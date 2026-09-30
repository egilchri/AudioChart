# Changelog

## 2026-09-30 — AutoRoute setup no longer freezes the tab in hazard-dense water (v758)

"It won't let me do an autoroute to either marker in the snapshot" —
real production report, SP002/TS014 near Carvers Harbor/Vinalhaven.
Live investigation found AutoRoute WAS eventually succeeding (correct
fallback-warning UI appeared), but only after 45s+ with the entire tab
frozen unresponsive — 2.5x past the intended 18s deadline.

Root cause: `autoRouteProg`'s setup phase (building the visibility-
graph nodes from every land/hazard ring in the bbox) ran as one
unbroken synchronous block, checked against the deadline only ONCE,
after all of it had already finished — never yielding to the browser
in between. A hazard-dense bbox like this one (600-1700 hazards, per
earlier fallback-warning-accuracy work) can spend many real seconds in
that block alone. Added a throttled yield+deadline-recheck (every 25
rings, same pattern the main A* loop already uses) to both of setup's
unbounded ring loops, so the tab stays responsive during setup and an
overrun is caught mid-way instead of only after the fact.

This also answers a related question: can the same route succeed on a
laptop but fail on a tablet? Yes, and this bug made it worse — the
deadline is already wall-clock (`Date.now()`), not iteration-count, so
the CAP itself doesn't change with device speed, but slower hardware
does the same setup work more slowly in real time, so it could burn
through most or all of the budget just building the graph, before
search even starts. The unyielded block meant that overrun went
undetected until setup was already fully done; now it's caught early,
so a genuinely-too-slow device gets the existing honest straight-line
fallback + warning instead of a long freeze. Users on consistently
slower hardware can still raise the "Route planning time limit"
setting (`DEFAULT_DEADLINE_MS`'s existing escape hatch) if they want
more time before that fallback kicks in.

Verified: `node --check`, full local suite incl.
test_channel_routing.js (all 14 cases still pass, no new timing
regressions — the two pre-existing "slow" warnings are unrelated
known-marginal cases).

## 2026-09-30 — Thicker inbound arrows; "Type a command" narrowed too (v757)

**Thicker arrows**: "try making the blue inbound arrows twice as
thick." `font-weight` was already at its CSS maximum (900), so added
`-webkit-text-stroke` to genuinely add line weight beyond what a bold
font-weight alone can give a text glyph. Live-verified: visibly bolder.

**Command bar narrowing, part 2**: v756 only narrowed the "Command
reference" picker; the "Type a command…" input (`#text-input`) still
stretched full-width via `flex:1`, which wasn't what "make command
reference and type a command shrunken windows much narrower" asked
for. Gave it the same treatment — fixed width sized to its placeholder,
`align-self: flex-start` to escape the parent's flex-column stretch.
Verified live: both rows are now narrow, with the send button sitting
right next to the input instead of stretched to the far right.

## 2026-09-30 — Tap-tooltips, Node Ops trimmed, command-picker overlap fixed (v756)

Three direct requests in one pass:

**Tap-tooltips for the edit-mode toolbar.** "We need tooltips for all
the buttons in the snapshot" — the #edit-banner buttons (Show hazards/
Show info/Copy waypoints/Mail waypoints/Revert/Delete route/OK/Cancel)
already had real `title` text, but native browser tooltips only ever
appear on mouse HOVER, which doesn't exist on the user's own device (a
Galaxy tablet). Added a small reusable `_addTapTooltip` helper: shows
the button's title text in a floating bubble on `touchstart`, purely
additive (never intercepts the real click), auto-hides after ~1.8s.

**Trimmed the Node Ops panel.** Removed "Fix selected nodes,"
"Reroute," and "Simulate" per direct request. Removed the buttons and
their direct click listeners; left the small amount of now-dead
supporting state (`_fixNodesMode` and its resets) in place rather than
chase a full removal, since `_reRouteSegments`/`_enterSimTrackMode`
themselves are still real, live functions used elsewhere (the
overnight-leg auto-route flow, and the Tracks panel's own Simulate
button) — only these 3 specific entry points went away.

**Fixed the version badge overlapping the command reference picker.**
The Command reference `<select>` was full-width (matching the text
input below it), and narrowing it alone wasn't enough — measured live,
both it and `#map-version-label` start at the exact same bottom-left
corner with overlapping Y ranges, two independently-positioned
elements that happened to collide. Sized the picker to its own
placeholder text and gave it a left offset clearing the badge's real
~48px width. Verified live: zero overlap.

## 2026-09-30 — Fixed white-background Waypoints/Test Sets buttons (v755)

Direct follow-up: the two new top-row buttons from v754 rendered with
the browser's bare default white button style instead of matching
Routes/Tracks/Samples. Real cause: the dark brass-pill styling is a
shared rule scoped to a fixed list of button IDs, and the two new IDs
were never added to it. Added `#waypoints-panel-btn`/`#testsets-panel-btn`
to that shared rule (base style, hover, active-press, and the toggled
`.active` state), matching the other buttons exactly. Live-verified.

## 2026-09-30 — Waypoints and Test Sets promoted to top-row buttons (v754)

Direct request: "I want them to become buttons that are always
visible, in the rows of buttons at the top of the screen." Waypoints
and Test Sets were nested submenus inside the right-click/long-press
map context menu ("Waypoints ›", "Test Sets ›"). Both are now
standalone panels (`#waypoints-panel`, `#testsets-panel`) opened by
always-visible buttons next to Routes/Tracks/Samples, using the same
open/close/drag/swipe pattern as every other top-row panel.

"Set waypoint here" stays in the context menu as its own flat button —
it acts on the specific right-clicked point, which only exists in that
flow, unlike the rest of the old submenu (Show/Hide/Export/Delete
SP*/Save as Test Set), which moved to the new Waypoints panel. The
existing per-waypoint and per-Test-Set expandable rows (Delete, Set
position here, Show/Hide on map, Try all routes) are unchanged — their
click handlers were already bound directly to the moved elements, not
dependent on being inside the context menu, so no interaction logic
needed rewriting. Found and fixed one real bug during verification: the
map's right-click handler still force-hid these elements with an
inline style on every right-click, which would have out-ranked the new
panel's CSS and left both panels looking empty whenever opened after
any right-click.

## 2026-09-30 — Inbound/outbound direction, and the arrows, work bay-wide now (v753)

