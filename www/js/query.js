/**
 * Spatial query engine using Turf.js.
 * Loads GeoJSON data once at startup, keeps in memory.
 */

import { bearingToWords, bearingToDisplay, formatDistance, distanceToDisplay, formatDM, trueTomagnetic, setMagneticVariation, compassDirectionWords, naturalDistance, magneticVariation } from './utils.js';

// ── IndexedDB offline store ───────────────────────────────────────────────────
// Works on plain HTTP (unlike the Cache API which requires HTTPS/localhost).

const IDB_NAME = 'audiochart-offline';
const IDB_STORE = 'geojson';
const IDB_VERSION = 1;

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ── Loaded per-position; exported for tests ───────────────────────────────────
export let hazards = null;
export let namedPlaces = null;
export let navaids = null;
export let waypoints = null;
export let restrictions = null;
let landPolygons = null;  // LNDARE polygons for line-of-sight checks
let _landLoadPromise = null;
export let depthZones = null;  // 'shallow area' Polygon features — always real geometry
export let channels   = null;  // FAIRWY polygon features from ENC data
let channelGraph = null;       // LineString edges: fairway centerlines + recommended tracks
let _channelIndex = null;      // built once from channelGraph — see _buildChannelIndex
export let soundings  = null;  // SOUNDG depth sounding points (thinned, ≤30m)

// ── Active region (Piece 2: parameterized regions) ────────────────────────
// Land/channels/channel-graph/soundings/depth-zone-source were, until now,
// always fetched from a single fixed top-level path — completely outside
// the CRUISE_PROFILES/prepareOfflineStatic per-region download system, so
// picking a non-default region silently kept serving the bundled default
// region's geometry. The active region is None by default (the bundled
// region, unchanged behavior/paths); setActiveRegion() switches it once a
// user picks a CRUISE_PROFILES entry.
const ACTIVE_REGION_KEY = 'audiochart-active-region';
let _activeRegion = null;
try { _activeRegion = localStorage.getItem(ACTIVE_REGION_KEY) || null; } catch (_) {}

export function getActiveRegion() { return _activeRegion; }
export function setActiveRegion(id) {
  const next = id || null;
  if (next === _activeRegion) return;
  _activeRegion = next;
  try {
    if (_activeRegion) localStorage.setItem(ACTIVE_REGION_KEY, _activeRegion);
    else localStorage.removeItem(ACTIVE_REGION_KEY);
  } catch (_) {}
  // loadData()'s land/channels/channel-graph/soundings/depth-zone fetches
  // are each guarded by "if (!alreadyLoaded)" — without clearing the
  // already-loaded state here, switching regions after the bundled default
  // (or a previous region) already loaded would silently keep serving that
  // stale geometry forever, since loadData() would see it as "already have
  // this" and never re-fetch.
  landPolygons = null; _landIndex = null; _landLoadPromise = null;
  depthZones = null;
  channels = null;
  channelGraph = null; _channelIndex = null;
  soundings = null;
}

// Region-scoped path for a geometry file — the bundled default region keeps
// its exact original top-level path (zero behavior change), any other
// active region reads from its own www/data/regions/<id>/ subdirectory.
function _regionPath(filename) {
  return _activeRegion ? `./data/regions/${_activeRegion}/${filename}` : `./data/${filename}`;
}
export let lastBearingResult = null;   // set by bearing queries; read by map view
export let lastCourseHazards = null;   // set by hazardsOnCourse; [{lat,lon,label,name}]
export let lastNavaidResults  = null;   // set by navaidsInRadius; [{lat,lon,label,name,colour,characteristic,brg,d}]
export let lastHazardResults = null;   // set by hazardsInRadius;  [{lat,lon,label,name,brg,d}]
export let focusedTarget = null;   // {lat, lon, name, type} — the "current" object

// The most recently dropped quick waypoint (long-press -> Waypoint -> Set).
// A quick-dropped waypoint gets an auto-generated name (wp001, wp002, ...)
// that's fast to place but not something you'd remember or say with
// confidence a minute later — "what's it called? who knows?" was the exact
// complaint. "Active Waypoint" is a fixed, unambiguous name that always
// means "whichever one I just dropped", resolved directly in
// findPlaceByName below so it works anywhere a place name is accepted
// (auto-route destination, focus, bearing queries) without needing to
// remember the real name at all.
export let activeWaypoint = null;  // {lat, lon, name}

const FOCUS_KEY = 'audiochart-focus';
const ACTIVE_WP_KEY = 'audiochart-active-waypoint';

export function setActiveWaypoint(lat, lon, name) {
  activeWaypoint = { lat, lon, name };
  try { localStorage.setItem(ACTIVE_WP_KEY, JSON.stringify(activeWaypoint)); } catch (_) {}
}

export function loadStoredActiveWaypoint() {
  try {
    const s = localStorage.getItem(ACTIVE_WP_KEY);
    if (s) activeWaypoint = JSON.parse(s);
  } catch (_) {}
  return activeWaypoint;
}

export function setFocus(lat, lon, name, type = 'place') {
  focusedTarget = { lat, lon, name, type };
  try { localStorage.setItem(FOCUS_KEY, JSON.stringify(focusedTarget)); } catch (_) {}
}

export function clearFocus() {
  focusedTarget = null;
  try { localStorage.removeItem(FOCUS_KEY); } catch (_) {}
}

export function loadStoredFocus() {
  try {
    const s = localStorage.getItem(FOCUS_KEY);
    if (s) focusedTarget = JSON.parse(s);
  } catch (_) {}
  return focusedTarget;
}

/** Bearing/range to the currently focused target. Returns null if none set. */
export function bearingToFocusedTarget(lat, lon) {
  if (!focusedTarget) return null;
  if (!focusedTarget.name) return bearingToCoord(lat, lon, focusedTarget.lat, focusedTarget.lon);
  return _formatBearingResult(
    lat, lon, focusedTarget.lat, focusedTarget.lon, focusedTarget.name,
    focusedTarget.type === 'waypoint', 1.0
  );
}

let _serverBase = null;
let _lastFetchLat = null;
let _lastFetchLon = null;
let _waypointPollTimer = null;
const REFETCH_DISTANCE_NM = 3.0;
const WAYPOINT_POLL_MS = 30_000;  // re-check OpenCPN waypoints every 30s

export function setServerBase(url) {
  _serverBase = url;
}

/** Merge user-defined waypoints into the in-memory waypoints FeatureCollection. */
export function mergeUserWaypoints(wps) {
  if (!wps || !wps.length) return;
  if (!waypoints) waypoints = { type: 'FeatureCollection', features: [], count: 0 };
  const existing = new Set(waypoints.features.map(f => f.properties?.name?.toLowerCase()));
  for (const wp of wps) {
    if (!existing.has(wp.name.toLowerCase())) {
      waypoints.features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [wp.lon, wp.lat] },
        properties: { name: wp.name, name_lower: wp.name.toLowerCase(), label: 'waypoint' },
      });
    }
  }
}

export function removeUserWaypoint(name) {
  if (!waypoints?.features) return;
  const lower = name.toLowerCase();
  waypoints.features = waypoints.features.filter(
    f => !(f.properties?.label === 'waypoint' && f.properties?.name?.toLowerCase() === lower)
  );
}

export async function hasOfflineData() {
  const h = await idbGet('hazards').catch(() => null);
  return !!(h?.features?.length);
}

/** Fetch the latest OpenCPN waypoints from the server. */
export async function refreshWaypoints() {
  if (!_serverBase) return;
  try {
    const resp = await fetch(`${_serverBase}/api/waypoints`, { cache: 'no-store' });
    if (resp.ok) {
      const data = await resp.json();
      waypoints = data;
      console.log(`[query] ${data.count} OpenCPN waypoints loaded`);
    }
  } catch (_) {}
}

function _startWaypointPolling() {
  if (_waypointPollTimer) return;
  _waypointPollTimer = setInterval(refreshWaypoints, WAYPOINT_POLL_MS);
}

/** Haversine distance in nm (used to decide when to refetch) */
function _distNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dphi = (lat2 - lat1) * Math.PI / 180;
  const dlam = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dphi/2)**2 + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlam/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/**
 * Load chart data for the given position.
 * Uses /api/nearby when the Mac server is available;
 * falls back to the static GeoJSON files for offline use.
 */

// When DEPARE polygons from multiple chart scales overlap at the same location,
// keep only the most-detailed chart's polygon. Builds a grid spatial index over
// fine-scale (US5+) polygons, then drops coarser polygons whose sampled vertices
// are mostly inside finer zones (i.e. the fine chart supersedes them there).
function _prioritiseByChartScale(zones) {
  const chartScale = name => { const m = (name || '').match(/^US(\d)/); return m ? +m[1] : 0; };
  const GRID = 0.01; // ~0.5nm cells

  // Build spatial index for fine (US5+) polygons
  const idx = new Map();
  for (const f of zones) {
    if (chartScale(f.properties.chart) < 5) continue;
    const geom = f.geometry;
    const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
    const lons = ring.map(c => c[0]), lats = ring.map(c => c[1]);
    const entry = { minLon: Math.min(...lons), maxLon: Math.max(...lons), minLat: Math.min(...lats), maxLat: Math.max(...lats), ring };
    for (let col = Math.floor(entry.minLon / GRID); col <= Math.ceil(entry.maxLon / GRID); col++) {
      for (let row = Math.floor(entry.minLat / GRID); row <= Math.ceil(entry.maxLat / GRID); row++) {
        const key = `${col},${row}`;
        if (!idx.has(key)) idx.set(key, []);
        idx.get(key).push(entry);
      }
    }
  }

  function coveredByFine(lon, lat) {
    const candidates = idx.get(`${Math.floor(lon / GRID)},${Math.floor(lat / GRID)}`) || [];
    for (const e of candidates) {
      if (lon < e.minLon || lon > e.maxLon || lat < e.minLat || lat > e.maxLat) continue;
      const r = e.ring; let inside = false, px = r[0][0], py = r[0][1];
      for (let i = 1; i <= r.length; i++) {
        const [cx, cy] = r[i % r.length];
        if ((py > lat) !== (cy > lat) && lon < (cx - px) * (lat - py) / (cy - py) + px) inside = !inside;
        px = cx; py = cy;
      }
      if (inside) return true;
    }
    return false;
  }

  return zones.filter(f => {
    if (chartScale(f.properties.chart) >= 5) return true;
    const geom = f.geometry;
    const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
    const step = Math.max(1, Math.floor(ring.length / 10));
    let covered = 0, total = 0;
    for (let i = 0; i < ring.length; i += step) { total++; if (coveredByFine(ring[i][0], ring[i][1])) covered++; }
    return covered / total < 0.2;
  });
}

