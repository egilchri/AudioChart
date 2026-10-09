// AudioChart 3D helm view: a route sailed from the tiller of a Cape Dory 25D, built at runtime
// from USGS 3DEP elevation and USDA NAIP aerial photos (both allow cross-origin reads), with
// buoys, lights and names from the region's chart data. Opened from the Routes panel
// (helm3d.html?route=<id>) or for a sample (?sample=<curated id>). Desktop browser with WebGL.
import * as THREE from 'three';
import { Water } from './lib/three/Water.js';

const statusEl = document.getElementById('status');
const loadingNote = document.getElementById('tileload');
const fail = (msg) => { statusEl.textContent = msg; statusEl.hidden = false; };
window.addEventListener('error', e => fail('Something went wrong: ' + e.message));
const setStatus = (msg) => { statusEl.textContent = msg; };

const LON0 = -68.87, LAT0 = 44.12, MX = 111320 * Math.cos(LAT0 * Math.PI / 180), MY = 111120;
const wx = lon => (lon - LON0) * MX, wz = lat => -(lat - LAT0) * MY;
const EYE = 2.0, NM = 1852;   // seated at the tiller
// Rockland Breakwater: not in the elevation data (water is flattened there); traced from the photo.
const BREAKWATER = [[-69.08197, 44.11540], [-69.07751, 44.10410]];

async function main() {
// ── Route and region ────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
if (params.get('embed')) document.body.classList.add('embed');   // inside AudioChart during a Virtual Journey
const REGIONS = ['penobscot-bay', 'casco-bay', 'piscataqua'];
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`Could not load ${url}`); return r.json(); }
async function findRoute() {
  const id = params.get('route'), sample = params.get('sample');
  if (id) {
    let routes = [];
    try { routes = JSON.parse(localStorage.getItem('audiochart-user-routes') || '[]'); } catch (_) {}
    const r = routes.find(x => x.id === id) || routes.find(x => x.name === id);
    if (r) return { id: r.id || r.name, name: r.name, points: r.points.map(p => [p.lon, p.lat]) };
  }
  if (sample) {
    for (const url of [...REGIONS.map(g => `./data/regions/${g}/curated_routes.json`), './data/curated_routes.json']) {
      let list; try { list = await getJSON(url); } catch (_) { continue; }
      const r = list.find(x => x.id === sample);
      if (r) return { id: r.id, name: r.name, points: r.points.map(p => Array.isArray(p) ? p : [p.lon, p.lat]) };
    }
  }
  return null;
}
async function regionFor(lon, lat) {
  for (const g of REGIONS) {
    try {
      const b = await getJSON(`./data/regions/${g}/chart_bounds.geojson`);
      const ring = b.features[0].geometry.coordinates[0], xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
      if (lon >= Math.min(...xs) && lon <= Math.max(...xs) && lat >= Math.min(...ys) && lat <= Math.max(...ys)) return `./data/regions/${g}`;
    } catch (_) {}
  }
  return './data';
}

