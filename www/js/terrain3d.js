// Shared by the 3D helm view (helm3d.js) and the bird's-eye bay view (bay3d.js): world
// coordinates, cached downloads, USGS 3DEP elevation, USDA NAIP photos, terrain meshes, and the
// prebuilt town buildings. Moved out of helm3d.js unchanged (v844) so both views use one copy.
import * as THREE from 'three';

// World frame: metres east (x) and south (z) of a fixed origin in mid Penobscot Bay; y up.
export const LON0 = -68.87, LAT0 = 44.12, MX = 111320 * Math.cos(LAT0 * Math.PI / 180), MY = 111120;
export const wx = lon => (lon - LON0) * MX, wz = lat => -(lat - LAT0) * MY;

// ── Cached fetches (Cache Storage, so a second run, or one offline, needs no network) ──
const CACHE_NAME = 'audiochart-helm3d-v1';
export const cacheP = ('caches' in window) ? caches.open(CACHE_NAME).catch(() => null) : Promise.resolve(null);
export async function cachedFetch(url, key = url) {
  const c = await cacheP;
  if (c) { const hit = await c.match(key); if (hit) return hit; }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  if (c) c.put(key, res.clone()).catch(() => {});
  return res;
}
export const SYNTH = location.origin + '/__helm3d/';
export const tlog = window.__helm3dLog = []; const T0 = performance.now(); export const tmark = (what) => tlog.push(`${Math.round(performance.now() - T0)} ${what}`);   // cache keys for data we compute (never fetched)

// ── USGS 3DEP elevation: 1/3 arc-second COGs, read by window through geotiff.js ──
const COG = cell => `https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/${cell}/USGS_13_${cell}.tif`;
const cogs = new Map();
const cogFor = cell => { if (!cogs.has(cell)) cogs.set(cell, GeoTIFF.fromUrl(COG(cell), { allowFullFile: false })); return cogs.get(cell); };
const cellsFor = (w, s, e, n) => {
  const out = [];
  for (let la = Math.floor(s) + 1; la <= Math.floor(n) + 1; la++) for (let lo = Math.ceil(-e); lo <= Math.ceil(-w); lo++) out.push(`n${la}w${String(lo).padStart(3, '0')}`);
  return out;
};
// level 0 = 10 m, 2 = ~37 m (the files' own overviews). Water and no-data come back as -3 m.
export async function readDem(w, s, e, n, level) {
  const key = `${SYNTH}dem/${level}/${w.toFixed(5)},${s.toFixed(5)},${e.toFixed(5)},${n.toFixed(5)}`;
  const c = await cacheP;
  if (c) {
    const hit = await c.match(key);
    if (hit) { const meta = JSON.parse(hit.headers.get('x-grid')); return { ...meta, elev: new Float32Array(await hit.arrayBuffer()) }; }
  }
  // open every 1°-square file the window touches at once, then read them all in parallel
  const opened = (await Promise.all(cellsFor(w, s, e, n).map(async cell => {
    let tiff; try { tiff = await cogFor(cell); } catch (_) { return null; }   // no file = open ocean or outside coverage
    const img0 = await tiff.getImage(0), img = await tiff.getImage(Math.min(level, (await tiff.getImageCount()) - 1));
    const [ox, oy] = img0.getOrigin(), f = img0.getWidth() / img.getWidth();
    return { img, ox, oy, dx: img0.getResolution()[0] * f, dy: -img0.getResolution()[1] * f };
  }))).filter(Boolean);
  tmark(`dem L${level} opened ${opened.length}`);
  let grid = null;
  if (opened.length) {
    const { ox, oy, dx, dy } = opened[0];
    const west = ox + Math.floor((w - ox) / dx) * dx, north = oy - Math.floor((oy - n) / dy) * dy;
    const gw = Math.ceil((e - west) / dx), gh = Math.ceil((north - s) / dy);
    grid = { w: gw, h: gh, west, north, dx, dy, elev: new Float32Array(gw * gh).fill(-3) };
    await Promise.all(opened.map(async ({ img, ox, oy, dx, dy }) => {
      const x0 = Math.round((grid.west - ox) / dx), y0 = Math.round((oy - grid.north) / dy);
      const win = [Math.max(0, x0), Math.max(0, y0), Math.min(img.getWidth(), x0 + grid.w), Math.min(img.getHeight(), y0 + grid.h)];
      if (win[2] <= win[0] || win[3] <= win[1]) return;
      const data = (await img.readRasters({ window: win, samples: [0] }))[0], ww = win[2] - win[0];
      for (let y = win[1]; y < win[3]; y++) for (let x = win[0]; x < win[2]; x++) {
        const v = data[(y - win[1]) * ww + (x - win[0])];
        grid.elev[(y - y0) * grid.w + (x - x0)] = (v > 0.4 && v < 9000) ? v : -3;
      }
    }));
    tmark(`dem L${level} read`);
  }
  if (!grid) {   // nothing but water
    const dx = 1 / 10800 * (level ? 4 : 1);
    const gw = Math.ceil((e - w) / dx), gh = Math.ceil((n - s) / dx);
    grid = { w: gw, h: gh, west: w, north: n, dx, dy: dx, elev: new Float32Array(gw * gh).fill(-3) };
  }
  if (c) {
    const { elev, ...meta } = grid;
    c.put(key, new Response(elev.buffer.slice(0), { headers: { 'x-grid': JSON.stringify(meta) } })).catch(() => {});
  }
  return grid;
}

