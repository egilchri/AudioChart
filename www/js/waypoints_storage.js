/**
 * AudioChart — user-waypoint localStorage read/naming helpers. Pure reads
 * and string logic, no map/UI dependency — waypoint map RENDERING
 * (_refreshWaypointLayer in app.js) stays put, it's genuinely tangled into
 * the map/popup UI (rename/delete/focus/AutoRoute buttons, a bridge into
 * the _ensureMap() closure) and wasn't a safe extraction this pass. See the
 * reliability-overhaul plan (Phase 3) for the full rationale.
 */

export const USER_WP_KEY = 'audiochart-user-waypoints';

export function loadUserWaypoints() {
  try { return JSON.parse(localStorage.getItem(USER_WP_KEY) || '[]'); } catch { return []; }
}

// Each prefix keeps its own numbering — a quick-dropped "wp003" and a
// search-dropped "SP003" coexisting is fine, but they shouldn't share one
// counter (searching a few places would otherwise burn through numbers a
// manually-dropped waypoint would expect to get, and vice versa).
function _nextNumberedWaypointName(prefix) {
  const nums = loadUserWaypoints()
    .filter(w => w.name.startsWith(prefix))
    .map(w => parseInt(w.name.slice(prefix.length), 10))
    .filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return prefix + String(next).padStart(3, '0');
}
export function nextWaypointName() { return _nextNumberedWaypointName('wp'); }
export function nextSearchPinName() { return _nextNumberedWaypointName('SP'); }
