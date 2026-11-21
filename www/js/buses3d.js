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
import { relayUrl } from './ais.js';

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

export function makeBuses({ scene, wx, wz, heightAt, laneAt = () => null, clockMin, roadDecks = () => null, focus = () => false, onCount, onDrop = () => {}, onRoad = () => {} }) {
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
      // (v1194: on the right, as Americans drive: her route's the road's middle line, so she's put in her right-hand lane,
      // a city street's own where it's drawn, else 1.8 m right of the line)
      const ln = laneAt(q.x, q.z, q.h), hr = q.h * DEG, side = ln ? null : [Math.cos(hr) * 1.8, Math.sin(hr) * 1.8];
      p.trip = trip; p.x = ln ? ln.x : q.x + side[0]; p.z = ln ? ln.z : q.z + side[1]; p.h = p.dh = ln ? ln.h : q.h; p.y = yAt(q); p.v = trip.arrived || trip.boarding ? 0 : q.v;
      p.under = false; p.tunnel = q.f === 1;
      p.g.position.set(p.x, p.y, p.z); p.model.rotation.set(0, -p.h * DEG, 0);
      // near, her real size; far off, big enough to see (as the trains: about 4 px wide)
      const cp = camera.position, d = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z), w = Math.max(1, d * 0.0058 / 2.6);
      p.model.scale.set(w, Math.max(1, w * 0.5), Math.max(1, w * 0.35));
      p.model.visible = !p.tunnel;
      p.a = { rail: 'C&J', trip: trip.T.at, from: south ? 'Dover, NH' : 'New York (Port Authority)', dest: south ? 'New York (Port Authority)' : 'Dover, NH',
        next: `Next: ${south ? 'Port Authority, Gate 36' : 'Seabrook, NH'}` };
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

