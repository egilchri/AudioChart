// SMART's Nippon Sharyo DMUs (v1118, requested: "recursively improve the look of the train"): the two- and three-car
// diesel multiple units Sonoma-Marin Area Rail Transit has run since 2017, modelled from Wikimedia Commons photos (set
// 102 at Sonoma County Airport, 108 in the Windsor yard, 113 at Larkspur, 114 at Petaluma). Brushed stainless cars with
// a near-black window band over a thin gold pinstripe, a green stripe low down and a green roof with dark grilles; at
// each end a cab whose green face carries the SMART badge, under a black windscreen in a black surround with an oval
// headlight at its top, round headlights and red tail lamps in black pockets either side, a silver bumper and coupler.
// makeSmart() → { group, length, cab }: nose to −z, centred, y = 0 at the rail; cab: the driver's eye, in metres.
// Each material's parts are merged into one mesh, so a whole train is a handful of draw calls.
import * as THREE from 'three';

const W = 3.1, BOT = 1.0, EAVE = 3.55, TOP = 4.15;   // car width, body bottom, where the roof's curve starts, roof top
const C = { steel: 0xbfc3c6, band: 0x30383a, screen: 0x3d4c58, frame: 0x8a9196, gold: 0xb48d3c, green: 0x1e8c5e, glass: 0x15191d, under: 0x34383b, bogie: 0x26292c, grille: 0x2c3a33, lamp: 0xfff6dc, tail: 0xc4161c, bumper: 0x9ea3a7 };

let BADGE = null;
function badgeTex() {   // "SONOMA-MARIN / SMART / AREA RAIL TRANSIT": cream plate, gold-brown letters, white speed lines
  if (BADGE) return BADGE;
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 192; const c = cv.getContext('2d');
  c.fillStyle = '#1e8c5e'; c.fillRect(0, 0, 512, 192);
  c.fillStyle = '#f4f1e6'; for (const s of [-1, 1]) for (let k = 0; k < 4; k++) c.fillRect(s < 0 ? 10 + k * 8 : 400 - k * 8, 78 + k * 12, 100, 5);
  c.fillStyle = '#f4f1e6'; c.fillRect(110, 58, 292, 84);
  c.fillStyle = '#c9822a'; c.font = 'bold 76px Helvetica, Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('SMART', 256, 102);
  c.fillStyle = '#f4f1e6'; c.font = 'bold 26px Helvetica, Arial, sans-serif'; c.fillText('SONOMA-MARIN', 256, 34); c.fillText('AREA RAIL TRANSIT', 256, 170);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return (BADGE = t);
}

