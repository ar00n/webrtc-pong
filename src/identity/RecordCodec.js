import { IDENTITY_CONFIG } from '../config/constants.js';
import {
  ByteReader,
  ByteWriter,
  bytesEqual,
  compressPayload,
  decompressPayload,
  fromBase64Url,
  toBase64Url,
  truncateUtf8
} from './BinaryCodec.js';
import { derivePlayerIdBytes } from './IdentityCrypto.js';

export const RECEIPT_VERSION = 2;
export const VOUCH_VERSION = 2;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export const MODE_TO_CODE = { firstTo: 0, timed: 1, endless: 2 };
export const CODE_TO_MODE = ['firstTo', 'timed', 'endless'];

export const DIFF_TO_CODE = { easy: 0, normal: 1, medium: 2, hard: 3, insane: 4, classic: 5 };
export const CODE_TO_DIFF = ['easy', 'normal', 'medium', 'hard', 'insane', 'classic'];

export function clampU16(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(0xffff, Math.floor(value));
}

export function computeWinner(hostScore, guestScore) {
  if (hostScore > guestScore) return 'host';
  if (guestScore > hostScore) return 'guest';
  return 'draw';
}

export function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return IDENTITY_CONFIG.DEFAULT_NICKNAME;
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, IDENTITY_CONFIG.MAX_NICKNAME_LENGTH);
  if (!cleaned) return IDENTITY_CONFIG.DEFAULT_NICKNAME;
  const utf8 = TEXT_ENCODER.encode(cleaned);
  if (utf8.length <= 255) return cleaned;
  return TEXT_DECODER.decode(truncateUtf8(utf8, 255)).trim() || IDENTITY_CONFIG.DEFAULT_NICKNAME;
}

export function normalizeCompactTag(value, fallback = '') {
  const str = typeof value === 'string' && value ? value : fallback;
  const utf8 = TEXT_ENCODER.encode(str);
  return utf8.length <= 63 ? str : TEXT_DECODER.decode(truncateUtf8(utf8, 63));
}

export function writeCompactTag(writer, value, tableToCode) {
  const str = normalizeCompactTag(value, '');
  if (Object.hasOwn(tableToCode, str)) {
    writer.writeU8(tableToCode[str]);
  } else {
    const utf8 = truncateUtf8(TEXT_ENCODER.encode(str), 63);
    writer.writeU8(0x80 | utf8.length);
    writer.writeBytes(utf8);
  }
}

export function readCompactTag(reader, codeToTable) {
  const b = reader.readU8();
  if ((b & 0x80) === 0) {
    if (b >= codeToTable.length) {
      throw new Error('Invalid compact tag code');
    }
    return codeToTable[b];
  }
  if ((b & 0x40) !== 0) {
    throw new Error('Invalid compact tag header');
  }
  return TEXT_DECODER.decode(reader.readBytes(b & 0x3f));
}

export function pairHash8(voucherIdBytes, subjectIdBytes) {
  // Asymmetric 64-bit FNV-1a-style hash over (voucherId, subjectId) for manifest diffing
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < 32; i++) {
    h1 = Math.imul(h1 ^ voucherIdBytes[i], 0x01000193);
    h2 = Math.imul(h2 ^ subjectIdBytes[i], 0x85ebca6b);
  }
  for (let i = 0; i < 32; i++) {
    h1 = Math.imul(h1 ^ subjectIdBytes[i], 0x01000193);
    h2 = Math.imul(h2 ^ voucherIdBytes[i], 0x85ebca6b);
  }
  const out = new Uint8Array(8);
  out[0] = (h1 >>> 24) & 0xff;
  out[1] = (h1 >>> 16) & 0xff;
  out[2] = (h1 >>> 8) & 0xff;
  out[3] = h1 & 0xff;
  out[4] = (h2 >>> 24) & 0xff;
  out[5] = (h2 >>> 16) & 0xff;
  out[6] = (h2 >>> 8) & 0xff;
  out[7] = h2 & 0xff;
  return out;
}

// --- Receipt Encoding / Decoding ---

