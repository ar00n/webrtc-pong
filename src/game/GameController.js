import {
  AUDIO_CONFIG,
  GAME_CONFIG,
  MATCH_MODES,
  NETWORK_CONFIG
} from '../config/constants.js';
import { MSG_TYPE } from '../network/protocol.js';
import { EventEmitter } from '../utils/EventEmitter.js';
import { GameState } from './GameState.js';
import { areMatchSettingsEqual, evaluateMatchWinner } from './MatchSettings.js';
import { PhysicsEngine } from './PhysicsEngine.js';

export class GameController extends EventEmitter {
  #state = new GameState();
  #physics = new PhysicsEngine();
  #network;
  #audio;
  #createMatchId;

  #localReady = false;
  #remoteReady = false;
  #remoteWinSoundId = AUDIO_CONFIG.DEFAULT_WIN_SOUND;
  #currentMatchId = '';
  #lastPaddleSend = 0;
  #lastSentPaddleY = null;

  constructor({ network, audio, createMatchId }) {
    super();
    this.#network = network;
    this.#audio = audio;
    this.#createMatchId = createMatchId;
  }

  get state() {
    return this.#state;
  }

  get localReady() {
    return this.#localReady;
  }

  get remoteReady() {
    return this.#remoteReady;
  }

  setRemoteWinSoundId(id) {
    if (typeof id === 'string') {
      this.#remoteWinSoundId = id;
    }
  }

  resetSession(localSettings = null) {
    if (localSettings) {
      this.#state.setSettings(localSettings);
    }
    this.#state.resetAll();
    this.#audio.resetHitDeduplication();
    this.#remoteWinSoundId = AUDIO_CONFIG.DEFAULT_WIN_SOUND;
    this.#localReady = false;
    this.#remoteReady = false;
    this.#lastSentPaddleY = null;
    this.#lastPaddleSend = 0;
    this.#currentMatchId = '';
  }

