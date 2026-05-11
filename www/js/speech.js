/**
 * Speech recognition wrapper.
 * Uses the Web Speech API (works offline on Android Chrome with language pack).
 * Push-to-talk: call startListening() on button press, stopListening() on release.
 */

let recognition = null;
let onResultCallback = null;
let onErrorCallback = null;
let listening = false;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export function isSupported() {
  return !!SpeechRecognition;
}

export function init(onResult, onError) {
  onResultCallback = onResult;
  onErrorCallback = onError;

  if (!SpeechRecognition) {
    onError('Speech recognition not supported in this browser. Try Chrome on Android.');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    listening = false;
    if (onResultCallback) onResultCallback(transcript);
  };

  recognition.onerror = (event) => {
    listening = false;
    const msg = event.error === 'no-speech' ? 'No speech detected' :
                event.error === 'network' ? 'Network error — is offline speech recognition enabled?' :
                `Speech error: ${event.error}`;
    if (onErrorCallback) onErrorCallback(msg);
  };

  recognition.onend = () => {
    listening = false;
  };
}

/** Start listening. Returns false if recognition unavailable. */
export function startListening() {
  if (!recognition || listening) return false;
  try {
    recognition.start();
    listening = true;
    return true;
  } catch (e) {
    listening = false;
    return false;
  }
}

/** Stop listening early (e.g. button released). */
export function stopListening() {
  if (!recognition || !listening) return;
  try {
    recognition.stop();
  } catch (_) {}
}

export function isListening() {
  return listening;
}
