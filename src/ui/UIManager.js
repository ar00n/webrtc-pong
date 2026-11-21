import { MATCH_MODES, PADDLE_COLORS } from '../config/constants.js';
import { formatMatchSummary, resolvePaddleColor } from '../game/MatchSettings.js';
import { formatPlayerTag } from '../identity/IdentityCrypto.js';
import { buildInviteUrl, normalizeRoomCode } from '../utils/code.js';
import { copyToClipboard, flashButtonLabel } from '../utils/dom.js';

export class UIManager {
  #els;
  #handlers;
  #swatchButtons = new Map();
  #activeTab = 'mine';
  #openDropdownId = null;
  #identitySnapshot = {
    myPlayerId: '',
    nickname: 'Player',
    displayTag: 'Player#------',
    myStats: { wins: 0, losses: 0, draws: 0, total: 0 },
    myReceipts: [],
    trustedAnchors: [],
    vouchedFriends: []
  };
  #opponentSnapshot = null;

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
      readyBar: document.getElementById('readyBar'),
      localReadyPill: document.getElementById('localReadyPill'),
      remoteReadyPill: document.getElementById('remoteReadyPill'),
      btnReady: document.getElementById('btnReady'),
      btnMute: document.getElementById('btnMute'),
      volumeSlider: document.getElementById('volumeSlider'),
      volumeValue: document.getElementById('volumeValue'),

      // Dropdown toolbar & summary indicators
      rulesSummaryText: document.getElementById('rulesSummaryText'),
      localColorDot: document.getElementById('localColorDot'),
      remoteColorMini: document.getElementById('remoteColorMini'),
      dropdownTriggers: Array.from(document.querySelectorAll('[data-dropdown-target]')),
      dropdownPopovers: Array.from(document.querySelectorAll('.dropdown-popover')),
      dropdownCloseBtns: Array.from(document.querySelectorAll('[data-close-dropdown]')),

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
      btnPreviewWinSound: document.getElementById('btnPreviewWinSound'),

      // Identity, Web of Trust & History controls
      myIdentityBadge: document.getElementById('myIdentityBadge'),
      myRecordBadge: document.getElementById('myRecordBadge'),
      nicknameInput: document.getElementById('nicknameInput'),
      btnSaveNickname: document.getElementById('btnSaveNickname'),
      btnToggleLedger: document.getElementById('btnToggleLedger'),
      btnBackupIdentity: document.getElementById('btnBackupIdentity'),
      backupPanel: document.getElementById('backupPanel'),
      btnDownloadBackup: document.getElementById('btnDownloadBackup'),
      btnCopyBackup: document.getElementById('btnCopyBackup'),
      importBackupInput: document.getElementById('importBackupInput'),
      btnImportBackup: document.getElementById('btnImportBackup'),
      backupFeedback: document.getElementById('backupFeedback'),

      opponentIdentityBar: document.getElementById('opponentIdentityBar'),
      opponentNameBadge: document.getElementById('opponentNameBadge'),
      opponentTrustBadge: document.getElementById('opponentTrustBadge'),
      btnTrustOpponent: document.getElementById('btnTrustOpponent'),
      opponentRecordSummary: document.getElementById('opponentRecordSummary'),
      btnViewOpponentHistory: document.getElementById('btnViewOpponentHistory'),

      ledgerPanel: document.getElementById('ledgerPanel'),
      tabMyHistory: document.getElementById('tabMyHistory'),
      tabOpponentHistory: document.getElementById('tabOpponentHistory'),
      tabTrustGraph: document.getElementById('tabTrustGraph'),
      ledgerContent: document.getElementById('ledgerContent')
    };

    this.#buildColorSwatches();
    this.#bindEvents();
  }

  get canvas() {
    return this.#els.canvas;
  }

  setLobbyView() {
    this.#closeAllDropdowns();
    this.#els.roomBox.classList.add('hidden');
    this.#els.lobbyBox.classList.remove('hidden');
  }

  setRoomView(code) {
    this.clearJoinError();
    this.#closeAllDropdowns();
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

  updateIdentityControls(snapshot) {
    this.#identitySnapshot = snapshot;
    this.#els.myIdentityBadge.textContent = snapshot.displayTag;
    this.#els.myIdentityBadge.title = snapshot.displayTag;
    if (this.#els.myRecordBadge) {
      this.#els.myRecordBadge.textContent = fmtRecord(snapshot.myStats);
    }
    if (document.activeElement !== this.#els.nicknameInput) {
      this.#els.nicknameInput.value = snapshot.nickname;
    }
    this.#els.btnToggleLedger.textContent = `History (${snapshot.myReceipts.length})`;
    this.#renderLedger();
  }

  updateOpponentIdentity(snapshot) {
    this.#opponentSnapshot = snapshot;
    const bar = this.#els.opponentIdentityBar;

    if (!snapshot) {
      bar.classList.add('hidden');
      this.#els.tabOpponentHistory.classList.add('hidden');
      if (this.#activeTab === 'opponent') {
        this.#setActiveTab('mine');
      }
      this.#renderLedger();
      return;
    }

    bar.classList.remove('hidden');

    if (snapshot.verifying) {
      this.#els.opponentNameBadge.textContent = 'Verifying opponent key...';
      this.#els.opponentTrustBadge.textContent = 'Checking';
      this.#els.opponentTrustBadge.className = 'trust-pill neutral';
      this.#els.btnTrustOpponent.classList.add('hidden');
      this.#els.btnViewOpponentHistory.classList.add('hidden');
      this.#els.opponentRecordSummary.textContent = '';
      this.#els.tabOpponentHistory.classList.add('hidden');
      this.#renderLedger();
      return;
    }

    const { peer, isTrustedAnchor, trustInfo, historySummary } = snapshot;
    this.#els.opponentNameBadge.textContent = peer.displayTag;
    this.#els.opponentTrustBadge.textContent = trustInfo.label;
    this.#els.opponentTrustBadge.className = `trust-pill ${trustInfo.trusted ? 'trusted' : 'unknown'}`;

    this.#els.btnTrustOpponent.classList.remove('hidden');
    this.#els.btnTrustOpponent.textContent = isTrustedAnchor ? '★ Trusted Friend' : '☆ Trust Friend';
    this.#els.btnTrustOpponent.classList.toggle('active', isTrustedAnchor);

    const { trusted, all, untrustedCount } = historySummary;
    if (all.total === 0) {
      this.#els.opponentRecordSummary.textContent = 'Record: 0W–0L';
      this.#els.opponentRecordSummary.title = 'No signed matches recorded yet.';
    } else if (untrustedCount === 0) {
      this.#els.opponentRecordSummary.textContent = `Record: ${fmtRecord(trusted)}`;
      this.#els.opponentRecordSummary.title =
        'All signed matches are against you or players in your Web of Trust.';
    } else {
      this.#els.opponentRecordSummary.textContent =
        `Known Record: ${fmtRecord(trusted)} (+${untrustedCount} vs strangers)`;
      this.#els.opponentRecordSummary.title =
        `${fmtRecord(trusted)} against you or your Web of Trust; ${untrustedCount} additional signed match(es) against unknown players.`;
    }

    this.#els.btnViewOpponentHistory.classList.remove('hidden');
    this.#els.btnViewOpponentHistory.textContent = `Matches (${all.total})`;
    this.#els.tabOpponentHistory.classList.remove('hidden');
    this.#els.tabOpponentHistory.textContent = `Opponent (${all.total})`;

    this.#renderLedger();
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
    const localColor = resolvePaddleColor(localColorId);
    const selectedId = localColor.id;
    for (const [id, btn] of this.#swatchButtons.entries()) {
      const isSelected = id === selectedId;
      btn.classList.toggle('selected', isSelected);
      btn.setAttribute('aria-pressed', String(isSelected));
    }

    if (this.#els.localColorDot) {
      this.#els.localColorDot.style.backgroundColor = localColor.hex;
    }

    this.#els.opponentColorBadge.classList.toggle('hidden', !connected);
    if (this.#els.remoteColorMini) {
      this.#els.remoteColorMini.classList.toggle('hidden', !connected);
    }

    if (connected) {
      const remoteColor = resolvePaddleColor(remoteColorId);
      this.#els.opponentColorDot.style.backgroundColor = remoteColor.hex;
      this.#els.opponentColorName.textContent = remoteColor.label;
      if (this.#els.remoteColorMini) {
        this.#els.remoteColorMini.style.backgroundColor = remoteColor.hex;
      }
    }
  }

  updateMatchSettings(settings, { inRoom, isHost }) {
    const summary = formatMatchSummary(settings);
    if (this.#els.rulesSummaryText) {
      this.#els.rulesSummaryText.textContent = summary;
    }

    const canEdit = !inRoom || isHost;
    this.#els.hostSettingsControls.classList.toggle('hidden', !canEdit);
    this.#els.guestSettingsBanner.classList.toggle('hidden', canEdit);

    if (!canEdit) {
      this.#els.customDifficultyRow.classList.add('hidden');
      this.#els.guestRulesSummary.textContent = summary;
      return;
    }

    this.#els.difficultySelect.value = settings.difficulty;
    this.#els.modeSelect.value = settings.mode;
    this.#els.targetScoreInput.value = String(settings.targetScore);

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

  updateMatchControls({
    inRoom,
    isHost,
    connected,
    connectionLost,
    matchActive,
    matchOver,
    paused,
    localReady = false,
    remoteReady = false
  }) {
    const canMidMatchReset = connected && !connectionLost && isHost && matchActive && !matchOver;
    this.#els.btnResetScore.classList.toggle('hidden', !canMidMatchReset);
    this.#els.btnResetScore.textContent = 'Reset Score';
    this.#els.inviteArea.classList.toggle('hidden', !inRoom || !isHost);

    this.#els.btnPause.disabled = !connected || connectionLost || !matchActive || matchOver;
    this.#els.btnPause.textContent = paused ? 'Resume (Space)' : 'Pause (Space)';

    const showReadyBar = inRoom && connected && !connectionLost && (!matchActive || matchOver);
    this.#els.readyBar.classList.toggle('hidden', !showReadyBar);

    if (showReadyBar) {
      this.#els.localReadyPill.textContent = localReady ? 'You: Ready ✓' : 'You: Not Ready';
      this.#els.localReadyPill.classList.toggle('ready', localReady);

      this.#els.remoteReadyPill.textContent = remoteReady ? 'Opponent: Ready ✓' : 'Opponent: Not Ready';
      this.#els.remoteReadyPill.classList.toggle('ready', remoteReady);

      this.#els.btnReady.disabled = false;
      this.#els.btnReady.classList.toggle('is-ready', localReady);
      if (localReady) {
        this.#els.btnReady.textContent = 'Ready ✓ (Cancel)';
      } else {
        this.#els.btnReady.textContent = matchOver ? 'Play Again (Ready)' : 'Ready Up';
      }
    } else {
      this.#els.btnReady.disabled = true;
    }
  }

  #toggleDropdown(targetId) {
    const nextId = this.#openDropdownId === targetId ? null : targetId;
    this.#openDropdownId = nextId;

    for (const popover of this.#els.dropdownPopovers) {
      popover.classList.toggle('hidden', popover.id !== nextId);
    }
    for (const trigger of this.#els.dropdownTriggers) {
      const isOpen = trigger.dataset.dropdownTarget === nextId;
      trigger.setAttribute('aria-expanded', String(isOpen));
    }
  }

  #closeAllDropdowns() {
    if (!this.#openDropdownId) return;
    this.#openDropdownId = null;
    for (const popover of this.#els.dropdownPopovers) {
      popover.classList.add('hidden');
    }
    for (const trigger of this.#els.dropdownTriggers) {
      trigger.setAttribute('aria-expanded', 'false');
    }
  }

  #setActiveTab(tab) {
    this.#activeTab = tab;
    this.#els.tabMyHistory.classList.toggle('active', tab === 'mine');
    this.#els.tabOpponentHistory.classList.toggle('active', tab === 'opponent');
    this.#els.tabTrustGraph.classList.toggle('active', tab === 'trust');
    this.#renderLedger();
  }

  #renderLedger() {
    if (this.#els.ledgerPanel.classList.contains('hidden')) return;
    const container = this.#els.ledgerContent;
    container.innerHTML = '';

    if (this.#activeTab === 'mine') {
      this.#renderMyReceipts(container);
    } else if (this.#activeTab === 'opponent') {
      this.#renderOpponentReceipts(container);
    } else {
      this.#renderTrustGraph(container);
    }
  }

  #renderMyReceipts(container) {
    const receipts = this.#identitySnapshot.myReceipts;
    if (receipts.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'status';
      empty.textContent = 'No mutually signed matches yet. Finish a match to record a dual-signed receipt.';
      container.appendChild(empty);
      return;
    }

    const myId = this.#identitySnapshot.myPlayerId;
    const anchorIds = new Set(this.#identitySnapshot.trustedAnchors.map((a) => a.playerId));

    for (const r of receipts) {
      const p = r.parsed;
      const iWasHost = p.host.id === myId;
      const opponent = iWasHost ? p.guest : p.host;
      const myScore = iWasHost ? p.hostScore : p.guestScore;
      const oppScore = iWasHost ? p.guestScore : p.hostScore;
      const iWon = (iWasHost && p.winner === 'host') || (!iWasHost && p.winner === 'guest');

      const row = document.createElement('div');
      row.className = 'ledger-row';

      const main = document.createElement('div');
      main.className = 'ledger-row-main';

      const title = document.createElement('strong');
      title.textContent = `${p.winner === 'draw' ? 'DRAW' : iWon ? 'WIN' : 'LOSS'} ${myScore}–${oppScore} vs ${formatPlayerTag(opponent.nickname, opponent.id)}`;
      title.className = p.winner === 'draw' ? '' : iWon ? 'win-text' : 'loss-text';

      const meta = document.createElement('span');
      meta.className = 'ledger-meta';
      const dateStr = new Date(p.timestamp).toLocaleString();
      const modeStr = p.settings?.mode || 'match';
      meta.textContent = `${dateStr} • ${modeStr} • Dual-Signed`;

      main.append(title, meta);

      const badge = document.createElement('span');
      badge.className = `trust-pill ${anchorIds.has(opponent.id) ? 'trusted' : 'neutral'}`;
      badge.textContent = anchorIds.has(opponent.id) ? 'Trusted Friend' : 'Signed Receipt';

      row.append(main, badge);
      container.appendChild(row);
    }
  }

  #renderOpponentReceipts(container) {
    const snap = this.#opponentSnapshot;
    if (!snap || snap.verifying) {
      const msg = document.createElement('p');
      msg.className = 'status';
      msg.textContent = 'Connect and authenticate with an opponent to view their signed history.';
      container.appendChild(msg);
      return;
    }

    const { peer, historySummary } = snap;
    const { trusted, untrustedCount, items } = historySummary;
    const summaryBanner = document.createElement('div');
    summaryBanner.className = 'ledger-summary';
    summaryBanner.textContent = untrustedCount === 0
      ? `${peer.displayTag} — Record: ${fmtRecord(trusted)} (all in your Web of Trust)`
      : `${peer.displayTag} — Known Record: ${fmtRecord(trusted)} • +${untrustedCount} dual-signed vs strangers`;
    container.appendChild(summaryBanner);

    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'status';
      empty.textContent = 'This opponent has not shared any signed match receipts yet.';
      container.appendChild(empty);
      return;
    }

    for (const item of items) {
      const p = item.receipt.parsed;
      const row = document.createElement('div');
      row.className = 'ledger-row';

      const main = document.createElement('div');
      main.className = 'ledger-row-main';

      const title = document.createElement('strong');
      const outcome = item.isDraw ? 'DREW' : item.peerWon ? 'BEAT' : 'LOST TO';
      title.textContent = `${peer.displayTag} ${outcome} ${item.classification.otherTag} (${item.myScore}–${item.oppScore})`;
      title.className = item.isDraw ? '' : item.peerWon ? 'win-text' : 'loss-text';

      const meta = document.createElement('span');
      meta.className = 'ledger-meta';
      meta.textContent = `${new Date(p.timestamp).toLocaleString()} • Both signatures verified`;

      main.append(title, meta);

      const badge = document.createElement('span');
      badge.className = `trust-pill ${item.classification.trusted ? 'trusted' : 'unknown'}`;
      badge.textContent = item.classification.badge;

      row.append(main, badge);
      container.appendChild(row);
    }
  }

  #renderTrustGraph(container) {
    const { trustedAnchors, vouchedFriends } = this.#identitySnapshot;

    const anchorHeader = document.createElement('div');
    anchorHeader.className = 'ledger-section-title';
    anchorHeader.textContent = `Direct Trusted Friends (${trustedAnchors.length})`;
    container.appendChild(anchorHeader);

    if (trustedAnchors.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'status';
      empty.textContent = 'No trusted friends yet. Click "☆ Trust" next to an opponent you know IRL/online.';
      container.appendChild(empty);
    } else {
      for (const anchor of trustedAnchors) {
        const row = document.createElement('div');
        row.className = 'ledger-row';

        const label = document.createElement('span');
        label.textContent = formatPlayerTag(anchor.nickname, anchor.playerId);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'secondary small';
        btn.textContent = 'Untrust';
        btn.addEventListener('click', (e) => {
          e.currentTarget.blur();
          this.#handlers.onUntrustAnchor?.(anchor.playerId);
        });

        row.append(label, btn);
        container.appendChild(row);
      }
    }

    const vouchedHeader = document.createElement('div');
    vouchedHeader.className = 'ledger-section-title';
    vouchedHeader.textContent = `Web of Trust (1–2 Hops: ${vouchedFriends.length})`;
    container.appendChild(vouchedHeader);

    if (vouchedFriends.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'status';
      empty.textContent = 'Play with trusted friends to automatically discover peers they have vouched for.';
      container.appendChild(empty);
    } else {
      for (const vf of vouchedFriends) {
        const row = document.createElement('div');
        row.className = 'ledger-row';

        const label = document.createElement('span');
        label.textContent = vf.displayTag;

        const badge = document.createElement('span');
        badge.className = 'trust-pill trusted';
        badge.textContent = `Hop ${vf.hop} via ${vf.viaName}`;

        row.append(label, badge);
        container.appendChild(row);
      }
    }
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

    // Dropdown popover controls
    for (const trigger of els.dropdownTriggers) {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        trigger.blur();
        this.#toggleDropdown(trigger.dataset.dropdownTarget);
      });
    }

    for (const closeBtn of els.dropdownCloseBtns) {
      closeBtn.addEventListener('click', (e) => {
        e.currentTarget.blur();
        this.#closeAllDropdowns();
      });
    }

    document.addEventListener('click', (e) => {
      if (!this.#openDropdownId) return;
      if (e.target.closest('.dropdown-popover') || e.target.closest('[data-dropdown-target]')) {
        return;
      }
      this.#closeAllDropdowns();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.#openDropdownId) {
        const tag = document.activeElement?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
          this.#closeAllDropdowns();
        }
      }
    });

    els.btnHost.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#closeAllDropdowns();
      this.#handlers.onHost();
    });

    const submitJoin = () => {
      const normalized = normalizeRoomCode(els.joinCodeInput.value);
      els.joinCodeInput.value = normalized;
      this.#closeAllDropdowns();
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

    els.btnReady.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#handlers.onToggleReady?.();
    });

    els.btnLeave.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#closeAllDropdowns();
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

    // Identity & Nickname events
    const saveNickname = () => {
      this.#handlers.onNicknameChange?.(els.nicknameInput.value);
      els.nicknameInput.blur();
    };
    els.btnSaveNickname.addEventListener('click', (e) => {
      e.currentTarget.blur();
      saveNickname();
    });
    els.nicknameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveNickname();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        els.nicknameInput.value = this.#identitySnapshot.nickname;
        els.nicknameInput.blur();
      }
    });

    els.btnTrustOpponent.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#handlers.onToggleTrustOpponent?.();
    });

    els.btnViewOpponentHistory.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#closeAllDropdowns();
      els.ledgerPanel.classList.toggle('hidden');
      this.#setActiveTab('opponent');
    });

    els.btnToggleLedger.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#closeAllDropdowns();
      els.ledgerPanel.classList.toggle('hidden');
      this.#renderLedger();
    });

    els.tabMyHistory.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#setActiveTab('mine');
    });
    els.tabOpponentHistory.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#setActiveTab('opponent');
    });
    els.tabTrustGraph.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.#setActiveTab('trust');
    });

    // Backup / Restore events
    els.btnBackupIdentity.addEventListener('click', (e) => {
      e.currentTarget.blur();
      els.backupPanel.classList.toggle('hidden');
      els.backupFeedback.textContent = '';
    });

    els.btnCopyBackup.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.blur();
      const json = this.#handlers.onExportIdentity?.() || '';
      const ok = await copyToClipboard(json);
      flashButtonLabel(btn, ok ? 'Copied!' : 'Copy Failed');
    });

    els.btnDownloadBackup.addEventListener('click', (e) => {
      e.currentTarget.blur();
      const json = this.#handlers.onExportIdentity?.() || '';
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const safeTag = this.#identitySnapshot.displayTag
        .replace('#', '-')
        .replace(/[^a-zA-Z0-9._-]/g, '_');
      const a = document.createElement('a');
      a.href = url;
      a.download = `pong-identity-${safeTag}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    els.btnImportBackup.addEventListener('click', async (e) => {
      e.currentTarget.blur();
      const raw = els.importBackupInput.value.trim();
      if (!raw) {
        els.backupFeedback.textContent = 'Paste a backup JSON first.';
        return;
      }
      const res = await this.#handlers.onImportIdentity?.(raw);
      if (res?.ok) {
        els.importBackupInput.value = '';
        els.importBackupInput.blur();
        els.backupFeedback.textContent = `Restored identity: ${res.displayTag}`;
      } else {
        els.backupFeedback.textContent = res?.error || 'Restore failed.';
      }
    });

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

function fmtRecord(s) {
  return `${s.wins}W–${s.losses}L${s.draws ? `–${s.draws}D` : ''}`;
}