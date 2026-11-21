import { IDENTITY_CONFIG } from '../config/constants.js';
import {
  ByteReader,
  ByteWriter,
  bytesEqual,
  derivePlayerId,
  derivePlayerIdBytes,
  formatPlayerTag,
  fromBase64Url,
  generateIdentityKeyPair,
  getShortId,
  importPrivateKey,
  importPublicKey,
  normalizeCompressedKeyB64,
  signBytes,
  signText,
  toBase64Url,
  verifyBytes,
  verifyText
} from './IdentityCrypto.js';
import {
  CODE_TO_DIFF,
  CODE_TO_MODE,
  DIFF_TO_CODE,
  MODE_TO_CODE,
  RECEIPT_VERSION,
  VOUCH_VERSION,
  clampU16,
  computeWinner,
  decodeReceiptBodyBytes,
  decodeSignedBatch,
  decodeVouchBodyBytes,
  encodeReceiptBodyBytes,
  encodeSignedBatch,
  encodeVouchBodyBytes,
  normalizeCompactTag,
  packReceipt,
  packVouch,
  pairHash8,
  readCompactTag,
  sanitizeNickname,
  unpackReceipt,
  unpackVouch,
  writeCompactTag
} from './RecordCodec.js';

export { sanitizeNickname };

const MAX_FUTURE_SKEW_MS = 15 * 60 * 1000;
const MAX_NICK_AGE_MS = 5 * 60 * 1000;
const MAX_NICK_FUTURE_SKEW_MS = 60 * 1000;
const MAX_TRANSIENT_KEYS = 256;
const MAX_NICK_CACHE = 512;

function bloomBitIndices(id) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return [(h1 >>> 0) & 511, (h2 >>> 0) & 511];
}

export class TrustLedger {
  #identity = null;
  #myReceipts = []; // [{ bodyBytes, hostSigBytes, guestSigBytes, matchIdPrefix8, hostIdBytes, guestIdBytes, parsed }]
  #graphReceipts = [];
  #trustedAnchors = new Map(); // playerId -> { playerId, shortId, nickname, compressedKeyB64, addedAt }
  #vouches = new Map(); // `${voucherId}:${subjectId}` -> { bodyBytes, sigBytes, voucherIdBytes, subjectIdBytes, pairHash, parsed }
  #keyRing = new Map(); // playerId -> compressedKeyB64 (33-byte P-256 compressed key in base64url)
  #lastLocalNickTs = 0;
  #lastNickUpdateTs = new Map(); // `${cleanKeyB64}:${sessionNonce}` -> last verified timestamp

  get ready() {
    return this.#identity !== null;
  }

  get myPlayerId() {
    return this.#identity?.playerId || '';
  }

  get myShortId() {
    return this.#identity?.shortId || '';
  }

  get myNickname() {
    return this.#identity?.nickname || IDENTITY_CONFIG.DEFAULT_NICKNAME;
  }

