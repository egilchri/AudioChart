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
function bearing(lon1, lat1, lon2, lat2) {
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dlam = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dlam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlam);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}
function offsetCoords(lat, lon, bearingDeg, distNm = 3.0) {
  const R = 3440.065;
  const d = distNm / R;
  const brg = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180, lon1 = lon * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
  const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
                                  Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
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

// Simplified port of Query.findWaterNear — no harbor-preference search (that
// logic lives entirely in query.js and is out of scope for this land/channel
// routing suite), just the plain radial spiral fallback.
function findWaterNearSimple(allRings, lon, lat, maxRadiusNm = 2.0) {
  if (!isOnLand(allRings, lon, lat)) return { lon, lat };
  for (let r = 0.02; r <= maxRadiusNm; r += 0.02) {
    for (let ang = 0; ang < 360; ang += 15) {
      const rad = ang * Math.PI / 180;
      const cv = Math.cos(lat * Math.PI / 180);
      const tx = lon + r / (60 * cv) * Math.cos(rad);
      const ty = lat + r / 60 * Math.sin(rad);
      if (!isOnLand(allRings, tx, ty)) return { lon: tx, lat: ty };
    }
  }
  return null;
}

// Mirrors query.js's _distToLandAlongBearing (Piece 1d) — coarse march then
// refine, NOT a plain endpoint-only binary search (unsound whenever a ray
// crosses clean through a landmass and re-emerges in open water beyond it).
function distToLandAlongBearing(allRings, lon, lat, bearingDeg, maxNm, coarseStepNm = 0.05) {
  let lastWater = 0;
  for (let d = coarseStepNm; d <= maxNm; d += coarseStepNm) {
    const p = offsetCoords(lat, lon, bearingDeg, d);
    if (isOnLand(allRings, p.lon, p.lat)) {
      let lo = lastWater, hi = d;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        const pm = offsetCoords(lat, lon, bearingDeg, mid);
        if (isOnLand(allRings, pm.lon, pm.lat)) hi = mid; else lo = mid;
      }
      return lo;
    }
    lastWater = d;
  }
  return maxNm;
}