// ── USDA NAIP aerial photos through The National Map's image service ──
// The service snaps every request to square pixels in degrees, so ask for square pixels and
// account for that (v1 of the sample, which did not, was misaligned by hundreds of metres).
const NAIP = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
export async function photo(w, s, e, n, maxPx = 4000) {
  const res = Math.max(e - w, n - s) / maxPx, W = Math.round((e - w) / res), H = Math.round((n - s) / res);
  const q = new URLSearchParams({ bbox: `${w},${s},${e},${n}`, bboxSR: 4326, imageSR: 4326, size: `${W},${H}`, format: 'jpg', compressionQuality: 82 });
  tmark('photo start');
  const blob = await (await cachedFetch(`${NAIP}?${q}&f=image`)).blob();
  tmark('photo done');
  // The service grows the box about its centre until the pixels are square; the same rule here
  // reproduces the extent it reports (checked against its f=json answers to ~1e-12°), saving a
  // round trip to a service that is sometimes very slow.
  const r = Math.max((e - w) / W, (n - s) / H), cx = (w + e) / 2, cy = (s + n) / 2;
  return { img: await createImageBitmap(blob), west: cx - W * r / 2, east: cx + W * r / 2, south: cy - H * r / 2, north: cy + H * r / 2 };
}

// Sample a photo onto a DEM grid: one RGBA value per cell.
export function photoAtCells(dem, t) {
  const out = new Uint8ClampedArray(dem.w * dem.h * 4);
  const c0 = Math.max(0, Math.floor((t.west - dem.west) / dem.dx)), c1 = Math.min(dem.w, Math.ceil((t.east - dem.west) / dem.dx));
  const r0 = Math.max(0, Math.floor((dem.north - t.north) / dem.dy)), r1 = Math.min(dem.h, Math.ceil((dem.north - t.south) / dem.dy));
  if (c1 <= c0 || r1 <= r0) return out;
  const cv = document.createElement('canvas'); cv.width = c1 - c0; cv.height = r1 - r0;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.drawImage(t.img, (t.west - dem.west) / dem.dx - c0, (dem.north - t.north) / dem.dy - r0, (t.east - t.west) / dem.dx, (t.north - t.south) / dem.dy);
  const px = c.getImageData(0, 0, cv.width, cv.height).data;
  for (let r = r0; r < r1; r++) for (let x = c0; x < c1; x++) {
    const sI = ((r - r0) * cv.width + (x - c0)) * 4, d = (r * dem.w + x) * 4;
    if (px[sI + 3]) { out[d] = px[sI]; out[d + 1] = px[sI + 1]; out[d + 2] = px[sI + 2]; out[d + 3] = 255; }
  }
  return out;
}
// Tree height: the elevation is bare earth, so lift cells the photo shows as forest
// (dark, green-leaning) by a typical Maine spruce height, smoothed at the edges.
// liftAt(x, y) → 0..1 lets the 3D-tree corridor near the route use real trees instead.
export function addCanopy(dem, t, liftAt = null) {
  const { w, h } = dem, px = photoAtCells(dem, t);
  let m = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], lum = 0.3 * r + 0.59 * g + 0.11 * b;
    m[i] = (dem.elev[i] > 0.8 && px[i * 4 + 3] > 0 && lum < 105 && g >= r - 4 && g >= b - 12) ? 1 : 0;
  }
  for (let pass = 0; pass < 3; pass++) {
    const o = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      o[i] = (m[i] * 4 + m[i - 1] + m[i + 1] + m[i - w] + m[i + w]) / 8;
    }
    m = o;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (dem.elev[i] <= 0.8) continue;
    const xm = x * dem.dx * MX, ym = y * dem.dy * MY;   // metres, for a smooth stand-height variation
    const lift = liftAt ? liftAt(x, y) : 1;
    if (lift > 0) dem.elev[i] += lift * m[i] * (13 + 2.5 * Math.sin(xm / 70) * Math.cos(ym / 55) + 1.5 * Math.sin(xm / 23 + ym / 31));
  }
  dem.canopy = m;
}

