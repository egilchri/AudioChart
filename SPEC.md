# AudioChart — Implementation Specification

This document describes the full AudioChart system well enough that a developer with the same hardware and software prerequisites can reproduce it from the GitHub repository using an AI coding assistant like Claude Code.

---

## What it does

AudioChart is an offline-capable nautical safety PWA for sailing Maine waters. The user types (or speaks via the phone keyboard mic) queries like:

- "Hazards within quarter mile"
- "Range and bearing to Carvers Harbor"
- "Where am I"
- "Nearest buoy"

The app responds in speech and text with magnetic bearings, distances, and a Leaflet map showing the bearing line. It works fully offline at sea once data is downloaded at the dock.

---

## Hardware prerequisites

| Item | Notes |
|---|---|
| Mac (any modern macOS) | Runs the server below decks |
| Android phone (Pixel recommended) | Helm-mounted display |
| USB GPS puck (optional) | Better position accuracy than phone GPS |
| OpenCPN running on Mac (optional) | Live position + waypoints |

---

## Software prerequisites

```bash
pip3 install aiohttp
```

- Python 3.9+
- OpenCPN 5.x (optional but recommended)
- NOAA S-57 ENC charts for Maine, downloaded from NOAA to `~/Documents/Charts/ENC/US_ME/`
- A nautical MBTiles file for the area (e.g. `penobscot-esri-z16.mbtiles`) placed at `server/penobscot-esri-z16.mbtiles`

---

## Repository structure

```
AudioChart/
├── server/
│   ├── server.py          # Main aiohttp server — run this
│   ├── chartdb.py         # SQLite chart database (built from ENC files)
│   ├── opencpn_bridge.py  # Reads position from OpenCPN (ini, TCP, track)
│   ├── nmea_bridge.py     # Reads position from USB GPS puck via serial
│   ├── opencpn_waypoints.py  # Reads waypoints from OpenCPN navobj.db
│   ├── tile_server.py     # Serves MBTiles nautical chart tiles
│   └── charts.db          # Auto-generated SQLite database (gitignored)
├── preprocess/
│   ├── build_regions.py   # Generates static regional GeoJSON from charts.db
│   ├── s57_codes.py       # S-57 object type mappings
│   └── s57_to_geojson.py  # ENC chart parser
├── www/                   # The PWA (served by server AND GitHub Pages)
│   ├── index.html
│   ├── manifest.json
│   ├── sw.js              # Service worker (network-first for JS/CSS/HTML)
│   ├── css/
│   │   ├── app.css
│   │   └── leaflet.css    # Bundled Leaflet CSS
│   ├── js/
│   │   ├── app.js         # Main entry point, UI wiring
│   │   ├── query.js       # Spatial query engine
│   │   ├── parser.js      # Natural language command parser
│   │   ├── gps.js         # GPS source priority system
│   │   ├── tts.js         # Web Speech API wrapper
│   │   ├── utils.js       # Bearing/distance formatting
│   │   └── lib/
│   │       └── leaflet.js # Bundled Leaflet JS
│   └── data/
│       ├── hazards.geojson      # Bundled Penobscot Bay hazards (static fallback)
│       ├── named_places.geojson # Bundled named places
│       ├── navaid.geojson       # Bundled navaids
│       └── regions/
│           ├── penobscot-bay.json  # Pre-built regional data for offline download
│           └── casco-bay.json
├── .github/workflows/deploy.yml   # Deploys www/ to GitHub Pages on push
├── Startup.md             # End-user and developer startup guide
└── SPEC.md                # This file
```

---

## Server architecture

The server (`server/server.py`) is a single `aiohttp` async application serving:

| Route | Purpose |
|---|---|
| `GET /` and `GET /{path}` | Serves `www/` as static files with `no-cache` headers |
| `GET /connect` | HTML page with QR code for easy phone setup |
| `GET /api/nearby?lat=&lon=&radius=` | GeoJSON hazards/places/navaids within radius (gzip compressed) |
| `GET /api/waypoints` | OpenCPN waypoints from navobj.db |
| `GET /api/find-place?q=` | Full-database place name search |
| `POST /api/test-position` | Set/clear fake position for OpenCPN NMEA injection |
| `GET /tiles/{z}/{x}/{y}.jpg` | Nautical chart tiles from MBTiles file |
| `GET /ws/gps` | WebSocket: streams GPS position updates to phone |

