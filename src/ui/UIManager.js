import { MATCH_MODES, PADDLE_COLORS } from '../config/constants.js';
import { formatMatchSummary, resolvePaddleColor } from '../game/MatchSettings.js';
import { copyToClipboard, flashButtonLabel } from '../utils/dom.js';
import { buildInviteUrl, normalizeRoomCode } from '../utils/code.js';

export class UIManager {
  #els;
  #handlers;
  #swatchButtons = new Map();

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
      volumeValue: document.getElementById('volumeValue'),

      // Match settings controls
      hostSettingsControls: document.getElementById('hostSettingsControls'),
      guestSettingsBanner: document.getElementById('guestSettingsBanner'),
      guestRulesSummary: document.getElementById('guestRulesSummary'),
      difficultySelect: document.getElementById('difficultySelect'),
      difficultySpec: document.getElementById('difficultySpec'),
      customDifficultyRow: document.getElementById('customDifficultyRow'),
      customInitialSpeedInput: document.getElementById('customInitialSpeedInput'),
      customMaxSpeedInput: document.getElementById('customMaxSpeedInput'),
      customMultiplierInput: document.getElementById('customMultiplierInput'),
      modeSelect: document.getElementById('modeSelect'),
      targetScoreWrap: document.getElementById('targetScoreWrap'),
      targetScoreInput: document.getElementById('targetScoreInput'),
      timeLimitWrap: document.getElementById('timeLimitWrap'),
      timeLimitSelect: document.getElementById('timeLimitSelect'),

      // Paddle colour controls
      paddleColorPalette: document.getElementById('paddleColorPalette'),
      opponentColorBadge: document.getElementById('opponentColorBadge'),
      opponentColorDot: document.getElementById('opponentColorDot'),
      opponentColorName: document.getElementById('opponentColorName'),

