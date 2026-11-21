import { MATCH_MODES } from '../config/constants.js';
import { formatTimeClock } from '../game/MatchSettings.js';

export function formatRecord(stats) {
  const wins = stats?.wins || 0;
  const losses = stats?.losses || 0;
  const draws = stats?.draws || 0;
  return `${wins}W–${losses}L${draws ? `–${draws}D` : ''}`;
}

export function formatTimestamp(ts) {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
}

export function formatReceiptMode(settings) {
  if (!settings || !settings.mode) return 'Match';
  switch (settings.mode) {
    case MATCH_MODES.FIRST_TO:
    case 'firstTo':
      return settings.targetScore ? `First to ${settings.targetScore}` : 'First to X';
    case MATCH_MODES.WIN_BY_2:
      return settings.targetScore ? `Win by 2 (${settings.targetScore})` : 'Win by 2';
    case MATCH_MODES.TIMED:
      return settings.timeLimitSec ? `Timed (${formatTimeClock(settings.timeLimitSec)})` : 'Timed';
    case MATCH_MODES.ENDLESS:
      return 'Endless';
    default:
      return settings.mode;
  }
}