  applySettings(rawSettings, { persist } = {}) {
    if (this.#network.inRoom && !this.#network.isHost) return false;

    const prevSettings = this.#state.settings;
    const merged = { ...prevSettings, ...rawSettings };
    this.#state.setSettings(merged);
    const settingsChanged = !areMatchSettingsEqual(this.#state.settings, prevSettings);

    persist?.(this.#state.settings);

    if (
      !this.#state.matchActive ||
      this.#state.matchOver ||
      rawSettings.mode !== undefined ||
      rawSettings.timeLimitSec !== undefined
    ) {
      this.#state.timeRemaining =
        this.#state.settings.mode === MATCH_MODES.TIMED ? this.#state.settings.timeLimitSec : 0;
    }

    if (this.#network.connected && this.#network.isHost) {
      this.sendGameSettings();
      if (this.#state.matchActive && !this.#state.matchOver) {
        this.#checkMatchWinner();
      } else if (settingsChanged && (this.#localReady || this.#remoteReady)) {
        const hadLocalReady = this.#localReady;
        this.#localReady = false;
        this.#remoteReady = false;
        if (hadLocalReady) {
          this.sendReadyState();
        }
      }
    }

    this.emit('change');
    return true;
  }

  handleSpacePress() {
    if (!this.#network.connected || this.#network.connectionLost) return;
    if (this.#state.matchActive && !this.#state.matchOver) {
      this.togglePause();
    } else {
      this.toggleReady();
    }
  }

  toggleReady() {
    if (
      !this.#network.connected ||
      this.#network.connectionLost ||
      (this.#state.matchActive && !this.#state.matchOver)
    ) {
      return;
    }

    this.#audio.unlock();
    this.#localReady = !this.#localReady;
    this.sendReadyState();
    this.#tryStartMatchIfReady();
    this.emit('change');
  }

  togglePause() {
    if (
      !this.#network.connected ||
      this.#network.connectionLost ||
      !this.#state.matchActive ||
      this.#state.matchOver
    ) {
      return;
    }

    const nextPaused = !this.#state.paused;
    const reason = nextPaused ? 'manual' : '';
    const by = nextPaused ? (this.#network.isHost ? 'Host' : 'Guest') : '';

    this.#state.setPaused(nextPaused, reason, by);
    this.#network.send(MSG_TYPE.PAUSE, { paused: nextPaused, reason, by });

    if (!nextPaused && this.#network.isHost) {
      this.sendSyncState();
    }

    this.#audio.playPause(nextPaused);
    this.emit('change');
  }

  resetHostMatch() {
    if (
      !this.#network.isHost ||
      !this.#network.connected ||
      this.#network.connectionLost ||
      !this.#state.matchActive ||
      this.#state.matchOver
    ) {
      return;
    }
    this.startHostMatch();
  }

  startHostMatch() {
    this.#state.resetMatch();
    this.#currentMatchId = this.#createMatchId();
    this.#audio.resetHitDeduplication();
    this.sendServe();
    this.emit('change');
  }

  handlePointerPaddle(y) {
    if (
      this.#network.inRoom &&
      (!this.#network.connected ||
        !this.#state.matchActive ||
        this.#state.paused ||
        this.#state.matchOver ||
        this.#network.connectionLost)
    ) {
      return;
    }
    const isHost = !this.#network.inRoom || this.#network.isHost;
    this.#state.setLocalPaddleY(isHost, y);
  }

  handlePeerJoin() {
    if (this.#state.matchActive) {
      if (!this.#state.matchOver) {
        this.#state.setPaused(true, 'reconnected', '');
        this.#state.waitingForServe = !this.#network.isHost;
      }
      if (this.#network.isHost) {
        this.sendGameSettings();
        this.sendSyncState();
        this.#network.startPingLoop();
      }
    }
    this.#audio.playConnect();
    this.emit('change');
  }

  handlePeerLeave() {
    this.#state.waitingForServe = false;
    this.handleConnectionLostPause();
  }

  handleConnectionLostPause() {
    if (this.#state.matchActive && !this.#state.matchOver) {
      this.#state.setPaused(true, 'lost', '');
    } else {
      this.#localReady = false;
      this.#remoteReady = false;
    }
    this.#audio.playDisconnect();
    this.emit('change');
  }

  handleConnectionRestored() {
    if (this.#state.matchActive && !this.#state.matchOver) {
      this.#state.setPaused(true, 'reconnected', '');
    } else {
      this.sendReadyState();
    }
    if (this.#network.isHost) {
      this.sendGameSettings();
      if (this.#state.matchActive) {
        this.sendSyncState();
      }
    }
    this.#audio.playConnect();
    this.emit('change');
  }

  syncAfterHello(wasHost) {
    const net = this.#network;
    const state = this.#state;

    if (net.isHost) {
      net.startPingLoop();
      this.sendGameSettings();
      if (state.matchActive) {
        if (!this.#currentMatchId) {
          this.#currentMatchId = this.#createMatchId();
        }
        this.sendSyncState();
      }
    } else {
      net.stopPingLoop();
      if (state.matchActive && wasHost) {
        state.waitingForServe = true;
      }
    }

    if ((!state.matchActive || state.matchOver) && this.#localReady) {
      this.sendReadyState();
    }

    this.emit('change');
  }

  handleMessage(msg) {
    const net = this.#network;
    const state = this.#state;

    switch (msg.t) {
      case MSG_TYPE.READY: {
        if (typeof msg.ready !== 'boolean') return true;
        if (state.matchActive && !state.matchOver) return true;
        this.#remoteReady = msg.ready;
        this.#tryStartMatchIfReady();
        this.emit('change');
        return true;
      }

      case MSG_TYPE.PADDLE: {
        if (!Number.isFinite(msg.y)) return true;
        state.setRemotePaddleY(net.isHost, msg.y);
        return true;
      }

      case MSG_TYPE.WIN_SOUND: {
        this.setRemoteWinSoundId(msg.winSoundId);
        return true;
      }

      case MSG_TYPE.GAME_SETTINGS: {
        if (net.isHost || !msg.settings) return true;
        const prevSettings = state.settings;
        state.setSettings(msg.settings);
        const settingsChanged = !areMatchSettingsEqual(state.settings, prevSettings);
        if (Number.isFinite(msg.timeRemaining)) {
          state.timeRemaining = msg.timeRemaining;
        } else if (!state.matchActive || state.matchOver) {
          state.timeRemaining =
            state.settings.mode === MATCH_MODES.TIMED ? state.settings.timeLimitSec : 0;
        }
        if ((!state.matchActive || state.matchOver) && settingsChanged && this.#localReady) {
          this.#localReady = false;
          this.sendReadyState();
        }
        this.emit('change');
        return true;
      }

      case MSG_TYPE.PAUSE: {
        if (!state.matchActive || state.matchOver) return true;
        const nextPaused = Boolean(msg.paused);
        if (nextPaused !== state.paused) {
          this.#audio.playPause(nextPaused);
        }
        const safeReason =
          msg.reason === 'reconnected' || msg.reason === 'lost' ? msg.reason : 'manual';
        const safeBy = typeof msg.by === 'string' ? msg.by.slice(0, 24) : '';
        state.setPaused(nextPaused, safeReason, safeBy);
        if (!nextPaused && net.isHost) {
          this.sendSyncState();
        }
        this.emit('change');
        return true;
      }

      case MSG_TYPE.SYNC_STATE: {
        if (!net.isHost) this.#applySyncState(msg);
        return true;
      }

      case MSG_TYPE.SERVE: {
        if (!net.isHost) this.#applyServe(msg);
        return true;
      }

      case MSG_TYPE.HIT: {
        this.#applyRemoteHit(msg);
        return true;
      }

      case MSG_TYPE.MISS: {
        if (!net.isHost || state.matchOver || state.paused || msg.round !== state.currentRound) {
          return true;
        }
        state.hostScore++;
        this.#audio.playScore(true);
        if (!this.#checkMatchWinner()) {
          state.prepareServe(-1);
          this.sendServe();
        }
        return true;
      }

      case MSG_TYPE.MATCH_OVER: {
        if (!net.isHost) this.#applyRemoteMatchOver(msg);
        return true;
      }

      default:
        return false;
    }
  }

  stepFrame(now, dt, verticalDirection) {
    if (this.#network.connected && !this.#network.connectionLost) {
      this.#network.checkTimeout(now);
    }

    const activePlay =
      this.#network.connected &&
      !this.#state.paused &&
      !this.#network.connectionLost &&
      this.#state.matchActive &&
      !this.#state.matchOver;

    if (!activePlay) return;

    const state = this.#state;
    const isHost = this.#network.isHost;

    state.moveLocalPaddle(isHost, verticalDirection, dt);
    state.decayVisualError(dt);

    const myY = Math.round(state.getLocalPaddleY(isHost));
    const timeSinceSend = now - this.#lastPaddleSend;
    if (
      timeSinceSend >= NETWORK_CONFIG.PADDLE_SEND_INTERVAL_MS &&
      (myY !== this.#lastSentPaddleY || timeSinceSend >= NETWORK_CONFIG.PADDLE_HEARTBEAT_MS)
    ) {
      this.#lastPaddleSend = now;
      this.#lastSentPaddleY = myY;
      this.#network.send(MSG_TYPE.PADDLE, { y: myY });
    }

    if (
      state.settings.mode === MATCH_MODES.TIMED &&
      state.timeRemaining > 0 &&
      state.serveTimer <= 0 &&
      !state.waitingForServe
    ) {
      state.timeRemaining = Math.max(0, state.timeRemaining - dt);
      if (isHost && state.timeRemaining <= 0 && this.#checkMatchWinner()) {
        return;
      }
    }

    this.#physics.step(state, dt, {
      onServeStart: () => this.#audio.playServe(),
      onWallBounce: () => this.#audio.playWallBounce(),
      onPaddleHit: (side) => this.#handlePaddleHit(side),
      onMiss: (side) => this.#handleMiss(side)
    });

    const fallbackMargin = Math.max(
      GAME_CONFIG.GUEST_MISS_FALLBACK_MARGIN,
      state.settings.maxBallSpeed * GAME_CONFIG.GUEST_MISS_FALLBACK_SEC
    );
    const fallbackX = GAME_CONFIG.WIDTH + GAME_CONFIG.BALL_RADIUS + fallbackMargin;
    if (isHost && !state.matchOver && state.ballOwner === 'g' && state.ballX > fallbackX) {
      state.hostScore++;
      this.#audio.playScore(true);
      if (!this.#checkMatchWinner()) {
        state.prepareServe(-1);
        this.sendServe();
      }
    }
  }

  sendReadyState() {
    if (!this.#network.connected) return;
    this.#network.send(MSG_TYPE.READY, { ready: this.#localReady });
  }

  sendGameSettings() {
    if (!this.#network.isHost || !this.#network.connected) return;
    this.#network.send(MSG_TYPE.GAME_SETTINGS, {
      settings: this.#state.settings,
      timeRemaining: this.#state.timeRemaining
    });
  }

  sendServe() {
    if (!this.#network.isHost || !this.#network.connected) return;
    const s = this.#state;
    this.#network.send(MSG_TYPE.SERVE, {
      round: s.currentRound,
      bx: s.ballX,
      by: s.ballY,
      vx: s.vx,
      vy: s.vy,
      hs: s.hostScore,
      gs: s.guestScore,
      st: s.serveTimer,
      timeRemaining: s.timeRemaining
    });
  }

  sendSyncState() {
    if (!this.#network.isHost || !this.#network.connected) return;
    const s = this.#state;
    this.#network.send(MSG_TYPE.SYNC_STATE, {
      round: s.currentRound,
      hitSeq: s.hitSeq,
      owner: s.ballOwner,
      bx: s.ballX,
      by: s.ballY,
      vx: s.vx,
      vy: s.vy,
      st: s.serveTimer,
      hs: s.hostScore,
      gs: s.guestScore,
      hy: s.hostY,
      paused: s.paused,
      pauseReason: s.pauseReason,
      pausedBy: s.pausedBy,
      settings: s.settings,
      timeRemaining: s.timeRemaining,
      matchOver: s.matchOver,
      winner: s.winner
    });
  }

  #tryStartMatchIfReady() {
    if (
      !this.#network.isHost ||
      !this.#network.connected ||
      this.#network.connectionLost ||
      !this.#localReady ||
      !this.#remoteReady ||
      (this.#state.matchActive && !this.#state.matchOver)
    ) {
      return;
    }

    this.#localReady = false;
    this.#remoteReady = false;
    this.startHostMatch();
  }

  #applyRemoteHit(msg) {
    const state = this.#state;
    if (
      state.matchOver ||
      state.paused ||
      msg.round !== state.currentRound ||
      !Number.isFinite(msg.hitSeq) ||
      msg.hitSeq <= state.lastHitSeq ||
      !Number.isFinite(msg.bx) ||
      !Number.isFinite(msg.by) ||
      !Number.isFinite(msg.vx) ||
      !Number.isFinite(msg.vy)
    ) {
      return;
    }
    state.lastHitSeq = msg.hitSeq;
    state.hitSeq = msg.hitSeq;

    const side = msg.vx > 0 ? 'left' : 'right';
    this.#audio.playPaddleHitOnce(msg.round, msg.hitSeq, side, Math.hypot(msg.vx, msg.vy));

    const oldBx = state.ballX;
    const oldBy = state.ballY;

    state.ballX = msg.bx;
    state.ballY = msg.by;
    state.vx = msg.vx;
    state.vy = msg.vy;
    state.serveTimer = 0;
    state.ballOwner = msg.vx < 0 ? 'h' : 'g';

    this.#physics.advanceVisual(state, this.#network.halfRtt);
    state.applyVisualError(oldBx - state.ballX, oldBy - state.ballY);
  }

  #applyRemoteMatchOver(msg) {
    const state = this.#state;
    const prevHs = state.hostScore;
    const prevGs = state.guestScore;
    const prevTime = state.timeRemaining;
    const hs = Number.isFinite(msg.hs) ? msg.hs : prevHs;
    const gs = Number.isFinite(msg.gs) ? msg.gs : prevGs;
    const nextTime = Number.isFinite(msg.timeRemaining) ? msg.timeRemaining : prevTime;

    const timedOk = state.settings.mode !== MATCH_MODES.TIMED || prevTime <= 5.0;
    const scoreOk = hs >= prevHs && gs >= prevGs && hs - prevHs <= 1 && gs - prevGs <= 1;
    const evalWinner = evaluateMatchWinner(
      { hostScore: hs, guestScore: gs, timeRemaining: nextTime },
      state.settings
    );

    const plausible =
      typeof msg.matchId === 'string' &&
      msg.matchId.length > 0 &&
      timedOk &&
      scoreOk &&
      evalWinner === msg.winner;

    state.hostScore = hs;
    state.guestScore = gs;
    state.timeRemaining = nextTime;
    state.setMatchOver(msg.winner || null);
    this.#localReady = false;
    this.#remoteReady = false;

    const fallbackId =
      msg.winner === 'guest' ? this.#audio.selectedWinSoundId : this.#remoteWinSoundId;
    const winSoundId = typeof msg.winSoundId === 'string' ? msg.winSoundId : fallbackId;
    this.#audio.playMatchWin(winSoundId);

    this.emit('match-over', {
      role: 'guest',
      matchId: msg.matchId,
      hostScore: hs,
      guestScore: gs,
      winner: msg.winner,
      settings: { ...state.settings },
      plausible
    });
    this.emit('change');
  }

  #applySyncState(msg) {
    if (
      !Number.isFinite(msg.round) ||
      !Number.isFinite(msg.hitSeq) ||
      !Number.isFinite(msg.bx) ||
      !Number.isFinite(msg.by) ||
      !Number.isFinite(msg.vx) ||
      !Number.isFinite(msg.vy) ||
      !Number.isFinite(msg.st) ||
      !Number.isFinite(msg.hs) ||
      !Number.isFinite(msg.gs) ||
      !Number.isFinite(msg.hy)
    ) {
      return;
    }

    const state = this.#state;
    const halfRtt = this.#network.halfRtt;

    if (msg.settings) {
      state.setSettings(msg.settings);
    }

    state.matchActive = true;
    state.currentRound = msg.round;
    state.hitSeq = msg.hitSeq;
    state.lastHitSeq = msg.hitSeq;
    this.#audio.syncHitDeduplication(msg.round, msg.hitSeq);

    state.ballOwner = msg.owner === 'g' ? 'g' : 'h';
    state.ballX = msg.bx;
    state.ballY = msg.by;
    state.vx = msg.vx;
    state.vy = msg.vy;
    state.serveTimer = msg.st;
    state.hostScore = msg.hs;
    state.guestScore = msg.gs;
    state.hostY = GameState.clampPaddleY(msg.hy);
    if (Number.isFinite(msg.timeRemaining)) {
      state.timeRemaining = msg.timeRemaining;
    }
    state.waitingForServe = false;
    state.visErrX = 0;
    state.visErrY = 0;

    if (msg.matchOver) {
      state.setMatchOver(msg.winner || null);
    } else {
      this.#localReady = false;
      this.#remoteReady = false;
      state.matchOver = false;
      state.winner = null;
      if (typeof msg.paused === 'boolean') {
        state.setPaused(msg.paused, msg.pauseReason || '', msg.pausedBy || '');
      }
    }

    if (!state.paused && !state.matchOver && !this.#network.connectionLost) {
      if (state.serveTimer > halfRtt) {
        state.serveTimer -= halfRtt;
      } else if (state.serveTimer > 0) {
        const rem = halfRtt - state.serveTimer;
        state.serveTimer = 0;
        this.#physics.advanceVisual(state, rem);
      } else {
        this.#physics.advanceVisual(state, halfRtt);
      }
    }

    this.emit('change');
  }

  #applyServe(msg) {
    if (
      !Number.isFinite(msg.round) ||
      !Number.isFinite(msg.bx) ||
      !Number.isFinite(msg.by) ||
      !Number.isFinite(msg.vx) ||
      !Number.isFinite(msg.vy) ||
      !Number.isFinite(msg.hs) ||
      !Number.isFinite(msg.gs) ||
      !Number.isFinite(msg.st)
    ) {
      return;
    }

    const state = this.#state;
    const halfRtt = this.#network.halfRtt;
    const startingNewMatch = !state.matchActive || state.matchOver;

    if (startingNewMatch) {
      this.#localReady = false;
      this.#remoteReady = false;
      this.#audio.resetHitDeduplication();
      state.centerPaddles();
    } else {
      if (msg.gs > state.guestScore) this.#audio.playScore(true);
      else if (msg.hs > state.hostScore) this.#audio.playScore(false);
    }

    state.matchActive = true;
    state.matchOver = false;
    state.winner = null;
    state.currentRound = msg.round;
    state.lastHitSeq = 0;
    state.hitSeq = 0;
    state.waitingForServe = false;
    state.visErrX = 0;
    state.visErrY = 0;

    if (!this.#network.connectionLost) {
      state.setPaused(false);
    }

    state.ballX = msg.bx;
    state.ballY = msg.by;
    state.vx = msg.vx;
    state.vy = msg.vy;
    state.hostScore = msg.hs;
    state.guestScore = msg.gs;
    if (Number.isFinite(msg.timeRemaining)) {
      state.timeRemaining = msg.timeRemaining;
    }
    state.ballOwner = state.vx < 0 ? 'h' : 'g';

    if (msg.st > halfRtt) {
      state.serveTimer = msg.st - halfRtt;
    } else {
      state.serveTimer = 0;
      this.#audio.playServe();
      this.#physics.advanceVisual(state, halfRtt - msg.st);
    }

    this.emit('change');
  }

  #checkMatchWinner() {
    if (!this.#network.isHost || this.#state.matchOver) return false;
    const winner = evaluateMatchWinner(this.#state, this.#state.settings);
    if (!winner) return false;

    if (!this.#currentMatchId) {
      this.#currentMatchId = this.#createMatchId();
    }

    const winSoundId =
      winner === 'host' ? this.#audio.selectedWinSoundId : this.#remoteWinSoundId;

    this.#state.setMatchOver(winner);
    this.#localReady = false;
    this.#remoteReady = false;
    this.#network.send(MSG_TYPE.MATCH_OVER, {
      matchId: this.#currentMatchId,
      winner,
      winSoundId,
      hs: this.#state.hostScore,
      gs: this.#state.guestScore,
      timeRemaining: this.#state.timeRemaining
    });
    this.#audio.playMatchWin(winSoundId);

    this.emit('match-over', {
      role: 'host',
      matchId: this.#currentMatchId,
      hostScore: this.#state.hostScore,
      guestScore: this.#state.guestScore,
      winner,
      settings: { ...this.#state.settings },
      plausible: true
    });
    this.emit('change');
    return true;
  }

  #handlePaddleHit(side) {
    const state = this.#state;
    const isHost = this.#network.isHost;
    const expectedOwner = side === 'left' ? 'h' : 'g';
    const nextOwner = side === 'left' ? 'g' : 'h';
    const isAuthoritative = (side === 'left' && isHost) || (side === 'right' && !isHost);
    const speed = Math.hypot(state.vx, state.vy);

    if (isAuthoritative && state.ballOwner === expectedOwner) {
      state.ballOwner = nextOwner;
      state.hitSeq++;
      state.lastHitSeq = state.hitSeq;
      this.#audio.playPaddleHitOnce(state.currentRound, state.hitSeq, side, speed);
      this.#network.send(MSG_TYPE.HIT, {
        round: state.currentRound,
        hitSeq: state.hitSeq,
        bx: state.ballX,
        by: state.ballY,
        vx: state.vx,
        vy: state.vy
      });
    } else if (!isAuthoritative && state.ballOwner === expectedOwner) {
      this.#audio.playPaddleHitOnce(state.currentRound, state.hitSeq + 1, side, speed);
    }
  }

  #handleMiss(side) {
    const state = this.#state;
    const isHost = this.#network.isHost;

    if (side === 'left' && isHost && state.ballOwner === 'h') {
      state.guestScore++;
      this.#audio.playScore(false);
      if (!this.#checkMatchWinner()) {
        state.prepareServe(1);
        this.sendServe();
      }
      return true;
    }

    if (side === 'right' && !isHost && state.ballOwner === 'g') {
      state.waitingForServe = true;
      this.#network.send(MSG_TYPE.MISS, { round: state.currentRound });
      return true;
    }

    return false;
  }
}
