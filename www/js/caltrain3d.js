// Caltrain's Stadler KISS (v1107, requested: "start with Caltrain", improving the trains against real photos): the
// seven-car double-deck electric trains in service since September 2024, modelled from Wikimedia Commons photos
// (a line-scan side view of set 321–322, and the cab head-on at Hayward Park). White cars with a red band along the
// top, a black upper-deck window band and lower-deck windows between each car's two pairs of doors, a thin red
// stripe over a grey skirt; at each end a cab with a red nose sweeping down from the roof, a black windscreen in a
// red surround, and headlights. Pantographs on two cars. The roof is red too: from above, a silver roof was lost on
// a grey city (v1105), so this one departs from the real train.
// makeCaltrain() → { group, length, cab }: nose to −z, centred, y = 0 at the rail; cab: the driver's eye, in metres.
// Each material's parts are merged into one mesh, so a whole train is a handful of draw calls.
import * as THREE from 'three';

const W = 3.0, BOT = 0.95, TOP = 4.6;   // car width, body bottom and roof (m above the rail)
const C = { white: 0xf3f3f1, red: 0xd7262e, glass: 0x15191d, skirt: 0x8d9398, bogie: 0x2a2d31, gear: 0x9aa1a6, lamp: 0xfff6dc };

export function makeCaltrain({ cars = 7, roofGlow = 0.12 } = {}) {
  const mats = {
    // (round 3: a little of their own light, so under the app's tone mapping (ACES at 0.55) the white stays white and
    // the red bright, as in the photos, not grey and maroon)
    white: new THREE.MeshLambertMaterial({ color: C.white, emissive: C.white, emissiveIntensity: 0.55 }),
    red: new THREE.MeshLambertMaterial({ color: C.red, emissive: C.red, emissiveIntensity: 0.55 }),
    sweep: new THREE.MeshLambertMaterial({ color: C.red, emissive: C.red, emissiveIntensity: 0.55, side: THREE.DoubleSide }),   // (the flat sweeps on her sides: seen from either face)
    roof: new THREE.MeshLambertMaterial({ color: C.red, emissive: C.red, emissiveIntensity: roofGlow }),   // (red from above: findable; less glow end-on)
    glass: new THREE.MeshLambertMaterial({ color: C.glass }),
    skirt: new THREE.MeshLambertMaterial({ color: C.skirt }),
    bogie: new THREE.MeshLambertMaterial({ color: C.bogie }),
    gear: new THREE.MeshLambertMaterial({ color: C.gear }),
    lamp: new THREE.MeshBasicMaterial({ color: C.lamp }),
    cap: new THREE.MeshLambertMaterial({ color: 0x3a3f44 }),
  };
  const parts = Object.fromEntries(Object.keys(mats).map(k => [k, []]));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s1 = new THREE.Vector3(1, 1, 1);
  const put = (mat, g, x, y, z, rx = 0, ry = 0, rz = 0) => { g.applyMatrix4(m4.compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), s1)); parts[mat].push(g); };
  const box = (mat, w, h, l, x, y, z, rx = 0) => put(mat, new THREE.BoxGeometry(w, h, l), x, y, z, rx);
  // a flat panel on both sides of the car, just proud of it: [z0, z1] along her, [y0, y1] up
  const sides = (mat, z0, z1, y0, y1, out = 0.012) => { for (const sx of [-1, 1]) box(mat, 0.02, y1 - y0, z1 - z0, sx * (W / 2 + out), (y0 + y1) / 2, (z0 + z1) / 2); };

  const LE = 27.4, LM = 26.2, GAP = 0.5;   // end (cab) cars and middle cars, and the gangway between
  const lens = Array.from({ length: cars }, (_, i) => i === 0 || i === cars - 1 ? LE : LM);
  const length = lens.reduce((a, b) => a + b, 0) + GAP * (cars - 1);
  const spans = [];   // (v1126) each car's front and back, for her cars to take her track's curves each on her own
  let z = -length / 2;   // the front of the first car (her nose is at −z)
  const NOSE = 2.6;      // the cab's sloped nose, in front of the body box
  lens.forEach((L, i) => {
    const front = i === 0, back = i === cars - 1, z0 = z + (front ? NOSE : 0), z1 = z + L - (back ? NOSE : 0), zc = (z0 + z1) / 2, BL = z1 - z0;
    // the body: white, a red band along the top, the red roof, a thin red stripe low down over a grey skirt
    box('white', W, 3.1 - BOT + 0.05 + (TOP - 0.5 - 3.1), BL, 0, (BOT + TOP - 0.5) / 2, zc);
    box('red', W + 0.004, 0.5, BL, 0, TOP - 0.25, zc);
    box('roof', W - 0.5, 0.06, BL - 0.4, 0, TOP + 0.03, zc);
    sides('skirt', z0, z1, BOT, 1.5); sides('red', z0, z1, 1.5, 1.64);
    // the car's plan, from her front end: end section (small square window), doors, the low middle (two decks of
    // windows), doors, end section. Fractions of the car from the line-scan photo.
    const at = f => z + f * L, d = 1.45;
    for (const f of [0.205, 0.795]) {   // two pairs of doors: white, two tall dark panes
      sides('glass', at(f) - d / 2 + 0.12, at(f) - 0.08, 1.75, 3.05); sides('glass', at(f) + 0.08, at(f) + d / 2 - 0.12, 1.75, 3.05);
      sides('skirt', at(f) - d / 2, at(f) + d / 2, 1.05, 1.12, 0.016);   // (the step)
    }
    for (const f of [0.1, 0.9]) if (!(front && f < 0.5) && !(back && f > 0.5)) sides('glass', at(f) - 0.32, at(f) + 0.32, 2.45, 3.05);
    sides('glass', at(0.27), at(0.73), 3.38, 4.08);   // the upper deck's window band
    for (let k = 0; k < 6; k++) { const a = at(0.29 + k * 0.074); sides('glass', a, a + 0.062 * L, 1.74, 2.46); }   // the lower deck's windows
    // under her: two bogies, and gear boxes along the roof; a pantograph on the second car and the second from last
    for (const f of [0.14, 0.86]) { box('bogie', 2.0, 0.55, 2.8, 0, 0.42, at(f)); }   // (mostly behind the skirt, as hers)
    box('skirt', 2.4, 0.3, BL * 0.45, 0, 0.95, zc);
    for (const f of [front ? 0.2 : 0.12, back ? 0.8 : 0.88]) box('gear', 1.6, 0.4, 2.6, 0, TOP + 0.2, at(f));   // (on a cab car, set back off the nose)
    if (i === 1 || i === cars - 2) {
      const pz = at(0.12);
      box('bogie', 1.7, 0.08, 0.5, 0, TOP + 1.25, pz);   // the pan head
      box('bogie', 0.06, 0.06, 1.25, 0, TOP + 0.85, pz - 0.35, -0.95);   // its arms
      box('bogie', 0.06, 0.06, 1.25, 0, TOP + 0.85, pz + 0.35, 0.95);
    }
    if (i < cars - 1) box('skirt', 2.3, 3.2, GAP + 0.2, 0, BOT + 1.7, z + L + GAP / 2);   // the gangway's bellows
    spans.push([z, z + L]); z += L + GAP;
  });
  // the cabs: a nose sloping down from the roof, at each end
  for (const [dir, zf] of [[-1, -length / 2], [1, length / 2]]) {
    const zb = zf - dir * NOSE;   // where the body box ends
    // the nose's side profile (along her, up), extruded across her
    const sh = new THREE.Shape([[0, BOT], [NOSE - 0.05, BOT], [NOSE, 1.75], [NOSE - 0.25, 3.0], [NOSE - 0.75, 3.95], [NOSE - 1.6, 4.45], [0, TOP]].map(([a, b]) => new THREE.Vector2(a, b)));
    const nose = new THREE.ExtrudeGeometry(sh, { depth: W, bevelEnabled: false });
    nose.translate(0, 0, -W / 2);
    // shape's x runs out to the nose: turn it to −z (front) or +z (back)
    put('white', nose, 0, 0, zb, 0, dir < 0 ? Math.PI / 2 : -Math.PI / 2);
    // the front (round 2, against the Hayward Park photo): white below the windscreen, with the Caltrain disc and
    // the headlights in black housings; the black windscreen filling the slope, red at its edges (the sides' red
    // wrapping round); a dark grey cap above it. Each piece lies on its stretch of the nose's slope.
    const onSlope = (mat, w, y0, y1, x0, x1, proud) => {   // a plate on the slope from (x0 back from the tip, y0) to (x1, y1)
      const a = Math.atan2(x1 - x0, y1 - y0), len = Math.hypot(x1 - x0, y1 - y0), ym = (y0 + y1) / 2, xm = (x0 + x1) / 2 - proud;
      put(mat, new THREE.BoxGeometry(w, len, 0.04), 0, ym, zf - dir * xm, -dir * a);
    };
    onSlope('red', W - 0.02, 2.05, 3.0, 0.06, 0.25, 0.015); onSlope('red', W - 0.12, 3.0, 3.95, 0.25, 0.75, 0.015);
    onSlope('glass', W - 0.6, 2.15, 3.0, 0.08, 0.25, 0.04); onSlope('glass', W - 0.7, 3.0, 3.88, 0.25, 0.71, 0.04);
    onSlope('cap', W - 0.4, 3.95, 4.45, 0.75, 1.6, 0.02);
    for (const sx of [-1, 1]) {
      box('glass', 0.62, 0.3, 0.05, sx * 0.92, 1.98, zf - dir * 0.0);   // the headlight housing
      box('lamp', 0.42, 0.14, 0.05, sx * 0.92, 1.98, zf - dir * -0.02);
      box('glass', 0.5, 0.36, 0.05, sx * 1.0, 1.22, zf - dir * -0.02);   // the grilles low down
    }
    const disc = new THREE.CylinderGeometry(0.2, 0.2, 0.03, 24); put('red', disc, 0, 1.98, zf - dir * -0.02, Math.PI / 2);   // the Caltrain disc
    box('bogie', 0.5, 0.32, 0.35, 0, 0.95, zf - dir * -0.12);   // the coupler
    // the nose's sides: red above the stripe, as the sweep down the body continues to the front
    for (const sx of [-1, 1]) {
      const ns = new THREE.ShapeGeometry(new THREE.Shape([[0, 1.64], [NOSE - 0.012, 1.64], [NOSE, 1.75], [NOSE - 0.25, 3.0], [NOSE - 0.75, 3.95], [NOSE - 1.6, 4.45], [0, TOP]].map(([a, b]) => new THREE.Vector2(a, b))));
      ns.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, dir), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)).premultiply(new THREE.Matrix4().makeTranslation(sx * (W / 2 + 0.014), 0, zb)));
      parts.sweep.push(ns);
    }
    // the red sweep down her side, from the roof well back to low at the nose; her side window in it
    for (const sx of [-1, 1]) {
      const sw = new THREE.ShapeGeometry(new THREE.Shape([[0, 1.64], [0, TOP - 0.5], [5.8, TOP - 0.5]].map(([a, b]) => new THREE.Vector2(a, b))));
      // shape x along her (back from the nose), y up; on the side at x = ±(W/2 + 0.014), facing out
      sw.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -dir), new THREE.Vector3(0, 1, 0), new THREE.Vector3(sx * -dir, 0, 0)).premultiply(new THREE.Matrix4().makeTranslation(sx * (W / 2 + 0.014), 0, zb)));
      parts.sweep.push(sw);
      box('glass', 0.02, 0.6, 1.0, sx * (W / 2 + 0.03), 3.15, zb - dir * 1.2);
    }
  }
  // each material's parts as one mesh
  const group = new THREE.Group();
  for (const [k, gs] of Object.entries(parts)) {
    if (!gs.length) continue;
    const flat = gs.map(g => (g.index ? g.toNonIndexed() : g));
    const n = flat.reduce((a, g) => a + g.attributes.position.count, 0), pos = new Float32Array(n * 3);
    let o = 0; for (const g of flat) { pos.set(g.attributes.position.array, o * 3); o += g.attributes.position.count; g.dispose(); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mats[k]); group.add(mesh);
  }
  // (the cab's eye: just ahead of her windscreen, as a camera there would see; inside the nose it looked at the nose's
  // own back wall, and through the glass from inside it would be black)
  return { group, length, spans, cab: [0, 3.25, -length / 2 - 0.25] };
}
