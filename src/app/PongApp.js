import {
  AUDIO_CONFIG,
  GAME_CONFIG,
  MATCH_MODES,
  MODE_CONFIG,
  NETWORK_CONFIG,
  PADDLE_CONFIG
} from '../config/constants.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { GameState } from '../game/GameState.js';
import {
  createDefaultMatchSettings,
  evaluateMatchWinner,
  normalizeMatchSettings,
  resolvePaddleColor
} from '../game/MatchSettings.js';
import { PhysicsEngine } from '../game/PhysicsEngine.js';
import { Renderer } from '../game/Renderer.js';
import { InputController } from '../input/InputController.js';
import { NetworkManager } from '../network/NetworkManager.js';
import { MSG_TYPE } from '../network/protocol.js';
import { UIManager } from '../ui/UIManager.js';
import { generateRoomCode, getRoomCodeFromUrl, isValidRoomCode } from '../utils/code.js';

export class PongApp {
  #audio = new AudioEngine();
  #state = new GameState();
  #physics = new PhysicsEngine();
  #network = new NetworkManager();
  #ui;
  #renderer;
  #input;

  #rafId = null;
  #lastFrameTime = 0;
  #lastPaddleSend = 0;
  #lastSentPaddleY = null;
  #roomTransitionId = 0;
  #remoteWinSoundId = AUDIO_CONFIG.DEFAULT_WIN_SOUND;
  #localSettings = createDefaultMatchSettings();
  #localColorId = PADDLE_CONFIG.DEFAULT_COLOR_ID;
  #remoteColorId = PADDLE_CONFIG.DEFAULT_COLOR_ID;

