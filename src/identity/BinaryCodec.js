const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const MAX_DECOMPRESSED_BYTES = 1024 * 1024; // 1 MiB safety cap

export function truncateUtf8(bytes, maxBytes) {
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  return bytes.subarray(0, end);
}

export function toBase64Url(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(b64url) {
  if (
    typeof b64url !== 'string' ||
    !b64url ||
    b64url.length % 4 === 1 ||
    !B64URL_RE.test(b64url)
  ) {
    return null;
  }
  const padLen = (4 - (b64url.length % 4)) % 4;
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    if (toBase64Url(bytes) !== b64url) {
      return null;
    }
    return bytes;
  } catch {
    return null;
  }
}

export function bytesEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// --- Deflate-Raw Compression Helpers ---

function singleChunkStream(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

async function compressWithStream(bytes) {
  const stream = new CompressionStream('deflate-raw');
  const res = await new Response(singleChunkStream(bytes).pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(res);
}

async function decompressWithStream(bytes, maxBytes = MAX_DECOMPRESSED_BYTES) {
  const stream = new DecompressionStream('deflate-raw');
  const reader = singleChunkStream(bytes).pipeThrough(stream).getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('Decompressed payload exceeds size limit').catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function compressPayload(rawBytes) {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  if (typeof CompressionStream === 'function' && bytes.length > 48) {
    try {
      const deflated = await compressWithStream(bytes);
      if (deflated.length + 1 < bytes.length) {
        const out = new Uint8Array(deflated.length + 1);
        out[0] = 0x01; // compressed
        out.set(deflated, 1);
        return out;
      }
    } catch {
      // Fallback to uncompressed
    }
  }
  const out = new Uint8Array(bytes.length + 1);
  out[0] = 0x00; // raw
  out.set(bytes, 1);
  return out;
}

export async function decompressPayload(packetBytes) {
  if (!(packetBytes instanceof Uint8Array) || packetBytes.length < 1) return null;
  const flag = packetBytes[0];
  const body = packetBytes.subarray(1);
  if (flag === 0x00) {
    return body.length <= MAX_DECOMPRESSED_BYTES ? body : null;
  }
  if (flag === 0x01 && body.length > 0 && typeof DecompressionStream === 'function') {
    try {
      return await decompressWithStream(body);
    } catch {
      return null;
    }
  }
  return null;
}

// --- Tiny Binary Writer / Reader ---

export class ByteWriter {
  #buf = new Uint8Array(256);
  #pos = 0;

  #ensure(extra) {
    if (this.#pos + extra <= this.#buf.length) return;
    let nextLen = this.#buf.length * 2;
    while (nextLen < this.#pos + extra) nextLen *= 2;
    const next = new Uint8Array(nextLen);
    next.set(this.#buf.subarray(0, this.#pos));
    this.#buf = next;
  }

  writeU8(v) {
    this.#ensure(1);
    this.#buf[this.#pos++] = v & 0xff;
  }

  writeU16(v) {
    this.#ensure(2);
    this.#buf[this.#pos++] = (v >>> 8) & 0xff;
    this.#buf[this.#pos++] = v & 0xff;
  }

  writeU48(v) {
    this.#ensure(6);
    const safe = Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 0xffffffffffff) : 0;
    const hi = Math.floor(safe / 0x100000000);
    const lo = safe >>> 0;
    this.#buf[this.#pos++] = (hi >>> 8) & 0xff;
    this.#buf[this.#pos++] = hi & 0xff;
    this.#buf[this.#pos++] = (lo >>> 24) & 0xff;
    this.#buf[this.#pos++] = (lo >>> 16) & 0xff;
    this.#buf[this.#pos++] = (lo >>> 8) & 0xff;
    this.#buf[this.#pos++] = lo & 0xff;
  }

  writeVarUint(v) {
    let n = v >>> 0;
    while (n >= 0x80) {
      this.writeU8((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    this.writeU8(n);
  }

  writeBytes(bytes) {
    this.#ensure(bytes.length);
    this.#buf.set(bytes, this.#pos);
    this.#pos += bytes.length;
  }

  writeShortStr(str) {
    const encoded = truncateUtf8(TEXT_ENCODER.encode(str || ''), 255);
    this.writeU8(encoded.length);
    this.writeBytes(encoded);
  }

  finish() {
    return this.#buf.slice(0, this.#pos);
  }
}

export class ByteReader {
  #buf;
  #pos = 0;

  constructor(buf) {
    this.#buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  }

  get remaining() {
    return this.#buf.length - this.#pos;
  }

  readU8() {
    if (this.#pos + 1 > this.#buf.length) throw new Error('EOF');
    return this.#buf[this.#pos++];
  }

  readU16() {
    if (this.#pos + 2 > this.#buf.length) throw new Error('EOF');
    const v = (this.#buf[this.#pos] << 8) | this.#buf[this.#pos + 1];
    this.#pos += 2;
    return v;
  }

  readU48() {
    if (this.#pos + 6 > this.#buf.length) throw new Error('EOF');
    const hi = (this.#buf[this.#pos] << 8) | this.#buf[this.#pos + 1];
    const lo =
      ((this.#buf[this.#pos + 2] << 24) |
        (this.#buf[this.#pos + 3] << 16) |
        (this.#buf[this.#pos + 4] << 8) |
        this.#buf[this.#pos + 5]) >>>
      0;
    this.#pos += 6;
    return hi * 0x100000000 + lo;
  }

  readVarUint() {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.readU8();
      if (i === 4 && (byte & 0xf0) !== 0) {
        throw new Error('Invalid varint');
      }
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
    throw new Error('Invalid varint');
  }

  readBytes(len) {
    if (len < 0 || this.#pos + len > this.#buf.length) throw new Error('EOF');
    const slice = this.#buf.subarray(this.#pos, this.#pos + len);
    this.#pos += len;
    return slice;
  }

  readShortStr() {
    const len = this.readU8();
    return TEXT_DECODER.decode(this.readBytes(len));
  }
}