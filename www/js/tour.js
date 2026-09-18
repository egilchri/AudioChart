/**
 * AudioChart — "Take a Tour" onboarding engine: lightweight callouts that
 * point an arrow at a real UI element and walk a user through a scripted
 * sequence of steps. Pure DOM/positioning logic — a step's actual content
 * (which element it targets, what advances it) is supplied by the caller;
 * this module owns no knowledge of app.js internals beyond what's passed
 * in, same split as router.js/wake_lock.js (logic here, DOM/content glue
 * stays in app.js). tts.js is a foundational module of the same kind
 * (not app.js itself), so importing it here doesn't break that split —
 * this app is voice-first throughout, and per direct request a tour step
 * should be spoken, not just displayed as text on screen.
 *
 * Step shape: { target, text, placement?, waitFor? }
 *   target:   CSS selector string, OR a function returning an Element|null
 *             (resolved fresh each render — a target like a Leaflet marker
 *             or an open popup's button doesn't exist until an earlier
 *             step's action creates it).
 *   text:     callout body text (plain text, not HTML).
 *   placement: 'top' | 'bottom' (default: whichever keeps the callout
 *             on-screen given the target's position).
 *   waitFor:  optional (advance) => cleanup. Called once the step renders;
 *             call advance() when the real UI action happens (a click, a
 *             select's change event, a Leaflet popupopen, ...). Return a
 *             function that removes whatever listener you attached. Steps
 *             without waitFor just show a manual Next button.
 * A step with no `target` renders as an untargeted, centered callout —
 * used for a tour's closing step.
 *
 * Every callout is draggable (grab anywhere on it) — it can land on top of
 * whatever it's pointing at (a Leaflet document popup's own content, for
 * instance), and dragging it aside is the direct fix rather than trying to
 * predict every real popup's shape in advance.
 */

import * as TTS from './tts.js';

const MODE_SEEN_KEY = 'audiochart-tour-mode-seen';
const TOUR_DONE_KEY = 'audiochart-tour-completed';

function _readBlob(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
}
function _writeBlobFlag(key, flagKey) {
  const blob = _readBlob(key);
  blob[flagKey] = true;
  localStorage.setItem(key, JSON.stringify(blob));
}

export function isModeIntroSeen(mode) { return !!_readBlob(MODE_SEEN_KEY)[mode]; }
export function markModeIntroSeen(mode) { _writeBlobFlag(MODE_SEEN_KEY, mode); }
export function isTourCompleted(id) { return !!_readBlob(TOUR_DONE_KEY)[id]; }
export function markTourCompleted(id) { _writeBlobFlag(TOUR_DONE_KEY, id); }

let _active = null; // { tour, stepIndex, el, cleanupWaitFor, pollTimer, onComplete }

export function startTour(tour, { onComplete } = {}) {
  _teardown();
  _active = { tour, stepIndex: 0, el: null, cleanupWaitFor: null, pollTimer: null, onComplete };
  _renderStep();
}

export function isTourActive() { return !!_active; }

function _finish(completed) {
  const { tour, onComplete } = _active || {};
  _teardown();
  if (tour && completed) markTourCompleted(tour.id);
  if (onComplete) onComplete({ completed });
}

function _teardown() {
  if (!_active) return;
  if (_active.cleanupWaitFor) { try { _active.cleanupWaitFor(); } catch { /* listener already gone */ } }
  if (_active.pollTimer) clearInterval(_active.pollTimer);
  if (_active.el) _active.el.remove();
  _active = null;
}

function _advance() {
  if (!_active) return;
  const { tour } = _active;
  if (_active.cleanupWaitFor) { try { _active.cleanupWaitFor(); } catch { /* already gone */ } _active.cleanupWaitFor = null; }
  if (_active.stepIndex >= tour.steps.length - 1) { _finish(true); return; }
  _active.stepIndex += 1;
  _renderStep();
}

function _back() {
  if (!_active || _active.stepIndex === 0) return;
  if (_active.cleanupWaitFor) { try { _active.cleanupWaitFor(); } catch { /* already gone */ } _active.cleanupWaitFor = null; }
  _active.stepIndex -= 1;
  _renderStep();
}

function _resolveTarget(target) {
  if (!target) return null;
  const el = typeof target === 'function'
    ? (() => { try { return target(); } catch { return null; } })()
    : document.querySelector(target);
  if (!el) return null;
  // A target can exist in the DOM well before it's actually shown — e.g.
  // #edit-ok-btn sits inside #edit-banner, which stays display:none until
  // edit mode activates. Treat a zero-size (hidden) element as not found
  // yet, so the poll loop keeps waiting instead of anchoring the callout
  // to a {0,0,0,0} rect.
  const r = el.getBoundingClientRect();
  return (r.width > 0 && r.height > 0) ? el : null;
}

