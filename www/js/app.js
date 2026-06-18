/**
 * AudioChart — main application entry point.
 * Input: text box (use phone keyboard mic for voice-to-text on Pixel).
 * Output: spoken TTS + on-screen text.
 */

import * as TTS from './tts.js';
import * as GPS from './gps.js';
import { parseCommand, parseCoordinate, normalizePlaceName } from './parser.js';
import * as Query from './query.js';

const VERSION = window.APP_VERSION;
document.getElementById('app-version').textContent = VERSION;

// ── Voice picker ──────────────────────────────────────────────────────────────
function _populateVoicePicker() {
  const sel = document.getElementById('voice-select');
  if (!sel) return;
  const voices = TTS.getVoices();
  if (!voices.length) return;
  const current = TTS.currentVoiceName();
  sel.innerHTML = voices.map(v =>
    `<option value="${v.name}"${v.name === current ? ' selected' : ''}>${v.name} (${v.lang})</option>`
  ).join('');
}
_populateVoicePicker();
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener('voiceschanged', _populateVoicePicker);
}
document.getElementById('voice-select')?.addEventListener('change', (e) => {
  TTS.setVoice(e.target.value);
  TTS.sayImmediate('Voice selected.');
});
// ─────────────────────────────────────────────────────────────────────────────

function _navaidMarkerIcon(navaid) {
  const c = (navaid.colour || '').toLowerCase();
  const l = (navaid.label || '').toLowerCase();
  let url;
  if (l === 'light')             url = './icons/markicons/Marks-Light-TypeA.svg';
  else if (l === 'beacon')       url = './icons/markicons/Marks-Beacon-SafeWater.svg';
  else if (c.includes('green'))  url = './icons/markicons/Marks-Lateral-Port-IALA-B.svg';
  else if (c.includes('red'))    url = './icons/markicons/Marks-Lateral-Starboard-IALA-B.svg';
  else                           url = './icons/markicons/Marks-Buoy-TypeA.svg';
  return L.icon({ iconUrl: url, iconSize: [32, 32], iconAnchor: [16, 32], tooltipAnchor: [0, -32] });
}

function _hazardMarkerIcon() {
  return L.icon({ iconUrl: './icons/markicons/Hazard-Warning.svg', iconSize: [28, 28], iconAnchor: [14, 28], tooltipAnchor: [0, -28] });
}

function _pinIcon() {
  return L.icon({ iconUrl: './icons/markicons/Marks-Active-Waypoint.svg', iconSize: [32, 32], iconAnchor: [16, 32], tooltipAnchor: [0, -32] });
}

function _waypointIcon() {
  return L.divIcon({
    className: '',
    html: '<div class="wp-marker"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    tooltipAnchor: [7, -7],
  });
}

function _animBoatIcon(bearingDeg = 0) {
  return L.divIcon({
    className: '',
    html: `<div class="anim-boat" style="transform:rotate(${bearingDeg - 90}deg)"><span class="anim-boat-rock">⛵</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    tooltipAnchor: [14, -14],
  });
}

function _segBearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dLon = (lon2 - lon1) * r;
  const y = Math.sin(dLon) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
            Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

window._dismissBoatCircle = function(el) {
  _boatCircleDismissed = true;
  el.classList.add('boat-bare');
};

function _boatIcon() {
  const cls = _boatCircleDismissed ? 'boat-marker boat-bare' : 'boat-marker';
  return L.divIcon({
    className: '',
    html: `<div class="${cls}" onclick="_dismissBoatCircle(this)"><span class="boat-emoji">⛵</span></div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    tooltipAnchor: [22, -22],
  });
}

function _showBoatPosition(lat, lon) {
  if (!_map) return;
  if (_boatLayer) { _map.removeLayer(_boatLayer); _boatLayer = null; }
  const marker = L.marker([lat, lon], { icon: _boatIcon(), zIndexOffset: 1000, draggable: true });

  marker.on('contextmenu', (e) => e.originalEvent.stopPropagation());
  marker.on('drag', (e) => {
    const { lat: dLat, lng: dLon } = e.target.getLatLng();
    _updateBearingLines(dLat, dLon);
  });
  marker.on('dragend', (e) => {
    const { lat: newLat, lng: newLon } = e.target.getLatLng();
    GPS.setManualPosition(newLat, newLon);
    syncTestPosButton();
    setStatus('Test position moved.');
    if (serverUrl) {
      fetch(`${serverUrl}/api/test-position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: newLat, lon: newLon }),
      }).catch(() => {});
      Query.loadData(newLat, newLon).then(() => {
        dataLoaded = true;
        setStatus('Ready. (map position)');
      }).catch(() => {});
    }
  });
  _boatLayer = L.layerGroup([marker]).addTo(_map);
  // hide the live-position layer — test position takes over
  if (_youLayer) { _map.removeLayer(_youLayer); _youLayer = null; }
  const zoom = _map.getZoom();
  if (!zoom) _map.setView([lat, lon], 13); else _map.panTo([lat, lon]);

  const _depthOn = document.getElementById('nf-depth')?.checked;
  (_depthOn ? _fetchTideHeight(lat, lon) : Promise.resolve())
    .catch(() => {})
    .then(() => _refreshNavaidOverlay());
}

function _clearBoatPosition() {
  if (_boatLayer && _map) { _map.removeLayer(_boatLayer); _boatLayer = null; }
  _refreshYouLayer();
}

function _refreshYouLayer() {
  if (!_map) return;
  if (_youLayer) { _map.removeLayer(_youLayer); _youLayer = null; }
  if (_boatLayer) return; // test position already shown by boat layer
  const pos = GPS.getPosition();
  if (!pos) return;
  const m = L.marker([pos.lat, pos.lon], { icon: _boatIcon(), zIndexOffset: 800 });

  _youLayer = L.layerGroup([m]).addTo(_map);
}

function _markerKey(lat, lon) { return `${lat.toFixed(5)},${lon.toFixed(5)}`; }

function flashMarker(lat, lon) {
  // Expand map to full height
  _mapContainer.classList.remove('map-compact', 'list-focus');

  // After the CSS height transition (250ms), resize + pan + flash
  setTimeout(() => {
    if (_map) {
      _map.invalidateSize();
      const pos = GPS.getPosition();
      if (pos) {
        _map.fitBounds(
          L.latLngBounds([[pos.lat, pos.lon], [lat, lon]]).pad(0.25)
        );
      } else {
        _map.panTo([lat, lon]);
      }
    }
    const marker = _markerByKey.get(_markerKey(lat, lon));
    if (!marker) return;
    const el = marker.getElement ? marker.getElement() : null;
    if (!el) return;
    el.classList.remove('marker-flash');
    void el.offsetWidth;
    el.classList.add('marker-flash');
    el.addEventListener('animationend', () => el.classList.remove('marker-flash'), { once: true });
  }, 260);
}

function _refreshWaypointLayer() {
  if (!_map) return;
  if (_waypointLayer) { _map.removeLayer(_waypointLayer); _waypointLayer = null; }
  if (!_waypointsVisible) return;
  const wps = loadUserWaypoints();
  if (!wps.length) return;
  _waypointLayer = L.layerGroup(
    wps.map(wp => {
      const m = L.marker([wp.lat, wp.lon], { icon: _waypointIcon(), draggable: true });
      m.bindTooltip(wp.name, { permanent: true, direction: 'top', className: 'map-tooltip' });
      _markerByKey.set(_markerKey(wp.lat, wp.lon), m);
      m.on('dragend', (e) => {
        const { lat: newLat, lng: newLon } = e.target.getLatLng();
        const stored = loadUserWaypoints();
        const idx = stored.findIndex(w => w.name === wp.name);
        if (idx !== -1) {
          _markerByKey.delete(_markerKey(stored[idx].lat, stored[idx].lon));
          stored[idx].lat = newLat;
          stored[idx].lon = newLon;
          localStorage.setItem(USER_WP_KEY, JSON.stringify(stored));
          Query.removeUserWaypoint(wp.name);
          Query.mergeUserWaypoints([{ name: wp.name, lat: newLat, lon: newLon }]);
          _markerByKey.set(_markerKey(newLat, newLon), m);
        }
        setStatus(`Waypoint ${wp.name} moved.`);
        TTS.sayImmediate(`Waypoint ${wp.name} moved.`);
      });
      return m;
    })
  ).addTo(_map);
}

function _setWaypointsVisible(v) {
  _waypointsVisible = v;
  localStorage.setItem('audiochart-waypoints-visible', String(v));
  _refreshWaypointLayer();
}
import { formatPositionDisplay, bearingToWords, bearingToDisplay, formatDistance, distanceToDisplay, trueTomagnetic, magneticVariation } from './utils.js';

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

// Show every TTS utterance in the response area so the user can read along.
TTS.onSpeak(text => { responseEl.textContent = text; });

let serverUrl = null;  // set in init(); used by offline button and test-position API

async function _runWhereAmI(lat, lon) {
  let response = Query.whereAmI(lat, lon);
  if (serverUrl && response?.text && /^\d+\s+degrees/.test(response.text)) {
    try {
      const r = await fetch(`${serverUrl}/api/nearest-landmark?lat=${lat}&lon=${lon}`,
        { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const lm = await r.json();
        const dir = Query.compassDir(lm.bearing_deg);
        const dist = Query.naturalDist(lm.dist_nm);
        response = { text: `${dist} ${dir} of ${lm.name}`, speech: `${dist} ${dir} of ${lm.name}.` };
      }
    } catch (_) {}
  }
  const txt = response?.text ?? response ?? 'No named places found nearby.';
  showResponse(txt);
  TTS.sayImmediate(response?.speech ?? txt);
}

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
let _navaidFilterLayer = null;
let _bearingAccumulator = [];   // persists bearing lines across successive bearing queries
let _waypointLayer = null;
let _boatLayer = null;
let _youLayer = null;
let _boatCircleDismissed = false;  // true after user taps the boat once
let _waypointsVisible = localStorage.getItem('audiochart-waypoints-visible') === 'true';
let _leafletReady = false;
let _depthHeatLayer = null;  // leaflet.heat layer for depth blobs (managed separately)
let _mudflatLayer   = null;  // tidal flat polygons (valsou < 0, always exposed)
let _channelLayer   = null;  // channel corridor polygons (managed separately)
let _soundingsLayer = null;  // depth sounding point labels
let _tideHeight    = 0;      // meters above MLLW; 0 = unknown/fallback
let _tideOffset    = 0;      // hours offset from real time for preview slider; 0 = live
let _tidePlayInterval = null;  // setInterval ID while tide animation is playing
let _tideLastFetch = 0;      // Date.now() of last successful fetch
let _tideStationId  = null;  // cached nearest NOAA station ID
let _tideStationLat = null;  // boat lat used for that station search
let _tideStationLon = null;
let _tideExtremes     = null;  // [{time:Date, height:Number, type:'H'|'L'}, …] around now
let _tideExtremesFetch = 0;    // Date.now() of last successful predictions fetch
let _tideCycleEl      = null;  // DOM element of the _TideCycle control, redrawn on a timer
let _currentStationId   = null;
let _currentStationLat  = null;
let _currentStationLon  = null;
let _currentStationName = null;
let _currentExtremes    = null;  // [{time,speed,type,floodDir,ebbDir}] around now
let _currentExtFetch    = 0;
let _currentStationsCache = null;  // session-cached full station list
let _currentArrowLayer  = null;
let _showCurrentArrows  = false;
const _stationPredCache = new Map();  // stationId → {extremes, fetchTime}

// ── Offline persistence keys ──────────────────────────────────────────────────
const _AC_TIDE_KEY     = 'ac_tide_offline';
const _AC_CUR_KEY      = 'ac_current_offline';
const _AC_STATIONS_KEY = 'ac_current_stations';
const _AC_PRED_KEY     = 'ac_pred_cache';

function _loadOfflineCache() {
  try {
    const t = JSON.parse(localStorage.getItem(_AC_TIDE_KEY));
    if (t?.extremes?.length) {
      _tideStationId = t.stationId; _tideStationLat = t.stationLat; _tideStationLon = t.stationLon;
      _tideExtremes = t.extremes.map(e => ({ height: e.height, type: e.type, time: new Date(e.ms) }));
      _tideExtremesFetch = t.extremesFetch;
    }
  } catch {}
  try {
    const c = JSON.parse(localStorage.getItem(_AC_CUR_KEY));
    if (c?.extremes?.length) {
      _currentStationId = c.stationId; _currentStationLat = c.stationLat;
      _currentStationLon = c.stationLon; _currentStationName = c.stationName;
      _currentExtremes = c.extremes.map(e => ({ speed: e.speed, type: e.type, floodDir: e.floodDir, ebbDir: e.ebbDir, time: new Date(e.ms) }));
      _currentExtFetch = c.extFetch;
    }
  } catch {}
  try {
    const s = JSON.parse(localStorage.getItem(_AC_STATIONS_KEY));
    if (Array.isArray(s) && s.length) _currentStationsCache = s;
  } catch {}
  try {
    const p = JSON.parse(localStorage.getItem(_AC_PRED_KEY));
    if (p) for (const [id, v] of Object.entries(p)) {
      if (v?.extremes?.length)
        _stationPredCache.set(id, { extremes: v.extremes.map(e => ({ speed: e.speed, type: e.type, floodDir: e.floodDir, ebbDir: e.ebbDir, time: new Date(e.ms) })), fetchTime: v.fetchTime });
    }
  } catch {}
}

function _saveTideOffline() {
  if (!_tideExtremes?.length || !_tideStationId) return;
  try {
    localStorage.setItem(_AC_TIDE_KEY, JSON.stringify({
      stationId: _tideStationId, stationLat: _tideStationLat, stationLon: _tideStationLon,
      extremes: _tideExtremes.map(e => ({ height: e.height, type: e.type, ms: e.time.getTime() })),
      extremesFetch: _tideExtremesFetch
    }));
  } catch {}
}

function _saveCurrentOffline() {
  if (!_currentExtremes?.length || !_currentStationId) return;
  try {
    localStorage.setItem(_AC_CUR_KEY, JSON.stringify({
      stationId: _currentStationId, stationLat: _currentStationLat,
      stationLon: _currentStationLon, stationName: _currentStationName,
      extremes: _currentExtremes.map(e => ({ speed: e.speed, type: e.type, floodDir: e.floodDir, ebbDir: e.ebbDir, ms: e.time.getTime() })),
      extFetch: _currentExtFetch
    }));
  } catch {}
}

function _saveStationsOffline() {
  if (!_currentStationsCache?.length) return;
  try {
    localStorage.setItem(_AC_STATIONS_KEY, JSON.stringify(
      _currentStationsCache.map(s => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }))
    ));
  } catch {}
}

function _savePredCacheOffline() {
  if (!_stationPredCache.size) return;
  try {
    const obj = {};
    for (const [id, v] of _stationPredCache.entries())
      obj[id] = { extremes: v.extremes.map(e => ({ speed: e.speed, type: e.type, floodDir: e.floodDir, ebbDir: e.ebbDir, ms: e.time.getTime() })), fetchTime: v.fetchTime };
    localStorage.setItem(_AC_PRED_KEY, JSON.stringify(obj));
  } catch {}
}

async function _prefetchTideCurrentForOffline(lat, lon, onProgress) {
  // Tide station + 72h prediction extremes
  try {
    onProgress?.('Tide predictions…');
    const sResp = await fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels');
    const { stations: tStations } = await sResp.json();
    let best = null, bestDist = Infinity;
    for (const s of tStations) {
      const d = Query.distanceNm(lon, lat, parseFloat(s.lng), parseFloat(s.lat));
      if (d < bestDist) { bestDist = d; best = s; }
    }
    _tideStationId = best.id; _tideStationLat = parseFloat(best.lat); _tideStationLon = parseFloat(best.lng);
    const now = new Date();
    const begin = new Date(now.getTime() - 24 * 3600000);
    const end   = new Date(now.getTime() + 48 * 3600000);
    const pResp = await fetch(
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${_tideStationId}` +
      `&product=predictions&datum=MLLW&time_zone=GMT&units=metric&interval=hilo&format=json` +
      `&begin_date=${_tideDateStr(begin)}&end_date=${_tideDateStr(end)}`
    );
    const extremes = ((await pResp.json())?.predictions || [])
      .map(p => ({ time: new Date(p.t.replace(' ', 'T') + ':00Z'), height: parseFloat(p.v), type: p.type === 'L' ? 'L' : 'H' }))
      .filter(e => isFinite(e.height) && isFinite(e.time.getTime()));
    if (extremes.length >= 2) { _tideExtremes = extremes; _tideExtremesFetch = Date.now(); }
    _saveTideOffline();
  } catch (e) { console.warn('[offline] tide prefetch', e); }

  // Current stations list
  try {
    onProgress?.('Current stations list…');
    if (!_currentStationsCache) {
      const r = await fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=currentpredictions&units=english');
      _currentStationsCache = (await r.json()).stations || [];
    }
    _saveStationsOffline();
  } catch (e) { console.warn('[offline] stations prefetch', e); }

  // Current widget station + 72h predictions
  try {
    onProgress?.('Current predictions…');
    await _ensureCurrentStation(lat, lon);
    if (_currentStationId) {
      const now = new Date();
      const begin = new Date(now.getTime() - 24 * 3600000);
      const end   = new Date(now.getTime() + 48 * 3600000);
      const r = await fetch(
        `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${_currentStationId}` +
        `&product=currents_predictions&time_zone=GMT&units=english&interval=MAX_SLACK&format=json` +
        `&begin_date=${_tideDateStr(begin)}&end_date=${_tideDateStr(end)}`
      );
      const events = ((await r.json())?.current_predictions?.cp || [])
        .map(p => ({ time: new Date(p.Time.replace(' ', 'T') + ':00Z'), speed: Math.abs(parseFloat(p.Velocity_Major) || 0), type: p.Type, floodDir: parseFloat(p.meanFloodDir) || 0, ebbDir: parseFloat(p.meanEbbDir) || 0 }))
        .filter(e => isFinite(e.time.getTime()));
      if (events.length >= 2) { _currentExtremes = events; _currentExtFetch = Date.now(); }
      _saveCurrentOffline();
    }
  } catch (e) { console.warn('[offline] current widget prefetch', e); }

  // Current arrow predictions for stations within 20nm
  if (_currentStationsCache) {
    try {
      const nearby = _currentStationsCache
        .map(s => ({ s, d: Query.distanceNm(lon, lat, parseFloat(s.lng), parseFloat(s.lat)) }))
        .filter(x => x.d <= 20).sort((a, b) => a.d - b.d).slice(0, 20).map(x => x.s);
      onProgress?.(`Current arrows (${nearby.length} stations)…`);
      await Promise.allSettled(nearby.map(s => _fetchStationCurrents(s.id)));
      _savePredCacheOffline();
    } catch (e) { console.warn('[offline] arrow stations prefetch', e); }
  }
}
let _activeCruiseName = 'Penobscot Bay';  // updated when user selects a region
let _markerByKey = new Map();
let _sketchMode      = false;
let _sketchPath      = null;
let _sketchWaypoints = [];
let _sketchRubber    = null;
let _sketchCursorLL  = null;
let _editMode              = false;
let _editRouteName         = null;
let _editRouteIdx          = -1;
let _editPoints            = [];
let _editVertexMarkers     = [];
let _editSegmentLayers     = [];
let _populateRouteSelectFn = null; // set by _ensureMap once DOM is ready
let _savedRoutesLayer  = null;
let _extendingRouteIdx = -1;
let _extendingFromEnd  = true;
let _lastAutoPanTime   = 0;
let _animMode = false;
let _animRafId = null;
let _animIntervalId = null;
let _animMarker = null;
let _animRouteLine    = null;
let _previewRouteLine = null;
let _animClickHandler = null;
let _animTraveled     = 0;
let _baseTileLayer    = null;
let _seamarkLayer     = null;
let _chartMode        = localStorage.getItem('audiochart-chart-mode') === 'chart';
let _seamarksVisible  = localStorage.getItem('audiochart-seamarksVisible') !== 'false';
let _animReportLayer   = null;
let _animMilestoneLayer = null;
let _animFollowMode = false;
let _animCurrentLat = null;
let _animCurrentLon = null;
let _lastCourseFrom = null;
let _lastCourseTo   = null;

async function loadLeaflet() {
  if (_leafletReady) return;
  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
  const base = serverUrl ? `${serverUrl}/js/lib` : './js/lib';
  await loadScript(`${base}/leaflet.js`);
  await loadScript(`${base}/leaflet-heat.js`);
  _leafletReady = true;
}

function setStatus(msg) { statusEl.textContent = msg; }

window._debugDepth = () => {
  const feats = Query.hazards?.features || [];
  const shallow = feats.filter(f => f.properties.label === 'shallow area');
  console.log('total hazard features:', feats.length);
  console.log('shallow area features:', shallow.length);
  if (shallow.length) {
    console.log('sample geometry types:', [...new Set(shallow.map(f=>f.geometry.type))]);
    console.log('sample valsou values:', shallow.slice(0,5).map(f=>f.properties.valsou));
  }
  console.log('tide height (m):', _tideHeight);
  console.log('draft (m):', _getDraftMeters());
};

// ── Map / list focus toggle ───────────────────────────────────────────────────
const _mapContainer = document.getElementById('map-container');
// Clicking the response area (list) → list expands, map shrinks
document.getElementById('response-area').addEventListener('click', () => {
  if (_mapContainer.classList.contains('map-compact'))
    _mapContainer.classList.add('list-focus');
});
// Touching/clicking the map → expand map to full height, release text input
function _expandMap() {
  _mapContainer.classList.remove('list-focus', 'input-focus', 'map-compact');
  textInput.blur();
  if (_map) setTimeout(() => _map.invalidateSize(), 260);
}
_mapContainer.addEventListener('mousedown', _expandMap);
_mapContainer.addEventListener('touchstart', _expandMap, { passive: true });

// Text input focus → collapse map so input area has full space
textInput.addEventListener('focus', () =>
  _mapContainer.classList.add('input-focus'));
textInput.addEventListener('blur', () => {
  _mapContainer.classList.remove('input-focus');
  if (_map) setTimeout(() => _map.invalidateSize(), 260);
});
function showResponse(text) {
  responseEl.textContent = text;
  navaidListEl.style.display = 'none';
  navaidListEl.innerHTML = '';
  _mapContainer.classList.remove('map-compact', 'list-focus');
}

function showNavaidList(navaids) {
  _mapContainer.classList.add('map-compact');
  _mapContainer.classList.remove('list-focus');
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
    row.addEventListener('click', () => {
      TTS.sayImmediate(`${base}, bearing ${bearingToWords(n.brg)}, ${formatDistance(n.d)}.`);
      if (n.lat != null && n.lon != null) flashMarker(n.lat, n.lon);
    });
    navaidListEl.appendChild(row);
  }
  navaidListEl.style.display = 'flex';
}

// ── Sketch route ─────────────────────────────────────────────────────────────

const _appEl = document.getElementById('app');
const _sketchBanner = document.getElementById('sketch-banner');

// ── Saved-route persistent display ────────────────────────────────────────────

function _routeEndpointIcon() {
  return L.divIcon({ className: 'route-endpoint-marker', iconSize: [14, 14], iconAnchor: [7, 7] });
}

function _refreshSavedRouteLayers() {
  if (!_map) return;
  if (_savedRoutesLayer) {
    _savedRoutesLayer.clearLayers();
  } else {
    _savedRoutesLayer = L.layerGroup();
  }
  if (_sketchMode || _editMode) return; // hidden during drawing/editing
  _savedRoutesLayer.addTo(_map);

  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  routes.forEach((route, routeIdx) => {
    if (!route.points || route.points.length < 1) return;
    const lls = route.points.map(p => [p.lat, p.lon]);

    L.polyline(lls, { color: '#e05252', weight: 3, opacity: 0.7, interactive: false })
      .addTo(_savedRoutesLayer);

    const addEndpointMarker = (pt, fromEnd) => {
      const m = L.marker([pt.lat, pt.lon], { icon: _routeEndpointIcon() }).addTo(_savedRoutesLayer);
      m.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const btnId = `ext-btn-${routeIdx}-${fromEnd ? 'end' : 'start'}`;
        const popup = L.popup({ closeButton: true })
          .setLatLng(m.getLatLng())
          .setContent(`<button id="${btnId}" style="padding:4px 10px;cursor:pointer;">Add to route</button>`)
          .openOn(_map);
        setTimeout(() => {
          const btn = document.getElementById(btnId);
          if (btn) btn.addEventListener('click', () => { _map.closePopup(popup); _enterExtendMode(routeIdx, fromEnd); });
        }, 0);
      });
    };

    addEndpointMarker(route.points[0], false);
    if (route.points.length > 1) addEndpointMarker(route.points[route.points.length - 1], true);
  });
}

