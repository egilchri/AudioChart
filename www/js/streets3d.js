// A city's streets (v1193, asked riding an M5 bus: "recursively improve the various views of the bus. Like how the roads
// look"): each road in a building area (www/data/streets/<area>.json, design/streets/build_streets.py, from OpenStreetMap)
// laid on the ground: its roadway in asphalt, its sidewalks either side in concrete, and its markings: a two-way
// street's double yellow line down the middle, white lane lines (dashed, 10 ft on 30, as New York's) between lanes the
// same way, a white edge line on the big roads; all of them stopping short of the junctions, where the crosswalks are
// (a ladder of white bars across the roadway). Draped on the 10 m ground (hAt: its height, interpolated), a little above
// it, so the ground's own photo of the street shows nowhere. Part of the armchair layer (bay3d.js loadArmchair).
import * as THREE from 'three';

const SIDEWALK = 4.2, STEP = 7;   // a sidewalk's width (m); the most between heights along a road
let MATS = null;
function mats() {
  if (MATS) return MATS;
  const off = (m, k) => { m.polygonOffset = true; m.polygonOffsetFactor = -1 - k; m.polygonOffsetUnits = -2 - 2 * k; return m; };
  // the asphalt: a little noise in it (its patches and wear), repeating every 8 m
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c = cv.getContext('2d');
  c.fillStyle = '#4a4c4f'; c.fillRect(0, 0, 128, 128);
  let sd = 7; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 2600; k++) { const v = 58 + rnd() * 30 | 0; c.fillStyle = `rgba(${v},${v + 1},${v + 3},${0.25 + rnd() * 0.3})`; c.fillRect(rnd() * 128, rnd() * 128, 1 + rnd() * 2, 1 + rnd() * 2); }
  for (let k = 0; k < 7; k++) { c.fillStyle = `rgba(30,31,33,${0.15 + rnd() * 0.2})`; c.fillRect(rnd() * 128, rnd() * 128, 10 + rnd() * 40, 6 + rnd() * 20); }   // (patches)
  const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  MATS = {
    walk: off(new THREE.MeshLambertMaterial({ color: 0xb4b1aa }), 0),
    road: off(new THREE.MeshLambertMaterial({ map: tex }), 1),
    paint: off(new THREE.MeshLambertMaterial({ vertexColors: true }), 2),
    mall: off(new THREE.MeshLambertMaterial({ map: mallTexture() }), 1),
    curb: off(new THREE.MeshLambertMaterial({ color: 0xc4c1b8, side: THREE.DoubleSide }), 1),   // (v1199: granite)
  };
  return MATS;
}

