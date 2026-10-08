#!/usr/bin/env python3
"""
Additively merge a patch region's merged layers into an existing region,
without rebuilding (and clobbering hand edits in) the existing files.

Built for v816: the penobscot-bay build was missing the ENC cells for the
NE corner (Frenchman Bay N, Mount Desert Narrows, Union River, NW Mount
Desert Island). The missing cells were built alone as a throwaway region
(s57_to_geojson.py + merge_charts.py --region <patch>, with the target's
land.geojson copied in first so shallow areas get clipped), then merged here.

Only features not already present are added, using the same rules
merge_charts.py uses within one build:
  hazards  - 15 m centroid dedup per objtype, re-sorted shallowest first
  navaid   - 5 m centroid dedup (name_lower filled in to match the target)
  places   - name_lower not already present
  soundings- only into ~240 m grid cells the target has no sounding in
  channels / recommended_tracks - exact-geometry dedup
Features outside the target region's bbox are dropped.

Patch features inside the M_COVR coverage of the target's own band-5
(US5*) cells are dropped too, so coarse band-4 patch cells don't layer
duplicate depth areas over water the target already charts in detail.

Usage: python3 merge_region_patch.py <target_dir> <patch_dir> minlon,minlat,maxlon,maxlat <target_chart_dir>
"""
import json, math, os, sys

from shapely.geometry import shape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from merge_charts import _feature_centroid, haversine_m


def load(d, name):
    p = os.path.join(d, name)
    return json.load(open(p))['features'] if os.path.exists(p) else []


def write(d, name, feats):
    with open(os.path.join(d, name), 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': feats}, f, separators=(',', ':'))


def band5_coverage(chart_dir):
    from osgeo import ogr
    from shapely import wkt
    from shapely.ops import unary_union
    ogr.UseExceptions()
    polys = []
    for root, _, files in os.walk(chart_dir):
        for fn in files:
            if not (fn.startswith('US5') and fn.endswith('.000')):
                continue
            ds = ogr.Open(os.path.join(root, fn))
            lyr = ds.GetLayerByName('M_COVR')
            for ft in lyr or []:
                if ft.GetField('CATCOV') == 1:
                    polys.append(wkt.loads(ft.GetGeometryRef().ExportToWkt()))
    return unary_union(polys)


def grid_key(lon, lat, deg=0.001):
    return (round(lon / deg), round(lat / deg))


def near_dedup(existing, new, radius_m, by_type=True):
    grid = {}
    for f in existing:
        lon, lat = _feature_centroid(f)
        grid.setdefault(grid_key(lon, lat), []).append((lon, lat, f['properties'].get('objtype')))
    added = []
    for f in new:
        lon, lat = _feature_centroid(f)
        gx, gy = grid_key(lon, lat)
        t = f['properties'].get('objtype')
        dup = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for (elon, elat, et) in grid.get((gx + dx, gy + dy), []):
                    if (not by_type or et == t) and haversine_m(lon, lat, elon, elat) < radius_m:
                        dup = True
        if not dup:
            added.append(f)
            grid.setdefault((gx, gy), []).append((lon, lat, t))
    return added


def main():
    target, patch, bbox = sys.argv[1], sys.argv[2], [float(x) for x in sys.argv[3].split(',')]

    covered = band5_coverage(sys.argv[4])

    def inside(f):
        c = shape(f['geometry']).centroid
        if covered.contains(c):
            return False
        return bbox[0] <= c.x <= bbox[2] and bbox[1] <= c.y <= bbox[3]

    def layer(name, fn):
        old = load(target, name)
        new = [f for f in load(patch, name) if inside(f)]
        add = fn(old, new)
        print(f'  {name}: {len(old)} existing + {len(add)} added (of {len(new)} in patch)')
        return old, add

    old, add = layer('hazards.geojson', lambda o, n: near_dedup(o, n, 15.0))
    merged = old + add
    merged.sort(key=lambda f: f['properties'].get('valsou') if f['properties'].get('valsou') is not None else 999)
    write(target, 'hazards.geojson', merged)

    old, add = layer('navaid.geojson', lambda o, n: near_dedup(o, n, 5.0, by_type=False))
    for f in add:
        f['properties'].setdefault('name_lower', (f['properties'].get('name') or '').lower())
    write(target, 'navaid.geojson', old + add)

    def places(o, n):
        seen = {f['properties'].get('name_lower', '').strip() for f in o}
        out = []
        for f in n:
            k = f['properties'].get('name_lower', '').strip()
            if k and k not in seen:
                seen.add(k)
                out.append(f)
        return out
    old, add = layer('named_places.geojson', places)
    write(target, 'named_places.geojson', old + add)

    def soundings(o, n, deg=0.003):
        cells = {(round(f['geometry']['coordinates'][1] / deg), round(f['geometry']['coordinates'][0] / deg)) for f in o}
        return [f for f in n if (round(f['geometry']['coordinates'][1] / deg), round(f['geometry']['coordinates'][0] / deg)) not in cells]
    old, add = layer('soundings.geojson', soundings)
    write(target, 'soundings.geojson', old + add)

    def exact(o, n):
        seen = {json.dumps(f['geometry'], sort_keys=True) for f in o}
        return [f for f in n if json.dumps(f['geometry'], sort_keys=True) not in seen]
    for name in ('channels.geojson', 'recommended_tracks.geojson'):
        old, add = layer(name, exact)
        write(target, name, old + add)


if __name__ == '__main__':
    main()
