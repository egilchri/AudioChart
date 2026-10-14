// Seagulls and seals for the 3D views (v888, requested): Bird's-eye (bay3d.js) and the helm/Drone
// view (helm3d.js). Gulls wheel in two loose flocks over wherever you're looking (one stays over
// your boat), flapping and gliding, and go to roost at night. Harbor seals haul out on the
// charted ledges that cover and uncover (hazards.geojson UWTROC, watlev 4) nearest you, a few on
// each, lifting their heads now and then, with more swimming nearby, heads up, diving and
// surfacing somewhere else. All of it is small and close: nothing is drawn more than ~2.5 km off.
import * as THREE from 'three';

const mats = new Map();
const mat = c => { if (!mats.has(c)) mats.set(c, new THREE.MeshLambertMaterial({ color: c })); return mats.get(c); };
const SPH = new THREE.SphereGeometry(1, 10, 7);
const blob = (c, sx, sy, sz, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(SPH, mat(c)); m.scale.set(sx, sy, sz); m.position.set(x, y, z); return m; };

// a herring gull, ~1.4 m across the wings, built along -z (beak); wings pivot at the shoulders
function makeGull() {
  const g = new THREE.Group();
  g.add(blob(0xf6f6f2, 0.11, 0.1, 0.3));                                   // body
  g.add(blob(0xf8f8f4, 0.075, 0.075, 0.08, 0, 0.05, -0.3));                // head
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.09, 5), mat(0xe8c040)); beak.rotation.x = -Math.PI / 2; beak.position.set(0, 0.04, -0.41); g.add(beak);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.015, 0.14), mat(0xf2f2ee)); tail.position.set(0, 0, 0.33); g.add(tail);
  const wing = side => {
    const w = new THREE.Group(); w.position.set(side * 0.08, 0.04, -0.04);
    const inner = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 0.2), mat(0xa9b0b6)); inner.position.x = side * 0.2; w.add(inner);
    const tip = new THREE.Group(); tip.position.x = side * 0.4; w.add(tip);
    const outer = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.018, 0.14), mat(0xa9b0b6)); outer.position.set(side * 0.14, 0, 0.02); tip.add(outer);
    const black = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.1), mat(0x1e2226)); black.position.set(side * 0.31, 0, 0.03); tip.add(black);
    g.add(w); return { w, tip };
  };
  return { group: g, L: wing(-1), R: wing(1) };
}

// a harbor seal, ~1.6 m, mottled grey-brown; hauled out (lying on the rock) or swimming (head only)
function makeSeal(seed) {
  const c = [0x9c9488, 0x8a8478, 0xaaa294, 0x7c766c][seed % 4];
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  body.add(blob(c, 0.3, 0.26, 0.72, 0, 0.24, 0));
  body.add(blob(c, 0.2, 0.18, 0.4, 0, 0.18, 0.62));                        // the tapering rear
  const flip = blob(c, 0.16, 0.03, 0.12, 0, 0.08, 1.02); body.add(flip);
  for (const s of [-1, 1]) body.add(blob(c, 0.1, 0.03, 0.14, s * 0.28, 0.08, -0.32));   // fore-flippers
  const head = new THREE.Group(); head.position.set(0, 0.36, -0.62); g.add(head);
  head.add(blob(c, 0.17, 0.16, 0.2));
  head.add(blob(0x3a3632, 0.08, 0.07, 0.07, 0, -0.03, -0.18));             // muzzle
  for (const s of [-1, 1]) head.add(blob(0x111111, 0.03, 0.03, 0.02, s * 0.08, 0.04, -0.15));
  return { group: g, body, head };
}

const ROCK_GEO = (() => { const geo = new THREE.DodecahedronGeometry(1, 1), p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const k = 1 + 0.18 * Math.sin(p.getX(i) * 5.1 + p.getZ(i) * 3.7); p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k); }
  geo.computeVertexNormals(); return geo; })();

/**
 * scene: the THREE scene; ledges: [[x, z], …] world positions of ledges awash.
 * update(dt, t, focus {x, z}, cam (a Vector3), opts {night, hidden, boat {x, z} | null, scale(d) → number})
 */
