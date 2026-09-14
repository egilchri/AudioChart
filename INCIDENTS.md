# Incidents

Real (or credibly reported) data-loss, corruption, or trust-breaking bugs —
not general bug tracking. Each entry captures what was reported, what was
found, and what shipped, even when the root cause couldn't be confirmed.

---

## 2026-09-14 — "Delete all SP* waypoints" reported to delete non-SP waypoints

**Reported by:** user, in conversation (no reproduction steps, reported
after the fact): the "Delete all SP* waypoints" button (map long-press →
Waypoints submenu; handler `map-ctx-wp-del-sp` in `www/js/app.js`, shipped
v609) deleted waypoints other than the SP*-prefixed search pins it's meant
to target. User recovered the missing waypoints via "a sync," and asked
whether it's now safe to use the button again.

**Investigation (against v629):**
- Read the handler end-to-end (`www/js/app.js` ~line 8391). The "what to
  delete" and "what to keep" sets are both derived from the same
  `w.name.startsWith('SP')` filter, applied to an un-mutated array read
  once via `WaypointsStorage.loadUserWaypoints()`. No code path found in
  the current version that would sweep in a non-SP-named waypoint.
- Checked what "a sync" could plausibly have restored. Google Drive sync
  (`www/js/drive_sync.js`) only ever reads/writes `audiochart-user-routes`
  and `audiochart-user-tracks` — personal waypoints
  (`audiochart-user-waypoints`) are never part of it, and there's no other
  backup or export path for personal waypoints anywhere in the app.
- This is an open contradiction: nothing in the current code would let a
  sync bring back a wiped local waypoint list. Two unconfirmed
  possibilities: (a) the incident happened on a different/older code path
  than what's in v629, or (b) "sync" refers to the separate OpenCPN
  boat-server waypoint feed (`Query.refreshWaypoints`, polled via
  `_serverBase`/`/api/waypoints`), which is a server-authoritative data
  source merged into the same in-memory list via `Query.mergeUserWaypoints`
  — distinct from the local pin list `WaypointsStorage` and the delete
  button operate on. Neither was confirmed with the user.

**Status:** Root cause not confirmed. No reproduction found against
current code.

**Mitigation shipped:** the confirm dialog now lists every waypoint name
about to be deleted, not just a count, so an unexpected name is visible
before committing to an unrecoverable delete (`www/js/app.js`, uncommitted
as of this writing — pending a version bump and explicit "commit and push
it").

**Follow-up not yet done:** there is still no backup/export path for
personal waypoints (routes/tracks have Drive sync + GPX export; waypoints
have neither). Worth adding one so a bad delete of any kind is
recoverable, independent of whether this specific bug is ever reproduced.
