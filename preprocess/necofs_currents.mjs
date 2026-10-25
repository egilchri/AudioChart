// node preprocess/necofs_currents.mjs [outDir=www/data/currents] — the NECOFS forecast's surface currents for
// Bird's-eye's arrows (v1015, requested: "now do the NECOFS current arrows"). NECOFS is UMass Dartmouth's FVCOM
// model of the Gulf of Maine, run daily, hourly out about four days. Its server (OPeNDAP, plain http, no CORS)
// can't be read by the app itself, so the Pages deploy runs this (every push, and every 6 hours) and serves
// <bay>.json beside the app, which keeps it for offline.
//
// The model's grid is unstructured: one element (triangle) nearest the middle of each square cell, `step`
// degrees of latitude on a side, in each bay's box; their surface layer's u and v, hourly from a day ago
// (Bird's-eye's clock can be set to any time today) to the end of the forecast. OPeNDAP allows one slice of a
// variable a request, and a bay's elements are scattered through the grid's numbering, so they're read in runs
// of nearby numbers, a few requests at a time.
//
// Casco also gets NECOFS's own Casco Bay model (v1016, requested: "use the finer NECOFS Casco model for the
// arrows"), at 0.01°. Its forecast file holds only one day, the one after next when it's made (each evening), so
// each build carries forward the fine hours the live site already has that aren't over yet, and adds the new
// file's: from the second day on, they cover today. Hours it doesn't cover use the Gulf of Maine model's.
//
// Out: { model, made, t0, dt, nt, step, w, s, unit, pts: [cx, cy, lon, lat, ...], uv: base64 Int8 [t][pt][u, v]
// in UNIT cm/s, fine?: { model, step, w, s, unit, pts, ts: [ms, ...], uv } }. Exits 0 with nothing written if
// the server can't be reached (the deploy goes on without it).
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://www.smast.umassd.edu:8080/thredds/dodsC/models/fvcom/NECOFS/Forecasts/';
const GOM7 = BASE + 'NECOFS_GOM7_FORECAST.nc', CASCO = BASE + 'NECOFS_FVCOM_OCEAN_CASCO_FORECAST.nc';
const LIVE = process.env.CURRENTS_LIVE ?? 'https://egilchri.github.io/AudioChart/data/currents/';   // (the site as deployed: its fine hours)
const BAYS = {   // regions3d.js overview boxes [w, s, e, n]
  'penobscot-bay': [-69.45, 43.75, -67.95, 44.75],
  'casco-bay': [-70.55, 43.42, -69.6, 44.02],
};
const UNIT = 3, MJD0 = Date.UTC(1858, 10, 17), PAR = 4;
const out = process.argv[2] || 'www/data/currents';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, q, binary) {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch(`${url}.${binary ? 'dods' : 'ascii'}?${q.replace(/\[/g, '%5B').replace(/\]/g, '%5D')}`, { signal: AbortSignal.timeout(120e3) });
      if (!r.ok) throw new Error(`${r.status}`);
      return binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
    } catch (e) { if (k >= 3) throw e; await sleep(2000 * (k + 1)); }
  }
}
// an ASCII response's one-dimensional array `name`
const ascii = (T, name) => T.split(`\n${name}[`)[1].split('\n')[1].split(',').map(Number);
// a binary (DAP2) response's arrays, in the order asked: after "Data:\n", each a count twice then big-endian floats
function dods(buf, n) {
  let o = buf.indexOf('\nData:\n') + 7; const A = [];
  for (let k = 0; k < n; k++) { const len = buf.readUInt32BE(o); o += 8; const a = new Float32Array(len); for (let i = 0; i < len; i++, o += 4) a[i] = buf.readFloatBE(o); A.push(a); }
  return A;
}

// The surface currents of `url`'s elements nearest the middle of each `step` cell in the box, for times ti0..ti1:
// { pts, uv (Int8Array [t][pt][u, v]) }
async function sample(url, lon, lat, [w, s, e, n], step, span, ti0, ti1, label) {
  const sx = step / Math.cos((s + n) / 2 * Math.PI / 180), cells = new Map();
  lon.forEach((x, i) => {
    const y = lat[i]; if (x < w || x > e || y < s || y > n) return;
    const cx = Math.floor((x - w) / sx), cy = Math.floor((y - s) / step), key = cx * 10000 + cy;
    const d = Math.hypot((x - w) / sx - cx - 0.5, (y - s) / step - cy - 0.5), c = cells.get(key);
    if (!c || d < c.d) cells.set(key, { i, d, cx, cy });
  });
  const P = [...cells.values()].sort((a, b) => a.i - b.i), runs = [];
  for (const p of P) { const r = runs.at(-1); if (r && p.i - r.a <= span) { r.b = p.i; r.P.push(p); } else runs.push({ a: p.i, b: p.i, P: [p] }); }
  const nt = ti1 - ti0 + 1, uv = new Int8Array(nt * P.length * 2), at = new Map(P.map((p, k) => [p, k]));
  const q8 = x => Number.isFinite(x) && Math.abs(x) < 10 ? Math.max(-127, Math.min(127, Math.round(x * 100 / UNIT))) : 0;
  let done = 0;
  const one = async r => {
    const sl = `[${ti0}:1:${ti1}][0:1:0][${r.a}:1:${r.b}]`, [U, V] = dods(await get(url, `u${sl},v${sl}`, true), 2), m = r.b - r.a + 1;
    for (const p of r.P) {
      const k = at.get(p), j = p.i - r.a;
      for (let t = 0; t < nt; t++) { const q = (t * P.length + k) * 2; uv[q] = q8(U[t * m + j]); uv[q + 1] = q8(V[t * m + j]); }
    }
    if (++done % 100 === 0) console.log(label, done, '/', runs.length);
  };
  for (let k = 0; k < runs.length; k += PAR) await Promise.all(runs.slice(k, k + PAR).map(one));
  console.log(label, P.length, 'points,', nt, 'hours', `(${runs.length} requests)`);
  return { pts: P.flatMap(p => [p.cx, p.cy, +lon[p.i].toFixed(4), +lat[p.i].toFixed(4)]), uv };
}
const b64 = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

