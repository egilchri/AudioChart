/**
 * Unit tests for spatial query logic.
 * Run with: node test/test_query.js
 * Uses fixture GeoJSON files — no browser or server needed.
 */

const fs = require('fs');
const path = require('path');

// ── Inline query math (mirrors www/js/query.js) ──────────────────────────────

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

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarityScore(a, b) {
  if (b.includes(a) || a.includes(b)) return 1.0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length, 1);
}

// ── Load fixtures ─────────────────────────────────────────────────────────────

const FIXTURES = path.join(__dirname, 'fixtures');
const hazards = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'test_hazards.geojson')));
const places = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'test_places.geojson')));

// Test position: middle of Fox Islands Thorofare
const LAT = 44.14, LON = -68.855;

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function assert(desc, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${desc}`); }
  else { failed++; console.error(`  ✗ ${desc}${detail ? ': ' + detail : ''}`); }
}

// ── Distance & bearing math ───────────────────────────────────────────────────
console.log('\nDistance / bearing math');

// UWTROC at [-68.843, 44.145] — slightly NE of test position
const uwtroc = hazards.features[0];
const [ulon, ulat] = uwtroc.geometry.coordinates;
const d1 = distanceNm(LON, LAT, ulon, ulat);
const b1 = bearing(LON, LAT, ulon, ulat);
assert('UWTROC distance < 1nm', d1 < 1.0, `got ${d1.toFixed(3)}nm`);
assert('UWTROC distance > 0', d1 > 0, `got ${d1.toFixed(3)}nm`);
assert('UWTROC bearing roughly NE (0-90°)', b1 >= 0 && b1 <= 120, `got ${b1.toFixed(0)}°`);

// Carvers Harbor at [-68.833, 44.063] — south of test position
const carver = places.features[0];
const [clon, clat] = carver.geometry.coordinates;
const d2 = distanceNm(LON, LAT, clon, clat);
const b2 = bearing(LON, LAT, clon, clat);
assert('Carvers Harbor distance > 0.5nm', d2 > 0.5, `got ${d2.toFixed(2)}nm`);
assert('Carvers Harbor roughly south (135-225°)', b2 >= 120 && b2 <= 240, `got ${b2.toFixed(0)}°`);

// Rockland Harbor — west of Vinalhaven
const rockland = places.features[2];
const [rlon, rlat] = rockland.geometry.coordinates;
const b3 = bearing(LON, LAT, rlon, rlat);
assert('Rockland Harbor roughly west (240-330°)', b3 >= 240 && b3 <= 330, `got ${b3.toFixed(0)}°`);

// ── Radius query simulation ───────────────────────────────────────────────────
console.log('\nRadius query');

const RADIUS = 0.5;
const nearby = hazards.features.filter(f => {
  const [flon, flat] = f.geometry.coordinates;
  return distanceNm(LON, LAT, flon, flat) <= RADIUS;
});
assert('At least 1 hazard within 0.5nm', nearby.length >= 1, `found ${nearby.length}`);
assert('UWTROC found in 0.5nm radius', nearby.some(f => f.properties.objtype === 'UWTROC'));

const nearbyQuarter = hazards.features.filter(f => {
  const [flon, flat] = f.geometry.coordinates;
  return distanceNm(LON, LAT, flon, flat) <= 0.25;
});
// Distant obstruction at [-68.900, 44.200] should NOT be in quarter mile
const farObstrn = hazards.features.find(f => f.properties.objtype === 'OBSTRN');
const [flon, flat] = farObstrn.geometry.coordinates;
const farDist = distanceNm(LON, LAT, flon, flat);
assert('Far obstruction > 0.25nm from test position', farDist > 0.25, `got ${farDist.toFixed(3)}nm`);

// ── Fuzzy place name matching ──────────────────────────────────────────────────
console.log('\nFuzzy place matching');

function findPlace(query) {
  const q = query.toLowerCase();
  let best = null, bestScore = 0;
  for (const f of places.features) {
    const name = f.properties.name_lower || '';
    const score = similarityScore(q, name);
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return { best, bestScore };
}

const { best: carverResult, bestScore: carverScore } = findPlace('carvers harbor');
assert('Exact "carvers harbor" match', carverResult && carverResult.properties.name === 'Carvers Harbor', `got ${carverResult?.properties.name}`);
assert('Carvers Harbor score > 0.9', carverScore > 0.9, `got ${carverScore.toFixed(2)}`);

const { best: foxResult } = findPlace('fox islands thorofare');
assert('Fox Islands Thorofare exact match', foxResult && foxResult.properties.name === 'Fox Islands Thorofare');

const { best: fuzzyResult, bestScore: fuzzyScore } = findPlace('carve our harbor');
assert('Fuzzy "carve our harbor" finds carvers harbor', fuzzyResult && fuzzyResult.properties.name === 'Carvers Harbor', `got ${fuzzyResult?.properties.name}, score ${fuzzyScore.toFixed(2)}`);

const { best: vinalResult } = findPlace('vinalhaven');
assert('Vinalhaven found', vinalResult && vinalResult.properties.name === 'Vinalhaven');

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
