// Angelique (v906, requested: "make the Angelique look better up close from the wheel. Like, WAY
// better."): Camden's gaff topsail ketch, built 1980 of steel, 95 ft on deck, 130 ft overall with her
// bowsprit, ~24 ft beam, 11 ft draft; glossy green hull, tanbark-brown (red ocher) canvas. The fleet's
// low-poly type in sailboat3d.js stands in for her from the air; this is the boat you stand on.
//
// Built along -z (bow), y up from the waterline, x to starboard, real metres; the same interface as
// sailboat3d.js's makeSailboat (group, trim, wake), plus steer() to turn the wheel. Everything that
// doesn't move is merged into one mesh per material, so the detail costs little to draw.
//
// From the wheel, forward: the spoked wheel on its box and the binnacle; the after doghouse with its
// companion doors; benches along the bulwarks; the mizzen with mast hoops and a fife rail of belaying
// pins and hanging coils, its boom overhead; the main deckhouse with windows, skylight and stovepipe;
// the mainmast's shrouds on deadeyes with ratlines, the pin rails; the main hatch, windlass, anchors
// at the catheads and the bowsprit with its netting, bobstay and whiskers. Gaff mainsail and mizzen
// with a topsail over each, staysail and jib; furled on the booms when she isn't sailing.
import * as THREE from 'three';

const V3 = THREE.Vector3;

