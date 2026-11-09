// node smooth.mjs: load Bird's-eye, wait for the trains, take the one moving fastest, sample her height for 30 s
import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9567);
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true }); await c.cmd('Network.setBypassServiceWorker', { bypass: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
for (let i = 0; i < 90; i++) { await sleep(1000); if (await c.ev(`__bay3d.rail.items().length > 5 && !!__bay3d.tracks()`) === true) break; }
await sleep(4000);
const snap = async () => JSON.parse(await c.ev(`JSON.stringify(__bay3d.rail.items().map(p=>[p.id,p.x,p.z]))`));
const a = await snap(); await sleep(2000); const b = await snap();
const id = process.env.ID || b.map(([id, x, z]) => { const o = a.find(q => q[0] === id); return [id, o ? Math.hypot(x - o[1], z - o[2]) : 0]; }).sort((p, q) => q[1] - p[1])[0][0];
await c.ev(`__bay3d.trainCard(${JSON.stringify(id)})`);
const ys = [];
const N = +(process.env.N || 150), DT = +(process.env.DT || 200);
for (let i = 0; i < N; i++) { ys.push(JSON.parse(await c.ev(`JSON.stringify((()=>{ const p = __bay3d.rail.items().find(p=>p.id==='${id}'); const t = __bay3d.tracks(); if (!p) return null; const lon = p.fix.lon + (p.x - p.fix.x) / (111320 * Math.cos(p.fix.lat * Math.PI / 180)), lat = p.fix.lat - (p.z - p.fix.z) / 111120; return [p.y, p.x, p.z, t.yAt(p.x, p.z), lon, lat]; })())`))); await sleep(DT); }
const ok = ys.filter(Boolean); let maxStep = 0, path = 0, nulls = ok.filter(v => v[3] == null).length;
for (let i = 1; i < ok.length; i++) { const d = Math.abs(ok[i][0] - ok[i - 1][0]); maxStep = Math.max(maxStep, d); path += Math.hypot(ok[i][1] - ok[i - 1][1], ok[i][2] - ok[i - 1][2]); if (d > 0.25) console.log(' jump', i, d.toFixed(2), ok[i - 1][3]?.toFixed(2), '->', ok[i][3]?.toFixed(2), ok[i][5].toFixed(5), ok[i][4].toFixed(5)); }
let maxMove = 0; for (let i = 1; i < ok.length; i++) maxMove = Math.max(maxMove, Math.hypot(ok[i][1] - ok[i - 1][1], ok[i][2] - ok[i - 1][2]));
console.log(id, 'moved m', path.toFixed(0), 'max y step', maxStep.toFixed(3), 'max move per sample m', maxMove.toFixed(1), 'off-track samples', nulls);
process.exit(0);
