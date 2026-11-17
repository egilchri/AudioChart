// The road's vehicles (v1149, reported: "the trucks on the highway just look like rectangular boxes"): sedans, SUVs,
// box trucks, and tractor-trailers (a tractor in her owner's colour, a long white or silver trailer), each with
// wheels, glass, a roof, head and tail lamps that light at night. One instanced mesh per kind, so thousands cost a
// few draws: near the eye (within NEAR m) the models, farther the old boxes of their size (a car is a few pixels
// from there). Used by the freeways' traffic (traffic3d.js) and the big bridges' (bridges3d.js), SF's and Boston's.
// Each model's origin is on the road under her middle, her nose toward +z.
import * as THREE from 'three';

const NEAR = 700;
const GLASS = 0x1e252c, TYRE = 0x1a1a1a, DARK = 0x2a2b2d, CHROME = 0xb8bcc0;
const HEAD = [1.0, 0.92, 0.75], TAIL = [1.0, 0.08, 0.04];
export const CAR_COLS = [0xf2f2f0, 0xf2f2f0, 0x1c1c1e, 0x1c1c1e, 0x9a9da3, 0x9a9da3, 0x5d6168, 0xb3262b, 0x24427a, 0x6f8fae, 0x2e5a3c, 0xd8c9a8];
export const CAB_COLS = [0xb3262b, 0xf2f2f0, 0xf2f2f0, 0x24427a, 0x1c1c1e, 0x2e5a3c, 0xc9ccd0, 0xd89a1c, 0x5b6f86, 0x7a1e22];
export const TRAILER_COLS = [0xf0f0ec, 0xf0f0ec, 0xf0f0ec, 0xe6e7e8, 0xc4c8cc, 0xc4c8cc, 0x8d969e, 0x3d5a8a];
export const BOX_COLS = [0xf2f2f0, 0xf2f2f0, 0xf2f2f0, 0xe8d24a, 0xd8d8d4];

// a model's parts merged: each part's colour (white takes the instance's colour; the rest are fixed, darkened by it
// only a little as they're dark already) and its lamp's glow
function model(build) {
  const pos = [], nor = [], col = [], lamp = [], idx = []; const c = new THREE.Color();
  const add = (g, hex, lp, f) => {
    if (f) f(g); const P = g.attributes.position, N = g.attributes.normal, I = g.index, o = pos.length / 3;
    c.set(hex);
    for (let i = 0; i < P.count; i++) { pos.push(P.getX(i), P.getY(i), P.getZ(i)); nor.push(N.getX(i), N.getY(i), N.getZ(i)); col.push(c.r, c.g, c.b); lamp.push(...(lp || [0, 0, 0])); }
    if (I) for (let i = 0; i < I.count; i++) idx.push(o + I.getX(i)); else for (let i = 0; i < P.count; i++) idx.push(o + i);
    g.dispose();
  };
  // a box from its size and middle; taper: its top shrunk to that share (a car's greenhouse)
  const box = (w, h, l, x, y, z, hex = 0xffffff, lp, taper = 1, taperL = taper) => add(new THREE.BoxGeometry(w, h, l), hex, lp, g => {
    const P = g.attributes.position;
    if (taper !== 1 || taperL !== 1) for (let i = 0; i < P.count; i++) if (P.getY(i) > 0) { P.setX(i, P.getX(i) * taper); P.setZ(i, P.getZ(i) * taperL); }
    g.computeVertexNormals(); g.translate(x, y, z);
  });
  const wheel = (r, w, x, y, z) => add(new THREE.CylinderGeometry(r, r, w, 9), TYRE, null, g => { g.rotateZ(Math.PI / 2); g.translate(x, y, z); });
  const cyl = (r, h, x, y, z, hex, along) => add(new THREE.CylinderGeometry(r, r, h, 8), hex, null, g => { if (along) g.rotateX(Math.PI / 2); g.translate(x, y, z); });
  build({ box, wheel, cyl });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('lamp', new THREE.Float32BufferAttribute(lamp, 3)); g.setIndex(idx);
  return g;
}
const lamps = (box, w, y, z, rear) => { for (const s of [-1, 1]) box(rear ? 0.32 : 0.34, rear ? 0.16 : 0.13, 0.05, s * w, y, z, rear ? 0x8a1410 : 0xeeeee6, rear ? TAIL : HEAD); };

