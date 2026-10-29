// New York Harbor's passenger boats as themselves (v1063, requested: "I think you are making the new york ferries look
// like the Maine ferries. Please make an effort to make them look more realistic"). Before, every passenger boat the
// AIS showed was drawn as a Maine State Ferry car ferry. Now:
//  · the Staten Island Ferry (siFerryModel): the big double-ended orange boats, 94-98 m by 21 m (the Ollis class
//    319 ft by 69 ft, Baird Maritime's review; the Molinari and Barberi classes 310 ft), all orange, a black boot-top;
//    three passenger decks of long window rows over open end decks, a pilothouse at each end on top, a stack
//    amidships; the smaller John A. Noble and Alice Austen (207 ft) with two;
//  · the fast catamarans (catModel): NYC Ferry's 26 m by 8 m Incat Crowther boats (blue and white, its vinyl wrap),
//    NY Waterway's (white, a navy hull with a red line: its colours), Seastreak's (white, navy): two hulls, the main
//    cabin across them, its windows wrapping round; on top the pilothouse forward and open seating aft;
//  · the sightseeing boats (excursionModel): Circle Line's, Statue City Cruises' and the rest: a monohull, two
//    enclosed decks of big windows, an open top deck with the pilothouse forward.
// Windows lit at night (their materials join windowMats). Bow toward −z, waterline y = 0.
import * as THREE from 'three';
import { loftHull, deckhouse, nameBoard, lamp, wakeOf, glassBand } from './vessels.js';

// a side's paint, H m high: bands [y0, y1, colour] from the bottom; window rows [y0, y1, w, step] (m), one repeat
// per 4 m as deckhouse() lays it; lit: the night map (the windows only)
function paintTex(lit, H, bg, bands = [], wins = [], glass = '#1f2a32') {
  const px = 32, cv = document.createElement('canvas'); cv.width = 128; cv.height = Math.max(8, Math.round(H * px)); const c = cv.getContext('2d');
  const Y = m => cv.height - m * px;
  c.fillStyle = lit ? '#000' : bg; c.fillRect(0, 0, 128, cv.height);
  if (!lit) for (const [y0, y1, col] of bands) { c.fillStyle = col; c.fillRect(0, Y(y1), 128, (y1 - y0) * px); }
  c.fillStyle = lit ? '#fff' : glass;
  for (const [y0, y1, w, step] of wins) for (let x = (step - w) / 2; x < 4; x += step) c.fillRect(Math.round(x * px), Y(y1), Math.round(w * px), (y1 - y0) * px);
  const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}
const sideMat = (windowMats, H, bg, bands = [], wins = [], glass) => {
  const m = new THREE.MeshLambertMaterial({ map: paintTex(false, H, bg, bands, wins, glass), emissive: 0xffd9a0, emissiveMap: paintTex(true, H, bg, bands, wins), emissiveIntensity: 0 });
  if (wins.length) windowMats.push(m); return m;
};
const hex = n => '#' + n.toString(16).padStart(6, '0');

