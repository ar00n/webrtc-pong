<script>
  import { normalizeRoomCode } from '../utils/code.js';

  let {
    joinCode = $bindable(''),
    joinError = '',
    onHost,
    onJoin,
    onClearError
  } = $props();

  function submitJoin() {
    const normalized = normalizeRoomCode(joinCode);
    joinCode = normalized;
    onJoin(normalized);
  }
</script>

<div>
  <div class="lobby-row">
    <button
      type="button"
      onclick={(e) => {
        e.currentTarget.blur();
        onHost();
      }}
    >
      Host Game (Left Paddle)
    </button>
    <span class="lobby-divider">or</span>
    <div class="join-group">
      <input
        class="join-code-input"
        type="text"
        maxlength="12"
        placeholder="CODE"
        autocomplete="off"
        aria-label="Room code"
        bind:value={joinCode}
        oninput={onClearError}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
            submitJoin();
          }
        }}
      />
      <button
        type="button"
        class="secondary join-btn"
        onclick={(e) => {
          e.currentTarget.blur();
          submitJoin();
        }}
      >
        Join Game
      </button>
    </div>
  </div>

  {#if joinError}
    <p class="inline-error" role="alert">{joinError}</p>
  {/if}
</div>
