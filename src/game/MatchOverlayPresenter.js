export function deriveStatusPresentation({
  inRoom,
  roomCode,
  isHost,
  connected,
  connectionLost,
  state,
  localReady,
  remoteReady
}) {
  if (!inRoom) {
    return { message: 'Host a room or join with a code', mode: '' };
  }

  if (connectionLost) {
    const offlineMsg = !navigator.onLine ? 'You are offline' : 'Connection lost';
    return {
      message: `${offlineMsg} — Game paused. Waiting in ${roomCode}...`,
      mode: 'error'
    };
  }

  if (!connected) {
    return {
      message: isHost
        ? `Waiting for friend to join ${roomCode}...`
        : `Connecting to room ${roomCode}...`,
      mode: 'waiting'
    };
  }

  if (!state.matchActive) {
    const readyCount = (localReady ? 1 : 0) + (remoteReady ? 1 : 0);
    if (localReady && remoteReady) {
      return { message: `${roomCode} — Both players ready! Starting match...`, mode: 'connected' };
    }
    if (localReady) {
      return {
        message: `${roomCode} — You are ready (${readyCount}/2). Waiting for opponent...`,
        mode: 'waiting'
      };
    }
    if (remoteReady) {
      return {
        message: `${roomCode} — Opponent is ready (${readyCount}/2). Click Ready Up to start!`,
        mode: 'waiting'
      };
    }
    return {
      message: `${roomCode} — Connected! Waiting for both players to Ready Up (0/2)`,
      mode: 'waiting'
    };
  }

  if (state.matchOver) {
    const localWon = (isHost && state.winner === 'host') || (!isHost && state.winner === 'guest');
    const readyCount = (localReady ? 1 : 0) + (remoteReady ? 1 : 0);
    const readySuffix = readyCount > 0 ? ` • Rematch Ready (${readyCount}/2)` : '';
    return {
      message: `${roomCode} — Match over (${localWon ? 'You won!' : 'Opponent won!'})${readySuffix}`,
      mode: 'connected'
    };
  }

  if (state.paused) {
    const reasonText =
      state.pauseReason === 'reconnected'
        ? 'Connection restored — Press Space to resume'
        : `Paused by ${state.pausedBy || 'player'} — Press Space to resume`;
    return { message: `${roomCode} — ${reasonText}`, mode: 'paused' };
  }

  const roleLabel = isHost ? 'Left Paddle (Host)' : 'Right Paddle (Guest)';
  return {
    message: `Connected in ${roomCode} — You are ${roleLabel}`,
    mode: 'connected'
  };
}

export function deriveOverlayPresentation({
  inRoom,
  roomCode,
  isHost,
  connected,
  connectionLost,
  state,
  localReady,
  remoteReady
}) {
  if (!inRoom) {
    return {
      title: 'P2P PONG',
      subtitle: 'Host a game or enter a room code above',
      accentColor: '#fff'
    };
  }

  if (connectionLost) {
    return {
      title: 'CONNECTION LOST — GAME PAUSED',
      subtitle: !navigator.onLine
        ? 'You are offline. Waiting for internet...'
        : 'Waiting for opponent to reconnect...',
      accentColor: '#eb5757'
    };
  }

  if (!connected) {
    return {
      title: isHost ? `ROOM CODE: ${roomCode}` : `JOINING ${roomCode}...`,
      subtitle: isHost
        ? 'Waiting for your friend to join...'
        : 'Establishing peer-to-peer connection...',
      accentColor: '#f2c94c'
    };
  }

  if (!state.matchActive) {
    if (localReady && remoteReady) {
      return {
        title: 'BOTH READY!',
        subtitle: 'Starting match...',
        accentColor: '#6fcf97'
      };
    }
    if (localReady) {
      return {
        title: 'WAITING FOR OPPONENT',
        subtitle: 'You are Ready (1/2) • Waiting for opponent to click Ready Up',
        accentColor: '#6fcf97'
      };
    }
    if (remoteReady) {
      return {
        title: 'OPPONENT IS READY!',
        subtitle: 'Opponent is Ready (1/2) • Click Ready Up above to start',
        accentColor: '#f2c94c'
      };
    }
    return {
      title: 'GET READY',
      subtitle: 'Click Ready Up above when both players are set (0/2 Ready)',
      accentColor: '#56ccf2'
    };
  }

  if (state.matchOver) {
    const localWon = (isHost && state.winner === 'host') || (!isHost && state.winner === 'guest');
    let rematchHint = 'Both players click Play Again (Ready) to rematch';
    if (localReady && remoteReady) {
      rematchHint = 'Both ready! Starting rematch...';
    } else if (localReady) {
      rematchHint = 'You are Ready (1/2) • Waiting for opponent';
    } else if (remoteReady) {
      rematchHint = 'Opponent wants a rematch! Click Play Again (Ready) (1/2)';
    }

    return {
      title: localWon ? 'YOU WIN!' : 'YOU LOSE',
      subtitle: `Final Score: ${state.hostScore} – ${state.guestScore} • ${rematchHint}`,
      accentColor: localWon ? '#6fcf97' : '#eb5757'
    };
  }

  if (state.paused) {
    return {
      title: 'PAUSED',
      subtitle:
        state.pauseReason === 'reconnected'
          ? 'Connection restored — Press SPACE to resume'
          : `Paused by ${state.pausedBy || 'player'} — Press SPACE to resume`,
      accentColor: '#56ccf2'
    };
  }

  return null;
}
