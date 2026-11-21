import { fromBase64Url, toBase64Url } from './BinaryCodec.js';
import {
  bytesEqual,
  derivePlayerId,
  derivePlayerIdBytes,
  formatPlayerTag,
  getShortId,
  normalizeCompressedKeyB64,
  signBytes,
  signText,
  verifyBytes,
  verifyText
} from './IdentityCrypto.js';
import { IdentityStore } from './IdentityStore.js';
import {
  RECEIPT_VERSION,
  VOUCH_VERSION,
  clampU16,
  computeWinner,
  decodeReceiptBodyBytes,
  encodeReceiptBodyBytes,
  encodeVouchBodyBytes,
  normalizeCompactTag,
  pairHash8,
  sanitizeNickname
} from './RecordCodec.js';
import {
  buildSyncManifest,
  decodeAndStoreRemoteVouches,
  decodeAndVerifyReceiptBatch,
  encodeMissingReceiptBatches,
  encodeMissingVouchBatch
} from './SyncProtocol.js';
import {
  evaluatePeerTrust,
  getMergedReceiptsForPeer,
  getVouchedFriendsList,
  summarizeMyHistory,
  summarizePeerHistory
} from './WebOfTrust.js';

export { sanitizeNickname };

const MAX_NICK_AGE_MS = 5 * 60 * 1000;
const MAX_NICK_FUTURE_SKEW_MS = 60 * 1000;
const MAX_NICK_CACHE = 512;

export class TrustLedger {
  #store = new IdentityStore();
  #lastLocalNickTs = 0;
  #lastNickUpdateTs = new Map();

  get ready() {
    return this.#store.ready;
  }

  get myPlayerId() {
    return this.#store.myPlayerId;
  }

  get myShortId() {
    return this.#store.myShortId;
  }

  get myNickname() {
    return this.#store.myNickname;
  }

  get myDisplayTag() {
    return this.#store.myDisplayTag;
  }

  get myCompressedKeyB64() {
    return this.#store.myCompressedKeyB64;
  }

  get myReceipts() {
    return this.#store.myReceipts.map((r) => ({ parsed: r.parsed }));
  }

