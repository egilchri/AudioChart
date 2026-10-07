/**
 * AudioChart — main application entry point.
 * Input: text box (use phone keyboard mic for voice-to-text on Pixel).
 * Output: spoken TTS + on-screen text.
 */

import * as TTS from './tts.js';
import * as GPS from './gps.js';
import { parseCommand, parseCoordinate, normalizePlaceName, parseFromToQuery } from './parser.js';
import * as Query from './query.js';
import * as Router from './router.js';
import * as GpxExport from './gpx_export.js';
import * as MarkerIcons from './marker_icons.js';
import * as HazardClustering from './hazard_clustering.js';
import * as WaypointsStorage from './waypoints_storage.js';
import * as TestSetsStorage from './test_sets_storage.js';
import { initCardStack } from './card_stack.js';
import * as VoiceLabels from './voice_labels.js';
import * as PushToTalk from './push_to_talk.js';
import * as WakeLock from './wake_lock.js';
import * as AnchorWatch from './anchor_watch.js';
import * as Tour from './tour.js';
import * as DriveSync from './drive_sync.js';
import { openDriveImportPicker } from './drive_import.js';
import { migrateLegacyIds } from './sync_merge.js';
import { splitIntoLegs } from './route_legs.js';

// Cold-start splash (#app-splash in index.html) — hidden once the map is
// actually ready (see the loadLeaflet().then()/.catch() calls below), with
// a hard safety-net timeout here so a stuck/erroring init path can never
// leave it covering the app forever.
function _hideAppSplash() {
  const el = document.getElementById('app-splash');
  if (!el || el.classList.contains('splash-hidden')) return;
  el.classList.add('splash-hidden');
  setTimeout(() => el.remove(), 600);
}
setTimeout(_hideAppSplash, 6000);

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

// ── Boat icon double-tap menu (Autoroute / Sketch) ──────────────────────────
// Replaced a hold-timer long-press here after it stayed unreliable on real
// phones through several genuine fix attempts (each one a real bug found by
// reading Leaflet's source, none of them fully verified live since there's
// no device to test against in this environment — that gap between
// confidence and actual verification was the real problem, not any single
// remaining bug). Double-tap sidesteps the whole category: it's a discrete,
// already-completed gesture by the time the browser reports it, so none of
// the held-timer races (touch-callout, Android's contextmenu synthesis,
// Leaflet's drag threshold) apply. It rides the same native dblclick
// synthesis Leaflet's own double-tap-to-zoom already depends on everywhere.
let _boatCtxLatLng = null;
let _boatCtxMapListenerBound = false;
// _routeFromHere itself lives inside _ensureMap()'s closure (it calls
// _triggerAutoRoute, defined there) — bridged out via this top-level ref so
// the boat menu's click handler (also top-level) can reach it.
let _routeFromHereFn = null;
let _autoRouteFromBoatToHereFn = null;
const _boatCtxMenu = document.getElementById('boat-context-menu');

function _hideBoatCtx() { _boatCtxMenu.style.display = 'none'; _disarmBoatCtxDragSelect(); }

function _showBoatCtx(clientX, clientY, latlng) {
  _boatCtxLatLng = latlng;
  _boatCtxMenu.style.display = 'block';
  const mw = _boatCtxMenu.offsetWidth, mh = _boatCtxMenu.offsetHeight;
  const x = Math.min(clientX, window.innerWidth - mw - 4);
  const y = (clientY + mh + 4 > window.innerHeight) ? Math.max(4, clientY - mh) : clientY;
  _boatCtxMenu.style.left = Math.max(4, x) + 'px';
  _boatCtxMenu.style.top  = Math.max(4, y) + 'px';
}

// This menu only ever opens from a completed dblclick (see _wireBoatLongPress
// below — the long-press gesture it's named for was replaced by double-tap/
// dblclick, per the comment above _boatCtxLatLng), which by definition fires
// only after the mouse/finger is already back up. A former "hold the boat,
// drag over an item, release to pick it" input mode used to justify tracking
// mousemove/mouseup globally from the moment the menu opened and firing
// item.click() programmatically on release — but with no continued press to
// track, that global listener just caught the ORDINARY separate click a user
// makes on a menu item (cursor motion between opening the menu and clicking
// an item is completely normal, not a drag-select gesture), firing
// item.click() a second time right alongside the button's own real native
// click. Confirmed live: this is exactly what made "double-click boat icon ->
// Autoroute" show the route-naming prompt twice, using whichever name was
// entered into the SECOND prompt. Removed entirely — each menu button's own
// addEventListener('click', ...) below is the only thing that should fire it.
function _disarmBoatCtxDragSelect() {
  // The release that ends a menu interaction lands on whatever's under the
  // cursor — a menu item, not the boat marker itself — so the marker's own
  // Leaflet 'mouseup' listener never fires and never gets the chance to
  // re-enable dragging. Do it here instead, unconditionally, covering every
  // path this menu closes through.
  const marker = _boatLayer?.getLayers()[0] || _youLayer?.getLayers()[0];
  marker?.dragging?.enable();
  _map?.dragging.enable();
}

document.getElementById('boat-ctx-autoroute').addEventListener('click', () => {
  _hideBoatCtx();
  if (_boatCtxLatLng) _routeFromHereFn?.(_boatCtxLatLng.lat, _boatCtxLatLng.lng);
});
document.getElementById('boat-ctx-sketch').addEventListener('click', () => {
  _hideBoatCtx();
  _enterSketchMode();
});
// Same pipeline the Search box uses (nextSearchPinName/saveUserWaypoint with
// type:'search') — a real, addressable, draggable, renamable pin, just
// sourced from "here" instead of a typed query. Per direct request: man
// overboard, marking a spot to come back to, etc. — needs to be one tap,
// no typing, so this doesn't reuse _runSearch's text-resolution path at all.
document.getElementById('boat-ctx-drop-pin').addEventListener('click', () => {
  _hideBoatCtx();
  if (!_boatCtxLatLng) return;
  const { lat, lng: lon } = _boatCtxLatLng;
  const name = WaypointsStorage.nextSearchPinName();
  saveUserWaypoint(name, lat, lon, 'search', formatPositionDisplay(lat, lon));
  Query.setActiveWaypoint(lat, lon, name);
  if (!_waypointsVisible) _setWaypointsVisible(true);
  const msg = `${name} dropped at your position.`;
  setStatus(msg);
  TTS.sayImmediate(msg);
});
// The second tap of a touch double-tap (see _wireBoatLongPress) is still
// followed by its own click on the boat — don't let that close the menu it
// just opened.
let _boatCtxTapOpenedAt = 0;
document.addEventListener('click', (e) => {
  if (Date.now() - _boatCtxTapOpenedAt < 500) return;
  if (!_boatCtxMenu.contains(e.target)) _hideBoatCtx();
}, { capture: true });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _hideBoatCtx(); });

function _wireBoatLongPress(marker) {
  if (_simTrackMode) return; // mid-playback isn't a sensible time to start a new route
  if (!_boatCtxMapListenerBound && _map) {
    _boatCtxMapListenerBound = true;
    _map.on('movestart zoomstart', _hideBoatCtx);
  }
  marker.on('dblclick', (e) => {
    const oe = e.originalEvent;
    // dblclick is a real MouseEvent even when the browser synthesized it
    // from two taps, so clientX/clientY are always there directly — no
    // touches/changedTouches fallback needed (that was only ever relevant
    // for raw touchstart/touchend, not this event type).
    //
    // L.DomEvent.stopPropagation (not the native oe.stopPropagation) is what
    // actually matters here: Leaflet's own _fireDOMEvent walks marker → map
    // and checks its own internal _stopped flag on the native event, which
    // only L.DomEvent.stopPropagation sets — without this, the map's default
    // double-click-zoom fires right along with our menu.
    L.DomEvent.stopPropagation(oe);
    _showBoatCtx(oe.clientX, oe.clientY, marker.getLatLng());
  });
  // iOS Safari doesn't reliably synthesize dblclick from two taps here, and
  // Leaflet's own tap-counting fallback skips iOS's taps because their
  // click events report pointerType 'mouse'. Confirmed in the iOS 27
  // simulator: two taps arrive as pointerup×2 + one click, no dblclick, no
  // menu. Detect the double-tap ourselves from touch pointerups instead.
  marker.on('add', () => {
    const el = marker.getElement();
    if (!el || el._boatTapWired) return;
    el._boatTapWired = true;
    let downX = 0, downY = 0, lastUp = 0, lastX = 0, lastY = 0;
    el.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
    el.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch') return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 10) { lastUp = 0; return; } // a drag, not a tap
      const now = Date.now();
      if (now - lastUp < 400 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 30) {
        lastUp = 0;
        _boatCtxTapOpenedAt = now;
        _showBoatCtx(e.clientX, e.clientY, marker.getLatLng());
      } else {
        lastUp = now; lastX = e.clientX; lastY = e.clientY;
      }
    });
  });
}

function _showBoatPosition(lat, lon) {
  if (!_map) return;
  if (_simTrackMode) _exitSimTrackMode();
  if (_boatLayer) { _map.removeLayer(_boatLayer); _boatLayer = null; }
  const marker = L.marker([lat, lon], { icon: MarkerIcons.boatIcon(), zIndexOffset: 1000, draggable: true });

  _wireBoatLongPress(marker);
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

  // Soundings (own toggle now) also needs a fresh tide height, same as
  // Depths/mudflats — both render tide-adjusted values.
  const _depthOn = document.getElementById('nf-depth')?.checked
    || document.getElementById('nf-soundings')?.checked;
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
  const icon = _simTrackMode ? MarkerIcons.animBoatIcon(_simTrackDeg) : MarkerIcons.boatIcon();
  const m = L.marker([pos.lat, pos.lon], { icon, zIndexOffset: 800 });
  _wireBoatLongPress(m);

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
  const wps = WaypointsStorage.loadUserWaypoints();
  if (!wps.length) return;
  _waypointLayer = L.layerGroup(
    wps.map(wp => {
      const icon = wp.type === 'search' ? MarkerIcons.searchPinIcon() : MarkerIcons.waypointIcon();
      // Direct report: buoys were "getting in the way" of tapping a user's
      // own markers — navaids render with no zIndexOffset (effectively 0),
      // so without one here Leaflet's default y-position stacking decided
      // the winner by coincidence. A user's own waypoint/search pin should
      // always win that fight, above every charted navaid/hazard symbol
      // (hazards top out at 1000, see their own zIndexOffset) regardless
      // of screen position.
      const m = L.marker([wp.lat, wp.lon], { icon, draggable: true, zIndexOffset: 1050 });
      m.bindTooltip(escapeHtml(wp.name), { permanent: true, direction: 'top', className: 'map-tooltip' });
      m.bindPopup(
        `<div class="navaid-popup">
           <div class="navaid-popup-name">${escapeHtml(wp.name)}</div>
           ${wp.note ? `<div class="navaid-popup-note">${escapeHtml(wp.note)}</div>` : ''}
           <div class="navaid-popup-coords"></div>
           <button class="navaid-popup-focus">&#127919; Set focus</button>
           <button class="navaid-popup-bring-boat">&#9935; Bring boat here</button>
           <button class="navaid-popup-autoroute">&#9973; AutoRoute from boat position</button>
           <button class="navaid-popup-objects">Objects within &rsaquo;</button>
           <button class="navaid-popup-routes-near">Routes within &rsaquo;</button>
           <button class="navaid-popup-tracks-near">Tracks within &rsaquo;</button>
           <button class="navaid-popup-rename">&#9998; Rename</button>
           ${wp.name.startsWith('SP') ? `<button class="navaid-popup-add-testset">&#129514; Add to Test Set&hellip;</button>
           <div class="navaid-popup-testset-choices" style="display:none"></div>` : ''}
           <button class="navaid-popup-delete">&#128465; Delete</button>
         </div>`,
        { maxWidth: 220, className: 'navaid-popup-wrapper' }
      );
      m.on('popupopen', (e) => {
        const popupEl = e.popup.getElement();
        // Read the marker's LIVE position, not the closed-over wp.lat/lon —
        // after a drag those go stale (the marker moved but this callback's
        // closure didn't), which is exactly the bug just reported: dragging
        // a pin then reopening its popup showed the coordinates from before
        // the drag. getLatLng() always reflects wherever it actually is now.
        const live = m.getLatLng();
        popupEl.querySelector('.navaid-popup-coords').textContent = formatPositionDisplay(live.lat, live.lng);
        popupEl.querySelector('.navaid-popup-focus').addEventListener('click', () => {
          _map.closePopup();
          Query.setFocus(live.lat, live.lng, wp.name, 'waypoint');
          _updateFocusButton();
          const msg = `Focused on ${wp.name}.`;
          showResponse(msg);
          TTS.sayImmediate(msg);
        });
        // Formerly the right-click menu's own "Bring boat here" — moved
        // here per direct request, since right-click on empty water no
        // longer offers it (only "Set marker here" does). Same shared
        // implementation as the Waypoints-panel and Test-Set-popup call sites.
        popupEl.querySelector('.navaid-popup-bring-boat').addEventListener('click', () => {
          _map.closePopup();
          _bringBoatTo(live.lat, live.lng, wp.name);
        });
        // Zero-interaction auto-route: boat's current GPS position → this
        // pin, no name prompt, no second tap. See _autoRouteFromBoatToHere.
        popupEl.querySelector('.navaid-popup-autoroute').addEventListener('click', () => {
          _map.closePopup();
          _autoRouteFromBoatToHereFn?.(live.lat, live.lng);
        });
        // Formerly the right-click menu's own Objects/Routes/Tracks-within
        // radius pickers — moved here per direct request. All three open
        // the same singleton flyout elements _openNearPointFlyout always
        // used, just anchored to this button instead of a context-menu row.
        popupEl.querySelector('.navaid-popup-objects').addEventListener('click', (ev) => {
          const rect = ev.currentTarget.getBoundingClientRect(); // before closePopup() detaches it
          _map.closePopup();
          _openNearPointFlyout(document.getElementById('map-ctx-objects-submenu'), rect, live);
        });
        popupEl.querySelector('.navaid-popup-routes-near').addEventListener('click', (ev) => {
          const rect = ev.currentTarget.getBoundingClientRect();
          _map.closePopup();
          _openNearPointFlyout(document.getElementById('map-ctx-routes-near-submenu'), rect, live);
        });
        popupEl.querySelector('.navaid-popup-tracks-near').addEventListener('click', (ev) => {
          const rect = ev.currentTarget.getBoundingClientRect();
          _map.closePopup();
          _openNearPointFlyout(document.getElementById('map-ctx-tracks-near-submenu'), rect, live);
        });
        // Per direct request (originally for search pins' auto-generated
        // SP00N names, equally true of quick-dropped wp00N ones) — a typed
        // name is a real, addressable AutoRoute destination just like a
        // gazetteer place, but "SP003" isn't something you'd remember or
        // say with confidence a minute later the way "Camden" is.
        popupEl.querySelector('.navaid-popup-rename').addEventListener('click', async () => {
          _map.closePopup();
          const newName = await _showTextPrompt('Rename waypoint', '', wp.name);
          if (!newName || newName === wp.name) return;
          const stored = WaypointsStorage.loadUserWaypoints();
          if (stored.some(w => w.name !== wp.name && w.name.toLowerCase() === newName.toLowerCase())) {
            const msg = `A waypoint named "${newName}" already exists.`;
            setStatus(msg);
            TTS.sayImmediate(msg);
            return;
          }
          const idx = stored.findIndex(w => w.name === wp.name);
          if (idx === -1) return;
          stored[idx].name = newName;
          localStorage.setItem(WaypointsStorage.USER_WP_KEY, JSON.stringify(stored));
          Query.removeUserWaypoint(wp.name);
          Query.mergeUserWaypoints([{ name: newName, lat: wp.lat, lon: wp.lon }]);
          if (Query.activeWaypoint?.name === wp.name) Query.setActiveWaypoint(wp.lat, wp.lon, newName);
          _refreshWaypointLayer();
          const msg = `Renamed to ${newName}.`;
          setStatus(msg);
          TTS.sayImmediate(msg);
        });
        // SP markers only — move this ONE marker into a Test Set (existing
        // or new). Direct request 2026-10-04; the bulk "Save SP* waypoints
        // as Test Set" in the Waypoints window was the only path before.
        // Like the bulk save, the SP waypoint is converted, not copied: it
        // leaves the regular waypoint list and becomes the set's next TS00N.
        const addTsBtn = popupEl.querySelector('.navaid-popup-add-testset');
        if (addTsBtn) addTsBtn.addEventListener('click', () => {
          const choices = popupEl.querySelector('.navaid-popup-testset-choices');
          if (choices.style.display !== 'none') { choices.style.display = 'none'; return; }
          const sets = TestSetsStorage.loadTestSets();
          choices.innerHTML = sets.map(set =>
            `<button class="navaid-popup-testset-pick" data-set-id="${escapeHtml(set.id)}">${escapeHtml(set.name)} (${set.waypoints.length})</button>`
          ).join('') + `<button class="navaid-popup-testset-pick" data-set-id="">&#65291; New Test Set&hellip;</button>`;
          choices.style.display = 'block';
          choices.querySelectorAll('.navaid-popup-testset-pick').forEach(b => b.addEventListener('click', async () => {
            _map.closePopup();
            const live = WaypointsStorage.loadUserWaypoints().find(w => w.name === wp.name);
            if (!live) return;
            let setId = b.dataset.setId, setName, tsName;
            if (!setId) {
              setName = await _showTextPrompt('Name this Test Set', '', TestSetsStorage.nextTestSetDefaultName());
              if (!setName) return;
              const set = TestSetsStorage.saveTestSet(setName, [live]);
              setId = set.id;
              tsName = set.waypoints[0].name;
            } else {
              setName = TestSetsStorage.loadTestSets().find(x => x.id === setId)?.name;
              tsName = TestSetsStorage.addWaypointToTestSet(setId, live);
              if (!tsName) return;
            }
            TestSetsStorage.setTestSetVisible(setId, true);
            localStorage.setItem(WaypointsStorage.USER_WP_KEY, JSON.stringify(WaypointsStorage.loadUserWaypoints().filter(w => w.name !== wp.name)));
            Query.removeUserWaypoint(wp.name);
            _refreshWaypointLayer();
            _refreshTestSetLayer();
            const msg = `${wp.name} added to Test Set "${setName}" as ${tsName}.`;
            setStatus(msg);
            TTS.sayImmediate(msg);
          }));
        });
        // Same removal steps as the "delete waypoint [name]" text command —
        // per direct request, old auto-named waypoints (wp001, wp002, ...)
        // cluttering the chart needed a way to clear them right from the
        // map, not just by typing their exact name into the command bar.
        popupEl.querySelector('.navaid-popup-delete').addEventListener('click', () => {
          if (!confirm(`Delete waypoint "${wp.name}"? This cannot be undone.`)) return;
          _map.closePopup();
          const stored = WaypointsStorage.loadUserWaypoints();
          const idx = stored.findIndex(w => w.name === wp.name);
          if (idx !== -1) stored.splice(idx, 1);
          localStorage.setItem(WaypointsStorage.USER_WP_KEY, JSON.stringify(stored));
          Query.removeUserWaypoint(wp.name);
          _refreshWaypointLayer();
          const msg = `Waypoint ${wp.name} deleted.`;
          setStatus(msg);
          TTS.sayImmediate(msg);
        });
      });
      _markerByKey.set(_markerKey(wp.lat, wp.lon), m);
      m.on('dragend', (e) => {
        const { lat: newLat, lng: newLon } = e.target.getLatLng();
        _currentMarkerLL = { lat: newLat, lng: newLon }; // the marker just moved is the one voice commands mean
        const stored = WaypointsStorage.loadUserWaypoints();
        const idx = stored.findIndex(w => w.name === wp.name);
        if (idx !== -1) {
          _markerByKey.delete(_markerKey(stored[idx].lat, stored[idx].lon));
          stored[idx].lat = newLat;
          stored[idx].lon = newLon;
          localStorage.setItem(WaypointsStorage.USER_WP_KEY, JSON.stringify(stored));
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

// Draws every waypoint from every currently-VISIBLE Test Set (see
// TestSetsStorage) as its own small, non-draggable marker layer,
// independent of _waypointLayer — a Test Set is a frozen snapshot for
// repeatable testing, not a live editable waypoint, so it deliberately
// skips the drag/rename/delete machinery _refreshWaypointLayer's markers
// have. The one popup action worth keeping is the one this session's own
// testing repeatedly relied on: jumping the boat's test position straight
// to a saved point, then AutoRouting from there — see _bringBoatTo, the
// same shared "Bring boat here" action the ctx-wp-pos handler also uses.
function _refreshTestSetLayer() {
  if (!_map) return;
  if (_testSetLayer) { _map.removeLayer(_testSetLayer); _testSetLayer = null; }
  const visibleIds = TestSetsStorage.loadVisibleTestSetIds();
  if (!visibleIds.size) return;
  const sets = TestSetsStorage.loadTestSets().filter(s => visibleIds.has(s.id));
  const markers = [];
  for (const set of sets) {
    for (const wp of set.waypoints) {
      const icon = MarkerIcons.testSetMarkerIcon();
      // See the matching zIndexOffset comment in _refreshWaypointLayer —
      // same direct report, same fix: a user's own marker should always
      // win over charted navaid/hazard symbols for tap priority.
      const m = L.marker([wp.lat, wp.lon], { icon, draggable: false, zIndexOffset: 1050 });
      m.bindTooltip(escapeHtml(wp.name), { permanent: true, direction: 'top', className: 'map-tooltip' });
      m.bindPopup(
        `<div class="navaid-popup">
           <div class="navaid-popup-name">${escapeHtml(wp.name)}</div>
           <div class="navaid-popup-note">Test Set: ${escapeHtml(set.name)}${wp.origName ? ` (from ${escapeHtml(wp.origName)})` : ''}</div>
           <div class="navaid-popup-coords">${formatPositionDisplay(wp.lat, wp.lon)}</div>
           <button class="ts-popup-pos">Bring boat here</button>
           <button class="ts-popup-autoroute">&#9973; AutoRoute from boat position</button>
           <button class="ts-popup-delete">&#128465; Delete</button>
         </div>`,
        { maxWidth: 220, className: 'navaid-popup-wrapper' }
      );
      m.on('popupopen', (e) => {
        const popupEl = e.popup.getElement();
        popupEl.querySelector('.ts-popup-pos').addEventListener('click', () => {
          _map.closePopup();
          _bringBoatTo(wp.lat, wp.lon, wp.name);
        });
        popupEl.querySelector('.ts-popup-autoroute').addEventListener('click', () => {
          _map.closePopup();
          _autoRouteFromBoatToHereFn?.(wp.lat, wp.lon);
        });
        popupEl.querySelector('.ts-popup-delete').addEventListener('click', () => {
          if (!confirm(`Delete ${wp.name} from Test Set "${set.name}"? This cannot be undone.`)) return;
          _map.closePopup();
          // deleteTestSetWaypoint deletes the whole set (not just this one
          // marker) once it's the last waypoint left — tombstone the SET's
          // own id in that case so Drive sync doesn't resurrect it on
          // another device (see v761's Test Set sync).
          if (set.waypoints.length <= 1) _tombstone(set.id, 'testset');
          TestSetsStorage.deleteTestSetWaypoint(set.id, wp.name);
          _refreshTestSetLayer();
          const msg = `${wp.name} deleted.`;
          setStatus(msg); TTS.sayImmediate(msg);
        });
      });
      markers.push(m);
    }
  }
  _testSetLayer = L.layerGroup(markers).addTo(_map);
}

function _setTestSetVisible(id, v) {
  TestSetsStorage.setTestSetVisible(id, v);
  _refreshTestSetLayer();
}

// Floating, cancellable progress banner for _tryAllTestSetRoutes — unlike
// _showRerouteOverlay's own spinner (deliberately pointer-events:none,
// nothing to click), this one needs a real, clickable Cancel button.
function _showTryAllRoutesBanner() {
  const banner = document.createElement('div');
  banner.className = 'try-routes-banner';
  banner.innerHTML = '<span class="try-routes-status">Testing routes…</span>' +
                      '<button class="try-routes-cancel-btn">&#9632; Cancel</button>';
  _map.getContainer().appendChild(banner);
  banner.querySelector('.try-routes-cancel-btn').addEventListener('click', () => {
    _tryAllRoutesCancelled = true;
  });
  return {
    setText(t) { const el = banner.querySelector('.try-routes-status'); if (el) el.textContent = t; },
    remove() { banner.remove(); },
  };
}

// "Try all routes" (direct request, 2026-09-28, then corrected — this is
// NOT a chain between consecutive test points): performs the same
// "AutoRoute from boat position" each individual marker's own popup
// already offers, automated across every marker in the set in turn —
// boat's current GPS position stays the constant "from", each marker is
// tried as the "to" one at a time. N real routing tests for a set of N
// waypoints, the same kind of test this whole project's own regression
// suite runs, just live in the browser against whatever region is
// currently loaded. Deliberately NOT built on _reRouteSegments/
// _autoRouteFromBoatToHere's full save-a-route flow (used throughout the
// rest of the app to persist a single planned route): saving N new named
// routes to the Routes list as a side effect of a batch TEST would clutter
// it, and a cancelled or deadline-exceeded test should just stop and
// report where it got to, not manufacture a saved route for the rest.
async function _tryAllTestSetRoutes(set) {
  if (!set.waypoints.length) {
    setStatus(`Test Set "${set.name}" has no markers to try routes to.`);
    return;
  }
  const pos = GPS.getPosition();
  if (!pos) {
    setStatus('No GPS fix yet — cannot try routes from the boat’s position.');
    return;
  }
  _tryAllRoutesCancelled = false;
  if (_tryAllRoutesLayer) { _tryAllRoutesLayer.clearLayers(); _map.removeLayer(_tryAllRoutesLayer); }
  _tryAllRoutesLayer = L.layerGroup().addTo(_map);
  const banner = _showTryAllRoutesBanner();

  const draftFt = _currentDraftFt();
  const legCount = set.waypoints.length;
  const results = [];
  for (let i = 0; i < legCount; i++) {
    if (_tryAllRoutesCancelled) break;
    const b = set.waypoints[i];
    banner.setText(`Testing ${i + 1} of ${legCount}: boat → ${b.name}…`);
    const path = await Router.autoRouteProg(
      { lat: pos.lat, lon: pos.lon }, { lat: b.lat, lon: b.lon },
      () => {}, () => {}, false, draftFt, _effectiveTideHeight(), null, null, _currentDeadlineMs()
    );
    // No re-check of _tryAllRoutesCancelled here on purpose: this leg's
    // real work already finished by the time Cancel could have been
    // clicked mid-flight — recording and drawing it is free at this point,
    // and throwing away a completed result would be wasteful, not safer.
    // The loop's own check above still stops any FURTHER leg from
    // starting, which is what Cancel is actually for.
    const fellBack = path.length <= 2 && Query.landBlocks(path[0].lon, path[0].lat, path[1].lon, path[1].lat);
    L.polyline(path.map(p => [p.lat, p.lon]), {
      color: fellBack ? '#e05252' : '#3aa655', weight: 4, opacity: 0.85,
    }).addTo(_tryAllRoutesLayer);
    results.push({ to: b.name, ok: !fellBack });
  }
  const cancelledEarly = _tryAllRoutesCancelled;
  banner.remove();

  const failed = results.filter(r => !r.ok);
  const msg = cancelledEarly
    ? `Cancelled "${set.name}" after testing ${results.length} of ${legCount} ${legCount === 1 ? 'route' : 'routes'} — ${failed.length} failed.`
    : `Tested ${results.length} ${results.length === 1 ? 'route' : 'routes'} in "${set.name}": ${failed.length} failed` +
      (failed.length ? ` (${failed.map(f => f.to).join(', ')}).` : '.');
  // No TTS here, direct request — "the voice is too talkative" for a
  // rapid-fire batch test the user is already watching on screen (the
  // banner's own live progress text, plus each route drawing in as it
  // completes); a spoken summary on top of that is unwanted noise, not
  // missing information.
  setStatus(msg);
}
import { formatPositionDisplay, bearingToWords, bearingToDisplay, formatDistance, distanceToDisplay, trueTomagnetic, magneticToTrue, magneticVariation, escapeHtml } from './utils.js';

// Capture Android PWA install prompt before any user gesture.
let _pwaInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _pwaInstallPrompt = e;
});

// DOM elements
const textForm = document.getElementById('text-form');
const textInput = document.getElementById('text-input');
const commandPicker = document.getElementById('command-picker');
const statusEl = document.getElementById('status-text');
const positionEl = document.getElementById('position-display');
const responseEl  = document.getElementById('response-text');
const responseAreaEl = document.getElementById('response-area');
const navaidListEl = document.getElementById('navaid-list');
const statusComboEl = document.getElementById('status-title-bar');
const wcoTitlebarEl = document.getElementById('wco-titlebar');
const historyList = document.getElementById('history-list');
const historyClear = document.getElementById('history-clear');
const offlineBtn    = document.getElementById('offline-btn');
// Region-download and test-position-spoofing are now both reached through
// one "Location" tile (see the Location-menu block below) rather than two
// separate always-visible buttons — routeBtn/testPosBtn both point at that
// SAME element so every existing progress-text/active-state update below
// (there are many) keeps working unchanged, just now surfacing on the
// shared tile instead of its own dedicated button.
const locationMenuBtn = document.getElementById('location-menu-btn');
const locationMenu    = document.getElementById('location-menu');
const routeBtn      = locationMenuBtn;
const cruiseForm    = document.getElementById('cruise-form');
const cruiseChoices = document.getElementById('cruise-choices');
const testPosBtn = locationMenuBtn;
const testPosForm = document.getElementById('test-pos-form');
const testPosInput = document.getElementById('test-pos-input');
const testPosSet = document.getElementById('test-pos-set');
const testPosClear = document.getElementById('test-pos-clear');
const searchBtn = document.getElementById('search-btn');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const mapLink = document.getElementById('map-link');
const opencpnBtn = document.getElementById('opencpn-btn');
const focusBtn = document.getElementById('focus-btn');
const trackRecBtn = document.getElementById('track-rec-btn');
const wakeLockBtn = document.getElementById('wake-lock-btn');
const anchorWatchBtn = document.getElementById('anchor-watch-btn');
const anchorWatchSilenceBtn = document.getElementById('anchor-watch-silence-btn');
const anchorWatchForm = document.getElementById('anchor-watch-form');
const anchorWatchRadiusInput = document.getElementById('anchor-watch-radius');
const anchorWatchStartBtn = document.getElementById('anchor-watch-start');
const anchorWatchCancelBtn = document.getElementById('anchor-watch-cancel');
// Clear Screen is similarly reached under a "Screen" tile.
const screenMenuBtn = document.getElementById('screen-menu-btn');
const screenMenu    = document.getElementById('screen-menu');
// Import is a top-level button (status-tiles-2), not tucked in the map's
// right-click context menu — moved out per direct request, since it
// doesn't act on a tapped point like the rest of that menu does.
const importMenuBtn = document.getElementById('import-menu-btn');
const importMenu    = document.getElementById('import-menu');

function _updateFocusButton() {
  if (!focusBtn) return;
  const f = Query.focusedTarget;
  focusBtn.textContent = f ? `🎯 ${f.name || 'Point'}` : '🎯 --';
  focusBtn.classList.toggle('focus-active', !!f);
  focusBtn.title = f
    ? `Bearing & range to ${f.name || 'focused point'} (Drag to move)`
    : 'No focus set (Drag to move)';
  _syncFocusMarker();
  _updateFocusRay();
}

function _repeatBearingQuery() {
  if (!Query.focusedTarget) {
    TTS.sayImmediate('No focus set. Say focus on, followed by a place name.');
    return;
  }
  handleCommand('bearing');   // reuses the QUERY_FOCUS path end-to-end
}
focusBtn?.addEventListener('click', _repeatBearingQuery);

// Swipe down on the status strip is a second way to trigger the same
// bearing/range repeat as tapping the target button — no small target to
// aim for, any downward swipe starting on the strip works, which matters
// more than button placement on a moving boat. The strip is pointer-events:
// none by default (so taps normally pass through to the map); enabling it
// here only for this one element trades away panning-from-that-26px-sliver
// for the gesture, which is the point.
(function _wireStatusSwipeDown() {
  const el = statusComboEl;
  if (!el) return;
  el.style.pointerEvents = 'auto';
  const SWIPE_MIN_DY = 40, SWIPE_MAX_DX = 40;
  let startX = null, startY = null;
  const start = (x, y) => { startX = x; startY = y; };
  const finish = (x, y) => {
    if (startY == null) return;
    const dy = y - startY, dx = Math.abs(x - startX);
    startX = startY = null;
    if (dy > SWIPE_MIN_DY && dx < SWIPE_MAX_DX) _repeatBearingQuery();
  };
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    start(t.clientX, t.clientY);
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    finish(t.clientX, t.clientY);
  });
  el.addEventListener('touchcancel', () => { startX = startY = null; });
  el.addEventListener('mousedown', (e) => start(e.clientX, e.clientY));
  el.addEventListener('mouseup', (e) => finish(e.clientX, e.clientY));
})();

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
  // 'dev: true' regions are still in progress — hidden from normal use (see
  // _visibleCruiseProfiles) so a user can't wander into an unfinished area
  // and get confused, but still fully reachable for continued development
  // via the ?dev=1 URL unlock (see the DEV_UNLOCK_KEY handling in init()).
  'Casco Bay': {
    dataUrl: './data/regions/casco-bay.json',
    dev: true,
    stops: [
      { name: 'Portland',  lat: 43.6573, lon: -70.2564 },
      { name: 'Harpswell', lat: 43.7931, lon: -70.0760 },
    ],
  },
  'Piscataqua': {
    dataUrl: './data/regions/piscataqua.json',
    dev: true,
    stops: [
      { name: 'Portsmouth',     lat: 43.0718, lon: -70.7626 },
      { name: 'Isles of Shoals', lat: 42.9697, lon: -70.6234 },
      { name: 'Kittery',        lat: 43.0850, lon: -70.7350 },
    ],
  },
};

// See the 'dev: true' note above — CRUISE_PROFILES entries flagged that way
// are hidden from every normal UI surface (onboarding, Download Region menu,
// About panel, region auto-detect) unless DEV_UNLOCK_KEY is set, which only
// happens by visiting the app once with ?dev=1 (see init()).
const DEV_UNLOCK_KEY = 'audiochart-dev-unlocked';
function _isDevUnlocked() { return localStorage.getItem(DEV_UNLOCK_KEY) === '1'; }
function _visibleCruiseProfiles() {
  if (_isDevUnlocked()) return CRUISE_PROFILES;
  return Object.fromEntries(Object.entries(CRUISE_PROFILES).filter(([, p]) => !p.dev));
}

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
let _testSetLayer = null;
let _tryAllRoutesLayer = null;
let _tryAllRoutesCancelled = false;
let _boatLayer = null;
let _youLayer = null;
let _focusRayLine = null;   // ray from the boat toward the current focus target
let _headingRayLine  = null; // live direction-of-travel ray (course over ground)
let _headingRayArrow = null; // arrowhead marker at the tip of _headingRayLine
let _headingSpeedEl  = null; // DOM element of the heading/speed readout control
let _followProgressEl = null; // DOM element of the route-follow progress readout control
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
let _fixNodesMode          = false; // single-click on vertex fixes hazards near just that node — stays armed like delete
let _selectedEditNodeIdx   = new Set(); // indices into _editPoints "lit" — fixed (or checked) this edit session; purely visual, not saved route data
let _editHistory           = [];    // stack of _editPoints snapshots for undo
let _editOriginalPoints    = [];    // snapshot of route.points as last saved, taken when edit mode was entered

let _populateRouteSelectFn = null; // set by _ensureMap once DOM is ready
let _buildRoutePickerPanelFn = null; // set by _ensureMap once DOM is ready — see _populateRouteSelectFn
let _buildTrackPickerPanelFn = null; // set by _ensureMap once DOM is ready — see _buildRoutePickerPanelFn
let _exitRoutePanelCompactFn = null; // set by _ensureMap once DOM is ready — resets compact mode when Follow/Virtual Journey ends
let _closeRoutePickerFn = null; // set by _ensureMap once DOM is ready — used by _startVirtualJourney
let _savedRoutesLayer  = null;
let _hiddenRouteNames  = new Set();
let _savedTracksLayer     = null;
let _hiddenTrackNames     = new Set();
let _expandedRouteRowName = null;   // which Routes panel row (if any) shows Rename/Export
let _expandedTrackRowName = null;   // same, for the Tracks panel
let _routeSelectMode = false;       // Routes panel bulk-select mode (checkboxes replace expand-on-tap)
let _selectedRouteIds = new Set();  // ids of routes currently checked in select mode
let _routeSortMode = 'newest';      // 'newest' | 'oldest' | 'name' — in-memory only, resets on reload
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
let _followFocusLegIdx    = null; // last leg index focus was auto-synced to — see _updateFollowProgress
// Live "while underway" hazard re-check (v722, direct request): as the
// tide changes during a followed route, a crossing that was fine when the
// route was planned can become genuinely marginal. Reset whenever a new
// following session starts/stops — see _startFollowingRoute/
// _stopFollowingRoute and _recheckFollowedRouteHazardsLive.
let _followedHazardKnownKeys = new Set();
let _liveFollowHazardLayer   = null;
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
// Left on the map (NOT cleared by _clearAutoRoute) whenever autoRouteProg had
// to move a start/end point off charted-too-shallow water — otherwise the
// only visible trace of that relocation was a console.log line, and the
// route looked like it silently missed its destination. See INCIDENTS.md.
let _routeSnapMarkers = [];
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
// Virtual Journey — plays a saved route back as a genuinely moving GPS fix
// (GPS.setVirtualPosition), not a cosmetic marker, so the rest of the app
// (focus/bearing, follow-progress, anchor watch) reacts exactly as if
// actually underway. Deliberately separate from _animMode's state — see
// the markup comment on #vjourney-banner for why it can't reuse anim-mode.
let _vjRoute        = null;   // the route object being played back
let _vjSegs         = [];     // precomputed {lat1,lon1,lat2,lon2,dist,cumDist,brg}
let _vjTotalNm      = 0;
let _vjSpeedKnots   = 5;
let _vjCompress     = 1;
let _vjTraveledNm   = 0;      // persists across pause/resume
let _vjBaselineNm   = 0;      // traveled-nm snapshot at the start of the current run segment
let _vjRunStartMs   = null;   // rAF timestamp anchor for the current run segment
let _vjRafId        = null;
let _vjRunning      = false;  // true only while actually ticking (false while paused)
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
// Picked from the #map-layer-select pulldown (was a cycle-through-on-tap
// button before): street chart, satellite, Maine bedrock geology (state
// survey's own vector data — no basemap of its own, shown as an overlay on
// the street chart), history (documents only, same street basemap as
// chart), etc. USGS's national geology layer was also tried (a
// self-contained WMS raster) but dropped per live comparison — Maine's own
// data was "by far the best" (real coastline/place-name context, since it
// overlays the chart rather than replacing it). Low-Tide Aerial (Maine
// GeoLibrary orthoimagery) was tried and removed — its dynamic per-tile
// ImageServer rendering caused a real, confirmed duplicate/ghosted-tile
// bug that a zoomAnimation fix didn't fully resolve; see git history if
// revisiting this.
const MAP_VIEW_MODES  = ['chart', 'satellite', 'geology-maine', 'towns-maine', 'history', 'demographics', 'island-info', 'anchorages', 'paintings'];
// Maps a display mode to the documents.geojson `category` it shows —
// the whole reason "switch to Geology/History" needs no separate menu.
const MAP_VIEW_DOC_CATEGORY = { 'geology-maine': 'geology', 'history': 'history', 'demographics': 'demographics', 'island-info': 'island-info', 'anchorages': 'anchorages', 'paintings': 'paintings' };
// Named water passages/reaches/thorofares (plus a handful of major islands
// that fall through every other label filter — see below) worth labeling
// directly on the chart, like a real NOAA chart would — a hand-verified
// allowlist, not an automatic filter, since Query.namedPlaces' label:'sea
// area' bucket (532 entries bay-wide) covers everything from these down to
// obscure named coves/ledges/shoals with no prominence field to tell them
// apart. Every name here was confirmed present in named_places.geojson by
// exact match before being added — see _renderPassageLabels().
// "Isle Au Haut" itself is in here too, not just "Isle au Haut Thorofare" —
// it's tagged label:"coastal feature" in the source data rather than
// label:"island", so it silently fell through _renderAllIslandLabels()'s
// island-only filter and never appeared anywhere on the chart at all,
// despite being one of the most significant islands in the whole bay.
const NOTABLE_PASSAGES = new Set([
  'Merchant Row', 'Fox Islands Thorofare', 'Little Thorofare',
  'Deer Island Thorofare', 'Eggemoggin Reach', 'Isle au Haut Thorofare',
  'Casco Passage', 'Fisherman Island Passage', 'Pond Island Passage',
  'Eastern Passage', 'North East Passage', 'Gilley Thorofare',
  'Bald Hill Reach', 'The Reach', 'Western Way', 'Eastern Way',
  'Isle Au Haut',
]);
let _mapViewMode      = MAP_VIEW_MODES.includes(localStorage.getItem('audiochart-chart-mode'))
  ? localStorage.getItem('audiochart-chart-mode') : 'satellite';
let _maineGeologyLayer      = null;
let _maineGeologyMoveEnd    = null;
let _maineGeologyFetchToken = 0;
let _maineTownsLayer      = null;
let _maineTownsMoveEnd    = null;
let _maineTownsFetchToken = 0;

let _animReportLayer   = null;
let _animMilestoneLayer = null;
let _animFollowMode = false;
let _animCurrentLat = null;
let _animCurrentLon = null;
let _setAnimSpeedFn = null; // set by _startRouteAnimation, cleared by _exitAnimMode — lets #anim-speed-input change speed live, no restart
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

// The router (router.js) takes draft/tide as plain parameters rather than
// reading them itself, so it can run outside a browser (see test/test_
// channel_routing.js) — this is the one place that reads the actual DOM
// input, shared by every real (non-debug) AutoRoute call site below.
function _currentDraftFt() {
  return parseFloat(document.getElementById('nf-draft-ft')?.value) || 5.0;
}

// Same pattern as _currentDraftFt — router.js takes the deadline as a
// plain parameter (Router.DEFAULT_DEADLINE_MS) rather than a hardcoded
// constant, specifically so this can be a user preference. A single
// fixed value can't be right for every device or every user's patience:
// a real Penobscot Bay route varied 9-14s+ run to run between an ordinary
// dev machine and a slower one, for a route that always had a real, safe
// answer — see the "Route planning time limit" setting.
function _currentDeadlineMs() {
  const s = parseFloat(document.getElementById('nf-route-timeout-s')?.value);
  return isFinite(s) && s > 0 ? s * 1000 : Router.DEFAULT_DEADLINE_MS;
}

// router.js's autoRouteProg reports search progress via a plain callback
// instead of drawing a Leaflet marker itself (see router.js's own comment) —
// this is the one place that actually draws the dot, shared by every real
// (non-debug) AutoRoute call site. Call the returned function with a
// {lat,lon} on each progress tick, and with null when the search is done to
// remove the marker.
function _makeSearchDotCallback() {
  let dot = null;
  return (a) => {
    if (!a) { if (dot) { dot.remove(); dot = null; } return; }
    if (!dot) {
      dot = L.circleMarker([a.lat, a.lon], {
        radius: 5, color: '#f5a623', fillColor: '#ffffff',
        fillOpacity: 0.9, weight: 2, opacity: 0.9,
      }).addTo(_map);
    } else {
      dot.setLatLng([a.lat, a.lon]);
    }
  };
}

window._debugAutoRoute = (start, end) => Router.autoRouteProg(start, end, () => {}, () => {});

// Regression check for the curated sample-route library (Query.curatedRoutes,
// see data/regions/<id>/curated_routes.json): re-runs AutoRoute between each
// sample's own start/end and reports whether the live router can still find
// *a* safe path — not necessarily identical to the stored one ("or their
// equivalent" was the point), just genuinely threaded (>2 points) or, if it
// came back as a plain 2-point line, one that's actually clear rather than a
// silent fallback (_classifyFallbackSeg is the same land/hazard check the
// fallback-warning banner itself uses).
window._verifyCuratedRoutes = async function () {
  const routes = Query.curatedRoutes || [];
  const results = [];
  for (const r of routes) {
    const start = r.points[0], end = r.points[r.points.length - 1];
    const t0 = performance.now();
    const generated = await Router.autoRouteProg(start, end, () => {}, () => {});
    const ms = Math.round(performance.now() - t0);
    let ok, reason;
    if (generated.length > 2) {
      ok = true; reason = `threaded path, ${generated.length} points`;
    } else {
      const { crossesLand, crossesHazard } = Router.classifyFallbackSeg(generated[0], generated[1]);
      ok = !crossesLand && !crossesHazard;
      reason = ok ? 'direct line, verified clear' : `fell back to a straight line crossing ${crossesLand ? 'land' : 'a hazard'}`;
    }
    results.push({ id: r.id, name: r.name, ok, reason, ms, points: generated.length });
    console.log(`[verifyCuratedRoutes] ${ok ? 'PASS' : 'FAIL'} — ${r.name}: ${reason} (${ms}ms)`);
  }
  const passed = results.filter(r => r.ok).length;
  console.log(`[verifyCuratedRoutes] ${passed}/${results.length} passed`);
  return results;
};
window._debugResolveWaterEnd = (lon, lat, which) => Query.resolveWaterEnd(lon, lat, which);
window._debugEnterEditMode = (idx) => _enterEditMode(idx);
window._debugCheckRouteHazards = (idx, silent) => _checkRouteHazards(idx, silent);
window._debugRefreshNavaidOverlay = () => { _refreshNavaidOverlay(); return _navaidFilterLayer ? _navaidFilterLayer.getLayers().length : 0; };
window._debugComputeLikelyInboundOutbound = (catlam, name, lat, lon) => _computeLikelyInboundOutbound(catlam, name, lat, lon);
window._debugChainAscendingBearing = (name, lat, lon) => _chainAscendingBearing(name, lat, lon);
window._debugRecheckFollowedHazardsLive = (baseline) => _recheckFollowedRouteHazardsLive(baseline);
window._debugEffectiveTideHeight = () => _effectiveTideHeight();
// Sets just the "currently following" state _recheckFollowedRouteHazardsLive
// reads, without _startFollowingRoute's track-recording side effects —
// testing the live hazard-recheck in isolation.
window._debugSetFollowing = (routeId, legIdx = 1) => { _followingRouteId = routeId; _followingLegIdx = legIdx; };
window._debugMap = () => _map;
window._debugLiveHazardCheck = () => _liveHazardCheck();
window._debugShowRouteFallbackWarning = (fallbackSegs) => _showRouteFallbackWarning(fallbackSegs);
window._debugNudgeLegOffshore = (routeIdx, h) => _nudgeLegOffshore(routeIdx, h);

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

// Longtest(setName, iterations) — end-to-end AutoRoute soak test, user's
// own design (2026-10-04): bring the boat to a random marker of a Test
// Set, AutoRoute to another random marker of the same set, play the boat
// along the result, then repeat from wherever it arrived. Uses the same
// router call and the same fallback/marginal grading as a real AutoRoute
// (_triggerAutoRoute), but deliberately doesn't save the test routes into
// the user's Routes list. Run from the console:  await Longtest('TS001', 3)
// Resolves to one result row per iteration (also printed as a table).
// Optional untilSec (2026-10-05, for a music-timed demo movie): start no
// new leg after that many seconds — the leg in progress still finishes,
// then the run ends with the usual results table.
window.Longtest = async (setName, iterations = 3, { speedKnots = 5, untilSec = null } = {}) => {
  const ltStart = Date.now();
  const set = TestSetsStorage.loadTestSets().find(s => s.name.toLowerCase() === String(setName).toLowerCase());
  if (!set) throw new Error(`No Test Set named "${setName}". Have: ${TestSetsStorage.loadTestSets().map(s => s.name).join(', ')}`);
  if (set.waypoints.length < 2) throw new Error(`Test Set "${set.name}" needs at least 2 markers.`);
  // Compare by name, not object: after a leg, `here` is a fresh object
  // (the route's real end point), so an identity check let a leg pick the
  // marker it was already at (TS025 → TS025, 0nm, on 2026-10-05).
  const pick = (exclude) => {
    const pool = set.waypoints.filter(w => !exclude || w.name !== exclude.name);
    return pool[Math.floor(Math.random() * pool.length)];
  };
  const results = [];
  // Every second leg, switch to the next map type (direct request
  // 2026-10-05) so a run also exercises each mode's layers with routes and
  // the moving boat on top. Switched directly rather than through the
  // menu's change handler, so it neither overwrites the user's saved map
  // type nor starts that mode's first-visit intro tour mid-run. The
  // original map type is restored at the end.
  const mapSelect = document.getElementById('map-layer-select');
  const mapTypes = mapSelect ? [...mapSelect.options].map(o => o.value).filter(Boolean) : [];
  const originalMapType = _mapViewMode;
  const setMapType = (mode) => {
    _mapViewMode = mode;
    if (mapSelect) mapSelect.value = mode;
    _applyMapLayer();
    _syncLayerBtn();
  };
  let here = pick(null);
  _bringBoatTo(here.lat, here.lon, here.name);
  // Chrome stretches a hidden tab's timers to ~1s, and the router yields on
  // a timer every few dozen steps — a route that takes 8s in front took 51s
  // hidden and "timed out" (2026-10-04, two false failures). Wait until the
  // tab is visible before each leg's routing and playback.
  const whenVisible = () => document.hidden ? new Promise(resolve => {
    setStatus('Longtest paused — bring this tab to the front to continue.');
    const onVis = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', onVis); resolve(); } };
    document.addEventListener('visibilitychange', onVis);
  }) : Promise.resolve();
  for (let i = 1; i <= iterations; i++) {
    await whenVisible();
    if (untilSec && (Date.now() - ltStart) / 1000 >= untilSec) break;
    if (i > 1 && i % 2 === 1 && mapTypes.length) {
      const next = mapTypes[(mapTypes.indexOf(_mapViewMode) + 1) % mapTypes.length];
      setMapType(next);
    }
    const dest = pick(here);
    const start = { lat: here.lat, lon: here.lon };
    const end = { lat: dest.lat, lon: dest.lon };
    setStatus(`Longtest ${i}/${iterations}: ${here.name} → ${dest.name}…`);
    const t0 = performance.now();
    let pts;
    try {
      pts = await Router.autoRouteProg(start, end, () => {}, () => {}, false,
        _currentDraftFt(), _tideHeight, null, null, _currentDeadlineMs());
    } catch (err) {
      results.push({ iter: i, from: here.name, to: dest.name, result: `ERROR: ${err.message}` });
      break;
    }
    const ms = Math.round(performance.now() - t0);
    const crossesLand = pts.some((p, k) => k > 0 && Query.landBlocks(pts[k - 1].lon, pts[k - 1].lat, p.lon, p.lat));
    const fellBack = pts.length <= 2 && crossesLand;
    const marginal = pts.length > 2 ? _marginalLegFromPath(pts) : null;
    const nm = pts.reduce((s, p, k) => k ? s + Query.distanceNm(pts[k - 1].lon, pts[k - 1].lat, p.lon, p.lat) : 0, 0);
    // Which kind of "tight" and how tight — router.js tags the flagged node
    // with marginalKind and marginalClearanceNm (2026-10-05, direct request).
    const mNode = marginal ? pts.find(p => p.marginal) : null;
    const mDist = mNode?.marginalClearanceNm != null ? ` (${Math.round(mNode.marginalClearanceNm * 1852)}m)` : '';
    const result = fellBack ? (pts._timedOut ? 'FAIL: timed out → straight line' : 'FAIL: no path → straight line')
      : crossesLand ? 'FAIL: route crosses land'
      : marginal ? (mNode?.marginalKind === 'shoal' ? `WARN: near shoal${mDist}` : `WARN: near shore${mDist}`)
      : 'PASS';
    results.push({ iter: i, from: here.name, to: dest.name, map: _mapViewMode, result, points: pts.length, nm: +nm.toFixed(1), ms });
    // Play it — even a failed route, so a straight line through land is visible.
    _startRouteAnimation({ name: `Longtest ${i}: ${here.name} → ${dest.name}`, points: pts }, speedKnots);
    await new Promise((resolve) => {
      const tick = setInterval(() => {
        if (!_animMode || _animBannerText.textContent.startsWith('✓')) { clearInterval(tick); resolve(); }
      }, 250);
    });
    await new Promise(r => setTimeout(r, 1500)); // let the arrival view settle
    if (_animMode) _exitAnimMode();
    // Advance: the boat continues from where it arrived. After a failed leg
    // the route's end isn't a real arrival, so jump to the intended
    // destination marker instead and keep testing rather than stopping.
    const last = pts[pts.length - 1];
    here = (fellBack || crossesLand) ? dest : { ...dest, lat: last.lat, lon: last.lon };
    _bringBoatTo(here.lat, here.lon, dest.name);
  }
  if (mapTypes.length && _mapViewMode !== originalMapType) setMapType(originalMapType);
  console.table(results);
  _showLongtestResults(set.name, results, null); // on-screen table, however Longtest was started
  window._longtestEndedAt = Date.now(); // lets a screen recording be trimmed to the run's end
  const passed = results.filter(r => r.result === 'PASS').length;
  const summary = `Longtest ${set.name}: ${passed}/${results.length} legs passed.`;
  setStatus(summary);
  console.log(summary);
  return results;
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
// "peek" pattern). Collapsed by default (see index.html) and stays that way
// through new lines arriving in the background — only an explicit tap opens it.
document.getElementById('response-close-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  _collapseResponseArea();
});
_addSwipeToClose(responseAreaEl, _collapseResponseArea, 'y');
// Tapping anywhere outside the expanded transcript closes it back to the peek
// bar, same as the × button — a normal "open panel, tap away to dismiss" gesture.
document.addEventListener('click', (e) => {
  if (responseAreaEl.classList.contains('collapsed')) return;
  if (!responseAreaEl.contains(e.target)) _collapseResponseArea();
});

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

// Tap-shown tooltip — see .btn-tap-tooltip's own comment in app.css for
// why this exists (native `title` never appears on a touch-only device).
// Purely additive: touchstart shows the bubble, the button's own click
// still fires completely normally right afterward. One shared bubble
// element reused across every button this is attached to, rather than
// creating/destroying a fresh element per tap.
let _tapTooltipEl = null;
let _tapTooltipTimer = null;
function _addTapTooltip(btn) {
  const text = btn.getAttribute('title');
  if (!text) return;
  btn.addEventListener('touchstart', () => {
    if (!_tapTooltipEl) {
      _tapTooltipEl = document.createElement('div');
      _tapTooltipEl.className = 'btn-tap-tooltip';
      document.body.appendChild(_tapTooltipEl);
    }
    clearTimeout(_tapTooltipTimer);
    _tapTooltipEl.textContent = text;
    _tapTooltipEl.style.display = 'block';
    const rect = btn.getBoundingClientRect();
    const bubbleRect = _tapTooltipEl.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - bubbleRect.width / 2;
    left = Math.min(Math.max(4, left), window.innerWidth - bubbleRect.width - 4);
    const top = Math.max(4, rect.top - bubbleRect.height - 8);
    _tapTooltipEl.style.left = `${left}px`;
    _tapTooltipEl.style.top = `${top}px`;
    _tapTooltipTimer = setTimeout(() => { _tapTooltipEl.style.display = 'none'; }, 1800);
  }, { passive: true });
}

// Drag-to-reposition for floating panels, so they can be moved out of the way — grab
// `handleEl` (its title bar) and drag; position is clamped to stay on-screen. Works with
// both touch and mouse. Position sticks for the rest of the page session (the panel is
// just hidden/shown via display, never removed, so the inline left/top persist).
function _makeDraggable(panelEl, handleEl) {
  let dragging = false, moved = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
  // Below this, a move is just hand tremor, not a drag attempt — matters for
  // handles that are ALSO a click target in their own right (e.g. Node Ops'
  // title doubles as its collapse/expand toggle): without a threshold, the
  // native click that follows every mouseup/touchend would fire right along
  // with a real drag, toggling collapse every time the panel gets moved.
  const DRAG_THRESHOLD_PX = 6;

  function begin(clientX, clientY) {
    dragging = true;
    moved = false;
    startX = clientX;
    startY = clientY;
    const rect = panelEl.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    panelEl.style.transition = 'none';
  }
  function moveTo(clientX, clientY) {
    if (!dragging) return;
    if (!moved && Math.hypot(clientX - startX, clientY - startY) < DRAG_THRESHOLD_PX) return;
    moved = true;
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

  // Swallow exactly the one click that follows a real drag gesture — see the
  // threshold comment above. A plain tap (moved stays false) passes through
  // untouched, so a handle with no click behavior of its own (every caller
  // but Node Ops' title) is completely unaffected.
  handleEl.addEventListener('click', (e) => {
    if (moved) { e.stopImmediatePropagation(); e.preventDefault(); moved = false; }
  }, { capture: true });
}

// Shrink-to-title for the open/close floating panels — direct request: "put
// shrink buttons on all the ui windows, like the Objects window already
// has." Objects/Node Ops toggle by tapping the title itself; these panels'
// titles already carry a ✕ (and Routes' a Focus toggle), so this adds an
// explicit ▴/▾ button beside the ✕ instead. Collapsed hides every child but
// .nf-title (CSS: .panel-collapsed). Reopening a closed panel always starts
// expanded — you open a panel to use it, not to find just its title bar.
function _makeCollapsible(panelEl) {
  const title = panelEl.querySelector('.nf-title');
  const closeBtn = title.querySelector('button[id$="close"]');
  let actions = closeBtn.closest('.nf-title-actions');
  if (!actions) {
    actions = document.createElement('span');
    actions.className = 'nf-title-actions';
    title.insertBefore(actions, closeBtn);
    actions.appendChild(closeBtn);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nf-shrink-btn';
  const sync = () => {
    const collapsed = panelEl.classList.contains('panel-collapsed');
    btn.textContent = collapsed ? '▾' : '▴';
    btn.title = collapsed ? 'Expand this window' : 'Shrink this window to just its title';
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panelEl.classList.toggle('panel-collapsed');
    sync();
  });
  actions.insertBefore(btn, closeBtn);
  let wasOpen = panelEl.classList.contains('open');
  new MutationObserver(() => {
    const isOpen = panelEl.classList.contains('open');
    if (isOpen && !wasOpen) { panelEl.classList.remove('panel-collapsed'); sync(); }
    wasOpen = isOpen;
  }).observe(panelEl, { attributes: true, attributeFilter: ['class'] });
  sync();
}

// ── Draggable UI groups: a few permanent widgets can be dragged out of the
// way at any time (focus button, tide widget, right rail) ──────────────────
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
function _makeDraggableGroup(groupId, getEls, alwaysOn = false, excludeSelector = null) {
  let curDx = 0, curDy = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(`audiochart-ui-pos-${groupId}`) || 'null');
    if (saved) { curDx = saved.dx; curDy = saved.dy; }
  } catch (_) {}

  // Exclude currently display:none elements (e.g. #delete-route-btn outside edit mode) —
  // a hidden element's getBoundingClientRect() is a zero-size rect at (0,0), which would
  // otherwise corrupt the clamp math for the rest of the group. Was offsetParent !== null,
  // which does that correctly for statically/absolutely-positioned elements, but per spec
  // (confirmed the actual cause of the target button not being draggable) offsetParent is
  // ALWAYS null for a position:fixed element regardless of visibility — silently excluding
  // #focus-btn (and .tide-cycle-ctrl/.heading-speed-ctrl on mobile, also position:fixed
  // there) from every group operation, no matter what. getClientRects().length still
  // correctly comes back empty for a real display:none element, but isn't fooled by fixed
  // positioning the way offsetParent is.
  const currentEls = () => getEls().filter(el => el && el.getClientRects().length > 0);
  const applyOffset = (dx, dy) => _appEl.style.setProperty(`--ui-pos-${groupId}`, `translate(${dx}px, ${dy}px)`);
  // Clamp a restored position before ever painting it — a dx/dy saved on a
  // taller/wider screen (e.g. a tablet) can push a widget off-screen (per
  // direct report: compass/tide flowing off the top) when the same saved
  // position loads on a smaller window. The resize listener below only
  // catches this after an actual resize event, never on a fresh page load.
  {
    const els = currentEls();
    if (els.length) {
      const clamped = _clampGroupOffset(els, curDx, curDy, 0, 0);
      curDx = clamped.dx; curDy = clamped.dy;
    }
  }
  applyOffset(curDx, curDy); // restore any saved position immediately

  let dragging = false;
  let moved = false; // real movement happened since begin() — see the click-swallow note below
  let startX = 0, startY = 0, baseDx = 0, baseDy = 0, origins = [];

  function begin(clientX, clientY) {
    dragging = true;
    moved = false;
    startX = clientX; startY = clientY;
    baseDx = curDx; baseDy = curDy;
    origins = currentEls();
  }
  // Below this, a move is ignored outright — no reposition, no click-swallow
  // flag set. #focus-btn's whole reason for existing is reliable taps with
  // wet hands/gloves/boat motion — without a threshold, ordinary tremor
  // while pressing it would both nudge its position by a pixel or two AND
  // swallow the bearing announcement on a normal tap.
  const DRAG_THRESHOLD_PX = 8;
  function moveTo(clientX, clientY) {
    if (!dragging) return;
    if (!moved && Math.hypot(clientX - startX, clientY - startY) < DRAG_THRESHOLD_PX) return;
    moved = true;
    const { dx, dy } = _clampGroupOffset(origins, baseDx + (clientX - startX), baseDy + (clientY - startY), baseDx, baseDy);
    curDx = dx; curDy = dy;
    applyOffset(dx, dy);
  }
  function end() {
    if (!dragging) return;
    dragging = false;
    localStorage.setItem(`audiochart-ui-pos-${groupId}`, JSON.stringify({ dx: curDx, dy: curDy }));
  }

  // Dragging only ever starts for groups passed alwaysOn=true (every current
  // caller). Touch already suppresses its own native 'click' after real
  // movement, but mouse doesn't — a desktop drag ends with the cursor (and
  // the button, since it followed it) in the same place, so mouseup there
  // still fires a normal click same-element click same as any non-dragged
  // click would. The capturing click listener below swallows exactly one
  // click when `moved` was set during the gesture that just ended, so
  // dragging #focus-btn on desktop doesn't also speak the bearing.
  currentEls().forEach(el => {
    el.classList.add('ui-drag-target');
    const gateOpen = () => alwaysOn;
    // excludeSelector lets an alwaysOn group contain its own drag-driven
    // controls (tide's scrub slider) without this outer whole-panel drag
    // hijacking their own touch/mouse gestures — those elements are left
    // completely alone (no begin(), so no preventDefault on their own
    // touchmove either) and handle themselves exactly as if this group
    // didn't exist.
    const excluded = (e) => alwaysOn && excludeSelector && e.target.closest(excludeSelector);

    el.addEventListener('touchstart', (e) => {
      if (!gateOpen() || e.touches.length !== 1 || excluded(e)) return;
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
      if (!gateOpen() || excluded(e)) return;
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

    el.addEventListener('click', (e) => {
      if (moved) { e.stopImmediatePropagation(); e.preventDefault(); moved = false; }
    }, { capture: true });
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

// One-time cleanup: 'tide' and 'headingspeed' just moved from the top-right
// Leaflet corner to a fixed lower-right lane (see the .tide-cycle-ctrl /
// .heading-speed-ctrl mobile rule in app.css) — any offset a user dragged in
// under the OLD base position (saved forever in localStorage by
// _makeDraggableGroup, and re-applied on every load regardless of how the
// underlying layout changes) is now measured from the wrong anchor and can
// land the widget anywhere, including fully offscreen or hidden behind
// something else. 'compass' didn't move, but gets the same treatment since a
// stale offset there would be silently just as invisible and just as hard
// to tell apart from "never rendered at all". Runs once per browser/device —
// _makeDraggableGroup reads these keys immediately, so this must run first.
if (localStorage.getItem('audiochart-uipos-migration-v479') !== '1') {
  ['tide', 'headingspeed', 'compass'].forEach(id => localStorage.removeItem(`audiochart-ui-pos-${id}`));
  localStorage.setItem('audiochart-uipos-migration-v479', '1');
}

function _initDraggableGroups() {
  // Only three widgets are draggable at all now: the focus button, the tide
  // widget, and the right rail (all alwaysOn — no separate "rearrange mode"
  // exists to gate anything else). navctl/version/cmdbar/headingspeed/
  // followprogress/status/compass/btncol used to have their own drag groups
  // but were all removed over time (either because dragging them made no
  // sense once laid out in a flex column, or per explicit decision they're
  // too important to risk going missing with no way back) — their old saved
  // offsets are scrubbed here so a device that has one lingering in
  // localStorage from years ago self-heals rather than leaving dead keys
  // around forever.
  for (const id of ['status', 'compass', 'btncol', 'navctl', 'version', 'cmdbar', 'headingspeed', 'followprogress']) {
    localStorage.removeItem(`audiochart-ui-pos-${id}`);
  }
  // Excluding the slider/play button so this outer whole-widget drag
  // doesn't hijack the slider's own drag-to-scrub gesture — those two
  // elements are left completely alone to handle their own touch/mouse
  // events exactly as if this group didn't exist.
  _makeDraggableGroup('tide', () => [...document.querySelectorAll('.tide-cycle-ctrl')], true, '#tide-offset-slider, #tide-play-btn');
  // Draggable at any time per explicit request — this is the one control
  // worth moving on the fly, since its whole point is a spot you reach for
  // without looking. A plain tap still speaks the bearing/range as normal;
  // see the click-swallow note in _makeDraggableGroup for how the two coexist.
  _makeDraggableGroup('focus', () => [document.getElementById('focus-btn')], true);
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
  // Per explicit direction, new lines land quietly in the background —
  // logging a line is not a reason to pop the transcript open over the map.
  // Only clear the initial inline display:none (so the collapsed peek bar
  // itself is visible), leave whatever collapsed/expanded state it's
  // currently in alone either way.
  responseAreaEl.style.display = '';
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

// #draw-banner and #route-dest-banner are normal-flow siblings of the
// Leaflet map, so showing one shrinks the map to make room for it at the
// bottom of the viewport — but #bottom-hud is position:fixed to the
// viewport's own bottom edge, not to the map's shrunk box, so it doesn't
// move out of the way on its own. Confirmed live on a phone: the tide
// widget sat directly on top of the "Name" button in the destination
// banner, matching the exact same collision #app.edit-mode #bottom-hud
// already fixes for #edit-banner. Both destination-tap banners share
// this one helper rather than duplicating the same two lines four times.
function _setBottomHudHiddenForBanner(hidden) {
  const el = document.getElementById('bottom-hud');
  if (el) el.style.display = hidden ? 'none' : '';
}

const _drawBanner   = document.getElementById('draw-banner');
const _drawBannerLabel = document.getElementById('draw-banner-label');
const _drawUsePositionBtn = document.getElementById('draw-use-position-btn');
const _drawNameDestBtn    = document.getElementById('draw-name-dest-btn');
const _drawConfirmBtn  = document.getElementById('draw-confirm-btn');

// ── Saved-route persistent display ────────────────────────────────────────────

// ── Documents ─────────────────────────────────────────────────────────────────
// Hand-curated reference material tied to a place — tap a spot on the map,
// pick from a table of relevant documents, read a short excerpt, open the
// full source. Deliberately generic (category field, not a geology-specific
// shape) per explicit user direction: "not just geology, but other features
// as well" and eventually community-contributed. Loaded once, eagerly, like
// the other small local datasets — no offline-region complexity needed yet
// given how few entries this starts with; the service worker's existing
// generic network-first/cache-fallback strategy for *.geojson already makes
// this available offline after the first successful fetch, same as every
// other data file here.
let _documents = [];
fetch('./data/documents.geojson')
  .then(r => r.json())
  .then(d => { _documents = d.features || []; _renderDocumentMarkers(); _renderAllIslandLabels(); _renderPassageLabels(); })
  .catch(() => {});

function _formatDocBody(text) {
  return (text || '').split('\n\n').map(p => `<p style="margin:0 0 6px">${p}</p>`).join('');
}

// Demographics entries carry structured data (population/medianAge/ageBrackets/
// seasonal) instead of prose — the user asked for "a table showing age and
// population," not a paragraph. Each figure is individually dated to its real
// census year rather than implied as current, since 2020-level detail (median
// age, age brackets) often isn't published yet for small Maine towns and the
// most recent real number available is still 2010. Seasonal contrast is only
// shown when a genuine documented source said something concrete — most small
// island/coastal towns have no such figure, and this omits the row rather than
// invent one.
function _formatDemographics(p) {
  const d = p.demographics || {};
  const rows = [];
  if (d.population) {
    rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666">Population</td><td><b>${d.population.value.toLocaleString()}</b> <span style="color:#888">(${d.population.year})</span></td></tr>`);
  }
  if (d.medianAge && d.medianAge.value != null) {
    rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666">Median age</td><td><b>${d.medianAge.value}</b> <span style="color:#888">(${d.medianAge.year})</span></td></tr>`);
  }
  let bracketsHtml = '';
  if (d.ageBrackets && d.ageBrackets.brackets) {
    bracketsHtml = `<div style="margin-top:6px;font-size:0.82em;color:#666">Age distribution (${d.ageBrackets.year} Census):</div>
      <table style="width:100%;border-collapse:collapse;margin-top:2px">
        ${Object.entries(d.ageBrackets.brackets).map(([k, v]) => `<tr><td style="padding:1px 10px 1px 0;color:#555">${k}</td><td>${v}%</td></tr>`).join('')}
      </table>`;
  }
  let seasonalHtml = '';
  if (d.seasonal) {
    seasonalHtml = `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #ddd;font-size:0.85em">${d.seasonal}</div>`;
  }
  return `<table style="width:100%;border-collapse:collapse">${rows.join('')}</table>${bracketsHtml}${seasonalHtml}`;
}

// Island Info entries answer the boater's practical question before landing:
// who owns this, can I actually go ashore, is it on the Maine Island Trail
// (MITA's handshake-agreement network — trail status is never assumed, only
// stated when a real source confirms or explicitly denies it), and is it
// held by a land trust. Structured like demographics, not prose, for the
// same reason: this is lookup data, not a story.
function _formatIslandInfo(p) {
  const d = p.islandInfo || {};
  const rows = [];
  if (d.ownership) rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Ownership</td><td>${d.ownership}</td></tr>`);
  if (d.landTrust) rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Land trust</td><td>${d.landTrust}</td></tr>`);
  if (d.onMaineIslandTrail != null) {
    const mitaText = d.onMaineIslandTrail === true ? 'Yes' : (d.onMaineIslandTrail === false ? 'No' : 'Not documented');
    rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Maine Island Trail</td><td>${mitaText}</td></tr>`);
  }
  if (d.publicAccess) rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Public access</td><td>${d.publicAccess}</td></tr>`);
  let notesHtml = '';
  if (d.notes) {
    notesHtml = `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #ddd;font-size:0.85em">${d.notes}</div>`;
  }
  return `<table style="width:100%;border-collapse:collapse">${rows.join('')}</table>${notesHtml}`;
}

// Practical mooring/anchoring guidance — deliberately separate from
// island-info's general facts (ownership, land trust, public access):
// this is the "where do I actually put the boat tonight" category,
// safety-adjacent enough to earn its own map mode and marker color
// rather than being buried in island-info's popups. Same doc-schema
// pattern as _formatIslandInfo, a d.anchorage sub-object on the document.
function _formatAnchorage(p) {
  const d = p.anchorage || {};
  const rows = [];
  if (d.moorings) rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Moorings</td><td>${d.moorings}</td></tr>`);
  if (d.anchoringNotes) rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Anchoring</td><td>${d.anchoringNotes}</td></tr>`);
  if (d.holdingGround) rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Holding ground</td><td>${d.holdingGround}</td></tr>`);
  if (d.protection) rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Protection</td><td>${d.protection}</td></tr>`);
  if (d.fee) rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Fee</td><td>${d.fee}</td></tr>`);
  if (d.contact) rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Contact</td><td>${d.contact}</td></tr>`);
  let notesHtml = '';
  if (d.notes) {
    notesHtml = `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #ddd;font-size:0.85em">${d.notes}</div>`;
  }
  return `<table style="width:100%;border-collapse:collapse">${rows.join('')}</table>${notesHtml}`;
}

// Iconic Painting mode (v1, public-domain only — see the curation note
// above the paintings entries in documents.geojson for the research
// standard). Each entry ties one real, documented painting to the
// specific spot it depicts. Not every entry has an imageAsset: a couple
// of well-documented paintings (Jonathan Fisher's 1824 Blue Hill view,
// John Marin's 1928 Stonington watercolor) have no legally-reproducible
// digitized copy available to bundle offline, so those stay text-and-
// citation only, same as any other category.
function _formatPainting(p) {
  const d = p.painting || {};
  const rows = [];
  if (d.artist) rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Artist</td><td>${d.artist}</td></tr>`);
  if (d.year) rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Year</td><td>${d.year}</td></tr>`);
  if (d.collection) rows.push(`<tr><td style="padding:2px 10px 2px 0;color:#666;vertical-align:top">Collection</td><td>${d.collection}</td></tr>`);
  const imgHtml = d.imageAsset
    ? `<img src="${d.imageAsset}" alt="${p.title}" style="width:100%;border-radius:4px;margin-bottom:6px;display:block">`
    : '';
  const storyHtml = d.story
    ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #ddd;font-size:0.85em">${d.story}</div>`
    : '';
  return `${imgHtml}<table style="width:100%;border-collapse:collapse">${rows.join('')}</table>${storyHtml}`;
}

// The full text lives in the geojson (see documents.geojson's own header note)
// so this popup needs nothing from the network — tap the marker, read the
// real content, no link-out required. Replaced an earlier "excerpt + Open
// link" design per direct feedback: the link opened a 60-page PDF from page
// 1 (never actually landing on the relevant section), and more fundamentally
// broke the offline-first principle this app is built on — reading a
// document while underway can't depend on a live connection. Markers only
// show for whichever category matches the active display mode
// (MAP_VIEW_DOC_CATEGORY) — per explicit direction, "switch to Geology/
// History display" IS the way to see that category's documents, no
// separate menu. History further filters by _selectedEra, since that
// category is subdivided by era (colonial/revolution/industrial/modern);
// 'all' shows every era. Demographics entries carry structured population/
// age data (see _formatDemographics) instead of prose body text; Island
// Info entries similarly carry structured ownership/access data (see
// _formatIslandInfo).
let _documentMarkersLayer = null;
let _selectedEra = 'all';
function _renderDocumentMarkers() {
  if (_documentMarkersLayer) { _map.removeLayer(_documentMarkersLayer); _documentMarkersLayer = null; }
  const category = MAP_VIEW_DOC_CATEGORY[_mapViewMode];
  if (!_map || !_documents.length || !category) return;
  const visible = _documents.filter(f => {
    if (f.properties.category !== category) return false;
    if (category === 'history' && _selectedEra !== 'all' && f.properties.era !== _selectedEra) return false;
    return true;
  });
  const markers = visible.map(f => {
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties;
    const bodyHtml = p.category === 'demographics' ? _formatDemographics(p)
      : p.category === 'island-info' ? _formatIslandInfo(p)
      : p.category === 'anchorages' ? _formatAnchorage(p)
      : p.category === 'paintings' ? _formatPainting(p)
      : _formatDocBody(p.body);
    const m = L.marker([lat, lon], { icon: MarkerIcons.documentMarkerIcon(p.category) });
    // Anchorages carry a short code (AS001…, in documents.geojson) so they
    // can be named by voice — "AutoRoute to AS005" — like SP/TS markers.
    if (p.code) m.bindTooltip(escapeHtml(p.code), { permanent: true, direction: 'top', className: 'map-tooltip' });
    // Lets the "Take a Tour" engine find a specific document marker by its
    // title (e.g. the flagship tour's Warren Island step) without a new
    // fetch or a second data structure — see _findDocumentMarkerByTitle.
    m._tourTitle = p.title;
    // Island Info's own online-lookup supplement (see _wireIslandLookup) —
    // never for geology/history/demographics, and appended, never mixed into
    // bodyHtml, so it stays visually separate from the self-contained
    // offline write-up above it.
    const lookupHtml = p.category === 'island-info' ? _wireIslandLookup(m, lat, lon) : '';
    // Anchorages: the one document category that names an actual place to
    // put the boat, not background reading — gets the same action set as a
    // waypoint's own marker popup (direct request), reusing its exact
    // button classes for free styling/consistency rather than duplicating
    // rules under a new doc-popup-* name. "Navigate to here" keeps its
    // original class/label (doc-popup-navigate, not "AutoRoute from boat
    // position") alongside the shared one — _takeTour's Warren Island step
    // narrates "tap Navigate to here" by that exact label and finds it by
    // that exact class (see _startVirtualJourney below), so both stay put;
    // navaid-popup-autoroute is added ONLY for matching visual styling.
    const navHtml = p.category === 'anchorages'
      ? `<div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
           <button class="doc-popup-navigate navaid-popup-autoroute">&#9973; Navigate to here</button>
           <button class="navaid-popup-focus">&#127919; Set focus</button>
           <button class="navaid-popup-bring-boat">&#9935; Bring boat here</button>
           <button class="navaid-popup-objects">Objects within &rsaquo;</button>
           <button class="navaid-popup-routes-near">Routes within &rsaquo;</button>
           <button class="navaid-popup-tracks-near">Tracks within &rsaquo;</button>
         </div>`
      : '';
    // Paintings gets a wider popup than the other text-only categories —
    // the bundled reproduction image needs real room, not a 260px squeeze.
    const html = `<div style="font-size:13px;line-height:1.5;max-width:${p.category === 'paintings' ? 300 : 260}px">
      <b>${p.code ? `${p.code} · ` : ''}${p.title}</b><br><span style="color:#666">${p.place}</span>
      <div style="margin-top:6px">${bodyHtml}</div>
      <div style="margin-top:4px;font-style:italic;font-size:0.78em;color:#888">${p.source}</div>
      ${lookupHtml}
      ${navHtml}
    </div>`;
    if (p.category === 'anchorages') {
      m.on('popupopen', (e) => {
        const popupEl = e.popup.getElement();
        popupEl.querySelector('.doc-popup-navigate').addEventListener('click', () => {
          _map.closePopup();
          _autoRouteFromBoatToHereFn?.(lat, lon);
        });
        popupEl.querySelector('.navaid-popup-focus').addEventListener('click', () => {
          _map.closePopup();
          Query.setFocus(lat, lon, p.title, 'place');
          _updateFocusButton();
          const msg = `Focused on ${p.title}.`;
          showResponse(msg);
          TTS.sayImmediate(msg);
        });
        popupEl.querySelector('.navaid-popup-bring-boat').addEventListener('click', () => {
          _map.closePopup();
          _bringBoatTo(lat, lon, p.title);
        });
        popupEl.querySelector('.navaid-popup-objects').addEventListener('click', (ev) => {
          const rect = ev.currentTarget.getBoundingClientRect(); // before closePopup() detaches it
          _map.closePopup();
          _openNearPointFlyout(document.getElementById('map-ctx-objects-submenu'), rect, { lat, lng: lon });
        });
        popupEl.querySelector('.navaid-popup-routes-near').addEventListener('click', (ev) => {
          const rect = ev.currentTarget.getBoundingClientRect();
          _map.closePopup();
          _openNearPointFlyout(document.getElementById('map-ctx-routes-near-submenu'), rect, { lat, lng: lon });
        });
        popupEl.querySelector('.navaid-popup-tracks-near').addEventListener('click', (ev) => {
          const rect = ev.currentTarget.getBoundingClientRect();
          _map.closePopup();
          _openNearPointFlyout(document.getElementById('map-ctx-tracks-near-submenu'), rect, { lat, lng: lon });
        });
      });
    }
    // Paintings: Leaflet's autoPan runs once, synchronously, when the popup
    // opens — using whatever height the DOM has *right then*. The <img>
    // hasn't loaded yet at that instant (no width/height attribute to give
    // it intrinsic size up front), so the popup is measured short, autoPan
    // barely pans (or doesn't), and then the image loads a moment later,
    // the popup grows underneath it, and the top of a popup near the top of
    // the viewport ends up off-screen with no further autoPan to fix it.
    // popup.update() re-measures and re-runs autoPan — call it once the
    // image (if any) actually finishes loading.
    if (p.category === 'paintings') {
      m.on('popupopen', (e) => {
        const img = e.popup.getElement().querySelector('img');
        if (img && !img.complete) {
          img.addEventListener('load', () => e.popup.update(), { once: true });
        }
      });
    }
    // maxHeight is a built-in Leaflet Popup option — it caps .leaflet-popup-content's
    // height and adds overflow-y:auto automatically, so a long entry (several
    // paragraphs) scrolls inside the popup instead of running off the bottom of
    // the screen, which is what was happening before (visible in a live screenshot —
    // the last paragraph was cut off at the viewport edge with no way to read it).
    return m.bindPopup(html, { maxWidth: 280, maxHeight: 380 });
  });
  _documentMarkersLayer = L.layerGroup(markers).addTo(_map);
}

// The one place the tour engine needs a narrow, named hook into app.js's
// marker layer rather than staying purely generic (CSS selector/DOM-only)
// — Leaflet markers aren't in the DOM at all until their layer is added,
// and there's no stable selector for "the marker whose popup is titled X."
function _findDocumentMarkerByTitle(title) {
  if (!_documentMarkersLayer) return null;
  let found = null;
  _documentMarkersLayer.eachLayer(m => { if (m._tourTitle === title) found = m; });
  return found;
}

// ── "Take a Tour" content ───────────────────────────────────────────────
// tour.js owns the generic callout engine; everything here is app-specific
// step content that plugs into it. The only trigger pattern left in active
// use: a one-step overview auto-shown the first time a user switches into
// a given map mode (see the map-layer-select 'change' listener). The
// click-through "discover a destination and plot a route" tour that used
// to live here (About panel's old "Guided tours" list) was superseded by
// the per-route auto-playing "movie" (see _playRouteMovie) — a passive,
// narrated walkthrough is what was actually wanted for showing off what a
// route offers, not a tutorial requiring the viewer to perform each click
// themselves.

// First time in Geology mode, per direct request ("maybe there is a flag
// so, for their first time in Geology mode, they get an overview").
// MODE_INTROS has no entries for the other 7 modes — genuinely absent,
// not stubbed, until there's real content worth writing for each.
const MODE_INTROS = {
  'geology-maine': [
    {
      target: '#map-layer-select',
      text: "You're viewing Maine Geological Survey bedrock and surficial data over the chart. Tap any colored marker for the write-up on that spot.",
    },
  ],
};

function _maybeShowModeIntro(mode) {
  // Never preempt a tour already in progress — the engine only tracks one
  // active tour at a time, so starting a second here would silently
  // hijack it. The mode intro simply doesn't fire that time; it'll still
  // be there the next time this mode is entered outside of a tour.
  if (Tour.isTourActive() || Tour.isModeIntroSeen(mode) || !MODE_INTROS[mode]) return;
  Tour.startTour({ id: `mode-intro-${mode}`, steps: MODE_INTROS[mode] }, {
    onComplete: () => Tour.markModeIntroSeen(mode),
  });
}

// ── Sample route "movies" ─────────────────────────────────────────────────
// A passive, auto-playing, narrated walkthrough per curated sample route —
// per direct request, this replaced an earlier click-through tour design:
// "it should be a movie, where you basically watch it drive... show the
// user what's possible, like changing modes and clicking on History and
// Geology links, and also hit the preview button, to show the little boat
// sailing along the route." Triggered by the "▶ Watch" button on each
// sample route in the Routes panel (see _renderSampleRouteList) — the
// routes themselves stay freely explorable on their own; this is purely an
// additional, optional demonstration layer.
//
// destinationTitle/historyTitle are each a genuine documents.geojson entry
// (confirmed live, closest real history write-up to each destination —
// see the commit this was added in for the exact query used), used both
// to locate the real marker/popup to open for that step AND as the source
// text for historyCaption below — a ~25-word summary of that document's
// actual body, not a generic mode-switch line (v656, per direct request:
// "click on a document, summarize its contents in 25 words or so... take
// your time, you're trying to entertain the user"). geologyCaption is the
// real Maine Geological Survey bedrock classification for that area,
// queried live against the same MGS_Bedrock_500K FeatureServer
// _refreshMaineGeologyLayer itself calls — geology mode has no clickable
// per-feature popup the way documents do (only a hover tooltip), so this
// is authored once from that same live data rather than "clicked" live.
const ROUTE_MOVIES = {
  'rockland-warren-island': {
    destinationTitle: 'Warren Island State Park — Anchorage & Moorings',
    historyTitle: "A 1692 raid, and the tradition it didn't manage to end",
    place: 'Warren Island',
    audioId: 'warren-island',
    historyCaption: "In 1692, an English captain raided this island, driving off Penobscot and Tarratine people who'd summered here for generations — but they kept coming back for centuries.",
    geologyCaption: "This stretch of coast sits on some of Maine's oldest bedrock — Precambrian gneiss, limestone, marble, and slate, folded long before the granite you'll see further inland.",
  },
  'rockland-carvers-harbor': {
    destinationTitle: 'Carvers Harbor — Anchorage & Moorings',
    historyTitle: "The first lobstermen's union in the country",
    place: 'Carvers Harbor',
    audioId: 'carvers-harbor',
    historyCaption: "In the winter of 2012, Vinalhaven's lobstermen formed the country's first lobstermen's union — modern labor organizing on an island once built by granite quarrying.",
    geologyCaption: "Vinalhaven sits on Silurian granite — the same rock its famous quarries cut for over a century, grading into marine sandstone and slate further out.",
  },
  'rockland-perry-creek': {
    destinationTitle: 'Perry Creek — Anchorage & Moorings',
    historyTitle: 'A lost race, a faster boat, and 140 years of grudge matches',
    place: 'Perry Creek',
    audioId: 'perry-creek',
    historyCaption: "A sailor lost a race here in 1883, built a faster boat out of spite, and started what's now the oldest continuously raced one-design fleet in North America.",
    geologyCaption: "The bedrock here is a genuine mash-up — ancient Precambrian marble and gneiss sitting right alongside much younger granite and slate.",
  },
  'rockland-stonington-overnight': {
    destinationTitle: 'Stonington Harbor — Anchorage & Moorings',
    historyTitle: "Maine's last working granite quarry",
    place: 'Stonington',
    audioId: 'stonington',
    historyCaption: "Crotch Island has been quarried since 1869. Its pink granite went into the Brooklyn Bridge's approaches, and it's still Maine's last working island quarry today.",
    geologyCaption: "It's no coincidence — this whole area is Devonian granite and granodiorite, the same rock the quarry has been cutting for a century and a half.",
  },
  'rockland-woodenboat-school': {
    destinationTitle: 'WoodenBoat School Waterfront',
    historyTitle: 'Three thousand years of camps on Eggemoggin Reach',
    place: 'WoodenBoat School',
    audioId: 'woodenboat-school',
    historyCaption: "Digs at Scott's Landing found shell middens showing people camping and fishing here for three thousand years — long before Eggemoggin Reach had a European name.",
    geologyCaption: 'The bedrock here is Devonian granite, the same family of rock that runs down through Stonington, with older metamorphosed volcanic rock mixed in nearby.',
  },
  // The one multi-night sample (v676) — 4 days, 3 overnights (Perry Creek,
  // Stonington, Burnt Coat Harbor) — but the movie template itself needed
  // no changes: it already shows one destination's History/Geology and
  // then previews the whole plotted route, and a 44-point, 4-stop route
  // animating in the same fixed 10s preview as any other sample already
  // reads as "this one's longer" on its own. The multi-night structure
  // is instead carried by the sample's own name/note in curated_routes.json
  // ("(3 nights)" + the day-by-day note) — the same mechanism every other
  // sample already uses to convey what's distinctive about it, not a new
  // one invented just for this route.
  'rockland-hadlock-cove': {
    destinationTitle: 'Hadlock Cove — Anchorage',
    historyTitle: "A ships' store that became an island's memory",
    place: 'Hadlock Cove',
    audioId: 'hadlock-cove',
    historyCaption: "In 1850, Edwin Hadlock built a ships' chandlery on nearby Little Cranberry Island — it's now the Islesford Historical Society's museum, listed on the National Register since 1980.",
    geologyCaption: "The rock around Hadlock Cove is Silurian-Devonian marine sandstone and slate, grading into gneiss and schist toward the southwest — with some volcanic rock mixed in along this stretch of coast.",
  },
};

// Movie narration audio — pre-rendered offline via Piper (same engine used
// for the sailors-page demo clips' voiceover, see www/audio/ — generated,
// not hand-recorded), not the live browser speechSynthesis API. Chrome has
// a real, confirmed bug where speechSynthesis.cancel() immediately
// followed by speak() can silently wedge the engine — no audio ever
// plays, onstart/onend never fire — which is exactly what made a live-TTS
// movie race through fast and silent (see tts.js's _armWatchdog comment
// for the full diagnosis). Pre-rendered audio sidesteps that class of bug
// entirely; only the narration is canned, everything else in the movie
// (map panning, popups, live geology data, Virtual Journey) stays real.
// Steps 1-3 are per-route (real, route-specific content, v656); steps 4-6
// are generic scripted lines shared by every route.
function _movieStepAudio(movie, n) {
  return n <= 3 ? `./audio/movie-${movie.audioId}-step${n}.mp3` : `./audio/movie-step${n}.mp3`;
}

// _playRouteMovie itself lives inside _ensureMap() (near _loadSampleRoute,
// which it depends on) — see there. ROUTE_MOVIES stays top-level since
// it's plain data with no scope dependencies.

// Island Info mode also gets a second, lighter tier: every island the chart
// data itself knows the name of (Query.namedPlaces, already loaded for
// search/lookup — reused here, no new fetch), not just the ~35 with a full
// curated ownership/access writeup. There are hundreds of these across
// Penobscot Bay (the server-backed dataset runs several hundred within the
// bay alone), too many to label with text directly on the map, so per
// explicit direction this is a click-for-name tier: a small plain dot that
// pops its name on tap. Islands that already have a full Island Info document
// are skipped here so they don't get a second, duller pin sitting on top
// of their real one — matched by name AND proximity, not name alone: Maine
// reuses island names constantly (multiple "Green Island"s, "Crow Island"s,
// "Sheep Island"s, "Bear Island"s, and "Stave Island"s all exist in
// different bays — hit this personally while researching Island Info
// entries), so a documented island must only suppress the dot for that
// SAME physical island, never every same-named island in the whole bay.
//
// Per explicit direction, every island-info document's `title` itself now
// carries a disambiguating "(Locality)" suffix too — e.g. "Bear Island
// (Eggemoggin Reach)" vs. "Bear Island (Northeast Harbor)", "Crow Island
// (Cranberry Isles)" — so the popup header alone is never ambiguous, not
// just the `place` subtitle line. That suffix is stripped back off before
// matching against Query.namedPlaces here, since the chart data's own
// island names are bare ("Bear Island", not "Bear Island (...)")
// — _bareIslandName() is the single place that convention is encoded, so
// any future rename convention change only needs to happen here.
function _bareIslandName(title) {
  return title.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase();
}
let _islandLabelsLayer = null;
function _renderAllIslandLabels() {
  if (_islandLabelsLayer) { _map.removeLayer(_islandLabelsLayer); _islandLabelsLayer = null; }
  if (_mapViewMode !== 'island-info' || !_map) return;
  const features = Query.namedPlaces?.features;
  if (!features || !features.length) return;
  const documented = _documents
    .filter(f => f.properties.category === 'island-info')
    .map(f => ({
      name: _bareIslandName(f.properties.title),
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }));
  const DEDUP_RADIUS_NM = 2;
  // Per explicit direction, bare rocks/ledges/reefs/shoals don't belong in
  // Island Info even though the chart data tags them the same as real
  // islands (label:'island') — the giveaway is almost always right in the
  // name itself ("Black Rock", "Cato Ledge", "Humpkins Ledge"). A name-based
  // filter isn't perfect (misses ledges with a person's-name-only title,
  // and would also catch a genuine named island like "Matinicus Rock" that
  // happens to have "Rock" in its name), but it matches the stated intent
  // far better than showing all ~300 undocumented dots including two dozen
  // bare rocks.
  const ROCK_OR_LEDGE = /\b(rock|rocks|ledge|ledges|reef|reefs|shoal|shoals)\b/i;
  const markers = [];
  for (const f of features) {
    if (f.properties.label !== 'island') continue;
    const name = f.properties.name;
    if (!name || ROCK_OR_LEDGE.test(name)) continue;
    const [lon, lat] = f.geometry.coordinates;
    const nameLower = name.toLowerCase();
    const isDocumented = documented.some(d =>
      d.name === nameLower && Query.distanceNm(lon, lat, d.lon, d.lat) < DEDUP_RADIUS_NM
    );
    if (isDocumented) continue;
    // L.circleMarker (SVG vector layer) was tried first for this, on the
    // theory that 300+ divIcon markers would repeat the DOM-count-blowup
    // hazard-clustering bug — but during testing every circleMarker path
    // came out degenerate (d="M0 0"). Root cause turned out to be a stale
    // test-session GPS/region selection feeding Query.namedPlaces data from
    // a completely different bay, projecting every point to an extreme
    // off-map pixel offset — not something this circleMarker vs. divIcon
    // choice actually controls. Kept divIcon anyway since it already proved
    // out working and fast enough at 600+ markers once the real Penobscot
    // Bay data was loaded (this app already renders far more DOM-heavy
    // hazard markers without issue; the earlier blowup was about
    // marker complexity at 600-1700 count, not a plain 8px dot at this scale).
    const m = L.marker([lat, lon], {
      icon: L.divIcon({
        className: '',
        html: '<div style="width:8px;height:8px;border-radius:50%;background:#fff;border:1.5px solid #7c3aed"></div>',
        iconSize: null,
        iconAnchor: [4, 4],
      }),
    });
    const lookupHtml = _wireIslandLookup(m, lat, lon);
    m.bindPopup(
      `<div style="font-size:13px"><b>${name}</b><div style="margin-top:4px;color:#888;font-size:0.82em">No ownership/access info yet</div>${lookupHtml}</div>`,
      { maxWidth: 220 }
    );
    markers.push(m);
  }
  _islandLabelsLayer = L.layerGroup(markers).addTo(_map);
}

// Permanent, always-on text labels for named passages/reaches/thorofares
// (NOTABLE_PASSAGES) — unlike _renderAllIslandLabels()'s click-for-name
// dots, these read directly off the chart with no tap required, since the
// curated set is small enough (16, not ~300) that text doesn't clutter the
// map. Runs in every map mode, not gated to island-info — per explicit
// request, these should read like a real chart's own baked-in labels
// wherever you're looking, not live behind a special mode.
let _passageLabelsLayer = null;
function _renderPassageLabels() {
  if (_passageLabelsLayer) { _map.removeLayer(_passageLabelsLayer); _passageLabelsLayer = null; }
  if (!_map) return;
  const features = Query.namedPlaces?.features;
  if (!features || !features.length) return;
  const markers = [];
  for (const f of features) {
    // No label-value check here — NOTABLE_PASSAGES is itself the curation
    // (see its comment for why: some genuinely notable features, like Isle
    // Au Haut, are tagged with an unexpected label value in the source
    // data and would otherwise be silently excluded).
    const name = f.properties.name;
    if (!name || !NOTABLE_PASSAGES.has(name)) continue;
    const [lon, lat] = f.geometry.coordinates;
    const m = L.marker([lat, lon], {
      icon: L.divIcon({
        className: '',
        html: `<span class="passage-label">${name}</span>`,
        iconSize: null,
      }),
      interactive: false,
      keyboard: false,
    });
    markers.push(m);
  }
  _passageLabelsLayer = L.layerGroup(markers).addTo(_map);
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
        const ct = Query.segCrossTrack(a.lon, a.lat, b.lon, b.lat, lon, lat);
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
        const ct = Query.segCrossTrack(a.lon, a.lat, b.lon, b.lat, lon, lat);
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

// depth_label is baked at chart-preprocessing time as e.g. "0.0-2.0m"
// (S-57 DRVAL1/DRVAL2, always meters) — convert to feet here so shallow-
// area callouts match every other depth readout in the app (soundings,
// DEPTH_HERE), rather than surfacing the raw chart-source unit.
function _depthRangeLabelFt(depthLabel) {
  const m = /^(-?[\d.]+)-(-?[\d.]+)m$/.exec(depthLabel || '');
  if (!m) return depthLabel;
  const toFt = (v) => (parseFloat(v) * 3.28084).toFixed(1);
  return `${toFt(m[1])}-${toFt(m[2])} ft`;
}

// Ranks Query.coverageLevelAt's tri-state so the worst point along the
// route wins — see the matching comment on Router.classifyFallbackSeg.
const _ROUTE_COVERAGE_RANK = { none: 0, land: 1, core: 2 };

// Whether real hazard data actually exists for this route's area, under
// whatever region Query currently has loaded. A route whose points fall
// outside 'core' coverage (wrong/no active region, data not yet
// downloaded) makes _findRouteHazards' "0 found" result meaningless — it
// isn't that the route is safe, it's that there was nothing to check
// against. See INCIDENTS.md, 2026-09-23: this exact gap let a route
// "verified" as zero-hazard actually ship running through 19 charted
// rocks, because the check silently ran against the wrong active region.
function _routeCoverageLevel(points) {
  let worst = 'core';
  for (const p of points) {
    const level = Query.coverageLevelAt(p.lon, p.lat);
    if (_ROUTE_COVERAGE_RANK[level] < _ROUTE_COVERAGE_RANK[worst]) worst = level;
    if (worst === 'none') break;
  }
  return worst;
}

function _findRouteHazards(points) {
  const pts   = points;
  const feats = Query.hazards?.features || [];
  const CORRIDOR = 0.05;  // nm (~100 yards each side)
  const DANGER_LABELS = new Set(['underwater rock', 'obstruction', 'wreck', 'UWTROC', 'OBSTRN', 'WRECKS']);
  const seen = new Set();
  const found = [];
  const dangerSegments = new Set(); // segment indices that have a nearby hazard
  const coverage = _routeCoverageLevel(pts);

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
      const ct = Query.segCrossTrack(a.lon, a.lat, b.lon, b.lat, pLon, pLat);
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
          segBrg:  MarkerIcons.segBearing(a.lat, a.lon, b.lat, b.lon),
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
        // The polygon's own depth_label is a worst-case RANGE for its whole
        // (often broad — see this session's router.js/query.js soundings
        // work) extent, not the depth at this exact spot. Direct request:
        // show the real charted depth here too, not just the coarse range.
        // A real sounding within a tight radius of the actual crossing
        // point is far more representative than the polygon-wide range;
        // no sounding that close stays honest and falls back to the range
        // alone rather than fabricate a precise-looking number. Only
        // meaningful for a genuine underwater shallow area — an
        // above-water obstacle has no "depth of water" to report.
        const nearSounding = minDepth >= 0 ? Query.nearestSounding?.(hit.lat, hit.lon, 0.2) : null;
        let depthFt = null;
        if (nearSounding) {
          // Same margin constant as router.js/query.js's own hazard
          // checks and the depth-heat overlay's red/yellow bands.
          const KEEL_CLEARANCE_MARGIN_M = 3 * 0.3048; // 3ft
          const draftM = _getDraftMeters();
          const eff = nearSounding.valsou + _effectiveTideHeight();
          depthFt = eff * 3.28084;
          // A real nearby sounding showing comfortably deep water means this
          // crossing isn't actually worth a caution triangle — the polygon's
          // depth_label is only a worst-case range for its whole extent, and
          // flagging every crossing regardless of real depth just trains
          // users to ignore the warning. Same "clearly fine" cutoff as the
          // depth-heat overlay's own yellow band and the user-settable
          // Comfortable clearance margin setting (v722, default 3ft): below
          // it, still flag as marginal; a sounding-confirmed depth at or
          // above it is left unflagged. No nearby sounding stays conservative
          // and keeps flagging, same "unverified is never safe" policy used
          // elsewhere this session.
          if (draftM != null && eff >= draftM + _getComfortMarginMeters()) continue;
        }
        dangerSegments.add(i);
        const polyLabel = minDepth < 0 ? 'above-water obstacle'
          : depthFt != null
            ? `shallow area (~${depthFt.toFixed(1)} ft here, charted range ${_depthRangeLabelFt(props.depth_label)})`
            : `shallow area (charted range ${_depthRangeLabelFt(props.depth_label)})`;
        found.push({
          lat: hit.lat, lon: hit.lon,
          projLat: hit.lat, projLon: hit.lon,
          label: polyLabel,
          depthFt: depthFt != null ? depthFt.toFixed(1) : null,
          name:  props.name || '',
          routeNm: distSoFar + hit.t * segLen,
          side:    'crossing',
          segBrg:  MarkerIcons.segBearing(a.lat, a.lon, b.lat, b.lon),
          sideSign: 0,
          kind: 'soft',
          legIndex: i,
          // Only a genuine underwater shallow-area crossing has a "move to
          // deeper water" fix — an above-water obstacle (minDepth < 0) has
          // no depth dimension to nudge along, see _nudgeLegOffshore.
          nudgeable: minDepth >= 0,
        });
      }
    }
    distSoFar += segLen;
  }
  found.sort((a, b) => a.routeNm - b.routeNm);
  return { found, dangerSegments, coverage };
}

// Cache of _findRouteHazards results for the routes panel's hazard badges,
// keyed by id+updatedAt so it's invalidated automatically whenever a
// route's content changes (anything that calls _touch() bumps updatedAt) —
// no new tracking field needed. Stale entries for edited/deleted routes
// just become unreachable and sit unused; fine for a cache realistically
// bounded by tens of saved routes, not worth an eviction policy yet.
let _routeHazardCountCache = new Map();
function _routeHazardCacheKey(route) { return `${route.id}:${route.updatedAt || route.createdAt || 0}`; }
function _getRouteHazards(route) {
  const key = _routeHazardCacheKey(route);
  let found = _routeHazardCountCache.get(key);
  if (found === undefined) {
    const result = _findRouteHazards(route.points);
    found = result.found;
    found.coverage = result.coverage; // see _checkRouteHazards — badge rendering reads this too
    _routeHazardCountCache.set(key, found);
  }
  return found;
}
// Non-computing lookup for the routes panel's first paint — see
// _warmRouteHazardCache. A route with hundreds of points against a
// hazards layer of tens of thousands of features is genuinely expensive;
// with 100+ saved routes (the "tens" the cache comment above assumed is
// long since out of date) doing this for every row on every panel open
// was the multi-second freeze reported live.
function _getRouteHazardsCached(route) {
  return _routeHazardCountCache.get(_routeHazardCacheKey(route));
}

// Computes and caches hazard badges for routes that don't have them yet,
// a few at a time via setTimeout so the panel itself paints immediately
// instead of blocking on the full list up front; re-renders the open
// panel once a batch finishes so badges pop in shortly after, rather than
// making the user wait for all of them before seeing anything at all.
let _routeHazardWarmupRunning = false;
function _warmRouteHazardCache() {
  if (_routeHazardWarmupRunning) return;
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const pending = routes.filter(r => _getRouteHazardsCached(r) === undefined);
  if (pending.length === 0) return;
  _routeHazardWarmupRunning = true;
  const BATCH_SIZE = 10; // small enough per setTimeout tick to stay responsive, large enough to not spend most of the warm-up on repeated full-list re-renders
  let i = 0;
  function step() {
    const end = Math.min(i + BATCH_SIZE, pending.length);
    for (; i < end; i++) _getRouteHazards(pending[i]);
    if (i < pending.length) {
      setTimeout(step, 0);
    } else {
      _routeHazardWarmupRunning = false;
    }
    if (document.getElementById('route-picker-panel')?.classList.contains('open')) {
      _buildRoutePickerPanelFn?.();
    }
  }
  setTimeout(step, 0);
}

function _checkRouteHazards(routeIdx, silent = false) {
  _lastHazardCheckedIdx = routeIdx;
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const route  = routes[routeIdx];
  if (!route) return [];
  const pts = route.points;
  const { found, dangerSegments, coverage } = _findRouteHazards(pts);
  found.coverage = coverage; // inspectable by callers (incl. window._debugCheckRouteHazards) without changing found's array shape

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
  found.forEach((h, hIdx) => {
    const tip = `${h.label}${h.name ? ': ' + h.name : ''} — ${h.side}, ${h.routeNm.toFixed(1)} nm along route`;
    const icon = h.kind === 'soft'
      ? MarkerIcons.softHazardMarkerIcon()
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
        // A nudgeable shallow-area crossing gets an extra option — same
        // "surface it right here, don't bury it in a menu" spirit as the
        // rest of this app's controls. Everything else (hard hazards,
        // above-water obstacles) keeps the old single-action behavior:
        // no fix but "move to deeper water" applies to those.
        if (h.kind === 'soft' && h.nudgeable && h.legIndex != null) {
          const editId = `hz-edit-${routeIdx}-${hIdx}`;
          const nudgeId = `hz-nudge-${routeIdx}-${hIdx}`;
          const popup = L.popup({ closeButton: true, maxWidth: 260 })
            .setLatLng([h.lat, h.lon])
            .setContent(
              `<div style="font-size:13px;line-height:1.5">${escapeHtml(h.label)}<br>`
              + `<button id="${nudgeId}" style="margin-top:4px;padding:4px 10px;cursor:pointer;">Nudge offshore</button> `
              + `<button id="${editId}" style="margin-top:4px;padding:4px 10px;cursor:pointer;">Edit route</button></div>`
            )
            .openOn(_map);
          setTimeout(() => {
            document.getElementById(nudgeId)?.addEventListener('click', () => {
              _map.closePopup(popup);
              _nudgeLegOffshore(routeIdx, h);
            });
            document.getElementById(editId)?.addEventListener('click', () => {
              _map.closePopup(popup);
              _jumpToEdit();
            });
          }, 0);
        } else {
          _jumpToEdit();
        }
      })
      .addTo(_hazardCheckLayer);
  });

  if (found.length === 0) {
    // 'core' coverage means real hazard data actually exists for this
    // route's whole length under whatever region is currently loaded — a
    // "0 found" result can only be trusted at that level. Anything less
    // (wrong/no active region, data not yet downloaded) means there was
    // nothing to check against, not that the route is safe: say so loudly,
    // regardless of `silent` — the same "an unverified route is a safety
    // issue, not a cosmetic one" reasoning as _blockedByCoverage's refusal
    // to auto-route into uncovered water. See INCIDENTS.md, 2026-09-23.
    if (coverage !== 'core') {
      const msg = coverage === 'none'
        ? `${route.name}: couldn't check for hazards — no chart data loaded for this area (region may need switching or downloading).`
        : `${route.name}: couldn't fully check for hazards — only land-avoidance data is loaded for this area, not rock/obstruction/wreck data.`;
      const mid = pts[Math.floor((pts.length - 1) / 2)];
      L.popup({ maxWidth: 300, autoPan: false })
        .setLatLng([mid.lat, mid.lon])
        .setContent(`<div style="font-size:13px;line-height:1.5"><b>${escapeHtml(route.name)}</b><br>⚠ ${escapeHtml(msg.slice(route.name.length + 2))}</div>`)
        .openOn(_map);
      setStatus(msg);
      TTS.sayImmediate(msg);
      return found;
    }
    if (!silent) {
      const mid = pts[Math.floor((pts.length - 1) / 2)];
      L.popup({ maxWidth: 300, autoPan: false })
        .setLatLng([mid.lat, mid.lon])
        .setContent(`<div style="font-size:13px;line-height:1.5"><b>${escapeHtml(route.name)}</b><br>✓ No rocks, obstructions, or wrecks within 100 yds.</div>`)
        .openOn(_map);
    }
    return found;
  }

  // A hazard was found nearby — this is a proximity warning, not a crossing
  // (the route doesn't actually run over it), so per direct request it stays
  // silent: no popup, no status, no speech. The red segment highlight and
  // skull/triangle markers above are the persistent visual signal, and
  // fixing is reached via the Node Ops "Fix selected nodes" button (select
  // the flagged waypoint, then Fix) or by editing manually. Only an actual
  // unresolved land/hazard CROSSING (_showRouteFallbackWarning) still
  // speaks — see the matching comment there.
  return found;
}

// Live "while underway" hazard re-check (direct request, 2026-09-28): as
// real time passes and the tide genuinely changes (see _effectiveTideHeight's
// now-live interpolation, fixed in the same release), a crossing that was
// fine when a route was planned/checked can become genuinely marginal by
// the time the boat actually gets there. Runs periodically (see its
// setInterval registration, chained onto the existing 60s tide-cycle
// refresh) against just the REMAINING portion of whatever route is
// currently being followed — not the whole route, which would keep
// re-flagging water already safely behind the boat — and only announces
// hazards that are NEW since the last check, not the same ones repeatedly.
// Silent no-op when no route is being followed. `baseline=true` (used
// once, right when following starts) establishes the known-hazard set
// without announcing anything — otherwise the very first call would treat
// every already-known hazard on the route as "new" purely because the
// tracking set started empty.
function _recheckFollowedRouteHazardsLive(baseline = false) {
  if (!_followingRouteId || !_map) return;
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const route = routes.find(r => r.id === _followingRouteId);
  const pts = route?.points;
  if (!pts || pts.length < 2) return;
  // One leg of overlap behind the "next waypoint" pointer, so a hazard on
  // the leg the boat is currently transiting isn't missed just because
  // _followingLegIdx already advanced past that leg's own start point.
  const aheadStart = Math.max(0, _followingLegIdx - 1);
  const aheadPts = pts.slice(aheadStart);
  if (aheadPts.length < 2) return;
  const { found } = _findRouteHazards(aheadPts);

  if (_liveFollowHazardLayer) _liveFollowHazardLayer.clearLayers();
  else _liveFollowHazardLayer = L.layerGroup().addTo(_map);

  const currentKeys = new Set();
  const newOnes = [];
  for (const h of found) {
    const key = `${h.lat.toFixed(5)},${h.lon.toFixed(5)}`;
    currentKeys.add(key);
    if (!_followedHazardKnownKeys.has(key)) newOnes.push(h);
    const icon = h.kind === 'soft'
      ? MarkerIcons.softHazardMarkerIcon()
      : L.divIcon({ className: '', html: '<div class="davy-jones-icon">&#9760;</div>', iconSize: [32, 32], iconAnchor: [16, 16] });
    L.marker([h.lat, h.lon], { icon, zIndexOffset: h.kind === 'soft' ? 800 : 1000 })
      .bindTooltip(`${h.label}${h.name ? ': ' + h.name : ''} — ${h.side}`, { permanent: false, direction: 'top', offset: [0, -6] })
      .addTo(_liveFollowHazardLayer);
  }
  _followedHazardKnownKeys = currentKeys;

  if (newOnes.length && !baseline) {
    const msg = `Tide update: ${newOnes.length} new shallow-area warning${newOnes.length > 1 ? 's' : ''} ahead on your route — ${newOnes[0].label}${newOnes[0].name ? ', ' + newOnes[0].name : ''}.`;
    setStatus(msg);
    TTS.sayImmediate(msg);
  }
}

// One-tap fix for a nudgeable shallow-area crossing (v713): instead of just
// warning, try to find real, sounding-verified comfortable water
// (Query.findComfortableNudgePoint — draft + 3ft, the same cutoff already
// used by the depth-heat overlay and this marker's own suppression logic,
// see v712) near the flagged crossing point, insert it as a new waypoint,
// and re-route just the two new sub-legs through it — same
// _reRouteSegments/_showRerouteOverlay machinery the Reroute button uses —
// so the fix is router-validated, not a naive straight splice. Strictly
// post-hoc and single-leg: never touches segBlocked/the A* hot path,
// matching the standing rule for standoff/proximity fixes in this
// hazard-dense chart data (a search-time version of a similar idea broke
// 6/8 regression cases earlier this session). No comfortable point found
// nearby → fall back to the existing "drop a draggable node here for the
// user to position by hand" behavior instead of guessing.
function _nudgeLegOffshore(routeIdx, h) {
  if (!_editMode || _editRouteIdx !== routeIdx) _enterEditMode(routeIdx, true);
  const legIndex = h.legIndex;
  const a = _editPoints[legIndex], b = _editPoints[legIndex + 1];
  if (!a || !b) return;

  const draftFt = _currentDraftFt();
  const nudge = Query.findComfortableNudgePoint(h.lon, h.lat, draftFt, _tideHeight, 0.15, _getComfortMarginMeters());
  if (!nudge) {
    const msg = "Couldn't find comfortably deep water nearby — added a node here to position by hand.";
    setStatus(msg);
    TTS.sayImmediate(msg);
    _insertVertex(legIndex, L.latLng(h.lat, h.lon));
    _renderEditLayers();
    return;
  }

  const legPts = [a, { lat: nudge.lat, lon: nudge.lon }, b];
  const ui = _showRerouteOverlay(legPts);
  _reRouteSegments(legPts, ui.update.bind(ui), ui.setText.bind(ui), 'Nudge offshore')
    .then(({ points: sub, fallbacks, fallbackSegs, blocked }) => {
      ui.remove();
      if (blocked) return; // _reRouteSegments already announced why
      _pushEditHistory();
      _editPoints.splice(legIndex, 2, ...sub);
      _newVertexIdx = -1;
      _selectedEditNodeIdx.clear();
      _renderEditLayers();
      // Fresh check against real hazard data, not just the land-avoidance
      // the router already did — same rhythm the Reroute button uses, and
      // the same reason: the nudge might clear THIS leg but reveal a
      // different one nearby, so don't declare success blindly.
      const movedYd = Math.round(nudge.movedNm * 2025.37); // nm -> yards
      const stillFound = _liveHazardCheck();
      if (!stillFound.length) {
        if (fallbacks > 0) _showRouteFallbackWarning(fallbackSegs);
        else setStatus(`Nudged route ~${movedYd}yd offshore for more clearance.`);
      }
    })
    .catch(err => {
      ui.remove();
      setStatus('Nudge failed.');
      console.error('[nudge offshore]', err);
    });
}

// Fixes hazards near a single waypoint — click "Fix selected nodes" to arm
// fix mode (stays armed, same as Delete/Overnight), then click waypoints on
// the map one at a time; each click inserts a new bypass waypoint into
// whichever of its two adjacent segments passes within CORRIDOR of a
// charted rock/obstruction/wreck, and lights the clicked node up
// ('edit-vertex-selected' in _renderEditLayers) so it's visibly been
// addressed. Deliberately per-node and immediate, not a batch multi-
// select-then-fix — matches the existing Delete-mode interaction model
// per explicit request ("keep deleting till we signal stop... first click
// button, then start fixing individual nodes").
//
// Originally nudged whichever existing endpoint the hazard sat closer to,
// and only if that happened to be the node clicked — found live to be a
// real bug, not just a design choice: the ⚠ warning icon a user is
// reacting to sits at the segment's geometric MIDPOINT (see
// _showRouteFallbackWarning), which has no relation to which of the two
// endpoints is nearer the hazard along the segment. Clicking the "far"
// endpoint of a genuinely flagged segment silently did nothing — no
// hazard was fixed, because vi (the computed nearer endpoint) didn't
// match idx, and the only feedback was a generic "nothing to fix"
// message easy to miss next to a visibly still-present warning triangle.
// Confirmed via a live test with a synthetic route and a real charted
// rock before rewriting this.
//
// Inserting a bypass point instead of nudging an endpoint fixes that
// structurally: it doesn't matter which of the segment's two endpoints
// gets clicked, since the fix targets the SEGMENT, not either endpoint —
// and it also stops moving a waypoint the user may have placed on purpose
// (a marina entrance, an anchorage) just because a hazard happened to be
// nearer to it.
//
// Scoped to charted point-hazards only (rock/obstruction/wreck within a
// narrow corridor of an otherwise-straight segment) — the same scope the
// tool always had. A segment that instead crosses LAND (a different
// fallback-warning cause — see _classifyFallbackSeg) isn't handled here:
// a single inserted point can't safely route around an arbitrary
// coastline the way real pathfinding (the existing Reroute button) can,
// so that case gets a clearer message pointing at Reroute/Insert instead
// of silently doing nothing.
function _fixNodeHazards(idx) {
  const CORRIDOR    = 0.05;
  const SAFETY      = 0.03;
  const DANGER_LABELS = new Set(['underwater rock','obstruction','wreck','UWTROC','OBSTRN','WRECKS']);

  const pts   = _editPoints;
  const feats = Query.hazards?.features || [];
  const n     = pts.length;

  const adjSegs = [];
  if (idx > 0)      adjSegs.push(idx - 1);  // segment (idx-1, idx)
  if (idx < n - 1)  adjSegs.push(idx);      // segment (idx, idx+1)

  // One entry per adjacent segment that has ≥1 hazard to bypass, holding
  // all its bypass points sorted along the segment — collected against the
  // ORIGINAL pts array first, applied afterward (highest segment index
  // first) so earlier insertions never invalidate a later segment's index.
  const bypassesBySeg = [];
  let hazardsFixed = 0;

  for (const i of adjSegs) {
    const a = pts[i], b = pts[i + 1];
    const segLen = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
    if (segLen < 1e-6) continue;
    const segBearing = Query.bearing(a.lon, a.lat, b.lon, b.lat);
    const bypassPts = [];

    for (const f of feats) {
      if (f.geometry.type !== 'Point') continue;
      const label = f.properties.label || f.properties.objtype || '';
      if (!DANGER_LABELS.has(label)) continue;
      const [pLon, pLat] = f.geometry.coordinates;
      const ct = Query.segCrossTrack(a.lon, a.lat, b.lon, b.lat, pLon, pLat);
      if (!ct) continue;
      const { crossTrack, alongTrack } = ct;
      if (Math.abs(crossTrack) > CORRIDOR || alongTrack < 0 || alongTrack > segLen) continue;

      // New waypoint sits at the hazard's own along-track position on the
      // original straight segment, offset perpendicular by CORRIDOR+SAFETY
      // — not scaled by segment length the way the old endpoint-nudge math
      // was, since we're placing a brand new point exactly where clearance
      // is needed rather than levering a distant endpoint to compensate.
      const frac        = alongTrack / segLen;
      const projLat      = a.lat + (b.lat - a.lat) * frac;
      const projLon      = a.lon + (b.lon - a.lon) * frac;
      const bypassSign  = crossTrack >= 0 ? -1 : 1;  // offset away from the hazard
      const perpBearing = segBearing + bypassSign * 90;
      const bypass = _destPoint(projLat, projLon, perpBearing, CORRIDOR + SAFETY);
      bypassPts.push({ alongTrack, point: bypass });
      hazardsFixed++;
    }

    if (bypassPts.length) {
      bypassPts.sort((x, y) => x.alongTrack - y.alongTrack);
      bypassesBySeg.push({ segIdx: i, points: bypassPts.map(bp => bp.point) });
    }
  }

  _selectedEditNodeIdx.add(idx);  // light it up either way — it's been addressed

  if (hazardsFixed === 0) {
    _renderEditLayers();
    const onLand = adjSegs.some(i => Query.landBlocks(pts[i].lon, pts[i].lat, pts[i + 1].lon, pts[i + 1].lat));
    const msg = onLand
      ? "This waypoint's segment crosses land, not a charted point hazard — try Reroute, or Insert a waypoint manually."
      : 'No nearby rock, obstruction, or wreck hazard to fix on this waypoint.';
    setStatus(msg); TTS.sayImmediate(msg);
    return;
  }

  _pushEditHistory();
  // Highest segIdx first so each splice's target index is still valid —
  // an insertion at a lower segIdx shifts everything after it, including
  // points already inserted by a higher-segIdx pass done earlier.
  bypassesBySeg.sort((x, y) => y.segIdx - x.segIdx);
  for (const { segIdx, points } of bypassesBySeg) {
    _editPoints.splice(segIdx + 1, 0, ...points);
  }
  _selectedEditNodeIdx.clear();  // every index past the lowest insertion point just shifted
  _renderEditLayers();
  clearTimeout(_liveHazardTimer);
  _liveHazardTimer = setTimeout(_liveHazardCheck, 300);

  const msg = `Fixed ${hazardsFixed} hazard${hazardsFixed > 1 ? 's' : ''} near this waypoint — added ${hazardsFixed > 1 ? 'bypass waypoints' : 'a bypass waypoint'}.`;
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
    <tr data-name="${escapeHtml(r.name)}">
      <td><input type="checkbox" class="npp-vis-cb" ${hiddenNames.has(r.name) ? '' : 'checked'}></td>
      <td class="npp-row-name">${escapeHtml(r.name)}</td>
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

    // Invisible fat line laid over the thin visible route (below) purely as a
    // bigger tap target — per direct report, tapping a route to enter edit
    // mode was too fussy on a phone, needing a near-exact hit on the visible
    // line's own few CSS pixels. weight is a hit-radius here, not a stroke
    // width anyone sees (opacity: 0), so it can be generous without changing
    // how the route looks.
    // routeIdx is captured once, when this layer group was last (re)built —
    // a background Wi-Fi Sync merging/reordering routes between then and an
    // actual later click/tap can leave it pointing at the wrong array slot
    // entirely (a different route, possibly a conflict-copy duplicate, with
    // completely different points) even though the map still visibly shows
    // the route this layer was drawn for. Confirmed live: editing opened a
    // route whose later waypoints were nowhere near the one actually drawn
    // on screen. Re-resolve by the route's stable id at the moment each
    // handler actually fires, instead of trusting the closure's index.
    const _freshRouteIdx = () => {
      if (!route.id) return routeIdx;
      const fresh = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
      const i = fresh.findIndex(r => r.id === route.id);
      return i >= 0 ? i : routeIdx;
    };
    L.polyline(lls, { color: '#e05252', weight: 32, opacity: 0, interactive: true })
      .on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        _enterEditMode(_freshRouteIdx());
      })
      .on('dblclick', (e) => { L.DomEvent.stopPropagation(e); })
      .on('mouseover', () => { _ctxRouteIdx = _freshRouteIdx(); })
      .on('contextmenu', (e) => {
        L.DomEvent.stopPropagation(e);
        _openSelectRoutePopup(_freshRouteIdx(), e.latlng);
      })
      .addTo(_savedRoutesLayer);
    const isSelected = routeIdx === _selectedRouteIdx;
    // VJ-green wins over "selected" gold if both are true at once (a route
    // was clicked/highlighted, then also started as a Virtual Journey): the
    // live "underway right now" state is more time-sensitive than the
    // passive last-clicked highlight, and the VJ banner already carries the
    // "this is the active route" signal elsewhere. Color kept in sync with
    // .vj-waypoint-marker's border in app.css.
    const isVjActive  = route.id === _vjRoute?.id;
    const routeLineColor   = isVjActive ? '#1e8a5c' : (isSelected ? '#f5c842' : '#e05252');
    const routeLineWeight  = (isVjActive || isSelected) ? 5 : 3;
    const routeLineOpacity = isVjActive ? 0.9 : (isSelected ? 1.0 : 0.7);
    L.polyline(lls, {
      color: routeLineColor,
      weight: routeLineWeight,
      opacity: routeLineOpacity,
      interactive: false,
    }).addTo(_savedRoutesLayer);

    // Segment bearing labels — perpendicular offset, alternating sides, dashed leader
    for (let i = 0; i < pts.length - 1; i++) {
      const midLat  = (pts[i].lat + pts[i + 1].lat) / 2;
      const midLon  = (pts[i].lon + pts[i + 1].lon) / 2;
      const trueBrg = MarkerIcons.segBearing(pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon);
      const magBrg  = Math.round(trueTomagnetic(trueBrg) + 360) % 360;
      const distNm  = Query.distanceNm(pts[i].lon, pts[i].lat, pts[i + 1].lon, pts[i + 1].lat);
      const html    = `${String(magBrg).padStart(3, '0')}&deg;M &thinsp; ${distNm.toFixed(1)}nm`;
      MarkerIcons.addLeaderLabel(_savedRoutesLayer, midLat, midLon, trueBrg, i % 2 === 0 ? 1 : -1, _labelOffsetNm, html, 'route-label-box');
    }

    // Route name label — viewport-aware position, renders above bearing tooltips
    {
      const labelPt = _bestRouteLabelPos(pts);
      const nameMarker = L.marker([labelPt.lat, labelPt.lon], {
        icon: L.divIcon({ className: 'route-name-label', html: escapeHtml(route.name), iconSize: null }),
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
      const m = L.marker([pt.lat, pt.lon], { icon: MarkerIcons.routeEndpointIcon() })
        .addTo(_savedRoutesLayer);
      // Offset label perpendicular to the adjacent segment
      const adjPt   = fromEnd ? pts[pts.length - 2] : pts[1];
      if (adjPt) {
        const segBrg = fromEnd
          ? MarkerIcons.segBearing(adjPt.lat, adjPt.lon, pt.lat, pt.lon)
          : MarkerIcons.segBearing(pt.lat, pt.lon, adjPt.lat, adjPt.lon);
        MarkerIcons.addLeaderLabel(_savedRoutesLayer, pt.lat, pt.lon, segBrg,
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
      L.marker([pt.lat, pt.lon], { icon: MarkerIcons.routeOvernightIcon() })
        .bindTooltip('Overnight stop', { direction: 'top', offset: [0, -10] })
        .addTo(_savedRoutesLayer);
    });

    // Virtual-Journey intermediate waypoints — every other route only ever
    // shows its two endpoints (+ overnight stops); the one route actively
    // running as a Virtual Journey also shows every other point along the
    // way. Skips the same first/last indices as the endpoint markers, and
    // any point already drawn above as an overnight marker, so nothing is
    // drawn twice with two different marker styles.
    if (route.id === _vjRoute?.id) {
      pts.forEach((pt, i) => {
        if (i === 0 || i === pts.length - 1 || pt.overnight) return;
        L.marker([pt.lat, pt.lon], { icon: MarkerIcons.vjWaypointIcon(), interactive: false })
          .addTo(_savedRoutesLayer);
      });
    }
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
      icon: L.divIcon({ className: 'route-name-label', html: escapeHtml(track.name), iconSize: null }),
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

  // See the matching comment in _triggerAutoRoute — autoRouteProg can move
  // startPt/endPt off charted-too-shallow water before routing at all;
  // this entry point had the exact same silent-relocation gap (a real
  // report: "AutoRoute to here" via this flow didn't end at the marker at
  // all, because the marker itself was the one that got moved).
  const snapEvents = [];
  let pts;
  try {
    pts = await Router.autoRouteProg(startPt, endPt,
      (path) => previewLine.setLatLngs(path.map(p => [p.lat, p.lon])),
      (t) => { const el = optOverlay.querySelector('.optimizing-text'); if (el) el.textContent = t; },
      false, _currentDraftFt(), _tideHeight, _makeSearchDotCallback(),
      (which, snap) => snapEvents.push({ which, ...snap }),
      _currentDeadlineMs()
    );
  } catch (err) {
    optOverlay.remove();
    previewLine.remove();
    console.error('[drawRoute] optimization error:', err);
    return;
  }

  optOverlay.remove();
  previewLine.remove();

  _routeSnapMarkers.forEach(m => m.remove());
  _routeSnapMarkers = snapEvents.map(s => {
    const label = s.which === 'end' ? 'destination' : 'start';
    return L.circleMarker([s.lat, s.lon], {
      radius: 7, color: '#ffaa00', fillColor: '#ffaa00', fillOpacity: 0.75, weight: 2,
    }).addTo(_map).bindTooltip(
      `${escapeHtml(name)} — ${label} moved ${s.movedNm.toFixed(2)}nm (too shallow at current draft/tide)`,
      { permanent: false }
    );
  });
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
  const marginalSeg = pts.length > 2 ? _marginalLegFromPath(pts) : null;
  const found = _enterEditMode(routes.length - 1);
  // Deliberately NOT gated on found.length — a fallback/marginal leg and a
  // nearby charted hazard are two different problems, and a coastal
  // fallback line will almost always graze a charted shallow area too
  // (that's WHY it couldn't route around it). Gating on found.length used
  // to let _checkRouteHazards' own "N hazards nearby, including shallow
  // area..." status line silently substitute for this warning — a real bug
  // found live (2026-09) with a genuine Rockland->Camden fallback: the user
  // got a status message about shallow areas and no indication whatsoever
  // that the route was an un-routed straight line across land.
  // Silent below except _showRouteFallbackWarning's own — direct request:
  // AutoRoute plotting should stay quiet, only speaking/statusing for a
  // genuine danger (couldn't avoid land/hazard, or a too-tight passage),
  // never for routine success or a shallow-water relocation note (that's
  // still visible on the map via the orange snap marker + its tooltip).
  if (fellBack) {
    _showRouteFallbackWarning([{ a: pts[0], b: pts[1], legIndex: 0 }]);
  } else if (marginalSeg) {
    _showRouteFallbackWarning([marginalSeg]);
  }
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
  _setBottomHudHiddenForBanner(true); // see the helper's own comment — same fix as route-dest-banner
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
  _setBottomHudHiddenForBanner(false);
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

const _placeDisambigOverlay = document.getElementById('place-disambig-overlay');
const _placeDisambigTitle   = document.getElementById('place-disambig-title');
const _placeDisambigList    = document.getElementById('place-disambig-list');
function _hidePlaceDisambig() { _placeDisambigOverlay.classList.remove('open'); }
// Resolves with the chosen candidate, or null if cancelled. Uses plain
// onclick (not addEventListener) on the close button and per-candidate
// buttons built fresh each call — assignment replaces rather than stacking,
// so no listener cleanup needed between calls.
function _showPlaceDisambig(query, candidates) {
  return new Promise((resolve) => {
    _placeDisambigTitle.textContent = `Multiple places named "${query}"`;
    _placeDisambigList.innerHTML = '';
    candidates.forEach((c) => {
      const btn = document.createElement('button');
      btn.textContent = c.near ? `${c.name} — near ${c.near}` : c.name;
      btn.onclick = () => { _hidePlaceDisambig(); resolve(c); };
      _placeDisambigList.appendChild(btn);
    });
    document.getElementById('place-disambig-close').onclick = () => { _hidePlaceDisambig(); resolve(null); };
    _placeDisambigOverlay.classList.add('open');
  });
}

// On-page window.prompt() replacement. Needed for any flow that might show
// more than one text prompt in a row (e.g. retrying a destination name that
// didn't resolve) — confirmed live that a second native prompt() fired
// right after the first, with no click in between, can be silently
// suppressed by Chrome/Electron-style webviews' own dialog-spam
// protection: no dialog appears at all, and the caller just sees an
// immediate null. This has no such per-page call-count behavior. Resolves
// with the trimmed, non-empty string, or null if cancelled/left empty —
// same contract as `prompt()` for a caller checking `if (!result) return;`.
// A quiet transcript line (see _appendTranscript) can be — and was,
// confirmed live — visually buried under a floating widget positioned on
// top of it, for a message important enough that missing it isn't fine
// (e.g. "no chart data here, X is unavailable"). This flashes center-screen
// above every ordinary widget instead, and stays up until tapped away —
// nothing to choose, so any click on it (backdrop or panel) dismisses it.
const _coverageAlertOverlay = document.getElementById('coverage-alert-overlay');
const _coverageAlertText    = document.getElementById('coverage-alert-text');
function _showCoverageAlert(text) {
  _coverageAlertText.textContent = text;
  _coverageAlertOverlay.classList.add('open');
}
function _hideCoverageAlert() { _coverageAlertOverlay.classList.remove('open'); }
_coverageAlertOverlay.addEventListener('click', _hideCoverageAlert);

const _textPromptOverlay = document.getElementById('text-prompt-overlay');
const _textPromptTitle   = document.getElementById('text-prompt-title');
const _textPromptInput   = document.getElementById('text-prompt-input');
function _hideTextPrompt() { _textPromptOverlay.classList.remove('open'); }
function _showTextPrompt(title, placeholder = '', value = '') {
  return new Promise((resolve) => {
    _textPromptTitle.textContent = title;
    _textPromptInput.value = value;
    _textPromptInput.placeholder = placeholder;
    const finish = (result) => { _hideTextPrompt(); resolve(result); };
    const goNow = () => finish(_textPromptInput.value.trim() || null);
    document.getElementById('text-prompt-go').onclick = goNow;
    document.getElementById('text-prompt-cancel').onclick = () => finish(null);
    document.getElementById('text-prompt-close').onclick = () => finish(null);
    _textPromptInput.onkeydown = (e) => {
      if (e.key === 'Enter') goNow();
      else if (e.key === 'Escape') finish(null);
    };
    _textPromptOverlay.classList.add('open');
    // Pre-filled (rename) vs. empty (new value): select-all so typing
    // replaces it outright, rather than landing the cursor mid-word.
    setTimeout(() => { _textPromptInput.focus(); _textPromptInput.select(); }, 0);
  });
}

// Resolves a typed place/waypoint name to a destination point — shared by
// Draw Route's own "Name" button and the Location-tile/right-click "Route
// from here" pending-destination flow (see route-dest-name-btn below).
// Checks for name collisions first (Query.findAmbiguousCandidates) and asks
// the user to pick when a bare name matches more than one real place —
// Maine reuses island names constantly across different bays, so silently
// guessing here risked routing toward the wrong one entirely. Only then
// falls through to Query.findPlaceByName's own single-best-guess behavior,
// same as every other (non-interactive, voice/text) caller of it.
// Gazetteer entries are often positioned on the landmass itself (a town or
// island label), not the water someone means when naming it as a
// destination — move onto the nearest confirmed water before dropping the
// point, preferring a real nearby harbor/anchorage/mooring over the literal
// closest wet pixel (see Query.findWaterNear).
async function _resolveNamedDestination(query) {
  const trimmed = query.trim();
  const candidates = Query.findAmbiguousCandidates(trimmed);
  const place = candidates ? await _showPlaceDisambig(trimmed, candidates) : Query.findPlaceByName(trimmed);
  if (!place) {
    if (!candidates) { // only speak "couldn't find" for an actual miss, not a cancelled picker
      const msg = `Couldn't find "${trimmed}".`;
      setStatus(msg); TTS.sayImmediate(msg);
    }
    return null;
  }
  let dest = place;
  if (Query.isLandAt(place.lon, place.lat)) {
    const water = Query.findWaterNear(place.lon, place.lat);
    if (!water) {
      const msg = `${place.name} is on land and no nearby water was found — pick a spot on the map instead.`;
      setStatus(msg); TTS.sayImmediate(msg);
      return null;
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
      // TTS gets "nautical miles" spelled out — a bare "nm" is read as
      // nanometers by browser speech synthesis. Real user report, 2026-09-28.
      const spoken = water.viaPlace
        ? `${place.name} — moved to ${water.viaPlace}, ${water.movedNm.toFixed(1)} nautical miles away.`
        : `${place.name} is on land — moved ${water.movedNm.toFixed(1)} nautical miles into open water.`;
      setStatus(msg); TTS.sayImmediate(spoken);
    }
  }
  return dest;
}

_drawNameDestBtn.addEventListener('click', async () => {
  const query = prompt('Destination — place or waypoint name:');
  if (!query || !query.trim()) return;
  const dest = await _resolveNamedDestination(query);
  if (!dest) return;
  _onDrawClick(L.latLng(dest.lat, dest.lon));
});
_drawConfirmBtn.addEventListener('click', _onDrawConfirm);
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
// Route name currently open in edit mode — set on entry, cleared on exit
// (Cancel/OK/Revert all funnel through _exitEditMode). Only ever survives
// into a later page load if edit mode was never cleanly exited (app closed/
// crashed/reloaded mid-edit), which is exactly when _recoverEditMode should
// resume it — see init().
const EDITING_ROUTE_KEY = 'audiochart-editing-route';

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

// _setRouteDestination/_armPendingRouteDestination live inside _ensureMap()'s
// closure (they call _triggerAutoRoute, defined there) — bridged out via
// this top-level ref, same pattern as _routeFromHereFn.
let _disarmPendingRouteDestinationFn = null;

function _clearAutoRoute() {
  _autoRouteStart = _autoRouteEnd = _autoRouteName = null;
  if (_autoRouteStartMarker)  { _autoRouteStartMarker.remove();  _autoRouteStartMarker  = null; }
  if (_autoRouteEndMarker)    { _autoRouteEndMarker.remove();    _autoRouteEndMarker    = null; }
  if (_autoRoutePreviewLayer) { _autoRoutePreviewLayer.remove(); _autoRoutePreviewLayer = null; }
  _disarmPendingRouteDestinationFn?.();
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


async function _reRouteSegments(pts, onProgress, onText, actionLabel = 'Re-route') {
  if (await _blockedByCoverage(pts[0], pts[pts.length - 1], actionLabel)) {
    return { points: pts, fallbacks: 0, fallbackSegs: [], blocked: true };
  }
  const result = [pts[0]];
  let fallbacks = 0;
  const fallbackSegs = [];  // {a,b,crossesLand,crossesHazard} of each leg that
                             // couldn't be routed and fell back to a straight
                             // line — lets the caller point the user at
                             // exactly where to add a waypoint, and say what
                             // it's actually crossing (see _classifyFallbackSeg)
  // Each leg has its own deadline budget inside autoRouteProg, but a
  // many-leg re-route had no OVERALL cap — a dozen legs could legitimately
  // run well past it with no way for the caller to know. Cap the running
  // total; once crossed, remaining legs go straight to the honest
  // straight-line fallback instead of spending their own budget too.
  const legCount = pts.length - 1;
  const perLegDeadlineMs = _currentDeadlineMs();
  const overallDeadlineMs = Math.min(perLegDeadlineMs * legCount, perLegDeadlineMs * 4);
  const _reRouteT0 = Date.now();
  for (let i = 0; i < pts.length - 1; i++) {
    const segLabel = pts.length > 2 ? `Seg ${i + 1}/${pts.length - 1}: ` : '';
    let sub;
    if (Date.now() - _reRouteT0 > overallDeadlineMs) {
      console.warn('[reRouteSegments] overall deadline exceeded — remaining legs left as straight lines');
      sub = [pts[i], pts[i + 1]];
    } else {
      sub = await Router.autoRouteProg(pts[i], pts[i + 1],
        (path) => { if (onProgress) onProgress([...result, ...path.slice(1)]); },
        (t)    => { if (onText) onText(segLabel + t); },
        false, _currentDraftFt(), _tideHeight, _makeSearchDotCallback(), null, perLegDeadlineMs
      );
    }
    // Index of pts[i] within the full route this leg is about to land in —
    // `result` already holds everything before this leg, so its own last
    // index IS where this leg starts. Lets a fallback marker's click
    // insert a new vertex at exactly the right spot (see
    // _showRouteFallbackWarning) without the caller needing to re-derive it.
    const legIndex = result.length - 1;
    if (sub.length <= 2) {
      // A 2-point result isn't automatically a naive "couldn't route it"
      // straight line — the coastal-standoff ladder (router.js's
      // _addRingNodes) can legitimately return just [start, end] with
      // marginal:true on one of them for a real, land-avoiding path that's
      // simply tighter than the normal comfort standoff (see its own
      // comment: "a real route was found, it just doesn't meet the normal
      // comfort standoff"). Found live testing the nudge-offshore feature
      // (v713): a short leg to a just-barely-comfortable nudge point kept
      // getting reported as "couldn't avoid land" even though the router
      // found a real, verified-clear path — _marginalLegFromPath was only
      // ever checked for a longer (>2 point) result, so this case fell
      // through to classifyFallbackSeg's straight-line land/hazard check
      // instead, which has no idea a real path was actually found.
      if (sub.some(p => p.marginal)) {
        fallbacks++;
        fallbackSegs.push({ a: pts[i], b: pts[i + 1], tightClearance: true, kind: sub.find(p => p.marginal).marginalKind || 'shore', legIndex });
      } else {
        // A 2-point answer is also what the router returns for a leg that's
        // simply open water — the normal case when re-routing an already-
        // routed route, whose consecutive points are clear by construction.
        // Found 2026-10-07 once Re-route became reachable in edit mode: a
        // "✓ Route clear" Camden route came back with "8 legs couldn't
        // avoid land". Only a leg that really crosses land/a hazard — or
        // can't be checked (thin coverage) — is a fallback.
        const cls = Router.classifyFallbackSeg(pts[i], pts[i + 1]);
        if (cls.crossesLand || cls.crossesHazard || cls.coverage !== 'core') {
          fallbacks++;
          fallbackSegs.push({ a: pts[i], b: pts[i + 1], legIndex, ...cls });
        }
      }
    } else {
      const marginalSeg = _marginalLegFromPath(sub, legIndex);
      if (marginalSeg) { fallbacks++; fallbackSegs.push(marginalSeg); }
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
// A `marginal` node (see _addRingNodes) means A* found a real, land-avoiding
// path through this leg, just via a passage tighter than our normal comfort
// standoff. Pinpoint it (rather than the leg's original endpoints) so the ⚠
// marker lands where the squeeze actually is.
// baseIndex offsets `idx` into whatever larger points array `path` will
// eventually be spliced into — 0 (the default) when `path` already IS
// that full array, as most callers pass it.
function _marginalLegFromPath(path, baseIndex = 0) {
  const idx = path.findIndex(p => p.marginal);
  if (idx < 0) return null;
  return {
    a: path[Math.max(0, idx - 1)],
    b: path[Math.min(path.length - 1, idx + 1)],
    tightClearance: true,
    kind: path[idx].marginalKind || 'shore', // 'shore' (close to land) or 'shoal' (close to charted shallows)
    legIndex: baseIndex + Math.max(0, idx - 1),
  };
}

function _fallbackReasonLabel(seg) {
  // A real, land-avoiding route WAS found here — just one that squeezes
  // through a passage tighter than our normal comfort standoff, because no
  // charted channel/buoy data exists for it (see COASTAL_STANDOFF_LADDER's
  // fallback in _addRingNodes). Distinct from an actual land/hazard crossing.
  // Two different "real route found, just tight" cases (router.js tags
  // which): close to shore, or close to charted water too shallow for the
  // boat. One shared label used to describe both as "off shore" (2026-10-05).
  if (seg.tightClearance) return seg.kind === 'shoal'
    ? 'charted shallow water (too shallow for your draft at this tide)'
    : 'shore (no charted channel here)';
  if (seg.crossesLand && seg.crossesHazard) return 'land and a charted hazard';
  if (seg.crossesHazard) return 'a charted hazard (rock/obstruction/wreck)';
  return 'land'; // crossesLand, or neither flag matched (still an unverified straight line)
}

let _routeFallbackLayer = null;
// onRaiseTimeout: optional retry callback, only supplied by a caller that
// has a live start/end/name in hand and can re-run the same AutoRoute —
// direct request: "if it times out, perhaps it could ask the user if they
// want to raise the threshold" instead of just landing on the same
// "add a waypoint" advice a genuinely-unroutable case gets, which isn't
// the right fix when the real cause was running out of search time.
function _showRouteFallbackWarning(fallbackSegs, onRaiseTimeout = null) {
  if (_routeFallbackLayer) { _routeFallbackLayer.clearLayers(); _routeFallbackLayer = null; }
  if (!fallbackSegs || !fallbackSegs.length) return;
  _routeFallbackLayer = L.layerGroup().addTo(_map);

  const mids = fallbackSegs.map(seg => ({
    lat: (seg.a.lat + seg.b.lat) / 2,
    lon: (seg.a.lon + seg.b.lon) / 2,
  }));
  mids.forEach((m, i) => {
    const seg = fallbackSegs[i];
    const reason = _fallbackReasonLabel(seg);
    const verb = seg.tightClearance ? 'Passes close to' : "Couldn't avoid";
    L.marker([m.lat, m.lon], {
      icon: L.divIcon({
        className: '',
        html: '<div class="davy-jones-icon">&#9888;</div>',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      }),
      zIndexOffset: 900,
    }).bindTooltip(`${verb} ${reason} here — tap to help by positioning a node`,
                    { permanent: false, direction: 'top', offset: [0, -6] })
      .on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        _map.setView([m.lat, m.lon], 16);
        // Every real _showRouteFallbackWarning caller already enters edit
        // mode for the affected route before this warning ever appears
        // (see _onDrawConfirm/_triggerAutoRoute/the reroute handlers), so
        // _editPoints already matches — no separate "which route" lookup
        // needed. Drop a new vertex right at the trouble spot, already
        // flashing (.edit-vertex-new, via _insertVertex's _newVertexIdx)
        // and draggable — same "flash a new node, drag to position" UX
        // Node Ops' own Insert button already uses. Per direct request:
        // turn a passive warning into "help me by positioning this node"
        // instead of leaving the user to add a waypoint from scratch.
        if (seg.legIndex != null && _editMode && _editPoints.length) {
          _insertVertex(seg.legIndex, L.latLng(m.lat, m.lon));
          _renderEditLayers();
          // Inserting shifts every LATER leg's index by one — the other
          // markers' own legIndex values are now stale. Clear them rather
          // than risk inserting at the wrong spot; Reroute afterward
          // regenerates a fresh, correctly-indexed set for anything still
          // wrong, same rhythm as fixing one thing at a time already
          // established by the Reroute button itself.
          _routeFallbackLayer?.clearLayers();
        }
      })
      .addTo(_routeFallbackLayer);
  });

  const n = fallbackSegs.length;
  const anyTight  = fallbackSegs.some(s => s.tightClearance);
  const anyHazard = fallbackSegs.some(s => s.crossesHazard);
  const anyLand   = fallbackSegs.some(s => !s.tightClearance && (s.crossesLand || !s.crossesHazard));
  // A real route was found for every flagged leg here — just tighter than
  // our normal comfort standoff, since no charted channel/buoy data exists
  // for this passage. Different from a genuine unresolved land/hazard
  // crossing: the ⚠ marker (with its tooltip, above) already flags exactly
  // where to double-check — a modal popup + TTS on top of that fired for
  // EVERY tight leg during repeated/batch AutoRoute testing and was "too
  // much" per direct report. Reserve the interrupting popup+speech for an
  // actual unresolved land/hazard crossing, the only case that still needs
  // a waypoint added before the route is safe to use.
  if (anyTight && !anyHazard && !anyLand) return;

  const first = mids[0];
  const reasonSummary = anyHazard && anyLand ? 'land or a charted hazard'
    : anyHazard ? 'a charted hazard (rock/obstruction/wreck)'
    : 'land';

  // A timed-out search and a genuinely-unroutable one look identical here
  // (same straight-line fallback, same land/hazard crossing) — only
  // router.js itself knows which happened (see its own `_timedOutFallback`
  // comment), passed down as onRaiseTimeout being non-null. Raising the
  // limit is real advice only for the timeout case: it can't help a truly
  // disconnected graph, so the ordinary "add a waypoint" wording stays the
  // default and this is additive, not a replacement.
  const timeoutInput = document.getElementById('nf-route-timeout-s');
  const currentS = _currentDeadlineMs() / 1000;
  const raisedS = Math.min(120, Math.round(currentS * 2));
  const canRaise = onRaiseTimeout && raisedS > currentS;

  const body = `<b>Couldn't avoid ${reasonSummary}</b> — ${n} leg${n > 1 ? 's' : ''} still cross${n > 1 ? '' : 'es'} it as a straight line.<br>`
    + `Add a waypoint in the passage${n > 1 ? ' (⚠ marks each spot)' : ''}, then re-route.`
    + (canRaise
        ? `<br><br>This may have run out of search time (${currentS}s limit) rather than being truly impossible.<br>`
          + `<button id="rfw-raise-timeout-btn" style="margin-top:4px">Try again with ${raisedS}s limit</button>`
        : '');
  const speakMsg = `Warning: ${n} route leg${n > 1 ? 's' : ''} couldn't avoid ${reasonSummary}. Add a waypoint and re-route.`
    + (canRaise ? ` This may have run out of search time — tap the popup to try again with more time.` : '');

  const popup = L.popup({ maxWidth: 300, autoPan: true })
    .setLatLng([first.lat, first.lon])
    .setContent(`<div style="font-size:13px;line-height:1.5">${body}</div>`)
    .openOn(_map);

  if (canRaise) {
    // Popup content is a fresh DOM node each time it's opened — wire the
    // click after openOn, same pattern _showRouteFallbackWarning's own
    // ⚠ markers use above.
    popup.getElement()?.querySelector('#rfw-raise-timeout-btn')?.addEventListener('click', () => {
      if (timeoutInput) timeoutInput.value = raisedS;
      _map.closePopup(popup);
      onRaiseTimeout();
    });
  }

  setStatus(speakMsg);
  TTS.sayImmediate(speakMsg);
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
        _touch(route);
        localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
        // Sketch points are placed entirely by hand — never auto-routed —
        // so this is exactly the case that needs an explicit check: nothing
        // else in the app has verified these points yet.
        const found = _checkRouteHazards(extIdx, true);
        if (!found.length) {
          // "nm" abbreviation for the visual status line; TTS gets the full
          // "nautical miles" spelling — a bare "nm" is read as nanometers
          // by browser speech synthesis. Real user report, 2026-09-28.
          setStatus(`${route.name} updated — ${totalNm.toFixed(1)} nm`);
          TTS.sayImmediate(`${route.name} updated — ${totalNm.toFixed(1)} nautical miles`);
        }
      }
    } else {
      const name = _nextRouteName();
      _saveRoute(name, pts);
      const newIdx = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]').length - 1;
      const found = _checkRouteHazards(newIdx, true);
      if (!found.length) {
        setStatus(`${name} saved — ${totalNm.toFixed(1)} nm`);
        TTS.sayImmediate(`${name} saved — ${totalNm.toFixed(1)} nautical miles`);
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

  _exitSketchMode();  // resets extendingRouteIdx

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
  const ct = Query.segCrossTrack(a.lon, a.lat, b.lon, b.lat, latlng.lng, latlng.lat);
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
    const ct = Query.segCrossTrack(a.lon, a.lat, b.lon, b.lat, latlng.lng, latlng.lat);
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
      const ct = Query.segCrossTrack(a.lon, a.lat, b.lon, b.lat, pLon, pLat);
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
    const ct = Query.segCrossTrack(a.lon, a.lat, b.lon, b.lat, pLon, pLat);
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
        // The purple tint alone (edit-vertex-overnight) was the only cue
        // that a node is an overnight stop — no actual icon, unlike the
        // bed-icon marker a saved route gets outside of edit mode.
        // Keeping the node number is deliberate (waypoints get referred to
        // by number, e.g. "node 10") — the bed rides as a small badge
        // instead of replacing it.
        html: pts[idx].overnight
          ? `<span class="edit-vertex-num">${idx + 1}</span><span class="edit-vertex-overnight-badge">&#128719;</span>`
          : `<span class="edit-vertex-num">${idx + 1}</span>`,
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


// The one word this banner never said, per direct feedback: gold routes are
// overwhelmingly "open in the Node-Ops editor" (a plain tap on any saved
// route jumps straight into edit mode), but nothing in the UI ever actually
// used the word "editing" — just the bare route name next to a pencil icon.
function _setEditBannerLabel(suffix = '') {
  document.getElementById('edit-banner-label').textContent = `Editing "${_editRouteName}"${suffix}`;
}

function _cancelAddNodeMode() {
  _addNodeMode = false;
  if (_map) { _map.dragging.enable(); _map.getContainer().style.cursor = ''; }
  _setEditBannerLabel();
  _updateEditToolsPanel();
}

function _updateEditToolsPanel() {
  document.getElementById('etp-insert-node')?.classList.toggle('active', _addNodeMode);
  document.getElementById('etp-delete')?.classList.toggle('active', _deleteMode);
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

  for (const w of WaypointsStorage.loadUserWaypoints()) {
    const d = pt.distanceTo(_map.latLngToContainerPoint([w.lat, w.lon]));
    if (d < bestD) { bestD = d; best = { lat: w.lat, lon: w.lon, name: w.name, type: 'waypoint' }; }
  }

  return best;
}

// Persistent, always-draggable marker for the current focus — lets the user nudge the
// focus point at any time, not just during initial placement. Snaps the same way the
// old drag-to-place-focus flow's temporary marker used to (that flow existed only
// behind the right-click menu's "Set focus here", now removed — a marker's own popup
// already has a point to focus on directly, so it calls Query.setFocus right away
// instead of needing a drag-and-snap step of its own).
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
  // Captured before _startRouteAnimation runs — it Clear-Screens as its
  // first step, which exits edit mode as part of that, which would
  // otherwise wipe _editPoints/_editRouteIdx out from under this function
  // before the animation ever got them.
  const route = {
    name:   _editRouteName || 'Route',
    points: _editPoints.map(_stripPoint),
  };
  // Confirmed live as a real bug: this (and the matching HTML default)
  // used to fall back to 500x — meaning a whole multi-hour sail flew by
  // in a few real seconds, giving no chance to actually watch the route.
  // True real-world speed (1x) overcorrected the other way: at a realistic
  // ~5kt, the boat covers a few meters per real second — sub-pixel movement
  // on a zoomed-out full-route view, so it LOOKS frozen even though it's
  // technically animating (confirmed the multiplier itself was applying
  // correctly — the banner's own "10x" label was live and accurate; it just
  // wasn't fast enough to visibly move on screen). 10x had the same problem,
  // just less severely. 100x is the confirmed-good default: the user's own
  // manual workaround (50kt at the then-default compression) looked right,
  // and that's ~10x higher than 10x-at-5kt — this matches it directly.
  if (!document.querySelector('.track-compress.selected')) {
    document.querySelector('.track-compress[data-compress="100"]')?.classList.add('selected');
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
  localStorage.setItem(EDITING_ROUTE_KEY, route.name);
  _editPoints = route.points.map(_stripPoint);
  _editOriginalPoints = route.points.map(_stripPoint);
  _deleteMode = false;
  _addNodeMode = false;
  _fixNodesMode = false;
  _editHistory = [];
  _selectedEditNodeIdx = new Set();

  _setEditBannerLabel();
  document.getElementById('edit-banner').style.display = 'flex';
  _appEl.classList.add('edit-mode');
  _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
  if (_map) {
    if (_savedRoutesLayer) _map.removeLayer(_savedRoutesLayer);
    _map.invalidateSize();
    _renderEditLayers();
    _map.getContainer().addEventListener('mouseup', _editPlaceNode);
  }
  document.getElementById('edit-tools-panel').style.display = 'flex';
  document.getElementById('edit-tools-panel').classList.remove('collapsed');
  document.getElementById('etp-title').classList.remove('collapsed');
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
  localStorage.removeItem(EDITING_ROUTE_KEY);
  _editPoints = [];
  _newVertexIdx = -1;
  _deleteMode = false;
  _addNodeMode = false;
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
  // Re-shows #left-rail-zoom-pan (hidden for the whole of edit mode) at
  // whatever top offset was last synced, possibly stale if the Leaflet
  // compass corner's own height changed while it was hidden — cheap to
  // just recompute rather than leave that as a latent gap.
  _syncLeftRailStack();
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

// Direct request (2026-09-30): tap-tooltips for the #edit-banner toolbar
// (Show hazards/Show info/Copy waypoints/Mail waypoints/Revert/Delete
// route/OK/Cancel) — see _addTapTooltip's own comment for why.
['edit-hazards-btn', 'edit-info-btn', 'edit-copy-wpts-btn', 'edit-mail-wpts-btn',
 'edit-revert-btn', 'delete-route-btn', 'edit-ok-btn', 'edit-cancel-btn']
  .forEach(id => _addTapTooltip(document.getElementById(id)));

// Direct request: Node Ops down to symbol-only buttons (was symbol + word,
// e.g. "✛ Add") — their existing `title` text is already the full
// description, same tap-tooltip wiring as the #edit-banner toolbar above
// so that description is still reachable on a touch-only device now that
// the word itself is gone from the button face.
['etp-add-node', 'etp-insert-node', 'etp-delete', 'etp-overnight', 'etp-animate']
  .forEach(id => _addTapTooltip(document.getElementById(id)));
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
  _setEditBannerLabel(` — ${nm} nm / ${mi} mi · ${wpts} waypoints`);
});

// Shared by the edit-route toolbar and the Routes/Tracks panel row corner
// buttons — produces a precise, directly-pasteable coordinate list (decimal
// degrees, not a DM/DMS display string) for accurate bug reports/testing.
const _wptCopyOverlay = document.getElementById('wpt-copy-overlay');
const _wptCopyText    = document.getElementById('wpt-copy-text');
const _wptCopyBtn     = document.getElementById('wpt-copy-btn');
function _waypointsJson(points) {
  return JSON.stringify(
    points.map(p => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })),
    null, 2
  );
}
function _showCopyWaypointsOverlay(name, points) {
  document.getElementById('wpt-copy-title').textContent = `${name} — ${points.length} waypoints`;
  const json = _waypointsJson(points);
  _wptCopyText.value = json;
  _wptCopyOverlay.classList.add('open');
  _wptCopyText.focus();
  _wptCopyText.select();
  navigator.clipboard?.writeText(json).catch(() => {}); // best-effort; textarea is the reliable fallback
}
document.getElementById('edit-copy-wpts-btn').addEventListener('click', () => {
  _showCopyWaypointsOverlay(_editRouteName, _editPoints);
});
// Phone-friendly alternative to the copy button, for the specific "send this
// bad route to the developer" flow — copy+paste-into-an-email is klunky on a
// phone, this prefills a real email instead. Recipient is hardcoded: this
// app has exactly one developer/maintainer, there's no multi-tenant "admin"
// to configure.
document.getElementById('edit-mail-wpts-btn').addEventListener('click', () => {
  const subject = encodeURIComponent(`AudioChart AutoRoute bug report — ${_editRouteName}`);
  const body = encodeURIComponent(
    `Route: ${_editRouteName}\nWaypoints: ${_editPoints.length}\nApp version: ${VERSION}\n\n`
    + `${_waypointsJson(_editPoints)}`
  );
  window.location.href = `mailto:egilchri@gmail.com?subject=${subject}&body=${body}`;
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

// Node Ops' title toggles its own panel's collapsed state (mirrored onto
// itself too, for the chevron) and doubles as the panel's drag handle — see
// _makeDraggable below and the edit-mode hide list in app.css, which hides
// #right-rail (Node Ops' old home) entirely for the duration of editing.
document.getElementById('etp-title').addEventListener('click', () => {
  const collapsed = document.getElementById('edit-tools-panel').classList.toggle('collapsed');
  document.getElementById('etp-title').classList.toggle('collapsed', collapsed);
});
_makeDraggable(document.getElementById('edit-tools-panel'), document.getElementById('etp-title'));

// Just plop a new node down near the end of the route and connect it —
// no map click, no separate sketch-mode round trip (that used to exit edit
// mode entirely to place it). The node lands a fixed distance away on
// screen, continuing the same on-screen direction as the last leg when
// there is one, so it's never hidden directly under the node it's
// attached to. Vertex markers are already draggable (see
// _renderEditLayers), so dragging it into its real position is just the
// normal drag-a-node gesture — no mode switch needed for that either.
document.getElementById('etp-add-node').addEventListener('click', () => {
  if (!_editMode || !_editPoints.length || !_map) return;
  if (_addNodeMode) _cancelAddNodeMode();
  _pushEditHistory();
  const last   = _editPoints[_editPoints.length - 1];
  const lastPx = _map.latLngToContainerPoint([last.lat, last.lon]);
  const OFFSET_PX = 50;
  let dx = OFFSET_PX, dy = OFFSET_PX; // single-point route: just offset down-and-right
  if (_editPoints.length >= 2) {
    const prev   = _editPoints[_editPoints.length - 2];
    const prevPx = _map.latLngToContainerPoint([prev.lat, prev.lon]);
    const vx = lastPx.x - prevPx.x, vy = lastPx.y - prevPx.y;
    const len = Math.hypot(vx, vy) || 1;
    dx = (vx / len) * OFFSET_PX;
    dy = (vy / len) * OFFSET_PX;
  }
  const newLatLng = _map.containerPointToLatLng([lastPx.x + dx, lastPx.y + dy]);
  _editPoints.push({ lat: newLatLng.lat, lon: newLatLng.lng });
  _newVertexIdx = _editPoints.length - 1;
  _selectedEditNodeIdx.clear();
  _renderEditLayers();
  clearTimeout(_liveHazardTimer);
  _liveHazardTimer = setTimeout(_liveHazardCheck, 300);
});

document.getElementById('etp-insert-node').addEventListener('click', () => {
  _addNodeMode = true;
  _renderEditLayers();
  _map.dragging.disable();
  _map.getContainer().style.cursor = 'crosshair';
  _setEditBannerLabel(' — click to insert node');
  _updateEditToolsPanel();
});

document.getElementById('etp-delete').addEventListener('click', () => {
  _deleteMode = !_deleteMode;
  _fixNodesMode = false;
  _setEditBannerLabel(_deleteMode ? ' — click a node to delete it' : '');
  _renderEditLayers();
  _updateEditToolsPanel();
});

// No more arm-a-mode-then-click-a-vertex — per direct request, this
// always targets the route's own current last waypoint (the one that
// actually matters for "where am I stopping tonight"), confirms once,
// and — on a fresh mark — goes straight into the next-leg destination
// prompt without a second, redundant confirm (this one already served
// that purpose). An already-marked last waypoint offers to unmark
// instead, so the toggle behavior isn't lost, just no longer needs a
// separate click-a-node step to reach.
document.getElementById('etp-overnight').addEventListener('click', () => {
  if (!_editMode || _editPoints.length < 1) return;
  const idx = _editPoints.length - 1;
  const p = _editPoints[idx];
  if (p.overnight) {
    if (!confirm(`Remove the overnight-stop mark from waypoint ${idx + 1}?`)) return;
    _pushEditHistory();
    _editPoints[idx] = { lat: p.lat, lon: p.lon };
    _renderEditLayers();
    return;
  }
  if (!confirm(`Mark waypoint ${idx + 1} (the last on this route) as an overnight stop?`)) return;
  _pushEditHistory();
  _editPoints[idx] = { lat: p.lat, lon: p.lon, overnight: true };
  _renderEditLayers();
  _promptNextLegAutoRoute(_editPoints[idx]);
});

document.getElementById('etp-animate').addEventListener('click', _animateEditRoute);

// Called right after the etp-overnight button marks the route's last
// waypoint as an overnight stop (its own confirm dialog already covers
// consent for this) — connects "I just marked tonight's anchorage" to
// "let's plan tomorrow's leg" in one motion instead of leaving the user
// to separately remember to extend the route later. Reuses the same
// _reRouteSegments/_showRerouteOverlay machinery the (now-removed)
// etp-reroute button used, just for a single new leg instead of the
// whole route.
async function _promptNextLegAutoRoute(fromPoint) {
  // Loop on a bad name instead of dropping the whole flow after one try —
  // per direct report, a name that doesn't resolve (a marina/business name
  // like "Billings Marine, Swan's Island" isn't itself a charted place)
  // should let the user immediately try another (e.g. "Stonington"), not
  // force them to re-trigger this whole prompt by re-toggling the
  // overnight flag. Only an actually-cancelled prompt (empty/Cancel) exits.
  // Uses _showTextPrompt, not window.prompt() — confirmed live that a
  // second native prompt() fired right after the first one (no click in
  // between) can be silently suppressed by the browser/webview's own
  // dialog-spam protection, which is exactly what a retry loop needs to do.
  let dest = null;
  while (!dest) {
    const query = await _showTextPrompt('Destination — place or waypoint name:');
    if (!query) return;
    dest = await _resolveNamedDestination(query);
    if (!dest) {
      // _resolveNamedDestination already announces a genuine "couldn't
      // find" miss, but stays silent when it showed a disambiguation
      // picker and the user closed it without choosing — this is the
      // guaranteed fallback so failing to resolve is never silent here.
      const msg = `Couldn't resolve "${query}" — try another name, or Cancel to skip the next leg.`;
      setStatus(msg);
      TTS.sayImmediate(msg);
    }
  }
  const destPt = { lat: dest.lat, lon: dest.lon };
  const ui = _showRerouteOverlay([fromPoint, destPt]);
  // _reRouteSegments only sees this one new leg in isolation, so its own
  // legIndex values start at 0 — offset them to where this leg actually
  // lands once appended to the real _editPoints below (captured now,
  // before the push, since fromPoint is _editPoints' current last point).
  const _nextLegBaseIdx = _editPoints.length - 1;
  _reRouteSegments([_stripPoint(fromPoint), destPt], ui.update.bind(ui), ui.setText.bind(ui), 'Next Leg')
    .then(({ points, fallbacks, fallbackSegs, blocked }) => {
      ui.remove();
      if (blocked) return;  // _reRouteSegments already announced why
      _pushEditHistory();  // its own undo step, separate from the overnight toggle
      _editPoints.push(...points.slice(1).map(_stripPoint));  // points[0] duplicates fromPoint
      _selectedEditNodeIdx.clear();
      _renderEditLayers();
      const found = _liveHazardCheck();
      if (!found.length) {
        if (fallbacks > 0) {
          _showRouteFallbackWarning(fallbackSegs.map(s => ({ ...s, legIndex: s.legIndex + _nextLegBaseIdx })));
        } else {
          setStatus('Next leg routed — review and Save when ready.');
        }
      }
    })
    .catch(err => {
      ui.remove();
      setStatus('Auto-route failed.');
      console.error('[nextLeg]', err);
    });
}

// Builds the lower-right Rename/Export/Copy/Delete corner controls for an .rp-row (shared
// between the Routes and Tracks list panels). getPoints() returns the point array to export;
// onRename(newName) persists the rename and should itself trigger a re-render of the owning
// panel; onDelete(), if given, does the same for deletion (own confirm() included) and adds
// the corner's Delete button — omit it for rows that shouldn't offer deletion here. itemLabel
// ('route'/'track') is just for tooltip wording.
function _buildRpCornerButtons(row, name, getPoints, onRename, onDelete, itemLabel = 'item') {
  const corner = document.createElement('div');
  corner.className = 'rp-corner';

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'rp-corner-btn';
  renameBtn.textContent = '✎ Rename';
  renameBtn.title = `Rename this ${itemLabel}`;
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
  exportBtn.title = `Save this ${itemLabel} as a GPX file`;
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    GpxExport.downloadGpx(getPoints(), name);
  });

  const copyWptsBtn = document.createElement('button');
  copyWptsBtn.type = 'button';
  copyWptsBtn.className = 'rp-corner-btn';
  copyWptsBtn.textContent = '📋 Copy waypoints';
  copyWptsBtn.title = `Copy this ${itemLabel}'s waypoints as text`;
  copyWptsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _showCopyWaypointsOverlay(name, getPoints());
  });

  corner.appendChild(renameBtn);
  corner.appendChild(exportBtn);
  corner.appendChild(copyWptsBtn);

  if (onDelete) {
    // Deliberately last, its own danger color, and reachable only once the
    // row is expanded — a plain tap on a collapsed row (the common case)
    // now unambiguously means "toggle shown on map," with nothing
    // destructive within reach of a stray tap. Was previously an "×"
    // sitting inline in the always-visible name row (always-visible on
    // touch devices, per the old .rp-delete-btn media-query override),
    // right next to the active/hidden state mark — reported as too easy to
    // hit by accident while trying to activate a route.
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'rp-corner-btn rp-corner-btn-danger';
    deleteBtn.textContent = '🗑 Delete';
    deleteBtn.title = `Permanently delete this ${itemLabel}`;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete();
    });
    corner.appendChild(deleteBtn);
  }

  return corner;
}

// ── Route animation ───────────────────────────────────────────────────────────

const _animBanner     = document.getElementById('anim-banner');
const _animBannerText = document.getElementById('anim-banner-text');

// ── Nautical chart display helpers ───────────────────────────────────────────

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

// User-configurable version of Query.COMFORTABLE_CLEARANCE_M (v722 shipped
// it as a fixed 3ft; settable-in-the-UI was the explicitly-flagged
// follow-up). Falls back to that same default when unset/invalid — never
// silently 0, which would make everything "comfortable".
function _getComfortMarginMeters() {
  const el = document.getElementById('nf-comfort-margin-ft');
  const raw = el ? parseFloat(el.value) : parseFloat(localStorage.getItem('audiochart-comfort-margin-ft') || '');
  return isFinite(raw) && raw >= 0 ? raw * 0.3048 : Query.COMFORTABLE_CLEARANCE_M;
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
        icon: MarkerIcons.makeCurrentArrowIcon(cur.speed, cur.dir, cur.type),
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
    <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8" fill="rgba(18,13,8,0.5)" stroke="var(--brass-dim)"/>
    ${inner}
  </svg>`;

  const ph = _tidePhaseAt(now);
  if (!ph) {
    return frame(`<text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" fill="var(--parchment-dim)" font-family="var(--font-brass-mono)" font-size="10">Tide: --</text>`);
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
    <path d="${areaD}" fill="rgba(199,154,72,0.16)" stroke="none"/>
    <path d="${pathD}" fill="none" stroke="var(--brass)" stroke-width="1.5"/>
    <circle cx="${xAt(now.getTime()).toFixed(1)}" cy="${yAt(ph.height).toFixed(1)}" r="3" fill="var(--parchment)" stroke="var(--brass-hi)" stroke-width="1.5"/>
    <text x="${W / 2}" y="${H - 4}" text-anchor="middle" fill="${labelColor}" font-family="var(--font-brass-mono)" font-size="9" font-weight="bold">${label}</text>
  `);
}

// Was: `if (_tideOffset === 0) return _tideHeight` — a one-time snapshot
// fetched at load time or whenever the Depths checkbox got toggled, frozen
// from then on until one of those specific triggers happened again. Every
// hazard check that calls this (shallow-area warning triangle, depth-heat
// overlay, nudge-offshore) was silently using a tide reading that could be
// hours stale during a real passage. Direct request, 2026-09-28: interpolate
// live from the already-cached tide-extremes curve (_tideExtremes, kept
// fresh by _refreshTideCycle's own 60s interval) for the CURRENT real time
// instead, the same math _tidePhaseAt already does for the offset-preview
// slider — falls back to the old static _tideHeight only if no cycle data
// has loaded yet.
function _effectiveTideHeight() {
  const sim = _tideOffset === 0 ? new Date() : new Date(Date.now() + _tideOffset * 3_600_000);
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

// Keeps #left-rail-zoom-pan/#vjourney-banner (desktop-only, see their own
// media query) positioned below whatever's actually in the Leaflet top-left
// corner (compass, and — only while following a route — the follow-progress
// readout, which pushed the corner taller than the rail's old hardcoded
// top:110px assumed and left it overlapping this readout's text, reported
// live). Measuring instead of hardcoding a second offset keeps this correct
// regardless of which of those happen to be showing. Zoom and pan themselves
// can no longer overlap EACH OTHER regardless of whether this function has
// run recently — they're flex children of #left-rail-zoom-pan with a real
// CSS `gap` now, not two independently-positioned elements whose non-overlap
// depended on this JS having fired since the last time either one's height
// changed (reported live as still happening after an edit-mode round trip —
// see _exitEditMode's own call to this function). This function now only
// has to get the rail's own top right, not the gap between its two children.
function _syncLeftRailStack() {
  if (window.innerWidth < 768 || !_mapContainer) return; // hidden below this width — nothing to sync
  const mcTop = _mapContainer.getBoundingClientRect().top;
  const corner = document.querySelector('.leaflet-top.leaflet-left');
  const rail = document.getElementById('left-rail-zoom-pan');
  const vjBanner = document.getElementById('vjourney-banner');
  const GAP = 10;
  if (!rail) return;

  const cornerBottom = corner ? corner.getBoundingClientRect().bottom : 30 + mcTop; // viewport-relative
  const railTop = cornerBottom + GAP;
  rail.style.top = Math.round(railTop - mcTop) + 'px';
  // Virtual Journey forces Underway mode on, which hides the rail entirely
  // (!important) — in that case it contributes no height (offsetParent
  // check) instead of leaving a gap, so #vjourney-banner lands directly
  // under the compass/follow-progress stack instead.
  const bottom = (rail.offsetParent !== null) ? rail.getBoundingClientRect().bottom : railTop;

  if (vjBanner && vjBanner.style.display !== 'none') {
    // vjBanner is position:fixed at this breakpoint (see its CSS) — its
    // `top` is viewport-relative already, unlike the rail above
    // (position:absolute inside #map-container), so no mcTop offset here.
    vjBanner.style.top = Math.round(bottom + GAP) + 'px';
  }
}
window.addEventListener('resize', _syncLeftRailStack);

function _updateFollowProgress(lat, lon) {
  if (!_followProgressEl) return;
  const _wasHidden = _followProgressEl.style.display === 'none';
  if (!_followingRouteId) {
    if (!_wasHidden) { _followProgressEl.style.display = 'none'; _syncLeftRailStack(); }
    return;
  }
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const route = routes.find(r => r.id === _followingRouteId);
  const pts = route?.points;
  if (!pts || pts.length < 2) {
    if (!_wasHidden) { _followProgressEl.style.display = 'none'; _syncLeftRailStack(); }
    return;
  }

  // Advance the "next waypoint" pointer using along-track projection onto the
  // current leg (same Query.segCrossTrack math as hazard checking), not just a raw
  // arrival-radius check — a route that cuts a corner near a waypoint (never
  // coming within ARRIVAL_THRESHOLD_NM of it) would otherwise get the pointer
  // stuck there for the rest of the trip, since it'd never trip that check.
  while (_followingLegIdx < pts.length - 1) {
    const a = pts[_followingLegIdx - 1], b = pts[_followingLegIdx];
    const segLen = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
    const ct = Query.segCrossTrack(a.lon, a.lat, b.lon, b.lat, lon, lat);
    const pastSegment = ct
      ? ct.alongTrack >= segLen
      : Query.distanceNm(lon, lat, b.lon, b.lat) <= ARRIVAL_THRESHOLD_NM;
    if (!pastSegment) break;
    _followingLegIdx++;
  }
  const nextPt = pts[_followingLegIdx];
  const distToNext = Query.distanceNm(lon, lat, nextPt.lon, nextPt.lat);
  const brgToNext = trueTomagnetic(Query.bearing(lon, lat, nextPt.lon, nextPt.lat));
  let distToEnd = distToNext;
  for (let i = _followingLegIdx; i < pts.length - 1; i++) {
    distToEnd += Query.distanceNm(pts[i].lon, pts[i].lat, pts[i + 1].lon, pts[i + 1].lat);
  }
  let distTraveled = 0;
  for (let i = 1; i < _trackRecPoints.length; i++) {
    distTraveled += Query.distanceNm(_trackRecPoints[i - 1].lon, _trackRecPoints[i - 1].lat, _trackRecPoints[i].lon, _trackRecPoints[i].lat);
  }

  // Re-sync focus only on a real leg advance, not every GPS tick — so an
  // ad-hoc "bearing to X" query in between isn't immediately overwritten.
  // See the matching initial sync in _startFollowingRoute.
  if (_followingLegIdx !== _followFocusLegIdx) {
    Query.setFocus(nextPt.lat, nextPt.lon, `${route.name} — waypoint ${_followingLegIdx + 1}`, 'waypoint');
    _updateFocusButton();
    _followFocusLegIdx = _followingLegIdx;
  }

  _followProgressEl.style.display = '';
  if (_wasHidden) _syncLeftRailStack();
  _followProgressEl.innerHTML =
    `<div>Next: ${bearingToDisplay(brgToNext)}, ${distToNext.toFixed(1)} nm</div>` +
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
  marker?.setIcon(MarkerIcons.animBoatIcon(bearingDegTrue));
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
  if (_sketchMode || _drawMode || _animMode) return; // _editMode intentionally allowed
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
      icon: MarkerIcons.animBoatIcon(_simTrackDeg), pane: 'simTrackBoatPane',
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
  marker?.setIcon(MarkerIcons.boatIcon());
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

// Shared "Bring boat here" action — moves the manual test position, shows
// the map (exiting any compact/list/input-focus state), refreshes bearing
// lines, and announces a Where-Am-I readout. One function backing every
// place this action is offered (map right-click, a waypoint's own "..."
// actions, a Test Set marker's popup) so they can't drift out of sync with
// each other the way the three near-duplicate inline copies used to.
// `label`, if given, names the point for the status message; omit it for
// an arbitrary tapped point that has no name of its own.
function _bringBoatTo(lat, lon, label) {
  GPS.setManualPosition(lat, lon);
  syncTestPosButton();
  document.getElementById('map-container').style.display = 'block';
  _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
  _showBoatPosition(lat, lon);
  _map.invalidateSize();
  _updateBearingLines(lat, lon);
  setStatus(label ? `Boat moved to ${label}.` : 'Boat moved.');
  _runWhereAmI(lat, lon);
  if (serverUrl) {
    fetch(`${serverUrl}/api/test-position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon }),
    }).catch(() => {});
    Query.loadData(lat, lon).then(() => {
      dataLoaded = true;
      setStatus(label ? `Ready. (${label})` : 'Ready. (map position)');
    }).catch(() => {});
  }
}

// Objects/Routes/Tracks-within radius pickers — standalone floating panels
// (see the #map-ctx-*-submenu CSS rule for the look), opened from a
// marker's own popup rather than the right-click menu (moved there per
// direct request). _nearPointOrigin holds the {lat, lng} point the flyout
// that's currently open should act on once a radius is picked — set right
// before showing a flyout, read once by its one delegated click handler
// (wired once in _ensureMap, same singleton elements every time), so
// reopening the same flyout for a different marker can't act on a stale
// point left over from the last one.
let _nearPointOrigin = null;

// `anchorRect`, not a live element — callers that close a Leaflet popup
// before opening the flyout (every current caller does, to avoid the
// popup and the flyout both being open at once) need their anchor
// button's position captured BEFORE closePopup() removes it from the DOM,
// not after; a rect survives that, an element reference's geometry doesn't.
function _openNearPointFlyout(el, anchorRect, origin) {
  _closeNearPointFlyouts();
  _nearPointOrigin = origin;
  el.style.display = 'block';
  const mw = el.offsetWidth, mh = el.offsetHeight;
  const anchor = anchorRect || null;
  const left = anchor ? Math.min(anchor.right - mw, window.innerWidth  - mw - 4) : 4;
  const top  = anchor ? Math.max(4, anchor.top  - mh - 4)                        : 4;
  el.style.left = Math.max(4, left) + 'px';
  el.style.top  = Math.max(4, top)  + 'px';
}

function _closeNearPointFlyouts() {
  for (const id of ['map-ctx-objects-submenu', 'map-ctx-routes-near-submenu', 'map-ctx-tracks-near-submenu']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
}

function _exitAnimMode() {
  if (_map) _map.off('click', _exitAnimMode);
  if (_map && _animClickHandler) { _map.off('click', _animClickHandler); _animClickHandler = null; }
  _animMode = false;
  _animFollowMode = false;
  _animCurrentLat = null;
  _animCurrentLon = null;
  _setAnimSpeedFn = null;
  if (_animRafId)      { cancelAnimationFrame(_animRafId); _animRafId = null; }
  if (_animIntervalId) { clearInterval(_animIntervalId);   _animIntervalId = null; }
  TTS.stop();
  _appEl.classList.remove('anim-mode');
  _syncLeftRailStack(); // re-shows #left-rail-zoom-pan — see _exitEditMode's own call for why
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
document.getElementById('anim-speed-input').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (v > 0) _setAnimSpeedFn?.(v);
});


// ── Virtual Journey ──────────────────────────────────────────────────────────

// #bottom-hud (and #focus-btn inside it) is position:fixed to the VIEWPORT's
// bottom-right corner, not to the map's shrunk box — same layout conflict
// already hit and documented for #edit-banner. There the fix was to just
// hide #bottom-hud, but that's the wrong tool here: the whole point of
// Virtual Journey (vs. the old anim-mode) is that #focus-btn stays live and
// tappable during playback. So instead, track the banner's real (variable —
// tide chart, wrapped text) height in a CSS var and let #bottom-hud ride up
// above it.
let _vjBannerRO = null;
function _syncVjBannerClearance() {
  const banner = document.getElementById('vjourney-banner');
  // Only below the desktop breakpoint (see #vjourney-banner's own CSS) does
  // the banner still dock full-width and eat into the bottom of the
  // viewport — at 768px+ it's position:fixed off in the left rail instead
  // (see _syncLeftRailStack), so #bottom-hud has nothing to clear there.
  const h = (window.innerWidth < 768 && banner && banner.style.display !== 'none') ? banner.offsetHeight : 0;
  _appEl.style.setProperty('--vjourney-h', h + 'px');
}

function _startVirtualJourney(route, speedKnots) {
  if (!route.points || route.points.length < 2) return;
  if (_trackRecActive) {
    const msg = 'Already recording/following a route — stop it first.';
    setStatus(msg); TTS.sayImmediate(msg);
    return;
  }
  _stopVirtualJourney(); // supersede any journey already running

  // Rehearsing "underway" is the whole point of Virtual Journey, so it
  // should look underway — force the switch on for the duration. Stopping
  // always forces it back off (not "restore whatever it was") — tried
  // restoring the prior state first, but that left the user stranded
  // without Screen/Map Type/Location whenever Underway already happened
  // to be on before the journey started, since nothing then changed it
  // back. A journey ending is the clear, unambiguous signal to return to
  // the normal planning UI.
  if (!_underwayCheckbox.checked) _setUnderwayMode(true);

  _vjRoute = route;
  _refreshSavedRouteLayers(); // draws this route in VJ-green with waypoints
  _vjSpeedKnots = speedKnots;
  _vjCompress = parseInt(document.querySelector('.vjourney-compress.selected')?.dataset.compress) || 1;
  _vjTraveledNm = 0;
  _vjBaselineNm = 0;

  const segs = [];
  let cumDist = 0;
  for (let i = 1; i < route.points.length; i++) {
    const p1 = route.points[i - 1], p2 = route.points[i];
    const d = Query.distanceNm(p1.lon, p1.lat, p2.lon, p2.lat);
    const brg = MarkerIcons.segBearing(p1.lat, p1.lon, p2.lat, p2.lon);
    segs.push({ lat1: p1.lat, lon1: p1.lon, lat2: p2.lat, lon2: p2.lon, dist: d, cumDist, brg });
    cumDist += d;
  }
  _vjSegs = segs;
  _vjTotalNm = cumDist;

  // Reuse _startFollowingRoute's next-waypoint/focus state (same fields
  // _updateFollowProgress already watches) so "next waypoint", the
  // follow-progress readout, and #focus-btn all work identically whether
  // GPS is real or virtual — but skip its track-recording side effect
  // entirely, since this is a rehearsal, not a real trip to save.
  const last = route.points[route.points.length - 1];
  _followingRouteId = route.id;
  _followingRouteName = route.name;
  _followingDestLat = last.lat;
  _followingDestLon = last.lon;
  _followingLegIdx = route.points.length > 1 ? 1 : 0;
  _followedHazardKnownKeys = new Set();
  if (_liveFollowHazardLayer) { _liveFollowHazardLayer.clearLayers(); _map.removeLayer(_liveFollowHazardLayer); _liveFollowHazardLayer = null; }
  _recheckFollowedRouteHazardsLive(true); // baseline — don't announce hazards already known from route creation/checks
  const firstLegPt = route.points[_followingLegIdx];
  Query.setFocus(firstLegPt.lat, firstLegPt.lon, `${route.name} — waypoint ${_followingLegIdx + 1}`, 'waypoint');
  _updateFocusButton();
  _followFocusLegIdx = _followingLegIdx;
  _appEl.classList.add('following-active');

  document.getElementById('vjourney-route-name').textContent = route.name;
  document.getElementById('vjourney-speed-input').value = speedKnots;
  document.getElementById('vjourney-status').textContent = `Underway · ${speedKnots} kts`;
  document.getElementById('vjourney-pause-btn').textContent = '⏸ Pause';
  document.getElementById('vjourney-banner').style.display = 'flex';
  _appEl.classList.add('vjourney-active');
  _syncVjActivateBtn(route);
  _syncVjBannerClearance();
  _syncLeftRailStack();
  if (!_vjBannerRO) {
    _vjBannerRO = new ResizeObserver(() => { _syncVjBannerClearance(); _syncLeftRailStack(); });
    _vjBannerRO.observe(document.getElementById('vjourney-banner'));
  }
  // The full routes list has nothing left to offer for the duration of a
  // journey — see #vjourney-activate-btn below for the one control from
  // its row (show/hide on the map) that's still relevant, now folded into
  // this banner directly — and it was reported as taking up too much
  // screen space sitting open on top of the map the whole time.
  _closeRoutePickerFn?.();
  _buildRoutePickerPanelFn?.();

  const msg = `Starting virtual journey: ${route.name}, ${speedKnots} knots.`;
  setStatus(msg); TTS.sayImmediate(msg);

  _vjRunning = true;
  _vjRunStartMs = Date.now();
  _vjRafId = setInterval(_vjStep, VJ_TICK_MS);
}

// A fixed-interval timer, not requestAnimationFrame — confirmed live that
// rAF is fully suspended by the browser once the tab is hidden/backgrounded
// (not just throttled), which would silently stall a journey the moment you
// switch apps or lock the screen. setInterval still fires (rate-clamped,
// typically to ~1/sec) in that state, so playback — and so bearing queries,
// anchor watch, etc. — keeps working for this specifically hands-off,
// rehearse-while-not-necessarily-watching use case. Elapsed time is real
// wall-clock (Date.now()), so a clamped/delayed tick still computes the
// correct position, just updates the display less often.
const VJ_TICK_MS = 200;

function _vjStep() {
  if (!_vjRunning) return;
  const elapsed = (Date.now() - _vjRunStartMs) / 1000;
  const nmPerRealSec = (_vjSpeedKnots / 3600) * _vjCompress;
  _vjTraveledNm = _vjBaselineNm + elapsed * nmPerRealSec;

  if (_vjTraveledNm >= _vjTotalNm) {
    const last = _vjRoute.points[_vjRoute.points.length - 1];
    const finalSeg = _vjSegs[_vjSegs.length - 1];
    GPS.setVirtualPosition(last.lat, last.lon, finalSeg?.brg ?? 0, _vjSpeedKnots);
    const msg = `Virtual journey complete: ${_vjRoute.name}.`;
    setStatus(msg); TTS.sayImmediate(msg);
    _stopVirtualJourney();
    return;
  }

  let seg = _vjSegs[_vjSegs.length - 1];
  for (const s of _vjSegs) {
    if (_vjTraveledNm >= s.cumDist && _vjTraveledNm < s.cumDist + s.dist) { seg = s; break; }
  }
  const frac = seg.dist > 0 ? (_vjTraveledNm - seg.cumDist) / seg.dist : 0;
  const lat = seg.lat1 + (seg.lat2 - seg.lat1) * frac;
  const lon = seg.lon1 + (seg.lon2 - seg.lon1) * frac;
  GPS.setVirtualPosition(lat, lon, seg.brg, _vjSpeedKnots);

  document.getElementById('vjourney-status').textContent =
    `Underway · ${_vjSpeedKnots} kts · ${_vjTraveledNm.toFixed(1)}/${_vjTotalNm.toFixed(1)} nm`;
}

function _pauseVirtualJourney() {
  if (!_vjRunning) return;
  _vjRunning = false;
  if (_vjRafId) { clearInterval(_vjRafId); _vjRafId = null; }
  document.getElementById('vjourney-pause-btn').textContent = '▶ Resume';
  document.getElementById('vjourney-status').textContent = `Paused · ${_vjTraveledNm.toFixed(1)}/${_vjTotalNm.toFixed(1)} nm`;
}

function _resumeVirtualJourney() {
  if (_vjRunning || !_vjRoute) return;
  _vjBaselineNm = _vjTraveledNm;
  _vjRunStartMs = Date.now();
  _vjRunning = true;
  document.getElementById('vjourney-pause-btn').textContent = '⏸ Pause';
  _vjRafId = setInterval(_vjStep, VJ_TICK_MS);
}

function _stopVirtualJourney() {
  _vjRunning = false;
  if (_vjRafId) { clearInterval(_vjRafId); _vjRafId = null; }
  if (!_vjRoute) return; // nothing was actually running — safe to call as a guard
  GPS.clearVirtualPosition();
  document.getElementById('vjourney-banner').style.display = 'none';
  _appEl.classList.remove('vjourney-active');
  _appEl.style.removeProperty('--vjourney-h');
  _vjRoute = null;
  _refreshSavedRouteLayers(); // reverts this route out of VJ-green/waypoints
  _vjSegs = [];
  _vjTotalNm = 0;
  _vjTraveledNm = 0;
  _vjBaselineNm = 0;
  // Same reset _finishTrackRecording does for the following/next-waypoint
  // state (Virtual Journey never touched _trackRecActive, so there's no
  // track to save here — just this bearing-tracking state to clear).
  _followingRouteId = null;
  _followingRouteName = null;
  _followingDestLat = null;
  _followingDestLon = null;
  _followingLegIdx = 1;
  _followFocusLegIdx = null;
  _followedHazardKnownKeys = new Set();
  if (_liveFollowHazardLayer) { _liveFollowHazardLayer.clearLayers(); _map.removeLayer(_liveFollowHazardLayer); _liveFollowHazardLayer = null; }
  _appEl.classList.remove('following-active');
  _exitRoutePanelCompactFn?.();
  if (_followProgressEl) _followProgressEl.style.display = 'none';
  _buildRoutePickerPanelFn?.();
  _setUnderwayMode(false);
  _syncLeftRailStack();
}

document.getElementById('vjourney-pause-btn').addEventListener('click', () => {
  if (_vjRunning) _pauseVirtualJourney(); else _resumeVirtualJourney();
});
document.getElementById('vjourney-stop-btn').addEventListener('click', _stopVirtualJourney);
document.getElementById('vjourney-close-btn').addEventListener('click', _stopVirtualJourney);

// Show/hide this route on the map — the one control from its row in the
// (now auto-closed, see _startVirtualJourney) routes list that's still
// relevant mid-journey; reuses the same pill styling/semantics as
// .rp-activate-btn there.
function _syncVjActivateBtn(route) {
  const btn = document.getElementById('vjourney-activate-btn');
  const hidden = _hiddenRouteNames.has(route.name);
  btn.classList.toggle('hidden', hidden);
  btn.textContent = hidden ? '✗ Hidden' : '✓ On map';
  btn.title = hidden ? 'Tap to show this route on the map' : 'Tap to hide this route from the map';
}
document.getElementById('vjourney-activate-btn').addEventListener('click', () => {
  if (!_vjRoute) return;
  if (_hiddenRouteNames.has(_vjRoute.name)) _hiddenRouteNames.delete(_vjRoute.name);
  else _hiddenRouteNames.add(_vjRoute.name);
  _saveHiddenRoutes();
  _refreshSavedRouteLayers();
  _syncVjActivateBtn(_vjRoute);
  _buildRoutePickerPanelFn?.();
});
document.getElementById('vjourney-banner').addEventListener('click', (e) => {
  const chip = e.target.closest('.vjourney-compress');
  if (!chip) return;
  document.querySelectorAll('.vjourney-compress').forEach(b => b.classList.remove('selected'));
  chip.classList.add('selected');
  _vjCompress = parseInt(chip.dataset.compress) || 1;
});
document.getElementById('vjourney-speed-input').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (!isNaN(v) && v > 0) _vjSpeedKnots = v;
});

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

  // Here, not in either caller — there are two ("Animate" in Node Ops via
  // _animateEditRoute, and "Animate" in the map's Track submenu via
  // track-route-go) and putting it in just one left the other with none of
  // this cleanup at all, which is what got reported. `route` is already a
  // plain object by the time either caller gets here, so clearing (which
  // exits edit mode as a side effect) can't wipe out data this function
  // still needs the way it would have earlier in either caller.
  _clearScreen();

  _animMode = true;
  _appEl.classList.add('anim-mode');
  _animBannerText.textContent = `⛵ ${route.name} · ${speedKnots} kts`;
  document.getElementById('anim-speed-input').value = speedKnots;
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

  // Overnight stops the boat should pause and flash at as it passes them —
  // per direct request. These markers are otherwise invisible during
  // Animate: _savedRoutesLayer (which is what MarkerIcons.routeOvernightIcon markers
  // live on) gets hidden a few lines up for a cleaner animated view, so
  // this flash is the only time one would ever be visible during
  // playback. Index 0 (the route's own start) is excluded — there's
  // nothing to "arrive at" a moment after the boat begins there.
  const ANIM_OVERNIGHT_PAUSE_MS = 1200;
  const overnightIdxs = [];
  for (let i = 1; i < route.points.length; i++) {
    if (route.points[i].overnight) overnightIdxs.push(i);
  }
  const ptCumNm = route.points.map((_, i) => i < segs.length ? segs[i].cumDist : totalNm);
  let _nextOvernightPtr = 0;

  const _initBearing = segs.length ? MarkerIcons.segBearing(segs[0].lat1, segs[0].lon1, segs[0].lat2, segs[0].lon2) : 0;
  if (!_map.getPane('animBoatPane')) _map.createPane('animBoatPane').style.zIndex = '750';
  _animMarker = L.marker(pts[0], { icon: MarkerIcons.animBoatIcon(_initBearing), pane: 'animBoatPane' }).addTo(_map);
  _animCurrentLat = pts[0][0];
  _animCurrentLon = pts[0][1];
  // Direct request: clicking the animated boat — typically once it's
  // arrived and sitting at the route's end — should bring up the same
  // marker menu every other marker in the app already has. Reuses the
  // exact navaid-popup-* classes/shared helpers (_bringBoatTo,
  // _openNearPointFlyout) rather than a one-off template. Live position,
  // not the route's fixed endpoint — works mid-animation too, not just
  // after arrival (nothing about a live marker's position makes "here"
  // ambiguous while it's still moving).
  _animMarker.bindPopup(
    `<div class="navaid-popup">
       <div class="navaid-popup-name">${escapeHtml(route.name)}</div>
       <button class="navaid-popup-focus">&#127919; Set focus</button>
       <button class="navaid-popup-bring-boat">&#9935; Bring boat here</button>
       <button class="navaid-popup-autoroute">&#9973; AutoRoute from boat position</button>
       <button class="navaid-popup-objects">Objects within &rsaquo;</button>
       <button class="navaid-popup-routes-near">Routes within &rsaquo;</button>
       <button class="navaid-popup-tracks-near">Tracks within &rsaquo;</button>
     </div>`,
    { maxWidth: 220, className: 'navaid-popup-wrapper' }
  );
  _animMarker.on('popupopen', (e) => {
    const popupEl = e.popup.getElement();
    const live = _animMarker.getLatLng();
    popupEl.querySelector('.navaid-popup-focus').addEventListener('click', () => {
      _map.closePopup();
      Query.setFocus(live.lat, live.lng, route.name, 'place');
      _updateFocusButton();
      const msg = `Focused on ${route.name}.`;
      showResponse(msg);
      TTS.sayImmediate(msg);
    });
    popupEl.querySelector('.navaid-popup-bring-boat').addEventListener('click', () => {
      _map.closePopup();
      _bringBoatTo(live.lat, live.lng, route.name);
    });
    popupEl.querySelector('.navaid-popup-autoroute').addEventListener('click', () => {
      _map.closePopup();
      _autoRouteFromBoatToHereFn?.(live.lat, live.lng);
    });
    popupEl.querySelector('.navaid-popup-objects').addEventListener('click', (ev) => {
      const rect = ev.currentTarget.getBoundingClientRect(); // before closePopup() detaches it
      _map.closePopup();
      _openNearPointFlyout(document.getElementById('map-ctx-objects-submenu'), rect, { lat: live.lat, lng: live.lng });
    });
    popupEl.querySelector('.navaid-popup-routes-near').addEventListener('click', (ev) => {
      const rect = ev.currentTarget.getBoundingClientRect();
      _map.closePopup();
      _openNearPointFlyout(document.getElementById('map-ctx-routes-near-submenu'), rect, { lat: live.lat, lng: live.lng });
    });
    popupEl.querySelector('.navaid-popup-tracks-near').addEventListener('click', (ev) => {
      const rect = ev.currentTarget.getBoundingClientRect();
      _map.closePopup();
      _openNearPointFlyout(document.getElementById('map-ctx-tracks-near-submenu'), rect, { lat: live.lat, lng: live.lng });
    });
  });

  // Fixed real-world playback length, regardless of route length or boat
  // speed: 10 seconds start to finish, every time — replaces the old
  // speed×compression pacing (the Speed chips no longer drive the actual
  // animation rate; speedKnots/sailTotalMin below are still real, just
  // for the realistic-sailing-time readout in the banner).
  const ANIMATE_TOTAL_SEC = 10;
  let nmPerRealSec = totalNm / ANIMATE_TOTAL_SEC;
  let sailTotalMin = Math.round(totalNm / speedKnots * 60); // actual sailing minutes

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
      const m = L.marker([n.lat, n.lon], { icon: MarkerIcons.navaidMarkerIcon(n) });
      _animReportLayer.addLayer(m);
      _highlightAndSpeak(m, null, null, null); // just flash, speech handled below
    }
    for (const h of (Query.lastHazardResults || [])) {
      const m = L.marker([h.lat, h.lon], { icon: MarkerIcons.hazardMarkerIcon() });
      _animReportLayer.addLayer(m);
      _highlightAndSpeak(m, null, null, null);
    }

    const speech = [navResult?.speech, hazResult?.speech].filter(Boolean).join('. ') || 'All clear.';
    TTS.sayImmediate(speech);
    _animBannerText.textContent = `⛵ Stopped · tap map to resume`;

    _map.once('click', () => {
      _animReportLayer.clearLayers();
      _animBannerText.textContent = `⛵ ${route.name} · ${speedKnots} kts`;
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
        GpxExport.downloadGpx(recordPoints, route.name);
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

    // Per explicit request: keep the boat on screen instead of letting it
    // sail out of the initial fitBounds view. Soft-follow, not locked-on —
    // only recenters once the boat gets within 15% of an edge, rather than
    // every frame, so the view still shows a sensible amount of the route
    // ahead/behind instead of pinning the boat dead center throughout.
    const _animPt = _map.latLngToContainerPoint([lat, lon]);
    const _animSize = _map.getSize();
    const _marginX = _animSize.x * 0.15, _marginY = _animSize.y * 0.15;
    if (_animPt.x < _marginX || _animPt.x > _animSize.x - _marginX ||
        _animPt.y < _marginY || _animPt.y > _animSize.y - _marginY) {
      _map.panTo([lat, lon], { animate: true, duration: 0.4, noMoveStart: true });
    }

    // Reached an overnight stop — snap exactly onto it, flash a bed-icon
    // marker, and pause briefly before resuming (same pause/resume shape
    // as the milestone-report branch below: return without scheduling the
    // next frame, then re-anchor startTime against _animTraveled to
    // resume cleanly).
    if (_nextOvernightPtr < overnightIdxs.length && traveled >= ptCumNm[overnightIdxs[_nextOvernightPtr]]) {
      const opt = route.points[overnightIdxs[_nextOvernightPtr]];
      _nextOvernightPtr++;
      _animMarker.setLatLng([opt.lat, opt.lon]);
      _animCurrentLat = opt.lat;
      _animCurrentLon = opt.lon;
      const flashMarker = L.marker([opt.lat, opt.lon], {
        icon: L.divIcon({ className: 'anim-overnight-flash', html: '&#128719;', iconSize: [26, 26], iconAnchor: [13, 13] }),
        zIndexOffset: 900,
      }).addTo(_map);
      const savedBanner = _animBannerText.textContent;
      _animBannerText.textContent = '🛏 Overnight stop';
      TTS.sayImmediate('Overnight stop.');
      setTimeout(() => {
        flashMarker.remove();
        if (!_animMode) return;
        _animBannerText.textContent = savedBanner;
        _animRafId = requestAnimationFrame((now2) => {
          startTime = now2 - (_animTraveled / nmPerRealSec * 1000);
          step(now2);
        });
      }, ANIM_OVERNIGHT_PAUSE_MS);
      return;
    }

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
            _animMilestoneLayer.addLayer(L.marker([fix.lat, fix.lon], { icon: MarkerIcons.navaidIcon(fix.type, c) }));
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

    const bearing = MarkerIcons.segBearing(seg.lat1, seg.lon1, seg.lat2, seg.lon2);
    const boatEl  = _animMarker.getElement()?.querySelector('.anim-boat');
    if (boatEl) boatEl.style.transform = MarkerIcons.boatIconTransform(bearing);

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
    const realSecLeft = Math.max(0, Math.round((totalNm - traveled) / nmPerRealSec));
    _animBannerText.textContent = `⛵ ${route.name} · ${speedKnots} kts · ${sailMinLeft}/${sailTotalMin} min (${realSecLeft}s)`;

    _animRafId = requestAnimationFrame(step);
  }
  // Lets #anim-speed-input change speed live without restarting — per
  // direct request, minimal friction: the default speed is fine most of
  // the time, so the widget only needs to let it be nudged when it isn't,
  // not force choosing one up front before every run. Playback pace itself
  // (nmPerRealSec) is fixed to the route's own ANIMATE_TOTAL_SEC budget now,
  // not to speedKnots, so changing it here only updates the realistic-
  // sailing-time readout — it can't speed up or slow down the animation.
  _setAnimSpeedFn = (newKt) => {
    if (!(newKt > 0)) return;
    speedKnots = newKt;
    sailTotalMin = Math.round(totalNm / speedKnots * 60);
    localStorage.setItem('audiochart-last-speed', speedKnots);
  };
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

// type: undefined for a plain manually-dropped waypoint, 'search' for one
// created via the Search box (see _runSearch) — only affects which icon
// _refreshWaypointLayer draws; storage/addressing (AutoRoute, findPlaceByName,
// drag-to-move) is identical either way. note: the resolved place name/label
// this pin's coordinates came from, shown as a subtitle in its popup menu —
// purely informational, never part of its addressable name.
function saveUserWaypoint(name, lat, lon, type, note) {
  const wps = WaypointsStorage.loadUserWaypoints();
  const entry = { name, lat, lon };
  if (type) entry.type = type;
  if (note) entry.note = note;
  wps.push(entry);
  localStorage.setItem(WaypointsStorage.USER_WP_KEY, JSON.stringify(wps));
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

// Island ownership "link-out" lookup. Two live point queries (not bbox —
// single point, tiny responses) against the same MEGIS FeatureServers Towns
// mode already uses: town/county/UT status, and (organized towns only —
// confirmed live that the state has NO owner-name field anywhere, and the
// Unorganized-Territory parcel layer's GRANTEE field is blank for all 36,661
// parcels statewide) a parcel id. Never throws — a failed/offline lookup
// degrades to nulls, which the caller renders as "couldn't look this up".
async function _lookupIslandJurisdiction(lat, lon) {
  const pt = `${lon},${lat}`;
  const townQuery = fetch(
    'https://services1.arcgis.com/RbMX0mRVOFNTdLzd/arcgis/rest/services/'
    + 'Maine_Town_and_Townships_Boundary_Polygons/FeatureServer/0/query'
    + `?where=1=1&outFields=TOWN,COUNTY,LURC&geometry=${pt}&geometryType=esriGeometryPoint`
    + '&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=false&f=json'
  ).then(r => r.json()).catch(() => null);
  const parcelQuery = fetch(
    'https://services1.arcgis.com/RbMX0mRVOFNTdLzd/arcgis/rest/services/'
    + 'Maine_Parcels_Organized_Towns/FeatureServer/10/query'
    + `?where=1=1&outFields=MAP_BK_LOT,PROP_LOC&geometry=${pt}&geometryType=esriGeometryPoint`
    + '&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=false&f=json'
  ).then(r => r.json()).catch(() => null);
  const [townResult, parcelResult] = await Promise.all([townQuery, parcelQuery]);
  const townAttrs = townResult?.features?.[0]?.attributes || null;
  const parcelAttrs = parcelResult?.features?.[0]?.attributes || null;
  if (!townAttrs && !parcelAttrs) return null; // both queries failed (offline etc.) — caller shows a connection error
  return {
    town: townAttrs?.TOWN || null,
    county: townAttrs?.COUNTY || null,
    isUT: townAttrs?.LURC === 'y',
    parcelId: parcelAttrs?.MAP_BK_LOT || null,
    propLoc: parcelAttrs?.PROP_LOC || null,
  };
}

// Builds the shared "look up this island's town/parcel + open Maine's own
// parcel map" HTML block, plus wires up a popupopen handler on `marker` that
// fills in the placeholder once the live lookup resolves. Appended to both
// the plain undocumented-island dots and the curated island-info popups —
// deliberately its own visually separate, clearly-online-only block (see
// _formatIslandInfo's own comment on why linking out was rejected there
// before: this is a live public-records check, not a substitute for the
// self-contained offline content, so it must never look like part of it).
let _islandLookupSeq = 0;
function _wireIslandLookup(marker, lat, lon) {
  const id = `island-lookup-${++_islandLookupSeq}`;
  marker.on('popupopen', async () => {
    const el = document.getElementById(id);
    if (!el || el.dataset.loaded) return;
    el.dataset.loaded = '1';
    const info = await _lookupIslandJurisdiction(lat, lon);
    const mapUrl = 'https://www.arcgis.com/apps/webappviewer/index.html'
      + `?id=28e35c8fcf514d2685357b78bdd0b246&center=${lon},${lat}&level=18`;
    if (!info) {
      el.innerHTML = `Couldn't look this up — needs a connection. `
        + `<a href="${mapUrl}" target="_blank" rel="noopener">Try Maine's parcel map</a>`;
      return;
    }
    const jurisdiction = info.town
      ? `${info.town}${info.county ? `, ${info.county} County` : ''}${info.isUT ? ' — includes Unorganized Territory' : ''}`
      : (info.isUT ? 'Unorganized Territory' : 'Town not found');
    // Explicit, not silently omitted: this layer is built from voluntary
    // per-town submissions to the state (confirmed live — some towns haven't
    // submitted, others only partially, small islets are exactly the kind of
    // parcel likely missing even where a town otherwise participates), so "no
    // parcel found here" reads as "the state doesn't have this on file" only
    // — never as "no owner" or "not a real parcel". The town's own assessor
    // can have a complete record this layer simply lacks.
    const parcel = info.parcelId
      ? ` &middot; Parcel ${info.parcelId}${info.propLoc ? ` (${info.propLoc})` : ''}`
      : (info.town ? ' &middot; No parcel on file in the state database (coverage varies by town — the town assessor may still have one)' : '');
    el.innerHTML = `${jurisdiction}${parcel}<br>`
      + `<a href="${mapUrl}" target="_blank" rel="noopener">&#128269; Open in Maine's parcel map</a>`;
  });
  return `<div id="${id}" style="margin-top:6px;padding-top:6px;border-top:1px solid #ddd;font-size:0.8em;color:#888">Looking up town&hellip; (needs a connection)</div>`;
}

function _clearMaineTownsLayer() {
  if (_maineTownsMoveEnd) { _map.off('moveend', _maineTownsMoveEnd); _maineTownsMoveEnd = null; }
  if (_maineTownsLayer) { _map.removeLayer(_maineTownsLayer); _maineTownsLayer = null; }
}

// Same live-FeatureServer-by-viewport-bbox pattern as _refreshMaineGeologyLayer,
// same ArcGIS org even (MEGIS) — "Maine Town and Townships Boundary Polygons",
// the state's own 1:24,000 political boundary layer. Confirmed live against ten
// of this region's own island coordinates before building this: every one
// resolved to a real TOWN, including the Unorganized-Territory ones (LURC='y'
// — Maine's Land Use Planning Commission, née LURC, has jurisdiction over
// Unorganized Territory specifically, so it's the field that actually answers
// "does this fall under a town or the state"). That org/UT split is exactly
// what determines which office an ownership lookup goes to next: a town
// assessor for an organized town, Maine Revenue Services for UT — the reason
// this mode exists in the first place.
//
// Two separate queries, not one: the source layer isn't dissolved by town, so
// querying it directly for geometry returned 1171 features / ~5MB for one
// Penobscot Bay viewport (every little UT island is its own polygon feature —
// confirmed live before settling on this). MEGIS also publishes a
// TOWN-dissolved version of the same data (one [Multi]Polygon per town) but it
// dropped COUNTY/LURC entirely — so geometry comes from the dissolved layer
// (21 features / ~450KB for that same viewport) and COUNTY/LURC come from a
// second, geometry-free distinct-attributes query against the original layer
// (25 rows / ~2KB), joined client-side by TOWN name. A town can straddle both
// — e.g. "Criehaven Twp" came back with both LURC='n' and LURC='y' rows in
// live testing — so the tooltip flags UT as "includes", not "is".
async function _refreshMaineTownsLayer() {
  if (_mapViewMode !== 'towns-maine' || !_map) return;
  const b = _map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const token = ++_maineTownsFetchToken;
  let geojson, attrRows;
  try {
    const geomUrl = 'https://services1.arcgis.com/RbMX0mRVOFNTdLzd/arcgis/rest/services/'
      + 'Maine_Town_and_Townships_Boundary_Polygons_Dissolved/FeatureServer/0/query'
      + '?where=1=1&outFields=TOWN'
      + `&geometry=${bbox}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`
      + '&f=geojson';
    const attrUrl = 'https://services1.arcgis.com/RbMX0mRVOFNTdLzd/arcgis/rest/services/'
      + 'Maine_Town_and_Townships_Boundary_Polygons/FeatureServer/0/query'
      + '?where=1=1&outFields=TOWN,COUNTY,LURC&returnDistinctValues=true&returnGeometry=false'
      + `&geometry=${bbox}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`
      + '&f=json';
    [geojson, attrRows] = await Promise.all([
      fetch(geomUrl).then(r => r.json()),
      fetch(attrUrl).then(r => r.json()).then(d => d.features || []),
    ]);
  } catch (e) {
    console.error('[towns-maine] fetch failed', e);
    return;
  }
  if (token !== _maineTownsFetchToken || _mapViewMode !== 'towns-maine') return;  // stale response or mode changed mid-fetch
  const byTown = new Map();
  for (const r of attrRows) {
    const a = r.attributes;
    const cur = byTown.get(a.TOWN) || { county: a.COUNTY, ut: false };
    if (a.LURC === 'y') cur.ut = true;
    byTown.set(a.TOWN, cur);
  }
  if (_maineTownsLayer) _map.removeLayer(_maineTownsLayer);
  _maineTownsLayer = L.geoJSON(geojson, {
    // Reuses the geology hash-palette — it takes any string, and the same
    // "stable but visually arbitrary, real identity comes from the tooltip"
    // reasoning applies here: ~15-20 distinct towns/UT units in this bay,
    // colored just for at-a-glance boundary contrast, not for the hue to mean
    // anything on its own.
    style: (f) => ({
      color: '#222', weight: 1.5,
      fillColor: _geologyColorFor(f.properties.TOWN || ''), fillOpacity: 0.18,
    }),
    onEachFeature: (f, layer) => {
      const town = f.properties.TOWN || 'Unnamed';
      const info = byTown.get(town);
      const county = info?.county ? `, ${info.county} County` : '';
      const ut = info?.ut ? ' — includes Unorganized Territory (state LUPC jurisdiction)' : '';
      layer.bindTooltip(`${town}${county}${ut}`, { sticky: true });
    },
  }).addTo(_map);
}

function _enableMaineTownsLayer() {
  _refreshMaineTownsLayer();
  _maineTownsMoveEnd = () => _refreshMaineTownsLayer();
  _map.on('moveend', _maineTownsMoveEnd);
}

function _applyMapLayer() {
  if (!_map) return;
  if (_baseTileLayer) { _map.removeLayer(_baseTileLayer); _baseTileLayer = null; }
  _clearMaineGeologyLayer();
  _clearMaineTownsLayer();

  if (_mapViewMode === 'satellite') {
    _baseTileLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { minZoom: 4, maxZoom: 18, maxNativeZoom: 17, attribution: '© Esri' }
    ).addTo(_map);
  } else {
    // 'chart', 'geology-maine', 'towns-maine', 'history', 'demographics',
    // 'island-info', 'anchorages', and 'paintings' all use the street
    // basemap: all but 'geology-maine' and 'towns-maine' use it on their
    // own (their markers need real coastline/place-name context and have
    // no map layer of their own); those two use it as context underneath
    // their own polygon overlay (added below) — neither dataset has
    // coastline/place-name context of its own.
    _baseTileLayer = L.tileLayer(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      // maxZoom stays 18 to match the zoom slider; maxNativeZoom caps actual tile
      // *requests* at 17 (the provider's real resolution) and lets Leaflet upscale
      // that last tile for zoom 18 instead of leaving a blank screen past 17.
      { minZoom: 4, maxZoom: 18, maxNativeZoom: 17, attribution: '© OpenStreetMap contributors' }
    ).addTo(_map);
  }

  if (_mapViewMode === 'geology-maine') _enableMaineGeologyLayer();
  if (_mapViewMode === 'towns-maine') _enableMaineTownsLayer();
  _renderDocumentMarkers();
  _renderAllIslandLabels();
  _renderPassageLabels();
  document.getElementById('history-era-banner').style.display = _mapViewMode === 'history' ? 'flex' : 'none';
  document.getElementById('paintings-list-btn').style.display = _mapViewMode === 'paintings' ? '' : 'none';
  _syncMapModeTitle();
}

const MAP_VIEW_ICONS  = { chart: '🗺', satellite: '🛰', 'geology-maine': '⛰', 'towns-maine': '🏛', history: '📜', demographics: '👥', 'island-info': '🏝', anchorages: '⚓', paintings: '🎨' };
const MAP_VIEW_LABELS = { chart: 'Chart', satellite: 'Satellite', 'geology-maine': 'Geology', 'towns-maine': 'Towns', history: 'History', demographics: 'Demographics', 'island-info': 'Island Info', anchorages: 'Anchorages', paintings: 'Paintings' };
// One-line, real descriptions of what each mode actually shows — used by
// the route movie's closing "other map types" table (v661), not shown
// anywhere else. Keep in sync with MAP_VIEW_MODES/MAP_VIEW_LABELS above.
const MAP_VIEW_DESCRIPTIONS = {
  chart: 'Standard nautical chart — depths, buoys, hazards',
  satellite: 'Real aerial imagery of the coastline',
  'geology-maine': 'Live Maine bedrock and surficial geology data',
  'towns-maine': 'Maine town boundaries and names',
  history: 'Real historical write-ups tied to actual places',
  demographics: 'Town population, age, and seasonal notes',
  'island-info': 'Who owns an island, and whether you can land',
  anchorages: 'Curated moorings and anchorages, with real details',
  paintings: 'Iconic historic paintings, at the real spot each one depicts',
};
const HISTORY_ERA_LABELS = {
  all: 'All Eras',
  colonial: 'Native American & Colonial',
  revolution: 'Revolution & Early Republic',
  industrial: '19th-Century Industry & Maritime',
  modern: '20th Century to Present',
};

// ── Status title bar (mode + GPS + coverage) ────────────────────────────────
// All three used to be separate always-visible elements (then briefly one
// cryptic in-row badge, which read as a pushable button it wasn't) — now one
// wide, short, title-styled strip above the button row. Full readable words,
// not glyph codes: a title bar has the width to spare, the constraint here
// is HEIGHT, not width. Each of the three producers (mode switch, every GPS
// fix, coverage-level changes) only owns its own piece of the combined state
// and calls _renderStatusCombo() to redraw — mirrored into #wco-titlebar too,
// for when an installed desktop app has a real native title-bar strip to use
// instead (see _syncWindowControlsOverlay).
let _statusModeGlyph    = '🗺';
let _statusModeLabel    = 'Chart';
let _statusGpsLabel     = 'GPS: waiting';
let _statusGpsCls       = '';
// Direct request (2026-09-27): show which chart region is actually active
// right next to the GPS label — set by _autoSelectRegionForPosition,
// never left to go stale, since the active region silently governs which
// hazard/channel/land data AutoRoute actually uses (see the SP003
// investigation this same day).
let _statusRegionLabel  = '';
let _statusCoverageLabel = '';
let _statusCoverageCls   = '';

function _renderStatusCombo() {
  const text = [`${_statusModeGlyph} ${_statusModeLabel}`, _statusGpsLabel, _statusRegionLabel, _statusCoverageLabel]
    .filter(Boolean).join('  ·  ');
  const cls = _statusCoverageCls || _statusGpsCls;
  if (statusComboEl) {
    statusComboEl.textContent = text;
    statusComboEl.title = text;
    statusComboEl.className = cls;
  }
  if (wcoTitlebarEl) {
    wcoTitlebarEl.textContent = text;
    wcoTitlebarEl.title = text;
  }
}

function _syncMapModeTitle() {
  _statusModeGlyph = MAP_VIEW_ICONS[_mapViewMode] || '🗺';
  _statusModeLabel = _mapViewMode === 'history'
    ? `History — ${HISTORY_ERA_LABELS[_selectedEra]}`
    : MAP_VIEW_LABELS[_mapViewMode];
  _renderStatusCombo();
}

document.querySelectorAll('.history-era-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.history-era-chip').forEach(c => c.classList.remove('selected'));
    chip.classList.add('selected');
    _selectedEra = chip.dataset.era;
    _renderDocumentMarkers();
    _syncMapModeTitle();
  });
});

// Was a single icon button that cycled through MAP_VIEW_MODES one tap at a
// time; per explicit request, now a pulldown showing every mode at once
// (picking a mode you're not adjacent to used to take several taps).
//
// Deliberately resets to the hidden "Map Type" placeholder option instead of
// showing the mode just picked — a plain <select> always displays its
// current selection in the closed state, so this tile would otherwise just
// read "History" or "Demographics" sitting there with no indication of what
// it even is. The status-title-bar strip already shows the active mode
// (e.g. "🗺 Chart · GPS: ...") elsewhere, so nothing is lost by not also
// duplicating it here.
function _syncLayerBtn() {
  const sel = document.getElementById('map-layer-select');
  if (!sel) return;
  sel.value = '';
}

function _ensureMap() {
  if (_map) return;
  // zoomAnimation was briefly forced off app-wide to work around a
  // duplicate/ghosted-tile bug specific to Low-Tide Aerial's slow,
  // dynamically-rendered tiles (Leaflet keeps old zoom-level tiles visible,
  // CSS-scaled, until every new tile loads — fine for fast pre-tiled
  // layers, but long enough to be visible with a ~0.5s/tile ImageServer).
  // That layer's been removed entirely, so the every-other-layer-is-fast
  // assumption holds again — smooth zoom animation restored.
  _map = L.map('leaflet-map', { zoomControl: false, attributionControl: true });
  _map.setView([44.1018, -69.0752], 11);  // Rockland Harbor — default until GPS arrives
  _applyMapLayer();
  _syncLayerBtn();
  _loadHiddenRoutes();
  _loadHiddenTracks();
  _refreshSavedRouteLayers();
  _refreshSavedTrackLayers();
  _renderDocumentMarkers();  // no-op if the documents.geojson fetch hasn't resolved yet — it'll self-render then
  _renderAllIslandLabels();  // no-op if not in island-info mode, or if Query.namedPlaces hasn't loaded yet
  _renderPassageLabels();    // no-op if Query.namedPlaces hasn't loaded yet

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
        ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${major ? 'var(--brass-hi)' : 'var(--brass-dim)'}" stroke-width="${major ? 1.2 : 0.7}"/>`;
      }
      const cardinals = new Set([0, 90, 180, 270]);
      let nums = '';
      for (let d = 0; d < 360; d += 30) {
        if (cardinals.has(d)) continue;
        const [x, y] = pt(55, d);
        nums += `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" fill="var(--parchment-dim)" font-family="var(--font-brass-mono)" font-size="7.5">${d}</text>`;
      }
      // magneticVariation is negative for westerly (e.g. -15 in Penobscot Bay).
      // rotate(variation) tilts N left toward magnetic north.
      const magRot = magneticVariation;
      // Chart & Brass palette (see :root in app.css) — engraved-ink dial,
      // brass rings/ticks, parchment cardinal letters in the app's serif
      // token. The 8-point rose itself (bold N/S/E/W + dim diagonals) is
      // kept as-is rather than swapped for the mockup's simpler single
      // arrow — it's a real, more functional design already; only its
      // colors and type change here.
      el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="70" height="70" viewBox="-70 -70 140 140">
        <circle r="68" fill="var(--brass-ink-2)" stroke="var(--brass)" stroke-width="1.5"/>
        <g transform="rotate(${magRot})">
          ${ticks}
          ${nums}
          <polygon points="0,0 -7,-14 0,-40 7,-14" fill="var(--brass-needle)"/>
          <polygon points="0,0 -7,14 0,40 7,14" fill="var(--parchment)"/>
          <polygon points="0,0 14,-7 40,0 14,7" fill="var(--parchment)"/>
          <polygon points="0,0 -14,-7 -40,0 -14,7" fill="var(--parchment)"/>
          <polygon points="0,0 -3,-8 17,-17 8,-3" fill="var(--brass-dim)"/>
          <polygon points="0,0 8,3 17,17 3,8" fill="var(--brass-dim)"/>
          <polygon points="0,0 3,8 -17,17 -8,3" fill="var(--brass-dim)"/>
          <polygon points="0,0 -8,-3 -17,-17 -3,-8" fill="var(--brass-dim)"/>
          <text x="0" y="-47" text-anchor="middle" dominant-baseline="middle" fill="var(--brass-needle)" font-family="var(--font-brass-serif)" font-size="12" font-weight="700">N</text>
          <text x="0" y="50" text-anchor="middle" dominant-baseline="middle" fill="var(--parchment)" font-family="var(--font-brass-serif)" font-size="11" font-weight="600">S</text>
          <text x="50" y="0" text-anchor="middle" dominant-baseline="middle" fill="var(--parchment)" font-family="var(--font-brass-serif)" font-size="11" font-weight="600">E</text>
          <text x="-50" y="0" text-anchor="middle" dominant-baseline="middle" fill="var(--parchment)" font-family="var(--font-brass-serif)" font-size="11" font-weight="600">W</text>
          <circle r="5" fill="var(--brass)" stroke="var(--brass-ink)" stroke-width="2"/>
        </g>
      </svg>
      <button id="zoom-to-me-btn" type="button" title="Zoom to my location" aria-label="Zoom to me">&#8857;</button>`;
      // ⊙ Zoom to me lives on the compass (2026-10-07; was in the removed
      // right-hand panel): the compass is the one instrument shown in every
      // mode, Underway included. Handler is wired below with the other
      // map-init listeners.
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
        <button class="tide-shrink-btn" type="button" title="Shrink the tide widget"></button>
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
      // Shrink to a small "TIDE ▾" tab — direct request 2026-10-04, same
      // idea as the other windows' shrink buttons. Remembered across reloads.
      const shrinkBtn = el.querySelector('.tide-shrink-btn');
      const setCollapsed = (collapsed) => {
        el.classList.toggle('tide-collapsed', collapsed);
        shrinkBtn.textContent = collapsed ? 'Tide \u25BE' : '\u25B4';
        shrinkBtn.title = collapsed ? 'Expand the tide widget' : 'Shrink the tide widget';
        try { localStorage.setItem('audiochart-tide-collapsed', collapsed ? '1' : ''); } catch {}
      };
      shrinkBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setCollapsed(!el.classList.contains('tide-collapsed'));
      });
      let storedTide = null;
      try { storedTide = localStorage.getItem('audiochart-tide-collapsed'); } catch {}
      setCollapsed(storedTide === '1');
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

  // "Zoned" layout: tide and heading/speed move out of Leaflet's own
  // topright control corner into #bottom-hud, the one consolidated HUD
  // row alongside #focus-btn (already placed there in index.html) —
  // safe to just re-parent them since both are position:fixed (see
  // app.css) and already fully escaped Leaflet's control-container
  // layout; nothing about their own construction/behavior changes.
  document.getElementById('bottom-hud').append(_tideCycleEl, _headingSpeedEl);

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

  // Popups are supposed to "rise to the top of the stack, unimpeded" (see
  // the .leaflet-popup-pane z-index override in app.css) — but that only
  // ever covers other MAP content (tiles, hazard markers, land polygons).
  // It can't win against Leaflet's own floating controls (compass rose,
  // tide cycle, heading/speed, follow-progress — a structurally separate
  // always-on-top layer from .leaflet-map-pane, where popups live) OR
  // against this app's own overlay chrome (top button row, mode title,
  // Global Ops title, status bar, panels — all direct children of
  // #map-container, one sibling level further out than #leaflet-map
  // itself). Both were confirmed live via getComputedStyle / a DOM
  // parentElement walk rather than guessed at — no z-index on the popup
  // pane can escape either sibling boundary, so this toggles a class on
  // #map-container instead (the nearest common ancestor of both
  // categories) and fades them out via CSS while any popup is open. See
  // the #map-container.popup-open rules in app.css for the full
  // reasoning and what's deliberately excluded.
  _map.on('popupopen', () => {
    document.getElementById('map-container')?.classList.add('popup-open');
  });
  _map.on('popupclose', () => {
    document.getElementById('map-container')?.classList.remove('popup-open');
  });

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
  // Independent of the tide-cycle fetch above — _effectiveTideHeight()
  // interpolates live from whatever _tideExtremes is already cached, so
  // this only needs real time to have passed, not a fresh fetch to have
  // just completed. See _recheckFollowedRouteHazardsLive's own comment.
  setInterval(_recheckFollowedRouteHazardsLive, 60 * 1000);

  document.getElementById('map-layer-select').addEventListener('change', (e) => {
    _mapViewMode = e.target.value;
    localStorage.setItem('audiochart-chart-mode', _mapViewMode);
    _applyMapLayer();
    _syncLayerBtn();
    _maybeShowModeIntro(_mapViewMode);
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

  // ⚓ Objects panel — direct request: always on screen (no more open/
  // closed via a separate button, #navaid-filter-btn removed), collapsible
  // to just its own title in place instead. Same collapse/expand mechanism
  // as Node Ops' #etp-title/#edit-tools-body (see that comment), persisted
  // across reloads the same way #right-rail's own collapsed state is —
  // default collapsed on first-ever load (it's now a permanent fixture,
  // so starting out of the way matters more than starting open), remember
  // whatever the user leaves it at after that.
  const _navaidFilterPanel = document.getElementById('navaid-filter-panel');
  const _navaidFilterTitle = document.getElementById('nf-panel-title');
  const _setNavaidPanelCollapsed = (collapsed) => {
    _navaidFilterPanel.classList.toggle('collapsed', collapsed);
    _navaidFilterTitle.classList.toggle('collapsed', collapsed);
    localStorage.setItem('audiochart-navaid-panel-collapsed', collapsed ? '1' : '');
  };
  const _storedNavaidCollapsed = localStorage.getItem('audiochart-navaid-panel-collapsed');
  _setNavaidPanelCollapsed(_storedNavaidCollapsed === null ? true : _storedNavaidCollapsed === '1');
  _navaidFilterTitle.addEventListener('click', () => {
    _setNavaidPanelCollapsed(!_navaidFilterPanel.classList.contains('collapsed'));
  });
  _makeDraggable(_navaidFilterPanel, _navaidFilterTitle);
  document.getElementById('nf-refresh').addEventListener('click', () => {
    _refreshNavaidOverlay();
  });

  // Waypoints / Test Sets panels — promoted from nested right-click
  // context-menu submenus to standalone top-row panels, per direct
  // request. Same open/close/drag/swipe pattern as every other panel
  // here; their button-click HANDLING (Show/Hide/Export/etc.) is
  // unchanged — see _wpSubmenu/_testSetsSubmenu's own listeners below,
  // which still work identically since they're bound to the same
  // elements regardless of where those elements live in the DOM.
  const _waypointsPanelBtn   = document.getElementById('waypoints-panel-btn');
  const _waypointsPanel      = document.getElementById('waypoints-panel');
  const _closeWaypointsPanel = () => {
    _waypointsPanel.classList.remove('open');
    _waypointsPanelBtn.classList.remove('active');
  };
  _addSwipeToClose(_waypointsPanel, _closeWaypointsPanel, 'x', '.nf-title');
  _makeDraggable(_waypointsPanel, _waypointsPanel.querySelector('.nf-title'));
  _makeCollapsible(_waypointsPanel);
  _waypointsPanelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _waypointsPanel.classList.toggle('open');
    _waypointsPanelBtn.classList.toggle('active', _waypointsPanel.classList.contains('open'));
    // Dynamic per-waypoint rows only ever got (re)built on right-click
    // before (removed above) — rebuild here so a waypoint saved/deleted
    // elsewhere shows up without a full reload.
    if (_waypointsPanel.classList.contains('open')) _populateWpSubmenu();
  });
  document.getElementById('waypoints-panel-close').addEventListener('click', _closeWaypointsPanel);
  _map.on('click', _closeWaypointsPanel);

  const _testSetsPanelBtn   = document.getElementById('testsets-panel-btn');
  const _testSetsPanel      = document.getElementById('testsets-panel');
  const _closeTestSetsPanel = () => {
    _testSetsPanel.classList.remove('open');
    _testSetsPanelBtn.classList.remove('active');
  };
  _addSwipeToClose(_testSetsPanel, _closeTestSetsPanel, 'x', '.nf-title');
  _makeDraggable(_testSetsPanel, _testSetsPanel.querySelector('.nf-title'));
  _makeCollapsible(_testSetsPanel);
  _testSetsPanelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _testSetsPanel.classList.toggle('open');
    _testSetsPanelBtn.classList.toggle('active', _testSetsPanel.classList.contains('open'));
    // Dynamic per-Test-Set rows only ever got (re)built when the OLD
    // submenu's parent toggle fired (removed above) — rebuild here so a
    // Test Set created/deleted elsewhere shows up without a full reload.
    if (_testSetsPanel.classList.contains('open')) _populateTestSetsSubmenu();
  });
  document.getElementById('testsets-panel-close').addEventListener('click', _closeTestSetsPanel);
  _map.on('click', _closeTestSetsPanel);
  document.getElementById('nf-clear').addEventListener('click', () => {
    if (_navaidFilterLayer) { _map?.removeLayer(_navaidFilterLayer); _navaidFilterLayer = null; }
    if (_depthHeatLayer)    { _map?.removeLayer(_depthHeatLayer);    _depthHeatLayer = null; }
    if (_mudflatLayer)      { _map?.removeLayer(_mudflatLayer);      _mudflatLayer   = null; }
    if (_currentArrowLayer) { _map?.removeLayer(_currentArrowLayer); _currentArrowLayer = null; }
  });

  // ⓘ About panel — tap either version label to see features + coverage areas
  const _aboutPanel = document.getElementById('about-panel');
  const _closeAbout = () => _aboutPanel.classList.remove('open');
  _addSwipeToClose(_aboutPanel, _closeAbout, 'x', '.nf-title');
  _makeDraggable(_aboutPanel, _aboutPanel.querySelector('.nf-title'));
  _makeCollapsible(_aboutPanel);
  document.getElementById('about-close').addEventListener('click', _closeAbout);
  _map.on('click', _closeAbout);
  function _showAboutPanel() {
    document.getElementById('about-version').textContent = `AudioChart ${VERSION}`;
    document.getElementById('about-features').innerHTML =
      ABOUT_FEATURES.map(f => `<li>${f}</li>`).join('');
    document.getElementById('about-regions').innerHTML =
      Object.keys(_visibleCruiseProfiles()).map(name => `<li>${name}</li>`).join('');
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

  // 📋 Paintings table — quick reference for Paintings mode: every entry
  // at a glance with a direct link to its bundled image. Button itself is
  // shown/hidden per-mode in _applyMapLayer, same convention as
  // #history-era-banner. Backdrop click dismisses it (matches every other
  // modal here), but a click on the panel itself is stopped from bubbling
  // first — unlike #coverage-alert-panel, this one holds real links that
  // need a normal click, not "anywhere dismisses."
  const _paintingsTableBtn     = document.getElementById('paintings-list-btn');
  const _paintingsTableOverlay = document.getElementById('paintings-table-overlay');
  const _paintingsTablePanel   = document.getElementById('paintings-table-panel');
  const _closePaintingsTable   = () => _paintingsTableOverlay.classList.remove('open');
  _paintingsTablePanel.addEventListener('click', (e) => e.stopPropagation());
  _paintingsTableOverlay.addEventListener('click', _closePaintingsTable);
  document.getElementById('paintings-table-close').addEventListener('click', _closePaintingsTable);
  _paintingsTableBtn.addEventListener('click', () => {
    const rows = _documents
      .filter(f => f.properties.category === 'paintings')
      .map(f => f.properties)
      .sort((a, b) => a.title.localeCompare(b.title));
    document.getElementById('paintings-table-body').innerHTML = rows.map(p => `
      <tr>
        <td>${escapeHtml(p.title)}</td>
        <td>${escapeHtml(p.painting?.artist || '')}</td>
        <td>${escapeHtml(p.painting?.year || '')}</td>
        <td>${p.painting?.imageAsset
          ? `<a href="${p.painting.imageAsset}" target="_blank" rel="noopener"><img class="paintings-table-thumb" src="${p.painting.imageAsset}" alt="${escapeHtml(p.title)}" loading="lazy"></a>`
          : '—'}</td>
      </tr>`).join('');
    _paintingsTableOverlay.classList.add('open');
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
  _makeCollapsible(_routePickerPanel);

  // ★ Sample Routes panel — standalone, not nested inside Routes, so the
  // user can leave it open across an entire movie and on into the next
  // one. Deliberately no _map.on('click', ...) auto-close like every
  // other panel here — closes only via its own ✕ or a swipe, both
  // explicit user actions (see the "leave it up until I close it" v650
  // fix comment on _playRouteMovie below for the bug this replaced).
  const _sampleRoutesPanel = document.getElementById('sample-routes-panel');
  const _sampleRoutesBtn   = document.getElementById('sample-routes-btn');
  const _closeSampleRoutesPanel = () => {
    _sampleRoutesPanel.classList.remove('open');
    _sampleRoutesBtn.classList.remove('active');
  };
  _addSwipeToClose(_sampleRoutesPanel, _closeSampleRoutesPanel, 'x', '.nf-title');
  _makeDraggable(_sampleRoutesPanel, _sampleRoutesPanel.querySelector('.nf-title'));
  _makeCollapsible(_sampleRoutesPanel);
  document.getElementById('sr-close').addEventListener('click', _closeSampleRoutesPanel);

  // Compact mode: while Follow/Virtual Journey is active, the full route
  // list (sized to span nearly the whole viewport height, see
  // #route-picker-panel's own CSS comment) has nothing left to offer over
  // that one route's own Stop control, and it blocks the Underway switch
  // (top-right) the whole time it's open. Lets the user shrink it down to
  // just that row on request rather than forcing it — they may still want
  // the full list open to glance at other routes while one's underway.
  let _routePanelCompact = false;
  const _compactToggleBtn = document.getElementById('rp-compact-toggle');
  function _setRoutePanelCompact(on) {
    _routePanelCompact = on;
    _routePickerPanel.classList.toggle('compact', on);
    _compactToggleBtn.classList.toggle('active', on);
    _compactToggleBtn.textContent = on ? '⤢ Show full list' : '⤡ Focus active route';
    _buildRoutePickerPanel();
  }
  _compactToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _setRoutePanelCompact(!_routePanelCompact);
  });

  // Sort comparators for the Routes panel's #rp-sort control — 'newest' matches
  // the sort this list always used before bulk-select existed.
  const _ROUTE_SORT_COMPARATORS = {
    newest: (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0),
    oldest: (a, b) => (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0),
    name:   (a, b) => a.name.localeCompare(b.name),
  };

  function _updateBulkBar(shownCount) {
    const bar = document.getElementById('rp-bulk-bar');
    bar.style.display = _routeSelectMode ? 'flex' : 'none';
    if (!_routeSelectMode) return;
    const n = _selectedRouteIds.size;
    document.getElementById('rp-bulk-select-all').textContent = `Select all shown (${shownCount})`;
    document.getElementById('rp-bulk-hide').textContent = `Hide selected (${n})`;
    document.getElementById('rp-bulk-delete').textContent = `Delete selected (${n})`;
    document.getElementById('rp-bulk-hide').disabled = n === 0;
    document.getElementById('rp-bulk-delete').disabled = n === 0;
  }

  function _buildRoutePickerPanel() {
    DriveSync.maybeAutoSync();
    const list  = document.getElementById('rp-route-list');
    const query = document.getElementById('rp-search').value || '';
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    list.innerHTML = '';
    let filtered = routes.filter(r => _itemMatchesSearch(r, query))
      .sort(_ROUTE_SORT_COMPARATORS[_routeSortMode] || _ROUTE_SORT_COMPARATORS.newest);
    if (_routePanelCompact) {
      filtered = filtered.filter(r => r.id === _followingRouteId || r.id === _vjRoute?.id);
    }
    _updateBulkBar(filtered.length);
    // A brand-new user's very first look at this panel was just a bare "No
    // saved routes." message, with the real sample-route library hidden a
    // click away behind the "★ Sample Routes" button above — easy to miss
    // entirely, worst for exactly the audience (new users) who'd benefit
    // most. Auto-expand the same sample list right here instead of making
    // them find and click that button first.
    //
    // Deliberately a one-way nudge, not a toggle this function owns: this
    // runs on every rebuild (search keystroke, sort change, follow/stop,
    // any external route-list update — see the many other call sites of
    // _buildRoutePickerPanel), not just when the user touches the sample
    // list. An earlier version also force-closed it whenever routes.length
    // > 0, which meant clicking "★ Sample Routes" open, then doing
    // anything else in the panel, silently closed it again — the "★ Sample
    // Routes" button's own click handler is the only thing that should
    // ever close it once routes exist; the list is meant to always be
    // reliably available there, exactly as many times as the user presses
    // that button, regardless of how many routes they already have.
    if (routes.length === 0) {
      _sampleRoutesPanel.classList.add('open');
      _sampleRoutesBtn.classList.add('active');
      _renderSampleRouteList(document.getElementById('rp-sample-list'), { withHeading: true });
    }
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rp-empty';
      empty.textContent = routes.length === 0 ? 'No saved routes yet.' : 'No routes match.';
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
      const selected = _selectedRouteIds.has(route.id);
      const row = document.createElement('button');
      row.className = 'rp-row' + (hidden ? ' hidden' : '') + (expanded ? ' expanded' : '') + (selected ? ' selected' : '');
      const nameLine = document.createElement('div');
      nameLine.className = 'rp-row-name';
      if (_routeSelectMode) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'rp-row-checkbox';
        checkbox.checked = selected;
        checkbox.addEventListener('click', (e) => e.stopPropagation());
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) _selectedRouteIds.add(route.id);
          else _selectedRouteIds.delete(route.id);
          _buildRoutePickerPanel();
        });
        nameLine.appendChild(checkbox);
      }
      // A dedicated button, not just a colored label — this is the "activate"
      // control (show/hide this route on the map) and it needs to look and
      // behave like one on its own, separate from tapping the rest of the
      // row (which only expands/collapses the details below). Previously a
      // plain-text ::before mark with no click handler of its own — the
      // whole row doubled as both "activate" AND "expand," a single tap
      // meaning two unrelated things at once.
      const activateBtn = document.createElement('button');
      activateBtn.type = 'button';
      activateBtn.className = 'rp-activate-btn' + (hidden ? ' hidden' : '');
      activateBtn.textContent = hidden ? '✗ Hidden' : '✓ On map';
      activateBtn.title = hidden ? 'Tap to show this route on the map' : 'Tap to hide this route from the map';
      activateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_hiddenRouteNames.has(route.name)) _hiddenRouteNames.delete(route.name);
        else _hiddenRouteNames.add(route.name);
        _saveHiddenRoutes();
        _refreshSavedRouteLayers();
        _buildRoutePickerPanel();
      });
      nameLine.appendChild(activateBtn);
      // flex:1 + ellipsis (not another stacked line) so a long name
      // truncates instead of pushing the date off the row — the whole
      // point of a table-like layout is that name/date/hazard line up
      // in one scannable row instead of each field getting its own line.
      const nameText = document.createElement('span');
      nameText.className = 'rp-row-name-text';
      nameText.textContent = route.name;
      nameLine.appendChild(nameText);
      const dateInline = document.createElement('span');
      dateInline.className = 'rp-row-date-inline';
      dateInline.textContent = _routeDateLabel(route);
      nameLine.appendChild(dateInline);
      {
        // Cached-only here — computing this per row (route segments ×
        // tens of thousands of hazard features) blocked the panel's own
        // first paint for multiple seconds once there were 100+ saved
        // routes. _warmRouteHazardCache backfills misses in the
        // background and re-renders once it has; a row just shows no
        // badge for the moment it isn't cached yet.
        const hazFoundRaw = _getRouteHazardsCached(route);
        const hazFound = hazFoundRaw || [];
        const hardCount = hazFound.filter(h => h.kind === 'hard').length;
        const softCount = hazFound.length - hardCount;
        // A cached result with no hard/soft badges could mean "genuinely
        // clean" or "nothing was actually checked" (wrong/no active
        // region for this route's area — see _checkRouteHazards). Absence
        // of a hazard badge here used to read as "verified safe" either
        // way; flag the second case explicitly instead of leaving it
        // indistinguishable from the first. See INCIDENTS.md, 2026-09-23.
        if (hardCount === 0 && softCount === 0 && hazFoundRaw && hazFoundRaw.coverage && hazFoundRaw.coverage !== 'core') {
          const badge = document.createElement('span');
          badge.className = 'status-badge rp-hazard-unverified';
          badge.textContent = '? unverified';
          badge.title = hazFoundRaw.coverage === 'none'
            ? 'No chart data is loaded for this route’s area — hazards were not actually checked'
            : 'Only land-avoidance data is loaded for this route’s area — rock/obstruction/wreck hazards were not actually checked';
          nameLine.appendChild(badge);
        }
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
      }, () => {
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
      }, 'route'));
      row.appendChild(nameLine);
      if (startName || endName) {
        const placeLine = document.createElement('div');
        placeLine.className = 'rp-row-places';
        placeLine.textContent = startName + (endName && endName !== startName ? ' → ' + endName : '');
        row.appendChild(placeLine);
      }
      // Follow/Virtual Journey come right after the name/date line, BEFORE the
      // (potentially long) multi-day legs list below — per direct report,
      // a route with several legs pushed these action buttons below the
      // fold, making them easy to miss without scrolling past the whole
      // leg breakdown first.
      const followBtn = document.createElement('button');
      followBtn.className = 'rp-follow-btn';
      if (_followingRouteId === route.id) {
        followBtn.textContent = '⏹ Stop Following';
        followBtn.title = 'Stop recording this passage';
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
      const vjBtn = document.createElement('button');
      vjBtn.className = 'rp-vj-btn';
      if (_vjRoute?.id === route.id) {
        vjBtn.textContent = '⏹ Stop Journey';
        vjBtn.title = 'Stop this virtual journey';
      } else {
        vjBtn.textContent = '🕹 Virtual Journey';
        vjBtn.title = 'Play this route back as a real moving GPS position at a configurable speed — rehearse bearing queries, anchor watch, etc. without leaving the dock';
        if (_trackRecActive) vjBtn.disabled = true;
      }
      vjBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_vjRoute?.id === route.id) {
          _stopVirtualJourney();
        } else {
          const speedKt2 = parseFloat(localStorage.getItem('audiochart-last-speed')) || 5;
          _startVirtualJourney(route, speedKt2);
        }
      });
      row.appendChild(vjBtn);
      // Previously the only way in was clicking the route's own line on the
      // map — awkward or outright impossible to hit reliably at some zoom
      // levels (reported live: can't see/click a route zoomed all the way
      // out). Re-resolves by id, same as the map's own click handler, so a
      // background sync reordering routes between panel-open and this
      // click can't open the wrong one either.
      const editBtn = document.createElement('button');
      editBtn.className = 'rp-follow-btn';
      editBtn.textContent = '✎ Edit';
      editBtn.title = 'Open this route in the map editor';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fresh = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
        const idx = fresh.findIndex(r => r.id === route.id);
        if (idx < 0) return;
        _closeRoutePicker();
        _enterEditMode(idx);
      });
      row.appendChild(editBtn);
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
      row.addEventListener('click', () => {
        if (_routeSelectMode) {
          if (_selectedRouteIds.has(route.id)) _selectedRouteIds.delete(route.id);
          else _selectedRouteIds.add(route.id);
        } else {
          _expandedRouteRowName = (_expandedRouteRowName === route.name) ? null : route.name;
        }
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
    if (opening) { _buildRoutePickerPanel(); _warmRouteHazardCache(); }
  });

  // Node Ops' ↻ (moved from the removed right-hand panel, 2026-10-07) —
  // re-solves the route being edited. The old panel also re-routed a
  // "selected" saved route outside edit mode (with a native alert() when
  // none was selected); to re-route a saved route now, open it and use this.
  document.getElementById('reroute-btn').addEventListener('click', () => {
    const btn = document.getElementById('reroute-btn');
    if (!_editMode) return;
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

  document.getElementById('rp-sort').addEventListener('change', (e) => {
    _routeSortMode = e.target.value;
    _buildRoutePickerPanel();
  });

  const _bulkSelectToggle = document.getElementById('rp-select-toggle');
  function _setRouteSelectMode(on) {
    _routeSelectMode = on;
    _selectedRouteIds.clear();
    _bulkSelectToggle.classList.toggle('active', on);
    _bulkSelectToggle.textContent = on ? '✕ Cancel select' : '☑ Select';
    _buildRoutePickerPanel();
  }
  _bulkSelectToggle.addEventListener('click', () => _setRouteSelectMode(!_routeSelectMode));
  document.getElementById('rp-bulk-cancel').addEventListener('click', () => _setRouteSelectMode(false));

  document.getElementById('rp-bulk-select-all').addEventListener('click', () => {
    const query = document.getElementById('rp-search').value || '';
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    routes.filter(r => _itemMatchesSearch(r, query)).forEach(r => _selectedRouteIds.add(r.id));
    _buildRoutePickerPanel();
  });

  document.getElementById('rp-bulk-hide').addEventListener('click', () => {
    if (!_selectedRouteIds.size) return;
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    routes.filter(r => _selectedRouteIds.has(r.id)).forEach(r => _hiddenRouteNames.add(r.name));
    _saveHiddenRoutes();
    _refreshSavedRouteLayers();
    _setRouteSelectMode(false);
  });

  document.getElementById('rp-bulk-delete').addEventListener('click', () => {
    if (!_selectedRouteIds.size) return;
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    const toDelete = routes.filter(r => _selectedRouteIds.has(r.id));
    if (!toDelete.length) return;
    const preview = toDelete.slice(0, 8).map(r => r.name).join(', ');
    const more = toDelete.length > 8 ? `, and ${toDelete.length - 8} more` : '';
    if (!confirm(`Delete ${toDelete.length} route${toDelete.length !== 1 ? 's' : ''}? ${preview}${more}\n\nThis cannot be undone.`)) return;
    toDelete.forEach((r) => {
      _tombstone(r.id, 'route');
      _hiddenRouteNames.delete(r.name);
      if (localStorage.getItem('audiochart-last-route') === r.name) {
        localStorage.removeItem('audiochart-last-route');
      }
      if (_expandedRouteRowName === r.name) _expandedRouteRowName = null;
    });
    localStorage.setItem(ROUTE_KEY, JSON.stringify(routes.filter(r => !_selectedRouteIds.has(r.id))));
    _saveHiddenRoutes();
    _refreshSavedRouteLayers();
    _populateRouteSelectFn?.();
    const msg = `Deleted ${toDelete.length} route${toDelete.length !== 1 ? 's' : ''}.`;
    setStatus(msg);
    TTS.sayImmediate(msg);
    _setRouteSelectMode(false);
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
  _makeCollapsible(_trackPickerPanel);

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
      const activateBtn = document.createElement('button');
      activateBtn.type = 'button';
      activateBtn.className = 'rp-activate-btn' + (hidden ? ' hidden' : '');
      activateBtn.textContent = hidden ? '✗ Hidden' : '✓ On map';
      activateBtn.title = hidden ? 'Tap to show this track on the map' : 'Tap to hide this track from the map';
      activateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_hiddenTrackNames.has(track.name)) _hiddenTrackNames.delete(track.name);
        else _hiddenTrackNames.add(track.name);
        _saveHiddenTracks();
        _refreshSavedTrackLayers();
        _buildTrackPickerPanel();
      });
      nameLine.appendChild(activateBtn);
      const nameText = document.createElement('span');
      nameText.textContent = track.name;
      nameLine.appendChild(nameText);
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
      }, () => {
        if (!confirm(`Delete track "${track.name}"?`)) return;
        const all = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
        _tombstone(track.id, 'track');
        localStorage.setItem(TRACK_KEY, JSON.stringify(all.filter(t => t.name !== track.name)));
        _hiddenTrackNames.delete(track.name);
        _saveHiddenTracks();
        if (_expandedTrackRowName === track.name) _expandedTrackRowName = null;
        _refreshSavedTrackLayers();
        _buildTrackPickerPanel();
      }, 'track'));
      row.appendChild(nameLine);
      if (startName || endName) {
        const placeLine = document.createElement('div');
        placeLine.className = 'rp-row-places';
        placeLine.textContent = startName + (endName && endName !== startName ? ' → ' + endName : '');
        row.appendChild(placeLine);
      }
      row.addEventListener('click', () => {
        _expandedTrackRowName = (_expandedTrackRowName === track.name) ? null : track.name;
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

  // ☁ Drive sync — shared between the Routes, Tracks, and Test Sets panels
  // (one backup blob covers all three, see drive_sync.js). A single Sync
  // action merges local and remote; nothing here ever wholesale-overwrites
  // either side, so there's no "wrong direction" to accidentally pick (see
  // sync_merge.js).
  (function _wireDriveSyncUI() {
    const statusEls = [document.getElementById('rp-sync-status'), document.getElementById('tp-sync-status'), document.getElementById('ts-sync-status')];
    const wifiCheckboxes = [document.getElementById('rp-wifi-sync'), document.getElementById('tp-wifi-sync'), document.getElementById('ts-wifi-sync')];
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

    [document.getElementById('rp-sync-now'), document.getElementById('tp-sync-now'), document.getElementById('ts-sync-now')].forEach(btn => {
      if (!btn) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setStatus('Syncing…');
        DriveSync.runMerge()
          .then(({ routeCount, trackCount, testSetCount, conflictCount }) => {
            const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
            const tracks = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
            _reconcileHiddenNamesAfterMerge(routes, tracks);
            _refreshSavedRouteLayers();
            _refreshSavedTrackLayers();
            _refreshTestSetLayer();
            if (document.getElementById('testsets-panel').classList.contains('open')) _populateTestSetsSubmenu();
            _populateRouteSelectFn?.();
            if (_routePickerPanel.classList.contains('open')) _buildRoutePickerPanel();
            if (_trackPickerPanel.classList.contains('open')) _buildTrackPickerPanel();
            setStatus(conflictCount > 0
              ? `Synced — ${routeCount} routes, ${trackCount} tracks, ${testSetCount} test sets, ${conflictCount} conflict cop${conflictCount === 1 ? 'y' : 'ies'} (review in the list)`
              : `Synced — ${routeCount} routes, ${trackCount} tracks, ${testSetCount} test sets, up to date`);
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

  // "Custom GeoLabels" checkbox — one toggle for the whole layer
  // (manually-dropped wp00N waypoints and Search/Drop-Pin's SP00N pins
  // alike; both render through the same _waypointsVisible-gated
  // _refreshWaypointLayer — internal naming stays "waypoints", only the
  // user-facing label changed). Per direct request: a real on/off control,
  // since previously the layer only ever turned itself on automatically
  // when a new pin was created, with no way to hide it again short of
  // clearing localStorage.
  const _waypointsCheckbox = document.getElementById('nf-waypoints');
  _waypointsCheckbox.checked = _waypointsVisible;
  _waypointsCheckbox.addEventListener('change', function () {
    _setWaypointsVisible(this.checked);
  });

  // Depths checkbox — show/hide settings and trigger tide fetch + overlay refresh
  const _depthCheckbox  = document.getElementById('nf-depth');
  const _depthSettings  = document.getElementById('nf-depth-settings');
  const _draftInput     = document.getElementById('nf-draft-ft');
  const _comfortInput   = document.getElementById('nf-comfort-margin-ft');
  const _timeoutInput   = document.getElementById('nf-route-timeout-s');
  _depthSettings.style.display = _depthCheckbox.checked ? '' : 'none';

  // Restore saved draft
  const _savedDraft = localStorage.getItem('audiochart-draft-ft');
  if (_savedDraft) _draftInput.value = _savedDraft;

  // Restore saved comfortable-clearance margin (v722 default: 3ft — see
  // Query.COMFORTABLE_CLEARANCE_M)
  const _savedComfort = localStorage.getItem('audiochart-comfort-margin-ft');
  if (_savedComfort) _comfortInput.value = _savedComfort;
  else _comfortInput.value = (Query.COMFORTABLE_CLEARANCE_M / 0.3048).toFixed(1);

  // Restore saved route-planning time limit
  const _savedTimeout = localStorage.getItem('audiochart-route-timeout-s');
  if (_savedTimeout) _timeoutInput.value = _savedTimeout;

  _depthCheckbox.addEventListener('change', async () => {
    _depthSettings.style.display = _depthCheckbox.checked ? '' : 'none';
    if (_depthCheckbox.checked) {
      const pos = GPS.getPosition();
      if (pos) await _fetchTideHeight(pos.lat, pos.lon);
    }
    _refreshNavaidOverlay();
  });

  // Soundings checkbox — split out from Depths into its own toggle, off
  // by default (direct request). Matches Depths' own pattern: fetch a
  // fresh tide height on enable (soundings render tide-adjusted
  // effective depth, same as mudflats), then refresh immediately rather
  // than waiting for the next pan/zoom.
  document.getElementById('nf-soundings').addEventListener('change', async function () {
    if (this.checked) {
      const pos = GPS.getPosition();
      if (pos) await _fetchTideHeight(pos.lat, pos.lon);
    }
    _refreshSoundingsLayer();
  });

  _draftInput.addEventListener('input', () => {
    localStorage.setItem('audiochart-draft-ft', _draftInput.value);
    if (_depthCheckbox.checked) _refreshNavaidOverlay();
  });

  _comfortInput.addEventListener('input', () => {
    localStorage.setItem('audiochart-comfort-margin-ft', _comfortInput.value);
    if (_depthCheckbox.checked) _refreshNavaidOverlay();
  });

  _timeoutInput.addEventListener('input', () => {
    localStorage.setItem('audiochart-route-timeout-s', _timeoutInput.value);
  });

  // Floating ☰ button — opens context menu at current GPS position
  // Refresh depth soundings when map moves or zooms
  _map.on('zoomend moveend', _refreshSoundingsLayer);

  // Direct follow-up (2026-09-29): navaids only ever redrew on initial
  // load, an explicit Refresh tap, a region switch, or the Depths
  // checkbox — never on plain panning/zooming, unlike soundings (just
  // above) and several other viewport-scoped overlays in this file
  // (_viewportHazardMoveEnd, _maineGeologyMoveEnd, _maineTownsMoveEnd).
  // Real complaint: panning to a new area showed nothing until manually
  // hitting Refresh. `moveend`/`zoomend` only fire once at the END of a
  // gesture (not continuously during it), so this is the same
  // lightweight debounce every other viewport-refresh in this file
  // already relies on.
  _map.on('zoomend moveend', _refreshNavaidOverlay);

  // Sketch route click/dblclick/mousemove handlers are registered in _enterSketchMode()

  // Right-click / long-press context menu
  const _ctxMenu = document.getElementById('map-context-menu');
  let _ctxLatLng = null;
  const _hideCtx = () => { _ctxMenu.style.display = 'none'; };

  const _ctxSubmenu = document.getElementById('map-ctx-objects-submenu');
  const _routesNearSubmenu = document.getElementById('map-ctx-routes-near-submenu');
  const _tracksNearSubmenu = document.getElementById('map-ctx-tracks-near-submenu');
  const _wpSubmenu  = document.getElementById('map-ctx-wp-submenu');
  const _testSetsSubmenu = document.getElementById('map-ctx-testsets-submenu');

  // Rebuild the dynamic waypoint rows (below the 6 static buttons)
  function _populateWpSubmenu() {
    // Remove all dynamic items (keep first 6 static children)
    while (_wpSubmenu.children.length > 6) _wpSubmenu.removeChild(_wpSubmenu.lastChild);
    const wps = WaypointsStorage.loadUserWaypoints();
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
      posBtn.textContent = 'Bring boat here';
      actions.appendChild(delBtn);
      actions.appendChild(posBtn);
      _wpSubmenu.appendChild(actions);
    }
  }

  // Rebuild the dynamic Test Set rows (below the 1 static "Hide all" button)
  function _populateTestSetsSubmenu() {
    while (_testSetsSubmenu.children.length > 1) _testSetsSubmenu.removeChild(_testSetsSubmenu.lastChild);
    const sets = TestSetsStorage.loadTestSets();
    const visibleIds = TestSetsStorage.loadVisibleTestSetIds();
    for (const set of sets) {
      const isVisible = visibleIds.has(set.id);
      const itemBtn = document.createElement('button');
      itemBtn.className = 'ctx-ts-item';
      itemBtn.dataset.tsId = set.id;
      itemBtn.textContent = `${set.name} (${set.waypoints.length})${isVisible ? ' \u{1F441}' : ''} ›`;
      _testSetsSubmenu.appendChild(itemBtn);

      const actions = document.createElement('div');
      actions.className = 'ctx-ts-actions';
      actions.dataset.tsId = set.id;
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'ctx-ts-toggle';
      toggleBtn.textContent = isVisible ? 'Hide on map' : 'Show on map';
      const tryBtn = document.createElement('button');
      tryBtn.className = 'ctx-ts-try-all';
      tryBtn.textContent = '\u{1F9ED} Try all routes';
      tryBtn.disabled = set.waypoints.length < 1;
      const delBtn = document.createElement('button');
      delBtn.className = 'ctx-ts-del';
      delBtn.textContent = 'Delete Test Set';
      actions.appendChild(toggleBtn);
      actions.appendChild(tryBtn);
      actions.appendChild(delBtn);
      _testSetsSubmenu.appendChild(actions);
    }
  }

  function _populateRouteSelect() {
    const sel    = document.getElementById('track-route-select');
    const speed  = document.getElementById('track-speed-input');
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    sel.innerHTML = routes.length
      ? routes.map((r, i) => `<option value="${i}">${escapeHtml(r.name)}</option>`).join('')
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
  _exitRoutePanelCompactFn = () => { if (_routePanelCompact) _setRoutePanelCompact(false); };
  _closeRoutePickerFn = _closeRoutePicker;
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
        configs.map((c, i) => `<option value="${i}">${escapeHtml(c.name)}</option>`).join('')
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
      ? routes.map((r, i) => `<option value="${i}">${escapeHtml(r.name)}</option>`).join('')
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

  _map.on('contextmenu', (e) => {
    _ctxLatLng = e.latlng;
    // Objects/Routes/Tracks-within are no longer part of this menu at all
    // (see _openNearPointFlyout) — just close a stray one left open from a
    // marker popup, since a fresh right-click means a fresh point anyway.
    _closeNearPointFlyouts();
    // _wpSubmenu/_testSetsSubmenu are no longer context-menu submenus —
    // they now live inside the standalone #waypoints-panel/#testsets-panel
    // (see that panel's own open handler, which populates them fresh);
    // forcing them to display:none here would permanently out-rank this
    // app's CSS override with an inline style, leaving those panels
    // looking empty every time they're opened after any right-click.
    _trackSubmenu.style.display  = 'none';
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

  // Objects/Routes/Tracks-within radius pickers — opened from a marker's own
  // popup now (see _openNearPointFlyout + the navaid-popup template in
  // _refreshWaypointLayer), not from this right-click menu anymore. These
  // listeners just act on whatever point _openNearPointFlyout last recorded
  // in _nearPointOrigin, same three singleton flyout elements either way.
  _ctxSubmenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-radius-nm]');
    if (!btn) return;
    const origin = _nearPointOrigin;
    _closeNearPointFlyouts();
    if (origin) handleMapLongPress(origin, parseFloat(btn.dataset.radiusNm), btn.dataset.radiusLabel);
  });

  _routesNearSubmenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-radius-nm]');
    if (!btn) return;
    const origin = _nearPointOrigin;
    _closeNearPointFlyouts();
    if (origin) _showNearPointPanel('route', origin, _routesNearPoint(origin.lat, origin.lng, parseFloat(btn.dataset.radiusNm)), btn.dataset.radiusLabel);
  });

  _tracksNearSubmenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-radius-nm]');
    if (!btn) return;
    const origin = _nearPointOrigin;
    _closeNearPointFlyouts();
    if (origin) _showNearPointPanel('track', origin, _tracksNearPoint(origin.lat, origin.lng, parseFloat(btn.dataset.radiusNm)), btn.dataset.radiusLabel);
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

    // Populated if autoRouteProg has to move the start/end off charted-too-
    // shallow water for the current draft/tide — previously only a
    // console.log, which made a relocated destination look like the router
    // just missed it. See INCIDENTS.md.
    const snapEvents = [];
    let pts;
    try {
      pts = await Router.autoRouteProg(start, end,
        (path) => _autoRoutePreviewLayer.setLatLngs(path.map(p => [p.lat, p.lon])),
        (t) => { const el = optOverlay.querySelector('.optimizing-text'); if (el) el.textContent = t; },
        false, _currentDraftFt(), _tideHeight, _makeSearchDotCallback(),
        (which, snap) => snapEvents.push({ which, ...snap }),
        _currentDeadlineMs()
      );
    } catch (err) {
      optOverlay.remove();
      console.error('[autoRoute] error:', err);
      setStatus(`Auto-route error: ${err.message}`);
      return;
    }

    optOverlay.remove();

    _routeSnapMarkers.forEach(m => m.remove());
    _routeSnapMarkers = snapEvents.map(s => {
      const label = s.which === 'end' ? 'destination' : 'start';
      return L.circleMarker([s.lat, s.lon], {
        radius: 7, color: '#ffaa00', fillColor: '#ffaa00', fillOpacity: 0.75, weight: 2,
      }).addTo(_map).bindTooltip(
        `${escapeHtml(name)} — ${label} moved ${s.movedNm.toFixed(2)}nm (too shallow at current draft/tide)`,
        { permanent: false }
      );
    });
    // The orange dot alone was easy to miss — a route that silently stops
    // well short of the marker reads as "it worked" (Carvers Harbor,
    // 2026-10-06: ended 0.65 nm outside the harbor with no message). Say it.
    const endMove = snapEvents.find(s => s.which === 'end' && s.movedNm >= 0.1);
    if (endMove) {
      const msg = `The route ends ${endMove.movedNm.toFixed(1)} nautical miles short of the destination — it's on land or too shallow there for a ${_currentDraftFt()} ft draft at the current tide.`;
      setStatus(msg);
      showResponse(msg);
      if (endMove.movedNm >= 0.25) TTS.sayImmediate(msg);
    }
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
    const marginalSeg = pts.length > 2 ? _marginalLegFromPath(pts) : null;
    const found = _enterEditMode(newIdx);

    // Deliberately NOT gated on found.length here — see the matching
    // comment in _onDrawConfirm. A fallback/marginal leg is a different,
    // more urgent problem than "a hazard is charted nearby," and gating on
    // found.length let a coastal fallback's own nearby-shallow-water hits
    // silently swallow the one warning that actually mattered.
    // Silent below except _showRouteFallbackWarning's own — see the matching
    // comment in _onDrawConfirm: AutoRoute plotting stays quiet except for
    // a genuine danger, never for routine success or a shallow-water
    // relocation note (still visible on the map via the orange snap marker).
    if (fellBack) {
      _showRouteFallbackWarning([{ a: pts[0], b: pts[1], legIndex: 0 }], pts._timedOut ? () => {
        // Retry re-plans the identical start/end/name at the raised limit —
        // remove the straight-line fallback route this attempt just saved
        // first, so a retry doesn't leave a duplicate/broken route behind
        // (same pop+tombstone the removed "Delete last route" context-menu
        // button used to do — see v759).
        const cur = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
        const idx = cur.findIndex(r => r.id === routes[newIdx].id);
        if (idx >= 0) {
          const [deleted] = cur.splice(idx, 1);
          _tombstone(deleted.id, 'route');
          localStorage.setItem(ROUTE_KEY, JSON.stringify(cur));
        }
        if (_editMode && _editRouteIdx === newIdx) _exitEditMode();
        _refreshSavedRouteLayers();
        _populateRouteSelectFn?.();
        _autoRouteName = name; _autoRouteStart = start; _autoRouteEnd = end;
        _triggerAutoRoute();
      } : null);
    } else if (marginalSeg) {
      _showRouteFallbackWarning([marginalSeg]);
    } else if (!found.length) {
      setStatus(`${name} planned — ${totalNm.toFixed(1)} nm.`);
    }
  }

  // Shared by the map context menu's "Route from here" and the boat icon's
  // long-press "Autoroute" shortcut — same start-a-route flow, just a
  // different way of supplying the starting point (a right-clicked map
  // point vs. wherever the boat currently is).
  function _routeFromHere(lat, lon) {
    const name = prompt('Name for this planned route:', _nextRouteName());
    if (!name) return;
    _autoRouteName  = name;
    _autoRouteStart = { lat, lon };
    if (_autoRouteStartMarker) _autoRouteStartMarker.remove();
    _autoRouteStartMarker = L.circleMarker([lat, lon], {
      radius: 8, color: '#00cc44', fillColor: '#00cc44', fillOpacity: 0.8, weight: 2,
    }).addTo(_map).bindTooltip(`${escapeHtml(name)} — start`, { permanent: false });
    if (_autoRouteEnd) {
      _triggerAutoRoute();
    } else {
      // Tap the map to finish it immediately — right-click → "Route to
      // here" still works too, this is just the faster path.
      _armPendingRouteDestination();
      setStatus(`"${name}" start set — tap the map for the destination, or type its name in the box below.`);
      TTS.sayImmediate(`${name} started. Tap the map for the destination, or enter the name of the destination in the text input box.`);
    }
  }
  _routeFromHereFn = _routeFromHere;

  // "AutoRoute from boat position" (a waypoint pin's own popup menu) — same
  // start→destination→_triggerAutoRoute pipeline as _routeFromHere/
  // _setRouteDestination, but genuinely zero-interaction per direct
  // request: no name prompt, no arming a second tap for the destination.
  // Start is wherever GPS says the boat actually is right now; destination
  // is the pin whose popup this was opened from.
  function _autoRouteFromBoatToHere(lat, lon) {
    const pos = GPS.getPosition();
    if (!pos) {
      const msg = 'No GPS fix yet — cannot auto-route from the boat’s position.';
      setStatus(msg);
      TTS.sayImmediate(msg);
      return;
    }
    // If the boat or the destination is off screen (a named place, or a
    // marker you're zoomed in on), frame both first so the new route is
    // actually visible. Left alone when both are already in view.
    const view = _map.getBounds();
    if (!view.contains([pos.lat, pos.lon]) || !view.contains([lat, lon])) {
      _map.fitBounds(L.latLngBounds([[pos.lat, pos.lon], [lat, lon]]), { padding: [80, 80], maxZoom: 13 });
    }
    _autoRouteName = _nextRouteName();
    _autoRouteStart = { lat: pos.lat, lon: pos.lon };
    if (_autoRouteStartMarker) _autoRouteStartMarker.remove();
    _autoRouteStartMarker = L.circleMarker([pos.lat, pos.lon], {
      radius: 8, color: '#00cc44', fillColor: '#00cc44', fillOpacity: 0.8, weight: 2,
    }).addTo(_map).bindTooltip(`${escapeHtml(_autoRouteName)} — start`, { permanent: false });
    _setRouteDestination(lat, lon);
  }
  _autoRouteFromBoatToHereFn = _autoRouteFromBoatToHere;

  // Shared by the pending-click destination-picker armed after
  // _routeFromHere (see below), a waypoint/Test Set popup's own AutoRoute
  // button, and the typed-name destination flow below — same
  // set-the-endpoint-and-route flow, just several different ways of
  // supplying the destination point.
  function _setRouteDestination(lat, lon) {
    _disarmPendingRouteDestination();
    _autoRouteEnd = { lat, lon };
    if (_autoRouteEndMarker) _autoRouteEndMarker.remove();
    _autoRouteEndMarker = L.circleMarker([lat, lon], {
      radius: 8, color: '#cc2200', fillColor: '#cc2200', fillOpacity: 0.8, weight: 2,
    }).addTo(_map).bindTooltip(`${escapeHtml(_autoRouteName || 'Route')} — destination`, { permanent: false });
    if (!_autoRouteStart) {
      setStatus('Destination set — long-press the boat icon → Autoroute to plan a route.');
      return;
    }
    _triggerAutoRoute();
  }

  // Armed by _routeFromHere once a start point is set with no destination
  // yet — the very next tap anywhere on the map completes the route
  // immediately, no need to separately find a destination-picker
  // elsewhere. Typing a name via the banner's Name button works too (see
  // route-dest-name-btn below), same underlying _setRouteDestination call.
  let _pendingRouteDestClick = null;
  const _routeDestBanner = document.getElementById('route-dest-banner');
  const _routeDestBannerLabel = document.getElementById('route-dest-banner-label');
  const _routeDestNameBtn = document.getElementById('route-dest-name-btn');
  function _disarmPendingRouteDestination() {
    if (_pendingRouteDestClick) { _map.off('click', _pendingRouteDestClick); _pendingRouteDestClick = null; }
    _routeDestBanner.style.display = 'none';
    _routeDestNameBtn.classList.remove('flash-attention');
    _setBottomHudHiddenForBanner(false);
  }
  function _armPendingRouteDestination() {
    _disarmPendingRouteDestination();
    _pendingRouteDestClick = (e) => _setRouteDestination(e.latlng.lat, e.latlng.lng);
    _map.on('click', _pendingRouteDestClick);
    // A status-bar message and a spoken line aren't enough on their own —
    // both are easy to miss, and this is the one moment the user has to
    // actually DO something (tap the map) rather than just be informed of
    // something. A persistent banner, same convention as Draw Route's own
    // step-by-step prompt, stays on screen until they act or cancel.
    _routeDestBannerLabel.textContent = `Tap the map to set the destination for "${_autoRouteName}" — or tap Name to type it`;
    _routeDestBanner.style.display = 'flex';
    // Tapping the map is the faster path, but it's easy to miss that typing
    // a name works too — flash the Name button a few times to draw the eye
    // to it (finite iteration count, not infinite: this banner can stay up
    // indefinitely and a forever-pulsing button would just become noise).
    _routeDestNameBtn.classList.remove('flash-attention');
    void _routeDestNameBtn.offsetWidth; // restart the animation if it's re-armed before finishing
    _routeDestNameBtn.classList.add('flash-attention');
    // Confirmed live on a phone: this banner's own "Name" button was
    // sitting right underneath #bottom-hud (fixed to the viewport's own
    // bottom edge, not aware of this normal-flow banner pushing the map
    // up) — same root cause and fix as #edit-banner's collision with the
    // tide widget (see #app.edit-mode #bottom-hud in app.css).
    _setBottomHudHiddenForBanner(true);
  }
  document.getElementById('route-dest-name-btn').addEventListener('click', async () => {
    // _showTextPrompt, not window.prompt() — see _promptNextLegAutoRoute's
    // own comment: a native prompt() can be silently suppressed by the
    // browser/webview's dialog-spam protection on a quick repeat trigger,
    // which this button (re-armable via Cancel + Autoroute again) is just
    // as exposed to. Matches the pattern already fixed there.
    const query = await _showTextPrompt('Destination — place or waypoint name:');
    if (!query) return;
    const dest = await _resolveNamedDestination(query);
    if (!dest) return;
    _setRouteDestination(dest.lat, dest.lon);
  });
  document.getElementById('route-dest-cancel-btn').addEventListener('click', () => {
    const name = _autoRouteName;
    _clearAutoRoute();
    const msg = `${name || 'Route'} cancelled.`;
    setStatus(msg);
    TTS.sayImmediate(msg);
  });
  _disarmPendingRouteDestinationFn = _disarmPendingRouteDestination;

  const _trackSubmenu = document.getElementById('map-ctx-track-submenu');

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

  _wpSubmenu.addEventListener('click', (e) => {
    const t = e.target;

    if (t.id === 'map-ctx-wp-show') { _hideCtx(); _setWaypointsVisible(true);  return; }
    if (t.id === 'map-ctx-wp-hide') { _hideCtx(); _setWaypointsVisible(false); return; }

    if (t.id === 'map-ctx-wp-export') {
      _hideCtx();
      const stored = WaypointsStorage.loadUserWaypoints();
      if (!stored.length) {
        const msg = 'No waypoints to export.';
        setStatus(msg); TTS.sayImmediate(msg);
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      GpxExport.downloadWaypointsGpx(stored, `AudioChart_waypoints_${stamp}`);
      const msg = `Exported ${stored.length} waypoint${stored.length === 1 ? '' : 's'}.`;
      setStatus(msg); TTS.sayImmediate(msg);
      return;
    }

    if (t.id === 'map-ctx-wp-del-sp') {
      _hideCtx();
      const stored = WaypointsStorage.loadUserWaypoints();
      const toDelete = stored.filter(w => w.name.startsWith('SP'));
      if (!toDelete.length) {
        const msg = 'No SP waypoints to delete.';
        setStatus(msg); TTS.sayImmediate(msg);
        return;
      }
      // List the actual names, not just a count — after a past report of
      // this deleting more than expected, a bare count gives no way to
      // catch a wrong match before committing to an unrecoverable delete.
      // ("Export all waypoints" above is the recommended safety net before
      // any bulk delete, now that a backup path actually exists.)
      const names = toDelete.map(w => w.name).join(', ');
      if (!confirm(`Delete ${toDelete.length} waypoint${toDelete.length === 1 ? '' : 's'}?\n\n${names}\n\nThis cannot be undone.`)) return;
      localStorage.setItem(WaypointsStorage.USER_WP_KEY, JSON.stringify(stored.filter(w => !w.name.startsWith('SP'))));
      for (const w of toDelete) Query.removeUserWaypoint(w.name);
      _refreshWaypointLayer();
      const msg = `Deleted ${toDelete.length} SP* waypoint${toDelete.length === 1 ? '' : 's'}.`;
      setStatus(msg); TTS.sayImmediate(msg);
      return;
    }

    if (t.id === 'map-ctx-wp-save-testset') {
      _hideCtx();
      const stored = WaypointsStorage.loadUserWaypoints();
      const spWps = stored.filter(w => w.name.startsWith('SP'));
      if (!spWps.length) {
        const msg = 'No SP* waypoints to save as a Test Set.';
        setStatus(msg); TTS.sayImmediate(msg);
        return;
      }
      (async () => {
        const name = await _showTextPrompt('Name this Test Set', '', TestSetsStorage.nextTestSetDefaultName());
        if (!name) return;
        const set = TestSetsStorage.saveTestSet(name, spWps);
        TestSetsStorage.setTestSetVisible(set.id, true);
        // Direct request, 2026-09-28: saving converts the source SP*
        // waypoints into the Test Set rather than leaving a duplicate
        // copy behind — they disappear from the regular Waypoints list
        // (and the map, via _refreshWaypointLayer below) and only exist
        // as this set's own TS00N markers from here on.
        localStorage.setItem(WaypointsStorage.USER_WP_KEY, JSON.stringify(stored.filter(w => !w.name.startsWith('SP'))));
        for (const w of spWps) Query.removeUserWaypoint(w.name);
        _refreshWaypointLayer();
        _refreshTestSetLayer();
        const msg = `Converted ${spWps.length} SP* waypoint${spWps.length === 1 ? '' : 's'} to Test Set "${name}".`;
        setStatus(msg); TTS.sayImmediate(msg);
      })();
      return;
    }

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
      localStorage.setItem(WaypointsStorage.USER_WP_KEY, JSON.stringify(WaypointsStorage.loadUserWaypoints().filter(w => w.name !== name)));
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
      _bringBoatTo(lat, lon, name);
      return;
    }
  });

  _testSetsSubmenu.addEventListener('click', (e) => {
    const t = e.target;

    if (t.id === 'map-ctx-testsets-hide-all') {
      _hideCtx();
      for (const id of TestSetsStorage.loadVisibleTestSetIds()) TestSetsStorage.setTestSetVisible(id, false);
      _refreshTestSetLayer();
      const msg = 'Hid all Test Set markers.';
      setStatus(msg); TTS.sayImmediate(msg);
      return;
    }

    if (t.classList.contains('ctx-ts-item')) {
      const id = t.dataset.tsId;
      const actions = _testSetsSubmenu.querySelector(`.ctx-ts-actions[data-ts-id="${id}"]`);
      _testSetsSubmenu.querySelectorAll('.ctx-ts-actions').forEach(a => {
        if (a !== actions) a.style.display = 'none';
      });
      const opening = actions.style.display !== 'block';
      actions.style.display = opening ? 'block' : 'none';
      return;
    }

    if (t.classList.contains('ctx-ts-toggle')) {
      const actions = t.closest('.ctx-ts-actions');
      const id = actions.dataset.tsId;
      const nowVisible = !TestSetsStorage.loadVisibleTestSetIds().has(id);
      _setTestSetVisible(id, nowVisible);
      _populateTestSetsSubmenu();
      const set = TestSetsStorage.loadTestSets().find(s => s.id === id);
      const msg = `Test Set "${set?.name ?? ''}" ${nowVisible ? 'shown on' : 'hidden from'} the map.`;
      setStatus(msg); TTS.sayImmediate(msg);
      return;
    }

    if (t.classList.contains('ctx-ts-del')) {
      const actions = t.closest('.ctx-ts-actions');
      const id = actions.dataset.tsId;
      const set = TestSetsStorage.loadTestSets().find(s => s.id === id);
      if (!set) return;
      if (!confirm(`Delete Test Set "${set.name}" (${set.waypoints.length} marker${set.waypoints.length === 1 ? '' : 's'})? This cannot be undone.`)) return;
      _tombstone(id, 'testset'); // see v761's Test Set sync
      TestSetsStorage.deleteTestSet(id);
      _refreshTestSetLayer();
      _populateTestSetsSubmenu();
      const msg = `Test Set "${set.name}" deleted.`;
      setStatus(msg); TTS.sayImmediate(msg);
      return;
    }

    if (t.classList.contains('ctx-ts-try-all')) {
      const actions = t.closest('.ctx-ts-actions');
      const id = actions.dataset.tsId;
      const set = TestSetsStorage.loadTestSets().find(s => s.id === id);
      if (!set) return;
      _hideCtx();
      _tryAllTestSetRoutes(set);
      return;
    }
  });

  importMenuBtn.addEventListener('click', () => {
    const isOpen = importMenu.style.display !== 'none';
    if (isOpen) { _closeImportMenu(); return; }
    const isMobile = navigator.maxTouchPoints > 1;
    document.getElementById('import-hint-text').textContent = isMobile
      ? 'Export from Navionics → Files app first'
      : '~/Library/Application Support/opencpn/';
    importMenu.style.display = 'flex';
  });

  const _gpxInput = document.getElementById('gpx-file-input');
  let _gpxMode = null;

  document.getElementById('map-ctx-import-markers').addEventListener('click', () => {
    _closeImportMenu();
    _gpxMode = 'markers';
    _gpxInput.multiple = false;
    _gpxInput.value = '';
    _gpxInput.click();
  });

  document.getElementById('map-ctx-import-routes').addEventListener('click', () => {
    _closeImportMenu();
    _gpxMode = 'routes';
    _gpxInput.multiple = false;
    _gpxInput.value = '';
    _gpxInput.click();
  });

  document.getElementById('map-ctx-combine-routes').addEventListener('click', () => {
    _closeImportMenu();
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

  // Sample Routes: a hand-verified library shipped per-region (see
  // Query.curatedRoutes / data/regions/<id>/curated_routes.json) — gives an
  // armchair cruiser something to explore immediately, and doubles as a
  // regression check (see window._verifyCuratedRoutes) that the live router
  // can still reproduce a safe path for each one. Shared by the manual
  // "★ Sample Routes" toggle below and _buildRoutePickerPanel's own
  // auto-expand for a brand-new user with no saved routes yet.
  function _renderSampleRouteList(listEl, { withHeading }) {
    const routes = Query.curatedRoutes || [];
    const heading = withHeading ? '<div class="rp-sample-heading">New here? Try a sample route to get started:</div>' : '';
    const items = routes.length
      ? routes.map(r => `
          <div class="rp-sample-item">
            <button class="rp-sample-item-main" data-id="${escapeHtml(r.id)}">
              <span class="rp-sample-item-name">${escapeHtml(r.name)}</span>
              ${r.note ? `<span class="rp-sample-item-note">${escapeHtml(r.note)}</span>` : ''}
            </button>
            <button class="rp-sample-item-watch" data-id="${escapeHtml(r.id)}" title="Watch a short auto-playing tour of this route">&#9654; Watch</button>
          </div>
        `).join('')
      : '<div class="rp-empty">No sample routes for this region yet.</div>';
    listEl.innerHTML = heading + items;
    listEl.style.display = 'block';
  }
  // Loads a curated sample as a real saved route — shared by the "load into
  // my routes" click and _playRouteMovie (which needs a real saved route to
  // hand Virtual Journey, same as any other route). Reuses an existing
  // load of the exact same sample (matched by name) rather than creating a
  // fresh duplicate every time, since Watch can reasonably be tapped more
  // than once for the same route.
  function _loadSampleRoute(sample) {
    const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
    const existing = routes.find(r => r.name === sample.name);
    if (existing) return existing;
    const existingNames = new Set(routes.map(r => r.name));
    const name = _uniqueRouteName(sample.name, existingNames);
    // Preserve any per-waypoint flags (e.g. `overnight`) — a plain
    // {lat,lon} copy here would silently drop them.
    const route = _stampNew({ name, points: sample.points.map(p => ({ ...p })) });
    routes.push(route);
    localStorage.setItem(ROUTE_KEY, JSON.stringify(routes));
    return route;
  }

  // Guards against a second "▶ Watch" click starting a concurrent movie
  // while one's already playing — two overlapping runs would fight over
  // the same singleton state (_animMode/_animMarker, GPS position, map
  // mode, etc.) rather than actually running side by side. Set/cleared at
  // the click handler below, not inside _playRouteMovie itself, so it
  // reliably resets even if a step throws partway through.
  let _movieRunning = false;

  // Step 6 (the "other map types" reference blurb) is the same for every
  // sample route — watch two or three in one sitting and it repeats
  // itself verbatim each time. Speak it once per session (in-memory, not
  // persisted — resets on reload) and skip straight to the closing lines
  // on every play after that.
  let _mapTypesBlurbShown = false;

  // See the big comment on ROUTE_MOVIES (top of file) for what this is and
  // why — a passive, auto-playing, narrated walkthrough per sample route,
  // triggered by "▶ Watch" below. Lives in this scope (not top-level, where
  // ROUTE_MOVIES itself sits) because it needs _loadSampleRoute and
  // _buildRoutePickerPanel, both local to _ensureMap.
  async function _playRouteMovie(sample) {
    const movie = ROUTE_MOVIES[sample.id];
    if (!movie) return;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const hud = document.getElementById('demo-hud');
    const stepBadge = document.getElementById('demo-step-badge');
    const TOTAL = 6;
    // Plays the pre-rendered clip for this step (_movieStepAudio, top of
    // file) and waits for it to finish before the movie advances —
    // reliable, fixed-duration playback via a plain <audio> element, not
    // the live speechSynthesis API. caption is shown in the HUD alongside
    // it, mirroring what's actually spoken (cosmetic only — the audio is
    // what plays, not this text).
    const showStep = (n, caption) => {
      if (stepBadge) { stepBadge.textContent = `STEP ${n} OF ${TOTAL}`; stepBadge.style.display = 'block'; }
      if (hud) { hud.textContent = caption; hud.style.display = 'block'; }
      return new Promise((resolve) => {
        let done = false;
        const audio = new Audio(_movieStepAudio(movie, n));
        // Explicitly pause and drop the element once this step is done,
        // whichever way it resolved — a movie creates 5 of these in
        // sequence, and leaving each one dangling (with a possibly still-
        // pending play() promise) risks compounding into browser
        // autoplay/media-session throttling on later steps.
        const finish = () => {
          if (done) return;
          done = true;
          try { audio.pause(); } catch (_) {}
          resolve();
        };
        // Hard ceiling regardless of how play() settles: confirmed live
        // that play()'s own promise can be left permanently pending in
        // some environments — neither resolving nor rejecting — which
        // would otherwise hang the whole movie forever on one step.
        // Starts generous (some of the v656 per-route summary clips run
        // 10-14s — an earlier flat 8s guess here cut those off mid-
        // sentence) and tightens to the clip's own real duration, plus a
        // buffer, as soon as metadata loads, so a genuinely stuck clip
        // still gets caught reasonably fast.
        let ceiling = setTimeout(finish, 20000);
        audio.addEventListener('loadedmetadata', () => {
          if (isFinite(audio.duration)) {
            clearTimeout(ceiling);
            ceiling = setTimeout(finish, audio.duration * 1000 + 3000);
          }
        }, { once: true });
        audio.addEventListener('ended', finish, { once: true });
        audio.addEventListener('error', finish, { once: true });
        audio.play().catch(finish);
      });
    };
    const switchMode = (mode) => {
      const sel = document.getElementById('map-layer-select');
      sel.value = mode;
      sel.dispatchEvent(new Event('change'));
    };
    // Step 6's "other map types" reference table — built from the real
    // mode list (MAP_VIEW_MODES/ICONS/LABELS/DESCRIPTIONS, top of file),
    // not hand-duplicated here.
    const _showModesTable = () => {
      const el = document.getElementById('demo-modes-table');
      if (!el) return;
      const rows = MAP_VIEW_MODES.map(m => `
        <tr>
          <td class="dmt-icon">${MAP_VIEW_ICONS[m]}</td>
          <td class="dmt-name">${MAP_VIEW_LABELS[m]}</td>
          <td class="dmt-desc">${MAP_VIEW_DESCRIPTIONS[m]}</td>
        </tr>
      `).join('');
      el.innerHTML = `<h4>Other map types</h4><table>${rows}</table>`;
      el.style.display = 'block';
    };
    const _hideModesTable = () => {
      const el = document.getElementById('demo-modes-table');
      if (el) el.style.display = 'none';
    };

    // A real boat position makes "Virtual Journey" and the route itself
    // make sense on screen — same Rockland test position used throughout
    // (the route data's own start point).
    GPS.setManualPosition(44.0986, -69.0752);
    syncTestPosButton();

    const myRoute = _loadSampleRoute(sample);
    _buildRoutePickerPanel();

    // Hidden, not closed, for the whole walkthrough — they float right
    // over the map and were in the way the entire time, not just during
    // the Step 4 animation. Their own .open state (and everything else
    // about "stays open until you close it", v650) is untouched; this
    // only toggles visibility temporarily. Routes' prior open-state is
    // captured rather than assumed (the user may or may not have had it
    // open — Sample Routes has its own top-chrome button now, v659, so
    // reaching Watch no longer implies Routes was open). Restored just
    // before the closing line, which tells the user to tap Sample Routes
    // next.
    const _routesWasOpen = _routePickerPanel.classList.contains('open');
    _sampleRoutesPanel.classList.remove('open');
    _sampleRoutesBtn.classList.remove('active');
    if (_routesWasOpen) _routePickerPanel.classList.remove('open');

    // Step 1: discover the destination. Starts wide from the boat's own
    // position, then flies across the bay to the destination — genuine
    // lateral panning plus a slow zoom-in (not an instant jump), so place
    // names have time to become legible as it zooms and the anchorage's
    // own anchor icon is the last thing to resolve into view. Timed to
    // run alongside this step's narration, not finish before it starts —
    // per direct request: "while you are saying [the line], let's first
    // pan over to it, then zoom in fairly slowly."
    switchMode('anchorages');
    await sleep(600);
    const destMarker = _findDocumentMarkerByTitle(movie.destinationTitle);
    if (destMarker && _map) {
      _map.setView([44.0986, -69.0752], 9);
      await sleep(300);
      const FLY_SECONDS = 3.5;
      // Same lesson as showStep's audio ceiling: flyTo's animation runs
      // on requestAnimationFrame, which some environments can leave
      // stalled indefinitely — never let a single 'moveend' that might
      // not come hang the whole movie forever.
      const flyDone = new Promise(resolve => {
        _map.once('moveend', resolve);
        setTimeout(resolve, (FLY_SECONDS + 2) * 1000);
      });
      _map.flyTo(destMarker.getLatLng(), 12, { duration: FLY_SECONDS });
      await Promise.all([flyDone, showStep(1, `Let's check out the region around ${movie.place}.`)]);
      destMarker.fire('click'); // real Leaflet click — opens the popup, same as a tap
      await sleep(600);
    } else {
      await showStep(1, `Let's check out the region around ${movie.place}.`);
    }
    await sleep(1500);

    // Step 2: history — a ~25-word summary of the real write-up at this
    // destination (see ROUTE_MOVIES comment), not just a mode-switch
    // announcement. Only if a history document exists near it.
    if (movie.historyTitle) {
      switchMode('history');
      await sleep(1200);
      const histMarker = _findDocumentMarkerByTitle(movie.historyTitle);
      if (histMarker && _map) {
        _map.setView(histMarker.getLatLng(), 12);
        await sleep(900);
        histMarker.fire('click');
        await sleep(600);
      }
      // Explain the mode itself before the per-route summary — keep this
      // clause in sync with MAP_VIEW_DESCRIPTIONS.history.
      await showStep(2, `Switching to History mode — this shows real historical write-ups tied to actual places. ${movie.historyCaption}`);
      await sleep(1800);
    }

    // Step 3: geology — a ~25-word summary of the real bedrock
    // classification for this area (see ROUTE_MOVIES comment). Mark the
    // generic one-time Geology-mode hint (MODE_INTROS) seen before
    // switching, so it doesn't auto-fire its own spoken callout here and
    // talk over this step's narration — the movie already explains the
    // mode switch itself.
    Tour.markModeIntroSeen('geology-maine');
    switchMode('geology-maine');
    await sleep(1800); // live FeatureServer fetch + render time
    // Explain the mode itself before the per-route summary — keep this
    // clause in sync with MAP_VIEW_DESCRIPTIONS['geology-maine'].
    await showStep(3, `Now, Geology mode — this shows live Maine bedrock and surficial geology data. ${movie.geologyCaption}`);
    await sleep(1800);

    // Step 4: back to Chart (clearer view than geology's colored overlay),
    // then sail it — using the same fixed-10-second boat-icon preview as
    // the "▶ Preview"/"▶ Animate" buttons elsewhere in the app
    // (_startRouteAnimation), not Virtual Journey. Virtual Journey is
    // real-time-scaled by speed×compression, so its actual runtime varies
    // with route length and doesn't reliably fit the movie's own pacing —
    // _startRouteAnimation always takes exactly ANIMATE_TOTAL_SEC (10s)
    // regardless of route length, which is what "the way we do when we
    // have a route preview" means (v653 fix — Virtual Journey wasn't it).
    switchMode('chart');
    await sleep(600);
    // Narrate before starting the animation, not after: _startRouteAnimation
    // clears the screen and announces itself via its own live TTS
    // ("Screen cleared." / "Animating {route}…", see _clearScreen and
    // _startRouteAnimation) on a different audio channel than this step's
    // pre-rendered clip — sequencing this first keeps the two from
    // talking over each other.
    await showStep(4, "Here's the route, already plotted. Watch the sailboat icon trace the route.");
    await sleep(500);
    _startRouteAnimation(myRoute, 5);
    // Fixed real-world length regardless of route — give it room to finish
    // before Step 5's own narration starts.
    await sleep(10500);
    _sampleRoutesPanel.classList.add('open');
    _sampleRoutesBtn.classList.add('active');
    if (_routesWasOpen) _routePickerPanel.classList.add('open');

    // Step 5: closing — by now the animation has finished and is sitting
    // on its own "complete · tap map to dismiss" banner (same as the real
    // Preview/Animate buttons); the movie itself is just done narrating.
    // Panels are visible again by now, so "Tap Samples" is actually
    // actionable when this line plays.
    await showStep(5, "That's the passage. Tap Samples to load any other.");
    await sleep(1500);

    // Step 6: there's more to explore — a quick reference table of every
    // other map mode (MAP_VIEW_MODES, top of file), shown alongside the
    // narration and left up a while longer after so it's actually
    // readable, not just glanced at (per direct request: "put up a table
    // for several seconds").
    if (_mapTypesBlurbShown) {
      // Same visual (badge + table), just no repeated audio narration.
      if (stepBadge) { stepBadge.textContent = `STEP 6 OF ${TOTAL}`; stepBadge.style.display = 'block'; }
      if (hud) { hud.textContent = 'Other map types.'; hud.style.display = 'block'; }
      _showModesTable();
      await sleep(4000);
      _hideModesTable();
    } else {
      _mapTypesBlurbShown = true;
      const _modesDonePromise = showStep(6, "There are a number of other map types, with new ones being added regularly. In addition to being a navigation app, AudioChart has something for even armchair sailors — it provides map modes as a way of exploring and learning about some diverse aspects of Penobscot Bay.");
      _showModesTable();
      await _modesDonePromise;
      await sleep(4000);
      _hideModesTable();
    }

    if (stepBadge) stepBadge.style.display = 'none';
    if (hud) hud.style.display = 'none';
  }

  const _sampleList = document.getElementById('rp-sample-list');
  // Own top-chrome button now (v659), not tucked inside Routes — a real
  // toggle, matching #route-picker-btn's own pattern, rather than the old
  // "always just opens" in-panel action button.
  _sampleRoutesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !_sampleRoutesPanel.classList.contains('open');
    _sampleRoutesPanel.classList.toggle('open');
    _sampleRoutesBtn.classList.toggle('active', opening);
    if (opening) _renderSampleRouteList(_sampleList, { withHeading: false });
  });
  _sampleList.addEventListener('click', (e) => {
    const watchBtn = e.target.closest('.rp-sample-item-watch');
    if (watchBtn) {
      const sample = (Query.curatedRoutes || []).find(r => r.id === watchBtn.dataset.id);
      // Deliberately does NOT close/hide the Sample Routes panel — it
      // stays open through the whole movie and into the next one, per
      // the v650 "leave it up until I close it" fix.
      if (sample && !_movieRunning) {
        _movieRunning = true;
        _playRouteMovie(sample).finally(() => { _movieRunning = false; });
      }
      return;
    }
    const btn = e.target.closest('.rp-sample-item-main');
    if (!btn) return;
    const sample = (Query.curatedRoutes || []).find(r => r.id === btn.dataset.id);
    if (!sample) return;
    const route = _loadSampleRoute(sample);
    _sampleList.style.display = 'none';
    _buildRoutePickerPanel();
    const msg = `Loaded sample route "${route.name}".`;
    setStatus(msg);
    TTS.sayImmediate(msg);
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
      const name = wpt.querySelector('name')?.textContent?.trim() || WaypointsStorage.nextWaypointName();
      if (isNaN(lat) || isNaN(lon)) continue;
      const type = wpt.querySelector('extensions > type')?.textContent?.trim() || undefined;
      const note = wpt.querySelector('extensions > note')?.textContent?.trim() || undefined;
      saveUserWaypoint(name, lat, lon, type, note);
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

  // Same pipeline the Search box and the boat icon's own "Drop Pin" menu
  // item use (nextSearchPinName/saveUserWaypoint with type:'search') — a
  // real, addressable, draggable, renamable pin, just sourced from a
  // right-clicked map point instead of a typed query or the boat's own
  // position. The dropped pin's own popup already has "Autoroute from boat
  // position" (see _autoRouteFromBoatToHereFn) — no separate "Autoroute to
  // here" menu item needed alongside this one.
  document.getElementById('map-ctx-drop-pin').addEventListener('click', () => {
    _hideCtx();
    if (!_ctxLatLng) return;
    const msg = _dropMarkerAt(_ctxLatLng.lat, _ctxLatLng.lng);
    setStatus(msg);
    TTS.sayImmediate(msg);
  });
  // Where the mouse is over the map, for the "Set marker" voice command.
  _map.on('mousemove', (e) => { _mapPointerLatLng = e.latlng; });
  _map.on('mouseout', () => { _mapPointerLatLng = null; });

  // "Bring boat here" and "Set focus here" no longer live on this menu —
  // per direct request, right-click now only offers "Set marker here", and
  // every point-specific action moved to that marker's own popup instead
  // (see the navaid-popup template in _refreshWaypointLayer). "Set focus"
  // there calls Query.setFocus directly rather than porting over
  // _enterFocusPlaceMode's snap-while-dragging flow — that flow existed to
  // turn an anonymous tapped coordinate into a nameable point; a marker
  // already has both, so the direct call is the correct fit, not a
  // shortcut. _bringBoatTo (used by the popup's own "Bring boat here") is
  // still shared with the Waypoints-panel and Test-Set-popup call sites.

  _refreshWaypointLayer();
  _refreshTestSetLayer();
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
  const dot = L.marker([lat, lon], { icon: MarkerIcons.boatIcon(), draggable: true, zIndexOffset: 900 });

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
  // Fetch a fresh tide reading first if depths or soundings are enabled
  // (same sequence as clicking either checkbox), then render —
  // fire-and-forget so the map paint isn't blocked.
  const _depthOn = document.getElementById('nf-depth')?.checked
    || document.getElementById('nf-soundings')?.checked;
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
    const toIcon = MarkerIcons.navaidIcon(destType || 'place', color);
    const toMarker = L.marker([destLat, destLon], { icon: toIcon });
    if (destName) toMarker.bindTooltip(escapeHtml(destName), { permanent: true, direction: 'top', className: 'map-tooltip' });
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

// A hard zoom<14 cutoff used to hide every sounding dot below that level —
// direct report: the user turned Depths on, saw nothing at their normal
// zoom, and had no way to force them on regardless. Direct follow-up
// ("turning them all on, at will") ruled out thinning too: show every
// real charted sounding in view, at any zoom, no sampling. The safety net
// below is only a hang-prevention ceiling for a pathological worst case
// (a huge merged multi-region dataset fully zoomed out) — a real,
// previously-hit class of bug in this app (see the hazard-clustering
// O(n²) hang / DOM-count blowup) — not a practical limit under normal use;
// the real per-region sounding counts (tens of thousands total, already
// pre-thinned to ≤30m spacing at build time) stay well under it even at
// a wide viewport.
const MAX_SOUNDING_MARKERS = 5000;

function _refreshSoundingsLayer() {
  if (!_map) return;
  if (_soundingsLayer) { _map.removeLayer(_soundingsLayer); _soundingsLayer = null; }
  // Split out from the "Depths" (mudflat) checkbox into its own
  // toggle — direct request, default off (these render densely enough
  // to clutter the chart when not specifically wanted).
  if (!document.getElementById('nf-soundings')?.checked) return;
  if (!Query.soundings?.features?.length) return;
  const bounds = _map.getBounds().pad(0.1);
  const inView = Query.soundings.features.filter(f => {
    const [lon, lat] = f.geometry.coordinates;
    return bounds.contains([lat, lon]);
  });
  if (!inView.length) return;
  const stride = Math.max(1, Math.ceil(inView.length / MAX_SOUNDING_MARKERS));
  const markers = [];
  for (let i = 0; i < inView.length; i += stride) {
    const [lon, lat] = inView[i].geometry.coordinates;
    const charted = inView[i].properties.valsou;
    const eff = charted + _effectiveTideHeight();
    const effFt = (eff * 3.28084).toFixed(1);
    const color = _soundingColor(eff);
    markers.push(
      L.circleMarker([lat, lon], {
        radius: 4, color, fill: false, weight: 1.5, opacity: 0.8,
      }).bindTooltip(`${effFt} ft`, { className: 'map-tooltip', sticky: true })
    );
  }
  _soundingsLayer = L.layerGroup(markers).addTo(_map);
}

// Real S-57 chart data (CATLAM, verified populated 2026-09-28 against a
// live NOAA ENC cell — port-hand/starboard-hand/preferred-channel) tells
// us which side of a channel a lateral mark denotes. That alone isn't a
// complete instruction — it also depends on the conventional direction of
// buoyage, which for US waters is "red right returning" (inbound = from
// seaward toward harbor; buoy numbers ascend going inbound, the same
// convention, not a separate fact).
//
// Direct follow-up (2026-09-30): "my goal is for each buoy that refers
// to inbound and outbound, I know what direction they are referring
// to." Real gap, found by re-reading this function's own output: once
// a real bearing was known, the rotated arrow REPLACED the word
// entirely (see arrowOrWord below) — a bare spinning glyph with no
// text anywhere saying which way it points, or even that it's
// "inbound" vs "outbound" at all. Fixed by keeping the word AND the
// arrow, and adding the real compass direction in plain text (reusing
// Query.compassDir, the same primitive already used for Location &
// Context/Charted Hazard) — "Inbound (heading northwest)" rather than
// an icon alone the reader has to estimate an angle from. When no
// chain neighbor was found (ascendingBrg null — see
// _chainAscendingBearing's own comment on when that happens), stays
// honest that no direction is available rather than guessing one.
function _lateralMarkGuidanceHtml(catlam, objtype, ascendingBrg, computedGuess) {
  // computedGuess (from _computeLikelyInboundOutbound, below): 'inbound',
  // 'outbound', or null. When set, bolds the currently-applicable line and
  // adds a one-line caption — an ADDITION, never a replacement: both
  // directions always stay stated in full, since this is a best-guess
  // from the boat's current heading, not a certainty (see that function's
  // own comment for why it can be wrong, and why it stays conservative).
  const activeLine = (dir) => computedGuess === dir ? ' active' : '';
  const hintHtml    = computedGuess
    ? '<div class="navaid-side-hint">Based on your current heading</div>' : '';
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const arrowOrWord = (brgDeg, word) => {
    const label = capitalize(word);
    if (brgDeg == null) return `${label} (direction not available):`;
    const dir = Query.compassDir(brgDeg);
    return `<span class="navaid-side-arrow" style="transform:rotate(${Math.round(brgDeg)}deg)">&#8593;</span> `
      + `${label} <span class="navaid-side-dir">(heading ${dir})</span>:`;
  };

  if (catlam === 'port-hand' || catlam === 'starboard-hand') {
    const inboundBrg  = ascendingBrg;
    const outboundBrg = ascendingBrg == null ? null : (ascendingBrg + 180) % 360;
    // For a port-hand mark, "leave to port" IS the inbound rule; for a
    // starboard-hand mark it's the outbound rule (and vice versa) — the
    // two lines' TEXT stays fixed (Port, then Starboard), only which
    // arrow/guess-highlight attaches to which line flips with catlam.
    const portBrg      = catlam === 'port-hand' ? inboundBrg  : outboundBrg;
    const starboardBrg = catlam === 'port-hand' ? outboundBrg : inboundBrg;
    const portGuess      = catlam === 'port-hand' ? 'inbound' : 'outbound';
    const starboardGuess = catlam === 'port-hand' ? 'outbound' : 'inbound';
    const cls = catlam === 'port-hand' ? 'port' : 'starboard';
    return `<div class="navaid-popup-side ${cls}">
      <div class="navaid-side-line${activeLine(portGuess)}">${arrowOrWord(portBrg, portGuess)} Leave to PORT</div>
      <div class="navaid-side-line${activeLine(starboardGuess)}">${arrowOrWord(starboardBrg, starboardGuess)} Leave to STARBOARD</div>
      ${hintHtml}
    </div>`;
  }
  if (catlam === 'preferred-channel-starboard') {
    return '<div class="navaid-popup-side junction">&#9888; Junction — preferred channel to STARBOARD (inbound)</div>';
  }
  if (catlam === 'preferred-channel-port') {
    return '<div class="navaid-popup-side junction">&#9888; Junction — preferred channel to PORT (inbound)</div>';
  }
  // A BOYSAW (safe-water/mid-channel mark) has no lateral side at all —
  // by design it's safe to pass on either side — a real, different, and
  // useful fact worth stating plainly rather than just omitting the box
  // a lateral mark would otherwise get here.
  if (objtype === 'BOYSAW') {
    return '<div class="navaid-popup-side safewater">&#9679; Safe water — pass on either side</div>';
  }
  return '';
}

// The real compass bearing of "ascending" (inbound, by chart convention —
// buoy numbers ascend inbound, a fixed national rule, not per-channel
// data) at THIS specific mark: find another real charted buoy/beacon in
// the same numbered chain (e.g. "Wheeler Bay Buoy 1" / "...Buoy 3") within
// a reasonable radius and take the bearing toward increasing numbers.
// Returns null if no chain neighbor is found nearby — never guessed.
// Independent of the boat's own position/heading; this is a fixed
// property of the chart itself, used both to draw the popup's directional
// arrows (always, when available) and by _computeLikelyInboundOutbound
// (below) to compare against the boat's live heading.
function _chainAscendingBearing(name, lat, lon) {
  if (!name || !Query.navaids?.features) return null;
  const digitMatches = [...name.matchAll(/\d+/g)];
  if (!digitMatches.length) return null;
  const lastMatch = digitMatches[digitMatches.length - 1];
  const selfNum = parseInt(lastMatch[0], 10);
  const chainKey = name.slice(0, lastMatch.index).trim().toLowerCase();

  const CHAIN_RADIUS_NM = 3.0;
  let lower = null, higher = null; // {num, lat, lon}, nearest on each side
  if (chainKey) {
    for (const f of Query.navaids.features) {
      if (f.properties.objtype !== 'BOYLAT' && f.properties.objtype !== 'BCNLAT') continue;
      const otherName = f.properties.name;
      if (!otherName || otherName === name) continue;
      const otherDigits = [...otherName.matchAll(/\d+/g)];
      if (!otherDigits.length) continue;
      const otherLastMatch = otherDigits[otherDigits.length - 1];
      const otherChainKey = otherName.slice(0, otherLastMatch.index).trim().toLowerCase();
      if (otherChainKey !== chainKey) continue;
      const otherNum = parseInt(otherLastMatch[0], 10);
      if (otherNum === selfNum) continue;
      const [olon, olat] = f.geometry.coordinates;
      if (Query.distanceNm(lon, lat, olon, olat) > CHAIN_RADIUS_NM) continue;
      if (otherNum < selfNum && (!lower || otherNum > lower.num)) lower = { num: otherNum, lat: olat, lon: olon };
      if (otherNum > selfNum && (!higher || otherNum < higher.num)) higher = { num: otherNum, lat: olat, lon: olon };
    }
  }
  if (lower || higher) {
    if (lower && higher) return Query.bearing(lower.lon, lower.lat, higher.lon, higher.lat);
    if (higher)           return Query.bearing(lon, lat, higher.lon, higher.lat);
    return Query.bearing(lower.lon, lower.lat, lon, lat);
  }

  // Fallback (2026-09-30), direct request: "every buoy seems to know
  // what's inbound and outbound, I would like to know too." Real finding
  // checked directly against Eggemoggin Reach's own data: NOAA often
  // names each buoy for the specific hazard it marks (e.g. "Pumpkin
  // Island Ledge Buoy 27," "Thrumcap Ledge Buoy 28") rather than a
  // shared channel name — but the NUMBERS still run as one real,
  // continuous, alternating red/green sequence for the whole passage
  // (verified: Eggemoggin Reach runs 1→33 straight through, mixing many
  // different hazard names). Exact-name chain-matching above is blind to
  // this. Falls back to the nearest OTHER lateral mark of ANY name
  // within a real, verified radius whose number is within 2 of this
  // one's — checked bay-wide before shipping: of 402 real lateral marks'
  // nearest-neighbor pairs, 295 have a number difference of 2 or less
  // (a real sequence signal) vs. 41 with a bigger jump that are
  // genuinely different, unrelated nearby marks (correctly excluded by
  // this same threshold, e.g. "Fox Island Thorofare Buoy 27" 0.38nm from
  // the unrelated "Inner Bay Ledges Buoy 7").
  return _sequenceNeighborBearing(name, selfNum, lat, lon);
}

function _sequenceNeighborBearing(name, selfNum, lat, lon) {
  const LINK_MAX_NM = 1.0;
  const MAX_NUM_DIFF = 2;
  let best = null, bestDist = Infinity;
  for (const f of Query.navaids.features) {
    if (f.properties.objtype !== 'BOYLAT' && f.properties.objtype !== 'BCNLAT') continue;
    const otherName = f.properties.name;
    if (!otherName || otherName === name) continue;
    const otherDigits = [...otherName.matchAll(/\d+/g)];
    if (!otherDigits.length) continue;
    const otherNum = parseInt(otherDigits[otherDigits.length - 1][0], 10);
    if (otherNum === selfNum || Math.abs(otherNum - selfNum) > MAX_NUM_DIFF) continue;
    const [olon, olat] = f.geometry.coordinates;
    const d = Query.distanceNm(lon, lat, olon, olat);
    if (d > LINK_MAX_NM || d >= bestDist) continue;
    bestDist = d; best = { num: otherNum, lat: olat, lon: olon };
  }
  if (!best) return null;
  return best.num > selfNum
    ? Query.bearing(lon, lat, best.lon, best.lat)
    : Query.bearing(best.lon, best.lat, lon, lat);
}

// Best-guess "which direction are you currently heading" for a lateral
// mark's port/starboard pair, computed from the boat's live GPS course
// compared against _chainAscendingBearing (above) — NOT from any stored
// "which way is the harbor" fact (none exists; see
// _lateralMarkGuidanceHtml's own comment on why CATLAM alone can't say
// this).
//
// Deliberately conservative — returns null (no guess shown) rather than
// a low-confidence one, whenever: no GPS heading, no chain neighbor
// found nearby, or the heading is too close to perpendicular to the
// chain to call confidently (a wrong CONFIDENT answer here is actively
// dangerous, not just unhelpful — worse than showing nothing extra).
function _computeLikelyInboundOutbound(catlam, name, lat, lon) {
  if (catlam !== 'port-hand' && catlam !== 'starboard-hand') return null;
  const pos = GPS.getPosition();
  if (!pos || pos.heading == null) return null;
  const ascendingBrg = _chainAscendingBearing(name, lat, lon);
  if (ascendingBrg == null) return null;

  let diff = Math.abs(pos.heading - ascendingBrg) % 360;
  if (diff > 180) diff = 360 - diff;
  const CONFIDENT_MARGIN_DEG = 20; // stay silent within ~20° of perpendicular
  if (diff < 90 - CONFIDENT_MARGIN_DEG) return 'inbound';
  if (diff > 90 + CONFIDENT_MARGIN_DEG) return 'outbound';
  return null;
}

// Plain-language "what this actually is" line — shape + colour +
// (for LIGHTS) characteristic — the physical description a mariner
// checks by eye to confirm they've found the right mark. Was previously
// only available in the marker's hover tooltip, a separate interaction;
// direct request was for the popup itself to be a complete, readable
// card, not split across two UI surfaces.
function _navaidIdentityHtml(n) {
  const parts = [];
  if (n.colour) parts.push(n.colour.charAt(0).toUpperCase() + n.colour.slice(1));
  if (n.shape) parts.push(n.shape);
  let line = parts.join(' ');
  if (n.characteristic) line = line ? `${line}, ${n.characteristic}` : n.characteristic;
  if (!line) return '';
  return `<div class="navaid-popup-identity">${line}</div>`;
}

// Direct follow-up (2026-09-29): "not working... forget the arrows...
// don't show them on the screen. For each buoy when I click on it I
// want to see the full information about how to pass it, and other
// incidental advice." Replaces the on-map channel arrows (v738-744)
// entirely with a richer tap popup. The user also asked, mid-build:
// "can't you get the source of truth from the chart supplier?" — yes:
// S-57's own INFORM attribute carries real per-aid remarks straight
// from NOAA/USCG (e.g. "East of shoal," "On spindle," "Seasonal aid:
// replaced by can when endangered by ice"), extracted into navaid.geojson
// this same release (see preprocess/s57_to_geojson.py). Verified
// directly against real downloaded ENC cells: populated on ~15% of real
// navaid features bay-wide (83 of 504 in this region) — shown here
// verbatim, visually distinct (see .navaid-popup-official), since it's
// the one line in this popup NOT computed by this app.
function _navaidOfficialRemarkHtml(inform) {
  if (!inform) return '';
  const safe = inform.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<div class="navaid-popup-row">
    <div class="navaid-popup-row-label">Official Chart Remark</div>
    <div class="navaid-popup-official">${safe}</div>
  </div>`;
}

// "Location & Context" row — the two nearest REAL named places (any
// kind: ledge, cove, town, anchorage — from named_places.geojson),
// each stated as a real distance+compass-direction, reusing the exact
// same primitives (Query.compassDir/naturalDist/bearing) already
// verified and shipped in the app's own "Where am I" feature (see
// query.js's whereAmI/findNearestLandmark) — not a new, separately-
// unverified computation. Deliberately factual/terse rather than
// flowing prose ("off Iron Point, near North Haven") since inventing
// geographic-relationship adjectives (e.g. "northern," "just west of")
// beyond what real bearing math supports would be an unverified guess
// dressed as fact. Capped at 2nm — a place farther than that isn't real
// "context" for THIS specific mark.
function _navaidLocationContextHtml(lat, lon) {
  const places = Query.namedPlaces?.features;
  if (!places) return '';
  const LOCAL_RADIUS_NM = 2.0;
  const withDist = [];
  for (const f of places) {
    const name = f.properties?.name;
    if (!name || f.geometry?.type !== 'Point') continue;
    const [flon, flat] = f.geometry.coordinates;
    const d = Query.distanceNm(lon, lat, flon, flat);
    if (d > LOCAL_RADIUS_NM) continue;
    withDist.push({ name, dist: d, lat: flat, lon: flon });
  }
  withDist.sort((a, b) => a.dist - b.dist);
  const top = withDist.slice(0, 2);
  if (!top.length) return '';
  const phrases = top.map((p) => {
    const brg = Query.bearing(p.lon, p.lat, lon, lat); // FROM place TOWARD this navaid
    const dir = Query.compassDir(brg);
    return `${Query.naturalDist(p.dist)} ${dir} of ${p.name}`;
  });
  return `<div class="navaid-popup-row">
    <div class="navaid-popup-row-label">Location &amp; Context</div>
    <div class="navaid-popup-row-value">${phrases.join('; ')}</div>
  </div>`;
}

// Direct follow-up (2026-09-29): "what these buoys are FOR — have we
// exhausted all information about them?" The one real gap: Query.hazards
// (11,938 real charted features bay-wide) was never cross-referenced
// against navaids at all, despite already being loaded. Searches only
// POINT hazards (UWTROC/OBSTRN/WRECKS/CBLOHD — real rocks, obstructions,
// wrecks, submarine cables) — matches _refreshNavaidOverlay's own
// existing convention of skipping DEPARE polygons (shown separately by
// the Depths layer), NOT query.js's nearestHazard, which destructures
// geometry.coordinates assuming a Point and would silently break on a
// polygon. Capped at 0.5nm, verified against real bay-wide distances
// (buoys typically sit 0.02-0.35nm from what they mark) — beyond that
// it's not really "what this buoy is for," so the row is omitted
// entirely rather than citing an irrelevant hazard. Only 19 of 11,938
// hazards bay-wide carry a real name (verified) — most hits state type
// + charted depth, not a name; that's an honest data limitation, not a
// bug, and never papered over with invented specificity.
function _navaidChartedHazardHtml(lat, lon) {
  const hazards = Query.hazards?.features;
  if (!hazards) return '';
  const MAX_NM = 0.5;
  const TYPE_LABEL = { UWTROC: 'underwater rock', OBSTRN: 'obstruction', WRECKS: 'wreck', CBLOHD: 'submarine cable' };
  let best = null, bestDist = Infinity, bestBrg = null;
  for (const f of hazards) {
    if (f.geometry?.type !== 'Point') continue;
    if (!TYPE_LABEL[f.properties?.objtype]) continue;
    const [flon, flat] = f.geometry.coordinates;
    const d = Query.distanceNm(lon, lat, flon, flat);
    if (d > MAX_NM || d >= bestDist) continue;
    bestDist = d; best = f; bestBrg = Query.bearing(flon, flat, lon, lat);
  }
  if (!best) return '';
  const typeLabel = TYPE_LABEL[best.properties.objtype];
  const name = best.properties.name;
  const depth = best.properties.valsou;
  const depthPhrase = (typeof depth === 'number') ? `, charted depth ${depth}ft` : '';
  const dir = Query.compassDir(bestBrg);
  const what = name ? `${name} (${typeLabel}${depthPhrase})` : `${typeLabel}${depthPhrase}`;
  return `<div class="navaid-popup-row">
    <div class="navaid-popup-row-label">Charted Hazard</div>
    <div class="navaid-popup-row-value">Marks ${what}, ${Query.naturalDist(bestDist)} ${dir}</div>
  </div>`;
}

// STATUS/PERSTA/PEREND — real S-57 attributes, verified against the
// local GDAL S-57 attribute catalog and real downloaded chart data (see
// STATUS_LABEL's own comment in preprocess/s57_codes.py). "permanent" is
// the overwhelming real-world default (531 of 749 real features
// bay-wide) — deliberately silent about it, since stating the
// unremarkable case on every single popup would just be noise;
// surfaces only the genuinely different facts (intermittent, private)
// and any real seasonal in-place date range.
function _navaidStatusHtml(status, persta, perend) {
  const parts = [];
  if (status && status !== 'permanent') {
    // status may itself be a single compound S-57 term containing a
    // literal "/" (e.g. "periodically/intermittent" is ONE code's
    // label, not two statuses) as well as "/"-joined MULTIPLE real
    // codes (e.g. a mark that's both periodically/intermittent AND
    // private) — either way this is one phrase, capitalize only its
    // first letter rather than treating every "/" as a boundary.
    parts.push(status.charAt(0).toUpperCase() + status.slice(1));
  }
  const fmtDate = (mmdd) => {
    // Real chart format: "--MMDD" (leading "--" = no year component)
    const m = /^--(\d{2})(\d{2})$/.exec(mmdd || '');
    if (!m) return null;
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mi = parseInt(m[1], 10) - 1;
    return MONTHS[mi] ? `${MONTHS[mi]} ${parseInt(m[2], 10)}` : null;
  };
  const startD = fmtDate(persta), endD = fmtDate(perend);
  if (startD && endD) parts.push(`In place ${startD} – ${endD}`);
  if (!parts.length) return '';
  return `<div class="navaid-popup-row">
    <div class="navaid-popup-row-label">Status</div>
    <div class="navaid-popup-row-value">${parts.join(' · ')}</div>
  </div>`;
}

// Direct request (2026-09-30), reintroducing on-map arrows after v745
// removed them: "geometrically accurate" — one arrow per CONSECUTIVE
// buoy pair, each pointing in that specific segment's own real
// ascending/inbound bearing, rather than one straight arrow per whole
// named channel (which can't stay accurate along a real curve —
// verified earlier this session that Fox Island Thorofare's consecutive
// bearings shift 109°->257°->204°->235° along its own length).
//
// Direct follow-up (2026-09-30): originally grouped by exact chain name
// (name with the trailing number stripped), matching
// _chainAscendingBearing's ORIGINAL logic — but that's blind to real
// channels where NOAA names each buoy for its own specific hazard
// rather than a shared channel name (verified: Eggemoggin Reach runs a
// real, continuous, alternating red/green 1->33 sequence straight
// through many different hazard names). Now uses the SAME unified
// number+proximity matching _chainAscendingBearing itself falls back to
// — nearest OTHER lateral mark within 1.0nm whose number is within 2 of
// this one's (verified bay-wide: 295 of 402 real marks' nearest
// neighbors have a number difference of 2 or less, a real sequence
// signal; 41 with a bigger jump are genuinely unrelated nearby marks,
// correctly excluded).
function _findInboundChainPairs() {
  if (!Query.navaids?.features) return [];
  const marks = [];
  for (const f of Query.navaids.features) {
    if (f.properties.objtype !== 'BOYLAT' && f.properties.objtype !== 'BCNLAT') continue;
    const name = f.properties.name;
    if (!name) continue;
    const digitMatches = [...name.matchAll(/\d+/g)];
    if (!digitMatches.length) continue;
    const num = parseInt(digitMatches[digitMatches.length - 1][0], 10);
    const [lon, lat] = f.geometry.coordinates;
    marks.push({ num, lat, lon });
  }
  const LINK_MAX_NM = 1.0;   // verified real max consecutive-buoy spacing (Fox Island Thorofare)
  const MAX_NUM_DIFF = 2;    // verified real signal threshold (see this function's own comment)
  const seen = new Set();
  const pairs = [];
  for (let i = 0; i < marks.length; i++) {
    const a = marks[i];
    let best = null, bestDist = Infinity, bestIdx = -1;
    for (let j = 0; j < marks.length; j++) {
      if (i === j) continue;
      const b = marks[j];
      if (b.num === a.num || Math.abs(b.num - a.num) > MAX_NUM_DIFF) continue;
      const d = Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
      if (d > LINK_MAX_NM || d >= bestDist) continue;
      bestDist = d; best = b; bestIdx = j;
    }
    if (!best) continue;
    const key = i < bestIdx ? `${i}|${bestIdx}` : `${bestIdx}|${i}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lower = a.num < best.num ? a : best;
    const higher = a.num < best.num ? best : a;
    pairs.push({ aLat: lower.lat, aLon: lower.lon, bLat: higher.lat, bLon: higher.lon,
                 brg: Query.bearing(lower.lon, lower.lat, higher.lon, higher.lat) });
  }
  return pairs;
}

// Plain single-headed arrow, no background box (the same visual
// language as the earlier, never-complained-about v740 style) — offset
// a small fixed SCREEN-pixel distance from its anchor point along brg,
// zoom-independent so it doesn't shrink to invisible at low zoom.
function _inboundArrowIcon(brg) {
  const PX_DIST = 14;
  const rad = brg * Math.PI / 180;
  const dx = PX_DIST * Math.sin(rad);
  const dy = -PX_DIST * Math.cos(rad);
  return L.divIcon({
    className: '',
    html: `<div class="navaid-inbound-arrow" style="transform:rotate(${Math.round(brg)}deg)">&#8593;</div>`,
    iconSize: [16, 16],
    iconAnchor: [8 - dx, 8 - dy],
  });
}

function _refreshNavaidOverlay() {
  if (!_map) return;
  if (_navaidFilterLayer) { _map.removeLayer(_navaidFilterLayer); _navaidFilterLayer = null; }

  // Buoys/Lights/Beacons were 3 separate toggles; combined into one
  // "Navaids" checkbox per direct request ("make them a settable
  // parameter" — singular) since all 3 always defaulted on together
  // anyway and nothing in practice needed them split.
  const types = new Set();
  if (document.getElementById('nf-navaids')?.checked) { types.add('buoy'); types.add('light'); types.add('beacon'); }
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
                  name: f.properties.name, characteristic: f.properties.characteristic,
                  catlam: f.properties.catlam, shape: f.properties.shape,
                  objtype: f.properties.objtype, chart: f.properties.chart,
                  inform: f.properties.inform, status: f.properties.status,
                  persta: f.properties.persta, perend: f.properties.perend };
      const m = L.marker([lat, lon], { icon: MarkerIcons.navaidMarkerIcon(n) });
      const tip = [n.name, n.characteristic || n.colour].filter(Boolean).join(' — ');
      if (tip) m.bindTooltip(tip, { permanent: false, direction: 'top', className: 'map-tooltip' });

      // Tap/click → full info popup (v745, replacing the on-map arrows —
      // see _navaidOfficialRemarkHtml's own comment). The side box is
      // filled in on popupopen (below), not here — it depends on the
      // boat's LIVE heading, which can be stale by the time a user
      // actually taps a marker that was rendered on an earlier refresh.
      // Location/official-remark rows are static per-mark facts, computed
      // once here instead.
      const safeName = (n.name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const identityHtml = _navaidIdentityHtml(n);
      const officialHtml = _navaidOfficialRemarkHtml(n.inform);
      const hazardHtml = _navaidChartedHazardHtml(lat, lon);
      const locationHtml = _navaidLocationContextHtml(lat, lon);
      const statusHtml = _navaidStatusHtml(n.status, n.persta, n.perend);
      // No "Navigation Rule" section at all for a plain LIGHTS/other
      // unclassified navaid — _lateralMarkGuidanceHtml returns '' for
      // those (no port/starboard/junction/safe-water side exists to
      // state), and an empty labeled row would just be a floating
      // heading over nothing.
      const guidanceHtml = _lateralMarkGuidanceHtml(n.catlam, n.objtype);
      const navRuleHtml = guidanceHtml
        ? `<div class="navaid-popup-row">
             <div class="navaid-popup-row-label">Navigation Rule</div>
             <div class="navaid-popup-side-slot">${guidanceHtml}</div>
           </div>`
        : '';
      m.bindPopup(
        `<div class="navaid-popup">
           <div class="navaid-popup-name">${safeName}</div>
           ${identityHtml}
           ${officialHtml}
           ${hazardHtml}
           ${locationHtml}
           ${statusHtml}
           ${navRuleHtml}
           <button class="navaid-popup-brg">Range &amp; bearing</button>
           <button class="navaid-popup-focus">&#127919; Set focus</button>
           <button class="navaid-popup-copy">Copy name</button>
           <button class="navaid-popup-copy-loc">Copy location</button>
         </div>`,
        { maxWidth: 260, className: 'navaid-popup-wrapper' }
      );
      m.on('popupopen', (e) => {
        const el = e.popup.getElement();
        const slot = el.querySelector('.navaid-popup-side-slot');
        if (slot) {
          const ascendingBrg = _chainAscendingBearing(n.name, lat, lon);
          const guess = _computeLikelyInboundOutbound(n.catlam, n.name, lat, lon);
          slot.innerHTML = _lateralMarkGuidanceHtml(n.catlam, n.objtype, ascendingBrg, guess);
        }
        el.querySelector('.navaid-popup-brg').addEventListener('click', () => {
          _map.closePopup();
          // Use exact coordinates — bypasses the parser's alias system which
          // mangles names like "Thorofare" or "Rockland" into wrong places.
          const pos = GPS.getPosition();
          if (!pos) {
            const msg = 'No GPS fix yet.';
            showResponse(msg); TTS.sayImmediate(msg); return;
          }
          const result = Query.bearingToResolvedPlace(pos.lat, pos.lon, lat, lon, n.name,
            _followingRouteId ? { keepFocus: true } : undefined);
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
        // Decimal degrees — most portable for pasting into another maps
        // app, GPS/chartplotter waypoint entry, or a text message; the
        // on-screen DM format (formatPositionDisplay) is for reading,
        // this is for round-tripping into something else.
        el.querySelector('.navaid-popup-copy-loc').addEventListener('click', (evt) => {
          navigator.clipboard.writeText(`${lat.toFixed(6)}, ${lon.toFixed(6)}`).catch(() => {});
          const btn = evt.currentTarget;
          btn.textContent = '✓ Copied';
          setTimeout(() => { btn.textContent = 'Copy location'; }, 1200);
        });
      });

      markers.push(m);
    }
  }

  // One "Inbound" arrow per real consecutive same-chain buoy pair — see
  // _findInboundChainPairs's own comment. Zoom-gated below 13 — real
  // gate-tight pairs in this same data were verified earlier this
  // session to be only 40-170m apart, a handful of screen pixels at low
  // zoom, reading as clutter rather than a placement problem.
  if (types.size > 0 && _map.getZoom() >= 13) {
    for (const { aLat, aLon, bLat, bLon, brg } of _findInboundChainPairs()) {
      const midLat = (aLat + bLat) / 2, midLon = (aLon + bLon) / 2;
      if (!bounds.pad(0.1).contains([midLat, midLon])) continue;
      markers.push(L.marker([midLat, midLon], {
        icon: _inboundArrowIcon(brg),
        interactive: true, keyboard: false,
      }).bindTooltip('Inbound', { permanent: false, direction: 'top', className: 'map-tooltip' }));
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
    HazardClustering.renderClusteredHazards(_map, hazardLayer, hazardPts, (h) => {
      const m = L.marker([h.lat, h.lon], { icon: MarkerIcons.hazardMarkerIcon() });
      m.bindTooltip(h.name, { permanent: false, direction: 'top', className: 'map-tooltip' });
      return m;
    });
    markers.push(hazardLayer);
  }

  // Direct report: toggling Depths with no boat draft set produced total
  // silence — the heat-layer block below is draft-gated (needs a number to
  // compute effective clearance against) and was failing that check with
  // no feedback at all, reading as "broken" rather than "needs one more
  // field filled in". A dedicated element, not a repurposed #nf-tide-status
  // — that one's legitimately updated by _fetchTideHeight far less often
  // than this function runs (every pan/zoom), so clearing/setting it HERE
  // on every refresh would just as often stomp a real tide reading right
  // back out. This one only ever says one thing, so it's always safe to
  // set it unconditionally on every call — no stale leftover text possible
  // once a draft is actually entered (confirmed live: an earlier version
  // that reused #nf-tide-status left the hint showing even after typing a
  // real draft value, since nothing ever cleared it back out).
  const _depthDraftHint = document.getElementById('nf-draft-hint');
  if (_depthDraftHint) {
    _depthDraftHint.textContent = (showDepths && _getDraftMeters() == null)
      ? 'Set your boat draft above to see this overlay.'
      : '';
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
      // Direct requirement (2026-09-27): always keep at least this much
      // clear water under the keel — matching constant in router.js/
      // query.js's own hazard-blocking checks, so a cell shown red here
      // is exactly a cell AutoRoute will actually avoid, not a narrower
      // "technically doesn't touch bottom" reading.
      const KEEL_CLEARANCE_MARGIN_M = 3 * 0.3048; // 3ft
      // _getComfortMarginMeters() is the user-settable "yellow caution"
      // cutoff (Comfortable clearance margin setting, v722, default 3ft —
      // same value the shallow-area warning triangle and nudge-offshore
      // feature use). At the default it's numerically equal to
      // KEEL_CLEARANCE_MARGIN_M, so the yellow band collapses to zero width
      // (only red/no-color show) unless the setting is raised above 3ft.
      const comfortM = _getComfortMarginMeters();
      const polyFeatures = [];
      for (const f of Query.depthZones) {
        const eff = (f.properties.valsou ?? 0) + _effectiveTideHeight();
        if (eff <= 0) continue;  // exposed/dry at current tide — not a navigable hazard
        let color = null;
        if (eff <= draftM + KEEL_CLEARANCE_MARGIN_M) color = '#e05252';
        else if (eff < draftM + comfortM)             color = '#f5c518';
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
    const marker = L.marker([n.lat, n.lon], { icon: MarkerIcons.navaidMarkerIcon(n) });
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
  HazardClustering.renderClusteredHazards(_map, hazardLayer, hazardPts, (h) => {
    const marker = L.marker([h.lat, h.lon], { icon: MarkerIcons.hazardMarkerIcon() });
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
  HazardClustering.renderClusteredHazards(_map, hazardLayer, hazardPts || [], (h) => {
    const m = L.marker([h.lat, h.lon], { icon: MarkerIcons.hazardMarkerIcon() });
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
  'virtual':       'VIRTUAL JOURNEY',
  'browser':       'DEVICE GPS',
  'nmea':          'GPS PUCK',
  'opencpn-nmea':  'OPENCPN LIVE',
  'opencpn-ini':   'OPENCPN',
  'opencpn-track': 'OPENCPN TRACK',
  'default':       'DEMO POSITION',
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
// Kept separate from _coverageLastAnnounced (below): this one updates the
// on-screen badge immediately and always, even during the untrustworthy
// startup window described there.
let _coverageLevel = null;

// What we've actually told the user out loud, and whether the app's very
// first coverage read is trustworthy yet — see _updateCoverageStatus's own
// comment for the real bug this fixes (a routine in-coverage start could
// speak a false "Limited chart data" warning, then a confusing "Chart data
// available" recovery right after, purely from hazard/navaid/named-place
// data not having finished loading yet when the very first GPS fix landed).
let _coverageLastAnnounced  = null;
let _coverageStartupSettled = false;

const COVERAGE_MESSAGES = {
  land: 'Limited chart data here — land avoidance only, no hazard or navaid detail. Auto Route and Re-route are unavailable; Sketch still works.',
  none: 'No chart data for this area. Auto Route, Re-route, and hazard checking are unavailable here; Sketch still works but is not checked against real charts.',
};

// ── Region auto-detection (coverage-none recovery) ──────────────────────────
// Each CRUISE_PROFILES region (and the bundled default) ships a tiny
// chart_bounds.geojson rectangle — cheap enough to fetch for all of them
// just to answer "which region, if any, actually covers this position,"
// independent of whichever region's full chart data happens to be loaded
// right now. '' is used as the bundled-default region's id throughout this
// block (matching Query.getActiveRegion()'s null-means-default convention,
// coerced to '' so it works as a plain object/Map key).
let _regionBoundsCache = null; // { '' : bbox|null, 'penobscot-bay': bbox|null, ... }
const _regionOfferBanner   = document.getElementById('region-offer-banner');
const _regionOfferText     = document.getElementById('region-offer-text');
const _regionOfferDownload = document.getElementById('region-offer-download-btn');
const _regionOfferDismiss  = document.getElementById('region-offer-dismiss-btn');
let _regionOfferCruiseName = null;
let _regionOfferSwitchOnly = false;
let _regionOfferRegionId   = null;

function _regionIdFor(cruiseName) {
  return CRUISE_PROFILES[cruiseName]?.dataUrl?.match(/regions\/([^/]+)\.json$/)?.[1] || null;
}

async function _fetchChartBounds(regionId) {
  try {
    const path = regionId ? `./data/regions/${regionId}/chart_bounds.geojson` : './data/chart_bounds.geojson';
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) return null;
    const ring = (await r.json()).features?.[0]?.geometry?.coordinates?.[0];
    if (!ring) return null;
    const lons = ring.map(c => c[0]), lats = ring.map(c => c[1]);
    return { minLon: Math.min(...lons), maxLon: Math.max(...lons), minLat: Math.min(...lats), maxLat: Math.max(...lats) };
  } catch (_) { return null; }
}

/** regionId ('' = bundled default) whose chart_bounds contains (lat, lon),
 * or null if none of the known regions do. Bounds are tiny and fetched once
 * per session, not re-fetched on every GPS tick. Checks specific (named)
 * regions BEFORE the bundled default — real bug found live (2026-09-27):
 * the bundled default's own chart_bounds.geojson covers essentially the
 * same box as Penobscot Bay's (both ~-69.32..-68.00, 43.75..44.83), so
 * checking '' first (its old iteration order) meant this function always
 * returned '' and a real, richer named region was never reached even when
 * the position was squarely inside it too. Prefer the more specific match. */
async function _regionContaining(lat, lon) {
  if (!_regionBoundsCache) {
    _regionBoundsCache = {};
    const ids = ['', ...Object.keys(_visibleCruiseProfiles()).map(_regionIdFor).filter(Boolean)];
    await Promise.all(ids.map(async (id) => { _regionBoundsCache[id] = await _fetchChartBounds(id); }));
  }
  const orderedIds = Object.keys(_regionBoundsCache).filter(id => id !== '').concat(['']);
  for (const id of orderedIds) {
    const b = _regionBoundsCache[id];
    if (b && lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat) return id;
  }
  return null;
}

// switchOnly=true: the target region is already downloaded (bundled
// default or previously fetched) — a free, instant, offline-safe switch,
// but per direct confirmed regression, "free" is not the same as
// "wanted right now": one tap always required, never automatic.
function _showRegionOfferBanner(cruiseName, { switchOnly = false, regionId = null } = {}) {
  _regionOfferCruiseName = cruiseName;
  _regionOfferSwitchOnly = switchOnly;
  _regionOfferRegionId = regionId;
  _regionOfferText.textContent = switchOnly
    ? `You're near ${cruiseName} — switch chart data to it?`
    : `You're near ${cruiseName} — chart data for it isn't downloaded yet.`;
  _regionOfferDownload.textContent = switchOnly ? '⇄ Switch' : '⬇ Download';
  _regionOfferBanner.style.display = 'flex';
}
function _hideRegionOfferBanner() {
  _regionOfferBanner.style.display = 'none';
  _regionOfferCruiseName = null;
  _regionOfferSwitchOnly = false;
  _regionOfferRegionId = null;
}
// Confirmed live as a real bug: this used to hide the banner immediately
// and let runRouteDownload run in the background, whose only progress
// feedback is routeBtn's text (a small button in the top status row, far
// from this banner) and setStatus (writes to a permanently-hidden
// element — no visible feedback at all on its own). From here it looked
// exactly like tapping Download did nothing. Now the banner stays up and
// mirrors every progress message directly where the user just tapped.
//
// _regionOfferDownloading guards against a SECOND real bug found chasing
// the first one down live: runRouteDownload's own progress calls
// Query.loadData(), which lets _updateCoverageStatus recompute — and once
// the new region's land/hazards actually load, coverage genuinely recovers
// mid-download (before the satellite-tile/tide-current loops even start),
// which unconditionally hid this exact banner. So the banner would vanish
// a few hundred ms into a download that was still actively running,
// silently, in the background — indistinguishable from "the button did
// nothing," just for a different reason than the first bug. This flag
// tells _updateCoverageStatus's auto-hide to stand down while a download
// started from this banner is still in flight.
let _regionOfferDownloading = false;
_regionOfferDownload.addEventListener('click', async () => {
  const cruiseName = _regionOfferCruiseName;
  if (!cruiseName) return;
  if (_regionOfferSwitchOnly) {
    const regionId = _regionOfferRegionId;
    _hideRegionOfferBanner();
    Query.setActiveRegion(regionId || null);
    await Query.loadData(null, null);
    dataLoaded = true;
    const msg = `Switched to ${cruiseName} chart data.`;
    setStatus(msg);
    TTS.sayImmediate(msg);
    const pos = GPS.getPosition();
    if (pos) _updateCoverageStatus(pos.lat, pos.lon);
    _refreshNavaidOverlay(); // otherwise the OLD region's navaids stay on screen after a switch
    return;
  }
  _regionOfferDownload.disabled = true;
  _regionOfferDismiss.disabled = true;
  _regionOfferDownloading = true;
  let lastMsg = '';
  await runRouteDownload(cruiseName, (msg) => { lastMsg = msg; _regionOfferText.textContent = msg; });
  _regionOfferDownloading = false;
  _regionOfferDownload.disabled = false;
  _regionOfferDismiss.disabled = false;
  // A failure message stays up for the user to actually read and dismiss
  // manually; success auto-clears itself after a moment.
  if (!lastMsg.startsWith('Download failed')) {
    setTimeout(() => { if (_regionOfferCruiseName === cruiseName) _hideRegionOfferBanner(); }, 2000);
  }
});
_regionOfferDismiss.addEventListener('click', _hideRegionOfferBanner);

// Direct request (2026-09-27), knowingly reversing the "never automatic"
// decision documented on _offerRegionForPosition below: when the boat's
// position sits inside a real region's bounds and that region isn't the
// active one, switch to it automatically — no tap. Deliberately NOT
// gated on Query.isRegionDownloaded (unlike _offerRegionForPosition's own
// banner choice) — that check is about whether a full offline package
// was pre-cached via runRouteDownload (a real, heavier fetch worth
// consent for), not whether the region's core chart files are reachable
// at all. A region's land/hazards/channel/soundings files are ordinary
// bundled static assets, exactly as cheap to fetch as the bundled
// default's — loadData()'s own per-file fetches already fail gracefully
// (falling back to bundled-default geometry) if genuinely offline and
// uncached, so there's nothing here that needs gating behind a tap.
// Still guarded against the exact regression that motivated the original
// manual-only decision (a silent switch mid-edit corrupting a route being
// worked on for a different area): skipped while editing/sketching/
// drawing. Always updates the title-bar region label regardless of
// whether a switch happens, so the active region is never silently wrong
// on screen — confirmed live this same day that _activeRegion being
// unexpectedly null was otherwise invisible short of inspecting devtools.
let _lastAutoRegionId = undefined; // regionId last auto-switched to; avoids redundant re-switch work on every GPS tick
async function _autoSelectRegionForPosition(lat, lon) {
  const regionId = await _regionContaining(lat, lon);
  const activeId = Query.getActiveRegion() || '';

  if (regionId !== null && regionId !== activeId && !_editMode && !_sketchMode && !_drawMode
      && _lastAutoRegionId !== regionId) {
    _lastAutoRegionId = regionId;
    Query.setActiveRegion(regionId || null);
    await Query.loadData(null, null);
    const cruiseName = regionId ? Object.keys(CRUISE_PROFILES).find(n => _regionIdFor(n) === regionId) : null;
    const msg = `Switched to ${cruiseName || 'default'} chart data.`;
    setStatus(msg);
    const pos = GPS.getPosition();
    if (pos) _updateCoverageStatus(pos.lat, pos.lon);
    _refreshNavaidOverlay(); // otherwise the OLD region's navaids stay on screen after a switch
  }

  const displayId = Query.getActiveRegion() || '';
  const cruiseName = displayId ? Object.keys(CRUISE_PROFILES).find(n => _regionIdFor(n) === displayId) : null;
  _statusRegionLabel = `Region: ${cruiseName || 'default'}`;
  _renderStatusCombo();
}

// Called (fire-and-forget, from _updateCoverageStatus) whenever the boat's
// real position has no chart data at all under whatever's currently loaded.
// Three distinct situations look identical from coverageLevelAt's point of
// view but call for very different responses:
//   - genuinely outside every known region  -> explain the app's real
//     coverage area instead of an unexplained "no chart data" dead end
//     (this is the case a visitor far from Maine, e.g. in California, hits)
//   - inside the currently-active region's own bounds -> nothing to switch
//     to, this exact spot just has no data
//   - inside a DIFFERENT region (bundled default or a downloaded one) ->
//     offer to switch, whether or not it needs a real download. Confirmed
//     live as a real regression: this used to silently auto-switch when
//     the target region was already downloaded/free, on the reasoning that
//     a free switch needs no confirmation — but "free" only measures
//     network cost, not disruption. A real GPS position (e.g. this
//     device's actual location) repeatedly, silently swapping the active
//     region out from under someone deliberately editing/planning a route
//     for a DIFFERENT area corrupted that route (routing silently lost
//     access to the right region's channel graph) with no visible cause.
//     Every switch is now one tap, never automatic, regardless of cost.
async function _offerRegionForPosition(lat, lon) {
  const regionId = await _regionContaining(lat, lon);
  const activeId = Query.getActiveRegion() || '';

  if (regionId === null) {
    // Genuinely outside every covered region almost always means a visitor
    // exploring the app from wherever they actually are (see this
    // function's header comment) rather than a real boat that's drifted out
    // of range — so rather than making them go find the Location button
    // themselves, just drop them at Rockland Harbor, the heart of Penobscot
    // Bay, so the app is immediately explorable. GPS.setManualPosition sets
    // the 'manual' source (highest priority — see gps.js's SOURCE_PRIORITY),
    // so this doesn't fight with a real GPS fix if one later arrives; it
    // simply takes over the same way an intentional Test Position would,
    // and re-enters this same position pipeline (showPosition ->
    // _updateCoverageStatus), which resolves to 'core' for Rockland and
    // updates the status/map on its own — no separate refresh needed here.
    // showPosition() itself never draws the boat icon (see _bringBoatTo for
    // the established convention) — _showBoatPosition is the separate call
    // that actually puts the marker on the map.
    GPS.setManualPosition(44.103, -69.088);
    syncTestPosButton();
    _showBoatPosition(44.103, -69.088);
    const msg = "AudioChart doesn't cover this area yet, so we've set a demo position in Rockland Harbor — " +
                "the heart of Penobscot Bay — for the full experience: History, Geology, Anchorages, and more. " +
                "Clear the test position any time to use your real location again.";
    setStatus(msg);
    TTS.sayImmediate(msg);
    _showCoverageAlert(msg);
    return;
  }

  if (regionId === activeId) {
    // Already the right region loaded — this spot is just outside its own
    // coverage; nothing to switch to.
    setStatus(COVERAGE_MESSAGES.none);
    TTS.sayImmediate(COVERAGE_MESSAGES.none);
    _showCoverageAlert(COVERAGE_MESSAGES.none);
    return;
  }

  const cruiseName = regionId ? Object.keys(CRUISE_PROFILES).find(n => _regionIdFor(n) === regionId) : null;
  const alreadyDownloaded = regionId === '' || (regionId && await Query.isRegionDownloaded(regionId));
  const displayName = cruiseName || 'Penobscot Bay';

  if (alreadyDownloaded) {
    _showRegionOfferBanner(displayName, { switchOnly: true, regionId });
    return;
  }

  if (cruiseName) _showRegionOfferBanner(cruiseName, { switchOnly: false });
}

/**
 * Reflects current position against loaded chart coverage — see
 * Query.coverageLevelAt. Runs on every position fix (cheap: memoized bbox
 * lookup, no rescans) but only updates the badge/speaks on a real change,
 * so it doesn't nag on every GPS tick while sitting outside coverage.
 */
let _coverageRecheckTimer = null;
let _coverageRecheckCount = 0;
const COVERAGE_RECHECK_MAX = 3; // ~6s of retries — enough for a slow fetch, not an indefinite poll for someone genuinely out of range
// Separate, much more generous budget for the app's very FIRST data load
// specifically (see dataReady/stillAwaitingFirstLoad below) — a real cold
// load (hazards/named_places/navaids, potentially several MB, over a slow
// connection) can easily take longer than COVERAGE_RECHECK_MAX's ~6s, and
// that used to be exactly long enough to falsely declare "no chart data"
// before the load had actually finished, with no way to ever re-check
// after (Auto Route worked fine once the data DID finish a few seconds
// later, but the spoken/badge verdict just stayed wrong). ~30s comfortably
// covers a slow real load while still eventually giving up and saying
// something if the fetch has genuinely failed for good.
let _coverageStartupWaitCount = 0;
const COVERAGE_STARTUP_WAIT_MAX = 15;

// v685-v687 each tried to solve a confusing coverage announcement by
// gating/delaying it further (a data-load-race timeout, then the real
// signal, then a grace window for a real GPS fix that might get
// superseded by a deliberate test position). Structurally superseded now:
// GPS.startGPS's shouldAccept predicate (see its call site in init()) means
// a real ('browser'-sourced) fix never even becomes the current position
// unless it's already confirmed inside Penobscot Bay coverage, so this
// function only ever sees 'browser' with level === 'core' — the whole
// class of "real fix outside coverage speaks before a spoof can override
// it" is now impossible by construction rather than papered over. Kept
// as _isRecheck-only (no source param) since nothing here needs to tell
// sources apart anymore.
function _updateCoverageStatus(lat, lon, _isRecheck = false) {
  if (!_isRecheck) _coverageRecheckCount = 0;  // a real position update, not a self-retry — start fresh
  const level = Query.coverageLevelAt(lon, lat);

  // The relevant hazard/navaid/named-place data for a NEW position
  // (server-bridge mode re-fetches "nearby" data per position; static mode
  // loads it once via Query.loadData) can still be in flight when this
  // first runs. Real bug found live (2026-09): a fixed ~6s retry budget
  // (the OLD value of this same guard) was too short for a genuinely slow
  // first load — Auto Route worked fine once the data actually finished
  // loading a few seconds later, but the spoken/badge coverage read never
  // re-evaluated after giving up at 6s, staying wrong indefinitely. Now
  // keyed off the real signal instead of a guess: dataReady is true only
  // once hazards/namedPlaces/navaids have actually populated, so a slow
  // load just keeps politely rechecking every 2s for as long as it takes,
  // no false "limited/no chart data" verdict along the way. The original
  // COVERAGE_RECHECK_MAX/~6s budget still applies once dataReady is true
  // (or coverage has settled once before) — that's the unrelated, already-
  // working self-correction for a real mid-voyage flip-flop, untouched.
  const dataReady = Query.hazards !== null && Query.namedPlaces !== null && Query.navaids !== null;
  const stillAwaitingFirstLoad = !_coverageStartupSettled && !dataReady &&
    _coverageStartupWaitCount < COVERAGE_STARTUP_WAIT_MAX;
  const willRecheck = level !== 'core' && !_coverageRecheckTimer &&
    (stillAwaitingFirstLoad || _coverageRecheckCount < COVERAGE_RECHECK_MAX);
  if (willRecheck) {
    if (stillAwaitingFirstLoad) _coverageStartupWaitCount++;
    else _coverageRecheckCount++;
    _coverageRecheckTimer = setTimeout(() => {
      _coverageRecheckTimer = null;
      // Re-read the CURRENT position rather than reusing the lat/lon
      // captured when this timer was scheduled — confirmed live as a real
      // bug: Virtual Journey (and, in principle, any fast-moving source)
      // can travel well past a coverage boundary in the 2s this timer
      // waits, so the stale point kept re-asserting an already-passed
      // coverage level and fighting with the live ticks, causing an
      // endless "chart data available" / "no chart data" flip-flop.
      const cur = GPS.getPosition();
      _updateCoverageStatus(cur?.lat ?? lat, cur?.lon ?? lon, true);
    }, 2000);
  }

  if (level !== _coverageLevel) {
    _coverageLevel = level;
    if (level === 'core') {
      _statusCoverageLabel = '';
      _statusCoverageCls   = '';
    } else {
      _statusCoverageLabel = level === 'land' ? '⚠ Limited chart data' : '⚠ No chart data';
      _statusCoverageCls   = `coverage-${level}`;
    }
    _renderStatusCombo();
    if (level !== 'none' && !_regionOfferDownloading) { _hideRegionOfferBanner(); _hideCoverageAlert(); }
  }

  // A read isn't trusted for SPEAKING purposes until either it's already
  // settled once before, it's unambiguously 'core', or willRecheck has
  // gone false (dataReady, or COVERAGE_STARTUP_WAIT_MAX/COVERAGE_RECHECK_MAX
  // genuinely exhausted) — the badge above still updates in real time
  // regardless, since a stale-but-harmless visual badge for as long as the
  // very first load actually takes is a fair trade for not crying wolf out
  // loud on an ordinary in-coverage start.
  if (!_coverageStartupSettled && level !== 'core' && willRecheck) return;
  if (level === 'core') _coverageStartupSettled = true;

  if (level === _coverageLastAnnounced) return; // nothing new to actually say
  const prevAnnounced = _coverageLastAnnounced;
  _coverageLastAnnounced = level;

  // Don't announce the very first "core" resolution on a normal in-coverage
  // start (prevAnnounced === null) — only speak up on an actual degrade/recover.
  if (prevAnnounced !== null || level !== 'core') {
    if (level === 'none') {
      _offerRegionForPosition(lat, lon); // async — sets its own status/TTS once it knows more
    } else {
      const msg = COVERAGE_MESSAGES[level] || 'Chart data available — full hazard and navaid checking restored.';
      setStatus(msg);
      TTS.sayImmediate(msg);
    }
  }
}

function showPosition(lat, lon, accuracy, source) {
  positionEl.textContent = formatPositionDisplay(lat, lon);
  const label = SOURCE_LABEL[source] || source.toUpperCase();
  const hasAcc = accuracy && !['opencpn-track', 'manual', 'virtual', 'default'].includes(source);
  const accText = hasAcc ? ` ±${Math.round(accuracy)}m` : '';
  _statusGpsLabel = `GPS: ${label}${accText}`;
  _statusGpsCls   = ['manual', 'virtual', 'default'].includes(source) ? 'gps-test' : 'gps-ok';
  _renderStatusCombo();
  _updateCoverageStatus(lat, lon);
  _autoSelectRegionForPosition(lat, lon); // fire-and-forget — sets its own status/title-bar label once it knows more

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
  layers.push(L.marker([lat, lon], { icon: MarkerIcons.pinIcon() })
    .bindTooltip('📍', { permanent: true, direction: 'top', className: 'map-tooltip' }));

  {
    const hazardLayer = L.layerGroup();
    HazardClustering.renderClusteredHazards(_map, hazardLayer, hazards, (h) => {
      const m = L.marker([h.lat, h.lon], { icon: MarkerIcons.hazardMarkerIcon() });
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
    const m = L.marker([n.lat, n.lon], { icon: MarkerIcons.navaidMarkerIcon(n) });
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

  // Press any visible button / menu item by its label (direct request
  // 2026-10-06). "press X" / "click X" always means a control on screen;
  // a bare label ("Anchor Watch", "Satellite") is tried only when it isn't
  // one of the regular commands. See voice_labels.js.
  // "press this" / "open it" mean the thing under the pointer, not a label.
  const explicitPress = intent !== 'POINTER_PRESS' && VoiceLabels.isExplicitPress(transcript);

  // While TTS is speaking, silently drop anything that doesn't parse — covers
  // background noise, keyboard-mic feedback, and TTS audio picked up by the mic.
  // An explicit "press X" is deliberate, so it still goes through.
  if (TTS.isSpeaking() && intent === 'UNKNOWN' && !explicitPress) return;
  if (!['SET_MARKER', 'POINTER_PRESS', 'AUTOROUTE_TO_PLACE', 'SHOW_PLACE', 'BRING_BOAT_TO_PLACE', 'START_TRACKING',
        'STOP_TRACKING', 'ANCHOR_WATCH', 'STOP_ANCHOR_WATCH', 'SILENCE_ALARM', 'CLEAR_SCREEN'].includes(intent)) {
    const msg = _runMarkerMenuCommand(transcript, intent);
    if (msg) {
      addToHistory(transcript);
      setStatus(msg);
      showResponse(msg);
      if (msg.startsWith('For safety')) TTS.sayImmediate(msg);
      return;
    }
  }
  if (explicitPress || intent === 'UNKNOWN') {
    const r = VoiceLabels.pressVisibleLabel(transcript);
    if (r.ok || explicitPress) {
      addToHistory(transcript);
      const clean = (t) => t.replace(/\s+/g, ' ').trim();
      const msg = r.ok ? `Pressed "${clean(r.label)}".`
        : r.reason === 'destructive' ? `For safety, "${clean(r.label)}" has to be tapped by hand.`
        : r.reason === 'ambiguous' ? `More than one "${clean(r.label)}" is showing — tap the one you mean.`
        : `No button like "${transcript.trim().replace(/^\S+\s+/, '')}" is showing right now.`;
      setStatus(msg);
      showResponse(msg);
      if (!r.ok) TTS.sayImmediate(msg);
      return;
    }
  }

  console.log('[AudioChart] handleCommand:', transcript);
  try {
    setStatus(`Command: "${transcript}"`);
    showResponse('...');
    addToHistory(transcript);

    if (intent === 'LIST_OBJECTS') {
      const response = {
        text:   'Hazards (rocks, ledges, shoals) · Buoys · Lights · Beacons · Restrictions (no-anchor, sanctuary) · Islands · Named places · Waypoints',
        speech: 'I can find hazards like rocks, ledges, and shoals; navigation aids including buoys, lights, and beacons; restricted areas like no-anchor zones and sanctuaries; nearby islands; and named places and OpenCPN waypoints for bearing queries.',
      };
      showResponse(response.text);
      TTS.sayImmediate(response.speech);
      return;
    }

    if (intent === 'LIST_WAYPOINTS') {
      const wps = WaypointsStorage.loadUserWaypoints();
      if (!wps.length) {
        const msg = 'No waypoints saved yet. Right-click the map and choose Set marker here.';
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
      const wps = WaypointsStorage.loadUserWaypoints();
      const idx = wps.findIndex(w => w.name.toLowerCase() === name);
      if (idx === -1) {
        const msg = `No waypoint named ${name}.`;
        showResponse(msg);
        TTS.sayImmediate(msg);
        return;
      }
      wps.splice(idx, 1);
      localStorage.setItem(WaypointsStorage.USER_WP_KEY, JSON.stringify(wps));
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

    // An ad-hoc bearing query while a route is being followed (real or
    // virtual) shouldn't silently retarget #focus-btn away from the leg
    // actually being steered to — checking "bearing to waypoint 5" or
    // "bearing to X" mid-passage is a lookup, not a request to change
    // course. The target stays locked until the leg advances on its own
    // or the user explicitly says "focus on X" (SET_FOCUS, unaffected).
    const _keepFocusOpt = _followingRouteId ? { keepFocus: true } : undefined;

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
      case 'NEAREST_ISLAND':
        response = Query.nearestIsland(pos.lat, pos.lon);
        break;
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
        response = Query.bearingToCoord(pos.lat, pos.lon, params.lat, params.lon, _keepFocusOpt);
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
      case 'FOLLOW_ROUTE': {
        const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
        const q = params.routeName.toLowerCase();
        const route = routes.find(r => r.name.toLowerCase() === q) ||
                      routes.find(r => r.name.toLowerCase().includes(q));
        if (!route) {
          response = { text: `No route named "${params.routeName}".`, speech: `I couldn't find a route called ${params.routeName}.` };
          break;
        }
        // _startFollowingRoute already sets its own status/speech (and
        // refuses if a track is already recording) — don't let the shared
        // response handling below speak a second time and cut it off.
        _startFollowingRoute(route);
        return;
      }
      case 'NEXT_WAYPOINT': {
        if (!_followingRouteId) {
          response = { text: 'Not following a route.', speech: 'Not following a route. Say follow route, then the route name, or tap Follow on a route.' };
          break;
        }
        const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
        const route = routes.find(r => r.id === _followingRouteId);
        const pt = route?.points?.[_followingLegIdx];
        if (!pt) {
          response = { text: 'No next waypoint.', speech: 'No next waypoint.' };
          break;
        }
        response = Query.bearingToNamedPoint(pos.lat, pos.lon, pt.lat, pt.lon, `${route.name} — waypoint ${_followingLegIdx + 1}`);
        break;
      }
      case 'BEARING_TO_ROUTE_WAYPOINT': {
        if (!_followingRouteId) {
          response = { text: 'Not following a route.', speech: 'Not following a route. Say follow route, then the route name, first.' };
          break;
        }
        const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
        const route = routes.find(r => r.id === _followingRouteId);
        const idx = params.waypointNum - 1;
        const pt = route?.points?.[idx];
        if (!pt) {
          response = { text: `Waypoint ${params.waypointNum} doesn't exist on "${route?.name || 'this route'}".`, speech: `Waypoint ${params.waypointNum} doesn't exist on this route.` };
          break;
        }
        response = Query.bearingToNamedPoint(pos.lat, pos.lon, pt.lat, pt.lon, `${route.name} — waypoint ${params.waypointNum}`, _keepFocusOpt);
        break;
      }
      case 'BRING_BOAT_TO_PLACE': {
        const mk = _markerByName(params.placeName);
        if (mk?.missing) { response = { text: `No marker called ${mk.name}.`, speech: `No marker called ${mk.name}.` }; break; }
        const dest = mk || await _resolveNamedDestination(params.placeName);
        if (!dest) { response = { text: `Couldn't find "${params.placeName}".`, speech: '' }; break; }
        if (mk) _currentMarkerLL = { lat: mk.lat, lng: mk.lon };
        const label = mk?.title ? `${mk.name}, ${mk.title}` : (dest.name || params.placeName);
        _bringBoatTo(dest.lat, dest.lon, label);
        response = { text: `Boat moved to ${label}.`, speech: '' };
        break;
      }
      case 'SHOW_PLACE': {
        // A visible button named exactly that ("Show hazards") wins over a
        // fuzzy place-name match.
        const btn = VoiceLabels.matchLabel(transcript, VoiceLabels.visibleTargets().map((t) => t.raw));
        if (btn.ok && btn.score <= 0.1) {
          const r = VoiceLabels.pressVisibleLabel(transcript);
          if (r.ok) { response = { text: `Pressed "${r.label.replace(/\s+/g, ' ').trim()}".`, speech: '' }; break; }
        }
        let coord = parseCoordinate(params.placeName);
        if (!coord) coord = await Query.findPlaceOnServer(params.placeName) || Query.findPlaceByName(params.placeName);
        if (!coord || !_map) {
          // "Show hazards", "Show info"… are buttons, not places.
          const r = VoiceLabels.pressVisibleLabel(transcript);
          response = r.ok
            ? { text: `Pressed "${r.label.replace(/\s+/g, ' ').trim()}".`, speech: '' }
            : { text: `Couldn't find "${params.placeName}".`, speech: `Couldn't find ${params.placeName}.` };
          break;
        }
        _map.setView([coord.lat, coord.lon], Math.max(_map.getZoom() || 13, 15));
        response = { text: `Showing ${coord.name || params.placeName}.`, speech: '' };
        break;
      }
      case 'START_TRACKING':
        response = _trackRecActive ? { text: 'Already recording.', speech: 'Already recording.' }
          : (_startTrackRecording(), { text: 'Recording your track — Stop is at the top right.', speech: 'Recording your track.' });
        break;
      case 'STOP_TRACKING':
        response = _stopTrackRecording() ? { text: 'Stopping — name the track to save it.', speech: '' } : { text: 'Not recording a track.', speech: 'Not recording a track.' };
        break;
      case 'ANCHOR_WATCH': {
        const ft = params.radiusFt || AnchorWatch.getRadiusFt();
        response = _armAnchorWatch(ft) ? { text: `Anchor watch on — ${ft} ft around here.`, speech: '' }
          : { text: 'No position fix yet — cannot arm anchor watch.', speech: 'No position fix yet.' };
        break;
      }
      case 'STOP_ANCHOR_WATCH':
        response = _stopAnchorWatch() ? { text: 'Anchor watch off.', speech: '' } : { text: 'Anchor watch is not on.', speech: 'Anchor watch is not on.' };
        break;
      case 'SILENCE_ALARM':
        if (AnchorWatch.isAlarming()) { AnchorWatch.silence(setStatus); _updateAnchorWatchButton(); response = { text: 'Alarm silenced — anchor watch still on.', speech: '' }; }
        else response = { text: 'No alarm sounding.', speech: '' };
        break;
      case 'CLEAR_SCREEN': {
        _clearScreen();
        response = { text: 'Screen cleared.', speech: '' };
        break;
      }
      case 'POINTER_PRESS': {
        const msg = _pressAtPointer(params.menu);
        response = { text: msg, speech: /^(For safety|Point at|Nothing)/.test(msg) ? msg : '' };
        break;
      }
      case 'SET_MARKER': {
        // Under the mouse pointer when it's over the map (point, then hold
        // Space and say it), else the middle of the map.
        if (!_map) { response = { text: 'Open the map first, then try again.', speech: '' }; break; }
        const at = _mapPointerLatLng || _map.getCenter();
        const msg = _dropMarkerAt(at.lat, at.lng);
        response = { text: msg, speech: msg };
        break;
      }
      case 'MARKER_AUTOROUTE':
      case 'MARKER_BRING_BOAT': {
        // "The marker" = the active waypoint, which "Set marker here" (and
        // Search) set when they drop a pin. Its live position comes from the
        // saved waypoint, so a marker dragged after it was set still counts.
        const aw = Query.activeWaypoint;
        const saved = aw && WaypointsStorage.loadUserWaypoints().find(w => w.name === aw.name);
        const m = saved ? { lat: saved.lat, lon: saved.lon, name: saved.name } : aw;
        if (!m) {
          const t = 'No marker set. Point at a spot and say "Set marker", or right-click or long-press the map and choose "Set marker here".';
          response = { text: t, speech: t };
          break;
        }
        _map?.closePopup(); // same as the popup's own buttons
        if (intent === 'MARKER_BRING_BOAT') {
          _bringBoatTo(m.lat, m.lon, m.name);
          response = { text: `Boat moved to ${m.name}.`, speech: '' };
        } else {
          if (!_autoRouteFromBoatToHereFn) { response = { text: 'Open the map first, then try again.', speech: '' }; break; }
          _autoRouteFromBoatToHereFn(m.lat, m.lon);
          response = { text: `AutoRoute to ${m.name}…`, speech: '' };
        }
        break;
      }
      case 'AUTOROUTE_TO_PLACE': {
        // Same pipeline as a waypoint popup's "AutoRoute from boat
        // position": start at the boat, destination resolved by name the
        // same way Draw Route's "Name" button does (asks which one when a
        // name is shared by several places; moves an on-land name onto
        // nearby water). Text-only acknowledgement — AutoRoute plotting
        // stays quiet except for real danger warnings.
        const mk = _markerByName(params.placeName);
        if (mk?.missing) { response = { text: `No marker called ${mk.name}.`, speech: `No marker called ${mk.name}.` }; break; }
        if (mk) {
          if (!_autoRouteFromBoatToHereFn) { response = { text: 'Open the map first, then try again.', speech: '' }; break; }
          _currentMarkerLL = { lat: mk.lat, lng: mk.lon };
          _autoRouteFromBoatToHereFn(mk.lat, mk.lon);
          response = { text: `AutoRoute to ${mk.title ? `${mk.name}, ${mk.title}` : mk.name}…`, speech: '' };
          break;
        }
        const dest = await _resolveNamedDestination(params.placeName);
        if (!dest) { response = { text: `Couldn't find "${params.placeName}".`, speech: '' }; break; }
        if (!_autoRouteFromBoatToHereFn) { response = { text: 'Open the map first, then try again.', speech: '' }; break; }
        _autoRouteFromBoatToHereFn(dest.lat, dest.lon);
        response = { text: `AutoRoute to ${dest.name || params.placeName}…`, speech: '' };
        break;
      }
      case 'BEARING_TO_PLACE': {
        response = Query.bearingToPlace(pos.lat, pos.lon, params.placeName, _keepFocusOpt);
        if (!response && serverUrl) {
          const place = await Query.findPlaceOnServer(params.placeName);
          if (place) {
            response = Query.bearingToResolvedPlace(pos.lat, pos.lon, place.lat, place.lon, place.name, _keepFocusOpt);
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
    // Empty speech means "nothing to say" — calling sayImmediate('') would
    // cancel whatever is already being spoken (e.g. AUTOROUTE_TO_PLACE's
    // "X is on land — moved to Y" from _resolveNamedDestination).
    if (speechText) TTS.sayImmediate(speechText);

    const isCourseIntent = (intent === 'HAZARDS_ON_COURSE' || intent === 'HAZARDS_ALONG_ROUTE');
    const isBearingIntent = (intent === 'BEARING_TO_PLACE' || intent === 'BEARING_TO_COORD' || intent === 'QUERY_FOCUS' ||
                              intent === 'NEXT_WAYPOINT' || intent === 'BEARING_TO_ROUTE_WAYPOINT');
    const isOtherMapIntent = ['NEAREST_ISLAND', 'NEAREST_HAZARD', 'NEAREST_NAVAID', 'NEAREST_RESTRICTION'].includes(intent);

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
    } else if (intent === 'SET_FOCUS' || intent === 'CLEAR_FOCUS' || intent === 'AUTOROUTE_TO_PLACE' ||
               intent === 'MARKER_AUTOROUTE' || intent === 'MARKER_BRING_BOAT' || intent === 'SET_MARKER' ||
               intent === 'POINTER_PRESS' || intent === 'SHOW_PLACE' || intent === 'BRING_BOAT_TO_PLACE' || intent === 'CLEAR_SCREEN' ||
               ['START_TRACKING', 'STOP_TRACKING', 'ANCHOR_WATCH', 'STOP_ANCHOR_WATCH', 'SILENCE_ALARM'].includes(intent)) {
      // Leave the current map view as-is — these only change the focus target.
    } else {
      // Used to call hideMap() — from when a command's answer replaced the
      // map on screen. The map IS the app now: on a phone that left a blank
      // blue screen with no way back (2026-10-07, after "didn't understand").
      // Desktop never showed it only because a wide-screen CSS rule forces
      // the map visible.
      _bearingAccumulator = [];
      opencpnBtn.style.display = 'none';
    }
  } catch (err) {
    console.error('[AudioChart] handleCommand error:', err);
    showResponse(`Error: ${err.message}`);
  }
}

// "Set marker here" — shared by the right-click menu and the "Set marker"
// voice/text command. Drops an SP marker and makes it the active waypoint,
// so "autoroute from boat position" / "bring boat here" act on it next.
let _mapPointerLatLng = null;
// Where the mouse pointer is on screen, for "press" / "menu" by voice.
let _pointerXY = null;
document.addEventListener('mousemove', (e) => { _pointerXY = { x: e.clientX, y: e.clientY }; }, { passive: true });
document.documentElement.addEventListener('mouseleave', () => { _pointerXY = null; });

// ── Saved markers by spoken name ─────────────────────────────────────────────
// "AutoRoute to TS003", "Bring boat to SP001" (2026-10-06, direct request).
// Speech engines write these many ways — "T S zero zero three", "TS 3",
// "teas three", "S P one" — so the prefix and the number are read loosely
// and matched by value (TS3 = TS003). Any other saved waypoint matches by
// its exact name. Returns {name, lat, lon}, {name, missing:true} when it
// was clearly a marker name that doesn't exist, or null (not a marker name).
const _NUM_WORDS = { zero: 0, oh: 0, o: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4,
  five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const _TENS_WORDS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function _spokenNumber(words) {
  let out = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d+$/.test(w)) out += w;
    else if (w in _TENS_WORDS) {
      const unit = _NUM_WORDS[words[i + 1]];
      if (unit >= 1 && unit <= 9) { out += String(_TENS_WORDS[w] + unit); i++; } else out += String(_TENS_WORDS[w]);
    } else if (w in _NUM_WORDS) out += String(_NUM_WORDS[w]);
    else return NaN;
  }
  return out ? parseInt(out, 10) : NaN;
}
function _markerByName(text) {
  const t = text.toLowerCase().replace(/[.!?,]/g, ' ').replace(/\s+/g, ' ').trim();
  const all = [
    ...WaypointsStorage.loadUserWaypoints().map((w) => ({ name: w.name, lat: w.lat, lon: w.lon })),
    ...TestSetsStorage.loadTestSets().flatMap((s) => s.waypoints.map((w) => ({ name: w.name, lat: w.lat, lon: w.lon }))),
    ..._documents.filter((f) => f.properties.code).map((f) => ({
      name: f.properties.code, title: f.properties.title, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
    })),
  ];
  const exact = all.find((w) => w.name.toLowerCase() === t);
  if (exact) return exact;
  const m = t.match(/^(t ?s|tee ?ess|tea ?s|teas|tease|s ?p|ess ?pee|a ?s|ay ?ess|ace|as)\s?-?\s?(.+)$/);
  if (!m) return null;
  const prefix = /^(t|tee|tea)/.test(m[1]) ? 'TS' : /^(a|ay)/.test(m[1]) ? 'AS' : 'SP';
  const num = _spokenNumber(m[2].replace(/-/g, ' ').split(' ').filter(Boolean));
  if (!Number.isFinite(num)) return null;
  const hit = all.find((w) => w.name.toUpperCase().startsWith(prefix) && parseInt(w.name.slice(2), 10) === num);
  return hit || { name: prefix + String(num).padStart(3, '0'), missing: true };
}

// ── A marker's menu by voice, without opening it first ───────────────────────
// Direct request 2026-10-06: pointing at an SP (or saved-waypoint) marker or
// a Test Set marker, any item on its popup menu can just be said ("bring
// boat here", "set focus", "objects within"). With nothing pointed at, the
// current marker is used — the one last placed or last acted on. Runs the
// popup's own button, so the behavior is exactly a click.
let _currentMarkerLL = null;
function _userMarkerLayers() {
  const out = [];
  for (const g of [_waypointLayer, _testSetLayer]) g?.eachLayer((l) => out.push(l));
  if (_mapViewMode === 'anchorages') _documentMarkersLayer?.eachLayer((l) => out.push(l));
  return out;
}
function _markerUnderPointer() {
  if (!_pointerXY) return null;
  const el = document.elementFromPoint(_pointerXY.x, _pointerXY.y);
  if (!el) return null;
  return _userMarkerLayers().find((l) => l._icon?.contains(el) || l.getTooltip?.()?.getElement?.()?.contains(el)) || null;
}
function _currentMarker() {
  const aw = Query.activeWaypoint;
  const ll = _currentMarkerLL || (aw && { lat: aw.lat, lng: aw.lon });
  if (!ll) return null;
  return _userMarkerLayers().find((l) => {
    const p = l.getLatLng();
    return Math.abs(p.lat - ll.lat) < 1e-7 && Math.abs(p.lng - ll.lng) < 1e-7;
  }) || null;
}
// Returns a reply when the words were one of the marker's menu items (or a
// refused Delete), else null so the command is handled as usual.
function _runMarkerMenuCommand(transcript, intent) {
  const layer = _markerUnderPointer() || _currentMarker();
  const content = layer?.getPopup?.()?.getContent?.();
  if (typeof content !== 'string') return null;
  const box = document.createElement('div');
  box.innerHTML = content;
  const items = [...box.querySelectorAll('button')].map((b) => ({ cls: b.classList[0], all: b.className, label: b.textContent.trim() }));
  let item = null;
  if (intent === 'MARKER_AUTOROUTE') item = items.find((i) => /autoroute/.test(i.all));
  else if (intent === 'MARKER_BRING_BOAT') item = items.find((i) => /bring-boat|ts-popup-pos/.test(i.all));
  else {
    const m = VoiceLabels.matchLabel(transcript, items.map((i) => i.label));
    if (!m.ok) return m.reason === 'destructive' ? `For safety, "${m.label.replace(/^\W+/, '')}" has to be clicked by hand.` : null;
    // A regular command ("nearest hazard"…) only gives way to a near-exact menu item.
    if (intent !== 'UNKNOWN' && m.score > 0.1) return null;
    item = items[m.index];
  }
  if (!item) return null;
  const ll = layer.getLatLng();
  _currentMarkerLL = { lat: ll.lat, lng: ll.lng };
  const popup = layer.getPopup();
  const autoPan = popup.options.autoPan;
  popup.options.autoPan = false; // run it in place — don't pan the map
  layer.openPopup();
  popup.options.autoPan = autoPan;
  const btn = popup.getElement()?.querySelector(`.${item.cls}`);
  if (!btn) return null;
  btn.click();
  const name = layer.getTooltip?.()?.getContent?.() || 'marker';
  return `${item.label.replace(/^[^\p{L}]+/u, '').replace(/[›…]$/, '').trim()} — ${name}.`;
}

// "Press" / "Menu" with no label: act on what's under the mouse pointer.
// A marker opens its popup (its menu); "menu" on bare map opens the
// right-click menu at that spot. Delete-type controls still need a click.
function _pressAtPointer(menu) {
  if (!_pointerXY) return 'Point at something with the mouse first.';
  const { x, y } = _pointerXY;
  const el = document.elementFromPoint(x, y);
  if (!el) return 'Nothing there to press.';
  const target = el.closest('button, [role="button"], [role="menuitem"], a[href], label, select, .leaflet-marker-icon, .leaflet-interactive') || el;
  const label = (target.innerText || target.getAttribute?.('aria-label') || target.title || '').replace(/\s+/g, ' ').trim();
  if (/\b(delete|remove|erase|discard)\b/i.test(label)) return `For safety, "${label}" has to be clicked by hand.`;
  const onBareMap = el.closest('#leaflet-map') && target === el && !el.closest('.leaflet-popup, .leaflet-control, .leaflet-marker-icon');
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: menu && onBareMap ? 2 : 0 };
  if (menu && onBareMap) {
    el.dispatchEvent(new MouseEvent('contextmenu', opts));
    return 'Opened the menu.';
  }
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  if (target.classList?.contains('leaflet-marker-icon')) return 'Opened the menu.';
  return label ? `Pressed "${label.slice(0, 40)}".` : 'Pressed.';
}
function _dropMarkerAt(lat, lon) {
  _currentMarkerLL = { lat, lng: lon };
  const name = WaypointsStorage.nextSearchPinName();
  saveUserWaypoint(name, lat, lon, 'search', formatPositionDisplay(lat, lon));
  Query.setActiveWaypoint(lat, lon, name);
  if (!_waypointsVisible) _setWaypointsVisible(true);
  return `${name} dropped.`;
}

// ── Voice bridge for the Android app (2026-10-06 prototype) ──────────────────
// The Android wrapper (android/ in the repo) adds hold-VOLUME-DOWN-to-talk:
// it asks for audioChartVoiceHints() (the visible button labels, to nudge
// recognition toward them), reports progress through audioChartVoiceStatus(),
// and hands the heard text to audioChartVoiceCommand(), which runs it like a
// typed command. #voice-hud shows "Listening…", what was heard, and the
// result, since the command box's own reply area is hidden unless it's open.
const _voiceHud = document.getElementById('voice-hud');
let _voiceHudTimer = 0;
function _showVoiceHud(text, holdMs = 0) {
  if (!_voiceHud) return;
  clearTimeout(_voiceHudTimer);
  _voiceHud.textContent = text;
  _voiceHud.style.display = 'block';
  if (holdMs) _voiceHudTimer = setTimeout(() => { _voiceHud.style.display = 'none'; }, holdMs);
}
window.audioChartVoiceHints = () => {
  const labels = VoiceLabels.visibleTargets().map(t => t.raw.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...new Set([...labels, 'set marker here', 'menu', 'press', 'bring boat here', 'autoroute from boat position', 'autoroute to'])];
};
window.audioChartVoiceStatus = (state, text) => {
  if (state === 'listening') _showVoiceHud('🎤 Listening…');
  else if (state === 'partial') _showVoiceHud(`🎤 “${text}”`);
  else if (state === 'thinking') _showVoiceHud('🎤 …');
  else if (state === 'error') _showVoiceHud(`🎤 ${text}`, 4000);
  else if (state === 'info') _showVoiceHud(`🎤 ${text}`, 6000);
};
window.audioChartVoiceCommand = async (text) => {
  _showVoiceHud(`🎤 “${text}”`);
  const before = document.getElementById('response-text')?.lastChild;
  await handleCommand(text);
  const after = document.getElementById('response-text')?.lastChild;
  const reply = after && after !== before ? after.textContent.replace(/^\d{1,2}:\d{2}\s*[AP]M/, '').trim() : '';
  _showVoiceHud(reply ? `🎤 “${text}” → ${reply}` : `🎤 “${text}”`, 5000);
};

// ── Command box on demand ─────────────────────────────────────────────────────
// The command box shows by itself only in Underway / while following a route
// (see #map-overlay-cmd in app.css). This button — and "/" on a keyboard —
// opens it any time, so typed or dictated commands (say-any-button,
// "autoroute to X", marker commands) work with Underway off too. Tap again,
// or Escape, to close.
const _cmdOpenBtn = document.getElementById('cmd-open-btn');
function _setCmdOpen(open) {
  document.getElementById('app').classList.toggle('cmd-open', open);
  _cmdOpenBtn?.classList.toggle('active', open);
  _placeCmdOpenBtn();
  if (open) setTimeout(() => textInput?.focus(), 0);
}
// While the box is open, sit at the end of its input row (right of ▶) rather
// than on top of the transcript strip. The row is in a different place on
// phones and desktop, so measure it instead of hard-coding a position.
function _placeCmdOpenBtn() {
  if (!_cmdOpenBtn) return;
  const submit = document.getElementById('text-submit');
  if (!document.getElementById('app').classList.contains('cmd-open') || !submit?.offsetWidth) {
    _cmdOpenBtn.style.left = _cmdOpenBtn.style.top = _cmdOpenBtn.style.bottom = '';
    return;
  }
  const r = submit.getBoundingClientRect();
  const p = _cmdOpenBtn.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
  _cmdOpenBtn.style.left = `${Math.round(r.right - p.left + 8)}px`;
  _cmdOpenBtn.style.top = `${Math.round(r.top - p.top + (r.height - _cmdOpenBtn.offsetHeight) / 2)}px`;
  _cmdOpenBtn.style.bottom = 'auto';
}
window.addEventListener('resize', _placeCmdOpenBtn);
_cmdOpenBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (_pttSuppressClick) { _pttSuppressClick = false; return; } // that was a hold-to-talk
  _setCmdOpen(!document.getElementById('app').classList.contains('cmd-open'));
});

// ── Hold to talk (push_to_talk.js) ───────────────────────────────────────────
// Hold the round button — or the Space bar when not typing — speak, let go.
// A quick tap still opens the typing box, so one button does both. Uses the
// same strip (#voice-hud) and command path as the Android app's bridge above.
const PTT_HOLD_MS = 250;
let _pttHoldTimer = 0;
let _pttActive = false;
let _pttSuppressClick = false;
function _pttStart() {
  if (_pttActive) return;
  _pttActive = true;
  PushToTalk.start({
    hints: window.audioChartVoiceHints(),
    onStatus: window.audioChartVoiceStatus,
    onText: window.audioChartVoiceCommand,
    beforeListen: () => TTS.stop(), // don't let the app hear itself
  });
}
function _pttStop() {
  if (!_pttActive) return;
  _pttActive = false;
  PushToTalk.stop();
}
if (_cmdOpenBtn && PushToTalk.isSupported()) {
  _cmdOpenBtn.classList.add('ptt');
  _cmdOpenBtn.title = 'Hold to talk · tap to type (keyboard: hold Space, or press /)';
  _cmdOpenBtn.setAttribute('aria-label', 'Talk');
  _cmdOpenBtn.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/></svg>';
  _cmdOpenBtn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    _pttHoldTimer = setTimeout(() => { _pttSuppressClick = true; _cmdOpenBtn.classList.add('talking'); _pttStart(); }, PTT_HOLD_MS);
  });
  const release = () => {
    clearTimeout(_pttHoldTimer);
    _cmdOpenBtn.classList.remove('talking');
    _pttStop();
  };
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) _cmdOpenBtn.addEventListener(ev, release);
  _cmdOpenBtn.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press menu on phones
  // Space bar: hold to talk anywhere except while typing in a field.
  const isTyping = (t) => t.closest?.('input, textarea, select, [contenteditable="true"]');
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault(); // also stops Space from re-pressing whichever button has focus
    if (!e.repeat) { _cmdOpenBtn.classList.add('talking'); _pttStart(); }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || isTyping(e.target)) return;
    e.preventDefault();
    _cmdOpenBtn.classList.remove('talking');
    _pttStop();
  });
  window.addEventListener('blur', release);
}
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    _setCmdOpen(true);
  } else if (e.key === 'Escape' && document.getElementById('app').classList.contains('cmd-open')) {
    _setCmdOpen(false);
    textInput?.blur();
  }
});

// ── Text input ────────────────────────────────────────────────────────────────

if (textForm) {
  textForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = textInput.value.trim();
    if (!text) {
      // Empty box + play: rerun the last command rather than no-op — the
      // history list already has it at index 0, so this is just "repeat".
      // Show it in the box (rather than leaving the box empty) so it's
      // visible what got replayed.
      const last = loadHistory()[0];
      if (last) {
        textInput.value = last;
        handleCommand(last);
      }
      return;
    }
    textInput.value = '';
    handleCommand(text);
  });
}

// Command reference picker — user asked for this directly ("I can't
// remember the commands"): picking an option fills its template into
// #text-input for editing, same click-to-populate-don't-submit pattern
// already used by the recent-commands history pills (see renderHistory
// below). Any [bracketed] placeholder in the template gets pre-selected
// so typing immediately overwrites it instead of requiring a manual
// select-then-type step.
if (commandPicker) {
  commandPicker.addEventListener('change', () => {
    if (!commandPicker.value) return;
    textInput.value = commandPicker.value;
    textInput.focus();
    const m = commandPicker.value.match(/\[[^\]]*\]/);
    if (m) textInput.setSelectionRange(m.index, m.index + m[0].length);
    else textInput.setSelectionRange(textInput.value.length, textInput.value.length);
    commandPicker.value = '';  // reset to the placeholder so the same option fires `change` again next time
  });
}

// ── Test position override ────────────────────────────────────────────────────

function syncTestPosButton() {
  const active = GPS.isManualPosition();
  testPosBtn.textContent = active ? '📍 CLEAR TEST' : '📍 Location';
  testPosBtn.classList.toggle('test-active', active);
}

function _closeTestPosForm() {
  testPosForm.style.display = 'none';
  testPosInput.value = '';
  testPosInput.style.borderColor = '';
}

function _closeLocationMenu() { locationMenu.style.display = 'none'; }

// The Location tile itself: while a spoofed position is active, one tap
// clears it (the common "oops, undo that" case) — same shortcut the old
// dedicated Set-Point button had. Otherwise it opens the 2-item menu
// (Spoof Location / Download Region) rather than jumping straight to either
// sub-form, since it now covers both.
locationMenuBtn.addEventListener('click', () => {
  if (GPS.isManualPosition()) {
    clearTestPosition();
    return;
  }
  const isOpen = locationMenu.style.display !== 'none';
  _closeTestPosForm();
  cruiseForm.style.display = 'none';
  if (isOpen) { _closeLocationMenu(); return; }
  locationMenu.style.display = 'flex';
});

document.getElementById('location-menu-spoof').addEventListener('click', () => {
  _closeLocationMenu();
  testPosForm.style.display = 'flex';
  testPosInput.focus();
});
document.getElementById('location-menu-region').addEventListener('click', () => {
  _closeLocationMenu();
  cruiseForm.style.display = 'flex';
});
// Confirmed live (the "Hurricane Island" bug): re-downloading a region only
// ever ADDS place/hazard/navaid data on top of whatever's already cached —
// it never removes or corrects an entry if the server's copy later changes.
// A device that downloaded before a name fix shipped keeps the old,
// stale entry forever, no matter how many times it re-downloads, since the
// old and new entries just accumulate side by side. This is the actual
// full reset: wipe the whole offline IndexedDB store and start clean.
// Saved routes/tracks live in localStorage, not here, so this can't touch them.
document.getElementById('location-menu-reset-data').addEventListener('click', async () => {
  _closeLocationMenu();
  const ok = confirm(
    "Reset offline data?\n\nThis wipes all downloaded chart data (hazards, place names, navaids) " +
    "so the next region download starts completely clean instead of merging onto what's already " +
    "cached. Your saved routes and tracks are not affected.\n\n" +
    "Use this if re-downloading a region hasn't fixed a stale or wrong result."
  );
  if (!ok) return;
  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('audiochart-offline');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve(); // other tabs holding it open — still proceed with reload
    });
  } catch (e) {
    console.warn('[reset-offline-data] delete failed:', e.message);
  }
  location.reload();
});

// Cancelable: Escape or a click outside the form/menu closes it without
// setting anything.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (testPosForm.style.display !== 'none') _closeTestPosForm();
    if (locationMenu.style.display !== 'none') _closeLocationMenu();
    if (searchForm.style.display !== 'none') _closeSearchForm();
  }
});
document.addEventListener('click', (e) => {
  if (locationMenuBtn.contains(e.target) || searchBtn.contains(e.target)) return;
  if (testPosForm.style.display !== 'none' && !testPosForm.contains(e.target)) _closeTestPosForm();
  if (locationMenu.style.display !== 'none' && !locationMenu.contains(e.target)) _closeLocationMenu();
  if (searchForm.style.display !== 'none' && !searchForm.contains(e.target)) _closeSearchForm();
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
  _followFocusLegIdx = null;
  _followedHazardKnownKeys = new Set();
  if (_liveFollowHazardLayer) { _liveFollowHazardLayer.clearLayers(); _map.removeLayer(_liveFollowHazardLayer); _liveFollowHazardLayer = null; }
  _appEl.classList.remove('following-active');
  _exitRoutePanelCompactFn?.();
  if (_followProgressEl) _followProgressEl.style.display = 'none';
  _updateActiveStrip();
  _refreshSavedTrackLayers();
}

// Start recording — from the boat's menu, the Tracks window, or voice
// ("start tracking"). Stopping is the strip's Stop button (#track-rec-btn).
function _startTrackRecording() {
  if (_trackRecActive) return false;
  _trackRecActive = true;
  _autoTrackEverStarted = true;
  _trackRecStartMs = Date.now();
  _trackRecPoints = [];
  _trackRecLastSampleTs = 0;
  _updateActiveStrip();
  return true;
}
function _stopTrackRecording() {
  if (!_trackRecActive) return false;
  if (_followingRouteId) { _stopFollowingRoute(false); return true; }
  // _showTextPrompt, not native prompt(): voice-friendly, and a native
  // dialog blocks the page (and any automation) until dismissed.
  // Cancelling keeps recording — with native prompt() a cancel silently
  // threw the whole track away.
  _showTextPrompt('Save track as:', '', `Track ${new Date(_trackRecStartMs).toLocaleString()}`).then((name) => {
    if (!name) { setStatus('Still recording.'); return; }
    const enough = _trackRecPoints.length >= 2;
    _finishTrackRecording(name);
    const msg = enough ? `Track saved as "${name}".` : 'Stopped — too short to save a track.';
    setStatus(msg); showResponse(msg);
  });
  return true;
}
trackRecBtn?.addEventListener('click', () => { _stopTrackRecording(); });

// Start recording a track linked to a specific route — auto-named and
// auto-saved on arrival (see the GPS callback below), with a manual stop
// always available via the same Track button (now showing "Stop Tracking").
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
  _followedHazardKnownKeys = new Set();
  if (_liveFollowHazardLayer) { _liveFollowHazardLayer.clearLayers(); _map.removeLayer(_liveFollowHazardLayer); _liveFollowHazardLayer = null; }
  _recheckFollowedRouteHazardsLive(true); // baseline — don't announce hazards already known from route creation/checks
  // Prime the focus/bearing system on the next waypoint right away — see
  // _updateFollowProgress's matching sync, which keeps this current as legs
  // advance. Together these make "bearing" (or a tap on #focus-btn) answer
  // "bearing and distance to next waypoint" the instant following starts,
  // with no separate command needed for the common case.
  const firstLegPt = route.points[_followingLegIdx];
  Query.setFocus(firstLegPt.lat, firstLegPt.lon, `${route.name} — waypoint ${_followingLegIdx + 1}`, 'waypoint');
  _updateFocusButton();
  _followFocusLegIdx = _followingLegIdx;
  _appEl.classList.add('following-active');
  _updateActiveStrip();
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
// State + browser-API calls live in wake_lock.js; this is just the DOM glue.
function _updateWakeLockButton() {
  if (!wakeLockBtn) return;
  const enabled = WakeLock.isEnabled();
  wakeLockBtn.textContent = enabled ? '☀️ Awake' : '💤 Sleep OK';
  wakeLockBtn.title = enabled
    ? 'Screen stays awake — tap to allow it to sleep'
    : 'Screen may sleep — tap to keep it awake';
  wakeLockBtn.classList.toggle('wake-active', enabled);
}

wakeLockBtn?.addEventListener('click', () => {
  WakeLock.setEnabled(!WakeLock.isEnabled());
  _updateWakeLockButton();
  if (WakeLock.isEnabled()) WakeLock.request(setStatus); else WakeLock.release();
  _closeScreenMenu();
});

// The Wake Lock spec auto-releases the sentinel whenever the tab is backgrounded
// (fires its own 'release' handler on its own) — re-request it on return, matching
// this codebase's one-listener-per-feature convention (no shared visibility dispatcher).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') WakeLock.request(setStatus);
});

// ── Anchor Watch ──────────────────────────────────────────────────────────────
// Piggybacks on the single shared GPS callback (see _checkAnchorWatch, called
// from the same place Track recording samples fixes) rather than opening a
// second geolocation watch or a setInterval poller — the only new per-tick
// cost is one haversine distance call, occasionally followed by redrawing one
// L.circle. Reliability, not the monitoring itself, is the real resource
// question: this only runs while the screen is on and the tab is foregrounded
// (see WakeLock.request above), a hard platform limit with no workaround, so
// arming it forces the wake lock on and says so plainly.

function _renderAnchorWatchCircle() {
  AnchorWatch.renderCircle(_map);
}

function _updateAnchorWatchButton() { _updateActiveStrip(); }

// ── Active strip (#active-strip) ─────────────────────────────────────────────
// What's running right now — track recording, anchor watch — with its Stop
// (and Silence) button, visible in every mode including Underway. Refreshed
// on every state change and GPS fix, plus a slow timer for elapsed time.
function _fmtElapsed(ms) {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
function _updateActiveStrip() {
  const recEl = document.getElementById('as-rec');
  const ancEl = document.getElementById('as-anchor');
  if (!recEl || !ancEl) return;
  if (_trackRecActive) {
    let nm = 0;
    for (let i = 1; i < _trackRecPoints.length; i++) {
      const a = _trackRecPoints[i - 1], b = _trackRecPoints[i];
      nm += Query.distanceNm(a.lon, a.lat, b.lon, b.lat);
    }
    const what = _followingRouteName ? `Following “${_followingRouteName}”` : 'Recording track';
    document.getElementById('as-rec-text').textContent =
      `● ${what} · ${nm.toFixed(1)} nm · ${_fmtElapsed(Date.now() - (_trackRecStartMs || Date.now()))}`;
    recEl.style.display = '';
  } else {
    recEl.style.display = 'none';
  }
  if (AnchorWatch.isArmed()) {
    const alarming = AnchorWatch.isAlarming();
    const a = AnchorWatch.getAnchor();
    const pos = GPS.getPosition();
    const away = a && pos ? Math.round(Query.distanceNm(a.lon, a.lat, pos.lon, pos.lat) * 6076.12) : null;
    const silenced = AnchorWatch.isSilenced();
    document.getElementById('as-anchor-text').textContent =
      `⚓ ${alarming ? (silenced ? 'Dragging (silenced) — ' : 'DRAGGING — ') : 'Anchor watch '}${AnchorWatch.getRadiusFt()} ft` + (away !== null ? ` · ${away} ft from anchor` : '');
    ancEl.classList.toggle('alarming', alarming && !silenced);
    anchorWatchSilenceBtn.style.display = alarming && !silenced ? '' : 'none';
    ancEl.style.display = '';
  } else {
    ancEl.style.display = 'none';
  }
  _appEl.classList.toggle('activity-on', _trackRecActive || AnchorWatch.isArmed());
  // The start buttons double as stop while running.
  const boatTrack = document.getElementById('boat-ctx-track');
  if (boatTrack) boatTrack.innerHTML = _trackRecActive ? '&#9632; Stop tracking' : '&#9679; Start tracking';
  const tpRecord = document.getElementById('tp-record');
  if (tpRecord) tpRecord.innerHTML = _trackRecActive ? '&#9632; Stop recording' : '&#9679; Record a new track';
  const boatAnchor = document.getElementById('boat-ctx-anchor');
  if (boatAnchor) boatAnchor.innerHTML = AnchorWatch.isArmed() ? '&#9632; Stop anchor watch' : '&#9875; Anchor watch here';
}
function _toggleTrackRecording() {
  if (_trackRecActive) { _stopTrackRecording(); return; }
  _startTrackRecording();
  const msg = 'Recording your track — Stop is at the top right.';
  setStatus(msg); showResponse(msg); TTS.sayImmediate('Recording your track.');
}
document.getElementById('boat-ctx-track')?.addEventListener('click', () => { _hideBoatCtx(); _toggleTrackRecording(); });
document.getElementById('tp-record')?.addEventListener('click', () => _toggleTrackRecording());
document.getElementById('boat-ctx-anchor')?.addEventListener('click', () => {
  _hideBoatCtx();
  if (AnchorWatch.isArmed()) _stopAnchorWatch(); else _openAnchorWatchForm();
});
setInterval(() => { if (_trackRecActive || AnchorWatch.isArmed()) _updateActiveStrip(); }, 30000);

// Called from the shared GPS callback on every fix; AnchorWatch.check()
// throttles internally so it costs nothing on fixes that arrive faster
// than its own check interval, and only invokes onButtonUpdate on an
// actual armed/alarming state transition, not every fix.
function _checkAnchorWatch(lat, lon) {
  AnchorWatch.check(lat, lon, { onStatus: setStatus, onButtonUpdate: _updateAnchorWatchButton });
}

function _closeAnchorWatchForm() {
  anchorWatchForm.style.display = 'none';
}

function _recoverAnchorWatch() {
  if (!AnchorWatch.recover({ onStatus: setStatus })) return;
  _renderAnchorWatchCircle();
  _updateAnchorWatchButton();
}

// The strip's Stop button (#anchor-watch-btn) — it's only shown while armed.
function _stopAnchorWatch() {
  if (!AnchorWatch.isArmed()) return false;
  const { wakeLockReleased } = AnchorWatch.disarm({ onStatus: setStatus });
  if (wakeLockReleased) _updateWakeLockButton();
  _renderAnchorWatchCircle();
  _updateAnchorWatchButton();
  return true;
}
anchorWatchBtn?.addEventListener('click', () => { _stopAnchorWatch(); });

// Opened from the boat's menu ("Anchor watch here"); the form now lives in
// #active-strip, so it works in Underway too.
function _openAnchorWatchForm() {
  anchorWatchRadiusInput.value = AnchorWatch.getRadiusFt();
  anchorWatchForm.style.display = 'flex';
}
function _armAnchorWatch(radiusFt) {
  const pos = GPS.getPosition();
  if (!pos) {
    setStatus('No position fix yet — cannot arm anchor watch.');
    return false;
  }
  _closeAnchorWatchForm();
  const { wakeLockForced } = AnchorWatch.arm(pos.lat, pos.lon, Math.max(20, radiusFt || 150), { onStatus: setStatus });
  if (wakeLockForced) _updateWakeLockButton();
  _renderAnchorWatchCircle();
  _updateAnchorWatchButton();
  return true;
}
anchorWatchStartBtn?.addEventListener('click', () => _armAnchorWatch(Number(anchorWatchRadiusInput.value)));

anchorWatchCancelBtn?.addEventListener('click', () => _closeAnchorWatchForm());

anchorWatchSilenceBtn?.addEventListener('click', () => {
  AnchorWatch.silence(setStatus);
  _updateAnchorWatchButton();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && anchorWatchForm.style.display !== 'none') _closeAnchorWatchForm();
});
document.addEventListener('click', (e) => {
  if (anchorWatchForm.style.display === 'none') return;
  if (anchorWatchForm.contains(e.target) || e.target.closest?.('#boat-ctx-anchor')) return;
  _closeAnchorWatchForm();
}, { capture: true });

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
      _updateActiveStrip();
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

// Per direct request: if the app closes (crash, killed in background, an
// accidental reload) while a route is open for editing, reopening it should
// drop straight back into editing that same route rather than starting
// fresh. EDITING_ROUTE_KEY only survives a page load when edit mode was
// never cleanly exited — see the key's own comment — so no confirmation
// prompt is needed here, unlike _recoverInProgressTrack's: there's nothing
// ambiguous to ask about, just resume.
function _recoverEditMode() {
  const name = localStorage.getItem(EDITING_ROUTE_KEY);
  if (!name) return;
  const routes = JSON.parse(localStorage.getItem(ROUTE_KEY) || '[]');
  const idx = routes.findIndex(r => r.name === name);
  if (idx === -1) { localStorage.removeItem(EDITING_ROUTE_KEY); return; }
  const found = _enterEditMode(idx);
  // Same rule _enterEditMode's other callers follow: don't let a routine
  // status announcement cut off a hazard warning that just fired instead.
  if (!found.length) {
    const msg = `Resumed editing "${name}" from before reload.`;
    setStatus(msg);
    TTS.sayImmediate(msg);
  }
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
document.getElementById('test-pos-cancel').addEventListener('click', _closeTestPosForm);
document.getElementById('cruise-cancel').addEventListener('click', () => { cruiseForm.style.display = 'none'; });

// ── Search: jump the map to a place/coordinate and drop a real, addressable pin ──
// Deliberately independent of the boat/test-position — this is "show me
// where X is," not "pretend I'm at X." Reuses the exact same
// coordinate-or-place resolution _test-pos-form_'s Set button already relies
// on (parseCoordinate, then server-backed then local place lookup). Per
// direct request, the dropped pin is a real, addressable waypoint (SP001,
// SP002, ...) — draggable, sayable/typeable as an AutoRoute destination,
// everything _refreshWaypointLayer already gives a regular waypoint — just
// tagged type:'search' so it renders with the teardrop pin icon instead of
// the plain square, and carries the resolved place/coords as a `note` for
// its popup (see saveUserWaypoint/_refreshWaypointLayer).

function _closeSearchForm() {
  searchForm.style.display = 'none';
  searchInput.style.borderColor = '';
}

searchBtn.addEventListener('click', () => {
  const isOpen = searchForm.style.display !== 'none';
  _closeTestPosForm();
  _closeLocationMenu();
  cruiseForm.style.display = 'none';
  if (isOpen) { _closeSearchForm(); return; }
  searchForm.style.display = 'flex';
  searchInput.focus();
});

async function _runSearch() {
  const raw = searchInput.value.trim();
  if (!raw) return;
  let coord = parseCoordinate(raw);
  if (!coord) coord = await Query.findPlaceOnServer(raw) || Query.findPlaceByName(raw);
  if (!coord) {
    searchInput.style.borderColor = 'var(--danger)';
    setTimeout(() => { searchInput.style.borderColor = ''; }, 1500);
    return;
  }
  await loadLeaflet();
  _ensureMap();
  document.getElementById('map-container').style.display = 'block';
  _mapContainer.classList.remove('map-compact', 'list-focus', 'input-focus');
  _closeSearchForm();
  searchInput.value = '';
  const name = WaypointsStorage.nextSearchPinName();
  const note = coord.name || formatPositionDisplay(coord.lat, coord.lon);
  saveUserWaypoint(name, coord.lat, coord.lon, 'search', note);
  Query.setActiveWaypoint(coord.lat, coord.lon, name);
  if (!_waypointsVisible) _setWaypointsVisible(true);
  // Same CSS-transition-then-resize timing _showBoatPosition/flashMarker use
  // elsewhere — the map container may still be mid-expand from the class
  // removal above, and invalidateSize()/setView() before that finishes can
  // compute against the wrong (collapsed) container size.
  setTimeout(() => {
    _map.invalidateSize();
    _map.setView([coord.lat, coord.lon], Math.max(_map.getZoom() || 13, 13));
  }, 300);
  setStatus(`${name}: ${note}`);
}

document.getElementById('search-go').addEventListener('click', _runSearch);
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') _runSearch(); });
document.getElementById('search-cancel').addEventListener('click', _closeSearchForm);

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
  // A route open in edit mode, mid-sketch, or mid-draw renders through its
  // own layer(s) (_renderEditLayers/_renderSketchLayers/draw-mode rubber
  // band), entirely separate from _savedRoutesLayer — the hidden-names loop
  // below never touches them, so without this, "Clear Screen" left whatever
  // route you were actively working on fully visible. Exiting each mode
  // tears its own layer down; the hidden-names loop then covers everything.
  if (_editMode) _exitEditMode();
  if (_sketchMode) _exitSketchMode();
  if (_drawMode) _exitDrawRouteMode();

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
  // Markers too (direct request 2026-10-07): SP/waypoint pins and every
  // Test Set's TS markers are HIDDEN, never deleted — they come back with
  // the Waypoints / Test Sets panels' show toggles, and a newly set marker
  // turns waypoints back on by itself (_dropMarkerAt).
  if (_waypointsVisible) _setWaypointsVisible(false);
  for (const id of TestSetsStorage.loadVisibleTestSetIds()) TestSetsStorage.setTestSetVisible(id, false);
  _refreshTestSetLayer();
  _currentMarkerLL = null;

  // Per explicit request: tidy Node Ops too, not just map layers —
  // collapsed (not toggled) so this is always a clean-up, never
  // accidentally re-expands it if it was already tucked away. Global Ops
  // no longer has a collapse state at all — its buttons are permanent now.
  document.getElementById('edit-tools-panel').classList.add('collapsed');
  document.getElementById('etp-title').classList.add('collapsed');

  const msg = 'Screen cleared.';
  setStatus(msg);
  TTS.sayImmediate(msg);
}

// Clear Screen is reached via the Screen tile's menu.
function _closeScreenMenu() { screenMenu.style.display = 'none'; }

// Import GPX markers/routes — reached via its own top-level Import tile.
function _closeImportMenu() { importMenu.style.display = 'none'; }

screenMenuBtn.addEventListener('click', () => {
  const isOpen = screenMenu.style.display !== 'none';
  if (isOpen) { _closeScreenMenu(); return; }
  screenMenu.style.display = 'flex';
});
document.getElementById('screen-menu-clear').addEventListener('click', () => {
  _closeScreenMenu();
  _clearScreen();
});
// Top-level button (status-tiles-2), not tucked in a menu — per direct
// request, this and the other primary actions (Routes/Tracks/Samples)
// stay one tap away rather than buried behind Screen. Opens in a new
// tab, not the app's own window — this is a PWA, and navigating away in
// place would abandon whatever's on screen (a route mid-edit, GPS
// tracking, Underway mode). Needs real internet; the app itself stays
// fully usable offline either way, this is just a way back to the
// marketing/tutorial site for whoever has a signal.
document.getElementById('tutorial-btn').addEventListener('click', () => {
  window.open('https://egilchri.github.io/AudioChart/sailors/#demo', '_blank', 'noopener');
});

// Underway is a pure visibility toggle — see #app.underway-mode in
// app.css — hides the top bar, #right-rail, zoom/pan, and tide down to
// the compass + bearing/heading-speed. A real slide switch (checkbox-
// driven, see #underway-btn in index.html/app.css), always visible in
// both states — its own positioning comment in app.css explains why it
// lives outside #map-overlay-status. Slid right (checked) = underway.
// The one deliberate exception to "the user flips this themselves":
// _startVirtualJourney forces it on for the run's duration (a rehearsal
// should look underway) and _stopVirtualJourney always forces it back
// off — not a restore-to-prior-state, since that left the user stranded
// without Screen/Map Type/Location whenever Underway already happened to
// be on before the journey started.
const _underwayCheckbox = document.getElementById('underway-checkbox');
function _setUnderwayMode(on) {
  _appEl.classList.toggle('underway-mode', on);
  _syncLeftRailStack(); // re-shows #left-rail-zoom-pan on the way back off — see _exitEditMode's own call for why
  localStorage.setItem('audiochart-underway-mode', on ? '1' : '');
  _underwayCheckbox.checked = on;
}
_underwayCheckbox.addEventListener('change', () => {
  _setUnderwayMode(_underwayCheckbox.checked);
});
if (localStorage.getItem('audiochart-underway-mode') === '1') _setUnderwayMode(true);

// Zoom slider + pan pad shrink together to one small tab — direct request
// 2026-10-04 ("put the zoom and pan widgets as a unit that can be shrunk").
// Remembered across reloads.
const _zoomPanRail = document.getElementById('left-rail-zoom-pan');
const _zoomPanToggle = document.getElementById('zoom-pan-toggle');
function _setZoomPanCollapsed(collapsed) {
  _zoomPanRail.classList.toggle('zp-collapsed', collapsed);
  _zoomPanToggle.textContent = collapsed ? '\u2295 \u25BE' : '\u25B4';
  _zoomPanToggle.title = collapsed ? 'Show the zoom & pan controls' : 'Shrink the zoom & pan controls';
  try { localStorage.setItem('audiochart-zoompan-collapsed', collapsed ? '1' : ''); } catch {}
}
_zoomPanToggle.addEventListener('click', () => _setZoomPanCollapsed(!_zoomPanRail.classList.contains('zp-collapsed')));
let _storedZoomPan = null;
try { _storedZoomPan = localStorage.getItem('audiochart-zoompan-collapsed'); } catch {}
_setZoomPanCollapsed(_storedZoomPan === '1');

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && screenMenu.style.display !== 'none') _closeScreenMenu();
  if (e.key === 'Escape' && importMenu.style.display !== 'none') _closeImportMenu();
});
document.addEventListener('click', (e) => {
  if (screenMenu.style.display === 'none') return;
  if (screenMenu.contains(e.target) || screenMenuBtn.contains(e.target)) return;
  _closeScreenMenu();
}, { capture: true });
document.addEventListener('click', (e) => {
  if (importMenu.style.display === 'none') return;
  if (importMenu.contains(e.target) || importMenuBtn.contains(e.target)) return;
  _closeImportMenu();
}, { capture: true });

// ── Route download ────────────────────────────────────────────────────────────

function _isPWA() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

// "Navigate with care" notice (2026-10-05, ahead of a public beta). Shown on
// first open and whenever DISCLAIMER_VERSION changes (bump it if the
// wording changes materially, so everyone sees the new text once). Not
// shown for ?demo recordings. Re-openable from the About panel.
const DISCLAIMER_VERSION = '2'; // v2 (2026-10-05): "Navigate with care" wording, re-shown once to everyone
const DISCLAIMER_KEY = 'audiochart-disclaimer-accepted';
function _showDisclaimer() {
  const overlay = document.getElementById('disclaimer-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  document.getElementById('disclaimer-accept')?.focus();
}
function _initDisclaimer() {
  const overlay = document.getElementById('disclaimer-overlay');
  if (!overlay) return;
  document.getElementById('disclaimer-accept').addEventListener('click', () => {
    try { localStorage.setItem(DISCLAIMER_KEY, DISCLAIMER_VERSION); } catch {}
    overlay.style.display = 'none';
  });
  document.getElementById('about-disclaimer-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    _showDisclaimer();
  });
  if (new URLSearchParams(location.search).has('demo')) return;
  let accepted = null;
  try { accepted = localStorage.getItem(DISCLAIMER_KEY); } catch {}
  if (accepted !== DISCLAIMER_VERSION) _showDisclaimer();
}

const ONBOARDING_DISABLED = true;
async function checkOnboarding() {
  // Disabled 2026-10-03 (v763). #welcome-overlay's z-index:100 sat below
  // Leaflet's panes, so the map always painted over it — this onboarding
  // was never actually visible since it was added. But it still covered the
  // bottom banners (z auto) with its 92% navy fill, making the Autoroute
  // "Tap the map to set the destination" prompt unreadable on any browser
  // with no offline data or an undismissed install step. Making it visible
  // would force a new, untested first-run flow on everyone, so per user
  // decision it stays off; the code below is kept in case it's revived.
  document.getElementById('welcome-overlay').style.display = 'none';
  if (ONBOARDING_DISABLED) return;
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

// onProgress is optional (default no-op) — every existing caller (the
// CRUISE_PROFILES buttons in init()) is unaffected; only the region-offer
// banner's Download button passes one, so it can mirror progress into its
// own on-screen text instead of relying solely on routeBtn's text (a small,
// easy-to-miss button in the top status row, far from wherever the user
// actually tapped Download) and setStatus (which — confirmed elsewhere this
// session — writes to a permanently-hidden element and produces no visible
// feedback at all on its own).
async function runRouteDownload(cruiseName, onProgress = () => {}) {
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
    onProgress(`Downloading ${cruiseName} chart data…`);
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
      _refreshNavaidOverlay(); // otherwise the OLD region's navaids stay on screen after a switch
      setStatus(`Chart data ready — caching satellite tiles…`);
      onProgress(`Chart data ready — caching satellite tiles…`);
    } catch (e) {
      const reason = e.name === 'AbortError' ? 'timed out' : e.message;
      setStatus(`Download failed: ${reason}`);
      onProgress(`Download failed: ${reason}`);
      routeBtn.textContent = '⬇ Region';
      routeBtn.disabled = false;
      if (offlineBtn) offlineBtn.disabled = false;
      return;
    }
    // Cache satellite tiles for each stop
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      routeBtn.textContent = `🛰 ${i + 1}/${stops.length}`;
      await Query.cacheSatelliteTiles(stop.lat, stop.lon, (done, total) => {
        const msg = `Satellite tiles ${stop.name}: ${done}/${total}`;
        setStatus(msg);
        onProgress(msg);
      });
    }
    // Prefetch tide/current for each stop
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      routeBtn.textContent = `🌊 ${i + 1}/${stops.length}`;
      await _prefetchTideCurrentForOffline(stop.lat, stop.lon, msg => { setStatus(`${stop.name}: ${msg}`); onProgress(`${stop.name}: ${msg}`); });
    }
    routeBtn.textContent = '✓ Region cached';
    setStatus(`${cruiseName} ready — chart data and satellite tiles cached.`);
    onProgress(`${cruiseName} ready — chart data and satellite tiles cached.`);
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
    onProgress(`Downloading ${stop.name} (${i + 1} of ${stops.length})…`);
    try {
      lastResult = await Query.prepareOffline(stop.lat, stop.lon, 25);
    } catch (e) {
      const reason = e.name === 'AbortError' ? 'timed out' : e.message;
      setStatus(`Download failed at ${stop.name}: ${reason}`);
      onProgress(`Download failed at ${stop.name}: ${reason}`);
      routeBtn.textContent = '⬇ Region';
      routeBtn.disabled = false;
      if (offlineBtn) offlineBtn.disabled = false;
      return;
    }
    routeBtn.textContent = `🛰 ${i + 1}/${stops.length}`;
    await Query.cacheSatelliteTiles(stop.lat, stop.lon, (done, total) => {
      const msg = `Satellite tiles ${stop.name}: ${done}/${total}`;
      setStatus(msg);
      onProgress(msg);
    });
    routeBtn.textContent = `🌊 ${i + 1}/${stops.length}`;
    await _prefetchTideCurrentForOffline(stop.lat, stop.lon, msg => { setStatus(`${stop.name}: ${msg}`); onProgress(`${stop.name}: ${msg}`); });
  }
  routeBtn.textContent = '✓ Region cached';
  setStatus(`${cruiseName} region complete — ${lastResult.total} features + satellite tiles cached.`);
  onProgress(`${cruiseName} region complete — ${lastResult.total} features + satellite tiles cached.`);
  routeBtn.disabled = false;
  if (offlineBtn) offlineBtn.disabled = false;
  checkOnboarding();
}

// ── Initialisation ────────────────────────────────────────────────────────────

// Chromium-only (Chrome/Edge desktop, installed app): lets the page draw
// live content directly into the OS-drawn title-bar strip instead of an
// in-page element, via manifest.json's display_override + the
// env(titlebar-area-*) CSS vars sized on #wco-titlebar. No effect at all on
// unsupported browsers/platforms (mobile, Firefox, Safari) — the in-page
// #status-title-bar just stays the one in use, no fallback logic needed
// beyond the plain CSS `body.wco-active` toggle below.
function _syncWindowControlsOverlay() {
  if (!('windowControlsOverlay' in navigator)) return;
  const sync = () => document.body.classList.toggle('wco-active', navigator.windowControlsOverlay.visible);
  sync();
  navigator.windowControlsOverlay.addEventListener('geometrychange', sync);
}

async function init() {
  _loadOfflineCache();
  setStatus('Waiting for GPS...');
  _syncWindowControlsOverlay();
  // Best-effort: ask the browser not to evict IndexedDB under storage
  // pressure. Matters more now that a region download persists in its own
  // slot rather than getting replaced by the next one — multiple downloaded
  // regions is real, if still modest (single-digit MB per region), data
  // worth keeping around. Most browsers grant this silently based on site
  // engagement with no user-visible prompt; safe to ignore if unsupported
  // or denied.
  navigator.storage?.persist?.().catch(() => {});

  Query.loadStoredFocus();
  _updateFocusButton();
  Query.loadStoredActiveWaypoint();
  _recoverInProgressTrack();
  _updateActiveStrip();

  if ('wakeLock' in navigator) {
    wakeLockBtn.style.display = 'inline-block';
    _updateWakeLockButton();
    WakeLock.request(setStatus);
  }

  // Show the map immediately on all devices (sidebar was removed in v198)
  loadLeaflet().then(() => {
    document.getElementById('map-container').style.display = 'block';
    _ensureMap();
    _map.invalidateSize();
    // _syncLeftRailStack() is otherwise only wired to reactive events
    // (follow-progress toggle, Virtual Journey start, window resize) — a
    // plain cold load never called it, so every fresh page view rendered
    // the left instrument column (#zoom-slider-wrap/#pan-controls-wrap) at
    // their hardcoded CSS top: values instead of the measured stack this
    // function computes. Reported live as the pan controls covering the
    // zoom slider — the same class of bug this function was written to
    // fix (see its own comment), just never applied at the one moment
    // that actually matters for most users: first paint.
    _syncLeftRailStack();
    _initDraggableGroups();
    _recoverAnchorWatch();
    _recoverEditMode();
    // A deliberate extra beat once the map is actually ready — per direct
    // request, so the splash doesn't just flash past on a fast/cached load.
    setTimeout(_hideAppSplash, 1000);
  }).catch(() => { _hideAppSplash(); });

  // If opened via QR code with ?server=, persist the server URL and clean the address bar.
  const _params = new URLSearchParams(location.search);
  const _serverParam = _params.get('server');
  if (_serverParam) {
    localStorage.setItem('audiochart_server_url', _serverParam);
    history.replaceState(null, '', location.pathname);
  }

  // Same pattern as ?server= above: visiting once with ?dev=1 persists the
  // dev unlock (see DEV_UNLOCK_KEY/_visibleCruiseProfiles) so in-progress
  // regions come back everywhere for continued development; ?dev=0 re-locks.
  const _devParam = _params.get('dev');
  if (_devParam === '1') {
    localStorage.setItem(DEV_UNLOCK_KEY, '1');
    history.replaceState(null, '', location.pathname);
  } else if (_devParam === '0') {
    localStorage.removeItem(DEV_UNLOCK_KEY);
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

  // Region download is reached via the Location tile's menu (see
  // location-menu-region's click handler above). Only shows regions visible
  // to this user — see _visibleCruiseProfiles: in-progress ('dev: true')
  // regions stay hidden from normal use, unlocked via the ?dev=1 URL param.
  Object.keys(_visibleCruiseProfiles()).forEach(cruiseName => {
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
      Query.mergeUserWaypoints(WaypointsStorage.loadUserWaypoints());
      setStatus('Ready. (offline)');
      // Direct report (2026-09-29): "navaids by default" wasn't working —
      // real cause, this real boot path never told the overlay to redraw
      // once chart data actually finished loading. The map may already be
      // visible on a fresh load with nothing else pending to trigger a
      // redraw (no pan/zoom yet); _refreshNavaidOverlay() itself no-ops
      // safely if the map isn't up yet.
      _refreshNavaidOverlay();
    }).catch(() => {});
  }

  GPS.startGPS(
    async (lat, lon, accuracy, source, heading, speedKt) => {
      showPosition(lat, lon, accuracy, source);
      _refreshYouLayer();
      // Virtual Journey has a real, meaningful heading every tick (the current
      // route segment's bearing) — swap in the bare, rotated boat icon so it
      // visibly points toward the next waypoint instead of sitting as the
      // static circled glyph real/unknown-heading fixes use.
      if (source === 'virtual' && heading != null) _setBoatIconRotated(heading);
      _updateFocusRay();
      _checkAnchorWatch(lat, lon);
      if (_trackRecActive || AnchorWatch.isArmed()) _updateActiveStrip();
      if (source === 'manual' || source === 'default') {
        _lastFixForHeading = null; // don't let a teleport corrupt the next real fallback calc
        _updateHeadingRay(lat, lon, null, null);
        _updateHeadingSpeedReadout(null, null);
      } else {
        const computed = _computeHeadingSpeed(lat, lon, heading, speedKt);
        _updateHeadingRay(lat, lon, computed.headingDeg, computed.speedKt);
        _updateHeadingSpeedReadout(computed.headingDeg, computed.speedKt);
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
          Query.mergeUserWaypoints(WaypointsStorage.loadUserWaypoints());
          setStatus('Ready.');
          _refreshNavaidOverlay(); // see the standalone-boot path's own comment above
        } catch (e) {
          setStatus('Chart data unavailable. Try reloading.');
          showResponse('Could not load chart data. If offline, ensure data files are cached.');
        }
      } else {
        Query.refreshIfNeeded(lat, lon).catch(() => {});
      }
    },
    (err) => {
      _statusGpsLabel = `GPS: ${err}`;
      _statusGpsCls   = 'gps-error';
      _renderStatusCombo();
      // watchPosition retries on its own (see gps.js's 15s timeout) and will
      // call back in here again if it keeps failing — say so, so a stale-looking
      // status reads as "still trying" rather than "the app is stuck." Permission
      // denial is the one case retrying won't fix, so it's left unadorned.
      setStatus(err === 'GPS permission denied'
        ? err
        : `${err} — retrying automatically. Map and offline chart data still work without a fix.`);
    },
    (lat, lon) => Query.coverageLevelAt(lon, lat) === 'core'
  );

  // This ship covers Penobscot Bay only, and browser geolocation was just
  // set watching above — while testing/developing away from the boat, a
  // real fix for wherever the device actually is would otherwise become
  // the current position (if only briefly) and correctly report that
  // real, irrelevant location has no coverage, moments before a deliberate
  // Location -> Spoof Location override reacted to it (see INCIDENTS.md/
  // CHANGELOG.md, 2026-09-25 — three prior attempts to patch this by
  // delaying/gating the coverage *announcement* itself all missed the
  // simpler fix: never treat that real fix as the current position at all
  // unless it's actually somewhere useful — see startGPS's shouldAccept
  // param just above). Showing Rockland Harbor — the heart of Penobscot
  // Bay — immediately, and only ever switching to a real GPS fix once it
  // reports being genuinely inside coverage, makes the confusing case
  // structurally impossible rather than papered over. Any explicit
  // Location -> Spoof Location / Virtual Journey position still overrides
  // this immediately and unconditionally, same as always. Called AFTER
  // startGPS (not before) so the onPosition callback registered above is
  // already wired up when this fires — calling it first left the initial
  // placeholder fix silently unrendered (no boat marker, no status update)
  // since nothing was listening yet, a real bug caught before shipping.
  GPS.setDefaultPosition(44.103, -69.088);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`).catch(() => {});
  }

  if (new URLSearchParams(location.search).has('demo')) {
    runDemoMode();
  }
  const _longtestParam = new URLSearchParams(location.search).get('longtest');
  if (_longtestParam) _runLongtestFromUrl(_longtestParam);
}

// ?longtest=TS001,10 — starts Longtest(setName, iterations) once the map and
// chart data are ready, then shows the results table on screen. For devices
// with no reachable console (iPhone/Pixel simulators, real phones). Direct
// request 2026-10-05. The parameter is stripped from the address bar as the
// run starts, so a reload (or reopening an installed app) can't rerun it.
async function _runLongtestFromUrl(param) {
  // ?longtest=SET,N[,SECONDS] — the optional third part stops starting new
  // legs after that many seconds (see untilSec on Longtest).
  const [name, n, until] = param.split(',');
  const iterations = Math.max(1, Math.min(50, parseInt(n, 10) || 3));
  const untilSec = parseFloat(until) > 0 ? parseFloat(until) : null;
  const url = new URL(location.href);
  url.searchParams.delete('longtest');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  await Query.whenLandLoaded();
  while (!_map) await new Promise(r => setTimeout(r, 200));
  await new Promise(r => setTimeout(r, 1500)); // let startup panels settle
  document.getElementById('sr-close')?.click();
  // Longtest shows its own results table; only an error needs showing here.
  try { await window.Longtest(name, iterations, { untilSec }); }
  catch (e) { _showLongtestResults(name, null, e.message); }
}

function _showLongtestResults(name, rows, err) {
  document.getElementById('longtest-results')?.remove();
  const el = document.createElement('div');
  el.id = 'longtest-results';
  const body = err
    ? `<p class="lt-err">${escapeHtml(err)}</p>`
    : `<table><tr><th>#</th><th>Leg</th><th>Map</th><th>Result</th><th>nm</th><th>s</th></tr>${rows.map(r =>
        `<tr class="${r.result === 'PASS' ? 'lt-pass' : r.result.startsWith('WARN') ? 'lt-warn' : 'lt-fail'}"><td>${r.iter}</td><td>${escapeHtml(r.from)} → ${escapeHtml(r.to)}</td><td>${escapeHtml(r.map || '')}</td><td>${escapeHtml(r.result)}</td><td>${r.nm ?? ''}</td><td>${r.ms != null ? (r.ms / 1000).toFixed(1) : ''}</td></tr>`
      ).join('')}</table>`;
  const passed = rows ? rows.filter(r => r.result === 'PASS').length : 0;
  const failed = rows ? rows.filter(r => r.result.startsWith('FAIL')).length : 0;
  el.innerHTML = `<div class="lt-head"><strong>Longtest ${escapeHtml(name)}</strong>
      <span>${rows ? `${rows.length} legs · ${passed} pass · ${failed} fail` : 'error'}</span>
      <button type="button" aria-label="Close">&#10005;</button></div>${body}`;
  el.querySelector('button').addEventListener('click', () => el.remove());
  document.body.appendChild(el);
}

// ── Demo mode ─────────────────────────────────────────────────────────────────
// Activated by adding ?demo to the URL.  Sets a test position and runs through
// a sequence of commands automatically — useful for screen-recording demos.

async function runDemoMode() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hud = document.getElementById('demo-hud');
  const stepBadge = document.getElementById('demo-step-badge');
  const show = msg => { if (hud) hud.textContent = msg; };
  // Speaks the step aloud for anyone watching ?demo live in a real browser
  // (real TTS, same voice/engine as the rest of the app) — the recorded
  // clip embedded on the marketing page can't capture that live audio, so
  // it's narrated separately in post from the same step text; see the
  // Warren Island block below for the step list this mirrors.
  const showStep = (n, total, text) => {
    if (stepBadge) { stepBadge.textContent = `STEP ${n} OF ${total}`; stepBadge.style.display = 'block'; }
    show(text);
    TTS.sayImmediate(text);
  };

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

  // Discover Warren Island's anchorage and route to it — narrated, numbered
  // steps (see showStep above), matching what's actually recorded for the
  // sailors landing page's demo clip: switch to Anchorages mode via the
  // same real UI path a user would use (the map-layer-select 'change'
  // event), pan there with the real on-screen pan buttons (not an instant
  // jump — confirmed live that a raw drag gesture doesn't register as a
  // real Leaflet pan under CDP automation, but clicking the actual pan
  // buttons does, the same as a real tap), fire a real click on the
  // marker to open its popup, then click its real "Navigate to here"
  // button — genuine AutoRoute, not staged.
  const WARREN_ISLAND_STEPS = 4;
  showStep(1, WARREN_ISLAND_STEPS,
    "Let's find somewhere to anchor for the night. I'll switch the chart into Anchorages mode, " +
    "which highlights moorings and anchorages all along the coast. Each one comes with real " +
    "details on depth, holding ground, and local notes.");
  const layerSelect = document.getElementById('map-layer-select');
  layerSelect.value = 'anchorages';
  layerSelect.dispatchEvent(new Event('change'));
  await sleep(13000);

  showStep(2, WARREN_ISLAND_STEPS,
    "Now I'll pan up the coast toward Islesboro, looking for a quiet spot to settle in. Warren " +
    "Island State Park sits just off Gilkey Harbor, a favorite stop for sailors working their way " +
    "through Penobscot Bay. It's got a handful of moorings, plus room to anchor nearby.");
  const panNorth = document.getElementById('pan-north');
  const panEast = document.getElementById('pan-east');
  if (panNorth && panEast) {
    panNorth.click(); await sleep(500);
    panNorth.click(); await sleep(500);
    panEast.click();  await sleep(500);
  }
  await sleep(14000);

  const warrenIslandMarker = _findDocumentMarkerByTitle('Warren Island State Park — Anchorage & Moorings');
  if (warrenIslandMarker && _map) {
    const markerEl = warrenIslandMarker.getElement ? warrenIslandMarker.getElement() : null;
    if (markerEl) markerEl.classList.add('marker-speaking');
    showStep(3, WARREN_ISLAND_STEPS,
      "Tapping the marker brings up everything AudioChart knows about this anchorage. You'll see " +
      "mooring counts, nightly fees, and anchoring notes, pulled from real charts and cruising " +
      "guides. No need to dig through a paper guidebook while you're underway.");
    await sleep(1400);
    if (markerEl) markerEl.classList.remove('marker-speaking');
    warrenIslandMarker.fire('click'); // real Leaflet click — opens the popup, same as a tap
    await sleep(13000);

    showStep(4, WARREN_ISLAND_STEPS,
      "One tap on Navigate to here, and AudioChart plots a real route from your current position. " +
      "It threads the passage between the islands and ledges, steering clear of hazards along the " +
      "way. From here, it's ready to call out headings and distances the whole way in.");
    const navBtn = document.querySelector('.doc-popup-navigate');
    if (navBtn) {
      navBtn.scrollIntoView({ block: 'center' });
      await sleep(600);
      navBtn.click();
      await sleep(14000);
    }
  }
  if (stepBadge) stepBadge.style.display = 'none';
  await sleep(1500);

  // Open the full chart map if the button is visible
  if (opencpnBtn && opencpnBtn.style.display !== 'none') {
    show('▶  Opening full chart view…');
    opencpnBtn.click();
    await sleep(5000);
  }

  show('✓  Demo complete');
  await sleep(2000);
  hud.style.display = 'none';
  if (stepBadge) stepBadge.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', () => {
  // Populate onboarding region buttons (Step 1) — see _visibleCruiseProfiles
  const obRegions = document.getElementById('ob-regions');
  Object.keys(_visibleCruiseProfiles()).forEach(name => {
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

  initCardStack();
  _initDisclaimer();
  init();
  checkOnboarding();
});