// ── The Staten Island Ferry ──
export function siFerryModel(F, windowMats = []) {
  const L = F.length_m || 94, small = L < 75, B = small ? 12.8 : Math.min(21.3, L * 0.225), half = L / 2, g = new THREE.Group();
  const ORANGE = 0xe8701c, BLACK = 0x1d1f22, DECK = 0x9da3a6, ROOF = 0xc9ccca;
  const M = c => new THREE.MeshLambertMaterial({ color: c });
  const orange = M(ORANGE), black = M(BLACK);
  const add = (o, y) => { o.position.y = y; g.add(o); return o; };
  // the hull: double-ended, its ends round in plan; orange to the main deck, the black boot-top at the water and a
  // black rubbing strake
  const HH = 4.4;
  add(deckhouse({ W: B, zf: -half, za: half, H: HH, nF: 2.3, nA: 2.3, roof: -1, side: sideMat(windowMats, HH, hex(ORANGE), [[0, 1.1, '#1d1f22'], [3.2, 3.55, '#1d1f22']]), top: M(DECK) }), -1.0);
  let y = HH - 1.0;
  // the decks: each an enclosed cabin of long window rows, the deck above overhanging it and carried out over the
  // open end decks, orange-sided
  const tiers = small ? [[0.62, 2.9], [0.5, 2.7]] : [[0.72, 3.0], [0.7, 3.0], [0.52, 2.8]];
  tiers.forEach(([f, h], k) => {
    const cabin = sideMat(windowMats, h, hex(ORANGE), [], [[0.95, h - 0.45, 1.25, 1.6]]);
    add(deckhouse({ W: B - 1.4, zf: -half * f, za: half * f, H: h, nF: 2.6, nA: 2.6, roof: -1, side: cabin, top: M(DECK) }), y);
    y += h;
    const over = k === tiers.length - 1 ? f + 0.06 : Math.min(0.9, f + 0.16), slabSide = sideMat(windowMats, 0.45, hex(ORANGE));
    add(deckhouse({ W: B - (k === tiers.length - 1 ? 2.4 : 0.6), zf: -half * over, za: half * over, H: 0.45, nF: 2.4, nA: 2.4, roof: -1, side: slabSide, top: M(k === tiers.length - 1 ? ROOF : DECK) }), y);
    y += 0.45;
  });
  // the pilothouses, one at each end on top, and the stack amidships, orange with a black top; masts
  const top = y, gl = new THREE.MeshLambertMaterial({ map: glassBand(false), emissive: 0xffd9a0, emissiveMap: glassBand(true), emissiveIntensity: 0 }); windowMats.push(gl);
  const pz = half * (tiers.at(-1)[0] + 0.02) - 2.6, pW = Math.min(9, B * 0.48);
  for (const s of [-1, 1]) {
    const ph = deckhouse({ W: pW, zf: s < 0 ? -pz - 2.4 : pz - 2.4, za: s < 0 ? -pz + 2.4 : pz + 2.4, H: 2.5, nF: 2.4, nA: 2.4, roof: 0.35, roofT: 0.2, side: gl, top: orange });
    add(ph, top);
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3.4, 0.2), black); m.position.set(0, top + 2.7 + 1.7, s * pz); g.add(m);
    lamp(g, 0xfff2d6, 0, top + 6.2, s * pz, windowMats);
  }
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 5.2, 16), orange); stack.scale.z = 1.6; stack.position.set(0, top + 2.6, 0); g.add(stack);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.52, 1.52, 0.9, 16), black); cap.scale.z = 1.6; cap.position.set(0, top + 4.8, 0); g.add(cap);
  // her name on the hull, toward each end, both sides (white on the orange)
  if (F.vessel) { const nm = nameBoard(F.vessel, 0, 0, null, '#ffffff'); for (const sx of [-1, 1]) for (const s of [-1, 1]) { const pl = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(16, L * 0.17), 1.3), nm); pl.position.set(sx * (B / 2 + 0.05), 1.6, s * half * 0.55); pl.rotation.y = sx * Math.PI / 2; g.add(pl); } }
  lamp(g, 0xff3b2e, -pW / 2, top + 1.5, -pz, windowMats); lamp(g, 0x3dff7a, pW / 2, top + 1.5, -pz, windowMats);
  g.userData.helm = [0, top + 1.6, -pz - 1.6];
  g.userData.lights = { mast: [0, top + 6.2, -pz], port: [-pW / 2, top + 1.5, -pz], stbd: [pW / 2, top + 1.5, -pz], stern: [0, top + 1, half * 0.6] };
  g.userData.wake = [wakeOf(B, L)]; g.add(g.userData.wake[0]);
  return g;
}

