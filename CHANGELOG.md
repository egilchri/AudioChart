# Changelog

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
