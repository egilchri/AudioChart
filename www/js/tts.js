/**
 * Text-to-speech wrapper using the Web Speech API SpeechSynthesis.
 * Works fully offline on all platforms.
 */

let voice = null;
let queue = [];
let speaking = false;

function selectVoice() {
  const voices = speechSynthesis.getVoices();
  voice = voices.find(v => v.lang === 'en-US' && !v.localService === false) ||
          voices.find(v => v.lang.startsWith('en-US')) ||
          voices.find(v => v.lang.startsWith('en')) ||
          (voices.length ? voices[0] : null);
}

// Voices may not be ready immediately
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener('voiceschanged', selectVoice);
  selectVoice();
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
  utt.onend = () => { speaking = false; speakNext(); };
  utt.onerror = () => { speaking = false; speakNext(); };
  speechSynthesis.speak(utt);
}

/** Queue text for speech output. */
export function say(text) {
  queue.push(text);
  speakNext();
}

/** Cancel current speech and all queued, speak immediately. */
export function sayImmediate(text) {
  queue = [];
  speechSynthesis.cancel();
  speaking = false;
  queue.push(text);
  speakNext();
}

/** Stop all speech and clear queue. */
export function stop() {
  queue = [];
  speechSynthesis.cancel();
  speaking = false;
}

export function isSpeaking() {
  return speaking || speechSynthesis.speaking;
}