const MODELS = {
  sedan: () => model(({ box, wheel }) => {
    box(1.82, 0.62, 4.6, 0, 0.64, 0);
    box(1.62, 0.5, 2.5, 0, 1.2, -0.25, GLASS, null, 0.82, 0.74);
    box(1.3, 0.05, 1.75, 0, 1.47, -0.3);
    box(1.84, 0.14, 4.62, 0, 0.36, 0, DARK);   // the sills and bumpers
    for (const x of [-0.8, 0.8]) for (const z of [-1.42, 1.42]) wheel(0.33, 0.24, x, 0.33, z);
    lamps(box, 0.62, 0.78, 2.31); lamps(box, 0.66, 0.82, -2.31, true);
  }),
  suv: () => model(({ box, wheel }) => {
    box(1.95, 0.86, 4.85, 0, 0.86, 0);
    box(1.8, 0.62, 3.05, 0, 1.6, -0.4, GLASS, null, 0.9, 0.86);
    box(1.6, 0.06, 2.65, 0, 1.92, -0.45);
    box(1.97, 0.18, 4.87, 0, 0.52, 0, DARK);
    for (const x of [-0.86, 0.86]) for (const z of [-1.5, 1.5]) wheel(0.38, 0.27, x, 0.38, z);
    lamps(box, 0.66, 1.05, 2.43); lamps(box, 0.72, 1.12, -2.43, true);
  }),
  box: () => model(({ box, wheel }) => {   // a box truck: her cab, her box (white, with the instance's tint), 8 m
    box(2.25, 1.55, 1.9, 0, 1.45, 3.0);
    box(2.1, 0.75, 0.06, 0, 2.05, 3.96, GLASS); for (const s of [-1, 1]) box(0.06, 0.6, 0.9, s * 1.13, 2.05, 3.3, GLASS);
    box(2.45, 2.6, 5.9, 0, 2.35, -0.95, 0xf4f4f2);
    box(2.47, 0.12, 5.92, 0, 1.08, -0.95, 0x8a8c8e);
    box(1.0, 0.45, 7.2, 0, 0.7, 0.2, DARK);
    for (const x of [-0.98, 0.98]) { wheel(0.46, 0.3, x, 0.46, 3.0); wheel(0.46, 0.5, x, 0.46, -2.4); }
    lamps(box, 0.85, 1.0, 3.97); lamps(box, 1.05, 1.2, -3.91, true);
  }),
  tractor: () => model(({ box, wheel, cyl }) => {   // a tractor, her nose at +z, 6.6 m: the trailer's kingpin over her back axles
    box(2.25, 1.35, 1.9, 0, 1.55, 2.25, 0xffffff, null, 0.92, 0.9);   // the hood
    box(2.45, 2.3, 2.1, 0, 2.15, 0.25);   // the cab
    box(2.45, 2.6, 1.5, 0, 2.3, -1.5);   // the sleeper
    box(2.4, 0.65, 3.4, 0, 3.6, -0.6, 0xffffff, null, 0.96, 0.75);   // the roof's fairing, up to the trailer's top
    box(2.2, 0.85, 0.06, 0, 2.75, 1.32, GLASS); for (const s of [-1, 1]) box(0.06, 0.7, 1.1, s * 1.235, 2.7, 0.55, GLASS);
    box(1.15, 1.0, 0.05, 0, 1.6, 3.21, CHROME);   // the grille
    box(2.5, 0.42, 0.35, 0, 0.62, 3.15, CHROME);   // the bumper
    box(1.0, 0.36, 6.4, 0, 0.82, -0.2, DARK);   // the frame
    for (const s of [-1, 1]) { cyl(0.32, 1.1, s * 0.95, 0.85, -0.3, CHROME, true); cyl(0.08, 1.9, s * 1.13, 3.7, -1.15, CHROME); }   // her fuel tanks, along her, and her stacks
    for (const x of [-1.0, 1.0]) { wheel(0.52, 0.3, x, 0.52, 2.2); wheel(0.52, 0.55, x, 0.52, -2.0); wheel(0.52, 0.55, x, 0.52, -3.3); }
    lamps(box, 0.95, 1.05, 3.23);
  }),
  trailer: () => model(({ box, wheel }) => {   // a 53 ft trailer, its front over the tractor's back axles; origin at its middle
    box(2.6, 2.75, 16.1, 0, 2.65, 0);
    box(2.62, 0.16, 16.12, 0, 1.33, 0, 0x8a8c8e);   // its bottom rail
    box(2.62, 0.08, 16.12, 0, 4.0, 0, 0xb0b2b4);
    box(0.05, 2.5, 0.04, 0, 2.65, -8.07, DARK);   // its doors' seam
    box(1.1, 0.35, 15, 0, 1.08, 0, DARK);
    for (const s of [-1, 1]) box(0.12, 0.9, 0.12, s * 0.95, 0.75, 5.2, DARK);   // the landing gear
    for (const x of [-1.0, 1.0]) for (const z of [-5.8, -7.05]) wheel(0.52, 0.55, x, 0.52, z);
    box(2.4, 0.2, 0.1, 0, 0.75, -8.1, DARK);
    lamps(box, 1.05, 1.15, -8.08, true);
  }),
};
// the far boxes' sizes, and where a tractor-trailer's two are along her
const SIZE = { sedan: [1.85, 1.45, 4.7], suv: [1.95, 1.9, 4.9], box: [2.45, 3.6, 8], tractor: [2.45, 3.9, 6.6], trailer: [2.6, 4.0, 16.1] };
export const LEN = { sedan: 4.7, suv: 4.9, box: 8, semi: 22 };
const TRACTOR_AT = 7.3, TRAILER_AT = -3.45;   // (her middle to theirs: the tractor's nose 10.6 m ahead, the trailer's front a metre behind her sleeper)

