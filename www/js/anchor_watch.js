/**
 * AudioChart — Anchor Watch: arm/disarm, drift checking against a set
 * radius, alarm tone/vibrate, and localStorage persistence across reloads.
 * `renderCircle(map, ...)` takes the Leaflet map as a parameter and calls
 * L.circle directly — same pattern hazard_clustering.js already uses —
 * rather than reaching for app.js's own map instance. The DOM button/
 * silence-button, the arm/cancel form, and their click/keydown/outside-
 * click listeners stay in app.js as thin UI wiring that calls into this
 * module and then refreshes the button — same split as router.js/
 * wake_lock.js (logic out, DOM glue stays). Extracted from app.js as part
 * of the reliability-overhaul's Phase 4 (see the plan for rationale).
 *
 * Piggybacks on the caller's own shared GPS callback (see check(), called
 * from the same place Track recording samples fixes) rather than opening a
 * second geolocation watch or a setInterval poller. Reliability, not the
 * monitoring itself, is the real resource question: this only runs while
 * the screen is on and the tab is foregrounded (see WakeLock.request), a
 * hard platform limit with no workaround, so arming it forces the wake
 * lock on and says so plainly.
 */

import * as Query from './query.js';
import * as TTS from './tts.js';
import * as WakeLock from './wake_lock.js';

const ANCHOR_WATCH_KEY = 'audiochart-anchor-watch'; // {armed, lat, lon, radiusFt, armedAtMs}
const ANCHOR_OUTSIDE_DEBOUNCE_MS = 30 * 1000;  // must stay outside continuously this long before alarming
const ANCHOR_RETRIGGER_MS = 5 * 60 * 1000;     // re-alarm after this long silenced if still outside
const ANCHOR_CHECK_THROTTLE_MS = 5 * 1000;     // don't re-check distance more than once per this
const FT_PER_NM = 6076.12;

let _armed            = false;
let _lat              = null;
let _lon              = null;
let _radiusFt         = Number(localStorage.getItem('audiochart-anchor-radius-ft')) || 150;
let _armedAtMs        = null;
let _lastCheckMs      = 0;
let _outsideSinceMs   = null; // set the moment a check finds us outside the radius; cleared when back inside
let _alarmActive      = false;
let _silencedUntilMs  = null;
let _wakeLockForcedOn = false; // true if arming Anchor Watch is what turned the wake lock on
let _layer            = null;
let _audioCtx         = null;
let _oscStopFn        = null;
let _speechIntervalId = null;

const ALARM_SPEECH_REPEAT_MS = 20 * 1000; // re-announce by voice, not just tone, while alarming

export function isArmed()     { return _armed; }
export function isAlarming()  { return _alarmActive; }
export function getRadiusFt() { return _radiusFt; }
export function getArmedAtMs() { return _armedAtMs; }

function _save() {
  if (_armed) {
    localStorage.setItem(ANCHOR_WATCH_KEY, JSON.stringify({
      armed: true, lat: _lat, lon: _lon,
      radiusFt: _radiusFt, armedAtMs: _armedAtMs,
    }));
  } else {
    localStorage.removeItem(ANCHOR_WATCH_KEY);
  }
}

export function renderCircle(map) {
  if (_layer) { map.removeLayer(_layer); _layer = null; }
  if (!_armed || !map) return;
  _layer = L.circle([_lat, _lon], {
    radius: (_radiusFt / FT_PER_NM) * 1852,
    className: 'anchor-watch-circle',
    color: '#4a9edd',
    weight: 2,
    dashArray: '6 6',
    fillColor: '#4a9edd',
    fillOpacity: 0.08,
  }).addTo(map);
  if (_alarmActive) _layer.getElement()?.classList.add('anchor-watch-alarming');
}

function _playAlarmTone() {
  if (_oscStopFn) return; // already playing
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    gain.gain.value = 0.25;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    let high = true;
    const toggle = setInterval(() => {
      high = !high;
      osc.frequency.setValueAtTime(high ? 1200 : 800, ctx.currentTime);
    }, 400);
    _oscStopFn = () => {
      clearInterval(toggle);
      osc.stop();
      osc.disconnect(); gain.disconnect();
    };
  } catch (err) {
    console.warn('[anchor watch] tone failed:', err);
  }
}

function _stopAlarmTone() {
  if (_oscStopFn) { _oscStopFn(); _oscStopFn = null; }
}

// The tone loops on its own (via _playAlarmTone's setInterval) for as long
// as the alarm is active, but TTS.sayImmediate only ever spoke once, at the
// moment of the initial trigger — easy to miss if you're not looking at the
// screen right then. Repeats the same spoken warning on an interval, same
// lifetime as the tone, so voice keeps pace with the audible beeping until
// silenced or cleared.
function _startAlarmSpeech(msg) {
  _stopAlarmSpeech();
  TTS.sayImmediate(msg);
  _speechIntervalId = setInterval(() => TTS.sayImmediate(msg), ALARM_SPEECH_REPEAT_MS);
}

