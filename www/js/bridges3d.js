// Bridges (v1020, requested: "don't forget to put in the Golden Gate bridge and the other bridges"): data/bridges/
// <region>.json, built by design/bridges/build_bridges.py from OpenStreetMap's lines and the NOAA chart's clearances,
// towers and piers. Each bridge: a deck along its line (on the ground at its ends), piers down into the water,
// towers, cables and suspenders, and trusses drawn as lines. Lit up a little at night. No file: no bridges.
import * as THREE from 'three';
import { wx, wz } from './terrain3d.js';

const box = new THREE.BoxGeometry(1, 1, 1);
const BOTTOM = -8;   // (piers and towers go on down out of sight under the water)

// Traffic (v1043, requested: "it would be nice to have cars on all bridges"): cars and a few trucks on every named
// road bridge, driving on the right at about 50 mph. A pair of decks with the same name and ends together (the Bay
// Bridge's east span, the Carquinez, the Benicia) is one-way each, the way OpenStreetMap draws them; a lone deck
// carries both ways.
const CAR_COLOURS = [0xf2f2f0, 0xf2f2f0, 0x1c1c1e, 0x1c1c1e, 0x9a9da3, 0x9a9da3, 0x5d6168, 0xb3262b, 0x24427a, 0x6f8fae, 0x2e5a3c, 0xd8c9a8];

