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
import { makeWakes } from './wake3d.js';
import { REGION3D, LON0, LAT0, MX, MY, wx, wz, readDem, readTopobathy, photo, addCanopy, gridMesh, photoMat, buildTown, disposeGroup, spruce, TOWN_NIGHT } from './terrain3d.js';
import { sunPos, SUN, makeSky, makeEnv, glowSprite, flashFor, flashOn, sectorColour, weatherPanel, startConditions, makeTrimmer, cycleLook } from './weather3d.js';
import { makeSailboat, fleetType } from './sailboat3d.js';
import { makeAngelique, makeBowdoin } from './angelique3d.js';
import { makeWildlife, ledgesFrom } from './wildlife3d.js';
import { makeMoorings } from './moorings3d.js';
import { callsOn, trackOf, alongTrack, cruiseState, ferryState, ferryDepartures, ferryLine, ferrySlipModel, terminalLot, terminalHouse, cruiseShipModel, ferryModelSimple, launchModel, cblModel, mins } from './vessels.js';
import { REGIONS3D, REGION3D_KEY, regions3dOffered } from './regions3d.js';
import { setShips } from './ships3d.js';
import { identify, liveModel, knownList } from './livefleet.js';
import { BUOY_F, makeBuoyF, buoyTime, topCurrent, strongest, tideWord, compass16 } from './buoyf.js';
import { makeCurrents, layerAt } from './currents.js';
import { OBS, makeObs, windWords, wavesWords } from './obs.js';
import { GAUGES, gaugePage, makeTideGauge, predAt, trendAt, nextTurns, tideChart } from './tidegauge.js';
import { makeAisFeed, aisStatus, aisName, aisDest, setKnown, knownFor, aisFlag, aisRot, aisPos, aisAgo, aisLookup, aisImo, aisCallsign, AIS_CREDIT } from './ais.js';

const statusEl = document.getElementById('status');
const loadingEl = document.getElementById('loading');
const fail = (msg) => { statusEl.textContent = msg; statusEl.hidden = false; };
window.addEventListener('error', e => fail('Something went wrong: ' + e.message));

const params = new URLSearchParams(location.search);
if (params.get('embed')) document.body.classList.add('embed');
// Empty Bay (v928, the user's idea: "a birdseye view, zoomable, of Penobscot Bay, with no water in it"):
// NOAA's land-and-seabed surface in place of USGS's land-only one, no water, the seabed coloured by depth
// with 10 m contours and deepened by EXAG (1-10x; 100 m of depth over 40 km is all but flat at 1x), and
// nothing afloat. Land, photos, towns and trees as ever.
const EMPTY = params.has('empty');
if (EMPTY) document.body.classList.add('empty');
const EXAG_KEY = 'audiochart-emptybay-exag';
let EXAG = 4; try { EXAG = clampNum(Number(localStorage.getItem(EXAG_KEY)) || 4, 1, 10); } catch (_) {}
function clampNum(v, a, b) { return Math.max(a, Math.min(b, v)); }
const yOf = EMPTY ? (h => h < 0 ? h * EXAG : h) : null;
const demFor = (w, s, e, n, fine) => EMPTY ? readTopobathy(w, s, e, n, fine ? 0.0001 : 0.0012) : readDem(w, s, e, n, fine ? 0 : 3);
const lonOf = x => x / MX + LON0, latOf = z => -z / MY + LAT0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DEG = Math.PI / 180;

// The overview reaches past the bay so its horizon is land, not open sea; the camera's target
// stays inside the bay itself. Which bay: Penobscot, or Casco (v992; regions3d.js, its chart region RID).
const REG = REGIONS3D[REGION3D], RID = REGION3D, PENOBSCOT = RID === 'penobscot-bay';
const OVERVIEW = REG.overview;
const BAY = REG.bay;
const WHOLE = { ...REG.whole, tilt: 40 * DEG, az: 0 };
const MIN_DIST = 120, MAX_DIST = 140000;