  get trustedAnchors() {
    return Array.from(this.#store.trustedAnchors.values());
  }

  async init() {
    await this.#store.init();
    this.#lastLocalNickTs = 0;
    this.#lastNickUpdateTs.clear();
  }

  setNickname(rawName) {
    return this.#store.setNickname(rawName);
  }

  async createNicknameUpdate(nickname, sessionNonce = '') {
    if (!this.#store.ready) return null;
    const clean = sanitizeNickname(nickname);
    const ts = Math.max(Date.now(), this.#lastLocalNickTs + 1);
    this.#lastLocalNickTs = ts;
    const scope = typeof sessionNonce === 'string' && sessionNonce ? `${sessionNonce}:` : '';
    const sig = await signText(this.#store.myPrivateKey, `nick:${scope}${ts}:${clean}`);
    return { nick: clean, ts, sig };
  }

  async verifyNicknameUpdate(peerCompressedKeyB64, msg, sessionNonce = '') {
    if (
      !msg ||
      typeof msg.nick !== 'string' ||
      !Number.isSafeInteger(msg.ts) ||
      typeof msg.sig !== 'string'
    ) {
      return null;
    }
    const now = Date.now();
    if (msg.ts > now + MAX_NICK_FUTURE_SKEW_MS || now - msg.ts > MAX_NICK_AGE_MS) {
      return null;
    }
    const cleanKeyB64 = normalizeCompressedKeyB64(peerCompressedKeyB64);
    if (!cleanKeyB64) return null;

    const scope = typeof sessionNonce === 'string' && sessionNonce ? `${sessionNonce}:` : '';
    const cacheKey = `${cleanKeyB64}:${scope}`;
    const prevTs = this.#lastNickUpdateTs.get(cacheKey) ?? -Infinity;
    if (msg.ts <= prevTs) {
      return null;
    }

    const clean = sanitizeNickname(msg.nick);
    const valid = await verifyText(cleanKeyB64, `nick:${scope}${msg.ts}:${clean}`, msg.sig);
    if (!valid) return null;

    this.#lastNickUpdateTs.delete(cacheKey);
    this.#lastNickUpdateTs.set(cacheKey, msg.ts);
    if (this.#lastNickUpdateTs.size > MAX_NICK_CACHE) {
      const oldest = this.#lastNickUpdateTs.keys().next().value;
      this.#lastNickUpdateTs.delete(oldest);
    }

    this.#store.updateAnchorNicknameByKey(cleanKeyB64, clean);
    return clean;
  }

  // --- Peer Authentication ---

  async createAuthResponse(nonce, verifierId) {
    if (!this.#store.ready || typeof nonce !== 'string' || typeof verifierId !== 'string') {
      return null;
    }
    const authString = `auth:${nonce}:${verifierId}:${this.#store.myNickname}`;
    const signature = await signText(this.#store.myPrivateKey, authString);
    return {
      k: this.#store.myCompressedKeyB64,
      nick: this.#store.myNickname,
      s: signature
    };
  }

  async verifyAuthResponse(params) {
    if (!params || !this.#store.ready || typeof params.expectedNonce !== 'string') return null;
    const { compressedKeyB64, nickname, signature, expectedNonce } = params;

    const cleanKeyB64 = normalizeCompressedKeyB64(compressedKeyB64);
    if (!cleanKeyB64) return null;

    const playerIdBytes = await derivePlayerIdBytes(cleanKeyB64);
    if (!playerIdBytes) return null;
    const playerId = toBase64Url(playerIdBytes);
    if (playerId === this.#store.myPlayerId) return null;

    const cleanNickname = sanitizeNickname(nickname);
    const authString = `auth:${expectedNonce}:${this.#store.myPlayerId}:${cleanNickname}`;
    const valid = await verifyText(cleanKeyB64, authString, signature);
    if (!valid) return null;

    this.#store.setKey(playerId, cleanKeyB64);
    this.#store.pruneKeyRing();
    return {
      playerId,
      playerIdBytes,
      shortId: getShortId(playerId),
      nickname: cleanNickname,
      displayTag: formatPlayerTag(cleanNickname, playerId),
      compressedKeyB64: cleanKeyB64
    };
  }

  // --- Dual-Signed Match Receipts ---

  async createMatchReceiptOffer({
    matchId,
    hostId,
    hostNick,
    guestId,
    guestNick,
    hostScore,
    guestScore,
    settings
  }) {
    if (!this.#store.ready) return null;
    const hostIdBytes = fromBase64Url(hostId);
    const guestIdBytes = fromBase64Url(guestId);
    if (
      !hostIdBytes ||
      hostIdBytes.length !== 32 ||
      !guestIdBytes ||
      guestIdBytes.length !== 32 ||
      bytesEqual(hostIdBytes, guestIdBytes)
    ) {
      return null;
    }

    const cleanHostScore = clampU16(hostScore);
    const cleanGuestScore = clampU16(guestScore);

    const parsed = {
      version: RECEIPT_VERSION,
      type: 'match-receipt',
      matchId,
      timestamp: Date.now(),
      host: { id: hostId, nickname: sanitizeNickname(hostNick) },
      guest: { id: guestId, nickname: sanitizeNickname(guestNick) },
      hostScore: cleanHostScore,
      guestScore: cleanGuestScore,
      winner: computeWinner(cleanHostScore, cleanGuestScore),
      settings: {
        mode: normalizeCompactTag(settings?.mode, 'first-to'),
        difficulty: normalizeCompactTag(settings?.difficulty, 'normal'),
        targetScore: clampU16(settings?.targetScore),
        timeLimitSec: clampU16(settings?.timeLimitSec)
      }
    };

    const bodyBytes = encodeReceiptBodyBytes(parsed, hostIdBytes, guestIdBytes);
    const sigBytes = await signBytes(this.#store.myPrivateKey, bodyBytes);

    return { bodyBytes, sigBytes, hostIdBytes, guestIdBytes, parsed };
  }

  async acceptMatchReceiptOffer({
    bodyB64,
    hostSigB64,
    peerCompressedKeyB64,
    expectedHostId,
    expectedGuestId,
    expectedMatchId,
    expectedHostScore,
    expectedGuestScore,
    expectedWinner,
    expectedMode,
    expectedDifficulty,
    expectedTargetScore,
    expectedTimeLimitSec,
    expectedHostNickname,
    expectedGuestNickname
  }) {
    if (!this.#store.ready || expectedGuestId !== this.#store.myPlayerId) return null;
    const bodyBytes = fromBase64Url(bodyB64);
    const hostSigBytes = fromBase64Url(hostSigB64);
    const cleanPeerKeyB64 = normalizeCompressedKeyB64(peerCompressedKeyB64);
    if (!bodyBytes || !hostSigBytes || hostSigBytes.length !== 64 || !cleanPeerKeyB64) return null;

    const derivedPeerId = await derivePlayerId(cleanPeerKeyB64);
    if (!derivedPeerId || derivedPeerId !== expectedHostId) return null;

    let decoded;
    try {
      decoded = decodeReceiptBodyBytes(bodyBytes);
    } catch {
      return null;
    }
    if (!decoded) return null;

    const { parsed, matchIdBytes, hostIdBytes, guestIdBytes } = decoded;
    if (
      parsed.matchId !== expectedMatchId ||
      parsed.host.id !== expectedHostId ||
      parsed.guest.id !== expectedGuestId ||
      parsed.hostScore !== expectedHostScore ||
      parsed.guestScore !== expectedGuestScore ||
      parsed.winner !== expectedWinner ||
      parsed.settings.mode !== normalizeCompactTag(expectedMode, '') ||
      (expectedDifficulty !== undefined &&
        parsed.settings.difficulty !== normalizeCompactTag(expectedDifficulty, '')) ||
      (expectedTargetScore !== undefined &&
        parsed.settings.targetScore !== clampU16(expectedTargetScore)) ||
      (expectedTimeLimitSec !== undefined &&
        parsed.settings.timeLimitSec !== clampU16(expectedTimeLimitSec)) ||
      (expectedHostNickname !== undefined &&
        parsed.host.nickname !== sanitizeNickname(expectedHostNickname)) ||
      (expectedGuestNickname !== undefined &&
        parsed.guest.nickname !== sanitizeNickname(expectedGuestNickname)) ||
      Math.abs(Date.now() - parsed.timestamp) > 5 * 60 * 1000
    ) {
      return null;
    }

    const hostValid = await verifyBytes(cleanPeerKeyB64, bodyBytes, hostSigBytes);
    if (!hostValid) return null;

    const guestSigBytes = await signBytes(this.#store.myPrivateKey, bodyBytes);
    const receipt = {
      bodyBytes,
      hostSigBytes,
      guestSigBytes,
      matchIdPrefix8: matchIdBytes.subarray(0, 8),
      hostIdBytes,
      guestIdBytes,
      parsed
    };

    this.#store.setKey(parsed.host.id, cleanPeerKeyB64);
    this.#store.storeMyReceipt(receipt);
    this.#store.persist();
    return receipt;
  }

  async finalizeHostMatchReceipt({ offer, guestSigB64, peerCompressedKeyB64, expectedGuestId }) {
    if (!this.#store.ready || !offer) return null;
    if (offer.parsed.host.id !== this.#store.myPlayerId || offer.parsed.guest.id !== expectedGuestId) {
      return null;
    }

    const cleanPeerKeyB64 = normalizeCompressedKeyB64(peerCompressedKeyB64);
    if (!cleanPeerKeyB64) return null;
    const derivedPeerId = await derivePlayerId(cleanPeerKeyB64);
    if (!derivedPeerId || derivedPeerId !== expectedGuestId) return null;

    const guestSigBytes = fromBase64Url(guestSigB64);
    if (!guestSigBytes || guestSigBytes.length !== 64) return null;

    const guestValid = await verifyBytes(cleanPeerKeyB64, offer.bodyBytes, guestSigBytes);
    if (!guestValid) return null;

    const receipt = {
      bodyBytes: offer.bodyBytes,
      hostSigBytes: offer.sigBytes,
      guestSigBytes,
      matchIdPrefix8: offer.bodyBytes.subarray(1, 9),
      hostIdBytes: offer.hostIdBytes,
      guestIdBytes: offer.guestIdBytes,
      parsed: offer.parsed
    };

    this.#store.setKey(offer.parsed.guest.id, cleanPeerKeyB64);
    this.#store.storeMyReceipt(receipt);
    this.#store.persist();
    return receipt;
  }

  // --- Signed Vouches & Trust Anchors ---

  isTrustedAnchor(playerId) {
    return this.#store.isTrustedAnchor(playerId);
  }

  async toggleTrustAnchor(peerProfile) {
    if (!this.#store.ready || !peerProfile?.playerId || peerProfile.playerId === this.#store.myPlayerId) {
      return null;
    }

    const compKeyB64 = normalizeCompressedKeyB64(peerProfile.compressedKeyB64);
    if (!compKeyB64) return null;

    const derivedId = await derivePlayerId(compKeyB64);
    if (!derivedId || derivedId !== peerProfile.playerId) return null;

    const active = !this.#store.isTrustedAnchor(peerProfile.playerId);
    const vouch = await this.#createSignedVouch(
      { playerId: peerProfile.playerId, nickname: peerProfile.nickname },
      active
    );
    if (!vouch) return null;

    this.#store.setKey(peerProfile.playerId, compKeyB64);
    if (active) {
      this.#store.setTrustedAnchor(peerProfile.playerId, {
        playerId: peerProfile.playerId,
        shortId: getShortId(peerProfile.playerId),
        nickname: sanitizeNickname(peerProfile.nickname),
        compressedKeyB64: compKeyB64,
        addedAt: Date.now()
      });
    } else {
      this.#store.deleteTrustedAnchor(peerProfile.playerId);
    }

    this.#store.storeVouch(vouch);
    this.#store.pruneKeyRing();
    this.#store.persist();
    return { active, vouch };
  }

  async revokeTrustAnchor(playerId) {
    const existing = this.#store.deleteTrustedAnchor(playerId);
    if (!existing) return null;

    const vouch = await this.#createSignedVouch(existing, false);
    if (vouch) {
      this.#store.storeVouch(vouch);
    }

    this.#store.pruneKeyRing();
    this.#store.persist();
    return vouch;
  }

  // --- Delta Sync Delegation ---

  buildSyncManifest(peerId, existingRemoteReceipts = []) {
    return buildSyncManifest(this.#store, peerId, existingRemoteReceipts);
  }

  encodeMissingReceiptBatches(peerId, peerManifest, chunkSize = 30) {
    return encodeMissingReceiptBatches(this.#store, peerId, peerManifest, chunkSize);
  }

  decodeAndVerifyReceiptBatch(batchB64, remotePeer, knownMatchIds = new Set()) {
    return decodeAndVerifyReceiptBatch(this.#store, batchB64, remotePeer, knownMatchIds);
  }

  encodeMissingVouchBatch(peerId, peerManifest = null, explicitVouches = null) {
    return encodeMissingVouchBatch(this.#store, peerId, peerManifest, explicitVouches);
  }

  decodeAndStoreRemoteVouches(batchB64, remotePeer) {
    return decodeAndStoreRemoteVouches(this.#store, batchB64, remotePeer);
  }

  // --- Web of Trust Queries ---

  summarizeMyHistory() {
    return summarizeMyHistory(this.#store.myPlayerId, this.#store.myReceipts);
  }

  getMergedReceiptsForPeer(peerId, remoteReceipts = []) {
    return getMergedReceiptsForPeer(
      peerId,
      this.#store.myReceipts,
      this.#store.graphReceipts,
      remoteReceipts
    );
  }

  evaluatePeerTrust(targetId, remoteReceipts = []) {
    return evaluatePeerTrust(targetId, this.#graphData(), remoteReceipts);
  }

  summarizePeerHistory(mergedReceipts, peerId) {
    return summarizePeerHistory(mergedReceipts, peerId, this.#graphData());
  }

  getVouchedFriendsList() {
    return getVouchedFriendsList(this.#graphData());
  }

  // --- Backup Export / Import ---

  exportBackupJson() {
    return this.#store.exportBackupJson();
  }

  async importBackupJson(rawText) {
    const result = await this.#store.importBackupJson(rawText);
    if (result.ok) {
      this.#lastLocalNickTs = 0;
      this.#lastNickUpdateTs.clear();
    }
    return result;
  }

  #graphData() {
    return {
      myId: this.#store.myPlayerId,
      myDisplayTag: this.#store.myDisplayTag,
      myReceipts: this.#store.myReceipts,
      graphReceipts: this.#store.graphReceipts,
      trustedAnchors: this.#store.trustedAnchors,
      vouches: this.#store.vouches
    };
  }

  async #createSignedVouch(subjectProfile, active) {
    const subjectIdBytes = fromBase64Url(subjectProfile.playerId);
    if (!subjectIdBytes || subjectIdBytes.length !== 32) return null;

    const prevTimestamp =
      this.#store.getVouch(this.#store.myPlayerId, subjectProfile.playerId)?.parsed.timestamp || 0;
    const timestamp = Math.max(Date.now(), prevTimestamp + 1);

    const parsed = {
      version: VOUCH_VERSION,
      type: 'vouch',
      active: Boolean(active),
      timestamp,
      voucher: { id: this.#store.myPlayerId },
      subject: { id: subjectProfile.playerId, nickname: sanitizeNickname(subjectProfile.nickname) }
    };

    const bodyBytes = encodeVouchBodyBytes(parsed, this.#store.myPlayerIdBytes, subjectIdBytes);
    const sigBytes = await signBytes(this.#store.myPrivateKey, bodyBytes);

    return {
      bodyBytes,
      sigBytes,
      voucherIdBytes: this.#store.myPlayerIdBytes,
      subjectIdBytes,
      pairHash: pairHash8(this.#store.myPlayerIdBytes, subjectIdBytes),
      parsed
    };
  }
}