export function makeFleet({ max = 9000, eye }) {
  const night = { value: 0 }, group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.3, vertexColors: true });
  mat.onBeforeCompile = sh => {
    sh.uniforms.uNight = night;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 lamp;\nvarying vec3 vLamp;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLamp = lamp;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec3 vLamp;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vLamp * uNight * 6.0 + diffuseColor.rgb * uNight * 0.12;');
  };
  mat.customProgramCacheKey = () => 'vehLamp';
  const farMat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.4 });
  const mk = (geo, m, n) => { const im = new THREE.InstancedMesh(geo, m, n); im.count = 0; im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.setColorAt(0, new THREE.Color(1, 1, 1)); group.add(im); return im; };
  const nearN = Math.min(max, 2500);
  const near = {}, slots = {};
  for (const k of Object.keys(MODELS)) { near[k] = mk(MODELS[k](), mat, nearN); slots[k] = new Int32Array(nearN).fill(-1); }
  const far = mk(new THREE.BoxGeometry(1, 1, 1), farMat, max), farSlot = new Int32Array(max).fill(-1);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), P = new THREE.Vector3(), S = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1), _c = new THREE.Color();
  let nf = 0; const nn = {};
  function one(k, x, y, z, yaw, col, d) {
    if (d < NEAR && nn[k] < nearN) {
      const im = near[k], i = nn[k]++;
      im.setMatrixAt(i, M.compose(P.set(x, y, z), Q.setFromAxisAngle(UP, yaw), ONE));
      if (slots[k][i] !== col) { slots[k][i] = col; im.setColorAt(i, _c.set(col)); im.instanceColor.needsUpdate = true; }
    } else if (nf < max) {
      const [w, h, l] = SIZE[k], i = nf++;
      far.setMatrixAt(i, M.compose(P.set(x, y + h / 2, z), Q.setFromAxisAngle(UP, yaw), S.set(w, h, l)));
      if (farSlot[i] !== col) { farSlot[i] = col; far.setColorAt(i, _c.set(col)); far.instanceColor.needsUpdate = true; }
    }
  }
  return {
    group,
    begin() { nf = 0; for (const k in near) nn[k] = 0; },
    // a vehicle of kind (sedan, suv, box or semi) on the road at (x, y, z), heading yaw (radians; 0 toward +z),
    // her colour (a semi: col her tractor's, col2 her trailer's)
    put(kind, x, y, z, yaw, col, col2) {
      const d = eye ? Math.hypot(x - eye.x, y - eye.y, z - eye.z) : 0;
      if (kind !== 'semi') { one(kind, x, y, z, yaw, col, d); return; }
      const sx = Math.sin(yaw), cz = Math.cos(yaw);
      one('tractor', x + sx * TRACTOR_AT, y, z + cz * TRACTOR_AT, yaw, col, d);
      one('trailer', x + sx * TRAILER_AT, y, z + cz * TRAILER_AT, yaw, col2 ?? 0xf0f0ec, d);
    },
    end() {
      far.count = nf; far.instanceMatrix.needsUpdate = true;
      for (const k in near) { near[k].count = nn[k]; near[k].instanceMatrix.needsUpdate = true; }
    },
    set visible(v) { group.visible = v; },
    night(k) { night.value = k; farMat.emissive.setRGB(0.55 * k, 0.45 * k, 0.3 * k); },
  };
}
// what a vehicle is, picked by chance: a truck (in a freeway's slow lane, mostly) a tractor-trailer or a box truck; a car a sedan or an SUV
export function pickVehicle(truck) {
  const r = Math.random(), pick = a => a[Math.random() * a.length | 0];
  if (truck) return r < 0.72 ? { kind: 'semi', col: pick(CAB_COLS), col2: pick(TRAILER_COLS) } : { kind: 'box', col: pick(BOX_COLS) };
  return r < 0.55 ? { kind: 'sedan', col: pick(CAR_COLS) } : { kind: 'suv', col: pick(CAR_COLS) };
}