// Fetch a geometry file for the active region: IndexedDB cache first (if a
// non-default region is active and was previously downloaded), then a
// region-scoped network fetch, falling back to the bundled default-region
// file if neither succeeds — this ordering is what keeps the bundled
// region's own behavior completely unchanged (no active region ⇒ this is
// just "fetch ./data/<filename>", same as before) while making a real
// downloaded region take priority once one is active. IDB key is reused
// (not kept per-region) since the app is used in one cruising area at a
// time, not several simultaneously.
async function _fetchRegionGeometry(idbKey, filename) {
  if (_activeRegion) {
    try {
      const cached = await idbGet(idbKey);
      if (cached) return cached;
    } catch (_) {}
    try {
      const r = await fetch(_regionPath(filename));
      if (r.ok) {
        const data = await r.json();
        idbPut(idbKey, data).catch(() => {});
        return data;
      }
    } catch (_) {}
    console.warn(`[AC] ${filename} not yet downloaded for region "${_activeRegion}" — using bundled default`);
  }
  try {
    const r = await fetch(`./data/${filename}`);
    return r.ok ? r.json() : null;
  } catch (_) {
    return null;
  }
}

/** Fetch+cache the 4 region-scoped geometry files ahead of time (alongside
 * Query.prepareOfflineStatic's point-feature download) so switching to a
 * newly-downloaded region doesn't first show stale bundled-default geometry
 * before the network fetch above completes. */
export async function prepareOfflineRegionGeometry(regionId) {
  for (const [idbKey, filename] of [
    ['land', 'land.geojson'], ['channels', 'channels.geojson'],
    ['channel_graph', 'channel_graph.geojson'], ['soundings', 'soundings.geojson'],
  ]) {
    try {
      const r = await fetch(`./data/regions/${regionId}/${filename}`);
      if (r.ok) await idbPut(idbKey, await r.json());
    } catch (_) {}
  }
}

export async function loadData(lat, lon) {
  // Land polygons and depth zones are position-independent — load once regardless of mode.
  // Depth zones always come from hazards.geojson so we get real polygon
  // geometry even when the server API only returns centroid points.
  if (!landPolygons) {
    _landLoadPromise = _fetchRegionGeometry('land', 'land.geojson')
      .then(land => {
        if (land) landPolygons = land;
        console.log(`[AC] Land polygons: ${landPolygons ? landPolygons.features.length : 'FAILED TO LOAD'}`);
        if (landPolygons) _landIndex = _buildLandEdgeIndex();
      })
      .catch(() => console.warn('[AC] land.geojson failed to load'));
  }
  if (!depthZones) {
    _fetchRegionGeometry('hazards_polygons', 'hazards.geojson')
      .then(fc => {
        if (fc) {
          const raw = fc.features.filter(f =>
            f.properties?.label === 'shallow area' && f.geometry?.type !== 'Point'
          );
          depthZones = _prioritiseByChartScale(raw);
        }
        console.log(`[AC] Depth zones: ${depthZones ? depthZones.length : 'FAILED TO LOAD'}`);
      })
      .catch(() => console.warn('[AC] hazards.geojson failed to load for depth zones'));
  }
  if (!channels) {
    _fetchRegionGeometry('channels', 'channels.geojson')
      .then(fc => {
        if (fc) channels = fc.features.filter(f => f.geometry?.type !== 'Point');
        console.log(`[AC] Channels: ${channels ? channels.length : 'not found'}`);
      })
      .catch(() => {});  // optional file — no warning if absent
  }
  if (!channelGraph) {
    _fetchRegionGeometry('channel_graph', 'channel_graph.geojson')
      .then(fc => {
        if (fc) { channelGraph = fc.features; _channelIndex = _buildChannelIndex(); }
        console.log(`[AC] Channel graph: ${channelGraph ? channelGraph.length : 'not found'} edges`);
      })
      .catch(() => {});  // optional file — no warning if absent; router falls back to normal behavior
  }
  if (!soundings) {
    _fetchRegionGeometry('soundings', 'soundings.geojson')
      .then(fc => {
        if (fc) soundings = fc;
        console.log(`[AC] Soundings: ${soundings ? soundings.features.length : 'not found'}`);
      })
      .catch(() => {});  // optional file — no warning if absent
  }

  // Try server API first
  if (_serverBase && lat != null && lon != null) {
    try {
      const url = `${_serverBase}/api/nearby?lat=${lat}&lon=${lon}`;
      const resp = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        const data = await resp.json();
        hazards = data.hazards;
        namedPlaces = data.places;
        navaids = data.navaids;
        restrictions = data.restrictions || null;
        if (data.magvar != null) {
          setMagneticVariation(data.magvar);
          console.log(`[query] MAGVAR from chart: ${data.magvar}°`);
        }
        _lastFetchLat = lat;
        _lastFetchLon = lon;
        console.log(`[query] Loaded ${data.count} features within ${data.radius_nm}nm of ${lat.toFixed(3)},${lon.toFixed(3)}`);
        await refreshWaypoints();
        _startWaypointPolling();
        return;
      }
    } catch (e) {
      console.warn('[query] Server API unavailable, falling back to static files:', e.message);
    }
  }

  // Offline fallback: check IndexedDB first (pre-downloaded at dock),
  // then fall back to the static files bundled with the app.
  // Version-check: if static files are newer than IDB data, use static files.
  let networkVersion = null;
  try {
    const vr = await fetch('./data/data-version.json');
    if (vr.ok) networkVersion = (await vr.json()).version;
  } catch (_) {}

  const [idbH, idbP, idbN, idbW, idbR, storedVersion] = await Promise.all([
    idbGet('hazards').catch(() => null),
    idbGet('named_places').catch(() => null),
    idbGet('navaids').catch(() => null),
    idbGet('waypoints').catch(() => null),
    idbGet('restrictions').catch(() => null),
    idbGet('data-version').catch(() => null),
  ]);

  const idbCurrent = idbH && networkVersion && storedVersion === networkVersion;

  if (idbCurrent) {
    hazards = idbH;
    namedPlaces = idbP;
    navaids = idbN;
    waypoints = idbW;
    restrictions = idbR || null;
    console.log(`[query] Loaded offline data from IndexedDB (version ${storedVersion})`);
  } else {
    if (idbH && !idbCurrent) {
      console.log(`[query] IDB data stale (stored=${storedVersion} network=${networkVersion}), using static files`);
    }
    const [h, p, n] = await Promise.all([
      fetch('./data/hazards.geojson').then(r => r.json()),
      fetch('./data/named_places.geojson').then(r => r.json()),
      fetch('./data/navaid.geojson').then(r => r.json()),
    ]);
    hazards = h;
    namedPlaces = p;
    navaids = n;
    if (networkVersion) await idbPut('data-version', networkVersion);
    console.log(`[query] Loaded offline data from static files (version ${networkVersion})`);
  }

  const storedMagvar = localStorage.getItem('audiochart-magvar');
  if (storedMagvar) setMagneticVariation(parseFloat(storedMagvar));
}

/**
 * Download a pre-built regional data file and merge into IndexedDB.
 * Used in standalone mode (no Mac server) — fetches from hosted static URL.
 * Downloads are additive, same deduplication logic as prepareOffline().
 */
export async function prepareOfflineStatic(dataUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let resp;
  try {
    resp = await fetch(dataUrl, { cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const data = await resp.json();

  if (data.magvar != null) {
    localStorage.setItem('audiochart-magvar', String(data.magvar));
  }

  const key = f => {
    const [lon, lat] = f.geometry.coordinates;
    return `${lat.toFixed(4)},${lon.toFixed(4)}`;
  };
  const pairs = [
    ['hazards',      data.hazards.features],
    ['named_places', data.places.features],
    ['navaids',      data.navaids.features],
    ['restrictions', (data.restrictions?.features) || []],
  ];
  for (const [idbKey, newFeatures] of pairs) {
    const existing = await idbGet(idbKey).catch(() => null);
    const existingFeatures = existing?.features || [];
    const seen = new Set(existingFeatures.map(key));
    const added = newFeatures.filter(f => !seen.has(key(f)));
    await idbPut(idbKey, { type: 'FeatureCollection', features: [...existingFeatures, ...added] });
  }
  const stored = await Promise.all(pairs.map(([k]) => idbGet(k).then(fc => (fc?.features || []).length)));
  // Record the current data version so the freshness check passes after
  // download — per-region (matching merge_charts.py --region's own
  // data-version.json) when dataUrl points at a regions/<id>.json bundle,
  // else the bundled default region's original global path, unchanged.
  try {
    const regionId = dataUrl.match(/regions\/([^/]+)\.json$/)?.[1];
    const versionUrl = regionId ? `./data/regions/${regionId}/data-version.json` : './data/data-version.json';
    const vr = await fetch(versionUrl);
    if (vr.ok) await idbPut('data-version', (await vr.json()).version);
  } catch (_) {}
  return { added: data.count, total: stored.reduce((a, b) => a + b, 0) };
}

/**
 * Pre-cache chart data and waypoints for offline use via IndexedDB.
 * Works on plain HTTP (unlike the Cache API which needs HTTPS/localhost).
 * Downloads are additive — call multiple times for different areas.
 */
export async function prepareOffline(lat, lon, radiusNm = 20) {
  if (!_serverBase) throw new Error('No server connection');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let resp;
  try {
    resp = await fetch(
      `${_serverBase}/api/nearby?lat=${lat}&lon=${lon}&radius=${radiusNm}`,
      { cache: 'no-store', signal: controller.signal }
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) throw new Error(`Server error: ${resp.status}`);
  const data = await resp.json();

  if (data.magvar != null) {
    localStorage.setItem('audiochart-magvar', String(data.magvar));
  }

  // Coordinate key for deduplication (within ~10m)
  const key = f => {
    const [lon, lat] = f.geometry.coordinates;
    return `${lat.toFixed(4)},${lon.toFixed(4)}`;
  };

  // Merge each layer with existing IndexedDB data
  const pairs = [
    ['hazards',      data.hazards.features],
    ['named_places', data.places.features],
    ['navaids',      data.navaids.features],
    ['restrictions', (data.restrictions?.features) || []],
  ];

  for (const [idbKey, newFeatures] of pairs) {
    const existing = await idbGet(idbKey).catch(() => null);
    const existingFeatures = existing?.features || [];
    const seen = new Set(existingFeatures.map(key));
    const added = newFeatures.filter(f => !seen.has(key(f)));
    await idbPut(idbKey, { type: 'FeatureCollection', features: [...existingFeatures, ...added] });
  }

  // Waypoints always replace (small, always current)
  const wpResp = await fetch(`${_serverBase}/api/waypoints`, { cache: 'no-store' });
  if (wpResp.ok) {
    await idbPut('waypoints', await wpResp.json());
  }

  // Return totals for status display
  const stored = await Promise.all(pairs.map(([k]) => idbGet(k).then(fc => (fc?.features || []).length)));
  const grandTotal = stored.reduce((a, b) => a + b, 0);

  return { added: data.count, total: grandTotal, radius_nm: radiusNm };
}

/**
 * Pre-download ESRI satellite tiles for offline map use.
 * Uses a tiered radius: wide at low zoom (overview), narrow at high zoom (detail).
 * Tiles are stored in the service worker's persistent satellite cache.
 * onProgress(done, total) is called after each batch.
 */
export async function cacheSatelliteTiles(lat, lon, onProgress) {
  if (!('caches' in window)) return { added: 0, total: 0 };

  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';
  // [zoom, radius_nm] — wide radius at low zoom, tight radius at high zoom
  const ZOOM_RADII = [[10, 25], [11, 25], [12, 12], [13, 6]];

  function tileXY(lat, lon, z) {
    const n = 2 ** z;
    const x = Math.floor((lon + 180) / 360 * n);
    const lr = Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180));
    const y = Math.floor((1 - lr / Math.PI) / 2 * n);
    return { x, y };
  }

  const urls = [];
  for (const [z, radiusNm] of ZOOM_RADII) {
    const padLat = radiusNm / 60;
    const padLon = padLat / Math.cos(lat * Math.PI / 180);
    const { x: x0, y: y0 } = tileXY(lat + padLat, lon - padLon, z);
    const { x: x1, y: y1 } = tileXY(lat - padLat, lon + padLon, z);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        urls.push(`${ESRI}/${z}/${y}/${x}`);  // ESRI uses z/y/x order
  }

  const cache = await caches.open('audiochart-satellite-v1');
  let added = 0;
  const BATCH = 12;

  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);
    await Promise.all(batch.map(async url => {
      if (await cache.match(url)) return;
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (resp.ok) { await cache.put(url, resp); added++; }
      } catch (_) {}
    }));
    if (onProgress) onProgress(Math.min(i + BATCH, urls.length), urls.length);
  }
  return { added, total: urls.length };
}

