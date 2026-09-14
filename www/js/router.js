/**
 * AudioChart — auto-routing (visibility-graph + A*, channel-graph fast path,
 * long-range depart/transit/arrive decomposition, and fallback classification).
 *
 * Extracted from app.js (2026-09) so this safety-critical algorithm can be
 * exercised directly by test/test_channel_routing.js against real chart data
 * in plain Node, instead of through a hand-maintained port of its logic that
 * could silently drift from the real thing — see the reliability-overhaul
 * plan for the full rationale. This module has no DOM/Leaflet dependency:
 * app.js supplies the user's draft setting and current tide height as plain
 * parameters, and an optional onSearchProgress callback stands in for the
 * live search-progress dot the browser UI draws.
 */

import * as Query from './query.js';

export async function autoRouteProg(
  start, end, onUpdate, onText = null, _escapeAttempted = false,
  draftFt = 5.0, tideHeightM = 0, onSearchProgress = null,
) {
  // Visibility Graph + A* (Euclidean Shortest Path with Polygonal Obstacles).
  // Nodes: start, end, and polygon vertices in the padded bounding box.
  // Edges are checked lazily during A* expansion.
  const PAD_NM    = 2.0;
  const SAFETY_NM   = 0.05;  // ~100 yards — kept as the hazard/tidal-ring offset floor (see HAZARD_OFFSET_LADDER); no longer used for land-ring standoff
  const CORRIDOR_NM = 3.0;   // include LAND rings within this distance of the direct line
  // A genuinely island-dotted stretch (e.g. Blue Hill Bay/Penobscot Bay —
  // verified live: 157 separate non-blocking land rings in one 9nm route's
  // corridor, ~2200 nodes from convex vertices alone) can still overwhelm A*
  // even with each individual ring's vertex selection unchanged/correct. This
  // is a NODE budget, not a ring-count budget, because unlike
  // MAX_EXTRA_NON_BLOCKING_RINGS's uniform tiny synthetic hazard circles,
  // real coastline rings vary hugely in vertex count (a long mainland stretch
  // running near-parallel to the route can contribute far more vertices than
  // a small island) — capping ring COUNT alone barely moved the real node
  // total in testing. Each already-included ring still keeps its FULL
  // correct convex-vertex set (no per-ring thinning, unlike hazards); this
  // only stops pulling in MORE nearby islands, closest-to-the-line first,
  // once the budget is spent.
  const MAX_LAND_NON_BLOCKING_NODES = 500;
  // A mariner keeps land at a distance, not right at the safety minimum: try
  // a comfortable ~0.5nm standoff first, only accepting something tighter
  // (down to ~0.15nm/275yd) where the geometry genuinely won't allow more —
  // e.g. island-dense or inland water. Never falls all the way to the old
  // 100yd floor here; that tight a clearance is reserved for water a real
  // chart has verified as a marked channel (Query.channelNeighbors' edges,
  // which don't go through this ladder at all — they follow the charted
  // centerline directly). Point-hazard/tidal-zone rings are a different
  // concern (avoiding a specific charted danger, not general coastal
  // standoff) and keep the original, unchanged ladder.
  const COASTAL_STANDOFF_LADDER = [0.5, 0.25, 0.15];
  const HAZARD_OFFSET_LADDER = [SAFETY_NM, SAFETY_NM * 2, SAFETY_NM * 4];
  // A charted drying/shallow zone can be much wider than a small point
  // hazard's ~100yd safety circle — confirmed live (Rockland -> Camden):
  // real tidal flats along the Rockport/Glen Cove shoreline needed up to
  // 1nm of standoff before a candidate cleared them, well past
  // HAZARD_OFFSET_LADDER's 0.2nm ceiling. Deliberately NOT reusing
  // COASTAL_STANDOFF_LADDER's own checkClearance=true path — that gate
  // measures distance to LAND (Query.distanceToLandNm), the wrong
  // question for a tidal-zone candidate; _isOnLandLocal already rejects
  // anything still inside the flat (or any other extra ring, or on dry
  // land), which is the actual test that matters here.
  const TIDAL_STANDOFF_LADDER = [1.0, 0.5, 0.2, 0.1, 0.05];
  // One honest wall-clock budget for the WHOLE call (setup + A*), not just the
  // search loop — replaces the old unbounded-setup + 8s-A*-only + up-to-2x-via-
  // escalation pattern, which could legitimately run 16s+ for one leg with no
  // way for the caller to know. Checked after setup and periodically during A*
  // (both against _profT0 below); exceeding it means the honest straight-line
  // fallback (_showRouteFallbackWarning), never a partial/unverified path.
  const DEADLINE_MS = 5000;
  // Point-hazard/tidal rings only need a graph NODE when genuinely close to
  // the direct line — segBlocked already checks every one of them for every
  // candidate edge regardless of this, so a distant one not getting a node
  // doesn't weaken safety, it just isn't offered as a routing waypoint.
  // Reusing CORRIDOR_NM=3 here was the dominant cost in a real failing case
  // (rock-strewn Maine coast): ~1354 hazard-circle rings within 3nm of one
  // 16.5nm line, each promoted to up to 10 nodes, for ~12,900 total nodes
  // before A* even started — most of them irrelevant to any real path.
  const EXTRA_CORRIDOR_NM = 0.5;
  // Even at 0.5nm, a real Penobscot Bay ledge field can put hundreds of
  // separate charted rocks in the corridor (verified live: 1781 extra rings
  // in one 9nm route's bbox, ~420 within EXTRA_CORRIDOR_NM, uncapped, before
  // this existed). segBlocked/the extraGrid below still checks EVERY extra
  // ring in the bbox for collisions regardless of this cap — this only
  // bounds how many get to OFFER themselves as A* routing waypoints, ranked
  // closest-to-the-line first (see the extraRings loop after _addRingNodes).
  const MAX_EXTRA_NON_BLOCKING_RINGS = 60;
  // A NODE budget on top of the RING budget above, mirroring
  // MAX_LAND_NON_BLOCKING_NODES's own reasoning — this ring cap alone was
  // fine when every extra ring contributed at most 4 nodes (a point-hazard
  // circle), but a non-blocking tidal ring now contributes its full vertex
  // set (see _addRingNodes' isTidal branch). Confirmed live as a real
  // regression: a real ~11.4nm Rockland approach with 60 eligible tidal
  // rings pushed setup to 2900 total nodes and the whole call past
  // DEADLINE_MS consistently (5006-5027ms across repeated runs, not a
  // one-off) — this budget is what keeps that bounded. Less generous than
  // land's 500 since these are lower-priority secondary obstacles, not
  // the primary coastline.
  const MAX_EXTRA_NON_BLOCKING_NODES = 300;

  const delay = ms => new Promise(r => setTimeout(r, ms));
  const _profT0 = Date.now();

  // Wait for land data to finish loading (resolves instantly after first load).
  await Query.whenLandLoaded();

  // Let the overlay and preview line paint before we do any real work.
  await delay(0);

  // A start/end that lands on charted-too-shallow water (a drying flat, at
  // the current draft/tide) looks like open water on a simple map click —
  // snap it to nearby navigable water first, same idea as the existing
  // on-land snap, extended to cover charted depth too. See
  // Query.snapToNavigableWater's own comment for the real case this fixes.
  // Runs on every recursive call (long-range sub-legs, escape sub-legs)
  // too — cheap and a no-op whenever the point is already fine.
  const snappedStart = Query.snapToNavigableWater(start.lon, start.lat, draftFt, tideHeightM);
  if (snappedStart) {
    console.log(`[autoRoute] start was charted too shallow — moved ${snappedStart.movedNm.toFixed(2)}nm to navigable water`);
    start = { lat: snappedStart.lat, lon: snappedStart.lon };
  }
  const snappedEnd = Query.snapToNavigableWater(end.lon, end.lat, draftFt, tideHeightM);
  if (snappedEnd) {
    console.log(`[autoRoute] end was charted too shallow — moved ${snappedEnd.movedNm.toFixed(2)}nm to navigable water`);
    end = { lat: snappedEnd.lat, lon: snappedEnd.lon };
  }

  // Long-range passage decomposition (Piece 1d) — everything below this is
  // completely unchanged for routes under the threshold; see the block
  // comment above LONG_RANGE_NM (defined after this function) for why more
  // time alone can't fix a route this long instead.
  const directNm = Query.distanceNm(start.lon, start.lat, end.lon, end.lat);
  if (directNm > LONG_RANGE_NM) {
    console.log(`[autoRoute] long-range passage: ${directNm.toFixed(1)}nm direct (> ${LONG_RANGE_NM}nm threshold) — decomposing instead of one visibility-graph search`);
    return await _longRangeRoute(start, end, onUpdate, onText, draftFt, tideHeightM, onSearchProgress);
  }

  // ── Bounding box ───────────────────────────────────────────────────────────
  const midLat = (start.lat + end.lat) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  const padLon = PAD_NM / (60 * cosLat);
  const padLat = PAD_NM / 60;
  const bMinLon = Math.min(start.lon, end.lon) - padLon;
  const bMaxLon = Math.max(start.lon, end.lon) + padLon;
  const bMinLat = Math.min(start.lat, end.lat) - padLat;
  const bMaxLat = Math.max(start.lat, end.lat) + padLat;

  // A directly-blocking ring's "every convex vertex" rule (see _addRingNodes)
  // is only safe when that ring is a normal local landmass — but the bundled
  // land data also includes a handful of enormous, simplified "whole East
  // Coast" rings (thousands of vertices, hundreds of miles of bbox) for
  // broad-area fallback coverage. Real bug found in production: a Portsmouth
  // NH -> York ME route (~8nm) got routed via a vertex near Newburyport MA
  // (~20nm off-route) because that vertex just happened to have a sharper
  // local turn angle than the real, relevant vertices near Kittery Point on
  // the SAME giant ring — turn-angle ranking alone has no sense of "near
  // this route" at all. relevantNm bounds candidate vertices (from ANY
  // ring, not just the oversized ones) to a window that scales with the
  // route's own length — generous enough for a real local detour (an
  // island's far side, sized like the old escalation window it replaces)
  // but nowhere near enough to reach an irrelevant point two towns over.
  const relevantNm = Math.min(Math.max(Query.distanceNm(start.lon, start.lat, end.lon, end.lat) * 0.75, 5), 25);
  const relevantLon = relevantNm / (60 * cosLat), relevantLat = relevantNm / 60;
  const relMinLon = Math.min(start.lon, end.lon) - relevantLon;
  const relMaxLon = Math.max(start.lon, end.lon) + relevantLon;
  const relMinLat = Math.min(start.lat, end.lat) - relevantLat;
  const relMaxLat = Math.max(start.lat, end.lat) + relevantLat;
  function _inRelevantWindow(lon, lat) {
    return lon >= relMinLon && lon <= relMaxLon && lat >= relMinLat && lat <= relMaxLat;
  }

  const nodes = [start, end];  // index 0 = start, 1 = end

  // ── Channel graph (fairway centerlines + recommended tracks) ─────────────
  // Nodes are water-only by construction (real charted channel/track data),
  // so no land-offset dance is needed the way land-ring vertices get below.
  // channelKeyToIdx lets the A* loop map a channel node's graph neighbors
  // (returned by lon/lat) back to this call's nodes[] array indices; an
  // empty Query.channelNodesNear (no data loaded, or none in this bbox) is
  // what guarantees zero behavior change wherever channel data is absent —
  // no separate feature flag needed.
  const channelNodeIdxSet = new Set();
  const channelKeyToIdx = new Map();
  if (Query.channelNodesNear) {
    for (const cn of Query.channelNodesNear(bMinLon, bMaxLon, bMinLat, bMaxLat)) {
      const idx = nodes.length;
      nodes.push({ lon: cn.lon, lat: cn.lat });
      channelNodeIdxSet.add(idx);
      channelKeyToIdx.set(cn.key, idx);
    }
  }

  // ── Point-to-segment distance (nm) ────────────────────────────────────────
  function _ptSegDistNm(ptLon, ptLat, aLon, aLat, bLon, bLat) {
    const dx = bLon - aLon, dy = bLat - aLat;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Query.distanceNm(ptLon, ptLat, aLon, aLat);
    const t = Math.max(0, Math.min(1, ((ptLon - aLon) * dx + (ptLat - aLat) * dy) / len2));
    return Query.distanceNm(ptLon, ptLat, aLon + t * dx, aLat + t * dy);
  }

  // ── Point-in-ring (even-odd rule) ──────────────────────────────────────────
  function _pointInRing(px, py, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // ── Tide-aware depth: which drying areas are hazardous right now? ──────────
  const draftM  = draftFt * 0.3048;
  const tideM   = tideHeightM;
  // eff = effective depth at current tide — matches the depth-overlay logic at
  // ~app.js:6281 (eff = valsou + tideHeight; hazard if eff <= draft). The old
  // filter here (`v >= 0 && tideM < draftM + v`) was inverted: it excluded
  // drying/intertidal areas (valsou < 0) from ever counting as hazards, and
  // flagged progressively *safer, deeper* zones as obstacles as valsou grew.
  const tidalObs = (Query.getDepthZones() || []).filter(f => {
    const v = f.properties?.valsou;
    if (v == null) return false;
    const eff = v + tideM;
    return eff <= draftM;
  });

  // ── Land: served by query.js's persistent edge index ──────────────────
  // Land geometry is static and shared by every route computation this
  // session, so it's indexed ONCE at load time (see _buildLandEdgeIndex in
  // query.js) rather than rescanned here — profiling a real failing route
  // (Sorrento -> Blue Hill Bay) found the old per-call linear scan spent 32
  // SECONDS just offsetting ~4900 graph nodes off land before A* even
  // started. Only the *dynamic* obstacles below (tidal drying zones, which
  // depend on current tide + draft, and point-hazard circles) still need a
  // small per-call ring list — land goes through Query.landBlocks/isLandAt/
  // landRingsNear instead.
  if (!Query.getLandPolygons()) console.warn('[autoRoute] land.geojson not loaded — routing without land avoidance');

  const extraRings = [];  // tidal obstacle + point-hazard circles for this call
  function _processExtraRing(outer, isTidal) {
    let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity;
    let cx = 0, cy = 0;
    for (const [x, y] of outer) {
      if (x < rMinX) rMinX = x; if (x > rMaxX) rMaxX = x;
      if (y < rMinY) rMinY = y; if (y > rMaxY) rMaxY = y;
      cx += x; cy += y;
    }
    if (rMaxX < bMinLon || rMinX > bMaxLon || rMaxY < bMinLat || rMinY > bMaxLat) return;
    cx /= outer.length; cy /= outer.length;
    extraRings.push({ ring: outer, rMinX, rMaxX, rMinY, rMaxY, cx, cy, isTidal });
  }

  for (const feat of tidalObs) {
    const { type, coordinates } = feat.geometry;
    const polys = type === 'Polygon' ? [coordinates] : coordinates;
    for (const rings of polys) _processExtraRing(rings[0], true);
  }

  // Point hazards (underwater rocks, obstructions, wrecks) are stored as Point
  // geometry in hazards.geojson, which Query.getDepthZones() explicitly excludes
  // (it only returns 'shallow area' Polygons) — so without this, the pathfinder
  // has no idea a charted rock exists and can route straight past one at
  // point-blank range. Turn each into a small circular no-go ring and feed it
  // through the exact same avoidance pipeline (segBlocked, node offsetting,
  // corridor search) rather than adding a parallel obstacle system.
  const HAZARD_SAFETY_NM = 0.05;  // ~100 yards — matches the corridor used by
                                   // _checkRouteHazards/_autoFixSelectedNodes
  const HAZARD_LABELS = new Set(['underwater rock', 'obstruction', 'wreck', 'UWTROC', 'OBSTRN', 'WRECKS']);
  function _hazardCircleRing(lon, lat, radiusNm, sides = 10) {
    const cv = Math.cos(lat * Math.PI / 180);
    const ring = [];
    for (let i = 0; i <= sides; i++) {
      const ang = (i / sides) * 2 * Math.PI;
      ring.push([
        lon + radiusNm / (60 * cv) * Math.cos(ang),
        lat + radiusNm / 60 * Math.sin(ang),
      ]);
    }
    return ring;
  }
  for (const f of (Query.hazards?.features || [])) {
    if (f.geometry?.type !== 'Point') continue;
    const label = f.properties?.label || f.properties?.objtype || '';
    if (!HAZARD_LABELS.has(label)) continue;
    const [lon, lat] = f.geometry.coordinates;
    if (lon < bMinLon || lon > bMaxLon || lat < bMinLat || lat > bMaxLat) continue;
    _processExtraRing(_hazardCircleRing(lon, lat, HAZARD_SAFETY_NM), false);
  }

  // Land rings near the corridor, for graph node generation — cached
  // bbox/centroid from the index, no need to re-walk each ring's vertices.
  const landRingsInBox = Query.landRingsNear(bMinLon, bMaxLon, bMinLat, bMaxLat);
  console.log(`[autoRoute] ring-filter took ${Date.now() - _profT0}ms — ${landRingsInBox.length} land rings, ${extraRings.length} extra (tidal/hazard) rings in bbox`);

  // extraRings (tidal drying zones + point-hazard circles) is per-call and
  // dynamic — not worth a persistent index — but can still reach several
  // hundred entries in a busy area, and segBlocked/_isOnLandLocal are called
  // once per A* edge check / node-offset candidate. A plain per-call scan
  // over hundreds of rings on every one of those calls was the next
  // bottleneck after land got indexed (A* was only completing ~20-180
  // expansions before hitting its own time cap on a real failing route).
  // Bucket into a small grid over this call's own bounding box, same idea
  // as the persistent land index but rebuilt fresh each call since the set
  // itself is small and changes per route.
  const EXTRA_GRID_N = 24;
  const extraGridCellLon = (bMaxLon - bMinLon) / EXTRA_GRID_N || 1e-9;
  const extraGridCellLat = (bMaxLat - bMinLat) / EXTRA_GRID_N || 1e-9;
  const _extraCellX = lon => Math.min(EXTRA_GRID_N - 1, Math.max(0, Math.floor((lon - bMinLon) / extraGridCellLon)));
  const _extraCellY = lat => Math.min(EXTRA_GRID_N - 1, Math.max(0, Math.floor((lat - bMinLat) / extraGridCellLat)));
  // Numeric key, not a template-string concat — avoids string
  // allocation/hashing on every lookup. segBlocked is the hottest call in
  // auto-routing (600K+ calls in one real search); this and the matching
  // fix in query.js's land index together cut its average cost ~5x.
  const _extraCellKey = (gx, gy) => gx * EXTRA_GRID_N + gy;
  const extraGrid = new Map();
  for (const entry of extraRings) {
    const x0 = _extraCellX(entry.rMinX), x1 = _extraCellX(entry.rMaxX);
    const y0 = _extraCellY(entry.rMinY), y1 = _extraCellY(entry.rMaxY);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = _extraCellKey(gx, gy);
        let arr = extraGrid.get(key);
        if (!arr) { arr = []; extraGrid.set(key, arr); }
        arr.push(entry);
      }
    }
  }
  let _extraQueryId = 0;

  function segBlocked(lon1, lat1, lon2, lat2) {
    if (Query.landBlocks(lon1, lat1, lon2, lat2)) return true;
    const sx = Math.min(lon1, lon2), ex = Math.max(lon1, lon2);
    const sy = Math.min(lat1, lat2), ey = Math.max(lat1, lat2);
    const x0 = _extraCellX(sx), x1 = _extraCellX(ex);
    const y0 = _extraCellY(sy), y1 = _extraCellY(ey);
    _extraQueryId++;
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const arr = extraGrid.get(_extraCellKey(gx, gy));
        if (!arr) continue;
        for (const entry of arr) {
          if (entry._eq === _extraQueryId) continue;
          entry._eq = _extraQueryId;
          const { ring, rMinX, rMaxX, rMinY, rMaxY } = entry;
          if (rMaxX < sx || rMinX > ex || rMaxY < sy || rMinY > ey) continue;
          if (Query.ringBlocks(ring, lon1, lat1, lon2, lat2)) return true;
        }
      }
    }
    return false;
  }

  // Validates a candidate offset point actually landed in open water — a
  // fixed offset direction (e.g. "away from the ring's centroid") can be
  // wrong on a concave/convoluted coastline (a cove, a narrow point) and
  // land the "safety offset" point back on dry ground.
  function _isOnLandLocal(lon, lat) {
    if (Query.isLandAt(lon, lat)) return true;
    const arr = extraGrid.get(_extraCellKey(_extraCellX(lon), _extraCellY(lat)));
    if (!arr) return false;
    for (const { ring, rMinX, rMaxX, rMinY, rMaxY } of arr) {
      if (lon < rMinX || lon > rMaxX || lat < rMinY || lat > rMaxY) continue;
      if (_pointInRing(lon, lat, ring)) return true;
    }
    return false;
  }

  // The visual basemap and the chart polygon data used for routing don't
  // always agree pixel-for-pixel — a click that looks like clear water can
  // land just inside the chart's land boundary. A point strictly inside a
  // polygon has NO reachable neighbor (any line out of it must cross the
  // boundary), so without this the search fails after a single, instant
  // check — which looks like the router "did nothing" rather than having
  // actually searched. Nudge a small distance to the nearest confirmed-water
  // spot rather than fail outright.
  const SNAP_RADIUS_NM = 0.15;
  function _snapOffLand(pt) {
    if (!_isOnLandLocal(pt.lon, pt.lat)) return pt;
    for (let r = 0.02; r <= SNAP_RADIUS_NM; r += 0.02) {
      for (let ang = 0; ang < 360; ang += 30) {
        const rad = ang * Math.PI / 180;
        const cv = Math.cos(pt.lat * Math.PI / 180);
        const tx = pt.lon + r / (60 * cv) * Math.cos(rad);
        const ty = pt.lat + r / 60 * Math.sin(rad);
        if (!_isOnLandLocal(tx, ty)) return { lat: ty, lon: tx };
      }
    }
    // Still on land past SNAP_RADIUS_NM — this isn't a chart/basemap
    // mismatch anymore, the point is genuinely inland (e.g. a waypoint
    // dropped on a shoreline trail, not in the harbor). Confirmed real case:
    // a point on York ME's Cliff Walk footpath, ~0.32nm from open water —
    // just past this local search, but well within reach of a real
    // destination. Fall back to Query.findWaterNear's wider (2nm default)
    // search, same mechanism already used for named-destination lookups
    // (see _drawNameDestBtn), so a start/end that's merely near the coast
    // still gets a usable, nearby water point instead of a routing failure
    // that looks like a bug.
    const water = Query.findWaterNear?.(pt.lon, pt.lat);
    if (water) {
      console.warn(`[autoRoute] endpoint was on land — moved ${water.movedNm.toFixed(2)}nm to open water${water.viaPlace ? ` (${water.viaPlace})` : ''}`);
      return { lat: water.lat, lon: water.lon };
    }
    return pt;
  }
  start = _snapOffLand(start);
  end   = _snapOffLand(end);
  nodes[0] = start;
  nodes[1] = end;

  // ── Convex-vertex node collection ───────────────────────────────────────────
  // A shortest path around a polygonal obstacle only ever needs to bend at a
  // CONVEX vertex of that obstacle (a headland poking into free space) — a
  // concave vertex (a cove) is never a necessary bend point, since the taut
  // string skips over the indentation (see the convex-flag computation this
  // pairs with in query.js's _buildLandEdgeIndex/processRing). This replaces
  // the old "up to 30 vertices closest to the line" sample: smaller (correct
  // bend points only, not a distance-based guess) and can't exclude a real
  // far-side bend point — an island's tip is a convex vertex of the island's
  // OWN ring regardless of how far it sits from the direct line, so it's
  // included automatically once that ring is, with no separate "escalation"
  // pass needed to go find it.
  //
  // Two tiers:
  //   - A ring that directly blocks the line (isBlocking=true): every convex
  //     vertex, uncapped by distance — this is what lets a single A* pass
  //     thread between many separate blocking rings at once (Piscataqua's 8,
  //     an island's 10+), instead of only ever getting to fix one per retry.
  //   - A ring merely near the corridor (isBlocking=false): convex vertices
  //     AND within CORRIDOR_NM — keeps the common case (an incidental nearby
  //     island) cheap.
  const MAX_BLOCKING_VERTS = 300;  // safety valve for the ~10-11k-vertex
                                    // mainland/coastline ring — if a directly-
                                    // blocking ring has more convex vertices
                                    // than this, keep the sharpest headlands
                                    // (by exterior turn angle), not the
                                    // closest-to-line ones this replaces.
  // Real charted shallow-area (DEPARE) polygons among the "extra" rings are
  // NOT small synthetic hazard circles — they're real charted shapes, and a
  // real 9nm line through a shoal-strewn bay can directly cross MANY of them
  // at once. Verified live: 22 separate blocking shallow-area polygons on
  // one Blue Hill Bay line, ~71 vertices each on average (each individually
  // well under MAX_BLOCKING_VERTS, so that per-ring cap never triggered) —
  // 1559 nodes total, the dominant cost after every other lever here. A
  // single mainland ring can legitimately need up to MAX_BLOCKING_VERTS
  // vertices to thread a long, complex coastline; a shoal polygon is a much
  // simpler shape and doesn't need nearly that many per ring even when
  // several stack up in the same corridor.
  const MAX_EXTRA_BLOCKING_VERTS = 8;
  // Tidal/depth-zone rings need more detail per ring than a synthetic
  // point-hazard circle (MAX_EXTRA_BLOCKING_VERTS=8 is what made the
  // original Rockland->Camden fallback fail in the first place — see the
  // v626 fix), but land's own MAX_BLOCKING_VERTS=300 is sized for the
  // RARE-simultaneous-blocking-ring case, not this one: confirmed live, a
  // real ~11.4nm Rockland approach had 19 separate blocking tidal
  // polygons on the direct line at once (the same "many separate charted
  // shallow-area shapes" pattern the comment above already documented for
  // Blue Hill Bay), and 19 x up to 300 alone pushed the whole call past
  // DEADLINE_MS. This sits between the two existing caps.
  const MAX_TIDAL_VERTS = 40;
  function _addRingNodes(entry, isBlocking, offsetLadder, checkClearance, isExtra) {
    const { ring, cx, cy, convex, isTidal } = entry;
    const n = ring.length - 1; // -1: skip closing duplicate vertex
    // A tidal/depth-zone drying obstacle is architecturally more like a
    // coastline than a small charted rock — it can be large and irregular,
    // and needs a real standoff distance, not the tight point-hazard
    // ladder. Confirmed live: Rockland -> Camden's real drying flats
    // needed BOTH this ladder and full-vertex treatment below (not just 4
    // route-relative extremes) to find a path around them at all — the
    // tight HAZARD_OFFSET_LADDER (max 0.2nm) left every candidate near a
    // wide flat with no viable standoff distance, so _addRingNodes
    // silently placed zero usable nodes there while still reporting the
    // ring as "handled," starving the search of any real edge through
    // that stretch even though land avoidance alone would have worked.
    if (isExtra && isTidal) { offsetLadder = TIDAL_STANDOFF_LADDER; }
    let indices = [];
    if (isExtra && !isBlocking) {
      if (isTidal) {
        indices = ring.slice(0, n).map((_, k) => k); // full vertex set, same as a blocking land ring
      } else {
        // A non-blocking point-hazard circle is tiny (~0.05nm radius) and
        // only ever needs "pass on this side"/"pass on that side"-style
        // waypoints — every one of its ~10 vertices being a candidate
        // (today's behavior, since these rings have no convex[] array) is
        // what let a 9nm open-water route accumulate 4205 graph nodes from
        // 0 land obstacles. Keep only the ring's 4 route-relative extremes
        // instead.
        indices = _pickExtremeVerts(ring, n, cx, cy);
      }
    } else {
      for (let k = 0; k < n; k++) {
        // extraRings (tidal/hazard circles) don't carry a precomputed convex
        // array — a small polygon approximating a circle is fully convex
        // anyway, so treat a missing array as "every vertex counts".
        if (convex && !convex[k]) continue;
        const [vx, vy] = ring[k];
        // "No distance-to-LINE cutoff" for a blocking ring (that's the real
        // fix for MDI/Piscataqua-style local detours) is not the same as "no
        // geographic relevance check at all" — a ring the size of the whole
        // East Coast still only has a small portion actually near this route.
        if (isBlocking) { if (_inRelevantWindow(vx, vy)) indices.push(k); continue; }
        if (_ptSegDistNm(vx, vy, start.lon, start.lat, end.lon, end.lat) <= CORRIDOR_NM) indices.push(k);
      }
    }
    // Land's own MAX_BLOCKING_VERTS=300 assumes blocking rings are RARE —
    // in practice a route crosses at most a handful of separate landmasses
    // directly. Confirmed live that assumption breaks for tidal data: a
    // real ~11.4nm Rockland approach had 19 SEPARATE blocking tidal-zone
    // polygons on the direct line at once (charted drying flats are
    // naturally fragmented into many small/medium shapes, unlike a
    // landmass), so reusing land's per-ring cap here still let the total
    // balloon past DEADLINE_MS (19 rings x up to 300 verts each). Tidal
    // rings — blocking or not — get their own, much tighter per-ring cap
    // instead; point-hazard circles (isExtra && !isTidal) never reach this
    // branch at all, they already got their 4 extremes above.
    const blockingVertCap = isTidal ? MAX_TIDAL_VERTS
                          : (isExtra ? MAX_EXTRA_BLOCKING_VERTS : MAX_BLOCKING_VERTS);
    if ((isBlocking || isTidal) && indices.length > blockingVertCap) {
      const scored = indices.map(k => {
        const [vx, vy] = ring[k];
        const [ax, ay] = ring[(k - 1 + n) % n];
        const [bx, by] = ring[(k + 1) % n];
        const e1x = vx - ax, e1y = vy - ay, e2x = bx - vx, e2y = by - vy;
        const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
        const dot = Math.max(-1, Math.min(1, (e1x * e2x + e1y * e2y) / (l1 * l2)));
        return { k, angle: Math.acos(dot) };  // larger = sharper turn
      });
      scored.sort((a, b) => b.angle - a.angle);
      indices = scored.slice(0, blockingVertCap).map(s => s.k);
    }
    for (const k of indices) {
      const [vx, vy] = ring[k];
      // Candidate offset directions: the vertex's local outward normal
      // (averaged from its two adjacent ring edges, both possible signs since
      // ring winding isn't assumed), then the ring-centroid direction as a
      // fallback. A single fixed direction (e.g. centroid-only) works for a
      // simple convex island but regularly lands ON LAND on a concave,
      // convoluted coastline (a cove, a point) — verified directly against
      // real chart data: centroid-only put ~45% of offset points back on
      // land. Try each candidate at increasing distances and keep the first
      // one that's actually confirmed to be in open water; skip the vertex
      // entirely (rather than adding a broken, unusable node) if none work.
      const [ax, ay] = ring[(k - 1 + n) % n];
      const [bx, by] = ring[(k + 1) % n];
      const e1x = vx - ax, e1y = vy - ay, e2x = bx - vx, e2y = by - vy;
      let n1x = e1y, n1y = -e1x, n2x = e2y, n2y = -e2x;
      const l1 = Math.hypot(n1x, n1y) || 1, l2 = Math.hypot(n2x, n2y) || 1;
      n1x /= l1; n1y /= l1; n2x /= l2; n2y /= l2;
      let lnx = n1x + n2x, lny = n1y + n2y;
      const ll = Math.hypot(lnx, lny);
      if (ll > 1e-10) { lnx /= ll; lny /= ll; } else { lnx = n1x; lny = n1y; }
      const cdx = vx - cx, cdy = vy - cy, cl = Math.hypot(cdx, cdy) || 1;
      const cnx = cdx / cl, cny = cdy / cl;
      const candidates = [[lnx, lny], [-lnx, -lny], [cnx, cny], [-cnx, -cny]];

      let placed = false;
      // Best sub-standard candidate seen (real clearance measured, just short
      // of this rung's 0.8x target) — kept as a last resort for a passage
      // genuinely narrower than the ladder's tightest rung can clear (e.g. a
      // real harbor-mouth gut). Without this, EVERY candidate at EVERY rung
      // gets rejected, the vertex is dropped with no via-node at all, and the
      // whole leg silently falls back to a straight line across land instead
      // — confirmed live as the root cause of the Portsmouth pier -> York
      // Harbor regression (test/test_channel_routing.js cases [3]/[6]).
      // MIN_FALLBACK_CLEARANCE_NM stays well above the 0.016nm-from-land bug
      // this checkClearance gate exists to prevent in the first place.
      const MIN_FALLBACK_CLEARANCE_NM = 0.03;
      let bestFallback = null;
      for (const [dx, dy] of candidates) {
        for (const dist of offsetLadder) {
          const cv = Math.cos(vy * Math.PI / 180);
          const nx = vx + dist / (60 * cv) * dx;
          const ny = vy + dist / 60 * dy;
          if (_isOnLandLocal(nx, ny)) continue;
          // "Not literally on land" alone isn't the same as "actually dist
          // away from land" — the offset direction is derived from THIS
          // vertex's own ring, but a narrow passage (e.g. a river between two
          // close banks) can land the candidate clear of ITS ring yet still
          // close to a different, nearby one. Confirmed as a real gap by the
          // Piece 1c test suite (a 0.016nm-from-land node on the Portsmouth
          // approach) before this check existed — only applied for the
          // coastal standoff ladder (checkClearance), not the unchanged
          // hazard/tidal-ring ladder, which never claimed a standoff distance.
          if (checkClearance) {
            const clearance = Query.distanceToLandNm(nx, ny, dist);
            if (clearance < dist * 0.8) {
              if (clearance >= MIN_FALLBACK_CLEARANCE_NM &&
                  (!bestFallback || clearance > bestFallback.clearance)) {
                bestFallback = { nx, ny, clearance };
              }
              continue;
            }
          }
          nodes.push({ lon: nx, lat: ny }); placed = true; break;
        }
        if (placed) break;
      }
      // `marginal: true` survives into the final path (tracePath() below reuses
      // these exact node objects) so callers can still warn the user even
      // though this leg didn't fall back to a raw land-crossing line — a real
      // route was found, it just doesn't meet the normal comfort standoff.
      if (!placed && bestFallback) nodes.push({ lon: bestFallback.nx, lat: bestFallback.ny, marginal: true });
    }
  }

  // The only routing-relevant points on a small non-blocking hazard circle
  // are its extremes relative to the route's OWN direction — the two points
  // where a path could pass left/right of it, and the two where it could
  // pass in front of/behind it. (Every other vertex of the ~10-gon circle
  // approximation is redundant: it can never be a better bend point than one
  // of these four.) This never changes what segBlocked/Query.ringBlocks
  // check — those always use the ring's full geometry — it only limits which
  // vertices get offered to A* as candidate waypoints.
  function _pickExtremeVerts(ring, n, cx, cy) {
    const rdx = (end.lon - start.lon) * 60 * cosLat, rdy = (end.lat - start.lat) * 60;
    const rl = Math.hypot(rdx, rdy) || 1;
    const ux = rdx / rl, uy = rdy / rl;   // unit vector along the route
    const px = -uy, py = ux;              // unit vector across the route
    let iAlongMax = 0, iAlongMin = 0, iSideMax = 0, iSideMin = 0;
    let alongMax = -Infinity, alongMin = Infinity, sideMax = -Infinity, sideMin = Infinity;
    for (let k = 0; k < n; k++) {
      const [vx, vy] = ring[k];
      const dxNm = (vx - cx) * 60 * cosLat, dyNm = (vy - cy) * 60;
      const along = dxNm * ux + dyNm * uy;
      const side  = dxNm * px + dyNm * py;
      if (along > alongMax) { alongMax = along; iAlongMax = k; }
      if (along < alongMin) { alongMin = along; iAlongMin = k; }
      if (side  > sideMax)  { sideMax  = side;  iSideMax  = k; }
      if (side  < sideMin)  { sideMin  = side;  iSideMin  = k; }
    }
    return [...new Set([iAlongMax, iAlongMin, iSideMax, iSideMin])];
  }

  // All blocking rings get full tier-1 treatment in this single pass — this
  // is what actually fixes a multi-obstacle passage (Piscataqua's 8 rings,
  // MDI's 10): every one of them contributes its real bend points into the
  // same shared node array, so A* can thread between all of them at once,
  // instead of only ever getting one ring widened per retry.
  const blockingLandRings = [];
  const seenRings = new Set(landRingsInBox.map(e => e.ring));
  const nonBlockingLandCandidates = [];
  for (const entry of landRingsInBox) {
    if (Query.ringBlocks(entry.ring, start.lon, start.lat, end.lon, end.lat)) {
      _addRingNodes(entry, true, COASTAL_STANDOFF_LADDER, true);
      blockingLandRings.push(entry);
      continue;
    }
    const d = _ptSegDistNm(entry.cx, entry.cy, start.lon, start.lat, end.lon, end.lat);
    if (d <= CORRIDOR_NM) nonBlockingLandCandidates.push({ entry, d });
  }
  // Shared node budget across BOTH non-blocking land sources below (this
  // corridor pass and the staggered-obstacle pass) — closest-to-the-line
  // islands get first claim on it either way.
  let landNonBlockingNodesAdded = 0;
  nonBlockingLandCandidates.sort((a, b) => a.d - b.d);
  for (const { entry } of nonBlockingLandCandidates) {
    if (landNonBlockingNodesAdded >= MAX_LAND_NON_BLOCKING_NODES) break;
    const before = nodes.length;
    _addRingNodes(entry, false, COASTAL_STANDOFF_LADDER, true);
    landNonBlockingNodesAdded += nodes.length - before;
  }
  // Staggered-obstacle case: a detour around a directly-blocking ring can
  // reveal a second obstacle that doesn't block the ORIGINAL direct line and
  // sits outside CORRIDOR_NM of it. One bounded, non-iterative hop — pull in
  // any land ring near each blocking ring's own extent (not a rescan; reuses
  // the persistent index) — rather than an unbounded/iterative search. Real
  // multi-obstacle cases are, by definition, obstacles near EACH OTHER, which
  // is exactly what this captures.
  const corridorLon = CORRIDOR_NM / (60 * cosLat);
  const corridorLat = CORRIDOR_NM / 60;
  const staggeredCandidates = [];
  for (const entry of blockingLandRings) {
    const neighbors = Query.landRingsNear(
      entry.rMinX - corridorLon, entry.rMaxX + corridorLon,
      entry.rMinY - corridorLat, entry.rMaxY + corridorLat,
    );
    for (const nb of neighbors) {
      if (seenRings.has(nb.ring)) continue;
      seenRings.add(nb.ring);
      staggeredCandidates.push({ entry: nb, d: _ptSegDistNm(nb.cx, nb.cy, start.lon, start.lat, end.lon, end.lat) });
    }
  }
  staggeredCandidates.sort((a, b) => a.d - b.d);
  for (const { entry } of staggeredCandidates) {
    if (landNonBlockingNodesAdded >= MAX_LAND_NON_BLOCKING_NODES) break;
    const before = nodes.length;
    _addRingNodes(entry, false, COASTAL_STANDOFF_LADDER, true);
    landNonBlockingNodesAdded += nodes.length - before;
  }
  const nonBlockingExtraCandidates = [];
  for (const entry of extraRings) {
    const blocks = Query.ringBlocks(entry.ring, start.lon, start.lat, end.lon, end.lat);
    if (blocks) { _addRingNodes(entry, true, HAZARD_OFFSET_LADDER, false, true); continue; }
    const d = _ptSegDistNm(entry.cx, entry.cy, start.lon, start.lat, end.lon, end.lat);
    if (d <= EXTRA_CORRIDOR_NM) nonBlockingExtraCandidates.push({ entry, d });
  }
  // A dense real ledge field can put hundreds of non-blocking hazards in the
  // corridor at once — cap how many get to contribute routing waypoints,
  // closest-to-the-line first (they're still all checked for actual
  // collisions via extraGrid/segBlocked above, cap or no cap). See
  // MAX_EXTRA_NON_BLOCKING_RINGS's comment for the real case this fixes.
  nonBlockingExtraCandidates.sort((a, b) => a.d - b.d);
  let extraNonBlockingNodesAdded = 0;
  for (const { entry } of nonBlockingExtraCandidates.slice(0, MAX_EXTRA_NON_BLOCKING_RINGS)) {
    if (extraNonBlockingNodesAdded >= MAX_EXTRA_NON_BLOCKING_NODES) break;
    const before = nodes.length;
    _addRingNodes(entry, false, HAZARD_OFFSET_LADDER, false, true);
    extraNonBlockingNodesAdded += nodes.length - before;
  }

  if (Date.now() - _profT0 > DEADLINE_MS) {
    console.warn('[autoRoute] deadline exceeded during setup — returning straight line');
    return [start, end];
  }

  console.log(`[autoRoute] setup took ${Date.now() - _profT0}ms — ${nodes.length} nodes, ${landRingsInBox.length} land rings in bbox, ${extraRings.length} extra rings`);

  // A tight, enclosed anchorage (e.g. a narrow creek behind close-in ledges)
  // can leave the raw start/end point with ZERO clear line-of-sight to any
  // node in the graph at all — not a slow search, a genuinely empty one.
  // Verified live: a real Perry Creek (Vinalhaven) departure had 0/1057
  // candidate edges clear (1018 land-blocked, 39 hazard-blocked). No amount
  // of node thinning fixes that; the fix is the same "get clear of the
  // immediate shore first" idea _longRangeRoute already uses via
  // Query.findClearOffshorePoint, just triggered by actual local blockage
  // instead of only by distance. _escapeAttempted caps this at one retry so
  // a pathological case can't recurse forever — it just falls back honestly.
  if (!_escapeAttempted) {
    const _hasClearEdge = (p) => {
      for (let j = 0; j < nodes.length; j++) {
        const q = nodes[j];
        if (q === p) continue;
        if (!segBlocked(p.lon, p.lat, q.lon, q.lat)) return true;
      }
      return false;
    };
    // A sub-leg that fell back to its own raw 2-point line is only a real
    // success if that line is actually clear — checked against land AND
    // hazards/shoals via this call's own segBlocked, not the narrower
    // land-only _legFailed used elsewhere (that gap is pre-existing in
    // _longRangeRoute too, but matters acutely here since findClearOffshorePoint
    // itself only rules out LAND along its ray, never hazards).
    const _subLegOk = (leg) => leg.length > 2 || !segBlocked(leg[0].lon, leg[0].lat, leg[1].lon, leg[1].lat);
    const startBlocked = !_hasClearEdge(start);
    const endBlocked = !_hasClearEdge(end);
    if (startBlocked || endBlocked) {
      console.log(`[autoRoute] locally enclosed endpoint(s) detected — startBlocked=${startBlocked} endBlocked=${endBlocked}, attempting local escape`);
      // Each recursive sub-call below has its OWN full DEADLINE_MS budget —
      // without a check between them, a call that's slow-failing (not
      // instant, like Perry Creek's real case: each sub-attempt legitimately
      // explores its own local graph before giving up) can compound to
      // several times DEADLINE_MS. Gate each subsequent step on the OUTER
      // call's own elapsed time so the whole escape attempt still honors
      // roughly one DEADLINE_MS-sized budget, same as every other path here.
      let effStart = start, prefix = [];
      let effEnd = end, suffix = [];
      if (startBlocked) {
        const departurePt = Query.findClearOffshorePoint(start.lon, start.lat, end.lon, end.lat, { draftFt, tideHeightM });
        if (departurePt) {
          const departLeg = await autoRouteProg(start, departurePt, onUpdate, onText, true, draftFt, tideHeightM, onSearchProgress);
          if (_subLegOk(departLeg)) { prefix = departLeg.slice(0, -1); effStart = departurePt; }
        }
      }
      if (endBlocked && Date.now() - _profT0 <= DEADLINE_MS) {
        const arrivalPt = Query.findClearOffshorePoint(end.lon, end.lat, start.lon, start.lat, { draftFt, tideHeightM });
        if (arrivalPt) {
          const arriveLeg = await autoRouteProg(arrivalPt, end, onUpdate, onText, true, draftFt, tideHeightM, onSearchProgress);
          if (_subLegOk(arriveLeg)) { suffix = arriveLeg.slice(1); effEnd = arrivalPt; }
        }
      }
      if ((prefix.length || suffix.length) && Date.now() - _profT0 <= DEADLINE_MS) {
        const middle = await autoRouteProg(effStart, effEnd, onUpdate, onText, true, draftFt, tideHeightM, onSearchProgress);
        if (_subLegOk(middle)) {
          console.log(`[autoRoute] local escape succeeded — prefix ${prefix.length}pts, middle ${middle.length}pts, suffix ${suffix.length}pts`);
          return [...prefix, ...middle, ...suffix.slice(1)];
        }
      }
      // Escape attempt didn't produce a verified-clear path — fall through to
      // the normal search below, which will honestly report no-path-found
      // rather than ever return something unverified.
    }
  }

  if (onText) onText(`Routing… 0 / ${nodes.length} nodes`);

  // ── Min-heap helpers ───────────────────────────────────────────────────────
  const heap = [];
  function hpush(score, idx) {
    heap.push([score, idx]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  }
  function hpop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        let m = k, l = 2 * k + 1, r = l + 1;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  }

  // ── A* ────────────────────────────────────────────────────────────────────
  const N   = nodes.length;
  const INF = 1e9;
  const gScore = new Float64Array(N).fill(INF);
  const prev   = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N); // finalized nodes — see note below
  gScore[0]    = 0;
  hpush(Query.distanceNm(start.lon, start.lat, end.lon, end.lat), 0);

  // Open-node index, kept in sync via openPos so closing a node is O(1)
  // (swap it with the last open entry, then shrink) instead of the
  // relaxation loop re-scanning every node in the graph on every single
  // expansion regardless of how many are already finalized. Verified live
  // as a real, measurable cost on a genuinely hazard-dense corridor (Fox
  // Islands Thorofare / Isle au Haut, 1500+ nodes) — expansions late in a
  // long search were still paying the full O(N) scan cost of the very
  // first one.
  const openList = new Int32Array(N);
  const openPos  = new Int32Array(N);
  for (let i = 0; i < N; i++) { openList[i] = i; openPos[i] = i; }
  let openCount = N;
  function _closeNode(idx) {
    closed[idx] = 1;
    const pos = openPos[idx];
    const last = --openCount;
    const movedIdx = openList[last];
    openList[pos] = movedIdx;
    openPos[movedIdx] = pos;
    openList[last] = idx;
    openPos[idx] = last;
  }

  function tracePath(endIdx) {
    const p = [];
    for (let i = endIdx; i !== -1; i = prev[i]) p.push(nodes[i]);
    return p.reverse();
  }

  let expansions = 0;
  let pathImproved = false;

  while (heap.length) {
    const [, curr] = hpop();
    if (curr === 1) break;  // reached end node
    // A node can be pushed multiple times (once per improvement found); once
    // popped, its gScore is already optimal (non-negative edge weights), so a
    // later, staler heap entry for the same node is redundant work — without
    // this check, a densely-connected local visibility graph (many nearby
    // candidate nodes near a complex coastline) could re-run the full O(N)
    // relaxation loop for the same node many times over, compounding what
    // should be an O(N) expansion count into something far larger.
    if (closed[curr]) continue;
    _closeNode(curr);

    const a = nodes[curr];
    for (let oi = 0; oi < openCount; oi++) {
      const j = openList[oi];
      const b = nodes[j];
      if (segBlocked(a.lon, a.lat, b.lon, b.lat)) continue;
      const ng = gScore[curr] + Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
      if (ng < gScore[j]) {
        gScore[j] = ng;
        prev[j]   = curr;
        const h   = Query.distanceNm(b.lon, b.lat, end.lon, end.lat);
        hpush(ng + h, j);
        if (j === 1) pathImproved = true;
      }
    }

    // Channel-graph edges (real charted fairway/recommended-track data) are
    // relaxed WITHOUT segBlocked — land and channel geometry are independently
    // digitized ENC layers with no guaranteed topological consistency, so a
    // real, safe channel edge can spuriously fail a segBlocked check against a
    // nearby simplified land edge at simplification tolerance. Neutral
    // distance cost (not discounted): these edges win only when they're a
    // genuinely feasible route the normal check would have falsely blocked,
    // never to out-compete a real shorter, verified-clear line.
    if (channelNodeIdxSet.has(curr) && Query.channelNeighbors) {
      for (const nb of Query.channelNeighbors(a.lon, a.lat)) {
        const j = channelKeyToIdx.get(nb.key);
        if (j === undefined || closed[j]) continue;
        const ng = gScore[curr] + Query.distanceNm(a.lon, a.lat, nb.lon, nb.lat);
        if (ng < gScore[j]) {
          gScore[j] = ng;
          prev[j]   = curr;
          const h   = Query.distanceNm(nb.lon, nb.lat, end.lon, end.lat);
          hpush(ng + h, j);
          if (j === 1) pathImproved = true;
        }
      }
    }

    if (++expansions % 20 === 0) {
      // Move a visible dot to show A* is alive and where it's searching —
      // purely cosmetic, so it's an optional callback rather than a direct
      // Leaflet dependency; app.js's caller creates/moves/removes the actual
      // marker, Node callers (tests) simply omit it.
      if (onSearchProgress) onSearchProgress(a);
      // Redraw the live preview line at this same throttled cadence, not on
      // every single gScore improvement — onUpdate (setLatLngs on a Leaflet
      // polyline) is a real DOM/canvas redraw, and the end node's path can
      // improve dozens of times over a multi-hundred-expansion search on a
      // tightly-connected local graph. Calling it unthrottled was a real,
      // confirmed source of wall-clock overhead on real hardware: a route
      // that computes in ~600ms with this overhead removed (verified via a
      // synchronous port with no UI side effects) was hitting the 5-second
      // deadline in the live app on an ordinary desktop browser.
      if (pathImproved) { onUpdate(tracePath(1)); pathImproved = false; }
      if (onText) onText(`Routing… ${expansions} / ${N} nodes`);
      await delay(0);
      if (Date.now() - _profT0 > DEADLINE_MS) {
        console.warn('[autoRoute] deadline exceeded after', expansions, 'expansions');
        break;
      }
    }
  }

  if (onSearchProgress) onSearchProgress(null); // signals the caller to remove its progress marker
  console.log(`[autoRoute] A* done — ${expansions} expansions, ${N} nodes, ${Date.now() - _profT0}ms total`);

  if (gScore[1] === INF) {
    // Convex-vertex selection (see _addRingNodes above) already includes
    // every blocking ring's real bend points in this one pass — no retry, no
    // hand-picked via-waypoint fallback. If A* still can't connect start to
    // end within DEADLINE_MS, it's a genuinely unroutable case (or one that
    // needs a manual waypoint) — return the honest straight-line fallback,
    // never a partial/unverified path.
    console.warn('[autoRoute] no path found — returning straight line');
    return [start, end];
  }

  return tracePath(1);
}

