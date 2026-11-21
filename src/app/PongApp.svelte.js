import { AudioEngine } from '../audio/AudioEngine.js';
import { AUDIO_CONFIG, GAME_CONFIG, PADDLE_CONFIG } from '../config/constants.js';
import { GameController } from '../game/GameController.js';
import {
  deriveOverlayPresentation,
  deriveStatusPresentation
} from '../game/MatchOverlayPresenter.js';
import { createDefaultMatchSettings, resolvePaddleColor } from '../game/MatchSettings.js';
import { Renderer } from '../game/Renderer.js';
import { generateMatchId } from '../identity/IdentityCrypto.js';
import { PeerTrustSession } from '../identity/PeerTrustSession.js';
import { InputController } from '../input/InputController.js';
import { NetworkManager } from '../network/NetworkManager.js';
import { MSG_TYPE } from '../network/protocol.js';
import { generateRoomCode, getRoomCodeFromUrl, isValidRoomCode } from '../utils/code.js';
import { PreferencesStore } from './PreferencesStore.js';

export class PongApp {
  #audio = new AudioEngine();
  #preferences = new PreferencesStore();
  #network = new NetworkManager();
  #trustSession = new PeerTrustSession(this.#network);
  #game = new GameController({
    network: this.#network,
    audio: this.#audio,
    createMatchId: generateMatchId
  });

  #renderer = null;
  #input = null;
  #rafId = null;
  #lastFrameTime = 0;
  #roomTransitionId = 0;
  #remoteColorId = PADDLE_CONFIG.DEFAULT_COLOR_ID;

  ui = $state({
    inRoom: false,
    roomCode: '',
    isHost: false,
    connected: false,
    connectionLost: false,
    rttMs: 0,
    showPing: false,
    statusMessage: 'Host a room or join with a code',
    statusMode: '',
    joinCode: '',
    joinError: '',

    matchActive: false,
    matchOver: false,
    winner: null,
    paused: false,
    localReady: false,
    remoteReady: false,

    settings: createDefaultMatchSettings(),
    localColorId: PADDLE_CONFIG.DEFAULT_COLOR_ID,
    remoteColorId: PADDLE_CONFIG.DEFAULT_COLOR_ID,

    volumePct: AUDIO_CONFIG.DEFAULT_VOLUME,
    isMuted: false,
    winSounds: [],
    selectedWinSoundId: AUDIO_CONFIG.DEFAULT_WIN_SOUND,

    identity: this.#trustSession.getIdentitySnapshot(),
    opponent: null
  });

  constructor() {
    this.#game.resetSession(this.#preferences.matchSettings);
    this.#bindEvents();
    this.#syncAudioUI();
    this.#syncWinSoundUI();
    this.#syncPaddleColorUI();
    this.#syncGameAndStatusUI();
    this.#trustSession.init();
  }

  mount(canvas) {
    if (!canvas) return () => {};

    this.#renderer = new Renderer(canvas);
    this.#input = new InputController(canvas, {
      onUserGesture: () => this.#audio.unlock(),
      onToggleMute: () => this.toggleMute(),
      onSpacePress: () => this.#game.handleSpacePress(),
      onPointerMove: (y) => this.#game.handlePointerPaddle(y)
    });

    const autoCode = getRoomCodeFromUrl();
    if (autoCode) {
      this.ui.joinCode = autoCode;
      this.joinRoom(autoCode);
    }

    this.#lastFrameTime = performance.now();
    const tick = (now) => {
      this.#loop(now);
      this.#rafId = requestAnimationFrame(tick);
    };
    this.#rafId = requestAnimationFrame(tick);

    return () => {
      if (this.#rafId !== null) {
        cancelAnimationFrame(this.#rafId);
        this.#rafId = null;
      }
      this.#input?.destroy();
      this.#input = null;
      this.#renderer = null;
    };
  }

  destroy() {
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    this.#input?.destroy();
    this.#input = null;
    this.#network.destroy();
    this.#game.clear();
    this.#trustSession.clear();
  }

  // --- Room Lifecycle ---

  async hostRoom() {
    this.#audio.unlock();
    await this.#enterRoom(generateRoomCode(), true);
  }

  async joinRoom(code) {
    this.#audio.unlock();
    if (!isValidRoomCode(code)) {
      this.ui.joinError = `Please enter a valid room code (at least ${3} characters).`;
      return;
    }
    await this.#enterRoom(code, false);
  }

  clearJoinError() {
    this.ui.joinError = '';
  }

  async leaveRoom() {
    this.#roomTransitionId++;
    this.#resetLocalSession();
    await this.#network.disconnect();
    this.#syncPaddleColorUI();
    this.#syncOpponentUI();
    this.#syncGameAndStatusUI();
  }

  // --- Gameplay Commands ---

  toggleReady() {
    this.#game.toggleReady();
  }

  togglePause() {
    this.#game.togglePause();
  }

  resetHostMatch() {
    this.#game.resetHostMatch();
  }

  updateMatchSettings(patch) {
    if (!patch || typeof patch !== 'object') return;
    this.#game.applySettings(patch, {
      persist: (settings) => this.#preferences.saveMatchSettings(settings)
    });
  }

  // --- Audio & Cosmetics ---

  toggleMute() {
    this.#audio.toggleMute();
    this.#syncAudioUI();
  }

  setVolume(pct) {
    this.#audio.setVolume(pct);
    this.#syncAudioUI();
  }

  setWinSound(id) {
    if (!this.#audio.setWinSound(id)) return;
    this.#syncWinSoundUI();
    if (this.#network.connected) {
      this.#sendWinSound();
    }
  }

  previewWinSound() {
    this.#audio.unlock();
    this.#audio.previewWinSound();
  }

  setPaddleColor(colorId) {
    this.#preferences.savePaddleColor(colorId);
    this.#syncPaddleColorUI();
    if (this.#network.connected) {
      this.#sendPaddleColor();
    }
  }

  // --- Identity & Trust Commands ---

  setNickname(rawName) {
    return this.#trustSession.setNickname(rawName);
  }

  toggleTrustOpponent() {
    return this.#trustSession.toggleTrustOpponent();
  }

  untrustAnchor(playerId) {
    return this.#trustSession.untrustAnchor(playerId);
  }

  exportIdentity() {
    return this.#trustSession.exportIdentity();
  }

  importIdentityBackup(rawJson) {
    return this.#trustSession.importIdentityBackup(rawJson);
  }

  // --- Internal Wiring & Loop ---

  async #enterRoom(code, isHost) {
    const transitionId = ++this.#roomTransitionId;
    this.#resetLocalSession();
    this.ui.joinError = '';
    this.ui.inRoom = true;
    this.ui.roomCode = code;
    this.ui.isHost = isHost;
    this.#syncPaddleColorUI();
    this.#syncOpponentUI();
    this.#setStatus(
      isHost ? `Waiting for friend to join ${code}...` : `Connecting to room ${code}...`,
      'waiting'
    );

    try {
      await this.#network.connect(code, isHost);
      if (transitionId !== this.#roomTransitionId) return;
      this.#syncPaddleColorUI();
      this.#syncOpponentUI();
      this.#syncGameAndStatusUI();
    } catch {
      if (transitionId !== this.#roomTransitionId) return;
      this.#resetLocalSession();
      this.ui.inRoom = false;
      this.ui.roomCode = '';
      this.ui.joinError = 'Failed to initialize room connection.';
      this.#setStatus('Failed to initialize room connection.', 'error');
    }
  }

  #resetLocalSession() {
    this.#remoteColorId = PADDLE_CONFIG.DEFAULT_COLOR_ID;
    this.#game.resetSession(this.#preferences.matchSettings);
    this.#trustSession.reset();
  }

  #bindEvents() {
    this.#trustSession.on('identity-change', (snapshot) => {
      this.ui.identity = snapshot;
    });

    this.#trustSession.on('opponent-change', (snapshot) => {
      this.ui.opponent = snapshot;
    });

    this.#game.on('change', () => {
      this.#syncGameAndStatusUI();
    });

    this.#game.on('match-over', (summary) => {
      this.#trustSession.onMatchOver(summary);
    });

    this.#network.on('peer-join', () => {
      this.#game.handlePeerJoin();
    });

    this.#network.on('peer-leave', () => {
      this.#remoteColorId = PADDLE_CONFIG.DEFAULT_COLOR_ID;
      this.#trustSession.reset();
      this.#input?.resetKeys();
      this.#game.handlePeerLeave();
      this.#syncPaddleColorUI();
      this.#syncOpponentUI();
    });

    this.#network.on('timeout', () => {
      this.#input?.resetKeys();
      this.#game.handleConnectionLostPause();
      this.#syncOpponentUI();
    });

    this.#network.on('connection-restored', () => {
      this.#game.handleConnectionRestored();
      this.#sendPaddleColor();
      this.#sendWinSound();
      this.#syncPaddleColorUI();
      this.#syncOpponentUI();
    });

    this.#network.on('offline', () => {
      if (this.#network.inRoom && this.#game.state.matchActive && !this.#game.state.matchOver) {
        this.#network.markConnectionLost();
        this.#input?.resetKeys();
        this.#game.handleConnectionLostPause();
      }
    });

    this.#network.on('online', () => this.#syncGameAndStatusUI());

    this.#network.on('rtt-update', (rttMs) => {
      this.ui.rttMs = rttMs;
      this.ui.showPing = this.#network.connected && !this.#network.connectionLost;
    });

    this.#network.on('error', ({ err, peerCount, code }) => {
      if (err.code === 'room-full' && peerCount === 0) {
        this.#setStatus(`Room ${code} is already full (2/2 players).`, 'error');
      } else if (err.code === 'peer-connect-failed') {
        this.#setStatus('Direct WebRTC connection failed (strict NAT/firewall).', 'error');
      } else if (err.code === 'relay-failed') {
        this.#setStatus('Could not reach signaling relays. Check your internet.', 'error');
      }
    });

    this.#network.on('message', ({ msg, userId }) => this.#handleNetworkMessage(msg, userId));
  }

  #handleNetworkMessage(msg, userId) {
    if (msg.t === MSG_TYPE.HELLO) {
      const wasHost = this.#network.isHost;
      if (msg.host === this.#network.isHost) {
        this.#network.setHostRole(this.#network.myUserId < userId);
      }
      this.#game.syncAfterHello(wasHost);
      this.#sendPaddleColor();
      this.#sendWinSound();
      this.#trustSession.startAuth();
      this.#syncPaddleColorUI();
      this.#syncGameAndStatusUI();
      return;
    }

    if (msg.t === MSG_TYPE.PADDLE_COLOR) {
      this.#remoteColorId = resolvePaddleColor(msg.colorId).id;
      this.#syncPaddleColorUI();
      return;
    }

    if (this.#trustSession.handleMessage(msg)) return;
    this.#game.handleMessage(msg);
  }

  #sendPaddleColor() {
    if (!this.#network.connected) return;
    this.#network.send(MSG_TYPE.PADDLE_COLOR, { colorId: this.#preferences.paddleColorId });
  }

  #sendWinSound() {
    if (!this.#network.connected) return;
    this.#network.send(MSG_TYPE.WIN_SOUND, { winSoundId: this.#audio.selectedWinSoundId });
  }

  #syncAudioUI() {
    this.ui.volumePct = this.#audio.volumePct;
    this.ui.isMuted = this.#audio.isMuted;
  }

  #syncWinSoundUI() {
    this.ui.winSounds = this.#audio.winSounds;
    this.ui.selectedWinSoundId = this.#audio.selectedWinSoundId;
  }

  #syncPaddleColorUI() {
    this.ui.localColorId = this.#preferences.paddleColorId;
    this.ui.remoteColorId = this.#remoteColorId;
  }

  #syncOpponentUI() {
    this.ui.opponent = this.#trustSession.getOpponentSnapshot();
  }

  #setStatus(message, mode = '') {
    this.ui.statusMessage = message;
    this.ui.statusMode = mode;
  }

  #syncGameAndStatusUI() {
    const net = this.#network;
    const s = this.#game.state;

    this.ui.inRoom = net.inRoom;
    this.ui.roomCode = net.roomCode;
    this.ui.isHost = net.isHost;
    this.ui.connected = net.connected;
    this.ui.connectionLost = net.connectionLost;
    this.ui.matchActive = s.matchActive;
    this.ui.matchOver = s.matchOver;
    this.ui.winner = s.winner;
    this.ui.paused = s.paused;
    this.ui.localReady = this.#game.localReady;
    this.ui.remoteReady = this.#game.remoteReady;
    this.ui.settings = { ...s.settings };
    this.ui.rttMs = net.rttMs;
    this.ui.showPing = net.connected && !net.connectionLost;

    const status = deriveStatusPresentation({
      inRoom: net.inRoom,
      roomCode: net.roomCode,
      isHost: net.isHost,
      connected: net.connected,
      connectionLost: net.connectionLost,
      state: s,
      localReady: this.#game.localReady,
      remoteReady: this.#game.remoteReady
    });
    this.#setStatus(status.message, status.mode);
  }

  #getPaddleRenderColors() {
    const localHex = resolvePaddleColor(this.#preferences.paddleColorId).hex;
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

    this.#game.stepFrame(now, dt, this.#input?.getVerticalDirection() ?? 0);

    if (this.#renderer) {
      const { hostColor, guestColor } = this.#getPaddleRenderColors();
      const overlay = deriveOverlayPresentation({
        inRoom: this.#network.inRoom,
        roomCode: this.#network.roomCode,
        isHost: this.#network.isHost,
        connected: this.#network.connected,
        connectionLost: this.#network.connectionLost,
        state: this.#game.state,
        localReady: this.#game.localReady,
        remoteReady: this.#game.remoteReady
      });

      this.#renderer.render(this.#game.state, {
        inRoom: this.#network.inRoom,
        isHost: this.#network.isHost,
        hostColor,
        guestColor,
        overlay
      });
    }
  }
}
