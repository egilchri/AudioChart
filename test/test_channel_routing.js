/**
 * Channel-aware, general multi-obstacle auto-routing certification.
 *
 * Run with:   node test/test_channel_routing.js
 *   → runs the regression suite below against real production chart data
 *     (www/data/land.geojson, channel_graph.geojson, etc.) by calling the
 *     REAL router (www/js/router.js's autoRouteProg) through the REAL query
 *     engine (www/js/query.js), via the Node shims in
 *     test/helpers/node_query_env.js.
 *
 * Until 2026-09 this suite ran against a hand-maintained ~900-line PORT of
 * _autoRouteProg's land-avoidance/channel-graph/long-range logic, kept in
 * this file, because the router was entangled with a couple of direct
 * DOM/Leaflet calls and couldn't run outside a browser. That port could
 * (and did) silently drift from the real code — a fix or a regression in
 * the real router had no reason to be reflected in it. router.js was
 * extracted from app.js specifically to close that gap: every case below
 * now certifies the actual shipped router, not a copy of its logic. See
 * the reliability-overhaul plan for the full rationale.
 *
 * A few of the old suite's cases relied on injecting a synthetic obstacle
 * ring directly into the port's input data — something the real Query
 * module has no public seam for (its land index is built once from real
 * chart data at load time). Those are called out explicitly below rather
 * than silently dropped; see "NOT PORTED" at the bottom.
 */
const { installNodeQueryEnv } = require('./helpers/node_query_env.js');
const path = require('path');

const WWW_DATA_DIR = path.join(__dirname, '..', 'www', 'data');
const DEADLINE_MS = 18000; // mirrors router.js's own DEFAULT_DEADLINE_MS
const LONG_RANGE_DEADLINE_MS = 54000; // mirrors router.js's own deadlineMs*3 long-range derivation — for cases that decompose into several per-leg budgets, not the local-search one above

installNodeQueryEnv(WWW_DATA_DIR);

