// AudioChart bird's-eye view of Penobscot Bay (v844): the whole bay in 3D from USGS 3DEP elevation
// and USDA NAIP photos, with a camera you fly yourself and a list of the towns that have
// buildings (www/data/buildings) to fly down to. Opened from the map-type menu ("3D Bird's-eye",
// shown over the chart in an iframe with embed=1) or directly as bay3d.html
// [?lat=&lon=&dist=metres | ?town=<file stem>]. Terrain, photos and buildings come from the same
// code as the 3D helm view (terrain3d.js), so both share one download cache.
//
// Two levels of detail: one coarse mesh of the whole bay (~80 m elevation, one ~35 m photo), and
// the helm view's 10 m tiles (0.07° × 0.045°, each with its own photo) loaded only around where
// you are looking once you are low enough to see them. Town buildings load near their town.
import * as THREE from 'three';
import { Water } from './lib/three/Water.js';
import { LON0, LAT0, MX, MY, wx, wz, readDem, photo, addCanopy, gridMesh, photoMat, buildTown, disposeGroup, spruce } from './terrain3d.js';

const statusEl = document.getElementById('status');
const loadingEl = document.getElementById('loading');
const fail = (msg) => { statusEl.textContent = msg; statusEl.hidden = false; };
window.addEventListener('error', e => fail('Something went wrong: ' + e.message));

const params = new URLSearchParams(location.search);
if (params.get('embed')) document.body.classList.add('embed');
const lonOf = x => x / MX + LON0, latOf = z => -z / MY + LAT0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DEG = Math.PI / 180;

// The overview reaches past the bay so its horizon is land, not open sea; the camera's target
// stays inside the bay itself.
const OVERVIEW = [-69.45, 43.75, -67.95, 44.75];
const BAY = [-69.25, 43.85, -68.1, 44.55];
const WHOLE = { lon: -68.7, lat: 44.17, dist: 60000, tilt: 40 * DEG, az: 0 };
const MIN_DIST = 120, MAX_DIST = 140000;

async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`Could not load ${url}`); return r.json(); }

async function main() {
// ── Renderer, scene, light ──
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(1.25, devicePixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
const sceneEl = document.getElementById('scene');
sceneEl.appendChild(renderer.domElement);
const ANISO = renderer.capabilities.getMaxAnisotropy();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 2, 1, 400000);
const HAZE = new THREE.Color(0xb2cbe0);
scene.fog = new THREE.FogExp2(HAZE, 0.000075);
const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 32), THREE.MathUtils.degToRad(205));
scene.add(new THREE.HemisphereLight(0xe4ecf2, 0x4a5644, 1.7));
const dl = new THREE.DirectionalLight(0xfff3e0, 2.1); dl.position.copy(sun).multiplyScalar(1000); scene.add(dl);
const PLAIN = new THREE.MeshLambertMaterial({ color: 0x66735c });

// ── Camera: a target point on the water, a distance from it, a heading and a tilt ──
// az = the direction you are looking (0 = north); tilt = 0 straight down, up to ~80° near the horizon.
const view = { x: wx(WHOLE.lon), z: wz(WHOLE.lat), dist: WHOLE.dist, az: WHOLE.az, tilt: WHOLE.tilt };
const maxTilt = d => DEG * (d > 40000 ? 55 : d < 2000 ? 80 : 80 - 25 * Math.log(d / 2000) / Math.log(20));
function clampView() {
  view.dist = clamp(view.dist, MIN_DIST, MAX_DIST);
  view.tilt = clamp(view.tilt, 0.05, maxTilt(view.dist));   // never quite straight down, so 'up' stays defined
  view.x = clamp(view.x, wx(BAY[0]), wx(BAY[2])); view.z = clamp(view.z, wz(BAY[3]), wz(BAY[1]));
}
function placeCamera() {
  const h = view.dist * Math.sin(view.tilt), fx = Math.sin(view.az), fz = -Math.cos(view.az);
  camera.position.set(view.x - fx * h, view.dist * Math.cos(view.tilt), view.z - fz * h);
  camera.lookAt(view.x, 0, view.z);
  camera.near = clamp(view.dist * 0.002, 0.5, 50); camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), seaPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitV = new THREE.Vector3();
function groundAt(clientX, clientY) {   // where a screen point meets sea level, or null above the horizon
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (ray.ray.direction.y > -0.01) return null;
  return ray.ray.intersectPlane(seaPlane, hitV) ? [hitV.x, hitV.z] : null;
}

// ── Flying: target, heading and tilt ease over; the distance rises in between when the hop is long ──
let anim = null;
function flyTo(to, dur = 2600) {
  const from = { ...view };
  let daz = ((to.az ?? from.az) - from.az) % (2 * Math.PI); if (daz > Math.PI) daz -= 2 * Math.PI; if (daz < -Math.PI) daz += 2 * Math.PI;
  const hop = Math.hypot(to.x - from.x, to.z - from.z);
  const peak = Math.max(from.dist, to.dist, hop * 0.9);
  anim = { t0: performance.now(), dur, from, to: { ...to, az: from.az + daz, tilt: to.tilt ?? from.tilt },
    bump: Math.max(0, Math.log(peak) - Math.max(Math.log(from.dist), Math.log(to.dist))) };
}
function stepAnim(now) {
  if (!anim) return;
  const u = clamp((now - anim.t0) / anim.dur, 0, 1), e = u * u * (3 - 2 * u), { from, to } = anim;
  view.x = from.x + (to.x - from.x) * e; view.z = from.z + (to.z - from.z) * e;
  view.az = from.az + (to.az - from.az) * e; view.tilt = from.tilt + (to.tilt - from.tilt) * e;
  view.dist = Math.exp(Math.log(from.dist) + (Math.log(to.dist) - Math.log(from.dist)) * e + anim.bump * Math.sin(Math.PI * u));
  if (u >= 1) anim = null;
}

