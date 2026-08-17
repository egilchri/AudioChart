#!/usr/bin/env python3
"""
Validate preprocessed GeoJSON output files.

Usage:
    python3 validate_output.py                                    # default bundled region
    python3 validate_output.py --region <id> --bbox minlat,maxlat,minlon,maxlon
        [--min-hazards N] [--expect-names name1,name2,...] [--data-dir PATH]
"""
import argparse
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Defaults match the bundled default region (Rockland-Vinalhaven corridor) —
# a new region passes its own --bbox/--min-hazards/--expect-names instead.
DEFAULT_BOUNDS = {'minlat': 43.9, 'maxlat': 44.4, 'minlon': -69.3, 'maxlon': -68.6}
DEFAULT_MIN_HAZARD_COUNT = 50
DEFAULT_EXPECT_NAMES = ['rockland', 'vinalhaven', 'north haven']


def load(data_dir, name):
    path = os.path.join(data_dir, name)
    if not os.path.exists(path):
        return None, f'MISSING: {path}'
    with open(path) as f:
        fc = json.load(f)
    return fc.get('features', []), None


def check_bounds(features, label, expected_bounds):
    # hazards.geojson mixes Point features (rocks, wrecks, obstructions) with
    # Polygon/MultiPolygon ones (DEPARE shallow-area zones) — coordinates[1]
    # on a polygon ring is not a latitude, it crashes. Bounds-checking only
    # needs a representative sample of positions, so Point features alone
    # are enough; this was a latent pre-existing bug (any dataset — bundled
    # or not — with DEPARE polygons would have hit it), not new here.
    points = [f for f in features if f['geometry']['type'] == 'Point']
    lons = [f['geometry']['coordinates'][0] for f in points]
    lats = [f['geometry']['coordinates'][1] for f in points]
    if not lons:
        return
    print(f'  {label} bounds: lat {min(lats):.2f}–{max(lats):.2f}, lon {min(lons):.2f}–{max(lons):.2f}')
    ok = (min(lats) <= expected_bounds['maxlat'] and max(lats) >= expected_bounds['minlat'] and
          min(lons) <= expected_bounds['maxlon'] and max(lons) >= expected_bounds['minlon'])
    if not ok:
        print(f'  WARNING: {label} does not cover the expected bbox!')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--region', default=None,
                     help='Region id, for messages only — data-dir is derived from --data-dir '
                          'or defaults to www/data/regions/<region>/ when given')
    ap.add_argument('--bbox', default=None, help='minlat,maxlat,minlon,maxlon (default: bundled region bbox)')
    ap.add_argument('--min-hazards', type=int, default=None, help=f'(default: {DEFAULT_MIN_HAZARD_COUNT})')
    ap.add_argument('--expect-names', default=None,
                     help='Comma-separated names to spot-check in named_places.geojson '
                          f'(default: {",".join(DEFAULT_EXPECT_NAMES)})')
    ap.add_argument('--data-dir', default=None,
                     help='Where to read the region\'s geojson from (default: www/data/, '
                          'or www/data/regions/<region>/ if --region is given without --data-dir)')
    args = ap.parse_args()

    if args.data_dir:
        data_dir = args.data_dir
    elif args.region:
        data_dir = os.path.join(SCRIPT_DIR, '../www/data/regions', args.region)
    else:
        data_dir = os.path.normpath(os.path.join(SCRIPT_DIR, '../www/data'))

    expected_bounds = DEFAULT_BOUNDS
    if args.bbox:
        minlat, maxlat, minlon, maxlon = (float(x) for x in args.bbox.split(','))
        expected_bounds = {'minlat': minlat, 'maxlat': maxlat, 'minlon': minlon, 'maxlon': maxlon}
    min_hazard_count = args.min_hazards if args.min_hazards is not None else DEFAULT_MIN_HAZARD_COUNT
    if args.expect_names:
        expect_names = args.expect_names.split(',')
    elif args.region:
        expect_names = []  # a new region has no known-good names to spot-check yet
    else:
        expect_names = DEFAULT_EXPECT_NAMES

    errors = 0

    print('=== Hazards ===')
    hazards, err = load(data_dir, 'hazards.geojson')
    if err:
        print(f'  {err}')
        errors += 1
    else:
        by_type = {}
        for f in hazards:
            t = f['properties'].get('objtype', '?')
            by_type[t] = by_type.get(t, 0) + 1
        for t, n in sorted(by_type.items()):
            print(f'  {t}: {n}')
        print(f'  Total: {len(hazards)}')
        if len(hazards) < min_hazard_count:
            print(f'  WARNING: fewer than {min_hazard_count} hazards — chart parsing may have failed')
            errors += 1
        check_bounds(hazards, 'hazards', expected_bounds)

    print('\n=== Named Places ===')
    places, err = load(data_dir, 'named_places.geojson')
    if err:
        print(f'  {err}')
        errors += 1
    else:
        by_type = {}
        no_name = 0
        for f in places:
            t = f['properties'].get('objtype', '?')
            by_type[t] = by_type.get(t, 0) + 1
            if not f['properties'].get('name'):
                no_name += 1
        for t, n in sorted(by_type.items()):
            print(f'  {t}: {n}')
        print(f'  Total: {len(places)}')
        if no_name:
            print(f'  WARNING: {no_name} places have null name')
            errors += 1
        # Spot-check for expected place names, if any were configured
        if expect_names:
            names_lower = {f['properties'].get('name_lower', '') for f in places}
            for expected in expect_names:
                found = any(expected in n for n in names_lower)
                status = 'OK' if found else 'MISSING'
                print(f'  "{expected}" in names: {status}')

    print('\n=== Navaids ===')
    navaids, err = load(data_dir, 'navaid.geojson')
    if err:
        print(f'  {err}')
        errors += 1
    else:
        by_type = {}
        for f in navaids:
            t = f['properties'].get('objtype', '?')
            by_type[t] = by_type.get(t, 0) + 1
        for t, n in sorted(by_type.items()):
            print(f'  {t}: {n}')
        print(f'  Total: {len(navaids)}')

    print(f'\n{"PASSED" if not errors else f"FAILED ({errors} errors)"}')
    sys.exit(0 if not errors else 1)


if __name__ == '__main__':
    main()
