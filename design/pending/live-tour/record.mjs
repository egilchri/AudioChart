// Records "San Francisco Bay, live": a narrated tour of whatever's flying, running and sailing right now, frame by
// frame on a stopped clock (shim.js replays the live feeds moved on at their real speeds).
//   node record.mjs [outdir] [fps]      needs Chrome on :9567 and a www/ server on :8793
// It picks its subjects from the live data (a plane coming in to SFO, a moving Caltrain, a SMART train, the fastest
// ferry), writes the narration about them (narr.json), voices it with Piper (../overview-demo/tts.py, which stops
// on any word not yet checked), times the shots to the narration, then records. Frames → <outdir>/NNNNN.jpg, the
// narration's start times → <outdir>/meta.json; build.py makes the video.
import fs from 'fs';
import { execFileSync } from 'child_process';
import { connect, sleep } from './cdp.mjs';
const OUT = process.argv[2] || 'rec', FPS = +(process.argv[3] || 24), ONLY = process.argv.slice(4).find(a => /^[0-9.]+,[0-9.]+$/.test(a));
const c = await connect(9567);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const J = async x => { const r = await c.ev(`JSON.stringify(${x})`); try { return JSON.parse(r); } catch (_) { throw new Error(`page: ${x} -> ${r}`); } };
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync('shim.js', 'utf8') });
try { await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true }); } catch (_) {}
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
// Live on (?ais= starts it), then everything in: ships, aircraft, trains, and a Caltrain's speed (two reports, 90 s apart)
for (let i = 0; i < 300; i++) {
  await sleep(1000);
  const s = await J(`{ v: window.__live?.().length || 0, a: __bay3d.air.count, t: __bay3d.rail.count, ct: __bay3d.rail.list().filter(t => t.rail === 'Caltrain' && t.v > 4 && t.v < 35 && t.lat > 37.45).length }`);
  if (i % 15 === 0) log('waiting', JSON.stringify(s));
  if (s.v > 20 && s.a > 15 && s.ct > 0) break;
}
const V0 = await J(`__bay3d.getView()`);   // the whole bay, as it opens
await c.ev(`(async()=>{
  const st=document.createElement('style'); st.textContent='.panel,#help,#loading,#clockbtn,#findbtn,#underwaybtn{display:none!important} #fakeptr{position:fixed;z-index:99;pointer-events:none;width:22px;height:22px;margin:-2px 0 0 -3px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}';
  document.head.appendChild(st);
  const p=document.createElement('div'); p.id='fakeptr'; p.innerHTML='<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 1 L2 18 L6.5 13.8 L9.6 20.5 L12.4 19.3 L9.4 12.8 L15.5 12.8 Z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  p.style.left='1400px'; p.style.top='800px'; document.body.appendChild(p);
  // where the camera looks for each kind of shot: a fixed view, or following a plane, a train or a ship as drawn now
  const B=__bay3d, rect=()=>B.renderer?.domElement?.getBoundingClientRect?.()||document.querySelector('#scene canvas').getBoundingClientRect();
  window.__viewFor = s => {
    if (s.kind==='fixed') return s.view;
    if (s.kind==='plane') { const a=B.air.list(B.camera, rect()).find(a=>a.hex===s.hex); if(!a) return null;
      // the camera sits D back from the view's ground point at tilt T: put it s.back behind her, s.up above her
      const T=s.tilt*Math.PI/180, az=(a.trk??0)+s.daz, D=(a.y+s.up)/Math.cos(T), ahead=D*Math.sin(T)-s.back, r=az*Math.PI/180;
      return { lat:a.at.lat+ahead*Math.cos(r)/111120, lon:a.at.lon+ahead*Math.sin(r)/(111320*Math.cos(a.at.lat*Math.PI/180)), dist:D, az, tilt:s.tilt, sx:a.sx, sy:a.sy }; }
    if (s.kind==='train') { const t=B.rail.list(B.camera, rect()).find(t=>t.id===s.id); if(!t) return null;
      return { lat:t.lat, lon:t.lon, dist:s.dist, az:t.h+s.daz, tilt:s.tilt, sx:t.sx, sy:t.sy }; }
    if (s.kind==='ship') { const v=(window.__live?.()||[]).find(v=>v.mmsi===s.mmsi); if(!v) return null;
      return { lat:v.lat, lon:v.lon, dist:s.dist, az:s.az, tilt:s.tilt }; }
  };
})()`);

