# Adventure Tests

A running log of user-submitted route tests, checked against live production
chart data with `node test/test_route_hazard_clearance.js <route.json>`.
Goal (user's framing): gradually eliminate as many warnings as possible.
Each entry is a snapshot — re-run the same route later to see whether a fix
actually helped.

"Hard" hazards = underwater rock / obstruction / wreck (not tide-dependent,
always worth fixing). "Shallow area" hits are draft/tide-dependent — the
router's live avoidance is tide-aware; the checker here is not, so these are
not automatically real problems, just worth a look.

---

## Test 1 — 2026-08-24 (v417)
Rockland Harbor western approach → toward Fox Islands Thorofare.
7 points, ~9.1nm.

**3 findings, all soft (shallow area only, no hard hazards):**
- (0.0-5.4m) at 6.89nm — leg (44.102051,-68.94648)→(44.108637,-68.929255)
- (0.0-5.4m) at 7.25nm — leg (44.108637,-68.929255)→(44.1134,-68.923127)
- (0.0-5.4m) at 8.36nm — leg (44.122957,-68.90324)→(44.127822,-68.886907)

All three cluster around Rockland Harbor's main approach (lon -68.94 to
-68.89), which has **no channel-graph coverage** — its FAIRWY polygon
exists in the source chart data but the medial-axis algorithm couldn't
resolve its shape (`build_channel_graph.py` logs "SKIP unresolved medial
axis" for Rockland Harbor Main Channel). Flagged, not yet fixed.

## Test 2 — 2026-08-24 (v417)
Continues from test 1's end → Fox Islands Thorofare → Stonington approach.
11 points, ~9.3nm.

**12 findings, 2 hard:**
- **Above-water obstacle** at 3.25nm — leg (44.133129,-68.840748)→(44.134212,-68.77625).
  Same Fox Islands Thorofare stretch flagged in the prior session's "why
  can't it avoid those first hazards" investigation — recurring, not a
  one-off. [[project_fallback_warning_accuracy]]
- **Underwater rock** at 9.06nm (marginal, ~92m off line) — leg
  (44.149671,-68.669229)→(44.152199,-68.66435), the final approach into
  Stonington.
- 10 shallow-area crossings, scattered through the middle of the route.

## Test 3 — 2026-08-24 (v417)
Continues east past Stonington into Merchant Row / Eggemoggin Reach
territory. 13 points, ~10.6nm.

**3 findings, all soft.** Cleanest test so far — no hard hazards at all.
- (1.8-3.6m) at 1.04nm, (0.0-5.4m) at 3.71nm, (0.0-5.4m) at 8.75nm.

## Test 4 — 2026-08-24 (v417)
Toward Great Cranberry Island (destination not given as town dock). 12
points, ~14.3nm.

**7 findings, all soft.** No hard hazards.
- (0.0-5.4m) at 1.36nm, (0.0-5.4m) at 2.80nm
- 5 more (0.0-1.8m / 1.8-3.6m) clustered right at arrival, ~14.0-14.3nm —
  route landed on Great Cranberry's **south shore** in shallow water, not
  the harbor. Prompted [[feedback_small_island_town_dock]]: assume the town
  dock for small-island destinations going forward.

## Test 5 — 2026-08-24 (v417)
Toward Northeast Harbor (destination not specified). 4 points, ~1.3nm.

**1 finding, trivial:** (1.8-3.6m) at 0.04nm, right at departure.
Endpoint landed in Gilpatrick Cove, ~1.2nm short of Northeast Harbor's
actual dock — same town-dock-default issue as test 4, broadened
[[feedback_small_island_town_dock]] to cover unspecified destinations
generally, not just small islands by name.

## Test 6 — 2026-08-24 (v417/v418)
Intended "head of Somes Sound, where the town dock is." 6 points, ending at
(44.307259,-68.30801).

**Not yet hazard-checked — investigation in progress, paused mid-session.**
Confirmed via named_places.geojson + test 7's start point that the route's
end (44.307,-68.308) is **~3.3nm short of the real head** (Somesville, near
44.36,-68.328). `Query.resolveWaterEnd(lon, lat, 'head')` in query.js is the
ray-casting resolver responsible — added `window._debugResolveWaterEnd` (v418)
to test it live, but did not get to run it before the user asked to pause.
**Next step: call the debug hook against the Somes Sound seed point and find
why 'head' stopped early.**

## Test 7 — 2026-08-24 (v417)
Starts at the real head of Somes Sound (44.361972,-68.327533, per the user)
→ south through the sound → toward Northeast Harbor. 6 points, ~7.8nm.

**1 finding, trivial:** (1.8-3.6m) at 7.79nm, near the very end.

---

## Open items carried forward
- ~~**Somes Sound head resolution**~~ — fixed v419: `resolveWaterEnd`'s
  'head' search now iterates (re-scans from where it stops) instead of
  committing to one fixed bearing, so it follows a bend instead of stopping
  at it.
- ~~**Rockland Harbor Main Channel**~~ — fixed v422: its medial axis had one
  small Voronoi-artifact loop (not real complexity), which was tripping the
  "too many edges" quality gate. `break_artifact_cycles` (Kruskal's MST over
  the edge set) breaks it back into a clean tree. Now 7 clean edges, zero
  land crossings.
- **Fox Islands Thorofare above-water obstacle** (test 2, leg
  (44.133129,-68.840748)→(44.134212,-68.77625)): recurring across sessions,
  still open — this is the extreme-hazard-density base-router limitation
  from [[project_fallback_warning_accuracy]], deferred pending more testing
  per the user's call.
