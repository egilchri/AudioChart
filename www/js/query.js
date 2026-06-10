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
export let depthZones = null;  // 'shallow area' Polygon features — always real geometry
export let channels   = null;  // FAIRWY polygon features from ENC data
export let soundings  = null;  // SOUNDG depth sounding points (thinned, ≤30m)
export let lastBearingResult = null;   // set by bearing queries; read by map view
export let lastCourseHazards = null;   // set by hazardsOnCourse; [{lat,lon,label,name}]
export let lastNavaidResults  = null;   // set by navaidsInRadius; [{lat,lon,label,name,colour,characteristic,brg,d}]
export let lastHazardResults = null;   // set by hazardsInRadius;  [{lat,lon,label,name,brg,d}]

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

export async function loadData(lat, lon) {
  // Land polygons and depth zones are position-independent — load once regardless of mode.
  // Depth zones always come from the bundled hazards.geojson so we get real polygon
  // geometry even when the server API only returns centroid points.
  if (!landPolygons) {
    fetch('./data/land.geojson')
      .then(r => r.ok ? r.json() : null)
      .then(land => {
        if (land) landPolygons = land;
        console.log(`[AC] Land polygons: ${landPolygons ? landPolygons.features.length : 'FAILED TO LOAD'}`);
      })
      .catch(() => console.warn('[AC] land.geojson failed to load'));
  }
  if (!depthZones) {
    fetch('./data/hazards.geojson')
      .then(r => r.ok ? r.json() : null)
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
    fetch('./data/channels.geojson')
      .then(r => r.ok ? r.json() : null)
      .then(fc => {
        if (fc) channels = fc.features.filter(f => f.geometry?.type !== 'Point');
        console.log(`[AC] Channels: ${channels ? channels.length : 'not found'}`);
      })
      .catch(() => {});  // optional file — no warning if absent
  }
  if (!soundings) {
    fetch('./data/soundings.geojson')
      .then(r => r.ok ? r.json() : null)
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
  // Record the current data version so the freshness check passes after download
  try {
    const vr = await fetch('./data/data-version.json');
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

export function findPlaceByName(query) {
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
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    if (_segIntersect(ax, ay, bx, by, ring[i][0], ring[i][1], ring[i+1][0], ring[i+1][1])) return true;
  }
  return false;
}

function _landBlocks(fromLon, fromLat, toLon, toLat) {
  if (!landPolygons) return false;
  // Quick bbox of the segment
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
  return { crossTrack: dxt, alongTrack: dat };
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
