// Records "New York's buses, live" (v1201, asked: "create a video that highlights recent improvements with the display
// of busses in Birdseye"): the city's buses from above, the Buses table and its search, then riding an M104 up
// Broadway from each side (Drone, Side, Ahead, Behind, Cab), on a stopped clock stepped one frame at a time (shim.js
// replays the feeds moved on at their real speeds, the buses too).
//   node record.mjs [outdir] [fps]      needs Chrome on :9567 (headless, --use-angle=metal --enable-gpu: SwiftShader
//   takes 7 s a frame over New York, the GPU 0.3) and a www/ server on :8791
// Writes the narration (narr.json), voices it with Piper (../overview-demo/tts.py: it stops on any word not yet
// checked), times the shots to it, records frames → <outdir>/NNNNN.jpg and <outdir>/meta.json; build.py makes the video.
import fs from 'fs';
import { execFileSync } from 'child_process';
import { connect, sleep } from '../live-tour/cdp.mjs';
const OUT = process.argv[2] || 'rec', FPS = +(process.argv[3] || 24);
const c = await connect(9567);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const J = async x => { const r = await c.ev(`JSON.stringify(${x})`); try { return JSON.parse(r); } catch (_) { throw new Error(`page: ${x} -> ${r}`); } };
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync('shim.js', 'utf8') });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8791/bay3d.html?region=new-york-harbor' });
for (let i = 0; i < 90; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
await sleep(8000);
await c.ev(`document.getElementById('livebtn').click()`);
// the buses in, and their speeds (two reports each: Bus Time is asked every 30 s)
for (let i = 0; i < 200; i++) {
  await sleep(1000);
  const s = await J(`{ b: __bay3d.rail.busCount || 0, k: __bay3d.rail.items().filter(p => p.mta && p.vKnown).length }`);
  if (i % 15 === 0) log('waiting', JSON.stringify(s));
  if (s.b > 500 && s.k > 300 && i > 70) break;
}
const V0 = { lat: 40.7905, lon: -73.9745, dist: 2600, az: 25, tilt: 58 };   // the Upper West Side, up Broadway
await c.ev(`__bay3d.setView(${JSON.stringify(V0)})`); await sleep(15000);
// her: an M104 going up Broadway to West Harlem, moving, nearest the middle of the view (else an M7 or M5)
const pick = await J(`(() => { const cp = __bay3d.camera.position;
  const all = __bay3d.rail.items().filter(p => p.mta && p.vKnown && p.v > 3 && p.v < 14 && /^M(104|7|5)$/.test(p.route) && /HARLEM|WASHINGTON|129|147/.test(p.a?.dest || ''));
  all.sort((a, b) => (a.route !== 'M104') - (b.route !== 'M104') || Math.hypot(a.x - cp.x, a.z - cp.z) - Math.hypot(b.x - cp.x, b.z - cp.z));
  const p = all[0]; return p ? { id: p.id, route: p.route, dest: p.a.dest, v: p.v, n: __bay3d.rail.busCount, trip: p.b.trip, dir: p.b.dir } : null; })()`);
if (!pick) { log('no M104, M7 or M5 heading uptown just now'); process.exit(4); }
log('her', JSON.stringify(pick));
await c.ev(`(()=>{ const st=document.createElement('style'); st.textContent='#loading,#help{display:none!important}'; document.head.appendChild(st); })()`);
// her route's line (shape.py, from the MTA's timetables: GTFS=<dir of its zips>), for the shim to carry her along
const path = JSON.parse(execFileSync('python3', ['shape.py', process.env.GTFS || 'gtfs', pick.trip, pick.route, String(pick.dir ?? 0)]).toString());
await c.ev(`window.__busPath = ${JSON.stringify({ id: pick.id, pts: path })}`); log('her route', path.length, 'points');
await c.ev(`__freeze()`);
const tilesBusy = `__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`;
const settle = async (ms = 900) => { for (let k = 0; k < ms / 150; k++) { await c.ev(`__step(150)`); for (let w = 0; w < 60 && await c.ev(tilesBusy); w++) await sleep(150); } };
// a look at each shot first, so their ground and streets are in
for (const m of ['drone', 'side', 'helm']) { await c.ev(`__bay3d.rideMover(${JSON.stringify(pick.id)}, '${m}')`); await settle(); await sleep(6000); await settle(); }
await c.ev(`__bay3d.leaveRide()`); await c.ev(`__bay3d.setView(${JSON.stringify(V0)})`); await settle();

// ── the narration ──
const say = r => r.replace(/^M(\d)(\d)(\d)$/, (m, a, b, d) => `M ${a} ${b === '0' ? 'oh' : b} ${d}`).replace(/^M(\d)$/, 'M $1');   // (M104: "M one oh four")
const title = t => t.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\bVia\b/g, 'via').replace(/\b(\d+) St\b/g, '$1th Street').replace(/\b1th\b/g, '1st').replace(/\b2th\b/g, '2nd').replace(/\b3th\b/g, '3rd').replace(/\b(1[123])(st|nd|rd)\b/g, '$1th');
const where = title(pick.dest.split(' via ')[0]), way = (pick.dest.split(' via ')[1] || '').toLowerCase();
const n = Math.round(pick.n / 100) * 100;
const narr = {
  a: `This is Ted's Birdseye, over Manhattan's Upper West Side. Every New York City bus is here, live, from the M T A's Bus Time feed: about ${n.toLocaleString('en-US')} of them right now.`,
  b: 'They have a table of their own now. Pick a route, or search: type Harlem, and up come the buses bound there, nearest first, each with where it is going.',
  c: `Here's an ${say(pick.route)}, heading up ${/broadway/.test(way) || pick.route !== 'M7' ? 'Broadway' : 'the avenue'} to ${where}. The streets are drawn now: asphalt, lane lines and crosswalks, and Broadway's planted center mall, with its trees and benches.`,
  d: "From across the street, she's a real New York City bus: a forty-foot New Flyer Excelsior, in the M T A's white and blue.",   // ("a real M T A bus": Piper says the A as an article)
  e: "Her destination sign shows her own route, and where she's bound, from the M T A's timetables.",
  f: 'She keeps to the right, in her own lane. Along the curbs: crosswalk ramps, fire hydrants, street lights and parking meters, and the city\'s real bus shelters, newsstands and subway entrances.',
  g: 'And you can ride up front, in the driver\'s seat.',
  h: "Ted's Birdseye. New York's buses, live.",
};
fs.writeFileSync('narr.json', JSON.stringify(narr, null, 1));
log('narration written; voicing');
try { execFileSync('../piper/bin/python', ['-I', '../overview-demo/tts.py', 'narr.json', 'en_US-ryan-high', 'narr', ...(process.argv.includes('--accept') ? ['--accept'] : [])], { stdio: 'inherit' }); }
catch (e) { log('narration has an unchecked word: check narr.json above, then rerun'); process.exit(2); }
const D = JSON.parse(fs.readFileSync('narr/durations.json', 'utf8'));