export function makeSmart({ cars = 2, glow = 0.45 } = {}) {
  const L = (c, e = glow, extra = {}) => new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: e, ...extra });
  const mats = {
    // (as Caltrain's: a little of their own light, so under the app's ACES tone mapping at 0.55 the steel reads silver
    // and the green green, not grey and bottle)
    steel: L(C.steel, 0.4), band: L(C.band, 0), gold: L(C.gold, 0.4), green: L(C.green), greenS: L(C.green, glow, { side: THREE.DoubleSide }),
    glass: L(C.glass, 0), screen: L(C.screen, 0.15), frame: L(C.frame, 0.2), black: L(0x101314, 0), under: L(C.under, 0), bogie: L(C.bogie, 0), grille: L(C.grille, 0), bumper: L(C.bumper, 0.3),
    lamp: new THREE.MeshBasicMaterial({ color: C.lamp }), tail: new THREE.MeshBasicMaterial({ color: C.tail }),
  };
  const parts = Object.fromEntries(Object.keys(mats).map(k => [k, []]));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s1 = new THREE.Vector3(1, 1, 1);
  const put = (mat, g, x, y, z, rx = 0, ry = 0, rz = 0) => { g.applyMatrix4(m4.compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), s1)); parts[mat].push(g); };
  const box = (mat, w, h, l, x, y, z, rx = 0) => put(mat, new THREE.BoxGeometry(w, h, l), x, y, z, rx);
  const sides = (mat, z0, z1, y0, y1, out = 0.012) => { for (const sx of [-1, 1]) box(mat, 0.02, y1 - y0, z1 - z0, sx * (W / 2 + out), (y0 + y1) / 2, (z0 + z1) / 2); };
  // the roof: a rounded cap across her, from the eaves up, extruded along [z0, z1]
  const roofShape = new THREE.Shape(); const R = 0.45;
  roofShape.moveTo(-W / 2, EAVE); roofShape.lineTo(-W / 2, TOP - R); roofShape.quadraticCurveTo(-W / 2, TOP, -W / 2 + R, TOP);
  roofShape.lineTo(W / 2 - R, TOP); roofShape.quadraticCurveTo(W / 2, TOP, W / 2, TOP - R); roofShape.lineTo(W / 2, EAVE); roofShape.lineTo(-W / 2, EAVE);
  const roof = (z0, z1) => { const g = new THREE.ExtrudeGeometry(roofShape, { depth: z1 - z0, bevelEnabled: false, curveSegments: 4 }); put('green', g, 0, 0, z0); };

  const LC = 25.9, GAP = 0.6, NOSE = 2.0;   // a car (85 ft over couplers), the gangway between, the cab's sloped nose
  const length = cars * LC + GAP * (cars - 1);
  let z = -length / 2;
  for (let i = 0; i < cars; i++) {
    const front = i === 0, back = i === cars - 1, z0 = z + (front ? NOSE : 0), z1 = z + LC - (back ? NOSE : 0), zc = (z0 + z1) / 2, BL = z1 - z0;
    // the body: stainless, the black window band with its gold line under it, a green stripe at the sill; the roof
    box('steel', W, EAVE - BOT, BL, 0, (BOT + EAVE) / 2, zc);
    roof(z0, z1);
    sides('band', z0, z1, 1.95, 3.05); sides('gold', z0, z1, 1.86, 1.92); sides('green', z0, z1, BOT + 0.02, BOT + 0.16);
    // her plan from her cab end (her doors are toward the ends: a long window bay between); a middle car the same,
    // its ends both plain. f: fractions of the car, from her front (each car's own front: the cab car's is its cab)
    const flip = back && !front, at = f => flip ? z + (1 - f) * LC : z + f * LC, d = 1.6;
    const doors = [0.27, 0.84];
    for (const f of doors) {   // a pair of plug doors: stainless, each leaf with a tall narrow window
      const a = at(f);
      sides('steel', a - d / 2, a + d / 2, BOT + 0.15, 3.15, 0.03);
      for (const s of [-1, 1]) sides('glass', a + s * d / 4 - 0.16, a + s * d / 4 + 0.16, 1.95, 2.95, 0.045);
      sides('band', a - 0.02, a + 0.02, BOT + 0.2, 3.1, 0.05);   // (the leaves' meeting)
    }
    // windows in the band: square-cornered panes, darker than the band, with their frames' gap between
    const pane = (a, w) => { const p0 = Math.min(a, a + w), p1 = Math.max(a, a + w); sides('frame', p0 - 0.05, p1 + 0.05, 2.03, 2.97, 0.018); sides('glass', p0, p1, 2.08, 2.92, 0.024); };
    const dir = flip ? -1 : 1, step = 1.55, pw = 1.25;
    for (let k = 0; k < 8; k++) pane(at(0.27) + dir * (d / 2 + 0.55 + k * step), dir * pw);   // between the doors
    for (let k = 0; k < 2; k++) pane(at(0.84) + dir * (d / 2 + 0.45 + k * step), dir * pw);   // past the far door
    if (!(front || back)) for (let k = 0; k < 2; k++) pane(at(0.27) - dir * (d / 2 + 0.45 + k * step), -dir * pw);
    else pane(at(0.27) - dir * (d / 2 + 0.45), -dir * pw);   // (one between the cab and the first door)
    // under her: two bogies, equipment boxes between (her engine, tanks, radiators), all dark
    for (const f of [0.12, 0.88]) { box('bogie', 2.2, 0.75, 3.0, 0, 0.55, z + f * LC); for (const sx of [-1, 1]) for (const dz of [-1, 1]) put('bogie', new THREE.CylinderGeometry(0.42, 0.42, 0.12, 14), sx * 0.78, 0.42, z + f * LC + dz * 1.15, 0, 0, Math.PI / 2); }
    for (const [f0, f1] of [[0.22, 0.38], [0.42, 0.6], [0.64, 0.78]]) box('under', 2.6, 0.65, (f1 - f0) * LC, 0, BOT - 0.33, z + (f0 + f1) / 2 * LC);
    // on the roof: grilles (her radiators and air-conditioning), dark green-black, along the middle
    for (const f of [0.2, 0.5, 0.78]) box('grille', 1.9, 0.08, 2.4, 0, TOP + 0.03, z + f * LC);
    if (i < cars - 1) box('band', 2.4, 3.0, GAP + 0.2, 0, BOT + 1.6, z + LC + GAP / 2);   // the gangway's bellows
    z += LC + GAP;
  }
  // the cabs, at each end: a nose from the bumper up the face and the raked windscreen to the roof
  // profile, (x back from the tip, y up): bumper, green face, windscreen, black cap, roof
  const PRO = [[0.0, 0.62], [0.0, 1.2], [0.1, 1.25], [0.18, 2.05], [0.62, 3.1], [0.9, 3.75], [1.4, 4.08], [NOSE, TOP], [NOSE, 0.62]];
  for (const [dir, zf] of [[-1, -length / 2], [1, length / 2]]) {
    const zb = zf - dir * NOSE;
    const sh = new THREE.Shape(PRO.map(([a, b]) => new THREE.Vector2(NOSE - a, b)));
    const nose = new THREE.ExtrudeGeometry(sh, { depth: W, bevelEnabled: false }); nose.translate(0, 0, -W / 2);
    put('steel', nose, 0, 0, zb, 0, dir < 0 ? Math.PI / 2 : -Math.PI / 2);
    // pieces lying on the nose's slope: a plate from (x0 back from the tip, y0) to (x1, y1), w across, proud of it
    const onSlope = (mat, w, x0, y0, x1, y1, proud = 0.02, xs = 0) => {
      const a = Math.atan2(x1 - x0, y1 - y0), len = Math.hypot(x1 - x0, y1 - y0);
      put(mat, new THREE.BoxGeometry(w, len, 0.04), xs, (y0 + y1) / 2, zf - dir * ((x0 + x1) / 2 - proud), -dir * a);
    };
    onSlope('green', W - 0.02, 0.1, 1.25, 0.18, 2.05, 0.02);   // the green face
    // the black front (the windscreen's surround and the cap over it), framed in green: green either side and above
    onSlope('green', W - 0.02, 0.18, 2.05, 0.62, 3.1, 0.012); onSlope('green', W - 0.06, 0.62, 3.1, 0.9, 3.75, 0.012);
    onSlope('black', W - 0.42, 0.18, 2.05, 0.62, 3.1, 0.022);
    onSlope('black', W - 0.62, 0.62, 3.1, 0.9, 3.72, 0.022);
    onSlope('green', W - 0.02, 0.9, 3.75, 1.4, 4.08, 0.015);   // the roof's green coming down to it
    onSlope('green', W - 0.02, 1.4, 4.08, NOSE, TOP, 0.015);
    // the windscreen: a wide middle pane between two narrower ones
    onSlope('screen', 1.36, 0.22, 2.2, 0.57, 3.0, 0.035);
    for (const s of [-1, 1]) onSlope('screen', 0.52, 0.22, 2.22, 0.56, 2.98, 0.035, s * 1.0);
    // the oval headlight at the top
    { const g = new THREE.CylinderGeometry(0.2, 0.2, 0.04, 20); g.scale(1.6, 1, 1); onSlopePut(g, 'bumper', 0.76, 3.42, 0.05); const l = new THREE.CylinderGeometry(0.09, 0.09, 0.05, 14); for (const s of [-1, 1]) { const lc = l.clone(); onSlopePut(lc, 'lamp', 0.76, 3.42, 0.08, s * 0.13); } }
    function onSlopePut(g, mat, x, y, proud, xs = 0) {   // a disc lying flat on the cap's slope
      const a = Math.atan2(0.9 - 0.62, 3.75 - 3.1);
      put(mat, g, xs, y, zf - dir * (x - proud), -dir * a + Math.PI / 2 * -dir + (dir < 0 ? 0 : 0), 0, 0);
    }
    // the face's black pockets, a round headlight over a red tail lamp in each; the SMART badge between
    for (const s of [-1, 1]) {
      box('band', 0.5, 0.82, 0.04, s * 1.18, 1.62, zf - dir * 0.1);
      put('lamp', new THREE.CylinderGeometry(0.12, 0.12, 0.05, 16), s * 1.18, 1.82, zf - dir * 0.09, Math.PI / 2);
      put('tail', new THREE.CylinderGeometry(0.08, 0.08, 0.05, 14), s * 1.18, 1.42, zf - dir * 0.095, Math.PI / 2);
    }
    { const g = new THREE.PlaneGeometry(1.5, 0.56); const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: badgeTex(), emissive: 0xffffff, emissiveMap: badgeTex(), emissiveIntensity: 0.45 }));
      m.position.set(0, 1.65, zf - dir * 0.06); m.rotation.set(-dir * Math.atan2(0.08, 0.8), dir < 0 ? Math.PI : 0, 0); m.userData.badge = true; parts.__badges = (parts.__badges || []).concat(m); }
    // the bumper, the coupler, the equipment under the face
    box('bumper', W - 0.2, 0.42, 0.3, 0, 1.0, zf - dir * 0.1);
    box('bogie', 0.55, 0.4, 0.7, 0, 0.88, zf + dir * 0.25);
    box('under', W - 0.5, 0.45, 0.5, 0, 0.6, zf - dir * 0.3);
    // the nose's sides: steel, the green of the face wrapping round the corner low down, the band and the cab's side
    // window behind it
    for (const sx of [-1, 1]) {
      const prof = PRO.slice(0, 8).map(([a, b]) => [NOSE - a, b]); prof.push([0, 0.62]);
      const ns = new THREE.ShapeGeometry(new THREE.Shape(prof.map(([a, b]) => new THREE.Vector2(a, b))));
      ns.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, dir), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)).premultiply(new THREE.Matrix4().makeTranslation(sx * (W / 2 + 0.005), 0, zb)));
      parts.steel.push(ns);
      const gw = new THREE.ShapeGeometry(new THREE.Shape([[NOSE - 0.1, 1.25], [NOSE - 0.18, 2.05], [NOSE - 1.1, 1.7], [NOSE - 1.1, 1.25]].map(([a, b]) => new THREE.Vector2(a, b))));
      gw.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, dir), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)).premultiply(new THREE.Matrix4().makeTranslation(sx * (W / 2 + 0.012), 0, zb)));
      parts.greenS.push(gw);
      // the green A-pillar: a strip 0.4 m deep along the nose's slope, from the face up to the roof
      const edge = PRO.slice(3, 8), strip = [...edge.map(([a, b]) => [NOSE - a, b]), ...edge.slice().reverse().map(([a, b]) => [NOSE - a - 0.4, b])];
      const ap = new THREE.ShapeGeometry(new THREE.Shape(strip.map(([a, b]) => new THREE.Vector2(a, b))));
      ap.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, dir), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)).premultiply(new THREE.Matrix4().makeTranslation(sx * (W / 2 + 0.014), 0, zb)));
      parts.greenS.push(ap);
      box('glass', 0.02, 0.85, 0.75, sx * (W / 2 + 0.03), 2.55, zb - dir * 0.8);   // the cab's side window
      box('band', 0.02, 1.1, 1.4, sx * (W / 2 + 0.022), 2.5, zb - dir * 0.75);
    }
  }
  const group = new THREE.Group();
  for (const [k, gs] of Object.entries(parts)) {
    if (k === '__badges') { for (const m of gs) group.add(m); continue; }
    if (!gs.length) continue;
    const flat = gs.map(g => (g.index ? g.toNonIndexed() : g));
    const n = flat.reduce((a, g) => a + g.attributes.position.count, 0), pos = new Float32Array(n * 3);
    let o = 0; for (const g of flat) { pos.set(g.attributes.position.array, o * 3); o += g.attributes.position.count; g.dispose(); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, mats[k]));
  }
  return { group, length, cab: [0, 2.9, -length / 2 - 0.3] };
}