// Casco's fine hours: the new file's, and those the live site has that aren't over (on the same points)
async function cascoFine(now) {
  const box = BAYS['casco-bay'], step = 0.01, keepFrom = now - 24 * 3600e3, frames = new Map();
  let pts = null;
  try {
    const G = await get(CASCO, 'lonc,latc,Itime,Itime2');
    const lon = ascii(G, 'lonc'), lat = ascii(G, 'latc'), I = ascii(G, 'Itime'), I2 = ascii(G, 'Itime2');
    const T = I.map((d, k) => MJD0 + d * 864e5 + I2[k]);
    const F = await sample(CASCO, lon, lat, box, step, 400, 0, T.length - 1, 'casco fine');
    pts = F.pts; const n2 = pts.length / 2;
    T.forEach((t, k) => frames.set(t, F.uv.subarray(k * n2, (k + 1) * n2)));
  } catch (e) { console.log('Casco model not read:', e.message); }
  try {
    const L = await (await fetch(LIVE + 'casco-bay.json', { signal: AbortSignal.timeout(30e3) })).json(), f = L.fine;
    if (f && (!pts || JSON.stringify(f.pts) === JSON.stringify(pts))) {
      pts ??= f.pts; const uv = new Int8Array(Buffer.from(f.uv, 'base64')), n2 = pts.length / 2;
      f.ts.forEach((t, k) => { if (t >= keepFrom && !frames.has(t)) frames.set(t, uv.subarray(k * n2, (k + 1) * n2)); });
      console.log('casco fine: carried', f.ts.filter(t => t >= keepFrom).length, 'hours from the live site');
    }
  } catch (e) { console.log('no live Casco hours to carry:', e.message); }
  const ts = [...frames.keys()].filter(t => t >= keepFrom).sort((a, b) => a - b);
  if (!pts || !ts.length) return null;
  const uv = new Int8Array(ts.length * pts.length / 2); ts.forEach((t, k) => uv.set(frames.get(t), k * pts.length / 2));
  console.log('casco fine:', ts.length, 'hours,', new Date(ts[0]).toISOString(), 'to', new Date(ts.at(-1)).toISOString());
  return { model: 'NECOFS Casco Bay (UMass Dartmouth FVCOM)', step, w: box[0], s: box[1], unit: UNIT, pts, ts, uv: b64(uv) };
}

async function main() {
  const G = await get(GOM7, 'lonc,latc,time');
  const lon = ascii(G, 'lonc'), lat = ascii(G, 'latc'), T = ascii(G, 'time').map(s => MJD0 + s * 1000);
  const now = Date.now(), ti0 = Math.max(0, T.findIndex(t => t >= now - 24 * 3600e3)), ti1 = T.length - 1;
  if (ti0 < 0 || ti1 - ti0 < 6) throw new Error('no forecast ahead');
  fs.mkdirSync(out, { recursive: true });
  for (const [bay, box] of Object.entries(BAYS)) {
    const step = 0.02, { pts, uv } = await sample(GOM7, lon, lat, box, step, 200, ti0, ti1, bay), nt = ti1 - ti0 + 1;
    const J = { model: 'NECOFS GOM7 (UMass Dartmouth FVCOM)', made: new Date(now).toISOString(), t0: T[ti0], dt: 3600e3, nt, step, w: box[0], s: box[1], unit: UNIT, pts, uv: b64(uv) };
    if (bay === 'casco-bay') { const f = await cascoFine(now); if (f) J.fine = f; }
    fs.writeFileSync(path.join(out, `${bay}.json`), JSON.stringify(J));
    console.log(bay, 'from', new Date(T[ti0]).toISOString());
  }
}
main().catch(e => { console.log('NECOFS currents not built:', e.message); process.exit(0); });
