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
  if (F.timetable) { const day = timetableDay(F, T, date); dayCache.set(F, { key, day }); return day; }
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
// A ferry run to her published timetable (v993, Casco Bay Lines; preprocess/build_cbl.py): F.timetable lists, for
// each period of the year (month-day ranges) and day of the week, a variant of the day; a variant is each boat's
// day, segments [t0, t1, a, b, bound] under way from landing a to landing b (indices into her landings: F.from,
// F.stops, F.to, in order along her line) bound for landing `bound`, or [t0, t1, a] alongside at a. F.bi says
// which of her boats this is.
function timetableDay(F, T, date) {
  const md = ymd(date).slice(5), tt = F.timetable;
  const per = tt.periods.find(p => p.md[0] <= p.md[1] ? md >= p.md[0] && md <= p.md[1] : md >= p.md[0] || md <= p.md[1]);
  const vi = per?.days[date.getDay()], segsIn = vi == null ? null : tt.variants[vi]?.[F.bi || 0];
  if (!segsIn?.length) return null;
  const near = (lon, lat) => { let best = 0, bd = Infinity; for (let f = 0; f <= T.L; f += 10) { const p = alongTrack(T, f); const d = Math.hypot(p.x - T.wx(lon), p.z - T.wz(lat)); if (d < bd) { bd = d; best = f; } } return best; };
  const land = [{ name: F.from, f: 0 }, ...(F.stops || []).map(st => ({ name: st.name, f: near(st.lon, st.lat) })), { name: F.to, f: T.L }];
  const segs = segsIn.map(([t0, t1, a, b, bound]) => b == null ? { t0, t1, f0: land[a].f, f1: land[a].f, at: land[a].name }
    : { t0, t1, f0: land[a].f, f1: land[b].f, from: land[a].name, to: land[b].name, bound: land[bound ?? b].name });
  return { segs, start: segs[0].t0, end: segs[segs.length - 1].t1, firstF: segs[0].f0, firstName: segs[0].at || segs[0].from };
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
// A cruise ship (v947, on request: "Can we make the cruise ship more realistic?"; was stacked boxes on a slab).
// The hull lofted from stations: a fine, flared bow with a raked stem, full sections amidships, a transom stern; red
// below the waterline, a black boot-top, the hull colour above (dark navy for the big ship, white for the small
// coastal one). The superstructure in decks, each rounded at its forward end, with rows of balconies (or windows)
// along the sides, lit at night, the after decks stepping down in terraces; the lifeboats in their davits along
// both sides; the bridge with its wings out past the hull and an observation lounge above it; a raked, shaped
// funnel; pools and a sun deck on top; a mast with radar domes; her wake under way.
export function cruiseShipModel(V, windowMats = []) {
  const L = V.length_m, B = V.beam_m, big = L > 150, g = new THREE.Group(), half = L / 2;
  const M = (c, o = {}) => new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide, ...o });
  const white = M(0xf4f3ef), hullC = M(big ? 0x24395f : 0xf2f1ec), red = M(0x8c2a22), black = M(0x16191d), glass = M(0x22303a), teak = M(0xb9a27c),
    orange = M(0xe8731f), blue = M(0x2f86b8), navy = M(0x24395f), grey = M(0x8d9296);
  const D = big ? 8.5 : 3.2, HH = big ? 14 : 5.5;   // draft; the hull's height above the water
  // ── the hull: half-breadth by station u (0 at the bow) and height y; the stem raked, the stern a transom ──
  const fU = u => u < 0.38 ? Math.pow(Math.sin(u / 0.38 * Math.PI / 2), 0.72) : u > 0.9 ? 1 - (u - 0.9) * 0.8 : 1;
  const gY = y => y < 0 ? 1 - Math.pow(-y / D, 2) * 0.32 : 1 + Math.min(1, y / HH) * 0.015;   // the bilge below, a little flare above
  const bowZ = y => -half + (big ? 0.06 : 0.03) * L * (1 - (y + D) / (HH + D)) ** 1.4, sternZ = y => half - 0.025 * L * (1 - (y + D) / (HH + D));
  const at = (u, y, sd) => { const z = bowZ(y) + u * (sternZ(y) - bowZ(y)); return [sd * B / 2 * fU(u) * gY(y), y, z]; };
  const band = (y0, y1, m) => {
    const N = 56, pos = [], idx = [];
    for (const sd of [-1, 1]) {
      const o = pos.length / 3;
      for (let k = 0; k <= N; k++) { const u = k / N; pos.push(...at(u, y0, sd), ...at(u, y1, sd)); }
      for (let k = 0; k < N; k++) { const a = o + k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const o = pos.length / 3; pos.push(...at(1, y0, -1), ...at(1, y0, 1), ...at(1, y1, -1), ...at(1, y1, 1)); idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);   // the transom
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
    g.add(new THREE.Mesh(geo, m));
  };
  band(-D, -0.05, red); band(-0.05, big ? 0.9 : 0.4, black); band(big ? 0.9 : 0.4, HH - (big ? 0.8 : 0.4), hullC); band(HH - (big ? 0.8 : 0.4), HH, big ? white : navy);
  { const pts = []; for (let k = 0; k <= 40; k++) pts.push(at(k / 40, HH, 1)); for (let k = 40; k >= 0; k--) pts.push(at(k / 40, HH, -1));   // the main deck, over the hull
    const sh = new THREE.Shape(pts.map(([x, , z]) => new THREE.Vector2(x, -z))), dg = new THREE.ShapeGeometry(sh); dg.rotateX(-Math.PI / 2); dg.translate(0, HH, 0); g.add(new THREE.Mesh(dg, grey)); }
  const box = (w, h, d, x, y, z, m) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); k.position.set(x, y, z); g.add(k); return k; };
  // ── the superstructure (v952, on request: "make the cruise ship's superstructure less boxy too"): each deck a
  // house with a bow-shaped nose, its front stepping back deck by deck in a curve, so the forward face sweeps up and
  // aft in one streamlined line; the sides falling in a little (tumblehome) and the after corners rounded; the after
  // decks stepping down in rounded terraces; a deck edge overhanging between decks. Balconies (or windows) wrap round.
  const DH = 3, decks = big ? 9 : 4, sFront = -half + (big ? 0.2 : 0.22) * L, sAft = half - (big ? 0.05 : 0.12) * L, wS = B / 2 * (big ? 0.985 : 0.88);
  const rows = (balc, lit) => {   // a cabin each 4 m (a balcony with its rail, or a window), repeated round the deck
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; const c = cv.getContext('2d');
    c.fillStyle = lit ? '#000' : '#f4f3ef'; c.fillRect(0, 0, 64, 64);
    if (balc) { c.fillStyle = lit ? '#ffffff' : '#2a3a48'; c.fillRect(6, 10, 52, 40); if (!lit) { c.fillStyle = '#9fb0ba'; c.fillRect(6, 34, 52, 16); c.fillStyle = '#f4f3ef'; c.fillRect(0, 10, 4, 50); c.fillRect(60, 10, 4, 50); c.fillStyle = '#dfe5e8'; c.fillRect(6, 33, 52, 2); } }
    else { c.fillStyle = lit ? '#fff' : '#2a3a48'; c.fillRect(10, 20, 44, 20); }
    const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  const balcM = new THREE.MeshLambertMaterial({ map: rows(true, false), emissive: 0xffdcaa, emissiveMap: rows(true, true), emissiveIntensity: 0 });
  const winM = new THREE.MeshLambertMaterial({ map: rows(false, false), emissive: 0xffdcaa, emissiveMap: rows(false, true), emissiveIntensity: 0 });
  const glassM = new THREE.MeshLambertMaterial({ map: glassBand(false), emissive: 0xffdcaa, emissiveMap: glassBand(true), emissiveIntensity: 0 });
  windowMats.push(balcM, winM, glassM);
  // a deck's plan: straight sides, a nose nl long (a superellipse quarter each side, blunt like the bow under it),
  // the after corners rounded to r; resampled to 64 points evenly round, starting aft on the centreline
  const plan = (w, z0, z1, nl, r) => {
    const P = [[0, z1]];
    for (let k = 0; k <= 6; k++) { const a = k / 6 * Math.PI / 2; P.push([w - r + r * Math.sin(a), z1 - r + r * Math.cos(a)]); }
    for (let k = 0; k <= 16; k++) { const s2 = k / 16; P.push([w * Math.pow(1 - s2 ** 1.8, 1 / 1.8), z0 + nl * (1 - s2)]); }
    for (let k = P.length - 2; k >= 1; k--) P.push([-P[k][0], P[k][1]]);
    P.push([0, z1]);
    const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]));
    const out = []; let j = 0;
    for (let i = 0; i < 64; i++) { const d = i / 64 * cum[cum.length - 1]; while (cum[j + 1] < d) j++; const t = (d - cum[j]) / ((cum[j + 1] - cum[j]) || 1); out.push([P[j][0] + (P[j + 1][0] - P[j][0]) * t, P[j][1] + (P[j + 1][1] - P[j][1]) * t]); }
    return out;
  };
  const step = i => big ? 0.6 * i + 0.24 * i * i : 0.3 * i + 0.12 * i * i;   // the forward face's setback, deck by deck: a curve
  const nl = wS * (big ? 1.25 : 1.1), tum = big ? 0.12 : 0.06;
  const deckGeom = i => {
    const terr = Math.max(0, i - (decks - (big ? 4 : 2))), zA = sAft - terr * (big ? 0.045 : 0.07) * L, w = wS - tum * i - (i === decks - 1 ? 0.6 : 0);
    return { w, zF: sFront + step(i), zA, rake: step(i + 1) - step(i), r: terr ? (big ? 7 : 3) : (big ? 4 : 1.5) };
  };
  let topZF = sFront, topZA = sAft;
  for (let i = 0; i < decks; i++) {
    const { w, zF, zA, rake, r } = deckGeom(i);
    const d = deckhouse({ H: DH, roof: 0.3, roofT: 0.22, side: big && i >= 1 && i < decks - 1 ? balcM : winM, top: white,
      outline: (f, grow = 0) => plan(w - tum * f + grow, zF + rake * f - grow, zA + grow, nl, r + grow) });
    d.position.y = HH + i * DH; g.add(d);
    topZF = zF + rake; topZA = zA;
  }
  const topY = HH + decks * DH + 0.22;
  // the lifeboats in their davits along both sides, over the promenade: rounded hulls, orange, under white canopies
  if (big) for (const sd of [-1, 1]) for (let z = sFront + 0.1 * L; z < sFront + 0.62 * L; z += 15) {
    const x = sd * (wS + 2.2), y = HH + DH * 1.4;
    const hb = new THREE.Mesh(new THREE.CapsuleGeometry(1.6, 7.6, 4, 12), orange); hb.rotation.x = Math.PI / 2; hb.scale.set(1.1, 1, 0.75); hb.position.set(x, y - 0.4, z); g.add(hb);
    const cn = new THREE.Mesh(new THREE.CapsuleGeometry(1.45, 6.8, 4, 12), white); cn.rotation.x = Math.PI / 2; cn.scale.set(1.05, 1, 0.8); cn.position.set(x, y + 0.5, z); g.add(cn);
    for (const dz of [-4, 4]) { const dv = box(0.4, 3.6, 0.4, sd * (wS + 1.0), HH + DH * 1.6, z + dz, grey); dv.rotation.z = -sd * 0.25; }   // the davits, leaning out
  }
  // the bridge: a deck of glass leaning out at the top, wrapping round the front of the deck below the top; its
  // wings tapering out past the hull either side, glassed cabs at their ends
  const bi = decks - 2, bd = deckGeom(bi), brY = HH + bi * DH + DH / 2, brZ = bd.zF, bLen = big ? 16 : 7, bw = bd.w + 0.25;
  { const bh = deckhouse({ H: DH * 0.9, roof: 0.45, roofT: 0.25, side: glassM, top: white,
      outline: (f, grow = 0) => plan(bw + 0.25 * f + grow, brZ - 0.25 - 0.5 * f - grow, brZ + bLen + grow, nl, 1 + grow) });
    bh.position.y = HH + bi * DH + 0.05; g.add(bh);
    const wx = B / 2 + (big ? 2 : 1), wz0 = brZ + nl * 0.75, wD0 = big ? 7 : 3, wD1 = big ? 3.2 : 1.5;
    for (const sd of [-1, 1]) {
      const sh = new THREE.Shape([[sd * bw * 0.9, wz0], [sd * wx, wz0 + 0.3], [sd * wx, wz0 + wD1], [sd * bw * 0.9, wz0 + wD0]].map(([x, z]) => new THREE.Vector2(x, -z)));
      const wg = new THREE.ExtrudeGeometry(sh, { depth: DH * 0.25, bevelEnabled: false }); wg.rotateX(-Math.PI / 2); wg.translate(0, brY + DH * 0.2, 0); g.add(new THREE.Mesh(wg, white));
      box(big ? 1.6 : 0.8, DH * 0.6, wD1 - 0.3, sd * (wx - (big ? 0.8 : 0.4)), brY + DH * 0.75, wz0 + wD1 / 2 + 0.15, glass);   // the cab at the wing's end
    }
  }
  // the observation lounge on top, forward: its glass front raked aft, wrapping round
  { const lw = wS * 0.8, lz = topZF + 1, lL = big ? 30 : 12;
    const lo = deckhouse({ H: DH * 0.9, roof: 0.35, roofT: 0.2, side: glassM, top: white,
      outline: (f, grow = 0) => plan(lw - 0.3 * f + grow, lz + (big ? 2.2 : 1) * f - grow, lz + lL + grow, lw * 1.1, 2 + grow) });
    lo.position.y = topY; g.add(lo); }
  // the sun deck, pools, the funnel aft of midships, the mast
  box(B * 0.7, 0.3, (topZA - topZF) * 0.55, 0, topY + 0.15, (topZF + topZA) / 2 + 6, teak);
  if (big) { box(10, 0.4, 16, 0, topY + 0.35, (topZF + topZA) / 2 - 4, blue); box(8, 0.4, 10, 0, topY + 0.35, (topZF + topZA) / 2 + 22, blue); }
  else box(4, 0.4, 6, 0, topY + 0.35, (topZF + topZA) / 2 + 4, blue);
  { const fH = big ? 15 : 6, fL = big ? 22 : 8, fW = B * (big ? 0.32 : 0.3), fz = (topZF + topZA) / 2 + (big ? 30 : 10);
    const prof = new THREE.Shape([[-fL / 2, 0], [fL / 2, 0], [fL / 2 + fH * 0.32, fH], [-fL / 2 + fH * 0.42, fH]].map(([z, y]) => new THREE.Vector2(z, y)));   // raked aft
    const fg = new THREE.ExtrudeGeometry(prof, { depth: fW, bevelEnabled: true, bevelSize: fW * 0.2, bevelThickness: fW * 0.2, bevelSegments: 3 });
    fg.rotateY(-Math.PI / 2); fg.translate(fW / 2, topY, fz);
    g.add(new THREE.Mesh(fg, big ? navy : white));
    box(fW * 1.3, fH * 0.12, fL * 0.9, 0, topY + fH * 0.95, fz + fH * 0.38, black);   // the soot-black top
    if (!big) box(fW * 1.31, fH * 0.12, fL * 0.75, 0, topY + fH * 0.55, fz + fH * 0.2, navy); }   // the small ship's band
  { const mz = brZ + (big ? 10 : 5), mh = big ? 9 : 4;
    box(0.5, mh, 0.5, 0, topY + DH + mh / 2, mz, white);
    for (const dx of [-1.6, 1.6]) { const dome = new THREE.Mesh(new THREE.SphereGeometry(big ? 1.2 : 0.6, 12, 8), white); dome.position.set(dx, topY + DH + mh * 0.75, mz); g.add(dome); }
    const rd = box(big ? 5 : 2.4, 0.3, 0.6, 0, topY + DH + mh, mz, black); rd.rotation.y = 0.4; }
  // mooring gear on the foredeck
  for (const dz of [0.04, 0.09]) for (const sd of [-1, 1]) { const k = big ? 1.6 : 0.7; box(k, k * 0.6, k, sd * B * 0.18, HH + k * 0.3, -half + dz * L + (big ? 8 : 3), black); }
  g.userData.helm = [0, brY + 1.2, brZ + 0.4];   // on the bridge, at its forward windows
  g.userData.wake = [wakeOf(B, L)]; g.add(g.userData.wake[0]);
  return g;
}

