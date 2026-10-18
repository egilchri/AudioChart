// Cruise ships, and the ferries' day, for the 3D views (v933; helm3d.js and bay3d.js).
// data/cruise_ships.json holds each call's track (planned by router.js at the ship's draft, see
// preprocess/build_cruise_tracks.js) and when it comes: on listed dates, or on a share of a season's days
// (picked from the date, so the same days for everyone). Times are local clock times.
import * as THREE from 'three';

// ── Which calls come on a day ──
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function dayChance(id, day) {   // 0..1, fixed for a call and a date
  let h = 2166136261;
  for (const ch of `${id}|${day}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h / 4294967296;
}
export function callsOn(data, date = new Date(), force = '') {
  const day = ymd(date), md = day.slice(5);
  return (data?.calls || []).filter(c => {
    if (force) return force === 'all' || force === c.id;
    if (c.dates) return c.dates.includes(day);
    if (c.season && (md < c.season[0] || md > c.season[1])) return false;
    return dayChance(c.id, day) < (c.chance ?? 0);
  });
}
export const mins = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// A track in the caller's world metres: points, cumulative lengths, total.
export function trackOf(lonlat, wx, wz) {
  const P = lonlat.map(([lo, la]) => [wx(lo), wz(la)]), c = [0];
  for (let i = 1; i < P.length; i++) c.push(c[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  return { P, c, L: c[c.length - 1], wx, wz };
}
export function alongTrack(T, f) {   // the point f metres along, and the heading there (degrees, 0 = north, clockwise)
  f = Math.max(0, Math.min(T.L, f));
  let i = 1; while (i < T.c.length - 1 && T.c[i] < f) i++;
  const [ax, az] = T.P[i - 1], [bx, bz] = T.P[i], k = (f - T.c[i - 1]) / ((T.c[i] - T.c[i - 1]) || 1);
  return { x: ax + (bx - ax) * k, z: az + (bz - az) * k, hdg: Math.atan2(bx - ax, -(bz - az)) * 180 / Math.PI };
}

// Where a cruise call's ship is at a clock time (minutes after local midnight): f metres along its track
// (from the sea end), heading, and what she's doing — or null when she isn't in the bay.
export function cruiseState(call, vessel, T, minute) {
  const run = T.L / (vessel.knots * 1852 / 60);   // minutes to steam the track
  if (call.arrive) {   // a big ship's call: in from the sea, at anchor all day, out again
    const a = mins(call.arrive), d = mins(call.depart);
    if (minute < a - run || minute > d + run) return null;
    if (minute < a) return { f: T.L * (minute - (a - run)) / run, dir: 1, doing: `bound for ${call.port}`, moving: true };
    if (minute <= d) return { f: T.L, dir: 1, doing: call.where, moving: false };
    return { f: T.L * (1 - (minute - d) / run), dir: -1, doing: `leaving ${call.port}`, moving: true };
  }
  const l = mins(call.leave), s = mins(call.stay);   // a small ship's leg: alongside at the start, under way, then in port
  if (minute < l - 120 || minute > s) return null;
  if (minute < l) return { f: 0, dir: 1, doing: `in ${call.where.replace(/^bound from (\w+).*/, '$1')}`, moving: false };
  if (minute < l + run) return { f: T.L * (minute - l) / run, dir: 1, doing: call.where, moving: true };
  return { f: T.L, dir: 1, doing: `in ${call.port}`, moving: false };
}

// A ferry's day in a view with a clock (Bird's-eye; v934): back and forth on her line between its ends
// through its stops, from service.start to service.end, the first boat leaving the service.first end
// ('to' is the island end of a mainland ferry), a few minutes at each landing. Summer hours and a season if
// she has them; out of season she's not shown. From the trip counts and terminal hours, not the timetable.
const dayCache = new WeakMap();
export function ferryDay(F, T, date = new Date()) {
  const key = ymd(date), hit = dayCache.get(F);
  if (hit && hit.key === key) return hit.day;
  const sv = F.service || { start: '06:00', end: '19:00', first: 'to' }, md = key.slice(5);
  let day = null;
  if (!sv.season || (md >= sv.season[0] && md <= sv.season[1])) {
    const summer = sv.summer && md >= sv.summer[0] && md <= sv.summer[1];
    const start = mins(summer ? sv.summer[2] : sv.start), end = mins(summer ? sv.summer[3] : sv.end);
    // where the stops are along the line (metres), ends included, in the order she meets them going 'to'
    const near = (lon, lat) => { let best = 0, bd = Infinity; for (let f = 0; f <= T.L; f += 10) { const p = alongTrack(T, f); const d = Math.hypot(p.x - T.wx(lon), p.z - T.wz(lat)); if (d < bd) { bd = d; best = f; } } return best; };
    const stops = [{ name: F.from, f: 0 }, ...(F.stops || []).map(s => ({ name: s.name, f: near(s.lon, s.lat) })), { name: F.to, f: T.L }].sort((a, b) => a.f - b.f);
    const out = sv.first === 'to' ? [...stops].reverse() : stops, round = [...out, ...[...out].reverse().slice(1)];
    const speed = F.knots * 1852 / 60, launch = F.kind === 'launch', segs = [];
    for (let t = start; t < end;) {   // round trips while the day lasts
      for (let i = 0; i + 1 < round.length && t < end; i++) {
        const a = round[i], b = round[i + 1], run = Math.abs(b.f - a.f) / speed;
        const bound = (b.f > a.f ? stops[stops.length - 1] : stops[0]).name;
        segs.push({ t0: t, t1: t + run, f0: a.f, f1: b.f, from: a.name, to: b.name, bound });
        t += run;
        const terminal = b === round[round.length - 1] || b.f === 0 || b.f === T.L;
        const dwell = terminal ? (launch ? 10 : 15) : 4;
        segs.push({ t0: t, t1: t + dwell, f0: b.f, f1: b.f, at: b.name }); t += dwell;
      }
    }
    day = { segs, start, end, firstF: out[0].f, firstName: out[0].name };
  }
  dayCache.set(F, { key, day });
  return day;
}
export function ferryState(F, T, minute, date = new Date()) {
  const day = ferryDay(F, T, date);
  if (!day) return null;
  const s = day.segs.find(g => minute >= g.t0 && minute < g.t1);
  if (!s) {   // before the first boat or after the last: alongside where she lies overnight
    const last = day.segs[day.segs.length - 1], f = minute < day.start || !last ? day.firstF : last.f1;
    return { f, dir: f > 0 ? -1 : 1, moving: false, at: minute < day.start ? day.firstName : (last.at || last.to) };
  }
  if (s.at) return { f: s.f0, dir: 1, moving: false, at: s.at };
  const k = (minute - s.t0) / (s.t1 - s.t0);
  return { f: s.f0 + (s.f1 - s.f0) * k, dir: s.f1 > s.f0 ? 1 : -1, moving: true, bound: s.bound, next: s.to };
}
// the day's departures from each landing, for the clock's "Coming up"
export const ferryDepartures = (F, T, date = new Date()) => (ferryDay(F, T, date)?.segs || []).filter(s => !s.at).map(s => ({ t: s.t0, from: s.from, to: s.bound }));

// ── The ships: bow toward −z, waterline at y = 0 ──
// windowMats: their lit windows' materials, for the caller to turn up at dusk (emissiveIntensity).
export function cruiseShipModel(V, windowMats = []) {
  const L = V.length_m, B = V.beam_m, big = L > 150, g = new THREE.Group();
  const M = c => new THREE.MeshLambertMaterial({ color: c });
  const white = M(0xf4f3ef), navy = M(0x1c2a44), red = M(0x8c2a22), glass = M(0x22303a), orange = M(0xe8731f), deck = M(0xb9a27c);
  const half = L / 2, taper = L * (big ? 0.2 : 0.17), hullH = big ? 14 : 5.5;
  const outline = [[-B / 2, half], [B / 2, half], [B / 2, -half + taper], [B * 0.18, -half], [-B * 0.18, -half], [-B / 2, -half + taper]];
  const slab = (y0, y1, m, sc = 1, zs = 1) => {
    const sh = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x * sc, -z * sc * zs)));
    const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: y1 - y0, bevelEnabled: false }), m);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = y0; g.add(mesh); return mesh;
  };
  slab(-2, 0.3, red, 0.995);
  slab(0.3, 1.6, navy);
  slab(1.6, hullH, white);
  // decks of cabins: window rows on a canvas, repeated along each deck's sides; the same rows lit, for night
  const rows = (lit, balc) => {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 32; const c = cv.getContext('2d');
    c.fillStyle = lit ? '#000' : '#f4f3ef'; c.fillRect(0, 0, 128, 32);
    c.fillStyle = lit ? '#fff' : '#2a3a48';
    for (let x = 4; x < 128; x += 16) c.fillRect(x, balc ? 6 : 10, 11, balc ? 20 : 12);
    if (balc && !lit) { c.fillStyle = '#cfd6da'; c.fillRect(0, 24, 128, 3); }   // the balcony rail
    const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  const tex = rows(false, big), lit = rows(true, big), DH = 3;
  const decks = big ? 8 : 4, superL = L * (big ? 0.8 : 0.72), superZ = L * 0.06;
  for (let i = 0; i < decks; i++) {
    const len = superL * (1 - i * (big ? 0.035 : 0.05)), w = B * (big ? 0.96 : 0.9);
    const rep = t => { t = t.clone(); t.needsUpdate = true; t.repeat.set(Math.round(len / 4), 1); return t; };
    const side = new THREE.MeshLambertMaterial({ map: rep(tex), emissive: 0xffdcaa, emissiveMap: rep(lit), emissiveIntensity: 0 });
    windowMats.push(side);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, DH, len), [side, side, white, white, side, side]);
    m.position.set(0, hullH + DH * i + DH / 2, superZ + (superL - len) / 2); g.add(m);
  }
  const topY = hullH + DH * decks;
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(B * 1.04, DH * 0.9, 6), white);   // bridge, wings out over the sides
  bridge.position.set(0, topY - DH * 1.45, superZ - superL / 2 + 3); g.add(bridge);
  const band = new THREE.Mesh(new THREE.BoxGeometry(B * 1.05, 1.1, 6.1), glass); band.position.set(0, topY - DH * 1.3, bridge.position.z); g.add(band);
  const sun = new THREE.Mesh(new THREE.BoxGeometry(B * 0.8, 0.4, superL * 0.5), deck);   // the open top deck
  sun.position.set(0, topY + 0.2, superZ + superL * 0.12); g.add(sun);
  const funnel = new THREE.Mesh(new THREE.BoxGeometry(B * 0.28, big ? 12 : 5, big ? 16 : 7), navy);
  funnel.position.set(0, topY + (big ? 6 : 2.5), superZ + superL * 0.3); funnel.rotation.x = -0.12; g.add(funnel);
  if (big) for (const sx of [-1, 1]) for (let z = -superL * 0.3; z < superL * 0.3; z += 13) {   // lifeboats along both sides
    const b = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.6, 10), orange); b.position.set(sx * (B / 2 + 0.6), hullH + 2.2, superZ + z); g.add(b);
  }
  // a wake, for when she's under way (userData.wake)
  const wc = document.createElement('canvas'); wc.width = 64; wc.height = 256;
  const c2 = wc.getContext('2d'), grd = c2.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, 'rgba(245,250,252,0.8)'); grd.addColorStop(1, 'rgba(245,250,252,0)');
  c2.fillStyle = grd; c2.beginPath(); c2.moveTo(22, 0); c2.lineTo(42, 0); c2.lineTo(64, 256); c2.lineTo(0, 256); c2.closePath(); c2.fill();
  const wake = new THREE.Mesh(new THREE.PlaneGeometry(B * 3, L * 1.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(wc), transparent: true, depthWrite: false }));
  wake.rotation.x = -Math.PI / 2; wake.position.set(0, 0.08, half + L * 0.8); g.add(wake);
  g.userData.wake = [wake];
  return g;
}

// A Maine State Ferry Service car ferry, simply, for the Bird's-eye view (the helm view has its own,
// closer-up model): red hull, white sides and house with windows, dark pilothouse glass.
export function ferryModelSimple(F, windowMats = []) {
  const L = F.length_m || 46, B = Math.min(12.2, L * 0.26), g = new THREE.Group(), half = L / 2, taper = L * 0.16;
  const M = c => new THREE.MeshLambertMaterial({ color: c });
  const outline = [[-B / 2, half], [B / 2, half], [B / 2, -half + taper], [B * 0.27, -half], [-B * 0.27, -half], [-B / 2, -half + taper]];
  const slab = (y0, y1, m) => {
    const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z))), { depth: y1 - y0, bevelEnabled: false }), m);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = y0; g.add(mesh);
  };
  slab(-1, 0.25, M(0x1d1f22)); slab(0.25, 2.2, M(0xc83a2e)); slab(2.2, 4.4, M(0xf3f2ee));
  const win = new THREE.MeshLambertMaterial({ color: 0xf3f2ee, emissive: 0xffd9a0, emissiveIntensity: 0 }); windowMats.push(win);
  const house = new THREE.Mesh(new THREE.BoxGeometry(B * 0.7, 2.6, L * 0.42), win); house.position.set(0, 5.7, -L * 0.06); g.add(house);
  const ph = new THREE.Mesh(new THREE.BoxGeometry(B * 0.5, 1.6, 5), M(0x22303a)); ph.position.set(0, 7.8, -L * 0.18); g.add(ph);
  g.userData.wake = [];
  return g;
}

// A small passenger launch (the Cranberry Isles boats): white hull with a blue sheer stripe, a long
// white cabin with windows, the wheelhouse forward. Bow toward −z, waterline at y = 0.
export function launchModel(F, windowMats = []) {
  const L = F.length_m || 14, B = L * 0.3, g = new THREE.Group(), half = L / 2;
  const M = c => new THREE.MeshLambertMaterial({ color: c });
  const sh = new THREE.Shape([[-B / 2, half], [B / 2, half], [B / 2, -half * 0.35], [0, -half], [-B / 2, -half * 0.35]].map(([x, z]) => new THREE.Vector2(x, -z)));
  const slab = (y0, y1, m) => { const k = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: y1 - y0, bevelEnabled: false }), m); k.rotation.x = -Math.PI / 2; k.position.y = y0; g.add(k); };
  slab(-0.8, 0.2, M(0x7a2a24)); slab(0.2, 1.3, M(0xf2f1ec)); slab(1.3, 1.55, M(0x23466e));
  const win = new THREE.MeshLambertMaterial({ color: 0xf2f1ec, emissive: 0xffd9a0, emissiveIntensity: 0 }); windowMats.push(win);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(B * 0.78, 1.9, L * 0.55), win); cabin.position.set(0, 2.5, L * 0.05); g.add(cabin);
  const band = new THREE.Mesh(new THREE.BoxGeometry(B * 0.8, 0.6, L * 0.56), M(0x26323b)); band.position.set(0, 2.7, L * 0.05); g.add(band);
  const wh = new THREE.Mesh(new THREE.BoxGeometry(B * 0.6, 1.2, 2.2), M(0xf2f1ec)); wh.position.set(0, 4.0, -L * 0.12); g.add(wh);
  g.userData.wake = [];
  return g;
}