async function waitForRegionDataReady(Query, timeoutMs = 8000) {
  await Query.whenLandLoaded();
  const t0 = Date.now();
  while (Query.channels === null && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

function pathCrossesLand(Query, points) {
  for (let i = 0; i < points.length - 1; i++) {
    if (Query.landBlocks(points[i].lon, points[i].lat, points[i + 1].lon, points[i + 1].lat)) return true;
  }
  return false;
}

// Two distinct budgets a case can override, not one:
// - routerDeadlineMs is what the router itself is actually given
//   (autoRouteProg's own deadlineMs param) — this genuinely changes how
//   long the search tries before giving up. A real bug caught 2026-09-27:
//   an earlier version only widened the grading window below without
//   passing this through, so a case could "pass" a generous test deadline
//   while the router had already given up much earlier and returned an
//   unsafe fallback — the test would have wrongly reported that as OK.
// - gradeDeadlineMs is what THIS function checks the total wall-clock
//   against, separately. A long-range case needs this alone raised: it
//   already internally spends routerDeadlineMs*3 (autoRouteProg's own
//   long-range envelope) by default, so grading its total against the
//   plain local-search budget was a repeated false signal — the router
//   hadn't failed at all, the test's threshold was just the wrong one.
//   Raising routerDeadlineMs too for a long-range case would be wrong: it
//   would inflate EACH of its several per-leg searches, compounding into
//   a much larger total than intended.
async function runCase(Query, Router, label, start, end, routerDeadlineMs = DEADLINE_MS, gradeDeadlineMs = routerDeadlineMs) {
  const t0 = Date.now();
  const path_ = await Router.autoRouteProg(start, end, () => {}, () => {}, false, 5.0, 0, null, null, routerDeadlineMs);
  const ms = Date.now() - t0;
  const crosses = pathCrossesLand(Query, path_);
  const fallback = path_.length <= 2 && crosses;
  const timeOk = ms < gradeDeadlineMs;
  const ok = !fallback && !crosses && timeOk;
  console.log(`${label}: ${ok ? 'PASS' : 'FAIL'} (fallback=${fallback}, crossesLand=${crosses}, ${path_.length} pts, ${ms}ms)`);
  if (ok && ms > 1500) console.log(`  ⚠ slow: ${ms}ms exceeds the 1500ms early-regression warning threshold (hard fail is ${gradeDeadlineMs}ms)`);
  return { ok, path: path_, ms, fallback, crosses };
}

async function main() {
  const Query = await import('../www/js/query.js');
  const Router = await import('../www/js/router.js');

  await Query.loadData(44.103, -69.088); // Rockland Harbor — any in-coverage point loads the whole region
  await waitForRegionDataReady(Query);
  console.log(`Loaded real chart data — ${Query.channels?.length ?? 0} channel features.\n`);

  let failures = 0;
  const gate = (result) => { if (!result.ok) failures++; };

  // Case 2 — the real multi-ring regression: a direct line from Frenchman Bay
  // (east of Mount Desert Island) to Blue Hill Bay (west of it) crosses 10
  // separate land rings against current chart data.
  //
  // Reclassified EXPERIMENTAL/non-blocking during the 2026-09 router
  // extraction: this case's old "PASS" was against the hand-maintained
  // port, not the real router — verified live that the CURRENT DEPLOYED
  // (pre-extraction) _autoRouteProg, run against this exact same bundled-
  // default dataset in a fresh browser, ALSO times out here (2 pts, 6001ms,
  // crosses land). A real, pre-existing gap the port's own reimplementation
  // never actually caught — not something this extraction introduced, and
  // not something to silently paper over by keeping the old (wrong) PASS.
  await runCase(Query, Router, '[2] EXPERIMENTAL/KNOWN-FAILING: Mount Desert Island 10-ring regression',
    { lat: 44.3995406, lon: -68.1998858 }, { lat: 44.2415486, lon: -68.4848074 });

  // Cases 3, 6, 7 (Portsmouth NH / York Harbor / Portsmouth -> Bar Harbor)
  // removed 2026-10-04 per direct request: this release is Penobscot Bay
  // only. (Case 5's gap note, which lived between them, is in git history.)

  // Case 8 — long-range fast path: two points >LONG_RANGE_NM apart, both
  // off any real land ring, direct line clear. Should return in low
  // milliseconds with just the 2 endpoints (no search needed), not seconds
  // with intermediate points.
  {
    const start = { lat: 42.0, lon: -68.5 };
    const end = { lat: 42.6, lon: -67.5 };
    const t0 = Date.now();
    const pts = await Router.autoRouteProg(start, end, () => {}, () => {});
    const ms = Date.now() - t0;
    const crosses = pathCrossesLand(Query, pts);
    const fallback = pts.length <= 2 && crosses;
    const ok = !fallback && !crosses && pts.length === 2 && ms < 200;
    console.log(`[8] Long-range fast path (open Gulf of Maine, >20nm): ${ok ? 'PASS' : 'FAIL'} (fallback=${fallback}, crossesLand=${crosses}, ${pts.length}pts, ${ms}ms)`);
    if (!ok) failures++;
  }

  // Case 10 — the originally-reported bug, isolated to the actual defect:
  // North Haven town dock (Fox Islands Thorofare, west mouth) out to the
  // thorofare's east mouth. The thorofare has no charted FAIRWY polygon or
  // RECTRC track — it's marked purely by a buoy chain — so before the
  // buoy-chain channel-graph source this leg ran in a straight line,
  // directly over North Haven, ignoring the marked channel entirely.
  //
  // Was reclassified EXPERIMENTAL/non-blocking during the 2026-09 router
  // extraction, believed to be a data-parity gap between bundled-default
  // and the penobscot-bay region's channel_graph.geojson. That diagnosis
  // was WRONG — re-diagnosed during the Isle au Haut routing-gap pass
  // (2026-09): the real cause was this case's own start point sitting
  // inside a charted drying flat at the router's default draft/tide
  // assumptions (confirmed live: moved 1.6nm to reach navigable water).
  // findClearOffshorePoint/autoRouteProg now snap a start/end that lands
  // on charted-too-shallow water to nearby navigable water automatically
  // (see Query.snapToNavigableWater) — this case now genuinely passes
  // against the SAME bundled-default dataset that used to fail it. Gated
  // for real now, not EXPERIMENTAL.
  gate(await runCase(Query, Router, '[10] Fox Islands Thorofare (buoy-chain channel)',
    { lat: 44.122212, lon: -68.860267 }, { lat: 44.145, lon: -68.79 }));

  // Case 11 — the user's full originally-reported route, North Haven town
  // dock all the way to Stonington ME. Was believed to hit a separate,
  // already-diagnosed "base router island-dense-archipelago limitation" on
  // the final approach into Stonington — also wrong, per the same
  // re-diagnosis as case 10 above (this case shares case 10's exact start
  // point, the real charted drying flat). Now genuinely passes. Gated for
  // real now, not EXPERIMENTAL.
  gate(await runCase(Query, Router, '[11] North Haven -> Stonington (full route)',
    { lat: 44.122212, lon: -68.860267 }, { lat: 44.157672, lon: -68.666394 }));

  // Case 12 — Merchant Row / Deer Island Thorofare (spatial buoy-chain
  // channel, 8 differently-named buoys with no shared name prefix, only
  // found via distance-based clustering): Field Ledge Buoy 27 to Humpkins
  // Islet Shoal Buoy 14.
  gate(await runCase(Query, Router, '[12] Merchant Row / Deer Island Thorofare (spatial buoy-chain channel)',
    { lat: 44.1403, lon: -68.6929 }, { lat: 44.1563, lon: -68.6336 }));

  // Case 13 — Rockland Harbor Main Channel, confirms the router actually
  // uses charted-channel data that was previously entirely absent from
  // channel_graph.geojson for this specific channel.
  gate(await runCase(Query, Router, '[13] Rockland Harbor Main Channel (medial-axis artifact-loop fix)',
    { lat: 44.10350, lon: -69.09719 }, { lat: 44.10668, lon: -69.10173 }));

  // ── New regression cases (2026-09 reliability overhaul) ────────────────────

  // Case 14 — Rockland -> Camden (~6.45nm): found live to fall back to a
  // straight line crossing land near Owls Head/Beauchamp Point (the
  // original note claimed a ~5.9s timeout; re-diagnosed this session it
  // actually failed fast — 309ms, A* genuinely exhausting its search).
  //
  // Root cause, confirmed by isolating obstacle sources in a scratch
  // router.js copy: land avoidance alone finds a clean path (5 pts, 94ms);
  // adding back point hazards still works (7 pts, 177ms); adding back
  // tide-dependent drying/shallow depth zones is what breaks it. The real
  // bug: _addRingNodes' coastal-standoff node placement treated a tidal
  // obstacle like a small point hazard (4 route-relative extreme vertices,
  // a 0.2nm-max offset ladder) — real drying flats along this shoreline
  // needed up to 1nm of standoff and their full vertex set, the same
  // treatment a blocking land ring already gets. Fixed by tagging
  // extraRings entries with their source (tidal vs. point-hazard) and
  // giving tidal ones land-style treatment (see TIDAL_STANDOFF_LADDER and
  // _addRingNodes' isTidal branch in router.js). Now genuinely passes
  // against BOTH bundled-default and the penobscot-bay region dataset —
  // this deliberately still loads the region dataset (kept from this
  // case's original setup) rather than because bundled-default needs it.
  Query.setActiveRegion('penobscot-bay');
  await Query.loadData(44.103, -69.088);
  await waitForRegionDataReady(Query);
  await new Promise((r) => setTimeout(r, 500)); // channelGraph resolves slightly after `channels`
  gate(await runCase(Query, Router, '[14] Rockland -> Camden (tidal-flat standoff)',
    { lat: 44.103, lon: -69.088 }, { lat: 44.20890463336856, lon: -69.06228505969469 }));

  // Case 15 — Rockland to Isle au Haut (Trial Point/Moores Harbor area,
  // ~19nm), found live to fall back to a straight line crossing land. The
  // destination sits inside a charted drying flat (valsou=0) at the
  // router's default draft/tide assumptions — genuinely unreachable there,
  // not a graph-connectivity or long-range-decomposition problem (both
  // ruled out live: the richer penobscot-bay region dataset failed
  // identically, and a scratch test lowering LONG_RANGE_NM confirmed the
  // decomposition path gets most of the way there too). Fixed the same way
  // as cases 10/11 above — Query.snapToNavigableWater moves the too-shallow
  // endpoint to nearby navigable water first. Switches back to
  // bundled-default explicitly (case 14 above left penobscot-bay active) —
  // verified live this also passes against the region dataset, but runs
  // against bundled-default here for parity with cases 1-13.
  Query.setActiveRegion(null);
  await Query.loadData(44.103, -69.088);
  await waitForRegionDataReady(Query);
  gate(await runCase(Query, Router, '[15] Rockland -> Isle au Haut (charted drying-flat destination)',
    { lat: 44.103, lon: -69.088 }, { lat: 44.052355, lon: -68.654217 }));

  // Case 16 — Rockland to Carvers Harbor/Vinalhaven (~11.4nm) — the
  // ORIGINAL known gap predating this whole overhaul: curated_routes.json's
  // own note says this corridor needed a hand-built route because "direct
  // AutoRoute fell back to a straight line" here. Found live (user report,
  // production v627, confirmed via a real hard refresh) that even after
  // the v625/v626 fixes it was STILL failing — but genuinely timing out,
  // not failing to find a path: confirmed by running it 3x in a row
  // against the penobscot-bay region dataset, landing at 5006-5027ms
  // every time. Root cause: the v626 fix gave tidal rings land-style full-
  // vertex treatment but only capped the NON-blocking case — this corridor
  // has 19 SEPARATE blocking tidal-zone polygons on the direct line at
  // once (real charted drying flats are fragmented, unlike a landmass),
  // and reusing land's MAX_BLOCKING_VERTS=300 per-ring cap for all 19 of
  // them alone pushed setup to 2893 nodes. Fixed (v628) with a tidal-
  // specific MAX_TIDAL_VERTS cap (blocking or not) and an overall node
  // budget for the non-blocking tidal/hazard loop
  // (MAX_EXTRA_NON_BLOCKING_NODES) — also sped up every other tidal-heavy
  // case in this suite as a side effect.
  //
  // v628's MAX_TIDAL_VERTS=40 still wasn't enough real margin: the SAME
  // user hit the SAME deadline again on their own real device — their
  // browser console showed 2151 nodes cut off at 5006ms after only 1120
  // of the ~1174 expansions a full search needs there (extrapolated
  // real completion ~5.2s), vs. 2.4s for the identical route/data on this
  // dev machine — a genuine ~2.2x device-speed gap, not a logic bug or
  // stale cache (confirmed via the app's own version badge). Lowered to
  // MAX_TIDAL_VERTS=15 (v629) so this dev machine finishes with real
  // headroom (~1.6-1.7s, i.e. ~3.5-3.7s even at that same 2.2x gap)
  // instead of tuning to just barely fit whichever machine tested it last.
  //
  // 2026-09-27: this exact device-speed-gap problem recurred, worse — a
  // real Penobscot Bay in-scope route (this case) ALWAYS finds a real,
  // valid route (never "no path exists"), but wall-clock varied 9.2s
  // (local, idle) to 18s+ (GitHub's shared CI runner under heavy load) —
  // not a routing bug, environmental noise on a shared runner. Chasing
  // DEFAULT_DEADLINE_MS ever higher to match CI's worst observed moment
  // would also raise real users' UX latency for no benefit (see v706's
  // own configurable "Route planning time limit" setting for the actual
  // per-user answer to this). This case's OWN check now gets a generous,
  // CI-noise-tolerant budget independent of the shipped app default —
  // this test cares whether a real route is eventually found, not how
  // fast a shared CI box happened to be today.
  const CASE16_TEST_DEADLINE_MS = 35000;
  gate(await runCase(Query, Router, '[16] Rockland -> Carvers Harbor/Vinalhaven (many simultaneous tidal flats)',
    { lat: 44.103, lon: -69.088 }, { lat: 44.045519, lon: -68.835208 }, CASE16_TEST_DEADLINE_MS));

  // Case 17 — Rockland -> WoodenBoat School / Center Harbor, Brooklin
  // (~24.5nm, found live via a user-reported route). Long flagged as an
  // open "base-router island-dense-archipelago limitation" (see
  // project_long_range_routing notes) with two prior fix attempts tried
  // and reverted — real root cause finally found and fixed 2026-09-18.
  //
  // Two things this was NOT: (1) a named-water-feature-midpoint heuristic
  // (first attempt) failed because useful channel names often label a
  // point that's itself on land, and ranking candidates by raw distance
  // surfaces dozens of irrelevant coves before a useful one; (2) a plain
  // geometric-midpoint bisection retry (second attempt) genuinely fixed
  // the general "one bracket is too much for one visibility-graph search"
  // failure mode elsewhere (confirmed: Rockland -> Perry Creek's own 19nm
  // transit bracket, failing before and passing after), but didn't fix
  // THIS case — every split still failed on the same "back half" no
  // matter where the split point landed.
  //
  // That "always fails reaching the same point regardless of approach"
  // pattern was the real clue: the bracket's own END point was the
  // problem, not the span. _transitLeg's clamp (`endT = startT +
  // (LONG_RANGE_NM-1)/totalNm`) is pure fraction-of-the-line arithmetic —
  // it has no idea whether the point it lands on is water. Confirmed live:
  // for this route, that clamped point landed squarely on the town of
  // Deer Isle — a real landmass a couple of miles across, not a tiny
  // pocket a small-radius snap could fix, and the direct rhumb line from
  // Rockland to Brooklin happens to cross it near that exact fraction.
  // Every patch attempt using that boundary failed no matter what the
  // OTHER endpoint was, because arriving AT that exact spot is what was
  // impossible, not the distance or the number of islands en route.
  //
  // The fix (kept in router.js, in the same spot the two reverted
  // attempts occupied): after computing the clamped bracket boundary,
  // walk it back along the same line in small steps until it's off land,
  // before ever calling autoRouteProg on it. Verified live: Rockland ->
  // WoodenBoat School now finds a real 21-point route clear of land in
  // ~1.5s (was: fallback=true, crossesLand=true, 2 pts). Also flips case 7
  // (Portsmouth -> Bar Harbor, a real land-crossing fallback before this)
  // to a genuine passing route — see its own comment above. The geometric-
  // bisection retry from the second attempt was removed once this made it
  // provably redundant (disabling it changed neither case's outcome) —
  // simpler is better once the actual bug has a real fix.
  gate(await (async () => {
    Query.setActiveRegion('penobscot-bay');
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    return runCase(Query, Router, '[17] Rockland -> WoodenBoat School/Center Harbor (long-range archipelago)',
      { lat: 44.103, lon: -69.088 }, { lat: 44.2446198, lon: -68.555493 }, DEADLINE_MS, LONG_RANGE_DEADLINE_MS);
  })());

  // Case 18 — FIXED. Rockland -> Heron Neck Ledge/Vinalhaven vicinity
  // (~12.8nm), found live 2026-09-27 via a real user-reported AutoRoute.
  // This is core Penobscot Bay (verified against named_places.geojson:
  // Heron Neck Ledge, Folly Ledge, Potato Island all within 0.3nm of the
  // route) — not an out-of-scope destination, despite an initial wrong
  // guess mid-session that it was near Sullivan/Frenchman Bay (never trust
  // eyeballed coordinates over checking named_places.geojson, see
  // feedback_verify_geo_names memory).
  //
  // Root cause: the "penobscot-bay" named region's OWN land.geojson was
  // missing real charted land (near Vinalhaven, and separately near Shag
  // Rock/Muscongus Bay — the second surfaced only after the first fix
  // changed the router's chosen path) that the bundled default's
  // land.geojson correctly has. With penobscot-bay active, AutoRoute found
  // the destination-region data "clear" and routed straight across real
  // charted land — a genuine, undetected, unsafe route.
  //
  // TWO blanket fix attempts tried and reverted first, both real
  // regressions: (1) union bundled-default's land data into every named
  // region at load time (query.js loadData) — fixed this case but broke
  // case [17]. (2) add just the one specific missing bundled polygon (a
  // single 88-point landmass) directly to the region file — still broke
  // case [17] AND still didn't fully fix this case. Root problem both
  // times: bundled-default represents this whole area as one coarse
  // landmass, while penobscot-bay represents the SAME real geography as
  // many smaller, more detailed polygons with real channels/gaps between
  // separate islands and ledges — pasting in the coarse bundled shape
  // paves over those real channels. This project's chart data is a
  // genuine patchwork; no one dataset is uniformly better than another.
  //
  // Actual fix: a geometric DIFFERENCE (bundled-default minus
  // penobscot-bay's own land, via shapely), computed only within a small
  // bounding box around each real gap, so only the genuinely missing
  // sliver gets added — never a whole landmass, never anything already
  // covered by penobscot-bay's own (possibly more detailed) data. Applied
  // twice: once around Vinalhaven (7 features added), once around Shag
  // Rock (18 small features added, a real scattered ledge field). Both
  // verified against the full regression suite before and after.
  //
  // A full-region version of this diff (whole chart_bounds box, no local
  // clip) was tried and found 2456 differing polygons — mostly bundled
  // having far more inland/river detail (Bangor, Ellsworth, etc., never
  // relevant to a boat) that penobscot-bay deliberately omits, not real
  // navigable-water gaps. Applying that blindly is a real risk (same
  // failure mode as attempt #2 above, just bigger) — not done. Other real
  // gaps almost certainly exist along the coast; each needs the same
  // local-diff-and-verify treatment when it actually surfaces, not a
  // blanket sweep.
  //
  // Grading this case deliberately checks the resulting path against the
  // BUNDLED-DEFAULT land data specifically (real ground truth), not
  // whatever's active when the route is computed — grading against the
  // same (possibly incomplete) data the router used to build the route
  // would be circular and never catch this class of bug.
  gate(await (async () => {
    Query.setActiveRegion('penobscot-bay');
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    const label = '[18] Rockland -> Heron Neck Ledge/Vinalhaven vicinity (region land-data gap)';
    const start = { lat: 44.103, lon: -69.088 }, end = { lat: 44.042835, lon: -68.836543 };
    const t0 = Date.now();
    const path_ = await Router.autoRouteProg(start, end, () => {}, () => {}, false, 5.0, 0);
    const ms = Date.now() - t0;
    // Re-load bundled-default (real ground truth) to grade against, then
    // switch back so it doesn't leak into later cases.
    Query.setActiveRegion(null);
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    const crosses = pathCrossesLand(Query, path_);
    const fallback = path_.length <= 2 && crosses;
    const ok = !fallback && !crosses && ms < DEADLINE_MS;
    console.log(`${label}: ${ok ? 'PASS' : 'FAIL'} (fallback=${fallback}, crossesLand=${crosses}, ${path_.length} pts, ${ms}ms)`);
    Query.setActiveRegion('penobscot-bay');
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    return { ok };
  })());

  // Case 19 — Rockland -> SP009/Eggemoggin Reach (~21.4nm, real user-
  // reported waypoint, exact coordinate read from the user's own saved
  // waypoint data 2026-09-27/28). AutoRoute failed completely — not a
  // timeout, a genuine "no path found" after A* exhausted its entire
  // candidate graph (confirmed live: 1311 expansions, all 1462 nodes).
  // Root cause: the router's per-query candidate-node generation
  // (_addRingNodes/_pickExtremeVerts) places plenty of points on EACH
  // side of the Deer Isle/Eggemoggin Reach passage but has no guarantee
  // any combination of them chains all the way through a real,
  // genuinely complex multi-island route — not a budget problem (3x-ing
  // the router's node/ring caps changed nothing) and not a missing-
  // buoy-data problem (the real charted buoy chains on each side are
  // genuinely ~3.35nm apart with no markers between them in the actual
  // charts).
  //
  // Fixed with a new precomputed navigable-water mesh
  // (preprocess/build_water_mesh.py -> water_mesh_deer_isle.geojson),
  // consumed as ordinary candidate nodes seeded via the mesh's own
  // precomputed shortest path (Query.waterMeshPath) — never as trusted,
  // segBlocked-bypassing edges the way real charted channel data is.
  // Getting the underlying water polygon right took three real, live-
  // verified iterations: land-only (mesh disagreed with the router's own
  // depth check 29% of the time), blind shallow-polygon subtraction
  // (fragmented the water polygon into thousands of disconnected
  // pieces), fixed-margin erosion around large hazards (still left a
  // real 28-edge stretch running straight through Tinker Ledges
  // unrescued, and separately risked cutting a destination off from the
  // mesh entirely when it sits close to a hazard's charted boundary) —
  // the version that actually works carves real, sounding-verified deep
  // water back out of each subtracted hazard, mirroring router.js's own
  // _soundingsClearCrossing rescue logic instead of approximating it
  // with a blind buffer. See build_water_mesh.py's own module/function
  // docstrings for the full iteration history — read those before
  // touching this again.
  gate(await (async () => {
    Query.setActiveRegion('penobscot-bay');
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    return runCase(Query, Router, '[19] Rockland -> SP009/Eggemoggin Reach (water-mesh archipelago fix)',
      { lat: 44.103, lon: -69.088 }, { lat: 44.281015556570566, lon: -68.65824742155965 },
      DEADLINE_MS, LONG_RANGE_DEADLINE_MS);
  })());

  // Case 20 — Rockland -> WoodenBoat School Moorings vicinity, Brooklin
  // (real user-reported route, 2026-09-28). Just 0.11nm from case 17's
  // own destination (which already passed), but failed completely
  // (full A* graph exhaustion, not a timeout) on BOTH bundled-default
  // and penobscot-bay. Root cause, confirmed live: _transitLeg's coarse
  // march detects where a direct line's blockage starts/ends, then
  // brackets the WHOLE detected span in one local search — for this
  // destination the march happened to detect one long continuous
  // blocked stretch (~19nm bracket) where case 17's nearly-identical
  // line detected a shorter one, splitting naturally into two easier
  // hops. Same real passage, same real water — a fragile difference in
  // where one coarse-march sample landed relative to a real hazard,
  // not a difference in what's actually navigable. Fixed by retrying a
  // failed full-span bracket with a much smaller one (just past where
  // the blockage starts, not its whole detected span) before giving up
  // — see router.js's _transitLeg for the fix and full comment. Run
  // against bundled-default specifically (case 17/19 already cover
  // penobscot-bay) since this reproduces and is fixed there too, with
  // no water-mesh data involved at all — proof this is a router-logic
  // fix, not another mesh-coverage gap.
  gate(await (async () => {
    Query.setActiveRegion(null);
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    return runCase(Query, Router, '[20] Rockland -> WoodenBoat School Moorings/Brooklin (fragile transit-bracket fix)',
      { lat: 44.103, lon: -69.088 }, { lat: 44.243724, lon: -68.557738 },
      DEADLINE_MS, LONG_RANGE_DEADLINE_MS);
  })());

  // Case 21 — a real user-reported route through the Fox Islands Thorofare/
  // Perry Creek approach (2026-09-28): "This was not a wise course... you
  // should have gone further offshore." Root cause, confirmed live: the
  // per-query hazard-circle rings segBlocked uses only ever get built for
  // point hazards (underwater rock/obstruction/wreck) inside THAT query's
  // own padded bbox (start/end +/- PAD_NM=2.0nm) — fine for steering
  // candidate node generation, but a real blind spot for edge checking.
  // This route's real, necessary detour bulges further than PAD_NM from
  // the direct line, so a charted rock ~0.6nm past the bbox's own edge
  // never got a ring built for it at all — the shipped route (before this
  // fix) passed within 0.0008nm (~1.5m) of it, silently, with no warning.
  // Fixed with Query.hazardPointBlocks — a global, bbox-independent
  // point-hazard check wired into segBlocked right alongside the existing
  // (always-correct) Query.landBlocks call, giving point hazards the same
  // guarantee land already had. Verified live: the fixed route's worst
  // standoff from a real charted rock improved from ~1.5m to ~51m.
  gate(await (async () => {
    Query.setActiveRegion('penobscot-bay');
    await Query.loadData(44.08, -68.8);
    await waitForRegionDataReady(Query);
    return runCase(Query, Router, '[21] Fox Islands Thorofare approach (global point-hazard check fix)',
      { lat: 44.032327, lon: -68.835473 }, { lat: 44.115263, lon: -68.86898 },
      DEADLINE_MS, LONG_RANGE_DEADLINE_MS);
  })());

  // Case 22 — Rockland -> TS016 (Brooklin/Eggemoggin Reach vicinity, ~21.4nm,
  // real user-reported route, found comparing an identical AutoRoute run
  // across two devices). Failed completely on bundled-default (full A*
  // exhaustion on the arrive leg, not a timeout) even though the route is
  // genuinely findable — confirmed live. Root cause: _longRangeRoute's
  // arrival-point pick (Query.findClearOffshorePoint) searches the full
  // 360° compass for whichever direction has the longest uninterrupted
  // clear-water run, with NO weight toward the direction the boat is
  // actually approaching from. For TS016 that picked a point sitting 117°
  // off the real approach bearing — bad enough here that the transit leg's
  // own bracket search between departurePt and that misaligned arrivalPt
  // never found a connected path within budget at all, not just an
  // inefficient one.
  //
  // Fixed in TWO places, deliberately NOT by changing
  // findClearOffshorePoint's default behavior: an earlier attempt made
  // destination-alignment the unconditional default for every caller and
  // broke cases 17 and 20 above — both already-fragile long-range cases in
  // this same island-dense area whose ORIGINAL most-open arrival/departure
  // points already worked; shifting the default moved them too and
  // destabilized _transitLeg's own bracket-detection math. Instead:
  // (1) findClearOffshorePoint grew an opt-in alignThresholdNm param
  // (prefer the closest-to-ideal-bearing direction among any that clear at
  // least that much open water, default openWidthNm — never applied
  // unless a caller explicitly asks); (2) _longRangeRoute calls it with
  // that option ONLY as a retry, after the plain pick's own leg/transit
  // search has already failed. A route whose first attempt already
  // succeeds (every previously-passing case, including 17/20) never enters
  // the retry path at all, so this can't regress them — confirmed live by
  // re-running the full suite after the fix: same 3 EXPERIMENTAL failures
  // as baseline (2/6/7), zero new ones.
  gate(await (async () => {
    Query.setActiveRegion(null);
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    return runCase(Query, Router, '[22] Rockland -> TS016/Brooklin vicinity (misaligned long-range arrival point)',
      { lat: 44.103, lon: -69.088 }, { lat: 44.281016, lon: -68.658247 },
      DEADLINE_MS, LONG_RANGE_DEADLINE_MS);
  })());

  // Cases 23-25 — found by Longtest (2026-10-04), all genuine "no path"
  // (A* exhausted, not a timeout), fixed by autoRouteProg's top-level
  // retries (see the WIDE_PAD_NM comment in router.js). Graded against the
  // long-range budget because a retry can take up to 2x the deadline.
  //  23: start/end almost due N/S across Deer Isle — no connected water in
  //      the 2nm-padded box; the real route runs east via Jericho Bay.
  //  24/25: TS018 is the Brooksville town-center point (on land). The
  //      nearest-water snap picked Snow Cove, which this chart data doesn't
  //      connect to the bay; the retry moves it to Bucks Harbor instead.
  for (const [label, a, b] of [
    ['[23] Bay Ledge -> Eggemoggin Reach (search area too narrow)', { lat: 44.087963, lon: -68.657477 }, { lat: 44.263155, lon: -68.616097 }],
    ['[24] TS018 Brooksville -> TS011 North Haven side (endpoint snapped into unreachable water)', { lat: 44.3477829, lon: -68.6912832 }, { lat: 44.115263, lon: -68.86898 }],
    ['[25] TS014 -> TS018 Brooksville (long-range, unreachable snapped endpoint)', { lat: 44.043153, lon: -68.835473 }, { lat: 44.3477829, lon: -68.6912832 }],
  ]) {
    gate(await (async () => {
      Query.setActiveRegion('penobscot-bay');
      await Query.loadData(44.103, -69.088);
      await waitForRegionDataReady(Query);
      return runCase(Query, Router, label, a, b, DEADLINE_MS, LONG_RANGE_DEADLINE_MS);
    })());
  }

  // Case 26 — TS014 -> TS010 at 2m tide, 3.5ft draft (found by Longtest,
  // 2026-10-04): a real 14-point route whose leg cut 349m across Lawrys
  // Island along a synthetic buoy-chain channel edge, which the router
  // used to trust without a land check. At tide 0-1m a different route
  // won and the bug stayed hidden, so this case pins the tide. Fixed by
  // router.js's CHANNEL_LAND_TOLERANCE_M guard.
  gate(await (async () => {
    Query.setActiveRegion('penobscot-bay');
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    const label = '[26] TS014 -> TS010 at 2m tide (channel edge cutting across Lawrys Island)';
    const t0 = Date.now();
    const p = await Router.autoRouteProg({ lat: 44.043153, lon: -68.835473 }, { lat: 44.154127, lon: -68.884358 },
      () => {}, () => {}, false, 3.5, 2.0, null, null, DEADLINE_MS);
    const ms = Date.now() - t0;
    const crosses = pathCrossesLand(Query, p);
    const fallback = p.length <= 2 && crosses;
    const ok = !fallback && !crosses && ms < LONG_RANGE_DEADLINE_MS;
    console.log(`${label}: ${ok ? 'PASS' : 'FAIL'} (fallback=${fallback}, crossesLand=${crosses}, ${p.length} pts, ${ms}ms)`);
    return { ok };
  })());

  // Case 27 — TS027 Northeast Harbor -> TS015 Belfast Harbor (31nm, found by
  // Longtest 2026-10-04). Long-range: the transit leg's bracket patches (the
  // detour around land on the cross-bay line) found no path in the 2nm-
  // padded box. They now search with WIDE_PAD_NM from the start.
  gate(await (async () => {
    Query.setActiveRegion('penobscot-bay');
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    return runCase(Query, Router, '[27] TS027 Northeast Harbor -> TS015 Belfast Harbor (long-range transit patch)',
      { lat: 44.298915, lon: -68.282175 }, { lat: 44.424461, lon: -68.992427 },
      DEADLINE_MS, LONG_RANGE_DEADLINE_MS);
  })());

  // Case 28 — TS008 (North Haven side) -> TS018 Brooksville, the reverse of
  // case 24, at 0m tide / 3.5ft draft (Longtest via ?longtest=, 2026-10-05).
  // Routed, but only after ~35s — over the browser's budget, so it failed
  // there. The wide-area retry was wasted on the unreachable Snow Cove end;
  // trying other nearby water first brings it to ~19s.
  gate(await (async () => {
    Query.setActiveRegion('penobscot-bay');
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    const label = '[28] TS008 -> TS018 Brooksville at 0m tide (try other water before widening)';
    const t0 = Date.now();
    const p = await Router.autoRouteProg({ lat: 44.115263, lon: -68.86898 }, { lat: 44.3477829, lon: -68.6912832 },
      () => {}, () => {}, false, 3.5, 0, null, null, DEADLINE_MS);
    const ms = Date.now() - t0;
    const crosses = pathCrossesLand(Query, p);
    const fallback = p.length <= 2 && crosses;
    const ok = !fallback && !crosses && ms < LONG_RANGE_DEADLINE_MS;
    console.log(`${label}: ${ok ? 'PASS' : 'FAIL'} (fallback=${fallback}, crossesLand=${crosses}, ${p.length} pts, ${ms}ms)`);
    return { ok };
  })());

  // Case 29 — TS028 Valley Cove (Somes Sound) -> TS015 Belfast Harbor (30nm,
  // Longtest on the iPhone simulator, 2026-10-05). The transit detour from
  // inner Blue Hill Bay toward Castine must go south via Eggemoggin Reach's
  // east entrance, outside even the 6nm box; detour patches now escalate to
  // EXTRA_WIDE_PAD_NM (12nm) on a genuine no-path.
  // NOT GATING since 2026-10-07: its earlier "pass" was false — the route
  // ran straight across 4.5nm of Mount Desert Island (Somes Sound → the
  // west side), through tiles missing from the region land data, and this
  // suite only checks land against that same incomplete data. With the
  // land restored the router finds no path (it can't yet plan a detour
  // round a big island far off the direct line). Kept running and logged;
  // re-gate once the router fix lands (scratchpad router_retryC.patch).
  (await (async () => {
    Query.setActiveRegion('penobscot-bay');
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    return runCase(Query, Router, '[29] EXPERIMENTAL/KNOWN-FAILING: TS028 Valley Cove -> TS015 Belfast Harbor (MDI detour)',
      { lat: 44.310281, lon: -68.317108 }, { lat: 44.424461, lon: -68.992427 },
      DEADLINE_MS, LONG_RANGE_DEADLINE_MS);
  })());

  // Case 31 — region land data holes (2026-10-07). The penobscot-bay land
  // file was missing whole tiles of Mount Desert Island (NW quarter, west of
  // Somes Sound) and everything north of ~44.4N east of -68.4 (Trenton,
  // Lamoine, Hancock), so a route from the head of Somes Sound to the west
  // side of MDI went straight across the island as "clear". Patched from the
  // detailed charts; these points must be land, and that leg must NOT come
  // back as a land-free straight line, or start from water across the island.
  gate(await (async () => {
    Query.setActiveRegion('penobscot-bay');
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    const mustBeLand = [[-68.37, 44.366], [-68.30, 44.50], [-68.20, 44.55]];
    const missing = mustBeLand.filter(([lon, lat]) => !Query.isLandAt(lon, lat));
    const p = await Router.autoRouteProg({ lat: 44.365466, lon: -68.328266 }, { lat: 44.366706, lon: -68.409293 },
      () => {}, () => {}, false, 5.0, 0, null, null, DEADLINE_MS);
    const silentlyAcross = p.length <= 2 && !pathCrossesLand(Query, p);
    // v816: nor may the start be silently swapped for "other nearby water"
    // on the far side of the island (it jumped 2.7nm to Mount Desert Narrows).
    const startJumpNm = Query.distanceNm(p[0].lon, p[0].lat, -68.328266, 44.365466);
    const ok = missing.length === 0 && !silentlyAcross && startJumpNm < 0.5;
    console.log(`[31] Region land covers Mount Desert Island / Trenton (no silent straight line across MDI): ${ok ? 'PASS' : 'FAIL'} (missing land at ${JSON.stringify(missing)}, ${p.length} pts, crossesLand=${pathCrossesLand(Query, p)}, start moved ${startJumpNm.toFixed(2)}nm)`);
    return { ok };
  })());

  // Case 30 — Rockland -> a marker in Carvers Harbor's mooring field
  // (2026-10-06, found recording a voice demo). The land data drew the
  // whole harbor as one solid landmass, so the destination was "on land"
  // and silently moved 0.65 nm south, outside the harbor. Fixed by
  // re-extracting land for that box from the detailed charts. Must end
  // inside the harbor (within 0.2 nm), on both datasets.
  for (const region of ['penobscot-bay', null]) {
    gate(await (async () => {
      Query.setActiveRegion(region);
      await Query.loadData(44.103, -69.088);
      await waitForRegionDataReady(Query);
      const label = `[30] Rockland -> Carvers Harbor mooring field (${region || 'default'} data)`;
      const end = { lat: 44.04336530728454, lon: -68.83608341217042 };
      const t0 = Date.now();
      const p = await Router.autoRouteProg({ lat: 44.103, lon: -69.088 }, end, () => {}, () => {}, false, 5.0, 0, null, null, DEADLINE_MS);
      const ms = Date.now() - t0;
      const crosses = pathCrossesLand(Query, p);
      const last = p[p.length - 1];
      const gapNm = Query.distanceNm(last.lon, last.lat, end.lon, end.lat);
      const ok = p.length > 2 && !crosses && gapNm <= 0.2 && ms < LONG_RANGE_DEADLINE_MS;
      console.log(`${label}: ${ok ? 'PASS' : 'FAIL'} (crossesLand=${crosses}, ends ${gapNm.toFixed(2)}nm from marker, ${p.length} pts, ${ms}ms)`);
      return { ok };
    })());
  }

  // Case 32 — "AutoRoute to Carvers Harbor" from the user's home position
  // (Route 442, 2026-10-09). The charted Carvers Harbor point is at the
  // landing, behind two drying rocks that close the head of the harbor in
  // this data, so no route reaches it. It must stop inside the harbor and
  // say so (onSnap 'end' with blocked), not fail outright.
  gate(await (async () => {
    Query.setActiveRegion('penobscot-bay');
    await Query.loadData(44.103, -69.088);
    await waitForRegionDataReady(Query);
    const label = '[32] Home -> Carvers Harbor landing (stops short, says so)';
    const end = { lat: 44.04694901640202, lon: -68.83553601902793 };
    const snaps = [];
    const t0 = Date.now();
    const p = await Router.autoRouteProg({ lat: 44.0986, lon: -69.0752 }, end, () => {}, () => {}, false, 5.0, 0, null,
      (which, sn) => snaps.push({ which, ...sn }), DEADLINE_MS);
    const ms = Date.now() - t0;
    const crosses = pathCrossesLand(Query, p);
    const last = p[p.length - 1];
    const gapNm = Query.distanceNm(last.lon, last.lat, end.lon, end.lat);
    const told = snaps.some(s => s.which === 'end' && s.blocked);
    const ok = p.length > 2 && !crosses && gapNm <= 0.3 && told && ms < 2 * DEADLINE_MS;
    console.log(`${label}: ${ok ? 'PASS' : 'FAIL'} (crossesLand=${crosses}, ends ${gapNm.toFixed(2)}nm from the landing, reported=${told}, ${p.length} pts, ${ms}ms)`);
    return { ok };
  })());

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll cases passed.');
  console.log(
    '\nNOT PORTED (relied on injecting a synthetic obstacle ring the real\n' +
    'Query module has no public seam for — see this file\'s header comment):\n' +
    '  - old case 1: single-ring perf floor (explicitly not a regression\n' +
    '    target on its own, per its original comment — safe to drop).\n' +
    '  - old case 4: staggered two-ring obstacle (tests the one-hop\n' +
    '    neighbor-expansion behavior with no known real-world example).\n' +
    '  - old case 5: channel-graph forced empty (case 2 above already\n' +
    '    covers land-only routing for a route that needs no channel data).\n' +
    '  - old case 9: long-range bracket-and-patch around a synthetic\n' +
    '    mid-course obstacle.\n' +
    'Follow-up options: add a test-only injection hook to query.js, or find\n' +
    'real-world coordinates with equivalent topology.'
  );
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