// A Maine State Ferry Service car ferry for the Bird's-eye view (v940, on request: "the deck of the ferry is ugly
// and unrealistic"; was three slabs and a box): red hull, black boot-top, a white sheer strake; the car deck open
// aft between white side casings, lane lines and the day's cars and trucks on it, the stern ramp raised; a closed
// forecastle at the bow; over the forward car deck the passenger house bridging the casings, its windows in rows
// (lit at night), a railed upper deck, the pilothouse forward on it with wrap-round glass and bridge wings, a mast
// with radar, and exhaust stacks in the casings. Her wake when she's under way. Bow toward −z, waterline y = 0.
function windowRows(len, lit, h = 32, bg = '#f3f2ee') {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = h; const c = cv.getContext('2d');
  c.fillStyle = lit ? '#000' : bg; c.fillRect(0, 0, 128, h);
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
// ── A lofted hull (v950, on request: "go to work on the shape of the topsides of all ferries. They need graceful
// sheer lines, and a much more hollowed out, non-boxy look"). The way a designer draws lines: the hull is a smooth
// surface defined at every station u (0 at the transom, 1 at the stem) by a few curves along the length:
//  · the sheer, hs(u): the deck edge's height, lowest a little aft of amidships and sweeping up to the bow (and a
//    little at the stern), a parabola each way, as a sheer is sprung with a batten;
//  · the waterline, its half-breadth fine and hollow (concave) at the entrance, an S-curve into the parallel body;
//  · the deck edge in plan, full and round forward, so the topsides flare out above the fine waterline;
//  · the flare between them, concave (the sides near vertical at the waterline, curling out toward the deck),
//    so the bow is hollow below and broad above, and throws the spray down and out;
//  · the sections below the water: V-shaped forward, flat-floored with a round bilge amidships (a superellipse);
//  · the profile: the stem raked, overhanging the waterline, its forefoot cut away in a curve; the bottom rising
//    aft to the transom.
// At each height the stations are spaced between the stem and the transom at that height, so the rake and the
// curved forefoot come out of the same surface. Painted by height (boot-top, topsides, sheer strake) with vertex
// colours, bands following the sheer. Bow toward −z, waterline y = 0.
function loftHull(o) {
  const { L, B, T } = o, half = L / 2, b2 = B / 2;
  const smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  const hs = o.sheer;
  const Tu = u => T * (u < o.runU ? 0.3 + 0.7 * smooth(u / o.runU) : 1);   // the bottom rising aft to the transom
  const hbWL = u => {   // waterline half-breadth
    if (u > o.uw) { const s = (1 - u) / (1 - o.uw); return b2 * (o.wlTip + (1 - o.wlTip) * (0.22 * s + 0.78 * smooth(s))); }
    return b2 * (o.wlAft + (1 - o.wlAft) * smooth(u / 0.22));
  };
  const hbD = u => {    // deck-edge half-breadth
    if (u > o.ud) { const s = (u - o.ud) / (1 - o.ud); return b2 * Math.max(o.dkTip, Math.pow(Math.max(0, 1 - s ** o.dkPow), 0.55)); }
    return b2 * (o.dkAft + (1 - o.dkAft) * smooth(u / 0.2));
  };
  const yF = o.flareTo || (u => hs(u));   // the height by which the flare is complete
  const half_at = (u, y) => {
    const w = hbWL(u), d = hbD(u);
    if (y >= 0) { const f = Math.min(1, y / Math.max(0.01, yF(u))); return w + (d - w) * f ** o.flareP(u); }
    const t = Math.max(0, 1 + y / Tu(u)), n = o.bilgeN(u);   // 0 at the keel, 1 at the waterline
    return w * Math.pow(Math.max(0, 1 - (1 - t) ** n), 1 / n);
  };
  const H = hs(1);
  const stemZ = y => y >= 0 ? -half + o.rake * L * Math.pow(Math.max(0, 1 - y / H), 1.15) : -half + o.rake * L + (o.forefoot - o.rake) * L * Math.min(1, -y / T) ** 2;
  const sternZ = y => half - (o.transomRake ?? 0.01) * L * (1 - (y + T) / (H + T));   // (the transom raked, its top aft)
  const zAt = (u, y) => sternZ(y) + u * (stemZ(y) - sternZ(y));
  // the stations, closer together toward the bow where the lines curve hardest
  const NU = o.NU || 56, U = []; for (let k = 0; k <= NU; k++) U.push(1 - Math.pow(1 - k / NU, 1.5));
  // the rows up the girth: bands of colour from the keel to the sheer, each band's top a height at u
  const rows = [];   // {y(u), col, start}
  let prev = u => -Tu(u);
  for (const [top, col, n] of o.bands) {
    const lo = prev, hi = u => Math.min(hs(u), Math.max(-Tu(u), top(u)));
    for (let r = 0; r <= n; r++) rows.push({ y: u => lo(u) + (hi(u) - lo(u)) * r / n, col, start: r === 0 });
    prev = hi;
  }
  const pos = [], col = [], idx = [], C = new THREE.Color();
  const R = rows.length;
  for (const sd of [-1, 1]) {
    const base = pos.length / 3;
    for (let r = 0; r < R; r++) {
      C.set(rows[r].col);
      for (const u of U) { const y = rows[r].y(u); pos.push(sd * half_at(u, y), y, zAt(u, y)); col.push(C.r, C.g, C.b); }
    }
    for (let r = 0; r < R - 1; r++) {
      if (rows[r + 1].start) continue;   // (the seam between two bands: the same heights, a new colour)
      for (let k = 0; k < NU; k++) {
        const a = base + r * (NU + 1) + k, b = a + NU + 1;
        if (sd > 0) idx.push(a, a + 1, b, a + 1, b + 1, b); else idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  // the transom: across between the two sides at u = 0, row by row
  { const base = pos.length / 3;
    for (let r = 0; r < R; r++) { C.set(rows[r].col); const y = rows[r].y(0), x = half_at(0, y), z = zAt(0, y); pos.push(-x, y, z, x, y, z); col.push(C.r, C.g, C.b, C.r, C.g, C.b); }
    for (let r = 0; r < R - 1; r++) { const a = base + r * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
  // a full bow (dkTip, wlTip well above 0: the Casco Bay Lines boats, v996) closed across the stem the same way
  if (o.stemFace) { const base = pos.length / 3;
    for (let r = 0; r < R; r++) { C.set(rows[r].col); const y = rows[r].y(1), x = half_at(1, y), z = zAt(1, y); pos.push(-x, y, z, x, y, z); col.push(C.r, C.g, C.b, C.r, C.g, C.b); }
    for (let r = 0; r < R - 1; r++) { const a = base + r * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); } }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  // a deck at height y(u) over u0..1 (a forecastle, a foredeck), cambered, inside the hull's sides
  const deck = (u0, yOf, color, u1 = 1, camber = 0.12) => {
    const p = [], ix = [], N = 24;
    for (let k = 0; k <= N; k++) { const u = u0 + (u1 - u0) * k / N, y = yOf(u), x = Math.max(0, half_at(u, y) - 0.04), z = zAt(u, y); p.push(-x, y, z, 0, y + camber * x / b2, z, x, y, z); }
    for (let k = 0; k < N; k++) { const a = k * 3; ix.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5); }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); dg.setIndex(ix); dg.computeVertexNormals();
    return new THREE.Mesh(dg, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
  };
  // a rubbing strake (or a guard, a cap rail) along the side at height y(u), standing out by `out`
  const strake = (yOf, r, color, u0 = 0.01, u1 = 0.985, out = 0.1) => {
    const g = new THREE.Group(), m = new THREE.MeshLambertMaterial({ color });
    for (const sd of [-1, 1]) {
      const pts = []; for (let k = 0; k <= 40; k++) { const u = u0 + (u1 - u0) * k / 40, y = yOf(u); pts.push(new THREE.Vector3(sd * (half_at(u, y) + out), y, zAt(u, y))); }
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, r, 6, false), m));
    }
    return g;
  };
  // the sides carried up above the sheer at the deck edge (casings, a bulwark) to a height top(u), where that's above it
  const wall = (topOf, color) => {
    const p = [], ix = [];
    for (const sd of [-1, 1]) {
      const b0 = p.length / 3;
      for (const u of U) { const y0 = hs(u) - 0.02, y1 = Math.max(y0, topOf(u)); p.push(sd * half_at(u, y0), y0, zAt(u, y0), sd * half_at(u, y1), y1, zAt(u, y1)); }
      for (let k = 0; k < NU; k++) { const a = b0 + k * 2; ix.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); wg.setIndex(ix); wg.computeVertexNormals();
    return new THREE.Mesh(wg, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
  };
  return { mesh, half: half_at, z: zAt, hs, deck, strake, wall, stemZ };
}
// ── A deckhouse (v950, on request: "make the passenger houses less boxy too"): the plan a rounded rectangle, its
// front a full curve and its after corners tightly rounded (a superellipse each half); the front raked (rakeF > 0
// leans the top aft, a streamlined face; < 0 leans it forward, as a pilothouse's windows do, against the glare);
// the sides with tumblehome (the top `tumble` in from the bottom each side); the windows wrapping round it (the
// texture runs along the perimeter, one repeat per 4 m); a roof overhanging all round. W wide, from zf (its front,
// toward −z) to za, H high from its base at y = 0.
function glassBand(lit) {   // a pilothouse's windows: a deep band of glass, thin mullions
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 32; const c = cv.getContext('2d');
  c.fillStyle = lit ? '#000' : '#f3f2ee'; c.fillRect(0, 0, 128, 32);
  c.fillStyle = lit ? '#7a6a50' : '#1f2a32'; c.fillRect(0, 32 * 0.12, 128, 32 * 0.5);
  if (!lit) { c.fillStyle = '#f3f2ee'; for (let x = 0; x < 128; x += 32) c.fillRect(x, 0, 3, 32); }
  const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}
// outline(f, grow), if given, draws the plan instead: N = 64 points round it (the cruise ship's decks, v952).
function deckhouse({ W, zf, za, H, rakeF = 0, tumble = 0, nF = 2.4, nA = 9, roof = 0.3, roofT = 0.2, side, top, outline }) {
  const N = 64, g = new THREE.Group();
  const ring = outline || ((f, grow = 0) => {   // the outline at a fraction f of the height, grown outward by `grow`
    const w = W / 2 - tumble * f + grow, z0 = zf + rakeF * f - grow, z1 = za + grow, c = (z0 + z1) / 2, hl = (z1 - z0) / 2, out = [];
    for (let i = 0; i < N; i++) {
      const t = i / N * Math.PI * 2, ct = Math.cos(t), st = Math.sin(t), n = st < 0 ? nF : nA;   // (sin < 0: the front half)
      out.push([w * Math.sign(ct) * Math.abs(ct) ** (2 / n), c + hl * Math.sign(st) * Math.abs(st) ** (2 / n)]);
    }
    return out;
  });
  const band = (r0, y0, r1, y1, mat, uvScale) => {
    const pos = [], uv = [], idx = []; let s = 0;
    for (let i = 0; i <= N; i++) {
      const a = r0[i % N], b = r1[i % N];
      if (i) { const p = r0[(i - 1) % N]; s += Math.hypot(a[0] - p[0], a[1] - p[1]); }
      pos.push(a[0], y0, a[1], b[0], y1, b[1]); uv.push(s / uvScale, 0, s / uvScale, 1);
      if (i) { const k = (i - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    // (wound so its faces look outward: checked against the outline's centre)
    const A = new THREE.Vector3(pos[0], pos[1], pos[2]), Bv = new THREE.Vector3(pos[6], pos[7], pos[8]), Tv = new THREE.Vector3(pos[3], pos[4], pos[5]);
    const nrm = Bv.clone().sub(A).cross(Tv.clone().sub(A)), nx = nrm.x, nz = nrm.z, ax = A.x, az = A.z;   // (the first face's normal, as wound: a, b, then the top)
    const cx = r0.reduce((q, p) => q + p[0], 0) / N, cz = r0.reduce((q, p) => q + p[1], 0) / N;
    if (nx * (ax - cx) + nz * (az - cz) < 0) for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
    g.add(new THREE.Mesh(geo, mat));
  };
  const cap = (r, y, mat, up = true) => {   // a flat lid on an outline (convex: a fan from its centre)
    const cx = r.reduce((q, p) => q + p[0], 0) / N, cz = r.reduce((q, p) => q + p[1], 0) / N, pos = [cx, y, cz], idx = [];
    for (const [x, z] of r) pos.push(x, y, z);
    for (let i = 0; i < N; i++) idx.push(0, 1 + i, 1 + (i + 1) % N);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
    if ((geo.attributes.normal.getY(0) > 0) !== up) { for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]]; geo.setIndex(idx); geo.computeVertexNormals(); }
    g.add(new THREE.Mesh(geo, mat));
  };
  const rb = ring(0), rt = ring(1);
  band(rb, 0, rt, H, side, 4);
  if (roof >= 0) { const ro = ring(1, roof); band(ro, H, ro, H + roofT, top, 4); cap(ro, H + roofT, top, true); cap(ro, H, top, false); }
  else cap(rt, H, top, true);
  g.userData.halfTop = W / 2 - tumble;
  return g;
}
// her name on a board, for both sides (v942)
function nameBoard(text, w, h, bg = '#f3f2ee', fg = '#1d2328') {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 64; const c = cv.getContext('2d');
  if (bg) { c.fillStyle = bg; c.fillRect(0, 0, 512, 64); } c.fillStyle = fg; c.font = 'bold 36px Helvetica, Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 256, 34);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshLambertMaterial({ map: t, ...(bg ? {} : { alphaTest: 0.4 }) });   // (no background: just the letters, on her side)
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
  const DK = 2.3, CAS = 2.7, TOP = DK + CAS, cw = 1.3;   // car deck height; casing height; casing width
  const fEnd = -half + taper * 1.25 + 0.4, deckLen = half - 0.3 - fEnd, deckZ = fEnd + deckLen / 2;   // (from the forecastle's after end to the stern)
  // the hull, lofted (v950): the sheer sweeping up from the car deck aft of amidships to the forecastle bulwark at
  // the stem; the waterline fine and hollow forward; the topsides flaring out above it, concave, to the full deck
  // forward; red, the black boot-top, a white sheer strake. Above the sheer the white casings and bulwark.
  const uF = (half - fEnd) / L, HB = TOP + 1.0;
  const sheer = u => DK + 0.35 * Math.max(0, (0.35 - u) / 0.35) ** 2 + (HB - DK) * Math.max(0, (u - 0.42) / 0.58) ** 2.3;
  const sm = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  const hull = loftHull({
    L, B, T: Math.min(3, L * 0.062), sheer, runU: 0.18, rake: 0.06, forefoot: 0.16, transomRake: 0.008,
    uw: 0.5, wlTip: 0.02, wlAft: 0.96, ud: uF + 0.04, dkTip: 0.025, dkPow: 2.2, dkAft: 1,
    flareP: u => 1 + 1.3 * sm((u - 0.45) / 0.3), flareTo: u => u < uF ? DK : DK + (sheer(u) - DK) * sm((u - uF) / 0.1),
    bilgeN: u => 1.5 + 2.8 * (1 - sm((u - 0.5) / 0.4)),
    bands: [[() => 0.3, 0x1d1f22, 7], [u => sheer(u) - 0.32, 0xc83a2e, 6], [u => sheer(u), 0xf3f2ee, 1]],
  });
  g.add(hull.mesh);
  g.add(hull.wall(u => u < uF ? TOP : TOP + 1.0 * sm((u - uF) / 0.03), 0xf3f2ee));   // the casings' outer faces, the bulwark round the forecastle
  g.add(hull.strake(u => DK - 0.6 + 0.3 * Math.max(0, (0.3 - u) / 0.3) ** 2 + 1.2 * Math.max(0, (u - 0.45) / 0.55) ** 2, 0.2, 0x1d1f22, 0.004, 0.93, 0.1));   // the guard, with a sheer of its own
  g.add(hull.strake(u => Math.max(sheer(u), u < uF ? TOP : TOP + 1.0 * sm((u - uF) / 0.03)) + 0.03, 0.07, 0xc83a2e, 0.004, 0.995, -0.02));   // the cap rail along the top
  // the car deck: asphalt grey, two yellow lane lines
  box(B - 2 * cw, 0.08, deckLen, 0, DK + 0.04, deckZ, deckM);
  for (const x of [-(B - 2 * cw) / 6, (B - 2 * cw) / 6]) box(0.14, 0.02, deckLen * 0.92, x, DK + 0.09, deckZ, yellow);
  // the forecastle: its deck at the casing tops, a grey deck within the bulwark; its after end a white bulkhead over the car deck
  g.add(hull.deck(uF - 0.005, () => TOP, 0x8d9296, 0.995, 0.15));
  box(B - 0.5, CAS, 0.3, 0, DK + CAS / 2, fEnd + 0.15, white);
  // on the forecastle: the anchor windlass, bollards each side (no jackstaff: it stood dead ahead of the helm's view)
  const fz = -half + taper * 0.55;
  box(B * 0.26, 0.6, 1.0, 0, TOP + 0.38, fz, M(0x7d858c));   // (a lighter grey: from the bridge it loomed black)
  for (const sx of [-1, 1]) for (const dz of [-1.6, 1.4]) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.6, 8), black); b.position.set(sx * B * 0.3, TOP + 0.38, fz + dz); g.add(b); }
  // the side casings, with a red cap rail
  for (const sx of [-1, 1]) { box(cw, CAS, deckLen - 3, sx * (B / 2 - cw / 2 - 0.03), DK + CAS / 2, deckZ + 1.5, white); box(cw - 0.1, 0.12, deckLen - 3, sx * (B / 2 - cw / 2 - 0.05), TOP + 0.06, deckZ + 1.5, red); }   // (stopping short of the bow's flare: the lofted side carries on)
  // her name on the casings, forward, both sides
  if (F.vessel) { const nm = nameBoard(F.vessel, 0, 0, null); for (const sx of [-1, 1]) { const pl = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(10, L * 0.2), 1.0), nm); pl.position.set(sx * (B / 2 + 0.02), TOP - 0.85, half - 0.62 * L); pl.rotation.y = sx * Math.PI / 2; g.add(pl); } }   // (on the casing, clear of the sheer's sweep)
  // the stern ramp, raised
  const ramp = box(B - 2 * cw - 0.4, 3.0, 0.25, 0, DK + 1.5, half - 0.2, grey); ramp.rotation.x = 0.12;
  // the passenger house over the forward car deck, its windows in rows, and its upper deck rail
  const hLen = L * 0.34, hZ = fEnd + hLen / 2, hH = 2.7;
  // (v950: a deckhouse, not a box: its front rounded and raked, the sides with tumblehome, the windows wrapping round)
  const side = new THREE.MeshLambertMaterial({ map: windowRows(4, false), emissive: 0xffd9a0, emissiveMap: windowRows(4, true), emissiveIntensity: 0 });
  windowMats.push(side);
  const house = deckhouse({ W: B - 0.3, zf: fEnd, za: fEnd + hLen, H: hH, rakeF: 1.1, tumble: 0.3, nF: 2.2, nA: 10, roof: 0.35, roofT: 0.18, side, top: white });
  house.position.y = TOP; g.add(house);
  const UP = TOP + hH + 0.18, hw = house.userData.halfTop;
  for (const sx of [-1, 1]) box(0.06, 0.9, hLen - 3.5, sx * (hw + 0.2), UP + 0.45, hZ + 1.6, white);   // the rail round the upper deck
  box(2 * hw + 0.4, 0.9, 0.06, 0, UP + 0.45, hZ + hLen / 2 + 0.3, white);
  // the pilothouse forward on the upper deck: its glass leaning out at the top, wrapping round; bridge wings out to the sides
  const pL = 4.6, pZ = hZ - hLen / 2 + pL / 2 + 1.6, pH = 2.4;
  const gl = new THREE.MeshLambertMaterial({ map: glassBand(false), emissive: 0xffd9a0, emissiveMap: glassBand(true), emissiveIntensity: 0 }); windowMats.push(gl);
  const ph = deckhouse({ W: B * 0.56, zf: pZ - pL / 2, za: pZ + pL / 2, H: pH, rakeF: -0.45, tumble: -0.08, nF: 2.6, nA: 6, roof: 0.3, roofT: 0.16, side: gl, top: white });
  ph.position.y = UP; g.add(ph);
  // the wings, tapering out from the pilothouse to the ship's side
  for (const sx of [-1, 1]) { const w = box(B * 0.22, 0.18, 1.6, sx * (B * 0.28 + B * 0.11 - 0.1), UP + 1.0, pZ - pL / 2 + 1.0, white); w.rotation.y = sx * 0.08; box(0.1, 1.0, 1.4, sx * (B * 0.49), UP + 1.5, pZ - pL / 2 + 1.0, white); }
  // the mast and radar, the exhaust stacks in the casings abaft the house
  box(0.18, 3.2, 0.18, 0, UP + pH + 1.7, pZ + 0.6, white);
  const radar = box(1.8, 0.14, 0.3, 0, UP + pH + 2.9, pZ + 0.6, black); radar.rotation.y = 0.5;
  box(0.02, 0.6, 1.0, 0, UP + pH + 2.6, pZ + 1.2, M(0x2a3f7a));   // the flag, on the mast
  // running lights: masthead, sidelights at the wing ends, stern light on the ramp; liferaft canisters aft on the upper deck
  lamp(g, 0xfff2d6, 0, UP + pH + 3.25, pZ + 0.6, windowMats);
  lamp(g, 0xff3b2e, -B * 0.49, UP + 1.6, pZ - pL / 2 + 0.6, windowMats); lamp(g, 0x3dff7a, B * 0.49, UP + 1.6, pZ - pL / 2 + 0.6, windowMats);
  lamp(g, 0xfff2d6, 0, DK + 3.2, half - 0.1, windowMats);
  for (const sx of [-1, 1]) for (const dz of [-1.1, 0]) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.4, 10), white); c.rotation.x = Math.PI / 2; c.position.set(sx * (hw - 0.6), UP + 0.5, hZ + hLen / 2 - 1.2 + dz); g.add(c); }
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
  g.userData.lights = { mast: [0, UP + pH + 3.25, pZ + 0.6], port: [-B * 0.49, UP + 1.6, pZ - pL / 2 + 0.6], stbd: [B * 0.49, UP + 1.6, pZ - pL / 2 + 0.6], stern: [0, DK + 3.2, half - 0.1] };   // (for the helm view's sector lights)
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
  // (v998) the Bustins Island ferry Lilly B (look 'lillyb', from Commons photos): a lobster-boat ferry, white topsides
  // over a blue boot stripe and red bottom, a black rub rail at the sheer, a cream house with big windows
  const lilly = F.look === 'lillyb';
  const white = M(lilly ? 0xefe8d4 : 0xf2f1ec), navy = M(0x23466e), redB = M(0x7a2a24), glass = M(0x1f2a32), teak = M(0x9b7b55), grey = M(0x8d9296);
  const box = (w, h, d, x, y, z, m) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); k.position.set(x, y, z); g.add(k); return k; };
  const SH = 1.45;   // sheer height at its lowest, a little aft of amidships
  // the hull, lofted (v950): a Downeast hull, her sheer sweeping up to a high, flared bow and a little at the
  // transom; the entrance fine and hollow at the waterline, the topsides flaring out above it; round bilges, the
  // forefoot cut away; red bottom, black boot-top, white topsides, the navy sheer stripe; a teak cap rail
  const sm = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  const sheer = u => SH + 0.14 * Math.max(0, (0.3 - u) / 0.3) ** 2 + 0.85 * Math.max(0, (u - 0.3) / 0.7) ** 2.2;
  const hull = loftHull({
    L, B, T: L * 0.075, sheer, runU: 0.3, rake: 0.1, forefoot: 0.34, transomRake: 0.02,
    uw: 0.42, wlTip: 0.02, wlAft: 0.88, ud: 0.5, dkTip: 0.03, dkPow: 2.0, dkAft: 0.92,
    flareP: u => 1 + 1.1 * sm((u - 0.4) / 0.4), bilgeN: u => 1.4 + 1.1 * (1 - sm((u - 0.45) / 0.45)),
    bands: lilly ? [[() => 0.05, 0x9b2b25, 6], [() => 0.2, 0x2a4c8c, 1], [u => sheer(u) - 0.1, 0xf4f3ef, 5], [u => sheer(u), 0x1d1f22, 1]]
      : [[() => 0.05, 0x7a2a24, 6], [() => 0.18, 0x1d1f22, 1], [u => sheer(u) - 0.24, 0xf2f1ec, 5], [u => sheer(u), 0x23466e, 1]],
  });
  g.add(hull.mesh);
  g.add(hull.strake(u => sheer(u) + 0.03, 0.06, lilly ? 0xf4f3ef : 0x9b7b55, 0.005, 0.99, -0.03));   // the cap rail
  g.add(hull.deck(0, () => SH - 0.05, 0x9b7b55, 0.66, 0));   // the deck, teak
  g.add(hull.deck(0.6, u => sheer(u) - 0.03, 0xd9d6cc, 0.995, 0.08));   // the foredeck, non-skid grey, following the sheer up
  // the deckhouse (v950: one rounded house, not two boxes): the wheelhouse forward, its windshield raked back, the
  // passenger cabin aft of it, windows all round (lit at night), sides with a little tumblehome
  const wz0 = -half + L * 0.3, wLen = 2.4, wW = B * 0.82, wH = 1.9;
  const cz0 = wz0 + wLen, cLen = L * 0.38, cW = B * 0.8;
  const side = new THREE.MeshLambertMaterial({ map: windowRows(4, false, lilly ? 40 : 32, lilly ? '#efe8d4' : undefined), emissive: 0xffd9a0, emissiveMap: windowRows(4, true, lilly ? 40 : 32), emissiveIntensity: 0 });
  windowMats.push(side);
  const dh = deckhouse({ W: wW, zf: wz0, za: cz0 + cLen, H: wH, rakeF: 0.55, tumble: 0.12, nF: 2.0, nA: 8, roof: -1, side, top: white });
  dh.position.y = SH; g.add(dh);
  // the roof over it, rounded at the front like the house, overhanging aft as an awning; life rings; the radar mast
  const rz0 = wz0 + 0.25, rLen = wLen + cLen + 1.6 - 0.4;
  const roofG = deckhouse({ W: B * 0.86, zf: rz0, za: rz0 + rLen, H: 0.12, nF: 2.0, nA: 6, roof: -1, side: white, top: white });
  roofG.position.y = SH + wH; g.add(roofG);
  for (const sx of [-1, 1]) box(0.08, wH - 0.05, 0.08, sx * B * 0.4, SH + wH / 2, rz0 + rLen - 0.1, white);   // the awning's posts
  const ringM = M(0xe8731f);
  for (const sx of [-1, 1]) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.08, 6, 14), ringM); r.position.set(sx * (wW / 2 - 0.12 * 0.55 + 0.05), SH + wH * 0.5, cz0 + cLen * 0.5); r.rotation.y = Math.PI / 2; g.add(r); }
  box(0.1, 1.6, 0.1, 0, SH + wH + 0.9, wz0 + wLen * 0.6, white);
  if (lilly) { const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.36, 0.3, 16), M(0xf4f3ef)); dome.position.set(0, SH + wH + 1.35, wz0 + wLen * 0.6); g.add(dome); }   // her radome
  else { const radar = box(1.1, 0.1, 0.22, 0, SH + wH + 1.6, wz0 + wLen * 0.6, M(0x1d1f22)); radar.rotation.y = 0.6; }
  // the after deck: rails round it, a bench across the transom
  const az0 = cz0 + cLen, aLen = half - az0;
  for (const sx of [-1, 1]) box(0.05, 0.8, aLen, sx * (B / 2 * 0.93 - 0.1), SH + 0.4, az0 + aLen / 2, grey);
  box(B - 0.1, 0.05, 0.05, 0, SH + 0.8, half - 0.05, grey);
  box(B * 0.7, 0.45, 0.45, 0, SH + 0.22, half - 0.5, teak);
  // her name on the bow, both sides
  if (F.vessel) { const nm = nameBoard(F.vessel, 3, 0.5, null, lilly ? '#1d1f22' : '#23466e'); for (const sx of [-1, 1]) { const u = 0.72, y = SH - 0.5, dx = hull.half(u + 0.02, y) - hull.half(u - 0.02, y), dz = hull.z(u + 0.02, y) - hull.z(u - 0.02, y), k = Math.hypot(dx, dz), nx = sx * -dz / k, nz = dx / k;   // on her flared side, square to it
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(3.6, L * 0.25), 0.42), nm); pl.position.set(sx * hull.half(u, y) + nx * 0.03, y, hull.z(u, y) + nz * 0.03); pl.rotation.y = Math.atan2(nx, nz); g.add(pl); } }
  // running lights: masthead, sidelights on the wheelhouse, stern light
  lamp(g, 0xfff2d6, 0, SH + wH + 1.75, wz0 + wLen * 0.6, windowMats, 0.1);
  lamp(g, 0xff3b2e, -B * 0.41, SH + wH + 0.2, rz0 + 1.0, windowMats, 0.09); lamp(g, 0x3dff7a, B * 0.41, SH + wH + 0.2, rz0 + 1.0, windowMats, 0.09);   // (at the roof's edge)
  lamp(g, 0xfff2d6, 0, SH + 0.9, half - 0.05, windowMats, 0.08);
  g.userData.helm = [0, SH + 1.7, wz0 - 0.5];   // at the wheelhouse front, just forward of the windshield (behind it, its dark glass filled the view)
  g.userData.wake = [wakeOf(B, L)]; g.add(g.userData.wake[0]);
  return g;
}

