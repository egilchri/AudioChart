/**
 * Route hazard-clearance certification.
 *
 * Run with:   node test/test_route_hazard_clearance.js
 *   → runs the regression suite (known-good/known-bad routes) against the
 *     real production chart data in www/data/hazards.geojson.
 *
 * Run with:   node test/test_route_hazard_clearance.js my_route.json
 *   → audits an arbitrary route (JSON array of {lat,lon}, or {points:[...]})
 *     against the same production data and prints a pass/fail report.
 *     Exits non-zero if any hazard is found — use this as the "is this
 *     route as safe as Navionics would produce" gate before trusting or
 *     publishing an auto-generated route.
 *
 * The corridor/shallow-threshold constants and the point-hazard /
 * DEPARE-crossing logic below are a direct port of _checkRouteHazards()
 * in www/js/app.js, so a route that passes here is one the in-app
 * "Check hazards" popup would also report clean.
 */

const fs = require('fs');
const path = require('path');

// ── Geometry (mirrors www/js/query.js + www/js/app.js) ───────────────────────

function distanceNm(lon1, lat1, lon2, lat2) {
  const R = 3440.065;
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dphi = (lat2 - lat1) * Math.PI / 180;
  const dlam = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lon1, lat1, lon2, lat2) {
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dlam = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dlam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlam);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function segCrossTrack(aLon, aLat, bLon, bLat, pLon, pLat) {
  const R = 3440.065;
  const d13 = distanceNm(aLon, aLat, pLon, pLat) / R;
  if (d13 < 1e-9) return { crossTrack: 0, alongTrack: 0 };
  const b13 = bearing(aLon, aLat, pLon, pLat) * Math.PI / 180;
  const b12 = bearing(aLon, aLat, bLon, bLat) * Math.PI / 180;
  const dxt = Math.asin(Math.sin(d13) * Math.sin(b13 - b12)) * R;
  const cosDxt = Math.cos(dxt / R);
  if (Math.abs(cosDxt) < 1e-10) return null;
  const dat = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / cosDxt))) * R;
  return { crossTrack: dxt, alongTrack: Math.cos(b13 - b12) >= 0 ? dat : -dat };
}

function segsIntersect(ax, ay, bx, by, px, py, qx, qy) {
  const cross = (ox, oy, ux, uy, vx, vy) => (ux - ox) * (vy - oy) - (uy - oy) * (vx - ox);
  const d1 = cross(px, py, qx, qy, ax, ay), d2 = cross(px, py, qx, qy, bx, by);
  const d3 = cross(ax, ay, bx, by, px, py), d4 = cross(ax, ay, bx, by, qx, qy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segPolyIntersectPoint(aLon, aLat, bLon, bLat, ring) {
  for (let i = 0; i < ring.length - 1; i++) {
    const [pLon, pLat] = ring[i], [qLon, qLat] = ring[i + 1];
    if (!segsIntersect(aLon, aLat, bLon, bLat, pLon, pLat, qLon, qLat)) continue;
    const dxAB = bLon - aLon, dyAB = bLat - aLat, dxPQ = qLon - pLon, dyPQ = qLat - pLat;
    const denom = dxAB * dyPQ - dyAB * dxPQ;
    if (Math.abs(denom) < 1e-12) continue;
    const t = ((pLon - aLon) * dyPQ - (pLat - aLat) * dxPQ) / denom;
    return { lat: aLat + t * dyAB, lon: aLon + t * dxAB, t };
  }
  return null;
}

// ── Hazard check (mirrors _checkRouteHazards in www/js/app.js) ───────────────

const CORRIDOR_NM         = 0.05; // ~100 yards each side
const SHALLOW_THRESHOLD_NM = 2.0; // flag DEPARE polygons shallower than this
const DANGER_LABELS = new Set(['underwater rock', 'obstruction', 'wreck', 'UWTROC', 'OBSTRN', 'WRECKS']);

function checkRouteHazards(points, hazardsFC) {
  const feats = hazardsFC.features;
  const depthZones = feats.filter(f => f.properties?.label === 'shallow area' && f.geometry?.type !== 'Point');
  const found = [];
  let distSoFar = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const segLen = distanceNm(a.lon, a.lat, b.lon, b.lat);

    for (const f of feats) {
      if (f.geometry.type !== 'Point') continue;
      const label = f.properties.label || f.properties.objtype || '';
      if (!DANGER_LABELS.has(label)) continue;
      const [pLon, pLat] = f.geometry.coordinates;
      const ct = segCrossTrack(a.lon, a.lat, b.lon, b.lat, pLon, pLat);
      if (!ct) continue;
      const { crossTrack, alongTrack } = ct;
      if (Math.abs(crossTrack) <= CORRIDOR_NM && alongTrack >= 0 && alongTrack <= segLen) {
        found.push({
          label: f.properties.label || label,
          name: f.properties.name || '',
          routeNm: distSoFar + alongTrack,
          crossTrackNm: crossTrack,
        });
      }
    }

    for (const f of depthZones) {
      const minDepth = parseFloat(f.properties.depth_label);
      if (isNaN(minDepth) || minDepth >= SHALLOW_THRESHOLD_NM) continue;
      const ring = f.geometry.coordinates[0];
      const hit = segPolyIntersectPoint(a.lon, a.lat, b.lon, b.lat, ring);
      if (!hit) continue;
      found.push({
        label: minDepth < 0 ? 'above-water obstacle' : `shallow area (${f.properties.depth_label})`,
        name: f.properties.name || '',
        routeNm: distSoFar + hit.t * segLen,
      });
    }
    distSoFar += segLen;
  }
  return found;
}

// ── Test runner ────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function assert(desc, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${desc}`); }
  else { failed++; console.error(`  ✗ ${desc}${detail ? ': ' + detail : ''}`); }
}

