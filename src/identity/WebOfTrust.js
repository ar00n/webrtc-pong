import { IDENTITY_CONFIG } from '../config/constants.js';
import { formatPlayerTag } from './IdentityCrypto.js';

export function getMergedReceiptsForPeer(
  peerId,
  myReceipts,
  graphReceipts,
  remoteReceipts = []
) {
  const seen = new Set();
  const merged = [];

  const addIfForPeer = (r) => {
    if (seen.has(r.parsed.matchId)) return;
    if (r.parsed.host.id !== peerId && r.parsed.guest.id !== peerId) return;
    seen.add(r.parsed.matchId);
    merged.push(r);
  };

  myReceipts.forEach(addIfForPeer);
  graphReceipts.forEach(addIfForPeer);
  remoteReceipts.forEach(addIfForPeer);

  return merged.sort((a, b) => b.parsed.timestamp - a.parsed.timestamp);
}

export function buildTrustContext(
  { myId, myDisplayTag, myReceipts, graphReceipts, trustedAnchors, vouches },
  extraReceipts = []
) {
  const playedIds = new Set();
  const playedNames = new Map();

  for (const r of myReceipts) {
    const { host, guest } = r.parsed;
    if (host.id === myId) {
      playedIds.add(guest.id);
      playedNames.set(guest.id, formatPlayerTag(guest.nickname, guest.id));
    } else if (guest.id === myId) {
      playedIds.add(host.id);
      playedNames.set(host.id, formatPlayerTag(host.nickname, host.id));
    }
  }

  const vouchedMap = new Map();
  const queue = [];

  for (const [anchorId, anchor] of trustedAnchors.entries()) {
    queue.push({ id: anchorId, hop: 0, name: formatPlayerTag(anchor.nickname, anchorId) });
  }
  if (myId) {
    queue.push({ id: myId, hop: 0, name: myDisplayTag });
  }

  const activeVouchesList = Array.from(vouches.values()).filter((v) => v.parsed.active);

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    if (current.hop >= IDENTITY_CONFIG.MAX_TRUST_HOPS) continue;

    for (const v of activeVouchesList) {
      const { voucher, subject } = v.parsed;
      if (voucher.id !== current.id) continue;
      if (subject.id === myId || trustedAnchors.has(subject.id)) continue;

      const nextHop = current.hop + 1;
      const prev = vouchedMap.get(subject.id);
      if (!prev || nextHop < prev.hop) {
        const subjectTag = formatPlayerTag(subject.nickname, subject.id);
        vouchedMap.set(subject.id, {
          hop: nextHop,
          viaId: voucher.id,
          viaName: current.name,
          displayTag: subjectTag
        });
        queue.push({ id: subject.id, hop: nextHop, name: subjectTag });
      }
    }
  }

  const allKnownReceipts = [...myReceipts, ...graphReceipts, ...extraReceipts];
  return { myId, playedIds, playedNames, trustedAnchors, vouchedMap, allKnownReceipts };
}

export function evaluatePeerTrust(targetId, graphData, remoteReceipts = []) {
  const ctx = buildTrustContext(graphData, remoteReceipts);

  if (targetId === ctx.myId) {
    return { level: 'self', trusted: true, label: 'You' };
  }
  if (ctx.trustedAnchors.has(targetId)) {
    return { level: 'anchor', trusted: true, label: 'Trusted Friend' };
  }

  const vouched = ctx.vouchedMap.get(targetId);
  if (vouched) {
    return {
      level: 'vouched',
      trusted: true,
      label: vouched.hop === 1 ? `Friend of ${vouched.viaName}` : `${vouched.hop}-Hop via ${vouched.viaName}`
    };
  }

  if (ctx.playedIds.has(targetId)) {
    return { level: 'played', trusted: true, label: 'Played Before' };
  }

  let mutualOpponentLabel = null;
  for (const r of ctx.allKnownReceipts) {
    const { host, guest } = r.parsed;
    let coSigner = null;
    if (host.id === targetId) coSigner = guest;
    else if (guest.id === targetId) coSigner = host;
    if (!coSigner) continue;

    if (coSigner.id === ctx.myId) {
      return { level: 'played', trusted: true, label: 'Played Before' };
    }
    if (ctx.trustedAnchors.has(coSigner.id) || ctx.vouchedMap.has(coSigner.id)) {
      return {
        level: 'known-graph',
        trusted: true,
        label: `Played ${formatPlayerTag(coSigner.nickname, coSigner.id)}`
      };
    }
    if (!mutualOpponentLabel && ctx.playedIds.has(coSigner.id)) {
      mutualOpponentLabel = `Mutual Opponent (${formatPlayerTag(coSigner.nickname, coSigner.id)})`;
    }
  }

  if (mutualOpponentLabel) {
    return { level: 'known-graph', trusted: true, label: mutualOpponentLabel };
  }

  return { level: 'unknown', trusted: false, label: 'New / Unvouched' };
}