// ── Long-range passage decomposition (Piece 1d) ─────────────────────────────
// The convex-vertex algorithm above is built for local/medium passages —
// verified fast and correct up to ~22nm. A real long coastal passage (e.g.
// Portsmouth NH -> Bar Harbor ME, ~136nm) isn't just slower, it's a different
// problem: tested directly (raising DEADLINE_MS to 30-60s, changing nothing
// else) and confirmed the search isn't slow, it's STUCK — every
// COASTAL_STANDOFF_LADDER offset point sits only 0.15-0.5nm off its own
// headland, with no line of sight past the next cape over, so the
// visibility graph is provably disconnected between start and end
// regardless of how long A* is allowed to run (a live probe against real
// chart data: A* exhausted its entire open set in 4 expansions, ~1s). More
// time doesn't fix a disconnected graph. The fix, per the user's own
// mariner's-eye framing: depart the coast, cross open water on a direct
// line (verified clear, not searched), arrive at the destination coast —
// see the plan file for the full empirical writeup.
export const LONG_RANGE_NM = 20;   // starting point, not calibrated — see plan's "Threshold" section
const LONG_RANGE_DEADLINE_MS = 15000; // separate internal budget, independent of DEADLINE_MS above
const LONG_RANGE_BUFFER_NM = 8;    // buffer on each side of a patched obstacle
const LONG_RANGE_MAX_HOPS = 6;     // bounded — more disjoint transit obstacles than this falls back honestly