// ── Cached fetches (Cache Storage, so a second run, or one offline, needs no network) ──
const CACHE_NAME = 'audiochart-helm3d-v1';
const cacheP = ('caches' in window) ? caches.open(CACHE_NAME).catch(() => null) : Promise.resolve(null);
async function cachedFetch(url, key = url) {
  const c = await cacheP;
  if (c) { const hit = await c.match(key); if (hit) return hit; }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  if (c) c.put(key, res.clone()).catch(() => {});
  return res;
}
const SYNTH = location.origin + '/__helm3d/';
const tlog = window.__helm3dLog = []; const T0 = performance.now(); const tmark = (what) => tlog.push(`${Math.round(performance.now() - T0)} ${what}`);   // cache keys for data we compute (never fetched)

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
async function readDem(w, s, e, n, level) {
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
async function photo(w, s, e, n, maxPx = 4000) {
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
function photoAtCells(dem, t) {
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
function addCanopy(dem, t, liftAt = null) {
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
function gridMesh(dem, t, stride, mat) {
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
function photoMat(t) {
  const tex = new THREE.Texture(t.img); tex.flipY = false; tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return new THREE.MeshLambertMaterial({ map: tex });
}

// ── Route geometry ──
function routeDist(px, pz) {
  let best = Infinity;
  for (let i = 1; i < routeW.length; i++) {
    const [ax, az] = routeW[i - 1], [bx, bz] = routeW[i], dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
    const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L)) : 0;
    best = Math.min(best, Math.hypot(px - ax - t * dx, pz - az - t * dz));
  }
  return best;
}

// ── Near tiles: 0.07° × 0.045° (≈5.6 × 5 km) of 10 m elevation + one photo each, within
// NEAR_M of the route. Streamed: loaded as the boat comes within LOAD_M, dropped past DROP_M,
// so a long passage never holds more than a handful in memory.
const TW = 0.07, TH = 0.045, NEAR_M = 2500, LOAD_M = 4500, DROP_M = 7000, LOD_NEAR_M = 2500;
const CORRIDOR = 1500, FADE = 300, DETAIL = 600;
function nearTiles() {
  const lons = routeLL.map(p => p[0]), lats = routeLL.map(p => p[1]), out = [];
  for (let x = Math.floor((Math.min(...lons) - 0.04) / TW) * TW; x < Math.max(...lons) + 0.04; x += TW)
    for (let y = Math.floor((Math.min(...lats) - 0.03) / TH) * TH; y < Math.max(...lats) + 0.03; y += TH) {
      const w = +x.toFixed(4), s = +y.toFixed(4), e = +(x + TW).toFixed(4), n = +(y + TH).toFixed(4);
      let best = Infinity;
      for (let i = 0; i <= 8 && best >= NEAR_M; i++) for (let j = 0; j <= 8; j++) best = Math.min(best, routeDist(wx(w + (e - w) * i / 8), wz(s + (n - s) * j / 8)));
      if (best < NEAR_M) out.push({ w, s, e, n, x0: wx(w), x1: wx(e), z0: wz(n), z1: wz(s), state: 'idle' });
    }
  return out;
}
const rectDist = (T, px, pz) => Math.hypot(Math.max(T.x0 - px, 0, px - T.x1), Math.max(T.z0 - pz, 0, pz - T.z1));

let SPRUCE_DETAILED = null, SPRUCE_SIMPLE = null, TREE_MAT = null;
function treeGeoms() {
  if (SPRUCE_DETAILED) return;
  const prof = [[0.06, 0], [1, 0.12], [0.45, 0.33], [0.72, 0.35], [0.3, 0.6], [0.48, 0.62], [0.02, 1]];   // tiered spruce (radius, height)
  SPRUCE_DETAILED = new THREE.LatheGeometry(prof.map(([r, h]) => new THREE.Vector2(r, h)), 6);
  SPRUCE_SIMPLE = new THREE.ConeGeometry(0.8, 1, 5); SPRUCE_SIMPLE.translate(0, 0.5, 0);
  TREE_MAT = new THREE.MeshLambertMaterial({ color: 0xffffff });
}
// Plain land colour shown until a tile's aerial photo arrives, so the view can start on the
// elevation alone (fast) while the photos (slow, from a busy service) fill in.
const PLAIN = new THREE.MeshLambertMaterial({ color: 0x66735c });
// Tiles load in two steps: elevation → plain terrain, ready to sail over; then, in the
// background, the photo → canopy height, photo texture and spruce.
async function loadTile(T) {
  T.state = 'loading'; const gen = (T.gen = (T.gen || 0) + 1);
  try {
    const M = 0.0002;   // ~2 cells of overlap so neighbouring tiles meet
    const photoP = photo(T.w, T.s, T.e, T.n); photoP.catch(() => {});   // starts now, alongside the elevation
    const dem = await readDem(T.w - M, T.s - M, T.e + M, T.n + M, 0);
    if (T.state !== 'loading' || T.gen !== gen) { photoP.then(ph => ph.img.close?.(), () => {}); return; }   // dropped meanwhile
    const rect = { west: T.w, east: T.e, south: T.s, north: T.n };
    Object.assign(T, { dem, mat: PLAIN, img: null, trees: [], photo: 'pending',
      full: gridMesh(dem, rect, 1, PLAIN), coarse: gridMesh(dem, rect, 4, PLAIN) });
    T.full.visible = false;
    scene.add(T.full, T.coarse);
    sinkFar(T, true);
    T.state = 'ready';
    photoP.then(ph => dressTile(T, gen, ph)).catch(err => { console.warn('[helm3d] photo failed', T, err); T.photo = 'failed'; });
  } catch (err) {
    console.warn('[helm3d] tile failed', T, err);
    T.state = 'failed';
  }
}
function dressTile(T, gen, ph) {
  if (T.state !== 'ready' || T.gen !== gen) { ph.img.close?.(); return; }   // dropped or reloaded meanwhile
  const dem = T.dem;
  const rd = new Float32Array(dem.w * dem.h);
  for (let y = 0; y < dem.h; y += 4) for (let x = 0; x < dem.w; x += 4) {
    const d = routeDist(wx(dem.west + (x + 0.5) * dem.dx), wz(dem.north - (y + 0.5) * dem.dy));
    for (let yy = y; yy < Math.min(dem.h, y + 4); yy++) for (let xx = x; xx < Math.min(dem.w, x + 4); xx++) rd[yy * dem.w + xx] = d;
  }
  addCanopy(dem, ph, (x, y) => Math.max(0, Math.min(1, (rd[y * dem.w + x] - CORRIDOR) / FADE)));
  const mat = photoMat(ph), wasNear = T.full.visible;
  scene.remove(T.full, T.coarse); T.full.geometry.dispose(); T.coarse.geometry.dispose();
  T.full = gridMesh(dem, ph, 1, mat); T.coarse = gridMesh(dem, ph, 4, mat);
  T.full.visible = wasNear; T.coarse.visible = !wasNear;
  T.mat = mat; T.img = ph.img;
  // spruce in the corridor, one per forested 10 m cell, jittered and varied
  treeGeoms();
  let seed = Math.round((T.w + 200) * 1e4 + T.s * 1e3); const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const spots = [];
  for (let y = 1; y < dem.h - 1; y++) for (let x = 1; x < dem.w - 1; x++) {
    const i = y * dem.w + x;
    if (rd[i] > CORRIDOR + FADE * rnd() || dem.elev[i] <= 0.6 || dem.canopy[i] < 0.45) continue;
    const lon = dem.west + (x + rnd()) * dem.dx, lat = dem.north - (y + rnd()) * dem.dy;
    if (lon < T.w || lon >= T.e || lat < T.s || lat >= T.n) continue;   // the overlap belongs to the neighbour
    spots.push([wx(lon), dem.elev[i], wz(lat), rd[i] < DETAIL]);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  for (const detail of [true, false]) {
    const set = spots.filter(sp => sp[3] === detail); if (!set.length) continue;
    const trees = new THREE.InstancedMesh(detail ? SPRUCE_DETAILED : SPRUCE_SIMPLE, TREE_MAT, set.length);
    set.forEach(([x, y, z], j) => {
      const hgt = 9 + rnd() * 10, r = hgt * (0.19 + rnd() * 0.08);
      pv.set(x, y - 0.5, z); sc.set(r, hgt, r); q.setFromAxisAngle(up, rnd() * 6.28);
      trees.setMatrixAt(j, m4.compose(pv, q, sc));
      col.setRGB(0.055 + rnd() * 0.035, 0.09 + rnd() * 0.05, 0.07 + rnd() * 0.03); trees.setColorAt(j, col);
    });
    T.trees.push(trees);
  }
  scene.add(T.full, T.coarse, ...T.trees);
  T.photo = 'done';
}
function dropTile(T) {
  if (T.state === 'loading') { T.state = 'idle'; return; }
  if (T.state !== 'ready') return;
  scene.remove(T.full, T.coarse, ...T.trees);
  T.full.geometry.dispose(); T.coarse.geometry.dispose();
  if (T.mat !== PLAIN) { T.mat.map.dispose(); T.mat.dispose(); }
  T.img?.close?.();
  for (const tr of T.trees) tr.dispose();
  sinkFar(T, false);
  Object.assign(T, { state: 'idle', full: null, coarse: null, trees: null, dem: null, mat: null, img: null, photo: null });
}
let tiles = [], loadingCount = 0;
function updateTiles(px, pz) {
  for (const T of tiles) {
    const d = rectDist(T, px, pz);
    if (T.state === 'ready') { const nearT = d < LOD_NEAR_M; T.full.visible = nearT; T.coarse.visible = !nearT; }
    if (d > DROP_M && (T.state === 'ready' || T.state === 'loading')) dropTile(T);
  }
  const want = tiles.filter(T => T.state === 'idle' && rectDist(T, px, pz) < LOAD_M).sort((a, b) => rectDist(a, px, pz) - rectDist(b, px, pz));
  while (loadingCount < 2 && want.length) {
    const T = want.shift(); loadingCount++;
    loadTile(T).finally(() => { loadingCount--; });
  }
  const near = tiles.filter(T => rectDist(T, px, pz) < LOD_NEAR_M);
  loadingNote.textContent = near.some(T => T.state === 'loading') ? 'Loading terrain ahead…' : 'Loading aerial photos…';
  loadingNote.hidden = !near.some(T => T.state === 'loading' || (T.state === 'ready' && T.photo === 'pending'));
}

// ── Far terrain: ~37 m elevation + one photo out to the horizon ──
let far = null, buildChart = null;   // buildChart is set once the corner chart exists
const farBbox = () => {
  const lons = routeLL.map(p => p[0]), lats = routeLL.map(p => p[1]);
  return [Math.min(...lons) - 0.2, Math.min(...lats) - 0.15, Math.max(...lons) + 0.2, Math.max(...lats) + 0.15];
};
async function loadFar() {
  const [W, S0, E, N] = farBbox();
  const photoP = photo(W, S0, E, N, 2048); photoP.catch(() => {});   // 2048 px is plenty this far off
  const dem = await readDem(W, S0, E, N, 2);
  const stride = dem.w * dem.h > 3e6 ? 2 : 1;
  const mesh = gridMesh(dem, { west: W, east: E, south: S0, north: N }, stride, PLAIN);
  scene.add(mesh);
  far = { dem, mesh, bbox: [W, S0, E, N] };
  for (const T of tiles) if (T.state === 'ready') sinkFar(T, true);   // tiles that arrived first
  buildChart?.();
  photoP.then(ph => {   // drape the photo when it comes
    addCanopy(dem, ph);
    const m2 = gridMesh(dem, ph, stride, photoMat(ph));
    scene.remove(far.mesh); far.mesh.geometry.dispose();
    far.mesh = m2; scene.add(m2);
    for (const T of tiles) if (T.state === 'ready') sinkFar(T, true);
  }).catch(err => console.warn('[helm3d] horizon photo failed', err));
}
// Lower the coarse terrain under a loaded near tile (and restore it when the tile is dropped).
function sinkFar(T, down) {
  if (!far) return;
  const pos = far.mesh.geometry.attributes.position, gidx = far.mesh.userData.gidx, d = far.dem, inset = 0.0004;
  for (let i = 0; i < gidx.length; i++) {
    const gi = gidx[i], gx = gi % d.w, gy = (gi - gx) / d.w;
    const lon = d.west + (gx + 0.5) * d.dx, lat = d.north - (gy + 0.5) * d.dy;
    if (lon > T.w + inset && lon < T.e - inset && lat > T.s + inset && lat < T.n - inset) pos.setY(i, down ? -20 : d.elev[gi]);
  }
  pos.needsUpdate = true;
}
function heightAt(lon, lat) {
  for (const T of tiles) {
    if (T.state !== 'ready' || lon < T.w || lon >= T.e || lat < T.s || lat >= T.n) continue;
    const d = T.dem, c = Math.floor((lon - d.west) / d.dx), r = Math.floor((d.north - lat) / d.dy);
    return d.elev[r * d.w + c];
  }
  if (!far) return -3;
  const d = far.dem, c = Math.floor((lon - d.west) / d.dx), r = Math.floor((d.north - lat) / d.dy);
  return (c >= 0 && r >= 0 && c < d.w && r < d.h) ? d.elev[r * d.w + c] : -3;
}

const ROUTE = await findRoute();
if (!ROUTE) { showChooser(); return; }
document.title = `${ROUTE.name} · 3D`;
document.getElementById('route-name').textContent = ROUTE.name;
const routeLL = ROUTE.points;
const routeW = routeLL.map(([x, y]) => [wx(x), wz(y)]);
const regionDir = await regionFor(routeLL[0][0], routeLL[0][1]);
setStatus('Loading chart data…');
const [navGJ, placesGJ] = await Promise.all([getJSON(`${regionDir}/navaid.geojson`), getJSON(`${regionDir}/named_places.geojson`)]);

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(1.25, devicePixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
const sceneEl = document.getElementById('scene');
sceneEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 2, 0.3, 80000);
const HAZE = new THREE.Color(0xb2cbe0);   // distant haze, a clear-day blue
scene.fog = new THREE.FogExp2(HAZE, 0.000075);

const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 32), THREE.MathUtils.degToRad(205));
scene.add(new THREE.HemisphereLight(0xe4ecf2, 0x4a5644, 1.7));
const dl = new THREE.DirectionalLight(0xfff3e0, 2.1); dl.position.copy(sun).multiplyScalar(1000); scene.add(dl);


setStatus('Downloading terrain…');
tiles = nearTiles();
{   // the horizon and the tiles around the start, all at once; photos keep arriving afterwards
  const [sx, sz] = routeW[0], first = tiles.filter(T => rectDist(T, sx, sz) < LOD_NEAR_M);
  // sail as soon as the start tiles are in; the horizon (bigger, slower) fills in a moment later
  loadFar().catch(err => console.warn('[helm3d] horizon failed', err));
  await Promise.all(first.map(loadTile));
}
const [FW, FS, FE, FN] = farBbox(), inFar = ([x, y]) => x >= FW && x <= FE && y >= FS && y <= FN;
const BREAKWATER_IN_VIEW = BREAKWATER.every(inFar);
const nav = navGJ.features.filter(f => inFar(f.geometry.coordinates) && ['BOYLAT', 'BCNLAT', 'BOYSAW', 'BOYSPP', 'BOYCAR', 'BOYISD', 'LIGHTS'].includes(f.properties.objtype))
  .map(f => ({ t: f.properties.objtype, n: f.properties.name, c: f.properties.colour, s: f.properties.shape, ch: f.properties.characteristic, x: f.geometry.coordinates[0], y: f.geometry.coordinates[1] }));
const places = placesGJ.features.filter(f => f.geometry.type === 'Point' && inFar(f.geometry.coordinates) && ['LNDARE', 'LNDRGN', 'LIGHTS', 'BUAARE'].includes(f.properties.objtype))
  .map(f => ({ t: f.properties.objtype, n: f.properties.name, x: f.geometry.coordinates[0], y: f.geometry.coordinates[1] }));

// Rockland Breakwater: granite, ~1.4 km, not in the elevation data (water is flattened there),
// traced from the aerial photo. The lighthouse sits on its outer end.
if (BREAKWATER_IN_VIEW) {
  const [[lo0, la0], [lo1, la1]] = BREAKWATER;
  const ax = wx(lo0), az = wz(la0), bx = wx(lo1), bz = wz(la1), len = Math.hypot(bx - ax, bz - az);
  const bw = new THREE.Mesh(new THREE.BoxGeometry(7, 9, len), new THREE.MeshLambertMaterial({ color: 0x8d877f }));
  bw.position.set((ax + bx) / 2, -0.5, (az + bz) / 2); bw.rotation.y = Math.atan2(bx - ax, bz - az);
  scene.add(bw);
  const g = new THREE.Group(), white = new THREE.MeshLambertMaterial({ color: 0xf1eee6 });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(16, 1, 16), new THREE.MeshLambertMaterial({ color: 0x8d877f })); deck.position.y = 3.5; g.add(deck);
  const house = new THREE.Mesh(new THREE.BoxGeometry(9, 6, 7), white); house.position.set(-1.5, 7, 1); g.add(house);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(6.2, 3, 4), new THREE.MeshLambertMaterial({ color: 0x7a2f26 }));
  roof.position.set(-1.5, 11.5, 1); roof.rotation.y = Math.PI / 4; roof.scale.set(1.05, 1, 0.82); g.add(roof);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(3, 11, 3), white); tower.position.set(3.5, 9.5, -2); g.add(tower);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 2, 8), new THREE.MeshLambertMaterial({ color: 0x262626 })); lantern.position.set(3.5, 16, -2); g.add(lantern);
  g.position.set(bx, 0, bz); g.rotation.y = Math.atan2(bx - ax, bz - az);
  scene.add(g);
}