export function encodeReceiptBodyBytes(parsed, hostIdBytes, guestIdBytes) {
  const matchIdBytes = fromBase64Url(parsed.matchId);
  if (!matchIdBytes || matchIdBytes.length !== 12) {
    throw new Error('Invalid matchId');
  }
  const w = new ByteWriter();
  w.writeU8(RECEIPT_VERSION);
  w.writeBytes(matchIdBytes);
  w.writeU48(parsed.timestamp);
  w.writeBytes(hostIdBytes);
  w.writeBytes(guestIdBytes);
  w.writeU16(clampU16(parsed.hostScore));
  w.writeU16(clampU16(parsed.guestScore));
  writeCompactTag(w, parsed.settings?.mode ?? 'firstTo', MODE_TO_CODE);
  writeCompactTag(w, parsed.settings?.difficulty ?? 'normal', DIFF_TO_CODE);
  w.writeU16(clampU16(parsed.settings?.targetScore));
  w.writeU16(clampU16(parsed.settings?.timeLimitSec));
  w.writeShortStr(sanitizeNickname(parsed.host.nickname));
  w.writeShortStr(sanitizeNickname(parsed.guest.nickname));
  return w.finish();
}

export function decodeReceiptBodyBytes(bodyBytes) {
  const r = new ByteReader(bodyBytes);
  const version = r.readU8();
  if (version !== RECEIPT_VERSION) return null;

  const matchIdBytes = new Uint8Array(r.readBytes(12));
  const timestamp = r.readU48();
  const hostIdBytes = new Uint8Array(r.readBytes(32));
  const guestIdBytes = new Uint8Array(r.readBytes(32));
  if (bytesEqual(hostIdBytes, guestIdBytes)) return null;

  const hostScore = r.readU16();
  const guestScore = r.readU16();
  const mode = readCompactTag(r, CODE_TO_MODE);
  const difficulty = readCompactTag(r, CODE_TO_DIFF);
  const targetScore = r.readU16();
  const timeLimitSec = r.readU16();
  const hostNick = sanitizeNickname(r.readShortStr());
  const guestNick = sanitizeNickname(r.readShortStr());

  if (r.remaining !== 0) return null;

  return {
    matchIdBytes,
    hostIdBytes,
    guestIdBytes,
    parsed: {
      version: RECEIPT_VERSION,
      type: 'match-receipt',
      matchId: toBase64Url(matchIdBytes),
      timestamp,
      host: { id: toBase64Url(hostIdBytes), nickname: hostNick },
      guest: { id: toBase64Url(guestIdBytes), nickname: guestNick },
      hostScore,
      guestScore,
      winner: computeWinner(hostScore, guestScore),
      settings: { mode, difficulty, targetScore, timeLimitSec }
    }
  };
}

export function packReceipt(r) {
  const buf = new Uint8Array(r.bodyBytes.length + 128);
  buf.set(r.bodyBytes, 0);
  buf.set(r.hostSigBytes, r.bodyBytes.length);
  buf.set(r.guestSigBytes, r.bodyBytes.length + 64);
  return toBase64Url(buf);
}

export function unpackReceipt(b64) {
  const buf = fromBase64Url(b64);
  if (!buf || buf.length < 223) return null;
  const bodyBytes = buf.subarray(0, buf.length - 128);
  const hostSigBytes = buf.subarray(buf.length - 128, buf.length - 64);
  const guestSigBytes = buf.subarray(buf.length - 64);

  let decoded;
  try {
    decoded = decodeReceiptBodyBytes(bodyBytes);
  } catch {
    return null;
  }
  if (!decoded) return null;

  return {
    bodyBytes,
    hostSigBytes,
    guestSigBytes,
    matchIdPrefix8: decoded.matchIdBytes.subarray(0, 8),
    hostIdBytes: decoded.hostIdBytes,
    guestIdBytes: decoded.guestIdBytes,
    parsed: decoded.parsed
  };
}

// --- Vouch Encoding / Decoding ---

export function encodeVouchBodyBytes(parsed, voucherIdBytes, subjectIdBytes) {
  const w = new ByteWriter();
  w.writeU8(VOUCH_VERSION);
  w.writeU8(parsed.active ? 1 : 0);
  w.writeU48(parsed.timestamp);
  w.writeBytes(voucherIdBytes);
  w.writeBytes(subjectIdBytes);
  w.writeShortStr(sanitizeNickname(parsed.subject.nickname));
  return w.finish();
}

export function decodeVouchBodyBytes(bodyBytes) {
  const r = new ByteReader(bodyBytes);
  const version = r.readU8();
  if (version !== VOUCH_VERSION) return null;

  const active = r.readU8() === 1;
  const timestamp = r.readU48();
  const voucherIdBytes = new Uint8Array(r.readBytes(32));
  const subjectIdBytes = new Uint8Array(r.readBytes(32));
  if (bytesEqual(voucherIdBytes, subjectIdBytes)) return null;

  const subjectNick = sanitizeNickname(r.readShortStr());
  if (r.remaining !== 0) return null;

  return {
    voucherIdBytes,
    subjectIdBytes,
    parsed: {
      version: VOUCH_VERSION,
      type: 'vouch',
      active,
      timestamp,
      voucher: { id: toBase64Url(voucherIdBytes) },
      subject: { id: toBase64Url(subjectIdBytes), nickname: subjectNick }
    }
  };
}

