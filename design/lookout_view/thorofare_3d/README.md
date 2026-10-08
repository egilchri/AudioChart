# Rockland to the Thorofare 3D (desktop WebGL sample)

Live: https://claude.ai/artifact/R6Ar3gqPFnJmRWkpqThs9J

three.js 0.160 (jsDelivr) scene: USGS 3DEP elevation (10 m near the Thorofare, 30 m beyond),
NAIP aerial photos draped on it, ~127k instanced spruce placed where the photo shows forest
within 1.5 km of the route, three's Water (reflectance tuned to 2%) and Sky, chart buoys/lights
from AudioChart data (scene.json). ~28 ms/frame on an M3 at 1.5× pixel ratio.

The data files are not committed (≈12 MB, regenerable):

    B=https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation
    gdal_translate -projwin -68.975 44.165 -68.765 44.075 /vsicurl/$B/13/TIFF/current/n45w069/USGS_13_n45w069.tif near.tif
    # far: the 30 m clip from ../README.md (lookout_view_usgs)
    # both → Float32 ENVI → int16 decimetres (water ≤0.4 m → -3 m), gzip, base64 → dem_near.b64.txt / dem_far.b64.txt
    S="https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bboxSR=4326&imageSR=4326&format=jpg&compressionQuality=82&f=image"
    # near_0..3.jpg: 2×2 tiles of bbox -68.975,44.075,-68.765,44.165 at size=4000,2400 (row-major, north row first)
    # far.jpg: bbox -69.16,43.98,-68.62,44.28 at size=4000,3086

## v2 (2026-10-08): from Rockland, bow, buoys

- Starts in Rockland Harbor: second 10 m patch (-69.13..-68.97, 44.055..44.135), 2×2 photo tiles.
- Photo tiles now carry their true extent. The NAIP service snaps requests to square pixels in
  degrees, so a 4000×2400 request for a 0.105°×0.045° box came back covering 0.063° of latitude;
  v1's textures were misregistered by hundreds of metres. `fetch_naip_tiles.py` sizes requests
  for square pixels and records the extent from `f=json`. One terrain mesh per tile.
- Rockland Breakwater: not in 3DEP (water hydro-flattened), traced from the photo:
  (-69.08197, 44.11540) → (-69.07751, 44.10410); lighthouse modelled at the outer end.
- Foredeck/pulpit/forestay attached to the camera, hidden from the water's mirror pass.
- Buoys scale up with distance (×1 under 150 m, up to ×6).
- No top-level await, and photos load via fetch + createImageBitmap, so the page's load event
  isn't held up by 24 MB of data. The artifact host still shows a blank frame for ~1 min on first load.

## v3 (2026-10-08): Perry Creek route, Cape Dory 25D, corner chart

- Route is the user's "Perry Creek" (saved 2026-10-08 19:48 UTC, 11 points, Rockland Harbor →
  Fox Islands Thorofare → Perry Creek, Vinalhaven), copied into scene.json.
- Boat is now its own object (points along the course, pitches/rolls); the camera sits inside it
  at the tiller (0.35 m to starboard, 1 m aft of the cockpit bulkhead, eye 2.0 m), so looking
  around turns your head, not the boat. Cape Dory 25D modelled from its published dimensions
  (25 ft LOA, 8 ft beam): lofted deck with sheer and camber, cabin trunk with bronze oval
  portlights and teak handrails, companionway and forward hatches, teak toe rails, deck-stepped
  mast with spreaders, uppers and fore/aft lowers, boom with navy sail cover, bow pulpit,
  stanchions and double lifelines.
- Corner chart: north-up land/water raster built in the browser from the same elevation the 3D
  view uses (so they agree), route ahead dashed, run so far solid, buoys, boat, view wedge.