function _renderStep() {
  if (!_active) return;
  if (_active.el) { _active.el.remove(); _active.el = null; }
  if (_active.pollTimer) { clearInterval(_active.pollTimer); _active.pollTimer = null; }
  const { tour, stepIndex } = _active;
  const step = tour.steps[stepIndex];
  const isLast = stepIndex === tour.steps.length - 1;

  const el = document.createElement('div');
  el.className = 'tour-callout';
  const textEl = document.createElement('div');
  textEl.className = 'tour-callout-text';
  textEl.textContent = step.text;
  TTS.sayImmediate(step.text);
  const controls = document.createElement('div');
  controls.className = 'tour-callout-controls';
  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'tour-btn tour-btn-skip';
  skipBtn.textContent = 'Skip';
  skipBtn.addEventListener('click', () => _finish(true));
  controls.appendChild(skipBtn);
  const spacer = document.createElement('span');
  spacer.className = 'tour-callout-spacer';
  controls.appendChild(spacer);
  if (stepIndex > 0) {
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'tour-btn tour-btn-back';
    backBtn.textContent = 'Back';
    backBtn.addEventListener('click', () => _back());
    controls.appendChild(backBtn);
  }
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'tour-btn tour-btn-next';
  nextBtn.textContent = isLast ? 'Got it' : 'Next';
  nextBtn.addEventListener('click', () => _advance());
  controls.appendChild(nextBtn);
  el.appendChild(textEl);
  el.appendChild(controls);
  document.body.appendChild(el);
  _active.el = el;
  _makeDraggable(el);

  const place = () => {
    const target = _resolveTarget(step.target);
    _positionCallout(el, target, step.placement);
    return target;
  };
  const target = place();

  // The target may not exist yet on first render (e.g. a marker that only
  // appears once the previous step's action finishes) — poll briefly
  // rather than give up immediately.
  if (!target && step.target) {
    let tries = 0;
    _active.pollTimer = setInterval(() => {
      tries += 1;
      const found = place();
      if (found || tries > 40) { clearInterval(_active.pollTimer); _active.pollTimer = null; }
    }, 200);
  }

  _active.cleanupWaitFor = step.waitFor ? (step.waitFor(() => _advance()) || null) : null;
}

// Callouts can land on top of whatever they're pointing at (a Leaflet
// document popup's own content, in the flagship tour's case — confirmed
// live, the two visibly overlapped). Letting the user drag the callout
// itself out of the way is the direct fix, rather than trying to predict
// every real popup's shape in advance. Self-contained (no import from
// app.js's own _makeDraggable) to keep this module free of app.js
// dependencies — same split as router.js/wake_lock.js. A plain tap on a
// Skip/Back/Next button still works: the click-swallow only fires once a
// real drag (past DRAG_THRESHOLD_PX) has happened.
const DRAG_THRESHOLD_PX = 6;
function _makeDraggable(el) {
  let dragging = false, moved = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;

  function begin(clientX, clientY) {
    dragging = true;
    moved = false;
    startX = clientX;
    startY = clientY;
    const rect = el.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
  }
  function moveTo(clientX, clientY) {
    if (!dragging) return;
    if (!moved && Math.hypot(clientX - startX, clientY - startY) < DRAG_THRESHOLD_PX) return;
    moved = true;
    el.classList.add('tour-callout-untargeted'); // dragging = no longer arrow-pointing at anything; hides the arrow (see CSS)
    el.style.transform = '';
    const w = el.offsetWidth, h = el.offsetHeight;
    const newLeft = Math.max(4, Math.min(window.innerWidth  - w - 4, origLeft + (clientX - startX)));
    const newTop  = Math.max(4, Math.min(window.innerHeight - h - 4, origTop  + (clientY - startY)));
    el.style.left = `${newLeft}px`;
    el.style.top  = `${newTop}px`;
  }
  function end() { dragging = false; }

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    begin(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    moveTo(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  el.addEventListener('touchend', end);

  el.addEventListener('mousedown', (e) => {
    begin(e.clientX, e.clientY);
    const onMove = (ev) => moveTo(ev.clientX, ev.clientY);
    const onUp = () => { end(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Swallow exactly the one click that follows a real drag gesture, so
  // dragging the callout by grabbing near a button doesn't also fire that
  // button. A plain tap (moved stays false) passes through untouched.
  el.addEventListener('click', (e) => {
    if (moved) { e.stopImmediatePropagation(); e.preventDefault(); moved = false; }
  }, { capture: true });
}

function _positionCallout(el, target, placement) {
  if (!target) {
    el.classList.add('tour-callout-untargeted');
    el.style.left = '50%';
    el.style.top = '50%';
    el.style.transform = 'translate(-50%, -50%)';
    return;
  }
  el.classList.remove('tour-callout-untargeted');
  el.style.transform = '';
  const rect = target.getBoundingClientRect();
  const calloutRect = el.getBoundingClientRect();
  const margin = 12;
  const side = placement === 'top' ? 'top'
    : placement === 'bottom' ? 'bottom'
    : (rect.top > window.innerHeight / 2 ? 'top' : 'bottom');
  const top = side === 'bottom' ? rect.bottom + margin : rect.top - calloutRect.height - margin;
  let left = rect.left + rect.width / 2 - calloutRect.width / 2;
  left = Math.min(Math.max(4, left), window.innerWidth - calloutRect.width - 4);
  const clampedTop = Math.min(Math.max(4, top), window.innerHeight - calloutRect.height - 4);
  el.style.left = `${left}px`;
  el.style.top = `${clampedTop}px`;
  el.dataset.tourArrow = side;
  // Arrow stays under the target's own center even after the callout body
  // got clamped sideways to fit the viewport.
  const arrowLeft = Math.min(Math.max(16, rect.left + rect.width / 2 - left), calloutRect.width - 16);
  el.style.setProperty('--tour-arrow-offset', `${arrowLeft}px`);
}