// ── Sketch auto-pan ────────────────────────────────────────────────────────────

function _sketchCheckAutoPan(latlng) {
  const now = Date.now();
  if (now - _lastAutoPanTime < 500) return;
  const sz = _map.getSize();
  const pt = _map.latLngToContainerPoint(latlng);
  const thresh = 0.15;
  const panAmt = 1 / 3;
  let dx = 0, dy = 0;
  if      (pt.x < sz.x * thresh)          dx = -Math.round(sz.x * panAmt);
  else if (pt.x > sz.x * (1 - thresh))    dx = +Math.round(sz.x * panAmt);
  if      (pt.y < sz.y * thresh)          dy = -Math.round(sz.y * panAmt);
  else if (pt.y > sz.y * (1 - thresh))    dy = +Math.round(sz.y * panAmt);
  if (dx !== 0 || dy !== 0) {
    _map.panBy([dx, dy], { animate: true, duration: 0.25 });
    _lastAutoPanTime = now;
  }
}

// ── Extend existing route from endpoint ───────────────────────────────────────

function _enterExtendMode(routeIdx, fromEnd) {
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const route  = routes[routeIdx];
  if (!route || !route.points.length) return;

  _extendingRouteIdx = routeIdx;
  _extendingFromEnd  = fromEnd;

  let pts = route.points.map(p => L.latLng(p.lat, p.lon));
  if (!fromEnd) pts = pts.slice().reverse();
  _sketchWaypoints = pts;

  if (_sketchPath) _map.removeLayer(_sketchPath);
  _sketchPath = L.polyline(pts, {
    color: '#e05252', weight: 4, opacity: 0.9, lineJoin: 'round', lineCap: 'round',
  }).addTo(_map);

  _enterSketchMode();
}

// Touch handler refs so they can be removed on exit
let _sketchTouchStart = null;
let _sketchTouchMove  = null;
let _sketchTouchEnd   = null;

function _sketchAddWaypoint(latlng) {
  _sketchWaypoints.push(latlng);
  if (_sketchWaypoints.length === 1) {
    // First waypoint of a new session — discard any leftover path from the previous sketch.
    if (_sketchPath) { _map.removeLayer(_sketchPath); }
    _sketchPath = L.polyline([latlng], {
      color: '#e05252', weight: 4, opacity: 0.9, lineJoin: 'round', lineCap: 'round',
    }).addTo(_map);
  } else {
    _sketchPath.setLatLngs(_sketchWaypoints);
  }
  _sketchUpdateRubber(latlng);
}

function _sketchUpdateRubber(cursorLL) {
  if (_sketchWaypoints.length === 0) return;
  const last = _sketchWaypoints[_sketchWaypoints.length - 1];
  if (!_sketchRubber) {
    _sketchRubber = L.polyline([last, cursorLL], {
      color: '#e05252', weight: 2, opacity: 0.5, dashArray: '6 6',
    }).addTo(_map);
  } else {
    _sketchRubber.setLatLngs([last, cursorLL]);
  }
}

function _enterSketchMode() {
  _sketchMode = true;
  document.getElementById('map-container').style.display = 'block';
  _appEl.classList.add('sketch-mode');
  _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
  _sketchBanner.style.display = 'flex';
  if (!_map) return;
  _map.invalidateSize();
  _map.dragging.disable();
  if (_savedRoutesLayer) _map.removeLayer(_savedRoutesLayer);

  // Mobile: touch handlers in capture phase so they fire before Leaflet's own handlers.
  // touchstart/touchmove update rubber-band; touchend commits the waypoint.
  const container = _map.getContainer();

  _sketchTouchStart = (e) => {
    if (!_sketchMode) return;
    e.preventDefault();
    e.stopPropagation();
    const t = e.touches[0];
    const r = container.getBoundingClientRect();
    _sketchCursorLL = _map.containerPointToLatLng(L.point(t.clientX - r.left, t.clientY - r.top));
    _sketchUpdateRubber(_sketchCursorLL);
  };
  _sketchTouchMove = (e) => {
    if (!_sketchMode) return;
    e.preventDefault();
    e.stopPropagation();
    const t = e.touches[0];
    const r = container.getBoundingClientRect();
    _sketchCursorLL = _map.containerPointToLatLng(L.point(t.clientX - r.left, t.clientY - r.top));
    _sketchUpdateRubber(_sketchCursorLL);
    _sketchCheckAutoPan(_sketchCursorLL);
  };
  _sketchTouchEnd = (e) => {
    if (!_sketchMode || !_sketchCursorLL) return;
    e.stopPropagation();
    _sketchAddWaypoint(_sketchCursorLL);
  };

  container.addEventListener('touchstart', _sketchTouchStart, { passive: false, capture: true });
  container.addEventListener('touchmove',  _sketchTouchMove,  { passive: false, capture: true });
  container.addEventListener('touchend',   _sketchTouchEnd,   { capture: true });

  // Desktop: click adds waypoint, mousemove updates rubber-band, dblclick finishes.
  // dblclick fires after two clicks; the second click adds a spurious waypoint we pop.
  _map.on('click',     _onSketchClick);
  _map.on('mousemove', _onSketchMouseMove);
  _map.on('dblclick',  _onSketchDblClick);
}

function _exitSketchMode() {
  _sketchMode = false;
  _appEl.classList.remove('sketch-mode');
  _sketchBanner.style.display = 'none';
  if (_map) {
    const container = _map.getContainer();
    if (_sketchTouchStart) container.removeEventListener('touchstart', _sketchTouchStart, { capture: true });
    if (_sketchTouchMove)  container.removeEventListener('touchmove',  _sketchTouchMove,  { capture: true });
    if (_sketchTouchEnd)   container.removeEventListener('touchend',   _sketchTouchEnd,   { capture: true });
    _sketchTouchStart = _sketchTouchMove = _sketchTouchEnd = null;
    _map.off('click',     _onSketchClick);
    _map.off('mousemove', _onSketchMouseMove);
    _map.off('dblclick',  _onSketchDblClick);
    _map.dragging.enable();
    _map.invalidateSize();
  }
  if (_sketchRubber) { _map.removeLayer(_sketchRubber); _sketchRubber = null; }
  if (_sketchPath)   { _map.removeLayer(_sketchPath);   _sketchPath   = null; }
  _sketchWaypoints = [];
  _sketchCursorLL  = null;
  _extendingRouteIdx = -1;
  _extendingFromEnd  = true;
  _refreshSavedRouteLayers();
}

function _onSketchClick(e) {
  _sketchAddWaypoint(e.latlng);
}

function _onSketchMouseMove(e) {
  _sketchUpdateRubber(e.latlng);
  _sketchCheckAutoPan(e.latlng);
}

function _onSketchDblClick(e) {
  // The second click of the dblclick already added a spurious waypoint — pop it.
  if (_sketchWaypoints.length > 0) _sketchWaypoints.pop();
  _finishSketch();
}

const ROUTE_KEY = 'audiochart-user-routes';

function _nextRouteName() {
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  return `Route ${routes.length + 1}`;
}

function _saveRoute(name, points) {
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  routes.push({ name, points: points.map(p => ({ lat: p.lat, lon: p.lng })) });
  localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
}

function _finishSketch() {
  const pts         = _sketchWaypoints.slice();
  const extIdx      = _extendingRouteIdx;  // capture before _exitSketchMode resets them
  const extFromEnd  = _extendingFromEnd;
  _exitSketchMode(); // resets _extendingRouteIdx/-FromEnd and calls _refreshSavedRouteLayers
  if (pts.length > 1) {
    let totalNm = 0;
    for (let i = 1; i < pts.length; i++) {
      totalNm += Query.distanceNm(
        pts[i - 1].lng, pts[i - 1].lat,
        pts[i].lng,     pts[i].lat
      );
    }
    if (extIdx >= 0) {
      const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
      const route  = routes[extIdx];
      if (route) {
        const finalPts = extFromEnd ? pts : pts.slice().reverse();
        route.points = finalPts.map(p => ({ lat: p.lat, lon: p.lng }));
        localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
        const msg = `${route.name} updated — ${totalNm.toFixed(1)} nm`;
        setStatus(msg);
        TTS.sayImmediate(msg);
      }
    } else {
      const name = _nextRouteName();
      _saveRoute(name, pts);
      const msg = `${name} saved — ${totalNm.toFixed(1)} nm`;
      setStatus(msg);
      TTS.sayImmediate(msg);
    }
    _refreshSavedRouteLayers();
  }
}

document.getElementById('sketch-done-btn').addEventListener('click', _finishSketch);
document.getElementById('sketch-cancel-btn').addEventListener('click', _exitSketchMode);

// ── Route edit mode ────────────────────────────────────────────────────────────

function _editVertexIcon() {
  return L.divIcon({
    className: 'edit-vertex-marker',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function _clearEditLayers() {
  _editVertexMarkers.forEach(m => _map.removeLayer(m));
  _editSegmentLayers.forEach(s => _map.removeLayer(s));
  _editVertexMarkers = [];
  _editSegmentLayers = [];
}

function _renderEditLayers() {
  _clearEditLayers();
  const pts = _editPoints;

  // Segment polylines — one per adjacent pair, wider for easier clicking
  for (let i = 0; i < pts.length - 1; i++) {
    const ptA = [pts[i].lat, pts[i].lon];
    const ptB = [pts[i + 1].lat, pts[i + 1].lon];
    const seg = L.polyline([ptA, ptB], {
      color: '#e05252', weight: 6, opacity: 0.85, interactive: true,
    }).addTo(_map);
    seg.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      _onEditSegmentClick(e, i);
    });
    _editSegmentLayers.push(seg);
  }

  // Vertex markers — draggable, one per waypoint
  for (let i = 0; i < pts.length; i++) {
    const idx = i;
    const m = L.marker([pts[idx].lat, pts[idx].lon], {
      icon: _editVertexIcon(),
      draggable: true,
      zIndexOffset: 1000,
    }).addTo(_map);
    m.on('drag', () => {
      const ll = m.getLatLng();
      _editPoints[idx] = { lat: ll.lat, lon: ll.lng };
      if (idx > 0) {
        _editSegmentLayers[idx - 1].setLatLngs([
          [_editPoints[idx - 1].lat, _editPoints[idx - 1].lon],
          [ll.lat, ll.lng],
        ]);
      }
      if (idx < _editPoints.length - 1) {
        _editSegmentLayers[idx].setLatLngs([
          [ll.lat, ll.lng],
          [_editPoints[idx + 1].lat, _editPoints[idx + 1].lon],
        ]);
      }
    });
    _editVertexMarkers.push(m);
  }
}

function _onEditSegmentClick(e, segIdx) {
  if (_editPoints.length <= 2) return; // nothing useful to remove
  const click = e.latlng;
  const ptA = _editPoints[segIdx];
  const ptB = _editPoints[segIdx + 1];
  const dA = click.distanceTo(L.latLng(ptA.lat, ptA.lon));
  const dB = click.distanceTo(L.latLng(ptB.lat, ptB.lon));
  const removeIdx = dA <= dB ? segIdx : segIdx + 1;

  const popup = L.popup({ closeButton: true, className: 'edit-remove-popup' })
    .setLatLng(e.latlng)
    .setContent('<button id="edit-remove-wp-btn" style="padding:4px 10px;cursor:pointer;">Remove waypoint</button>')
    .openOn(_map);

  // Wire button after popup is in DOM
  setTimeout(() => {
    const btn = document.getElementById('edit-remove-wp-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        _map.closePopup(popup);
        _editPoints.splice(removeIdx, 1);
        _renderEditLayers();
      });
    }
  }, 0);
}

function _enterEditMode(routeIdx) {
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const route = routes[routeIdx];
  if (!route) return;

  _editMode = true;
  _editRouteIdx = routeIdx;
  _editRouteName = route.name;
  _editPoints = route.points.map(p => ({ lat: p.lat, lon: p.lon }));

  document.getElementById('edit-banner-label').textContent = route.name;
  document.getElementById('edit-banner').style.display = 'flex';
  _appEl.classList.add('edit-mode');
  _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
  if (_map) {
    _map.invalidateSize();
    _map.dragging.disable();
    if (_savedRoutesLayer) _map.removeLayer(_savedRoutesLayer);
    _renderEditLayers();
  }
}

function _exitEditMode() {
  _editMode = false;
  _editRouteName = null;
  _editRouteIdx = -1;
  _editPoints = [];
  if (_map) {
    _clearEditLayers();
    _map.closePopup();
    _map.dragging.enable();
    _map.invalidateSize();
  }
  document.getElementById('edit-banner').style.display = 'none';
  _appEl.classList.remove('edit-mode');
  _refreshSavedRouteLayers();
}

function _saveEditedRoute() {
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  if (!routes[_editRouteIdx]) { _exitEditMode(); return; }
  routes[_editRouteIdx].points = _editPoints.map(p => ({ lat: p.lat, lon: p.lon }));
  localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
  const name = _editRouteName || 'Route';
  _exitEditMode(); // calls _refreshSavedRouteLayers
  _populateRouteSelectFn?.();
  const msg = `${name} saved.`;
  setStatus(msg);
  TTS.sayImmediate(msg);
}

document.getElementById('edit-save-btn').addEventListener('click', _saveEditedRoute);
document.getElementById('edit-cancel-btn').addEventListener('click', _exitEditMode);

// ── GPX export ────────────────────────────────────────────────────────────────