// → { group, labels: [{ text, x, y, z }], places: [{ name, x, z, az, L }], credit, night(k), update(dt) } or null
export async function makeBridges(rid, heightAt) {
  let J;
  try { const r = await fetch(`./data/bridges/${rid}.json`); if (!r.ok) return null; J = await r.json(); } catch (_) { return null; }
  const group = new THREE.Group(), mats = new Map(), labels = new Map();
  const mat = c => { if (!mats.has(c)) mats.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.25 })); return mats.get(c); };
  const lineMat = c => new THREE.LineBasicMaterial({ color: new THREE.Color(c).multiplyScalar(0.8) });
  const parts = [];   // [x, y, z, sx, sy, sz, rotY, colour] for one instanced mesh of boxes
  const ground = (lon, lat) => Math.max(0, heightAt(lon, lat)) + 0.4;
  const put = (x, z, y0, y1, along, across, az, c) => { if (y1 - y0 > 0.1) parts.push([x, (y0 + y1) / 2, z, across, y1 - y0, along, Math.PI - az, c]); };   // (az: the deck's bearing)

  const roads = [];   // [deck points, bridge] for the traffic
  const places = new Map();   // the big ones, as places to fly to (v1047): by name, the longest part of each
  for (const B of J.bridges) {
    const P = B.pts.map(([lon, lat, h]) => ({ x: wx(lon), z: wz(lat), h, lon, lat }));
    // the heights: the ends on the ground, any unknown run between them ramped from the ground to the first height
    if (P[0].h == null) P[0].h = ground(P[0].lon, P[0].lat);
    if (P.at(-1).h == null) P.at(-1).h = ground(P.at(-1).lon, P.at(-1).lat);
    for (let i = 1; i < P.length - 1; i++) if (P[i].h == null) {
      let j = i; while (P[j].h == null) j++;
      const a = P[i - 1], b = P[j];
      for (let k = i; k < j; k++) P[k].h = a.h + (b.h - a.h) * (k - i + 1) / (j - i + 1);
    }
    for (const p of P) p.h = Math.max(p.h, ground(p.lon, p.lat));
    // the deck: a box section along the line (top, bottom and both sides)
    const pos = [], idx = [], w2 = B.w / 2;
    P.forEach((p, i) => {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      p.tx = (b.x - a.x) / L; p.tz = (b.z - a.z) / L; p.nx = -p.tz; p.nz = p.tx;
      const lx = p.x + p.nx * w2, lz = p.z + p.nz * w2, rx = p.x - p.nx * w2, rz = p.z - p.nz * w2, y1 = p.h, y0 = p.h - B.depth;
      pos.push(lx, y1, lz, rx, y1, rz, lx, y0, lz, rx, y0, rz, lx, y1, lz, lx, y0, lz, rx, y1, rz, rx, y0, rz);
      if (i) {
        const o = (i - 1) * 8, n = i * 8;
        for (const [a0, a1] of [[0, 1], [3, 2], [5, 4], [6, 7]]) idx.push(o + a0, n + a0, o + a1, o + a1, n + a0, n + a1);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const deck = new THREE.Mesh(g, mat(B.color)); deck.material.side = THREE.DoubleSide; group.add(deck);
    if (!B.minor && !/rail/i.test(B.name)) roads.push([P, B]);
    {   // a place: a main bridge, or any named road bridge 700 m long (New York's are drawn plain, so "minor")
      let L = 0; for (let i = 1; i < P.length; i++) L += Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
      const name = B.short.replace(/\s*\([^)]*\)$/, '');
      if ((!B.minor || L >= 700) && /Bridge|Skyway|Crossing/.test(name) && name !== 'Bridge' && !/rail/i.test(B.name) && !(places.get(name)?.L >= L)) {
        const i = P.length >> 1, a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
        places.set(name, { name, x: P[i].x, z: P[i].z, az: Math.atan2(b.x - a.x, -(b.z - a.z)), L, big: !B.minor || !!places.get(name)?.big });   // (big: one of the bridges with a spec of its own, for the bridges tour: v1065)
      }
    }
    // piers: two columns under a wide deck, a wall under a narrow one, where the deck is over the water or low ground
    for (const [lon, lat, top, az] of B.piers) {
      const gy = heightAt(lon, lat), x = wx(lon), z = wz(lat), a = az * Math.PI / 180;
      if (gy > top - 2) continue;
      const y0 = gy > 0.5 ? gy : BOTTOM, s = Math.min(6, Math.max(1.4, B.w * 0.14));
      if (B.w >= 16) for (const side of [-1, 1]) put(x + Math.cos(a) * side * B.w * 0.3, z + Math.sin(a) * side * B.w * 0.3, y0, top, s, s, a, B.color);
      else put(x, z, y0, top, s * 0.8, B.w * 0.8, a, B.color);
    }
    // towers: two legs joined by struts (a suspension or lift bridge's), or one shaft (the Bay Bridge's east span)
    for (const T of B.towers) {
      const x = wx(T.lon), z = wz(T.lat), a = T.az * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      if (T.kind === 'single') { put(x, z, BOTTOM, T.top, 12, 12, a, B.color); continue; }
      if (T.kind === 'gothic') {   // the Brooklyn Bridge's (v1032): granite, the roadway through two pointed arches
        const stone = 0xb7aa8f, along = 13, across = T.w + 16, archW = T.w * 0.36, pierW = (across - 2 * archW) / 3;
        const archTop = T.deck + (T.top - T.deck) * 0.62, at = off => [x + ca * off, z + sa * off];
        put(x, z, BOTTOM, T.deck - B.depth, along + 4, across + 4, a, stone);   // the base, below the deck
        for (const k of [-1, 0, 1]) { const [px, pz] = at(k * (archW + pierW)); put(px, pz, T.deck - B.depth, T.top, along, pierW, a, stone); }
        for (const k of [-1, 1]) {
          const c = k * (archW + pierW) / 2, [ox, oz] = at(c);
          put(ox, oz, archTop, T.top, along, archW, a, stone);   // over the arch
          for (let i = 0; i < 4; i++) {   // its pointed head: the opening narrowing in four steps
            const h = (archTop - T.deck) * 0.07, y1 = archTop - i * h, fill = archW * (0.5 - 0.5 * Math.sqrt(1 - ((4 - i) / 4.6) ** 2));
            for (const sd of [-1, 1]) { const [fx, fz] = at(c + sd * (archW - fill) / 2); put(fx, fz, y1 - h, y1, along, fill, a, stone); }
          }
        }
        put(x, z, T.top - 2.5, T.top + 1, along + 2, across + 2, a, stone);   // the cornice
        continue;
      }
      const leg = T.kind === 'lift' ? 3 : Math.max(4, T.top * 0.045), half = T.w / 2 + leg / 2;
      for (const side of [-1, 1]) put(x + ca * side * half, z + sa * side * half, BOTTOM, T.top, leg * (T.kind === "lift" ? 1.5 : 2.2), leg, a, B.color);
      const struts = T.kind === 'lift' ? [T.top - 2] : [T.deck - B.depth - 2, ...[0.45, 0.7, 0.9].map(f => T.deck + (T.top - T.deck) * f), T.top - leg * 0.4];
      for (const y of struts) put(x, z, y - leg * 0.4, y + leg * 0.4, leg, T.w + leg * 2, a, B.color);
    }
    for (const K of B.blocks) { const a = K.az * Math.PI / 180; put(wx(K.lon), wz(K.lat), Math.min(BOTTOM, heightAt(K.lon, K.lat)), K.top, K.len, K.w, a, 0xb9b4a8); }   // anchorages
    // cables and their suspenders
    const seg = [];
    for (const C of B.cables) {
      const pts = C.map(([lon, lat, h]) => new THREE.Vector3(wx(lon), h, wz(lat)));
      // the main cable: a tube as thick as she has them (v1064, cable_r), else a line
      if (B.cable_r) group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, B.cable_r, 6), mat(B.color)));
      else group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(B.color)));
      C.forEach(([lon, lat, h, dh], i) => { if (h - dh > 1.5) seg.push(pts[i].x, h, pts[i].z, pts[i].x, dh, pts[i].z); });
    }
    // arches (v1064, the Bayonne's and Hell Gate's): each rib a tube, with hangers down to the deck where it's above
    // it and posts up to the deck where it's below
    for (const R of B.arches || []) {
      const pts = R.pts.map(([lon, lat, h]) => new THREE.Vector3(wx(lon), h, wz(lat)));
      group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, R.r, 8), mat(B.color)));
      R.pts.forEach(([, , h, dh], i) => {
        if (h > dh + 1.5) seg.push(pts[i].x, h, pts[i].z, pts[i].x, dh, pts[i].z);
        else if (h < dh - B.depth - 1.5) seg.push(pts[i].x, h, pts[i].z, pts[i].x, dh - B.depth, pts[i].z);
      });
    }
    // trusses: chords, posts and diagonals on both sides, through (above the deck) or under it
    for (const T of B.truss) for (const side of [-1, 1]) {
      const at = i => { const p = P[i]; return [p.x + p.nx * side * w2, p.z + p.nz * side * w2]; };
      for (let i = T.i0; i <= T.i1; i++) {
        const [x, z] = at(i), up = T.above[i - T.i0], lo = T.below, h = P[i].h, b0 = h - B.depth;
        if (up > 0.5) seg.push(x, h, z, x, h + up, z);
        if (lo > 0.5) seg.push(x, b0, z, x, b0 - lo, z);
        if (i === T.i1) continue;
        const [x1, z1] = at(i + 1), up1 = T.above[i + 1 - T.i0], h1 = P[i + 1].h, b1 = h1 - B.depth, odd = (i - T.i0) % 2;
        if (up > 0.5 || up1 > 0.5) {
          seg.push(x, h + up, z, x1, h1 + up1, z1);
          seg.push(...(odd ? [x, h, z, x1, h1 + up1, z1] : [x, h + up, z, x1, h1, z1]));
        }
        if (lo > 0.5) {
          seg.push(x, b0 - lo, z, x1, b1 - lo, z1);
          seg.push(...(odd ? [x, b0, z, x1, b1 - lo, z1] : [x, b0 - lo, z, x1, b1, z1]));
        }
      }
    }
    if (seg.length) group.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(seg, 3)), lineMat(B.color)));
    // one name for each bridge (its longest part), over its middle
    if (!B.minor && !(labels.get(B.short)?.len >= P.length)) {
      const m = P[P.length >> 1];
      labels.set(B.short, { text: B.short, x: m.x, y: m.h + 25, z: m.z, len: P.length });
    }
  }
  if (parts.length) {
    const im = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.2 }), parts.length), M = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    parts.forEach(([x, y, z, sx, sy, sz, r, col], i) => {
      im.setMatrixAt(i, M.compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r), new THREE.Vector3(sx, sy, sz)));
      im.setColorAt(i, c.set(col));
    });
    mats.set('parts', im.material); group.add(im);
  }
  const cars = makeTraffic(roads);
  if (cars) group.add(cars.mesh);
  const night = k => { for (const m of mats.values()) m.emissive.copy(m.color).multiplyScalar(0.3 * k); cars?.night(k); };
  return { group, labels: [...labels.values()], places: [...places.values()].sort((a, b) => a.name.localeCompare(b.name)), credit: J.credit, night, update: dt => cars?.update(dt) };
}

