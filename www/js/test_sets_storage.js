/**
 * AudioChart — named "Test Set" localStorage read/write helpers. A Test
 * Set is a permanent, named SNAPSHOT of waypoints (name/lat/lon copied at
 * save time, not a live reference) meant for repeatable testing — per
 * direct request: "save [SP markers] as TS markers and have a way of
 * bringing them to the screen for testing." Deliberately a snapshot, not
 * a reference to the live SP/wp waypoints: a Test Set has to keep working
 * as a fixed set of test coordinates even after the SP markers it was
 * built from are later renamed, moved, or bulk-deleted (see app.js's
 * existing "Delete all SP* waypoints" action). Pure reads/writes, no
 * map/UI dependency — same split as waypoints_storage.js.
 */

export const TEST_SETS_KEY = 'audiochart-test-sets';
const VISIBLE_KEY = 'audiochart-test-sets-visible';

export function loadTestSets() {
  try { return JSON.parse(localStorage.getItem(TEST_SETS_KEY) || '[]'); } catch { return []; }
}

function _saveAll(sets) {
  localStorage.setItem(TEST_SETS_KEY, JSON.stringify(sets));
}

// Mirrors waypoints_storage.js's own _nextNumberedWaypointName — used only
// to pre-fill the "name this Test Set" prompt with a reasonable default;
// the user can always rename it to something descriptive before saving.
export function nextTestSetName() {
  const nums = loadTestSets()
    .map(s => parseInt(s.name.replace(/^TS/, ''), 10))
    .filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return 'TS' + String(next).padStart(3, '0');
}

// waypoints: [{name, lat, lon}, ...] — copied by value, not stored by
// reference, so later edits to the live waypoint list never affect an
// already-saved Test Set.
export function saveTestSet(name, waypoints) {
  const sets = loadTestSets();
  const entry = {
    id: `ts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    name,
    createdAt: new Date().toISOString(),
    waypoints: waypoints.map(w => ({ name: w.name, lat: w.lat, lon: w.lon })),
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