// The bay's name on the page, and the switch between the bays (v992): another bay is a fresh page (its own world
// frame, terrain and traffic), so the switch reloads with ?region=, keeping the embed, Empty Bay and route, and
// remembers the choice for next time.
document.title = `${REG.name} 3D · AudioChart`;
{ const h1 = document.querySelector('.panel h1'); if (h1?.firstChild) h1.firstChild.textContent = REG.name; }
statusEl.textContent = `Loading ${REG.name}…`;
try { if (/bay3d\.html$/.test(location.pathname)) localStorage.setItem(REGION3D_KEY, RID); } catch (_) {}
{
  const sw = document.getElementById('bayswitch'), offered = regions3dOffered(RID);
  if (sw && offered.length > 1) {
    for (const id of offered) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = REGIONS3D[id].short; b.title = id === RID ? `Showing ${REGIONS3D[id].name}` : `Go to ${REGIONS3D[id].name}`;
      b.classList.toggle('on', id === RID); b.setAttribute('aria-pressed', String(id === RID));
      b.addEventListener('click', () => {
        if (id === RID) return;
        try { localStorage.setItem(REGION3D_KEY, id); } catch (_) {}
        const q = new URLSearchParams();
        for (const k of ['embed', 'empty', 'route', 'boat', 'ais']) if (params.has(k)) q.set(k, params.get(k));
        q.set('region', id);
        location.replace(`${location.pathname}?${q}`);
      });
      sw.appendChild(b);
    }
    if (params.get('embed')) document.body.appendChild(sw);   // (out of the panel, which the chart hides)
    sw.hidden = false;
  }
}

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
// Empty Bay's seabed: below sea level the photo gives way to a colour for the depth (wet mud and weed at the
// tide line, sand, grey-green silt, slate, dark in the deep holes), darkened along every 10 m contour.
const EXAG_U = { value: EXAG };
const WATER_MIN = -110;   // Empty Bay's water level, m: at this it's empty (the bay's deepest is about −104)
const WATER_MAX = 2;      // a little over sea level: about high water
// The slider (0-1000) is finer near the surface, where the shoals and ledges cover and uncover: the level is
// WATER_MAX less (WATER_MAX - WATER_MIN)(1 - s/1000)². Fill and Drain move the slider evenly, so the sea runs
// up the deep holes fast and slows as it spreads over the flats.
const levelAt = sv => WATER_MAX - (WATER_MAX - WATER_MIN) * (1 - sv / 1000) ** 2;
const sliderAt = lvl => 1000 * (1 - Math.sqrt(clampNum((WATER_MAX - lvl) / (WATER_MAX - WATER_MIN), 0, 1)));
let waterLevel = WATER_MIN, waterFill = 0, waterUI = () => {};   // waterFill: +1 filling, −1 draining
function stepWater(dt) {
  if (!waterFill) return;
  const top = sliderAt(0), sv = clampNum(sliderAt(waterLevel) + waterFill * top / 15 * dt, 0, top);   // empty to sea level in about 15 s
  waterLevel = levelAt(sv);
  if (sv <= 0 || sv >= top) { waterLevel = sv <= 0 ? WATER_MIN : 0; waterFill = 0; }
  waterUI();
}
function seabed(mat) {
  if (!EMPTY) return mat;
  mat.onBeforeCompile = sh => {
    sh.uniforms.uExag = EXAG_U;
    sh.vertexShader = 'varying float vElevY;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vElevY = position.y;');
    sh.fragmentShader = `uniform float uExag;
varying float vElevY;
vec3 seabedColour(float d) {
  vec3 c = mix(vec3(0.36, 0.29, 0.17), vec3(0.82, 0.74, 0.55), smoothstep(0.5, 4.0, d));   // weed and mud to sand
  c = mix(c, vec3(0.60, 0.63, 0.50), smoothstep(6.0, 18.0, d));                              // olive silt
  c = mix(c, vec3(0.42, 0.50, 0.58), smoothstep(18.0, 40.0, d));                             // blue-grey mud
  c = mix(c, vec3(0.20, 0.25, 0.38), smoothstep(40.0, 95.0, d));                             // the deep holes
  return pow(c, vec3(2.2)) * 1.15;
}
` + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
  if (vElevY < 0.0) {
    float d = -vElevY / uExag;
    diffuseColor.rgb = seabedColour(d);
    float fw = max(fwidth(d / 10.0), 1e-4), line = abs(fract(d / 10.0 + 0.5) - 0.5) / fw;
    diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.6, 1.6, line));
  }`);
  };
  mat.customProgramCacheKey = () => 'seabed';
  return mat;
}
seabed(PLAIN);

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
// riding a vessel (v919 Bowdoin's crow's nest; v937 any vessel underway, at her helm or by drone), below
const nest = { on: false, v: null, mode: 'nest', yaw: 0, pitch: -3, zoom: 1, prev: null, drag: null };
const zoomRange = () => ORBITS(nest.mode) ? [0.2, 5] : [1, 7];   // the drone closes in or stands off; the glasses magnify
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
let tap0 = null;   // a tap (down and up, hardly moved) picks a live vessel: her AIS card (v988)
sceneEl.addEventListener('pointerdown', e => {
  tap0 = pointers.size ? null : { x: e.clientX, y: e.clientY, t: performance.now() };
  if (nest.on) { sceneEl.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); nest.drag = pointers.size === 1 ? { x: e.clientX, y: e.clientY } : { pinch: pinchState(), zoom: nest.zoom }; return; }   // in the crow's nest: look round
  anim = null; sceneEl.setPointerCapture(e.pointerId);   // (following stops when you drag, not on a tap: v988)
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
  if (nest.on) {
    if (!pointers.has(e.pointerId) || !nest.drag) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (nest.drag.pinch && pointers.size >= 2) { nest.zoom = clamp(nest.drag.zoom * pinchState().d / Math.max(1, nest.drag.pinch.d), ...zoomRange()); return; }
    const k = ORBITS(nest.mode) ? 0.25 : 0.12 / nest.zoom;   // degrees a pixel: finer through the glasses
    nest.yaw = ((nest.yaw - (e.clientX - nest.drag.x) * k + 540) % 360) - 180; nest.pitch = clamp(nest.pitch + (e.clientY - nest.drag.y) * k, -60, 30);
    nest.drag.x = e.clientX; nest.drag.y = e.clientY; return;
  }
  if (!pointers.has(e.pointerId) || !drag) return;
  if (follow && (!tap0 || Math.hypot(e.clientX - tap0.x, e.clientY - tap0.y) >= 7)) stopFollow();
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
  if (tap0 && e.type === 'pointerup' && !pointers.size && Math.hypot(e.clientX - tap0.x, e.clientY - tap0.y) < 7 && performance.now() - tap0.t < 600) tapAt(e.clientX, e.clientY);
  tap0 = null;
  if (nest.on) { nest.drag = pointers.size === 1 ? (() => { const [p] = pointers.values(); return { x: p.x, y: p.y }; })() : null; return; }
  if (!pointers.size) { drag = null; sceneEl.classList.remove('dragging'); }
  else if (pointers.size === 1) { const [p] = pointers.values(); drag = { mode: 'pan', x: p.x, y: p.y, anchor: groundAt(p.x, p.y) }; }
};
sceneEl.addEventListener('pointerup', endPointer); sceneEl.addEventListener('pointercancel', endPointer);
sceneEl.addEventListener('wheel', e => {
  e.preventDefault();
  if (nest.on) { nest.zoom = clamp(nest.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002)), ...zoomRange()); return; }   // the glasses, or the drone in or out
  anim = null;
  const anchor = groundAt(e.clientX, e.clientY);
  view.dist *= Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)); clampView(); placeCamera();
  const hit = anchor && groundAt(e.clientX, e.clientY);
  if (anchor && hit) { view.x += anchor[0] - hit[0]; view.z += anchor[1] - hit[1]; clampView(); placeCamera(); }
}, { passive: false });
addEventListener('keydown', e => {
  if (e.target !== document.body) return;
  if (nest.on) {
    const k = { ArrowLeft: [-4, 0], ArrowRight: [4, 0], ArrowUp: [0, 2], ArrowDown: [0, -2] }[e.key];
    if (k) { nest.yaw = ((nest.yaw + k[0] / nest.zoom + 540) % 360) - 180; nest.pitch = clamp(nest.pitch + k[1] / nest.zoom, -60, 30); }
    else if (e.key === 'Escape') leaveRide();
    else if (e.key === 'l' || e.key === 'L') lookoutReport();
    else if (e.key === 'h' || e.key === 'H') ride(nest.v, 'helm');
    else if (e.key === 'd' || e.key === 'D') ride(nest.v, 'drone');
    else if (e.key === '+' || e.key === '=') nest.zoom = Math.min(zoomRange()[1], nest.zoom * 1.4);
    else if (e.key === '-') nest.zoom = Math.max(zoomRange()[0], nest.zoom / 1.4);
    else return;
    e.preventDefault(); return;
  }
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
statusEl.textContent = EMPTY ? `Draining ${REG.name}…` : 'Downloading the bay…';
const [OW, OS, OE, ON] = OVERVIEW;
const ovPhotoP = photo(OW, OS, OE, ON, 4000); ovPhotoP.catch(() => {});
const ov = await demFor(OW, OS, OE, ON, false);
const OV_STRIDE = ov.w * ov.h > 1.2e6 ? 2 : 1;
const OV_RECT = { west: OW, east: OE, south: OS, north: ON };
let ovMesh = gridMesh(ov, OV_RECT, OV_STRIDE, PLAIN, yOf);
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
  const m2 = gridMesh(ov, ph, OV_STRIDE, seabed(photoMat(ph, ANISO)), yOf);
  scene.remove(ovMesh); ovMesh.geometry.dispose(); ovMesh = m2; scene.add(m2);
  for (const T of tiles) if (T.state === 'ready') sinkOverview(T, true);
}).catch(err => console.warn('[bay3d] overview photo failed', err));
// Lower the overview under a loaded detail tile (and restore it when the tile goes).
function sinkOverview(T, down) {
  const pos = ovMesh.geometry.attributes.position, gidx = ovMesh.userData.gidx, inset = 0.0006;
  for (let i = 0; i < gidx.length; i++) {
    const gi = gidx[i], gx = gi % ov.w, gy = (gi - gx) / ov.w;
    const lon = ov.west + (gx + 0.5) * ov.dx, lat = ov.north - (gy + 0.5) * ov.dy;
    if (lon > T.w + inset && lon < T.e - inset && lat > T.s + inset && lat < T.n - inset) pos.setY(i, down ? (EMPTY ? -2000 : -40) : yOf ? yOf(ov.elev[gi]) : ov.elev[gi]);
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
    const dem = await demFor(T.w - M, T.s - M, T.e + M, T.n + M, true);
    if (T.state !== 'loading' || T.gen !== gen) { photoP.then(ph => ph.img.close?.(), () => {}); return; }
    const rect = { west: T.w, east: T.e, south: T.s, north: T.n };
    Object.assign(T, { dem, mat: PLAIN, img: null, photo: 'pending', full: gridMesh(dem, rect, 1, PLAIN, yOf), coarse: gridMesh(dem, rect, 4, PLAIN, yOf) });
    T.full.visible = false; scene.add(T.full, T.coarse); sinkOverview(T, true); T.state = 'ready';
    photoP.then(ph => {
      if (T.state !== 'ready' || T.gen !== gen) { ph.img.close?.(); return; }
      addCanopy(dem, ph, () => 0);   // forest mask only: the 3D trees give the forest its height here
      T.spots = treeSpots(T, dem); treesDirty = true;
      const mat = seabed(photoMat(ph, ANISO)), wasNear = T.full.visible;
      scene.remove(T.full, T.coarse); T.full.geometry.dispose(); T.coarse.geometry.dispose();
      T.full = gridMesh(dem, ph, 1, mat, yOf); T.coarse = gridMesh(dem, ph, 4, mat, yOf);
      T.full.visible = wasNear; T.coarse.visible = !wasNear; scene.add(T.full, T.coarse);
      T.mat = mat; T.img = ph.img; T.photo = 'done';
    }).catch(err => { console.warn('[bay3d] photo failed', T, err); T.photo = 'failed'; });
  } catch (err) { console.warn('[bay3d] tile failed', T, err); T.state = 'failed'; }
}
// Empty Bay's depth exaggeration changed: every loaded mesh's heights again from its grid, the sunk
// overview kept sunk under the loaded tiles
// Empty Bay's charted rocks, obstructions and wrecks (v931, requested): hazards.geojson's points, each kind one
// instanced mesh, standing on the seabed where it is (heightAt, deepened by EXAG like the seabed) and drawn
// bigger the farther off you are, so they can be found from up high. Water let back in hides them, as it would.
// Re-placed when tiles load, the Depth slider moves or the view zooms (updateHazards, from the frame's checks).
const hazards = { list: [], meshes: {}, key: '' };
let updateHazards = () => {};
// (v964, asked: "Aren't there any known shipwrecks in deeper water in Penobscot Bay?") plus the wrecks always
// under water, which hazards.geojson's build had left out (data/wrecks_submerged.geojson; INCIDENTS.md 2026-10-21)
if (EMPTY) Promise.all([getJSON(`./data/regions/${RID}/hazards.geojson`), getJSON('./data/wrecks_submerged.geojson').catch(() => ({ features: [] }))]).then(([fc, wr]) => {
  fc = { features: [...fc.features, ...wr.features] };
  const KIND = { 'underwater rock': 'rock', obstruction: 'obstruction', wreck: 'wreck' };
  const seen = new Set();
  for (const f of fc.features) {
    const kind = KIND[f.properties?.label]; if (!kind || f.geometry?.type !== 'Point') continue;
    const [lon, lat] = f.geometry.coordinates, cell = `${kind}|${Math.round(lon * 6000)},${Math.round(lat * 6000)}`;   // the same one on two charts: once (~15 m)
    if (seen.has(cell)) continue; seen.add(cell);
    let sd = Math.round(Math.abs(lon * 1e5 + lat * 7e4)) % 2147483646 + 1; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    hazards.list.push({ kind, lon, lat, x: wx(lon), z: wz(lat), valsou: f.properties.valsou, watlev: f.properties.watlev, name: f.properties.name, turn: rnd() * Math.PI * 2, size: 0.8 + rnd() * 0.5 });
  }
  const geo = {
    rock: new THREE.DodecahedronGeometry(1, 0).scale(1, 0.62, 0.9),
    obstruction: new THREE.BoxGeometry(1.3, 0.9, 1.3),
    wreck: (() => {   // a small hull, keel down, broken off at the stern
      const sh = new THREE.Shape(); sh.moveTo(0, 1.6); sh.quadraticCurveTo(0.7, 0.6, 0.6, -1.3); sh.lineTo(-0.6, -1.3); sh.quadraticCurveTo(-0.7, 0.6, 0, 1.6);
      return new THREE.ExtrudeGeometry(sh, { depth: 0.7, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, -0.1, 0);
    })(),
  };
  const col = { rock: 0x625a50, obstruction: 0x6a6488, wreck: 0x9a5426 };
  for (const kind of Object.keys(geo)) {
    const items = hazards.list.filter(h => h.kind === kind);
    const m = new THREE.InstancedMesh(geo[kind], new THREE.MeshLambertMaterial({ color: col[kind] }), Math.max(1, items.length));
    m.count = items.length; m.frustumCulled = false; scene.add(m); hazards.meshes[kind] = { m, items };
  }
  const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  updateHazards = () => {
    const size = clamp(view.dist / 260, 1.5, 45);   // metres: small up close, findable from the heights
    const key = `${tiles.filter(T => T.state === 'ready').length}|${EXAG}|${Math.round(Math.log(size) * 8)}`;
    if (key === hazards.key) return; hazards.key = key; hazards.size = size;
    for (const { m, items } of Object.values(hazards.meshes)) {
      items.forEach((h, i) => {
        const big = h.kind === 'wreck' ? 1.8 : 1, s = size * h.size * big;
        h.y = yOf(Math.min(heightAt(h.lon, h.lat), 0));   // a rock charted on dry land sits at the tide line
        q.setFromAxisAngle(up, h.turn); sc.set(s, s, s); pv.set(h.x, h.y + s * 0.35, h.z);
        m.setMatrixAt(i, mat.compose(pv, q, sc));
      });
      m.instanceMatrix.needsUpdate = true;
    }
  };
  updateHazards();
}).catch(err => console.warn('[bay3d] hazards failed', err));
// what the depth readout says of the one under (or nearest within its size of) a point
function hazardNear(lon, lat) {
  let best = null, bd = Infinity;
  const x = wx(lon), z = wz(lat), r = Math.max(12, (hazards.size || 10) * 1.6);
  for (const h of hazards.list) { const d = Math.hypot(h.x - x, h.z - z); if (d < r && d < bd) { bd = d; best = h; } }
  if (!best) return '';
  const WAT = { 1: 'partly submerged at high water', 2: 'always dry', 3: 'always under water', 4: 'covers and uncovers', 5: 'awash' };
  const v = best.valsou, depth = v == null ? '' : v < 0 ? `dries ${Math.round(-v / 0.3048)} ft at low water` : `${Math.round(v / 0.3048)} ft over it at low water`;
  return [best.name || best.kind[0].toUpperCase() + best.kind.slice(1), depth, WAT[best.watlev]].filter(Boolean).join(' · ');
}
function remeshForExag() {
  const redo = (mesh, dem) => {
    if (!mesh) return;
    const pos = mesh.geometry.attributes.position, gidx = mesh.userData.gidx;
    for (let i = 0; i < gidx.length; i++) pos.setY(i, yOf(dem.elev[gidx[i]]));
    pos.needsUpdate = true; mesh.geometry.computeVertexNormals(); mesh.geometry.computeBoundingSphere();
  };
  redo(ovMesh, ov);
  for (const T of tiles) if (T.state === 'ready') { redo(T.full, T.dem); redo(T.coarse, T.dem); sinkOverview(T, true); }
  ovMesh.geometry.computeVertexNormals();
}
if (EMPTY) {
  const box = document.getElementById('exagbox'), inp = document.getElementById('exag'), out = document.getElementById('exagval');
  // Water level (v929, requested): let the sea back in, from empty to a little over sea level (NAVD 88, about
  // mean sea level; high water at Rockland is about +1.6 m). Its surface stands at the level, deepened by EXAG
  // like the seabed. ▲ Fill / ▼ Drain run it up or down over about 15 s. Not remembered: it opens empty.
  const lv = document.getElementById('wlevel'), lvOut = document.getElementById('wlevelval'), fillBtn = document.getElementById('wfill');
  if (lv) {
    const show = () => {
      lvOut.textContent = waterLevel <= WATER_MIN ? 'empty' : Math.abs(waterLevel) < 0.25 ? 'sea level' : `${waterLevel > 0 ? '+' : '−'}${Math.round(Math.abs(waterLevel) / 0.3048)} ft`;
      fillBtn.textContent = waterFill ? '❚❚' : waterLevel > -0.25 ? '▼ Drain' : '▲ Fill';
    };
    lv.addEventListener('input', () => { waterLevel = levelAt(Number(lv.value)); waterFill = 0; show(); });
    fillBtn.addEventListener('click', () => { waterFill = waterFill ? 0 : waterLevel > -0.25 ? -1 : 1; show(); });
    waterUI = () => { lv.value = String(Math.round(sliderAt(waterLevel))); show(); };
    show();
  }
  if (box) {
    box.hidden = false; inp.value = String(EXAG); out.textContent = `${EXAG}×`;
    inp.addEventListener('input', () => {
      EXAG = clampNum(Number(inp.value) || 1, 1, 10); EXAG_U.value = EXAG; out.textContent = `${EXAG}×`;
      try { localStorage.setItem(EXAG_KEY, String(EXAG)); } catch (_) {}
      remeshForExag();
    });
    for (const ev of ['pointerdown', 'wheel', 'touchstart']) box.addEventListener(ev, e => e.stopPropagation(), { passive: true });   // not a drag of the view
  }
  // Depth under the pointer (v930, requested): where the line of sight meets the terrain, marched along the ray
  // against heightAt (the meshes have ~600k triangles a tile, too many to pick through on every move) and
  // narrowed by halving; then that spot's true depth, and the water over it when the Water slider has let
  // some in. Mouse: follows the pointer. Touch: a tap shows it for a few seconds.
  const tip = document.createElement('div'); tip.id = 'depthtip'; tip.hidden = true; document.body.appendChild(tip);
  const surfY = (x, z) => yOf(heightAt(lonOf(x), latOf(z)));
  const terrainHit = (cx, cy) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const o = ray.ray.origin, d = ray.ray.direction, at = k => [o.x + d.x * k, o.y + d.y * k, o.z + d.z * k];
    for (let prev = 0, k = 2, i = 0; i < 700 && k < 250000; i++) {
      const [x, y, z] = at(k);
      if (y <= surfY(x, z)) {
        let lo = prev, hi = k;
        for (let n = 0; n < 16; n++) { const m = (lo + hi) / 2, [mx, my, mz] = at(m); if (my <= surfY(mx, mz)) hi = m; else lo = m; }
        const [hx, , hz] = at(hi); return { lon: lonOf(hx), lat: latOf(hz) };
      }
      if (y < -1500) return null;
      prev = k; k += Math.max(3, k * 0.015);
    }
    return null;
  };
  const ftOf = m => Math.round(m / 0.3048).toLocaleString();
  let tipAt = null, tipQueued = false, tipUntil = 0;
  const showTip = () => {
    tipQueued = false;
    const hit = tipAt && terrainHit(tipAt.x, tipAt.y);
    if (!hit) { tip.hidden = true; return; }
    const h = heightAt(hit.lon, hit.lat);
    let txt;
    if (h >= 0.5) txt = `Land · about ${ftOf(h)} ft up`;
    else if (h > -0.5) txt = 'At the tide line';
    else {
      txt = `<b>${ftOf(-h)} ft</b> deep <span>(${Math.round(-h)} m)</span>`;
      if (waterLevel > WATER_MIN && waterLevel > h) txt += `<br>under ${ftOf(waterLevel - h)} ft of water now`;
    }
    const hz = hazardNear(hit.lon, hit.lat);
    if (hz) txt += `<br><b>${hz}</b>`;
    tip.innerHTML = txt; tip.hidden = false; tip.dataset.at = `${hit.lat.toFixed(5)},${hit.lon.toFixed(5)},${h.toFixed(2)}`;   // (for tests)
    const w = tip.offsetWidth, hh = tip.offsetHeight;
    tip.style.left = Math.min(innerWidth - w - 8, tipAt.x + 16) + 'px';
    tip.style.top = Math.max(8, Math.min(innerHeight - hh - 8, tipAt.y - hh - 10)) + 'px';
  };
  const queueTip = () => { if (!tipQueued) { tipQueued = true; requestAnimationFrame(showTip); } };
  let downAt = null;
  sceneEl.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    if (drag) { tip.hidden = true; return; }
    tipAt = { x: e.clientX, y: e.clientY }; queueTip();
  });
  sceneEl.addEventListener('pointerleave', () => { if (performance.now() > tipUntil) tip.hidden = true; });
  sceneEl.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; if (e.pointerType !== 'mouse') tip.hidden = true; });
  sceneEl.addEventListener('pointerup', e => {
    if (e.pointerType === 'mouse' || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8) return;
    tipAt = { x: e.clientX, y: e.clientY }; tipUntil = performance.now() + 3500; queueTip();
    setTimeout(() => { if (performance.now() >= tipUntil) tip.hidden = true; }, 3600);
  });
  addEventListener('wheel', () => { if (tipAt) queueTip(); }, { passive: true });
  const sub = document.querySelector('h1 small'); if (sub) sub.textContent = 'Empty Bay: the water drained away';
  document.getElementById('sailboat')?.setAttribute('hidden', '');   // nothing afloat to follow
  document.getElementById('credit').textContent = 'Land and seabed NOAA NCEI CUDEM · Photos USDA NAIP';
  const help = document.getElementById('help');
  if (help) help.textContent = 'Empty Bay: the bay with the water gone. Drag to move · Shift-drag to turn and tilt · scroll or pinch to zoom · Depth deepens the seabed · Water lets the sea back in (▲ Fill) · point (or tap) for the depth, and the charted rocks and wrecks';
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
const townList = (await getJSON('./data/buildings/index.json').catch(() => [])).filter(t => { const [w, s, e, n] = t.bbox; return e > OVERVIEW[0] && w < OVERVIEW[2] && n > OVERVIEW[1] && s < OVERVIEW[3]; }).map(t => {
  const [w, s, e, n] = t.bbox, lon = (w + e) / 2, lat = (s + n) / 2;
  return { ...t, id: t.file.replace(/\.json$/, ''), short: t.name.split(/, | and /)[0], lon, lat, x: wx(lon), z: wz(lat), group: null, state: 'idle', credit: '' };
}).sort((a, b) => a.short.localeCompare(b.short));
// the Maine State ferry slips (v943, below), placed once the ferries are loaded; a town's own piers that stand
// where a slip does give way to it
const slips = [];
let slipsReadyResolve; const slipsReady = new Promise(r => { slipsReadyResolve = r; setTimeout(r, 8000); });
const creditEl = document.getElementById('credit');
function updateCredit() {
  const shown = townList.filter(t => t.group);
  creditEl.textContent = (EMPTY ? 'Land and seabed NOAA NCEI CUDEM · Photos USDA NAIP' : 'Elevation USGS 3DEP · Photos USDA NAIP') + (shown.length ? ' · Buildings © OpenStreetMap contributors' + (shown.some(t => /Microsoft/.test(t.credit)) ? ', Microsoft' : '') : '');
}
async function loadTown(t) {
  t.state = 'loading'; townsLoading++;
  try {
    const T = t.data || (t.data = await getJSON(`./data/buildings/${t.file}`));
    if (t.state !== 'loading') return;
    await slipsReady; if (t.state !== 'loading') return;
    const near = pr => slips.some(sl => pr.p.some(([lo, la]) => inSlip(sl, wx(lo), wz(la))));   // (within a slip's piers, v949)
    t.group = buildTown(slips.length ? { ...T, piers: T.piers.filter(pr => !near(pr)) } : T);
    for (const h of moorings?.harbors || []) if (h.spots && Math.hypot(h.x - t.x, h.z - t.z) < 4000) moorings.relayout(h);   // lay them out again clear of its piers
    t.credit = T.credit || ''; scene.add(t.group); t.state = 'ready'; updateCredit();
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
{ const ts = document.getElementById('townsect'); if (ts) ts.hidden = !townList.length; }
const panel = document.getElementById('panel'), toggle = document.getElementById('towns-toggle');
function foldPanel(fold) { if (!matchMedia('(max-width: 640px)').matches) return; panel.classList.toggle('folded', fold); toggle.setAttribute('aria-expanded', String(!fold)); }
toggle.addEventListener('click', () => foldPanel(!panel.classList.contains('folded')));
foldPanel(true);

// ── Rockland Breakwater (the town file leaves it out; the helm view models it the same way) ──
if (PENOBSCOT) {
  const [[lo0, la0], [lo1, la1]] = [[-69.08197, 44.11540], [-69.07751, 44.10410]];
  const ax = wx(lo0), az = wz(la0), bx = wx(lo1), bz = wz(la1), len = Math.hypot(bx - ax, bz - az);
  const bw = new THREE.Mesh(new THREE.BoxGeometry(7, 9, len), new THREE.MeshLambertMaterial({ color: 0x8d877f }));
  bw.position.set((ax + bx) / 2, -0.5, (az + bz) / 2); bw.rotation.y = Math.atan2(bx - ax, bz - az); scene.add(bw);
}

// ── Buoys and lighthouses from the chart: instanced, drawn larger the farther off they are ──
const [navGJ, placesGJ, landGJ] = await Promise.all([
  getJSON(`./data/regions/${RID}/navaid.geojson`).catch(() => ({ features: [] })),
  getJSON(`./data/regions/${RID}/named_places.geojson`).catch(() => ({ features: [] })),
  getJSON('./data/landmarks.json').catch(() => ({ landmarks: [] })),
]);
const inBay = ([x, y]) => x >= OW && x <= OE && y >= OS && y <= ON;
const navs = navGJ.features.filter(f => f.geometry?.type === 'Point' && inBay(f.geometry.coordinates));
const BUOY_T = ['BOYLAT', 'BCNLAT', 'BOYSAW', 'BOYSPP', 'BOYCAR', 'BOYISD'];
const buoys = navs.filter(f => BUOY_T.includes(f.properties.objtype)).map(f => ({ x: wx(f.geometry.coordinates[0]), z: wz(f.geometry.coordinates[1]), c: (f.properties.colour || '').split('/')[0], num: ((f.properties.name || '').replace(/"/g, '').match(/(\S{1,3})$/)?.[1] || '').replace(/^(?!.*\d).*$/, '') }));
// every charted light, for the night: a glow that flashes its own characteristic
const litNavs = navs.filter(f => f.properties.objtype === 'LIGHTS').map(f => ({ x: wx(f.geometry.coordinates[0]), z: wz(f.geometry.coordinates[1]), fl: flashFor(f.properties.characteristic), name: f.properties.name, hgt: f.properties.height_m, sec: f.properties.sectors, only: !!f.properties.sector_only, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
const lightsAshore = navs.filter(f => f.properties.objtype === 'LIGHTS').filter(f => !buoys.some(b => Math.hypot(b.x - wx(f.geometry.coordinates[0]), b.z - wz(f.geometry.coordinates[1])) < 40))
  .map(f => ({ x: wx(f.geometry.coordinates[0]), z: wz(f.geometry.coordinates[1]), y: Math.max(0, heightAt(...f.geometry.coordinates)) }));
// ── Where she is (v1000, requested: "when I look at a tracked vessel in birdseye view, it is difficult to really
// see where she is … put some bearings and range to known items"): the charted marks round a vessel, the nearest
// first and the others spread round her as for a fix by hand-bearing compass, each with its magnetic bearing from
// her and its range. Her card and the follow bar list them, and lines run out to them in the view.
let MAGVAR = PENOBSCOT ? -15.3 : -15.0;
getJSON(`./data/regions/${RID}.json`).then(r => { if (typeof r.magvar === 'number') MAGVAR = r.magvar; }).catch(() => {});
const toMag = t => ((t - MAGVAR) % 360 + 360) % 360;
const magTxt = t => `${String(Math.round(toMag(t)) % 360).padStart(3, '0')}°M`;
const fixMarks = [];
for (const f of navs) {   // named marks (a light, buoy or daybeacon), not one known only by its number
  const n = f.properties.name;
  if (n && /[a-z]{3}/.test(n) && !fixMarks.some(m => m.n === n)) fixMarks.push({ n, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], k: f.properties.objtype === 'LIGHTS' ? 0.7 : 1 });
}
for (const f of placesGJ.features) {   // headlands and islands
  const o = f.properties.objtype, c = f.geometry?.coordinates;
  if (f.geometry?.type === 'Point' && f.properties.name && (o === 'LNDRGN' || o === 'LNDARE') && inBay(c)) fixMarks.push({ n: f.properties.name, lon: c[0], lat: c[1], k: o === 'LNDRGN' ? 0.9 : 1.2 });
}
for (const m of fixMarks) { m.x = wx(m.lon); m.z = wz(m.lat); }
function marksNear(x, z, n = 3) {
  const out = [];
  const c = fixMarks.map(m => ({ m, d: Math.hypot(m.x - x, m.z - z) })).filter(o => o.d > 40 && o.d < 6 * 1852).sort((a, b) => a.d * a.m.k - b.d * b.m.k);
  for (const o of c) {
    o.brg = (Math.atan2(o.m.x - x, -(o.m.z - z)) / DEG + 360) % 360;
    if (out.some(p => Math.abs(((p.brg - o.brg + 540) % 360) - 180) < 35)) continue;   // a fix wants marks well apart
    out.push(o); if (out.length === n) break;
  }
  return out;
}
const fixRange = d => d < 0.25 * 1852 ? `${Math.round(d / 0.9144 / 10) * 10} yd` : `${(d / 1852).toFixed(1)} nm`;
const fixBrg = o => `${String(Math.round(toMag(o.brg)) % 360).padStart(3, '0')}°M`;
const fixText = o => `${o.m.n} bears ${fixBrg(o)}, ${fixRange(o.d)}`;
// 🗺 Chart (v1000, requested: "be able to flip over to chart view"): AudioChart's chart, centred on her with her
// marks drawn, and a way back to this view. Only inside AudioChart, which has the chart.
const chartHook = () => { try { return window.parent !== window && window.parent.__audioChartViews?.showVessel ? window.parent.__audioChartViews : null; } catch (_) { return null; } };
function showOnChart(v) {
  const hook = chartHook(); if (!hook) return;
  hook.showVessel(window, {
    lat: latOf(v.z), lon: lonOf(v.x), name: vName(v), mmsi: v.kind === 'ais' ? v.A.mmsi : null,
    sog: v.kind === 'ais' ? v.A.sog : null, cog: v.kind === 'ais' ? v.A.cog : null, cogText: v.kind === 'ais' && v.A.cog != null ? magTxt(v.A.cog) : null,   // (her vector on the chart: v1008)
    marks: marksNear(v.x, v.z).map(o => ({ n: o.m.n, lat: o.m.lat, lon: o.m.lon, text: `${fixBrg(o)}, ${fixRange(o.d)}` })),
  });
}
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
// wakes in the water itself (v959, requested: "give Bird's-eye boats the same wake" as the helm view's,
// wake3d.js), for the nearest dozen boats under way; the old painted foam overlays stay off
const wakes = makeWakes(water, 12), WAKE_N = 12;
function updateWakes(dt) {
  const cp = camera.position, list = [];
  const add = (key, g, L, kn, moving) => { if (moving && g.visible) list.push({ key, x: g.position.x, z: g.position.z, rotY: g.rotation.y, L, scale: g.scale.x, kn, moving, d: Math.hypot(g.position.x - cp.x, g.position.z - cp.z) }); };
  if (own.r || own.ext) add('own', own.boat.group, own.boat.L, own.wakeKn, own.wakeOn);
  fleet.forEach((b, i) => add('f' + i, b.boat.group, b.boat.L, b.boat.kn || BOAT_KN, !!b.going));
  traffic.forEach((v, i) => add('t' + i, v.group, v.L, v.kind === 'ferry' ? v.F.knots : v.V.knots, !!(v.on && v.st?.moving)));
  for (const v of live) add('a' + v.mmsi, v.group, v.L, v.A.sog || 0, v.on && (v.A.sog || 0) >= 0.8);
  list.sort((a, b) => a.d - b.d);
  wakes.update(list.slice(0, WAKE_N), dt);
}
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
  return { sp, fl: l.fl, sec: l.sec, only: l.only, phase: Math.random() * 6, range: (ashore ? 9 : 3.5) * 1852 };
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
    aboveFog = env.aboveFog = above;   // (the moon, as it moves, shows over the fog bank too)
    treeFogCut = above ? top - 4 : -Infinity; treesDirty = true;
    blanket.g.visible = above;
    const su = sky.material.uniforms, T = env.T;
    if (above) {   // the sky over the fog bank: the time of day's own (or the overcast) sky
      _sky.zen.set(env.over ? T.over : T.zen); _sky.hor.set(env.over ? T.fog : T.haze);
      su.zenith.value.copy(_sky.zen); su.horizon.value.copy(_sky.hor); scene.fog.color.copy(_sky.hor);
      su.sunCol.value.fromArray(env.over ? [0, 0, 0] : T.glow); su.moonK.value = env.night && !env.over ? (env.moon?.up ?? 1) : 0;
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
    let col = g.fl.col;
    if (g.sec) {   // a sector light: its colour from where you're looking from (v918)
      col = sectorColour(g.sec, g.only, g.fl.col, Math.atan2(g.sp.position.x - camera.position.x, -(g.sp.position.z - camera.position.z)) * 180 / Math.PI);
      if (col != null) g.sp.material.color.setHex(col);
    }
    g.sp.visible = col != null && k > 0 && flashOn(g.fl, t + g.phase) && !(above && g.sp.position.y < top);
    if (g.sp.visible) g.sp.material.opacity = k;
  }
}

// ── A fleet of sailboats (v870, requested: the helm view's sail trim, seen from the air) ──
// Forty boats on open water, each sailing short legs round its own patch of the bay and trimmed
// to the Weather panel's wind (weather3d.js's makeTrimmer): they never point inside 45° of the
// wind, tack and gybe as they turn, heel to leeward, and stop with sails furled in a calm. Close up
// they sail at a real 5 kn; from higher up time runs faster (up to 20×) so you can see them move.
// Like the buoys, they're drawn bigger the farther off you are.
// Off since v1018 (requested: "wipe all 'fake boats' off the screen. They add confusion", i.e. "the boat aimlessly
// driving around in circles"): ?fleet=1 brings them back (the demo videos were made with them).
const FLEET_N = params.get('fleet') === '1' ? 40 : 0, BOAT_KN = 5, NMm = 1852;
// drawn bigger the farther off, as the buoys are; a big boat needs less of it, so a windjammer stays
// bigger than a daysailer at any range without becoming an island from the heights (v905)
const boatScale = (boat, d) => Math.max(1.6, clamp(d / 250, 1.6, 90) * Math.sqrt(8 / boat.L));
const isWater = (x, z) => heightAt(lonOf(x), latOf(z)) <= 0.3;
const clearLeg = (x, z, h, len) => { const a = h * DEG; for (let d = 120; d <= len + 200; d += 120) if (!isWater(x + Math.sin(a) * d, z - Math.cos(a) * d)) return false; return true; };
const fleet = [];
{
  let sd = 20261012; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const [BW, BS, BE, BN] = BAY;
  for (let tries = 0; fleet.length < (EMPTY ? 0 : FLEET_N) && tries < 6000; tries++) {   // nothing afloat in an empty bay
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
// The schooner Bowdoin (v919, requested): always in the fleet, sailing her own patch of East Penobscot Bay
// off Castine, Maine Maritime Academy's home port; the nearest open water to there with room to sail.
const OWN_TYPE = (() => { let b = params.get('boat'); if (!b) { try { b = localStorage.getItem('audiochart-boat'); } catch (_) {} } return b === 'angelique' || b === 'bowdoin' ? b : 'cd25'; })();
const OWN_NAME = { cd25: 'Sea Nymph', angelique: 'Angelique', bowdoin: 'Bowdoin' }[OWN_TYPE];
// (when she's your own boat, chosen in the helm view, she's that one, not a second Bowdoin in the fleet)
let bowdoin = null;
if (OWN_TYPE !== 'bowdoin' && !EMPTY && PENOBSCOT) {   // (she sails from Castine: Penobscot Bay's)
  const c = { x: wx(-68.84), z: wz(44.33) };
  const roomy = (x, z) => isWater(x, z) && [0, 1, 2, 3, 4, 5, 6, 7].every(k => isWater(x + Math.sin(k * Math.PI / 4) * 0.45 * NMm, z - Math.cos(k * Math.PI / 4) * 0.45 * NMm));
  let at = null;
  for (let r = 0; !at && r <= 4 * NMm; r += 300) for (let k = 0; k < Math.max(1, Math.round(r / 300)) * 6 && !at; k++) {
    const a = k / (Math.max(1, Math.round(r / 300)) * 6) * 2 * Math.PI, x = c.x + Math.sin(a) * r, z = c.z - Math.cos(a) * r;
    if (roomy(x, z)) at = { x, z };
  }
  if (at) {
    let sd = 1921; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    const boat = makeSailboat('bowdoin', 1921);
    scene.add(boat.group);
    bowdoin = { boat, name: 'Bowdoin', home: at, x: at.x, z: at.z, h: 200, want: null, left: 0, trim: makeTrimmer(), rnd };
    fleet.push(bowdoin);
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
document.getElementById('sailboat').hidden = !fleet.some(b => b !== bowdoin);   // (no fleet: nothing to follow but Bowdoin, who has her own button)
function stopFollow() { if (!follow) return; follow = null; document.getElementById('sailboat').classList.remove('on'); }

// ── Bowdoin's crow's nest (v919, requested: "give it a Crow's Nest, and a way to trigger an observation from
// there") ── 🔭 Crow's nest puts you in her ice barrel at the foremast head, 60-odd feet up, riding with her as
// she sails: drag (or the arrow keys) to look round, scroll or pinch for the glasses (up to 7×). Lookout's report
// calls out what's in sight from up there: lighthouses, towns, summits and nearby vessels, each with its bearing
// off her bow, as a lookout would ("Owls Head Light, broad on the port bow, 6.2 nm"), shown and spoken.
// Come down (or Esc) flies you back to where you were.
// Every window shrinks (v940, the standing request: "all windows should be shrinkable"): the – in its corner folds
// it to its first line, + opens it again, remembered for each window. (The ride's chart shrinks with a tap.)
function shrinkable(el) {
  if (!el || el.querySelector(':scope > .shrinker')) return;
  const key = `audiochart-bay3d-shrunk-${el.id}`, b = document.createElement('button');
  b.type = 'button'; b.className = 'shrinker';
  const sync = () => { const on = el.classList.contains('shrunk'); b.textContent = on ? '+' : '–'; b.title = on ? 'Open this window out' : 'Shrink this window'; };
  try { el.classList.toggle('shrunk', localStorage.getItem(key) === '1'); } catch (_) {}
  b.addEventListener('pointerdown', e => e.stopPropagation());
  b.addEventListener('click', e => { e.stopPropagation(); const on = el.classList.toggle('shrunk'); try { localStorage.setItem(key, on ? '1' : '0'); } catch (_) {} sync(); });
  sync(); el.appendChild(b);
  // opened from its button, a window always opens out (v952: a remembered fold left the Underway and Coming up
  // tables showing only their titles and a +, which read as empty)
  el.openOut = () => { el.classList.remove('shrunk'); try { localStorage.setItem(key, '0'); } catch (_) {} sync(); };
}
for (const id of ['nesthud', 'underway', 'clockpanel']) shrinkable(document.getElementById(id));
const nestHud = document.getElementById('nesthud'), nestRep = document.getElementById('nestrep');
const nestOK = ['nesthud', 'nestrep', 'crowsnest', 'nestdown', 'nestreport', 'bowdoinbtn', 'ridename', 'ridehint'].every(id => document.getElementById(id));   // (a stale cached page may lack them)
// Riding (v937, requested: "zoom in to the helm of any boat underway ... the boat should become the focus, so
// drone view would refer to that"): any vessel in ⛴ Underway, or Bowdoin's 🔭 crow's nest, puts you aboard her,
// riding with her: ⎈ Helm where you'd stand at her wheel (or on a ship's bridge), 🚁 Drone above and astern of her,
// following her round (drag to circle her, scroll or pinch to close in or stand off), 🔭 Nest Bowdoin's ice
// barrel. ⬇ Leave (Esc) leaves you over her, following her in the Bird's-eye view.
const vGroup = v => v.group || v.boat.group;
let syncFollowHud = () => {};   // (the follow bar, below)
const RIDE_BTNS = [['ridehelm', 'helm'], ['ridedrone', 'drone'], ['ridestern', 'stern'], ['rideside', 'side'], ['ridebow', 'bow'], ['ridenest', 'nest']];
const titleCase = t => t.toLowerCase().replace(/(^|[\s.'-])[a-z]/g, c => c.toUpperCase()).replace(/\b(Ii|Iii|Iv)\b/g, r => r.toUpperCase());   // (Maquoit II, Aucocisco III: v993)
function vName(v) {
  if (v === own) return OWN_NAME;
  if (v === bowdoin) return 'Bowdoin';
  if (v.kind === 'ferry') return titleCase(v.F.vessel || v.F.name).replace(/^Capt\./, 'Captain');
  if (v.kind === 'cruise') return cap(v.V.name);
  if (v.kind === 'ais') return aisName(v.A);
  return cap((KIND[v.boat.type] || 'a sailboat').replace(/^an? /, ''));
}
const vDoing = v => v.boat.power ? 'Hauling traps' : env.W.heel > 0 ? 'Under sail' : 'Becalmed';
const vTitle = v => v.kind === 'cruise' ? `the ${v.V.name}` : vName(v);   // in a sentence
const vLen = v => v.L || v.boat?.L || 8;
const helmOf = v => vGroup(v).userData.helm || v.boat?.helm || [0, 2, vLen(v) * 0.35];
// Stern, Side and Bow (v968, requested: "view this boat from the stern, bow, and sides, like we did elsewhere",
// as the helm view's v955): a camera boat keeping station off her, low on the water, looking at her: astern with
// her wake running toward you, abeam to starboard, or ahead and a little off her starboard bow as she comes on.
// They orbit her as the drone does (drag to circle her, scroll or pinch to close in or stand off), only lower and
// closer. yaw: degrees round from dead astern (−: to starboard); el: degrees up; d: boat lengths off.
const CHASE = { stern: { yaw: 0, el: 7, d: 2.4, label: 'astern of' }, side: { yaw: -90, el: 6, d: 2.6, label: 'abeam of' }, bow: { yaw: -165, el: 6, d: 2.3, label: 'ahead of' } };
const ORBITS = m => m === 'drone' || !!CHASE[m];   // the camera off her, looking at her
function ride(v, mode = 'helm') {
  if (!v || !nestOK || (!vGroup(v).visible && v !== nest.v)) return;
  if (mode === 'nest' && !v.boat?.nest) mode = 'helm';
  const was = nest.on;
  if (!was) { stopFollow(); anim = null; nest.prev = { ...view }; }
  nest.on = true; nest.v = v; nest.mode = mode; nest.yaw = CHASE[mode]?.yaw || 0; nest.pitch = CHASE[mode] ? -CHASE[mode].el : mode === 'drone' ? -16 : mode === 'helm' && helmOf(v)[1] > 6 ? -8 : -3; nest.zoom = 1; nestRep.textContent = '';   // (from a high bridge, a little down: her bow in sight)
  document.body.classList.add('innest'); nestHud.hidden = false;
  document.getElementById('crowsnest').classList.toggle('on', mode === 'nest');
  const big = vLen(v) > 30 && !v.boat, name = vTitle(v);
  document.getElementById('ridename').textContent = mode === 'nest' ? `${name}'s crow's nest` : mode === 'drone' ? `Drone over ${v === own ? 'your boat' : name}` : CHASE[mode] ? `From a boat ${CHASE[mode].label} ${v === own ? 'your boat' : name}`
    : v === own ? 'At your helm' : big ? `On the bridge of ${name}` : `At the helm of ${v.boat && !v.kind ? 'a ' + name.toLowerCase() : name}`;
  for (const [id, m] of RIDE_BTNS) { const b = document.getElementById(id); if (b) { b.classList.toggle('on', m === mode); if (m === 'nest') b.hidden = !v.boat?.nest; } }
  document.getElementById('ridehint').textContent = ORBITS(mode) ? 'Drag or arrow keys to circle her · scroll or pinch to close in or stand off'
    : mode === 'nest' ? 'Drag or arrow keys to look round · scroll or pinch for the glasses' : 'Drag or arrow keys to look round · scroll or pinch for the binoculars';
  rideStatus();
  if (!was) {
    if (aboveFog || env.foggy) applyConditions({ vis: 'clear' });
    if (v.boat && !v.boat.power && env.W.heel === 0) applyConditions({ wind: 'breezy' });   // a sailboat's sailing
    foldPanel(true);
  }
  camera.fov = 50; camera.near = ORBITS(mode) ? 0.5 : 0.25; camera.updateProjectionMatrix();
}
function leaveRide() {
  if (!nest.on) return;
  const v = nest.v; nest.on = false; nest.v = null;
  document.body.classList.remove('innest'); nestHud.hidden = true; document.getElementById('crowsnest').classList.remove('on');
  camera.fov = 50; camera.near = 1; camera.updateProjectionMatrix();
  // over her, following her (from her quarter, high enough to see where she's bound)
  Object.assign(view, { x: v.x, z: v.z, dist: clamp(vLen(v) * 8, 250, 2500), tilt: 60 * DEG, az: (v.h + 35) * DEG });
  markCurrent(null); follow = v;
}
function setNest(on) { if (on) ride(bowdoin, 'nest'); else leaveRide(); }   // (the crow's nest, as before)
function rideStatus() {   // what she's doing, under the title
  const el = document.getElementById('ridestat'); if (!el || !nest.on) return;
  const v = nest.v;
  el.textContent = v.kind ? v.label : v === own ? sailNote.textContent : vDoing(v);
}
setInterval(rideStatus, 1000);
const _nw = new THREE.Vector3(), _nt = new THREE.Vector3();
function nestCamera() {   // after every vessel has moved: the eye aboard her, looking where you've turned it
  const v = nest.v, g = vGroup(v);
  if (!g.visible && !(v === own && own.r)) { leaveRide(); return; }   // she's gone (out of service, out of season)
  const h = v.h * DEG, sh = Math.sin(h), ch = Math.cos(h);
  const toWorld = ([lx, ly, lz], out) => out.set(v.x + lx * ch - lz * sh, ly, v.z + lx * sh + lz * ch);   // her frame (bow toward −z) to the world
  if (ORBITS(nest.mode)) {
    const L = vLen(v), C = CHASE[nest.mode], D = (C ? clamp(L * C.d, 18, 700) : clamp(L * 3.2, 45, 900)) / nest.zoom, el = clamp(-nest.pitch, 3, 85) * DEG;
    // a camera boat stays on the water (v1002, reported: Bow on the pilot boat at her pier put it among the houses):
    // where her Stern, Side or Bow spot is ashore, it goes round her to the nearest bearing afloat (clear of the
    // piers if it can be); ashore all round (a boat in a slip), it rises over the roofs and looks down on her
    const spot = yaw => { const a = (v.h + yaw) * DEG, r = Math.cos(el) * D; return [v.x - Math.sin(a) * r, v.z + Math.cos(a) * r]; };
    const wet = yaw => heightAt(lonOf(spot(yaw)[0]), latOf(spot(yaw)[1])) <= 0.3, open = yaw => wet(yaw) && !pierSegs(...spot(yaw), 12).length;
    let high = false;
    if (C && !wet(nest.yaw)) {
      let k = 0;
      for (const ok of [open, wet]) { for (k = 15; k <= 180; k += 15) { if (ok(nest.yaw + k)) { nest.yaw += k; break; } if (ok(nest.yaw - k)) { nest.yaw -= k; break; } } if (k <= 180) break; }
      high = k > 180;
    }
    const az = (v.h + nest.yaw) * DEG;
    _nt.set(v.x, Math.min(L * 0.12, 20) + 1.5, v.z);
    camera.position.set(_nt.x - Math.sin(az) * Math.cos(el) * D, _nt.y + Math.sin(el) * D, _nt.z + Math.cos(az) * Math.cos(el) * D);
    { const gy = heightAt(lonOf(camera.position.x), latOf(camera.position.z)), up = high || gy > 0.3 ? 28 : 4; if (camera.position.y < gy + up) camera.position.y = gy + up; }   // (never in the ground, nor among the houses)
    camera.lookAt(_nt); if (!C) camera.rotateX(0.1);   // (low on the water, she's best in the middle)   // her a little below the middle, clear of the bar along the top
    camera.fov = 50;
    view.x = v.x; view.z = v.z; view.dist = Math.max(D * 1.5, 900); view.az = az;
  } else {
    if (nest.mode === 'nest') { g.updateMatrixWorld(true); v.boat.nest.getWorldPosition(_nw); camera.position.copy(_nw); }
    else camera.position.copy(toWorld(helmOf(v), _nw));
    camera.rotation.set(nest.pitch * DEG, -(v.h + nest.yaw) * DEG, 0, 'YXZ');
    camera.fov = 50 / nest.zoom;
    view.x = v.x; view.z = v.z; view.dist = 6000; view.az = (v.h + nest.yaw) * DEG;   // what loads and what's labelled: round her, out toward the horizon
  }
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
}
// ── The ride's chart (v937, requested: "for each boat that we zoom into, throw up an overview chart so we can put
// the boat in context with respect to its course and destination"): north up, fitted to her whole course (a
// ferry's line with its landings, a cruise ship's track in from the sea, your route with its stops), her place
// and heading on it, the run so far, and a line saying where she's bound, how far and when. A sailboat or lobster
// boat out for the day has no course: a few miles round her, her wake so far and the way she's heading.
// Land and water from the view's own elevation (below). Tap to shrink or enlarge (remembered).
const rcEl = document.getElementById('ridechart'), rcCtx = rcEl?.getContext('2d');
const RC_SMALL_KEY = 'audiochart-bay3d-ridechart-small';
try { document.body.classList.toggle('smallride', localStorage.getItem(RC_SMALL_KEY) === '1'); } catch (_) {}
rcEl?.addEventListener('pointerdown', e => e.stopPropagation());
rcEl?.addEventListener('click', e => {
  e.stopPropagation();
  const small = document.body.classList.toggle('smallride');
  try { localStorage.setItem(RC_SMALL_KEY, small ? '1' : '0'); } catch (_) {}
});
// The land, drawn for the chart's own frame at its own resolution (v939, requested: "make the coastline on the
// chart less blocky"): the elevation interpolated between its samples (the detail tiles where they're loaded,
// else the overview), so the shore is a smooth curve, not the overview's squares; redrawn when the frame moves,
// or when more detail has loaded.
function elevSmooth(lon, lat) {
  const bil = (d, c0, r0) => {
    const c = Math.max(0, Math.min(d.w - 1.001, c0)), r = Math.max(0, Math.min(d.h - 1.001, r0)), ci = Math.floor(c), ri = Math.floor(r), fc = c - ci, fr = r - ri, i = ri * d.w + ci;
    return (d.elev[i] * (1 - fc) + d.elev[i + 1] * fc) * (1 - fr) + (d.elev[i + d.w] * (1 - fc) + d.elev[i + d.w + 1] * fc) * fr;
  };
  for (const T of tiles) {
    if (T.state !== 'ready' || lon < T.w || lon >= T.e || lat < T.s || lat >= T.n) continue;
    const d = T.dem; return bil(d, (lon - d.west) / d.dx - 0.5, (d.north - lat) / d.dy - 0.5);
  }
  const c = (lon - ov.west) / ov.dx - 0.5, r = (ov.north - lat) / ov.dy - 0.5;
  return c >= 0 && r >= 0 && c < ov.w - 1 && r < ov.h - 1 ? bil(ov, c, r) : -3;
}
function rideLandFor(B, size, k) {
  const ready = tiles.filter(T => T.state === 'ready').length, key = `${B.cx},${B.cz},${B.half},${size}`, now = performance.now();
  if (rc.land && rc.land.key === key && (rc.land.ready === ready || now - rc.land.t < 8000)) return rc.land.cv;
  const R = Math.min(640, Math.round(size * Math.min(2, devicePixelRatio))), q = size / R;
  const cv = rc.land?.cv.width === R ? rc.land.cv : Object.assign(document.createElement('canvas'), { width: R, height: R });
  const c = cv.getContext('2d'), img = c.createImageData(R, R), d = img.data, land = new Uint8Array(R * R);
  for (let j = 0; j < R; j++) {
    const lat = latOf(B.cz + ((j + 0.5) * q - (size + 22) / 2) / k);
    for (let i = 0; i < R; i++) land[j * R + i] = elevSmooth(lonOf(B.cx + ((i + 0.5) * q - size / 2) / k), lat) > 0.3 ? 1 : 0;
  }
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    const n = j * R + i, o = n * 4, L = land[n];
    const edge = L && ((i > 0 && !land[n - 1]) || (i < R - 1 && !land[n + 1]) || (j > 0 && !land[n - R]) || (j < R - 1 && !land[n + R]));
    const [r, g, b] = edge ? [120, 104, 74] : L ? [236, 223, 190] : [200, 222, 234];
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  rc.land = { cv, key, ready, t: now };
  return cv;
}
const rc = { v: null, box: null, trail: [], lastT: 0, stops: null, land: null };
function rideCourse(v) {   // her course in world metres, and the places on it ({x, z, name, kind})
  if (v.kind === 'ferry') {
    return { pts: v.T.P, places: ferryStops(v).map(st => ({ x: st.x, z: st.z, name: st.name, f: st.f, kind: 'stop' })) };
  }
  if (v.kind === 'cruise') {
    const P = v.T.P, a = P[0], b = P[P.length - 1];
    return { pts: P, places: [{ x: a[0], z: a[1], name: v.call.arrive ? 'to sea' : v.call.where.replace(/^bound from (\w+).*/, '$1'), kind: 'end' }, { x: b[0], z: b[1], name: v.call.port, kind: 'stop' }] };
  }
  if (v === own && own.r) {
    const P = own.pts, places = [{ x: P[0][0], z: P[0][1], name: 'Start', kind: 'end' }, { x: P[P.length - 1][0], z: P[P.length - 1][1], name: (own.r.name || '').replace(/\s*\([^)]*\)\s*$/, '').split(/\s+(?:to|→|-)\s+/i).pop() || 'End', kind: 'stop' }];
    for (const c of own.nights) { const [x, z] = ownPosAt(c); places.push({ x, z, name: '', kind: 'night' }); }
    return { pts: P, places };
  }
  return null;
}
function rideLine(v) {   // where she's bound, how far, and when
  const nm = m => `${(m / NMm).toFixed(m < 10 * NMm ? 1 : 0)} nm`, clk = m => hhmm(((m % 1440) + 1440) % 1440), now = clockMin();
  if (v.kind === 'ferry' && v.st) {
    const st = v.st, stops = rc.stops || [];
    if (!st.moving) {
      const next = ferryDepartures(v.F, v.T).find(d => d.t >= now - 0.01);
      return `At ${st.at}` + (next ? ` · leaves ${clk(next.t)} for ${next.to}` : ' · done for the day');
    }
    const nx = stops.find(p => p.name === st.next), left = nx ? Math.abs(nx.f - st.f) : 0;
    return `Bound for ${st.next}${st.next !== st.bound ? `, then ${st.bound}` : ''} · ${nm(left)} · ${clk(now + left / (v.F.knots * NMm / 60))}`;
  }
  if (v.kind === 'cruise' && v.st) {
    const st = v.st, left = st.dir > 0 ? v.T.L - st.f : st.f;
    return st.moving ? `${cap(st.doing)} · ${nm(left)}` + (st.dir > 0 ? ` · ${clk(now + left / (v.V.knots * NMm / 60))}` : '') : cap(st.doing);
  }
  if (v === own && own.r) {
    const left = own.total - own.S;
    if (left < 1) return 'Arrived';
    return `${nm(left)} to go` + (boatClock ? ` · arriving about ${clk(now + passageMin(own.total) - passageMin(own.S))}` : ` · ${(left / (OWN_KN * NMm)).toFixed(1)} h at ${OWN_KN} kn`);
  }
  if (v.kind === 'ais') return `${v.label} · heading ${String(Math.round(((v.h % 360) + 360) % 360)).padStart(3, '0')}°${aisDest(v.A.dest) ? ' · bound for ' + aisDest(v.A.dest) : ''}`;
  return `${vDoing(v)} · heading ${String(Math.round(((v.h % 360) + 360) % 360)).padStart(3, '0')}°`;
}
function drawRideChart() {
  if (!rcEl) return;
  const show = nest.on && !!nest.v;
  rcEl.hidden = !show; if (!show) { rc.v = null; return; }
  const v = nest.v, now = performance.now();
  if (rc.v !== v) { rc.v = v; rc.trail = []; rc.box = null; const cs = rideCourse(v); rc.course = cs; rc.stops = cs?.places.filter(p => p.f != null) || null; }
  if (now - rc.lastT > 1500) { rc.lastT = now; rc.trail.push([v.x, v.z]); if (rc.trail.length > 400) rc.trail.shift(); }
  const cs = rc.course, M = 0.6 * NMm;
  if (cs && !rc.box) {   // the whole course, with room round it
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of cs.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    rc.box = { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, half: Math.max(1.2 * NMm, (Math.max(x1 - x0, z1 - z0)) / 2 + M) };
  }
  if (!cs && (!rc.box || Math.hypot(v.x - rc.box.cx, v.z - rc.box.cz) > rc.box.half * 0.6)) rc.box = { cx: v.x, cz: v.z, half: 2.5 * NMm };   // round her, moving on as she sails out of it
  const dpr = Math.min(2, devicePixelRatio), size = rcEl.clientWidth;
  if (!size) return;
  if (rcEl.width !== Math.round(size * dpr)) rcEl.width = rcEl.height = Math.round(size * dpr);
  const c = rcCtx; c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const B = rc.box, k = (size - 22) / (2 * B.half), X = x => size / 2 + (x - B.cx) * k, Y = z => (size + 22) / 2 + (z - B.cz) * k;   // (below the line along the top)
  c.fillStyle = 'rgb(200,222,234)'; c.fillRect(0, 0, size, size);
  c.imageSmoothingEnabled = true; c.drawImage(rideLandFor(B, size, k), 0, 0, size, size);
  if (cs) {   // her course, dashed; for your route, the run so far solid
    c.lineWidth = 2; c.strokeStyle = '#a5741f'; c.setLineDash([5, 4]); c.beginPath();
    cs.pts.forEach(([x, z], i) => i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z))); c.stroke(); c.setLineDash([]);
    if (v === own) {
      c.lineWidth = 3; c.strokeStyle = '#7a4f0e'; c.beginPath(); c.moveTo(X(cs.pts[0][0]), Y(cs.pts[0][1]));
      for (let i = 1; i < own.cum.length && own.cum[i] < own.S; i++) c.lineTo(X(cs.pts[i][0]), Y(cs.pts[i][1]));
      c.lineTo(X(own.x), Y(own.z)); c.stroke();
    }
  }
  if (rc.trail.length > 1 && v !== own) {   // her wake on the chart, since you came aboard
    c.lineWidth = 2; c.strokeStyle = 'rgba(122,79,14,0.75)'; c.beginPath();
    rc.trail.forEach(([x, z], i) => i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z))); c.lineTo(X(v.x), Y(v.z)); c.stroke();
  }
  if (!cs) {   // no course: the way she's heading, a mile on
    const a = v.h * DEG; c.lineWidth = 1.5; c.strokeStyle = '#a5741f'; c.setLineDash([3, 4]); c.beginPath();
    c.moveTo(X(v.x), Y(v.z)); c.lineTo(X(v.x + Math.sin(a) * NMm), Y(v.z - Math.cos(a) * NMm)); c.stroke(); c.setLineDash([]);
  }
  // the places on her course, the next one in red
  const st = v.st, nextName = v.kind === 'ferry' && st ? (st.moving ? st.next : null) : null;
  c.font = '600 10.5px "Source Sans 3", system-ui, sans-serif'; c.textBaseline = 'middle';
  for (const p of cs?.places || []) {
    const x = X(p.x), y = Y(p.z), hot = p.name && (p.name === nextName || (v.kind !== 'ferry' && p.kind === 'stop'));
    c.fillStyle = p.kind === 'night' ? '#e0a843' : hot ? '#d0342c' : '#2fa35a'; c.strokeStyle = '#fbfcf8'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, y - 5); c.lineTo(x + 4, y); c.lineTo(x, y + 5); c.lineTo(x - 4, y); c.closePath(); c.fill(); c.stroke();
    if (!p.name) continue;
    const left = x > size * 0.62; c.textAlign = left ? 'right' : 'left';
    c.lineWidth = 3; c.strokeStyle = 'rgba(251,252,248,0.9)'; c.strokeText(p.name, x + (left ? -7 : 7), y);
    c.fillStyle = '#1d2a30'; c.fillText(p.name, x + (left ? -7 : 7), y);
  }
  // the other traffic, small
  for (const o of [...traffic, ...live]) if (o !== v && o.on) { const x = X(o.x), y = Y(o.z); if (x > 0 && y > 0 && x < size && y < size) { c.fillStyle = '#22324a'; c.beginPath(); c.arc(x, y, 2.2, 0, 7); c.fill(); } }
  // what you're looking at, then her
  const cx = X(v.x), cy = Y(v.z);
  if (!ORBITS(nest.mode)) {
    const look = v.h + nest.yaw, hf = 2 * Math.atan(Math.tan(camera.fov * DEG / 2) * camera.aspect) / DEG, a0 = (look - hf / 2 - 90) * DEG, a1 = (look + hf / 2 - 90) * DEG;
    c.fillStyle = 'rgba(214,162,74,0.25)'; c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, size * 0.18, a0, a1); c.closePath(); c.fill();
  }
  c.save(); c.translate(cx, cy); c.rotate(v.h * DEG);
  c.fillStyle = '#1d2a30'; c.strokeStyle = '#fbfcf8'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(0, -9); c.quadraticCurveTo(5, -2, 4, 7); c.lineTo(-4, 7); c.quadraticCurveTo(-5, -2, 0, -9); c.closePath(); c.fill(); c.stroke();
  c.restore();
  // where she's bound, along the top; north and the scale
  const line = rideLine(v);
  c.fillStyle = 'rgba(29,42,48,0.82)'; c.fillRect(0, 0, size, 20);
  c.fillStyle = '#f3efe4'; c.font = '600 11px "Source Sans 3", system-ui, sans-serif'; c.textAlign = 'left'; c.textBaseline = 'middle';
  let t = line; while (c.measureText(t).width > size - 12 && t.length > 4) t = t.slice(0, -2); if (t !== line) t = t.trimEnd() + '…';
  c.fillText(t, 6, 10.5);
  c.fillStyle = '#1d2a30'; c.textAlign = 'center'; c.textBaseline = 'top'; c.fillText('N', 13, 24);
  c.beginPath(); c.moveTo(13, 37); c.lineTo(9, 45); c.lineTo(17, 45); c.closePath(); c.fill();
  const nmBar = [0.25, 0.5, 1, 2, 5, 10].find(n => n * NMm * k > size * 0.18) || 10, bar = nmBar * NMm * k;
  c.fillRect(size - 10 - bar, size - 12, bar, 2.5);
  c.textAlign = 'right'; c.textBaseline = 'bottom'; c.font = '500 10px "JetBrains Mono", monospace'; c.fillText(`${nmBar} nm`, size - 10, size - 14);
  c.strokeStyle = 'rgba(20,35,42,0.35)'; c.lineWidth = 1; c.strokeRect(0.5, 0.5, size - 1, size - 1);
}

const REL = rel => {   // a bearing off the bow in a lookout's words
  const a = Math.abs(rel), side = rel > 0 ? 'starboard' : 'port';
  return a < 6 ? 'dead ahead' : a < 30 ? `fine on the ${side} bow` : a < 60 ? `on the ${side} bow` : a < 82 ? `broad on the ${side} bow` : a < 98 ? `abeam to ${side}` : a < 150 ? `abaft the ${side} beam` : a < 174 ? `on the ${side} quarter` : 'dead astern';
};
const KIND = { daysailer: 'a daysailer', pocket: 'a sloop', cruiser: 'a sloop', cd25: 'a sloop', schooner: 'a schooner', lobster: 'a lobster boat', angelique: 'a ketch' };
function lookoutReport() {
  if (!nest.on) return;
  const b = nest.v, from = ORBITS(nest.mode) ? (() => { const [lx, ly, lz] = helmOf(b), h = b.h * DEG; return { x: b.x + lx * Math.cos(h) - lz * Math.sin(h), y: ly, z: b.z + lx * Math.sin(h) + lz * Math.cos(h) }; })() : camera.position;
  const eye = Math.max(1.5, from.y), ex = from.x, ez = from.z;   // (from the drone: as from her helm)
  const inSight = (x, z, hgt) => {   // over the horizon? behind land?
    const d = Math.hypot(x - ex, z - ez);
    if (d / NMm > 2.08 * (Math.sqrt(eye) + Math.sqrt(Math.max(1, hgt)))) return null;
    for (let k = 0.04; k < 0.97; k += 0.02) {
      const px = ex + (x - ex) * k, pz = ez + (z - ez) * k, y = eye + (hgt - eye) * k - (d * k) * (d * (1 - k)) / (2 * 6.4e6 / 0.87);
      if (heightAt(lonOf(px), latOf(pz)) > y + 2) return null;
    }
    return d;
  };
  const seen = [];
  const add = (name, x, z, hgt, rank) => { const d = inSight(x, z, hgt); if (d != null && d > 150) seen.push({ name, d, rel: ((Math.atan2(x - ex, -(z - ez)) / DEG - b.h + 540) % 360) - 180, rank }); };
  for (const l of litNavs) if (l.name && /Light/.test(l.name)) add(l.name, l.x, l.z, l.hgt || 15, 0);
  for (const t of townList) add(t.short, t.x, t.z, 15, 1);
  for (const p of places) if (p.elev) add(p.n, p.x, p.z, p.elev, 2);
  for (const o of fleet) if (o !== b && Math.hypot(o.x - ex, o.z - ez) < 6 * NMm) add(o === bowdoin ? 'the schooner Bowdoin' : KIND[o.boat.type] || 'a vessel', o.x, o.z, o.boat.L > 20 ? 25 : 8, 3);   // vessels within 6 nm
  for (const o of traffic) if (o !== b && o.on && Math.hypot(o.x - ex, o.z - ez) < 8 * NMm) add(o.kind === 'ferry' ? `the ${o.F.called || (o.F.kind === 'cbl' ? 'Casco Bay Lines ferry' : (o.F.says || 'ferry').toLowerCase())} ${titleCase(o.F.vessel || '')}`.trim() : `a ${o.V.name}`, o.x, o.z, o.kind === 'cruise' ? 50 : 12, 3);
  for (const o of live) if (o !== b && o.on && Math.hypot(o.x - ex, o.z - ez) < 8 * NMm) add(`the ${o.what.toLowerCase()} ${aisName(o.A)}`, o.x, o.z, o.L > 100 ? 40 : o.L > 25 ? 14 : 6, 3);
  if (b !== own && own.r && own.boat.group.visible) add('your boat', own.x, own.z, 8, 3);
  const pickN = (rank, n) => seen.filter(o => o.rank === rank).sort((p, q) => p.d - q.d).slice(0, n);
  const list = [...pickN(3, 3), ...pickN(0, 3), ...pickN(1, 3), ...pickN(2, 2)];
  const nm = d => d < 926 ? `${Math.round(d / 0.9144 / 10) * 10} yards` : `${(d / NMm).toFixed(1)} nm`;
  const lines = list.map(o => `${o.name.charAt(0).toUpperCase() + o.name.slice(1)}, ${REL(o.rel)}, ${nm(o.d)}`);
  const horizon = 2.08 * Math.sqrt(eye);
  const head = env.foggy ? 'Fog all round; nothing in sight.' : lines.length ? `From ${nest.mode === 'nest' ? `${vName(b)}'s crow's nest` : b === own ? 'your helm' : vLen(b) > 30 && !b.boat ? `the bridge of ${vTitle(b)}` : `${b.boat ? 'the ' + vName(b).toLowerCase() : vName(b)}'s helm`}, ${Math.round(eye / 0.3048)} feet up, horizon ${horizon.toFixed(1)} miles:` : 'Nothing in sight but water.';
  nestRep.innerHTML = '';
  const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.title = 'Close'; x.addEventListener('click', () => { nestRep.textContent = ''; }); nestRep.appendChild(x);
  clearTimeout(lookoutReport.t); lookoutReport.t = setTimeout(() => { nestRep.textContent = ''; }, 45000);   // (off the view after a while)
  const h = document.createElement('div'); h.className = 'head'; h.textContent = head; nestRep.appendChild(h);
  if (!env.foggy) for (const t of lines) { const li = document.createElement('div'); li.textContent = t; nestRep.appendChild(li); }
  shrinkable(nestRep);
  try { window.parent?.__audioChartViews?.say?.((env.foggy ? head : lines.length ? 'Lookout reports: ' + lines.join('. ') : head) + '.'); } catch (_) {}
}
if (nestOK) {
document.getElementById('crowsnest').addEventListener('click', () => nest.on && nest.mode === 'nest' && nest.v === bowdoin ? leaveRide() : ride(bowdoin, 'nest'));
document.getElementById('nestdown').addEventListener('click', leaveRide);
for (const [id, m] of RIDE_BTNS) document.getElementById(id)?.addEventListener('click', () => ride(nest.v, m));
document.getElementById('nestreport').addEventListener('click', lookoutReport);
// Following a boat (v969, requested: "add them while following too"): a bar naming her, with Helm, Drone, Stern,
// Side and Bow to go aboard or round her from here, and ✕ to stop following. Your own boat too (v970, requested:
// "add Stern, Side and Bow for my own boat too").
const followHud = document.getElementById('followhud');
if (followHud) {
  shrinkable(followHud);
  for (const ev of ['pointerdown', 'wheel', 'touchstart']) followHud.addEventListener(ev, e => e.stopPropagation(), { passive: true });
  for (const b of followHud.querySelectorAll('button[data-m]')) b.addEventListener('click', () => { if (follow) ride(follow, b.dataset.m); });
  document.getElementById('followstop').addEventListener('click', stopFollow);
  const fc = document.getElementById('followchart');
  fc.hidden = !chartHook(); fc.addEventListener('click', () => follow && showOnChart(follow));
  setInterval(() => {   // her nearest mark, its bearing from her and range (v1000)
    const el = document.getElementById('followfix'), v = !followHud.hidden && follow;
    el.textContent = v ? (o => o ? `${o.m.n} bears ${fixBrg(o)}, ${fixRange(o.d)}` : '')(marksNear(v.x, v.z, 1)[0]) : '';
  }, 1000);
}
syncFollowHud = function sync() {   // every frame: cheap unless who's followed changes
  if (!followHud) return;
  const v = follow && !nest.on && vGroup(follow).visible ? follow : null;
  if (v === sync.v) return;
  sync.v = v; followHud.hidden = !v;
  if (v) followHud.querySelector('#followname').textContent = `Following ${vName(v)}${v === own ? ' (yours)' : v.kind === 'ferry' || v.kind === 'ais' ? ' · ' + v.label : ''}`;
};
document.getElementById('bowdoinbtn').addEventListener('click', () => {
  if (!bowdoin) return;
  if (nest.on) leaveRide();
  markCurrent(null); foldPanel(true);
  if (aboveFog || env.foggy) applyConditions({ vis: 'clear' });
  follow = bowdoin; document.getElementById('sailboat').classList.add('on');
  flyTo({ x: bowdoin.x, z: bowdoin.z, dist: 160, tilt: 64 * DEG, az: (bowdoin.h + 35) * DEG }, 3000);
});
  // shown while there's a Bowdoin to go to: the fleet's, or yours when she's on the water here
  const syncNestBtns = () => { const has = !!bowdoin?.boat.group.visible; for (const id of ['crowsnest', 'bowdoinbtn']) document.getElementById(id).hidden = !has && !nest.on; };
  syncNestBtns(); setInterval(syncNestBtns, 1000);
}

function updateFleet(dt) {
  const up = env.W.heel > 0, heel = env.W.heel * DEG, cp = camera.position, show = !aboveFog;
  const FLEET_K = clamp(view.dist / 150, 1, 20);
  const realBowdoin = live.some(v => v.W?.model === 'bowdoin');   // (the real one's out there: she stands aside)
  for (const b of fleet) {
    b.boat.group.visible = show && !(b === bowdoin && realBowdoin);
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
    b.boat.wake(0); b.going = go;   // (its wake is in the water: updateWakes)
    { const d = Math.hypot(b.x - cp.x, cp.y, b.z - cp.z); b.boat.group.scale.setScalar(nest.on && (b === nest.v || d < 1500) ? 1 : boatScale(b.boat, d)); }   // never smaller than 1.6×: the closest you can come is ~120 m (but life-size round you when you're aboard a vessel)
    b.boat.group.position.set(b.x, 0, b.z);
    b.boat.group.rotation.y = -b.h * DEG;
  }
}

// ── Ferries and cruise ships (v933, requested: "the occasional cruise ship traffic", and "whatever ferries or
// cruise ships we show are on realistic courses"). By the real clock: the Fox Islands ferries back and forth on
// their charted lines (data/ferries.json, from OpenStreetMap) through the day, and on a call day a cruise ship
// in from the sea to her anchorage for the day and out again in the evening, or a small one between ports,
// on tracks the router planned at her draft (data/cruise_ships.json). Not in Empty Bay: nothing afloat there.
// ?cruise=<call id>|all and ?clock=HH:MM are for testing.
const traffic = [], trafficLit = [];
const FORCE_CRUISE = params.get('cruise') || '';
// The scene's clock (v934, the user's idea: "put a clock on the screen, and turn it to the time the ferry or
// cruise ship will pass by"): the real time to begin with (or ?clock=HH:MM); the 🕗 panel sets it, runs it
// faster, and lists what's coming, each a jump to that moment and that vessel. Once you've set it, the light
// follows it too (the sun's height then: night, dawn, day or sunset), until you pick a Time in the weather panel.
const realMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
const simClock = { base: (() => { const c = params.get('clock'); return c && /^\d\d?:\d\d$/.test(c) ? mins(c) : realMin(); })(), at: performance.now(), rate: 1, light: false };
// Linked to your boat (v936, requested: "link the two clocks"): while she sails a route (▶ Sail it, or a
// Virtual Journey) the clock is her time on passage from when she left, so you meet each ferry when you
// would; moving the clock yourself lets go of her.
let boatClock = null;   // () => minutes; set by your boat's code below
const clockMin = () => Math.max(0, Math.min(1439.9, boatClock ? boatClock() : simClock.base + (performance.now() - simClock.at) / 60000 * simClock.rate));
function setClock(min, rate = simClock.rate, byUser = true) {
  boatClock = null;
  Object.assign(simClock, { base: Math.max(0, Math.min(1439.9, min)), at: performance.now(), rate });
  if (byUser) { simClock.light = true; lightForClock(); }
  syncClock();
}
function lightForClock() {   // the weather panel's time of day, from where the sun is at the scene's time
  if (!simClock.light) return;
  const m = clockMin(), d = new Date(); d.setHours(Math.floor(m / 60), Math.floor(m % 60), 0, 0);
  const sp = sunPos(latOf(view.z), lonOf(view.x), d);
  const time = sp.alt < -6 ? 'night' : sp.alt < 6 ? (sp.brg < 180 ? 'dawn' : 'sunset') : 'day';
  if (time !== env.C.time) applyConditions({ time });
}
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
if (!EMPTY) Promise.all([getJSON('./data/ferries.json').catch(() => null), getJSON('./data/cruise_ships.json').catch(() => null), getJSON('./data/windjammers.json').catch(() => null)]).then(([fd, cd, wd]) => {
  // (live AIS: the ferries' and the windjammers' full names, and what they are)
  // (a ferry run to a timetable has several boats, each her own name and length: F.boats, v993)
  const boatsOf = F => F.boats ? F.boats.map((b, bi) => ({ ...F, ...b, bi })) : [F];
  setKnown(knownList(fd, wd));
  const here = P => P.some(([lo, la]) => inBay([lo, la]));   // (this bay's: v992)
  for (const F of (fd?.ferries || []).filter(F => here(ferryLine(F))).flatMap(boatsOf)) {
    const T = trackOf(ferryLine(F), wx, wz), group = (F.kind === 'launch' ? launchModel : (F.kind === 'cbl' || F.kind === 'ctc') ? cblModel : ferryModelSimple)(F, trafficLit); group.visible = false; scene.add(group);
    traffic.push({ kind: 'ferry', F, T, group, L: F.length_m || 46, x: T.P[0][0], z: T.P[0][1], on: false, label: '' });
  }
  for (const call of callsOn(cd, new Date(), FORCE_CRUISE).filter(c => here(c.track))) {
    const V = cd.vessels[call.vessel], T = trackOf(call.track, wx, wz), group = cruiseShipModel(V, trafficLit); group.visible = false; scene.add(group);
    traffic.push({ kind: 'cruise', call, V, T, group, L: V.length_m, x: T.P[0][0], z: T.P[0][1], on: false, label: '' });
    console.log(`[bay3d] cruise ship today: ${call.id}`);
  }
  for (const v of traffic) if (v.kind === 'ferry' && v.F.slips) for (const end of ['from', 'to']) {
    const sp = v.F.slips[end]; if (!sp) continue;
    const group = ferrySlipModel(Math.min(12.2, v.L * 0.26), v.L); scene.add(group);
    const sl = { v, name: v.F[end], brg: sp.brg, x0: wx(sp.lon), z0: wz(sp.lat), x: wx(sp.lon), z: wz(sp.lat), group, fitN: -1 };
    slips.push(sl); placeSlip(sl);
  }
  centralPiers();
}).catch(err => console.warn('[bay3d] traffic', err)).finally(() => slipsReadyResolve());
if (EMPTY) slipsReadyResolve();
// ── The Maine State ferry slips (v943, on request: "The dock for this ferry looks unrealistic ... These large Maine
// State ferries have characteristic tall green gantries"): at each end of the car ferries' runs a slip
// (vessels.js ferrySlipModel: wing walls, the transfer bridge and its green lift gantry), its head and the bearing
// out of it from data/ferries.json (from OpenStreetMap). Where the drawn ground puts the head ashore, the slip moves
// out along its bearing to the water's edge, once the detailed ground there has loaded. A ferry waiting at a slip
// lies in it, her stern (the car ramp) at the bridge and her bow to the sea.
function placeSlip(sl) {
  sl.group.position.set(sl.x, 0, sl.z); sl.group.rotation.y = -sl.brg * DEG;
}
function fitSlips() {
  let moved = false;
  const ready = tiles.filter(T => T.state === 'ready').length;
  for (const sl of slips) {
    sl.group.visible = !aboveFog && !EMPTY;
    if (sl.fitN === ready) continue;
    const lon = lonOf(sl.x0), lat = latOf(sl.z0);
    if (!tiles.some(T => T.state === 'ready' && lon >= T.w && lon < T.e && lat >= T.s && lat < T.n)) continue;   // (the detail isn't here yet)
    sl.fitN = ready;
    const ux = Math.sin(sl.brg * DEG), uz = -Math.cos(sl.brg * DEG);
    let lastLand = -Infinity;
    for (let d = -30; d <= 45; d += 3) if (elevSmooth(lonOf(sl.x0 + ux * d), latOf(sl.z0 + uz * d)) > 0.3) lastLand = d;
    const d = lastLand >= 0 ? lastLand + 3 : 0;
    sl.x = sl.x0 + ux * d; sl.z = sl.z0 + uz * d; placeSlip(sl); moved = true;
  }
  if (moved) centralPiers();
}
// a point in a slip's own frame: lx across it (+ to starboard looking out to sea), t out along it from its head
function slipLocal(sl, X, Z) { const h = sl.brg * DEG, dx = X - sl.x, dz = Z - sl.z; return { lx: dx * Math.cos(h) + dz * Math.sin(h), t: dx * Math.sin(h) - dz * Math.cos(h) }; }
function slipWorld(sl, lx, t) { const h = sl.brg * DEG; return [sl.x + lx * Math.cos(h) + t * Math.sin(h), sl.z + lx * Math.sin(h) - t * Math.cos(h)]; }
function inSlip(sl, X, Z) { const { W, WL } = sl.group.userData.walls, p = slipLocal(sl, X, Z); return Math.abs(p.lx) < W / 2 + 6 && p.t > -26 && p.t < WL + 6; }
// Two slips side by side (Rockland's; v949, requested: "add piers for the Rockland ferry terminal"): a planked pier
// on piles fills the water between their inner fender piers, out to the shorter one's end, as at the real terminal.
let centralGroups = [];
function centralPiers() {
  for (const gp of centralGroups) { scene.remove(gp); gp.traverse(o => o.geometry?.dispose()); }
  centralGroups = [];
  const plankM = new THREE.MeshLambertMaterial({ color: 0x8a7a64 }), pileM = new THREE.MeshLambertMaterial({ color: 0x4b4136 });
  for (let i = 0; i < slips.length; i++) for (let j = i + 1; j < slips.length; j++) {
    const A = slips[i], B = slips[j]; if (Math.hypot(A.x - B.x, A.z - B.z) > 40) continue;
    const wa = A.group.userData.walls, wb = B.group.userData.walls, sa = slipLocal(A, B.x, B.z).lx > 0 ? 1 : -1, sb = slipLocal(B, A.x, A.z).lx > 0 ? 1 : -1;
    const wallX = (w, sx, t) => sx * (w.W / 2 + w.FL * Math.max(0, (t - w.WL * 0.7) / (w.WL * 0.3)) ** 2 + 1.4);
    const L = Math.min(wa.WL, wb.WL) * 0.95, pa = [], pb = [];
    for (let t = 0; t <= L + 0.01; t += L / 12) { pa.push(slipWorld(A, wallX(wa, sa, t), t)); pb.push(slipWorld(B, wallX(wb, sb, t), t)); }
    if (Math.hypot(pa[0][0] - pb[0][0], pa[0][1] - pb[0][1]) < 1.5) continue;   // (walls already touching)
    const poly = [...pa, ...pb.reverse()], sh = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.35, bevelEnabled: false }); geo.rotateX(-Math.PI / 2); geo.translate(0, 4.05, 0);
    const gp = new THREE.Group(); gp.add(new THREE.Mesh(geo, plankM));
    const xs = poly.map(p => p[0]), zs = poly.map(p => p[1]), inside = (x, z) => { let c = false; for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) { const [xi, zi] = poly[a], [xj, zj] = poly[b]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
    const pg = []; for (let x = Math.min(...xs); x <= Math.max(...xs); x += 4) for (let z = Math.min(...zs); z <= Math.max(...zs); z += 4) if (inside(x, z)) { const c = new THREE.CylinderGeometry(0.28, 0.28, 6.5, 6); c.translate(x, 0.8, z); pg.push(c); }
    for (const c of pg) gp.add(new THREE.Mesh(c, pileM));
    scene.add(gp); centralGroups.push(gp);
  }
}
// The shore side of each terminal (v950, requested: "add piers for the other ferry terminals too"): where the town
// data has no terminal of its own (Rockland's has; Vinalhaven's has its office), the staging lot behind the slip,
// its lanes running down to her, and beside it the ticket office, both found on the drawn ground clear of the
// town's buildings, and the road from the transfer bridge up to the lot. Placed once the slip is fitted and the
// detail and the town there have loaded, and again when either changes.
function townBuildingsNear(x, z, r) {
  const out = [];
  for (const t of townList) if (t.data && Math.hypot(t.x - x, t.z - z) < 6000) for (const b of t.data.buildings) {
    const P = b.p.map(([lo, la]) => [wx(lo), wz(la)]), cx = P.reduce((a, p) => a + p[0], 0) / P.length, cz = P.reduce((a, p) => a + p[1], 0) / P.length;
    if (Math.hypot(cx - x, cz - z) < r) out.push({ x: cx, z: cz, r: Math.max(...P.map(p => Math.hypot(p[0] - cx, p[1] - cz))), n: b.n || '' });
  }
  return out;
}
function terminalFor(sl) {
  if (sl.term) { scene.remove(sl.term); disposeGroup(sl.term); for (const m of sl.termLit || []) trafficLit.splice(trafficLit.indexOf(m), 1); sl.term = null; }
  if (slips.some(o => o !== sl && o.term && Math.hypot(o.x - sl.x, o.z - sl.z) < 60)) return;   // (two slips side by side share one)
  const blds = townBuildingsNear(sl.x, sl.z, 400);
  if (blds.some(b => /ferry terminal/i.test(b.n) && Math.hypot(b.x - sl.x, b.z - sl.z) < 200)) return;   // the town has the whole terminal
  const office = !blds.some(b => /ferr/i.test(b.n) && Math.hypot(b.x - sl.x, b.z - sl.z) < 200);
  const el = (lx, t) => { const [X, Z] = slipWorld(sl, lx, t); return elevSmooth(lonOf(X), latOf(Z)); };
  // a rectangle w across by l along the slip's line, centred at (lx, t): its ground, or null where it isn't dry and level and clear
  const site = (lx, t, w, l) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) { const e = el(lx + (i / 4 - 0.5) * w, t + (j / 4 - 0.5) * l); if (!(e > 2)) return null; lo = Math.min(lo, e); hi = Math.max(hi, e); }
    if (hi - lo > 3.5) return null;
    for (const b of blds) { const p = slipLocal(sl, b.x, b.z); if (Math.abs(p.lx - lx) < w / 2 + b.r + 3 && Math.abs(p.t - t) < l / 2 + b.r + 3) return null; }
    return { lo, hi };
  };
  const LW = 24, LL = 40;
  let best = null;
  for (let t = -(26 + LL / 2 + 2); t >= -150; t -= 6) for (let lx = -64; lx <= 64; lx += 8) {
    const score = Math.hypot(lx * 1.5, t + 26); if (best && score >= best.score) continue;
    const s = site(lx, t, LW, LL); if (s) best = { lx, t, score, ...s };
  }
  if (!best) return;
  const g = new THREE.Group(), lit = [], ry = -sl.brg * DEG;
  const put = (obj, lx, t, y, rot = 0) => { const [X, Z] = slipWorld(sl, lx, t); obj.position.set(X, y, Z); obj.rotation.y = ry + rot; g.add(obj); };
  // (the lot's lanes run along the slip's line, its stop line at the end toward her)
  put(terminalLot(LW, LL, Math.round(Math.abs(sl.x0)) + 7, lit), best.lx, best.t, best.hi + 0.12, 0);
  if (office) for (const side of [1, -1]) {   // the office beside the lot, at its end toward the slip
    const lx = best.lx + side * (LW / 2 + 7), t = best.t + LL / 2 - 6, s = site(lx, t, 9, 16);
    if (s) { put(terminalHouse(lit), lx, t, s.hi, side * Math.PI / 2); break; }
  }
  // the road from the bridge's shore end up to the lot, on a causeway of fill with rip-rap sides where it crosses
  // the water or the low shore
  const a = [0, -27], b = [best.lx, best.t + LL / 2], dl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, n = Math.max(2, Math.ceil(dl / 3));
  const ux = (b[0] - a[0]) / dl, ut = (b[1] - a[1]) / dl, top = [], sides = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, lx = a[0] + (b[0] - a[0]) * f, t = a[1] + (b[1] - a[1]) * f;
    const y = i === n ? best.hi + 0.13 : Math.max(el(lx, t) + 0.15, 3.6 + (best.hi + 0.13 - 3.6) * f ** 2), foot = Math.min(el(lx, t), y) - 0.5, spread = 3.6 + Math.max(0, y - foot) * 1.3;
    for (const s of [-1, 1]) {
      const [X, Z] = slipWorld(sl, lx - s * ut * 3.6, t + s * ux * 3.6); top.push(X, y, Z);
      const [X2, Z2] = slipWorld(sl, lx - s * ut * spread, t + s * ux * spread); sides.push(X, y, Z, X2, foot, Z2);
    }
  }
  const strip = (pos, stride, quads) => { const idx = []; for (let i = 0; i < n; i++) for (const [p, q] of quads) { const k = i * stride; idx.push(k + p, k + q, k + stride + p, k + q, k + stride + q, k + stride + p); } const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals(); return geo; };
  g.add(new THREE.Mesh(strip(top, 2, [[0, 1]]), new THREE.MeshLambertMaterial({ color: 0x55585b, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 })));
  g.add(new THREE.Mesh(strip(sides, 4, [[0, 1], [2, 3]]), new THREE.MeshLambertMaterial({ color: 0x8e8a82, side: THREE.DoubleSide })));
  trafficLit.push(...lit); sl.termLit = lit; sl.term = g; scene.add(g);
}
function fitTerminals() {
  if (EMPTY) return;
  for (const sl of slips) {
    if (sl.term) sl.term.visible = !aboveFog;
    if (sl.fitN < 0) continue;
    const towns = townList.filter(t => t.data && Math.hypot(t.x - sl.x, t.z - sl.z) < 6000).length, key = sl.fitN + ':' + towns + ':' + sl.x.toFixed(1);
    if (sl.termKey !== key) { sl.termKey = key; terminalFor(sl); }
  }
}
setInterval(fitSlips, 2000);
setInterval(fitTerminals, 2500);
const slipFor = (v, name) => slips.find(sl => sl.v === v && sl.name === name);
// Alongside at the landings (v941, reported with a screenshot: the mail boat lay on top of the Northeast Harbor
// pier, where OpenStreetMap's ferry line begins). Where a town's piers are loaded (data/buildings), a ferry waiting
// at a landing lies alongside the pier or wharf edge nearest it, on whichever side is open water clear of the other
// piers, bow the way her line runs; leaving and coming in she eases between that berth and her line over 150 m.
// Where there are no piers in the data (or none near), she stays on her line as before.
function ferryStops(v) {
  if (v.stopsF) return v.stopsF;
  const T = v.T, at = (lon, lat) => { const x = wx(lon), z = wz(lat); let bi = 0, bd = Infinity; T.P.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - z); if (d < bd) { bd = d; bi = i; } }); return T.c[bi]; };
  const list = [{ name: v.F.from, f: 0 }, ...(v.F.stops || []).filter(st => !st.summer || ferryLine(v.F) === v.F.summer_line).map(st => ({ name: st.name, f: at(st.lon, st.lat) })), { name: v.F.to, f: T.L }];
  return (v.stopsF = list.map(st => { const p = alongTrack(T, st.f); return { ...st, x: p.x, z: p.z, hdg: p.hdg }; }));
}
function pierSegs(x, z, r) {   // the pier and wharf edges within r metres: {ax, az, bx, bz, w, berth}
  const out = [];
  for (const t of townList) {
    if (!t.data?.piers || Math.hypot(t.x - x, t.z - z) > 15000) continue;
    for (const pr of t.data.piers) {
      const P = pr.p.map(([lo, la]) => [wx(lo), wz(la)]), w = pr.area ? 0 : (pr.w || 3), berth = pr.kind !== 'breakwater';
      const n = pr.area ? P.length : P.length - 1;
      for (let i = 0; i < n; i++) {
        const [ax, az] = P[i], [bx, bz] = P[(i + 1) % P.length];
        if (segDist(x, z, ax, az, bx, bz) < r) out.push({ ax, az, bx, bz, w, berth });
      }
    }
  }
  return out;
}
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1, t = clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}
function findBerth(v, stop) {
  const L = vLen(v), B = Math.min(12.2, L * 0.28), obst = pierSegs(stop.x, stop.z, 100 + L), cands = obst.filter(g => g.berth && segDist(stop.x, stop.z, g.ax, g.az, g.bx, g.bz) < 80);
  if (!townList.some(t => t.data && Math.hypot(t.x - stop.x, t.z - stop.z) < 15000)) return undefined;   // no town data here yet: ask again later
  let best = null;
  for (const g of cands) {
    const len = Math.hypot(g.bx - g.ax, g.bz - g.az); if (len < 5) continue;
    const ux = (g.bx - g.ax) / len, uz = (g.bz - g.az) / len, tp = clamp(((stop.x - g.ax) * ux + (stop.z - g.az) * uz), 0, len);
    for (const side of [-1, 1]) for (const dt of [0, -L / 3, L / 3, -L * 0.7, L * 0.7]) {
      const t = clamp(tp + dt, Math.min(len / 2, L * 0.35), Math.max(len / 2, len - L * 0.35)), off = g.w / 2 + B / 2 + 1;
      const cx = g.ax + ux * t - uz * side * off, cz = g.az + uz * t + ux * side * off;
      let ok = true;
      for (let a = -0.5; a <= 0.5 && ok; a += 0.25) for (const b of [-0.5, 0, 0.5]) {   // her hull: open water, clear of every pier
        const px = cx + ux * a * L - uz * b * B, pz = cz + uz * a * L + ux * b * B;
        if (!isWater(px, pz) || obst.some(o => o !== g && segDist(px, pz, o.ax, o.az, o.bx, o.bz) < o.w / 2 + 0.8) || segDist(px, pz, g.ax, g.az, g.bx, g.bz) < g.w / 2 + 0.5) { ok = false; break; }
      }
      if (!ok) continue;
      const score = Math.hypot(cx - stop.x, cz - stop.z) + Math.abs(dt) * 0.2;
      if (!best || score < best.score) {
        const h = Math.atan2(ux, -uz) / DEG, d = ((stop.hdg - h + 540) % 360) - 180;   // bow the way her line runs there
        best = { x: cx, z: cz, h: Math.abs(d) <= 90 ? h : h + 180, score };
      }
    }
  }
  return best;
}
function berthOf(v, stop) {
  const sl = slipFor(v, stop.name);
  if (sl) { const ux = Math.sin(sl.brg * DEG), uz = -Math.cos(sl.brg * DEG), k = vLen(v) / 2 + 0.6; return { x: sl.x + ux * k, z: sl.z + uz * k, h: sl.brg }; }   // in her slip
  v.berths ||= {};
  const b = v.berths[stop.name], now = performance.now();
  if (b && (b.pose || now - b.t < 5000)) return b.pose;
  const pose = findBerth(v, stop) || null;   // (none yet: look again in a while, as the town and the detailed ground load)
  v.berths[stop.name] = { pose, t: now };
  return pose;
}
function berthPose(v, st) {
  const stops = ferryStops(v), near = f => stops.reduce((a, b) => Math.abs(b.f - f) < Math.abs(a.f - f) ? b : a);
  const ease = (bp, w) => {   // w 0 at the berth, 1 on her line
    const k = w * w * (3 - 2 * w), dh = ((v.h - bp.h + 540) % 360) - 180;
    v.x = bp.x + (v.x - bp.x) * k; v.z = bp.z + (v.z - bp.z) * k; v.h = bp.h + dh * k;
  };
  if (!st.moving) { const bp = berthOf(v, near(st.f)); if (bp) ease(bp, 0); return; }
  const R = 150, dFrom = Math.abs(st.f - st.f0), dTo = Math.abs(st.f1 - st.f);
  if (dFrom < R) { const bp = berthOf(v, near(st.f0)); if (bp) ease(bp, dFrom / R); }
  else if (dTo < R) { const bp = berthOf(v, near(st.f1)); if (bp) ease(bp, dTo / R); }
}
function updateTraffic() {
  const minute = clockMin(), cp = camera.position, lk = env.lightsK || 0;
  for (const m of trafficLit) m.emissiveIntensity = lk;
  let anyCruise = false;
  for (const v of traffic) {
    const st = liveOK ? null : v.kind === 'ferry' ? ferryState(v.F, v.T, minute) : cruiseState(v.call, v.V, v.T, minute);   // (live AIS: the real ones instead)
    v.on = !!st && !aboveFog; v.group.visible = v.on; v.st = st;
    if (!st) continue;
    const p = alongTrack(v.T, st.f), hdg = st.dir > 0 ? p.hdg : p.hdg + 180;
    v.x = p.x; v.z = p.z; v.h = hdg;
    if (v.kind === 'ferry') berthPose(v, st);   // alongside at a landing, not on the pier where her line begins (v941)
    v.group.position.set(v.x, 0, v.z); v.group.rotation.y = -v.h * DEG;
    for (const w of v.group.userData.wake) w.visible = false;   // (her wake is in the water: updateWakes)
    // drawn a little bigger from far off, as the sailboats are (less: she's big already)
    v.group.scale.setScalar(nest.on && nest.v === v ? 1 : Math.max(1, Math.min(v.kind === 'cruise' ? 3 : 8, Math.hypot(p.x - cp.x, cp.y, p.z - cp.z) / 250 * Math.sqrt(8 / v.L) * 0.6)));
    v.label = v.kind === 'ferry' ? `${v.F.says || 'Ferry'} ${st.moving ? 'to ' + st.bound : 'at ' + st.at}` : `${v.V.name[0].toUpperCase() + v.V.name.slice(1)}, ${st.doing}`;
    if (v.kind === 'cruise' && v.on) anyCruise = true;
  }
  const btn = document.getElementById('cruisebtn'); if (btn) btn.hidden = !anyCruise;
}
document.getElementById('cruisebtn')?.addEventListener('click', () => {
  const v = traffic.find(o => o.kind === 'cruise' && o.on); if (!v) return;
  markCurrent(null); foldPanel(true);
  flyTo({ x: v.x, z: v.z, dist: Math.max(900, v.L * 4), tilt: 58 * DEG, az: ((v.h || 0) + 40) * DEG }, 3000);
  follow = v;
});

// What's coming today: the ferries' departures and the cruise ships' arrivals and departures, by the scene's clock
const cap = t => t[0].toUpperCase() + t.slice(1);
function trafficEvents() {
  const ev = [];
  for (const v of traffic) {
    if (v.kind === 'ferry') {
      for (const d of ferryDepartures(v.F, v.T)) ev.push({ t: d.t, v, text: `${v.F.says || 'Ferry'} leaves ${d.from} for ${d.to}` });
    } else {
      const c = v.call, nm = cap(v.V.name), run = v.T.L / (v.V.knots * 1852 / 60);
      if (c.arrive) ev.push({ t: mins(c.arrive) - run, v, text: `${nm} comes in from the sea, bound for ${c.port}` },
        { t: mins(c.arrive), v, text: `${nm} anchors ${c.where.replace(/^at anchor /, '')}` },
        { t: mins(c.depart), v, text: `${nm} weighs anchor and puts to sea` });
      else ev.push({ t: mins(c.leave), v, text: `${nm} ${c.where.replace(/^bound/, 'leaves')}`.replace(' to ', ' for ') });
    }
  }
  return ev.sort((a, b) => a.t - b.t);
}
const clockBtn = document.getElementById('clockbtn'), clockPanel = document.getElementById('clockpanel');
function syncClock() {
  if (!clockBtn) return;
  const m = clockMin();
  clockBtn.textContent = `🕗 ${hhmm(m)}${boatClock ? ' ⛵' : simClock.rate > 1 ? ` ×${simClock.rate}` : ''}`;
  if (clockPanel.hidden) return;
  clockPanel.querySelector('#clocktime').textContent = hhmm(m);
  clockPanel.querySelector('#clocklink').hidden = !boatClock;
  const sl = clockPanel.querySelector('#clockslider'); if (document.activeElement !== sl) sl.value = String(Math.round(m));
  for (const b of clockPanel.querySelectorAll('[data-rate]')) b.classList.toggle('on', !boatClock && Number(b.dataset.rate) === simClock.rate);
}
function fillComing() {
  const list = clockPanel.querySelector('#coming'), m = clockMin(), next = trafficEvents().filter(e => e.t >= m - 1).slice(0, 7);
  list.innerHTML = '';
  if (!next.length) { list.innerHTML = '<li class="none">Nothing more on the water today</li>'; return; }
  for (const e of next) {
    const li = document.createElement('li'), btn = document.createElement('button'); btn.type = 'button';
    btn.innerHTML = `<b>${hhmm(e.t)}</b> ${e.text}`;
    btn.addEventListener('click', () => {   // a couple of minutes before, at the vessel, following her
      if (!boatClock) setClock(e.t - 2);   // (with your boat's clock: where the vessel is now, the time kept)
      const t = boatClock ? clockMin() : e.t + 1;
      const st = e.v.kind === 'ferry' ? ferryState(e.v.F, e.v.T, t) : cruiseState(e.v.call, e.v.V, e.v.T, t);
      if (st) {
        const p = alongTrack(e.v.T, st.f), hdg = st.dir > 0 ? p.hdg : p.hdg + 180;
        markCurrent(null); foldPanel(true);
        flyTo({ x: p.x, z: p.z, dist: Math.max(700, e.v.L * 4), tilt: 58 * DEG, az: (hdg + 40) * DEG }, 2500);
        follow = e.v;
      }
      fillComing();
    });
    li.appendChild(btn); list.appendChild(li);
  }
}
if (clockBtn && !EMPTY) {
  clockBtn.hidden = false;
  clockBtn.addEventListener('click', () => {
    clockPanel.hidden = !clockPanel.hidden;
    if (!clockPanel.hidden) { clockPanel.openOut?.(); const wx = document.getElementById('wxpanel'); if (wx) wx.hidden = true; fillComing(); syncClock(); }
  });
  for (const ev of ['pointerdown', 'wheel', 'touchstart']) clockPanel.addEventListener(ev, e => e.stopPropagation(), { passive: true });
  clockPanel.querySelector('#clockslider').addEventListener('input', e => { setClock(Number(e.target.value)); fillComing(); });
  clockPanel.querySelector('#clocknow').addEventListener('click', () => { setClock(realMin(), 1); fillComing(); });
  for (const b of clockPanel.querySelectorAll('[data-rate]')) b.addEventListener('click', () => setClock(clockMin(), Number(b.dataset.rate)));
  setInterval(() => { syncClock(); lightForClock(); if (!clockPanel.hidden && (simClock.rate > 1 || boatClock)) fillComing(); }, 1000);
}

// ── ⛴ Underway (v937, requested: "in the table of active ferries and craft, there would be a place to click to
// zoom to that boat"): what's on the water now: your boat, the ferries and cruise ships (by the scene's clock),
// Bowdoin, and the sailboats and lobster boats nearest where you're looking. Each: Helm, aboard at her helm;
// Drone, by drone over her; Follow, fly over and follow her in this view.
const uwBtn = document.getElementById('underwaybtn'), uwPanel = document.getElementById('underway');
// when she's due (v942, requested: "for ferries, please add a column for ETA"): a ferry under way, at her next
// landing; one alongside, when she leaves; a cruise ship bound in, at her anchorage or port; your boat with the
// clock linked to her, at the end of her route. {t: 'HH:MM', sub: what it's for}
function vEta(v) {
  const now = clockMin(), st = v.st;
  if (v.kind === 'ferry' && st) {
    if (!st.moving) { const nx = ferryDepartures(v.F, v.T).find(d => d.t >= now - 0.01); return nx ? { t: hhmm(nx.t), sub: 'leaves' } : null; }
    const nx = ferryStops(v).find(p => p.name === st.next), left = nx ? Math.abs(nx.f - st.f) : 0;
    return { t: hhmm(now + left / (v.F.knots * NMm / 60)), sub: st.next };
  }
  if (v.kind === 'cruise' && st?.moving && st.dir > 0) return { t: hhmm(now + (v.T.L - st.f) / (v.V.knots * NMm / 60)), sub: v.call.port };
  if (v === own && own.r && boatClock && own.S < own.total) return { t: hhmm(Math.min(1439, now + passageMin(own.total) - passageMin(own.S))), sub: 'arrives' };
  return null;
}
function fillUnderway() {
  const list = uwPanel.querySelector('ul'); list.innerHTML = '<li class="hdr"><span class="n">Vessel</span><span class="eta">ETA</span><span class="d">Off</span><span class="go"></span></li>';
  const away = v => { const d = Math.hypot(v.x - view.x, v.z - view.z) / NMm; return d < 0.15 ? '' : `${d.toFixed(d < 10 ? 1 : 0)} nm`; };
  const rows = [], d2 = b => Math.hypot(b.x - view.x, b.z - view.z);
  if (own.r && own.boat.group.visible) rows.push({ v: own, what: own.vj ? 'On your Virtual Journey' : own.playing ? 'Under way on your route' : own.S >= own.total ? 'Arrived' : 'Ready on your route' });
  for (const v of traffic) if (v.on) rows.push({ v, what: v.kind === 'cruise' ? v.label.replace(/^[^,]*, /, '') : v.label });
  for (const v of live.filter(o => o.on).sort((a, b) => d2(a) - d2(b)).slice(0, 12)) rows.push({ v, what: `📡 ${v.label}` });
  if (bowdoin && bowdoin !== own && bowdoin.boat.group.visible) rows.push({ v: bowdoin, what: 'Schooner, out of Castine' });
  for (const v of fleet.filter(b => b !== bowdoin && b.boat.group.visible).sort((a, b) => d2(a) - d2(b)).slice(0, 6)) rows.push({ v, what: vDoing(v) });
  if (!rows.length) { list.innerHTML = '<li class="none">Nothing on the water in sight</li>'; return; }
  for (const r of rows) {
    const li = document.createElement('li'), v = r.v;
    if (nest.on && nest.v === v) li.className = 'aboard';
    li.innerHTML = '<span class="n"><b></b> <small></small></span><span class="eta"><b></b><small></small></span><span class="d"></span><span class="go"><button type="button" data-m="helm" title="Aboard her, at the helm">Helm</button><button type="button" data-m="drone" title="A drone over her, following her">Drone</button><button type="button" data-m="fly" title="Fly over her and follow her in this view">Follow</button><button type="button" data-m="stern" title="From a boat astern of her, low on the water">Stern</button><button type="button" data-m="side" title="From a boat abeam of her, to starboard">Side</button><button type="button" data-m="bow" title="From ahead, as she comes on">Bow</button></span>';
    li.querySelector('b').textContent = v === own ? `${OWN_NAME} (yours)` : vName(v);
    if (v.kind === 'ais') { const ib = document.createElement('button'); ib.type = 'button'; ib.className = 'info'; ib.dataset.m = 'info'; ib.textContent = 'ⓘ'; ib.title = 'Everything her AIS says'; li.querySelector('b').after(ib); }
    li.querySelector('small').textContent = r.what;
    li.querySelector('.d').textContent = away(v);
    const eta = vEta(v); if (eta) { li.querySelector('.eta b').textContent = eta.t; li.querySelector('.eta small').textContent = eta.sub; li.querySelector('.eta').title = eta.sub === 'leaves' ? `Leaves at ${eta.t}` : `Due at ${eta.sub} at ${eta.t}`; }
    for (const b of li.querySelectorAll('button')) b.addEventListener('click', () => {
      uwPanel.hidden = true; uwBtn.classList.remove('on');
      if (b.dataset.m === 'info') { showCard(v); return; }
      if (b.dataset.m !== 'fly') { ride(v, b.dataset.m); return; }
      if (nest.on) leaveRide();
      markCurrent(null); foldPanel(true);
      if (aboveFog || env.foggy) applyConditions({ vis: 'clear' });
      flyTo({ x: v.x, z: v.z, dist: clamp(vLen(v) * 8, 250, 2500), tilt: 60 * DEG, az: ((v.h || 0) + 35) * DEG }, 2800);
      follow = v;
    });
    list.appendChild(li);
  }
}
if (uwBtn && uwPanel && !EMPTY) {
  uwBtn.hidden = false;
  uwBtn.addEventListener('click', () => {
    uwPanel.hidden = !uwPanel.hidden; uwBtn.classList.toggle('on', !uwPanel.hidden);
    if (!uwPanel.hidden) { uwPanel.openOut?.(); for (const id of ['wxpanel', 'clockpanel']) { const el = document.getElementById(id); if (el) el.hidden = true; } fillUnderway(); }
  });
  clockBtn?.addEventListener('click', () => { uwPanel.hidden = true; uwBtn.classList.remove('on'); });
  for (const ev of ['pointerdown', 'wheel', 'touchstart']) uwPanel.addEventListener(ev, e => e.stopPropagation(), { passive: true });
  setInterval(() => { if (!uwPanel.hidden && !uwPanel.matches(':hover')) fillUnderway(); }, 2500);   // (not under the pointer: a click mid-rebuild would miss)
}

// ── 📡 Live AIS (v986, requested: "add AIS data, in real time, for boats and ships broadcasting a signal ...
// gracefully not work unless we are connected", for the armchair features first; ais.js, relay/ais/) ── With Live
// on, the vessels really in the bay now, from their AIS: each drawn as what she is (a tanker, a ferry, a schooner,
// a lobster boat), moved on between reports by her speed and course, named, in ⛴ Underway to ride or follow like
// any other, in the lookout's report and on the ride's chart. While they're coming in, the made-up ferries and
// cruise ships stand aside for the real ones. With no internet, or no relay, the button says so and nothing else
// changes. The choice is remembered.
const live = [];   // { kind: 'ais', mmsi, A (her last report), fix: {x, z, t}, group, boat?, trim?, L, x, z, h, on, what, label }
let liveOK = false, liveListen = 1e9;
const liveBtn = document.getElementById('livebtn'), LIVE_KEY = 'audiochart-bay3d-live';
// a boat whose AIS puts her ashore (v997, reported: "The Chebeague water taxi is showing up on land" — she was, by her
// own AIS, hauled out up on Chebeague with her set still on): high ground under her and all round her, so not a boat
// alongside a pier or at the water's edge, where the elevation data or her GPS can be a little out. Her name stays
// on the spot, marked ashore, but no hull among the trees.
const ashoreAt = (lon, lat) => heightAt(lon, lat) > 2 && [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => heightAt(lon + dx * 0.0005, lat + dy * 0.00036) > 1);
function liveData(snap) {
  const now = Date.now(), seen = new Set();
  for (const A of snap.vessels || []) {
    if (A.lon < OVERVIEW[0] || A.lon > OVERVIEW[2] || A.lat < OVERVIEW[1] || A.lat > OVERVIEW[3]) continue;
    seen.add(A.mmsi);
    let v = live.find(o => o.mmsi === A.mmsi);
    const { K, W, S, cls } = identify(A);
    let was = null;   // (her card and following go over to her new self: v1000)
    if (v && (v.model !== cls.model || v.K !== K || v.W !== W)) { was = { card: cardV === v, follow: follow === v }; dropLive(v); v = null; }   // her static data came in: what she is changed
    if (!v) {
      const m = liveModel(A, cls, Number(A.mmsi) % 9973, K, W, trafficLit);
      v = { kind: 'ais', mmsi: A.mmsi, model: cls.model, K, W, ...m, x: wx(A.lon), z: wz(A.lat), h: A.hdg ?? A.cog ?? 0, on: false, label: '' };
      m.group.visible = false; scene.add(m.group); live.push(v);
      if (was?.card) { cardV = v; if (aisCard) aisCard.hidden = false; } if (was?.follow) follow = v;
    }
    v.A = A; v.what = cls.what;
    v.fix = { x: wx(A.lon), z: wz(A.lat), t: now - (A.age || 0) * 1000 };
    const st = aisStatus(A.status), kn = A.sog || 0;
    v.ashore = ashoreAt(A.lon, A.lat);
    v.label = `${cls.what}${v.ashore ? ', ashore (hauled out?)' : st && st !== 'under way' ? ', ' + st : ''}${kn >= 0.5 ? `, ${kn.toFixed(kn < 10 ? 1 : 0)} kn${A.cog != null ? ' on ' + magTxt(A.cog) : ''}` : ''}`;   // (her course too: v1008)
    // back from 🗺 Chart (v1000, ?vessel=<mmsi>): her card again, and following her
    if (params.get('vessel') === String(A.mmsi)) {   // (the page may still be starting up: again shortly, until it takes)
      params.delete('vessel');
      const back = () => { try { follow = v; showCard(v); } catch (_) { setTimeout(back, 300); } }; setTimeout(back, 0);
    }
  }
  for (const v of [...live]) if (!seen.has(v.mmsi)) dropLive(v);
  liveOK = live.length > 0;
}
window.__live = () => live.map(v => ({ mmsi: v.mmsi, name: v.A.name, lat: latOf(v.z), lon: lonOf(v.x), sog: v.A.sog, age: v.A.age }));   // (for checking from a script that they move)
function dropLive(v) {
  if (nest.on && nest.v === v) leaveRide();
  if (follow === v) stopFollow();
  scene.remove(v.group); disposeGroup?.(v.group);
  live.splice(live.indexOf(v), 1);
}
function updateLive(dt) {
  if (!live.length) return;
  const now = Date.now(), cp = camera.position, up = env.W.heel > 0, heel = env.W.heel * DEG;
  for (const v of live) {
    const A = v.A, kn = A.sog || 0, cog = A.cog ?? A.hdg ?? v.h;
    // where she is now: her last report, moved on at her speed and course (for up to five minutes)
    const s = kn * NMm / 3600 * clamp((now - v.fix.t) / 1000, 0, 300), tx = v.fix.x + Math.sin(cog * DEG) * s, tz = v.fix.z - Math.cos(cog * DEG) * s;
    const k = v.placed ? Math.min(1, dt * 1.5) : 1; v.placed = true;   // a new report eases her across, no jump
    v.x += (tx - v.x) * k; v.z += (tz - v.z) * k;
    const want = A.hdg ?? (kn >= 0.5 ? A.cog : null);
    if (want != null) { const turn = ((want - v.h + 540) % 360) - 180; v.h = (v.h + clamp(turn, -20 * dt, 20 * dt) + 360) % 360; }
    v.on = liveFeed.on && !aboveFog; v.group.visible = v.on && !v.ashore;
    v.group.position.set(v.x, 0, v.z); v.group.rotation.y = -v.h * DEG;
    const d = Math.hypot(v.x - cp.x, cp.y, v.z - cp.z), aboard = nest.on && nest.v === v;
    if (v.boat) {
      if (v.trim) v.boat.trim(v.trim(env.C.windFrom, v.h, env.W.tws ?? 8, up ? kn : 0, dt), heel, up);
      v.boat.wake(0);
      v.group.scale.setScalar(aboard || (nest.on && d < 1500) ? 1 : boatScale(v.boat, d));
    } else {
      for (const w of v.group.userData.wake || []) w.visible = false;   // (her wake is in the water: updateWakes)
      v.group.scale.setScalar(aboard ? 1 : Math.max(1, Math.min(v.L > 100 ? 3 : 8, d / 250 * Math.sqrt(8 / v.L) * 0.6)));
    }
  }
}
if (!EMPTY) setShips(await getJSON('./data/ships.json').catch(() => null));   // (before the feed: her colours from the first sight of her)
const liveFeed = makeAisFeed({
  bbox: OVERVIEW,   // (this bay's vessels only: v1019)
  onData: snap => { liveListen = snap.listening ?? 1e9; liveData(snap); },   // (how long the relay has been tuned in: v1010)
  onState: ({ state, note }) => {
    if (state === 'offline' || state === 'off') { for (const v of [...live]) dropLive(v); liveOK = false; }
    syncLiveBtn(state, note);
  },
});
function syncLiveBtn(state = liveBtn?.dataset.state || 'off', note = '') {
  if (!liveBtn) return;
  liveBtn.dataset.state = state;
  liveBtn.classList.toggle('on', liveFeed.on);
  const tuning = liveFeed.on && state !== 'offline' && !live.length && liveListen < 300;   // (the relay only just reconnected to the feed: vessels come in over a few minutes, v1010)
  liveBtn.textContent = !liveFeed.on ? '📡 Live' : tuning ? '📡 Live · tuning in…' : state === 'live' ? `📡 Live · ${live.length}` : state === 'offline' ? '📡 Live · offline' : '📡 Live · …';
  liveBtn.title = !liveFeed.on ? 'Show the vessels in the bay right now, from their AIS (needs an internet connection)'
    : tuning ? 'The live feed has only just started listening: vessels come in over the next few minutes, as each one reports. Tap to turn Live off.'
    : state === 'offline' ? `${note || 'Live AIS is unavailable'}. Tap to turn Live off.` : state === 'live' ? `${live.length} vessels broadcasting AIS in the bay now. Tap to turn Live off.\n${AIS_CREDIT}` : `${note || 'Listening for ships…'} Tap to turn Live off.`;
}
if (liveBtn && !EMPTY) {   // (the relay listens to both bays: relay/ais/core.mjs BOXES; each bay shows its own, by OVERVIEW)
  liveBtn.hidden = false;
  liveBtn.addEventListener('click', () => {
    if (liveFeed.on) liveFeed.stop(); else { liveFeed.start(); if (!boatClock) setClock(realMin(), 1, false); }   // live is now: the clock to now
    try { localStorage.setItem(LIVE_KEY, liveFeed.on ? '1' : '0'); } catch (_) {}
    syncLiveBtn();
  });
  let was = false; try { was = localStorage.getItem(LIVE_KEY) === '1'; } catch (_) {}
  if (was || params.has('ais') || params.has('vessel')) liveFeed.start();
  setInterval(() => { if (liveFeed.on && liveBtn.dataset.state === 'live') syncLiveBtn('live'); }, 5000);
  syncLiveBtn();
}

// Lines out to her marks (v1000): from the vessel whose card is open, else the one you're following, to the
// marks her card or the follow bar names, each labelled with its bearing from her and range.
const fixLines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(18), 3)),
  new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, depthTest: false }));
fixLines.renderOrder = 10; fixLines.frustumCulled = false; fixLines.visible = false; scene.add(fixLines);
let fixFor = null, fixList = [], fixAt = 0;
function updateFixLines() {
  const v = aisCard && !aisCard.hidden && cardV && live.includes(cardV) ? cardV : follow && !nest.on && follow !== own && vGroup(follow).visible ? follow : null;
  if (!v) { fixLines.visible = false; fixFor = null; fixList = []; return; }
  if (v !== fixFor || t - fixAt > 2) { fixFor = v; fixAt = t; fixList = marksNear(v.x, v.z, v === cardV ? 3 : 1); }
  const P = fixLines.geometry.attributes.position, y = 3;
  fixList.forEach((o, i) => { P.setXYZ(i * 2, v.x, y, v.z); P.setXYZ(i * 2 + 1, o.m.x, y, o.m.z); });
  P.needsUpdate = true; fixLines.geometry.setDrawRange(0, fixList.length * 2); fixLines.visible = fixList.length > 0;
}

// Her course and speed (v1008, requested: "for a given vessel, if they are reporting a speed and direction, can we
// show that on the various views when we are looking at the boat?"): from the vessel whose card is open, or the one
// you're following or riding with, a line on the water along her course over the ground to where she'll be in so
// many minutes at her speed (as a chart plotter's vector), a tick at each minute (each five, past a dozen), an
// arrowhead, and at its tip her speed, course and the minutes it runs. The minutes suit how far off you are: 1, 3,
// 6, 12, 30 or 60, the line long enough to see. Only for a vessel that's moving (0.5 kn and over) and sends a course.
const vecLines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 2 * 40), 3)),
  new THREE.LineBasicMaterial({ color: 0x7fe0a6, transparent: true, opacity: 0.95, depthTest: false }));
vecLines.renderOrder = 10; vecLines.frustumCulled = false; vecLines.visible = false; scene.add(vecLines);
let vecTip = null;   // { text, x, z } for her label at the line's end
function updateVector() {
  const v = aisCard && !aisCard.hidden && cardV && live.includes(cardV) ? cardV : nest.on && nest.v?.kind === 'ais' ? nest.v : follow?.kind === 'ais' && live.includes(follow) ? follow : null;
  const A = v?.A, kn = A?.sog || 0, cog = A?.cog ?? null;
  if (!v || !v.on || v.ashore || kn < 0.5 || cog == null) { vecLines.visible = false; vecTip = null; return; }
  const cp = camera.position, far = Math.hypot(v.x - cp.x, cp.y, v.z - cp.z), mps = kn * NMm / 3600;
  const min = [1, 3, 6, 12, 30, 60].find(m => mps * 60 * m >= far * 0.3) || 60, len = mps * 60 * min;
  const ux = Math.sin(cog * DEG), uz = -Math.cos(cog * DEG), y = 1.5, P = vecLines.geometry.attributes.position;
  let i = 0; const seg = (x0, z0, x1, z1) => { P.setXYZ(i++, x0, y, z0); P.setXYZ(i++, x1, y, z1); };
  const ex = v.x + ux * len, ez = v.z + uz * len, tk = Math.max(len * 0.02, far * 0.006);
  seg(v.x, v.z, ex, ez);
  const every = min > 12 ? 5 : 1;
  for (let m = every; m < min; m += every) { const px = v.x + ux * mps * 60 * m, pz = v.z + uz * mps * 60 * m; seg(px - uz * tk, pz + ux * tk, px + uz * tk, pz - ux * tk); }
  const ah = tk * 2.5;   // the arrowhead
  for (const sx of [-1, 1]) seg(ex, ez, ex - ux * ah + sx * -uz * ah * 0.6, ez - uz * ah + sx * ux * ah * 0.6);
  P.needsUpdate = true; vecLines.geometry.setDrawRange(0, i); vecLines.visible = true;
  vecTip = { text: `${kn.toFixed(kn < 10 ? 1 : 0)} kn · ${magTxt(cog)} · ${min} min`, x: ex, z: ez };
}

// ── A live vessel's AIS card (v988, requested: "if I click on a vessel you can bring up a table that shows you
// all the data AIS has on it") ── Tap her in the view (or ⓘ by her name in ⛴ Underway): her name, MMSI, flag,
// call sign and IMO number, what she is and her size and draft, her status, speed, course, heading and rate of
// turn, where she's bound and when, where she is, how long since she was heard, and how far off she is; with a
// link to look her up online, and the buttons to follow or ride with her. Only what she sends: a small Class B
// boat has a few lines. Kept up to date while it's open.
const aisCard = document.getElementById('aisinfo');
let cardV = null;
if (aisCard) {
  shrinkable(aisCard);
  for (const ev of ['pointerdown', 'wheel', 'touchstart']) aisCard.addEventListener(ev, e => e.stopPropagation(), { passive: true });
  document.getElementById('aisclose').addEventListener('click', () => { aisCard.hidden = true; cardV = null; });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !aisCard.hidden && !nest.on) { aisCard.hidden = true; cardV = null; } });
  const go = aisCard.querySelector('.go');
  for (const [m, label, title] of [['fly', 'Follow', 'Fly over her and follow her'], ['helm', 'Helm', 'Aboard her, at the helm'], ['drone', 'Drone', 'A drone over her'], ['stern', 'Stern', 'From a boat astern of her'], ['side', 'Side', 'From a boat abeam of her'], ['bow', 'Bow', 'From ahead, as she comes on']]) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title;
    b.addEventListener('click', () => {
      const v = cardV; if (!v || !live.includes(v)) return;
      if (m !== 'fly') { ride(v, m); return; }
      if (nest.on) leaveRide();
      markCurrent(null); foldPanel(true);
      flyTo({ x: v.x, z: v.z, dist: clamp(vLen(v) * 8, 250, 2500), tilt: 60 * DEG, az: ((v.h || 0) + 35) * DEG }, 2800);
      follow = v;
    });
    go.appendChild(b);
  }
  if (chartHook()) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = '🗺 Chart'; b.title = 'Show her on the chart';
    b.addEventListener('click', () => cardV && live.includes(cardV) && showOnChart(cardV));
    go.appendChild(b);
  }
  setInterval(fillCard, 2000);
}
function showCard(v) {
  if (!aisCard) return;
  cardV = v; aisCard.hidden = false; aisCard.openOut?.();
  uwPanel.hidden = true; uwBtn.classList.remove('on');
  for (const id of ['wxpanel', 'clockpanel']) { const el = document.getElementById(id); if (el) el.hidden = true; }
  fillCard();
}
const ftm = m => `${Math.round(m * 3.281)} ft (${m < 20 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)} m)`;
const deg3 = d => String(Math.round(((d % 360) + 360) % 360) % 360).padStart(3, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fillCard() {
  if (!aisCard || aisCard.hidden || !cardV) return;
  if (cardV === buoyF) { fillBuoyCard(); return; }
  if (cardV === gauge) { fillGaugeCard(); return; }
  aisCard.querySelector('.go').hidden = false;
  const v = cardV, A = v.A, gone = !live.includes(v);
  document.getElementById('aisname').textContent = `📡 ${aisName(A)}${gone ? ' (no longer heard)' : ''}`;
  const rows = [], row = (k, val, html = false) => { if (val !== '' && val != null) rows.push([k, val, html]); };
  row('MMSI', A.mmsi); row('Flag', aisFlag(A.mmsi)); row('Call sign', aisCallsign(A.callsign)); row('IMO', aisImo(A.imo));
  row('Type', `${v.what}${A.type ? ` (AIS ${A.type})` : ''}`);
  row('Size', A.L ? `${ftm(A.L)}${A.B ? ` × ${ftm(A.B)}` : ''}` : '');
  row('Draft', A.draught ? ftm(A.draught) : '');
  row('Status', aisStatus(A.status) ? cap(aisStatus(A.status)) : '');
  row('Speed', A.sog != null ? `${A.sog.toFixed(1)} kn` : '');
  row('Course', A.cog != null ? `${deg3(A.cog)}° true` : '');
  row('Heading', A.hdg != null ? `${deg3(A.hdg)}° true` : '');
  row('Turning', aisRot(A.rot));
  row('Bound for', aisDest(A.dest) || A.dest);
  if (A.eta) { const [md, hm] = A.eta.split(' '), [mo, dd] = md.split('-').map(Number); row('ETA', `${MON[mo - 1]} ${dd}${hm ? `, ${hm} UTC` : ''}`); }
  row('Position', `${aisPos(A.lat, A.lon)}${A.acc === true ? ' (±10 m)' : ''}${v.ashore ? ' — ashore: hauled out, or her AIS is wrong' : ''}`);
  { const fx = marksNear(v.x, v.z); if (fx.length) row('Bearings', fx.map(o => fixText(o).replace(/[&<>]/g, c => `&#${c.charCodeAt(0)};`)).join('<br>'), true); }
  row('Last heard', aisAgo((Date.now() - v.fix.t) / 1000));
  const mine = own.r && own.boat.group.visible, fx = mine ? own.x : view.x, fz = mine ? own.z : view.z, d = Math.hypot(v.x - fx, v.z - fz);
  if (d > 30) row(mine ? 'From your boat' : 'From the view', `${(d / NMm).toFixed(d < 10 * NMm ? 1 : 0)} nm, ${deg3(Math.atan2(v.x - fx, -(v.z - fz)) / DEG)}° true`);
  if (navigator.onLine !== false) row('More', `<a href="${aisLookup(A.mmsi)}" target="_blank" rel="noopener">Look her up on VesselFinder ↗</a>`, true);
  const tb = aisCard.querySelector('table'); tb.innerHTML = '';
  for (const [k, val, html] of rows) { const tr = tb.insertRow(), th = document.createElement('th'), td = tr.insertCell(); th.textContent = k; tr.prepend(th); if (html) td.innerHTML = val; else td.textContent = val; }
  for (const b of aisCard.querySelectorAll('.go button')) b.disabled = gone;
}
// the tap: the live vessel nearest it on the screen, within a finger's width of her or her name
const _tp = new THREE.Vector3();
function tapAt(cx, cy) {
  if (!aisCard) return;
  const r = renderer.domElement.getBoundingClientRect(), scr = (x, y, z) => { _tp.set(x, y, z).project(camera); return _tp.z < 1 ? [r.left + (_tp.x + 1) / 2 * r.width, r.top + (1 - _tp.y) / 2 * r.height] : null; };
  if (buoyF) { const a = scr(buoyF.x, 0, buoyF.z), b = scr(buoyF.x, 6 * buoyF.g.scale.x, buoyF.z); if (a && b && Math.hypot(cx - a[0], cy - (a[1] + b[1]) / 2) < 26 + Math.abs(a[1] - b[1]) / 2) { showCard(buoyF); return; } }
  if (gauge) { const a = scr(gauge.x, gauge.g.position.y, gauge.z), b = scr(gauge.x, gauge.g.position.y + 7 * gauge.g.scale.x, gauge.z); if (a && b && Math.hypot(cx - a[0], cy - (a[1] + b[1]) / 2) < 26 + Math.abs(a[1] - b[1]) / 2) { showCard(gauge); return; } }
  if (!live.length) return;
  let best = null, bd = 26;
  for (const v of live) {
    if (!v.on || (nest.on && nest.v === v)) continue;
    const top = (v.L > 100 ? 45 : v.L > 25 ? 14 : 8) * v.group.scale.x, a = scr(v.x, 0, v.z), b = scr(v.x, top, v.z); if (!a || !b) continue;
    b[1] -= 22;   // (her name, just above her)
    const dx = b[0] - a[0], dy = b[1] - a[1], k = clamp(((cx - a[0]) * dx + (cy - a[1]) * dy) / ((dx * dx + dy * dy) || 1), 0, 1);
    const d = Math.hypot(cx - a[0] - dx * k, cy - a[1] - dy * k);
    if (d < bd) { bd = d; best = v; }
  }
  if (best) showCard(best);
}

