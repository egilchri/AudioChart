// The railway's tracks, drawn (v1125, requested: "I'd like to show the tracks. And since they are permanent, maybe the
// train path will appear smoother"): OpenStreetMap's lines (www/data/rail/<id>.json), each sampled every 20 m and
// given a height profile once, smoothed along her as a railway's grades are, over the ground's bumps: a ballast bed
// with its ties, the two rails on it; seen from afar, a thin dark line. A bridge's deck runs straight between its ends
// (not down on the water: the Capitol Corridor's crossing of the Carquinez Strait), on piers; a tunnel isn't drawn.
// The trains ride on these heights (yAt), not the ground's: they no longer bob over each bump of it.
// The heights are taken again where the ground under them changes (a detail tile come or gone: reheight). Where a
// drawn bridge model carries the line (bridges3d.js's rail bridges: the Benicia–Martinez truss, 24 m up), the track
// lies on its deck (setDecks, v1126), not on a low deck of its own under it.
import * as THREE from 'three';

const STEP = 20, BED = 1.7, SHOULDER = 2.6, DROP = 0.55, RAIL = 0.7175, RAIL_H = 0.18, FAR = 2500;
const CW = 0.07, CH = 0.045;   // chunks: the detail tiles' grid

function tiesTexture() {   // grey-brown ballast, dark ties across it every 0.6 m (u across the bed, v along her)
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; const c = cv.getContext('2d');
  c.fillStyle = '#8e8981'; c.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 300; i++) { c.fillStyle = Math.random() < 0.5 ? 'rgba(60,56,50,0.35)' : 'rgba(190,184,172,0.4)'; c.fillRect(Math.random() * 64, Math.random() * 64, 2, 2); }
  c.fillStyle = '#5b4c3e'; c.fillRect(16, 4, 32, 24);   // (a tie: 2.6 m across the middle of the 5.2 m bed, 0.24 m of each 0.6)
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export function makeTracks({ scene, lines, bridge = [], tunnel = [], wx, wz, heightAt }) {
  const isB = new Set(bridge), isT = new Set(tunnel);
  const ground = (lon, lat) => Math.max(0, heightAt(lon, lat) || 0);
  // each line, sampled: lon, lat, x, z, and (once heights are taken) y, the bed's top
  const L = lines.map((l, i) => {
    const S = [];
    for (let k = 1; k < l.length; k++) {
      const [a0, b0] = l[k - 1], [a1, b1] = l[k], x0 = wx(a0), z0 = wz(b0), x1 = wx(a1), z1 = wz(b1), n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / STEP));
      for (let j = k === 1 ? 0 : 1; j <= n; j++) { const f = j / n; S.push({ lon: a0 + (a1 - a0) * f, lat: b0 + (b1 - b0) * f, x: x0 + (x1 - x0) * f, z: z0 + (z1 - z0) * f, y: 0 }); }
    }
    const lons = l.map(p => p[0]), lats = l.map(p => p[1]);
    return { i, S, bridge: isB.has(i), tunnel: isT.has(i), w: Math.min(...lons), e: Math.max(...lons), s: Math.min(...lats), n: Math.max(...lats), chunk: null };
  });
  // the lines meeting at each end (to 0.5 m), so their heights agree where they join
  const ends = new Map(), endKey = p => `${Math.round(p.x * 2)},${Math.round(p.z * 2)}`;
  for (const ln of L) for (const e of [0, 1]) { const k = endKey(ln.S[e ? ln.S.length - 1 : 0]); (ends.get(k) || ends.set(k, []).get(k)).push([ln, e]); }

  // (v1126) the rail bridge models' deck tops, by 40 m cell: a sample within 6 m of one's centre line lies on it
  let decks = new Map();
  function deckAt(x, z) {
    let best = null, bd = 36; const cx = Math.floor(x / 40), cz = Math.floor(z / 40);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [a, b] of decks.get(`${cx + i},${cz + j}`) || []) {
      const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz, f = L2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2)) : 0;
      const d = (a.x + dx * f - x) ** 2 + (a.z + dz * f - z) ** 2; if (d < bd) { bd = d; best = a.h + (b.h - a.h) * f + 0.1; }
    }
    return best;
  }
  function profile(ln) {   // her heights: the ground's upper envelope, smoothed; a bridge's or tunnel's straight between its ends
    const S = ln.S, n = S.length, raw = S.map(p => ground(p.lon, p.lat));
    for (const p of S) p.deck = deckAt(p.x, p.z);
    if (ln.bridge || ln.tunnel || S.some(p => p.deck != null)) {
      // the known heights: her ends (on the ground) and wherever a bridge model's deck carries her; straight between
      const known = []; for (let k = 0; k < n; k++) if (S[k].deck != null) known.push([k, S[k].deck]);
      if (!known.length || known[0][0] > 0) known.unshift([0, S[0].deck ?? raw[0]]);
      if (known.at(-1)[0] < n - 1) known.push([n - 1, S[n - 1].deck ?? raw[n - 1]]);
      for (let q = 1; q < known.length; q++) {
        const [k0, y0] = known[q - 1], [k1, y1] = known[q];
        for (let k = k0; k <= k1; k++) { S[k].y = y0 + (y1 - y0) * (k1 > k0 ? (k - k0) / (k1 - k0) : 0); if (ln.bridge && S[k].deck == null) S[k].y = Math.max(S[k].y, raw[k] + 1.5, 3); }
      }
      if (!ln.bridge && !ln.tunnel) for (let k = 0; k < n; k++) if (S[k].deck == null) S[k].y = Math.max(S[k].y, raw[k]);
      return;
    }
    const env = raw.map((_, k) => Math.max(...raw.slice(Math.max(0, k - 2), k + 3)));   // (over the bumps within 40 m)
    for (let k = 0; k < n; k++) { let a = 0, c = 0; for (let j = Math.max(0, k - 3); j <= Math.min(n - 1, k + 3); j++) { a += env[j]; c++; } S[k].y = a / c; }
  }
  function joinEnds(lns) {   // at each join, the lines' mean height there, eased into the last 4 samples of each
    const keys = new Set(); for (const ln of lns) for (const e of [0, 1]) keys.add(endKey(ln.S[e ? ln.S.length - 1 : 0]));
    for (const k of keys) {
      const at = ends.get(k); if (!at || at.length < 2) continue;
      const m = at.reduce((a, [ln, e]) => a + ln.S[e ? ln.S.length - 1 : 0].y, 0) / at.length;
      for (const [ln, e] of at) { const S = ln.S, n = S.length, d = m - S[e ? n - 1 : 0].y; for (let j = 0; j < Math.min(4, n); j++) S[e ? n - 1 - j : j].y += d * (1 - j / 4); }
    }
  }

  // ── drawing: per chunk, the bed (its shoulders sloping down; a bridge's straight down, its girders) and the rails ──
  const tex = tiesTexture();
  const bedMat = new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const railMat = new THREE.MeshLambertMaterial({ color: 0xc4c0b8, emissive: 0x6a6660, emissiveIntensity: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const pierMat = new THREE.MeshLambertMaterial({ color: 0x8d8a84 });
  const farMat = new THREE.LineBasicMaterial({ color: 0x3a332c, transparent: true, opacity: 0.75 });
  const chunks = new Map();
  for (const ln of L) {
    const S = ln.S, m = S[S.length >> 1], key = `${Math.floor(m.lon / CW)},${Math.floor(m.lat / CH)}`;
    let ch = chunks.get(key); if (!ch) chunks.set(key, ch = { lines: [], x: wx((Math.floor(m.lon / CW) + 0.5) * CW), z: wz((Math.floor(m.lat / CH) + 0.5) * CH), bed: null, rails: null });
    ch.lines.push(ln); ln.chunk = ch;
  }
  const group = new THREE.Group(); scene.add(group);
  function build(ch) {
    const bp = [], bu = [], bi = [], rp = [], ri = [];
    for (const ln of ch.lines) {
      if (ln.tunnel) continue;
      const S = ln.S, n = S.length; let along = 0;
      const prof = ln.bridge ? [[-1.9, -1.3], [-1.9, 0], [1.9, 0], [1.9, -1.3]] : [[-SHOULDER, -DROP], [-BED, 0], [BED, 0], [SHOULDER, -DROP]];
      for (let k = 0; k < n; k++) {
        const a = S[Math.max(0, k - 1)], b = S[Math.min(n - 1, k + 1)], tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
        if (k) along += Math.hypot(S[k].x - S[k - 1].x, S[k].z - S[k - 1].z);
        const v0 = bp.length / 3;
        for (const [o, dy] of prof) { bp.push(S[k].x + nx * o, S[k].y + dy, S[k].z + nz * o); bu.push((o + SHOULDER) / (2 * SHOULDER), along / 0.6); }
        const r0 = rp.length / 3;
        for (const s of [-1, 1]) for (const o of [-0.06, 0.06]) rp.push(S[k].x + nx * (s * RAIL + o), S[k].y + RAIL_H, S[k].z + nz * (s * RAIL + o));
        if (k) {
          for (let q = 0; q < 3; q++) { const p0 = v0 - 4 + q, p1 = v0 + q; bi.push(p0, p0 + 1, p1, p0 + 1, p1 + 1, p1); }   // (facing up)
          for (const q of [0, 2]) { const p0 = r0 - 4 + q, p1 = r0 + q; ri.push(p0, p0 + 1, p1, p0 + 1, p1 + 1, p1); }
        }
      }
    }
    for (const m of [ch.bed, ch.rails]) if (m) { group.remove(m); m.geometry.dispose(); }
    ch.bed = ch.rails = null;
    if (!bi.length) return;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(bu, 2)); g.setIndex(bi); g.computeVertexNormals();
    const r = new THREE.BufferGeometry(); r.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3)); r.setIndex(ri); r.computeVertexNormals();
    ch.bed = new THREE.Mesh(g, bedMat); ch.rails = new THREE.Mesh(r, railMat); group.add(ch.bed, ch.rails);
  }
  // seen from afar: every line as a thin dark line (one mesh), and the bridges' piers (one instanced mesh)
  let far = null, piers = null;
  function buildFar() {
    const p = [];
    for (const ln of L) { if (ln.tunnel) continue; const S = ln.S; for (let k = 1; k < S.length; k++) p.push(S[k - 1].x, S[k - 1].y + 0.6, S[k - 1].z, S[k].x, S[k].y + 0.6, S[k].z); }
    if (far) { group.remove(far); far.geometry.dispose(); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); far = new THREE.LineSegments(g, farMat); group.add(far);
    const at = [];
    for (const ln of L) if (ln.bridge) for (let k = 2; k < ln.S.length - 2; k += 2) { if (ln.S[k].deck != null) continue; const q = ln.S[k], gnd = ground(q.lon, q.lat), h = q.y - 1.3 - gnd; if (h > 1.5) at.push(q.x, gnd, q.z, h); }
    if (piers) { group.remove(piers); piers.geometry.dispose(); }
    piers = new THREE.InstancedMesh(new THREE.BoxGeometry(3.2, 1, 1.4), pierMat, Math.max(1, at.length / 4)); piers.count = at.length / 4;
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < at.length / 4; i++) piers.setMatrixAt(i, m4.makeScale(1, at[i * 4 + 3], 1).setPosition(at[i * 4], at[i * 4 + 1] + at[i * 4 + 3] / 2, at[i * 4 + 2]));
    group.add(piers);
  }

  // the samples by 40 m cell, for the trains' heights
  const CELL = 40; let grid = new Map();
  function index() {
    grid = new Map();
    for (const ln of L) ln.S.forEach((p, k) => { const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`; (grid.get(key) || grid.set(key, []).get(key)).push(ln, k); });
  }
  // the rails' top under (x, z): the nearest sample within reach (12 m), eased toward its neighbour along her
  function yAt(x, z, reach = 12) {
    let best = null, bd = reach * reach; const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const r = Math.ceil(reach / CELL);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) { const c = grid.get(`${cx + i},${cz + j}`); if (!c) continue; for (let q = 0; q < c.length; q += 2) { const p = c[q].S[c[q + 1]], d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; best = [c[q], c[q + 1]]; } } }
    if (!best) return null;
    const [ln, k] = best, S = ln.S, p = S[k], nb = S[k + 1] && (!S[k - 1] || (S[k + 1].x - x) ** 2 + (S[k + 1].z - z) ** 2 < (S[k - 1].x - x) ** 2 + (S[k - 1].z - z) ** 2) ? S[k + 1] : S[k - 1] || p;
    const dx = nb.x - p.x, dz = nb.z - p.z, L2 = dx * dx + dz * dz, f = L2 ? Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / L2)) : 0;
    return p.y + (nb.y - p.y) * f + RAIL_H;
  }

  function all() { for (const ln of L) profile(ln); joinEnds(L); for (const ch of chunks.values()) build(ch); buildFar(); index(); }
  all();
  let farDirty = false;
  return {
    group, yAt,
    // the ground under w..e, s..n has changed: her heights there taken again
    // (v1126) the rail bridge models' decks ([[{x, z, h}]]): the lines on them given their heights again
    setDecks(D) {
      decks = new Map();
      for (const P of D) for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i], seg = [a, b];
        const x0 = Math.floor(Math.min(a.x, b.x) / 40) - 1, x1 = Math.floor(Math.max(a.x, b.x) / 40) + 1, z0 = Math.floor(Math.min(a.z, b.z) / 40) - 1, z1 = Math.floor(Math.max(a.z, b.z) / 40) + 1;
        for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) { const k = `${cx},${cz}`; (decks.get(k) || decks.set(k, []).get(k)).push(seg); }
      }
      all();
    },
    reheight(w, s, e, n) {
      const hit = L.filter(ln => ln.e >= w && ln.w <= e && ln.n >= s && ln.s <= n); if (!hit.length) return;
      for (const ln of hit) profile(ln); joinEnds(hit);
      for (const ch of new Set(hit.map(ln => ln.chunk))) build(ch);
      farDirty = true;
    },
    // each few tenths of a second: the beds and rails near the view; the far lines when the view is high
    update(vx, vz, dist) {
      if (farDirty) { farDirty = false; buildFar(); index(); }
      const R = Math.max(3000, Math.min(9000, dist * 2.2));
      for (const ch of chunks.values()) { const v = Math.hypot(ch.x - vx, ch.z - vz) < R + 4000; if (ch.bed) ch.bed.visible = v; if (ch.rails) ch.rails.visible = v && dist < 1500; }
      if (far) far.visible = dist > FAR * 0.6;
    },
  };
}