// Mirrors query.js's Query.findClearOffshorePoint (Piece 1d) — ray-cast for
// the most-open direction (default unrestricted, coneDeg=180 — found live
// that a harbor's one real opening can point away from the eventual
// destination entirely, e.g. Bar Harbor's exit is NE into Frenchman Bay,
// not the SW bearing toward Portsmouth), march out until clearly open. See
// query.js's version for the full rationale.
function findClearOffshorePoint(allRings, lon, lat, towardLon, towardLat, opts = {}) {
  const coneDeg = opts.coneDeg ?? 180;
  const maxNm = opts.maxNm ?? 8;
  const rays = opts.rays ?? 24;
  const openWidthNm = opts.openWidthNm ?? 1.0;
  const stepNm = opts.stepNm ?? 0.15;

  if (isOnLand(allRings, lon, lat)) {
    const w = findWaterNearSimple(allRings, lon, lat);
    if (!w) return null;
    lon = w.lon; lat = w.lat;
  }

  const centerBrg = bearing(lon, lat, towardLon, towardLat);
  let bestBrg = centerBrg, bestOpen = -1;
  for (let i = 0; i < rays; i++) {
    const offsetDeg = rays > 1 ? -coneDeg + (2 * coneDeg * i) / (rays - 1) : 0;
    const brg = (centerBrg + offsetDeg + 360) % 360;
    const d = distToLandAlongBearing(allRings, lon, lat, brg, maxNm);
    if (d > bestOpen) { bestOpen = d; bestBrg = brg; }
  }

  let placed = { lat, lon };
  for (let d = stepNm; d <= bestOpen; d += stepNm) {
    const p = offsetCoords(lat, lon, bestBrg, d);
    if (isOnLand(allRings, p.lon, p.lat)) break;
    placed = p;
    const leftNm = distToLandAlongBearing(allRings, p.lon, p.lat, (bestBrg + 90) % 360, openWidthNm);
    const rightNm = distToLandAlongBearing(allRings, p.lon, p.lat, (bestBrg + 270) % 360, openWidthNm);
    if (leftNm + rightNm >= openWidthNm * 1.6) break;
  }
  return placed;
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
// Mirrors app.js's Piece 1c split: land rings get a comfortable-standoff-
// first ladder (mariner keeps distance from land), hazard/tidal rings keep
// the original tight ladder (avoiding a specific charted danger, not general
// coastal standoff).
const COASTAL_STANDOFF_LADDER = [0.5, 0.25, 0.15];
const HAZARD_OFFSET_LADDER = [SAFETY_NM, SAFETY_NM * 2, SAFETY_NM * 4];

// Mirrors app.js's Piece 1d long-range passage decomposition constants —
// see app.js's block comment above LONG_RANGE_NM for the full rationale
// (empirically confirmed: a long coastal passage's visibility graph is
// disconnected, not just slow — more time doesn't fix it).
const LONG_RANGE_NM = 20;
const LONG_RANGE_DEADLINE_MS = 15000;
const LONG_RANGE_BUFFER_NM = 8;
const LONG_RANGE_MAX_HOPS = 6;

function autoRoute(allRings, chGraph, start, end) {
  const t0 = Date.now();
  const directNm0 = distanceNm(start.lon, start.lat, end.lon, end.lat);
  if (directNm0 > LONG_RANGE_NM) {
    return longRangeRoute(allRings, chGraph, start, end, t0);
  }
  const midLat = (start.lat + end.lat) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  const padLon = PAD_NM / (60 * cosLat), padLat = PAD_NM / 60;
  const bMinLon = Math.min(start.lon, end.lon) - padLon, bMaxLon = Math.max(start.lon, end.lon) + padLon;
  const bMinLat = Math.min(start.lat, end.lat) - padLat, bMaxLat = Math.max(start.lat, end.lat) + padLat;

  // See app.js's matching comment: a directly-blocking ring's "every convex
  // vertex" rule needs a geographic relevance window, not just a distance-
  // to-LINE exemption — otherwise a huge simplified coastline ring can offer
  // up an irrelevant sharp-angled vertex many miles off-route as a "bend
  // point" (real bug: Portsmouth NH -> York ME routed via Newburyport MA).
  const relevantNm = Math.min(Math.max(distanceNm(start.lon, start.lat, end.lon, end.lat) * 0.75, 5), 25);
  const relevantLon = relevantNm / (60 * cosLat), relevantLat = relevantNm / 60;
  const relMinLon = Math.min(start.lon, end.lon) - relevantLon, relMaxLon = Math.max(start.lon, end.lon) + relevantLon;
  const relMinLat = Math.min(start.lat, end.lat) - relevantLat, relMaxLat = Math.max(start.lat, end.lat) + relevantLat;
  const inRelevantWindow = (lon, lat) => lon >= relMinLon && lon <= relMaxLon && lat >= relMinLat && lat <= relMaxLat;

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

  // Mirrors query.js's Query.distanceToLandNm (Piece 1c) — bbox-rejects rings
  // and edges outside the search radius first, so this stays cheap enough to
  // call once per candidate offset point despite the flat (non-indexed) ring
  // scan this test harness otherwise uses.
  function distanceToLandNm(lon, lat, maxSearchNm) {
    const cv = Math.cos(lat * Math.PI / 180) || 1e-9;
    const padLon = maxSearchNm / (60 * cv), padLat = maxSearchNm / 60;
    const minX = lon - padLon, maxX = lon + padLon, minY = lat - padLat, maxY = lat + padLat;
    let best = Infinity;
    for (const r of allRings) {
      if (r.rMaxX < minX || r.rMinX > maxX || r.rMaxY < minY || r.rMinY > maxY) continue;
      const ring = r.ring;
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
        if (Math.max(x1, x2) < minX || Math.min(x1, x2) > maxX || Math.max(y1, y2) < minY || Math.min(y1, y2) > maxY) continue;
        const d = ptSegDistNm(lon, lat, x1, y1, x2, y2);
        if (d < best) best = d;
      }
    }
    return best;
  }

  function addRingNodes(entry, isBlocking, offsetLadder, checkClearance) {
    const { ring, cx, cy, convex } = entry;
    const n = ring.length - 1;
    let indices = [];
    for (let k = 0; k < n; k++) {
      if (convex && !convex[k]) continue;
      const [vx, vy] = ring[k];
      if (isBlocking) { if (inRelevantWindow(vx, vy)) indices.push(k); continue; }
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
        for (const dist of offsetLadder) {
          const cv = Math.cos(vy * Math.PI / 180);
          const nx = vx + dist / (60 * cv) * dx;
          const ny = vy + dist / 60 * dy;
          if (isOnLand(allRings, nx, ny)) continue;
          if (checkClearance && distanceToLandNm(nx, ny, dist) < dist * 0.8) continue;
          nodes.push({ lon: nx, lat: ny }); placed = true; break;
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
      addRingNodes(entry, true, COASTAL_STANDOFF_LADDER, true);
      blockingLandRings.push(entry);
      continue;
    }
    const d = ptSegDistNm(entry.cx, entry.cy, start.lon, start.lat, end.lon, end.lat);
    if (d <= CORRIDOR_NM) addRingNodes(entry, false, COASTAL_STANDOFF_LADDER, true);
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
      addRingNodes(nb, false, COASTAL_STANDOFF_LADDER, true);
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

// ── Long-range passage decomposition (mirrors app.js's Piece 1d) ──────────────

function isClearOffshoreLine(allRings, a, b) {
  return !isOnLand(allRings, a.lon, a.lat) && !isOnLand(allRings, b.lon, b.lat) &&
         !landBlocks(allRings, a.lon, a.lat, b.lon, b.lat);
}

function transitLeg(allRings, chGraph, a, b, lrT0) {
  if (isClearOffshoreLine(allRings, a, b)) return { path: [a, b], expansions: 0 };

  const result = [a];
  let cursor = a;
  let totalExpansions = 0;
  for (let hop = 0; hop < LONG_RANGE_MAX_HOPS; hop++) {
    if (Date.now() - lrT0 > LONG_RANGE_DEADLINE_MS) return null;
    if (!landBlocks(allRings, cursor.lon, cursor.lat, b.lon, b.lat)) {
      result.push(b);
      return { path: result, expansions: totalExpansions };
    }

    const totalNm = distanceNm(cursor.lon, cursor.lat, b.lon, b.lat);
    const STEP_NM = 1.0;
    const steps = Math.max(2, Math.ceil(totalNm / STEP_NM));
    let firstBlockedT = null, lastBlockedT = null;
    let prevPt = cursor;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const pt = { lat: cursor.lat + (b.lat - cursor.lat) * t, lon: cursor.lon + (b.lon - cursor.lon) * t };
      if (landBlocks(allRings, prevPt.lon, prevPt.lat, pt.lon, pt.lat)) {
        if (firstBlockedT === null) firstBlockedT = (i - 1) / steps;
        lastBlockedT = t;
      }
      prevPt = pt;
    }
    if (firstBlockedT === null) { firstBlockedT = 0; lastBlockedT = 1; }

    const bufferT = Math.min(LONG_RANGE_BUFFER_NM / totalNm, 0.4);
    const startT = Math.max(0, firstBlockedT - bufferT);
    let endT = Math.min(1, lastBlockedT + bufferT);
    const spanNm = (endT - startT) * totalNm;
    if (spanNm > LONG_RANGE_NM - 1) endT = startT + (LONG_RANGE_NM - 1) / totalNm;

    const bracketStart = startT <= 0 ? cursor
      : { lat: cursor.lat + (b.lat - cursor.lat) * startT, lon: cursor.lon + (b.lon - cursor.lon) * startT };
    const bracketEnd = { lat: cursor.lat + (b.lat - cursor.lat) * endT, lon: cursor.lon + (b.lon - cursor.lon) * endT };

    if (startT > 0) result.push(bracketStart);
    const sub = autoRoute(allRings, chGraph, bracketStart, bracketEnd);
    totalExpansions += sub.expansions || 0;
    const patched = sub.path;
    if (process.env.DEBUG_LR) console.log(`    [debug] hop ${hop}: bracketStart=${JSON.stringify(bracketStart)} bracketEnd=${JSON.stringify(bracketEnd)} spanNm=${(endT-startT)*totalNm} patched=${patched.length}pts fallback=${sub.fallback}`);
    if (patched.length <= 2 && landBlocks(allRings, patched[0].lon, patched[0].lat, patched[1].lon, patched[1].lat)) {
      if (process.env.DEBUG_LR) console.log('    [debug] bracket still crosses land — bailing');
      return null;
    }
    for (const p of patched.slice(1)) result.push(p);

    cursor = bracketEnd;
    if (endT >= 1) return { path: result, expansions: totalExpansions };
  }
  if (process.env.DEBUG_LR) console.log('    [debug] hit LONG_RANGE_MAX_HOPS');
  return null;
}

function longRangeRoute(allRings, chGraph, start, end, lrT0) {
  if (isClearOffshoreLine(allRings, start, end)) {
    return { path: [start, end], fallback: false, expansions: 0, ms: Date.now() - lrT0 };
  }
  if (Date.now() - lrT0 > LONG_RANGE_DEADLINE_MS) {
    return { path: [start, end], fallback: true, expansions: 0, ms: Date.now() - lrT0 };
  }

  const departurePt = findClearOffshorePoint(allRings, start.lon, start.lat, end.lon, end.lat);
  const arrivalPt = findClearOffshorePoint(allRings, end.lon, end.lat, start.lon, start.lat);
  if (process.env.DEBUG_LR) console.log('  [debug] departurePt', departurePt, 'arrivalPt', arrivalPt);
  if (!departurePt || !arrivalPt) {
    return { path: [start, end], fallback: true, expansions: 0, ms: Date.now() - lrT0 };
  }
  if (Date.now() - lrT0 > LONG_RANGE_DEADLINE_MS) {
    return { path: [start, end], fallback: true, expansions: 0, ms: Date.now() - lrT0 };
  }

  const departSub = autoRoute(allRings, chGraph, start, departurePt);
  if (process.env.DEBUG_LR) console.log('  [debug] departSub', departSub.path.length, 'pts, fallback', departSub.fallback, 'ms', departSub.ms);
  if (departSub.path.length <= 2 && landBlocks(allRings, departSub.path[0].lon, departSub.path[0].lat, departSub.path[1].lon, departSub.path[1].lat)) {
    return { path: [start, end], fallback: true, expansions: departSub.expansions, ms: Date.now() - lrT0 };
  }
  if (Date.now() - lrT0 > LONG_RANGE_DEADLINE_MS) {
    return { path: [start, end], fallback: true, expansions: departSub.expansions, ms: Date.now() - lrT0 };
  }

  const transit = transitLeg(allRings, chGraph, departurePt, arrivalPt, lrT0);
  if (process.env.DEBUG_LR) console.log('  [debug] transit', transit ? `${transit.path.length}pts` : 'NULL (deadline or too many hops)', 'elapsed', Date.now() - lrT0);
  if (!transit) {
    return { path: [start, end], fallback: true, expansions: departSub.expansions, ms: Date.now() - lrT0 };
  }

  const arriveSub = autoRoute(allRings, chGraph, arrivalPt, end);
  if (process.env.DEBUG_LR) console.log('  [debug] arriveSub', arriveSub.path.length, 'pts, fallback', arriveSub.fallback, 'ms', arriveSub.ms);
  if (arriveSub.path.length <= 2 && landBlocks(allRings, arriveSub.path[0].lon, arriveSub.path[0].lat, arriveSub.path[1].lon, arriveSub.path[1].lat)) {
    return { path: [start, end], fallback: true, expansions: departSub.expansions + transit.expansions, ms: Date.now() - lrT0 };
  }
  if (Date.now() - lrT0 > LONG_RANGE_DEADLINE_MS) {
    return { path: [start, end], fallback: true, expansions: departSub.expansions + transit.expansions, ms: Date.now() - lrT0 };
  }

  const path = [...departSub.path];
  for (const p of transit.path.slice(1)) path.push(p);
  for (const p of arriveSub.path.slice(1)) path.push(p);

  let nm = 0;
  for (let i = 0; i < path.length - 1; i++) nm += distanceNm(path[i].lon, path[i].lat, path[i + 1].lon, path[i + 1].lat);

  return {
    path, fallback: false,
    expansions: (departSub.expansions || 0) + (transit.expansions || 0) + (arriveSub.expansions || 0),
    ms: Date.now() - lrT0, nm,
  };
}

// ── Hazard check (mirrors _checkRouteHazards, land-crossing only for this suite) ──

function pathCrossesLand(allRings, points) {
  for (let i = 0; i < points.length - 1; i++) {
    if (landBlocks(allRings, points[i].lon, points[i].lat, points[i + 1].lon, points[i + 1].lat)) return true;
  }
  return false;
}

// Concrete, checkable version of "stays off the coast" (Piece 1c) — not just
// "doesn't cross land". Only meaningful for a point actually offset off a
// land-ring vertex by _addRingNodes (a raw start/end or a channel-graph node
// can legitimately sit closer to shore, e.g. a pier or a charted channel).
function minDistToLandNm(allRings, lon, lat) {
  let best = Infinity;
  for (const r of allRings) {
    const ring = r.ring;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
      const d = ptSegDistNm(lon, lat, x1, y1, x2, y2);
      if (d < best) best = d;
    }
  }
  return best;
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

  // Case 6 — Piece 1c coastal standoff: Portsmouth -> York again, this time
  // asserting the path's intermediate (non-endpoint, non-channel-node) points
  // each keep a reasonable distance off land — the concrete, checkable
  // version of "stay off the coast" per the user's mariner framing ("100
  // yards is way too close, unless it's a properly marked channel"). Real
  // charted channel nodes (Piece 1a) are exempt — they follow a verified-safe
  // centerline directly, not this offset ladder. A small tolerance below the
  // ladder's 0.15nm floor allows for real chart curvature/rounding, not a
  // fixed exact bound.
  {
    const start = { lat: 43.08077, lon: -70.757141 };
    const end   = { lat: 43.129213, lon: -70.632961 };
    const { path, fallback } = autoRoute(allRings, chGraph, start, end);
    const crosses = pathCrossesLand(allRings, path);
    const chanKeySet = new Set(chGraph.nodes.keys());
    const isChannelPoint = p => chanKeySet.has(nodeKey(p.lon, p.lat));
    const STANDOFF_TOLERANCE_NM = 0.03;
    let worst = Infinity, worstPt = null;
    for (let i = 1; i < path.length - 1; i++) {
      const p = path[i];
      if (isChannelPoint(p)) continue;
      const d = minDistToLandNm(allRings, p.lon, p.lat);
      if (d < worst) { worst = d; worstPt = p; }
    }
    const standoffOk = worst === Infinity || worst >= (0.15 - STANDOFF_TOLERANCE_NM);
    const ok = !fallback && !crosses && standoffOk;
    console.log(`[6] Portsmouth pier -> York Harbor (coastal standoff): ${ok ? 'PASS' : 'FAIL'} (fallback=${fallback}, crossesLand=${crosses}, worst non-channel standoff=${worst === Infinity ? 'n/a' : worst.toFixed(3) + 'nm'}${worstPt ? ` at ${worstPt.lat.toFixed(5)},${worstPt.lon.toFixed(5)}` : ''})`);
    if (!ok) failures++;
  }

  // Case 7 — EXPERIMENTAL, not yet a committed regression case: a real
  // long-range coastal passage, Portsmouth NH pier all the way to Bar
  // Harbor ME (~136nm direct), the kind of leg Navionics' autorouting
  // reportedly handles in one shot. Stress-tests everything built this
  // session at once — the padded bbox now spans nearly the whole Maine
  // coast, so MANY more land rings are in play than any case above, and the
  // single 5000ms DEADLINE_MS budget has to cover all of it in one leg, not
  // a short local passage. Kept separate from the pass/fail-gated suite
  // above (doesn't add to `failures`) since this is a new finding to
  // report, not yet a certified regression target.
  {
    const start = { lat: 43.08077, lon: -70.757141 };   // Portsmouth NH pier
    const end   = { lat: 44.391934, lon: -68.205831 };  // Bar Harbor ME (named place)
    report('[7] EXPERIMENTAL: Portsmouth NH -> Bar Harbor ME (long-range)', allRings, chGraph, start, end);
  }

  // Case 8 — long-range fast path: two points >LONG_RANGE_NM apart, both
  // confirmed off any real land ring, direct line clear. Deterministic
  // (doesn't depend on fragile real-archipelago geometry the way case 7
  // does) — asserts the new decomposition branch's cheapest path (an
  // already-clear crossing needs no search at all) is actually taken:
  // should return in low milliseconds with just the 2 endpoints, not
  // seconds with intermediate points.
  {
    const start = { lat: 42.0, lon: -68.5 };
    const end   = { lat: 42.6, lon: -67.5 };
    const { path, fallback, ms } = autoRoute(allRings, chGraph, start, end);
    const crosses = pathCrossesLand(allRings, path);
    const ok = !fallback && !crosses && path.length === 2 && ms < 200;
    console.log(`[8] Long-range fast path (open Gulf of Maine, >20nm): ${ok ? 'PASS' : 'FAIL'} (fallback=${fallback}, crossesLand=${crosses}, ${path.length}pts, ${ms}ms)`);
    if (!ok) failures++;
  }

  // Case 9 — long-range bracket-and-patch: a single synthetic obstacle
  // placed in the middle of an otherwise-clear >60nm line. Deterministic
  // (synthetic ring only, not real chart data) proof that the hop-based
  // walk-forward patcher in transitLeg actually detours around a real
  // obstacle on a long crossing, rather than only ever taking the fast
  // path or falling back.
  {
    const outer = [[-69.76, 43.995], [-69.76, 44.005], [-69.74, 44.005], [-69.74, 43.995], [-69.76, 43.995]];
    const syntheticRing = {
      ring: outer, rMinX: -69.76, rMaxX: -69.74, rMinY: 43.995, rMaxY: 44.005, cx: -69.75, cy: 44.0,
      convex: computeConvex(outer),
    };
    const start = { lat: 44.0, lon: -70.5 };
    const end   = { lat: 44.0, lon: -69.0 };
    const emptyGraph = { nodes: new Map(), adjacency: new Map() };
    if (!report('[9] Long-range bracket-and-patch (synthetic mid-course obstacle)', [syntheticRing], emptyGraph, start, end)) failures++;
  }

  // Case 10 — the user-reported bug, isolated to the actual defect: North
  // Haven town dock (Fox Islands Thorofare, west mouth) out to the
  // thorofare's east mouth. The thorofare has NO charted FAIRWY polygon or
  // RECTRC track in NOAA's ENC data at all — it's marked purely by a chain
  // of 19 numbered lateral buoys — so before the buoy-chain channel-graph
  // source (build_channel_graph.py) this leg ran in a straight line,
  // directly over North Haven, ignoring the marked channel entirely. Real
  // chart data, real reported start coordinate.
  {
    const start = { lat: 44.122212, lon: -68.860267 };  // North Haven town dock
    const end   = { lat: 44.145, lon: -68.79 };          // east mouth of Fox Islands Thorofare
    if (!report('[10] Fox Islands Thorofare (buoy-chain channel)', allRings, chGraph, start, end)) failures++;
  }

  // Case 11 — EXPERIMENTAL, not yet a committed regression case: the user's
  // full originally-reported route, North Haven town dock all the way to
  // Stonington ME. Case 10 above confirms the channel-ignoring defect itself
  // is fixed; this leg continues on past the thorofare's east mouth into the
  // Merchant Row / Deer Island Thorofare island-dense archipelago near
  // Stonington, which hits the separate, already-diagnosed base-router gap
  // for island-dense local archipelagos (see the long-range-routing work).
  // Kept separate from the gated suite above for the same reason as case 7:
  // a new/known finding to report, not a regression this session claims to
  // have fixed.
  {
    const start = { lat: 44.122212, lon: -68.860267 };  // North Haven town dock
    const end   = { lat: 44.157672, lon: -68.666394 };  // Stonington approach
    report('[11] EXPERIMENTAL: North Haven -> Stonington (full route)', allRings, chGraph, start, end);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll cases passed.');
  process.exit(failures ? 1 : 0);
}

run();