// Town buildings and wharves (v833: Carvers Harbor). Prebuilt per town by
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
const BAY_M = 2.8, STOREY_M = 2.9, SHINGLE_M = 2.2;
async function addTowns() {
  let list;
  try { list = await getJSON('./data/buildings/index.json'); } catch (_) { return; }
  const lons = routeLL.map(p => p[0]), lats = routeLL.map(p => p[1]), padLon = 0.06, padLat = 0.045;
  for (const town of list) {
    const [w, s, e, n] = town.bbox;
    if (e < Math.min(...lons) - padLon || w > Math.max(...lons) + padLon || n < Math.min(...lats) - padLat || s > Math.max(...lats) + padLat) continue;
    try { buildTown(await getJSON(`./data/buildings/${town.file}`)); } catch (err) { console.warn('[helm3d] buildings', town.file, err); }
  }
}
function buildTown(T) {
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
    scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, map, side: map === WALL_TEX ? THREE.DoubleSide : THREE.FrontSide })));
  }
  // wharves and piers: a plank deck at the lidar's deck height on pilings; breakwaters in granite
  const deckMat = new THREE.MeshLambertMaterial({ color: 0x8a7a64 }), pileMat = new THREE.MeshLambertMaterial({ color: 0x4b4136 }), stoneMat = new THREE.MeshLambertMaterial({ color: 0x8d877f });
  const pileGeo = new THREE.CylinderGeometry(0.18, 0.18, 1, 6), piles = [];
  for (const pr of T.piers) {
    const P = pr.p.map(([lo, la]) => [wx(lo), wz(la)]), deckY = Math.max(0.6, pr.d), stone = pr.kind === 'breakwater';
    if (pr.area && !stone) {
      const shape = new THREE.Shape(P.map(([x, z]) => new THREE.Vector2(x, -z)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.35, bevelEnabled: false }); geo.rotateX(-Math.PI / 2); geo.translate(0, deckY - 0.35, 0);
      scene.add(new THREE.Mesh(geo, deckMat));
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
      m.position.set((ax + bx) / 2, deckY - h / 2, (az + bz) / 2); m.rotation.y = Math.atan2(bx - ax, bz - az); scene.add(m);
      if (!stone) for (let t = 0; t <= L; t += 3.5) for (const sgn of [-1, 1]) {
        const nx = (bz - az) / L * sgn * pr.w * 0.4, nz = -(bx - ax) / L * sgn * pr.w * 0.4;
        piles.push([ax + (bx - ax) * t / L + nx, az + (bz - az) * t / L + nz, deckY]);
      }
    }
  }
  if (piles.length) {
    const inst = new THREE.InstancedMesh(pileGeo, pileMat, piles.length), mtx = new THREE.Matrix4();
    piles.forEach(([x, z, y], i) => { const h = y + 3; inst.setMatrixAt(i, mtx.makeScale(1, h, 1).setPosition(x, y - h / 2, z)); });
    scene.add(inst);
  }
  let c = document.getElementById('town-credit');
  if (!c) {
    c = document.createElement('div'); c.id = 'town-credit'; c.textContent = 'Buildings © OpenStreetMap contributors';
    c.style.cssText = 'position:absolute;left:8px;bottom:6px;z-index:2;font-size:10px;color:rgba(255,255,255,0.75);text-shadow:0 0 3px rgba(0,0,0,0.6);pointer-events:none';
    document.querySelector('.scene').appendChild(c);
  }
  if (/Microsoft/.test(T.credit || '') && !/Microsoft/.test(c.textContent)) c.textContent += ', Microsoft';   // gaps filled from Microsoft's footprints
  console.log(`[helm3d] ${T.name}: ${T.buildings.length} buildings, ${T.piers.length} piers`);
}
addTowns();

// Cape Dory 25D (Alberg design: 25 ft LOA, 8 ft beam), seen from the tiller. Boat frame:
// y up from the waterline, -z forward, x to starboard; the helmsman's eye is at (0.35, EYE, 0).
// mainsail and jib, set while sailing in Drone view (see the sails in the model below); heel eases in with them
let setSails = () => {}, sailsUp = false, heel = 0;
const bow = new THREE.Group();
{
  const M = c => new THREE.MeshLambertMaterial({ color: c });
  const BUFF = M(0xe4d9bf), WHITE = M(0xf3f0e8), TEAK = M(0x93613a), BRONZE = M(0xa8743a), STEEL = M(0xc3cacf);
  const SPAR = M(0xd8dcdf), COVER = M(0x22304d), GLASS = M(0x1d2a30);
  const Z0 = -0.9, ZS = -5.0, L = ZS - Z0;                  // cockpit bulkhead → stem
  const tOf = z => (z - Z0) / L;                             // 0 at cockpit, 1 at stem
  const half = z => 1.2 * Math.sqrt(Math.max(0, 1 - Math.pow(Math.min(1, tOf(z)), 2.4)));
  const sheer = z => 0.85 + 0.22 * Math.pow(Math.max(0, tOf(z)), 1.6);
  const deckY = (z, x) => { const b = half(z) || 1e-3; return sheer(z) + 0.06 * (1 - Math.min(1, (x / b) ** 2)); };
  // lofted surface helper: rows along z, columns across x
  function loft(nz, nx, f, mat) {
    const pos = [], idx = [];
    for (let i = 0; i <= nz; i++) for (let j = 0; j <= nx; j++) pos.push(...f(i / nz, j / nx));
    for (let i = 0; i < nz; i++) for (let j = 0; j < nx; j++) {
      const a = i * (nx + 1) + j, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.material.side = THREE.DoubleSide; return m;
  }
  const zAt = u => Z0 + u * L;
  // deck (buff non-skid) and white margin at the edge
  bow.add(loft(48, 16, (u, v) => { const z = zAt(u), b = half(z), x = (v * 2 - 1) * b; return [x, deckY(z, x), z]; }, BUFF));
  // topsides: white, from the sheer down to the waterline with a little flare
  for (const s of [-1, 1]) bow.add(loft(48, 4, (u, v) => {
    const z = zAt(u), b = half(z), y = sheer(z) * (1 - v); return [s * b * (1 - 0.12 * v), y, z];
  }, WHITE));
  // cabin trunk: rounded-front plan, sides leaning in slightly, cambered top
  const TZ0 = Z0, TZ1 = -3.0, TL = TZ1 - TZ0;
  const thw = z => { const t = (z - TZ0) / TL; return Math.min(half(z) - 0.3, 0.86) * Math.pow(Math.max(0, 1 - Math.pow(t, 6)), 0.5); };
  const trunkBase = z => sheer(z) + 0.04, trunkTop = (z, x) => sheer(z) + 0.46 - 0.06 * ((z - TZ0) / TL) + 0.05 * (1 - Math.min(1, (x / (thw(z) || 1e-3)) ** 2));
  const tz = u => TZ0 + u * TL;
  bow.add(loft(36, 12, (u, v) => { const z = tz(u), w = thw(z) - 0.04, x = (v * 2 - 1) * w; return [x, trunkTop(z, x), z]; }, BUFF));
  for (const s of [-1, 1]) bow.add(loft(36, 2, (u, v) => {
    const z = tz(u), w = thw(z); return [s * (w - 0.04 * v), trunkBase(z) + v * (trunkTop(z, s * (w - 0.04)) - trunkBase(z)), z];
  }, WHITE));
  // bronze oval portlights, two each side
  for (const s of [-1, 1]) for (const z of [-1.55, -2.3]) {
    const w = thw(z), y = (trunkBase(z) + trunkTop(z, s * w)) / 2;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.018, 6, 20), BRONZE); rim.scale.set(1, 0.5, 1);
    rim.position.set(s * (w + 0.005), y, z); rim.rotation.y = Math.PI / 2; bow.add(rim);
    const gl = new THREE.Mesh(new THREE.CircleGeometry(0.1, 16), GLASS); gl.scale.set(1, 0.5, 1);
    gl.position.set(s * (w + 0.003), y, z); gl.rotation.y = s * Math.PI / 2; bow.add(gl);
  }
  // teak handrails along the cabin top
  for (const s of [-1, 1]) {
    const z0 = -1.15, z1 = -2.65, x = s * 0.58, y = trunkTop(-1.9, x) + 0.07;
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.035, Math.abs(z1 - z0)), TEAK); rail.position.set(x, y, (z0 + z1) / 2); bow.add(rail);
    for (let k = 0; k <= 4; k++) { const z = z0 + (z1 - z0) * k / 4, p = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 0.05), TEAK); p.position.set(x, y - 0.04, z); bow.add(p); }
  }
  // companionway sliding hatch and its teak garage
  const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.07, 0.6), WHITE); hatch.position.set(0, trunkTop(-1.2, 0) + 0.035, -1.2); bow.add(hatch);
  for (const s of [-1, 1]) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.75), TEAK); r.position.set(s * 0.38, trunkTop(-1.25, 0) + 0.03, -1.25); bow.add(r); }
  // forward hatch on the foredeck
  const fh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.5), WHITE); fh.position.set(0, deckY(-3.55, 0) + 0.05, -3.55); bow.add(fh);
  const fhr = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.06, 0.56), TEAK); fhr.position.set(0, deckY(-3.55, 0) + 0.02, -3.55); bow.add(fhr);
  // teak toe rails along the sheer
  for (const s of [-1, 1]) {
    const pts = []; for (let i = 0; i <= 30; i++) { const z = Z0 + (L + 0.02) * i / 30; pts.push(new THREE.Vector3(s * (half(z) - 0.02), sheer(z) + 0.04, z)); }
    bow.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.03, 5), TEAK));
  }
  // bronze bow chocks and a mooring cleat
  for (const s of [-1, 1]) { const c = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.18), BRONZE); c.position.set(s * (half(-4.6) - 0.06), sheer(-4.6) + 0.07, -4.6); bow.add(c); }
  const cleat = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.22), BRONZE); cleat.position.set(0, deckY(-4.2, 0) + 0.04, -4.2); bow.add(cleat);
  // spars: deck-stepped mast on the cabin top, boom with a navy sail cover over the cockpit
  const MZ = -2.75, MTOP = 10.5, mastFoot = trunkTop(MZ, 0);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, MTOP - mastFoot, 12), SPAR); mast.position.set(0, (MTOP + mastFoot) / 2, MZ); bow.add(mast);
  const BY = mastFoot + 1.2;
  // the boom swings from the gooseneck: its group pivots at the mast
  const boomG = new THREE.Group(); boomG.position.set(0, BY, MZ); bow.add(boomG);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 3.2, 10), SPAR); boom.rotation.x = Math.PI / 2; boom.position.set(0, 0, 1.6); boomG.add(boom);
  const cover = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 2.7, 4, 10), COVER); cover.rotation.x = Math.PI / 2; cover.position.set(0, 0.11, 1.5); boomG.add(cover);
  // standing rigging (thin stainless wire)
  const wire = (a, b, r = 0.006) => bow.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(...a), new THREE.Vector3(...b)), 1, r, 4), STEEL));
  const head = [0, MTOP, MZ];
  wire(head, [0, sheer(ZS) + 0.12, ZS - 0.02]);                                   // forestay
  for (const s of [-1, 1]) {
    const cx = s * (half(MZ) - 0.05), cy = sheer(MZ) + 0.05;
    wire([0, MTOP - 0.4, MZ], [cx, cy, MZ]);                                       // uppers
    wire([0, 5.6, MZ], [cx, cy, MZ - 0.45]); wire([0, 5.6, MZ], [cx, cy, MZ + 0.45]);   // lowers
    const spreader = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.04, 0.05), SPAR); spreader.position.set(s * 0.38, 5.6, MZ); bow.add(spreader);
  }
  // bow pulpit, stanchions and lifelines
  const PH = 0.62;
  const pul = new THREE.CatmullRomCurve3([[-0.62, -4.25], [-0.42, -4.75], [0, -5.12], [0.42, -4.75], [0.62, -4.25]].map(([x, z]) => new THREE.Vector3(x, sheer(z) + PH, z)));
  bow.add(new THREE.Mesh(new THREE.TubeGeometry(pul, 40, 0.022, 6), STEEL));
  for (const [x, z] of [[-0.62, -4.25], [0.62, -4.25], [-0.3, -4.95], [0.3, -4.95]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, PH, 6), STEEL); leg.position.set(x, sheer(z) + PH / 2, z); bow.add(leg);
  }
  const stz = [-3.3, -1.9, 0.4, 1.7];   // the last two on the side decks beside the cockpit
  for (const s of [-1, 1]) {
    const tops = [[s * 0.62, sheer(-4.25) + PH, -4.25]];
    for (const z of stz) {
      const x = s * ((z > Z0 ? 1.2 - 0.27 * Math.pow((z - Z0) / 3.5, 1.5) : half(z)) - 0.08), h = z > Z0 ? 0.85 + 0.08 * ((z - Z0) / 3.5) ** 2 : sheer(z);
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, PH, 6), STEEL); st.position.set(x, h + PH / 2, z); bow.add(st);
      tops.push([x, h + PH, z]);
    }
    for (let k = 1; k < tops.length; k++) { wire(tops[k - 1], tops[k], 0.005); wire([tops[k - 1][0], tops[k - 1][1] - 0.3, tops[k - 1][2]], [tops[k][0], tops[k][1] - 0.3, tops[k][2]], 0.005); }
  }
  // aft half (seen from the raised views): side decks round a recessed cockpit, transom, tiller,
  // backstay, stern pulpit. LOA 25 ft puts the transom ~2.6 m aft of the cockpit bulkhead.
  const ZT = 2.6, tA = z => (z - Z0) / (ZT - Z0);
  const halfA = z => 1.2 - 0.27 * Math.pow(Math.max(0, tA(z)), 1.5), sheerA = z => 0.85 + 0.08 * tA(z) ** 2;
  const CW2 = 0.725, CZ1d = 1.95;   // half-width and aft end of the cockpit opening
  for (const sd of [-1, 1]) bow.add(loft(16, 3, (u, v) => { const z = Z0 + u * (CZ1d - Z0), b = halfA(z), x = sd * (CW2 + v * (b - CW2)); return [x, sheerA(z) + 0.04 * (1 - (x / b) ** 2), z]; }, BUFF));   // side decks
  bow.add(loft(6, 12, (u, v) => { const z = CZ1d + u * (ZT - CZ1d), b = halfA(z), x = (v * 2 - 1) * b; return [x, sheerA(z) + 0.04 * (1 - (x / b) ** 2), z]; }, BUFF));   // aft deck
  for (const sd of [-1, 1]) bow.add(loft(16, 4, (u, v) => { const z = Z0 + u * (ZT - Z0), b = halfA(z); return [sd * b * (1 - 0.1 * v), sheerA(z) * (1 - v) + 0.15 * v, z]; }, WHITE));
  { // transom
    const sh = new THREE.Shape(), b = halfA(ZT), y0 = 0.15, y1 = sheerA(ZT);
    sh.moveTo(-b * 0.9, y0); sh.lineTo(b * 0.9, y0); sh.lineTo(b, y1); sh.lineTo(-b, y1); sh.closePath();
    const tr = new THREE.Mesh(new THREE.ShapeGeometry(sh), WHITE); tr.position.z = ZT; tr.material.side = THREE.DoubleSide; bow.add(tr);
  }
  { // cockpit well and coamings
    const CZ0 = Z0 + 0.05, CZ1 = 1.95, CW = 1.45, sole = 0.45;
    const well = new THREE.Mesh(new THREE.BoxGeometry(CW, 0.02, CZ1 - CZ0), M(0x8d8676)); well.position.set(0, sole, (CZ0 + CZ1) / 2); bow.add(well);
    for (const sd of [-1, 1]) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.04, CZ1 - CZ0 - 0.1), BUFF); seat.position.set(sd * (CW / 2 - 0.21), 0.78, (CZ0 + CZ1) / 2); bow.add(seat);
      const coam = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, CZ1 - CZ0), TEAK); coam.position.set(sd * (CW / 2 + 0.03), 1.0, (CZ0 + CZ1) / 2); bow.add(coam);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.45, CZ1 - CZ0), WHITE); wall.position.set(sd * CW / 2, sole + 0.22, (CZ0 + CZ1) / 2); bow.add(wall);
    }
    const aftWall = new THREE.Mesh(new THREE.BoxGeometry(CW, 0.45, 0.02), WHITE); aftWall.position.set(0, sole + 0.22, CZ1); bow.add(aftWall);
  }
  // tiller from the rudder head at the transom forward into the cockpit
  const tillerG = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.5, 8), TEAK);
  tillerG.position.set(0.05, sheerA(ZT) + 0.22, ZT - 0.7); tillerG.rotation.x = Math.PI / 2 - 0.18; bow.add(tillerG);
  // backstay and stern pulpit
  wire([0, MTOP, MZ], [0, sheerA(ZT) + 0.1, ZT - 0.05]);
  const spul = new THREE.CatmullRomCurve3([[-halfA(1.7) + 0.06, 1.7], [-0.7, ZT - 0.05], [0.7, ZT - 0.05], [halfA(1.7) - 0.06, 1.7]].map(([x, z]) => new THREE.Vector3(x, sheerA(z) + PH, z)));
  bow.add(new THREE.Mesh(new THREE.TubeGeometry(spul, 30, 0.02, 6), STEEL));
  for (const [x, z] of [[-0.7, ZT - 0.05], [0.7, ZT - 0.05]]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, PH, 6), STEEL); leg.position.set(x, sheerA(z) + PH / 2, z); bow.add(leg); }
  // Sails (Drone view, v837): mainsail and jib drawing on a broad reach, starboard tack, so the
  // wind comes over the starboard quarter and both sails are out to port. Each is a lofted
  // surface with a belly (deepest ~40% back from the luff) and twist toward the head.
  const CLOTH = new THREE.MeshLambertMaterial({ color: 0xf5f2ea, side: THREE.DoubleSide });
  function sail(luff, leech, belly, nu = 14, nv = 10) {   // luff(u), leech(u): points; belly(u): leeward unit vector
    const pos = [], idx = [];
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, a = luff(u), b = leech(u), w = belly(u), chord = a.distanceTo(b);
      for (let j = 0; j <= nv; j++) {
        const v = j / nv, depth = chord * 0.11 * Math.sin(Math.PI * Math.pow(v, 0.8));
        const p = a.clone().lerp(b, v).addScaledVector(w, depth); pos.push(p.x, p.y, p.z);
      }
    }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const k = i * (nv + 1) + j; idx.push(k, k + nv + 1, k + 1, k + 1, k + nv + 1, k + nv + 2); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    return new THREE.Mesh(g, CLOTH);
  }
  const BOOM_OUT = THREE.MathUtils.degToRad(-62), V3 = THREE.Vector3;
  // mainsail in the boom's frame (the group turns with the boom): luff up the mast, foot along
  // the boom, the leech curving in from the clew to the head, twisting off further outboard aloft
  const mainH = MTOP - 0.35 - BY, twist = u => THREE.MathUtils.degToRad(-12) * u;
  const main = sail(
    u => new V3(0, 0.08 + u * mainH, 0.06),
    u => { const r = 3.05 * (1 - u) * (1 + 0.18 * Math.sin(Math.PI * u)) + 0.12 * u, t = twist(u); return new V3(Math.sin(t) * r, 0.08 + u * mainH, 0.06 + Math.cos(t) * r); },
    u => new V3(-Math.cos(twist(u)), 0, Math.sin(twist(u)) * 0.2).normalize());
  main.visible = false; boomG.add(main);
  // jib: luff on the forestay, clew sheeted well out to port for the broad reach
  const tack = new V3(0, sheer(ZS) + 0.25, ZS + 0.05), stayTop = new V3(0, MTOP, MZ), headJ = tack.clone().lerp(stayTop, 0.84);
  const clew = new V3(-1.55, 1.75, MZ + 0.2);
  const jib = sail(u => tack.clone().lerp(headJ, u), u => clew.clone().lerp(headJ, u),
    u => { const c = clew.clone().lerp(headJ, u).sub(tack.clone().lerp(headJ, u)); return new V3(-c.z, 0, c.x).normalize().multiplyScalar(-1).setY(0).normalize(); });
  jib.visible = false; bow.add(jib);
  setSails = on => {
    main.visible = jib.visible = on; cover.visible = !on;
    boomG.rotation.y = on ? BOOM_OUT : 0;
  };
}
// The boat is its own object: it points along the course and pitches/rolls; the camera sits at
// the tiller inside it, so looking around turns your head, not the boat.
const boat = new THREE.Group();
boat.add(bow);
scene.add(boat);
boat.add(camera);
camera.position.set(0.35, EYE, 1.0);   // at the tiller, aft end of the cockpit


