<script>
  import { formatRecord } from '../utils/format.js';

  let { opponent, onToggleTrust, onViewHistory } = $props();

  let recordSummary = $derived.by(() => {
    if (!opponent || opponent.verifying) return { text: '', title: '' };
    const { trusted, all, untrustedCount } = opponent.historySummary;
    if (all.total === 0) {
      return {
        text: 'Record: 0W–0L',
        title: 'No signed matches recorded yet.'
      };
    }
    if (untrustedCount === 0) {
      return {
        text: `Record: ${formatRecord(trusted)}`,
        title: 'All signed matches are against you or players in your Web of Trust.'
      };
    }
    return {
      text: `Known Record: ${formatRecord(trusted)} (+${untrustedCount} vs strangers)`,
      title: `${formatRecord(trusted)} against you or your Web of Trust; ${untrustedCount} additional signed match(es) against unknown players.`
    };
  });
</script>

{#if opponent}
  <div class="opponent-trust-bar">
    <span class="field-label">Opponent:</span>

    {#if opponent.verifying}
      <strong class="identity-tag">Verifying opponent key...</strong>
      <span class="trust-pill neutral">Checking</span>
    {:else}
      <strong class="identity-tag">{opponent.peer.displayTag}</strong>
      <span class="trust-pill {opponent.trustInfo.trusted ? 'trusted' : 'unknown'}">
        {opponent.trustInfo.label}
      </span>
      <button
        type="button"
        class="secondary small trust-opponent-btn"
        class:active={opponent.isTrustedAnchor}
        onclick={(e) => {
          e.currentTarget.blur();
          onToggleTrust();
        }}
      >
        {opponent.isTrustedAnchor ? '★ Trusted Friend' : '☆ Trust Friend'}
      </button>
      <span class="status" title={recordSummary.title}>{recordSummary.text}</span>
      <button
        type="button"
        class="secondary small"
        onclick={(e) => {
          e.currentTarget.blur();
          onViewHistory();
        }}
      >
        Matches ({opponent.historySummary.all.total})
      </button>
    {/if}
  </div>
{/if}
