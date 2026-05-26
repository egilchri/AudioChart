/**
 * Text-to-speech wrapper using the Web Speech API SpeechSynthesis.
 * Works fully offline on all platforms.
 */

const VOICE_PREF_KEY = 'audiochart-voice-name';

let voice = null;
let queue = [];
let speaking = false;
let _onSpeechEnd = null;

function _voiceQuality(v) {
  const n = v.name.toLowerCase();
  if (n.includes('premium')) return 4;
  if (n.includes('enhanced')) return 3;
  if (v.localService) return 2;
  return 1;
}

function _rankVoices(voices) {
  return voices
    .filter(v => v.lang.startsWith('en'))
    .sort((a, b) => {
      const aUS = a.lang === 'en-US' ? 1 : 0;
      const bUS = b.lang === 'en-US' ? 1 : 0;
      if (aUS !== bUS) return bUS - aUS;
      return _voiceQuality(b) - _voiceQuality(a);
    });
}

function selectVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;

  const saved = localStorage.getItem(VOICE_PREF_KEY);
  if (saved) {
    const match = voices.find(v => v.name === saved);
    if (match) { voice = match; return; }
  }

  const ranked = _rankVoices(voices);
  voice = ranked[0] || voices[0] || null;
}

// Voices may not be ready immediately
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener('voiceschanged', selectVoice);
  selectVoice();
  // iOS pauses speechSynthesis after ~15s of inactivity; resume it periodically
  setInterval(() => {
    if (speechSynthesis.speaking) {
      speechSynthesis.pause();
      speechSynthesis.resume();
    }
  }, 10000);
}

function speakNext() {
  if (speaking || queue.length === 0) return;
  const text = queue.shift();
  speaking = true;
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = 0.85;
  utt.pitch = 1.0;
  utt.volume = 1.0;
  if (voice) utt.voice = voice;
  utt.onend = () => {
    speaking = false;
    if (queue.length === 0 && _onSpeechEnd) { const cb = _onSpeechEnd; _onSpeechEnd = null; cb(); }
    speakNext();
  };
  utt.onerror = () => { speaking = false; speakNext(); };
  speechSynthesis.speak(utt);
}

/** Queue text for speech output. */
export function say(text) {
  queue.push(text);
  speakNext();
}

/** Cancel current speech and all queued, speak immediately. Optional onEnd callback fires when done. */
export function sayImmediate(text, onEnd = null) {
  _onSpeechEnd = onEnd;
  queue = [];
  speechSynthesis.cancel();
  speaking = false;
  queue.push(text);
  speakNext();
}

/** Stop all speech and clear queue. */
export function stop() {
  _onSpeechEnd = null;
  queue = [];
  speechSynthesis.cancel();
  speaking = false;
}

export function isSpeaking() {
  return speaking || speechSynthesis.speaking;
}

/** Return all English voices sorted best-first, for a UI picker. */
export function getVoices() {
  return _rankVoices(speechSynthesis.getVoices());
}

/** Set voice by name and persist the preference. */
export function setVoice(name) {
  const match = speechSynthesis.getVoices().find(v => v.name === name);
  if (match) {
    voice = match;
    localStorage.setItem(VOICE_PREF_KEY, name);
  }
}

/** Return the currently active voice name, or null. */
export function currentVoiceName() {
  return voice?.name ?? null;
}
