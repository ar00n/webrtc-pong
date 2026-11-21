import {
  AUDIO_CONFIG,
  GAME_CONFIG,
  IDENTITY_CONFIG,
  MATCH_MODES,
  MODE_CONFIG,
  NETWORK_CONFIG,
  PADDLE_CONFIG
} from '../config/constants.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { GameState } from '../game/GameState.js';
import {
  createDefaultMatchSettings,
  evaluateMatchWinner,
  normalizeMatchSettings,
  resolvePaddleColor
} from '../game/MatchSettings.js';
import { PhysicsEngine } from '../game/PhysicsEngine.js';
import { Renderer } from '../game/Renderer.js';
import { derivePlayerId, generateMatchId } from '../identity/IdentityCrypto.js';
import { TrustLedger } from '../identity/TrustLedger.js';
import { InputController } from '../input/InputController.js';
import { NetworkManager } from '../network/NetworkManager.js';
import { MSG_TYPE } from '../network/protocol.js';
import { UIManager } from '../ui/UIManager.js';
import { generateRoomCode, getRoomCodeFromUrl, isValidRoomCode } from '../utils/code.js';

export class PongApp {
  #audio = new AudioEngine();
  #state = new GameState();
  #physics = new PhysicsEngine();
  #network = new NetworkManager();
  #ledger = new TrustLedger();
  #ledgerReady = null;
  #ui;
  #renderer;
  #input;

  #rafId = null;
  #lastFrameTime = 0;
  #lastPaddleSend = 0;
  #lastSentPaddleY = null;
  #roomTransitionId = 0;
  #remoteWinSoundId = AUDIO_CONFIG.DEFAULT_WIN_SOUND;
  #localSettings = createDefaultMatchSettings();
  #localColorId = PADDLE_CONFIG.DEFAULT_COLOR_ID;
  #remoteColorId = PADDLE_CONFIG.DEFAULT_COLOR_ID;

  // Identity, auth & match-signing session state
  #authSessionId = 0;
  #cryptoQueue = Promise.resolve();
  #outgoingAuthNonce = null;
  #verifiedPeer = null;
  #lastPeerNickTs = 0;
  #remoteReceipts = [];
  #bufferedManifest = null;
  #bufferedHistoryBatches = [];
  #bufferedVouchBatches = [];
  #currentMatchId = '';
  #pendingReceiptOffers = new Map();
  #expectedGuestMatch = null;
  #signedMatchIds = new Set();

