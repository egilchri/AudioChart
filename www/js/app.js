/**
 * AudioChart — main application entry point.
 * Input: text box (use phone keyboard mic for voice-to-text on Pixel).
 * Output: spoken TTS + on-screen text.
 */

import * as TTS from './tts.js';
import * as GPS from './gps.js';
import { parseCommand, parseCoordinate, normalizePlaceName, parseFromToQuery } from './parser.js';
import * as Query from './query.js';
import * as DriveSync from './drive_sync.js';
import { openDriveImportPicker } from './drive_import.js';
import { migrateLegacyIds } from './sync_merge.js';
import { splitIntoLegs } from './route_legs.js';

const VERSION = window.APP_VERSION;
document.getElementById('app-version').textContent = VERSION;
document.getElementById('map-version-label').textContent = VERSION;

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

// Discreet variant for soft/shallow route-check markers (_checkRouteHazards)
// — same yellow-triangle-with-! asset (the international caution symbol,
// per user request) as the general hazard layer above, just sized down and
// without the skull's pulse, so it reads as "worth a glance" rather than
// "stop and look." A skull for a merely draft/tide-dependent shallow patch
// was the wrong signal — reserved for hard hazards (rock/obstruction/wreck).
function _softHazardMarkerIcon() {
  return L.icon({ iconUrl: './icons/markicons/Hazard-Warning.svg', iconSize: [16, 16], iconAnchor: [8, 8], tooltipAnchor: [0, -8] });
}

// ── Hazard marker clustering ────────────────────────────────────────────────
// A rock-strewn stretch of the Maine coast can put a dozen+ charted hazards
// within a few boat-lengths of each other — real example: a 0.25nm long-press
// query near North Haven returning 16+ overlapping triangle icons, unreadable
// as a pile. Individual hazards still render normally when they're not
// crowded; only markers close enough on SCREEN (not nautical distance — this
// is purely a rendering fix, every hazard is still full-accuracy queryable
// data underneath, just visually merged) at the current zoom get replaced by
// one soft-edged blob. Re-clusters on zoom so zooming in un-merges them.

let _hazardClusterZoomHandler = null;

/** Union-find clustering of `points` ({lat,lon}[]) by on-screen pixel distance
 * at the map's current zoom/pan. Returns arrays of indices into `points`.
 * Grid-bucketed (cell size = pixelRadius, each point only compared against
 * its own + 8 neighboring cells) rather than the naive all-pairs check —
 * Penobscot Bay alone charts thousands of point hazards, and a full-bay
 * viewport can put a real fraction of those on screen at once; plain
 * all-pairs comparison at that count is a genuine multi-second main-thread
 * hang, not just an inefficiency (found live-testing this feature). */
function _clusterIndicesByPixel(map, points, pixelRadius) {
  const n = points.length;
  const px = points.map(p => map.latLngToContainerPoint([p.lat, p.lon]));
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const cell = Math.max(pixelRadius, 1);
  const cellKey = (cx, cy) => `${cx},${cy}`;
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(px[i].x / cell), cy = Math.floor(px[i].y / cell);
    const k = cellKey(cx, cy);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const r2 = pixelRadius * pixelRadius;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(px[i].x / cell), cy = Math.floor(px[i].y / cell);
    for (let dcx = -1; dcx <= 1; dcx++) {
      for (let dcy = -1; dcy <= 1; dcy++) {
        const neighbors = grid.get(cellKey(cx + dcx, cy + dcy));
        if (!neighbors) continue;
        for (const j of neighbors) {
          if (j <= i) continue; // each unordered pair checked once, still symmetric via union()
          const dx = px[i].x - px[j].x, dy = px[i].y - px[j].y;
          if (dx * dx + dy * dy <= r2) union(i, j);
        }
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()];
}

function _hazardBlobIcon(count) {
  // Deliberately NOT sized to the cluster's real pixel spread — a bug found
  // live (2026-08-23): sizing the blob to maxD-of-members meant that when
  // the DOM-count safety valve (below) widens the grouping radius on a
  // hazard-dense view, every resulting blob (and its blur halo) ballooned
  // to match, and dozens of huge overlapping halos washed the whole chart
  // in a continuous orange fog instead of reading as distinct local blobs.
  // A small, count-driven size — same convention as any standard map
  // marker cluster — stays legible and local regardless of how far apart
  // the real members ended up; clicking still zooms to the members' real
  // bounds (see _renderClusteredHazards), which is how more detail actually
  // surfaces — no on-blob count/text (user feedback 2026-08-23: the number
  // badges read as clutter of their own; the exact count is still in the
  // tooltip on hover/tap, just not permanently painted on the map).
  const r = Math.min(10 + Math.sqrt(count) * 2.5, 22);
  const size = r * 2;
  const blurId = `hazBlur${Math.round(r)}`;
  const svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="${blurId}" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="${Math.max(r * 0.1, 1.5)}" />
    </filter></defs>
    <circle cx="${r}" cy="${r}" r="${r * 0.85}" fill="#f5c842" fill-opacity="0.88" filter="url(#${blurId})" />
  </svg>`;
  return L.divIcon({ className: 'hazard-blob-marker', html: svg, iconSize: [size, size], iconAnchor: [r, r] });
}

/** Renders hazardPts into layerGroup: an isolated hazard gets its normal
 * marker (makeMarker(h) — identical to what each caller already built
 * before this existed), a screen-crowded group gets one blob instead;
 * clicking a blob zooms in on it (which re-clusters via the zoomend
 * listener below and reveals the real markers once they're no longer
 * crowded — nothing is ever hidden permanently or dropped from the data). */
function _renderClusteredHazards(map, layerGroup, hazardPts, makeMarker) {
  // A whole-bay, zoomed-out view can have hundreds/thousands of hazards
  // spread widely enough on screen that a small cluster radius barely merges
  // any of them — still one real DOM marker+SVG icon per point, which is a
  // genuine multi-second freeze at that count regardless of how fast the
  // clustering math itself is. Below MAX_HAZARD_MARKERS use a tight radius
  // (merge only truly-crowded icons, keep isolated ones exact); above it,
  // widen the radius until the marker count actually produced drops under
  // the cap — trading precision for a bounded number of DOM nodes only when
  // the point count demands it.
  const MAX_HAZARD_MARKERS = 250;
  if (_hazardClusterZoomHandler) { map.off('zoomend', _hazardClusterZoomHandler); _hazardClusterZoomHandler = null; }
  function render() {
    layerGroup.clearLayers();
    if (!hazardPts.length) return;
    let clusterPx = 26; // roughly one hazard-icon width
    let groups = _clusterIndicesByPixel(map, hazardPts, clusterPx);
    for (let guard = 0; groups.length > MAX_HAZARD_MARKERS && guard < 8; guard++) {
      clusterPx *= 2;
      groups = _clusterIndicesByPixel(map, hazardPts, clusterPx);
    }
    for (const idxs of groups) {
      if (idxs.length === 1) { makeMarker(hazardPts[idxs[0]]).addTo(layerGroup); continue; }
      const members = idxs.map(i => hazardPts[i]);
      const pxPts = members.map(h => map.latLngToContainerPoint([h.lat, h.lon]));
      const cx = pxPts.reduce((s, p) => s + p.x, 0) / pxPts.length;
      const cy = pxPts.reduce((s, p) => s + p.y, 0) / pxPts.length;
      L.marker(map.containerPointToLatLng([cx, cy]), {
        icon: _hazardBlobIcon(members.length), zIndexOffset: 500,
      }).bindTooltip(`${members.length} hazards — tap to expand`, {
        permanent: false, direction: 'top', className: 'map-tooltip',
      }).on('click', () => map.fitBounds(L.latLngBounds(members.map(h => [h.lat, h.lon])).pad(0.6)))
        .addTo(layerGroup);
    }
  }
  render();
  _hazardClusterZoomHandler = render;
  map.on('zoomend', _hazardClusterZoomHandler);
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

// The ⛵ glyph is a side-profile boat with the sail/jib leading to the LEFT (screen-west)
// in its neutral, hull-down orientation. A single continuous rotation can't represent every
// heading without passing through upside-down/capsized-looking orientations for half the
// compass. Instead, mirror the glyph horizontally for the eastward half of the compass (so
// it always faces "forward" toward its target half — left or right) and rotate by at most
// ±90° from that horizontal reference, so the hull never flips above the sail.
function _boatIconTransform(bearingDeg) {
  const b = ((bearingDeg % 360) + 360) % 360;
  const facingRight = b >= 0 && b <= 180;
  const rotation = facingRight ? (b - 90) : (b - 270);
  return facingRight ? `rotate(${rotation}deg) scaleX(-1)` : `rotate(${rotation}deg)`;
}

function _animBoatIcon(bearingDeg = 0) {
  return L.divIcon({
    className: '',
    html: `<div class="anim-boat" style="transform:${_boatIconTransform(bearingDeg)}"><span class="anim-boat-rock">⛵</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    tooltipAnchor: [14, -14],
  });
}

// Place a text label offset perpendicular to a route point, with a solid leader line
// and an arrowhead whose tip points to the route.
// side: +1 = right of trueBrg, -1 = left.  offsetNm in nautical miles.
function _addLeaderLabel(layer, anchorLat, anchorLon, trueBrg, side, offsetNm, html, cssClass) {
  const perpBrg = ((trueBrg + side * 90) + 360) % 360;
  const oLat = anchorLat + offsetNm * Math.cos(perpBrg * Math.PI / 180) / 60;
  const oLon = anchorLon + offsetNm * Math.sin(perpBrg * Math.PI / 180) / 60 / Math.cos(anchorLat * Math.PI / 180);

  // Solid leader line from label to route
  L.polyline([[oLat, oLon], [anchorLat, anchorLon]], {
    color: '#6aaad4', weight: 1.5, opacity: 0.7, interactive: false,
  }).addTo(layer);

  // Arrowhead at the route end: SVG triangle, tip pinned to anchor via transform-origin.
  // perpBrg goes from anchor → label, so arrowBrg = +180° = direction pointing back to route.
  const arrowBrg = (perpBrg + 180) % 360;
  L.marker([anchorLat, anchorLon], {
    icon: L.divIcon({
      className: '',
      html: `<svg style="transform:rotate(${arrowBrg}deg);transform-origin:6px 0px"
                  width="12" height="12" viewBox="0 0 12 12"
                  xmlns="http://www.w3.org/2000/svg">
               <polygon points="6,0 0,11 12,11" fill="#6aaad4" fill-opacity="0.85"/>
             </svg>`,
      iconSize: [12, 12],
      iconAnchor: [6, 0],
    }),
    interactive: false,
  }).addTo(layer);

  // Label at offset position, centered on its anchor point
  L.marker([oLat, oLon], {
    icon: L.divIcon({ className: '', html: `<div class="${cssClass}">${html}</div>`, iconSize: [0, 0], iconAnchor: [0, 0] }),
    interactive: false,
  }).addTo(layer);
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
  if (_simTrackMode) _exitSimTrackMode();
  if (_boatLayer) { _map.removeLayer(_boatLayer); _boatLayer = null; }
  const marker = L.marker([lat, lon], { icon: _boatIcon(), zIndexOffset: 1000, draggable: true });

  marker.on('contextmenu', (e) => e.originalEvent.stopPropagation());
  marker.on('drag', (e) => {
    const { lat: dLat, lng: dLon } = e.target.getLatLng();
    _updateBearingLines(dLat, dLon);
    _updateFocusRay(dLat, dLon);
  });
  marker.on('dragend', (e) => {
    const { lat: newLat, lng: newLon } = e.target.getLatLng();
    GPS.setManualPosition(newLat, newLon);
    syncTestPosButton();
    _updateFocusRay();
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
  _updateFocusRay();
}

function _clearBoatPosition() {
  if (_boatLayer && _map) { _map.removeLayer(_boatLayer); _boatLayer = null; }
  _refreshYouLayer();
  _updateFocusRay();
}

function _refreshYouLayer() {
  if (!_map) return;
  if (_youLayer) { _map.removeLayer(_youLayer); _youLayer = null; }
  if (_boatLayer) return; // test position already shown by boat layer
  const pos = GPS.getPosition();
  if (!pos) return;
  const icon = _simTrackMode ? _animBoatIcon(_simTrackDeg) : _boatIcon();
  const m = L.marker([pos.lat, pos.lon], { icon, zIndexOffset: 800 });

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
      m.bindPopup(
        `<div class="navaid-popup">
           <div class="navaid-popup-name">${wp.name}</div>
           <button class="navaid-popup-focus">&#127919; Set focus</button>
         </div>`,
        { maxWidth: 220, className: 'navaid-popup-wrapper' }
      );
      m.on('popupopen', (e) => {
        e.popup.getElement().querySelector('.navaid-popup-focus').addEventListener('click', () => {
          _map.closePopup();
          Query.setFocus(wp.lat, wp.lon, wp.name, 'waypoint');
          _updateFocusButton();
          const msg = `Focused on ${wp.name}.`;
          showResponse(msg);
          TTS.sayImmediate(msg);
        });
      });
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
import { formatPositionDisplay, bearingToWords, bearingToDisplay, formatDistance, distanceToDisplay, trueTomagnetic, magneticToTrue, magneticVariation } from './utils.js';

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
const responseAreaEl = document.getElementById('response-area');
const navaidListEl = document.getElementById('navaid-list');
const gpsStatusEl = document.getElementById('gps-status');
const coverageStatusEl = document.getElementById('coverage-status');
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
const focusBtn = document.getElementById('focus-btn');
const trackRecBtn = document.getElementById('track-rec-btn');
const wakeLockBtn = document.getElementById('wake-lock-btn');
const clearScreenBtn = document.getElementById('clear-screen-btn');

function _updateFocusButton() {
  if (!focusBtn) return;
  const f = Query.focusedTarget;
  focusBtn.textContent = f ? `🎯 ${f.name || 'Point'}` : '🎯 --';
  focusBtn.classList.toggle('focus-active', !!f);
  focusBtn.title = f ? `Bearing & range to ${f.name || 'focused point'}` : 'No focus set';
  _syncFocusMarker();
  _updateFocusRay();
}

focusBtn?.addEventListener('click', () => {
  if (!Query.focusedTarget) {
    TTS.sayImmediate('No focus set. Say focus on, followed by a place name.');
    return;
  }
  handleCommand('bearing');   // reuses the QUERY_FOCUS path end-to-end
});

// Show every TTS utterance in the response area so the user can read along.
TTS.onSpeak(text => { _appendTranscript(text); });

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

// Hand-authored — no feature registry exists to introspect. Shown in the
// About panel (tap either version label); keep short, update when a major
// feature ships.
const ABOUT_FEATURES = [
  'Voice &amp; text queries — bearings, nearest hazard/navaid, depth here',
  'Auto-route around land, hazards, and tidal drying zones',
  'Tide-aware depth overlay with your draft',
  'Fully offline once chart data is downloaded',
  'Google Drive sync for routes and tracks',
];

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
let _focusRayLine = null;   // ray from the boat toward the current focus target
let _headingRayLine  = null; // live direction-of-travel ray (course over ground)
let _headingRayArrow = null; // arrowhead marker at the tip of _headingRayLine
let _headingSpeedEl  = null; // DOM element of the heading/speed readout control
let _followProgressEl = null; // DOM element of the route-follow progress readout control
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
let _liveHazardTimer       = null;
let _newVertexIdx          = -1;  // index of freshly inserted vertex — flashes until dragged
let _deleteMode            = false; // single-click on vertex deletes it
let _addNodeMode           = false; // waiting for click to insert node into nearest segment
let _overnightMode         = false; // single-click on vertex toggles it as an overnight stop
let _fixNodesMode          = false; // single-click on vertex fixes hazards near just that node — stays armed like delete/overnight
let _selectedEditNodeIdx   = new Set(); // indices into _editPoints "lit" — fixed (or checked) this edit session; purely visual, not saved route data
let _growRouteIdx          = -1;    // index of route being grown; -1 = not in grow mode
let _editHistory           = [];    // stack of _editPoints snapshots for undo
let _editOriginalPoints    = [];    // snapshot of route.points as last saved, taken when edit mode was entered

let _populateRouteSelectFn = null; // set by _ensureMap once DOM is ready
let _buildRoutePickerPanelFn = null; // set by _ensureMap once DOM is ready — see _populateRouteSelectFn
let _buildTrackPickerPanelFn = null; // set by _ensureMap once DOM is ready — see _buildRoutePickerPanelFn
let _savedRoutesLayer  = null;
let _hiddenRouteNames  = new Set();
let _savedTracksLayer     = null;
let _hiddenTrackNames     = new Set();
let _expandedRouteRowName = null;   // which Routes panel row (if any) shows Rename/Export
let _expandedTrackRowName = null;   // same, for the Tracks panel
let _trackRecActive       = false;  // true while recording a GPS breadcrumb track
let _trackRecPoints       = [];     // [{lat, lon, t}]
let _trackRecStartMs      = null;
let _trackRecLastSampleTs = 0;
// Once any track recording (auto or manual) has started this session, don't
// auto-start another — avoids re-triggering the moment a manually-stopped
// track's next real fix comes in. A fresh page load resets this, which is
// fine: _recoverInProgressTrack() runs first and either resumes (setting
// _trackRecActive itself) or the user explicitly discards, both of which
// should allow a genuinely new voyage to auto-start its own track.
let _autoTrackEverStarted = false;
// "Follow route" — a route-linked track recording (see _startFollowingRoute)
// distinct from a plain manual recording: auto-named, and auto-stopped on
// arrival at the route's final waypoint.
let _followingRouteId     = null;
let _followingRouteName   = null;
let _followingDestLat     = null;
let _followingDestLon     = null;
let _followingLegIdx      = 1; // index of the next not-yet-reached waypoint in the followed route
const ARRIVAL_THRESHOLD_NM = 0.1; // ~600ft — comfortably above typical GPS drift
let _extendingRouteIdx = -1;
let _extendingFromEnd  = true;
let _ctxRouteIdx       = -1;  // last route hovered; used by context-menu actions
let _selectedRouteIdx  = -1;  // route clicked/highlighted on map
let _hazardCheckLayer       = null; // temporary markers from Check for Hazards
let _lastHazardCheckedIdx   = -1;  // route idx of most recent hazard check, for auto-recheck after save
let _autoRouteStart        = null;
let _autoRouteEnd          = null;
let _autoRouteName         = null;
let _autoRouteStartMarker  = null;
let _autoRouteEndMarker    = null;
let _autoRoutePreviewLayer = null;
let _drawMode        = false;
let _drawStart       = null;
let _drawEnd         = null;
let _drawRubber      = null;
let _drawName        = null;
let _drawTouchStart  = null;
let _drawTouchMove   = null;
let _drawTouchEnd    = null;
let _drawMapClick    = null;
let _drawMapMouseMove = null;
let _drawMapMouseDown = null;
let _drawMapMouseUp   = null;
// Map dragging is disabled while placing a route point (so a stray drag
// can't be misread as a click elsewhere) — but that also blocks the normal
// way to pan toward an off-screen destination mid-placement. These track
// whether the current press-and-move has gone far enough to count as a
// pan rather than a tap, so it can be panned manually instead.
let _drawGestureStartPt = null;
let _drawGestureLastPt  = null;
let _drawIsPanning      = false;
const _TAP_TOLERANCE_PX = 15; // press-and-move-far-enough-to-count-as-a-pan threshold; shared with sketch mode
let _focusPlaceMode   = false;  // true while the drag-to-place focus marker is live
let _focusPlaceMarker = null;   // the draggable L.marker being positioned
let _focusPlaceSnap   = null;   // {lat, lon, name, type} of the locked-on object, or null
let _focusMarker      = null;   // persistent, always-draggable marker for the current focus
let _simTrackMode       = false;  // true while the Simulate Track aiming/running UI is active
let _simTrackRunning    = false;  // true only once Start has been pressed and the DR loop is animating
let _simTrackHandle     = null;   // draggable marker at the course ray's endpoint (aiming phase only)
let _simTrackRay        = null;   // dashed preview ray shown while aiming
let _simTrackLine       = null;   // solid track trail shown once running (start -> current position)
let _simTrackBoatMarker = null;   // separate moving boat icon, decoupled from the real GPS/test-position marker
let _simTrackDeg        = 0;      // simulated course, TRUE degrees, 0-359 — locked once running
let _simTrackLenNm      = 5;      // preview ray length in nm, locked in at mode-entry
let _simTrackBoat       = null;   // {lat, lon} captured when the mode was entered — the DR start point
let _simTrackSpeedKts   = 5;      // simulated speed, knots
let _simTrackCompress   = 10;     // time-compression multiplier
let _simTrackTraveledNm = 0;      // nm traveled so far along the course (persists across Stop)
let _simTrackBaselineNm = 0;      // traveled-nm snapshot taken at the start of the current run segment
let _simTrackRunStartMs = null;   // rAF timestamp anchor for the current run segment
let _simTrackRafId      = null;
const SIM_TRACK_DEFAULT_NM = 5;
let _viewportHazardLayer    = null; // hazard markers for current map viewport (edit mode)
let _viewportHazardMoveEnd  = null; // moveend listener ref for cleanup
let _routeNameLabels        = [];   // [{marker, pts}] for viewport-clamping on moveend
let _routeNameMoveEndWired  = false;
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
// Cycled by tapping map-layer-btn: street chart → satellite → USGS bedrock geology
// (self-contained WMS raster) → Maine bedrock geology (state survey's own, richer
// vector data — no basemap of its own, shown as an overlay on the street chart) → back.
const MAP_VIEW_MODES  = ['chart', 'satellite', 'geology-usgs', 'geology-maine'];
let _mapViewMode      = MAP_VIEW_MODES.includes(localStorage.getItem('audiochart-chart-mode'))
  ? localStorage.getItem('audiochart-chart-mode') : 'satellite';
let _maineGeologyLayer      = null;
let _maineGeologyMoveEnd    = null;
let _maineGeologyFetchToken = 0;
let _wakeLockEnabled  = localStorage.getItem('audiochart-wake-lock') !== 'false'; // on by default
let _wakeLockSentinel = null;   // the live WakeLockSentinel, or null when not currently held
let _wakeLockWarned   = false;  // suppresses repeated warnings for the same ongoing failure
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

window._debugAutoRoute = (start, end) => _autoRouteProg(start, end, () => {}, () => {});
window._debugResolveWaterEnd = (lon, lat, which) => Query.resolveWaterEnd(lon, lat, which);
window._debugEnterEditMode = (idx) => _enterEditMode(idx);
window._debugCheckRouteHazards = (idx, silent) => _checkRouteHazards(idx, silent);
window._debugMap = () => _map;
window._debugLiveHazardCheck = () => _liveHazardCheck();
window._debugShowRouteFallbackWarning = (fallbackSegs) => _showRouteFallbackWarning(fallbackSegs);

// Deletes routes by exact name through the same path as the Routes panel's
// per-row delete button (tombstones each one, so Drive sync won't resurrect
// them) without the confirm() prompt — for bulk cleanup of test/junk routes.
window._debugDeleteRoutesByName = (names) => {
  const nameSet = new Set(names);
  const all = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const toDelete = all.filter(r => nameSet.has(r.name));
  toDelete.forEach(r => {
    _tombstone(r.id, 'route');
    _hiddenRouteNames.delete(r.name);
    if (localStorage.getItem('audiochart-last-route') === r.name) localStorage.removeItem('audiochart-last-route');
  });
  localStorage.setItem(ROUTE_KEY, JSON.stringify(all.filter(r => !nameSet.has(r.name))));
  _saveHiddenRoutes();
  _refreshSavedRouteLayers();
  _populateRouteSelectFn?.();
  _buildRoutePickerPanelFn?.();
  return toDelete.map(r => r.name);
};

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
// Clicking the response area (list) → list expands, map shrinks. If it's collapsed
// to its thin one-line remnant, a tap anywhere on it re-expands instead.
document.getElementById('response-area').addEventListener('click', () => {
  if (responseAreaEl.classList.contains('collapsed')) { _expandResponseArea(); return; }
  if (_mapContainer.classList.contains('map-compact'))
    _mapContainer.classList.add('list-focus');
});
// Shrink the transcript to a thin tappable bar when it's in the way — never fully
// vanishes, so there's always a visible, obvious way back (standard bottom-sheet
// "peek" pattern). Reappears at full size on the next response/utterance.
document.getElementById('response-close-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  _collapseResponseArea();
});
_addSwipeToClose(responseAreaEl, _collapseResponseArea, 'y');

// Swipe-to-close for panels/banners whose only other dismiss control is a small × button.
// `axis` is the direction that closes it: 'x' swipes right (floating panels near the
// right edge), 'y' swipes down (bottom-docked banners). Live-follows the finger with a
// fade, snaps back if released short of the threshold, animates away if past it.
function _addSwipeToClose(el, closeFn, axis = 'x', excludeSelector = null) {
  const THRESHOLD = 70;
  let startX = 0, startY = 0, tracking = false;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (excludeSelector && e.target.closest(excludeSelector)) return; // e.g. the draggable title bar
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
    el.style.transition = 'none';
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    const primary = axis === 'x' ? dx : dy;
    const cross   = axis === 'x' ? dy : dx;
    if (Math.abs(cross) > Math.abs(primary) * 1.2) { tracking = false; el.style.transform = ''; el.style.opacity = ''; return; }
    const clamped = Math.max(0, primary); // only follow in the closing direction
    el.style.transform = axis === 'x' ? `translateX(${clamped}px)` : `translateY(${clamped}px)`;
    el.style.opacity = String(Math.max(0.3, 1 - clamped / 200));
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = (t?.clientX ?? startX) - startX;
    const dy = (t?.clientY ?? startY) - startY;
    const primary = axis === 'x' ? dx : dy;
    el.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
    if (primary > THRESHOLD) {
      el.style.transform = axis === 'x' ? 'translateX(120%)' : 'translateY(120%)';
      el.style.opacity = '0';
      setTimeout(() => {
        closeFn();
        el.style.transition = '';
        el.style.transform = '';
        el.style.opacity = '';
      }, 200);
    } else {
      el.style.transform = '';
      el.style.opacity = '';
    }
  });
}