// ── the subjects, from what's live now ──
const SFO = [37.6189, -122.375];
const AIRLINE = { UAL: 'United', SWA: 'Southwest', ASA: 'Alaska', AAL: 'American', DAL: 'Delta', SKW: 'SkyWest', JBU: 'JetBlue', FDX: 'FedEx', HAL: 'Hawaiian', FFT: 'Frontier', NKS: 'Spirit', UPS: 'UPS' };
const km = (lat, lon, [la, lo]) => Math.hypot((lon - lo) * 111.32 * Math.cos(la * Math.PI / 180), (lat - la) * 111.12);
const flightWords = f => {   // "UAL1954" → "United 19 54" (said "nineteen fifty-four"), "SWA803" → "Southwest 8 oh 3"
  const m = /^([A-Z]{3})(\d{1,4})$/.exec(f || ''); if (!m || !AIRLINE[m[1]]) return null;
  const n = m[2].replace(/^0+/, ''), pair = s => s === '00' ? 'hundred' : s[0] === '0' ? `oh ${s[1]}` : s;
  return `${AIRLINE[m[1]]} ${n.length <= 2 ? n : n.length === 3 ? `${n[0]} ${pair(n.slice(1))}` : `${n.slice(0, 2)} ${pair(n.slice(2))}`}`;
};
const air = (await J(`__bay3d.air.list()`)).filter(a => !a.ground && flightWords(a.flight));
const plane = air.filter(a => a.alt >= 2200 && a.alt <= 7000 && (a.vr ?? 0) < -200 && km(a.lat, a.lon, SFO) < 30)
  .sort((a, b) => Math.abs(a.alt - 3800) - Math.abs(b.alt - 3800))[0]
  || air.filter(a => a.alt >= 2200 && a.alt <= 9000).sort((a, b) => km(a.lat, a.lon, SFO) - km(b.lat, b.lon, SFO))[0];
