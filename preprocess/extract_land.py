"""
Extract LNDARE (land area) polygon geometry from S-57 ENC charts and
produce a deduplicated, simplified GeoJSON for client-side line-of-sight checks.

Strategy:
  - Process charts detailed-scale first (US6 -> US5 -> US4 -> US3 -> US2),
    grouped into scale TIERS (all US6 charts as one tier, then all US5
    charts, etc.) rather than file-by-file.
  - Deduplicate by chart-cell COVERAGE, not by polygon centroid. Each ENC
    cell carries its own M_COVR ("coverage") meta-object marking the
    exact area it's authoritative for (CATCOV=1) -- the same mechanism
    real ECDIS software uses to compile overlapping charts of different
    scales. Before a tier's LNDARE polygons are added, they're clipped to
    exclude any area already covered by a STRICTLY finer tier's M_COVR
    footprint, whether that finer tier shows land or water there. A
    coarser chart's land shape can then only fill genuine gaps in finer
    coverage, never override it.
      Fixes a real bug in the old centroid-based dedup (see
      INCIDENTS.md/CHANGELOG.md 2026-09-23-24, and this file's own git
      history): a large, multi-vertex landmass like a whole island is
      usually one LNDARE feature per chart, so its centroid lands in a
      single grid cell -- a finer chart's fragmentary coverage of just
      one harbor on that island doesn't reliably claim that same cell,
      so a coarser chart's less accurate whole-island outline could slip
      through unfiltered and smooth over a real, navigable notch in the
      coastline that the finer chart shows correctly as open water.
      Coverage-based clipping fixes this structurally: it doesn't matter
      whether any single fine polygon's centroid happens to land in the
      same cell as the coarse one, only whether the finer chart's own
      declared coverage area overlaps.
  - Simplify at 0.0005 deg (~55 m) to preserve narrow peninsulas and small
    islands. Applied before clipping so the clip operates on the same
    simplified boundary that ships.
  - Drop slivers smaller than 2e-7 sq-degrees (~42 m x 42 m at 44 deg N),
    checked after clipping (a clip can shrink a polygon into a sliver).

Usage:
    python3 preprocess/extract_land.py [--chart-dir DIR] [--bbox minlat,maxlat,minlon,maxlon]
                                        [--out PATH | --region ID]
Output:
    www/data/land.geojson by default, or www/data/regions/<ID>/land.geojson
    with --region, or an explicit --out path.
"""

import argparse, json, os, sys

try:
    from osgeo import ogr
except ImportError:
    sys.exit('GDAL/OGR not found.  pip install gdal')

try:
    from shapely.geometry import shape, mapping
    from shapely.ops import unary_union
    from shapely.validation import make_valid
except ImportError:
    sys.exit('shapely not found.  pip install shapely')

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ENC_BASE = os.path.expanduser('~/Documents/Charts/ENC/US_ME')
DEFAULT_OUT_PATH = os.path.join(SCRIPT_DIR, '../www/data/land.geojson')
DEFAULT_BBOX = (43.0, 47.5, -71.5, -66.0)  # minlat, maxlat, minlon, maxlon

SIMPLIFY_DEG  = 0.0005  # ~55 m — enough detail to catch narrow peninsulas & small islands
MIN_AREA_DEG2 = 2e-7    # drop slivers < ~0.18 ha (~42m × 42m at 44°N)
COORD_PRECISION = 5

# Adjacent chart cells' M_COVR boundaries are digitized independently and
# essentially never share exact vertices, even where they're meant to abut
# seamlessly. Clipping a coarser chart's LNDARE against an unbuffered union
# of finer coverage footprints leaves razor-thin, oddly-shaped leftover
# slivers right along those seams — real bug found live (2026-09-24): one
# such sliver pinched the visibility graph across Fox Islands Thorofare,
# a real narrow channel, making a previously-solvable route report "no
# path found" against otherwise-correct chart data. Buffering each tier's
# coverage footprint outward by a small amount before using it to clip
# swallows those seam slivers into "already covered" instead of leaving
# them as disconnected fragments. Far smaller than SIMPLIFY_DEG so it
# doesn't meaningfully erode any genuine gap in fine-chart coverage.
CLIP_BUFFER_DEG = 0.00003  # ~3 m at 44°N

ogr.UseExceptions()

# Set by main() from parsed args — bbox_ok() reads these as module globals
# rather than a closure so the rest of the file (unchanged logic) doesn't
# need to be threaded with an extra parameter.
MIN_LAT = MAX_LAT = MIN_LON = MAX_LON = None


# ── Geometry helpers ──────────────────────────────────────────────────────────

def bbox_ok(env):
    minX, maxX, minY, maxY = env
    return maxX >= MIN_LON and minX <= MAX_LON and maxY >= MIN_LAT and minY <= MAX_LAT


def simplify_geom(geom):
    """Return simplified geometry; fall back to original if simplification fails."""
    s = geom.SimplifyPreserveTopology(SIMPLIFY_DEG)
    return s if (s and not s.IsEmpty()) else geom


def ogr_to_shapely(geom):
    """OGR geometry -> valid shapely geometry, or None if it can't be made valid."""
    try:
        g = shape(json.loads(geom.ExportToJson()))
    except Exception:
        return None
    if not g.is_valid:
        g = make_valid(g)
    return None if g.is_empty else g


def round_coords(obj, ndigits=COORD_PRECISION):
    """Recursively round every coordinate pair in a GeoJSON geometry dict."""
    if isinstance(obj[0], (int, float)):
        return [round(obj[0], ndigits), round(obj[1], ndigits)]
    return [round_coords(c, ndigits) for c in obj]


