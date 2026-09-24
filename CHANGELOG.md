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
