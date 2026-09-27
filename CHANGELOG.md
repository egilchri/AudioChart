# Changelog

> **2026-05-15 to 2026-07-22 isn't logged here.** `COMMITS.md` was frozen
> around this date with a note naming this file "authoritative going
> forward," but it wasn't actually kept up — see `COMMITS.md` for its own
> log through mid-May, or `git log` for the raw commit history in between.
>
> The blocks from 2026-07-22 through today (v676) resume coverage, but as
> a **condensed summary, not a commit-by-commit log** — each groups a real
> span of work into one entry rather than reproducing every commit
> message. See [RECENT_CHANGES.md](RECENT_CHANGES.md) for a full prose
> deep-dive on the v317–v325 cluster specifically (Focus Target, Simulate
> Heading); the summaries below start right after that.

## 2026-09-27 — Make route-planning time limit a user setting (v706)

Direct follow-up to the deadline tuning in v703/v705: a real Penobscot Bay
case varied 9.2s to 14s+ run to run across a normal dev machine and a
slower CI runner, for a route that always had a real, valid answer — no
single hardcoded `DEADLINE_MS` was going to be right for every device or
every user's patience. Someone planning a passage the night before can
reasonably wait longer than someone checking a quick local hop.

`router.js`'s `DEADLINE_MS`/`LONG_RANGE_DEADLINE_MS` constants are now a
caller-supplied `deadlineMs` parameter on `autoRouteProg` (threaded
through every recursive call: escape sub-legs, long-range depart/transit/
arrive), defaulting to a new exported `DEFAULT_DEADLINE_MS` (14000, same
as before) when not specified. The long-range overall envelope is derived
as `deadlineMs * 3` rather than a second hardcoded constant, so raising
the one user-facing number scales both budgets together.

Added "Route planning time limit" as its own setting next to Boat Draft
in the Objects panel (5-120s, persisted the same way), read via a new
`_currentDeadlineMs()` helper mirroring `_currentDraftFt()`'s pattern,
threaded into all three real AutoRoute/Re-route call sites in app.js.
Verified live: value persists across reload, and `Router.
DEFAULT_DEADLINE_MS` is correctly exported. Test suite and its two
long-range cases updated to the new parameterized shape — all previously-
passing cases still pass identically after the refactor (`test/
test_query.js` 25/25, `test/test_channel_routing.js` unchanged from v705).

## 2026-09-27 — Always keep 3ft of clearance under the keel (v705)

Direct requirement: "Always keep at least 3ft under the keel." Every
depth-hazard formula in the codebase (`eff = valsou + tide`, blocked if
`<= draft`) had zero safety margin — a verified real route existed with
only ~3cm of charted clearance at its tightest point, arithmetically
"passing" but not something a real mariner would call safe.

Added a `KEEL_CLEARANCE_MARGIN_M` (3ft) constant, applied consistently
everywhere a depth/tide comparison decides whether water counts as
navigable: `router.js`'s `tidalObs` hazard filter, the v700
`_soundingsClearCrossing` override, `query.js`'s `_makeObstacleCheck`
(used by both `snapToNavigableWater` for start/end relocation and
`findClearOffshorePoint` for long-range escape points), and the map's
depth-overlay red/yellow coloring in `app.js` (so a cell shown red is
exactly a cell AutoRoute will actually avoid).

Widening what counts as hazardous surfaced two further, real consequences
— found and fixed in the same pass, not deferred:
- A genuinely in-scope Penobscot Bay route (Rockland -> WoodenBoat
  School/Center Harbor) started **genuinely failing** (A* provably
  exhausted its local search, not a timeout) because more of the map now
  correctly counts as hazardous than the existing node/ring budget
  (`MAX_EXTRA_NON_BLOCKING_RINGS`/`NODES`) was tuned for. Confirmed via a
  scratch test that raising the budget (60->150 rings, 300->900 nodes)
  restored a real, verified-safe 47-point route. Not a workaround —
  a real route exists and now gets found.
- That wider search costs more time even for routes that don't strictly
  need it, pushing an already-marginal real case (Rockland -> Carvers
  Harbor/Vinalhaven) past `DEADLINE_MS`, varying 9.2-12s run to run on
  the same machine for a route that always finds a real, valid answer.
  Raised `DEADLINE_MS` 10000->14000 and `LONG_RANGE_DEADLINE_MS`
  30000->42000 (proportional), same "wait longer, don't falsely report
  impossible" reasoning as the first increase (v703).

Also fixed the test suite's own long-standing mismatch (surfaced
repeatedly this session): it applied the general per-leg `DEADLINE_MS`
to long-range cases' *total* wall-clock, even though those legitimately
spend several sequential per-leg budgets under their own, separate,
larger `LONG_RANGE_DEADLINE_MS`. `runCase` now takes an optional
per-case deadline override, used for the two long-range cases.

**Known, deliberately not chased further:** case `[7]` (Portsmouth NH ->
Bar Harbor, ~136nm) still genuinely fails under the new margin — a
different leg provably has no connected path within its local search
graph, confirmed NOT fixable by more budget alone (tested up to 300
rings/1800 nodes: the bottleneck just moves to a different leg's timeout
instead of resolving). That route is **outside Penobscot Bay**, the
stated scope of the release goal — flagged as a known hard case for
future work, not treated as release-blocking. All gated in-scope
Penobscot Bay cases (`[10]`-`[17]`, excluding `[7]`) pass reliably across
repeated runs. `test/test_query.js` (25/25) passes.

## 2026-09-27 — Surface boat draft as its own always-visible setting (v704)

Draft already existed as a persisted setting (`nf-draft-ft`, saved to
localStorage, read by every AutoRoute/Re-route call) but was undiscoverable:
it lived inside the "Objects" (navaid filter) panel, nested under `Depths`
and hidden entirely (`display:none`) unless that checkbox — an unrelated
map-*display* toggle — was checked first. Direct user report: "I need to
be able to set the draft of my boat in settings" — they couldn't find it.