// ── Pointer and wheel: drag to move, right/Shift-drag to turn and tilt, wheel/pinch to zoom ──
const pointers = new Map();
let drag = null;
sceneEl.addEventListener('contextmenu', e => e.preventDefault());
sceneEl.addEventListener('pointerdown', e => {
  anim = null; sceneEl.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  sceneEl.classList.add('dragging');
  if (pointers.size === 1) drag = { mode: (e.button === 2 || e.shiftKey || e.ctrlKey) ? 'turn' : 'pan', x: e.clientX, y: e.clientY, anchor: groundAt(e.clientX, e.clientY) };
  else drag = { mode: 'pinch', ...pinchState() };
});
function pinchState() {
  const [a, b] = [...pointers.values()];
  return { d: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}
sceneEl.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId) || !drag) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (drag.mode === 'pan') {
    if (!drag.anchor) { drag.anchor = groundAt(e.clientX, e.clientY); return; }
    const hit = groundAt(e.clientX, e.clientY); if (!hit) return;
    view.x += drag.anchor[0] - hit[0]; view.z += drag.anchor[1] - hit[1]; clampView(); placeCamera();
  } else if (drag.mode === 'turn') {
    view.az -= (e.clientX - drag.x) * 0.005; view.tilt += (e.clientY - drag.y) * 0.004;
    drag.x = e.clientX; drag.y = e.clientY; clampView(); placeCamera();
  } else if (pointers.size >= 2) {
    const p = pinchState();
    const anchor = groundAt(p.mx, p.my);
    view.dist *= drag.d / Math.max(1, p.d);
    view.az -= (p.ang - drag.ang);
    view.tilt += (p.my - drag.my) * 0.004;
    clampView(); placeCamera();
    const hit = anchor && groundAt(p.mx, p.my);
    if (anchor && hit) { view.x += anchor[0] - hit[0]; view.z += anchor[1] - hit[1]; clampView(); placeCamera(); }
    Object.assign(drag, p);
  }
});
const endPointer = e => {
  pointers.delete(e.pointerId);
  if (!pointers.size) { drag = null; sceneEl.classList.remove('dragging'); }
  else if (pointers.size === 1) { const [p] = pointers.values(); drag = { mode: 'pan', x: p.x, y: p.y, anchor: groundAt(p.x, p.y) }; }
};
sceneEl.addEventListener('pointerup', endPointer); sceneEl.addEventListener('pointercancel', endPointer);
sceneEl.addEventListener('wheel', e => {
  e.preventDefault(); anim = null;
  const anchor = groundAt(e.clientX, e.clientY);
  view.dist *= Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)); clampView(); placeCamera();
  const hit = anchor && groundAt(e.clientX, e.clientY);
  if (anchor && hit) { view.x += anchor[0] - hit[0]; view.z += anchor[1] - hit[1]; clampView(); placeCamera(); }
}, { passive: false });
addEventListener('keydown', e => {
  if (e.target !== document.body) return;
  const step = view.dist * 0.15, fx = Math.sin(view.az), fz = -Math.cos(view.az);
  const k = { ArrowUp: [fx, fz], ArrowDown: [-fx, -fz], ArrowLeft: [fz, -fx], ArrowRight: [-fz, fx] }[e.key];
  if (k) { view.x += k[0] * step; view.z += k[1] * step; }
  else if (e.key === '+' || e.key === '=') view.dist /= 1.4;
  else if (e.key === '-') view.dist *= 1.4;
  else return;
  e.preventDefault(); anim = null; clampView(); placeCamera();
});
document.getElementById('compass').addEventListener('click', () => flyTo({ x: view.x, z: view.z, dist: view.dist, az: 0, tilt: view.tilt }, 900));

