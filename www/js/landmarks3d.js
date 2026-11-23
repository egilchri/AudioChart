// Landmarks modelled by hand over their measured footprints (v1205, for the Brooklyn-to-the-Met tour video, asked: "I
// expect we'll want to recursively improve the look of the MET"). A building in a town's file with `lm` set is drawn
// here instead of as a plain block of windows (terrain3d.js buildTown). Round 1 of the Met: limestone, the Fifth Avenue
// front's central pavilion (Richard Morris Hunt's, 1902: three great arches between paired Corinthian columns, the
// uncarved blocks over them, the cornice), its banners, the steps down to the avenue, and the two fountains.
import * as THREE from 'three';

const mat = (rgb, extra = {}) => new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace), ...extra });

// a local frame on a facade: o = its middle at the ground (world x, z), along = the bearing (degrees, 0 = north) the
// facade runs, out = 90° to the right of it, toward the street. Local (u along, v up from y0, w out) → world.
function frame(ox, oz, along, y0) {
  const a = along * Math.PI / 180, o = a + Math.PI / 2;
  const ux = Math.sin(a), uz = -Math.cos(a), nx = Math.sin(o), nz = -Math.cos(o);
  const at = (u, v, w) => new THREE.Vector3(ox + ux * u + nx * w, y0 + v, oz + uz * u + nz * w);
  const yaw = Math.atan2(nx, nz);   // rotation about y that turns a model's +z to face out
  return { at, yaw };
}
// a box of size (du along, dv up, dw out) centred at local (u, v + dv/2, w)
function box(F, g, m, u, v, w, du, dv, dw) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(du, dv, dw), m);
  b.position.copy(F.at(u, v + dv / 2, w)); b.rotation.y = F.yaw; g.add(b); return b;
}

const pointIn = (P, x, z) => { let k = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) k = !k; } return k; };