// ── The fast catamarans ──
export const CAT_LIVERY = {
  nycferry: { hull: [[-2, 0.55, 0x1d5aa6], [0.55, 0.9, 0x46b6d9]], top: 0xf4f4f1, cabin: 0xf4f4f1, glass: '#1c2a38', roof: 0xf4f4f1 },
  nywaterway: { hull: [[-2, 1.15, 0x1b2f5e], [1.15, 1.42, 0xd2232e]], top: 0xf4f4f1, cabin: 0xf4f4f1, glass: '#1c2a38', roof: 0xf4f4f1 },
  seastreak: { hull: [[-2, 0.9, 0x162a4e], [0.9, 1.05, 0xb9c0c6]], top: 0xf4f4f1, cabin: 0xf4f4f1, glass: '#141c26', roof: 0xf4f4f1 },
  generic: { hull: [[-2, 0.4, 0x2b3a4a]], top: 0xf2f1ec, cabin: 0xf2f1ec, glass: '#1f2a32', roof: 0xf2f1ec },
};
export function catModel(F, liv = CAT_LIVERY.generic, windowMats = []) {
  const L = F.length_m || 26, B = Math.max(7.5, Math.min(13, F.beam_m || L * 0.31)), half = L / 2, g = new THREE.Group();
  const M = c => new THREE.MeshLambertMaterial({ color: c }), white = M(liv.top);
  const add = (o, y) => { o.position.y = y; g.add(o); return o; };
  const sm = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  // the two hulls: slender, their bows near plumb and fine, the sheer rising a little forward; the livery in bands
  const hb = B * 0.27, SH = 2.0, sheer = u => SH + 0.35 * sm((u - 0.7) / 0.3);
  for (const sx of [-1, 1]) {
    const h = loftHull({
      L, B: hb, T: 1.15, sheer, runU: 0.08, rake: 0.03, forefoot: 0.05, transomRake: 0.004,
      uw: 0.62, wlTip: 0.02, wlAft: 0.95, ud: 0.66, dkTip: 0.05, dkPow: 2.0, dkAft: 0.97,
      flareP: () => 1.1, bilgeN: () => 2.4,
      bands: [...liv.hull.map(([, y1, c]) => [() => y1, c, 2]), [u => sheer(u), liv.top, 2]],
    });
    h.mesh.position.x = sx * (B / 2 - hb / 2); g.add(h.mesh);
  }
  // the bridging deck between them, and the main cabin on it: streamlined forward, windows all round
  const box = (w, hh, d, x, yy, z, m) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), m); k.position.set(x, yy, z); g.add(k); return k; };
  box(B, 0.6, L * 0.82, 0, SH - 0.3, 0.06 * L, M(liv.hull.at(-1)[2]));
  const cH = 2.5, cab = sideMat(windowMats, cH, hex(liv.cabin), [], [[0.75, 2.05, 1.5, 1.8]], liv.glass);
  add(deckhouse({ W: B - 0.2, zf: -half + 0.16 * L, za: half - 0.06 * L, H: cH, rakeF: 1.6, tumble: 0.25, nF: 2.0, nA: 6, roof: 0.25, roofT: 0.18, side: cab, top: M(0xa9afb3) }), SH);
  const UP = SH + cH + 0.18;
  // on top: the pilothouse forward, its glass leaning out; railings round the open seating aft, rows of benches
  const gl = new THREE.MeshLambertMaterial({ map: glassBand(false), emissive: 0xffd9a0, emissiveMap: glassBand(true), emissiveIntensity: 0 }); windowMats.push(gl);
  const pz0 = -half + 0.24 * L, pL = Math.min(5, L * 0.18);
  add(deckhouse({ W: B * 0.6, zf: pz0, za: pz0 + pL, H: 2.0, rakeF: -0.35, tumble: -0.05, nF: 2.4, nA: 6, roof: 0.3, roofT: 0.15, side: gl, top: M(liv.roof) }), UP);
  const rail = M(0xd0d4d6), a0 = pz0 + pL + 0.6, a1 = half - 0.08 * L - 0.3;
  for (const sx of [-1, 1]) box(0.05, 0.95, a1 - a0, sx * (B / 2 - 0.4), UP + 0.48, (a0 + a1) / 2, rail);
  box(B - 0.8, 0.95, 0.05, 0, UP + 0.48, a1, rail);
  const bench = M(0x2c4f7c);
  for (let z = a0 + 0.8; z < a1 - 0.6; z += 1.3) for (const sx of [-1, 1]) box(B * 0.32, 0.45, 0.5, sx * B * 0.2, UP + 0.23, z, bench);
  box(0.12, 2.0, 0.12, 0, UP + 2.0 + 1.0, pz0 + pL * 0.6, white);
  const radar = box(1.2, 0.1, 0.24, 0, UP + 2.0 + 1.7, pz0 + pL * 0.6, M(0x1d1f22)); radar.rotation.y = 0.5;
  // her name on each hull forward
  if (F.vessel) { const nm = nameBoard(F.vessel, 0, 0, null, hex(liv.hull[0][2])); for (const sx of [-1, 1]) { const pl = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(5, L * 0.2), 0.5), nm); pl.position.set(sx * (B / 2 + 0.03), SH - 0.45, -half + 0.22 * L); pl.rotation.y = sx * Math.PI / 2; g.add(pl); } }
  lamp(g, 0xfff2d6, 0, UP + 4.1, pz0 + pL * 0.6, windowMats, 0.12);
  lamp(g, 0xff3b2e, -B * 0.3, UP + 1.4, pz0 + 0.4, windowMats, 0.1); lamp(g, 0x3dff7a, B * 0.3, UP + 1.4, pz0 + 0.4, windowMats, 0.1);
  g.userData.helm = [0, UP + 1.4, pz0 + 0.6];
  g.userData.lights = { mast: [0, UP + 4.1, pz0 + pL * 0.6], port: [-B * 0.3, UP + 1.4, pz0 + 0.4], stbd: [B * 0.3, UP + 1.4, pz0 + 0.4], stern: [0, SH + 1, half] };
  g.userData.wake = [wakeOf(B, L)]; g.add(g.userData.wake[0]);
  return g;
}