// Water: ripple normals generated here (no image download), sky and shore reflected.
function rippleNormals(size = 256) {
  const hgt = new Float32Array(size * size), data = new Uint8Array(size * size * 4);
  // many random wave trains (integer wavenumbers keep it tileable), amplitude falling with frequency
  let sd = 11; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const waves = Array.from({ length: 160 }, () => {
    const k = 2 + rr() * 22, th = rr() * Math.PI * 2;
    return { kx: Math.round(Math.cos(th) * k), ky: Math.round(Math.sin(th) * k), a: Math.pow(k, -1.4) * (0.6 + rr() * 0.8), p: rr() * 6.283 };
  });
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0; for (const wv of waves) v += wv.a * Math.sin(2 * Math.PI * (wv.kx * x + wv.ky * y) / size + wv.p);
    hgt[y * size + x] = v;
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = hgt[y * size + (x + 1) % size] - hgt[y * size + (x - 1 + size) % size];
    const dy = hgt[((y + 1) % size) * size + x] - hgt[((y - 1 + size) % size) * size + x];
    const n = new THREE.Vector3(-dx * 0.65, -dy * 0.65, 1).normalize(), o = (y * size + x) * 4;
    data[o] = (n.x * 0.5 + 0.5) * 255; data[o + 1] = (n.y * 0.5 + 0.5) * 255; data[o + 2] = (n.z * 0.5 + 0.5) * 255; data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
  return t;
}
const water = new Water(new THREE.PlaneGeometry(120000, 120000), {
  textureWidth: 512, textureHeight: 512, waterNormals: rippleNormals(),
  sunDirection: sun.clone().normalize(), sunColor: 0xfff4e0, waterColor: 0x1f3c48, distortionScale: 1.2, fog: true,
});
water.rotation.x = -Math.PI / 2;
water.material.uniforms.size.value = 6;
// Real water reflects ~2% looking straight down (three's default is 30%, which reads as milky
// from a low eye), and a little less sky overall at grazing angles.
water.material.fragmentShader = water.material.fragmentShader
  .replace('float rf0 = 0.3;', 'float rf0 = 0.02;')
  .replace('reflectionSample * 0.9 +', 'reflectionSample * 0.78 +');
water.material.needsUpdate = true;
// keep the boat's own bow out of the water's reflection pass
{ const mirror = water.onBeforeRender; water.onBeforeRender = (...a) => { bow.visible = false; mirror(...a); bow.visible = true; }; }
scene.add(water);

