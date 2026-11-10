// node jitter.mjs: follow a moving train (drone view) and record each car's place, heading and height every frame for
// SECS seconds; print how jumpy they are. ID=<train id> to choose; RAIL= to choose among a railroad's
import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9567), SECS = +(process.env.SECS || 40);
await c.cmd('Network.enable'); await c.cmd('Network.setBypassServiceWorker', { bypass: true }); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`__bay3d.rail.list().filter(t => t.v > 4).length > 2`) === true) break; }
const J = async x => JSON.parse(await c.ev(`JSON.stringify(${x})`));
const all = (await J(`__bay3d.rail.list()`)).filter(t => t.v > 4 && t.lat > 37.25 && t.lat < 38.6 && t.lon > -123 && t.lon < -121.5 && (!process.env.RAIL || t.rail === process.env.RAIL));
const pick = process.env.ID ? (await J(`__bay3d.rail.list()`)).find(t => t.id === process.env.ID) : all.sort((a, b) => b.v - a.v)[(+process.env.N || 0)];
console.log('train', pick.id, pick.rail, 'v', pick.v);
await c.ev(`__bay3d.setView({ lat: ${pick.lat}, lon: ${pick.lon}, dist: 600, az: 0, tilt: 60 })`); await sleep(2000);
await c.ev(`__bay3d.trainCard(${JSON.stringify(pick.id)})`); await sleep(800);
await c.ev(`[...document.querySelectorAll('#aisinfo .go button')].find(b => b.dataset.m === '${process.env.MODE || 'drone'}')?.click()`); await sleep(4000);
const rec = JSON.parse(await c.ev(`(async () => JSON.stringify(await new Promise(res => { const p = __bay3d.rail.items().find(p => p.id === ${JSON.stringify(pick.id)}), out = [], t0 = performance.now(), v = new THREE_V();
  function THREE_V() { return { x: 0, y: 0, z: 0 }; }
  const t00 = p.lastT; const f = () => { const t = (p.lastT || 0) - t00; const cs = p.cars.map(c => { c.updateWorldMatrix(true, false); const e = c.matrixWorld.elements; const L = Math.hypot(e[8], e[10]) || 1; return [e[12], e[13], e[14], Math.atan2(-e[8], e[10]), -e[8] / L, -e[10] / L, e[9]]; }); out.push([t, p.artd, cs, p.gapT, p.v, p.cur && p.cur.k]); if (t < ${SECS * 1000}) requestAnimationFrame(f); else res(out); }; f(); })))()`));
// in windows of >= 250 ms: each car's speed along, sideways, heading rate and climb; flag a change between windows
const C_at = (i, k) => { const r = W[i][1][2][k]; return `${r[0].toFixed(0)},${r[2].toFixed(0)} y${r[1].toFixed(1)} piece ${W[i][1][5]}`; };
const W = []; let last = rec[0];
for (const r of rec) if (r[0] - last[0] >= 250) { W.push([last, r]); last = r; }
const st = W.map(([a, b]) => { const dt = (b[0] - a[0]) / 1000; return { t: b[0] / 1000, gap: b[3], v: b[4], cars: b[2].map((C, k) => { const B = a[2][k], dx = C[0] - B[0], dz = C[2] - B[2]; return { sp: (dx * C[4] + dz * C[5]) / dt, side: Math.abs(dx * C[5] - dz * C[4]) / dt, dh: Math.abs(((C[3] - B[3]) * 180 / Math.PI + 540) % 360 - 180) / dt, dy: (C[1] - B[1]) / dt }; }) }; });
let mx = { acc: 0, side: 0, dh: 0, dy: 0, ddy: 0 }; const ev = [];
for (let i = 1; i < st.length; i++) if (st[i].t > 4) st[i].cars.forEach((c, k) => {
  const p = st[i - 1].cars[k], acc = Math.abs(c.sp - p.sp) / ((st[i].t - st[i - 1].t) || 1), ddy = Math.abs(c.dy - p.dy);
  mx.acc = Math.max(mx.acc, acc); mx.side = Math.max(mx.side, c.side); mx.dh = Math.max(mx.dh, c.dh); mx.dy = Math.max(mx.dy, Math.abs(c.dy)); mx.ddy = Math.max(mx.ddy, ddy);
  if (st[i].t > 4 && (acc > 3 || c.side > 1.5 || c.dh > 10 || ddy > 1)) ev.push(`${st[i].t.toFixed(1)}s car${k} speed ${p.sp.toFixed(1)}→${c.sp.toFixed(1)} side ${c.side.toFixed(2)} turn ${c.dh.toFixed(1)}°/s climb ${p.dy.toFixed(2)}→${c.dy.toFixed(2)} gap ${st[i].gap?.toFixed(0)} v ${st[i].v?.toFixed(1)} at ${C_at(i, k)}`);
});
const sp = st.map(w => w.cars[0].sp); console.log('speed car0 (m/s, each ~1 s):', sp.filter((_, i) => i % 4 === 0).map(v => v.toFixed(0)).join(' '));
console.log(`windows ${st.length}: max accel ${mx.acc.toFixed(1)} m/s², sideways ${mx.side.toFixed(2)} m/s, turn ${mx.dh.toFixed(1)}°/s, climb ${mx.dy.toFixed(2)} m/s, climb change ${mx.ddy.toFixed(2)} m/s`);
console.log(ev.length, 'events'); console.log(ev.slice(0, 20).join('\n'));
process.exit(0);
