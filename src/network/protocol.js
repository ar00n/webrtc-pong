import { NETWORK_CONFIG } from '../config/constants.js';

export const MSG_TYPE = Object.freeze({
  HELLO: 'hello',
  PING: 'ping',
  PONG: 'pong',
  PADDLE: 'p',
  PADDLE_COLOR: 'paddleColor',
  WIN_SOUND: 'winSound',
  GAME_SETTINGS: 'gameSettings',
  PAUSE: 'pause',
  SYNC_STATE: 'syncState',
  SERVE: 'serve',
  HIT: 'hit',
  MISS: 'miss',
  MATCH_OVER: 'matchOver'
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
  let path = location.pathname.replace(/\/index\.html$/, '/');
  if (!path.endsWith('/') && !/\.[^/]+$/.test(path)) {
    path += '/';
  }
  return NETWORK_CONFIG.APP_ID_PREFIX + location.origin + path;
}