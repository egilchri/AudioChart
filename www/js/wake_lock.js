/**
 * AudioChart — Screen Wake Lock state and browser-API calls. The DOM button
 * reference, its click listener, the visibilitychange re-request listener,
 * and closing the Screen menu after a click all stay in app.js as thin UI
 * wiring that calls into this module — same split as router.js (logic out,
 * DOM glue stays). Extracted as part of the reliability-overhaul's Phase 2
 * (see the plan for rationale).
 */

let _enabled  = localStorage.getItem('audiochart-wake-lock') !== 'false'; // on by default
let _sentinel = null;   // the live WakeLockSentinel, or null when not currently held
let _warned   = false;  // suppresses repeated warnings for the same ongoing failure

export function isEnabled() { return _enabled; }

export function setEnabled(on) {
  _enabled = on;
  localStorage.setItem('audiochart-wake-lock', on ? 'true' : 'false');
  _warned = false;
}

// onWarn(message), if given, is called at most once per ongoing failure —
// callers typically pass setStatus so the user sees why the screen won't
// stay awake, without repeating the message on every retry.
export async function request(onWarn) {
  if (!_enabled || !('wakeLock' in navigator)) return;
  if (document.visibilityState !== 'visible') return;
  if (_sentinel) return; // already held

  try {
    _sentinel = await navigator.wakeLock.request('screen');
    _warned = false;
    _sentinel.addEventListener('release', () => { _sentinel = null; });
  } catch (err) {
    _sentinel = null;
    if (!_warned) {
      _warned = true;
      console.warn('[wakelock] request failed:', err);
      if (onWarn) onWarn(`Screen wake lock unavailable: ${err.message}`);
    }
  }
}

export function release() {
  if (_sentinel) _sentinel.release().catch(() => {});
}
