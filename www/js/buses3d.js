// C&J's coaches into New York (v1183; asked: "How about the C&J coming from Boston/NH?", "I'd be coming from Seabrook"):
// Dover, Portsmouth and Seabrook NH to the Port Authority Bus Terminal (Gate 36), non-stop, and back. On C&J's
// timetable (ridecj.com, "Daily schedule, effective October 14, 2025"), at the scene's clock: each coach comes into
// the bay on I-95 at Port Chester and runs her road to the terminal to arrive at her time; the northbound ones leave
// at theirs. Her road isn't published: it's inferred (www/data/buses/nyc-cj.json, design/buses/build_cj.py): I-95,
// the Cross Bronx, the George Washington Bridge, I-95 and NJ 495 down through New Jersey, the Lincoln Tunnel and the
// terminal's ramps, the way Peter Pan's Boston coaches are drawn in their own timetable data. Her pace on it is a
// guess too (about 35 mph, slower in the tunnel and on the ramps), so she's where the timetable would have her, give
// or take traffic.
// They're movers as the trains are (kind 'rail', bus: true): on with 📡 Live, a card, Follow, and her driver's seat.
import * as THREE from 'three';
import { labelSprite } from './aircraft3d.js';
import { bayDay } from './regiontime.js';

const DEG = Math.PI / 180;
// days: 0 Sunday .. 6 Saturday. Southbound by their time at the terminal (and at Dover, for the card); northbound by
// their time leaving it (and at Dover)
const ALL = [0, 1, 2, 3, 4, 5, 6];
const SOUTH = [
  { at: '11:50', dover: '5:30', days: ALL },
  { at: '16:50', dover: '10:00', days: ALL },
  { at: '21:35', dover: '15:30', days: [5, 0] },
];
const NORTH = [
  { at: '7:30', dover: '13:30', days: [1, 6, 0] },
  { at: '12:45', dover: '19:10', days: ALL },
  { at: '18:00', dover: '23:30', days: [0, 1, 2, 3, 4, 5] },
];
const mins = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const hhmm = m => { m = ((m % 1440) + 1440) % 1440; const h = Math.floor(m / 60), mi = Math.floor(m % 60); return `${h % 12 || 12}:${String(mi).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; };
const LEN = 13.7;   // a 45 ft coach (C&J's are MCI J4500s and Van Hools)
// her pace, m/s: on the road, in the tunnel, on the terminal's ramps (the last and first few hundred metres)
const PACE = [16, 12, 6];

// a coach: a white body on a dark skirt, the windows along her a dark band, the windscreen and her lamps; her front
// toward -z, as the trains'
export function coachModel() {
  const g = new THREE.Group(), W = 2.6, H = 3.45, L = LEN;
  const m = c => new THREE.MeshLambertMaterial({ color: c });
  const box = (w, h, l, x, y, z, mat) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat); b.position.set(x, y, z); g.add(b); return b; };
  box(W, H - 0.9, L, 0, 0.9 + (H - 0.9) / 2, 0, m(0xf2f2ee));                       // her body
  box(W + 0.02, 0.55, L - 0.4, 0, 0.62, 0, m(0x1d2a4a));                            // her skirt, navy
  box(W + 0.04, 1.05, L - 3.2, 0, 2.35, 0.9, m(0x1a1f26));                           // the side windows
  // the windscreen and her destination sign: faces outward only, so from her driver's seat they're not there (a box's
  // inner face had blacked out the view ahead)
  for (const [w, h, y, c] of [[W - 0.2, 1.5, 2.2, 0x1a1f26], [W - 0.3, 0.35, 3.15, 0x0d0f12]]) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m(c)); f.rotation.y = Math.PI; f.position.set(0, y, -L / 2 - 0.03); g.add(f);
  }
  const wheel = new THREE.CylinderGeometry(0.52, 0.52, 0.32, 14); wheel.rotateZ(Math.PI / 2);
  const tyre = m(0x161616);
  for (const z of [-L / 2 + 2.3, L / 2 - 3.6, L / 2 - 2.3]) for (const s of [-1, 1]) { const w = new THREE.Mesh(wheel, tyre); w.position.set(s * (W / 2 - 0.12), 0.52, z); g.add(w); }
  const lamp = new THREE.MeshBasicMaterial({ color: 0xfff2d0 }), tail = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
  for (const s of [-1, 1]) { box(0.35, 0.18, 0.05, s * 0.95, 0.95, -L / 2 - 0.03, lamp); box(0.2, 0.5, 0.05, s * 1.1, 1.3, L / 2 + 0.03, tail); }
  return g;
}

export function makeBuses({ scene, wx, wz, heightAt, clockMin, roadDecks = () => null, focus = () => false, onCount, onDrop = () => {}, onRoad = () => {} }) {
  let route = null, on = false, hover = null, credit = '';
  const pinned = new Set(), coaches = new Map(), _v = new THREE.Vector3();
  // her road each way: its points (x, z, flag: 0 road, 1 tunnel, 2 bridge or ramp), the distance along it to each,
  // and the time along it at her pace (s)
  function prep(P, rampAtEnd) {
    const pts = P.map(([lon, lat, f]) => ({ lon, lat, f, x: wx(lon), z: wz(lat) }));
    let s = 0, t = 0; const n = pts.length;
    pts.forEach((p, i) => {
      if (i) { const q = pts[i - 1], d = Math.hypot(p.x - q.x, p.z - q.z), ramp = rampAtEnd ? i > n - 4 : i < 3; s += d; t += d / (ramp ? PACE[2] : p.f === 1 ? PACE[1] : PACE[0]); }
      p.s = s; p.t = t;
    });
    return { pts, len: s, dur: t };
  }
  // her road's pieces in a 100 m grid: for keeping the trees off it (the photo's green had stood them on the Turnpike)
  const CELL = 100, grid = new Map();
  function index(R) {
    for (let i = 1; i < R.pts.length; i++) {
      const a = R.pts[i - 1], b = R.pts[i], n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (CELL / 2)) + 1;
      for (let j = 0; j <= n; j++) { const k = `${Math.floor((a.x + (b.x - a.x) * j / n) / CELL)},${Math.floor((a.z + (b.z - a.z) * j / n) / CELL)}`; const c = grid.get(k); if (!c) grid.set(k, [[a, b]]); else if (c[c.length - 1][0] !== a) c.push([a, b]); }
    }
  }
  // within r m of her road's middle line (and its carriageways' width, 8 m either side)
  function nearRoad(x, z, r) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), R2 = (r + 8) ** 2;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [a, b] of grid.get(`${cx + i},${cz + j}`) || []) {
      const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
      if ((a.x + dx * t - x) ** 2 + (a.z + dz * t - z) ** 2 < R2) return true;
    }
    return false;
  }
  fetch('./data/buses/nyc-cj.json').then(r => r.json()).then(j => { route = { sb: prep(j.sb, true), nb: prep(j.nb, false) }; credit = j.credit; index(route.sb); index(route.nb); onRoad(nearRoad); }).catch(e => console.warn('[buses] route', e));
  // where she is t s along her road: the point, her heading, whether she's in the tunnel
  function at(R, t) {
    const P = R.pts; let lo = 0, hi = P.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (P[mid].t <= t) lo = mid; else hi = mid; }
    const a = P[lo], b = P[hi], u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, lon: a.lon + (b.lon - a.lon) * u, lat: a.lat + (b.lat - a.lat) * u,
      h: (Math.atan2(b.x - a.x, -(b.z - a.z)) / DEG + 360) % 360, f: b.f, v: (b.s - a.s) / Math.max(1e-6, b.t - a.t) };
  }
  // her height: a big bridge's deck where she's on one (bridges3d.js's road decks: the GWB's), else the ground
  function yAt(p) {
    if (p.f === 2) {
      const D = roadDecks(); let best = null, bd = 40 * 40;
      if (D) for (const P of D) for (const q of P) { const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2; if (d < bd) { bd = d; best = q.h; } }
      if (best != null) return best;
    }
    return Math.max(0, heightAt(p.lon, p.lat) || 0);
  }
  // the trips on the road at the scene's minute m (and those from yesterday's late runs still on it)
  function running(m) {
    if (!route) return [];
    const out = [], today = bayDay().getDay();
    for (const [dayOff, day] of [[0, today], [-1440, (today + 6) % 7]]) {
      for (const T of SOUTH) if (T.days.includes(day)) {
        const end = mins(T.at) + dayOff, start = end - route.sb.dur / 60;
        if (m >= start && m < end + 2) out.push({ id: `cj-s-${T.at}`, T, dir: 'S', R: route.sb, t: Math.min(route.sb.dur, (m - start) * 60), start, end, arrived: m >= end });
      }
      for (const T of NORTH) if (T.days.includes(day)) {
        const start = mins(T.at) + dayOff, end = start + route.nb.dur / 60;
        if (m >= start - 2 && m < end) out.push({ id: `cj-n-${T.at}`, T, dir: 'N', R: route.nb, t: Math.max(0, (m - start) * 60), start, end, boarding: m < start });
      }
    }
    return out;
  }
  function make(trip) {
    const g = new THREE.Group(), model = coachModel(), tag = labelSprite();
    tag.position.set(0, 6, 0); g.add(model, tag); scene.add(g);
    g.userData.helm = [-0.75, 2.4, -LEN / 2 + 1.0];   // her driver's seat: left of her middle, behind the windscreen
    const p = { kind: 'rail', bus: true, id: trip.id, g, group: g, model, tag, L: 45, len: LEN, y: 0, x: 0, z: 0, h: 0, dh: 0, v: 0, vKnown: true, helm0: g.userData.helm,
      fix: { t: Date.now() } };
    coaches.set(trip.id, p); return p;
  }
  function drop(p) { pinned.delete(p); if (hover === p) hover = null; coaches.delete(p.id); onDrop(p); scene.remove(p.g); p.g.traverse(o => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); }); }
  let lastM = -1;
  function update(dt, camera) {
    if (!on || !route) return;
    const m = clockMin(), live = running(m), seen = new Set();
    for (const trip of live) {
      seen.add(trip.id);
      const p = coaches.get(trip.id) || make(trip), q = at(trip.R, trip.t), south = trip.dir === 'S';
      // (v1184) how fast she's turning, °/s, eased: her wheel turns with it
      if (p.trip && dt > 0) { const dh = ((q.h - p.h + 540) % 360) - 180; p.turn = (p.turn || 0) + (Math.max(-20, Math.min(20, dh / dt)) - (p.turn || 0)) * Math.min(1, dt / 0.6); }
      p.trip = trip; p.x = q.x; p.z = q.z; p.h = p.dh = q.h; p.y = yAt(q); p.v = trip.arrived || trip.boarding ? 0 : q.v;
      p.under = false; p.tunnel = q.f === 1;
      p.g.position.set(p.x, p.y, p.z); p.model.rotation.set(0, -p.h * DEG, 0);
      // near, her real size; far off, big enough to see (as the trains: about 4 px wide)
      const cp = camera.position, d = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z), w = Math.max(1, d * 0.0058 / 2.6);
      p.model.scale.set(w, Math.max(1, w * 0.5), Math.max(1, w * 0.35));
      p.model.visible = !p.tunnel;
      p.a = { rail: 'C&J', trip: trip.T.at, from: south ? 'Dover, NH' : 'New York (Port Authority)', dest: south ? 'New York (Port Authority)' : 'Dover, NH',
        next: south ? 'Port Authority, Gate 36' : 'Seabrook, NH' };
      p.from = p.a.from; p.dest = p.a.dest;
      p.title = `C&J coach, ${south ? 'from Dover' : 'to Dover'} (${hhmm(mins(trip.T.at))})`;
      // (OSM's tunnels on her road: the Lincoln Tunnel's, and the Trans-Manhattan Expressway's under the apartment houses
      // over it at the bridge's Manhattan end)
      const where = !p.tunnel ? '' : q.lon < -73.995 && q.lat < 40.77 ? 'In the Lincoln Tunnel · ' : 'Under the apartment houses · ';
      p.label = where + (south ? (trip.arrived ? `At the Port Authority, Gate 36 (due ${hhmm(trip.end)})` : `Dover ${hhmm(mins(trip.T.dover))} → Port Authority, due ${hhmm(trip.end)}`)
        : (trip.boarding ? `Boarding at Gate 36, leaves ${hhmm(trip.start)}` : `Port Authority ${hhmm(trip.start)} → Seabrook, Portsmouth, Dover ${hhmm(mins(trip.T.dover))}`));
      p.labelBase = p.label;
      p.tag.userData.draw(`C&J → ${south ? 'New York' : 'Dover NH'}`);
      p.tag.visible = p === hover || pinned.has(p) || focus(p);
      p.fix.t = Date.now();
    }
    for (const p of [...coaches.values()]) if (!seen.has(p.id)) drop(p);
    if (coaches.size !== lastM) { lastM = coaches.size; onCount?.(coaches.size); }
  }
  return {
    get credit() { return credit; },
    start() { on = true; },
    stop() { on = false; for (const p of [...coaches.values()]) drop(p); lastM = -1; onCount?.(0); },
    update,
    at(cx, cy, camera, rect, reach = 22) {
      let best = null, bd = reach;
      for (const p of coaches.values()) {
        _v.copy(p.g.position).project(camera); if (_v.z >= 1) continue;
        const d = Math.hypot(rect.left + (_v.x + 1) / 2 * rect.width - cx, rect.top + (1 - _v.y) / 2 * rect.height - cy);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    },
    set hover(p) { hover = p; },
    has: p => coaches.get(p?.id) === p,
    items: () => [...coaches.values()],
    toggle(p) { if (pinned.has(p)) pinned.delete(p); else pinned.add(p); },
    pin(id, show = true) { const p = coaches.get(id); if (p) { if (show) pinned.add(p); else pinned.delete(p); } return !!p; },
    get count() { return coaches.size; },
    list: () => [...coaches.values()].map(p => ({ id: p.id, rail: 'C&J', dir: p.trip.dir, at: p.trip.T.at, tunnel: p.tunnel, v: +p.v.toFixed(1), h: Math.round(p.h), y: +p.y.toFixed(1), shown: p.tag.visible, label: p.label })),
    // (for checking) the minutes each way takes on her road
    durations: () => route && { sb: route.sb.dur / 60, nb: route.nb.dur / 60, sbKm: route.sb.len / 1000, nbKm: route.nb.len / 1000 },
  };
}

// the trains' movers and the coaches' as one (bay3d.js's `rail`): what's asked of one asked of both
export function withBuses(trains, buses) {
  return new Proxy(trains, {
    get(t, k) {
      switch (k) {
        case 'count': return t.count + buses.count;
        case 'has': return p => t.has(p) || buses.has(p);
        case 'items': return () => [...t.items(), ...buses.items()];
        case 'list': return (c, r) => [...t.list(c, r), ...buses.list()];
        case 'at': return (...a) => t.at(...a) || buses.at(...a);
        case 'start': return () => { t.start(); buses.start(); };
        case 'stop': return () => { t.stop(); buses.stop(); };
        case 'update': return (dt, cam) => { t.update(dt, cam); buses.update(dt, cam); };
        case 'toggle': return p => (buses.has(p) ? buses : t).toggle(p);
        case 'pin': return (id, show) => t.pin(id, show) || buses.pin(id, show);
        case 'buses': return buses;
      }
      const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) { if (k === 'hover') { t.hover = v && t.has(v) ? v : null; buses.hover = v && buses.has(v) ? v : null; return true; } t[k] = v; return true; },
  });
}
