/*
 * Stand-in for the browser speech-synthesis API where it doesn't exist —
 * notably Android's WebView, used by the AudioChart Android app
 * (android/ in the repo). Without it, tts.js throws on load and the whole
 * app fails to start (found 2026-10-06). Loaded as a classic script before
 * the app's modules, so it's in place before tts.js runs.
 *
 * With the Android app's bridge (window.AudioChartAndroid) it speaks through
 * Android's own TextToSpeech; with no bridge it stays silent but keeps the
 * same events firing, so the app's speech queue never stalls.
 * `speaking` is kept accurate because tts.js's watchdog replays an
 * utterance it thinks died silently.
 */
(function () {
  if (typeof window.speechSynthesis !== 'undefined') return;
  var bridge = window.AudioChartAndroid || null;
  var pending = {};
  var count = 0;
  var nextId = 1;

  function fire(u, type) {
    var ev = new Event(type);
    ev.utterance = u;
    if (type === 'error') ev.error = 'interrupted';
    try { if (typeof u['on' + type] === 'function') u['on' + type](ev); } catch (e) { console.error(e); }
    u.dispatchEvent(ev);
  }

  function Utterance(text) {
    var et = new EventTarget();
    et.text = text || '';
    et.rate = 1; et.pitch = 1; et.volume = 1; et.voice = null; et.lang = 'en-US';
    et.onstart = et.onend = et.onerror = et.onboundary = null;
    return et;
  }

  var synth = new EventTarget();
  synth.speaking = false;
  synth.pending = false;
  synth.paused = false;
  synth.getVoices = function () {
    return bridge ? [{ name: 'Android', lang: 'en-US', localService: true, default: true, voiceURI: 'android' }] : [];
  };
  synth.speak = function (u) {
    var id = String(nextId++);
    pending[id] = u;
    count++;
    synth.speaking = true;
    if (bridge) {
      bridge.speak(String(u.text), id, Number(u.rate) || 1, Number(u.pitch) || 1);
    } else {
      setTimeout(function () { window.__acTts(id, 'start'); window.__acTts(id, 'end'); }, 0);
    }
  };
  synth.cancel = function () {
    if (bridge) bridge.stop();
    // Cancelled utterances are dropped without firing events: tts.js resets
    // its own queue state right after calling cancel(), so a late 'end' here
    // would only start the next line early.
    pending = {}; count = 0; synth.speaking = false;
  };
  synth.pause = function () {};
  synth.resume = function () {};

  // Called by the Android bridge (and the silent fallback above).
  window.__acTts = function (id, type) {
    var u = pending[id];
    if (!u) return;
    if (type === 'start') { fire(u, 'start'); return; }
    delete pending[id];
    count = Math.max(0, count - 1);
    synth.speaking = count > 0;
    fire(u, type === 'error' ? 'error' : 'end');
  };

  window.speechSynthesis = synth;
  window.SpeechSynthesisUtterance = Utterance;
})();