// Casco Bay Lines boats (v993; v996, on request: "more attractive ship renderings for the Casco ferries, at least as
// attractive as the ones we have for Penobscot"). Each of the fleet drawn as herself, from the company's photos and
// specs (cascobaylines.com/about-us/vessels): the livery a black hull, a broad yellow band up to the main deck with a
// red line along its top, white houses above, red railings (on the promenades with white panels), the pilothouses
// with red roofs. Workboat hulls, full in plan, nearly plumb-stemmed, 32 ft (9.75 m) of beam even on the 85-footer.
//  · Aucocisco III and Wabanaki (110 ft, near sisters): three tiers, the main cabin, a second deck with an open
//    promenade fore and aft round its cabin, a sun deck over it carried aft as an awning; the pilothouse forward on
//    top, the tall red funnel with its black top amidships.
//  · Machigonne II (122 ft, 37 ft beam), the Peaks Island car ferry: a blunt bow with its ramp, the open car deck
//    forward, the houses aft of it, two tiers and a railed sun deck, the pilothouse forward, a red funnel aft.
//  · Maquoit II (98 ft), the down-the-bay mail and freight boat: a high white bow, the cabins forward, an open
//    freight deck aft, the red crane on her upper house behind the pilothouse.
//  · Bay Mist (85 ft): two tiers, the upper cabin's big windows, the pilothouse forward on top, a thin red stack aft.
// And (v998) the Chebeague Transportation Company's Independence (54 ft, Washburn & Doughty 2019; from Commons photos):
// a steel hull, navy to the sheer with a red boot line and two guard rails; the white main cabin from just abaft the
// foredeck, an open after deck under the upper deck's overhang; on the upper deck the pilothouse forward, nearly the
// full width, white with a red band under its windows and a red roof, a radar mast; benches aft inside red railings
// with white panels; the flag at the stern.
// Windows and doors lit at night (their materials join windowMats). Bow toward −z, waterline y = 0.
// F: { vessel, length_m }.
const CBL_FLEET = {
  'AUCOCISCO III': { B: 9.75, plan: 'tiered' }, 'WABANAKI': { B: 9.75, plan: 'tiered' },
  'MACHIGONNE II': { B: 11.3, plan: 'car' }, 'MAQUOIT II': { B: 9.75, plan: 'freight' }, 'BAY MIST': { B: 9.75, plan: 'small' },
  'INDEPENDENCE': { B: 6.2, plan: 'ctc' },
};
// a cabin's side: one repeat per 4 m (as deckhouse() lays it), a window every `step` m `w` m wide between heights
// wy0..wy1 m up its H m side; below `yel` m the hull's yellow band carried up it, with the red line along its top
function cblCabinTex(lit, { H, wy0, wy1, step = 2, w = 1.1, yel = 0 }) {
  const px = 32, cv = document.createElement('canvas'); cv.width = 128; cv.height = Math.round(H * px); const c = cv.getContext('2d');
  const Y = m => cv.height - m * px;   // (the canvas's top is the cabin's top)
  c.fillStyle = lit ? '#000' : '#f3f2ee'; c.fillRect(0, 0, 128, cv.height);
  if (yel && !lit) { c.fillStyle = '#e9c21f'; c.fillRect(0, Y(yel), 128, yel * px); c.fillStyle = '#c23a2e'; c.fillRect(0, Y(yel), 128, 3); }
  c.fillStyle = lit ? '#fff' : '#26323b';
  for (let x = (step - w) / 2; x < 4; x += step) c.fillRect(Math.round(x * px), Y(wy1), Math.round(w * px), (wy1 - wy0) * px);
  const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}