// ── The sightseeing boats ──
export const EXC_LIVERY = {
  circleline: { hull: [[-3, 0.35, 0x1d1f22], [0.35, 1.6, 0x1f3f8f], [1.6, 1.85, 0xc8312b]], top: 0xf4f4f1, glass: '#1c2a38' },
  statue: { hull: [[-3, 0.35, 0x1d1f22], [0.35, 1.3, 0x173f74]], top: 0xf4f4f1, glass: '#1c2a38' },
  generic: { hull: [[-3, 0.35, 0x1d1f22], [0.35, 0.6, 0x2b3a4a]], top: 0xf2f1ec, glass: '#1f2a32' },
};
export function excursionModel(F, liv = EXC_LIVERY.generic, windowMats = []) {
  const L = F.length_m || 40, B = Math.max(7, Math.min(13, F.beam_m || L * 0.25)), half = L / 2, g = new THREE.Group();
  const M = c => new THREE.MeshLambertMaterial({ color: c });
  const add = (o, y) => { o.position.y = y; g.add(o); return o; };
  const sm = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  const SH = 2.3, sheer = u => SH + 0.9 * sm((u - 0.65) / 0.35);
  const hull = loftHull({
    L, B, T: 1.7, sheer, runU: 0.18, rake: 0.08, forefoot: 0.2, transomRake: 0.01,
    uw: 0.55, wlTip: 0.04, wlAft: 0.92, ud: 0.66, dkTip: 0.08, dkPow: 2.0, dkAft: 0.95,
    flareP: u => 1 + 0.8 * sm((u - 0.5) / 0.4), bilgeN: u => 2 + 1.5 * (1 - sm((u - 0.5) / 0.4)),
    bands: [...liv.hull.map(([, y1, c]) => [() => y1, c, 2]), [u => sheer(u), liv.top, 2]],
  });
  g.add(hull.mesh);
  g.add(hull.deck(0, () => SH - 0.05, 0x9aa19d, 0.995, 0.05));
  // two enclosed decks, the lower nearly her length, big windows; an open top deck with the pilothouse forward
  const tiers = [[0.13, 0.95, 2.6], [0.2, 0.86, 2.5]];
  let y = SH;
  const Z = t => -half + t * L;
  for (const [t0, t1, h] of tiers) {
    const side = sideMat(windowMats, h, hex(liv.top), [], [[0.75, h - 0.35, 1.7, 2.0]], liv.glass);
    add(deckhouse({ W: B - 0.6, zf: Z(t0), za: Z(t1), H: h, rakeF: 0.9, tumble: 0.2, nF: 2.2, nA: 6, roof: 0.3, roofT: 0.2, side, top: M(0xa9afb3) }), y);
    y += h + 0.2;
  }
  const gl = new THREE.MeshLambertMaterial({ map: glassBand(false), emissive: 0xffd9a0, emissiveMap: glassBand(true), emissiveIntensity: 0 }); windowMats.push(gl);
  add(deckhouse({ W: B * 0.5, zf: Z(0.24), za: Z(0.24) + 4, H: 2.1, rakeF: -0.35, tumble: -0.05, nF: 2.4, nA: 6, roof: 0.3, roofT: 0.15, side: gl, top: M(liv.top) }), y);
  const rail = M(0xe0e2e2), box = (w, hh, d, x, yy, z, m) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), m); k.position.set(x, yy, z); g.add(k); return k; };
  for (const sx of [-1, 1]) box(0.05, 1.0, (Z(0.84) - Z(0.32)), sx * (B / 2 - 0.55), y + 0.5, (Z(0.84) + Z(0.32)) / 2, rail);
  box(B - 1.1, 1.0, 0.05, 0, y + 0.5, Z(0.84), rail);
  box(0.14, 2.6, 0.14, 0, y + 2.1 + 1.3, Z(0.24) + 2.4, M(liv.top));
  if (F.vessel) { const nm = nameBoard(F.vessel, 0, 0, null, hex(liv.hull[1]?.[2] ?? 0x1d1f22)); for (const sx of [-1, 1]) { const u = 0.8, yy = SH + 0.1, pl = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(7, L * 0.17), 0.6), nm); pl.position.set(sx * (hull.half(u, yy) + 0.04), yy, hull.z(u, yy)); pl.rotation.y = sx * Math.PI / 2; g.add(pl); } }
  lamp(g, 0xfff2d6, 0, y + 4.0, Z(0.24) + 2.4, windowMats, 0.13);
  lamp(g, 0xff3b2e, -B * 0.25, y + 1.3, Z(0.24) + 0.4, windowMats, 0.1); lamp(g, 0x3dff7a, B * 0.25, y + 1.3, Z(0.24) + 0.4, windowMats, 0.1);
  g.userData.helm = [0, y + 1.4, Z(0.24) + 0.6];
  g.userData.lights = { mast: [0, y + 4.0, Z(0.24) + 2.4], port: [-B * 0.25, y + 1.3, Z(0.24) + 0.4], stbd: [B * 0.25, y + 1.3, Z(0.24) + 0.4], stern: [0, SH + 1, half] };
  g.userData.wake = [wakeOf(B, L)]; g.add(g.userData.wake[0]);
  return g;
}

