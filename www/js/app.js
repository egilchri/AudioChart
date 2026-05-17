/**
 * AudioChart — main application entry point.
 * Input: text box (use phone keyboard mic for voice-to-text on Pixel).
 * Output: spoken TTS + on-screen text.
 */

import * as TTS from './tts.js';
import * as GPS from './gps.js';
import { parseCommand, parseCoordinate } from './parser.js';
import * as Query from './query.js';

const VERSION = 'v13';
document.getElementById('app-version').textContent = VERSION;

function _navaidMarkerColor(navaid) {
  const c = (navaid.colour || '').toLowerCase();
  const l = navaid.label || '';
  if (c.includes('green'))                     return '#2da84a';
  if (c.includes('red'))                       return '#e05252';
  if (c.includes('white'))                     return '#cccccc';
  if (c.includes('yellow') || c.includes('amber')) return '#e0c030';
  if (l === 'light')                           return '#e0c030';
  if (l === 'beacon')                          return '#4a9edd';
  return '#aaaaaa';
}
import { formatPositionDisplay, bearingToWords, bearingToDisplay, formatDistance, distanceToDisplay, trueTomagnetic } from './utils.js';

// Capture Android PWA install prompt before any user gesture.
let _pwaInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _pwaInstallPrompt = e;
});

// DOM elements
const textForm = document.getElementById('text-form');
const textInput = document.getElementById('text-input');
const statusEl = document.getElementById('status-text');
const positionEl = document.getElementById('position-display');
const responseEl  = document.getElementById('response-text');
const navaidListEl = document.getElementById('navaid-list');
const gpsStatusEl = document.getElementById('gps-status');
const historyList = document.getElementById('history-list');
const historyClear = document.getElementById('history-clear');
const offlineBtn    = document.getElementById('offline-btn');
const routeBtn      = document.getElementById('route-btn');
const cruiseForm    = document.getElementById('cruise-form');
const cruiseChoices = document.getElementById('cruise-choices');
const testPosBtn = document.getElementById('test-pos-btn');
const testPosForm = document.getElementById('test-pos-form');
const testPosInput = document.getElementById('test-pos-input');
const testPosSet = document.getElementById('test-pos-set');
const testPosClear = document.getElementById('test-pos-clear');
const mapLink = document.getElementById('map-link');
const opencpnBtn = document.getElementById('opencpn-btn');

let serverUrl = null;  // set in init(); used by offline button and test-position API

const CRUISE_PROFILES = {
  'Penobscot Bay': {
    dataUrl: './data/regions/penobscot-bay.json',
    stops: [
      { name: 'Rockland',               lat: 44.1018, lon: -69.0752 },
      { name: 'Camden',                 lat: 44.2099, lon: -69.0645 },
      { name: 'Belfast',                lat: 44.4258, lon: -68.9969 },
      { name: 'Castine',                lat: 44.3867, lon: -68.7956 },
      { name: 'Stonington',             lat: 44.1647, lon: -68.6655 },
      { name: 'Great Cranberry Island', lat: 44.2366, lon: -68.3103 },
    ],
  },
  'Casco Bay': {
    dataUrl: './data/regions/casco-bay.json',
    stops: [
      { name: 'Portland',  lat: 43.6573, lon: -70.2564 },
      { name: 'Harpswell', lat: 43.7931, lon: -70.0760 },
    ],
  },
  'Piscataqua': {
    dataUrl: './data/regions/piscataqua.json',
    stops: [
      { name: 'Portsmouth',     lat: 43.0718, lon: -70.7626 },
      { name: 'Isles of Shoals', lat: 42.9697, lon: -70.6234 },
      { name: 'Kittery',        lat: 43.0850, lon: -70.7350 },
    ],
  },
};

// ── Query history ─────────────────────────────────────────────────────────────

const HISTORY_KEY = 'audiochart-history';
const HISTORY_MAX = 30;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function saveHistory(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_MAX)));
}

function addToHistory(text) {
  const items = loadHistory().filter(t => t !== text);
  items.unshift(text);
  saveHistory(items);
  renderHistory();
}

function renderHistory() {
  const items = loadHistory();
  historyList.innerHTML = '';
  items.forEach(text => {
    const btn = document.createElement('button');
    btn.className = 'history-pill';
    btn.textContent = text;
    btn.addEventListener('click', () => {
      textInput.value = text;
      textInput.focus();
    });
    historyList.appendChild(btn);
  });
  historyClear.style.display = items.length ? 'inline-block' : 'none';
}

historyClear.addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

renderHistory();

// ── State ─────────────────────────────────────────────────────────────────────

let dataLoaded = false;
let gpsReady = false;
let _map = null;
let _mapLayers = null;
let _leafletReady = false;
let _lastCourseFrom = null;
let _lastCourseTo   = null;

