// Small planes and helicopters as they are (v1113, requested from a Side view of N383AC, an Aeronca Champ, drawn as a
// tube and three boxes: "recursively improve the side view of this airplane, others like it"). Over SF on a weekday
// a quarter of the aircraft are Cessna 172s, with 150/152s, Cirruses, Cherokees, Champs, Bonanzas, twins and
// helicopters among them. Five families, each drawn in metres against its reference type's side view and scaled to
// the type ADS-B reports:
//   hw: high wing, strut-braced (Cessna 150/152/172/182/206/208, the Champ and Citabria, the Cub), tricycle or tailwheel
//   lw: low wing singles (Cherokee/Warrior/Arrow, Cirrus, Bonanza (the V-tail too), Mooney, Diamond, Malibu, RV)
//   tw: light twins (Twin Comanche, Seneca, Baron, Duchess, 310/421, DA42, King Air)
//   heli: helicopters (JetRanger, 407, MD 500, R22/R44, AStar, H130/H135, A109)
// A fuselage is lofted from side-view stations [z, top, bottom, half-width, squareness]; its windows and stripes
// are laid on her sides (projected onto the loft), her registration painted on her aft fuselage. Her propeller (or
// rotor) turns: group.userData.spin. makeLightPlane(type, reg, { gear, cat }) → { group, L, cockpit, drop, pitch }
// or null. Metres; nose to −z; origin on her centreline at mid-length.
import * as THREE from 'three';

const BRIGHT = 1.45;   // (as airliner3d.js: colours a little over 1 under the app's tone mapping)
const GLASS = 0x26313c, HGLASS = 0x2c3a48, DARK = 0x1c2127, TYRE = 0x16181a, STRUT = 0xd4d8dc, PROP = 0x26292c;
let shared = null; const discMats = {};
const mat = () => { if (!shared) { shared = new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: 0x262626, specular: 0x4a4a4a, shininess: 48 }); shared.userData.shared = true; } return shared; };
const disc = (op = 0.14) => { if (!discMats[op]) { const m = discMats[op] = new THREE.MeshBasicMaterial({ color: 0x3a3d40, transparent: true, opacity: op, side: THREE.DoubleSide, depthWrite: false }); m.userData.shared = true; } return discMats[op]; };

// ICAO type → [family, reference, length m, span m, options]
// options: tail (tailwheel), retract, ttail, vtail, blades, pants (wheel fairings), long (a turbine's long nose), fen (fenestron)
const TYPES = {
  C150: ['hw', 'c172', 7.3, 10.1, { pants: 0 }], C152: ['hw', 'c172', 7.3, 10.1, { pants: 1 }], C172: ['hw', 'c172', 8.28, 11.0, { pants: 1 }],
  C72R: ['hw', 'c172', 8.28, 11.0, { retract: 1 }], C182: ['hw', 'c172', 8.84, 11.0, { pants: 1, blades: 3 }], C82R: ['hw', 'c172', 8.84, 11.0, { retract: 1, blades: 3 }],
  C206: ['hw', 'c172', 8.6, 11.0, { blades: 3 }], C207: ['hw', 'c172', 9.8, 11.0, { blades: 3 }], C208: ['hw', 'c172', 11.46, 15.88, { blades: 3, long: 1 }],
  C177: ['hw', 'c172', 8.4, 10.8, { pants: 1 }], C170: ['hw', 'c172', 7.6, 11.0, { tail: 1 }], C180: ['hw', 'c172', 7.8, 10.9, { tail: 1 }], C185: ['hw', 'c172', 7.85, 10.9, { tail: 1, blades: 3 }],
  CH7A: ['hw', 'champ', 6.6, 10.7, { tail: 1 }], CH7B: ['hw', 'champ', 6.9, 10.2, { tail: 1 }], BL8: ['hw', 'champ', 6.9, 9.8, { tail: 1 }], AR11: ['hw', 'champ', 6.6, 10.7, { tail: 1 }],
  J3: ['hw', 'champ', 6.8, 10.7, { tail: 1 }], PA18: ['hw', 'champ', 6.88, 10.73, { tail: 1 }], PA12: ['hw', 'champ', 6.8, 10.8, { tail: 1 }], PA22: ['hw', 'champ', 6.3, 9.1, {}],
  CUB: ['hw', 'champ', 7.0, 10.7, { tail: 1 }], CC19: ['hw', 'champ', 7.0, 10.7, { tail: 1 }], X5: ['hw', 'champ', 7.0, 10.7, { tail: 1 }],
  P28A: ['lw', 'p28', 7.25, 10.67, { pants: 1 }], P28B: ['lw', 'p28', 7.3, 10.67, { pants: 1 }], P28R: ['lw', 'p28', 7.5, 10.8, { retract: 1 }], P28T: ['lw', 'p28', 8.2, 10.8, { retract: 1, ttail: 1 }],
  P32R: ['lw', 'p28', 8.4, 11.0, { retract: 1, blades: 3 }], PA32: ['lw', 'p28', 8.4, 11.0, { pants: 1, blades: 3 }], PA24: ['lw', 'p28', 7.6, 11.0, { retract: 1 }], PA38: ['lw', 'p28', 7.0, 10.4, { ttail: 1 }],
  PA46: ['lw', 'p28', 8.8, 13.1, { retract: 1, blades: 3 }], P46T: ['lw', 'p28', 9.0, 13.1, { retract: 1, blades: 4, long: 1 }],
  SR20: ['lw', 'sr', 7.92, 11.68, { pants: 1, blades: 3 }], SR22: ['lw', 'sr', 7.92, 11.68, { pants: 1, blades: 3 }], S22T: ['lw', 'sr', 7.92, 11.68, { pants: 1, blades: 3 }],
  BE33: ['lw', 'p28', 7.8, 10.2, { retract: 1 }], BE35: ['lw', 'p28', 8.13, 10.2, { retract: 1, vtail: 1 }], BE36: ['lw', 'p28', 8.38, 10.2, { retract: 1, blades: 3 }],
  M20P: ['lw', 'p28', 7.6, 11.0, { retract: 1 }], M20T: ['lw', 'p28', 8.1, 11.0, { retract: 1, blades: 3 }], DA40: ['lw', 'sr', 8.0, 11.9, { pants: 1, ttail: 1 }],
  RV6: ['lw', 'p28', 6.1, 7.0, { pants: 1, tail: 1 }], RV7: ['lw', 'p28', 6.2, 7.6, { pants: 1, tail: 1 }], RV8: ['lw', 'p28', 6.3, 7.3, { pants: 1, tail: 1 }], RV9: ['lw', 'p28', 6.2, 8.5, { pants: 1 }],
  RV10: ['lw', 'p28', 7.4, 9.7, { pants: 1, blades: 3 }], RV12: ['lw', 'p28', 6.2, 8.1, { pants: 1 }], RV14: ['lw', 'p28', 6.4, 8.4, { pants: 1 }], CRUZ: ['lw', 'sr', 6.6, 8.6, { pants: 1 }],
  T34T: ['lw', 'p28', 8.75, 10.0, { retract: 1, blades: 3 }], T34P: ['lw', 'p28', 7.9, 10.0, { retract: 1 }], TBM9: ['lw', 'sr', 10.7, 12.8, { retract: 1, blades: 5, long: 1 }],
  TBM7: ['lw', 'sr', 10.6, 12.7, { retract: 1, blades: 4, long: 1 }], PC12: ['lw', 'sr', 14.4, 16.3, { retract: 1, blades: 4, long: 1, ttail: 1 }], C210: ['hw', 'c172', 8.6, 11.2, { retract: 1, blades: 3 }],
  PA30: ['tw', 'be58', 7.67, 10.97, { retract: 1 }], PA34: ['tw', 'be58', 8.72, 11.85, { retract: 1 }], PA44: ['tw', 'be58', 8.4, 11.8, { retract: 1, ttail: 1 }], PA31: ['tw', 'be58', 9.9, 12.4, { retract: 1, blades: 3 }],
  BE55: ['tw', 'be58', 8.5, 11.5, { retract: 1 }], BE58: ['tw', 'be58', 9.09, 11.53, { retract: 1, blades: 3 }], BE76: ['tw', 'be58', 8.9, 11.6, { retract: 1, ttail: 1 }],
  C310: ['tw', 'be58', 9.74, 11.25, { retract: 1, blades: 3 }], C340: ['tw', 'be58', 10.5, 11.6, { retract: 1, blades: 3 }], C414: ['tw', 'be58', 11.1, 13.45, { retract: 1, blades: 3 }], C421: ['tw', 'be58', 11.1, 12.5, { retract: 1, blades: 3 }],
  DA42: ['tw', 'be58', 8.56, 13.42, { retract: 1, ttail: 1, blades: 3 }], DA62: ['tw', 'be58', 9.2, 14.6, { retract: 1, ttail: 1, blades: 3 }],
  BE9L: ['tw', 'be58', 10.8, 15.3, { retract: 1, blades: 3, long: 1 }], BE20: ['tw', 'be58', 13.36, 16.61, { retract: 1, blades: 4, long: 1, ttail: 1 }], B350: ['tw', 'be58', 14.2, 17.65, { retract: 1, blades: 4, long: 1, ttail: 1 }],
  P180: ['tw', 'be58', 14.4, 14.0, { retract: 1, blades: 5, long: 1, ttail: 1 }],
  B06: ['heli', 'b06', 9.5, 10.16, { blades: 2 }], B06T: ['heli', 'b06', 9.5, 10.16, { blades: 2 }], B407: ['heli', 'b06', 10.6, 10.67, { blades: 4 }], B505: ['heli', 'b06', 9.6, 11.3, { blades: 3 }],
  H500: ['heli', 'h500', 7.0, 8.05, { blades: 5 }], R22: ['heli', 'r44', 6.3, 7.67, { blades: 2 }], R44: ['heli', 'r44', 8.96, 10.06, { blades: 2 }], R66: ['heli', 'r44', 9.4, 10.06, { blades: 2 }],
  AS50: ['heli', 'b06', 10.93, 10.69, { blades: 3, trR: 1 }], AS55: ['heli', 'b06', 10.93, 10.69, { blades: 3, trR: 1 }], EC30: ['heli', 'b06', 10.7, 10.69, { blades: 3, fen: 1 }],
  EC35: ['heli', 'b06', 10.2, 10.2, { blades: 4, fen: 1 }], EC45: ['heli', 'b06', 13.0, 11.0, { blades: 4 }], A109: ['heli', 'b06', 11.4, 11.0, { blades: 4 }], S76: ['heli', 'b06', 13.2, 13.4, { blades: 4 }],
  B429: ['heli', 'b06', 12.7, 10.98, { blades: 4 }], A119: ['heli', 'b06', 11.1, 10.83, { blades: 4 }],
};
export const lightKnown = type => !!TYPES[type];