function _stopAlarmSpeech() {
  if (_speechIntervalId) { clearInterval(_speechIntervalId); _speechIntervalId = null; }
}

function _triggerAlarm({ onStatus, onButtonUpdate } = {}) {
  _alarmActive = true;
  _silencedUntilMs = null;
  _playAlarmTone();
  navigator.vibrate?.([400, 200, 400, 200, 400]);
  const msg = `Anchor alarm — dragging outside the ${_radiusFt} ft watch radius.`;
  onStatus?.(msg); _startAlarmSpeech(msg);
  onButtonUpdate?.();
  _layer?.getElement()?.classList.add('anchor-watch-alarming');
}

function _clearAlarm(onButtonUpdate) {
  _alarmActive = false;
  _silencedUntilMs = null;
  _stopAlarmTone();
  _stopAlarmSpeech();
  onButtonUpdate?.();
  _layer?.getElement()?.classList.remove('anchor-watch-alarming');
}

// Returns { wakeLockForced } so the caller can refresh its own wake-lock
// button — WakeLock itself has no UI, that's app.js's Screen-menu button.
export function arm(lat, lon, radiusFt, { onStatus } = {}) {
  _armed = true;
  _lat = lat;
  _lon = lon;
  _radiusFt = radiusFt;
  _armedAtMs = Date.now();
  _outsideSinceMs = null;
  localStorage.setItem('audiochart-anchor-radius-ft', String(radiusFt));
  _save();
  let wakeLockForced = false;
  if (!WakeLock.isEnabled()) {
    _wakeLockForcedOn = true;
    wakeLockForced = true;
    WakeLock.setEnabled(true);
    WakeLock.request(onStatus);
  }
  const msg = `Anchor watch armed — ${radiusFt} ft radius. Keep the screen on for it to work.`;
  onStatus?.(msg); TTS.sayImmediate(msg);
  return { wakeLockForced };
}

// Returns { wakeLockReleased }, same reasoning as arm()'s return value.
export function disarm({ onStatus } = {}) {
  _armed = false;
  _clearAlarm();
  _outsideSinceMs = null;
  _save();
  let wakeLockReleased = false;
  if (_wakeLockForcedOn) {
    _wakeLockForcedOn = false;
    wakeLockReleased = true;
    WakeLock.setEnabled(false);
    WakeLock.release();
  }
  const msg = 'Anchor watch disarmed.';
  onStatus?.(msg); TTS.sayImmediate(msg);
  return { wakeLockReleased };
}

export function silence(onStatus) {
  _stopAlarmTone();
  _stopAlarmSpeech();
  navigator.vibrate?.(0);
  _silencedUntilMs = Date.now() + ANCHOR_RETRIGGER_MS;
  // Keep _alarmActive true — still armed and still outside the radius,
  // just muted; check() re-triggers automatically after the cooldown.
  onStatus?.('Anchor alarm silenced — still watching.');
}

// Called from the shared GPS callback on every fix; throttled internally so
// it costs nothing on fixes that arrive faster than ANCHOR_CHECK_THROTTLE_MS.
// onButtonUpdate fires only on an actual armed/alarming state transition —
// not on every fix — matching the pre-extraction behavior exactly.
export function check(lat, lon, { onStatus, onButtonUpdate } = {}) {
  if (!_armed) return;
  const now = Date.now();
  if (now - _lastCheckMs < ANCHOR_CHECK_THROTTLE_MS) return;
  _lastCheckMs = now;

  const distNm = Query.distanceNm(_lon, _lat, lon, lat);
  const outside = distNm * FT_PER_NM > _radiusFt;

  if (!outside) {
    _outsideSinceMs = null;
    if (_alarmActive) _clearAlarm(onButtonUpdate);
    return;
  }

  if (_outsideSinceMs === null) _outsideSinceMs = now;
  const continuouslyOutsideMs = now - _outsideSinceMs;

  if (!_alarmActive) {
    if (continuouslyOutsideMs >= ANCHOR_OUTSIDE_DEBOUNCE_MS) _triggerAlarm({ onStatus, onButtonUpdate });
  } else if (_silencedUntilMs !== null && now >= _silencedUntilMs) {
    _triggerAlarm({ onStatus, onButtonUpdate }); // re-alarm after a silence cooldown, still outside
  }
}

export function recover({ onStatus } = {}) {
  const raw = localStorage.getItem(ANCHOR_WATCH_KEY);
  if (!raw) return false;
  try {
    const { armed, lat, lon, radiusFt, armedAtMs } = JSON.parse(raw);
    if (!armed || lat == null || lon == null) return false;
    _armed = true;
    _lat = lat;
    _lon = lon;
    _radiusFt = radiusFt || _radiusFt;
    _armedAtMs = armedAtMs || Date.now();
    const mins = Math.round((Date.now() - _armedAtMs) / 60000);
    onStatus?.(`Resumed anchor watch from before reload — armed ${mins} min ago, ${_radiusFt} ft radius.`);
    return true;
  } catch (_) {
    localStorage.removeItem(ANCHOR_WATCH_KEY);
    return false;
  }
}
