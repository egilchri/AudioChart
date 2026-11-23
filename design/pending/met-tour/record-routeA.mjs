// Records "Brooklyn to the Met" (2026-11-22, asked: "a tour riding the F-train to the Brooklyn waterfront, then taking a
// ferry across to Manhattan, then hop on a bus to get to the Metropolitan museum", "start in Brooklyn, like Cobble Hill",
// route A: the F from Bergen St to York St, NYC Ferry's East River route from DUMBO to East 34th St, the M34 SBS and a
// Madison Avenue bus to 83rd St). Each leg rides a real train, ferry and bus running when it's recorded; the clock is
// stopped and stepped a frame at a time during each leg (shim.js), and runs again between legs while the next is found.
//   GTFS=<dir of the MTA bus zips> VOICE=<ElevenLabs voice id> node record.mjs [outdir] [fps]
//   needs Chrome on :9567 (headless, --use-angle=metal --enable-gpu) and a www/ server on :8791
// Voices the narration (narr.json → narr/, ../bus-video/eleven.py), times the shots to it, records frames → <outdir>/.
import fs from 'fs';
import { execFileSync } from 'child_process';
import { connect, sleep } from '../live-tour/cdp.mjs';
const OUT = process.argv[2] || 'rec', FPS = +(process.argv[3] || 24), VOICE = process.env.VOICE || 'cjVigY5qzO86Huf0OWal';
const c = await connect(9567);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const J = async x => { const r = await c.ev(`JSON.stringify(${x})`); try { return JSON.parse(r); } catch (_) { throw new Error(`page: ${x} -> ${r}`); } };

// ── the narration (Eric), voiced first: the shots are timed to it ──
const narr = {
  a: "This is Ted's Birdseye, over Cobble Hill in Brooklyn. Let's go to the Metropolitan Museum of Art the way New Yorkers do: by subway, ferry and bus. Every train, boat and bus you'll see is a real one, running in the city as this was recorded.",
  b: "We take the F train at Bergen Street, toward Manhattan. This is the view from the front of the train.",
  c: "Two stops on, past Jay Street MetroTech, we get off at York Street, the F's last stop in Brooklyn.",
  d: "Up the stairs in DUMBO, it's a short walk down to the water by the Brooklyn Bridge, and the ferry landing at Fulton Ferry.",
  e: "NYC Ferry's East River route heads north from here, under the Manhattan and Williamsburg Bridges.",
  f: "It calls at Williamsburg, Greenpoint and Long Island City, then crosses to East 34th Street in Manhattan.",
  g: "From there, the M34 Select Bus runs crosstown along 34th Street, and near Madison Avenue we change to a bus uptown.",
  h: "The M1, M2, M3 and M4 all run up Madison into the Upper East Side. We get off at 83rd Street.",
  i: "And a block away, on Fifth Avenue at the edge of Central Park: the Metropolitan Museum of Art.",
  j: "Ted's Birdseye. New York, live.",
};
// (voiced again only when the words change: ElevenLabs charges by the character)
const same = fs.existsSync('narr/durations.json') && fs.existsSync('narr.json') && fs.readFileSync('narr.json', 'utf8') === JSON.stringify(narr, null, 1);
fs.writeFileSync('narr.json', JSON.stringify(narr, null, 1));
if (same) log('narration as voiced before'); else { log('voicing'); execFileSync('python3', ['-I', '../bus-video/eleven.py', 'narr', VOICE, 'narr.json', 'narr'], { stdio: 'inherit' }); }
const D = JSON.parse(fs.readFileSync('narr/durations.json', 'utf8'));

// ── the shots: [narration, shot, leg, seconds more] ──
const SHOTS = [['a', 'open', 'open', 1.5], ['b', 'fcab1', 'F1', 1.2], ['c', 'fcab2', 'F2', 1.5], ['d', 'dumbo', 'walk', 1.2],
  ['e', 'shelm', 'ferry', 1.5], ['f', 'sdrone', 'ferry', 1.5], ['g', 'bahead', 'bus', 1.2], ['h', 'bcab', 'bus', 1.5], ['i', 'met', 'met', 2], ['j', 'end', 'met', 2.5]];
