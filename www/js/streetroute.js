// Walking directions over the street map (v1214, asked: "I should be able to put in address and 'walk there on the
// sidewalk'"): the streets of www/data/streets/<area>.json (OpenStreetMap's ways, as streets3d.js draws them) as a graph,
// and the shortest way along it from one point to another. Loaded by bay3d.js on the first 📍 Walk to….
//
// The graph: a node for each point of a way (a point two ways share is their junction: OSM's own node), an edge between
// a way's consecutive points, its length in metres. Motorways are left out (no one walks them). The areas' files meet
// at only a few shared points, so a way's loose end is tied to the nearest other point within 15 m: the same street
// carried on in the next area's file, or a small gap in the map.

const CELL = 50;

// ways: [{ p: [[lon, lat], ...], w, c, n }], from any number of files; wx, wz: lon, lat → the scene's metres
export function buildGraph(ways, wx, wz) {
  const id = new Map(), xs = [], zs = [], adj = [];
  const node = (lon, lat) => {
    const k = `${lon},${lat}`; let i = id.get(k);
    if (i === undefined) { i = xs.length; id.set(k, i); xs.push(wx(lon)); zs.push(wz(lat)); adj.push([]); }
    return i;
  };
  const link = (a, b, hw, n) => { if (a === b) return; const len = Math.hypot(xs[a] - xs[b], zs[a] - zs[b]); adj[a].push({ to: b, len, hw, n }); adj[b].push({ to: a, len, hw, n }); };
  for (const r of ways) {
    if (r.c === 'mot' || !r.p || r.p.length < 2) continue;
    const hw = (r.w || 8) / 2, n = r.n || '';
    let prev = node(r.p[0][0], r.p[0][1]);
    for (let k = 1; k < r.p.length; k++) { const cur = node(r.p[k][0], r.p[k][1]); link(prev, cur, hw, n); prev = cur; }
  }
  const grid = new Map(), key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  for (let i = 0; i < xs.length; i++) { const k = key(xs[i], zs[i]); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
  const G = { xs, zs, adj, grid, key };
  // loose ends tied on (the next area's file, small gaps)
  for (let i = 0; i < xs.length; i++) {
    if (adj[i].length !== 1) continue;
    const near = nearest(G, xs[i], zs[i], 15, j => j !== i && !adj[i].some(e => e.to === j));
    if (near >= 0) link(i, near, adj[i][0].hw, '');
  }
  return G;
}

// the node nearest (x, z) within R m (that `ok` allows), or -1
export function nearest(G, x, z, R, ok = null) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), K = Math.ceil(R / CELL);
  let best = -1, bd = R;
  for (let i = -K; i <= K; i++) for (let k = -K; k <= K; k++) for (const j of G.grid.get(`${cx + i},${cz + k}`) || []) {
    const d = Math.hypot(G.xs[j] - x, G.zs[j] - z);
    if (d < bd && (!ok || ok(j))) { bd = d; best = j; }
  }
  return best;
}

// the shortest way from (sx, sz) to (tx, tz): [{ x, z, hw, n }] (each point with the half-width and name of the street
// it's reached by), its length, or null (no street near one end, or no way between them)
export function route(G, sx, sz, tx, tz) {
  const a = nearest(G, sx, sz, 300), b = nearest(G, tx, tz, 400);
  if (a < 0 || b < 0) return null;
  const N = G.xs.length, g = new Float64Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), via = new Array(N), done = new Uint8Array(N);
  const h = i => Math.hypot(G.xs[i] - G.xs[b], G.zs[i] - G.zs[b]);
  const heap = [];   // [f, node], a binary heap on f
  const push = (f, i) => { heap.push([f, i]); let c = heap.length - 1; while (c) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
  g[a] = 0; push(h(a), a);
  while (heap.length) {
    const [, i] = pop(); if (done[i]) continue; done[i] = 1;
    if (i === b) break;
    for (const e of G.adj[i]) {
      const ng = g[i] + e.len;
      if (ng < g[e.to]) { g[e.to] = ng; from[e.to] = i; via[e.to] = e; push(ng + h(e.to), e.to); }
    }
  }
  if (!done[b]) return null;
  const pts = [];
  for (let i = b; i >= 0; i = from[i]) { const e = via[i]; pts.push({ x: G.xs[i], z: G.zs[i], hw: e?.hw ?? 4, n: e?.n ?? '' }); }
  pts.reverse();
  return { pts, len: g[b] };
}

// the way moved over to the right-hand sidewalk: each point pushed off to the right of the way you're going, past its
// street's roadway (the way's half-width) and 2.6 m onto the sidewalk, the corners mitred
// inside(x, z): true in a building. The way is first cut into 3 m steps, and a step that lands in one (the map's street
// line and its buildings don't always agree: the west side of 6th Av at Herald Square) is drawn back toward the
// roadway, half a metre at a time, until it's clear (at most onto the kerb's edge of the roadway)
export function sidewalk(pts, inside = null) {
  const P0 = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 0.5), P = [];
  P0.forEach((p, i) => {
    if (i) { const a = P0[i - 1], L = Math.hypot(p.x - a.x, p.z - a.z), k = Math.floor(L / 3); for (let j = 1; j < k; j++) P.push({ x: a.x + (p.x - a.x) * j / k, z: a.z + (p.z - a.z) * j / k, hw: p.hw, n: p.n }); }
    P.push(p);
  });
  if (P.length < 2) return P.map(p => ({ x: p.x, z: p.z, n: p.n }));
  const seg = []; for (let i = 0; i + 1 < P.length; i++) { const dx = P[i + 1].x - P[i].x, dz = P[i + 1].z - P[i].z, L = Math.hypot(dx, dz); seg.push({ rx: -dz / L, rz: dx / L, d: P[i + 1].hw + 2.6 }); }   // (the sidewalk: from the roadway's edge out 4.2 m, streets3d.js; you 2.6 m out on it, clear of the kiosks and lamps by the kerb, 1.6 m off the buildings)
  return P.map((p, i) => {
    const s0 = seg[Math.max(0, i - 1)], s1 = seg[Math.min(seg.length - 1, i)], d = Math.min(s0.d, s1.d);
    let nx = s0.rx + s1.rx, nz = s0.rz + s1.rz; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
    const k = Math.min(2, 1 / Math.max(0.5, nx * s1.rx + nz * s1.rz));   // (the mitre: further out at a corner, not too far)
    let D = d * k; const floor = Math.min(D, Math.max(1, d - 2.6));
    while (inside && D > floor && inside(p.x + nx * D, p.z + nz * D)) D = Math.max(floor, D - 0.5);
    return { x: p.x + nx * D, z: p.z + nz * D, n: p.n };
  });
}
