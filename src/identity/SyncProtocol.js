import { IDENTITY_CONFIG } from '../config/constants.js';
import { ByteReader, ByteWriter, fromBase64Url, toBase64Url } from './BinaryCodec.js';
import { verifyBytes } from './IdentityCrypto.js';
import {
  CODE_TO_DIFF,
  CODE_TO_MODE,
  DIFF_TO_CODE,
  MODE_TO_CODE,
  RECEIPT_VERSION,
  VOUCH_VERSION,
  computeWinner,
  decodeReceiptBodyBytes,
  decodeSignedBatch,
  decodeVouchBodyBytes,
  encodeReceiptBodyBytes,
  encodeSignedBatch,
  encodeVouchBodyBytes,
  pairHash8,
  readCompactTag,
  sanitizeNickname,
  writeCompactTag
} from './RecordCodec.js';

const MAX_FUTURE_SKEW_MS = 15 * 60 * 1000;

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

function parseReceiptManifestSet(rB64) {
  const bytes = fromBase64Url(rB64);
  const set = new Set();
  if (!bytes || bytes.length % 8 !== 0) return set;
  for (let i = 0; i < bytes.length; i += 8) {
    set.add(toBase64Url(bytes.subarray(i, i + 8)));
  }
  return set;
}

function parseVouchManifestMap(vB64) {
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

function matchesBloom(bloomBytes, id) {
  if (!bloomBytes || bloomBytes.length !== 64) return false;
  const [b1, b2] = bloomBitIndices(id);
  return (
    (bloomBytes[b1 >>> 3] & (1 << (b1 & 7))) !== 0 &&
    (bloomBytes[b2 >>> 3] & (1 << (b2 & 7))) !== 0
  );
}

export function buildSyncManifest(store, peerId, existingRemoteReceipts = []) {
  if (!store.ready) return null;

  const prefixMap = new Map();
  const addReceipt = (r) => {
    if (r.parsed.host.id === peerId || r.parsed.guest.id === peerId) {
      prefixMap.set(r.parsed.matchId, r.matchIdPrefix8);
    }
  };
  store.myReceipts.forEach(addReceipt);
  store.graphReceipts.forEach(addReceipt);
  existingRemoteReceipts.forEach(addReceipt);

  const rWriter = new ByteWriter();
  for (const p8 of prefixMap.values()) {
    rWriter.writeBytes(p8);
  }

  const vWriter = new ByteWriter();
  for (const v of store.vouches.values()) {
    vWriter.writeBytes(v.pairHash);
    vWriter.writeU48(v.parsed.timestamp);
  }

  const bloom = new Uint8Array(64);
  const markBloom = (id) => {
    const [b1, b2] = bloomBitIndices(id);
    bloom[b1 >>> 3] |= 1 << (b1 & 7);
    bloom[b2 >>> 3] |= 1 << (b2 & 7);
  };

  markBloom(store.myPlayerId);
  for (const id of store.trustedAnchors.keys()) markBloom(id);
  for (const r of store.myReceipts) {
    markBloom(r.parsed.host.id);
    markBloom(r.parsed.guest.id);
  }

  return {
    r: toBase64Url(rWriter.finish()),
    v: toBase64Url(vWriter.finish()),
    g: toBase64Url(bloom)
  };
}

export async function encodeMissingReceiptBatches(store, peerId, peerManifest, chunkSize = 30) {
  if (!store.ready) return [];

  const peerHas = peerManifest?.r ? parseReceiptManifestSet(peerManifest.r) : new Set();
  const peerBloom = peerManifest?.g ? fromBase64Url(peerManifest.g) : null;

  const candidates = [];
  for (const r of store.myReceipts) {
    const prefixB64 = toBase64Url(r.matchIdPrefix8);
    if (peerHas.has(prefixB64)) continue;

    const otherId = r.parsed.host.id === store.myPlayerId ? r.parsed.guest.id : r.parsed.host.id;
    const inPeerGraph = matchesBloom(peerBloom, otherId);
    candidates.push({ r, inPeerGraph });
  }

  if (candidates.length === 0) return [];

  candidates.sort((a, b) => {
    if (a.inPeerGraph !== b.inPeerGraph) return a.inPeerGraph ? -1 : 1;
    return b.r.parsed.timestamp - a.r.parsed.timestamp;
  });

  const selected = candidates.slice(0, IDENTITY_CONFIG.MAX_SHARED_RECEIPTS).map((c) => c.r);
  const safeChunkSize = Math.max(1, chunkSize | 0);
  const batches = [];

  for (let i = 0; i < selected.length; i += safeChunkSize) {
    const encoded = await encodeSignedBatch({
      myId: store.myPlayerId,
      peerId,
      items: selected.slice(i, i + safeChunkSize),
      getParticipantIds: (r) => [r.parsed.host.id, r.parsed.guest.id],
      keyRing: store.keyRing,
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

export async function decodeAndVerifyReceiptBatch(
  store,
  batchB64,
  remotePeer,
  knownMatchIds = new Set()
) {
  if (!store.ready) return [];

  const decodedBatch = await decodeSignedBatch({
    batchB64,
    remotePeer,
    myIdentity: store.identity,
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
  for (const r of store.myReceipts) seenIds.add(r.parsed.matchId);
  for (const r of store.graphReceipts) seenIds.add(r.parsed.matchId);

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
    store.setKey(hostKey.id, hostKey.keyB64);
    store.setKey(guestKey.id, guestKey.keyB64);

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
    if (otherId === store.myPlayerId) {
      if (store.storeMyReceipt(receipt)) storedNewReceipt = true;
    } else if (store.isTrustedAnchor(otherId)) {
      if (store.storeGraphReceipt(receipt)) storedNewReceipt = true;
    }
  }

  store.pruneKeyRing();
  if (storedNewReceipt) {
    store.persist();
  }

  return verified.sort((a, b) => b.parsed.timestamp - a.parsed.timestamp);
}

export async function encodeMissingVouchBatch(
  store,
  peerId,
  peerManifest = null,
  explicitVouches = null
) {
  if (!store.ready) return null;

  const peerVouches = peerManifest?.v ? parseVouchManifestMap(peerManifest.v) : new Map();
  let list;

  if (explicitVouches) {
    list = explicitVouches;
  } else {
    const myId = store.myPlayerId;
    const all = Array.from(store.vouches.values()).filter((v) => {
      const peerTs = peerVouches.get(toBase64Url(v.pairHash));
      return peerTs === undefined || v.parsed.timestamp > peerTs;
    });
    const tierFor = (v) => {
      const voucherId = v.parsed.voucher.id;
      if (voucherId === myId) return 2;
      if (store.isTrustedAnchor(voucherId)) return 1;
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
    myId: store.myPlayerId,
    peerId,
    items: list,
    getParticipantIds: (v) => [v.parsed.voucher.id, v.parsed.subject.id],
    keyRing: store.keyRing,
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

export async function decodeAndStoreRemoteVouches(store, batchB64, remotePeer) {
  if (!store.ready) return [];

  const decodedBatch = await decodeSignedBatch({
    batchB64,
    remotePeer,
    myIdentity: store.identity,
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
    if (voucherKey.id === store.myPlayerId) continue;

    const existing = store.getVouch(voucherKey.id, subjectKey.id);
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

    store.setKey(voucherKey.id, voucherKey.keyB64);
    store.setKey(subjectKey.id, subjectKey.keyB64);

    const vouch = {
      bodyBytes,
      sigBytes: item.sigBytes,
      voucherIdBytes: voucherKey.idBytes,
      subjectIdBytes: subjectKey.idBytes,
      pairHash: pairHash8(voucherKey.idBytes, subjectKey.idBytes),
      parsed: decoded.parsed
    };
    store.storeVouch(vouch);
    accepted.push(vouch);
  }

  if (accepted.length > 0) {
    store.pruneVouches();
    store.pruneKeyRing();
    store.persist();
  }
  return accepted;
}
