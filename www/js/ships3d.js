// Ships drawn as their kind, in their owners' colours (v1001, requested: "depict ships in a way approximating how
// they look … emphasizing efficiency but also verisimilitude"). Three layers, cheapest first:
//  · a model for each kind of ship (here: the product tanker, the harbour tug, the pilot boat), shaped from her
//    AIS dimensions — length, beam, and her draught, which sets how deep she lies;
//  · liveries (data/ships.json), one per operator and matched by name, so one entry dresses a whole fleet: Iver
//    Ships' red with the white V, McAllister's black, maroon and gold, the Portland pilots' black and grey;
//  · particulars for a ship that calls here (data/ships.json `ships`, from her owner's published spec sheet),
//    matched by MMSI or name, for her length, beam and depth before her AIS static data comes in, and anything
//    her model needs that AIS doesn't send.
// A ship in no list still gets her kind's model, in colours picked from her name, from a palette of real ones.
// Bow toward −z, waterline y = 0, as vessels.js.
import * as THREE from 'three';
import { loftHull, deckhouse, nameBoard, lamp, wakeOf, windowRows, glassBand } from './vessels.js';

const sm = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const hex = c => typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : c;
const seedOf = s => [...(s || 'ship')].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 2147483647, 7) || 7;

// ── Which ship, which livery ──
let SHIPS = { liveries: [], ships: [] };
export function setShips(d) { SHIPS = { liveries: (d?.liveries || []).map(l => ({ ...l, re: new RegExp(l.match, 'i') })), ships: d?.ships || [] }; }
const letters = t => (t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// her record (by MMSI, else her name: AIS cuts names at 20 characters, so the start of one will do) and her livery
export function shipFor(mmsi, name) {
  const k = letters(name);
  const S = SHIPS.ships.find(s => s.mmsi && String(s.mmsi) === String(mmsi)) || (k.length >= 6 ? SHIPS.ships.find(s => letters(s.name).startsWith(k) || (s.aka || []).some(a => letters(a).startsWith(k))) : null) || null;
  const liv = (S?.livery && SHIPS.liveries.find(l => l.id === S.livery)) || SHIPS.liveries.find(l => l.re.test(name || '')) || null;
  return { S, liv };
}

// a livery for a ship in no list: real tanker colours, picked by her name
const TANKER_LOOKS = [
  { hull: '#8f2a26', boot: '#5a1c1a', deck: '#8f3a2e', house: '#f2f1ec', funnel: '#f2f1ec', funnelTop: '#1d1f22' },
  { hull: '#1f2a3a', boot: '#7a2a24', deck: '#6b2f2a', house: '#f2f1ec', funnel: '#24395f', funnelTop: '#1d1f22' },
  { hull: '#24395f', boot: '#7a2a24', deck: '#5e6b4e', house: '#f2f1ec', funnel: '#c8a03a', funnelTop: '#1d1f22' },
  { hull: '#1d1f22', boot: '#7a2a24', deck: '#7a3a2e', house: '#e9e4d6', funnel: '#b3262b', funnelTop: '#1d1f22' },
  { hull: '#3d4a3e', boot: '#7a2a24', deck: '#5e6b4e', house: '#f2f1ec', funnel: '#2f6f9a', funnelTop: '#1d1f22' },
];
const pick = (arr, name) => arr[seedOf(name) % arr.length];
// a rail: a top bar on stanchions, along z from z0 to z1 at x, its foot at y
function rail(g, mat, x, y, z0, z1, h = 0.9, every = 1.6, r = 0.03) {
  const bar = new THREE.Mesh(new THREE.BoxGeometry(r * 2, r * 2, Math.abs(z1 - z0)), mat); bar.position.set(x, y + h, (z0 + z1) / 2); g.add(bar);
  const n = Math.max(1, Math.round(Math.abs(z1 - z0) / every));
  for (let i = 0; i <= n; i++) { const p = new THREE.Mesh(new THREE.BoxGeometry(r * 2, h, r * 2), mat); p.position.set(x, y + h / 2, z0 + (z1 - z0) * i / n); g.add(p); }
}

// a painted mark on her side, from a canvas: Vroon's white V (on Iver Ships' tankers, forward of the manifold)
function markMat(kind, color) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128; const c = cv.getContext('2d');
  c.fillStyle = color;
  if (kind === 'vroon-v') {   // a broad V, its left arm longer: as painted, leaning aft
    c.beginPath(); c.moveTo(0, 0); c.lineTo(78, 0); c.lineTo(128, 96); c.lineTo(178, 0); c.lineTo(256, 0); c.lineTo(150, 128); c.lineTo(106, 128); c.closePath(); c.fill();
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshLambertMaterial({ map: t, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
}
// a word painted large (PILOT), filling its board
function wordMat(text, color) {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128; const c = cv.getContext('2d');
  c.fillStyle = color; c.font = 'bold 112px Helvetica, Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 256, 70, 500);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshLambertMaterial({ map: t, transparent: true, alphaTest: 0.4, polygonOffset: true, polygonOffsetFactor: -2 });
}
// a plane laid on her side at station u, height y, square to the hull there
function onSide(g, hull, mat, u, y, w, h, sx) {
  const dx = hull.half(u + 0.01, y) - hull.half(u - 0.01, y), dz = hull.z(u + 0.01, y) - hull.z(u - 0.01, y), k = Math.hypot(dx, dz), nx = sx * -dz / k, nz = dx / k;
  const pl = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  pl.position.set(sx * hull.half(u, y) + nx * 0.05, y, hull.z(u, y) + nz * 0.05); pl.rotation.y = Math.atan2(nx, nz) + (sx < 0 ? 0 : 0); g.add(pl); return pl;
}

// ── A product/chemical tanker (Iver Prosperity: 184 m, 27.4 m beam, 17.2 m deep, the Hyundai Mipo 37,000-tonne type;
// the photo of Iver Beauty, her fleet-mate, for the look) ── The hull lofted: a long parallel body, a bulbous bow
// with a near-plumb stem, a broad transom; her freeboard her depth less her draught (AIS sends it), so she lies deep
// loaded and high in ballast. Her main deck carries the cargo-pipe runs down the middle, the manifold across
// amidships with the hose crane, the raised catwalk from the house to the forecastle, rows of tank hatches; the
// forecastle at the bow with the foremast; aft, the accommodation five decks high with the bridge across her full
// beam, the funnel abaft it, the free-fall lifeboat on its ramp over the stern.
export function tankerModel(V, liv, windowMats = []) {
  const L = V.L || 150, B = V.B || L * 0.15, D = V.D || L * 0.093, half = L / 2, g = new THREE.Group();
  const look = { ...pick(TANKER_LOOKS, V.name), ...(liv || {}) };
  const M = c => new THREE.MeshLambertMaterial({ color: hex(c) });
  const house = M(look.house), dark = M(0x1d1f22), steel = M(0xb9b4a8), deckM = M(look.deck), funnelM = M(look.funnel);
  const box = (w, h, d, x, y, z, m) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); k.position.set(x, y, z); g.add(k); return k; };
  const T = Math.max(D * 0.32, Math.min(D * 0.72, V.T || D * 0.6));   // her draught now (AIS), within reason
  const FB = D - T;                                                    // her freeboard
  const sheer = u => FB + D * 0.04 * Math.max(0, (u - 0.75) / 0.25) ** 2;
  const hull = loftHull({
    L, B, T, sheer, runU: 0.16, rake: 0.012, forefoot: 0.0, transomRake: 0.02,
    uw: 0.8, wlTip: 0.06, wlAft: 0.78, ud: 0.84, dkTip: 0.1, dkPow: 2.2, dkAft: 0.9,
    flareP: u => 1 + 0.6 * sm((u - 0.85) / 0.12), bilgeN: u => 2.2 + 2.6 * (1 - sm((u - 0.7) / 0.25)),
    bands: [[() => Math.min(0.6, T * 0.06), hex(look.boot), 3], [u => sheer(u), hex(look.hull), 6]],
    NU: 64,
  });
  g.add(hull.mesh);
  g.add(hull.deck(0, sheer, hex(look.deck), 0.995, 0.25));
  // the forecastle: raised 2.6 m over the last tenth, its sides the hull's carried up, a grey deck
  const FC = 2.6, uFC = 0.9;
  g.add(hull.wall(u => u < uFC ? sheer(u) + 1.1 : sheer(u) + FC + 1.1 * sm((u - uFC) / 0.02), hex(look.hull)));   // the bulwark / forecastle sides
  g.add(hull.deck(uFC, u => sheer(u) + FC, hex(look.deck), 0.995, 0.1));
  // the white V forward (or her owner's mark), and her name at the bow and across the stern
  if (look.mark) { const mm = markMat(look.mark, look.markColor || '#f4f3ef'); for (const sx of [-1, 1]) onSide(g, hull, mm, 0.76, FB * 0.42, FB * 1.6, FB * 0.84, sx); }
  if (V.name) {
    const nm = nameBoard(V.name, 0, 0, null, look.name || '#f4f3ef');
    for (const sx of [-1, 1]) onSide(g, hull, nm, 0.86, sheer(0.86) - 1.6, Math.min(26, L * 0.13), 2.4, sx);
    const st = new THREE.Mesh(new THREE.PlaneGeometry(B * 0.6, 1.6), nm); st.position.set(0, FB - 1.6, hull.z(0, FB - 1.6) + 0.08); g.add(st);
  }
  // the accommodation aft: five decks, windows in rows (lit at night), the bridge across her beam on top
  const za = half - L * 0.045, zf = za - L * 0.085, hL = za - zf, nD = L > 150 ? 6 : 5, dh = 2.8, hW = B * 0.82;
  const side = new THREE.MeshLambertMaterial({ map: windowRows(hL / 3, false, 32, look.house), emissive: 0xffd9a0, emissiveMap: windowRows(hL / 3, true, 32), emissiveIntensity: 0 });
  for (const t of [side.map, side.emissiveMap]) { t.wrapT = THREE.RepeatWrapping; t.repeat.y = nD; } windowMats.push(side);   // (a row of windows to each deck)
  const acc = deckhouse({ W: hW, zf, za, H: nD * dh, nF: 14, nA: 14, roof: 0.4, roofT: 0.3, side, top: house });
  acc.position.y = FB; g.add(acc);
  const BR = FB + nD * dh + 0.3, bL = hL * 0.55, bZ = zf + bL / 2;
  const gl = new THREE.MeshLambertMaterial({ map: glassBand(false), emissive: 0xffd9a0, emissiveMap: glassBand(true), emissiveIntensity: 0 }); windowMats.push(gl);
  const bridge = deckhouse({ W: B * 0.6, zf, za: zf + bL, H: 2.9, rakeF: -0.25, nF: 12, nA: 12, roof: 0.5, roofT: 0.35, side: gl, top: house });
  bridge.position.y = BR; g.add(bridge);
  box(B * 1.0, 0.45, 4.2, 0, BR + 2.6, zf + 2.4, house);   // the bridge wings, out to her sides
  for (const sx of [-1, 1]) box(1.6, 2.6, 3.6, sx * (B * 0.5 - 0.8), BR + 1.3, zf + 2.4, house);   // (their cabs, closed)
  // the radar mast on the wheelhouse top, its two scanners
  const MT = BR + 3.3;
  box(0.5, 7, 0.5, 0, MT + 3.5, bZ + bL * 0.2, house); box(5, 0.4, 0.5, 0, MT + 4.6, bZ + bL * 0.2, house);
  for (const sx of [-1, 1]) { const r = box(3.2, 0.2, 0.5, sx * 2.0, MT + 5.0, bZ + bL * 0.2, dark); r.rotation.y = sx * 0.4; }
  // the funnel abaft the bridge: tapered, its top black
  const fH = 9, fz = zf + hL * 0.72;
  const fun = new THREE.Mesh(new THREE.CylinderGeometry(B * 0.11, B * 0.13, fH, 16), funnelM); fun.scale.z = 1.5; fun.position.set(0, BR + fH / 2 - 1, fz); g.add(fun);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(B * 0.112, B * 0.112, 1.8, 16), M(look.funnelTop || '#1d1f22')); top.scale.z = 1.5; top.position.set(0, BR + fH - 1.9, fz); g.add(top);
  if (look.funnelBand) { const b = new THREE.Mesh(new THREE.CylinderGeometry(B * 0.116, B * 0.118, 1.4, 16), M(look.funnelBand)); b.scale.z = 1.5; b.position.set(0, BR + fH * 0.55, fz); g.add(b); }
  // the free-fall lifeboat on its ramp over the stern, orange
  const lb = box(3.2, 3.0, 9.5, 0, FB + nD * dh * 0.45, za + 3.5, M(0xe8731f)); lb.rotation.x = -0.6;
  box(4.2, 0.4, 10, 0, FB + nD * dh * 0.45 - 1.8, za + 3.4, house).rotation.x = -0.6;
  // the cargo deck: the pipe runs down the middle, the catwalk over them, the manifold across amidships with its
  // hose crane, rows of tank hatches each side, the deck foam monitors at the house front
  const dz0 = -half + L * 0.1 + 2, dz1 = zf - 2, dL = dz1 - dz0, dZ = (dz0 + dz1) / 2;
  for (const [x, r] of [[-1.6, 0.35], [-0.8, 0.45], [0, 0.45], [0.8, 0.35], [1.6, 0.3]]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r, dL, 8), steel); p.rotation.x = Math.PI / 2; p.position.set(x, FB + 1.0, dZ); g.add(p); }
  const cw = box(1.4, 0.2, dL + 4, B * 0.12, FB + 2.9, dZ - 2, M(look.catwalk || look.house));
  for (let z = dz0; z < dz1; z += 9) box(0.25, 2.8, 0.25, B * 0.12, FB + 1.5, z, steel);
  for (const sx of [-1, 1]) box(0.06, 0.9, dL + 4, B * 0.12 + sx * 0.7, FB + 3.4, dZ - 2, steel);   // its rails
  const mz = -L * 0.02;
  box(B * 0.92, 1.8, 3.4, 0, FB + 0.9, mz, steel);   // the manifold
  box(B * 0.95, 0.9, 6, 0, FB + 0.45, mz, M(look.drip || look.deck));   // its drip trays
  const cr = M(look.crane || look.house);
  box(1.0, 9, 1.0, 0, FB + 4.5, mz + 4.5, cr); const jib = box(0.7, 0.7, 15, 0, FB + 10.5, mz - 1.5, cr); jib.rotation.x = -0.35;   // the hose crane
  for (const sx of [-1, 1]) for (let i = 0; i < 6; i++) { const h = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.7, 10), steel); h.position.set(sx * B * 0.3, FB + 0.35, dz0 + (i + 0.5) * dL / 6); g.add(h); }
  for (const sx of [-1, 1]) box(0.6, 1.4, 0.6, sx * 2.2, FB + 0.7 + 0.5, zf - 3, M(0xc8302a));   // foam monitors
  // the foremast on the forecastle, the windlasses, the bow-thruster mark
  box(0.7, 12, 0.7, 0, FB + FC + 6, -half + L * 0.05, house);
  for (const sx of [-1, 1]) box(1.6, 1.0, 2.2, sx * B * 0.18, FB + FC + 0.5, -half + L * 0.075, M(0x5e6b4e));
  // running lights: forward and after masthead lights, sidelights at the wings, the stern light
  lamp(g, 0xfff2d6, 0, FB + FC + 12.2, -half + L * 0.05, windowMats, 0.5);
  lamp(g, 0xfff2d6, 0, MT + 7.2, bZ + bL * 0.2, windowMats, 0.5);
  lamp(g, 0xff3b2e, -B * 0.5, BR + 3.2, zf + 1.0, windowMats, 0.45); lamp(g, 0x3dff7a, B * 0.5, BR + 3.2, zf + 1.0, windowMats, 0.45);
  lamp(g, 0xfff2d6, 0, FB + 2, half - 0.3, windowMats, 0.45);
  g.userData.helm = [0, BR + 1.8, zf - 0.6];
  g.userData.top = MT + 7;   // (her height, for her label)
  g.userData.wake = [wakeOf(B, L)]; g.add(g.userData.wake[0]);
  return g;
}