// Drag-to-reposition for floating panels, so they can be moved out of the way — grab
// `handleEl` (its title bar) and drag; position is clamped to stay on-screen. Works with
// both touch and mouse. Position sticks for the rest of the page session (the panel is
// just hidden/shown via display, never removed, so the inline left/top persist).
function _makeDraggable(panelEl, handleEl) {
  let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;

  function begin(clientX, clientY) {
    dragging = true;
    startX = clientX;
    startY = clientY;
    const rect = panelEl.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    panelEl.style.transition = 'none';
  }
  function moveTo(clientX, clientY) {
    if (!dragging) return;
    const w = panelEl.offsetWidth, h = panelEl.offsetHeight;
    const newLeft = Math.max(4, Math.min(window.innerWidth  - w - 4, origLeft + (clientX - startX)));
    const newTop  = Math.max(4, Math.min(window.innerHeight - h - 4, origTop  + (clientY - startY)));
    panelEl.style.left   = `${newLeft}px`;
    panelEl.style.top    = `${newTop}px`;
    panelEl.style.right  = 'auto';
    panelEl.style.bottom = 'auto';
  }
  function end() { dragging = false; }

  handleEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    begin(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  handleEl.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    e.preventDefault(); // suppress page scroll while actively dragging
    moveTo(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  handleEl.addEventListener('touchend', end);

  handleEl.addEventListener('mousedown', (e) => {
    begin(e.clientX, e.clientY);
    const onMove = (ev) => moveTo(ev.clientX, ev.clientY);
    const onUp = () => { end(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Rearrange mode: drag any permanent UI element out of the way ───────────────
// Tapping the "Rearrange" button (map-overlay-status) enters a global mode, like
// iOS home-screen icon jiggle: every group gets a dashed outline + jiggle and can
// be dragged; normal taps are suppressed everywhere until "Done" is tapped.
// Related buttons that are visually one unit move together.
//
// This used to be entered via a 600ms long-press on any grouped element instead
// of a dedicated button — dropped because a real tap that lingers past 600ms
// (slow touch release, a brief pause while reading a tooltip) silently hijacked
// the tap into a drag instead of firing the button, with no visible cause.
// Reported live: "the long press to move ui elements feature keeps interfering
// with normal operations."
let _rearrangeMode = false;

function _enterRearrangeMode() {
  if (_rearrangeMode) return;
  _rearrangeMode = true;
  _appEl.classList.add('rearrange-mode');
  const banner = document.getElementById('rearrange-banner');
  if (banner) banner.style.display = 'flex';
}
function _exitRearrangeMode() {
  _rearrangeMode = false;
  _appEl.classList.remove('rearrange-mode');
  const banner = document.getElementById('rearrange-banner');
  if (banner) banner.style.display = 'none';
}
document.getElementById('rearrange-btn')?.addEventListener('click', _enterRearrangeMode);
document.getElementById('rearrange-done-btn')?.addEventListener('click', _exitRearrangeMode);

// Suppress normal tap actions everywhere while rearranging — a single capture-phase
// interceptor instead of guarding every individual button's own click handler.
document.addEventListener('click', (e) => {
  if (!_rearrangeMode) return;
  if (e.target.closest('#rearrange-done-btn') || e.target.closest('#rearrange-reset-btn')) return;
  e.stopPropagation();
  e.preventDefault();
}, true);

function _clampGroupOffset(els, candidateDx, candidateDy, appliedDx, appliedDy) {
  let dx = candidateDx, dy = candidateDy;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const naturalLeft = r.left - appliedDx, naturalTop = r.top - appliedDy;
    const w = el.offsetWidth, h = el.offsetHeight;
    dx = Math.min(Math.max(dx, 4 - naturalLeft), window.innerWidth  - w - 4 - naturalLeft);
    dy = Math.min(Math.max(dy, 4 - naturalTop),  window.innerHeight - h - 4 - naturalTop);
  }
  return { dx, dy };
}

// Registers one draggable group: `getEls()` is called lazily (not at setup time) since
// some groups (the Leaflet-Control widgets) don't exist until the map is built. The
// offset is a CSS variable (--ui-pos-<groupId>) referenced by each element's own
// `transform` rule in app.css — a transform doesn't care whether the element underneath
// is positioned bottom/right, top/left, or lives inside Leaflet's control-container flex
// layout, so this works uniformly across every kind of element without detaching anything.
const _draggableGroupResetters = [];

function _resetUiPositions() {
  for (const reset of _draggableGroupResetters) reset();
}
document.getElementById('rearrange-reset-btn')?.addEventListener('click', _resetUiPositions);

function _makeDraggableGroup(groupId, getEls) {
  let curDx = 0, curDy = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(`audiochart-ui-pos-${groupId}`) || 'null');
    if (saved) { curDx = saved.dx; curDy = saved.dy; }
  } catch (_) {}

  // Exclude currently display:none elements (e.g. #delete-route-btn outside edit mode) —
  // a hidden element's getBoundingClientRect() is a zero-size rect at (0,0), which would
  // otherwise corrupt the clamp math for the rest of the group.
  const currentEls = () => getEls().filter(el => el && el.offsetParent !== null);
  const applyOffset = (dx, dy) => _appEl.style.setProperty(`--ui-pos-${groupId}`, `translate(${dx}px, ${dy}px)`);
  applyOffset(curDx, curDy); // restore any saved position immediately

  _draggableGroupResetters.push(() => {
    curDx = 0; curDy = 0;
    localStorage.removeItem(`audiochart-ui-pos-${groupId}`);
    applyOffset(0, 0);
  });

  let dragging = false;
  let startX = 0, startY = 0, baseDx = 0, baseDy = 0, origins = [];

  function begin(clientX, clientY) {
    dragging = true;
    startX = clientX; startY = clientY;
    baseDx = curDx; baseDy = curDy;
    origins = currentEls();
  }
  function moveTo(clientX, clientY) {
    if (!dragging) return;
    const { dx, dy } = _clampGroupOffset(origins, baseDx + (clientX - startX), baseDy + (clientY - startY), baseDx, baseDy);
    curDx = dx; curDy = dy;
    applyOffset(dx, dy);
  }
  function end() {
    if (!dragging) return;
    dragging = false;
    localStorage.setItem(`audiochart-ui-pos-${groupId}`, JSON.stringify({ dx: curDx, dy: curDy }));
  }

  // Dragging only ever starts once _rearrangeMode is already on (entered via the
  // "Rearrange" button) — outside rearrange mode these are plain buttons and every
  // touch/mouse event here is a no-op, so a normal tap is never intercepted.
  currentEls().forEach(el => {
    el.classList.add('ui-drag-target');

    el.addEventListener('touchstart', (e) => {
      if (!_rearrangeMode || e.touches.length !== 1) return;
      const t = e.touches[0];
      begin(t.clientX, t.clientY);
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      e.preventDefault();
      moveTo(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);

    el.addEventListener('mousedown', (e) => {
      if (!_rearrangeMode) return;
      begin(e.clientX, e.clientY);
      const onMove = (ev) => moveTo(ev.clientX, ev.clientY);
      const onUp = () => {
        end();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  // Re-clamp on viewport resize/orientation change so a previously-dragged group
  // never ends up off-screen (relevant on a boat tablet/phone that may rotate).
  window.addEventListener('resize', () => {
    const els = currentEls();
    if (!els.length) return;
    const { dx, dy } = _clampGroupOffset(els, curDx, curDy, curDx, curDy);
    if (dx !== curDx || dy !== curDy) {
      curDx = dx; curDy = dy;
      applyOffset(dx, dy);
      localStorage.setItem(`audiochart-ui-pos-${groupId}`, JSON.stringify({ dx, dy }));
    }
  });
}

function _initRearrangeGroups() {
  _makeDraggableGroup('status', () => [document.getElementById('map-overlay-status')]);
  _makeDraggableGroup('btncol', () => [
    'global-ops-title',
    'map-menu-btn', 'map-layer-btn', 'zoom-to-me-btn', 'navaid-filter-btn',
    'route-picker-btn', 'reroute-btn', 'delete-route-btn', 'track-picker-btn',
  ].map(id => document.getElementById(id)));
  _makeDraggableGroup('navctl', () => ['zoom-slider-wrap', 'pan-controls-wrap'].map(id => document.getElementById(id)));
  _makeDraggableGroup('version', () => [document.getElementById('map-version-label')]);
  _makeDraggableGroup('cmdbar', () => [document.getElementById('map-overlay-cmd')]);
  _makeDraggableGroup('compass', () => [...document.querySelectorAll('.compass-rose-ctrl')]);
  _makeDraggableGroup('tide', () => [...document.querySelectorAll('.tide-cycle-ctrl')]);
  _makeDraggableGroup('headingspeed', () => [...document.querySelectorAll('.heading-speed-ctrl')]);
  _makeDraggableGroup('followprogress', () => [...document.querySelectorAll('.follow-progress-ctrl')]);
}

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
const _TRANSCRIPT_MAX_LINES = 200; // bound DOM/memory growth over an all-day sail
let _lastTranscriptLine = null;

function _collapseResponseArea() {
  responseAreaEl.style.display = ''; // clear the initial inline display:none from index.html
  responseAreaEl.classList.add('collapsed');
}
function _expandResponseArea() {
  responseAreaEl.style.display = ''; // clear the initial inline display:none from index.html
  responseAreaEl.classList.remove('collapsed');
}

function _appendTranscript(text) {
  if (!text || text === '...' || text === _lastTranscriptLine) return; // skip the
                       // transient "working" placeholder and dedupe the common
                       // showResponse+TTS pairing
  _lastTranscriptLine = text;
  const line = document.createElement('div');
  line.className = 'transcript-line';
  const time = document.createElement('span');
  time.className = 'transcript-time';
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const body = document.createElement('span');
  body.className = 'transcript-body';
  body.textContent = text;
  line.appendChild(time);
  line.appendChild(body);
  responseEl.appendChild(line);
  while (responseEl.children.length > _TRANSCRIPT_MAX_LINES) {
    responseEl.removeChild(responseEl.firstChild);
  }
  _expandResponseArea();
  responseAreaEl.scrollTop = responseAreaEl.scrollHeight;
}

function showResponse(text) {
  _appendTranscript(text);
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
  _expandResponseArea();
}

// ── Sketch route ─────────────────────────────────────────────────────────────

const _appEl = document.getElementById('app');
const _sketchBanner = document.getElementById('sketch-banner');
const _drawBanner   = document.getElementById('draw-banner');
const _drawBannerLabel = document.getElementById('draw-banner-label');
const _drawUsePositionBtn = document.getElementById('draw-use-position-btn');
const _drawNameDestBtn    = document.getElementById('draw-name-dest-btn');
const _drawConfirmBtn  = document.getElementById('draw-confirm-btn');

// ── Saved-route persistent display ────────────────────────────────────────────

// Cross-track / along-track geometry helpers (used by hazard check + autofix)
function _segCrossTrack(aLon, aLat, bLon, bLat, pLon, pLat) {
  const R = 3440.065;
  const d13 = Query.distanceNm(aLon, aLat, pLon, pLat) / R;
  if (d13 < 1e-9) return { crossTrack: 0, alongTrack: 0 };
  const b13 = Query.bearing(aLon, aLat, pLon, pLat) * Math.PI / 180;
  const b12 = Query.bearing(aLon, aLat, bLon, bLat) * Math.PI / 180;
  const dxt = Math.asin(Math.sin(d13) * Math.sin(b13 - b12)) * R;
  const cosDxt = Math.cos(dxt / R);
  if (Math.abs(cosDxt) < 1e-10) return null;
  const dat = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / cosDxt))) * R;
  return { crossTrack: dxt, alongTrack: Math.cos(b13 - b12) >= 0 ? dat : -dat };
}

function _routesNearPoint(lat, lon, radiusNm) {
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const results = [];
  routes.forEach((route, routeIdx) => {
    const pts = route.points;
    if (!pts || pts.length < 1) return;
    let minDist = Infinity;
    if (pts.length === 1) {
      minDist = Query.distanceNm(pts[0].lon, pts[0].lat, lon, lat);
    } else {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const segLen = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
        const ct = _segCrossTrack(a.lon, a.lat, b.lon, b.lat, lon, lat);
        const d = (ct && ct.alongTrack >= 0 && ct.alongTrack <= segLen)
          ? Math.abs(ct.crossTrack)
          : Math.min(Query.distanceNm(a.lon, a.lat, lon, lat), Query.distanceNm(b.lon, b.lat, lon, lat));
        if (d < minDist) minDist = d;
      }
    }
    if (minDist <= radiusNm) {
      results.push({ routeIdx, name: route.name, distanceNm: minDist, dateLabel: _routeDateLabel(route) });
    }
  });
  results.sort((a, b) => a.distanceNm - b.distanceNm);
  return results;
}

function _tracksNearPoint(lat, lon, radiusNm) {
  const tracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
  const results = [];
  tracks.forEach(track => {
    const pts = track.points;
    if (!pts || pts.length < 1) return;
    let minDist = Infinity;
    if (pts.length === 1) {
      minDist = Query.distanceNm(pts[0].lon, pts[0].lat, lon, lat);
    } else {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const segLen = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
        const ct = _segCrossTrack(a.lon, a.lat, b.lon, b.lat, lon, lat);
        const d = (ct && ct.alongTrack >= 0 && ct.alongTrack <= segLen)
          ? Math.abs(ct.crossTrack)
          : Math.min(Query.distanceNm(a.lon, a.lat, lon, lat), Query.distanceNm(b.lon, b.lat, lon, lat));
        if (d < minDist) minDist = d;
      }
    }
    if (minDist <= radiusNm) {
      results.push({ name: track.name, distanceNm: minDist, dateLabel: _routeDateLabel(track) });
    }
  });
  results.sort((a, b) => a.distanceNm - b.distanceNm);
  return results;
}

function _segsIntersect(ax, ay, bx, by, px, py, qx, qy) {
  const cross = (ox, oy, ux, uy, vx, vy) => (ux-ox)*(vy-oy) - (uy-oy)*(vx-ox);
  const d1 = cross(px,py, qx,qy, ax,ay), d2 = cross(px,py, qx,qy, bx,by);
  const d3 = cross(ax,ay, bx,by, px,py), d4 = cross(ax,ay, bx,by, qx,qy);
  return ((d1>0&&d2<0)||(d1<0&&d2>0)) && ((d3>0&&d4<0)||(d3<0&&d4>0));
}

function _segPolyIntersectPoint(aLon, aLat, bLon, bLat, ring) {
  for (let i = 0; i < ring.length - 1; i++) {
    const [pLon, pLat] = ring[i], [qLon, qLat] = ring[i + 1];
    if (!_segsIntersect(aLon, aLat, bLon, bLat, pLon, pLat, qLon, qLat)) continue;
    const dxAB = bLon-aLon, dyAB = bLat-aLat, dxPQ = qLon-pLon, dyPQ = qLat-pLat;
    const denom = dxAB*dyPQ - dyAB*dxPQ;
    if (Math.abs(denom) < 1e-12) continue;
    const t = ((pLon-aLon)*dyPQ - (pLat-aLat)*dxPQ) / denom;
    return { lat: aLat + t*dyAB, lon: aLon + t*dxAB, t };
  }
  return null;
}

function _destPoint(lat, lon, bearingDeg, distNm) {
  const R = 3440.065;
  const d    = distNm / R;
  const brng = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1)*Math.cos(d) + Math.cos(lat1)*Math.sin(d)*Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng)*Math.sin(d)*Math.cos(lat1), Math.cos(d)-Math.sin(lat1)*Math.sin(lat2));
  return { lat: lat2 * 180/Math.PI, lon: lon2 * 180/Math.PI };
}

function _routeEndpointIcon() {
  return L.divIcon({ className: 'route-endpoint-marker', iconSize: [14, 14], iconAnchor: [7, 7] });
}

function _routeOvernightIcon() {
  return L.divIcon({ className: 'route-overnight-marker', html: '&#9875;', iconSize: [16, 16], iconAnchor: [8, 8] });
}

// silent=true suppresses the "all clear" popup for automatic/background
// checks (route just created, edit mode opened, route saved) so routine
// checks don't nag — but a found hazard ALWAYS opens the popup regardless
// of silent, since the whole point of auto-checking is to stop routes with
// real problems from saving without anyone being told.
// Pure hazard scan — no map layer mutation, no popups, no TTS. Used both by
// _checkRouteHazards below (which adds the map/popup/TTS presentation on
// top) and by the routes panel's per-route hazard badges (_getRouteHazards),
// which need just the count without stomping the shared _hazardCheckLayer on
// every row. Each found entry is tagged kind: 'hard' (rock/obstruction/wreck
// — always worth fixing) or 'soft' (shallow-area/above-water crossing —
// draft/tide dependent, not automatically unsafe) so callers can tell them
// apart without re-deriving the distinction from label strings.
function _findRouteHazards(points) {
  const pts   = points;
  const feats = Query.hazards?.features || [];
  const CORRIDOR = 0.05;  // nm (~100 yards each side)
  const DANGER_LABELS = new Set(['underwater rock', 'obstruction', 'wreck', 'UWTROC', 'OBSTRN', 'WRECKS']);
  const seen = new Set();
  const found = [];
  const dangerSegments = new Set(); // segment indices that have a nearby hazard

  const SHALLOW_THRESHOLD = 2.0; // nm depth — flag DEPARE polygons shallower than this
  let distSoFar = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const segLen = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
    const segMinLat = Math.min(a.lat, b.lat), segMaxLat = Math.max(a.lat, b.lat);
    const segMinLon = Math.min(a.lon, b.lon), segMaxLon = Math.max(a.lon, b.lon);
    const BUF = 0.001; // ~0.06 nm bbox buffer

    // ── Point hazards: cross-track corridor check ──
    for (const f of feats) {
      if (f.geometry.type !== 'Point') continue;
      const label = f.properties.label || f.properties.objtype || '';
      if (!DANGER_LABELS.has(label)) continue;
      const [pLon, pLat] = f.geometry.coordinates;
      const key = `${pLon.toFixed(5)},${pLat.toFixed(5)}`;
      if (seen.has(key)) continue;
      const ct = _segCrossTrack(a.lon, a.lat, b.lon, b.lat, pLon, pLat);
      if (!ct) continue;
      const { crossTrack, alongTrack } = ct;
      if (Math.abs(crossTrack) <= CORRIDOR && alongTrack >= 0 && alongTrack <= segLen) {
        seen.add(key);
        dangerSegments.add(i);
        const t = segLen > 0 ? alongTrack / segLen : 0;
        found.push({
          lat: pLat, lon: pLon,
          projLat: a.lat + (b.lat - a.lat) * t,
          projLon: a.lon + (b.lon - a.lon) * t,
          label: f.properties.label || label,
          name:  f.properties.name || '',
          routeNm: distSoFar + alongTrack,
          side:    crossTrack <= 0 ? 'port' : 'starboard',
          segBrg:  _segBearing(a.lat, a.lon, b.lat, b.lon),
          sideSign: crossTrack > 0 ? 1 : -1,
          kind: 'hard',
        });
      }
    }

    // ── Polygon hazards: route crosses shallow/above-water area ──
    // Use Query.depthZones (always real geometry from static file, even in server/IDB mode)
    for (const f of (Query.depthZones || [])) {
      const props = f.properties || {};
      const minDepth = parseFloat(props.depth_label);
      if (isNaN(minDepth) || minDepth >= SHALLOW_THRESHOLD) continue;
      // depthZones can be Polygon or MultiPolygon — coordinates[0] is only
      // the outer ring directly for Polygon; for MultiPolygon it's the
      // first polygon's [outer, ...holes] instead. This went unnoticed
      // because this whole check had no live caller until now (see
      // _enterEditMode/_checkRouteHazards auto-invocation).
      const { type, coordinates } = f.geometry;
      const polys = type === 'Polygon' ? [coordinates] : coordinates;
      for (const rings of polys) {
        const ring = rings[0];
        // Bbox pre-filter
        const lons = ring.map(c => c[0]), lats = ring.map(c => c[1]);
        if (Math.max(...lons) < segMinLon - BUF || Math.min(...lons) > segMaxLon + BUF ||
            Math.max(...lats) < segMinLat - BUF || Math.min(...lats) > segMaxLat + BUF) continue;
        const key = `poly:${lons[0].toFixed(5)},${lats[0].toFixed(5)}`;
        if (seen.has(key)) continue;
        const hit = _segPolyIntersectPoint(a.lon, a.lat, b.lon, b.lat, ring);
        if (!hit) continue;
        seen.add(key);
        dangerSegments.add(i);
        const polyLabel = minDepth < 0 ? 'above-water obstacle' : `shallow area (${props.depth_label})`;
        found.push({
          lat: hit.lat, lon: hit.lon,
          projLat: hit.lat, projLon: hit.lon,
          label: polyLabel,
          name:  props.name || '',
          routeNm: distSoFar + hit.t * segLen,
          side:    'crossing',
          segBrg:  _segBearing(a.lat, a.lon, b.lat, b.lon),
          sideSign: 0,
          kind: 'soft',
        });
      }
    }
    distSoFar += segLen;
  }
  found.sort((a, b) => a.routeNm - b.routeNm);
  return { found, dangerSegments };
}

// Cache of _findRouteHazards results for the routes panel's hazard badges,
// keyed by id+updatedAt so it's invalidated automatically whenever a
// route's content changes (anything that calls _touch() bumps updatedAt) —
// no new tracking field needed. Stale entries for edited/deleted routes
// just become unreachable and sit unused; fine for a cache realistically
// bounded by tens of saved routes, not worth an eviction policy yet.
let _routeHazardCountCache = new Map();
function _getRouteHazards(route) {
  const key = `${route.id}:${route.updatedAt || route.createdAt || 0}`;
  let found = _routeHazardCountCache.get(key);
  if (found === undefined) {
    found = _findRouteHazards(route.points).found;
    _routeHazardCountCache.set(key, found);
  }
  return found;
}

function _checkRouteHazards(routeIdx, silent = false) {
  _lastHazardCheckedIdx = routeIdx;
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const route  = routes[routeIdx];
  if (!route) return [];
  const pts = route.points;
  const { found, dangerSegments } = _findRouteHazards(pts);

  if (_hazardCheckLayer) _hazardCheckLayer.clearLayers();
  _hazardCheckLayer = L.layerGroup().addTo(_map);

  // Tapping the flagged part of the route (the red highlight or the skull
  // marker) should jump straight into edit mode — that's the whole reason
  // it's flagged, so fixing it shouldn't require separately hunting for the
  // route on the map and tapping it again.
  const _jumpToEdit = () => {
    if (!_editMode || _editRouteIdx !== routeIdx) _enterEditMode(routeIdx);
    else _checkRouteHazards(routeIdx, false);
  };

  // Highlight dangerous route segments in red
  for (const i of dangerSegments) {
    L.polyline([[pts[i].lat, pts[i].lon], [pts[i+1].lat, pts[i+1].lon]], {
      color: '#e05252', weight: 7, opacity: 0.9, interactive: true,
    }).on('click', (e) => { L.DomEvent.stopPropagation(e); _jumpToEdit(); })
      .addTo(_hazardCheckLayer);
  }

  // Pulsing skull for hard hazards; a small, discreet caution triangle for
  // soft ones (see _softHazardMarkerIcon) — click zooms to it and edits
  for (const h of found) {
    const tip = `${h.label}${h.name ? ': ' + h.name : ''} — ${h.side}, ${h.routeNm.toFixed(1)} nm along route`;
    const icon = h.kind === 'soft'
      ? _softHazardMarkerIcon()
      : L.divIcon({
          className: '',
          html: '<div class="davy-jones-icon">&#9760;</div>',
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });
    L.marker([h.lat, h.lon], {
      icon,
      zIndexOffset: h.kind === 'soft' ? 800 : 1000,
    }).bindTooltip(tip, { permanent: false, direction: 'top', offset: [0, -6] })
      .on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        _map.setView([h.lat, h.lon], 16);
        _jumpToEdit();
      })
      .addTo(_hazardCheckLayer);
  }

  if (found.length === 0) {
    if (!silent) {
      const mid = pts[Math.floor((pts.length - 1) / 2)];
      L.popup({ maxWidth: 300, autoPan: false })
        .setLatLng([mid.lat, mid.lon])
        .setContent(`<div style="font-size:13px;line-height:1.5"><b>${route.name}</b><br>✓ No rocks, obstructions, or wrecks within 100 yds.</div>`)
        .openOn(_map);
    }
    return found;
  }

  // A hazard was found — announce it out loud, not just as a map marker
  // someone could be looking away from. No popup here: the red segment
  // highlight and skull/triangle markers above are the persistent visual
  // signal, and fixing is reached via the Node Ops "Fix selected nodes"
  // button (select the flagged waypoint, then Fix) or by editing manually.
  // Reported live: an unprompted popup box, stacked on top of the toolbar,
  // "is not useful."
  const speakMsg = `Warning: ${route.name} has ${found.length} hazard${found.length > 1 ? 's' : ''} nearby, including ${found[0].label}${found[0].name ? ', ' + found[0].name : ''}.`;
  setStatus(speakMsg);
  TTS.sayImmediate(speakMsg);
  return found;
}

// Fixes hazards near a single waypoint — click "Fix selected nodes" to arm
// fix mode (stays armed, same as Delete/Overnight), then click waypoints on
// the map one at a time; each click immediately nudges just that waypoint
// clear of any charted rock/obstruction/wreck on one of its two adjacent
// segments, and lights it up ('edit-vertex-selected' in _renderEditLayers)
// so it's visibly been addressed. Deliberately per-node and immediate, not
// a batch multi-select-then-fix — matches the existing Delete-mode
// interaction model per explicit request ("keep deleting till we signal
// stop... consistent with that... first click button, then start fixing
// individual nodes"). A hazard is only fixed if THIS node is the specific
// endpoint the nudge-math would move — if the segment's other, unclicked
// endpoint is the nearer one, that hazard is left alone rather than moving
// a node the user didn't click.
function _fixNodeHazards(idx) {
  const CORRIDOR    = 0.05;
  const SAFETY      = 0.03;
  const MAX_DISP    = 0.15;  // nm cap per vertex move
  const DANGER_LABELS = new Set(['underwater rock','obstruction','wreck','UWTROC','OBSTRN','WRECKS']);

  const pts   = _editPoints;
  const feats = Query.hazards?.features || [];
  const n     = pts.length;
  const disp  = { dlat: 0, dlon: 0 };
  let hazardsFixed = 0;

  const adjSegs = [];
  if (idx > 0)     adjSegs.push(idx - 1);  // segment (idx-1, idx)
  if (idx < n - 1)  adjSegs.push(idx);      // segment (idx, idx+1)

  for (const i of adjSegs) {
    const a = pts[i], b = pts[i + 1];
    const segLen = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
    if (segLen < 1e-6) continue;
    const segBearing = Query.bearing(a.lon, a.lat, b.lon, b.lat);

    for (const f of feats) {
      if (f.geometry.type !== 'Point') continue;
      const label = f.properties.label || f.properties.objtype || '';
      if (!DANGER_LABELS.has(label)) continue;
      const [pLon, pLat] = f.geometry.coordinates;
      const ct = _segCrossTrack(a.lon, a.lat, b.lon, b.lat, pLon, pLat);
      if (!ct) continue;
      const { crossTrack, alongTrack } = ct;
      if (Math.abs(crossTrack) > CORRIDOR || alongTrack < 0 || alongTrack > segLen) continue;

      // Move whichever endpoint needs less displacement (see _fixNodeHazards'
      // header comment) — only proceed if that's the node that was clicked.
      const frac = alongTrack / segLen;
      const vi = frac <= 0.5 ? i : i + 1;
      if (vi !== idx) continue;

      const delta       = CORRIDOR + SAFETY - Math.abs(crossTrack);
      const bypassSign  = crossTrack >= 0 ? -1 : 1;  // move perp away from the hazard
      const perpBearing = segBearing + bypassSign * 90;
      const denom        = frac <= 0.5 ? segLen - alongTrack : alongTrack;
      const dNeeded       = Math.min(denom > 0.005 ? delta * segLen / denom : MAX_DISP, MAX_DISP);

      const moved = _destPoint(pts[idx].lat, pts[idx].lon, perpBearing, dNeeded);
      disp.dlat += moved.lat - pts[idx].lat;
      disp.dlon += moved.lon - pts[idx].lon;
      hazardsFixed++;
    }
  }

  _selectedEditNodeIdx.add(idx);  // light it up either way — it's been addressed

  if (hazardsFixed === 0) {
    _renderEditLayers();
    const msg = 'No nearby rock, obstruction, or wreck hazard to fix on this waypoint.';
    setStatus(msg); TTS.sayImmediate(msg);
    return;
  }

  _pushEditHistory();
  _editPoints[idx] = { ...pts[idx], lat: pts[idx].lat + disp.dlat, lon: pts[idx].lon + disp.dlon };
  _renderEditLayers();
  clearTimeout(_liveHazardTimer);
  _liveHazardTimer = setTimeout(_liveHazardCheck, 300);

  const msg = `Fixed ${hazardsFixed} hazard${hazardsFixed > 1 ? 's' : ''} near this waypoint.`;
  setStatus(msg); TTS.sayImmediate(msg);
}

function _bestRouteLabelPos(pts) {
  // Return the vertex closest to the viewport center that is within bounds;
  // fall back to geographic midpoint if none are visible.
  const bounds  = _map.getBounds();
  const center  = bounds.getCenter();
  let bestPt = null, bestDist = Infinity;
  for (const p of pts) {
    if (!bounds.contains([p.lat, p.lon])) continue;
    const d = Math.hypot(p.lat - center.lat, p.lon - center.lng);
    if (d < bestDist) { bestDist = d; bestPt = p; }
  }
  if (bestPt) return bestPt;
  // No vertex in viewport — use geographic midpoint
  const n = pts.length;
  if (n === 1) return pts[0];
  if (n % 2 === 1) return pts[Math.floor(n / 2)];
  const m = n / 2;
  return { lat: (pts[m-1].lat + pts[m].lat) / 2, lon: (pts[m-1].lon + pts[m].lon) / 2 };
}

function _repositionRouteNameLabels() {
  if (!_map) return;
  for (const { marker, pts } of _routeNameLabels) {
    const p = _bestRouteLabelPos(pts);
    marker.setLatLng([p.lat, p.lon]);
  }
}

function _selectRoute(routeIdx) {
  _selectedRouteIdx = (_selectedRouteIdx === routeIdx) ? -1 : routeIdx;
  _refreshSavedRouteLayers();
}

function _openSelectRoutePopup(routeIdx, latlng) {
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const route = routes[routeIdx];
  if (!route) return;
  const isSelected = routeIdx === _selectedRouteIdx;
  const btnId = `select-route-btn-${routeIdx}`;
  L.popup({ closeButton: true })
    .setLatLng(latlng)
    .setContent(`<div style="text-align:center"><button id="${btnId}">${isSelected ? 'Deselect' : 'Select this route'}</button></div>`)
    .openOn(_map);
  setTimeout(() => {
    document.getElementById(btnId)?.addEventListener('click', () => {
      _map.closePopup();
      _selectRoute(routeIdx);
      const msg = isSelected ? `${route.name} deselected.` : `${route.name} selected.`;
      setStatus(msg);
      TTS.sayImmediate(msg);
    });
  }, 0);
}

function _showNearPointPanel(kind, latlng, results, radiusLabel) {
  // kind: 'route' | 'track'
  const hiddenNames = kind === 'route' ? _hiddenRouteNames : _hiddenTrackNames;
  const label = kind === 'route' ? 'route' : 'track';

  const panel = document.getElementById('near-point-panel');
  const tbody = document.getElementById('npp-tbody');
  document.getElementById('npp-title').textContent = results.length === 0
    ? `No ${label}s within ${radiusLabel}`
    : `${results.length} ${label}${results.length > 1 ? 's' : ''} within ${radiusLabel}`;

  tbody.innerHTML = results.map(r => `
    <tr data-name="${r.name}">
      <td><input type="checkbox" class="npp-vis-cb" ${hiddenNames.has(r.name) ? '' : 'checked'}></td>
      <td class="npp-row-name">${r.name}</td>
      <td>${distanceToDisplay(r.distanceNm)}</td>
      <td>${r.dateLabel}</td>
    </tr>`).join('');

  // Position at the clicked point, converted to screen coords, clamped to viewport —
  // same clamping approach already used for #map-context-menu.
  const pt = _map.latLngToContainerPoint(latlng);
  const mapRect = _map.getContainer().getBoundingClientRect();
  panel.style.display = 'block';
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  const x = Math.min(mapRect.left + pt.x, window.innerWidth - pw - 4);
  const y = Math.min(mapRect.top + pt.y, window.innerHeight - ph - 4);
  panel.style.left = Math.max(4, x) + 'px';
  panel.style.top = Math.max(4, y) + 'px';

  const refresh = kind === 'route' ? _refreshSavedRouteLayers : _refreshSavedTrackLayers;
  const save = kind === 'route' ? _saveHiddenRoutes : _saveHiddenTracks;
  const rebuildPanel = kind === 'route' ? _buildRoutePickerPanelFn : _buildTrackPickerPanelFn;

  tbody.querySelectorAll('.npp-vis-cb').forEach(cb => {
    const name = cb.closest('tr').dataset.name;
    cb.addEventListener('change', () => {
      if (cb.checked) hiddenNames.delete(name); else hiddenNames.add(name);
      save(); refresh(); rebuildPanel?.();
    });
  });

  document.getElementById('npp-hide-others').onclick = () => {
    const resultNames = new Set(results.map(r => r.name));
    const all = JSON.parse(localStorage.getItem(kind === 'route' ? ROUTE_KEY : TRACK_KEY) || '[]');
    all.forEach(item => { if (!resultNames.has(item.name)) hiddenNames.add(item.name); });
    save(); refresh(); rebuildPanel?.();
    tbody.querySelectorAll('.npp-vis-cb').forEach(cb => { cb.checked = true; });
    const msg = `Showing only the ${results.length} ${label}${results.length > 1 ? 's' : ''} within ${radiusLabel}.`;
    setStatus(msg); TTS.sayImmediate(msg);
  };

  const msg = results.length === 0 ? `No ${label}s within ${radiusLabel}.` : `${results.length} ${label}${results.length > 1 ? 's' : ''} within ${radiusLabel}.`;
  setStatus(msg); TTS.sayImmediate(msg);
}
document.getElementById('npp-close').addEventListener('click', () => {
  document.getElementById('near-point-panel').style.display = 'none';
});

function _refreshSavedRouteLayers() {
  if (!_map) return;
  _routeNameLabels = [];
  if (_savedRoutesLayer) {
    _savedRoutesLayer.clearLayers();
  } else {
    _savedRoutesLayer = L.layerGroup();
  }
  if (_sketchMode || _editMode) return; // hidden during drawing/editing
  _savedRoutesLayer.addTo(_map);

  // Custom pane above tooltip pane (650) so route names render over bearing labels
  if (!_map.getPane('routeNamePane')) {
    _map.createPane('routeNamePane').style.zIndex = '700';
  }
  if (!_routeNameMoveEndWired) {
    _map.on('moveend zoomend', _repositionRouteNameLabels);
    _map.on('zoomend', _refreshSavedRouteLayers);   // re-snap label offsets to current zoom
    _routeNameMoveEndWired = true;
  }

  // Keep labels ~55 screen-pixels from the route regardless of zoom level.
  // Formula: pixels/NM ≈ (256 · 2^z) / (360 · 60) · cos(lat)
  const _z = _map.getZoom();
  const _pxPerNm = 256 * Math.pow(2, _z) / (360 * 60) * Math.cos(44.5 * Math.PI / 180);
  const _labelOffsetNm = Math.min(Math.max(55 / _pxPerNm, 0.15), 3.0);

  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  routes.forEach((route, routeIdx) => {
    if (!route.points || route.points.length < 1) return;
    if (_hiddenRouteNames.has(route.name)) return;
    const pts = route.points;
    const lls = pts.map(p => [p.lat, p.lon]);

    L.polyline(lls, { color: '#e05252', weight: 8, opacity: 0, interactive: true })
      .on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        _enterEditMode(routeIdx);
      })
      .on('dblclick', (e) => { L.DomEvent.stopPropagation(e); })
      .on('mouseover', () => { _ctxRouteIdx = routeIdx; })
      .on('contextmenu', (e) => {
        L.DomEvent.stopPropagation(e);
        _openSelectRoutePopup(routeIdx, e.latlng);
      })
      .addTo(_savedRoutesLayer);
    const isSelected = routeIdx === _selectedRouteIdx;
    L.polyline(lls, {
      color: isSelected ? '#f5c842' : '#e05252',
      weight: isSelected ? 5 : 3,
      opacity: isSelected ? 1.0 : 0.7,
      interactive: false,
    }).addTo(_savedRoutesLayer);

    // Segment bearing labels — perpendicular offset, alternating sides, dashed leader
    for (let i = 0; i < pts.length - 1; i++) {
      const midLat  = (pts[i].lat + pts[i + 1].lat) / 2;
      const midLon  = (pts[i].lon + pts[i + 1].lon) / 2;
      const trueBrg = _segBearing(pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon);
      const magBrg  = Math.round(trueTomagnetic(trueBrg) + 360) % 360;
      const distNm  = Query.distanceNm(pts[i].lon, pts[i].lat, pts[i + 1].lon, pts[i + 1].lat);
      const html    = `${String(magBrg).padStart(3, '0')}&deg;M &thinsp; ${distNm.toFixed(1)}nm`;
      _addLeaderLabel(_savedRoutesLayer, midLat, midLon, trueBrg, i % 2 === 0 ? 1 : -1, _labelOffsetNm, html, 'route-label-box');
    }

    // Route name label — viewport-aware position, renders above bearing tooltips
    {
      const labelPt = _bestRouteLabelPos(pts);
      const nameMarker = L.marker([labelPt.lat, labelPt.lon], {
        icon: L.divIcon({ className: 'route-name-label', html: route.name, iconSize: null }),
        pane: 'routeNamePane',
        interactive: true,
      }).on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const routes2 = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
        const newName = prompt('Rename route:', routes2[routeIdx].name);
        if (!newName || !newName.trim()) return;
        routes2[routeIdx].name = newName.trim();
        _touch(routes2[routeIdx]);
        localStorage.setItem(ROUTE_KEY, JSON.stringify(routes2));
        localStorage.setItem('audiochart-last-route', newName.trim());
        _populateRouteSelectFn?.();
        _refreshSavedRouteLayers();
      }).addTo(_savedRoutesLayer);
      _routeNameLabels.push({ marker: nameMarker, pts });
    }

    // Endpoint markers with coordinate labels (leader line, offset from route)
    const addEndpointMarker = (pt, fromEnd) => {
      const m = L.marker([pt.lat, pt.lon], { icon: _routeEndpointIcon() })
        .addTo(_savedRoutesLayer);
      // Offset label perpendicular to the adjacent segment
      const adjPt   = fromEnd ? pts[pts.length - 2] : pts[1];
      if (adjPt) {
        const segBrg = fromEnd
          ? _segBearing(adjPt.lat, adjPt.lon, pt.lat, pt.lon)
          : _segBearing(pt.lat, pt.lon, adjPt.lat, adjPt.lon);
        _addLeaderLabel(_savedRoutesLayer, pt.lat, pt.lon, segBrg,
          fromEnd ? -1 : 1, _labelOffsetNm * 1.2,
          formatPositionDisplay(pt.lat, pt.lon), 'route-coord-label-box');
      }
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

    addEndpointMarker(pts[0], false);
    if (pts.length > 1) addEndpointMarker(pts[pts.length - 1], true);

    // Overnight-stop markers — always visible, not just while editing
    pts.forEach((pt, i) => {
      if (i === 0 || i === pts.length - 1 || !pt.overnight) return;
      L.marker([pt.lat, pt.lon], { icon: _routeOvernightIcon() })
        .bindTooltip('Overnight stop', { direction: 'top', offset: [0, -10] })
        .addTo(_savedRoutesLayer);
    });
  });
}

// Recorded GPS breadcrumb trails — simpler than routes: no edit-mode hit-target layer
// (not editable plans) and no per-segment bearing labels (would be noise for a real,
// possibly-thousands-of-points trail). Just a colored polyline + a static name label.
function _refreshSavedTrackLayers() {
  if (!_map) return;
  if (_savedTracksLayer) _savedTracksLayer.clearLayers();
  else _savedTracksLayer = L.layerGroup();
  _savedTracksLayer.addTo(_map);

  const tracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
  tracks.forEach(track => {
    if (!track.points || track.points.length < 2) return;
    if (_hiddenTrackNames.has(track.name)) return;
    const lls = track.points.map(p => [p.lat, p.lon]);
    L.polyline(lls, { color: '#c77dff', weight: 3, opacity: 0.8, interactive: false }).addTo(_savedTracksLayer);
    const mid = track.points[Math.floor(track.points.length / 2)];
    L.marker([mid.lat, mid.lon], {
      icon: L.divIcon({ className: 'route-name-label', html: track.name, iconSize: null }),
      interactive: false,
    }).addTo(_savedTracksLayer);
  });

  // Live preview of the in-progress recording, if active
  if (_trackRecActive && _trackRecPoints.length >= 2) {
    L.polyline(_trackRecPoints.map(p => [p.lat, p.lon]), {
      color: '#c77dff', weight: 3, opacity: 0.5, dashArray: '4,4', interactive: false,
    }).addTo(_savedTracksLayer);
  }
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
let _sketchMapMouseDown = null;
let _sketchMapMouseUp   = null;
// Same tap-vs-drag distinction as Draw Route mode: dragging is disabled while
// sketching so a stray drag can't misplace a waypoint, but that also blocks the
// normal way to pan toward off-screen territory mid-sketch.
let _sketchGestureStartPt = null;
let _sketchGestureLastPt  = null;
let _sketchIsPanning      = false;

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
    e.preventDefault(); e.stopPropagation(); // suppress the ghost click that would otherwise
                                              // re-fire _onSketchClick for this same tap
    _sketchAddWaypoint(_sketchCursorLL);
  };

  container.addEventListener('touchstart', _sketchTouchStart, { passive: false, capture: true });
  container.addEventListener('touchmove',  _sketchTouchMove,  { passive: false, capture: true });
  container.addEventListener('touchend',   _sketchTouchEnd,   { capture: true });

  // Desktop: click adds waypoint, mousemove updates rubber-band, dblclick finishes.
  // dblclick fires after two clicks; the second click adds a spurious waypoint we pop.
  _sketchGestureStartPt = null;
  _sketchGestureLastPt  = null;
  _sketchIsPanning      = false;
  _sketchMapMouseDown = (e) => {
    _sketchGestureStartPt = e.containerPoint;
    _sketchGestureLastPt  = e.containerPoint;
    _sketchIsPanning = false;
  };
  _sketchMapMouseUp = () => { _sketchGestureStartPt = null; };
  _map.on('mousedown', _sketchMapMouseDown);
  _map.on('mouseup',   _sketchMapMouseUp);
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
    if (_sketchMapMouseDown) { _map.off('mousedown', _sketchMapMouseDown); _sketchMapMouseDown = null; }
    if (_sketchMapMouseUp)   { _map.off('mouseup',   _sketchMapMouseUp);   _sketchMapMouseUp   = null; }
    _sketchGestureStartPt = _sketchGestureLastPt = null;
    _sketchIsPanning = false;
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
  _growRouteIdx      = -1;
  _refreshSavedRouteLayers();
}

function _onSketchClick(e) {
  if (_sketchIsPanning) { _sketchIsPanning = false; return; } // suppress the click that follows a drag-pan
  _sketchAddWaypoint(e.latlng);
}

function _onSketchMouseMove(e) {
  if (_sketchGestureStartPt) {
    const dx = e.containerPoint.x - _sketchGestureStartPt.x, dy = e.containerPoint.y - _sketchGestureStartPt.y;
    if (!_sketchIsPanning && Math.hypot(dx, dy) > _TAP_TOLERANCE_PX) _sketchIsPanning = true;
    if (_sketchIsPanning) {
      _map.panBy([_sketchGestureLastPt.x - e.containerPoint.x, _sketchGestureLastPt.y - e.containerPoint.y], { animate: false });
      _sketchGestureLastPt = e.containerPoint;
      return; // don't also update the rubber band while panning
    }
  }
  _sketchUpdateRubber(e.latlng);
  _sketchCheckAutoPan(e.latlng);
}

function _onSketchDblClick(e) {
  // The second click of the dblclick already added a spurious waypoint — pop it.
  if (_sketchWaypoints.length > 0) _sketchWaypoints.pop();
  _finishSketch();
}

// ── Stretch-to-draw route mode ─────────────────────────────────────────────────

function _onDrawClick(latlng) {
  if (!_drawStart) {
    _drawStart = latlng;
    _drawName  = _nextRouteName();
    _drawBannerLabel.textContent = `”${_drawName}” — tap your destination`;
    _drawUsePositionBtn.style.display = 'none';
    _drawNameDestBtn.style.display = 'inline-block';
    return;
  }
  // Start already placed — this tap sets (or repositions) the destination.
  // Computing the route now requires a separate, explicit OK tap so a
  // spurious extra tap (double-tap, ghost click, fat-finger) can never
  // silently finish the route on its own.
  _drawEnd = latlng;
  if (!_drawRubber) {
    _drawRubber = L.polyline([_drawStart, _drawEnd], {
      color: '#f5a623', weight: 3, dashArray: '8 6', opacity: 0.9,
    }).addTo(_map);
  } else {
    _drawRubber.setLatLngs([_drawStart, _drawEnd]);
  }
  _drawBannerLabel.textContent = `”${_drawName}” — tap OK to compute, or tap map to move destination`;
  _drawConfirmBtn.style.display = 'inline-block';
}