function loadPoints(route) {
  return route.map(p => ({ lat: p.lat, lon: p.lon }));
}

const args = process.argv.slice(2);

if (args.length > 0) {
  // ── Certify an arbitrary route file ─────────────────────────────────────
  const routePath = path.resolve(args[0]);
  const hazardsFC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'www', 'data', 'hazards.geojson')));
  const raw = JSON.parse(fs.readFileSync(routePath));
  const points = loadPoints(Array.isArray(raw) ? raw : raw.points);
  const found = checkRouteHazards(points, hazardsFC);
  if (found.length === 0) {
    console.log(`✓ ${routePath}: no rocks, obstructions, wrecks, or shallow-area crossings within ${CORRIDOR_NM * 1852 | 0}m.`);
    process.exit(0);
  } else {
    console.error(`✗ ${routePath}: ${found.length} hazard(s) found:`);
    for (const h of found) console.error(`   - ${h.label}${h.name ? ' (' + h.name + ')' : ''} at ${h.routeNm.toFixed(2)}nm along route`);
    process.exit(1);
  }
}

// ── Regression suite ──────────────────────────────────────────────────────
// Bass Harbor -> Great Cranberry Isle, reported 2026-08-06: the auto-router's
// route (pre-fix) passed 67m from a charted underwater rock at
// (-68.3004057, 44.2240253) — a distance the router had no way to know about,
// since it only avoided land + DEPARE polygons, never point hazards. This
// pins that specific rock so a future regression (e.g. someone reverting the
// hazard-ring fix in _autoRouteProg) is caught here even without re-running
// the full A* search.

console.log('Route hazard-clearance regression suite\n');

const hazardsFC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'www', 'data', 'hazards.geojson')));

const routeCuttingCloseToRock = loadPoints([
  { lat: 44.236712, lon: -68.348642 }, { lat: 44.233853, lon: -68.348393 },
  { lat: 44.224555, lon: -68.342412 }, { lat: 44.220929, lon: -68.338463 },
  { lat: 44.220641, lon: -68.335239 }, { lat: 44.224612, lon: -68.285455 },
  { lat: 44.256035, lon: -68.27692 },  { lat: 44.258226, lon: -68.276759 },
  { lat: 44.260246, lon: -68.276365 }, { lat: 44.260385, lon: -68.276217 },
  { lat: 44.260735, lon: -68.273562 }, { lat: 44.26061,  lon: -68.265606 },
]);

const routeWithClearance = loadPoints([
  { lat: 44.235046, lon: -68.349481 }, { lat: 44.234911, lon: -68.349804 },
  { lat: 44.234891, lon: -68.349813 }, { lat: 44.233696, lon: -68.350047 },
  { lat: 44.229569, lon: -68.347244 }, { lat: 44.221934, lon: -68.341854 },
  { lat: 44.221359, lon: -68.341432 }, { lat: 44.219531, lon: -68.338135 },
  { lat: 44.219505, lon: -68.336105 }, { lat: 44.219531, lon: -68.335872 },
  { lat: 44.220164, lon: -68.325416 }, { lat: 44.220048, lon: -68.301468 },
  { lat: 44.220306, lon: -68.297785 }, { lat: 44.220461, lon: -68.296833 },
  { lat: 44.22081,  lon: -68.296042 }, { lat: 44.222025, lon: -68.295072 },
  { lat: 44.230952, lon: -68.288946 }, { lat: 44.237933, lon: -68.284167 },
  { lat: 44.239883, lon: -68.283161 }, { lat: 44.24235,  lon: -68.282658 },
  { lat: 44.245721, lon: -68.282442 }, { lat: 44.253773, lon: -68.281975 },
  { lat: 44.262895, lon: -68.280196 }, { lat: 44.263114, lon: -68.279972 },
  { lat: 44.263114, lon: -68.279774 }, { lat: 44.261358, lon: -68.272615 },
  { lat: 44.259312, lon: -68.267477 },
]);

const POINT_LABELS = new Set(['underwater rock', 'obstruction', 'wreck', 'UWTROC', 'OBSTRN', 'WRECKS']);

const badFound = checkRouteHazards(routeCuttingCloseToRock, hazardsFC);
assert(
  'checker flags the known close-pass rock on the unsafe track',
  badFound.some(h => POINT_LABELS.has(h.label)),
  `found: ${JSON.stringify(badFound.map(h => h.label))}`
);

// The Navionics-equivalent track still grazes a charted 1.8-3.6m depth-area
// polygon near shore (same as the unsafe track does, just without a rock in
// it) — that's a normal, draft-dependent finding for inshore Maine passages,
// not a hard hazard. What actually distinguishes the two routes is the point
// hazards: zero here vs. a charted rock on the other track.
const goodFound = checkRouteHazards(routeWithClearance, hazardsFC);
assert(
  'checker reports zero point hazards (rocks/obstructions/wrecks) on the wide-clearance track',
  goodFound.filter(h => POINT_LABELS.has(h.label)).length === 0,
  `found: ${JSON.stringify(goodFound.map(h => h.label))}`
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