function _downloadGpx(points, routeName) {
  const trkpts = points.map(p => {
    const iso = new Date(p.t).toISOString();
    return `    <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><time>${iso}</time></trkpt>`;
  }).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="AudioChart">
  <trk>
    <name>${routeName}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
  const blob = new Blob([xml], { type: 'application/gpx+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${routeName.replace(/\s+/g, '_')}.gpx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Route animation ───────────────────────────────────────────────────────────

const _animBanner     = document.getElementById('anim-banner');
const _animBannerText = document.getElementById('anim-banner-text');

// ── Nautical chart display helpers ───────────────────────────────────────────

const _NAVAID_SYMBOL = { buoy: '◆', light: '✦', beacon: '▲', hazard: '⚠', restriction: '⛔', waypoint: '⚓', place: '📍', coord: '✕' };

function _navaidIcon(type, color, label) {
  const sym = _NAVAID_SYMBOL[type] || '●';
  const html = label != null
    ? `<div style="background:#fff;color:${color};font-weight:bold;font-size:12px;min-width:22px;height:22px;padding:0 3px;border-radius:11px;border:2px solid ${color};display:flex;align-items:center;justify-content:center;gap:2px;box-shadow:0 1px 4px rgba(0,0,0,.6);white-space:nowrap">${sym} ${label}</div>`
    : `<div style="background:#fff;color:${color};font-size:14px;width:24px;height:24px;border-radius:50%;border:2.5px solid ${color};display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.6)">${sym}</div>`;
  return L.divIcon({ className: '', html, iconSize: null, iconAnchor: [12, 12] });
}

function _bearingLineLabel(fromLat, fromLon, toLat, toLon, brgMag, distNm, color) {
  const midLat = (fromLat + toLat) / 2;
  const midLon = (fromLon + toLon) / 2;
  const brgStr = `${Math.round(brgMag).toString().padStart(3, '0')}°M`;
  const distStr = distNm < 0.1 ? `${Math.round(distNm * 2000) / 2} yd`
                : distNm < 1   ? `${Math.round(distNm * 10) / 10} nm`
                :                `${Math.round(distNm * 10) / 10} nm`;
  const html = `<div style="color:${color};font-size:11px;font-weight:bold;white-space:nowrap;text-shadow:0 0 3px #000,0 0 3px #000,0 0 3px #000;line-height:1.3;transform:translate(-50%,-50%)">${brgStr}<br>${distStr}</div>`;
  return L.marker([midLat, midLon], {
    icon: L.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] }),
    interactive: false,
  });
}

function _getDraftMeters() {
  const el = document.getElementById('nf-draft-ft');
  const raw = el ? parseFloat(el.value) : parseFloat(localStorage.getItem('audiochart-draft-ft') || '');
  return isFinite(raw) && raw > 0 ? raw * 0.3048 : null;
}

async function _ensureTideStation(lat, lon) {
  if (!_tideStationId || _tideStationLat === null ||
      Query.distanceNm(lon, lat, _tideStationLon, _tideStationLat) >= 10) {
    const resp = await fetch(
      'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels'
    );
    const { stations } = await resp.json();
    let best = null, bestDist = Infinity;
    for (const s of stations) {
      const d = Query.distanceNm(lon, lat, parseFloat(s.lng), parseFloat(s.lat));
      if (d < bestDist) { bestDist = d; best = s; }
    }
    _tideStationId  = best.id;
    _tideStationLat = parseFloat(best.lat);
    _tideStationLon = parseFloat(best.lng);
  }
  return _tideStationId;
}

async function _ensureCurrentStation(lat, lon) {
  if (_currentStationId && _currentStationLat !== null &&
      Query.distanceNm(lon, lat, _currentStationLon, _currentStationLat) < 10) {
    return _currentStationId;
  }
  if (!_currentStationsCache) {
    const resp = await fetch(
      'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=currentpredictions&units=english'
    );
    _currentStationsCache = (await resp.json()).stations || [];
    _saveStationsOffline();
  }
  let best = null, bestDist = Infinity;
  for (const s of _currentStationsCache) {
    const d = Query.distanceNm(lon, lat, parseFloat(s.lng), parseFloat(s.lat));
    if (d < bestDist) { bestDist = d; best = s; }
  }
  if (!best) return null;
  _currentStationId   = best.id;
  _currentStationLat  = parseFloat(best.lat);
  _currentStationLon  = parseFloat(best.lng);
  _currentStationName = best.name;
  return _currentStationId;
}

async function _fetchTideHeight(lat, lon) {
  const TEN_MIN = 10 * 60 * 1000;
  const tideStatus = document.getElementById('nf-tide-status');
  const setStatus = (msg) => { if (tideStatus) tideStatus.textContent = msg; };

  // Re-use cached reading if recent and boat hasn't moved far
  if (_tideStationId && _tideLastFetch && Date.now() - _tideLastFetch < TEN_MIN) {
    if (_tideStationLat !== null) {
      const d = Query.distanceNm(lon, lat, _tideStationLon, _tideStationLat);
      if (d < 10) return _tideHeight;
    }
  }

  setStatus('Fetching tide…');
  try {
    await _ensureTideStation(lat, lon);

    // Fetch current water level at that station
    const wlResp = await fetch(
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
      `?station=${_tideStationId}&product=water_level&datum=MLLW` +
      `&time_zone=GMT&units=metric&date=latest&format=json`
    );
    const wlData = await wlResp.json();
    const v = parseFloat(wlData?.data?.[0]?.v);
    if (!isFinite(v)) throw new Error('bad reading');
    _tideHeight    = v;
    _tideLastFetch = Date.now();
    const sign = v >= 0 ? '+' : '';
    setStatus(`Tide: ${sign}${v.toFixed(2)} m (MLLW)`);
  } catch {
    if (_tideExtremes?.length >= 2) {
      const phase = _tidePhaseAt(new Date());
      if (phase) {
        _tideHeight = phase.height;
        const sign = _tideHeight >= 0 ? '+' : '';
        setStatus(`Tide: ${sign}${_tideHeight.toFixed(2)} m (cached)`);
        return _tideHeight;
      }
    }
    setStatus('Tide: offline (using MLLW)');
  }
  return _tideHeight;
}

function _tideDateStr(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Fetches the high/low tide predictions bracketing "now" so the cycle widget
// can draw a sinusoid anchored to real extremes (NOAA only gives us the
// current observed level via _fetchTideHeight — not the cycle shape).
async function _fetchTideCycle(lat, lon) {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (_tideExtremes && _tideExtremesFetch && Date.now() - _tideExtremesFetch < SIX_HOURS) {
    if (_tideStationLat !== null) {
      const d = Query.distanceNm(lon, lat, _tideStationLon, _tideStationLat);
      if (d < 10) return _tideExtremes;
    }
  }

  try {
    await _ensureTideStation(lat, lon);

    const now   = new Date();
    const begin = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const end   = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const resp = await fetch(
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
      `?station=${_tideStationId}&product=predictions&datum=MLLW` +
      `&time_zone=GMT&units=metric&interval=hilo&format=json` +
      `&begin_date=${_tideDateStr(begin)}&end_date=${_tideDateStr(end)}`
    );
    const data = await resp.json();
    const extremes = (data?.predictions || []).map(p => ({
      time:   new Date(p.t.replace(' ', 'T') + ':00Z'),
      height: parseFloat(p.v),
      type:   p.type === 'L' ? 'L' : 'H',
    })).filter(e => isFinite(e.height) && isFinite(e.time.getTime()));
    if (extremes.length < 2) throw new Error('not enough extremes');
    _tideExtremes      = extremes;
    _tideExtremesFetch = Date.now();
    _saveTideOffline();
  } catch {
    // Keep any previously cached extremes — a slightly stale curve beats none.
  }
  return _tideExtremes;
}

async function _fetchCurrentCycle(lat, lon) {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (_currentExtremes && _currentExtFetch && Date.now() - _currentExtFetch < SIX_HOURS) {
    if (_currentStationLat !== null &&
        Query.distanceNm(lon, lat, _currentStationLon, _currentStationLat) < 10) {
      return _currentExtremes;
    }
  }
  try {
    await _ensureCurrentStation(lat, lon);
    if (!_currentStationId) return null;
    const now   = new Date();
    const begin = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const end   = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const resp = await fetch(
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
      `?station=${_currentStationId}&product=currents_predictions` +
      `&time_zone=GMT&units=english&interval=MAX_SLACK&format=json` +
      `&begin_date=${_tideDateStr(begin)}&end_date=${_tideDateStr(end)}`
    );
    const data = await resp.json();
    const events = (data?.current_predictions?.cp || []).map(p => ({
      time:     new Date(p.Time.replace(' ', 'T') + ':00Z'),
      speed:    Math.abs(parseFloat(p.Velocity_Major) || 0),
      type:     p.Type,  // 'flood' | 'ebb' | 'slack'
      floodDir: parseFloat(p.meanFloodDir) || 0,
      ebbDir:   parseFloat(p.meanEbbDir)   || 0,
    })).filter(e => isFinite(e.time.getTime()));
    if (events.length < 2) throw new Error('not enough current events');
    _currentExtremes = events;
    _currentExtFetch = Date.now();
    _saveCurrentOffline();
  } catch {
    // Keep any previously cached data
  }
  return _currentExtremes;
}

// Where `at` sits between the two cached extremes that bracket it: phase 0..1
// running prev→next, plus the cosine-interpolated height at that instant.
function _tidePhaseAt(at) {
  if (!_tideExtremes || _tideExtremes.length < 2) return null;
  const t = at.getTime();
  let prev = null, next = null;
  for (let i = 0; i < _tideExtremes.length - 1; i++) {
    if (_tideExtremes[i].time.getTime() <= t && t <= _tideExtremes[i + 1].time.getTime()) {
      prev = _tideExtremes[i];
      next = _tideExtremes[i + 1];
      break;
    }
  }
  if (!prev) {
    if (t < _tideExtremes[0].time.getTime()) { prev = _tideExtremes[0]; next = _tideExtremes[1]; }
    else { prev = _tideExtremes[_tideExtremes.length - 2]; next = _tideExtremes[_tideExtremes.length - 1]; }
  }
  const span  = next.time.getTime() - prev.time.getTime();
  const phase = span > 0 ? Math.min(1, Math.max(0, (t - prev.time.getTime()) / span)) : 0;
  const mid   = (prev.height + next.height) / 2;
  const amp   = (prev.height - next.height) / 2;
  return { prev, next, phase, height: mid + amp * Math.cos(Math.PI * phase) };
}

function _currentAtExtremes(extremes, at) {
  if (!extremes || extremes.length < 2) return null;
  const t = at.getTime();
  let prev = null, next = null;
  for (let i = 0; i < extremes.length - 1; i++) {
    if (extremes[i].time.getTime() <= t && t <= extremes[i + 1].time.getTime()) {
      prev = extremes[i]; next = extremes[i + 1]; break;
    }
  }
  if (!prev) {
    if (t < extremes[0].time.getTime()) { prev = extremes[0]; next = extremes[1]; }
    else { prev = extremes[extremes.length - 2]; next = extremes[extremes.length - 1]; }
  }
  const span  = next.time.getTime() - prev.time.getTime();
  const phase = span > 0 ? Math.min(1, Math.max(0, (t - prev.time.getTime()) / span)) : 0;
  const speed = (prev.speed + next.speed) / 2 + (prev.speed - next.speed) / 2 * Math.cos(Math.PI * phase);
  const dominantType = prev.type !== 'slack' ? prev.type : next.type !== 'slack' ? next.type : 'slack';
  const type = speed < 0.05 ? 'slack' : dominantType;
  const floodDir = prev.floodDir || next.floodDir;
  const ebbDir   = prev.ebbDir   || next.ebbDir;
  const dir = type === 'flood' ? floodDir : type === 'ebb' ? ebbDir : floodDir;
  const nextEvent = extremes.find(e => e.time.getTime() > t);
  return { speed, type, dir, nextEvent };
}

function _currentAt(at) {
  return _currentAtExtremes(_currentExtremes, at);
}

async function _fetchStationCurrents(stationId) {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const cached = _stationPredCache.get(stationId);
  if (cached && Date.now() - cached.fetchTime < SIX_HOURS) return cached.extremes;
  try {
    const now   = new Date();
    const begin = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const end   = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const resp = await fetch(
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
      `?station=${stationId}&product=currents_predictions` +
      `&time_zone=GMT&units=english&interval=MAX_SLACK&format=json` +
      `&begin_date=${_tideDateStr(begin)}&end_date=${_tideDateStr(end)}`
    );
    const data = await resp.json();
    const events = (data?.current_predictions?.cp || []).map(p => ({
      time:     new Date(p.Time.replace(' ', 'T') + ':00Z'),
      speed:    Math.abs(parseFloat(p.Velocity_Major) || 0),
      type:     p.Type,
      floodDir: parseFloat(p.meanFloodDir) || 0,
      ebbDir:   parseFloat(p.meanEbbDir)   || 0,
    })).filter(e => isFinite(e.time.getTime()));
    _stationPredCache.set(stationId, { extremes: events, fetchTime: Date.now() });
    return events;
  } catch {
    return cached?.extremes || [];
  }
}

function _makeCurrentArrowIcon(speed, dir, type) {
  const scale = Math.min(1.5, Math.max(0.55, speed * 0.8 + 0.3));
  const color = '#ff8800';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60">
    <g transform="translate(30,30) rotate(${dir}) scale(${scale.toFixed(2)})" opacity="0.88">
      <polygon points="0,-22 -8,-10 8,-10" fill="${color}"/>
      <line x1="0" y1="-10" x2="0" y2="14" stroke="${color}" stroke-width="3" stroke-linecap="round"/>
      <line x1="-9" y1="16" x2="9" y2="16" stroke="${color}" stroke-width="3" stroke-linecap="round"/>
    </g>
  </svg>`;
  return L.divIcon({ html: svg, iconSize: [60, 60], iconAnchor: [30, 30], className: '' });
}

function _renderCurrentArrows() {
  if (!_showCurrentArrows || !_map || !_currentStationsCache) return;
  if (_currentArrowLayer) { _map.removeLayer(_currentArrowLayer); _currentArrowLayer = null; }
  const center = _map.getCenter();
  const nearby = _currentStationsCache
    .map(s => ({ s, d: Query.distanceNm(center.lng, center.lat, parseFloat(s.lng), parseFloat(s.lat)) }))
    .filter(x => x.d <= 20)
    .sort((a, b) => a.d - b.d).slice(0, 20).map(x => x.s);
  const sim = new Date(Date.now() + _tideOffset * 3_600_000);
  const markers = [];
  for (const station of nearby) {
    const cached = _stationPredCache.get(station.id);
    if (!cached?.extremes?.length) continue;
    const cur = _currentAtExtremes(cached.extremes, sim);
    if (!cur || cur.speed < 0.05) continue;
    markers.push(
      L.marker([parseFloat(station.lat), parseFloat(station.lng)], {
        icon: _makeCurrentArrowIcon(cur.speed, cur.dir, cur.type),
        interactive: true, keyboard: false,
      }).bindTooltip(
        `${cur.speed.toFixed(1)} kt ${cur.type}<br><span style="color:#8a9ab0;font-size:0.85em">${station.name}</span>`,
        { className: 'map-tooltip' }
      )
    );
  }
  if (markers.length) _currentArrowLayer = L.layerGroup(markers).addTo(_map);
}

async function _fetchAndRenderCurrentArrows() {
  if (!_showCurrentArrows || !_map) return;
  if (!_currentStationsCache) {
    try {
      const resp = await fetch(
        'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=currentpredictions&units=english'
      );
      _currentStationsCache = (await resp.json()).stations || [];
      _saveStationsOffline();
    } catch { return; }
  }
  const center = _map.getCenter();
  const nearby = _currentStationsCache
    .map(s => ({ s, d: Query.distanceNm(center.lng, center.lat, parseFloat(s.lng), parseFloat(s.lat)) }))
    .filter(x => x.d <= 20)
    .sort((a, b) => a.d - b.d).slice(0, 20).map(x => x.s);
  const toFetch = nearby.filter(s => {
    const c = _stationPredCache.get(s.id);
    return !c || Date.now() - c.fetchTime > 6 * 60 * 60 * 1000;
  });
  if (toFetch.length) {
    await Promise.all(toFetch.map(s => _fetchStationCurrents(s.id)));
    _savePredCacheOffline();
  }
  _renderCurrentArrows();
}

function _dirArrow(deg) {
  const dirs = ['↑','↗','→','↘','↓','↙','←','↖'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

function _fmtDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

// Renders the tide-cycle widget as inline SVG: a translucent sinusoid spanning
// roughly one tidal cycle around `now`, a dot marking the current position on
// it, and a one-line rising/falling readout. Falls back to a quiet placeholder
// when no prediction data is available yet (no GPS fix / NOAA unreachable).
function _tideCycleSvg(now) {
  const W = 132, H = 64;
  const frame = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8" fill="rgba(12,25,45,0.5)" stroke="rgba(42,80,128,0.8)"/>
    ${inner}
  </svg>`;

  const ph = _tidePhaseAt(now);
  if (!ph) {
    return frame(`<text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" fill="#8a9ab0" font-family="Arial,sans-serif" font-size="10">Tide: --</text>`);
  }

  // Show the bracketing pair plus one extreme on either side — about one cycle
  const idx  = _tideExtremes.indexOf(ph.prev);
  const segs = _tideExtremes.slice(Math.max(0, idx - 1), Math.min(_tideExtremes.length, idx + 3));

  const tMin = segs[0].time.getTime();
  const tMax = segs[segs.length - 1].time.getTime();
  const hMin = Math.min(...segs.map(s => s.height));
  const hMax = Math.max(...segs.map(s => s.height));
  const hSpan = Math.max(0.1, hMax - hMin);

  const padX = 6, padY = 7, labelH = 13;
  const plotW = W - padX * 2, plotH = H - padY * 2 - labelH;
  const xAt = (t) => padX + ((t - tMin) / (tMax - tMin)) * plotW;
  const yAt = (h) => padY + (1 - (h - hMin) / hSpan) * plotH;

  const SAMPLES = 10;
  const pts = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i], b = segs[i + 1];
    const span = b.time.getTime() - a.time.getTime();
    const mid  = (a.height + b.height) / 2;
    const amp  = (a.height - b.height) / 2;
    for (let s = (i === 0 ? 0 : 1); s <= SAMPLES; s++) {
      const frac = s / SAMPLES;
      pts.push([
        xAt(a.time.getTime() + frac * span),
        yAt(mid + amp * Math.cos(Math.PI * frac)),
      ]);
    }
  }
  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const baseY = (padY + plotH).toFixed(1);
  const areaD = `${pathD} L${pts[pts.length - 1][0].toFixed(1)},${baseY} L${pts[0][0].toFixed(1)},${baseY} Z`;

  const rising = ph.next.type === 'H';
  const arrow  = rising ? '▲' : '▼';
  const label  = `${arrow} ${rising ? 'High' : 'Low'} in ${_fmtDuration(ph.next.time.getTime() - now.getTime())}`;
  const labelColor = rising ? '#52c052' : '#e0a030';

  return frame(`
    <path d="${areaD}" fill="rgba(74,158,221,0.16)" stroke="none"/>
    <path d="${pathD}" fill="none" stroke="rgba(74,158,221,0.7)" stroke-width="1.5"/>
    <circle cx="${xAt(now.getTime()).toFixed(1)}" cy="${yAt(ph.height).toFixed(1)}" r="3" fill="#e8edf4" stroke="#4a9edd" stroke-width="1.5"/>
    <text x="${W / 2}" y="${H - 4}" text-anchor="middle" fill="${labelColor}" font-family="Arial,sans-serif" font-size="9" font-weight="bold">${label}</text>
  `);
}