// ── The whole bay, coarse ──
statusEl.textContent = 'Downloading the bay…';
const [OW, OS, OE, ON] = OVERVIEW;
const ovPhotoP = photo(OW, OS, OE, ON, 4000); ovPhotoP.catch(() => {});
const ov = await readDem(OW, OS, OE, ON, 3);
const OV_STRIDE = ov.w * ov.h > 1.2e6 ? 2 : 1;
const OV_RECT = { west: OW, east: OE, south: OS, north: ON };
let ovMesh = gridMesh(ov, OV_RECT, OV_STRIDE, PLAIN);
scene.add(ovMesh);
function heightAt(lon, lat) {
  for (const T of tiles) {
    if (T.state !== 'ready' || lon < T.w || lon >= T.e || lat < T.s || lat >= T.n) continue;
    const d = T.dem, c = Math.floor((lon - d.west) / d.dx), r = Math.floor((d.north - lat) / d.dy);
    return d.elev[r * d.w + c];
  }
  const c = Math.floor((lon - ov.west) / ov.dx), r = Math.floor((ov.north - lat) / ov.dy);
  return (c >= 0 && r >= 0 && c < ov.w && r < ov.h) ? ov.elev[r * ov.w + c] : -3;
}
ovPhotoP.then(ph => {
  addCanopy(ov, ph);
  const m2 = gridMesh(ov, ph, OV_STRIDE, photoMat(ph, ANISO));
  scene.remove(ovMesh); ovMesh.geometry.dispose(); ovMesh = m2; scene.add(m2);
  for (const T of tiles) if (T.state === 'ready') sinkOverview(T, true);
}).catch(err => console.warn('[bay3d] overview photo failed', err));
// Lower the overview under a loaded detail tile (and restore it when the tile goes).
function sinkOverview(T, down) {
  const pos = ovMesh.geometry.attributes.position, gidx = ovMesh.userData.gidx, inset = 0.0006;
  for (let i = 0; i < gidx.length; i++) {
    const gi = gidx[i], gx = gi % ov.w, gy = (gi - gx) / ov.w;
    const lon = ov.west + (gx + 0.5) * ov.dx, lat = ov.north - (gy + 0.5) * ov.dy;
    if (lon > T.w + inset && lon < T.e - inset && lat > T.s + inset && lat < T.n - inset) pos.setY(i, down ? -40 : ov.elev[gi]);
  }
  pos.needsUpdate = true;
}

// ── Detail tiles: the helm view's grid (same edges, so the same cached downloads) ──
const TW = 0.07, TH = 0.045;
const tiles = [];
for (let x = Math.floor(BAY[0] / TW) * TW; x < BAY[2]; x += TW)
  for (let y = Math.floor(BAY[1] / TH) * TH; y < BAY[3]; y += TH) {
    const w = +x.toFixed(4), s = +y.toFixed(4), e = +(x + TW).toFixed(4), n = +(y + TH).toFixed(4);
    tiles.push({ w, s, e, n, x0: wx(w), x1: wx(e), z0: wz(n), z1: wz(s), state: 'idle' });
  }
