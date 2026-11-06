# Town buildings for the 3D helm view

`www/data/buildings/<town>.json` is built offline per town and listed in
`www/data/buildings/index.json` (file + bbox); `helm3d.js` loads every town
whose bbox is near the route. Built so far (Casco Bay, v996: Portland, South Portland, Peaks, Little and Great Diamond, Long, Cliff and Chebeague; v999: South Freeport and Bustins Island; from the ME_SouthCoastal_1_2020 survey and Microsoft quadkey 030233120, Portland with `MAXH=70`): Carvers Harbor (v833), North Haven village
and the Fox Islands Thorofare (v835), Camden (v836), Rockland and Rockport (v839),
Stonington, Islesford, Great Cranberry and Northeast Harbor (v840), Southwest Harbor and the
WoodenBoat School in Brooklin (v841), Bar Harbor and Castine (v842), Belfast and Searsport (v843), and the ferry terminals at Lincolnville Beach, Grindle Point (Islesboro), Bass Harbor and Swan's Island (v950, with Microsoft footprints; Bass Harbor and Swan's from ME_MidCoast_1_2021; the MDI towns use
the ME_MidCoast_1_2021 lidar survey, via `EPT=`).

Along SMART's line (v1118, `40 sf 9`): Larkspur, San Rafael, Terra Linda, Hamilton and Novato from `USGS_LPC_CA_NoCal_Wildfires_B5b_QL1_2018`; Petaluma, Cotati and Rohnert Park, Santa Rosa, the Sonoma County Airport station and Windsor from `CA_NorthernCA_1_B22`. Their NAIP photos fell back to The National Map's USGS imagery (build_town.py); EPT and its hierarchy are fetched with retries (S3 resets and 502s were common).

Along Caltrain's line (v1120, `40 sf 9`): Burlingame, San Mateo, San Carlos and Belmont, Redwood City from `CA_CaliforniaGaps_3_B23`; Palo Alto and Menlo Park, California Avenue, Mountain View, Sunnyvale and San Jose from `CA_SantaClaraCounty_2020`.

Sources:

- **Footprints:** OpenStreetMap (ODbL). Credit is shown in the scene.
  Overpass query: `way["building"]` plus `way["man_made"~"pier|breakwater"]`
  in the bbox, `out geom tags`. Send a User-Agent, or overpass-api.de returns 406.
- **Gap fill (optional):** Microsoft's ML building footprints (ODbL), one quadkey file per
  area: look the zoom-9 quadkey up in `global-buildings/dataset-links.csv`, then pass
  `MS=<file.csv.gz>`. A Microsoft footprint is used only where no OSM building covers its
  centre or sits within 8 m. Camden: OSM had 541 buildings and Microsoft filled in 1,851.
  The scene credit then adds Microsoft.
  A Microsoft footprint with no ground-class lidar within 8 m is dropped: it is on the water
  (a moored boat or float the model took for a building).
- **Heights:** the USGS 3DEP lidar point cloud. The Entwine EPT is on AWS:
  `usgs-lidar-public/<project>/ept.json`. Carvers Harbor uses
  ME_MidCoast_2_2021, found with hobuinc/usgs-lidar's
  `boundaries/resources.geojson`. EPT coordinates are web mercator (EPSG:3857),
  and Z is NAVD88, the same datum as the 3DEP DEM the terrain uses.
- **Roof colours:** the USDA NAIP image of the bbox from
  imagery.nationalmap.gov `exportImage` (4000 px).

Buildings whose centre is outside the town's bbox are skipped, since they belong to the neighbouring town's file.
Rockland's breakwater and its light are skipped by name (SKIP), because helm3d.js models them by hand.
An airport (v1111, SFO, survey `CA_CaliforniaGaps_3_B23`): `FLAT_OVER=900 PALETTE_BIG=airport` keeps footprints over 900 m² flat-roofed, in the airport palette (white, light grey, blue-grey glass), with curtain walls (`cw`: big panes on tall floors, terrain3d.js). The airport's ground (runways, taxiways, lights, jet bridges, tower) is a separate layer: `design/airports/build_airport.py` → `www/data/airports/<id>.json`, drawn by `www/js/airport3d.js`.
A named building whose OSM outline or roof the lidar contradicts can be replaced by hand-fitted blocks in `overrides.json` (keyed by its OSM name); build_buildings.py emits those instead. So far: Southwest Harbor's Coast Guard station (v1092).
An area spanning two quadkeys gets its Microsoft files concatenated (`cat a.gz b.gz > ms.csv.gz`).

Steps (Python venv with `laspy[lazrs] numpy pillow`). Each script reads the town from the environment:
`BBOX=west,south,east,north`, `TOWN="display name"`, and `EPT=<lidar project>`
(the default is ME_MidCoast_2_2021). Fetch the NAIP image at a size with the bbox's aspect ratio.
Then add the town to index.json (an optional `"focus": [lon, lat]` tells the bird's-eye view,
bay3d.html, where to aim when flying to the town; without it, it aims at the densest cluster of buildings):

    python ept_hier.py ept.json nodes.json             # EPT nodes touching the bbox, point counts per depth
    python ept_fetch.py nodes.json pts.npy 9           # points to depth 9 (~0.7 pts/m²), clipped to the bbox
    python build_buildings.py osm.json pts.npy naip.jpg ../../www/data/buildings/<town>.json

How each building is built:

- **Ground:** the 30th percentile of ground-class points within 8 m outside the footprint.
- **Eave and ridge:** the 12th and 92nd percentiles of non-ground points inside it. The ridge is capped at a 50° pitch, which stops overhanging trees inflating it.
- **Missing data:** buildings with fewer than 4 points get a default size.
- **Roof shape:** footprints that fill more than 85% of their minimum rectangle get a gable roof along the long side. The rest get a flat roof.
- **Wall colours:** chosen from a weighted Maine palette, by OSM id.
- **Piers:** the deck height is the 60th percentile of points within 2 m of the pier's line.