Moved "Boat draft" out from under the Depths-only wrapper to its own
always-visible row in the Objects panel (a divider separates it from the
display-toggle checkboxes above it), independent of whether the Depths
overlay is shown or hidden. The tide-status readout stays under the
Depths toggle (that one's genuinely about the overlay). No storage/JS
logic changed — same key, same restore-on-load, same input listener —
verified live: value persists across reload, and the draft row stays
visible with Depths unchecked.

## 2026-09-27 — Raise routing deadlines: prefer waiting over a false "impossible" (v703)

v702's caching optimization was real (30-45% faster on most cases) but
CI still failed 3 cases on the very next push — CI's shared runner
measured ~1.7-2x slower than local dev hardware, enough to push already-
marginal legs (`[7]`, `[16]`, `[17]`) past `DEADLINE_MS=5000` even after
the speedup, with two degrading to an unsafe straight-line-across-land
fallback. Chasing further micro-optimization has diminishing returns and
doesn't address the actual constraint: the goal set for this release
(AutoRoute must succeed anywhere in Penobscot Bay unless truly
impossible — see `project_penobscot_bay_flawless_autoroute_goal` memory)
means a slow-but-findable safe route should never be abandoned for an
unsafe fast one just because a device is having a slow moment.

Raised `DEADLINE_MS` 5000 -> 10000 (per-leg local-search budget) and
`LONG_RANGE_DEADLINE_MS` 15000 -> 30000 (overall long-range envelope,
scaled proportionally since a long-range passage can spend several
sequential per-leg budgets). Test's own mirrored constant updated to
match. All regression cases pass locally with comfortable margin even
assuming CI-level slowdown (worst case `[16]` 4190ms vs the new 10000ms
budget, `[7]`'s worst single leg 3209ms vs the same). This is a
deliberate latency-for-reliability tradeoff, not a hidden one — a
genuinely hard route may now take noticeably longer to plan, in exchange
for actually finding the safe route that exists rather than giving up.

## 2026-09-27 — Cache point-in-ring containment per coordinate, not per edge (v702)

v701's fix (below) was correct but its cost model was wrong: it re-ran a
fresh point-in-ring ray-cast on every `(edge, ring)` pair, even though A*
calls `segBlocked` thousands of times against the SAME small set of
`nodes[]` coordinates. Confirmed on GitHub's CI runner (slower/shared than
local): 3 regression cases failed outright, 2 of them (`[7]` long-range
Portsmouth NH -> Bar Harbor, `[16]` Rockland -> Carvers Harbor) degrading
all the way to an unsafe straight-line-across-land fallback — a real,
live failure of exactly the kind the user's stated release goal (AutoRoute
must succeed anywhere in Penobscot Bay unless truly impossible — see
`project_penobscot_bay_flawless_autoroute_goal` memory) rules out.

Fixed by caching containment per distinct coordinate (`_tidalRingsContaining`,
keyed by exact lon/lat, reusing the point's own `extraGrid` cell so it
only ever tests rings already spatially local to it) and making the check
fully lazy — only computed for a coordinate that actually reaches an
`isTidal` ring neither `landBlocks` nor `Query.ringBlocks` already
resolved. Each distinct point now pays for its own containment check
at most once per search, not once per candidate edge that touches it.
Result: most regression cases dropped 30-45% in wall-clock time versus
v701 (e.g. `[16]` 4895ms -> ~4200ms, `[17]` 3279ms -> ~2800ms, `[10]`
1077ms -> 770ms, `[14]` 1578ms -> 874ms) with identical routes/outcomes.
`test/test_query.js` (25/25) and `test/test_channel_routing.js` (all
gated cases) pass, repeated 3x locally for stability.

**Still an open concern, not resolved by this entry:** case `[7]`
specifically (a genuinely large long-range, multi-bracket, ~136nm
passage) remains marginal — 4.8-5.0s across repeated local runs, i.e.
within low single-digit percent of `DEADLINE_MS`. Each individual sub-leg
comfortably fits its own 5000ms budget in every local run (the real
router would not have fallen back), but the CI failure above shows a
slow-enough moment can still push one sub-leg over that per-leg wall,
cascading into `_longRangeRoute` abandoning the whole passage for an
unsafe straight line — even though a real, safe 42-point route
demonstrably exists (found in every successful run). This is exactly the
scenario the stated release goal calls out. Flagged for the user rather
than resolved unilaterally: either a further algorithmic speedup, or a
deliberately larger per-leg budget specifically for long-range sub-legs
(distinct from the general 5s local-search budget), is needed before this
can be called reliably solved.

## 2026-09-27 — Fix: segments fully inside a hazard ring went undetected (v701)

Found immediately after v700 while double-checking the fixed route's real
minimum depth (not just trusting the router's own pass/fail): a *different*
segment on the same Perry Creek route crossed real charted soundings of
0.3-0.6m — genuinely dangerous at a 3.5ft draft — with no hazard flagged
at all. Confirmed this predates today's session entirely (reproduced
against the pre-v700 router unchanged).

Root cause: `Query.ringBlocks`/`_ringBlocks` only detects a segment
*crossing* a ring's boundary edge. A segment whose both endpoints already
sit inside the same hazard ring never crosses an edge at all — topologically
zero boundary intersections — so it silently passed as "clear" no matter
how deep inside a hazardous polygon it actually ran. Real risk anywhere in
the bay: the broad tidal DEPARE polygons in this dataset are large enough
(one spans nearly the whole visible chart) that many graph nodes can
legitimately fall inside one without ever being checked against it.

Fix: `segBlocked` now also checks whether either endpoint is contained
inside a tidal ring (point-in-ring, using the existing `_pointInRing`
already in router.js), not just boundary-crossing. Scoped to `isTidal`
rings only, with a cheap bbox pre-check before the full ray-cast — first
version checked every ring type and was a measured regression, pushing two
already-marginal real regression-suite cases (`[7]` long-range Portsmouth
NH -> Bar Harbor, `[16]` Rockland -> Carvers Harbor) past `DEADLINE_MS`,
with `[16]` degrading all the way to an unsafe straight-line-across-land
fallback — a worse outcome than before this fix existed. Re-verified after
scoping down: both cases pass again (`[7]` 4915ms, `[16]` 4895ms — closer
to the 5s deadline than is comfortable, flagged as an open concern, not
resolved by this entry). `test/test_query.js` (25/25) and `test/
test_channel_routing.js` (all gated cases) both pass.

**Two things this surfaced that still need a decision, not code:**
1. The real Perry Creek route this fix now produces has only ~3cm of
   charted clearance at its tightest point (1.1m sounding vs 1.07m draft)
   — the hazard formula (`eff = valsou + tide`, block if `<= draft`) has
   *no* safety margin at all; 3cm and 30m both count as "pass." Needs an
   explicit minimum-clearance buffer, not a judgment call buried in code.
2. Two real routes in the regression suite now run within ~2% of
   `DEADLINE_MS` (5000ms) — not yet a real failure, but not much headroom
   either, and the user's stated release goal is that AutoRoute must
   succeed anywhere in Penobscot Bay unless truly impossible (see
   `project_penobscot_bay_flawless_autoroute_goal` memory).

## 2026-09-27 — Router trusts real soundings over a tidal polygon's worst case (v700)

