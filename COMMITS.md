# AudioChart — Development History

---

## May 10

- Initial commit: AudioChart nautical navigation PWA
- Silence noisy retry messages in server output
- Remove Web Speech API mic button; use native keyboard voice input
- Add offline prep and manual test position features
- Fix offline download: reduce radius to 20nm, add timeout and better errors
- Make offline download additive — multiple areas build up coverage
- Allow place names in test position input (Camden, Belfast, etc.)
- Switch offline storage from Cache API to IndexedDB
- Fix fuzzy matching: substring containment uses length ratio not 1.0
- Add /connect page with QR code for easy phone setup
- Update Startup.md: document stop-hopping strategy for offline coverage

---

## May 11

- Exclude /connect from service worker so QR page always loads fresh
- Add visual test-position confirmation: OpenCPN NMEA injection + phone map link
- Prefer town/harbour labels when multiple features share the same name
- Add server-side place lookup to fix ambiguous names like Southwest Harbor
- Add gzip compression and one-tap Route download for full cruise coverage
- Fix View on map link: use Google Maps URL on desktop, geo: URI on Android
- Fix geo: URI for Navionics — remove ?z=14 zoom parameter
- Use Google Maps URL for View on map on all platforms
- Add cruise profiles: Penobscot Bay and Casco Bay
- Add standalone hosted app: pre-built regions, GitHub Pages deployment
- Reload data from IndexedDB after route download so queries work immediately
- Add first-time welcome message with getting-started instructions
- Fix manifest start_url: use relative ./ so PWA installs from both localhost and GitHub Pages
- Add bearing map view: Leaflet map with position, destination, and line
- Reload chart data when test position is set (server mode)
- Show map on phone too: use OpenStreetMap tiles when no server
- Display bearings as numbers (241° M), speak them as words (two four one)
- Where am I: describe position relative to nearest landmark
- Fix whereAmI landmark search: correct labels, wider fallback radius
- Add SPEC.md: full implementation specification for server-mode reproduction
- Add place disambiguation: 'Crow Island, Cranberry Isles' picks the right one
- Document navaid naming and place disambiguation in Startup.md
- Add HAZARDS_ON_COURSE query: check a planned route for hazards
- Add server-side course-hazards endpoint to fix data gap
- Handle directional place qualifiers: 'west end of X', 'eastern entrance to X'
- Add 'Open in OpenCPN' button for course hazard queries
- Fix layout: map at 1/3 screen, OpenCPN button always visible, history capped
- Replace OpenCPN GPX approach with full-screen browser map tab
- Add 'Hazards along [route name]' for OpenCPN named routes
- Fix course-map quadrilateral and deduplicate route waypoints
- Fix 'Where am I' falling back to raw coordinates
- Add restricted areas, overhead cables, and light characteristics

---

## May 12

- Support ngrok URLs as server mode for PWA install
- Document ngrok mode and PWA 'Install' vs 'Add to Home Screen'
- Clarify that hosted PWA is fully offline after initial setup
- Add apple-touch-icon and apple-mobile-web-app-title for iOS PWA install
- Add ?demo mode for screen-recorded demos
- Switch mini-map to ESRI satellite imagery; add Where Am I map
- Restore local tiles in server mode; ESRI satellite only for standalone
- Pre-cache satellite tiles during Route download for offline map use
- Rebuild regional data with restrictions, cables, light characteristics
- Always use ESRI satellite for in-app mini-map
- Fix map zoom: call invalidateSize before fitBounds
- Fix oval compass rose — stretch icon horizontally to correct aspect ratio
- Fix 'bearing to west entrance to X' — directional parsing in bearingToPlace
- Fix cascading alias expansion in normalizePlaceName
- Document new features and fix manifest icon purposes

---

## May 13