**Port:** 8080 (HTTP, not HTTPS — service worker works on localhost only)

**GPS position priority** (highest first):
1. `manual` — test position set via API (priority 6)
2. `opencpn-nmea` — TCP NMEA from OpenCPN on port 10110 (priority 5)
3. `nmea` — USB GPS puck via serial (priority 4)
4. `opencpn-track` — last track point from navobj.db, has 5-minute staleness check (priority 2)
5. `browser` — phone's native GPS via `navigator.geolocation` (priority 1)
6. `opencpn-ini` — polled from `opencpn.ini`, no timestamp, lowest priority (priority 0)

`opencpn-ini` is priority 0 (below browser) because it's a stale config value with no timestamp — it should never override a live phone GPS fix.

---

## Chart database

On first run, `chartdb.py` processes all `.000` S-57 ENC files found under `~/Documents/Charts/ENC/US_ME/` and inserts them into `server/charts.db` (SQLite, WAL mode). Subsequent starts skip already-processed charts.

The database has three tables:
- `features` — hazards, named places, navaids (lat, lon, category, objtype, label, name, props)
- `magvar` — magnetic variation records (valmag, valacm annual correction, ryrmgv reference year)
- `processed_charts` — tracks which ENC files have been processed

`get_nearby(lat, lon, radius_nm)` queries by bounding box + haversine and returns GeoJSON FeatureCollections with the nearest MAGVAR value.

**To rebuild the database from scratch:** delete `server/charts.db` and restart the server.

---

## OpenCPN integration (one-time setup)

### Live position from OpenCPN → AudioChart

In OpenCPN: **Options → Connections → Add Connection**
- Type: Network | Protocol: TCP | Address: localhost | Port: **10110** | Direction: Output only

The `opencpn_bridge.py` connects to localhost:10110 and parses `$GPRMC`/`$GNRMC`/`$GPGLL` sentences.

### Test-position injection: AudioChart → OpenCPN

In OpenCPN: **Options → Connections → Add Connection**
- Type: Network | Protocol: TCP | Address: localhost | Port: **10112** | Direction: Input

The server listens on port 10112 and broadcasts `$GPRMC` sentences at 1 Hz when a test position is active. This moves the ship icon in OpenCPN to match the 📍 position set in the app.

---

## Building static regional data (developer workflow)

Pre-built regional files let the hosted app work offline without a server.

```bash
# 1. Make sure charts.db is current
python3 server/server.py  # wait for chart processing to finish, then Ctrl+C

# 2. Build regional GeoJSON files
python3 preprocess/build_regions.py
```

This writes:
- `www/data/regions/penobscot-bay.json` — full Penobscot Bay dataset with magvar
- `www/data/regions/casco-bay.json` — full Casco Bay dataset
- `www/data/regions/piscataqua.json` — Portsmouth NH / Kittery ME area (uses NOAA NH ENC charts from `~/Documents/Charts/ENC/US_NH/`)
- Updates `www/data/hazards.geojson`, `named_places.geojson`, `navaid.geojson` (static fallbacks, sourced from Penobscot Bay)

Run this whenever ENC charts are updated, then commit and push. GitHub Actions deploys automatically.

**Adding a new region:** Edit `REGIONS` dict in `preprocess/build_regions.py` and add a matching entry to `CRUISE_PROFILES` in `www/js/app.js`.

---

## Web app architecture

**`gps.js`** — Priority-based GPS system. `setManualPosition(lat, lon)` overrides with source `'manual'` (priority 6). `getPosition()` returns `{lat, lon, accuracy, source}`.