export function cblModel(F, windowMats = []) {
  const spec = CBL_FLEET[(F.vessel || '').toUpperCase()] || { B: 9.75, plan: 'tiered' };
  const L = F.length_m || 33.5, B = spec.B, g = new THREE.Group(), half = L / 2, plan = spec.plan;
  const mats = {}, M = c => mats[c] || (mats[c] = new THREE.MeshLambertMaterial({ color: c }));
  const WHITE = 0xf3f2ee, RED = 0xc23a2e, BLACK = 0x1d1f22, YELLOW = 0xe9c21f, DECK = 0x9aa19d, GREY = 0x8d9296, NAVY = 0x1f2f5c;
  const white = M(WHITE), red = M(RED), black = M(BLACK);
  const box = (w, h, d, x, y, z, m) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); k.position.set(x, y, z); g.add(k); return k; };
  const sm = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  const Z = t => -half + t * L;   // t: 0 at the stem, 1 at the stern
  // ── the hull: flat-sheered, rising at the bow (high and white on Maquoit); full in plan, the bow round (blunt on
  // the car ferry, for her ramp); flat-floored, hard-bilged
  const ctc = plan === 'ctc';   // (the Chebeague boat: smaller, her own livery)
  const DK = ctc ? 1.9 : 2.3, bowRise = plan === 'freight' ? 1.3 : plan === 'car' ? 0.25 : 0.7;
  const sheer = u => DK + bowRise * sm((u - 0.8) / 0.2);
  const car = plan === 'car';
  const hull = loftHull({
    L, B, T: ctc ? 1.2 : 1.9, sheer, stemFace: true, runU: 0.14, rake: car ? 0.01 : ctc ? 0.06 : 0.03, forefoot: car ? 0.06 : ctc ? 0.2 : 0.12, transomRake: 0.004,
    uw: car ? 0.86 : 0.72, wlTip: car ? 0.55 : ctc ? 0.1 : 0.18, wlAft: 0.96, ud: car ? 0.9 : 0.8, dkTip: car ? 0.72 : ctc ? 0.28 : 0.4, dkPow: 2.0, dkAft: 0.98,
    flareP: () => 1.2, bilgeN: u => 3.2 + 1.2 * (1 - sm((u - 0.55) / 0.35)),
    bands: ctc ? [[() => 0.1, RED, 1], [u => sheer(u), NAVY, 6]]
      : [[() => 0.9, BLACK, 4], [u => Math.min(sheer(u), DK) - 0.1, YELLOW, 3], [u => Math.min(sheer(u), DK), RED, 1], [u => sheer(u), WHITE, 2]],
  });
  g.add(hull.mesh);
  if (ctc) for (const y of [0.55, 1.0]) g.add(hull.strake(() => y, 0.08, NAVY, 0.02, 0.99, 0.02));   // her two guard rails
  else g.add(hull.strake(() => 0.9, 0.11, BLACK, 0.005, 0.995, 0.02));   // the rubbing strake, at the top of the black
  g.add(hull.strake(u => sheer(u) + 0.03, 0.06, ctc ? WHITE : RED, 0.004, 0.996, -0.03));   // the cap rail
  const DM = DK - 1.0;   // the main deck, inside the bulwarks
  g.add(hull.deck(0, () => DM, DECK, 0.995, 0.05));
  // ── the kit
  const rrect = (W, zf, za, nF = 2.6, nA = 6, N = 48) => {   // a rounded plan, as deckhouse() draws it
    const c = (zf + za) / 2, hl = (za - zf) / 2, out = [];
    for (let i = 0; i < N; i++) { const a = i / N * Math.PI * 2, ct = Math.cos(a), st = Math.sin(a), n = st < 0 ? nF : nA; out.push([W / 2 * Math.sign(ct) * Math.abs(ct) ** (2 / n), c + hl * Math.sign(st) * Math.abs(st) ** (2 / n)]); }
    return out;
  };
  const cabinMat = o => { const m = new THREE.MeshLambertMaterial({ map: cblCabinTex(false, o), emissive: 0xffd9a0, emissiveMap: cblCabinTex(true, o), emissiveIntensity: 0 }); windowMats.push(m); return m; };
  const house = (W, t0, t1, y, H, side, o = {}) => { const h = deckhouse({ W, zf: Z(t0), za: Z(t1), H, nF: o.nF ?? 2.6, nA: o.nA ?? 6, rakeF: o.rakeF || 0, tumble: o.tumble || 0, roof: o.roof ?? -1, roofT: o.roofT ?? 0.18, side, top: o.top || white }); h.position.y = y; g.add(h); return h; };
  const slab = (W, t0, t1, y, o = {}) => { const s = deckhouse({ W, zf: Z(t0), za: Z(t1), H: 0.3, nF: o.nF ?? 2.6, nA: o.nA ?? 6, roof: -1, side: white, top: M(DECK) }); s.position.y = y; g.add(s); return y + 0.3; };
  // railings round an outline (a closed ring of [x, z]), its top rail, mid rail and stanchions red, on the
  // promenades white panels between; `keep(x, z)` leaves out the stretches where there's a house instead
  const railR = [], railW = [];
  const railing = (pts, y, { h = 1.05, panels = false, keep = () => true } = {}) => {
    for (let i = 0; i < pts.length; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % pts.length], dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
      if (len < 0.01 || !keep((x0 + x1) / 2, (z0 + z1) / 2)) continue;
      const ang = Math.atan2(-dz, dx), mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      const bar = (yy, th) => railR.push(new THREE.BoxGeometry(len + 0.04, th, th).rotateY(ang).translate(mx, yy, mz));
      bar(y + h, 0.07); if (!panels) bar(y + h * 0.5, 0.04);
      for (let s = 0; s < len; s += 1.5) railR.push(new THREE.BoxGeometry(0.05, h, 0.05).translate(x0 + dx * s / len, y + h / 2, z0 + dz * s / len));
      if (panels) railW.push(new THREE.PlaneGeometry(len, h * 0.62).rotateY(ang).translate(mx, y + 0.12 + h * 0.31, mz));
    }
  };
  const inset = (pts, d) => pts.map(([x, z]) => { const cz = pts.reduce((q, p) => q + p[1], 0) / pts.length, k = Math.hypot(x, z - cz) || 1; return [x - d * x / k, z - d * (z - cz) / k]; });
  const post = (x, y0, y1, z, r = 0.08) => box(r * 2, y1 - y0, r * 2, x, (y0 + y1) / 2, z, white);
  const glass = () => { const m = new THREE.MeshLambertMaterial({ map: glassBand(false), emissive: 0xffd9a0, emissiveMap: glassBand(true), emissiveIntensity: 0 }); windowMats.push(m); return m; };
  const pilothouse = (W, t0, t1, y, H = 2.2) => house(W, t0, t1, y, H, glass(), { rakeF: -0.35, tumble: -0.06, nF: 2.4, nA: 6, roof: 0.35, roofT: 0.22, top: red });
  const funnel = (t, y, h, r, x = 0) => {
    const f = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.94, r, h, 18), red); f.position.set(x, y + h / 2, Z(t)); g.add(f);
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.95, r * 0.95, h * 0.18, 18), black); c.position.set(x, y + h * 0.91, Z(t)); g.add(c);
  };
  const mast = (t, y, h) => {   // the mast, its radar and a yard for the lights, on the pilothouse roof
    box(0.16, h, 0.16, 0, y + h / 2, Z(t), white);
    box(1.4, 0.08, 0.08, 0, y + h * 0.7, Z(t), white);
    const r = box(1.6, 0.12, 0.26, 0, y + h * 0.5, Z(t) - 0.4, black); r.rotation.y = 0.5;
    box(0.4, 0.4, 0.4, 0, y + h * 0.5 - 0.3, Z(t) - 0.4, white);
    return [0, y + h + 0.1, Z(t)];
  };
  const flag = (t, y, x = 0) => { box(0.06, 3.0, 0.06, x, y + 1.5, Z(t), white); const f = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.8), new THREE.MeshLambertMaterial({ color: 0x2a3f7a, side: THREE.DoubleSide })); f.rotation.y = Math.PI / 2; f.position.set(x, y + 2.5, Z(t) + 0.75); g.add(f); };
  const vehicle = (x, t, truck, col) => { const z = Z(t), h = truck ? 1.9 : 1.45, len = truck ? 5.6 : 4.6; box(1.9, h * 0.55, len, x, DM + 0.25 + h * 0.27, z, M(col)); box(1.75, h * 0.4, truck ? 2.4 : len * 0.5, x, DM + 0.25 + h * 0.75, z - (truck ? len * 0.2 : 0), M(truck ? col : 0x1f2a32)); };
  let helm, mastTop, side = [0, 0, 0], stern;
  // ── the boats
  const Y1 = DM, U = 2.5;   // the main cabin's base; a tier's height above the yellow
  if (plan === 'tiered') {   // Aucocisco III, Wabanaki
    house(B - 0.35, 0.08, 0.95, Y1, 1.0 + U + 0.05, cabinMat({ H: 1.05 + U, wy0: 1.75, wy1: 2.85, step: 2.1, w: 1.15, yel: 1.0 }), { nF: 2.2 });
    const y2 = slab(B + 0.2, 0.035, 0.985, Y1 + 1.05 + U, { nF: 2.0, nA: 5 });
    const c2 = [0.2, 0.68];
    house(B - 2.2, c2[0], c2[1], y2, U, cabinMat({ H: U, wy0: 0.85, wy1: 1.9, step: 2.1, w: 1.15 }));
    railing(inset(rrect(B + 0.2, Z(0.035), Z(0.985), 2.0, 5), 0.12), y2, { panels: true });
    const y3 = slab(B - 0.9, 0.18, 0.93, y2 + U);   // the sun deck, its after part an awning over the promenade
    for (const sx of [-1, 1]) for (const t of [0.78, 0.9]) post(sx * (B / 2 - 0.7), y2, y3 - 0.3, Z(t));
    railing(inset(rrect(B - 0.9, Z(0.18), Z(0.93)), 0.1), y3, { keep: (x, z) => z > Z(0.33) || Math.abs(x) > B * 0.3 });
    pilothouse(B * 0.5, 0.2, 0.33, y3);
    house(B * 0.52, 0.33, 0.43, y3, 2.0, white, { nF: 4, nA: 6 });
    funnel(0.56, y3, 4.2, 0.62);
    flag(0.91, y3);
    mastTop = mast(0.29, y3 + 2.45, 2.6); helm = [0, y3 + 1.5, Z(0.2) + 0.6]; side = [B * 0.27, y3 + 1.4, Z(0.21)]; stern = [0, y2 + 0.8, Z(0.985)];
  } else if (plan === 'car') {   // Machigonne II
    // the open car deck forward, her bow ramp raised, the day's cars on it
    const ramp = box(B * 0.5, 2.6, 0.25, 0, DK + 1.2, Z(0.012), M(GREY)); ramp.rotation.x = -0.1;
    for (const sx of [-1, 1]) box(0.3, 3.4, 0.3, sx * B * 0.27, DK + 1.6, Z(0.02), M(GREY));   // the ramp's hoist posts
    vehicle(-2.4, 0.1, false, 0xb8bcc0); vehicle(0.2, 0.13, true, 0x8b1e1e); vehicle(2.6, 0.09, false, 0x2c4a6e);
    house(B - 0.35, 0.22, 0.985, Y1, 1.0 + 2.8, cabinMat({ H: 3.8, wy0: 1.9, wy1: 2.7, step: 2.4, w: 0.95, yel: 1.0 }), { nF: 6, nA: 6 });
    const y2 = slab(B, 0.2, 0.99, Y1 + 3.8, { nF: 6 });
    house(B - 1.0, 0.24, 0.97, y2, U, cabinMat({ H: U, wy0: 0.85, wy1: 1.9, step: 2.2, w: 1.2 }), { nF: 3, rakeF: 0.4 });
    railing(inset(rrect(B, Z(0.2), Z(0.99), 6, 6), 0.1), y2, { panels: true, keep: (x, z) => z < Z(0.26) });
    const y3 = slab(B - 0.8, 0.235, 0.975, y2 + U, { nF: 3 });
    railing(inset(rrect(B - 0.8, Z(0.235), Z(0.975), 3), 0.1), y3, { panels: true, keep: (x, z) => z > Z(0.38) || Math.abs(x) > B * 0.25 });
    pilothouse(B * 0.42, 0.26, 0.38, y3);
    funnel(0.8, y3, 2.6, 0.6);
    flag(0.95, y3);
    mastTop = mast(0.33, y3 + 2.45, 3.4); helm = [0, y3 + 1.5, Z(0.26) + 0.6]; side = [B * 0.23, y3 + 1.4, Z(0.27)]; stern = [0, y2 + 0.8, Z(0.99)];
  } else if (plan === 'freight') {   // Maquoit II
    house(B - 0.35, 0.14, 0.6, Y1, 1.0 + U, cabinMat({ H: 1.0 + U, wy0: 1.75, wy1: 2.75, step: 2.4, w: 1.4, yel: 1.0 }), { nF: 4 });
    const y2 = slab(B + 0.1, 0.04, 0.74, Y1 + 1.0 + U, { nF: 2.0 });
    for (const sx of [-1, 1]) post(sx * (B / 2 - 0.3), Y1, y2 - 0.3, Z(0.72));
    house(B - 2.0, 0.19, 0.56, y2, U, cabinMat({ H: U, wy0: 0.85, wy1: 1.85, step: 2.2, w: 1.0 }));
    railing(inset(rrect(B + 0.1, Z(0.04), Z(0.74), 2.0), 0.12), y2, { panels: true });
    const y3 = y2 + U;
    railing(inset(rrect(B - 2.0, Z(0.19), Z(0.56)), 0.1), y3, { keep: (x, z) => z > Z(0.33) || Math.abs(x) > B * 0.27 });
    pilothouse(B * 0.5, 0.19, 0.32, y3);
    box(1.6, 1.8, 2.2, 0, y3 + 0.9, Z(0.47), red);   // the crane: its house, the boom laid forward
    const boom = box(0.4, 0.4, 6.5, 1.1, y3 + 1.6, Z(0.47) - 2.6, red); boom.rotation.x = -0.05;
    box(1.8, 1.4, 2.0, 0, y3 + 0.7, Z(0.53), white);
    // freight aft: a pickup, a pallet of lumber, a pile of bins
    vehicle(-2.0, 0.84, true, 0xe9e9e6); box(1.6, 0.9, 2.4, 2.2, DM + 0.45, Z(0.82), M(0xb08d5a)); box(1.2, 1.0, 1.2, 2.4, DM + 0.5, Z(0.93), M(0x2c4a6e));
    flag(0.69, y2);
    mastTop = mast(0.27, y3 + 2.45, 3.2); helm = [0, y3 + 1.5, Z(0.19) + 0.6]; side = [B * 0.27, y3 + 1.4, Z(0.2)]; stern = [0, DK + 0.6, Z(0.995)];
  } else if (ctc) {   // Independence
    const H1 = 2.6;
    house(B - 0.4, 0.2, 0.68, Y1, H1, cabinMat({ H: H1, wy0: 1.3, wy1: 2.1, step: 1.6, w: 0.85 }), { nF: 3.5, nA: 8 });
    const y2 = slab(B - 0.05, 0.18, 0.975, Y1 + H1, { nF: 3, nA: 8 });
    for (const sx of [-1, 1]) for (const t of [0.8, 0.96]) post(sx * (B / 2 - 0.35), DK, y2 - 0.3, Z(t), 0.05);   // the overhang's posts
    const Wp = B * 0.8, p0 = 0.19, p1 = 0.37;   // the pilothouse: white, a red band, the glass, a red roof
    house(Wp, p0, p1, y2, 0.55, white, { nF: 4, nA: 8 });
    house(Wp, p0, p1, y2 + 0.55, 0.28, red, { nF: 4, nA: 8 });
    house(Wp, p0, p1, y2 + 0.83, 1.2, glass(), { nF: 4, nA: 8, roof: 0.25, roofT: 0.18, top: red });
    railing(inset(rrect(B - 0.05, Z(0.18), Z(0.975), 3, 8), 0.08), y2, { panels: true, keep: (x, z) => z > Z(p1) + 0.2 });
    for (const sx of [-1, 1]) box(0.5, 0.45, Z(0.9) - Z(0.45), sx * 0.55, y2 + 0.22, (Z(0.45) + Z(0.9)) / 2, white);   // the benches, back to back
    flag(0.97, y2);
    mastTop = mast(0.3, y2 + 2.25, 1.8); helm = [0, y2 + 1.55, Z(p0) + 0.5]; side = [Wp / 2, y2 + 1.0, Z(p0 + 0.03)]; stern = [0, y2 + 0.8, Z(0.975)];
  } else {   // Bay Mist
    house(B - 0.35, 0.05, 0.975, Y1, 1.0 + U, cabinMat({ H: 1.0 + U, wy0: 1.7, wy1: 2.8, step: 1.7, w: 1.25, yel: 1.0 }), { nF: 3 });
    const y2 = slab(B, 0.025, 0.985, Y1 + 1.0 + U, { nF: 3 });
    house(B - 0.7, 0.3, 0.975, y2, 2.4, cabinMat({ H: 2.4, wy0: 0.75, wy1: 1.95, step: 2.0, w: 1.7 }), { nF: 6 });
    house(B - 0.4, 0.295, 0.98, y2 + 2.4, 0.22, red, { nF: 6 });   // its roof white, with a red edge
    railing(inset(rrect(B, Z(0.025), Z(0.985), 3), 0.1), y2, { keep: (x, z) => z < Z(0.3) });
    pilothouse(B * 0.56, 0.06, 0.22, y2, 2.3);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.8, 10), red); pipe.position.set(-B * 0.3, y2 + 2.6 + 0.9, Z(0.86)); g.add(pipe);
    mastTop = mast(0.15, y2 + 2.55, 4.2); helm = [0, y2 + 1.55, Z(0.06) + 0.6]; side = [B * 0.29, y2 + 1.5, Z(0.07)]; stern = [0, y2 + 0.8, Z(0.985)];
  }
  if (railR.length) g.add(new THREE.Mesh(mergeGeos(railR), red));
  if (railW.length) g.add(new THREE.Mesh(mergeGeos(railW), new THREE.MeshLambertMaterial({ color: WHITE, side: THREE.DoubleSide })));
  // her name on the bow, both sides, in black on the yellow (on Maquoit's high white bow, above it)
  if (F.vessel) {
    const nm = nameBoard(F.vessel, 0, 0, null, ctc ? '#e6cf8a' : undefined), t = plan === 'small' ? 0.08 : ctc ? 0.17 : 0.07, y = plan === 'freight' ? DK + 0.55 : ctc ? DK - 0.35 : DK - 0.5;
    for (const sx of [-1, 1]) { const u = 1 - t, dx = hull.half(u + 0.02, y) - hull.half(u - 0.02, y), dz = hull.z(u + 0.02, y) - hull.z(u - 0.02, y), k = Math.hypot(dx, dz), nx = sx * -dz / k, nz = dx / k;
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(6, L * (ctc ? 0.3 : 0.17)), ctc ? 0.5 : 0.62), nm); pl.position.set(sx * hull.half(u, y) + nx * 0.04, y, hull.z(u, y) + nz * 0.04); pl.rotation.y = Math.atan2(nx, nz); g.add(pl); }
  }
  // running lights: masthead, sidelights at the pilothouse, stern light
  const port = [-side[0], side[1], side[2]], stbd = side;
  lamp(g, 0xfff2d6, ...mastTop, windowMats); lamp(g, 0xff3b2e, ...port, windowMats); lamp(g, 0x3dff7a, ...stbd, windowMats); lamp(g, 0xfff2d6, ...stern, windowMats);
  g.userData.helm = helm;
  g.userData.lights = { mast: mastTop, port, stbd, stern };
  g.userData.wake = [wakeOf(B, L)]; g.add(g.userData.wake[0]);
  return g;
}

