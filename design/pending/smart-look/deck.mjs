// node deck.mjs: the drawn track's height along the Benicia–Martinez rail bridge, and a look at it
import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9567);
await c.cmd('Network.enable'); await c.cmd('Network.setBypassServiceWorker', { bypass: true }); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.tracks?.()`) === true) break; }
await c.ev(`__bay3d.setView({ lat: 38.0425, lon: -122.1215, dist: 260, az: 70, tilt: 74 })`);
await sleep(3000); for (let w = 0; w < 90 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(1000); await sleep(1500);
console.log(await c.ev(`(async () => { const { wx, wz } = await import('./js/terrain3d.js'); const t = __bay3d.tracks(), o = []; for (let f = 0; f <= 1.0001; f += 0.1) { const lat = 38.039044 + (38.048171 - 38.039044) * f, lon = -122.121109 + (-122.128134 + 122.121109) * f; o.push(lat.toFixed(4) + ':' + (t.yAt(wx(lon), wz(lat), 30)?.toFixed(1))); } return o.join(' '); })()`));
await c.shot('deck_close.png');
await c.ev(`__bay3d.setView({ lat: 38.0405, lon: -122.1195, dist: 1100, az: 100, tilt: 64 })`); await sleep(4000); await c.shot('deck_wide.png');
process.exit(0);
