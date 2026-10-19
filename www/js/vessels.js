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
const inSummer = (sv, md) => !!(sv?.summer && md >= sv.summer[0] && md <= sv.summer[1]);
// her line on that date: in her summer hours a ferry with a summer_line takes it, for her summer stops
// (the mail boat's Sutton Island; v935)
export const ferryLine = (F, date = new Date()) => (F.summer_line && inSummer(F.service, ymd(date).slice(5)) ? F.summer_line : F.line);
export function ferryDay(F, T, date = new Date()) {
  const key = ymd(date), hit = dayCache.get(F);
  if (hit && hit.key === key) return hit.day;
  const sv = F.service || { start: '06:00', end: '19:00', first: 'to' }, md = key.slice(5);
  let day = null;
  if (!sv.season || (md >= sv.season[0] && md <= sv.season[1])) {
    const summer = inSummer(sv, md);
    const start = mins(summer ? sv.summer[2] : sv.start), end = mins(summer ? sv.summer[3] : sv.end);
    // where the stops are along the line (metres), ends included, in the order she meets them going 'to'
    const near = (lon, lat) => { let best = 0, bd = Infinity; for (let f = 0; f <= T.L; f += 10) { const p = alongTrack(T, f); const d = Math.hypot(p.x - T.wx(lon), p.z - T.wz(lat)); if (d < bd) { bd = d; best = f; } } return best; };
    const stops = [{ name: F.from, f: 0 }, ...(F.stops || []).filter(s => !s.summer || summer).map(s => ({ name: s.name, f: near(s.lon, s.lat) })), { name: F.to, f: T.L }].sort((a, b) => a.f - b.f);
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
  return { f: s.f0 + (s.f1 - s.f0) * k, dir: s.f1 > s.f0 ? 1 : -1, moving: true, bound: s.bound, next: s.to, f0: s.f0, f1: s.f1 };
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
  g.userData.helm = [0, topY - DH * 1.3, bridge.position.z - 3.3];   // on the bridge, at its forward windows (v937)
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

// A Maine State Ferry Service car ferry for the Bird's-eye view (v940, on request: "the deck of the ferry is ugly
// and unrealistic"; was three slabs and a box): red hull, black boot-top, a white sheer strake; the car deck open
// aft between white side casings, lane lines and the day's cars and trucks on it, the stern ramp raised; a closed
// forecastle at the bow; over the forward car deck the passenger house bridging the casings, its windows in rows
// (lit at night), a railed upper deck, the pilothouse forward on it with wrap-round glass and bridge wings, a mast
// with radar, and exhaust stacks in the casings. Her wake when she's under way. Bow toward −z, waterline y = 0.
function windowRows(len, lit, h = 32) {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = h; const c = cv.getContext('2d');
  c.fillStyle = lit ? '#000' : '#f3f2ee'; c.fillRect(0, 0, 128, h);
  c.fillStyle = lit ? '#fff' : '#26323b';
  for (let x = 6; x < 128; x += 21) c.fillRect(x, h * 0.3, 15, h * 0.42);
  const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.repeat.set(Math.max(1, Math.round(len / 4)), 1); return t;
}
function wakeOf(B, L) {
  const wc = document.createElement('canvas'); wc.width = 64; wc.height = 256;
  const c2 = wc.getContext('2d'), grd = c2.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, 'rgba(245,250,252,0.8)'); grd.addColorStop(1, 'rgba(245,250,252,0)');
  c2.fillStyle = grd; c2.beginPath(); c2.moveTo(22, 0); c2.lineTo(42, 0); c2.lineTo(64, 256); c2.lineTo(0, 256); c2.closePath(); c2.fill();
  const wake = new THREE.Mesh(new THREE.PlaneGeometry(B * 3, L * 1.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(wc), transparent: true, depthWrite: false }));
  wake.rotation.x = -Math.PI / 2; wake.position.set(0, 0.08, L / 2 + L * 0.8); return wake;
}
// a hull's waterplane, bow toward −z: parallel sides aft, rounding in over bowLen to a bow tip tipW wide (v942)
function roundBow(B, half, bowLen, tipW = 0, aftZ = half) {
  const pts = [[-B / 2, aftZ], [B / 2, aftZ], [B / 2, -half + bowLen]];
  for (let i = 1; i <= 10; i++) { const t = i / 10, a = t * Math.PI / 2; pts.push([tipW / 2 + (B / 2 - tipW / 2) * Math.cos(a) ** 0.8, -half + bowLen - bowLen * Math.sin(a)]); }
  for (let i = 10; i >= 1; i--) { const t = i / 10, a = t * Math.PI / 2; pts.push([-(tipW / 2 + (B / 2 - tipW / 2) * Math.cos(a) ** 0.8), -half + bowLen - bowLen * Math.sin(a)]); }
  pts.push([-B / 2, -half + bowLen]);
  return pts;
}
// her name on a board, for both sides (v942)
function nameBoard(text, w, h, bg = '#f3f2ee', fg = '#1d2328') {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 64; const c = cv.getContext('2d');
  c.fillStyle = bg; c.fillRect(0, 0, 512, 64); c.fillStyle = fg; c.font = 'bold 36px Helvetica, Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 256, 34);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshLambertMaterial({ map: t });
}
// running lights: small lamps, lit at night with the windows (their materials join windowMats)
function lamp(g, color, x, y, z, windowMats, r = 0.18) {
  const m = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0 }); windowMats.push(m);
  const k = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), m); k.position.set(x, y, z); g.add(k); return k;
}
export function ferryModelSimple(F, windowMats = []) {
  const L = F.length_m || 46, B = Math.min(12.2, L * 0.26), g = new THREE.Group(), half = L / 2, taper = L * 0.16;
  let sd = [...(F.name || 'ferry')].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 2147483647, 7) || 7;
  const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const M = c => new THREE.MeshLambertMaterial({ color: c });
  const white = M(0xf3f2ee), red = M(0xc83a2e), black = M(0x1d1f22), deckM = M(0x55585a), glass = M(0x1f2a32), grey = M(0x8d9296), yellow = M(0xe0b23a);
  const box = (w, h, d, x, y, z, m) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); k.position.set(x, y, z); g.add(k); return k; };
  const outline = roundBow(B, half, taper * 1.25, B * 0.3);
  const slab = (pts, y0, y1, m) => {
    const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z))), { depth: y1 - y0, bevelEnabled: false }), m);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = y0; g.add(mesh); return mesh;
  };
  const DK = 2.3, CAS = 2.7, TOP = DK + CAS, cw = 1.3;   // car deck height; casing height; casing width
  slab(outline, -1, 0.3, black); slab(outline, 0.3, DK - 0.25, red); slab(outline, DK - 0.25, DK, white);
  slab(roundBow(B + 0.3, half + 0.15, taper * 1.25, B * 0.3), DK - 0.8, DK - 0.5, black);   // the rubbing strake, standing proud
  // the car deck: asphalt grey, two yellow lane lines
  const fEnd = -half + taper * 1.25 + 0.4, deckLen = half - 0.3 - fEnd, deckZ = fEnd + deckLen / 2;   // (from the forecastle's after end to the stern)
  box(B - 2 * cw, 0.08, deckLen, 0, DK + 0.04, deckZ, deckM);
  for (const x of [-(B - 2 * cw) / 6, (B - 2 * cw) / 6]) box(0.14, 0.02, deckLen * 0.92, x, DK + 0.09, deckZ, yellow);
  // the forecastle: the bow closed in up to the casing tops, a grey deck on it
  const fwd = roundBow(B, half, taper * 1.25, B * 0.3, fEnd);
  slab(fwd, DK, TOP, white); slab(fwd, TOP, TOP + 0.08, grey);
  // on the forecastle: the anchor windlass, bollards each side (no jackstaff: it stood dead ahead of the helm's view)
  const fz = -half + taper * 0.55;
  box(B * 0.32, 0.7, 1.2, 0, TOP + 0.43, fz, M(0x3c4248));
  for (const sx of [-1, 1]) for (const dz of [-1.6, 1.4]) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.6, 8), black); b.position.set(sx * B * 0.3, TOP + 0.38, fz + dz); g.add(b); }
  // the side casings, with a red cap rail
  for (const sx of [-1, 1]) { box(cw, CAS, deckLen, sx * (B / 2 - cw / 2), DK + CAS / 2, deckZ, white); box(cw + 0.06, 0.12, deckLen, sx * (B / 2 - cw / 2), TOP + 0.06, deckZ, red); }
  // her name on the casings, forward, both sides
  if (F.vessel) { const nm = nameBoard(F.vessel); for (const sx of [-1, 1]) { const pl = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(10, L * 0.22), 1.2), nm); pl.position.set(sx * (B / 2 + 0.02), DK + CAS * 0.55, -half + taper + L * 0.12); pl.rotation.y = sx * Math.PI / 2; g.add(pl); } }
  // the stern ramp, raised
  const ramp = box(B - 2 * cw - 0.4, 3.0, 0.25, 0, DK + 1.5, half - 0.2, grey); ramp.rotation.x = 0.12;
  // the passenger house over the forward car deck, its windows in rows, and its upper deck rail
  const hLen = L * 0.34, hZ = fEnd + hLen / 2, hH = 2.7;
  const side = new THREE.MeshLambertMaterial({ map: windowRows(hLen, false), emissive: 0xffd9a0, emissiveMap: windowRows(hLen, true), emissiveIntensity: 0 });
  const endS = new THREE.MeshLambertMaterial({ map: windowRows(B, false), emissive: 0xffd9a0, emissiveMap: windowRows(B, true), emissiveIntensity: 0 });
  windowMats.push(side, endS);
  const house = new THREE.Mesh(new THREE.BoxGeometry(B, hH, hLen), [side, side, white, white, endS, endS]); house.position.set(0, TOP + hH / 2, hZ); g.add(house);
  const UP = TOP + hH;
  for (const sx of [-1, 1]) box(0.06, 0.9, hLen, sx * (B / 2 - 0.05), UP + 0.45, hZ, white);   // the rail round the upper deck
  box(B, 0.9, 0.06, 0, UP + 0.45, hZ + hLen / 2 - 0.03, white);
  // the pilothouse forward on the upper deck: white, wrap-round glass, bridge wings out to the sides
  const pL = 4.6, pZ = hZ - hLen / 2 + pL / 2 + 0.4, pH = 2.4;
  box(B * 0.56, pH, pL, 0, UP + pH / 2, pZ, white);
  box(B * 0.56 + 0.04, 0.95, pL + 0.04, 0, UP + pH * 0.62, pZ, glass);
  box(B * 0.98, 0.2, 1.8, 0, UP + 1.0, pZ - pL / 2 + 0.9, white);   // the wings
  box(B * 0.58, 0.18, pL + 0.5, 0, UP + pH + 0.09, pZ, white);       // her roof, a little overhang
  // the mast and radar, the exhaust stacks in the casings abaft the house
  box(0.18, 3.2, 0.18, 0, UP + pH + 1.7, pZ + 0.6, white);
  const radar = box(1.8, 0.14, 0.3, 0, UP + pH + 2.9, pZ + 0.6, black); radar.rotation.y = 0.5;
  box(0.02, 0.6, 1.0, 0, UP + pH + 2.6, pZ + 1.2, M(0x2a3f7a));   // the flag, on the mast
  // running lights: masthead, sidelights at the wing ends, stern light on the ramp; liferaft canisters aft on the upper deck
  lamp(g, 0xfff2d6, 0, UP + pH + 3.25, pZ + 0.6, windowMats);
  lamp(g, 0xff3b2e, -B * 0.49, UP + 1.3, pZ - pL / 2 + 0.9, windowMats); lamp(g, 0x3dff7a, B * 0.49, UP + 1.3, pZ - pL / 2 + 0.9, windowMats);
  lamp(g, 0xfff2d6, 0, DK + 3.2, half - 0.1, windowMats);
  for (const sx of [-1, 1]) for (const dz of [-1.1, 0]) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.4, 10), white); c.rotation.x = Math.PI / 2; c.position.set(sx * (B / 2 - 0.9), UP + 0.5, hZ + hLen / 2 - 1.2 + dz); g.add(c); }
  for (const sx of [-1, 1]) { box(0.9, 2.4, 1.4, sx * (B / 2 - cw / 2), TOP + 1.2, hZ + hLen / 2 + 2.2, white); box(0.92, 0.5, 1.42, sx * (B / 2 - cw / 2), TOP + 2.4, hZ + hLen / 2 + 2.2, black); }
  // the day's cars and trucks on the open deck aft, in their lanes
  const COLS = [0xb8bcc0, 0x2a2d31, 0x8b1e1e, 0x2c4a6e, 0xe9e9e6, 0x5a6b4e, 0x9a8a6c, 0x6c7378];
  const lanes = [-(B - 2 * cw) / 3, 0, (B - 2 * cw) / 3], z0 = hZ + hLen / 2 + 1.2, z1 = half - 1.6;
  for (const x of lanes) for (let z = z0; z < z1 - 4;) {
    if (rnd() < 0.18) { z += 3; continue; }   // a gap
    const truck = rnd() < 0.18, len = truck ? 7.5 : 4.5, h = truck ? 2.9 : 1.5, col = COLS[Math.floor(rnd() * COLS.length)];
    if (z + len > z1) break;
    const cz = z + len / 2;
    box(1.9, h * 0.62, len, x, DK + 0.25 + h * 0.31, cz, M(col));
    if (truck) box(1.95, h * 0.42, len * 0.72, x, DK + 0.25 + h * 0.62 + h * 0.21, cz + len * 0.12, M(rnd() < 0.5 ? 0xe9e9e6 : col));   // the box
    else box(1.7, h * 0.36, len * 0.5, x, DK + 0.25 + h * 0.62 + h * 0.18, cz + 0.2, glass);   // the cab, its windows
    z += len + 0.9;
  }
  g.userData.helm = [0, UP + 1.65, pZ - pL / 2 + 0.7];   // in the pilothouse, at its forward windows
  g.userData.wake = [wakeOf(B, L)]; g.add(g.userData.wake[0]);
  return g;
}