export function classifyReceipt(receipt, subjectPlayerId, ctx) {
  const { host, guest } = receipt.parsed;
  const other = host.id === subjectPlayerId ? guest : host;
  const otherTag = formatPlayerTag(other.nickname, other.id);

  if (other.id === ctx.myId) {
    return { level: 'self', trusted: true, otherTag, badge: 'vs You' };
  }
  if (ctx.trustedAnchors.has(other.id)) {
    return { level: 'anchor', trusted: true, otherTag, badge: 'vs Trusted Friend' };
  }
  if (ctx.vouchedMap.has(other.id)) {
    const v = ctx.vouchedMap.get(other.id);
    return { level: 'vouched', trusted: true, otherTag, badge: `vs Friend of ${v.viaName}` };
  }
  if (ctx.playedIds.has(other.id)) {
    return { level: 'played', trusted: true, otherTag, badge: 'vs Mutual Opponent' };
  }

  return { level: 'untrusted', trusted: false, otherTag, badge: 'vs Stranger' };
}

export function summarizeMyHistory(myId, myReceipts) {
  const stats = { wins: 0, losses: 0, draws: 0, total: 0 };

  for (const r of myReceipts) {
    const p = r.parsed;
    const iWasHost = p.host.id === myId;
    const iWon = (iWasHost && p.winner === 'host') || (!iWasHost && p.winner === 'guest');
    stats.total++;
    if (p.winner === 'draw') stats.draws++;
    else if (iWon) stats.wins++;
    else stats.losses++;
  }

  return stats;
}

export function summarizePeerHistory(mergedReceipts, peerId, graphData) {
  const ctx = buildTrustContext(graphData, mergedReceipts);
  const trusted = { wins: 0, losses: 0, draws: 0, total: 0 };
  const all = { wins: 0, losses: 0, draws: 0, total: 0 };

  const items = mergedReceipts.map((receipt) => {
    const p = receipt.parsed;
    const isHost = p.host.id === peerId;
    const peerWon = (isHost && p.winner === 'host') || (!isHost && p.winner === 'guest');
    const isDraw = p.winner === 'draw';
    const classification = classifyReceipt(receipt, peerId, ctx);

    all.total++;
    if (isDraw) all.draws++;
    else if (peerWon) all.wins++;
    else all.losses++;

    if (classification.trusted) {
      trusted.total++;
      if (isDraw) trusted.draws++;
      else if (peerWon) trusted.wins++;
      else trusted.losses++;
    }

    return {
      receipt,
      isHost,
      peerWon,
      isDraw,
      myScore: isHost ? p.hostScore : p.guestScore,
      oppScore: isHost ? p.guestScore : p.hostScore,
      classification
    };
  });

  return {
    trusted,
    all,
    untrustedCount: all.total - trusted.total,
    items
  };
}

export function getVouchedFriendsList(graphData) {
  const ctx = buildTrustContext(graphData);
  return Array.from(ctx.vouchedMap.entries()).map(([playerId, info]) => ({
    playerId,
    displayTag: info.displayTag,
    hop: info.hop,
    viaName: info.viaName
  }));
}
