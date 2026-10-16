// AudioChart 3D helm view: a route sailed from the tiller of a Cape Dory 25D, built at runtime
// from USGS 3DEP elevation and USDA NAIP aerial photos (both allow cross-origin reads), with
// buoys, lights and names from the region's chart data. Opened from the Routes panel
// (helm3d.html?route=<id>) or for a sample (?sample=<curated id>). Desktop browser with WebGL.
import * as THREE from 'three';
import { Water } from './lib/three/Water.js';
import { depthAtFrom } from './depth.js';
import { LON0, LAT0, MX, MY, wx, wz, cachedFetch, readDem, photo, photoAtCells, addCanopy, gridMesh, photoMat, buildTown, spruce, tlog, tmark, TOWN_NIGHT } from './terrain3d.js';
import { makeWildlife, ledgesFrom } from './wildlife3d.js';
import { makeAngelique, ANGELIQUE, makeBowdoin, BOWDOIN } from './angelique3d.js';
import { makeSky, makeEnv, glowSprite, flashFor, sectorColour, weatherPanel, startConditions, makeTrimmer, cycleLook } from './weather3d.js';

const statusEl = document.getElementById('status');
const loadingNote = document.getElementById('tileload');
const fail = (msg) => { statusEl.textContent = msg; statusEl.hidden = false; };
window.addEventListener('error', e => fail('Something went wrong: ' + e.message));
const setStatus = (msg) => { statusEl.textContent = msg; };

// Your boat (v905, requested: "an alternative boat choice, like a Camden Windjammer, such as the
// Angelique"): the Cape Dory 25D, or the 95 ft gaff topsail ketch Angelique (sailboat3d.js), from
// ?boat= or the choice remembered in this browser (the Bird's-eye view shares it).
const BOAT_KEY = 'audiochart-boat', BOATS = { cd25: 'Sea Nymph, the Cape Dory 25D', angelique: 'Angelique', bowdoin: 'the schooner Bowdoin' };   // (Bowdoin v919)
const BOAT_TYPE = (() => { let b = new URLSearchParams(location.search).get('boat'); if (!b) { try { b = localStorage.getItem(BOAT_KEY); } catch (_) {} } return BOATS[b] ? b : 'cd25'; })();
const ANGEL = BOAT_TYPE !== 'cd25';   // one of the big vessels (Angelique, or Bowdoin since v919), from angelique3d.js
const SHIP = BOAT_TYPE === 'bowdoin' ? BOWDOIN : ANGELIQUE;
// the helmsman's eye: seated at the Cape Dory's tiller, or standing at Angelique's wheel on her afterdeck
const EYE = ANGEL ? SHIP.helm[1] : 2.0, HELM_X = ANGEL ? SHIP.helm[0] : 0.35, HELM_Z = ANGEL ? SHIP.helm[2] : 1.0, NM = 1852;
// Rockland Breakwater: not in the elevation data (water is flattened there); traced from the photo.
const BREAKWATER = [[-69.08197, 44.11540], [-69.07751, 44.10410]];

