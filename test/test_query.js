/**
 * Unit tests for spatial query logic (distance/bearing math, radius
 * filtering, fuzzy place-name matching, ambiguous-name disambiguation).
 *
 * Run with: node test/test_query.js
 *   → calls the REAL www/js/query.js against real production chart data
 *     (www/data/), via the Node shims in test/helpers/node_query_env.js —
 *     same pattern test_channel_routing.js already established.
 *
 * Until 2026-09 this suite ran entirely against a hand-maintained port of
 * query.js's distance/bearing math, similarityScore, and
 * findAmbiguousCandidates, backed by small synthetic fixture GeoJSON files.
 * That port had its own copy of the scoring logic with NO LABEL_RANK
 * weighting in its local findPlace() helper — so it could never have
 * caught the real, live bug this file's rewrite was prompted by: an exact
 * query like "Carver's Harbor" (apostrophe) or a fuzzy one like "carve our
 * harbor" landing on "Carvers Corner" (an unrelated place ~30nm away, near
 * Lincolnville) instead of the real Carvers Harbor on Vinalhaven, because
 * Carvers Harbor is chart-labeled "sea area" (LABEL_RANK 0) while Carvers
 * Corner is labeled "town" (LABEL_RANK 3). Rewritten to call the real
 * functions directly so this class of bug can't hide behind a port again.
 */
const { installNodeQueryEnv } = require('./helpers/node_query_env.js');
const path = require('path');

const WWW_DATA_DIR = path.join(__dirname, '..', 'www', 'data');
installNodeQueryEnv(WWW_DATA_DIR);

