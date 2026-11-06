// node region.mjs <tag>: the SF region's whole view, then the Delta, Sacramento and Santa Rosa from above
import { connect, sleep } from '../live-tour/cdp.mjs';
const tag = process.argv[2] || 'g', c = await connect(9567); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 400)); if (d.method === 'Runtime.consoleAPICalled' && /warn|error/.test(d.params.type)) errs.push(JSON.stringify(d.params.args.map(a => a.description || a.value)).slice(0, 300)); });
await c.cmd('Network.enable'); await c.cmd('Network.setBypassServiceWorker', { bypass: true }); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay' });
for (let i = 0; i < 120; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
await sleep(60000);
await c.ev(`__bay3d.goWhole()`); await sleep(8000); await c.shot(`${tag}_whole.png`);
for (const [n, v] of [['sj', { lat: 37.33, lon: -121.9, dist: 9000, az: 0, tilt: 50 }]]) {
  await c.ev(`__bay3d.setView(${JSON.stringify(v)})`); await sleep(5000);
  for (let w = 0; w < 120 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(1000);
  await sleep(2000); await c.shot(`${tag}_${n}.png`);
}
console.log('ERRORS', errs.slice(0, 10).join('\n')); process.exit(0);