// True if a straight line between two points needs no further checking at
// all — off land at both ends, and the segment itself doesn't cross land.
// Deliberately does NOT check hazards/tidal zones (see the plan's "Why not
// a universal fast-path" section) — that's covered separately, after the
// route is saved, by the existing _checkRouteHazards/_liveHazardCheck
// safety net (same mechanism already used for hand-drawn sketch routes).
function _isClearOffshoreLine(a, b) {
  return !Query.isLandAt(a.lon, a.lat) && !Query.isLandAt(b.lon, b.lat) &&
         !Query.landBlocks(a.lon, a.lat, b.lon, b.lat);
}

// Departure-point -> arrival-point transit leg: a straight line if already
// clear, otherwise patches just the blocked stretch(es) with the existing
// local algorithm (bracketed and clamped so each recursive call stays
// under LONG_RANGE_NM), walking forward one obstacle at a time rather than
// re-solving the whole span. Returns null on internal deadline exceeded or
// too many disjoint obstacles (LONG_RANGE_MAX_HOPS) — signals the caller to
// fall back to the honest full straight line.
async function _transitLeg(a, b, lrT0, onUpdate, onText, draftFt, tideHeightM, onSearchProgress) {
  if (_isClearOffshoreLine(a, b)) return [a, b];

  const result = [a];
  let cursor = a;
  for (let hop = 0; hop < LONG_RANGE_MAX_HOPS; hop++) {
    if (Date.now() - lrT0 > LONG_RANGE_DEADLINE_MS) return null;
    if (!Query.landBlocks(cursor.lon, cursor.lat, b.lon, b.lat)) {
      result.push(b);
      return result;
    }

    // Coarse march from cursor to b to find where the blockage starts/ends.
    const totalNm = Query.distanceNm(cursor.lon, cursor.lat, b.lon, b.lat);
    const STEP_NM = 1.0;
    const steps = Math.max(2, Math.ceil(totalNm / STEP_NM));
    let firstBlockedT = null, lastBlockedT = null;
    let prevPt = cursor;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const pt = { lat: cursor.lat + (b.lat - cursor.lat) * t, lon: cursor.lon + (b.lon - cursor.lon) * t };
      if (Query.landBlocks(prevPt.lon, prevPt.lat, pt.lon, pt.lat)) {
        if (firstBlockedT === null) firstBlockedT = (i - 1) / steps;
        lastBlockedT = t;
      }
      prevPt = pt;
    }
    if (firstBlockedT === null) { firstBlockedT = 0; lastBlockedT = 1; } // safety net, shouldn't happen

    // Bracket the blocked stretch with a buffer, clamped so the bracket's
    // own span stays under LONG_RANGE_NM — guarantees the recursive
    // _autoRouteProg call below takes the plain/existing branch, never
    // re-enters this one (an unclamped buffer was a real bug caught during
    // planning: a long blocked stretch + generous buffers on each side
    // could itself exceed the long-range threshold).
    const bufferT = Math.min(LONG_RANGE_BUFFER_NM / totalNm, 0.4);
    const startT = Math.max(0, firstBlockedT - bufferT);
    let endT = Math.min(1, lastBlockedT + bufferT);
    const spanNm = (endT - startT) * totalNm;
    if (spanNm > LONG_RANGE_NM - 1) endT = startT + (LONG_RANGE_NM - 1) / totalNm;

    const bracketStart = startT <= 0 ? cursor
      : { lat: cursor.lat + (b.lat - cursor.lat) * startT, lon: cursor.lon + (b.lon - cursor.lon) * startT };
    const bracketEnd = { lat: cursor.lat + (b.lat - cursor.lat) * endT, lon: cursor.lon + (b.lon - cursor.lon) * endT };

    if (startT > 0) result.push(bracketStart);
    const patched = await autoRouteProg(bracketStart, bracketEnd, onUpdate, onText, false, draftFt, tideHeightM, onSearchProgress);
    if (patched.length <= 2 && Query.landBlocks(patched[0].lon, patched[0].lat, patched[1].lon, patched[1].lat)) {
      return null; // local avoidance also failed for this obstacle — honest fallback, don't splice in a land crossing
    }
    for (const p of patched.slice(1)) result.push(p);

    cursor = bracketEnd;
    if (endT >= 1) return result;
  }
  return null; // too many disjoint obstacles along this transit
}