function _effectiveTideHeight() {
  if (_tideOffset === 0) return _tideHeight;
  const sim = new Date(Date.now() + _tideOffset * 3_600_000);
  return _tidePhaseAt(sim)?.height ?? _tideHeight;
}

function _onTideSlider(e) {
  _stopTidePlay();
  _tideOffset = parseFloat(e.target.value);
  _redrawTideCycle();
  _refreshNavaidOverlay();
  if (_showCurrentArrows) _renderCurrentArrows();
}

function _stopTidePlay() {
  if (!_tidePlayInterval) return;
  clearInterval(_tidePlayInterval);
  _tidePlayInterval = null;
  const btn = _tideCycleEl?.querySelector('#tide-play-btn');
  if (btn) btn.textContent = '▶';
}

function _startTidePlay() {
  if (_tidePlayInterval) { _stopTidePlay(); return; }
  const slider = _tideCycleEl?.querySelector('#tide-offset-slider');
  const btn = _tideCycleEl?.querySelector('#tide-play-btn');
  if (btn) btn.textContent = '⏸';
  _tidePlayInterval = setInterval(() => {
    _tideOffset += 0.5;
    if (_tideOffset > 24) _tideOffset = 0;
    if (slider) slider.value = _tideOffset;
    _redrawTideCycle();
    _refreshNavaidOverlay();
    if (_showCurrentArrows) _renderCurrentArrows();
  }, 500);
}

function _redrawTideCycle() {
  if (!_tideCycleEl) return;
  const sim = new Date(Date.now() + _tideOffset * 3_600_000);
  const wrapper = _tideCycleEl.querySelector('.tide-svg-wrapper');
  if (wrapper) wrapper.innerHTML = _tideCycleSvg(sim);
  const lbl = _tideCycleEl.querySelector('.tide-offset-label');
  if (lbl) lbl.textContent = _tideOffset === 0 ? 'now'
    : (_tideOffset > 0 ? '+' : '−') + _fmtDuration(Math.abs(_tideOffset) * 3_600_000);

}

window._debugTideCycle = () => {
  console.log('station:', _tideStationId, _tideStationLat, _tideStationLon);
  console.log('extremes:', _tideExtremes);
  const ph = _tidePhaseAt(new Date());
  console.log('phase at now:', ph);
};

function _updateBearingLines(lat, lon) {
  for (const entry of _bearingAccumulator) {
    if (!entry._polyline) continue;
    const { destLat, destLon } = entry.result;
    entry._polyline.setLatLngs([[lat, lon], [destLat, destLon]]);
    if (entry._labelMarker) {
      const newBrg = trueTomagnetic(Query.bearing(lon, lat, destLon, destLat));
      const newDist = Query.distanceNm(lon, lat, destLon, destLat);
      entry._labelMarker.setLatLng([(lat + destLat) / 2, (lon + destLon) / 2]);
      const el = entry._labelMarker.getElement();
      if (el) {
        const brgStr = `${Math.round(newBrg).toString().padStart(3, '0')}°M`;
        const distStr = newDist < 0.1 ? `${Math.round(newDist * 2000) / 2} yd` : `${Math.round(newDist * 10) / 10} nm`;
        el.innerHTML = `<div style="color:${entry._color};font-size:11px;font-weight:bold;white-space:nowrap;text-shadow:0 0 3px #000,0 0 3px #000,0 0 3px #000;line-height:1.3;transform:translate(-50%,-50%)">${brgStr}<br>${distStr}</div>`;
      }
    }
  }
}

function _exitAnimMode() {
  if (_map) _map.off('click', _exitAnimMode);
  if (_map && _animClickHandler) { _map.off('click', _animClickHandler); _animClickHandler = null; }
  _animMode = false;
  _animFollowMode = false;
  _animCurrentLat = null;
  _animCurrentLon = null;
  if (_animRafId)      { cancelAnimationFrame(_animRafId); _animRafId = null; }
  if (_animIntervalId) { clearInterval(_animIntervalId);   _animIntervalId = null; }
  TTS.stop();
  _appEl.classList.remove('anim-mode');
  _animBanner.style.display = 'none';
  if (_animMarker       && _map) { _map.removeLayer(_animMarker);       _animMarker       = null; }
  if (_animRouteLine    && _map) { _map.removeLayer(_animRouteLine);    _animRouteLine    = null; }
  if (_animReportLayer   && _map) { _map.removeLayer(_animReportLayer);   _animReportLayer   = null; }
  if (_animMilestoneLayer && _map) { _map.removeLayer(_animMilestoneLayer); _animMilestoneLayer = null; }
  if (_previewRouteLine && _map) { _map.removeLayer(_previewRouteLine); _previewRouteLine = null; }
  if (_map) { _map.dragging.enable(); _map.invalidateSize(); }
}

document.getElementById('anim-stop-btn').addEventListener('click', _exitAnimMode);

function _getTrackSettings() {
  const objChip      = document.querySelector('.track-obj.selected');
  const distChip     = document.querySelector('.track-dist.selected');
  const compressChip = document.querySelector('.track-compress.selected');
  const zoomChip     = document.querySelector('.track-zoom.selected');
  const visChip      = document.querySelector('.track-visibility.selected');
  return {
    filter:     objChip      ? (objChip.dataset.obj || null)         : null,
    radiusNm:   distChip     ? parseFloat(distChip.dataset.nm)       : 0.25,
    compress:   compressChip ? parseInt(compressChip.dataset.compress) : 1,
    zoom:       zoomChip?.dataset.zoom ? parseInt(zoomChip.dataset.zoom) : null,
    visibility: visChip      ? parseFloat(visChip.dataset.nm)        : 2,
    record:   document.getElementById('track-record-checkbox')?.checked || false,
    milestoneNm: (() => {
      const cb = document.getElementById('track-milestone-checkbox');
      const inp = document.getElementById('track-milestone-input');
      return (cb?.checked && inp) ? parseFloat(inp.value) || null : null;
    })(),
  };
}

function _startRouteAnimation(route, speedKnots) {
  if (!_map) return;
  const track = _getTrackSettings();

  _animMode = true;
  _appEl.classList.add('anim-mode');
  _animBannerText.textContent = `⛵ ${route.name} · ${speedKnots} kts`;
  _animBanner.style.display = 'flex';
  document.getElementById('map-container').style.display = 'block';
  _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
  _map.invalidateSize();

  const pts = route.points.map(p => [p.lat, p.lon]);
  _animRouteLine = L.polyline(pts, {
    color: '#e05252', weight: 3, opacity: 0.7, dashArray: '8 4',
  }).addTo(_map);
  if (track.zoom) _map.setView(pts[0], track.zoom);
  else            _map.fitBounds(L.latLngBounds(pts).pad(0.25));

  // Pre-compute segments with cumulative distance
  const segs = [];
  let cumDist = 0;
  for (let i = 1; i < route.points.length; i++) {
    const p1 = route.points[i - 1], p2 = route.points[i];
    const d = Query.distanceNm(p1.lon, p1.lat, p2.lon, p2.lat);
    segs.push({ lat1: p1.lat, lon1: p1.lon, lat2: p2.lat, lon2: p2.lon, dist: d, cumDist });
    cumDist += d;
  }
  const totalNm = cumDist;

  const _initBearing = segs.length ? _segBearing(segs[0].lat1, segs[0].lon1, segs[0].lat2, segs[0].lon2) : 0;
  _animMarker = L.marker(pts[0], { icon: _animBoatIcon(_initBearing), zIndexOffset: 1000 }).addTo(_map);
  _animCurrentLat = pts[0][0];
  _animCurrentLon = pts[0][1];

  // Apply time compression: 1× = real time, 10× = 10 min sailing per real sec, etc.
  const compress    = track.compress || 1;
  const nmPerRealSec = (speedKnots / 3600) * compress;
  const sailTotalMin = Math.round(totalNm / speedKnots * 60); // actual sailing minutes
  const compressLabel = compress > 1 ? ` · ${compress}×` : '';

  // Prime TTS in the user-gesture call stack so iOS allows timer-triggered speech later.
  // Boat won't start moving until both parts of the announcement finish.
  const milesText = `${Math.round(totalNm * 10) / 10} nautical miles.`;
  TTS.sayImmediate(`Animating ${route.name}.`, () => {
    if (!_animMode) return;
    setTimeout(() => {
      if (!_animMode) return;
      TTS.sayImmediate(milesText, () => {
        if (!_animMode) return;
        _animRafId = requestAnimationFrame(step);
      });
    }, 400);
  });

  // Object layer for click-based reports
  _animReportLayer    = L.layerGroup().addTo(_map);
  _animMilestoneLayer = L.layerGroup().addTo(_map);
  _animTraveled = 0;

  // Recording setup: collect one sample per real second, timestamped by simulated sailing time
  const recordStart  = Date.now();
  const recordPoints = track.record ? [] : null;
  let   lastRecordElapsed = -1;

  // Milestone reporting: speak closest tracked object every N miles
  let lastMilestoneNm = 0;

  // Tap map during animation → stop boat, show nearby objects, tap again to resume
  function _onAnimStop() {
    _map.off('click', _onAnimStop);
    _animClickHandler = null;
    if (_animRafId) { cancelAnimationFrame(_animRafId); _animRafId = null; }

    const navResult = Query.navaidsInRadius(_animCurrentLat, _animCurrentLon, track.radiusNm, track.filter);
    const hazResult = !track.filter
      ? Query.hazardsInRadius(_animCurrentLat, _animCurrentLon, track.radiusNm)
      : null;

    _animReportLayer.clearLayers();
    for (const n of (Query.lastNavaidResults || [])) {
      const m = L.marker([n.lat, n.lon], { icon: _navaidMarkerIcon(n) });
      _animReportLayer.addLayer(m);
      _highlightAndSpeak(m, null, null, null); // just flash, speech handled below
    }
    for (const h of (Query.lastHazardResults || [])) {
      const m = L.marker([h.lat, h.lon], { icon: _hazardMarkerIcon() });
      _animReportLayer.addLayer(m);
      _highlightAndSpeak(m, null, null, null);
    }

    const speech = [navResult?.speech, hazResult?.speech].filter(Boolean).join('. ') || 'All clear.';
    TTS.sayImmediate(speech);
    _animBannerText.textContent = `⛵ Stopped · tap map to resume`;

    _map.once('click', () => {
      _animReportLayer.clearLayers();
      _animBannerText.textContent = `⛵ ${route.name} · ${speedKnots} kts${compressLabel}`;
      _animClickHandler = _onAnimStop;
      _map.on('click', _onAnimStop);
      _animRafId = requestAnimationFrame((now) => {
        startTime = now - (_animTraveled / nmPerRealSec * 1000);
        step(now);
      });
    });
  }
  _animClickHandler = _onAnimStop;
  _map.on('click', _onAnimStop);

  // Delay RAF start to let the DOM/map settle after entering fullscreen
  let startTime = null;
  function step(now) {
    if (!_animMode) return;
    if (startTime === null) startTime = now; // anchor to first frame
    const elapsed  = (now - startTime) / 1000;
    const traveled = elapsed * nmPerRealSec;
    _animTraveled  = traveled;

    if (traveled >= totalNm) {
      if (_animClickHandler) { _map.off('click', _animClickHandler); _animClickHandler = null; }
      _animMarker.setLatLng(pts[pts.length - 1]);
      _animBannerText.textContent = `✓ ${route.name} complete · ${sailTotalMin} min sailing · tap map to dismiss`;
      _map.stop();
      setTimeout(() => {
        _map.invalidateSize();
        _map.flyToBounds(L.latLngBounds(pts).pad(0.1), { duration: 1.5 });
      }, 150);
      if (recordPoints) {
        const finalT = recordStart + Math.round(totalNm / speedKnots * 3600 * 1000);
        const last = pts[pts.length - 1];
        recordPoints.push({ lat: last[0], lon: last[1], t: finalT });
        _downloadGpx(recordPoints, route.name);
      }
      _map.once('click', _exitAnimMode);
      return;
    }

    // Interpolate position on route
    let seg = segs[segs.length - 1];
    for (const s of segs) {
      if (traveled >= s.cumDist && traveled < s.cumDist + s.dist) { seg = s; break; }
    }
    const frac = seg.dist > 0 ? (traveled - seg.cumDist) / seg.dist : 0;
    const lat  = seg.lat1 + (seg.lat2 - seg.lat1) * frac;
    const lon  = seg.lon1 + (seg.lon2 - seg.lon1) * frac;
    _animMarker.setLatLng([lat, lon]);
    _animCurrentLat = lat;
    _animCurrentLon = lon;

    // Record one sample per real second
    if (recordPoints && Math.floor(elapsed) > lastRecordElapsed) {
      lastRecordElapsed = Math.floor(elapsed);
      const sailedSec = Math.round(traveled / speedKnots * 3600);
      recordPoints.push({ lat, lon, t: recordStart + sailedSec * 1000 });
    }

    // Milestone report: pause boat, draw bearing lines, speak two fixes, then resume
    if (track.milestoneNm && traveled - lastMilestoneNm >= track.milestoneNm) {
      lastMilestoneNm += track.milestoneNm * Math.floor((traveled - lastMilestoneNm) / track.milestoneNm);
      const fixes = Query.nearestNavaids(lat, lon, track.filter, true, 2, track.visibility ?? 2);
      console.log('[AC] milestone fixes:', fixes.length, fixes.map(f => `lat=${f.lat.toFixed(6)} lon=${f.lon.toFixed(6)}`));
      if (fixes.length > 0) {
        const colors  = ['#f5a623', '#4dd0e1'];
        const weights = [4, 2];
        if (_animMilestoneLayer) {
          _animMilestoneLayer.clearLayers();
          const allPoints = [[lat, lon]];
          fixes.forEach((fix, i) => {
            const c = colors[i];
            console.log(`[AC] line ${i}: boat=[${lat.toFixed(6)},${lon.toFixed(6)}] fix=[${fix.lat.toFixed(6)},${fix.lon.toFixed(6)}]`);
            _animMilestoneLayer.addLayer(L.polyline([[lat, lon], [fix.lat, fix.lon]], {
              color: c, weight: weights[i], dashArray: i === 1 ? '6 4' : null, opacity: 0.95,
            }));
            _animMilestoneLayer.addLayer(L.marker([fix.lat, fix.lon], { icon: _navaidIcon(fix.type, c) }));
            if (fix.brg != null && fix.distNm != null) {
              _animMilestoneLayer.addLayer(_bearingLineLabel(lat, lon, fix.lat, fix.lon, fix.brg, fix.distNm, c));
            }
            allPoints.push([fix.lat, fix.lon]);
          });
          console.log('[AC] milestone layer child count:', _animMilestoneLayer.getLayers().length);
          // Always zoom to fit all objects as tight as possible
          _map.fitBounds(L.latLngBounds(allPoints).pad(0.12));
        }
        const savedBanner = _animBannerText.textContent;
        _animBannerText.textContent = `⛵ Reporting…`;
        const resume = () => {
          setTimeout(() => {
            if (!_animMode) return;
            _animBannerText.textContent = savedBanner;
            _animRafId = requestAnimationFrame((now) => {
              startTime = now - (_animTraveled / nmPerRealSec * 1000);
              step(now);
            });
          }, 500);
        };
        // Compute inter-bearing angle and build debug speech
        let angleSpeech = '';
        if (fixes.length >= 2) {
          const arc = Math.abs(((fixes[1].brg - fixes[0].brg + 180 + 360) % 360) - 180);
          const arcRounded = Math.round(arc);
          const valid = arc >= 60 && arc <= 120;
          angleSpeech = `Angle between fixes: ${arcRounded} degrees. ${valid ? 'Good fix.' : 'ERROR: angle out of range.'}`;
          console.log(`[AC] fix angle: ${arcRounded}° (${valid ? 'OK' : 'OUT OF RANGE 60-120'})`);
        } else {
          angleSpeech = 'No valid fix. No pair with 60 to 120 degree separation within visibility range.';
          console.log('[AC] No valid fix pair found within visibility range.');
        }
        // Linger 1.5s so user can see both lines before speech starts
        setTimeout(() => {
          if (!_animMode) return;
          if (fixes.length >= 2) {
            TTS.sayImmediate(fixes[0].speech, () => {
              setTimeout(() => TTS.sayImmediate(fixes[1].speech, () => {
                setTimeout(() => TTS.sayImmediate(angleSpeech, resume), 300);
              }), 400);
            });
          } else {
            TTS.sayImmediate(fixes[0].speech, () => {
              setTimeout(() => TTS.sayImmediate(angleSpeech, resume), 300);
            });
          }
        }, 1500);
        return; // pause until speech + delay complete
      }
    }

    const bearing = _segBearing(seg.lat1, seg.lon1, seg.lat2, seg.lon2);
    const boatEl  = _animMarker.getElement()?.querySelector('.anim-boat');
    if (boatEl) boatEl.style.transform = `rotate(${bearing - 90}deg)`;

    if (track.zoom) {
      const b = _map.getBounds();
      const latSpan = b.getNorthEast().lat - b.getSouthWest().lat;
      const lonSpan = b.getNorthEast().lng - b.getSouthWest().lng;
      const margin  = 0.2;
      const inView  = lat > b.getSouthWest().lat + latSpan * margin &&
                      lat < b.getNorthEast().lat - latSpan * margin &&
                      lon > b.getSouthWest().lng + lonSpan * margin &&
                      lon < b.getNorthEast().lng - lonSpan * margin;
      if (!inView) _map.setView([lat, lon], track.zoom, { animate: true, duration: 0.5 });
    }

    const sailMinLeft = Math.round((totalNm - traveled) / speedKnots * 60);
    const realMinLeft = compress > 1 ? ` (${Math.round(sailMinLeft / compress)} real min)` : '';
    _animBannerText.textContent = `⛵ ${route.name} · ${speedKnots} kts${compressLabel} · ${sailMinLeft}/${sailTotalMin} min${realMinLeft}`;

    _animRafId = requestAnimationFrame(step);
  }
  // Let the anim-mode CSS take effect and map resize before speech ends
  setTimeout(() => { _map.invalidateSize(); }, 300);
}

function _startFollowMode(route) {
  // Non-test mode: pan map to real GPS position on every fix
  _animFollowMode = true;
  _animMode = true;
  _appEl.classList.add('anim-mode');
  _animBannerText.textContent = '⛵ Following real GPS position';
  _animBanner.style.display = 'flex';
  document.getElementById('map-container').style.display = 'block';
  _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
  _map.invalidateSize();

  if (route) {
    const pts = route.points.map(p => [p.lat, p.lon]);
    _animRouteLine = L.polyline(pts, {
      color: '#e05252', weight: 3, opacity: 0.7, dashArray: '8 4',
    }).addTo(_map);
  }
}

// ── User waypoints (localStorage) ────────────────────────────────────────────

const USER_WP_KEY = 'audiochart-user-waypoints';

function loadUserWaypoints() {
  try { return JSON.parse(localStorage.getItem(USER_WP_KEY) || '[]'); } catch { return []; }
}

function nextWaypointName() {
  const nums = loadUserWaypoints()
    .map(w => parseInt(w.name.replace(/\D/g, ''), 10))
    .filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return 'wp' + String(next).padStart(3, '0');
}

function saveUserWaypoint(name, lat, lon) {
  const wps = loadUserWaypoints();
  wps.push({ name, lat, lon });
  localStorage.setItem(USER_WP_KEY, JSON.stringify(wps));
  Query.mergeUserWaypoints([{ name, lat, lon }]);
  _refreshWaypointLayer();
}

