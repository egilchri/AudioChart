/**
 * AudioChart — named "Test Set" localStorage read/write helpers. A Test
 * Set is a permanent, named SNAPSHOT of waypoints (name/lat/lon copied at
 * save time, not a live reference) meant for repeatable testing — per
 * direct request: "save [SP markers] as TS markers and have a way of
 * bringing them to the screen for testing." A copy, not a live reference,
 * because a Test Set has to keep working as a fixed set of test
 * coordinates regardless of what later happens elsewhere — its own
 * waypoints are only ever removed via deleteTestSet/deleteTestSetWaypoint
 * below, never as a side effect of editing a regular wp* or SP* waypoint.
 * (Saving DOES convert the source SP* waypoints into a set — direct
 * request, 2026-09-28: they're renamed to TS00N and removed from the
 * regular waypoint list at save time, in app.js's own save handler, not
 * left behind as a duplicate. This module has no opinion on that; it just
 * stores whatever waypoints array the caller hands it.) Pure reads/writes,
 * no map/UI dependency — same split as waypoints_storage.js.
 */

export const TEST_SETS_KEY = 'audiochart-test-sets';
const VISIBLE_KEY = 'audiochart-test-sets-visible';

export function loadTestSets() {
  try { return JSON.parse(localStorage.getItem(TEST_SETS_KEY) || '[]'); } catch { return []; }
}

function _saveAll(sets) {
  localStorage.setItem(TEST_SETS_KEY, JSON.stringify(sets));
}

// Pre-fills the "name this Test Set" prompt with a reasonable default —
// the SET's own name (a free-text description, e.g. "Archipelago test
// points"), not the per-MARKER "TS001" labels below. Deliberately not
// TS-prefixed itself, so it can't be confused with those marker labels
// once several sets are on screen at once.
export function nextTestSetDefaultName() {
  return `Test Set ${loadTestSets().length + 1}`;
}

// Every marker ever saved into a Test Set gets its own sequential,
// globally-unique "TS00N" label (per direct request) — continuing across
// ALL saved sets, not restarting per set, so two sets shown on the map at
// the same time never show a duplicate "TS001" label. The original SP*/
// wp* name is kept as origName (shown in the marker's popup) so the
// point it came from is still traceable.
function _nextTestMarkerNum(sets) {
  let maxNum = 0;
  for (const s of sets) {
    for (const wp of s.waypoints) {
      const m = /^TS(\d+)$/.exec(wp.name);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
  }
  return maxNum;
}

// waypoints: [{name, lat, lon}, ...] — copied by value, not stored by
// reference, so later edits to the live waypoint list never affect an
// already-saved Test Set.
export function saveTestSet(name, waypoints) {
  const sets = loadTestSets();
  let num = _nextTestMarkerNum(sets);
  const entry = {
    id: `ts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    name,
    createdAt: new Date().toISOString(),
    waypoints: waypoints.map(w => ({
      name: `TS${String(++num).padStart(3, '0')}`,
      lat: w.lat,
      lon: w.lon,
      origName: w.name,
    })),
  };
  sets.push(entry);
  _saveAll(sets);
  return entry;
}

export function deleteTestSet(id) {
  _saveAll(loadTestSets().filter(s => s.id !== id));
  const visible = loadVisibleTestSetIds();
  if (visible.has(id)) { visible.delete(id); _saveVisibleTestSetIds(visible); }
}

// Removes a single marker from a Test Set (its own TS00N name, not the
// set's own name/id). If that was the last marker, deletes the whole
// (now-empty, no longer useful) set — same cleanup deleteTestSet does.
export function deleteTestSetWaypoint(setId, waypointName) {
  const sets = loadTestSets();
  const set = sets.find(s => s.id === setId);
  if (!set) return;
  set.waypoints = set.waypoints.filter(w => w.name !== waypointName);
  if (set.waypoints.length === 0) {
    deleteTestSet(setId);
    return;
  }
  _saveAll(sets);
}

export function loadVisibleTestSetIds() {
  try { return new Set(JSON.parse(localStorage.getItem(VISIBLE_KEY) || '[]')); } catch { return new Set(); }
}

function _saveVisibleTestSetIds(idSet) {
  localStorage.setItem(VISIBLE_KEY, JSON.stringify([...idSet]));
}

export function setTestSetVisible(id, visible) {
  const ids = loadVisibleTestSetIds();
  if (visible) ids.add(id); else ids.delete(id);
  _saveVisibleTestSetIds(ids);
}