function buildMet(b, wx, wz) {
  const g = new THREE.Group(); g.name = 'The Metropolitan Museum of Art';
  const G = b.g ?? 26, stone = mat([224, 214, 194]), stoneD = mat([200, 190, 170]), roofM = mat([140, 140, 134]);
  const dark = mat([38, 36, 40]), glass = mat([70, 78, 84]), water = mat([120, 160, 180]), spray = mat([235, 240, 245], { transparent: true, opacity: 0.7 });
  // the body: the footprint, extruded to its measured roof
  const P = b.p.map(([lo, la]) => [wx(lo), wz(la)]);
  const shape = new THREE.Shape(P.map(([x, z]) => new THREE.Vector2(x, -z)));
  const body = new THREE.ExtrudeGeometry(shape, { depth: b.r + 3, bevelEnabled: false }); body.rotateX(-Math.PI / 2); body.translate(0, G - 3, 0);
  g.add(new THREE.Mesh(body, [roofM, stone]));   // (ExtrudeGeometry's groups: 0 the caps, 1 the sides)
  // the Fifth Avenue front at 82nd Street, facing the avenue (it runs 29° east of north)
  const L = b.front; if (!L) return g;
  const Fe = frame(wx(L[0]), wz(L[1]), 29, G);   // along north-northeast, so out is 119°: toward the avenue
  const W = 58, Hp = 33, proj = 4.5, plat = 3;   // the pavilion: width, height, how far it stands out, the entrance platform's rise
  // (round 2) the wings along the avenue: the footprint's edges that face it, each with a base, a cornice, and tall
  // windows between pilasters at the main floor and shorter ones over them, all of it clear of the pavilion
  {
    const n = [Math.sin(119 * Math.PI / 180), -Math.cos(119 * Math.PI / 180)], top = b.r, C = Fe.at(0, 0, 0);
    for (let i = 0; i < P.length; i++) {
      const [ax, az] = P[i], [bx, bz] = P[(i + 1) % P.length], L = Math.hypot(bx - ax, bz - az); if (L < 6) continue;
      const ex = (bx - ax) / L, ez = (bz - az) / L; if (Math.abs(ex * n[0] + ez * n[1]) > 0.1) continue;   // (running along the avenue)
      // facing it: just outside the edge is outside the footprint, and the edge is on the avenue side of the building
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (pointIn(P, mx + n[0] * 1.5, mz + n[1] * 1.5) || !pointIn(P, mx - n[0] * 1.5, mz - n[1] * 1.5)) continue;
      if ((mx - C.x) * n[0] + (mz - C.z) * n[1] < -60) continue;   // (the inner courts' walls)
      const yaw = Math.atan2(n[0], n[1]);
      const put = (m, s, d, v, dv, w, du) => { const k = new THREE.Mesh(new THREE.BoxGeometry(du, dv, w), m); k.position.set(ax + ex * s + n[0] * d, G + v + dv / 2, az + ez * s + n[1] * d); k.rotation.y = yaw; g.add(k); };
      const along = s => { const x = ax + ex * s, z = az + ez * s; return Math.abs((x - C.x) * Math.sin(29 * Math.PI / 180) + (z - C.z) * -Math.cos(29 * Math.PI / 180)); };
      const segs = []; for (let s = 0; s <= L; s += 0.5) segs.push(along(s) > W / 2 + 1);
      if (!segs.some(Boolean)) continue;
      put(stoneD, L / 2, 0.4, -1, 2.6, 0.8, L); put(stoneD, L / 2, 0.5, top - 1.6, 1.2, 1.0, L + 0.6);   // base, cornice
      for (let s = 3.5; s < L - 2.5; s += 7) {
        if (along(s) < W / 2 + 4) continue;
        put(glass, s, 0.04, 4.5, 8.5, 0.1, 2.6); put(glass, s, 0.04, 16, 4.5, 0.1, 2.2);   // main floor, over it
        put(stone, s + 3.5, 0.3, 1.6, top - 3.4, 0.6, 1.3);   // pilaster
      }
    }
  }
  box(Fe, g, stone, 0, -3, proj / 2, W, Hp + 3, proj);   // the pavilion's block
  box(Fe, g, stoneD, 0, Hp - 3.2, proj + 0.6, W + 1.2, 1.4, 1.6);   // the cornice
  box(Fe, g, stoneD, 0, plat + 15.2, proj + 0.4, W, 2.2, 1.2);   // the entablature over the columns
  // three great arched windows: dark, recessed, round-topped
  for (const u of [-14.5, 0, 14.5]) {
    const r = 4.2, s = new THREE.Shape();
    s.moveTo(-r, 0); s.lineTo(r, 0); s.lineTo(r, 9.5); s.absarc(0, 9.5, r, 0, Math.PI, false); s.lineTo(-r, 0);
    const m = new THREE.Mesh(new THREE.ShapeGeometry(s, 16), glass);
    m.position.copy(Fe.at(u, plat + 0.3, proj + 0.03)); m.rotation.y = Fe.yaw; g.add(m);
    box(Fe, g, dark, u, plat, proj - 0.5, 4.6, 5.5, 1.2);   // the doors, deep in the arch
    // the banner hung in front of it (the exhibitions')
    const bc = [[178, 34, 52], [32, 72, 140], [212, 160, 40]][Math.round(u / 14.5) + 1];
    box(Fe, g, mat(bc), u, plat + 4, proj + 1.6, 3.2, 10, 0.1);
  }
  // four pairs of Corinthian columns, on pedestals, and the uncarved blocks over each pair
  const colG = new THREE.CylinderGeometry(0.7, 0.8, 13.6, 16);
  for (const u0 of [-21.8, -7.3, 7.3, 21.8]) {
    box(Fe, g, stoneD, u0, plat, proj + 1.1, 4.6, 1.6, 2.6);   // pedestal
    for (const du of [-1.15, 1.15]) {
      const c = new THREE.Mesh(colG, stone); c.position.copy(Fe.at(u0 + du, plat + 1.6 + 6.8, proj + 1.1)); g.add(c);
      box(Fe, g, stoneD, u0 + du, plat + 1.6 + 13.6 - 0.9, proj + 1.1, 2.0, 0.9, 2.0);   // capital
    }
    box(Fe, g, stone, u0, plat + 17.4, proj + 1.1, 4.4, 4.2, 2.6);   // the block meant for sculpture, never carved
  }
  // the steps: from the sidewalk up to the platform, the width of the pavilion and more
  const SW = 66, SD = 15, n = 12;
  for (let i = 0; i < n; i++) box(Fe, g, stoneD, 0, -1, proj + SD - (i + 0.5) * SD / n, SW - i * 0.6, 1 + (i + 1) * plat / n, SD / n + 0.02);
  box(Fe, g, stoneD, 0, -1, proj + 1.2, W, 1 + plat, 2.4);   // the platform
  // the fountains, either side of the steps (the plaza's, 2014)
  for (const u of [-48, 48]) {
    box(Fe, g, stoneD, u, -0.4, 13, 22, 1.1, 8);
    box(Fe, g, water, u, 0.72, 13, 21, 0.02, 7);
    for (let k = -3; k <= 3; k++) { const j = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.25, 2.2, 6), spray); j.position.copy(Fe.at(u + k * 2.6, 1.8, 13)); g.add(j); }
  }
  return g;
}

const BUILDERS = { met: buildMet };
export function buildLandmark(b, wx, wz) { const f = BUILDERS[b.lm]; return f ? f(b, wx, wz) : null; }
