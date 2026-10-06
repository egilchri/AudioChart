/**
 * AudioChart — press any visible button / menu item by saying (or typing)
 * its label. Direct request 2026-10-06: "the voice can activate any title of
 * any button or menu that appears". Works with any text source: the command
 * box, phone keyboard dictation, desktop dictation, or a future in-app mic.
 *
 * Candidates are whatever a sighted user could tap right now: visible,
 * enabled, on screen and not covered by something else — buttons, menu
 * items, links, checkbox labels, and the options of visible drop-downs.
 * Map markers themselves are left out (hundreds of them, mostly unnamed).
 * Destructive actions are never pressed by voice — they still need a tap.
 */

const VERB_PREFIX = /^(?:please\s+)?(?:press|click(?:\s+on)?|tap(?:\s+on)?|hit|push|select|choose|open|toggle|turn\s+on|turn\s+off)\s+(?:the\s+)?/i;
const DESTRUCTIVE = /\b(delete|remove|erase|discard)\b/i;

/** True when the text explicitly asks to press something ("press X"). */
export function isExplicitPress(text) { return VERB_PREFIX.test(text.trim()); }

function clean(s) {
  return (s || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(button|menu|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Visible and actually reachable: has a box, isn't hidden, sits in the
// viewport, and at least one sample point (center, or a sliver at either
// edge — card-stack buttons only show their left edge) hits the element.
function isTappable(el) {
  if (el.disabled || el.closest('[aria-hidden="true"], .leaflet-marker-pane')) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
  const cy = r.top + r.height / 2;
  for (const x of [r.left + r.width / 2, r.left + 6, r.right - 6]) {
    const hit = document.elementFromPoint(x, cy);
    if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return true;
  }
  return false;
}

// Symbol-only buttons (✕, ＋, ▴) have no words in their text — fall back to
// their aria-label, then their tooltip, so "close" finds the ✕ buttons.
function labelOf(el) {
  if (el.tagName === 'LABEL') return el.innerText;
  if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit')) return el.value;
  const text = el.innerText || '';
  if (clean(text)) return text;
  return el.getAttribute('aria-label') || el.title || '';
}

/** Everything that could be pressed right now: [{label, el, select?, option?}] */
export function visibleTargets() {
  const out = [];
  const sel = 'button, [role="button"], [role="menuitem"], a[href], input[type="button"], input[type="submit"], label';
  for (const el of document.querySelectorAll(sel)) {
    if (el.tagName === 'LABEL' && !el.querySelector('input[type="checkbox"], input[type="radio"]') && !el.htmlFor) continue;
    if (!isTappable(el)) continue;
    const label = clean(labelOf(el));
    if (label) out.push({ label, raw: labelOf(el).trim(), el });
  }
  for (const s of document.querySelectorAll('select')) {
    // The Command reference list holds example commands, not choices —
    // matching one would just fill the box with "[place]" placeholders.
    if (s.id === 'command-picker' || !isTappable(s)) continue;
    for (const o of s.options) {
      if (o.disabled || o.hidden || !o.value) continue;
      const label = clean(o.text);
      if (label) out.push({ label, raw: o.text.trim(), el: s, option: o });
    }
  }
  return out;
}

/**
 * Try to press the visible control whose label best matches `text`.
 * Returns {ok:true, label} after pressing, or {ok:false, reason, label?}.
 */
function scoreAgainst(text, targets) {
  const q = clean(text.trim().replace(VERB_PREFIX, ''));
  if (q.length < 2) return null;
  return targets.map(t => {
    let score;
    if (t.label === q) score = 0;
    else if (q.length >= 4 && (t.label.startsWith(q + ' ') || q.startsWith(t.label + ' '))) score = 0.1;
    else score = lev(q, t.label) / Math.max(q.length, t.label.length);
    return { ...t, score };
  }).sort((a, b) => a.score - b.score);
}

/**
 * Best match for `text` among a fixed list of labels (e.g. a marker's menu,
 * which may not be on screen). Returns {ok:true, index, label, score} or
 * {ok:false, reason, label?} — same rules as pressVisibleLabel.
 */
export function matchLabel(text, rawLabels) {
  const scored = scoreAgainst(text, rawLabels.map((raw, index) => ({ raw, index, label: clean(raw) })));
  if (!scored) return { ok: false, reason: 'empty' };
  const best = scored[0];
  if (!best || best.score > 0.3) return { ok: false, reason: 'no-match' };
  if (DESTRUCTIVE.test(best.raw)) return { ok: false, reason: 'destructive', label: best.raw };
  return { ok: true, index: best.index, label: best.raw, score: best.score };
}

export function pressVisibleLabel(text) {
  const scored = scoreAgainst(text, visibleTargets());
  if (!scored) return { ok: false, reason: 'empty' };
  const best = scored[0];
  if (!best || best.score > 0.3) return { ok: false, reason: 'no-match' };
  // Two different controls equally good (e.g. two "Close" buttons) — don't guess.
  const tie = scored.find(t => t !== best && t.score === best.score && t.el !== best.el);
  if (tie) return { ok: false, reason: 'ambiguous', label: best.raw };
  if (DESTRUCTIVE.test(best.raw)) return { ok: false, reason: 'destructive', label: best.raw };
  if (best.option) {
    best.el.value = best.option.value;
    best.el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    best.el.click();
  }
  return { ok: true, label: best.raw };
}