// ── A harbour tug, ship-assist (McAllister's at Portland: the Andrew, Rowan, Vicki M. and Rosemary McAllister,
// Fournier Girls; Commons photos of Capt. Brian A. McAllister for the look) ── A short, beamy hull, her sheer
// sweeping high to a full bow, the heavy bow fender ("pudding") round the stem and tyres along her sides; the
// main deckhouse with a white band at its top, the tall wheelhouse above it with windows all round, for seeing
// the ship she's pushing; twin stacks abaft it; the towing winch and H-bitt aft. Black hull, the gold sheer
// stripe, the maroon house, the red stacks with black tops, by her livery.
export function tugModel(V, liv, windowMats = []) {
  const L = V.L || 28, B = V.B || L * 0.36, half = L / 2, g = new THREE.Group();
  const look = { hull: '#1d1f22', stripe: '#d9a52b', house: '#7a1f22', band: '#f2f1ec', funnel: '#a3262b', funnelTop: '#1d1f22', name: '#d9a52b', ...pick([{}, { house: '#f2f1ec', band: '#1d1f22', funnel: '#1d1f22', stripe: '#f2f1ec', name: '#f2f1ec' }, { hull: '#24395f', house: '#f2f1ec', stripe: '#f2f1ec', funnel: '#24395f', name: '#f2f1ec' }], V.name), ...(liv || {}) };
  const M = c => new THREE.MeshLambertMaterial({ color: hex(c) });
  const houseM = M(look.house), white = M(look.band), black = M(0x1d1f22);
  const box = (w, h, d, x, y, z, m) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); k.position.set(x, y, z); g.add(k); return k; };
  const SH = 1.5;
  const sheer = u => SH + 0.25 * Math.max(0, (0.25 - u) / 0.25) ** 2 + 1.5 * Math.max(0, (u - 0.35) / 0.65) ** 2.1;
  const hull = loftHull({
    L, B, T: L * 0.15, sheer, runU: 0.3, rake: 0.05, forefoot: 0.22, transomRake: 0.03,
    uw: 0.5, wlTip: 0.06, wlAft: 0.8, ud: 0.55, dkTip: 0.22, dkPow: 1.6, dkAft: 0.88,
    flareP: u => 1 + 0.8 * sm((u - 0.45) / 0.4), bilgeN: u => 1.6 + 1.0 * (1 - sm((u - 0.5) / 0.4)),
    bands: [[() => 0.15, 0x7a2a24, 3], [u => sheer(u) - 0.55, hex(look.hull), 4], [u => sheer(u) - 0.35, hex(look.stripe), 1], [u => sheer(u), hex(look.hull), 1]],
    stemFace: true,
  });
  g.add(hull.mesh);
  g.add(hull.wall(u => sheer(u) + 0.75, hex(look.hull)));   // the bulwark
  g.add(hull.deck(0, sheer, 0x7d4a3a, 0.99, 0.06));
  // the fenders: the pudding round the bow, a band of tyres along each side, the stern fender
  const pud = new THREE.Mesh(new THREE.TorusGeometry(B * 0.32, 0.55, 8, 20, Math.PI), black); pud.rotation.set(Math.PI / 2, 0, Math.PI); pud.position.set(0, sheer(1) - 0.2, hull.z(0.97, sheer(1)) + B * 0.2); g.add(pud);
  for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) { const u = 0.12 + i * 0.09, y = sheer(u) - 0.95, t = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.17, 6, 12), black); t.position.set(sx * (hull.half(u, y) + 0.15), y, hull.z(u, y)); t.rotation.y = Math.PI / 2; g.add(t); }
  box(B * 0.8, 0.8, 0.8, 0, SH - 0.2, half + 0.1, black);
  // the main deckhouse, its white band, then the upper deck and the tall wheelhouse
  const hz0 = -half + L * 0.3, hz1 = half - L * 0.32, hH = 2.4, hW = B * 0.66;
  const side = new THREE.MeshLambertMaterial({ map: windowRows((hz1 - hz0) / 2, false, 32, look.house), emissive: 0xffd9a0, emissiveMap: windowRows((hz1 - hz0) / 2, true, 32), emissiveIntensity: 0 });
  windowMats.push(side);
  const mh = deckhouse({ W: hW, zf: hz0, za: hz1, H: hH, nF: 3, nA: 6, roof: 0.15, roofT: 0.35, side, top: white });
  mh.position.y = SH; g.add(mh);
  const UP = SH + hH + 0.35, wL = Math.min(4.2, L * 0.15), wz0 = hz0 + 0.6;
  box(hW * 0.8, 2.1, wL + 1.6, 0, UP + 1.05, wz0 + (wL + 1.6) / 2, houseM);   // the upper deck house
  const gl = new THREE.MeshLambertMaterial({ map: glassBand(false), emissive: 0xffd9a0, emissiveMap: glassBand(true), emissiveIntensity: 0 }); windowMats.push(gl);
  const WH = UP + 2.1, wh = deckhouse({ W: hW * 0.95, zf: wz0, za: wz0 + wL, H: 2.3, rakeF: -0.3, tumble: -0.1, nF: 2.6, nA: 4, roof: 0.35, roofT: 0.25, side: gl, top: white });
  wh.position.y = WH; g.add(wh);
  for (const sx of [-1, 1]) box(0.05, 0.9, wL + 1.4, sx * hW * 0.45, UP + 2.55, wz0 + wL / 2, white);   // the rail round the wheelhouse deck
  // the mast over the wheelhouse, its lights and searchlights
  const mT = WH + 2.6;
  box(0.22, 3.6, 0.22, 0, mT + 1.8, wz0 + wL * 0.6, white); box(2.2, 0.15, 0.15, 0, mT + 2.2, wz0 + wL * 0.6, white);
  for (const sx of [-1, 1]) box(0.45, 0.45, 0.45, sx * 0.9, mT + 0.25, wz0 + 0.5, white);
  // twin stacks abaft the wheelhouse
  for (const sx of [-1, 1]) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 3.2, 12), M(look.funnel)); s.scale.z = 1.6; s.position.set(sx * hW * 0.3, UP + 1.6, wz0 + wL + 2.0); g.add(s);
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.7, 12), M(look.funnelTop)); t.scale.z = 1.6; t.position.set(sx * hW * 0.3, UP + 2.9, wz0 + wL + 2.0); g.add(t);
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.52, 0.35, 12), white); b.scale.z = 1.6; b.position.set(sx * hW * 0.3, UP + 1.9, wz0 + wL + 2.0); g.add(b);
  }
  // the towing winch, the H-bitt aft
  box(B * 0.4, 1.2, 1.6, 0, SH + 0.6, hz1 + 1.6, M(0x2f6f3a));
  box(B * 0.5, 0.35, 0.4, 0, SH + 1.2, half - 2, white); for (const sx of [-1, 1]) box(0.35, 1.2, 0.35, sx * B * 0.22, SH + 0.6, half - 2, white);
  if (V.name) { const nm = nameBoard(V.name, 0, 0, null, look.name); for (const sx of [-1, 1]) onSide(g, hull, nm, 0.66, sheer(0.66) - 0.85, Math.min(10, L * 0.33), 0.75, sx); }
  lamp(g, 0xfff2d6, 0, mT + 3.6, wz0 + wL * 0.6, windowMats, 0.14); lamp(g, 0xfff2d6, 0, mT + 2.6, wz0 + wL * 0.6, windowMats, 0.14);   // (two masthead lights: towing)
  lamp(g, 0xff3b2e, -hW * 0.48, WH + 1.2, wz0 + 0.6, windowMats, 0.12); lamp(g, 0x3dff7a, hW * 0.48, WH + 1.2, wz0 + 0.6, windowMats, 0.12);
  lamp(g, 0xfff2d6, 0, SH + 1.3, half - 0.3, windowMats, 0.12);
  g.userData.helm = [0, WH + 1.6, wz0 + 0.4];
  g.userData.top = mT + 3.6;
  g.userData.wake = [wakeOf(B, L)]; g.add(g.userData.wake[0]);
  return g;
}