// A Cranberry Isles passenger launch (v942, on request: "upgrade the appearance of all ferries"; was a wedge and two
// boxes): a Downeast hull, white with a navy sheer stripe and red bottom, her bow rising and rounded in plan; the
// wheelhouse forward with a raked windshield; a long passenger cabin aft of it with rows of windows (lit at night),
// a white roof with life rings, a radar mast; an open after deck with rails; her name on the bow; running lights;
// a wake under way. Bow toward −z, waterline y = 0.
export function launchModel(F, windowMats = []) {
  const L = F.length_m || 14, B = L * 0.3, g = new THREE.Group(), half = L / 2;
  const M = c => new THREE.MeshLambertMaterial({ color: c });
  const white = M(0xf2f1ec), navy = M(0x23466e), redB = M(0x7a2a24), glass = M(0x1f2a32), teak = M(0x9b7b55), grey = M(0x8d9296);
  const box = (w, h, d, x, y, z, m) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); k.position.set(x, y, z); g.add(k); return k; };
  const plan = roundBow(B, half, L * 0.42, 0.25);
  const slab = (pts, y0, y1, m, sc = 1) => {
    const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x * sc, -z))), { depth: y1 - y0, bevelEnabled: false }), m);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = y0; g.add(mesh); return mesh;
  };
  const SH = 1.45;   // sheer height amidships
  slab(plan, -0.8, 0.05, redB, 0.92); slab(plan, 0.05, 0.18, M(0x1d1f22), 0.97); slab(plan, 0.18, SH - 0.22, white); slab(plan, SH - 0.22, SH, navy);
  // the bow rising: a raised forward section of the sheer, white with the stripe carried up
  const fore = roundBow(B, half, L * 0.42, 0.25, -half + L * 0.46);
  slab(fore, SH, SH + 0.35, white); slab(fore, SH + 0.35, SH + 0.5, navy);
  slab(roundBow(B - 0.2, half - 0.1, L * 0.42, 0.2, -half + L * 0.46), SH + 0.5, SH + 0.53, M(0xd9d6cc));   // the foredeck on it, non-skid grey
  slab(roundBow(B - 0.16, half - 0.08, L * 0.42, 0.2), SH - 0.05, SH + 0.02, teak);   // the deck
  // the wheelhouse forward: raked windshield (a slanted glass face), side windows, white roof
  const wz0 = -half + L * 0.3, wLen = 2.4, wW = B * 0.82, wH = 1.9, wy = SH;
  box(wW, wH, wLen, 0, wy + wH / 2, wz0 + wLen / 2, white);
  const ws = box(wW + 0.02, 0.9, 0.08, 0, wy + wH * 0.66, wz0 - 0.12, glass); ws.rotation.x = -0.32;
  for (const sx of [-1, 1]) box(0.04, 0.8, wLen * 0.8, sx * (wW / 2 + 0.01), wy + wH * 0.68, wz0 + wLen / 2, glass);
  // the passenger cabin aft of the wheelhouse, a little narrower, windows in rows
  const cz0 = wz0 + wLen, cLen = L * 0.38, cW = B * 0.8, cH = 1.75;
  const side = new THREE.MeshLambertMaterial({ map: windowRows(cLen, false), emissive: 0xffd9a0, emissiveMap: windowRows(cLen, true), emissiveIntensity: 0 });
  const endS = new THREE.MeshLambertMaterial({ map: windowRows(cW, false), emissive: 0xffd9a0, emissiveMap: windowRows(cW, true), emissiveIntensity: 0 });
  windowMats.push(side, endS);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(cW, cH, cLen), [side, side, white, white, endS, endS]); cabin.position.set(0, SH + cH / 2, cz0 + cLen / 2); g.add(cabin);
  // the roof over both, overhanging aft as an awning; life rings on it; the radar mast
  const rz0 = wz0 - 0.15, rLen = wLen + cLen + 1.6;
  box(B * 0.88, 0.12, rLen, 0, SH + wH + 0.06, rz0 + rLen / 2, white);
  for (const sx of [-1, 1]) box(0.08, wH - 0.05, 0.08, sx * B * 0.4, SH + wH / 2, rz0 + rLen - 0.1, white);   // the awning's posts
  const ringM = M(0xe8731f);
  for (const sx of [-1, 1]) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.08, 6, 14), ringM); r.position.set(sx * (cW / 2 + 0.03), SH + cH * 0.55, cz0 + cLen * 0.5); r.rotation.y = Math.PI / 2; g.add(r); }
  box(0.1, 1.6, 0.1, 0, SH + wH + 0.9, wz0 + wLen * 0.6, white);
  const radar = box(1.1, 0.1, 0.22, 0, SH + wH + 1.6, wz0 + wLen * 0.6, M(0x1d1f22)); radar.rotation.y = 0.6;
  // the after deck: rails round it, a bench across the transom
  const az0 = cz0 + cLen, aLen = half - az0;
  for (const sx of [-1, 1]) box(0.05, 0.8, aLen, sx * (B / 2 - 0.06), SH + 0.4, az0 + aLen / 2, grey);
  box(B - 0.1, 0.05, 0.05, 0, SH + 0.8, half - 0.05, grey);
  box(B * 0.7, 0.45, 0.45, 0, SH + 0.22, half - 0.5, teak);
  // her name on the bow, both sides
  if (F.vessel) { const nm = nameBoard(F.vessel, 3, 0.5, '#f2f1ec', '#23466e'); for (const sx of [-1, 1]) { const pl = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(3.6, L * 0.25), 0.42), nm); pl.position.set(sx * (B / 2 - 0.02), SH - 0.55, -half + L * 0.26); pl.rotation.y = sx * Math.PI / 2 + sx * 0.12; g.add(pl); } }
  // running lights: masthead, sidelights on the wheelhouse, stern light
  lamp(g, 0xfff2d6, 0, SH + wH + 1.75, wz0 + wLen * 0.6, windowMats, 0.1);
  lamp(g, 0xff3b2e, -(wW / 2 + 0.06), SH + wH - 0.2, wz0 + 0.3, windowMats, 0.09); lamp(g, 0x3dff7a, wW / 2 + 0.06, SH + wH - 0.2, wz0 + 0.3, windowMats, 0.09);
  lamp(g, 0xfff2d6, 0, SH + 0.9, half - 0.05, windowMats, 0.08);
  g.userData.helm = [0, SH + 1.6, wz0 + 0.7];   // in the wheelhouse, at the windshield
  g.userData.wake = [wakeOf(B, L)]; g.add(g.userData.wake[0]);
  return g;
}
