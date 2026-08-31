# Recent Changes — Focus Target & Simulate Heading (v317–v325)

> A feature deep-dive, not the changelog — see [CHANGELOG.md](CHANGELOG.md)
> for the canonical release history.

This document covers a cluster of related features added over several
sessions between **2026-07-13 and 2026-07-19**, spanning app versions
**v317 through v325**. It's meant to be read start to finish — each section
builds on the one before it.

---

## 1. Focus Target (v317)

The core new concept: a **focus** is a "current point of interest" —
a place, waypoint, buoy, or bare coordinate — that you can set once and
then repeatedly ask "how far / what bearing" without re-stating the full
query.

**Setting a focus:**
- Any successful bearing query auto-sets the focus ("bearing to Carvers
  Harbor" → Carvers Harbor becomes the focus).
- Voice/text: `"focus on <place>"`.
- Tap **Set focus** in a navaid or waypoint's popup.
- Long-press the map → **Set focus here**.

**Using it:**
- Say/type a bare `"bearing"`, `"range"`, `"how far"`, or `"status"` to
  re-query the current focus without repeating its name.
- Tap the **🎯** button (top status bar) — same effect.
- `"clear focus"` clears it.

The focus persists across reloads (saved to `localStorage`), and the 🎯
button always shows its current name (or `🎯 --` if none is set).

---

## 2. Reliability fixes (v318–v319)

Bugs found while testing the feature above:

- **Test-position form is now cancelable.** Previously the only way to
  dismiss the 📍 test-position input was to tap "Clear." Escape or
  clicking outside the form now closes it without setting anything.
- **Route-node focus is named properly.** Long-pressing a route node
  while editing a route and choosing "Set focus here" now labels the
  focus with the route name and node number (e.g.
  *"Rockland-PerryCreek WP2"*) instead of a bare "Point."
- **TTS no longer cuts out mid-sentence.** Two separate bugs were found
  and fixed:
  - The browser can *pause* speech mid-utterance (e.g. a brief
    audio-focus interruption) — now resumed immediately instead of after
    a long timeout.
  - Mobile Chrome has a known bug where an interrupted utterance goes
    completely silent without ever signaling it's done — a watchdog now
    detects this and replays the sentence once from the top instead of
    leaving it truncated.

---

## 3. Drag-to-place focus + scrolling transcript (v320–v321)

**Drag-to-place:** long-pressing the map and choosing "🎯 Set focus here"
now drops a small draggable marker instead of confirming instantly. It
pulses gently while you're just moving it around, and snaps onto (and
flashes) the nearest navaid, waypoint, or route node within a few pixels
of your finger — so you can precisely land the focus on a real object even
with an imprecise tap. A small banner with ✓ (confirm) and ✕ (cancel)
finishes the placement.

**Scrolling transcript:** the response box at the bottom of the screen
used to just show the single most recent message — every new response or
spoken line silently erased the last one. It's now an append-only,
timestamped, auto-scrolling log (capped at 200 lines) of everything shown
or spoken, so you can scroll back and see what happened a few queries ago.

---

## 4. Persistent draggable focus marker (v322)

The drag-to-place marker from v320 only appeared during that one
placement gesture. Now, **whenever a focus is set — by any method — a
marker for it stays on the map permanently**, and you can drag it at any
time to nudge or retarget it, not just when first placing it. Dragging it
snaps the same way as before (onto navaids/waypoints/route nodes) and
speaks the usual "Focused on…" confirmation on release.

*(A real bug was found and fixed while building this: the "locked on"
flash animation was accidentally fighting with Leaflet's own positioning
logic and rendering the marker in the wrong place. Fixed by changing what
CSS property the animation uses.)*

---

## 5. Dismissable transcript (v323)

The scrolling transcript from v321 can grow tall enough to cover part of
the map on a small phone screen. A small **×** in its corner now hides it
temporarily — it reappears automatically the next time there's something
new to show, so dismissing it isn't a permanent setting.

---

## 6. Bearing ray to focus target (v324)

A thin dashed green ray now extends from the boat's current position
along the bearing to your focus target, running a bit past the target's
actual distance. It updates live as you move (GPS fix or dragging the
test position) and whenever the focus changes — including while you're
dragging the persistent focus marker itself. It disappears when there's
no focus set.

---

## 7. Simulate Heading — dead-reckoning rehearsal tool (v325)

A new, separate tool for a different question: *"if I steer this heading,
where do I end up?"* — independent of any focus target.

**How to use it:**
1. Set the boat's position (test position or live GPS).
2. Optionally pick a route in the hamburger menu → **Track** submenu.
3. Tap **🧭 Simulate heading** (new button in that same submenu).
4. **Drag** the cyan handle around the boat, or **type a bearing number**
   — either way, a cyan dashed ray extends from the boat along that
   heading, and the boat icon itself rotates to visually point that way.
5. **Done** or **Cancel** to exit — nothing is saved, it's a rehearsal.

The ray's length depends on context: if you picked a route, it measures
to the nearest waypoint *ahead* of the boat on that route (so you can
check whether a given heading would actually get you there); otherwise it
falls back to your current focus target; otherwise a flat 5 nm.

All headings are shown and entered in **magnetic degrees**, matching how
the rest of the app speaks bearings.

---

## Also investigated: real bearing & speed from live GPS

While building this, the question came up: can the app compute your
*actual* bearing and speed over ground while sailing, not just simulated
ones? Short answer — **the raw data already exists but is currently
thrown away**:

- The browser's own GPS API reports `speed` and `heading` fields when the
  device is moving fast enough to compute them, but the code only reads
  latitude/longitude from it today.
- The NMEA `$GPRMC` sentences the app already parses (from a USB GPS
  puck or OpenCPN) contain speed and course fields too, also currently
  discarded.

This wasn't implemented — GPS-derived heading is also fairly noisy at
typical light-air sailing speeds and would need smoothing to be useful.
It's a reasonable next feature if wanted.

---

## Current version

**v325**, deployed to GitHub Pages. Remember **Shift-CMD-R** after an
update to force the installed PWA to pick up the new version.