  constructor() {
    this.#ui = new UIManager({
      onHost: () => this.hostRoom(),
      onJoin: (code) => this.joinRoom(code),
      onLeave: () => this.leaveRoom(),
      onTogglePause: () => this.togglePause(),
      onResetScore: () => this.#resetHostMatch(),
      onToggleMute: () => this.#toggleMute(),
      onVolumeChange: (pct) => this.#setVolume(pct),
      onMatchSettingsChange: (patch) => this.#updateMatchSettings(patch),
      onPaddleColorChange: (colorId) => this.#setPaddleColor(colorId),
      onWinSoundChange: (id) => this.#setWinSound(id),
      onPreviewWinSound: () => this.#previewWinSound(),
      getRoomCode: () => this.#network.roomCode,
      onNicknameChange: (name) => this.#setNickname(name),
      onToggleTrustOpponent: () => this.#toggleTrustOpponent(),
      onUntrustAnchor: (playerId) => this.#untrustAnchor(playerId),
      onExportIdentity: () => this.#ledger.exportBackupJson(),
      onImportIdentity: (json) => this.#importIdentityBackup(json)
    });

    this.#renderer = new Renderer(this.#ui.canvas);

    this.#input = new InputController(this.#ui.canvas, {
      onUserGesture: () => this.#audio.unlock(),
      onToggleMute: () => this.#toggleMute(),
      onTogglePause: () => this.togglePause(),
      onPointerMove: (y) => this.#handlePointerPaddle(y)
    });

    this.#initMatchSettings();
    this.#initPaddleColor();
    this.#bindNetworkEvents();
    this.#syncAudioUI();
    this.#syncWinSoundUI();
    this.#syncMatchSettingsUI();
    this.#syncPaddleColorUI();
    this.#syncStatusUI();

    this.#ledgerReady = this.#initIdentity();
  }

  start() {
    const autoCode = getRoomCodeFromUrl();
    if (autoCode) {
      this.#ui.setJoinInput(autoCode);
      this.joinRoom(autoCode);
    }

    this.#lastFrameTime = performance.now();
    const tick = (now) => {
      this.#loop(now);
      this.#rafId = requestAnimationFrame(tick);
    };
    this.#rafId = requestAnimationFrame(tick);
  }

  destroy() {
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    this.#input.destroy();
    this.#network.destroy();
  }

  async hostRoom() {
    this.#audio.unlock();
    await this.#enterRoom(generateRoomCode(), true);
  }

  async joinRoom(code) {
    this.#audio.unlock();
    if (!isValidRoomCode(code)) {
      this.#ui.showJoinError(
        `Please enter a valid room code (at least ${NETWORK_CONFIG.MIN_CODE_LENGTH} characters).`
      );
      return;
    }
    await this.#enterRoom(code, false);
  }

  async leaveRoom() {
    this.#roomTransitionId++;
    this.#state.setSettings(this.#localSettings);
    this.#resetLocalSession();
    await this.#network.disconnect();
    this.#ui.setLobbyView();
    this.#syncMatchSettingsUI();
    this.#syncPaddleColorUI();
    this.#syncOpponentTrustUI();
    this.#syncStatusUI();
  }

  togglePause() {
    if (
      !this.#network.connected ||
      this.#network.connectionLost ||
      !this.#state.matchActive ||
      this.#state.matchOver
    ) {
      return;
    }

    const nextPaused = !this.#state.paused;
    const reason = nextPaused ? 'manual' : '';
    const by = nextPaused ? (this.#network.isHost ? 'Host' : 'Guest') : '';

    this.#state.setPaused(nextPaused, reason, by);
    this.#network.send(MSG_TYPE.PAUSE, { paused: nextPaused, reason, by });

    if (!nextPaused && this.#network.isHost) {
      this.#sendSyncState();
    }

    this.#audio.playPause(nextPaused);
    this.#syncStatusUI();
  }

  async #initIdentity() {
    await this.#ledger.init();
    this.#syncIdentityUI();
  }

  async #setNickname(rawName) {
    await this.#ledgerReady;
    const clean = this.#ledger.setNickname(rawName);
    this.#syncIdentityUI();

    if (this.#network.connected && !this.#network.connectionLost && this.#verifiedPeer) {
      const update = await this.#ledger.createNicknameUpdate(clean);
      if (update && this.#network.connected) {
        this.#network.send(MSG_TYPE.NICKNAME_UPDATE, update);
      }
    }
  }

  async #toggleTrustOpponent() {
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

    this.#syncIdentityUI();
    this.#syncOpponentTrustUI();
  }

  async #untrustAnchor(playerId) {
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

    this.#syncIdentityUI();
    this.#syncOpponentTrustUI();
  }

  async #importIdentityBackup(rawJson) {
    await this.#ledgerReady;
    const result = await this.#ledger.importBackupJson(rawJson);
    if (result.ok) {
      this.#syncIdentityUI();
      if (this.#network.connected && !this.#network.connectionLost) {
        this.#startPeerAuth({ reauth: true });
      } else {
        this.#syncOpponentTrustUI();
      }
    }
    return result;
  }

  #syncIdentityUI() {
    if (!this.#ledger.ready) return;
    this.#ui.updateIdentityControls({
      myPlayerId: this.#ledger.myPlayerId,
      nickname: this.#ledger.myNickname,
      displayTag: this.#ledger.myDisplayTag,
      myStats: this.#ledger.summarizeMyHistory(),
      myReceipts: this.#ledger.myReceipts,
      trustedAnchors: this.#ledger.trustedAnchors,
      vouchedFriends: this.#ledger.getVouchedFriendsList()
    });
  }

  #syncOpponentTrustUI() {
    if (!this.#ledger.ready) return;

    if (!this.#network.inRoom || !this.#network.connected) {
      this.#ui.updateOpponentIdentity(null);
      return;
    }

    if (!this.#verifiedPeer) {
      this.#ui.updateOpponentIdentity({ verifying: true });
      return;
    }

    const peerId = this.#verifiedPeer.playerId;
    const mergedReceipts = this.#ledger.getMergedReceiptsForPeer(peerId, this.#remoteReceipts);
    const peerTrust = this.#ledger.evaluatePeerTrust(peerId, mergedReceipts);
    const summary = this.#ledger.summarizePeerHistory(mergedReceipts, peerId);

    this.#ui.updateOpponentIdentity({
      verifying: false,
      peer: this.#verifiedPeer,
      isTrustedAnchor: this.#ledger.isTrustedAnchor(peerId),
      trustInfo: peerTrust,
      historySummary: summary
    });
  }

  #resetAuthState({ preserveMatchSigning = false } = {}) {
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
      this.#expectedGuestMatch = null;
    }
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

  #startPeerAuth({ reauth = false, preserveMatchSigning = false } = {}) {
    this.#resetAuthState({ preserveMatchSigning });
    this.#syncOpponentTrustUI();

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

  #handleAuthChallenge(msg) {
    const sessionId = this.#authSessionId;
    this.#enqueueCryptoTask(sessionId, async () => {
      if (!msg || typeof msg.nonce !== 'string' || typeof msg.k !== 'string') return;
      const peerIdFromKey = await derivePlayerId(msg.k);
      if (sessionId !== this.#authSessionId || !peerIdFromKey) return;

      const response = await this.#ledger.createAuthResponse(msg.nonce, peerIdFromKey);
      if (sessionId !== this.#authSessionId || !response || !this.#network.connected) return;

      this.#network.send(MSG_TYPE.AUTH_RESPONSE, response);

      const peerKeyChanged = Boolean(this.#verifiedPeer && this.#verifiedPeer.playerId !== peerIdFromKey);
      if ((msg.reauth === true || peerKeyChanged) && !this.#outgoingAuthNonce) {
        this.#startPeerAuth({ reauth: false, preserveMatchSigning: !peerKeyChanged });
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

      // Send our compact sync manifest first so the peer only transmits missing deltas
      this.#sendSyncManifest();

      // Drain any sync messages that arrived before auth finished
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

      this.#syncIdentityUI();
      this.#syncOpponentTrustUI();
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
      this.#syncOpponentTrustUI();
    });
  }

  #sendSyncManifest() {
    if (!this.#network.connected || !this.#verifiedPeer || !this.#ledger.ready) return;
    const manifest = this.#ledger.buildSyncManifest(this.#verifiedPeer.playerId, this.#remoteReceipts);
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

      this.#syncIdentityUI();
      this.#syncOpponentTrustUI();
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
      this.#syncIdentityUI();
      this.#syncOpponentTrustUI();
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

  #initiateMatchReceiptSigning(winner) {
    if (!this.#network.isHost || !this.#network.connected) return;
    const matchId = this.#currentMatchId;
    const hostScore = this.#state.hostScore;
    const guestScore = this.#state.guestScore;
    const settings = { ...this.#state.settings };
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

      const { toBase64Url } = await import('../identity/IdentityCrypto.js');
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
      const expected = this.#expectedGuestMatch;
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
        expectedMode: expected.mode
      });

      if (sessionId !== this.#authSessionId || !receipt) return;

      this.#rememberSignedMatchId(expected.matchId);
      this.#expectedGuestMatch = null;
      this.#mergeRemoteReceipts([receipt]);

      if (this.#network.connected) {
        const { toBase64Url } = await import('../identity/IdentityCrypto.js');
        this.#network.send(MSG_TYPE.MATCH_RECEIPT_ACCEPT, {
          m: expected.matchId,
          s: toBase64Url(receipt.guestSigBytes)
        });
      }

      this.#syncIdentityUI();
      this.#syncOpponentTrustUI();
    });
  }

  #handleMatchReceiptAccept(msg) {
    if (!this.#network.isHost) return;
    const sessionId = this.#authSessionId;

    this.#enqueueCryptoTask(sessionId, async () => {
      const offer = this.#pendingReceiptOffers.get(msg.m);
      if (
        !this.#verifiedPeer ||
        !offer ||
        this.#signedMatchIds.has(msg.m)
      ) {
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
      this.#syncIdentityUI();
      this.#syncOpponentTrustUI();
    });
  }

  async #enterRoom(code, isHost) {
    const transitionId = ++this.#roomTransitionId;
    if (isHost) {
      this.#state.setSettings(this.#localSettings);
    }
    this.#resetLocalSession();
    this.#ui.setRoomView(code);
    this.#syncMatchSettingsUI();
    this.#syncPaddleColorUI();
    this.#syncOpponentTrustUI();
    this.#ui.setStatus(
      isHost ? `Waiting for friend to join ${code}...` : `Connecting to room ${code}...`,
      'waiting'
    );

    try {
      await this.#network.connect(code, isHost);
      if (transitionId !== this.#roomTransitionId) return;
      this.#syncMatchSettingsUI();
      this.#syncPaddleColorUI();
      this.#syncOpponentTrustUI();
      this.#syncStatusUI();
    } catch {
      if (transitionId !== this.#roomTransitionId) return;
      this.#ui.setStatus('Failed to initialize room connection.', 'error');
    }
  }

  #resetLocalSession() {
    this.#state.resetAll();
    this.#audio.resetHitDeduplication();
    this.#remoteColorId = PADDLE_CONFIG.DEFAULT_COLOR_ID;
    this.#remoteWinSoundId = AUDIO_CONFIG.DEFAULT_WIN_SOUND;
    this.#lastSentPaddleY = null;
    this.#lastPaddleSend = 0;
    this.#currentMatchId = '';
    this.#resetAuthState();
  }

  #resetHostMatch() {
    if (!this.#network.isHost || !this.#network.connected || this.#network.connectionLost) {
      return;
    }
    this.#state.resetMatch();
    this.#currentMatchId = generateMatchId();
    this.#audio.resetHitDeduplication();
    this.#sendServe();
    this.#syncStatusUI();
  }

  #initMatchSettings() {
    let saved = null;
    try {
      const raw = localStorage.getItem(MODE_CONFIG.STORAGE_SETTINGS_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch {
      saved = null;
    }

    this.#localSettings = normalizeMatchSettings(saved || undefined);
    this.#state.setSettings(this.#localSettings);
    this.#state.timeRemaining =
      this.#state.settings.mode === MATCH_MODES.TIMED ? this.#state.settings.timeLimitSec : 0;
  }

  #updateMatchSettings(patch) {
    if (this.#network.inRoom && !this.#network.isHost) return;
    if (!patch || typeof patch !== 'object') return;

    const merged = { ...this.#state.settings, ...patch };
    this.#state.setSettings(merged);
    this.#localSettings = { ...this.#state.settings };

    try {
      localStorage.setItem(MODE_CONFIG.STORAGE_SETTINGS_KEY, JSON.stringify(this.#localSettings));
    } catch {
      // Ignore storage errors
    }

    if (
      !this.#state.matchActive ||
      patch.mode !== undefined ||
      patch.timeLimitSec !== undefined
    ) {
      this.#state.timeRemaining =
        this.#state.settings.mode === MATCH_MODES.TIMED ? this.#state.settings.timeLimitSec : 0;
    }

    this.#syncMatchSettingsUI();

    if (this.#network.connected && this.#network.isHost) {
      this.#sendGameSettings();
      if (this.#state.matchActive && !this.#state.matchOver) {
        this.#checkMatchWinner();
      }
    }
  }

  #syncMatchSettingsUI() {
    this.#ui.updateMatchSettings(this.#state.settings, {
      inRoom: this.#network.inRoom,
      isHost: this.#network.isHost
    });
  }

  #initPaddleColor() {
    let savedId = null;
    try {
      savedId = localStorage.getItem(PADDLE_CONFIG.STORAGE_COLOR_KEY);
    } catch {
      savedId = null;
    }
    this.#localColorId = resolvePaddleColor(savedId).id;
  }

  #setPaddleColor(colorId) {
    const resolved = resolvePaddleColor(colorId);
    this.#localColorId = resolved.id;

    try {
      localStorage.setItem(PADDLE_CONFIG.STORAGE_COLOR_KEY, resolved.id);
    } catch {
      // Ignore storage errors
    }

    this.#syncPaddleColorUI();
    if (this.#network.connected) {
      this.#sendPaddleColor();
    }
  }

  #syncPaddleColorUI() {
    this.#ui.updatePaddleColorControls({
      localColorId: this.#localColorId,
      remoteColorId: this.#remoteColorId,
      connected: this.#network.connected
    });
  }

  #toggleMute() {
    this.#audio.toggleMute();
    this.#syncAudioUI();
  }

  #setVolume(pct) {
    this.#audio.setVolume(pct);
    this.#syncAudioUI();
  }

  #syncAudioUI() {
    this.#ui.updateAudioControls(this.#audio.volumePct, this.#audio.isMuted);
  }

  #setWinSound(id) {
    if (!this.#audio.setWinSound(id)) return;
    this.#syncWinSoundUI();
    if (this.#network.connected) {
      this.#sendWinSound();
    }
  }

  #previewWinSound() {
    this.#audio.unlock();
    this.#audio.previewWinSound();
  }

  #syncWinSoundUI() {
    this.#ui.updateWinSoundControls({
      sounds: this.#audio.winSounds,
      selectedId: this.#audio.selectedWinSoundId
    });
  }

  #handlePointerPaddle(y) {
    if (
      this.#network.inRoom &&
      (
        !this.#network.connected ||
        this.#state.paused ||
        this.#state.matchOver ||
        this.#network.connectionLost
      )
    ) {
      return;
    }
    const isHost = !this.#network.inRoom || this.#network.isHost;
    this.#state.setLocalPaddleY(isHost, y);
  }

  #triggerConnectionLostPause() {
    if (this.#state.matchActive && !this.#state.matchOver) {
      this.#state.setPaused(true, 'lost', '');
    }
    this.#input.resetKeys();
    this.#audio.playDisconnect();
    this.#syncPaddleColorUI();
    this.#syncOpponentTrustUI();
    this.#syncStatusUI();
  }

  #bindNetworkEvents() {
    this.#network.on('peer-join', () => {
      if (this.#state.matchActive) {
        if (!this.#state.matchOver) {
          this.#state.setPaused(true, 'reconnected', '');
          this.#state.waitingForServe = !this.#network.isHost;
        }
        if (this.#network.isHost) {
          this.#sendGameSettings();
          this.#sendSyncState();
          this.#network.startPingLoop();
        }
      }

      this.#audio.playConnect();
      this.#syncMatchSettingsUI();
      this.#syncPaddleColorUI();
      this.#syncStatusUI();
    });

    this.#network.on('peer-leave', () => {
      this.#state.waitingForServe = false;
      this.#remoteColorId = PADDLE_CONFIG.DEFAULT_COLOR_ID;
      this.#remoteWinSoundId = AUDIO_CONFIG.DEFAULT_WIN_SOUND;
      this.#resetAuthState();
      this.#triggerConnectionLostPause();
    });

    this.#network.on('timeout', () => {
      this.#triggerConnectionLostPause();
    });

    this.#network.on('connection-restored', () => {
      if (this.#state.matchActive && !this.#state.matchOver) {
        this.#state.setPaused(true, 'reconnected', '');
      }
      if (this.#network.isHost) {
        this.#sendGameSettings();
        if (this.#state.matchActive) {
          this.#sendSyncState();
        }
      }
      this.#sendPaddleColor();
      this.#sendWinSound();
      this.#audio.playConnect();
      this.#syncMatchSettingsUI();
      this.#syncPaddleColorUI();
      this.#syncOpponentTrustUI();
      this.#syncStatusUI();
    });

    this.#network.on('offline', () => {
      if (this.#network.inRoom && this.#state.matchActive && !this.#state.matchOver) {
        this.#network.markConnectionLost();
        this.#triggerConnectionLostPause();
      }
    });

    this.#network.on('online', () => this.#syncStatusUI());

    this.#network.on('rtt-update', (rttMs) => {
      const show = this.#network.connected && !this.#network.connectionLost;
      this.#ui.updatePing(rttMs, show);
    });

    this.#network.on('error', ({ err, peerCount, code }) => {
      if (err.code === 'room-full' && peerCount === 0) {
        this.#ui.setStatus(`Room ${code} is already full (2/2 players).`, 'error');
      } else if (err.code === 'peer-connect-failed') {
        this.#ui.setStatus('Direct WebRTC connection failed (strict NAT/firewall).', 'error');
      } else if (err.code === 'relay-failed') {
        this.#ui.setStatus('Could not reach signaling relays. Check your internet.', 'error');
      }
    });

    this.#network.on('message', ({ msg, userId }) => this.#handleNetworkMessage(msg, userId));
  }

  #handleNetworkMessage(msg, userId) {
    const net = this.#network;
    const state = this.#state;

    switch (msg.t) {
      case MSG_TYPE.HELLO: {
        const wasHost = net.isHost;
        if (msg.host === net.isHost) {
          net.setHostRole(net.myUserId < userId);
        }

        if (net.isHost) {
          net.startPingLoop();
          this.#sendGameSettings();
          if (!state.matchActive || (!wasHost && state.currentRound === 0)) {
            state.resetMatch();
            this.#currentMatchId = generateMatchId();
            this.#audio.resetHitDeduplication();
            this.#sendServe();
          } else {
            if (!this.#currentMatchId) {
              this.#currentMatchId = generateMatchId();
            }
            this.#sendSyncState();
          }
        } else {
          net.stopPingLoop();
          if (!state.matchActive) {
            state.matchActive = true;
            state.waitingForServe = true;
          } else if (wasHost) {
            state.waitingForServe = true;
          }
        }

        this.#sendPaddleColor();
        this.#sendWinSound();
        this.#startPeerAuth();
        this.#syncMatchSettingsUI();
        this.#syncPaddleColorUI();
        this.#syncStatusUI();
        return;
      }

      case MSG_TYPE.AUTH_CHALLENGE: {
        this.#handleAuthChallenge(msg);
        return;
      }

      case MSG_TYPE.AUTH_RESPONSE: {
        this.#handleAuthResponse(msg);
        return;
      }

      case MSG_TYPE.NICKNAME_UPDATE: {
        this.#handleNicknameUpdate(msg);
        return;
      }

      case MSG_TYPE.SYNC_MANIFEST: {
        this.#handleSyncManifest(msg);
        return;
      }

      case MSG_TYPE.HISTORY_SYNC: {
        this.#handleRemoteHistory(msg);
        return;
      }

      case MSG_TYPE.VOUCH_SYNC: {
        this.#handleRemoteVouches(msg);
        return;
      }

      case MSG_TYPE.MATCH_RECEIPT_OFFER: {
        this.#handleMatchReceiptOffer(msg);
        return;
      }

      case MSG_TYPE.MATCH_RECEIPT_ACCEPT: {
        this.#handleMatchReceiptAccept(msg);
        return;
      }

      case MSG_TYPE.PADDLE: {
        if (!Number.isFinite(msg.y)) return;
        state.setRemotePaddleY(net.isHost, msg.y);
        return;
      }

      case MSG_TYPE.PADDLE_COLOR: {
        this.#remoteColorId = resolvePaddleColor(msg.colorId).id;
        this.#syncPaddleColorUI();
        return;
      }

      case MSG_TYPE.WIN_SOUND: {
        if (typeof msg.winSoundId === 'string') {
          this.#remoteWinSoundId = msg.winSoundId;
        }
        return;
      }

      case MSG_TYPE.GAME_SETTINGS: {
        if (net.isHost || !msg.settings) return;
        state.setSettings(msg.settings);
        if (Number.isFinite(msg.timeRemaining)) {
          state.timeRemaining = msg.timeRemaining;
        } else if (!state.matchActive) {
          state.timeRemaining =
            state.settings.mode === MATCH_MODES.TIMED ? state.settings.timeLimitSec : 0;
        }
        this.#syncMatchSettingsUI();
        return;
      }

      case MSG_TYPE.PAUSE: {
        if (!state.matchActive || state.matchOver) return;
        const nextPaused = Boolean(msg.paused);
        if (nextPaused !== state.paused) {
          this.#audio.playPause(nextPaused);
        }
        const safeReason = msg.reason === 'reconnected' || msg.reason === 'lost' ? msg.reason : 'manual';
        const safeBy = typeof msg.by === 'string' ? msg.by.slice(0, 24) : '';
        state.setPaused(nextPaused, safeReason, safeBy);
        if (!nextPaused && net.isHost) {
          this.#sendSyncState();
        }
        this.#syncStatusUI();
        return;
      }

      case MSG_TYPE.SYNC_STATE: {
        if (net.isHost) return;
        this.#applySyncState(msg);
        return;
      }

      case MSG_TYPE.SERVE: {
        if (net.isHost) return;
        this.#applyServe(msg);
        return;
      }

      case MSG_TYPE.HIT: {
        if (
          state.matchOver ||
          state.paused ||
          msg.round !== state.currentRound ||
          !Number.isFinite(msg.hitSeq) ||
          msg.hitSeq <= state.lastHitSeq ||
          !Number.isFinite(msg.bx) ||
          !Number.isFinite(msg.by) ||
          !Number.isFinite(msg.vx) ||
          !Number.isFinite(msg.vy)
        ) {
          return;
        }
        state.lastHitSeq = msg.hitSeq;
        state.hitSeq = msg.hitSeq;

        const side = msg.vx > 0 ? 'left' : 'right';
        this.#audio.playPaddleHitOnce(msg.round, msg.hitSeq, side, Math.hypot(msg.vx, msg.vy));

        const oldBx = state.ballX;
        const oldBy = state.ballY;

        state.ballX = msg.bx;
        state.ballY = msg.by;
        state.vx = msg.vx;
        state.vy = msg.vy;
        state.serveTimer = 0;
        state.ballOwner = msg.vx < 0 ? 'h' : 'g';

        this.#physics.advanceVisual(state, net.halfRtt);
        state.applyVisualError(oldBx - state.ballX, oldBy - state.ballY);
        return;
      }

      case MSG_TYPE.MISS: {
        if (!net.isHost || state.matchOver || state.paused || msg.round !== state.currentRound) {
          return;
        }
        state.hostScore++;
        this.#audio.playScore(true);
        if (!this.#checkMatchWinner()) {
          state.prepareServe(-1);
          this.#sendServe();
        }
        return;
      }

      case MSG_TYPE.MATCH_OVER: {
        if (net.isHost) return;

        const prevHs = state.hostScore;
        const prevGs = state.guestScore;
        const prevTime = state.timeRemaining;
        const hs = Number.isFinite(msg.hs) ? msg.hs : prevHs;
        const gs = Number.isFinite(msg.gs) ? msg.gs : prevGs;
        const nextTime = Number.isFinite(msg.timeRemaining) ? msg.timeRemaining : prevTime;

        const timedOk = state.settings.mode !== MATCH_MODES.TIMED || prevTime <= 5.0;
        const scoreOk =
          hs >= prevHs &&
          gs >= prevGs &&
          hs - prevHs <= 1 &&
          gs - prevGs <= 1;
        const evalWinner = evaluateMatchWinner(
          { hostScore: hs, guestScore: gs, timeRemaining: nextTime },
          state.settings
        );

        const plausible =
          typeof msg.matchId === 'string' &&
          msg.matchId.length > 0 &&
          !this.#signedMatchIds.has(msg.matchId) &&
          timedOk &&
          scoreOk &&
          evalWinner === msg.winner;

        this.#expectedGuestMatch = {
          matchId: msg.matchId,
          hostScore: hs,
          guestScore: gs,
          winner: msg.winner,
          mode: state.settings.mode,
          plausible
        };

        state.hostScore = hs;
        state.guestScore = gs;
        state.timeRemaining = nextTime;
        state.setMatchOver(msg.winner || null);

        const fallbackId =
          msg.winner === 'guest' ? this.#audio.selectedWinSoundId : this.#remoteWinSoundId;
        const winSoundId = typeof msg.winSoundId === 'string' ? msg.winSoundId : fallbackId;
        this.#playMatchOverSound(winSoundId);
        this.#syncStatusUI();
      }
    }
  }

  #applySyncState(msg) {
    if (
      !Number.isFinite(msg.round) ||
      !Number.isFinite(msg.hitSeq) ||
      !Number.isFinite(msg.bx) ||
      !Number.isFinite(msg.by) ||
      !Number.isFinite(msg.vx) ||
      !Number.isFinite(msg.vy) ||
      !Number.isFinite(msg.st) ||
      !Number.isFinite(msg.hs) ||
      !Number.isFinite(msg.gs) ||
      !Number.isFinite(msg.hy)
    ) {
      return;
    }

    const state = this.#state;
    const halfRtt = this.#network.halfRtt;

    if (msg.settings) {
      state.setSettings(msg.settings);
      this.#syncMatchSettingsUI();
    }

    state.matchActive = true;
    state.currentRound = msg.round;
    state.hitSeq = msg.hitSeq;
    state.lastHitSeq = msg.hitSeq;
    this.#audio.syncHitDeduplication(msg.round, msg.hitSeq);

    state.ballOwner = msg.owner === 'g' ? 'g' : 'h';
    state.ballX = msg.bx;
    state.ballY = msg.by;
    state.vx = msg.vx;
    state.vy = msg.vy;
    state.serveTimer = msg.st;
    state.hostScore = msg.hs;
    state.guestScore = msg.gs;
    state.hostY = GameState.clampPaddleY(msg.hy);
    if (Number.isFinite(msg.timeRemaining)) {
      state.timeRemaining = msg.timeRemaining;
    }
    state.waitingForServe = false;
    state.visErrX = 0;
    state.visErrY = 0;

    if (msg.matchOver) {
      state.setMatchOver(msg.winner || null);
    } else {
      state.matchOver = false;
      state.winner = null;
      if (typeof msg.paused === 'boolean') {
        state.setPaused(msg.paused, msg.pauseReason || '', msg.pausedBy || '');
      }
    }

    if (!state.paused && !state.matchOver && !this.#network.connectionLost) {
      if (state.serveTimer > halfRtt) {
        state.serveTimer -= halfRtt;
      } else if (state.serveTimer > 0) {
        const rem = halfRtt - state.serveTimer;
        state.serveTimer = 0;
        this.#physics.advanceVisual(state, rem);
      } else {
        this.#physics.advanceVisual(state, halfRtt);
      }
    }

    this.#syncStatusUI();
  }

  #applyServe(msg) {
    if (
      !Number.isFinite(msg.round) ||
      !Number.isFinite(msg.bx) ||
      !Number.isFinite(msg.by) ||
      !Number.isFinite(msg.vx) ||
      !Number.isFinite(msg.vy) ||
      !Number.isFinite(msg.hs) ||
      !Number.isFinite(msg.gs) ||
      !Number.isFinite(msg.st)
    ) {
      return;
    }

    const state = this.#state;
    const halfRtt = this.#network.halfRtt;

    if (msg.gs > state.guestScore) this.#audio.playScore(true);
    else if (msg.hs > state.hostScore) this.#audio.playScore(false);

    state.matchActive = true;
    state.matchOver = false;
    state.winner = null;
    if (msg.round === 1 && msg.hs === 0 && msg.gs === 0) {
      this.#expectedGuestMatch = null;
    }
    state.currentRound = msg.round;
    state.lastHitSeq = 0;
    state.hitSeq = 0;
    state.waitingForServe = false;
    state.visErrX = 0;
    state.visErrY = 0;

    if (!this.#network.connectionLost) {
      state.setPaused(false);
    }

    state.ballX = msg.bx;
    state.ballY = msg.by;
    state.vx = msg.vx;
    state.vy = msg.vy;
    state.hostScore = msg.hs;
    state.guestScore = msg.gs;
    if (Number.isFinite(msg.timeRemaining)) {
      state.timeRemaining = msg.timeRemaining;
    }
    state.ballOwner = state.vx < 0 ? 'h' : 'g';

    if (msg.st > halfRtt) {
      state.serveTimer = msg.st - halfRtt;
    } else {
      state.serveTimer = 0;
      this.#audio.playServe();
      this.#physics.advanceVisual(state, halfRtt - msg.st);
    }

    this.#syncStatusUI();
  }

  #sendGameSettings() {
    if (!this.#network.isHost || !this.#network.connected) return;
    this.#network.send(MSG_TYPE.GAME_SETTINGS, {
      settings: this.#state.settings,
      timeRemaining: this.#state.timeRemaining
    });
  }

  #sendPaddleColor() {
    if (!this.#network.connected) return;
    this.#network.send(MSG_TYPE.PADDLE_COLOR, { colorId: this.#localColorId });
  }

  #sendWinSound() {
    if (!this.#network.connected) return;
    this.#network.send(MSG_TYPE.WIN_SOUND, { winSoundId: this.#audio.selectedWinSoundId });
  }

  #sendServe() {
    if (!this.#network.isHost || !this.#network.connected) return;
    const s = this.#state;
    this.#network.send(MSG_TYPE.SERVE, {
      round: s.currentRound,
      bx: s.ballX,
      by: s.ballY,
      vx: s.vx,
      vy: s.vy,
      hs: s.hostScore,
      gs: s.guestScore,
      st: s.serveTimer,
      timeRemaining: s.timeRemaining
    });
  }

  #sendSyncState() {
    if (!this.#network.isHost || !this.#network.connected) return;
    const s = this.#state;
    this.#network.send(MSG_TYPE.SYNC_STATE, {
      round: s.currentRound,
      hitSeq: s.hitSeq,
      owner: s.ballOwner,
      bx: s.ballX,
      by: s.ballY,
      vx: s.vx,
      vy: s.vy,
      st: s.serveTimer,
      hs: s.hostScore,
      gs: s.guestScore,
      hy: s.hostY,
      paused: s.paused,
      pauseReason: s.pauseReason,
      pausedBy: s.pausedBy,
      settings: s.settings,
      timeRemaining: s.timeRemaining,
      matchOver: s.matchOver,
      winner: s.winner
    });
  }

  #checkMatchWinner() {
    if (!this.#network.isHost || this.#state.matchOver) return false;
    const winner = evaluateMatchWinner(this.#state, this.#state.settings);
    if (!winner) return false;

    if (!this.#currentMatchId) {
      this.#currentMatchId = generateMatchId();
    }

    const winSoundId =
      winner === 'host' ? this.#audio.selectedWinSoundId : this.#remoteWinSoundId;

    this.#state.setMatchOver(winner);
    this.#network.send(MSG_TYPE.MATCH_OVER, {
      matchId: this.#currentMatchId,
      winner,
      winSoundId,
      hs: this.#state.hostScore,
      gs: this.#state.guestScore,
      timeRemaining: this.#state.timeRemaining
    });
    this.#playMatchOverSound(winSoundId);
    this.#syncStatusUI();
    this.#initiateMatchReceiptSigning(winner);
    return true;
  }

  #playMatchOverSound(winSoundId) {
    this.#audio.playMatchWin(winSoundId);
  }

  #syncStatusUI() {
    const net = this.#network;
    const s = this.#state;

    this.#ui.updateMatchControls({
      inRoom: net.inRoom,
      isHost: net.isHost,
      connected: net.connected,
      connectionLost: net.connectionLost,
      matchActive: s.matchActive,
      matchOver: s.matchOver,
      paused: s.paused
    });

    const showPing = net.connected && !net.connectionLost;
    this.#ui.updatePing(net.rttMs, showPing);

    if (!net.inRoom) {
      this.#ui.setStatus('Host a room or join with a code');
      return;
    }

    if (net.connectionLost) {
      const offlineMsg = !navigator.onLine ? 'You are offline' : 'Connection lost';
      this.#ui.setStatus(`${offlineMsg} — Game paused. Waiting in ${net.roomCode}...`, 'error');
    } else if (!net.connected) {
      this.#ui.setStatus(
        net.isHost
          ? `Waiting for friend to join ${net.roomCode}...`
          : `Connecting to room ${net.roomCode}...`,
        'waiting'
      );
    } else if (s.matchOver) {
      const localWon = (net.isHost && s.winner === 'host') || (!net.isHost && s.winner === 'guest');
      this.#ui.setStatus(
        `${net.roomCode} — Match over (${localWon ? 'You won!' : 'Opponent won!'})`,
        'connected'
      );
    } else if (s.paused) {
      const reasonText = s.pauseReason === 'reconnected'
        ? 'Connection restored — Press Space to resume'
        : `Paused by ${s.pausedBy || 'player'} — Press Space to resume`;
      this.#ui.setStatus(`${net.roomCode} — ${reasonText}`, 'paused');
    } else {
      const roleLabel = net.isHost ? 'Left Paddle (Host)' : 'Right Paddle (Guest)';
      this.#ui.setStatus(`Connected in ${net.roomCode} — You are ${roleLabel}`, 'connected');
    }
  }

  #getOverlayState() {
    const net = this.#network;
    const s = this.#state;

    if (!net.inRoom) {
      return {
        title: 'P2P PONG',
        subtitle: 'Host a game or enter a room code above',
        accentColor: '#fff'
      };
    }

    if (net.connectionLost) {
      return {
        title: 'CONNECTION LOST — GAME PAUSED',
        subtitle: !navigator.onLine
          ? 'You are offline. Waiting for internet...'
          : 'Waiting for opponent to reconnect...',
        accentColor: '#eb5757'
      };
    }

    if (!net.connected) {
      return {
        title: net.isHost ? `ROOM CODE: ${net.roomCode}` : `JOINING ${net.roomCode}...`,
        subtitle: net.isHost
          ? 'Waiting for your friend to join...'
          : 'Establishing peer-to-peer connection...',
        accentColor: '#f2c94c'
      };
    }

    if (s.matchOver) {
      const localWon = (net.isHost && s.winner === 'host') || (!net.isHost && s.winner === 'guest');
      return {
        title: localWon ? 'YOU WIN!' : 'YOU LOSE',
        subtitle: net.isHost
          ? `Final Score: ${s.hostScore} – ${s.guestScore} • Click "Play Again" to rematch`
          : `Final Score: ${s.hostScore} – ${s.guestScore} • Waiting for host to start rematch`,
        accentColor: localWon ? '#6fcf97' : '#eb5757'
      };
    }

    if (s.paused) {
      return {
        title: 'PAUSED',
        subtitle: s.pauseReason === 'reconnected'
          ? 'Connection restored — Press SPACE to resume'
          : `Paused by ${s.pausedBy || 'player'} — Press SPACE to resume`,
        accentColor: '#56ccf2'
      };
    }

    return null;
  }

  #getPaddleRenderColors() {
    const localHex = resolvePaddleColor(this.#localColorId).hex;
    const remoteHex = this.#network.inRoom
      ? resolvePaddleColor(this.#remoteColorId).hex
      : resolvePaddleColor(PADDLE_CONFIG.DEFAULT_COLOR_ID).hex;

    const isHost = !this.#network.inRoom || this.#network.isHost;
    return {
      hostColor: isHost ? localHex : remoteHex,
      guestColor: isHost ? remoteHex : localHex
    };
  }

  #loop(now) {
    const dt = Math.min((now - this.#lastFrameTime) / 1000, GAME_CONFIG.MAX_FRAME_DT);
    this.#lastFrameTime = now;

    if (this.#state.matchActive) {
      this.#network.checkTimeout(now);
    }

    const activePlay = (
      this.#network.connected &&
      !this.#state.paused &&
      !this.#network.connectionLost &&
      this.#state.matchActive &&
      !this.#state.matchOver
    );

    if (activePlay) {
      this.#updateSimulation(now, dt);
    }

    const { hostColor, guestColor } = this.#getPaddleRenderColors();
    this.#renderer.render(this.#state, {
      inRoom: this.#network.inRoom,
      isHost: this.#network.isHost,
      hostColor,
      guestColor,
      overlay: this.#getOverlayState()
    });
  }

  #updateSimulation(now, dt) {
    const state = this.#state;
    const net = this.#network;
    const isHost = net.isHost;

    state.moveLocalPaddle(isHost, this.#input.getVerticalDirection(), dt);
    state.decayVisualError(dt);

    const myY = Math.round(state.getLocalPaddleY(isHost));
    const timeSinceSend = now - this.#lastPaddleSend;
    if (
      timeSinceSend >= NETWORK_CONFIG.PADDLE_SEND_INTERVAL_MS &&
      (myY !== this.#lastSentPaddleY || timeSinceSend >= NETWORK_CONFIG.PADDLE_HEARTBEAT_MS)
    ) {
      this.#lastPaddleSend = now;
      this.#lastSentPaddleY = myY;
      net.send(MSG_TYPE.PADDLE, { y: myY });
    }

    if (
      state.settings.mode === MATCH_MODES.TIMED &&
      state.timeRemaining > 0 &&
      state.serveTimer <= 0 &&
      !state.waitingForServe
    ) {
      state.timeRemaining = Math.max(0, state.timeRemaining - dt);
      if (isHost && state.timeRemaining <= 0 && this.#checkMatchWinner()) {
        return;
      }
    }

    this.#physics.step(state, dt, {
      onServeStart: () => this.#audio.playServe(),
      onWallBounce: () => this.#audio.playWallBounce(),
      onPaddleHit: (side) => this.#handlePaddleHit(side),
      onMiss: (side) => this.#handleMiss(side)
    });

    const fallbackMargin = Math.max(
      GAME_CONFIG.GUEST_MISS_FALLBACK_MARGIN,
      state.settings.maxBallSpeed * GAME_CONFIG.GUEST_MISS_FALLBACK_SEC
    );
    const fallbackX = GAME_CONFIG.WIDTH + GAME_CONFIG.BALL_RADIUS + fallbackMargin;
    if (isHost && !state.matchOver && state.ballOwner === 'g' && state.ballX > fallbackX) {
      state.hostScore++;
      this.#audio.playScore(true);
      if (!this.#checkMatchWinner()) {
        state.prepareServe(-1);
        this.#sendServe();
      }
    }
  }

  #handlePaddleHit(side) {
    const state = this.#state;
    const isHost = this.#network.isHost;
    const expectedOwner = side === 'left' ? 'h' : 'g';
    const nextOwner = side === 'left' ? 'g' : 'h';
    const isAuthoritative = (side === 'left' && isHost) || (side === 'right' && !isHost);
    const speed = Math.hypot(state.vx, state.vy);

    if (isAuthoritative && state.ballOwner === expectedOwner) {
      state.ballOwner = nextOwner;
      state.hitSeq++;
      state.lastHitSeq = state.hitSeq;
      this.#audio.playPaddleHitOnce(state.currentRound, state.hitSeq, side, speed);
      this.#network.send(MSG_TYPE.HIT, {
        round: state.currentRound,
        hitSeq: state.hitSeq,
        bx: state.ballX,
        by: state.ballY,
        vx: state.vx,
        vy: state.vy
      });
    } else if (!isAuthoritative && state.ballOwner === expectedOwner) {
      this.#audio.playPaddleHitOnce(state.currentRound, state.hitSeq + 1, side, speed);
    }
  }

  #handleMiss(side) {
    const state = this.#state;
    const isHost = this.#network.isHost;

    if (side === 'left' && isHost && state.ballOwner === 'h') {
      state.guestScore++;
      this.#audio.playScore(false);
      if (!this.#checkMatchWinner()) {
        state.prepareServe(1);
        this.#sendServe();
      }
      return true;
    }

    if (side === 'right' && !isHost && state.ballOwner === 'g') {
      state.waitingForServe = true;
      this.#network.send(MSG_TYPE.MISS, { round: state.currentRound });
      return true;
    }

    return false;
  }
}