def polygon_parts(geom):
    """Yield each Polygon inside a (Multi)Polygon/GeometryCollection, dropping
    non-polygonal parts a difference() can occasionally produce (slivers of
    lower dimension along a shared boundary)."""
    if geom.geom_type == 'Polygon':
        yield geom
    elif geom.geom_type in ('MultiPolygon', 'GeometryCollection'):
        for part in geom.geoms:
            yield from polygon_parts(part)


# ── Chart ordering ────────────────────────────────────────────────────────────

def chart_scale_tier(dirname):
    """Lower number = finer scale = processed first, and whose own coverage
    footprint takes priority when tiers overlap."""
    if dirname.startswith('US6'): return 0
    if dirname.startswith('US5'): return 1
    if dirname.startswith('US4'): return 2
    if dirname.startswith('US3'): return 3
    if dirname.startswith('US2'): return 4
    return 9


def chart_files(enc_base, dirnames):
    for dirname in dirnames:
        dir_path = os.path.join(enc_base, dirname)
        for fname in sorted(os.listdir(dir_path)):
            if fname.endswith('.000'):
                yield dirname, os.path.join(dir_path, fname)


def read_coverage(path):
    """Union of this chart cell's own M_COVR CATCOV=1 (coverage available)
    polygons within the target bbox — the cell's declared authoritative
    footprint. None if the cell has no usable M_COVR."""
    ds = ogr.Open(path)
    if not ds:
        return None
    layer = ds.GetLayerByName('M_COVR')
    if not layer:
        return None
    polys = []
    for feat in layer:
        geom = feat.GetGeometryRef()
        if not geom or not bbox_ok(geom.GetEnvelope()):
            continue
        catcov_idx = feat.GetFieldIndex('CATCOV')
        if catcov_idx >= 0 and feat.GetField(catcov_idx) != 1:
            continue  # CATCOV=2 ("no coverage") — not this cell's authoritative area
        g = ogr_to_shapely(geom)
        if g is not None:
            polys.append(g)
    ds = None
    return unary_union(polys) if polys else None


def read_land(path):
    """This chart cell's LNDARE polygons within the target bbox, simplified,
    as shapely geometries."""
    ds = ogr.Open(path)
    if not ds:
        return []
    layer = ds.GetLayerByName('LNDARE')
    if not layer:
        return []
    out = []
    for feat in layer:
        geom = feat.GetGeometryRef()
        if not geom or not bbox_ok(geom.GetEnvelope()):
            continue
        geom = simplify_geom(geom)
        g = ogr_to_shapely(geom)
        if g is not None:
            out.append(g)
    ds = None
    return out


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
    tiers = {}
    for d in enc_dirs:
        tiers.setdefault(chart_scale_tier(d), []).append(d)

    already_covered = None  # union of every strictly-finer tier's own M_COVR footprint
    all_land = []           # shapely polygons, clipped, ready for output
    skipped_tiny = 0
    skipped_empty_clip = 0

    for tier in sorted(tiers):
        dirnames = tiers[tier]
        tier_coverage_parts = []
        tier_land_count = 0

        for dirname, path in chart_files(enc_base, dirnames):
            cov = read_coverage(path)
            if cov is not None:
                tier_coverage_parts.append(cov)

            land_polys = read_land(path)
            if not land_polys:
                continue

            for g in land_polys:
                clipped = g if already_covered is None else g.difference(already_covered)
                if not clipped.is_valid:
                    clipped = make_valid(clipped)
                if clipped.is_empty:
                    skipped_empty_clip += 1
                    continue
                for part in polygon_parts(clipped):
                    if part.area < MIN_AREA_DEG2:
                        skipped_tiny += 1
                        continue
                    all_land.append(part)
                    tier_land_count += 1

            if land_polys:
                print(f'  [{dirname}] {os.path.basename(path)}: +{sum(1 for g in land_polys)} raw')

        print(f'Tier {tier} ({dirnames[0][:3]}*, {len(dirnames)} charts): '
              f'{tier_land_count} land pieces kept after clipping')

        if tier_coverage_parts:
            tier_union = unary_union(tier_coverage_parts).buffer(CLIP_BUFFER_DEG)
            already_covered = tier_union if already_covered is None else already_covered.union(tier_union)

    print(f'\nSkipped {skipped_tiny} slivers, {skipped_empty_clip} pieces fully covered by a finer chart')

    # Clipping leaves pieces that exactly touch or barely overlap their
    # neighbor along a chart-cell seam (see CLIP_BUFFER_DEG's comment) —
    # a final dissolve welds anything touching/overlapping back into one
    # coherent shape per real landmass, rather than shipping it as several
    # separate slivers that can pinch a narrow channel's visibility graph
    # between them. Also naturally re-merges any real duplicate coverage
    # between adjacent same-tier charts that CLIP_BUFFER_DEG's finer-tier-
    # only clipping doesn't touch.
    print(f'Dissolving {len(all_land)} pieces...')
    merged = unary_union(all_land)
    all_land = list(polygon_parts(merged))
    print(f'-> {len(all_land)} polygons after dissolve')

    features = []
    for g in all_land:
        gj = mapping(g)
        gj['coordinates'] = round_coords(gj['coordinates'])
        features.append({'type': 'Feature', 'geometry': gj, 'properties': {}})

    geojson = {'type': 'FeatureCollection', 'features': features}
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(geojson, f, separators=(',', ':'))

    size_kb = os.path.getsize(out_path) // 1024
    print(f'Wrote {len(features)} polygons → {out_path} ({size_kb} KB)')


if __name__ == '__main__':
    main()
