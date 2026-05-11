/**
 * GPS position provider.
 *
 * Source priority (highest wins):
 *   1. opencpn-nmea  — real-time NMEA from OpenCPN TCP output
 *   2. opencpn-track — OpenCPN last track point (from navobj.db poll)
 *   3. nmea          — USB GPS puck via server serial bridge
 *   4. browser       — navigator.geolocation (Android GPS)
 *
 * The Mac server WebSocket sends all server-side sources.
 * Browser geolocation runs in parallel as a fallback.
 */

const SOURCE_PRIORITY = {
  'manual':        6,   // user-entered test position — overrides everything
  'opencpn-nmea':  5,   // real-time NMEA from OpenCPN TCP output
  'nmea':          4,   // USB GPS puck via serial
  'opencpn-ini':   3,   // OwnShipLatLon from opencpn.ini (zero config)
  'opencpn-track': 2,   // last navobj.db track point
  'browser':       1,   // Android/browser geolocation
};

let currentPosition = null;
let watchId = null;
let wsGps = null;
let wsReconnectTimer = null;
let onPositionCallback = null;
let onErrorCallback = null;
let serverBaseUrl = null;

function priority(source) {
  return SOURCE_PRIORITY[source] ?? 0;
}

function updatePosition(lat, lon, accuracy, source) {
  // Only update if this source is at least as authoritative as the current one
  if (currentPosition && priority(source) < priority(currentPosition.source)) return;
  currentPosition = { lat, lon, accuracy, source };
  if (onPositionCallback) onPositionCallback(lat, lon, accuracy, source);
}

/** Start watching GPS. Calls onPosition(lat, lon, accuracy, source) on updates. */
export function startGPS(onPosition, onError) {
  onPositionCallback = onPosition;
  onErrorCallback = onError;

  if (!navigator.geolocation) {
    onError('Geolocation not available');
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      updatePosition(latitude, longitude, accuracy, 'browser');
    },
    (err) => {
      const msg = err.code === 1 ? 'GPS permission denied' :
                  err.code === 2 ? 'GPS position unavailable' :
                  'GPS timeout';
      if (onErrorCallback) onErrorCallback(msg);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

/**
 * Connect to Mac server WebSocket for server-side GPS sources
 * (GPS puck, OpenCPN NMEA, OpenCPN track).
 * Auto-reconnects if the connection drops.
 */
export function connectServer(baseUrl) {
  serverBaseUrl = baseUrl;
  _connectWS();
}

function _connectWS() {
  if (!serverBaseUrl) return;
  const wsUrl = serverBaseUrl.replace(/^http/, 'ws') + '/ws/gps';
  try {
    wsGps = new WebSocket(wsUrl);

    wsGps.onopen = () => {
      console.log('[gps] Connected to server GPS bridge');
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    };

    wsGps.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.lat && data.lon) {
          updatePosition(data.lat, data.lon, data.accuracy ?? 5, data.source ?? 'nmea');
        }
      } catch (_) {}
    };

    wsGps.onerror = () => {};

    wsGps.onclose = () => {
      wsGps = null;
      // Reconnect after 5s
      wsReconnectTimer = setTimeout(_connectWS, 5000);
    };
  } catch (_) {}
}

// Keep legacy name for compatibility with app.js
export function connectNMEA(baseUrl) {
  connectServer(baseUrl);
}

/** Set an explicit test position, overriding all other GPS sources. */
export function setManualPosition(lat, lon) {
  updatePosition(lat, lon, 0, 'manual');
}

/** Clear manual override so real GPS takes over again. */
export function clearManualPosition() {
  if (currentPosition?.source === 'manual') {
    currentPosition = null;
  }
}

export function isManualPosition() {
  return currentPosition?.source === 'manual';
}

export function getPosition() {
  return currentPosition;
}

export function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (wsGps) { wsGps.close(); wsGps = null; }
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
}
