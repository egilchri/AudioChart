// node look.mjs <tag>: SFO in Bird's-eye from a few fixed views (Chrome on :9567, www/ on :8793)
import { connect, sleep } from '../live-tour/cdp.mjs';
const tag = process.argv[2] || 's1', c = await connect(9567); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 300)); if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning')) errs.push(JSON.stringify(d.params.args.map(a => a.description || a.value)).slice(0, 300)); });
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true }); await c.cmd('Network.setBypassServiceWorker', { bypass: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
await sleep(8000);
await c.ev(`(() => { const st = document.createElement('style'); st.textContent = '.panel,#help,#ovmap{display:none!important}'; document.head.appendChild(st); })()`);
const settle = async () => { await sleep(2000); for (let w = 0; w < 50 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(1000); await sleep(1500); };
const V = {
  overview: { lat: 37.613, lon: -122.375, dist: 5500, az: 300, tilt: 52 },
  threshold: { lat: 37.6075, lon: -122.3585, dist: 420, az: 298, tilt: 62 },
  terminals: { lat: 37.6155, lon: -122.3885, dist: 700, az: 250, tilt: 62 },
  lights: { lat: 37.6045, lon: -122.352, dist: 1100, az: 300, tilt: 64 },
  gate: { lat: 37.611555, lon: -122.389794, dist: 180, az: 200, tilt: 58 },
  tower: { lat: 37.6159, lon: -122.3838, dist: 300, az: 120, tilt: 72 },
};
for (const [k, v] of Object.entries(V).filter(([k]) => !process.env.ONLY || process.env.ONLY.split(',').includes(k))) { await c.ev(`__bay3d.setView(${JSON.stringify(v)})`); await settle(); await c.shot(`${tag}_${k}.png`); }
console.log(await c.ev(`JSON.stringify({ ground: __bay3d.air.items().filter(p => p.a.ground).slice(0, 3).map(p => [p.title, +p.y.toFixed(1)]) })`));
console.log(errs.length ? 'ERRORS\n' + [...new Set(errs)].slice(0, 6).join('\n') : 'no errors');
process.exit(0);