Follow-up to v698/v699: those fixed the *symptom* (silent destination
relocation) but a live investigation of the actual reported case (autoroute
to a Perry Creek search pin) found a real router over-caution underneath
it. The router's tidal-hazard check flags an entire charted DEPARE
(depth-range) polygon as blocking if its single worst-case `valsou`
(minimum depth anywhere in that polygon) would be too shallow at the
current draft/tide — but a real DEPARE polygon can span a huge area
(confirmed: one spanned nearly the whole visible chart, `valsou=0`,
labeled range "0.0-5.4m") while the actual charted soundings along one
specific candidate edge showed 6-14.6m of real water the entire way. That
blanket rule forced the router to detour ~2nm out along the Fox Islands
Thorofare channel and back rather than cutting directly to the
destination, even though the direct line was genuinely safe (verified via
real sounding data, not assumed).

Fix: `segBlocked` in `router.js` now takes a tidal-ring block as a
starting point, not a final answer — it samples real charted soundings
(`Query.soundings`) every 0.05nm along the specific candidate edge, and
only overrides the polygon's block if *every* sample has a nearby real
sounding (0.15nm search radius) showing adequate depth. Any gap in
sounding coverage stays conservative and keeps the original block — this
only ever clears a tidal DEPARE block, never a land ring or a point hazard
(rock/wreck/obstruction), and never on missing data.

First implementation used `Query.nearestSounding` directly and was a real
regression: a ~20k-feature flat scan per sample, called from inside
`segBlocked` (itself called thousands of times per search), pushed one
real route from ~1s to 15s+, blowing `DEADLINE_MS` and silently degrading
to the straight-line fallback — a worse outcome than before the fix.
Replaced with a lazily-built, call-scoped spatial grid over
`Query.soundings` (same pattern as the existing `extraGrid`, cells sized
to the search radius). Verified live: the same Perry Creek case now
routes directly (12-14 points depending on draft, ~1.1-1.3s, no detour)
at both the user's real 3.5ft draft and the 5ft default; both `test/
test_query.js` (25/25) and `test/test_channel_routing.js` (all cases,
including the timing-sensitive long-range case) pass with no regressions.

## 2026-09-27 — Same shallow-water snap fix, also missed in the "Auto Route" draw flow (v699)

v698 only wired the new `onSnap` surfacing into `_triggerAutoRoute` (the
marker-popup "AutoRoute from boat position" / map context-menu "Route to
here" pipeline). Missed that `_onDrawConfirm` — the Routes panel's own
"Auto Route" button, tap-start/tap-destination flow, and by its own
existing code comment literally "the PRIMARY 'auto-route to here' entry
point" — calls `Router.autoRouteProg` directly and independently, with no
shared code path to `_triggerAutoRoute` at all. It had the exact same
silent-relocation gap. Found by re-testing after a user report of "no
progress" on the exact same repro on v698; traced to this second, separate
call site. Same fix applied: `onSnap` wired through, snap note surfaced
via setStatus/TTS, persistent amber marker left at the real routed point.
Verified live (tap-start/tap-destination onto known shallow water):
status showed both a start-moved and a destination-moved note, and both
markers appeared at their correct snapped coordinates.

Still open: `_reRouteSegments` (the "Reroute"/"Fix selected nodes" flow in
edit mode) shares the same `autoRouteProg` call but doesn't have this
surfacing yet — lower priority since it's re-routing an existing waypoint,
not silently relocating a fresh destination pin, but the same class of gap.

## 2026-09-27 — Surface silent destination/start relocation on shallow water (v698)

`autoRouteProg` already moves a start/end point off charted-too-shallow
water (for the current draft/tide) to the nearest navigable spot before
routing — a real, minimal snap, found live: a user dropped a pin, chose
"AutoRoute from boat position," and the resulting route didn't reach the
pin at all. Root cause: the relocation was real and correct (confirmed via
the console log `[autoRoute] end was charted too shallow — moved 1.70nm to
navigable water`), but was never surfaced anywhere in the UI — only
console.log — and `_clearAutoRoute()` deletes the temporary destination
marker once the route is saved, so there was no visual trace of where the
router actually aimed. The route looked broken; it had actually just
quietly retargeted itself. Fixed two ways: `autoRouteProg` now takes an
optional `onSnap(which, {lat, lon, movedNm})` callback, threaded through
every recursive call (long-range legs, local-escape legs, transit
patches); `_triggerAutoRoute` uses it to (a) speak/show a status message
("Destination was in water too shallow for the current draft — moved
X.XXnm to reach it.") and (b) leave a small amber marker with a tooltip at
the actual routed point, which survives `_clearAutoRoute()` (cleared only
by the next AutoRoute call). Verified live: reproduced the exact snap with
an injected test pin, confirmed both the status message and the marker
appear at the router's real destination.

## 2026-09-27 — Fix: route name could render at 0px width in the Routes panel (v697)

Found and fixed a real bug in the "table format" Routes-panel row layout
that shipped, undocumented, bundled into v694: `.rp-row-name-text` used
`flex: 1`, which implies `flex-basis: 0%`. In a route with a couple of
hazard badges (e.g. "8 hard" + "15 shallow") plus the date and the
On-map/Hidden pill, those fixed-width siblings alone already filled the
~300px panel width, leaving zero *free* space for the name's flex-grow to
claim — so the name rendered at literal 0px, not just a narrow ellipsis,
vanishing from the row entirely. Reproduced live with an injected test
route (8 hard / 15 shallow badges) and confirmed via computed styles
before fixing.

Fix: `.rp-row-name-text` now has a real `min-width` (90px) so it always
keeps a visible share of the row regardless of badge count, and
`.rp-row-name` gained `flex-wrap: wrap` so badges that don't fit on the
first line drop to a second line instead of squeezing the name out.
Common case (no/few badges) is unaffected — still one tidy line.

## 2026-09-26 — Empty-box replay now shows the replayed command (v696)

Follow-up to v695's "play on an empty box reruns the last command": that
rerun was silent — the box stayed empty while the command ran in the
background, with no indication of what had actually happened. Now the
replayed command's text is written into the box (same text the history
pill for it would show) at the moment it runs, so it's visible on screen,
not just audible/in the response area.

## 2026-09-26 — Target button always shown in journey mode; play button reruns last command (v695)

Two small consistency fixes:

- The 🎯 target/bearing button (`#focus-btn`) used to be hidden specifically
  during a Virtual Journey (reasoning at the time: the journey's own
  top-left "Next: bearing, distance" readout already showed the same info,
  so the button felt redundant). Reversed per direct request — journey
  mode, real or virtual, should always have the target button available,
  for consistency between the two. Virtual Journey already forces
  Underway mode on itself, so no VJ-specific CSS rule is needed at all now;
  removing the old hide-rule was the whole fix.
