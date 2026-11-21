import {
  CUSTOM_DIFFICULTY_BOUNDS,
  DIFFICULTY_PRESETS,
  MATCH_MODES,
  MODE_CONFIG,
  PADDLE_COLORS,
  PADDLE_CONFIG
} from '../config/constants.js';

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

export function resolvePaddleColor(idOrHex) {
  const fallback =
    PADDLE_COLORS.find((c) => c.id === PADDLE_CONFIG.DEFAULT_COLOR_ID) || PADDLE_COLORS[0];
  if (typeof idOrHex !== 'string') return fallback;
  const normalized = idOrHex.trim().toLowerCase();
  return (
    PADDLE_COLORS.find((c) => c.id === normalized || c.hex.toLowerCase() === normalized) ||
    fallback
  );
}

export function createDefaultMatchSettings() {
  const preset = DIFFICULTY_PRESETS[MODE_CONFIG.DEFAULT_DIFFICULTY] || DIFFICULTY_PRESETS.normal;
  return {
    difficulty: preset.id,
    initialBallSpeed: preset.initialBallSpeed,
    maxBallSpeed: preset.maxBallSpeed,
    speedMultiplier: preset.speedMultiplier,
    mode: MODE_CONFIG.DEFAULT_MODE,
    targetScore: MODE_CONFIG.DEFAULT_TARGET_SCORE,
    timeLimitSec: MODE_CONFIG.DEFAULT_TIME_LIMIT_SEC
  };
}

export function normalizeMatchSettings(raw = {}) {
  const base = createDefaultMatchSettings();
  const src = raw && typeof raw === 'object' ? raw : {};

  let difficulty = typeof src.difficulty === 'string' ? src.difficulty : base.difficulty;
  let initialBallSpeed = base.initialBallSpeed;
  let maxBallSpeed = base.maxBallSpeed;
  let speedMultiplier = base.speedMultiplier;

  if (difficulty !== 'custom' && DIFFICULTY_PRESETS[difficulty]) {
    const preset = DIFFICULTY_PRESETS[difficulty];
    initialBallSpeed = preset.initialBallSpeed;
    maxBallSpeed = preset.maxBallSpeed;
    speedMultiplier = preset.speedMultiplier;
  } else if (difficulty === 'custom') {
    initialBallSpeed = Math.round(
      clampNumber(
        src.initialBallSpeed,
        CUSTOM_DIFFICULTY_BOUNDS.MIN_INITIAL_SPEED,
        CUSTOM_DIFFICULTY_BOUNDS.MAX_INITIAL_SPEED,
        base.initialBallSpeed
      )
    );
    maxBallSpeed = Math.round(
      clampNumber(
        src.maxBallSpeed,
        CUSTOM_DIFFICULTY_BOUNDS.MIN_MAX_SPEED,
        CUSTOM_DIFFICULTY_BOUNDS.MAX_MAX_SPEED,
        base.maxBallSpeed
      )
    );
    maxBallSpeed = Math.max(maxBallSpeed, initialBallSpeed);
    speedMultiplier = Number(
      clampNumber(
        src.speedMultiplier,
        CUSTOM_DIFFICULTY_BOUNDS.MIN_MULTIPLIER,
        CUSTOM_DIFFICULTY_BOUNDS.MAX_MULTIPLIER,
        base.speedMultiplier
      ).toFixed(2)
    );
  } else {
    difficulty = base.difficulty;
  }

  const validModes = new Set(Object.values(MATCH_MODES));
  const mode = validModes.has(src.mode) ? src.mode : base.mode;

  const targetScore = Math.round(
    clampNumber(
      src.targetScore,
      MODE_CONFIG.MIN_TARGET_SCORE,
      MODE_CONFIG.MAX_TARGET_SCORE,
      base.targetScore
    )
  );

  const timeLimitSec = Math.round(
    clampNumber(
      src.timeLimitSec,
      MODE_CONFIG.MIN_TIME_LIMIT_SEC,
      MODE_CONFIG.MAX_TIME_LIMIT_SEC,
      base.timeLimitSec
    )
  );

  return {
    difficulty,
    initialBallSpeed,
    maxBallSpeed,
    speedMultiplier,
    mode,
    targetScore,
    timeLimitSec
  };
}

export function areMatchSettingsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.difficulty === b.difficulty &&
    a.initialBallSpeed === b.initialBallSpeed &&
    a.maxBallSpeed === b.maxBallSpeed &&
    a.speedMultiplier === b.speedMultiplier &&
    a.mode === b.mode &&
    a.targetScore === b.targetScore &&
    a.timeLimitSec === b.timeLimitSec
  );
}

export function evaluateMatchWinner(state, settings) {
  const hs = state.hostScore;
  const gs = state.guestScore;

  switch (settings.mode) {
    case MATCH_MODES.FIRST_TO:
      if (hs >= settings.targetScore && hs > gs) return 'host';
      if (gs >= settings.targetScore && gs > hs) return 'guest';
      return null;

    case MATCH_MODES.WIN_BY_2:
      if (hs >= settings.targetScore && hs - gs >= 2) return 'host';
      if (gs >= settings.targetScore && gs - hs >= 2) return 'guest';
      return null;

    case MATCH_MODES.TIMED:
      if (state.timeRemaining <= 0) {
        if (hs > gs) return 'host';
        if (gs > hs) return 'guest';
      }
      return null;

    case MATCH_MODES.ENDLESS:
    default:
      return null;
  }
}

export function isMatchInOvertime(state, settings) {
  return (
    settings.mode === MATCH_MODES.TIMED &&
    !state.matchOver &&
    state.timeRemaining <= 0 &&
    state.hostScore === state.guestScore
  );
}

export function formatTimeClock(seconds) {
  const safe = Math.max(0, Math.ceil(Number(seconds) || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatDifficultySummary(settings) {
  const label =
    settings.difficulty === 'custom'
      ? 'Custom'
      : DIFFICULTY_PRESETS[settings.difficulty]?.label || 'Normal';
  return `${label} (Max ${settings.maxBallSpeed} px/s, ${settings.speedMultiplier.toFixed(2)}×)`;
}

export function formatModeSummary(settings) {
  switch (settings.mode) {
    case MATCH_MODES.FIRST_TO:
      return `First to ${settings.targetScore}`;
    case MATCH_MODES.WIN_BY_2:
      return `Win by 2 (${settings.targetScore})`;
    case MATCH_MODES.TIMED:
      return `Timed (${formatTimeClock(settings.timeLimitSec)})`;
    case MATCH_MODES.ENDLESS:
      return 'Endless';
    default:
      return 'First to 7';
  }
}

export function formatMatchSummary(settings) {
  return `${formatDifficultySummary(settings)} • ${formatModeSummary(settings)}`;
}
