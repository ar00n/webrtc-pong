import { GAME_CONFIG, MATCH_MODES } from '../config/constants.js';
import { createDefaultMatchSettings, normalizeMatchSettings } from './MatchSettings.js';

export class GameState {
  // Entities & scores
  hostY = 0;
  guestY = 0;
  ballX = 0;
  ballY = 0;
  vx = 310;
  vy = 190;
  hostScore = 0;
  guestScore = 0;
  serveTimer = 0;

  // Match & authority tracking
  matchActive = false;
  matchOver = false;
  winner = null; // null | 'host' | 'guest'
  timeRemaining = 0;
  settings = createDefaultMatchSettings();

  paused = false;
  pauseReason = ''; // '' | 'manual' | 'lost' | 'reconnected'
  pausedBy = '';
  currentRound = 0;
  hitSeq = 0;
  lastHitSeq = 0;
  ballOwner = 'h'; // 'h' (host/left) | 'g' (guest/right)
  waitingForServe = false;

  // Visual error smoothing
  visErrX = 0;
  visErrY = 0;

  constructor() {
    this.centerPaddles();
    this.centerBall();
  }

  static clampPaddleY(y) {
    if (!Number.isFinite(y)) return 0;
    return Math.max(0, Math.min(GAME_CONFIG.HEIGHT - GAME_CONFIG.PADDLE_HEIGHT, y));
  }

  setSettings(nextSettings) {
    this.settings = normalizeMatchSettings(nextSettings);
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > this.settings.maxBallSpeed && speed > 0) {
      const scale = this.settings.maxBallSpeed / speed;
      this.vx *= scale;
      this.vy *= scale;
    }
  }

  centerPaddles() {
    const centerY = GAME_CONFIG.HEIGHT / 2 - GAME_CONFIG.PADDLE_HEIGHT / 2;
    this.hostY = centerY;
    this.guestY = centerY;
  }

  centerBall() {
    this.ballX = GAME_CONFIG.WIDTH / 2;
    this.ballY = GAME_CONFIG.HEIGHT / 2;
  }

  resetAll() {
    this.matchActive = false;
    this.matchOver = false;
    this.winner = null;
    this.timeRemaining =
      this.settings.mode === MATCH_MODES.TIMED ? this.settings.timeLimitSec : 0;
    this.paused = false;
    this.pauseReason = '';
    this.pausedBy = '';
    this.currentRound = 0;
    this.hitSeq = 0;
    this.lastHitSeq = 0;
    this.ballOwner = 'h';
    this.waitingForServe = false;
    this.hostScore = 0;
    this.guestScore = 0;
    this.serveTimer = 0;
    this.visErrX = 0;
    this.visErrY = 0;
    this.centerPaddles();
    this.centerBall();
  }

  resetMatch() {
    this.matchActive = true;
    this.matchOver = false;
    this.winner = null;
    this.paused = false;
    this.pauseReason = '';
    this.pausedBy = '';
    this.hostScore = 0;
    this.guestScore = 0;
    this.timeRemaining =
      this.settings.mode === MATCH_MODES.TIMED ? this.settings.timeLimitSec : 0;
    this.centerPaddles();
    this.prepareServe(Math.random() < 0.5 ? 1 : -1);
  }

  setMatchOver(winner) {
    this.matchOver = true;
    this.winner = winner;
    this.serveTimer = 0;
    this.waitingForServe = false;
    this.paused = false;
    this.pauseReason = '';
    this.pausedBy = '';
  }

  prepareServe(direction) {
    this.currentRound++;
    this.hitSeq = 0;
    this.lastHitSeq = 0;
    this.visErrX = 0;
    this.visErrY = 0;
    this.waitingForServe = false;

    this.centerBall();
    const angle = (Math.random() - 0.5) * GAME_CONFIG.SERVE_ANGLE_RANGE;
    const speed = this.settings?.initialBallSpeed ?? GAME_CONFIG.INITIAL_BALL_SPEED;
    this.vx = Math.cos(angle) * speed * direction;
    this.vy = Math.sin(angle) * speed;
    this.serveTimer = GAME_CONFIG.SERVE_DELAY;
    this.ballOwner = direction < 0 ? 'h' : 'g';
  }

  setPaused(paused, reason = '', by = '') {
    this.paused = paused;
    this.pauseReason = paused ? reason : '';
    this.pausedBy = paused ? by : '';
  }

  getLocalPaddleY(isHost) {
    return isHost ? this.hostY : this.guestY;
  }

  setLocalPaddleY(isHost, y) {
    if (!Number.isFinite(y)) return;
    const clamped = GameState.clampPaddleY(y);
    if (isHost) this.hostY = clamped;
    else this.guestY = clamped;
  }

  setRemotePaddleY(isHost, y) {
    if (!Number.isFinite(y)) return;
    const clamped = GameState.clampPaddleY(y);
    if (isHost) this.guestY = clamped;
    else this.hostY = clamped;
  }

  moveLocalPaddle(isHost, direction, dt) {
    if (direction === 0) return;
    const current = this.getLocalPaddleY(isHost);
    this.setLocalPaddleY(isHost, current + direction * GAME_CONFIG.PADDLE_SPEED * dt);
  }

  applyVisualError(dx, dy) {
    if (Math.hypot(dx, dy) < GAME_CONFIG.MAX_VISUAL_SNAP_DIST) {
      this.visErrX = dx;
      this.visErrY = dy;
    } else {
      this.visErrX = 0;
      this.visErrY = 0;
    }
  }

  decayVisualError(dt) {
    const decay = Math.exp(-GAME_CONFIG.VISUAL_ERROR_DECAY * dt);
    this.visErrX *= decay;
    this.visErrY *= decay;
  }
}