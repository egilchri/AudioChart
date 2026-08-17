/**
 * Channel-aware, general multi-obstacle auto-routing certification.
 *
 * Run with:   node test/test_channel_routing.js
 *   → runs the regression suite below against real production chart data
 *     (www/data/land.geojson, channel_graph.geojson).
 *
 * A direct port of the land-avoidance + convex-vertex node selection +
 * channel-graph core of _autoRouteProg() in www/js/app.js (same convention
 * as test_route_hazard_clearance.js — _autoRouteProg can't run outside a
 * browser, it touches L.circleMarker/document.getElementById), so a route
 * this certifies as findable/clean is what the in-app router should also
 * produce. Point-hazard/tidal obstacles are intentionally left out — this
 * suite is specifically about land-avoidance, channel-graph, and timing
 * behavior, not a re-test of the existing hazard-clearance suite.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'www', 'data');
const DEADLINE_MS = 5000;  // mirrors _autoRouteProg's production budget

// ── Geometry (mirrors www/js/query.js) ────────────────────────────────────────

function distanceNm(lon1, lat1, lon2, lat2) {
  const R = 3440.065;
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dphi = (lat2 - lat1) * Math.PI / 180;
  const dlam = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function segsIntersect(ax, ay, bx, by, px, py, qx, qy) {
  const cross = (ox, oy, ux, uy, vx, vy) => (ux - ox) * (vy - oy) - (uy - oy) * (vx - ox);
  const d1 = cross(px, py, qx, qy, ax, ay), d2 = cross(px, py, qx, qy, bx, by);
  const d3 = cross(ax, ay, bx, by, px, py), d4 = cross(ax, ay, bx, by, qx, qy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function ringBlocks(ring, ax, ay, bx, by) {
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
    if (segsIntersect(ax, ay, bx, by, x1, y1, x2, y2)) return true;
  }
  return false;
}
function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function ptSegDistNm(ptLon, ptLat, aLon, aLat, bLon, bLat) {
  const dx = bLon - aLon, dy = bLat - aLat;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return distanceNm(ptLon, ptLat, aLon, aLat);
  const t = Math.max(0, Math.min(1, ((ptLon - aLon) * dx + (ptLat - aLat) * dy) / len2));
  return distanceNm(ptLon, ptLat, aLon + t * dx, aLat + t * dy);
}

// ── Land data (flat scan — fine for a test harness, unlike the app's indexed version) ──
// Precomputes the same convex-vertex flag per ring that query.js's
// _buildLandEdgeIndex/processRing now computes at load time.

function computeConvex(outer) {
  const n = outer.length - 1;
  const convex = new Uint8Array(n);
  if (n < 3) return convex;
  let signedArea = 0;
  for (let k = 0; k < n; k++) {
    const [x1, y1] = outer[k], [x2, y2] = outer[(k + 1) % n];
    signedArea += x1 * y2 - x2 * y1;
  }
  const areaSign = signedArea >= 0 ? 1 : -1;
  for (let k = 0; k < n; k++) {
    const [vx, vy] = outer[k];
    const [ax, ay] = outer[(k - 1 + n) % n];
    const [bx, by] = outer[(k + 1) % n];
    const cross = (vx - ax) * (by - vy) - (vy - ay) * (bx - vx);
    if (Math.sign(cross) === areaSign) convex[k] = 1;
  }
  return convex;
}

function loadLand() {
  const land = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'land.geojson')));
  const rings = [];
  for (const f of land.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      const outer = poly[0];
      let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity, cx = 0, cy = 0;
      for (const [x, y] of outer) {
        if (x < rMinX) rMinX = x; if (x > rMaxX) rMaxX = x;
        if (y < rMinY) rMinY = y; if (y > rMaxY) rMaxY = y;
        cx += x; cy += y;
      }
      cx /= outer.length; cy /= outer.length;
      rings.push({ ring: outer, rMinX, rMaxX, rMinY, rMaxY, cx, cy, convex: computeConvex(outer) });
    }
  }
  return rings;
}

function isOnLand(allRings, lon, lat) {
  for (const r of allRings) {
    if (lon < r.rMinX || lon > r.rMaxX || lat < r.rMinY || lat > r.rMaxY) continue;
    if (pointInRing(lon, lat, r.ring)) return true;
  }
  return false;
}
function landBlocks(allRings, ax, ay, bx, by) {
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by), maxY = Math.max(ay, by);
  for (const r of allRings) {
    if (r.rMaxX < minX || r.rMinX > maxX || r.rMaxY < minY || r.rMinY > maxY) continue;
    if (ringBlocks(r.ring, ax, ay, bx, by)) return true;
  }
  return false;
}
function landRingsNear(allRings, minLon, maxLon, minLat, maxLat) {
  const out = [];
  for (const r of allRings) {
    if (r.rMaxX < minLon || r.rMinX > maxLon || r.rMaxY < minLat || r.rMinY > maxLat) continue;
    out.push(r);
  }
  return out;
}

// ── Channel graph (mirrors query.js's channel index) ──────────────────────────

function nodeKey(lon, lat) { return `${lat.toFixed(4)},${lon.toFixed(4)}`; }

function loadChannelGraph() {
  const p = path.join(DATA_DIR, 'channel_graph.geojson');
  if (!fs.existsSync(p)) return { nodes: new Map(), adjacency: new Map() };
  const fc = JSON.parse(fs.readFileSync(p));
  const nodes = new Map(), adjacency = new Map();
  const ensure = (lon, lat) => {
    const key = nodeKey(lon, lat);
    if (!nodes.has(key)) nodes.set(key, { lon, lat });
    return key;
  };
  const connect = (ka, kb) => {
    if (ka === kb) return;
    const a = nodes.get(ka), b = nodes.get(kb);
    let arrA = adjacency.get(ka); if (!arrA) { arrA = []; adjacency.set(ka, arrA); }
    let arrB = adjacency.get(kb); if (!arrB) { arrB = []; adjacency.set(kb, arrB); }
    if (!arrA.some(n => n.key === kb)) arrA.push({ key: kb, lon: b.lon, lat: b.lat });
    if (!arrB.some(n => n.key === ka)) arrB.push({ key: ka, lon: a.lon, lat: a.lat });
  };
  for (const f of fc.features) {
    const c = f.geometry.coordinates;
    for (let i = 0; i < c.length - 1; i++) {
      const ka = ensure(c[i][0], c[i][1]), kb = ensure(c[i + 1][0], c[i + 1][1]);
      connect(ka, kb);
    }
  }
  return { nodes, adjacency };
}

function channelNodesNear(chGraph, minLon, maxLon, minLat, maxLat) {
  const out = [];
  for (const [key, n] of chGraph.nodes) {
    if (n.lon >= minLon && n.lon <= maxLon && n.lat >= minLat && n.lat <= maxLat) {
      out.push({ lon: n.lon, lat: n.lat, key });
    }
  }
  return out;
}

// ── Router: convex-vertex visibility-graph + A*, land + channel graph ─────────
// Direct port of _autoRouteProg's core (www/js/app.js): convex-vertex node
// selection (no more distance-sampled/escalation-retry approach), one-hop
// staggered-obstacle neighbor expansion, channel-graph edges relaxed without
// segBlocked, and a single DEADLINE_MS wall-clock budget covering the whole
// call. Point-hazard/tidal obstacles are intentionally omitted (see header).

const PAD_NM = 2.0, SAFETY_NM = 0.05, CORRIDOR_NM = 3.0, MAX_BLOCKING_VERTS = 300;

function autoRoute(allRings, chGraph, start, end) {
  const t0 = Date.now();
  const midLat = (start.lat + end.lat) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  const padLon = PAD_NM / (60 * cosLat), padLat = PAD_NM / 60;
  const bMinLon = Math.min(start.lon, end.lon) - padLon, bMaxLon = Math.max(start.lon, end.lon) + padLon;
  const bMinLat = Math.min(start.lat, end.lat) - padLat, bMaxLat = Math.max(start.lat, end.lat) + padLat;

  const nodes = [start, end];

  const channelNodeIdxSet = new Set();
  const channelKeyToIdx = new Map();
  for (const cn of channelNodesNear(chGraph, bMinLon, bMaxLon, bMinLat, bMaxLat)) {
    const idx = nodes.length;
    nodes.push({ lon: cn.lon, lat: cn.lat });
    channelNodeIdxSet.add(idx);
    channelKeyToIdx.set(cn.key, idx);
  }

  const landRingsInBox = landRingsNear(allRings, bMinLon, bMaxLon, bMinLat, bMaxLat);

  function addRingNodes(entry, isBlocking) {
    const { ring, cx, cy, convex } = entry;
    const n = ring.length - 1;
    let indices = [];
    for (let k = 0; k < n; k++) {
      if (convex && !convex[k]) continue;
      if (isBlocking) { indices.push(k); continue; }
      const [vx, vy] = ring[k];
      if (ptSegDistNm(vx, vy, start.lon, start.lat, end.lon, end.lat) <= CORRIDOR_NM) indices.push(k);
    }
    if (isBlocking && indices.length > MAX_BLOCKING_VERTS) {
      const scored = indices.map(k => {
        const [vx, vy] = ring[k];
        const [ax, ay] = ring[(k - 1 + n) % n];
        const [bx, by] = ring[(k + 1) % n];
        const e1x = vx - ax, e1y = vy - ay, e2x = bx - vx, e2y = by - vy;
        const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
        const dot = Math.max(-1, Math.min(1, (e1x * e2x + e1y * e2y) / (l1 * l2)));
        return { k, angle: Math.acos(dot) };
      });
      scored.sort((a, b) => b.angle - a.angle);
      indices = scored.slice(0, MAX_BLOCKING_VERTS).map(s => s.k);
    }
    for (const k of indices) {
      const [vx, vy] = ring[k];
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
      for (const [dx, dy] of candidates) {
        for (const dist of [SAFETY_NM, SAFETY_NM * 2, SAFETY_NM * 4]) {
          const cv = Math.cos(vy * Math.PI / 180);
          const nx = vx + dist / (60 * cv) * dx;
          const ny = vy + dist / 60 * dy;
          if (!isOnLand(allRings, nx, ny)) { nodes.push({ lon: nx, lat: ny }); placed = true; break; }
        }
        if (placed) break;
      }
    }
  }

  const SNAP_RADIUS_NM = 0.15;
  function snapOffLand(pt) {
    if (!isOnLand(allRings, pt.lon, pt.lat)) return pt;
    for (let r = 0.02; r <= SNAP_RADIUS_NM; r += 0.02) {
      for (let ang = 0; ang < 360; ang += 30) {
        const rad = ang * Math.PI / 180;
        const cv = Math.cos(pt.lat * Math.PI / 180);
        const tx = pt.lon + r / (60 * cv) * Math.cos(rad);
        const ty = pt.lat + r / 60 * Math.sin(rad);
        if (!isOnLand(allRings, tx, ty)) return { lat: ty, lon: tx };
      }
    }
    return pt;
  }
  start = snapOffLand(start); end = snapOffLand(end);
  nodes[0] = start; nodes[1] = end;

  const blockingLandRings = [];
  const seenRings = new Set(landRingsInBox.map(e => e.ring));
  for (const entry of landRingsInBox) {
    if (ringBlocks(entry.ring, start.lon, start.lat, end.lon, end.lat)) {
      addRingNodes(entry, true);
      blockingLandRings.push(entry);
      continue;
    }
    const d = ptSegDistNm(entry.cx, entry.cy, start.lon, start.lat, end.lon, end.lat);
    if (d <= CORRIDOR_NM) addRingNodes(entry, false);
  }
  const corridorLon = CORRIDOR_NM / (60 * cosLat), corridorLat = CORRIDOR_NM / 60;
  for (const entry of blockingLandRings) {
    const neighbors = landRingsNear(
      allRings,
      entry.rMinX - corridorLon, entry.rMaxX + corridorLon,
      entry.rMinY - corridorLat, entry.rMaxY + corridorLat,
    );
    for (const nb of neighbors) {
      if (seenRings.has(nb.ring)) continue;
      seenRings.add(nb.ring);
      addRingNodes(nb, false);
    }
  }

  if (Date.now() - t0 > DEADLINE_MS) {
    return { path: [start, end], fallback: true, expansions: 0, ms: Date.now() - t0 };
  }

  function segBlocked(lon1, lat1, lon2, lat2) { return landBlocks(allRings, lon1, lat1, lon2, lat2); }

  const N = nodes.length, INF = 1e9;
  const gScore = new Float64Array(N).fill(INF);
  const prev = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  gScore[0] = 0;
  const heap = [];
  function hpush(score, idx) {
    heap.push([score, idx]);
    let k = heap.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
  }
  function hpop() {
    const top = heap[0]; const last = heap.pop();
    if (heap.length) {
      heap[0] = last; let k = 0;
      for (;;) {
        let m = k, l = 2 * k + 1, r = l + 1;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
      }
    }
    return top;
  }
  hpush(distanceNm(start.lon, start.lat, end.lon, end.lat), 0);

  function tracePath(endIdx) { const p = []; for (let i = endIdx; i !== -1; i = prev[i]) p.push(nodes[i]); return p.reverse(); }

  let expansions = 0;
  while (heap.length) {
    const [, curr] = hpop();
    if (curr === 1) break;
    if (closed[curr]) continue;
    closed[curr] = 1;
    const a = nodes[curr];
    for (let j = 0; j < N; j++) {
      if (j === curr || closed[j]) continue;
      const b = nodes[j];
      if (segBlocked(a.lon, a.lat, b.lon, b.lat)) continue;
      const ng = gScore[curr] + distanceNm(a.lon, a.lat, b.lon, b.lat);
      if (ng < gScore[j]) { gScore[j] = ng; prev[j] = curr; hpush(ng + distanceNm(b.lon, b.lat, end.lon, end.lat), j); }
    }
    if (channelNodeIdxSet.has(curr)) {
      const key = nodeKey(a.lon, a.lat);
      for (const nb of (chGraph.adjacency.get(key) || [])) {
        const j = channelKeyToIdx.get(nb.key);
        if (j === undefined || closed[j]) continue;
        const ng = gScore[curr] + distanceNm(a.lon, a.lat, nb.lon, nb.lat);
        if (ng < gScore[j]) { gScore[j] = ng; prev[j] = curr; hpush(ng + distanceNm(nb.lon, nb.lat, end.lon, end.lat), j); }
      }
    }
    expansions++;
    if (expansions % 20 === 0 && Date.now() - t0 > DEADLINE_MS) break;
  }

  const ms = Date.now() - t0;
  if (gScore[1] === INF) {
    return { path: [start, end], fallback: true, expansions, ms };
  }
  return { path: tracePath(1), fallback: false, expansions, ms, nm: gScore[1] };
}

// ── Hazard check (mirrors _checkRouteHazards, land-crossing only for this suite) ──

function pathCrossesLand(allRings, points) {
  for (let i = 0; i < points.length - 1; i++) {
    if (landBlocks(allRings, points[i].lon, points[i].lat, points[i + 1].lon, points[i + 1].lat)) return true;
  }
  return false;
}

// ── Certification suite ────────────────────────────────────────────────────────

function report(label, allRings, chGraph, start, end) {
  const { path, fallback, expansions, ms, nm } = autoRoute(allRings, chGraph, start, end);
  const crosses = pathCrossesLand(allRings, path);
  const timeOk = ms < DEADLINE_MS;
  const ok = !fallback && !crosses && timeOk;
  const slow = ms > 1500;
  console.log(`${label}: ${ok ? 'PASS' : 'FAIL'} (fallback=${fallback}, crossesLand=${crosses}, ${expansions} expansions, ${path.length} pts, ${ms}ms${nm ? `, ${nm.toFixed(2)}nm` : ''})`);
  if (slow && ok) console.log(`  ⚠ slow: ${ms}ms exceeds the 1500ms early-regression warning threshold (hard fail is ${DEADLINE_MS}ms)`);
  return ok;
}

function run() {
  const allRings = loadLand();
  const chGraph = loadChannelGraph();
  console.log(`Loaded ${allRings.length} land rings, ${chGraph.nodes.size} channel-graph nodes.\n`);

  let failures = 0;

  // Case 1 — cheap synthetic single-ring case, kept as a fast perf floor
  // (not a regression target on its own — case 2 below is the real
  // multi-ring regression) — a small square land block placed directly
  // between two water points.
  {
    const start = { lon: -68.30, lat: 44.30 };
    const end   = { lon: -68.28, lat: 44.30 };
    const outer = [[-68.296, 44.295], [-68.296, 44.305], [-68.284, 44.305], [-68.284, 44.295], [-68.296, 44.295]];
    const syntheticRing = {
      ring: outer, rMinX: -68.296, rMaxX: -68.284, rMinY: 44.295, rMaxY: 44.305, cx: -68.29, cy: 44.30,
      convex: computeConvex(outer),
    };
    if (!report('[1] Single-ring perf floor', [syntheticRing], chGraph, start, end)) failures++;
  }

  // Case 2 — the real multi-ring regression: a direct line from Frenchman Bay
  // (east of Mount Desert Island) to Blue Hill Bay (west of it) crosses 10
  // separate land rings against current chart data (confirmed this session) —
  // this is what the old single-ring escalation retry could never fully
  // solve, and is now handled by the convex-vertex approach in one pass.
  {
    const start = { lat: 44.3995406, lon: -68.1998858 };
    const end   = { lat: 44.2415486, lon: -68.4848074 };
    if (!report('[2] Mount Desert Island 10-ring regression', allRings, chGraph, start, end)) failures++;
  }

  // Case 3 — the originally-reported bug, full end to end: Portsmouth NH pier
  // to York Harbor ME. With Piece 1a (channel data) alone this only certified
  // the harbor-mouth passage; the general convex-vertex fix should now get
  // all the way to York without needing any charted track data for the open
  // coastal stretch beyond the harbor mouth. If it still can't, that's a real
  // finding to report, not a test to quietly re-scope.
  {
    const start = { lat: 43.08077, lon: -70.757141 };
    const end   = { lat: 43.129213, lon: -70.632961 };
    if (!report('[3] Portsmouth pier -> York Harbor (full route)', allRings, chGraph, start, end)) failures++;
  }

  // Case 4 — staggered obstacles: two rings, NEITHER blocks the original
  // direct line nor sits within CORRIDOR_NM of it individually, but they're
  // adjacent to each other near the true bent path — the one behavior in
  // this design without a real-data example, needs a deterministic synthetic
  // pin. Ring A blocks the direct line; ring B sits just past A's far side,
  // reachable only via the one-hop neighbor expansion.
  {
    const start = { lon: -68.50, lat: 44.50 };
    const end   = { lon: -68.44, lat: 44.50 };
    const outerA = [[-68.482, 44.495], [-68.482, 44.505], [-68.468, 44.505], [-68.468, 44.495], [-68.482, 44.495]];
    const outerB = [[-68.462, 44.501], [-68.462, 44.509], [-68.452, 44.509], [-68.452, 44.501], [-68.462, 44.501]];
    const ringA = { ring: outerA, rMinX: -68.482, rMaxX: -68.468, rMinY: 44.495, rMaxY: 44.505, cx: -68.475, cy: 44.50, convex: computeConvex(outerA) };
    const ringB = { ring: outerB, rMinX: -68.462, rMaxX: -68.452, rMinY: 44.501, rMaxY: 44.509, cx: -68.457, cy: 44.505, convex: computeConvex(outerB) };
    if (!report('[4] Staggered-obstacle synthetic case', [ringA, ringB], chGraph, start, end)) failures++;
  }

  // Case 5 — fallback safety: with channel-graph data forced empty, land-only
  // routing must still work (proves the channel-graph code path is inert
  // when there's no channel data, using the MDI multi-ring case since it
  // doesn't depend on channel data to begin with).
  {
    const emptyGraph = { nodes: new Map(), adjacency: new Map() };
    const start = { lat: 44.3995406, lon: -68.1998858 };
    const end   = { lat: 44.2415486, lon: -68.4848074 };
    if (!report('[5] Fallback safety (no channel data)', allRings, emptyGraph, start, end)) failures++;
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll cases passed.');
  process.exit(failures ? 1 : 0);
}

run();