/**
 * Reload data if vessel has moved significantly from last fetch position.
 * Call this whenever position updates.
 */
export async function refreshIfNeeded(lat, lon) {
  if (!_serverBase) return;
  if (_lastFetchLat == null) return;
  const dist = _distNm(lat, lon, _lastFetchLat, _lastFetchLon);
  if (dist >= REFETCH_DISTANCE_NM) {
    console.log(`[query] Vessel moved ${dist.toFixed(1)}nm — refreshing chart data`);
    await loadData(lat, lon);
  }
}

/**
 * Look up a place name in loaded waypoints and named places.
 * Returns {lat, lon, name} for the best match, or null.
 * Used by the test position input so you can type "Camden" instead of coordinates.
 */
const LABEL_RANK = { town: 3, harbour: 3, 'coastal feature': 2, 'sea area': 0 };

const _DIRECTIONAL = [
  { re: /^west(?:ern)?\s+(?:end|entrance|side)\s+(?:of|to)\s+/i, bearing: 270 },
  { re: /^east(?:ern)?\s+(?:end|entrance|side)\s+(?:of|to)\s+/i, bearing: 90 },
  { re: /^north(?:ern)?\s+(?:end|entrance|side)\s+(?:of|to)\s+/i, bearing: 0 },
  { re: /^south(?:ern)?\s+(?:end|entrance|side)\s+(?:of|to)\s+/i, bearing: 180 },
  { re: /^(?:entrance|entry|mouth)\s+(?:of|to)\s+/i, bearing: null },
];

function parseDirectional(query) {
  for (const { re, bearing } of _DIRECTIONAL) {
    const m = query.match(re);
    if (m) return { clean: query.slice(m[0].length).trim(), bearing };
  }
  return { clean: query, bearing: null };
}

export function offsetCoords(lat, lon, bearingDeg, distNm = 3.0) {
  const R = 3440.065;
  const d = distNm / R;
  const brg = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180, lon1 = lon * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1)*Math.cos(d) + Math.cos(lat1)*Math.sin(d)*Math.cos(brg));
  const lon2 = lon1 + Math.atan2(Math.sin(brg)*Math.sin(d)*Math.cos(lat1),
                                  Math.cos(d) - Math.sin(lat1)*Math.sin(lat2));
  return { lat: lat2 * 180/Math.PI, lon: lon2 * 180/Math.PI };
}

function parseDisambiguated(query) {
  const i = query.indexOf(',');
  if (i === -1) return { primary: query.trim().toLowerCase(), qualifier: null };
  const primary = query.slice(0, i).trim().toLowerCase();
  let qualifier = query.slice(i + 1).trim().toLowerCase();
  if (qualifier.startsWith('near ')) qualifier = qualifier.slice(5).trim();
  return { primary, qualifier: qualifier || null };
}

const ACTIVE_WAYPOINT_ALIASES = new Set(['active waypoint', 'the active waypoint', 'active wp']);

export function findPlaceByName(query) {
  const normalized = (query || '').trim().toLowerCase();
  if (activeWaypoint && ACTIVE_WAYPOINT_ALIASES.has(normalized)) {
    return { lat: activeWaypoint.lat, lon: activeWaypoint.lon, name: activeWaypoint.name };
  }

  const { clean, bearing } = parseDirectional(query);
  const { primary, qualifier } = parseDisambiguated(clean);

  // Resolve qualifier to coords for proximity-based disambiguation
  let qualLat = null, qualLon = null;
  if (qualifier) {
    const qr = findPlaceByName(qualifier);
    if (qr) { qualLat = qr.lat; qualLon = qr.lon; }
  }

  let exact = [], best = null, bestScore = 0;

  const search = (features) => {
    for (const f of (features || [])) {
      const name = f.properties.name_lower || f.properties.name?.toLowerCase() || '';
      const base = similarityScore(primary, name);
      const rank = LABEL_RANK[f.properties.label] ?? 1;
      if (base >= 0.99) {
        exact.push(f);
      } else {
        const score = base + rank * 0.001;
        if (score > bestScore) { bestScore = score; best = f; }
      }
    }
  };

  search(waypoints?.features);
  search(namedPlaces?.features);
  search(navaids?.features);

  let result = null;
  if (exact.length > 0) {
    let chosen;
    if (qualLat !== null && exact.length > 1) {
      chosen = exact.reduce((a, b) => {
        const [alon, alat] = a.geometry.coordinates;
        const [blon, blat] = b.geometry.coordinates;
        const da = (alat - qualLat) ** 2 + (alon - qualLon) ** 2;
        const db = (blat - qualLat) ** 2 + (blon - qualLon) ** 2;
        return da <= db ? a : b;
      });
    } else {
      chosen = exact.reduce((a, b) =>
        (LABEL_RANK[a.properties.label] ?? 1) >= (LABEL_RANK[b.properties.label] ?? 1) ? a : b
      );
    }
    const [lon, lat] = chosen.geometry.coordinates;
    result = { lat, lon, name: chosen.properties.name };
  } else if (best && bestScore >= 0.5) {
    const [lon, lat] = best.geometry.coordinates;
    result = { lat, lon, name: best.properties.name };
  }

  if (result && bearing !== null) {
    const { lat, lon } = offsetCoords(result.lat, result.lon, bearing);
    return { ...result, lat, lon };
  }
  return result;
}

/**
 * Find a navigation landmark by name, prioritizing named lights for position fixes.
 * Searches navaids (lights first), then falls back to findPlaceByName.
 */
// Static navaid features cached for name-based lookups. The server-loaded
// `navaids` uses flash characteristics as names (e.g. "Fl W 6s") rather than
// proper lighthouse names, so we keep a separate cache of the static file.
let _staticNavaidFeatures = null;

async function _ensureStaticNavaids() {
  if (_staticNavaidFeatures) return;
  try {
    const r = await fetch('./data/navaid.geojson');
    if (r.ok) _staticNavaidFeatures = (await r.json()).features;
  } catch (_) {}
}

export async function findLandmarkByName(name) {
  const q = name.toLowerCase().trim();

  await _ensureStaticNavaids();

  // Search static navaid file for proper lighthouse/buoy names
  let best = null, bestScore = 0;
  const features = _staticNavaidFeatures || navaids?.features || [];
  for (const f of features) {
    const fname = (f.properties.name || '').toLowerCase();
    if (!fname) continue;
    const score = similarityScore(q, fname);
    const boosted = f.properties.label === 'light' ? score + 0.01 : score;
    if (boosted > bestScore) { bestScore = boosted; best = f; }
  }

  // High threshold to avoid false matches — caller can fall back to server if null.
  if (best && bestScore >= 0.65) {
    const [lon, lat] = best.geometry.coordinates;
    return { lat, lon, name: best.properties.name };
  }

  // Also try named places (e.g. "Owls Head" from named_places.geojson)
  return findPlaceByName(q);
}

/**
 * Compute a two-bearing position fix (cross-bearing fix).
 * Given two landmarks with their magnetic bearings from the observer,
 * returns the observer's computed position.
 *
 * @param {number} latA - Landmark A latitude
 * @param {number} lonA - Landmark A longitude
 * @param {number} brgA_mag - Magnetic bearing FROM observer TO landmark A
 * @param {number} latB - Landmark B latitude
 * @param {number} lonB - Landmark B longitude
 * @param {number} brgB_mag - Magnetic bearing FROM observer TO landmark B
 * @returns {{lat, lon, crossing, quality}} or throws Error
 */
export function computePositionFix(latA, lonA, brgA_mag, latB, lonB, brgB_mag) {
  // Convert magnetic to true bearings
  const brgA_true = ((brgA_mag + magneticVariation) + 360) % 360;
  const brgB_true = ((brgB_mag + magneticVariation) + 360) % 360;

  // Back-bearings: direction from each landmark toward the observer
  const recipA = (brgA_true + 180) % 360;
  const recipB = (brgB_true + 180) % 360;

  // Flat-earth Cartesian with cosine-latitude longitude correction
  const cosLat = Math.cos(((latA + latB) / 2) * Math.PI / 180);
  const xA = lonA * cosLat, yA = latA;
  const xB = lonB * cosLat, yB = latB;

  // Direction unit vectors (bearing convention: sin=East, cos=North)
  const dxA = Math.sin(recipA * Math.PI / 180), dyA = Math.cos(recipA * Math.PI / 180);
  const dxB = Math.sin(recipB * Math.PI / 180), dyB = Math.cos(recipB * Math.PI / 180);

  // Solve: [xA + t*dxA, yA + t*dyA] = [xB + s*dxB, yB + s*dyB]
  const det = dxA * (-dyB) - (-dxB) * dyA;
  if (Math.abs(det) < 1e-10) {
    throw new Error('Bearing lines are parallel — choose landmarks with more angular separation.');
  }
  const t = ((-dyB) * (xB - xA) + dxB * (yB - yA)) / det;

  const arc = Math.abs(((brgA_mag - brgB_mag + 180 + 360) % 360) - 180);
  const quality = arc >= 60 ? 'Good fix' : arc >= 30 ? 'Fair fix' : 'Poor fix — small crossing angle';

  return {
    lat:      yA + t * dyA,
    lon:      (xA + t * dxA) / cosLat,
    crossing: Math.round(arc),
    quality,
  };
}

