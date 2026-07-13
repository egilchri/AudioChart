# AudioChart — "Focus Target" feature

Hand this file to Claude Code in the `AudioChart` repo and ask it to apply the
changes described below. Each section names the file, gives an anchor (existing
code to find), and the code to add near it.

## Goal

- Designate a waypoint / named place / navaid / point as the **focused target**.
- A permanent on-screen button shows the focus name and, when tapped, speaks
  and displays bearing + range to it — no need to re-say the full query.
- Any successful "bearing to X" query also sets X as the new focus automatically.
- Voice/text commands: `"focus on <place>"`, `"clear focus"`, and bare
  `"bearing"` / `"range"` / `"how far"` / `"status"` (re-queries the focus).
- Focus persists across reloads via localStorage (useful on an all-day sail).

---

## 1. `www/js/query.js`

Add near the other `let last...Result` exports at the top:

```js
export let focusedTarget = null;   // {lat, lon, name, type} — the "current" object

const FOCUS_KEY = 'audiochart-focus';

export function setFocus(lat, lon, name, type = 'place') {
  focusedTarget = { lat, lon, name, type };
  try { localStorage.setItem(FOCUS_KEY, JSON.stringify(focusedTarget)); } catch (_) {}
}

export function clearFocus() {
  focusedTarget = null;
  try { localStorage.removeItem(FOCUS_KEY); } catch (_) {}
}

export function loadStoredFocus() {
  try {
    const s = localStorage.getItem(FOCUS_KEY);
    if (s) focusedTarget = JSON.parse(s);
  } catch (_) {}
  return focusedTarget;
}

/** Bearing/range to the currently focused target. Returns null if none set. */
export function bearingToFocusedTarget(lat, lon) {
  if (!focusedTarget) return null;
  return _formatBearingResult(
    lat, lon, focusedTarget.lat, focusedTarget.lon, focusedTarget.name,
    focusedTarget.type === 'waypoint', 1.0
  );
}
```

Then make successful bearing queries auto-set the focus. Inside
`_formatBearingResult` (the shared helper used by `bearingToPlace`,
`bearingToResolvedPlace`, and indirectly `bearingToCoord`), add one line right
after the existing `lastBearingResult = { ... }` assignment:

```js
function _formatBearingResult(lat, lon, flat, flon, name, isWaypoint, score) {
  const brg = trueTomagnetic(bearing(lon, lat, flon, flat));
  const dist = distanceNm(lon, lat, flon, flat);
  lastBearingResult = { destLat: flat, destLon: flon, destName: name, destType: isWaypoint ? 'waypoint' : 'place', brg, distNm: dist };
  setFocus(flat, flon, name, isWaypoint ? 'waypoint' : 'place');   // <-- ADD THIS LINE
  ...
```

And in `bearingToCoord` (which has its own bearing-result block since it has
no name), add a focus set with a generic label:

```js
export function bearingToCoord(lat, lon, targetLat, targetLon) {
  const brg = trueTomagnetic(bearing(lon, lat, targetLon, targetLat));
  const dist = distanceNm(lon, lat, targetLon, targetLat);
  lastBearingResult = { destLat: targetLat, destLon: targetLon, destName: null, destType: 'coord', brg, distNm: dist };
  setFocus(targetLat, targetLon, null, 'coord');   // <-- ADD THIS LINE
  ...
```

---

## 2. `www/js/parser.js`

Add these patterns to the `PATTERNS` array. Order doesn't matter much for the
first two (no keyword overlap with existing patterns), but the bare-command
one should go near the top since it's a full-string anchor and cheap to check
first:

```js
  // QUERY FOCUS — bare repeat command, must be the WHOLE transcript
  {
    re: /^(?:range\s+and\s+bearing|bearing\s+and\s+range|bearing|range|distance|how\s+far|status|check)\s*[?.!]?\s*$/i,
    intent: 'QUERY_FOCUS',
    params: {},
  },

  // SET FOCUS
  {
    re: /\b(?:focus\s+on|set\s+focus\s+(?:to|on)|watch)\s+(.{3,60})$/i,
    intent: 'SET_FOCUS',
    extract: (m) => ({ placeName: m[1].trim() }),
  },

  // CLEAR FOCUS
  {
    re: /\b(?:clear|cancel|remove)\s+focus\b/i,
    intent: 'CLEAR_FOCUS',
    params: {},
  },
```