- Add Piscataqua region, fix offline flow, and guided onboarding
- Fix navaid radius parsing: accept 'mi' abbreviation and 'within' synonyms
- Fix parseRadius: check fractions before 'mi' regex to avoid 1/2 → 2
- Add NAVAIDS_IN_RADIUS handler and navaidsInRadius query function
- Show navaid map for radius queries: colored markers by chart colour
- Navaid map: tap marker to speak range/bearing

---

## May 15

- Show navaid marker speech text in response window on click
- Show and speak hazard marker label on click in course map
- Guard hazard click handler against undefined label/name
- Hazard marker click: speak and display range and bearing from current position
- Use numeric/symbol format in text window for marker range and bearing
- Add LIST_OBJECTS voice command to enumerate queryable object types
- Show hazards-in-radius on map; limit speech to 2 items before 'X more'
- Limit hazards-on-course speech to 2 items before 'Plus N more'
- Name Rockland Breakwater Light in navaid and named_places data
- Add backfill_light_names.py to name unnamed ENC lights from NGA + overrides
- Backfill light names from OSM: Two Bush Island, Deer Island Thorofare, Matinicus Rock
- Extend chart area to Mt. Desert Island / Frenchman Bay
- Restore light characteristics; fix pipeline
- Add CHANGELOG.md generated from git history

---

## May 16

- Show app version in header
- Improve history UX: scrollable list, tap to edit
- Show navaid results as scrollable tap-to-speak list
- Fix navaid list ordering: render after showResponse
- Compact map when navaid list is shown to give list more space
- Double map height
- Map/list trade real estate on click
- Show all navaid results in scrollable list, not just first 8
- Add NAVAIDS_ON_BEARING query: find buoys/lights by bearing range
- Add data version check to detect and bypass stale IndexedDB chart data

---

## May 17

- Typed navaid/hazard icons, right-click context menu, long-press map query
- Add submenu for map context menu with selectable query radius
- Add "Set position here" to map context menu
- Add Where am I and Set waypoint here to map context menu
- Show waypoints as yellow squares on the map
- Add Show/Hide waypoints toggle to map context menu
- Add list waypoints command
- Add delete waypoint command
- Add Delete waypoint submenu to map context menu
- Consolidate waypoint menu into single Waypoints submenu
- Fix text input pushed off screen by tall map
- Show waypoint on map immediately when set
- Flash map marker when list row is tapped
- Expand map and pan to object when list row is tapped
- Collapse map when text input is focused
- Show boat icon on map when Set position here is used
- Fit map to show both current position and selected object on list tap
- Fix buoy icon color mapping (green/red were swapped)
- Make boat and waypoint markers draggable
- Make "You are here" dot draggable
- Use boat icon for You are here marker

---

## May 18

- Add You label to boat marker
- True two-way toggle: map grows when tapped, collapses when input focused
- Add persistent You boat marker on all map views
- Fix You boat marker missing on map queries
- Fix You boat visibility — solid blue circle, always in bounds
- Add Track submenu to right-click menu
- Add Sketch route to right-click menu
- Sketch route: true fullscreen + save route to localStorage
- Add route animation and GPS follow to Track menu
- Reorganize: Route becomes top-level menu with Sketch and Delete submenu
- Route animation: real-time speed + periodic object reports
- Fix animation: always animate when speed given, start from route beginning
- Add floating ☰ map menu button for phone access
- Fix Stop button and track filter reporting
- Fix sketch route drawing on mobile (touchmove not firing)
- Fix mobile sketch: use capture phase to beat Leaflet touch handlers
- Draw bearing lines and icons during animation interval reports
- Add time compression toggle to route animation (1× 10× 30× 60×)
- Use bare emoji boat icon during animation (no blue circle)
- Desktop two-column layout: map left, controls sidebar right
- Fix desktop layout: always show map container, init map on load
- Add 100× time compression option to animation

---

## May 19