const trains = await J(`__bay3d.rail.list()`);
const train = trains.filter(t => t.rail === 'Caltrain' && t.v > 4 && t.v < 35 && t.lat > 37.45).sort((a, b) => b.lat - a.lat)[0];
const smart = trains.filter(t => t.rail === 'SMART').sort((a, b) => b.v - a.v)[0];
const ships = (await J(`window.__live()`)).filter(v => /ferry/i.test(v.what || '') && v.sog >= 10 && v.sog <= 38).sort((a, b) => b.sog - a.sog);
const ship = ships[0];
if (!plane || !train) { log('no plane or train to follow', JSON.stringify({ plane: !!plane, train: !!train })); process.exit(4); }
log('subjects', plane.flight, plane.alt, 'ft', '|', train.id, train.dest, train.v, 'm/s', '|', smart?.id, smart?.dest, '|', ship?.name, ship?.sog);
const counts = await J(`{ s: window.__live().length, a: __bay3d.air.count, t: __bay3d.rail.count }`);
// the clock stops now, as they are: the tiles, the narration and the voicing all happen in no time at all (a gap
// here moved every plane on by minutes at the first frame: AAL517 was "coming down through 3,200 feet" at 500)
await c.ev(`__freeze()`);
const settle = async (ms = 450) => { for (let k = 0; k < ms / 150; k++) { await c.ev(`__step(150)`); for (let w = 0; w < 60 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(150); } };

// ── tiles first: a slow look at each subject in real time ──
const roundTo = (x, n) => Math.round(x / n) * n;
const spec = {
  whole: { kind: 'fixed', view: V0 },
  live: { kind: 'fixed', view: { ...V0, dist: V0.dist * 0.92 } },
  plane: { kind: 'plane', hex: plane.hex, back: 360, up: 110, daz: 12, tilt: 72 },
  sfo: { kind: 'fixed', view: { lat: 37.6175, lon: -122.382, dist: 5200, az: 300, tilt: 58 } },
  train: { kind: 'train', id: train.id, dist: 700, daz: 35, tilt: 60 },
  train2: { kind: 'train', id: train.id, dist: 1200, daz: -40, tilt: 58 },
  smart: smart ? { kind: 'train', id: smart.id, dist: 900, daz: 30, tilt: 60 } : null,
  ship: ship ? { kind: 'ship', mmsi: ship.mmsi, dist: 1400, az: (ship.cog ?? 0) + 30, tilt: 63 } : null,
};
for (const k of Object.keys(spec)) { if (!spec[k]) continue; const v = await J(`__viewFor(${JSON.stringify(spec[k])})`); if (v) { await c.ev(`__bay3d.setView(${JSON.stringify(v)})`); await settle(); } }
await c.ev(`__bay3d.setView(${JSON.stringify(V0)})`); await settle();

// ── the narration, about them ──
const toward = d => /san francisco/i.test(d) ? 'bound for San Francisco' : /san jose|tamien|gilroy/i.test(d) ? 'heading south for San Jose' : d ? `bound for ${d}` : 'on its way';
const mph = Math.round(train.v * 2.237 / 5) * 5;
const trainNo = String(train.trip || '').replace(/^(\d)(\d\d)$/, '$1 $2');
const narr = {
  a: "This is Ted's Birdseye, over San Francisco Bay, and everything moving down there is real, right now.",
  b: `The Live button brings in three feeds at once: ships from their AIS, aircraft from ADS-B, and trains from five one one. Up here it counts them: ${counts.s} ships, ${counts.a} aircraft and ${counts.t} trains.`,
  c: `Here's ${flightWords(plane.flight)}, ${(plane.vr ?? 0) < -200 ? 'coming down through' : 'at'} ${roundTo(plane.alt, 100).toLocaleString('en-US')} feet${km(plane.lat, plane.lon, SFO) < 30 && (plane.vr ?? 0) < -200 ? ' for San Francisco International' : ''}. Every airliner broadcasts its position, height and speed about once a second. That's ADS-B, the air's version of a ship's AIS.`,
  d: 'Hover over a plane and its label appears: the flight, and its height. The thin line drops to the ground, so you can judge how high it is. Click it, and the label stays.',
  e: "At the airport, the jets taxiing and parked show up too, without labels, so the field doesn't turn into a wall of writing.",
  f: `Now the trains. This is Caltrain ${trainNo}, ${toward(train.dest)}, at about ${mph} miles an hour. Trains don't broadcast like planes, so their positions come from the railroads, through five one one dot org.`,
  g: 'Five one one only lets us ask every minute and a half, so between reports the app keeps each train rolling at its last speed and heading. When a fresh report comes in, it eases into place.',
  ...(smart ? { h1: `Up in Marin, a SMART train is ${/windsor|larkspur|santa rosa|petaluma|san rafael/i.test(smart.dest) ? `heading for ${smart.dest}` : 'on its way'}.` } : {}),
  ...(ship ? { h2: `And on the water, a ferry is making ${Math.round(ship.sog)} knots, from her own AIS.` } : {}),
  j: 'Ships, planes and trains, all on one map, all live. A living map of the bay.',
};
fs.writeFileSync('narr.json', JSON.stringify(narr, null, 1));
log('narration written; voicing');
try { execFileSync('../piper/bin/python', ['-I', '../overview-demo/tts.py', 'narr.json', 'en_US-ryan-high', 'narr'], { stdio: 'inherit' }); }
catch (e) { log('narration has an unchecked word: check narr.json above, then rerun'); process.exit(2); }
const D = JSON.parse(fs.readFileSync('narr/durations.json', 'utf8'));

// ── the shots, timed to the narration: [narration key, shot, extra seconds] ──
const SHOTS = [['a', 'whole', 1.2], ['b', 'live', 1.0], ['c', 'plane', 1.0], ['d', 'plane', 1.6], ['e', 'sfo', 1.0], ['f', 'train', 1.0], ['g', 'train2', 1.0],
  ...(smart ? [['h1', 'smart', 1.2]] : []), ...(ship ? [['h2', 'ship', 1.2]] : []), ['j', 'whole', 3.0]];
let T = 0; const segs = SHOTS.map(([k, s, x]) => { const lead = s === SHOTS[0][1] && T === 0 ? 0.6 : 1.4, seg = { k, s, t0: T, say: T + lead, t1: T + lead + D[k] + x }; T = seg.t1; return seg; });
const LEN = T, TR = 3.2;   // seconds to fly from one shot to the next
log('length', LEN.toFixed(1), 's');

// the pointer: off-screen, to the Live button for b, onto the plane for d (a real hover, so her label shows), then away
const liveBtn = await J(`(r => ({ x: r.left + r.width * 0.55, y: r.top + r.height * 0.6 }))(document.getElementById('livebtn').getBoundingClientRect())`);
let ptr = { x: 1330, y: 760 };
const mix = (a, b, u) => a + (b - a) * u, ease = u => u * u * (3 - 2 * u);
const blend = (a, b, u) => ({ lat: mix(a.lat, b.lat, u), lon: mix(a.lon, b.lon, u), dist: Math.exp(mix(Math.log(a.dist), Math.log(b.dist), u)),
  az: a.az + ((((b.az - a.az) % 360) + 540) % 360 - 180) * u, tilt: mix(a.tilt, b.tilt, u) });

fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const [T0, T1] = ONLY ? ONLY.split(',').map(Number) : [0, LEN];
const marks = [], dt = 1 / FPS; let n = 0, lastV = V0, pinned = false, trainPinned = false;
for (let f = 0; f * dt <= LEN; f++) {
  const t = f * dt, i = segs.findIndex(s => t < s.t1 || s === segs[segs.length - 1]), sg = segs[i];
  for (const s of segs) if (Math.abs(t - s.say) < dt / 2 + 1e-9 && t >= T0 - 1e-9 && t <= T1) marks.push({ name: s.k, t: t - T0 });
  // the view: this shot's, flown into from the last shot's over the first TR seconds
  let v = await J(`__viewFor(${JSON.stringify(spec[sg.s])})`) || lastV;
  const u = i > 0 ? Math.min(1, (t - sg.t0) / TR) : 1;
  if (u < 1 && segs[i - 1].s !== sg.s) { const p = await J(`__viewFor(${JSON.stringify(spec[segs[i - 1].s])})`) || lastV; v = { ...blend(p, v, ease(u)), sx: v.sx, sy: v.sy }; }
  lastV = v;
  await c.ev(`__bay3d.setView(${JSON.stringify({ lat: v.lat, lon: v.lon, dist: v.dist, az: v.az, tilt: v.tilt })})`);
  // the pointer
  let want = { x: 1330, y: 760 };
  if (sg.k === 'b' && t > sg.say + 3) want = liveBtn;
  if (sg.k === 'd' && v.sx != null) want = { x: v.sx + 2, y: v.sy + 2 };
  const k = sg.k === 'd' && t > sg.say + 1.6 ? 1 : 0.09;   // (glides there, then stays on her)
  ptr = { x: mix(ptr.x, want.x, k), y: mix(ptr.y, want.y, k) };
  await c.ev(`(p=>{p.style.left='${ptr.x.toFixed(1)}px'; p.style.top='${ptr.y.toFixed(1)}px';})(document.getElementById('fakeptr'))`);
  await c.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.max(0, Math.min(1279, ptr.x)), y: Math.max(0, Math.min(719, ptr.y)), buttons: 0 });
  if (sg.k === 'd' && t > sg.t1 - 0.5 && !pinned) { pinned = true; await c.ev(`__bay3d.air.pin(${JSON.stringify(plane.hex)})`); }
  if (sg.s === 'train' && !trainPinned) { trainPinned = true; await c.ev(`__bay3d.rail.pin(${JSON.stringify(train.id)})`); }
  if (sg.s === 'smart') await c.ev(`__bay3d.rail.pin(${JSON.stringify(smart.id)})`);
  await c.ev(`__step(${1000 / FPS})`);
  for (let w = 0; w < 40 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(150);
  if (t < T0 - 1e-9 || t > T1) continue;
  const r = await c.cmd('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  fs.writeFileSync(`${OUT}/${String(n++).padStart(5, '0')}.jpg`, Buffer.from(r.result.data, 'base64'));
  if (f % (FPS * 5) === 0) log('t', t.toFixed(1), sg.k);
}
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({ fps: FPS, frames: n, marks, subjects: { plane: plane.flight, train: train.id, smart: smart?.id, ship: ship?.name } }));
log('done', n, 'frames');
process.exit(0);
