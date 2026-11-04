// Airliners as they are (v1108, requested: "How about airlines? If we can get up close, it would be worth
// recursively improving them"): one parametric airliner, sized from the type her ADS-B reports (B738, A321, E75L,
// B77W …) and painted in her airline's colours, from the flight's prefix. Shaped against a Boeing 737-800 three-view
// (Wikimedia Commons: 39.5 m long, 35.8 m span, 12.5 m tall, fuselage 3.76 m) and photos of United, Southwest and
// Alaska 737s: a round fuselage with a rounded nose and a tail cone swept up beneath, low swept wings with
// dihedral and winglets, two (or four) engines slung under and ahead of them, a swept fin and tailplane; the
// regional jets' engines on the tail under a T-tail. The colours are in the geometry (vertex colours), so a plane
// is one mesh with one shared material.
// makeAirliner(type, flight, { gear }) → { group, L, cockpit } or null when she isn't an airliner we know the shape
// of (the caller keeps its small plane). Metres; nose to −z; origin on her centreline at mid-length.
import * as THREE from 'three';

// ICAO type → [length, span, fuselage diameter, engines (2, 4, or 'rear')]
const T = {
  B737: [33.6, 34.3, 3.76, 2], B738: [39.5, 35.8, 3.76, 2], B38M: [39.5, 35.9, 3.76, 2], B739: [42.1, 35.9, 3.76, 2], B39M: [42.2, 35.9, 3.76, 2], B3XM: [43.8, 35.9, 3.76, 2],
  A319: [33.8, 35.8, 3.95, 2], A19N: [33.8, 35.8, 3.95, 2], A320: [37.6, 35.8, 3.95, 2], A20N: [37.6, 35.8, 3.95, 2], A321: [44.5, 35.8, 3.95, 2], A21N: [44.5, 35.8, 3.95, 2],
  BCS1: [35.0, 35.1, 3.7, 2], BCS3: [38.7, 35.1, 3.7, 2], E170: [29.9, 26.0, 3.0, 2], E75L: [31.7, 26.0, 3.0, 2], E75S: [31.7, 26.0, 3.0, 2], E190: [36.2, 28.7, 3.0, 2], E195: [38.7, 28.7, 3.0, 2], E290: [36.2, 33.7, 3.0, 2],
  CRJ2: [26.8, 21.2, 2.7, 'rear'], CRJ7: [32.5, 23.2, 2.7, 'rear'], CRJ9: [36.2, 24.9, 2.7, 'rear'], B712: [37.8, 28.4, 3.3, 'rear'],
  B752: [47.3, 38.05, 3.76, 2], B753: [54.4, 38.05, 3.76, 2], B762: [48.5, 47.6, 5.03, 2], B763: [54.9, 47.6, 5.03, 2], B764: [61.4, 51.9, 5.03, 2],
  B772: [63.7, 60.9, 6.2, 2], B77L: [63.7, 64.8, 6.2, 2], B77W: [73.9, 64.8, 6.2, 2], B779: [76.7, 71.8, 6.2, 2],
  B788: [56.7, 60.1, 5.77, 2], B789: [62.8, 60.1, 5.77, 2], B78X: [68.3, 60.1, 5.77, 2],
  A332: [58.8, 60.3, 5.64, 2], A333: [63.7, 60.3, 5.64, 2], A339: [63.7, 64.0, 5.64, 2], A359: [66.8, 64.75, 5.96, 2], A35K: [73.8, 64.75, 5.96, 2],
  // (v1113: business jets, their engines on the tail under a T-tail, as the regional jets')
  C510: [12.4, 13.2, 1.5, 'rear'], C525: [13.0, 14.3, 1.5, 'rear'], C25A: [14.5, 15.5, 1.6, 'rear'], C25B: [15.6, 16.3, 1.6, 'rear'], C25C: [16.3, 16.3, 1.6, 'rear'],
  C56X: [15.8, 17.2, 1.7, 'rear'], C68A: [19.4, 22.0, 2.0, 'rear'], C700: [22.3, 20.6, 2.0, 'rear'], C750: [22.0, 19.4, 1.9, 'rear'], E50P: [12.8, 12.3, 1.6, 'rear'], E55P: [15.6, 15.9, 1.75, 'rear'],
  E545: [19.7, 20.0, 2.1, 'rear'], E550: [20.7, 20.0, 2.1, 'rear'], LJ35: [14.8, 12.0, 1.6, 'rear'], LJ45: [17.7, 14.6, 1.6, 'rear'], LJ60: [17.9, 13.3, 1.7, 'rear'], LJ75: [17.7, 15.5, 1.6, 'rear'],
  CL30: [20.9, 19.5, 2.2, 'rear'], CL35: [20.9, 21.0, 2.2, 'rear'], CL60: [20.9, 19.6, 2.7, 'rear'], GL5T: [29.5, 28.7, 2.7, 'rear'], GLEX: [30.3, 28.6, 2.7, 'rear'], GL7T: [33.8, 31.7, 2.7, 'rear'],
  G280: [20.3, 19.2, 2.2, 'rear'], GALX: [18.9, 17.7, 2.2, 'rear'], GLF4: [26.9, 23.7, 2.4, 'rear'], GLF5: [29.4, 28.5, 2.5, 'rear'], GLF6: [30.4, 30.4, 2.6, 'rear'], GA6C: [30.4, 30.4, 2.6, 'rear'],
  F2TH: [20.2, 19.3, 2.5, 'rear'], F900: [20.2, 19.3, 2.5, 'rear'], FA50: [18.5, 18.9, 2.5, 'rear'], FA7X: [23.2, 26.2, 2.5, 'rear'], FA8X: [24.5, 26.3, 2.5, 'rear'],
  PC24: [16.8, 17.0, 1.9, 'rear'], HDJT: [13.0, 12.1, 1.5, 'rear'], H25B: [15.6, 15.7, 1.9, 'rear'], ASTR: [16.9, 16.0, 1.9, 'rear'],
  A388: [72.7, 79.8, 7.1, 4, 'dd'], B744: [70.7, 64.4, 6.5, 4, 'hump'], B748: [76.3, 68.4, 6.5, 4, 'hump'],   // (round 6: the A380's double deck, the 747's hump)
};
// airline (the flight's prefix) → body, belly (below the line), tail, engines, and an accent along her lower aft side
const LIVERY = {
  UAL: { body: 0xf3f3f1, belly: 0x2f62bd, line: -0.18, tail: 0x2f62bd, tail2: 0xa9c3ea, eng: 0x2f62bd },
  SKW: { body: 0xf3f3f1, belly: 0x2f62bd, line: -0.18, tail: 0x2f62bd, tail2: 0xa9c3ea, eng: 0x2f62bd },   // (in SF, flying as United Express)
  SWA: { body: 0x304cb2, belly: 0x304cb2, tail: 0x304cb2, tail2: 0xe21836, tail3: 0xfdb515, eng: 0x304cb2, accent: [0xfdb515, 0xe21836] },
  ASA: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0x0b2e59, tail2: 0x00a9ce, eng: 0x0b2e59, accent: [0x00a9ce, 0x48a23f] },
  DAL: { body: 0xf3f3f1, belly: 0x0b2d5e, line: -0.25, tail: 0xc8102e, tail2: 0x0b2d5e, eng: 0x9aa3ab },
  AAL: { body: 0xc5ccd3, belly: 0x9aa3ab, line: -0.45, tail: 0x0e3f8a, tail2: 0xc8102e, eng: 0x9aa3ab },
  JBU: { body: 0xf3f3f1, belly: 0x0b2a6b, line: -0.2, tail: 0x0b2a6b, tail2: 0x3a73c8, eng: 0x0b2a6b },
  HAL: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0x4b2a7c, tail2: 0xd3426e, eng: 0x4b2a7c },
  FDX: { body: 0xf3f3f1, belly: 0xf3f3f1, top: 0x4d148c, tail: 0x4d148c, tail2: 0xff6600, eng: 0xc0c4c8 },
  UPS: { body: 0x4a2d1e, belly: 0x4a2d1e, tail: 0x4a2d1e, tail2: 0xffb500, eng: 0x4a2d1e },
  NKS: { body: 0xffe100, belly: 0xffe100, tail: 0xffe100, tail2: 0x111111, eng: 0x222222 },
  FFT: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0x00754a, tail2: 0x8fc54a, eng: 0x00754a },
};
// a tail's own pattern: fin(f along her chord from the leading edge 0…1, h up her 0…1) → colour (or undefined: her tail colour)
const ring = (f, h, cf, ch) => Math.hypot((f - cf) * 1.6, h - ch);
Object.assign(LIVERY, {
  UAE: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0xf3f3f1, eng: 0xf3f3f1, fin: f => f < 0.2 ? 0x00843d : f < 0.27 ? 0xf3f3f1 : f < 0.37 ? 0x151515 : f < 0.47 ? 0xd71a21 : undefined },   // Emirates: the flag along her leading edge
  BAW: { body: 0xf3f3f1, belly: 0x1c2a5a, line: -0.3, tail: 0xf3f3f1, eng: 0x9aa3ab, fin: (f, h) => f > 0.42 ? (h < 0.5 ? 0xd8203a : 0x1c2a5a) : undefined },   // British Airways: the Chatham flag
  DLH: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0x0a1d4d, eng: 0x0a1d4d, fin: (f, h) => { const r = ring(f, h, 0.55, 0.5); return r > 0.17 && r < 0.22 ? 0xf3f3f1 : undefined; } },   // Lufthansa: the crane's ring
  ACA: { body: 0xf3f3f1, belly: 0x1a1a1a, line: -0.25, tail: 0x151515, eng: 0x151515, fin: (f, h) => ring(f, h, 0.55, 0.45) < 0.16 ? 0xd22630 : undefined },   // Air Canada: the maple leaf
  AFR: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0xf3f3f1, eng: 0xc9ced3, fin: f => f > 0.55 && f < 0.68 ? 0x002157 : f >= 0.68 && f < 0.76 ? 0xed2939 : undefined },
  KLM: { body: 0x00a1de, belly: 0xf3f3f1, line: -0.35, tail: 0x00a1de, eng: 0x00a1de },
  CPA: { body: 0xf3f3f1, belly: 0xc9ced3, line: -0.3, tail: 0x006564, eng: 0xc9ced3, fin: (f, h) => f > 0.4 && f < 0.8 && Math.abs(h - 0.45 - (f - 0.6) * 0.5) < 0.07 ? 0xf3f3f1 : undefined },   // Cathay: the brushwing
  SIA: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0x1d2a5b, eng: 0xc9ced3, fin: (f, h) => ring(f, h, 0.55, 0.45) < 0.16 ? 0xf2b411 : undefined },   // Singapore: the bird
  JAL: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0xf3f3f1, eng: 0xc9ced3, fin: (f, h) => ring(f, h, 0.55, 0.5) < 0.24 ? 0xcc0000 : undefined },   // JAL: the crane circle
  ANA: { body: 0xf3f3f1, belly: 0x13448f, line: -0.3, tail: 0xf3f3f1, eng: 0x13448f, fin: (f, h) => h < 0.22 ? 0x13448f : undefined },
  KAL: { body: 0x8ccbe8, belly: 0xc9ced3, line: -0.1, tail: 0xf3f3f1, eng: 0x8ccbe8, fin: (f, h) => ring(f, h, 0.55, 0.5) < 0.2 ? (h > 0.5 ? 0xcd2e3a : 0x0047a0) : undefined },   // Korean: the taegeuk
  QFA: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0xe0001b, eng: 0xc9ced3, fin: (f, h) => ring(f, h, 0.58, 0.45) < 0.14 ? 0xf3f3f1 : undefined },   // Qantas: the kangaroo
  EVA: { body: 0xf3f3f1, belly: 0x00684d, line: -0.3, tail: 0x00684d, eng: 0x00684d, fin: (f, h) => f > 0.5 && h > 0.55 ? 0xf2a900 : undefined },
  CAL: { body: 0xf3f3f1, belly: 0xd7d9dc, line: -0.35, tail: 0xf3f3f1, eng: 0xc9ced3, fin: (f, h) => ring(f, h, 0.55, 0.5) < 0.24 ? 0xe2477a : undefined },   // China Airlines: the plum blossom
  THY: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0xc70a0c, eng: 0xc9ced3, fin: (f, h) => ring(f, h, 0.55, 0.5) < 0.18 ? 0xf3f3f1 : undefined },
  EIN: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0x006272, eng: 0x006272, fin: (f, h) => ring(f, h, 0.55, 0.5) < 0.13 ? 0x8bc63f : undefined },   // Aer Lingus: the shamrock
  VIR: { body: 0xd9dde1, belly: 0xd9dde1, tail: 0xda0530, eng: 0xda0530 },
  ANZ: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0x151515, eng: 0x151515, fin: (f, h) => ring(f, h, 0.55, 0.5) < 0.17 ? 0xf3f3f1 : undefined },   // Air New Zealand: the koru
  QTR: { body: 0xd8dbe0, belly: 0xd8dbe0, tail: 0x5c0632, eng: 0x5c0632 },
  ETD: { body: 0xe8e2d8, belly: 0xe8e2d8, tail: 0xb9975b, eng: 0xb9975b },
  AMX: { body: 0xf3f3f1, belly: 0x0b2343, line: -0.3, tail: 0x0b2343, eng: 0x0b2343 },
  WJA: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0x00a7b5, eng: 0x00a7b5 },
  QXE: { body: 0xf3f3f1, belly: 0xf3f3f1, tail: 0x0b2e59, tail2: 0x00a9ce, eng: 0x0b2e59 },   // (Horizon: flying as Alaska)
});
LIVERY.UAL.fin = LIVERY.SKW.fin = (f, h) => ring(f, h, 0.42, 0.32) < 0.3 ? 0xa9c3ea : undefined;   // United's globe, low on her tail
LIVERY.DAL.fin = (f, h) => f < 0.5 && h < 0.45 ? 0x0b2d5e : undefined;   // Delta's widget, red over blue
const PLAIN = { body: 0xf1f2f3, belly: 0xd4d8dc, line: -0.35, tail: 0x8d9aa7, tail2: 0xb9c3cc, eng: 0xc4c9ce };
const DARK = 0x1b2026, WING = 0xc9ced3, GEAR = 0x3b4046, TYRE = 0x16181a;