async function main() {
// ── Route and region ────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
if (params.get('embed')) document.body.classList.add('embed');
if (params.get('inchart')) document.body.classList.add('inchart');   // in the chart's Bird's-eye frame (v882)   // inside AudioChart during a Virtual Journey
const REGIONS = ['penobscot-bay', 'casco-bay', 'piscataqua'];
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`Could not load ${url}`); return r.json(); }
// Free Sailing (v890/v891, requested: Drone view follows free sailing): no route, so the scene is
// built for a 10 × 10 nm square round the boat: a "route" of east-west sweeps 3 km apart across
// it, which every route-shaped piece below (near tiles, the horizon, trees, towns) is happy with.
// The boat goes wherever AudioChart's free-sailing boat goes (BroadcastChannel, {free}); near the
// square's edge the view reloads centred on her again.
const FREE = params.get('free') ? { lat: +params.get('lat'), lon: +params.get('lon'), hdg: +params.get('hdg') || 0, kn: +params.get('kn') || 0 } : null;
const FREE_R = 5 * 1852;
function freeRoute() {
  const dLat = FREE_R / 111120, dLon = FREE_R / (111320 * Math.cos(FREE.lat * Math.PI / 180)), pts = [[FREE.lon, FREE.lat]];
  for (let k = 0, y = -dLat; y <= dLat + 1e-9; y += 3000 / 111120, k++) {
    const row = [[FREE.lon - dLon, FREE.lat + y], [FREE.lon + dLon, FREE.lat + y]];
    pts.push(...(k % 2 ? row.reverse() : row));
  }
  return { id: 'free', name: 'Free Sailing', points: pts, overnight: [] };
}
async function findRoute() {
  if (FREE) return freeRoute();
  const id = params.get('route'), sample = params.get('sample');
  if (id) {
    let routes = [];
    try { routes = JSON.parse(localStorage.getItem('audiochart-user-routes') || '[]'); } catch (_) {}
    const r = routes.find(x => x.id === id) || routes.find(x => x.name === id);
    if (r) return { id: r.id || r.name, name: r.name, points: r.points.map(p => [p.lon, p.lat]), overnight: r.points.map(p => !!p.overnight) };
  }
  if (sample) {
    for (const url of [...REGIONS.map(g => `./data/regions/${g}/curated_routes.json`), './data/curated_routes.json']) {
      let list; try { list = await getJSON(url); } catch (_) { continue; }
      const r = list.find(x => x.id === sample);
      if (r) return { id: r.id, name: r.name, points: r.points.map(p => Array.isArray(p) ? p : [p.lon, p.lat]), overnight: r.points.map(p => !Array.isArray(p) && !!p.overnight) };
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
function treeGeoms() { if (!SPRUCE_DETAILED) ({ detailed: SPRUCE_DETAILED, simple: SPRUCE_SIMPLE, mat: TREE_MAT } = spruce()); }
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
  const mat = photoMat(ph, renderer.capabilities.getMaxAnisotropy()), wasNear = T.full.visible;
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
// Through the binoculars (v908) the shore you're looking at, out to BINO_M, gets full detail: tiles
// along the sight lines are added to the grid if the route didn't need them, loaded first, and kept.
let binocView = null;   // { bearing (true), hfov } while the glasses are up
const tileKey = new Set();
function binocTiles(px, pz) {
  if (!binocView) return new Set();
  const seen = new Set();
  for (const off of [-0.5, -0.25, 0, 0.25, 0.5]) {
    const b = THREE.MathUtils.degToRad(binocView.bearing + off * binocView.hfov);
    for (let t = 800; t <= 9000; t += 700) {
      const lon = (px + Math.sin(b) * t) / MX + LON0, lat = -(pz - Math.cos(b) * t) / MY + LAT0;
      const w = +(Math.floor(lon / TW) * TW).toFixed(4), s0 = +(Math.floor(lat / TH) * TH).toFixed(4), k = `${w},${s0}`;
      if (!tileKey.has(k)) { tileKey.add(k); const e = +(w + TW).toFixed(4), n = +(s0 + TH).toFixed(4); tiles.push({ w, s: s0, e, n, x0: wx(w), x1: wx(e), z0: wz(n), z1: wz(s0), state: 'idle' }); }
      seen.add(k);
    }
  }
  return seen;
}
function updateTiles(px, pz) {
  if (!tileKey.size) for (const T of tiles) tileKey.add(`${T.w},${T.s}`);
  const inGlass = binocTiles(px, pz), seen = T => inGlass.has(`${T.w},${T.s}`) && rectDist(T, px, pz) < BINO_M;
  for (const T of tiles) {
    const d = rectDist(T, px, pz), g = seen(T);
    if (T.state === 'ready') { const nearT = d < LOD_NEAR_M || g; T.full.visible = nearT; T.coarse.visible = !nearT; }
    if (d > DROP_M && !g && (T.state === 'ready' || T.state === 'loading')) dropTile(T);
  }
  const want = tiles.filter(T => T.state === 'idle' && (rectDist(T, px, pz) < LOAD_M || seen(T))).sort((a, b) => (seen(b) - seen(a)) || rectDist(a, px, pz) - rectDist(b, px, pz));
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
    const m2 = gridMesh(dem, ph, stride, photoMat(ph, renderer.capabilities.getMaxAnisotropy()));
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
// your boat's speed from AudioChart's settings (the same one a Virtual Journey uses), else 5 kn (v862)
const BOAT_KN = (() => { let v = NaN; try { v = parseFloat(localStorage.getItem('audiochart-last-speed')); } catch (_) {} return v > 0 && v < 40 ? v : 5; })();
const routeW = routeLL.map(([x, y]) => [wx(x), wz(y)]);
const regionDir = await regionFor(routeLL[0][0], routeLL[0][1]);
setStatus('Loading chart data…');
const [navGJ, placesGJ, landGJ] = await Promise.all([getJSON(`${regionDir}/navaid.geojson`), getJSON(`${regionDir}/named_places.geojson`), getJSON('./data/landmarks.json').catch(() => ({ landmarks: [] }))]);
// Headings are magnetic (v869, requested), as on a boat's compass: the region's charted variation
// (e.g. 15.3° W in Penobscot Bay, stored as -15.3, east positive), magnetic = true - variation.
let MAGVAR = -15.3;
getJSON(`${regionDir}.json`).then(r => { if (typeof r.magvar === 'number') MAGVAR = r.magvar; }).catch(() => {});
const toMag = t => ((t - MAGVAR) % 360 + 360) % 360;
// Depth readout (v865): charted depth under the boat from the region's soundings and DEPARE
// shallow-area bands (shared depth.js). Loaded in the background; the readout shows — until then.
let depthSnd = null, depthZones = null, wildlifeLedges = null, wildlife = null;
getJSON(`${regionDir}/soundings.geojson`).then(fc => { depthSnd = fc; }).catch(() => {});
getJSON(`${regionDir}/hazards.geojson`).then(fc => {
  depthZones = fc.features.filter(f => f.properties?.label === 'shallow area' && f.geometry?.type !== 'Point');
  wildlifeLedges = ledgesFrom(fc, wx, wz); wildlife?.setLedges(wildlifeLedges);
}).catch(() => {});
const DRAFT_FT = (() => { let v = NaN; try { v = parseFloat(localStorage.getItem('audiochart-draft-ft')); } catch (_) {} return v > 0 ? v : 5; })();

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
const hemi = new THREE.HemisphereLight(0xe4ecf2, 0x4a5644, 1.7); scene.add(hemi);
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
  .map(f => ({ t: f.properties.objtype, n: f.properties.name, c: f.properties.colour, s: f.properties.shape, ch: f.properties.characteristic, sec: f.properties.sectors, only: !!f.properties.sector_only, x: f.geometry.coordinates[0], y: f.geometry.coordinates[1] }));
const places = placesGJ.features.filter(f => f.geometry.type === 'Point' && inFar(f.geometry.coordinates) && ['LNDARE', 'LNDRGN', 'LIGHTS', 'BUAARE'].includes(f.properties.objtype))
  .map(f => ({ t: f.properties.objtype, n: f.properties.name, x: f.geometry.coordinates[0], y: f.geometry.coordinates[1] }));
// summits (data/landmarks.json): labelled from farther off, at their real height
for (const l of landGJ.landmarks || []) if (inFar([l.lon, l.lat])) places.push({ t: 'SUMMIT', n: l.name, x: l.lon, y: l.lat, elev: l.elev_m });

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

async function addTowns() {
  let list;
  try { list = await getJSON('./data/buildings/index.json'); } catch (_) { return; }
  const lons = routeLL.map(p => p[0]), lats = routeLL.map(p => p[1]), padLon = 0.06, padLat = 0.045;
  for (const town of list) {
    const [w, s, e, n] = town.bbox;
    if (e < Math.min(...lons) - padLon || w > Math.max(...lons) + padLon || n < Math.min(...lats) - padLat || s > Math.max(...lats) + padLat) continue;
    try { const T = await getJSON(`./data/buildings/${town.file}`); scene.add(buildTown(T)); townCredit(T); console.log(`[helm3d] ${T.name}: ${T.buildings.length} buildings, ${T.piers.length} piers`); } catch (err) { console.warn('[helm3d] buildings', town.file, err); }
  }
}
function townCredit(T) {
  let c = document.getElementById('town-credit');
  if (!c) {
    c = document.createElement('div'); c.id = 'town-credit'; c.textContent = 'Buildings © OpenStreetMap contributors';
    c.style.cssText = 'position:absolute;left:8px;bottom:6px;z-index:2;font-size:10px;color:rgba(255,255,255,0.75);text-shadow:0 0 3px rgba(0,0,0,0.6);pointer-events:none';
    document.querySelector('.scene').appendChild(c);
  }
  if (/Microsoft/.test(T.credit || '') && !/Microsoft/.test(c.textContent)) c.textContent += ', Microsoft';   // gaps filled from Microsoft's footprints
}
addTowns();

// Cape Dory 25D (Alberg design: 25 ft LOA, 8 ft beam), seen from the tiller. Boat frame:
// y up from the waterline, -z forward, x to starboard; the helmsman's eye is at (0.35, EYE, 0).
// mainsail and jib, set while under way with any wind (see the sails in the model below); heel eases in with them
let setSails = () => {}, trimSails = () => {}, sailsUp = false, heel = 0;
const bow = new THREE.Group();
{
  const M = c => new THREE.MeshLambertMaterial({ color: c });
  const BUFF = M(0xe4d9bf), WHITE = M(0xf3f0e8), TEAK = M(0x93613a), BRONZE = M(0xa8743a), STEEL = M(0xc3cacf);
  const SPAR = M(0xd8dcdf), COVER = M(0x22304d), GLASS = M(0x1d2a30);
  const STRIPE = M(0x1f3352), BOTTOM = M(0x6e2a22);   // navy boot-top and cove stripes, red antifouling
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
  // topsides (v902, more like the real boat): white, from the sheer down to the waterline. An
  // Alberg spoon bow: the stem rakes well forward of where it meets the water (LOA 24'7", LWL 19'),
  // its profile curving aft ever faster toward the waterline; under it, red antifouling down to the
  // turn of the bilge (seen when she heels). v: 0 at the sheer, 1 at the waterline.
  const OVB = 0.85, huF = u => 1.2 * Math.sqrt(Math.max(0, 1 - Math.pow(Math.min(1, u), 2.4)));
  const fwdPt = (s, u, v, out = 0) => {
    const zd = zAt(u), f = v ** 1.8, z = zd + (Z0 + u * (L + OVB) - zd) * f;
    return [s * huF(u) * (1 - 0.1 * f) * (1 + out), sheer(zd) * (1 - v), z];
  };
  const fwdUnder = (s, u, v) => { const z = Z0 + u * (L + OVB + 0.55 * v); return [s * huF(u) * 0.9 * (1 - 0.55 * v ** 1.3), -0.45 * v, z]; };
  // a stripe from depth d0 to d1 below the sheer (each a number or a function of u), just proud of the topsides
  const band = (pt, sh, d0, d1, mat, n = 48) => {
    const at = (d, u) => typeof d === 'function' ? d(u) : d;
    for (const s of [-1, 1]) bow.add(loft(n, 1, (u, a) => pt(s, u, (at(d0, u) + (at(d1, u) - at(d0, u)) * a) / sh(u), 0.006), mat));
  };
  for (const s of [-1, 1]) {
    bow.add(loft(48, 6, (u, v) => fwdPt(s, u, v), WHITE));
    bow.add(loft(32, 4, (u, v) => fwdUnder(s, u, v), BOTTOM));
  }
  const shF = u => sheer(zAt(u));
  band(fwdPt, shF, u => shF(u) - 0.1, shF, STRIPE);   // boot-top, 4" above the water
  band(fwdPt, shF, 0.1, 0.13, STRIPE);                 // cove stripe under the toe rail
  // cabin trunk: rounded-front plan, sides leaning in slightly, cambered top
  const TZ0 = Z0, TZ1 = -3.0, TL = TZ1 - TZ0;
  const thw = z => { const t = (z - TZ0) / TL; return Math.min(half(z) - 0.3, 0.86) * Math.pow(Math.max(0, 1 - Math.pow(t, 6)), 0.5); };
  const trunkBase = z => sheer(z) + 0.04, trunkTop = (z, x) => sheer(z) + 0.46 - 0.06 * ((z - TZ0) / TL) + 0.05 * (1 - Math.min(1, (x / (thw(z) || 1e-3)) ** 2));
  // trunk stations crowd toward its rounded front, where the width falls away fast; the deck's inner
  // edge uses the very same stations, so no sliver of open hull shows between deck and trunk (v905,
  // reported from the Drone view: dark holes either side of the trunk's forward end)
  const tz = u => TZ0 + (1 - Math.pow(1 - u, 3)) * TL;
  // deck (buff non-skid), open under the trunk (v903: it ran across inside the cabin as a false ceiling)
  const deckRow = (z, sd, v) => { const b = half(z), w = Math.min(thw(z), b), x = sd * (w + v * (b - w)); return [x, deckY(z, x), z]; };
  for (const sd of [-1, 1]) {
    bow.add(loft(48, 8, (u, v) => deckRow(tz(u), sd, v), BUFF));                        // beside the trunk
    bow.add(loft(32, 8, (u, v) => deckRow(TZ1 + u * (ZS - TZ1), sd, v), BUFF));         // foredeck
  }
  bow.add(loft(48, 12, (u, v) => { const z = tz(u), w = thw(z) - 0.04, x = (v * 2 - 1) * w; return [x, trunkTop(z, x), z]; }, BUFF));
  for (const s of [-1, 1]) bow.add(loft(48, 2, (u, v) => {
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
  // aft topsides (v902): a short counter, the raked transom meeting the water OVS forward of its top
  const OVS = 0.55, aftPt = (s, u, v, out = 0) => {
    const zd = Z0 + u * (ZT - Z0), f = v ** 1.3, z = zd + (Z0 + u * (ZT - OVS - Z0) - zd) * f;
    return [s * halfA(zd) * (1 - 0.16 * f) * (1 + out), sheerA(zd) * (1 - v), z];
  };
  const aftUnder = (s, u, v) => { const z = Z0 + u * (ZT - OVS - Z0) - 0.5 * u ** 3 * v; return [s * halfA(Z0 + u * (ZT - Z0)) * 0.84 * (1 - (0.45 + 0.4 * u) * v ** 1.2), -0.45 * v, z]; };
  for (const sd of [-1, 1]) {
    bow.add(loft(16, 6, (u, v) => aftPt(sd, u, v), WHITE));
    bow.add(loft(12, 4, (u, v) => aftUnder(sd, u, v), BOTTOM));
  }
  const shA = u => sheerA(Z0 + u * (ZT - Z0));
  band(aftPt, shA, u => shA(u) - 0.1, shA, STRIPE, 16);
  band(aftPt, shA, 0.1, 0.13, STRIPE, 16);
  // transom: the raked plane between the two topsides' after edges, a touch of round to it, the
  // boot-top carried across; under it, the bottom closes in to the rudder
  const trPt = (a, v, out = 0) => { const p = aftPt(-1, 1, v), q = aftPt(1, 1, v); return [p[0] + (q[0] - p[0]) * a, p[1], p[2] + 0.05 * Math.sin(Math.PI * a) + out]; };
  bow.add(loft(8, 10, (v, a) => trPt(a, v), WHITE));
  bow.add(loft(1, 10, (v, a) => trPt(a, 1 - (0.1 * (1 - v)) / sheerA(ZT), 0.006), STRIPE));
  bow.add(loft(4, 8, (v, a) => { const p = aftUnder(-1, 1, v), q = aftUnder(1, 1, v); return [p[0] + (q[0] - p[0]) * a, p[1], p[2]]; }, BOTTOM));
  { // transom-hung "barn door" rudder (as the 25D's): its leading edge follows the transom's rake,
    // bronze pintles, the tiller over the transom from the rudder head
    const zLE = y => ZT - OVS + OVS * y / sheerA(ZT), sh = new THREE.Shape(), top = sheerA(ZT) + 0.17;
    sh.moveTo(zLE(top) + 0.02, top); sh.lineTo(zLE(top) + 0.16, top);
    sh.bezierCurveTo(zLE(0.5) + 0.22, 0.5, zLE(0.1) + 0.42, 0.1, zLE(-0.5) + 0.46, -0.5);
    sh.quadraticCurveTo(zLE(-1.0) + 0.42, -1.05, zLE(-1.0) + 0.05, -1.0);
    sh.lineTo(zLE(-1.0), -1.0); sh.lineTo(zLE(top), top);
    const rud = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 1, curveSegments: 10 }), WHITE);
    rud.rotation.y = -Math.PI / 2; rud.position.x = 0.025; bow.add(rud);
    for (const y of [0.75, 0.25, -0.35]) { const pin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.14), BRONZE); pin.position.set(0, y, zLE(y) + 0.02); pin.rotation.x = Math.atan(OVS / sheerA(ZT)); bow.add(pin); }
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
  // Below (v903, reported: from the tiller you looked through the open after end of the cabin into an
  // empty hull with the sea running through it). The bridge-deck bulkhead now closes the trunk, with
  // the companionway open in it, and below is the 25D's cabin: teak-and-holly sole, companionway
  // ladder over the engine box, galley to port (sink with its pump faucet, two-burner stove), icebox to starboard,
  // settee berths each side with backrests, the drop-leaf table on the compression post, the main
  // bulkhead with its doorway and the V-berth beyond. The sea is kept out of the hull by a
  // depth-only cap across the inside at the bridge deck's height (drawn after the cabin, before the
  // water), so the water plane can't show through the bilge.
  {
    const SOLE = -0.22, IN = M(0xf0ebe0), CUSH = M(0x2f4a6b), STAIN = M(0xb9c0c4), BLACK = M(0x26292c), HOLLY = M(0xc9a978);
    const box = (w, h, d, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); bow.add(b); return b; };
    // bridge-deck bulkhead at the trunk's after end, the companionway cut out of it
    const BZ = Z0 + 0.01, tw0 = thw(Z0), sh = new THREE.Shape();
    sh.moveTo(-0.725, 0.45); sh.lineTo(0.725, 0.45); sh.lineTo(0.725, trunkBase(Z0)); sh.lineTo(tw0, trunkBase(Z0));
    for (let k = 0; k <= 12; k++) { const x = tw0 - 2 * tw0 * k / 12; sh.lineTo(x, trunkTop(Z0, x) - 0.01); }
    sh.lineTo(-tw0, trunkBase(Z0)); sh.lineTo(-0.725, trunkBase(Z0)); sh.closePath();
    const door = new THREE.Path(), dy0 = 0.86, dy1 = trunkTop(Z0, 0) - 0.07;
    door.moveTo(-0.27, dy0); door.lineTo(-0.24, dy1); door.lineTo(0.24, dy1); door.lineTo(0.27, dy0); door.closePath(); sh.holes.push(door);
    const bh = new THREE.Mesh(new THREE.ShapeGeometry(sh, 4), WHITE); bh.position.z = BZ; bow.add(bh);
    for (const s of [-1, 1]) box(0.05, dy1 - dy0, 0.05, s * 0.28, (dy0 + dy1) / 2, BZ + 0.02, TEAK);   // companionway trim
    box(0.6, 0.04, 0.06, 0, dy0 - 0.02, BZ + 0.02, TEAK);                                               // sill
    // sole and ladder
    box(0.7, 0.03, 2.2, 0, SOLE, -2.0, HOLLY);
    box(0.66, 0.97, 0.3, 0, SOLE + 0.485, BZ - 0.16, IN);                                              // the diesel's box, under the bridge deck
    for (let k = 0; k < 3; k++) box(0.42, 0.035, 0.16, 0, SOLE + 0.24 * (k + 1), BZ - 0.38 - 0.16 * (2 - k), TEAK);
    for (const s of [-1, 1]) { const rail = box(0.035, 1.05, 0.06, s * 0.23, SOLE + 0.42, BZ - 0.55, TEAK); rail.rotation.x = -0.45; }
    // galley to port: counter, sink with a pump faucet, two-burner stove; icebox to starboard
    box(0.55, 0.62, 0.7, -0.68, SOLE + 0.31, -1.3, IN);
    box(0.58, 0.04, 0.73, -0.68, SOLE + 0.64, -1.3, TEAK);
    box(0.3, 0.02, 0.26, -0.7, SOLE + 0.665, -1.12, STAIN); box(0.24, 0.025, 0.2, -0.7, SOLE + 0.668, -1.12, BLACK);   // sink, its basin
    const tap = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.22, 6), STAIN); tap.position.set(-0.86, SOLE + 0.76, -1.12); bow.add(tap);
    const spout = box(0.02, 0.02, 0.12, -0.86, SOLE + 0.86, -1.07, STAIN);
    box(0.34, 0.08, 0.3, -0.68, SOLE + 0.7, -1.47, STAIN);                                              // stove
    for (const dz of [-0.07, 0.07]) { const b = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.01, 4, 12), BLACK); b.rotation.x = Math.PI / 2; b.position.set(-0.68, SOLE + 0.75, -1.47 + dz); bow.add(b); }
    // chart table to starboard (v905, requested: "galley sink, chart table, and berths"), over the
    // icebox: a chart of the bay on it with parallel rules, the VHF and depth sounder on the bulkhead above
    box(0.55, 0.62, 0.7, 0.68, SOLE + 0.31, -1.3, IN); box(0.58, 0.04, 0.73, 0.68, SOLE + 0.64, -1.3, TEAK);
    for (const dz of [-0.36, 0.36]) box(0.58, 0.03, 0.02, 0.68, SOLE + 0.675, -1.3 + dz, TEAK);        // fiddles
    {
      const c = document.createElement('canvas'); c.width = 128; c.height = 160; const g = c.getContext('2d');
      g.fillStyle = '#dfeaf0'; g.fillRect(0, 0, 128, 160);                                             // water
      g.fillStyle = '#efe2b8';                                                                          // land and islands
      g.beginPath(); g.moveTo(0, 0); g.lineTo(46, 0); g.bezierCurveTo(30, 40, 52, 70, 26, 110); g.lineTo(0, 160); g.closePath(); g.fill();
      for (const [x, y, r] of [[80, 40, 10], [96, 90, 14], [70, 128, 7], [112, 140, 6]]) { g.beginPath(); g.ellipse(x, y, r, r * 0.7, 0.6, 0, 7); g.fill(); }
      g.strokeStyle = '#9ab3c2'; g.lineWidth = 1; for (let k = 0; k < 6; k++) { g.beginPath(); g.moveTo(0, 20 + k * 25); g.bezierCurveTo(50, 30 + k * 25, 80, 10 + k * 25, 128, 22 + k * 25); g.stroke(); }
      g.strokeStyle = '#7a4b9a'; g.beginPath(); g.arc(92, 30, 16, 0, 7); g.stroke();                   // compass rose
      g.strokeStyle = '#333'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(40, 150); g.lineTo(60, 96); g.lineTo(88, 60); g.stroke();   // pencilled course
      const chart = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.56), new THREE.MeshLambertMaterial({ map: new THREE.CanvasTexture(c) }));
      chart.rotation.x = -Math.PI / 2; chart.rotation.z = 0.08; chart.position.set(0.67, SOLE + 0.663, -1.3); bow.add(chart);
      const rule = box(0.05, 0.012, 0.36, 0.6, SOLE + 0.67, -1.28, M(0x9fb6c0)); rule.rotation.y = 0.5;   // parallel rules
    }
    box(0.26, 0.09, 0.05, 0.55, SOLE + 1.0, BZ - 0.04, BLACK);                                          // VHF
    box(0.05, 0.04, 0.012, 0.6, SOLE + 1.0, BZ - 0.068, M(0x6fd08a));                                   // its display
    box(0.12, 0.12, 0.04, 0.82, SOLE + 1.0, BZ - 0.04, BLACK);                                          // depth sounder
    box(0.08, 0.06, 0.012, 0.82, SOLE + 1.01, BZ - 0.063, M(0xd8e8a0));
    // settee berths with backrests, port and starboard
    for (const s of [-1, 1]) {
      box(0.5, 0.36, 1.3, s * 0.62, SOLE + 0.18, -2.3, IN);
      box(0.52, 0.11, 1.3, s * 0.62, SOLE + 0.42, -2.3, CUSH);
      const back = box(0.1, 0.4, 1.3, s * 0.9, SOLE + 0.7, -2.3, CUSH); back.rotation.z = s * 0.18;
      for (const y of [0.98, 1.12]) box(0.02, 0.04, 1.3, s * 0.97, SOLE + y, -2.3, TEAK);             // ceiling strips above
    }
    // drop-leaf table on the compression post under the mast
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 8), TEAK); post.position.set(0, SOLE + 0.75, -2.72); bow.add(post);
    box(0.5, 0.03, 0.75, 0, SOLE + 0.68, -2.35, TEAK);
    // main bulkhead with its doorway, the V-berth forward
    const mb = new THREE.Shape(), MBZ = -3.02;
    // cut to the hull and under the deck's crown (v905: it stood 1.25 m tall, through the foredeck either side of the trunk)
    const mt = half(MBZ) - 0.05, mbTop = x => deckY(MBZ, x) - 0.02;
    mb.moveTo(-0.7, SOLE); mb.lineTo(0.7, SOLE); mb.lineTo(mt, 0.55);
    for (let k = 0; k <= 12; k++) { const x = mt - 2 * mt * k / 12; mb.lineTo(x, mbTop(x)); }
    mb.lineTo(-mt, 0.55); mb.closePath();
    const dw = new THREE.Path(), dTop = mbTop(0) - 0.08; dw.moveTo(-0.22, SOLE + 0.05); dw.lineTo(0.22, SOLE + 0.05); dw.lineTo(0.22, dTop); dw.lineTo(-0.22, dTop); dw.closePath(); mb.holes.push(dw);
    const mbm = new THREE.Mesh(new THREE.ShapeGeometry(mb), TEAK); mbm.position.z = MBZ; bow.add(mbm);
    const vb = new THREE.Shape(); vb.moveTo(-0.85, 0); vb.lineTo(0.85, 0); vb.lineTo(0.1, -1.5); vb.lineTo(-0.1, -1.5); vb.closePath();
    const vg = new THREE.ExtrudeGeometry(vb, { depth: 0.12, bevelEnabled: false }); vg.rotateX(Math.PI / 2);
    const vm = new THREE.Mesh(vg, CUSH); vm.position.set(0, SOLE + 0.62, MBZ - 0.05); bow.add(vm);
    // keep the sea out: the inside of the hull at the bridge deck's height, depth only
    const cap = new THREE.MeshBasicMaterial({ colorWrite: false });
    const y = 0.42, fwd = (s, u) => fwdPt(s, u, 1 - y / sheer(zAt(u)), -0.01);   // the hull's own section there, a hair inside
    const mask = loft(48, 1, (u, a) => { const p = fwd(-1, u), q = fwd(1, u); return [p[0] + (q[0] - p[0]) * a, y, p[2]]; }, cap);
    mask.renderOrder = 1; bow.add(mask);
  }
  // tiller from the rudder head at the transom forward into the cockpit
  const tillerG = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.6, 8), TEAK);
  tillerG.position.set(0, sheerA(ZT) + 0.27, ZT - 0.67); tillerG.rotation.x = Math.PI / 2 + 0.12; bow.add(tillerG);
  // backstay and stern pulpit
  wire([0, MTOP, MZ], [0, sheerA(ZT) + 0.1, ZT - 0.05]);
  const spul = new THREE.CatmullRomCurve3([[-halfA(1.7) + 0.06, 1.7], [-0.7, ZT - 0.05], [0.7, ZT - 0.05], [halfA(1.7) - 0.06, 1.7]].map(([x, z]) => new THREE.Vector3(x, sheerA(z) + PH, z)));
  bow.add(new THREE.Mesh(new THREE.TubeGeometry(spul, 30, 0.02, 6), STEEL));
  for (const [x, z] of [[-0.7, ZT - 0.05], [0.7, ZT - 0.05]]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, PH, 6), STEEL); leg.position.set(x, sheerA(z) + PH / 2, z); bow.add(leg); }
  // Sails (Drone view, v837): mainsail and jib, built out to port and trimmed to the wind by
  // trimSails (v869: boom angle, jib sheet, tack and heel follow the wind direction). Each is a lofted
  // surface with a belly (deepest ~40% back from the luff) and twist toward the head.
  // v902: Dacron white with cross-cut panel seams and a leech tabling (a canvas texture), and a
  // little glow of its own so a sail seen against the light reads as cloth, not grey board
  const clothTex = (() => {
    const c = document.createElement('canvas'); c.width = 128; c.height = 512;
    const x = c.getContext('2d'); x.fillStyle = '#f7f4ec'; x.fillRect(0, 0, 128, 512);
    x.fillStyle = 'rgba(120,110,90,0.28)'; for (let k = 1; k < 11; k++) x.fillRect(0, Math.round(k * 512 / 11), 128, 2);
    x.fillStyle = 'rgba(150,140,120,0.35)'; x.fillRect(122, 0, 6, 512); x.fillRect(0, 0, 3, 512);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
  })();
  const CLOTH = new THREE.MeshLambertMaterial({ color: 0xffffff, map: clothTex, emissive: 0x5a5750, side: THREE.DoubleSide });
  function sail(luff, leech, belly, nu = 14, nv = 10) {   // luff(u), leech(u): points; belly(u): leeward unit vector
    const pos = [], idx = [], uv = [];
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, a = luff(u), b = leech(u), w = belly(u), chord = a.distanceTo(b);
      for (let j = 0; j <= nv; j++) {
        const v = j / nv, depth = chord * 0.11 * Math.sin(Math.PI * Math.pow(v, 0.8));
        const p = a.clone().lerp(b, v).addScaledVector(w, depth); pos.push(p.x, p.y, p.z); uv.push(v, u);
      }
    }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const k = i * (nv + 1) + j; idx.push(k, k + nv + 1, k + 1, k + 1, k + nv + 1, k + nv + 2); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    return new THREE.Mesh(g, CLOTH);
  }
  const V3 = THREE.Vector3;
  // mainsail in the boom's frame (the group turns with the boom): luff up the mast, foot along
  // the boom, the leech curving in from the clew to the head, twisting off further outboard aloft
  const mainH = MTOP - 0.35 - BY, twist = u => THREE.MathUtils.degToRad(-12) * u;
  const main = sail(
    u => new V3(0, 0.08 + u * mainH, 0.06),
    u => { const r = 3.05 * (1 - u) * (1 + 0.18 * Math.sin(Math.PI * u)) + 0.12 * u, t = twist(u); return new V3(Math.sin(t) * r, 0.08 + u * mainH, 0.06 + Math.cos(t) * r); },
    u => new V3(-Math.cos(twist(u)), 0, Math.sin(twist(u)) * 0.2).normalize());
  main.visible = false; boomG.add(main);
  // jib: luff on the forestay; the clew swings round the tack as it is sheeted (trimSails)
  const tack = new V3(0, sheer(ZS) + 0.25, ZS + 0.05), stayTop = new V3(0, MTOP, MZ), headJ = tack.clone().lerp(stayTop, 0.84);
  const CLEW_R = Math.hypot(1.55, MZ + 0.2 - tack.z), CLEW_Y = 1.75;
  const jibAt = (deg, side) => {   // side +1: out to port
    const a = THREE.MathUtils.degToRad(deg), clew = new V3(-side * Math.sin(a) * CLEW_R, CLEW_Y, tack.z + Math.cos(a) * CLEW_R);
    return sail(u => tack.clone().lerp(headJ, u), u => clew.clone().lerp(headJ, u),
      u => { const c = clew.clone().lerp(headJ, u).sub(tack.clone().lerp(headJ, u)); return new V3(c.z, 0, -c.x).multiplyScalar(side).setY(0).normalize(); }).geometry;
  };
  const jib = new THREE.Mesh(jibAt(36, 1), CLOTH);
  jib.visible = false; bow.add(jib);
  let jibKey = '';
  setSails = on => {
    main.visible = jib.visible = on; cover.visible = !on;
    if (!on) boomG.rotation.y = 0;
  };
  // Sail trim (v869): boom and jib clew angles in degrees off the centreline, side +1 = sails out
  // to port (wind from starboard), jibOn false = jib furled (motoring to windward).
  trimSails = (boomDeg, jibDeg, side, jibOn) => {
    boomG.rotation.y = -side * THREE.MathUtils.degToRad(boomDeg);
    main.scale.x = side < 0 ? -1 : 1;   // the mainsail's belly to leeward
    jib.visible = main.visible && jibOn;
    const key = `${Math.round(jibDeg * 2)},${Math.sign(side)}`;
    if (jibOn && key !== jibKey) { jibKey = key; jib.geometry.dispose(); jib.geometry = jibAt(jibDeg, Math.sign(side) || 1); }
  };
}
// Point of sail and trim (v869): weather3d.js's makeTrimmer, shared with the Bird's-eye fleet.
const WIND_DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const trimmer = makeTrimmer();
function pointOfSail(course, dt) {
  const p = trimmer(env.C.windFrom, course, WND.tws ?? 8, BOAT_KN, dt);
  const tackTxt = WND.heel === 0 || p.noGo ? '' : `, ${p.tack > 0 ? 'starboard' : 'port'} tack`;   // the side the boom is on, dead downwind too
  return { ...p, label: (WND.heel === 0 ? 'calm' : p.name) + tackTxt };
}