  constructor() {
    this.#ui = new UIManager({
      onHost: () => this.hostRoom(),
      onJoin: (code) => this.joinRoom(code),
      onLeave: () => this.leaveRoom(),
      onTogglePause: () => this.togglePause(),
      onResetScore: () => this.#resetHostMatch(),
      onToggleMute: () => this.#toggleMute(),
      onVolumeChange: (pct) => this.#setVolume(pct),
      onMatchSettingsChange: (patch) => this.#updateMatchSettings(patch),
      onPaddleColorChange: (colorId) => this.#setPaddleColor(colorId),
      onWinSoundChange: (id) => this.#setWinSound(id),
      onPreviewWinSound: () => this.#previewWinSound(),
      getRoomCode: () => this.#network.roomCode
    });

    this.#renderer = new Renderer(this.#ui.canvas);

    this.#input = new InputController(this.#ui.canvas, {
      onUserGesture: () => this.#audio.unlock(),
      onToggleMute: () => this.#toggleMute(),
      onTogglePause: () => this.togglePause(),
      onPointerMove: (y) => this.#handlePointerPaddle(y)
    });

    this.#initMatchSettings();
    this.#initPaddleColor();
    this.#bindNetworkEvents();
    this.#syncAudioUI();
    this.#syncWinSoundUI();
    this.#syncMatchSettingsUI();
    this.#syncPaddleColorUI();
    this.#syncStatusUI();
  }

  start() {
    const autoCode = getRoomCodeFromUrl();
    if (autoCode) {
      this.#ui.setJoinInput(autoCode);
      this.joinRoom(autoCode);
    }

    this.#lastFrameTime = performance.now();
    const tick = (now) => {
      this.#loop(now);
      this.#rafId = requestAnimationFrame(tick);
    };
    this.#rafId = requestAnimationFrame(tick);
  }

  destroy() {
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    this.#input.destroy();
    this.#network.destroy();
  }

  async hostRoom() {
    this.#audio.unlock();
    await this.#enterRoom(generateRoomCode(), true);
  }

  async joinRoom(code) {
    this.#audio.unlock();
    if (!isValidRoomCode(code)) {
      this.#ui.showJoinError(
        `Please enter a valid room code (at least ${NETWORK_CONFIG.MIN_CODE_LENGTH} characters).`
      );
      return;
    }
    await this.#enterRoom(code, false);
  }

  async leaveRoom() {
    this.#roomTransitionId++;
    this.#state.setSettings(this.#localSettings);
    this.#resetLocalSession();
    await this.#network.disconnect();
    this.#ui.setLobbyView();
    this.#syncMatchSettingsUI();
    this.#syncPaddleColorUI();
    this.#syncStatusUI();
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
      this.#sendSyncState();
    }

    this.#audio.playPause(nextPaused);
    this.#syncStatusUI();
  }

  async #enterRoom(code, isHost) {
    const transitionId = ++this.#roomTransitionId;
    if (isHost) {
      this.#state.setSettings(this.#localSettings);
    }
    this.#resetLocalSession();
    this.#ui.setRoomView(code);
    this.#syncMatchSettingsUI();
    this.#syncPaddleColorUI();
    this.#ui.setStatus(
      isHost ? `Waiting for friend to join ${code}...` : `Connecting to room ${code}...`,
      'waiting'
    );

    try {
      await this.#network.connect(code, isHost);
      if (transitionId !== this.#roomTransitionId) return;
      this.#syncMatchSettingsUI();
      this.#syncPaddleColorUI();
      this.#syncStatusUI();
    } catch {
      if (transitionId !== this.#roomTransitionId) return;
      this.#ui.setStatus('Failed to initialize room connection.', 'error');
    }
  }

  #resetLocalSession() {
    this.#state.resetAll();
    this.#audio.resetHitDeduplication();
    this.#remoteColorId = PADDLE_CONFIG.DEFAULT_COLOR_ID;
    this.#remoteWinSoundId = AUDIO_CONFIG.DEFAULT_WIN_SOUND;
    this.#lastSentPaddleY = null;
    this.#lastPaddleSend = 0;
  }

  #resetHostMatch() {
    if (!this.#network.isHost || !this.#network.connected || this.#network.connectionLost) {
      return;
    }
    this.#state.resetMatch();
    this.#audio.resetHitDeduplication();
    this.#sendServe();
    this.#syncStatusUI();
  }

  #initMatchSettings() {
    let saved = null;
    try {
      const raw = localStorage.getItem(MODE_CONFIG.STORAGE_SETTINGS_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch {
      saved = null;
    }

    this.#localSettings = normalizeMatchSettings(saved || undefined);
    this.#state.setSettings(this.#localSettings);
    this.#state.timeRemaining =
      this.#state.settings.mode === MATCH_MODES.TIMED ? this.#state.settings.timeLimitSec : 0;
  }

  #updateMatchSettings(patch) {
    if (this.#network.inRoom && !this.#network.isHost) return;
    if (!patch || typeof patch !== 'object') return;

    const merged = { ...this.#state.settings, ...patch };
    this.#state.setSettings(merged);
    this.#localSettings = { ...this.#state.settings };

    try {
      localStorage.setItem(MODE_CONFIG.STORAGE_SETTINGS_KEY, JSON.stringify(this.#localSettings));
    } catch {
      // Ignore storage errors
    }

    if (
      !this.#state.matchActive ||
      patch.mode !== undefined ||
      patch.timeLimitSec !== undefined
    ) {
      this.#state.timeRemaining =
        this.#state.settings.mode === MATCH_MODES.TIMED ? this.#state.settings.timeLimitSec : 0;
    }

    this.#syncMatchSettingsUI();

    if (this.#network.connected && this.#network.isHost) {
      this.#sendGameSettings();
      if (this.#state.matchActive && !this.#state.matchOver) {
        this.#checkMatchWinner();
      }
    }
  }

  #syncMatchSettingsUI() {
    this.#ui.updateMatchSettings(this.#state.settings, {
      inRoom: this.#network.inRoom,
      isHost: this.#network.isHost
    });
  }

  #initPaddleColor() {
    let savedId = null;
    try {
      savedId = localStorage.getItem(PADDLE_CONFIG.STORAGE_COLOR_KEY);
    } catch {
      savedId = null;
    }
    this.#localColorId = resolvePaddleColor(savedId).id;
  }

  #setPaddleColor(colorId) {
    const resolved = resolvePaddleColor(colorId);
    this.#localColorId = resolved.id;

    try {
      localStorage.setItem(PADDLE_CONFIG.STORAGE_COLOR_KEY, resolved.id);
    } catch {
      // Ignore storage errors
    }

    this.#syncPaddleColorUI();
    if (this.#network.connected) {
      this.#sendPaddleColor();
    }
  }

  #syncPaddleColorUI() {
    this.#ui.updatePaddleColorControls({
      localColorId: this.#localColorId,
      remoteColorId: this.#remoteColorId,
      connected: this.#network.connected
    });
  }

  #toggleMute() {
    this.#audio.toggleMute();
    this.#syncAudioUI();
  }

  #setVolume(pct) {
    this.#audio.setVolume(pct);
    this.#syncAudioUI();
  }

  #syncAudioUI() {
    this.#ui.updateAudioControls(this.#audio.volumePct, this.#audio.isMuted);
  }

  #setWinSound(id) {
    if (!this.#audio.setWinSound(id)) return;
    this.#syncWinSoundUI();
    if (this.#network.connected) {
      this.#sendWinSound();
    }
  }

  #previewWinSound() {
    this.#audio.unlock();
    this.#audio.previewWinSound();
  }

  #syncWinSoundUI() {
    this.#ui.updateWinSoundControls({
      sounds: this.#audio.winSounds,
      selectedId: this.#audio.selectedWinSoundId
    });
  }

  #handlePointerPaddle(y) {
    if (
      this.#network.inRoom &&
      (
        !this.#network.connected ||
        this.#state.paused ||
        this.#state.matchOver ||
        this.#network.connectionLost
      )
    ) {
      return;
    }
    const isHost = !this.#network.inRoom || this.#network.isHost;
    this.#state.setLocalPaddleY(isHost, y);
  }

  #triggerConnectionLostPause() {
    if (this.#state.matchActive && !this.#state.matchOver) {
      this.#state.setPaused(true, 'lost', '');
    }
    this.#input.resetKeys();
    this.#audio.playDisconnect();
    this.#syncPaddleColorUI();
    this.#syncStatusUI();
  }

  #bindNetworkEvents() {
    this.#network.on('peer-join', () => {
      if (this.#state.matchActive) {
        if (!this.#state.matchOver) {
          this.#state.setPaused(true, 'reconnected', '');
          this.#state.waitingForServe = !this.#network.isHost;
        }
        if (this.#network.isHost) {
          this.#sendGameSettings();
          this.#sendSyncState();
          this.#network.startPingLoop();
        }
      }

      this.#audio.playConnect();
      this.#syncMatchSettingsUI();
      this.#syncPaddleColorUI();
      this.#syncStatusUI();
    });

    this.#network.on('peer-leave', () => {
      this.#state.waitingForServe = false;
      this.#remoteColorId = PADDLE_CONFIG.DEFAULT_COLOR_ID;
      this.#remoteWinSoundId = AUDIO_CONFIG.DEFAULT_WIN_SOUND;
      this.#triggerConnectionLostPause();
    });

    this.#network.on('timeout', () => {
      this.#triggerConnectionLostPause();
    });

    this.#network.on('connection-restored', () => {
      if (this.#state.matchActive && !this.#state.matchOver) {
        this.#state.setPaused(true, 'reconnected', '');
      }
      if (this.#network.isHost) {
        this.#sendGameSettings();
        if (this.#state.matchActive) {
          this.#sendSyncState();
        }
      }
      this.#sendPaddleColor();
      this.#sendWinSound();
      this.#audio.playConnect();
      this.#syncMatchSettingsUI();
      this.#syncPaddleColorUI();
      this.#syncStatusUI();
    });

    this.#network.on('offline', () => {
      if (this.#network.inRoom && this.#state.matchActive && !this.#state.matchOver) {
        this.#network.markConnectionLost();
        this.#triggerConnectionLostPause();
      }
    });

    this.#network.on('online', () => this.#syncStatusUI());

    this.#network.on('rtt-update', (rttMs) => {
      const show = this.#network.connected && !this.#network.connectionLost;
      this.#ui.updatePing(rttMs, show);
    });

    this.#network.on('error', ({ err, peerCount, code }) => {
      if (err.code === 'room-full' && peerCount === 0) {
        this.#ui.setStatus(`Room ${code} is already full (2/2 players).`, 'error');
      } else if (err.code === 'peer-connect-failed') {
        this.#ui.setStatus('Direct WebRTC connection failed (strict NAT/firewall).', 'error');
      } else if (err.code === 'relay-failed') {
        this.#ui.setStatus('Could not reach signaling relays. Check your internet.', 'error');
      }
    });

    this.#network.on('message', ({ msg, userId }) => this.#handleNetworkMessage(msg, userId));
  }

  #handleNetworkMessage(msg, userId) {
    const net = this.#network;
    const state = this.#state;

    switch (msg.t) {
      case MSG_TYPE.HELLO: {
        const wasHost = net.isHost;
        if (msg.host === net.isHost) {
          net.setHostRole(net.myUserId < userId);
        }

        if (net.isHost) {
          net.startPingLoop();
          this.#sendGameSettings();
          if (!state.matchActive || (!wasHost && state.currentRound === 0)) {
            state.resetMatch();
            this.#audio.resetHitDeduplication();
            this.#sendServe();
          } else {
            this.#sendSyncState();
          }
        } else {
          net.stopPingLoop();
          if (!state.matchActive) {
            state.matchActive = true;
            state.waitingForServe = true;
          } else if (wasHost) {
            state.waitingForServe = true;
          }
        }

        this.#sendPaddleColor();
        this.#sendWinSound();
        this.#syncMatchSettingsUI();
        this.#syncPaddleColorUI();
        this.#syncStatusUI();
        return;
      }

      case MSG_TYPE.PADDLE: {
        if (!Number.isFinite(msg.y)) return;
        state.setRemotePaddleY(net.isHost, msg.y);
        return;
      }

      case MSG_TYPE.PADDLE_COLOR: {
        this.#remoteColorId = resolvePaddleColor(msg.colorId).id;
        this.#syncPaddleColorUI();
        return;
      }

      case MSG_TYPE.WIN_SOUND: {
        if (typeof msg.winSoundId === 'string') {
          this.#remoteWinSoundId = msg.winSoundId;
        }
        return;
      }

      case MSG_TYPE.GAME_SETTINGS: {
        if (net.isHost || !msg.settings) return;
        state.setSettings(msg.settings);
        if (Number.isFinite(msg.timeRemaining)) {
          state.timeRemaining = msg.timeRemaining;
        } else if (!state.matchActive) {
          state.timeRemaining =
            state.settings.mode === MATCH_MODES.TIMED ? state.settings.timeLimitSec : 0;
        }
        this.#syncMatchSettingsUI();
        return;
      }

      case MSG_TYPE.PAUSE: {
        if (state.matchOver) return;
        const nextPaused = Boolean(msg.paused);
        if (nextPaused !== state.paused) {
          this.#audio.playPause(nextPaused);
        }
        state.setPaused(nextPaused, msg.reason || 'manual', msg.by || '');
        if (!nextPaused && net.isHost) {
          this.#sendSyncState();
        }
        this.#syncStatusUI();
        return;
      }

      case MSG_TYPE.SYNC_STATE: {
        if (net.isHost) return;
        this.#applySyncState(msg);
        return;
      }

      case MSG_TYPE.SERVE: {
        if (net.isHost) return;
        this.#applyServe(msg);
        return;
      }

      case MSG_TYPE.HIT: {
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

        this.#physics.advanceVisual(state, net.halfRtt);
        state.applyVisualError(oldBx - state.ballX, oldBy - state.ballY);
        return;
      }

      case MSG_TYPE.MISS: {
        if (!net.isHost || state.matchOver || state.paused || msg.round !== state.currentRound) {
          return;
        }
        state.hostScore++;
        this.#audio.playScore(true);
        if (!this.#checkMatchWinner()) {
          state.prepareServe(-1);
          this.#sendServe();
        }
        return;
      }

      case MSG_TYPE.MATCH_OVER: {
        if (net.isHost) return;
        if (Number.isFinite(msg.hs)) state.hostScore = msg.hs;
        if (Number.isFinite(msg.gs)) state.guestScore = msg.gs;
        if (Number.isFinite(msg.timeRemaining)) state.timeRemaining = msg.timeRemaining;
        state.setMatchOver(msg.winner || null);

        const fallbackId =
          msg.winner === 'guest' ? this.#audio.selectedWinSoundId : this.#remoteWinSoundId;
        const winSoundId = typeof msg.winSoundId === 'string' ? msg.winSoundId : fallbackId;
        this.#playMatchOverSound(winSoundId);
        this.#syncStatusUI();
      }
    }
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
      this.#syncMatchSettingsUI();
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

    this.#syncStatusUI();
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

    if (msg.gs > state.guestScore) this.#audio.playScore(true);
    else if (msg.hs > state.hostScore) this.#audio.playScore(false);

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

    this.#syncStatusUI();
  }

  #sendGameSettings() {
    if (!this.#network.isHost || !this.#network.connected) return;
    this.#network.send(MSG_TYPE.GAME_SETTINGS, {
      settings: this.#state.settings,
      timeRemaining: this.#state.timeRemaining
    });
  }

  #sendPaddleColor() {
    if (!this.#network.connected) return;
    this.#network.send(MSG_TYPE.PADDLE_COLOR, { colorId: this.#localColorId });
  }

  #sendWinSound() {
    if (!this.#network.connected) return;
    this.#network.send(MSG_TYPE.WIN_SOUND, { winSoundId: this.#audio.selectedWinSoundId });
  }

  #sendServe() {
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

  #sendSyncState() {
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

  #checkMatchWinner() {
    if (!this.#network.isHost || this.#state.matchOver) return false;
    const winner = evaluateMatchWinner(this.#state, this.#state.settings);
    if (!winner) return false;

    const winSoundId =
      winner === 'host' ? this.#audio.selectedWinSoundId : this.#remoteWinSoundId;

    this.#state.setMatchOver(winner);
    this.#network.send(MSG_TYPE.MATCH_OVER, {
      winner,
      winSoundId,
      hs: this.#state.hostScore,
      gs: this.#state.guestScore,
      timeRemaining: this.#state.timeRemaining
    });
    this.#playMatchOverSound(winSoundId);
    this.#syncStatusUI();
    return true;
  }

  #playMatchOverSound(winSoundId) {
    this.#audio.playMatchWin(winSoundId);
  }

  #syncStatusUI() {
    const net = this.#network;
    const s = this.#state;

    this.#ui.updateMatchControls({
      inRoom: net.inRoom,
      isHost: net.isHost,
      connected: net.connected,
      connectionLost: net.connectionLost,
      matchActive: s.matchActive,
      matchOver: s.matchOver,
      paused: s.paused
    });

    const showPing = net.connected && !net.connectionLost;
    this.#ui.updatePing(net.rttMs, showPing);

    if (!net.inRoom) {
      this.#ui.setStatus('Host a room or join with a code');
      return;
    }

    if (net.connectionLost) {
      const offlineMsg = !navigator.onLine ? 'You are offline' : 'Connection lost';
      this.#ui.setStatus(`${offlineMsg} — Game paused. Waiting in ${net.roomCode}...`, 'error');
    } else if (!net.connected) {
      this.#ui.setStatus(
        net.isHost
          ? `Waiting for friend to join ${net.roomCode}...`
          : `Connecting to room ${net.roomCode}...`,
        'waiting'
      );
    } else if (s.matchOver) {
      const localWon = (net.isHost && s.winner === 'host') || (!net.isHost && s.winner === 'guest');
      this.#ui.setStatus(
        `${net.roomCode} — Match over (${localWon ? 'You won!' : 'Opponent won!'})`,
        'connected'
      );
    } else if (s.paused) {
      const reasonText = s.pauseReason === 'reconnected'
        ? 'Connection restored — Press Space to resume'
        : `Paused by ${s.pausedBy || 'player'} — Press Space to resume`;
      this.#ui.setStatus(`${net.roomCode} — ${reasonText}`, 'paused');
    } else {
      const roleLabel = net.isHost ? 'Left Paddle (Host)' : 'Right Paddle (Guest)';
      this.#ui.setStatus(`Connected in ${net.roomCode} — You are ${roleLabel}`, 'connected');
    }
  }

  #getOverlayState() {
    const net = this.#network;
    const s = this.#state;

    if (!net.inRoom) {
      return {
        title: 'P2P PONG',
        subtitle: 'Host a game or enter a room code above',
        accentColor: '#fff'
      };
    }

    if (net.connectionLost) {
      return {
        title: 'CONNECTION LOST — GAME PAUSED',
        subtitle: !navigator.onLine
          ? 'You are offline. Waiting for internet...'
          : 'Waiting for opponent to reconnect...',
        accentColor: '#eb5757'
      };
    }

    if (!net.connected) {
      return {
        title: net.isHost ? `ROOM CODE: ${net.roomCode}` : `JOINING ${net.roomCode}...`,
        subtitle: net.isHost
          ? 'Waiting for your friend to join...'
          : 'Establishing peer-to-peer connection...',
        accentColor: '#f2c94c'
      };
    }

    if (s.matchOver) {
      const localWon = (net.isHost && s.winner === 'host') || (!net.isHost && s.winner === 'guest');
      return {
        title: localWon ? 'YOU WIN!' : 'YOU LOSE',
        subtitle: net.isHost
          ? `Final Score: ${s.hostScore} – ${s.guestScore} • Click "Play Again" to rematch`
          : `Final Score: ${s.hostScore} – ${s.guestScore} • Waiting for host to start rematch`,
        accentColor: localWon ? '#6fcf97' : '#eb5757'
      };
    }

    if (s.paused) {
      return {
        title: 'PAUSED',
        subtitle: s.pauseReason === 'reconnected'
          ? 'Connection restored — Press SPACE to resume'
          : `Paused by ${s.pausedBy || 'player'} — Press SPACE to resume`,
        accentColor: '#56ccf2'
      };
    }

    return null;
  }

  #getPaddleRenderColors() {
    const localHex = resolvePaddleColor(this.#localColorId).hex;
    const remoteHex = this.#network.inRoom
      ? resolvePaddleColor(this.#remoteColorId).hex
      : resolvePaddleColor(PADDLE_CONFIG.DEFAULT_COLOR_ID).hex;

    const isHost = !this.#network.inRoom || this.#network.isHost;
    return {
      hostColor: isHost ? localHex : remoteHex,
      guestColor: isHost ? remoteHex : localHex
    };
  }

  #loop(now) {
    const dt = Math.min((now - this.#lastFrameTime) / 1000, GAME_CONFIG.MAX_FRAME_DT);
    this.#lastFrameTime = now;

    if (this.#state.matchActive) {
      this.#network.checkTimeout(now);
    }

    const activePlay = (
      this.#network.connected &&
      !this.#state.paused &&
      !this.#network.connectionLost &&
      this.#state.matchActive &&
      !this.#state.matchOver
    );

    if (activePlay) {
      this.#updateSimulation(now, dt);
    }

    const { hostColor, guestColor } = this.#getPaddleRenderColors();
    this.#renderer.render(this.#state, {
      inRoom: this.#network.inRoom,
      isHost: this.#network.isHost,
      hostColor,
      guestColor,
      overlay: this.#getOverlayState()
    });
  }

  #updateSimulation(now, dt) {
    const state = this.#state;
    const net = this.#network;
    const isHost = net.isHost;

    state.moveLocalPaddle(isHost, this.#input.getVerticalDirection(), dt);
    state.decayVisualError(dt);

    // Send local paddle position (~60Hz on movement, 10Hz heartbeat)
    const myY = Math.round(state.getLocalPaddleY(isHost));
    const timeSinceSend = now - this.#lastPaddleSend;
    if (
      timeSinceSend >= NETWORK_CONFIG.PADDLE_SEND_INTERVAL_MS &&
      (myY !== this.#lastSentPaddleY || timeSinceSend >= NETWORK_CONFIG.PADDLE_HEARTBEAT_MS)
    ) {
      this.#lastPaddleSend = now;
      this.#lastSentPaddleY = myY;
      net.send(MSG_TYPE.PADDLE, { y: myY });
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

    // Host fallback if Guest disconnects or drops a miss packet
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
        this.#sendServe();
      }
    }
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
      // Client-side predicted sound before authoritative packet arrives
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
        this.#sendServe();
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