- Add Import menu item for GPX markers and routes
- Add Combine routes (GPX) import option
- Show combined route on map before animating
- Fix import submenu hidden/styling — was always visible
- Add 500× time compression option to animation
- Auto-run Where am I after setting pin position
- Fix auto where-am-I after set position — always fire immediately
- Expand map and show boat on set-position; auto where-am-I for waypoint pos
- Show boat on map and auto where-am-I when typing a position name
- Fix map display after typing position — await _ensureMap before drawing
- Single-source version in version.js; fix map redraw on Set position
- Fix version not showing — use var so APP_VERSION lands on window
- Fix blank map after Set position — wait for CSS transition before invalidateSize
- Fix map hidden after Set position on mobile
- Fix map blank after Set position — setView when no zoom yet
- Add zoom level + boat-follow to route animation
- Zoom out to full route when animation completes
- Add satellite/chart map layer toggle
- Fix layer toggle button position — add position:relative to map container
- Stay in anim mode after completion until user taps map
- Rotate boat icon to heading and add rocking animation
- Redesign animation tracking: no lines, persistent flash markers, fix audio
- Fix iOS TTS during animation — prime on gesture + keep-alive
- Tap-to-stop: click map during animation to see nearby objects
- Restore click-on-object info for Objects Within context menu
- Tap to stop/resume animation; pulse + pan on object click
- Sticky route name and default 5-knot speed

---

## May 20

- Add 1000× animation speed multiplier
- Add 2000× animation speed multiplier
- Add Record checkbox to animation: saves GPX track
- Simplify Record to GPX-only, remove video capture
- Refresh route dropdown when Track submenu opens or GPX is imported
- Better import feedback: confirm count saved to Track menu
- Refresh Track dropdown after Combine Routes import

---

## May 25

- Every-N-miles milestone report: speak + draw bearing line to closest object
- Fix duplicate nearestNavaid declaration that broke module loading
- Pause boat during milestone report; resume after speech + 500ms
- Wait for opening announcement to finish before moving boat
- Named track configs + paced opening speech
- Add feedback to track config buttons; confirm before delete
- Rename route to match config name on save
- Show '✓ Loaded' feedback on track config load button
- Voice picker + smarter voice selection
- Fix config load: refresh route dropdown first; fix voice picker CSS vars
- Zoom map to show full bearing line during milestone report
- Line-of-sight navaid filter using ENC land polygons
- Fix config load: apply all controls correctly; fix save routeName capture
- Fix config load: persist sticky route/speed and handle old routeName format
- Add config load diagnostics: console log + status bar display
- Speak loaded config values for PWA diagnostic
- Log route names and speak route found/not-found in config load diagnostic
- Tighten land polygon extraction: detailed-first, finer simplification
- Regenerate land.geojson with improved parameters (2386 polygons)

---

## May 26

- Fix LOS: always load land.geojson regardless of server vs static path
- Add land data diagnostics: voice command + speech prefix on null
- Report two nearest visible objects at milestones for navigational fix
- Improve milestone fix display: always fitBounds, linger before speech
- Add milestone debug logging; make two lines visually distinct
- Require 45° angular separation between fix bearings; numbered endpoint labels
- Prefer 60°–120° bearing separation for cross-bearing fix
- Default map to Rockland Harbor; fix route sticky after config save
- Speak inter-bearing angle at milestone; flag if outside 60°–120°
- Add Visibility distance parameter to milestone fix reporting
- Exhaustive pair search for best cross-bearing fix
- Only accept 60°–120° pairs; report no-fix clearly if none qualify
- Show full route + last fix at route completion
- Navaid icons and bearing/range labels on fix lines
- Visibility chips inline with milestone row; context menu scrollable
- White icon circles with colored symbol/border; route-only end zoom
- Compass rose, track menu layout, service worker versioned registration
- Compass rose: top-left position, 140px, degree tick marks and numeric labels
- flyToBounds at route end to reliably show full route in viewport
- Compass rose rotated to magnetic north using local variation
