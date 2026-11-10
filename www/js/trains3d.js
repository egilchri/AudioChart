// Live trains in Bird's-eye (v1099): Caltrain, SMART and ACE, from 511.org through the relay's GET /trains
// (relay/ais/core.mjs RAIL). 511 is asked at most every 90 s per railroad, so between reports each train runs on
// at the speed and heading of her last two positions (511's own bearing is always 0), for up to a minute, then
// waits for the next. On with 📡 Live; needs an internet connection. Her label shows only while the pointer is
// over her, or after a tap on her until the next (v1102, as the aircraft's since v1101).
import * as THREE from 'three';
import { relayUrl } from './ais.js';
import { labelSprite } from './aircraft3d.js';
import { makeCaltrain } from './caltrain3d.js';
import { makeSmart } from './smart3d.js';
import { makeAmtrak } from './amtrak3d.js';
import { minOfDay, bayDay } from './regiontime.js';

export const TRAIN_CREDIT = 'Trains from 511.org and Amtrak (via Amtraker)';
const DEG = Math.PI / 180;
const LONG = /starlight|zephyr|chief|sunset|eagle|builder|cardinal|crescent|limited/i;   // (Amtrak's long-distance trains: Superliners or their like)
// each railroad's train: cars, car length (m), and livery (body, band)
const LOOK = {
  Caltrain: { cars: 6, len: 26, body: 0xd8dadc, band: 0xc8102e },
  SMART: { cars: 2, len: 25, body: 0xf1f1ee, band: 0x2e8b57 },
  ACE: { cars: 6, len: 26, body: 0xe6e3ee, band: 0x5b2a86 },
  Amtrak: { cars: 5, len: 26, body: 0xc9cdd2, band: 0x1f3f7a },
};
function trainModel(look) {   // the cars in a line along -z (her front), 1 unit = 1 m
  const g = new THREE.Group(), body = new THREE.MeshLambertMaterial({ color: look.body }), band = new THREE.MeshLambertMaterial({ color: look.band });
  const roof = new THREE.MeshLambertMaterial({ color: look.band, emissive: look.band, emissiveIntensity: 0.45 });
  const L = look.len, gap = 1.2;
  for (let i = 0; i < look.cars; i++) {
    const z = i * (L + gap) - (look.cars - 1) * (L + gap) / 2;
    const car = new THREE.Mesh(new THREE.BoxGeometry(3.1, 4.6, L), body); car.position.set(0, 2.3 + 0.6, z); g.add(car);
    const b = new THREE.Mesh(new THREE.BoxGeometry(3.16, 0.7, L * 0.98), band); b.position.set(0, 1.6, z); g.add(b);
    const r = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, L * 0.96), roof); r.position.set(0, 5.26, z); g.add(r);   // (her roof in her colour: from above, silver on a grey city didn't show, v1105)
  }
  return g;
}
// (v1126, reported: "trains aren't always straight lines ... It follows the curve of the track") her cars, each on
// her own: the model's meshes (each material merged over her whole length) cut into one group per car, by each
// triangle's middle; a lone part (a decal, a simple car's box) by its place. spans: each car's [front, back] in z
function splitCars(model, spans) {
  const cars = spans.map(([a, b]) => { const c = new THREE.Group(); c.userData.zc = (a + b) / 2; c.userData.half = (b - a) / 2; c.position.z = c.userData.zc; return c; });
  const which = z => { let best = 0, bd = Infinity; spans.forEach(([a, b], i) => { const d = z < a ? a - z : z > b ? z - b : 0; if (d < bd) { bd = d; best = i; } }); return best; };
  for (const m of [...model.children]) {
    if (!m.isMesh) continue;
    const g = m.geometry;
    if (g.index || m.position.lengthSq() > 0 || spans.length < 2) { const c = cars[which(m.position.z)]; model.remove(m); m.position.z -= c.userData.zc; c.add(m); continue; }
    const P = g.attributes.position, n = P.count / 3, names = Object.keys(g.attributes), out = cars.map(() => Object.fromEntries(names.map(k => [k, []])));
    for (let t = 0; t < n; t++) {
      const i = which((P.getZ(t * 3) + P.getZ(t * 3 + 1) + P.getZ(t * 3 + 2)) / 3), o = out[i], zc = cars[i].userData.zc;
      for (const k of names) { const A = g.attributes[k], sz = A.itemSize; for (let v = t * 3; v < t * 3 + 3; v++) for (let q = 0; q < sz; q++) o[k].push(k === 'position' && q === 2 ? A.array[v * sz + q] - zc : A.array[v * sz + q]); }
    }
    model.remove(m); g.dispose();
    out.forEach((o, i) => {
      if (!o.position.length) return;
      const ng = new THREE.BufferGeometry(); for (const k of names) ng.setAttribute(k, new THREE.Float32BufferAttribute(o[k], g.attributes[k].itemSize));
      const nm = new THREE.Mesh(ng, m.material); nm.castShadow = m.castShadow; nm.receiveShadow = m.receiveShadow; cars[i].add(nm);
    });
  }
  model.add(...cars);
  return cars;
}
// "San Francisco Caltrain Station Northbound" -> "San Francisco"; "Stockton - Robert J Cabral Sta" -> "Stockton"
const place = d => (d || '').replace(/\s+(Caltrain\s+)?Station\b.*$/i, '').replace(/\s+-\s+.*$/, '').replace(/^SMART\s+/i, '').trim();
const lonOf = p => p.fix.lon + (p.x - p.fix.x) / (111320 * Math.cos(p.fix.lat * DEG)), latOf = p => p.fix.lat - (p.z - p.fix.z) / 111120;   // (where she's drawn now)
const hhmm = m => { m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`; };
// Her run (v1117, requested: "For the trains I need to know their destination, their origin, and the ETA"): the
// railroads' timetables (www/data/rail/<id>-trips.json, design/rail/build_trips.py), found by her trip (Caltrain's train
// number, SMART's GTFS trip id). How late she's running: 511's expected time at her next stop where it gives one, else
// where she is against where the timetable has her (between its stations, by distance); ETAs are the timetable's plus that.
// (v1121) a run from the relay's own times, for a railroad whose timetable we don't hold (Amtrak: Amtraker gives her
// origin, next stop and end with their scheduled and expected times)
function liveRun(a, nowMs) {
  const m = v => v ? minOfDay(v) : null, late = a.nextAim && a.nextExp ? (a.nextExp - a.nextAim) / 60000 : null;
  return { num: a.trip, from: place(a.from), fromT: m(a.fromAim), dest: place(a.dest), destT: m(a.destExp || a.destAim), sched: m(a.destAim),
    next: place(a.next), nextT: m(a.nextExp || a.nextAim), late, live: late != null, started: !(a.atStop && a.fromAim && nowMs < a.fromAim + 60e3), hhmm,
    // (a long-distance train ends days from now, the Zephyr in Chicago: her day, then)
    destDay: (() => { const t = a.destExp || a.destAim; return t && bayDay(t).getTime() !== bayDay(nowMs).getTime() ? bayDay(t).toLocaleDateString([], { weekday: 'short' }) + ' ' : ''; })() };
}
function runOf(a, run, nowMs) {
  const S = run.s, at = nowMs - (a.age || 0) * 1000;
  let now = minOfDay(at); if (now < S[0][3] - 720) now += 1440;   // (a run past midnight: GTFS counts on past 24:00)
  const kx = 111320 * Math.cos(a.lat * DEG), ky = 111120;
  let best = null;
  for (let i = 1; i < S.length; i++) {   // the stretch between two stations she's nearest, and how far along it
    const [, x1, y1, t1] = S[i - 1], [, x2, y2, t2] = S[i], dx = (x2 - x1) * kx, dy = (y2 - y1) * ky, L2 = dx * dx + dy * dy || 1;
    const f = Math.max(0, Math.min(1, ((a.lon - x1) * kx * dx + (a.lat - y1) * ky * dy) / L2)), d = Math.hypot((a.lon - x1) * kx - dx * f, (a.lat - y1) * ky - dy * f);
    if (!best || d < best.d) best = { d, i, f, t: t1 + (t2 - t1) * f };
  }
  let late = null;
  if (a.nextAim && a.nextExp) late = (a.nextExp - a.nextAim) / 60000;
  else if (best && best.d < 3000) late = now - best.t;
  // (waiting to start: on time; early, or over half an hour off: not to be trusted, the timetable may be out of date
  // (Caltrain on 2026-11-05 seemed 35 to 70 min behind the GTFS one), so the timetable's times are shown as they are)
  if (late != null && !(a.nextAim && a.nextExp) && (late < -2 || late > 30)) { late = late < -2 && now < S[0][3] ? 0 : null; }
  const wrap = m => m < S[0][3] - 720 ? m + 1440 : m;   // (on the timetable's count, past 24:00 after midnight)
  const lt = Math.max(0, late || 0), ni = best ? (best.f > 0.98 ? Math.min(best.i + 1, S.length - 1) : best.i) : 1;
  return { num: run.n, from: S[0][0], fromT: a.fromAim ? wrap(minOfDay(a.fromAim)) : a.nextAim && a.next && place(a.next) === S[0][0] ? wrap(minOfDay(a.nextAim)) : S[0][3], dest: S[S.length - 1][0],
    // (v1119: 511's own times first, now the relay passes them: the GTFS timetable here was Caltrain's of January, 5 to 43
    // min off her current one)
    destT: a.destExp ? wrap(minOfDay(a.destExp)) : S[S.length - 1][3] + lt, sched: a.destAim ? wrap(minOfDay(a.destAim)) : S[S.length - 1][3],
    next: a.next ? place(a.next) : S[ni][0], nextT: a.nextExp ? minOfDay(a.nextExp) : S[ni][3] + lt, late, live: !!(a.nextAim && a.nextExp), started: now >= S[0][3] - 0.5, hhmm };
}
const metres = (a, b) => Math.hypot((b.lon - a.lon) * 111320 * Math.cos(a.lat * DEG), (b.lat - a.lat) * 111120);

// Each train is also a 'vessel' to Bird's-eye's card, Follow and ride views (v1104): kind 'rail', as the aircraft's
// (aircraft3d.js), her cab at the front of her first car.
export function makeTrains({ scene, bbox, wx, wz, heightAt, every = 30000, onCount, focus = () => false, onDrop = () => {} }) {
  let trackY = null;   // (the drawn tracks' heights: track3d.js, v1125)
  const trains = new Map();   // id -> { a, g, model, label, fix, prev, v (m/s), h, x, z }
  let on = false, timer = null, inflight = null, hover = null;
  const pinned = new Set(), _v = new THREE.Vector3(), _cab = new THREE.Vector3();
  // the railway's tracks (v1116, reported: the Caltrains at 4th & King "weren't pointing down the tracks"; a train
  // standing at a platform had only a guess at her heading, south-east or north-west, and 4th & King's platforms run
  // south-west): OSM's main lines and their sidings (www/data/rail/, design/rail/build_rail.py), cut into segments in
  // a 250 m grid. Each train is laid on the nearest one within 40 m, pointing along it.
  const CELL = 250, grid = new Map(); let segs = null, trips = null;
  function setTracks(lines) {
    const S = []; grid.clear();
    for (const l of lines) for (let i = 1; i < l.length; i++) {
      const x1 = wx(l[i - 1][0]), z1 = wz(l[i - 1][1]), x2 = wx(l[i][0]), z2 = wz(l[i][1]), k = S.length / 4; S.push(x1, z1, x2, z2);
      const n = Math.ceil(Math.hypot(x2 - x1, z2 - z1) / (CELL / 2)) + 1;
      for (let j = 0; j <= n; j++) { const key = `${Math.floor((x1 + (x2 - x1) * j / n) / CELL)},${Math.floor((z1 + (z2 - z1) * j / n) / CELL)}`; const c = grid.get(key); if (!c) grid.set(key, [k]); else if (c[c.length - 1] !== k) c.push(k); }
    }
    segs = new Float64Array(S);
    for (const p of trains.values()) { p.ft = undefined; p.cur = null; }   // (laid on them afresh)
    // (v1121) where the pieces meet: each end (to 0.5 m) and the pieces that end there, so a train can be walked along
    // her track between reports, through its joins and junctions
    ends.clear();
    for (let k = 0; k < segs.length / 4; k++) for (const e of [0, 1]) { const key = endKey(segs[k * 4 + e * 2], segs[k * 4 + e * 2 + 1]); const c = ends.get(key); if (c) c.push(k * 2 + e); else ends.set(key, [k * 2 + e]); }
  }
  const ends = new Map(), endKey = (x, z) => `${Math.round(x * 2)},${Math.round(z * 2)}`;
  const segH = (k, dir) => { const dx = segs[k * 4 + 2] - segs[k * 4], dz = segs[k * 4 + 3] - segs[k * 4 + 1]; return (Math.atan2(dir * dx, -dir * dz) / DEG + 360) % 360; };
  // from piece k at t (0..1), going dir (+1 toward its second end), d metres along the track: where, and heading. At a
  // join it takes the piece going on straightest (the main line through a crossover); it stops at a track's end or a
  // turn of over 50° (a yard's ladder)
  function walk(k, t, dir, d) {
    for (let n = 0; n < 400; n++) {
      const x1 = segs[k * 4], z1 = segs[k * 4 + 1], dx = segs[k * 4 + 2] - x1, dz = segs[k * 4 + 3] - z1, L = Math.hypot(dx, dz) || 1e-9;
      const left = (dir > 0 ? 1 - t : t) * L;
      if (d <= left) { t += dir * d / L; return { x: x1 + dx * t, z: z1 + dz * t, h: segH(k, dir), k, t, dir }; }
      d -= left; t = dir > 0 ? 1 : 0;
      const h = segH(k, dir), ex = x1 + dx * t, ez = z1 + dz * t;
      let best = null, bt = 50;
      for (const ke of ends.get(endKey(ex, ez)) || []) {
        const k2 = ke >> 1, e = ke & 1; if (k2 === k) continue;
        const dir2 = e === 0 ? 1 : -1, turn = near(segH(k2, dir2), h);
        if (turn < bt) { bt = turn; best = [k2, e === 0 ? 0 : 1, dir2]; }
      }
      if (!best) {   // (no piece ends here: most such ends meet a track mid-piece, where a junction's node isn't one of its ends; 517 in the SF tracks)
        const m = onTrack(ex, ez, 3, k);
        if (m) for (const dir2 of [1, -1]) { const turn = near(segH(m.k, dir2), h); if (turn < bt) { bt = turn; best = [m.k, m.t, dir2]; } }
        if (best && best[0] === k) best = null;
      }
      if (!best) return { x: ex, z: ez, h, k, t, dir };
      [k, t, dir] = best;
    }
    return null;
  }
  // (v1127) a place on the track ({k, t, dir, x, z, h}: h her heading, dir her way along piece k) moved d metres on
  // (back, if d < 0, still facing her way); and how far on or back along her track (x, z) is from it, to 20 m
  const placeOf = ({ k, t, dir }) => ({ k, t, dir, x: segs[k * 4] + (segs[k * 4 + 2] - segs[k * 4]) * t, z: segs[k * 4 + 1] + (segs[k * 4 + 3] - segs[k * 4 + 1]) * t, h: segH(k, dir) });
  function step(c, d) {
    if (Math.abs(d) < 1e-6) return c;
    const w = d > 0 ? walk(c.k, c.t, c.dir, d) : walk(c.k, c.t, -c.dir, -d);
    return !w ? null : d > 0 ? w : { ...w, dir: -w.dir, h: (w.h + 180) % 360 };
  }
  function alongTo(c, x, z, max = 3000) {
    let best = null, bd = 60 * 60;
    for (const sg of [1, -1]) { let q = c; for (let d = 0; d <= max; d += 20) { if (d) { const n = step(q, sg * 20); if (!n) break; q = n; } const e = (q.x - x) ** 2 + (q.z - z) ** 2; if (e < bd) { bd = e; best = sg * d; } } }
    return best;
  }
  // the nearest track to (x, z): the point on it, and its two headings' first (°, as p.h: 0 north, 90 east)
  function onTrack(x, z, reach = 40, skip = -1) {
    if (!segs) return null;
    let best = null, bd = reach * reach; const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const k of grid.get(`${cx + i},${cz + j}`) || []) {
      if (k === skip) continue;
      const x1 = segs[k * 4], z1 = segs[k * 4 + 1], dx = segs[k * 4 + 2] - x1, dz = segs[k * 4 + 3] - z1, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / L2)), px = x1 + dx * t, pz = z1 + dz * t, d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < bd) { bd = d; best = { x: px, z: pz, h: (Math.atan2(dx, -dz) / DEG + 360) % 360, k, t }; }
    }
    return best;
  }
  const near = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
  function drop(p) { pinned.delete(p); if (hover === p) hover = null; trains.delete(p.id); onDrop(p); scene.remove(p.g); p.g.traverse(o => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); }); trains.delete(p.id); }
  function data(j) {
    const now = Date.now(), seen = new Set();
    for (const a of j.trains || []) {
      seen.add(a.id);
      let p = trains.get(a.id);
      if (!p) {
        // Caltrain: her Stadler KISS, modelled from photos (caltrain3d.js, v1107); SMART her Nippon Sharyo DMU (smart3d.js,
        // v1118: two cars, as most of her runs; 511 doesn't say); ACE, simple cars for now
        // Amtrak (v1122): the Charger and California Cars (amtrak3d.js). Her Charger at her Oakland and San Jose end
        // (v1123: v1122 had it at Sacramento's; a photo of eastbound 528 at Berkeley, January 2026, has her cab car
        // leading, headlights lit): pulling away from Sacramento, the cab car leading toward it. The long-distance trains
        // (the Coast Starlight, the Zephyr: v1124) their Superliners behind two ALC-42s
        const look = LOOK[a.rail] || LOOK.Caltrain, kiss = a.rail === 'Caltrain' ? makeCaltrain() : a.rail === 'SMART' ? makeSmart() : a.rail === 'Amtrak' ? makeAmtrak(LONG.test(a.line || '') ? { kind: 'long' } : { cars: 4, locoFront: !/sacramento|auburn/i.test(a.dest || '') }) : null;
        const g = new THREE.Group(), model = kiss ? kiss.group : trainModel(look), label = labelSprite();
        g.add(model, label); scene.add(g);
        const L = kiss ? kiss.length : look.cars * look.len + (look.cars - 1) * 1.2;
        g.userData.helm = kiss ? kiss.cab : [0, 3.6, -L / 2 + 1.6];   // (her cab: the front of her first car)
        const cars = splitCars(model, kiss?.spans || Array.from({ length: look.cars }, (_, i) => { const z = i * (look.len + 1.2) - (look.cars - 1) * (look.len + 1.2) / 2; return [z - look.len / 2, z + look.len / 2]; }));
        // (L sizes the ride views' distances: her whole 160 m put the drone 380 m back, end-on she was a post; as a
        // 45 m vessel it stands ~100 m off. len is her real length)
        p = { kind: 'rail', id: a.id, g, group: g, L: 45, len: L, y: 0, model, tag: label, x: wx(a.lon), z: wz(a.lat), h: a.dir === 'S' ? 135 : a.dir === 'N' ? 315 : 0, v: 0, placed: false, cars, helm0: g.userData.helm };
        trains.set(a.id, p);
      }
      const at = now - (a.age || 0) * 1000;
      // a new report: her speed and heading from the last one. (The relay asks 511 every 90 s, we ask it every 30: the
      // same report again comes back a second later by its rounded age, and was taken for a new one that hadn't moved,
      // so every train stopped between reports. v1106: only a report 5 s newer is new)
      if (!p.fix || at > p.fix.t + 5000) {
        if (p.fix) {
          const d = metres(p.fix, a), s = (at - p.fix.t) / 1000;
          if (a.mph == null) p.v = s > 5 && d / s < 50 ? d / s : 0;   // (a stand at a station is 0; a jump of over 50 m/s is no speed)
          if (s > 5) p.vKnown = true;   // (her speed needs two reports, 90 s apart: till then it isn't known, v1106)
          if (d > 30) { p.h = (Math.atan2((a.lon - p.fix.lon) * Math.cos(a.lat * DEG), a.lat - p.fix.lat) / DEG + 360) % 360; p.moved = true; p.seenMove = true; }
        }
        if (p.fix && at - p.fix.t < 15 * 60e3) p.gap = at - p.fix.t;   // (her reports' gap: how far ahead to run her on)
        p.fix = { lon: a.lon, lat: a.lat, x: wx(a.lon), z: wz(a.lat), t: at }; p.ft = undefined;
      }
      // Amtrak gives her speed and heading (to 45°) herself: known from her first report (v1121)
      if (a.mph != null) { p.v = a.mph / 2.237; p.vKnown = true; if (a.brg != null && a.mph > 2 && !p.seenMove) { p.h = a.brg; p.moved = true; } }
      p.a = a;
      const tr = trips?.[a.rail]?.[a.trip]; p.run = tr ? runOf(a, tr, now) : a.destAim || a.destExp ? liveRun(a, now) : null;
      const num = p.run?.num || (/^\d{1,4}$/.test(a.trip) ? a.trip : '');   // (Caltrain's train number; SMART's, from her timetable: her trip ids are long)
      p.dest = p.run?.dest || place(a.dest); p.from = p.run?.from || place(a.from) || '';
      p.tag.userData.draw(`${a.rail === 'Amtrak' && a.line ? a.line : a.rail} ${num} → ${p.dest || '?'}`.replace(/\s+/g, ' '));
      p.title = `${a.rail === 'Amtrak' && a.line ? a.line : a.rail} ${num}`.trim();   // (Amtrak's by her route: "Capitol Corridor 723")
      const speed = !p.vKnown ? '' : p.v >= 1 ? `about ${Math.round(p.v * 2.237)} mph` : 'stopped';
      p.label = p.run ? `${p.from} → ${p.dest}, ${p.run.late == null ? 'timetabled' : 'due'} ${p.run.destDay || ''}${hhmm(p.run.destT)}${p.run.late >= 2 ? ` (${Math.round(p.run.late)} min late)` : ''}${speed ? ` · ${speed}` : ''}`
        : `${speed ? speed[0].toUpperCase() + speed.slice(1) : 'Speed due in a minute or so'}${p.dest ? `, bound for ${p.dest}` : ''}`;
    }
    for (const p of [...trains.values()]) if (!seen.has(p.id)) drop(p);
    onCount?.(trains.size);
  }
  async function poll() {
    if (!on) return;
    const ctl = new AbortController(); inflight = ctl; const kill = setTimeout(() => ctl.abort(), 8000); let got = null;
    try {
      const r = await fetch(`${relayUrl()}/trains?bbox=${bbox.map(v => v.toFixed(3)).join(',')}`, { signal: ctl.signal, cache: 'no-store' });
      const j = await r.json(); if (on && r.ok) got = j;
    } catch (_) {} finally { clearTimeout(kill); if (inflight === ctl) inflight = null; }   // (the network's failures, quietly)
    try { if (got) data(got); } catch (e) { console.error('[live] couldn\'t take in the answer', e); }   // (ours, loudly: v1104 lost all but one plane a poll to a quiet one)
    if (on) timer = setTimeout(poll, every);
  }
  // her last report on her track: the piece, where along it, and which way she's going on it
  function fixOnTrack(p) {
    const tr = onTrack(p.fix.x, p.fix.z); if (!tr) return null;
    const ref = p.moved ? p.h : p.a.dir === 'S' ? 180 : p.a.dir === 'N' ? 0 : p.h;
    return { k: tr.k, t: tr.t, dir: near(segH(tr.k, 1), ref) <= near(segH(tr.k, -1), ref) ? 1 : -1 };
  }
  function update(dt, camera) {
    if (!trains.size) return;
    const now = Date.now(), cp = camera.position;
    for (const p of trains.values()) {
      // (v1121, asked: "you can achieve some optimizations by knowing that trains run on tracks") between reports she runs
      // on along her own track at her speed, round its curves, for up to 1.5 of her reports' gap (Amtrak's are ~5 min
      // apart: she'd sat still four of them, then jumped); no further than her next stop's expected time takes her
      const el = Math.max((now - p.fix.t) / 1000, 0), lim = Math.max(60, Math.min(480, 1.5 * (p.gap || (p.a.rail === 'Amtrak' ? 300e3 : 90e3)) / 1000));
      let s = p.v * Math.min(el, lim), tx = null, tz = null; p.wh = null;
      if (p.a.nextExp && !p.a.atStop && p.a.nextExp > p.fix.t) s = Math.min(s, p.v * (p.a.nextExp - p.fix.t) / 1000);
      // (v1121) between reports she runs on along her own track; (v1127, reported: the cars "jump around a little too
      // vigorously") her place on it (cur) moved on each frame by her pace, not walked afresh from her last report's
      // (up to 10 km back: through junctions each time, and past the walk's 400 pieces): her target (her report's
      // place and s on) kept as how far ahead of her it is (gapT), closed over ~6 s at no more than a third of her
      // speed (3 m/s at least; a far gap faster, to her speed again over 1/30 of it); she doesn't back up for it, and only a report 6 km behind her or off her track (8 km looked along) puts her there at once
      if (p.ft === undefined) {
        p.ft = fixOnTrack(p); p.st = s; p.lastT = now;
        if (p.ft) {
          const A = placeOf(p.ft); let a = p.cur && p.placed ? alongTo(p.cur, A.x, A.z, 8000) : null;
          // (her way along her track, as shown, against her report's: if they're opposed where her report puts her, she
          // was set going the wrong way (before she'd been seen to move), and is turned about: she'd run off from her
          // reports, then stood, never backing up)
          if (a != null) { const q = step(p.cur, a); if (q && near(q.h, A.h) > 90) { p.cur = { ...p.cur, dir: -p.cur.dir, h: (p.cur.h + 180) % 360 }; a = -a; p.vs = null; } }
          if (a != null && a + s > -6000) p.gapT = a + s; else { p.cur = step(A, s) || A; p.gapT = 0; p.vs = null; }
        } else p.cur = null;
      }
      let walked = false;
      if (p.cur) {
        // (on the clock's time, not the frame's: a frame's dt is capped, and on a slow screen she fell behind)
        const rt = Math.min(2, Math.max(0, (now - (p.lastT || now)) / 1000));
        const ds = s - p.st, vt = Math.max(0, Math.min(ds / Math.max(rt, 1e-3), p.v * 1.3 + 0.5)); p.st = s;
        // her pace as a train's: toward her target's and the gap's correction, but no harder than 0.7 m/s² up and 1.2
        // m/s² down, and braking in time to stop at her target when it stops (her next stop's expected time)
        const cap = Math.max(3, p.v / 3, Math.min(p.v, Math.abs(p.gapT) / 30)), want = Math.max(0, Math.min(vt + Math.max(-cap, Math.min(cap, p.gapT / 6)), vt + Math.sqrt(2 * 1.0 * Math.max(0, p.gapT))));
        p.vs = p.vs == null ? (p.a.atStop ? want : Math.max(want, p.v)) : p.vs + Math.max(-(1.2 + Math.min(1.8, Math.abs(p.gapT) / 300)) * rt, Math.min((0.7 + Math.min(2.3, Math.abs(p.gapT) / 200)) * rt, want - p.vs));   // (harder, when she's far from her target: a 2 km gap closed at a crawl)
        const m = p.vs * rt;
        p.gapT += ds - m;
        const n = step(p.cur, m); if (n) p.cur = n; p.lastT = now;
        tx = p.cur.x; tz = p.cur.z; p.wh = p.cur.h; walked = true;
      }
      if (tx == null) { const s1 = Math.min(s, p.v * 60); tx = p.fix.x + Math.sin(p.h * DEG) * s1; tz = p.fix.z - Math.cos(p.h * DEG) * s1; }
      const k = p.placed && !walked ? Math.min(1, dt * 0.8) : 1; p.placed = true;   // (on her track, she's where her walk puts her)
      p.x += (tx - p.x) * k; p.z += (tz - p.z) * k;
      // on her track, along it: the way she's going if she's been seen to move, or else her direction's way (a
      // southbound train the end of it nearer south). Off any track (none within 40 m), as before
      const tr = onTrack(p.x, p.z);
      let dh = p.h;
      if (tr) {
        const ref = p.wh ?? (p.moved ? p.h : p.a.dir === 'S' ? 180 : p.a.dir === 'N' ? 0 : p.h), alt = (tr.h + 180) % 360;
        dh = near(tr.h, ref) <= near(alt, ref) ? tr.h : alt; p.x = tr.x; p.z = tr.z;
        if (!p.moved) p.h = dh;   // (and her heading's this till she's seen to move: her card's and her map's too)
      }
      const turn = ((dh - (p.dh ?? dh) + 540) % 360) - 180; p.dh = ((p.dh ?? dh) + (p.placedH ? Math.max(-20 * dt, Math.min(20 * dt, turn)) : turn) + 360) % 360; p.placedH = true;
      const lon = p.fix.lon + (p.x - p.fix.x) / (111320 * Math.cos(p.fix.lat * DEG)), lat = p.fix.lat - (p.z - p.fix.z) / 111120;
      // on the ground under her whole length, not just her middle (v1107: a 190 m Caltrain set at her middle's height
      // sank into the rise ahead of her, and showed in two pieces): the ground under her front and back too, she sits
      // at the higher of her middle and her ends' mean, tilted to their slope (no more than a railway's 2°)
      const hl = (p.len || 160) / 2 * (p.model.scale.z || 1), fx = Math.sin(p.dh * DEG) * hl, fz = -Math.cos(p.dh * DEG) * hl;
      // (v1125: on her track's own heights, smoothed as a railway's grades, bridges' decks and all, not the ground's
      // bumps; the ground where there's no track)
      // (her ends, straight out from her middle, stand off the curve of a long train's track: looked for further, and
      // where none, her middle's height, not the ground's bumps: a 126 m Amtrak jumped 3.6 m at a time)
      const tC = trackY?.(p.x, p.z), hC = tC ?? Math.max(0, heightAt(lon, lat) || 0);
      const gAt = (x, z) => tC != null ? (trackY(x, z, 35) ?? tC) : Math.max(0, heightAt(p.fix.lon + (x - p.fix.x) / (111320 * Math.cos(p.fix.lat * DEG)), p.fix.lat - (z - p.fix.z) / 111120) || 0);
      const hF = gAt(p.x + fx, p.z + fz), hB = gAt(p.x - fx, p.z - fz);
      p.y = Math.max(hC, (hF + hB) / 2); p.g.position.set(p.x, p.y, p.z);
      p.model.rotation.order = 'YXZ'; p.model.rotation.set(Math.max(-0.035, Math.min(0.035, Math.atan2(hF - hB, 2 * hl))), -p.dh * DEG, 0);
      // her real size near; farther off, big enough to see (v1105, reported: "It's hard to see trains"): about 4 px
      // wide whatever the distance (a 3 m train is a fraction of a pixel from 20 km), and long in proportion
      const d = Math.hypot(p.x - cp.x, cp.y - p.g.position.y, p.z - cp.z), w = Math.max(1, d * 0.0058 / 3.1), l = Math.max(1, d * 0.02 / 160, w * 0.35);
      p.model.scale.set(w, Math.max(1, w * 0.5), l);
      // (v1126) near, at her real size, on her track: each car where her track is under her two trucks (70% of the way
      // from her middle to each end), turned and tilted to their line, on the track's heights. Her cab's camera with her
      // first car. Farther off, or off her track, the cars in a straight line as before
      // (v1127: at any distance, her cars each made bigger in place when she's far: v1126 straightened her at 530 m, a snap)
      let art = walked && !!p.cars && !!p.cur;
      if (art) {
        const at = f => step(p.cur, f);
        const P = p.cars.map(c => { const b = c.userData.half * 0.7, cf = -c.userData.zc; return [at(cf + b), at(cf - b), b]; });
        if (P.some(([F, B]) => !F || !B)) art = false;
        else {
          p.model.rotation.set(0, 0, 0); p.model.scale.set(1, 1, 1);
          const ky = p.artd ? 1 - Math.exp(-dt / 0.35) : 1;   // (her height and tilt eased: no step where the track's do)
          p.cars.forEach((c, i) => {
            const [F, B, b] = P[i], yF = trackY?.(F.x, F.z, 6) ?? p.y, yB = trackY?.(B.x, B.z, 6) ?? p.y, u = c.userData;
            u.y = u.y == null || !p.artd ? (yF + yB) / 2 : u.y + ((yF + yB) / 2 - u.y) * ky;
            u.pitch = u.pitch == null || !p.artd ? Math.atan2(yF - yB, 2 * b) : u.pitch + (Math.atan2(yF - yB, 2 * b) - u.pitch) * ky;
            c.position.set((F.x + B.x) / 2 - p.x, u.y - p.y, (F.z + B.z) / 2 - p.z);
            // her heading eased over ~0.15 s: the track's line is straight pieces, and at each corner she turned at once
            const hd = Math.atan2(F.x - B.x, -(F.z - B.z)), dd = ((hd - (u.hd ?? hd)) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
            u.hd = u.hd == null || !p.artd || Math.abs(dd) > 0.5 ? hd : u.hd + dd * (1 - Math.exp(-dt / 0.15));
            c.rotation.set(Math.max(-0.05, Math.min(0.05, u.pitch)), -u.hd, 0, 'YXZ');
            c.scale.set(w, Math.max(1, w * 0.5), l);
          });
          const c0 = p.cars[0], [hx, hy, hz] = p.helm0; c0.updateWorldMatrix(true, false);
          _cab.set(hx, hy, hz - c0.userData.zc).applyMatrix4(c0.matrixWorld);
          const h = p.h * DEG, ch = Math.cos(h), sh = Math.sin(h), dx = _cab.x - p.x, dz = _cab.z - p.z;
          p.g.userData.helm = [dx * ch + dz * sh, _cab.y - p.y, -dx * sh + dz * ch];
        }
      }
      if (!art && p.cars && p.artd !== false) { for (const c of p.cars) { c.position.set(0, 0, c.userData.zc); c.rotation.set(0, 0, 0); c.scale.set(1, 1, 1); } p.g.userData.helm = p.helm0; }
      p.artd = art;
      p.tag.visible = p === hover || pinned.has(p) || focus(p);
    }
  }
  return {
    start() { if (on) return; on = true; poll(); },
    stop() { on = false; clearTimeout(timer); inflight?.abort(); for (const p of [...trains.values()]) drop(p); onCount?.(0); },
    update, setTracks, setTrackY: f => { trackY = f; }, nearTrack: (x, z, r) => !!onTrack(x, z, r), setTrips: d => { trips = d; },
    // the train under a point on the screen (client px), within reach px of her middle: for hover and tap
    at(cx, cy, camera, rect, reach = 22) {
      let best = null, bd = reach;
      for (const p of trains.values()) {
        _v.copy(p.g.position).project(camera); if (_v.z >= 1) continue;
        const d = Math.hypot(rect.left + (_v.x + 1) / 2 * rect.width - cx, rect.top + (1 - _v.y) / 2 * rect.height - cy);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    },
    set hover(p) { hover = p; },
    has: p => trains.get(p?.id) === p,
    items: () => [...trains.values()],
    toggle(p) { if (pinned.has(p)) pinned.delete(p); else pinned.add(p); },
    pin(id, show = true) { const p = trains.get(id); if (p) { if (show) pinned.add(p); else pinned.delete(p); } return !!p; },   // (for a recording)
    get on() { return on; },
    get count() { return trains.size; },
    list: (camera, rect) => [...trains.values()].map(p => {   // (for checking from a script)
      const o = { id: p.id, rail: p.a.rail, trip: p.a.trip, dest: place(p.a.dest), v: +p.v.toFixed(1), h: Math.round(p.dh ?? p.h), shown: p.tag.visible, lat: latOf(p), lon: lonOf(p) };
      if (camera && rect) { _v.copy(p.g.position).project(camera); if (_v.z < 1) { o.sx = Math.round(rect.left + (_v.x + 1) / 2 * rect.width); o.sy = Math.round(rect.top + (1 - _v.y) / 2 * rect.height); } }
      return o;
    }),
  };
}