Insert these before the existing `BEARING_TO_COORD` / `BEARING_TO_PLACE`
patterns at the bottom of the array (order relative to those two doesn't
matter since the regexes don't overlap).

---

## 3. `www/js/app.js`

### 3a. New switch cases

Inside `handleCommand`'s `switch (intent)` block, add three cases (near
`BEARING_TO_PLACE` is a natural spot):

```js
      case 'QUERY_FOCUS': {
        response = Query.bearingToFocusedTarget(pos.lat, pos.lon);
        if (!response) {
          response = {
            text: 'No focus set. Try "focus on <place>" or ask a bearing question first.',
            speech: 'No focus set. Try focus on, followed by a place name.',
          };
        }
        break;
      }
      case 'SET_FOCUS': {
        let place = Query.findPlaceByName(params.placeName);
        if (!place && serverUrl) place = await Query.findPlaceOnServer(params.placeName);
        if (!place) {
          response = { text: `Couldn't find "${params.placeName}".`, speech: `I couldn't find ${params.placeName}.` };
          break;
        }
        Query.setFocus(place.lat, place.lon, place.name, 'place');
        _updateFocusButton();
        response = { text: `Focused on ${place.name}.`, speech: `Focused on ${place.name}.` };
        break;
      }
      case 'CLEAR_FOCUS': {
        Query.clearFocus();
        _updateFocusButton();
        response = { text: 'Focus cleared.', speech: 'Focus cleared.' };
        break;
      }
```

Also add `'QUERY_FOCUS'` to the `isBearingIntent` line further down so the
bearing map/line is drawn the same way an ordinary bearing query would:

```js
    const isBearingIntent = (intent === 'BEARING_TO_PLACE' || intent === 'BEARING_TO_COORD' || intent === 'QUERY_FOCUS');
```

### 3b. Focus button wiring

Near where `testPosBtn` is defined (around line 285), add:

```js
const focusBtn = document.getElementById('focus-btn');

function _updateFocusButton() {
  if (!focusBtn) return;
  const f = Query.focusedTarget;
  focusBtn.textContent = f ? `🎯 ${f.name || 'Point'}` : '🎯 --';
  focusBtn.classList.toggle('focus-active', !!f);
  focusBtn.title = f ? `Bearing & range to ${f.name || 'focused point'}` : 'No focus set';
}

focusBtn?.addEventListener('click', () => {
  if (!Query.focusedTarget) {
    TTS.sayImmediate('No focus set. Say focus on, followed by a place name.');
    return;
  }
  handleCommand('bearing');   // reuses the QUERY_FOCUS path end-to-end
});
```

(A long-press-to-clear is optional; the voice/text command `"clear focus"`
already covers it, and it can be added to the map long-press menu later if
wanted.)

### 3c. Restore focus on load

In `init()` (wherever startup wiring happens, alongside other localStorage
reads like `_seamarksVisible`), add:

```js
Query.loadStoredFocus();
_updateFocusButton();
```

---

## 4. `www/index.html`

Add the button next to `test-pos-btn` in the top status overlay:

```html
<button id="focus-btn" title="No focus set">🎯 --</button>
```

so that block reads:

```html
<button id="offline-btn" ...>&#11015; Offline</button>
<button id="route-btn" ...>&#11015; Route</button>
<button id="test-pos-btn" title="Set test position">&#128205;</button>
<button id="focus-btn" title="No focus set">🎯 --</button>
```

---

## 5. `www/css/app.css`

Reuse whatever class `test-pos-btn` / `offline-btn` already use for sizing;
just add a highlight state:

```css
#focus-btn.focus-active {
  background: #1a6b3c;
  color: #fff;
}
```

---

## 6. Tap-a-marker-to-focus (in addition to voice/text)

The navaid "object browser" layer (`_refreshNavaidOverlay` in `app.js`, the
one toggled by the 🧭 Objects panel) already gives each navaid marker a popup
with a "Range & bearing" button — this is the natural place to add a third
button.

### 6a. Navaid markers — extend the existing popup