// ── A Maine State Ferry Service slip (v943, on request: "The dock for this ferry looks unrealistic ... These large
// Maine State ferries have characteristic tall green gantries"). The head of the slip (where the transfer bridge
// meets her car deck) at the origin, the sea toward −z: the transfer bridge running up to the shore, steel with
// green girders; over its seaward end the green lift gantry, two lattice towers with counterweights, a crossbeam
// and the hoist house on top, cables down to the bridge; the wing walls either side of her berth, timber-faced pile
// walls flaring out to the sea, a dolphin at each end; a concrete abutment ashore. One mesh per material.
function mergeGeos(geos) {
  const pos = [], nor = [], idx = []; let off = 0;
  for (const g of geos) {
    const ng = g.index ? g : g.toNonIndexed();
    if (!ng.attributes.normal) ng.computeVertexNormals();
    pos.push(...ng.attributes.position.array); nor.push(...ng.attributes.normal.array);
    if (ng.index) for (const i of ng.index.array) idx.push(i + off); else for (let i = 0; i < ng.attributes.position.count; i++) idx.push(i + off);
    off += ng.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); m.setIndex(idx);
  return m;
}
// A cargo ship or tanker (v986, for live AIS: the tankers bound up the bay for Searsport, a freighter, a dredger):
// a long hull with a raked bow and flat sides, red below the boot-top; the deckhouse aft with its bridge wings and
// funnel; a tanker's deck with its pipe run and manifold, a cargo ship's with hatch covers and a few containers.
// V: { length_m, beam_m, tanker }. Bow toward −z, waterline y = 0.
export function merchantModel(V, windowMats = []) {
  const L = V.length_m || 120, B = V.beam_m || L * 0.16, half = L / 2, g = new THREE.Group();
  const M = c => new THREE.MeshLambertMaterial({ color: c });
  let sd = Math.round(L * 7 + B * 13) || 7; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const hullC = V.tanker ? [0x7a2a24, 0x1f2a3a, 0x24395f][Math.floor(rnd() * 3)] : [0x1f2a3a, 0x2f4f3a, 0x3a3f46, 0x7a2a24][Math.floor(rnd() * 4)];
  const hull = M(hullC), red = M(0x8c2a22), deck = M(V.tanker ? 0x6b5a4a : 0x5a5d60), white = M(0xf1efe9), glass = M(0x1f2a32), black = M(0x16191d);
  const FB = Math.max(2, L * 0.045), bowL = Math.min(B * 1.6, L * 0.14);
  // the hull's plan, extruded from the boot-top to the deck; the bow at +y in the shape, −z once stood up
  const plan = (w, x0) => { const s = new THREE.Shape(); s.moveTo(-w / 2, -half); s.lineTo(w / 2, -half); s.lineTo(w / 2, half - bowL); s.quadraticCurveTo(w / 2, half - bowL * 0.25, 0, half); s.quadraticCurveTo(-w / 2, half - bowL * 0.25, -w / 2, half - bowL); s.closePath(); return s; };
  const slab = (w, y0, h, m) => { const k = new THREE.Mesh(new THREE.ExtrudeGeometry(plan(w), { depth: h, bevelEnabled: false, curveSegments: 8 }), m); k.rotation.x = -Math.PI / 2; k.position.y = y0; g.add(k); return k; };
  slab(B, -0.6, 1.2, red); slab(B, 0.6, FB - 0.6, hull); slab(B * 0.98, FB, 0.12, deck);
  const box = (w, h, d, x, y, z, m) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); k.position.set(x, y, z); g.add(k); return k; };
  // the deckhouse aft, its decks and bridge, with lit windows
  const hz = half - L * 0.1, hd = L * 0.09, decks = Math.max(3, Math.round(L / 35)), dh = 2.7;
  box(B * 0.86, decks * dh, hd, 0, FB + decks * dh / 2, hz, white);
  const win = new THREE.MeshLambertMaterial({ color: 0x2a3640, emissive: 0xffd9a0, emissiveIntensity: 0 }); windowMats.push(win);
  for (let i = 0; i < decks; i++) box(B * 0.87, 0.8, hd * 0.9, 0, FB + i * dh + 1.6, hz, win);
  const brY = FB + decks * dh;
  box(B * 1.02, 2.4, hd * 0.55, 0, brY + 1.2, hz - hd * 0.2, white); box(B * 1.03, 0.9, hd * 0.5, 0, brY + 1.5, hz - hd * 0.21, glass);
  box(B * 0.2, B * 0.35, B * 0.22, 0, brY + B * 0.17, hz + hd * 0.32, black);   // the funnel
  box(0.4, 7, 0.4, 0, brY + 5.9, hz - hd * 0.1, white);   // the radar mast
  if (V.tanker) {   // the pipe run along the centreline, the manifold amidships, a catwalk
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, L * 0.7, 8), M(0xb9b4a8)); pipe.rotation.x = Math.PI / 2; pipe.position.set(0, FB + 1.1, -L * 0.04); g.add(pipe);
    box(B * 0.7, 1.6, 2.5, 0, FB + 0.9, -L * 0.03, M(0x9a958a)); box(1.2, 0.4, L * 0.7, B * 0.12, FB + 2.2, -L * 0.04, M(0xd0cbbf));
  } else {   // hatch covers, and a few containers on them
    const n = Math.max(3, Math.round(L / 25)), span = L * 0.66, cols = [0x2f86b8, 0xc23a2e, 0xe0b531, 0x2b8a4a, 0x8d9296, 0xe8731f];
    for (let i = 0; i < n; i++) {
      const z = -half + bowL + 4 + (i + 0.5) * span / n;
      box(B * 0.8, 1.2, span / n * 0.82, 0, FB + 0.6, z, M(0x4a5a46));
      if (rnd() < 0.7) for (let r = 0; r < 1 + Math.floor(rnd() * 3); r++) box(B * 0.78, 2.5, span / n * 0.7, 0, FB + 2.45 + r * 2.6, z, M(cols[Math.floor(rnd() * cols.length)]));
    }
  }
  box(0.4, 9, 0.4, 0, FB + 4.5, -half + bowL * 0.6, white);   // the foremast
  g.userData.helm = [0, brY + 1.7, hz - hd * 0.45];   // on the bridge, at its forward windows
  g.userData.wake = [wakeOf(B, L)]; g.add(g.userData.wake[0]);
  return g;
}

