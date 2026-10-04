// Card-stack toolbar — the top-of-screen buttons as one row of overlapping
// cards, only each card's left edge (its symbol) showing. Direct request
// 2026-10-04, from design/card-stack-toolbar.html: "one stack, 41 pixels";
// on screens too narrow for 41px slivers the slivers tighten to fit.
//
// The REAL elements (#map-layer-select, #search-btn, #route-picker-btn …)
// are moved into the stack, not copied, so every existing listener, .active
// state and display:none toggle (offline-btn, paintings-list-btn) keeps
// working untouched. Hidden cards are skipped and the stack re-lays-out when
// one appears or disappears.
//
// Interaction:
//  - Mouse: hovering a card raises it to full width; click as normal.
//  - Touch: a plain tap is left entirely to the browser (native click, or the
//    native picker for the Map Type <select>). Sliding a finger along the
//    stack raises whichever card is under it; lifting presses that card, and
//    the stray native click from the slide is swallowed. Sliding well off the
//    stack vertically cancels.

const SLIVER_PX = 41;
const MIN_SLIVER_PX = 14;
const SLIDE_THRESHOLD_PX = 8;
const CANCEL_OFF_STACK_PX = 40;

export function initCardStack() {
  const rows = [document.getElementById('status-tiles'), document.getElementById('status-tiles-2')];
  if (rows.some(r => !r)) return;

  const stack = document.createElement('div');
  stack.id = 'card-stack';
  rows[0].parentNode.insertBefore(stack, rows[0]);
  for (const row of rows) {
    for (const el of [...row.children]) {
      el.classList.add('stack-card');
      stack.appendChild(el);
    }
    row.style.display = 'none';
  }

  const visibleCards = () => [...stack.children].filter(c => c.style.display !== 'none');

  let step = SLIVER_PX;
  function layout() {
    const cards = visibleCards();
    // While the toolbar is hidden (startup, edit/anim/underway modes) every
    // measurement reads 0 — laying out then gave a far-too-wide stack on the
    // Pixel emulator. The ResizeObserver below re-runs this once it shows.
    if (!cards.length || !stack.parentElement.offsetParent) return;
    const cardW = cards[0].offsetWidth;
    // #map-overlay-status is absolutely positioned and shrink-wraps its
    // content, so its own width is just the stack's. Measure the real room:
    // from its left edge to the map container's right edge, less a margin.
    const host = stack.parentElement;
    const box = (host.offsetParent || document.body).getBoundingClientRect();
    const avail = box.right - host.getBoundingClientRect().left - 10;
    step = cards.length > 1
      ? Math.max(MIN_SLIVER_PX, Math.min(SLIVER_PX, (avail - cardW) / (cards.length - 1)))
      : SLIVER_PX;
    cards.forEach((c, i) => {
      c.style.left = `${Math.round(i * step)}px`;
      c.style.zIndex = String(i + 1); // later cards on top, so each one's LEFT edge peeks out
    });
    stack.style.width = `${Math.round((cards.length - 1) * step + cardW)}px`;
  }

  function cardAt(clientX) {
    const cards = visibleCards();
    const i = Math.floor((clientX - stack.getBoundingClientRect().left) / step);
    return cards[Math.max(0, Math.min(cards.length - 1, i))] || null;
  }

  let raised = null;
  function raise(card) {
    if (raised === card) return;
    raised?.classList.remove('stack-raised');
    raised = card;
    card?.classList.add('stack-raised');
  }

  function press(card) {
    if (card.tagName === 'SELECT') {
      try { card.showPicker(); } catch { card.focus(); }
    } else {
      card.click();
    }
  }

  // ── Touch ──
  let touchId = null, startX = 0, sliding = false, swallowClick = false, lowerTimer = 0;
  stack.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || touchId !== null) return;
    touchId = e.pointerId;
    startX = e.clientX;
    sliding = false;
    clearTimeout(lowerTimer);
    raise(cardAt(e.clientX));
  });
  stack.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') { raise(cardAt(e.clientX)); return; }
    if (e.pointerId !== touchId) return;
    if (!sliding && Math.abs(e.clientX - startX) < SLIDE_THRESHOLD_PX) return;
    sliding = true;
    const r = stack.getBoundingClientRect();
    const off = e.clientY < r.top - CANCEL_OFF_STACK_PX || e.clientY > r.bottom + CANCEL_OFF_STACK_PX;
    raise(off ? null : cardAt(e.clientX));
  });
  const endTouch = (e, cancelled) => {
    if (e.pointerId !== touchId) return;
    touchId = null;
    if (sliding) {
      // Press BEFORE arming the swallow — press() dispatches a click itself,
      // and the swallow would eat it (confirmed on the Pixel emulator).
      if (raised && !cancelled) press(raised);
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 400);
    }
    lowerTimer = setTimeout(() => raise(null), 300);
  };
  stack.addEventListener('pointerup', (e) => endTouch(e, false));
  stack.addEventListener('pointercancel', (e) => endTouch(e, true));
  stack.addEventListener('click', (e) => {
    if (swallowClick) { e.stopImmediatePropagation(); e.preventDefault(); swallowClick = false; }
  }, { capture: true });

  // ── Mouse / keyboard ──
  stack.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') raise(null); });
  stack.addEventListener('focusin', (e) => raise(e.target.closest('.stack-card')));
  stack.addEventListener('focusout', () => raise(null));

  // Re-lay-out when a card is shown/hidden (offline-btn, paintings-list-btn)
  // or the window resizes.
  // layout() itself writes style.left/zIndex, so only react when the set of
  // visible cards actually changed — otherwise this would loop forever.
  let visibleKey = '';
  const relayoutIfVisibilityChanged = () => {
    const key = visibleCards().map(c => c.id).join(',');
    if (key !== visibleKey) { visibleKey = key; layout(); }
  };
  const obs = new MutationObserver(relayoutIfVisibilityChanged);
  for (const c of stack.children) obs.observe(c, { attributes: true, attributeFilter: ['style'] });
  window.addEventListener('resize', layout);
  // initCardStack runs before the map container has its final size (seen on
  // the Pixel emulator: first layout measured too much room, slivers ran off
  // the right edge). Re-measure whenever the container actually resizes.
  const container = stack.parentElement.offsetParent;
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(layout);
    if (container) ro.observe(container);
    ro.observe(stack.parentElement); // 0 → real size when the toolbar is shown
  }
  window.addEventListener('load', layout);
  visibleKey = visibleCards().map(c => c.id).join(',');
  layout();
}
