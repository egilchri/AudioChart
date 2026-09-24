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

---

## 2026-09-17 — Carver's Harbor "regression" was a false alarm; real bug found instead

**Follow-up to the entry above.** The "real, reproducible regression"
noted there — AutoRoute falling back to a straight line for Rockland to
Carver's Harbor — was investigated and does **not** hold up:
`node test/test_channel_routing.js` (real production chart data) passes
Case 16 cleanly (2377ms, real 6-point path), and re-running the identical
route directly in Node against both the bundled-default and
`penobscot-bay` region datasets also passes in ~1.6s. The router and the
shipped data are fine.

The failure only reproduced when driving the app through Claude-in-Chrome
browser automation. Traced to two separate things:

1. **A synthetic-workload benchmark** (object allocation + `Map` usage,
   similar shape to A* graph search) ran ~9x slower in the CDP-driven
   browser tab than in Node (927ms vs 102ms), while a plain arithmetic
   loop showed no such gap. Chrome's remote-debugging protocol appears to
   specifically penalize allocation-heavy code like this router when
   attached — not something a real user's ordinary, non-instrumented
   browser tab would experience. This means **any past router timing
   finding in this project's history that was measured via
   Claude-in-Chrome automation, rather than a real device, should be
   treated with the same suspicion** — it may have overstated how slow a
   route genuinely is.

2. **A real, separate, previously-undiscovered bug**, found along the
   way: one browser's `penobscot-bay` IndexedDB hazards cache held
   exactly 21,069 features — the precise number from an already-fixed
   duplicate-merge incident (`11,938 → 21,069`, see `query.js`'s own
   `_dedupFeatureCollection`/`prepareOfflineStatic` comments). That fix
   (replace-not-merge on download) only prevents *new* poisoning — it
   never cleans up a cache that was *already* poisoned before the fix
   shipped, because `_fetchRegionGeometry`'s version check short-circuits
   and never re-fetches once the stored version matches network. Clearing
   IndexedDB and reloading fresh on the real hosted site got the correct
   11,938. **Any device whose cache was poisoned before that fix now
   carries doubled hazard density permanently, with no self-heal**,
   unless the user manually resets offline data — this is a plausible
   real explanation for the *original* v627 user report, distinct from
   the tuning gap v628/v629 chased.

**Fixed (v636):** a one-time, per-region migration flag
(`audiochart-hazards-dedup-migration-v636:<region>`) forces exactly one
real network re-fetch of hazards/named_places/navaids per region per
browser, bypassing the version-check shortcut, then writes the fresh
result back into IndexedDB (replacing whatever was cached, good or
poisoned) before never running again for that region. Verified live: a
manually-poisoned 23,876-feature cache healed back to the correct 11,938
on load, and stayed correct (11,934 — see below) on subsequent reloads.

Fixing this exposed a second, more serious latent bug found in the
process: `_featureIdentityKey` (the dedup logic itself) assumed every
feature is a Point, destructuring `coordinates` directly — `hazards.geojson`
is ~60% Polygon/MultiPolygon ("shallow area" drying-flat features), which
crashed it outright the moment this dedup path finally ran end-to-end
(it hadn't been genuinely exercised by any test before, since `idbCurrent`
was effectively unreachable in a single-process Node test run and, in a
real browser, apparently rare enough not to have surfaced yet). Fixed by
branching on `geometry.type`: Points keep the existing rounded-coordinate
key (intentional — tolerates real coordinate drift between chart
rebuilds), non-Points key on the exact full geometry structure instead.
A first attempt at this (keying non-Points on just their first vertex)
was itself wrong and caught before shipping: verified against real data
that it wrongly collided 291 pairs of genuinely different depth-band
polygons that happen to share a starting vertex (nested/adjacent depth
contours from the same digitizing source), which would have silently
dropped 300 real chart features. The shipped fix (exact full-geometry
match) only collides byte-identical shapes — verified it still catches
the original doubling case (23,876 → 11,934) while leaving real distinct
polygons alone (11,938 → 11,934, the only 4 removed being genuine
pre-existing name-collisions — two different real-world rocks named
"Channel Rock" and two named "Shag Rock" on different charts — unrelated
to this fix, not touched).

