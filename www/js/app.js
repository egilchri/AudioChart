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
const offlineBtn = document.getElementById('offline-btn');
const testPosBtn = document.getElementById('test-pos-btn');
const testPosForm = document.getElementById('test-pos-form');
const testPosInput = document.getElementById('test-pos-input');
const testPosSet = document.getElementById('test-pos-set');
const testPosClear = document.getElementById('test-pos-clear');

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

function setStatus(msg) { statusEl.textContent = msg; }
function showResponse(text) { responseEl.textContent = text; }

const SOURCE_LABEL = {
  'manual':        'TEST POSITION',
  'browser':       'PHONE GPS',
  'nmea':          'GPS PUCK',
  'opencpn-nmea':  'OPENCPN LIVE',
  'opencpn-ini':   'OPENCPN',
  'opencpn-track': 'OPENCPN TRACK',
};

function showPosition(lat, lon, accuracy, source) {
  positionEl.textContent = formatPositionDisplay(lat, lon);
  const label = SOURCE_LABEL[source] || source.toUpperCase();
  const accText = accuracy && !['opencpn-track', 'manual'].includes(source)
    ? ` ±${Math.round(accuracy)}m` : '';
  gpsStatusEl.textContent = `GPS: ${label}${accText}`;
  gpsStatusEl.className = source === 'manual'
    ? 'status-badge gps-test'
    : 'status-badge gps-ok';
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

    showResponse(response);
    TTS.sayImmediate(response);
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

testPosSet.addEventListener('click', () => {
  const raw = testPosInput.value.trim();
  const coord = parseCoordinate(raw);
  if (coord) {
    GPS.setManualPosition(coord.lat, coord.lon);
    testPosForm.style.display = 'none';
    testPosInput.value = '';
  } else {
    testPosInput.style.borderColor = 'var(--danger)';
    setTimeout(() => { testPosInput.style.borderColor = ''; }, 1500);
  }
});

testPosClear.addEventListener('click', () => {
  GPS.clearManualPosition();
  testPosForm.style.display = 'none';
});

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {
  setStatus('Waiting for GPS...');

  // Connect to Mac server BEFORE starting GPS so setServerBase is ready
  // when the first fix arrives and triggers loadData.
  const isMacServer = location.hostname === 'localhost' ||
                      !!location.hostname.match(/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./);
  const serverUrl = isMacServer
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
      offlineBtn.textContent = '⏳ Downloading...';
      try {
        const result = await Query.prepareOffline(pos.lat, pos.lon);
        offlineBtn.textContent = '✓ Offline ready';
        setStatus(`Offline data cached: ${result.count} features within ${result.radius_nm}nm.`);
      } catch (e) {
        offlineBtn.textContent = '⬇ Offline';
        setStatus('Offline download failed. Is the server running?');
      } finally {
        offlineBtn.disabled = false;
      }
    });
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

document.addEventListener('DOMContentLoaded', init);