/**
 * Server-side place lookup — searches the full chart database.
 * Used as fallback when findPlaceByName can't find the place in loaded data
 * (e.g. place is outside the current 20nm data radius).
 */
export async function findPlaceOnServer(query) {
  if (!_serverBase) return null;
  try {
    const resp = await fetch(
      `${_serverBase}/api/find-place?q=${encodeURIComponent(query)}`,
      { cache: 'no-store', signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return null;
    return await resp.json();  // {lat, lon, name}
  } catch (_) {
    return null;
  }
}

// ── Turf helpers ────────────────────────────────────────────────────────────

function turfPoint(lon, lat) {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} };
}

/** Haversine distance in nautical miles */
export function distanceNm(lon1, lat1, lon2, lat2) {
  const R = 3440.065; // nm
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dphi = (lat2 - lat1) * Math.PI / 180;
  const dlam = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing from (lon1,lat1) to (lon2,lat2), 0–360° */
export function bearing(lon1, lat1, lon2, lat2) {
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dlam = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dlam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlam);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

/** True if point (lon,lat) is within radiusNm nautical miles of (clon,clat) */
function withinRadius(clon, clat, lon, lat, radiusNm) {
  return distanceNm(clon, clat, lon, lat) <= radiusNm;
}

// ── Simple Levenshtein for fuzzy place matching ──────────────────────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarityScore(a, b) {
  if (a === b) return 1.0;
  // Substring containment: score by coverage ratio, not a flat 1.0.
  // "camden" in "cdsoa-cruise-camden-day-7" → 6/26 = 0.23
  // "camden" in "camden harbor"             → 6/13 = 0.46
  // This prevents a short query from matching a long unrelated name.
  if (b.includes(a)) return a.length / b.length;
  if (a.includes(b)) return b.length / a.length;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length, 1);
}

// ── Query functions ──────────────────────────────────────────────────────────

const LANDMARK_LABELS = new Set(['town', 'island', 'coastal feature', 'anchorage']);

function findNearestLandmark(lat, lon) {
  if (!namedPlaces) return null;
  let preferred = null, prefDist = Infinity;
  let fallback  = null, fallDist = Infinity;
  for (const f of namedPlaces.features) {
    const name = f.properties.name;
    if (!name) continue;
    const [flon, flat] = f.geometry.coordinates;
    const d = distanceNm(lon, lat, flon, flat);
    if (LANDMARK_LABELS.has(f.properties.label) && d < prefDist && d < 20) {
      prefDist = d; preferred = { name, dist: d, lat: flat, lon: flon };
    }
    if (d < fallDist && d < 15) {
      fallDist = d; fallback = { name, dist: d, lat: flat, lon: flon };
    }
  }
  return preferred || fallback;
}

/** Exported so app.js can format the server-side nearest-landmark fallback. */
export const compassDir  = compassDirectionWords;
export const naturalDist = naturalDistance;

/** Describe current position relative to nearest landmark. */
export function whereAmI(lat, lon, accuracy) {
  lastBearingResult = null;
  const accText   = accuracy ? `  ±${Math.round(accuracy)} m` : '';
  const accSpeech = accuracy ? `, accuracy ${Math.round(accuracy)} metres` : '';

  const lm = findNearestLandmark(lat, lon);
  if (lm) {
    const brg = ((bearing(lm.lon, lm.lat, lon, lat)) + 360) % 360;
    const dir = compassDirectionWords(brg);
    const dist = naturalDistance(lm.dist);
    return {
      text:   `${dist} ${dir} of ${lm.name}${accText}`,
      speech: `You are ${dist} ${dir} of ${lm.name}${accSpeech}.`,
    };
  }

  const coordText = `${formatDM(lat, true)}, ${formatDM(lon, false)}`;
  return {
    text:   `${coordText}${accText}`,
    speech: `You are at ${coordText}${accSpeech}.`,
  };
}

/** Find nearest hazard to (lat, lon). Returns spoken response string. */
export function nearestHazard(lat, lon) {
  if (!hazards || hazards.features.length === 0) return 'No hazard data loaded.';
  let nearest = null, minDist = Infinity;
  for (const f of hazards.features) {
    const [flon, flat] = f.geometry.coordinates;
    const d = distanceNm(lon, lat, flon, flat);
    if (d < minDist) { minDist = d; nearest = f; }
  }
  if (!nearest) return 'No hazards found.';
  const [flon, flat] = nearest.geometry.coordinates;
  const label = nearest.properties.label || nearest.properties.objtype;
  const name = nearest.properties.name ? `, ${nearest.properties.name}` : '';
  const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
  lastBearingResult = { destLat: flat, destLon: flon, destName: (label + name).trim(), destType: 'hazard', brg, distNm: minDist };
  return {
    text:   `Nearest hazard: ${label}${name}  ${bearingToDisplay(brg)}  ${distanceToDisplay(minDist)}`,
    speech: `Nearest hazard: ${label}${name}, bearing ${bearingToWords(brg)}, ${formatDistance(minDist)}.`,
  };
}


/** Find all hazards within radiusNm. Returns spoken response string. */
export function hazardsInRadius(lat, lon, radiusNm) {
  lastBearingResult = null;
  if (!hazards || hazards.features.length === 0) return 'No hazard data loaded.';
  const nearby = [];
  for (const f of hazards.features) {
    const [flon, flat] = f.geometry.coordinates;
    const d = distanceNm(lon, lat, flon, flat);
    if (d <= radiusNm) nearby.push({ f, d, brg: trueTomagnetic(bearing(lon, lat, flon, flat)) });
  }
  nearby.sort((a, b) => a.d - b.d);

  const radiusDesc = radiusNm === 0.25 ? 'quarter mile' :
                     radiusNm === 0.5  ? 'half mile' :
                     `${radiusNm} nautical miles`;

  if (nearby.length === 0) return `No charted hazards within ${radiusDesc} of your position.`;

  const count = nearby.length;
  const TEXT_MAX = 5, SPEAK_MAX = 2;

  lastHazardResults = nearby.map(({ f, d, brg }) => {
    const [flon, flat] = f.geometry.coordinates;
    return {
      lat:   flat,
      lon:   flon,
      label: f.properties.label || f.properties.objtype,
      name:  f.properties.name || null,
      brg,
      d,
    };
  });

  const textParts = nearby.slice(0, TEXT_MAX).map(({ f, d, brg }) => {
    const label = f.properties.label || f.properties.objtype;
    const name = f.properties.name ? ` ${f.properties.name}` : '';
    return `${label}${name}  ${bearingToDisplay(brg)}  ${distanceToDisplay(d)}`;
  });
  const speechParts = nearby.slice(0, SPEAK_MAX).map(({ f, d, brg }) => {
    const label = f.properties.label || f.properties.objtype;
    const name = f.properties.name ? ` ${f.properties.name}` : '';
    return `${label}${name} bearing ${bearingToWords(brg)}, ${formatDistance(d)}`;
  });

  const textMore   = count > TEXT_MAX  ? ` Plus ${count - TEXT_MAX} more.`  : '';
  const speechMore = count > SPEAK_MAX ? ` Plus ${count - SPEAK_MAX} more.` : '';
  const header = `${count} hazard${count === 1 ? '' : 's'} within ${radiusDesc}`;
  return {
    text:   `${header}:\n${textParts.join('\n')}${textMore}`,
    speech: `${header}: ${speechParts.join('. ')}.${speechMore}`,
  };
}

/** Find bearing and distance to a named place or OpenCPN waypoint. */
export function bearingToPlace(lat, lon, queryName) {
  // Strip directional qualifiers before searching ("west entrance to" etc.)
  const { clean, bearing: dirBearing } = parseDirectional(queryName.toLowerCase().trim());
  const q = clean;

  let best = null, bestScore = 0, bestIsWaypoint = false;

  // Search OpenCPN waypoints first — user-created marks take priority
  if (waypoints && waypoints.features) {
    for (const f of waypoints.features) {
      const name = f.properties.name_lower || '';
      const score = similarityScore(q, name);
      if (score > bestScore) { bestScore = score; best = f; bestIsWaypoint = true; }
    }
  }

  // Search chart-based named places
  if (namedPlaces && namedPlaces.features) {
    for (const f of namedPlaces.features) {
      const name = f.properties.name_lower || '';
      const score = similarityScore(q, name);
      if (score > bestScore) { bestScore = score; best = f; bestIsWaypoint = false; }
    }
  }

  // Search navaids (buoys, lights, beacons) — allows abbreviated names from position fixes
  if (navaids && navaids.features) {
    for (const f of navaids.features) {
      const name = f.properties.name_lower || f.properties.name?.toLowerCase() || '';
      const score = similarityScore(q, name);
      if (score > bestScore) { bestScore = score; best = f; bestIsWaypoint = false; }
    }
  }

  if (!best || bestScore < 0.4) return null;  // signal caller to try server

  let [flon, flat] = best.geometry.coordinates;
  if (dirBearing !== null) {
    const off = offsetCoords(flat, flon, dirBearing);
    flat = off.lat; flon = off.lon;
  }

  return _formatBearingResult(lat, lon, flat, flon, best.properties.name,
                              bestIsWaypoint, bestScore);
}

/** Format a bearing result from a pre-resolved coordinate. */
export function bearingToResolvedPlace(lat, lon, toLat, toLon, toName) {
  return _formatBearingResult(lat, lon, toLat, toLon, toName, false, 1.0);
}

function _formatBearingResult(lat, lon, flat, flon, name, isWaypoint, score) {
  const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
  const dist = distanceNm(lon, lat, flon, flat);
  lastBearingResult = { destLat: flat, destLon: flon, destName: name, destType: isWaypoint ? 'waypoint' : 'place', brg, distNm: dist };
  setFocus(flat, flon, name, isWaypoint ? 'waypoint' : 'place');
  const tag = isWaypoint ? ' (waypoint)' : '';
  const matchNote = score < 0.9 ? `Closest match: ${name}${tag}` : `${name}${tag}`;
  return {
    text:   `${matchNote}  ${bearingToDisplay(brg)}  ${distanceToDisplay(dist)}`,
    speech: `${score < 0.9 ? `Closest match: ${name}${tag}. ` : `${name}${tag}: `}bearing ${bearingToWords(brg)}, ${formatDistance(dist)}.`,
  };
}