let T = 0; const segs = SHOTS.map(([k, s, leg, x], i) => { const lead = i === 0 ? 0.8 : 0.9, seg = { k, s, leg, t0: T, say: T + lead, t1: T + lead + D[k] + x }; T = seg.t1; return seg; });
const LEN = T; log('length', LEN.toFixed(1), 's');

// ── the page ──
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync('shim.js', 'utf8') });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8791/bay3d.html?region=new-york-harbor&v=' + Date.now() });
for (let i = 0; i < 90; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.liveShips`) === true) break; }
await sleep(8000);
await c.ev(`(()=>{ const st=document.createElement('style'); st.textContent='#loading,#help,#followhud{display:none!important}'; document.head.appendChild(st); })()`);
const liveOn = async () => { for (let i = 0; i < 60; i++) { const t = await c.ev(`document.getElementById('livebtn').textContent`); if (/·/.test(t) && await c.ev(`__bay3d.rail.list().length`) > 100) return; if (i % 12 === 0) await c.ev(`document.getElementById('livebtn').click()`); await sleep(2500); } };
await liveOn(); log('live');

const V = {
  open: { lat: 40.6855, lon: -73.9960, dist: 1900, az: 15, tilt: 60 },   // Cobble Hill, looking up toward Manhattan
  dumbo: { lat: 40.7036, lon: -73.9930, dist: 900, az: 300, tilt: 58 },   // DUMBO and Fulton Ferry, the bridges
  met: { lat: 40.7792, lon: -73.9625, dist: 650, az: 285, tilt: 52 },   // the Met, Central Park beyond
};
const tilesBusy = `__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`;
const settle = async (ms = 900) => { for (let k = 0; k < ms / 150; k++) { await c.ev(`__step(150)`); for (let w = 0; w < 60 && await c.ev(tilesBusy); w++) await sleep(150); } };
const viewAt = async (v) => { await c.ev(`__bay3d.leaveRide()`); await c.ev(`__bay3d.setView(${JSON.stringify(v)})`); };

// ── each leg: the clock running till her train, boat or bus is found, then stopped ──
const SUB = JSON.parse(fs.readFileSync('../../../www/data/rail/nyc-subway.json', 'utf8'));
const DEG = Math.PI / 180, mxy = (o, p) => [(p[0] - o[0]) * 111320 * Math.cos(o[1] * DEG), (p[1] - o[1]) * 111120];
function project(pts, lon, lat) {   // → s (metres along) of the point on pts nearest (lon, lat), and how far off
  let s = 0, best = { s: 0, d: Infinity };
  for (let i = 0; i + 1 < pts.length; i++) { const [ax, ay] = mxy([lon, lat], pts[i]), [bx, by] = mxy([lon, lat], pts[i + 1]), L = Math.hypot(bx - ax, by - ay) || 1e-9, u = Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / (L * L))), d = Math.hypot(ax + (bx - ax) * u, ay + (by - ay) * u); if (d < best.d) best = { s: s + u * L, d }; s += L; }
  return best;
}
const cumOf = pts => { const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(...mxy(pts[i - 1], pts[i]))); return cum; };
let her = {}, plan = null;
const FV = 10;   // (the F's pace between Bergen St and York St, m/s: about 22 mph)
async function leg(name) {
  await c.ev(`__thaw()`); await c.ev(`__bay3d.leaveRide()`);
  if (name === 'open' || name === 'walk' || name === 'met') { await viewAt(V[name === 'open' ? 'open' : name === 'walk' ? 'dumbo' : 'met']); await sleep(9000); await c.ev(`__freeze()`); await settle(1500); return; }
  // the F: a train to Jamaica (northbound) up to 2.4 km short of Bergen St, run on by the page in real time till she's
  // at Bergen St (F1), then again till she's a shot's length short of York St (F2); the clock stopped there each time,
  // and while it's stopped she's carried on along her route at a subway's pace (__trainPlan)
  if (name === 'F1' || name === 'F2') {
    if (name === 'F1') for (let i = 0; i < 120 && !her.F; i++) {
      const fs_ = await J(`__bay3d.rail.list().filter(t => t.rail === 'F train' && /\\.\\.N/.test(t.id)).map(t => ({ id: t.id, lat: t.lat, lon: t.lon }))`);
      for (const t of fs_) {
        const key = t.id.split('_').slice(1).join('_'), sh = SUB.shapes[key]; if (!sh) continue;
        const stop = id => sh.s.find(x => x[0] === id)?.[1]; const sB = stop('F20'), sY = stop('F18'); if (sB == null || sY == null) continue;
        const pr = project(sh.p, t.lon, t.lat);
        if (pr.d < 80 && pr.s > sB - 2400 && pr.s <= sB - 150) { her.F = { id: t.id, key, sB, sY, pts: sh.p, cum: cumOf(sh.p) }; log('F', t.id, Math.round(sB - pr.s), 'm short of Bergen St'); break; }
      }
      if (!her.F) { if (i % 6 === 0) log('waiting for an F north of Carroll St'); await sleep(10000); }
    }
    if (!her.F) throw new Error('no F');
    const sg = segs.find(x => x.leg === name), target = name === 'F1' ? her.F.sB - 40 : her.F.sY - FV * (sg.t1 - sg.t0) - 10;
    for (let i = 0; ; i++) {
      const t = await J(`__bay3d.rail.list().find(t => t.id === ${JSON.stringify(her.F.id)})`); if (!t) throw new Error('lost the F');
      const pr = project(her.F.pts, t.lon, t.lat);
      if (pr.s >= target) { if (pr.s - target > 50) log(name, 'overshot by', Math.round(pr.s - target), 'm (reports jump a stop at a time), put back'); plan = { id: her.F.id, pts: her.F.pts, cum: her.F.cum, s0: target, v: FV }; break; }
      if (i % 15 === 0) log(name, Math.round(target - pr.s), 'm to go');
      if (i > 600) throw new Error('the F stopped');
      await sleep(2000);
    }
    await c.ev(`window.__trainPlan = ${JSON.stringify(plan)}`); await c.ev(`__freeze()`); log(name, 'stopped the clock'); return;
  }
  if (name === 'ferry') {   // (take 3, the user: "I don't want a narration that is false") an East River route boat, known as
    // one by calling at DUMBO (Fulton Ferry Landing) and then heading north, up toward the Manhattan Bridge: the Astoria and
    // Soundview boats pass under the same bridges but don't call at DUMBO, and the South Brooklyn boats leave it southward
    const LAND = [-73.9946, 40.7037], near = s => Math.hypot(...mxy(LAND, [s.lon, s.lat]));
    const called = new Map(); let s = null;
    for (let i = 0; i < 400 && !s; i++) {
      const a = await J(`__bay3d.liveShips().filter(s => /NYC Ferry/.test(s.what) && (s.age ?? 0) < 150)`);
      for (const x of a) if (near(x) < 350 && x.sog < 3) called.set(String(x.mmsi), Date.now());
      s = a.find(x => called.has(String(x.mmsi)) && Date.now() - called.get(String(x.mmsi)) < 15 * 60000 && x.sog > 6 && (x.cog > 340 || x.cog < 80) && x.lat > LAND[1] && x.lat < 40.7135 && near(x) > 150) || null;
      if (!s) { if (i % 6 === 0) log('waiting for an East River boat leaving DUMBO northbound; called there:', [...called.keys()].join(',') || 'none'); await sleep(10000); }
    }
    if (!s) throw new Error('no ferry'); her.ferry = s; await c.ev(`__freeze()`); log('ferry', JSON.stringify(s)); return;
  }
  if (name === 'bus') {   // a Madison Avenue bus going uptown, between 59th and 79th St
    let b = null;
    for (let i = 0; i < 120 && !b; i++) {
      b = await J(`(() => { const a = __bay3d.rail.items().filter(p => p.mta && /^M[1-4]$/.test(p.route) && String(p.b?.dir) === '0' && p.vKnown && p.v > 2 && p.v < 14 && latOf(p) > 40.762 && latOf(p) < 40.776); const p = a[0]; return p ? { id: p.id, route: p.route, dest: p.a?.dest, trip: p.b.trip, dir: p.b.dir } : null; })()`.replace(/latOf\(p\)/g, '(p.b?.lat ?? 0)'));
      if (!b) { if (i % 6 === 0) log('waiting for a Madison Avenue bus uptown'); await sleep(10000); }
    }
    if (!b) throw new Error('no bus'); her.bus = b; log('bus', JSON.stringify(b));
    const path = JSON.parse(execFileSync('python3', ['../bus-video/shape.py', process.env.GTFS || 'gtfs', b.trip, b.route, String(b.dir ?? 0)]).toString());
    await c.ev(`window.__busPath = ${JSON.stringify({ id: b.id, pts: path })}`); await c.ev(`__freeze()`); return;
  }
}
// the F carried on to s (metres along her route), the clock stepped half a second at a time, no frames
const ffTo = async s => { for (let k = 0; k < 2000 && (await c.ev(`__trainS()`)) < s; k++) await c.ev(`__step(500)`); };
// (then the page caught up: it asks for the trains every 30 real seconds, so after a fast-forward she's drawn where her
// last report had her; wait, the clock barely moving, till she's drawn within 40 m of where she is)
const planAt = sv => { const P = plan, cum = P.cum; let i = 1; while (i < cum.length - 1 && cum[i] < sv) i++; const f = Math.max(0, Math.min(1, (sv - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1))); return [P.pts[i - 1][0] + (P.pts[i][0] - P.pts[i - 1][0]) * f, P.pts[i - 1][1] + (P.pts[i][1] - P.pts[i - 1][1]) * f]; };
async function syncTrain() {
  for (let k = 0; k < 90; k++) {
    const t = await J(`__bay3d.rail.list().find(t => t.id === ${JSON.stringify(plan.id)})`), sv = await c.ev(`__trainS()`), [lo, la] = planAt(sv);
    const d = t ? Math.hypot(...mxy([lo, la], [t.lon, t.lat])) : Infinity;
    if (d < 40) { log('F drawn', Math.round(d), 'm off'); return; }
    if (k % 10 === 0) log('F drawn', Math.round(d), 'm off; waiting for the page');
    await c.ev(`__step(50)`); await sleep(1000);
  }
  log('F never caught up');
}
const ride = async (id, mode) => { const r = await c.ev(`__bay3d.rideMover(${JSON.stringify(id)}, '${mode}')`); if (r !== id) log('ride failed', id, mode, r); };
const rideShip = async (mmsi, mode) => { const r = await c.ev(`__bay3d.rideShip(${JSON.stringify(String(mmsi))}, '${mode}')`); if (r !== String(mmsi)) log('ride failed', mmsi, mode, r); };

fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const marks = [], dt = 1 / FPS; let nf = 0, cur = '', curLeg = '';
for (let f = 0; f * dt <= LEN; f++) {
  const t = f * dt, sg = segs.find(s => t < s.t1) || segs.at(-1);
  for (const s of segs) if (Math.abs(t - s.say) < dt / 2 + 1e-9) marks.push({ name: s.k, t });
  if (sg.leg !== curLeg) { curLeg = sg.leg; log('leg', curLeg); await leg(curLeg); }
  if (sg.s !== cur) {   // (a cut: the new shot set up, and a look first so its ground and streets are in)
    cur = sg.s; log('shot', cur);
    if (cur === 'fcab1') await ride(plan.id, 'helm');
    if (cur === 'fcab2') await ride(plan.id, 'helm');
    if (cur === 'shelm') await rideShip(her.ferry.mmsi, 'helm');
    if (cur === 'sdrone') await rideShip(her.ferry.mmsi, 'drone');
    if (cur === 'bahead') await ride(her.bus.id, 'bow');
    if (cur === 'bcab') await ride(her.bus.id, 'helm');
    await settle(1200);
  }
  const k = (t - sg.t0) / (sg.t1 - sg.t0);
  if (cur === 'open' || cur === 'dumbo' || cur === 'met' || cur === 'end') { const v = V[cur === 'end' ? 'met' : cur]; await c.ev(`__bay3d.setView(${JSON.stringify({ ...v, dist: v.dist * ((cur === 'end' ? 1.25 : 1) - 0.08 * k), az: v.az + 8 * k })})`); }
  await c.ev(`__step(${1000 / FPS})`);
  if (t - sg.t0 < 0.1) for (let w = 0; w < 40 && await c.ev(tilesBusy); w++) await sleep(150);
  const r = await c.cmd('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  fs.writeFileSync(`${OUT}/${String(nf++).padStart(5, '0')}.jpg`, Buffer.from(r.result.data, 'base64'));
  if (f % (FPS * 5) === 0) log('t', t.toFixed(1), sg.k, cur);
}
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({ fps: FPS, frames: nf, marks, her }));
log('done', nf, 'frames');
process.exit(0);