// Depart the coast near start, cross open water on a direct (verified, not
// searched) line, arrive at the coast near end — see the block comment
// above LONG_RANGE_NM. Only called for routes beyond that threshold;
// _autoRouteProg's existing algorithm is unchanged for everything else.
// True if a sub-leg's own result is itself a failed fallback — collapsed to
// a straight 2-point line that still crosses land. `_transitLeg`'s bracket
// patches already guard against splicing this in; the depart/arrive legs
// need the identical check (a real gap found live: a Portsmouth -> Port
// Clyde test case produced a `fallback: false` overall result that still
// crossed land, because the arrive leg silently fell back and got spliced
// in unchecked).
function _legFailed(leg) {
  return leg.length <= 2 && Query.landBlocks(leg[0].lon, leg[0].lat, leg[1].lon, leg[1].lat);
}

async function _longRangeRoute(start, end, onUpdate, onText, draftFt, tideHeightM, onSearchProgress) {
  const _lrT0 = Date.now();
  if (onText) onText('Planning long passage…');

  if (_isClearOffshoreLine(start, end)) return [start, end];
  if (Date.now() - _lrT0 > LONG_RANGE_DEADLINE_MS) return [start, end];

  const departurePt = Query.findClearOffshorePoint(start.lon, start.lat, end.lon, end.lat, { draftFt, tideHeightM });
  const arrivalPt = Query.findClearOffshorePoint(end.lon, end.lat, start.lon, start.lat, { draftFt, tideHeightM });
  if (!departurePt || !arrivalPt) return [start, end];
  if (Date.now() - _lrT0 > LONG_RANGE_DEADLINE_MS) return [start, end];

  const departLeg = await autoRouteProg(start, departurePt, onUpdate, onText, false, draftFt, tideHeightM, onSearchProgress);
  if (_legFailed(departLeg)) return [start, end];
  if (Date.now() - _lrT0 > LONG_RANGE_DEADLINE_MS) return [start, end];

  const transit = await _transitLeg(departurePt, arrivalPt, _lrT0, onUpdate, onText, draftFt, tideHeightM, onSearchProgress);
  if (!transit) return [start, end];

  const arriveLeg = await autoRouteProg(arrivalPt, end, onUpdate, onText, false, draftFt, tideHeightM, onSearchProgress);
  if (_legFailed(arriveLeg)) return [start, end];
  if (Date.now() - _lrT0 > LONG_RANGE_DEADLINE_MS) return [start, end];

  console.log(`[autoRoute] long-range passage done in ${Date.now() - _lrT0}ms — depart ${departLeg.length}pts, transit ${transit.length}pts, arrive ${arriveLeg.length}pts`);

  const result = [...departLeg];
  for (const p of transit.slice(1)) result.push(p);
  for (const p of arriveLeg.slice(1)) result.push(p);
  return result;
}