function _highlightAndSpeak(marker, displayText, speechText, onEnd) {
  if (displayText) showResponse(displayText);
  const el = marker.getElement?.();
  if (el) {
    el.classList.add('marker-speaking');
    if (_map && !_map.getBounds().contains(marker.getLatLng())) {
      _map.panTo(marker.getLatLng());
    }
  }
  if (speechText) {
    TTS.sayImmediate(speechText, () => {
      if (el) el.classList.remove('marker-speaking');
      if (onEnd) onEnd();
    });
  } else {
    // Flash-only call (no speech text) — just do a quick flash
    if (el) {
      el.classList.remove('marker-speaking');
      el.classList.add('marker-flash');
      el.addEventListener('animationend', () => el.classList.remove('marker-flash'), { once: true });
    }
  }
}

// ── Map ───────────────────────────────────────────────────────────────────────

function _applyMapLayer() {
  if (!_map) return;
  if (_baseTileLayer) { _map.removeLayer(_baseTileLayer); _baseTileLayer = null; }
  if (_seamarkLayer)  { _map.removeLayer(_seamarkLayer);  _seamarkLayer  = null; }
  if (_chartMode) {
    _baseTileLayer = L.tileLayer(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { minZoom: 4, maxZoom: 17, attribution: '© OpenStreetMap contributors' }
    ).addTo(_map);
    if (_seamarksVisible) {
      _seamarkLayer = L.tileLayer(
        'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
        { minZoom: 7, maxZoom: 17, attribution: '© OpenSeaMap contributors', opacity: 0.9 }
      ).addTo(_map);
    }
  } else {
    _baseTileLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { minZoom: 4, maxZoom: 17, attribution: '© Esri' }
    ).addTo(_map);
  }
}

function _syncLayerBtn() {
  const btn = document.getElementById('map-layer-btn');
  if (!btn) return;
  btn.textContent = _chartMode ? '🛰' : '🗺';
  btn.title       = _chartMode ? 'Switch to satellite' : 'Switch to chart';
}

function _syncSeamarkBtn() {
  const btn = document.getElementById('seamark-toggle-btn');
  if (!btn) return;
  btn.title = _seamarksVisible ? 'Hide seamarks' : 'Show seamarks';
  btn.classList.toggle('active', !_seamarksVisible);
}