// (v1186; asked: "Is there a feed for MTA busses?", "MTA bus key installed", "You can do it now") New York's city
// buses, live: MTA Bus Time's GPS positions through the relay (GET /mtabus, at most every 30 s: its limit), about
// 3,500 at midday, 570 of them on Manhattan's routes. Each runs from her last report to her new one over the time
// between them, so she's about half a minute behind, but on her street (a straight run on from a report had cut
// corners through the blocks). All of them one instanced mesh, one draw call (v1155's lesson: New York's 630 trains,
// each her own meshes, were 19,000); each a mover (kind 'rail', bus: true, mta: true) for her card, Follow and her
// driver's seat, with an empty group to carry her helm. MTA blue on white.
// ── An MTA bus as herself (v1194, asked: "make the bus model look like a real MTA bus"): a 40 ft low-floor bus, the
// New Flyer Xcelsior most of the fleet now is: 12.2 m by 2.59 m, her floor low (0.3 m clear of the street), the roof
// 3.0 m up with the air conditioning's pod over her back half. Her paint (one canvas, every face's place on it):
// white, the MTA's blue along her skirt rising in a sweep to her windscreen, a lighter stripe over it; the dark band of
// her windows with their pillars; on her right (the kerb) the front door ahead of her front wheels and the rear door
// past her middle, glass to the floor; the driver's window on her left; the big windscreen, the amber destination sign
// over it, the headlights and the black bumper with the bike rack in front; at the back the engine's louvres and the
// red tail lights. A Select Bus Service bus in that service's blue and white. Close in, the whole model (wheels, the
// mirrors on their arms, the roof pod); farther, only her painted body: a box, the same paint.
const BUS_L = 12.2, BUS_W = 2.59, BUS_Y0 = 0.3, BUS_Y1 = 3.0, BUS_AX = [2.35, 9.35];   // her axles, from her front (m)
const ATLAS = { right: [0, 0, 1024, 256], left: [0, 256, 1024, 512], front: [0, 512, 256, 800], rear: [256, 512, 512, 800] };
const SW = { white: 560, black: 600, tyre: 640, hub: 680, pod: 720, glass: 760, blue: 800, rack: 840 };   // (flat colours: 20 px squares at y 520)
function busPaint(sbs) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1024; const c = cv.getContext('2d');
  const WHITE = '#f3f3f0', BLUE = sbs ? '#1f5fbf' : '#163f9a', LIGHT = sbs ? '#5fb6e8' : '#3d7fd6', GLASS = '#161b22';
  const swatch = { white: WHITE, black: '#141414', tyre: '#1b1b1b', hub: '#b4b7bb', pod: '#dcdcd8', glass: GLASS, blue: BLUE, rack: '#26282b' };
  for (const [k, x] of Object.entries(SW)) { c.fillStyle = swatch[k]; c.fillRect(x, 516, 28, 28); }
  // a side, its front at `fx` (the right side's front is at its right end, as seen; the left's at its left)
  const side = (y0, right) => {
    const H = 256, ppm = 1024 / BUS_L, hp = H / (BUS_Y1 - BUS_Y0);
    const X = m => right ? 1024 - m * ppm : m * ppm, Y = h => y0 + H - (h - BUS_Y0) * hp;   // (m from her front; h m above the street)
    const rect = (m0, m1, h0, h1, col) => { const a = X(m0), b = X(m1); c.fillStyle = col; c.fillRect(Math.min(a, b), Y(h1), Math.abs(b - a), Y(h0) - Y(h1)); };
    c.fillStyle = WHITE; c.fillRect(0, y0, 1024, H);
    // the skirt, the sweep up to the windscreen, the stripe
    rect(0, BUS_L, BUS_Y0, 0.78, BLUE);
    c.fillStyle = BLUE; c.beginPath(); c.moveTo(X(0), Y(0.78)); c.lineTo(X(0), Y(sbs ? 2.0 : 1.55)); c.quadraticCurveTo(X(1.2), Y(0.9), X(3.6), Y(0.78)); c.closePath(); c.fill();
    rect(0.4, BUS_L - 0.2, 0.86, 0.94, LIGHT);
    if (sbs) { for (let k = 0; k < 3; k++) { c.fillStyle = k % 2 ? LIGHT : BLUE; c.beginPath(); const m = 4.4 + k * 0.5; c.moveTo(X(m), Y(0.78)); c.lineTo(X(m + 0.35), Y(0.78)); c.lineTo(X(m + 0.85), Y(1.12)); c.lineTo(X(m + 0.5), Y(1.12)); c.fill(); } }
    // the windows: dark, a sheen, white pillars between
    const win = (m0, m1, h0 = 1.22, h1 = 2.62) => {
      rect(m0, m1, h0, h1, GLASS);
      const a = X(m0), b = X(m1), g = c.createLinearGradient(0, Y(h1), 0, Y(h0)); g.addColorStop(0, 'rgba(150,170,190,0.28)'); g.addColorStop(0.45, 'rgba(150,170,190,0.05)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(Math.min(a, b), Y(h1), Math.abs(b - a), Y(h0) - Y(h1));
    };
    const door = (m0, m1) => { rect(m0 - 0.06, m1 + 0.06, 0.32, 2.72, '#2a2d31'); win(m0, (m0 + m1) / 2 - 0.03, 0.4, 2.62); win((m0 + m1) / 2 + 0.03, m1, 0.4, 2.62); rect(m0, m1, 1.45, 1.5, '#8c8f93'); };
    const panes = (m0, m1, n) => { const w = (m1 - m0) / n; for (let k = 0; k < n; k++) win(m0 + k * w + 0.07, m0 + (k + 1) * w - 0.07); };
    if (right) { door(0.25, 1.4); panes(1.55, 6.55, 4); door(6.7, 7.9); panes(8.05, 11.2, 3); }
    else { win(0.2, 1.75, 1.3, 2.62); panes(1.9, 11.2, 7); }
    win(11.35, 11.95, 1.9, 2.62);   // (the little one at the back, over the engine)
    rect(0, BUS_L, 2.66, 2.7, '#c9c9c4');   // (the roof's edge, its gutter)
    // the wheel arches
    for (const a of BUS_AX) { c.fillStyle = '#121212'; c.beginPath(); c.arc(X(a), Y(BUS_Y0), 0.62 * ppm, Math.PI, 0); c.fill(); }
    // the roundel, and her number's plate (blank: one paint for all)
    c.fillStyle = BLUE; c.beginPath(); c.arc(X(right ? 3.3 : 2.4), Y(1.05), 0.17 * hp, 0, 2 * Math.PI); c.fill();
    c.fillStyle = WHITE; c.font = `bold ${0.13 * hp}px Helvetica, Arial, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('MTA', X(right ? 3.3 : 2.4), Y(1.05));
    if (sbs) { c.fillStyle = BLUE; c.font = `bold ${0.16 * hp}px Helvetica, Arial, sans-serif`; c.fillText('SELECT BUS SERVICE', X(right ? 9.6 : 7.2), Y(1.06)); }
    rect(0.05, 0.12, 0.5, 2.7, '#d9d9d5'); rect(BUS_L - 0.12, BUS_L - 0.05, 0.5, 2.7, '#d9d9d5');   // (the corners' seams)
  };
  side(0, true); side(256, false);
  // the front (256 px across her 2.59 m, 288 down her 2.7 m), as seen from ahead
  { const [x0, y0] = ATLAS.front, W = 256, H = 288, ppm = W / BUS_W, hp = H / (BUS_Y1 - BUS_Y0), Y = h => y0 + H - (h - BUS_Y0) * hp;
    c.fillStyle = WHITE; c.fillRect(x0, y0, W, H);
    c.fillStyle = BLUE; c.fillRect(x0, Y(0.95), W, Y(BUS_Y0) - Y(0.95));
    c.fillStyle = GLASS; c.fillRect(x0 + 8, Y(2.5), W - 16, Y(0.98) - Y(2.5));
    const g = c.createLinearGradient(x0, Y(2.5), x0 + W, Y(1.0)); g.addColorStop(0, 'rgba(170,190,210,0.3)'); g.addColorStop(0.5, 'rgba(170,190,210,0.05)'); g.addColorStop(1, 'rgba(170,190,210,0.18)'); c.fillStyle = g; c.fillRect(x0 + 8, Y(2.5), W - 16, Y(0.98) - Y(2.5));
    c.fillStyle = '#0c0c0c'; c.fillRect(x0 + 18, Y(2.88), W - 36, Y(2.56) - Y(2.88));   // the destination sign
    c.textAlign = 'center'; c.textBaseline = 'middle';   // (the sign's own words are lit over it, close in: busSigns)
    c.fillStyle = '#141414'; c.fillRect(x0, Y(0.55), W, Y(BUS_Y0) - Y(0.55));   // the bumper
    for (const sx of [0, 1]) { const hx = x0 + (sx ? W - 14 - 0.5 * ppm : 14); c.fillStyle = '#2a2a2a'; c.fillRect(hx, Y(0.88), 0.5 * ppm, Y(0.62) - Y(0.88)); c.fillStyle = '#f4f1e6'; c.fillRect(hx + 3, Y(0.85), 0.5 * ppm * 0.55, Y(0.65) - Y(0.85)); c.fillStyle = '#e8a33a'; c.fillRect(hx + 4 + 0.5 * ppm * 0.55, Y(0.85), 0.5 * ppm * 0.3, Y(0.65) - Y(0.85)); }
    c.fillStyle = WHITE; c.beginPath(); c.arc(x0 + W / 2, Y(0.75), 0.16 * hp, 0, 2 * Math.PI); c.fill();
    c.fillStyle = BLUE; c.font = `bold ${0.12 * hp}px Helvetica, Arial, sans-serif`; c.fillText('MTA', x0 + W / 2, Y(0.75)); }
  // the back
  { const [x0, y0] = ATLAS.rear, W = 256, H = 288, ppm = W / BUS_W, hp = H / (BUS_Y1 - BUS_Y0), Y = h => y0 + H - (h - BUS_Y0) * hp;
    c.fillStyle = WHITE; c.fillRect(x0, y0, W, H);
    c.fillStyle = BLUE; c.fillRect(x0, Y(0.85), W, Y(BUS_Y0) - Y(0.85));
    c.fillStyle = '#2b2e33'; c.fillRect(x0 + 40, Y(1.55), W - 80, Y(0.95) - Y(1.55));   // the engine's louvres
    c.fillStyle = '#4b4f55'; for (let k = 0; k < 10; k++) c.fillRect(x0 + 44, Y(1.52) + k * (Y(0.98) - Y(1.52)) / 10, W - 88, 2);
    c.fillStyle = GLASS; c.fillRect(x0 + 30, Y(2.6), W - 60, Y(1.95) - Y(2.6));
    for (const sx of [0, 1]) { const tx = x0 + (sx ? W - 26 : 8); c.fillStyle = '#b0141a'; c.fillRect(tx, Y(1.7), 18, Y(0.95) - Y(1.7)); c.fillStyle = '#e8a33a'; c.fillRect(tx, Y(0.92), 18, 10); }
    c.fillStyle = '#141414'; c.fillRect(x0, Y(0.5), W, Y(BUS_Y0) - Y(0.5)); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
// a box whose faces take their places on the paint: rects { px, nx, py, ny, pz, nz } (an atlas rect, or a swatch name)
function paintedBox(w, h, l, x, y, z, rects) {
  const g = new THREE.BoxGeometry(w, h, l).toNonIndexed(), uv = g.attributes.uv, faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  for (let f = 0; f < 6; f++) {
    let r = rects[faces[f]] ?? rects.all ?? 'white'; if (typeof r === 'string') { const sx = SW[r] + 8; r = [sx, 524, sx + 12, 536]; }
    for (let k = f * 6; k < f * 6 + 6; k++) uv.setXY(k, (r[0] + uv.getX(k) * (r[2] - r[0])) / 1024, 1 - (r[3] - uv.getY(k) * (r[3] - r[1])) / 1024);
  }
  g.translate(x, y, z); return g;
}
function mergeGeos(list) {
  const n = list.reduce((a, g) => a + g.attributes.position.count, 0), pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0; for (const g of list) { const k = g.attributes.position.count; pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); uv.set(g.attributes.uv.array, o * 2); o += k; g.dispose(); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}
function swatchUv(g, name) { const uv = g.attributes.uv, u = (SW[name] + 14) / 1024, v = 1 - 530 / 1024; for (let k = 0; k < uv.count; k++) uv.setXY(k, u, v); return g; }
// (for the design harness, design/pending/bus-look) one bus, as the instanced ones are drawn
export function mtaBusMesh(sbs = false, far = false, route = '', dest = '') {
  const G = cityBusGeometry(), m = new THREE.Mesh(far ? G.far : G.near, new THREE.MeshLambertMaterial({ map: busPaint(sbs) }));
  if (route) { const cv = document.createElement('canvas'); cv.width = SIGN_W; cv.height = SIGN_H; drawSign(cv.getContext('2d'), route, dest); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; m.add(new THREE.Mesh(signGeometry(), new THREE.MeshBasicMaterial({ map: t, toneMapped: false }))); }
  return m;
}
// → { near, far } geometries (her front toward −z, her middle at 0, her wheels on y = 0)
function cityBusGeometry() {
  const H = BUS_Y1 - BUS_Y0, yc = BUS_Y0 + H / 2, z = m => -BUS_L / 2 + m;   // (m from her front)
  const body = () => paintedBox(BUS_W, H, BUS_L, 0, yc, 0, { px: ATLAS.right, nx: ATLAS.left, nz: ATLAS.front, pz: ATLAS.rear, py: 'white', ny: 'black' });
  const parts = [body()];
  parts.push(paintedBox(2.2, 0.34, 4.6, 0, BUS_Y1 + 0.17, z(7.6), { all: 'pod' }));   // the air conditioning, over her back half
  parts.push(paintedBox(1.6, 0.16, 1.4, 0, BUS_Y1 + 0.08, z(1.6), { all: 'pod' }));    // (an escape hatch's housing, forward)
  // the bike rack, folded up against her bumper: its frame, two bars across and its ends
  for (const y of [0.62, 1.0]) parts.push(paintedBox(1.7, 0.05, 0.05, 0, y, z(-0.12), { all: 'rack' }));
  for (const sx of [-1, 1]) parts.push(paintedBox(0.05, 0.5, 0.05, sx * 0.85, 0.8, z(-0.12), { all: 'rack' }));
  parts.push(paintedBox(0.5, 0.06, 0.14, 0, 0.5, z(-0.06), { all: 'rack' }));   // (its hinge)
  for (const sx of [-1, 1]) {   // the mirrors, on their arms off her front corners
    parts.push(paintedBox(0.45, 0.05, 0.05, sx * (BUS_W / 2 + 0.2), 2.55, z(0.15), { all: 'black' }));
    parts.push(paintedBox(0.08, 0.42, 0.22, sx * (BUS_W / 2 + 0.42), 2.3, z(0.1), { all: 'black' }));
  }
  for (const a of BUS_AX) for (const sx of [-1, 1]) {   // the wheels: the tyre, the hub
    const t = new THREE.CylinderGeometry(0.5, 0.5, 0.3, 14).toNonIndexed(); t.rotateZ(Math.PI / 2); t.translate(sx * (BUS_W / 2 - 0.13), 0.5, z(a)); parts.push(swatchUv(t, 'tyre'));
    const hb = new THREE.CylinderGeometry(0.3, 0.3, 0.3, 12).toNonIndexed(); hb.rotateZ(Math.PI / 2); hb.translate(sx * (BUS_W / 2 - 0.09), 0.5, z(a)); parts.push(swatchUv(hb, 'hub'));
  }
  return { near: mergeGeos(parts), far: mergeGeos([body()]) };
}
// ── The destination signs (v1195, asked: "show each bus's real route on its sign"): over the windscreen, in the top of
// the first window on her kerb side, and her route's number in her back window, amber LEDs: her route and where she's
// bound (www/data/buses/mta-signs.json, design/buses/build_mta_signs.py: each route's usual headsign each way, from the
// MTA's timetables; the live feed gives her route and direction). Lit panels laid over her paint, a pool of them for the
// buses nearest the eye, each drawn again only when its bus or her sign changes.
const SIGN_W = 512, SIGN_H = 128;
function signGeometry() {
  const parts = [], plane = (w, h, u0, v0, u1, v1, ry, x, y, z) => {
    const g = new THREE.PlaneGeometry(w, h).toNonIndexed(), uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) * (u1 - u0), v0 + uv.getY(k) * (v1 - v0));
    g.rotateY(ry); g.translate(x, y, z); parts.push(g);
  };
  plane(2.2, 0.3, 0, 0.5, 1, 1, Math.PI, 0, 2.72, -BUS_L / 2 - 0.015);                  // over the windscreen
  plane(1.05, 0.17, 0, 0.5, 1, 1, Math.PI / 2, BUS_W / 2 + 0.015, 2.5, -BUS_L / 2 + 2.17);  // the kerb side: in the window by the front door
  plane(0.75, 0.3, 0, 0, 0.375, 0.5, 0, 0, 2.45, BUS_L / 2 + 0.015);                       // her back window: the route
  const n = parts.reduce((a, g) => a + g.attributes.position.count, 0), pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0; for (const g of parts) { pos.set(g.attributes.position.array, o * 3); uv.set(g.attributes.uv.array, o * 2); o += g.attributes.position.count; g.dispose(); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); return geo;
}
function drawSign(c, route, dest) {
  const AMBER = '#ffb422', fit = (text, x, y, w, px, align = 'left') => {
    c.font = `bold ${px}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`; const m = c.measureText(text).width, k = Math.min(1, w / (m || 1));
    c.save(); c.translate(x, y); c.scale(k, 1); c.textAlign = align; c.fillText(text, 0, 0); c.restore();
  };
  c.fillStyle = '#080808'; c.fillRect(0, 0, SIGN_W, SIGN_H);
  c.fillStyle = AMBER; c.textBaseline = 'middle';
  const r = route.replace(/\+$/, ''), rw = 118;
  fit(r, 8, 33, rw, 44);
  if (dest) { const words = dest.split(' via '); if (words.length > 1 && dest.length > 24) { fit(words[0], rw + 18, 20, SIGN_W - rw - 26, 24); fit('via ' + words.slice(1).join(' via '), rw + 18, 47, SIGN_W - rw - 26, 22); } else fit(dest, rw + 18, 33, SIGN_W - rw - 26, 30); }
  fit(r, 96, 96, 176, 50, 'center');   // (the back window's: her route alone, in rows 64-128, the first 192 px)
  c.fillStyle = 'rgba(0,0,0,0.5)';   // (the LEDs' grid)
  for (let x = 0; x < SIGN_W; x += 3) c.fillRect(x, 0, 1, SIGN_H);
  for (let y = 0; y < SIGN_H; y += 3) c.fillRect(0, y, SIGN_W, 1);
}
// her route as riders say it: 'M15' (+, Select Bus Service), the express buses (X, SIM, BxM, QM, BM)
function routeName(r) {
  const sbs = /\+$/.test(r), base = r.replace(/\+$/, '').replace(/^BX(?=\d)/, 'Bx').replace(/^BXM/, 'BxM');
  return sbs ? `${base} Select Bus Service` : /^(X|SIM|BxM|QM|BM)\d/.test(base) ? `${base} express` : base;
}
// her way, as New Yorkers say it: on Manhattan's grid (its avenues run 29° east of north) uptown, downtown, crosstown;
// elsewhere by the compass (the feed gives her direction only as 0 or 1, not where she's bound)
function wayOf(h, route) {
  const off = a => Math.abs(((h - a) % 360 + 540) % 360 - 180);
  if (/^M\d/.test(route)) return off(29) < 40 ? 'uptown' : off(209) < 40 ? 'downtown' : off(119) < 50 ? 'crosstown, east' : 'crosstown, west';
  return ['northbound', 'eastbound', 'southbound', 'westbound'][Math.round(h / 90) % 4];
}
export function makeMtaBuses({ scene, wx, wz, heightAt, laneAt = () => null, bbox, relay = () => relayUrl('birdseye'), roadDecks = () => null, focus = () => false, onCount, onDrop = () => {}, every = 30000 }) {
  const MAX = 6000, buses = new Map(), _v = new THREE.Vector3(), _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0);
  // four instanced meshes: a local bus and a Select Bus Service one, each close in (the whole model) and farther (her body)
  const G = cityBusGeometry(), NEAR = 350, meshes = [false, true].map(sbs => { const mat = new THREE.MeshLambertMaterial({ map: busPaint(sbs) });
    return [G.near, G.far].map((geo, k) => { const m = new THREE.InstancedMesh(geo, mat, k ? MAX : 600); m.count = 0; m.frustumCulled = false; m.castShadow = !k; scene.add(m); return m; }); });
  const all = meshes.flat(), mesh = { set count(n) { for (const m of all) m.count = n; if (!n) for (const sl of slots) { sl.m.visible = false; sl.p = null; } } };
  // the signs: the 24 buses nearest the eye, within 220 m (busSigns, above)
  let SIGNS = null; const slots = [], SIGN_GEO = signGeometry(), SLOTS = 24, SIGN_NEAR = 220;
  fetch('./data/buses/mta-signs.json').then(r => r.ok ? r.json() : null).then(j => { SIGNS = j?.signs || null; for (const sl of slots) sl.key = ''; }).catch(() => {});
  const signOf = p => SIGNS?.[p.route]?.[p.b?.dir === 1 ? 1 : 0] || '';
  function slotFor(p) {
    let sl = slots.find(q => q.p === p) || slots.find(q => !q.p);
    if (!sl && slots.length < SLOTS) {
      const cv = document.createElement('canvas'); cv.width = SIGN_W; cv.height = SIGN_H; const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      sl = { m: new THREE.Mesh(SIGN_GEO, new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })), cv, tex, key: '', p: null }; sl.m.visible = false; scene.add(sl.m); slots.push(sl);
    }
    return sl;
  }
  const tag = labelSprite(); tag.visible = false; scene.add(tag);
  let on = false, timer = null, hover = null, pinned = new Set(), deck = null;
  // the big bridges' decks by 25 m cell, with their line's heading: a bus there going the deck's way is on it (one
  // passing under it, on the FDR or an avenue, isn't)
  function deckAt(x, z, h) {
    if (!deck) { const D = roadDecks(); if (!D) return null; deck = new Map();
      for (const P of D) for (let i = 1; i < P.length; i++) { const a = P[i - 1], b = P[i], n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 10), dh = (Math.atan2(b.x - a.x, -(b.z - a.z)) / DEG + 360) % 360;
        for (let j = 0; j <= n; j++) { const x2 = a.x + (b.x - a.x) * j / n, z2 = a.z + (b.z - a.z) * j / n; deck.set(`${Math.floor(x2 / 25)},${Math.floor(z2 / 25)}`, [a.h + (b.h - a.h) * j / n, dh]); } } }
    const c = deck.get(`${Math.floor(x / 25)},${Math.floor(z / 25)}`); if (!c) return null;
    const d = Math.abs(((h - c[1]) % 180 + 270) % 180 - 90); return d > 65 ? c[0] : null;   // (along it, either way)
  }
  function data(j) {
    const now = Date.now(), seen = new Set();
    for (const b of j.buses || []) {
      const id = 'mta:' + b.id; seen.add(id);
      const fx = wx(b.lon), fz = wz(b.lat), at = now - (b.age || 0) * 1000;
      let p = buses.get(id);
      if (!p) {
        const g = new THREE.Group(); g.userData.helm = [-0.7, 2.2, -12.2 / 2 + 0.9]; scene.add(g);
        p = { kind: 'rail', bus: true, mta: true, id, g, group: g, L: 40, len: 12.2, x: fx, z: fz, y: 0, h: b.brg ?? 0, dh: b.brg ?? 0, v: 0, vKnown: false, from: { x: fx, z: fz }, to: { x: fx, z: fz }, t0: now, gap: every, fix: { t: at } };
        buses.set(id, p);
      }
      if (!p.lastAt || at > p.lastAt + 3000) {   // (a new report: from where she's drawn now to it, over the time since her last)
        const gap = p.lastAt ? Math.max(10e3, Math.min(90e3, at - p.lastAt)) : every;
        const d = Math.hypot(fx - p.to.x, fz - p.to.z);
        // (her speed from her two reports; faster than 45 mph is her GPS jumping, not her: her speed kept)
        if (p.lastAt && d / (gap / 1000) <= 20) { p.v = d / (gap / 1000); p.vKnown = true; } if (d > 600) { p.x = fx; p.z = fz; }   // (a jump: there at once)
        p.from = { x: p.x, z: p.z }; p.to = { x: fx, z: fz, lon: b.lon, lat: b.lat }; p.t0 = now; p.gap = gap; p.lastAt = at; p.fix.t = at;
        if (b.brg != null) p.brg = b.brg;
      }
      p.b = b; p.route = b.route;
      p.title = `${routeName(b.route)} bus${b.id ? ' ' + b.id : ''}`;
      p.a = { rail: 'MTA bus', trip: b.trip, from: '', dest: signOf(p) ? (signOf(p).replace(/^SELECT BUS /, '')) : '', next: `${routeName(b.route)} · ${wayOf(p.h, b.route)}` };
      p.label = `${routeName(b.route)}${p.vKnown ? (p.v >= 1 ? ` · about ${Math.round(p.v * 2.237)} mph` : ' · stopped') : ''}`;
      p.labelBase = p.label;
    }
    for (const [id, p] of buses) if (!seen.has(id)) { buses.delete(id); pinned.delete(p); if (hover === p) hover = null; onDrop(p); scene.remove(p.g); }
    onCount?.(buses.size);
  }
  async function poll() {
    if (!on) return;
    try { const r = await fetch(`${relay()}/mtabus?bbox=${bbox.map(v => v.toFixed(3)).join(',')}`, { cache: 'no-store' }); const j = await r.json(); if (on && r.ok) data(j); }
    catch (_) {}   // (the network's, quietly: again next time)
    if (on) timer = setTimeout(poll, every);
  }
  function update(dt, camera) {
    if (!on) { mesh.count = 0; tag.visible = false; return; }
    const now = Date.now(), cp = camera.position, cnt = [0, 0, 0, 0], close = []; let n = 0, label = null;
    for (const p of buses.values()) {
      const u = Math.max(0, Math.min(1, (now - p.t0) / p.gap)); let x = p.from.x + (p.to.x - p.from.x) * u, z = p.from.z + (p.to.z - p.from.z) * u;
      const mv = Math.hypot(p.to.x - p.from.x, p.to.z - p.from.z);
      const want = mv > 4 ? (Math.atan2(p.to.x - p.from.x, -(p.to.z - p.from.z)) / DEG + 360) % 360 : p.brg ?? p.h;
      p.hh ??= p.h; const turn = ((want - p.hh + 540) % 360) - 180; p.hh = (p.hh + Math.max(-90 * dt, Math.min(90 * dt, turn)) + 360) % 360;
      // (v1194: in her lane, square to her street, where there's one near going her way; p.hh her own heading, for that)
      const ln = Math.abs(x - cp.x) < 3000 && Math.abs(z - cp.z) < 3000 ? laneAt(x, z, p.hh) : null;
      if (ln) { x = ln.x; z = ln.z; } p.h = p.dh = ln ? ln.h : p.hh;
      if (p.yx == null || Math.hypot(x - p.yx, z - p.yz) > 5) {   // (her height, again when she's moved 5 m)
        p.yx = x; p.yz = z; const t = (x - p.from.x) / ((p.to.x - p.from.x) || 1);
        const lon = p.to.lon ?? 0, lat = p.to.lat ?? 0, gx = Math.max(0, heightAt(lon + (x - p.to.x) / (111320 * Math.cos(lat * DEG)), lat - (z - p.to.z) / 111120) || 0);
        p.yy = deckAt(x, z, p.h) ?? gx;
      }
      p.x = x; p.z = z; p.y = p.yy; p.g.position.set(x, p.y, z);
      {
        const d = Math.hypot(x - cp.x, p.y - cp.y, z - cp.z), w = Math.max(1, d * 0.0058 / 2.55);   // (far off, about 4 px wide, as the trains)
        if (d < SIGN_NEAR) close.push([d, p]);
        const set = meshes[/\+$/.test(p.route || '') ? 1 : 0], near = d < NEAR && cnt[set === meshes[1] ? 1 : 0] < 600, m = near ? set[0] : set[1], i = near ? cnt[set === meshes[1] ? 1 : 0]++ : cnt[set === meshes[1] ? 3 : 2]++;
        if (i < m.instanceMatrix.count) { m.setMatrixAt(i, _m4.compose(_p.set(x, p.y, z), _q.setFromAxisAngle(_y, -p.h * DEG), _s.set(w, Math.max(1, w * 0.5), Math.max(1, w * 0.4)))); n++; }
      }
      if (p === hover || pinned.has(p) || focus(p)) label = p;
    }
    // the nearest buses' signs: kept on the same bus while she's near, drawn again when her sign changes
    close.sort((a, b) => a[0] - b[0]); const lit = new Set(close.slice(0, SLOTS).map(c => c[1]));
    for (const sl of slots) if (sl.p && !lit.has(sl.p)) { sl.p = null; sl.m.visible = false; }
    for (const p of lit) {
      const sl = slotFor(p); if (!sl) continue; sl.p = p;
      const dest = signOf(p), key = `${p.route}|${dest}`;
      if (sl.key !== key) { sl.key = key; drawSign(sl.cv.getContext('2d'), p.route || '', dest); sl.tex.needsUpdate = true; }
      sl.m.position.set(p.x, p.y, p.z); sl.m.rotation.set(0, -p.h * DEG, 0); sl.m.visible = true;
    }
    meshes[0][0].count = cnt[0]; meshes[1][0].count = cnt[1]; meshes[0][1].count = cnt[2]; meshes[1][1].count = cnt[3]; for (const m of all) m.instanceMatrix.needsUpdate = true;
    tag.visible = !!label; if (label) { tag.position.set(label.x, label.y + 6, label.z); tag.userData.draw(label.label); }
  }
  return {
    start() { if (on) return; on = true; poll(); },
    stop() { on = false; clearTimeout(timer); for (const p of buses.values()) { onDrop(p); scene.remove(p.g); } buses.clear(); pinned.clear(); hover = null; mesh.count = 0; onCount?.(0); },
    update,
    at(cx, cy, camera, rect, reach = 22) {
      let best = null, bd = reach;
      for (const p of buses.values()) {
        _v.set(p.x, p.y + 1.5, p.z).project(camera); if (_v.z >= 1) continue;
        const d = Math.hypot(rect.left + (_v.x + 1) / 2 * rect.width - cx, rect.top + (1 - _v.y) / 2 * rect.height - cy);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    },
    set hover(p) { hover = p; },
    has: p => buses.get(p?.id) === p,
    items: () => [...buses.values()],
    toggle(p) { if (pinned.has(p)) pinned.delete(p); else pinned.add(p); },
    pin(id, show = true) { const p = buses.get(id); if (p) { if (show) pinned.add(p); else pinned.delete(p); } return !!p; },
    get count() { return buses.size; },
    list: () => [...buses.values()].map(p => ({ id: p.id, rail: 'MTA bus', route: p.route, v: +p.v.toFixed(1), h: Math.round(p.h), y: +p.y.toFixed(1), label: p.label })),
  };
}

// the trains' movers and the buses' as one (bay3d.js's `rail`): what's asked of one asked of all. (v1186: any number
// of bus layers, C&J's and the MTA's)
export function withBuses(trains, ...extra) {
  const all = [trains, ...extra], owner = p => all.find(m => m.has(p));
  return new Proxy(trains, {
    get(t, k) {
      switch (k) {
        case 'count': return all.reduce((a, m) => a + m.count, 0);
        case 'busCount': return extra.reduce((a, m) => a + m.count, 0);
        case 'has': return p => !!owner(p);
        case 'items': return () => all.flatMap(m => m.items());
        case 'list': return (c, r) => all.flatMap(m => m.list(c, r));
        case 'at': return (...a) => { for (const m of all) { const p = m.at(...a); if (p) return p; } return null; };
        case 'start': return () => all.forEach(m => m.start());
        case 'stop': return () => all.forEach(m => m.stop());
        case 'update': return (dt, cam) => all.forEach(m => m.update(dt, cam));
        case 'toggle': return p => owner(p)?.toggle(p);
        case 'pin': return (id, show) => all.some(m => m.pin(id, show));
        case 'buses': return extra[0];
        case 'layers': return extra;
      }
      const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) { if (k === 'hover') { for (const m of all) m.hover = v && m.has(v) ? v : null; return true; } t[k] = v; return true; },
  });
}