// ── the shots, timed to it: [narration, shot, seconds more] ──
const SHOTS = [['a', 'over', 1.5], ['b', 'table', 2.5], ['c', 'drone', 1.2], ['d', 'side', 1.2], ['e', 'bow', 1.5], ['f', 'stern', 1.2], ['g', 'helm', 2.5], ['h', 'end', 2.5]];
let T = 0; const segs = SHOTS.map(([k, s, x], i) => { const lead = i === 0 ? 0.8 : 0.9, seg = { k, s, t0: T, say: T + lead, t1: T + lead + D[k] + x }; T = seg.t1; return seg; });
const LEN = T; log('length', LEN.toFixed(1), 's');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const marks = [], dt = 1 / FPS; let nf = 0, cur = '';
const SEARCH = 'harlem';
for (let f = 0; f * dt <= LEN; f++) {
  const t = f * dt, sg = segs.find(s => t < s.t1) || segs.at(-1);
  for (const s of segs) if (Math.abs(t - s.say) < dt / 2 + 1e-9) marks.push({ name: s.k, t });
  if (sg.s !== cur) {   // (a cut: the new shot set up)
    const was = cur; cur = sg.s;
    if (was === 'table') await c.ev(`(()=>{ const i=document.querySelector('#underway .bussearch input'); if(i){i.value='';i.dispatchEvent(new Event('input'));} document.getElementById('underwaybtn').click(); })()`);
    if (cur === 'over' || cur === 'end') { await c.ev(`__bay3d.leaveRide()`); await c.ev(`__bay3d.setView(${JSON.stringify(cur === 'end' ? { ...V0, dist: 3200 } : V0)})`); }
    if (cur === 'table') await c.ev(`(()=>{ document.getElementById('underwaybtn').click(); document.querySelector('#underway .uwtabs [data-tab=bus]').click(); })()`);
    if (['drone', 'side', 'bow', 'stern', 'helm'].includes(cur)) { const r = await c.ev(`__bay3d.rideMover(${JSON.stringify(pick.id)}, '${cur}')`); if (r !== pick.id) log('ride failed', cur, r); }
  }
  if (cur === 'over' || cur === 'end') await c.ev(`__bay3d.setView(${JSON.stringify({ ...V0, dist: (cur === 'end' ? 3200 : V0.dist) * (1 - 0.06 * (t - sg.t0) / (sg.t1 - sg.t0)), az: V0.az + 6 * (t - sg.t0) / (sg.t1 - sg.t0) })})`);   // (a slow drift in)
  if (cur === 'table') {   // the search typed, a letter at a time, from three seconds in
    const k = Math.max(0, Math.min(SEARCH.length, Math.floor((t - sg.say - 3) / 0.18)));
    await c.ev(`(()=>{ const i=document.querySelector('#underway .bussearch input'); const v=${JSON.stringify(SEARCH)}.slice(0,${k}); if(i && i.value!==v){i.value=v;i.dispatchEvent(new Event('input'));} })()`);
  }
  await c.ev(`__step(${1000 / FPS})`);
  if (t - sg.t0 < 0.1) for (let w = 0; w < 40 && await c.ev(tilesBusy); w++) await sleep(150);   // (after a cut only: the wide views always have a tile coming)
  const r = await c.cmd('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  fs.writeFileSync(`${OUT}/${String(nf++).padStart(5, '0')}.jpg`, Buffer.from(r.result.data, 'base64'));
  if (f % (FPS * 5) === 0) log('t', t.toFixed(1), sg.k, cur);
}
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({ fps: FPS, frames: nf, marks, her: pick }));
log('done', nf, 'frames');
process.exit(0);
