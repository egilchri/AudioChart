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

// Mirrors www/js/query.js's real similarityScore exactly (not the looser
// "any containment = 1.0" approximation this file used before) — the
// Hurricane Island regression below depends on the partial-containment
// scoring (0.7 + 0.3*ratio) actually producing two close-but-not-identical
// scores for "hurricane island" against two differently-qualified real
// names, which a flat 1.0-for-any-containment score can't reproduce.
function similarityScore(a, b) {
  if (a === b) return 1.0;
  if (b.includes(a)) return 0.7 + 0.3 * (a.length / b.length);
  if (a.includes(b)) return 0.7 + 0.3 * (b.length / a.length);
  const dist = levenshtein(a, b);
  const lev = 1 - dist / Math.max(a.length, b.length, 1);
  return Math.min(lev, 0.69);
}

// Mirrors www/js/query.js's LABEL_RANK + findAmbiguousCandidates — same
// formula (base + rank*0.1), same "within 0.05 of the top score counts as
// tied" rule. Kept alongside findPlace's own mirror above rather than
// importing query.js directly, matching this file's existing no-browser,
// fixture-only convention (see the file header).
const LABEL_RANK = { town: 3, harbour: 3, 'coastal feature': 2, 'sea area': 0 };
const AMBIGUOUS_SCORE_MARGIN = 0.05;
function findAmbiguousCandidates(query) {
  const q = query.toLowerCase();
  const scored = [];
  for (const f of places.features) {
    const name = f.properties.name_lower || '';
    const base = similarityScore(q, name);
    if (base < 0.3) continue;
    const rank = LABEL_RANK[f.properties.label] ?? 1;
    const score = base >= 0.99 ? 1 : base + rank * 0.1;
    scored.push({ score, f });
  }
  if (scored.length <= 1) return null;
  const topScore = Math.max(...scored.map(s => s.score));
  const tied = scored.filter(s => s.score >= topScore - AMBIGUOUS_SCORE_MARGIN);
  return tied.length > 1 ? tied.map(t => t.f) : null;
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

// ── Hurricane Island: real name-collision regression ────────────────────────────
// Maine has two real, unrelated islands both named "Hurricane Island" — one off
// Spruce Head/Muscle Ridge, one off Vinalhaven — confirmed live when an autoroute
// to "Hurricane Island" silently landed on the wrong one. The actual production
// bug turned out to be stale offline cache data (a separate, non-unit-testable
// deployment/sync issue — see git history), but the matching logic itself must
// keep flagging this as a real ambiguity rather than silently picking one, or a
// future data or scoring change could reintroduce the silent-wrong-answer failure
// mode even with fully fresh data.
console.log('\nHurricane Island name-collision regression');

const hurricaneCandidates = findAmbiguousCandidates('Hurricane Island');
assert('"Hurricane Island" is flagged ambiguous', !!hurricaneCandidates, 'findAmbiguousCandidates returned null — a real duplicate silently went undetected');
if (hurricaneCandidates) {
  const names = hurricaneCandidates.map(f => f.properties.name).sort();
  assert(
    'Both real Hurricane Islands are offered as candidates',
    names.includes('Hurricane Island (Spruce Head)') && names.includes('Hurricane Island (Vinalhaven)'),
    `got [${names.join(', ')}]`
  );
}

// A single-word query with no real collision must NOT be flagged ambiguous —
// the point of this check is catching genuine duplicates, not making every
// query interactive.
const carverAmbiguous = findAmbiguousCandidates('carvers harbor');
assert('"carvers harbor" is NOT flagged ambiguous (no real collision)', carverAmbiguous === null, `got ${JSON.stringify(carverAmbiguous?.map(f => f.properties.name))}`);

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