export function makeWildlife({ scene, ledges = [] }) {
  ledges = ledges.slice();
  let sd = 9172; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  // gulls: flock 0 follows your boat (or the view), flock 1 hangs round the nearest seal ledge
  const gulls = [];
  for (let i = 0; i < 16; i++) {
    const b = makeGull(); scene.add(b.group);
    gulls.push({ ...b, flock: i < 9 ? 0 : 1, r: 18 + rnd() * 45, h: 14 + rnd() * 26, a: rnd() * 6.28, w: (rnd() < 0.5 ? 1 : -1) * (0.16 + rnd() * 0.12), ph: rnd() * 6.28, glide: rnd() * 4, dx: (rnd() - 0.5) * 40, dz: (rnd() - 0.5) * 40 });
  }
  const anchors = [null, null];
  // seals: up to 5 ledges round you, 2-4 on each; swimmers between them
  const sites = [], swimmers = [];
  let siteAt = null;
  const placeSites = (fx, fz) => {
    siteAt = { x: fx, z: fz };
    const near = ledges.map(([x, z], i) => ({ x, z, i, d: Math.hypot(x - fx, z - fz) })).filter(l => l.d < 2500).sort((a, b) => a.d - b.d);
    const pick = [];
    for (const l of near) { if (pick.length >= 5) break; if (!pick.some(p => Math.hypot(p.x - l.x, p.z - l.z) < 250)) pick.push(l); }
    for (const s of sites) scene.remove(s.g);
    sites.length = 0;
    for (const l of pick) {
      const g = new THREE.Group(); g.position.set(l.x, 0, l.z); scene.add(g);
      const rs = 1.7 + (l.i % 3) * 0.35, rock = new THREE.Mesh(ROCK_GEO, mat(0x3a342c)); rock.scale.set(rs * 1.5, 0.45, rs); rock.rotation.y = l.i; g.add(rock);
      const weed = new THREE.Mesh(ROCK_GEO, mat(0x5b5226)); weed.scale.set(rs * 1.75, 0.1, rs * 1.2); weed.rotation.y = l.i; g.add(weed);   // rockweed at the waterline
      const seals = [], n = 2 + (l.i % 3);
      for (let k = 0; k < n; k++) {
        const s = makeSeal(l.i + k), a = (k / n) * 6.28 + l.i, rr = rs * 0.6;
        s.group.position.set(Math.cos(a) * rr * 1.3, 0.36, Math.sin(a) * rr); s.group.rotation.y = a + 1.3 + (k % 2) * 0.6;
        g.add(s.group); seals.push({ ...s, ph: (l.i * 7 + k * 3) % 10 });
      }
      sites.push({ g, seals, x: l.x, z: l.z });
    }
    for (const s of swimmers) scene.remove(s.group);
    swimmers.length = 0;
    for (const [j, st] of sites.slice(0, 3).entries()) for (let k = 0; k < 2; k++) {
      const s = makeSeal(j + k + 2); s.body.visible = false; s.head.position.set(0, 0, 0); scene.add(s.group);
      swimmers.push({ ...s, cx: st.x, cz: st.z, a: rnd() * 6.28, r: 25 + rnd() * 50, up: 6 + rnd() * 8, down: 0, sink: 0 });
    }
  };

  function update(dt, t, focus, cam, opts = {}) {
    const hidden = !!opts.hidden, scale = opts.scale || (() => 1);
    // seals: re-seat on the ledges nearest you once you've moved off
    if (!siteAt || Math.hypot(focus.x - siteAt.x, focus.z - siteAt.z) > 600) placeSites(focus.x, focus.z);
    for (const st of sites) {
      const d = Math.hypot(st.x - cam.x, cam.y, st.z - cam.z);
      st.g.visible = !hidden && d < 2500;
      if (!st.g.visible) continue;
      st.g.scale.setScalar(scale(d));
      for (const s of st.seals) {   // every ~10 s a seal lifts its head and looks round
        const u = (t * 0.1 + s.ph / 10) % 1, lift = u < 0.25 ? Math.sin(u / 0.25 * Math.PI) : 0;
        s.head.rotation.x = -0.6 * lift; s.head.rotation.y = 0.5 * Math.sin(t * 0.7 + s.ph) * lift; s.head.position.y = 0.36 + 0.12 * lift;
        s.body.rotation.z = 0.25 + 0.03 * Math.sin(t * 0.5 + s.ph);   // lying a little on one side
      }
    }
    for (const s of swimmers) {   // heads up for a while, then down, and up again a little way off
      const d = Math.hypot(s.cx - cam.x, cam.y, s.cz - cam.z);
      s.group.visible = !hidden && d < 2500;
      if (s.up > 0) { s.up -= dt; s.sink = Math.max(0, s.sink - dt * 0.6); if (s.up <= 0) s.down = 5 + Math.random() * 6; }
      else { s.sink = Math.min(1, s.sink + dt * 0.8); s.down -= dt; if (s.down <= 0) { s.a += 0.6 + Math.random(); s.up = 6 + Math.random() * 10; } }
      s.a += dt * 0.012;
      const x = s.cx + Math.cos(s.a) * s.r, z = s.cz + Math.sin(s.a) * s.r, k = scale(d);
      s.group.position.set(x, (0.05 + Math.sin(t * 1.3 + s.r) * 0.04 - s.sink * 0.5) * k, z);
      s.group.rotation.y = -s.a; s.head.rotation.x = -0.25; s.group.scale.setScalar(k);
    }
    // gulls: roost at night
    const target = [opts.boat || focus, sites[0] || focus];
    for (let f = 0; f < 2; f++) {
      const A = anchors[f], T = target[f];
      if (!A || (f === 0 && opts.boat) || Math.hypot(T.x - A.x, T.z - A.z) > 900) anchors[f] = { x: T.x, z: T.z };   // the boat's flock keeps up with her, at any pace
      else { const k = Math.min(1, dt * 0.25); A.x += (T.x - A.x) * k; A.z += (T.z - A.z) * k; }   // a flock drifts after its target
    }
    for (const b of gulls) {
      const A = anchors[b.flock], cx = A.x + b.dx, cz = A.z + b.dz;
      b.a += b.w * dt;
      const x = cx + Math.cos(b.a) * b.r, z = cz + Math.sin(b.a) * b.r, d = Math.hypot(x - cam.x, b.h - cam.y, z - cam.z);
      b.group.visible = !hidden && !opts.night && d < 2500;
      if (!b.group.visible) continue;
      const k = scale(d);
      b.group.position.set(x, b.h + Math.sin(t * 0.4 + b.ph) * 2, z);
      b.group.scale.setScalar(k);
      const sg = Math.sign(b.w), head = Math.atan2(sg * Math.sin(b.a), -sg * Math.cos(b.a));   // along the circle
      b.group.rotation.set(0, head, sg * 0.35, 'YXZ');   // banked into the turn
      b.glide -= dt; if (b.glide < -2.5) b.glide = 2 + Math.random() * 4;   // glide a few seconds, then ~2.5 s of flapping
      const flap = b.glide > 0 ? 0.12 : Math.sin(t * 9 + b.ph) * 0.7, tipF = b.glide > 0 ? -0.08 : Math.sin(t * 9 + b.ph - 0.6) * 0.45;
      b.L.w.rotation.z = -flap; b.R.w.rotation.z = flap; b.L.tip.rotation.z = -tipF; b.R.tip.rotation.z = tipF;
    }
  }
  // the ledges arrive after the scene is up (hazards.geojson is big)
  const setLedges = L => { ledges = L; siteAt = null; };
  return { update, setLedges, get seals() { return sites.reduce((n, s) => n + s.seals.length, 0) + swimmers.length; } };
}

// ledges awash (watlev 4: covers and uncovers) from a hazards FeatureCollection, as world [x, z]
export function ledgesFrom(fc, wx, wz) {
  return (fc?.features || []).filter(f => f.properties?.objtype === 'UWTROC' && f.properties.watlev === 4 && f.geometry?.type === 'Point')
    .map(f => [wx(f.geometry.coordinates[0]), wz(f.geometry.coordinates[1])]);
}