// a planted mall's ground (v1196): grass, a darker clump of planting here and there, mulch round it; repeating every 8 m
function mallTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c = cv.getContext('2d');
  let sd = 13; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  c.fillStyle = '#4f6b34'; c.fillRect(0, 0, 128, 128);
  for (let k = 0; k < 3000; k++) { const g = 80 + rnd() * 50 | 0; c.fillStyle = `rgba(${g * 0.55 | 0},${g},${g * 0.4 | 0},0.5)`; c.fillRect(rnd() * 128, rnd() * 128, 1, 1 + rnd() * 2); }
  for (let k = 0; k < 9; k++) {   // shrubs in their beds of mulch
    const x = rnd() * 128, y = rnd() * 128, r = 6 + rnd() * 10;
    c.fillStyle = 'rgba(92,64,42,0.75)'; c.beginPath(); c.ellipse(x, y, r * 1.25, r * 1.1, 0, 0, 7); c.fill();
    for (let j = 0; j < 14; j++) { const g = 60 + rnd() * 40 | 0; c.fillStyle = `rgb(${g * 0.45 | 0},${g},${g * 0.35 | 0})`; c.beginPath(); c.arc(x + (rnd() - 0.5) * r * 1.4, y + (rnd() - 0.5) * r * 1.2, 2 + rnd() * r * 0.4, 0, 7); c.fill(); }
  }
  const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; return tex;
}
// a divided street's twins (v1196, asked: "make Broadway's center mall green"): OpenStreetMap draws Broadway above
// Columbus Circle, Park Avenue and the parkways as two one-way roadways; between them is their mall. A one-way road whose
// twin (her name, the other way) runs alongside on her left, 6 to 45 m off, for a good part of her length: → how far off
// (m, the twin's middle line; the mall's middle is half that), else 0
function twinGap(r, Q, N, byName) {
  const others = byName.get(r.n) || [], offs = []; let tried = 0;
  for (let i = 0; i < Q.length; i += 2) {
    tried++; const q = Q[i], n = N[i]; let best = null, bd = 45 * 45;
    for (const o of others) {
      if (o.r === r) continue;
      for (let k = 0; k < o.Q.length; k++) { const p = o.Q[k], d2 = (p.x - q.x) ** 2 + (p.z - q.z) ** 2; if (d2 < bd && o.N[k].dx * n.dx + o.N[k].dz * n.dz < -0.7) { bd = d2; best = p; } }
    }
    if (!best) continue;
    const off = (best.x - q.x) * n.nx + (best.z - q.z) * n.nz, along = Math.abs((best.x - q.x) * n.dx + (best.z - q.z) * n.dz);
    if (off < -6 && off > -45 && along < 12) offs.push(-off);
  }
  if (offs.length < Math.max(2, tried * 0.4)) return 0;
  offs.sort((a, b) => a - b); return offs[offs.length >> 1];
}
// a point s along Q, o off her (m, + right): { x, z, dx, dz (her way there), nx, nz (her right) }
function at(Q, N, s, o) {
  let i = 1; while (i < Q.length - 1 && Q[i].s < s) i++;
  const a = Q[i - 1], b = Q[i], t = Math.max(0, Math.min(1, (s - a.s) / ((b.s - a.s) || 1))), n = N[i - 1], L = Math.hypot(n.nx, n.nz) || 1;
  const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
  return { x: x + n.nx / L * o, z: z + n.nz / L * o, dx: n.dx, dz: n.dz, nx: n.nx / L, nz: n.nz / L };
}
// a mall's furniture (v1197, asked: "add trees and benches to the mall"): London planes (the Broadway malls' street
// trees: a grey-brown trunk, a broad crown, each a little different), and benches of wooden slats on dark iron ends
let FURN = null;
function furniture() {
  if (FURN) return FURN;
  const colGeo = (g, c) => { g = g.toNonIndexed(); const col = new Float32Array(g.attributes.position.count * 3); for (let k = 0; k < col.length; k += 3) col.set(c, k); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); return g; };
  const merge = list => { const n = list.reduce((a, g) => a + g.attributes.position.count, 0), pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3); let o = 0;
    for (const g of list) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3); o += g.attributes.position.count; g.dispose(); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); return geo; };
  const box = (w, h, d, x, y, z, c) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return colGeo(g, c); };
  const trunk = new THREE.CylinderGeometry(0.16, 0.24, 4.2, 7); trunk.translate(0, 2.1, 0);
  const crown = new THREE.IcosahedronGeometry(2.6, 1); crown.scale(1, 0.82, 1); crown.translate(0, 5.6, 0);
  const crown2 = new THREE.IcosahedronGeometry(1.8, 1); crown2.translate(1.2, 6.6, 0.6);
  const crown3 = new THREE.IcosahedronGeometry(1.7, 1); crown3.translate(-1.1, 6.3, -0.8);
  const WOOD = [0.47, 0.32, 0.2], IRON = [0.1, 0.12, 0.11];
  const bench = [box(1.9, 0.04, 0.12, 0, 0.45, -0.17, WOOD), box(1.9, 0.04, 0.12, 0, 0.45, -0.02, WOOD), box(1.9, 0.04, 0.12, 0, 0.45, 0.13, WOOD),   // the seat's slats
    box(1.9, 0.1, 0.04, 0, 0.66, -0.26, WOOD), box(1.9, 0.1, 0.04, 0, 0.83, -0.28, WOOD),   // the back's
    ...[-0.85, 0.85].flatMap(x => [box(0.06, 0.45, 0.06, x, 0.22, 0.14, IRON), box(0.06, 0.88, 0.06, x, 0.44, -0.24, IRON), box(0.06, 0.05, 0.42, x, 0.42, -0.04, IRON)])];
  // (v1199) a street light: New York's grey cobra-head on its tapered pole, 9 m up, its arm out over the roadway (+x)
  const GREY = [0.42, 0.44, 0.45], LAMP = [0.9, 0.88, 0.8];
  const pole = new THREE.CylinderGeometry(0.07, 0.12, 9, 6); pole.translate(0, 4.5, 0);
  const base = new THREE.CylinderGeometry(0.2, 0.24, 0.6, 6); base.translate(0, 0.3, 0);
  const arm = new THREE.BoxGeometry(2.4, 0.08, 0.08); arm.rotateZ(0.12); arm.translate(1.15, 9.05, 0);
  const head = new THREE.BoxGeometry(0.75, 0.16, 0.32); head.translate(2.45, 9.2, 0);
  const lens = new THREE.BoxGeometry(0.55, 0.02, 0.24); lens.translate(2.45, 9.11, 0);
  // a fire hydrant: red, its silver bonnet and nozzle caps, on its base flange
  const RED = [0.66, 0.1, 0.08], SILVER = [0.75, 0.76, 0.78];
  const hb = new THREE.CylinderGeometry(0.13, 0.15, 0.55, 8); hb.translate(0, 0.33, 0);
  const fl = new THREE.CylinderGeometry(0.2, 0.2, 0.06, 8); fl.translate(0, 0.03, 0);
  const bon = new THREE.CylinderGeometry(0.05, 0.14, 0.14, 8); bon.translate(0, 0.67, 0);
  const nut = new THREE.CylinderGeometry(0.03, 0.03, 0.06, 5); nut.translate(0, 0.77, 0);
  const noz = new THREE.CylinderGeometry(0.06, 0.06, 0.4, 6); noz.rotateZ(Math.PI / 2); noz.translate(0, 0.45, 0);
  const pump = new THREE.CylinderGeometry(0.08, 0.08, 0.14, 6); pump.rotateX(Math.PI / 2); pump.translate(0, 0.45, 0.16);
  // (v1200) a Muni-Meter, the city's parking pay station: a grey box on its post, a blue band across its top, its screen
  // and keypad to the sidewalk (−x: away from the roadway); and the city's litter basket, green wire mesh, open-topped
  const MGREY = [0.5, 0.52, 0.54], MBLUE = [0.13, 0.3, 0.62], DARK = [0.08, 0.09, 0.1];
  const mpost = new THREE.BoxGeometry(0.14, 0.7, 0.14); mpost.translate(0, 0.35, 0);
  const mbox = new THREE.BoxGeometry(0.3, 0.85, 0.32); mbox.translate(0, 1.12, 0);
  const mtop = new THREE.BoxGeometry(0.31, 0.14, 0.33); mtop.translate(0, 1.6, 0);
  const mscr = new THREE.BoxGeometry(0.02, 0.18, 0.2); mscr.translate(-0.16, 1.3, 0);
  const mkey = new THREE.BoxGeometry(0.02, 0.16, 0.14); mkey.translate(-0.16, 1.05, 0);
  const GREEN = [0.12, 0.3, 0.17];
  const bin = new THREE.CylinderGeometry(0.31, 0.25, 0.86, 10, 1, true); bin.translate(0, 0.43, 0);
  const binIn = new THREE.CylinderGeometry(0.29, 0.29, 0.02, 10); binIn.translate(0, 0.7, 0);
  const binRim = new THREE.TorusGeometry(0.31, 0.025, 4, 12); binRim.rotateX(Math.PI / 2); binRim.translate(0, 0.86, 0);
  const binFoot = new THREE.CylinderGeometry(0.25, 0.25, 0.04, 10); binFoot.translate(0, 0.02, 0);
  // (v1200) a bus shelter, New York's: a dark frame and flat roof, glass at the back and one end, the lit advertising panel
  // at the other, a bench along the back; open to the kerb (+x). Its glass a mesh of its own (see-through)
  const FRAME = [0.25, 0.27, 0.28], AD = [0.93, 0.92, 0.86];
  const sh = [];
  for (const [x, z] of [[-0.7, -1.85], [-0.7, 1.85], [0.55, -1.85], [0.55, 1.85]]) { const g = new THREE.BoxGeometry(0.07, 2.5, 0.07); g.translate(x, 1.25, z); sh.push(colGeo(g, FRAME)); }
  { const g = new THREE.BoxGeometry(1.7, 0.12, 4.0); g.translate(-0.05, 2.56, 0); sh.push(colGeo(g, FRAME)); }
  { const g = new THREE.BoxGeometry(1.2, 1.85, 0.14); g.translate(-0.08, 1.15, 1.85); sh.push(colGeo(g, AD)); }
  { const g = new THREE.BoxGeometry(1.26, 1.95, 0.1); g.translate(-0.08, 1.15, 1.85); sh.push(colGeo(g, FRAME)); }
  { const g = new THREE.BoxGeometry(0.36, 0.05, 2.4); g.translate(-0.48, 0.48, -0.2); sh.push(colGeo(g, [0.55, 0.57, 0.58])); }
  { const g = new THREE.BoxGeometry(0.05, 0.05, 2.4); g.translate(-0.62, 0.24, -0.2); sh.push(colGeo(g, FRAME)); }
  // its bus stop sign by the kerb: a pole, the blue sign
  { const g = new THREE.CylinderGeometry(0.04, 0.04, 2.9, 5); g.translate(1.05, 1.45, -2.4); sh.push(colGeo(g, FRAME)); }
  { const g = new THREE.BoxGeometry(0.03, 0.6, 0.45); g.translate(1.05, 2.6, -2.4); sh.push(colGeo(g, [0.12, 0.3, 0.65])); }
  const glass = [], gb = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); glass.push(colGeo(g, [0.75, 0.85, 0.9])); };
  gb(0.02, 2.2, 3.6, -0.7, 1.3, 0); gb(1.1, 2.2, 0.02, -0.12, 1.3, -1.85);
  // a newsstand: the city's green kiosk, its roof overhanging, its window and the magazines under it to the sidewalk (−x)
  const NG = [0.1, 0.28, 0.19], NG2 = [0.14, 0.36, 0.24];
  const nk = [];
  { const g = new THREE.BoxGeometry(1.6, 2.4, 2.6); g.translate(0, 1.2, 0); nk.push(colGeo(g, NG)); }
  { const g = new THREE.BoxGeometry(2.1, 0.12, 3.1); g.translate(-0.1, 2.5, 0); nk.push(colGeo(g, NG2)); }
  { const g = new THREE.BoxGeometry(0.03, 0.85, 1.8); g.translate(-0.81, 1.55, 0); nk.push(colGeo(g, [0.07, 0.08, 0.09])); }
  for (const [k, c] of [[0, [0.75, 0.2, 0.15]], [1, [0.9, 0.75, 0.2]], [2, [0.2, 0.4, 0.75]], [3, [0.85, 0.85, 0.82]]]) { const g = new THREE.BoxGeometry(0.06, 0.32, 0.5); g.translate(-0.84, 0.95, -0.8 + k * 0.53); nk.push(colGeo(g, c)); }
  { const g = new THREE.BoxGeometry(0.3, 0.06, 2.4); g.translate(-0.95, 1.1, 0); nk.push(colGeo(g, NG2)); }   // (the window's ledge)
  // (v1200) a subway entrance: its stair down (the treads darkening to the bottom, −z), the green iron railings round the
  // opening on three sides, the two lamp posts at the top (+z) with their globes (a mesh of their own: green, where you
  // can go in; red, out only), the black "Subway" panels on the railings by the top
  const RAIL = [0.1, 0.24, 0.15], st = [], post = (x, z, h) => { const g = new THREE.BoxGeometry(0.05, h, 0.05); g.translate(x, h / 2, z); st.push(colGeo(g, RAIL)); };
  for (let k = 0; k < 11; k++) { const g = new THREE.BoxGeometry(1.5, 0.02, 0.42), v = 0.44 * (k / 10) + 0.04; g.translate(0, 0.015, -2.1 + k * 0.42); st.push(colGeo(g, [v, v, v * 1.02])); }
  for (const sx of [-0.82, 0.82]) {
    for (const y of [0.5, 1.0]) { const g = new THREE.BoxGeometry(0.05, 0.05, 4.6); g.translate(sx, y, 0); st.push(colGeo(g, RAIL)); }
    for (let z = -2.3; z <= 2.31; z += 1.15) post(sx, z, 1.0);
    { const g = new THREE.BoxGeometry(0.03, 0.32, 1.1), w = new THREE.BoxGeometry(0.035, 0.03, 1.1); g.translate(sx * 1.02, 1.22, 1.5); w.translate(sx * 1.02, 1.33, 1.5); st.push(colGeo(g, [0.05, 0.05, 0.05]), colGeo(w, [0.92, 0.92, 0.9])); }
    post(sx, 2.3, 2.3);
  }
  for (const y of [0.5, 1.0]) { const g = new THREE.BoxGeometry(1.64, 0.05, 0.05); g.translate(0, y, -2.3); st.push(colGeo(g, RAIL)); }
  const globes = [-0.82, 0.82].map(sx => { const g = new THREE.SphereGeometry(0.17, 10, 8); g.translate(sx, 2.45, 2.3); return colGeo(g, [1, 1, 1]); });
  // a street elevator: a glass cab, its grey frame and roof, its doors to the sidewalk (−x)
  const el = [], elGlass = [];
  for (const [x, z] of [[-1.05, -1.05], [-1.05, 1.05], [1.05, -1.05], [1.05, 1.05]]) { const g = new THREE.BoxGeometry(0.1, 2.9, 0.1); g.translate(x, 1.45, z); el.push(colGeo(g, FRAME)); }
  { const g = new THREE.BoxGeometry(2.3, 0.2, 2.3); g.translate(0, 2.95, 0); el.push(colGeo(g, FRAME)); }
  { const g = new THREE.BoxGeometry(0.06, 2.2, 1.0); g.translate(-1.07, 1.1, 0); el.push(colGeo(g, [0.62, 0.64, 0.66])); }
  for (const [w, d, x, z] of [[0.02, 2.1, 1.05, 0], [2.1, 0.02, 0, -1.05], [2.1, 0.02, 0, 1.05]]) { const g = new THREE.BoxGeometry(w, 2.7, d); g.translate(x, 1.4, z); elGlass.push(colGeo(g, [0.75, 0.85, 0.9])); }
  FURN = {
    stair: merge(st), globe: merge(globes), elevator: merge(el), elGlass: merge(elGlass),
    globeMat: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    shelter: merge(sh), glass: merge(glass), newsstand: merge(nk),
    glassMat: new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.28, depthWrite: false }),
    meter: merge([colGeo(mpost, MGREY), colGeo(mbox, MGREY), colGeo(mtop, MBLUE), colGeo(mscr, DARK), colGeo(mkey, DARK)]),
    bin: merge([colGeo(bin, GREEN), colGeo(binIn, DARK), colGeo(binRim, GREEN), colGeo(binFoot, GREEN)]),
    light: merge([colGeo(pole, GREY), colGeo(base, GREY), colGeo(arm, GREY), colGeo(head, GREY), colGeo(lens, LAMP)]),
    hydrant: merge([colGeo(hb, RED), colGeo(fl, RED), colGeo(bon, SILVER), colGeo(nut, SILVER), colGeo(noz, SILVER), colGeo(pump, SILVER)]),
    trunk: colGeo(trunk, [0.45, 0.42, 0.36]), crown: merge([colGeo(crown, [1, 1, 1]), colGeo(crown2, [1, 1, 1]), colGeo(crown3, [1, 1, 1])]), bench: merge(bench),
    mat: new THREE.MeshLambertMaterial({ vertexColors: true }), leaf: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  };
  return FURN;
}
// (for the design harness, design/pending/street-look) one piece of the street's furniture, as the streets draw it
export function furnitureMesh(name, color = null) {
  const F = furniture(), mat = { glass: F.glassMat, elGlass: F.glassMat, globe: F.globeMat, crown: F.leaf }[name] || F.mat;
  const m = new THREE.Mesh(F[name], mat.clone()); if (color) { m.material.vertexColors = false; m.material.color.set(color); } return m;
}
// a polyline in metres, resampled so no two heights are more than STEP apart: [{x, z, s (along), j (a junction: the
// crossing street's width, m; 0 where none)}]
function resample(P, J) {
  const out = [];
  for (let i = 0; i < P.length; i++) {
    if (i) {
      const a = P[i - 1], b = P[i], L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(L / STEP);
      for (let k = 1; k < n; k++) { const t = k / n; out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, s: out.at(-1).s + L / n, j: false }); }
      out.push({ x: b.x, z: b.z, s: out.at(-1).s + L / n, j: J.get(i) ?? 0 });
    } else out.push({ x: P[0].x, z: P[0].z, s: 0, j: J.get(0) ?? 0 });
  }
  return out;
}
// the side direction (to the right going along) at each point, mitred at the bends, not too far at a sharp one
function sides(Q) {
  return Q.map((q, i) => {
    const a = Q[Math.max(0, i - 1)], b = Q[Math.min(Q.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    let k = 1;
    if (i > 0 && i < Q.length - 1) {
      const ux = q.x - a.x, uz = q.z - a.z, ul = Math.hypot(ux, uz) || 1;
      const cos = (ux / ul) * dx + (uz / ul) * dz; k = 1 / Math.max(0.5, cos);
    }
    return { nx: -dz * k, nz: dx * k, dx, dz };
  });
}

// → { group } (y up, the ground's own frame); data: the area's streets; hAt(lon, lat): the ground's height
export function makeStreets({ data, wx, wz, hAt, lonOf, latOf, furn = null }) {
  const M = mats(), lift = { walk: 0.45, road: 0.3, paint: 0.36, mall: 0.47 };   // (v1199: the sidewalks 15 cm over the roadway, on their kerbs)
  const trees = [], benches = [], lights = [], hydrants = [], meters = [], bins = [];
  const B = { walk: [[], [], []], road: [[], [], []], paint: [[], [], [], []], mall: [[], [], []], curb: [[], [], []] };   // positions, uvs or colours, indices
  const yAt = (x, z, up) => hAt(lonOf(x), latOf(z)) + up;
  // a strip along Q between offsets o0 and o1 (m, + right), from s0 to s1 along it
  // (up1: the o1 edge's own height: o0 = o1 and up1 above up is a wall, a kerb's face)
  function strip(buf, Q, N, o0, o1, s0, s1, up, colour = null, up1 = up) {
    const [pos, aux, idx] = buf, base = pos.length / 3; let n = 0;
    const pts = [];
    for (let i = 0; i < Q.length; i++) {
      const q = Q[i];
      if (q.s < s0 && !(Q[i + 1] && Q[i + 1].s > s0)) continue;
      if (q.s > s1 && !(Q[i - 1] && Q[i - 1].s < s1)) continue;
      // (clipped to s0..s1: the ends moved in along the segment)
      let x = q.x, z = q.z, s = q.s;
      if (s < s0) { const b = Q[i + 1], t = (s0 - s) / (b.s - s); x += (b.x - x) * t; z += (b.z - z) * t; s = s0; }
      if (s > s1) { const a = Q[i - 1], t = (s1 - a.s) / (s - a.s); x = a.x + (x - a.x) * t; z = a.z + (z - a.z) * t; s = s1; }
      pts.push({ x, z, s, n: N[i] });
    }
    if (pts.length < 2) return;
    for (const p of pts) for (const [o, u] of [[o0, up], [o1, up1]]) {
      const x = p.x + p.n.nx * o, z = p.z + p.n.nz * o;
      pos.push(x, yAt(x, z, u), z);
      if (colour) aux.push(...colour); else aux.push(o / 8, p.s / 8);
      n++;
    }
    // (facing up whichever way across it runs: o0 to o1 rightward turns the other winding)
    for (let k = 0; k + 1 < pts.length; k++) { const a = base + k * 2; if (o1 < o0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const WHITE = [0.86, 0.86, 0.82], YELLOW = [0.86, 0.66, 0.16], PAD = [0.55, 0.2, 0.15];   // (PAD: a kerb ramp's warning pad, brick red)
  const W = data.ways.filter(r => r.p.length >= 2).map(r => { const Q = resample(r.p.map(([lo, la]) => ({ x: wx(lo), z: wz(la) })), new Map(r.j || [])); return { r, Q, N: sides(Q) }; });
  // where each road's own points are, with the ways off them (her points' neighbours): a crossing street's side
  const ends = new Map();
  for (const { r, Q } of W) for (let i = 0; i < Q.length; i++) if (Q[i].j !== false) {   // (her own points, not resampled ones)
    const k = `${Q[i].x},${Q[i].z}`, list = ends.get(k) || ends.set(k, []).get(k);
    for (const b of [Q[i - 1], Q[i + 1]]) if (b) { const L = Math.hypot(b.x - Q[i].x, b.z - Q[i].z) || 1; list.push({ r, dx: (b.x - Q[i].x) / L, dz: (b.z - Q[i].z) / L }); }
  }
  const byName = new Map(); for (const w of W) if (w.r.o && w.r.n) (byName.get(w.r.n) || byName.set(w.r.n, []).get(w.r.n)).push(w);
  for (const { r, Q, N } of W) {
    const L = Q.at(-1).s;
    const hw = r.w / 2, big = r.c === 'mot' || r.c === 'tru', svc = r.c === 'ser';
    const gap = r.o && r.n && !big ? twinGap(r, Q, N, byName) : 0, mall = gap / 2 > hw + 1 ? gap / 2 : 0;   // (her half of the mall, on her left)
    // (her roadway's width is a guess from her lanes, wide for Broadway: by her mall it's kept to leave the mall 3 m a side)
    const hwL = mall ? Math.max(Math.min(hw, mall - 3), r.l * 1.6 + 0.5, 3) : hw;
    // where the crosswalks across her land (as drawn below: past each crossing street's kerb)
    const crossAt = big || svc || L < 12 ? [] : Q.filter(q => q.j).flatMap(q => [q.s - q.j / 2 - 2, q.s + q.j / 2 + 2]).filter(c => c >= 2 && c <= L - 2);
    // the sidewalks (v1199, asked: "add real curbs to the sidewalks"): 15 cm up on their kerbs, a granite face down to the
    // roadway and its granite top along the edge; each side stopping at the kerb line of a street crossing from that side
    // (the far side of a T runs on), the crossing street's own sidewalks taking the corner
    if (!big && !svc) for (const sd of [-1, 1]) {
      const o0 = sd < 0 ? -hwL : hw, o1 = sd < 0 && mall ? -mall : sd * (hw + SIDEWALK), cuts = [];
      for (const q of Q) if (q.j) { const out = ends.get(`${q.x},${q.z}`) || [], n = N[Q.indexOf(q)];
        if (out.some(o => o.r !== r && (o.dx * n.nx + o.dz * n.nz) * sd > 0.3)) cuts.push([q.s - q.j / 2, q.s + q.j / 2]); }
      // (v1199, asked: "add curb cuts at the crosswalks") where a crosswalk lands, a ramp down to the roadway, 1.5 m deep and
      // as wide as the crosswalk, its red warning pad at the foot, its sides walled; the kerb broken for it
      const RL = Math.min(1.5, Math.abs(o1 - o0) - 0.4), o0r = o0 + sd * RL, ramps = RL > 0.6 ? crossAt : [];
      let s = 0; for (const [c0, c1] of [...cuts.sort((a, b) => a[0] - b[0]), [L, L]]) {
        if (c0 - s > 0.5) {
          const here = ramps.filter(c => c - 1.6 > s && c + 1.6 < c0);
          strip(B.walk, Q, N, here.length ? o0r : o0, o1, s, c0, lift.walk);
          let t = s;
          for (const c of [...here, Infinity]) {
            const e = Math.min(c - 1.6, c0);
            if (e - t > 0.2) { if (here.length) strip(B.walk, Q, N, o0, o0r, t, e, lift.walk); strip(B.curb, Q, N, o0, o0, t, e, lift.road - 0.05, null, lift.walk); strip(B.curb, Q, N, o0, o0 + sd * 0.18, t, e, lift.walk + 0.004); }
            if (c === Infinity) break;
            strip(B.walk, Q, N, o0, o0r, c - 1.6, c + 1.6, lift.road + 0.01, null, lift.walk);   // the ramp
            strip(B.paint, Q, N, o0 + sd * 0.05, o0 + sd * 0.65, c - 1.5, c + 1.5, lift.road + 0.025, PAD, lift.road + 0.025 + (lift.walk - lift.road) * 0.65 / RL);   // its warning pad
            for (const e2 of [c - 1.6, c + 1.6]) {   // its sides: the sidewalk's edge down to the ramp
              const a = at(Q, N, e2, o0), b = at(Q, N, e2, o0r), [pos, aux, idx] = B.curb, k = pos.length / 3;
              pos.push(a.x, yAt(a.x, a.z, lift.road), a.z, a.x, yAt(a.x, a.z, lift.walk), a.z, b.x, yAt(b.x, b.z, lift.walk), b.z); aux.push(0, 0, 0, 0, 0, 0); idx.push(k, k + 1, k + 2);
            }
            t = c + 1.6;
          }
          // (v1199, asked: "add fire hydrants and street lights to the sidewalks") along this run of sidewalk, kept off the
          // ramps: street lights about every 32 m, the two sides staggered; a hydrant near the corner, past the ramp
          if (!(sd < 0 && mall)) {
            const clear = x => !here.some(c => Math.abs(x - c) < 2.6) && x > s + 1 && x < c0 - 1, edge = o0 + sd * 0.55;
            for (let x = s + (sd > 0 ? 9 : 25); x < c0 - 4; x += 32) if (clear(x)) lights.push({ ...at(Q, N, x, edge), sd, s: x, side: sd, r });
            if (c0 - s > 18) { const x = [s + 4.5, s + 5.5, s + 7].find(clear); if (x != null && (sd > 0 || r.o !== 1)) hydrants.push({ ...at(Q, N, x, o0 + sd * 0.7), sd }); }
            // (v1200, asked: "add parking meters and trash cans to the sidewalks") a Muni-Meter mid-block (two on a long
            // block), off the lights; a litter basket at the block's far corner, by the crosswalk
            const off = x => clear(x) && !lights.some(l => Math.abs(l.s - x) < 2 && l.side === sd && l.r === r);
            if (c0 - s > 30) for (const f of c0 - s > 70 ? [0.33, 0.67] : [0.5]) { const x = [0, 2.5, -2.5, 5].map(d => s + (c0 - s) * f + d).find(off); if (x != null) meters.push({ ...at(Q, N, x, o0 + sd * 0.55), sd }); }
            if (c0 < L - 1 && c0 - s > 12) { const x = [c0 - 4.4, c0 - 5.4].find(clear); if (x != null) bins.push({ ...at(Q, N, x, o0 + sd * 0.75), sd }); }
          }
        }
        s = Math.max(s, c1);
      }
    }
    strip(B.road, Q, N, -hwL, hw, 0, L, lift.road);
    if (svc || L < 12) continue;
    // the markings, in the runs between junctions, each kept back from the junction past the crossing street's kerb and
    // its crosswalk
    const js = Q.filter(q => q.j).map(q => ({ s: q.s, keep: q.j / 2 + 4.2 }));
    const runs = []; let a = { s: 0, keep: Q[0].j ? Q[0].j / 2 + 4.2 : 0 };
    for (const b of [...js.filter(j => j.s > 0), { s: L, keep: Q.at(-1).j ? Q.at(-1).j / 2 + 4.2 : 0 }]) {
      if (b.s === L && js.at(-1)?.s === L) b.keep = js.at(-1).keep;
      const s0 = a.s + a.keep, s1 = b.s - b.keep; if (s1 - s0 > 4) runs.push([s0, s1]); a = b;
      if (b.s >= L) break;
    }
    // the mall: planted, its stone kerb round it (the concrete under it showing), ending short of each crossing street
    // (v1197: each block's mall paved at its ends, a bench there facing in; its trees down the middle of her half)
    if (mall) for (const [s0, s1] of runs) if (s1 - s0 > 6) {
      const end = s1 - s0 > 22 ? 4.5 : 1.5;
      strip(B.mall, Q, N, -hwL - 0.6, -mall, s0 + end, s1 - end, lift.mall);
      const half = mall - hwL - 0.6, oT = -(hwL + 0.6 + half / 2);
      if (half >= 1.5) for (let t = s0 + end + 3; t < s1 - end - 2; t += 8.5) trees.push(at(Q, N, t + ((t * 7.3) % 1.6) - 0.8, oT));
      if (end > 2) for (const t of [s0 + 2.6, s1 - 2.6]) benches.push(at(Q, N, t, -hwL - 1.3));
    }
    const travel = Math.min(r.w - 1, r.l * 3.2), lanes = r.l;
    for (const [s0, s1] of runs) {
      if (!r.o && lanes >= 2) for (const o of [-0.12, 0.12]) strip(B.paint, Q, N, o - 0.06, o + 0.06, s0, s1, lift.paint, YELLOW);   // the double yellow
      // white lane lines between lanes going the same way: dashed
      const per = r.o ? lanes : Math.floor(lanes / 2), lw = travel / lanes;
      for (const sd of r.o ? [0] : [-1, 1]) for (let k = 1; k < per; k++) {
        const o = r.o ? -travel / 2 + k * lw : sd * k * lw;
        for (let s = s0 + 1; s + 3 < s1; s += 12.2) strip(B.paint, Q, N, o - 0.06, o + 0.06, s, s + 3, lift.paint, WHITE);
      }
      if (big) for (const sd of [-1, 1]) strip(B.paint, Q, N, sd * (hw - 0.4) - 0.07, sd * (hw - 0.4) + 0.07, s0, s1, lift.paint, WHITE);
    }
    // the crosswalks: a ladder of bars across the roadway, 3 m deep, at each junction (not on the expressways)
    if (!big) for (const { s, keep } of js) for (const at of [s - keep + 2.2, s + keep - 2.2]) {
      if (at < 2 || at > L - 2) continue;
      for (let o = -hw + 0.6; o + 0.5 < hw - 0.4; o += 1.2) strip(B.paint, Q, N, o, o + 0.55, at - 1.5, at + 1.5, lift.paint, WHITE);
    }
  }
  const group = new THREE.Group(); group.name = 'streets';
  const mesh = (buf, mat, colours) => {
    const [pos, aux, idx] = buf; if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute(colours ? 'color' : 'uv', new THREE.Float32BufferAttribute(aux, colours ? 3 : 2));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true; group.add(m);
  };
  mesh(B.walk, M.walk); mesh(B.road, M.road); mesh(B.paint, M.paint, true); mesh(B.mall, M.mall); mesh(B.curb, M.curb);
  // the mall's trees and benches: instanced, on the ground there
  if (trees.length || benches.length) {
    const F = furniture(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    let sd = 17; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    if (trees.length) {
      const tr = new THREE.InstancedMesh(F.trunk, F.mat, trees.length), cr = new THREE.InstancedMesh(F.crown, F.leaf, trees.length);
      trees.forEach((t, i) => {
        const k = 0.8 + rnd() * 0.45; q.setFromAxisAngle(Y, rnd() * 6.3); m4.compose(p.set(t.x, yAt(t.x, t.z, lift.mall - 0.05), t.z), q, sc.set(k, k * (0.9 + rnd() * 0.25), k));
        tr.setMatrixAt(i, m4); cr.setMatrixAt(i, m4); cr.setColorAt(i, c.setRGB(0.2 + rnd() * 0.08, 0.33 + rnd() * 0.1, 0.13 + rnd() * 0.05));
      });
      tr.castShadow = cr.castShadow = true; group.add(tr, cr);
    }
    if (benches.length) {
      const bn = new THREE.InstancedMesh(F.bench, F.mat, benches.length);
      // (her length along the street; facing in, to the mall's middle: on her left, so her back's to the roadway)
      benches.forEach((b, i) => { q.setFromAxisAngle(Y, Math.atan2(-b.dz, b.dx) + Math.PI); bn.setMatrixAt(i, m4.compose(p.set(b.x, yAt(b.x, b.z, lift.walk - 0.02), b.z), q, sc.set(1, 1, 1))); });
      bn.castShadow = true; group.add(bn);
    }
  }
  // (v1200, asked: "add newsstands and bus stop shelters to the sidewalks") the city's own: each on the sidewalk of the
  // street the city lists it on (its name matched, else the nearest), the shelter open to the kerb, the newsstand's window
  // to the sidewalk; the lights, meters, hydrants and baskets moved out of their way
  const shelters = [], stands = [];
  const stairs = [], lifts = [];
  if (furn && (furn.shelters.length || furn.newsstands.length || furn.subway?.length)) {
    const norm = t => ` ${String(t || '').toUpperCase()} `.replace(/[^A-Z0-9 ]/g, ' ').replace(/ (\d+)(ST|ND|RD|TH) /g, ' $1 ')
      .replace(/ STREET /g, ' ST ').replace(/ AVENUE | AVE /g, ' AV ').replace(/ BOULEVARD /g, ' BLVD ').replace(/ PLACE /g, ' PL ').replace(/ ROAD /g, ' RD ').replace(/ PARKWAY /g, ' PKWY ').replace(/ DRIVE /g, ' DR ')
      .replace(/ WEST /g, ' W ').replace(/ EAST /g, ' E ').replace(/ NORTH /g, ' N ').replace(/ SOUTH /g, ' S ').replace(/\s+/g, '');
    const G = new Map(), CELL = 25;
    for (const w of W) { if (w.r.c === 'mot' || w.r.c === 'tru' || w.r.c === 'ser') continue; w.nm = norm(w.r.n); w.Q.forEach((q, i) => { const k = `${Math.floor(q.x / CELL)},${Math.floor(q.z / CELL)}`; (G.get(k) || G.set(k, []).get(k)).push([w, i]); }); }
    const place = ([lo, la, st], list, depth) => {
      const x = wx(lo), z = wz(la), cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), want = norm(st);
      let best = null, bd = Infinity;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [w, k] of G.get(`${cx + i},${cz + j}`) || []) {
        const q = w.Q[k], d = Math.hypot(q.x - x, q.z - z) - (want && w.nm === want ? 30 : 0);   // (her own street, if it's near)
        if (d < bd) { bd = d; best = [w, k]; }
      }
      if (!best || bd > 25) return;
      const [w, k] = best, q = w.Q[k], n = w.N[k], L = Math.hypot(n.nx, n.nz) || 1;
      const along = (x - q.x) * n.dx + (z - q.z) * n.dz, off = ((x - q.x) * n.nx + (z - q.z) * n.nz) / L;
      const sd = off < 0 ? -1 : 1, hw = w.r.w / 2, s = Math.max(2, Math.min(w.Q.at(-1).s - 2, q.s + along));
      const o = { ...at(w.Q, w.N, s, sd * (hw + depth)), sd }; list.push(o); return o;
    };
    for (const f of furn.shelters) place(f, shelters, 1.55);
    for (const f of furn.newsstands) place(f, stands, 1.75);
    // (v1200, asked: "add subway entrances to the sidewalks") each stair and street elevator the MTA lists, on the
    // nearest street's sidewalk; a stair along it, its top toward one end or the other (by where it is)
    for (const [lo, la, kind, inOk] of furn.subway || []) {
      const o = place([lo, la, ''], kind ? lifts : stairs, kind ? 2.0 : 2.2); if (!o) continue;
      o.inOk = inOk; o.flip = kind ? 0 : ((lo * 1e5 | 0) + (la * 1e5 | 0)) & 1;
    }
    const away = o => ![...shelters, ...stands].some(b => Math.hypot(b.x - o.x, b.z - o.z) < 3.2) && ![...stairs, ...lifts].some(b => Math.hypot(b.x - o.x, b.z - o.z) < 3.6);
    for (const list of [lights, hydrants, meters, bins]) { const keep = list.filter(away); list.length = 0; list.push(...keep); }
  }
  // the street lights and hydrants (v1199): instanced, on the sidewalk; a light's arm out over her roadway
  if (shelters.length || stands.length || stairs.length || lifts.length) {
    const F = furniture(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), Y = new THREE.Vector3(0, 1, 0), GREEN = new THREE.Color(0.25, 1, 0.35), RED = new THREE.Color(1, 0.18, 0.12);
    for (const [list, geo, mat] of [[shelters, F.shelter, F.mat], [shelters, F.glass, F.glassMat], [stands, F.newsstand, F.mat], [stairs, F.stair, F.mat], [stairs, F.globe, F.globeMat], [lifts, F.elevator, F.mat], [lifts, F.elGlass, F.glassMat]]) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((o, i) => {
        q.setFromAxisAngle(Y, Math.atan2(o.sd * o.nz, -o.sd * o.nx) + (o.flip ? Math.PI : 0));   // (a stair's top one way or the other along the street)
        im.setMatrixAt(i, m4.compose(p.set(o.x, yAt(o.x, o.z, lift.walk - 0.01), o.z), q, one));
        if (geo === F.globe) im.setColorAt(i, o.inOk ? GREEN : RED);
      });
      im.castShadow = mat === F.mat; group.add(im);
    }
  }
  if (lights.length || hydrants.length || meters.length || bins.length) {
    const F = furniture(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), Y = new THREE.Vector3(0, 1, 0);
    for (const [list, geo] of [[lights, F.light], [hydrants, F.hydrant], [meters, F.meter], [bins, F.bin]]) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, F.mat, list.length);
      list.forEach((o, i) => { q.setFromAxisAngle(Y, Math.atan2(o.sd * o.nz, -o.sd * o.nx)); im.setMatrixAt(i, m4.compose(p.set(o.x, yAt(o.x, o.z, lift.walk - 0.01), o.z), q, one)); });
      im.castShadow = geo === F.light; group.add(im);
    }
  }
  group.userData.credit = data.credit;
  return { group };
}
