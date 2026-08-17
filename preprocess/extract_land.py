"""
Extract LNDARE (land area) polygon geometry from S-57 ENC charts and
produce a deduplicated, simplified GeoJSON for client-side line-of-sight checks.

Strategy:
  - Process charts detailed-scale first (US5/US6 → US4 → US3 → US2) so that
    fine-grained polygon boundaries win deduplication over coarse ones.
  - Deduplicate via centroid grid at 0.003° (~330 m): if a polygon's centroid
    falls in a cell already claimed by a more-detailed chart, skip it.
  - Simplify at 0.0005° (~55 m) to preserve narrow peninsulas and small islands.
  - Drop slivers smaller than 2e-7 sq-degrees (~42 m × 42 m at 44°N).

Usage:
    python3 preprocess/extract_land.py [--chart-dir DIR] [--bbox minlat,maxlat,minlon,maxlon]
                                        [--out PATH | --region ID]
Output:
    www/data/land.geojson by default, or www/data/regions/<ID>/land.geojson
    with --region, or an explicit --out path.
"""

import argparse, json, os, sys, math

try:
    from osgeo import ogr
except ImportError:
    sys.exit('GDAL/OGR not found.  pip install gdal')

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ENC_BASE = os.path.expanduser('~/Documents/Charts/ENC/US_ME')
DEFAULT_OUT_PATH = os.path.join(SCRIPT_DIR, '../www/data/land.geojson')
DEFAULT_BBOX = (43.0, 47.5, -71.5, -66.0)  # minlat, maxlat, minlon, maxlon

SIMPLIFY_DEG  = 0.0005  # ~55 m — enough detail to catch narrow peninsulas & small islands
MIN_AREA_DEG2 = 2e-7    # drop slivers < ~0.18 ha (~42m × 42m at 44°N)
DEDUP_CELL    = 0.003   # 0.003° grid (~330 m) for centroid deduplication

ogr.UseExceptions()

# Set by main() from parsed args — bbox_ok() reads these as module globals
# rather than a closure so the rest of the file (unchanged logic) doesn't
# need to be threaded with an extra parameter.
MIN_LAT = MAX_LAT = MIN_LON = MAX_LON = None


# ── Geometry helpers ──────────────────────────────────────────────────────────

def ring_coords(ring):
    return [[round(ring.GetX(i), 5), round(ring.GetY(i), 5)]
            for i in range(ring.GetPointCount())]


def poly_to_geojson(geom):
    """Return (gtype_str, coords) for a Polygon or MultiPolygon OGR geom."""
    flat = geom.GetGeometryType() & ~0x80000000  # strip Z flag
    if flat == ogr.wkbPolygon:
        return 'Polygon', [ring_coords(geom.GetGeometryRef(i))
                           for i in range(geom.GetGeometryCount())]
    if flat == ogr.wkbMultiPolygon:
        polys = []
        for i in range(geom.GetGeometryCount()):
            sub = geom.GetGeometryRef(i)
            polys.append([ring_coords(sub.GetGeometryRef(j))
                          for j in range(sub.GetGeometryCount())])
        return 'MultiPolygon', polys
    return None, None


def bbox_ok(env):
    minX, maxX, minY, maxY = env
    return maxX >= MIN_LON and minX <= MAX_LON and maxY >= MIN_LAT and minY <= MAX_LAT


def centroid_of_ring(ring):
    if not ring:
        return 0.0, 0.0
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    return sum(lons) / len(lons), sum(lats) / len(lats)


def polygon_area(ring):
    """Shoelace formula for signed area in degrees²."""
    n = len(ring)
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += ring[i][0] * ring[j][1]
        area -= ring[j][0] * ring[i][1]
    return abs(area) / 2.0


def simplify_geom(geom):
    """Return simplified geometry; fall back to original if simplification fails."""
    s = geom.SimplifyPreserveTopology(SIMPLIFY_DEG)
    return s if (s and not s.IsEmpty()) else geom