// ── A pilot boat (the Portland pilots' Spring Point: Gladding-Hearn, 2004, C. Raymond Hunt design, 52.5 × 17 ft,
// 4.8 ft draught; from a 2009 photo for the look) ── An aluminium deep-V hull, black with a pale blue boot stripe,
// a black rub rail; the cabin a little forward of amidships, light grey, "PILOT" in red on each side, windows all
// round; wide side decks with heated rails; the mast and radar on the roof; the open after deck with the rescue
// U-frame over the transom.
export function pilotModel(V, liv, windowMats = []) {
  const L = V.L || 16, B = V.B || L * 0.32, half = L / 2, g = new THREE.Group();
  const look = { hull: '#1d1f22', boot: '#6fa8d6', house: '#d7dadb', word: '#c8302a', ...(liv || {}) };
  const M = c => new THREE.MeshLambertMaterial({ color: hex(c) });
  const houseM = M(look.house), black = M(0x1d1f22), steel = M(0xb9bec2);
  const box = (w, h, d, x, y, z, m) => { const k = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); k.position.set(x, y, z); g.add(k); return k; };
  const SH = 1.25;
  const sheer = u => SH + 0.1 * Math.max(0, (0.3 - u) / 0.3) ** 2 + 0.7 * Math.max(0, (u - 0.35) / 0.65) ** 2;
  const hull = loftHull({
    L, B, T: L * 0.06, sheer, runU: 0.25, rake: 0.08, forefoot: 0.3, transomRake: 0.01,
    uw: 0.45, wlTip: 0.02, wlAft: 0.9, ud: 0.55, dkTip: 0.05, dkPow: 2.0, dkAft: 0.95,
    flareP: u => 1 + 1.0 * sm((u - 0.4) / 0.4), bilgeN: u => 1.1 + 0.4 * (1 - sm((u - 0.5) / 0.4)),
    bands: [[() => 0.12, hex(look.boot), 2], [u => sheer(u), hex(look.hull), 5]],
  });
  g.add(hull.mesh);
  g.add(hull.strake(u => sheer(u) - 0.5, 0.14, 0x1d1f22, 0.01, 0.97, 0.06));   // the rub rail
  g.add(hull.deck(0, sheer, 0x8d9296, 0.995, 0.05));
  // the cabin, forward of amidships, its windows wrapping round; PILOT on each side
  const cz0 = -half + L * 0.3, cz1 = cz0 + L * 0.36, cW = B * 0.66, cH = 2.0;
  const side = new THREE.MeshLambertMaterial({ map: windowRows((cz1 - cz0) / 1.2, false, 40, look.house), emissive: 0xffd9a0, emissiveMap: windowRows((cz1 - cz0) / 1.2, true, 40), emissiveIntensity: 0 });
  windowMats.push(side);
  const cab = deckhouse({ W: cW, zf: cz0, za: cz1, H: cH, rakeF: 0.45, tumble: 0.12, nF: 2.2, nA: 8, roof: 0.12, roofT: 0.12, side, top: houseM });
  cab.position.y = SH; g.add(cab);
  const word = wordMat('PILOT', look.word);
  for (const sx of [-1, 1]) { const p = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(3.4, cz1 - cz0 - 1.4), 0.62), word); p.position.set(sx * (cW / 2 - 0.12 * 0.15 + 0.04), SH + 0.3, (cz0 + cz1) / 2 + 0.3); p.rotation.y = sx * Math.PI / 2; g.add(p); }   // (below the windows, on the tumbled-in side)
  // the rails round the side decks and the roof, the mast and radar
  for (const sx of [-1, 1]) rail(g, steel, sx * (B / 2 - 0.2), sheer(0.5), -half + L * 0.28, -half + L * 0.82, 0.85, 1.5);
  for (const sx of [-1, 1]) rail(g, steel, sx * (cW / 2 - 0.35), SH + cH + 0.12, cz0 + 0.8, cz1 - 0.4, 0.5, 1.2, 0.025);
  box(0.12, 2.4, 0.12, 0, SH + cH + 1.3, (cz0 + cz1) / 2 + 0.4, steel);
  const rad = box(1.2, 0.1, 0.25, 0, SH + cH + 0.5, (cz0 + cz1) / 2 - 0.5, black); rad.rotation.y = 0.5;
  // the rescue U-frame over the transom
  for (const sx of [-1, 1]) box(0.12, 2.0, 0.12, sx * B * 0.3, SH + 1.0, half - 0.4, steel);
  box(B * 0.6 + 0.12, 0.12, 0.12, 0, SH + 2.0, half - 0.4, steel);
  if (V.boat) { const nm = nameBoard(V.boat.toUpperCase(), 0, 0, null, '#f4f3ef'); for (const sx of [-1, 1]) onSide(g, hull, nm, 0.2, SH - 0.45, Math.min(3.4, L * 0.22), 0.35, sx); }
  lamp(g, 0xfff2d6, 0, SH + cH + 2.5, (cz0 + cz1) / 2 + 0.4, windowMats, 0.1);
  lamp(g, 0xff3b2e, 0, SH + cH + 2.2, (cz0 + cz1) / 2 + 0.4, windowMats, 0.1);   // (white over red: a pilot on duty)
  lamp(g, 0xff3b2e, -cW / 2, SH + cH, cz0 + 0.5, windowMats, 0.08); lamp(g, 0x3dff7a, cW / 2, SH + cH, cz0 + 0.5, windowMats, 0.08);
  g.userData.helm = [0, SH + 1.6, cz0 + 0.6];
  g.userData.top = SH + cH + 2.6;
  g.userData.wake = [wakeOf(B, L)]; g.add(g.userData.wake[0]);
  return g;
}