// ── Materials ────────────────────────────────────────────────────────────────
const DS = THREE.DoubleSide;
const phong = (color, shininess = 30, specular = 0x222222, extra = {}) => new THREE.MeshPhongMaterial({ color, shininess, specular, side: DS, ...extra });
const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, side: DS, ...extra });
function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
let rs = 12345; const rnd = () => (rs = (rs * 16807) % 2147483647) / 2147483647;
const MATS = {};
function materials(P) {
  if (MATS[P.id]) return MATS[P.id];
  // deck: Douglas fir planks running fore and aft, black seams, staggered butts; one tile = 8 planks × 4 m
  const deck = canvasTex(256, 512, (x, w, h) => {
    for (let k = 0; k < 8; k++) {
      const pw = w / 8;
      for (let seg = -1; seg < 3; seg++) {
        const y0 = (seg + (k % 4) / 4) * h / 2, v = 0.85 + 0.25 * rnd();
        x.fillStyle = `rgb(${Math.round(196 * v)},${Math.round(168 * v)},${Math.round(124 * v)})`;
        x.fillRect(k * pw, y0, pw, h / 2);
        x.strokeStyle = `rgba(110,80,50,${0.08 + 0.1 * rnd()})`; x.lineWidth = 1;
        for (let g = 0; g < 5; g++) { const gx = k * pw + 3 + rnd() * (pw - 6); x.beginPath(); x.moveTo(gx, y0); x.bezierCurveTo(gx + 2, y0 + h / 6, gx - 2, y0 + h / 3, gx + 1, y0 + h / 2); x.stroke(); }
        x.fillStyle = 'rgba(40,30,22,0.9)'; x.fillRect(k * pw, y0, pw, 2);   // butt joint
      }
      x.fillStyle = 'rgba(28,22,18,0.95)'; x.fillRect(k * pw, 0, 3, h);       // seam
    }
  });
  // canvas sails, tanbark brown (reported: "brown topsails"): vertical cloths, a bolt rope, three rows of reef points
  const sail = canvasTex(256, 512, (x, w, h) => {
    x.fillStyle = P.sail; x.fillRect(0, 0, w, h);
    for (let k = 0; k < 14; k++) { x.fillStyle = `rgba(${k % 2 ? 40 : 120},${k % 2 ? 12 : 50},${k % 2 ? 10 : 40},0.10)`; x.fillRect(k * w / 14, 0, w / 14, h); }
    x.fillStyle = 'rgba(40,12,10,0.45)'; for (let k = 1; k < 14; k++) x.fillRect(Math.round(k * w / 14), 0, 1, h);
    x.fillStyle = 'rgba(30,10,8,0.6)'; x.fillRect(0, 0, 4, h); x.fillRect(w - 5, 0, 5, h); x.fillRect(0, h - 5, w, 5);
    x.fillStyle = 'rgba(232,220,190,0.85)';
    for (const fr of [0.1, 0.17, 0.24]) { const y = h * (1 - fr); x.fillStyle = 'rgba(40,12,10,0.35)'; x.fillRect(0, y - 1, w, 2); x.fillStyle = 'rgba(232,220,190,0.9)'; for (let px = 10; px < w - 6; px += 14) x.fillRect(px, y - 5, 2, 10); }
  }, false);
  const net = canvasTex(64, 64, (x, w, h) => { x.clearRect(0, 0, w, h); x.strokeStyle = 'rgba(225,215,190,1)'; x.lineWidth = 3; for (let k = 0; k <= 64; k += 32) { x.beginPath(); x.moveTo(k, 0); x.lineTo(k - 64, 64); x.moveTo(k, 0); x.lineTo(k + 64, 64); x.stroke(); } });
  const grating = canvasTex(64, 64, (x, w, h) => { x.fillStyle = '#2a1d12'; x.fillRect(0, 0, w, h); x.fillStyle = '#a77b47'; for (let k = 0; k < 4; k++) { x.fillRect(k * 16 + 3, 0, 9, h); x.fillRect(0, k * 16 + 3, w, 9); } });
  const name = (big, small, color, back) => canvasTex(1024, 256, (x, w, h) => {
    if (back) { x.fillStyle = back; x.fillRect(0, 0, w, h); x.strokeStyle = color; x.lineWidth = 8; x.strokeRect(10, 10, w - 20, h - 20); }
    x.fillStyle = color; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `bold ${small ? 120 : 150}px Georgia, 'Times New Roman', serif`; x.fillText(big, w / 2, small ? h * 0.38 : h / 2);
    if (small) { x.font = 'bold 64px Georgia, serif'; x.fillText(small, w / 2, h * 0.8); }
  }, false);
  const ring = canvasTex(512, 64, (x, w, h) => {
    for (let k = 0; k < 8; k++) { x.fillStyle = k % 2 ? '#f2efe8' : '#d8452e'; x.fillRect(k * w / 8, 0, w / 8, h); }
    x.fillStyle = '#1b2a3a'; x.font = 'bold 40px Helvetica, Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(P.name, w * 0.125 + w / 16, h / 2); x.fillText(P.port, w * 0.625 + w / 16, h / 2);
  }, false);
  const card = canvasTex(128, 128, (x, w, h) => {
    x.fillStyle = '#f3ecd8'; x.beginPath(); x.arc(64, 64, 62, 0, 7); x.fill();
    x.strokeStyle = '#222'; x.lineWidth = 1; for (let k = 0; k < 32; k++) { const a = k * Math.PI / 16; x.beginPath(); x.moveTo(64 + Math.sin(a) * (k % 4 ? 52 : 40), 64 - Math.cos(a) * (k % 4 ? 52 : 40)); x.lineTo(64 + Math.sin(a) * 60, 64 - Math.cos(a) * 60); x.stroke(); }
    x.fillStyle = '#9b2a20'; x.beginPath(); x.moveTo(64, 10); x.lineTo(56, 64); x.lineTo(72, 64); x.fill();
    x.fillStyle = '#222'; x.font = 'bold 16px Georgia'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('N', 64, 30); x.fillText('S', 64, 100); x.fillText('E', 98, 64); x.fillText('W', 30, 64);
  }, false);
  const nameTex = name(P.name, P.port + ', ME', P.nameCol, null);
  const M = {
    hull: phong(P.hull, 90, P.hullSpec), bottom: lambert(0x7a2a22), gold: phong(P.stripe, 60, 0x664422), boot: phong(0x16191a, 60, 0x333333),
    white: phong(0xefeae0, 20, 0x222222), buff: lambert(0xe0d4b4), varnish: phong(0xa86f36, 55, 0x553311), darkwood: phong(0x5e3a1c, 40, 0x332211),
    spar: phong(0xc08a4c, 45, 0x443322), deck: lambert(0xffffff, { map: deck }), iron: phong(0x1e2022, 40, 0x333333), brass: phong(0xc9a04a, 90, 0x997733),
    glass: phong(0x1d2c35, 120, 0x8899aa), rope: lambert(0xcdb88e), tar: lambert(0x2c2925), red: phong(0xb3241c, 40), green: phong(0x1e8a3a, 40),
    sail: new THREE.MeshLambertMaterial({ color: 0xffffff, map: sail, emissive: P.sailGlow, side: DS }),
    furl: lambert(P.furl), net: new THREE.MeshLambertMaterial({ color: 0xffffff, map: net, transparent: true, alphaTest: 0.4, side: DS }),
    grating: lambert(0xffffff, { map: grating }), card: lambert(0xffffff, { map: card }),
    name: new THREE.MeshLambertMaterial({ map: nameTex, emissiveMap: nameTex, emissive: 0x8a6a30, transparent: true, side: DS, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    board: new THREE.MeshLambertMaterial({ map: name(P.name, null, P.nameCol, P.boardBack), side: DS }),
    ring: phong(0xffffff, 30, 0x222222, { map: ring }),
    window: phong(0x1d2c35, 120, 0x8899aa, { emissive: 0x000000 }),
  };
  return (MATS[P.id] = M);
}

// ── Geometry helpers: parts are collected per material and merged ───────────
function loft(nz, nx, f, uvf) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= nz; i++) for (let j = 0; j <= nx; j++) { const a = i / nz, b = j / nx; pos.push(...f(a, b)); uv.push(...(uvf ? uvf(a, b) : [b, a])); }
  for (let i = 0; i < nz; i++) for (let j = 0; j < nx; j++) { const a = i * (nx + 1) + j, b = a + 1, c = a + nx + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new V3(1, 1, 1);
function at(g, x, y, z, rx = 0, ry = 0, rz = 0) { _m.compose(new V3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s); return g.applyMatrix4(_m); }
const boxG = (w, h, d, x, y, z, rx, ry, rz) => at(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
const cylG = (r0, r1, h, seg, x, y, z, rx, ry, rz) => at(new THREE.CylinderGeometry(r0, r1, h, seg), x, y, z, rx, ry, rz);
const torG = (R, r, x, y, z, rx, ry, rz, rs2 = 6, ts = 20) => at(new THREE.TorusGeometry(R, r, rs2, ts), x, y, z, rx, ry, rz);
const _up = new V3(0, 1, 0);
function rodG(a, b, r, seg = 4) {   // a cylinder from point a to point b
  const d = new V3().subVectors(b, a), len = d.length(), g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
  g.applyQuaternion(_q.setFromUnitVectors(_up, d.normalize())); g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}
function sagLine(a, b, sag, r, n = 8) {   // a rope hanging between a and b
  const out = [];
  for (let k = 0; k < n; k++) {
    const p = t => a.clone().lerp(b, t).add(new V3(0, -sag * 4 * t * (1 - t), 0));
    out.push(rodG(p(k / n), p((k + 1) / n), r, 3));
  }
  return out;
}
function mergeG(geos) {
  let n = 0; const parts = geos.map(g => { const ng = g.index ? g.toNonIndexed() : g; if (!ng.attributes.normal) ng.computeVertexNormals(); n += ng.attributes.position.count; return ng; });
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2); let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); m.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return m;
}
function collector() {
  const P = {};
  const add = (k, ...gs) => { (P[k] ||= []).push(...gs.flat()); };
  add.build = (parent, M) => { for (const k in P) parent.add(new THREE.Mesh(mergeG(P[k]), M[k])); };
  return add;
}

// a lofted sail with a belly: luff(u), leech(u) points, belly(u) the leeward unit vector
function sailGeo(luff, leech, belly, depth = 0.09, nu = 14, nv = 10) {
  const pos = [], idx = [], uv = [];
  for (let i = 0; i <= nu; i++) {
    const u = i / nu, a = luff(u), b = leech(u), w = belly(u), chord = a.distanceTo(b);
    for (let j = 0; j <= nv; j++) {
      const v = j / nv, p = a.clone().lerp(b, v).addScaledVector(w, chord * depth * Math.sin(Math.PI * Math.pow(v, 0.8)));
      pos.push(p.x, p.y, p.z); uv.push(v, u);
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const k = i * (nv + 1) + j; idx.push(k, k + nv + 1, k + 1, k + 1, k + nv + 1, k + nv + 2); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function jibGeo(tack, head, R, clewY, deg, side) {   // side +1: clew to port
  const a = deg * Math.PI / 180, clew = new V3(-side * Math.sin(a) * R, clewY, tack.z + Math.cos(a) * R);
  return sailGeo(u => tack.clone().lerp(head, u), u => clew.clone().lerp(head, u),
    u => { const c = clew.clone().lerp(head, u).sub(tack.clone().lerp(head, u)); return new V3(c.z, 0, -c.x).multiplyScalar(side).setY(0).normalize(); }, 0.1);
}

// ── A vessel from its spec: her lines, where things are (C, for the views), and make() ──
function vessel(P) {
// ── Lines ────────────────────────────────────────────────────────────────────
// u: 0 at the stem head, 1 at the taffrail; v: 0 at the sheer, 1 at the waterline
const { L, HB, BH, BT, DRAFT, OVB, OVS, CAMBER } = P;
const zD = u => -L / 2 + u * L, uZ = z => (z + L / 2) / L;
const hw = u => u < 0.5 ? HB * (0.07 + 0.93 * Math.pow(Math.sin(Math.PI / 2 * u / 0.5), 0.85)) : HB * (1 - 0.36 * Math.pow((u - 0.5) / 0.5, 2.2));
const sh = u => u < 0.55 ? P.fb + P.shF * Math.pow((0.55 - u) / 0.55, 1.8) : P.fb + P.shA * Math.pow((u - 0.55) / 0.45, 2);
const zW = u => -L / 2 + OVB + u * (L - OVB - OVS);
const side = (s, u, v, out = 0) => { const f = Math.pow(v, 1.5); return [s * hw(u) * (1 - 0.06 * f) * (1 + out), sh(u) * (1 - v), zD(u) + (zW(u) - zD(u)) * f]; };
const under = (s, u, v) => [s * hw(u) * 0.94 * (1 - (0.55 + 0.25 * u) * Math.pow(v, 1.2)), -DRAFT * v, zW(u) + (u < 0.12 ? 2.2 * v * (1 - u / 0.12) : 0)];
const hwIn = u => Math.max(0.02, hw(u) - BT);
const deckY = (u, x) => sh(u) + CAMBER * (1 - Math.min(1, (x / hw(u)) ** 2));
const deckAt = (z, x = 0) => deckY(uZ(z), x);

// where things are (also what helm3d.js needs to put you, the anchor and the lights aboard)
// MAIN is the forward mast (Angelique's main, a schooner's fore), MIZ the after one (her mizzen, a schooner's main)
const Z_MAIN = P.masts[0].z, Z_MIZ = P.masts[1].z, Z_WHEEL = P.zWheel;
const D_MAIN = deckAt(Z_MAIN), D_MIZ = deckAt(Z_MIZ), D_WHEEL = deckAt(Z_WHEEL);
const MAIN = { ...P.masts[0], d: D_MAIN };
const MIZ = { ...P.masts[1], d: D_MIZ };
const SPRIT = P.sprit && (() => { const a = 10 * Math.PI / 180, z0 = zD(0) + 0.3, y0 = sh(0) + 0.35, len = P.sprit; return { z0, y0, a, len, z1: z0 - len * Math.cos(a), y1: y0 + len * Math.sin(a) }; })();
const STEM_HEAD = new V3(0, sh(0) + 0.45, zD(0) + 0.2);
const helmEye = [0, D_WHEEL + 1.72, Z_WHEEL + 1.15];   // a step abaft the wheel, so it sits low in the view
const C = {
  L, kn: P.kn,
  helm: helmEye,                                          // standing at the wheel
  roller: [0, sh(0.03) + 0.2, zD(0.03) - 0.2],            // the anchor goes from the stem head
  atMast: [0.3, deckAt(P.zAtMast) + 1.7, P.zAtMast],              // the walk forward to watch it go
  lights: {                                               // sidelight boards in the main shrouds, stern light, anchor light
    port: [-(hw(uZ(Z_MAIN)) + 0.25), sh(uZ(Z_MAIN)) + BH + 1.6, Z_MAIN + 0.5],
    stbd: [hw(uZ(Z_MAIN)) + 0.25, sh(uZ(Z_MAIN)) + BH + 1.6, Z_MAIN + 0.5],
    stern: [0, sh(1) + BH + 0.25, L / 2 + 0.25],
    anchor: P.anchorLight,
  },
  rail: [hw(uZ(Z_WHEEL + 1.15)) - 0.55, D_WHEEL + 1.72, Z_WHEEL + 1.15],   // at the rail abreast the wheel, where you'd stand with the binoculars
  droneBack: P.droneBack,
  // the lookout's eye in the ice barrel at the foremast head (Bowdoin's crow's nest, v919)
  crowsNest: P.iceBarrel ? [0, D_MAIN + MAIN.head + 1.25, Z_MAIN] : null,
};

// ── The boat ─────────────────────────────────────────────────────────────────
function make() {
  const M = materials(P), add = collector(), K = P.layout;
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);

  // hull: glossy green topsides, gold cove stripe, black boot-top, red bottom, a full keel
  for (const s of [-1, 1]) {
    add('hull', loft(60, 8, (u, v) => side(s, u, v)));
    add('bottom', loft(40, 6, (u, v) => under(s, u, v)));
    add('gold', loft(60, 1, (u, a) => side(s, u, (0.16 + 0.05 * a) / sh(u), 0.004)));
    add('boot', loft(60, 1, (u, a) => side(s, u, 1 - (0.18 * (1 - a)) / sh(u), 0.004)));
  }
  add('hull', loft(8, 6, (v, a) => { const p = side(-1, 0, v), q = side(1, 0, v); return [p[0] + (q[0] - p[0]) * a, p[1], p[2] - 0.12 * Math.sin(Math.PI * a)]; }));   // the stem's face
  add('bottom', loft(6, 4, (v, a) => { const p = under(-1, 0, v), q = under(1, 0, v); return [p[0] + (q[0] - p[0]) * a, p[1], p[2] - 0.1 * Math.sin(Math.PI * a)]; }));
  add('bottom', boxG(0.4, 0.9, 20 * L / 29, 0, -DRAFT - 0.1, 0.5));                                                                 // keel
  add('bottom', boxG(0.22, 2.6, 1.5, 0, -1.6, zW(1) - 0.9));                                                              // rudder
  // transom: raked, with a little round to it, her name and hailing port in gold leaf
  const trBul = 0.3, trPt = (a, v, out = 0) => { const p = side(-1, 1, v), q = side(1, 1, v); return [p[0] + (q[0] - p[0]) * a, p[1], p[2] + trBul * Math.sin(Math.PI * a) * (1 - 0.6 * v) + out]; };
  add('hull', loft(8, 12, (v, a) => trPt(a, v)));
  add('bottom', loft(4, 8, (v, a) => { const p = under(-1, 1, v), q = under(1, 1, v); return [p[0] + (q[0] - p[0]) * a, p[1], p[2]]; }));
  add('name', loft(1, 12, (v, a) => trPt(0.18 + 0.64 * a, 0.08 + 0.34 * v, 0.03), (v, a) => [a, 1 - v]));
  for (const s of [-1, 1]) add('board', loft(6, 1, (u, t) => { const uu = 0.05 + 0.1 * u; return [s * (hw(uu) + 0.02), sh(uu) + 0.15 + 0.5 * t, zD(uu)]; }, (u, t) => [s < 0 ? u : 1 - u, t]));   // quarterboards at the bow

  // deck: planked fir inside the bulwarks, cambered
  add('deck', loft(80, 12, (u, j) => { const x = (j * 2 - 1) * hwIn(u); return [x, deckY(u, x), zD(u)]; }, (u, j) => { const x = (j * 2 - 1) * hwIn(u); return [x / 1.12, zD(u) / 4]; }));
  // bulwarks: green outside, white inside, a varnished cap rail; white stanchions inside
  const capY = u => sh(u) + BH + 0.05;
  for (const s of [-1, 1]) {
    add('hull', loft(60, 2, (u, t) => [s * hw(u) * (1 - 0.012 * t), sh(u) + t * BH, zD(u)]));
    add('white', loft(60, 2, (u, t) => { const x = s * hwIn(u) * (1 - 0.012 * t), y0 = deckY(u, hwIn(u)); return [x, y0 + t * (sh(u) + BH - y0), zD(u)]; }));
    add('varnish', loft(60, 3, (u, j) => {
      const k = Math.round(j * 3), xi = hwIn(u) - 0.05, xo = hw(u) + 0.05, y = capY(u);
      return [[s * xi, y - 0.07, zD(u)], [s * xi, y, zD(u)], [s * xo, y, zD(u)], [s * xo, y - 0.07, zD(u)]][k];
    }));
    for (let u = 0.04; u < 0.98; u += 0.035) add('white', boxG(0.07, BH - 0.05, 0.1, s * (hwIn(u) - 0.035), (deckY(u, hwIn(u)) + sh(u) + BH) / 2, zD(u), 0, s * Math.atan2(hw(u + 0.01) - hw(u - 0.01), 0.58), 0));
  }
  // taffrail across the transom, and the knightheads closing the bulwarks at the stem
  {
    const tz = a => zD(1) + trBul * Math.sin(Math.PI * a), y0 = sh(1);
    add('hull', loft(2, 12, (t, a) => [(-hw(1) + 2 * hw(1) * a), y0 + t * BH, tz(a)]));
    add('white', loft(2, 12, (t, a) => [(-hwIn(1) + 2 * hwIn(1) * a), deckY(1, 0) - 0.1 + t * (y0 + BH - deckY(1, 0) + 0.1), tz(a) - BT]));
    add('varnish', loft(3, 12, (j, a) => { const k = Math.round(j * 3), x = -hw(1) + 2 * hw(1) * a, y = capY(1); return [[x, y - 0.07, tz(a) - BT - 0.05], [x, y, tz(a) - BT - 0.05], [x, y, tz(a) + 0.05], [x, y - 0.07, tz(a) + 0.05]][k]; }));
    add('hull', boxG(hw(0) * 2 + 0.04, BH + 0.4, 0.35, 0, sh(0) + BH / 2 - 0.15, zD(0) + 0.05));
    add('varnish', boxG(hw(0) * 2 + 0.14, 0.08, 0.5, 0, capY(0) - 0.03, zD(0) + 0.1));
  }

  // ── the wheel, its box and the binnacle ──
  const wheel = new THREE.Group(); wheel.position.set(0, D_WHEEL + 0.84, Z_WHEEL + 0.36); body.add(wheel);
  {
    const W = collector();
    W('brass', cylG(0.1, 0.1, 0.24, 16, 0, 0, 0, Math.PI / 2));
    W('brass', cylG(0.06, 0.06, 0.05, 12, 0, 0, 0.14, Math.PI / 2));
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4, dir = new V3(Math.sin(a), Math.cos(a), 0);
      W('varnish', rodG(dir.clone().multiplyScalar(0.09), dir.clone().multiplyScalar(0.46), 0.022, 6));
      W('varnish', rodG(dir.clone().multiplyScalar(0.54), dir.clone().multiplyScalar(0.6), 0.026, 6));
      W('varnish', rodG(dir.clone().multiplyScalar(0.6), dir.clone().multiplyScalar(0.72), 0.019, 6));
      W('varnish', at(new THREE.SphereGeometry(0.026, 8, 6), ...dir.clone().multiplyScalar(0.72).toArray()));
      if (k === 0) W('white', rodG(dir.clone().multiplyScalar(0.61), dir.clone().multiplyScalar(0.68), 0.027, 8));   // the king spoke's turk's head
    }
    const rim = new THREE.TorusGeometry(0.5, 0.04, 10, 48); rim.scale(1, 1, 0.75); W('varnish', rim);
    W('brass', torG(0.5, 0.01, 0, 0, 0.032, 0, 0, 0, 4, 48));
    W.build(wheel, M);
  }
  add('varnish', boxG(0.42, 0.78, 0.5, 0, D_WHEEL + 0.39, Z_WHEEL));                                                        // wheel box
  add('darkwood', boxG(0.46, 0.05, 0.54, 0, D_WHEEL + 0.8, Z_WHEEL));
  add('brass', cylG(0.04, 0.04, 0.3, 8, 0, D_WHEEL + 0.84, Z_WHEEL + 0.2, Math.PI / 2));                                   // the shaft
  {   // binnacle forward of the box: a varnished pedestal, brass hood, the card under glass
    const bz = Z_WHEEL - 0.8, by = D_WHEEL + 1.05;
    add('varnish', cylG(0.2, 0.24, 1.0, 8, 0, D_WHEEL + 0.5, bz));
    add('brass', cylG(0.22, 0.22, 0.1, 16, 0, by + 0.05, bz));
    add('brass', at(new THREE.SphereGeometry(0.22, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, by + 0.1, bz));
    add('card', at(new THREE.CircleGeometry(0.09, 20), 0, by + 0.2, bz + 0.17, -0.7));
    add('glass', at(new THREE.RingGeometry(0.09, 0.11, 20), 0, by + 0.2, bz + 0.172, -0.7));
    for (const s of [-1, 1]) add('iron', at(new THREE.SphereGeometry(0.07, 10, 8), s * 0.3, by + 0.08, bz));                // quadrantal spheres
  }

  // ── deckhouses ──
  function house(z0, z1, hw2, hgt, opts = {}) {   // z0 forward, z1 aft
    const zc = (z0 + z1) / 2, base = deckAt(zc, hw2) - 0.04, top = deckAt(zc, 0) + hgt, len = z1 - z0;
    for (const s of [-1, 1]) add('varnish', boxG(0.06, top - base, len, s * hw2, (top + base) / 2, zc));
    add('varnish', boxG(hw2 * 2, top - base, 0.06, 0, (top + base) / 2, z0));
    add('varnish', boxG(hw2 * 2, top - base, 0.06, 0, (top + base) / 2, z1));
    for (const s of [-1, 1]) for (const z of [z0, z1]) add('darkwood', boxG(0.1, top - base + 0.02, 0.1, s * hw2, (top + base) / 2, z));
    add('darkwood', boxG(hw2 * 2 + 0.12, 0.08, len + 0.12, 0, top - 0.02, zc));                                            // the roof's edge
    add('buff', loft(1, 10, (a, j) => { const x = (j * 2 - 1) * (hw2 + 0.06); return [x, top + 0.02 + 0.08 * (1 - (x / (hw2 + 0.06)) ** 2), z0 - 0.06 + a * (len + 0.12)]; }));
    for (const s of [-1, 1]) add('varnish', boxG(0.05, 0.05, len - 0.6, s * (hw2 - 0.25), top + 0.13, zc));                // handrails
    return { base, top, zc };
  }
  // main deckhouse amidships: windows down each side and two forward, a skylight, the galley stovepipe
  {
    const [z0, z1, w2, hh] = K.house, H = house(z0, z1, w2, hh);
    for (const s of [-1, 1]) for (let k = 0; k < K.windows; k++) {
      const z = z0 + 0.8 + k * (z1 - z0 - 1.6) / (K.windows - 1), y = (H.base + H.top) / 2 + 0.06;
      add('window', boxG(0.02, 0.38, 0.6, s * (w2 + 0.03), y, z));
      add('white', boxG(0.03, 0.46, 0.06, s * (w2 + 0.035), y, z - 0.33)); add('white', boxG(0.03, 0.46, 0.06, s * (w2 + 0.035), y, z + 0.33));
      add('white', boxG(0.03, 0.05, 0.72, s * (w2 + 0.035), y - 0.22, z)); add('white', boxG(0.03, 0.05, 0.72, s * (w2 + 0.035), y + 0.22, z));
    }
    for (const x of [-0.75, 0.75]) { const y = (H.base + H.top) / 2 + 0.06; add('window', boxG(0.55, 0.36, 0.02, x, y, z0 - 0.03)); add('white', boxG(0.65, 0.46, 0.015, x, y, z0 - 0.025)); }
    // aft end: the companionway with a sliding hatch and doors
    add('darkwood', boxG(0.8, H.top - H.base - 0.1, 0.03, 0, (H.top + H.base) / 2 - 0.05, z1 + 0.04));
    for (const x of [-0.2, 0.2]) add('varnish', boxG(0.36, H.top - H.base - 0.2, 0.04, x, (H.top + H.base) / 2 - 0.08, z1 + 0.06));
    add('brass', cylG(0.025, 0.025, 0.03, 8, 0.05, (H.top + H.base) / 2, z1 + 0.09, Math.PI / 2));
    add('varnish', boxG(0.9, 0.14, 0.9, 0, H.top + 0.16, z1 - 0.4));
    // skylight: a raised box with sloping glass in brass bars
    const sy = H.top + 0.1, sz = (z0 + z1) / 2 - 0.55;
    add('varnish', boxG(1.1, 0.3, 1.6, 0, sy + 0.15, sz));
    for (const s of [-1, 1]) {
      add('glass', at(new THREE.PlaneGeometry(1.5, 0.62).rotateY(Math.PI / 2).rotateZ(-s * 1.05), s * 0.27, sy + 0.44, sz));
      for (let k = 0; k < 6; k++) add('brass', rodG(new V3(s * 0.55, sy + 0.3, sz - 0.7 + k * 0.28), new V3(0, sy + 0.58, sz - 0.7 + k * 0.28), 0.012, 4));
    }
    add('varnish', boxG(0.08, 0.06, 1.6, 0, sy + 0.6, sz));
    // the galley stove's chimney, a brass Charlie Noble on top
    add('iron', cylG(0.09, 0.09, 0.8, 10, 0.9, H.top + 0.45, z0 + 0.9));
    add('brass', cylG(0.16, 0.13, 0.22, 12, 0.9, H.top + 0.92, z0 + 0.9));
    add('brass', cylG(0.18, 0.18, 0.03, 12, 0.9, H.top + 1.05, z0 + 0.9));
  }
  // after doghouse: round brass ports, companion doors facing the helm, sliding hatch on top
  {
    const [z0, z1, w2, hh] = K.dog, H = house(z0, z1, w2, hh);
    for (const s of [-1, 1]) for (const z of [z0 + 0.6, z1 - 0.6]) {
      add('brass', torG(0.11, 0.022, s * (w2 + 0.035), (H.base + H.top) / 2 + 0.05, z, 0, Math.PI / 2, 0, 6, 20));
      add('window', at(new THREE.CircleGeometry(0.1, 16), s * (w2 + 0.032), (H.base + H.top) / 2 + 0.05, z, 0, Math.PI / 2, 0));
    }
    for (const x of [-0.21, 0.21]) {
      add('varnish', boxG(0.38, H.top - H.base - 0.12, 0.04, x, (H.top + H.base) / 2 - 0.05, z1 + 0.05));
      for (const y of [0.25, 0.55]) add('darkwood', boxG(0.3, 0.04, 0.02, x, H.base + y, z1 + 0.075));
    }
    add('brass', cylG(0.022, 0.022, 0.04, 8, 0.04, (H.top + H.base) / 2, z1 + 0.09, Math.PI / 2));
    add('varnish', boxG(0.86, 0.12, 0.8, 0, H.top + 0.14, z1 - 0.38));
    for (const s of [-1, 1]) add('darkwood', boxG(0.05, 0.08, 1.4, s * 0.45, H.top + 0.1, z1 - 0.7));
  }
  // benches along the bulwarks aft, where the passengers sit
  for (const s of [-1, 1]) for (const [za, zb] of K.benches) {
    const n = 8; for (let k = 0; k < n; k++) {
      const z = za + (zb - za) * (k + 0.5) / n, u = uZ(z), x = s * (hwIn(u) - 0.24), y = deckY(u, hwIn(u)) + 0.42;
      add('varnish', boxG(0.4, 0.05, (zb - za) / n + 0.01, x, y, z));
      if (k % 2 === 0) add('darkwood', boxG(0.06, 0.4, 0.06, x - s * 0.12, y - 0.21, z));
    }
  }
  // main hatch forward, with a grating
  { const z = K.hatch, y = deckAt(z) + 0.38; add('varnish', boxG(1.7, 0.36, 1.5, 0, y - 0.18, z)); add('grating', boxG(1.55, 0.03, 1.35, 0, y + 0.01, z)); add('darkwood', boxG(1.8, 0.06, 1.6, 0, y - 0.02, z).scale(1, 1, 1)); }
  // a life ring on each side of the doghouse, on the bulwarks
  for (const s of [-1, 1]) { const z = K.rings, u = uZ(z); add('ring', torG(0.32, 0.07, s * (hwIn(u) - 0.09), sh(u) + 0.35, z, 0, Math.PI / 2, 0, 10, 32)); }

  // ── windlass, anchors at the catheads, bitts ──
  {
    const z = K.windlass, d = deckAt(z), zh = zD(0) + 0.6;
    for (const s of [-1, 1]) add('iron', boxG(0.24, 0.9, 0.3, s * 0.75, d + 0.45, z));
    add('iron', cylG(0.18, 0.18, 1.3, 14, 0, d + 0.55, z, 0, 0, Math.PI / 2));
    for (const s of [-1, 1]) { add('iron', cylG(0.32, 0.32, 0.14, 16, s * 0.48, d + 0.55, z, 0, 0, Math.PI / 2)); add('iron', boxG(0.06, 0.06, 0.9, s * 0.95, d + 0.75, z + 0.1, 0.3)); }
    for (const s of [-1, 1]) {   // chain from the gypsy forward to the hawse
      const a = new V3(s * 0.48, d + 0.3, z - 0.2), b = new V3(s * 0.55, deckAt(zh) + 0.05, zh);
      for (let k = 0; k < 10; k++) { const p = a.clone().lerp(b, k / 10); add('iron', torG(0.06, 0.018, p.x, p.y + 0.03, p.z, k % 2 ? Math.PI / 2 : 0, 0, 0, 4, 8)); }
    }
    for (const s of [-1, 1]) add('varnish', boxG(0.3, 0.6, 0.3, s * 0.5, deckAt(zh + 0.4) + 0.3, zh + 0.4));                         // bitts at the stem
    for (const s of [-1, 1]) {   // cathead and a stocked anchor hanging from it
      const u = 0.07, x = s * (hw(u) + 0.35), y = capY(u), z = zD(u);
      add('darkwood', boxG(0.9, 0.22, 0.22, s * (hw(u) + 0.1), y, z));
      add('iron', cylG(0.055, 0.055, 1.7, 8, x, y - 1.0, z));
      add('iron', cylG(0.04, 0.04, 1.5, 8, x, y - 0.25, z, Math.PI / 2));
      add('iron', torG(0.08, 0.02, x, y - 0.06, z, 0, Math.PI / 2, 0, 4, 10));
      const arm = new THREE.TorusGeometry(0.55, 0.05, 6, 14, Math.PI * 0.8); arm.rotateZ(Math.PI * 1.1); arm.rotateY(Math.PI / 2); add('iron', at(arm, x, y - 1.5, z));
    }
  }

  // ── bowsprit: bobstay, whiskers, footropes, netting (none on a knockabout) ──
  if (SPRIT) {
    const S = SPRIT, a = new V3(0, S.y0, S.z0 + 0.4), b = new V3(0, S.y1, S.z1);
    add('spar', rodG(a, b, 0.19, 12));
    add('iron', cylG(0.24, 0.24, 0.3, 12, 0, S.y1 - 0.05 * Math.sin(S.a), S.z1 + 0.15, Math.PI / 2 - S.a));
    add('white', rodG(b, b.clone().add(new V3(0, 0.55 * Math.sin(S.a), -0.55)), 0.13, 10));                                // the jibboom's tip
    const stemWL = new V3(0, 0.5, zW(0) - 0.6);
    add('iron', rodG(b, stemWL, 0.035, 5));                                                                                // bobstay
    const whisk = s => new V3(s * (hw(0.03) + 0.05), sh(0.03) + 0.1, zD(0.03));
    for (const s of [-1, 1]) {
      add('iron', rodG(b, whisk(s), 0.02, 4));
      add('rope', sagLine(new V3(s * 0.45, S.y1 - 0.15, S.z1 + 0.3), new V3(s * 0.55, S.y0 - 0.1, S.z0 - 0.6), 0.55, 0.015, 8));   // footropes
      const p = whisk(s), geo = new THREE.BufferGeometry(), pts = [p, a, b], uvs = pts.flatMap(q => [q.x / 0.3, q.z / 0.3]);
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap(q => q.toArray()), 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geo.computeVertexNormals();
      add('net', geo);
    }
  }

  // ── masts, hoops, fife rails, pin rails, shrouds on deadeyes with ratlines, stays ──
  function mast(m, shrouds) {
    const { z, d } = m, top = d + m.head;
    add('spar', cylG(m.r * 0.78, m.r, m.head + 0.2, 16, 0, d + m.head / 2 - 0.1, z));
    add('white', cylG(m.r * 0.8, m.r * 0.8, 1.6, 16, 0, top - 0.8, z));                                                    // masthead, painted
    add('iron', cylG(m.r + 0.12, m.r + 0.2, 0.22, 16, 0, d + 0.1, z));                                                      // mast coat
    if (!P.topmasts) {   // bald-headed (Bowdoin): the mast ends at its painted head, a truck on top; no crosstrees
      if (P.iceBarrel && m === MAIN) {   // the ice barrel: an open, hooped cask at the foremast head, a lookout's crow's nest
        add('darkwood', at(new THREE.CylinderGeometry(0.52, 0.44, 1.25, 16, 1, true), 0, top + 0.5, z));
        add('darkwood', cylG(0.44, 0.44, 0.06, 16, 0, top - 0.12, z));
        for (const y of [-0.5, -0.05, 0.4]) add('iron', torG(0.49 - y * 0.06, 0.025, 0, top + 0.5 + y, z, Math.PI / 2, 0, 0, 4, 20));
        for (const s of [-1, 1]) add('iron', rodG(new V3(s * 0.4, top - 0.1, z), new V3(s * 0.12, top - 1.4, z), 0.03, 4));   // the iron knees under it
      } else add('white', at(new THREE.SphereGeometry(0.14, 10, 8), 0, top + 0.08, z));   // truck
    } else {
    add('iron', boxG(0.55, 0.2, 1.1, 0, top + 0.1, z - 0.25));                                                              // cap
    add('darkwood', boxG(0.18, 0.18, 1.2, 0, d + m.cross, z - 0.2));                                                        // trestletrees
    add('darkwood', boxG(2.6 * (m === MAIN ? 1 : 0.8), 0.12, 0.14, 0, d + m.cross + 0.1, z - 0.2));                          // crosstrees
    const tTop = d + m.top, tz = z - 0.45;
    add('spar', cylG(0.09, 0.15, tTop - (top - 1.6), 12, 0, (tTop + top - 1.6) / 2, tz));                                    // topmast
    add('white', at(new THREE.SphereGeometry(0.14, 10, 8), 0, tTop + 0.08, tz));                                              // truck
    }
    const tz = z - 0.45;
    for (let y = d + m.by + 0.7; y < d + m.throat - 0.2; y += 1.15) add('spar', torG(m.r * 0.8 + 0.06, 0.03, 0, y, z, Math.PI / 2, 0, 0, 5, 18));   // mast hoops
    // halyards down the after side of the mast to the fife rail
    for (const x of [-0.14, 0, 0.14]) add('rope', rodG(new V3(x, d + m.throat + 0.4, z + m.r + 0.04), new V3(x * 3, d + 0.82, z + 0.62), 0.011, 3));
    // fife rail round the after side, belaying pins, coils hanging
    const ry = d + 0.78, fr = [[new V3(-0.75, ry, z - 0.35), new V3(-0.75, ry, z + 0.7)], [new V3(-0.75, ry, z + 0.7), new V3(0.75, ry, z + 0.7)], [new V3(0.75, ry, z + 0.7), new V3(0.75, ry, z - 0.35)]];
    for (const [p, q] of fr) {
      add('varnish', at(new THREE.BoxGeometry(0.12, 0.07, p.distanceTo(q) + 0.12).lookAt(new V3().subVectors(q, p)), (p.x + q.x) / 2, ry, (p.z + q.z) / 2));
      const n = Math.round(p.distanceTo(q) / 0.2);
      for (let k = 1; k < n; k++) {
        const c = p.clone().lerp(q, k / n);
        add('darkwood', cylG(0.022, 0.018, 0.36, 6, c.x, c.y + 0.03, c.z));
        add('darkwood', cylG(0.032, 0.025, 0.1, 6, c.x, c.y + 0.17, c.z));
        if ((k + Math.round(c.x * 7)) % 2 === 0) { const o = new V3(c.x === -0.75 ? -1 : c.x === 0.75 ? 1 : 0, 0, c.z === z + 0.7 ? 1 : 0).multiplyScalar(0.07); add('rope', torG(0.15, 0.022, c.x + o.x, c.y - 0.13, c.z + o.z, 0, o.x ? Math.PI / 2 : 0, 0, 4, 16)); }
      }
    }
    for (const [x, zz] of [[-0.75, z - 0.35], [-0.75, z + 0.7], [0.75, z + 0.7], [0.75, z - 0.35]]) add('varnish', cylG(0.06, 0.07, 0.78, 8, x, d + 0.39, zz));
    add('rope', torG(0.32, 0.03, 0.3, d + 0.03, z + 1.25, Math.PI / 2, 0, 0, 4, 24), torG(0.22, 0.03, 0.3, d + 0.07, z + 1.25, Math.PI / 2, 0, 0, 4, 20), torG(0.12, 0.03, 0.3, d + 0.1, z + 1.25, Math.PI / 2, 0, 0, 4, 16));   // a line flaked down on deck
    // shrouds: chainplates, deadeyes and lanyards, ratlines, a sheer pole; pin rails inside the bulwark
    for (const s of [-1, 1]) {
      const tops = [], hounds = new V3(s * 0.3, d + m.hounds, z);
      for (const dz of shrouds) {
        const zz = z + dz, u = uZ(zz), xo = s * (hw(u) + 0.1), y0 = capY(u) + 0.35;
        add('iron', boxG(0.04, 1.2, 0.1, xo, y0 - 0.55, zz));
        const lo = new V3(xo, y0, zz), hi = new V3(xo * 0.99, y0 + 0.55, zz);
        for (const p of [lo, hi]) add('darkwood', cylG(0.13, 0.13, 0.09, 12, p.x, p.y, p.z, 0, 0, Math.PI / 2));
        for (const o of [-0.06, 0, 0.06]) add('rope', rodG(lo.clone().add(new V3(0, 0, o)), hi.clone().add(new V3(0, 0, o)), 0.009, 3));
        add('tar', rodG(hi, hounds, 0.018, 5));
        tops.push(hi);
      }
      add('iron', rodG(tops[0].clone().add(new V3(0, 0.25, 0)), tops[tops.length - 1].clone().add(new V3(0, 0.25, 0)), 0.018, 4));
      const onShroud = (p, y) => p.clone().lerp(hounds, (y - p.y) / (hounds.y - p.y));
      for (let y = tops[0].y + 0.5; y < hounds.y - 2.2; y += 0.4) for (let k = 0; k + 1 < tops.length; k++) add('tar', rodG(onShroud(tops[k], y), onShroud(tops[k + 1], y), 0.008, 3));
      // topmast shrouds and futtocks
      if (P.topmasts) {
      const ct = new V3(s * (m === MAIN ? 1.25 : 1.0), d + m.cross + 0.15, z - 0.2), tt = new V3(s * 0.08, d + m.top - 1.2, tz);
      add('tar', rodG(ct, tt, 0.013, 4)); add('tar', rodG(ct, new V3(s * 0.32, d + m.cross - 1.8, z), 0.012, 4));
      for (let y = ct.y + 0.45; y < tt.y - 1.5; y += 0.4) { const p = ct.clone().lerp(tt, (y - ct.y) / (tt.y - ct.y)); add('tar', rodG(p, new V3(0, p.y, p.z + (tz - p.z) * 0.2), 0.007, 3)); }
      // topmast backstay to the rail abaft the shrouds
      const bz = z + (m === MAIN ? 3.4 : 3.0), bu = uZ(bz);
      add('tar', rodG(new V3(s * 0.06, d + m.top - 0.6, tz), new V3(s * (hw(bu) + 0.06), capY(bu), bz), 0.012, 4));
      }
      // pin rail
      const pu = uZ(z + 0.2), px = s * (hwIn(pu) - 0.08), py = sh(pu) + 0.5;
      add('varnish', boxG(0.14, 0.06, 2.4, px, py, z + 0.2));
      for (let k = 0; k < 11; k++) {
        const pz = z - 0.8 + k * 0.2;
        add('darkwood', cylG(0.022, 0.018, 0.36, 6, px, py + 0.03, pz)); add('darkwood', cylG(0.032, 0.025, 0.1, 6, px, py + 0.17, pz));
        if (k % 3 !== 1) add('rope', torG(0.16, 0.022, px - s * 0.07, py - 0.14, pz, 0, Math.PI / 2, 0, 4, 16));
      }
      // sidelight boards on the main shrouds
      if (m === MAIN) {
        const lp = C.lights[s < 0 ? 'port' : 'stbd'];
        add(s < 0 ? 'red' : 'green', boxG(0.04, 0.4, 0.55, lp[0] - s * 0.06, lp[1] - 0.05, lp[2]));
        add('white', boxG(0.05, 0.42, 0.04, lp[0], lp[1] - 0.05, lp[2] - 0.29));
      }
    }
  }
  mast(MAIN, [-0.5, 0.15, 0.8]);
  mast(MIZ, [-0.1, 0.6]);
  // stays: inner forestay to the mainmast's hounds, jibstay to the topmast, spring stays between the masts
  // a knockabout (no bowsprit): the jib's stay from the stem head to the foremast head, the forestaysail's from the deck a few metres aft
  const foreHead = new V3(0, D_MAIN + MAIN.hounds, Z_MAIN - 0.3), jibHead = P.topmasts ? new V3(0, D_MAIN + MAIN.top - 1.4, Z_MAIN - 0.5) : new V3(0, D_MAIN + MAIN.head - 0.3, Z_MAIN - 0.25);
  const sprEnd = SPRIT ? new V3(0, SPRIT.y1, SPRIT.z1) : STEM_HEAD.clone();
  const stayTack = SPRIT ? STEM_HEAD : new V3(0, deckAt(zD(0) + 3.2) + 0.3, zD(0) + 3.2);
  add('tar', rodG(stayTack, foreHead, 0.02, 5), rodG(sprEnd, jibHead, 0.018, 5));
  add('tar', rodG(new V3(0, D_MAIN + MAIN.head - 0.3, Z_MAIN + 0.25), new V3(0, D_MIZ + MIZ.head - 0.3, Z_MIZ - 0.25), 0.016, 4));
  if (P.topmasts) add('tar', rodG(new V3(0, D_MAIN + MAIN.top - 0.4, Z_MAIN - 0.4), new V3(0, D_MIZ + MIZ.top - 0.4, Z_MIZ - 0.4), 0.012, 4));
  // main sheet horse just forward of the mizzen; the mizzen's on the taffrail
  add('iron', rodG(new V3(-1.2, D_MIZ + 0.3, Z_MIZ - 1.3), new V3(1.2, D_MIZ + 0.3, Z_MIZ - 1.3), 0.03, 6));
  add('iron', rodG(new V3(-1.4, capY(1) + 0.12, L / 2 - 0.1), new V3(1.4, capY(1) + 0.12, L / 2 - 0.1), 0.03, 6));
  add.build(body, M);

  // ── sails and the spars that swing: each boom group pivots at its gooseneck ──
  const booms = [];
  for (const m of [MAIN, MIZ]) {
    const bg = new THREE.Group(); bg.position.set(0, m.d + m.by, m.z); body.add(bg);
    const B = collector();
    B('spar', rodG(new V3(0, 0, m.r + 0.05), new V3(0, 0, m.boom), 0.14, 10));
    for (const s of [-1, 1]) B('darkwood', boxG(0.06, 0.3, 0.5, s * (m.r + 0.06), 0, 0.15));                                // jaws
    B('darkwood', boxG(0.3, 0.06, 0.06, 0, 0, m.boom - 0.15));
    B.build(bg, M);
    const yT = m.throat - m.by, A = 35 * Math.PI / 180;
    const gaff = new THREE.Group(); gaff.position.set(0, yT, 0); bg.add(gaff);
    const G = collector();
    G('spar', rodG(new V3(0, 0, m.r + 0.05), new V3(0, Math.sin(A) * m.gaff, Math.cos(A) * m.gaff + m.r), 0.11, 8));
    for (const s of [-1, 1]) G('darkwood', boxG(0.06, 0.24, 0.45, s * (m.r + 0.06), 0.06, 0.12, -A));
    G.build(gaff, M);
    const peak = new V3(0, yT + Math.sin(A) * m.gaff, Math.cos(A) * m.gaff + m.r), clew = new V3(0, 0.2, m.boom - 0.45);
    const tw = u => -0.16 * u, belly = u => new V3(-Math.cos(tw(u)), 0, Math.sin(tw(u)) * 0.2).normalize();
    const rot = (p, t) => new V3(Math.sin(t) * p.z + Math.cos(t) * p.x, p.y, Math.cos(t) * p.z - Math.sin(t) * p.x);
    const sail = new THREE.Mesh(sailGeo(u => new V3(0, 0.4 + u * (yT - 0.45), m.r + 0.08), u => rot(clew.clone().lerp(peak, u), tw(u) * 0.7), belly, 0.085), M.sail);
    bg.add(sail);
    // peak and throat halyards (from the masthead, on the pivot's axis, so they swing true)
    const hal = new THREE.Mesh(mergeG([0.45, 0.8, 1].map(f => rodG(new V3(0, m.head - m.by - 0.3, 0.1), new V3(0, yT + Math.sin(A) * m.gaff * f, Math.cos(A) * m.gaff * f + m.r), 0.012, 3))), M.rope);
    bg.add(hal);
    const sheetEnd = m === MAIN ? new V3(0, -(m.by - 0.3), Z_MIZ - 1.3 - m.z) : new V3(0, capY(1) + 0.12 - m.d - m.by, L / 2 - 0.1 - m.z);
    const sheet = new THREE.Mesh(rodG(new V3(0, -0.1, m.boom - 0.4), sheetEnd, 0.016, 4), M.rope); bg.add(sheet);
    // gaff topsail: up the topmast from the throat, sheeted to the gaff's peak
    const head = new V3(0, m.top - m.by - 0.6, -0.3), tack = new V3(0, yT + 0.5, 0.1);
    const topsail = !P.topmasts ? new THREE.Object3D() : new THREE.Mesh(sailGeo(u => tack.clone().lerp(head, u), u => peak.clone().add(new V3(0, 0.1, -0.2)).lerp(head, u), () => new V3(-1, 0, 0), 0.07, 10, 6), M.sail);
    bg.add(topsail);
    // furled: the sail stowed on the boom under its gaff, the topsail sent down
    const furl = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, m.boom - 1.6, 4, 12).rotateX(Math.PI / 2).translate(0, 0.3, m.boom / 2 + 0.2), M.furl); bg.add(furl);
    const ties = new THREE.Mesh(mergeG(Array.from({ length: 7 }, (_, k) => torG(0.28, 0.018, 0, 0.3, 1.2 + k * (m.boom - 2.2) / 6, 0, 0, 0, 3, 14))), M.rope); bg.add(ties);
    booms.push({ bg, gaff, sail, topsail, furl, ties, hal, m, yT });
  }
  // headsails: staysail on the inner forestay, jib on the jibstay, their clews swung by the trim
  const heads = [
    { tack: stayTack.clone().add(new V3(0, 0.1, 0.1)), head: stayTack.clone().lerp(foreHead, 0.82), R: P.heads[0], y: 3.7 },
    { tack: sprEnd.clone().lerp(jibHead, 0.03), head: sprEnd.clone().lerp(jibHead, 0.82), R: P.heads[1], y: 4.4 },
  ].map(h => { const mesh = new THREE.Mesh(jibGeo(h.tack, h.head, h.R, h.y, 20, 1), M.sail); body.add(mesh); return { ...h, mesh, key: '' }; });
  const jibFurl = new THREE.Mesh(SPRIT ? rodG(new V3(0, SPRIT.y0 + 0.3, SPRIT.z0 - 1), new V3(0, SPRIT.y1 + 0.2, SPRIT.z1 + 0.6), 0.17, 8)
    : rodG(STEM_HEAD.clone().lerp(jibHead, 0.04), STEM_HEAD.clone().lerp(jibHead, 0.22), 0.17, 8), M.furl); body.add(jibFurl);   // (a knockabout's jib furled down its stay)

  let nest = null;
  if (C.crowsNest) { nest = new THREE.Object3D(); nest.position.set(...C.crowsNest); body.add(nest); }   // the lookout's eye, for the views to ride
  let wheelA = 0, wheelT = 0;
  const setUp = up => {
    for (const b of booms) {
      b.sail.visible = b.topsail.visible = b.hal.visible = up; b.furl.visible = b.ties.visible = !up;
      b.gaff.position.y = up ? b.yT : 0.62; b.gaff.rotation.x = up ? 0 : 35 * Math.PI / 180;   // lowered onto the furled sail
    }
    jibFurl.visible = !up;
  };
  setUp(false);
  let upNow = false;
  return {
    group: g, body, type: P.id, L, kn: P.kn, power: false, nest, helm: C.helm,
    wake() {},
    // p: a makeTrimmer() result; heelRad: the wind's full heel; up: false furls everything
    trim(p, heelRad, up) {
      if (up !== upNow) { upNow = up; setUp(up); }
      for (const b of booms) { b.bg.rotation.y = -p.side * (up ? p.boom : 0) * Math.PI / 180; b.sail.scale.x = b.topsail.scale.x = p.side < 0 ? -1 : 1; }
      body.rotation.z = up ? p.side * p.heelK * heelRad * 0.45 : 0;   // a big vessel: stiff
      const key = `${Math.round(p.jib)},${p.side}`;
      for (const h of heads) {
        h.mesh.visible = up && p.jibOn;
        if (h.mesh.visible && key !== h.key) { h.key = key; h.mesh.geometry.dispose(); h.mesh.geometry = jibGeo(h.tack, h.head, h.R, h.y, p.jib, p.side); }
      }
    },
    // rate: degrees a second she's turning (+ to starboard); the wheel turns with the helm put over
    steer(rate, dt) {
      wheelT = Math.max(-2.4, Math.min(2.4, -rate * 0.35));
      wheelA += (wheelT - wheelA) * Math.min(1, dt * 2);
      wheel.rotation.z = wheelA;
    },
    // lit windows below at night
    setNight(on) { M.window.emissive.setHex(on ? 0x6b4a1c : 0x000000); },
  };
}
return { C, make };
}

// ── The vessels ──────────────────────────────────────────────────────────────
// Angelique (v906): exactly as she was built before the builder took a spec.
const ANGELIQUE_SPEC = {
  id: 'angelique', L: 29, HB: 3.65, BH: 0.85, BT: 0.14, DRAFT: 3.3, OVB: 3.0, OVS: 2.2, CAMBER: 0.12, fb: 1.85, shF: 0.8, shA: 0.45, kn: 7,
  masts: [{ z: -5.8, by: 1.75, throat: 16.5, hounds: 17.2, head: 19.5, cross: 18.2, top: 27.5, boom: 10.8, gaff: 8.5, r: 0.27 },
          { z: 5.8, by: 3.0, throat: 12.5, hounds: 13.2, head: 15.5, cross: 14.3, top: 22.5, boom: 8.4, gaff: 6.2, r: 0.24 }],
  topmasts: true, sprit: 8.5, iceBarrel: false, heads: [7.2, 10.5], zWheel: 11.6, zAtMast: -10.5, anchorLight: [0, 9.0, -14.6], droneBack: 90,
  layout: { house: [-3.5, 3.4, 1.75, 0.95], windows: 5, dog: [7.5, 9.6, 1.1, 0.8], benches: [[6.6, 10.8], [-1.5, 2.8]], hatch: -8.9, rings: 8.4, windlass: -12.2 },
  hull: 0x1f5a3c, hullSpec: 0x5a6a60, stripe: 0xd2ab55, sail: '#8e4c30', sailGlow: 0x4a2416, furl: 0x74402c,
  name: 'ANGELIQUE', port: 'CAMDEN', nameCol: '#e2bd62', boardBack: '#16402b',
};
// The Arctic schooner Bowdoin (v919, requested: "add the schooner Bowdoin, currently owned by Maine Maritime
// Academy … give it a Crow's Nest", and "I want to be able to swap her in, just like Sea Nymph and Angelique").
// Built 1921 by Hodgdon Brothers, East Boothbay, to William Hand's design, for Donald MacMillan's Arctic
// voyages; Maine Maritime Academy's training vessel, home port Castine. 88 ft overall, 72 ft on the waterline,
// 21 ft beam, 10 ft draft, 66 tons (MMA's fact sheet). A gaff schooner, "bald-headed, knockabout": no
// topmasts and no bowsprit, the jib tacked at the stem head; the foremast shorter than the main, and at its
// head the ice barrel, her crow's nest. Mast heights and colours aren't in the sources: a white hull and
// cream canvas, and masts scaled to her length, are guesses to correct.
const BOWDOIN_SPEC = {
  id: 'bowdoin', L: 26.8, HB: 3.2, BH: 0.7, BT: 0.12, DRAFT: 3.05, OVB: 2.6, OVS: 2.3, CAMBER: 0.12, fb: 1.55, shF: 0.7, shA: 0.35, kn: 7,
  masts: [{ z: -5.4, by: 1.6, throat: 13.0, hounds: 13.6, head: 15.8, cross: 14.5, top: 15.8, boom: 7.6, gaff: 6.0, r: 0.22 },
          { z: 1.8, by: 1.7, throat: 14.6, hounds: 15.2, head: 17.6, cross: 16.3, top: 17.6, boom: 11.2, gaff: 7.4, r: 0.25 }],
  topmasts: false, sprit: 0, iceBarrel: true, heads: [5.6, 7.2], zWheel: 10.9, zAtMast: -9.2, anchorLight: [0, 7.5, -11.6], droneBack: 80,
  layout: { house: [-3.9, 0.2, 1.35, 0.8], windows: 3, dog: [5.6, 8.6, 1.25, 0.95], benches: [[3.6, 5.2]], hatch: -8.2, rings: 9.2, windlass: -11.0 },
  hull: 0xf0ede4, hullSpec: 0x666666, stripe: 0x1d1f21, sail: '#e6dcc4', sailGlow: 0x3a352a, furl: 0xd8ccae,
  name: 'BOWDOIN', port: 'CASTINE', nameCol: '#1d1f21', boardBack: '#f0ede4',
};
const A = vessel(ANGELIQUE_SPEC), B = vessel(BOWDOIN_SPEC);
export const ANGELIQUE = A.C, makeAngelique = A.make;
export const BOWDOIN = B.C, makeBowdoin = B.make;
