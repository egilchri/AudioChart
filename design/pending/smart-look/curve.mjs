// node curve.mjs: each train's cars' headings (do they differ on a curve?), and a top view of the most curved one
import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9567);
await c.cmd('Network.enable'); await c.cmd('Network.setBypassServiceWorker', { bypass: true }); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`__bay3d.rail.list().length > 10`) === true) break; }
const J = async x => JSON.parse(await c.ev(`JSON.stringify(${x})`));
const res = [];
for (const t of await J(`__bay3d.rail.list()`)) {
  await c.ev(`__bay3d.setView({ lat: ${t.lat}, lon: ${t.lon}, dist: 300, az: 0, tilt: 85 })`); await sleep(1500);
  const r = await J(`(() => { const p = __bay3d.rail.items().find(p => p.id === ${JSON.stringify(t.id)}); return p && { art: p.artd, hs: p.cars.map(c => Math.round(-c.rotation.y * 180 / Math.PI)) }; })()`);
  if (r) { const sp = Math.max(...r.hs) - Math.min(...r.hs); res.push([sp, t.id, t.lat, t.lon, r.art, r.hs.join(' ')]); }
}
res.sort((a, b) => b[0] - a[0]); for (const r of res.slice(0, 8)) console.log(r.join('  '));
const [, id, lat, lon] = res[0];
await c.ev(`__bay3d.setView({ lat: ${lat}, lon: ${lon}, dist: 380, az: 0, tilt: 88 })`);
await sleep(3000); for (let w = 0; w < 60 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(1000); await sleep(1000);
const q = await J(`__bay3d.rail.list()`); const u = q.find(x => x.id === id); await c.ev(`__bay3d.setView({ lat: ${u.lat}, lon: ${u.lon}, dist: 380, az: 0, tilt: 88 })`); await sleep(1500);
await c.shot('curve_top.png'); console.log('shot', id);
process.exit(0);