// A fallback straight line's own gScore[1]===INF tells us the search never
// connected start to end — it does NOT tell us WHY (land in the way vs. a
// charted point-hazard vs. both), and _showRouteFallbackWarning used to
// always say "land" regardless. Real bug found live (2026-08-23): a route
// through Fox Islands Thorofare's rock-strewn approach to Merchant Row fell
// back on a leg that runs directly over a charted underwater rock — open
// water the whole way, no land anywhere nearby — so a user reading "couldn't
// avoid land" has every reason to dismiss the warning as not applying here.
// Classify what a fallback segment actually crosses so the message matches
// what's really blocking it.
const _FALLBACK_HAZARD_LABELS = new Set(['underwater rock', 'obstruction', 'wreck', 'UWTROC', 'OBSTRN', 'WRECKS']);
const _FALLBACK_HAZARD_CORRIDOR_NM = 0.05; // matches HAZARD_SAFETY_NM in _autoRouteProg
export function classifyFallbackSeg(a, b) {
  const crossesLand = Query.landBlocks(a.lon, a.lat, b.lon, b.lat);
  const segLenNm = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
  let crossesHazard = false;
  for (const f of (Query.hazards?.features || [])) {
    if (f.geometry?.type !== 'Point') continue;
    const label = f.properties?.label || f.properties?.objtype || '';
    if (!_FALLBACK_HAZARD_LABELS.has(label)) continue;
    const [pLon, pLat] = f.geometry.coordinates;
    const ct = Query.segCrossTrack(a.lon, a.lat, b.lon, b.lat, pLon, pLat);
    if (!ct) continue;
    if (Math.abs(ct.crossTrack) <= _FALLBACK_HAZARD_CORRIDOR_NM && ct.alongTrack >= 0 && ct.alongTrack <= segLenNm) {
      crossesHazard = true;
      break;
    }
  }
  return { crossesLand, crossesHazard };
}