function _ensureMap() {
  if (_map) return;
  _map = L.map('leaflet-map', { zoomControl: false, attributionControl: true });
  _map.setView([44.1018, -69.0752], 11);  // Rockland Harbor — default until GPS arrives
  _applyMapLayer();
  _syncLayerBtn();
  _syncSeamarkBtn();
  _refreshSavedRouteLayers();

  // Zoom slider (desktop only — hidden by CSS on mobile)
  const _zoomSlider = document.getElementById('zoom-slider');
  const _zoomLabel  = document.getElementById('zoom-slider-label');
  const _syncZoomSlider = () => {
    const z = _map.getZoom();
    _zoomSlider.value = z;
    _zoomLabel.textContent = z;
  };
  _zoomSlider.addEventListener('input', () => _map.setZoom(parseInt(_zoomSlider.value, 10)));
  _map.on('zoomend', _syncZoomSlider);
  _syncZoomSlider();

  // Compass rose overlay
  const _CompassRose = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const el = L.DomUtil.create('div', 'compass-rose-ctrl');
      L.DomEvent.disableClickPropagation(el);
      const pt = (r, deg) => {
        const a = (deg - 90) * Math.PI / 180;
        return [+(Math.cos(a) * r).toFixed(2), +(Math.sin(a) * r).toFixed(2)];
      };
      let ticks = '';
      for (let d = 0; d < 360; d += 5) {
        const major = d % 10 === 0;
        const [x1, y1] = pt(major ? 61 : 64, d);
        const [x2, y2] = pt(68, d);
        ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${major ? '#6a9bbf' : '#3a5a70'}" stroke-width="${major ? 1.2 : 0.7}"/>`;
      }
      const cardinals = new Set([0, 90, 180, 270]);
      let nums = '';
      for (let d = 0; d < 360; d += 30) {
        if (cardinals.has(d)) continue;
        const [x, y] = pt(55, d);
        nums += `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" fill="#99bbcc" font-family="Arial,sans-serif" font-size="7.5">${d}</text>`;
      }
      // magneticVariation is negative for westerly (e.g. -15 in Penobscot Bay).
      // rotate(variation) tilts N left toward magnetic north.
      const magRot = magneticVariation;
      el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="-70 -70 140 140">
        <circle r="68" fill="rgba(12,25,45,0.85)" stroke="#4a9edd" stroke-width="1.5"/>
        <g transform="rotate(${magRot})">
          ${ticks}
          ${nums}
          <polygon points="0,0 -7,-14 0,-40 7,-14" fill="#e05252"/>
          <polygon points="0,0 -7,14 0,40 7,14" fill="rgba(210,210,210,0.88)"/>
          <polygon points="0,0 14,-7 40,0 14,7" fill="rgba(210,210,210,0.88)"/>
          <polygon points="0,0 -14,-7 -40,0 -14,7" fill="rgba(210,210,210,0.88)"/>
          <polygon points="0,0 -3,-8 17,-17 8,-3" fill="rgba(160,160,160,0.55)"/>
          <polygon points="0,0 8,3 17,17 3,8" fill="rgba(160,160,160,0.55)"/>
          <polygon points="0,0 3,8 -17,17 -8,3" fill="rgba(160,160,160,0.55)"/>
          <polygon points="0,0 -8,-3 -17,-17 -3,-8" fill="rgba(160,160,160,0.55)"/>
          <text x="0" y="-47" text-anchor="middle" dominant-baseline="middle" fill="#e05252" font-family="Arial,sans-serif" font-size="11" font-weight="bold">N</text>
          <text x="0" y="50" text-anchor="middle" dominant-baseline="middle" fill="#ccc" font-family="Arial,sans-serif" font-size="11" font-weight="bold">S</text>
          <text x="50" y="0" text-anchor="middle" dominant-baseline="middle" fill="#ccc" font-family="Arial,sans-serif" font-size="11" font-weight="bold">E</text>
          <text x="-50" y="0" text-anchor="middle" dominant-baseline="middle" fill="#ccc" font-family="Arial,sans-serif" font-size="11" font-weight="bold">W</text>
          <circle r="5" fill="#1a3a5c" stroke="#4a9edd" stroke-width="2"/>
        </g>
      </svg>`;
      return el;
    },
  });
  new _CompassRose().addTo(_map);

  // Tide-cycle overlay — translucent sinusoid showing where "now" sits in the
  // current tide cycle. Mirrors the compass rose: a small always-on, click-
  // through L.Control so it never gets in the way of map interaction.
  const _TideCycle = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const el = L.DomUtil.create('div', 'tide-cycle-ctrl');
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      el.innerHTML = `
        <div class="tide-svg-wrapper"></div>
        <div class="tide-slider-row">
          <input type="range" id="tide-offset-slider" min="-6" max="24" step="0.25" value="0">
          <div class="tide-play-row">
            <button id="tide-play-btn">&#9654;</button>
            <div class="tide-offset-label">now</div>
          </div>
        </div>`;
      _tideCycleEl = el;
      const slider = el.querySelector('#tide-offset-slider');
      slider.addEventListener('input', _onTideSlider);
      slider.addEventListener('dblclick', (ev) => {
        ev.target.value = 0;
        _tideOffset = 0;
        _stopTidePlay();
        _redrawTideCycle();
        _refreshNavaidOverlay();
      });
      el.querySelector('#tide-play-btn').addEventListener('click', (ev) => {
        ev.stopPropagation();
        _startTidePlay();
      });
      _redrawTideCycle();
      return el;
    },
  });
  new _TideCycle().addTo(_map);

  // Redraw the "now" dot every minute (cheap — pure math against cached
  // extremes); refresh the predictions themselves only when the boat has
  // moved far enough to need a new station, or the cache has gone stale
  // (handled inside _fetchTideCycle's own TTL/distance check).
  const _refreshTideCycle = () => {
    const pos = GPS.getPosition();
    if (pos) {
      Promise.all([
        _fetchTideCycle(pos.lat, pos.lon),
        _fetchCurrentCycle(pos.lat, pos.lon),
      ]).then(_redrawTideCycle);
    } else {
      _redrawTideCycle();
    }
  };
  _refreshTideCycle();
  setInterval(_refreshTideCycle, 60 * 1000);

  document.getElementById('map-layer-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    _chartMode = !_chartMode;
    localStorage.setItem('audiochart-chart-mode', _chartMode ? 'chart' : 'satellite');
    _applyMapLayer();
    _syncLayerBtn();
  });

  document.getElementById('seamark-toggle-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    _seamarksVisible = !_seamarksVisible;
    localStorage.setItem('audiochart-seamarksVisible', String(_seamarksVisible));
    _applyMapLayer();
    _syncSeamarkBtn();
  });

  // ⚓ Navaid filter panel
  const _navaidFilterBtn   = document.getElementById('navaid-filter-btn');
  const _navaidFilterPanel = document.getElementById('navaid-filter-panel');
  const _closeNavaidPanel = () => {
    _navaidFilterPanel.classList.remove('open');
    _navaidFilterBtn.classList.remove('active');
  };
  _navaidFilterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _navaidFilterPanel.classList.toggle('open');
    _navaidFilterBtn.classList.toggle('active', _navaidFilterPanel.classList.contains('open'));
  });
  document.getElementById('nf-close').addEventListener('click', _closeNavaidPanel);
  _map.on('click', _closeNavaidPanel);
  document.getElementById('nf-refresh').addEventListener('click', () => {
    _refreshNavaidOverlay();
  });
  document.getElementById('nf-clear').addEventListener('click', () => {
    if (_navaidFilterLayer) { _map?.removeLayer(_navaidFilterLayer); _navaidFilterLayer = null; }
    if (_depthHeatLayer)    { _map?.removeLayer(_depthHeatLayer);    _depthHeatLayer = null; }
    if (_mudflatLayer)      { _map?.removeLayer(_mudflatLayer);      _mudflatLayer   = null; }
    if (_currentArrowLayer) { _map?.removeLayer(_currentArrowLayer); _currentArrowLayer = null; }
    _navaidFilterPanel.classList.remove('open');
    _navaidFilterBtn.classList.remove('active');
  });

  // Currents checkbox
  document.getElementById('nf-currents').addEventListener('change', function () {
    _showCurrentArrows = this.checked;
    if (_showCurrentArrows) _fetchAndRenderCurrentArrows();
    else if (_currentArrowLayer) { _map.removeLayer(_currentArrowLayer); _currentArrowLayer = null; }
  });
  _map.on('moveend', () => { if (_showCurrentArrows) _fetchAndRenderCurrentArrows(); });

  // Depths checkbox — show/hide settings and trigger tide fetch + overlay refresh
  const _depthCheckbox  = document.getElementById('nf-depth');
  const _depthSettings  = document.getElementById('nf-depth-settings');
  const _draftInput     = document.getElementById('nf-draft-ft');
  _depthSettings.style.display = _depthCheckbox.checked ? '' : 'none';

  // Restore saved draft
  const _savedDraft = localStorage.getItem('audiochart-draft-ft');
  if (_savedDraft) _draftInput.value = _savedDraft;

  _depthCheckbox.addEventListener('change', async () => {
    _depthSettings.style.display = _depthCheckbox.checked ? '' : 'none';
    if (_depthCheckbox.checked) {
      const pos = GPS.getPosition();
      if (pos) await _fetchTideHeight(pos.lat, pos.lon);
    }
    _refreshNavaidOverlay();
  });

  _draftInput.addEventListener('input', () => {
    localStorage.setItem('audiochart-draft-ft', _draftInput.value);
    if (_depthCheckbox.checked) _refreshNavaidOverlay();
  });

  // Floating ☰ button — opens context menu at current GPS position
  document.getElementById('map-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const pos = GPS.getPosition();
    _ctxLatLng = pos ? L.latLng(pos.lat, pos.lon) : _map.getCenter();
    const btn  = e.currentTarget.getBoundingClientRect();
    _ctxSubmenu.style.display    = 'none';
    _wpSubmenu.style.display     = 'none';
    _trackSubmenu.style.display  = 'none';
    _routeSubmenu.style.display  = 'none';
    _importSubmenu.style.display = 'none';
    _populateWpSubmenu();
    _populateRouteSelect();
    const showing = _ctxMenu.style.display === 'block';
    _ctxMenu.style.display = showing ? 'none' : 'block';
    if (!showing) {
      const mw = _ctxMenu.offsetWidth, mh = _ctxMenu.offsetHeight;
      const x = Math.min(Math.max(4, btn.left - mw), window.innerWidth  - mw - 4);
      const y = Math.min(Math.max(4, btn.top  - mh - 8), window.innerHeight - mh - 4);
      _ctxMenu.style.left = x + 'px';
      _ctxMenu.style.top  = y + 'px';
    }
  });

  // Refresh depth soundings when map moves or zooms
  _map.on('zoomend moveend', _refreshSoundingsLayer);

  // Sketch route click/dblclick/mousemove handlers are registered in _enterSketchMode()

  // Right-click / long-press context menu
  const _ctxMenu = document.getElementById('map-context-menu');
  let _ctxLatLng = null;
  const _hideCtx = () => { _ctxMenu.style.display = 'none'; };

  const _ctxSubmenu = document.getElementById('map-ctx-objects-submenu');
  const _wpSubmenu  = document.getElementById('map-ctx-wp-submenu');

  // Rebuild the dynamic waypoint rows (below the 3 static buttons)
  function _populateWpSubmenu() {
    // Remove all dynamic items (keep first 3 static children)
    while (_wpSubmenu.children.length > 3) _wpSubmenu.removeChild(_wpSubmenu.lastChild);
    const wps = loadUserWaypoints();
    for (const wp of wps) {
      const itemBtn = document.createElement('button');
      itemBtn.className = 'ctx-wp-item';
      itemBtn.dataset.wpName = wp.name;
      itemBtn.dataset.wpLat  = wp.lat;
      itemBtn.dataset.wpLon  = wp.lon;
      itemBtn.textContent = `${wp.name} ›`;
      _wpSubmenu.appendChild(itemBtn);

      const actions = document.createElement('div');
      actions.className = 'ctx-wp-actions';
      actions.dataset.wpName = wp.name;
      actions.dataset.wpLat  = wp.lat;
      actions.dataset.wpLon  = wp.lon;
      const delBtn = document.createElement('button');
      delBtn.className = 'ctx-wp-del';
      delBtn.textContent = 'Delete';
      const posBtn = document.createElement('button');
      posBtn.className = 'ctx-wp-pos';
      posBtn.textContent = 'Set position here';
      actions.appendChild(delBtn);
      actions.appendChild(posBtn);
      _wpSubmenu.appendChild(actions);
    }
  }

  function _populateRouteSelect() {
    const sel    = document.getElementById('track-route-select');
    const speed  = document.getElementById('track-speed-input');
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    sel.innerHTML = routes.length
      ? routes.map((r, i) => `<option value="${i}">${r.name}</option>`).join('')
      : '<option value="">— no routes saved —</option>';
    // Restore sticky route
    const lastName = localStorage.getItem('audiochart-last-route');
    if (lastName) {
      const idx = routes.findIndex(r => r.name === lastName);
      if (idx >= 0) sel.value = idx;
    }
    // Restore sticky speed, default 5 knots
    if (!speed.value) speed.value = localStorage.getItem('audiochart-last-speed') || '5';
  }
  _populateRouteSelectFn = _populateRouteSelect;

  // ── Track config save/load ──────────────────────────────────────────────────
  const TRACK_CONFIG_KEY = 'audiochart-track-configs';

  function _loadTrackConfigs() {
    try { return JSON.parse(localStorage.getItem(TRACK_CONFIG_KEY) || '[]'); } catch { return []; }
  }

  function _saveTrackConfigs(configs) {
    localStorage.setItem(TRACK_CONFIG_KEY, JSON.stringify(configs));
  }

  function _populateConfigSelect() {
    const sel = document.getElementById('track-config-select');
    const configs = _loadTrackConfigs();
    sel.innerHTML = configs.length
      ? '<option value="">— saved configs —</option>' +
        configs.map((c, i) => `<option value="${i}">${c.name}</option>`).join('')
      : '<option value="">— saved configs —</option>';
  }

  function _captureTrackConfig() {
    const routeSel = document.getElementById('track-route-select');
    const routes   = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    const routeIdx = parseInt(routeSel.value);
    return {
      routeName:        (!isNaN(routeIdx) && routes[routeIdx]) ? routes[routeIdx].name : '',
      filter:           document.querySelector('.track-obj.selected')?.dataset.obj ?? '',
      radiusNm:         parseFloat(document.querySelector('.track-dist.selected')?.dataset.nm) || 0.25,
      compress:         parseInt(document.querySelector('.track-compress.selected')?.dataset.compress) || 1,
      zoom:             document.querySelector('.track-zoom.selected')?.dataset.zoom || '',
      visibility:       parseFloat(document.querySelector('.track-visibility.selected')?.dataset.nm) || 2,
      speedKnots:       parseFloat(document.getElementById('track-speed-input')?.value) || 5,
      record:           document.getElementById('track-record-checkbox')?.checked || false,
      milestoneEnabled: document.getElementById('track-milestone-checkbox')?.checked || false,
      milestoneNm:      parseFloat(document.getElementById('track-milestone-input')?.value) || 5,
    };
  }

  function _applyTrackConfig(cfg) {
    console.log('[AC] applyTrackConfig called with:', JSON.stringify(cfg));

    // Rebuild route dropdown without triggering sticky-restore side effects
    const routes   = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    const routeSel = document.getElementById('track-route-select');
    routeSel.innerHTML = routes.length
      ? routes.map((r, i) => `<option value="${i}">${r.name}</option>`).join('')
      : '<option value="">— no routes saved —</option>';
    // Try routeName first; fall back to cfg.name for configs saved before route rename was fixed
    let idx = routes.findIndex(r => r.name === cfg.routeName);
    if (idx < 0) idx = routes.findIndex(r => r.name === cfg.name);
    if (idx >= 0) {
      routeSel.value = String(idx);
      localStorage.setItem('audiochart-last-route', routes[idx].name);
    }

    // Chip groups
    const setChip = (cls, attr, val) => {
      const strVal = String(val ?? '');
      document.querySelectorAll(`.${cls}`).forEach(b => {
        b.classList.toggle('selected', b.dataset[attr] === strVal);
      });
    };
    setChip('track-obj',        'obj',      cfg.filter);
    setChip('track-dist',       'nm',       cfg.radiusNm);
    setChip('track-compress',   'compress', cfg.compress);
    setChip('track-zoom',       'zoom',     cfg.zoom);
    setChip('track-visibility', 'nm',       cfg.visibility ?? 2);

    // Speed — update sticky so _populateRouteSelect() doesn't clobber it
    const speedEl = document.getElementById('track-speed-input');
    if (speedEl) {
      speedEl.value = cfg.speedKnots || 5;
      localStorage.setItem('audiochart-last-speed', speedEl.value);
    }

    // Checkboxes
    const recordEl = document.getElementById('track-record-checkbox');
    if (recordEl) recordEl.checked = !!cfg.record;
    const msEl  = document.getElementById('track-milestone-checkbox');
    const msInp = document.getElementById('track-milestone-input');
    if (msEl)  msEl.checked   = !!cfg.milestoneEnabled;
    if (msInp) msInp.value    = cfg.milestoneNm || 5;

    const routeName = idx >= 0 ? routes[idx].name : 'not found';
    const filterLabel = cfg.filter || 'All';
    console.log('[AC] cfg.routeName:', cfg.routeName, '| cfg.name:', cfg.name);
    console.log('[AC] Routes in storage:', routes.map(r => r.name));
    console.log('[AC] Route match idx:', idx, '→', routeName);
    console.log('[AC] Applied. Filter:', filterLabel,
      '| Radius:', cfg.radiusNm, '| Compress:', cfg.compress,
      '| Zoom:', cfg.zoom, '| Speed:', cfg.speedKnots,
      '| Milestone:', cfg.milestoneEnabled, cfg.milestoneNm);
    setStatus(`Loaded "${cfg.name}": ${filterLabel}, ${cfg.radiusNm}nm, ${cfg.speedKnots}kts, route ${routeName}`);
    TTS.sayImmediate(`Loaded ${cfg.name}: ${filterLabel}, ${cfg.radiusNm} miles, ${cfg.speedKnots} knots, route ${routeName}`);
  }

  _populateConfigSelect();

  document.getElementById('track-config-save').addEventListener('click', () => {
    const nameEl = document.getElementById('track-config-name');
    const btn    = document.getElementById('track-config-save');
    const name   = nameEl.value.trim();
    if (!name) {
      nameEl.style.outline = '2px solid #e05252';
      nameEl.focus();
      setTimeout(() => { nameEl.style.outline = ''; }, 1200);
      return;
    }
    // Capture config BEFORE touching the route dropdown
    const captured = _captureTrackConfig();

    // Rename the selected route to match the config name
    const routeSel = document.getElementById('track-route-select');
    const routeIdx = parseInt(routeSel.value);
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    if (!isNaN(routeIdx) && routes[routeIdx]) {
      routes[routeIdx].name = name;
      localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
      localStorage.setItem('audiochart-last-route', name);  // keep sticky in sync with rename
      _populateRouteSelect();
      // Re-select the renamed route after repopulating
      const newIdx = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]')
        .findIndex(r => r.name === name);
      if (newIdx >= 0) routeSel.value = String(newIdx);
    }

    const configs  = _loadTrackConfigs();
    const existing = configs.findIndex(c => c.name === name);
    // Force routeName to match the config name regardless of dropdown state
    const cfg = { name, ...captured, routeName: name };
    if (existing >= 0) configs[existing] = cfg; else configs.push(cfg);
    _saveTrackConfigs(configs);
    _populateConfigSelect();
    document.getElementById('track-config-select').value =
      configs.findIndex(c => c.name === name);
    nameEl.value = '';
    const prev = btn.textContent;
    btn.textContent = '✓ Saved';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1500);
  });

  document.getElementById('track-config-load').addEventListener('click', () => {
    const sel = document.getElementById('track-config-select');
    const btn = document.getElementById('track-config-load');
    const idx = parseInt(sel.value);
    if (isNaN(idx)) return;
    const configs = _loadTrackConfigs();
    if (!configs[idx]) return;
    _applyTrackConfig(configs[idx]);
    const prev = btn.textContent;
    btn.textContent = `✓ Loaded`;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1500);
  });

  document.getElementById('track-config-delete').addEventListener('click', () => {
    const sel = document.getElementById('track-config-select');
    const idx = parseInt(sel.value);
    if (isNaN(idx)) return;
    const name = _loadTrackConfigs()[idx]?.name;
    if (!name || !confirm(`Delete config "${name}"?`)) return;
    const configs = _loadTrackConfigs();
    configs.splice(idx, 1);
    _saveTrackConfigs(configs);
    _populateConfigSelect();
  });
  // ────────────────────────────────────────────────────────────────────────────

  const _routeSubmenu  = document.getElementById('map-ctx-route-submenu');
  const _importSubmenu = document.getElementById('map-ctx-import-submenu');

  _map.on('contextmenu', (e) => {
    _ctxLatLng = e.latlng;
    _ctxSubmenu.style.display    = 'none';
    _wpSubmenu.style.display     = 'none';
    _trackSubmenu.style.display  = 'none';
    _routeSubmenu.style.display  = 'none';
    _importSubmenu.style.display = 'none';
    _populateWpSubmenu();
    _populateRouteSelect();
    _ctxMenu.style.left    = '0';
    _ctxMenu.style.top     = '0';
    _ctxMenu.style.display = 'block';
    const mw = _ctxMenu.offsetWidth, mh = _ctxMenu.offsetHeight;
    const x  = Math.min(e.originalEvent.clientX, window.innerWidth  - mw - 4);
    const y  = Math.min(e.originalEvent.clientY, window.innerHeight - mh - 4);
    _ctxMenu.style.left = Math.max(4, x) + 'px';
    _ctxMenu.style.top  = Math.max(4, y) + 'px';
  });
  _map.on('movestart zoomstart', _hideCtx);
  document.addEventListener('click', (e) => { if (!_ctxMenu.contains(e.target)) _hideCtx(); }, { capture: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _hideCtx(); });

  document.getElementById('map-ctx-objects-parent').addEventListener('click', () => {
    _ctxSubmenu.style.display = _ctxSubmenu.style.display === 'block' ? 'none' : 'block';
  });

  _ctxSubmenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-radius-nm]');
    if (!btn) return;
    _hideCtx();
    if (_ctxLatLng) handleMapLongPress(_ctxLatLng, parseFloat(btn.dataset.radiusNm), btn.dataset.radiusLabel);
  });

  document.getElementById('map-ctx-route-parent').addEventListener('click', () => {
    _routeSubmenu.style.display = _routeSubmenu.style.display === 'block' ? 'none' : 'block';
  });

  document.getElementById('map-ctx-sketch').addEventListener('click', () => {
    _hideCtx();
    _enterSketchMode();
  });

  document.getElementById('map-ctx-route-delete').addEventListener('click', () => {
    _hideCtx();
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    if (!routes.length) { TTS.sayImmediate('No routes saved.'); return; }
    const deleted = routes.pop();
    localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
    _refreshSavedRouteLayers();
    const msg = `${deleted.name} deleted.`;
    setStatus(msg);
    TTS.sayImmediate(msg);
  });

  document.getElementById('map-ctx-route-rename').addEventListener('click', () => {
    _hideCtx();
    const sel    = document.getElementById('track-route-select');
    const idx    = parseInt(sel.value);
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    if (isNaN(idx) || !routes[idx]) {
      alert('Select a route in the Track panel first, then rename.');
      return;
    }
    const newName = prompt('Rename route:', routes[idx].name);
    if (!newName || !newName.trim()) return;
    routes[idx].name = newName.trim();
    localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
    localStorage.setItem('audiochart-last-route', newName.trim());
    _populateRouteSelect();
    const newIdx = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]')
      .findIndex(r => r.name === newName.trim());
    if (newIdx >= 0) sel.value = String(newIdx);
  });

  document.getElementById('map-ctx-route-edit').addEventListener('click', () => {
    _hideCtx();
    const sel    = document.getElementById('track-route-select');
    const idx    = parseInt(sel.value);
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    if (isNaN(idx) || !routes[idx]) {
      alert('Select a route in the Track → Along route panel first, then edit.');
      return;
    }
    _enterEditMode(idx);
  });

  const _trackSubmenu = document.getElementById('map-ctx-track-submenu');
  document.getElementById('map-ctx-track-parent').addEventListener('click', () => {
    _populateRouteSelect();
    _trackSubmenu.style.display = _trackSubmenu.style.display === 'block' ? 'none' : 'block';
  });

  // Track chip selection — single-select per group
  _trackSubmenu.addEventListener('click', (e) => {
    const chip = e.target.closest('.track-chip');
    if (!chip) return;
    const group = chip.classList[1]; // track-obj / track-dist / track-interval
    _trackSubmenu.querySelectorAll(`.${group}`).forEach(b => b.classList.remove('selected'));
    chip.classList.add('selected');
  });

  document.getElementById('track-route-go').addEventListener('click', () => {
    _hideCtx();
    const sel    = document.getElementById('track-route-select');
    const speed  = parseFloat(document.getElementById('track-speed-input').value);
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    const route  = routes[parseInt(sel.value)];
    if (!route || !route.points?.length) {
      TTS.sayImmediate('No route selected. Sketch a route first.');
      return;
    }
    if (!speed || speed <= 0) {
      TTS.sayImmediate('Enter a speed in knots first.');
      return;
    }
    localStorage.setItem('audiochart-last-route', route.name);
    localStorage.setItem('audiochart-last-speed', speed);
    _startRouteAnimation(route, speed);
  });

  document.getElementById('map-ctx-wp-parent').addEventListener('click', () => {
    _wpSubmenu.style.display = _wpSubmenu.style.display === 'block' ? 'none' : 'block';
  });

  _wpSubmenu.addEventListener('click', (e) => {
    const t = e.target;

    if (t.id === 'map-ctx-wp-set') {
      _hideCtx();
      if (!_ctxLatLng) return;
      const { lat, lng: lon } = _ctxLatLng;
      const name = nextWaypointName();
      saveUserWaypoint(name, lat, lon);
      if (!_waypointsVisible) _setWaypointsVisible(true);
      showWaypointMap(null, null, loadUserWaypoints()).catch(() => {});
      const msg = `Waypoint ${name} set.`;
      setStatus(msg);
      TTS.sayImmediate(msg);
      return;
    }

    if (t.id === 'map-ctx-wp-show') { _hideCtx(); _setWaypointsVisible(true);  return; }
    if (t.id === 'map-ctx-wp-hide') { _hideCtx(); _setWaypointsVisible(false); return; }

    if (t.classList.contains('ctx-wp-item')) {
      const name    = t.dataset.wpName;
      const actions = _wpSubmenu.querySelector(`.ctx-wp-actions[data-wp-name="${name}"]`);
      // Collapse all other open action panels
      _wpSubmenu.querySelectorAll('.ctx-wp-actions').forEach(a => {
        if (a !== actions) a.style.display = 'none';
      });
      _wpSubmenu.querySelectorAll('.ctx-wp-item').forEach(b => {
        if (b !== t) b.textContent = `${b.dataset.wpName} ›`;
      });
      const opening = actions.style.display !== 'block';
      actions.style.display = opening ? 'block' : 'none';
      t.textContent = `${name} ${opening ? '‹' : '›'}`;
      return;
    }

    if (t.classList.contains('ctx-wp-del')) {
      const actions = t.closest('.ctx-wp-actions');
      const name = actions.dataset.wpName;
      _hideCtx();
      localStorage.setItem(USER_WP_KEY, JSON.stringify(loadUserWaypoints().filter(w => w.name !== name)));
      Query.removeUserWaypoint(name);
      _refreshWaypointLayer();
      const msg = `Waypoint ${name} deleted.`;
      setStatus(msg); TTS.sayImmediate(msg);
      return;
    }

    if (t.classList.contains('ctx-wp-pos')) {
      const actions = t.closest('.ctx-wp-actions');
      const lat = parseFloat(actions.dataset.wpLat);
      const lon = parseFloat(actions.dataset.wpLon);
      const name = actions.dataset.wpName;
      _hideCtx();
      GPS.setManualPosition(lat, lon);
      syncTestPosButton();
      document.getElementById('map-container').style.display = 'block';
      _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
      _showBoatPosition(lat, lon);
      _map.invalidateSize();
      setStatus(`Position set to ${name}.`);
      _runWhereAmI(lat, lon);
      if (serverUrl) {
        fetch(`${serverUrl}/api/test-position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat, lon }),
        }).catch(() => {});
        Query.loadData(lat, lon).then(() => { dataLoaded = true; setStatus(`Ready. (${name})`); }).catch(() => {});
      }
      return;
    }
  });

  document.getElementById('map-ctx-import-parent').addEventListener('click', () => {
    const isMobile = navigator.maxTouchPoints > 1;
    document.getElementById('import-hint-text').textContent = isMobile
      ? 'Export from Navionics → Files app first'
      : '~/Library/Application Support/opencpn/';
    _importSubmenu.style.display = _importSubmenu.style.display === 'block' ? 'none' : 'block';
  });

  const _gpxInput = document.getElementById('gpx-file-input');
  let _gpxMode = null;

  document.getElementById('map-ctx-import-markers').addEventListener('click', () => {
    _hideCtx();
    _gpxMode = 'markers';
    _gpxInput.multiple = false;
    _gpxInput.value = '';
    _gpxInput.click();
  });

  document.getElementById('map-ctx-import-routes').addEventListener('click', () => {
    _hideCtx();
    _gpxMode = 'routes';
    _gpxInput.multiple = false;
    _gpxInput.value = '';
    _gpxInput.click();
  });

  document.getElementById('map-ctx-combine-routes').addEventListener('click', () => {
    _hideCtx();
    _gpxMode = 'combine';
    _gpxInput.multiple = true;
    _gpxInput.value = '';
    _gpxInput.click();
  });

  _gpxInput.addEventListener('change', () => {
    if (_gpxMode === 'combine') {
      _combineGpxRoutes([..._gpxInput.files]);
      return;
    }
    const file = _gpxInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const doc = new DOMParser().parseFromString(ev.target.result, 'application/xml');
      if (_gpxMode === 'markers') _importGpxMarkers(doc);
      else                        _importGpxRoutes(doc);
    };
    reader.readAsText(file);
  });

  function _importGpxMarkers(doc) {
    const wpts = [...doc.querySelectorAll('wpt')];
    if (!wpts.length) { TTS.sayImmediate('No waypoints found in file.'); return; }
    let count = 0;
    for (const wpt of wpts) {
      const lat  = parseFloat(wpt.getAttribute('lat'));
      const lon  = parseFloat(wpt.getAttribute('lon'));
      const name = wpt.querySelector('name')?.textContent?.trim() || nextWaypointName();
      if (isNaN(lat) || isNaN(lon)) continue;
      saveUserWaypoint(name, lat, lon);
      count++;
    }
    if (!_waypointsVisible) _setWaypointsVisible(true);
    const msg = `Imported ${count} marker${count !== 1 ? 's' : ''}.`;
    setStatus(msg); TTS.sayImmediate(msg);
  }

  function _importGpxRoutes(doc) {
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    let count = 0;
    for (const rte of doc.querySelectorAll('rte')) {
      const name   = rte.querySelector('name')?.textContent?.trim() || `Route ${routes.length + count + 1}`;
      const points = [...rte.querySelectorAll('rtept')].map(pt => ({
        lat: parseFloat(pt.getAttribute('lat')),
        lon: parseFloat(pt.getAttribute('lon')),
      })).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
      if (!points.length) continue;
      routes.push({ name, points });
      count++;
    }
    for (const trk of doc.querySelectorAll('trk')) {
      const name   = trk.querySelector('name')?.textContent?.trim() || `Route ${routes.length + count + 1}`;
      const points = [...trk.querySelectorAll('trkpt')].map(pt => ({
        lat: parseFloat(pt.getAttribute('lat')),
        lon: parseFloat(pt.getAttribute('lon')),
      })).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
      if (!points.length) continue;
      routes.push({ name, points });
      count++;
    }
    localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
    _populateRouteSelect();
    const total = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]').length;
    const msg = count
      ? `Imported ${count} route${count !== 1 ? 's' : ''}. ${total} route${total !== 1 ? 's' : ''} total in Track menu.`
      : 'No routes or tracks found in that file. Try Import Markers instead.';
    setStatus(msg); TTS.sayImmediate(msg);
  }

  function _combineGpxRoutes(files) {
    if (!files.length) return;
    files.sort((a, b) => a.name.localeCompare(b.name));
    const reads = files.map(f => new Promise(resolve => {
      const r = new FileReader();
      r.onload = (ev) => resolve(ev.target.result);
      r.readAsText(f);
    }));
    Promise.all(reads).then(texts => {
      const allPoints = [];
      for (const text of texts) {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        const src = doc.querySelector('rte') || doc.querySelector('trk');
        if (!src) continue;
        const ptTag = src.tagName === 'rte' ? 'rtept' : 'trkpt';
        for (const pt of src.querySelectorAll(ptTag)) {
          const lat = parseFloat(pt.getAttribute('lat'));
          const lon = parseFloat(pt.getAttribute('lon'));
          if (!isNaN(lat) && !isNaN(lon)) allPoints.push({ lat, lon });
        }
      }
      if (!allPoints.length) { TTS.sayImmediate('No route points found.'); return; }
      const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
      routes.push({ name: 'Combined Route', points: allPoints });
      localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
      if (_map) {
        if (_previewRouteLine) { _map.removeLayer(_previewRouteLine); }
        const pts = allPoints.map(p => [p.lat, p.lon]);
        _previewRouteLine = L.polyline(pts, {
          color: '#e05252', weight: 3, opacity: 0.7, dashArray: '8 4',
        }).addTo(_map);
        _map.fitBounds(L.latLngBounds(pts).pad(0.25));
        document.getElementById('map-container').style.display = 'block';
        _map.invalidateSize();
      }
      _populateRouteSelect();
      const msg = `Combined route saved. ${allPoints.length} points from ${files.length} files.`;
      setStatus(msg); TTS.sayImmediate(msg);
    });
  }

  document.getElementById('map-ctx-bring-boat').addEventListener('click', () => {
    _hideCtx();
    if (!_ctxLatLng) return;
    const { lat, lng: lon } = _ctxLatLng;
    GPS.setManualPosition(lat, lon);
    syncTestPosButton();
    _showBoatPosition(lat, lon);
    _updateBearingLines(lat, lon);
    setStatus('Boat moved.');
    if (serverUrl) {
      fetch(`${serverUrl}/api/test-position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lon }),
      }).catch(() => {});
      Query.loadData(lat, lon).then(() => { dataLoaded = true; }).catch(() => {});
    }
  });

  document.getElementById('map-ctx-set-position').addEventListener('click', () => {
    _hideCtx();
    if (!_ctxLatLng) return;
    const { lat, lng: lon } = _ctxLatLng;
    GPS.setManualPosition(lat, lon);
    syncTestPosButton();
    document.getElementById('map-container').style.display = 'block';
    _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
    _showBoatPosition(lat, lon);
    _map.invalidateSize();
    setStatus('Test position set from map.');
    _runWhereAmI(lat, lon);
    if (serverUrl) {
      fetch(`${serverUrl}/api/test-position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lon }),
      }).catch(() => {});
      Query.loadData(lat, lon).then(() => {
        dataLoaded = true;
        setStatus('Ready. (map position)');
      }).catch(() => {});
    }
  });

  _refreshWaypointLayer();
  _refreshYouLayer();
}