// ── Buoy F (v1013, requested; buoyf.js): the University of Maine's data buoy in West Penobscot Bay, its current
// as arrows on the water (at the surface, and the strongest below, when it differs), a label, and its readings on
// the card when tapped. Offline it shows the last reading, with its age, up to 12 hours; then only the buoy. ──
const buoyF = PENOBSCOT && !EMPTY ? (() => {
  const g = new THREE.Group(), x = wx(BUOY_F.lon), z = wz(BUOY_F.lat), yel = new THREE.MeshStandardMaterial({ color: 0xf0c020, roughness: 0.55 });
  const part = (geo, y, m = yel) => { const o = new THREE.Mesh(geo, m); o.position.y = y; g.add(o); return o; };
  part(new THREE.CylinderGeometry(1.5, 1.3, 0.9, 20), 0.25);   // the discus hull
  part(new THREE.CylinderGeometry(0.55, 0.7, 0.5, 12), 0.95);
  for (const a of [0, 2.1, 4.2]) { const leg = part(new THREE.CylinderGeometry(0.06, 0.06, 3.2, 5), 2.6); leg.position.set(Math.cos(a) * 0.5, 2.6, Math.sin(a) * 0.5); leg.rotation.set(Math.sin(a) * 0.15, 0, -Math.cos(a) * 0.15); }
  const panel = part(new THREE.BoxGeometry(0.9, 0.6, 0.06), 2.2, new THREE.MeshStandardMaterial({ color: 0x1b2a44, roughness: 0.3, metalness: 0.4 })); panel.rotation.x = -0.5;
  part(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 5), 4.6);   // the anemometer mast and its light
  part(new THREE.SphereGeometry(0.13, 8, 6), 5.1, new THREE.MeshBasicMaterial({ color: 0xfff2a0 }));
  g.position.set(x, 0, z); scene.add(g);
  const arrows = [0x5fd3ff, 0xa9b8ff].map(c => { const l = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3)), new THREE.LineBasicMaterial({ color: c, depthTest: false, transparent: true })); l.renderOrder = 5; l.frustumCulled = false; l.visible = false; scene.add(l); return l; });
  return { kind: 'buoy', x, z, g, arrows, R: null, tips: [] };
})() : null;
const buoyFeed = buoyF ? makeBuoyF({ onData: R => { buoyF.R = R; } }) : null;
buoyFeed?.start();
const knTxt = kn => `${kn.toFixed(kn < 10 ? 1 : 0)} kn`;
const agoMin = t => Math.round((Date.now() - t) / 60e3);
function updateBuoyF() {
  if (!buoyF) return;
  buoyF.g.scale.setScalar(clamp(view.dist / 400, 1, 80));
  const R = buoyFeed.reading, top = topCurrent(R), deep = strongest(R), L = view.dist * 0.15;
  buoyF.tips = [];
  const draw = (line, c, y) => {
    if (!c || c.kn < 0.15) { line.visible = false; return; }
    const len = L * Math.min(c.kn, 3), ux = Math.sin(c.to * DEG), uz = -Math.cos(c.to * DEG), P = line.geometry.attributes.position, ah = len * 0.18;
    let i = 0; const seg = (x0, z0, x1, z1) => { P.setXYZ(i++, buoyF.x + x0, y, buoyF.z + z0); P.setXYZ(i++, buoyF.x + x1, y, buoyF.z + z1); };
    seg(0, 0, ux * len, uz * len);
    for (const sx of [-1, 1]) seg(ux * len, uz * len, ux * (len - ah) - sx * uz * ah * 0.6, uz * (len - ah) + sx * ux * ah * 0.6);
    P.needsUpdate = true; line.geometry.setDrawRange(0, i); line.visible = true;
    buoyF.tips.push({ x: buoyF.x + ux * len, z: buoyF.z + uz * len });
  };
  draw(buoyF.arrows[0], top, 1.2);
  // the strongest below, when it's a different current: half again as strong, or setting another way
  const differs = deep && top && deep.depth > 5 && (deep.kn > top.kn * 1.5 + 0.1 || Math.abs(((deep.to - top.to + 540) % 360) - 180) > 45);
  draw(buoyF.arrows[1], differs ? deep : null, 0.8);
  buoyF.differs = differs;
}
// her label: the current she feels, and the stronger one below if it differs; how old, if it's not the latest
function buoyLabel() {
  const R = buoyFeed?.reading; if (!R) return BUOY_F.name;
  const top = topCurrent(R), deep = strongest(R), age = agoMin(buoyTime(R)), w = c => tideWord(c.kn, c.to);
  let t = `${BUOY_F.name}`;
  if (top) t += top.kn < 0.15 ? ' · slack' : ` · ${w(top) ? w(top) + ' ' : ''}${knTxt(top.kn)} ${magTxt(top.to)}`;
  if (buoyF.differs) t += ` · ${w(deep) ? w(deep) + ' ' : ''}${knTxt(deep.kn)} ${magTxt(deep.to)} at ${Math.round(deep.depth * 3.281)} ft`;
  if (age > 90) t += ` · ${age < 120 ? age + ' min' : Math.round(age / 60) + ' h'} ago`;
  return t;
}
const cF = c => `${(c * 9 / 5 + 32).toFixed(1)} °F (${c.toFixed(1)} °C)`;
function fillBuoyCard() {
  const R = buoyFeed.reading;
  document.getElementById('aisname').textContent = `🟡 ${BUOY_F.name}, West Penobscot Bay`;
  aisCard.querySelector('.go').hidden = true;
  const rows = [], row = (k, val, html = false) => { if (val !== '' && val != null) rows.push([k, val, html]); };
  const at = t => { const d = new Date(t); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  if (!R) row('Readings', buoyFeed.failed ? 'None: can\'t reach the buoy\'s server (out of range?), and none kept from the last 12 hours' : 'Asking the buoy…');
  else {
    const top = topCurrent(R), w = c => tideWord(c.kn, c.to), cur = c => `${c.kn < 0.15 ? 'Slack, ' : w(c) ? cap(w(c)) + ', ' : ''}${knTxt(c.kn)} setting ${deg3(c.to)}° true (${magTxt(c.to)})`;
    if (top) row('Current', `${cur(top)} at ${Math.round(top.depth * 3.281)} ft`);
    if (R.profile) {   // the profile, about every 30 ft, and its strongest
      const P = R.profile.P, pick = P.filter((p, i) => i === 0 || i === P.length - 1 || Math.round(p.depth) % 20 === 10), deep = strongest(R);
      if (!pick.includes(deep)) { pick.push(deep); pick.sort((a, b) => a.depth - b.depth); }
      row('Below', pick.map(p => `${String(Math.round(p.depth * 3.281)).padStart(3)} ft  ${knTxt(p.kn).padStart(6)}  ${deg3(p.to)}°T${p === deep ? '  max' : ''}`).join('<br>').replace(/ /g, '&nbsp;'), true);
      row('Measured', `${at(R.profile.t)}, by the buoy's current profiler, ${Math.round(P[0].depth * 3.281)}–${Math.round(P[P.length - 1].depth * 3.281)} ft down`);
    }
    if (R.water) {
      const W = R.water, a = W[0], b = W[W.length - 1];
      row('Water', `${cF(a.c)} at ${Math.round(a.depth * 3.281)} ft${b !== a ? `; ${cF(b.c)} at ${Math.round(b.depth * 3.281)} ft` : ''}`);
      const S = W.filter(x => x.psu != null); if (S.length) row('Salinity', `${S[0].psu.toFixed(1)} at ${Math.round(S[0].depth * 3.281)} ft${S.length > 1 ? `; ${S[S.length - 1].psu.toFixed(1)} at ${Math.round(S[S.length - 1].depth * 3.281)} ft` : ''} (PSU)`);
    }
    if (R.met) {
      const m = R.met;
      row('Wind', `${compass16(m.from)} ${knTxt(m.kn)}${m.gust != null ? `, gusts ${knTxt(m.gust)}` : ''}`);
      if (m.air != null) row('Air', cF(m.air));
      if (m.mb != null) row('Pressure', `${m.mb.toFixed(1)} mb`);
      if (m.vis != null) row('Visibility', m.vis >= 2900 ? 'over 1.5 nm' : `${(m.vis / 1852).toFixed(1)} nm`);
    }
    if (R.waves) row('Waves', `${(R.waves.hs * 3.281).toFixed(1)} ft${R.waves.per ? `, ${Math.round(R.waves.per)} s` : ''}${R.waves.from != null ? `, from ${compass16(R.waves.from)}` : ''}`);
    const age = (Date.now() - buoyTime(R)) / 1000;
    row('Latest', `${at(buoyTime(R))} (${aisAgo(age)})${buoyFeed.failed ? ' — the last one kept: can\'t reach the buoy\'s server' : age > 5400 ? ' — no newer one yet' : ''}`);
  }
  row('Position', aisPos(BUOY_F.lat, BUOY_F.lon));
  { const mine = own.r && own.boat.group.visible, fx = mine ? own.x : view.x, fz = mine ? own.z : view.z, d = Math.hypot(buoyF.x - fx, buoyF.z - fz);
    if (d > 30) row(mine ? 'From your boat' : 'From the view', `${(d / NMm).toFixed(d < 10 * NMm ? 1 : 0)} nm, ${deg3(Math.atan2(buoyF.x - fx, -(buoyF.z - fz)) / DEG)}° true`); }
  row('Source', `${BUOY_F.credit}, buoy F01 (NDBC ${BUOY_F.ndbc})`);
  if (!buoyFeed.failed) row('More', `<a href="${BUOY_F.page}" target="_blank" rel="noopener">All her readings, on NERACOOS ↗</a>`, true);
  const tb = aisCard.querySelector('table'); tb.innerHTML = '';
  for (const [k, val, html] of rows) { const tr = tb.insertRow(), th = document.createElement('th'), td = tr.insertCell(); th.textContent = k; tr.prepend(th); if (html) td.innerHTML = val; else td.textContent = val; }
}

// ── The tide gauge (v1014, requested: "now do the measured vs predicted tide"; tidegauge.js): NOAA's live gauge for
// the bay (Bar Harbor, or Portland), a striped tide staff on its pier, its label the height now and how far the water
// runs above or below the tables (the surge), and the last day and the next half on the card. Offline the kept
// predictions still give the tide; the last measurement shows with its age, up to 12 hours. ──
const GAUGE = GAUGES[RID];
const gauge = GAUGE && !EMPTY ? (() => {
  const g = new THREE.Group(), x = wx(GAUGE.lon), z = wz(GAUGE.lat);
  const red = new THREE.MeshStandardMaterial({ color: 0xc8322a, roughness: 0.6 }), white = new THREE.MeshStandardMaterial({ color: 0xf2f0e8, roughness: 0.6 });
  for (let i = 0; i < 7; i++) { const o = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1, 0.12), i % 2 ? white : red); o.position.y = i + 0.5; g.add(o); }   // the staff, a foot of it to a band
  const hut = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1, 1.2), white); hut.position.set(0.9, 0.5, 0); g.add(hut);   // the gauge's housing
  g.position.set(x, 0, z); scene.add(g);
  return { kind: 'gauge', x, z, g };
})() : null;
const tide = gauge ? makeTideGauge(GAUGE, { onData: () => {} }) : null;
tide?.start();
const ft1 = v => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} ft`;
function updateGauge() {
  if (!gauge) return;
  gauge.g.scale.setScalar(clamp(view.dist / 400, 1, 80));
  gauge.g.position.y = Math.max(heightAt(GAUGE.lon, GAUGE.lat), 0);
}
// "above"/"below predicted", or "as predicted" within a couple of inches
const surgeTxt = s => Math.abs(s) < 0.2 ? 'as predicted' : `${Math.abs(s).toFixed(1)} ft ${s > 0 ? 'above' : 'below'} predicted`;
function gaugeLabel() {
  const S = tide.state, now = Date.now(), m = tide.surge, p = predAt(S, now), tr = trendAt(S, now);
  let t = `${GAUGE.name} tide`;
  const h = m && now - m.t < 30 * 60e3 ? m.ft : p != null ? p + (m?.surge ?? 0) : null;   // (the measured height, else predicted plus the last surge)
  if (h != null) t += ` · ${ft1(h)}${tr == null ? '' : Math.abs(tr) < 0.3 ? ', turning' : tr > 0 ? ' rising' : ' falling'}`;
  if (m) t += ` · ${surgeTxt(m.surge)}${now - m.t > 90 * 60e3 ? ` (${Math.round((now - m.t) / 3600e3)} h ago)` : ''}`;
  return t;
}
function fillGaugeCard() {
  const S = tide.state, now = Date.now(), m = tide.surge, p = predAt(S, now), tr = trendAt(S, now);
  document.getElementById('aisname').textContent = `🌊 ${GAUGE.name} tide gauge`;
  aisCard.querySelector('.go').hidden = true;
  const rows = [], row = (k, val, html = false) => { if (val !== '' && val != null) rows.push([k, val, html]); };
  const at = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (m) row('Measured', `${ft1(m.ft)} at ${at(m.t)}${now - m.t > 30 * 60e3 ? ` (${aisAgo((now - m.t) / 1000)})${tide.failed ? ' — the last one kept: can\'t reach NOAA' : ''}` : ''}`);
  else row('Measured', tide.failed ? 'None: can\'t reach NOAA (out of range?), and none kept from the last 12 hours' : 'Asking the gauge…');
  if (m && predAt(S, m.t) != null) row('Predicted then', ft1(predAt(S, m.t)));
  if (m) row('Surge', `${m.surge >= 0 ? '+' : '−'}${Math.abs(m.surge).toFixed(1)} ft: the water's ${surgeTxt(m.surge)}${Math.abs(m.surge) >= 1 ? ` — wind or a storm is ${m.surge > 0 ? 'piling it up' : 'holding it off'}` : ''}`);
  if (p != null) row('Now', `${ft1(p + (m?.surge ?? 0))}${m ? Math.abs(m.surge) >= 0.2 ? ` (predicted ${ft1(p)}, ${m.surge > 0 ? '+' : '−'}${Math.abs(m.surge).toFixed(1)} surge)` : '' : ' predicted'}${tr == null ? '' : Math.abs(tr) < 0.3 ? ', turning' : `, ${tr > 0 ? 'rising' : 'falling'} ${Math.abs(tr).toFixed(1)} ft an hour`}`);
  for (const n of nextTurns(S, now)) row(n.high ? 'High' : 'Low', `${ft1(n.ft)} at ${at(n.t)}${m && Math.abs(m.surge) >= 0.3 ? `; with the surge, about ${ft1(n.ft + m.surge)}` : ''}`);
  if (p != null) row('Charted depths', `add about ${ft1(p + (m?.surge ?? 0))} near ${GAUGE.name} now (they're from mean lower low water)`);
  if (!S.pred.length) row('Predictions', tide.failed ? 'None kept yet: they come with the first visit online' : 'Asking NOAA…');
  row('Position', aisPos(GAUGE.lat, GAUGE.lon));
  { const mine = own.r && own.boat.group.visible, fx = mine ? own.x : view.x, fz = mine ? own.z : view.z, d = Math.hypot(gauge.x - fx, gauge.z - fz);
    if (d > 30) row(mine ? 'From your boat' : 'From the view', `${(d / NMm).toFixed(d < 10 * NMm ? 1 : 0)} nm, ${deg3(Math.atan2(gauge.x - fx, -(gauge.z - fz)) / DEG)}° true`); }
  row('Source', `NOAA tide gauge ${GAUGE.id}, every 6 minutes; heights above mean lower low water`);
  if (!tide.failed) row('More', `<a href="${gaugePage(GAUGE)}" target="_blank" rel="noopener">The gauge on NOAA Tides &amp; Currents ↗</a>`, true);
  const tb = aisCard.querySelector('table'); tb.innerHTML = '';
  const svg = tideChart(S, now);
  if (svg) { const td = tb.insertRow().insertCell(); td.colSpan = 2; td.className = 'chart'; td.innerHTML = svg + '<div class="key"><b class="p"></b>predicted <b class="m"></b>measured</div>'; }
  for (const [k, val, html] of rows) { const tr = tb.insertRow(), th = document.createElement('th'), td = tr.insertCell(); th.textContent = k; tr.prepend(th); if (html) td.innerHTML = val; else td.textContent = val; }
}

