import { fromBase64Url, toBase64Url } from './BinaryCodec.js';

export {
  ByteReader,
  ByteWriter,
  bytesEqual,
  compressPayload,
  decompressPayload,
  fromBase64Url,
  toBase64Url,
  truncateUtf8
} from './BinaryCodec.js';

const ECDSA_ALGO = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });
const SIGN_PARAMS = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });

// NIST P-256 curve constants for 33-byte SEC1 point compression/decompression
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const P256_SQRT_EXP = (P256_P + 1n) >> 2n; // p ≡ 3 (mod 4)

const TEXT_ENCODER = new TextEncoder();

// Bounded CryptoKey cache to avoid repeated crypto.subtle.importKey calls
const PUBLIC_KEY_CACHE = new Map();
const MAX_KEY_CACHE = 512;

function modPow(base, exp, mod) {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function bytesToBigInt(bytes) {
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}

function bigIntTo32Bytes(value) {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function generateMatchId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

// --- P-256 Point Compression (65B raw <-> 33B SEC1) ---

export function compressRawPublicKey(raw65) {
  const bytes = raw65 instanceof Uint8Array ? raw65 : new Uint8Array(raw65);
  if (bytes.length !== 65 || bytes[0] !== 0x04) return null;
  const out = new Uint8Array(33);
  out[0] = (bytes[64] & 1) === 1 ? 0x03 : 0x02;
  out.set(bytes.subarray(1, 33), 1);
  return out;
}

export function decompressPublicKey(compressed) {
  const bytes = compressed instanceof Uint8Array ? compressed : fromBase64Url(compressed);
  if (!bytes || bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) {
    return null;
  }

  const xBytes = bytes.subarray(1, 33);
  const x = bytesToBigInt(xBytes);
  if (x < 0n || x >= P256_P) return null;

  const rhs = (((modPow(x, 3n, P256_P) - 3n * x + P256_B) % P256_P) + P256_P) % P256_P;
  let y = modPow(rhs, P256_SQRT_EXP, P256_P);
  if ((y * y) % P256_P !== rhs) return null;

  if (y === 0n && (bytes[0] & 1) === 1) return null;
  if ((y & 1n) !== BigInt(bytes[0] & 1)) {
    y = P256_P - y;
  }

  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(xBytes, 1);
  raw.set(bigIntTo32Bytes(y), 33);
  return raw;
}

export function normalizeCompressedKeyB64(keyInput) {
  const bytes = keyInput instanceof Uint8Array ? keyInput : fromBase64Url(keyInput);
  if (!bytes || !decompressPublicKey(bytes)) return null;
  return toBase64Url(bytes);
}

// --- Key Generation, Import & Derivation ---

export async function generateIdentityKeyPair() {
  const keyPair = await crypto.subtle.generateKey(ECDSA_ALGO, true, ['sign', 'verify']);
  const rawPublic = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const compressed = compressRawPublicKey(rawPublic);
  const compressedKeyB64 = toBase64Url(compressed);

  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  if (!privateJwk?.d) throw new Error('Missing private scalar d');

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    compressedKey: compressed,
    compressedKeyB64,
    privateD: privateJwk.d
  };
}

export async function importPublicKey(keyInput) {
  const bytes = keyInput instanceof Uint8Array ? keyInput : fromBase64Url(keyInput);
  if (!bytes) throw new Error('Invalid compressed public key');

  const raw65 = decompressPublicKey(bytes);
  if (!raw65) throw new Error('Invalid P-256 point');

  const cacheKey = toBase64Url(bytes);
  if (PUBLIC_KEY_CACHE.has(cacheKey)) {
    const cached = PUBLIC_KEY_CACHE.get(cacheKey);
    PUBLIC_KEY_CACHE.delete(cacheKey);
    PUBLIC_KEY_CACHE.set(cacheKey, cached);
    return cached;
  }

  const promise = crypto.subtle
    .importKey('raw', raw65, ECDSA_ALGO, true, ['verify'])
    .catch((err) => {
      PUBLIC_KEY_CACHE.delete(cacheKey);
      throw err;
    });

  if (PUBLIC_KEY_CACHE.size >= MAX_KEY_CACHE) {
    const oldest = PUBLIC_KEY_CACHE.keys().next().value;
    PUBLIC_KEY_CACHE.delete(oldest);
  }
  PUBLIC_KEY_CACHE.set(cacheKey, promise);
  return promise;
}

export async function importPrivateKey(compressedKeyInput, privateD) {
  const dBytes = fromBase64Url(privateD);
  if (!dBytes || dBytes.length !== 32) {
    throw new Error('Invalid private scalar');
  }
  const raw65 = decompressPublicKey(compressedKeyInput);
  if (!raw65) throw new Error('Invalid public key');

  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: toBase64Url(raw65.subarray(1, 33)),
    y: toBase64Url(raw65.subarray(33, 65)),
    d: toBase64Url(dBytes)
  };
  return crypto.subtle.importKey('jwk', jwk, ECDSA_ALGO, true, ['sign']);
}

export async function derivePlayerIdBytes(keyInput) {
  const bytes = keyInput instanceof Uint8Array ? keyInput : fromBase64Url(keyInput);
  if (!bytes || bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) {
    return null;
  }
  // Ensure point is actually valid on P-256 before trusting its derived ID
  if (!decompressPublicKey(bytes)) return null;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

export async function derivePlayerId(keyInput) {
  const idBytes = await derivePlayerIdBytes(keyInput);
  return idBytes ? toBase64Url(idBytes) : null;
}

export function getShortId(playerId) {
  return typeof playerId === 'string' && playerId.length >= 6 ? playerId.slice(0, 6) : '------';
}

export function formatPlayerTag(nickname, playerId) {
  const cleanName = typeof nickname === 'string' && nickname.trim() ? nickname.trim() : 'Player';
  return `${cleanName}#${getShortId(playerId)}`;
}

// --- Signing & Verification (Binary + Text) ---

export async function signBytes(privateKey, dataBytes) {
  const bytes = dataBytes instanceof Uint8Array ? dataBytes : new Uint8Array(dataBytes);
  const sigBuffer = await crypto.subtle.sign(SIGN_PARAMS, privateKey, bytes);
  return new Uint8Array(sigBuffer);
}

export async function signText(privateKey, text) {
  const sigBytes = await signBytes(privateKey, TEXT_ENCODER.encode(text));
  return toBase64Url(sigBytes);
}

export async function verifyBytes(keyInput, dataBytes, sigInput) {
  const sigBytes = sigInput instanceof Uint8Array ? sigInput : fromBase64Url(sigInput);
  if (!sigBytes || sigBytes.length !== 64 || !(dataBytes instanceof Uint8Array)) {
    return false;
  }
  try {
    const publicKey = await importPublicKey(keyInput);
    return await crypto.subtle.verify(SIGN_PARAMS, publicKey, sigBytes, dataBytes);
  } catch {
    return false;
  }
}

export async function verifyText(keyInput, text, sigB64Url) {
  if (typeof text !== 'string' || typeof sigB64Url !== 'string' || !sigB64Url) {
    return false;
  }
  return verifyBytes(keyInput, TEXT_ENCODER.encode(text), sigB64Url);
}