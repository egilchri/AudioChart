/**
 * Pure merge logic for syncing Routes/Tracks across devices via a single
 * shared Drive blob. No localStorage/Drive/DOM access here — everything
 * takes plain arrays in and returns plain arrays out, so it's easy to
 * hand-verify in isolation.
 */

function _newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * One-time, in-place backfill for items saved before id/updatedAt existed.
 * Same-named items in the same array get distinct ids (`legacy:name`,
 * `legacy:name#2`, ...) so two unrelated items that happen to share a
 * generic name (e.g. two GPX imports both named "Route 1") don't silently
 * collapse into one and lose data.
 */
export function migrateLegacyIds(items) {
  const seen = new Map(); // name -> count
  for (const item of items) {
    if (item.id) continue;
    const n = seen.get(item.name) || 0;
    seen.set(item.name, n + 1);
    item.id = n === 0 ? `legacy:${item.name}` : `legacy:${item.name}#${n + 1}`;
    if (typeof item.updatedAt !== 'number') item.updatedAt = 0; // sentinel: "unknown/legacy"
  }
  return items;
}

export function contentEquals(a, b) {
  return a.name === b.name && JSON.stringify(a.points) === JSON.stringify(b.points);
}

/**
 * Merge one collection (routes, or tracks) from two sources.
 * @returns {{merged: object[], tombstones: object[], conflictCount: number, conflicts: {id, name}[]}}
 */
export function mergeCollections({ localItems, remoteItems, localTombstones, remoteTombstones, now = Date.now() }) {
  const tombById = new Map();
  for (const t of [...localTombstones, ...remoteTombstones]) {
    const existing = tombById.get(t.id);
    if (!existing || t.deletedAt > existing.deletedAt) tombById.set(t.id, t);
  }

  const byId = new Map();
  const conflicts = [];
  const usedNames = new Set();

  function isTombstoned(item) {
    const t = tombById.get(item.id);
    return t && !(item.updatedAt > t.deletedAt); // edit-after-delete = undelete
  }

  function place(item) {
    if (isTombstoned(item)) return;
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      usedNames.add(item.name);
      return;
    }
    if (contentEquals(existing, item)) {
      // Same content either side — keep whichever has the higher updatedAt (or existing on a tie).
      if (item.updatedAt > existing.updatedAt) byId.set(item.id, item);
      return;
    }
    if (item.updatedAt !== existing.updatedAt) {
      // Genuine timestamps disagree — last write wins.
      if (item.updatedAt > existing.updatedAt) byId.set(item.id, item);
      return;
    }
    // Tied (both real edits at the same instant, or both legacy sentinel 0) with
    // genuinely different content — don't guess, keep both as a conflict copy.
    let name = `${item.name} (conflict copy)`;
    let suffix = 2;
    while (usedNames.has(name)) name = `${item.name} (conflict copy ${suffix++})`;
    usedNames.add(name);
    const copy = { ...item, id: _newId(), name, updatedAt: now };
    byId.set(copy.id, copy);
    conflicts.push({ id: copy.id, name: copy.name });
  }

  for (const item of localItems) place(item);
  for (const item of remoteItems) place(item);

  return {
    merged: [...byId.values()],
    tombstones: [...tombById.values()],
    conflictCount: conflicts.length,
    conflicts,
  };
}

/** Count-capped, not age-capped — this app's usage scale never realistically fills this,
 *  and age-based pruning would risk resurrecting items deleted while another device was
 *  offline for a season. */
export function pruneTombstones(tombstones, { maxCount = 2000 } = {}) {
  if (tombstones.length <= maxCount) return tombstones;
  return [...tombstones].sort((a, b) => b.deletedAt - a.deletedAt).slice(0, maxCount);
}