// ── The forecast currents (v1015, requested: "now do the NECOFS current arrows"; currents.js): NECOFS's surface
// current over the bay, an arrow for each point (about 1.2 nm apart; every 2nd or 4th from further up), its length
// and colour by its speed, at the scene's clock, so they turn with the tide as the clock runs. 🌀 Currents turns
// them off and on (remembered). Offline they go on from the kept forecast until it runs out. ──
const CUR_KEY = 'audiochart-bay3d-currents', curBtn = document.getElementById('curbtn');
let curOn = true; try { curOn = localStorage.getItem(CUR_KEY) !== '0'; } catch (_) {}
const curLine = EMPTY ? null : (() => {
  const l = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
  l.frustumCulled = false; l.visible = false; l.renderOrder = 4; scene.add(l); return l;
})();
let curF = null, curUV = null, curL = null, curAt = -1, curKey = '';
const curFeed = curLine ? makeCurrents(RID, { onData: F => {
  curF = F; curAt = -1;
  const n = Math.max(F.n, F.fine?.n ?? 0) * 6; curLine.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); curLine.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  for (const L of [F, F.fine]) if (L) {   // each layer's points in the world (the Gulf of Maine model's, and Casco's finer one)
    L.x = new Float32Array(L.n); L.z = new Float32Array(L.n);
    for (let k = 0; k < L.n; k++) { L.x[k] = wx(L.pts[k * 4 + 2]); L.z[k] = wz(L.pts[k * 4 + 3]); }
  }
  if (curBtn) curBtn.hidden = false; syncCurBtn();
} }) : null;
const sceneMs = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() + clockMin() * 60e3; };
const dayTime = t => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
function syncCurBtn() {
  if (!curBtn || !curF) return;
  curBtn.classList.toggle('on', curOn); curBtn.setAttribute('aria-pressed', String(curOn));
  const t = sceneMs();
  curBtn.title = `The forecast surface currents, as arrows that follow the clock: ${t > curF.t1 ? `none for this time — the forecast ran to ${dayTime(curF.t1)}` : `forecast to ${dayTime(curF.t1)}`}. Pale under ½ kn, cyan to 1½, yellow to 2½, orange beyond. NECOFS (UMass Dartmouth FVCOM), made ${dayTime(Date.parse(curF.made))}${curF.fine ? `; its finer Casco Bay model ${dayTime(curF.fine.t0)} to ${dayTime(curF.fine.t1)}, the Gulf of Maine model's otherwise` : ''}.`;
}
curBtn?.addEventListener('click', () => { curOn = !curOn; try { localStorage.setItem(CUR_KEY, curOn ? '1' : '0'); } catch (_) {} curKey = ''; syncCurBtn(); });
// pale blue, cyan, yellow, orange by knots
const curCol = kn => kn < 0.5 ? [0.62, 0.74, 0.95] : kn < 1.5 ? [0.37, 0.83, 1] : kn < 2.5 ? [1, 0.88, 0.4] : [1, 0.6, 0.24];
function updateCurrents() {
  if (!curLine) return;
  const t = sceneMs();
  if (!curOn || !curF) { curLine.visible = false; curUV = null; return; }
  if (Math.abs(t - curAt) > 30e3) { const A = layerAt(curF, t); curUV = A?.uv ?? null; curL = A?.L ?? null; curAt = t; curKey = ''; }
  if (!curUV) { curLine.visible = false; return; }
  const F = curL, K = 2 ** clamp(Math.ceil(Math.log2(view.dist / 25 / (F.step * 111e3))), 0, 3), L = K * F.step * 111e3, y = Math.max(1.5, view.dist * 0.0012);
  const key = `${curAt}|${K}|${Math.round(y)}`; if (key === curKey) return; curKey = key;
  const P = curLine.geometry.attributes.position, C = curLine.geometry.attributes.color; let i = 0;
  const put = (x, z, c) => { P.setXYZ(i, x, y, z); C.setXYZ(i++, c[0], c[1], c[2]); };
  for (let k = 0; k < F.n; k++) {
    if (!F.wet[k] || F.pts[k * 4] % K || F.pts[k * 4 + 1] % K) continue;
    const u = curUV[k * 2], v = curUV[k * 2 + 1], kn = Math.hypot(u, v); if (kn < 0.1) continue;
    const len = L * 0.45 * Math.min(kn, 2.5), ux = u / kn, uz = -v / kn, x = F.x[k] - ux * len / 2, z = F.z[k] - uz * len / 2, ex = x + ux * len, ez = z + uz * len, ah = Math.min(len * 0.3, L * 0.15), c = curCol(kn);
    put(x, z, c); put(ex, ez, c);
    for (const sx of [-1, 1]) { put(ex, ez, c); put(ex - ux * ah - sx * uz * ah * 0.5, ez - uz * ah + sx * ux * ah * 0.5, c); }
  }
  P.needsUpdate = true; C.needsUpdate = true; curLine.geometry.setDrawRange(0, i); curLine.visible = true;
}
// close in, the arrow nearest the middle of the view, in words (flood and ebb in Penobscot only: tideWord's axis is its)
function curNear() {
  if (!curLine?.visible || !curUV || view.dist > 15000) return null;
  let best = -1, bd = Math.max(view.dist * 0.6, 2500);
  const F = curL;
  for (let k = 0; k < F.n; k++) {   // (a point on the water, by its model and by ours)
    if (!F.wet[k]) continue;
    const d = Math.hypot(F.x[k] - view.x, F.z[k] - view.z); if (d < bd && isWater(F.x[k], F.z[k])) { bd = d; best = k; } }
  if (best < 0) return null;
  const u = curUV[best * 2], v = curUV[best * 2 + 1], kn = Math.hypot(u, v), to = (Math.atan2(u, v) / DEG + 360) % 360;
  return { x: F.x[best], z: F.z[best], text: `Forecast current · ${kn < 0.1 ? 'slack' : `${PENOBSCOT && tideWord(kn, to) ? tideWord(kn, to) + ' ' : ''}${knTxt(kn)} ${magTxt(to)}`} · ${clockTxt()}` };
}
const clockTxt = () => { const m = clockMin(); return `${Math.floor(m / 60)}:${String(Math.floor(m % 60)).padStart(2, '0')}`; };
setInterval(syncCurBtn, 60e3);
curFeed?.start();   // (after the above: a kept forecast comes back at once)