export const airlinerKnown = type => !!T[type];
let shared = null;   // one material for all of them: the colours are in the geometry
// (double-sided: the left wing and tailplane are the right's mirror images, inside out)
// (round 4, against a United Express E175 on final at LAX: glossy paint, a sun highlight along her; round 3: a little
// light in her shadows, a wing's underside was black)
const mat = () => { if (!shared) { shared = new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: 0x262626, specular: 0x4a4a4a, shininess: 48 }); shared.userData.shared = true; } return shared; };
const BRIGHT = 1.45;   // (the colours a little over 1, so under the app's tone mapping (ACES at 0.55) white stays white: as Caltrain's, v1107)

export function makeAirliner(type, flight = '', { gear = false } = {}) {
  const spec = T[type]; if (!spec) return null;
  const [L, span, D, eng, deck] = spec, R = D / 2, wide = D > 4.5, liv = LIVERY[(flight || '').slice(0, 3)] || PLAIN;
  const parts = [], col = new THREE.Color(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
  // a geometry in one colour (or coloured per vertex by fn(x, y, z)), moved into place
  // (round 4: each part keeps its own smooth normals; merged and recomputed, every face was flat, the round fuselage
  // and nacelles faceted. k: a light's brightness, far over 1)
  const add = (g, c, at = null, fn = null, k = BRIGHT) => {
    if (!g.attributes.normal) g.computeVertexNormals();
    if (at) g.applyMatrix4(at);
    const gg = g.index ? g.toNonIndexed() : g, p = gg.attributes.position, n = p.count, cs = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col.setHex(fn ? fn(p.getX(i), p.getY(i), p.getZ(i)) : c); cs[i * 3] = col.r * k; cs[i * 3 + 1] = col.g * k; cs[i * 3 + 2] = col.b * k; }
    gg.setAttribute('color', new THREE.BufferAttribute(cs, 3)); parts.push(gg); if (gg !== g) g.dispose();
  };
  const place = (x, y, z, rx = 0, ry = 0, rz = 0) => m4.clone().compose(new THREE.Vector3(x, y, z), q.setFromEuler(e.set(rx, ry, rz, 'YXZ')), one);
  const z0 = -L / 2;   // her nose
  // ── the fuselage: radius along her (a rounded nose, the parallel cabin, the tail cone), swept up beneath at the tail
  const NOSE = 0.11, CONE = wide ? 0.6 : 0.62;   // (round 2: a longer, pointed nose)
  // (f clamped: a vertex's f, worked back from its position, can be −1e-16 at the nose tip, and a fractional power of
  // a negative number is NaN: it was, for a third of the types)
  const rAt = f => { f = Math.min(1, Math.max(0, f)); return f < NOSE ? R * Math.max(0, 1 - ((NOSE - f) / NOSE) ** 1.7) ** 0.6 * 0.97 + R * 0.03 : f <= CONE ? R : R * (1 - 0.86 * ((f - CONE) / (1 - CONE)) ** 1.25); };
  const prof = []; for (let k = 0; k <= 60; k++) { const f = k / 60; prof.push(new THREE.Vector2(Math.max(0.02, rAt(f)), f * L)); }
  const fus = new THREE.LatheGeometry(prof, 28);   // round the y axis: y is along her, nose at y = 0
  fus.rotateX(Math.PI / 2); fus.translate(0, 0, z0);   // (y → +z: nose at −L/2)
  { const p = fus.attributes.position;   // the tail cone's axis rises as it narrows (top nearly level, belly sweeping up); the nose droops a little
    for (let i = 0; i < p.count; i++) { const f = (p.getZ(i) - z0) / L, r = rAt(f); p.setY(i, p.getY(i) + (f > CONE ? (R - r) * 0.78 : f < NOSE ? -(R - r) * 0.32 : 0)); }
    if (/^(E1|E2|E7)/.test(type)) for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * 1.1);   // (an E-jet's 'double bubble': 3.35 m tall, 3.0 wide)
    if (deck === 'dd') for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * 1.18);   // (the A380: two full decks, 8.4 m tall, 7.1 wide)
    if (deck === 'hump') for (let i = 0; i < p.count; i++) {   // (the 747: her upper deck, a hump over her first third)
      const f = (p.getZ(i) - z0) / L, y = p.getY(i), up = Math.min(1, Math.max(0, (f - 0.03) / 0.1)) * (1 - Math.min(1, Math.max(0, (f - (type === 'B748' ? 0.33 : 0.29)) / 0.08)));
      if (y > 0) p.setY(i, y + R * 0.5 * up * (y / R)); }   // (~8.1 m tall at her upper deck, as hers)
    fus.computeVertexNormals(); }
  const line = (liv.line ?? -0.3) * R, tailF = CONE + 0.05;
  add(fus, 0, null, (x, y, z) => {
    const f = (z - z0) / L;
    if (f < 0.058 && f > 0.033 && y > R * 0.3 && y < R * 0.6 && Math.abs(x) < R * 0.7) return DARK;   // the cockpit windows: a band high on her nose (round 5: they read as a mask)
    if (liv.top && y > R * 0.55 && f < 0.7) return liv.top;
    if (liv.accent && y < -R * 0.35 && f > 0.45) return f > 0.62 ? liv.accent[1] : liv.accent[0];   // (Southwest's belly stripes; Alaska's swoosh)
    return y < line ? liv.belly : liv.body;
  });
  // the wing-to-body fairing (round 5, against the E175 and the 737 three-view): a long, flattened bulge under her
  // where her wings join, in her belly's colour
  { const fz = z0 + L * (eng === 'rear' ? 0.43 : 0.37) + span * 0.11, fair = new THREE.SphereGeometry(1, 20, 12); fair.scale(R * 0.95, R * 0.45, span * (eng === 'rear' ? 0.14 : 0.17));
    add(fair, liv.belly ?? liv.body, place(0, -R * 0.72, fz)); }
  // the cabin windows along each side, door to door: a 737's or an A320's every 0.51 m; an E-jet's, a CRJ's or an
  // A220's big and 0.8 m apart (round 4: the E175's were tiny 737 dashes)
  // (v1113: a business jet's, bigger still, a metre apart, along her cabin only)
  const biz = eng === 'rear' && !/^(CRJ|B712)/.test(type), big = biz || /^(E1|E2|E7|CRJ|BCS)/.test(type);
  const wp = biz ? 0.95 : big ? 0.8 : wide ? 0.53 : 0.51, wh = biz ? 0.4 : big ? 0.42 : wide ? 0.36 : 0.32, ww = biz ? 0.34 : big ? 0.32 : wide ? 0.26 : 0.23;
  const rows = biz ? [[0.3, 0.975, 0.2, 0.6]] : deck === 'dd' ? [[0, 0.975, 0.14, 0.82], [0.73, 0.765, 0.13, 0.8]] : deck === 'hump' ? [[0.3, 0.975, 0.14, 0.82], [1.12, 0.66, 0.14, type === 'B748' ? 0.31 : 0.27]] : [[0.3, 0.975, 0.14, wide ? 0.82 : 0.84]];   // [height, out, from, to] × R, L
  for (const [hy, out, fa, fb] of rows) for (let z = z0 + L * fa; z < z0 + L * fb; z += wp) for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(ww / 2, ww / 2, 0.04, 10).scale(wh / ww, 1, 1).rotateZ(Math.PI / 2), DARK, place(sx * R * out, R * hy, z));
  // ── the wings: a swept trapezoid with thickness, low on her, rising to the tips (dihedral), with winglets
  const semi = span / 2, rootZ = z0 + L * (eng === 'rear' ? 0.43 : 0.37), rootC = span * (eng === 'rear' ? 0.17 : 0.22), tipC = rootC * 0.18, sweep = (wide ? 31 : 26) * Math.PI / 180, dih = (eng === 'rear' ? 3 : 6) * Math.PI / 180;
  const wingY = -R * 0.55, foil = (s, c0, c1, zLE, len, t, kink = 0) => {   // a surface's planform [span x, along z] at y = 0, t thick
    // (round 3: an airliner's wing trailing edge runs straight out to a kink a third of the way, then sweeps back)
    const pts = [[0, 0], [len, Math.tan(s) * len], [len, Math.tan(s) * len + c1]];
    if (kink) pts.push([len * kink, c0]); pts.push([0, c0]);
    const sh = new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b)));
    const g = new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false }); g.rotateX(Math.PI / 2); g.translate(0, t / 2, zLE); return g;
  };
  for (const sx of [-1, 1]) {
    const w = foil(sweep, rootC, tipC, rootZ, semi - R * 0.8, Math.max(0.25, rootC * 0.07), eng === 'rear' ? 0 : 0.33);
    if (sx < 0) w.scale(-1, 1, 1);
    const wingAt = place(sx * R * 0.8, wingY, 0, 0, 0, sx * dih), len = semi - R * 0.8;
    add(w, WING, wingAt.clone());
    // the flaps, down for landing: behind the trailing edge, inboard to the kink and outboard to three quarters of
    // the way (round 4: the E175 on final)
    if (gear) {
      const kx = eng === 'rear' ? 0 : len * 0.33, teZ = x => x <= kx ? rootZ + rootC : rootZ + rootC + (x - kx) / (len - kx) * (Math.tan(sweep) * len + tipC - rootC);
      for (const [xa, xb] of [[0.15, kx || len * 0.33], [kx || len * 0.33, len * 0.74]]) {
        const za = teZ(xa), zb = teZ(xb), segL = Math.hypot(xb - xa, zb - za), cf = (zb > za ? rootC * 0.2 : rootC * 0.22), fl = new THREE.BoxGeometry(segL, 0.1, cf);
        fl.translate(0, 0, cf / 2); fl.rotateX(0.42); fl.rotateY(-Math.atan2(zb - za, xb - xa)); fl.translate((xa + xb) / 2, -0.05, (za + zb) / 2);
        if (sx < 0) fl.scale(-1, 1, 1);
        add(fl, WING, wingAt.clone());
      }
    }
    // the winglet, up and canted out at her tip
    const tipX = sx * (R * 0.8 + (semi - R * 0.8) * Math.cos(dih)), tipY = wingY + (semi - R * 0.8) * Math.sin(dih), tipZ = rootZ + Math.tan(sweep) * (semi - R * 0.8);
    add(new THREE.BoxGeometry(0.07, span * 0.065, tipC * 0.75), liv.tail, place(tipX + sx * 0.12, tipY + span * 0.032, tipZ + tipC * 0.7, 0, 0, -sx * 0.22));
    // her lights: red at her left wingtip, green at her right; landing lights in the wing roots with the gear down
    add(new THREE.SphereGeometry(0.16, 8, 6), sx < 0 ? 0xff2a2a : 0x2aff5a, place(tipX, tipY + 0.05, tipZ + 0.2), null, 3.2);
    if (gear) add(new THREE.SphereGeometry(0.22, 8, 6), 0xfffbe8, place(sx * R * 1.35, wingY - 0.1, rootZ + 0.35), null, 4.5);
  }
  // ── the engines: nacelles under and ahead of the wing (two, or four), or on the tail for the regional jets
  const engR = D * (wide ? 0.31 : eng === 'rear' ? 0.23 : 0.27), engL = engR * 3.3;   // (round 2: a 737's nacelle is ~2 m across, half her fuselage; round 1 had it half that)
  const nacelle = (x, y, zFront, pylon) => {
    const n = new THREE.CylinderGeometry(engR * 0.92, engR, engL, 20, 1, false); n.rotateX(Math.PI / 2);
    add(n, liv.eng, place(x, y, zFront + engL / 2));
    const inlet = new THREE.CircleGeometry(engR * 0.86, 20); inlet.rotateY(Math.PI); add(inlet, DARK, place(x, y, zFront - 0.02));
    const core = new THREE.CylinderGeometry(engR * 0.45, engR * 0.25, engL * 0.35, 12); core.rotateX(Math.PI / 2); add(core, 0x5d646b, place(x, y, zFront + engL + engL * 0.15));
    if (pylon) add(new THREE.BoxGeometry(0.3, pylon.h, engL * 0.8), WING, place(x, y + pylon.y, zFront + engL * 0.55));
  };
  if (eng === 'rear') for (const sx of [-1, 1]) nacelle(sx * (R + engR * 1.15), R * 0.35, z0 + L * 0.7, null);
  else {
    const ats = eng === 4 ? [0.36, 0.66] : [wide ? 0.31 : 0.26];
    for (const at of ats) for (const sx of [-1, 1]) {
      const s = R * 0.8 + (semi - R * 0.8) * at, x = sx * s, y = wingY + (s - R * 0.8) * Math.tan(dih) - engR * 1.05, zLE = rootZ + Math.tan(sweep) * (s - R * 0.8);
      nacelle(x, y, zLE - engL * 0.55, { y: engR * 0.9, h: engR * 0.9 });
    }
  }
  // ── the tail: the fin (her airline's colours, a second colour up its trailing half), the tailplane
  const finH = R * (wide ? 3.2 : 3.6), finRoot = L * 0.165, finTip = finRoot * 0.3, finSweep = 41 * Math.PI / 180, finZ = z0 + L * 0.745, topY = R * 0.78;   // (round 2: swept 41°, her tip at ~95% of her length)
  const finLE = Math.tan(finSweep) * finH, fin = new THREE.Shape([[0, 0], [finRoot, 0], [finLE + finTip, finH], [finLE, finH]].map(([a, b]) => new THREE.Vector2(a, b)));
  // (round 6: a fine grid on each face, not an extrusion's few big triangles, so a tail's bands and circles come out
  // crisp: on the extrusion every second colour was a smear)
  const fy0 = topY + R * 0.1, ft = Math.max(0.25, finRoot * 0.05), NI = 18, NJ = 22, chordAt = u => finRoot + (finTip - finRoot) * u;
  for (const sx of [-1, 1]) {
    const pos = [], idx = [];
    for (let i = 0; i <= NI; i++) for (let j = 0; j <= NJ; j++) { const u = i / NI, v = j / NJ; pos.push(sx * ft / 2, fy0 + u * finH, finZ + u * finLE + v * chordAt(u)); }
    for (let i = 0; i < NI; i++) for (let j = 0; j < NJ; j++) { const a = i * (NJ + 1) + j, b = a + NJ + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    add(g, 0, null, (x, y, z) => { const h = (y - fy0) / finH, f = (z - finZ - h * finLE) / chordAt(h);
      if (liv.fin) return liv.fin(f, h) ?? liv.tail;
      if (liv.tail3 && h > 0.15 && h < 0.3) return liv.tail3;
      return liv.tail2 && (f * chordAt(h) / finRoot > 0.45 || (liv === LIVERY.SWA && h < 0.2)) ? liv.tail2 : liv.tail; });
  }
  // red beacons on her back and belly, a white light at her tail
  add(new THREE.SphereGeometry(0.15, 8, 6), 0xff3020, place(0, R * 1.0, z0 + L * 0.5), null, 3.2);
  add(new THREE.SphereGeometry(0.15, 8, 6), 0xff3020, place(0, -R * 1.0, z0 + L * 0.45), null, 3.2);
  add(new THREE.SphereGeometry(0.12, 8, 6), 0xffffff, place(0, R * 0.55, -z0 - 0.05), null, 3.0);
  const tailT = eng === 'rear', hsY = tailT ? topY + R * 0.1 + finH * 0.97 : topY - R * 0.15, hsZ = tailT ? finZ + finLE * 0.95 : z0 + L * 0.825;   // (round 5: her tailplane's tip ends about level with her tail, not past it)
  for (const sx of [-1, 1]) {
    const h = foil(30 * Math.PI / 180, L * 0.085, L * 0.035, hsZ, span * 0.18, 0.18);
    if (sx < 0) h.scale(-1, 1, 1);
    add(h, tailT ? liv.tail : WING, place(sx * (tailT ? 0.15 : R * 0.35), hsY, 0, 0, 0, sx * (tailT ? 0 : 7 * Math.PI / 180)));
  }
  // ── the gear, down on the ground and on the way in: the nose leg and the mains under the wing
  if (gear) {
    const legH = R * 0.75 + (wide ? 1.0 : 0.45), wheel = (x, z, r) => { const t = new THREE.CylinderGeometry(r, r, r * 0.8, 12); t.rotateZ(Math.PI / 2); add(t, TYRE, place(x, -R - legH, z)); };
    add(new THREE.CylinderGeometry(0.09, 0.09, legH, 6), GEAR, place(0, -R - legH / 2 + 0.15, z0 + L * 0.1)); wheel(0.16, z0 + L * 0.1, 0.36); wheel(-0.16, z0 + L * 0.1, 0.36);
    const mz = rootZ + rootC * 0.72;
    for (const sx of [-1, 1]) { const x = sx * R * (wide ? 1.1 : 0.85); add(new THREE.CylinderGeometry(0.13, 0.13, legH, 6), GEAR, place(x, -R - legH / 2 + 0.2, mz)); wheel(x + sx * 0.3, mz, wide ? 0.62 : 0.55); wheel(x - sx * 0.05, mz, wide ? 0.62 : 0.55); }
  }
  // all of her as one mesh
  let n = 0; for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), cols = new Float32Array(n * 3); let o = 0;
  for (const g of parts) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); cols.set(g.attributes.color.array, o * 3); o += g.attributes.position.count; g.dispose(); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const group = new THREE.Group(); group.add(new THREE.Mesh(geo, mat()));
  // (drop: her centre over the bottom of her wheels, with the gear down: to sit her on the ground, v1111)
  return { group, L, cockpit: [0, R * 0.35, z0 + L * 0.04 - 0.6], drop: gear ? R + R * 0.75 + (wide ? 1.0 : 0.45) + (wide ? 0.62 : 0.55) : R };
}
