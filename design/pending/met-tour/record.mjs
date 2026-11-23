// Records "Brooklyn to the Met" (2026-11-22, asked: "a tour riding the F-train to the Brooklyn waterfront, then taking a
// ferry across to Manhattan, then hop on a bus to get to the Metropolitan museum", "start in Brooklyn, like Cobble Hill";
// route A's ferry dropped the same day, the user choosing "F train then Madison bus": the F from Bergen St to 34 St-Herald
// Sq, a walk east along 34th St past the Empire State Building, and a Madison Avenue bus (M1-M4) to 83rd St; route A's
// version is record-routeA.mjs). Each leg rides a real train and bus running when it's recorded (two different F trains:
// one leaving Bergen St, one coming into Herald Sq, the ride between being 25 minutes); the clock is stopped and stepped
// a frame at a time during each leg (shim.js), and runs again between legs while the next is found. The narration
// must be true of what's on screen (the user: "I don't want a narration that is false").
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
  a: "This is Ted's Birdseye, over Cobble Hill in Brooklyn. Let's go to the Metropolitan Museum of Art the way New Yorkers do: by subway and bus. Every train and bus you'll see is a real one, running in the city as this was recorded.",
  b: "We take the F train at Bergen Street, toward Manhattan. This is the view from the front of the train.",
  c: "We ride it under the East River and up Sixth Avenue, to 34th Street, Herald Square.",
  d: "Up on the street, it's a two-block walk east along 34th Street, past the Empire State Building, to Madison Avenue.",
  e: "On Madison, the M1, M2, M3 and M4 all run uptown.",
  f: "Up through Midtown and into the Upper East Side. We get off at 83rd Street.",
  g: "And a block away, on Fifth Avenue at the edge of Central Park: the Metropolitan Museum of Art.",
  h: "Ted's Birdseye. New York, live.",
};
// (voiced again only when the words change: ElevenLabs charges by the character)
const same = fs.existsSync('narr/durations.json') && fs.existsSync('narr.json') && fs.readFileSync('narr.json', 'utf8') === JSON.stringify(narr, null, 1);
fs.writeFileSync('narr.json', JSON.stringify(narr, null, 1));
if (same) log('narration as voiced before'); else { log('voicing'); execFileSync('python3', ['-I', '../bus-video/eleven.py', 'narr', VOICE, 'narr.json', 'narr'], { stdio: 'inherit' }); }
const D = JSON.parse(fs.readFileSync('narr/durations.json', 'utf8'));

// ── the shots: [narration, shot, leg, seconds more] ──
// (d and g: the walker's own eyes, asked: "do a POV of the person doing the walking parts"; walks below)
const SHOTS = [['a', 'open', 'open', 1.5], ['b', 'fcab1', 'F1', 1.2], ['c', 'fcab2', 'F2', 1.5], ['d', 'walk1', 'walk', 15 - 0.9 - 6.13],
  ['e', 'bahead', 'bus', 1.2], ['f', 'bcab', 'bus', 1.5], ['g', 'walk2', 'met', 10 - 0.9 - 5.76], ['h', 'end', 'met', 2.5]];
// SPLICE=<an earlier take's frames> OLDX=<its d,g extras, e.g. 3,3>: only the walks recorded again, the rest copied from it
const SPLICE = process.env.SPLICE, OLDX = (process.env.OLDX || '3,3').split(',').map(Number);
let T = 0; const segs = SHOTS.map(([k, s, leg, x], i) => { const lead = i === 0 ? 0.8 : 0.9, seg = { k, s, leg, t0: T, say: T + lead, t1: T + lead + D[k] + x }; T = seg.t1; return seg; });
const LEN = T; log('length', LEN.toFixed(1), 's');
let oldSegs = null;
if (SPLICE) { let T2 = 0; oldSegs = SHOTS.map(([k, s, leg, x], i) => { if (k === 'd') x = OLDX[0]; if (k === 'g') x = OLDX[1]; const lead = i === 0 ? 0.8 : 0.9, seg = { k, t0: T2, t1: T2 + lead + D[k] + x }; T2 = seg.t1; return seg; }); }

