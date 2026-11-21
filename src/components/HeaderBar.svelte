<script>
  let { statusMessage, statusMode = '', rttMs = 0, showPing = false } = $props();
</script>

<header class="header">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true"></span>
    <strong>WebRTC Pong</strong>
  </div>
  <div class="status-wrap">
    <span class="dot {statusMode}" aria-hidden="true"></span>
    <span class="status" role="status" aria-live="polite">{statusMessage}</span>
    {#if showPing}
      <span class="ping-badge">{rttMs} ms</span>
    {/if}
  </div>
</header>
