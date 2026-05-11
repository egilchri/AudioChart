/**
 * Spatial query engine using Turf.js.
 * Loads GeoJSON data once at startup, keeps in memory.
 */

import { bearingToWords, bearingToDisplay, formatDistance, distanceToDisplay, formatDM, trueTomagnetic, setMagneticVariation, compassDirectionWords, naturalDistance } from './utils.js';

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
export let waypoints = null;   // OpenCPN user waypoints
export let lastBearingResult = null;  // set by bearing queries; read by map view

let _serverBase = null;
let _lastFetchLat = null;
let _lastFetchLon = null;
let _waypointPollTimer = null;
const REFETCH_DISTANCE_NM = 3.0;
const WAYPOINT_POLL_MS = 30_000;  // re-check OpenCPN waypoints every 30s

export function setServerBase(url) {
  _serverBase = url;
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
export async function loadData(lat, lon) {
  // Try server API first
  if (_serverBase && lat != null && lon != null) {
    try {
      const url = `${_serverBase}/api/nearby?lat=${lat}&lon=${lon}`;
      const resp = await fetch(url, { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        hazards = data.hazards;
        namedPlaces = data.places;
        navaids = data.navaids;
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
  const [idbH, idbP, idbN, idbW] = await Promise.all([
    idbGet('hazards').catch(() => null),
    idbGet('named_places').catch(() => null),
    idbGet('navaids').catch(() => null),
    idbGet('waypoints').catch(() => null),
  ]);

  if (idbH) {
    hazards = idbH;
    namedPlaces = idbP;
    navaids = idbN;
    waypoints = idbW;
    console.log('[query] Loaded offline data from IndexedDB');
  } else {
    const [h, p, n] = await Promise.all([
      fetch('./data/hazards.geojson').then(r => r.json()),
      fetch('./data/named_places.geojson').then(r => r.json()),
      fetch('./data/navaid.geojson').then(r => r.json()),
    ]);
    hazards = h;
    namedPlaces = p;
    navaids = n;
    console.log('[query] Loaded offline data from static files');
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
  ];
  for (const [idbKey, newFeatures] of pairs) {
    const existing = await idbGet(idbKey).catch(() => null);
    const existingFeatures = existing?.features || [];
    const seen = new Set(existingFeatures.map(key));
    const added = newFeatures.filter(f => !seen.has(key(f)));
    await idbPut(idbKey, { type: 'FeatureCollection', features: [...existingFeatures, ...added] });
  }
  const stored = await Promise.all(pairs.map(([k]) => idbGet(k).then(fc => (fc?.features || []).length)));
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
// When multiple features share the same name, prefer specific place types over
// generic sea areas so "Southwest Harbor (town)" beats "Southwest Harbor (sea area)".
const LABEL_RANK = { town: 3, harbour: 3, 'coastal feature': 2, 'sea area': 0 };

function parseDisambiguated(query) {
  const i = query.indexOf(',');
  if (i === -1) return { primary: query.trim().toLowerCase(), qualifier: null };
  const primary = query.slice(0, i).trim().toLowerCase();
  let qualifier = query.slice(i + 1).trim().toLowerCase();
  if (qualifier.startsWith('near ')) qualifier = qualifier.slice(5).trim();
  return { primary, qualifier: qualifier || null };
}

export function findPlaceByName(query) {
  const { primary, qualifier } = parseDisambiguated(query);

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

  if (exact.length > 0) {
    let chosen;
    if (qualLat !== null && exact.length > 1) {
      // Pick the exact match closest to the qualifier location
      chosen = exact.reduce((a, b) => {
        const [alon, alat] = a.geometry.coordinates;
        const [blon, blat] = b.geometry.coordinates;
        const da = (alat - qualLat) ** 2 + (alon - qualLon) ** 2;
        const db = (blat - qualLat) ** 2 + (blon - qualLon) ** 2;
        return da <= db ? a : b;
      });
    } else {
      // No qualifier — prefer by label rank
      chosen = exact.reduce((a, b) =>
        (LABEL_RANK[a.properties.label] ?? 1) >= (LABEL_RANK[b.properties.label] ?? 1) ? a : b
      );
    }
    const [lon, lat] = chosen.geometry.coordinates;
    return { lat, lon, name: chosen.properties.name };
  }

  if (!best || bestScore < 0.5) return null;
  const [lon, lat] = best.geometry.coordinates;
  return { lat, lon, name: best.properties.name };
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
function distanceNm(lon1, lat1, lon2, lat2) {
  const R = 3440.065; // nm
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dphi = (lat2 - lat1) * Math.PI / 180;
  const dlam = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing from (lon1,lat1) to (lon2,lat2), 0–360° */
function bearing(lon1, lat1, lon2, lat2) {
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
  lastBearingResult = { destLat: flat, destLon: flon, destName: (label + name).trim() };
  const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
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
  const textParts = nearby.slice(0, 5).map(({ f, d, brg }) => {
    const label = f.properties.label || f.properties.objtype;
    const name = f.properties.name ? ` ${f.properties.name}` : '';
    return `${label}${name}  ${bearingToDisplay(brg)}  ${distanceToDisplay(d)}`;
  });
  const speechParts = nearby.slice(0, 5).map(({ f, d, brg }) => {
    const label = f.properties.label || f.properties.objtype;
    const name = f.properties.name ? ` ${f.properties.name}` : '';
    return `${label}${name} bearing ${bearingToWords(brg)}, ${formatDistance(d)}`;
  });

  const more = count > 5 ? ` Plus ${count - 5} more.` : '';
  const header = `${count} hazard${count === 1 ? '' : 's'} within ${radiusDesc}`;
  return {
    text:   `${header}:\n${textParts.join('\n')}${more}`,
    speech: `${header}: ${speechParts.join('. ')}.${more}`,
  };
}

/** Find bearing and distance to a named place or OpenCPN waypoint. */
export function bearingToPlace(lat, lon, queryName) {
  const q = queryName.toLowerCase().trim();
  let best = null, bestScore = 0, bestIsWaypoint = false;

  // Search OpenCPN waypoints first — user-created marks take priority
  if (waypoints && waypoints.features) {
    for (const f of waypoints.features) {
      const name = f.properties.name_lower || '';
      const score = similarityScore(q, name);
      if (score > bestScore) { bestScore = score; best = f; bestIsWaypoint = true; }
    }
  }

  // Search chart-based named places (only if no waypoint scored higher)
  if (namedPlaces && namedPlaces.features) {
    for (const f of namedPlaces.features) {
      const name = f.properties.name_lower || '';
      const score = similarityScore(q, name);
      if (score > bestScore) { bestScore = score; best = f; bestIsWaypoint = false; }
    }
  }

  if (!best || bestScore < 0.4) {
    return `I couldn't find a place called "${queryName}". Try a different name.`;
  }

  const [flon, flat] = best.geometry.coordinates;
  lastBearingResult = { destLat: flat, destLon: flon, destName: best.properties.name };
  const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
  const dist = distanceNm(lon, lat, flon, flat);
  const name = best.properties.name;
  const tag = bestIsWaypoint ? ' (waypoint)' : '';
  const matchNote = bestScore < 0.9 ? `Closest match: ${name}${tag}` : `${name}${tag}`;
  return {
    text:   `${matchNote}  ${bearingToDisplay(brg)}  ${distanceToDisplay(dist)}`,
    speech: `${bestScore < 0.9 ? `Closest match: ${name}${tag}. ` : `${name}${tag}: `}bearing ${bearingToWords(brg)}, ${formatDistance(dist)}.`,
  };
}

/** Compute range and bearing from current position to an explicit coordinate. */
export function bearingToCoord(lat, lon, targetLat, targetLon) {
  lastBearingResult = { destLat: targetLat, destLon: targetLon, destName: null };
  const brg = trueTomagnetic(bearing(lon, lat, targetLon, targetLat));
  const dist = distanceNm(lon, lat, targetLon, targetLat);
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

/** Find nearest navigation aid. Returns spoken response string. */
export function nearestNavaid(lat, lon) {
  if (!navaids || navaids.features.length === 0) return 'No navaid data loaded.';
  let nearest = null, minDist = Infinity;
  for (const f of navaids.features) {
    const [flon, flat] = f.geometry.coordinates;
    const d = distanceNm(lon, lat, flon, flat);
    if (d < minDist) { minDist = d; nearest = f; }
  }
  if (!nearest) return 'No navaids found.';
  const [flon, flat] = nearest.geometry.coordinates;
  const label = nearest.properties.label || 'navaid';
  const name = nearest.properties.name ? `, ${nearest.properties.name}` : '';
  lastBearingResult = { destLat: flat, destLon: flon, destName: (label + name).trim() };
  const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
  const colour = nearest.properties.colour ? `, ${nearest.properties.colour}` : '';
  return {
    text:   `Nearest ${label}${name}${colour}  ${bearingToDisplay(brg)}  ${distanceToDisplay(minDist)}`,
    speech: `Nearest ${label}${name}${colour}, bearing ${bearingToWords(brg)}, ${formatDistance(minDist)}.`,
  };
}