async function loadLeaflet() {
  if (_leafletReady) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = serverUrl ? `${serverUrl}/js/lib/leaflet.js` : './js/lib/leaflet.js';
    s.onload = () => { _leafletReady = true; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function setStatus(msg) { statusEl.textContent = msg; }
function showResponse(text) {
  responseEl.textContent = text;
  navaidListEl.style.display = 'none';
  navaidListEl.innerHTML = '';
  document.getElementById('map-container').classList.remove('map-compact');
}

function showNavaidList(navaids) {
  document.getElementById('map-container').classList.add('map-compact');
  navaidListEl.innerHTML = '';
  for (const n of navaids) {
    const nameStr = n.name ? ` ${n.name}` : '';
    const detail  = n.characteristic ? ` (${n.characteristic})` : n.colour ? ` (${n.colour})` : '';
    const base    = `${n.label}${nameStr}${detail}`;

    const row = document.createElement('button');
    row.className = 'navaid-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'navaid-row-name';
    nameEl.textContent = base;

    const navEl = document.createElement('span');
    navEl.className = 'navaid-row-nav';
    navEl.textContent = `${bearingToDisplay(n.brg)}  ${distanceToDisplay(n.d)}`;

    row.appendChild(nameEl);
    row.appendChild(navEl);
    row.addEventListener('click', () =>
      TTS.sayImmediate(`${base}, bearing ${bearingToWords(n.brg)}, ${formatDistance(n.d)}.`)
    );
    navaidListEl.appendChild(row);
  }
  navaidListEl.style.display = 'flex';
}

function _ensureMap() {
  if (_map) return;
  _map = L.map('leaflet-map', { zoomControl: false, attributionControl: true });
  // ESRI World Imagery satellite tiles — pre-cached during ⬇ Route for offline use.
  // Note: ESRI tile URL uses {z}/{y}/{x} order (y before x).
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { minZoom: 4, maxZoom: 17, attribution: '© Esri' }
  ).addTo(_map);
}

async function showPositionMap(lat, lon) {
  await loadLeaflet();
  document.getElementById('map-container').style.display = 'block';
  _ensureMap();
  _map.invalidateSize();
  if (_mapLayers) { _map.removeLayer(_mapLayers); _mapLayers = null; }
  const dot = L.circleMarker([lat, lon], {
    radius: 10, color: '#4a9edd', fillColor: '#4a9edd', fillOpacity: 1, weight: 0,
  }).bindTooltip('You are here', { permanent: true, direction: 'top', className: 'map-tooltip' });
  _mapLayers = L.layerGroup([dot]).addTo(_map);
  _map.setView([lat, lon], 13);
  _map.invalidateSize();
}

async function showMap(fromLat, fromLon, result) {
  await loadLeaflet();
  document.getElementById('map-container').style.display = 'block';
  _ensureMap();
  _map.invalidateSize();  // must precede fitBounds so Leaflet knows container size
  if (_mapLayers) { _map.removeLayer(_mapLayers); _mapLayers = null; }
  const { destLat, destLon, destName } = result;
  const fromDot = L.circleMarker([fromLat, fromLon], {
    radius: 7, color: '#4a9edd', fillColor: '#4a9edd', fillOpacity: 1, weight: 0,
  });
  const toDot = L.circleMarker([destLat, destLon], {
    radius: 7, color: '#e05252', fillColor: '#e05252', fillOpacity: 1, weight: 0,
  });
  if (destName) toDot.bindTooltip(destName, { permanent: true, direction: 'top', className: 'map-tooltip' });
  const line = L.polyline([[fromLat, fromLon], [destLat, destLon]], {
    color: '#4a9edd', weight: 2, dashArray: '6 4', opacity: 0.85,
  });
  _mapLayers = L.layerGroup([line, fromDot, toDot]).addTo(_map);
  _map.fitBounds(L.latLngBounds([[fromLat, fromLon], [destLat, destLon]]).pad(0.2));
}

function hideMap() {
  document.getElementById('map-container').style.display = 'none';
}

async function showNavaidMap(fromLat, fromLon, navaids) {
  await loadLeaflet();
  document.getElementById('map-container').style.display = 'block';
  _ensureMap();
  _map.invalidateSize();
  if (_mapLayers) { _map.removeLayer(_mapLayers); _mapLayers = null; }

  const layers = [];
  layers.push(L.circleMarker([fromLat, fromLon], {
    radius: 8, color: '#4a9edd', fillColor: '#4a9edd', fillOpacity: 1, weight: 0,
  }).bindTooltip('You', { permanent: true, direction: 'top', className: 'map-tooltip' }));

  for (const n of navaids) {
    const color = _navaidMarkerColor(n);
    const marker = L.circleMarker([n.lat, n.lon], {
      radius: 7, color, fillColor: color, fillOpacity: 0.9, weight: 2,
    });
    const tip = [n.name, n.characteristic || n.colour].filter(Boolean).join(' — ');
    if (tip) marker.bindTooltip(tip, { permanent: false, direction: 'top', className: 'map-tooltip' });
    marker.on('click', () => {
      const nameStr = n.name ? ` ${n.name}` : '';
      const detail  = n.characteristic ? `, ${n.characteristic}` : n.colour ? `, ${n.colour}` : '';
      const base = `${n.label}${nameStr}${detail}`;
      const displayText = `${base}, ${bearingToDisplay(n.brg)}, ${distanceToDisplay(n.d)}`;
      const speechText  = `${base}, bearing ${bearingToWords(n.brg)}, ${formatDistance(n.d)}.`;
      showResponse(displayText);
      TTS.sayImmediate(speechText);
    });
    layers.push(marker);
  }

  _mapLayers = L.layerGroup(layers).addTo(_map);
  const allPts = [[fromLat, fromLon], ...navaids.map(n => [n.lat, n.lon])];
  _map.fitBounds(L.latLngBounds(allPts).pad(0.25));
}

async function showHazardMap(fromLat, fromLon, hazardPts) {
  await loadLeaflet();
  document.getElementById('map-container').style.display = 'block';
  _ensureMap();
  _map.invalidateSize();
  if (_mapLayers) { _map.removeLayer(_mapLayers); _mapLayers = null; }

  const layers = [];
  layers.push(L.circleMarker([fromLat, fromLon], {
    radius: 8, color: '#4a9edd', fillColor: '#4a9edd', fillOpacity: 1, weight: 0,
  }).bindTooltip('You', { permanent: true, direction: 'top', className: 'map-tooltip' }));

  for (const h of hazardPts) {
    const marker = L.circleMarker([h.lat, h.lon], {
      radius: 7, color: '#e0a030', fillColor: '#e0a030', fillOpacity: 0.9, weight: 2,
    });
    const tip = [h.label, h.name].filter(Boolean).join(', ');
    if (tip) marker.bindTooltip(tip, { permanent: false, direction: 'top', className: 'map-tooltip' });
    marker.on('click', () => {
      const nameStr = h.name ? `, ${h.name}` : '';
      const base = `${h.label}${nameStr}`;
      const displayText = `${base}, ${bearingToDisplay(h.brg)}, ${distanceToDisplay(h.d)}`;
      const speechText  = `${base}, bearing ${bearingToWords(h.brg)}, ${formatDistance(h.d)}.`;
      showResponse(displayText);
      TTS.sayImmediate(speechText);
    });
    layers.push(marker);
  }

  _mapLayers = L.layerGroup(layers).addTo(_map);
  const allPts = [[fromLat, fromLon], ...hazardPts.map(h => [h.lat, h.lon])];
  _map.fitBounds(L.latLngBounds(allPts).pad(0.25));
}

async function showCourseMap(fromLat, fromLon, toLat, toLon, hazardPts) {
  await loadLeaflet();
  document.getElementById('map-container').style.display = 'block';
  _ensureMap();
  _map.invalidateSize();
  if (_mapLayers) { _map.removeLayer(_mapLayers); _mapLayers = null; }

  const layers = [];
  // Course line
  layers.push(L.polyline([[fromLat, fromLon], [toLat, toLon]], {
    color: '#4a9edd', weight: 2, dashArray: '6 4', opacity: 0.85,
  }));
  // From/To endpoints
  layers.push(L.circleMarker([fromLat, fromLon], { radius: 7, color: '#4a9edd', fillColor: '#4a9edd', fillOpacity: 1, weight: 0 }));
  layers.push(L.circleMarker([toLat, toLon],   { radius: 7, color: '#4a9edd', fillColor: '#4a9edd', fillOpacity: 1, weight: 0 }));
  // Hazard markers
  for (const h of (hazardPts || [])) {
    const m = L.circleMarker([h.lat, h.lon], { radius: 6, color: '#e0a030', fillColor: '#e0a030', fillOpacity: 1, weight: 0 });
    if (h.label || h.name) m.bindTooltip((h.label + h.name).trim(), { permanent: false, direction: 'top', className: 'map-tooltip' });
    m.on('click', () => {
      const label = ((h.label || '') + (h.name || '')).trim();
      const pos = GPS.getPosition();
      let displayText = label;
      let speechText  = label;
      if (pos) {
        const d   = Query.distanceNm(pos.lon, pos.lat, h.lon, h.lat);
        const brg = trueTomagnetic(Query.bearing(pos.lon, pos.lat, h.lon, h.lat));
        const displayRB = `${bearingToDisplay(brg)}, ${distanceToDisplay(d)}`;
        const speechRB  = `bearing ${bearingToWords(brg)}, ${formatDistance(d)}`;
        displayText = label ? `${label}, ${displayRB}` : displayRB;
        speechText  = label ? `${label}, ${speechRB}.` : `${speechRB}.`;
      }
      showResponse(displayText);
      TTS.sayImmediate(speechText);
    });
    layers.push(m);
  }

  _mapLayers = L.layerGroup(layers).addTo(_map);
  const allPts = [[fromLat, fromLon], [toLat, toLon], ...(hazardPts || []).map(h => [h.lat, h.lon])];
  _map.fitBounds(L.latLngBounds(allPts).pad(0.2));
}

const SOURCE_LABEL = {
  'manual':        'TEST POSITION',
  'browser':       'PHONE GPS',
  'nmea':          'GPS PUCK',
  'opencpn-nmea':  'OPENCPN LIVE',
  'opencpn-ini':   'OPENCPN',
  'opencpn-track': 'OPENCPN TRACK',
};

positionEl.addEventListener('click', () => {
  const text = positionEl.textContent;
  if (!text || text.startsWith('--')) return;
  navigator.clipboard.writeText(text).then(() => {
    const prev = positionEl.textContent;
    positionEl.textContent = 'Copied!';
    setTimeout(() => { positionEl.textContent = prev; }, 1000);
  });
});

function showPosition(lat, lon, accuracy, source) {
  positionEl.textContent = formatPositionDisplay(lat, lon);
  const label = SOURCE_LABEL[source] || source.toUpperCase();
  const accText = accuracy && !['opencpn-track', 'manual'].includes(source)
    ? ` ±${Math.round(accuracy)}m` : '';
  gpsStatusEl.textContent = `GPS: ${label}${accText}`;
  gpsStatusEl.className = source === 'manual'
    ? 'status-badge gps-test'
    : 'status-badge gps-ok';

  if (source === 'manual') {
    mapLink.href = `https://maps.google.com/?q=${lat},${lon}&z=14`;
    mapLink.style.display = 'block';
  } else {
    mapLink.style.display = 'none';
  }
}

// ── Command handling ──────────────────────────────────────────────────────────

async function handleCommand(transcript) {
  console.log('[AudioChart] handleCommand:', transcript);
  try {
    setStatus(`Command: "${transcript}"`);
    showResponse('...');
    addToHistory(transcript);

    const { intent, params } = parseCommand(transcript);

    if (intent === 'LIST_OBJECTS') {
      const response = {
        text:   'Hazards (rocks, ledges, shoals) · Buoys · Lights · Beacons · Restrictions (no-anchor, sanctuary) · Named places · Waypoints',
        speech: 'I can find hazards like rocks, ledges, and shoals; navigation aids including buoys, lights, and beacons; restricted areas like no-anchor zones and sanctuaries; and named places and OpenCPN waypoints for bearing queries.',
      };
      showResponse(response.text);
      TTS.sayImmediate(response.speech);
      return;
    }

    const pos = GPS.getPosition();
    if (!pos) {
      const msg = 'No GPS fix yet. Please wait for a position.';
      showResponse(msg);
      TTS.sayImmediate(msg);
      return;
    }

    if (!dataLoaded) {
      const msg = 'Chart data still loading. Please wait.';
      showResponse(msg);
      TTS.sayImmediate(msg);
      return;
    }
    console.log('[AudioChart] intent:', intent, params);
    let response;

    switch (intent) {
      case 'WHERE_AM_I': {
        response = Query.whereAmI(pos.lat, pos.lon, pos.accuracy);
        // If local data had no landmark, ask the server directly
        if (serverUrl && response.text && /^\d+\s+degrees/.test(response.text)) {
          try {
            const r = await fetch(
              `${serverUrl}/api/nearest-landmark?lat=${pos.lat}&lon=${pos.lon}`,
              { cache: 'no-store', signal: AbortSignal.timeout(4000) }
            );
            if (r.ok) {
              const lm = await r.json();
              const dir = Query.compassDir(lm.bearing_deg);
              const dist = Query.naturalDist(lm.dist_nm);
              const acc = pos.accuracy ? `  ±${Math.round(pos.accuracy)} m` : '';
              const accSp = pos.accuracy ? `, accuracy ${Math.round(pos.accuracy)} metres` : '';
              response = {
                text:   `${dist} ${dir} of ${lm.name}${acc}`,
                speech: `You are ${dist} ${dir} of ${lm.name}${accSp}.`,
              };
            }
          } catch (_) {}
        }
        break;
      }
      case 'NEAREST_HAZARD':
        response = Query.nearestHazard(pos.lat, pos.lon);
        break;
      case 'HAZARDS_IN_RADIUS':
        response = Query.hazardsInRadius(pos.lat, pos.lon, params.radiusNm ?? 0.25);
        if (Query.lastHazardResults?.length) {
          showHazardMap(pos.lat, pos.lon, Query.lastHazardResults).catch(() => {});
        }
        break;
      case 'BEARING_TO_COORD':
        response = Query.bearingToCoord(pos.lat, pos.lon, params.lat, params.lon);
        break;
      case 'BEARING_TO_PLACE': {
        response = Query.bearingToPlace(pos.lat, pos.lon, params.placeName);
        if (!response && serverUrl) {
          const place = await Query.findPlaceOnServer(params.placeName);
          if (place) {
            response = Query.bearingToResolvedPlace(pos.lat, pos.lon, place.lat, place.lon, place.name);
          }
        }
        if (!response) {
          response = `I couldn't find "${params.placeName}". Try a different name.`;
        }
        break;
      }
      case 'NEAREST_NAVAID':
        response = Query.nearestNavaid(pos.lat, pos.lon);
        break;
      case 'NAVAIDS_IN_RADIUS':
        response = Query.navaidsInRadius(pos.lat, pos.lon, params.radiusNm, params.filter ?? null);
        if (Query.lastNavaidResults?.length) {
          showNavaidMap(pos.lat, pos.lon, Query.lastNavaidResults).catch(() => {});
          response = { text: response?.text ?? response, speech: response?.text ?? response, _navaidList: Query.lastNavaidResults };
        }
        break;
      case 'NAVAIDS_ON_BEARING':
        response = Query.navaidsOnBearing(pos.lat, pos.lon, params.bearing, params.tolerance, params.filters ?? null);
        if (Query.lastNavaidResults?.length) {
          showNavaidMap(pos.lat, pos.lon, Query.lastNavaidResults).catch(() => {});
          response = { text: response?.text ?? response, speech: response?.text ?? response, _navaidList: Query.lastNavaidResults };
        }
        break;
      case 'NEAREST_RESTRICTION':
        response = Query.nearestRestriction(pos.lat, pos.lon);
        break;
      case 'HAZARDS_ON_COURSE': {
        const resolvePlace = async (name) =>
          parseCoordinate(name) ||
          await Query.findPlaceOnServer(name) ||
          Query.findPlaceByName(name);
        const [fromPos, toPos] = await Promise.all([
          resolvePlace(params.fromPlace),
          resolvePlace(params.toPlace),
        ]);
        if (!fromPos) { response = { text: `Couldn't find "${params.fromPlace}"`, speech: `I couldn't find ${params.fromPlace}.` }; break; }
        if (!toPos)   { response = { text: `Couldn't find "${params.toPlace}"`,   speech: `I couldn't find ${params.toPlace}.`   }; break; }
        _lastCourseFrom = fromPos;
        _lastCourseTo   = toPos;
        // Server endpoint queries the full chart DB — bypasses the 20nm in-memory limit
        if (serverUrl) {
          try {
            const r = await fetch(
              `${serverUrl}/api/course-hazards?from_lat=${fromPos.lat}&from_lon=${fromPos.lon}&to_lat=${toPos.lat}&to_lon=${toPos.lon}`,
              { cache: 'no-store', signal: AbortSignal.timeout(8000) }
            );
            if (r.ok) {
              const data = await r.json();
              response = Query.formatCourseHazards(data.hazards, data.course_length_nm);
              break;
            }
          } catch (_) {}
        }
        response = Query.hazardsOnCourse(fromPos.lat, fromPos.lon, toPos.lat, toPos.lon);
        break;
      }
      case 'HAZARDS_ALONG_ROUTE': {
        if (!serverUrl) {
          response = { text: 'Route lookup requires the Mac server.', speech: 'Route lookup requires the Mac server.' };
          break;
        }
        try {
          const r = await fetch(
            `${serverUrl}/api/route-hazards?name=${encodeURIComponent(params.routeName)}`,
            { cache: 'no-store', signal: AbortSignal.timeout(8000) }
          );
          if (!r.ok) throw new Error('Server error');
          const data = await r.json();
          if (data.not_found) {
            response = { text: `No route named "${params.routeName}" found in OpenCPN.`, speech: `I couldn't find a route called ${params.routeName} in OpenCPN.` };
            break;
          }
          if (data.error) { response = { text: data.error, speech: data.error }; break; }
          _lastCourseFrom = data.from;
          _lastCourseTo   = data.to;
          _lastCourseFrom._routeName = data.route_name;
          response = Query.formatCourseHazards(data.hazards, data.course_length_nm);
        } catch (e) {
          response = { text: `Error: ${e.message}`, speech: `Error looking up route.` };
        }
        break;
      }
      default:
        response = 'I didn\'t understand that. Try: "hazards within quarter mile", "bearing to [place]", or "where am I".';
    }

    const displayText = response?.text  ?? response;
    const speechText  = response?.speech ?? response;
    const navaidList  = response?._navaidList ?? null;
    showResponse(displayText);
    if (navaidList) showNavaidList(navaidList);
    TTS.sayImmediate(speechText);

    const SHOW_MAP_FOR = ['BEARING_TO_PLACE', 'BEARING_TO_COORD', 'NEAREST_HAZARD', 'NEAREST_NAVAID', 'NEAREST_RESTRICTION'];
    const isCourseIntent = (intent === 'HAZARDS_ON_COURSE' || intent === 'HAZARDS_ALONG_ROUTE');
    if (intent === 'WHERE_AM_I') {
      showPositionMap(pos.lat, pos.lon).catch(() => {});
      opencpnBtn.style.display = 'none';
    } else if (isCourseIntent && _lastCourseFrom) {
      showCourseMap(_lastCourseFrom.lat, _lastCourseFrom.lon, _lastCourseTo.lat, _lastCourseTo.lon, Query.lastCourseHazards).catch(() => {});
      if (serverUrl) opencpnBtn.style.display = 'inline-block';
    } else if (SHOW_MAP_FOR.includes(intent) && Query.lastBearingResult) {
      showMap(pos.lat, pos.lon, Query.lastBearingResult).catch(() => {});
      opencpnBtn.style.display = 'none';
    } else {
      hideMap();
      opencpnBtn.style.display = 'none';
    }
  } catch (err) {
    console.error('[AudioChart] handleCommand error:', err);
    showResponse(`Error: ${err.message}`);
  }
}

// ── Text input ────────────────────────────────────────────────────────────────

if (textForm) {
  textForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = textInput.value.trim();
    if (!text) return;
    textInput.value = '';
    TTS.stop();
    handleCommand(text);
  });
}

