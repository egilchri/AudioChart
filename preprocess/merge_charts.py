#!/usr/bin/env python3
"""
Merge and deduplicate raw GeoJSON files from s57_to_geojson.py.
Produces the final www/data/ files consumed by the PWA.

Pipeline order:
  1. python3 s57_to_geojson.py       — extract from NOAA ENC S-57 files
  2. python3 backfill_light_names.py — add names from NGA + manual overrides
  3. python3 merge_charts.py         — deduplicate and write final www/data/ files

Usage: python3 merge_charts.py
"""
import json
import math
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '../www/data'))
DEDUP_RADIUS_M = 15.0  # merge features within this distance (metres)


def haversine_m(lon1, lat1, lon2, lat2):
    """Return distance in metres between two WGS84 points."""
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def deduplicate(features, radius_m=DEDUP_RADIUS_M):
    """Remove near-duplicate point features. Keeps whichever has more populated properties."""
    kept = []
    for feat in features:
        lon, lat = feat['geometry']['coordinates']
        duplicate = False
        for k in kept:
            klon, klat = k['geometry']['coordinates']
            if haversine_m(lon, lat, klon, klat) < radius_m:
                # Keep the one with more non-null property values
                feat_score = sum(1 for v in feat['properties'].values() if v is not None)
                k_score = sum(1 for v in k['properties'].values() if v is not None)
                if feat_score > k_score:
                    kept[kept.index(k)] = feat
                duplicate = True
                break
        if not duplicate:
            kept.append(feat)
    return kept


def deduplicate_places(features):
    """Deduplicate named places by exact name match + proximity."""
    seen_names = {}
    kept = []
    for feat in features:
        name = feat['properties'].get('name_lower', '').strip()
        if not name:
            continue
        lon, lat = feat['geometry']['coordinates']
        if name in seen_names:
            # Keep if closer to the map center (prefer the more specific chart cell)
            pass  # just skip duplicate names
        else:
            seen_names[name] = feat
            kept.append(feat)
    return kept


def build_chart_bounds(hazard_features):
    """Build a single bounding box polygon from all hazard feature coordinates."""
    lons = [f['geometry']['coordinates'][0] for f in hazard_features]
    lats = [f['geometry']['coordinates'][1] for f in hazard_features]
    if not lons:
        return None
    minlon, maxlon = min(lons), max(lons)
    minlat, maxlat = min(lats), max(lats)
    # Add small buffer
    buf = 0.02
    ring = [
        [minlon - buf, minlat - buf],
        [maxlon + buf, minlat - buf],
        [maxlon + buf, maxlat + buf],
        [minlon - buf, maxlat + buf],
        [minlon - buf, minlat - buf],
    ]
    return {
        'type': 'FeatureCollection',
        'features': [{
            'type': 'Feature',
            'geometry': {'type': 'Polygon', 'coordinates': [ring]},
            'properties': {'description': 'Chart coverage area'},
        }],
    }


def load_raw(name):
    path = os.path.join(DATA_DIR, name)
    if not os.path.exists(path):
        print(f'  WARNING: {path} not found — run s57_to_geojson.py first')
        return []
    with open(path) as f:
        fc = json.load(f)
    return fc.get('features', [])


def write(features, name):
    fc = {'type': 'FeatureCollection', 'features': features}
    path = os.path.join(DATA_DIR, name)
    with open(path, 'w') as f:
        json.dump(fc, f, separators=(',', ':'))
    size_kb = os.path.getsize(path) // 1024
    print(f'  {name}: {len(features)} features, {size_kb} KB')


def main():
    print('Loading raw GeoJSON files...')
    hazards = load_raw('hazards_raw.geojson')
    places = load_raw('named_places_raw.geojson')
    navaids = load_raw('navaid_raw.geojson')

    print(f'Raw counts: hazards={len(hazards)}, places={len(places)}, navaids={len(navaids)}')

    print('Deduplicating hazards...')
    hazards = deduplicate(hazards)

    print('Deduplicating named places...')
    places = deduplicate_places(places)

    print('Deduplicating navaids...')
    navaids = deduplicate(navaids, radius_m=5.0)

    # Sort hazards: shallowest (most dangerous) first
    def hazard_sort_key(f):
        v = f['properties'].get('valsou')
        return v if v is not None else 999

    hazards.sort(key=hazard_sort_key)

    print('Writing output files...')
    write(hazards, 'hazards.geojson')
    write(places, 'named_places.geojson')
    write(navaids, 'navaid.geojson')

    bounds = build_chart_bounds(hazards)
    if bounds:
        path = os.path.join(DATA_DIR, 'chart_bounds.geojson')
        with open(path, 'w') as f:
            json.dump(bounds, f, separators=(',', ':'))
        print(f'  chart_bounds.geojson: coverage polygon written')

    print('\nMerge complete.')


if __name__ == '__main__':
    main()
