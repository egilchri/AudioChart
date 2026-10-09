"""
Breakwaters, groynes, moles and training walls (S-57 SLCONS with CATSLC 1, 2, 3 or 7) from
the ENC cells, as land polygons for the router (2026-10-09). The charts draw most of them as
lines, which LNDARE extraction (extract_land.py) never saw, so AutoRoute sailed straight across
the Rockland Harbor Breakwater. Lines get a solid width (HALF_WIDTH_M either side); areas are
used as drawn. Overlapping copies from different chart scales are merged.

Piers and wharves (CATSLC 4, 6, 15, 16...) are deliberately left out: routes end at them, and
blocking them would cut destinations off.

    python3 preprocess/extract_breakwaters.py --chart-dir ~/Documents/Charts/ENC/penobscot_bay_only \
        --bbox 43.8,44.8,-69.6,-68.0 --out /tmp/breakwaters.geojson
"""
import argparse, glob, json, math, os
from osgeo import ogr, gdal
from shapely.geometry import shape, mapping
from shapely.ops import unary_union, transform

ogr.UseExceptions()
gdal.SetConfigOption('OGR_S57_OPTIONS', 'RETURN_PRIMITIVES=OFF,SPLIT_MULTIPOINT=ON,LNAM_REFS=ON,UPDATES=APPLY')
CATS = {1: 'breakwater', 2: 'groyne', 3: 'mole', 7: 'training wall'}
HALF_WIDTH_M = 10.0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chart-dir', required=True)
    ap.add_argument('--bbox', required=True, help='minlat,maxlat,minlon,maxlon')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    s, n, w, e = (float(v) for v in a.bbox.split(','))
    k = math.cos(math.radians((s + n) / 2))
    to_m = lambda x, y, z=None: (x * 111320 * k, y * 110540)
    to_deg = lambda x, y, z=None: (x / (111320 * k), y / 110540)
    parts, names = [], set()
    for f in sorted(glob.glob(os.path.join(os.path.expanduser(a.chart_dir), '*', '*.000'))):
        ds = ogr.Open(f)
        lyr = ds.GetLayerByName('SLCONS')
        if not lyr: continue
        lyr.SetSpatialFilterRect(w, s, e, n)
        for ft in lyr:
            if ft.GetField('CATSLC') not in CATS: continue
            g = shape(json.loads(ft.GetGeometryRef().ExportToJson()))
            gm = transform(to_m, g)
            gm = gm.buffer(HALF_WIDTH_M, cap_style=2) if gm.geom_type in ('LineString', 'MultiLineString') else gm.buffer(0)
            parts.append(gm)
            if ft.GetField('OBJNAM'): names.add(ft.GetField('OBJNAM'))
    merged = unary_union(parts)
    polys = list(merged.geoms) if merged.geom_type == 'MultiPolygon' else [merged]
    feats = []
    for p in polys:
        d = transform(to_deg, p.simplify(2.0))
        m = mapping(d)
        m['coordinates'] = [[[round(x, 5), round(y, 5)] for x, y in ring] for ring in m['coordinates']]
        feats.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': m['coordinates']}, 'properties': {}})
    json.dump({'type': 'FeatureCollection', 'features': feats}, open(a.out, 'w'), separators=(',', ':'))
    print(f'{len(parts)} chart features -> {len(feats)} polygons; named: {sorted(names)}')

if __name__ == '__main__':
    main()
