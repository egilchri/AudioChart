// The railway's tracks, drawn (v1125, requested: "I'd like to show the tracks. And since they are permanent, maybe the
// train path will appear smoother"): OpenStreetMap's lines (www/data/rail/<id>.json), each sampled every 20 m and
// given a height profile once, smoothed along her as a railway's grades are, over the ground's bumps: a ballast bed
// with its ties, the two rails on it; seen from afar, a thin dark line. A bridge's deck runs straight between its ends
// (not down on the water: the Capitol Corridor's crossing of the Carquinez Strait), on piers; a tunnel isn't drawn.
// The trains ride on these heights (yAt), not the ground's: they no longer bob over each bump of it.
// The heights are taken again where the ground under them changes (a detail tile come or gone: reheight). Where a
// drawn bridge model carries the line (bridges3d.js's rail bridges: the Benicia–Martinez truss, 24 m up), the track
// lies on its deck (setDecks, v1126), not on a low deck of its own under it.
// (v1155, "do the elevated lines next") New York's els: a raised piece with its layer (`elev`, build_rail.py --elev)
// stands at an el's height over the street (8 m on layer 1, 3 m more a layer up) where it joins another, ramping
// down at 4% to the ground where it meets track on the ground, on steel: girders under each track, a pair of columns
// and a crossbeam every 20 m. One beside a drawn road bridge's deck (the Manhattan and Williamsburg Bridges' subway
// tracks) lies along that deck. Lines without `elev` (Boston's, SF's) are as they were.
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

