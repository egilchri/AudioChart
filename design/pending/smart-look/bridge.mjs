// node bridge.mjs: wait for an Amtrak train on the Benicia–Martinez rail bridge, then shoot it (Chrome :9567, www :8793)
import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9567);
await c.cmd('Network.enable'); await c.cmd('Network.setBypassServiceWorker', { bypass: true }); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
const J = async x => JSON.parse(await c.ev(`JSON.stringify(${x})`));
const settle = async () => { await sleep(2500); for (let w = 0; w < 90 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(1000); await sleep(1000); };
const B = [38.0436, -122.1246];
await c.ev(`__bay3d.setView(${JSON.stringify({ lat: B[0], lon: B[1], dist: 1400, az: 100, tilt: 62 })})`); await settle();
await c.shot('bn_empty.png');
const on = t => t.lat > 38.036 && t.lat < 38.050 && t.lon > -122.130 && t.lon < -122.119;
for (let i = 0; i < 3600; i++) {
  const ts = (await J(`__bay3d.rail.list()`)).filter(t => t.rail === 'Amtrak');
  const t = ts.find(on);
  if (i % 60 === 0) console.log(new Date().toLocaleTimeString(), ts.map(t => `${t.id} ${t.lat.toFixed(3)},${t.lon.toFixed(3)}`).join(' | '));
  if (t) {
    console.log('ON BRIDGE', t.id, t.dest, t.lat, t.lon);
    await c.ev(`__bay3d.setView(${JSON.stringify({ lat: t.lat, lon: t.lon, dist: 900, az: 100, tilt: 64 })})`); await sleep(2500); await c.shot('bn_wide.png');
    const u = (await J(`__bay3d.rail.list()`)).find(x => x.id === t.id);
    await c.ev(`__bay3d.setView(${JSON.stringify({ lat: u.lat, lon: u.lon, dist: 320, az: 70, tilt: 74 })})`); await sleep(2500); await c.shot('bn_close.png');
    await c.ev(`__bay3d.trainCard(${JSON.stringify(t.id)})`); await sleep(800);
    await c.ev(`[...document.querySelectorAll('#aisinfo .go button')].find(b => b.dataset.m === 'side')?.click()`); await sleep(3000); await c.shot('bn_side.png');
    process.exit(0);
  }
  await sleep(1000);
}
console.log('no train'); process.exit(1);