Direct follow-up: "every buoy seems to know what's inbound and
outbound, I would like to know too" and "I want this to be working all
over the entire map." Real cause, found by directly inspecting
Eggemoggin Reach's own data: NOAA often names each buoy for the specific
hazard it marks ("Pumpkin Island Ledge Buoy 27," "Thrumcap Ledge Buoy
28") rather than a shared channel name — but the real chart NUMBERS
still run as one continuous, alternating red/green sequence for the
whole passage (verified: Eggemoggin Reach runs 1→33 straight through,
mixing many different hazard names). Both `_chainAscendingBearing`
(feeds the popup's Navigation Rule text) and `_findInboundChainPairs`
(the on-map arrows) only matched buoys sharing an EXACT name prefix, so
they were blind to this real pattern.

Both now fall back to (or, for the arrows, are fully replaced by) the
same unified check: nearest OTHER lateral mark within 1.0nm whose
number is within 2 of this one's. Verified bay-wide before shipping:
of 402 real lateral marks, 295 have a nearest-neighbor number
difference of 2 or less (a real sequence signal), while 41 with a
bigger jump are genuinely unrelated nearby marks — correctly excluded
by the same threshold. On-map arrow coverage rose from 69 pairs across
31 named channels to 204 pairs covering 307 of 402 real lateral marks
(76%, up from a much narrower slice). Live-verified: Eggemoggin Reach,
previously nearly arrow-free, now shows arrows spread across its length
(12 in one representative view, up from 0-2).

## 2026-09-30 — Popup states the real inbound/outbound direction in words (v752)

Direct goal statement: "for each buoy that refers to inbound and
outbound, I know what direction they are referring to." Re-reading
`_lateralMarkGuidanceHtml`'s own output found the real gap: once a real
bearing was known, the code REPLACED the word "Inbound"/"Outbound"
entirely with just a small rotated arrow glyph — no text anywhere
saying which way it pointed, or even which line was inbound vs.
outbound. Fixed: both the word and the arrow now show together, plus
the real compass direction in plain text via `Query.compassDir` (the
same primitive already used for Location & Context/Charted Hazard) —
e.g. "Outbound (heading east): Leave to PORT." When no chain neighbor
exists (`_chainAscendingBearing` returns null), stays honest that
direction isn't available rather than guessing one. Live-verified on
Fox Island Thorofare Buoy 14, matching the real, independently-verified
convention from earlier this session (ascending numbers run west).

Also answered two direct follow-ups about the v751 "Inbound" arrows'
coverage ("I only see arrows in Fox Island Thorofare... how about
Eggemoggin Reach?") by checking live on production at several other
real locations — confirmed working correctly bay-wide (Rockland Harbor
Bypass Channel, Casco Passage, and 2 real pairs in the broader
Eggemoggin Reach area: The Triangles Buoy 23/25 and Buck's Harbor East
Channel Buoy 1/2) — the arrows only render at zoom ≥13, so a zoomed-out
view of the whole bay legitimately shows none.

## 2026-09-30 — Geometrically accurate "Inbound" arrows return (v751)

Direct follow-up to an analytical question: "how many labels would we
need to label all of Penobscot Bay with Inbound direction indicators?"
Computed 38 if one straight arrow covers each whole named channel, but
flagged that's inaccurate for a curving channel (verified earlier this
session that Fox Island Thorofare's real consecutive bearings shift
109°→257°→204°→235° along its length). Direct request: "let's go with
the geometrically accurate version instead" — confirmed this means
reintroducing on-map arrows (removed in v745) alongside, not instead
of, the tap-popup info card.

New design, genuinely different from the earlier v738-744 arrows: one
arrow per CONSECUTIVE same-chain buoy pair (e.g. Buoy 12→14), each
pointing that specific segment's own real bearing, rather than one
per buoy pointing at its nearest neighbor of any chain (the old,
removed design). Reuses `_chainAscendingBearing`'s own chain-grouping
and BOYLAT/BCNLAT filter, and the same 1.0nm real-spacing cap verified
against actual chart data in the earlier arrow work. Verified bay-wide
before building: 69 real consecutive pairs across 31 real named
channels (not ~400 for an all-buoys version). Same plain-glyph,
no-background visual language as the earlier v740 arrows and the same
zoom≥13 gate (real gate-tight pairs are only 40-170m apart — a few
screen pixels at low zoom). Live-verified: arrows correctly track the
real channel curve at Fox Island Thorofare, zoom-gate works, and all
existing popup content (hazard/location/status/nav-rule rows, Copy
location) still renders correctly alongside the arrows.

## 2026-09-29 — Fixed: navaids not actually showing by default (v750)

Direct report: "I had asked you to show navaids by default. That's not
working yet." v748 fixed pan/zoom triggering a redraw, but that only
helps once you MOVE the map — the real root cause was upstream: none of
the app's actual `Query.loadData()` completion points (the real
standalone-boot path, the first real GPS fix, both manual and
auto region-switch, and the region-download flow) ever called
`_refreshNavaidOverlay()` once chart data actually finished loading.
On a fresh load the map can already be sitting still with nothing else
pending to trigger a redraw, so navaids never appeared until a manual
pan/zoom or the Refresh button. Added the call at all five real
completion points (`_refreshNavaidOverlay()` itself already no-ops
safely if the map isn't up yet). Verified live: cleared all storage,
loaded fresh, touched nothing — navaids now render immediately once
data loads, no interaction required.

## 2026-09-29 — "Copy location" button on navaid popups (v749)

Direct request: a "Copy location" button on the navaid popup, alongside
the existing "Copy name." Copies decimal-degree coordinates
(`lat.toFixed(6), lon.toFixed(6)`) — the most portable format for
pasting into another maps app, a chartplotter's waypoint entry, or a
text message, distinct from the DM format (`formatPositionDisplay`)
already used elsewhere for on-screen reading. Same interaction pattern
as "Copy name" (click → "✓ Copied" flash → reverts after 1.2s). Live-
verified: click handler fires and updates the button label correctly.

## 2026-09-29 — Navaids now refresh automatically on pan/zoom (v748)

Direct report: "I find I have to bring up the panel, and hit Refresh,
to see the Navaids." Confirmed a real gap: `_refreshNavaidOverlay` was
only ever called on initial map load, an explicit Refresh tap, a
region switch, or toggling the Depths checkbox — never on plain
panning or zooming, unlike Soundings and several other viewport-scoped
overlays in this file which already bind to `moveend`/`zoomend`.
Panning to a new area showed nothing until manually hitting Refresh.
Added the same `_map.on('zoomend moveend', _refreshNavaidOverlay)`
binding soundings already had. Verified live: navaids now populate
automatically after both a plain pan and a zoom change, with no manual
Refresh needed.

## 2026-09-29 — Split Soundings out as its own toggle, off by default (v747)

Direct request: "make those little depth circles a different parameter,
that I can set. Have them be off, by default. Have all navaids be on,
by default, and make them a settable parameter." Two changes to the
Objects filter panel:

1. **Soundings** (the small per-point depth circles, `_refreshSoundingsLayer`)
   had no toggle of their own — they were tied to the same "Depths"
   checkbox as the mudflat overlay. Split into a new "Soundings"
   checkbox, off by default (dense sounding fields cluttered the chart
   when not specifically wanted). Depths keeps controlling mudflats;
   both still trigger a fresh tide-height fetch on enable, since both
   render tide-adjusted values.
2. **Buoys/Lights/Beacons** were 3 separate checkboxes, each already on
   by default — confirmed with the user this should become one combined
   "Navaids" checkbox ("make them a settable parameter," singular),
   still on by default.

## 2026-09-29 — Navaid popups: what each buoy is FOR (v746)

Direct follow-up to v745: "I still feel like I'm missing something,
what these buoys are FOR. Have we exhausted all information about
them?" Researched directly (real data, not assumption): `hazards.geojson`
(11,938 real charted features, already loaded) was never cross-referenced
against navaids at all — the single biggest real gap. Added two new
popup rows:

**Charted Hazard** — nearest real POINT hazard (underwater rock,
obstruction, wreck, submarine cable — deliberately excluding DEPARE
shallow-area polygons, matching `_refreshNavaidOverlay`'s own existing
convention, since `query.js`'s `nearestHazard` doesn't filter to Point
geometries and would break on them) within 0.5nm, verified against real
bay-wide distances (buoys typically sit 0.02–0.35nm from what they
mark). States type + charted depth, and the real name on the rare
(19 of 11,938 bay-wide) named hit — e.g. "Egg Rock Daybeacon 8A" now
correctly shows "Marks Egg Rock (underwater rock), less than a quarter
mile southwest." 403 of 504 real navaids (80%) get a match; the row is
omitted entirely, never forced, for the rest.

**Status** — extracted two more real, previously-unused S-57 attributes
(`STATUS`, `PERSTA`/`PEREND`) into the pipeline, decoded against the
real local GDAL S-57 attribute catalog rather than assumed from memory.
STATUS is populated on 78% of real navaid features bay-wide — far
denser than INFORM's 15% — but stays silent for the overwhelming
"permanent" default (531 of 749); surfaces only genuinely different
facts like "private" or "periodically/intermittent," plus a real
seasonal in-place date range when PERSTA/PEREND are set (e.g. "Union
River Channel Buoy 2: In place May 1 – Nov 1"). 49 navaids get a
notable status line, 26 get real seasonal dates.

Live-verified in-browser against three real cases: Fox Island Thorofare
Buoy 14 (unnamed nearby obstruction), Egg Rock Daybeacon 8A (named
hazard + official remark together), and Union River Channel Buoy 2
(seasonal + private). Caught and fixed a real display bug during that
verification: STATUS labels can themselves contain a literal "/" (e.g.
"periodically/intermittent" is ONE code's label, not two statuses) —
the original render logic mis-split it into "Periodically,
Intermittent"; fixed to treat the whole string as one phrase.

## 2026-09-29 — Navaid popups: full info card, on-map arrows removed (v745)

Direct request: "not working. Try a new approach. Forget the arrows.
Don't show them on the screen... when I click on it I want to see the
full information about how to pass it, and other incidental advice,"
with a reference mockup (Location & Context / Navigation Rule rows).
Removed the entire on-map channel-arrow feature (v738-744: icon
functions, CSS, the per-buoy/BOYSAW render blocks) and replaced it with
a richer tap popup.

**Caught and corrected a real error before shipping it**: the
reference mockup stated "leave to starboard when transiting eastward"
for Fox Island Thorofare Buoy 14. Checked the real numbered-buoy chain
directly (buoy 2 at the east end, buoy 27 at the west end — numbers
increase heading WEST) and cross-checked against an independent web
source describing the same channel's real buoyage convention — both
confirmed the opposite of the mockup: numbers ascend, and "red right
returning" applies, heading WEST, not east. Built the feature on the
verified direction, not the mockup's specific wording.

**"Are we sure we're getting the richest source of data?"** — checked.
Downloaded all 34 real NOAA ENC chart cells covering Penobscot Bay and
extracted S-57's own INFORM attribute — real official USCG/NOAA remarks
("East of shoal," "On spindle," "Seasonal aid: replaced by can when
endangered by ice") previously discarded by the extraction pipeline.
Populated on 83 of 504 real navaid features (~16%) in this region; added
as a new `inform` field (preprocess/s57_to_geojson.py), re-merged into
both navaid.geojson files, fingerprints regenerated. Cross-checked
against the official USCG Light List (Volume I, downloaded and text-
extracted) for the same buoys — confirmed identical remark text (e.g.
"East of shoal" on Fox Island Thorofare Buoy 10 in both sources) —
S-57 INFORM already carries the same core USCG data, so nothing richer
was being missed for ordinary buoys; the Light List's only notably
deeper content is fog-signal/sector detail on major lighted aids, out
of scope for this pass.

**New popup layout** (`_refreshNavaidOverlay` in app.js): Official
Chart Remark (verbatim INFORM text, visually marked as the one line NOT
computed by this app) → Location & Context (nearest 2 real named
places, each a real distance+compass-direction via the same primitives
already used by "Where am I") → Navigation Rule (existing port/
starboard box, now labeled and kept — still states both directions with
live-heading highlighting, never a single guessed side). Verified live
against the real local build for both an official-remark buoy (Fox
Island Thorofare Buoy 10) and a no-remark buoy (Buoy 14, matching the
mockup's own example — confirmed its real INFORM is genuinely empty in
both NOAA sources, not a pipeline gap).

## 2026-09-29 — Channel arrows: systematic coverage audit + colour fallback (v744)

Direct request, after v743 shipped: "did you systematically check every
buoy has 1 arrow, or 2 if you can pass on either side?" Answer at the
time was no — only spot-checked a couple of screenshots. Ran a real
audit against the full Penobscot Bay dataset (504 navaid features),
classifying every one into its expected arrow count and checking the
actual code's behavior against it:
- 417 catlam port/starboard/preferred-channel marks + 19 BOYSAW (436
  total) should each get exactly 1 or 2 arrows.
- 65 LIGHTS should get 0 (a light has no "side" — correct, unchanged).

Found one real gap: 3 of 420 real BOYLAT/BCNLAT features ("Turtle
Island Ledge Gong Buoy 2," two others) have real colour data (red or
green) but are missing `catlam` in the chart extraction, so they fell
through to 0 arrows despite genuinely being lateral marks. Fixed by
falling back to colour (red/green) when catlam is absent — the arrow
only needs "is this a lateral mark," not which specific side, so colour
alone is sufficient. Re-ran the audit against the fixed code: all 504
real features now land in their correct group with zero failures —
420 lateral marks each get exactly 1 real (non-null) neighbor bearing,
19 BOYSAW each get exactly 2, 65 LIGHTS get 0, summing exactly to 504.

## 2026-09-29 — Channel arrows: one per buoy, not per pair (v743)

Direct request: "start over with the arrows. No blue background. Just a
single blue arrow on the side of the buoy that is safe to pass on. For
every single buoy on Penobscot Bay." Dropped the whole pair/midpoint
design from v739-v742 (gate vs. sequential classification, mutual-
nearest-neighbor matching, two arrows drawn at a shared midpoint) in
favor of one plain arrow per BUOY, anchored at that buoy's own position,
offset a small fixed screen-pixel distance (not a shared point between
two buoys — avoids ever landing on a real marker regardless of how
close two marks are).

Direction: each lateral mark's arrow points toward its own nearest
OTHER lateral mark, searched across the full bay-wide dataset (not just
the current viewport) so even a buoy near the edge of view gets a real
answer — the real, physical side where the marked channel continues,
independent of which way the boat is heading (sidesteps the inbound/
outbound ambiguity the popup's own text already has to hedge on).
Extended eligibility to preferred-channel-port/starboard marks too (a
real, separate catlam value for channel-split junctions), not just
plain port/starboard-hand — checked bay-wide, 18 of 507 real marks are
this type. Verified live against the real local build (Chrome extension
reconnected this session): confirmed on-map arrows now spread broadly
across the whole visible bay, not one dense cluster, each landing
directly beside its own buoy rather than orphaned at a distant midpoint.
Still zoom-gated at 13+ (unchanged from v741 — real close-pair spacing
is 40-170m, a few screen pixels at low zoom).

## 2026-09-29 — Channel arrows: drop strict mutual-neighbor requirement (v742)

Direct follow-up, with a real screenshot: "Long Pond Shoal Buoy 8" near
Mount Desert Island had no arrow nearby despite a real neighbor
("Bowden Ledge Buoy 6") only 0.5nm away, well inside range. Root cause,
confirmed against real data: v741's pairing required MUTUAL nearest
neighbor (A's nearest is B, AND B's nearest is A) specifically to stop
one mark claiming multiple links. That's too strict outside a dense
two-buoy gate — Bowden Ledge Buoy 6's own nearest neighbor was a THIRD,
different buoy, so the real link to Long Pond Shoal Buoy 8 was rejected
even though it's a genuine nearby pair. Checked bay-wide: 110 of 417
lateral buoys (26%) were being dropped for exactly this reason — a real
neighbor existed in range, it just wasn't reciprocal.

Fix: each mark still links to only its own single nearest neighbor
(distance-classified into gate/sequential exactly as before), but pairs
no longer need to be symmetric, and duplicate unordered pairs are
deduped. Verified directly against `navaid.geojson`: bay-wide coverage
rose from 59% to 84% (349 of 417 buoys), Fox Island Thorofare's real
pairs went from 6 to 14 (correctly folding in nearby daybeacons marking
the same channel), and Rockland Harbor Bypass Channel's tight real gate
pairs stayed correctly classified as gates.

## 2026-09-29 — Channel arrows: real coverage fix + zoom gate (v741)

Direct follow-up, with a real bay-wide screenshot: "why aren't there
arrows all over Penobscot Bay?" then, pushing further, "yeah, but how
about coverage?" Two separate real problems, both confirmed against
actual chart data rather than assumed:

**Coverage gap.** v739's pairing only searched for the NEAREST OPPOSITE
COLOR buoy within gate range. That misses a second real pattern,
confirmed via Fox Island Thorofare's actual buoy list: long runs of the
SAME color in a row (10, 12, 14, 16, 18, 20, 24 — all starboard-hand),
spaced 0.2–0.5nm apart, tracing the channel's own curving centerline.
An opposite-color-only search finds nothing there even though the
channel is densely marked. Rewrote `_findChannelBuoyPairs` to pair every
lateral mark with its own nearest OTHER lateral mark of any color
(mutual nearest-neighbor, so no mark claims two links), classified by
distance alone into two arrow treatments: a close "gate" pair (≤0.15nm,
verified against Rockland Harbor Bypass Channel's real 9&10/7&8/3&2
spacing of 0.02–0.09nm) gets a perpendicular arrow — the boat passes
BETWEEN the two marks; a farther "sequential" link (up to 1.0nm, Fox
Island Thorofare's real spacing) gets an arrow ALONG the connecting
line — the line itself IS the channel's path there. Verified directly
against `navaid.geojson` with standalone scripts (browser extension was
disconnected this session): Fox Island Thorofare coverage went from
effectively 0% to 67% (12 of 18 real buoys), while Rockland's real gate
pairs still classify correctly as gates. Bay-wide: 246 of 417 lateral
buoys now paired (59%), 34 gate pairs and 89 sequential pairs.

**Low-zoom clutter.** A separate screenshot at zoom 10 showed a chaotic
arrow "starburst." Not a placement bug: real gate-pair spacing (40–170m)
compresses to a handful of screen pixels at that zoom, so dozens of
independently-correct arrows from a tight, curving channel read as
noise. Channel arrows now only render at zoom ≥13, where real pairs have
enough on-screen room to read individually; the per-arrow offset from
the pair's midpoint was also reduced (22px → 10px) to keep both arrows
visually close to their true pair at the zoom levels they do render at.

## 2026-09-29 — Simpler channel arrows, moved clear of buoy markers (v740)

Direct follow-up, with a real screenshot: v739's double-headed midpoint
arrow, sitting in a filled colored box exactly at a red/green pair's
midpoint, could land almost directly on top of one of the source buoys
when they were closely spaced — confirmed in the screenshot, the arrow
was visibly covering a green marker.

Two changes: (1) simplified to a single-headed arrow with no background
box — a plain glyph with a white outline for contrast, "less intrusive"
per direct request, replacing the filled square. (2) Now drawn as TWO
of these plain arrows per pair instead of one, offset ~22px from the
midpoint ALONG the channel axis (the one direction neither source buoy
sits on, regardless of how close together they are) rather than sitting
exactly between them — "a little ahead and behind," pointing away from
each other, still reading as "the channel runs both ways" without a
double-headed glyph. Verified with exact on-screen pixel distances (not
eyeballing): the old design put arrows at 0px from their source buoy;
the new one clears to 6–24px in the large majority of real cases.

## 2026-09-29 — Channel arrows: position-based pairing, not name-chains (v739)

Direct follow-up, with a real screenshot showing arrows dense around Fox
Islands Thorofare but essentially absent everywhere else in Penobscot
Bay: "why is this implemented for one small region?" Root cause,
confirmed by testing v738's `_chainAscendingBearing` live against real
buoys: it only finds a bearing when two buoys share a literal NAME
prefix (e.g. "Fox Islands Thorofare Buoy 1"/"...Buoy 3"). Checked real
buoys near Deer Island Thorofare/Merchant Row directly — each is named
for its OWN charted hazard ("West Mark Island Ledge Buoy 2", "Brown Cow
Ledge Whistle Buoy 2BC", "North Bay Ledge Buoy 2"...), never sharing a
channel-name prefix with its neighbors despite marking the same real
channel. Name-chain matching was structurally blind to most of the bay,
not a rendering bug.

Also a direct design request: "a blue double-sided arrow in between red
and green buoys would produce less clutter" than one arrow per buoy.

Replaced the per-buoy lateral arrow entirely with `_findChannelBuoyPairs`:
position-based, no name matching at all — for every red (starboard-hand)
and green (port-hand) mark that are each other's mutual nearest
opposite-color neighbor within real channel-width distance (0.5nm), draw
ONE shared blue arrow at their midpoint, oriented along the channel
(perpendicular to the line connecting them). Works identically whether
NOAA named the buoys with a shared channel prefix or not. BOYSAW
safe-water marks keep their existing two-arrow-per-mark treatment
(unrelated — no red/green pairing applies to them).

Live-verified: the previously-empty Deer Isle/Stonington/Merchant Row
area now shows 20 real channel arrows (zero before), and total coverage
across a wide Penobscot Bay view broadened substantially versus the
old name-chain approach.

## 2026-09-29 — On-map double-arrows show which side to pass a buoy (v738)

Direct follow-up: "when the buoys are displayed, put a double ended
arrow next to it" — instead of only telling the side in the popup
(v731-733), show it at a glance right on the chart, no tap needed.

A small green/red rounded square with a white "↕" glyph now renders next
to every lateral buoy/beacon with a computable chain bearing, offset to
the actual channel/pass-through side (not the buoy's own side — worked
through concretely with a real "red right returning" example before
writing the code: for a green/port-hand mark, the channel is on the
mark's own STARBOARD side relative to the inbound heading, i.e.
`ascendingBrg + 90°`; for red/starboard-hand, `ascendingBrg - 90°`),
rotated to point along the real channel axis (double-headed since that
axis serves both inbound and outbound travel). A BOYSAW safe-water mark
gets two arrows, one flanking each side, in blue — a real, different
fact ("pass on either side"), not a placeholder for missing data.

Silent (draws nothing) for any mark with no computable chain bearing —
same "no confident answer, no guess" rule as the rest of this feature.
Live-verified with exact pixel-position math (not just eyeballing a
screenshot, which was initially misleading) against two real marks:
Wheeler Bay Buoy 1 (port-hand) and Marshall Point Lighted Buoy MP
(BOYSAW) — both rendered at the precisely correct offset and rotation.

## 2026-09-29 — CI fix: guard a latent `navigator` reference (v737)

v736 shipped with CI red — missed before pushing. The new self-heal
migration's write-back caused `loadData()`'s IndexedDB cache to become
genuinely populated partway through `test_channel_routing.js`'s Node
test run (which reuses process state across many test cases), which
newly exercised an existing, previously-dormant branch —
`else if (idbH && !navigator.onLine)` — that references the browser-only
global `navigator`, undefined in Node: `ReferenceError: navigator is not
defined`. A real latent bug in already-shipped code, just never
triggered from a clean IDB before. Guarded with a `typeof navigator !==
'undefined'` check; no behavior change in any real browser, where
`navigator` always exists. Verified locally against the exact CI
commands (`test_channel_routing.js`, `test_route_hazard_clearance.js`,
`test_parser.js`, `test_query.js`, full syntax-check loop) before
shipping this time.

## 2026-09-29 — Defeat CDN-level staleness + self-heal already-stuck devices (v736)

v735 fixed the service worker's own cache race, but `curl -I` against the
real live production URL turned up one more layer: GitHub Pages' own CDN
(Fastly) serves `data-version.json` (and every other static file) with
`Cache-Control: max-age=600` — a 10-minute edge cache that sits in FRONT
of the origin, which no repo-level config can change on GitHub Pages.
`cache: 'no-store'` on a fetch only ever controlled the browser's own
behavior; it can't reach a CDN edge node at all.

Fixed properly this time: every `data-version.json` fetch now appends a
`?v=<timestamp>` cache-busting query string, making each request a URL
the CDN has never cached — sidesteps the 10-minute TTL entirely,
regardless of its value, with no GitHub Pages configuration needed.

Also added a one-time self-heal (same pattern as the existing v636
hazards-dedup migration) for a device that's ALREADY stuck: if a stored
version hash was ever recorded while the freshness check itself was
being served stale (either bug above), that device has no way to notice
on its own — matching wrongly is exactly this failure's symptom, not an
error. Two independent migration flags (one for hazards/places/navaids,
one for land/channel-graph/soundings/curated-routes — genuinely separate
IndexedDB cache families) each force exactly one real re-fetch per
region per browser, then never run again. This is the actual fix for
the specific device that kept reporting empty buoy popups even after
v734/v735 shipped real, verified-correct fixes.

## 2026-09-29 — Fix a real stale-freshness-check race in the service worker (v735)

v734 fixed the actual missing data, but a real user's device still showed
the old, empty buoy popup afterward — even after a confirmed hard
reload, on a *different* buoy this time, whose data was independently
confirmed correct in both shipped files. That ruled out both "missing
data" and "ordinary browser cache" as the cause, pointing at the one
remaining layer: the service worker's own Cache Storage.

Root cause, found by reading `sw.js`: `data-version.json` — the
fingerprint `query.js` compares against its own IndexedDB copy to decide
whether to trust it or re-fetch real chart data — was being served
through the generic `networkFirst()` strategy, which races a real
network fetch against a 2.5s timeout and returns the OLD cached response
if the network is merely *slow* (not failed). On a real boat's weak
signal — exactly the condition that race exists to tolerate — this can
lose the race and silently return a stale hash that still matches the
also-stale IndexedDB copy, permanently hiding a real data update. An
earlier fix (`cache: 'no-store'` on the fetch inside `_fetchRegionGeometry`/
`loadData()`) only addressed the browser's own HTTP disk cache
underneath that call — it couldn't reach the service worker's separate
Cache Storage layer sitting in front of it.

Fixed by routing any `data-version.json` request straight to the network
— no Cache Storage read or write for this one file at all. A failure
there was already handled safely by the caller (falls through to not
trusting IndexedDB, or to the explicit offline fallback) — it just needs
to be a real failure, never a wrong-but-successful stale answer.

## 2026-09-29 — Buoy pass-side data now on bundled-default too (v734)

Real bug report with a screenshot: a buoy popup showed only its colour
("Red"), no shape, no pass-side box or arrows at all — v731/v732/v733's
work never reached it. Root cause, confirmed by inspecting both files
directly: the reported buoy loads from `www/data/navaid.geojson` (the
bundled-default dataset, used whenever the "penobscot-bay" *named*
region isn't the active one) — only the named region's own
`www/data/regions/penobscot-bay/navaid.geojson` was reprocessed in
v731/v732. Not a caching bug — a hard reload correctly could not have
fixed it, since the bundled data genuinely never had the fields.

Applied the identical, already-proven recipe (re-download the same 32
real NOAA chart cells, re-extract via `extract_navaids()`, merge
`catlam`+`shape` in by `(chart, name)`, regenerate the fingerprint) to
`www/data/navaid.geojson`. 483/497 features matched, 415 got `catlam`,
434 got `shape`; the specific reported buoy ("Fox Island Thorofare Buoy
2A") verified directly: `catlam: starboard-hand, shape: nun`. No code
changes — `_lateralMarkGuidanceHtml`/`_navaidIdentityHtml` already read
whichever dataset is active, so once the data carries the fields the
existing v731–v733 UI just works, same as it already does for the named
penobscot-bay region.

## 2026-09-29 — Replace "Inbound/Outbound" text with directional arrows (v733)

Direct follow-up: the words "Inbound"/"Outbound" in v731/v732's pass-side
box read as confusing on their own. Replaced with a small arrow rotated
to the real compass bearing each line's rule applies to — the popup now
reads "↖ Leave to PORT" / "↘ Leave to STARBOARD" (arrows rotated to
actual heading, not generic glyphs), so which way is which is answered
by a picture, not a word.

The real bearing comes from the same chain-neighbor mechanism v732's
live-heading guess already used (`_chainAscendingBearing`, now factored
out on its own) — finds another real charted buoy in the same numbered
chain nearby and takes the bearing toward the higher number. Falls back
to the original "Inbound:"/"Outbound:" wording only when no chain
neighbor is found (no real bearing to point an arrow at). The live-
heading best-guess highlighting from v732 is unchanged, just now
attached to arrow-based lines instead of word-based ones.

Live-verified against the real Wheeler Bay Buoy 1/3 pair: correct
arrow directions with no GPS heading set, and correct highlighting
retained once a heading was set.

## 2026-09-29 — Richer navaid popup + live heading-based side guess (v732)

Two direct follow-ups to v731, both Penobscot Bay only:

**Complete navaid identity card.** The buoy/beacon popup previously
showed only the name and the v731 pass-side box; shape, colour, and
light characteristic were only ever visible in the marker's separate
hover tooltip. Added `shape` extraction (BOYSHP/BCNSHP — a real S-57
attribute, same family as CATLAM, verified against a live NOAA chart
cell before use: `nun`/`can`/`spherical`/`pillar`/`spar`/`barrel`/
`super-buoy`/`ice buoy` for buoys, `stake-pole`/`withy`/`tower`/`lattice
beacon`/`pile beacon`/`cairn`/`buoyant beacon` for beacons) and merged
it into penobscot-bay's `navaid.geojson` (436/487 matched features now
carry it). The popup now shows a plain "Green can" / "Red/white pillar,
Fl(1) R 4s" identity line. BOYSAW (safe-water/mid-channel marks) get
their own honest note — "Safe water — pass on either side" — instead of
silently having no side guidance at all.

**Live heading-based best guess.** Direct follow-up: "the system could
compute what side of a marker I should leave it." Implemented
conservatively — a WRONG confident answer here is dangerous, not just
unhelpful, so this only ever ADDS emphasis on top of the existing
both-directions text, never replaces or hides either side. Real buoy
numbers ascend inbound by chart convention; find another real charted
buoy in the same numbered chain nearby (e.g. "Wheeler Bay Buoy 1" /
"...Buoy 3"), which gives the local ascending/inbound bearing at that
exact spot, then compare the boat's live GPS heading against it. Stays
silent (shows nothing extra) whenever there's no heading, no chain
neighbor within 3nm, or the heading is within ~20° of perpendicular to
the chain — never forces a guess. Live-verified with a virtual GPS
heading against a real buoy pair (Wheeler Bay Buoy 1/3): correct
"Inbound" and "Outbound" highlighting in both directions, and correctly
silent when heading was set perpendicular to the chain.

## 2026-09-29 — Buoy pass-side guidance ("leave to port/starboard") (v731)

Direct request: tapping a buoy should tell you something meaningful for
underway use, not just its name. Added which side of a channel each
lateral buoy/beacon denotes, right in its popup.

Verified the source data first rather than assuming: downloaded a real
NOAA ENC chart cell (US4ME20M) and inspected it directly with `ogrinfo`
— confirmed CATLAM (category of lateral mark) is a real, fully-populated
S-57 attribute on every BOYLAT/BCNLAT feature (port-hand, starboard-hand,
preferred-channel-to-port/-starboard), cross-checked against real buoy
names/numbers (odd = port-hand/green, even = starboard-hand/red).

- `preprocess/s57_to_geojson.py`'s `extract_navaids()` now extracts CATLAM
  (BOYLAT/BCNLAT only) via a new `CATLAM_LABEL` map in `s57_codes.py`.
- Penobscot Bay's `navaid.geojson` re-processed from freshly downloaded
  chart cells and merged in (name+chart matching, not coordinates — a few
  charts had been reissued with slightly corrected buoy positions since
  the region was first built); 417 of 420 real lateral marks now carry
  `catlam` (the remaining 3 are marks since replaced/renumbered in the
  current chart edition — correctly left unset, not guessed). Casco
  Bay/Piscataqua/bundled-default are a separate follow-up.
- New popup line, deliberately the most visually prominent element in the
  popup (colored: green for port-hand, red for starboard-hand, amber for
  a preferred-channel junction mark): e.g. "Inbound: leave to PORT ·
  Outbound: leave to STARBOARD." States both directions explicitly rather
  than a single "leave to port," since CATLAM alone doesn't say which way
  you're heading — only the US "red right returning" convention
  (buoy numbers ascend inbound) resolves that.
- Live-verified against two real charted buoys (Ensign Island Lighted
  Bell Buoy 1 = port-hand, Ensign Island Buoy 14 = starboard-hand):
  correct color and wording in both cases.

## 2026-09-28 — Depth soundings show at any zoom (v730)

Direct report: the Depths overlay's numeric sounding dots (colored by
comfort margin, depth on tap) had a hard `zoom < 14` cutoff that hid every
one of them below that level — with the checkbox itself always on, this
made the feature look broken ("I don't see them") for anyone not zoomed
in tight. Removed the cutoff entirely, per direct follow-up ("turning
them all on, at will"): real soundings in view now always render,
regardless of zoom.

To avoid reintroducing a real, previously-hit class of bug in this app
(a dense, unthinned marker set hanging the browser — see the hazard-
clustering O(n²)/DOM-count fixes), a `MAX_SOUNDING_MARKERS` = 5000
density cap (even stride-sampling) still applies, but only as a
worst-case safety net — real per-region sounding counts (already
pre-thinned to ≤30m spacing at build time) stay well under it even
across a whole bay at low zoom. Live-verified: ~1000s of real charted
soundings render smoothly at zoom 10 across all of Penobscot Bay.

## 2026-09-28 — Drop the nearby-hazard-proximity speech (v729)

Direct request: "Stop saying 'Warning route ... has ... hazards nearby'.
I don't want to hear it" — continuing the same v727/v728 narrowing.
`_checkRouteHazards`'s "Warning: X has N hazards nearby, including..."
TTS + status line fired for a charted hazard merely near the route (a
proximity warning), not one the route actually crosses. Per the same
"only tell me when I go right over a rock or over land" rule stated for
v728, this now stays fully silent too — the red segment highlight and
skull/triangle map markers remain as the persistent visual signal, fixed
via Node Ops' "Fix selected nodes" as before.

## 2026-09-28 — Drop the tight-clearance popup+speech (v728)

Direct report, with a screenshot from repeated AutoRoute testing: the
"N leg(s) pass tighter than our normal comfort margin..." popup (plus its
TTS) fired for every tight-but-successfully-routed leg — no different in
weight from the genuinely unresolved land/hazard-crossing warning, even
though a real route WAS found in this case, just closer to shore than the
normal comfort standoff. During batch/repeated testing this meant a modal
popup on nearly every leg — "too much" per direct report.

`_showRouteFallbackWarning` now stays fully silent (no popup, no
setStatus, no TTS) for the tight-clearance-only case — the ⚠ marker (with
its hover tooltip) still appears on the map at the exact spot, same as
before, just passively rather than interrupting. The popup+speech is now
reserved for the one case that still needs action: an actual unresolved
land or charted-hazard crossing.

## 2026-09-28 — Minimal AutoRoute narration (v727)

Direct request: AutoRoute plotting/completion was "too talkative." Removed
all TTS speech and status-bar text for routine outcomes — successful plan
completion ("X planned — N nm") and the shallow-water marker-relocation
note ("Destination was in water too shallow... moved X nm") — from
`_onDrawConfirm`, `_triggerAutoRoute`, and `_promptNextLegAutoRoute`
("Next leg routed"). The marker-relocation info stays available passively
(the existing orange snap marker + its hover tooltip on the map), just
never proactively announced.

The one thing still spoken/shown is `_showRouteFallbackWarning` — a
genuine danger (couldn't avoid land/hazard, or a too-tight passage) —
left untouched, per the same request ("only in the most dangerous
extreme circumstances").

## 2026-09-28 — "Try all routes" for Test Sets (v726)

Added a "Try all routes" action to each Test Set's context-menu actions
row (alongside Show/Hide and Delete). For a Test Set with N markers, it
runs N independent AutoRoute calls — boat's current GPS position to each
marker in turn, not chained marker-to-marker — drawing each leg's path
on the map as it completes (green = real route found, red = router
fell back to a straight line) and finishing with a status-bar summary
of how many legs failed. Silent — no TTS narration, just the visual
banner/status text, since this is a rapid-fire batch test the user is
already watching on screen. Cancellable mid-run via a banner button; a
leg already computing when Cancel is clicked still finishes, gets drawn,
and is counted in the summary — only the *next* leg is skipped. A
1-marker Test Set is a valid target (there's no chaining requirement).

Design went through several corrections from the initial draft: chained
routing between consecutive markers was replaced with boat-to-each-marker
independently; TTS narration was removed entirely; and a self-found bug
during verification — cancelling while a leg was in-flight discarded
that leg's already-completed result instead of recording it — was fixed
by removing a redundant post-await cancellation check (only the
loop-top check, which gates starting a *new* leg, enforces Cancel now).

## 2026-09-28 — Self-heal stale pre-v719 Test Set waypoint names (v725)

Real user report, diagnosed from a screenshot: markers labeled "SP003",
"SP005", "SP007" were showing on the map with the exact same purple
Test Set marker icon as a correctly-named "TS007" — and "Save SP*
waypoints as Test Set" reported "No SP* waypoints to save," even though
SP-labeled markers were clearly visible.

Root cause: v719 added TS00N renaming for waypoints saved into a NEW
Test Set, but never migrated waypoints already sitting inside Test Sets
saved before that fix shipped — v718's original save logic copied the
source waypoint's name as-is, with no renaming at all. Those older Test
Set entries kept their original "SP00N" names forever, rendered with
the Test Set marker icon (matching the screenshot exactly) but never
picked up by "Save SP* waypoints as Test Set" — that command only ever
looks at the *separate*, regular waypoint list, and these names were
already living inside a Test Set, just under a stale name.

Fixed with a one-time, idempotent self-heal in
`test_sets_storage.js`: on load, scans every stored Test Set for any
waypoint name that doesn't match `TS\d+`, renames it to the next
available sequential TS00N label (continuing the existing global
counter, so it can't collide with an already-correct TS00N elsewhere),
and preserves the original name as `origName` if not already set. Runs
automatically, no user action needed — matches this project's existing
"self-heal on load" pattern (e.g. the hazards-cache dedup migration).

Verified live in a browser: seeded a legacy-shaped Test Set (SP003/
SP005/SP007, no renaming, matching the reported screenshot) alongside
an already-correctly-named TS007 in a different set — after reload,
the stale entries became TS008/TS009/TS010 (continuing past the
existing TS007, no collision), `origName` preserved, and the
already-correct TS007 left untouched. Confirmed idempotent: a second
reload made no further changes. No console errors.

## 2026-09-28 — Test Set marker delete option; saving now converts SP* waypoints instead of duplicating them (v724)

Two direct follow-ups to the Test Sets feature (v718-v719).

**1. Delete option on individual TS markers.** Each marker's popup
("Set position here" / "AutoRoute from boat position") had no way to
remove just that one point — only the whole Test Set, from the Test
Sets submenu. Added a "Delete" button (confirms first); deleting the
last waypoint in a set removes the now-empty set entirely, matching the
same cleanup the "Delete Test Set" action already does. Also fixed a
real styling gap while in this popup: the existing buttons
(`ts-popup-pos`/`ts-popup-autoroute`) were never actually added to the
app's shared popup-button CSS rule back in v718, so they rendered as
plain unstyled `<button>` elements — folded them (and the new delete
button, with the same red-danger treatment as every other delete
button in the app) into that shared rule.

**2. "Save as Test Set" now converts, not duplicates.** Direct request,
after "not all SP markers are renamed as TS right now" turned out to
mean the source SP* waypoints were expected to disappear from the
regular waypoint list once saved into a set, not sit around unchanged
as a leftover duplicate alongside the new TS-named copy. The save
handler now removes the source SP* waypoints (from both localStorage
and the live `Query` waypoint index) immediately after building the
Test Set, mirroring the existing "Delete all SP* waypoints" bulk-delete
logic. Status message updated to say "Converted," not "Saved," to
match. `TestSetsStorage`'s own internal snapshot/copy design (v718) is
unchanged — this only changes what app.js's save handler does with the
source waypoints afterward.

Verified live in a browser: saving converts SP001/SP002 into
TS001/TS002 and removes them from the regular waypoint list (a
non-SP-prefixed waypoint in the same list correctly survives
untouched); the new popup buttons render properly styled; deleting one
marker from a two-marker set leaves the other intact; deleting the
last marker in a set removes the set entirely, including from the
visible-sets tracking. No console errors. `test_query.js` (25/25)
passes — no query.js/router.js changes this release.

## 2026-09-28 — Settable comfort margin, and live hazard re-checking while underway (v723)

Two direct follow-up requests from v722's clearance-margin fix.

**1. Settable clearance margin.** The "comfortable clearance" margin
(v722: draft + 3ft) is now a real setting — "Comfortable clearance
margin" in the Objects panel, next to Boat draft — instead of a fixed
value baked into the code. Wired through all three places it's used
(the shallow-area warning triangle, the depth-heat overlay, and the
nudge-offshore feature's target depth), defaulting to 3ft for anyone
who hasn't touched it. `Query.findComfortableNudgePoint` now takes the
margin as an optional parameter instead of always reaching for its own
internal constant.

**2. Live hazard re-checking while following a route, plus a real bug
this surfaced.** Direct question: "while underway, it should pop up
warning triangles ad hoc if the tides dictate. Or are you already using
mean low water as the baseline?" Confirmed MLLW is already the datum
everywhere (soundings, the live NOAA tide fetch, the depth-heat
overlay). But investigating the "ad hoc" half surfaced a real, separate
bug: `_effectiveTideHeight()` was a one-time snapshot fetched at load
time or whenever the Depths checkbox got toggled — frozen from then on,
not actually live, even though the app already fetches and caches a
full tide-extremes curve every 60 seconds for the tide-preview slider.
Every hazard check silently used a tide reading that could be hours
stale by the time a boat following a route actually reached a spot.

Fixed `_effectiveTideHeight()` to interpolate live from that
already-cached curve for the real current time (same math the
tide-offset slider already used, just pointed at "now" instead of a
simulated offset) instead of the frozen snapshot. Added a genuinely new
feature on top: while a route is being followed (real GPS or a Virtual
Journey rehearsal), a periodic check (chained onto the same 60s
interval) re-examines just the REMAINING portion of the route ahead of
the boat's current position against the now-live tide, and announces +
marks on the map any hazard that's newly crossed the comfort threshold
since the last check — not the whole route (which would keep
re-flagging water already safely behind the boat), and not hazards
already known about (a state-diffed set, so nothing re-announces every
60 seconds just because it's still there).

Verified live in a browser: the settable margin persists and updates
suppression behavior correctly; `_effectiveTideHeight()` now visibly
changes value between two calls seconds apart (previously would have
returned bit-for-bit the same frozen number); the live re-check
correctly stays silent on a repeat call with nothing new, and correctly
announces + draws a marker for a genuinely new hazard on the first
real check. No console errors. Full `test_channel_routing.js` and
`test_query.js` (25/25) pass — this release touches only warning
display and a new opt-in-by-following periodic check, not AutoRoute's
own routing/avoidance logic.

## 2026-09-28 — Lower the "comfortable clearance" margin from draft+6ft to draft+3ft (v722)

Real user report: at their actual 3.5ft draft, AutoRoute flagged two
shallow-area warning triangles where the real charted soundings showed
8.2ft and 8.9ft of water — genuinely charted depths, correctly read,
but not what the user considered worth a caution given their draft.
Investigated the exact suppression math live: the shared "comfortable"
margin (`COMFORTABLE_CLEARANCE_M`, draft + 6ft) required 9.5ft of real
depth to suppress a warning at a 3.5ft draft; both real soundings fell
just short of it.

Changed the shared constant from 6ft to 3ft, applied consistently
everywhere it's used (per direct confirmation — "I agree it should be
everywhere," matching the constant's own existing design intent:
"comfortable means the same thing everywhere in this app"): the
shallow-area warning triangle's suppression threshold, the "nudge
offshore" feature's target depth, and the depth-heat overlay's
yellow/red shading. Also confirmed the app already uses MLLW (Mean
Lower Low Water) consistently as the depth datum throughout — real
soundings, the depth-heat overlay, and the live NOAA tide fetch all
reference it explicitly.

Known, accepted side effect: 3ft is now numerically equal to the
existing hard `KEEL_CLEARANCE_MARGIN_M` floor, so the depth-heat
overlay's yellow "caution" band has collapsed to zero width (only
red/no-color show) until this margin becomes user-configurable (raised
as a follow-up idea, not yet built). Kept `COMFORTABLE_CLEARANCE_M` as
its own named constant rather than merging it into
`KEEL_CLEARANCE_MARGIN_M`, specifically so a future settable-in-the-UI
value only has one place to change.

Verified live against the exact reported case: both previously-flagged
spots (8.2ft, 8.9ft) now correctly suppress at a 3.5ft draft. This is a
warning-display change only — router.js's actual hazard-avoidance
logic (`segBlocked`/`_soundingsClearCrossing`) already used the hard
3ft `KEEL_CLEARANCE_MARGIN_M` floor and is unaffected. Full
`test_channel_routing.js` and `test_query.js` (25/25) pass with no
routing changes, as expected for a display-only fix.

## 2026-09-28 — Fix a real gap letting a route pass within 1.5m of a charted rock (v721)

Real user report, with a saved route: "This was not a wise course. I
think you should have gone further offshore." Investigated with real
chart data, not assumed: the route's worst clearance from a charted
underwater rock was **0.0008nm — about 1.5 meters** — confirmed against
the actual hazard data, not just visually.

Root cause, confirmed live: `router.js`'s `segBlocked` builds a small
no-go circle (`HAZARD_SAFETY_NM = 0.05nm`) around each charted point
hazard (underwater rock/obstruction/wreck) and checks candidate route
edges against it — but only for hazards inside *that query's own*
padded bounding box (`start`/`end` ± `PAD_NM = 2.0nm`). That's fine for
steering candidate *node generation* away from a hazard, but a genuine
blind spot for *edge checking*: this route's real, necessary detour
around Fox Islands Thorofare/Perry Creek bulges further than `PAD_NM`
past the direct start-end line, so a real charted rock sitting ~0.6nm
past the query bbox's own edge never got a no-go circle built for it at
all — `segBlocked` had literally never heard of it. The route "succeeded"
with no warning, which is worse than failing loudly: exactly the
"never silently unsafe" bar this project holds AutoRoute to.

This is the same class of gap `Query.landBlocks` doesn't have — land
crossing is checked via a global, bbox-independent spatial index, always
correct regardless of which query built it. Point hazards had no
equivalent. Fixed by adding `Query.hazardPointBlocks` — a new, always-on,
grid-indexed (not a per-query bbox scan) check covering every charted
point hazard in the loaded region, wired into `segBlocked` right
alongside the existing `Query.landBlocks` call. The existing per-query
hazard-circle mechanism is untouched (still used for node generation);
this adds the same always-correct guarantee to edge checking that land
already had.

Verified live: the fixed route's worst standoff from the same charted
rock improved from ~1.5m to ~51m — the router now finds a real
alternative that goes further offshore, exactly as reported. Full
`test_channel_routing.js` and `test_query.js` (25/25) pass, including a
new permanent regression case `[21]` for this exact route. No
meaningful performance change (the new check is grid-indexed, same cost
class as the existing `landBlocks` call it sits beside).

## 2026-09-28 — TTS: spell out "nautical miles" instead of "nm" in spoken distances (v720)

Real user report: the app's spoken (TTS) announcements read a distance
like "0.30nm" as "0.30 nanometers" — a bare "nm" is ambiguous to a
browser's speech synthesis engine, which defaults to the SI unit
(nanometers) rather than nautical miles.

Found and fixed the specific reported case (the "moved X nm to reach
it" announcement spoken after AutoRoute snaps a too-shallow start/end
point to navigable water — both call sites, `_onDrawConfirm` and
`_triggerAutoRoute`), then audited every other `TTS.sayImmediate`/
`TTS.say` call site in `app.js` for the same abbreviated-"nm"-in-spoken-
text pattern and found three more real instances: the route-
saved/updated confirmation (two call sites) and the named-destination
water-snap announcement. All four now follow the pattern already
correctly used elsewhere in the file (e.g. the AutoRoute planned-route
summary): the visual status-bar text keeps the "nm" abbreviation, the
TTS-spoken text spells out "nautical miles" in full.

No other call sites matched the pattern — remaining "nm"-containing
strings in `app.js` are all visual-only (map tooltips, popup HTML,
`.textContent` readouts), never passed to TTS.

## 2026-09-28 — Test Set markers get their own TS001-style labels (v719)

Follow-up to v718, per direct request: "the test set markers need to be
labelled like TS001, etc." v718 kept each marker's original SP*/wp* name
(e.g. "SP001") when snapshotted into a Test Set — confusing once several
sets are saved, since a marker's on-screen label had nothing to do with
which Test Set it belonged to.

Every waypoint saved into a Test Set now gets its own sequential
`TS00N` label instead, numbered GLOBALLY across every Test Set ever
saved (not restarting per set) — so two different sets shown on the map
at the same time can never collide on the same label. The original
SP*/wp* name is kept as `origName` and shown in the marker's popup
("Test Set: Archipelago test points (from SP001)") so the point it came
from is still traceable. The Test Set's own free-text NAME (e.g.
"Archipelago test points") is a separate concept from these per-marker
labels — its own default-name suggestion changed from "TS001" (which
collided with the new marker-numbering scheme) to "Test Set N".

Verified in a real browser: saved a Test Set, confirmed its markers now
tooltip as "TS001"/"TS002" and their popup correctly cites the original
SP001/SP002 they came from. No console errors. `test_query.js` (25/25)
unaffected (no query.js/router.js changes this release).

## 2026-09-28 — Test Sets: save SP* waypoints as a permanent, named snapshot for repeatable testing (v718)

Per direct request, after this session's repeated reliance on saved SP*
(search-dropped pin) waypoints for testing routing fixes: "save them all
as TS markers and have a way of bringing them to the screen for
testing."

Adds a Test Set — a permanent, named SNAPSHOT of the current SP*
waypoints (coordinates and names copied by value, not a live reference)
that survives even after those SP* waypoints are later renamed, moved,
or bulk-deleted via the existing "Delete all SP* waypoints" action. New
`www/js/test_sets_storage.js` (pure localStorage read/write helpers,
same split as the existing `waypoints_storage.js`) plus a new "🧪 Test
Sets ›" entry in the map's right-click context menu, alongside the
existing "Waypoints ›" menu (which gained a new "Save SP* waypoints as
Test Set" action, prompting for a name).

A visible Test Set renders its own small, distinct, non-draggable marker
per waypoint (own icon, own map layer, independent of the regular
draggable waypoint layer — a Test Set is a frozen reference point, not a
live editable waypoint). Its popup keeps just the two actions this
session's own testing actually used repeatedly: "Set position here"
(jump the boat's test GPS position straight to it) and "AutoRoute from
boat position" — both mirroring existing, already-tested code paths
exactly. The Test Sets submenu lists every saved set with a live marker
count and an eye-icon visibility indicator; each set expands to
Show/Hide-on-map and Delete actions, the same expand/collapse pattern
the Waypoints submenu already uses for individual waypoints.

Verified end-to-end in a real browser (not just unit-level): saved a
real two-point Test Set, confirmed its markers render with the correct
name/coordinates/Test-Set-name in their popup, confirmed "Set position
here" actually moves the boat's test GPS position and reloads chart
data for that spot, confirmed Hide/Show correctly toggles marker
visibility and persists across a reload, and confirmed Delete removes
the set from storage and its markers from the map. No console errors
throughout. `test_query.js` (25/25) unaffected (no query.js/router.js
changes this release).

## 2026-09-28 — Fix a fragile long-range transit bracket that failed 0.11nm from a passing route (v717)

Real user report: AutoRoute from Rockland to the WoodenBoat School
Moorings vicinity in Brooklin failed completely (full A* graph
exhaustion, not a timeout) — reachable with "no path found — returning
straight line," a straight line across real charted land. Striking
detail: this destination is just 0.11nm from case 17's own destination
(WoodenBoat School/Center Harbor), which has passed in the regression
suite since the same-day archipelago work earlier today. Confirmed live
on BOTH bundled-default and the penobscot-bay region — not a region-
data gap, and not something the precomputed water mesh from earlier
today's work could fix (confirmed by direct connectivity checks against
the mesh; also confirmed the failure reproduces identically with no
water mesh loaded at all on bundled-default).

Root cause, isolated by capturing the router's own internal bracket
boundaries for both destinations side by side: `_transitLeg` (router.js)
coarse-marches the direct line from departure to arrival to find where
a blockage starts and ends, then brackets the WHOLE detected span in
one local search. For the passing destination, that march happened to
detect a shorter blocked stretch, splitting the passage naturally into
two easy local searches. For the failing destination — same real water,
same real islands, a destination shifted by about a boat's length —
the march detected one long continuous ~19nm blocked stretch instead,
handed as a single much harder bracket to the local search, which
genuinely exhausted its candidate graph trying to solve it in one shot.

Fixed by retrying a failed full-span bracket with a much smaller one —
just past where the blockage starts, not its whole detected span —
before giving up on the whole transit leg. If the smaller bracket
succeeds, `_transitLeg`'s own hop loop naturally continues on to bracket
and solve the remaining stretch as a further hop, the same way the
already-passing destination did on its own. This directly targets the
sensitivity itself (any bracket that's too hard to solve in one shot can
now split into an easier first bite) rather than one specific spot,
so it should hold for the next similarly fragile case, not just this one.

Verified: the fix alone (no water-mesh or region-data changes) resolves
the route on both bundled-default and penobscot-bay. Full
`test_channel_routing.js` and `test_query.js` (25/25) pass; case 19
(today's earlier archipelago fix) is unaffected (~15-16s, unchanged).
Added permanent regression case `[20]`, run against bundled-default
specifically to prove this is a router-logic fix, not another mesh-
coverage gap.

## 2026-09-28 — Give the long-range transit leg its real time budget, not a flat per-call cap (v716)

Follow-up to v715, found by CI rather than a user report this time. An
earlier same-day attempt to extend the water mesh to a second dataset
(shipped as v716, then reverted — see git history) got caught by CI
failing on the exact route v715 fixed: case `[19]`, Rockland → SP009 in
Eggemoggin Reach. Reverting restored the byte-identical v715 code and
data, but a direct re-run of that exact unchanged commit's CI job
**still failed once**, then passed cleanly on a second re-run with no
changes at all — proving this was never a functional regression, but a
timing one: v715's own original passing CI run had already used 17,084
of its 18,000ms per-leg budget (916ms to spare) to find this route.
Case 19 has always had close to zero margin on CI's shared runners, not
just under the specific change that got reverted.

The real fix: `_transitLeg`'s per-obstacle bracket search (`router.js`)
was capped at the flat per-call `deadlineMs` (18s), even though the
long-range decomposition it's part of already budgets 3x that
(`longRangeDeadlineMs`, 54s) for the whole passage — and a fast depart
leg typically leaves nearly all of that unused. The bracket search now
gets whatever's actually left of the full passage budget instead of a
flat 18s slice, so a genuinely hard, island-dense bracket (like Deer
Isle/Eggemoggin Reach) gets real headroom instead of being cut off at
an arbitrary fraction of a budget that was never actually exhausted.
The existing per-hop `longRangeDeadlineMs` guard is unchanged, so this
can't run the whole passage past its documented 3x envelope.

Verified locally: case 19's search still converges the same way it
always did (1475 expansions, ~16.3s, unchanged from before) — this
change is pure headroom, invisible when a search is already fast enough,
and only matters when it isn't. Full `test_channel_routing.js` and
`test_query.js` (25/25) pass.

## 2026-09-28 — Precomputed navigable-water mesh fixes a real "no path found" archipelago gap (v715)

Real user report: AutoRoute from a Penobscot Bay position to SP009 (inside
Eggemoggin Reach, near Deer Isle) failed completely — not a timeout, a
genuine "no path found" after A* exhausted its entire candidate graph
(1,311 expansions, all 1,462 nodes, ~8s). Root cause, confirmed live, not
assumed: the router's per-query candidate-node generation
(`router.js`'s `_addRingNodes`/`_pickExtremeVerts`, built fresh from land-
ring vertices near the direct start-end line on every search) places
plenty of points on each side of a genuinely complex multi-island passage
(Deer Isle's coastline, Merchant Row, the reach itself), but has no
guarantee any combination of them chains all the way through. Ruled out
directly: not a search budget problem (3x-ing the node/ring caps changed
nothing), not sparse candidates (hundreds already existed on both sides),
not a missing-buoy-data problem (the real charted buoy chains on each
side are genuinely ~3.35nm apart with no markers between them in the
actual charts — correct behavior, not a bug in how buoy chains are
built). This is the "island-dense archipelago" limitation already
flagged in this project's own notes.

Fixed with a new precomputed navigable-water mesh
(`preprocess/build_water_mesh.py` → `water_mesh_deer_isle.geojson`,
Penobscot Bay region only for now — a deliberately scoped pilot), reusing
the same boundary-point-Voronoi medial-axis technique
`build_channel_graph.py` already uses for real charted channels, applied
to a computed "open water" polygon instead. Consumed at runtime as
**ordinary candidate nodes** (`Query.waterMeshPath` precomputes the
mesh's own shortest path once per query; `router.js` seeds just that
path into its existing node array) — deliberately **not** given
`channel_graph.geojson`'s trusted/unchecked treatment, since that data
is independently surveyed and this mesh is geometrically derived from
the same land/depth data the runtime already checks. Every mesh-derived
edge still goes through the router's real, live `segBlocked` check on
every query, same as any other candidate node.

Getting the underlying water polygon right took several real, live-
verified iterations, each one a genuine bug caught before shipping:
- Found and fixed a bug in the *shared* `medial_axis_edges` (used by the
  real channel pipeline too): it only densified a polygon's outer
  boundary, never interior rings — a no-op for a real channel polygon
  (none have holes) but fatal for an open-water polygon full of islands,
  fragmenting the mesh into dozens of disconnected pieces.
- Land-only water polygon: the resulting mesh disagreed with the
  router's own real depth check on 29% of its edges.
- Blindly subtracting every charted shallow-area polygon: fragmented the
  water polygon into thousands of disconnected slivers (a DEPARE
  polygon's `valsou` is a single worst-case value for its whole extent —
  the same coarse-vs-real theme this project keeps running into).
- Subtracting only large/significant hazards, eroded by a fixed margin:
  much better, but still left a real 28-consecutive-edge stretch running
  straight through Tinker Ledges unrescued, and separately risked
  cutting a destination off from the mesh entirely when it sits close to
  a hazard's own charted boundary.
- What actually works: before subtracting a significant hazard, carve
  back out of it the union of small circles around every real nearby
  sounding confirming genuine depth — mirroring `router.js`'s own
  `_soundingsClearCrossing` rescue logic directly instead of
  approximating it with a blind buffer.

Verified end-to-end against the real reported route (Rockland → SP009,
exact coordinate from the user's own saved waypoint): now finds a real,
9-point, zero-land-crossing route. Verified the fix doesn't regress
anything else: full `test_channel_routing.js` suite passes, including
the two cases most likely to be affected by any change in this same
geography (case 16, Vinalhaven tidal flats; case 17, WoodenBoat
School/Center Harbor, previously fragile earlier this session) — case
17's timing, which briefly regressed 3x during an earlier iteration of
this fix, is back to its normal ~7s baseline in the shipped version.
Added permanent regression case `[19]` for this exact route.
`test/test_query.js` (25/25) also passes.

This was a deliberately narrow pilot (Penobscot Bay region only, one
hard passage) rather than a whole-region sweep — a full-region version
of the same diff found 2,456 differing polygons, mostly the bundled
dataset having far more inland/river detail this region's data
deliberately omits as irrelevant to a boat, not real navigable-water
gaps. The technique (and every dead end that didn't work) is documented
in `build_water_mesh.py`'s own module and function docstrings, ready to
reuse for the next hard passage or region without re-deriving any of
this.

## 2026-09-27 — Fix real charted-land gaps in the Penobscot Bay region's own map data (v714)

Real user report: AutoRoute from a Penobscot Bay position to a Vinalhaven-
vicinity destination (Heron Neck Ledge/Folly Ledge/Potato Island — core
bay, confirmed against named_places.geojson) produced a route that
straight-lined across real charted land between two of its own waypoints.
Root cause: the "penobscot-bay" named region's own `land.geojson` is
missing real land in a couple of spots that the app's generic bundled
dataset correctly has — this project's chart data is a genuine patchwork,
not one dataset uniformly better than another (confirmed directly: a
long-standing route through the Deer Isle/Stonington area depends on
detail the region's own data has that the generic bundled dataset does
NOT have there).

Two blanket fixes were tried first and reverted, each because they fixed
the reported case but broke that Deer Isle/Stonington route: (1) merging
the entire bundled land dataset into every named region at load time, (2)
pasting in the one specific missing bundled landmass polygon wholesale.
Both re-introduced the bundled dataset's own coarser representation of an
area the region's data already drew correctly with more detail.

Actual fix: a precise geometric difference (bundled-default minus the
region's own land, via shapely) computed only within a small bounding box
around each real gap, so only the genuinely missing sliver of land gets
added — never a whole landmass, never anything already covered by the
region's own more detailed data. Fixed two real gaps found this way:
near Vinalhaven (7 small polygons) and near Shag Rock/Muscongus Bay (18
small polygons, a real scattered ledge field) — the second only surfaced
after fixing the first changed the router's chosen path through the same
route. `data-version.json` regenerated so cached devices see the update.

A full-region version of this diff was also tried, purely to survey scope
(not applied): it found 2,456 differing polygons, but the overwhelming
majority are the bundled dataset having far more inland/river detail
(Bangor, Ellsworth, etc.) that this region's data deliberately omits as
irrelevant to a boat — not real navigable-water gaps. Applying that
blindly would repeat the same failure mode as the reverted attempts above,
just at a much larger scale. Other real coastal gaps almost certainly
exist; each needs this same small, verified, local fix when it actually
surfaces, not a blanket sweep.

Added a permanent regression case (`test_channel_routing.js` [18])
grading the resulting path against the bundled dataset specifically (real
ground truth), not whatever data built the route — otherwise the test
would be circular and could never catch this class of bug again.
`test/test_query.js` (25/25) and the full channel-routing suite (all
gated cases, including the previously-fragile Deer Isle/Stonington case)
pass.

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

## 2026-09-27 — "Nudge offshore" one-tap fix for a flagged shallow-area crossing (v713)

Direct follow-up: "if I pass too close to the coast, can't I try moving
straight out by 25 or 50 yards?" Tapping the yellow shallow-area warning
triangle now opens a small popup with two choices — "Edit route" (the
previous, only behavior) and a new "Nudge offshore" that tries to fix it
automatically.

`Query.findComfortableNudgePoint` (query.js) finds the nearest point with
real, sounding-verified comfortable depth (draft + 6ft — the same cutoff
the depth-heat overlay and v712's suppression logic already use), reusing
the existing `_makeObstacleCheck`/`_nearestClearPoint` machinery from
`snapToNavigableWater` but parameterized stricter: a wider margin, and
with the router's own "open-water nook" override turned off entirely
(that override exists only to keep the A* search from stranding itself —
a concern this single, user-initiated call doesn't have; nudging should
find the most conservative nearby answer, not the most permissive one).

Once a comfortable point is found, `_nudgeLegOffshore` (app.js) inserts it
as a real waypoint and re-routes just the two new sub-legs through it
(the same `_reRouteSegments`/`_showRerouteOverlay` machinery the Reroute
button already uses) — the fix is router-validated, not a naive straight
splice. No comfortable point within ~0.15nm falls back to the previous
behavior: drop a draggable node at the trouble spot for the user to
position by hand, with an explicit "couldn't find comfortably deep water
nearby" message — never guesses. Strictly post-hoc and single-leg, same
as v710's own shallow-area warning: this never touches `segBlocked`/the
A* hot path, per the standing rule in this hazard-dense chart data (a
search-time version of a similar idea broke 6/8 regression cases earlier
this session).

Also fixed a real, pre-existing bug this surfaced: `_reRouteSegments`
(app.js) treated ANY 2-point router result as a naive "couldn't avoid
land" failure, even when the router's own coastal-standoff ladder
legitimately returns a real, land-avoiding 2-point path marked
`marginal: true` (just tighter than the normal comfort standoff — see
router.js's own `_addRingNodes` comment). `_marginalLegFromPath` was only
ever checked for longer (>2 point) results; a short nudge leg was the
first thing to actually hit the 2-point-and-marginal case, which was
being misreported as a land crossing instead of the correct "passes
tight but real" warning. Fixed by checking the `marginal` flag before
falling through to `classifyFallbackSeg`'s straight-line check.

Verified against real chart data end-to-end, including the actual popup
UI (not just debug hooks): a genuine ~4.9ft shallow crossing nudged
~180yd to real 26.9ft/39.7ft-sounding-verified water, re-routed, and
confirmed clear via a live in-browser check; a genuine crossing with no
comfortable water within the cap correctly fell back to the manual-node
behavior with the right message. `test/test_query.js` (25/25) and
`test/test_channel_routing.js` (all gated cases) pass unchanged.

## 2026-09-27 — Don't show a shallow-area triangle when a real sounding says the crossing is actually deep (v712)

Direct follow-up to v711: showing the real depth ("~14.8 ft here") next to
the polygon's coarse range surfaced a UX problem it didn't fix on its
own — the triangle appeared on *every* crossing of a shallow-labeled
DEPARE polygon regardless of the real depth at that exact spot, so a
route could get flagged even where a real sounding showed clearly
comfortable water. User's reaction: "Seems to me there shouldn't be a
yellow triangle there in that case."

`_findRouteHazards` in `app.js` now uses the same real-sounding lookup to
decide whether to flag the crossing at all, not just what number to show.
If a real sounding is found nearby and its tide-adjusted depth is at or
above draft + 6ft, the crossing is left unflagged — same "clearly fine"
cutoff already used by the depth-heat overlay's own yellow band, so a
route triangle now means the same thing the map's own shading already
implies. A crossing in the marginal band (draft+3ft to draft+6ft) or
worse still gets flagged, and a crossing with no real sounding nearby
stays conservative and flags as before ("unverified is never safe",
same policy as the rest of this session's soundings work). Above-water
obstacle crossings are untouched — there's no "depth of water" to
evaluate there. `dangerSegments` (the red route highlight) is now set
only when a hazard is actually flagged, so a suppressed crossing doesn't
leave an unexplained red highlight with no marker.

Verified against real chart data (not synthetic): built two test routes
from actual charted soundings — a genuine ~4.9ft and ~8.9ft shallow
crossing (still flagged, real depth shown) and a genuine ~14.8ft crossing
inside a shallow-labeled polygon (now suppressed) — confirmed live in a
running app instance. `test/test_query.js` (25/25) and
`test/test_channel_routing.js` (all gated cases) pass unchanged — display
logic only, no router.js pathfinding impact.

## 2026-09-27 — Show real charted depth on shallow-area warning triangles (v711)

Direct request: for each yellow warning-triangle marker on a route (the
"soft hazard" shallow-area icon shown while editing/reviewing a route),
show the actual depth of the water there, in feet.

The marker's tooltip previously showed only the charted DEPARE polygon's
own worst-case depth *range* for its whole extent (e.g. "shallow area
(0.0-17.7 ft)") — same coarse-vs-precise theme as this session's other
fixes (v700/v709/v710): a polygon can span a broad area while the actual
depth at the specific crossing point is very different. `_findRouteHazards`
in `app.js` now also looks up a real nearby charted sounding
(`Query.nearestSounding`, 0.2nm radius) at the exact point the route
crosses the shallow polygon, and shows it alongside the range: "shallow
area (~14.8 ft here, charted range 0.0-17.7 ft)". Only applied to genuine
underwater shallow areas, not the separate "above-water obstacle" case
(no depth of water to report there). No real sounding found nearby stays
honest and shows the range alone, same "unverified stays conservative"
policy used throughout this session — never fabricates a precise-looking
number without real data behind it.

Display-only change (`app.js`'s hazard-finding/tooltip text), doesn't
touch router.js pathfinding at all. Verified live: injected the exact
route from the original standoff-warning report, confirmed both shallow-
area markers' real tooltips now show the actual nearby sounding depth.
`test/test_query.js` (25/25) and `test/test_channel_routing.js` (all
gated cases) pass unchanged.

## 2026-09-27 — Warn when a route grazes a shallow area, without blocking routing (v710)

Direct follow-up to v709: a user-reported route's leg passed 0.063nm
(~115m) from a real charted 0-1.8m shallow polygon without technically
crossing it. `segBlocked` correctly lets this through — it only blocks a
crossing or containment, not mere proximity — but a real mariner would
call that uncomfortably tight.

First attempt made this a hard block in `segBlocked` itself (checked
during the A* search, same standoff distance). **Reverted after the full
regression suite showed it was far too broad**: tidal shallow polygons in
this coastal data are numerous and often huge, so requiring every
candidate edge to stay clear of any nearby one — even when not routing
around it — cut off most previously-valid routing space. 6 of 8
regression cases broke, with search times blowing up 3-5x (up to 32s on
one case). Reverted immediately; nothing broken shipped.

Shipped instead: a POST-HOC check on the finished path only, not a
search-time block. Reuses the existing `marginal` flag/warning machinery
(`_marginalLegFromPath`/`_showRouteFallbackWarning` in `app.js`, already
built for the coastal-standoff-ladder's own fallback case) — zero changes
needed there. Runs once per finished route on a small, bounded number of
legs rather than thousands of times during the search, so a full
per-vertex proximity scan is cheap regardless of how broad the tidal
polygons are. Same real-soundings override as v700/v709: a leg
confirmed comfortably deep along its real charted soundings the whole way
isn't warned about just because a coarse polygon's worst-case footprint
happens to be nearby.

Verified: the mechanism correctly flags a real close-pass leg (confirmed
on a similar route), and the full regression suite passes identically to
the pre-change baseline across repeated runs — no timing or outcome
changes on any of the 8 previously-passing cases. `test/test_query.js`
(25/25) also passes.

## 2026-09-27 — Trust real soundings in the snap-to-navigable-water check too (v709)

Root cause of the original SP003 report (autoroute to a marker the user
confirmed sits squarely in the charted Fox Islands Thorofare channel, but
which the router moved 1.30nm away and then couldn't reach). Same bug
class already fixed in `router.js`'s mid-search `segBlocked` in v700, just
never applied to `query.js`'s `_makeObstacleCheck` (used by
`snapToNavigableWater` and `findClearOffshorePoint`): a DEPARE ("shallow
area") polygon's `valsou` is a single worst-case value for a potentially
huge area, and SP003's real charted depth (a sounding 0.068nm away showed
6.4m) was nothing like that worst case.

This one took three attempts to get right, all verified against the full
regression suite before deciding, not guessed:
1. Bare-minimum depth trust (mirroring v700 exactly) — genuinely cut
   SP003's snap distance 1.30nm -> 0.15nm, proving the diagnosis, but
   broke 3 previously-working routes (`[10]`, `[11]`, `[14]`).
2. A flat depth-confidence buffer — fixed `[14]` but not `[10]`/`[11]`,
   and broke a 4th case (`[17]`) that hadn't failed before.
3. **Shipped**: depth confidence AND a cheap open-water check (real
   compass-direction sampling at 0.4nm, not just the one ray that reached
   the candidate point) — because a point can have excellent, comfortable
   sounding depth and still be a small, real-graph-disconnected nook the
   visibility graph can't route out of (confirmed live: a candidate with
   a 5.1m sounding 0.038nm away, comfortably deep, had open water in only
   2 of 12 compass directions at 1nm). This function runs before the
   routing graph exists, so it can't check real graph connectivity
   directly — the open-water sampling is a cheap, effective proxy.
   Threshold (6 of 8 directions) picked empirically: 8 let the disconnected
   nook through and broke the 3 cases again; 7 correctly excluded it but
   also excluded the real SP003 improvement entirely; 6 is the only value
   that fixed SP003 while keeping every regression case passing.

**Honest result, not oversold:** SP003 now gets a real, graph-connected
5-point route (not a 2-point straight-line fallback) ending 1.06nm from
the marker — better than the original 1.30nm miss, but not a full arrival
at the exact point. The remaining gap is the same class of problem (this
function still can't fully verify graph connectivity, only approximate
it) and may need a more structural fix later. `test/test_query.js`
(25/25) and `test/test_channel_routing.js` (all gated cases, run
repeatedly for stability) pass with this change.

## 2026-09-27 — Auto-select the active chart region; show it in the title bar (v708)

Direct request: "I want the region to show in the window title area, near
where it says demo position. Also, when we are working in Penobscot
region, like we are, then set the Penobscot region." This knowingly
reverses a prior, deliberate design decision (`_offerRegionForPosition`'s
own comment: "every switch is now one tap, never automatic" — a real
regression once had a silent auto-switch corrupt an in-progress route
edit for a different area).

Added `_autoSelectRegionForPosition`, called from `showPosition()`
alongside the existing coverage check: when the boat's GPS/demo position
sits inside a real region's bounds and that region isn't already active,
switches automatically — skipped while editing/sketching/drawing, to
avoid the exact prior regression. Deliberately NOT gated on
`Query.isRegionDownloaded` the way the manual banner is — that check is
about a heavier pre-cached-for-offline package, not whether a region's
core chart files (ordinary bundled static assets, same cost as the
default's) are reachable at all.

Found and fixed a real bug while wiring this up: `_regionContaining`
always returned the bundled-default region (`''`), even when the
position was squarely inside a real, named region's bounds too — because
the bundled default's own `chart_bounds.geojson` happens to cover
essentially the same box as Penobscot Bay's, and `''` was checked first
in iteration order. Reordered to check specific (named) regions before
the generic default.

Also added `_statusRegionLabel` to the title bar (`_renderStatusCombo`),
positioned right after the GPS label per the request — shows "Region:
Penobscot Bay" or "Region: default", always current, never silently
wrong (this was the actual blocker in diagnosing the SP003 case: the
real active region was invisible short of inspecting devtools).

Verified live on a completely fresh session (no prior region selection):
demo position at Rockland auto-selects Penobscot Bay immediately, title
bar updates, `Query.getActiveRegion()` and the persisted localStorage key
both confirm the real switch (not just the label), and real region data
(2386 land polygons, 5 channels) loads correctly.

Also ships a previously-verified, independent fix: `test/
test_channel_routing.js`'s case 16 had a real bug in its own deadline
handling (a wider grading window wasn't actually passed to the router's
own budget, so the test could "pass" while the router had already given
up) — fixed by splitting `runCase`'s param into `routerDeadlineMs` (what
the router gets) and `gradeDeadlineMs` (what the test grades against).

## 2026-09-27 — Raise default route-planning time limit once more (v707)

CI's shared runner, under heavier load than the previous check, pushed
the same two known-marginal cases well past the v706 default (one to
14219ms, one to 20013ms) — a real device can easily see similar load.
Raised `DEFAULT_DEADLINE_MS` 14000->18000 (and the test's mirrored
constants, 54000 for the long-range derivation) as the new shipped
starting point, rather than continuing to chase CI's exact worst case —
users on consistently slower hardware now have the v706 "Route planning
time limit" setting to raise it further themselves. All in-scope
Penobscot Bay cases pass with real margin locally after this change.

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
