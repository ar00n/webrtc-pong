export const GAME_CONFIG = Object.freeze({
  WIDTH: 700,
  HEIGHT: 420,
  PADDLE_MARGIN: 20,
  PADDLE_WIDTH: 12,
  PADDLE_HEIGHT: 80,
  PADDLE_SPEED: 420,
  BALL_RADIUS: 7,
  INITIAL_BALL_SPEED: 340,
  MAX_BALL_SPEED: 1000,
  SPEED_MULTIPLIER: 1.05,
  MAX_BOUNCE_ANGLE: 0.95,
  SERVE_DELAY: 0.65,
  SERVE_ANGLE_RANGE: 0.6,
  MAX_SUBSTEP: 1 / 180,
  MAX_FRAME_DT: 0.05,
  VISUAL_ERROR_DECAY: 22,
  MAX_VISUAL_SNAP_DIST: 140,
  GUEST_MISS_FALLBACK_MARGIN: 180,
  GUEST_MISS_FALLBACK_SEC: 0.35
});

export const COURT_BOUNDS = Object.freeze({
  LEFT_FACE: GAME_CONFIG.PADDLE_MARGIN + GAME_CONFIG.PADDLE_WIDTH,
  RIGHT_FACE: GAME_CONFIG.WIDTH - GAME_CONFIG.PADDLE_MARGIN - GAME_CONFIG.PADDLE_WIDTH
});

export const NETWORK_CONFIG = Object.freeze({
  APP_ID_PREFIX: 'webrtc-pong-v1:',
  MAX_USERS: 2,
  CODE_CHARS: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  CODE_LENGTH: 5,
  MIN_CODE_LENGTH: 3,
  MAX_CODE_LENGTH: 12,
  HEARTBEAT_INTERVAL_MS: 500,
  CONNECTION_TIMEOUT_MS: 2500,
  PADDLE_SEND_INTERVAL_MS: 16,
  PADDLE_HEARTBEAT_MS: 100,
  DEFAULT_HALF_RTT: 0.025,
  MAX_HALF_RTT_SAMPLE: 0.15,
  RTT_SMOOTHING: 0.7,
  MAX_VISUAL_ADVANCE: 0.18
});

export const AUDIO_CONFIG = Object.freeze({
  STORAGE_VOL_KEY: 'p2p-pong-volume',
  STORAGE_MUTE_KEY: 'p2p-pong-muted',
  STORAGE_WIN_SOUND_KEY: 'p2p-pong-win-sound',
  DEFAULT_VOLUME: 70,
  DEFAULT_WIN_SOUND: 'classic',
  MAX_GAIN: 0.45,
  GAIN_CURVE: 1.4
});

export const PADDLE_COLORS = Object.freeze([
  Object.freeze({ id: 'white', label: 'Classic White', hex: '#ffffff' }),
  Object.freeze({ id: 'cyan', label: 'Electric Cyan', hex: '#56ccf2' }),
  Object.freeze({ id: 'green', label: 'Neon Green', hex: '#6fcf97' }),
  Object.freeze({ id: 'yellow', label: 'Arcade Yellow', hex: '#f2c94c' }),
  Object.freeze({ id: 'orange', label: 'Solar Orange', hex: '#f2994a' }),
  Object.freeze({ id: 'red', label: 'Crimson Red', hex: '#eb5757' }),
  Object.freeze({ id: 'purple', label: 'Plasma Purple', hex: '#bb6bd9' }),
  Object.freeze({ id: 'blue', label: 'Cobalt Blue', hex: '#2f80ed' })
]);

export const PADDLE_CONFIG = Object.freeze({
  STORAGE_COLOR_KEY: 'p2p-pong-paddle-color',
  DEFAULT_COLOR_ID: 'white'
});

export const DIFFICULTY_PRESETS = Object.freeze({
  easy: Object.freeze({
    id: 'easy',
    label: 'Easy',
    initialBallSpeed: 280,
    maxBallSpeed: 680,
    speedMultiplier: 1.03
  }),
  normal: Object.freeze({
    id: 'normal',
    label: 'Normal',
    initialBallSpeed: GAME_CONFIG.INITIAL_BALL_SPEED,
    maxBallSpeed: GAME_CONFIG.MAX_BALL_SPEED,
    speedMultiplier: GAME_CONFIG.SPEED_MULTIPLIER
  }),
  hard: Object.freeze({
    id: 'hard',
    label: 'Hard',
    initialBallSpeed: 400,
    maxBallSpeed: 1400,
    speedMultiplier: 1.08
  })
});

export const CUSTOM_DIFFICULTY_BOUNDS = Object.freeze({
  MIN_INITIAL_SPEED: 200,
  MAX_INITIAL_SPEED: 600,
  MIN_MAX_SPEED: 450,
  MAX_MAX_SPEED: 1600,
  MIN_MULTIPLIER: 1.0,
  MAX_MULTIPLIER: 1.2
});

export const MATCH_MODES = Object.freeze({
  FIRST_TO: 'first-to',
  WIN_BY_2: 'win-by-2',
  TIMED: 'timed',
  ENDLESS: 'endless'
});

export const MODE_CONFIG = Object.freeze({
  STORAGE_SETTINGS_KEY: 'p2p-pong-match-settings',
  DEFAULT_DIFFICULTY: 'normal',
  DEFAULT_MODE: MATCH_MODES.FIRST_TO,
  DEFAULT_TARGET_SCORE: 7,
  MIN_TARGET_SCORE: 1,
  MAX_TARGET_SCORE: 99,
  DEFAULT_TIME_LIMIT_SEC: 120,
  MIN_TIME_LIMIT_SEC: 30,
  MAX_TIME_LIMIT_SEC: 600
});