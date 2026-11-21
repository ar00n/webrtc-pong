import { MSG_TYPE } from '../network/protocol.js';
import { EventEmitter } from '../utils/EventEmitter.js';
import { fromBase64Url } from './BinaryCodec.js';
import { derivePlayerId, toBase64Url } from './IdentityCrypto.js';
import { decodeReceiptBodyBytes } from './RecordCodec.js';
import { TrustLedger } from './TrustLedger.js';

export class PeerTrustSession extends EventEmitter {
  #ledger = new TrustLedger();
  #ledgerReady = null;
  #network;

  #authSessionId = 0;
  #cryptoQueue = Promise.resolve();
  #outgoingAuthNonce = null;
  #verifiedPeer = null;
  #lastPeerNickTs = 0;
  #remoteReceipts = [];
  #bufferedManifest = null;
  #bufferedHistoryBatches = [];
  #bufferedVouchBatches = [];

  #pendingReceiptOffers = new Map();
  #expectedGuestMatches = new Map();
  #signedMatchIds = new Set();

  constructor(network) {
    super();
    this.#network = network;
  }

  init() {
    this.#ledgerReady = this.#ledger.init().then(() => {
      this.emit('identity-change', this.getIdentitySnapshot());
    });
    return this.#ledgerReady;
  }

  reset({ preserveMatchSigning = false } = {}) {
    this.#authSessionId++;
    this.#outgoingAuthNonce = null;
    this.#verifiedPeer = null;
    this.#lastPeerNickTs = 0;
    this.#remoteReceipts = [];
    this.#bufferedManifest = null;
    this.#bufferedHistoryBatches = [];
    this.#bufferedVouchBatches = [];
    if (!preserveMatchSigning) {
      this.#pendingReceiptOffers.clear();
      this.#expectedGuestMatches.clear();
    }
    this.emit('opponent-change', this.getOpponentSnapshot());
  }

  startAuth({ reauth = false, preserveMatchSigning = false } = {}) {
    this.reset({ preserveMatchSigning });

    const sessionId = this.#authSessionId;
    this.#enqueueCryptoTask(sessionId, async () => {
      if (!this.#network.connected) return;
      const nonce = crypto.randomUUID();
      this.#outgoingAuthNonce = nonce;
      this.#network.send(MSG_TYPE.AUTH_CHALLENGE, {
        nonce,
        k: this.#ledger.myCompressedKeyB64,
        nick: this.#ledger.myNickname,
        reauth
      });
    });
  }

  handleMessage(msg) {
    switch (msg.t) {
      case MSG_TYPE.AUTH_CHALLENGE:
        this.#handleAuthChallenge(msg);
        return true;
      case MSG_TYPE.AUTH_RESPONSE:
        this.#handleAuthResponse(msg);
        return true;
      case MSG_TYPE.NICKNAME_UPDATE:
        this.#handleNicknameUpdate(msg);
        return true;
      case MSG_TYPE.SYNC_MANIFEST:
        this.#handleSyncManifest(msg);
        return true;
      case MSG_TYPE.HISTORY_SYNC:
        this.#handleRemoteHistory(msg);
        return true;
      case MSG_TYPE.VOUCH_SYNC:
        this.#handleRemoteVouches(msg);
        return true;
      case MSG_TYPE.MATCH_RECEIPT_OFFER:
        this.#handleMatchReceiptOffer(msg);
        return true;
      case MSG_TYPE.MATCH_RECEIPT_ACCEPT:
        this.#handleMatchReceiptAccept(msg);
        return true;
      default:
        return false;
    }
  }

  onMatchOver({ role, matchId, hostScore, guestScore, winner, settings, plausible }) {
    if (role === 'host') {
      this.#initiateMatchReceiptSigning({ matchId, hostScore, guestScore, settings });
      return;
    }

    if (!matchId || this.#signedMatchIds.has(matchId)) return;
    this.#expectedGuestMatches.set(matchId, {
      matchId,
      hostScore,
      guestScore,
      winner,
      mode: settings.mode,
      difficulty: settings.difficulty,
      targetScore: settings.targetScore,
      timeLimitSec: settings.timeLimitSec,
      plausible: Boolean(plausible)
    });
    if (this.#expectedGuestMatches.size > 10) {
      const oldest = this.#expectedGuestMatches.keys().next().value;
      this.#expectedGuestMatches.delete(oldest);
    }
  }

  async setNickname(rawName) {
    await this.#ledgerReady;
    const clean = this.#ledger.setNickname(rawName);
    this.emit('identity-change', this.getIdentitySnapshot());

    if (this.#network.connected && !this.#network.connectionLost && this.#verifiedPeer) {
      const sessionId = this.#authSessionId;
      const update = await this.#ledger.createNicknameUpdate(clean);
      if (
        update &&
        sessionId === this.#authSessionId &&
        this.#network.connected &&
        !this.#network.connectionLost
      ) {
        this.#network.send(MSG_TYPE.NICKNAME_UPDATE, update);
      }
    }
  }

  async toggleTrustOpponent() {
    await this.#ledgerReady;
    if (!this.#verifiedPeer) return;

    const result = await this.#ledger.toggleTrustAnchor(this.#verifiedPeer);
    if (!result) return;

    if (this.#network.connected && result.vouch) {
      const batch = await this.#ledger.encodeMissingVouchBatch(
        this.#verifiedPeer.playerId,
        null,
        [result.vouch]
      );
      if (batch && this.#network.connected) {
        this.#network.send(MSG_TYPE.VOUCH_SYNC, { b: batch });
      }
    }

    this.emit('identity-change', this.getIdentitySnapshot());
    this.emit('opponent-change', this.getOpponentSnapshot());
  }

  async untrustAnchor(playerId) {
    await this.#ledgerReady;
    const vouch = await this.#ledger.revokeTrustAnchor(playerId);

    if (this.#network.connected && this.#verifiedPeer && vouch) {
      const batch = await this.#ledger.encodeMissingVouchBatch(
        this.#verifiedPeer.playerId,
        null,
        [vouch]
      );
      if (batch && this.#network.connected) {
        this.#network.send(MSG_TYPE.VOUCH_SYNC, { b: batch });
      }
    }

    this.emit('identity-change', this.getIdentitySnapshot());
    this.emit('opponent-change', this.getOpponentSnapshot());
  }

  exportIdentity() {
    return this.#ledger.exportBackupJson();
  }

  async importIdentityBackup(rawJson) {
    await this.#ledgerReady;
    const result = await this.#ledger.importBackupJson(rawJson);
    if (result.ok) {
      this.emit('identity-change', this.getIdentitySnapshot());
      if (this.#network.connected && !this.#network.connectionLost) {
        this.startAuth({ reauth: true });
      } else {
        this.emit('opponent-change', this.getOpponentSnapshot());
      }
    }
    return result;
  }

  getIdentitySnapshot() {
    if (!this.#ledger.ready) {
      return {
        myPlayerId: '',
        nickname: 'Player',
        displayTag: 'Player#------',
        myStats: { wins: 0, losses: 0, draws: 0, total: 0 },
        myReceipts: [],
        trustedAnchors: [],
        vouchedFriends: []
      };
    }

    return {
      myPlayerId: this.#ledger.myPlayerId,
      nickname: this.#ledger.myNickname,
      displayTag: this.#ledger.myDisplayTag,
      myStats: this.#ledger.summarizeMyHistory(),
      myReceipts: this.#ledger.myReceipts,
      trustedAnchors: this.#ledger.trustedAnchors,
      vouchedFriends: this.#ledger.getVouchedFriendsList()
    };
  }

  getOpponentSnapshot() {
    if (!this.#ledger.ready || !this.#network.inRoom || !this.#network.connected) {
      return null;
    }

    if (!this.#verifiedPeer) {
      return { verifying: true };
    }

    const peerId = this.#verifiedPeer.playerId;
    const mergedReceipts = this.#ledger.getMergedReceiptsForPeer(peerId, this.#remoteReceipts);
    const peerTrust = this.#ledger.evaluatePeerTrust(peerId, mergedReceipts);
    const summary = this.#ledger.summarizePeerHistory(mergedReceipts, peerId);

    return {
      verifying: false,
      peer: this.#verifiedPeer,
      isTrustedAnchor: this.#ledger.isTrustedAnchor(peerId),
      trustInfo: peerTrust,
      historySummary: summary
    };
  }

  #enqueueCryptoTask(sessionId, fn) {
    this.#cryptoQueue = this.#cryptoQueue
      .then(async () => {
        await this.#ledgerReady;
        if (sessionId !== this.#authSessionId) return;
        await fn();
      })
      .catch(() => {
        // Isolate malformed crypto payloads
      });
  }

  #handleAuthChallenge(msg) {
    const sessionId = this.#authSessionId;
    this.#enqueueCryptoTask(sessionId, async () => {
      if (!msg || typeof msg.nonce !== 'string' || typeof msg.k !== 'string') return;
      const peerIdFromKey = await derivePlayerId(msg.k);
      if (sessionId !== this.#authSessionId || !peerIdFromKey) return;

      const response = await this.#ledger.createAuthResponse(msg.nonce, peerIdFromKey);
      if (sessionId !== this.#authSessionId || !response || !this.#network.connected) return;

      this.#network.send(MSG_TYPE.AUTH_RESPONSE, response);

      const peerKeyChanged = Boolean(
        this.#verifiedPeer && this.#verifiedPeer.playerId !== peerIdFromKey
      );
      if ((msg.reauth === true || peerKeyChanged) && !this.#outgoingAuthNonce) {
        this.startAuth({ reauth: false, preserveMatchSigning: !peerKeyChanged });
      }
    });
  }

  #handleAuthResponse(msg) {
    const sessionId = this.#authSessionId;
    this.#enqueueCryptoTask(sessionId, async () => {
      const nonce = this.#outgoingAuthNonce;
      if (!nonce || !msg) return;

      const verified = await this.#ledger.verifyAuthResponse({
        compressedKeyB64: msg.k,
        nickname: msg.nick,
        signature: msg.s,
        expectedNonce: nonce
      });

      if (sessionId !== this.#authSessionId || !verified) return;

      this.#outgoingAuthNonce = null;
      this.#verifiedPeer = verified;

      this.#sendSyncManifest();

      if (this.#bufferedManifest) {
        const manifest = this.#bufferedManifest;
        this.#bufferedManifest = null;
        await this.#sendDeltaForManifest(manifest);
      }

      if (this.#bufferedVouchBatches.length > 0) {
        for (const batchB64 of this.#bufferedVouchBatches) {
          await this.#ledger.decodeAndStoreRemoteVouches(batchB64, verified);
        }
        this.#bufferedVouchBatches = [];
      }

      if (this.#bufferedHistoryBatches.length > 0) {
        const knownIds = this.#getKnownRemoteMatchIds();
        for (const batchB64 of this.#bufferedHistoryBatches) {
          const decoded = await this.#ledger.decodeAndVerifyReceiptBatch(batchB64, verified, knownIds);
          this.#mergeRemoteReceipts(decoded);
          for (const r of decoded) knownIds.add(r.parsed.matchId);
        }
        this.#bufferedHistoryBatches = [];
      }

      if (sessionId !== this.#authSessionId) return;

      this.emit('identity-change', this.getIdentitySnapshot());
      this.emit('opponent-change', this.getOpponentSnapshot());
    });
  }

  #handleNicknameUpdate(msg) {
    const sessionId = this.#authSessionId;
    this.#enqueueCryptoTask(sessionId, async () => {
      if (!this.#verifiedPeer || !msg || msg.ts <= this.#lastPeerNickTs) return;
      const cleanNick = await this.#ledger.verifyNicknameUpdate(
        this.#verifiedPeer.compressedKeyB64,
        msg
      );
      if (sessionId !== this.#authSessionId || !cleanNick) return;

      this.#lastPeerNickTs = msg.ts;
      this.#verifiedPeer = {
        ...this.#verifiedPeer,
        nickname: cleanNick,
        displayTag: `${cleanNick}#${this.#verifiedPeer.shortId}`
      };

      this.emit('identity-change', this.getIdentitySnapshot());
      this.emit('opponent-change', this.getOpponentSnapshot());
    });
  }

  #sendSyncManifest() {
    if (!this.#network.connected || !this.#verifiedPeer || !this.#ledger.ready) return;
    const manifest = this.#ledger.buildSyncManifest(
      this.#verifiedPeer.playerId,
      this.#remoteReceipts
    );
    if (manifest) {
      this.#network.send(MSG_TYPE.SYNC_MANIFEST, manifest);
    }
  }

  #handleSyncManifest(msg) {
    const sessionId = this.#authSessionId;
    this.#enqueueCryptoTask(sessionId, async () => {
      if (!msg || typeof msg.r !== 'string') return;
      if (!this.#verifiedPeer) {
        this.#bufferedManifest = msg;
        return;
      }
      await this.#sendDeltaForManifest(msg);
    });
  }

  async #sendDeltaForManifest(peerManifest) {
    if (!this.#network.connected || !this.#verifiedPeer || !this.#ledger.ready) return;
    const peerId = this.#verifiedPeer.playerId;

    const receiptBatches = await this.#ledger.encodeMissingReceiptBatches(peerId, peerManifest, 30);
    if (!this.#network.connected || this.#verifiedPeer?.playerId !== peerId) return;

    for (const batchB64 of receiptBatches) {
      this.#network.send(MSG_TYPE.HISTORY_SYNC, { b: batchB64 });
    }

    const vouchBatch = await this.#ledger.encodeMissingVouchBatch(peerId, peerManifest);
    if (vouchBatch && this.#network.connected && this.#verifiedPeer?.playerId === peerId) {
      this.#network.send(MSG_TYPE.VOUCH_SYNC, { b: vouchBatch });
    }
  }

  #handleRemoteVouches(msg) {
    const sessionId = this.#authSessionId;
    this.#enqueueCryptoTask(sessionId, async () => {
      if (!msg || typeof msg.b !== 'string') return;

      if (!this.#verifiedPeer) {
        if (this.#bufferedVouchBatches.length < 10) {
          this.#bufferedVouchBatches.push(msg.b);
        }
        return;
      }

      await this.#ledger.decodeAndStoreRemoteVouches(msg.b, this.#verifiedPeer);
      if (sessionId !== this.#authSessionId) return;

      this.emit('identity-change', this.getIdentitySnapshot());
      this.emit('opponent-change', this.getOpponentSnapshot());
    });
  }

  #handleRemoteHistory(msg) {
    const sessionId = this.#authSessionId;
    this.#enqueueCryptoTask(sessionId, async () => {
      if (!msg || typeof msg.b !== 'string') return;

      if (!this.#verifiedPeer) {
        if (this.#bufferedHistoryBatches.length < 10) {
          this.#bufferedHistoryBatches.push(msg.b);
        }
        return;
      }

      const knownIds = this.#getKnownRemoteMatchIds();
      const verifiedRemote = await this.#ledger.decodeAndVerifyReceiptBatch(
        msg.b,
        this.#verifiedPeer,
        knownIds
      );
      if (sessionId !== this.#authSessionId) return;

      this.#mergeRemoteReceipts(verifiedRemote);
      this.emit('identity-change', this.getIdentitySnapshot());
      this.emit('opponent-change', this.getOpponentSnapshot());
    });
  }

  #getKnownRemoteMatchIds() {
    const set = new Set(this.#remoteReceipts.map((r) => r.parsed.matchId));
    for (const r of this.#ledger.myReceipts) {
      set.add(r.parsed.matchId);
    }
    return set;
  }

  #mergeRemoteReceipts(newReceipts) {
    if (!newReceipts || newReceipts.length === 0) return;
    const seen = new Set(this.#remoteReceipts.map((r) => r.parsed.matchId));
    for (const r of newReceipts) {
      if (!seen.has(r.parsed.matchId)) {
        seen.add(r.parsed.matchId);
        this.#remoteReceipts.push(r);
      }
    }
    this.#remoteReceipts.sort((a, b) => b.parsed.timestamp - a.parsed.timestamp);
  }

  #rememberSignedMatchId(matchId) {
    this.#signedMatchIds.add(matchId);
    if (this.#signedMatchIds.size > 200) {
      const oldest = this.#signedMatchIds.values().next().value;
      this.#signedMatchIds.delete(oldest);
    }
  }

  #initiateMatchReceiptSigning({ matchId, hostScore, guestScore, settings }) {
    if (!this.#network.isHost || !this.#network.connected) return;
    const sessionId = this.#authSessionId;

    this.#enqueueCryptoTask(sessionId, async () => {
      if (!this.#verifiedPeer || !matchId || this.#signedMatchIds.has(matchId)) return;

      const offer = await this.#ledger.createMatchReceiptOffer({
        matchId,
        hostId: this.#ledger.myPlayerId,
        hostNick: this.#ledger.myNickname,
        guestId: this.#verifiedPeer.playerId,
        guestNick: this.#verifiedPeer.nickname,
        hostScore,
        guestScore,
        settings
      });

      if (sessionId !== this.#authSessionId || !offer || !this.#network.connected) return;

      this.#pendingReceiptOffers.set(matchId, offer);
      if (this.#pendingReceiptOffers.size > 10) {
        const oldestKey = this.#pendingReceiptOffers.keys().next().value;
        this.#pendingReceiptOffers.delete(oldestKey);
      }

      this.#network.send(MSG_TYPE.MATCH_RECEIPT_OFFER, {
        b: toBase64Url(offer.bodyBytes),
        s: toBase64Url(offer.sigBytes)
      });
    });
  }

  #handleMatchReceiptOffer(msg) {
    if (this.#network.isHost) return;
    const sessionId = this.#authSessionId;

    this.#enqueueCryptoTask(sessionId, async () => {
      const bodyBytes = fromBase64Url(msg?.b);
      if (!bodyBytes) return;

      let matchId = '';
      try {
        const decoded = decodeReceiptBodyBytes(bodyBytes);
        matchId = decoded?.parsed?.matchId || '';
      } catch {
        return;
      }

      const expected = matchId ? this.#expectedGuestMatches.get(matchId) : null;
      if (
        !this.#verifiedPeer ||
        !expected ||
        !expected.plausible ||
        this.#signedMatchIds.has(expected.matchId)
      ) {
        return;
      }

      const receipt = await this.#ledger.acceptMatchReceiptOffer({
        bodyB64: msg.b,
        hostSigB64: msg.s,
        peerCompressedKeyB64: this.#verifiedPeer.compressedKeyB64,
        expectedHostId: this.#verifiedPeer.playerId,
        expectedGuestId: this.#ledger.myPlayerId,
        expectedMatchId: expected.matchId,
        expectedHostScore: expected.hostScore,
        expectedGuestScore: expected.guestScore,
        expectedWinner: expected.winner,
        expectedMode: expected.mode,
        expectedDifficulty: expected.difficulty,
        expectedTargetScore: expected.targetScore,
        expectedTimeLimitSec: expected.timeLimitSec
      });

      if (sessionId !== this.#authSessionId || !receipt) return;

      this.#expectedGuestMatches.delete(expected.matchId);
      this.#rememberSignedMatchId(expected.matchId);
      this.#mergeRemoteReceipts([receipt]);

      if (this.#network.connected) {
        this.#network.send(MSG_TYPE.MATCH_RECEIPT_ACCEPT, {
          m: expected.matchId,
          s: toBase64Url(receipt.guestSigBytes)
        });
      }

      this.emit('identity-change', this.getIdentitySnapshot());
      this.emit('opponent-change', this.getOpponentSnapshot());
    });
  }

  #handleMatchReceiptAccept(msg) {
    if (!this.#network.isHost) return;
    const sessionId = this.#authSessionId;

    this.#enqueueCryptoTask(sessionId, async () => {
      const offer = this.#pendingReceiptOffers.get(msg?.m);
      if (!this.#verifiedPeer || !offer || this.#signedMatchIds.has(msg.m)) {
        return;
      }

      const receipt = await this.#ledger.finalizeHostMatchReceipt({
        offer,
        guestSigB64: msg.s,
        peerCompressedKeyB64: this.#verifiedPeer.compressedKeyB64,
        expectedGuestId: this.#verifiedPeer.playerId
      });

      if (sessionId !== this.#authSessionId || !receipt) return;

      this.#rememberSignedMatchId(msg.m);
      this.#pendingReceiptOffers.delete(msg.m);
      this.#mergeRemoteReceipts([receipt]);
      this.emit('identity-change', this.getIdentitySnapshot());
      this.emit('opponent-change', this.getOpponentSnapshot());
    });
  }
}