- Hitting the ▶ play button on the text-command bar while the box is empty
  used to be a silent no-op. It now reruns the last command from history
  (the same list the command-history pills are built from) instead of
  doing nothing — a quick "repeat that" without retyping or hunting for
  the pill.

## 2026-09-26 — Virtual Journey shows its waypoints, in a new green (v694)

While a Virtual Journey is running, its route now shows every intermediate
waypoint as a small marker (previously only the two endpoints and any
overnight stops ever got markers, in or out of VJ), and the route line and
those new waypoint markers render in a new color, `#1e8a5c` — distinct from
the app's existing greens (`#4ade80` "on map" pill, `#00cc44` AutoRoute
start marker) so it reads as its own thing rather than a shade of either.
The Virtual Journey banner and its buttons keep their existing gold
(`#f5c842`) — only the map's route line/waypoints change. Reverts to
normal styling and the waypoint markers disappear the moment the journey
stops. Scoped to Virtual Journey only for now, not real Follow-route
recording.

Came out of a broader discussion about the app's mode taxonomy (it
actually has 11 distinct interaction states under the hood — Edit, Sketch,
Draw, Follow-route, Virtual Journey, Route Animation, Follow-GPS Anim, Sim
Track, Focus-place, Underway, bulk-select — not a clean 3, though "Edit /
Journey / just-looking-at-the-chart" remains a reasonable simplified
mental model for a user). No banner-wording or new mode-indicator changes
came out of that discussion — both `#edit-banner` ("Editing...") and
`#vjourney-banner` ("Virtual Journey — ...") already self-identify clearly
today.

## 2026-09-26 — Tutorial link moved to a top-level button (v693)

Per direct follow-up: v692 tucked "Tutorial" inside the Screen menu,
but it belongs alongside Routes/Tracks/Samples as a one-tap top-level
button (`#status-tiles-2`), not buried behind another menu — consistent
with this project's standing preference for surfacing controls
directly rather than nesting them.

## 2026-09-26 — "Tutorial" link from the app back to the sailors demos (v692)

Screen menu (alongside Awake/Clear Screen) gets a "📖 Tutorial" entry —
opens the sailors marketing page's demo section
(`sailors/#demo`) in a new tab, not the app's own window, since this is
a PWA and navigating away in place would abandon whatever's on screen
(a route mid-edit, GPS tracking, Underway mode). Needs real internet;
the app itself is unaffected either way. Mirrors the "🏠 Home" link
added to the sailors page's own nav earlier today, the other direction.

## 2026-09-26 — Underway & Bearing demo: fixed "lives" mispronunciation

