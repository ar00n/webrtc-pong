<script>
  let {
    volumePct,
    isMuted,
    winSounds = [],
    selectedWinSoundId,
    onVolumeChange,
    onWinSoundChange,
    onPreviewWinSound,
    onClose
  } = $props();
</script>

<div id="dropdownAudio" class="dropdown-popover" role="region" aria-label="Audio & Win Sound">
  <div class="popover-header">
    <span class="popover-title">Audio &amp; Win Sound</span>
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

  <div class="audio-bar">
    <div class="audio-group">
      <span class="field-label">Volume</span>
      <input
        type="range"
        min="0"
        max="100"
        value={volumePct}
        aria-label="Volume"
        oninput={(e) => onVolumeChange(Number(e.currentTarget.value))}
        onchange={(e) => e.currentTarget.blur()}
        onpointerup={(e) => e.currentTarget.blur()}
      />
      <span class="vol-text">{isMuted ? 'Muted' : `${volumePct}%`}</span>
    </div>

    <div class="win-sound-controls">
      <label class="inline-field">
        <span class="field-label">Win Sound</span>
        <select
          aria-label="Win sound selection"
          value={selectedWinSoundId}
          onchange={(e) => {
            e.currentTarget.blur();
            onWinSoundChange(e.currentTarget.value);
          }}
        >
          {#each winSounds as sound (sound.id)}
            <option value={sound.id}>{sound.label}</option>
          {/each}
        </select>
      </label>
      <button
        type="button"
        class="secondary small"
        onclick={(e) => {
          e.currentTarget.blur();
          onPreviewWinSound();
        }}
      >
        Preview
      </button>
    </div>
  </div>
</div>