async function _onDrawConfirm() {
  if (!_drawStart || !_drawEnd) return;
  const name    = _drawName;
  const startPt = { lat: _drawStart.lat, lon: _drawStart.lng };
  const endPt   = { lat: _drawEnd.lat, lon: _drawEnd.lng };
  if (await _blockedByCoverage(startPt, endPt, 'Draw Route')) { _exitDrawRouteMode(true); return; }
  _exitDrawRouteMode(true);  // skip route refresh — edit mode handles display after optimization

  // Show straight-line preview while optimizing
  const previewLine = L.polyline(
    [[startPt.lat, startPt.lon], [endPt.lat, endPt.lon]],
    { color: '#f5a623', weight: 3, dashArray: '8 6', opacity: 0.9 }
  ).addTo(_map);

  const optOverlay = document.createElement('div');
  optOverlay.className = 'optimizing-overlay';
  optOverlay.innerHTML =
    '<span class=”optimizing-boat”>&#9975;</span>' +
    '<em class=”optimizing-text”>Optimizing&#8230;</em>';
  _map.getContainer().appendChild(optOverlay);

  let pts;
  try {
    pts = await _autoRouteProg(startPt, endPt,
      (path) => previewLine.setLatLngs(path.map(p => [p.lat, p.lon])),
      (t) => { const el = optOverlay.querySelector('.optimizing-text'); if (el) el.textContent = t; }
    );
  } catch (err) {
    optOverlay.remove();
    previewLine.remove();
    console.error('[drawRoute] optimization error:', err);
    return;
  }

  optOverlay.remove();
  previewLine.remove();

  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  routes.push(_stampNew({ name, points: pts.map(p => ({ lat: p.lat, lon: p.lon })) }));
  localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
  _populateRouteSelectFn?.();
  // A fallback here (autoRoute gave up and returned the raw straight line)
  // was previously silent — this is the PRIMARY "auto-route to here" entry
  // point, unlike _reRouteSegments' callers, which already show
  // _showRouteFallbackWarning for exactly this case. A real gap: the user
  // draws a route, waits, and gets a straight line across land saved with
  // zero indication anything went wrong. Only a genuine fallback counts —
  // 2 points alone isn't enough, since a direct line that's ALREADY clear
  // (no avoidance needed, e.g. Piece 1d's long-range fast path) also
  // legitimately returns exactly 2 points.
  const fellBack = pts.length <= 2 && Query.landBlocks(pts[0].lon, pts[0].lat, pts[1].lon, pts[1].lat);
  const found = _enterEditMode(routes.length - 1);
  if (fellBack && !found.length) _showRouteFallbackWarning([{ a: pts[0], b: pts[1] }]);
}

function _onDrawMouseMove(latlng) {
  if (!_drawStart || _drawEnd) return; // destination already placed — no live rubber-band until it's tapped again
  if (!_drawRubber) {
    _drawRubber = L.polyline([_drawStart, latlng], {
      color: '#f5a623', weight: 3, dashArray: '8 6', opacity: 0.85,
    }).addTo(_map);
  } else {
    _drawRubber.setLatLngs([_drawStart, latlng]);
  }
}

function _enterDrawRouteMode() {
  if (_sketchMode) _exitSketchMode();
  if (_editMode)   _exitEditMode();
  _drawMode = true;
  _drawStart = null; _drawEnd = null; _drawRubber = null; _drawName = null;
  _drawBannerLabel.textContent = 'Auto route — tap your start point';
  _drawConfirmBtn.style.display = 'none';
  _drawUsePositionBtn.style.display = 'inline-block';
  _drawNameDestBtn.style.display = 'none';
  _drawBanner.style.display = 'flex';
  _appEl.classList.add('sketch-mode');
  if (!_map) return;
  _map.dragging.disable();
  if (_savedRoutesLayer) _map.removeLayer(_savedRoutesLayer);

  _drawGestureStartPt = null;
  _drawGestureLastPt  = null;
  _drawIsPanning      = false;

  const container = _map.getContainer();
  _drawTouchStart = (e) => {
    if (!_drawMode) return;
    e.preventDefault();
    const t = e.touches[0];
    _drawGestureStartPt = { x: t.clientX, y: t.clientY };
    _drawGestureLastPt  = _drawGestureStartPt;
    _drawIsPanning = false;
  };
  _drawTouchMove = (e) => {
    if (!_drawMode) return;
    e.preventDefault(); e.stopPropagation();
    const t = e.touches[0];
    const r = container.getBoundingClientRect();
    if (_drawGestureStartPt) {
      const dx = t.clientX - _drawGestureStartPt.x, dy = t.clientY - _drawGestureStartPt.y;
      if (!_drawIsPanning && Math.hypot(dx, dy) > _TAP_TOLERANCE_PX) _drawIsPanning = true;
      if (_drawIsPanning) {
        _map.panBy([_drawGestureLastPt.x - t.clientX, _drawGestureLastPt.y - t.clientY], { animate: false });
        _drawGestureLastPt = { x: t.clientX, y: t.clientY };
        return; // don't also update the rubber band while panning
      }
    }
    _onDrawMouseMove(_map.containerPointToLatLng(L.point(t.clientX - r.left, t.clientY - r.top)));
  };
  _drawTouchEnd = (e) => {
    if (!_drawMode) return;
    e.preventDefault(); e.stopPropagation(); // suppress the ghost click that would otherwise
                                              // re-fire _onDrawClick for this same tap
    const wasPanning = _drawIsPanning;
    _drawGestureStartPt = null;
    _drawIsPanning = false;
    if (wasPanning) return; // moved too far to count as placing a point — just a pan
    const t = e.changedTouches[0];
    const r = container.getBoundingClientRect();
    _onDrawClick(_map.containerPointToLatLng(L.point(t.clientX - r.left, t.clientY - r.top)));
  };
  container.addEventListener('touchstart', _drawTouchStart, { capture: true });
  container.addEventListener('touchmove',  _drawTouchMove,  { passive: false, capture: true });
  container.addEventListener('touchend',   _drawTouchEnd,   { capture: true });

  // Mouse (desktop) equivalent — same tap-vs-drag distinction, using
  // Leaflet's own mouse events so coordinates are already map-relative.
  _drawMapMouseDown = (e) => {
    _drawGestureStartPt = e.containerPoint;
    _drawGestureLastPt  = e.containerPoint;
    _drawIsPanning = false;
  };
  _drawMapMouseMove = (e) => {
    if (_drawGestureStartPt) {
      const dx = e.containerPoint.x - _drawGestureStartPt.x, dy = e.containerPoint.y - _drawGestureStartPt.y;
      if (!_drawIsPanning && Math.hypot(dx, dy) > _TAP_TOLERANCE_PX) _drawIsPanning = true;
      if (_drawIsPanning) {
        _map.panBy([_drawGestureLastPt.x - e.containerPoint.x, _drawGestureLastPt.y - e.containerPoint.y], { animate: false });
        _drawGestureLastPt = e.containerPoint;
        return;
      }
    }
    _onDrawMouseMove(e.latlng);
  };
  _drawMapMouseUp = () => { _drawGestureStartPt = null; };
  _drawMapClick = (e) => {
    if (_drawIsPanning) { _drawIsPanning = false; return; } // suppress the click that follows a drag-pan
    _onDrawClick(e.latlng);
  };
  _map.on('mousedown', _drawMapMouseDown);
  _map.on('mousemove', _drawMapMouseMove);
  _map.on('mouseup',   _drawMapMouseUp);
  _map.on('click',     _drawMapClick);
}

function _exitDrawRouteMode(skipRefresh = false) {
  _drawMode = false;
  _drawBanner.style.display = 'none';
  _drawConfirmBtn.style.display = 'none';
  _drawUsePositionBtn.style.display = 'none';
  _drawNameDestBtn.style.display = 'none';
  _appEl.classList.remove('sketch-mode');
  if (_drawRubber) { _map.removeLayer(_drawRubber); _drawRubber = null; }
  _drawStart = null; _drawEnd = null; _drawName = null;
  if (_map) {
    const container = _map.getContainer();
    if (_drawTouchStart) container.removeEventListener('touchstart', _drawTouchStart, { capture: true });
    if (_drawTouchMove) container.removeEventListener('touchmove', _drawTouchMove, { capture: true });
    if (_drawTouchEnd)  container.removeEventListener('touchend',  _drawTouchEnd,  { capture: true });
    _drawTouchStart = _drawTouchMove = _drawTouchEnd = null;
    if (_drawMapClick)     { _map.off('click',     _drawMapClick);     _drawMapClick     = null; }
    if (_drawMapMouseMove) { _map.off('mousemove', _drawMapMouseMove); _drawMapMouseMove = null; }
    if (_drawMapMouseDown) { _map.off('mousedown', _drawMapMouseDown); _drawMapMouseDown = null; }
    if (_drawMapMouseUp)   { _map.off('mouseup',   _drawMapMouseUp);   _drawMapMouseUp   = null; }
    _drawGestureStartPt = _drawGestureLastPt = null;
    _drawIsPanning = false;
    _map.dragging.enable();
  }
  if (!skipRefresh) _refreshSavedRouteLayers();
}

document.getElementById('draw-cancel-btn').addEventListener('click', _exitDrawRouteMode);

_drawUsePositionBtn.addEventListener('click', () => {
  const pos = GPS.getPosition();
  if (!pos) {
    const msg = 'No GPS position yet.';
    setStatus(msg); TTS.sayImmediate(msg);
    return;
  }
  _onDrawClick(L.latLng(pos.lat, pos.lon));
});

_drawNameDestBtn.addEventListener('click', () => {
  const query = prompt('Destination — place or waypoint name:');
  if (!query || !query.trim()) return;
  const place = Query.findPlaceByName(query.trim());
  if (!place) {
    const msg = `Couldn't find "${query.trim()}".`;
    setStatus(msg); TTS.sayImmediate(msg);
    return;
  }
  // Gazetteer entries are often positioned on the landmass itself (a town or
  // island label), not the water someone means when naming it as a
  // destination — move onto the nearest confirmed water before dropping the
  // point, preferring a real nearby harbor/anchorage/mooring over the literal
  // closest wet pixel (see Query.findWaterNear).
  let dest = place;
  if (Query.isLandAt(place.lon, place.lat)) {
    const water = Query.findWaterNear(place.lon, place.lat);
    if (!water) {
      const msg = `${place.name} is on land and no nearby water was found — pick a spot on the map instead.`;
      setStatus(msg); TTS.sayImmediate(msg);
      return;
    }
    dest = { lat: water.lat, lon: water.lon, name: place.name };
    // A name that's already a water-feature term ("York Harbor", "Blue Hill
    // Bay") landing on the gazetteer's shore-side point and getting moved to
    // water is the EXPECTED outcome, not a surprise — narrating "X is on
    // land, I will move the point" for every such lookup is just noise.
    // Only announce the move when the name itself gave no hint this was
    // coming (a town/island name someone used as a stand-in destination).
    if (!Query.isWaterFeatureName(place.name)) {
      const msg = water.viaPlace
        ? `${place.name} — moved to ${water.viaPlace}, ${water.movedNm.toFixed(1)} nm away.`
        : `${place.name} is on land — moved ${water.movedNm.toFixed(1)} nm into open water.`;
      setStatus(msg); TTS.sayImmediate(msg);
    }
  }
  _onDrawClick(L.latLng(dest.lat, dest.lon));
});
_drawConfirmBtn.addEventListener('click', _onDrawConfirm);
document.getElementById('focus-place-confirm-btn').addEventListener('click', _confirmFocusPlace);
document.getElementById('focus-place-cancel-btn').addEventListener('click', _cancelFocusPlace);
document.getElementById('track-simulate-track').addEventListener('click', () => {
  document.getElementById('map-context-menu').style.display = 'none';
  _enterSimTrackMode();
});
document.getElementById('sim-track-close-btn').addEventListener('click', _exitSimTrackMode);
_addSwipeToClose(document.getElementById('sim-track-banner'), () => _exitSimTrackMode(), 'y');
document.getElementById('sim-track-start-btn').addEventListener('click', () => {
  if (_simTrackRunning) _stopSimTrack(); else _startSimTrack();
});
document.getElementById('sim-track-course-input').addEventListener('input', (e) => {
  if (!_simTrackMode || _simTrackRunning) return;
  const magVal = parseFloat(e.target.value);
  if (!isNaN(magVal)) _updateSimTrackRay(magneticToTrue(magVal));
});
document.getElementById('sim-track-banner').addEventListener('click', (e) => {
  const chip = e.target.closest('.track-sim-compress');
  if (!chip || chip.disabled) return;
  document.querySelectorAll('.track-sim-compress').forEach(b => b.classList.remove('selected'));
  chip.classList.add('selected');
});

const ROUTE_KEY = 'audiochart-user-routes';
const HIDDEN_ROUTES_KEY = 'audiochart-hidden-routes';
const TRACK_KEY = 'audiochart-user-tracks';
const HIDDEN_TRACKS_KEY = 'audiochart-hidden-tracks';
const IN_PROGRESS_TRACK_KEY = 'audiochart-track-in-progress'; // {startMs, points}
const TOMBSTONE_KEY = 'audiochart-sync-tombstones'; // [{id, type: 'route'|'track', deletedAt}], for Drive merge sync

// id/updatedAt stamping + delete tombstones, feeding the Drive merge sync (see sync_merge.js).
function _newSyncId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function _stampNew(obj) {
  obj.id = _newSyncId();
  obj.createdAt = Date.now();
  obj.updatedAt = Date.now();
  return obj;
}
function _touch(obj) {
  obj.updatedAt = Date.now();
  return obj;
}
// createdAt is set once at creation and never touched again, so it stays a reliable
// "when did I make this" signal even after renames/edits keep bumping updatedAt.
function _routeDateLabel(route) {
  const ms = route.createdAt || route.updatedAt || 0;
  if (!ms) return 'date unknown';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
// Rebuild a plain {lat, lon} point, preserving `overnight` if set — used everywhere
// a points array gets reconstructed via .map(), so the flag survives edits/reroutes.
function _stripPoint(p) {
  return p.overnight ? { lat: p.lat, lon: p.lon, overnight: true } : { lat: p.lat, lon: p.lon };
}
function _tombstone(id, type) {
  if (!id) return; // legacy items migrate lazily; nothing to tombstone until they've been loaded once
  const list = JSON.parse(localStorage.getItem(TOMBSTONE_KEY) || '[]');
  list.push({ id, type, deletedAt: Date.now() });
  localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(list));
}

// One-time migration: backfill id/updatedAt on any route/track saved before this feature existed.
(function _migrateSyncIds() {
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const tracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
  migrateLegacyIds(routes);
  migrateLegacyIds(tracks);
  localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
  localStorage.setItem(TRACK_KEY, JSON.stringify(tracks));
})();

function _loadHiddenRoutes() {
  // Every launch starts tidy: everything hidden until the user picks something
  // to show from the Routes panel. (Previously restored last session's visible
  // set, but that let disposable test routes pile up as permanently-visible.)
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  _hiddenRouteNames = new Set(routes.map(r => r.name));
  _saveHiddenRoutes();
}

function _saveHiddenRoutes() {
  localStorage.setItem(HIDDEN_ROUTES_KEY, JSON.stringify([..._hiddenRouteNames]));
}

function _loadHiddenTracks() {
  // See _loadHiddenRoutes — startup always hides everything, no restore.
  const tracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
  _hiddenTrackNames = new Set(tracks.map(t => t.name));
  _saveHiddenTracks();
}

function _saveHiddenTracks() {
  localStorage.setItem(HIDDEN_TRACKS_KEY, JSON.stringify([..._hiddenTrackNames]));
}

// Place-name reverse-geocode cache: "lat,lon" → nearest named place string
const _placeNameCache = new Map();

function _nearestPlaceName(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (_placeNameCache.has(key)) return _placeNameCache.get(key);
  const features = Query.namedPlaces?.features;
  if (!features || features.length === 0) return null;
  let bestName = null, bestDist = Infinity;
  for (const f of features) {
    const [flon, flat] = f.geometry.coordinates;
    const d = Query.distanceNm(lon, lat, flon, flat);
    if (d < bestDist) { bestDist = d; bestName = f.properties.name; }
  }
  _placeNameCache.set(key, bestName);
  return bestName;
}

// Routes/Tracks search: "from X", "to Y", "from X to Y", "between X and Y" —
// resolved through the same fuzzy place matcher used everywhere else (Query.findPlaceByName),
// so search semantics stay consistent with bearing/focus/hazard queries.
const FROM_TO_MATCH_RADIUS_NM = 5; // generous enough to cover a harbor/anchorage's spread
const _searchPlaceCache = new Map();

function _resolveSearchPlace(text) {
  const key = normalizePlaceName(text);
  if (_searchPlaceCache.has(key)) return _searchPlaceCache.get(key);
  const place = Query.findPlaceByName(key) || null;
  _searchPlaceCache.set(key, place);
  return place;
}

function _matchesPoint(point, placeText, haystackFallback) {
  if (!point || !placeText) return !placeText; // no constraint on this end
  const place = _resolveSearchPlace(placeText);
  if (place) return Query.distanceNm(point.lon, point.lat, place.lon, place.lat) <= FROM_TO_MATCH_RADIUS_NM;
  // Couldn't confidently resolve the place (typo, or outside loaded chart data) —
  // fall back to a plain substring check against this endpoint's own place label.
  return haystackFallback.includes(placeText.toLowerCase());
}

function _itemMatchesSearch(item, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const { from, to, directional } = parseFromToQuery(query);
  const first = item.points?.[0];
  const last  = item.points?.[item.points.length - 1];
  const startHay = first ? (_nearestPlaceName(first.lat, first.lon) || '').toLowerCase() : '';
  const endHay   = last  ? (_nearestPlaceName(last.lat,  last.lon)  || '').toLowerCase() : '';
  if (!from && !to) {
    return (item.name + ' ' + startHay + ' ' + endHay).toLowerCase().includes(q);
  }
  const straight = _matchesPoint(first, from, startHay) && _matchesPoint(last, to, endHay);
  if (directional) return straight;
  const swapped = _matchesPoint(last, from, endHay) && _matchesPoint(first, to, startHay);
  return straight || swapped;
}

function _nextRouteName() {
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  return `Route ${routes.length + 1}`;
}

function _saveRoute(name, points) {
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  routes.push(_stampNew({ name, points: points.map(p => ({ lat: p.lat, lon: p.lng })) }));
  localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
}

function _clearAutoRoute() {
  _autoRouteStart = _autoRouteEnd = _autoRouteName = null;
  if (_autoRouteStartMarker)  { _autoRouteStartMarker.remove();  _autoRouteStartMarker  = null; }
  if (_autoRouteEndMarker)    { _autoRouteEndMarker.remove();    _autoRouteEndMarker    = null; }
  if (_autoRoutePreviewLayer) { _autoRoutePreviewLayer.remove(); _autoRoutePreviewLayer = null; }
}