Piper read "lives" in "Everything you've saved lives right here" as
the long-i plural noun instead of the short-i verb. Unlike the
AutoRoute clip (built this session as discrete frame+line pieces),
this demo predates the session as a single continuous recording with
no separable script or audio segments — so this was a surgical splice,
not a re-render: synthesized a corrected clip ("livz" spelling forces
the short-i reading), time-matched it to the original segment's exact
duration (atempo, not just trimmed — keeps everything after it in
sync with the unmodified video track) and loudness (measured via
volumedetect, not eyeballed), then spliced it into the extracted audio
track at the real pause boundaries (found via silencedetect, since
there's no way to transcribe/locate speech automatically here) and
re-muxed with the original video, untouched (`-c:v copy`).

## 2026-09-26 — Sailors-page Home button; route-movie map-types blurb speaks once per session (v691)

Two direct requests. (1) The sailors marketing page's sticky top nav
gets a "🏠 Home" link back to the hero/demo section, always reachable
while scrolled anywhere on the page — outline style so it doesn't
visually compete with "Open the app" for attention. Plain
`<a href="#top">`, no JS: an earlier attempt added an explicit
`scrollIntoView` click handler after live testing seemed to show the
native anchor-jump not firing, but that was chasing the wrong cause —
the *identical* symptom (smooth-scroll never completing) showed up on
a bare `scrollIntoView({behavior:'smooth'})` call too, and disappeared
entirely with `behavior:'instant'`. That's smooth-scroll animation
throttling on a hidden/backgrounded automation tab, the same class of
limitation already known here for `flyTo`'s rAF-driven map animation —
not a real bug, and not something the extra JS actually fixed (it used
`behavior:'smooth'` too). Reverted to the plain anchor once the real
cause was found; verified correct with an instant-scroll equivalent
since the animated version can't be confirmed from this environment.
(2) `_playRouteMovie`'s closing "there are a number of other map
types..." narration is identical for every sample route — watching two
or three Watch movies in one sitting repeated it verbatim each time.
Now speaks once per session (an in-memory flag alongside the existing
`_movieRunning` one, not persisted — resets on reload); every play
after the first still shows the reference table for the same 4s, just
without repeating the audio.

## 2026-09-26 — AutoRoute demo: fixed "Vinalhaven" mispronunciation

Piper's grapheme-to-phoneme guess for "Vinalhaven" didn't land right.
Respelled to "Vinyl Haven" (both real dictionary words, so the TTS
frontend handles it correctly) in the one line that says it, re-synced
that beat's held-frame timing to the new (slightly longer) clip
duration, and rebuilt the video. Original Piper voice unchanged — this
was purely a pronunciation fix, not a voice change (a same-session
detour into Coqui XTTS voice cloning, tried for a stronger Downeast
Maine cadence, didn't pan out: XTTS's phoneme decoder pulled pronunciation
back toward its general-American training distribution regardless of
reference-clip accent, and eye-dialect spelling made it worse, not
better, since XTTS's frontend expects real words).

## 2026-09-26 — Route destination "Name" prompt now uses the in-app modal (v690)

`route-dest-name-btn` (the "Name" button on the pending-destination
banner, added in v689) called native `window.prompt()` — the one
remaining call site not yet using `_showTextPrompt`, the in-app modal
that `_promptNextLegAutoRoute` already switched to. Same reasoning
applies here: a native `prompt()` can be silently suppressed by the
browser/webview's dialog-spam protection on a quick repeat trigger
(re-arm via Cancel + Autoroute again), which this button is just as
exposed to. Switched to `_showTextPrompt` for consistency and to close
that gap.

## 2026-09-26 — New sailors-page demo clip: AutoRoute (now tab 2)

Added an "AutoRoute" tab to the sailors landing page's demo picker,
alongside the existing Discover & Route / Underway & Bearing clips —
placed second (bumping Underway & Bearing to third), since it's the
more fundamental workflow. ~72s walkthrough (previous cut was ~42s) of
both ways to start an AutoRoute: double-tapping the boat icon for the
fastest path — tap the map, or tap Name and type a destination (using
the newly-`_showTextPrompt`-based modal above, live-typed on screen) —
then zooming in on the resolved destination marker and panning back out
to show the full plotted route; and searching for a named destination,
zooming in on the result, dragging the dropped pin to fine-tune its
position, tapping it open, and choosing "AutoRoute from boat position"
from its popup. The double-tap beat zooms tight on the boat icon and
flashes the cursor ring twice, visually reading as an actual double-tap
rather than a single static click marker (per direct request after the
first cut). Unlike demo.mp4/demo3.mp4 (continuous screen recordings),
this clip is a slideshow of real screenshots captured live against the
actual running app at each step (not staged/mocked) — except the pin
drag, depicted with a static drag-arrow overlay after live dragging
proved unreliable to capture cleanly in this environment (see session
memory for why) — each beat held for its narration line's duration and
composited via ffmpeg with the same local Piper `en_US-ljspeech-high`
voice used by the other two clips — no
continuous screen-recording pipeline was reconstructed this session.
Doesn't touch `APP_VERSION`/`sw.js` — `/sailors/` is excluded from
service-worker caching, same as the other clips.

## 2026-09-26 — Autoroute destination prompt now mentions typing a name (v689)

The "tap the map for the destination" prompt (spoken + status bar + the
persistent on-screen banner) only ever mentioned tapping the map, even
though a "Name" button right next to it has always let you type a place
or waypoint name instead — easy to miss since nothing called it out. Now
the spoken line, status text, and banner label all mention both options,
and the Name button flashes a few times (finite, not infinite — the
banner can stay up indefinitely) when the banner first appears, to draw
the eye to it.

## 2026-09-26 — Structural fix: default to Rockland, never trust an out-of-coverage real fix (v688)

v687's grace window fixed the real-GPS-vs-spoof race reactively — delay
the announcement long enough for a spoof to override it — but the user
asked for something simpler: this ship covers Penobscot Bay only, so
just default to a known-good position (Rockland Harbor) immediately on
launch, and only ever switch to a real GPS fix once it's confirmed to
actually be inside coverage. A real fix anywhere else is now ignored
entirely, as if it never arrived, rather than becoming the current
position and racing a deliberate override.

Implemented as a new lowest-priority `'default'` GPS source (loses to
literally everything, including a stale `opencpn-ini` config value) plus
an optional `shouldAccept(lat, lon)` predicate on `GPS.startGPS`, checked
only for `'browser'`-sourced fixes (manual/virtual/server sources are
never filtered). `app.js` wires `Query.coverageLevelAt(...) === 'core'`
as that predicate and sets the Rockland default immediately after
`startGPS` is called.

This makes v687's grace window provably dead code — `_updateCoverageStatus`
can now only ever see a `'browser'` fix that's already inside coverage —
so it was removed rather than kept as unreachable defensive code.

Real bug caught live before shipping: `GPS.setDefaultPosition(...)` must
be called *after* `GPS.startGPS(...)`, not before — `startGPS` is what
registers the position callback, so calling the default-position setter
first left the initial placeholder fix silently unrendered (no boat
marker, status stuck on "GPS: waiting").

## 2026-09-25 — The real root cause: a spoof-grace window (v687)

User reported v686 *still* spoke "Limited chart data here" while testing
— the actual cause turned out to be different from both prior attempts.
GPS starts watching for a real position automatically on launch; while
developing/testing away from the boat, that real fix (wherever the
device actually is) can genuinely have no coverage there and — correctly,
for that real location — announces it, moments before a deliberately-set
test position (Location -> Spoof Location, e.g. Penobscot Bay) overrides
it. The warning wasn't wrong, it was just about to be superseded and
never should have been said out loud in the first place.

Fixed by giving a real GPS fix (not a manual/virtual one — those speak
immediately as before) a 4-second grace window before trusting it enough
to announce: if a manual or virtual override arrives in that window, the
real fix's verdict is dropped entirely and never spoken. If nothing
overrides it, the app falls through to its normal (already-fixed in v686)
behavior and tells the truth about the real position. Caught and fixed a
real bug in this fix itself before shipping — an early version could
re-arm the grace window forever if no spoof ever arrived, silently never
announcing anything — via an expanded state-machine simulation covering
that exact case.

## 2026-09-25 — v685's coverage-announcement fix was incomplete (v686)

User reported v685 still spoke the false "Limited chart data" warning
while spoofing a Penobscot position, even though Auto Route worked fine
once the app had settled in. Root cause of the gap: v685 gated its
"is this read trustworthy yet" decision on a fixed ~6-second retry
window (borrowed from an unrelated existing mechanism) — a real cold
load of hazard/navaid/named-place data can take longer than that on a
slower connection, so the fix gave up and spoke the false warning right
before the data actually finished loading, then never re-checked again
(no further position update ever arrived to trigger it).

Replaced the timing guess with the real signal: whether
`Query.hazards`/`namedPlaces`/`navaids` have actually populated yet.
While they haven't, the app just keeps quietly re-checking every 2s —
for as long as it takes — with a generous ~30s backstop in case the
load has genuinely failed for good, after which it falls through to
the original bounded retry-and-announce behavior. Re-verified with an
expanded state-machine simulation: silent through a simulated 20-second
slow load that resolves to full coverage, still eventually speaks up
once for a genuine total failure, and still speaks immediately (no
added delay) for a real mid-voyage coverage loss after a normal start.

## 2026-09-25 — Fix the confusing startup coverage announcement (v685)

User reported hearing "Limited chart data here — Auto Route and Re-route
are unavailable; Sketch still works" on a normal launch while testing a
Penobscot Bay position — it should have "just worked" silently. Root
cause: the app's very first coverage check can run before hazard/navaid/
named-place data has finished loading, reading as degraded even sitting
in the middle of full coverage; that false read got spoken immediately,
then ~2s later a second, equally confusing "Chart data available" message
fired once the data-load race resolved on its own. Fixed by not trusting
a coverage read for *speaking* purposes until it's either unambiguously
'core', already settled once before, or has survived the existing retry
window — the on-screen badge still updates in real time regardless, only
the announcement is held back. A real mid-voyage loss of coverage after
a normal start still speaks up immediately, no added delay — verified via
an isolated state-machine simulation covering both cases plus recovery.

Also trimmed the separate "you're outside coverage" message (heard when
a position resolves nowhere in range at all) to drop its "Casco Bay and
Piscataqua are also covered" line, since this release ships Penobscot Bay
only — kept the part explaining *why* Rockland Harbor / Penobscot Bay is
worth the demo position (History, Geology, Anchorages, and more).

## 2026-09-25 — Paintings table button styling (v684)

The "List" button that opens the All Paintings table now reads "List
Paintings" and matches the same brass tile look (background, border,
text color, hover state) as Routes/Tracks/Samples next to it — it was
missing from the shared button-styling selector, so it had been
rendering in the bare browser default instead of the app's own chrome.

## 2026-09-25 — Paintings table: thumbnails (v683)

Follow-up to v682's "All Paintings" table: the Image column now shows an
actual 72px thumbnail of each bundled reproduction, not just a "View"
text link — still a clickable link straight to the full image in a new
tab, table stays open. Lazy-loaded so opening the table with all 14
entries doesn't fetch every image at once.

## 2026-09-25 — Paintings mode: "All Paintings" table (v682)

Quick, dismissible reference table for Paintings mode — a "📋 List"
button appears next to Routes/Tracks/Samples only while in that mode,
opening a modal table of every entry (title, artist, year) with a
direct link to each one's bundled image. Clicking the dimmed backdrop
outside the table closes it, same convention as every other modal in
the app; clicking a link inside it doesn't (rows stop the click from
bubbling to the backdrop). Framed as a "for now" quick add — a fuller
per-entry-marker experience already exists via the map itself.