export function ferrySlipModel(beam = 12.2, len = 46) {
  const parts = {}, add = (k, g) => (parts[k] ||= []).push(g);
  const bx = (w, h, d, x, y, z, ry = 0, rx = 0, rz = 0) => { const g = new THREE.BoxGeometry(w, h, d); if (rz) g.rotateZ(rz); if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); g.translate(x, y, z); return g; };
  const cy = (r, h, x, y, z) => { const g = new THREE.CylinderGeometry(r, r, h, 7); g.translate(x, y, z); return g; };
  const W = beam + 1.8, BL = 22, rise = Math.atan(1.1 / BL);
  // the transfer bridge: deck rising from her car deck to the shore, green girders either side, posts along them
  add('steel', bx(7.2, 0.5, BL, 0, 2.85 + 0.55, BL / 2, 0, -rise));
  for (const sx of [-1, 1]) {
    add('green', bx(0.5, 1.5, BL, sx * 3.7, 3.75, BL / 2, 0, -rise));
    for (let t = 1; t < BL; t += 3) add('green', bx(0.16, 1.1, 0.16, sx * 3.7, 4.5 + t * 1.1 / BL + 0.4, t));
    add('green', bx(0.12, 0.12, BL, sx * 3.7, 5.3, BL / 2, 0, -rise));   // the handrail
  }
  add('concrete', bx(9.5, 6, 4.5, 0, 1.4, BL + 2));   // the abutment ashore
  // the lift gantry over the bridge's seaward end
  const GX = 5.6, GZ = 1.6, GH = 14.5;
  for (const sx of [-1, 1]) {
    for (const [dx, dz] of [[-0.65, -0.65], [0.65, -0.65], [-0.65, 0.65], [0.65, 0.65]]) add('green', bx(0.3, GH, 0.3, sx * GX + dx, GH / 2 - 0.5, GZ + dz));
    for (let y = 1.5; y < GH; y += 2.4) { for (const dz of [-0.65, 0.65]) add('green', bx(1.6, 0.18, 0.18, sx * GX, y, GZ + dz)); for (const dx of [-0.65, 0.65]) add('green', bx(0.18, 0.18, 1.6, sx * GX + dx, y, GZ)); }
    for (let y = 1.5; y + 2.4 < GH; y += 2.4) for (const dz of [-0.65, 0.65]) add('green', bx(0.12, 2.75, 0.12, sx * GX, y + 1.2, GZ + dz, 0, 0, (y / 2.4) % 2 < 1 ? 0.5 : -0.5));   // cross-bracing on the faces
    add('concrete', bx(0.9, 2.4, 0.9, sx * GX, 9.8, GZ));   // the counterweight inside the tower
    add('concrete', bx(2.2, 1, 2.2, sx * GX, -0.2, GZ));    // its footing
    add('dark', bx(0.07, GH - 3.6, 0.07, sx * 3.5, (GH + 3.6) / 2 - 0.2, 0.4));   // the hoist cable down to the bridge
  }
  add('green', bx(2 * GX + 2.2, 1.5, 1.9, 0, GH + 0.25, GZ));   // the crossbeam
  add('green', bx(3.4, 2, 2.6, 0, GH + 2, GZ)); add('steel', bx(3.8, 0.2, 3, 0, GH + 3.1, GZ));   // the hoist house, its roof
  // the fender piers either side of her berth (v949, on request: "add piers for the Rockland ferry terminal"; were
  // 34 m wing walls, shorter than the ferry): pile walls running her length, straight and flaring out only toward
  // the sea, timber facing on the inside and two wales; on top a plank catwalk with a handrail; a dolphin at the
  // seaward end, the catwalk running out to it
  const WL = Math.max(34, len * 0.98), FL = 3.5, wallX = (sx, t) => sx * (W / 2 + FL * Math.max(0, (t - WL * 0.7) / (WL * 0.3)) ** 2);
  for (const sx of [-1, 1]) {
    for (let t = 0; t <= WL + 0.01; t += 2.2) add('pile', cy(0.3, 7.2, wallX(sx, t), 0.9, -t));
    for (let t = 0; t < WL - 0.01; t += 4.4) {
      const t1 = Math.min(WL, t + 4.4), xa = wallX(sx, t), xb = wallX(sx, t1), sl = Math.hypot(xb - xa, t1 - t), ry = Math.atan2(xb - xa, -(t1 - t)), mx = (xa + xb) / 2, mz = -(t + t1) / 2;
      add('timber', bx(0.25, 3.8, sl + 0.05, mx - sx * 0.35, 2.1, mz, ry));
      for (const y of [1.0, 3.9]) add('timber', bx(0.4, 0.4, sl + 0.05, mx - sx * 0.05, y, mz, ry));
      add('plank', bx(1.6, 0.18, sl + 0.05, mx + sx * 0.55, 4.35, mz, ry));   // the catwalk
      add('green', bx(0.07, 0.07, sl + 0.05, mx + sx * 1.3, 5.4, mz, ry));     // its handrail
      add('green', bx(0.08, 1.0, 0.08, xa + sx * 1.3, 4.95, -t));
    }
    const xe = wallX(sx, WL), dx = xe + sx * 2.6, dz = -WL - 2;   // the dolphin at the seaward end, and the catwalk out to it
    for (let k = 0; k < 7; k++) { const a = k / 7 * Math.PI * 2, r = k ? 1.0 : 0; add('pile', cy(0.32, 6.6, dx + Math.cos(a) * r, 1.0, dz + Math.sin(a) * r)); }
    add('concrete', cy(1.5, 0.5, dx, 4.4, dz));
    add('plank', bx(1.4, 0.18, Math.hypot(dx - xe, 2), (xe + dx) / 2 + sx * 0.3, 4.35, -WL - 1, Math.atan2(dx - xe, -2)));
    add('pile', cy(0.3, 7.2, sx * W / 2, 0.9, 1.2)); add('pile', cy(0.3, 7.2, sx * W / 2 * 0.62, 0.9, 0.6));   // at the head, either side of the bridge
  }
  const MAT = { green: 0x2f6e3c, steel: 0x6f7377, concrete: 0xaaa79f, pile: 0x4b4136, timber: 0x6e5c45, dark: 0x202326, plank: 0x8a7a64 };
  const g = new THREE.Group();
  for (const k in parts) g.add(new THREE.Mesh(mergeGeos(parts[k]), new THREE.MeshLambertMaterial({ color: MAT[k] })));
  g.userData.walls = { W, WL, FL };   // (for a pier between two slips side by side)
  return g;
}