// The boat is its own object: it points along the course and pitches/rolls; the camera sits at
// the tiller inside it, so looking around turns your head, not the boat.
const boat = new THREE.Group();
boat.add(bow);
scene.add(boat);
boat.add(camera);
camera.position.set(HELM_X, EYE, HELM_Z);   // at the tiller, aft end of the cockpit (Angelique: her wheel)
// Angelique in place of the Cape Dory: the Cape Dory's model is hidden (the lights added to bow
// below are placed for whichever boat it is); she heels and trims herself (frame())
const angel = ANGEL ? (BOAT_TYPE === 'bowdoin' ? makeBowdoin() : makeAngelique()) : null;   // angelique3d.js (v906: her own detailed model)
if (angel) { for (const o of bow.children) o.visible = false; angel.wake(0); boat.add(angel.group); }
if (angel) { const sub = document.querySelector('.sub'); if (sub) sub.firstChild.textContent = sub.firstChild.textContent.replace('From the tiller of a Cape Dory 25D', BOAT_TYPE === 'bowdoin' ? "From the wheel of Bowdoin, Maine Maritime Academy's Arctic schooner" : "From the wheel of Angelique, Camden's gaff topsail ketch"); }
// her own wake (v902; the ferries had one, she didn't): a fading fan of foam astern and a curl at
// the bow, on a level group that follows her position and heading (not her bob, pitch or heel,
// which tipped the far end of a 50 m fan under the water), showing with her speed through the water
const wakeG = new THREE.Group(); scene.add(wakeG);
if (ANGEL) wakeG.scale.setScalar(3.6 * SHIP.L / 29);   // a big vessel's wake: the same foam, sized to her
const ownWake = (() => {
  // foam drawn on a canvas, the apex at the top (forward): the two diverging arms of the wake,
  // broken and fading, and (astern only) the churned streak right behind her
  const foam = (w, h, spread, churn) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); let sd = 7; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 2600; i++) {
      const t = rr() ** 0.8, side = rr() < 0.5 ? -1 : 1, a = (1 - t) ** 1.4;
      const arm = w / 2 + side * (w * 0.04 + spread * w * t) + (rr() - 0.5) * (3 + 14 * t);
      x.fillStyle = `rgba(246,250,252,${(0.25 + 0.5 * rr()) * a})`;
      x.beginPath(); x.ellipse(arm, t * h, 1 + 3 * rr() * (0.4 + t), 2 + 6 * rr(), 0, 0, 2 * Math.PI); x.fill();
      if (churn && rr() < 0.6) {
        const tc = rr() ** 1.3, ac = (1 - tc) ** 2;
        x.fillStyle = `rgba(240,247,250,${(0.2 + 0.35 * rr()) * ac})`;
        x.beginPath(); x.ellipse(w / 2 + (rr() - 0.5) * w * (0.08 + 0.18 * tc), tc * h, 2 + 5 * rr(), 3 + 8 * rr(), 0, 0, 2 * Math.PI); x.fill();
      }
    }
    return new THREE.CanvasTexture(c);
  };
  const mat = new THREE.MeshBasicMaterial({ map: foam(256, 1024, 0.42, true), transparent: true, depthWrite: false, opacity: 0 });
  const fan = new THREE.Mesh(new THREE.PlaneGeometry(14, 50), mat);
  fan.rotation.x = -Math.PI / 2; fan.position.set(0, 0.05, 1.7 + 25); fan.renderOrder = 1; wakeG.add(fan);
  // the bow wave: the same arms from the stem, peeling off along her sides
  const bmat = new THREE.MeshBasicMaterial({ map: foam(128, 256, 0.46, false), transparent: true, opacity: 0, depthWrite: false });
  const curl = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 5), bmat);
  curl.rotation.x = -Math.PI / 2; curl.position.set(0, 0.06, -4.3 + 2.5); curl.renderOrder = 1; wakeG.add(curl);
  let spd = 0, last = null;
  return (pos, dt) => {   // pos: [x, z] this frame
    wakeG.position.set(pos[0], 0, pos[1]); wakeG.rotation.y = boat.rotation.y;
    if (last && dt > 0) {
      const v = Math.hypot(pos[0] - last[0], pos[1] - last[1]) / dt;
      if (v < 40) spd += (v - spd) * Math.min(1, dt * 1.2);   // a jump (reload, slider) isn't speed
    }
    last = [pos[0], pos[1]];
    const k = Math.min(1, spd / 2.6);   // full at ~5 knots
    mat.opacity = 0.7 * k; bmat.opacity = 0.8 * k;
    fan.scale.y = 0.4 + 0.6 * k; fan.position.z = 1.7 + 25 * fan.scale.y;
    fan.visible = curl.visible = k > 0.02;
  };
})();


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
  sunDirection: sun.clone().normalize(), sunColor: 0xfff4e0, waterColor: 0x3268a0, distortionScale: 1.2, fog: true,
});
water.rotation.x = -Math.PI / 2;
water.material.uniforms.size.value = 6;
// Real water reflects ~2–4% looking straight down (three's default is 30%, which reads as milky
// from a low eye), and a little less sky overall at grazing angles.
water.material.fragmentShader = water.material.fragmentShader
  .replace('float rf0 = 0.3;', 'float rf0 = 0.04;')
  .replace('reflectionSample * 0.9 +', 'reflectionSample * 0.78 +');
water.material.needsUpdate = true;
// keep the boat's own bow out of the water's reflection pass
{ const mirror = water.onBeforeRender; water.onBeforeRender = (...a) => { bow.visible = false; if (angel) angel.group.visible = false; mirror(...a); bow.visible = true; if (angel) angel.group.visible = true; }; }
water.renderOrder = 2;   // after the hull's sea-excluding cap (v903)
scene.add(water);

// Sky: the shared dome (weather3d.js): blue overhead fading to the haze colour at the horizon, sun or moon.
const sky = makeSky(60000);
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
  marks.push({ g, n, fl, lamp, phase: Math.random() * 6, num: (n.n || '').match(/(\S{1,3})$/)?.[1] || '', name: n.n, kind: 'buoy', ch: lt?.ch, sec: lt?.sec, only: lt?.only });
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
  marks.push({ g, n: l, fl, lamp, phase: 0, fixedMark: true, kind: 'light', name: l.ch, title: l.n, ch: l.ch, sec: l.sec, only: l.only });
}

