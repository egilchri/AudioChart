/**
 * AudioChart — main application entry point.
 * Input: text box (use phone keyboard mic for voice-to-text on Pixel).
 * Output: spoken TTS + on-screen text.
 */

import * as TTS from './tts.js';
import * as GPS from './gps.js';
import { parseCommand, parseCoordinate } from './parser.js';
import * as Query from './query.js';
import { formatPositionDisplay } from './utils.js';

// DOM elements
const textForm = document.getElementById('text-form');
const textInput = document.getElementById('text-input');
const statusEl = document.getElementById('status-text');
const positionEl = document.getElementById('position-display');
const responseEl = document.getElementById('response-text');
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
      TTS.stop();
      handleCommand(text);
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
function showResponse(text) { responseEl.textContent = text; }

async function showMap(fromLat, fromLon, result) {
  await loadLeaflet();
  const container = document.getElementById('map-container');
  container.style.display = 'block';
  if (!_map) {
    _map = L.map('leaflet-map', { zoomControl: false, attributionControl: !!(!serverUrl) });
    const tileUrl = serverUrl
      ? `${serverUrl}/tiles/{z}/{x}/{y}.jpg`
      : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const tileOpts = serverUrl
      ? { minZoom: 10, maxZoom: 16 }
      : { minZoom: 8, maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' };
    L.tileLayer(tileUrl, tileOpts).addTo(_map);
  }
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
  _map.fitBounds(L.latLngBounds([[fromLat, fromLon], [destLat, destLon]]).pad(0.35));
  _map.invalidateSize();
}

function hideMap() {
  document.getElementById('map-container').style.display = 'none';
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

    const { intent, params } = parseCommand(transcript);
    console.log('[AudioChart] intent:', intent, params);
    let response;

    switch (intent) {
      case 'WHERE_AM_I':
        response = Query.whereAmI(pos.lat, pos.lon, pos.accuracy);
        break;
      case 'NEAREST_HAZARD':
        response = Query.nearestHazard(pos.lat, pos.lon);
        break;
      case 'HAZARDS_IN_RADIUS':
        response = Query.hazardsInRadius(pos.lat, pos.lon, params.radiusNm ?? 0.25);
        break;
      case 'BEARING_TO_COORD':
        response = Query.bearingToCoord(pos.lat, pos.lon, params.lat, params.lon);
        break;
      case 'BEARING_TO_PLACE':
        response = Query.bearingToPlace(pos.lat, pos.lon, params.placeName);
        break;
      case 'NEAREST_NAVAID':
        response = Query.nearestNavaid(pos.lat, pos.lon);
        break;
      default:
        response = 'I didn\'t understand that. Try: "hazards within quarter mile", "bearing to [place]", or "where am I".';
    }

    const displayText = response?.text  ?? response;
    const speechText  = response?.speech ?? response;
    showResponse(displayText);
    TTS.sayImmediate(speechText);

    const SHOW_MAP_FOR = ['BEARING_TO_PLACE', 'BEARING_TO_COORD', 'NEAREST_HAZARD', 'NEAREST_NAVAID'];
    if (SHOW_MAP_FOR.includes(intent) && Query.lastBearingResult) {
      showMap(pos.lat, pos.lon, Query.lastBearingResult).catch(() => {});
    } else {
      hideMap();
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

testPosBtn.addEventListener('click', () => {
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

testPosClear.addEventListener('click', () => {
  GPS.clearManualPosition();
  testPosForm.style.display = 'none';
  if (serverUrl) {
    fetch(`${serverUrl}/api/test-position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => {});
  }
});

// ── Route download ────────────────────────────────────────────────────────────

async function runRouteDownload(cruiseName) {
  const profile = CRUISE_PROFILES[cruiseName];
  cruiseForm.style.display = 'none';
  routeBtn.disabled = true;
  if (offlineBtn) offlineBtn.disabled = true;

  if (!serverUrl && profile.dataUrl) {
    // Standalone mode — fetch pre-built regional file from hosting
    routeBtn.textContent = '⏳ Downloading...';
    setStatus(`Downloading ${cruiseName} chart data…`);
    try {
      const result = await Query.prepareOfflineStatic(profile.dataUrl);
      // Refresh in-memory data from the updated IndexedDB so queries work immediately
      await Query.loadData(null, null);
      dataLoaded = true;
      routeBtn.textContent = '✓ Route cached';
      setStatus(`${cruiseName} ready — ${result.total} features loaded.`);
    } catch (e) {
      const reason = e.name === 'AbortError' ? 'timed out' : e.message;
      setStatus(`Download failed: ${reason}`);
      routeBtn.textContent = '⬇ Route';
    }
    routeBtn.disabled = false;
    if (offlineBtn) offlineBtn.disabled = false;
    return;
  }

  // Developer mode — stop-by-stop dynamic API calls
  const stops = profile.stops;
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
  }
  routeBtn.textContent = '✓ Route cached';
  setStatus(`${cruiseName} route complete — ${lastResult.total} features cached.`);
  routeBtn.disabled = false;
  if (offlineBtn) offlineBtn.disabled = false;
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {
  setStatus('Waiting for GPS...');

  // Connect to Mac server BEFORE starting GPS so setServerBase is ready
  // when the first fix arrives and triggers loadData.
  const isMacServer = location.hostname === 'localhost' ||
                      !!location.hostname.match(/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./);
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
}

document.addEventListener('DOMContentLoaded', () => {
  // Show welcome overlay on first visit
  const welcomeOverlay = document.getElementById('welcome-overlay');
  const welcomeClose   = document.getElementById('welcome-close');
  if (!localStorage.getItem('audiochart-welcomed')) {
    welcomeOverlay.style.display = 'flex';
  }
  welcomeClose.addEventListener('click', () => {
    localStorage.setItem('audiochart-welcomed', '1');
    welcomeOverlay.style.display = 'none';
  });

  init();
});
