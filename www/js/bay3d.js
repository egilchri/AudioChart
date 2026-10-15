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
import { LON0, LAT0, MX, MY, wx, wz, readDem, photo, addCanopy, gridMesh, photoMat, buildTown, disposeGroup, spruce, TOWN_NIGHT } from './terrain3d.js';
import { SUN, makeSky, makeEnv, glowSprite, flashFor, flashOn, weatherPanel, startConditions, makeTrimmer, cycleLook } from './weather3d.js';
import { makeSailboat, fleetType } from './sailboat3d.js';
import { makeAngelique } from './angelique3d.js';
import { makeWildlife, ledgesFrom } from './wildlife3d.js';

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
const sun = SUN;
const hemi = new THREE.HemisphereLight(0xe4ecf2, 0x4a5644, 1.7); scene.add(hemi);
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
  if (follow) { anim.to.x = follow.x; anim.to.z = follow.z; }   // she keeps sailing while we fly there
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
  stopFollow();
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
let treesDirty = false, treeFogCut = -Infinity;   // above a fog bank, trees standing in it are hidden (v871)
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
        if (A[i + 9] > keep || A[i + 1] < treeFogCut) continue;
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
  const dist = 1100, tilt = 71 * DEG, back = dist * Math.sin(tilt);
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
  current = id; stopFollow();
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
const [navGJ, placesGJ, landGJ] = await Promise.all([
  getJSON('./data/regions/penobscot-bay/navaid.geojson').catch(() => ({ features: [] })),
  getJSON('./data/regions/penobscot-bay/named_places.geojson').catch(() => ({ features: [] })),
  getJSON('./data/landmarks.json').catch(() => ({ landmarks: [] })),
]);
const inBay = ([x, y]) => x >= OW && x <= OE && y >= OS && y <= ON;
const navs = navGJ.features.filter(f => f.geometry?.type === 'Point' && inBay(f.geometry.coordinates));
const BUOY_T = ['BOYLAT', 'BCNLAT', 'BOYSAW', 'BOYSPP', 'BOYCAR', 'BOYISD'];
const buoys = navs.filter(f => BUOY_T.includes(f.properties.objtype)).map(f => ({ x: wx(f.geometry.coordinates[0]), z: wz(f.geometry.coordinates[1]), c: (f.properties.colour || '').split('/')[0], num: ((f.properties.name || '').replace(/"/g, '').match(/(\S{1,3})$/)?.[1] || '').replace(/^(?!.*\d).*$/, '') }));
// every charted light, for the night: a glow that flashes its own characteristic
const litNavs = navs.filter(f => f.properties.objtype === 'LIGHTS').map(f => ({ x: wx(f.geometry.coordinates[0]), z: wz(f.geometry.coordinates[1]), fl: flashFor(f.properties.characteristic), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
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
  sunDirection: sun.clone().normalize(), sunColor: 0xfff4e0, waterColor: 0x3268a0, distortionScale: 1.2, fog: true,
});
water.rotation.x = -Math.PI / 2; water.material.uniforms.size.value = 6;
water.material.fragmentShader = water.material.fragmentShader.replace('float rf0 = 0.3;', 'float rf0 = 0.04;').replace('reflectionSample * 0.9 +', 'reflectionSample * 0.78 +');
water.material.needsUpdate = true;
scene.add(water);
const sky = makeSky(150000); scene.add(sky);
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

// ── Weather (v860, direct request): the helm view's conditions (weather3d.js), seen from above.
// Fog from up here is a white blanket on the water with the hills standing out of it, until you
// come down into it; a cloud deck hides the sky only from below it; at dusk, at night and in fog
// the lights come out: the charted lights flash, and the towns' windows light up.
const env = makeEnv({ renderer, scene, hemi, dl, sky, water, clouds, starsR: 140000, deckSize: 300000, deckY: 1800, foamR: 1400, foamTile: 24 });
const blanket = (() => {   // the top of a fog bank: a flat layer, with a lumpy cloud-textured skin just over it
  const g = new THREE.Group();
  const flat = new THREE.Mesh(new THREE.PlaneGeometry(300000, 300000), new THREE.MeshBasicMaterial({ color: 0xbcc5cc, transparent: true, opacity: 0.97, fog: true, toneMapped: false }));
  flat.rotation.x = -Math.PI / 2; g.add(flat);
  const tex = clouds.material.map.clone(); tex.needsUpdate = true; tex.repeat.set(36, 36); tex.rotation = 0.6;
  const skin = new THREE.Mesh(new THREE.PlaneGeometry(300000, 300000), new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false, fog: true, toneMapped: false }));
  skin.rotation.x = -Math.PI / 2; skin.position.y = 6; g.add(skin);
  g.visible = false; scene.add(g);
  return { g, flat, skin };
})();
const FOG_TOP = { fog: 70, thick: 110 };
const glows = litNavs.filter(l => l.fl).map(l => {
  const ashore = lightsAshore.some(a => Math.hypot(a.x - l.x, a.z - l.z) < 5);
  const sp = glowSprite(l.fl.col, ashore ? 0.016 : 0.01);
  sp.position.set(l.x, ashore ? Math.max(0, heightAt(l.lon, l.lat)) + 12 : 3, l.z); scene.add(sp);
  return { sp, fl: l.fl, phase: Math.random() * 6, range: (ashore ? 9 : 3.5) * 1852 };
});
let wxPanel = null, aboveFog = null;
function applyConditions(next = {}) {
  env.apply(next);
  TOWN_NIGHT.value = env.lightsK;
  blanket.flat.material.color.copy(env.fogC); blanket.skin.material.color.copy(env.fogC).lerp(new THREE.Color(0xffffff), env.night ? 0.05 : 0.35);
  aboveFog = null;   // re-decide the sky in the next frame
  wxPanel?.sync(env.C, env.W);
}
const _sky = { zen: new THREE.Color(), hor: new THREE.Color() };
function updateWeather(dt, t) {
  const cy = camera.position.y, top = FOG_TOP[env.C.vis];
  // fog: from above its top, the blanket and the sky above it; inside it, the scene fog
  const above = env.foggy && cy > top + 40;
  if (above !== aboveFog) {
    aboveFog = above;
    treeFogCut = above ? top - 4 : -Infinity; treesDirty = true;
    blanket.g.visible = above;
    const su = sky.material.uniforms, T = env.T;
    if (above) {   // the sky over the fog bank: the time of day's own (or the overcast) sky
      _sky.zen.set(env.over ? T.over : T.zen); _sky.hor.set(env.over ? T.fog : T.haze);
      su.zenith.value.copy(_sky.zen); su.horizon.value.copy(_sky.hor); scene.fog.color.copy(_sky.hor);
      su.sunCol.value.fromArray(env.over ? [0, 0, 0] : T.glow); su.moonK.value = env.night && !env.over ? 1 : 0;
      env.stars.visible = env.night && !env.over;
    } else env.apply({});   // back to the conditions as they are at sea level
  }
  if (above) blanket.g.position.set(camera.position.x, top, camera.position.z);
  const base = above ? 0.000075 : 1.98 / env.visM;
  scene.fog.density = env.foggy && !above ? base : base * clamp(1500 / cy, 0.03, 1);   // thinner haze the higher you are
  clouds.visible = env.cloudsOn && cy < 1300;
  env.deck.visible = env.deckOn && cy < 1700;
  env.rain.visible = env.rainOn && cy < 1500;
  env.foam.visible = env.foamOn && view.dist < 15000 && !above;
  env.update(dt, camera, { x: view.x, z: view.z }, clamp(view.dist / 400, 1, 20), Math.max(0.06, view.dist * 0.0004));   // lifted a little from up high, clear of the water's depth
  env.stars.position.copy(camera.position);
  // the lights
  const lk = Math.min(1, env.lightsK * 1.4);
  for (const g of glows) {
    if (!lk) { g.sp.visible = false; continue; }
    const d = Math.hypot(g.sp.position.x - camera.position.x, g.sp.position.z - camera.position.z), k = Math.min(1, 1.25 - d / (Math.min(g.range, env.visM * 1.6) + cy)) * lk;
    g.sp.visible = k > 0 && flashOn(g.fl, t + g.phase) && !(above && g.sp.position.y < top);
    if (g.sp.visible) g.sp.material.opacity = k;
  }
}

// ── A fleet of sailboats (v870, requested: the helm view's sail trim, seen from the air) ──
// Forty boats on open water, each sailing short legs round its own patch of the bay and trimmed
// to the Weather panel's wind (weather3d.js's makeTrimmer): they never point inside 45° of the
// wind, tack and gybe as they turn, heel to leeward, and stop with sails furled in a calm. Close up
// they sail at a real 5 kn; from higher up time runs faster (up to 20×) so you can see them move.
// Like the buoys, they're drawn bigger the farther off you are.
const FLEET_N = 40, BOAT_KN = 5, NMm = 1852;
// drawn bigger the farther off, as the buoys are; a big boat needs less of it, so a windjammer stays
// bigger than a daysailer at any range without becoming an island from the heights (v905)
const boatScale = (boat, d) => Math.max(1.6, clamp(d / 250, 1.6, 90) * Math.sqrt(8 / boat.L));
const isWater = (x, z) => heightAt(lonOf(x), latOf(z)) <= 0.3;
const clearLeg = (x, z, h, len) => { const a = h * DEG; for (let d = 120; d <= len + 200; d += 120) if (!isWater(x + Math.sin(a) * d, z - Math.cos(a) * d)) return false; return true; };
const fleet = [];
{
  let sd = 20261012; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const [BW, BS, BE, BN] = BAY;
  for (let tries = 0; fleet.length < FLEET_N && tries < 6000; tries++) {
    const x = wx(BW + rnd() * (BE - BW)), z = wz(BS + rnd() * (BN - BS));
    if (fleet.some(b => Math.hypot(b.home.x - x, b.home.z - z) < 1.6 * NMm)) continue;
    let ok = isWater(x, z);
    for (let k = 0; ok && k < 8; k++) ok = isWater(x + Math.sin(k * Math.PI / 4) * 0.45 * NMm, z - Math.cos(k * Math.PI / 4) * 0.45 * NMm);
    if (!ok) continue;
    const boat = makeSailboat(fleetType(rnd), fleet.length);   // a mixed fleet (v905)
    scene.add(boat.group);
    fleet.push({ boat, home: { x, z }, x, z, h: rnd() * 360, want: null, left: 0, trim: makeTrimmer(), rnd });
  }
}
function pickLeg(b) {
  const wf = env.C.windFrom, calm = env.W.heel === 0, away = Math.hypot(b.x - b.home.x, b.z - b.home.z);
  const homeBrg = Math.atan2(b.home.x - b.x, -(b.home.z - b.z)) / DEG;
  for (let i = 0; i < 30; i++) {
    const h = (b.rnd() * 360), twa = Math.abs(((wf - h + 540) % 360) - 180), len = (0.25 + b.rnd() * 0.3) * NMm;
    if (!calm && !b.boat.power && twa < 45) continue;   // a powerboat goes any way she likes
    if (away > 0.45 * NMm && Math.cos((h - homeBrg) * DEG) < 0.3) continue;   // head back toward home
    if (!clearLeg(b.x, b.z, h, len)) continue;
    b.want = h; b.left = len; return;
  }
  b.want = homeBrg; b.left = 300;   // nothing better: back toward open water at home
}
// ⛵ Follow a sailboat (v871): the boats are small and spread over the bay, so this flies to the
// one nearest the middle of the view (the next one along on each click) and keeps it centred,
// seen from off its quarter, until you drag or zoom.
let follow = null;
function followBoat() {
  if (!fleet.length) return;
  const order = fleet.map(b => ({ b, d: Math.hypot(b.x - view.x, b.z - view.z) })).sort((p, q) => p.d - q.d).map(o => o.b);
  const b = follow ? fleet[(fleet.indexOf(follow) + 1) % fleet.length] : order[0];
  markCurrent(null); document.getElementById('sailboat').classList.add('on'); foldPanel(true);
  if (aboveFog || env.foggy) applyConditions({ vis: 'clear' });   // in fog you'd never find her
  if (env.W.heel === 0) applyConditions({ wind: 'breezy' });       // and in a calm she isn't sailing
  follow = b;
  flyTo({ x: b.x, z: b.z, dist: 150, tilt: 62 * DEG, az: (b.h + 35) * DEG }, 3000);
}
document.getElementById('sailboat').addEventListener('click', followBoat);
function stopFollow() { if (!follow) return; follow = null; document.getElementById('sailboat').classList.remove('on'); }

function updateFleet(dt) {
  const up = env.W.heel > 0, heel = env.W.heel * DEG, cp = camera.position, show = !aboveFog;
  const FLEET_K = clamp(view.dist / 150, 1, 20);
  for (const b of fleet) {
    b.boat.group.visible = show;
    const go = up || b.boat.power, kn = b.boat.kn || BOAT_KN;   // a lobster boat works in a calm too
    if (b.want == null || b.left <= 0) pickLeg(b);
    const twa = Math.abs(((env.C.windFrom - b.want + 540) % 360) - 180);
    if (up && !b.boat.power && twa < 40) pickLeg(b);   // the wind shifted onto her bow: bear away onto a new leg
    if (go) {
      const turn = ((b.want - b.h + 540) % 360) - 180, step = 25 * dt * FLEET_K / 6;
      b.h = (b.h + clamp(turn, -step, step) + 360) % 360;
      const v = kn * NMm / 3600 * FLEET_K * dt, a = b.h * DEG;
      b.x += Math.sin(a) * v; b.z -= Math.cos(a) * v; b.left -= v;
    }
    const p = b.trim(env.C.windFrom, b.h, env.W.tws ?? 8, up ? kn : 0, dt * FLEET_K / 4);
    b.boat.trim(p, heel, up);
    b.boat.wake(go ? Math.min(1, kn / 8) : 0);
    b.boat.group.scale.setScalar(boatScale(b.boat, Math.hypot(b.x - cp.x, cp.y, b.z - cp.z)));   // never smaller than 1.6×: the closest you can come is ~120 m
    b.boat.group.position.set(b.x, 0, b.z);
    b.boat.group.rotation.y = -b.h * DEG;
  }
}

// ── Seagulls and seals (v888, requested; wildlife3d.js), round where you're looking ──
const wildlife = makeWildlife({ scene });
getJSON('./data/regions/penobscot-bay/hazards.geojson').then(fc => wildlife.setLedges(ledgesFrom(fc, wx, wz))).catch(() => {});

// ── Route waypoints (v873, requested: as in the helm view) ──
// Pick a saved route or a sample under "Route waypoints" (opened from the chart, the route the
// chart is showing comes preselected): a marker on a pole at each waypoint (green; amber ☾ for an
// overnight stop, red ⚓ at the end), drawn bigger with distance, the route as a line on the water,
// "WP n" labels, and the view flies to fit it. The choice is remembered.
const WPR_KEY = 'audiochart-bay3d-route';
const wpSel = document.getElementById('wproute');
const routeChoices = [];
{
  let saved = []; try { saved = JSON.parse(localStorage.getItem('audiochart-user-routes') || '[]'); } catch (_) {}
  // opened mid-edit (v879): the route being edited, with its unsaved changes, comes first
  if (params.get('route') === 'editing') {
    try { const e = JSON.parse(localStorage.getItem('audiochart-bay3d-editing') || 'null'); if (e?.points?.length) routeChoices.push({ id: 'editing', name: `${e.name} (editing)`, points: e.points }); } catch (_) {}
  }
  saved.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).forEach(r => routeChoices.push({ id: r.id || r.name, name: r.name, points: r.points }));
  const samples = await getJSON('./data/regions/penobscot-bay/curated_routes.json').catch(() => []);
  for (const r of samples) if (!routeChoices.some(c => c.name === r.name)) routeChoices.push({ id: 'sample:' + r.id, name: r.name + ' (sample)', points: r.points });
  for (const c of routeChoices) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; wpSel.appendChild(o); }
}
const wpGroup = new THREE.Group(); scene.add(wpGroup);
let wps = [], routeFlew = false, followOwnAtStart = false;
function showRoute(id, fly) {
  for (const o of [...wpGroup.children]) { wpGroup.remove(o); o.traverse(m => { m.geometry?.dispose(); }); }
  wps = [];
  const r = routeChoices.find(c => c.id === id);
  wpSel.value = r ? id : '';
  if (id !== 'editing') try { localStorage.setItem(WPR_KEY, r ? id : ''); } catch (_) {}
  if (!r) { setOwnRoute(null); return; }
  const pts = r.points.map(p => Array.isArray(p) ? { lon: p[0], lat: p[1] } : p);
  pts.forEach((p, i) => {
    const last = i === pts.length - 1, night = !!p.overnight, col = last ? 0xd0342c : night ? 0xe0a843 : 0x2fa35a;
    const g = new THREE.Group(); g.position.set(wx(p.lon), 0, wz(p.lat));
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6), new THREE.MeshLambertMaterial({ color: 0xf2f2ee })); pole.position.y = 1.6; g.add(pole);
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.55), new THREE.MeshLambertMaterial({ color: col, emissive: col, emissiveIntensity: 0.35 })); gem.position.y = 3.6; gem.scale.y = 1.4; g.add(gem);
    wpGroup.add(g);
    wps.push({ g, label: `WP ${i + 1}` + (night ? ' ☾' : last ? ' ⚓' : '') });
  });
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(wx(p.lon), 1.5, wz(p.lat)))), new THREE.LineBasicMaterial({ color: 0xe0a843 }));
  wpGroup.add(line);
  setOwnRoute(r, pts);
  if (fly) {
    const xs = pts.map(p => wx(p.lon)), zs = pts.map(p => wz(p.lat));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    markCurrent(null);
    flyTo({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, dist: clamp(Math.max(x1 - x0, z1 - z0) * 1.5, 2500, 90000), tilt: 45 * DEG, az: 0 }, 2800);
  }
}
function updateWaypoints() {
  const cp = camera.position;
  for (const p of wps) p.g.scale.setScalar(clamp(Math.hypot(p.g.position.x - cp.x, cp.y, p.g.position.z - cp.z) / 150, 1, 80));
  wpGroup.visible = !aboveFog;
}
// ── Your boat underway (v874, requested): a sloop sailing the chosen route, trimmed to the wind
// like the fleet. ▶ Sail it plays it at a pace (your boat's speed from AudioChart's settings,
// times 1–200) with the view following her; drag to look elsewhere. While a Virtual Journey of
// the same route runs in AudioChart, she follows the journey instead (it broadcasts progress).
const OWN_KN = (() => { let v = NaN; try { v = parseFloat(localStorage.getItem('audiochart-last-speed')); } catch (_) {} return v > 0 && v < 40 ? v : 5; })();
const PACE_KEY = 'audiochart-bay3d-pace';
// your boat: the Cape Dory 25D, or Angelique if that's your choice in the helm view (v905, same key)
const OWN_TYPE = (() => { let b = params.get('boat'); if (!b) { try { b = localStorage.getItem('audiochart-boat'); } catch (_) {} } return b === 'angelique' ? 'angelique' : 'cd25'; })();
const own = { boat: OWN_TYPE === 'angelique' ? makeAngelique() : makeSailboat(OWN_TYPE, 4), trim: makeTrimmer(), r: null, pts: [], cum: [0], nights: [], total: 0, S: 0, playing: false, vj: null, x: 0, z: 0, h: 0 };
own.boat.group.visible = false; scene.add(own.boat.group);
const sailRow = document.getElementById('sailrow'), sailBtn = document.getElementById('sailit'), paceSel = document.getElementById('sailpace'), sailNote = document.getElementById('sailnote');
for (const k of [1, 5, 20, 60, 200]) { const o = document.createElement('option'); o.value = k; o.textContent = k === 1 ? `${OWN_KN} kn real time` : `${OWN_KN} kn × ${k}`; paceSel.appendChild(o); }
try { paceSel.value = localStorage.getItem(PACE_KEY) || '60'; } catch (_) { paceSel.value = '60'; }
if (!paceSel.value) paceSel.value = '60';
paceSel.addEventListener('change', () => { try { localStorage.setItem(PACE_KEY, paceSel.value); } catch (_) {} });
function setOwnRoute(r, pts) {
  own.r = r; own.playing = false; own.S = 0; sailBtn.textContent = '▶ Sail it';
  sailRow.hidden = !r; sailNote.hidden = !r; followBtn.hidden = !r; own.boat.group.visible = !!r;
  if (!r) return;
  own.pts = pts.map(p => [wx(p.lon), wz(p.lat)]);
  own.cum = [0]; for (let i = 1; i < own.pts.length; i++) own.cum.push(own.cum[i - 1] + Math.hypot(own.pts[i][0] - own.pts[i - 1][0], own.pts[i][1] - own.pts[i - 1][1]));
  own.total = own.cum[own.cum.length - 1];
  own.nights = pts.map((p, i) => p.overnight && i < pts.length - 1 ? own.cum[i] : null).filter(v => v != null);   // where each day ends (v876)
  placeOwn(0);
}
function ownPosAt(s) {
  s = clamp(s, 0, own.total);
  let i = 1; while (i < own.cum.length - 1 && own.cum[i] < s) i++;
  const t = (s - own.cum[i - 1]) / ((own.cum[i] - own.cum[i - 1]) || 1), a = own.pts[i - 1], b = own.pts[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
function placeOwn(dt) {
  const [x, z] = ownPosAt(own.S), s2 = Math.min(own.S, own.total - 300);
  const a = ownPosAt(s2 - 60), b = ownPosAt(s2 + 300), want = (Math.atan2(b[0] - a[0], -(b[1] - a[1])) / DEG + 360) % 360;
  own.h = dt ? (own.h + clamp((((want - own.h) + 540) % 360) - 180, -90 * dt, 90 * dt) + 360) % 360 : want;
  own.x = x; own.z = z;
}
sailBtn.addEventListener('click', () => {
  if (!own.r || own.vj) return;
  if (own.S >= own.total) own.S = 0;
  own.playing = !own.playing; sailBtn.textContent = own.playing ? '❚❚ Pause' : '▶ Sail it';
  if (own.playing) {
    if (env.W.heel === 0) applyConditions({ wind: 'breezy' });   // she can't sail in a calm
    markCurrent(null); follow = own; document.getElementById('sailboat').classList.remove('on');
    // high enough to see her among the islands and coastline around her (v876; was 450 m)
    if (view.dist < 1500 || view.dist > 20000) flyTo({ x: own.x, z: own.z, dist: 6000, tilt: 50 * DEG, az: 0 }, 2500);
  }
});
// ⌖ Follow (v876): keep your boat centred, at whatever height and heading you've set; panning or
// dragging lets go, this picks her up again.
const followBtn = document.getElementById('followown');
function followOwn() {
  markCurrent(null); follow = own;
  if (view.dist > 20000) flyTo({ x: own.x, z: own.z, dist: 6000, tilt: 50 * DEG, az: view.az }, 2200);
}
followBtn.addEventListener('click', () => {
  if (!own.r) return;
  if (follow === own) { stopFollow(); return; }
  followOwn();
});
// Inside the chart (embed; v876, then v880 on request: "minimize the change in interface"), this
// view has no controls of its own: the chart's compass rose, zoom and pan drive it, and your boat
// is the chart's boat (own.ext, set by AudioChart through __bay3d.setBoat), so the chart's own
// Play (a Virtual Journey, or Animate) sails her and its ⊙ follows her. The panel stays hidden.
function updateOwn(dt) {
  const pace = Number(paceSel.value) || 60;
  let up, kn = OWN_KN;
  if (own.ext) {   // the chart's boat
    const e = own.ext;
    own.x = e.x; own.z = e.z;
    own.h = dt ? (own.h + clamp((((e.h - own.h) + 540) % 360) - 180, -90 * dt, 90 * dt) + 360) % 360 : e.h;
    up = env.W.heel > 0 && e.moving; kn = e.kn > 0 ? e.kn : OWN_KN;
  } else {
    if (!own.r) return;
    if (own.vj) own.S = own.vj.frac * own.total;
    else if (own.playing) {
      own.S += OWN_KN * NMm / 3600 * pace * dt;
      if (own.S >= own.total) { own.S = own.total; own.playing = false; sailBtn.textContent = '▶ Sail it'; }
    }
    placeOwn(own.playing || own.vj ? dt : 0);
    up = env.W.heel > 0 && own.S < own.total;
  }
  const p = own.trim(env.C.windFrom, own.h, env.W.tws ?? 8, up ? kn : 0, dt * Math.min(pace, 8));
  own.boat.trim(p, env.W.heel * DEG, up);
  own.boat.wake(up ? Math.min(1, kn / 8) : 0);
  const cp = camera.position;
  own.boat.group.scale.setScalar(boatScale(own.boat, Math.hypot(own.x - cp.x, cp.y, own.z - cp.z)));
  own.boat.group.position.set(own.x, 0, own.z); own.boat.group.rotation.y = -own.h * DEG;
  own.boat.group.visible = !aboveFog;
  followBtn.classList.toggle('on', follow === own);
  const day = own.nights.length ? `Day ${1 + own.nights.filter(c => own.S >= c - 1).length} of ${own.nights.length + 1} · ` : '';
  if (!own.ext && lblTick % 6 === 0) sailNote.textContent = (own.vj ? 'Following your Virtual Journey · ' : '') + day + `${(own.S / NMm).toFixed(1)} / ${(own.total / NMm).toFixed(1)} nm` + (up ? ` · ${p.name}` : env.W.heel === 0 ? ' · calm' : ' · arrived');
}
// an overnight stop on a Virtual Journey (v887): sunset, night, dawn and day again over its few seconds
let night = null, nightSeen = 0;
function updateNight() {
  if (!night) return;
  const u = (Date.now() - night.start) / night.dur;
  if (u >= 1) { night = null; applyConditions({ time: 'day' }); return; }
  const L = cycleLook(night.from, u); env.blendT = L.T; applyConditions({ time: L.time }); env.blendT = null;
}
try {   // a Virtual Journey of this route running in AudioChart
  const ch = new BroadcastChannel('audiochart-vj');
  ch.onmessage = e => {
    const m = e.data || {};
    if (m.cycle && m.cycle.start !== nightSeen) { nightSeen = m.cycle.start; night = { ...m.cycle, from: env.C.time }; }   // an overnight stop (v887)
    if (own.ext) return;   // inside the chart, the chart's boat already is the journey
    if (!own.r || (m.routeId !== own.r.id && 'sample:' + m.routeId !== own.r.id && m.routeId !== own.r.name)) return;
    own.vj = m.running ? { frac: clamp(m.frac, 0, 1) } : null;
    if (!m.running && m.frac >= 0.999) own.S = own.total;
    sailBtn.disabled = !!own.vj;
    if (own.vj && !follow && !drag) follow = own;
  };
  ch.postMessage({ hello: true });
} catch (_) {}

wpSel.addEventListener('change', () => { showRoute(wpSel.value, true); foldPanel(true); });
{
  let start = params.get('route') || ''; try { if (!start) start = localStorage.getItem(WPR_KEY) || ''; } catch (_) {}
  if (start && !routeChoices.some(c => c.id === start)) start = routeChoices.find(c => c.id === 'sample:' + start)?.id || '';
  routeFlew = !!start && !!params.get('route') && !params.get('lat');
  showRoute(start, routeFlew);
  // from the helm view's Bird's-eye button (v875): your boat where she was, still sailing if she was
  if (own.r && params.get('at')) {
    own.S = clamp(Number(params.get('at')) || 0, 0, 1) * own.total; placeOwn(0); followOwnAtStart = true;
    if ([...paceSel.options].some(o => o.value === params.get('pace'))) paceSel.value = params.get('pace');
    if (params.get('play') === '1') { own.playing = true; sailBtn.textContent = '❚❚ Pause'; }
  }
}

// double-click your boat (v896, requested): AudioChart's boat menu (Free sail, Autoroute, …)
{
  let hook = null; try { if (window.parent !== window) hook = window.parent.__audioChartViews; } catch (_) {}
  if (hook?.boatMenu) {
    const pv = new THREE.Vector3();
    // on the page, not the canvas: a press captures the pointer to the scene's container, so the
    // dblclick and pointerup land there (v898); controls are left alone
    const onScene = e => !e.target.closest?.('button, input, select, textarea, a, label, .panel, #wxpanel');
    addEventListener('pointerdown', () => hook.hideBoatMenu());
    const tryMenu = (x, y) => {
      if (!own.boat.group.visible) return false;
      const r = renderer.domElement.getBoundingClientRect();
      pv.set(own.x, 6 * own.boat.group.scale.x, own.z).project(camera);
      const sx = r.left + (pv.x + 1) / 2 * r.width, sy = r.top + (1 - pv.y) / 2 * r.height;
      if (!(pv.z < 1 && Math.hypot(x - sx, y - sy) < 45)) return false;
      hook.boatMenu(window, x, y); return true;
    };
    addEventListener('dblclick', e => { if (onScene(e) && tryMenu(e.clientX, e.clientY)) e.stopImmediatePropagation(); });
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

// "⛵ Free sail" (v894): start Free Sailing from here, at the chart's boat and heading, without going
// back to the chart for the boat's menu; shown only inside AudioChart, while nothing is sailing
{
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'tofree'; b.className = 'wxbtn'; b.hidden = true;
  b.textContent = '⛵ Free sail'; b.title = 'Sail from your boat on a course and speed you set (Free Sailing)';
  document.getElementById('tohelm').before(b);
  const fs = () => { try { return window.parent !== window ? window.parent.__audioChartFreeSail : null; } catch (_) { return null; } };
  const sync = () => { const f = fs(); b.hidden = !(f && document.body.classList.contains('embed') && !f.active() && !f.busy()); };
  sync(); setInterval(sync, 1000);
  b.addEventListener('click', () => { fs()?.start(); sync(); });
}

// to another 3D view: inside AudioChart the chart loads it behind this one and fades it in (v899)
const goView = url => { try { if (window.parent !== window && window.parent.__audioChartViews?.go?.(window, url)) return; } catch (_) {} location.href = url; };
// "◀ 3D helm": back to the helm view of this route, from where your boat is now (v875). Opened from
// the chart, the same button is "🚁 Drone" (v882, requested: Drone from Bird's-eye and back): the
// helm view's Drone, at your boat's place on the route shown; its Bird's-eye button comes back here.
{
  const b = document.getElementById('tohelm'), fromHelm = params.get('from') === 'helm';
  if (!fromHelm) { b.textContent = '🚁 Drone'; b.title = 'The 3D view from just above your boat, on this route'; }
  // the helm view sails a route, so this needs one (a saved route or a sample, not an unsaved edit)
  // with no route (Free Sailing, v891) it opens the helm view's free mode at the chart's boat
  const freeBoat = () => !own.r && own.ext;
  // the same View choices as the helm view's row (v895, requested: pass between all the views):
  // Chart (inside AudioChart), Helm, 20 ft, 60 ft, Drone, and this one, Bird's-eye. The old single
  // button stays as the click target the others go through.
  b.hidden = true;
  const views = document.createElement('span'); views.id = 'views'; views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'View');
  b.before(views);
  let hook = null; try { if (window.parent !== window) hook = window.parent.__audioChartViews; } catch (_) {}
  const mk = (label, title, fn) => { const x = document.createElement('button'); x.type = 'button'; x.className = 'wxbtn'; x.textContent = label; x.title = title; x.addEventListener('click', fn); views.appendChild(x); return x; };
  if (hook) mk('🗺 Chart', 'Back to the chart', () => hook.chart());
  let goEye = 100;
  const helmBtns = [['Helm', 'Deck level, at the tiller', 6.5], ['20 ft', 'From 20 ft up', 20], ['60 ft', 'From 60 ft up', 60], ['🚁 Drone', 'From just above and astern of your boat', 100]]
    .map(([l, t, ft]) => { const x = mk(l, t, () => { goEye = ft; b.click(); }); x.dataset.eye = ft; return x; });
  const here = mk("Bird's-eye", 'This view: the whole bay from the air', () => {}); here.classList.add('on'); here.setAttribute('aria-current', 'true');
  const sync = () => {
    const can = fromHelm || (document.body.classList.contains('embed') && ((own.r && own.r.id !== 'editing') || freeBoat()));
    for (const x of helmBtns) x.hidden = !can;
    views.hidden = !hook && !can;
  };
  sync(); setInterval(sync, 1000);
  // how far along the route your boat is: the route's own progress, or the chart's boat projected onto it
  const along = () => {
    if (!own.ext) return own.S;
    let best = Infinity, S = 0;
    for (let i = 1; i < own.pts.length; i++) {
      const [ax, az] = own.pts[i - 1], [bx, bz] = own.pts[i], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      const t = clamp(((own.x - ax) * dx + (own.z - az) * dz) / L2, 0, 1), d = Math.hypot(ax + dx * t - own.x, az + dz * t - own.z);
      if (d < best) { best = d; S = own.cum[i - 1] + t * (own.cum[i] - own.cum[i - 1]); }
    }
    return S;
  };
  b.addEventListener('click', () => {
    const q = new URLSearchParams(), id = own.r?.id || params.get('route') || '';
    if (freeBoat() || (!own.r && params.get('free'))) {
      const bx = own.ext ? own.x : view.x, bz = own.ext ? own.z : view.z;   // the chart's boat, else where you're looking
      q.set('free', '1'); q.set('lat', latOf(bz).toFixed(5)); q.set('lon', lonOf(bx).toFixed(5));
      q.set('hdg', String(Math.round(own.ext?.h ?? own.h ?? 0))); q.set('kn', String(own.ext?.kn ?? 0)); q.set('eye', String(goEye));
      if (params.get('embed')) q.set('embed', '1');
      try { if (window.frameElement?.closest('#bay3d-wrap')) q.set('inchart', '1'); } catch (_) {}
      goView('./helm3d.html?' + q); return;
    }
    if (id.startsWith('sample:')) q.set('sample', id.slice(7));
    else if (routeChoices.some(c => c.id === id)) q.set('route', id);
    else q.set('sample', id);
    if (own.r) q.set('start', (along() / NMm).toFixed(3));
    q.set('pace', paceSel.value); if (own.playing) q.set('play', '1');
    q.set('eye', String(goEye));   // the View button pressed (Drone for the old single button)
    if (params.get('embed')) q.set('embed', '1');
    // inside the chart (#bay3d-wrap) the chart's toolbar sits over the top-left, so the helm view's
    // View row moves down a little there
    try { if (window.frameElement?.closest('#bay3d-wrap')) q.set('inchart', '1'); } catch (_) {}
    goView('./helm3d.html?' + q);
  });
}

// ── Labels: towns (click to fly there) from up high; place names and buoy numbers lower down ──
const labelsEl = document.getElementById('labels'), pool = [];
const places = placesGJ.features.filter(f => f.geometry?.type === 'Point' && inBay(f.geometry.coordinates) && ['LNDARE', 'LNDRGN', 'BUAARE'].includes(f.properties.objtype))
  .map(f => ({ n: f.properties.name, x: wx(f.geometry.coordinates[0]), z: wz(f.geometry.coordinates[1]), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }))
  .filter(p => p.n);
for (const l of landGJ.landmarks || []) places.push({ n: l.name, x: wx(l.lon), z: wz(l.lat), lon: l.lon, lat: l.lat, elev: l.elev_m });   // summits
for (const p of places) p.y = Math.max(4, p.elev ?? heightAt(p.lon, p.lat));
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
      const near = places.map(p => ({ p, d: Math.hypot(p.x - view.x, p.z - view.z) })).filter(o => o.d < R && !o.p.elev).sort((a, b) => a.d - b.d).slice(0, 60);
      for (const { p, d } of near) cand.push({ text: p.n, x: p.x, y: p.y + 6, z: p.z, cls: '', pri: 1 + d / R });
      for (const p of places) {   // summits: from farther off, ahead of nearer names
        if (!p.elev) continue;
        const d = Math.hypot(p.x - view.x, p.z - view.z), RS = Math.max(R, 9000);
        if (d < RS) cand.push({ text: p.n, x: p.x, y: p.y + 6, z: p.z, cls: '', pri: 0.5 + d / RS });
      }
    }
    if (view.dist < 3000) {
      for (const sset of buoySets) for (const b of sset.list) {
        const d = Math.hypot(b.x - view.x, b.z - view.z);
        if (b.num && d < 2200) cand.push({ text: `"${b.num}"`, x: b.x, y: 6, z: b.z, cls: 'buoy', pri: 3 + d / 2200 });
      }
    }
    if ((own.r || own.ext) && own.boat.group.visible) cand.push({ text: '⛵ You', x: own.x, y: 12 * own.boat.group.scale.x, z: own.z, cls: 'you', pri: -1 });
    if (view.dist < 40000) for (const p of wps) {   // route waypoints
      const d = Math.hypot(p.g.position.x - view.x, p.g.position.z - view.z);
      if (d < Math.max(view.dist * 2, 3000)) cand.push({ text: p.label, x: p.g.position.x, y: 4.6 * p.g.scale.x, z: p.g.position.z, cls: 'wpt', pri: 0.8 + d / Math.max(view.dist * 2, 3000) });
    }
    if (aboveFog) { const top = FOG_TOP[env.C.vis]; cand = cand.filter(c => c.cls === 'town' || c.y - 6 > top); }   // names under the fog bank don't show
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
  else if (lat && lon) {   // az/tilt: coming back to a view left earlier (AudioChart's Back to 3D)
    const az = Number(params.get('az')) || 0, tilt = Number(params.get('tilt')) || 45;
    Object.assign(view, { x: wx(lon), z: wz(lat), dist: dist || 20000, tilt: tilt * DEG, az: az * DEG }); markCurrent(null);
  }
  else if (!routeFlew) markCurrent('whole');
}
if (followOwnAtStart) follow = own;   // after the start view, which clears any follow
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
  water.position.set(view.x, 0, view.z);
  sky.position.copy(camera.position);
  updateNight();
  updateWeather(dt, t);
  updateFleet(dt);
  updateWaypoints();
  updateOwn(dt);
  wildlife.update(dt, t, view, camera.position, { hidden: !!aboveFog, night: env.C.time === 'night', boat: (own.ext || own.r) ? own : null, scale: d => clamp(d / 35, 3, 8) });
  if (follow && !anim) { const k = Math.min(1, dt * 4); view.x += (follow.x - view.x) * k; view.z += (follow.z - view.z) * k; }
  renderer.render(scene, camera);
  updateLabels(); updateReadout();
  requestAnimationFrame(frame);
}
// Weather panel: in the readout box, top right; the forecast is for where you're looking
wxPanel = weatherPanel({ host: document.getElementById('scale'), panelParent: document.body, where: () => [lonOf(view.x), latOf(view.z)], pick: applyConditions });
applyConditions(startConditions(params));
statusEl.hidden = true;
requestAnimationFrame(frame);
window.__bay3d = {   // for AudioChart (returning to the chart where you were) and for testing
  getView: () => ({ lat: latOf(view.z), lon: lonOf(view.x), dist: view.dist, az: view.az / DEG, tilt: view.tilt / DEG, following: follow === own }),
  // where your boat is on screen, [x, y] in this page's pixels, or null (for testing and the demo video)
  boatOnScreen: () => {
    if (!own.boat.group.visible) return null;
    const v = new THREE.Vector3(own.x, 6 * own.boat.group.scale.x, own.z).project(camera), r = renderer.domElement.getBoundingClientRect();
    return v.z < 1 ? [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height] : null;
  },
  // the chart's pan buttons and zoom slider, while this is open over it (v876): pan by a quarter of
  // the view's distance, relative to the screen (+dy = ahead in the picture); setDist keeps following
  pan: (dx, dy) => {
    stopFollow(); anim = null;
    const k = view.dist * 0.25 * Math.sin(Math.max(view.tilt, 0.3)) + view.dist * 0.1, fx = Math.sin(view.az), fz = -Math.cos(view.az);
    view.x += (Math.cos(view.az) * dx + fx * dy) * k; view.z += (Math.sin(view.az) * dx + fz * dy) * k; clampView();
  },
  // the chart's boat (v880): {lat, lon, h, kn, moving, routeId}, ~10 times a second; null hides her.
  // When she starts moving the view picks her up; the route she's on gets its waypoints.
  setBoat: b => {
    if (!b) { own.ext = null; own.boat.group.visible = !!own.r; return; }
    const first = !own.ext, h = Number.isFinite(b.h) ? b.h : own.ext?.h ?? own.h;
    own.ext = { x: wx(b.lon), z: wz(b.lat), h, kn: b.kn, moving: !!b.moving };
    if (first) own.h = h;
    if (b.routeId) {
      const c = routeChoices.find(c => c.id === b.routeId || c.id === 'sample:' + b.routeId || c.name === b.routeId);
      if (c && wpSel.value !== c.id) showRoute(c.id, false);
    }
    if (b.moving && !own.extMoving) followOwn();
    own.extMoving = !!b.moving;
  },
  followBoat: () => followOwn(),
  setDist: m => { if (anim) anim.to.dist = m; else view.dist = m; clampView(); },
  setAz: d => { anim = null; view.az = ((d % 360) + 360) % 360 * DEG; clampView(); placeCamera(); },   // the chart's compass rose, dragged round (v883)
  setTilt: d => { if (anim) anim = null; view.tilt = d * DEG; clampView(); placeCamera(); },   // the chart's tilt slider (v884)
  northUp: () => flyTo({ x: view.x, z: view.z, dist: view.dist, az: 0, tilt: view.tilt }, 900),
  setView: v => { anim = null; Object.assign(view, { x: wx(v.lon), z: wz(v.lat), dist: v.dist ?? view.dist, az: (v.az ?? view.az / DEG) * DEG, tilt: (v.tilt ?? view.tilt / DEG) * DEG }); clampView(); placeCamera(); },
  goTown: id => { const tw = townList.find(x => x.id === id); if (tw) goTown(tw); return !!tw; },
  goWhole, towns: townList, tiles, scene, env, applyConditions, fleet, own, isWater: (lat, lon) => isWater(wx(lon), wz(lat)), boatAt: i => ({ lat: latOf(fleet[i].z), lon: lonOf(fleet[i].x), h: fleet[i].h }), renderer, trees: () => ({ near: TREES.near.count, far: TREES.far.count, K: TREES.K }),
};
}
main().catch(err => { console.error(err); fail('Could not start the 3D view: ' + err.message); });