**`query.js`** — All spatial queries. Data lives in module-level `let hazards`, `namedPlaces`, `navaids`, `waypoints`. `loadData(lat, lon)` loads from server API → IndexedDB → static files (in that order). Query functions return `{text, speech}` pairs: `text` uses compact numeric format ("164° M, 2.1 nm"), `speech` uses digit-by-digit TTS format ("one six four degrees magnetic"). `findPlaceByName` searches waypoints, named places, and navaids (named buoys/lights/beacons are reachable by name in bearing queries). `navaidsInRadius(lat, lon, radiusNm, filter)` finds all navaids of a given type within radius, showing name + characteristic/colour + bearing + distance for each.

**`parser.js`** — Maps natural language to intents: `WHERE_AM_I`, `NEAREST_HAZARD`, `HAZARDS_IN_RADIUS`, `NAVAIDS_IN_RADIUS`, `BEARING_TO_COORD`, `BEARING_TO_PLACE`, `NEAREST_NAVAID`, `NEAREST_RESTRICTION`, `HAZARDS_ON_COURSE`, `HAZARDS_ALONG_ROUTE`. `NAVAIDS_IN_RADIUS` accepts an optional type filter (`buoy`, `light`, `beacon`, or null for all). Includes phonetic aliases for Maine place names.

**`tts.js`** — Wraps `window.speechSynthesis`. `sayImmediate(text)` cancels any in-progress speech and speaks immediately.

**`utils.js`** — Formatting: `bearingToWords(deg)` → digit-by-digit TTS, `bearingToDisplay(deg)` → "164° M", `compassDirectionWords(deg)` → "southwest", `naturalDistance(nm)` → "about a nautical mile".

**`sw.js`** — Network-first for all JS/CSS/HTML/GeoJSON (never serves stale app code). Cache-first for tiles. Never caches `/api/*` or `/ws/*`. Excludes `/connect` from interception.

**Offline storage** — IndexedDB (not Cache API — works on plain HTTP). Keys: `hazards`, `named_places`, `navaids`, `waypoints`. `prepareOffline(lat, lon, radiusNm)` downloads from server and merges additively (deduplicates by coordinate key at 4 decimal places ≈ 10m). `prepareOfflineStatic(dataUrl)` fetches a pre-built regional file and merges the same way.

---

## Two operating modes

| Mode | URL | Data source | GPS source |
|---|---|---|---|
| **Hosted (standalone)** | `https://egilchri.github.io/AudioChart` | Pre-built regional files + IndexedDB | Phone GPS only |
| **Developer (local server)** | `http://localhost:8080` | Live dynamic API (`/api/nearby`) | OpenCPN → GPS puck → phone GPS |

In developer mode, the bearing map view uses local nautical chart tiles (`/tiles/{z}/{x}/{y}.jpg`). In standalone mode, OpenStreetMap tiles are used instead.

---

## Starting the server

```bash
cd /path/to/AudioChart
python3 server/server.py
```

The server prints its local IP and a `localhost:8080/connect` URL. Open that in a browser on the Mac and scan the QR code with the phone to open the app.

---

## Key non-obvious details

- **Magnetic variation**: read from the nearest ENC chart's `MAGVAR` layer and applied to all bearings. Stored in `localStorage('audiochart-magvar')` as offline fallback.
- **Fuzzy place matching**: Levenshtein distance with a length-ratio fix for substring containment. `bearingToPlace` searches waypoints first, then named places. Falls back to `/api/find-place` server endpoint (full DB search) for test-position input only.
- **MAGVAR formula**: `adjusted = valmag + (valacm / 60) * (currentYear - referenceYear)` where `valacm` is annual change in minutes/year.
- **TMS tile flipping**: `y_mbtiles = (2^z - 1) - y_leaflet` — done server-side in `tile_server.py`.
- **Thread-safe SQLite**: `chartdb.py` uses `threading.local()` for per-thread connections to avoid corruption under aiohttp's thread pool executor.
- **`where am I` landmark search**: prefers towns/islands/coastal features/anchorages within 20nm; falls back to any named place within 15nm; then coordinates. Direction expressed as bearing FROM landmark TO user (8-point English compass).
