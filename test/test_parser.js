/**
 * Unit tests for the command parser.
 * Run with: node test/test_parser.js
 * (No test framework needed — pure Node.js)
 */

// Inline the parser logic since we can't use ES module imports in plain Node.js

const PLACE_ALIASES = {
  'carve our': 'carver',
  'carvers': 'carvers harbor',
  'final haven': 'vinalhaven',
  'vinyl haven': 'vinalhaven',
  'vinyl haven island': 'vinalhaven',
  'fox island': 'fox islands thorofare',
  'fox islands': 'fox islands thorofare',
  'thorofare': 'fox islands thorofare',
  'thorough fare': 'fox islands thorofare',
  'rockland': 'rockland harbor',
  'north haven': 'north haven island',
  'muscle ridge': 'muscle ridge channel',
};

function normalizePlaceName(raw) {
  let s = raw.toLowerCase()
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/harbour/g, 'harbor')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [alias, replacement] of Object.entries(PLACE_ALIASES)) {
    if (s.includes(alias)) s = s.replace(alias, replacement);
  }
  return s.trim();
}

function parseRadius(text) {
  const nm = text.match(/(\d+(?:\.\d+)?)\s*(?:nm|nautical\s*miles?)/i);
  if (nm) return parseFloat(nm[1]);
  const mi = text.match(/(\d+(?:\.\d+)?)\s*miles?/i);
  if (mi) return parseFloat(mi[1]);
  if (/quarter\s*mile|1\s*\/\s*4\s*mile/i.test(text)) return 0.25;
  if (/half\s*mile|1\s*\/\s*2\s*mile/i.test(text)) return 0.5;
  if (/one\s*mile/i.test(text)) return 1.0;
  if (/two\s*miles?/i.test(text)) return 2.0;
  return 0.25;
}

function navaidFilters(text) {
  const t = text.toLowerCase();
  const types = [];
  if (/buoy|marker|nun|can/.test(t)) types.push('buoy');
  if (/light/.test(t)) types.push('light');
  if (/beacon/.test(t)) types.push('beacon');
  return types.length ? types : null;
}

