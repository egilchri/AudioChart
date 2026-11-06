// node ride.mjs <tag> [view]: ride a live SMART train in Bird's-eye (Chrome :9567, www on :8793), shoot each view
import { connect, sleep } from '../live-tour/cdp.mjs';
const tag = process.argv[2] || 'x', views = (process.argv[3] || 'side').split(','), c = await connect(9567); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 300)); if (d.method === 'Runtime.consoleAPICalled' && /warn|error/.test(d.params.type)) errs.push(JSON.stringify(d.params.args.map(a => a.description || a.value)).slice(0, 300)); });
await c.cmd('Network.enable'); await c.cmd('Network.setBypassServiceWorker', { bypass: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
for (let i = 0; i < 90; i++) { await sleep(1000); if (await c.ev(`__bay3d.rail.list().some(t => t.rail === 'SMART')`) === true) break; }
const J = async x => JSON.parse(await c.ev(`JSON.stringify(${x})`)); const R = `document.querySelector('#scene canvas').getBoundingClientRect()`;
const all = (await J(`__bay3d.rail.list()`)).filter(t => t.rail === 'SMART'); console.log(all.map(t => `${t.id} ${t.dest} ${t.lat.toFixed(4)},${t.lon.toFixed(4)} v${t.v}`).join('\n'));
const pick = process.env.ID ? all.find(t => t.id === process.env.ID) : all.sort((a, b) => a.lat - b.lat)[0];
const settle = async () => { await sleep(2500); for (let w = 0; w < 150 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(1000); await sleep(1500); };
const here = async () => (await J(`__bay3d.rail.list()`)).find(x => x.id === pick.id);
let me = await here(); await c.ev(`__bay3d.setView(${JSON.stringify({ lat: me.lat, lon: me.lon, dist: 1600, az: 30, tilt: 58 })})`); await settle();
for (let k = 0; k < 6; k++) { const s = (await J(`__bay3d.rail.list(__bay3d.camera, ${R})`)).find(x => x.id === pick.id); if (!s?.sx) break; await c.click(s.sx, s.sy); await sleep(600); if (await c.ev(`!document.getElementById('aisinfo').hidden`) === true) break; }
await c.ev(`document.getElementById('aisinfo').querySelector('.shrinker')?.click()`);
for (const m of views) {
  await c.ev(`[...document.querySelectorAll('#aisinfo .go button')].find(b => b.dataset.m === '${m}')?.click()`); await settle();
  await c.shot(`${tag}_${m}.png`);
}
console.log(await J(`__bay3d.tiles.filter(T=>T.state!=='idle').map(T=>[T.w,T.s,T.state,T.photo])`));
console.log('ERRORS', errs.slice(0, 8).join('\n'));
process.exit(0);
