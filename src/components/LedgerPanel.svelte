<script>
  import { formatPlayerTag } from '../identity/IdentityCrypto.js';
  import { formatReceiptMode, formatRecord, formatTimestamp } from '../utils/format.js';

  let {
    identity,
    opponent = null,
    activeTab = $bindable('mine'),
    onUntrustAnchor
  } = $props();

  let anchorIds = $derived(new Set(identity.trustedAnchors.map((a) => a.playerId)));
  let showOpponentTab = $derived(Boolean(opponent && !opponent.verifying));
</script>

<section class="panel ledger-panel" aria-label="Match history and Web of Trust">
  <div class="ledger-tabs">
    <button
      type="button"
      class="secondary small"
      class:active={activeTab === 'mine'}
      onclick={(e) => {
        e.currentTarget.blur();
        activeTab = 'mine';
      }}
    >
      My Matches
    </button>

    {#if showOpponentTab}
      <button
        type="button"
        class="secondary small"
        class:active={activeTab === 'opponent'}
        onclick={(e) => {
          e.currentTarget.blur();
          activeTab = 'opponent';
        }}
      >
        Opponent ({opponent.historySummary.all.total})
      </button>
    {/if}

    <button
      type="button"
      class="secondary small"
      class:active={activeTab === 'trust'}
      onclick={(e) => {
        e.currentTarget.blur();
        activeTab = 'trust';
      }}
    >
      Web of Trust
    </button>
  </div>

  <div class="ledger-content">
    {#if activeTab === 'mine'}
      {#if identity.myReceipts.length === 0}
        <p class="status">
          No mutually signed matches yet. Finish a match to record a dual-signed receipt.
        </p>
      {:else}
        {#each identity.myReceipts as r (r.parsed.matchId)}
          {@const p = r.parsed}
          {@const iWasHost = p.host.id === identity.myPlayerId}
          {@const opp = iWasHost ? p.guest : p.host}
          {@const myScore = iWasHost ? p.hostScore : p.guestScore}
          {@const oppScore = iWasHost ? p.guestScore : p.hostScore}
          {@const iWon = (iWasHost && p.winner === 'host') || (!iWasHost && p.winner === 'guest')}
          {@const isTrusted = anchorIds.has(opp.id)}
          <div class="ledger-row">
            <div class="ledger-row-main">
              <strong class={p.winner === 'draw' ? '' : iWon ? 'win-text' : 'loss-text'}>
                {p.winner === 'draw' ? 'DRAW' : iWon ? 'WIN' : 'LOSS'}
                {myScore}–{oppScore} vs {formatPlayerTag(opp.nickname, opp.id)}
              </strong>
              <span class="ledger-meta">
                {formatTimestamp(p.timestamp)} • {formatReceiptMode(p.settings)} • Dual-Signed
              </span>
            </div>
            <span class="trust-pill {isTrusted ? 'trusted' : 'neutral'}">
              {isTrusted ? 'Trusted Friend' : 'Signed Receipt'}
            </span>
          </div>
        {/each}
      {/if}
    {:else if activeTab === 'opponent'}
      {#if !showOpponentTab}
        <p class="status">
          Connect and authenticate with an opponent to view their signed history.
        </p>
      {:else}
        {@const { peer, historySummary } = opponent}
        {@const { trusted, untrustedCount, items } = historySummary}
        <div class="ledger-summary">
          {#if untrustedCount === 0}
            {peer.displayTag} — Record: {formatRecord(trusted)} (all in your Web of Trust)
          {:else}
            {peer.displayTag} — Known Record: {formatRecord(trusted)} • +{untrustedCount} dual-signed vs strangers
          {/if}
        </div>

        {#if items.length === 0}
          <p class="status">This opponent has not shared any signed match receipts yet.</p>
        {:else}
          {#each items as item (item.receipt.parsed.matchId)}
            {@const p = item.receipt.parsed}
            {@const outcome = item.isDraw ? 'DREW' : item.peerWon ? 'BEAT' : 'LOST TO'}
            <div class="ledger-row">
              <div class="ledger-row-main">
                <strong class={item.isDraw ? '' : item.peerWon ? 'win-text' : 'loss-text'}>
                  {peer.displayTag} {outcome} {item.classification.otherTag} ({item.myScore}–{item.oppScore})
                </strong>
                <span class="ledger-meta">
                  {formatTimestamp(p.timestamp)} • Both signatures verified
                </span>
              </div>
              <span class="trust-pill {item.classification.trusted ? 'trusted' : 'unknown'}">
                {item.classification.badge}
              </span>
            </div>
          {/each}
        {/if}
      {/if}
    {:else}
      <div class="ledger-section-title">
        Direct Trusted Friends ({identity.trustedAnchors.length})
      </div>

      {#if identity.trustedAnchors.length === 0}
        <p class="status">
          No trusted friends yet. Click "☆ Trust Friend" next to an opponent you know IRL/online.
        </p>
      {:else}
        {#each identity.trustedAnchors as anchor (anchor.playerId)}
          <div class="ledger-row">
            <span>{formatPlayerTag(anchor.nickname, anchor.playerId)}</span>
            <button
              type="button"
              class="secondary small"
              onclick={(e) => {
                e.currentTarget.blur();
                onUntrustAnchor(anchor.playerId);
              }}
            >
              Untrust
            </button>
          </div>
        {/each}
      {/if}

      <div class="ledger-section-title">
        Web of Trust (1–2 Hops: {identity.vouchedFriends.length})
      </div>

      {#if identity.vouchedFriends.length === 0}
        <p class="status">
          Play with trusted friends to automatically discover peers they have vouched for.
        </p>
      {:else}
        {#each identity.vouchedFriends as vf (vf.playerId)}
          <div class="ledger-row">
            <span>{vf.displayTag}</span>
            <span class="trust-pill trusted">Hop {vf.hop} via {vf.viaName}</span>
          </div>
        {/each}
      {/if}
    {/if}
  </div>
</section>