## 2026-09-25 — Three more Penobscot Bay paintings (v681)

Iconic Painting mode: added three more Fitz Henry Lane works depicting
Penobscot Bay proper, nearly doubling the count of paintings actually
set on the bay itself (Owl's Head + the original Castine + the two
Camden views → adds two more Castine views plus a Penobscot River-mouth
scene). *Castine Harbor* (1852, Portland Museum of Art) — fishermen
unloading catch on a rocky island with Dice Head Light beyond. *Castine,
Maine* (1856, Museum of Fine Arts Boston, aka "Castine from Fort
George") — a wide hilltop view down over the harbor town. *Lumber
Schooners at Evening on Penobscot Bay* (1863, National Gallery of Art)
— two schooners becalmed at dusk near the mouth of the Penobscot River.
All three verified public domain (CC0/PD-old, confirmed via Wikimedia
Commons license metadata, not just the museum page) with real bundled
images, same policy as every other entry in this mode. Sourced from the
Fitz Henry Lane Online catalogue raisonné; a fourth candidate (Farnsworth
Art Museum's "Owl's Head Light, Rockland") was found and well-documented
but has no legally available image anywhere, so left out under the
mode's image-required rule.

## 2026-09-25 — land.geojson dedup-pipeline fix (script only) + a real snap-point bug (v680)

Follow-up to v678's Perry Creek/Vinalhaven false land-crossing flag (a
`preprocess/extract_land.py` bug: centroid-based dedup let a coarse
whole-island chart outline stand in for a real navigable notch a
harbor-scale chart shows as open water). Rewrote the script's dedup to
clip each chart tier's LNDARE polygons against a union of every finer
tier's own official M_COVR chart-coverage footprint (the same mechanism
real ECDIS software uses to compile overlapping multi-scale charts),
verified correct against the raw NOAA ENC source data directly.

**Not yet shipped as data**: running the fixed script over the full
coast produces genuinely more accurate land geometry (e.g. North Haven's
landmass goes from 83 to 272 vertices — far more real detail, not just a
different simplification), but that extra detail exposed a real gap in
the router's pathfinding around tight, real harbor entrances — 4
previously-solid routes (Fox Islands Thorofare, North Haven→Stonington,
Portsmouth→Bar Harbor, Rockland→Isle au Haut) started failing against it.
That's core A*/visibility-graph work, out of scope for this pass — the
corrected script ships now, documented and tested on its own, but
`www/data/land.geojson` itself stays as-is (original artifact still
present) until the router side gets its own dedicated pass.

**A real bug found and fixed along the way, shipped now regardless**:
`Query.snapToNavigableWater`'s "move a too-shallow/on-land point to the
nearest clear water" search picked the *first* clear point found, with
no check that it was actually reachable from — a point can be real,
charted, obstacle-free water and still sit in a small, mostly-enclosed
pocket that leaves the router with no escape route. Now prefers a
candidate that stays clear a bit further out along the same bearing too,
falling back to the old behavior if nothing better is found. Verified
against the full router/hazard/query test suites — zero regressions.

## 2026-09-24 — Fix the active-region hazard-checker bug itself (v679)

Follow-up to v678 below: that entry found but didn't fix the root cause —
`Query.landBlocks`, `Router.classifyFallbackSeg`, and the route hazard
checker (`_findRouteHazards`/`_checkRouteHazards`, behind the "0 hazards"
popup and the routes panel's hazard badges) all silently check whatever
chart region happens to be active, with no signal when that region
doesn't actually cover the route being checked. Added coverage awareness
using the app's own existing `Query.coverageLevelAt` (already used to
gate the live AutoRoute/Reroute buttons, just never wired into these):
`classifyFallbackSeg` now returns a `coverage` field ('core'/'land'/
'none'), and `_findRouteHazards`'s result carries a `.coverage` summary
across the whole route. When coverage isn't 'core', `_checkRouteHazards`
now says so explicitly — "couldn't check for hazards, no chart data
loaded for this area" — instead of silently reporting all-clear, and
does so regardless of the `silent` flag used for routine auto-checks,
same reasoning as the existing AutoRoute coverage gate: an unverified
route is a safety issue, not a cosmetic one. The routes panel now shows
a "? unverified" badge on any route with no hazard badges whose coverage
wasn't actually 'core', so a clean-looking row can't be mistaken for a
checked one. Verified live against the exact failure this replaces:
before the fix, switching the active region away from a route's real
area made a route with 3 real charted rocks report 0 hazards; after,
it reports coverage 'none' and refuses to claim it's clear. Confirmed
against the existing router/hazard/query test suites (all passing) and
manually reproduced/fixed live in a local build before shipping.

## 2026-09-23 — A real hazard-checker bug, and the rock field it was hiding (v678)

Follow-up to v677 below: user flagged a specific land crossing on that same
route, which led to finding a much bigger problem. The app's land/hazard
checker (`Query.landBlocks`, `classifyFallbackSeg`) checks against whichever
chart region happens to be active in a browser's `localStorage`, not the
region a route actually needs — with the wrong region active (or none
loaded), it silently reports zero crossings and zero hazards regardless of
the real route. This had been quietly producing false "verified safe"
results, including for v677's own SP008 fix below: that fix was never
actually checked against real chart data, and the route it shipped ran
straight through a genuine 19-rock field off Crotch Island — the same
danger originally reported, not actually fixed.