Find this block inside `_refreshNavaidOverlay`:

```js
      m.bindPopup(
        `<div class="navaid-popup">
           <div class="navaid-popup-name">${safeName}</div>
           <button class="navaid-popup-brg">Range &amp; bearing</button>
           <button class="navaid-popup-copy">Copy name</button>
         </div>`,
        { maxWidth: 220, className: 'navaid-popup-wrapper' }
      );
```

Add a focus button to the markup:

```js
      m.bindPopup(
        `<div class="navaid-popup">
           <div class="navaid-popup-name">${safeName}</div>
           <button class="navaid-popup-brg">Range &amp; bearing</button>
           <button class="navaid-popup-focus">&#127919; Set focus</button>
           <button class="navaid-popup-copy">Copy name</button>
         </div>`,
        { maxWidth: 220, className: 'navaid-popup-wrapper' }
      );
```

And wire it inside the existing `m.on('popupopen', ...)` handler, alongside
the `.navaid-popup-brg` / `.navaid-popup-copy` listeners:

```js
        el.querySelector('.navaid-popup-focus').addEventListener('click', () => {
          _map.closePopup();
          Query.setFocus(lat, lon, n.name, 'place');
          _updateFocusButton();
          const msg = `Focused on ${n.name}.`;
          showResponse(msg);
          TTS.sayImmediate(msg);
        });
```

### 6b. Waypoint markers — add a popup (they currently have none)

In `_refreshWaypointLayer`, the marker is created like this:

```js
      const m = L.marker([wp.lat, wp.lon], { icon: _waypointIcon(), draggable: true });
      m.bindTooltip(wp.name, { permanent: true, direction: 'top', className: 'map-tooltip' });
```

Add a popup right after the tooltip line:

```js
      m.bindPopup(
        `<div class="navaid-popup">
           <div class="navaid-popup-name">${wp.name}</div>
           <button class="navaid-popup-focus">&#127919; Set focus</button>
         </div>`,
        { maxWidth: 220, className: 'navaid-popup-wrapper' }
      );
      m.on('popupopen', (e) => {
        e.popup.getElement().querySelector('.navaid-popup-focus').addEventListener('click', () => {
          _map.closePopup();
          Query.setFocus(wp.lat, wp.lon, wp.name, 'waypoint');
          _updateFocusButton();
          const msg = `Focused on ${wp.name}.`;
          showResponse(msg);
          TTS.sayImmediate(msg);
        });
      });
```

(Reuses the `navaid-popup` CSS class already in `app.css` — no new styling
needed.)

### 6c. Arbitrary map point — long-press context menu

For "the current object" being any point on the water (not a charted
feature), add an entry to the existing right-click/long-press menu next to
`map-ctx-route-from-here`.

In `www/index.html`, near the `map-ctx-route-from-here` button:

```html
<button id="map-ctx-set-focus">&#127919; Set focus here</button>
```

In `www/js/app.js`, near the `map-ctx-route-from-here` listener (~line 4118):

```js
  document.getElementById('map-ctx-set-focus').addEventListener('click', () => {
    _hideCtx();
    if (!_ctxLatLng) return;
    Query.setFocus(_ctxLatLng.lat, _ctxLatLng.lng, null, 'coord');
    _updateFocusButton();
    const msg = 'Focused on this point.';
    showResponse(msg);
    TTS.sayImmediate(msg);
  });
```

---

## Test checklist

1. `bearing to Carvers Harbor` → focus button updates to "🎯 Carvers Harbor".
2. Say/type `bearing` alone → repeats bearing+range to Carvers Harbor.
3. `focus on Owls Head` → button updates, no bearing spoken (just confirmation).
4. Tap the focus button → speaks bearing/range to Owls Head.
5. `clear focus` → button resets to "🎯 --"; bare `bearing` now says "No focus set."
6. Reload the page → focus from before reload is restored (persisted via localStorage).
7. Open the Objects (🧭) panel, tap a buoy marker → popup shows "Set focus" → tapping it updates the focus button.
8. Tap a waypoint marker on the map → same "Set focus" popup works.
9. Long-press/right-click any point on open water → "Set focus here" → focus button shows "🎯 Point" (or similar) with no name.
