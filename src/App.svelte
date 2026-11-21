<script>
  import { onMount } from 'svelte';
  import { PongApp } from './app/PongApp.svelte.js';
  import HeaderBar from './components/HeaderBar.svelte';
  import LobbyPanel from './components/LobbyPanel.svelte';
  import RoomBar from './components/RoomBar.svelte';
  import ToolbarStrip from './components/ToolbarStrip.svelte';
  import LedgerPanel from './components/LedgerPanel.svelte';

  const pong = new PongApp();

  let canvasEl = $state(null);
  let ledgerOpen = $state(false);
  let activeLedgerTab = $state('mine');

  onMount(() => {
    const unmountCanvas = pong.mount(canvasEl);
    return () => {
      unmountCanvas?.();
      pong.destroy();
    };
  });

  $effect(() => {
    const opp = pong.ui.opponent;
    if ((!opp || opp.verifying) && activeLedgerTab === 'opponent') {
      activeLedgerTab = 'mine';
    }
  });

  function handleViewOpponentHistory() {
    if (ledgerOpen && activeLedgerTab === 'opponent') {
      ledgerOpen = false;
    } else {
      ledgerOpen = true;
      activeLedgerTab = 'opponent';
    }
  }
</script>

<main class="app">
  <section class="panel" aria-label="Game controls and connection status">
    <HeaderBar
      statusMessage={pong.ui.statusMessage}
      statusMode={pong.ui.statusMode}
      rttMs={pong.ui.rttMs}
      showPing={pong.ui.showPing}
    />

    {#if !pong.ui.inRoom}
      <LobbyPanel
        bind:joinCode={pong.ui.joinCode}
        joinError={pong.ui.joinError}
        onHost={() => pong.hostRoom()}
        onJoin={(code) => pong.joinRoom(code)}
        onClearError={() => pong.clearJoinError()}
      />
    {:else}
      <RoomBar
        roomCode={pong.ui.roomCode}
        isHost={pong.ui.isHost}
        connected={pong.ui.connected}
        connectionLost={pong.ui.connectionLost}
        matchActive={pong.ui.matchActive}
        matchOver={pong.ui.matchOver}
        paused={pong.ui.paused}
        localReady={pong.ui.localReady}
        remoteReady={pong.ui.remoteReady}
        opponent={pong.ui.opponent}
        onTogglePause={() => pong.togglePause()}
        onResetScore={() => pong.resetHostMatch()}
        onLeave={() => pong.leaveRoom()}
        onToggleReady={() => pong.toggleReady()}
        onToggleTrustOpponent={() => pong.toggleTrustOpponent()}
        onViewOpponentHistory={handleViewOpponentHistory}
      />
    {/if}

    <ToolbarStrip
      inRoom={pong.ui.inRoom}
      isHost={pong.ui.isHost}
      connected={pong.ui.connected}
      settings={pong.ui.settings}
      localColorId={pong.ui.localColorId}
      remoteColorId={pong.ui.remoteColorId}
      volumePct={pong.ui.volumePct}
      isMuted={pong.ui.isMuted}
      winSounds={pong.ui.winSounds}
      selectedWinSoundId={pong.ui.selectedWinSoundId}
      identity={pong.ui.identity}
      onMatchSettingsChange={(patch) => pong.updateMatchSettings(patch)}
      onPaddleColorChange={(colorId) => pong.setPaddleColor(colorId)}
      onToggleMute={() => pong.toggleMute()}
      onVolumeChange={(pct) => pong.setVolume(pct)}
      onWinSoundChange={(id) => pong.setWinSound(id)}
      onPreviewWinSound={() => pong.previewWinSound()}
      onNicknameChange={(name) => pong.setNickname(name)}
      onExportIdentity={() => pong.exportIdentity()}
      onImportIdentity={(json) => pong.importIdentityBackup(json)}
      onToggleLedger={() => (ledgerOpen = !ledgerOpen)}
    />
  </section>

  <canvas bind:this={canvasEl} width="700" height="420" aria-label="Pong game board"></canvas>

  <p class="status controls-hint">
    Controls: Mouse / Touch drag, W/S or Arrow Up &amp; Down, Space to Pause / Resume, M to Mute
  </p>

  {#if ledgerOpen}
    <LedgerPanel
      identity={pong.ui.identity}
      opponent={pong.ui.opponent}
      bind:activeTab={activeLedgerTab}
      onUntrustAnchor={(playerId) => pong.untrustAnchor(playerId)}
    />
  {/if}
</main>
