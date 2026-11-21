<script>
  import { onDestroy } from 'svelte';
  import { buildInviteUrl } from '../utils/code.js';
  import { copyToClipboard } from '../utils/dom.js';
  import OpponentBar from './OpponentBar.svelte';

  let {
    roomCode,
    isHost,
    connected,
    connectionLost,
    matchActive,
    matchOver,
    paused,
    localReady = false,
    remoteReady = false,
    opponent = null,
    onTogglePause,
    onResetScore,
    onLeave,
    onToggleReady,
    onToggleTrustOpponent,
    onViewOpponentHistory
  } = $props();

  let copyCodeLabel = $state('Copy Code');
  let copyLinkLabel = $state('Invite Link');
  let codeTimer = null;
  let linkTimer = null;

  onDestroy(() => {
    clearTimeout(codeTimer);
    clearTimeout(linkTimer);
  });

  async function handleCopyCode(e) {
    e.currentTarget.blur();
    const ok = await copyToClipboard(roomCode);
    copyCodeLabel = ok ? 'Copied!' : 'Copy Failed';
    clearTimeout(codeTimer);
    codeTimer = setTimeout(() => {
      copyCodeLabel = 'Copy Code';
    }, 1400);
  }

  async function handleCopyLink(e) {
    e.currentTarget.blur();
    const ok = await copyToClipboard(buildInviteUrl(roomCode));
    copyLinkLabel = ok ? 'Link Copied!' : 'Copy Failed';
    clearTimeout(linkTimer);
    linkTimer = setTimeout(() => {
      copyLinkLabel = 'Invite Link';
    }, 1400);
  }

  let canMidMatchReset = $derived(connected && !connectionLost && isHost && matchActive && !matchOver);
  let pauseDisabled = $derived(!connected || connectionLost || !matchActive || matchOver);
  let showReadyBar = $derived(connected && !connectionLost && (!matchActive || matchOver));
  let readyButtonLabel = $derived(
    localReady ? 'Ready ✓ (Cancel)' : matchOver ? 'Play Again (Ready)' : 'Ready Up'
  );
</script>

<div>
  <div class="room-toolbar">
    {#if isHost}
      <div class="invite-area">
        <div class="code-box">
          <span class="code-label">Room</span>
          <span class="code-text">{roomCode}</span>
          <button type="button" class="secondary small" onclick={handleCopyCode}>
            {copyCodeLabel}
          </button>
          <button type="button" class="small" onclick={handleCopyLink}>
            {copyLinkLabel}
          </button>
        </div>
      </div>
    {/if}

    <div class="room-actions">
      <button
        type="button"
        class="secondary small"
        disabled={pauseDisabled}
        onclick={(e) => {
          e.currentTarget.blur();
          onTogglePause();
        }}
      >
        {paused ? 'Resume (Space)' : 'Pause (Space)'}
      </button>

      {#if canMidMatchReset}
        <button
          type="button"
          class="secondary small"
          onclick={(e) => {
            e.currentTarget.blur();
            onResetScore();
          }}
        >
          Reset Score
        </button>
      {/if}

      <button
        type="button"
        class="danger-outline small"
        onclick={(e) => {
          e.currentTarget.blur();
          onLeave();
        }}
      >
        Leave Room
      </button>
    </div>
  </div>

  {#if showReadyBar}
    <div class="ready-bar">
      <div class="ready-players">
        <span class="ready-pill" class:ready={localReady}>
          {localReady ? 'You: Ready ✓' : 'You: Not Ready'}
        </span>
        <span class="ready-pill" class:ready={remoteReady}>
          {remoteReady ? 'Opponent: Ready ✓' : 'Opponent: Not Ready'}
        </span>
      </div>
      <button
        type="button"
        class="ready-btn"
        class:is-ready={localReady}
        onclick={(e) => {
          e.currentTarget.blur();
          onToggleReady();
        }}
      >
        {readyButtonLabel}
      </button>
    </div>
  {/if}

  <OpponentBar
    {opponent}
    onToggleTrust={onToggleTrustOpponent}
    onViewHistory={onViewOpponentHistory}
  />
</div>
