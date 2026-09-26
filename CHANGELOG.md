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