/** Compute range and bearing from current position to an explicit coordinate. */
export function bearingToCoord(lat, lon, targetLat, targetLon) {
  const brg = trueTomagnetic(bearing(lon, lat, targetLon, targetLat));
  const dist = distanceNm(lon, lat, targetLon, targetLat);
  lastBearingResult = { destLat: targetLat, destLon: targetLon, destName: null, destType: 'coord', brg, distNm: dist };
  setFocus(targetLat, targetLon, null, 'coord');
  const latDir = targetLat >= 0 ? 'N' : 'S';
  const lonDir = targetLon >= 0 ? 'E' : 'W';
  const latAbs = Math.abs(targetLat);
  const lonAbs = Math.abs(targetLon);
  const latDeg = Math.floor(latAbs);
  const latMin = ((latAbs - latDeg) * 60).toFixed(3);
  const lonDeg = Math.floor(lonAbs);
  const lonMin = ((lonAbs - lonDeg) * 60).toFixed(3);
  const coordLabel = `${latDeg}°${latMin}'${latDir} ${lonDeg}°${lonMin}'${lonDir}`;
  return {
    text:   `${coordLabel}  ${bearingToDisplay(brg)}  ${distanceToDisplay(dist)}`,
    speech: `Bearing to ${coordLabel}: ${bearingToWords(brg)}, ${formatDistance(dist)}.`,
  };
}

// ── Line-of-sight helpers ─────────────────────────────────────────────────────

function _segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1x = bx - ax, d1y = by - ay;
  const d2x = dx - cx, d2y = dy - cy;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return false;
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
  const u = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
}

function _ringBlocks(ring, ax, ay, bx, by) {
  const sx = Math.min(ax, bx), ex = Math.max(ax, bx);
  const sy = Math.min(ay, by), ey = Math.max(ay, by);
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const x1 = ring[i][0], y1 = ring[i][1], x2 = ring[i + 1][0], y2 = ring[i + 1][1];
    // Cheap per-edge bbox reject before the exact intersection test — a large
    // ring (a whole island's coastline can be 1000+ vertices) would otherwise
    // test every edge regardless of how far it is from this segment. Verified
    // ~11x faster on a 1633-vertex ring with identical results.
    if (Math.max(x1, x2) < sx || Math.min(x1, x2) > ex ||
        Math.max(y1, y2) < sy || Math.min(y1, y2) > ey) continue;
    if (_segIntersect(ax, ay, bx, by, x1, y1, x2, y2)) return true;
  }
  return false;
}

// ── Persistent land edge index ────────────────────────────────────────────
// land.geojson covers the whole bundled chart area (Chesapeake Bay to the
// Maine/Canada border — ~800nm, 2386 features, ~80k vertices as of writing)
// as a single static file, and some of its polygons are large connected
// landmasses (a peninsula joined to the mainland by a causeway, say) rather
// than compact islands — one was measured at ~10-11k vertices spanning the
// entire coverage area. A naive per-query scan of every ring (as this file
// did until now) re-walks all of that on every single call; profiling a
// real auto-route search showed 32 SECONDS spent this way before the actual
// pathfinding even started. Build a spatial index ONCE, right after
// land.geojson finishes loading (see loadData below), and have every
// caller (LOS checks, auto-routing) query it instead of rescanning raw
// GeoJSON. This is pure in-memory computation over data already loaded —
// no network access, so it costs nothing offline/underway.
//
// Two structures, built in one pass over every ring's edges:
//   - grid2D:   "col,row" -> edges whose bbox overlaps that cell. Used for
//               segment-intersection queries (landBlocks/findBlockingRing),
//               where locality in both axes is valid and correct.
//   - rowIndex: row -> edges whose y-range overlaps that row. Used for
//               point-in-land ray casting, which needs every edge whose
//               y-range straddles the query latitude (across the full
//               longitude range) to get a correct even-odd crossing count —
//               column locality doesn't apply to that test.
// Per-ring metadata (bbox + centroid) is cached alongside so callers that
// need "which rings are near this corridor" (auto-route node generation)
// don't have to re-walk a whole ring's vertices just to find its extent.
const IDX_CELL = 0.01; // ~0.5nm — matches _prioritiseByChartScale's grid

let _landIndex = null; // { grid2D, rowIndex, ringMeta: Map<ring, meta> }

function _cellOf(v) { return Math.floor(v / IDX_CELL); }
// A numeric key (not a template-string concat) for the 2D grid Map — avoids
// string allocation/hashing on every lookup, which mattered: this grid is
// queried from segBlocked, the single hottest call in auto-routing (600K+
// calls in one real search).
function _cellKey2D(c, r) { return c * 1e7 + r; }

function _buildLandEdgeIndex() {
  const t0 = Date.now();
  const grid2D = new Map();
  const rowIndex = new Map();
  const ringMeta = new Map();
  let edgeCount = 0, ringCount = 0;

  function insert2D(edge) {
    const c0 = _cellOf(edge.minX), c1 = _cellOf(edge.maxX);
    const r0 = _cellOf(edge.minY), r1 = _cellOf(edge.maxY);
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const key = _cellKey2D(c, r);
        let arr = grid2D.get(key);
        if (!arr) { arr = []; grid2D.set(key, arr); }
        arr.push(edge);
      }
    }
  }
  function insertRow(edge) {
    const r0 = _cellOf(edge.minY), r1 = _cellOf(edge.maxY);
    for (let r = r0; r <= r1; r++) {
      let arr = rowIndex.get(r);
      if (!arr) { arr = []; rowIndex.set(r, arr); }
      arr.push(edge);
    }
  }

  function processRing(outer) {
    ringCount++;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let cx = 0, cy = 0;
    for (const [x, y] of outer) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      cx += x; cy += y;
    }
    cx /= outer.length; cy /= outer.length;

    // Convex-vertex flags — computed once here, not per route call. A
    // shortest path around a polygonal obstacle only ever needs to bend at a
    // CONVEX vertex of that obstacle (a headland poking into free space); a
    // concave vertex (a cove) is never a necessary bend point, since the taut
    // string skips over the indentation. This is what auto-routing's node
    // selection uses instead of an arbitrary "closest N to the line" sample
    // (see _addRingNodes in app.js) — smaller and more correct, since it
    // can't exclude a real far-side bend point (e.g. an island's tip) just
    // because it happens to sit far from the direct line.
    // n = outer.length-1: outer's last point duplicates the first (closed
    // ring), so distinct vertices are indices 0..n-1.
    const n = outer.length - 1;
    const convex = new Uint8Array(n);
    if (n >= 3) {
      let signedArea = 0;
      for (let k = 0; k < n; k++) {
        const [x1, y1] = outer[k], [x2, y2] = outer[(k + 1) % n];
        signedArea += x1 * y2 - x2 * y1;
      }
      // Chart data isn't guaranteed consistently wound (CW vs CCW) — compare
      // each vertex's local turn direction against the ring's OWN overall
      // winding rather than assuming one, same reasoning _addRingNodes
      // already applies when it tries both offset-normal signs.
      const areaSign = signedArea >= 0 ? 1 : -1;
      for (let k = 0; k < n; k++) {
        const [vx, vy] = outer[k];
        const [ax, ay] = outer[(k - 1 + n) % n];
        const [bx, by] = outer[(k + 1) % n];
        const cross = (vx - ax) * (by - vy) - (vy - ay) * (bx - vx);
        if (Math.sign(cross) === areaSign) convex[k] = 1;
      }
    }
    ringMeta.set(outer, { minX, maxX, minY, maxY, cx, cy, convex });
    for (let i = 0, n = outer.length - 1; i < n; i++) {
      const x1 = outer[i][0], y1 = outer[i][1], x2 = outer[i + 1][0], y2 = outer[i + 1][1];
      const edge = {
        x1, y1, x2, y2, ring: outer,
        minX: Math.min(x1, x2), maxX: Math.max(x1, x2),
        minY: Math.min(y1, y2), maxY: Math.max(y1, y2),
      };
      insert2D(edge);
      insertRow(edge);
      edgeCount++;
    }
  }

  if (landPolygons) {
    for (const feat of landPolygons.features) {
      const { type, coordinates } = feat.geometry;
      const polys = type === 'Polygon' ? [coordinates] : coordinates;
      for (const rings of polys) processRing(rings[0]);
    }
  }

  console.log(`[AC] land index built in ${Date.now() - t0}ms — ${ringCount} rings, ${edgeCount} edges`);
  return { grid2D, rowIndex, ringMeta };
}

function _gatherCells(map, minX, maxX, minY, maxY, queryId) {
  const c0 = _cellOf(minX), c1 = _cellOf(maxX);
  const r0 = _cellOf(minY), r1 = _cellOf(maxY);
  const out = [];
  for (let c = c0; c <= c1; c++) {
    for (let r = r0; r <= r1; r++) {
      const arr = map.get(_cellKey2D(c, r));
      if (!arr) continue;
      for (const edge of arr) {
        if (edge._q === queryId) continue; // dedupe — an edge can span multiple cells
        edge._q = queryId;
        out.push(edge);
      }
    }
  }
  return out;
}
let _idxQueryId = 0;

/**
 * True if the segment crosses any land ring edge. Index-backed.
 * This is the single hottest call in auto-routing — profiling a real slow
 * search showed it called 600,000+ times in one A* run, at ~100% of the
 * search's wall time. Inlined (no intermediate array from _gatherCells,
 * unlike findBlockingRing/landRingsNear below which run far less often and
 * don't need this) and short-circuits on the first blocking edge, rather
 * than always gathering every candidate edge into an array before checking
 * any of them — same result, no per-call allocation, no wasted work on the
 * common "found a block early" case.
 */
function _landBlocksIndexed(ax, ay, bx, by) {
  if (!_landIndex) return false;
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by), maxY = Math.max(ay, by);
  const c0 = _cellOf(minX), c1 = _cellOf(maxX);
  const r0 = _cellOf(minY), r1 = _cellOf(maxY);
  _idxQueryId++;
  const queryId = _idxQueryId;
  const grid2D = _landIndex.grid2D;
  for (let c = c0; c <= c1; c++) {
    for (let r = r0; r <= r1; r++) {
      const arr = grid2D.get(_cellKey2D(c, r));
      if (!arr) continue;
      for (const edge of arr) {
        if (edge._q === queryId) continue;
        edge._q = queryId;
        if (edge.maxX < minX || edge.minX > maxX || edge.maxY < minY || edge.minY > maxY) continue;
        if (_segIntersect(ax, ay, bx, by, edge.x1, edge.y1, edge.x2, edge.y2)) return true;
      }
    }
  }
  return false;
}

/** The ring (vertex array) of the first land polygon whose boundary crosses the segment, or null. */
function _findBlockingRingIndexed(ax, ay, bx, by) {
  if (!_landIndex) return null;
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by), maxY = Math.max(ay, by);
  _idxQueryId++;
  const edges = _gatherCells(_landIndex.grid2D, minX, maxX, minY, maxY, _idxQueryId);
  for (const edge of edges) {
    if (edge.maxX < minX || edge.minX > maxX || edge.maxY < minY || edge.minY > maxY) continue;
    if (_segIntersect(ax, ay, bx, by, edge.x1, edge.y1, edge.x2, edge.y2)) return edge.ring;
  }
  return null;
}