// One mesh over a DEM grid (optionally only the cells under a photo), at a stride:
// 1 = every cell, 4 = every 4th, for terrain far from the boat.
export function gridMesh(dem, t, stride, mat) {
  const c0 = Math.max(0, Math.floor((t.west - dem.west) / dem.dx - 1)), c1 = Math.min(dem.w - 1, Math.ceil((t.east - dem.west) / dem.dx));
  const r0 = Math.max(0, Math.floor((dem.north - t.north) / dem.dy - 1)), r1 = Math.min(dem.h - 1, Math.ceil((dem.north - t.south) / dem.dy));
  const cols = [], rows = [];
  for (let x = c0; x < c1; x += stride) cols.push(x); cols.push(c1);
  for (let y = r0; y < r1; y += stride) rows.push(y); rows.push(r1);
  const w = cols.length, h = rows.length;
  const pos = new Float32Array(w * h * 3), uv = new Float32Array(w * h * 2), gidx = new Int32Array(w * h);
  rows.forEach((gy, y) => cols.forEach((gx, x) => {
    const gi = gy * dem.w + gx, i = y * w + x;
    const lon = dem.west + (gx + 0.5) * dem.dx, lat = dem.north - (gy + 0.5) * dem.dy;
    pos[i * 3] = wx(lon); pos[i * 3 + 1] = dem.elev[gi]; pos[i * 3 + 2] = wz(lat); gidx[i] = gi;
    uv[i * 2] = (lon - t.west) / (t.east - t.west); uv[i * 2 + 1] = (t.north - lat) / (t.north - t.south);   // ImageBitmap textures aren't flipped
  }));
  const idx = new Uint32Array((w - 1) * (h - 1) * 6); let k = 0;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const a = y * w + x, b = a + 1, c = a + w, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, mat); mesh.userData.gidx = gidx;
  return mesh;
}
export function photoMat(t, aniso = 8) {
  const tex = new THREE.Texture(t.img); tex.flipY = false; tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = aniso;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return new THREE.MeshLambertMaterial({ map: tex });
}