async function _autoRouteProg(start, end, onUpdate, onText = null, _escapeAttempted = false) {
  // Visibility Graph + A* (Euclidean Shortest Path with Polygonal Obstacles).
  // Nodes: start, end, and polygon vertices in the padded bounding box.
  // Edges are checked lazily during A* expansion.
  const PAD_NM    = 2.0;
  const SAFETY_NM   = 0.05;  // ~100 yards — kept as the hazard/tidal-ring offset floor (see HAZARD_OFFSET_LADDER); no longer used for land-ring standoff
  const CORRIDOR_NM = 3.0;   // include LAND rings within this distance of the direct line
  // A genuinely island-dotted stretch (e.g. Blue Hill Bay/Penobscot Bay —
  // verified live: 157 separate non-blocking land rings in one 9nm route's
  // corridor, ~2200 nodes from convex vertices alone) can still overwhelm A*
  // even with each individual ring's vertex selection unchanged/correct. This
  // is a NODE budget, not a ring-count budget, because unlike
  // MAX_EXTRA_NON_BLOCKING_RINGS's uniform tiny synthetic hazard circles,
  // real coastline rings vary hugely in vertex count (a long mainland stretch
  // running near-parallel to the route can contribute far more vertices than
  // a small island) — capping ring COUNT alone barely moved the real node
  // total in testing. Each already-included ring still keeps its FULL
  // correct convex-vertex set (no per-ring thinning, unlike hazards); this
  // only stops pulling in MORE nearby islands, closest-to-the-line first,
  // once the budget is spent.
  const MAX_LAND_NON_BLOCKING_NODES = 500;
  // A mariner keeps land at a distance, not right at the safety minimum: try
  // a comfortable ~0.5nm standoff first, only accepting something tighter
  // (down to ~0.15nm/275yd) where the geometry genuinely won't allow more —
  // e.g. island-dense or inland water. Never falls all the way to the old
  // 100yd floor here; that tight a clearance is reserved for water a real
  // chart has verified as a marked channel (Query.channelNeighbors' edges,
  // which don't go through this ladder at all — they follow the charted
  // centerline directly). Point-hazard/tidal-zone rings are a different
  // concern (avoiding a specific charted danger, not general coastal
  // standoff) and keep the original, unchanged ladder.
  const COASTAL_STANDOFF_LADDER = [0.5, 0.25, 0.15];
  const HAZARD_OFFSET_LADDER = [SAFETY_NM, SAFETY_NM * 2, SAFETY_NM * 4];
  // One honest wall-clock budget for the WHOLE call (setup + A*), not just the
  // search loop — replaces the old unbounded-setup + 8s-A*-only + up-to-2x-via-
  // escalation pattern, which could legitimately run 16s+ for one leg with no
  // way for the caller to know. Checked after setup and periodically during A*
  // (both against _profT0 below); exceeding it means the honest straight-line
  // fallback (_showRouteFallbackWarning), never a partial/unverified path.
  const DEADLINE_MS = 5000;
  // Point-hazard/tidal rings only need a graph NODE when genuinely close to
  // the direct line — segBlocked already checks every one of them for every
  // candidate edge regardless of this, so a distant one not getting a node
  // doesn't weaken safety, it just isn't offered as a routing waypoint.
  // Reusing CORRIDOR_NM=3 here was the dominant cost in a real failing case
  // (rock-strewn Maine coast): ~1354 hazard-circle rings within 3nm of one
  // 16.5nm line, each promoted to up to 10 nodes, for ~12,900 total nodes
  // before A* even started — most of them irrelevant to any real path.
  const EXTRA_CORRIDOR_NM = 0.5;
  // Even at 0.5nm, a real Penobscot Bay ledge field can put hundreds of
  // separate charted rocks in the corridor (verified live: 1781 extra rings
  // in one 9nm route's bbox, ~420 within EXTRA_CORRIDOR_NM, uncapped, before
  // this existed). segBlocked/the extraGrid below still checks EVERY extra
  // ring in the bbox for collisions regardless of this cap — this only
  // bounds how many get to OFFER themselves as A* routing waypoints, ranked
  // closest-to-the-line first (see the extraRings loop after _addRingNodes).
  const MAX_EXTRA_NON_BLOCKING_RINGS = 60;

  const delay = ms => new Promise(r => setTimeout(r, ms));
  const _profT0 = Date.now();

  // Wait for land data to finish loading (resolves instantly after first load).
  await Query.whenLandLoaded();

  // Let the overlay and preview line paint before we do any real work.
  await delay(0);

  // Long-range passage decomposition (Piece 1d) — everything below this is
  // completely unchanged for routes under the threshold; see the block
  // comment above LONG_RANGE_NM (defined after this function) for why more
  // time alone can't fix a route this long instead.
  const directNm = Query.distanceNm(start.lon, start.lat, end.lon, end.lat);
  if (directNm > LONG_RANGE_NM) {
    console.log(`[autoRoute] long-range passage: ${directNm.toFixed(1)}nm direct (> ${LONG_RANGE_NM}nm threshold) — decomposing instead of one visibility-graph search`);
    return await _longRangeRoute(start, end, onUpdate, onText);
  }

  // ── Bounding box ───────────────────────────────────────────────────────────
  const midLat = (start.lat + end.lat) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  const padLon = PAD_NM / (60 * cosLat);
  const padLat = PAD_NM / 60;
  const bMinLon = Math.min(start.lon, end.lon) - padLon;
  const bMaxLon = Math.max(start.lon, end.lon) + padLon;
  const bMinLat = Math.min(start.lat, end.lat) - padLat;
  const bMaxLat = Math.max(start.lat, end.lat) + padLat;

  // A directly-blocking ring's "every convex vertex" rule (see _addRingNodes)
  // is only safe when that ring is a normal local landmass — but the bundled
  // land data also includes a handful of enormous, simplified "whole East
  // Coast" rings (thousands of vertices, hundreds of miles of bbox) for
  // broad-area fallback coverage. Real bug found in production: a Portsmouth
  // NH -> York ME route (~8nm) got routed via a vertex near Newburyport MA
  // (~20nm off-route) because that vertex just happened to have a sharper
  // local turn angle than the real, relevant vertices near Kittery Point on
  // the SAME giant ring — turn-angle ranking alone has no sense of "near
  // this route" at all. relevantNm bounds candidate vertices (from ANY
  // ring, not just the oversized ones) to a window that scales with the
  // route's own length — generous enough for a real local detour (an
  // island's far side, sized like the old escalation window it replaces)
  // but nowhere near enough to reach an irrelevant point two towns over.
  const relevantNm = Math.min(Math.max(Query.distanceNm(start.lon, start.lat, end.lon, end.lat) * 0.75, 5), 25);
  const relevantLon = relevantNm / (60 * cosLat), relevantLat = relevantNm / 60;
  const relMinLon = Math.min(start.lon, end.lon) - relevantLon;
  const relMaxLon = Math.max(start.lon, end.lon) + relevantLon;
  const relMinLat = Math.min(start.lat, end.lat) - relevantLat;
  const relMaxLat = Math.max(start.lat, end.lat) + relevantLat;
  function _inRelevantWindow(lon, lat) {
    return lon >= relMinLon && lon <= relMaxLon && lat >= relMinLat && lat <= relMaxLat;
  }

  const nodes = [start, end];  // index 0 = start, 1 = end

  // ── Channel graph (fairway centerlines + recommended tracks) ─────────────
  // Nodes are water-only by construction (real charted channel/track data),
  // so no land-offset dance is needed the way land-ring vertices get below.
  // channelKeyToIdx lets the A* loop map a channel node's graph neighbors
  // (returned by lon/lat) back to this call's nodes[] array indices; an
  // empty Query.channelNodesNear (no data loaded, or none in this bbox) is
  // what guarantees zero behavior change wherever channel data is absent —
  // no separate feature flag needed.
  const channelNodeIdxSet = new Set();
  const channelKeyToIdx = new Map();
  if (Query.channelNodesNear) {
    for (const cn of Query.channelNodesNear(bMinLon, bMaxLon, bMinLat, bMaxLat)) {
      const idx = nodes.length;
      nodes.push({ lon: cn.lon, lat: cn.lat });
      channelNodeIdxSet.add(idx);
      channelKeyToIdx.set(cn.key, idx);
    }
  }

  // ── Point-to-segment distance (nm) ────────────────────────────────────────
  function _ptSegDistNm(ptLon, ptLat, aLon, aLat, bLon, bLat) {
    const dx = bLon - aLon, dy = bLat - aLat;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Query.distanceNm(ptLon, ptLat, aLon, aLat);
    const t = Math.max(0, Math.min(1, ((ptLon - aLon) * dx + (ptLat - aLat) * dy) / len2));
    return Query.distanceNm(ptLon, ptLat, aLon + t * dx, aLat + t * dy);
  }

  // ── Point-in-ring (even-odd rule) ──────────────────────────────────────────
  function _pointInRing(px, py, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // ── Tide-aware depth: which drying areas are hazardous right now? ──────────
  const draftFt = parseFloat(document.getElementById('nf-draft-ft')?.value) || 5.0;
  const draftM  = draftFt * 0.3048;
  const tideM   = _tideHeight;
  // eff = effective depth at current tide — matches the depth-overlay logic at
  // ~app.js:6281 (eff = valsou + tideHeight; hazard if eff <= draft). The old
  // filter here (`v >= 0 && tideM < draftM + v`) was inverted: it excluded
  // drying/intertidal areas (valsou < 0) from ever counting as hazards, and
  // flagged progressively *safer, deeper* zones as obstacles as valsou grew.
  const tidalObs = (Query.getDepthZones() || []).filter(f => {
    const v = f.properties?.valsou;
    if (v == null) return false;
    const eff = v + tideM;
    return eff <= draftM;
  });

  // ── Land: served by query.js's persistent edge index ──────────────────
  // Land geometry is static and shared by every route computation this
  // session, so it's indexed ONCE at load time (see _buildLandEdgeIndex in
  // query.js) rather than rescanned here — profiling a real failing route
  // (Sorrento -> Blue Hill Bay) found the old per-call linear scan spent 32
  // SECONDS just offsetting ~4900 graph nodes off land before A* even
  // started. Only the *dynamic* obstacles below (tidal drying zones, which
  // depend on current tide + draft, and point-hazard circles) still need a
  // small per-call ring list — land goes through Query.landBlocks/isLandAt/
  // landRingsNear instead.
  if (!Query.getLandPolygons()) console.warn('[autoRoute] land.geojson not loaded — routing without land avoidance');

  const extraRings = [];  // tidal obstacle + point-hazard circles for this call
  function _processExtraRing(outer) {
    let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity;
    let cx = 0, cy = 0;
    for (const [x, y] of outer) {
      if (x < rMinX) rMinX = x; if (x > rMaxX) rMaxX = x;
      if (y < rMinY) rMinY = y; if (y > rMaxY) rMaxY = y;
      cx += x; cy += y;
    }
    if (rMaxX < bMinLon || rMinX > bMaxLon || rMaxY < bMinLat || rMinY > bMaxLat) return;
    cx /= outer.length; cy /= outer.length;
    extraRings.push({ ring: outer, rMinX, rMaxX, rMinY, rMaxY, cx, cy });
  }

  for (const feat of tidalObs) {
    const { type, coordinates } = feat.geometry;
    const polys = type === 'Polygon' ? [coordinates] : coordinates;
    for (const rings of polys) _processExtraRing(rings[0]);
  }

  // Point hazards (underwater rocks, obstructions, wrecks) are stored as Point
  // geometry in hazards.geojson, which Query.getDepthZones() explicitly excludes
  // (it only returns 'shallow area' Polygons) — so without this, the pathfinder
  // has no idea a charted rock exists and can route straight past one at
  // point-blank range. Turn each into a small circular no-go ring and feed it
  // through the exact same avoidance pipeline (segBlocked, node offsetting,
  // corridor search) rather than adding a parallel obstacle system.
  const HAZARD_SAFETY_NM = 0.05;  // ~100 yards — matches the corridor used by
                                   // _checkRouteHazards/_autoFixSelectedNodes
  const HAZARD_LABELS = new Set(['underwater rock', 'obstruction', 'wreck', 'UWTROC', 'OBSTRN', 'WRECKS']);
  function _hazardCircleRing(lon, lat, radiusNm, sides = 10) {
    const cv = Math.cos(lat * Math.PI / 180);
    const ring = [];
    for (let i = 0; i <= sides; i++) {
      const ang = (i / sides) * 2 * Math.PI;
      ring.push([
        lon + radiusNm / (60 * cv) * Math.cos(ang),
        lat + radiusNm / 60 * Math.sin(ang),
      ]);
    }
    return ring;
  }
  for (const f of (Query.hazards?.features || [])) {
    if (f.geometry?.type !== 'Point') continue;
    const label = f.properties?.label || f.properties?.objtype || '';
    if (!HAZARD_LABELS.has(label)) continue;
    const [lon, lat] = f.geometry.coordinates;
    if (lon < bMinLon || lon > bMaxLon || lat < bMinLat || lat > bMaxLat) continue;
    _processExtraRing(_hazardCircleRing(lon, lat, HAZARD_SAFETY_NM));
  }

  // Land rings near the corridor, for graph node generation — cached
  // bbox/centroid from the index, no need to re-walk each ring's vertices.
  const landRingsInBox = Query.landRingsNear(bMinLon, bMaxLon, bMinLat, bMaxLat);
  console.log(`[autoRoute] ring-filter took ${Date.now() - _profT0}ms — ${landRingsInBox.length} land rings, ${extraRings.length} extra (tidal/hazard) rings in bbox`);

  // extraRings (tidal drying zones + point-hazard circles) is per-call and
  // dynamic — not worth a persistent index — but can still reach several
  // hundred entries in a busy area, and segBlocked/_isOnLandLocal are called
  // once per A* edge check / node-offset candidate. A plain per-call scan
  // over hundreds of rings on every one of those calls was the next
  // bottleneck after land got indexed (A* was only completing ~20-180
  // expansions before hitting its own time cap on a real failing route).
  // Bucket into a small grid over this call's own bounding box, same idea
  // as the persistent land index but rebuilt fresh each call since the set
  // itself is small and changes per route.
  const EXTRA_GRID_N = 24;
  const extraGridCellLon = (bMaxLon - bMinLon) / EXTRA_GRID_N || 1e-9;
  const extraGridCellLat = (bMaxLat - bMinLat) / EXTRA_GRID_N || 1e-9;
  const _extraCellX = lon => Math.min(EXTRA_GRID_N - 1, Math.max(0, Math.floor((lon - bMinLon) / extraGridCellLon)));
  const _extraCellY = lat => Math.min(EXTRA_GRID_N - 1, Math.max(0, Math.floor((lat - bMinLat) / extraGridCellLat)));
  // Numeric key, not a template-string concat — avoids string
  // allocation/hashing on every lookup. segBlocked is the hottest call in
  // auto-routing (600K+ calls in one real search); this and the matching
  // fix in query.js's land index together cut its average cost ~5x.
  const _extraCellKey = (gx, gy) => gx * EXTRA_GRID_N + gy;
  const extraGrid = new Map();
  for (const entry of extraRings) {
    const x0 = _extraCellX(entry.rMinX), x1 = _extraCellX(entry.rMaxX);
    const y0 = _extraCellY(entry.rMinY), y1 = _extraCellY(entry.rMaxY);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = _extraCellKey(gx, gy);
        let arr = extraGrid.get(key);
        if (!arr) { arr = []; extraGrid.set(key, arr); }
        arr.push(entry);
      }
    }
  }
  let _extraQueryId = 0;

  function segBlocked(lon1, lat1, lon2, lat2) {
    if (Query.landBlocks(lon1, lat1, lon2, lat2)) return true;
    const sx = Math.min(lon1, lon2), ex = Math.max(lon1, lon2);
    const sy = Math.min(lat1, lat2), ey = Math.max(lat1, lat2);
    const x0 = _extraCellX(sx), x1 = _extraCellX(ex);
    const y0 = _extraCellY(sy), y1 = _extraCellY(ey);
    _extraQueryId++;
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const arr = extraGrid.get(_extraCellKey(gx, gy));
        if (!arr) continue;
        for (const entry of arr) {
          if (entry._eq === _extraQueryId) continue;
          entry._eq = _extraQueryId;
          const { ring, rMinX, rMaxX, rMinY, rMaxY } = entry;
          if (rMaxX < sx || rMinX > ex || rMaxY < sy || rMinY > ey) continue;
          if (Query.ringBlocks(ring, lon1, lat1, lon2, lat2)) return true;
        }
      }
    }
    return false;
  }

  // Validates a candidate offset point actually landed in open water — a
  // fixed offset direction (e.g. "away from the ring's centroid") can be
  // wrong on a concave/convoluted coastline (a cove, a narrow point) and
  // land the "safety offset" point back on dry ground.
  function _isOnLandLocal(lon, lat) {
    if (Query.isLandAt(lon, lat)) return true;
    const arr = extraGrid.get(_extraCellKey(_extraCellX(lon), _extraCellY(lat)));
    if (!arr) return false;
    for (const { ring, rMinX, rMaxX, rMinY, rMaxY } of arr) {
      if (lon < rMinX || lon > rMaxX || lat < rMinY || lat > rMaxY) continue;
      if (_pointInRing(lon, lat, ring)) return true;
    }
    return false;
  }

  // The visual basemap and the chart polygon data used for routing don't
  // always agree pixel-for-pixel — a click that looks like clear water can
  // land just inside the chart's land boundary. A point strictly inside a
  // polygon has NO reachable neighbor (any line out of it must cross the
  // boundary), so without this the search fails after a single, instant
  // check — which looks like the router "did nothing" rather than having
  // actually searched. Nudge a small distance to the nearest confirmed-water
  // spot rather than fail outright.
  const SNAP_RADIUS_NM = 0.15;
  function _snapOffLand(pt) {
    if (!_isOnLandLocal(pt.lon, pt.lat)) return pt;
    for (let r = 0.02; r <= SNAP_RADIUS_NM; r += 0.02) {
      for (let ang = 0; ang < 360; ang += 30) {
        const rad = ang * Math.PI / 180;
        const cv = Math.cos(pt.lat * Math.PI / 180);
        const tx = pt.lon + r / (60 * cv) * Math.cos(rad);
        const ty = pt.lat + r / 60 * Math.sin(rad);
        if (!_isOnLandLocal(tx, ty)) return { lat: ty, lon: tx };
      }
    }
    // Still on land past SNAP_RADIUS_NM — this isn't a chart/basemap
    // mismatch anymore, the point is genuinely inland (e.g. a waypoint
    // dropped on a shoreline trail, not in the harbor). Confirmed real case:
    // a point on York ME's Cliff Walk footpath, ~0.32nm from open water —
    // just past this local search, but well within reach of a real
    // destination. Fall back to Query.findWaterNear's wider (2nm default)
    // search, same mechanism already used for named-destination lookups
    // (see _drawNameDestBtn), so a start/end that's merely near the coast
    // still gets a usable, nearby water point instead of a routing failure
    // that looks like a bug.
    const water = Query.findWaterNear?.(pt.lon, pt.lat);
    if (water) {
      console.warn(`[autoRoute] endpoint was on land — moved ${water.movedNm.toFixed(2)}nm to open water${water.viaPlace ? ` (${water.viaPlace})` : ''}`);
      return { lat: water.lat, lon: water.lon };
    }
    return pt;
  }
  start = _snapOffLand(start);
  end   = _snapOffLand(end);
  nodes[0] = start;
  nodes[1] = end;

  // ── Convex-vertex node collection ───────────────────────────────────────────
  // A shortest path around a polygonal obstacle only ever needs to bend at a
  // CONVEX vertex of that obstacle (a headland poking into free space) — a
  // concave vertex (a cove) is never a necessary bend point, since the taut
  // string skips over the indentation (see the convex-flag computation this
  // pairs with in query.js's _buildLandEdgeIndex/processRing). This replaces
  // the old "up to 30 vertices closest to the line" sample: smaller (correct
  // bend points only, not a distance-based guess) and can't exclude a real
  // far-side bend point — an island's tip is a convex vertex of the island's
  // OWN ring regardless of how far it sits from the direct line, so it's
  // included automatically once that ring is, with no separate "escalation"
  // pass needed to go find it.
  //
  // Two tiers:
  //   - A ring that directly blocks the line (isBlocking=true): every convex
  //     vertex, uncapped by distance — this is what lets a single A* pass
  //     thread between many separate blocking rings at once (Piscataqua's 8,
  //     an island's 10+), instead of only ever getting to fix one per retry.
  //   - A ring merely near the corridor (isBlocking=false): convex vertices
  //     AND within CORRIDOR_NM — keeps the common case (an incidental nearby
  //     island) cheap.
  const MAX_BLOCKING_VERTS = 300;  // safety valve for the ~10-11k-vertex
                                    // mainland/coastline ring — if a directly-
                                    // blocking ring has more convex vertices
                                    // than this, keep the sharpest headlands
                                    // (by exterior turn angle), not the
                                    // closest-to-line ones this replaces.
  // Real charted shallow-area (DEPARE) polygons among the "extra" rings are
  // NOT small synthetic hazard circles — they're real charted shapes, and a
  // real 9nm line through a shoal-strewn bay can directly cross MANY of them
  // at once. Verified live: 22 separate blocking shallow-area polygons on
  // one Blue Hill Bay line, ~71 vertices each on average (each individually
  // well under MAX_BLOCKING_VERTS, so that per-ring cap never triggered) —
  // 1559 nodes total, the dominant cost after every other lever here. A
  // single mainland ring can legitimately need up to MAX_BLOCKING_VERTS
  // vertices to thread a long, complex coastline; a shoal polygon is a much
  // simpler shape and doesn't need nearly that many per ring even when
  // several stack up in the same corridor.
  const MAX_EXTRA_BLOCKING_VERTS = 8;
  function _addRingNodes(entry, isBlocking, offsetLadder, checkClearance, isExtra) {
    const { ring, cx, cy, convex } = entry;
    const n = ring.length - 1; // -1: skip closing duplicate vertex
    let indices = [];
    if (isExtra && !isBlocking) {
      // A non-blocking hazard/tidal circle is tiny (~0.05nm radius) and only
      // ever needs "pass on this side"/"pass on that side"-style waypoints —
      // every one of its ~10 vertices being a candidate (today's behavior,
      // since these rings have no convex[] array) is what let a 9nm open-
      // water route accumulate 4205 graph nodes from 0 land obstacles. Keep
      // only the ring's 4 route-relative extremes instead.
      indices = _pickExtremeVerts(ring, n, cx, cy);
    } else {
      for (let k = 0; k < n; k++) {
        // extraRings (tidal/hazard circles) don't carry a precomputed convex
        // array — a small polygon approximating a circle is fully convex
        // anyway, so treat a missing array as "every vertex counts".
        if (convex && !convex[k]) continue;
        const [vx, vy] = ring[k];
        // "No distance-to-LINE cutoff" for a blocking ring (that's the real
        // fix for MDI/Piscataqua-style local detours) is not the same as "no
        // geographic relevance check at all" — a ring the size of the whole
        // East Coast still only has a small portion actually near this route.
        if (isBlocking) { if (_inRelevantWindow(vx, vy)) indices.push(k); continue; }
        if (_ptSegDistNm(vx, vy, start.lon, start.lat, end.lon, end.lat) <= CORRIDOR_NM) indices.push(k);
      }
    }
    const blockingVertCap = isExtra ? MAX_EXTRA_BLOCKING_VERTS : MAX_BLOCKING_VERTS;
    if (isBlocking && indices.length > blockingVertCap) {
      const scored = indices.map(k => {
        const [vx, vy] = ring[k];
        const [ax, ay] = ring[(k - 1 + n) % n];
        const [bx, by] = ring[(k + 1) % n];
        const e1x = vx - ax, e1y = vy - ay, e2x = bx - vx, e2y = by - vy;
        const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
        const dot = Math.max(-1, Math.min(1, (e1x * e2x + e1y * e2y) / (l1 * l2)));
        return { k, angle: Math.acos(dot) };  // larger = sharper turn
      });
      scored.sort((a, b) => b.angle - a.angle);
      indices = scored.slice(0, blockingVertCap).map(s => s.k);
    }
    for (const k of indices) {
      const [vx, vy] = ring[k];
      // Candidate offset directions: the vertex's local outward normal
      // (averaged from its two adjacent ring edges, both possible signs since
      // ring winding isn't assumed), then the ring-centroid direction as a
      // fallback. A single fixed direction (e.g. centroid-only) works for a
      // simple convex island but regularly lands ON LAND on a concave,
      // convoluted coastline (a cove, a point) — verified directly against
      // real chart data: centroid-only put ~45% of offset points back on
      // land. Try each candidate at increasing distances and keep the first
      // one that's actually confirmed to be in open water; skip the vertex
      // entirely (rather than adding a broken, unusable node) if none work.
      const [ax, ay] = ring[(k - 1 + n) % n];
      const [bx, by] = ring[(k + 1) % n];
      const e1x = vx - ax, e1y = vy - ay, e2x = bx - vx, e2y = by - vy;
      let n1x = e1y, n1y = -e1x, n2x = e2y, n2y = -e2x;
      const l1 = Math.hypot(n1x, n1y) || 1, l2 = Math.hypot(n2x, n2y) || 1;
      n1x /= l1; n1y /= l1; n2x /= l2; n2y /= l2;
      let lnx = n1x + n2x, lny = n1y + n2y;
      const ll = Math.hypot(lnx, lny);
      if (ll > 1e-10) { lnx /= ll; lny /= ll; } else { lnx = n1x; lny = n1y; }
      const cdx = vx - cx, cdy = vy - cy, cl = Math.hypot(cdx, cdy) || 1;
      const cnx = cdx / cl, cny = cdy / cl;
      const candidates = [[lnx, lny], [-lnx, -lny], [cnx, cny], [-cnx, -cny]];

      let placed = false;
      for (const [dx, dy] of candidates) {
        for (const dist of offsetLadder) {
          const cv = Math.cos(vy * Math.PI / 180);
          const nx = vx + dist / (60 * cv) * dx;
          const ny = vy + dist / 60 * dy;
          if (_isOnLandLocal(nx, ny)) continue;
          // "Not literally on land" alone isn't the same as "actually dist
          // away from land" — the offset direction is derived from THIS
          // vertex's own ring, but a narrow passage (e.g. a river between two
          // close banks) can land the candidate clear of ITS ring yet still
          // close to a different, nearby one. Confirmed as a real gap by the
          // Piece 1c test suite (a 0.016nm-from-land node on the Portsmouth
          // approach) before this check existed — only applied for the
          // coastal standoff ladder (checkClearance), not the unchanged
          // hazard/tidal-ring ladder, which never claimed a standoff distance.
          if (checkClearance && Query.distanceToLandNm(nx, ny, dist) < dist * 0.8) continue;
          nodes.push({ lon: nx, lat: ny }); placed = true; break;
        }
        if (placed) break;
      }
    }
  }

  // The only routing-relevant points on a small non-blocking hazard circle
  // are its extremes relative to the route's OWN direction — the two points
  // where a path could pass left/right of it, and the two where it could
  // pass in front of/behind it. (Every other vertex of the ~10-gon circle
  // approximation is redundant: it can never be a better bend point than one
  // of these four.) This never changes what segBlocked/Query.ringBlocks
  // check — those always use the ring's full geometry — it only limits which
  // vertices get offered to A* as candidate waypoints.
  function _pickExtremeVerts(ring, n, cx, cy) {
    const rdx = (end.lon - start.lon) * 60 * cosLat, rdy = (end.lat - start.lat) * 60;
    const rl = Math.hypot(rdx, rdy) || 1;
    const ux = rdx / rl, uy = rdy / rl;   // unit vector along the route
    const px = -uy, py = ux;              // unit vector across the route
    let iAlongMax = 0, iAlongMin = 0, iSideMax = 0, iSideMin = 0;
    let alongMax = -Infinity, alongMin = Infinity, sideMax = -Infinity, sideMin = Infinity;
    for (let k = 0; k < n; k++) {
      const [vx, vy] = ring[k];
      const dxNm = (vx - cx) * 60 * cosLat, dyNm = (vy - cy) * 60;
      const along = dxNm * ux + dyNm * uy;
      const side  = dxNm * px + dyNm * py;
      if (along > alongMax) { alongMax = along; iAlongMax = k; }
      if (along < alongMin) { alongMin = along; iAlongMin = k; }
      if (side  > sideMax)  { sideMax  = side;  iSideMax  = k; }
      if (side  < sideMin)  { sideMin  = side;  iSideMin  = k; }
    }
    return [...new Set([iAlongMax, iAlongMin, iSideMax, iSideMin])];
  }

  // All blocking rings get full tier-1 treatment in this single pass — this
  // is what actually fixes a multi-obstacle passage (Piscataqua's 8 rings,
  // MDI's 10): every one of them contributes its real bend points into the
  // same shared node array, so A* can thread between all of them at once,
  // instead of only ever getting one ring widened per retry.
  const blockingLandRings = [];
  const seenRings = new Set(landRingsInBox.map(e => e.ring));
  const nonBlockingLandCandidates = [];
  for (const entry of landRingsInBox) {
    if (Query.ringBlocks(entry.ring, start.lon, start.lat, end.lon, end.lat)) {
      _addRingNodes(entry, true, COASTAL_STANDOFF_LADDER, true);
      blockingLandRings.push(entry);
      continue;
    }
    const d = _ptSegDistNm(entry.cx, entry.cy, start.lon, start.lat, end.lon, end.lat);
    if (d <= CORRIDOR_NM) nonBlockingLandCandidates.push({ entry, d });
  }
  // Shared node budget across BOTH non-blocking land sources below (this
  // corridor pass and the staggered-obstacle pass) — closest-to-the-line
  // islands get first claim on it either way.
  let landNonBlockingNodesAdded = 0;
  nonBlockingLandCandidates.sort((a, b) => a.d - b.d);
  for (const { entry } of nonBlockingLandCandidates) {
    if (landNonBlockingNodesAdded >= MAX_LAND_NON_BLOCKING_NODES) break;
    const before = nodes.length;
    _addRingNodes(entry, false, COASTAL_STANDOFF_LADDER, true);
    landNonBlockingNodesAdded += nodes.length - before;
  }
  // Staggered-obstacle case: a detour around a directly-blocking ring can
  // reveal a second obstacle that doesn't block the ORIGINAL direct line and
  // sits outside CORRIDOR_NM of it. One bounded, non-iterative hop — pull in
  // any land ring near each blocking ring's own extent (not a rescan; reuses
  // the persistent index) — rather than an unbounded/iterative search. Real
  // multi-obstacle cases are, by definition, obstacles near EACH OTHER, which
  // is exactly what this captures.
  const corridorLon = CORRIDOR_NM / (60 * cosLat);
  const corridorLat = CORRIDOR_NM / 60;
  const staggeredCandidates = [];
  for (const entry of blockingLandRings) {
    const neighbors = Query.landRingsNear(
      entry.rMinX - corridorLon, entry.rMaxX + corridorLon,
      entry.rMinY - corridorLat, entry.rMaxY + corridorLat,
    );
    for (const nb of neighbors) {
      if (seenRings.has(nb.ring)) continue;
      seenRings.add(nb.ring);
      staggeredCandidates.push({ entry: nb, d: _ptSegDistNm(nb.cx, nb.cy, start.lon, start.lat, end.lon, end.lat) });
    }
  }
  staggeredCandidates.sort((a, b) => a.d - b.d);
  for (const { entry } of staggeredCandidates) {
    if (landNonBlockingNodesAdded >= MAX_LAND_NON_BLOCKING_NODES) break;
    const before = nodes.length;
    _addRingNodes(entry, false, COASTAL_STANDOFF_LADDER, true);
    landNonBlockingNodesAdded += nodes.length - before;
  }
  const nonBlockingExtraCandidates = [];
  for (const entry of extraRings) {
    const blocks = Query.ringBlocks(entry.ring, start.lon, start.lat, end.lon, end.lat);
    if (blocks) { _addRingNodes(entry, true, HAZARD_OFFSET_LADDER, false, true); continue; }
    const d = _ptSegDistNm(entry.cx, entry.cy, start.lon, start.lat, end.lon, end.lat);
    if (d <= EXTRA_CORRIDOR_NM) nonBlockingExtraCandidates.push({ entry, d });
  }
  // A dense real ledge field can put hundreds of non-blocking hazards in the
  // corridor at once — cap how many get to contribute routing waypoints,
  // closest-to-the-line first (they're still all checked for actual
  // collisions via extraGrid/segBlocked above, cap or no cap). See
  // MAX_EXTRA_NON_BLOCKING_RINGS's comment for the real case this fixes.
  nonBlockingExtraCandidates.sort((a, b) => a.d - b.d);
  for (const { entry } of nonBlockingExtraCandidates.slice(0, MAX_EXTRA_NON_BLOCKING_RINGS)) {
    _addRingNodes(entry, false, HAZARD_OFFSET_LADDER, false, true);
  }

  if (Date.now() - _profT0 > DEADLINE_MS) {
    console.warn('[autoRoute] deadline exceeded during setup — returning straight line');
    return [start, end];
  }

  console.log(`[autoRoute] setup took ${Date.now() - _profT0}ms — ${nodes.length} nodes, ${landRingsInBox.length} land rings in bbox, ${extraRings.length} extra rings`);

  // A tight, enclosed anchorage (e.g. a narrow creek behind close-in ledges)
  // can leave the raw start/end point with ZERO clear line-of-sight to any
  // node in the graph at all — not a slow search, a genuinely empty one.
  // Verified live: a real Perry Creek (Vinalhaven) departure had 0/1057
  // candidate edges clear (1018 land-blocked, 39 hazard-blocked). No amount
  // of node thinning fixes that; the fix is the same "get clear of the
  // immediate shore first" idea _longRangeRoute already uses via
  // Query.findClearOffshorePoint, just triggered by actual local blockage
  // instead of only by distance. _escapeAttempted caps this at one retry so
  // a pathological case can't recurse forever — it just falls back honestly.
  if (!_escapeAttempted) {
    const _hasClearEdge = (p) => {
      for (let j = 0; j < nodes.length; j++) {
        const q = nodes[j];
        if (q === p) continue;
        if (!segBlocked(p.lon, p.lat, q.lon, q.lat)) return true;
      }
      return false;
    };
    // A sub-leg that fell back to its own raw 2-point line is only a real
    // success if that line is actually clear — checked against land AND
    // hazards/shoals via this call's own segBlocked, not the narrower
    // land-only _legFailed used elsewhere (that gap is pre-existing in
    // _longRangeRoute too, but matters acutely here since findClearOffshorePoint
    // itself only rules out LAND along its ray, never hazards).
    const _subLegOk = (leg) => leg.length > 2 || !segBlocked(leg[0].lon, leg[0].lat, leg[1].lon, leg[1].lat);
    const startBlocked = !_hasClearEdge(start);
    const endBlocked = !_hasClearEdge(end);
    if (startBlocked || endBlocked) {
      console.log(`[autoRoute] locally enclosed endpoint(s) detected — startBlocked=${startBlocked} endBlocked=${endBlocked}, attempting local escape`);
      // Each recursive sub-call below has its OWN full DEADLINE_MS budget —
      // without a check between them, a call that's slow-failing (not
      // instant, like Perry Creek's real case: each sub-attempt legitimately
      // explores its own local graph before giving up) can compound to
      // several times DEADLINE_MS. Gate each subsequent step on the OUTER
      // call's own elapsed time so the whole escape attempt still honors
      // roughly one DEADLINE_MS-sized budget, same as every other path here.
      let effStart = start, prefix = [];
      let effEnd = end, suffix = [];
      if (startBlocked) {
        const departurePt = Query.findClearOffshorePoint(start.lon, start.lat, end.lon, end.lat);
        if (departurePt) {
          const departLeg = await _autoRouteProg(start, departurePt, onUpdate, onText, true);
          if (_subLegOk(departLeg)) { prefix = departLeg.slice(0, -1); effStart = departurePt; }
        }
      }
      if (endBlocked && Date.now() - _profT0 <= DEADLINE_MS) {
        const arrivalPt = Query.findClearOffshorePoint(end.lon, end.lat, start.lon, start.lat);
        if (arrivalPt) {
          const arriveLeg = await _autoRouteProg(arrivalPt, end, onUpdate, onText, true);
          if (_subLegOk(arriveLeg)) { suffix = arriveLeg.slice(1); effEnd = arrivalPt; }
        }
      }
      if ((prefix.length || suffix.length) && Date.now() - _profT0 <= DEADLINE_MS) {
        const middle = await _autoRouteProg(effStart, effEnd, onUpdate, onText, true);
        if (_subLegOk(middle)) {
          console.log(`[autoRoute] local escape succeeded — prefix ${prefix.length}pts, middle ${middle.length}pts, suffix ${suffix.length}pts`);
          return [...prefix, ...middle, ...suffix.slice(1)];
        }
      }
      // Escape attempt didn't produce a verified-clear path — fall through to
      // the normal search below, which will honestly report no-path-found
      // rather than ever return something unverified.
    }
  }

  if (onText) onText(`Routing… 0 / ${nodes.length} nodes`);

  // ── Min-heap helpers ───────────────────────────────────────────────────────
  const heap = [];
  function hpush(score, idx) {
    heap.push([score, idx]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  }
  function hpop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        let m = k, l = 2 * k + 1, r = l + 1;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  }

  // ── A* ────────────────────────────────────────────────────────────────────
  const N   = nodes.length;
  const INF = 1e9;
  const gScore = new Float64Array(N).fill(INF);
  const prev   = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N); // finalized nodes — see note below
  gScore[0]    = 0;
  hpush(Query.distanceNm(start.lon, start.lat, end.lon, end.lat), 0);

  function tracePath(endIdx) {
    const p = [];
    for (let i = endIdx; i !== -1; i = prev[i]) p.push(nodes[i]);
    return p.reverse();
  }

  let expansions = 0;
  let searchDot = null;
  let pathImproved = false;

  while (heap.length) {
    const [, curr] = hpop();
    if (curr === 1) break;  // reached end node
    // A node can be pushed multiple times (once per improvement found); once
    // popped, its gScore is already optimal (non-negative edge weights), so a
    // later, staler heap entry for the same node is redundant work — without
    // this check, a densely-connected local visibility graph (many nearby
    // candidate nodes near a complex coastline) could re-run the full O(N)
    // relaxation loop for the same node many times over, compounding what
    // should be an O(N) expansion count into something far larger.
    if (closed[curr]) continue;
    closed[curr] = 1;

    const a = nodes[curr];
    for (let j = 0; j < N; j++) {
      if (j === curr || closed[j]) continue;
      const b = nodes[j];
      if (segBlocked(a.lon, a.lat, b.lon, b.lat)) continue;
      const ng = gScore[curr] + Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
      if (ng < gScore[j]) {
        gScore[j] = ng;
        prev[j]   = curr;
        const h   = Query.distanceNm(b.lon, b.lat, end.lon, end.lat);
        hpush(ng + h, j);
        if (j === 1) pathImproved = true;
      }
    }

    // Channel-graph edges (real charted fairway/recommended-track data) are
    // relaxed WITHOUT segBlocked — land and channel geometry are independently
    // digitized ENC layers with no guaranteed topological consistency, so a
    // real, safe channel edge can spuriously fail a segBlocked check against a
    // nearby simplified land edge at simplification tolerance. Neutral
    // distance cost (not discounted): these edges win only when they're a
    // genuinely feasible route the normal check would have falsely blocked,
    // never to out-compete a real shorter, verified-clear line.
    if (channelNodeIdxSet.has(curr) && Query.channelNeighbors) {
      for (const nb of Query.channelNeighbors(a.lon, a.lat)) {
        const j = channelKeyToIdx.get(nb.key);
        if (j === undefined || closed[j]) continue;
        const ng = gScore[curr] + Query.distanceNm(a.lon, a.lat, nb.lon, nb.lat);
        if (ng < gScore[j]) {
          gScore[j] = ng;
          prev[j]   = curr;
          const h   = Query.distanceNm(nb.lon, nb.lat, end.lon, end.lat);
          hpush(ng + h, j);
          if (j === 1) pathImproved = true;
        }
      }
    }

    if (++expansions % 20 === 0) {
      // Move a visible dot to show A* is alive and where it's searching
      if (!searchDot) {
        searchDot = L.circleMarker([a.lat, a.lon], {
          radius: 5, color: '#f5a623', fillColor: '#ffffff',
          fillOpacity: 0.9, weight: 2, opacity: 0.9,
        }).addTo(_map);
      } else {
        searchDot.setLatLng([a.lat, a.lon]);
      }
      // Redraw the live preview line at this same throttled cadence, not on
      // every single gScore improvement — onUpdate (setLatLngs on a Leaflet
      // polyline) is a real DOM/canvas redraw, and the end node's path can
      // improve dozens of times over a multi-hundred-expansion search on a
      // tightly-connected local graph. Calling it unthrottled was a real,
      // confirmed source of wall-clock overhead on real hardware: a route
      // that computes in ~600ms with this overhead removed (verified via a
      // synchronous port with no UI side effects) was hitting the 5-second
      // deadline in the live app on an ordinary desktop browser.
      if (pathImproved) { onUpdate(tracePath(1)); pathImproved = false; }
      if (onText) onText(`Routing… ${expansions} / ${N} nodes`);
      await delay(0);
      if (Date.now() - _profT0 > DEADLINE_MS) {
        console.warn('[autoRoute] deadline exceeded after', expansions, 'expansions');
        break;
      }
    }
  }

  if (searchDot) { searchDot.remove(); searchDot = null; }
  console.log(`[autoRoute] A* done — ${expansions} expansions, ${N} nodes, ${Date.now() - _profT0}ms total`);

  if (gScore[1] === INF) {
    // Convex-vertex selection (see _addRingNodes above) already includes
    // every blocking ring's real bend points in this one pass — no retry, no
    // hand-picked via-waypoint fallback. If A* still can't connect start to
    // end within DEADLINE_MS, it's a genuinely unroutable case (or one that
    // needs a manual waypoint) — return the honest straight-line fallback,
    // never a partial/unverified path.
    console.warn('[autoRoute] no path found — returning straight line');
    return [start, end];
  }

  return tracePath(1);
}

// ── Long-range passage decomposition (Piece 1d) ─────────────────────────────
// The convex-vertex algorithm above is built for local/medium passages —
// verified fast and correct up to ~22nm. A real long coastal passage (e.g.
// Portsmouth NH -> Bar Harbor ME, ~136nm) isn't just slower, it's a different
// problem: tested directly (raising DEADLINE_MS to 30-60s, changing nothing
// else) and confirmed the search isn't slow, it's STUCK — every
// COASTAL_STANDOFF_LADDER offset point sits only 0.15-0.5nm off its own
// headland, with no line of sight past the next cape over, so the
// visibility graph is provably disconnected between start and end
// regardless of how long A* is allowed to run (a live probe against real
// chart data: A* exhausted its entire open set in 4 expansions, ~1s). More
// time doesn't fix a disconnected graph. The fix, per the user's own
// mariner's-eye framing: depart the coast, cross open water on a direct
// line (verified clear, not searched), arrive at the destination coast —
// see the plan file for the full empirical writeup.
const LONG_RANGE_NM = 20;          // starting point, not calibrated — see plan's "Threshold" section
const LONG_RANGE_DEADLINE_MS = 15000; // separate internal budget, independent of DEADLINE_MS above
const LONG_RANGE_BUFFER_NM = 8;    // buffer on each side of a patched obstacle
const LONG_RANGE_MAX_HOPS = 6;     // bounded — more disjoint transit obstacles than this falls back honestly

// True if a straight line between two points needs no further checking at
// all — off land at both ends, and the segment itself doesn't cross land.
// Deliberately does NOT check hazards/tidal zones (see the plan's "Why not
// a universal fast-path" section) — that's covered separately, after the
// route is saved, by the existing _checkRouteHazards/_liveHazardCheck
// safety net (same mechanism already used for hand-drawn sketch routes).
function _isClearOffshoreLine(a, b) {
  return !Query.isLandAt(a.lon, a.lat) && !Query.isLandAt(b.lon, b.lat) &&
         !Query.landBlocks(a.lon, a.lat, b.lon, b.lat);
}

// Departure-point -> arrival-point transit leg: a straight line if already
// clear, otherwise patches just the blocked stretch(es) with the existing
// local algorithm (bracketed and clamped so each recursive call stays
// under LONG_RANGE_NM), walking forward one obstacle at a time rather than
// re-solving the whole span. Returns null on internal deadline exceeded or
// too many disjoint obstacles (LONG_RANGE_MAX_HOPS) — signals the caller to
// fall back to the honest full straight line.
async function _transitLeg(a, b, lrT0, onUpdate, onText) {
  if (_isClearOffshoreLine(a, b)) return [a, b];

  const result = [a];
  let cursor = a;
  for (let hop = 0; hop < LONG_RANGE_MAX_HOPS; hop++) {
    if (Date.now() - lrT0 > LONG_RANGE_DEADLINE_MS) return null;
    if (!Query.landBlocks(cursor.lon, cursor.lat, b.lon, b.lat)) {
      result.push(b);
      return result;
    }

    // Coarse march from cursor to b to find where the blockage starts/ends.
    const totalNm = Query.distanceNm(cursor.lon, cursor.lat, b.lon, b.lat);
    const STEP_NM = 1.0;
    const steps = Math.max(2, Math.ceil(totalNm / STEP_NM));
    let firstBlockedT = null, lastBlockedT = null;
    let prevPt = cursor;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const pt = { lat: cursor.lat + (b.lat - cursor.lat) * t, lon: cursor.lon + (b.lon - cursor.lon) * t };
      if (Query.landBlocks(prevPt.lon, prevPt.lat, pt.lon, pt.lat)) {
        if (firstBlockedT === null) firstBlockedT = (i - 1) / steps;
        lastBlockedT = t;
      }
      prevPt = pt;
    }
    if (firstBlockedT === null) { firstBlockedT = 0; lastBlockedT = 1; } // safety net, shouldn't happen

    // Bracket the blocked stretch with a buffer, clamped so the bracket's
    // own span stays under LONG_RANGE_NM — guarantees the recursive
    // _autoRouteProg call below takes the plain/existing branch, never
    // re-enters this one (an unclamped buffer was a real bug caught during
    // planning: a long blocked stretch + generous buffers on each side
    // could itself exceed the long-range threshold).
    const bufferT = Math.min(LONG_RANGE_BUFFER_NM / totalNm, 0.4);
    const startT = Math.max(0, firstBlockedT - bufferT);
    let endT = Math.min(1, lastBlockedT + bufferT);
    const spanNm = (endT - startT) * totalNm;
    if (spanNm > LONG_RANGE_NM - 1) endT = startT + (LONG_RANGE_NM - 1) / totalNm;

    const bracketStart = startT <= 0 ? cursor
      : { lat: cursor.lat + (b.lat - cursor.lat) * startT, lon: cursor.lon + (b.lon - cursor.lon) * startT };
    const bracketEnd = { lat: cursor.lat + (b.lat - cursor.lat) * endT, lon: cursor.lon + (b.lon - cursor.lon) * endT };

    if (startT > 0) result.push(bracketStart);
    const patched = await _autoRouteProg(bracketStart, bracketEnd, onUpdate, onText);
    if (patched.length <= 2 && Query.landBlocks(patched[0].lon, patched[0].lat, patched[1].lon, patched[1].lat)) {
      return null; // local avoidance also failed for this obstacle — honest fallback, don't splice in a land crossing
    }
    for (const p of patched.slice(1)) result.push(p);

    cursor = bracketEnd;
    if (endT >= 1) return result;
  }
  return null; // too many disjoint obstacles along this transit
}

// Depart the coast near start, cross open water on a direct (verified, not
// searched) line, arrive at the coast near end — see the block comment
// above LONG_RANGE_NM. Only called for routes beyond that threshold;
// _autoRouteProg's existing algorithm is unchanged for everything else.
// True if a sub-leg's own result is itself a failed fallback — collapsed to
// a straight 2-point line that still crosses land. `_transitLeg`'s bracket
// patches already guard against splicing this in; the depart/arrive legs
// need the identical check (a real gap found live: a Portsmouth -> Port
// Clyde test case produced a `fallback: false` overall result that still
// crossed land, because the arrive leg silently fell back and got spliced
// in unchecked).
function _legFailed(leg) {
  return leg.length <= 2 && Query.landBlocks(leg[0].lon, leg[0].lat, leg[1].lon, leg[1].lat);
}

async function _longRangeRoute(start, end, onUpdate, onText) {
  const _lrT0 = Date.now();
  if (onText) onText('Planning long passage…');

  if (_isClearOffshoreLine(start, end)) return [start, end];
  if (Date.now() - _lrT0 > LONG_RANGE_DEADLINE_MS) return [start, end];

  const departurePt = Query.findClearOffshorePoint(start.lon, start.lat, end.lon, end.lat);
  const arrivalPt = Query.findClearOffshorePoint(end.lon, end.lat, start.lon, start.lat);
  if (!departurePt || !arrivalPt) return [start, end];
  if (Date.now() - _lrT0 > LONG_RANGE_DEADLINE_MS) return [start, end];

  const departLeg = await _autoRouteProg(start, departurePt, onUpdate, onText);
  if (_legFailed(departLeg)) return [start, end];
  if (Date.now() - _lrT0 > LONG_RANGE_DEADLINE_MS) return [start, end];

  const transit = await _transitLeg(departurePt, arrivalPt, _lrT0, onUpdate, onText);
  if (!transit) return [start, end];

  const arriveLeg = await _autoRouteProg(arrivalPt, end, onUpdate, onText);
  if (_legFailed(arriveLeg)) return [start, end];
  if (Date.now() - _lrT0 > LONG_RANGE_DEADLINE_MS) return [start, end];

  console.log(`[autoRoute] long-range passage done in ${Date.now() - _lrT0}ms — depart ${departLeg.length}pts, transit ${transit.length}pts, arrive ${arriveLeg.length}pts`);

  const result = [...departLeg];
  for (const p of transit.slice(1)) result.push(p);
  for (const p of arriveLeg.slice(1)) result.push(p);
  return result;
}

// Auto Route / Draw Route / Re-route all invoke the pathfinder, which is
// only meaningfully safe where real hazard/navaid data exists (see
// Query.coverageLevelAt) — outside that, refuse rather than silently
// produce a "safe" route that was never actually checked against real
// charts. Sketch mode is unaffected since the user places every point
// themselves. Checks both endpoints of a leg — a corridor that merely
// passes through reduced coverage between two in-coverage endpoints isn't
// caught here, but a start/end point outside 'core' is the common real
// case (the user's own current area) and the cheap check to make.
async function _blockedByCoverage(start, end, actionLabel) {
  // Land data can take a couple seconds to (re)load after a cache miss or a
  // version-invalidated refresh (see the v408 IndexedDB staleness fix) — a
  // real bug found live: clicking Draw/Auto Route/Re-route in that window
  // read coverageLevelAt() against a still-empty landPolygons and reported
  // "no chart data here" even sitting in the middle of fully-charted water.
  // Only land has an awaitable readiness promise; hazards/places/navaids
  // loading is unavoidably best-effort here, same as before this fix.
  await Query.whenLandLoaded();
  const startLevel = Query.coverageLevelAt(start.lon, start.lat);
  const endLevel = Query.coverageLevelAt(end.lon, end.lat);
  if (startLevel === 'core' && endLevel === 'core') return false;
  const worst = (startLevel === 'none' || endLevel === 'none') ? 'none' : 'land';
  const msg = worst === 'none'
    ? `${actionLabel} needs real chart data, which isn't available here. Try Sketch instead.`
    : `${actionLabel} needs hazard and navaid data, which isn't available here — only land avoidance. Try Sketch instead.`;
  setStatus(msg);
  TTS.sayImmediate(msg);
  return true;
}

function _showRerouteOverlay(pts) {
  const previewLine = L.polyline(
    pts.map(p => [p.lat, p.lon]),
    { color: '#f5a623', weight: 3, dashArray: '8 6', opacity: 0.75 }
  ).addTo(_map);
  const overlay = document.createElement('div');
  overlay.className = 'optimizing-overlay';
  overlay.innerHTML = '<span class="optimizing-boat">&#9975;</span>' +
                      '<em class="optimizing-text">Re-routing&#8230;</em>';
  _map.getContainer().appendChild(overlay);
  return {
    update(newPts) { previewLine.setLatLngs(newPts.map(p => [p.lat, p.lon])); },
    setText(t) { const el = overlay.querySelector('.optimizing-text'); if (el) el.textContent = t; },
    remove() { previewLine.remove(); overlay.remove(); },
  };
}