/** True if (lon,lat) is inside any land ring. Index-backed even-odd ray cast. */
function _isLandAtIndexed(lon, lat) {
  if (!_landIndex) return false;
  const arr = _landIndex.rowIndex.get(_cellOf(lat));
  if (!arr) return false;
  // Group by ring and test each ring's parity independently — combining
  // edges from unrelated rings into one global crossing count is only valid
  // for perfectly disjoint simple polygons, and real chart data has enough
  // edge cases (adjacent-tile seams, near-duplicate boundary segments) to
  // break that assumption. Verified: caused a ~3% false-negative rate in
  // Maine's island-dense coast before switching to per-ring grouping.
  const byRing = new Map();
  for (const edge of arr) {
    let list = byRing.get(edge.ring);
    if (!list) { list = []; byRing.set(edge.ring, list); }
    list.push(edge);
  }
  for (const edges of byRing.values()) {
    let inside = false;
    for (const { x1, y1, x2, y2 } of edges) {
      if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/**
 * Distinct land rings with at least one edge overlapping the given bbox,
 * with cached bbox/centroid — lets a caller (auto-route node generation)
 * find "which rings are near this corridor" without re-walking every ring's
 * full vertex list just to compute its extent.
 */
export function landRingsNear(minLon, maxLon, minLat, maxLat) {
  if (!_landIndex) return [];
  _idxQueryId++;
  const edges = _gatherCells(_landIndex.grid2D, minLon, maxLon, minLat, maxLat, _idxQueryId);
  const seen = new Set();
  const out = [];
  for (const edge of edges) {
    if (seen.has(edge.ring)) continue;
    seen.add(edge.ring);
    const meta = _landIndex.ringMeta.get(edge.ring);
    out.push({ ring: edge.ring, rMinX: meta.minX, rMaxX: meta.maxX, rMinY: meta.minY, rMaxY: meta.maxY, cx: meta.cx, cy: meta.cy, convex: meta.convex });
  }
  return out;
}

export function isLandAt(lon, lat) {
  return _isLandAtIndexed(lon, lat);
}

// A place-name gazetteer entry (e.g. a town or island label) is often
// positioned on the landmass itself, not in the water someone actually means
// when they name it as a destination ("York Harbor" → the harbor, not the
// village on the shore). If a nearby real anchorage/harbor/mooring feature
// exists, that's a better destination than the literal closest wet pixel —
// but the bundled offline data doesn't currently carry that feature class
// anywhere, so this is forward-looking: it activates automatically if/when
// such labels do appear (a richer regional download, a future server dataset).
const WATER_BODY_LABELS = new Set(['harbour', 'harbor', 'marina', 'mooring', 'anchorage', 'cove']);

/**
 * Resolve a point to open water: unchanged if already water, otherwise the
 * nearest confirmed-water spot within maxRadiusNm (preferring a nearby named
 * harbor/anchorage/mooring feature over the literal nearest wet pixel, since
 * that's a more useful destination than "the first patch of water past the
 * seawall"). Returns null if no water is found within maxRadiusNm (genuinely
 * landlocked point, or a gap in the bundled land data).
 */
export function findWaterNear(lon, lat, maxRadiusNm = 2.0) {
  if (!isLandAt(lon, lat)) return { lon, lat, movedNm: 0, viaPlace: null };

  let nearestBody = null, nearestBodyNm = Infinity;
  for (const f of (namedPlaces?.features || [])) {
    const label = (f.properties.label || '').toLowerCase();
    if (!WATER_BODY_LABELS.has(label)) continue;
    const [flon, flat] = f.geometry.coordinates;
    if (isLandAt(flon, flat)) continue;
    const d = distanceNm(lon, lat, flon, flat);
    if (d <= maxRadiusNm && d < nearestBodyNm) { nearestBodyNm = d; nearestBody = f; }
  }
  if (nearestBody) {
    const [flon, flat] = nearestBody.geometry.coordinates;
    return { lon: flon, lat: flat, movedNm: nearestBodyNm, viaPlace: nearestBody.properties.name };
  }

  for (let r = 0.02; r <= maxRadiusNm; r += 0.02) {
    for (let ang = 0; ang < 360; ang += 15) {
      const rad = ang * Math.PI / 180;
      const cv = Math.cos(lat * Math.PI / 180);
      const tx = lon + r / (60 * cv) * Math.cos(rad);
      const ty = lat + r / 60 * Math.sin(rad);
      if (!isLandAt(tx, ty)) return { lon: tx, lat: ty, movedNm: r, viaPlace: null };
    }
  }
  return null;
}

// ── Channel graph (fairway centerlines + recommended tracks) ──────────────
// Built once at load time, same reasoning as _buildLandEdgeIndex: this can be
// consulted on every auto-route call, so it shouldn't be rescanned per call.
// Node identity is coordinate-key rounding (matches the pattern already used
// for offline-sync dedup elsewhere in this file) — edges from independently
// generated sources (a polygon-derived centerline vs. a recommended-track
// LineString) that happen to share an endpoint become the same graph node.
function _channelNodeKey(lon, lat) { return `${lat.toFixed(4)},${lon.toFixed(4)}`; }

function _buildChannelIndex() {
  const nodes = new Map();       // key -> {lon, lat}
  const adjacency = new Map();   // key -> [{key, lon, lat}]
  const grid = new Map();        // cell key (reuses _cellOf/_cellKey2D) -> [key]

  function ensureNode(lon, lat) {
    const key = _channelNodeKey(lon, lat);
    if (!nodes.has(key)) {
      nodes.set(key, { lon, lat });
      const c = _cellKey2D(_cellOf(lon), _cellOf(lat));
      let arr = grid.get(c);
      if (!arr) { arr = []; grid.set(c, arr); }
      arr.push(key);
    }
    return key;
  }
  function connect(keyA, keyB) {
    if (keyA === keyB) return;
    const a = nodes.get(keyA), b = nodes.get(keyB);
    let arrA = adjacency.get(keyA); if (!arrA) { arrA = []; adjacency.set(keyA, arrA); }
    let arrB = adjacency.get(keyB); if (!arrB) { arrB = []; adjacency.set(keyB, arrB); }
    if (!arrA.some(n => n.key === keyB)) arrA.push({ key: keyB, lon: b.lon, lat: b.lat });
    if (!arrB.some(n => n.key === keyA)) arrB.push({ key: keyA, lon: a.lon, lat: a.lat });
  }

  for (const f of (channelGraph || [])) {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    for (let i = 0; i < coords.length - 1; i++) {
      const [alon, alat] = coords[i], [blon, blat] = coords[i + 1];
      const keyA = ensureNode(alon, alat), keyB = ensureNode(blon, blat);
      connect(keyA, keyB);
    }
  }
  console.log(`[AC] Channel graph index built — ${nodes.size} nodes, ${channelGraph?.length ?? 0} edges`);
  return { nodes, adjacency, grid };
}

/** Channel-graph nodes whose grid cell falls in the given bbox — for auto-route node collection. */
export function channelNodesNear(minLon, maxLon, minLat, maxLat) {
  if (!_channelIndex) return [];
  const c0 = _cellOf(minLon), c1 = _cellOf(maxLon);
  const r0 = _cellOf(minLat), r1 = _cellOf(maxLat);
  const out = [];
  for (let c = c0; c <= c1; c++) {
    for (let r = r0; r <= r1; r++) {
      const keys = _channelIndex.grid.get(_cellKey2D(c, r));
      if (!keys) continue;
      for (const key of keys) {
        const n = _channelIndex.nodes.get(key);
        out.push({ lon: n.lon, lat: n.lat, key });
      }
    }
  }
  return out;
}

/** Neighbors of a channel-graph node by its coordinate-derived key, or [] if not a channel node. */
export function channelNeighbors(lon, lat) {
  if (!_channelIndex) return [];
  const key = _channelNodeKey(lon, lat);
  return _channelIndex.adjacency.get(key) || [];
}

function _landBlocks(fromLon, fromLat, toLon, toLat) {
  if (_landIndex) return _landBlocksIndexed(fromLon, fromLat, toLon, toLat);
  if (!landPolygons) return false;
  // Fallback (index not yet built): quick bbox of the segment
  const minX = Math.min(fromLon, toLon), maxX = Math.max(fromLon, toLon);
  const minY = Math.min(fromLat, toLat), maxY = Math.max(fromLat, toLat);
  for (const feat of landPolygons.features) {
    const { type, coordinates } = feat.geometry;
    const polys = type === 'Polygon' ? [coordinates] : coordinates;
    for (const rings of polys) {
      const outer = rings[0];
      // Bbox pre-filter
      let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity;
      for (const [x, y] of outer) {
        if (x < pMinX) pMinX = x; if (x > pMaxX) pMaxX = x;
        if (y < pMinY) pMinY = y; if (y > pMaxY) pMaxY = y;
      }
      if (pMaxX < minX || pMinX > maxX || pMaxY < minY || pMinY > maxY) continue;
      if (_ringBlocks(outer, fromLon, fromLat, toLon, toLat)) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────

/** Find nearest navigation aid, optionally filtered by type. Returns spoken response string. */
export function nearestNavaid(lat, lon, filter, requireLOS = false) {
  if (!navaids || navaids.features.length === 0) return filter ? null : 'No navaid data loaded.';
  let nearest = null, minDist = Infinity;
  for (const f of navaids.features) {
    if (filter && f.properties.label !== filter) continue;
    const [flon, flat] = f.geometry.coordinates;
    const d = distanceNm(lon, lat, flon, flat);
    if (d >= minDist) continue;
    if (requireLOS && _landBlocks(lon, lat, flon, flat)) continue;
    minDist = d; nearest = f;
  }
  if (!nearest) return filter ? null : 'No navaids found.';
  const [flon, flat] = nearest.geometry.coordinates;
  const label = nearest.properties.label || 'navaid';
  const characteristic = nearest.properties.characteristic;
  const nameStr = nearest.properties.name ? `, ${nearest.properties.name}` : '';
  const detail = characteristic ? ` (${characteristic})` : (nearest.properties.colour ? `, ${nearest.properties.colour}` : '');
  const destName = `${label}${nameStr}${detail}`.trim();
  const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
  lastBearingResult = { destLat: flat, destLon: flon, destName: destName, destType: label, brg, distNm: minDist };
  const prefix = requireLOS
    ? (landPolygons ? 'Nearest visible' : 'Nearest (no land data)')
    : 'Nearest';
  return {
    lat:    flat,
    lon:    flon,
    text:   `${prefix} ${label}${nameStr}${detail}  ${bearingToDisplay(brg)}  ${distanceToDisplay(minDist)}`,
    speech: `${prefix} ${label}${nameStr}${detail}, bearing ${bearingToWords(brg)}, ${formatDistance(minDist)}.`,
  };
}

/** Like nearestNavaid but returns an array of up to `count` nearest visible navaids. */
/**
 * Returns the best two-navaid cross-bearing fix within maxDistNm.
 *
 * Scoring: tries every pair of visible navaids and picks the pair whose
 * combined distance is smallest AND whose inter-bearing angle is in the
 * ideal 60–120° range.  If no ideal pair exists, the best pair with
 * angle ≥ 45° is returned.  If even that fails, returns just the nearest
 * single navaid.
 */
export function nearestNavaids(lat, lon, filter, requireLOS = false, count = 2, maxDistNm = Infinity) {
  if (!navaids || navaids.features.length === 0) return [];
  const candidates = [];
  for (const f of navaids.features) {
    if (filter && f.properties.label !== filter) continue;
    const [flon, flat] = f.geometry.coordinates;
    const d = distanceNm(lon, lat, flon, flat);
    if (d > maxDistNm) continue;
    if (requireLOS && _landBlocks(lon, lat, flon, flat)) continue;
    const brg = bearing(lon, lat, flon, flat);
    candidates.push({ f, d, brg, flat, flon });
  }
  candidates.sort((a, b) => a.d - b.d);
  if (candidates.length === 0) return [];
  if (count < 2 || candidates.length < 2) return [candidates[0]];

  function angleDiff(a, b) {
    return Math.abs(((a - b + 180 + 360) % 360) - 180);
  }

  // Find the best pair: angle must be 60–120° (ideal fix geometry).
  // Among qualifying pairs, prefer the one with the smallest combined distance.
  // If no pair qualifies, return only the single nearest navaid so the caller
  // knows a valid two-bearing fix was not achievable within the visibility range.
  let bestA = null, bestB = null, bestDistSum = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const arc = angleDiff(candidates[i].brg, candidates[j].brg);
      if (arc < 60 || arc > 120) continue;          // outside ideal range — skip
      const distSum = candidates[i].d + candidates[j].d;
      if (distSum < bestDistSum) {
        bestA = candidates[i]; bestB = candidates[j]; bestDistSum = distSum;
      }
    }
  }

  const selected = (bestA && bestB) ? [bestA, bestB] : [candidates[0]];

  const prefix = requireLOS
    ? (landPolygons ? 'Nearest visible' : 'Nearest (no land data)')
    : 'Nearest';
  return selected.map(({ f, d, flat, flon }, i) => {
    const label = f.properties.label || 'navaid';
    const characteristic = f.properties.characteristic;
    const nameStr = f.properties.name ? `, ${f.properties.name}` : '';
    const detail = characteristic ? ` (${characteristic})` : (f.properties.colour ? `, ${f.properties.colour}` : '');
    const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
    const rankPrefix = i === 0 ? prefix : 'Also visible';
    return {
      lat:    flat,
      lon:    flon,
      brg,
      distNm: d,
      type:   f.properties.label || 'navaid',
      text:   `${rankPrefix} ${label}${nameStr}${detail}  ${bearingToDisplay(brg)}  ${distanceToDisplay(d)}`,
      speech: `${rankPrefix} ${label}${nameStr}${detail}, bearing ${bearingToWords(brg)}, ${formatDistance(d)}.`,
    };
  });
}

export function landDataInfo() {
  if (!landPolygons) return 'Land data not loaded.';
  return `Land data: ${landPolygons.features.length} polygons loaded.`;
}

// ── Coverage detection ──────────────────────────────────────────────────
// The bundled land.geojson covers a broad stretch of the East Coast, but the
// real safety data — hazards, navaids, named places — is scoped to whatever
// smaller region is actually loaded. That region isn't a fixed rectangle:
// in server-bridge mode (loadData(lat,lon) hitting /api/nearby), it's
// whatever the server returned for a "near this position" query, which can
// be an irregular, sparse cluster of features rather than anything a bbox
// around it would faithfully represent — verified live: a "nearby" fetch's
// own bounding box did not reliably contain the query point that produced
// it (empty space in one direction skews the box off-center). So 'core' is
// a PROXIMITY check (is there real data within CORE_PROXIMITY_NM of here),
// which is correct for both a full static regional bundle and a narrow
// server "nearby" result. 'land' still uses a bbox, since land.geojson is
// a stable, static, full-region file where that's accurate and land data
// is dense enough that a hard boundary doesn't need a fuzzy margin.
const CORE_PROXIMITY_NM = 8;

function _firstCoord(geom) {
  if (!geom) return null;
  let c = geom.coordinates;
  while (Array.isArray(c) && typeof c[0] !== 'number') c = c[0];
  return Array.isArray(c) && typeof c[0] === 'number' ? c : null;
}

function _hasNearbyFeature(fc, lon, lat, maxNm) {
  if (!fc || !fc.features) return false;
  for (const f of fc.features) {
    const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : _firstCoord(f.geometry);
    if (!c) continue;
    if (distanceNm(lon, lat, c[0], c[1]) <= maxNm) return true;
  }
  return false;
}

const _coverageCache = { landRef: null, landBbox: null };

function _bboxOfFeatureCollection(fc) {
  if (!fc || !fc.features) return null;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const walk = c => {
    if (typeof c[0] === 'number') {
      const [x, y] = c;
      if (x < minLon) minLon = x; if (x > maxLon) maxLon = x;
      if (y < minLat) minLat = y; if (y > maxLat) maxLat = y;
    } else {
      for (const sub of c) walk(sub);
    }
  };
  for (const f of fc.features) { if (f.geometry) walk(f.geometry.coordinates); }
  return minLon === Infinity ? null : { minLon, maxLon, minLat, maxLat };
}

/** { land: bbox|null } — bbox = {minLon,maxLon,minLat,maxLat}. */
export function getCoverageBounds() {
  if (_coverageCache.landRef !== landPolygons) {
    _coverageCache.landBbox = _bboxOfFeatureCollection(landPolygons);
    _coverageCache.landRef = landPolygons;
  }
  return { land: _coverageCache.landBbox };
}

/**
 * 'core'  — real hazard/navaid/place data within CORE_PROXIMITY_NM (safe for auto-routing).
 * 'land'  — land-avoidance geometry only, no hazard/navaid detail.
 * 'none'  — no chart data of any kind for this position.
 */
export function coverageLevelAt(lon, lat) {
  if (_hasNearbyFeature(hazards, lon, lat, CORE_PROXIMITY_NM) ||
      _hasNearbyFeature(namedPlaces, lon, lat, CORE_PROXIMITY_NM) ||
      _hasNearbyFeature(navaids, lon, lat, CORE_PROXIMITY_NM)) return 'core';
  const { land } = getCoverageBounds();
  if (land && lon >= land.minLon && lon <= land.maxLon && lat >= land.minLat && lat <= land.maxLat) return 'land';
  return 'none';
}

export function landBlocks(fromLon, fromLat, toLon, toLat) {
  return _landBlocks(fromLon, fromLat, toLon, toLat);
}

export function getLandPolygons() {
  return landPolygons;
}

export function whenLandLoaded() {
  return _landLoadPromise || Promise.resolve();
}

export function ringBlocks(ring, ax, ay, bx, by) {
  return _ringBlocks(ring, ax, ay, bx, by);
}

export function getDepthZones() {
  return depthZones;
}

export function findBlockingRing(fromLon, fromLat, toLon, toLat) {
  if (_landIndex) return _findBlockingRingIndexed(fromLon, fromLat, toLon, toLat);
  if (!landPolygons) return null;
  // Fallback (index not yet built)
  const minX = Math.min(fromLon, toLon), maxX = Math.max(fromLon, toLon);
  const minY = Math.min(fromLat, toLat), maxY = Math.max(fromLat, toLat);
  for (const feat of landPolygons.features) {
    const { type, coordinates } = feat.geometry;
    const polys = type === 'Polygon' ? [coordinates] : coordinates;
    for (const rings of polys) {
      const outer = rings[0];
      let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity;
      for (const [x, y] of outer) {
        if (x < pMinX) pMinX = x; if (x > pMaxX) pMaxX = x;
        if (y < pMinY) pMinY = y; if (y > pMaxY) pMaxY = y;
      }
      if (pMaxX < minX || pMinX > maxX || pMaxY < minY || pMinY > maxY) continue;
      if (_ringBlocks(outer, fromLon, fromLat, toLon, toLat)) return outer;
    }
  }
  return null;
}

/** Check whether all data needed for offline use is cached. */
export async function offlineReadiness() {
  async function swCached(path) {
    try {
      if (typeof caches === 'undefined') return false;
      const url = new URL(path, location.href).href;
      return !!(await caches.match(url));
    } catch { return false; }
  }

  const lines = [];
  let critical = true;

  // Land data (line-of-sight)
  if (await swCached('./data/land.geojson')) {
    const n = landPolygons ? ` (${landPolygons.features.length} polygons)` : '';
    lines.push(`Land data${n}: ready`);
  } else {
    lines.push('Land data: NOT cached — line-of-sight checks will fail');
    critical = false;
  }

  // Navaid data — IDB preferred, static file fallback
  const idbNavaids = await idbGet('navaids').catch(() => null);
  const idbVersion = await idbGet('data-version').catch(() => null);
  if (idbNavaids?.features?.length) {
    const ver = idbVersion ? ` (${idbVersion})` : '';
    lines.push(`Navaids: ${idbNavaids.features.length} features in offline store${ver}`);
  } else if (await swCached('./data/navaid.geojson')) {
    lines.push('Navaids: static file cached');
  } else {
    lines.push('Navaid data: NOT cached');
    critical = false;
  }

  // Hazard data
  const idbHazards = await idbGet('hazards').catch(() => null);
  if (idbHazards?.features?.length) {
    lines.push(`Hazards: ${idbHazards.features.length} features in offline store`);
  } else if (await swCached('./data/hazards.geojson')) {
    lines.push('Hazards: static file cached');
  } else {
    lines.push('Hazard data: NOT cached');
  }

  // Named places (bearing-to-place queries)
  const idbPlaces = await idbGet('named_places').catch(() => null);
  if (idbPlaces?.features?.length) {
    lines.push(`Named places: ${idbPlaces.features.length} in offline store`);
  } else if (await swCached('./data/named_places.geojson')) {
    lines.push('Named places: static file cached');
  } else {
    lines.push('Named places: NOT cached');
  }

  const verdict = critical
    ? 'All critical data is cached. Ready for offline use.'
    : 'Critical data is missing. Open the app with a connection before departing.';

  const text   = lines.join('\n') + '\n' + verdict;
  const speech = lines.join('. ') + '. ' + verdict;
  return { text, speech };
}

/** Find all navaids of a given type within radiusNm. filter: 'buoy'|'light'|'beacon'|null */
export function navaidsInRadius(lat, lon, radiusNm, filter) {
  if (!navaids || navaids.features.length === 0) return 'No navaid data loaded.';

  const nearby = [];
  for (const f of navaids.features) {
    const [flon, flat] = f.geometry.coordinates;
    if (filter && f.properties.label !== filter) continue;
    const d = distanceNm(lon, lat, flon, flat);
    if (d <= radiusNm) nearby.push({ f, d, brg: trueTomagnetic(bearing(lon, lat, flon, flat)) });
  }
  nearby.sort((a, b) => a.d - b.d);

  const radiusDesc = radiusNm === 0.25 ? 'quarter mile' :
                     radiusNm === 0.5  ? 'half mile' :
                     `${radiusNm} nautical miles`;
  const typeDesc = filter ? `${filter}s` : 'navaids';

  if (nearby.length === 0) return `No ${typeDesc} within ${radiusDesc} of your position.`;

  const SPEAK_MAX = 2;
  const count = nearby.length;

  const speechParts = nearby.slice(0, SPEAK_MAX).map(({ f, d, brg }) => {
    const label = f.properties.label || 'navaid';
    const name  = f.properties.name ? ` ${f.properties.name}` : '';
    const detail = f.properties.characteristic ? `, ${f.properties.characteristic}` : f.properties.colour ? `, ${f.properties.colour}` : '';
    return `${label}${name}${detail}, bearing ${bearingToWords(brg)}, ${formatDistance(d)}`;
  });

  const speechMore = count > SPEAK_MAX ? ` Plus ${count - SPEAK_MAX} more.` : '';
  const header = `${count} ${typeDesc} within ${radiusDesc}`;

  lastNavaidResults = nearby.map(({ f, d, brg }) => {
    const [flon, flat] = f.geometry.coordinates;
    return {
      lat:            flat,
      lon:            flon,
      label:          f.properties.label || 'navaid',
      name:           f.properties.name || null,
      colour:         f.properties.colour || null,
      characteristic: f.properties.characteristic || null,
      brg,
      d,
    };
  });

  return {
    text:   header,
    speech: `${header}: ${speechParts.join('. ')}.${speechMore}`,
  };
}

/** Find nearest restricted area. */
export function nearestRestriction(lat, lon) {
  if (!restrictions || restrictions.features.length === 0) return 'No restriction data loaded.';
  let nearest = null, minDist = Infinity;
  for (const f of restrictions.features) {
    const [flon, flat] = f.geometry.coordinates;
    const d = distanceNm(lon, lat, flon, flat);
    if (d < minDist) { minDist = d; nearest = f; }
  }
  if (!nearest) return 'No restricted areas found.';
  const [flon, flat] = nearest.geometry.coordinates;
  const label = nearest.properties.label || 'restricted area';
  const name = nearest.properties.name ? `: ${nearest.properties.name}` : '';
  const inform = nearest.properties.inform ? `  "${nearest.properties.inform}"` : '';
  const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
  lastBearingResult = { destLat: flat, destLon: flon, destName: (label + name).trim(), destType: 'restriction', brg, distNm: minDist };
  return {
    text:   `Nearest restriction — ${label}${name}  ${bearingToDisplay(brg)}  ${distanceToDisplay(minDist)}${inform}`,
    speech: `Nearest restricted area: ${label}${name}, bearing ${bearingToWords(brg)}, ${formatDistance(minDist)}.`,
  };
}

/**
 * Signed cross-track distance from point P to line A→B.
 * Returns {crossTrack (nm, +ve = starboard), alongTrack (nm from A)} or null if degenerate.
 */
function crossTrackDist(aLon, aLat, bLon, bLat, pLon, pLat) {
  const R = 3440.065;
  const d13 = distanceNm(aLon, aLat, pLon, pLat) / R;
  if (d13 < 1e-9) return { crossTrack: 0, alongTrack: 0 };
  const b13 = bearing(aLon, aLat, pLon, pLat) * Math.PI / 180;
  const b12 = bearing(aLon, aLat, bLon, bLat) * Math.PI / 180;
  const dxt = Math.asin(Math.sin(d13) * Math.sin(b13 - b12)) * R;
  const cosDxt = Math.cos(dxt / R);
  if (Math.abs(cosDxt) < 1e-10) return null;
  const dat = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / cosDxt))) * R;
  return { crossTrack: dxt, alongTrack: Math.cos(b13 - b12) >= 0 ? dat : -dat };
}

/**
 * Format a course-hazards result (from server API or local search) and update lastCourseHazards.
 * hazards = [{label, name, along_track_nm, cross_track_nm, side, lat, lon}, ...]
 * Already sorted by along_track_nm ascending.
 */
export function formatCourseHazards(hazardsArr, courseLengthNm, corridorNm = 0.25) {
  const count = hazardsArr.length;
  const courseLen = distanceToDisplay(courseLengthNm);
  const header = `${count} hazard${count === 1 ? '' : 's'} on ${courseLen} course`;

  lastCourseHazards = hazardsArr.map(r => ({
    lat: r.lat, lon: r.lon, label: r.label, name: r.name ? `, ${r.name}` : '',
  }));

  if (count === 0) {
    return {
      text:   `No charted hazards within ${corridorNm} nm of that course (${courseLen})`,
      speech: `No charted hazards within ${corridorNm} nautical miles of that course.`,
    };
  }

  const textParts = hazardsArr.slice(0, 8).map(r => {
    const n = r.name ? `, ${r.name}` : '';
    return `${r.label}${n}  ${distanceToDisplay(r.along_track_nm)} along  ${distanceToDisplay(r.cross_track_nm)} ${r.side}`;
  });
  const SPEAK_MAX = 2;
  const speechParts = hazardsArr.slice(0, SPEAK_MAX).map(r => {
    const n = r.name ? `, ${r.name}` : '';
    return `${r.label}${n}, ${formatDistance(r.along_track_nm)} along, ${formatDistance(r.cross_track_nm)} to ${r.side}`;
  });
  const textMore   = count > 8        ? `\nPlus ${count - 8} more.`        : '';
  const speechMore = count > SPEAK_MAX ? ` Plus ${count - SPEAK_MAX} more.` : '';

  return {
    text:   `${header}:\n${textParts.join('\n')}${textMore}`,
    speech: `${count} hazard${count === 1 ? '' : 's'} on course: ${speechParts.join('. ')}.${speechMore}`,
  };
}

/**
 * Find all navaids whose bearing from (lat, lon) falls within bearingDeg ± toleranceDeg.
 * filters: array of label strings (['buoy','light']), or null for all types.
 * radiusNm: maximum range to consider (default 20nm matches the data load radius).
 */
export function navaidsOnBearing(lat, lon, bearingDeg, toleranceDeg, filters, radiusNm = 20) {
  if (!navaids || navaids.features.length === 0) return 'No navaid data loaded.';

  const targetBrg = ((bearingDeg % 360) + 360) % 360;

  const nearby = [];
  for (const f of navaids.features) {
    const [flon, flat] = f.geometry.coordinates;
    if (filters && filters.length > 0 && !filters.includes(f.properties.label)) continue;
    const d = distanceNm(lon, lat, flon, flat);
    if (d > radiusNm) continue;
    const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
    const diff = Math.abs(((brg - targetBrg + 540) % 360) - 180);
    if (diff <= toleranceDeg) nearby.push({ f, d, brg });
  }
  nearby.sort((a, b) => a.d - b.d);

  const typeDesc = !filters || filters.length === 0 ? 'navaids'
    : filters.length === 1 ? `${filters[0]}s`
    : filters.map(t => `${t}s`).join(' and ');
  const brgDisplay = `${targetBrg.toFixed(0)}°`;
  const tolDisplay = `±${toleranceDeg}°`;

  if (nearby.length === 0) {
    return {
      text:   `No ${typeDesc} at bearing ${brgDisplay} ${tolDisplay}`,
      speech: `No ${typeDesc} found at bearing ${targetBrg} degrees, plus or minus ${toleranceDeg} degrees.`,
    };
  }

  const count = nearby.length;
  const SPEAK_MAX = 3;

  lastNavaidResults = nearby.map(({ f, d, brg }) => {
    const [flon, flat] = f.geometry.coordinates;
    return { lat: flat, lon: flon, label: f.properties.label || 'navaid',
             name: f.properties.name || null, colour: f.properties.colour || null,
             characteristic: f.properties.characteristic || null, brg, d };
  });

  const speechParts = nearby.slice(0, SPEAK_MAX).map(({ f, d, brg }) => {
    const label = f.properties.label || 'navaid';
    const name  = f.properties.name ? ` ${f.properties.name}` : '';
    const detail = f.properties.characteristic ? `, ${f.properties.characteristic}` : f.properties.colour ? `, ${f.properties.colour}` : '';
    return `${label}${name}${detail}, bearing ${bearingToWords(brg)}`;
  });

  const speechMore = count > SPEAK_MAX ? ` Plus ${count - SPEAK_MAX} more.` : '';
  const header = `${count} ${typeDesc} at bearing ${brgDisplay} ${tolDisplay}`;

  return {
    text:   header,
    speech: `${header}: ${speechParts.join('. ')}.${speechMore}`,
  };
}

/** Find all charted hazards within corridorNm of the course from A to B (local in-memory data). */
export function hazardsOnCourse(fromLat, fromLon, toLat, toLon, corridorNm = 0.25) {
  lastBearingResult = null;
  lastCourseHazards = null;
  if (!hazards || hazards.features.length === 0) return 'No hazard data loaded.';

  const dAB = distanceNm(fromLon, fromLat, toLon, toLat);
  if (dAB < 0.01) return 'Start and end are the same point.';

  const PRIORITY = { 'underwater rock': 2, 'obstruction': 2, 'wreck': 2, 'shallow area': 1 };

  const results = [];
  for (const f of hazards.features) {
    const label = f.properties.label || f.properties.objtype || 'hazard';
    if ((PRIORITY[label] ?? 2) === 1 && !f.properties.name) continue;

    const [pLon, pLat] = f.geometry.coordinates;
    const ct = crossTrackDist(fromLon, fromLat, toLon, toLat, pLon, pLat);
    if (!ct) continue;
    const { crossTrack, alongTrack } = ct;
    if (Math.abs(crossTrack) <= corridorNm && alongTrack >= 0 && alongTrack <= dAB) {
      results.push({
        lat: pLat, lon: pLon, label,
        name: f.properties.name || '',
        along_track_nm: alongTrack,
        cross_track_nm: Math.abs(crossTrack),
        side: crossTrack <= 0 ? 'port' : 'starboard',
      });
    }
  }
  results.sort((a, b) => a.along_track_nm - b.along_track_nm);

  return formatCourseHazards(results, dAB, corridorNm);
}

/**
 * Return the nearest depth sounding to the given position, within radiusNm.
 * Returns {valsou, lat, lon, distNm} or null.
 */
export function nearestSounding(lat, lon, radiusNm = 0.15) {
  if (!soundings?.features?.length) return null;
  let best = null, bestDist = Infinity;
  for (const f of soundings.features) {
    const [flon, flat] = f.geometry.coordinates;
    const d = distanceNm(lon, lat, flon, flat);
    if (d < radiusNm && d < bestDist) {
      bestDist = d;
      best = { valsou: f.properties.valsou, lat: flat, lon: flon, distNm: d };
    }
  }
  return best;
}