// Sky: a clear-day gradient dome, deep blue overhead fading to the haze colour at the horizon
// (so distant land and water blend into it), with a soft glow around the sun. Drawn first,
// behind everything; not tone-mapped, so the blue stays blue.
const sky = new THREE.Mesh(new THREE.SphereGeometry(60000, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
  uniforms: { zenith: { value: new THREE.Color(0x2f62a8) }, horizon: { value: HAZE.clone() }, sunDir: { value: sun.clone().normalize() } },
  vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
    void main() {
      float h = max(vDir.y, 0.0);
      vec3 c = mix(horizon, zenith, pow(h, 0.55));
      float g = max(dot(normalize(vDir), sunDir), 0.0);
      c += vec3(1.0, 0.95, 0.85) * (pow(g, 300.0) * 1.2 + pow(g, 12.0) * 0.12);
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }`,
}));
sky.renderOrder = -1; sky.frustumCulled = false;
scene.add(sky);

// Fair-weather clouds: a drifting deck ~1.5 km up, from tileable noise made here (no download).
// Fog thins them into the haze toward the horizon; the water reflects them.
const clouds = (() => {
  const N = 512, img = new ImageData(N, N), rand = (() => { let sd = 5; return () => (sd = (sd * 16807) % 2147483647) / 2147483647; })();
  const octaves = [8, 16, 32, 64].map(L => ({ L, g: Float32Array.from({ length: L * L }, rand) }));
  const smooth = t => t * t * (3 - 2 * t);
  const noise = (x, y) => {   // periodic value noise, summed over octaves; 0..1
    let v = 0, amp = 0.5, tot = 0;
    for (const { L, g } of octaves) {
      const fx = x / N * L, fy = y / N * L, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = smooth(fx - x0), ty = smooth(fy - y0);
      const at = (i, j) => g[((j + L) % L) * L + ((i + L) % L)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx, b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
      v += (a + (b - a) * ty) * amp; tot += amp; amp *= 0.5;
    }
    return v / tot;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const n = noise(x, y), o = (y * N + x) * 4;
    const a = Math.max(0, Math.min(1, (n - 0.585) / 0.09));     // only the higher noise is cloud: separate puffs
    const shade = 222 + 33 * Math.min(1, (n - 0.585) / 0.14);    // white middles, faintly grey edges
    img.data[o] = shade; img.data[o + 1] = shade; img.data[o + 2] = Math.min(255, shade + 4); img.data[o + 3] = a * 235;
  }
  const cv = document.createElement('canvas'); cv.width = cv.height = N; cv.getContext('2d').putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(9, 9); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true, toneMapped: false }));
  m.rotation.x = Math.PI / 2; m.position.y = 1500;
  scene.add(m);
  return m;
})();

// Buoys, beacons and lights from the chart.
const COLORS = { green: 0x2b8a4a, red: 0xc23a2e, yellow: 0xe0b531, white: 0xeeeeea };
const colOf = c => COLORS[(c || 'white').split('/')[0]] ?? 0xdddddd;
const mat = c => new THREE.MeshLambertMaterial({ color: c });
const lights = nav.filter(n => n.t === 'LIGHTS');
const marks = [];
function flashFor(ch) {
  if (!ch) return null;
  const per = parseFloat((ch.match(/(\d+(?:\.\d+)?)s/) || [])[1]) || (/^Q/.test(ch) ? 1 : 4);
  const col = /\bG\b/.test(ch) ? 0x5dff8a : /\bR\b/.test(ch) ? 0xff4b3a : /\bY\b/.test(ch) ? 0xffd75a : 0xfff6d8;
  return { per, col, iso: /^Iso|^Oc/.test(ch), fixed: /^F\b/.test(ch) };
}
for (const n of nav.filter(n => n.t !== 'LIGHTS')) {
  const g = new THREE.Group(), c = colOf(n.c), s = n.s || 'stake/pole';
  if (s === 'can') {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.0, 20), mat(c)); m.position.y = 1.0; g.add(m);
    if ((n.c || '').includes('/')) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.5, 20), mat(COLORS.red)); b.position.y = 1.0; g.add(b); }
  } else if (s === 'nun') {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 1.1, 20), mat(c)); m.position.y = 0.55; g.add(m);
    const t = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.3, 20), mat(c)); t.position.y = 1.75; g.add(t);
  } else if (s === 'pillar') {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.2, 0.9, 20), mat(c)); base.position.y = 0.45; g.add(base);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.8, 3.2, 4, 1, true), new THREE.MeshLambertMaterial({ color: c, wireframe: true }));
    tower.position.y = 2.5; g.add(tower);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 0.08), mat(c)); plate.position.y = 3.1; g.add(plate);
  } else {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 5.0, 8), mat(0x6b6a62)); pole.position.y = 2.5; g.add(pole);
    const board = (n.c || '').startsWith('red')
      ? new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.08, 3), mat(c))
      : new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 0.08), mat(c));
    if ((n.c || '').startsWith('red')) { board.rotation.x = Math.PI / 2; board.rotation.y = Math.PI / 2; }
    board.position.y = 4.6; g.add(board);
  }
  const lt = lights.find(l => Math.hypot((l.x - n.x) * MX, (l.y - n.y) * MY) < 40);
  const fl = flashFor(lt?.ch);
  let lamp = null;
  if (fl) { lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshBasicMaterial({ color: fl.col })); lamp.position.y = s === 'pillar' ? 4.3 : 2.6; g.add(lamp); }
  g.position.set(wx(n.x), 0, wz(n.y));
  scene.add(g);
  marks.push({ g, n, fl, lamp, phase: Math.random() * 6, num: (n.n || '').match(/(\S{1,3})$/)?.[1] || '', name: n.n, kind: 'buoy' });
}
// Lights not on a buoy: a short white tower with its light.
for (const l of lights) {
  if (nav.some(n => n.t !== 'LIGHTS' && Math.hypot((l.x - n.x) * MX, (l.y - n.y) * MY) < 40)) continue;
  if (BREAKWATER_IN_VIEW && Math.hypot((l.x - BREAKWATER[1][0]) * MX, (l.y - BREAKWATER[1][1]) * MY) < 80) continue;
  const g = new THREE.Group(), base = Math.max(0, heightAt(l.x, l.y));
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.6, 9, 16), mat(0xf0eee6)); tower.position.y = 4.5; g.add(tower);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.2, 12), mat(0x2b2b2b)); cap.position.y = 9.6; g.add(cap);
  const fl = flashFor(l.ch), lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshBasicMaterial({ color: fl?.col ?? 0xfff6d8 }));
  lamp.position.y = 9.6; g.add(lamp);
  g.position.set(wx(l.x), base, wz(l.y)); scene.add(g);
  marks.push({ g, n: l, fl, lamp, phase: 0, fixedMark: true, kind: 'light', name: l.ch });
}

// Route and motion
const route = routeLL.map(([x, y]) => [wx(x), wz(y)]);
const cum = [0]; for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]));
const TOTAL = cum[cum.length - 1];
function posAt(s) {
  s = Math.max(0, Math.min(TOTAL, s));
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  return [route[i - 1][0] + t * (route[i][0] - route[i - 1][0]), route[i - 1][1] + t * (route[i][1] - route[i - 1][1])];
}
function courseAt(s) {   // degrees true, from a short look-ahead so turns are smooth
  const a = posAt(Math.min(s, TOTAL - 500) - 80), b = posAt(Math.min(s, TOTAL - 500) + 450);
  return (Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180 / Math.PI + 360) % 360;
}

let S = (Number(params.get('start')) || 0.05) * NM, playing = false, yawOff = 0, pitch = -1.2, zoom = 1, smoothCourse = null;
const posEl = document.getElementById('pos'); posEl.max = (TOTAL / NM).toFixed(3); posEl.value = (S / NM).toFixed(3);
const playBtn = document.getElementById('play'), speedEl = document.getElementById('speed');
const setPlaying = on => { playing = on; playBtn.innerHTML = on ? '&#10074;&#10074; Pause' : '&#9654; Play'; if (on && S >= TOTAL - 1) S = 0; };
playBtn.addEventListener('click', () => setPlaying(!playing));
posEl.addEventListener('input', () => { S = Number(posEl.value) * NM; smoothCourse = null; });
document.getElementById('reset').addEventListener('click', () => { yawOff = 0; pitch = -1.2; zoom = 1; });
addEventListener('keydown', e => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); setPlaying(!playing); } });
let drag = null;
sceneEl.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, yaw: yawOff, pitch }; sceneEl.setPointerCapture(e.pointerId); sceneEl.classList.add('dragging'); });
sceneEl.addEventListener('pointermove', e => {
  if (!drag) return;
  const k = camera.fov / sceneEl.clientHeight;
  yawOff = drag.yaw - (e.clientX - drag.x) * k; pitch = Math.max(-30, Math.min(30, drag.pitch + (e.clientY - drag.y) * k));
});
const endDrag = () => { drag = null; sceneEl.classList.remove('dragging'); };
sceneEl.addEventListener('pointerup', endDrag); sceneEl.addEventListener('pointercancel', endDrag);
sceneEl.addEventListener('wheel', e => { e.preventDefault(); zoom = Math.max(1, Math.min(8, zoom * Math.exp(-e.deltaY * 0.0015))); }, { passive: false });

// Labels: projected each frame; hidden when terrain on that sight line is in the way.
const labelsEl = document.getElementById('labels'), showLbl = document.getElementById('showlbl');
const labelPool = [];
function sightClear(from, to, toH) {
  const dx = to[0] - from[0], dz = to[1] - from[1], d = Math.hypot(dx, dz);
  for (let t = 40; t < d - 60; t += Math.max(15, t * 0.02)) {
    const x = from[0] + dx * t / d, z = from[1] + dz * t / d;
    const hT = heightAt(x / MX + LON0, -z / MY + LAT0), los = eyeH + (toH - eyeH) * t / d;
    if (hT > los) return false;
  }
  return true;
}
const placeLabels = places.filter(p => p.t !== 'LIGHTS').map(p => ({ ...p, w: [wx(p.x), wz(p.y)], h: Math.max(4, heightAt(p.x, p.y)) }));
let lblFrame = 0, lblCache = [];
function updateLabels(pos) {
  if (!showLbl.checked) { labelsEl.hidden = true; return; } labelsEl.hidden = false;
  if (lblFrame++ % 8 === 0) {   // sight-line checks are the costly part; refresh a few times a second
    const cand = [];
    for (const p of placeLabels) {
      const d = Math.hypot(p.w[0] - pos[0], p.w[1] - pos[1]); if (d > 5 * NM || d < 60) continue;
      cand.push({ text: p.n, v: new THREE.Vector3(p.w[0], p.h + 8, p.w[1]), d, cls: '', w: p.w, h: p.h });
    }
    for (const m of marks) {
      if (m.kind !== 'buoy' || !m.num) continue;
      const d = Math.hypot(m.g.position.x - pos[0], m.g.position.z - pos[1]); if (d > 1.3 * NM) continue;
      cand.push({ text: `"${m.num}"`, v: new THREE.Vector3(m.g.position.x, 5.5, m.g.position.z), d, cls: 'buoy', w: [m.g.position.x, m.g.position.z], h: 3 });
    }
    cand.sort((a, b) => a.d - b.d);
    lblCache = cand.slice(0, 40).filter(c => sightClear(pos, c.w, c.h)).slice(0, 14);
  }
  const W = sceneEl.clientWidth, H = sceneEl.clientHeight, placed = [];
  let n = 0;
  for (const c of lblCache) {
    const p = c.v.clone().project(camera);
    if (p.z > 1 || Math.abs(p.x) > 1.05 || p.y > 0.95 || p.y < -1) continue;
    const x = (p.x + 1) / 2 * W, y = (1 - p.y) / 2 * H, w = c.text.length * 7.5 + 6;
    if (placed.some(r => Math.abs(r[0] - x) < (r[2] + w) / 2 && Math.abs(r[1] - y) < 16)) continue;
    placed.push([x, y, w]);
    let el = labelPool[n]; if (!el) { el = document.createElement('div'); labelsEl.appendChild(el); labelPool[n] = el; }
    el.className = 'lbl ' + c.cls; el.textContent = c.text; el.style.left = x + 'px'; el.style.top = y + 'px'; el.hidden = false; n++;
  }
  for (let i = n; i < labelPool.length; i++) labelPool[i].hidden = true;
}

// Heading tape
const tape = document.getElementById('tapecv'), tctx = tape.getContext('2d');
tape.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:28px;pointer-events:none;z-index:1';
function drawTape(look, hfov) {
  const W = sceneEl.clientWidth, dpr = Math.min(2, devicePixelRatio);
  if (tape.width !== Math.round(W * dpr)) { tape.width = Math.round(W * dpr); tape.height = Math.round(28 * dpr); }
  const c = tctx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, 28);
  c.fillStyle = 'rgba(16,28,34,0.5)'; c.fillRect(0, 0, W, 28);
  c.strokeStyle = 'rgba(240,244,245,0.8)'; c.fillStyle = '#eef3f4'; c.font = '500 11px "JetBrains Mono", monospace'; c.textAlign = 'center'; c.textBaseline = 'top';
  const card = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  const pxDeg = W / hfov, step = hfov > 40 ? 5 : 1;
  for (let b = Math.floor((look - hfov / 2) / step) * step; b <= look + hfov / 2; b += step) {
    const x = W / 2 + (b - look) * pxDeg, bb = ((b % 360) + 360) % 360, major = bb % (step * 2) === 0;
    c.beginPath(); c.moveTo(x, 28); c.lineTo(x, major ? 20 : 24); c.stroke();
    if (bb % (step === 5 ? 10 : 5) === 0) c.fillText(card[bb] || String(bb).padStart(3, '0'), x, 5);
  }
  c.fillStyle = '#e0a843'; c.beginPath(); c.moveTo(W / 2 - 6, 28); c.lineTo(W / 2 + 6, 28); c.lineTo(W / 2, 20); c.closePath(); c.fill();
}

// ── Arrival: the anchor goes down off the bow roller, chain rattling, with a splash ──
// Sound is made here with Web Audio (no files). Browsers only allow it after a click or key
// press in this window, so the context is unlocked on the first one.
let audioCtx = null, audioMaster = null;
// all sound goes through one gain node, so a recording (see Record) can take it too
const audioOut = () => { if (!audioMaster) { audioMaster = audioCtx.createGain(); audioMaster.connect(audioCtx.destination); } return audioMaster; };
const unlockAudio = () => {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (_) {}
};
addEventListener('pointerdown', unlockAudio); addEventListener('keydown', unlockAudio);
function noiseBuffer(sec) {
  const b = audioCtx.createBuffer(1, Math.round(audioCtx.sampleRate * sec), audioCtx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function playChain(sec) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  // soft metallic clinks of chain running over the roller, slowing as the anchor settles
  let at = audioCtx.currentTime, gap = 0.06;
  while (at < audioCtx.currentTime + sec) {
    const src = audioCtx.createBufferSource(), bp = audioCtx.createBiquadFilter(), g = audioCtx.createGain();
    src.buffer = noiseBuffer(0.08); bp.type = 'bandpass'; bp.frequency.value = 1400 + Math.random() * 900; bp.Q.value = 9;
    g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(0.06 + Math.random() * 0.04, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    src.connect(bp).connect(g).connect(audioOut()); src.start(at);
    at += gap + Math.random() * 0.04; gap *= 1.05;
  }
}
// A small anchor going in: a soft, low whoosh with no hard attack, then a few bubbles.
function playSplash() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime;
  const src = audioCtx.createBufferSource(), lp = audioCtx.createBiquadFilter(), g = audioCtx.createGain();
  src.buffer = noiseBuffer(1.6); lp.type = 'lowpass'; lp.Q.value = 0.7;
  lp.frequency.setValueAtTime(1600, now); lp.frequency.exponentialRampToValueAtTime(350, now + 1.2);
  g.gain.setValueAtTime(0.0001, now); g.gain.linearRampToValueAtTime(0.16, now + 0.07);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
  src.connect(lp).connect(g).connect(audioOut()); src.start(now);
  // bubbles: short soft sine blips that rise in pitch, trailing off
  for (let k = 0; k < 6; k++) {
    const t0 = now + 0.25 + k * (0.09 + Math.random() * 0.12), f0 = 260 + Math.random() * 260;
    const o = audioCtx.createOscillator(), og = audioCtx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f0 * 2.2, t0 + 0.06);
    og.gain.setValueAtTime(0.0001, t0); og.gain.linearRampToValueAtTime(0.035 * (1 - k / 7), t0 + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
    o.connect(og).connect(audioOut()); o.start(t0); o.stop(t0 + 0.08);
  }
}
const anchorNote = document.getElementById('anchornote');
const ROLLER = new THREE.Vector3(0, 1.12, -5.25);   // stem-head roller, boat frame
const anchorObj = new THREE.Group();
{
  const galv = new THREE.MeshLambertMaterial({ color: 0x6f767b });
  const shank = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.75, 0.05), galv); shank.position.y = -0.37; anchorObj.add(shank);
  const stock = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.6, 6), galv); stock.rotation.z = Math.PI / 2; stock.position.y = -0.72; anchorObj.add(stock);
  for (const sgn of [-1, 1]) {
    const fluke = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.42, 3), galv); fluke.position.set(sgn * 0.13, -0.55, 0); fluke.rotation.z = Math.PI; anchorObj.add(fluke);
  }
}
anchorObj.visible = false; scene.add(anchorObj);
const chainGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const chain = new THREE.Line(chainGeo, new THREE.LineBasicMaterial({ color: 0x3d4246 })); chain.visible = false; chain.frustumCulled = false; scene.add(chain);
const SPRAY = 140;
const sprayGeo = new THREE.BufferGeometry(); sprayGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPRAY * 3), 3));
const dropTex = (() => {   // soft round droplet
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d'), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(240,247,250,0.8)'); gr.addColorStop(1, 'rgba(240,247,250,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
})();
const spray = new THREE.Points(sprayGeo, new THREE.PointsMaterial({ color: 0xf4f8fa, map: dropTex, size: 0.16, transparent: true, opacity: 0.9, depthWrite: false }));
spray.visible = false; spray.frustumCulled = false; scene.add(spray);
const rings = [0, 0.35, 0.8].map(() => {
  const r = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 64), new THREE.MeshBasicMaterial({ color: 0xe8f0f3, transparent: true, opacity: 0, depthWrite: false }));
  r.rotation.x = -Math.PI / 2; r.visible = false; scene.add(r); return r;
});
const RING_DELAY = [0, 0.35, 0.8];
const anchor = { state: 'up', t: 0, v: 0, splashAt: null, vel: new Float32Array(SPRAY * 3) };
// The foredeck hides the water at the stem from the tiller (as on the real boat), so on arrival
// the view walks forward past the mast and looks down at the bow, lets the anchor go, watches the
// splash, then goes back aft. arrive() starts it; dropAnchor() is the actual let-go.
// Viewpoint height: the helm (2 m), or raised above the boat for a wider look at the water and
// shore, e.g. 20 ft (~6 m) as if from the spreaders, or 60 ft (~18 m). From the "View" buttons
// in the scene, the H key, or ?eye=<feet>; remembered in this browser.
// Raised views sit astern and tilt down a little, so the boat stays in the picture and the
// mast doesn't split it: back = metres astern of the tiller, tilt = degrees down.
// Drone (100 ft, 50 m astern) looks down on the whole boat with the shore beyond; looking
// around from a raised view circles the camera around the boat instead of turning in place.
const DRONE_M = 100 * 0.3048;
const EYE_CHOICES = [{ label: 'Helm', m: EYE }, { label: '20 ft', m: 20 * 0.3048 }, { label: '60 ft', m: 60 * 0.3048 }, { label: 'Drone', m: DRONE_M }];
const FT60 = 60 * 0.3048, _back = m => Math.max(0, (m - EYE) * 2.2), _tilt = m => Math.max(0, (m - EYE) * 2.4) / (1 + Math.max(0, m - EYE) / 18);
const _toDrone = m => Math.min(1, Math.max(0, (m - FT60) / (DRONE_M - FT60)));   // 60 ft -> drone, so the change glides
const eyeBack = m => m <= FT60 ? _back(m) : _back(FT60) + (50 - _back(FT60)) * _toDrone(m);
const eyeTilt = m => m <= FT60 ? _tilt(m) : _tilt(FT60) + (20 - _tilt(FT60)) * _toDrone(m);
let eyeTarget = DRONE_M;   // Drone by default (direct request, v832); a choice made since is remembered
{
  let want = Number(params.get('eye')) * 0.3048;   // feet in the URL; metres stored
  if (!want) { try { want = Number(localStorage.getItem('audiochart-helm3d-view')); } catch (_) {} }
  if (want > 0) eyeTarget = want;
}
let eyeH = eyeTarget;
const eyeBox = document.getElementById('eyepick');
function syncEyeButtons() { for (const b of eyeBox.querySelectorAll('button')) b.classList.toggle('on', Math.abs(Number(b.dataset.m) - eyeTarget) < 0.2); }
function setEye(m) { eyeTarget = m; try { localStorage.setItem('audiochart-helm3d-view', String(m)); } catch (_) {} syncEyeButtons(); }
for (const c of EYE_CHOICES) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = c.label; b.dataset.m = c.m;
  b.addEventListener('pointerdown', e => e.stopPropagation());   // not a look-around drag
  b.addEventListener('click', () => setEye(c.m)); eyeBox.appendChild(b);
}
syncEyeButtons();
addEventListener('keydown', e => {
  if (e.key !== 'h' && e.key !== 'H') return;
  const i = EYE_CHOICES.findIndex(c => Math.abs(c.m - eyeTarget) < 0.2);
  setEye(EYE_CHOICES[(i + 1) % EYE_CHOICES.length].m);
});
const TILLER = new THREE.Vector3(0.35, EYE, 1.0), AT_MAST = new THREE.Vector3(0.3, 2.6, -3.2);   // on the foredeck, just forward of the mast
let camK = 0;
const UP_AXIS = new THREE.Vector3(0, 1, 0);
function arrive() {
  anchor.state = 'walking'; anchor.t = 0; anchorNote.hidden = false;
  anchorObj.visible = true;   // sitting on the roller until it's let go
}
function dropAnchor() {
  anchor.state = 'falling'; anchor.t = 0; anchor.v = 0;
  anchorObj.position.copy(boat.localToWorld(ROLLER.clone())); anchorObj.rotation.set(0, boat.rotation.y, 0); anchorObj.visible = true;
  chain.visible = true; anchorNote.hidden = false;
  playChain(2.6);
}
function raiseAnchor() {
  anchor.state = 'up'; anchorObj.visible = chain.visible = spray.visible = false;
  for (const r of rings) r.visible = false;
  anchorNote.hidden = true;
}
function splash(at) {
  anchor.splashAt = at.clone(); anchor.splashT = 0;
  const pos = sprayGeo.attributes.position.array;
  for (let i = 0; i < SPRAY; i++) {
    const a = Math.random() * Math.PI * 2, out = 0.6 + Math.random() * 2.0, up = 2.5 + Math.random() * 3.0;
    pos[i * 3] = at.x; pos[i * 3 + 1] = 0.05; pos[i * 3 + 2] = at.z;
    anchor.vel[i * 3] = Math.cos(a) * out; anchor.vel[i * 3 + 1] = up; anchor.vel[i * 3 + 2] = Math.sin(a) * out;
  }
  sprayGeo.attributes.position.needsUpdate = true; spray.visible = true;
  rings.forEach(r => { r.position.set(at.x, 0.03, at.z); r.scale.setScalar(0.3); r.visible = true; r.material.opacity = 0; });
  playSplash();
}
function updateAnchor(dt) {
  anchor.t += dt;
  // how far forward the view is: out over 1.6 s, held while the anchor goes, back aft after
  const wantForward = ['walking', 'falling', 'sinking', 'sunk'].includes(anchor.state);
  camK = Math.max(0, Math.min(1, camK + (wantForward ? dt : -dt) / 1.6));
  if (anchor.state === 'up') return;
  if (anchor.state === 'walking') {
    anchorObj.position.copy(boat.localToWorld(ROLLER.clone())); anchorObj.rotation.set(0, boat.rotation.y, 0);
    if (camK >= 1) dropAnchor();
    return;
  }
  const roller = boat.localToWorld(ROLLER.clone());
  if (anchor.state === 'falling') {
    anchor.v += 9.8 * dt; anchorObj.position.y -= anchor.v * dt;
    if (anchorObj.position.y <= 0) { anchor.state = 'sinking'; splash(anchorObj.position); }
  } else if (anchor.state === 'sinking') {
    anchorObj.position.y -= 0.9 * dt;   // gone below the surface; the rode stays angled down to it
    if (anchorObj.position.y < -6) anchor.state = 'sunk';
  } else if (anchor.state === 'sunk' && anchor.t > 6) {   // seconds since let-go: then back to the tiller
    anchor.state = 'set';
  }
  const cp = chainGeo.attributes.position;
  cp.setXYZ(0, roller.x, roller.y, roller.z);
  cp.setXYZ(1, anchorObj.position.x, Math.max(anchorObj.position.y, -0.05), anchorObj.position.z);
  cp.needsUpdate = true;
  if (anchor.splashAt) {
    anchor.splashT += dt;
    const pos = sprayGeo.attributes.position.array;
    for (let i = 0; i < SPRAY; i++) {
      anchor.vel[i * 3 + 1] -= 9.8 * dt;
      pos[i * 3] += anchor.vel[i * 3] * dt; pos[i * 3 + 1] = Math.max(-0.2, pos[i * 3 + 1] + anchor.vel[i * 3 + 1] * dt); pos[i * 3 + 2] += anchor.vel[i * 3 + 2] * dt;
    }
    sprayGeo.attributes.position.needsUpdate = true;
    spray.material.opacity = Math.max(0, 0.9 * (1 - anchor.splashT / 1.4)); spray.visible = spray.material.opacity > 0;
    rings.forEach((r, k) => {
      const tt = anchor.splashT - RING_DELAY[k];
      if (tt < 0) return;
      r.scale.setScalar(0.3 + tt * 1.6); r.material.opacity = Math.max(0, 0.7 * (1 - tt / 3)); r.visible = r.material.opacity > 0;
    });
  }
}

// Corner chart: land/water raster from the same elevation the 3D view uses (so they agree),
// north up, centred on the boat, with the route, buoys and the bearing you're looking along.
const chartEl = document.getElementById('minichart'), cctx = chartEl.getContext('2d'), showChart = document.getElementById('showchart');
showChart.addEventListener('change', () => { chartEl.hidden = !showChart.checked; });
let CH = null;
buildChart = () => { CH = (() => {
  const lons = routeLL.map(p => p[0]), lats = routeLL.map(p => p[1]);
  const west = Math.min(...lons) - 0.16, east = Math.max(...lons) + 0.16, south = Math.min(...lats) - 0.12, north = Math.max(...lats) + 0.12;
  const ppd = 3000, W = Math.round((east - west) * ppd), H = Math.round((north - south) * ppd);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d'), img = c.createImageData(W, H), d = img.data;
  const land = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) land[y * W + x] = heightAt(west + (x + 0.5) / ppd, north - (y + 0.5) / ppd) > 0.4 ? 1 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4;
    const edge = land[i] && ((x > 0 && !land[i - 1]) || (x < W - 1 && !land[i + 1]) || (y > 0 && !land[i - W]) || (y < H - 1 && !land[i + W]));
    const [r, g, b] = edge ? [120, 104, 74] : land[i] ? [236, 223, 190] : [200, 222, 234];
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return { cv, west, north, ppd };
})(); };
if (far) buildChart();
function drawChart(pos, course, look, hfov) {
  if (!showChart.checked) return;
  const dpr = Math.min(2, devicePixelRatio), size = chartEl.clientWidth;
  if (chartEl.width !== Math.round(size * dpr)) { chartEl.width = chartEl.height = Math.round(size * dpr); }
  const c = cctx; c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const lon = pos[0] / MX + LON0, lat = -pos[1] / MY + LAT0;
  const RANGE_NM = 4.8, pxPerNm = size / (2 * RANGE_NM);
  const sx = pxPerNm * 60 * Math.cos(LAT0 * Math.PI / 180), sy = pxPerNm * 60;      // px per degree
  const X = lo => size / 2 + (lo - lon) * sx, Y = la => size / 2 - (la - lat) * sy;
  c.imageSmoothingEnabled = true;
  c.fillStyle = 'rgb(200,222,234)'; c.fillRect(0, 0, size, size);
  if (CH) c.drawImage(CH.cv, X(CH.west), Y(CH.north), CH.cv.width / CH.ppd * sx, CH.cv.height / CH.ppd * sy);
  // route ahead (dashed) and run so far (solid)
  c.lineWidth = 2; c.strokeStyle = '#a5741f'; c.setLineDash([5, 4]); c.beginPath();
  routeLL.forEach(([lo, la], i) => i ? c.lineTo(X(lo), Y(la)) : c.moveTo(X(lo), Y(la))); c.stroke(); c.setLineDash([]);
  let acc = 0; c.lineWidth = 3; c.strokeStyle = '#7a4f0e'; c.beginPath(); c.moveTo(X(routeLL[0][0]), Y(routeLL[0][1]));
  for (let i = 1; i < route.length; i++) {
    const segLen = cum[i] - cum[i - 1];
    if (acc + segLen >= S) { c.lineTo(X(lon), Y(lat)); break; }
    c.lineTo(X(routeLL[i][0]), Y(routeLL[i][1])); acc += segLen;
  }
  c.stroke();
  // buoys
  for (const m of marks) {
    if (m.kind !== 'buoy') continue;
    const x = X(m.n.x), y = Y(m.n.y); if (x < -5 || y < -5 || x > size + 5 || y > size + 5) continue;
    c.fillStyle = (m.n.c || '').startsWith('red') ? '#c23a2e' : (m.n.c || '').startsWith('green') ? '#2b8a4a' : '#555';
    c.beginPath(); c.arc(x, y, 2, 0, 7); c.fill();
  }
  // what you're looking at, then the boat
  const cx = size / 2, cy = size / 2, a0 = (look - hfov / 2 - 90) * Math.PI / 180, a1 = (look + hfov / 2 - 90) * Math.PI / 180;
  c.fillStyle = 'rgba(214,162,74,0.22)'; c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, size * 0.42, a0, a1); c.closePath(); c.fill();
  c.save(); c.translate(cx, cy); c.rotate(course * Math.PI / 180);
  c.fillStyle = '#1d2a30'; c.strokeStyle = '#fbfcf8'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(0, -9); c.quadraticCurveTo(5, -2, 4, 7); c.lineTo(-4, 7); c.quadraticCurveTo(-5, -2, 0, -9); c.closePath(); c.fill(); c.stroke();
  c.restore();
  // north arrow and scale
  c.fillStyle = '#1d2a30'; c.font = '600 11px "Source Sans 3", system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'top';
  c.fillText('N', 14, 4); c.beginPath(); c.moveTo(14, 17); c.lineTo(10, 25); c.lineTo(18, 25); c.closePath(); c.fill();
  const bar = pxPerNm * 2; c.fillRect(size - 10 - bar, size - 12, bar, 2.5);
  c.textAlign = 'right'; c.textBaseline = 'bottom'; c.font = '500 10px "JetBrains Mono", monospace'; c.fillText('2 nm', size - 10, size - 14);
  c.strokeStyle = 'rgba(20,35,42,0.35)'; c.lineWidth = 1; c.strokeRect(0.5, 0.5, size - 1, size - 1);
}

function resize() {
  const w = sceneEl.clientWidth, h = sceneEl.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(sceneEl); resize();

const clock = new THREE.Clock();
let t = 0;
let fpsN = 0, fpsT = performance.now(); window.__fps = 0;
let lastTileCheck = -1;
function frame() {
  if (++fpsN === 60) { window.__fps = Math.round(60000 / (performance.now() - fpsT)); fpsN = 0; fpsT = performance.now(); }
  const dt = Math.min(0.1, clock.getDelta()); t += dt;
  if (vjFollow) {   // ease toward the journey's broadcast position, which arrives once per tick
    const target = vjFollow.frac * TOTAL;
    S = Math.abs(target - S) > 500 ? target : S + (target - S) * Math.min(1, dt * 2);
    posEl.value = (S / NM).toFixed(3);
  }
  else if (playing) { S += dt * 6 * NM / 3600 * Number(speedEl.value); if (S >= TOTAL) { S = TOTAL; setPlaying(false); } posEl.value = (S / NM).toFixed(3); }
  if (anchor.state === 'up' && S >= TOTAL - 1) arrive();
  else if (anchor.state !== 'up' && S < TOTAL - 50) raiseAnchor();
  updateAnchor(dt);
  const pos = posAt(S), course = courseAt(S);
  if (t - lastTileCheck > 0.5) { lastTileCheck = t; updateTiles(pos[0], pos[1]); }
  smoothCourse = smoothCourse == null ? course : smoothCourse + (((course - smoothCourse + 540) % 360) - 180) * Math.min(1, dt * 1.5);
  const look = smoothCourse + yawOff;
  const bob = Math.sin(t * 1.1) * 0.12 + Math.sin(t * 0.63 + 1) * 0.08;
  boat.position.set(pos[0], bob, pos[1]);
  camera.fov = 55 / zoom; camera.updateProjectionMatrix();
  const roll = Math.sin(t * 0.9) * 0.012;
  const wantSails = eyeH > 24 && anchor.state === 'up';
  if (wantSails !== sailsUp) { sailsUp = wantSails; setSails(sailsUp); }
  heel += ((sailsUp ? THREE.MathUtils.degToRad(5) : 0) - heel) * Math.min(1, dt * 0.8);   // heeling to port
  bow.rotation.z = heel;   // the hull heels; the camera (a child of boat, not bow) stays level
  boat.rotation.set(Math.sin(t * 0.7) * 0.012, -THREE.MathUtils.degToRad(smoothCourse), roll * 2, 'YXZ');
  const ease = camK * camK * (3 - 2 * camK);
  // viewpoint height (Helm / 20 ft / 60 ft), eased so changes glide
  eyeH += (eyeTarget - eyeH) * Math.min(1, dt * 2.5);
  TILLER.set(0.35 * (eyeH <= EYE + 0.3 ? 1 : 0), eyeH, 1.0 + eyeBack(eyeH));
  if (eyeH > EYE + 0.3) TILLER.applyAxisAngle(UP_AXIS, -THREE.MathUtils.degToRad(yawOff * (1 - ease)));   // orbit the boat
  camera.position.lerpVectors(TILLER, AT_MAST, ease);
  camera.rotation.set(THREE.MathUtils.degToRad((pitch - eyeTilt(eyeH)) + (-38 - (pitch - eyeTilt(eyeH))) * ease), -THREE.MathUtils.degToRad(yawOff * (1 - ease)), -roll * 1.6, 'YXZ');
  for (const m of marks) {
    if (!m.fixedMark) { const d = Math.hypot(m.g.position.x - pos[0], m.g.position.z - pos[1]); m.g.scale.setScalar(Math.max(1, Math.min(6, d / 150))); m.g.position.y = Math.sin(t * 1.4 + m.phase) * 0.18; m.g.rotation.z = Math.sin(t * 1.1 + m.phase) * 0.06; m.g.rotation.x = Math.cos(t * 0.9 + m.phase) * 0.05; }
    if (m.lamp && m.fl) { const ph = (t + m.phase) % m.fl.per; m.lamp.visible = m.fl.fixed || (m.fl.iso ? ph < m.fl.per / 2 : ph < 0.45); }
  }
  water.material.uniforms.time.value += dt * 0.6;
  sky.position.set(boat.position.x, 0, boat.position.z);   // the dome travels with the boat
  clouds.material.map.offset.x += dt * 0.0004; clouds.material.map.offset.y += dt * 0.00015;   // drifting on a light westerly
  renderer.render(scene, camera);
  updateLabels(pos);
  const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect) * 180 / Math.PI;
  drawTape(((look % 360) + 360) % 360, hfov);
  drawChart(pos, (smoothCourse + 360) % 360, ((look % 360) + 360) % 360, hfov);
  if (rec) recFrame();
  document.getElementById('ro-cog').textContent = String(Math.round((smoothCourse + 360) % 360)).padStart(3, '0') + '° T';
  document.getElementById('ro-look').textContent = String(Math.round(((look % 360) + 360) % 360)).padStart(3, '0') + '° T';
  document.getElementById('ro-run').textContent = `${(S / NM).toFixed(1)}/${(TOTAL / NM).toFixed(1)} nm`;
  document.getElementById('ro-zoom').textContent = zoom.toFixed(1) + '×';
  if (lblFrame % 8 === 1) {
    let best = null;
    for (const m of marks) {
      if (m.kind !== 'buoy') continue;
      const dx = m.g.position.x - pos[0], dz = m.g.position.z - pos[1], d = Math.hypot(dx, dz);
      const rel = Math.abs((((Math.atan2(dx, -dz) * 180 / Math.PI) - smoothCourse + 540) % 360) - 180);
      if (rel < 30 && d < 3 * NM && (!best || d < best.d)) best = { m, d, rel };
    }
    document.getElementById('ro-ahead').textContent = best ? `${best.m.name}, ${(best.d / NM).toFixed(2)} nm` : 'None within 3 nm';
  }
  requestAnimationFrame(frame);
}
statusEl.hidden = true;
// ── Record: saves the view as a movie (direct request, v834) ──
// Each frame the 3D picture, heading tape, labels and corner chart are drawn onto one canvas,
// recorded with the anchor sounds by MediaRecorder; MP4 where the browser can (Chrome), else
// WebM. Stops itself once the anchor is set, or on a second click; the file goes to Downloads.
let rec = null;
const recBtn = document.createElement('button');
recBtn.type = 'button'; recBtn.id = 'recbtn'; recBtn.textContent = '⏺ Record';
recBtn.title = 'Record this journey as a movie (saved to your Downloads folder)';
recBtn.style.cssText = 'position:absolute;left:12px;top:74px;z-index:2;font:inherit;font-size:0.78rem;color:#e6eef1;background:rgba(20,34,42,0.55);border:0;border-radius:6px;padding:5px 10px;cursor:pointer';
recBtn.addEventListener('pointerdown', e => e.stopPropagation());
recBtn.addEventListener('click', () => rec ? stopRec() : startRec());
sceneEl.appendChild(recBtn);
async function startRec() {
  recBtn.disabled = true;
  unlockAudio();
  // only record sound that is actually running: a stalled audio track holds back the movie's clock
  if (audioCtx && audioCtx.state !== 'running') await Promise.race([audioCtx.resume(), new Promise(r => setTimeout(r, 400))]).catch(() => {});
  recBtn.disabled = false;
  const src = renderer.domElement, cv = document.createElement('canvas');
  cv.width = src.width - (src.width % 2); cv.height = src.height - (src.height % 2);
  const stream = cv.captureStream(0), vtrack = stream.getVideoTracks()[0];   // a frame each time one is drawn
  if (audioCtx?.state === 'running') { const dest = audioCtx.createMediaStreamDestination(); audioOut().connect(dest); for (const t of dest.stream.getAudioTracks()) stream.addTrack(t); }
  const type = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12e6 }), chunks = [];
  mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mr.onstop = () => {
    const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm', blob = new Blob(chunks, { type: type.split(';')[0] || 'video/webm' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${ROUTE.name.replace(/[\\/:*?"<>|]/g, '-')} - 3D journey.${ext}`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    recBtn.textContent = '⏺ Record'; recBtn.style.background = 'rgba(20,34,42,0.55)';
  };
  mr.start(1000);
  rec = { mr, cv, vtrack, c: cv.getContext('2d'), t0: performance.now(), stopAt: null };
  recBtn.style.background = 'rgba(176,40,32,0.85)';
}
function stopRec() { if (!rec) return; const r = rec; rec = null; r.mr.stop(); }
function recFrame() {
  const { c, cv } = rec, src = renderer.domElement, k = cv.width / sceneEl.clientWidth, box = sceneEl.getBoundingClientRect();
  c.drawImage(src, 0, 0, cv.width, cv.height);
  c.save(); c.scale(k, k);
  c.drawImage(tape, 0, 0, sceneEl.clientWidth, 28);
  if (!labelsEl.hidden) for (const el of labelPool) {
    if (el.hidden) continue;
    const x = parseFloat(el.style.left), y = parseFloat(el.style.top), buoy = el.classList.contains('buoy');
    c.font = buoy ? '500 11px "JetBrains Mono", monospace' : '600 13px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'bottom';
    c.shadowColor = 'rgba(0,0,0,0.75)'; c.shadowBlur = 4; c.fillStyle = '#fbfcf8'; c.fillText(el.textContent, x, y - 7);
    c.shadowBlur = 0; c.fillStyle = 'rgba(255,255,255,0.6)'; c.fillRect(x - 0.5, y - 6, 1, 6);
  }
  if (!chartEl.hidden && chartEl.offsetParent) { const r = chartEl.getBoundingClientRect(); c.drawImage(chartEl, r.left - box.left, r.top - box.top, r.width, r.height); }
  const credit = document.getElementById('town-credit');
  if (credit) { c.font = '10px system-ui, sans-serif'; c.textAlign = 'left'; c.textBaseline = 'bottom'; c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 3; c.fillStyle = 'rgba(255,255,255,0.8)'; c.fillText(credit.textContent, 8, sceneEl.clientHeight - 6); }
  c.restore();
  rec.vtrack.requestFrame?.();
  const sec = Math.floor((performance.now() - rec.t0) / 1000);
  recBtn.textContent = `⏹ Stop ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  if (anchor.state === 'set' && rec.stopAt == null) rec.stopAt = performance.now() + 2500;   // a moment at anchor, then save
  if (rec.stopAt != null && performance.now() > rec.stopAt) stopRec();
}
window.__helm3dReadyMs = Math.round(performance.now());   // time to first view, for measuring startup
requestAnimationFrame(frame);

// Follow a Virtual Journey running in the AudioChart window (it broadcasts its progress).
let vjFollow = null;
const vjNote = document.getElementById('vjnote');
try {
  const ch = new BroadcastChannel('audiochart-vj');
  ch.onmessage = (e) => {
    const m = e.data || {};
    if (m.routeId !== ROUTE.id) return;
    if (!m.running && m.frac >= 0.999) S = TOTAL;   // journey complete: arrive
    vjFollow = m.running ? { frac: Math.max(0, Math.min(1, m.frac)) } : null;
    vjNote.hidden = !vjFollow;
    playBtn.disabled = !!vjFollow;
  };
  ch.postMessage({ hello: true });   // ask the app where the journey is (it may already have arrived)
} catch (_) {}
window.__helm3d = { scene, renderer, camera, tiles, updateTiles, posAt, TOTAL, wx, wz, frame, setS: v => { S = v; }, setLook: (y, p) => { yawOff = y; pitch = p; }, setZoom: z => { zoom = z; } };   // console/testing hooks
}

// No route chosen: list saved routes and the samples.
async function showChooser() {
  statusEl.hidden = true;
  const box = document.getElementById('chooser'); box.hidden = false;
  let routes = [];
  try { routes = JSON.parse(localStorage.getItem('audiochart-user-routes') || '[]'); } catch (_) {}
  const list = box.querySelector('ul');
  const add = (href, text) => { const li = document.createElement('li'), a = document.createElement('a'); a.href = href; a.textContent = text; li.appendChild(a); list.appendChild(li); };
  try { for (const r of await (await fetch('./data/regions/penobscot-bay/curated_routes.json')).json()) add(`?sample=${encodeURIComponent(r.id)}`, `${r.name} (sample)`); } catch (_) {}
  routes.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 30).forEach(r => add(`?route=${encodeURIComponent(r.id || r.name)}`, r.name));
}

main().catch(e => fail('Something went wrong: ' + e.message));
