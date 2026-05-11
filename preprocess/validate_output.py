#!/usr/bin/env python3
"""Validate preprocessed GeoJSON output files."""
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '../www/data'))

# Expected coverage: Rockland–Vinalhaven corridor
EXPECTED_BOUNDS = {'minlat': 43.9, 'maxlat': 44.4, 'minlon': -69.3, 'maxlon': -68.6}
MIN_HAZARD_COUNT = 50


def load(name):
    path = os.path.join(DATA_DIR, name)
    if not os.path.exists(path):
        return None, f'MISSING: {path}'
    with open(path) as f:
        fc = json.load(f)
    return fc.get('features', []), None


def check_bounds(features, label):
    lons = [f['geometry']['coordinates'][0] for f in features]
    lats = [f['geometry']['coordinates'][1] for f in features]
    if not lons:
        return
    print(f'  {label} bounds: lat {min(lats):.2f}–{max(lats):.2f}, lon {min(lons):.2f}–{max(lons):.2f}')
    ok = (min(lats) <= EXPECTED_BOUNDS['maxlat'] and max(lats) >= EXPECTED_BOUNDS['minlat'] and
          min(lons) <= EXPECTED_BOUNDS['maxlon'] and max(lons) >= EXPECTED_BOUNDS['minlon'])
    if not ok:
        print(f'  WARNING: {label} does not cover expected Rockland-Vinalhaven area!')


def main():
    errors = 0

    print('=== Hazards ===')
    hazards, err = load('hazards.geojson')
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
        if len(hazards) < MIN_HAZARD_COUNT:
            print(f'  WARNING: fewer than {MIN_HAZARD_COUNT} hazards — chart parsing may have failed')
            errors += 1
        check_bounds(hazards, 'hazards')

    print('\n=== Named Places ===')
    places, err = load('named_places.geojson')
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
        # Spot-check for key Penobscot Bay places
        names_lower = {f['properties'].get('name_lower', '') for f in places}
        for expected in ['rockland', 'vinalhaven', 'north haven']:
            found = any(expected in n for n in names_lower)
            status = 'OK' if found else 'MISSING'
            print(f'  "{expected}" in names: {status}')

    print('\n=== Navaids ===')
    navaids, err = load('navaid.geojson')
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
