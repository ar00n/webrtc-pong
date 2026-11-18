import { copyToClipboard, flashButtonLabel } from '../utils/dom.js';
import { buildInviteUrl, normalizeRoomCode } from '../utils/code.js';

export class UIManager {
  #els;
  #handlers;

  constructor(handlers) {
    this.#handlers = handlers;
    this.#els = {
      canvas: document.getElementById('game'),
      status: document.getElementById('status'),
      dot: document.getElementById('dot'),
      pingBadge: document.getElementById('pingBadge'),
      lobbyBox: document.getElementById('lobbyBox'),
      lobbyError: document.getElementById('lobbyError'),
      roomBox: document.getElementById('roomBox'),
      inviteArea: document.getElementById('inviteArea'),
      joinCodeInput: document.getElementById('joinCodeInput'),
      roomCodeDisplay: document.getElementById('roomCodeDisplay'),
      btnHost: document.getElementById('btnHost'),
      btnJoin: document.getElementById('btnJoin'),
      btnCopyCode: document.getElementById('btnCopyCode'),
      btnCopyLink: document.getElementById('btnCopyLink'),
      btnPause: document.getElementById('btnPause'),
      btnResetScore: document.getElementById('btnResetScore'),
      btnLeave: document.getElementById('btnLeave'),
      btnMute: document.getElementById('btnMute'),
      volumeSlider: document.getElementById('volumeSlider'),
      volumeValue: document.getElementById('volumeValue')
    };

    this.#bindEvents();
  }

  get canvas() {
    return this.#els.canvas;
  }

  setLobbyView() {
    this.#els.roomBox.classList.add('hidden');
    this.#els.lobbyBox.classList.remove('hidden');
  }

  setRoomView(code) {
    this.clearJoinError();
    this.#els.roomCodeDisplay.textContent = code;
    this.#els.lobbyBox.classList.add('hidden');
    this.#els.roomBox.classList.remove('hidden');
  }

  setJoinInput(code) {
    this.#els.joinCodeInput.value = code;
  }

  showJoinError(message) {
    this.#els.lobbyError.textContent = message;
    this.#els.lobbyError.classList.remove('hidden');
  }

  clearJoinError() {
    this.#els.lobbyError.textContent = '';
    this.#els.lobbyError.classList.add('hidden');
  }

  setStatus(message, mode = '') {
    this.#els.status.textContent = message;
    this.#els.dot.className = 'dot' + (mode ? ` ${mode}` : '');
  }

  updateAudioControls(volumePct, isMuted) {
    this.#els.volumeSlider.value = String(volumePct);
    this.#els.volumeValue.textContent = isMuted ? 'Muted' : `${volumePct}%`;
    this.#els.btnMute.textContent = (isMuted || volumePct === 0)
      ? 'Sound: Off (M)'
      : 'Sound: On (M)';
  }

  updatePing(rttMs, visible) {
    this.#els.pingBadge.classList.toggle('hidden', !visible);
    if (visible) {
      this.#els.pingBadge.textContent = `${rttMs} ms`;
    }
  }

  updateMatchControls({ inRoom, isHost, connected, connectionLost, matchActive, paused }) {
    const canPlay = connected && !paused && !connectionLost && matchActive;
    this.#els.canvas.classList.toggle('playing', canPlay);

    this.#els.btnResetScore.classList.toggle('hidden', !connected || !isHost);
    this.#els.inviteArea.classList.toggle('hidden', !inRoom || !isHost);

    this.#els.btnPause.disabled = !connected || connectionLost || !matchActive;
    this.#els.btnPause.textContent = paused ? 'Resume (Space)' : 'Pause (Space)';

    this.updatePing(null, false);
  }

  setPlayingCursor(active) {
    this.#els.canvas.classList.toggle('playing', active);
  }

  #bindEvents() {
    const els = this.#els;

    els.btnHost.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#handlers.onHost();
    });

    const submitJoin = () => {
      const normalized = normalizeRoomCode(els.joinCodeInput.value);
      els.joinCodeInput.value = normalized;
      this.#handlers.onJoin(normalized);
    };

    els.btnJoin.addEventListener('click', (e) => {
      e.currentTarget.blur();
      submitJoin();
    });

    els.joinCodeInput.addEventListener('input', () => this.clearJoinError());
    els.joinCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        els.joinCodeInput.blur();
        submitJoin();
      }
    });

    els.btnPause.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#handlers.onTogglePause();
    });

    els.btnLeave.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#handlers.onLeave();
    });

    els.btnResetScore.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#handlers.onResetScore();
    });

    els.btnCopyCode.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.blur();
      const ok = await copyToClipboard(this.#handlers.getRoomCode());
      flashButtonLabel(btn, ok ? 'Copied!' : 'Copy Failed');
    });

    els.btnCopyLink.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.blur();
      const url = buildInviteUrl(this.#handlers.getRoomCode());
      const ok = await copyToClipboard(url);
      flashButtonLabel(btn, ok ? 'Link Copied!' : 'Copy Failed');
    });

    els.btnMute.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#handlers.onToggleMute();
    });

    els.volumeSlider.addEventListener('input', () => {
      this.#handlers.onVolumeChange(Number(els.volumeSlider.value));
    });
    els.volumeSlider.addEventListener('change', (e) => e.currentTarget.blur());
    els.volumeSlider.addEventListener('pointerup', (e) => e.currentTarget.blur());
  }
}
