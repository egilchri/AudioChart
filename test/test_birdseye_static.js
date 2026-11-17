// Bird's-eye footprint, static half (v1153): no module AudioChart's boaters load (Bird's-eye's bay3d.js and the helm
// view's helm3d.js, through their static imports) may statically import the armchair layer: aircraft, trains, the
// T's tunnels and stations, freeway traffic, airports. bay3d.js loads those with import() only where they're wanted
// (loadArmchair). The live half, what a browser actually fetches, is test/test_birdseye_footprint.mjs.
const fs = require('fs'), path = require('path');
const JS = path.join(__dirname, '..', 'www', 'js');
const ARMCHAIR = new Set(['aircraft3d', 'cockpit', 'flightroute', 'trains3d', 'track3d', 'subway3d', 'platform3d', 'traffic3d',
  'airport3d', 'mbta3d', 'caltrain3d', 'smart3d', 'amtrak3d', 'airliner3d', 'lightplane3d']);

// static imports only: `import ... from './x.js'` and `import './x.js'` (comments stripped first; import() is skipped)
function staticImports(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const out = [];
  for (const m of src.matchAll(/^\s*import\s+(?:[^'"()]*?\s+from\s+)?['"](\.\/[^'"]+\.js)['"]/gm)) out.push(path.join(path.dirname(file), m[1]));
  return out;
}
let fail = 0;
for (const entry of ['bay3d.js', 'helm3d.js']) {
  const seen = new Map(), stack = [[path.join(JS, entry), [entry]]];
  while (stack.length) {
    const [f, via] = stack.pop();
    if (seen.has(f) || !fs.existsSync(f)) continue;
    seen.set(f, via);
    for (const g of staticImports(f)) stack.push([g, [...via, path.basename(g)]]);
  }
  const bad = [...seen].filter(([f]) => ARMCHAIR.has(path.basename(f, '.js')));
  for (const [, via] of bad) { console.log(`FAIL ${entry} statically imports the armchair layer: ${via.join(' → ')}`); fail++; }
  if (!bad.length) console.log(`PASS ${entry}: ${seen.size} modules, none of the armchair layer`);
}
process.exit(fail ? 1 : 0);