// ── The shore side of a ferry terminal (v950, on request: "add piers for the other ferry terminals too"): the staging
// lot where the cars queue for the boat, and the terminal's ticket office. Placed by bay3d.js on the drawn ground
// behind each slip that has no terminal of its own in the town data. The lot: asphalt, w across by l along its lanes
// (along z), white lane lines, the cars waiting in them, light poles at the corners, a skirt below its edge where the
// ground falls away; top at y = 0.
export function terminalLot(w, l, seed = 1, windowMats = []) {
  let sd = seed % 2147483647 || 1; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const parts = {}, add = (k, g) => (parts[k] ||= []).push(g);
  const bx = (W, H, D, x, y, z) => { const g = new THREE.BoxGeometry(W, H, D); g.translate(x, y, z); return g; };
  add('asphalt', bx(w, 4, l, 0, -2, 0));
  const nl = Math.max(2, Math.floor((w - 2) / 3.4)), lw = (w - 2) / nl;
  for (let i = 1; i < nl; i++) add('paint', bx(0.14, 0.02, l - 6, -w / 2 + 1 + i * lw, 0.01, 0));
  add('paint', bx(w - 2, 0.02, 0.3, 0, 0.01, -l / 2 + 2.5));   // the stop line, toward the slip
  const COLS = [0xb8bcc0, 0x2a2d31, 0x8b1e1e, 0x2c4a6e, 0xe9e9e6, 0x5a6b4e, 0x9a8a6c, 0x6c7378, 0x3d5f8a];
  for (let i = 0; i < nl; i++) {
    const x = -w / 2 + 1 + (i + 0.5) * lw;
    for (let z = -l / 2 + 3.2; z < l / 2 - 5;) {
      if (rnd() < 0.3) break;   // the end of this lane's queue
      const truck = rnd() < 0.15, len = truck ? 6.5 : 4.5, h = truck ? 2.6 : 1.5, col = COLS[Math.floor(rnd() * COLS.length)];
      add('c' + col, bx(1.85, h * 0.6, len, x, h * 0.3 + 0.2, z + len / 2));
      if (truck) add(rnd() < 0.5 ? 'cwhite' : 'c' + col, bx(1.9, h * 0.45, len * 0.65, x, h * 0.6 + h * 0.22 + 0.2, z + len * 0.6));
      else add('glass', bx(1.65, h * 0.36, len * 0.5, x, h * 0.6 + h * 0.18 + 0.2, z + len / 2 + 0.2));
      z += len + 1.1;
    }
  }
  const lamps = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { add('pole', bx(0.18, 7, 0.18, sx * (w / 2 - 0.4), 3.5, sz * (l / 2 - 0.4))); add('pole', bx(1.2, 0.12, 0.3, sx * (w / 2 - 0.9), 7, sz * (l / 2 - 0.4))); lamps.push([sx * (w / 2 - 1.4), 6.9, sz * (l / 2 - 0.4)]); }
  const MAT = { asphalt: 0x505356, paint: 0xe8e6de, glass: 0x1f2a32, pole: 0x7c8186, cwhite: 0xe9e9e6 };
  const g = new THREE.Group();
  for (const k in parts) g.add(new THREE.Mesh(mergeGeos(parts[k]), new THREE.MeshLambertMaterial({ color: MAT[k] ?? +k.slice(1) })));
  for (const [x, y, z] of lamps) lamp(g, 0xffe2b0, x, y, z, windowMats, 0.22);
  return g;
}
// the terminal's ticket office and waiting room: cedar-shingled, white trim, windows along its sides (lit at night),
// a dark green hip roof, a porch on the lot side, the service's sign on the gable end. Base at y = 0, long side along x.
export function terminalHouse(windowMats = []) {
  const g = new THREE.Group(), W = 15, D = 8, H = 3.4, M = c => new THREE.MeshLambertMaterial({ color: c });
  const shingle = M(0x8f877a), trim = M(0xf2f1ec), roofM = M(0x2f5b3e);
  const side = new THREE.MeshLambertMaterial({ map: windowRows(W, false, 32, '#8f877a'), emissive: 0xffd9a0, emissiveMap: windowRows(W, true, 32), emissiveIntensity: 0 });
  side.map.repeat.set(4, 1); side.emissiveMap.repeat.set(4, 1); windowMats.push(side);
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), [shingle, shingle, shingle, shingle, side, side]); body.position.y = H / 2 - 0.6; g.add(body);
  const base = new THREE.Mesh(new THREE.BoxGeometry(W + 0.3, 3, D + 0.3), M(0x9b9890)); base.position.y = -1.5; g.add(base);
  const band = new THREE.Mesh(new THREE.BoxGeometry(W + 0.1, 0.25, D + 0.1), trim); band.position.y = H - 0.6; g.add(band);
  // the hip roof: a box frustum, eaves overhanging
  const rg = new THREE.BufferGeometry(), e = 0.6, rh = 2.6, x0 = W / 2 + e, z0 = D / 2 + e, x1 = W / 2 - D / 2 + 0.5, y0 = H - 0.6;
  const v = [[-x0, y0, -z0], [x0, y0, -z0], [x0, y0, z0], [-x0, y0, z0], [-x1, y0 + rh, 0], [x1, y0 + rh, 0]];
  const tris = [[0, 4, 5], [0, 5, 1], [1, 5, 2], [2, 5, 4], [2, 4, 3], [3, 4, 0]];
  rg.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat().flatMap(i => v[i]), 3)); rg.computeVertexNormals();
  const rm = new THREE.Mesh(rg, new THREE.MeshLambertMaterial({ color: 0x2f5b3e, side: THREE.DoubleSide })); g.add(rm);
  // the porch along the lot side (+z): a roof on white posts
  const porch = new THREE.Mesh(new THREE.BoxGeometry(W * 0.6, 0.15, 2.4), roofM); porch.position.set(0, H - 1.0, D / 2 + 1.2); porch.rotation.x = 0.12; g.add(porch);
  for (const px of [-W * 0.28, 0, W * 0.28]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.16, H - 1.0, 0.16), trim); p.position.set(px, (H - 1.0) / 2 - 0.5, D / 2 + 2.2); g.add(p); }
  // the sign on the end, toward the road
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 0.7), nameBoard('MAINE STATE FERRY SERVICE', 5, 0.7, '#f2f1ec', '#2f5b3e'));
  sign.position.set(-W / 2 - 0.02, H - 1.3, 0); sign.rotation.y = -Math.PI / 2; g.add(sign);
  const sign2 = sign.clone(); sign2.position.set(W / 2 + 0.02, H - 1.3, 0); sign2.rotation.y = Math.PI / 2; g.add(sign2);
  return g;
}