// ── Which one she is: from her name, where she's bound and her size; null if she isn't one of New York's (in the
// harbour, lat 40.4-41.1, lon -74.4 to -73.6) ──
const SI = /^(GUY V\.? MOLINARI|SANDY GROUND|DOROTHY DAY|SAMUEL I\.? NEWHOUSE|SEN\.? ?JOHN J\.? ?MARCHI|ANDREW J\.? BARBERI|SPIRIT OF AMERICA|S\.?S\.?G\.? MICHAEL H\.? OLLIS|JOHN F\.? KENNEDY|JOHN A\.? NOBLE|ALICE AUSTEN)$/i;
// NY Waterway's boats, by name (the ones the live feed shows, and the fleet's better-known others) or by where
// they say they're bound (its New Jersey runs)
const NYW = /^(FRANK SINATRA|YOGI BERRA|ADM\.? RICHARD E\.? BENNIS|GOV\.? THOMAS H\.? KEAN|CONG\.? ROBERT A\.? ROE|FIORELLO LA ?GUARDIA|MOLLY PITCHER|BETSY ROSS|FRANKLIN D\.? ROOSEVELT|THOMAS JEFFERSON|GEORGE WASHINGTON|ALEXANDER HAMILTON|HENRY HUDSON|ABRAHAM LINCOLN|DOROTHY ADDIE|MOIRA SMITH|BRENDAN T\.? BYRNE|JAMES FLORIO|SEN\.? FRANK LAUTENBERG|PORT IMPERIAL MANHATTAN|ENDURING FREEDOM|AUSTIN TOBIN)$/i;
const NYW_DEST = /NJ ?<> ?NYC|HOBOKEN|WEEHAWKEN|PORT IMPERIAL|PAULUS HOOK|WORLD FI|BELFORD|EDGEWATER/i;
const CIRCLE = /^CIRCLE LINE|^(BEAST|SHARK)$/i, STATUE = /^MISS (LIBERTY|FREEDOM|ELLIS ISLAND|NEW YORK|GATEWAY)/i, SEASTREAK = /SEASTREAK|^COMMODORE$/i;
// → { build(windowMats) → group, L, what } or null
export function harborKind(A) {
  if (!(A.lat > 40.4 && A.lat < 41.1 && A.lon > -74.4 && A.lon < -73.6)) return null;
  const name = (A.name || '').trim(), L = A.L, F = { vessel: name, length_m: L, beam_m: A.B };
  const one = (fn, liv, len, what) => ({ build: wm => fn({ ...F, length_m: len }, ...(liv ? [liv] : []), wm), L: len, what });
  if (SI.test(name)) { const len = L || (/NOBLE|AUSTEN/i.test(name) ? 63 : 94); return { build: wm => siFerryModel({ ...F, length_m: len }, wm), L: len, what: 'Staten Island Ferry' }; }
  if (SEASTREAK.test(name)) return one(catModel, CAT_LIVERY.seastreak, L || 43, 'Seastreak ferry');
  if (NYW.test(name) || NYW_DEST.test(A.dest || '')) return one(catModel, CAT_LIVERY.nywaterway, L || 26, 'NY Waterway ferry');
  if (CIRCLE.test(name)) return one(excursionModel, EXC_LIVERY.circleline, L || 45, 'Circle Line sightseeing boat');
  if (STATUE.test(name)) return one(excursionModel, EXC_LIVERY.statue, L || 40, 'Statue City Cruises ferry');
  // the rest by size and shape: NYC Ferry's 26 m catamarans (beamy for their length), else a sightseeing boat
  if (!L || (L >= 20 && L <= 32 && (!A.B || A.B / L >= 0.27))) return one(catModel, CAT_LIVERY.nycferry, L || 26, 'NYC Ferry');
  if (L > 32 && L < 80) return one(excursionModel, EXC_LIVERY.generic, L, 'Harbor sightseeing boat');
  return null;
}