// ── Matinicus Rock (v1016, requested: "now do the Matinicus Rock wind and waves"; obs.js): the wind measured on
// the Rock, and the seas at Buoy E offshore, as a label on the Rock; the same readings are in the Weather panel. ──
const ROCK = PENOBSCOT && !EMPTY ? OBS['penobscot-bay'] : null, rockObs = ROCK ? makeObs(ROCK, {}) : null;
rockObs?.start();
const rockXZ = ROCK ? { x: wx(ROCK.wind.lon), z: wz(ROCK.wind.lat) } : null;
function rockLabel() {
  const O = rockObs.reading; let t = ROCK.wind.name;
  if (O?.wind) t += ` · ${windWords(O.wind)}`;
  if (O?.waves) t += ` · ${wavesWords(O.waves).replace('seas', 'seas offshore')}`;
  const age = O ? (Date.now() - Math.max(Date.parse(O.wind?.t || 0), Date.parse(O.waves?.t || 0))) / 3600e3 : 0;
  return age > 2 ? `${t} (${Math.round(age)} h ago)` : t;
}

// ── Moored boats, by the season (v944, requested: "add the moored boats with seasons"; moorings3d.js) ──
const moorings = EMPTY ? null : makeMoorings({
  scene, wx, wz, lonOf, latOf,
  water: (x, z) => elevSmooth(lonOf(x), latOf(z)) <= 0.3,
  detailAt: (x, z) => { const lon = lonOf(x), lat = latOf(z); return tiles.some(T => T.state === 'ready' && lon >= T.w && lon < T.e && lat >= T.s && lat < T.n); },
  clear: (x, z) => {   // clear of the ferry lines and slips, and of the piers
    for (const v of traffic) if (v.kind === 'ferry') { const P = v.T.P; for (let i = 1; i < P.length; i++) if (segDist(x, z, P[i - 1][0], P[i - 1][1], P[i][0], P[i][1]) < 60) return false; }
    if (slips.some(sl => Math.hypot(x - sl.x, z - sl.z) < 90)) return false;
    return !pierSegs(x, z, 14).length;
  },
  windFrom: () => env.C.windFrom ?? 200,
  hidden: () => !!aboveFog,
});
setInterval(() => moorings?.update(view), 2000);

