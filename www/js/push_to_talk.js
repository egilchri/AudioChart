/**
 * AudioChart — hold-to-talk using the browser's own speech recognition.
 * Direct request 2026-10-06: "I just want to hold down a button and talk."
 *
 * Hold the mic button (or the Space bar), speak, let go: the words go to
 * handleCommand like a typed command. Where the browser can recognise speech
 * on the device (Chrome 139+: SpeechRecognition.available/install with
 * processLocally), that's used — after a one-time language-pack download it
 * works offline and no audio leaves the device. Other browsers fall back to
 * their standard recognizer, which may use the browser maker's online
 * service (see privacy/index.html).
 *
 * (speech.js is the original 2026-05 push-to-talk wrapper, unused since the
 * keyboard-mic switch; this replaces it rather than reviving it, because it
 * needs on-device setup, hold semantics and phrase hints it never had.)
 */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const LANG = 'en-US';

let rec = null;
let holding = false;     // the user is still holding the button/key
let heard = '';          // final text so far in this hold
let interim = '';
let ended = true;
let onDevice = null;     // null = not checked yet; true/false after
let installing = false;
let usePhrases = true;
let cb = null;

export function isSupported() { return !!SR; }

/** Status for the strip: 'listening' | 'partial' | 'thinking' | 'error' | 'info'. */
function status(state, text = '') { cb?.onStatus?.(state, text); }

function beep(freq = 880, ms = 90) {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = freq; g.gain.value = 0.08;
    o.connect(g).connect(ac.destination); o.start();
    o.stop(ac.currentTime + ms / 1000);
    o.onended = () => ac.close();
  } catch { /* no audio — the strip still shows the state */ }
}

// Prefer on-device recognition. Returns true (use it), false (not offered by
// this browser — use the standard recognizer), or 'wait' (one-time language
// pack download started; try again when it's done).
async function checkOnDevice() {
  if (onDevice !== null) return onDevice;
  if (typeof SR.available !== 'function') return (onDevice = false);
  let a;
  try { a = await SR.available({ langs: [LANG], processLocally: true }); }
  catch { return (onDevice = false); }
  if (a === 'available') return (onDevice = true);
  if (a === 'downloadable' || a === 'downloading') {
    if (!installing) {
      installing = true;
      SR.install({ langs: [LANG], processLocally: true })
        .then((ok) => {
          installing = false;
          if (ok) { onDevice = true; status('info', 'Speech is ready — hold to talk.'); }
          else { onDevice = false; status('info', 'Offline speech couldn’t be set up; using the browser’s standard speech recognition.'); }
        })
        .catch(() => { installing = false; onDevice = false; });
    }
    return 'wait';
  }
  return (onDevice = false);
}

/**
 * Start listening (call on press). opts: {hints: string[], onStatus(state,text),
 * onText(text), beforeListen()}.
 */
export async function start(opts) {
  if (!SR || !ended) return;
  cb = opts;
  holding = true;
  const od = await checkOnDevice();
  if (od === 'wait') {
    status('info', 'Setting up offline speech (one-time download)… try again in a moment.');
    return;
  }
  if (!holding) return; // released while we were checking — a tap, not a hold
  cb.beforeListen?.();
  heard = ''; interim = ''; ended = false;
  rec = new SR();
  rec.lang = LANG;
  rec.continuous = true;      // keep listening for as long as it's held
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  if (od === true) rec.processLocally = true;
  // Nudge recognition toward what's on screen (Chrome's contextual biasing).
  if (usePhrases && od === true && window.SpeechRecognitionPhrase && 'phrases' in rec && opts.hints?.length) {
    try { rec.phrases = opts.hints.slice(0, 100).map((p) => new SpeechRecognitionPhrase(p, 4.0)); }
    catch { usePhrases = false; }
  }
  rec.onstart = () => { beep(); status('listening'); };
  rec.onresult = (e) => {
    interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) heard += (heard ? ' ' : '') + t.trim();
      else interim += t;
    }
    const shown = (heard + ' ' + interim).trim();
    if (shown) status('partial', shown);
  };
  rec.onerror = (e) => {
    if (e.error === 'phrases-not-supported') { usePhrases = false; return; }
    if (e.error === 'aborted' || e.error === 'no-speech') return; // handled in onend
    ended = true;
    status('error', {
      'not-allowed': 'AudioChart needs permission to use the microphone.',
      'service-not-allowed': 'AudioChart needs permission to use the microphone.',
      'audio-capture': 'No microphone found.',
      'network': 'Speech recognition needs an internet connection in this browser.',
      'language-not-supported': 'English speech recognition isn’t available here.',
    }[e.error] || `Speech recognition error (${e.error}).`);
  };
  rec.onend = () => {
    const wasEnded = ended;
    ended = true;
    if (wasEnded) return;  // an error already reported
    const text = (heard + ' ' + interim).trim();
    if (text) { status('thinking'); cb.onText?.(text); }
    else status('error', 'Didn’t catch that — hold and try again.');
  };
  try { rec.start(); }
  catch (err) { ended = true; status('error', `Couldn’t start listening (${err.message}).`); }
}

/** Stop listening (call on release); the words heard so far are sent. */
export function stop() {
  holding = false;
  if (rec && !ended) {
    // A short grace period so the last word isn't clipped by an early release.
    const r = rec;
    setTimeout(() => { try { r.stop(); } catch { /* already stopped */ } }, 350);
  }
}

export function isListening() { return !ended; }