async function waitForDataReady(Query, timeoutMs = 8000) {
  await Query.whenLandLoaded();
  const t0 = Date.now();
  while ((Query.hazards === null || Query.namedPlaces === null) && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

let passed = 0, failed = 0;

function assert(desc, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${desc}`); }
  else { failed++; console.error(`  ✗ ${desc}${detail ? ': ' + detail : ''}`); }
}

async function main() {
  const Query = await import('../www/js/query.js');

  // Seed the load with Rockland Harbor, then resolve the real test position
  // (Fox Islands Thorofare) once named-place data is actually available —
  // findPlaceByName needs loaded data before it can resolve anything.
  await Query.loadData(44.103, -69.088);
  await waitForDataReady(Query);

  const foxThorofare = Query.findPlaceByName('fox islands thorofare');
  const LAT = foxThorofare.lat, LON = foxThorofare.lon;

  // ── Distance & bearing math ─────────────────────────────────────────────
  console.log('\nDistance / bearing math');

  // A real charted underwater rock near Fox Islands Thorofare.
  const uwtrocLon = -68.8188569, uwtrocLat = 44.1224325;
  const d1 = Query.distanceNm(LON, LAT, uwtrocLon, uwtrocLat);
  const b1 = Query.bearing(LON, LAT, uwtrocLon, uwtrocLat);
  assert('Real UWTROC near Fox Islands Thorofare is < 1nm away', d1 < 1.0, `got ${d1.toFixed(3)}nm`);
  assert('...and roughly SW of it (180-270°)', b1 >= 180 && b1 <= 270, `got ${b1.toFixed(0)}°`);

  // Carvers Harbor, on Vinalhaven, relative to Rockland Harbor — ties
  // directly into today's bug: confirms the real distance/bearing math
  // agrees Carvers Harbor sits close to Vinalhaven's own named point,
  // roughly ESE of Rockland (not ~30nm north near Lincolnville).
  const rockland = Query.findPlaceByName('rockland harbor');
  const carversHarbor = Query.findPlaceByName('carvers harbor');
  const vinalhaven = Query.findPlaceByName('vinalhaven');
  assert('Rockland Harbor resolves', !!rockland, 'findPlaceByName returned null');
  assert('Carvers Harbor resolves', !!carversHarbor, 'findPlaceByName returned null');
  assert('Vinalhaven resolves', !!vinalhaven, 'findPlaceByName returned null');
  if (rockland && carversHarbor && vinalhaven) {
    const dCarver = Query.distanceNm(rockland.lon, rockland.lat, carversHarbor.lon, carversHarbor.lat);
    const bCarver = Query.bearing(rockland.lon, rockland.lat, carversHarbor.lon, carversHarbor.lat);
    assert('Carvers Harbor is roughly 9-13nm from Rockland Harbor', dCarver > 9 && dCarver < 13, `got ${dCarver.toFixed(2)}nm`);
    assert('...roughly ESE of Rockland (60-150°)', bCarver >= 60 && bCarver <= 150, `got ${bCarver.toFixed(0)}°`);
    const carverToVinal = Query.distanceNm(carversHarbor.lon, carversHarbor.lat, vinalhaven.lon, vinalhaven.lat);
    assert('Carvers Harbor is close to Vinalhaven\'s own named point (< 3nm)', carverToVinal < 3, `got ${carverToVinal.toFixed(2)}nm`);
  }

  // ── Radius query ─────────────────────────────────────────────────────────
  console.log('\nRadius query');

  const RADIUS = 0.5;
  const nearby = Query.hazards.features.filter((f) => {
    const [flon, flat] = f.geometry.coordinates;
    return Query.distanceNm(LON, LAT, flon, flat) <= RADIUS;
  });
  assert('At least 1 real hazard within 0.5nm of Fox Islands Thorofare', nearby.length >= 1, `found ${nearby.length}`);
  assert('The nearby UWTROC above is included in that 0.5nm set', nearby.some((f) => {
    const [flon, flat] = f.geometry.coordinates;
    return Math.abs(flon - uwtrocLon) < 1e-6 && Math.abs(flat - uwtrocLat) < 1e-6;
  }));

  // That same UWTROC (~0.4nm away, asserted above) must NOT be within a
  // tighter quarter-mile radius — verifies the filter boundary itself,
  // not just "something nearby exists."
  const withinQuarter = Query.hazards.features.filter((f) => {
    const [flon, flat] = f.geometry.coordinates;
    return Query.distanceNm(LON, LAT, flon, flat) <= 0.25;
  });
  assert('The ~0.4nm UWTROC is correctly excluded from a 0.25nm radius', d1 > 0.25, `got ${d1.toFixed(3)}nm`);
  assert('...and indeed does not appear in the 0.25nm result set', !withinQuarter.some((f) => {
    const [flon, flat] = f.geometry.coordinates;
    return Math.abs(flon - uwtrocLon) < 1e-6 && Math.abs(flat - uwtrocLat) < 1e-6;
  }));

  // ── Fuzzy place name matching (real Query.findPlaceByName) ──────────────
  console.log('\nFuzzy place matching');

  assert('Exact "carvers harbor" match', carversHarbor && carversHarbor.name === 'Carvers Harbor', `got ${carversHarbor?.name}`);

  const foxResult = Query.findPlaceByName('fox islands thorofare');
  assert('Fox Islands Thorofare exact match', foxResult && foxResult.name === 'Fox Islands Thorofare');

  const vinalResult = Query.findPlaceByName('vinalhaven');
  assert('Vinalhaven found', vinalResult && vinalResult.name === 'Vinalhaven');

  // Regression for a real bug found live: a fuzzy (non-exact) query with no
  // exact-match fast path used to run into the LABEL_RANK issue described
  // in this file's own header — "carve our harbor" scored against BOTH
  // Carvers Harbor (sea area, rank 0) and Carvers Corner (town, rank 3, but
  // a much worse text match) via the old flat base+rank*0.1 formula, and
  // the rank gap won regardless of how much better Carvers Harbor's actual
  // text match was. Fixed by only letting rank break ties among candidates
  // whose base text score is already close to the best one seen
  // (RANK_TIEBREAK_MARGIN in query.js) — see findPlaceByName's own comment.
  const fuzzyResult = Query.findPlaceByName('carve our harbor');
  assert('Fuzzy "carve our harbor" finds Carvers Harbor', fuzzyResult && fuzzyResult.name === 'Carvers Harbor', `got ${fuzzyResult?.name}`);

  // ── Hurricane Island: real name-collision regression ────────────────────
  // Maine has multiple real, unrelated islands named "Hurricane Island" —
  // off Spruce Head/Muscle Ridge, and off Vinalhaven — confirmed live when
  // an autoroute to "Hurricane Island" silently landed on the wrong one.
  // The matching logic must keep flagging this as a real ambiguity rather
  // than silently picking one.
  console.log('\nHurricane Island name-collision regression');

  const hurricaneCandidates = Query.findAmbiguousCandidates('Hurricane Island');
  assert('"Hurricane Island" is flagged ambiguous', !!hurricaneCandidates, 'findAmbiguousCandidates returned null — a real duplicate silently went undetected');
  if (hurricaneCandidates) {
    const names = hurricaneCandidates.map((c) => c.name).sort();
    assert(
      'Both real Hurricane Islands are offered as candidates',
      names.includes('Hurricane Island (Spruce Head)') && names.includes('Hurricane Island (Vinalhaven)'),
      `got [${names.join(', ')}]`
    );
  }

  // ── Apostrophe normalization + exact-match-not-diluted regression (v623) ─
  // The actual bug reported live: AutoRoute to "Carver's Harbor" (as
  // written in the route name/UI) landed near Lincolnville instead of
  // Vinalhaven. Root cause was two-fold — see this file's header comment —
  // and both parts get their own regression guard here.
  console.log('\nApostrophe normalization + exact-match disambiguation (v623)');

  for (const q of ["carver's harbor", 'Carver’s Harbor', 'carvers harbor']) {
    const r = Query.findPlaceByName(q);
    assert(`"${q}" resolves to the real Carvers Harbor on Vinalhaven`, r && r.name === 'Carvers Harbor', `got ${r?.name}`);
    const amb = Query.findAmbiguousCandidates(q);
    assert(`"${q}" is NOT flagged ambiguous (a decisive exact match, not a real collision)`, amb === null, `got ${JSON.stringify(amb?.map((c) => c.name))}`);
  }

  // Same normalization must not break a genuine, unrelated apostrophe'd
  // place name — confirms this is a general fix, not special-cased.
  const swans = Query.findPlaceByName("swan's island");
  assert('"swan\'s island" resolves to the real Swans Island', swans && swans.name === 'Swans Island', `got ${swans?.name}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