// ── Weather and time of day (v858; shared with the bird's-eye view in weather3d.js since v860) ──
// The conditions (time, visibility, sky, wind) restyle the sky, light, sea and clouds there; this
// view adds the lights: at dusk, at night and in fog every charted light flashes its own rhythm and
// colour as a glow, house windows light up in the towns, the ferries show their windows and running
// lights, and your own boat shows hers (sidelights and stern light under way, an all-round white
// light at the masthead at anchor), each over its proper arc, as at sea, and the boat heels and
// moves with the wind. Chosen from the Weather panel (or N for night); remembered.
const env = makeEnv({ renderer, scene, hemi, dl, sky, water, clouds, starsR: 50000, deckSize: 90000, deckY: 1800, foamR: 1400, foamTile: 24 });
// seagulls over the boat and seals on the ledges nearby (v888, requested; wildlife3d.js)
wildlife = makeWildlife({ scene, ledges: wildlifeLedges || [] });
let lightsK = 0, visM = 26000, WND = env.W;
// running lights on a vessel: a glow at `at` (the parent's local frame, bow toward -z) shown over
// an arc of `arc` degrees each side of `toward` (degrees from ahead, + to starboard); arc 180 = all round
const runLights = [];
function runLight(parent, at, color, toward, arc, when = null, size = 0.014, metres = false) {
  const sp = glowSprite(color, size, metres); sp.position.set(...at); parent.add(sp);
  const a = THREE.MathUtils.degToRad(toward);
  runLights.push({ sp, dir: new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)), cos: Math.cos(THREE.MathUtils.degToRad(arc)), when, size: metres ? 0 : size });
  return sp;
}
// Your own boat's lights are close, so they get more than a glow (v857, direct request): a lit lamp
// (screened outside its arc since v914), a glow a metre and a half across over the lamp's arc, and the pool of
// coloured light each one throws on the water beside the boat, which is what you notice from the
// Drone view astern, where the rules hide the sidelights themselves.
const nightOnly = [];   // shown only at night, each with an optional condition
const POOL = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64; const c = cv.getContext('2d');
  const gr = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.3)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = gr; c.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(cv);
})();
// The lamp is screened like a real one (v914, requested: "screen the sidelights"): outside its arc you see
// only a faint spill from the edge of its board, so from the helm a sidelight doesn't shine back at you.
const screened = [];
function ownLight(at, color, toward, arc, pool, when) {
  runLight(bow, at, color, toward, arc, when, 1.5, true); const glow = runLights[runLights.length - 1];
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
  lamp.position.set(...at); lamp.visible = false; bow.add(lamp); nightOnly.push({ o: lamp, when });
  if (arc < 180) screened.push({ lamp, glow, lit: new THREE.Color(color), dim: new THREE.Color(color).multiplyScalar(0.1) });
  if (pool) {   // [x, z, size]: on the water, in the boat's frame
    const m = new THREE.Mesh(new THREE.PlaneGeometry(pool[2], pool[2]), new THREE.MeshBasicMaterial({ map: POOL, color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(pool[0], 0.12, pool[1]); m.visible = false; m.renderOrder = 2; boat.add(m); nightOnly.push({ o: m, when, pool: true });
  }
}
const SIDE = 112.5 / 2;   // each sidelight shows from dead ahead to 22.5° abaft the beam
const underWay = () => anchor.state === 'up', atAnchor = () => anchor.state !== 'up';
if (ANGEL) {   // Angelique: sidelight boards in the main shrouds, stern light on the taffrail, anchor light in the forestay
  const LT = SHIP.lights;
  ownLight(LT.port, 0xff2a1e, -SIDE, SIDE, [-6, LT.port[2], 12], underWay);
  ownLight(LT.stbd, 0x2bff6a, SIDE, SIDE, [6, LT.stbd[2], 12], underWay);
  ownLight(LT.stern, 0xfff2d6, 180, 67.5, [0, 18, 14], underWay);
  ownLight(LT.anchor, 0xfff2d6, 0, 180, [0, -14, 26], atAnchor);
} else {
ownLight([-0.45, 1.68, -4.75], 0xff2a1e, -SIDE, SIDE, [-2.2, -5, 5], underWay);   // port sidelight, red
ownLight([0.45, 1.68, -4.75], 0x2bff6a, SIDE, SIDE, [2.2, -5, 5], underWay);      // starboard sidelight, green
ownLight([0, 1.56, 2.66], 0xfff2d6, 180, 67.5, [0, 5, 6], underWay);             // stern light
ownLight([0, 10.6, -2.75], 0xfff2d6, 0, 180, [0, -1, 14], atAnchor);               // anchor light at the masthead
}
const litMats = [];   // materials with an emissive glow that comes on with the lights (ferry windows)
let wxPanel = null;
for (const m of marks) if (m.lamp) {   // a glow on every charted light, over its lamp
  m.glowSize = m.kind === 'light' ? 0.03 : 0.02;
  m.glow = glowSprite(m.fl?.col ?? 0xfff6d8, m.glowSize);
  m.range = (m.kind === 'light' ? 9 : 3.5) * NM;
  scene.add(m.glow);
}
function applyConditions(next = {}) {
  env.apply(next);
  ({ lightsK, visM, W: WND } = env);
  for (const n of nightOnly) if (n.pool) n.o.material.opacity = 0.4 * Math.max(0, (lightsK - 0.3) / 0.7);   // pools of light only show once it's dim
  TOWN_NIGHT.value = lightsK;
  if (angel) angel.setNight(lightsK > 0.3);   // lamplight in her deckhouse windows
  for (const m of litMats) m.emissiveIntensity = lightsK;
  const lo = Math.min(1, lightsK * 1.4);
  for (const r of runLights) r.sp.material.opacity = lo;
  if (!lightsK) { for (const r of runLights) r.sp.visible = false; for (const n of nightOnly) n.o.visible = false; for (const m of marks) if (m.glow) m.glow.visible = false; }
  wxPanel?.sync(env.C, WND);
}
const _p = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
function updateLights(pos) {   // after the boat and ferries have moved, before the render
  if (!lightsK) return;
  camera.getWorldPosition(_c);
  const lk = Math.min(1, lightsK * 1.4), carry = visM * 1.6;   // in fog a light shows a little beyond where land does
  // a distant light's glow is the same size on the screen however far you zoom: through the binoculars (7×)
  // it was magnified into a great coloured blob on the shore (v917, reported: "they don't look natural")
  const zk = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.tan(THREE.MathUtils.degToRad(27.5));
  for (const m of marks) {
    if (!m.glow) continue;
    const range = Math.min(m.range, carry), d = Math.hypot(m.g.position.x - pos[0], m.g.position.z - pos[1]), k = Math.min(1, 1.25 - d / range) * lk;
    if (m.sec) {   // a sector light: white, red or green (or dark) by where you see it from (v918)
      const col = sectorColour(m.sec, m.only, m.fl?.col ?? 0xfff6d8, Math.atan2(m.g.position.x - _c.x, -(m.g.position.z - _c.z)) * 180 / Math.PI);
      if (col == null) m.lamp.visible = false; else { m.glow.material.color.setHex(col); m.lamp.material.color.setHex(col); }
    }
    m.glow.visible = m.lamp.visible && k > 0;
    if (m.glow.visible) { m.lamp.getWorldPosition(m.glow.position); m.glow.material.opacity = k; m.glow.scale.setScalar(m.glowSize * zk); }
  }
  for (const n of nightOnly) n.o.visible = !n.when || n.when();
  for (const r of runLights) {
    const par = r.sp.parent;
    if (!par || (r.when && !r.when())) { r.sp.visible = r.inArc = false; continue; }
    r.sp.getWorldPosition(_p); _d.copy(r.dir).transformDirection(par.matrixWorld);
    const tx = _c.x - _p.x, tz = _c.z - _p.z, l = Math.hypot(tx, tz) || 1, dl2 = Math.hypot(_d.x, _d.z) || 1;
    r.inArc = r.cos <= -0.999 || (tx * _d.x + tz * _d.z) / (l * dl2) >= r.cos;
    r.sp.visible = l < carry && r.inArc;
    if (r.size) r.sp.scale.setScalar(r.size * zk);
  }
  for (const k of screened) k.lamp.material.color.copy(k.glow.inArc ? k.lit : k.dim);
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

// ── Waypoints (v872, requested: optionally show them on Virtual Journeys) ──
// The ◆ Waypoints toggle in the View row (and W) shows a numbered marker at each of the route's
// waypoints (green; amber for an overnight stop, red at the end), the route itself as a dashed
// line on the water, and the next waypoint's distance and magnetic bearing. Remembered.
const WP_KEY = 'audiochart-helm3d-waypoints';
let wpOn = FREE ? false : params.get('wpts') ? params.get('wpts') === '1' : (() => { try { return localStorage.getItem(WP_KEY) === 'on'; } catch (_) { return false; } })();
const wpGroup = new THREE.Group(); wpGroup.visible = wpOn; scene.add(wpGroup);
const wps = route.map((w, i) => {
  const night = !!ROUTE.overnight?.[i], last = i === route.length - 1;
  const col = last ? 0xd0342c : night ? 0xe0a843 : 0x2fa35a;
  const g = new THREE.Group(); g.position.set(w[0], 0, w[1]);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6), new THREE.MeshLambertMaterial({ color: 0xf2f2ee })); pole.position.y = 1.6; g.add(pole);
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.55), new THREE.MeshLambertMaterial({ color: col, emissive: col, emissiveIntensity: 0.35 })); gem.position.y = 3.6; gem.scale.y = 1.4; g.add(gem);
  wpGroup.add(g);
  return { g, w, i, night, last, label: `WP ${i + 1}` + (night ? ' ☾' : last ? ' ⚓' : '') };
});
const wpLine = (() => {
  const pts = route.map(([x, z]) => new THREE.Vector3(x, 0.3, z));
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xe0a843, dashSize: 12, gapSize: 8 }));
  l.computeLineDistances(); wpGroup.add(l); return l;
})();
function nextWp(s) { for (let i = 1; i < cum.length; i++) if (cum[i] > s + 5) return wps[i]; return null; }
function updateWaypoints(pos) {
  if (!wpOn) return;
  for (const p of wps) {   // drawn bigger with distance, like the buoys, so they read from afar
    const d = Math.hypot(p.w[0] - pos[0], p.w[1] - pos[1]);
    p.g.scale.setScalar(Math.max(1, Math.min(14, d / 120)));
  }
}

