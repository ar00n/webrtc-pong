import { NETWORK_CONFIG } from '../config/constants.js';

export function generateRoomCode(length = NETWORK_CONFIG.CODE_LENGTH) {
  const { CODE_CHARS } = NETWORK_CONFIG;
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return code;
}

export function normalizeRoomCode(raw) {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, NETWORK_CONFIG.MAX_CODE_LENGTH);
}

export function isValidRoomCode(code) {
  return code.length >= NETWORK_CONFIG.MIN_CODE_LENGTH;
}

export function buildInviteUrl(code) {
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  return url.toString();
}

export function getRoomCodeFromUrl() {
  const raw = new URLSearchParams(location.search).get('room') || '';
  const normalized = normalizeRoomCode(raw);
  return isValidRoomCode(normalized) ? normalized : '';
}
