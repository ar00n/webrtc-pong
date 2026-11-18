import { NETWORK_CONFIG } from '../config/constants.js';

export const MSG_TYPE = Object.freeze({
  HELLO: 'hello',
  PING: 'ping',
  PONG: 'pong',
  PADDLE: 'p',
  PAUSE: 'pause',
  SYNC_STATE: 'syncState',
  SERVE: 'serve',
  HIT: 'hit',
  MISS: 'miss'
});

const UNSEQUENCED_TYPES = new Set([
  MSG_TYPE.HELLO,
  MSG_TYPE.PING,
  MSG_TYPE.PONG
]);

export function isSequencedMessage(type) {
  return !UNSEQUENCED_TYPES.has(type);
}

export function getAppId() {
  return NETWORK_CONFIG.APP_ID_PREFIX + location.origin + location.pathname.replace(/\/index\.html$/, '/');
}