// Spruce for 3D trees: a tiered lathe up close, a plain cone farther off. Unit height; instances
// scale them. White material so per-instance colours show as they are. Made once, shared.
let SPRUCE = null;
export function spruce() {
  if (SPRUCE) return SPRUCE;
  const prof = [[0.06, 0], [1, 0.12], [0.45, 0.33], [0.72, 0.35], [0.3, 0.6], [0.48, 0.62], [0.02, 1]];   // tiered spruce (radius, height)
  const detailed = new THREE.LatheGeometry(prof.map(([r, h]) => new THREE.Vector2(r, h)), 6);
  const simple = new THREE.ConeGeometry(0.8, 1, 5); simple.translate(0, 0.5, 0);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  return (SPRUCE = { detailed, simple, mat });
}

// Town buildings and wharves (v833 on). Prebuilt per town by
// design/buildings/build_buildings.py: OpenStreetMap footprints, eave and ridge heights and
// ground level from USGS 3DEP lidar, roof colours from the NAIP photo. Rectangular footprints get
// a gable roof along their long side; the rest keep their outline with a flat roof. All walls
// share one mesh and all roofs another, so a whole town is two draw calls.
function townTex(draw) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  draw(cv.getContext('2d'));
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4; return t;
}
const WALL_TEX = townTex(c => {   // one window bay of one storey: clapboard, a trimmed sash window
  c.fillStyle = '#fff'; c.fillRect(0, 0, 128, 128);
  c.fillStyle = 'rgba(0,0,0,0.10)'; for (let y = 4; y < 128; y += 8) c.fillRect(0, y, 128, 1.5);
  c.fillStyle = '#f4f4f0'; c.fillRect(40, 30, 48, 66);                // trim
  c.fillStyle = '#26313a'; c.fillRect(45, 35, 38, 56);                // glass
  c.fillStyle = '#e8e8e2'; c.fillRect(45, 61, 38, 4); c.fillRect(62, 35, 4, 56);   // muntins
});
const ROOF_TEX = townTex(c => {   // asphalt shingle courses
  c.fillStyle = '#fff'; c.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 16) {
    c.fillStyle = 'rgba(0,0,0,0.16)'; c.fillRect(0, y, 128, 2);
    c.fillStyle = 'rgba(0,0,0,0.07)'; for (let x = (y / 16) % 2 ? 0 : 16; x < 128; x += 32) c.fillRect(x, y, 2, 16);
  }
});
export const BAY_M = 2.8, STOREY_M = 2.9, SHINGLE_M = 2.2;
export function buildTown(T) {   // → a Group of the town's buildings and wharves, in world coordinates
  const group = new THREE.Group(); group.name = T.name;
  const wall = { pos: [], uv: [], col: [] }, roof = { pos: [], uv: [], col: [] };
  const lin = (rgb, f = 1) => { const c = new THREE.Color().setRGB(rgb[0] / 255 * f, rgb[1] / 255 * f, rgb[2] / 255 * f, THREE.SRGBColorSpace); return [c.r, c.g, c.b]; };
  // a quad a-b-c-d (counter-clockwise seen from outside), uv per corner
  function quad(G, a, b, c, d, ua, ub, uc, ud, col) {
    for (const [p, u] of [[a, ua], [b, ub], [c, uc], [a, ua], [c, uc], [d, ud]]) { G.pos.push(...p); G.uv.push(...u); G.col.push(...col); }
  }
  function tri(G, a, b, c, ua, ub, uc, col) { for (const [p, u] of [[a, ua], [b, ub], [c, uc]]) { G.pos.push(...p); G.uv.push(...u); G.col.push(...col); } }
  let bay = BAY_M;   // window spacing; wider on big commercial and wharf buildings
  function wallStrip(ax, az, bx, bz, y0, y1, g, col) {   // outward = right of a→b when the ring is clockwise in x/z
    const L = Math.hypot(bx - ax, bz - az), u1 = L / bay, v0 = (y0 - g) / STOREY_M, v1 = (y1 - g) / STOREY_M;
    quad(wall, [ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], [0, v0], [u1, v0], [u1, v1], [0, v1], col);
  }
  for (const b of T.buildings) {
    const g = b.g ?? 2.5, foot = g - 3, eave = g + b.e, ridge = g + b.r;
    const wc = lin(b.wc, 1.12), rc = lin(b.rc, 1.08);
    let P = b.p.map(([lo, la]) => [wx(lo), wz(la)]);
    // make the ring wind so the outside is on the right of each edge (signed area in x/z)
    let A = 0; for (let i = 0; i < P.length; i++) { const [x1, z1] = P[i], [x2, z2] = P[(i + 1) % P.length]; A += x1 * z2 - x2 * z1; }
    bay = Math.abs(A) / 2 > 350 ? BAY_M * 2 : BAY_M;
    if (A < 0) P = P.reverse();
    if (b.s === 'gable') {
      // the footprint's minimum-area rectangle; ridge along its long side
      let best = null;
      for (let i = 0; i < P.length; i++) {
        const [x1, z1] = P[i], [x2, z2] = P[(i + 1) % P.length], L = Math.hypot(x2 - x1, z2 - z1); if (L < 1e-3) continue;
        const ux = (x2 - x1) / L, uz = (z2 - z1) / L; let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity;
        for (const [x, z] of P) { const a = x * ux + z * uz, c = -x * uz + z * ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
        const area = (a1 - a0) * (c1 - c0); if (!best || area < best.area) best = { area, ux, uz, a0, a1, c0, c1 };
      }
      let { ux, uz, a0, a1, c0, c1 } = best;
      if (a1 - a0 < c1 - c0) { [ux, uz] = [-uz, ux]; [a0, a1, c0, c1] = [c0, c1, -a1, -a0]; }   // u = long axis
      const at = (a, c) => [a * ux - c * uz, a * uz + c * ux];   // back to x/z
      const k = [at(a0, c0), at(a1, c0), at(a1, c1), at(a0, c1)];
      let ar = 0; for (let i = 0; i < 4; i++) { const [x1, z1] = k[i], [x2, z2] = k[(i + 1) % 4]; ar += x1 * z2 - x2 * z1; }
      if (ar < 0) k.reverse();
      for (let i = 0; i < 4; i++) wallStrip(k[i][0], k[i][1], k[(i + 1) % 4][0], k[(i + 1) % 4][1], foot, eave, g, wc);
      // gable ends: triangles on the two short sides
      const half = (c1 - c0) / 2, cm = (c0 + c1) / 2, rise = ridge - eave, vE = (eave - g) / STOREY_M, vR = (ridge - g) / STOREY_M;
      for (const a of [a0, a1]) {
        const p = at(a, c0), q = at(a, c1), m = at(a, cm), out = a === a0 ? -1 : 1;
        const [P1, P2] = (out > 0) === (ar >= 0) ? [p, q] : [q, p];
        tri(wall, [P1[0], eave, P1[1]], [P2[0], eave, P2[1]], [m[0], ridge, m[1]], [0, vE], [2 * half / bay, vE], [half / bay, vR], wc);
      }
      // roof: two slopes with a little overhang at the eaves and the gable ends
      const oh = 0.45, ohEnd = 0.3, drop = rise / half * oh, slopeLen = Math.hypot(half + oh, rise + drop) / SHINGLE_M, runLen = (a1 - a0 + 2 * ohEnd) / SHINGLE_M;
      for (const side of [-1, 1]) {
        const ce = side < 0 ? c0 - oh : c1 + oh, e0 = at(a0 - ohEnd, ce), e1 = at(a1 + ohEnd, ce), r0 = at(a0 - ohEnd, cm), r1 = at(a1 + ohEnd, cm), ye = eave - drop;
        const pts = [[e0[0], ye, e0[1]], [e1[0], ye, e1[1]], [r1[0], ridge, r1[1]], [r0[0], ridge, r0[1]]];
        const uvs = [[0, 0], [runLen, 0], [runLen, slopeLen], [0, slopeLen]];
        // both windings, so each slope shows from above whatever the rectangle's handedness
        quad(roof, pts[0], pts[1], pts[2], pts[3], uvs[0], uvs[1], uvs[2], uvs[3], rc);
        quad(roof, pts[3], pts[2], pts[1], pts[0], uvs[3], uvs[2], uvs[1], uvs[0], rc);
      }
    } else {
      for (let i = 0; i < P.length; i++) wallStrip(P[i][0], P[i][1], P[(i + 1) % P.length][0], P[(i + 1) % P.length][1], foot, eave, g, wc);
      const contour = P.map(([x, z]) => new THREE.Vector2(x, z));
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, [])) {
        const t = [P[i], P[j], P[k]].map(([x, z]) => [x, eave, z]), uv = [P[i], P[j], P[k]].map(([x, z]) => [x / SHINGLE_M, z / SHINGLE_M]);
        tri(roof, t[0], t[1], t[2], uv[0], uv[1], uv[2], rc); tri(roof, t[2], t[1], t[0], uv[2], uv[1], uv[0], rc);
      }
    }
  }
  for (const [G, map] of [[wall, WALL_TEX], [roof, ROOF_TEX]]) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(G.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(G.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(G.col, 3));
    geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, map, side: map === WALL_TEX ? THREE.DoubleSide : THREE.FrontSide })));
  }
  // wharves and piers: a plank deck at the lidar's deck height on pilings; breakwaters in granite
  const deckMat = new THREE.MeshLambertMaterial({ color: 0x8a7a64 }), pileMat = new THREE.MeshLambertMaterial({ color: 0x4b4136 }), stoneMat = new THREE.MeshLambertMaterial({ color: 0x8d877f });
  const pileGeo = new THREE.CylinderGeometry(0.18, 0.18, 1, 6), piles = [];
  for (const pr of T.piers) {
    const P = pr.p.map(([lo, la]) => [wx(lo), wz(la)]), deckY = Math.max(0.6, pr.d), stone = pr.kind === 'breakwater';
    if (pr.area && !stone) {
      const shape = new THREE.Shape(P.map(([x, z]) => new THREE.Vector2(x, -z)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.35, bevelEnabled: false }); geo.rotateX(-Math.PI / 2); geo.translate(0, deckY - 0.35, 0);
      group.add(new THREE.Mesh(geo, deckMat));
      const xs = P.map(p => p[0]), zs = P.map(p => p[1]);
      for (let x = Math.min(...xs); x <= Math.max(...xs); x += 3.5) for (let z = Math.min(...zs); z <= Math.max(...zs); z += 3.5) {
        let inside = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside; }
        if (inside) piles.push([x, z, deckY]);
      }
      continue;
    }
    for (let i = 0; i + 1 < P.length; i++) {
      const [ax, az] = P[i], [bx, bz] = P[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < 0.5) continue;
      const h = stone ? deckY + 3 : 0.35, m = new THREE.Mesh(new THREE.BoxGeometry(pr.w, h, L + (stone ? 0 : pr.w * 0.5)), stone ? stoneMat : deckMat);
      m.position.set((ax + bx) / 2, deckY - h / 2, (az + bz) / 2); m.rotation.y = Math.atan2(bx - ax, bz - az); group.add(m);
      if (!stone) for (let t = 0; t <= L; t += 3.5) for (const sgn of [-1, 1]) {
        const nx = (bz - az) / L * sgn * pr.w * 0.4, nz = -(bx - ax) / L * sgn * pr.w * 0.4;
        piles.push([ax + (bx - ax) * t / L + nx, az + (bz - az) * t / L + nz, deckY]);
      }
    }
  }
  if (piles.length) {
    const inst = new THREE.InstancedMesh(pileGeo, pileMat, piles.length), mtx = new THREE.Matrix4();
    piles.forEach(([x, z, y], i) => { const h = y + 3; inst.setMatrixAt(i, mtx.makeScale(1, h, 1).setPosition(x, y - h / 2, z)); });
    group.add(inst);
  }
  return group;
}
// Free a town (or any group) built above.
export function disposeGroup(g) {
  g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.map !== WALL_TEX && o.material.map !== ROOF_TEX) o.material.dispose?.(); });
}