// ── Fox Islands ferries (v846): when the route passes near the Rockland–Vinalhaven or Rockland–
// North Haven ferry line (data/ferries.json, from OpenStreetMap), a ferry is staged to come by:
// across your bow about 400 m ahead if you cross its line, or meeting you port to port if you run
// along it. Where it is depends only on how far you have sailed (S), at its own speed against the
// boat's speed (BOAT_KN), so it keeps its place with Play, the slider and a Virtual Journey alike. Before its
// time it waits at its terminal; after, it lies at the other one. Near the meeting its path is
// eased off the charted line toward you (so it passes close enough to see from the Drone view),
// back onto the line within a couple of kilometres either way, so it still leaves and reaches
// its terminals on the real track.
const ferries = [];
function ferryModel(F) {   // a Maine State Ferry Service car ferry: bow toward -z, waterline at y = 0
  // The fleet's look (MSFS photos): red hull with a black boot-top at the waterline, high white sides
  // round the car deck, a white passenger house with a row of windows, and a white pilothouse with
  // dark glass up top under a radar mast. Length from data/ferries.json (Thompson 154 ft, Burgess 130 ft).
  const L = F.length_m || 46, B = Math.min(12.2, L * 0.26), g = new THREE.Group();
  const white = mat(0xf3f2ee), red = mat(0xc83a2e), black = mat(0x1d1f22), deckM = mat(0x6f7378), glass = mat(0x1e2a33);
  const half = L / 2, taper = L * 0.16;
  const outline = [[-B / 2, half], [B / 2, half], [B / 2, -half + taper], [B * 0.27, -half], [-B * 0.27, -half], [-B / 2, -half + taper]];
  const slab = (y0, y1, m, sc = 1) => {   // a horizontal slice of the hull outline
    const sh = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x * sc, -z * sc)));
    const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: y1 - y0, bevelEnabled: false }), m);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = y0; g.add(mesh); return mesh;
  };
  slab(-1.1, 0.25, black, 0.995);   // boot-top
  slab(0.25, 2.2, red);             // red hull
  slab(2.2, 2.4, deckM, 0.985);     // car deck
  // windows: one canvas texture, repeated along the white houses' sides
  const winTex = (() => {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 32; const c = cv.getContext('2d');
    c.fillStyle = '#f3f2ee'; c.fillRect(0, 0, 128, 32); c.fillStyle = '#26323b';
    for (let x = 8; x < 128; x += 32) c.fillRect(x, 9, 20, 13);
    const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const winLit = (() => {   // the same windows lit, for the emissive glow at night
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 32; const c = cv.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, 128, 32); c.fillStyle = '#fff';
    for (let x = 8; x < 128; x += 32) c.fillRect(x, 9, 20, 13);
    const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const house = (w, h, len, x, y, z, windows) => {
    const rep = t => { t = t.clone(); t.needsUpdate = true; t.repeat.set(Math.max(1, Math.round(len / 4)), 1); return t; };
    const sideMat = windows ? new THREE.MeshLambertMaterial({ map: rep(winTex), emissive: 0xffd9a0, emissiveMap: rep(winLit), emissiveIntensity: lightsK }) : white;
    if (windows) litMats.push(sideMat);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, len), [sideMat, sideMat, white, white, white, white]);
    m.position.set(x, y + h / 2, z); g.add(m); return m;
  };
  // high white sides round the car deck (open at the stern for the ramp), and a white forecastle
  const sideLen = L - taper - 2;
  for (const sx of [-1, 1]) house(0.35, 2.2, sideLen, sx * (B / 2 - 0.18), 2.2, half - 1 - sideLen / 2, false);
  slab(2.2, 4.4, white, 1.0).scale.set(1, 1, 1);   // full-height white skin at the bow…
  const fore = g.children[g.children.length - 1];
  fore.geometry.dispose();
  { const sh = new THREE.Shape([[-B / 2, half - L + taper + 2], [B / 2, half - L + taper + 2], [B / 2, -half + taper], [B * 0.27, -half], [-B * 0.27, -half], [-B / 2, -half + taper]].map(([x, z]) => new THREE.Vector2(x, -z)));
    fore.geometry = new THREE.ExtrudeGeometry(sh, { depth: 2.2, bevelEnabled: false }); }   // …only over the forecastle
  // passenger house along the starboard side, with windows; the pilothouse spans the beam above it
  const hz = -L * 0.06, hLen = L * 0.42;
  house(4.2, 2.6, hLen, B / 2 - 2.3, 4.4, hz, true);
  house(B - 0.4, 0.25, L * 0.2, 0, 7.0, -L * 0.18, false);                // bridge deck over the car deck
  const ph = house(B * 0.5, 2.3, 5.2, B * 0.18, 7.25, -L * 0.18, false);   // pilothouse
  const band = new THREE.Mesh(new THREE.BoxGeometry(B * 0.5 + 0.06, 0.9, 5.26), glass); band.position.set(ph.position.x, 8.75, ph.position.z); g.add(band);
  // radar mast, horn, two small exhaust stacks
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 3.2, 8), white); mast.position.set(ph.position.x, 11.2, ph.position.z + 1); g.add(mast);
  const radar = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.18, 0.3), black); radar.position.set(ph.position.x, 12.6, ph.position.z + 1); g.add(radar);
  // running lights: masthead, sidelights on the bridge wings, stern light
  runLight(g, [ph.position.x, 12.9, ph.position.z + 1], 0xfff2d6, 0, 112.5, null, 0.018);
  runLight(g, [-(B / 2 - 0.3), 7.6, -L * 0.18], 0xff3b2e, -SIDE, SIDE, null, 0.018);
  runLight(g, [B / 2 - 0.3, 7.6, -L * 0.18], 0x3dff7a, SIDE, SIDE, null, 0.018);
  runLight(g, [0, 4.8, half], 0xfff2d6, 180, 67.5, null, 0.018);
  for (const dz of [-0.5, 0.5]) { const st = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 2.6, 10), black); st.position.set(B / 2 - 2.3 + dz * 1.2, 8.1, hz + hLen * 0.35); g.add(st); }
  // her name on both sides, forward
  if (F.vessel) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 64; const c = cv.getContext('2d');
    c.fillStyle = '#f3f2ee'; c.fillRect(0, 0, 512, 64); c.fillStyle = '#1d2328'; c.font = 'bold 34px Helvetica, Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(F.vessel, 256, 34);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    for (const sx of [-1, 1]) {
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.1), new THREE.MeshLambertMaterial({ map: t }));
      plate.position.set(sx * (B / 2 + 0.02), 3.4, -L * 0.22); plate.rotation.y = sx * Math.PI / 2; g.add(plate);
    }
  }
  // vehicles on the open deck (port side and the stern, where the house doesn't cover them)
  const carCols = [0xb8bcc0, 0x8c1f1f, 0x23415f, 0xe8e6e0, 0x2f2f2f, 0x5b6b4a, 0xa88f5c];
  let k = 0;
  for (let z = -L * 0.3; z < half - 4; z += 5) for (const x of [-B / 2 + 1.6, -B / 2 + 4.0]) {
    if ((k * 7 + 3) % 5 === 0) { k++; continue; }
    const car = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 4.4), mat(carCols[k++ % carCols.length])); car.position.set(x, 3.1, z); g.add(car);
  }
  const truck = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3.2, 9), mat(0xd9d6cf)); truck.position.set(0.6, 4.0, half - 7); g.add(truck);
  // stern ramp, raised
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(B * 0.55, 0.3, 4), deckM); ramp.position.set(0, 3.6, half + 0.4); ramp.rotation.x = -1.1; g.add(ramp);
  // wake: a fading white fan astern, and a little bow wave
  const wc = document.createElement('canvas'); wc.width = 64; wc.height = 256;
  const wx2 = wc.getContext('2d'), grd = wx2.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, 'rgba(245,250,252,0.85)'); grd.addColorStop(1, 'rgba(245,250,252,0)');
  wx2.fillStyle = grd; wx2.beginPath(); wx2.moveTo(22, 0); wx2.lineTo(42, 0); wx2.lineTo(64, 256); wx2.lineTo(0, 256); wx2.closePath(); wx2.fill();
  const wake = new THREE.Mesh(new THREE.PlaneGeometry(B * 2.8, 150), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(wc), transparent: true, depthWrite: false }));
  wake.rotation.x = -Math.PI / 2; wake.position.set(0, 0.06, half + 75); g.add(wake);
  const bowWave = new THREE.Mesh(new THREE.RingGeometry(B * 0.5, B * 0.75, 24, 1, Math.PI * 0.15, Math.PI * 0.7), new THREE.MeshBasicMaterial({ color: 0xf2f7f9, transparent: true, opacity: 0.55, depthWrite: false }));
  bowWave.rotation.x = -Math.PI / 2; bowWave.position.set(0, 0.07, -half + 6); g.add(bowWave);
  g.userData.wake = [wake, bowWave];
  return g;
}
function ferryAt(fy, f) {   // point on the line f metres from Rockland, and the smoothed direction there
  const pt = d => {
    d = Math.max(0, Math.min(fy.L, d));
    let i = 1; while (i < fy.fc.length - 1 && fy.fc[i] < d) i++;
    const t = (d - fy.fc[i - 1]) / ((fy.fc[i] - fy.fc[i - 1]) || 1);
    return [fy.P[i - 1][0] + t * (fy.P[i][0] - fy.P[i - 1][0]), fy.P[i - 1][1] + t * (fy.P[i][1] - fy.P[i - 1][1])];
  };
  const [x, z] = pt(f), a = pt(f - 90), b = pt(f + 90), l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return { x, z, tx: (b[0] - a[0]) / l, tz: (b[1] - a[1]) / l };
}
function setupFerries(data) {
  for (const F of data.ferries || []) {
    const P = F.line.map(([lo, la]) => [wx(lo), wz(la)]), fc = [0];
    for (let i = 1; i < P.length; i++) fc.push(fc[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const fy = { F, P, fc, L: fc[fc.length - 1] };
    const nearest = (x, z) => {   // distance to the line and how far along it
      let best = { d: Infinity, f: 0 };
      for (let i = 1; i < P.length; i++) {
        const [ax, az] = P[i - 1], [bx, bz] = P[i], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
        const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)) : 0;
        const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
        if (d < best.d) best = { d, f: fc[i - 1] + t * Math.sqrt(L2) };
      }
      return best;
    };
    const samples = [];
    for (let s = 0; s <= TOTAL; s += 50) { const [x, z] = posAt(s); samples.push({ s, x, z, ...nearest(x, z) }); }
    const dmin = Math.min(...samples.map(o => o.d));
    if (!(dmin <= 1.5 * NM)) continue;   // never within sight of this ferry's line
    // where to meet: of the stretch within 1 nm of the line, the place nearest mid-route, clear of both ends
    let cands = samples.filter(o => o.d <= Math.max(NM, dmin + 50) && o.s > 800 && o.s < TOTAL - 800);
    if (!cands.length) cands = samples.filter(o => o.d <= dmin + 1);
    const c = cands.reduce((a, b) => Math.abs(b.s - TOTAL / 2) < Math.abs(a.s - TOTAL / 2) ? b : a);
    const [ax, az] = posAt(c.s - 60), [bx, bz] = posAt(c.s + 60), bl = Math.hypot(bx - ax, bz - az) || 1, ux = (bx - ax) / bl, uz = (bz - az) / bl;
    const T0 = ferryAt(fy, c.f), along = ux * T0.tx + uz * T0.tz;   // +1: the boat heads the way the line runs (out from Rockland)
    const portX = uz, portZ = -ux;   // the boat's port side there
    fy.k = F.knots / BOAT_KN; fy.f0 = c.f; fy.off = [0, 0];
    if (Math.abs(along) > 0.8) {   // running along it: meet head-on, passing port to port at least 200 m off
      fy.dir = along > 0 ? -1 : 1; fy.sCross = c.s;
      fy.off = [c.x - T0.x + portX * 220, c.z - T0.z + portZ * 220];   // through the spot 220 m off your port side
    } else {   // crossing it: the ferry crosses your course ~400 m ahead
      fy.dir = (Math.round(c.s / 50) % 2) ? 1 : -1; fy.sCross = c.s - 400;
      fy.off = [c.x - T0.x, c.z - T0.z];   // through your track, not up to a mile off it
    }
    fy.label = `Ferry to ${fy.dir > 0 ? F.to : F.from}`;   // (she is F.vessel; the label says where she's bound)
    fy.group = ferryModel(F); scene.add(fy.group);
    ferries.push(fy);
    console.log(`[helm3d] ${F.name} ferry: ${along > 0.8 || along < -0.8 ? 'meets' : 'crosses'} the route ${(c.s / NM).toFixed(1)} nm in, ${(c.d / NM).toFixed(2)} nm from its line`);
  }
}
if (!FREE) getJSON('./data/ferries.json').then(setupFerries).catch(err => console.warn('[helm3d] ferries', err));
function ferryPos(fy, f) {   // on the line, eased toward the meeting point near f0
  const p = ferryAt(fy, f), w = Math.exp(-(((f - fy.f0) / 2200) ** 2));
  return [p.x + fy.off[0] * w, p.z + fy.off[1] * w];
}
function updateFerries(t) {
  for (const fy of ferries) {
    const raw = fy.f0 + fy.dir * fy.k * (S - fy.sCross), f = Math.max(0, Math.min(fy.L, raw)), under = raw > 0 && raw < fy.L;
    const [x, z] = ferryPos(fy, f), a = ferryPos(fy, f - 60 * fy.dir), b = ferryPos(fy, f + 60 * fy.dir);
    fy.group.position.set(x, Math.sin(t * 0.5 + fy.L) * 0.08, z);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1) fy.group.rotation.y = -Math.atan2(b[0] - a[0], -(b[1] - a[1]));
    for (const w of fy.group.userData.wake) w.visible = under;
  }
}

let lastCourse = null;
let S = (Number(params.get('start')) || 0.05) * NM, playing = false, yawOff = 0, pitch = -1.2, zoom = 1, smoothCourse = null;
const posEl = document.getElementById('pos'); posEl.max = (TOTAL / NM).toFixed(3); posEl.value = (S / NM).toFixed(3);
const playBtn = document.getElementById('play'), speedEl = document.getElementById('speed');
{   // Pace: your boat's speed, from real time up to 200 times as fast; the choice is remembered (v862)
  const kn = String(Math.round(BOAT_KN * 10) / 10);
  speedEl.innerHTML = [[1, 'real time'], [5, '× 5'], [20, '× 20'], [60, '× 60'], [200, '× 200']].map(([v, t]) => `<option value="${v}">${kn} kn ${t}</option>`).join('');
  let pace = '60'; try { pace = localStorage.getItem('audiochart-helm3d-pace') || pace; } catch (_) {}
  speedEl.value = [...speedEl.options].some(o => o.value === pace) ? pace : '60';
  speedEl.addEventListener('change', () => { try { localStorage.setItem('audiochart-helm3d-pace', speedEl.value); } catch (_) {} });
}
const setPlaying = on => { playing = on; playBtn.innerHTML = on ? '&#10074;&#10074; Pause' : '&#9654; Play'; if (on && S >= TOTAL - 1) S = 0; };
if (params.get('pace') && [...speedEl.options].some(o => o.value === params.get('pace'))) speedEl.value = params.get('pace');   // back from Bird's-eye (v875)
playBtn.addEventListener('click', () => setPlaying(!playing));
posEl.addEventListener('input', () => { S = Number(posEl.value) * NM; smoothCourse = null; });
document.getElementById('reset').addEventListener('click', () => { if (binoc.on) setBinoc(false); yawOff = 0; pitch = -1.2; zoom = 1; });
addEventListener('keydown', e => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); setPlaying(!playing); } });
if (params.get('play') === '1') setPlaying(true);   // still sailing, back from Bird's-eye (v875)
let drag = null;
sceneEl.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, yaw: yawOff, pitch }; sceneEl.setPointerCapture(e.pointerId); sceneEl.classList.add('dragging'); });
sceneEl.addEventListener('pointermove', e => {
  if (!drag) return;
  const k = camera.fov / sceneEl.clientHeight;
  yawOff = drag.yaw - (e.clientX - drag.x) * k; pitch = Math.max(-30, Math.min(30, drag.pitch + (e.clientY - drag.y) * k));
});
const endDrag = () => { drag = null; sceneEl.classList.remove('dragging'); };
sceneEl.addEventListener('pointerup', endDrag); sceneEl.addEventListener('pointercancel', endDrag);
sceneEl.addEventListener('wheel', e => { e.preventDefault(); if (binoc.on) return; zoom = Math.max(1, Math.min(8, zoom * Math.exp(-e.deltaY * 0.0015))); }, { passive: false });