// a window with rounded corners, [z, y] round it
function rr(z0, y0, z1, y1, r, n = 4) {
  const p = [], c = [[z1 - r, y1 - r, 0], [z0 + r, y1 - r, 1], [z0 + r, y0 + r, 2], [z1 - r, y0 + r, 3]];
  for (const [cz, cy, q] of c) for (let k = 0; k <= n; k++) { const a = (q + k / n) * Math.PI / 2; p.push([cz + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return p;
}
// ── the references: side-view stations [z from her nose, top, bottom, half-width, squareness] in metres, and where
// her wing, tail, gear, windows and stripes go. (Shaped against the Cessna 172, Aeronca 7AC Champ, Piper PA-28,
// Cirrus SR22, Beech 58 Baron and Bell 206 three-views and photos.)
const REF = {
  c172: {
    L: 8.28, prop: { z: 0.24, y: 0.04, r: 0.95, spin: 0.21 }, cowl: 1.3,
    st: [[0.30, 0.24, -0.15, 0.2, 2.2], [0.5, 0.33, -0.3, 0.36, 2.3], [0.85, 0.37, -0.43, 0.45, 2.5], [1.3, 0.4, -0.5, 0.5, 2.7], [1.56, 0.43, -0.54, 0.54, 3],
      [2.18, 0.8, -0.55, 0.56, 3.2], [3.3, 0.81, -0.55, 0.56, 3.2], [3.75, 0.73, -0.49, 0.52, 2.9], [4.6, 0.61, -0.33, 0.4, 2.6], [5.6, 0.48, -0.15, 0.27, 2.4],
      [6.6, 0.37, 0.0, 0.16, 2.3], [7.4, 0.29, 0.1, 0.08, 2.2], [7.78, 0.25, 0.14, 0.03, 2]],
    shield: [1.6, 2.15, 0.44], wing: { high: 1, y: 0.82, le: 1.95, root: 1.63, tip: 1.12, taper: 0.45, dih: 1.7, t: 0.13 },
    strut: [[[2.45, -0.42], [2.25, 0.55]]],   // [fuselage z, y] → [wing z, fraction of her semispan]
    fin: { z: 6.4, y: 0.3, h: 1.15, root: 1.88, tip: 0.75, sweep: 1.05, dorsal: [5.0, 0.52] }, hs: { z: 7.0, y: 0.2, semi: 1.73, root: 1.25, tip: 0.95, sweep: 0.2 },
    gear: { nose: [0.95, -1.12, 0.2], main: [3.35, -1.12, 1.25, 0.22], legFrom: [3.15, -0.52, 0.45] },
    win: [[[1.86, 0.12], [2.16, 0.74], [2.8, 0.77], [2.8, 0.12]], [[2.88, 0.12], [2.88, 0.77], [3.4, 0.75], [3.72, 0.66], [3.92, 0.48], [3.9, 0.3], [3.7, 0.12]]],
    stripe: [[0.55, -0.06], [7.5, 0.16]], reg: [4.5, 6.0, 0.24],
    cockpit: [-0.26, 0.5, 2.45],
  },
  champ: {
    L: 6.6, prop: { z: 0.16, y: 0.03, r: 0.9, spin: 0.12 }, cowl: 1.2,
    st: [[0.22, 0.2, -0.15, 0.17, 2], [0.42, 0.32, -0.3, 0.33, 2.1], [0.85, 0.38, -0.4, 0.38, 2.3], [1.2, 0.4, -0.45, 0.38, 2.6], [1.72, 0.8, -0.48, 0.38, 3.2],
      [3.0, 0.8, -0.45, 0.37, 3.2], [3.4, 0.62, -0.37, 0.32, 2.8], [4.3, 0.45, -0.22, 0.24, 2.6], [5.4, 0.32, -0.05, 0.14, 2.4], [6.15, 0.24, 0.06, 0.06, 2.2], [6.4, 0.22, 0.1, 0.02, 2]],
    shield: [1.24, 1.7, 0.42], wing: { high: 1, y: 0.8, le: 1.5, root: 1.6, tip: 1.6, taper: 1, dih: 1, t: 0.12, round: 1 },
    strut: [[[2.0, -0.4], [1.72, 0.56]], [[2.0, -0.4], [2.62, 0.56]]],
    fin: { z: 5.5, y: 0.24, h: 1.02, root: 1.1, tip: 0.0, sweep: 0, round: 1 }, hs: { z: 5.72, y: 0.16, semi: 1.6, root: 0.95, tip: 0.95, sweep: 0, round: 1 },
    gear: { tail: [6.1, 0.3], main: [1.05, -1.06, 0.95, 0.25], legFrom: [[0.85, -0.44, 0.3], [1.45, -0.44, 0.3]] },
    win: [[[1.5, 0.06], [1.76, 0.72], [2.92, 0.75], [3.28, 0.52], [3.28, 0.06]]],
    stripe: [[0.4, -0.1], [6.2, 0.1]], reg: [3.45, 4.85, 0.17], cockpit: [0, 0.42, 1.95],
  },
  p28: {
    L: 7.25, prop: { z: 0.22, y: 0.03, r: 0.94, spin: 0.2 }, cowl: 1.25,
    st: [[0.28, 0.21, -0.15, 0.2, 2.2], [0.55, 0.3, -0.33, 0.38, 2.4], [1.2, 0.34, -0.42, 0.5, 2.6], [1.45, 0.38, -0.44, 0.55, 2.8], [2.05, 0.76, -0.44, 0.57, 3],
      [3.0, 0.77, -0.42, 0.57, 3], [3.55, 0.62, -0.36, 0.52, 2.8], [4.5, 0.46, -0.24, 0.38, 2.6], [5.6, 0.34, -0.1, 0.24, 2.4], [6.5, 0.27, 0.0, 0.13, 2.2], [7.1, 0.24, 0.06, 0.04, 2]],
    shield: [1.48, 2.02, 0.4], wing: { y: -0.3, le: 1.55, root: 1.6, tip: 1.07, taper: 0.5, dih: 7, t: 0.15 },
    fin: { z: 5.75, y: 0.28, h: 0.88, root: 1.35, tip: 0.65, sweep: 0.75, dorsal: [4.7, 0.44] }, hs: { z: 6.15, y: 0.12, semi: 1.83, root: 0.76, tip: 0.76, sweep: 0 },
    gear: { nose: [0.85, -0.97, 0.19], main: [2.55, -0.97, 1.6, 0.2] },
    win: [[[1.86, 0.06], [2.06, 0.68], [2.84, 0.7], [2.84, 0.06]], [[2.94, 0.06], [2.94, 0.7], [3.45, 0.61], [3.78, 0.26], [3.62, 0.06]]],
    stripe: [[0.5, -0.12], [7.0, 0.12]], reg: [3.95, 5.25, 0.22], cockpit: [-0.27, 0.42, 2.35],
  },
  sr: {
    L: 7.92, prop: { z: 0.26, y: 0.06, r: 0.98, spin: 0.24 }, cowl: 1.5,
    st: [[0.32, 0.27, -0.15, 0.23, 2.2], [0.65, 0.36, -0.32, 0.4, 2.4], [1.45, 0.42, -0.44, 0.53, 2.6], [1.72, 0.47, -0.46, 0.57, 2.8], [2.45, 0.86, -0.46, 0.62, 2.8],
      [3.2, 0.88, -0.44, 0.62, 2.8], [3.9, 0.74, -0.37, 0.55, 2.6], [5.0, 0.52, -0.2, 0.38, 2.4], [6.2, 0.36, -0.02, 0.22, 2.2], [7.1, 0.28, 0.08, 0.1, 2.1], [7.6, 0.25, 0.12, 0.03, 2]],
    shield: [1.75, 2.42, 0.47], wing: { y: -0.3, le: 1.95, root: 1.55, tip: 0.85, taper: 0, dih: 4.5, t: 0.15 },
    fin: { z: 6.5, y: 0.3, h: 1.05, root: 1.35, tip: 0.7, sweep: 0.9, dorsal: [5.5, 0.46] }, hs: { z: 6.9, y: 0.16, semi: 1.75, root: 0.85, tip: 0.6, sweep: 0.2 },
    gear: { nose: [0.95, -1.0, 0.2], main: [2.95, -1.0, 1.7, 0.21] },
    win: [[[2.2, 0.08], [2.42, 0.78], [3.25, 0.82], [3.3, 0.08]], [[3.4, 0.1], [3.4, 0.8], [3.9, 0.7], [4.3, 0.3], [4.1, 0.1]]],
    stripe: [[0.6, -0.15], [7.5, 0.13]], reg: [4.8, 6.4, 0.24], cockpit: [-0.3, 0.5, 2.8],
  },
  be58: {
    L: 9.09, nose: 1, prop: { z: 1.7, y: -0.25, r: 0.98, spin: 0.2, x: 1.85 },
    st: [[0.02, 0.06, 0.0, 0.02, 2], [0.35, 0.18, -0.18, 0.22, 2.1], [0.9, 0.3, -0.36, 0.38, 2.3], [1.6, 0.38, -0.46, 0.52, 2.6], [1.95, 0.42, -0.48, 0.56, 2.8],
      [2.6, 0.8, -0.5, 0.6, 3], [4.1, 0.8, -0.48, 0.6, 3], [4.7, 0.64, -0.4, 0.52, 2.8], [5.8, 0.48, -0.25, 0.36, 2.6], [7.2, 0.34, -0.06, 0.2, 2.4], [8.4, 0.26, 0.06, 0.08, 2.2], [8.9, 0.24, 0.1, 0.03, 2]],
    shield: [1.97, 2.56, 0.44], wing: { y: -0.33, le: 2.65, root: 2.1, tip: 1.1, taper: 0, dih: 6, t: 0.15 },
    nacelle: { x: 1.85, z0: 1.85, z1: 5.2, r: 0.34 },
    fin: { z: 7.25, y: 0.28, h: 1.3, root: 1.65, tip: 0.8, sweep: 0.9, dorsal: [6.0, 0.46] }, hs: { z: 7.85, y: 0.14, semi: 2.0, root: 0.95, tip: 0.7, sweep: 0.15 },
    gear: { nose: [1.1, -1.12, 0.19], main: [3.55, -1.12, 1.85, 0.24] },
    win: [[[2.3, 0.08], [2.55, 0.74], [3.25, 0.77], [3.25, 0.08]], [[3.35, 0.08], [3.35, 0.77], [3.95, 0.77], [3.95, 0.08]], [[4.05, 0.1], [4.05, 0.74], [4.6, 0.62], [4.6, 0.1]]],
    stripe: [[0.3, -0.12], [8.7, 0.14]], reg: [5.5, 7.2, 0.24], cockpit: [-0.28, 0.48, 2.9],
  },
  // (helicopters, round 2 against the Bell 206B's three-view: 2.91 m to her rotor head, her floor ~0.5 m over the
  // ground on her skids, her cowling over her roof to the exhaust)
  b06: {
    L: 9.5, st: [[0.0, 0.25, -0.15, 0.05, 2], [0.22, 0.66, -0.45, 0.42, 2], [0.8, 0.98, -0.62, 0.62, 2.2], [1.8, 1.04, -0.62, 0.66, 2.5], [2.7, 0.98, -0.55, 0.62, 2.5],
      [3.25, 0.86, -0.3, 0.47, 2.3], [3.6, 0.72, -0.02, 0.3, 2.2], [4.1, 0.58, 0.14, 0.2, 2.1], [8.8, 0.42, 0.24, 0.09, 2], [9.0, 0.4, 0.27, 0.05, 2]],
    shield: [0.0, 1.0, -0.42], glass: { z0: 0.03, z1: 0.98, lo0: -0.12, lo1: 0.12, c0: 0.12, c1: 0.78, cb: 0.2 },
    cowl: [[1.2, 0.98, 0.18], [1.55, 1.24, 0.4], [2.0, 1.32, 0.45], [2.9, 1.3, 0.42], [3.4, 1.12, 0.3], [3.8, 0.82, 0.14]], exhaust: [3.3, 1.2],
    mast: [1.95, 1.72], rotorR: 5.08, chord: 0.33,
    fin: { z: 8.35, y: 0.35, h: 1.0, root: 0.75, tip: 0.45, sweep: 0.45, under: 0.55 }, hs: { z: 6.4, y: 0.42, semi: 0.95, root: 0.45, tip: 0.4, sweep: 0, plates: 1 },
    trotor: { z: 8.7, y: 1.05, r: 0.82 }, skid: { y: -1.1, x: 1.0, z0: -0.1, z1: 3.3, cross: [0.9, 2.7] },
    win: [rr(0.98, -0.12, 1.72, 0.86, 0.12), rr(1.86, -0.08, 2.56, 0.84, 0.12)],
    stripe: [[0.1, -0.25], [8.9, 0.32]], reg: [4.3, 6.1, 0.36], cockpit: [-0.3, 0.45, 0.85],
  },
};
REF.h500 = { ...REF.b06, L: 7.0, st: [[0.0, 0.3, -0.1, 0.05, 2], [0.25, 0.85, -0.5, 0.5, 2], [0.9, 1.15, -0.62, 0.7, 2.1], [1.8, 1.15, -0.6, 0.7, 2.2], [2.5, 0.95, -0.35, 0.55, 2.1],
  [3.0, 0.62, 0.1, 0.22, 2], [6.3, 0.48, 0.3, 0.08, 2], [6.5, 0.46, 0.33, 0.05, 2]], shield: [0.0, 1.1, -0.45], glass: { z0: 0.03, z1: 1.0, lo0: -0.18, lo1: 0.08, c0: 0.1, c1: 0.85, cb: 0.18 },
  cowl: [[1.15, 1.1, 0.18], [1.45, 1.26, 0.32], [2.05, 1.28, 0.34], [2.55, 1.08, 0.24], [2.9, 0.78, 0.1]], exhaust: [2.6, 1.0],
  mast: [1.6, 1.58], rotorR: 4.02, chord: 0.17, fin: { z: 6.0, y: 0.4, h: 0.85, root: 0.6, tip: 0.35, sweep: 0.4, under: 0.5 }, hs: { z: 6.0, y: 0.95, semi: 0.6, root: 0.35, tip: 0.3, sweep: 0 },
  trotor: { z: 6.4, y: 0.6, r: 0.66 }, skid: { y: -1.05, x: 0.95, z0: 0.0, z1: 2.9, cross: [0.8, 2.3] },
  win: [rr(1.06, -0.3, 1.78, 0.98, 0.14)], stripe: [[0.2, -0.25], [6.4, 0.38]], reg: [3.1, 4.6, 0.45], cockpit: [-0.3, 0.45, 0.8] };
REF.r44 = { ...REF.b06, L: 8.96, st: [[0.0, 0.3, -0.15, 0.05, 2], [0.25, 0.75, -0.48, 0.45, 2], [0.85, 1.08, -0.6, 0.62, 2.1], [1.75, 1.08, -0.55, 0.62, 2.3], [2.4, 0.95, -0.4, 0.5, 2.2],
  [2.9, 0.8, 0.0, 0.3, 2], [3.3, 0.7, 0.45, 0.1, 2], [8.5, 0.6, 0.48, 0.05, 2], [8.7, 0.6, 0.5, 0.03, 2]], shield: [0.0, 1.25, -0.45], glass: { z0: 0.03, z1: 1.02, lo0: -0.22, lo1: 0.02, c0: 0.08, c1: 0.85, cb: 0.16 },
  cowl: [[1.55, 1.02, 0.14], [1.8, 1.32, 0.18], [2.15, 1.38, 0.2], [2.7, 1.12, 0.2], [3.1, 0.82, 0.08]], exhaust: null,
  mast: [1.95, 2.02], rotorR: 5.03, chord: 0.25, fin: { z: 8.1, y: 0.55, h: 0.75, root: 0.55, tip: 0.35, sweep: 0.35, under: 0.6 }, hs: { z: 8.1, y: 0.55, semi: 0.0, root: 0.3, tip: 0.3, sweep: 0 },
  trotor: { z: 8.6, y: 0.7, r: 0.74 }, skid: { y: -1.15, x: 1.05, z0: 0.05, z1: 3.0, cross: [0.7, 2.4] },
  win: [rr(1.08, -0.25, 1.72, 0.94, 0.14)], stripe: [[0.3, -0.3], [3.0, 0.25]], reg: [3.0, 4.4, 0.62], cockpit: [-0.3, 0.45, 0.75] };

// her paint, from her registration: white with two stripes, mostly; a Champ yellow, red or white; a helicopter's darker
const PAIRS = [[0x1f3f8f, 0x6f9ad8], [0x9b1c1c, 0xd9a33a], [0x6b1f2a, 0xc0a062], [0x2f6b3a, 0xc8b04a], [0x222222, 0xb32020], [0x1f6f9f, 0x1f3f5f], [0xc85a1a, 0x7a2a10], [0x8a8f96, 0x2a4f8a]];
const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
function livery(ref, reg) {
  const h = hash(reg), [a, b] = PAIRS[h % PAIRS.length], WHITE = 0xf3f3f1;
  if (ref === 'champ') return [{ body: 0xf0bf2a, s1: 0xb3201e, s2: 0x1a1a1a, text: 0x1a1a1a }, { body: 0xb8201e, s1: WHITE, s2: 0x1a1a1a, text: WHITE }, { body: WHITE, s1: 0xb3201e, s2: 0xb3201e, text: 0xb3201e }, { body: 0xf0bf2a, s1: 0x1a1a1a, s2: 0x1a1a1a, text: 0x1a1a1a }][(h >>> 4) % 4];
  if (ref === 'b06' || ref === 'h500' || ref === 'r44') { const bodies = [WHITE, WHITE, 0x1b2a4a, 0x9b1c1c, 0x1a1a1a, 0xf0bf2a, 0x2f6b3a]; const body = bodies[(h >>> 4) % bodies.length]; return { body, s1: body === WHITE ? a : WHITE, s2: body === WHITE ? b : 0xc0a062, text: body === WHITE || body === 0xf0bf2a ? 0x1a1a1a : WHITE }; }   // (dark lettering on white or yellow)
  return { body: WHITE, s1: a, s2: b, text: a };
}

// ── shapes
// a monotone interpolant through [x, y] points (no overshoot between stations)
function curve(xs, ys) {
  const n = xs.length, d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : 3 * (d[i - 1] + d[i]) / (2 / d[i] * d[i - 1] + d[i - 1] / d[i] + 4) || (d[i - 1] + d[i]) / 2;
  for (let i = 1; i < n - 1; i++) if (d[i - 1] * d[i] > 0) m[i] = 2 / (1 / d[i - 1] + 1 / d[i]);
  return x => {
    if (x <= xs[0]) return ys[0]; if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
// a fuselage lofted through side-view stations: superellipse sections, round (2) to boxy (3+)
function loft(st, nz = 96, ns = 48, extra = []) {
  const zs = st.map(s => s[0]), T = curve(zs, st.map(s => s[1])), B = curve(zs, st.map(s => s[2])), W = curve(zs, st.map(s => s[3])), N = curve(zs, st.map(s => s[4]));
  const z0 = zs[0], z1 = zs[zs.length - 1], pos = [], idx = [];
  const sgnpow = (v, p) => Math.sign(v) * Math.abs(v) ** p;
  // her rings: a little closer at her ends, and one each side of any edge she's painted along (her windscreen's: round
  // 4's colour ran between two rings in teeth)
  const zz = []; for (let k = 0; k <= nz; k++) { const u = k / nz; zz.push(z0 + (z1 - z0) * (1 - Math.cos(u * Math.PI)) / 2 * 0.25 + (z1 - z0) * u * 0.75); }
  for (const x of extra) zz.push(x - 0.004, x + 0.004); zz.sort((a, b) => a - b); nz = zz.length - 1;
  for (let k = 0; k <= nz; k++) {
    const z = zz[k];
    const t = T(z), b = B(z), w = Math.max(0.004, W(z)), n = N(z), cy = (t + b) / 2, hh = Math.max(0.004, (t - b) / 2);
    for (let j = 0; j <= ns; j++) { const a = j / ns * Math.PI * 2; pos.push(w * sgnpow(Math.cos(a), 2 / n), cy + hh * sgnpow(Math.sin(a), 2 / n), z); }
  }
  for (let k = 0; k < nz; k++) for (let j = 0; j < ns; j++) { const a = k * (ns + 1) + j, b = a + ns + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  // her half-width at (z, y) on her surface: for laying windows and paint on her side
  const xAt = (z, y) => { const t = T(z), b = B(z), w = W(z), n = N(z), hh = (t - b) / 2, v = Math.min(1, Math.abs((y - (t + b) / 2) / hh)); return w * (1 - v ** n) ** (1 / n); };
  // a point on her at z, angle a round her (0 her right side, π/2 her top), pushed out by off
  const at = (z, a, off = 0) => { const t = T(z), b = B(z), w = Math.max(0.004, W(z)), n = N(z), cy = (t + b) / 2, hh = Math.max(0.004, (t - b) / 2), c = Math.cos(a), sn = Math.sin(a);
    const x = w * sgnpow(c, 2 / n), y = hh * sgnpow(sn, 2 / n), l = Math.hypot(x / w, y / hh) || 1; return [x + off * c, cy + y + off * sn]; };
  // the angle round her at which her surface is at height y (her right side, 0 … π/2)
  const angAt = (z, y) => { const t = T(z), b = B(z), n = N(z), v = Math.max(-1, Math.min(1, (y - (t + b) / 2) / ((t - b) / 2))); return Math.asin(sgnpow(v, n / 2)); };
  return { g, T, B, W, xAt, at, angAt, z0, z1 };
}
// a NACA 4-digit section, TE → upper → LE → lower → TE, as [x/c, y/c]
function section(t, m = 0.02, p = 0.4, n = 14) {
  const up = [], lo = [];
  for (let i = 0; i <= n; i++) {
    const x = (1 - Math.cos(i / n * Math.PI)) / 2, yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const yc = m ? (x < p ? m / p / p * (2 * p * x - x * x) : m / (1 - p) ** 2 * (1 - 2 * p + 2 * p * x - x * x)) : 0;
    up.push([x, yc + yt]); lo.push([x, yc - yt]);
  }
  return [...up.reverse(), ...lo.slice(1)];
}
// a flying surface along +x (span), its leading edge at z = le(u), chord ch(u), height y(u), u 0 at her root … 1 at her tip; capped
function surface(span, le, ch, y, t, { m = 0.02, n = 24 } = {}) {
  const sec = section(t, m), ns = sec.length, pos = [], idx = [];
  for (let i = 0; i <= n; i++) { const u = i / n, c = Math.max(0.01, ch(u)), z = le(u), yy = y(u); for (const [a, b] of sec) pos.push(u * span, yy + b * c, z + a * c); }
  for (let i = 0; i < n; i++) for (let j = 0; j < ns - 1; j++) { const a = i * ns + j, b = a + ns; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  for (const [i, flip] of [[0, true], [n, false]]) {   // the ends: a fan from the section's middle
    const c0 = pos.length / 3; let cx = 0, cy = 0, cz = 0; for (let j = 0; j < ns; j++) { cx += pos[(i * ns + j) * 3]; cy += pos[(i * ns + j) * 3 + 1]; cz += pos[(i * ns + j) * 3 + 2]; }
    pos.push(cx / ns, cy / ns, cz / ns);
    for (let j = 0; j < ns - 1; j++) flip ? idx.push(c0, i * ns + j + 1, i * ns + j) : idx.push(c0, i * ns + j, i * ns + j + 1);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
// a mirror image, wound the right way round (or, double-sided, she's lit from inside: her left wing was black)
const mirror = g => { g.scale(-1, 1, 1); const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.computeVertexNormals(); return g; };
const roundTip = (c, u, k = 0.3) => u < 1 - k ? c : c * Math.sqrt(Math.max(0.02, 1 - ((u - (1 - k)) / k) ** 2));

export function makeLightPlane(type, reg = '', { gear = false, cat = '' } = {}) {
  let spec = TYPES[type];
  if (!spec) spec = cat === 'A7' ? ['heli', 'b06', 9.5, 10.16, { blades: 2 }] : cat === 'A1' ? TYPES.C172 : null;   // (a type we don't know: a 172, or a JetRanger)
  if (!spec) return null;
  const [fam, refName, L, span, o] = spec, R = REF[refName], s = L / R.L, liv = livery(refName, reg || type);
  const parts = [], col = new THREE.Color(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), V = (x, y, z) => new THREE.Vector3(x, y, z);
  const add = (g, c, at = null, fn = null, k = BRIGHT) => {
    if (!g.attributes.normal) g.computeVertexNormals();
    if (at) g.applyMatrix4(at);
    // (her undersides a little brighter, as the sunlit ground and water light them: round 5's low wings, seen from
    // beside her, were near-black slabs)
    const p = g.attributes.position, nr = g.attributes.normal, cs = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { col.setHex(fn ? fn(p.getX(i), p.getY(i), p.getZ(i)) : c); const u = Math.max(0, -nr.getY(i)), kk = k * (1 + 1.1 * u); cs[i * 3] = col.r * kk * (1 + 0.3 * u); cs[i * 3 + 1] = col.g * kk; cs[i * 3 + 2] = col.b * kk * (1 + 0.22 * u); }   // (and less green: the hemisphere's ground light is)
    g.setAttribute('color', new THREE.BufferAttribute(cs, 3)); for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(a)) g.deleteAttribute(a);
    parts.push(g);
  };
  const place = (x, y, z, rx = 0, ry = 0, rz = 0) => m4.clone().compose(V(x, y, z), q.setFromEuler(e.set(rx, ry, rz, 'YXZ')), V(1, 1, 1));
  const rod = (a, b, r, c) => {   // a strut or leg from a to b
    const d = b.clone().sub(a), g = new THREE.CylinderGeometry(r, r, d.length(), 8);
    add(g, c, m4.clone().compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize()), V(1, 1, 1)));
  };
  const ball = (x, y, z, sx, sy, sz, c, k) => add(new THREE.SphereGeometry(1, 18, 12).scale(sx, sy, sz), c, place(x, y, z), null, k);
  const wheel = (x, y, z, r, pant) => {
    add(new THREE.CylinderGeometry(r, r, r * 0.62, 16).rotateZ(Math.PI / 2), TYRE, place(x, y, z));
    if (pant) {   // a wheel fairing, her body's colour: a teardrop, round ahead, drawn out to a point behind (round 3: an egg)
      const pr = []; for (let k = 0; k <= 16; k++) { const t = k / 16, rr = t < 0.35 ? Math.sqrt(1 - ((0.35 - t) / 0.35) ** 2) : 1 - ((t - 0.35) / 0.65) ** 1.6 * 0.92; pr.push(new THREE.Vector2(Math.max(0.01, rr), t)); }
      const g = new THREE.LatheGeometry(pr, 16); g.scale(r * 0.6, r * 4.4, r * 1.05); g.rotateX(Math.PI / 2); add(g, liv.body, place(x, y + r * 0.18, z - r * 1.45));
    }
  };
  const semi = span / 2 / s;   // (her span, in her reference's metres)

  // ── her fuselage, painted: the windscreen (glass where she slopes up to her roof), her body colour
  const [w0, w1, wy] = R.shield, F = loft(R.st, 96, 48, [w0, w1]);
  const heli = fam === 'heli';
  add(F.g, liv.body);
  // her windscreen: a panel laid over her, from her cowl up over her roof (a helicopter's, round her nose below her
  // roof): its own grid, so its edges are clean (round 4's, painted on her own rings, had teeth)
  // (a panel from her side at height lo(z) up to hi(z), or with no hi up over her top, to a gap either side of her middle)
  const panel = (z0, z1, lo, hi, gap = 0) => {
    const NZ = 24, NA = 30, pos = [], idx = [];
    for (const side of [1, -1]) {
      const base = pos.length / 3;
      for (let i = 0; i <= NZ; i++) {
        const z = z0 + (z1 - z0) * i / NZ, a0 = F.angAt(z, lo(z)), a1 = hi ? F.angAt(z, Math.max(lo(z) + 0.02, hi(z))) : Math.PI / 2 - gap;
        for (let j = 0; j <= NA; j++) { let a = a0 + (a1 - a0) * j / NA; if (side < 0) a = Math.PI - a; const [x, y] = F.at(z, a, 0.012); pos.push(x, y, z); }
      }
      for (let i = 0; i < NZ; i++) for (let j = 0; j < NA; j++) { const a = base + i * (NA + 1) + j, b = a + NA + 1; side < 0 ? idx.push(a, b, a + 1, a + 1, b, b + 1) : idx.push(a, a + 1, b, a + 1, b + 1, b); }   // (wound to face out on both sides)
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); add(g, heli ? HGLASS : GLASS);
  };
  if (!heli) panel(w0, w1, z => wy - (z - w0) * 0.05, null);
  else {   // a helicopter's bubble: over her nose with a frame down its middle, its foot rising to her doors; her chin windows below it
    const G = R.glass, lo = z => G.lo0 + (G.lo1 - G.lo0) * (z - G.z0) / (G.z1 - G.z0);
    panel(G.z0, G.z1, lo, null, 0.035);
    panel(G.c0, G.c1, z => F.B(z) + G.cb, z => lo(z) - 0.07);
  }
  // her side windows and stripes, laid on her sides
  const decal = (poly, c, off = 0.008, sides = [-1, 1]) => {
    const pts = []; for (let i = 0; i < poly.length; i++) {   // (each edge cut into short lengths, so she bends with her)
      const [a, b] = [poly[i], poly[(i + 1) % poly.length]], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1));
      for (let k = 0; k < n; k++) pts.push(new THREE.Vector2(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n));
    }
    // (and each triangle cut small, every corner of it laid on her: a big flat one cut inside her curved side, and
    // round 1's windows and stripes showed only round their edges)
    const tris = [], cut = (a, b, c, d = 0) => {
      if (d > 6 || Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) < 0.07) { tris.push(a, b, c); return; }
      const ab = a.clone().add(b).multiplyScalar(0.5), bc = b.clone().add(c).multiplyScalar(0.5), ca = c.clone().add(a).multiplyScalar(0.5);
      cut(a, ab, ca, d + 1); cut(ab, b, bc, d + 1); cut(ca, bc, c, d + 1); cut(ab, bc, ca, d + 1);
    };
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(pts, [])) cut(pts[i], pts[j], pts[k]);
    for (const sx of sides) {
      const pos = []; for (const p of tris) pos.push(sx * (F.xAt(p.x, p.y) + off + 0.006), p.y, p.x);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); add(g, c);
    }
  };
  for (const w of R.win) decal(w, GLASS);
  { const [[za, ya], [zb, yb]] = R.stripe, at = z => ya + (yb - ya) * (z - za) / (zb - za), band = (lo, hi, z0 = za, z1 = zb) => {   // (two bands, rising aft, behind her windows)
      // (kept on her side, within her depth: round 5's ran off a helicopter's tail boom)
      const top = [], bot = [], fit = (z, y) => Math.max(F.B(z) + 0.25 * (F.T(z) - F.B(z)), Math.min(F.T(z) - 0.25 * (F.T(z) - F.B(z)), y));
      for (let k = 0; k <= 24; k++) { const z = z0 + (z1 - z0) * k / 24; top.push([z, fit(z, at(z) + hi)]); bot.unshift([z, fit(z, at(z) + lo) - 0.001]); }
      return [...top, ...bot]; };
    const z0 = heli ? R.win[0][0][0] - 0.05 : za;
    decal(band(0.02, 0.11, z0), liv.s1, 0.004); decal(band(-0.07, -0.025, z0), liv.s2, 0.004); }

  // ── her wings: high, strut-braced, or low with dihedral
  const Wg = R.wing;
  if (Wg) {
    const dih = Wg.dih * Math.PI / 180, inner = fam === 'hw' ? 0.0 : R.st.find(x => x[0] >= Wg.le)[3] * 0.9;
    const tipLE = Wg.le + (Wg.root - Wg.tip) * (fam === 'lw' && refName === 'sr' ? 0.25 : 0.12);
    const ch = u => { const c = u < Wg.taper || Wg.taper >= 1 ? Wg.root : Wg.root + (Wg.tip - Wg.root) * (u - Wg.taper) / (1 - Wg.taper); return Wg.round ? roundTip(c, u, 0.12) : c; };
    const le = u => { const base = u < Wg.taper || Wg.taper >= 1 ? Wg.le : Wg.le + (tipLE - Wg.le) * (u - Wg.taper) / (1 - Wg.taper); return Wg.round ? base + (Wg.root - ch(u)) * 0.5 : base; };
    for (const sx of [-1, 1]) {
      const wspan = semi - inner, g = surface(wspan, le, ch, u => (Wg.high ? 0.035 * ch(u) : 0), Wg.t);
      if (sx < 0) mirror(g);
      add(g, liv.body, place(sx * inner, Wg.y + (Wg.high ? 0 : 0.06), 0, 0, 0, sx * dih), (x, y, z) => Math.abs(x) > semi * 0.93 ? liv.s1 : liv.body);   // (her wingtips in her stripe colour)
      const tip = V(sx * (inner + wspan * Math.cos(dih)), Wg.y + wspan * Math.sin(dih) + 0.05, le(1) + ch(1) * 0.3);
      add(new THREE.SphereGeometry(0.07, 8, 6), sx < 0 ? 0xff2a2a : 0x2aff5a, place(tip.x + sx * 0.04, tip.y, tip.z), null, 3.2);   // her lights: red to port, green to starboard
      for (const [[fz, fy], [wz, wu]] of R.strut || []) rod(V(sx * F.xAt(fz, fy), fy, fz), V(sx * semi * wu, Wg.y - 0.02 + semi * wu * Math.sin(dih), wz), 0.03, STRUT);
    }
    // the light twins' nacelles: her engines out on her wings, a propeller on each
    if (R.nacelle) for (const sx of [-1, 1]) {
      const { x, z0, z1, r } = R.nacelle, yN = Wg.y + 0.03 + Math.abs(x) * Math.sin(dih) - 0.05;
      const n = loft([[z0, yN + r * 0.5, yN - r * 0.4, r * 0.55, 2.1], [z0 + 0.35, yN + r, yN - r, r * 0.95, 2.2], [z0 + 1.2, yN + r * 1.05, yN - r * 1.05, r, 2.4], [z1 - 0.9, yN + r * 0.8, yN - r * 0.9, r * 0.85, 2.3], [z1, yN + r * 0.2, yN - r * 0.1, r * 0.12, 2]], 30, 20);
      add(n.g, liv.body, place(sx * x, 0, 0));
    }
  }
  // ── her tail: a fin (rounded on the Champ), a tailplane (a T-tail or a V-tail on some)
  // (a fenestron, on the Airbus types: her tail rotor in a duct at the end of her boom, her fin over it; round 1's
  // was a ring hung beside her)
  const fen = heli && o.fen ? (() => { const rf = R.trotor.r * 0.62, zc = R.fin.z + 0.25, yc = (F.T(zc) + F.B(zc)) / 2 + rf * 0.5; return { rf, zc, yc }; })() : null;
  const fin = fen ? { ...R.fin, z: fen.zc - fen.rf * 0.9, y: fen.yc + fen.rf * 1.05, h: R.fin.h * 0.7, root: fen.rf * 1.5, under: 0 } : R.fin, hs = fen ? { ...R.hs, z: fen.zc - 1.6 } : R.hs;
  if (fin) {
    const finH = o.vtail ? 0 : fin.h, chF = u => { const c = fin.root + (fin.tip - fin.root) * u; return fin.round ? Math.max(0.02, fin.root * Math.sqrt(Math.max(0, 1 - u ** 2.2))) : c; };
    const leF = u => fin.round ? fin.z + (fin.root - chF(u)) : fin.z + fin.sweep * u;
    if (finH) {
      const g = surface(finH, leF, chF, () => 0, 0.1, { m: 0 }); g.rotateZ(Math.PI / 2);   // (span along +y)
      add(g, liv.body, place(0, fin.y, 0), (x, y, z) => { const u = (y - fin.y) / finH; return u > 0.72 ? liv.s1 : u > 0.6 ? liv.s2 : liv.body; });   // (bands across her fin)
      if (fin.under) { const u2 = surface(fin.under, u => fin.z + 0.1 * u, () => fin.root * 0.8, () => 0, 0.1, { m: 0 }); u2.rotateZ(-Math.PI / 2); add(u2, liv.body, place(0, fin.y, 0)); }
      if (fin.dorsal) { const [dz, dy] = fin.dorsal, sh = new THREE.Shape([new THREE.Vector2(dz, dy - 0.06), new THREE.Vector2(fin.z + 0.25, fin.y + finH * 0.25), new THREE.Vector2(fin.z + 0.4, fin.y - 0.06)]);
        const g2 = new THREE.ExtrudeGeometry(sh, { depth: 0.05, bevelEnabled: false }); g2.rotateY(-Math.PI / 2); g2.translate(0.025, 0, 0); add(g2, liv.body); }
    }
    if (hs && hs.semi) for (const sx of [-1, 1]) {
      const v = !!o.vtail, tt = !!o.ttail, semiH = v ? hs.semi * 0.95 : hs.semi;
      const chH = u => { const c = hs.root + (hs.tip - hs.root) * u; return hs.round ? roundTip(c, u, 0.35) : c; };
      const leH = u => (tt ? fin.z + fin.sweep * 0.95 : hs.z) + hs.sweep * u + (hs.round ? (hs.root - chH(u)) * 0.5 : 0);
      const g = surface(semiH, leH, chH, () => 0, 0.09, { m: 0 }); if (sx < 0) mirror(g);
      add(g, v ? liv.body : liv.body, place(0, tt ? fin.y + fin.h * 0.97 : hs.y, 0, 0, 0, sx * (v ? 33 : tt ? 0 : 2) * Math.PI / 180));
      if (hs.plates) { const pl = surface(0.32, u => hs.z + hs.sweep + 0.05 + 0.12 * u, u => hs.tip * (1 - 0.35 * u), () => 0, 0.08, { m: 0 }); pl.rotateZ(Math.PI / 2); add(pl, liv.body, place(sx * (semiH + 0.02), hs.y - 0.14, 0)); }   // (a JetRanger's little fins at her stabiliser's tips)
    }
  }
  // ── her helicopter's parts: the engine fairing on her back, the mast, the skids
  const spin = []; let cowlTop = null;
  if (heli) {
    // her cowling over her roof (transmission and engine), lofted into her, round 1's was a lozenge sat on top; the exhaust
    const cw = R.cowl, C = loft(cw.map(([z, t, w], i) => [z, t, F.T(z) - 0.14, w, i === 0 || i === cw.length - 1 ? 2 : 2.4]), 40, 28); add(C.g, liv.body); cowlTop = C.T;
    if (R.exhaust) { const [ez, ey] = R.exhaust; add(new THREE.CylinderGeometry(0.1, 0.12, 0.26, 12), DARK, place(0, ey + 0.06, ez, 0.7)); }   // (her exhaust, raked back)
    // her mast and rotor head (round 1: a bare stick)
    const [mz, my] = R.mast, mBase = C.T(mz) - 0.05;
    add(new THREE.CylinderGeometry(0.07, 0.11, my - mBase, 10), DARK, place(0, (my + mBase) / 2, mz));
    add(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 14), 0x30353a, place(0, my - 0.02, mz));
    add(new THREE.CylinderGeometry(0.06, 0.06, 0.22, 8), 0x30353a, place(0, my + 0.13, mz));
    for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 6), STRUT, place(sx * 0.13, my - 0.12, mz + 0.05));   // (pitch links)
    // her skids, the cross tubes arched out and down to them
    const k = R.skid;
    for (const sx of [-1, 1]) {
      const skid = new THREE.CatmullRomCurve3([V(sx * k.x, k.y + 0.32, k.z0 - 0.25), V(sx * k.x, k.y + 0.05, k.z0), V(sx * k.x, k.y, k.z0 + 0.5), V(sx * k.x, k.y, k.z1)]);
      add(new THREE.TubeGeometry(skid, 16, 0.045, 6), STRUT);
      for (const cz of k.cross) { const yb = F.B(cz) + 0.06, xb = F.xAt(cz, yb) * 0.6;
        add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(sx * xb, yb, cz), V(sx * (xb + (k.x - xb) * 0.55), yb - 0.06, cz), V(sx * k.x * 0.97, (yb + k.y) / 2, cz), V(sx * k.x, k.y + 0.03, cz)]), 10, 0.04, 6), STRUT); }
    }
    if (fen) {   // the duct (round 2: a bare disc, her fin floating over it): a faired shroud from her boom up into her fin, the hole through it
      const { rf, zc, yc } = fen, Ro = rf * 1.32, sh = new THREE.Shape(), zb = zc - rf * 2.6, yb = (F.T(zb) + F.B(zb)) / 2;
      sh.moveTo(zb, yb - 0.12);   // (from her boom, under the duct, round its back and up its front into her fin, back to her boom)
      for (let k = 0; k <= 24; k++) { const a = -Math.PI * 0.62 + k / 24 * Math.PI * 1.25; sh.lineTo(zc + Ro * Math.cos(a), yc + Ro * Math.sin(a)); }
      sh.lineTo(zc - Ro * 0.55, yc + Ro * 1.02); sh.lineTo(zb, yb + 0.12); sh.closePath();
      const hole = new THREE.Path(); hole.absarc(zc, yc, rf, 0, Math.PI * 2, true); sh.holes.push(hole);
      const g = new THREE.ExtrudeGeometry(sh, { depth: 0.24, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, curveSegments: 28 });
      g.rotateY(-Math.PI / 2); g.translate(0.12, 0, 0); add(g, liv.body);
      add(new THREE.CylinderGeometry(rf, rf, 0.32, 28, 1, true).rotateZ(Math.PI / 2), 0x1a1c1e, place(0, yc, zc));   // (the duct's wall, dark)
      add(new THREE.CylinderGeometry(0.1, 0.1, 0.1, 10).rotateZ(Math.PI / 2), 0x3a3f44, place(0, yc, zc));   // (the fan's hub)
    }
  }
  // ── her gear: fixed (with fairings on many), a tailwheel on the Champ, or retracted in the air
  let bottom = 0, pitch = 0;
  const G = R.gear;
  if (G && (!o.retract || gear)) {
    let [mz, my, mx, mr] = G.main; const pants = !!o.pants && !o.retract, shift = o.tail && G.nose ? Wg.le + 0.3 - mz : 0; mz += shift;   // (a tailwheel Cessna's or RV's mains: ahead, under her wing's leading edge)
    for (const sx of [-1, 1]) {
      const axle = V(sx * mx, my, mz);
      if (G.legFrom && Array.isArray(G.legFrom[0])) for (const [lz, ly, lx] of G.legFrom) rod(V(sx * lx, ly, lz), axle, 0.03, STRUT);   // (the Champ's vee)
      else if (G.legFrom) { const [lz, ly, lx] = G.legFrom; rod(V(sx * lx, ly, lz + shift), axle.clone().add(V(-sx * 0.1, 0.05, 0)), 0.045, STRUT); }   // (a Cessna's spring-steel leg)
      else rod(V(sx * mx, Wg.y + mx * Math.sin(Wg.dih * Math.PI / 180) - 0.05, mz), axle, 0.055, STRUT);   // (a Piper's oleo, down from her wing)
      wheel(sx * mx, my, mz, mr, pants);
    }
    bottom = my - mr;
    if (G.nose && !o.tail) { const [nz, ny, nr] = G.nose; rod(V(0, F.B(nz) + 0.1, nz - 0.05), V(0, ny, nz), 0.04, STRUT); wheel(0, ny, nz, nr, pants); }
    if (o.tail || G.tail) {   // her tailwheel, and her three-point attitude on the ground: her tail down onto it
      const tz = G.tail ? G.tail[0] : R.st[R.st.length - 3][0], tr = 0.08, ty = F.B(tz);
      const th = Math.atan2(ty - 0.18 - tr - bottom, tz - mz);   // (the angle from her mains' bottom up to the tailwheel's)
      pitch = Math.max(0, th) * 180 / Math.PI;
      rod(V(0, ty + 0.02, tz - 0.05), V(0, ty - 0.18, tz + 0.08), 0.025, STRUT); wheel(0, ty - 0.18, tz + 0.08, tr, false);
    }
  }
  if (heli) bottom = R.skid.y - 0.045;
  // ── her lights: a red beacon on her fin or her back, white at her tail
  const finTop = fin && !o.vtail ? (fin.round ? [0, fin.y + fin.h * 0.97, fin.z + fin.root * 0.82] : [0, fin.y + fin.h + 0.03, fin.z + fin.sweep + Math.max(0.1, fin.tip * 0.4)]) : [0, F.T(R.L * 0.5) + 0.05, R.L * 0.5];
  add(new THREE.SphereGeometry(0.06, 8, 6), 0xff3020, place(...(heli ? [0, cowlTop(R.cowl[2][0] + 0.4) + 0.03, R.cowl[2][0] + 0.4] : finTop)), null, 3.2);
  add(new THREE.SphereGeometry(0.05, 8, 6), 0xffffff, place(0, F.T(F.z1) - 0.02, F.z1 + 0.02), null, 3.0);

  // all of her body as one mesh (indexed, merged)
  let nv = 0, ni = 0; for (const g of parts) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), cols = new Float32Array(nv * 3), ix = new Uint32Array(ni); let ov = 0, oi = 0;
  for (const g of parts) {
    const c = g.attributes.position.count; pos.set(g.attributes.position.array, ov * 3); nor.set(g.attributes.normal.array, ov * 3); cols.set(g.attributes.color.array, ov * 3);
    if (g.index) for (let i = 0; i < g.index.count; i++) ix[oi++] = g.index.array[i] + ov; else for (let i = 0; i < c; i++) ix[oi++] = i + ov;
    ov += c; g.dispose();
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); geo.setAttribute('color', new THREE.BufferAttribute(cols, 3)); geo.setIndex(new THREE.BufferAttribute(ix, 1));
  const inner = new THREE.Group(); inner.add(new THREE.Mesh(geo, mat()));

  // ── her propeller(s) or rotors: their own meshes, turning (a faint disc where the blades blur)
  const BM = mat(), bladeGeo = (len, w, t, c) => { const g = new THREE.BoxGeometry(w, len, t, 1, 10, 1); g.translate(0, len / 2, 0); const n = g.attributes.position.count, cs = new Float32Array(n * 3); col.setHex(c); for (let i = 0; i < n; i++) { cs[i * 3] = col.r * BRIGHT; cs[i * 3 + 1] = col.g * BRIGHT; cs[i * 3 + 2] = col.b * BRIGHT; } g.setAttribute('color', new THREE.BufferAttribute(cs, 3)); g.deleteAttribute('uv'); return g; };
  const tipped = (r, w, c, tipC) => { const g = bladeGeo(r, w, w * 0.18, c), p = g.attributes.position, cs = g.attributes.color; col.setHex(tipC); for (let i = 0; i < p.count; i++) if (p.getY(i) > r * 0.9) cs.setXYZ(i, col.r * BRIGHT, col.g * BRIGHT, col.b * BRIGHT); return g; };
  const rotor = (at, axis, r, blades, w, c, hub) => {
    const g = new THREE.Group(); g.position.copy(at);
    const spinG = new THREE.Group(); g.add(spinG);
    for (let i = 0; i < blades; i++) { const b = new THREE.Mesh(tipped(r, w, c, heli && axis === 'y' ? 0xd8d8d8 : blades > 6 ? c : 0xf2c230), BM);   /* (a fenestron's fan unpainted) */ b.rotation.z = i / blades * Math.PI * 2; spinG.add(b); }
    if (hub) { const sp = new THREE.Mesh(hub, BM); g.add(sp); }
    const d = new THREE.Mesh(new THREE.CircleGeometry(r, 40), disc(heli ? (axis === 'y' ? 0.06 : 0.08) : 0.14)); g.add(d);
    if (axis === 'y') { g.rotation.x = -Math.PI / 2; } else if (axis === 'x') { g.rotation.y = Math.PI / 2; }
    inner.add(g); spin.push({ o: spinG, w: heli && axis === 'y' ? 9 : 22 });
  };
  const spinner = (r, l, c) => { const pr = []; for (let k = 0; k <= 12; k++) { const t = k / 12; pr.push(new THREE.Vector2(r * Math.sqrt(1 - (1 - t) ** 2), -l * (1 - t))); } const g = new THREE.LatheGeometry(pr, 20); g.rotateX(-Math.PI / 2); g.rotateX(Math.PI); const n = g.attributes.position.count, cs = new Float32Array(n * 3); col.setHex(c); for (let i = 0; i < n; i++) { cs[i * 3] = col.r * BRIGHT; cs[i * 3 + 1] = col.g * BRIGHT; cs[i * 3 + 2] = col.b * BRIGHT; } g.setAttribute('color', new THREE.BufferAttribute(cs, 3)); g.deleteAttribute('uv'); return g; };
  if (heli) {
    rotor(V(0, R.mast[1], R.mast[0]), 'y', span / 2 / s, o.blades || 2, R.chord, PROP, null);
    if (fen) rotor(V(0, fen.yc, fen.zc), 'x', fen.rf * 0.95, 9, 0.1, PROP, null);
    else rotor(V((o.trR ? 1 : -1) * 0.32, R.trotor.y, R.trotor.z), 'x', R.trotor.r, 2, 0.14, PROP, null);   // (on her left; an AStar's on her right)
  } else if (R.prop) {
    const P = R.prop, xs = P.x ? [-P.x, P.x] : [0];
    const yP = R.nacelle ? R.wing.y + 0.03 + R.nacelle.x * Math.sin(R.wing.dih * Math.PI / 180) - 0.05 : P.y;
    for (const x of xs) rotor(V(x, yP, P.z), 'z', P.r, o.blades || 2, 0.12, PROP, spinner(P.spin, P.spin * 1.6, liv.s1 === 0xf3f3f1 ? 0xd8d8d8 : liv.s1));
  }

  // ── her registration, painted on her aft fuselage (both sides, reading left to right on each)
  const reg2 = String(reg || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (reg2 && R.reg) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 96; const x = c.getContext('2d');
    x.font = '700 84px "Helvetica Neue", Arial, sans-serif'; x.fillStyle = '#' + new THREE.Color(liv.text).getHexString(); x.textBaseline = 'middle'; x.textAlign = 'center';
    const tw = Math.min(500, x.measureText(reg2).width); x.save(); x.translate(256, 50); x.scale(Math.min(1, 500 / x.measureText(reg2).width), 1); x.fillText(reg2, 0, 0); x.restore();
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const m = new THREE.MeshPhongMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.FrontSide, emissive: 0x111111, shininess: 30 });
    const [ra, rb] = R.reg, mid = (ra + rb) / 2, wTxt = (rb - ra), h = Math.min(wTxt * 96 / 512, (F.T(rb) - F.B(rb)) * (heli ? 0.7 : 0.5));   // (no taller than half her depth at its aft end: round 3's curled over her back)
    // (on her, even where she narrows, and clear above her stripe: round 6's was maroon on maroon)
    const [[sa, ya], [sb, yb]] = R.stripe, clear = ya + (yb - ya) * (rb - sa) / (sb - sa) + 0.11 + 0.03 + h * 0.5;
    const ry = Math.max(F.B(rb) + h * 0.5 + 0.02, Math.min(F.T(rb) - h * 0.5 - 0.02, heli ? R.reg[2] : Math.max(R.reg[2], clear)));
    for (const sx of [-1, 1]) {
      const pos = [], uv = [], idx = [], n = 16;
      const NJ = 6;   // (rows up her side, each laid on her: two, and the strip's middle cut into her, round 4)
      for (let i = 0; i <= n; i++) for (let jj = 0; jj <= NJ; jj++) { const j = jj / NJ;
        const z = mid - wTxt / 2 + wTxt * i / n, y = ry + (j - 0.5) * h;
        pos.push(sx * (F.xAt(z, y) + 0.02), y, z); uv.push(sx < 0 ? i / n : 1 - i / n, j);
      }
      for (let i = 0; i < n; i++) for (let j = 0; j < NJ; j++) { const a = i * (NJ + 1) + j, c2 = a + NJ + 1; sx > 0 ? idx.push(a, a + 1, c2, c2, a + 1, c2 + 1) : idx.push(a, c2, a + 1, c2, c2 + 1, a + 1); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, m); mesh.renderOrder = 1; inner.add(mesh);
    }
  }

  inner.scale.setScalar(s); inner.position.z = -L / 2;
  const group = new THREE.Group(); group.add(inner); group.userData.spin = spin;
  const ck = R.cockpit, th = pitch * Math.PI / 180;
  // (drop: her centre over the bottom of her wheels (or skids), sat on the ground; with a tailwheel, tilted back onto it)
  const zM = (G?.main ? G.main[0] + (o.tail && G.nose ? Wg.le + 0.3 - G.main[0] : 0) : R.L / 2) - R.L / 2;
  const drop = -(bottom * Math.cos(th) - zM * Math.sin(th)) * s;
  return { group, L, cockpit: [ck[0] * s, ck[1] * s, ck[2] * s - L / 2], drop: bottom ? drop : L * 0.05, pitch, family: fam };
}
