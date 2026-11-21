<script>
  import { PADDLE_COLORS } from '../../config/constants.js';

  let { localColor, remoteColor, connected, onPaddleColorChange, onClose } = $props();
</script>

<div id="dropdownPaddle" class="dropdown-popover" role="region" aria-label="Paddle Colour">
  <div class="popover-header">
    <span class="popover-title">Paddle Colour</span>
    <button
      type="button"
      class="popover-close"
      aria-label="Close"
      onclick={(e) => {
        e.currentTarget.blur();
        onClose();
      }}
    >
      ×
    </button>
  </div>

  <div class="paddle-bar">
    <div class="color-palette" role="group" aria-label="Select paddle colour">
      {#each PADDLE_COLORS as color (color.id)}
        <button
          type="button"
          class="color-swatch"
          class:selected={color.id === localColor.id}
          style:background-color={color.hex}
          title={color.label}
          aria-label={color.label}
          aria-pressed={color.id === localColor.id}
          onclick={(e) => {
            e.currentTarget.blur();
            onPaddleColorChange(color.id);
          }}
        ></button>
      {/each}
    </div>
    {#if connected}
      <span class="opponent-color">
        Opponent:
        <span class="opponent-dot" style:background-color={remoteColor.hex} aria-hidden="true"></span>
        <span>{remoteColor.label}</span>
      </span>
    {/if}
  </div>
</div>