export function packVouch(v) {
  const buf = new Uint8Array(v.bodyBytes.length + 64);
  buf.set(v.bodyBytes, 0);
  buf.set(v.sigBytes, v.bodyBytes.length);
  return toBase64Url(buf);
}

export function unpackVouch(b64) {
  const buf = fromBase64Url(b64);
  if (!buf || buf.length < 137) return null;
  const bodyBytes = buf.subarray(0, buf.length - 64);
  const sigBytes = buf.subarray(buf.length - 64);

  let decoded;
  try {
    decoded = decodeVouchBodyBytes(bodyBytes);
  } catch {
    return null;
  }
  if (!decoded) return null;

  return {
    bodyBytes,
    sigBytes,
    voucherIdBytes: decoded.voucherIdBytes,
    subjectIdBytes: decoded.subjectIdBytes,
    pairHash: pairHash8(decoded.voucherIdBytes, decoded.subjectIdBytes),
    parsed: decoded.parsed
  };
}

// --- Shared Compressed Batch Key-Table Framing ---

export async function encodeSignedBatch({
  myId,
  peerId,
  items,
  getParticipantIds,
  keyRing,
  writeItem
}) {
  if (!items || items.length === 0) return null;

  // Index 0 = me, Index 1 = connected peer, Indices 2+ = extra keys needed for this batch
  const keyIndex = new Map([
    [myId, 0],
    [peerId, 1]
  ]);
  const extraKeyBytesList = [];

  const getKeyIdx = (id) => {
    if (keyIndex.has(id)) return keyIndex.get(id);
    const compB64 = keyRing.get(id);
    const compBytes = compB64 ? fromBase64Url(compB64) : null;
    if (!compBytes || compBytes.length !== 33) return -1;
    const idx = 2 + extraKeyBytesList.length;
    keyIndex.set(id, idx);
    extraKeyBytesList.push(compBytes);
    return idx;
  };

  const validEntries = [];
  for (const item of items) {
    const [idA, idB] = getParticipantIds(item);
    const idxA = getKeyIdx(idA);
    const idxB = getKeyIdx(idB);
    if (idxA >= 0 && idxB >= 0) {
      validEntries.push({ item, idxA, idxB });
    }
  }
  if (validEntries.length === 0) return null;

  const w = new ByteWriter();
  w.writeVarUint(validEntries.length);
  w.writeVarUint(extraKeyBytesList.length);
  for (const kBytes of extraKeyBytesList) {
    w.writeBytes(kBytes);
  }
  for (const entry of validEntries) {
    writeItem(w, entry);
  }

  const compressed = await compressPayload(w.finish());
  return toBase64Url(compressed);
}

export async function decodeSignedBatch({
  batchB64,
  remotePeer,
  myIdentity,
  maxItems,
  readItem
}) {
  if (typeof batchB64 !== 'string') return null;

  const packet = fromBase64Url(batchB64);
  if (!packet) return null;
  const raw = await decompressPayload(packet);
  if (!raw) return null;

  const keyEntries = [
    { id: remotePeer.playerId, idBytes: remotePeer.playerIdBytes, keyB64: remotePeer.compressedKeyB64 },
    { id: myIdentity.playerId, idBytes: myIdentity.playerIdBytes, keyB64: myIdentity.compressedKeyB64 }
  ];

  const reader = new ByteReader(raw);
  try {
    const count = reader.readVarUint();
    const extraCount = reader.readVarUint();
    if (count > maxItems || extraCount > maxItems * 2) {
      return null;
    }

    for (let i = 0; i < extraCount; i++) {
      const compBytes = new Uint8Array(reader.readBytes(33));
      const idBytes = await derivePlayerIdBytes(compBytes);
      if (!idBytes) return null;
      keyEntries.push({
        id: toBase64Url(idBytes),
        idBytes,
        keyB64: toBase64Url(compBytes)
      });
    }

    const items = [];
    for (let i = 0; i < count; i++) {
      items.push(readItem(reader));
    }
    if (reader.remaining !== 0) return null;

    return { items, keyEntries };
  } catch {
    return null;
  }
}