async function showPositionMap(lat, lon) {
  await loadLeaflet();
  document.getElementById('map-container').style.display = 'block';
  _ensureMap();
  _map.invalidateSize();
  if (_mapLayers) { _map.removeLayer(_mapLayers); _mapLayers = null; }
  const dot = L.marker([lat, lon], { icon: _boatIcon(), draggable: true, zIndexOffset: 900 });

  dot.on('contextmenu', (e) => e.originalEvent.stopPropagation());
  dot.on('drag', (e) => {
    const { lat: dLat, lng: dLon } = e.target.getLatLng();
    _updateBearingLines(dLat, dLon);
  });
  dot.on('dragend', (e) => {
    const { lat: newLat, lng: newLon } = e.target.getLatLng();
    GPS.setManualPosition(newLat, newLon);
    syncTestPosButton();
    if (_mapLayers) { _map.removeLayer(_mapLayers); _mapLayers = null; }
    _showBoatPosition(newLat, newLon);
    setStatus('Test position set from map.');
    if (serverUrl) {
      fetch(`${serverUrl}/api/test-position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: newLat, lon: newLon }),
      }).catch(() => {});
      Query.loadData(newLat, newLon).then(() => {
        dataLoaded = true;
        setStatus('Ready. (map position)');
      }).catch(() => {});
    }
  });
  _mapLayers = L.layerGroup([dot]).addTo(_map);
  _map.setView([lat, lon], 13);
  _map.invalidateSize();

  // Auto-draw the default overlay so the user sees objects immediately.
  // Fetch a fresh tide reading first if depths are enabled (same sequence as
  // clicking the depth checkbox), then render — fire-and-forget so the map
  // paint isn't blocked.
  const _depthOn = document.getElementById('nf-depth')?.checked;
  (_depthOn ? _fetchTideHeight(lat, lon) : Promise.resolve())
    .catch(() => {})
    .then(() => _refreshNavaidOverlay());
}

const _BEARING_COLORS = ['#4a9edd', '#f5a623', '#4dd0e1', '#7ec86e', '#e05252', '#b39ddb'];

async function showMap(fromLat, fromLon, result) {
  await loadLeaflet();
  document.getElementById('map-container').style.display = 'block';
  _ensureMap();
  _map.invalidateSize();
  if (_mapLayers) { _map.removeLayer(_mapLayers); _mapLayers = null; }

  // Draw all accumulated bearing lines; fall back to just the current result.
  const entries = _bearingAccumulator.length > 0
    ? _bearingAccumulator
    : [{ fromLat, fromLon, result }];

  const layers = [];
  const allPts = [];

  for (let i = 0; i < entries.length; i++) {
    const { fromLat: fLat, fromLon: fLon, result: r } = entries[i];
    const { destLat, destLon, destName, destType, brg, distNm } = r;
    const color = _BEARING_COLORS[i % _BEARING_COLORS.length];

    layers.push(L.circleMarker([fLat, fLon], {
      radius: 5, color: '#fff', fillColor: color, fillOpacity: 1, weight: 1.5,
    }));
    const toIcon = _navaidIcon(destType || 'place', color);
    const toMarker = L.marker([destLat, destLon], { icon: toIcon });
    if (destName) toMarker.bindTooltip(destName, { permanent: true, direction: 'top', className: 'map-tooltip' });
    layers.push(toMarker);
    const bearingPolyline = L.polyline([[fLat, fLon], [destLat, destLon]], {
      color, weight: 2, dashArray: '6 4', opacity: 0.85,
    });
    layers.push(bearingPolyline);
    let bearingLabel = null;
    if (brg != null && distNm != null) {
      bearingLabel = _bearingLineLabel(fLat, fLon, destLat, destLon, brg, distNm, color);
      layers.push(bearingLabel);
    }
    entries[i]._polyline = bearingPolyline;
    entries[i]._labelMarker = bearingLabel;
    entries[i]._color = color;
    allPts.push([fLat, fLon], [destLat, destLon]);
  }

  _mapLayers = L.layerGroup(layers).addTo(_map);
  _map.fitBounds(L.latLngBounds(allPts).pad(0.2));
}


function _pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function _inChannel(lon, lat) {
  if (!Query.channels?.length) return false;
  for (const f of Query.channels) {
    const polys = f.geometry.type === 'Polygon'
      ? [f.geometry.coordinates]
      : f.geometry.coordinates;
    for (const poly of polys) {
      if (_pointInRing(lon, lat, poly[0])) return true;
    }
  }
  return false;
}

function _soundingColor(effDepthM) {
  if (effDepthM < 2)  return '#e05252';  // red — very shallow
  if (effDepthM < 5)  return '#f5a623';  // orange — caution
  if (effDepthM < 10) return '#f5e642';  // yellow — moderate
  return '#7ec8e3';                       // blue — comfortable
}

function _refreshSoundingsLayer() {
  if (!_map) return;
  if (_soundingsLayer) { _map.removeLayer(_soundingsLayer); _soundingsLayer = null; }
  if (!document.getElementById('nf-depth')?.checked) return;
  if (!Query.soundings?.features?.length) return;
  const zoom = _map.getZoom();
  if (zoom < 14) return;  // only show at close zoom — dots still add up fast
  const bounds = _map.getBounds().pad(0.1);
  const markers = [];
  for (const f of Query.soundings.features) {
    const [lon, lat] = f.geometry.coordinates;
    if (!bounds.contains([lat, lon])) continue;
    const charted = f.properties.valsou;
    const eff = charted + _effectiveTideHeight();
    const effFt = (eff * 3.28084).toFixed(1);
    const color = _soundingColor(eff);
    markers.push(
      L.circleMarker([lat, lon], {
        radius: 4, color, fill: false, weight: 1.5, opacity: 0.8,
      }).bindTooltip(`${effFt} ft`, { className: 'map-tooltip', sticky: true })
    );
  }
  if (markers.length) _soundingsLayer = L.layerGroup(markers).addTo(_map);
}

function _refreshNavaidOverlay() {
  if (!_map) return;
  if (_navaidFilterLayer) { _map.removeLayer(_navaidFilterLayer); _navaidFilterLayer = null; }

  const types = new Set();
  if (document.getElementById('nf-buoy')?.checked)   types.add('buoy');
  if (document.getElementById('nf-light')?.checked)  types.add('light');
  if (document.getElementById('nf-beacon')?.checked) types.add('beacon');
  const showHazards = document.getElementById('nf-hazard')?.checked;
  const showDepths  = document.getElementById('nf-depth')?.checked;
  if (types.size === 0 && !showHazards && !showDepths) return;

  const bounds = _map.getBounds();
  const markers = [];

  if (types.size > 0 && Query.navaids?.features) {
    for (const f of Query.navaids.features) {
      if (!types.has(f.properties.label)) continue;
      const [lon, lat] = f.geometry.coordinates;
      if (!bounds.contains([lat, lon])) continue;
      const n = { label: f.properties.label, colour: f.properties.colour,
                  name: f.properties.name, characteristic: f.properties.characteristic };
      const m = L.marker([lat, lon], { icon: _navaidMarkerIcon(n) });
      const tip = [n.name, n.characteristic || n.colour].filter(Boolean).join(' — ');
      if (tip) m.bindTooltip(tip, { permanent: false, direction: 'top', className: 'map-tooltip' });

      // Tap/click → popup with Range & bearing and Copy name
      const safeName = (n.name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      m.bindPopup(
        `<div class="navaid-popup">
           <div class="navaid-popup-name">${safeName}</div>
           <button class="navaid-popup-brg">Range &amp; bearing</button>
           <button class="navaid-popup-copy">Copy name</button>
         </div>`,
        { maxWidth: 220, className: 'navaid-popup-wrapper' }
      );
      m.on('popupopen', (e) => {
        const el = e.popup.getElement();
        el.querySelector('.navaid-popup-brg').addEventListener('click', () => {
          _map.closePopup();
          // Use exact coordinates — bypasses the parser's alias system which
          // mangles names like "Thorofare" or "Rockland" into wrong places.
          const pos = GPS.getPosition();
          if (!pos) {
            const msg = 'No GPS fix yet.';
            showResponse(msg); TTS.sayImmediate(msg); return;
          }
          const result = Query.bearingToResolvedPlace(pos.lat, pos.lon, lat, lon, n.name);
          showResponse(result.text);
          TTS.sayImmediate(result.speech);
          _bearingAccumulator.push({ fromLat: pos.lat, fromLon: pos.lon, result: Query.lastBearingResult });
          if (_bearingAccumulator.length > 6) _bearingAccumulator.shift();
          showMap(pos.lat, pos.lon, Query.lastBearingResult).catch(() => {});
        });
        el.querySelector('.navaid-popup-copy').addEventListener('click', (evt) => {
          navigator.clipboard.writeText(n.name).catch(() => {});
          const btn = evt.currentTarget;
          btn.textContent = '✓ Copied';
          setTimeout(() => { btn.textContent = 'Copy name'; }, 1200);
        });
      });

      markers.push(m);
    }
  }

  if (showHazards && Query.hazards?.features) {
    for (const f of Query.hazards.features) {
      // DEPARE features are now polygons — skip them here (shown by Depths layer)
      if (f.geometry.type !== 'Point') continue;
      const [lon, lat] = f.geometry.coordinates;
      if (!bounds.contains([lat, lon])) continue;
      const label = f.properties.label || f.properties.objtype || 'hazard';
      const name  = f.properties.name || label;
      const m = L.marker([lat, lon], { icon: _hazardMarkerIcon() });
      m.bindTooltip(name, { permanent: false, direction: 'top', className: 'map-tooltip' });
      markers.push(m);
    }
  }

  // Mudflat layer — tidal flats (valsou < 0 = seabed above chart datum, always exposed).
  if (_mudflatLayer) { _map.removeLayer(_mudflatLayer); _mudflatLayer = null; }
  if (showDepths && Query.depthZones) {
    const mudflatFeatures = Query.depthZones.filter(f => (f.properties.valsou ?? 0) < 0);
    if (mudflatFeatures.length) {
      _mudflatLayer = L.geoJSON(
        { type: 'FeatureCollection', features: mudflatFeatures },
        {
          style: () => ({ color: 'none', weight: 0, fillColor: '#a07040', fillOpacity: 0.85 }),
          onEachFeature: (f, layer) => layer.bindTooltip('Tidal flat', { sticky: true, className: 'map-tooltip' }),
        }
      ).addTo(_map);
    }
  }

  // Depth layer — true contour-band fills from bundled polygon geometry.
  // Always uses Query.depthZones (loaded from hazards.geojson) so we get real
  // polygon shapes even in server mode, which only returns centroid points.
  if (_depthHeatLayer) { _map.removeLayer(_depthHeatLayer); _depthHeatLayer = null; }
  if (showDepths && Query.depthZones) {
    const draftM = _getDraftMeters();
    if (draftM != null) {
      const polyFeatures = [];
      for (const f of Query.depthZones) {
        const eff = (f.properties.valsou ?? 0) + _effectiveTideHeight();
        if (eff <= 0) continue;  // exposed/dry at current tide — not a navigable hazard
        let color = null;
        if (eff <= draftM)             color = '#e05252';
        else if (eff < draftM + 1.8288) color = '#f5c518';
        if (!color) continue;
        // Suppress warnings inside maintained navigation channels
        const ring = f.geometry.coordinates?.[0];
        if (ring?.length) {
          const clon = ring.reduce((s, c) => s + c[0], 0) / ring.length;
          const clat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
          if (_inChannel(clon, clat)) continue;
        }
        const effFt = (eff * 3.28084).toFixed(1);
        polyFeatures.push({ ...f, properties: { ...f.properties, _color: color, _tip: `${effFt} ft` } });
      }
      if (polyFeatures.length) {
        _depthHeatLayer = L.geoJSON(
          { type: 'FeatureCollection', features: polyFeatures },
          {
            style: (f) => ({ color: 'none', weight: 0, fillColor: f.properties._color, fillOpacity: 0.4 }),
            onEachFeature: (f, layer) => layer.bindTooltip(f.properties._tip, { sticky: true, className: 'map-tooltip' }),
          }
        ).addTo(_map);
      }
    }
  }

  if (markers.length) _navaidFilterLayer = L.layerGroup(markers).addTo(_map);

  // Channel corridor overlay — FAIRWY polygons from ENC data
  if (_channelLayer) { _map.removeLayer(_channelLayer); _channelLayer = null; }
  if (showDepths && Query.channels?.length) {
    _channelLayer = L.geoJSON(
      { type: 'FeatureCollection', features: Query.channels },
      {
        style: () => ({ color: '#29b6f6', weight: 1.5, dashArray: '5,4',
                        fillColor: '#29b6f6', fillOpacity: 0.22 }),
        onEachFeature: (f, layer) =>
          layer.bindTooltip(`⚓ ${f.properties.name}`, { sticky: true, className: 'map-tooltip' })
      }
    ).addTo(_map);
  }

  _refreshSoundingsLayer();
}

function hideMap() {

  document.getElementById('map-container').style.display = 'none';
  _bearingAccumulator = [];
  if (_navaidFilterLayer) { _map?.removeLayer(_navaidFilterLayer); _navaidFilterLayer = null; }
  if (_depthHeatLayer)    { _map?.removeLayer(_depthHeatLayer);    _depthHeatLayer = null; }
  if (_channelLayer)      { _map?.removeLayer(_channelLayer);      _channelLayer = null; }
  if (_soundingsLayer)    { _map?.removeLayer(_soundingsLayer);    _soundingsLayer = null; }
  document.getElementById('navaid-filter-panel')?.classList.remove('open');
  document.getElementById('navaid-filter-btn')?.classList.remove('active');
}

async function showNavaidMap(fromLat, fromLon, navaids) {
  await loadLeaflet();
  document.getElementById('map-container').style.display = 'block';
  _ensureMap();
  _map.invalidateSize();
  if (_mapLayers) { _map.removeLayer(_mapLayers); _mapLayers = null; }
  _markerByKey.clear();
  _refreshYouLayer();

  const layers = [];
  for (const n of navaids) {
    const marker = L.marker([n.lat, n.lon], { icon: _navaidMarkerIcon(n) });
    _markerByKey.set(_markerKey(n.lat, n.lon), marker);
    const tip = [n.name, n.characteristic || n.colour].filter(Boolean).join(' — ');
    if (tip) marker.bindTooltip(tip, { permanent: false, direction: 'top', className: 'map-tooltip' });
    marker.on('click', () => {
      const nameStr = n.name ? ` ${n.name}` : '';
      const detail  = n.characteristic ? `, ${n.characteristic}` : n.colour ? `, ${n.colour}` : '';
      const base = `${n.label}${nameStr}${detail}`;
      _highlightAndSpeak(marker,
        `${base}, ${bearingToDisplay(n.brg)}, ${distanceToDisplay(n.d)}`,
        `${base}, bearing ${bearingToWords(n.brg)}, ${formatDistance(n.d)}.`
      );
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
  _markerByKey.clear();
  _refreshYouLayer();

  const layers = [];
  for (const h of hazardPts) {
    const marker = L.marker([h.lat, h.lon], { icon: _hazardMarkerIcon() });
    _markerByKey.set(_markerKey(h.lat, h.lon), marker);
    const tip = [h.label, h.name].filter(Boolean).join(', ');
    if (tip) marker.bindTooltip(tip, { permanent: false, direction: 'top', className: 'map-tooltip' });
    marker.on('click', () => {
      const nameStr = h.name ? `, ${h.name}` : '';
      const base = `${h.label}${nameStr}`;
      _highlightAndSpeak(marker,
        `${base}, ${bearingToDisplay(h.brg)}, ${distanceToDisplay(h.d)}`,
        `${base}, bearing ${bearingToWords(h.brg)}, ${formatDistance(h.d)}.`
      );
    });
    layers.push(marker);
  }

  _mapLayers = L.layerGroup(layers).addTo(_map);
  const allPts = [[fromLat, fromLon], ...hazardPts.map(h => [h.lat, h.lon])];
  _map.fitBounds(L.latLngBounds(allPts).pad(0.25));
}

async function showWaypointMap(fromLat, fromLon, wps) {
  await loadLeaflet();
  document.getElementById('map-container').style.display = 'block';
  _ensureMap();
  _map.invalidateSize();
  if (_mapLayers) { _map.removeLayer(_mapLayers); _mapLayers = null; }

  // Ensure waypoints are visible and layer is up to date
  if (!_waypointsVisible) _setWaypointsVisible(true);

  // "You" dot in the transient layer
  if (fromLat != null) {
    _mapLayers = L.layerGroup([
      L.circleMarker([fromLat, fromLon], {
        radius: 8, color: '#4a9edd', fillColor: '#4a9edd', fillOpacity: 1, weight: 0,
      }).bindTooltip('You', { permanent: true, direction: 'top', className: 'map-tooltip' }),
    ]).addTo(_map);
  }

  const allPts = [
    ...(fromLat != null ? [[fromLat, fromLon]] : []),
    ...wps.map(w => [w.lat, w.lon]),
  ];
  if (allPts.length > 1) {
    _map.fitBounds(L.latLngBounds(allPts).pad(0.3));
  } else if (allPts.length === 1) {
    _map.setView(allPts[0], 13);
  }
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
    const m = L.marker([h.lat, h.lon], { icon: _hazardMarkerIcon() });
    if (h.label || h.name) m.bindTooltip(((h.label || '') + ' ' + (h.name || '')).trim(), { permanent: false, direction: 'top', className: 'map-tooltip' });
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

async function showFixMap(lmA, lmB, fix) {
  await loadLeaflet();
  document.getElementById('map-container').style.display = 'block';
  _ensureMap();

  // Expand container and hide the boat icon before fitting bounds so the
  // viewport is already at full size when fitBounds runs.
  _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
  if (_youLayer) { _map.removeLayer(_youLayer); _youLayer = null; }
  _map.invalidateSize();

  if (_mapLayers) { _map.removeLayer(_mapLayers); _mapLayers = null; }

  const group = L.layerGroup();
  const EXTEND_NM = 5;
  const COLOR_A = '#f5a623', COLOR_B = '#4dd0e1';

  function addPositionLine(lm, brgMag, color) {
    const brgTrue = ((brgMag + magneticVariation) + 360) % 360;
    const recip   = (brgTrue + 180) % 360;
    const lineStart = Query.offsetCoords(lm.lat, lm.lon, brgTrue, EXTEND_NM);
    const lineEnd   = Query.offsetCoords(fix.lat, fix.lon, recip, EXTEND_NM);
    L.polyline(
      [[lineStart.lat, lineStart.lon], [lm.lat, lm.lon], [fix.lat, fix.lon], [lineEnd.lat, lineEnd.lon]],
      { color, weight: 2.5, dashArray: '10 6', opacity: 0.85, interactive: false }
    ).addTo(group);
    const d = Query.distanceNm(lm.lon, lm.lat, fix.lon, fix.lat);
    _bearingLineLabel(lm.lat, lm.lon, fix.lat, fix.lon, brgMag, d, color).addTo(group);
    L.circleMarker([lm.lat, lm.lon], { radius: 5, color: '#fff', fillColor: color, fillOpacity: 1, weight: 1.5 })
      .bindTooltip(lm.name, { permanent: false })
      .addTo(group);
  }

  addPositionLine(lmA, lmA.brgMag, COLOR_A);
  addPositionLine(lmB, lmB.brgMag, COLOR_B);

  // Fix marker — no tooltip on the dot itself so the crossing point stays clear.
  L.circleMarker([fix.lat, fix.lon], { radius: 9, color: '#fff', fillColor: '#e05252', fillOpacity: 1, weight: 2 })
    .addTo(group);

  // Coordinate label offset below the crossing point so it never covers it.
  const fixLabelHtml = `<div class="fix-coord-label" style="transform:translate(-50%,14px)">Fix: ${formatPositionDisplay(fix.lat, fix.lon)}</div>`;
  L.marker([fix.lat, fix.lon], {
    icon: L.divIcon({ className: '', html: fixLabelHtml, iconSize: [0, 0], iconAnchor: [0, 0] }),
    interactive: false,
  }).addTo(group);

  _mapLayers = group;
  group.addTo(_map);

  const bounds = L.latLngBounds([[lmA.lat, lmA.lon], [lmB.lat, lmB.lon], [fix.lat, fix.lon]]);
  _map.fitBounds(bounds.pad(0.12));
  // Re-fit after CSS transition completes to catch any container resize.
  setTimeout(() => { _map.invalidateSize(); _map.fitBounds(bounds.pad(0.12)); }, 300);
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

// ── Map long-press query ──────────────────────────────────────────────────────

async function handleMapLongPress(latlng, radiusNm = 0.25, radiusLabel = '¼ mile') {
  if (!dataLoaded) return;
  const lat = latlng.lat, lon = latlng.lng;

  await loadLeaflet();
  document.getElementById('map-container').style.display = 'block';
  _ensureMap();
  _map.invalidateSize();
  if (_mapLayers) { _map.removeLayer(_mapLayers); _mapLayers = null; }
  _refreshYouLayer();

  Query.hazardsInRadius(lat, lon, radiusNm);
  Query.navaidsInRadius(lat, lon, radiusNm, null);
  const hazards = Query.lastHazardResults || [];
  const navaids = Query.lastNavaidResults || [];

  _markerByKey.clear();
  const layers = [];
  layers.push(L.marker([lat, lon], { icon: _pinIcon() })
    .bindTooltip('📍', { permanent: true, direction: 'top', className: 'map-tooltip' }));

  for (const h of hazards) {
    const m = L.marker([h.lat, h.lon], { icon: _hazardMarkerIcon() });
    _markerByKey.set(_markerKey(h.lat, h.lon), m);
    const tip = [h.label, h.name].filter(Boolean).join(', ');
    if (tip) m.bindTooltip(tip, { permanent: false, direction: 'top', className: 'map-tooltip' });
    m.on('click', () => {
      const nameStr = h.name ? `, ${h.name}` : '';
      const base = `${h.label}${nameStr}`;
      _highlightAndSpeak(m,
        `${base}, ${bearingToDisplay(h.brg)}, ${distanceToDisplay(h.d)}`,
        `${base}, bearing ${bearingToWords(h.brg)}, ${formatDistance(h.d)}.`
      );
    });
    layers.push(m);
  }

  for (const n of navaids) {
    const m = L.marker([n.lat, n.lon], { icon: _navaidMarkerIcon(n) });
    _markerByKey.set(_markerKey(n.lat, n.lon), m);
    const tip = [n.name, n.characteristic || n.colour].filter(Boolean).join(' — ');
    if (tip) m.bindTooltip(tip, { permanent: false, direction: 'top', className: 'map-tooltip' });
    m.on('click', () => {
      const nameStr = n.name ? ` ${n.name}` : '';
      const detail  = n.characteristic ? `, ${n.characteristic}` : n.colour ? `, ${n.colour}` : '';
      const base = `${n.label}${nameStr}${detail}`;
      _highlightAndSpeak(m,
        `${base}, ${bearingToDisplay(n.brg)}, ${distanceToDisplay(n.d)}`,
        `${base}, bearing ${bearingToWords(n.brg)}, ${formatDistance(n.d)}.`
      );
    });
    layers.push(m);
  }

  _mapLayers = L.layerGroup(layers).addTo(_map);
  const _curPos = GPS.getPosition();
  const allPts = [
    [lat, lon],
    ...(_curPos ? [[_curPos.lat, _curPos.lon]] : []),
    ...hazards.map(h => [h.lat, h.lon]),
    ...navaids.map(n => [n.lat, n.lon]),
  ];
  if (allPts.length > 1) {
    _map.fitBounds(L.latLngBounds(allPts).pad(0.25));
  } else {
    _map.setView([lat, lon], 14);
  }

  const total = hazards.length + navaids.length;
  const txt = total === 0
    ? `No hazards or navaids within ${radiusLabel}.`
    : `${total} object${total !== 1 ? 's' : ''} within ${radiusLabel}: ${hazards.length} hazard${hazards.length !== 1 ? 's' : ''}, ${navaids.length} navaid${navaids.length !== 1 ? 's' : ''}.`;
  showResponse(txt);
  TTS.sayImmediate(txt);
  if (total > 0) showNavaidList([...hazards, ...navaids]);
}

// ── Command handling ──────────────────────────────────────────────────────────

async function handleCommand(transcript) {
  // Parse first so we can gate on intent before touching any UI.
  const { intent, params } = parseCommand(transcript);

  // While TTS is speaking, silently drop anything that doesn't parse — covers
  // background noise, keyboard-mic feedback, and TTS audio picked up by the mic.
  if (TTS.isSpeaking() && intent === 'UNKNOWN') return;

  console.log('[AudioChart] handleCommand:', transcript);
  try {
    setStatus(`Command: "${transcript}"`);
    showResponse('...');
    addToHistory(transcript);

    if (intent === 'LIST_OBJECTS') {
      const response = {
        text:   'Hazards (rocks, ledges, shoals) · Buoys · Lights · Beacons · Restrictions (no-anchor, sanctuary) · Named places · Waypoints',
        speech: 'I can find hazards like rocks, ledges, and shoals; navigation aids including buoys, lights, and beacons; restricted areas like no-anchor zones and sanctuaries; and named places and OpenCPN waypoints for bearing queries.',
      };
      showResponse(response.text);
      TTS.sayImmediate(response.speech);
      return;
    }

    if (intent === 'LIST_WAYPOINTS') {
      const wps = loadUserWaypoints();
      if (!wps.length) {
        const msg = 'No waypoints saved yet. Right-click the map and choose Set waypoint here.';
        showResponse(msg);
        TTS.sayImmediate(msg);
        return;
      }
      const pos = GPS.getPosition();
      const rows = wps.map(wp => {
        if (pos) {
          const brg = trueTomagnetic(Query.bearing(pos.lon, pos.lat, wp.lon, wp.lat));
          const d   = Query.distanceNm(pos.lon, pos.lat, wp.lon, wp.lat);
          return { label: wp.name, brg, d };
        }
        return { label: wp.name, brg: null, d: null };
      });
      const textLines  = rows.map(r => r.brg != null ? `${r.label}: ${bearingToDisplay(r.brg)}, ${distanceToDisplay(r.d)}` : r.label);
      const speechLines = rows.map(r => r.brg != null ? `${r.label}, bearing ${bearingToWords(r.brg)}, ${formatDistance(r.d)}` : r.label);
      showResponse(textLines.join('\n'));
      showNavaidList(rows.map((r, i) => ({ label: wps[i].name, name: null, brg: r.brg ?? 0, d: r.d ?? 0, lat: wps[i].lat, lon: wps[i].lon })));
      showWaypointMap(pos?.lat ?? null, pos?.lon ?? null, wps).catch(() => {});
      TTS.sayImmediate(speechLines.join('. ') + '.');
      return;
    }

    if (intent === 'DELETE_WAYPOINT') {
      const name = params.waypointName;
      const wps = loadUserWaypoints();
      const idx = wps.findIndex(w => w.name.toLowerCase() === name);
      if (idx === -1) {
        const msg = `No waypoint named ${name}.`;
        showResponse(msg);
        TTS.sayImmediate(msg);
        return;
      }
      wps.splice(idx, 1);
      localStorage.setItem(USER_WP_KEY, JSON.stringify(wps));
      Query.removeUserWaypoint(name);
      _refreshWaypointLayer();
      const msg = `Waypoint ${name} deleted.`;
      showResponse(msg);
      TTS.sayImmediate(msg);
      return;
    }

    if (intent === 'OFFLINE_STATUS') {
      const result = await Query.offlineReadiness();
      showResponse(result.text);
      TTS.sayImmediate(result.speech);
      return;
    }

    if (intent === 'RUN_TEST') {
      const TESTS = {
        1: { lat: 44+5.5/60,  lon: -(69+0.5/60),  cmd: 'fix Rockland Breakwater Light 299 Two Bush Island Light 215',                    expected: '44°05.5\'N  069°00.6\'W  ·  Good fix  84°' },
        2: { lat: 44+3.0/60,  lon: -(69+3.0/60),  cmd: 'fix Grindstone Ledge Buoy 22 134 Monroe Island Lighted Bell Buoy 11 043',         expected: '44°03.0\'N  069°03.0\'W  ·  Good fix  89°' },
        3: { lat: 44+3.0/60,  lon: -(68+59.0/60), cmd: 'fix Rockland Breakwater Light 324 Two Bush Island Light 232',                    expected: '44°03.0\'N  068°59.1\'W  ·  Good fix  88°' },
        4: { lat: 44+4.0/60,  lon: -(68+59.0/60), cmd: 'fix Rockland Breakwater Light 314 Two Bush Island Light 227',                    expected: '44°04.0\'N  068°59.1\'W  ·  Good fix  87°' },
        5: { lat: 44+5.5/60,  lon: -(69+1.0/60),  cmd: 'fix Rockland Breakwater Light 301 Two Bush Island Light 213',                    expected: '44°05.5\'N  069°01.0\'W  ·  Good fix  88°' },
        6: { lat: 44+6.0/60,  lon: -(69+3.0/60),  cmd: 'fix Rockland Breakwater Light 296 Two Bush Island Light 202',                    expected: '44°06.0\'N  069°03.0\'W  ·  Good fix  86°' },
        // Deer Isle region
        7:  { lat: 44+2.0/60,  lon: -(68+40.0/60), cmd: 'fix Rock T Buoy 6 348 The Brandies Buoy 4 254',                                   expected: '44°02.0\'N  068°40.0\'W  ·  Good fix  94°' },
        8:  { lat: 44+2.0/60,  lon: -(68+48.0/60), cmd: 'fix Bunker Ledge Buoy 8 246 Old Duke Ledges Buoy 6 146',                          expected: '44°02.0\'N  068°48.0\'W  ·  Good fix  100°' },
        9:  { lat: 44+14.0/60, lon: -(68+30.0/60), cmd: 'fix Pond Island Passage Buoy 3 086 Blue Hill Bay Light 021',                       expected: '44°14.0\'N  068°30.0\'W  ·  Good fix  65°' },
        10: { lat: 44+6.0/60,  lon: -(68+40.0/60), cmd: 'fix North Bay Ledge Buoy 2 135 Ram Island Ledge Buoy 2 247',                      expected: '44°06.0\'N  068°40.0\'W  ·  Good fix  112°' },
        11: { lat: 44+12.0/60, lon: -(68+32.0/60), cmd: 'fix Mahoney Island Ledge Buoy 2 054 Channel Rock Buoy 5 341',                     expected: '44°12.0\'N  068°32.0\'W  ·  Good fix  73°' },
      };
      const t = TESTS[params.testNum];
      if (!t) { showResponse(`No test T${params.testNum}. Available: T1–T11.`); return; }
      GPS.setManualPosition(t.lat, t.lon);
      syncTestPosButton();
      showResponse(`T${params.testNum}: ${formatPositionDisplay(t.lat, t.lon)}\n${t.cmd}\nExpected: ${t.expected}`);
      await handleCommand(t.cmd);
      return;
    }

    if (intent === 'POSITION_FIX') {
      // If TTS is already speaking a result, the mic may have picked up "position fix…"
      // from the speaker. Don't interrupt the current speech.
      if (TTS.isSpeaking()) return;
      // Use lightweight normalization — skip full normalizePlaceName to avoid alias
      // cascades (e.g. "thorofare" alias mangling "deer island thorofare light station").
      const name1 = params.landmark1.toLowerCase().trim();
      const name2 = params.landmark2.toLowerCase().trim();

      // findLandmarkByName searches the static navaid.geojson which has proper
      // lighthouse names (the server API uses flash characteristics as names).
      let [lmA, lmB] = await Promise.all([
        Query.findLandmarkByName(name1),
        Query.findLandmarkByName(name2),
      ]);

      if (!lmA) {
        const msg = `Couldn't find "${name1}". Try the full name of a light, buoy, or landmark.`;
        showResponse(msg); TTS.sayImmediate(msg); return;
      }
      if (!lmB) {
        const msg = `Couldn't find "${name2}". Try the full name of a light, buoy, or landmark.`;
        showResponse(msg); TTS.sayImmediate(msg); return;
      }

      let fix;
      try {
        fix = Query.computePositionFix(lmA.lat, lmA.lon, params.bearing1, lmB.lat, lmB.lon, params.bearing2);
      } catch (e) {
        showResponse(e.message); TTS.sayImmediate(e.message); return;
      }

      const fixCoord = formatPositionDisplay(fix.lat, fix.lon);
      const latAbs = Math.abs(fix.lat), lonAbs = Math.abs(fix.lon);
      const latDeg = Math.floor(latAbs), latMin = ((latAbs - latDeg) * 60).toFixed(1);
      const lonDeg = Math.floor(lonAbs), lonMin = ((lonAbs - lonDeg) * 60).toFixed(1);
      const latDir = fix.lat >= 0 ? 'North' : 'South';
      const lonDir = fix.lon >= 0 ? 'East' : 'West';
      const fixSpeech = `${latDeg} degrees ${latMin} minutes ${latDir}, ${lonDeg} degrees ${lonMin} minutes ${lonDir}`;

      const displayText = `Position fix\n${lmA.name}  ${params.bearing1}°M\n${lmB.name}  ${params.bearing2}°M\n${fixCoord}  ·  ${fix.quality}  ${fix.crossing}°`;
      const speechText  = `Position fix: ${fixSpeech}. ${fix.quality}. Crossing angle ${fix.crossing} degrees.`;

      // Speak first — the TTS caption callback fires synchronously and would overwrite
      // the response element. Calling showResponse after locks in the concise display.
      TTS.sayImmediate(speechText);
      showResponse(displayText);
      showFixMap({ ...lmA, brgMag: params.bearing1 }, { ...lmB, brgMag: params.bearing2 }, fix).catch(() => {});
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
      case 'DEPTH_HERE': {
        const s = Query.nearestSounding(pos.lat, pos.lon);
        if (!s) {
          response = { text: 'No depth sounding data near this position.', speech: 'No depth sounding data near this position.' };
        } else {
          const chartedFt = (s.valsou * 3.28084).toFixed(1);
          const effM = s.valsou + _tideHeight;
          const effFt = (effM * 3.28084).toFixed(1);
          const tideFt = (_tideHeight * 3.28084).toFixed(1);
          const sign = _tideHeight >= 0 ? '+' : '';
          const text = `Charted depth: ${chartedFt} ft (MLLW)\nTide: ${sign}${tideFt} ft\nEffective depth: ~${effFt} ft`;
          const speech = `Charted depth ${chartedFt} feet. Current tide is ${sign}${tideFt} feet above mean low water, giving an effective depth of about ${effFt} feet.`;
          response = { text, speech };
        }
        break;
      }
      case 'LAND_DATA': {
        const info = Query.landDataInfo();
        response = { text: info, speech: info };
        break;
      }
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

    const isCourseIntent = (intent === 'HAZARDS_ON_COURSE' || intent === 'HAZARDS_ALONG_ROUTE');
    const isBearingIntent = (intent === 'BEARING_TO_PLACE' || intent === 'BEARING_TO_COORD');
    const isOtherMapIntent = ['NEAREST_HAZARD', 'NEAREST_NAVAID', 'NEAREST_RESTRICTION'].includes(intent);

    if (isBearingIntent && Query.lastBearingResult) {
      // Accumulate bearing lines — keep the most recent 6 (one per color).
      _bearingAccumulator.push({ fromLat: pos.lat, fromLon: pos.lon, result: Query.lastBearingResult });
      if (_bearingAccumulator.length > 6) _bearingAccumulator.shift();
      showMap(pos.lat, pos.lon, Query.lastBearingResult).catch(() => {});
      opencpnBtn.style.display = 'none';
    } else if (intent === 'WHERE_AM_I') {
      _bearingAccumulator = [];
      showPositionMap(pos.lat, pos.lon).catch(() => {});
      opencpnBtn.style.display = 'none';
    } else if (isCourseIntent && _lastCourseFrom) {
      _bearingAccumulator = [];
      showCourseMap(_lastCourseFrom.lat, _lastCourseFrom.lon, _lastCourseTo.lat, _lastCourseTo.lon, Query.lastCourseHazards).catch(() => {});
      if (serverUrl) opencpnBtn.style.display = 'inline-block';
    } else if (isOtherMapIntent && Query.lastBearingResult) {
      _bearingAccumulator = [];
      showMap(pos.lat, pos.lon, Query.lastBearingResult).catch(() => {});
      opencpnBtn.style.display = 'none';
    } else {
      _bearingAccumulator = [];
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
  let raw = testPosInput.value.trim();
  // Empty input → use first stop of the active cruise region as default
  if (!raw) {
    const defaultStop = CRUISE_PROFILES[_activeCruiseName]?.stops[0];
    if (!defaultStop) return;
    raw = defaultStop.name;
  }
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
    await loadLeaflet();
    _ensureMap();
    textInput.blur();
    document.getElementById('map-container').style.display = 'block';
    _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
    _showBoatPosition(coord.lat, coord.lon);
    setTimeout(() => {
      _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
      _map.invalidateSize();
      _map.panTo([coord.lat, coord.lon]);
    }, 300);
    _runWhereAmI(coord.lat, coord.lon);
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
  _clearBoatPosition();
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
  _activeCruiseName = cruiseName;
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
    // Prefetch tide/current for each stop
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      routeBtn.textContent = `🌊 ${i + 1}/${stops.length}`;
      await _prefetchTideCurrentForOffline(stop.lat, stop.lon, msg => setStatus(`${stop.name}: ${msg}`));
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
    routeBtn.textContent = `🌊 ${i + 1}/${stops.length}`;
    await _prefetchTideCurrentForOffline(stop.lat, stop.lon, msg => setStatus(`${stop.name}: ${msg}`));
  }
  routeBtn.textContent = '✓ Route cached';
  setStatus(`${cruiseName} route complete — ${lastResult.total} features + satellite tiles cached.`);
  routeBtn.disabled = false;
  if (offlineBtn) offlineBtn.disabled = false;
  checkOnboarding();
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {
  _loadOfflineCache();
  setStatus('Waiting for GPS...');

  // On desktop, show the map immediately so the sidebar sits on the right
  if (window.innerWidth >= 768) {
    loadLeaflet().then(() => { _ensureMap(); _map.invalidateSize(); }).catch(() => {});
  }

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
        offlineBtn.textContent = '⏳ Tide/current…';
        await _prefetchTideCurrentForOffline(pos.lat, pos.lon, msg => setStatus(msg));
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
      Query.mergeUserWaypoints(loadUserWaypoints());
      setStatus('Ready. (offline)');
    }).catch(() => {});
  }

  GPS.startGPS(
    async (lat, lon, accuracy, source) => {
      showPosition(lat, lon, accuracy, source);
      _refreshYouLayer();
      if (_animFollowMode && _map) _map.panTo([lat, lon]);
      if (!gpsReady) {
        gpsReady = true;
        setStatus('Loading chart data for your position...');
        try {
          await Query.loadData(lat, lon);
          dataLoaded = true;
          Query.mergeUserWaypoints(loadUserWaypoints());
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
    navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`).catch(() => {});
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