// A fallback straight line's own gScore[1]===INF tells us the search never
// connected start to end — it does NOT tell us WHY (land in the way vs. a
// charted point-hazard vs. both), and _showRouteFallbackWarning used to
// always say "land" regardless. Real bug found live (2026-08-23): a route
// through Fox Islands Thorofare's rock-strewn approach to Merchant Row fell
// back on a leg that runs directly over a charted underwater rock — open
// water the whole way, no land anywhere nearby — so a user reading "couldn't
// avoid land" has every reason to dismiss the warning as not applying here.
// Classify what a fallback segment actually crosses so the message matches
// what's really blocking it.
const _FALLBACK_HAZARD_LABELS = new Set(['underwater rock', 'obstruction', 'wreck', 'UWTROC', 'OBSTRN', 'WRECKS']);
const _FALLBACK_HAZARD_CORRIDOR_NM = 0.05; // matches HAZARD_SAFETY_NM in _autoRouteProg
function _classifyFallbackSeg(a, b) {
  const crossesLand = Query.landBlocks(a.lon, a.lat, b.lon, b.lat);
  const segLenNm = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
  let crossesHazard = false;
  for (const f of (Query.hazards?.features || [])) {
    if (f.geometry?.type !== 'Point') continue;
    const label = f.properties?.label || f.properties?.objtype || '';
    if (!_FALLBACK_HAZARD_LABELS.has(label)) continue;
    const [pLon, pLat] = f.geometry.coordinates;
    const ct = _segCrossTrack(a.lon, a.lat, b.lon, b.lat, pLon, pLat);
    if (!ct) continue;
    if (Math.abs(ct.crossTrack) <= _FALLBACK_HAZARD_CORRIDOR_NM && ct.alongTrack >= 0 && ct.alongTrack <= segLenNm) {
      crossesHazard = true;
      break;
    }
  }
  return { crossesLand, crossesHazard };
}

async function _reRouteSegments(pts, onProgress, onText) {
  if (await _blockedByCoverage(pts[0], pts[pts.length - 1], 'Re-route')) {
    return { points: pts, fallbacks: 0, fallbackSegs: [], blocked: true };
  }
  const result = [pts[0]];
  let fallbacks = 0;
  const fallbackSegs = [];  // {a,b,crossesLand,crossesHazard} of each leg that
                             // couldn't be routed and fell back to a straight
                             // line — lets the caller point the user at
                             // exactly where to add a waypoint, and say what
                             // it's actually crossing (see _classifyFallbackSeg)
  // Each leg has its own DEADLINE_MS (5s) budget inside _autoRouteProg, but a
  // many-leg re-route had no OVERALL cap — a dozen legs could legitimately
  // run a minute-plus with no way for the caller to know. Cap the running
  // total; once crossed, remaining legs go straight to the honest
  // straight-line fallback instead of spending their own budget too.
  const legCount = pts.length - 1;
  const overallDeadlineMs = Math.min(5000 * legCount, 20000);
  const _reRouteT0 = Date.now();
  for (let i = 0; i < pts.length - 1; i++) {
    const segLabel = pts.length > 2 ? `Seg ${i + 1}/${pts.length - 1}: ` : '';
    let sub;
    if (Date.now() - _reRouteT0 > overallDeadlineMs) {
      console.warn('[reRouteSegments] overall deadline exceeded — remaining legs left as straight lines');
      sub = [pts[i], pts[i + 1]];
    } else {
      sub = await _autoRouteProg(pts[i], pts[i + 1],
        (path) => { if (onProgress) onProgress([...result, ...path.slice(1)]); },
        (t)    => { if (onText) onText(segLabel + t); }
      );
    }
    if (sub.length <= 2) {
      fallbacks++;
      fallbackSegs.push({ a: pts[i], b: pts[i + 1], ..._classifyFallbackSeg(pts[i], pts[i + 1]) });
    }
    result.push(...sub.slice(1));
    if (onProgress) onProgress([...result]);
  }
  return { points: result, fallbacks, fallbackSegs };
}

// Auto-route couldn't get a segment around an obstacle and silently fell
// back to a straight line — easy to miss as a status-bar message alone, and
// an unverified "route" is a safety issue, not a cosmetic one. Mark every
// failed leg's midpoint on the map and pop up an explicit instruction
// (matches the existing _checkRouteHazards popup pattern) rather than
// relying on the user to notice the geometry looks wrong.
//
// Every message here used to hard-code "land" regardless of what actually
// blocked the leg. Real bug found live (2026-08-23): a route through Fox
// Islands Thorofare's rock-strewn approach fell back on a leg running
// directly over a charted underwater rock — open water, no land in sight —
// so "Couldn't avoid land" read as simply wrong and easy to dismiss. Each
// segment is now labeled by what _classifyFallbackSeg actually found.
function _fallbackReasonLabel(seg) {
  if (seg.crossesLand && seg.crossesHazard) return 'land and a charted hazard';
  if (seg.crossesHazard) return 'a charted hazard (rock/obstruction/wreck)';
  return 'land'; // crossesLand, or neither flag matched (still an unverified straight line)
}

let _routeFallbackLayer = null;
function _showRouteFallbackWarning(fallbackSegs) {
  if (_routeFallbackLayer) { _routeFallbackLayer.clearLayers(); _routeFallbackLayer = null; }
  if (!fallbackSegs || !fallbackSegs.length) return;
  _routeFallbackLayer = L.layerGroup().addTo(_map);

  const mids = fallbackSegs.map(seg => ({
    lat: (seg.a.lat + seg.b.lat) / 2,
    lon: (seg.a.lon + seg.b.lon) / 2,
  }));
  mids.forEach((m, i) => {
    const reason = _fallbackReasonLabel(fallbackSegs[i]);
    L.marker([m.lat, m.lon], {
      icon: L.divIcon({
        className: '',
        html: '<div class="davy-jones-icon">&#9888;</div>',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      }),
      zIndexOffset: 900,
    }).bindTooltip(`Couldn't avoid ${reason} here — add a waypoint (leg ${i + 1})`,
                    { permanent: false, direction: 'top', offset: [0, -6] })
      .on('click', (e) => { L.DomEvent.stopPropagation(e); _map.setView([m.lat, m.lon], 16); })
      .addTo(_routeFallbackLayer);
  });

  const n = fallbackSegs.length;
  const anyHazard = fallbackSegs.some(s => s.crossesHazard);
  const anyLand   = fallbackSegs.some(s => s.crossesLand || !s.crossesHazard);
  const reasonSummary = anyHazard && anyLand ? 'land or a charted hazard'
    : anyHazard ? 'a charted hazard (rock/obstruction/wreck)'
    : 'land';
  const first = mids[0];
  const body = `<b>Couldn't avoid ${reasonSummary}</b> — ${n} leg${n > 1 ? 's' : ''} still cross${n > 1 ? '' : 'es'} it as a straight line.<br>`
    + `Add a waypoint in the passage${n > 1 ? ' (⚠ marks each spot)' : ''}, then re-route.`;
  L.popup({ maxWidth: 300, autoPan: true })
    .setLatLng([first.lat, first.lon])
    .setContent(`<div style="font-size:13px;line-height:1.5">${body}</div>`)
    .openOn(_map);

  const speakMsg = `Warning: ${n} route leg${n > 1 ? 's' : ''} couldn't avoid ${reasonSummary}. Add a waypoint and re-route.`;
  setStatus(speakMsg);
  TTS.sayImmediate(speakMsg);
}

function _finishSketch() {
  const pts         = _sketchWaypoints.slice();
  const extIdx      = _extendingRouteIdx;  // capture before _exitSketchMode resets them
  const extFromEnd  = _extendingFromEnd;
  const growIdx     = _growRouteIdx;
  _exitSketchMode(); // resets _extendingRouteIdx/-FromEnd/_growRouteIdx and calls _refreshSavedRouteLayers

  if (growIdx >= 0 && pts.length > 1) {
    // Add Nodes mode: append straight-line new nodes (skip anchor pts[0])
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    if (routes[growIdx]) {
      const newPts = pts.slice(1).map(p => ({ lat: p.lat, lon: p.lng }));
      routes[growIdx].points = [...routes[growIdx].points, ...newPts];
      _touch(routes[growIdx]);
      localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
      _populateRouteSelectFn?.();
      const found = _enterEditMode(growIdx);
      if (!found.length) setStatus(`Route extended — ${newPts.length} node(s) added.`);
    }
    return;
  }
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
        _touch(route);
        localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
        // Sketch points are placed entirely by hand — never auto-routed —
        // so this is exactly the case that needs an explicit check: nothing
        // else in the app has verified these points yet.
        const found = _checkRouteHazards(extIdx, true);
        if (!found.length) {
          const msg = `${route.name} updated — ${totalNm.toFixed(1)} nm`;
          setStatus(msg);
          TTS.sayImmediate(msg);
        }
      }
    } else {
      const name = _nextRouteName();
      _saveRoute(name, pts);
      const newIdx = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]').length - 1;
      const found = _checkRouteHazards(newIdx, true);
      if (!found.length) {
        const msg = `${name} saved — ${totalNm.toFixed(1)} nm`;
        setStatus(msg);
        TTS.sayImmediate(msg);
      }
    }
    _refreshSavedRouteLayers();
    _populateRouteSelectFn?.();
  }
}

async function _finishSketchAutoRoute() {
  if (_sketchWaypoints.length < 2) { _exitSketchMode(); return; }
  const rawPts     = _sketchWaypoints.slice();
  const extIdx     = _extendingRouteIdx;
  const extFromEnd = _extendingFromEnd;
  const growIdx    = _growRouteIdx;

  _exitSketchMode();  // resets _growRouteIdx / extendingRouteIdx

  if (growIdx >= 0) {
    // "Add Nodes" grow mode: rawPts[0] is the anchor (existing route's last point);
    // route only from anchor through the new waypoints, then append (skip anchor).
    const routePts = rawPts.map(p => ({ lat: p.lat, lon: p.lng }));
    const ui = _showRerouteOverlay(routePts);
    try {
      const { points, fallbacks, fallbackSegs, blocked } = await _reRouteSegments(
        routePts, ui.update.bind(ui), ui.setText.bind(ui)
      );
      ui.remove();
      if (blocked) return;  // _reRouteSegments already announced why
      const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
      if (routes[growIdx]) {
        routes[growIdx].points = [...routes[growIdx].points, ...points.slice(1)];
        _touch(routes[growIdx]);
        localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
        _populateRouteSelectFn?.();
        const found = _enterEditMode(growIdx);
        if (!found.length) {
          if (fallbacks > 0) _showRouteFallbackWarning(fallbackSegs);
          else setStatus('Route extended.');
        }
      }
    } catch (err) {
      ui.remove();
      setStatus('Auto-route failed.');
      console.error('[sketchAutoRoute grow]', err);
    }
    return;
  }

  // Waypoints are in placement order; extend-from-start reverses them so the
  // active "tip" is always at the end — reverse back for geographical order.
  const ordered  = extFromEnd ? rawPts : rawPts.slice().reverse();
  const routePts = ordered.map(p => ({ lat: p.lat, lon: p.lng }));

  const ui = _showRerouteOverlay(routePts);
  try {
    const { points, fallbacks, fallbackSegs, blocked } = await _reRouteSegments(
      routePts, ui.update.bind(ui), ui.setText.bind(ui)
    );
    ui.remove();
    if (blocked) return;  // _reRouteSegments already announced why

    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    let found;
    if (extIdx >= 0 && routes[extIdx]) {
      routes[extIdx].points = points;
      _touch(routes[extIdx]);
      localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
      _populateRouteSelectFn?.();
      found = _enterEditMode(extIdx);
    } else {
      const name = _nextRouteName();
      routes.push(_stampNew({ name, points }));
      localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
      _populateRouteSelectFn?.();
      found = _enterEditMode(routes.length - 1);
    }
    if (!found.length) {
      if (fallbacks > 0) _showRouteFallbackWarning(fallbackSegs);
      else setStatus('Route saved.');
    }
  } catch (err) {
    ui.remove();
    setStatus('Auto-route failed.');
    console.error('[sketchAutoRoute]', err);
  }
}

document.getElementById('sketch-done-btn').addEventListener('click', _finishSketch);
document.getElementById('sketch-route-btn').addEventListener('click', _finishSketchAutoRoute);
document.getElementById('sketch-cancel-btn').addEventListener('click', _exitSketchMode);

// ── Route edit mode ────────────────────────────────────────────────────────────