// ── the page ──
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync('shim.js', 'utf8') });
await c.cmd('Network.enable'); await c.cmd('Network.clearBrowserCache'); await c.cmd('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8791', storageTypes: 'all' });   // (a stale cached buildings file hid the Met)
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8791/bay3d.html?region=new-york-harbor&v=' + Date.now() });
for (let i = 0; i < 90; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.liveShips`) === true) break; }
await sleep(8000);
await c.ev(`(()=>{ const st=document.createElement('style'); st.textContent='#loading,#help,#followhud{display:none!important}'; document.head.appendChild(st); })()`);
const liveOn = async () => { for (let i = 0; i < 60; i++) { const t = await c.ev(`document.getElementById('livebtn').textContent`); if (/·/.test(t) && await c.ev(`__bay3d.rail.list().length`) > 100) return; if (i % 12 === 0) await c.ev(`document.getElementById('livebtn').click()`); await sleep(2500); } };
await liveOn(); log('live');

const V = {
  open: { lat: 40.6855, lon: -73.9960, dist: 1900, az: 15, tilt: 60 },   // Cobble Hill, looking up toward Manhattan
  herald: { lat: 40.7488, lon: -73.9858, dist: 1000, az: 29, tilt: 58 },   // 34th St from Herald Sq to Madison, the Empire State Building, looking up the avenues
  met: { lat: 40.77895, lon: -73.9628, dist: 520, az: 299, tilt: 62 },   // the Met's front on Fifth Avenue, Central Park beyond (landmarks3d.js)
};
const tilesBusy = `__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`;
const settle = async (ms = 900) => { for (let k = 0; k < ms / 150; k++) { await c.ev(`__step(150)`); for (let w = 0; w < 60 && await c.ev(tilesBusy); w++) await sleep(150); } };
// the walks, on the sidewalk at eye height (__bay3d.walkEye; streets from www/data/streets): 34th St's south side from
// Sixth Avenue (Herald Sq) to Madison, turning to look up at the Empire State Building on the right as it's passed; 83rd
// St's south side from Madison to Fifth, then turning left to the Met's front down the avenue. k = 0..1 through the shot.
const DEG_ = Math.PI / 180, offLL = (p, brg, m) => [p[0] + Math.sin(brg * DEG_) * m / (111320 * Math.cos(p[1] * DEG_)), p[1] + Math.cos(brg * DEG_) * m / 111120];
const lerpLL = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
const ease = x => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x), bump = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));
// (the user, of take 5: "the walks are too fast, slow them down": they'd been ~39 and ~25 m/s, the whole way in a few
// seconds; now pieces of each, cut together, at ~7 m/s: brisk, but a walk)
const pieces = (P, k) => { const W = P.reduce((a, p) => a + p.w, 0); let x = k * W; for (let i = 0; i < P.length; i++) { if (x <= P[i].w || i === P.length - 1) return [i, Math.min(1, x / P[i].w)]; x -= P[i].w; } };
const W1 = [{ w: 5, f0: 0.10, f1: 0.176 }, { w: 6, f0: 0.31, f1: 0.40 }, { w: 4, f0: 0.89, f1: 0.95 }];   // (of 460 m: Herald Sq, the Empire State Building, Madison)
const W2 = [{ w: 4.3, f0: 0.08, f1: 0.28 }, { w: 5.7, f0: 0.75, f1: 0.95 }];   // (of 150 m: leaving Madison; reaching Fifth, then the turn)
const WALK = {
  walk1: k => { const A = [-73.987746, 40.749801], B = [-73.982961, 40.747771], b = 119.2, [i, x] = pieces(W1, k), P = W1[i], f = P.f0 + (P.f1 - P.f0) * x, look = i === 1 ? bump(f, 0.355, 0.03) : 0;
    const [lon, lat] = offLL(lerpLL(A, B, f), b + 90, 10.5); return { lon, lat, az: b + 38 * look, pitch: 3 + 34 * look, piece: i }; },
  walk2: k => { const A = [-73.960236, 40.778908], B = [-73.961833, 40.779582], b = 299.1, [i, x] = pieces(W2, k), P = W2[i], f = P.f0 + (P.f1 - P.f0) * (i === 1 ? ease(x / 0.6) : x), turn = i === 1 ? ease((x - 0.55) / 0.35) : 0;
    const [lon, lat] = offLL(lerpLL(A, B, f), b - 90, 6); return { lon, lat, az: b - 59 * turn, pitch: 3 + 5 * turn, piece: i }; },
};
let piece = -1;
const eyeAt = async (shot, k) => { const e = WALK[shot](k); await c.ev(`__bay3d.walkEye(${JSON.stringify(e)})`); if (e.piece !== piece) { const cut = piece >= 0 && k > 0; piece = e.piece; if (cut) await settle(600); } };
const viewAt = async (v) => { await c.ev(`__bay3d.leaveRide()`); await c.ev(`__bay3d.walkEye(null)`); await c.ev(`__bay3d.setView(${JSON.stringify(v)})`); };

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
const FV = 10;   // (the F's pace, m/s: about 22 mph)
// (take 7: the page's train polling stopped unseen for half an hour, and takes 5 and 6's F reports jumped kilometres when
// it came back: while a leg waits on a train, if the page hasn't asked for 70 s, the feed is started again)
const kick = async () => { const a = await c.ev(`__trainsAge()`); if (a > 70) { log('trains not asked for in', Math.round(a), 's: feed restarted'); await c.ev(`__bay3d.rail.stop(); __bay3d.rail.start()`); await sleep(6000); } };
async function leg(name) {
  await c.ev(`__thaw()`); await c.ev(`__bay3d.leaveRide()`);
  if (name === 'open' || name === 'walk' || name === 'met') { await viewAt(V[name === 'open' ? 'open' : name === 'walk' ? 'herald' : 'met']); await sleep(9000); await c.ev(`__freeze()`); await settle(1500); return; }
  // the F: F1 a northbound train found up to 2.4 km short of Bergen St (F20), run on by the page in real time till she's
  // at Bergen St; F2 another one found short of 34 St-Herald Sq (D17), run on till she's a shot's length short of it.
  // The clock is stopped there each time, and while it's stopped she's carried on along her route at a subway's pace
  // (__trainPlan). (Reports jump a stop at a time, so she's put back to the mark if one carried her past it.)
  if (name === 'F1' || name === 'F2') {
    const stopId = name === 'F1' ? 'F20' : 'D17', stopName = name === 'F1' ? 'Bergen St' : '34 St-Herald Sq'; let F = null;
    for (let i = 0; i < 180 && !F; i++) {
      await kick();
      const fs_ = await J(`__bay3d.rail.list().filter(t => t.rail === 'F train' && /\\.\\.N/.test(t.id)).map(t => ({ id: t.id, lat: t.lat, lon: t.lon }))`);
      for (const t of fs_) {
        const key = t.id.split('_').slice(1).join('_'), sh = SUB.shapes[key]; if (!sh) continue;
        const sS = sh.s.find(x => x[0] === stopId)?.[1]; if (sS == null) continue;
        const pr = project(sh.p, t.lon, t.lat);
        if (pr.d < 80 && pr.s > sS - 2400 && pr.s <= sS - 400) { F = { id: t.id, key, sS, pts: sh.p, cum: cumOf(sh.p) }; log(name, t.id, Math.round(sS - pr.s), 'm short of', stopName); break; }
      }
      if (!F) { if (i % 6 === 0) log(name, 'waiting for an F coming up to', stopName); await sleep(10000); }
    }
    if (!F) throw new Error('no F for ' + name); her[name] = F;
    const sg = segs.find(x => x.leg === name), target = name === 'F1' ? F.sS - 40 : F.sS - FV * (sg.t1 - sg.t0) - 10;
    for (let i = 0; ; i++) {
      await kick(); const t = await J(`__bay3d.rail.list().find(t => t.id === ${JSON.stringify(F.id)})`); if (!t) throw new Error('lost the F');
      const pr = project(F.pts, t.lon, t.lat);
      if (pr.s >= target) { if (pr.s - target > 50) log(name, 'overshot by', Math.round(pr.s - target), 'm, put back'); plan = { id: F.id, pts: F.pts, cum: F.cum, s0: target, v: FV }; break; }
      if (i % 15 === 0) log(name, Math.round(target - pr.s), 'm to go');
      if (i > 900) throw new Error('the F stopped');
      await sleep(2000);
    }
    await c.ev(`window.__trainPlan = ${JSON.stringify(plan)}`); await c.ev(`__freeze()`); log(name, 'stopped the clock');
    await syncTrain(); return;   // (take 5: without it the cab showed her last report's place, a stop off: the page asks every 30 s)
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
// (take 6: she was never drawn where she was put. The page takes a report only 5 s newer, by its clock, than the last
// it took, and the clock's stopped; and a report that jumps her back turns her round. So: put her 110 m short, run the
// clock on 5.5 s (she's carried on 55 m) and wait for the page to ask and take it; then 5.5 s more, and the next one,
// 55 m on, gives her her heading and pace. She's then where she was to be. The page asks every 30 real seconds.)
async function syncTrain() {
  const P = window_plan(); const target = P.s0; P.s0 = target - P.v * 11; await c.ev(`window.__trainPlan = ${JSON.stringify(P)}`);
  for (const pass of [1, 2]) {
    await c.ev(`__step(5500)`);
    let d = Infinity;
    for (let k = 0; k < 50; k++) {
      const t = await J(`__bay3d.rail.list().find(t => t.id === ${JSON.stringify(P.id)})`), [lo, la] = planAt(await c.ev(`__trainS()`));
      d = t ? Math.hypot(...mxy([lo, la], [t.lon, t.lat])) : Infinity;
      if (d < 25) break;
      await sleep(1000);
    }
    log('F drawn', Math.round(d), 'm off, pass', pass);
  }
}
const window_plan = () => plan;
const ride = async (id, mode) => { const r = await c.ev(`__bay3d.rideMover(${JSON.stringify(id)}, '${mode}')`); if (r !== id) log('ride failed', id, mode, r); };
const rideShip = async (mmsi, mode) => { const r = await c.ev(`__bay3d.rideShip(${JSON.stringify(String(mmsi))}, '${mode}')`); if (r !== String(mmsi)) log('ride failed', mmsi, mode, r); };

fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const marks = [], dt = 1 / FPS; let nf = 0, cur = '', curLeg = '';
for (let f = 0; f * dt <= LEN; f++) {
  const t = f * dt, sg = segs.find(s => t < s.t1) || segs.at(-1);
  for (const s of segs) if (Math.abs(t - s.say) < dt / 2 + 1e-9) marks.push({ name: s.k, t });
  if (SPLICE && !WALK[sg.s]) {   // (not a walk: the earlier take's frame at the same point in the shot)
    const os = oldSegs[segs.indexOf(sg)], src = `${SPLICE}/${String(Math.min(Math.round((os.t0 + (t - sg.t0)) * FPS), Math.round(os.t1 * FPS) - 1)).padStart(5, '0')}.jpg`;
    fs.copyFileSync(src, `${OUT}/${String(nf++).padStart(5, '0')}.jpg`); cur = ''; continue;
  }
  if (sg.leg !== curLeg) { curLeg = sg.leg; log('leg', curLeg); await leg(curLeg); }
  if (sg.s !== cur) {   // (a cut: the new shot set up, and a look first so its ground and streets are in)
    cur = sg.s; log('shot', cur);
    if (cur === 'fcab1') await ride(plan.id, 'helm');
    if (cur === 'fcab2') await ride(plan.id, 'helm');
    if (cur === 'shelm') await rideShip(her.ferry.mmsi, 'helm');
    if (cur === 'sdrone') await rideShip(her.ferry.mmsi, 'drone');
    if (cur === 'bahead') await ride(her.bus.id, 'bow');
    if (cur === 'bcab') await ride(her.bus.id, 'helm');
    piece = -1; if (WALK[cur]) await eyeAt(cur, 0); else await c.ev(`__bay3d.walkEye(null)`);
    await settle(1200);
  }
  const k = (t - sg.t0) / (sg.t1 - sg.t0);
  if (WALK[cur]) await eyeAt(cur, k);
  if (cur === 'open' || cur === 'end') { const v = V[cur === 'end' ? 'met' : cur]; await c.ev(`__bay3d.setView(${JSON.stringify({ ...v, dist: v.dist * ((cur === 'end' ? 1.25 : 1) - 0.08 * k), az: v.az + 8 * k })})`); }
  await c.ev(`__step(${1000 / FPS})`);
  if (t - sg.t0 < 0.1) for (let w = 0; w < 40 && await c.ev(tilesBusy); w++) await sleep(150);
  const r = await c.cmd('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  fs.writeFileSync(`${OUT}/${String(nf++).padStart(5, '0')}.jpg`, Buffer.from(r.result.data, 'base64'));
  if (f % (FPS * 5) === 0) log('t', t.toFixed(1), sg.k, cur);
}
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({ fps: FPS, frames: nf, marks, her }));
log('done', nf, 'frames');
process.exit(0);