# ── Chart ordering ────────────────────────────────────────────────────────────

def chart_scale_priority(dirname):
    """Lower number = processed first (detailed charts win deduplication)."""
    if dirname.startswith('US6'): return 0
    if dirname.startswith('US5'): return 1
    if dirname.startswith('US4'): return 2
    if dirname.startswith('US3'): return 3
    if dirname.startswith('US2'): return 4
    return 9


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    global MIN_LAT, MAX_LAT, MIN_LON, MAX_LON

    ap = argparse.ArgumentParser()
    ap.add_argument('--chart-dir', default=DEFAULT_ENC_BASE,
                     help=f'ENC source directory (default: {DEFAULT_ENC_BASE})')
    ap.add_argument('--bbox', default=None,
                     help='minlat,maxlat,minlon,maxlon (default: the bundled Maine-coast bbox)')
    ap.add_argument('--out', default=None, help='Output path (default: www/data/land.geojson)')
    ap.add_argument('--region', default=None,
                     help='Shorthand for --out www/data/regions/<region>/land.geojson')
    args = ap.parse_args()

    enc_base = os.path.expanduser(args.chart_dir)
    if args.bbox:
        MIN_LAT, MAX_LAT, MIN_LON, MAX_LON = (float(x) for x in args.bbox.split(','))
    else:
        MIN_LAT, MAX_LAT, MIN_LON, MAX_LON = DEFAULT_BBOX

    if args.out:
        out_path = args.out
    elif args.region:
        out_path = os.path.join(SCRIPT_DIR, '../www/data/regions', args.region, 'land.geojson')
    else:
        out_path = DEFAULT_OUT_PATH

    enc_dirs = sorted(
        d for d in os.listdir(enc_base)
        if os.path.isdir(os.path.join(enc_base, d)) and d.startswith('US')
    )
    enc_dirs.sort(key=chart_scale_priority)

    claimed_cells = set()   # (grid_x, grid_y) cells already covered
    features = []
    skipped_dup = skipped_tiny = 0

    for enc_dir in enc_dirs:
        dir_path = os.path.join(enc_base, enc_dir)
        for fname in sorted(os.listdir(dir_path)):
            if not fname.endswith('.000'):
                continue
            path = os.path.join(dir_path, fname)
            ds = ogr.Open(path)
            if not ds:
                continue
            layer = ds.GetLayerByName('LNDARE')
            if not layer:
                continue

            chart_added = 0
            for feat in layer:
                geom = feat.GetGeometryRef()
                if not geom or not bbox_ok(geom.GetEnvelope()):
                    continue

                geom = simplify_geom(geom)
                gtype, coords = poly_to_geojson(geom)
                if gtype is None:
                    continue

                # Get outer ring for area + centroid checks
                outer = coords[0] if gtype == 'Polygon' else coords[0][0]

                # Drop slivers
                area = polygon_area(outer)
                if area < MIN_AREA_DEG2:
                    skipped_tiny += 1
                    continue

                # Deduplicate: skip if this centroid cell was already claimed
                cx, cy = centroid_of_ring(outer)
                cell = (int(cx / DEDUP_CELL), int(cy / DEDUP_CELL))
                if cell in claimed_cells:
                    skipped_dup += 1
                    continue
                claimed_cells.add(cell)

                features.append({
                    'type': 'Feature',
                    'geometry': {'type': gtype, 'coordinates': coords},
                    'properties': {},
                })
                chart_added += 1

            if chart_added:
                print(f'  {fname}: +{chart_added}')
            ds = None

    print(f'\nSkipped {skipped_dup} duplicates, {skipped_tiny} slivers')

    geojson = {'type': 'FeatureCollection', 'features': features}
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(geojson, f, separators=(',', ':'))

    size_kb = os.path.getsize(out_path) // 1024
    print(f'Wrote {len(features)} polygons → {out_path} ({size_kb} KB)')


if __name__ == '__main__':
    main()