const PATTERNS = [
  { re: /\b(where am i|what'?s?\s+my\s+(position|location|coordinates?)|what\s+is\s+my\s+(position|location)|my\s+position)\b/i, intent: 'WHERE_AM_I', params: {} },
  { re: /\b(nearest|closest)\s+hazard\b/i, intent: 'NEAREST_HAZARD', params: {} },
  { re: /\b(any|are\s+there)\s+hazards?\s*(nearby|around|close|here)\b/i, intent: 'NEAREST_HAZARD', params: {} },
  { re: /hazards?.{0,30}(quarter|1\s*\/\s*4)\s*mile/i, intent: 'HAZARDS_IN_RADIUS', params: { radiusNm: 0.25 } },
  { re: /hazards?.{0,30}half\s*mile/i, intent: 'HAZARDS_IN_RADIUS', params: { radiusNm: 0.5 } },
  { re: /hazards?.{0,50}within\s+(.{1,30})/i, intent: 'HAZARDS_IN_RADIUS', extract: (m) => ({ radiusNm: parseRadius(m[1]) }) },
  { re: /\b(give\s+me|report|what\s+are|list)\b.{0,30}(bearing|hazard).{0,30}hazard/i, intent: 'HAZARDS_IN_RADIUS', params: { radiusNm: 0.25 } },
  { re: /\b(nearest|closest)\s+(buoy|beacon|light|marker|nun|can)\b/i, intent: 'NEAREST_NAVAID', params: {} },
  { re: /(buoys?\s+(?:and\s+)?lights?|lights?\s+(?:and\s+)?buoys?|buoys?|lights?|beacons?|navaids?).{0,30}(?:bearing\s+(?:at\s+)?|at\s+bearing\s+)(\d{1,3})(?:\s*°?(?:\s*degrees?)?)?.{0,10}(?:\+[-–]?|plus\s+or\s+minus|within)\s*(\d{1,3})/i, intent: 'NAVAIDS_ON_BEARING', extract: (m) => ({ filters: navaidFilters(m[1]), bearing: parseInt(m[2]), tolerance: parseInt(m[3]) }) },
  { re: /(buoys?\s+(?:and\s+)?lights?|lights?\s+(?:and\s+)?buoys?|buoys?|lights?|beacons?|navaids?).{0,30}(?:bearing\s+(?:at\s+)?|at\s+bearing\s+)(\d{1,3})(?:\s*°?(?:\s*degrees?)?)/i, intent: 'NAVAIDS_ON_BEARING', extract: (m) => ({ filters: navaidFilters(m[1]), bearing: parseInt(m[2]), tolerance: 10 }) },
  { re: /\b(range\s+and\s+bearing|bearing\s+and\s+range|bearing|distance|how\s+far|range)\b.{0,20}(to|of)\s+(.{3,60})$/i, intent: 'BEARING_TO_PLACE', extract: (m) => ({ placeName: m[3].trim() }) },
];

function parseCommand(transcript) {
  const t = transcript.trim();
  for (const pattern of PATTERNS) {
    const m = t.match(pattern.re);
    if (m) {
      const params = pattern.extract ? pattern.extract(m) : { ...pattern.params };
      if (params.placeName) params.placeName = normalizePlaceName(params.placeName);
      return { intent: pattern.intent, params };
    }
  }
  return { intent: 'UNKNOWN', params: { transcript: t } };
}

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function expect(description, actual, expectedIntent, expectedParams) {
  const result = parseCommand(actual);
  let ok = result.intent === expectedIntent;
  if (ok && expectedParams) {
    for (const [k, v] of Object.entries(expectedParams)) {
      if (result.params[k] !== v) { ok = false; break; }
    }
  }
  if (ok) {
    passed++;
    console.log(`  ✓ ${description}`);
  } else {
    failed++;
    console.error(`  ✗ ${description}`);
    console.error(`    input:    "${actual}"`);
    console.error(`    expected: ${expectedIntent} ${JSON.stringify(expectedParams || {})}`);
    console.error(`    got:      ${result.intent} ${JSON.stringify(result.params)}`);
  }
}

console.log('\nWHERE_AM_I');
expect('basic', 'where am i', 'WHERE_AM_I');
expect('what is my position', "what's my position", 'WHERE_AM_I');
expect('what is my location', 'what is my location', 'WHERE_AM_I');
expect('my position', 'my position', 'WHERE_AM_I');

console.log('\nNEAREST_HAZARD');
expect('nearest hazard', 'nearest hazard', 'NEAREST_HAZARD');
expect('closest hazard', 'closest hazard', 'NEAREST_HAZARD');
expect('any hazards nearby', 'any hazards nearby', 'NEAREST_HAZARD');
expect('are there hazards close', 'are there hazards close', 'NEAREST_HAZARD');

console.log('\nHAZARDS_IN_RADIUS');
expect('quarter mile explicit', 'hazards within quarter mile', 'HAZARDS_IN_RADIUS', { radiusNm: 0.25 });
expect('1/4 mile', 'hazards within 1/4 mile', 'HAZARDS_IN_RADIUS', { radiusNm: 0.25 });
expect('half mile', 'hazards within half mile', 'HAZARDS_IN_RADIUS', { radiusNm: 0.5 });
expect('0.5 nm', 'hazards within 0.5 nm', 'HAZARDS_IN_RADIUS', { radiusNm: 0.5 });
expect('1 nautical mile', 'hazards within 1 nautical mile', 'HAZARDS_IN_RADIUS', { radiusNm: 1 });
expect('give me bearing of hazards', 'give me bearing of any hazards', 'HAZARDS_IN_RADIUS');
// The two example queries from requirements
expect('req example 1', 'give me the bearing of any hazards to navigation within 1/4 mile of my current location', 'HAZARDS_IN_RADIUS', { radiusNm: 0.25 });

console.log('\nBEARING_TO_PLACE');
const q2 = parseCommand('give me the range and bearing to the mouth of Carver Harbor in the Fox Island Thorofare');
const correctIntent = q2.intent === 'BEARING_TO_PLACE';
const hasCarver = q2.params.placeName && q2.params.placeName.includes('carver');
if (correctIntent && hasCarver) { passed++; console.log('  ✓ req example 2 (range and bearing to place)'); }
else { failed++; console.error(`  ✗ req example 2: got ${q2.intent} / "${q2.params.placeName}"`); }

expect('bearing to carvers harbor', 'bearing to Carvers Harbor', 'BEARING_TO_PLACE');
expect('range and bearing to rockland', 'range and bearing to Rockland', 'BEARING_TO_PLACE');
expect('how far to vinalhaven', 'how far to Vinalhaven', 'BEARING_TO_PLACE');
expect('distance to fox islands thorofare', 'distance to Fox Islands Thorofare', 'BEARING_TO_PLACE');

console.log('\nNEAREST_NAVAID');
expect('nearest buoy', 'nearest buoy', 'NEAREST_NAVAID');
expect('closest light', 'closest light', 'NEAREST_NAVAID');
expect('nearest marker', 'nearest marker', 'NEAREST_NAVAID');

console.log('\nNAVAIDS_ON_BEARING');
{
  const r = parseCommand('name all buoys and lights bearing at 90 degrees +- 10 degrees');
  const ok = r.intent === 'NAVAIDS_ON_BEARING' && r.params.bearing === 90 && r.params.tolerance === 10
    && Array.isArray(r.params.filters) && r.params.filters.includes('buoy') && r.params.filters.includes('light');
  if (ok) { passed++; console.log('  ✓ buoys and lights bearing at 90 +- 10'); }
  else { failed++; console.error(`  ✗ buoys and lights bearing at 90 +- 10: got ${r.intent} ${JSON.stringify(r.params)}`); }
}
{
  const r = parseCommand('lights bearing 270 plus or minus 15');
  const ok = r.intent === 'NAVAIDS_ON_BEARING' && r.params.bearing === 270 && r.params.tolerance === 15
    && r.params.filters?.includes('light');
  if (ok) { passed++; console.log('  ✓ lights bearing 270 plus or minus 15'); }
  else { failed++; console.error(`  ✗ lights bearing 270 plus or minus 15: got ${r.intent} ${JSON.stringify(r.params)}`); }
}
{
  const r = parseCommand('buoys bearing at 45 degrees');
  const ok = r.intent === 'NAVAIDS_ON_BEARING' && r.params.bearing === 45 && r.params.tolerance === 10
    && r.params.filters?.includes('buoy');
  if (ok) { passed++; console.log('  ✓ buoys bearing at 45 degrees (default tolerance)'); }
  else { failed++; console.error(`  ✗ buoys bearing at 45 degrees: got ${r.intent} ${JSON.stringify(r.params)}`); }
}
{
  const r = parseCommand('navaids at bearing 180 within 20');
  const ok = r.intent === 'NAVAIDS_ON_BEARING' && r.params.bearing === 180 && r.params.tolerance === 20
    && r.params.filters === null;
  if (ok) { passed++; console.log('  ✓ navaids at bearing 180 within 20'); }
  else { failed++; console.error(`  ✗ navaids at bearing 180 within 20: got ${r.intent} ${JSON.stringify(r.params)}`); }
}

console.log('\nUNKNOWN fallback');
expect('garbage input', 'banana orange apple', 'UNKNOWN');
expect('empty-ish', 'um', 'UNKNOWN');

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
