<script>
  import { formatMatchSummary, resolvePaddleColor } from '../game/MatchSettings.js';
  import { formatRecord } from '../utils/format.js';
  import AudioPopover from './toolbar/AudioPopover.svelte';
  import MatchRulesPopover from './toolbar/MatchRulesPopover.svelte';
  import PaddleColorPopover from './toolbar/PaddleColorPopover.svelte';
  import ProfilePopover from './toolbar/ProfilePopover.svelte';

  let {
    inRoom,
    isHost,
    connected,
    settings,
    localColorId,
    remoteColorId,
    volumePct,
    isMuted,
    winSounds = [],
    selectedWinSoundId,
    identity,
    onMatchSettingsChange,
    onPaddleColorChange,
    onToggleMute,
    onVolumeChange,
    onWinSoundChange,
    onPreviewWinSound,
    onNicknameChange,
    onExportIdentity,
    onImportIdentity,
    onToggleLedger
  } = $props();

  let openDropdown = $state(null); // null | 'rules' | 'paddle' | 'audio' | 'profile'
  let anchorEl = $state(null);

  $effect(() => {
    void inRoom;
    openDropdown = null;
  });

  let rulesSummary = $derived(formatMatchSummary(settings));
  let canEditRules = $derived(!inRoom || isHost);
  let localColor = $derived(resolvePaddleColor(localColorId));
  let remoteColor = $derived(resolvePaddleColor(remoteColorId));
  let myRecordText = $derived(formatRecord(identity.myStats));
  let soundButtonLabel = $derived(isMuted || volumePct === 0 ? 'Sound: Off (M)' : 'Sound: On (M)');

  function toggleDropdown(id, e) {
    e.stopPropagation();
    e.currentTarget.blur();
    openDropdown = openDropdown === id ? null : id;
  }

  function closeDropdown() {
    openDropdown = null;
  }

  function handleWindowClick(e) {
    if (!openDropdown) return;
    if (anchorEl && anchorEl.contains(e.target)) return;
    openDropdown = null;
  }

  function handleWindowKeydown(e) {
    if (e.key === 'Escape' && openDropdown) {
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        openDropdown = null;
      }
    }
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<div class="toolbar-anchor" bind:this={anchorEl}>
  <div class="toolbar-strip" role="toolbar" aria-label="Game settings and preferences">
    <button
      type="button"
      class="menu-pill"
      aria-expanded={openDropdown === 'rules'}
      aria-controls="dropdownRules"
      onclick={(e) => toggleDropdown('rules', e)}
    >
      <span class="pill-kicker">Rules:</span>
      <span class="pill-value">{rulesSummary}</span>
      <span class="chevron" aria-hidden="true">▾</span>
    </button>

    <button
      type="button"
      class="menu-pill"
      aria-expanded={openDropdown === 'paddle'}
      aria-controls="dropdownPaddle"
      onclick={(e) => toggleDropdown('paddle', e)}
    >
      <span class="swatch-dot" style:background-color={localColor.hex} aria-hidden="true"></span>
      <span class="pill-value">Paddle</span>
      {#if connected}
        <span
          class="swatch-dot remote-mini"
          style:background-color={remoteColor.hex}
          aria-hidden="true"
        ></span>
      {/if}
      <span class="chevron" aria-hidden="true">▾</span>
    </button>

    <div class="audio-split">
      <button
        type="button"
        class="secondary small mute-btn"
        title="Toggle Mute (M)"
        onclick={(e) => {
          e.currentTarget.blur();
          onToggleMute();
        }}
      >
        {soundButtonLabel}
      </button>
      <button
        type="button"
        class="menu-pill split-chevron"
        aria-expanded={openDropdown === 'audio'}
        aria-controls="dropdownAudio"
        aria-label="Audio & Win Sound settings"
        title="Volume & Win Sound"
        onclick={(e) => toggleDropdown('audio', e)}
      >
        <span class="chevron" aria-hidden="true">▾</span>
      </button>
    </div>

    <div class="profile-group">
      <button
        type="button"
        class="menu-pill"
        aria-expanded={openDropdown === 'profile'}
        aria-controls="dropdownProfile"
        title="Identity, Nickname & Key Backup"
        onclick={(e) => toggleDropdown('profile', e)}
      >
        <strong class="identity-tag compact" title={identity.displayTag}>
          {identity.displayTag}
        </strong>
        <span class="record-pill">{myRecordText}</span>
        <span class="chevron" aria-hidden="true">▾</span>
      </button>
      <button
        type="button"
        class="secondary small ledger-toggle-btn"
        onclick={(e) => {
          e.currentTarget.blur();
          openDropdown = null;
          onToggleLedger();
        }}
      >
        History ({identity.myReceipts.length})
      </button>
    </div>
  </div>

  {#if openDropdown === 'rules'}
    <MatchRulesPopover
      {settings}
      {canEditRules}
      {onMatchSettingsChange}
      onClose={closeDropdown}
    />
  {/if}

  {#if openDropdown === 'paddle'}
    <PaddleColorPopover
      {localColor}
      {remoteColor}
      {connected}
      {onPaddleColorChange}
      onClose={closeDropdown}
    />
  {/if}

  {#if openDropdown === 'audio'}
    <AudioPopover
      {volumePct}
      {isMuted}
      {winSounds}
      {selectedWinSoundId}
      {onVolumeChange}
      {onWinSoundChange}
      {onPreviewWinSound}
      onClose={closeDropdown}
    />
  {/if}

  {#if openDropdown === 'profile'}
    <ProfilePopover
      {identity}
      {onNicknameChange}
      {onExportIdentity}
      {onImportIdentity}
      onClose={closeDropdown}
    />
  {/if}
</div>