// ── Seagulls and seals (v888, requested; wildlife3d.js), round where you're looking ──
const wildlife = makeWildlife({ scene });
getJSON(`./data/regions/${RID}/hazards.geojson`).then(fc => wildlife.setLedges(ledgesFrom(fc, wx, wz))).catch(() => {});

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
  const samples = await getJSON(`./data/regions/${RID}/curated_routes.json`).catch(() => []);
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
// Search on the chart (v960, reported: "search doesn't seem to work in birdseye mode"): it moved the
// chart hidden underneath; now the view flies to the place too, and a blue pin marks it (SP001 …)
const pinGroup = new THREE.Group(); scene.add(pinGroup);
const pins = [];
function dropPin(lat, lon, label) {
  const g = new THREE.Group(); g.position.set(wx(lon), 0, wz(lat));
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6), new THREE.MeshLambertMaterial({ color: 0xf2f2ee })); pole.position.y = 1.6; g.add(pole);
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.55), new THREE.MeshLambertMaterial({ color: 0x2f7fd0, emissive: 0x2f7fd0, emissiveIntensity: 0.35 })); gem.position.y = 3.6; gem.scale.y = 1.4; g.add(gem);
  pinGroup.add(g); pins.push({ g, label });
  stopFollow(); markCurrent(null);
  flyTo({ x: g.position.x, z: g.position.z, dist: 2500, tilt: Math.max(view.tilt, 35 * DEG), az: view.az }, 2800);
}
function clearPins() { for (const p of pins.splice(0)) { pinGroup.remove(p.g); p.g.traverse(m => m.geometry?.dispose()); } }
function updateWaypoints() {
  const cp = camera.position;
  for (const p of pins) p.g.scale.setScalar(clamp(Math.hypot(p.g.position.x - cp.x, cp.y, p.g.position.z - cp.z) / 150, 1, 80));
  pinGroup.visible = !aboveFog;
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
const own = { boat: OWN_TYPE === 'angelique' ? makeAngelique() : OWN_TYPE === 'bowdoin' ? makeBowdoin() : makeSailboat(OWN_TYPE, 4), trim: makeTrimmer(), r: null, pts: [], cum: [0], nights: [], total: 0, S: 0, playing: false, vj: null, x: 0, z: 0, h: 0 };
if (OWN_TYPE === 'bowdoin') bowdoin = own;   // her crow's nest is yours (v919)
own.boat.group.visible = false; scene.add(own.boat.group);
const sailRow = document.getElementById('sailrow'), sailBtn = document.getElementById('sailit'), paceSel = document.getElementById('sailpace'), sailNote = document.getElementById('sailnote');
for (const k of [1, 5, 20, 60, 200]) { const o = document.createElement('option'); o.value = k; o.textContent = k === 1 ? `${OWN_KN} kn real time` : `${OWN_KN} kn × ${k}`; paceSel.appendChild(o); }
try { paceSel.value = localStorage.getItem(PACE_KEY) || '60'; } catch (_) { paceSel.value = '60'; }
if (!paceSel.value) paceSel.value = '60';
paceSel.addEventListener('change', () => { try { localStorage.setItem(PACE_KEY, paceSel.value); } catch (_) {} });
// her time on passage (minutes) at s along the route; each day after an overnight stop starts again at the hour
// she first left (v936)
const passageMin = s => (s - (own.nights.filter(c => s >= c - 1).pop() ?? 0)) / (OWN_KN * NMm) * 60;
function linkClock() {
  if (boatClock || !clockBtn || EMPTY) return;
  const depart = clockMin() - passageMin(own.S);
  simClock.light = true;
  boatClock = () => depart + passageMin(own.S);
  syncClock();
}
function setOwnRoute(r, pts) {
  if (boatClock) setClock(clockMin(), 1, false);   // a new route: the clock lets go of her, at the time it was
  own.r = r; own.playing = false; own.S = 0; sailBtn.textContent = '▶ Sail it';
  sailRow.hidden = !r || EMPTY; sailNote.hidden = !r || EMPTY; followBtn.hidden = !r || EMPTY; own.boat.group.visible = !!r && !EMPTY;
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
    linkClock();
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
  own.boat.wake(0);   // (her wake is in the water: updateWakes)
  own.wakeOn = own.ext ? !!own.ext.moving : !!(own.playing || own.vj) && own.S < own.total; own.wakeKn = kn;
  const cp = camera.position;
  { const d = Math.hypot(own.x - cp.x, cp.y, own.z - cp.z); own.boat.group.scale.setScalar(nest.on && (nest.v === own || d < 1500) ? 1 : boatScale(own.boat, d)); }
  own.boat.group.position.set(own.x, 0, own.z); own.boat.group.rotation.y = -own.h * DEG;
  own.boat.group.visible = !aboveFog && !EMPTY;
  followBtn.classList.toggle('on', follow === own);
  const day = own.nights.length ? `Day ${1 + own.nights.filter(c => own.S >= c - 1).length} of ${own.nights.length + 1} · ` : '';
  if (!own.ext && lblTick % 6 === 0) sailNote.textContent = (own.vj ? 'Following your Virtual Journey · ' : '') + day + `${(own.S / NMm).toFixed(1)} / ${(own.total / NMm).toFixed(1)} nm` + (up ? ` · ${p.name}` : env.W.heel === 0 ? ' · calm' : ' · arrived');
}
// an overnight stop on a Virtual Journey (v887): sunset, night, dawn and day again over its few seconds
let night = null, nightSeen = 0;
function updateNight() {
  if (!night) return;
  const u = (Date.now() - night.start) / night.dur;
  if (u >= 1) { night = null; env.blendHour = null; applyConditions({ time: 'day' }); return; }
  const L = cycleLook(night.from, u); env.blendT = L.T; env.blendHour = L.hour; applyConditions({ time: L.time }); env.blendT = null;   // (blendHour stays set: the moon follows the cycle, not the night clock)
}
try {   // a Virtual Journey of this route running in AudioChart
  const ch = new BroadcastChannel('audiochart-vj');
  ch.onmessage = e => {
    const m = e.data || {};
    if ('rate' in m) env.setMoonRate(m.rate);   // the journey's time rate drives the moon (v916)
    if (m.cycle && m.cycle.start !== nightSeen) { nightSeen = m.cycle.start; night = { ...m.cycle, from: env.C.time }; }   // an overnight stop (v887)
    if (own.ext) return;   // inside the chart, the chart's boat already is the journey
    if (!own.r || (m.routeId !== own.r.id && 'sample:' + m.routeId !== own.r.id && m.routeId !== own.r.name)) return;
    if (m.running && !own.vj && env.W.heel === 0) applyConditions({ wind: 'breezy' });   // a journey's begun: she can't sail in a calm
    own.vj = m.running ? { frac: clamp(m.frac, 0, 1) } : null;
    if (own.vj) { own.S = own.vj.frac * own.total; linkClock(); }
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
    if (params.get('play') === '1') { own.playing = true; sailBtn.textContent = '❚❚ Pause'; linkClock(); }
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
for (const l of (landGJ.landmarks || []).filter(l => inBay([l.lon, l.lat]))) places.push({ n: l.name, x: wx(l.lon), z: wz(l.lat), lon: l.lon, lat: l.lat, elev: l.elev_m });   // summits
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
    for (const v of traffic) {   // ferries and cruise ships
      if (!v.on || view.dist > 40000 || (nest.on && nest.v === v)) continue;
      const d = Math.hypot(v.x - view.x, v.z - view.z);
      if (d < Math.max(view.dist * 2, 4000)) cand.push({ text: v.label, x: v.x, y: (v.kind === 'cruise' ? 55 : 14) * v.group.scale.x, z: v.z, cls: 'wpt', pri: (v.kind === 'cruise' ? 0.6 : 0.9) + d / 1e6 });
    }
    for (const v of live) {   // live AIS vessels (v986)
      if (!v.on || view.dist > 40000 || (nest.on && nest.v === v)) continue;
      const d = Math.hypot(v.x - view.x, v.z - view.z);
      if (d < Math.max(view.dist * 2, 4000)) cand.push({ text: `📡 ${aisName(v.A)}${v.ashore ? ' · ashore' : ''}`, x: v.x, y: v.ashore ? Math.max(0, heightAt(v.A.lon, v.A.lat)) + 8 : (v.L > 100 ? 45 : v.L > 25 ? 14 : 8) * v.group.scale.x, z: v.z, cls: 'wpt', pri: 0.85 + d / 1e6 });
    }
    if (bowdoin && nest.v !== bowdoin && view.dist < 30000) { const d = Math.hypot(bowdoin.x - view.x, bowdoin.z - view.z); if (d < Math.max(view.dist * 2, 3000)) cand.push({ text: 'Bowdoin', x: bowdoin.x, y: 24 * bowdoin.boat.group.scale.x, z: bowdoin.z, cls: 'wpt', pri: 0.7 }); }
    // (v907: no "⛵ You" label over your boat any more — requested: "get rid of the box that follows the boat")
    if (view.dist < 40000) for (const p of [...wps, ...pins]) {   // route waypoints and search pins
      const d = Math.hypot(p.g.position.x - view.x, p.g.position.z - view.z);
      if (d < Math.max(view.dist * 2, 3000)) cand.push({ text: p.label, x: p.g.position.x, y: 4.6 * p.g.scale.x, z: p.g.position.z, cls: 'wpt', pri: 0.8 + d / Math.max(view.dist * 2, 3000) });
    }
    if (buoyF && view.dist < 90000) { const d = Math.hypot(buoyF.x - view.x, buoyF.z - view.z); if (d < Math.max(view.dist * 2, 4000)) cand.push({ text: buoyLabel(), x: buoyF.x, y: 6 * buoyF.g.scale.x, z: buoyF.z, cls: 'wpt tap', pri: 0.75 + d / 1e6, click: () => showCard(buoyF) }); }   // Buoy F (v1013)
    if (gauge && view.dist < 90000) { const d = Math.hypot(gauge.x - view.x, gauge.z - view.z); if (d < Math.max(view.dist * 2, 4000)) cand.push({ text: gaugeLabel(), x: gauge.x, y: gauge.g.position.y + 7 * gauge.g.scale.x, z: gauge.z, cls: 'wpt tap', pri: 0.75 + d / 1e6, click: () => showCard(gauge) }); }   // the tide gauge (v1014)
    if (rockXZ && view.dist < 90000) { const d = Math.hypot(rockXZ.x - view.x, rockXZ.z - view.z); if (d < Math.max(view.dist * 2, 4000)) cand.push({ text: rockLabel(), x: rockXZ.x, y: Math.max(heightAt(ROCK.wind.lon, ROCK.wind.lat), 0) + Math.max(15, view.dist * 0.01), z: rockXZ.z, cls: 'wpt', pri: 0.76 + d / 1e6 }); }   // Matinicus Rock (v1016)
    { const c = curNear(); if (c) cand.push({ text: c.text, x: c.x, y: Math.max(2, view.dist * 0.0012) + 2, z: c.z, cls: 'wpt', pri: 0.85 }); }   // the forecast current here (v1015)
    if (vecTip) cand.push({ text: vecTip.text, x: vecTip.x, y: 4, z: vecTip.z, cls: 'wpt', pri: 0.4 });   // her vector's tip (v1008)
    for (const o of fixList) cand.push({ text: `${o.m.n} · ${fixBrg(o)}, ${fixRange(o.d)}`, x: o.m.x, y: Math.max(6, heightAt(o.m.lon, o.m.lat) + 6), z: o.m.z, cls: 'wpt', pri: 0.5 });   // her marks (v1000)
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
    if (!el) { el = document.createElement('div'); labelsEl.appendChild(el); pool[n] = el; el.addEventListener('click', () => el._town ? goTown(el._town) : el._click?.()); }
    el.className = 'lbl ' + c.cls; el.textContent = c.text; el.style.left = x + 'px'; el.style.top = y + 'px'; el.hidden = false; el._town = c.town || null; el._click = c.click || null;
    n++;
  }
  for (let i = n; i < pool.length; i++) pool[i].hidden = true;
}

// ── Where the live vessels are (v1006, requested: "it's hard to tell from birdseye view when zoomed out which
// vessels are being tracked. Maybe we should flash them, or flash them on command?") ── Zoomed out, where a ship is
// a speck and her name may be crowded off, each live vessel has a small green ring (brass for the one followed),
// tap it for her card. ✨ Find, or F, flashes them all for a few seconds, from any height, and so does the first
// sight of the feed's vessels.
const marksEl = document.getElementById('livemarks'), markPool = [], findBtn = document.getElementById('findbtn');
let flashUntil = 0, flashedOnce = false;
function flashLive(ms = 6000) { flashUntil = performance.now() + ms; }
function updateLiveMarks() {
  const flash = performance.now() < flashUntil, far = !nest.on && view.dist > 4000;
  marksEl.classList.toggle('flash', flash);
  if (findBtn) findBtn.hidden = !liveFeed.on || !live.length;
  if (live.length && !flashedOnce) { flashedOnce = true; flashLive(); } else if (!liveFeed.on) flashedOnce = false;   // (again each time Live comes on)
  const W = sceneEl.clientWidth, H = sceneEl.clientHeight;
  let n = 0;
  if (far || flash) for (const v of live) {
    if (!v.on || (nest.on && nest.v === v)) continue;
    const p = v3.set(v.x, v.ashore ? Math.max(0, heightAt(v.A.lon, v.A.lat)) : 2, v.z).project(camera);
    if (p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) continue;
    let el = markPool[n];
    if (!el) { el = document.createElement('i'); marksEl.appendChild(el); markPool[n] = el; el.addEventListener('click', () => el._v && live.includes(el._v) && showCard(el._v)); }
    // underway, in a brighter green (v1013, requested: "flash a different shade of green if they are actually
    // underway"): making 0.5 kn or more, and not reporting herself at anchor or moored
    const uw = !v.ashore && (v.A.sog ?? 0) >= 0.5 && v.A.status !== 1 && v.A.status !== 5;
    el._v = v; el.title = `${aisName(v.A)}${uw ? ' · underway' : ''}`; el.className = (follow === v ? 'fol' : '') + (uw ? ' uw' : '');
    el.style.left = (p.x + 1) / 2 * W + 'px'; el.style.top = (1 - p.y) / 2 * H + 'px'; el.hidden = false;
    n++;
  }
  for (let i = n; i < markPool.length; i++) markPool[i].hidden = true;
}
findBtn?.addEventListener('click', () => flashLive());
addEventListener('keydown', e => { if (e.target === document.body && (e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && live.length) { flashLive(); e.preventDefault(); } });

// ── Readout: height and heading ──
const altEl = document.getElementById('alt'), needle = document.getElementById('needle');
function updateReadout() {
  const ft = camera.position.y / 0.3048;
  altEl.textContent = ft > 9000 ? `${(camera.position.y / 1852).toFixed(1)} nm up` : `${ft < 200 ? Math.round(ft) : Math.round(ft / 50) * 50} ft up`;   // (aboard: to the foot)
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
  if (!nest.on) { clampView(); placeCamera(); }
  if (t - lastCheck > 0.4) { lastCheck = t; updateTiles(); updateTowns(); updateMarks(); updateHazards(); }
  // the wrecks blink (v932, requested): a bright orange glow, on for 0.6 s in every 1.2 s
  if (hazards.meshes.wreck) hazards.meshes.wreck.m.material.emissive.setHex(t % 1.2 < 0.6 ? 0xff6a1a : 0x000000);
  if (!drag && !anim) updateTrees(); else if (t - (TREES.lastMove || 0) > 0.25) { TREES.lastMove = t; updateTrees(); }
  if (EMPTY) stepWater(dt);
  water.position.set(view.x, EMPTY ? (waterLevel < 0 ? waterLevel * EXAG : waterLevel) : 0, view.z);
  if (EMPTY) { water.visible = waterLevel > WATER_MIN; env.foam.visible = false; }   // (the weather turns the whitecaps on in a breeze)
  sky.position.copy(camera.position);
  updateNight();
  updateWeather(dt, t);
  updateFleet(dt);
  updateTraffic();
  updateLive(dt);
  updateWaypoints();
  updateOwn(dt);
  updateWakes(dt);
  if (nest.on) nestCamera();   // after every vessel has moved, yours too
  if (nest.on || !rcEl?.hidden) drawRideChart();
  wildlife.update(dt, t, view, camera.position, { hidden: !!aboveFog || EMPTY, night: env.C.time === 'night', boat: (own.ext || own.r) ? own : null, scale: d => clamp(d / 35, 3, 8) });
  syncFollowHud(); updateFixLines(); updateVector(); updateBuoyF(); updateGauge(); updateCurrents();
  if (follow && !anim && !nest.on) { const k = Math.min(1, dt * 4); view.x += (follow.x - view.x) * k; view.z += (follow.z - view.z) * k; }
  renderer.render(scene, camera);
  updateLabels(); updateLiveMarks(); updateReadout();
  requestAnimationFrame(frame);
}
// Weather panel: in the readout box, top right; the forecast is for where you're looking
// choosing a time of day yourself (a Time button, N, Forecast now) takes the light back from the clock until you
// move the clock again (v975: after a clock change, lightForClock undid the choice within a second)
wxPanel = weatherPanel({ host: document.getElementById('scale'), panelParent: document.body, where: () => [lonOf(view.x), latOf(view.z)], pick: c => { if ('time' in c) simClock.light = false; applyConditions(c); } });
applyConditions(startConditions(params));
statusEl.hidden = true;
requestAnimationFrame(frame);
window.__bay3d = {   // for AudioChart (returning to the chart where you were) and for testing
  // Clear Screen on the chart (v953): drop the route's waypoints and line, as the chart drops its routes
  clearRoute: () => { showRoute('', false); clearPins(); },
  dropPin,
  region: RID,
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
  goWhole, towns: townList, tiles, scene, env, traffic, clockMin, setClock, camera, applyConditions, fleet, own, bowdoin, nest, setNest, ride, leaveRide, lookoutReport, findBerth, pierSegs, ferryStops, moorings, isWaterXZ: (x, z) => isWater(x, z), isWater: (lat, lon) => isWater(wx(lon), wz(lat)), boatAt: i => ({ lat: latOf(fleet[i].z), lon: lonOf(fleet[i].x), h: fleet[i].h }), renderer, trees: () => ({ near: TREES.near.count, far: TREES.far.count, K: TREES.K }),
};
}
main().catch(err => { console.error(err); fail('Could not start the 3D view: ' + err.message); });

// Clear view (v911): the chart's "⛶ Clear" button hides this view's own buttons too; follow its class
try {
  const app = window.parent !== window && window.parent.document.getElementById('app');
  if (app) { const sync = () => document.body.classList.toggle('clear-view', app.classList.contains('clear-view')); sync(); new MutationObserver(sync).observe(app, { attributes: true, attributeFilter: ['class'] }); }
} catch (_) {}
