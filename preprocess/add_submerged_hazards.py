#!/usr/bin/env python3
"""
Put back the charted hazards that are always under water (S-57 WATLEV 3) into an
existing hazards.geojson, from the same ENC cells it was built from.

Until 2026-10-21 s57_to_geojson.py skipped WATLEV 3, taking it for "permanently
dry" (it means "always under water/submerged"; dry is 2), so every built
hazards.geojson is missing its submerged rocks, obstructions and wrecks
(INCIDENTS.md 2026-10-21). The extractor is fixed; this patches the shipped
files without re-running the whole region pipeline, whose other outputs (land
splices, light names, sectors) carry hand fixes a rebuild would put at risk.

Each feature is made exactly as s57_to_geojson.extract_hazards makes it (a
point at the geometry's centroid; objtype, label, valsou, watlev, name, chart),
from the cells already named in the file's own "chart" properties, then dropped
if within merge_charts' 15 m of a point hazard already there (or one just
added), and the list re-sorted shallowest first as merge_charts sorts it.

Usage:
    python3 preprocess/add_submerged_hazards.py www/data/regions/penobscot-bay/hazards.geojson \\
        --chart-dir ~/Documents/Charts/ENC/US_ME
Then regenerate that data's data-version.json fingerprint.
"""
import argparse
import json
import os

import fiona

from merge_charts import DEDUP_RADIUS_M, haversine_m
from s57_codes import HAZARD_LAYERS, OBJTYPE_LABEL
from s57_to_geojson import centroid_point

SUBMERGED = 3
LAYERS = [l for l in HAZARD_LAYERS if l != 'CBLOHD']   # overhead cables have no water level


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('hazards', help='hazards.geojson to patch in place')
    ap.add_argument('--chart-dir', required=True, help='directory of ENC cell folders (<cell>/<cell>.000)')
    a = ap.parse_args()

    raw = open(a.hazards).read()
    fc = json.loads(raw)
    feats = fc['features']
    cells = sorted({f['properties'].get('chart') for f in feats if f['properties'].get('chart')})
    pts = [tuple(f['geometry']['coordinates'][:2]) for f in feats
           if f['geometry']['type'] == 'Point' and f['properties'].get('objtype') in LAYERS]

    # a coarse grid over the points, so each new one only checks its neighbours
    cell_deg = 0.0005
    grid = {}
    def key(lon, lat): return (int(lon // cell_deg), int(lat // cell_deg))
    def add(lon, lat): grid.setdefault(key(lon, lat), []).append((lon, lat))
    def near(lon, lat):
        kx, ky = key(lon, lat)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for (x, y) in grid.get((kx + dx, ky + dy), ()):
                    if haversine_m(lon, lat, x, y) < DEDUP_RADIUS_M:
                        return True
        return False
    for p in pts: add(*p)

    added, dup, counts = [], 0, {}
    for cell in cells:
        path = os.path.join(os.path.expanduser(a.chart_dir), cell)
        enc = next((os.path.join(path, n) for n in sorted(os.listdir(path)) if n.endswith('.000')), None) if os.path.isdir(path) else None
        if not enc:
            print(f'  {cell}: no .000 cell under {path}, skipped')
            continue
        layers = set(fiona.listlayers(enc))
        for layer in LAYERS:
            if layer not in layers:
                continue
            with fiona.open(enc, layer=layer) as src:
                for feat in src:
                    geom = feat.get('geometry')
                    props = feat['properties']
                    if not geom or props.get('WATLEV') != SUBMERGED:
                        continue
                    lon, lat = centroid_point(geom)
                    if near(lon, lat):
                        dup += 1
                        continue
                    add(lon, lat)
                    added.append({
                        'type': 'Feature',
                        'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
                        'properties': {
                            'objtype': layer, 'label': OBJTYPE_LABEL[layer], 'valsou': props.get('VALSOU'),
                            'watlev': SUBMERGED, 'name': props.get('OBJNAM'), 'chart': cell,
                        },
                    })
                    counts[layer] = counts.get(layer, 0) + 1

    feats.extend(added)
    feats.sort(key=lambda f: f['properties'].get('valsou') if f['properties'].get('valsou') is not None else 999)
    # written in the file's own compact form (a plain load+dump of these files round-trips byte for byte)
    with open(a.hazards, 'w') as fh:
        fh.write(json.dumps(fc, separators=(',', ':'), ensure_ascii=False))
    print(f'{a.hazards}: added {len(added)} {counts}, {dup} already there (within {DEDUP_RADIUS_M:g} m), from {len(cells)} cells')


if __name__ == '__main__':
    main()