// ── Test position override ────────────────────────────────────────────────────

function syncTestPosButton() {
  const active = GPS.isManualPosition();
  testPosBtn.textContent = active ? '📍 CLEAR TEST' : '📍';
  testPosBtn.classList.toggle('test-active', active);
}

testPosBtn.addEventListener('click', () => {
  if (GPS.isManualPosition()) {
    clearTestPosition();
    return;
  }
  const isOpen = testPosForm.style.display !== 'none';
  testPosForm.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) testPosInput.focus();
});

testPosSet.addEventListener('click', async () => {
  const raw = testPosInput.value.trim();
  // Coordinates first; for place names prefer server (full DB + label ranking),
  // falling back to local cache when offline.
  let coord = parseCoordinate(raw);
  if (!coord) coord = await Query.findPlaceOnServer(raw) || Query.findPlaceByName(raw);
  if (coord) {
    GPS.setManualPosition(coord.lat, coord.lon);
    testPosForm.style.display = 'none';
    testPosInput.value = '';
    syncTestPosButton();
    if (coord.name) setStatus(`Test position set: ${coord.name}`);
    if (serverUrl) {
      fetch(`${serverUrl}/api/test-position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: coord.lat, lon: coord.lon }),
      }).catch(() => {});
      // Reload chart data for the new position so local queries work
      setStatus(`Loading chart data for ${coord.name || 'position'}…`);
      Query.loadData(coord.lat, coord.lon).then(() => {
        dataLoaded = true;
        setStatus(`Ready. (${coord.name || 'test position'})`);
      }).catch(() => {});
    }
  } else {
    testPosInput.style.borderColor = 'var(--danger)';
    setTimeout(() => { testPosInput.style.borderColor = ''; }, 1500);
  }
});

opencpnBtn.addEventListener('click', () => {
  if (!serverUrl || !_lastCourseFrom || !_lastCourseTo) return;
  const p = new URLSearchParams({
    from_lat:  _lastCourseFrom.lat,
    from_lon:  _lastCourseFrom.lon,
    to_lat:    _lastCourseTo.lat,
    to_lon:    _lastCourseTo.lon,
    from_name: _lastCourseFrom.name || 'Start',
    to_name:   _lastCourseTo.name   || 'End',
  });
  if (_lastCourseFrom._routeName) p.set('route_name', _lastCourseFrom._routeName);
  window.open(`${serverUrl}/course-map?${p}`, '_blank');
});

function clearTestPosition() {
  GPS.clearManualPosition();
  testPosForm.style.display = 'none';
  syncTestPosButton();
  if (serverUrl) {
    fetch(`${serverUrl}/api/test-position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => {});
  }
}

testPosClear.addEventListener('click', clearTestPosition);

// ── Route download ────────────────────────────────────────────────────────────

function _isPWA() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

async function checkOnboarding() {
  if (new URLSearchParams(location.search).has('demo')) return;

  const overlay   = document.getElementById('welcome-overlay');
  const stepDl    = document.getElementById('ob-step-download');
  const stepInst  = document.getElementById('ob-step-install');

  const hasData = await Query.hasOfflineData();

  if (!hasData) {
    stepDl.style.display   = '';
    stepInst.style.display = 'none';
    overlay.style.display  = 'flex';
    return;
  }

  if (!_isPWA() && !localStorage.getItem('audiochart-install-dismissed')) {
    stepDl.style.display   = 'none';
    stepInst.style.display = '';
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    document.getElementById('ob-install-ios').style.display     = isIOS ? '' : 'none';
    document.getElementById('ob-install-android').style.display = isIOS ? 'none' : '';
    overlay.style.display = 'flex';
    return;
  }

  overlay.style.display = 'none';
}

async function runRouteDownload(cruiseName) {
  const profile = CRUISE_PROFILES[cruiseName];
  cruiseForm.style.display = 'none';
  routeBtn.disabled = true;
  if (offlineBtn) offlineBtn.disabled = true;

  const stops = profile.stops;

  if (profile.dataUrl) {
    // Standalone mode — chart data is one regional file, then cache satellite tiles per stop
    routeBtn.textContent = '⏳ Chart data…';
    setStatus(`Downloading ${cruiseName} chart data…`);
    try {
      const result = await Query.prepareOfflineStatic(profile.dataUrl);
      await Query.loadData(null, null);
      dataLoaded = true;
      setStatus(`Chart data ready — caching satellite tiles…`);
    } catch (e) {
      const reason = e.name === 'AbortError' ? 'timed out' : e.message;
      setStatus(`Download failed: ${reason}`);
      routeBtn.textContent = '⬇ Route';
      routeBtn.disabled = false;
      if (offlineBtn) offlineBtn.disabled = false;
      return;
    }
    // Cache satellite tiles for each stop
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      routeBtn.textContent = `🛰 ${i + 1}/${stops.length}`;
      await Query.cacheSatelliteTiles(stop.lat, stop.lon, (done, total) => {
        setStatus(`Satellite tiles ${stop.name}: ${done}/${total}`);
      });
    }
    routeBtn.textContent = '✓ Route cached';
    setStatus(`${cruiseName} ready — chart data and satellite tiles cached.`);
    routeBtn.disabled = false;
    if (offlineBtn) offlineBtn.disabled = false;
    checkOnboarding();
    return;
  }

  // Developer mode — stop-by-stop dynamic API calls + satellite tiles
  let lastResult;
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    routeBtn.textContent = `⏳ ${i + 1}/${stops.length}`;
    setStatus(`Downloading ${stop.name} (${i + 1} of ${stops.length})…`);
    try {
      lastResult = await Query.prepareOffline(stop.lat, stop.lon, 25);
    } catch (e) {
      const reason = e.name === 'AbortError' ? 'timed out' : e.message;
      setStatus(`Download failed at ${stop.name}: ${reason}`);
      routeBtn.textContent = '⬇ Route';
      routeBtn.disabled = false;
      if (offlineBtn) offlineBtn.disabled = false;
      return;
    }
    routeBtn.textContent = `🛰 ${i + 1}/${stops.length}`;
    await Query.cacheSatelliteTiles(stop.lat, stop.lon, (done, total) => {
      setStatus(`Satellite tiles ${stop.name}: ${done}/${total}`);
    });
  }
  routeBtn.textContent = '✓ Route cached';
  setStatus(`${cruiseName} route complete — ${lastResult.total} features + satellite tiles cached.`);
  routeBtn.disabled = false;
  if (offlineBtn) offlineBtn.disabled = false;
  checkOnboarding();
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {
  setStatus('Waiting for GPS...');

  // If opened via QR code with ?server=, persist the server URL and clean the address bar.
  const _params = new URLSearchParams(location.search);
  const _serverParam = _params.get('server');
  if (_serverParam) {
    localStorage.setItem('audiochart_server_url', _serverParam);
    history.replaceState(null, '', location.pathname);
  }

  // Connect to Mac server BEFORE starting GPS so setServerBase is ready
  // when the first fix arrives and triggers loadData.
  const isMacServer = location.hostname === 'localhost' ||
                      /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(location.hostname) ||
                      /\.ngrok(-free)?\.app$|\.ngrok\.io$/.test(location.hostname);
  serverUrl = isMacServer
    ? location.origin
    : localStorage.getItem('audiochart_server_url');
  if (serverUrl) {
    GPS.connectServer(serverUrl);
    Query.setServerBase(serverUrl);

    // Show offline prep button only when Mac server is reachable
    offlineBtn.style.display = 'inline-block';
    offlineBtn.addEventListener('click', async () => {
      const pos = GPS.getPosition();
      if (!pos) { setStatus('No GPS fix yet — cannot download offline data.'); return; }
      offlineBtn.disabled = true;
      routeBtn.disabled = true;
      offlineBtn.textContent = '⏳ Downloading...';
      try {
        const result = await Query.prepareOffline(pos.lat, pos.lon);
        offlineBtn.textContent = '✓ Offline ready';
        setStatus(`Downloaded ${result.added} features (${result.total} total cached).`);
      } catch (e) {
        offlineBtn.textContent = '⬇ Offline';
        const reason = e.name === 'AbortError' ? 'timed out' : e.message;
        setStatus(`Offline download failed: ${reason}`);
        console.error('[offline]', e);
      } finally {
        offlineBtn.disabled = false;
        routeBtn.disabled = false;
      }
    });

  }

  // Route button and cruise picker are always available (standalone + developer)
  routeBtn.style.display = 'inline-block';
  routeBtn.addEventListener('click', () => {
    const isOpen = cruiseForm.style.display !== 'none';
    cruiseForm.style.display = isOpen ? 'none' : 'flex';
  });
  Object.keys(CRUISE_PROFILES).forEach(cruiseName => {
    const btn = document.createElement('button');
    btn.className = 'cruise-choice';
    btn.textContent = cruiseName;
    btn.addEventListener('click', () => runRouteDownload(cruiseName));
    cruiseChoices.appendChild(btn);
  });

  // Standalone mode: load bundled static data immediately (no GPS needed)
  if (!serverUrl) {
    Query.loadData(null, null).then(() => {
      dataLoaded = true;
      setStatus('Ready. (offline)');
    }).catch(() => {});
  }

  GPS.startGPS(
    async (lat, lon, accuracy, source) => {
      showPosition(lat, lon, accuracy, source);
      if (!gpsReady) {
        gpsReady = true;
        setStatus('Loading chart data for your position...');
        try {
          await Query.loadData(lat, lon);
          dataLoaded = true;
          setStatus('Ready.');
        } catch (e) {
          setStatus('Chart data unavailable. Try reloading.');
          showResponse('Could not load chart data. If offline, ensure data files are cached.');
        }
      } else {
        Query.refreshIfNeeded(lat, lon).catch(() => {});
      }
    },
    (err) => {
      gpsStatusEl.textContent = `GPS: ${err}`;
      gpsStatusEl.className = 'status-badge gps-error';
      setStatus(err);
    }
  );

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  if (new URLSearchParams(location.search).has('demo')) {
    runDemoMode();
  }
}

// ── Demo mode ─────────────────────────────────────────────────────────────────
// Activated by adding ?demo to the URL.  Sets a test position and runs through
// a sequence of commands automatically — useful for screen-recording demos.

async function runDemoMode() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hud = document.getElementById('demo-hud');
  const show = msg => { if (hud) hud.textContent = msg; };

  hud.style.display = 'block';
  localStorage.setItem('audiochart-welcomed', '1');  // suppress welcome overlay

  show('DEMO — setting position to Rockland Harbor…');
  await sleep(2000);

  // Set test position
  const demoLat = 44.0986, demoLon = -69.0752;
  GPS.setManualPosition(demoLat, demoLon);
  syncTestPosButton();
  if (serverUrl) {
    fetch(`${serverUrl}/api/test-position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: demoLat, lon: demoLon }),
    }).catch(() => {});
    setStatus('Loading chart data…');
    await Query.loadData(demoLat, demoLon);
    dataLoaded = true;
    setStatus('Ready.');
  }
  await sleep(2000);

  const sequence = [
    ['Where am I',                           4500],
    ['Hazards within quarter mile',          5500],
    ['Range and bearing to Carvers Harbor',  5000],
    ['Nearest light',                        4000],
    ['Nearest restricted area',              4500],
    ['Hazards along Rockland-Camden',        7000],
  ];

  for (const [cmd, pauseMs] of sequence) {
    show(`▶  ${cmd}`);
    textInput.value = '';
    textInput.focus();
    for (const ch of cmd) {
      textInput.value += ch;
      await sleep(45);
    }
    await sleep(400);
    textForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await sleep(pauseMs);
  }

  // Open the full chart map if the button is visible
  if (opencpnBtn && opencpnBtn.style.display !== 'none') {
    show('▶  Opening full chart view…');
    opencpnBtn.click();
    await sleep(5000);
  }

  show('✓  Demo complete');
  await sleep(2000);
  hud.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', () => {
  // Populate onboarding region buttons (Step 1)
  const obRegions = document.getElementById('ob-regions');
  Object.keys(CRUISE_PROFILES).forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'ob-region-btn';
    btn.textContent = name;
    btn.addEventListener('click', () => {
      document.getElementById('welcome-overlay').style.display = 'none';
      runRouteDownload(name);
    });
    obRegions.appendChild(btn);
  });

  // Android install button (Step 2)
  document.getElementById('ob-install-btn')?.addEventListener('click', async () => {
    if (_pwaInstallPrompt) {
      await _pwaInstallPrompt.prompt();
      _pwaInstallPrompt = null;
    }
    document.getElementById('welcome-overlay').style.display = 'none';
    localStorage.setItem('audiochart-install-dismissed', '1');
  });

  // "Maybe later" (Step 2)
  document.getElementById('ob-install-later')?.addEventListener('click', () => {
    document.getElementById('welcome-overlay').style.display = 'none';
    localStorage.setItem('audiochart-install-dismissed', '1');
  });

  init();
  checkOnboarding();
});