Rebuilt the SP008 approach/departure for real this time: followed the
actual charted/buoyed channel (Field Ledge, Crotch Island, Moose Island
Rock, Peggy's Island Ledge buoys) into a genuinely dense ledge field
beyond it (Merchant Row area), then computed a safe thread through the
raw charted rock positions via a grid/A* search, simplified, and verified
segment-by-segment — both against the app's own checker (with the correct
region now loaded) and independently against the raw NOAA ENC source data
directly. Also found and fixed a second real bug on the same route: a
waypoint in the Burnt Coat Harbor loop sat exactly on Burnt Coat Harbor
Lighthouse's charted rock. A land-crossing sweep also flagged the older
Rockland–Perry Creek leg (reused by 3 other sample routes); that one
turned out to be a chart-data pipeline artifact, not a real hazard —
`extract_land.py`'s dedup let a coarse-scale whole-island outline stand
in for a real navigable notch the actual harbor-scale chart shows clearly
— confirmed via the same raw-chart cross-check and left unchanged.

## 2026-09-23 — Rockland to Hadlock Cove: dangerous reroute fixed (v677)

User reported skull-and-crossbones and yellow-triangle hazard markers, and
red-highlighted segments, on their saved "Rockland to Hadlock Cove (3
overnights)" sample route. Root cause: the user had re-tagged the second
overnight stop themselves (via the app's own Overnight-tag + Reroute
feature) to a new spot near Crotch Island, off Stonington — the resulting
AutoRoute reroute threaded a real path directly through a charted rock
field there (15 hard hazards + 1 obstruction within 100 yds). Not a UI
glitch; a genuinely dangerous route.

Fixed by keeping the user's preferred overnight location (their
self-placed search pin, "SP008") but rebuilding the two connecting legs
around it from scratch and re-verifying live with the app's own hazard
checker: zero hard or soft hazard flags, cleaner than the original
Stonington-harbor routing (which had carried 10 soft/shallow warnings).
Applied to both the user's live saved route and the repo's
`curated_routes.json` sample data, so new installs get the safe version
too.

## 2026-09-23 — Developer docs

Audited developer documentation for staleness: found `CHANGELOG.md`
itself 744 commits/4.5 months stale (see the header note above), and
`RECENT_CHANGES.md` asserting a "current version" 350 versions out of
date. Fixed both, and corrected `www/developers/index.html`'s
descriptions of each (it had been overselling both as more current than
they were). No app version bump — docs only, nothing shipped to users.

**Going forward**: per direct instruction, this file (and any other doc
whose claims a change makes stale — README.md, SPEC.md, the developers
page) gets updated as part of the change itself, not as an occasional
catch-up pass like this one.

## 2026-09-18 to 2026-09-23 (v649–v676)

**Route movies.** Replaced the old interactive "tap through this tour
yourself" onboarding for sample routes with auto-playing, narrated
"▶ Watch" walkthroughs — real map panning/zooming to the destination, a
click into that route's actual History and Geology write-ups (~25-word
summaries of the real content, not a generic mode-announcement), then the
route itself plotted and sailed via the same 10-second boat-preview
animation the app's own Preview/Animate buttons use. Narration is
pre-rendered via Piper (local neural TTS), not live `speechSynthesis` — a
real, confirmed Chrome bug (`cancel()` immediately followed by `speak()`
can silently wedge the speech engine) made live narration unreliable.
Closes with a reference table of all map modes. 6 sample routes now have
a movie, including a new multi-night one (Rockland → Perry Creek →
Stonington → Burnt Coat Harbor → Hadlock Cove, 3 overnights, 4 harbors).