  get myDisplayTag() {
    return this.#identity
      ? formatPlayerTag(this.#identity.nickname, this.#identity.playerId)
      : 'Player#------';
  }

  get myCompressedKeyB64() {
    return this.#identity?.compressedKeyB64 || '';
  }

  get myReceipts() {
    return this.#myReceipts.map((r) => ({
      parsed: r.parsed
    }));
  }

  get trustedAnchors() {
    return Array.from(this.#trustedAnchors.values());
  }

  summarizeMyHistory() {
    const myId = this.#identity?.playerId || '';
    const stats = { wins: 0, losses: 0, draws: 0, total: 0 };

    for (const r of this.#myReceipts) {
      const p = r.parsed;
      const iWasHost = p.host.id === myId;
      const iWon = (iWasHost && p.winner === 'host') || (!iWasHost && p.winner === 'guest');
      stats.total++;
      if (p.winner === 'draw') stats.draws++;
      else if (iWon) stats.wins++;
      else stats.losses++;
    }

    return stats;
  }

  async init() {
    let loaded = false;
    try {
      const raw = localStorage.getItem(IDENTITY_CONFIG.STORAGE_KEY);
      if (raw) {
        loaded = await this.#loadFromObject(JSON.parse(raw), { verifySignatures: false });
      }
    } catch {
      loaded = false;
    }

    if (!loaded) {
      const kp = await generateIdentityKeyPair();
      const playerIdBytes = await derivePlayerIdBytes(kp.compressedKey);
      const playerId = toBase64Url(playerIdBytes);
      this.#identity = {
        playerId,
        playerIdBytes,
        shortId: getShortId(playerId),
        nickname: IDENTITY_CONFIG.DEFAULT_NICKNAME,
        compressedKey: kp.compressedKey,
        compressedKeyB64: kp.compressedKeyB64,
        privateD: kp.privateD,
        publicKey: kp.publicKey,
        privateKey: kp.privateKey
      };
      this.#myReceipts = [];
      this.#graphReceipts = [];
      this.#trustedAnchors.clear();
      this.#vouches.clear();
      this.#keyRing.clear();
      this.#keyRing.set(playerId, kp.compressedKeyB64);
      this.#lastLocalNickTs = 0;
      this.#lastNickUpdateTs.clear();
      this.#persist();
    }
  }

  setNickname(rawName) {
    if (!this.#identity) return '';
    this.#identity.nickname = sanitizeNickname(rawName);
    this.#persist();
    return this.#identity.nickname;
  }

  async createNicknameUpdate(nickname, sessionNonce = '') {
    if (!this.#identity) return null;
    const clean = sanitizeNickname(nickname);
    const ts = Math.max(Date.now(), this.#lastLocalNickTs + 1);
    this.#lastLocalNickTs = ts;
    const scope = typeof sessionNonce === 'string' && sessionNonce ? `${sessionNonce}:` : '';
    const sig = await signText(this.#identity.privateKey, `nick:${scope}${ts}:${clean}`);
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

    let anchorUpdated = false;
    for (const anchor of this.#trustedAnchors.values()) {
      if (anchor.compressedKeyB64 === cleanKeyB64 && anchor.nickname !== clean) {
        anchor.nickname = clean;
        anchorUpdated = true;
      }
    }
    if (anchorUpdated) {
      this.#persist();
    }

    return clean;
  }

  // --- Peer Authentication ---

  async createAuthResponse(nonce, verifierId) {
    if (!this.#identity || typeof nonce !== 'string' || typeof verifierId !== 'string') {
      return null;
    }
    const authString = `auth:${nonce}:${verifierId}:${this.#identity.nickname}`;
    const signature = await signText(this.#identity.privateKey, authString);
    return {
      k: this.#identity.compressedKeyB64,
      nick: this.#identity.nickname,
      s: signature
    };
  }

  async verifyAuthResponse(params) {
    if (!params || !this.#identity || typeof params.expectedNonce !== 'string') return null;
    const { compressedKeyB64, nickname, signature, expectedNonce } = params;

    const cleanKeyB64 = normalizeCompressedKeyB64(compressedKeyB64);
    if (!cleanKeyB64) return null;

    const playerIdBytes = await derivePlayerIdBytes(cleanKeyB64);
    if (!playerIdBytes) return null;
    const playerId = toBase64Url(playerIdBytes);
    if (playerId === this.#identity.playerId) return null;

    const cleanNickname = sanitizeNickname(nickname);
    const authString = `auth:${expectedNonce}:${this.#identity.playerId}:${cleanNickname}`;
    const valid = await verifyText(cleanKeyB64, authString, signature);
    if (!valid) return null;

    this.#keyRing.set(playerId, cleanKeyB64);
    this.#pruneKeyRing();
    return {
      playerId,
      playerIdBytes,
      shortId: getShortId(playerId),
      nickname: cleanNickname,
      displayTag: formatPlayerTag(cleanNickname, playerId),
      compressedKeyB64: cleanKeyB64
    };
  }

  // --- Dual-Signed Match Receipts (Binary) ---

  async createMatchReceiptOffer({ matchId, hostId, hostNick, guestId, guestNick, hostScore, guestScore, settings }) {
    if (!this.#identity) return null;
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
        mode: normalizeCompactTag(settings?.mode, 'firstTo'),
        difficulty: normalizeCompactTag(settings?.difficulty, 'normal'),
        targetScore: clampU16(settings?.targetScore),
        timeLimitSec: clampU16(settings?.timeLimitSec)
      }
    };

    const bodyBytes = encodeReceiptBodyBytes(parsed, hostIdBytes, guestIdBytes);
    const sigBytes = await signBytes(this.#identity.privateKey, bodyBytes);

    return {
      bodyBytes,
      sigBytes,
      hostIdBytes,
      guestIdBytes,
      parsed
    };
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
    if (!this.#identity || expectedGuestId !== this.#identity.playerId) return null;
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
      (expectedTargetScore !== undefined && parsed.settings.targetScore !== clampU16(expectedTargetScore)) ||
      (expectedTimeLimitSec !== undefined && parsed.settings.timeLimitSec !== clampU16(expectedTimeLimitSec)) ||
      (expectedHostNickname !== undefined && parsed.host.nickname !== sanitizeNickname(expectedHostNickname)) ||
      (expectedGuestNickname !== undefined && parsed.guest.nickname !== sanitizeNickname(expectedGuestNickname)) ||
      Math.abs(Date.now() - parsed.timestamp) > 5 * 60 * 1000
    ) {
      return null;
    }

    const hostValid = await verifyBytes(cleanPeerKeyB64, bodyBytes, hostSigBytes);
    if (!hostValid) return null;

    const guestSigBytes = await signBytes(this.#identity.privateKey, bodyBytes);
    const receipt = {
      bodyBytes,
      hostSigBytes,
      guestSigBytes,
      matchIdPrefix8: matchIdBytes.subarray(0, 8),
      hostIdBytes,
      guestIdBytes,
      parsed
    };

    this.#keyRing.set(parsed.host.id, cleanPeerKeyB64);
    this.#storeMyReceipt(receipt);
    this.#persist();
    return receipt;
  }

  async finalizeHostMatchReceipt({ offer, guestSigB64, peerCompressedKeyB64, expectedGuestId }) {
    if (!this.#identity || !offer) return null;
    if (offer.parsed.host.id !== this.#identity.playerId || offer.parsed.guest.id !== expectedGuestId) {
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

    this.#keyRing.set(offer.parsed.guest.id, cleanPeerKeyB64);
    this.#storeMyReceipt(receipt);
    this.#persist();
    return receipt;
  }

  // --- Delta Sync Manifest & Compressed Batch Encoding ---

  buildSyncManifest(peerId, existingRemoteReceipts = []) {
    if (!this.#identity) return null;

    const prefixMap = new Map();
    const addReceipt = (r) => {
      if (r.parsed.host.id === peerId || r.parsed.guest.id === peerId) {
        prefixMap.set(r.parsed.matchId, r.matchIdPrefix8);
      }
    };
    this.#myReceipts.forEach(addReceipt);
    this.#graphReceipts.forEach(addReceipt);
    existingRemoteReceipts.forEach(addReceipt);

    const rWriter = new ByteWriter();
    for (const p8 of prefixMap.values()) {
      rWriter.writeBytes(p8);
    }

    const vWriter = new ByteWriter();
    for (const v of this.#vouches.values()) {
      vWriter.writeBytes(v.pairHash);
      vWriter.writeU48(v.parsed.timestamp);
    }

    const bloom = new Uint8Array(64);
    const markBloom = (id) => {
      const [b1, b2] = bloomBitIndices(id);
      bloom[b1 >>> 3] |= 1 << (b1 & 7);
      bloom[b2 >>> 3] |= 1 << (b2 & 7);
    };

    markBloom(this.#identity.playerId);
    for (const id of this.#trustedAnchors.keys()) markBloom(id);
    for (const r of this.#myReceipts) {
      markBloom(r.parsed.host.id);
      markBloom(r.parsed.guest.id);
    }

    return {
      r: toBase64Url(rWriter.finish()),
      v: toBase64Url(vWriter.finish()),
      g: toBase64Url(bloom)
    };
  }

  #parseReceiptManifestSet(rB64) {
    const bytes = fromBase64Url(rB64);
    const set = new Set();
    if (!bytes || bytes.length % 8 !== 0) return set;
    for (let i = 0; i < bytes.length; i += 8) {
      set.add(toBase64Url(bytes.subarray(i, i + 8)));
    }
    return set;
  }

  #parseVouchManifestMap(vB64) {
    const bytes = fromBase64Url(vB64);
    const map = new Map();
    if (!bytes || bytes.length % 14 !== 0) return map;
    const reader = new ByteReader(bytes);
    while (reader.remaining >= 14) {
      const hashB64 = toBase64Url(reader.readBytes(8));
      const ts = reader.readU48();
      map.set(hashB64, ts);
    }
    return map;
  }

  #matchesBloom(bloomBytes, id) {
    if (!bloomBytes || bloomBytes.length !== 64) return false;
    const [b1, b2] = bloomBitIndices(id);
    return (
      (bloomBytes[b1 >>> 3] & (1 << (b1 & 7))) !== 0 &&
      (bloomBytes[b2 >>> 3] & (1 << (b2 & 7))) !== 0
    );
  }

  async encodeMissingReceiptBatches(peerId, peerManifest, chunkSize = 30) {
    if (!this.#identity) return [];

    const peerHas = peerManifest?.r ? this.#parseReceiptManifestSet(peerManifest.r) : new Set();
    const peerBloom = peerManifest?.g ? fromBase64Url(peerManifest.g) : null;

    const candidates = [];
    for (const r of this.#myReceipts) {
      const prefixB64 = toBase64Url(r.matchIdPrefix8);
      if (peerHas.has(prefixB64)) continue;

      const otherId = r.parsed.host.id === this.#identity.playerId ? r.parsed.guest.id : r.parsed.host.id;
      const inPeerGraph = this.#matchesBloom(peerBloom, otherId);
      candidates.push({ r, inPeerGraph });
    }

    if (candidates.length === 0) return [];

    candidates.sort((a, b) => {
      if (a.inPeerGraph !== b.inPeerGraph) return a.inPeerGraph ? -1 : 1;
      return b.r.parsed.timestamp - a.r.parsed.timestamp;
    });

    const selected = candidates
      .slice(0, IDENTITY_CONFIG.MAX_SHARED_RECEIPTS)
      .map((c) => c.r);

    const safeChunkSize = Math.max(1, chunkSize | 0);
    const batches = [];
    for (let i = 0; i < selected.length; i += safeChunkSize) {
      const encoded = await encodeSignedBatch({
        myId: this.#identity.playerId,
        peerId,
        items: selected.slice(i, i + safeChunkSize),
        getParticipantIds: (r) => [r.parsed.host.id, r.parsed.guest.id],
        keyRing: this.#keyRing,
        writeItem: (w, { item: r, idxA: hIdx, idxB: gIdx }) => {
          const p = r.parsed;
          w.writeBytes(fromBase64Url(p.matchId)); // 12B
          w.writeU48(p.timestamp);
          w.writeVarUint(hIdx);
          w.writeVarUint(gIdx);
          w.writeVarUint(p.hostScore);
          w.writeVarUint(p.guestScore);
          writeCompactTag(w, p.settings.mode, MODE_TO_CODE);
          writeCompactTag(w, p.settings.difficulty, DIFF_TO_CODE);
          w.writeVarUint(p.settings.targetScore ?? 0);
          w.writeVarUint(p.settings.timeLimitSec ?? 0);
          w.writeShortStr(p.host.nickname);
          w.writeShortStr(p.guest.nickname);
          w.writeBytes(r.hostSigBytes);
          w.writeBytes(r.guestSigBytes);
        }
      });
      if (encoded) batches.push(encoded);
    }
    return batches;
  }

  async decodeAndVerifyReceiptBatch(batchB64, remotePeer, knownMatchIds = new Set()) {
    if (!this.#identity) return [];

    const decodedBatch = await decodeSignedBatch({
      batchB64,
      remotePeer,
      myIdentity: this.#identity,
      maxItems: IDENTITY_CONFIG.MAX_SHARED_RECEIPTS,
      readItem: (reader) => {
        const matchIdBytes = new Uint8Array(reader.readBytes(12));
        return {
          matchIdBytes,
          matchId: toBase64Url(matchIdBytes),
          timestamp: reader.readU48(),
          hIdx: reader.readVarUint(),
          gIdx: reader.readVarUint(),
          hostScore: reader.readVarUint(),
          guestScore: reader.readVarUint(),
          mode: readCompactTag(reader, CODE_TO_MODE),
          difficulty: readCompactTag(reader, CODE_TO_DIFF),
          targetScore: reader.readVarUint(),
          timeLimitSec: reader.readVarUint(),
          hostNick: sanitizeNickname(reader.readShortStr()),
          guestNick: sanitizeNickname(reader.readShortStr()),
          hostSigBytes: new Uint8Array(reader.readBytes(64)),
          guestSigBytes: new Uint8Array(reader.readBytes(64))
        };
      }
    });
    if (!decodedBatch) return [];

    const maxAllowedTimestamp = Date.now() + MAX_FUTURE_SKEW_MS;
    const verified = [];
    const seenIds = new Set(knownMatchIds);
    for (const r of this.#myReceipts) seenIds.add(r.parsed.matchId);
    for (const r of this.#graphReceipts) seenIds.add(r.parsed.matchId);

    let storedNewReceipt = false;
    const { items, keyEntries } = decodedBatch;

    for (const item of items) {
      if (
        item.timestamp > maxAllowedTimestamp ||
        item.hostScore > 0xffff ||
        item.guestScore > 0xffff ||
        item.targetScore > 0xffff ||
        item.timeLimitSec > 0xffff ||
        seenIds.has(item.matchId)
      ) {
        continue;
      }

      const hostKey = keyEntries[item.hIdx];
      const guestKey = keyEntries[item.gIdx];
      if (!hostKey || !guestKey || hostKey.id === guestKey.id) continue;
      if (hostKey.id !== remotePeer.playerId && guestKey.id !== remotePeer.playerId) continue;

      const candidateParsed = {
        version: RECEIPT_VERSION,
        type: 'match-receipt',
        matchId: item.matchId,
        timestamp: item.timestamp,
        host: { id: hostKey.id, nickname: item.hostNick },
        guest: { id: guestKey.id, nickname: item.guestNick },
        hostScore: item.hostScore,
        guestScore: item.guestScore,
        winner: computeWinner(item.hostScore, item.guestScore),
        settings: {
          mode: item.mode,
          difficulty: item.difficulty,
          targetScore: item.targetScore,
          timeLimitSec: item.timeLimitSec
        }
      };

      let bodyBytes;
      let decoded;
      try {
        bodyBytes = encodeReceiptBodyBytes(candidateParsed, hostKey.idBytes, guestKey.idBytes);
        decoded = decodeReceiptBodyBytes(bodyBytes);
      } catch {
        continue;
      }
      if (!decoded) continue;

      const [validHost, validGuest] = await Promise.all([
        verifyBytes(hostKey.keyB64, bodyBytes, item.hostSigBytes),
        verifyBytes(guestKey.keyB64, bodyBytes, item.guestSigBytes)
      ]);
      if (!validHost || !validGuest) continue;

      seenIds.add(item.matchId);
      this.#keyRing.set(hostKey.id, hostKey.keyB64);
      this.#keyRing.set(guestKey.id, guestKey.keyB64);

      const receipt = {
        bodyBytes,
        hostSigBytes: item.hostSigBytes,
        guestSigBytes: item.guestSigBytes,
        matchIdPrefix8: item.matchIdBytes.subarray(0, 8),
        hostIdBytes: hostKey.idBytes,
        guestIdBytes: guestKey.idBytes,
        parsed: decoded.parsed
      };
      verified.push(receipt);

      const otherId = hostKey.id === remotePeer.playerId ? guestKey.id : hostKey.id;
      if (otherId === this.#identity.playerId) {
        this.#storeMyReceipt(receipt);
        storedNewReceipt = true;
      } else if (this.#trustedAnchors.has(otherId)) {
        this.#storeGraphReceipt(receipt);
        storedNewReceipt = true;
      }
    }

    this.#pruneKeyRing();
    if (storedNewReceipt) {
      this.#persist();
    }

    return verified.sort((a, b) => b.parsed.timestamp - a.parsed.timestamp);
  }

  // --- Signed Vouches & Trust Anchors ---

  isTrustedAnchor(playerId) {
    return this.#trustedAnchors.has(playerId);
  }

  async toggleTrustAnchor(peerProfile) {
    if (!this.#identity || !peerProfile?.playerId || peerProfile.playerId === this.#identity.playerId) {
      return null;
    }

    const compKeyB64 = normalizeCompressedKeyB64(peerProfile.compressedKeyB64);
    if (!compKeyB64) return null;

    const derivedId = await derivePlayerId(compKeyB64);
    if (!derivedId || derivedId !== peerProfile.playerId) return null;

    const active = !this.#trustedAnchors.has(peerProfile.playerId);

    const vouch = await this.#createSignedVouch(
      { playerId: peerProfile.playerId, nickname: peerProfile.nickname, compressedKeyB64: compKeyB64 },
      active
    );
    if (!vouch) return null;

    this.#keyRing.set(peerProfile.playerId, compKeyB64);
    if (active) {
      this.#trustedAnchors.set(peerProfile.playerId, {
        playerId: peerProfile.playerId,
        shortId: getShortId(peerProfile.playerId),
        nickname: sanitizeNickname(peerProfile.nickname),
        compressedKeyB64: compKeyB64,
        addedAt: Date.now()
      });
    } else {
      this.#trustedAnchors.delete(peerProfile.playerId);
    }

    this.#storeVouch(vouch);
    this.#pruneKeyRing();
    this.#persist();
    return { active, vouch };
  }

  async revokeTrustAnchor(playerId) {
    const existing = this.#trustedAnchors.get(playerId);
    if (!existing) return null;

    this.#trustedAnchors.delete(playerId);
    const vouch = await this.#createSignedVouch(existing, false);
    if (vouch) {
      this.#storeVouch(vouch);
    }

    this.#pruneKeyRing();
    this.#persist();
    return vouch;
  }

  async encodeMissingVouchBatch(peerId, peerManifest = null, explicitVouches = null) {
    if (!this.#identity) return null;

    const peerVouches = peerManifest?.v ? this.#parseVouchManifestMap(peerManifest.v) : new Map();
    let list;

    if (explicitVouches) {
      list = explicitVouches;
    } else {
      const myId = this.#identity.playerId;
      const all = Array.from(this.#vouches.values()).filter((v) => {
        const peerTs = peerVouches.get(toBase64Url(v.pairHash));
        return peerTs === undefined || v.parsed.timestamp > peerTs;
      });
      const tierFor = (v) => {
        const voucherId = v.parsed.voucher.id;
        if (voucherId === myId) return 2;
        if (this.#trustedAnchors.has(voucherId)) return 1;
        return 0;
      };
      all.sort((a, b) => {
        const tierDiff = tierFor(b) - tierFor(a);
        if (tierDiff !== 0) return tierDiff;
        return b.parsed.timestamp - a.parsed.timestamp;
      });
      const maxShared = IDENTITY_CONFIG.MAX_SHARED_VOUCHES;
      list = maxShared > 0 ? all.slice(0, maxShared) : [];
    }

    return encodeSignedBatch({
      myId: this.#identity.playerId,
      peerId,
      items: list,
      getParticipantIds: (v) => [v.parsed.voucher.id, v.parsed.subject.id],
      keyRing: this.#keyRing,
      writeItem: (w, { item: v, idxA: vIdx, idxB: sIdx }) => {
        w.writeU8(v.parsed.active ? 1 : 0);
        w.writeU48(v.parsed.timestamp);
        w.writeVarUint(vIdx);
        w.writeVarUint(sIdx);
        w.writeShortStr(v.parsed.subject.nickname);
        w.writeBytes(v.sigBytes);
      }
    });
  }

  async decodeAndStoreRemoteVouches(batchB64, remotePeer) {
    if (!this.#identity) return [];

    const decodedBatch = await decodeSignedBatch({
      batchB64,
      remotePeer,
      myIdentity: this.#identity,
      maxItems: IDENTITY_CONFIG.MAX_SHARED_VOUCHES,
      readItem: (reader) => ({
        active: reader.readU8() === 1,
        timestamp: reader.readU48(),
        vIdx: reader.readVarUint(),
        sIdx: reader.readVarUint(),
        subjectNick: sanitizeNickname(reader.readShortStr()),
        sigBytes: new Uint8Array(reader.readBytes(64))
      })
    });
    if (!decodedBatch) return [];

    const maxAllowedTimestamp = Date.now() + MAX_FUTURE_SKEW_MS;
    const accepted = [];
    const { items, keyEntries } = decodedBatch;

    for (const item of items) {
      if (item.timestamp > maxAllowedTimestamp) continue;

      const voucherKey = keyEntries[item.vIdx];
      const subjectKey = keyEntries[item.sIdx];
      if (!voucherKey || !subjectKey || voucherKey.id === subjectKey.id) continue;
      if (voucherKey.id === this.#identity.playerId) continue;

      const key = `${voucherKey.id}:${subjectKey.id}`;
      const existing = this.#vouches.get(key);
      if (existing && item.timestamp <= existing.parsed.timestamp) continue;

      const candidateParsed = {
        version: VOUCH_VERSION,
        type: 'vouch',
        active: item.active,
        timestamp: item.timestamp,
        voucher: { id: voucherKey.id },
        subject: { id: subjectKey.id, nickname: item.subjectNick }
      };

      const bodyBytes = encodeVouchBodyBytes(candidateParsed, voucherKey.idBytes, subjectKey.idBytes);
      const decoded = decodeVouchBodyBytes(bodyBytes);
      if (!decoded) continue;

      const valid = await verifyBytes(voucherKey.keyB64, bodyBytes, item.sigBytes);
      if (!valid) continue;

      this.#keyRing.set(voucherKey.id, voucherKey.keyB64);
      this.#keyRing.set(subjectKey.id, subjectKey.keyB64);

      const vouch = {
        bodyBytes,
        sigBytes: item.sigBytes,
        voucherIdBytes: voucherKey.idBytes,
        subjectIdBytes: subjectKey.idBytes,
        pairHash: pairHash8(voucherKey.idBytes, subjectKey.idBytes),
        parsed: decoded.parsed
      };
      this.#storeVouch(vouch);
      accepted.push(vouch);
    }

    if (accepted.length > 0) {
      this.#pruneVouches();
      this.#pruneKeyRing();
      this.#persist();
    }
    return accepted;
  }

  // --- Web of Trust Evaluation ---

  getMergedReceiptsForPeer(peerId, remoteReceipts = []) {
    const seen = new Set();
    const merged = [];

    const addIfForPeer = (r) => {
      if (seen.has(r.parsed.matchId)) return;
      if (r.parsed.host.id !== peerId && r.parsed.guest.id !== peerId) return;
      seen.add(r.parsed.matchId);
      merged.push(r);
    };

    this.#myReceipts.forEach(addIfForPeer);
    this.#graphReceipts.forEach(addIfForPeer);
    remoteReceipts.forEach(addIfForPeer);

    return merged.sort((a, b) => b.parsed.timestamp - a.parsed.timestamp);
  }

  buildTrustContext(extraReceipts = []) {
    const myId = this.#identity?.playerId || '';
    const playedIds = new Set();
    const playedNames = new Map();

    for (const r of this.#myReceipts) {
      const { host, guest } = r.parsed;
      if (host.id === myId) {
        playedIds.add(guest.id);
        playedNames.set(guest.id, formatPlayerTag(guest.nickname, guest.id));
      } else if (guest.id === myId) {
        playedIds.add(host.id);
        playedNames.set(host.id, formatPlayerTag(host.nickname, host.id));
      }
    }

    const vouchedMap = new Map();
    const queue = [];

    for (const [anchorId, anchor] of this.#trustedAnchors.entries()) {
      queue.push({ id: anchorId, hop: 0, name: formatPlayerTag(anchor.nickname, anchorId) });
    }
    if (myId) {
      queue.push({ id: myId, hop: 0, name: this.myDisplayTag });
    }

    const activeVouchesList = Array.from(this.#vouches.values()).filter((v) => v.parsed.active);

    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      if (current.hop >= IDENTITY_CONFIG.MAX_TRUST_HOPS) continue;

      for (const v of activeVouchesList) {
        const { voucher, subject } = v.parsed;
        if (voucher.id !== current.id) continue;
        if (subject.id === myId || this.#trustedAnchors.has(subject.id)) continue;

        const nextHop = current.hop + 1;
        const prev = vouchedMap.get(subject.id);
        if (!prev || nextHop < prev.hop) {
          const subjectTag = formatPlayerTag(subject.nickname, subject.id);
          vouchedMap.set(subject.id, {
            hop: nextHop,
            viaId: voucher.id,
            viaName: current.name,
            displayTag: subjectTag
          });
          queue.push({ id: subject.id, hop: nextHop, name: subjectTag });
        }
      }
    }

    const allKnownReceipts = [...this.#myReceipts, ...this.#graphReceipts, ...extraReceipts];
    return { myId, playedIds, playedNames, vouchedMap, allKnownReceipts };
  }

  evaluatePeerTrust(targetId, remoteReceipts = []) {
    const ctx = this.buildTrustContext(remoteReceipts);

    if (targetId === ctx.myId) {
      return { level: 'self', trusted: true, label: 'You' };
    }
    if (this.#trustedAnchors.has(targetId)) {
      return { level: 'anchor', trusted: true, label: 'Trusted Friend' };
    }

    const vouched = ctx.vouchedMap.get(targetId);
    if (vouched) {
      return {
        level: 'vouched',
        trusted: true,
        label: vouched.hop === 1 ? `Friend of ${vouched.viaName}` : `${vouched.hop}-Hop via ${vouched.viaName}`
      };
    }

    if (ctx.playedIds.has(targetId)) {
      return { level: 'played', trusted: true, label: 'Played Before' };
    }

    let mutualOpponentLabel = null;
    for (const r of ctx.allKnownReceipts) {
      const { host, guest } = r.parsed;
      let coSigner = null;
      if (host.id === targetId) coSigner = guest;
      else if (guest.id === targetId) coSigner = host;
      if (!coSigner) continue;

      if (coSigner.id === ctx.myId) {
        return { level: 'played', trusted: true, label: 'Played Before' };
      }
      if (this.#trustedAnchors.has(coSigner.id) || ctx.vouchedMap.has(coSigner.id)) {
        return {
          level: 'known-graph',
          trusted: true,
          label: `Played ${formatPlayerTag(coSigner.nickname, coSigner.id)}`
        };
      }
      if (!mutualOpponentLabel && ctx.playedIds.has(coSigner.id)) {
        mutualOpponentLabel = `Mutual Opponent (${formatPlayerTag(coSigner.nickname, coSigner.id)})`;
      }
    }

    if (mutualOpponentLabel) {
      return { level: 'known-graph', trusted: true, label: mutualOpponentLabel };
    }

    return { level: 'unknown', trusted: false, label: 'New / Unvouched' };
  }

  classifyReceipt(receipt, subjectPlayerId, ctx) {
    const { host, guest } = receipt.parsed;
    const other = host.id === subjectPlayerId ? guest : host;
    const otherTag = formatPlayerTag(other.nickname, other.id);

    if (other.id === ctx.myId) {
      return { level: 'self', trusted: true, otherTag, badge: 'vs You' };
    }
    if (this.#trustedAnchors.has(other.id)) {
      return { level: 'anchor', trusted: true, otherTag, badge: 'vs Trusted Friend' };
    }
    if (ctx.vouchedMap.has(other.id)) {
      const v = ctx.vouchedMap.get(other.id);
      return { level: 'vouched', trusted: true, otherTag, badge: `vs Friend of ${v.viaName}` };
    }
    if (ctx.playedIds.has(other.id)) {
      return { level: 'played', trusted: true, otherTag, badge: 'vs Mutual Opponent' };
    }

    return { level: 'untrusted', trusted: false, otherTag, badge: 'vs Stranger' };
  }

  summarizePeerHistory(mergedReceipts, peerId) {
    const ctx = this.buildTrustContext(mergedReceipts);
    const trusted = { wins: 0, losses: 0, draws: 0, total: 0 };
    const all = { wins: 0, losses: 0, draws: 0, total: 0 };

    const items = mergedReceipts.map((receipt) => {
      const p = receipt.parsed;
      const isHost = p.host.id === peerId;
      const peerWon = (isHost && p.winner === 'host') || (!isHost && p.winner === 'guest');
      const isDraw = p.winner === 'draw';
      const classification = this.classifyReceipt(receipt, peerId, ctx);

      all.total++;
      if (isDraw) all.draws++;
      else if (peerWon) all.wins++;
      else all.losses++;

      if (classification.trusted) {
        trusted.total++;
        if (isDraw) trusted.draws++;
        else if (peerWon) trusted.wins++;
        else trusted.losses++;
      }

      return {
        receipt,
        isHost,
        peerWon,
        isDraw,
        myScore: isHost ? p.hostScore : p.guestScore,
        oppScore: isHost ? p.guestScore : p.hostScore,
        classification
      };
    });

    return {
      trusted,
      all,
      untrustedCount: all.total - trusted.total,
      items
    };
  }

  getVouchedFriendsList() {
    const ctx = this.buildTrustContext();
    return Array.from(ctx.vouchedMap.entries()).map(([playerId, info]) => ({
      playerId,
      displayTag: info.displayTag,
      hop: info.hop,
      viaName: info.viaName
    }));
  }

  // --- Compact Persistence & Backup ---

  #collectUsedKeyIds() {
    const usedIds = new Set();
    if (this.#identity) {
      usedIds.add(this.#identity.playerId);
    }
    for (const r of this.#myReceipts) {
      usedIds.add(r.parsed.host.id);
      usedIds.add(r.parsed.guest.id);
    }
    for (const r of this.#graphReceipts) {
      usedIds.add(r.parsed.host.id);
      usedIds.add(r.parsed.guest.id);
    }
    for (const id of this.#trustedAnchors.keys()) {
      usedIds.add(id);
    }
    for (const v of this.#vouches.values()) {
      usedIds.add(v.parsed.voucher.id);
      usedIds.add(v.parsed.subject.id);
    }
    return usedIds;
  }

  #pruneKeyRing(maxTransientKeys = MAX_TRANSIENT_KEYS) {
    if (this.#keyRing.size <= maxTransientKeys) return;
    const usedIds = this.#collectUsedKeyIds();
    const transient = [];
    for (const id of this.#keyRing.keys()) {
      if (!usedIds.has(id)) {
        transient.push(id);
      }
    }
    const excess = transient.length - maxTransientKeys;
    for (let i = 0; i < excess; i++) {
      this.#keyRing.delete(transient[i]);
    }
  }

  #serializeState() {
    if (!this.#identity) return null;

    const usedIds = this.#collectUsedKeyIds();
    const keys = {};
    for (const id of usedIds) {
      const k = this.#keyRing.get(id);
      if (k) keys[id] = k;
    }

    return {
      v: 2,
      id: {
        k: this.#identity.compressedKeyB64,
        d: this.#identity.privateD,
        n: this.#identity.nickname
      },
      keys,
      r: this.#myReceipts.map(packReceipt),
      g: this.#graphReceipts.map(packReceipt),
      a: Array.from(this.#trustedAnchors.values()).map((a) => [a.playerId, a.nickname, a.addedAt]),
      vo: Array.from(this.#vouches.values()).map(packVouch)
    };
  }

  exportBackupJson() {
    const obj = this.#serializeState();
    return obj ? JSON.stringify(obj) : '';
  }

  async importBackupJson(rawText) {
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { ok: false, error: 'Invalid JSON backup.' };
    }

    const ok = await this.#loadFromObject(parsed, { verifySignatures: true });
    if (!ok) {
      return { ok: false, error: 'Invalid or corrupted identity keypair in backup.' };
    }

    this.#persist();
    return { ok: true, displayTag: this.myDisplayTag };
  }

  // --- Internal Helpers ---

  async #loadFromObject(data, { verifySignatures }) {
    if (!data || data.v !== 2 || !data.id) return false;

    const compKeyB64 = normalizeCompressedKeyB64(data.id.k);
    if (!compKeyB64 || typeof data.id.d !== 'string') return false;

    let nextIdentity;
    try {
      const compressedKey = fromBase64Url(compKeyB64);
      const publicKey = await importPublicKey(compressedKey);
      const privateKey = await importPrivateKey(compressedKey, data.id.d);

      const probe = new Uint8Array([1, 2, 3, 4]);
      const sig = await signBytes(privateKey, probe);
      const valid = await verifyBytes(compKeyB64, probe, sig);
      if (!valid) return false;

      const playerIdBytes = await derivePlayerIdBytes(compressedKey);
      const playerId = toBase64Url(playerIdBytes);
      nextIdentity = {
        playerId,
        playerIdBytes,
        shortId: getShortId(playerId),
        nickname: sanitizeNickname(data.id.n),
        compressedKey,
        compressedKeyB64: compKeyB64,
        privateD: data.id.d,
        publicKey,
        privateKey
      };
    } catch {
      return false;
    }

    const nextMyReceipts = [];
    const nextGraphReceipts = [];
    const nextTrustedAnchors = new Map();
    const nextVouches = new Map();
    const nextKeyRing = new Map();
    nextKeyRing.set(nextIdentity.playerId, nextIdentity.compressedKeyB64);

    if (data.keys && typeof data.keys === 'object') {
      for (const [id, kB64] of Object.entries(data.keys)) {
        if (id === nextIdentity.playerId) continue;
        const cleanKey = normalizeCompressedKeyB64(kB64);
        if (!cleanKey) continue;
        if (verifySignatures) {
          const derived = await derivePlayerId(cleanKey);
          if (derived !== id) continue;
        }
        nextKeyRing.set(id, cleanKey);
      }
    }

    if (Array.isArray(data.a)) {
      for (const entry of data.a) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [id, nick, addedAt] = entry;
        if (typeof id !== 'string') continue;
        const compKey = nextKeyRing.get(id);
        if (!compKey || id === nextIdentity.playerId) continue;
        nextTrustedAnchors.set(id, {
          playerId: id,
          shortId: getShortId(id),
          nickname: sanitizeNickname(nick),
          compressedKeyB64: compKey,
          addedAt: Number.isFinite(addedAt) && addedAt >= 0 ? addedAt : Date.now()
        });
      }
    }

    const decodeStoredReceipt = async (b64) => {
      const receipt = unpackReceipt(b64);
      if (!receipt) return null;
      if (verifySignatures) {
        const hKey = nextKeyRing.get(receipt.parsed.host.id);
        const gKey = nextKeyRing.get(receipt.parsed.guest.id);
        if (!hKey || !gKey) return null;
        const [vh, vg] = await Promise.all([
          verifyBytes(hKey, receipt.bodyBytes, receipt.hostSigBytes),
          verifyBytes(gKey, receipt.bodyBytes, receipt.guestSigBytes)
        ]);
        if (!vh || !vg) return null;
      }
      return receipt;
    };

    const insertReceipt = (list, receipt) => {
      if (list.some((r) => r.parsed.matchId === receipt.parsed.matchId)) return;
      list.unshift(receipt);
      list.sort((a, b) => b.parsed.timestamp - a.parsed.timestamp);
      if (list.length > IDENTITY_CONFIG.MAX_STORED_RECEIPTS) {
        list.length = IDENTITY_CONFIG.MAX_STORED_RECEIPTS;
      }
    };

    if (Array.isArray(data.r)) {
      for (const b64 of data.r.slice(0, IDENTITY_CONFIG.MAX_STORED_RECEIPTS)) {
        const receipt = await decodeStoredReceipt(b64);
        if (
          receipt &&
          (receipt.parsed.host.id === nextIdentity.playerId ||
            receipt.parsed.guest.id === nextIdentity.playerId)
        ) {
          insertReceipt(nextMyReceipts, receipt);
        }
      }
    }

    if (Array.isArray(data.g)) {
      for (const b64 of data.g.slice(0, IDENTITY_CONFIG.MAX_STORED_RECEIPTS)) {
        const receipt = await decodeStoredReceipt(b64);
        if (receipt) insertReceipt(nextGraphReceipts, receipt);
      }
    }

    const maxImportVouches = Math.max(IDENTITY_CONFIG.MAX_SHARED_VOUCHES * 4, 200);
    if (Array.isArray(data.vo)) {
      for (const b64 of data.vo.slice(0, maxImportVouches)) {
        const vouch = unpackVouch(b64);
        if (!vouch) continue;

        if (verifySignatures) {
          const vKey = nextKeyRing.get(vouch.parsed.voucher.id);
          if (!vKey) continue;
          const valid = await verifyBytes(vKey, vouch.bodyBytes, vouch.sigBytes);
          if (!valid) continue;
        }

        const vKey = `${vouch.parsed.voucher.id}:${vouch.parsed.subject.id}`;
        const existing = nextVouches.get(vKey);
        if (!existing || vouch.parsed.timestamp > existing.parsed.timestamp) {
          nextVouches.delete(vKey);
          nextVouches.set(vKey, vouch);
        }
      }
    }

    this.#identity = nextIdentity;
    this.#myReceipts = nextMyReceipts;
    this.#graphReceipts = nextGraphReceipts;
    this.#trustedAnchors = nextTrustedAnchors;
    this.#vouches = nextVouches;
    this.#keyRing = nextKeyRing;
    this.#lastLocalNickTs = 0;
    this.#lastNickUpdateTs.clear();
    this.#pruneVouches();
    this.#pruneKeyRing();

    return true;
  }

  #persist() {
    if (!this.#identity) return;
    try {
      localStorage.setItem(IDENTITY_CONFIG.STORAGE_KEY, this.exportBackupJson());
    } catch {
      this.#graphReceipts.length = Math.min(this.#graphReceipts.length, 20);
      this.#pruneVouches(40);
      this.#pruneKeyRing();
      try {
        localStorage.setItem(IDENTITY_CONFIG.STORAGE_KEY, this.exportBackupJson());
      } catch {
        // Ignore
      }
    }
  }

  #storeMyReceipt(receipt) {
    if (this.#myReceipts.some((r) => r.parsed.matchId === receipt.parsed.matchId)) return;
    this.#myReceipts.unshift(receipt);
    this.#myReceipts.sort((a, b) => b.parsed.timestamp - a.parsed.timestamp);
    if (this.#myReceipts.length > IDENTITY_CONFIG.MAX_STORED_RECEIPTS) {
      this.#myReceipts.length = IDENTITY_CONFIG.MAX_STORED_RECEIPTS;
    }
  }

  #storeGraphReceipt(receipt) {
    if (this.#graphReceipts.some((r) => r.parsed.matchId === receipt.parsed.matchId)) return;
    this.#graphReceipts.unshift(receipt);
    this.#graphReceipts.sort((a, b) => b.parsed.timestamp - a.parsed.timestamp);
    if (this.#graphReceipts.length > IDENTITY_CONFIG.MAX_STORED_RECEIPTS) {
      this.#graphReceipts.length = IDENTITY_CONFIG.MAX_STORED_RECEIPTS;
    }
  }

  async #createSignedVouch(subjectProfile, active) {
    const subjectIdBytes = fromBase64Url(subjectProfile.playerId);
    if (!subjectIdBytes || subjectIdBytes.length !== 32) return null;

    const key = `${this.#identity.playerId}:${subjectProfile.playerId}`;
    const prevTimestamp = this.#vouches.get(key)?.parsed.timestamp || 0;
    const timestamp = Math.max(Date.now(), prevTimestamp + 1);

    const parsed = {
      version: VOUCH_VERSION,
      type: 'vouch',
      active: Boolean(active),
      timestamp,
      voucher: { id: this.#identity.playerId },
      subject: { id: subjectProfile.playerId, nickname: sanitizeNickname(subjectProfile.nickname) }
    };

    const bodyBytes = encodeVouchBodyBytes(parsed, this.#identity.playerIdBytes, subjectIdBytes);
    const sigBytes = await signBytes(this.#identity.privateKey, bodyBytes);

    return {
      bodyBytes,
      sigBytes,
      voucherIdBytes: this.#identity.playerIdBytes,
      subjectIdBytes,
      pairHash: pairHash8(this.#identity.playerIdBytes, subjectIdBytes),
      parsed
    };
  }

  #storeVouch(vouch) {
    const key = `${vouch.parsed.voucher.id}:${vouch.parsed.subject.id}`;
    const existing = this.#vouches.get(key);
    if (!existing || vouch.parsed.timestamp > existing.parsed.timestamp) {
      this.#vouches.delete(key);
      this.#vouches.set(key, vouch);
    }
  }

  #pruneVouches(maxCap = Math.max(IDENTITY_CONFIG.MAX_SHARED_VOUCHES * 2, 100)) {
    if (this.#vouches.size <= maxCap) return;
    const myId = this.#identity?.playerId;

    const oneHopFriends = new Set();
    for (const v of this.#vouches.values()) {
      if (v.parsed.active && this.#trustedAnchors.has(v.parsed.voucher.id)) {
        oneHopFriends.add(v.parsed.subject.id);
      }
    }

    const tierFor = (v) => {
      const voucherId = v.parsed.voucher.id;
      if (voucherId === myId) return 3;
      if (this.#trustedAnchors.has(voucherId)) return 2;
      if (oneHopFriends.has(voucherId)) return 1;
      return 0;
    };

    const entries = Array.from(this.#vouches.entries()).sort(([, a], [, b]) => {
      const tierDiff = tierFor(b) - tierFor(a);
      if (tierDiff !== 0) return tierDiff;
      return b.parsed.timestamp - a.parsed.timestamp;
    });

    this.#vouches.clear();
    for (const [k, v] of entries.slice(0, maxCap)) {
      this.#vouches.set(k, v);
    }
  }
}