const rectDist = (T, px, pz) => Math.hypot(Math.max(T.x0 - px, 0, px - T.x1), Math.max(T.z0 - pz, 0, pz - T.z1));
async function loadTile(T) {
  T.state = 'loading'; const gen = (T.gen = (T.gen || 0) + 1);
  try {
    const M = 0.0002;
    const photoP = photo(T.w, T.s, T.e, T.n); photoP.catch(() => {});
    const dem = await readDem(T.w - M, T.s - M, T.e + M, T.n + M, 0);
    if (T.state !== 'loading' || T.gen !== gen) { photoP.then(ph => ph.img.close?.(), () => {}); return; }
    const rect = { west: T.w, east: T.e, south: T.s, north: T.n };
    Object.assign(T, { dem, mat: PLAIN, img: null, photo: 'pending', full: gridMesh(dem, rect, 1, PLAIN), coarse: gridMesh(dem, rect, 4, PLAIN) });
    T.full.visible = false; scene.add(T.full, T.coarse); sinkOverview(T, true); T.state = 'ready';
    photoP.then(ph => {
      if (T.state !== 'ready' || T.gen !== gen) { ph.img.close?.(); return; }
      addCanopy(dem, ph, () => 0);   // forest mask only: the 3D trees give the forest its height here
      T.spots = treeSpots(T, dem); treesDirty = true;
      const mat = photoMat(ph, ANISO), wasNear = T.full.visible;
      scene.remove(T.full, T.coarse); T.full.geometry.dispose(); T.coarse.geometry.dispose();
      T.full = gridMesh(dem, ph, 1, mat); T.coarse = gridMesh(dem, ph, 4, mat);
      T.full.visible = wasNear; T.coarse.visible = !wasNear; scene.add(T.full, T.coarse);
      T.mat = mat; T.img = ph.img; T.photo = 'done';
    }).catch(err => { console.warn('[bay3d] photo failed', T, err); T.photo = 'failed'; });
  } catch (err) { console.warn('[bay3d] tile failed', T, err); T.state = 'failed'; }
}
function dropTile(T) {
  if (T.state === 'loading') { T.state = 'idle'; return; }
  if (T.state !== 'ready') return;
  scene.remove(T.full, T.coarse); T.full.geometry.dispose(); T.coarse.geometry.dispose();
  if (T.mat !== PLAIN) { T.mat.map.dispose(); T.mat.dispose(); }
  T.img?.close?.(); sinkOverview(T, false);
  if (T.spots) { T.spots = null; treesDirty = true; }
  Object.assign(T, { state: 'idle', full: null, coarse: null, dem: null, mat: null, img: null, photo: null });
}
// ── 3D trees: one spruce per forested 10 m cell of a detail tile (from the photo, as in the
// helm view), on the bare-earth ground. Rebuilt as the view moves: every tree near the camera,
// thinning with distance (kept with chance (K/d)², the kept ones drawn wider to fill in), a
// tiered spruce up close and a plain cone beyond. ~60k trees at most.
const SP = 10;   // floats per tree: x, y, z, height, radius, turn, r, g, b, chance
function treeSpots(T, dem) {
  let seed = Math.round((T.w + 200) * 1e4 + T.s * 1e3); const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out = [];
  for (let y = 1; y < dem.h - 1; y++) for (let x = 1; x < dem.w - 1; x++) {
    const i = y * dem.w + x;
    if (dem.elev[i] <= 0.6 || dem.canopy[i] < 0.45) continue;
    const lon = dem.west + (x + rnd()) * dem.dx, lat = dem.north - (y + rnd()) * dem.dy;
    if (lon < T.w || lon >= T.e || lat < T.s || lat >= T.n) continue;   // the overlap belongs to the neighbour
    const hgt = 9 + rnd() * 10;
    out.push(wx(lon), dem.elev[i] - 0.5, wz(lat), hgt, hgt * (0.19 + rnd() * 0.08), rnd() * 6.28,
      0.055 + rnd() * 0.035, 0.09 + rnd() * 0.05, 0.07 + rnd() * 0.03, rnd());
  }
  return Float32Array.from(out);
}
const TREE_CAP = 60000, NEAR_TREE = 600;
const TREES = (() => {
  const { detailed, simple, mat } = spruce();
  const mk = geo => { const m = new THREE.InstancedMesh(geo, mat, TREE_CAP); m.count = 0; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); return m; };
  return { near: mk(detailed), far: mk(simple), K: 900, at: null };
})();
let treesDirty = false;
function updateTrees() {
  const cp = camera.position, on = view.dist < DETAIL_BELOW;
  const moved = !TREES.at || Math.hypot(cp.x - TREES.at.x, cp.y - TREES.at.y, cp.z - TREES.at.z) > Math.max(40, view.dist * 0.06);
  if (!treesDirty && !moved) return;
  treesDirty = false; TREES.at = cp.clone();
  let nN = 0, nF = 0;
  if (on) {
    const R = clamp(view.dist * 2.4, 1500, 6000), K2 = TREES.K * TREES.K;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    let wanted = 0;
    for (const T of tiles) {
      if (!T.spots || rectDist(T, view.x, view.z) > R) continue;
      const A = T.spots;
      for (let i = 0; i < A.length; i += SP) {
        const dx = A[i] - cp.x, dy = A[i + 1] - cp.y, dz = A[i + 2] - cp.z, d2 = dx * dx + dy * dy + dz * dz;
        const keep = d2 < K2 ? 1 : K2 / d2;
        if (A[i + 9] > keep) continue;
        if (Math.hypot(A[i] - view.x, A[i + 2] - view.z) > R) continue;
        wanted++;
        const near = d2 < NEAR_TREE * NEAR_TREE, mesh = near ? TREES.near : TREES.far, k = near ? nN : nF;
        if (k >= TREE_CAP) continue;
        const wide = Math.min(2.5, 1 / Math.sqrt(keep));
        pv.set(A[i], A[i + 1], A[i + 2]); sc.set(A[i + 4] * wide, A[i + 3], A[i + 4] * wide); q.setFromAxisAngle(up, A[i + 5]);
        mesh.setMatrixAt(k, m.compose(pv, q, sc)); mesh.setColorAt(k, col.setRGB(A[i + 6], A[i + 7], A[i + 8]));
        if (near) nN++; else nF++;
      }
    }
    // keep the total near the cap: thin harder next time if over, less if well under
    if (wanted > TREE_CAP * 1.6) TREES.K *= 0.85; else if (wanted < TREE_CAP * 0.6 && TREES.K < 1800) { TREES.K *= 1.15; treesDirty = true; }
  }
  for (const [mesh, n] of [[TREES.near, nN], [TREES.far, nF]]) {
    mesh.count = n; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

let loadingCount = 0;
const DETAIL_BELOW = 7000;   // camera distance under which 10 m tiles load
function updateTiles() {
  const R = clamp(view.dist * 1.1, 2500, 6500), low = view.dist < DETAIL_BELOW;
  for (const T of tiles) {
    const d = rectDist(T, view.x, view.z);
    if (T.state === 'ready') { const fine = d < 2500 && view.dist < 3500; T.full.visible = fine; T.coarse.visible = !fine; }
    if ((d > R + 4000 || view.dist > DETAIL_BELOW * 2) && (T.state === 'ready' || T.state === 'loading')) dropTile(T);
  }
  if (low) {
    const want = tiles.filter(T => T.state === 'idle' && rectDist(T, view.x, view.z) < R).sort((a, b) => rectDist(a, view.x, view.z) - rectDist(b, view.x, view.z));
    while (loadingCount < 2 && want.length) { const T = want.shift(); loadingCount++; loadTile(T).finally(() => { loadingCount--; }); }
  }
  const near = tiles.filter(T => rectDist(T, view.x, view.z) < 2500);
  const busy = low && near.some(T => T.state === 'loading' || (T.state === 'ready' && T.photo === 'pending'));
  loadingEl.textContent = near.some(T => T.state === 'loading') ? 'Loading detail…' : 'Loading aerial photos…';
  loadingEl.hidden = !busy && !townsLoading;
}

// ── Towns: listed from index.json, buildings built when you come near ──
let townsLoading = 0;
const townList = (await getJSON('./data/buildings/index.json').catch(() => [])).map(t => {
  const [w, s, e, n] = t.bbox, lon = (w + e) / 2, lat = (s + n) / 2;
  return { ...t, id: t.file.replace(/\.json$/, ''), short: t.name.split(/, | and /)[0], lon, lat, x: wx(lon), z: wz(lat), group: null, state: 'idle', credit: '' };
}).sort((a, b) => a.short.localeCompare(b.short));
const creditEl = document.getElementById('credit');
function updateCredit() {
  const shown = townList.filter(t => t.group);
  creditEl.textContent = 'Elevation USGS 3DEP · Photos USDA NAIP' + (shown.length ? ' · Buildings © OpenStreetMap contributors' + (shown.some(t => /Microsoft/.test(t.credit)) ? ', Microsoft' : '') : '');
}
async function loadTown(t) {
  t.state = 'loading'; townsLoading++;
  try {
    const T = t.data || (t.data = await getJSON(`./data/buildings/${t.file}`));
    if (t.state !== 'loading') return;
    t.group = buildTown(T); t.credit = T.credit || ''; scene.add(t.group); t.state = 'ready'; updateCredit();
  } catch (err) { console.warn('[bay3d] town', t.file, err); t.state = 'failed'; }
  finally { townsLoading--; }
}
function updateTowns() {
  for (const t of townList) {
    const d = Math.hypot(t.x - view.x, t.z - view.z);
    if (t.state === 'idle' && d < 5000 && view.dist < 9000) loadTown(t);
    else if ((t.state === 'ready' || t.state === 'loading') && (d > 9000 || view.dist > 16000)) {
      if (t.group) { scene.remove(t.group); disposeGroup(t.group); t.group = null; }
      t.state = 'idle'; updateCredit();
    }
  }
}
// Where to look at a town from: tries twelve headings and keeps the one with the most land just
// beyond the waterfront (the town) and the least under the camera and the line in (so it sits
// over open water, looking in). The aim then moves to the shore on the camera's side.
function townView(t) {   // t: {x, z}, a point on the town's waterfront
  const dist = 1100, tilt = 66 * DEG, back = dist * Math.sin(tilt);
  const landAt = (x, z) => heightAt(lonOf(x), latOf(z)) > 0.5;
  let best = null;
  if (t.az != null) best = { az: t.az, fx: Math.sin(t.az), fz: -Math.cos(t.az) };
  else for (let k = 0; k < 12; k++) {
    const az = k * 30 * DEG, fx = Math.sin(az), fz = -Math.cos(az);
    let score = 0;
    for (let r = 100; r <= 900; r += 80) if (landAt(t.x + fx * r, t.z + fz * r)) score += 1;
    for (let r = 200; r <= back * 1.15; r += 80) if (landAt(t.x - fx * r, t.z - fz * r)) score -= r > back * 0.7 ? 3 : 1.5;
    if (!best || score > best.score) best = { score, az, fx, fz };
  }
  let x = t.x, z = t.z;
  for (let r = 0; r <= 1500; r += 40) {   // from inland, walk out toward the camera to the water's edge
    if (!landAt(t.x - best.fx * r, t.z - best.fz * r)) { x = t.x - best.fx * Math.max(0, r - 120); z = t.z - best.fz * Math.max(0, r - 120); break; }
  }
  return { x, z, dist, tilt, az: best.az };
}
const townsUl = document.getElementById('towns'), wholeBtn = document.getElementById('whole');
let current = null;
function markCurrent(id) {
  current = id;
  for (const b of townsUl.querySelectorAll('button')) b.classList.toggle('on', b.dataset.id === id);
  wholeBtn.classList.toggle('on', id === 'whole');
}
// The village and its waterfront: the densest cluster of the town's buildings (or the index's
// "focus" point), seen from the nearest open water (the camera looks from that water toward the cluster).
async function waterfront(t) {
  try { t.data = t.data || await getJSON(`./data/buildings/${t.file}`); } catch (_) { return t; }
  const B = t.data.buildings.map(b => [wx(b.p[0][0]), wz(b.p[0][1])]);
  if (!B.length) return t;
  let vx, vz;
  if (t.focus) { vx = wx(t.focus[0]); vz = wz(t.focus[1]); }   // index.json can name the spot (WoodenBoat: the school, not Brooklin village)
  else {
  const cells = new Map(), C = 250;
  for (const [x, z] of B) { const k = `${Math.floor(x / C)},${Math.floor(z / C)}`; cells.set(k, (cells.get(k) || 0) + 1); }
  const [bk] = [...cells.entries()].sort((a, b) => b[1] - a[1])[0], [cx, cz] = bk.split(',').map(v => (Number(v) + 0.5) * C);
  const near = B.filter(([x, z]) => Math.hypot(x - cx, z - cz) < 400);
  vx = near.reduce((a, p) => a + p[0], 0) / near.length; vz = near.reduce((a, p) => a + p[1], 0) / near.length;
  }
  for (let r = 60; r <= 2000; r += 40) {   // the nearest water that is open (water a little beyond it too)
    for (let k = 0; k < 24; k++) {
      const a = k / 24 * 2 * Math.PI, wxp = vx + Math.sin(a) * r, wzp = vz - Math.cos(a) * r;
      const wet = d => heightAt(lonOf(vx + Math.sin(a) * d), latOf(vz - Math.cos(a) * d)) <= 0.5;
      if (wet(r) && wet(r + 150) && wet(r + 300)) return { x: wxp + (vx - wxp) * 0.35, z: wzp + (vz - wzp) * 0.35, az: Math.atan2(vx - wxp, -(vz - wzp)) };
    }
  }
  return { x: vx, z: vz };
}
async function goTown(t) { markCurrent(t.id); foldPanel(true); const at = await waterfront(t); if (current === t.id) flyTo(townView(at), 3200); }
function goWhole() { flyTo({ x: wx(WHOLE.lon), z: wz(WHOLE.lat), dist: WHOLE.dist, tilt: WHOLE.tilt, az: WHOLE.az }, 2600); markCurrent('whole'); foldPanel(true); }
for (const t of townList) {
  const li = document.createElement('li'), b = document.createElement('button');
  b.type = 'button'; b.textContent = t.short; b.title = t.name; b.dataset.id = t.id;
  b.addEventListener('click', () => goTown(t));
  li.appendChild(b); townsUl.appendChild(li);
}
wholeBtn.addEventListener('click', goWhole);
const panel = document.getElementById('panel'), toggle = document.getElementById('towns-toggle');
function foldPanel(fold) { if (!matchMedia('(max-width: 640px)').matches) return; panel.classList.toggle('folded', fold); toggle.setAttribute('aria-expanded', String(!fold)); }
toggle.addEventListener('click', () => foldPanel(!panel.classList.contains('folded')));
foldPanel(true);

// ── Rockland Breakwater (the town file leaves it out; the helm view models it the same way) ──
{
  const [[lo0, la0], [lo1, la1]] = [[-69.08197, 44.11540], [-69.07751, 44.10410]];
  const ax = wx(lo0), az = wz(la0), bx = wx(lo1), bz = wz(la1), len = Math.hypot(bx - ax, bz - az);
  const bw = new THREE.Mesh(new THREE.BoxGeometry(7, 9, len), new THREE.MeshLambertMaterial({ color: 0x8d877f }));
  bw.position.set((ax + bx) / 2, -0.5, (az + bz) / 2); bw.rotation.y = Math.atan2(bx - ax, bz - az); scene.add(bw);
}

// ── Buoys and lighthouses from the chart: instanced, drawn larger the farther off they are ──
const [navGJ, placesGJ] = await Promise.all([
  getJSON('./data/regions/penobscot-bay/navaid.geojson').catch(() => ({ features: [] })),
  getJSON('./data/regions/penobscot-bay/named_places.geojson').catch(() => ({ features: [] })),
]);
const inBay = ([x, y]) => x >= OW && x <= OE && y >= OS && y <= ON;
const navs = navGJ.features.filter(f => f.geometry?.type === 'Point' && inBay(f.geometry.coordinates));
const BUOY_T = ['BOYLAT', 'BCNLAT', 'BOYSAW', 'BOYSPP', 'BOYCAR', 'BOYISD'];
const buoys = navs.filter(f => BUOY_T.includes(f.properties.objtype)).map(f => ({ x: wx(f.geometry.coordinates[0]), z: wz(f.geometry.coordinates[1]), c: (f.properties.colour || '').split('/')[0], num: (f.properties.name || '').match(/(\S{1,3})$/)?.[1] || '' }));
const lightsAshore = navs.filter(f => f.properties.objtype === 'LIGHTS').filter(f => !buoys.some(b => Math.hypot(b.x - wx(f.geometry.coordinates[0]), b.z - wz(f.geometry.coordinates[1])) < 40))
  .map(f => ({ x: wx(f.geometry.coordinates[0]), z: wz(f.geometry.coordinates[1]), y: Math.max(0, heightAt(...f.geometry.coordinates)) }));
const BUOY_COL = { red: 0xc23a2e, green: 0x2b8a4a, yellow: 0xe0b531 };
const buoySets = Object.entries({ red: 0, green: 0, yellow: 0, other: 0 }).map(([k]) => {
  const list = buoys.filter(b => (BUOY_COL[b.c] ? b.c : 'other') === k);
  const geo = new THREE.CylinderGeometry(0.7, 0.7, 2.2, 10); geo.translate(0, 1.1, 0);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: BUOY_COL[k] ?? 0xdddddd }), Math.max(1, list.length));
  mesh.count = list.length; mesh.frustumCulled = false; scene.add(mesh);
  return { list, mesh };
});
const towerGeo = new THREE.CylinderGeometry(1.0, 1.6, 10, 12); towerGeo.translate(0, 5, 0);
const towers = new THREE.InstancedMesh(towerGeo, new THREE.MeshLambertMaterial({ color: 0xf0eee6 }), Math.max(1, lightsAshore.length));
towers.count = lightsAshore.length; towers.frustumCulled = false; scene.add(towers);
const m4 = new THREE.Matrix4();
function updateMarks() {   // scale with distance from the camera so they stay visible from up high
  const cp = camera.position, show = view.dist < 22000;
  for (const { list, mesh } of buoySets) {
    mesh.visible = show && list.length > 0;
    if (!mesh.visible) continue;
    list.forEach((b, i) => { const s = clamp(Math.hypot(b.x - cp.x, cp.y, b.z - cp.z) / 700, 1, 25); mesh.setMatrixAt(i, m4.makeScale(s, s, s).setPosition(b.x, 0, b.z)); });
    mesh.instanceMatrix.needsUpdate = true;
  }
  lightsAshore.forEach((l, i) => { const s = clamp(Math.hypot(l.x - cp.x, cp.y, l.z - cp.z) / 1500, 1, 12); towers.setMatrixAt(i, m4.makeScale(s, s, s).setPosition(l.x, l.y, l.z)); });
  towers.instanceMatrix.needsUpdate = true;
}