**Iconic Painting map mode.** A new mode showing real, public-domain
historic paintings at the exact spot each one depicts — Fitz Henry Lane,
George Bellows, Rockwell Kent, Thomas Cole. Deliberately
public-domain-only (excludes still-copyrighted work like the Wyeth
family's) so every entry ships a real embedded image, fully offline, no
exceptions.

**Content gaps filled**: Anchorages, History, Geology, and Island Info
modes had real coverage gaps — nothing between Owl's Head and Port
Clyde, and nothing at all yet for Casco Bay (unlocked for real use via
the existing `?dev=1` flag) — filled with real, sourced entries in both
areas.

**A real UI bug fixed**: the zoom slider and pan (d-pad) controls could
render on top of each other — the two were independently-positioned
elements kept apart by a JS function that wasn't wired to every place
they get hidden and re-shown (exiting edit mode, exiting route preview,
toggling Underway off). Restructured so they're flex children of one
wrapper with a real CSS gap — the overlap is now structurally impossible
rather than dependent on the right JS having run recently.

## 2026-09-10 to 2026-09-18 (v587–v649)

**Routing-reliability overhaul.** The router, GPX export, marker icons,
wake lock, hazard clustering, and waypoint storage were split out of the
monolithic `app.js` into their own modules. Added a curated-routes
database and bulk-delete for auto-generated waypoints (with an incident
write-up in `INCIDENTS.md` after a real SP*-prefixed-waypoint delete bug
was found in the wild). Fixed a real gap where the fallback-warning
banner (shown when AutoRoute can't find a safe path) never appeared on
the two *direct* AutoRoute entry points, only the re-route path.

**Multi-region chart storage**: downloaded regions no longer evict each
other from IndexedDB — previously downloading a second region's data
could silently wipe the first.

**Webcams map type**: shipped, then reverted after real-world use — the
link-out-only cams (no embeddable image) "didn't work very well." A
persistent duplicate/ghosted-tile bug in the since-removed Low-Tide
Aerial mode got one serious fix attempt (disabling Leaflet's zoom
animation) that didn't fully resolve it; that mode was later dropped.

## 2026-09-01 to 2026-09-10 (v483–v587)

Island ownership/access became a live link-out lookup (town/parcel
status + a link to Maine's own parcel map) rather than nothing at all.
Fixed a real service-worker gotcha found the hard way: `sw.js`'s *own*
bytes need to change every release (its `@version` comment) or the
worker silently refreezes on whatever it last installed, even when
every other file changed — this had been quietly stopping recent CSS/UI
fixes from ever reaching real devices. Fixed an offline-region-merge bug
where coordinate-only deduplication let named features (harbors,
passages) accumulate up to 17× duplicates across repeated downloads of
the same region. Search fixes: "Hurricane" as a destination query, two
missing charted islands.

## 2026-08-16 to 2026-08-31 (v387–v483)

**The auto-routing rewrite** — the biggest single body of work in this
window: coastal standoff distance, a real head/mouth place-name resolver
("head of Somes Sound," and auto-resolving bare river/creek names to
their mouths), long-range passage
decomposition (depart/transit/arrive) for routes over 20nm, and a
parameterized pipeline for building a brand-new chart region from raw
NOAA/source data end to end — used to build the Casco Bay and Piscataqua
regions. Several real, user-found routing bugs fixed along the way
(wrong search cone on long legs, an unchecked leg-splice that could
still land on a "successful" route crossing land).

Also: hazard-marker clustering into readable blobs in crowded areas
(with two real performance bugs found and fixed — an O(n²) hang and a
DOM-node-count blowup), a fallback-warning accuracy fix, a Clear Screen
button, hover tooltips added to every button in the app, and scrollable
document-marker popups.

## 2026-07-22 to 2026-07-28 (v330–v341)

Optional Google Drive backup for saved Routes/Tracks — the first version
was one-way sync and caused a real data-loss incident within days;
replaced with a proper bidirectional merge (tombstones, conflict copies)
the same week. Directional route/track search ("from X to Y"). Overnight
stops: any route waypoint can be tagged as an overnight stop, with a
day-by-day leg breakdown using actual routed (not straight-line)
distance. Swipe-to-close and drag-to-reposition for floating panels. A
live heading/speed direction-of-travel ray. A round of UI fixes (bigger
focus button, collapsible transcript, max-zoom blank-tile fix). Screen
wake lock toggle. Rearrange mode for dragging UI elements out of the
way. Remembering the last-open route/track across reloads (later
reverted — see v403 in the 2026-08-16 block above, which replaced it
with "never auto-show anything stale on launch" after 15 old test
routes were found cluttering a real screen).

## 2026-05-15

### Chart Data
- Extended chart area from Rockland/Vinalhaven to **Mt. Desert Island / Frenchman Bay** — 16 new ENC cells (rows E–G of ME2 grid); hazards 4,685→8,377, navaids 214→373, named places 534→944
- Added `backfill_light_names.py` preprocessing script to name unnamed NOAA ENC lights from OSM/Overpass and a manual overrides file
- Named lights from OSM: Two Bush Island Light, Deer Island Thorofare Light Station, Matinicus Rock Light Station, Blue Hill Bay Light, Bear Island Light Station, Egg Rock Light Station
- Named Rockland Breakwater Light via manual override (NOAA ENC OBJNAM is blank for this light)
- Restored light characteristic strings (e.g. `Fl(1) W 5s`), height, and range to navaid data — these were dropped when the pipeline was re-run; `extract_navaids` now builds characteristics from S-57 LITCHR/SIGPER/SIGGRP attributes
- Bumped service worker cache to v8 to force fresh navaid data on all clients

### Map Interaction
- Tapping a navaid marker now also prints the spoken text (name, bearing, distance) in the response window
- Tapping a hazard marker in the course map now speaks and prints its label and range/bearing from current position
- Hazard markers in radius queries now appear on the tile map (amber markers), with tap-to-speak
- Marker text window uses numeric/symbol format (`022° M, 0.3 nm`); speech uses words (`bearing zero two two degrees magnetic`)

### Voice Commands
- Added `LIST_OBJECTS` command ("list objects", "what can you find") — enumerates queryable object types without requiring a GPS fix
- Hazards-in-radius and navaids-in-radius queries now speak at most 2 items before "Plus N more"; full list still shown in text window
- Hazards-on-course speech also capped at 2 items before "Plus N more"

---

## 2026-05-13

### Voice Commands
- Added `NAVAIDS_IN_RADIUS` query: "buoys within half mile", "lights within 1 nm", etc.
- Navaid radius map: colored circle markers by chart color (red/green/white/amber), tap marker to hear name, bearing, and distance
- Tapping navaid map marker shortens text window to header only; detail spoken on tap
- Fixed navaid radius parsing: accept `mi` abbreviation and `with` as synonym for `within`
- Fixed `parseRadius`: check fractions before `mi` regex to prevent `1/2` → `2`
- Bumped service worker cache to v7

### App
- Added Piscataqua region (Portsmouth/York area)
- Fixed offline flow and added guided onboarding for first-time users
- Updated docs: Piscataqua region, navaid queries, GPS priority, onboarding flow

---

## 2026-05-12

### Map
- Switched mini-map to ESRI satellite imagery; standalone mode always uses ESRI satellite
- Added "Where Am I" map view showing current position
- Pre-cache satellite tiles during Route download for offline map use
- Fixed map zoom: call `invalidateSize` before `fitBounds`

### Queries & Parsing
- Added restricted areas, overhead cables, and light characteristics to chart data
- Fixed `bearing to west entrance to X` — directional parsing in `bearingToPlace`
- Fixed cascading alias expansion in `normalizePlaceName`
- Fixed oval compass rose icon aspect ratio

### App & PWA
- Added `?demo` mode for screen-recorded demos
- Support ngrok URLs as server mode for PWA install
- Added `apple-touch-icon` and `apple-mobile-web-app-title` for iOS PWA install
- Clarified that hosted PWA is fully offline after initial setup
- Updated docs for ngrok mode, PWA install, and new features

---

## 2026-05-11

### Voice Commands
- Added `HAZARDS_ON_COURSE` query: check a planned route between two named places for hazards
- Added `HAZARDS_ALONG_ROUTE` query: check a named OpenCPN route for hazards
- Added server-side course-hazards endpoint to fix data coverage gaps
- Added "Open in OpenCPN" button for course hazard results
- Handle directional place qualifiers: "west end of X", "eastern entrance to X"
- Added place disambiguation: "Crow Island, Cranberry Isles" resolves to the correct one
- "Where am I" now describes position relative to nearest landmark

### Map
- Added bearing map view: Leaflet map with position, destination, and connecting line
- Show map on phone using OpenStreetMap tiles when no server is available
- Fixed course-map quadrilateral and deduplicated route waypoints
- Fixed "Where am I" falling back to raw coordinates

### Display
- Bearings displayed as numbers (`241° M`) in text, spoken as words ("two four one degrees magnetic")

### App & PWA
- Added standalone hosted app with pre-built regions and GitHub Pages deployment
- Added cruise profiles: Penobscot Bay and Casco Bay
- Added one-tap Route download with gzip compression
- Added `/connect` page with QR code for easy phone setup
- Added first-time welcome message with getting-started instructions
- Added server-side place lookup to fix ambiguous names (e.g. Southwest Harbor)
- Prefer town/harbour labels when multiple features share a name
- Fixed manifest `start_url` for PWA install from both localhost and GitHub Pages
- Reload data from IndexedDB after route download so queries work immediately
- Fixed "View on map" links across platforms

---

## 2026-05-10

### Initial release
- AudioChart nautical navigation PWA: voice queries for hazards, bearings, navaids, and position
- Offline-first architecture using IndexedDB for chart data storage
- Offline prep: download chart data for a radius; additive multi-area coverage
- Manual test position input (coordinates or place name)
- Remove Web Speech API mic button; use native keyboard voice input
- Fix fuzzy place name matching (substring containment length ratio)
- Silence noisy server retry messages
