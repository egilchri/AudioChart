/**
 * AudioChart — main application entry point.
 * Coordinates GPS, speech, and query modules.
 */

import * as Speech from './speech.js';
import * as TTS from './tts.js';
import * as GPS from './gps.js';
import { parseCommand } from './parser.js';
import * as Query from './query.js';
import { formatPositionDisplay } from './utils.js';

// DOM elements
const micBtn = document.getElementById('mic-btn');
const textForm = document.getElementById('text-form');
const textInput = document.getElementById('text-input');
const statusEl = document.getElementById('status-text');
const positionEl = document.getElementById('position-display');
const responseEl = document.getElementById('response-text');
const gpsStatusEl = document.getElementById('gps-status');
const speechStatusEl = document.getElementById('speech-status');
const historyList = document.getElementById('history-list');
const historyClear = document.getElementById('history-clear');

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
  const items = loadHistory().filter(t => t !== text); // deduplicate
  items.unshift(text);                                  // newest first
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

let dataLoaded = false;
let gpsReady = false;

function setStatus(msg) {
  statusEl.textContent = msg;
}

function showResponse(text) {
  responseEl.textContent = text;
}

const SOURCE_LABEL = {
  'browser':        'PHONE GPS',
  'nmea':           'GPS PUCK',
  'opencpn-nmea':   'OPENCPN LIVE',
  'opencpn-ini':    'OPENCPN',
  'opencpn-track':  'OPENCPN TRACK',
};

function showPosition(lat, lon, accuracy, source) {
  positionEl.textContent = formatPositionDisplay(lat, lon);
  const label = SOURCE_LABEL[source] || source.toUpperCase();
  const accText = accuracy && source !== 'opencpn-track' ? ` ±${Math.round(accuracy)}m` : '';
  gpsStatusEl.textContent = `GPS: ${label}${accText}`;
  gpsStatusEl.className = 'status-badge gps-ok';
}

async function handleCommand(transcript) {
  console.log('[AudioChart] handleCommand:', transcript);
  try {
    setStatus(`Heard: "${transcript}"`);
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
        response = 'I didn\'t understand that. Try asking about hazards, your position, or a specific place.';
    }

    showResponse(response);
    TTS.sayImmediate(response);
  } catch (err) {
    console.error('[AudioChart] handleCommand error:', err);
    showResponse(`Error: ${err.message}`);
  }
}

// Microphone button — push to talk
micBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (Speech.isListening()) return;
  micBtn.classList.add('listening');
  setStatus('Listening...');
  TTS.stop();
  const ok = Speech.startListening();
  if (!ok) {
    micBtn.classList.remove('listening');
    setStatus('Speech recognition unavailable');
  }
});

micBtn.addEventListener('pointerup', () => {
  micBtn.classList.remove('listening');
  Speech.stopListening();
});

micBtn.addEventListener('pointercancel', () => {
  micBtn.classList.remove('listening');
  Speech.stopListening();
});

// Text input form
if (textForm) {
  textForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = textInput.value.trim();
    console.log('[AudioChart] text submit:', text);
    if (!text) return;
    textInput.value = '';
    TTS.stop();
    handleCommand(text);
  });
} else {
  console.error('[AudioChart] text-form element not found');
}

async function init() {
  setStatus('Loading chart data...');

  // Load chart data — deferred until GPS fix so we can load the right area
  // GPS callback below will trigger the first load once position is known

  // Init speech
  Speech.init(
    (transcript) => handleCommand(transcript),
    (err) => {
      setStatus(err);
      speechStatusEl.textContent = 'Speech: unavailable';
    }
  );

  if (Speech.isSupported()) {
    speechStatusEl.textContent = 'Speech: ready';
    speechStatusEl.className = 'status-badge speech-ok';
  } else {
    speechStatusEl.textContent = 'Speech: unsupported';
    TTS.say('Welcome to AudioChart. Speech recognition is not available in this browser.');
  }

  // Connect to Mac server BEFORE starting GPS so setServerBase is ready
  // when the first GPS fix arrives and triggers loadData.
  const isMacServer = !location.hostname.endsWith('.github.io') &&
                      (location.hostname === 'localhost' || location.hostname.match(/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./));
  const serverUrl = isMacServer
    ? location.origin
    : localStorage.getItem('audiochart_server_url');
  if (serverUrl) {
    GPS.connectServer(serverUrl);
    Query.setServerBase(serverUrl);
  }

  // Start GPS
  GPS.startGPS(
    async (lat, lon, accuracy, source) => {
      showPosition(lat, lon, accuracy, source);
      if (!gpsReady) {
        gpsReady = true;
        setStatus('Loading chart data for your position...');
        try {
          await Query.loadData(lat, lon);
          dataLoaded = true;
          setStatus('Ready. Press the microphone and speak a command.');
          TTS.say('AudioChart ready. Press the microphone button to speak a command.');
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

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
