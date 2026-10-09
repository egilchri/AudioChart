# Town buildings for the 3D helm view

`www/data/buildings/<town>.json` is built offline per town and listed in
`www/data/buildings/index.json` (file + bbox); `helm3d.js` loads every town
whose bbox is near the route. Built so far: Carvers Harbor (v833), North Haven village
and the Fox Islands Thorofare (v835), Camden (v836), Rockland and Rockport (v839),
Stonington, Islesford, Great Cranberry and Northeast Harbor (v840; the last three use
the ME_MidCoast_1_2021 lidar survey, via `EPT=`).

Sources:

- **Footprints:** OpenStreetMap (ODbL). Credit is shown in the scene.
  Overpass query: `way["building"]` plus `way["man_made"~"pier|breakwater"]`
  in the bbox, `out geom tags`. Send a User-Agent, or overpass-api.de returns 406.
- **Gap fill (optional):** Microsoft's ML building footprints (ODbL), one quadkey file per
  area: look the zoom-9 quadkey up in `global-buildings/dataset-links.csv`, then pass
  `MS=<file.csv.gz>`. A Microsoft footprint is used only where no OSM building covers its
  centre or sits within 8 m. Camden: OSM had 541 buildings and Microsoft filled in 1,851.
  The scene credit then adds Microsoft.
- **Heights:** the USGS 3DEP lidar point cloud. The Entwine EPT is on AWS:
  `usgs-lidar-public/<project>/ept.json`. Carvers Harbor uses
  ME_MidCoast_2_2021, found with hobuinc/usgs-lidar's
  `boundaries/resources.geojson`. EPT coordinates are web mercator (EPSG:3857),
  and Z is NAVD88, the same datum as the 3DEP DEM the terrain uses.
- **Roof colours:** the USDA NAIP image of the bbox from
  imagery.nationalmap.gov `exportImage` (4000 px).

Buildings whose centre is outside the town's bbox are skipped, since they belong to the neighbouring town's file.
Rockland's breakwater and its light are skipped by name (SKIP), because helm3d.js models them by hand.
An area spanning two quadkeys gets its Microsoft files concatenated (`cat a.gz b.gz > ms.csv.gz`).

Steps (Python venv with `laspy[lazrs] numpy pillow`). Each script reads the town from the environment:
`BBOX=west,south,east,north`, `TOWN="display name"`, and `EPT=<lidar project>`
(the default is ME_MidCoast_2_2021). Fetch the NAIP image at a size with the bbox's aspect ratio.
Then add the town to index.json:

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