function _editVertexIcon() {
  return L.divIcon({
    className: 'edit-vertex-marker',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function _pushEditHistory() {
  _editHistory.push(_editPoints.map(_stripPoint));
  document.getElementById('edit-undo-btn').style.display = '';
}

function _clearEditLayers() {
  _editVertexMarkers.forEach(m => _map.removeLayer(m));
  _editSegmentLayers.forEach(s => _map.removeLayer(s));
  _editVertexMarkers = [];
  _editSegmentLayers = [];
  _map.getContainer().querySelectorAll('.edit-vertex-marker').forEach(el => el.remove());
}

function _insertVertex(segIdx, latlng) {
  const a = _editPoints[segIdx], b = _editPoints[segIdx + 1];
  if (!a || !b) return;
  const segLen = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
  const ct = _segCrossTrack(a.lon, a.lat, b.lon, b.lat, latlng.lng, latlng.lat);
  const t = (ct && segLen > 0) ? Math.max(0, Math.min(1, ct.alongTrack / segLen)) : 0.5;
  const newLat = a.lat + (b.lat - a.lat) * t;
  const newLon = a.lon + (b.lon - a.lon) * t;
  _pushEditHistory();
  _editPoints.splice(segIdx + 1, 0, { lat: newLat, lon: newLon });
  _newVertexIdx = segIdx + 1;
  _selectedEditNodeIdx.clear();  // indices past segIdx just shifted
}

function _nearestSegIdx(pts, latlng) {
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const segLen = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
    const ct = _segCrossTrack(a.lon, a.lat, b.lon, b.lat, latlng.lng, latlng.lat);
    let dist;
    if (ct && ct.alongTrack >= 0 && ct.alongTrack <= segLen) {
      dist = Math.abs(ct.crossTrack);
    } else {
      dist = Math.min(
        Query.distanceNm(a.lon, a.lat, latlng.lng, latlng.lat),
        Query.distanceNm(b.lon, b.lat, latlng.lng, latlng.lat)
      );
    }
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  }
  return bestIdx;
}

function _liveHazardCheck() {
  const pts = _editPoints;
  if (!pts || pts.length < 2) return [];
  const CORRIDOR = 0.05;
  const SHALLOW_THRESHOLD = 2.0;
  const DANGER_LABELS = new Set(['underwater rock', 'obstruction', 'wreck', 'UWTROC', 'OBSTRN', 'WRECKS']);
  const feats = Query.hazards?.features || [];
  const found = [];
  const seen = new Set();
  let distSoFar = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const segLen = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
    const segMinLat = Math.min(a.lat, b.lat), segMaxLat = Math.max(a.lat, b.lat);
    const segMinLon = Math.min(a.lon, b.lon), segMaxLon = Math.max(a.lon, b.lon);
    const BUF = 0.001;
    for (const f of feats) {
      if (f.geometry.type !== 'Point') continue;
      const label = f.properties.label || f.properties.objtype || '';
      if (!DANGER_LABELS.has(label)) continue;
      const [pLon, pLat] = f.geometry.coordinates;
      const key = `${pLon.toFixed(5)},${pLat.toFixed(5)}`;
      if (seen.has(key)) continue;
      const ct = _segCrossTrack(a.lon, a.lat, b.lon, b.lat, pLon, pLat);
      if (!ct) continue;
      if (Math.abs(ct.crossTrack) <= CORRIDOR && ct.alongTrack >= 0 && ct.alongTrack <= segLen) {
        seen.add(key);
        found.push({ name: f.properties.name || label, routeNm: distSoFar + ct.alongTrack });
      }
    }
    for (const f of (Query.depthZones || [])) {
      const props = f.properties || {};
      const minDepth = parseFloat(props.depth_label);
      if (isNaN(minDepth) || minDepth >= SHALLOW_THRESHOLD) continue;
      // depthZones can be Polygon or MultiPolygon — see the matching fix in
      // _checkRouteHazards.
      const { type, coordinates } = f.geometry;
      const polys = type === 'Polygon' ? [coordinates] : coordinates;
      for (const rings of polys) {
        const ring = rings[0];
        const lons = ring.map(c => c[0]), lats = ring.map(c => c[1]);
        if (Math.max(...lons) < segMinLon - BUF || Math.min(...lons) > segMaxLon + BUF ||
            Math.max(...lats) < segMinLat - BUF || Math.min(...lats) > segMaxLat + BUF) continue;
        const key = `poly:${lons[0].toFixed(5)},${lats[0].toFixed(5)}`;
        if (seen.has(key)) continue;
        const hit = _segPolyIntersectPoint(a.lon, a.lat, b.lon, b.lat, ring);
        if (!hit) continue;
        seen.add(key);
        const lbl = minDepth < 0 ? 'above-water obstacle' : 'shallow area';
        found.push({ name: props.name || lbl, routeNm: distSoFar + hit.t * segLen });
      }
    }
    distSoFar += segLen;
  }
  if (found.length === 0) {
    showResponse('✓ Route clear');
  } else {
    const names = [...new Set(found.map(h => h.name))].slice(0, 3).join(', ');
    const msg = `Warning: ${found.length} hazard${found.length > 1 ? 's' : ''} on edited route — ${names}`;
    showResponse(msg);
    TTS.sayImmediate(msg);
  }
  return found;
}

function _checkEditSegment(segIdx, latlng) {
  const CORRIDOR = 0.05;
  const DANGER_LABELS = new Set(['underwater rock','obstruction','wreck','UWTROC','OBSTRN','WRECKS']);
  const a = _editPoints[segIdx], b = _editPoints[segIdx + 1];
  if (!a || !b) return;
  const segLen = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
  const feats  = Query.hazards?.features || [];
  const found  = [];
  for (const f of feats) {
    if (f.geometry.type !== 'Point') continue;
    const label = f.properties.label || f.properties.objtype || '';
    if (!DANGER_LABELS.has(label)) continue;
    const [pLon, pLat] = f.geometry.coordinates;
    const ct = _segCrossTrack(a.lon, a.lat, b.lon, b.lat, pLon, pLat);
    if (!ct) continue;
    const { crossTrack, alongTrack } = ct;
    if (Math.abs(crossTrack) <= CORRIDOR && alongTrack >= 0 && alongTrack <= segLen)
      found.push(f.properties.name || label);
  }
  const html = found.length === 0
    ? `<span style="color:#2a7a2a">&#10003; Clear</span>`
    : `<span style="color:#c0392b">&#9888; ${found.length} hazard${found.length > 1 ? 's' : ''}: `
      + found.slice(0, 3).join(', ')
      + (found.length > 3 ? ` +${found.length - 3} more` : '')
      + '</span>';
  L.popup({ closeButton: false, className: 'segment-hazard-popup' })
    .setLatLng(latlng)
    .setContent(`<div style="font-size:13px;padding:2px 4px">${html}</div>`)
    .openOn(_map);
}

function _renderEditLayers() {
  _clearEditLayers();
  const pts = _editPoints;

  // Segment polylines + bearing labels
  for (let i = 0; i < pts.length - 1; i++) {
    const ptA = [pts[i].lat, pts[i].lon];
    const ptB = [pts[i + 1].lat, pts[i + 1].lon];
    const seg = L.polyline([ptA, ptB], {
      color: '#f5c842', weight: 5, opacity: 0.9, interactive: !_addNodeMode,
    }).addTo(_map);
    _editSegmentLayers.push(seg);

    // Bearing labels omitted in edit mode — they clutter the map; visible in normal route display
  }

  // Pre-compute cumulative distances for tooltip display
  const _cumNm = [0];
  for (let i = 1; i < pts.length; i++) {
    _cumNm.push(_cumNm[i - 1] + Query.distanceNm(pts[i - 1].lon, pts[i - 1].lat, pts[i].lon, pts[i].lat));
  }

  // Vertex markers — drag to move, click to remove, coordinate label
  for (let i = 0; i < pts.length; i++) {
    const idx = i;
    const isNew = idx === _newVertexIdx;
    const tipContent = () =>
      `${formatPositionDisplay(pts[idx].lat, pts[idx].lon)}<br>${_cumNm[idx].toFixed(1)} nm from start`;
    const vertexClasses = ['edit-vertex-marker'];
    if (isNew) vertexClasses.push('edit-vertex-new');
    else if (_deleteMode) vertexClasses.push('edit-vertex-delete');
    if (pts[idx].overnight) vertexClasses.push('edit-vertex-overnight');
    if (_selectedEditNodeIdx.has(idx)) vertexClasses.push('edit-vertex-selected');
    const m = L.marker([pts[idx].lat, pts[idx].lon], {
      icon: L.divIcon({
        className: vertexClasses.join(' '),
        html: `<span class="edit-vertex-num">${idx + 1}</span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
      draggable: true,
      zIndexOffset: 1000,
    }).bindTooltip(tipContent(), {
      permanent: false, direction: 'top', offset: [0, -20], className: 'route-coord-tip edit-coord-tip',
    }).addTo(_map);
    m.on('dragstart', () => {
      _map.dragging.disable();
      _pushEditHistory();
      if (idx === _newVertexIdx) {
        _newVertexIdx = -1;
        // Remove the flash class directly — setIcon() during an active drag reinitialises
        // Leaflet's Draggable on the new element, breaking the drag event chain and
        // preventing _editPoints from being updated, which leaves a ghost on dragend.
        m.getElement()?.classList.remove('edit-vertex-new');
      }
      m.openTooltip();
    });
    m.on('drag', () => {
      const ll = m.getLatLng();
      _editPoints[idx] = _editPoints[idx].overnight
        ? { lat: ll.lat, lon: ll.lng, overnight: true }
        : { lat: ll.lat, lon: ll.lng };
      m.setTooltipContent(formatPositionDisplay(ll.lat, ll.lng));
      // Update adjacent segment polylines live (bearing labels rebuild on dragend)
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
    m.on('dragend', () => {
      requestAnimationFrame(() => {
        _renderEditLayers();
        _map.dragging.enable();
        clearTimeout(_liveHazardTimer);
        _liveHazardTimer = setTimeout(_liveHazardCheck, 300);
      });
    });
    m.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (_deleteMode && _editPoints.length > 2) {
        _pushEditHistory();
        _editPoints.splice(idx, 1);
        _selectedEditNodeIdx.clear();  // indices past idx just shifted — stale selection would point at the wrong node
        _renderEditLayers();
        // Removing a waypoint can just as easily introduce a hazard (it may
        // have been providing clearance) as fix one — recheck either way.
        clearTimeout(_liveHazardTimer);
        _liveHazardTimer = setTimeout(_liveHazardCheck, 300);
      } else if (_overnightMode) {
        _pushEditHistory();
        const p = _editPoints[idx];
        _editPoints[idx] = p.overnight ? { lat: p.lat, lon: p.lon } : { lat: p.lat, lon: p.lon, overnight: true };
        _renderEditLayers();
      } else if (_fixNodesMode) {
        _fixNodeHazards(idx);
      }
    });
    m.on('dblclick', (e) => {
      L.DomEvent.stopPropagation(e);
      if (_editPoints.length <= 2) return;
      _pushEditHistory();
      _editPoints.splice(idx, 1);
      _selectedEditNodeIdx.clear();  // indices past idx just shifted
      _renderEditLayers();
      clearTimeout(_liveHazardTimer);
      _liveHazardTimer = setTimeout(_liveHazardCheck, 300);
    });
    _editVertexMarkers.push(m);
  }
}

function _renderViewportHazards() {
  const DANGER_LABELS = new Set(['underwater rock','obstruction','wreck','UWTROC','OBSTRN','WRECKS']);
  if (_viewportHazardLayer) _viewportHazardLayer.clearLayers();
  else _viewportHazardLayer = L.layerGroup().addTo(_map);
  const bounds = _map.getBounds();
  const feats  = Query.hazards?.features || [];
  for (const f of feats) {
    if (f.geometry.type !== 'Point') continue;
    const label = f.properties.label || f.properties.objtype || '';
    if (!DANGER_LABELS.has(label)) continue;
    const [pLon, pLat] = f.geometry.coordinates;
    if (!bounds.contains([pLat, pLon])) continue;
    const name = f.properties.name ? `: ${f.properties.name}` : '';
    L.circleMarker([pLat, pLon], {
      radius: 5, color: '#fff', weight: 1.5,
      fillColor: '#e88a00', fillOpacity: 0.9,
      interactive: true,
    }).bindTooltip(label + name, { permanent: false, direction: 'top' })
      .addTo(_viewportHazardLayer);
  }
}

function _clearViewportHazards() {
  if (_viewportHazardMoveEnd) {
    _map.off('moveend', _viewportHazardMoveEnd);
    _viewportHazardMoveEnd = null;
  }
  if (_viewportHazardLayer) { _viewportHazardLayer.clearLayers(); _map.removeLayer(_viewportHazardLayer); _viewportHazardLayer = null; }
  const btn = document.getElementById('edit-hazards-btn');
  if (btn) { btn.textContent = 'Show hazards'; btn.classList.remove('active'); }
}

document.getElementById('edit-hazards-btn').addEventListener('click', () => {
  if (_viewportHazardLayer) {
    _clearViewportHazards();
  } else {
    _renderViewportHazards();
    _viewportHazardMoveEnd = () => _renderViewportHazards();
    _map.on('moveend', _viewportHazardMoveEnd);
    const btn = document.getElementById('edit-hazards-btn');
    btn.textContent = 'Hide hazards';
    btn.classList.add('active');
  }
});


function _cancelAddNodeMode() {
  _addNodeMode = false;
  if (_map) { _map.dragging.enable(); _map.getContainer().style.cursor = ''; }
  document.getElementById('edit-banner-label').textContent = _editRouteName;
  _updateEditToolsPanel();
}

function _updateEditToolsPanel() {
  document.getElementById('etp-insert-node')?.classList.toggle('active', _addNodeMode);
  document.getElementById('etp-delete')?.classList.toggle('active', _deleteMode);
  document.getElementById('etp-overnight')?.classList.toggle('active', _overnightMode);
  document.getElementById('etp-fix-nodes')?.classList.toggle('active', _fixNodesMode);
}

// Screen-space (not distance-space) match, so it's equally forgiving at any zoom level.
function _nearestEditVertexIdx(lat, lon, pxTolerance = 20) {
  if (!_editMode || !_editPoints.length || !_map) return -1;
  const clickPt = _map.latLngToContainerPoint([lat, lon]);
  let best = -1, bestD = Infinity;
  _editPoints.forEach((p, i) => {
    const d = clickPt.distanceTo(_map.latLngToContainerPoint([p.lat, p.lon]));
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD <= pxTolerance ? best : -1;
}

// Nearest named object (route-edit vertex, navaid, or saved waypoint) within pxTolerance
// screen pixels of lat/lon, or null. Used to snap the drag-to-place focus marker.
function _nearestSnapTarget(lat, lon, pxTolerance = 20) {
  if (!_map) return null;
  const pt = _map.latLngToContainerPoint([lat, lon]);
  let best = null, bestD = pxTolerance;

  const vIdx = _nearestEditVertexIdx(lat, lon, pxTolerance);
  if (vIdx >= 0) {
    const p = _editPoints[vIdx];
    const d = pt.distanceTo(_map.latLngToContainerPoint([p.lat, p.lon]));
    if (d < bestD) { bestD = d; best = { lat: p.lat, lon: p.lon, name: `${_editRouteName} WP${vIdx + 1}`, type: 'coord' }; }
  }

  for (const f of Query.navaids?.features || []) {
    const [flon, flat] = f.geometry.coordinates;
    const d = pt.distanceTo(_map.latLngToContainerPoint([flat, flon]));
    if (d < bestD) {
      const p = f.properties;
      const label = p.name || [p.label, p.characteristic || p.colour].filter(Boolean).join(' ');
      bestD = d; best = { lat: flat, lon: flon, name: label, type: 'place' };
    }
  }

  for (const w of loadUserWaypoints()) {
    const d = pt.distanceTo(_map.latLngToContainerPoint([w.lat, w.lon]));
    if (d < bestD) { bestD = d; best = { lat: w.lat, lon: w.lon, name: w.name, type: 'waypoint' }; }
  }

  return best;
}

// Drag-to-place focus marker: shows an idle-pulsing marker the user can drag, which snaps
// to and flashes near named objects, then confirms via the #focus-place-banner.
function _enterFocusPlaceMode(latlng) {
  if (_sketchMode || _drawMode) return;   // those modes hijack touch/click in capture phase
  if (_addNodeMode) _cancelAddNodeMode(); // avoid a stray _editPlaceNode mouseup inserting a route node
  _focusPlaceMode = true;
  _focusPlaceSnap = null;

  _focusPlaceMarker = L.marker(latlng, {
    icon: L.divIcon({ className: 'focus-place-marker focus-place-idle', iconSize: [18, 18], iconAnchor: [9, 9] }),
    draggable: true,
    zIndexOffset: 1200,
  }).addTo(_map);

  _focusPlaceMarker.on('drag', () => {
    const ll = _focusPlaceMarker.getLatLng();
    const snap = _nearestSnapTarget(ll.lat, ll.lng);
    _focusPlaceSnap = snap;
    const el = _focusPlaceMarker.getElement();
    if (snap) {
      _focusPlaceMarker.setLatLng([snap.lat, snap.lon]);
      el?.classList.replace('focus-place-idle', 'focus-place-locked');
      document.getElementById('focus-place-banner-label').textContent = `🎯 Snapped: ${snap.name}`;
    } else {
      el?.classList.replace('focus-place-locked', 'focus-place-idle');
      document.getElementById('focus-place-banner-label').textContent = 'Placing focus…';
    }
  });

  document.getElementById('focus-place-banner-label').textContent = 'Placing focus…';
  document.getElementById('focus-place-banner').style.display = 'flex';
}

function _confirmFocusPlace() {
  const ll   = _focusPlaceMarker.getLatLng();
  const snap = _focusPlaceSnap;
  const lat  = snap ? snap.lat : ll.lat;
  const lon  = snap ? snap.lon : ll.lng;
  const name = snap ? snap.name : null;
  const type = snap ? snap.type : 'coord';
  Query.setFocus(lat, lon, name, type);
  _updateFocusButton();
  const msg = `Focused on ${name || 'this point'}.`;
  showResponse(msg);
  TTS.sayImmediate(msg);
  _exitFocusPlaceMode();
}

function _cancelFocusPlace() { _exitFocusPlaceMode(); }

function _exitFocusPlaceMode() {
  _focusPlaceMode = false;
  document.getElementById('focus-place-banner').style.display = 'none';
  if (_focusPlaceMarker) { _map.removeLayer(_focusPlaceMarker); _focusPlaceMarker = null; }
  _focusPlaceSnap = null;
}

// Persistent, always-draggable marker for the current focus — lets the user nudge the
// focus point at any time, not just during initial placement. Snaps the same way
// _enterFocusPlaceMode's temporary marker does.
function _syncFocusMarker() {
  if (!_map) return;
  const f = Query.focusedTarget;
  if (!f) {
    if (_focusMarker) { _map.removeLayer(_focusMarker); _focusMarker = null; }
    return;
  }
  if (!_focusMarker) {
    _focusMarker = L.marker([f.lat, f.lon], {
      icon: L.divIcon({ className: 'focus-place-marker focus-place-locked', iconSize: [18, 18], iconAnchor: [9, 9] }),
      draggable: true,
      zIndexOffset: 1100,
    }).addTo(_map);
    _focusMarker.on('drag', () => {
      const ll = _focusMarker.getLatLng();
      const snap = _nearestSnapTarget(ll.lat, ll.lng);
      const el = _focusMarker.getElement();
      if (snap) {
        _focusMarker.setLatLng([snap.lat, snap.lon]);
        el?.classList.replace('focus-place-idle', 'focus-place-locked');
      } else {
        el?.classList.replace('focus-place-locked', 'focus-place-idle');
      }
      // Live-follow the ray to the dragged (not yet committed) target position.
      const pos = GPS.getPosition();
      if (pos && _focusRayLine) {
        const tll = _focusMarker.getLatLng();
        const brg  = Query.bearing(pos.lon, pos.lat, tll.lng, tll.lat);
        const dist = Query.distanceNm(pos.lon, pos.lat, tll.lng, tll.lat);
        const end  = _destinationPoint(pos.lat, pos.lon, brg, dist * 1.15);
        _focusRayLine.setLatLngs([[pos.lat, pos.lon], [end.lat, end.lon]]);
      }
    });
    _focusMarker.on('dragend', () => {
      const ll = _focusMarker.getLatLng();
      const snap = _nearestSnapTarget(ll.lat, ll.lng);
      const lat  = snap ? snap.lat : ll.lat;
      const lon  = snap ? snap.lon : ll.lng;
      const name = snap ? snap.name : null;
      const type = snap ? snap.type : 'coord';
      Query.setFocus(lat, lon, name, type);
      _updateFocusButton();
      const msg = `Focused on ${name || 'this point'}.`;
      showResponse(msg);
      TTS.sayImmediate(msg);
    });
  } else {
    _focusMarker.setLatLng([f.lat, f.lon]);
  }
  _focusMarker.bindTooltip(f.name || 'Focus', { permanent: false, direction: 'top', className: 'map-tooltip' });
  const el = _focusMarker.getElement();
  el?.classList.toggle('focus-place-locked', !!f.name);
  el?.classList.toggle('focus-place-idle', !f.name);
}

function _animateEditRoute() {
  if (_editRouteIdx < 0 || _editPoints.length < 2) return;
  const speed = parseFloat(localStorage.getItem('audiochart-last-speed')) || 5;
  const route = {
    name:   _editRouteName || 'Route',
    points: _editPoints.map(_stripPoint),
  };
  if (!document.querySelector('.track-compress.selected')) {
    document.querySelector('.track-compress[data-compress="500"]')?.classList.add('selected');
  }
  _startRouteAnimation(route, speed);
}

function _editPlaceNode(e) {
  if (!_editMode || !_addNodeMode) return;
  if (e.button !== undefined && e.button !== 0) return; // left click only
  const latlng = _map.mouseEventToLatLng(e);
  const segIdx = _nearestSegIdx(_editPoints, latlng);
  _cancelAddNodeMode();
  _insertVertex(segIdx, latlng);

  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  if (!routes[_editRouteIdx]) return;
  routes[_editRouteIdx].points = _editPoints.map(_stripPoint);
  _touch(routes[_editRouteIdx]);
  localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
  const savedIdx       = _editRouteIdx;
  const savedNewVtxIdx = _newVertexIdx;
  const savedHistory   = _editHistory.slice();
  _exitEditMode();
  _newVertexIdx = savedNewVtxIdx;
  _enterEditMode(savedIdx);
  _editHistory  = savedHistory;
  document.getElementById('edit-undo-btn').style.display = savedHistory.length > 0 ? '' : 'none';
}

function _enterEditMode(routeIdx, skipHazardCheck = false) {
  if (_sketchMode) _exitSketchMode();
  if (_hazardCheckLayer) { _hazardCheckLayer.clearLayers(); _hazardCheckLayer = null; }
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const route = routes[routeIdx];
  if (!route) return [];

  _editMode = true;
  _editRouteIdx = routeIdx;
  _editRouteName = route.name;
  _editPoints = route.points.map(_stripPoint);
  _editOriginalPoints = route.points.map(_stripPoint);
  _deleteMode = false;
  _addNodeMode = false;
  _overnightMode = false;
  _fixNodesMode = false;
  _editHistory = [];
  _selectedEditNodeIdx = new Set();

  document.getElementById('edit-banner-label').textContent = route.name;
  document.getElementById('edit-banner').style.display = 'flex';
  _appEl.classList.add('edit-mode');
  _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
  if (_map) {
    _map.invalidateSize();
    if (_savedRoutesLayer) _map.removeLayer(_savedRoutesLayer);
    _renderEditLayers();
    _map.getContainer().addEventListener('mouseup', _editPlaceNode);
  }
  document.getElementById('edit-tools-panel').style.display = 'flex';
  document.getElementById('delete-route-btn').style.display = 'flex';
  _updateEditToolsPanel();
  // Check whenever a route is opened for editing — not just on request —
  // so waypoints placed/moved in a prior session (or manually, outside any
  // auto-route flow) get surfaced instead of staying silently unverified.
  // Returned so callers with their own follow-up status/speech (e.g. "Route
  // planned — 12.3nm") can skip it when a hazard warning already fired —
  // TTS.sayImmediate interrupts, so speaking both back-to-back would cut
  // off the more important hazard warning.
  //
  // skipHazardCheck exists for exactly one caller: the hazard popup's own
  // "Edit manually" button. Without it, choosing that button immediately
  // re-triggers the SAME popup (nothing was fixed, just entering edit mode
  // doesn't clear a hazard) — confirmed live, this is genuinely
  // indistinguishable from the button doing nothing at all, since the new
  // popup looks identical to the one just dismissed.
  if (skipHazardCheck) return [];
  return _checkRouteHazards(routeIdx, true);
}

function _exitEditMode() {
  const _justEditedName = _editRouteName;
  _editMode = false;
  _editRouteName = null;
  _editRouteIdx = -1;
  _editPoints = [];
  _newVertexIdx = -1;
  _deleteMode = false;
  _addNodeMode = false;
  _overnightMode = false;
  _fixNodesMode = false;
  _editHistory = [];
  _selectedEditNodeIdx = new Set();
  document.getElementById('edit-undo-btn').style.display = 'none';
  _clearViewportHazards();
  // _checkRouteHazards's red-segment/skull-marker overlay (_hazardCheckLayer)
  // was previously only ever cleared at the START of the next check — fine
  // when the check had no live caller, but now that it auto-fires on every
  // edit-mode entry, leaving it uncleared on exit meant a skull marker (high
  // z-index, clickable) could sit on the map indefinitely after Cancel/Save,
  // both looking permanently stuck AND blocking clicks on the route
  // underneath it to re-enter edit mode.
  if (_hazardCheckLayer) { _hazardCheckLayer.clearLayers(); _map.removeLayer(_hazardCheckLayer); _hazardCheckLayer = null; }
  if (_map) {
    _map.getContainer().removeEventListener('mouseup', _editPlaceNode);
    _map.dragging.enable();
    _map.getContainer().style.cursor = '';
    _clearEditLayers();
    _map.closePopup();
    _map.invalidateSize();
  }
  document.getElementById('edit-banner').style.display = 'none';
  document.getElementById('edit-tools-panel').style.display = 'none';
  document.getElementById('delete-route-btn').style.display = 'none';
  _appEl.classList.remove('edit-mode');
  if (_justEditedName) {
    _hiddenRouteNames.delete(_justEditedName);
    _saveHiddenRoutes();
  }
  _refreshSavedRouteLayers();
}

function _saveEditedRoute() {
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  if (!routes[_editRouteIdx]) { _exitEditMode(); return; }
  routes[_editRouteIdx].points = _editPoints.map(_stripPoint);
  _touch(routes[_editRouteIdx]);
  localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
  const name = _editRouteName || 'Route';
  const savedIdx = _editRouteIdx;
  _exitEditMode(); // calls _refreshSavedRouteLayers, resets _editRouteIdx
  _populateRouteSelectFn?.();
  // Always re-check on save, not just if this route happened to be checked
  // already this session — a hazard warning takes priority over the plain
  // "saved" confirmation when there's something to flag.
  const found = _checkRouteHazards(savedIdx, true);
  if (!found.length) {
    const msg = `${name} saved.`;
    setStatus(msg);
    TTS.sayImmediate(msg);
  }
}

function _revertEditedRoute() {
  if (!_editOriginalPoints.length) return;
  _pushEditHistory();
  _editPoints = _editOriginalPoints.map(_stripPoint);
  _selectedEditNodeIdx.clear();
  _renderEditLayers();
  // Also re-write storage immediately — undoes any mid-session "add node"
  // write (_editPlaceNode), which is the actual way an edit can survive
  // Cancel and count as an inadvertent change.
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  if (routes[_editRouteIdx]) {
    routes[_editRouteIdx].points = _editPoints.map(_stripPoint);
    localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
  }
  clearTimeout(_liveHazardTimer);
  _liveHazardTimer = setTimeout(_liveHazardCheck, 300);
  const msg = `${_editRouteName || 'Route'} reverted to last saved.`;
  setStatus(msg);
  TTS.sayImmediate(msg);
}

document.getElementById('edit-ok-btn').addEventListener('click', _saveEditedRoute);
document.getElementById('edit-cancel-btn').addEventListener('click', _exitEditMode);
document.getElementById('edit-revert-btn').addEventListener('click', _revertEditedRoute);
document.getElementById('edit-info-btn').addEventListener('click', () => {
  let totalNm = 0;
  for (let i = 0; i < _editPoints.length - 1; i++) {
    totalNm += Query.distanceNm(
      _editPoints[i].lon, _editPoints[i].lat,
      _editPoints[i + 1].lon, _editPoints[i + 1].lat
    );
  }
  const nm   = totalNm.toFixed(1);
  const mi   = (totalNm * 1.15078).toFixed(1);
  const wpts = _editPoints.length;
  TTS.sayImmediate(`${_editRouteName}. ${nm} nautical miles, ${mi} statute miles, ${wpts} waypoints.`);
  document.getElementById('edit-banner-label').textContent =
    `${_editRouteName} — ${nm} nm / ${mi} mi · ${wpts} waypoints`;
});

// Shared by the edit-route toolbar and the Routes/Tracks panel row corner
// buttons — produces a precise, directly-pasteable coordinate list (decimal
// degrees, not a DM/DMS display string) for accurate bug reports/testing.
const _wptCopyOverlay = document.getElementById('wpt-copy-overlay');
const _wptCopyText    = document.getElementById('wpt-copy-text');
const _wptCopyBtn     = document.getElementById('wpt-copy-btn');
function _showCopyWaypointsOverlay(name, points) {
  document.getElementById('wpt-copy-title').textContent = `${name} — ${points.length} waypoints`;
  const json = JSON.stringify(
    points.map(p => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })),
    null, 2
  );
  _wptCopyText.value = json;
  _wptCopyOverlay.classList.add('open');
  _wptCopyText.focus();
  _wptCopyText.select();
  navigator.clipboard?.writeText(json).catch(() => {}); // best-effort; textarea is the reliable fallback
}
document.getElementById('edit-copy-wpts-btn').addEventListener('click', () => {
  _showCopyWaypointsOverlay(_editRouteName, _editPoints);
});
document.getElementById('wpt-copy-close').addEventListener('click', () => {
  _wptCopyOverlay.classList.remove('open');
});
_wptCopyBtn.addEventListener('click', () => {
  _wptCopyText.select();
  navigator.clipboard?.writeText(_wptCopyText.value).then(() => {
    _wptCopyBtn.textContent = '✓ Copied';
    _wptCopyBtn.classList.add('copied');
    setTimeout(() => { _wptCopyBtn.textContent = '📋 Copy'; _wptCopyBtn.classList.remove('copied'); }, 1200);
  }).catch(() => {});
});
document.getElementById('edit-undo-btn').addEventListener('click', () => {
  if (_editHistory.length === 0) return;
  _editPoints = _editHistory.pop();
  _newVertexIdx = -1;
  _selectedEditNodeIdx.clear();
  _renderEditLayers();
  document.getElementById('edit-undo-btn').style.display =
    _editHistory.length > 0 ? '' : 'none';
});

// Shrink Node Ops to just its title bar when it's in the way — mirrors the
// transcript's collapse-not-vanish "peek" pattern (_collapseResponseArea).
document.getElementById('etp-title').addEventListener('click', () => {
  document.getElementById('edit-tools-panel').classList.toggle('collapsed');
});

// Same collapse-to-title-bar idea for the right-side button column ("Global Ops").
document.getElementById('global-ops-title').addEventListener('click', () => {
  _appEl.classList.toggle('global-ops-collapsed');
});

document.getElementById('etp-add-node').addEventListener('click', () => {
  if (!_editMode) return;
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const route  = routes[_editRouteIdx];
  if (!route || !route.points.length) return;
  const lastPt  = route.points[route.points.length - 1];
  const growIdx = _editRouteIdx;
  _exitEditMode();
  _growRouteIdx   = growIdx;
  const anchorLL  = L.latLng(lastPt.lat, lastPt.lon);
  _sketchWaypoints = [anchorLL];
  if (_sketchPath) _map.removeLayer(_sketchPath);
  _sketchPath = L.polyline([anchorLL], {
    color: '#e05252', weight: 4, opacity: 0.9, lineJoin: 'round', lineCap: 'round',
  }).addTo(_map);
  _enterSketchMode();
});

document.getElementById('etp-insert-node').addEventListener('click', () => {
  _addNodeMode = true;
  _renderEditLayers();
  _map.dragging.disable();
  _map.getContainer().style.cursor = 'crosshair';
  document.getElementById('edit-banner-label').textContent = _editRouteName + ' — click to insert node';
  _updateEditToolsPanel();
});

document.getElementById('etp-delete').addEventListener('click', () => {
  _deleteMode = !_deleteMode;
  _overnightMode = false;
  _fixNodesMode = false;
  document.getElementById('edit-banner-label').textContent =
    _deleteMode ? _editRouteName + ' — click a node to delete it' : _editRouteName;
  _renderEditLayers();
  _updateEditToolsPanel();
});

document.getElementById('etp-overnight').addEventListener('click', () => {
  _overnightMode = !_overnightMode;
  _deleteMode = false;
  _fixNodesMode = false;
  document.getElementById('edit-banner-label').textContent =
    _overnightMode ? _editRouteName + ' — click a node to mark/unmark as an overnight stop' : _editRouteName;
  _renderEditLayers();
  _updateEditToolsPanel();
});

document.getElementById('etp-fix-nodes').addEventListener('click', () => {
  if (!_editMode) return;
  _fixNodesMode = !_fixNodesMode;
  _deleteMode = false;
  _overnightMode = false;
  document.getElementById('edit-banner-label').textContent =
    _fixNodesMode ? _editRouteName + ' — click a node to fix hazards near it' : _editRouteName;
  _renderEditLayers();
  _updateEditToolsPanel();
});

document.getElementById('etp-animate').addEventListener('click', _animateEditRoute);
document.getElementById('etp-simulate-track').addEventListener('click', _enterSimTrackMode);

document.getElementById('etp-reroute').addEventListener('click', () => {
  if (!_editMode || _editPoints.length < 2) return;
  const btn = document.getElementById('etp-reroute');
  btn.disabled = true;
  const ui = _showRerouteOverlay(_editPoints);
  _reRouteSegments(_editPoints.map(_stripPoint), ui.update.bind(ui), ui.setText.bind(ui))
    .then(({ points, fallbacks, fallbackSegs, blocked }) => {
      ui.remove();
      btn.disabled = false;
      if (blocked) return;  // _reRouteSegments already announced why
      _editPoints = points;
      _selectedEditNodeIdx.clear();  // re-routing regenerates the whole point list
      _renderEditLayers();
      // Re-routing regenerates every point — a fresh check against real
      // hazard data, not just the land-avoidance the router already did.
      const found = _liveHazardCheck();
      if (!found.length) {
        if (fallbacks > 0) _showRouteFallbackWarning(fallbackSegs);
        else setStatus('Re-routed.');
      }
    })
    .catch(err => {
      ui.remove();
      btn.disabled = false;
      setStatus('Re-route failed.');
      console.error('[reroute]', err);
    });
});

// ── GPX export ────────────────────────────────────────────────────────────────

function _downloadGpx(points, routeName) {
  const trkpts = points.map(p => {
    // Route points have no per-point timestamp (they're planned paths, not a real track) —
    // omit <time> rather than fabricate one.
    const timeTag = (p.t != null) ? `<time>${new Date(p.t).toISOString()}</time>` : '';
    const extTag  = p.overnight ? '<extensions><overnight>true</overnight></extensions>' : '';
    return `    <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${timeTag}${extTag}</trkpt>`;
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

// Builds the lower-right Rename/Export corner controls for an .rp-row (shared between the
// Routes and Tracks list panels). getPoints() returns the point array to export; onRename(newName)
// persists the rename and should itself trigger a re-render of the owning panel.
function _buildRpCornerButtons(row, name, getPoints, onRename) {
  const corner = document.createElement('div');
  corner.className = 'rp-corner';

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'rp-corner-btn';
  renameBtn.textContent = '✎ Rename';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nameLine = row.querySelector('.rp-row-name');
    const nameText = nameLine.querySelector('span');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = name;
    input.className = 'rp-rename-input';
    input.addEventListener('click', (ev) => ev.stopPropagation());
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') saveBtn.click(); });
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '✓';
    saveBtn.className = 'rp-corner-btn';
    saveBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const newName = input.value.trim();
      if (newName && newName !== name) onRename(newName);
    });
    nameText.replaceWith(input);
    nameLine.insertBefore(saveBtn, corner);
    input.focus();
  });

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'rp-corner-btn';
  exportBtn.textContent = '⬇ Export';
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _downloadGpx(getPoints(), name);
  });

  const copyWptsBtn = document.createElement('button');
  copyWptsBtn.type = 'button';
  copyWptsBtn.className = 'rp-corner-btn';
  copyWptsBtn.textContent = '📋 Copy waypoints';
  copyWptsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _showCopyWaypointsOverlay(name, getPoints());
  });

  corner.appendChild(renameBtn);
  corner.appendChild(exportBtn);
  corner.appendChild(copyWptsBtn);
  return corner;
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

// Flat-earth approximation (matches _addLeaderLabel's convention) — fine at coastal scale.
function _destinationPoint(lat, lon, bearingDeg, distNm) {
  const brgRad = bearingDeg * Math.PI / 180;
  const dLat = distNm * Math.cos(brgRad) / 60;
  const dLon = distNm * Math.sin(brgRad) / 60 / Math.cos(lat * Math.PI / 180);
  return { lat: lat + dLat, lon: lon + dLon };
}

// Persistent ray from the boat toward the current focus target, extending a bit past it.
// lat/lon optionally override the boat position (used for live feedback while dragging).
function _updateFocusRay(lat, lon) {
  if (!_map) return;
  const f = Query.focusedTarget;
  const pos = (lat != null && lon != null) ? { lat, lon } : GPS.getPosition();
  if (!f || !pos) {
    if (_focusRayLine) { _map.removeLayer(_focusRayLine); _focusRayLine = null; }
    return;
  }
  const brg  = Query.bearing(pos.lon, pos.lat, f.lon, f.lat);
  const dist = Query.distanceNm(pos.lon, pos.lat, f.lon, f.lat);
  const end  = _destinationPoint(pos.lat, pos.lon, brg, dist * 1.15);
  const latlngs = [[pos.lat, pos.lon], [end.lat, end.lon]];
  if (!_focusRayLine) {
    _focusRayLine = L.polyline(latlngs, {
      color: '#4ade80', weight: 2, opacity: 0.75, dashArray: '2 8', interactive: false,
    }).addTo(_map);
  } else {
    _focusRayLine.setLatLngs(latlngs);
  }
}

// ── Live direction-of-travel indicator ──────────────────────────────────────────
// A solid red ray + arrowhead from the boat showing real course-over-ground, scaled
// to a 6-minute predictor (standard ECDIS/chartplotter convention) — longer when
// moving fast, shorter when slow. Hidden below MIN_HEADING_SPEED_KT since phone GPS
// heading is unreliable/noisy near-stationary. Paired with a small numeric readout
// next to the tide widget.
const MIN_HEADING_SPEED_KT = 2;
const HEADING_PREDICTOR_MIN = 6;
let _lastFixForHeading = null; // {lat, lon, t} — fallback source when coords.heading is unavailable

function _computeHeadingSpeed(lat, lon, browserHeadingDeg, browserSpeedKt) {
  const now = Date.now();
  let headingDeg = browserHeadingDeg;
  let speedKt = browserSpeedKt;
  if (_lastFixForHeading) {
    const dtSec = (now - _lastFixForHeading.t) / 1000;
    const distNm = Query.distanceNm(_lastFixForHeading.lon, _lastFixForHeading.lat, lon, lat);
    if (dtSec > 0) {
      if (headingDeg == null && distNm > 0.005) { // moved more than ~9m — enough to trust a computed bearing
        headingDeg = Query.bearing(_lastFixForHeading.lon, _lastFixForHeading.lat, lon, lat);
      }
      if (speedKt == null) speedKt = (distNm / dtSec) * 3600;
    }
  }
  _lastFixForHeading = { lat, lon, t: now };
  return { headingDeg, speedKt };
}

function _updateHeadingRay(lat, lon, headingDeg, speedKt) {
  if (!_map) return;
  if (headingDeg == null || speedKt == null || speedKt < MIN_HEADING_SPEED_KT) {
    if (_headingRayLine)  { _map.removeLayer(_headingRayLine);  _headingRayLine  = null; }
    if (_headingRayArrow) { _map.removeLayer(_headingRayArrow); _headingRayArrow = null; }
    return;
  }
  const distNm = speedKt * (HEADING_PREDICTOR_MIN / 60);
  const end = _destinationPoint(lat, lon, headingDeg, distNm);
  const latlngs = [[lat, lon], [end.lat, end.lon]];
  if (!_headingRayLine) {
    _headingRayLine = L.polyline(latlngs, {
      color: '#e05252', weight: 3, opacity: 0.9, interactive: false,
    }).addTo(_map);
  } else {
    _headingRayLine.setLatLngs(latlngs);
  }
  const arrowIcon = L.divIcon({
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
      <polygon points="10,0 18,18 10,13 2,18" fill="#e05252" transform="rotate(${headingDeg},10,10)"/>
    </svg>`,
    iconSize: [20, 20], iconAnchor: [10, 10], className: '',
  });
  if (!_headingRayArrow) {
    _headingRayArrow = L.marker([end.lat, end.lon], { icon: arrowIcon, interactive: false, keyboard: false }).addTo(_map);
  } else {
    _headingRayArrow.setLatLng([end.lat, end.lon]);
    _headingRayArrow.setIcon(arrowIcon);
  }
}

function _updateFollowProgress(lat, lon) {
  if (!_followProgressEl) return;
  if (!_followingRouteId) { _followProgressEl.style.display = 'none'; return; }
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const route = routes.find(r => r.id === _followingRouteId);
  const pts = route?.points;
  if (!pts || pts.length < 2) { _followProgressEl.style.display = 'none'; return; }

  // Advance the "next waypoint" pointer using along-track projection onto the
  // current leg (same _segCrossTrack math as hazard checking), not just a raw
  // arrival-radius check — a route that cuts a corner near a waypoint (never
  // coming within ARRIVAL_THRESHOLD_NM of it) would otherwise get the pointer
  // stuck there for the rest of the trip, since it'd never trip that check.
  while (_followingLegIdx < pts.length - 1) {
    const a = pts[_followingLegIdx - 1], b = pts[_followingLegIdx];
    const segLen = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
    const ct = _segCrossTrack(a.lon, a.lat, b.lon, b.lat, lon, lat);
    const pastSegment = ct
      ? ct.alongTrack >= segLen
      : Query.distanceNm(lon, lat, b.lon, b.lat) <= ARRIVAL_THRESHOLD_NM;
    if (!pastSegment) break;
    _followingLegIdx++;
  }
  const nextPt = pts[_followingLegIdx];
  const distToNext = Query.distanceNm(lon, lat, nextPt.lon, nextPt.lat);
  let distToEnd = distToNext;
  for (let i = _followingLegIdx; i < pts.length - 1; i++) {
    distToEnd += Query.distanceNm(pts[i].lon, pts[i].lat, pts[i + 1].lon, pts[i + 1].lat);
  }
  let distTraveled = 0;
  for (let i = 1; i < _trackRecPoints.length; i++) {
    distTraveled += Query.distanceNm(_trackRecPoints[i - 1].lon, _trackRecPoints[i - 1].lat, _trackRecPoints[i].lon, _trackRecPoints[i].lat);
  }

  _followProgressEl.style.display = '';
  _followProgressEl.innerHTML =
    `<div>Next: ${distToNext.toFixed(1)} nm</div>` +
    `<div>To end: ${distToEnd.toFixed(1)} nm</div>` +
    `<div>Traveled: ${distTraveled.toFixed(1)} nm</div>`;
}

function _updateHeadingSpeedReadout(headingDeg, speedKt) {
  if (!_headingSpeedEl) return;
  if (speedKt == null) { _headingSpeedEl.style.display = 'none'; return; }
  _headingSpeedEl.style.display = '';
  const headingText = (headingDeg != null && speedKt >= MIN_HEADING_SPEED_KT)
    ? `${String(Math.round(trueTomagnetic(headingDeg) + 360) % 360).padStart(3, '0')}°M`
    : '—°M';
  _headingSpeedEl.textContent = `${headingText} · ${speedKt.toFixed(1)}kt`;
}

// ── Simulate Heading — dead-reckoning rehearsal tool ────────────────────────────
// Place the boat, pick an arbitrary heading (drag or type), see a ray showing where
// it leads. Distinct from _startRouteAnimation (which moves a boat along a route over
// simulated time) — this is a static plotting check, no time dimension.

// "Next waypoint ahead" = the far end of whichever route segment the boat is nearest
// to, via the existing cross-track projection helper (_nearestSegIdx, used elsewhere
// for route-edit vertex snapping).
function _nearestRouteWaypointAhead(lat, lon, route) {
  if (!route?.points?.length) return null;
  if (route.points.length === 1) return route.points[0];
  const segIdx = _nearestSegIdx(route.points, L.latLng(lat, lon));
  return route.points[segIdx + 1];
}

// Ray length + reference point, priority: selected route's next waypoint ahead >
// current focus target > fixed default.
function _simTrackRefPoint(lat, lon) {
  const sel = document.getElementById('track-route-select');
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const route = sel?.value !== '' ? routes[parseInt(sel.value)] : null;
  if (route?.points?.length) {
    const wp = _nearestRouteWaypointAhead(lat, lon, route);
    if (wp) return { lat: wp.lat, lon: wp.lon, lenNm: Query.distanceNm(lon, lat, wp.lon, wp.lat) };
  }
  if (Query.focusedTarget) {
    const f = Query.focusedTarget;
    return { lat: f.lat, lon: f.lon, lenNm: Query.distanceNm(lon, lat, f.lon, f.lat) };
  }
  return { lat: null, lon: null, lenNm: SIM_TRACK_DEFAULT_NM };
}

// Swap whichever boat marker is currently shown (test-position or live-GPS layer) to
// the rotated icon, without touching _showBoatPosition/_refreshYouLayer's own
// marker-creation/drag-handler logic. Both layers are always single-marker L.layerGroups.
function _setBoatIconRotated(bearingDegTrue) {
  const marker = _boatLayer?.getLayers()[0] || _youLayer?.getLayers()[0];
  marker?.setIcon(_animBoatIcon(bearingDegTrue));
}

// bearingDegTrue: TRUE degrees (matches _destinationPoint/Query.bearing convention).
// Banner/input display magnetic — this app shows bearings as magnetic everywhere else.
function _updateSimTrackRay(bearingDegTrue) {
  if (_simTrackRunning) return; // course locked once the simulation is running
  bearingDegTrue = ((bearingDegTrue % 360) + 360) % 360;
  _simTrackDeg = bearingDegTrue;
  const { lat, lon } = _simTrackBoat;
  const end = _destinationPoint(lat, lon, bearingDegTrue, _simTrackLenNm);
  const latlngs = [[lat, lon], [end.lat, end.lon]];
  if (!_simTrackRay) {
    _simTrackRay = L.polyline(latlngs, {
      color: '#38bdf8', weight: 2.5, opacity: 0.85, dashArray: '6 4', interactive: false,
    }).addTo(_map);
  } else {
    _simTrackRay.setLatLngs(latlngs);
  }
  _simTrackHandle?.setLatLng([end.lat, end.lon]);
  _setBoatIconRotated(bearingDegTrue);
  const magDeg = Math.round(trueTomagnetic(bearingDegTrue));
  const input = document.getElementById('sim-track-course-input');
  if (input && document.activeElement !== input) input.value = magDeg;
  _updateSimTrackBannerText();
}

function _updateSimTrackBannerText() {
  const label = document.getElementById('sim-track-banner-status');
  if (!label) return;
  const magDeg = Math.round(trueTomagnetic(_simTrackDeg));
  if (!_simTrackRunning && _simTrackTraveledNm === 0) {
    label.textContent = `Course: ${String(magDeg).padStart(3, '0')}°M — drag handle or Start`;
    return;
  }
  const sailMin = Math.round(_simTrackTraveledNm / _simTrackSpeedKts * 60);
  const state = _simTrackRunning ? '' : ' · stopped';
  label.textContent =
    `⛵ ${String(magDeg).padStart(3, '0')}°M · ${_simTrackSpeedKts} kts · ${_simTrackCompress}× · ` +
    `${_simTrackTraveledNm.toFixed(1)} nm in ${sailMin} min sailing${state}`;
}

function _enterSimTrackMode() {
  if (_sketchMode || _drawMode || _focusPlaceMode || _animMode) return; // _editMode intentionally allowed
  const pos = GPS.getPosition();
  if (!pos) { TTS.sayImmediate("Set the boat's position first."); return; }
  if (_addNodeMode) _cancelAddNodeMode(); // avoid edit-mode's node-placement mouseup racing the drag handle

  _simTrackMode = true;
  _simTrackRunning = false;
  _simTrackTraveledNm = 0;
  _simTrackBaselineNm = 0;
  _simTrackBoat = { lat: pos.lat, lon: pos.lon };

  const ref = _simTrackRefPoint(pos.lat, pos.lon);
  _simTrackLenNm = ref.lenNm;
  const initialBrg = ref.lat != null ? Query.bearing(pos.lon, pos.lat, ref.lon, ref.lat) : 0;

  _simTrackHandle = L.marker([pos.lat, pos.lon], {
    icon: L.divIcon({ className: 'sim-track-handle', iconSize: [16, 16], iconAnchor: [8, 8] }),
    draggable: true,
    zIndexOffset: 1300,
  }).addTo(_map);
  _simTrackHandle.on('drag', () => {
    const ll = _simTrackHandle.getLatLng();
    _updateSimTrackRay(Query.bearing(_simTrackBoat.lon, _simTrackBoat.lat, ll.lng, ll.lat));
  });

  const speedInput = document.getElementById('sim-track-speed-input');
  if (speedInput && !speedInput.value) {
    speedInput.value = document.getElementById('track-speed-input')?.value || 5;
  }

  _updateSimTrackRay(initialBrg);
  document.getElementById('sim-track-start-btn').textContent = '▶ Start';
  document.getElementById('sim-track-banner').style.display = 'flex';
}

function _startSimTrack() {
  if (!_simTrackMode || _simTrackRunning) return;
  const speedInput = document.getElementById('sim-track-speed-input');
  const speed = parseFloat(speedInput.value);
  if (!speed || speed <= 0) { TTS.sayImmediate('Enter a speed in knots first.'); return; }
  _simTrackSpeedKts = speed;
  _simTrackCompress = parseInt(document.querySelector('.track-sim-compress.selected')?.dataset.compress) || 1;

  _simTrackRunning = true;
  _simTrackBaselineNm = _simTrackTraveledNm;
  _simTrackRunStartMs = null;

  document.getElementById('sim-track-course-input').disabled = true;
  speedInput.disabled = true;
  document.querySelectorAll('.track-sim-compress').forEach(b => b.disabled = true);

  if (!_simTrackLine) {
    _simTrackLine = L.polyline(
      [[_simTrackBoat.lat, _simTrackBoat.lon], [_simTrackBoat.lat, _simTrackBoat.lon]],
      { color: '#38bdf8', weight: 3, opacity: 0.9, interactive: false }
    ).addTo(_map);
  }
  if (!_map.getPane('simTrackBoatPane')) _map.createPane('simTrackBoatPane').style.zIndex = '760';
  if (!_simTrackBoatMarker) {
    _simTrackBoatMarker = L.marker([_simTrackBoat.lat, _simTrackBoat.lon], {
      icon: _animBoatIcon(_simTrackDeg), pane: 'simTrackBoatPane',
    }).addTo(_map);
  }

  document.getElementById('sim-track-start-btn').textContent = '⏸ Stop';
  document.getElementById('sim-track-start-btn').classList.add('sim-track-running');
  _simTrackRafId = requestAnimationFrame(_simTrackStep);
}

function _simTrackStep(now) {
  if (!_simTrackMode || !_simTrackRunning) return;
  if (_simTrackRunStartMs === null) _simTrackRunStartMs = now;

  const elapsedSec   = (now - _simTrackRunStartMs) / 1000;
  const nmPerRealSec = (_simTrackSpeedKts / 3600) * _simTrackCompress;
  _simTrackTraveledNm = _simTrackBaselineNm + elapsedSec * nmPerRealSec;

  const { lat: bLat, lon: bLon } = _simTrackBoat;
  const cur = _destinationPoint(bLat, bLon, _simTrackDeg, _simTrackTraveledNm);

  _simTrackLine.setLatLngs([[bLat, bLon], [cur.lat, cur.lon]]);
  _simTrackBoatMarker.setLatLng([cur.lat, cur.lon]);

  if (_map && !_map.getBounds().pad(-0.1).contains([cur.lat, cur.lon])) {
    _map.panTo([cur.lat, cur.lon], { animate: true, duration: 0.4 });
  }

  _updateSimTrackBannerText();
  _simTrackRafId = requestAnimationFrame(_simTrackStep);
}

function _stopSimTrack() {
  if (!_simTrackRunning) return;
  _simTrackRunning = false;
  if (_simTrackRafId) { cancelAnimationFrame(_simTrackRafId); _simTrackRafId = null; }
  document.getElementById('sim-track-start-btn').textContent = '▶ Start';
  document.getElementById('sim-track-start-btn').classList.remove('sim-track-running');
  _updateSimTrackBannerText();
}

function _exitSimTrackMode() {
  if (!_simTrackMode) return;
  _stopSimTrack();
  _simTrackMode = false;
  document.getElementById('sim-track-banner').style.display = 'none';
  if (_simTrackHandle)     { _map.removeLayer(_simTrackHandle);     _simTrackHandle = null; }
  if (_simTrackRay)        { _map.removeLayer(_simTrackRay);        _simTrackRay = null; }
  if (_simTrackLine)       { _map.removeLayer(_simTrackLine);       _simTrackLine = null; }
  if (_simTrackBoatMarker) { _map.removeLayer(_simTrackBoatMarker); _simTrackBoatMarker = null; }
  _simTrackBoat = null;
  _simTrackTraveledNm = 0;
  _simTrackBaselineNm = 0;

  const speedInput = document.getElementById('sim-track-speed-input');
  if (speedInput) speedInput.disabled = false;
  document.getElementById('sim-track-course-input').disabled = false;
  document.querySelectorAll('.track-sim-compress').forEach(b => b.disabled = false);

  const marker = _boatLayer?.getLayers()[0] || _youLayer?.getLayers()[0];
  marker?.setIcon(_boatIcon());
}

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
  // Restore route labels that were hidden during animation
  if (_savedRoutesLayer && _map && !_map.hasLayer(_savedRoutesLayer)) _savedRoutesLayer.addTo(_map);
  // Close standalone settings panel if open
  const _ts = document.getElementById('map-ctx-track-submenu');
  if (_ts?._standalone) {
    _ts.style.cssText = '';
    _ts.style.display = 'none';
    _ts._standalone = false;
  }
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
  // Hide cluttered route labels (bearing tips, coord tooltips) during animation
  if (_savedRoutesLayer && _map.hasLayer(_savedRoutesLayer)) _map.removeLayer(_savedRoutesLayer);

  const pts = route.points.map(p => [p.lat, p.lon]);
  _animRouteLine = L.polyline(pts, {
    color: '#e05252', weight: 3, opacity: 0.7, dashArray: '8 4',
  }).addTo(_map);
  if (track.zoom) _map.setView(pts[0], track.zoom);
  else            _map.fitBounds(L.latLngBounds(pts).pad(0.05));

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
  if (!_map.getPane('animBoatPane')) _map.createPane('animBoatPane').style.zIndex = '750';
  _animMarker = L.marker(pts[0], { icon: _animBoatIcon(_initBearing), pane: 'animBoatPane' }).addTo(_map);
  _animCurrentLat = pts[0][0];
  _animCurrentLon = pts[0][1];

  // Apply time compression: 1× = real time, 10× = 10 min sailing per real sec, etc.
  const compress    = track.compress || 1;
  const nmPerRealSec = (speedKnots / 3600) * compress;
  const sailTotalMin = Math.round(totalNm / speedKnots * 60); // actual sailing minutes
  const compressLabel = compress > 1 ? ` · ${compress}×` : '';

  // Prime TTS for iOS audio unlock; animation starts immediately in parallel.
  const milesText = `${Math.round(totalNm * 10) / 10} nautical miles.`;
  TTS.sayImmediate(`Animating ${route.name}. ${milesText}`);
  _animRafId = requestAnimationFrame(step);

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
  // Delay registering the stop handler so the popup's button click doesn't
  // immediately trigger it (closePopup strips the popup's stopPropagation
  // listener before the click finishes bubbling to the map).
  setTimeout(() => {
    if (!_animMode) return;
    _animClickHandler = _onAnimStop;
    _map.on('click', _onAnimStop);
  }, 300);

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
    if (boatEl) boatEl.style.transform = _boatIconTransform(bearing);

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

// Deterministic color per bedrock unit code — Maine's own COLOR field is a
// numbered index into a paper-map color chart, not a usable CSS value, so units
// are colored by a hash of their CODE instead. Visually arbitrary but stable
// (the same unit always gets the same color) and gives real unit-to-unit contrast;
// the actual identity comes from the tooltip (CODE + UNIT_DESCRIPTION), not the hue.
const _GEOLOGY_PALETTE = ['#c96f4a','#e8b84b','#6fa96f','#5b9bd5','#a06cd5','#d5637a','#4fb0a5','#c9944a','#7c8fa6','#b5cc5e','#d68fb0','#5c9e7c'];
function _geologyColorFor(code) {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
  return _GEOLOGY_PALETTE[h % _GEOLOGY_PALETTE.length];
}

function _clearMaineGeologyLayer() {
  if (_maineGeologyMoveEnd) { _map.off('moveend', _maineGeologyMoveEnd); _maineGeologyMoveEnd = null; }
  if (_maineGeologyLayer) { _map.removeLayer(_maineGeologyLayer); _maineGeologyLayer = null; }
}

// Maine's bedrock layer is a live ArcGIS FeatureServer (real polygon geometry +
// attributes, not pre-rendered tiles like the USGS WMS) — re-queried by viewport
// bbox on every pan/zoom, same moveend-driven refresh pattern as
// _renderViewportHazards. _maineGeologyFetchToken guards against a slow response
// for an old viewport landing after a newer request already started.
async function _refreshMaineGeologyLayer() {
  if (_mapViewMode !== 'geology-maine' || !_map) return;
  const b = _map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const token = ++_maineGeologyFetchToken;
  let geojson;
  try {
    const url = 'https://services1.arcgis.com/RbMX0mRVOFNTdLzd/ArcGIS/rest/services/'
      + 'MGS_Bedrock_500K_Simplified_Map_Data/FeatureServer/0/query'
      + '?where=1=1&outFields=CODE,AGE,PROTOLITH,UNIT_DESCRIPTION'
      + `&geometry=${bbox}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`
      + '&f=geojson';
    geojson = await fetch(url).then(r => r.json());
  } catch (e) {
    console.error('[geology-maine] fetch failed', e);
    return;
  }
  if (token !== _maineGeologyFetchToken || _mapViewMode !== 'geology-maine') return;  // stale response or mode changed mid-fetch
  if (_maineGeologyLayer) _map.removeLayer(_maineGeologyLayer);
  _maineGeologyLayer = L.geoJSON(geojson, {
    style: (f) => ({
      color: '#333', weight: 0.5,
      fillColor: _geologyColorFor(f.properties.CODE || ''), fillOpacity: 0.55,
    }),
    onEachFeature: (f, layer) => {
      const p = f.properties;
      layer.bindTooltip(`${p.CODE || ''} — ${p.UNIT_DESCRIPTION || 'Bedrock unit'}`, { sticky: true });
    },
  }).addTo(_map);
}

function _enableMaineGeologyLayer() {
  _refreshMaineGeologyLayer();
  _maineGeologyMoveEnd = () => _refreshMaineGeologyLayer();
  _map.on('moveend', _maineGeologyMoveEnd);
}

function _applyMapLayer() {
  if (!_map) return;
  if (_baseTileLayer) { _map.removeLayer(_baseTileLayer); _baseTileLayer = null; }
  _clearMaineGeologyLayer();

  if (_mapViewMode === 'satellite') {
    _baseTileLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { minZoom: 4, maxZoom: 18, maxNativeZoom: 17, attribution: '© Esri' }
    ).addTo(_map);
  } else if (_mapViewMode === 'geology-usgs') {
    // USGS State Geologic Map Compilation (mrdata.usgs.gov) — self-contained WMS
    // raster (own background, no basemap needed underneath). Live internet fetch,
    // same offline limitation as the satellite layer above.
    _baseTileLayer = L.tileLayer.wms(
      'https://mrdata.usgs.gov/services/sgmc2',
      { layers: 'sgmc2', format: 'image/png', transparent: false,
        minZoom: 4, maxZoom: 18, attribution: 'USGS State Geologic Map Compilation' }
    ).addTo(_map);
  } else {
    // 'chart' and 'geology-maine' both use the street basemap: 'chart' on its own,
    // 'geology-maine' as context underneath its own polygon overlay (added below) —
    // that dataset has no coastline/place-name context of its own.
    _baseTileLayer = L.tileLayer(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      // maxZoom stays 18 to match the zoom slider; maxNativeZoom caps actual tile
      // *requests* at 17 (the provider's real resolution) and lets Leaflet upscale
      // that last tile for zoom 18 instead of leaving a blank screen past 17.
      { minZoom: 4, maxZoom: 18, maxNativeZoom: 17, attribution: '© OpenStreetMap contributors' }
    ).addTo(_map);
  }

  if (_mapViewMode === 'geology-maine') _enableMaineGeologyLayer();
}

const MAP_VIEW_ICONS  = { chart: '🗺', satellite: '🛰', 'geology-usgs': '🪨', 'geology-maine': '⛰' };
const MAP_VIEW_LABELS = { chart: 'chart', satellite: 'satellite', 'geology-usgs': 'USGS geology', 'geology-maine': 'Maine geology' };

function _syncLayerBtn() {
  const btn = document.getElementById('map-layer-btn');
  if (!btn) return;
  const next = MAP_VIEW_MODES[(MAP_VIEW_MODES.indexOf(_mapViewMode) + 1) % MAP_VIEW_MODES.length];
  btn.textContent = MAP_VIEW_ICONS[_mapViewMode];
  btn.title       = `Switch to ${MAP_VIEW_LABELS[next]}`;
}

function _ensureMap() {
  if (_map) return;
  _map = L.map('leaflet-map', { zoomControl: false, attributionControl: true });
  _map.setView([44.1018, -69.0752], 11);  // Rockland Harbor — default until GPS arrives
  _applyMapLayer();
  _syncLayerBtn();
  _loadHiddenRoutes();
  _loadHiddenTracks();
  _refreshSavedRouteLayers();
  _refreshSavedTrackLayers();

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

  // Pan buttons (desktop only — hidden by CSS on mobile)
  const PAN_PX = 200;
  document.getElementById('pan-north').addEventListener('click', () => _map.panBy([0, -PAN_PX], { animate: true, duration: 0.25 }));
  document.getElementById('pan-south').addEventListener('click', () => _map.panBy([0, +PAN_PX], { animate: true, duration: 0.25 }));
  document.getElementById('pan-west') .addEventListener('click', () => _map.panBy([-PAN_PX, 0], { animate: true, duration: 0.25 }));
  document.getElementById('pan-east') .addEventListener('click', () => _map.panBy([+PAN_PX, 0], { animate: true, duration: 0.25 }));

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
      el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="70" height="70" viewBox="-70 -70 140 140">
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

  // Heading/speed readout — small always-on text control, same L.Control family as
  // the compass rose and tide cycle, stacked with them in the top-right corner.
  const _HeadingSpeedReadout = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const el = L.DomUtil.create('div', 'heading-speed-ctrl');
      L.DomEvent.disableClickPropagation(el);
      el.style.display = 'none';
      _headingSpeedEl = el;
      return el;
    },
  });
  new _HeadingSpeedReadout().addTo(_map);

  // Route-follow progress readout — next waypoint / distance to end / distance
  // traveled, shown only while a route is being followed (see _startFollowingRoute).
  const _FollowProgressReadout = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const el = L.DomUtil.create('div', 'follow-progress-ctrl');
      L.DomEvent.disableClickPropagation(el);
      el.style.display = 'none';
      _followProgressEl = el;
      return el;
    },
  });
  new _FollowProgressReadout().addTo(_map);

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
    _mapViewMode = MAP_VIEW_MODES[(MAP_VIEW_MODES.indexOf(_mapViewMode) + 1) % MAP_VIEW_MODES.length];
    localStorage.setItem('audiochart-chart-mode', _mapViewMode);
    _applyMapLayer();
    _syncLayerBtn();
  });

  document.getElementById('zoom-to-me-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const pos = GPS.getPosition();
    if (!pos) {
      const msg = 'No GPS fix yet. Please wait for a position.';
      setStatus(msg);
      TTS.sayImmediate(msg);
      return;
    }
    _map.flyTo([pos.lat, pos.lon], 15, { duration: 0.6 });
  });

  // ⚓ Navaid filter panel
  const _navaidFilterBtn   = document.getElementById('navaid-filter-btn');
  const _navaidFilterPanel = document.getElementById('navaid-filter-panel');
  const _closeNavaidPanel = () => {
    _navaidFilterPanel.classList.remove('open');
    _navaidFilterBtn.classList.remove('active');
  };
  _addSwipeToClose(_navaidFilterPanel, _closeNavaidPanel, 'x', '.nf-title');
  _makeDraggable(_navaidFilterPanel, _navaidFilterPanel.querySelector('.nf-title'));
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

  // ⓘ About panel — tap either version label to see features + coverage areas
  const _aboutPanel = document.getElementById('about-panel');
  const _closeAbout = () => _aboutPanel.classList.remove('open');
  _addSwipeToClose(_aboutPanel, _closeAbout, 'x', '.nf-title');
  _makeDraggable(_aboutPanel, _aboutPanel.querySelector('.nf-title'));
  document.getElementById('about-close').addEventListener('click', _closeAbout);
  _map.on('click', _closeAbout);
  function _showAboutPanel() {
    document.getElementById('about-version').textContent = `AudioChart ${VERSION}`;
    document.getElementById('about-features').innerHTML =
      ABOUT_FEATURES.map(f => `<li>${f}</li>`).join('');
    document.getElementById('about-regions').innerHTML =
      Object.keys(CRUISE_PROFILES).map(name => `<li>${name}</li>`).join('');
    _aboutPanel.classList.add('open');
  }
  document.getElementById('app-version').addEventListener('click', (e) => {
    e.stopPropagation();
    _showAboutPanel();
  });
  document.getElementById('map-version-label').addEventListener('click', (e) => {
    e.stopPropagation();
    _showAboutPanel();
  });

  // ✒ Route picker panel
  const _routePickerBtn   = document.getElementById('route-picker-btn');
  const _routePickerPanel = document.getElementById('route-picker-panel');
  const _closeRoutePicker = () => {
    _routePickerPanel.classList.remove('open');
    _routePickerBtn.classList.remove('active');
  };
  _addSwipeToClose(_routePickerPanel, _closeRoutePicker, 'x', '.nf-title');
  _makeDraggable(_routePickerPanel, _routePickerPanel.querySelector('.nf-title'));

  function _buildRoutePickerPanel() {
    DriveSync.maybeAutoSync();
    const list  = document.getElementById('rp-route-list');
    const query = document.getElementById('rp-search').value || '';
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    list.innerHTML = '';
    const filtered = routes.filter(r => _itemMatchesSearch(r, query))
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rp-empty';
      empty.textContent = routes.length === 0 ? 'No saved routes.' : 'No routes match.';
      list.appendChild(empty);
      return;
    }
    filtered.forEach(route => {
      const first = route.points?.[0];
      const last  = route.points?.[route.points.length - 1];
      const startName = first ? (_nearestPlaceName(first.lat, first.lon) || `${first.lat.toFixed(3)},${first.lon.toFixed(3)}`) : '';
      const endName   = last  ? (_nearestPlaceName(last.lat,  last.lon)  || `${last.lat.toFixed(3)},${last.lon.toFixed(3)}`)   : '';
      const hidden = _hiddenRouteNames.has(route.name);
      const expanded = route.name === _expandedRouteRowName;
      const row = document.createElement('button');
      row.className = 'rp-row' + (hidden ? ' hidden' : '') + (expanded ? ' expanded' : '');
      const nameLine = document.createElement('div');
      nameLine.className = 'rp-row-name';
      const nameText = document.createElement('span');
      nameText.textContent = route.name;
      nameLine.appendChild(nameText);
      {
        const hazFound = _getRouteHazards(route);
        const hardCount = hazFound.filter(h => h.kind === 'hard').length;
        const softCount = hazFound.length - hardCount;
        if (hardCount > 0) {
          const badge = document.createElement('span');
          badge.className = 'status-badge rp-hazard-hard';
          badge.textContent = `${hardCount} hard`;
          badge.title = `${hardCount} rock/obstruction/wreck hazard${hardCount > 1 ? 's' : ''} on this route`;
          nameLine.appendChild(badge);
        }
        if (softCount > 0) {
          const badge = document.createElement('span');
          badge.className = 'status-badge rp-hazard-soft';
          badge.textContent = `${softCount} shallow`;
          badge.title = `${softCount} shallow-area crossing${softCount > 1 ? 's' : ''} — draft/tide dependent, not automatically unsafe`;
          nameLine.appendChild(badge);
        }
      }
      const delBtn = document.createElement('button');
      delBtn.className = 'rp-delete-btn';
      delBtn.textContent = '×';
      delBtn.title = 'Delete route';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Delete route "${route.name}"?`)) return;
        const all = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
        _tombstone(route.id, 'route');
        localStorage.setItem(ROUTE_KEY, JSON.stringify(all.filter(r => r.name !== route.name)));
        _hiddenRouteNames.delete(route.name);
        _saveHiddenRoutes();
        if (localStorage.getItem('audiochart-last-route') === route.name)
          localStorage.removeItem('audiochart-last-route');
        if (_expandedRouteRowName === route.name) _expandedRouteRowName = null;
        _refreshSavedRouteLayers();
        _populateRouteSelectFn?.();
        _buildRoutePickerPanel();
      });
      nameLine.appendChild(delBtn);
      nameLine.appendChild(_buildRpCornerButtons(row, route.name, () => route.points, (newName) => {
        const routes2 = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
        const idx = routes2.findIndex(r => r.name === route.name);
        if (idx < 0) return;
        const oldName = routes2[idx].name;
        routes2[idx].name = newName;
        _touch(routes2[idx]);
        localStorage.setItem(ROUTE_KEY, JSON.stringify(routes2));
        if (localStorage.getItem('audiochart-last-route') === oldName) {
          localStorage.setItem('audiochart-last-route', newName);
        }
        if (_hiddenRouteNames.has(oldName)) { _hiddenRouteNames.delete(oldName); _hiddenRouteNames.add(newName); }
        _saveHiddenRoutes();
        if (_expandedRouteRowName === oldName) _expandedRouteRowName = newName;
        _populateRouteSelectFn?.();
        _refreshSavedRouteLayers();
        _buildRoutePickerPanel();
      }));
      row.appendChild(nameLine);
      if (startName || endName) {
        const placeLine = document.createElement('div');
        placeLine.className = 'rp-row-places';
        placeLine.textContent = startName + (endName && endName !== startName ? ' → ' + endName : '');
        row.appendChild(placeLine);
      }
      const dateLine = document.createElement('div');
      dateLine.className = 'rp-row-date';
      dateLine.textContent = _routeDateLabel(route);
      row.appendChild(dateLine);
      const speedKt = parseFloat(localStorage.getItem('audiochart-last-speed')) || 5;
      const legs = splitIntoLegs(route.points, speedKt);
      if (legs.length > 0) {
        const legList = document.createElement('div');
        legList.className = 'rp-legs';
        legs.forEach((leg, i) => {
          const aName = _nearestPlaceName(route.points[leg.startIdx].lat, route.points[leg.startIdx].lon)
            || formatPositionDisplay(route.points[leg.startIdx].lat, route.points[leg.startIdx].lon);
          const bName = _nearestPlaceName(route.points[leg.endIdx].lat, route.points[leg.endIdx].lon)
            || formatPositionDisplay(route.points[leg.endIdx].lat, route.points[leg.endIdx].lon);
          const legRow = document.createElement('div');
          legRow.className = 'rp-leg-row';
          legRow.textContent = `Day ${i + 1}: ${aName} \u2192 ${bName}, ${leg.distNm.toFixed(1)}nm (~${leg.hours.toFixed(1)}h @ ${speedKt}kt)`;
          legList.appendChild(legRow);
        });
        row.appendChild(legList);
      }
      const followBtn = document.createElement('button');
      followBtn.className = 'rp-follow-btn';
      if (_followingRouteId === route.id) {
        followBtn.textContent = '⏹ Stop Following';
        followBtn.classList.add('following');
      } else {
        followBtn.textContent = '▶ Follow';
        followBtn.title = 'Record a timestamped track of this passage — stops automatically on arrival';
        if (_trackRecActive) followBtn.disabled = true;
      }
      followBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_followingRouteId === route.id) _stopFollowingRoute(false);
        else _startFollowingRoute(route);
      });
      row.appendChild(followBtn);
      row.addEventListener('click', () => {
        if (_hiddenRouteNames.has(route.name)) {
          _hiddenRouteNames.delete(route.name);
        } else {
          _hiddenRouteNames.add(route.name);
        }
        _saveHiddenRoutes();
        _expandedRouteRowName = (_expandedRouteRowName === route.name) ? null : route.name;
        _refreshSavedRouteLayers();
        _buildRoutePickerPanel();
      });
      list.appendChild(row);
    });
  }

  _routePickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !_routePickerPanel.classList.contains('open');
    _routePickerPanel.classList.toggle('open');
    _routePickerBtn.classList.toggle('active', opening);
    if (opening) _buildRoutePickerPanel();
  });

  document.getElementById('reroute-btn').addEventListener('click', () => {
    const btn = document.getElementById('reroute-btn');
    if (_editMode) {
      if (_editPoints.length < 2) return;
      btn.classList.add('working');
      const ui = _showRerouteOverlay(_editPoints);
      _reRouteSegments(_editPoints.map(_stripPoint), ui.update.bind(ui), ui.setText.bind(ui))
        .then(({ points, fallbacks, fallbackSegs, blocked }) => {
          ui.remove();
          btn.classList.remove('working');
          if (blocked) return;  // _reRouteSegments already announced why
          _editPoints = points;
          _selectedEditNodeIdx.clear();  // re-routing regenerates the whole point list
          _renderEditLayers();
          const found = _liveHazardCheck();
          if (!found.length) {
            if (fallbacks > 0) _showRouteFallbackWarning(fallbackSegs);
            else setStatus('Re-routed.');
          }
        })
        .catch(err => {
          ui.remove();
          btn.classList.remove('working');
          setStatus('Re-route failed.');
          console.error('[reroute-btn]', err);
        });
    } else {
      const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
      const idx = (_ctxRouteIdx >= 0 && routes[_ctxRouteIdx]) ? _ctxRouteIdx
                : parseInt(document.getElementById('track-route-select').value);
      if (isNaN(idx) || !routes[idx]) { alert('Select a route first.'); return; }
      btn.classList.add('working');
      const ui = _showRerouteOverlay(routes[idx].points);
      _reRouteSegments(routes[idx].points, ui.update.bind(ui), ui.setText.bind(ui))
        .then(({ points, fallbacks, fallbackSegs, blocked }) => {
          ui.remove();
          btn.classList.remove('working');
          if (blocked) return;  // _reRouteSegments already announced why
          routes[idx].points = points;
          _touch(routes[idx]);
          localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
          const found = _enterEditMode(idx);
          if (!found.length) {
            if (fallbacks > 0) _showRouteFallbackWarning(fallbackSegs);
            else setStatus('Re-routed.');
          }
        })
        .catch(err => {
          ui.remove();
          btn.classList.remove('working');
          setStatus('Re-route failed.');
          console.error('[reroute-btn]', err);
        });
    }
  });
  document.getElementById('delete-route-btn').addEventListener('click', () => {
    if (!_editMode) return;
    const name = _editRouteName;
    const idx  = _editRouteIdx;
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    _exitEditMode();
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    _tombstone(routes[idx]?.id, 'route');
    routes.splice(idx, 1);
    localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
    _refreshSavedRouteLayers();
    _populateRouteSelectFn?.();
    const msg = `${name} deleted.`;
    setStatus(msg);
    TTS.sayImmediate(msg);
  });

  document.getElementById('rp-close').addEventListener('click', _closeRoutePicker);

  // Strip a trailing "(conflict copy)" / "(conflict copy N)" suffix — matches
  // the naming sync_merge.js's mergeCollections() uses, so duplicates created
  // by a sync (including the pre-v358 unbounded-growth bug) can be found.
  function _baseRouteName(name) {
    return name.replace(/ \(conflict copy(?: \d+)?\)$/, '');
  }

  document.getElementById('rp-cleanup-dupes').addEventListener('click', () => {
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');

    // Group by base name, then within each group cluster by identical points —
    // only byte-identical duplicates are candidates for removal. Two routes
    // that share a base name but have genuinely different points are a real,
    // distinct conflict, not a duplicate, and are left untouched.
    const byBaseName = new Map();
    for (const r of routes) {
      const base = _baseRouteName(r.name);
      if (!byBaseName.has(base)) byBaseName.set(base, []);
      byBaseName.get(base).push(r);
    }

    const toRemove = [];
    for (const [base, group] of byBaseName) {
      if (group.length < 2) continue;
      const byPoints = new Map();
      for (const r of group) {
        const key = JSON.stringify(r.points);
        if (!byPoints.has(key)) byPoints.set(key, []);
        byPoints.get(key).push(r);
      }
      for (const dupes of byPoints.values()) {
        if (dupes.length < 2) continue;
        // Keep one: prefer the plain base name (no "(conflict copy...)"
        // suffix) if present, otherwise the oldest by updatedAt.
        dupes.sort((a, b) => {
          const aIsBase = a.name === base, bIsBase = b.name === base;
          if (aIsBase !== bIsBase) return aIsBase ? -1 : 1;
          return (a.updatedAt || 0) - (b.updatedAt || 0);
        });
        for (let i = 1; i < dupes.length; i++) toRemove.push(dupes[i]);
      }
    }

    if (!toRemove.length) {
      const msg = 'No duplicate routes found.';
      setStatus(msg); TTS.sayImmediate(msg);
      return;
    }

    const preview = toRemove.slice(0, 8).map(r => r.name).join(', ');
    const more = toRemove.length > 8 ? `, and ${toRemove.length - 8} more` : '';
    if (!confirm(
      `Remove ${toRemove.length} duplicate route${toRemove.length !== 1 ? 's' : ''}? ` +
      `Keeps one copy of each.\n\n${preview}${more}\n\nThis cannot be undone.`
    )) return;

    const removeIds = new Set(toRemove.map(r => r.id));
    toRemove.forEach(r => _tombstone(r.id, 'route'));
    const kept = routes.filter(r => !removeIds.has(r.id));
    localStorage.setItem(ROUTE_KEY, JSON.stringify(kept));

    const keptNames = new Set(kept.map(r => r.name));
    for (const name of [..._hiddenRouteNames]) if (!keptNames.has(name)) _hiddenRouteNames.delete(name);
    _saveHiddenRoutes();
    const lastRoute = localStorage.getItem('audiochart-last-route');
    if (lastRoute && !keptNames.has(lastRoute)) localStorage.removeItem('audiochart-last-route');
    if (_expandedRouteRowName && !keptNames.has(_expandedRouteRowName)) _expandedRouteRowName = null;

    _refreshSavedRouteLayers();
    _populateRouteSelectFn?.();
    _buildRoutePickerPanel();
    const msg = `Removed ${toRemove.length} duplicate route${toRemove.length !== 1 ? 's' : ''}.`;
    setStatus(msg);
    TTS.sayImmediate(msg);
  });

  document.getElementById('rp-draw-route').addEventListener('click', () => {
    _closeRoutePicker();
    _enterDrawRouteMode();
  });
  document.getElementById('rp-sketch').addEventListener('click', () => {
    _closeRoutePicker();
    _enterSketchMode();
  });
  document.getElementById('rp-search').addEventListener('input', _buildRoutePickerPanel);
  document.getElementById('rp-show-all').addEventListener('click', () => {
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    routes.forEach(r => _hiddenRouteNames.delete(r.name));
    _saveHiddenRoutes();
    _refreshSavedRouteLayers();
    _buildRoutePickerPanel();
    // Bring every now-visible route into view — otherwise "All" just un-hides them
    // without actually showing them if they're outside the current map viewport,
    // defeating the point of browsing the map to find one you've forgotten the name of.
    const allPts = routes.flatMap(r => (r.points || []).map(p => [p.lat, p.lon]));
    if (allPts.length > 1) _map.fitBounds(L.latLngBounds(allPts).pad(0.15));
  });
  document.getElementById('rp-hide-all').addEventListener('click', () => {
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    routes.forEach(r => _hiddenRouteNames.add(r.name));
    _saveHiddenRoutes();
    _refreshSavedRouteLayers();
    _buildRoutePickerPanel();
  });
  document.getElementById('rp-hide-unselected').addEventListener('click', () => {
    if (_selectedRouteIdx < 0) {
      const msg = 'No route selected — long-press a route on the map first.';
      setStatus(msg); TTS.sayImmediate(msg);
      return;
    }
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    const keepName = routes[_selectedRouteIdx]?.name;
    routes.forEach(r => { if (r.name !== keepName) _hiddenRouteNames.add(r.name); });
    _saveHiddenRoutes();
    _refreshSavedRouteLayers();
    _buildRoutePickerPanel();
  });
  _map.on('click', _closeRoutePicker);

  // ◎ Track picker panel
  const _trackPickerBtn   = document.getElementById('track-picker-btn');
  const _trackPickerPanel = document.getElementById('track-picker-panel');
  const _closeTrackPicker = () => {
    _trackPickerPanel.classList.remove('open');
    _trackPickerBtn.classList.remove('active');
  };
  _addSwipeToClose(_trackPickerPanel, _closeTrackPicker, 'x', '.nf-title');
  _makeDraggable(_trackPickerPanel, _trackPickerPanel.querySelector('.nf-title'));

  function _buildTrackPickerPanel() {
    DriveSync.maybeAutoSync();
    const list  = document.getElementById('tp-track-list');
    const query = document.getElementById('tp-search').value || '';
    const tracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
    list.innerHTML = '';
    const filtered = tracks.filter(t => _itemMatchesSearch(t, query))
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rp-empty';
      empty.textContent = tracks.length === 0 ? 'No saved tracks.' : 'No tracks match.';
      list.appendChild(empty);
      return;
    }
    filtered.forEach(track => {
      const first = track.points?.[0];
      const last  = track.points?.[track.points.length - 1];
      const startName = first ? (_nearestPlaceName(first.lat, first.lon) || `${first.lat.toFixed(3)},${first.lon.toFixed(3)}`) : '';
      const endName   = last  ? (_nearestPlaceName(last.lat,  last.lon)  || `${last.lat.toFixed(3)},${last.lon.toFixed(3)}`)   : '';
      const hidden = _hiddenTrackNames.has(track.name);
      const expanded = track.name === _expandedTrackRowName;
      const row = document.createElement('button');
      row.className = 'rp-row' + (hidden ? ' hidden' : '') + (expanded ? ' expanded' : '');
      const nameLine = document.createElement('div');
      nameLine.className = 'rp-row-name';
      const nameText = document.createElement('span');
      nameText.textContent = track.name;
      nameLine.appendChild(nameText);
      const delBtn = document.createElement('button');
      delBtn.className = 'rp-delete-btn';
      delBtn.textContent = '×';
      delBtn.title = 'Delete track';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Delete track "${track.name}"?`)) return;
        const all = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
        _tombstone(track.id, 'track');
        localStorage.setItem(TRACK_KEY, JSON.stringify(all.filter(t => t.name !== track.name)));
        _hiddenTrackNames.delete(track.name);
        _saveHiddenTracks();
        if (_expandedTrackRowName === track.name) _expandedTrackRowName = null;
        _refreshSavedTrackLayers();
        _buildTrackPickerPanel();
      });
      nameLine.appendChild(delBtn);
      nameLine.appendChild(_buildRpCornerButtons(row, track.name, () => track.points, (newName) => {
        const tracks2 = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
        const idx = tracks2.findIndex(t => t.name === track.name);
        if (idx < 0) return;
        const oldName = tracks2[idx].name;
        tracks2[idx].name = newName;
        _touch(tracks2[idx]);
        localStorage.setItem(TRACK_KEY, JSON.stringify(tracks2));
        if (_hiddenTrackNames.has(oldName)) { _hiddenTrackNames.delete(oldName); _hiddenTrackNames.add(newName); }
        _saveHiddenTracks();
        if (_expandedTrackRowName === oldName) _expandedTrackRowName = newName;
        _refreshSavedTrackLayers();
        _buildTrackPickerPanel();
      }));
      row.appendChild(nameLine);
      if (startName || endName) {
        const placeLine = document.createElement('div');
        placeLine.className = 'rp-row-places';
        placeLine.textContent = startName + (endName && endName !== startName ? ' → ' + endName : '');
        row.appendChild(placeLine);
      }
      row.addEventListener('click', () => {
        if (_hiddenTrackNames.has(track.name)) {
          _hiddenTrackNames.delete(track.name);
        } else {
          _hiddenTrackNames.add(track.name);
        }
        _saveHiddenTracks();
        _expandedTrackRowName = (_expandedTrackRowName === track.name) ? null : track.name;
        _refreshSavedTrackLayers();
        _buildTrackPickerPanel();
      });
      list.appendChild(row);
    });
  }

  _trackPickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !_trackPickerPanel.classList.contains('open');
    _trackPickerPanel.classList.toggle('open');
    _trackPickerBtn.classList.toggle('active', opening);
    if (opening) _buildTrackPickerPanel();
  });

  document.getElementById('tp-close').addEventListener('click', _closeTrackPicker);
  document.getElementById('tp-search').addEventListener('input', _buildTrackPickerPanel);
  document.getElementById('tp-show-all').addEventListener('click', () => {
    const tracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
    tracks.forEach(t => _hiddenTrackNames.delete(t.name));
    _saveHiddenTracks();
    _refreshSavedTrackLayers();
    _buildTrackPickerPanel();
  });
  document.getElementById('tp-hide-all').addEventListener('click', () => {
    const tracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
    tracks.forEach(t => _hiddenTrackNames.add(t.name));
    _saveHiddenTracks();
    _refreshSavedTrackLayers();
    _buildTrackPickerPanel();
  });
  _map.on('click', _closeTrackPicker);

  // ☁ Drive sync — shared between the Routes and Tracks panels (one backup blob covers both).
  // A single Sync action merges local and remote; nothing here ever wholesale-overwrites
  // either side, so there's no "wrong direction" to accidentally pick (see sync_merge.js).
  (function _wireDriveSyncUI() {
    const statusEls = [document.getElementById('rp-sync-status'), document.getElementById('tp-sync-status')];
    const wifiCheckboxes = [document.getElementById('rp-wifi-sync'), document.getElementById('tp-wifi-sync')];
    const setStatus = (text) => statusEls.forEach(el => { if (el) el.textContent = text; });
    const refreshLastSynced = () => {
      const last = DriveSync.getLastSyncMs();
      setStatus(last ? `Last synced ${new Date(last).toLocaleString()}` : 'Not yet synced to Drive.');
    };
    wifiCheckboxes.forEach(cb => { if (cb) cb.checked = DriveSync.getWifiSyncEnabled(); });
    refreshLastSynced();

    wifiCheckboxes.forEach(cb => {
      if (!cb) return;
      cb.addEventListener('change', () => {
        DriveSync.setWifiSyncEnabled(cb.checked);
        wifiCheckboxes.forEach(other => { if (other) other.checked = cb.checked; });
      });
    });

    function _reconcileHiddenNamesAfterMerge(routes, tracks) {
      const routeNames = new Set(routes.map(r => r.name));
      const trackNames = new Set(tracks.map(t => t.name));
      let routesChanged = false, tracksChanged = false;
      for (const n of [..._hiddenRouteNames]) if (!routeNames.has(n)) { _hiddenRouteNames.delete(n); routesChanged = true; }
      for (const n of [..._hiddenTrackNames]) if (!trackNames.has(n)) { _hiddenTrackNames.delete(n); tracksChanged = true; }
      if (routesChanged) _saveHiddenRoutes();
      if (tracksChanged) _saveHiddenTracks();
      const lastRoute = localStorage.getItem('audiochart-last-route');
      if (lastRoute && !routeNames.has(lastRoute)) localStorage.removeItem('audiochart-last-route');
    }

    [document.getElementById('rp-sync-now'), document.getElementById('tp-sync-now')].forEach(btn => {
      if (!btn) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setStatus('Syncing…');
        DriveSync.runMerge()
          .then(({ routeCount, trackCount, conflictCount }) => {
            const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
            const tracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
            _reconcileHiddenNamesAfterMerge(routes, tracks);
            _refreshSavedRouteLayers();
            _refreshSavedTrackLayers();
            _populateRouteSelectFn?.();
            if (_routePickerPanel.classList.contains('open')) _buildRoutePickerPanel();
            if (_trackPickerPanel.classList.contains('open')) _buildTrackPickerPanel();
            setStatus(conflictCount > 0
              ? `Synced — ${routeCount} routes, ${trackCount} tracks, ${conflictCount} conflict cop${conflictCount === 1 ? 'y' : 'ies'} (review in the list)`
              : `Synced — ${routeCount} routes, ${trackCount} tracks, up to date`);
          })
          .catch(err => setStatus(err.message || 'Sync failed.'));
      });
    });
  })();

  // Keep panel in sync after route changes — called from _populateRouteSelect below
  const _rebuildPickerIfOpen = () => {
    if (_routePickerPanel.classList.contains('open')) _buildRoutePickerPanel();
  };

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
    _routesNearSubmenu.style.display = 'none';
    _tracksNearSubmenu.style.display = 'none';
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
  const _routesNearSubmenu = document.getElementById('map-ctx-routes-near-submenu');
  const _tracksNearSubmenu = document.getElementById('map-ctx-tracks-near-submenu');
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
    _rebuildPickerIfOpen();
  }
  _populateRouteSelectFn = _populateRouteSelect;
  _buildRoutePickerPanelFn = _buildRoutePickerPanel;
  _buildTrackPickerPanelFn = _buildTrackPickerPanel;

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
      _touch(routes[routeIdx]);
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
    _routesNearSubmenu.style.display = 'none';
    _tracksNearSubmenu.style.display = 'none';
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
    const cx = e.originalEvent.clientX, cy = e.originalEvent.clientY;
    const x  = Math.min(cx, window.innerWidth  - mw - 4);
    const y  = (cy + mh + 4 > window.innerHeight) ? Math.max(4, cy - mh) : cy;
    _ctxMenu.style.left = Math.max(4, x) + 'px';
    _ctxMenu.style.top  = Math.max(4, y) + 'px';
  });
  // Keep menu inside viewport when submenus expand
  new ResizeObserver(() => {
    if (_ctxMenu.style.display !== 'block') return;
    const rect = _ctxMenu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 4)
      _ctxMenu.style.top = Math.max(4, window.innerHeight - rect.height - 4) + 'px';
    if (rect.right > window.innerWidth - 4)
      _ctxMenu.style.left = Math.max(4, window.innerWidth - rect.width - 4) + 'px';
  }).observe(_ctxMenu);
  _map.on('movestart zoomstart', _hideCtx);
  _map.on('click', () => {
    if (_editMode || _sketchMode || _selectedRouteIdx < 0) return;
    _selectedRouteIdx = -1;
    if (_hazardCheckLayer) { _hazardCheckLayer.clearLayers(); _hazardCheckLayer = null; }
    _refreshSavedRouteLayers();
  });
  document.addEventListener('click', (e) => { if (!_ctxMenu.contains(e.target)) _hideCtx(); }, { capture: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { _hideCtx(); if (_addNodeMode) _cancelAddNodeMode(); if (_simTrackMode) _exitSimTrackMode(); }
  });

  document.getElementById('map-ctx-objects-parent').addEventListener('click', () => {
    _ctxSubmenu.style.display = _ctxSubmenu.style.display === 'block' ? 'none' : 'block';
  });

  _ctxSubmenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-radius-nm]');
    if (!btn) return;
    _hideCtx();
    if (_ctxLatLng) handleMapLongPress(_ctxLatLng, parseFloat(btn.dataset.radiusNm), btn.dataset.radiusLabel);
  });

  document.getElementById('map-ctx-routes-near-parent').addEventListener('click', () => {
    _routesNearSubmenu.style.display = _routesNearSubmenu.style.display === 'block' ? 'none' : 'block';
  });

  _routesNearSubmenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-radius-nm]');
    if (!btn) return;
    _hideCtx();
    if (_ctxLatLng) _showNearPointPanel('route', _ctxLatLng, _routesNearPoint(_ctxLatLng.lat, _ctxLatLng.lng, parseFloat(btn.dataset.radiusNm)), btn.dataset.radiusLabel);
  });

  document.getElementById('map-ctx-tracks-near-parent').addEventListener('click', () => {
    _tracksNearSubmenu.style.display = _tracksNearSubmenu.style.display === 'block' ? 'none' : 'block';
  });

  _tracksNearSubmenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-radius-nm]');
    if (!btn) return;
    _hideCtx();
    if (_ctxLatLng) _showNearPointPanel('track', _ctxLatLng, _tracksNearPoint(_ctxLatLng.lat, _ctxLatLng.lng, parseFloat(btn.dataset.radiusNm)), btn.dataset.radiusLabel);
  });

  document.getElementById('map-ctx-route-parent').addEventListener('click', () => {
    _routeSubmenu.style.display = _routeSubmenu.style.display === 'block' ? 'none' : 'block';
  });

  document.getElementById('map-ctx-draw-route').addEventListener('click', () => {
    _hideCtx();
    _enterDrawRouteMode();
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
    _tombstone(deleted.id, 'route');
    localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
    _refreshSavedRouteLayers();
    const msg = `${deleted.name} deleted.`;
    setStatus(msg);
    TTS.sayImmediate(msg);
  });

  document.getElementById('map-ctx-route-clear-all').addEventListener('click', () => {
    _hideCtx();
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    if (!routes.length) { TTS.sayImmediate('No routes saved.'); return; }
    if (!confirm(`Delete all ${routes.length} route${routes.length > 1 ? 's' : ''}?`)) return;
    routes.forEach(r => _tombstone(r.id, 'route'));
    localStorage.setItem(ROUTE_KEY, JSON.stringify([]));
    _refreshSavedRouteLayers();
    _populateRouteSelectFn?.();
    const msg = 'All routes cleared.';
    setStatus(msg);
    TTS.sayImmediate(msg);
  });

  async function _triggerAutoRoute() {
    if (!_autoRouteStart || !_autoRouteEnd) return;
    const name  = _autoRouteName;
    const start = _autoRouteStart;
    const end   = _autoRouteEnd;
    if (await _blockedByCoverage(start, end, 'Auto Route')) return;
    setStatus(`Planning "${name}"…`);

    if (_autoRoutePreviewLayer) { _autoRoutePreviewLayer.remove(); _autoRoutePreviewLayer = null; }
    _autoRoutePreviewLayer = L.polyline(
      [[start.lat, start.lon], [end.lat, end.lon]],
      { color: '#3399ff', weight: 3, dashArray: '8 6', opacity: 0.9 }
    ).addTo(_map);

    const optOverlay = document.createElement('div');
    optOverlay.className = 'optimizing-overlay';
    optOverlay.innerHTML =
      '<span class="optimizing-boat">&#9975;</span>' +
      '<em class="optimizing-text">Optimizing&#8230;</em>';
    _map.getContainer().appendChild(optOverlay);

    let pts;
    try {
      pts = await _autoRouteProg(start, end,
        (path) => _autoRoutePreviewLayer.setLatLngs(path.map(p => [p.lat, p.lon])),
        (t) => { const el = optOverlay.querySelector('.optimizing-text'); if (el) el.textContent = t; }
      );
    } catch (err) {
      optOverlay.remove();
      console.error('[autoRoute] error:', err);
      setStatus(`Auto-route error: ${err.message}`);
      return;
    }

    optOverlay.remove();

    const totalNm = pts.reduce((sum, p, idx) =>
      idx === 0 ? 0 : sum + Query.distanceNm(pts[idx - 1].lon, pts[idx - 1].lat, p.lon, p.lat), 0);

    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    routes.push(_stampNew({ name, points: pts.map(p => ({ lat: p.lat, lon: p.lon })) }));
    localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
    const newIdx = routes.length - 1;

    _populateRouteSelectFn?.();
    _clearAutoRoute();
    // Same gap as _onDrawConfirm: this entry point previously spoke "X
    // planned" via TTS even when autoRoute had silently given up and
    // returned the raw straight line — actively announcing false success,
    // worse than staying silent. See the matching comment there.
    const fellBack = pts.length <= 2 && Query.landBlocks(pts[0].lon, pts[0].lat, pts[1].lon, pts[1].lat);
    const found = _enterEditMode(newIdx);

    if (fellBack && !found.length) {
      _showRouteFallbackWarning([{ a: pts[0], b: pts[1] }]);
    } else if (!found.length) {
      const msg = `${name} planned — ${totalNm.toFixed(1)} nm.`;
      setStatus(msg);
      TTS.sayImmediate(`${name} planned. ${totalNm.toFixed(1)} nautical miles.`);
    }
  }

  document.getElementById('map-ctx-route-from-here').addEventListener('click', () => {
    _hideCtx();
    if (!_ctxLatLng) return;
    const name = prompt('Name for this planned route:', _nextRouteName());
    if (!name) return;
    _autoRouteName  = name;
    _autoRouteStart = { lat: _ctxLatLng.lat, lon: _ctxLatLng.lng };
    if (_autoRouteStartMarker) _autoRouteStartMarker.remove();
    _autoRouteStartMarker = L.circleMarker([_ctxLatLng.lat, _ctxLatLng.lng], {
      radius: 8, color: '#00cc44', fillColor: '#00cc44', fillOpacity: 0.8, weight: 2,
    }).addTo(_map).bindTooltip(`${name} — start`, { permanent: false });
    if (_autoRouteEnd) {
      _triggerAutoRoute();
    } else {
      setStatus(`"${name}" start set — right-click map → "Route to here".`);
    }
  });

  document.getElementById('map-ctx-route-to-here').addEventListener('click', () => {
    _hideCtx();
    if (!_ctxLatLng) return;
    _autoRouteEnd = { lat: _ctxLatLng.lat, lon: _ctxLatLng.lng };
    if (_autoRouteEndMarker) _autoRouteEndMarker.remove();
    _autoRouteEndMarker = L.circleMarker([_ctxLatLng.lat, _ctxLatLng.lng], {
      radius: 8, color: '#cc2200', fillColor: '#cc2200', fillOpacity: 0.8, weight: 2,
    }).addTo(_map).bindTooltip(`${_autoRouteName || 'Route'} — destination`, { permanent: false });
    if (!_autoRouteStart) {
      setStatus('Destination set — right-click map → "Route from here" to plan route.');
      return;
    }
    _triggerAutoRoute();
  });

  const _visParent  = document.getElementById('map-ctx-route-vis-parent');
  const _visList    = document.getElementById('map-ctx-route-vis-list');
  _visParent.addEventListener('click', () => {
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    _visList.innerHTML = '';
    routes.forEach((route) => {
      const hidden = _hiddenRouteNames.has(route.name);
      const btn = document.createElement('button');
      btn.textContent = (hidden ? '✗ ' : '✓ ') + route.name;
      btn.style.paddingLeft = '36px';
      btn.style.fontSize = '0.85rem';
      btn.style.color = hidden ? 'var(--danger)' : 'var(--text-dim)';
      btn.addEventListener('click', () => {
        if (_hiddenRouteNames.has(route.name)) {
          _hiddenRouteNames.delete(route.name);
        } else {
          _hiddenRouteNames.add(route.name);
        }
        _saveHiddenRoutes();
        _refreshSavedRouteLayers();
        _hideCtx();
      });
      _visList.appendChild(btn);
    });
    _visList.style.display = _visList.style.display === 'block' ? 'none' : 'block';
  });

  document.getElementById('map-ctx-route-rename').addEventListener('click', () => {
    _hideCtx();
    const sel    = document.getElementById('track-route-select');
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    const idx    = (_selectedRouteIdx >= 0 && routes[_selectedRouteIdx]) ? _selectedRouteIdx
                 : (_ctxRouteIdx >= 0 && routes[_ctxRouteIdx]) ? _ctxRouteIdx
                 : parseInt(sel.value);
    if (isNaN(idx) || !routes[idx]) {
      alert('Select a route in the Track panel first, then rename.');
      return;
    }
    const newName = prompt('Rename route:', routes[idx].name);
    if (!newName || !newName.trim()) return;
    const oldName = routes[idx].name;
    routes[idx].name = newName.trim();
    _touch(routes[idx]);
    localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
    localStorage.setItem('audiochart-last-route', newName.trim());
    _hiddenRouteNames.delete(oldName);
    _saveHiddenRoutes();
    _populateRouteSelect();
    const newIdx = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]')
      .findIndex(r => r.name === newName.trim());
    if (newIdx >= 0) sel.value = String(newIdx);
  });

  document.getElementById('map-ctx-route-edit').addEventListener('click', () => {
    _hideCtx();
    const sel    = document.getElementById('track-route-select');
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    const idx    = (_selectedRouteIdx >= 0 && routes[_selectedRouteIdx]) ? _selectedRouteIdx
                 : (_ctxRouteIdx >= 0 && routes[_ctxRouteIdx]) ? _ctxRouteIdx
                 : parseInt(sel.value);
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

  // Show the track submenu as a standalone floating panel (bypasses context menu).
  function _openAnimSettings(nearEl) {
    if (_trackSubmenu._standalone) { _closeAnimSettings(); return; }
    _populateRouteSelect();
    _trackSubmenu.style.cssText +=
      ';position:fixed;z-index:10000;background:var(--dark-blue)' +
      ';border:1px solid var(--mid-blue);border-radius:6px' +
      ';box-shadow:0 2px 12px rgba(0,0,0,0.7);max-height:92dvh;overflow-y:auto';
    _trackSubmenu.style.display = 'block';
    _trackSubmenu._standalone = true;
    const mw = _trackSubmenu.offsetWidth, mh = _trackSubmenu.offsetHeight;
    const anchor = nearEl ? nearEl.getBoundingClientRect() : null;
    const left = anchor ? Math.min(anchor.right - mw, window.innerWidth  - mw - 4) : 4;
    const top  = anchor ? Math.max(4, anchor.top  - mh - 4)                        : 4;
    _trackSubmenu.style.left = Math.max(4, left) + 'px';
    _trackSubmenu.style.top  = Math.max(4, top)  + 'px';
  }

  function _closeAnimSettings() {
    if (!_trackSubmenu._standalone) return;
    _trackSubmenu.style.position = '';
    _trackSubmenu.style.zIndex   = '';
    _trackSubmenu.style.background = '';
    _trackSubmenu.style.border   = '';
    _trackSubmenu.style.borderRadius = '';
    _trackSubmenu.style.boxShadow = '';
    _trackSubmenu.style.maxHeight = '';
    _trackSubmenu.style.overflowY = '';
    _trackSubmenu.style.display  = 'none';
    _trackSubmenu._standalone = false;
  }

  document.getElementById('anim-settings-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    _openAnimSettings(this);
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
      Query.setActiveWaypoint(lat, lon, name);
      if (!_waypointsVisible) _setWaypointsVisible(true);
      showWaypointMap(null, null, loadUserWaypoints()).catch(() => {});
      const msg = `Waypoint ${name} set — that's now the Active Waypoint.`;
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

  document.getElementById('rp-import-file').addEventListener('click', () => {
    _gpxMode = 'routes';
    _gpxInput.multiple = false;
    _gpxInput.value = '';
    _gpxInput.click();
  });

  document.getElementById('rp-import-drive').addEventListener('click', () => {
    setStatus('Opening Drive…');
    openDriveImportPicker((text) => _importGpxFromText(text, 'routes'))
      .catch(err => setStatus(err.message || 'Could not open Drive.'));
  });

  _gpxInput.addEventListener('change', () => {
    if (_gpxMode === 'combine') {
      _combineGpxRoutes([..._gpxInput.files]);
      return;
    }
    const file = _gpxInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => _importGpxFromText(ev.target.result, _gpxMode);
    reader.readAsText(file);
  });

  // Shared by local-file import (above) and Drive import (_wireDriveImportUI).
  function _importGpxFromText(text, mode) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror') || !doc.querySelector('gpx')) {
      const msg = "That file doesn't look like a GPX route file.";
      setStatus(msg); TTS.sayImmediate(msg);
      return;
    }
    if (mode === 'markers') _importGpxMarkers(doc);
    else                    _importGpxRoutes(doc);
  }

  // Web Share Target (Android): sw.js intercepted a shared-GPX POST, stashed
  // the file text in Cache Storage, and 303-redirected here with
  // ?shared-gpx=1. A fresh navigation can't retain the POST body or reach
  // into the previous page's JS (app.js is a module — _importGpxFromText
  // isn't on window), so this is the pickup side of that handoff. Runs once,
  // since _ensureMap()'s body only executes on its first call (at startup).
  if (new URLSearchParams(location.search).get('shared-gpx') === '1') {
    _importSharedGpx();
  }

  async function _importSharedGpx() {
    history.replaceState(null, '', location.pathname); // strip flag first — no re-import on refresh
    try {
      const cache = await caches.open('audiochart-share-target');
      const hit = await cache.match('./shared-gpx-payload');
      if (!hit) {
        const msg = 'No shared file found.';
        setStatus(msg); TTS.sayImmediate(msg);
        return;
      }
      const text = await hit.text();
      await cache.delete('./shared-gpx-payload');
      if (!text.trim()) {
        const msg = 'Shared file was empty.';
        setStatus(msg); TTS.sayImmediate(msg);
        return;
      }
      _importGpxFromText(text, 'routes');
    } catch (e) {
      const msg = 'Could not read shared file.';
      setStatus(msg); TTS.sayImmediate(msg);
    }
  }

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

  // Never silently collide with an existing route name (e.g. Navionics and
  // AudioChart both happening to have a "109") — append a distinguishing
  // suffix instead, since a name match doesn't mean it's the same route.
  function _uniqueRouteName(name, existingNames) {
    if (!existingNames.has(name)) return name;
    let n = 2;
    while (existingNames.has(`${name} (Imported${n > 2 ? ' ' + n : ''})`)) n++;
    return `${name} (Imported${n > 2 ? ' ' + n : ''})`;
  }

  function _importGpxRoutes(doc) {
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    const existingNames = new Set(routes.map(r => r.name));
    let count = 0;
    for (const rte of doc.querySelectorAll('rte')) {
      const rawName = rte.querySelector('name')?.textContent?.trim() || `Route ${routes.length + count + 1}`;
      const name   = _uniqueRouteName(rawName, existingNames);
      const points = [...rte.querySelectorAll('rtept')].map(pt => ({
        lat: parseFloat(pt.getAttribute('lat')),
        lon: parseFloat(pt.getAttribute('lon')),
        ...(pt.querySelector('extensions > overnight')?.textContent?.trim() === 'true' ? { overnight: true } : {}),
      })).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
      if (!points.length) continue;
      routes.push(_stampNew({ name, points }));
      existingNames.add(name);
      count++;
    }
    for (const trk of doc.querySelectorAll('trk')) {
      const rawName = trk.querySelector('name')?.textContent?.trim() || `Route ${routes.length + count + 1}`;
      const name   = _uniqueRouteName(rawName, existingNames);
      const points = [...trk.querySelectorAll('trkpt')].map(pt => ({
        lat: parseFloat(pt.getAttribute('lat')),
        lon: parseFloat(pt.getAttribute('lon')),
        ...(pt.querySelector('extensions > overnight')?.textContent?.trim() === 'true' ? { overnight: true } : {}),
      })).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
      if (!points.length) continue;
      routes.push(_stampNew({ name, points }));
      existingNames.add(name);
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
          const overnight = pt.querySelector('extensions > overnight')?.textContent?.trim() === 'true';
          if (!isNaN(lat) && !isNaN(lon)) allPoints.push(overnight ? { lat, lon, overnight: true } : { lat, lon });
        }
      }
      if (!allPoints.length) { TTS.sayImmediate('No route points found.'); return; }
      const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
      routes.push(_stampNew({ name: 'Combined Route', points: allPoints }));
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

  document.getElementById('map-ctx-set-focus').addEventListener('click', () => {
    _hideCtx();
    if (!_ctxLatLng) return;
    _enterFocusPlaceMode(_ctxLatLng);
  });

  _refreshWaypointLayer();
  _refreshYouLayer();
  _syncFocusMarker();
  _updateFocusRay();
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
           <button class="navaid-popup-focus">&#127919; Set focus</button>
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
        el.querySelector('.navaid-popup-focus').addEventListener('click', () => {
          _map.closePopup();
          Query.setFocus(lat, lon, n.name, 'place');
          _updateFocusButton();
          const msg = `Focused on ${n.name}.`;
          showResponse(msg);
          TTS.sayImmediate(msg);
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
    // This is the big one — a rock-strewn stretch of coast (Penobscot Bay
    // easily has hundreds of charted point hazards) shows every one of them
    // in the current viewport with no radius limit, unlike the small-radius
    // query overlays. Route it through the same clustering helper as those
    // so a dense field of triangles reads as smooth yellow blobs instead of
    // an unreadable pile, not just the transient query popups.
    const hazardPts = [];
    for (const f of Query.hazards.features) {
      // DEPARE features are now polygons — skip them here (shown by Depths layer)
      if (f.geometry.type !== 'Point') continue;
      const [lon, lat] = f.geometry.coordinates;
      if (!bounds.contains([lat, lon])) continue;
      const label = f.properties.label || f.properties.objtype || 'hazard';
      const name  = f.properties.name || label;
      hazardPts.push({ lat, lon, label, name });
    }
    const hazardLayer = L.layerGroup();
    _renderClusteredHazards(_map, hazardLayer, hazardPts, (h) => {
      const m = L.marker([h.lat, h.lon], { icon: _hazardMarkerIcon() });
      m.bindTooltip(h.name, { permanent: false, direction: 'top', className: 'map-tooltip' });
      return m;
    });
    markers.push(hazardLayer);
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

  const hazardLayer = L.layerGroup();
  _renderClusteredHazards(_map, hazardLayer, hazardPts, (h) => {
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
    return marker;
  });

  _mapLayers = L.layerGroup([hazardLayer]).addTo(_map);
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
  const hazardLayer = L.layerGroup();
  _renderClusteredHazards(_map, hazardLayer, hazardPts || [], (h) => {
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
    return m;
  });
  layers.push(hazardLayer);

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
  'browser':       'DEVICE GPS',
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

// Tracks which coverage tier the boat is currently in, so we only speak up
// on a real transition (not every GPS tick) — see _updateCoverageStatus.
let _coverageLevel = null;

const COVERAGE_MESSAGES = {
  land: 'Limited chart data here — land avoidance only, no hazard or navaid detail. Auto Route and Re-route are unavailable; Sketch still works.',
  none: 'No chart data for this area. Auto Route, Re-route, and hazard checking are unavailable here; Sketch still works but is not checked against real charts.',
};

/**
 * Reflects current position against loaded chart coverage — see
 * Query.coverageLevelAt. Runs on every position fix (cheap: memoized bbox
 * lookup, no rescans) but only updates the badge/speaks on a real change,
 * so it doesn't nag on every GPS tick while sitting outside coverage.
 */
let _coverageRecheckTimer = null;
let _coverageRecheckCount = 0;
const COVERAGE_RECHECK_MAX = 3; // ~6s of retries — enough for a slow fetch, not an indefinite poll for someone genuinely out of range
function _updateCoverageStatus(lat, lon, _isRecheck = false) {
  if (!_isRecheck) _coverageRecheckCount = 0;  // a real position update, not a self-retry — start fresh
  const level = Query.coverageLevelAt(lon, lat);

  // The relevant hazard/navaid data for a NEW position (server-bridge mode
  // re-fetches "nearby" data per position) can still be in flight when this
  // first runs — "is any core data loaded at all" isn't a reliable signal
  // for that, since stale data from a previous position already satisfies
  // it. A real GPS watch self-corrects within a second or two as fixes keep
  // arriving regardless, but a one-shot test position or a slow first fix
  // could otherwise get stuck showing a falsely-degraded badge. Take a
  // handful of unconditional re-checks shortly after any non-core result
  // rather than trying to detect readiness precisely — capped so someone
  // genuinely out of range (e.g. cruising far outside coverage) doesn't
  // leave a timer polling every 2s for the rest of the voyage.
  if (level !== 'core' && !_coverageRecheckTimer && _coverageRecheckCount < COVERAGE_RECHECK_MAX) {
    _coverageRecheckCount++;
    _coverageRecheckTimer = setTimeout(() => {
      _coverageRecheckTimer = null;
      _updateCoverageStatus(lat, lon, true);
    }, 2000);
  }

  if (level === _coverageLevel) return;
  const prevLevel = _coverageLevel;
  _coverageLevel = level;

  if (level === 'core') {
    coverageStatusEl.style.display = 'none';
  } else {
    coverageStatusEl.style.display = 'inline-block';
    coverageStatusEl.className = `status-badge coverage-${level}`;
    coverageStatusEl.textContent = level === 'land' ? '⚠ Limited chart data' : '⚠ No chart data';
  }

  // Don't announce the very first "core" resolution on a normal in-coverage
  // start (prevLevel === null) — only speak up on an actual degrade/recover.
  if (prevLevel !== null || level !== 'core') {
    const msg = COVERAGE_MESSAGES[level] || 'Chart data available — full hazard and navaid checking restored.';
    setStatus(msg);
    TTS.sayImmediate(msg);
  }
}

function showPosition(lat, lon, accuracy, source) {
  positionEl.textContent = formatPositionDisplay(lat, lon);
  const label = SOURCE_LABEL[source] || source.toUpperCase();
  const accText = accuracy && !['opencpn-track', 'manual'].includes(source)
    ? ` ±${Math.round(accuracy)}m` : '';
  gpsStatusEl.textContent = `GPS: ${label}${accText}`;
  gpsStatusEl.className = source === 'manual'
    ? 'status-badge gps-test'
    : 'status-badge gps-ok';
  _updateCoverageStatus(lat, lon);

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

  {
    const hazardLayer = L.layerGroup();
    _renderClusteredHazards(_map, hazardLayer, hazards, (h) => {
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
      return m;
    });
    layers.push(hazardLayer);
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
      case 'QUERY_FOCUS': {
        response = Query.bearingToFocusedTarget(pos.lat, pos.lon);
        if (!response) {
          response = {
            text: 'No focus set. Try "focus on <place>" or ask a bearing question first.',
            speech: 'No focus set. Try focus on, followed by a place name.',
          };
        }
        break;
      }
      case 'SET_FOCUS': {
        let place = Query.findPlaceByName(params.placeName);
        if (!place && serverUrl) place = await Query.findPlaceOnServer(params.placeName);
        if (!place) {
          response = { text: `Couldn't find "${params.placeName}".`, speech: `I couldn't find ${params.placeName}.` };
          break;
        }
        Query.setFocus(place.lat, place.lon, place.name, 'place');
        _updateFocusButton();
        response = { text: `Focused on ${place.name}.`, speech: `Focused on ${place.name}.` };
        break;
      }
      case 'CLEAR_FOCUS': {
        Query.clearFocus();
        _updateFocusButton();
        response = { text: 'Focus cleared.', speech: 'Focus cleared.' };
        break;
      }
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
    const isBearingIntent = (intent === 'BEARING_TO_PLACE' || intent === 'BEARING_TO_COORD' || intent === 'QUERY_FOCUS');
    const isOtherMapIntent = ['NEAREST_HAZARD', 'NEAREST_NAVAID', 'NEAREST_RESTRICTION'].includes(intent);

    if (isBearingIntent && Query.lastBearingResult) {
      // Accumulate bearing lines — keep the most recent 6 (one per color).
      _bearingAccumulator.push({ fromLat: pos.lat, fromLon: pos.lon, result: Query.lastBearingResult });
      if (_bearingAccumulator.length > 6) _bearingAccumulator.shift();
      showMap(pos.lat, pos.lon, Query.lastBearingResult).catch(() => {});
      opencpnBtn.style.display = 'none';
      _updateFocusButton();
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
    } else if (intent === 'SET_FOCUS' || intent === 'CLEAR_FOCUS') {
      // Leave the current map view as-is — these only change the focus target.
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

function _closeTestPosForm() {
  testPosForm.style.display = 'none';
  testPosInput.value = '';
  testPosInput.style.borderColor = '';
}

testPosBtn.addEventListener('click', () => {
  if (GPS.isManualPosition()) {
    clearTestPosition();
    return;
  }
  const isOpen = testPosForm.style.display !== 'none';
  if (isOpen) { _closeTestPosForm(); return; }
  testPosForm.style.display = 'flex';
  testPosInput.focus();
});

// Cancelable: Escape or a click outside the form closes it without setting anything.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && testPosForm.style.display !== 'none') _closeTestPosForm();
});
document.addEventListener('click', (e) => {
  if (testPosForm.style.display === 'none') return;
  if (testPosForm.contains(e.target) || testPosBtn.contains(e.target)) return;
  _closeTestPosForm();
}, { capture: true });

// ── Track recording ──────────────────────────────────────────────────────────

// Shared save/reset — used by the manual Track button, "Stop Following", and
// arrival-triggered auto-stop, so there's exactly one place that writes to
// TRACK_KEY and clears recording state.
function _finishTrackRecording(name) {
  if (name && _trackRecPoints.length >= 2) {
    const tracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
    tracks.push(_stampNew({ name, points: _trackRecPoints }));
    localStorage.setItem(TRACK_KEY, JSON.stringify(tracks));
  }
  localStorage.removeItem(IN_PROGRESS_TRACK_KEY);
  _trackRecActive = false;
  _trackRecPoints = [];
  _trackRecStartMs = null;
  _followingRouteId = null;
  _followingRouteName = null;
  _followingDestLat = null;
  _followingDestLon = null;
  _followingLegIdx = 1;
  if (_followProgressEl) _followProgressEl.style.display = 'none';
  trackRecBtn.textContent = '⏺ Track';
  trackRecBtn.title = 'Record a GPS track';
  trackRecBtn.classList.remove('rec-active');
  _refreshSavedTrackLayers();
}

trackRecBtn?.addEventListener('click', () => {
  if (!_trackRecActive) {
    _trackRecActive = true;
    _autoTrackEverStarted = true;
    _trackRecStartMs = Date.now();
    _trackRecPoints = [];
    _trackRecLastSampleTs = 0;
    trackRecBtn.textContent = '⏹ Stop';
    trackRecBtn.classList.add('rec-active');
    return;
  }
  if (_followingRouteId) { _stopFollowingRoute(false); return; }
  const name = prompt('Save track as:', `Track ${new Date(_trackRecStartMs).toLocaleString()}`);
  _finishTrackRecording(name && name.trim() ? name.trim() : null);
});

// Start recording a track linked to a specific route — auto-named and
// auto-saved on arrival (see the GPS callback below), with a manual stop
// always available via the same Track button (now showing "Stop").
function _startFollowingRoute(route) {
  if (_trackRecActive) {
    const msg = 'Already recording a track — stop it first.';
    setStatus(msg); TTS.sayImmediate(msg);
    return;
  }
  const last = route.points?.[route.points.length - 1];
  if (!last) return;
  _trackRecActive = true;
  _autoTrackEverStarted = true;
  _trackRecStartMs = Date.now();
  _trackRecPoints = [];
  _trackRecLastSampleTs = 0;
  _followingRouteId = route.id;
  _followingRouteName = route.name;
  _followingDestLat = last.lat;
  _followingDestLon = last.lon;
  _followingLegIdx = route.points.length > 1 ? 1 : 0;
  trackRecBtn.textContent = '⏹ Stop';
  trackRecBtn.title = `Following "${route.name}" — tap to stop early`;
  trackRecBtn.classList.add('rec-active');
  const msg = `Following "${route.name}" — recording your track.`;
  setStatus(msg); TTS.sayImmediate(msg);
  _buildRoutePickerPanelFn?.();
}

// `arrived` distinguishes the two ways a followed route's recording ends —
// only changes the spoken/status message, the save behavior is identical.
function _stopFollowingRoute(arrived) {
  const routeName = _followingRouteName;
  const saved = _trackRecPoints.length >= 2;
  const name = `${routeName} — ${new Date().toLocaleDateString()}`;
  _finishTrackRecording(saved ? name : null);
  const outcome = saved ? 'track saved' : 'too short to save a track';
  const msg = arrived
    ? `Arrived — ${outcome} for "${routeName}".`
    : `Stopped following "${routeName}" — ${outcome}.`;
  setStatus(msg); TTS.sayImmediate(msg);
  _buildRoutePickerPanelFn?.();
}

// ── Screen wake lock ─────────────────────────────────────────────────────────
function _updateWakeLockButton() {
  if (!wakeLockBtn) return;
  wakeLockBtn.textContent = _wakeLockEnabled ? '☀️ Awake' : '💤 Sleep OK';
  wakeLockBtn.title = _wakeLockEnabled
    ? 'Screen stays awake — tap to allow it to sleep'
    : 'Screen may sleep — tap to keep it awake';
  wakeLockBtn.classList.toggle('wake-active', _wakeLockEnabled);
}

async function _requestWakeLock() {
  if (!_wakeLockEnabled || !('wakeLock' in navigator)) return;
  if (document.visibilityState !== 'visible') return;
  if (_wakeLockSentinel) return; // already held

  try {
    _wakeLockSentinel = await navigator.wakeLock.request('screen');
    _wakeLockWarned = false;
    _wakeLockSentinel.addEventListener('release', () => { _wakeLockSentinel = null; });
  } catch (err) {
    _wakeLockSentinel = null;
    if (!_wakeLockWarned) {
      _wakeLockWarned = true;
      console.warn('[wakelock] request failed:', err);
      setStatus(`Screen wake lock unavailable: ${err.message}`);
    }
  }
}

function _releaseWakeLock() {
  if (_wakeLockSentinel) _wakeLockSentinel.release().catch(() => {});
}

wakeLockBtn?.addEventListener('click', () => {
  _wakeLockEnabled = !_wakeLockEnabled;
  localStorage.setItem('audiochart-wake-lock', _wakeLockEnabled ? 'true' : 'false');
  _wakeLockWarned = false;
  _updateWakeLockButton();
  if (_wakeLockEnabled) _requestWakeLock(); else _releaseWakeLock();
});

// The Wake Lock spec auto-releases the sentinel whenever the tab is backgrounded
// (fires the 'release' handler above on its own) — re-request it on return, matching
// this codebase's one-listener-per-feature convention (no shared visibility dispatcher).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _requestWakeLock();
});

function _recoverInProgressTrack() {
  const raw = localStorage.getItem(IN_PROGRESS_TRACK_KEY);
  if (!raw) return;
  try {
    const { startMs, points, followingRouteId, followingRouteName, followingDestLat, followingDestLon, followingLegIdx } = JSON.parse(raw);
    if (!points || points.length < 2) { localStorage.removeItem(IN_PROGRESS_TRACK_KEY); return; }
    const mins = Math.round((Date.now() - startMs) / 60000);
    const label = followingRouteName
      ? `Found an in-progress recording of "${followingRouteName}" (${points.length} points, started ${mins} min ago). Resume following it?`
      : `Found an unsaved track recording (${points.length} points, started ${mins} min ago). Resume recording it?`;
    if (confirm(label)) {
      _trackRecActive = true;
      _autoTrackEverStarted = true;
      _trackRecStartMs = startMs;
      _trackRecPoints = points;
      _trackRecLastSampleTs = points[points.length - 1].t;
      _followingRouteId = followingRouteId || null;
      _followingRouteName = followingRouteName || null;
      _followingDestLat = followingDestLat ?? null;
      _followingDestLon = followingDestLon ?? null;
      _followingLegIdx = followingLegIdx ?? 1;
      trackRecBtn.textContent = '⏹ Stop';
      if (followingRouteName) trackRecBtn.title = `Following "${followingRouteName}" — tap to stop early`;
      trackRecBtn.classList.add('rec-active');
    } else {
      const name = prompt('Save the recovered points as a track before discarding? Leave blank to discard.', '');
      if (name && name.trim()) {
        const tracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
        tracks.push(_stampNew({ name: name.trim(), points }));
        localStorage.setItem(TRACK_KEY, JSON.stringify(tracks));
      }
      localStorage.removeItem(IN_PROGRESS_TRACK_KEY);
    }
  } catch (_) { localStorage.removeItem(IN_PROGRESS_TRACK_KEY); }
}

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

// One-tap reset for map clutter — a long test/exploration session can leave
// several routes shown at once (each with its own bearing-label overlay)
// plus leftover query-result markers (long-press lookups, hazard checks,
// the fallback-warning triangles), none of which clear themselves. Mirrors
// exactly what a fresh launch already does for routes/tracks (see
// _loadHiddenRoutes/_loadHiddenTracks — "every launch starts tidy") without
// requiring an actual reload, plus clears the transient query-result
// layers a reload would also naturally drop. Deliberately does NOT touch
// checkbox-controlled overlays (hazards/navaids/depths/current arrows) or
// the boat/waypoint layers — those are standing preferences, not clutter.
function _clearScreen() {
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  routes.forEach(r => _hiddenRouteNames.add(r.name));
  _saveHiddenRoutes();
  _refreshSavedRouteLayers();

  const tracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
  tracks.forEach(t => _hiddenTrackNames.add(t.name));
  _saveHiddenTracks();
  _refreshSavedTrackLayers();

  for (const layer of [_mapLayers, _hazardCheckLayer, _routeFallbackLayer,
                        _autoRoutePreviewLayer, _viewportHazardLayer,
                        _animReportLayer, _animMilestoneLayer]) {
    if (layer) _map?.removeLayer(layer);
  }
  _mapLayers = _hazardCheckLayer = _routeFallbackLayer = null;
  _autoRoutePreviewLayer = _viewportHazardLayer = null;
  _animReportLayer = _animMilestoneLayer = null;

  const msg = 'Screen cleared.';
  setStatus(msg);
  TTS.sayImmediate(msg);
}

clearScreenBtn.addEventListener('click', _clearScreen);

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
      // regionId (e.g. "piscataqua") drives the land/channels/soundings
      // path Query.loadData() reads from — a bundled default-only regionId
      // (dataUrl with no "regions/<id>.json" match) leaves the active
      // region unset, matching today's unchanged bundled-default behavior.
      const regionId = profile.dataUrl.match(/regions\/([^/]+)\.json$/)?.[1];
      if (regionId) {
        Query.setActiveRegion(regionId);
        await Query.prepareOfflineRegionGeometry(regionId);
      }
      const result = await Query.prepareOfflineStatic(profile.dataUrl);
      await Query.loadData(null, null);
      dataLoaded = true;
      // The coverage badge only recomputes on a live GPS fix — without this,
      // switching regions leaves it showing the old region's stale verdict
      // until the next natural position tick happens to arrive.
      const _switchPos = GPS.getPosition();
      if (_switchPos) _updateCoverageStatus(_switchPos.lat, _switchPos.lon);
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

  Query.loadStoredFocus();
  _updateFocusButton();
  Query.loadStoredActiveWaypoint();
  _recoverInProgressTrack();

  if ('wakeLock' in navigator) {
    wakeLockBtn.style.display = 'inline-block';
    _updateWakeLockButton();
    _requestWakeLock();
  }

  // Show the map immediately on all devices (sidebar was removed in v198)
  loadLeaflet().then(() => {
    document.getElementById('map-container').style.display = 'block';
    _ensureMap();
    _map.invalidateSize();
    _initRearrangeGroups();
  }).catch(() => {});

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
    async (lat, lon, accuracy, source, heading, speedKt) => {
      showPosition(lat, lon, accuracy, source);
      _refreshYouLayer();
      _updateFocusRay();
      if (source === 'manual') {
        _lastFixForHeading = null; // don't let a teleport corrupt the next real fallback calc
        _updateHeadingRay(lat, lon, null, null);
        _updateHeadingSpeedReadout(null, null);
      } else {
        const computed = _computeHeadingSpeed(lat, lon, heading, speedKt);
        _updateHeadingRay(lat, lon, computed.headingDeg, computed.speedKt);
        _updateHeadingSpeedReadout(computed.headingDeg, computed.speedKt);
      }
      // Auto-start a track the first time a REAL fix (not a test position)
      // comes in, so a voyage is captured by default without requiring the
      // user to remember to tap "Track" — testing/simulating a position
      // never triggers this since source === 'manual' is excluded.
      if (source !== 'manual' && !_trackRecActive && !_autoTrackEverStarted) {
        _trackRecActive = true;
        _autoTrackEverStarted = true;
        _trackRecStartMs = Date.now();
        _trackRecPoints = [];
        _trackRecLastSampleTs = 0;
        trackRecBtn.textContent = '⏹ Stop';
        trackRecBtn.title = 'Recording automatically — tap to stop and save';
        trackRecBtn.classList.add('rec-active');
      }
      if (_trackRecActive) {
        const now = Date.now();
        if (now - _trackRecLastSampleTs >= 1000) {
          _trackRecLastSampleTs = now;
          _trackRecPoints.push({ lat, lon, t: now });
          localStorage.setItem(IN_PROGRESS_TRACK_KEY, JSON.stringify({
            startMs: _trackRecStartMs, points: _trackRecPoints,
            followingRouteId: _followingRouteId, followingRouteName: _followingRouteName,
            followingDestLat: _followingDestLat, followingDestLon: _followingDestLon,
            followingLegIdx: _followingLegIdx,
          }));
          _refreshSavedTrackLayers();
        }
        // Arrival check runs on every fix (not just sampled ones) so a route
        // being followed auto-completes promptly rather than up to 1s late.
        if (_followingRouteId && _followingDestLat != null &&
            Query.distanceNm(lon, lat, _followingDestLon, _followingDestLat) <= ARRIVAL_THRESHOLD_NM) {
          _stopFollowingRoute(true);
        }
      }
      _updateFollowProgress(lat, lon);
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