export function makeTracks({ scene, lines, bridge = [], tunnel = [], elev = [], wx, wz, heightAt }) {
  const isB = new Set(bridge), isT = new Set(tunnel), lay = new Map(elev);
  const ground = (lon, lat) => Math.max(0, heightAt(lon, lat) || 0);
  // each line, sampled: lon, lat, x, z, and (once heights are taken) y, the bed's top
  const L = lines.map((l, i) => {
    const S = [];
    for (let k = 1; k < l.length; k++) {
      const [a0, b0] = l[k - 1], [a1, b1] = l[k], x0 = wx(a0), z0 = wz(b0), x1 = wx(a1), z1 = wz(b1), n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / STEP));
      for (let j = k === 1 ? 0 : 1; j <= n; j++) { const f = j / n; S.push({ lon: a0 + (a1 - a0) * f, lat: b0 + (b1 - b0) * f, x: x0 + (x1 - x0) * f, z: z0 + (z1 - z0) * f, y: 0 }); }
    }
    const lons = l.map(p => p[0]), lats = l.map(p => p[1]);
    return { i, S, bridge: isB.has(i), tunnel: isT.has(i), elev: lay.get(i) || 0, w: Math.min(...lons), e: Math.max(...lons), s: Math.min(...lats), n: Math.max(...lats), chunk: null };
  });
  // the lines meeting at each end (to 0.5 m), so their heights agree where they join
  const ends = new Map(), endKey = p => `${Math.round(p.x * 2)},${Math.round(p.z * 2)}`;
  for (const ln of L) for (const e of [0, 1]) { const k = endKey(ln.S[e ? ln.S.length - 1 : 0]); (ends.get(k) || ends.set(k, []).get(k)).push([ln, e]); }

  // (v1126) the rail bridge models' deck tops, by 40 m cell: a sample within 6 m of one's centre line lies on it
  let decks = new Map(), roads = new Map();
  // (v1155) a road bridge's deck beside an el's piece (within 20 m, running the same way): her height there, a little under it
  function roadAt(x, z, hx, hz) {
    let best = null, bd = 400; const cx = Math.floor(x / 40), cz = Math.floor(z / 40);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [a, b] of roads.get(`${cx + i},${cz + j}`) || []) {
      const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz; if (!L2 || Math.abs(dx * hx + dz * hz) / Math.sqrt(L2) < 0.92) continue;
      const f = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2)), d = (a.x + dx * f - x) ** 2 + (a.z + dz * f - z) ** 2;
      if (d < bd && f > 0 && f < 1) { bd = d; best = a.h + (b.h - a.h) * f - 2; }
    }
    return best;
  }
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
    if (ln.elev && roads.size) for (let k = 0; k < n; k++) if (S[k].deck == null) {
      const a = S[Math.max(0, k - 1)], b = S[Math.min(n - 1, k + 1)], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      S[k].deck = roadAt(S[k].x, S[k].z, (b.x - a.x) / l, (b.z - a.z) / l);
    }
    if (ln.elev && !S.some(p => p.deck != null)) return elevProfile(ln, raw);
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
  // (v1155) an el: over the street at her layer's height where she joins another el, down to the ground at 4% where
  // she meets track on it (her approach, or a short bridge's embankment ends: straight between them, as before)
  function elevProfile(ln, raw) {
    const S = ln.S, n = S.length, H = 5 + 3 * ln.elev, GRADE = 0.04;
    const air = e => (ends.get(endKey(S[e ? n - 1 : 0])) || []).some(([o]) => o !== ln && o.elev);
    const a0 = air(0), a1 = air(1), cum = [0]; for (let k = 1; k < n; k++) cum.push(cum[k - 1] + Math.hypot(S[k].x - S[k - 1].x, S[k].z - S[k - 1].z));
    const env = raw.map((_, k) => Math.max(...raw.slice(Math.max(0, k - 2), k + 3)));
    const y0 = raw[0] + (a0 ? H : 0), y1 = raw[n - 1] + (a1 ? H : 0), len = cum[n - 1] || 1;
    for (let k = 0; k < n; k++) {
      let e = 0, c = 0; for (let j = Math.max(0, k - 3); j <= Math.min(n - 1, k + 3); j++) { e += env[j]; c++; }
      const h = Math.min(H, a0 ? H : GRADE * cum[k], a1 ? H : GRADE * (len - cum[k]));
      S[k].y = Math.max(e / c + h, y0 + (y1 - y0) * cum[k] / len, raw[k] + (h > 2 ? 0 : 0.3));
    }
  }
  function joinEnds(lns) {   // at each join, the lines' mean height there, eased into the last 4 samples of each
    const keys = new Set(); for (const ln of lns) for (const e of [0, 1]) keys.add(endKey(ln.S[e ? ln.S.length - 1 : 0]));
    for (const k of keys) {
      const at = ends.get(k); if (!at || at.length < 2) continue;
      const m = at.reduce((a, [ln, e]) => a + ln.S[e ? ln.S.length - 1 : 0].y, 0) / at.length;
      for (const [ln, e] of at) { const S = ln.S, n = S.length, d = m - S[e ? n - 1 : 0].y, w = Math.min(n, Math.abs(d) > 4 && at.some(([o]) => o.elev) ? Math.ceil(Math.abs(d)) : 4); for (let j = 0; j < w; j++) S[e ? n - 1 - j : j].y += d * (1 - j / w); }   // (a bigger step eased over more: v1155)
    }
  }

  // ── drawing: per chunk, the bed (its shoulders sloping down; a bridge's straight down, its girders) and the rails ──
  const tex = tiesTexture();
  const bedMat = new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const railMat = new THREE.MeshLambertMaterial({ color: 0xc4c0b8, emissive: 0x6a6660, emissiveIntensity: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const pierMat = new THREE.MeshLambertMaterial({ color: 0x8d8a84 });
  const steelMat = new THREE.MeshLambertMaterial({ color: 0x55605b, side: THREE.DoubleSide });   // (v1155: an el's steel, the MTA's grey-green)
  const farMat = new THREE.LineBasicMaterial({ color: 0x3a332c, transparent: true, opacity: 0.75 });
  const chunks = new Map();
  for (const ln of L) {
    const S = ln.S, m = S[S.length >> 1], key = `${Math.floor(m.lon / CW)},${Math.floor(m.lat / CH)}`;
    let ch = chunks.get(key); if (!ch) chunks.set(key, ch = { lines: [], x: wx((Math.floor(m.lon / CW) + 0.5) * CW), z: wz((Math.floor(m.lat / CH) + 0.5) * CH), bed: null, rails: null, steel: null });
    ch.lines.push(ln); ln.chunk = ch;
  }
  const group = new THREE.Group(); scene.add(group);
  function build(ch) {
    const bp = [], bu = [], bi = [], rp = [], ri = [], sp = [], si = [];
    for (const ln of ch.lines) {
      if (ln.tunnel) continue;
      const S = ln.S, n = S.length; let along = 0;
      // (v1155) an el's open deck: ties only, her girders (steel) under them; a bridge's solid deck; else the bed and shoulders
      const el = ln.elev > 0, prof = el ? [[-1.5, 0], [-1.45, 0.02], [1.45, 0.02], [1.5, 0]] : ln.bridge ? [[-1.9, -1.3], [-1.9, 0], [1.9, 0], [1.9, -1.3]] : [[-SHOULDER, -DROP], [-BED, 0], [BED, 0], [SHOULDER, -DROP]];
      for (let k = 0; k < n; k++) {
        const a = S[Math.max(0, k - 1)], b = S[Math.min(n - 1, k + 1)], tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
        if (k) along += Math.hypot(S[k].x - S[k - 1].x, S[k].z - S[k - 1].z);
        const v0 = bp.length / 3;
        for (const [o, dy] of prof) { bp.push(S[k].x + nx * o, S[k].y + dy, S[k].z + nz * o); bu.push((o + SHOULDER) / (2 * SHOULDER), along / 0.6); }
        if (el) { const s0 = sp.length / 3; for (const o of [-1.25, 1.25]) for (const dy of [-1.35, -0.05]) sp.push(S[k].x + nx * o, S[k].y + dy, S[k].z + nz * o);   // (her two girders: plates 1.3 m deep)
          if (k) for (const q of [0, 2]) { const p0 = s0 - 4 + q, p1 = s0 + q; si.push(p0, p0 + 1, p1, p0 + 1, p1 + 1, p1); } }
        const r0 = rp.length / 3;
        for (const s of [-1, 1]) for (const o of [-0.06, 0.06]) rp.push(S[k].x + nx * (s * RAIL + o), S[k].y + RAIL_H, S[k].z + nz * (s * RAIL + o));
        if (k) {
          for (let q = 0; q < 3; q++) { const p0 = v0 - 4 + q, p1 = v0 + q; bi.push(p0, p0 + 1, p1, p0 + 1, p1 + 1, p1); }   // (facing up)
          for (const q of [0, 2]) { const p0 = r0 - 4 + q, p1 = r0 + q; ri.push(p0, p0 + 1, p1, p0 + 1, p1 + 1, p1); }
        }
      }
    }
    for (const m of [ch.bed, ch.rails, ch.steel]) if (m) { group.remove(m); m.geometry.dispose(); }
    ch.bed = ch.rails = ch.steel = null;
    if (si.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); g.setIndex(si); g.computeVertexNormals(); ch.steel = new THREE.Mesh(g, steelMat); group.add(ch.steel); }
    if (!bi.length) return;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(bu, 2)); g.setIndex(bi); g.computeVertexNormals();
    const r = new THREE.BufferGeometry(); r.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3)); r.setIndex(ri); r.computeVertexNormals();
    ch.bed = new THREE.Mesh(g, bedMat); ch.rails = new THREE.Mesh(r, railMat); group.add(ch.bed, ch.rails);
  }
  // seen from afar: every line as a thin dark line (one mesh), and the bridges' piers (one instanced mesh)
  let far = null, piers = null, elCols = null, elBeams = null;
  function buildFar() {
    const p = [];
    for (const ln of L) { if (ln.tunnel) continue; const S = ln.S; for (let k = 1; k < S.length; k++) p.push(S[k - 1].x, S[k - 1].y + 0.6, S[k - 1].z, S[k].x, S[k].y + 0.6, S[k].z); }
    if (far) { group.remove(far); far.geometry.dispose(); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); far = new THREE.LineSegments(g, farMat); group.add(far);
    const at = [];
    for (const ln of L) if (ln.bridge && !ln.elev) for (let k = 2; k < ln.S.length - 2; k += 2) { if (ln.S[k].deck != null) continue; const q = ln.S[k], gnd = ground(q.lon, q.lat), h = q.y - 1.3 - gnd; if (h > 1.5) at.push(q.x, gnd, q.z, h); }
    if (piers) { group.remove(piers); piers.geometry.dispose(); }
    piers = new THREE.InstancedMesh(new THREE.BoxGeometry(3.2, 1, 1.4), pierMat, Math.max(1, at.length / 4)); piers.count = at.length / 4;
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < at.length / 4; i++) piers.setMatrixAt(i, m4.makeScale(1, at[i * 4 + 3], 1).setPosition(at[i * 4], at[i * 4 + 1] + at[i * 4 + 3] / 2, at[i * 4 + 2]));
    group.add(piers);
    // (v1155) an el's steel: under each track every 20 m, a pair of columns from the street to her girders, a crossbeam on them
    const cols = [], beams = [];
    for (const ln of L) if (ln.elev) { const S = ln.S, n = S.length; for (let k = 0; k < n; k++) {
      if (S[k].deck != null) continue;
      const q = S[k], gnd = ground(q.lon, q.lat), h = q.y - 1.35 - gnd; if (h < 2.5) continue;
      const a = S[Math.max(0, k - 1)], b = S[Math.min(n - 1, k + 1)], tl = Math.hypot(b.x - a.x, b.z - a.z) || 1, nx = -(b.z - a.z) / tl, nz = (b.x - a.x) / tl;
      for (const o of [-1.6, 1.6]) cols.push(q.x + nx * o, gnd, q.z + nz * o, h);
      beams.push(q.x, q.y - 1.6, q.z, Math.atan2(nx, nz));
    } }
    for (const m of [elCols, elBeams]) if (m) { group.remove(m); m.geometry.dispose(); }
    elCols = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 1, 0.42), steelMat, Math.max(1, cols.length / 4)); elCols.count = cols.length / 4;
    for (let i = 0; i < cols.length / 4; i++) elCols.setMatrixAt(i, m4.makeScale(1, cols[i * 4 + 3], 1).setPosition(cols[i * 4], cols[i * 4 + 1] + cols[i * 4 + 3] / 2, cols[i * 4 + 2]));
    elBeams = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.55, 4.0), steelMat, Math.max(1, beams.length / 4)); elBeams.count = beams.length / 4;
    const e3 = new THREE.Euler(), qq = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), at3 = new THREE.Vector3();
    for (let i = 0; i < beams.length / 4; i++) elBeams.setMatrixAt(i, m4.compose(at3.set(beams[i * 4], beams[i * 4 + 1], beams[i * 4 + 2]), qq.setFromEuler(e3.set(0, beams[i * 4 + 3], 0)), one));
    group.add(elCols, elBeams);
  }

  // the samples by 40 m cell, for the trains' heights
  const CELL = 40; let grid = new Map();
  function index() {
    grid = new Map();
    for (const ln of L) ln.S.forEach((p, k) => { const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`; (grid.get(key) || grid.set(key, []).get(key)).push(ln, k); });
  }
  // the rails' top under (x, z): the nearest sample within reach (12 m), eased toward its neighbour along her
  function yAt(x, z, reach = 12) {
    let best = null, bd = (reach + 10) ** 2; const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const r = Math.ceil((reach + 10) / CELL);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) { const c = grid.get(`${cx + i},${cz + j}`); if (!c) continue; for (let q = 0; q < c.length; q += 2) { const p = c[q].S[c[q + 1]], d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; best = [c[q], c[q + 1]]; } } }
    if (!best) return null;
    // (v1127) on the nearest piece between two samples (not the nearest sample: samples are 20 m apart, and the
    // parallel track's 4.5 m off was often nearer, its height a step from hers)
    let by = null, bq = Infinity;
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) { const c = grid.get(`${cx + i},${cz + j}`); if (!c) continue; for (let q = 0; q < c.length; q += 2) {
      const S = c[q].S, k = c[q + 1];
      for (const k2 of [k - 1, k + 1]) { const a = S[k], b = S[k2]; if (!b) continue;
        const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz, f = L2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2)) : 0, d = (a.x + dx * f - x) ** 2 + (a.z + dz * f - z) ** 2;
        if (d < bq) { bq = d; by = a.y + (b.y - a.y) * f; } }
    } }
    return by + RAIL_H;
  }

  function all() { for (const ln of L) profile(ln); joinEnds(L); for (const ch of chunks.values()) build(ch); buildFar(); index(); }
  all();
  let farDirty = false;
  return {
    group, yAt,
    // the ground under w..e, s..n has changed: her heights there taken again
    // (v1126) the rail bridge models' decks ([[{x, z, h}]]): the lines on them given their heights again
    setDecks(D, R = []) {   // (v1155: R, the road bridges' decks, for an el's pieces on them)
      const cells = Q => { const M = new Map(); for (const P of Q) for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i], seg = [a, b];
        const x0 = Math.floor(Math.min(a.x, b.x) / 40) - 1, x1 = Math.floor(Math.max(a.x, b.x) / 40) + 1, z0 = Math.floor(Math.min(a.z, b.z) / 40) - 1, z1 = Math.floor(Math.max(a.z, b.z) / 40) + 1;
        for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) { const k = `${cx},${cz}`; (M.get(k) || M.set(k, []).get(k)).push(seg); }
      } return M; };
      decks = cells(D); roads = L.some(ln => ln.elev) ? cells(R || []) : new Map();
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
      for (const ch of chunks.values()) { const v = Math.hypot(ch.x - vx, ch.z - vz) < R + 4000; if (ch.bed) ch.bed.visible = v; if (ch.steel) ch.steel.visible = v; if (ch.rails) ch.rails.visible = v && dist < 1500; }
      if (far) far.visible = dist > FAR * 0.6;
    },
  };
}
