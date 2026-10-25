// node preprocess/necofs_currents.mjs [outDir=www/data/currents] — the NECOFS forecast's surface currents for
// Bird's-eye's arrows (v1015, requested: "now do the NECOFS current arrows"). NECOFS is UMass Dartmouth's FVCOM
// model of the Gulf of Maine, run daily, hourly out about four days. Its server (OPeNDAP, plain http, no CORS)
// can't be read by the app itself, so the Pages deploy runs this (every push, and every 6 hours) and serves
// <bay>.json beside the app, which keeps it for offline.
//
// The model's grid is unstructured: one element (triangle) nearest the middle of each square cell, `STEP`
// degrees of latitude on a side, in each bay's box; their surface layer's u and v, hourly from a day ago (Bird's-eye's
// clock can be set to any time today) to the end of the forecast. OPeNDAP allows one slice of a variable a request, and a bay's elements are scattered
// through the grid's numbering, so they're read in runs of nearby numbers, a few requests at a time.
//
// Out: { model, made, t0, dt, nt, step, w, s, pts: [cx, cy, lon, lat, ...], uv: base64 Int8 [t][pt][u, v] in
// UNIT cm/s }. Exits 0 with nothing written if the server can't be reached (the deploy goes on without it).
import fs from 'node:fs';
import path from 'node:path';

const URL0 = 'http://www.smast.umassd.edu:8080/thredds/dodsC/models/fvcom/NECOFS/Forecasts/NECOFS_GOM7_FORECAST.nc';
const BAYS = {   // regions3d.js overview boxes [w, s, e, n]
  'penobscot-bay': [-69.45, 43.75, -67.95, 44.75],
  'casco-bay': [-70.55, 43.42, -69.6, 44.02],
};
const STEP = 0.02, SPAN = 200, UNIT = 3, MJD0 = Date.UTC(1858, 10, 17), PAR = 4;
const out = process.argv[2] || 'www/data/currents';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(q, binary) {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch(`${URL0}.${binary ? 'dods' : 'ascii'}?${q.replace(/\[/g, '%5B').replace(/\]/g, '%5D')}`, { signal: AbortSignal.timeout(120e3) });
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

async function main() {
  const G = await get('lonc,latc,time');
  const lon = ascii(G, 'lonc'), lat = ascii(G, 'latc'), T = ascii(G, 'time').map(s => MJD0 + s * 1000);
  const now = Date.now(), ti0 = Math.max(0, T.findIndex(t => t >= now - 24 * 3600e3)), ti1 = T.length - 1;
  if (ti0 < 0 || ti1 - ti0 < 6) throw new Error('no forecast ahead');
  fs.mkdirSync(out, { recursive: true });
  for (const [bay, [w, s, e, n]] of Object.entries(BAYS)) {
    const sx = STEP / Math.cos((s + n) / 2 * Math.PI / 180), cells = new Map();
    lon.forEach((x, i) => {
      const y = lat[i]; if (x < w || x > e || y < s || y > n) return;
      const cx = Math.floor((x - w) / sx), cy = Math.floor((y - s) / STEP), key = cx * 10000 + cy;
      const d = Math.hypot((x - w) / sx - cx - 0.5, (y - s) / STEP - cy - 0.5), c = cells.get(key);
      if (!c || d < c.d) cells.set(key, { i, d, cx, cy });
    });
    const P = [...cells.values()].sort((a, b) => a.i - b.i), runs = [];
    for (const p of P) { const r = runs.at(-1); if (r && p.i - r.a <= SPAN) { r.b = p.i; r.P.push(p); } else runs.push({ a: p.i, b: p.i, P: [p] }); }
    const nt = ti1 - ti0 + 1, uv = new Int8Array(nt * P.length * 2), at = new Map(P.map((p, k) => [p, k]));
    let done = 0;
    const one = async r => {
      const sl = `[${ti0}:1:${ti1}][0:1:0][${r.a}:1:${r.b}]`, [U, V] = dods(await get(`u${sl},v${sl}`, true), 2), m = r.b - r.a + 1;
      for (const p of r.P) {
        const k = at.get(p), j = p.i - r.a;
        for (let t = 0; t < nt; t++) {
          const q = (t * P.length + k) * 2, u = U[t * m + j], v = V[t * m + j];
          uv[q] = Number.isFinite(u) && Math.abs(u) < 10 ? Math.max(-127, Math.min(127, Math.round(u * 100 / UNIT))) : 0;
          uv[q + 1] = Number.isFinite(v) && Math.abs(v) < 10 ? Math.max(-127, Math.min(127, Math.round(v * 100 / UNIT))) : 0;
        }
      }
      if (++done % 40 === 0) console.log(bay, done, '/', runs.length);
    };
    for (let k = 0; k < runs.length; k += PAR) await Promise.all(runs.slice(k, k + PAR).map(one));
    const pts = P.flatMap(p => [p.cx, p.cy, +lon[p.i].toFixed(4), +lat[p.i].toFixed(4)]);
    const J = { model: 'NECOFS GOM7 (UMass Dartmouth FVCOM)', made: new Date(now).toISOString(), t0: T[ti0], dt: 3600e3, nt, step: STEP, w, s, unit: UNIT, pts, uv: Buffer.from(uv.buffer).toString('base64') };
    fs.writeFileSync(path.join(out, `${bay}.json`), JSON.stringify(J));
    console.log(bay, P.length, 'points,', nt, 'hours from', new Date(T[ti0]).toISOString(), `(${runs.length} requests)`);
  }
}
main().catch(e => { console.log('NECOFS currents not built:', e.message); process.exit(0); });
