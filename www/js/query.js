/**
 * Spatial query engine using Turf.js.
 * Loads GeoJSON data once at startup, keeps in memory.
 */

import { bearingToWords, formatDistance, formatDM, trueTomagnetic, setMagneticVariation } from './utils.js';

// Loaded per-position; exported for tests
export let hazards = null;
export let namedPlaces = null;
export let navaids = null;
export let waypoints = null;   // OpenCPN user waypoints

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

  // Offline fallback: static pre-generated files
  const [h, p, n] = await Promise.all([
    fetch('./data/hazards.geojson').then(r => r.json()),
    fetch('./data/named_places.geojson').then(r => r.json()),
    fetch('./data/navaid.geojson').then(r => r.json()),
  ]);
  hazards = h;
  namedPlaces = p;
  navaids = n;
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
  if (b.includes(a) || a.includes(b)) return 1.0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length, 1);
}

// ── Query functions ──────────────────────────────────────────────────────────

/** Speak current position. */
export function whereAmI(lat, lon, accuracy) {
  const acc = accuracy ? `, accuracy ${Math.round(accuracy)} metres` : '';
  return `You are at ${formatDM(lat, true)}, ${formatDM(lon, false)}${acc}.`;
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
  const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
  const label = nearest.properties.label || nearest.properties.objtype;
  const name = nearest.properties.name ? `, ${nearest.properties.name}` : '';
  return `Nearest hazard: ${label}${name}, bearing ${bearingToWords(brg)}, ${formatDistance(minDist)}.`;
}

/** Find all hazards within radiusNm. Returns spoken response string. */
export function hazardsInRadius(lat, lon, radiusNm) {
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
  const parts = nearby.slice(0, 5).map(({ f, d, brg }) => {
    const label = f.properties.label || f.properties.objtype;
    const name = f.properties.name ? ` ${f.properties.name}` : '';
    return `${label}${name} bearing ${bearingToWords(brg)}, ${formatDistance(d)}`;
  });

  const more = count > 5 ? ` Plus ${count - 5} more.` : '';
  return `${count} hazard${count === 1 ? '' : 's'} within ${radiusDesc}: ${parts.join('. ')}.${more}`;
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
  const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
  const dist = distanceNm(lon, lat, flon, flat);
  const name = best.properties.name;
  const tag = bestIsWaypoint ? ' (waypoint)' : '';
  const prefix = bestScore < 0.9 ? `Closest match: ${name}${tag}. ` : `${name}${tag}: `;
  return `${prefix}bearing ${bearingToWords(brg)}, ${formatDistance(dist)}.`;
}

/** Compute range and bearing from current position to an explicit coordinate. */
export function bearingToCoord(lat, lon, targetLat, targetLon) {
  const brg = trueTomagnetic(bearing(lon, lat, targetLon, targetLat));
  const dist = distanceNm(lon, lat, targetLon, targetLat);
  // Format the target coordinate compactly for the response
  const latDir = targetLat >= 0 ? 'N' : 'S';
  const lonDir = targetLon >= 0 ? 'E' : 'W';
  const latAbs = Math.abs(targetLat);
  const lonAbs = Math.abs(targetLon);
  const latDeg = Math.floor(latAbs);
  const latMin = ((latAbs - latDeg) * 60).toFixed(3);
  const lonDeg = Math.floor(lonAbs);
  const lonMin = ((lonAbs - lonDeg) * 60).toFixed(3);
  const coordLabel = `${latDeg}°${latMin}'${latDir} ${lonDeg}°${lonMin}'${lonDir}`;
  return `Bearing to ${coordLabel}: ${bearingToWords(brg)}, ${formatDistance(dist)}.`;
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
  const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
  const label = nearest.properties.label || 'navaid';
  const name = nearest.properties.name ? `, ${nearest.properties.name}` : '';
  const colour = nearest.properties.colour ? `, ${nearest.properties.colour}` : '';
  return `Nearest ${label}${name}${colour}, bearing ${bearingToWords(brg)}, ${formatDistance(minDist)}.`;
}
