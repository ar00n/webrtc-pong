<script>
  import { MATCH_MODES } from '../../config/constants.js';
  import { formatMatchSummary } from '../../game/MatchSettings.js';

  let { settings, canEditRules, onMatchSettingsChange, onClose } = $props();

  const STANDARD_TIMES = [
    { value: 30, label: '0:30' },
    { value: 60, label: '1:00' },
    { value: 120, label: '2:00' },
    { value: 180, label: '3:00' },
    { value: 300, label: '5:00' },
    { value: 600, label: '10:00' }
  ];

  const initialNumericValues = new Map();

  let rulesSummary = $derived(formatMatchSummary(settings));
  let usesTarget = $derived(
    settings.mode === MATCH_MODES.FIRST_TO || settings.mode === MATCH_MODES.WIN_BY_2
  );
  let usesTime = $derived(settings.mode === MATCH_MODES.TIMED);
  let timeOptions = $derived(
    STANDARD_TIMES.some((o) => o.value === settings.timeLimitSec)
      ? STANDARD_TIMES
      : [...STANDARD_TIMES, { value: settings.timeLimitSec, label: `${settings.timeLimitSec}s` }]
  );

  function commitNumericField(input, field) {
    onMatchSettingsChange({ [field]: Number(input.value) });
    input.value =
      field === 'speedMultiplier' ? settings[field].toFixed(2) : String(settings[field]);
  }

  function numericHandlers(field) {
    return {
      onfocus: (e) => {
        initialNumericValues.set(field, e.currentTarget.value);
      },
      onchange: (e) => {
        commitNumericField(e.currentTarget, field);
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const initial = initialNumericValues.get(field);
          if (e.currentTarget.value === initial) {
            commitNumericField(e.currentTarget, field);
          }
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.currentTarget.value = initialNumericValues.get(field) ?? e.currentTarget.value;
          e.currentTarget.blur();
        }
      }
    };
  }
</script>

<div id="dropdownRules" class="dropdown-popover" role="region" aria-label="Match Rules">
  <div class="popover-header">
    <span class="popover-title">Match Mode &amp; Difficulty</span>
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

  {#if canEditRules}
    <div class="settings-controls">
      <label class="inline-field">
        <span class="field-label">Difficulty</span>
        <select
          aria-label="Difficulty"
          value={settings.difficulty}
          onchange={(e) => {
            e.currentTarget.blur();
            onMatchSettingsChange({ difficulty: e.currentTarget.value });
          }}
        >
          <option value="easy">Easy</option>
          <option value="normal">Normal</option>
          <option value="hard">Hard</option>
          <option value="custom">Custom</option>
        </select>
      </label>

      <label class="inline-field">
        <span class="field-label">Mode</span>
        <select
          aria-label="Game mode"
          value={settings.mode}
          onchange={(e) => {
            e.currentTarget.blur();
            onMatchSettingsChange({ mode: e.currentTarget.value });
          }}
        >
          <option value="first-to">First to X</option>
          <option value="win-by-2">Win by 2</option>
          <option value="timed">Timed</option>
          <option value="endless">Endless</option>
        </select>
      </label>

      {#if usesTarget}
        <label class="inline-field">
          <span class="field-label">Points</span>
          <input
            type="number"
            min="1"
            max="99"
            step="1"
            value={settings.targetScore}
            aria-label="Target points"
            {...numericHandlers('targetScore')}
          />
        </label>
      {/if}

      {#if usesTime}
        <label class="inline-field">
          <span class="field-label">Time</span>
          <select
            aria-label="Match duration"
            value={settings.timeLimitSec}
            onchange={(e) => {
              e.currentTarget.blur();
              onMatchSettingsChange({ timeLimitSec: Number(e.currentTarget.value) });
            }}
          >
            {#each timeOptions as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </label>
      {/if}

      {#if settings.difficulty !== 'custom'}
        <span class="spec-text">
          (Max {settings.maxBallSpeed} px/s, {settings.speedMultiplier.toFixed(2)}×)
        </span>
      {/if}
    </div>

    {#if settings.difficulty === 'custom'}
      <div class="custom-diff-row">
        <label class="inline-field">
          <span class="field-label">Serve Speed</span>
          <input
            type="number"
            min="200"
            max="600"
            step="10"
            value={settings.initialBallSpeed}
            aria-label="Custom serve speed"
            {...numericHandlers('initialBallSpeed')}
          />
        </label>
        <label class="inline-field">
          <span class="field-label">Max Speed</span>
          <input
            type="number"
            min="450"
            max="1600"
            step="20"
            value={settings.maxBallSpeed}
            aria-label="Custom max ball speed"
            {...numericHandlers('maxBallSpeed')}
          />
        </label>
        <label class="inline-field">
          <span class="field-label">Multiplier</span>
          <input
            type="number"
            min="1.00"
            max="1.20"
            step="0.01"
            value={settings.speedMultiplier.toFixed(2)}
            aria-label="Custom speed multiplier"
            {...numericHandlers('speedMultiplier')}
          />
        </label>
      </div>
    {/if}
  {:else}
    <div class="rules-badge">
      Host Rules: <strong>{rulesSummary}</strong>
    </div>
  {/if}
</div>
