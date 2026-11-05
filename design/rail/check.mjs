// node check.mjs: SF with Live on; every train's heading, and a look at those at 4th & King (Side view and from above)
import { connect, sleep } from '../pending/live-tour/cdp.mjs';
const c = await connect(9611); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 300)); if (d.method === 'Runtime.consoleAPICalled' && /warn|error/.test(d.params.type)) errs.push(JSON.stringify(d.params.args.map(a => a.description || a.value)).slice(0, 200)); });
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true }); await c.cmd('Network.setBypassServiceWorker', { bypass: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8811/www/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`__bay3d?.rail?.count > 2`) === true) break; }
await sleep(4000);
const J = async x => JSON.parse(await c.ev(`JSON.stringify(${x})`));
const L = await J(`__bay3d.rail.list()`);
for (const t of L) console.log(t.rail, t.trip, t.dest, 'v', t.v, 'h', t.h, t.lat.toFixed(4), t.lon.toFixed(4), Math.hypot(t.lat - 37.7765, (t.lon + 122.3945) * 0.79) < 0.004 ? '← 4th & King' : '');
const settle = async () => { await sleep(2500); for (let w = 0; w < 30 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(1000); await sleep(800); };
await c.ev(`__bay3d.setView({ lat: 37.7762, lon: -122.3935, dist: 700, az: 135, tilt: 55 })`); await settle(); await c.shot('kingst_above.png');
const k = L.find(t => Math.hypot(t.lat - 37.7765, (t.lon + 122.3945) * 0.79) < 0.004);
if (k) { await c.ev(`__bay3d.ride(__bay3d.rail.items().find(p => p.id === ${JSON.stringify(k.id)}), 'drone')`); await settle(); await c.shot('kingst_drone.png'); }
console.log('ERRORS', errs.slice(0, 6).join('\n')); process.exit(0);
