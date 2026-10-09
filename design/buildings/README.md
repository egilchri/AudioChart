# Town buildings for the 3D helm view

`www/data/buildings/<town>.json` is built offline per town and listed in
`www/data/buildings/index.json` (file + bbox); `helm3d.js` loads every town
whose bbox is near the route. Carvers Harbor (v833) is the only one so far.

Sources:

- **Footprints:** OpenStreetMap (ODbL). Credit is shown in the scene.
  Overpass query: `way["building"]` plus `way["man_made"~"pier|breakwater"]`
  in the bbox, `out geom tags`. Send a User-Agent, or overpass-api.de returns 406.
- **Heights:** the USGS 3DEP lidar point cloud. The Entwine EPT is on AWS:
  `usgs-lidar-public/<project>/ept.json`. Carvers Harbor uses
  ME_MidCoast_2_2021, found with hobuinc/usgs-lidar's
  `boundaries/resources.geojson`. EPT coordinates are web mercator (EPSG:3857),
  and Z is NAVD88, the same datum as the 3DEP DEM the terrain uses.
- **Roof colours:** the USDA NAIP image of the bbox from
  imagery.nationalmap.gov `exportImage` (4000 px).

Steps (Python venv with `laspy[lazrs] numpy pillow`; the bbox is set at the top of each script):

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
