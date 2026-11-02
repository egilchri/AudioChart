import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9567); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 300)); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errs.push(JSON.stringify(d.params.args.map(a => a.description || a.value)).slice(0, 300)); });
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true }); await c.cmd('Network.setBypassServiceWorker', { bypass: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
for (let i = 0; i < 90; i++) { await sleep(1000); if (await c.ev(`__bay3d.rail.list().some(t => t.rail === 'Caltrain')`) === true) break; }
await sleep(3000);
const J = async x => JSON.parse(await c.ev(`JSON.stringify(${x})`)); const R = `document.querySelector('#scene canvas').getBoundingClientRect()`;
const t = (await J(`__bay3d.rail.list()`)).filter(t => t.rail === 'Caltrain' && t.lat < 37.72 && t.lat > 37.45).sort((a, b) => b.v - a.v)[0];
console.log('train', t.id, t.dest);
const settle = async () => { await sleep(2500); for (let w = 0; w < 40 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(1000); await sleep(800); };
await c.ev(`__bay3d.goWhole()`); await settle(); await c.shot('a_whole.png');
const here = async () => (await J(`__bay3d.rail.list()`)).find(x => x.id === t.id);
let me = await here(); await c.ev(`__bay3d.setView(${JSON.stringify({ lat: me.lat, lon: me.lon, dist: 5500, az: 30, tilt: 55 })})`); await settle(); await c.shot('a_mid.png');
me = await here(); await c.ev(`__bay3d.setView(${JSON.stringify({ lat: me.lat, lon: me.lon, dist: 1600, az: 30, tilt: 58 })})`); await settle();
for (let k = 0; k < 4; k++) { const s = (await J(`__bay3d.rail.list(__bay3d.camera, ${R})`)).find(x => x.id === t.id); await c.click(s.sx, s.sy); await sleep(500); if (await c.ev(`!document.getElementById('aisinfo').hidden`) === true) break; }
await c.ev(`document.getElementById('aisinfo').querySelector('.shrinker')?.click()`);   // (fold her card out of the picture)
for (const m of ['side', 'bow', 'drone', 'stern', 'helm']) {
  await c.ev(`[...document.querySelectorAll('#aisinfo .go button')].find(b => b.dataset.m === '${m}').click()`); await settle();
  await c.shot(`a_${m}.png`);
}
console.log('ERRORS', errs.slice(0, 5).join('\n'));
process.exit(0);