// the traffic: one instanced mesh of boxes, each car a distance along its deck and a lane, moved on every frame
function makeTraffic(roads) {
  const LANE = 3.6, list = [];
  for (const [P, B] of roads) {
    const len = [0];
    for (let i = 1; i < P.length; i++) len.push(len[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z, P[i].h - P[i - 1].h));
    const L = len.at(-1); if (L < 200) continue;
    const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) < 800;
    const oneWay = roads.some(([Q, C]) => C !== B && C.short === B.short && ((near(P[0], Q.at(-1)) && near(P.at(-1), Q[0])) || (near(P[0], Q[0]) && near(P.at(-1), Q.at(-1)))));
    const lanes = Math.max(oneWay ? 1 : 2, Math.min(oneWay ? 5 : 6, Math.floor((B.w - 2) / LANE)));
    const road = { P, len, L };
    for (let ln = 0; ln < lanes; ln++) {
      // forward lanes on the right of the line (its +normal side), the others back the other way on the left
      const fwd = oneWay || ln < lanes / 2, k = oneWay ? ln - (lanes - 1) / 2 : fwd ? ln + 0.5 : -(ln - lanes / 2 + 0.5);
      const off = k * Math.min(LANE, (B.w - 1.5) / lanes), v = (21 + Math.random() * 6) * (fwd ? 1 : -1);
      for (let s = Math.random() * 30; s < L; s += 22 + Math.random() * 45) {
        const truck = Math.random() < 0.08;
        list.push({ road, off, v, s, len: truck ? 13 : 4.7, w: truck ? 2.5 : 1.85, h: truck ? 3.6 : 1.5, c: truck ? 0xe8e6e0 : CAR_COLOURS[Math.random() * CAR_COLOURS.length | 0] });
      }
    }
  }
  if (!list.length) return null;
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.4 });
  const mesh = new THREE.InstancedMesh(box, mat, list.length), c = new THREE.Color();
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false;
  list.forEach((a, i) => mesh.setColorAt(i, c.set(a.c)));
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const update = dt => {
    list.forEach((a, i) => {
      const { P, len, L } = a.road;
      a.s = (a.s + a.v * dt + L) % L;
      let lo = 0, hi = len.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (len[m] <= a.s) lo = m; else hi = m; }
      const A = P[lo], Bp = P[hi], u = (a.s - len[lo]) / ((len[hi] - len[lo]) || 1);
      const tx = Bp.x - A.x, tz = Bp.z - A.z, tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
      p.set(A.x + tx * u + nx * a.off, A.h + (Bp.h - A.h) * u + a.h / 2, A.z + tz * u + nz * a.off);
      mesh.setMatrixAt(i, M.compose(p, q.setFromAxisAngle(up, Math.atan2(tx, tz)), sc.set(a.w, a.h, a.len)));
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  // at night their lamps: a glow on every car (white ahead and red astern are too small to tell apart from up here)
  const night = k => mat.emissive.setRGB(0.55 * k, 0.45 * k, 0.3 * k);
  return { mesh, update, night };
}
