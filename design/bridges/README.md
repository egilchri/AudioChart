# Bridges for Bird's-eye

`www/data/bridges/<region>.json` (v1020, SF Bay) is built offline by `build_bridges.py` and drawn by
`www/js/bridges3d.js`. A region with no file has no bridges.

    python3 -I design/bridges/build_bridges.py sf-bay [OSM=<cached overpass json>]

- **Lines:** OpenStreetMap bridge ways (road and rail), from Overpass (send a User-Agent). overpass-api.de is often
  at capacity; the script falls back to overpass.private.coffee. A mirror can lack the newest way ids, so a cached
  response can be passed as `OSM=`.
- **Heights and towers:** the region's NOAA ENC cells (`BRIDGE` VERCLR/VERCCL/VERCOP, `PYLONS`), plus published
  figures. The big bridges are described in `SPECS`, as knots along their line (lat or lon, then a height), with
  their towers, cable runs, trusses and anchorages. Their OSM way ids are written there too: if OSM renumbers a way,
  that spec fails loudly.
- **Everything else** OSM has over the chart's water (at least 30% of its length off `land.geojson`) gets a plain
  deck at its charted clearance + 1.5 m (4.5 m if none is charted), and lift towers where the chart has a lift span.