      // Win sound controls
      winSoundSelect: document.getElementById('winSoundSelect'),
      btnPreviewWinSound: document.getElementById('btnPreviewWinSound')
    };

    this.#buildColorSwatches();
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

  updateWinSoundControls({ sounds = [], selectedId } = {}) {
    const select = this.#els.winSoundSelect;
    select.innerHTML = '';

    for (const sound of sounds) {
      if (!sound) continue;
      const opt = document.createElement('option');
      opt.value = sound.id;
      opt.textContent = sound.label;
      select.appendChild(opt);
    }

    if (selectedId != null && Array.from(select.options).some((opt) => opt.value === selectedId)) {
      select.value = selectedId;
    } else if (select.options.length > 0) {
      select.selectedIndex = 0;
    }
  }

  updatePaddleColorControls({ localColorId, remoteColorId, connected }) {
    const selectedId = resolvePaddleColor(localColorId).id;
    for (const [id, btn] of this.#swatchButtons.entries()) {
      const isSelected = id === selectedId;
      btn.classList.toggle('selected', isSelected);
      btn.setAttribute('aria-pressed', String(isSelected));
    }

    this.#els.opponentColorBadge.classList.toggle('hidden', !connected);
    if (connected) {
      const remoteColor = resolvePaddleColor(remoteColorId);
      this.#els.opponentColorDot.style.backgroundColor = remoteColor.hex;
      this.#els.opponentColorName.textContent = remoteColor.label;
    }
  }

  updateMatchSettings(settings, { inRoom, isHost }) {
    const canEdit = !inRoom || isHost;
    this.#els.hostSettingsControls.classList.toggle('hidden', !canEdit);
    this.#els.guestSettingsBanner.classList.toggle('hidden', canEdit);

    if (!canEdit) {
      this.#els.customDifficultyRow.classList.add('hidden');
      this.#els.guestRulesSummary.textContent = formatMatchSummary(settings);
      return;
    }

    this.#els.difficultySelect.value = settings.difficulty;
    this.#els.modeSelect.value = settings.mode;
    this.#els.targetScoreInput.value = String(settings.targetScore);

    // Ensure timeLimitSelect shows current value (even if non-preset)
    const timeVal = String(settings.timeLimitSec);
    if (!Array.from(this.#els.timeLimitSelect.options).some((o) => o.value === timeVal)) {
      const opt = document.createElement('option');
      opt.value = timeVal;
      opt.textContent = `${settings.timeLimitSec}s`;
      this.#els.timeLimitSelect.appendChild(opt);
    }
    this.#els.timeLimitSelect.value = timeVal;

    const isCustom = settings.difficulty === 'custom';
    this.#els.customDifficultyRow.classList.toggle('hidden', !isCustom);
    this.#els.difficultySpec.classList.toggle('hidden', isCustom);
    if (isCustom) {
      this.#els.customInitialSpeedInput.value = String(settings.initialBallSpeed);
      this.#els.customMaxSpeedInput.value = String(settings.maxBallSpeed);
      this.#els.customMultiplierInput.value = settings.speedMultiplier.toFixed(2);
    } else {
      this.#els.difficultySpec.textContent =
        `(Max ${settings.maxBallSpeed} px/s, ${settings.speedMultiplier.toFixed(2)}×)`;
    }

    const usesTarget =
      settings.mode === MATCH_MODES.FIRST_TO || settings.mode === MATCH_MODES.WIN_BY_2;
    const usesTime = settings.mode === MATCH_MODES.TIMED;
    this.#els.targetScoreWrap.classList.toggle('hidden', !usesTarget);
    this.#els.timeLimitWrap.classList.toggle('hidden', !usesTime);
  }

  updatePing(rttMs, visible) {
    this.#els.pingBadge.classList.toggle('hidden', !visible);
    if (visible) {
      this.#els.pingBadge.textContent = `${rttMs} ms`;
    }
  }

  updateMatchControls({ inRoom, isHost, connected, connectionLost, matchActive, matchOver, paused }) {
    this.#els.btnResetScore.classList.toggle('hidden', !connected || !isHost);
    this.#els.btnResetScore.textContent = matchOver ? 'Play Again' : 'Reset Score';
    this.#els.inviteArea.classList.toggle('hidden', !inRoom || !isHost);

    this.#els.btnPause.disabled = !connected || connectionLost || !matchActive || matchOver;
    this.#els.btnPause.textContent = paused ? 'Resume (Space)' : 'Pause (Space)';
  }

  #buildColorSwatches() {
    const container = this.#els.paddleColorPalette;
    container.innerHTML = '';

    for (const color of PADDLE_COLORS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch';
      btn.style.backgroundColor = color.hex;
      btn.title = color.label;
      btn.setAttribute('aria-label', color.label);
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', (e) => {
        e.currentTarget.blur();
        this.#handlers.onPaddleColorChange?.(color.id);
      });
      this.#swatchButtons.set(color.id, btn);
      container.appendChild(btn);
    }
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

    // Match Settings events
    els.difficultySelect.addEventListener('change', (e) => {
      e.currentTarget.blur();
      this.#handlers.onMatchSettingsChange?.({ difficulty: e.currentTarget.value });
    });

    els.modeSelect.addEventListener('change', (e) => {
      e.currentTarget.blur();
      this.#handlers.onMatchSettingsChange?.({ mode: e.currentTarget.value });
    });

    els.timeLimitSelect.addEventListener('change', (e) => {
      e.currentTarget.blur();
      this.#handlers.onMatchSettingsChange?.({ timeLimitSec: Number(e.currentTarget.value) });
    });

    const bindNumericInput = (input, field) => {
      let initialValue = input.value;
      input.addEventListener('focus', () => {
        initialValue = input.value;
      });
      const commit = () => {
        this.#handlers.onMatchSettingsChange?.({ [field]: Number(input.value) });
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (input.value !== initialValue) {
            input.blur();
          } else {
            commit();
            input.blur();
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          input.value = initialValue;
          input.blur();
        }
      });
    };

    bindNumericInput(els.targetScoreInput, 'targetScore');
    bindNumericInput(els.customInitialSpeedInput, 'initialBallSpeed');
    bindNumericInput(els.customMaxSpeedInput, 'maxBallSpeed');
    bindNumericInput(els.customMultiplierInput, 'speedMultiplier');

    // Win sound events
    els.winSoundSelect.addEventListener('change', (e) => {
      e.currentTarget.blur();
      this.#handlers.onWinSoundChange?.(e.currentTarget.value);
    });

    els.btnPreviewWinSound.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#handlers.onPreviewWinSound?.();
    });
  }
}