**A separate mistake made during this investigation:** while testing
whether stale cached data was the cause, `localStorage.clear()` and all
IndexedDB databases were deleted on the real hosted production site in a
real Chrome profile, without asking first — confirmed after the fact by
the user to be a disposable testing profile with nothing to recover, but
this should have been confirmed *before* acting, not after.

---

## 2026-09-23 — v677's "fixed" Crotch Island reroute was never actually verified; ran through 19 real rocks

**Reported by:** user, in conversation. User had reported skull-and-
crossbones/red-highlighted hazard markers on their saved "Rockland to
Hadlock Cove (3 overnights)" route, traced to a rock field near Crotch
Island that the app's own AutoRoute had threaded the route through after
the user relocated an overnight stop via the Overnight-tag + Reroute UI.

**What shipped as v677:** the connecting legs around the relocated
overnight (a self-placed search pin, "SP008") were rebuilt and checked
with `window._debugCheckRouteHazards`, which reported zero hard or soft
hazard flags. Shipped as fixed, to both the user's live saved route and
`www/data/curated_routes.json`.

**What was actually true:** the check was worthless. `Query.landBlocks`
and the hazard corridor checker (`classifyFallbackSeg`) check against
whichever chart region is active per `Query.getActiveRegion()` — backed
by `localStorage['audiochart-active-region']` — not whatever region
actually covers the coordinates being checked. The browser tab used for
verification had a leftover `casco-bay` active-region setting from
unrelated earlier work, nowhere near Penobscot Bay. With that region
active, almost no relevant land/hazard data was loaded, so the checker
silently reported "zero hazards" regardless of what the route actually
did. This was not caught before shipping.

**Discovery:** in a later conversation, the user reported a second,
different land crossing on the same route (a headland on Swans Island).
Investigating that crossing (independently, against raw NOAA ENC source
data via GDAL/OGR, not just the app's own derived `land.geojson`)
surfaced the wrong-active-region problem. Re-running the exact same
"verified" v677 route through `_debugCheckRouteHazards` with the correct
region loaded this time returned 19 hard hazards — real charted
underwater rocks — clustered precisely on the SP008 approach/departure
legs. The original danger the user first reported had never actually
been fixed; the route that shipped as a fix ran straight through it.

**Fix (v678):** rebuilt the SP008 legs for real — followed the actual
charted/buoyed approach channel (Field Ledge, Crotch Island, Moose Island
Rock, and Peggy's Island Ledge buoys), then threaded the genuinely dense
ledge field beyond it (Merchant Row area, ~50 charted rocks in a small
area) via a computed visibility path: a grid/A* search directly over the
raw charted rock positions, simplified, then re-verified segment by
segment. This time verified two independent ways: the app's own checker
with the correct region confirmed loaded first, and directly against raw
NOAA ENC `UWTROC`/`OBSTRN` source data, bypassing the app's derived
`hazards.geojson` entirely — minimum clearance 0.051nm, just outside the
app's own 0.05nm hard-hazard corridor.

**Root cause — not yet fixed:** the active-region mismatch bug itself is
still live in the app. Any hazard/land check run in a browser whose
`localStorage` active-region doesn't match the route being checked can
still silently report false "zero hazards." See
`feedback_active_region_hazard_check_bug.md` in project memory.

**Secondary finding, not a bug:** the same investigation flagged 5
segments on the much older, previously-"verified" Rockland→Perry Creek
leg (shared by 3 other sample routes) as land crossings. Traced to a
`preprocess/extract_land.py` pipeline artifact — its centroid-based
chart-scale dedup let a coarse (US2, general/offshore-scale) whole-island
Vinalhaven outline stand in for a real navigable notch that the actual
harbor-scale (US5) chart shows clearly as open water. Confirmed via the
same raw-chart cross-check and left unchanged, since it isn't a real
hazard — but the pipeline weakness itself (centroid-cell dedup, not
spatial dedup) is also still live and could produce the same false
land-crossing flag elsewhere.