// ── Water, sky, clouds (as in the helm view, sized for the whole bay) ──
function rippleNormals(size = 256) {
  const hgt = new Float32Array(size * size), data = new Uint8Array(size * size * 4);
  let sd = 11; const rr = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const waves = Array.from({ length: 160 }, () => { const k = 2 + rr() * 22, th = rr() * Math.PI * 2; return { kx: Math.round(Math.cos(th) * k), ky: Math.round(Math.sin(th) * k), a: Math.pow(k, -1.4) * (0.6 + rr() * 0.8), p: rr() * 6.283 }; });
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { let v = 0; for (const wv of waves) v += wv.a * Math.sin(2 * Math.PI * (wv.kx * x + wv.ky * y) / size + wv.p); hgt[y * size + x] = v; }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = hgt[y * size + (x + 1) % size] - hgt[y * size + (x - 1 + size) % size], dy = hgt[((y + 1) % size) * size + x] - hgt[((y - 1 + size) % size) * size + x];
    const n = new THREE.Vector3(-dx * 0.65, -dy * 0.65, 1).normalize(), o = (y * size + x) * 4;
    data[o] = (n.x * 0.5 + 0.5) * 255; data[o + 1] = (n.y * 0.5 + 0.5) * 255; data[o + 2] = (n.z * 0.5 + 0.5) * 255; data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; return t;
}
const water = new Water(new THREE.PlaneGeometry(400000, 400000), {
  textureWidth: 512, textureHeight: 512, waterNormals: rippleNormals(),
  sunDirection: sun.clone().normalize(), sunColor: 0xfff4e0, waterColor: 0x1f3c48, distortionScale: 1.2, fog: true,
});
water.rotation.x = -Math.PI / 2; water.material.uniforms.size.value = 6;
water.material.fragmentShader = water.material.fragmentShader.replace('float rf0 = 0.3;', 'float rf0 = 0.02;').replace('reflectionSample * 0.9 +', 'reflectionSample * 0.78 +');
water.material.needsUpdate = true;
scene.add(water);
const sky = new THREE.Mesh(new THREE.SphereGeometry(150000, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
  uniforms: { zenith: { value: new THREE.Color(0x2f62a8) }, horizon: { value: HAZE.clone() }, sunDir: { value: sun.clone().normalize() } },
  vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
    void main() { float h = max(vDir.y, 0.0); vec3 c = mix(horizon, zenith, pow(h, 0.55)); float g = max(dot(normalize(vDir), sunDir), 0.0);
      c += vec3(1.0, 0.95, 0.85) * (pow(g, 300.0) * 1.2 + pow(g, 12.0) * 0.12); gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }`,
}));
sky.renderOrder = -1; sky.frustumCulled = false; scene.add(sky);
const clouds = (() => {
  const N = 512, img = new ImageData(N, N), rand = (() => { let sd = 5; return () => (sd = (sd * 16807) % 2147483647) / 2147483647; })();
  const octaves = [8, 16, 32, 64].map(L => ({ L, g: Float32Array.from({ length: L * L }, rand) })), smooth = t => t * t * (3 - 2 * t);
  const noise = (x, y) => { let v = 0, amp = 0.5, tot = 0; for (const { L, g } of octaves) { const fx = x / N * L, fy = y / N * L, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = smooth(fx - x0), ty = smooth(fy - y0); const at = (i, j) => g[((j + L) % L) * L + ((i + L) % L)]; const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx, b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx; v += (a + (b - a) * ty) * amp; tot += amp; amp *= 0.5; } return v / tot; };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const n = noise(x, y), o = (y * N + x) * 4, a = Math.max(0, Math.min(1, (n - 0.585) / 0.09)), sh = 222 + 33 * Math.min(1, (n - 0.585) / 0.14); img.data[o] = sh; img.data[o + 1] = sh; img.data[o + 2] = Math.min(255, sh + 4); img.data[o + 3] = a * 235; }
  const cv = document.createElement('canvas'); cv.width = cv.height = N; cv.getContext('2d').putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(9, 9); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true, toneMapped: false }));
  m.rotation.x = Math.PI / 2; m.position.y = 1500; scene.add(m); return m;
})();

// ── Labels: towns (click to fly there) from up high; place names and buoy numbers lower down ──
const labelsEl = document.getElementById('labels'), pool = [];
const places = placesGJ.features.filter(f => f.geometry?.type === 'Point' && inBay(f.geometry.coordinates) && ['LNDARE', 'LNDRGN', 'BUAARE'].includes(f.properties.objtype))
  .map(f => ({ n: f.properties.name, x: wx(f.geometry.coordinates[0]), z: wz(f.geometry.coordinates[1]), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }))
  .filter(p => p.n);
for (const p of places) p.y = Math.max(4, heightAt(p.lon, p.lat));
for (const t of townList) t.y = Math.max(10, heightAt(t.lon, t.lat)) + 20;
let lblTick = 0, cand = [];
const v3 = new THREE.Vector3();
function updateLabels() {
  if (lblTick++ % 6 === 0) {
    cand = [];
    for (const t of townList) {
      const d = Math.hypot(t.x - view.x, t.z - view.z);
      if ((view.dist > 2500 || d > 3500) && d < Math.max(view.dist * 2.5, 4000)) cand.push({ text: t.short, x: t.x, y: t.y, z: t.z, cls: 'town', pri: 0, town: t });
    }
    if (view.dist < 30000) {
      const R = view.dist * 1.3;
      const near = places.map(p => ({ p, d: Math.hypot(p.x - view.x, p.z - view.z) })).filter(o => o.d < R).sort((a, b) => a.d - b.d).slice(0, 60);
      for (const { p, d } of near) cand.push({ text: p.n, x: p.x, y: p.y + 6, z: p.z, cls: '', pri: 1 + d / R });
    }
    if (view.dist < 3000) {
      for (const sset of buoySets) for (const b of sset.list) {
        const d = Math.hypot(b.x - view.x, b.z - view.z);
        if (b.num && d < 2200) cand.push({ text: `"${b.num}"`, x: b.x, y: 6, z: b.z, cls: 'buoy', pri: 3 + d / 2200 });
      }
    }
    cand.sort((a, b) => a.pri - b.pri);
  }
  const W = sceneEl.clientWidth, H = sceneEl.clientHeight, placed = [];
  let n = 0;
  for (const c of cand) {
    if (n >= 34) break;
    const p = v3.set(c.x, c.y, c.z).project(camera);
    if (p.z > 1 || Math.abs(p.x) > 1.02 || p.y > 0.98 || p.y < -1) continue;
    const x = (p.x + 1) / 2 * W, y = (1 - p.y) / 2 * H, w = c.text.length * (c.cls === 'town' ? 8.5 : 7) + 8;
    if (placed.some(r => Math.abs(r[0] - x) < (r[2] + w) / 2 && Math.abs(r[1] - y) < 17)) continue;
    placed.push([x, y, w]);
    let el = pool[n];
    if (!el) { el = document.createElement('div'); labelsEl.appendChild(el); pool[n] = el; el.addEventListener('click', () => el._town && goTown(el._town)); }
    el.className = 'lbl ' + c.cls; el.textContent = c.text; el.style.left = x + 'px'; el.style.top = y + 'px'; el.hidden = false; el._town = c.town || null;
    n++;
  }
  for (let i = n; i < pool.length; i++) pool[i].hidden = true;
}

// ── Readout: height and heading ──
const altEl = document.getElementById('alt'), needle = document.getElementById('needle');
function updateReadout() {
  const ft = camera.position.y / 0.3048;
  altEl.textContent = ft > 9000 ? `${(camera.position.y / 1852).toFixed(1)} nm up` : `${Math.round(ft / 50) * 50} ft up`;
  needle.setAttribute('transform', `rotate(${-view.az / DEG})`);
}

function resize() {
  const w = sceneEl.clientWidth, h = sceneEl.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(sceneEl); resize();

// ── Start: a town, a point from the chart, or the whole bay ──
{
  const town = townList.find(t => t.id === params.get('town'));
  const lat = Number(params.get('lat')), lon = Number(params.get('lon')), dist = Number(params.get('dist'));
  if (town) { Object.assign(view, { x: wx(WHOLE.lon), z: wz(WHOLE.lat) }); clampView(); placeCamera(); goTown(town); }
  else if (lat && lon) { Object.assign(view, { x: wx(lon), z: wz(lat), dist: dist || 20000, tilt: 45 * DEG, az: 0 }); markCurrent(null); }
  else markCurrent('whole');
}
clampView(); placeCamera();

const clock = new THREE.Clock();
let t = 0, lastCheck = -1, fpsN = 0, fpsT = performance.now(); window.__fps = 0;
function frame(now) {
  if (++fpsN === 60) { window.__fps = Math.round(60000 / (performance.now() - fpsT)); fpsN = 0; fpsT = performance.now(); }
  const dt = Math.min(0.1, clock.getDelta()); t += dt;
  stepAnim(now ?? performance.now());
  clampView(); placeCamera();
  if (t - lastCheck > 0.4) { lastCheck = t; updateTiles(); updateTowns(); updateMarks(); }
  if (!drag && !anim) updateTrees(); else if (t - (TREES.lastMove || 0) > 0.25) { TREES.lastMove = t; updateTrees(); }
  const cy = camera.position.y;
  scene.fog.density = 0.000075 * clamp(1500 / cy, 0.03, 1);   // thinner haze the higher you are
  clouds.visible = cy < 1300;
  water.position.set(view.x, 0, view.z);
  sky.position.copy(camera.position);
  water.material.uniforms.time.value += dt * 0.6;
  clouds.material.map.offset.x += dt * 0.0004; clouds.material.map.offset.y += dt * 0.00015;
  renderer.render(scene, camera);
  updateLabels(); updateReadout();
  requestAnimationFrame(frame);
}
statusEl.hidden = true;
requestAnimationFrame(frame);
window.__bay3d = {   // for AudioChart (returning to the chart where you were) and for testing
  getView: () => ({ lat: latOf(view.z), lon: lonOf(view.x), dist: view.dist, az: view.az / DEG, tilt: view.tilt / DEG }),
  setView: v => { anim = null; Object.assign(view, { x: wx(v.lon), z: wz(v.lat), dist: v.dist ?? view.dist, az: (v.az ?? view.az / DEG) * DEG, tilt: (v.tilt ?? view.tilt / DEG) * DEG }); clampView(); placeCamera(); },
  goTown: id => { const tw = townList.find(x => x.id === id); if (tw) goTown(tw); return !!tw; },
  goWhole, towns: townList, tiles, scene, renderer, trees: () => ({ near: TREES.near.count, far: TREES.far.count, K: TREES.K }),
};
}
main().catch(err => { console.error(err); fail('Could not start the 3D view: ' + err.message); });
