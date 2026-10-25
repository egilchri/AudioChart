// Bridges (v1020, requested: "don't forget to put in the Golden Gate bridge and the other bridges"): data/bridges/
// <region>.json, built by design/bridges/build_bridges.py from OpenStreetMap's lines and the NOAA chart's clearances,
// towers and piers. Each bridge: a deck along its line (on the ground at its ends), piers down into the water,
// towers, cables and suspenders, and trusses drawn as lines. Lit up a little at night. No file: no bridges.
import * as THREE from 'three';
import { wx, wz } from './terrain3d.js';

const box = new THREE.BoxGeometry(1, 1, 1);
const BOTTOM = -8;   // (piers and towers go on down out of sight under the water)

// → { group, labels: [{ text, x, y, z }], credit, night(k) } or null
export async function makeBridges(rid, heightAt) {
  let J;
  try { const r = await fetch(`./data/bridges/${rid}.json`); if (!r.ok) return null; J = await r.json(); } catch (_) { return null; }
  const group = new THREE.Group(), mats = new Map(), labels = new Map();
  const mat = c => { if (!mats.has(c)) mats.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.25 })); return mats.get(c); };
  const lineMat = c => new THREE.LineBasicMaterial({ color: new THREE.Color(c).multiplyScalar(0.8) });
  const parts = [];   // [x, y, z, sx, sy, sz, rotY, colour] for one instanced mesh of boxes
  const ground = (lon, lat) => Math.max(0, heightAt(lon, lat)) + 0.4;
  const put = (x, z, y0, y1, along, across, az, c) => { if (y1 - y0 > 0.1) parts.push([x, (y0 + y1) / 2, z, across, y1 - y0, along, Math.PI - az, c]); };   // (az: the deck's bearing)

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
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(B.color)));
      C.forEach(([lon, lat, h, dh], i) => { if (h - dh > 1.5) seg.push(pts[i].x, h, pts[i].z, pts[i].x, dh, pts[i].z); });
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
  const night = k => { for (const m of mats.values()) m.emissive.copy(m.color).multiplyScalar(0.3 * k); };
  return { group, labels: [...labels.values()], credit: J.credit, night };
}