// Labels: projected each frame; hidden when terrain on that sight line is in the way.
const labelsEl = document.getElementById('labels'), showLbl = document.getElementById('showlbl');
const labelPool = [];
function sightClear(from, to, toH) {
  const dx = to[0] - from[0], dz = to[1] - from[1], d = Math.hypot(dx, dz);
  for (let t = 40; t < d - 60; t += Math.max(15, t * 0.02)) {
    const x = from[0] + dx * t / d, z = from[1] + dz * t / d;
    const e0 = nest.on ? _camW.y : eyeH, hT = heightAt(x / MX + LON0, -z / MY + LAT0), los = e0 + (toH - e0) * t / d;
    if (hT > los) return false;
  }
  return true;
}
const placeLabels = places.filter(p => p.t !== 'LIGHTS').map(p => ({ ...p, w: [wx(p.x), wz(p.y)], h: Math.max(4, p.elev ?? heightAt(p.x, p.y)) }));
let lblFrame = 0, lblCache = [];
function updateLabels(pos) {
  if (!showLbl.checked) { labelsEl.hidden = true; return; } labelsEl.hidden = false;
  if (lblFrame++ % 8 === 0) {   // sight-line checks are the costly part; refresh a few times a second
    const cand = [];
    for (const p of placeLabels) {
      const d = Math.hypot(p.w[0] - pos[0], p.w[1] - pos[1]); if (d > Math.min((p.t === 'SUMMIT' ? 10 : 5) * NM, visM * 1.2) || d < 60) continue;
      cand.push({ text: p.n, v: new THREE.Vector3(p.w[0], p.h + 8, p.w[1]), d: p.t === 'SUMMIT' ? d * 0.4 : d, cls: '', w: p.w, h: p.h });   // summits win a place among the labels
    }
    for (const m of marks) {
      if (m.kind !== 'buoy' || !m.num) continue;
      const d = Math.hypot(m.g.position.x - pos[0], m.g.position.z - pos[1]); if (d > Math.min(1.3 * NM, visM * 1.2)) continue;
      cand.push({ text: `"${m.num}"`, v: new THREE.Vector3(m.g.position.x, 5.5, m.g.position.z), d, cls: 'buoy', w: [m.g.position.x, m.g.position.z], h: 3 });
    }
    if (wpOn) {
      const nx = nextWp(S);
      for (const p of wps) {
        const d = Math.hypot(p.w[0] - pos[0], p.w[1] - pos[1]); if (d > Math.min(4 * NM, visM * 1.2) || d < 15) continue;
        const k = p.g.scale.x, text = p === nx ? `${p.label} · ${(d / NM).toFixed(2)} nm` : p.label;
        cand.push({ text, v: new THREE.Vector3(p.w[0], 4.6 * k, p.w[1]), d: p === nx ? 0 : d * 0.6, cls: 'wpt' + (p === nx ? ' next' : ''), w: p.w, h: 4 * k });
      }
    }
    for (const fy of ferries) {
      const fp = fy.group.position, d = Math.hypot(fp.x - pos[0], fp.z - pos[1]); if (d > Math.min(3 * NM, visM * 1.2)) continue;
      cand.push({ text: fy.label, v: new THREE.Vector3(fp.x, 12, fp.z), d: d * 0.5, cls: '', w: [fp.x, fp.z], h: 8 });
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
const ROLLER = ANGEL ? new THREE.Vector3(...SHIP.roller) : new THREE.Vector3(0, 1.12, -5.25);   // stem-head roller, boat frame
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
const EYE_CHOICES = [{ label: 'Helm', m: EYE, title: ANGEL ? 'On deck, at the wheel' : 'Deck level, at the tiller' }, { label: '20 ft', m: 20 * 0.3048 }, { label: '60 ft', m: 60 * 0.3048 }, { label: 'Drone', m: DRONE_M }];
const FT60 = 60 * 0.3048, _back = m => Math.max(0, (m - EYE) * 2.2), _tilt = m => Math.max(0, (m - EYE) * 2.4) / (1 + Math.max(0, m - EYE) / 18);
const _toDrone = m => Math.min(1, Math.max(0, (m - FT60) / (DRONE_M - FT60)));   // 60 ft -> drone, so the change glides
const DRONE_BACK = ANGEL ? SHIP.droneBack : 50;   // she's 130 ft overall: the Drone stands farther off to see all of her
const eyeBack = m => m <= FT60 ? _back(m) : _back(FT60) + (DRONE_BACK - _back(FT60)) * _toDrone(m);
const eyeTilt = m => m <= FT60 ? _tilt(m) : _tilt(FT60) + (20 - _tilt(FT60)) * _toDrone(m);
let eyeTarget = DRONE_M;   // Drone by default (direct request, v832); a choice made since is remembered
{
  let want = Number(params.get('eye')) * 0.3048;   // feet in the URL; metres stored
  if (!want) { try { want = Number(localStorage.getItem('audiochart-helm3d-view')); } catch (_) {} }
  if (want > 0) eyeTarget = Math.max(EYE, want);   // a Cape Dory helm height remembered would put you below Angelique's deck
}
let eyeH = eyeTarget;
const eyeBox = document.getElementById('eyepick');
function syncEyeButtons() { for (const b of eyeBox.querySelectorAll('button[data-m]')) b.classList.toggle('on', !nest.on && Math.abs(Number(b.dataset.m) - eyeTarget) < 0.2); }
// Bowdoin's crow's nest (v919, requested: "give it a Crow's Nest, and a way to trigger an observation from there"):
// a viewpoint in her ice barrel at the foremast head, 60-odd feet up, riding with her heel and roll; look round as
// at the helm, raise the binoculars from up there, and 📣 Lookout calls out what's in sight (below).
const nest = { on: false, k: 0 };
const binoc = { on: false, prevEye: 0, prevZoom: 1, range: null, rangeT: 0, sx: 0 };   // binoculars (v908), below
function setEye(m) { if (binoc.on) setBinoc(false); if (nest.on) setNest(false); eyeTarget = m; try { localStorage.setItem('audiochart-helm3d-view', String(m)); } catch (_) {} syncEyeButtons(); }
// double-click the boat (v896, requested): AudioChart's boat menu (Free sail, Autoroute, …)
{
  let hook = null; try { if (window.parent !== window) hook = window.parent.__audioChartViews; } catch (_) {}
  if (hook?.boatMenu) {
    const rc = new THREE.Raycaster(), v = new THREE.Vector2();
    // on the page, not the canvas: a press captures the pointer to the scene's container, so the
    // dblclick and pointerup land there (v898); controls are left alone
    const onScene = e => !e.target.closest?.('button, input, select, textarea, a, label, .panel, #wxpanel');
    addEventListener('pointerdown', () => hook.hideBoatMenu());
    const tryMenu = (x, y) => {
      const r = renderer.domElement.getBoundingClientRect();
      v.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
      rc.setFromCamera(v, camera);
      if (rc.intersectObject(boat, true).length) hook.boatMenu(window, x, y);
    };
    addEventListener('dblclick', e => { if (onScene(e)) tryMenu(e.clientX, e.clientY); });
    // a phone's double-tap (v897): two quick touch taps close together; browsers don't reliably
    // turn those into dblclick (iOS never does here), the same reason the chart detects its own
    let downX = 0, downY = 0, lastUp = 0, lastX = 0, lastY = 0;
    addEventListener('pointerdown', e => { downX = e.clientX; downY = e.clientY; });
    addEventListener('pointerup', e => {
      if (e.pointerType !== 'touch' || !onScene(e)) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 10) { lastUp = 0; return; }   // a drag, not a tap
      const now = Date.now();
      if (now - lastUp < 400 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 30) { lastUp = 0; tryMenu(e.clientX, e.clientY); }
      else { lastUp = now; lastX = e.clientX; lastY = e.clientY; }
    });
  }
}
// "🗺 Chart" (v895, requested: pass between all the views): inside AudioChart, back to the 2D chart
{
  let hook = null; try { if (window.parent !== window) hook = window.parent.__audioChartViews; } catch (_) {}
  if (hook) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = '🗺 Chart'; b.className = 'birdbtn';
    b.title = 'Back to the chart'; b.addEventListener('pointerdown', e => e.stopPropagation());
    b.addEventListener('click', () => hook.chart()); eyeBox.appendChild(b);
  }
}
for (const c of EYE_CHOICES) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = c.label; b.dataset.m = c.m; if (c.title) b.title = c.title;
  b.addEventListener('pointerdown', e => e.stopPropagation());   // not a look-around drag
  b.addEventListener('click', () => setEye(c.m)); eyeBox.appendChild(b);
}
const nestBtn = SHIP.crowsNest && ANGEL ? document.createElement('button') : null;
const lookBtn = document.createElement('button'); lookBtn.type = 'button'; lookBtn.className = 'binbtn'; lookBtn.textContent = '📣 Lookout'; lookBtn.hidden = true;
lookBtn.title = "The lookout's report: what's in sight from the crow's nest, with bearings off the bow (L)";
function setNest(on) {
  if (!nestBtn || on === nest.on) return;
  nest.on = on; nestBtn.classList.toggle('on', on); lookBtn.hidden = !on;
  if (on) { if (binoc.on) setBinoc(false); eyeTarget = EYE; pitch = Math.max(pitch, -8); }   // from the deck's height up the rigging (no orbit)
  else { lookRep.hidden = true; }
  syncEyeButtons();
}
if (nestBtn) {
  nestBtn.type = 'button'; nestBtn.textContent = "🔭 Crow's nest"; nestBtn.title = 'Up the foremast to the ice barrel at its head: the lookout\'s view, 60 ft up';
  nestBtn.addEventListener('pointerdown', e => e.stopPropagation());
  nestBtn.addEventListener('click', () => setNest(!nest.on)); eyeBox.appendChild(nestBtn);
  lookBtn.addEventListener('pointerdown', e => e.stopPropagation());
  lookBtn.addEventListener('click', () => lookoutReport()); eyeBox.appendChild(lookBtn);
}
syncEyeButtons();
// Binoculars (v908, requested: "a spyglass, or binoculars … stop the boat, and then point the
// binoculars towards the shore, and scan, for details"): 7× glasses raised at the helm. Two round
// eyepieces, black round them; a compass reticle along the bottom like a pair of marine 7×50s; a
// range to the land under the cross-hair, with the nearest named place; a little shake from your
// hands and the boat. Drag (or the arrow keys) to scan; terrain in the direction you're looking is
// loaded in full detail out to ~9 km so a distant shore is sharp. B toggles, Esc lowers them.
const BINO_ZOOM = 7, BINO_M = 9000;
// Raising the glasses to look out over either side, you step to the rail on that side (v918): from the wheel
// the deckhouse, the bulwark and the mizzen were most of what 7× showed off the bow.
const RAIL = ANGEL ? SHIP.rail : [0.85, EYE, HELM_Z];
const binBtn = document.createElement('button'); binBtn.type = 'button'; binBtn.className = 'binbtn'; binBtn.textContent = 'Binoculars';
binBtn.title = '7× binoculars from the helm: drag or use the arrow keys to scan the shore (B; Esc to lower them)';
binBtn.addEventListener('pointerdown', e => e.stopPropagation());
binBtn.addEventListener('click', () => setBinoc(!binoc.on));
eyeBox.appendChild(binBtn);
// made here if the page is an older cached copy without it (its new script with an old page would otherwise fail)
const binCv = document.getElementById('binoc') || (() => { const c = document.createElement('canvas'); c.id = 'binoc'; c.hidden = true; document.getElementById('labels').after(c); return c; })();
Object.assign(binCv.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '1' });
const binCtx = binCv.getContext('2d');
function setBinoc(on) {
  if (on === binoc.on) return;
  binoc.on = on; binoc.mark = null; binBtn.classList.toggle('on', on); binBtn.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('binoc', on); binCv.hidden = !on;
  if (on) { binoc.prevEye = eyeTarget; binoc.prevZoom = zoom; eyeTarget = EYE; eyeH = EYE; zoom = BINO_ZOOM; if (pitch < -6) pitch = -0.6; }
  else { eyeTarget = binoc.prevEye; zoom = binoc.prevZoom; }
  syncEyeButtons(); lastTileCheck = -1;
}
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'b' || e.key === 'B') { setBinoc(!binoc.on); return; }
  if (!binoc.on) return;
  const step = camera.fov / 5;
  if (e.key === 'Escape') setBinoc(false);
  else if (e.key === 'ArrowLeft') yawOff -= step; else if (e.key === 'ArrowRight') yawOff += step;
  else if (e.key === 'ArrowUp') pitch = Math.min(30, pitch + step / 2); else if (e.key === 'ArrowDown') pitch = Math.max(-30, pitch - step / 2);
  else return;
  e.preventDefault();
});
// the range to whatever land the cross-hair is on: march out along the sight line over the terrain
function binocRange(bearing, pitchDeg, eyeY) {
  const b = THREE.MathUtils.degToRad(bearing), tp = Math.tan(THREE.MathUtils.degToRad(pitchDeg)), ox = boat.position.x, oz = boat.position.z;
  let wet = false;
  for (let t = 25; t < 20000; t += Math.max(8, t * 0.008)) {
    let y = eyeY + tp * t - t * t / (2 * 6.4e6 / 0.87);   // earth's curve less refraction
    if (y < 0) wet = true;                                   // the sight line has met the water…
    if (wet) y = 0.5;                                         // …keep looking along the bearing for the shore beyond
    const x = ox + Math.sin(b) * t, z = oz - Math.cos(b) * t;
    if (heightAt(x / MX + LON0, -z / MY + LAT0) > y) {
      if (wet && Math.abs(Math.atan(eyeY / t) + Math.atan(tp)) > THREE.MathUtils.degToRad(0.4)) return null;   // that shore is well above the cross-hair: you're looking at water
      let name = null, best = 1500;
      for (const p of placeLabels) { const d = Math.hypot(p.w[0] - x, p.w[1] - z); if (d < best) { best = d; name = p.n; } }
      return { d: t, name };
    }
  }
  return null;
}
// The charted light under the cross-hair (v917, requested: "have the binoculars name the light"): of
// the lit marks in range and not behind land (by day, v918, any buoy or daybeacon), the one nearest the centre of the glasses, within a
// small circle round it. Named with its number or name, its characteristic and its range.
const _lp = new THREE.Vector3();
function binocMark() {
  camera.getWorldPosition(_c);
  let best = null;
  const night = lightsK > 0.3;
  for (const m of marks) {
    if (!m.lamp && night) continue;   // at night only what's lit; by day buoys and daybeacons too (v918)
    if (m.lamp) m.lamp.getWorldPosition(_lp); else { m.g.getWorldPosition(_lp); _lp.y += 2 * m.g.scale.y; }
    const d = Math.hypot(_lp.x - _c.x, _lp.z - _c.z);
    if (d < 30 || d > (m.kind === 'light' ? 9 : 3.5) * NM) continue;
    const q = _lp.clone().project(camera);
    if (q.z > 1) continue;
    const off = Math.hypot(q.x * camera.aspect, q.y);   // from the centre, in half-heights of the view
    if (off > (m === binoc.mark?.m ? 0.26 : 0.18) || (best && off >= best.off)) continue;   // (easier to stay on than to get on)
    // hidden behind land? look along the line for terrain above it
    let hid = false;
    for (let k = 0.05; k < 0.97 && !hid; k += 0.03) {
      const x = _c.x + (_lp.x - _c.x) * k, z = _c.z + (_lp.z - _c.z) * k, y = _c.y + (_lp.y - _c.y) * k;
      if (heightAt(x / MX + LON0, -z / MY + LAT0) > y + 1) hid = true;
    }
    if (!hid) best = { m, off, d };
  }
  return best;
}
const markText = ({ m, d }) => {
  let what = m.kind === 'light' ? m.title : m.name;
  if (!what) {   // an unnamed light: by the nearest named place
    let best = 2500, near = null; const x = m.g.position.x, z = m.g.position.z;
    for (const p of placeLabels) { const dd = Math.hypot(p.w[0] - x, p.w[1] - z); if (dd < best) { best = dd; near = p.n; } }
    what = near ? `Light by ${near}` : 'Light';
  }
  let look = m.ch || [m.n.c, m.kind === 'buoy' && m.n.s !== 'stake/pole' ? m.n.s : m.n.t === 'BCNLAT' ? 'daybeacon' : null].filter(Boolean).join(' ');
  if (m.sec && m.ch) {   // which of its sectors you're in (v918): "F W, red sector"
    camera.getWorldPosition(_c);
    const sc = sectorColour(m.sec, m.only, null, Math.atan2(m.g.position.x - _c.x, -(m.g.position.z - _c.z)) * 180 / Math.PI);
    const nm = { 0xfff6d8: 'white', 0xff4b3a: 'red', 0x5dff8a: 'green', 0xffd75a: 'yellow' }[sc];
    if (nm) look += `, ${nm} sector`;
  }
  return `${what}${look ? ' · ' + look : ''} · ${d < 926 ? Math.round(d / 0.9144 / 10) * 10 + ' yd' : (d / NM).toFixed(d < 9260 ? 2 : 1) + ' nm'}`;
};
// 📣 The lookout's report from the crow's nest (v919): lighthouses, towns and harbours, summits and the ferries in
// sight from up there (not over the horizon, not behind land), each with its bearing off the bow in a lookout's
// words and its distance, nearest first in each kind ("Owls Head Light, broad on the port bow, 6.2 nm").
// Shown over the view and spoken in AudioChart's voice. L, or the 📣 Lookout button.
const lookRep = document.createElement('div'); lookRep.id = 'lookrep'; lookRep.hidden = true;
lookRep.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);top:150px;z-index:6;max-width:min(560px,calc(100% - 32px));box-sizing:border-box;background:rgba(18,31,38,0.78);color:#eef2f1;border-radius:6px;padding:8px 12px;font:13px/1.45 system-ui,sans-serif;pointer-events:auto';
sceneEl.appendChild(lookRep);
lookRep.addEventListener('pointerdown', e => e.stopPropagation());
lookRep.addEventListener('click', () => { lookRep.hidden = true; });
const REL = rel => {
  const a = Math.abs(rel), side = rel > 0 ? 'starboard' : 'port';
  return a < 6 ? 'dead ahead' : a < 30 ? `fine on the ${side} bow` : a < 60 ? `on the ${side} bow` : a < 82 ? `broad on the ${side} bow` : a < 98 ? `abeam to ${side}` : a < 150 ? `abaft the ${side} beam` : a < 174 ? `on the ${side} quarter` : 'dead astern';
};
function lookoutReport() {
  const eye = _camW.y, pos = [boat.position.x, boat.position.z], hdg = smoothCourse ?? 0, seen = [];
  const add = (name, w, h, rank) => {
    const d = Math.hypot(w[0] - pos[0], w[1] - pos[1]);
    if (d < 150 || d / NM > 2.08 * (Math.sqrt(Math.max(1, eye)) + Math.sqrt(Math.max(1, h))) || d > visM * 1.1 || !sightClear(pos, w, h)) return;
    seen.push({ name, d, rank, rel: ((Math.atan2(w[0] - pos[0], -(w[1] - pos[1])) * 180 / Math.PI - hdg + 540) % 360) - 180 });
  };
  for (const m of marks) if (m.kind === 'light' && m.title && /Light/.test(m.title)) add(m.title, [m.g.position.x, m.g.position.z], m.g.position.y + 10, 0);
  for (const p of placeLabels) {   // towns and harbours, summits, islands (not every named ledge and cove)
    const rank = p.elev ? 2 : p.t === 'BUAARE' ? 1 : /\b(Island|Isle|Islands)\b/.test(p.n) ? 4 : -1;
    if (rank >= 0) add(p.n, p.w, p.elev ? p.h : p.h + 8, rank);
  }
  for (const fy of ferries) { const fp = fy.group.position; add(fy.label.replace(/^Ferry/, 'The ferry'), [fp.x, fp.z], 10, 3); }
  const pick = (rank, n) => seen.filter(o => o.rank === rank).sort((a, b) => a.d - b.d).slice(0, n);
  const list = [...pick(3, 2), ...pick(0, 3), ...pick(1, 3), ...pick(4, 2), ...pick(2, 2)];
  const dist = d => d < 926 ? `${Math.round(d / 0.9144 / 10) * 10} yards` : `${(d / NM).toFixed(1)} nm`;
  const lines = list.map(o => `${o.name}, ${REL(o.rel)}, ${dist(o.d)}`);
  const head = visM < 2000 ? 'Fog all round; nothing in sight.' : lines.length ? `From the crow's nest, ${Math.round(eye / 0.3048)} ft up (horizon ${(2.08 * Math.sqrt(eye)).toFixed(1)} nm):` : 'Nothing in sight but water.';
  lookRep.replaceChildren();
  const h = document.createElement('div'); h.style.opacity = '0.8'; h.textContent = head; lookRep.appendChild(h);
  if (visM >= 2000) for (const t of lines) { const li = document.createElement('div'); li.textContent = t; lookRep.appendChild(li); }
  lookRep.hidden = false;
  try { window.parent?.__audioChartViews?.say?.(visM < 2000 || !lines.length ? head : 'Lookout reports: ' + lines.join('. ') + '.'); } catch (_) {}
}
addEventListener('keydown', e => { if ((e.key === 'l' || e.key === 'L') && nest.on && !e.metaKey && !e.ctrlKey && !/INPUT|SELECT/.test(e.target.tagName)) lookoutReport(); });
function drawBinoc(lookTrue, hfov) {
  const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(sceneEl.clientWidth * dpr), H = Math.round(sceneEl.clientHeight * dpr);
  if (binCv.width !== W || binCv.height !== H) { binCv.width = W; binCv.height = H; }
  const c = binCtx, r = Math.min(H * 0.47, W * 0.3), cx = W / 2, cy = H / 2, off = r * 0.6;
  c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, W, H);
  c.fillStyle = '#050607'; c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'destination-out';
  for (const x of [cx - off, cx + off]) {
    const g = c.createRadialGradient(x, cy, r * 0.8, x, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, cy, r, 0, Math.PI * 2); c.fill();
  }
  c.globalCompositeOperation = 'source-over';
  const ink = 'rgba(232,236,230,0.85)', px = W / hfov;   // canvas pixels per degree
  c.strokeStyle = ink; c.fillStyle = ink; c.lineWidth = Math.max(1, dpr);
  // cross-hair: a horizontal mil scale through the centre and a short vertical index
  c.beginPath(); c.moveTo(cx - r * 0.55, cy); c.lineTo(cx + r * 0.55, cy);
  for (let k = -10; k <= 10; k++) { const x = cx + k * px * 0.1, hgt = (k % 5 ? 4 : 8) * dpr; c.moveTo(x, cy - hgt); c.lineTo(x, cy + hgt); }
  c.moveTo(cx, cy - r * 0.18); c.lineTo(cx, cy + r * 0.18); c.stroke();
  // compass along the bottom, magnetic, as in a pair of marine glasses
  const mag = toMag(lookTrue), yS = cy + r * 0.66, span = r * 0.7;
  c.save(); c.beginPath(); c.rect(cx - span, yS - 26 * dpr, span * 2, 52 * dpr); c.clip();
  c.font = `${11 * dpr}px ui-monospace, Menlo, monospace`; c.textAlign = 'center'; c.textBaseline = 'top';
  c.beginPath();
  for (let h = Math.floor(mag - hfov / 2) * 2 - 2; h <= (mag + hfov / 2) * 2 + 2; h++) {   // half-degree ticks, every degree numbered
    const d = h / 2, x = cx + (d - mag) * px, whole = h % 2 === 0;
    c.moveTo(x, yS); c.lineTo(x, yS - (whole ? 10 : 5) * dpr);
    if (whole && px > 40 && Math.abs(x - cx) < span - 14 * dpr) c.fillText(String(((d % 360) + 360) % 360).padStart(3, '0'), x, yS + 3 * dpr);
  }
  c.stroke(); c.restore();
  c.beginPath(); c.moveTo(cx, yS - 16 * dpr); c.lineTo(cx - 5 * dpr, yS - 24 * dpr); c.lineTo(cx + 5 * dpr, yS - 24 * dpr); c.closePath(); c.fill();
  // the readout: bearing, range to the land under the cross-hair, the nearest named place
  const R = binoc.range, brg = String(Math.round(mag) % 360).padStart(3, '0') + '° M';
  const txt = R ? `${brg} · ${R.d < 926 ? Math.round(R.d / 0.9144 / 10) * 10 + ' yd' : (R.d / NM).toFixed(R.d < 9260 ? 2 : 1) + ' nm'}${R.name ? ' · ' + R.name : ''}` : brg;
  c.font = `600 ${13 * dpr}px system-ui, sans-serif`; c.textBaseline = 'middle'; c.textAlign = 'center';
  const tw = c.measureText(txt).width + 20 * dpr;
  c.fillStyle = 'rgba(5,6,7,0.55)'; c.fillRect(cx - tw / 2, cy + r * 0.82 - 11 * dpr, tw, 22 * dpr);
  c.fillStyle = '#f3f1e8'; c.fillText(txt, cx, cy + r * 0.82);
  // the light you're on: a ring round it and its name over the cross-hair
  const B = binoc.mark;
  if (B) {
    if (B.m.lamp) B.m.lamp.getWorldPosition(_lp); else { B.m.g.getWorldPosition(_lp); _lp.y += 2 * B.m.g.scale.y; }
    const q = _lp.project(camera), mx = (q.x + 1) / 2 * W, my = (1 - q.y) / 2 * H;
    c.strokeStyle = 'rgba(255,214,120,0.9)'; c.lineWidth = 1.5 * dpr; c.beginPath(); c.arc(mx, my, 16 * dpr, 0, Math.PI * 2); c.stroke();
    const lt = markText(B), lw = c.measureText(lt).width + 20 * dpr, ly = cy - r * 0.62;
    c.fillStyle = 'rgba(5,6,7,0.55)'; c.fillRect(cx - lw / 2, ly - 11 * dpr, lw, 22 * dpr);
    c.fillStyle = '#ffd98a'; c.fillText(lt, cx, ly);
  }
}
// to another 3D view: inside AudioChart the chart loads it behind this one and fades it in (v899)
const goView = url => { try { if (window.parent !== window && window.parent.__audioChartViews?.go?.(window, url)) return; } catch (_) {} location.href = url; };
// Bird's-eye (v875, requested: one of the 3D view's choices): switches this window to the
// Bird's-eye view of the bay with this route and your boat where she is now (still sailing if she
// was), and its "◀ 3D helm" button comes back here. In a Virtual Journey both follow the journey.
{
  const b = document.createElement('button'); b.type = 'button'; b.textContent = "Bird's-eye"; b.className = 'birdbtn'; b.id = 'tobird';
  b.title = 'The whole bay from the air, with your boat on this route';
  b.addEventListener('pointerdown', e => e.stopPropagation());
  b.addEventListener('click', () => {
    const p = FREE ? [freeP.x, freeP.z] : posAt(S), q = new URLSearchParams();
    if (FREE) q.set('free', '1'); else q.set('route', params.get('route') || ROUTE.id);
    q.set('lat', (-p[1] / MY + LAT0).toFixed(5)); q.set('lon', (p[0] / MX + LON0).toFixed(5));
    q.set('dist', '700'); q.set('tilt', '55'); q.set('az', String(Math.round(smoothCourse ?? 0)));
    if (!FREE) { q.set('at', (S / TOTAL).toFixed(5)); q.set('pace', speedEl.value); if (playing) q.set('play', '1'); }
    q.set('from', 'helm'); if (params.get('embed')) q.set('embed', '1');
    goView('./bay3d.html?' + q);
  });
  eyeBox.appendChild(b);
}
// Boat (v905): Cape Dory 25D or Angelique (or Bowdoin, v919); the scene is rebuilt for her, where you are now
{
  const b = document.createElement('button'); b.type = 'button'; b.className = 'birdbtn'; b.id = 'boatbtn';
  // round the three (v919): Sea Nymph, the Cape Dory 25D → Angelique → Bowdoin → Sea Nymph
  const NEXT = { cd25: 'angelique', angelique: 'bowdoin', bowdoin: 'cd25' }, SHORT = { cd25: 'Sea Nymph', angelique: 'Angelique', bowdoin: 'Bowdoin' };
  b.textContent = '⛵ ' + SHORT[BOAT_TYPE]; b.title = `Your boat: ${BOATS[BOAT_TYPE]}. Click for ${BOATS[NEXT[BOAT_TYPE]]}`;
  b.addEventListener('pointerdown', e => e.stopPropagation());
  b.addEventListener('click', () => {
    const next = NEXT[BOAT_TYPE], q = new URLSearchParams(location.search);
    try { localStorage.setItem(BOAT_KEY, next); } catch (_) {}
    q.set('boat', next);
    if (FREE) { q.set('lat', (-freeP.z / MY + LAT0).toFixed(5)); q.set('lon', (freeP.x / MX + LON0).toFixed(5)); q.set('hdg', String(Math.round(freeP.h))); }
    else { q.set('start', (S / NM).toFixed(3)); if (playing) q.set('play', '1'); else q.delete('play'); q.set('pace', speedEl.value); }
    location.replace(location.pathname + '?' + q);
  });
  eyeBox.appendChild(b);
}
// Weather (v858): a button at the end of the View buttons opens the conditions panel (weather3d.js)
wxPanel = weatherPanel({ host: eyeBox, panelParent: sceneEl, where: () => routeLL[Math.floor(routeLL.length / 2)], pick: applyConditions });
applyConditions(startConditions(params));
const wpBtn = document.createElement('button'); wpBtn.type = 'button'; wpBtn.className = 'wpbtn'; wpBtn.textContent = '◆ Waypoints';
wpBtn.title = 'Show the route\'s waypoints and the next one\'s distance (W)';
const setWp = on => {
  wpOn = on; wpGroup.visible = on; wpBtn.classList.toggle('on', on); wpBtn.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem(WP_KEY, on ? 'on' : 'off'); } catch (_) {}
  lblFrame = 0;   // relabel now
};
wpBtn.addEventListener('pointerdown', e => e.stopPropagation());
wpBtn.addEventListener('click', () => setWp(!wpOn)); if (!FREE) eyeBox.appendChild(wpBtn); setWp(wpOn);
addEventListener('keydown', e => { if (!FREE && (e.key === 'w' || e.key === 'W') && !e.metaKey && !e.ctrlKey && !/INPUT|SELECT/.test(e.target.tagName)) setWp(!wpOn); });
addEventListener('keydown', e => {
  if (e.key !== 'h' && e.key !== 'H') return;
  const i = EYE_CHOICES.findIndex(c => Math.abs(c.m - eyeTarget) < 0.2);
  setEye(EYE_CHOICES[(i + 1) % EYE_CHOICES.length].m);
});
const _nestP = new THREE.Vector3();
const TILLER = new THREE.Vector3(HELM_X, EYE, HELM_Z), AT_MAST = ANGEL ? new THREE.Vector3(...SHIP.atMast) : new THREE.Vector3(0.3, 2.6, -3.2);   // on the foredeck, just forward of the mast
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
  if (!FREE) {
  c.lineWidth = 2; c.strokeStyle = '#a5741f'; c.setLineDash([5, 4]); c.beginPath();
  routeLL.forEach(([lo, la], i) => i ? c.lineTo(X(lo), Y(la)) : c.moveTo(X(lo), Y(la))); c.stroke(); c.setLineDash([]);
  let acc = 0; c.lineWidth = 3; c.strokeStyle = '#7a4f0e'; c.beginPath(); c.moveTo(X(routeLL[0][0]), Y(routeLL[0][1]));
  for (let i = 1; i < route.length; i++) {
    const segLen = cum[i] - cum[i - 1];
    if (acc + segLen >= S) { c.lineTo(X(lon), Y(lat)); break; }
    c.lineTo(X(routeLL[i][0]), Y(routeLL[i][1])); acc += segLen;
  }
  c.stroke();
  }
  if (wpOn) for (const p of wps) {   // waypoints
    const x = X(routeLL[p.i][0]), y = Y(routeLL[p.i][1]); if (x < -5 || y < -5 || x > size + 5 || y > size + 5) continue;
    c.fillStyle = p.last ? '#d0342c' : p.night ? '#e0a843' : '#2fa35a'; c.strokeStyle = '#fbfcf8'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, y - 4.5); c.lineTo(x + 3.5, y); c.lineTo(x, y + 4.5); c.lineTo(x - 3.5, y); c.closePath(); c.fill(); c.stroke();
  }
  // buoys
  for (const m of marks) {
    if (m.kind !== 'buoy') continue;
    const x = X(m.n.x), y = Y(m.n.y); if (x < -5 || y < -5 || x > size + 5 || y > size + 5) continue;
    c.fillStyle = (m.n.c || '').startsWith('red') ? '#c23a2e' : (m.n.c || '').startsWith('green') ? '#2b8a4a' : '#555';
    c.beginPath(); c.arc(x, y, 2, 0, 7); c.fill();
  }
  for (const fy of ferries) {   // ferries: a small dark hull
    const fp = fy.group.position, x = X(fp.x / MX + LON0), y = Y(-fp.z / MY + LAT0); if (x < -5 || y < -5 || x > size + 5 || y > size + 5) continue;
    c.save(); c.translate(x, y); c.rotate(-fy.group.rotation.y); c.fillStyle = '#22324a'; c.strokeStyle = '#fbfcf8'; c.lineWidth = 1; c.fillRect(-2.5, -6, 5, 12); c.strokeRect(-2.5, -6, 5, 12); c.restore();
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
const _camW = new THREE.Vector3();
function frame() {
  if (++fpsN === 60) { window.__fps = Math.round(60000 / (performance.now() - fpsT)); fpsN = 0; fpsT = performance.now(); }
  const dt = Math.min(0.1, clock.getDelta()); t += dt;
  updateNight();
  if (FREE) updateFree(dt);
  else if (vjFollow) {   // ease toward the journey's broadcast position, which arrives once per tick
    const target = vjFollow.frac * TOTAL;
    S = Math.abs(target - S) > 500 ? target : S + (target - S) * Math.min(1, dt * 2);
    posEl.value = (S / NM).toFixed(3);
  }
  else if (playing) { S += dt * BOAT_KN * NM / 3600 * Number(speedEl.value); if (S >= TOTAL) { S = TOTAL; setPlaying(false); } posEl.value = (S / NM).toFixed(3); }
  if (FREE) { /* no end of the route to anchor at */ }
  else if (anchor.state === 'up' && S >= TOTAL - 1) arrive();
  else if (anchor.state !== 'up' && S < TOTAL - 50) raiseAnchor();
  updateAnchor(dt);
  const pos = FREE ? [freeP.x, freeP.z] : posAt(S), course = FREE ? freeP.h : courseAt(S);
  if (t - lastTileCheck > 0.5) { lastTileCheck = t; updateTiles(pos[0], pos[1]); }
  smoothCourse = smoothCourse == null ? course : smoothCourse + (((course - smoothCourse + 540) % 360) - 180) * Math.min(1, dt * 1.5);
  const look = smoothCourse + yawOff;
  const mv = WND.move, bob = (Math.sin(t * 1.1) * 0.12 + Math.sin(t * 0.63 + 1) * 0.08) * mv;
  boat.position.set(pos[0], bob, pos[1]);
  updateFerries(t);
  camera.fov = 55 / zoom; camera.updateProjectionMatrix();
  const roll = Math.sin(t * 0.9) * 0.012 * Math.pow(mv, 0.8);
  const wantSails = anchor.state === 'up' && WND.heel > 0;   // set in every view while under way with wind (v870; was Drone only)
  if (wantSails !== sailsUp) { sailsUp = wantSails; if (!angel) setSails(sailsUp); }   // (Angelique sets her own, below)
  const pt = pointOfSail(smoothCourse, dt);
  if (sailsUp && !angel) trimSails(pt.boom, pt.jib, pt.side, pt.jibOn);
  heel += ((sailsUp ? pt.side * pt.heelK * THREE.MathUtils.degToRad(WND.heel) : 0) - heel) * Math.min(1, dt * 0.8);   // heeling to leeward
  bow.rotation.z = heel;   // the hull heels; the camera (a child of boat, not bow) stays level
  if (angel) {
    angel.trim(pt, Math.abs(heel) / Math.max(1e-3, pt.heelK || 1), sailsUp);   // she sets the heel herself (stiffer than the Cape Dory)
    angel.steer(dt > 0 && lastCourse != null ? (((smoothCourse - lastCourse + 540) % 360) - 180) / dt : 0, dt);   // the wheel follows her turning
  }
  lastCourse = smoothCourse;
  boat.rotation.set((Math.sin(t * 0.7) * 0.012 + Math.sin(t * 0.45 + 2) * 0.01 * Math.max(0, mv - 1)) * mv, -THREE.MathUtils.degToRad(smoothCourse), roll * 2, 'YXZ');
  ownWake(pos, dt);
  const ease = camK * camK * (3 - 2 * camK);
  // viewpoint height (Helm / 20 ft / 60 ft), eased so changes glide
  eyeH += (eyeTarget - eyeH) * Math.min(1, dt * 2.5);
  TILLER.set(HELM_X * (eyeH <= EYE + 0.3 ? 1 : 0), eyeH, HELM_Z + eyeBack(eyeH));
  { const side = binoc.on && !nest.on && Math.abs(yawOff) > 12 ? Math.sign(yawOff) : 0; binoc.sx += (side - binoc.sx) * Math.min(1, dt * 1.6); }
  nest.k += ((nest.on ? 1 : 0) - nest.k) * Math.min(1, dt * 1.2);   // the climb: a few seconds up or down
  if (nest.k > 0.001 && angel?.nest) {
    angel.group.updateMatrixWorld(true); angel.nest.getWorldPosition(_nestP); camera.parent.worldToLocal(_nestP);
    const sm = x => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); }, ez = sm(nest.k / 0.35), ey = sm((nest.k - 0.25) / 0.75);   // forward along the deck to the foremast, then up the ratlines
    TILLER.set(TILLER.x + (_nestP.x - TILLER.x) * ez, TILLER.y + (_nestP.y - TILLER.y) * ey, TILLER.z + (_nestP.z - TILLER.z) * ez);
  }
  if (!nest.on && Math.abs(binoc.sx) > 0.001) { const a = Math.abs(binoc.sx); TILLER.x = TILLER.x * (1 - a) + binoc.sx * RAIL[0]; TILLER.y += (RAIL[1] - EYE) * a; TILLER.z = TILLER.z * (1 - a) + RAIL[2] * a; }
  if (eyeH > EYE + 0.3) TILLER.applyAxisAngle(UP_AXIS, -THREE.MathUtils.degToRad(yawOff * (1 - ease)));   // orbit the boat
  camera.position.lerpVectors(TILLER, AT_MAST, ease);
  camera.rotation.set(THREE.MathUtils.degToRad((pitch - eyeTilt(eyeH)) + (-38 - (pitch - eyeTilt(eyeH))) * ease), -THREE.MathUtils.degToRad(yawOff * (1 - ease)), -roll * 1.6, 'YXZ');
  if (binoc.on) {   // hands and the boat: a slow wander, a little more in a seaway
    const k = 0.05 * (0.6 + mv);
    camera.rotation.x += THREE.MathUtils.degToRad(k * (Math.sin(t * 1.3) + 0.5 * Math.sin(t * 3.1 + 1)));
    camera.rotation.y += THREE.MathUtils.degToRad(k * (Math.sin(t * 0.9 + 2) + 0.5 * Math.sin(t * 2.3)));
  }
  for (const m of marks) {
    if (!m.fixedMark) { const d = Math.hypot(m.g.position.x - pos[0], m.g.position.z - pos[1]); m.g.scale.setScalar(Math.max(1, Math.min(6, d / 150))); m.g.position.y = Math.sin(t * 1.4 + m.phase) * 0.18; m.g.rotation.z = Math.sin(t * 1.1 + m.phase) * 0.06; m.g.rotation.x = Math.cos(t * 0.9 + m.phase) * 0.05; }
    if (m.lamp && m.fl) { const ph = (t + m.phase) % m.fl.per; m.lamp.visible = m.fl.fixed || (m.fl.iso ? ph < m.fl.per / 2 : ph < 0.45); }
  }
  updateLights(pos);
  sky.position.set(boat.position.x, 0, boat.position.z);   // the dome travels with the boat
  env.stars.position.copy(sky.position);
  env.update(dt, camera, boat.position);
  wildlife.update(dt, t, boat.position, camera.getWorldPosition(_camW), { night: env.C.time === 'night', boat: boat.position, scale: d => Math.min(2.5, Math.max(1, d / 150)) });
  renderer.render(scene, camera);
  updateLabels(pos);
  const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect) * 180 / Math.PI;
  drawTape(toMag(look), hfov);   // a magnetic compass card
  binocView = binoc.on ? { bearing: look, hfov } : null;
  if (binoc.on) {
    if (t - binoc.rangeT > 0.25) { binoc.rangeT = t; binoc.range = binocRange(look, pitch, _camW.y); { const B = binocMark(); if (B) { binoc.mark = B; binoc.markT = t; } else if (t - (binoc.markT || 0) > 1.2) binoc.mark = null; } }   // held a moment, so the name doesn't flicker with the shake of your hands
    drawBinoc(look, hfov);
  }
  drawChart(pos, (smoothCourse + 360) % 360, ((look % 360) + 360) % 360, hfov);
  if (rec) recFrame();
  document.getElementById('ro-cog').textContent = String(Math.round(toMag(smoothCourse)) % 360).padStart(3, '0') + '° M';
  document.getElementById('ro-look').textContent = String(Math.round(toMag(look)) % 360).padStart(3, '0') + '° M';
  document.getElementById('ro-run').textContent = FREE ? (freeP.kn ? `${freeP.kn} kn` : 'stopped') : `${(S / NM).toFixed(1)}/${(TOTAL / NM).toFixed(1)} nm`;
  document.getElementById('ro-zoom').textContent = zoom.toFixed(1) + '×';
  updateWaypoints(pos);
  if (lblFrame % 8 === 1) {
    const nx = wpOn && nextWp(S), el = document.getElementById('ro-wp');
    el.parentElement.hidden = !wpOn;
    if (nx) { const dx = nx.w[0] - pos[0], dz = nx.w[1] - pos[1]; el.textContent = `${nx.label} · ${(Math.hypot(dx, dz) / NM).toFixed(2)} nm · ${String(Math.round(toMag(Math.atan2(dx, -dz) * 180 / Math.PI)) % 360).padStart(3, '0')}° M`; }
    else if (wpOn) el.textContent = 'Arrived';
  }
  if (lblFrame % 8 === 1) document.getElementById('ro-wind').textContent = `${WIND_DIRS[Math.round(env.C.windFrom / 22.5) % 16]} ${WND.kn} · ${pt.label}`;
  if (lblFrame % 8 === 1) {
    let best = null;
    for (const m of marks) {
      if (m.kind !== 'buoy') continue;
      const dx = m.g.position.x - pos[0], dz = m.g.position.z - pos[1], d = Math.hypot(dx, dz);
      const rel = Math.abs((((Math.atan2(dx, -dz) * 180 / Math.PI) - smoothCourse + 540) % 360) - 180);
      if (rel < 30 && d < 3 * NM && (!best || d < best.d)) best = { m, d, rel };
    }
    const dEl = document.getElementById('ro-depth');
    const dep = depthSnd ? depthAtFrom(depthSnd, depthZones, LAT0 - pos[1] / MY, LON0 + pos[0] / MX) : null;
    const ft = dep ? dep.m * 3.28084 : null;
    dEl.textContent = ft == null ? '—' : `${ft < 10 ? ft.toFixed(1) : Math.round(ft)} ft`;
    dEl.className = ft == null ? '' : ft < DRAFT_FT + 1 ? 'alarm' : ft < DRAFT_FT + 3 ? 'warn' : '';
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

// Free Sailing: AudioChart's boat ~5 times a second; eased in between so she glides
const freeP = FREE ? { x: wx(FREE.lon), z: wz(FREE.lat), h: FREE.hdg, kn: FREE.kn, tx: wx(FREE.lon), tz: wz(FREE.lat), th: FREE.hdg } : null;
const FREE_C = FREE ? { x: wx(FREE.lon), z: wz(FREE.lat) } : null;
let freeLeaving = false;
function freeAim(f) {
  freeP.tx = wx(f.lon); freeP.tz = wz(f.lat); freeP.th = f.hdg; freeP.kn = f.running ? f.kn : 0;
  if (Math.hypot(freeP.tx - freeP.x, freeP.tz - freeP.z) > 500) { freeP.x = freeP.tx; freeP.z = freeP.tz; }   // a jump, not a glide
  // near the edge of the scene: start again centred on her
  if (!freeLeaving && Math.hypot(freeP.tx - FREE_C.x, freeP.tz - FREE_C.z) > FREE_R - 1.5 * NM) {
    freeLeaving = true;
    const q = new URLSearchParams(location.search);
    q.set('lat', f.lat.toFixed(5)); q.set('lon', f.lon.toFixed(5)); q.set('hdg', String(Math.round(f.hdg))); q.set('kn', String(freeP.kn));
    location.replace('./helm3d.html?' + q);
  }
}
function updateFree(dt) {
  const k = Math.min(1, dt * 3);
  freeP.x += (freeP.tx - freeP.x) * k; freeP.z += (freeP.tz - freeP.z) * k;
  freeP.h = (freeP.h + (((freeP.th - freeP.h + 540) % 360) - 180) * Math.min(1, dt * 1.5) + 360) % 360;
}
if (FREE) {   // nothing to play along: the boat is sailed from AudioChart
  for (const id of ['play', 'pos']) { const el = document.getElementById(id); if (el) el.hidden = true; }
  const sp = document.getElementById('speed')?.closest('label'); if (sp) sp.hidden = true;
  const vn = document.getElementById('vjnote'); vn.textContent = 'Following Free Sailing'; vn.hidden = false;
}

// Follow a Virtual Journey running in the AudioChart window (it broadcasts its progress).
let vjFollow = null;
// an overnight stop on the journey (v887): sunset, night, dawn and day again over its few seconds
let night = null, nightSeen = 0;
function updateNight() {
  if (!night) return;
  const u = (Date.now() - night.start) / night.dur;
  if (u >= 1) { night = null; env.blendHour = null; applyConditions({ time: 'day' }); return; }
  const L = cycleLook(night.from, u); env.blendT = L.T; env.blendHour = L.hour; applyConditions({ time: L.time }); env.blendT = null;   // (blendHour stays set: the moon follows the cycle, not the night clock)
}
const vjNote = document.getElementById('vjnote');
try {
  const ch = new BroadcastChannel('audiochart-vj');
  ch.onmessage = (e) => {
    const m = e.data || {};
    if ('rate' in m) env.setMoonRate(m.rate);   // the journey's time rate drives the moon (v916)
    if (m.cycle && m.cycle.start !== nightSeen) { nightSeen = m.cycle.start; night = { ...m.cycle, from: env.C.time }; }   // an overnight stop (v887)
    if (FREE) { if (m.free) freeAim(m.free); return; }
    if (m.routeId !== ROUTE.id) return;
    if (!m.running && m.frac >= 0.999) S = TOTAL;   // journey complete: arrive
    vjFollow = m.running ? { frac: Math.max(0, Math.min(1, m.frac)) } : null;
    vjNote.hidden = !vjFollow;
    playBtn.disabled = !!vjFollow;
  };
  ch.postMessage({ hello: true });   // ask the app where the journey is (it may already have arrived)
} catch (_) {}
window.__helm3d = { env, setNight: on => applyConditions({ time: on ? 'night' : 'day' }), applyConditions, COND: env.C, scene, renderer, camera, tiles, ferries, updateTiles, posAt, TOTAL, wx, wz, frame, setS: v => { S = v; }, setLook: (y, p) => { yawOff = y; pitch = p; }, setZoom: z => { zoom = z; }, binoc, marks, nest, setNest: on => setNest(on), lookoutReport: () => lookoutReport() };   // console/testing hooks
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

// Clear view (v911): the chart's "⛶ Clear" button hides this view's own buttons too; follow its class
try {
  const app = window.parent !== window && window.parent.document.getElementById('app');
  if (app) { const sync = () => document.body.classList.toggle('clear-view', app.classList.contains('clear-view')); sync(); new MutationObserver(sync).observe(app, { attributes: true, attributeFilter: ['class'] }); }
} catch (_) {}
