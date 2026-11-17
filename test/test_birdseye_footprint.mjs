// Bird's-eye footprint check (v1153): a boater's Bird's-eye in a Maine bay must not fetch the armchair layer
// (aircraft, trains, the T's tunnels and stations, freeway traffic, airports), and an armchair bay must still load it.
//
// Needs the repo served (python3 -m http.server 8838 from the repo root) and a Chrome with remote debugging:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9633 \
//     --user-data-dir=/tmp/footprint-prof about:blank
//   node test/test_birdseye_footprint.mjs [base=http://127.0.0.1:8838] [port=9633]
const base = process.argv[2] || 'http://127.0.0.1:8838', port = +(process.argv[3] || 9633);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ARMCHAIR = /\/js\/(aircraft3d|cockpit|flightroute|trains3d|track3d|subway3d|platform3d|traffic3d|airport3d|mbta3d|caltrain3d|smart3d|amtrak3d|airliner3d|lightplane3d)\.js|\/data\/(rail|roads|airports)\//;

const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}, urls = [], errs = [];
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; return; }
  if (d.method === 'Network.requestWillBeSent') urls.push(d.params.request.url);
  if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.split('\n')[0] || d.params.exceptionDetails.text);
};
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async x => (await cmd('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
await cmd('Network.enable'); await cmd('Runtime.enable'); await cmd('Page.enable');
await cmd('Network.setCacheDisabled', { cacheDisabled: true });

async function visit(region, wait = 12000) {
  urls.length = 0; errs.length = 0;
  await cmd('Page.navigate', { url: `${base}/www/bay3d.html?region=${region}` });
  await sleep(wait);
  return { armchair: urls.filter(u => ARMCHAIR.test(u)).map(u => u.replace(/^.*\/www\//, '')), errs: [...errs], ready: await ev('!!window.__bay3d') };
}

let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };
// a fresh boater: no planes-and-trains choice remembered, Live off
await cmd('Page.navigate', { url: `${base}/www/bay3d.html?region=penobscot-bay` }); await sleep(1500);
await ev(`(() => { try { localStorage.removeItem('audiochart-bay3d-planes-trains'); localStorage.removeItem('audiochart-bay3d-live'); } catch (_) {} return 1; })()`);
for (const r of ['penobscot-bay', 'casco-bay']) {
  const v = await visit(r);
  check(v.ready, `${r}: Bird's-eye up`);
  check(!v.armchair.length, `${r}: no armchair files fetched${v.armchair.length ? ': ' + v.armchair.join(', ') : ''}`);
  check(!v.errs.length, `${r}: no page errors${v.errs.length ? ': ' + v.errs.join(' | ') : ''}`);
}
const b = await visit('boston-harbor', 20000);
check(b.ready, 'boston-harbor: Bird\'s-eye up');
check(b.armchair.some(u => /trains3d/.test(u)) && b.armchair.some(u => /data\/rail\//.test(u)), 'boston-harbor: armchair layer loaded');
check(!b.errs.length, `boston-harbor: no page errors${b.errs.length ? ': ' + b.errs.join(' | ') : ''}`);
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
