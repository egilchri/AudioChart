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

---

## 2026-09-17 — v633's "fixed" Warren Island anchorage position was still on land

**Discovered while:** building a new "Rockland to Warren Island" sample
route and guided tour (v635) — not user-reported.

**What v633 claimed:** the same commit that fixed 19 on-land anchorage
markers moved Warren Island State Park's anchorage point from the
island's generic (on-land) centroid to "the island's eastern shore,
adjacent to the pier," with the commit message stating each new position
was "verified against real chart data to confirm each new position is in
water."

**What was actually true:** `Query.isLandAt(-68.942974, 44.2726)` — the
same function AutoRoute itself uses to decide whether a segment crosses
land — returned `true` for that v633 point. It was still on land. Mapping
the coastline around it with a grid of `isLandAt()` probes showed the
real water was a very narrow (~50-75m) channel gap immediately next to
the point, easy to miss by eye or with an approximate coordinate, but a
real, checkable fact the v633 fix apparently never actually checked
against `isLandAt()` — despite the commit message's "verified" claim.

**Why this matters:** any anchorage's "Navigate to here" button
(shipped v634) silently depends on its stored coordinate being real
water — a marker positioned on land makes AutoRoute either fail to find
a path or fall back to a straight line that crosses land, with no
indication to the user that the destination itself was the problem.

**Fix (v635):** re-positioned to a confirmed-clear point off the
island's north end (documented in `documents.geojson`'s own
`positionNote`), verified two ways: `Query.isLandAt()` directly, and a
live `Router.autoRouteProg()` call from Rockland that now threads a real
multi-point path (not a fallback line) — the same regression-check
standard `window._verifyCuratedRoutes()` applies to the curated-routes
library. Also confirmed unrelated: a fresh `_verifyCuratedRoutes()` run
now shows the pre-existing "Rockland to Carver's Harbor" curated route
failing (AutoRoute falls back to a line crossing land for that corridor)
— a real, reproducible regression, unrelated to this fix, not
investigated further here.

**Follow-up, done same day:** ran `Query.isLandAt()` against all 60
`category: "anchorages"` points in `documents.geojson` (not just the 19
from v633) — Warren Island was the only one on land. No further cleanup
needed.
