#!/usr/bin/env python3
"""
Backfill proper names for unnamed lights in navaid_raw.geojson using two sources:

  1. NGA Pub. 110 — worldwide light list from the National Geospatial-Intelligence
     Agency, fetched via their MSI API for the chart bounding box.

  2. light_name_overrides.json — manual name patches that survive pipeline re-runs.
     Format: [{"lat": 44.104041, "lon": -69.0775453, "name": "Rockland Breakwater Light"}, ...]

Matching strategy:
  - Find the nearest NGA light within MATCH_RADIUS_M metres of each unnamed ENC light.
  - Optionally confirm the characteristic prefix matches (e.g. both start with "Fl W").

Run after s57_to_geojson.py and before merge_charts.py:
  python3 backfill_light_names.py [--bbox minlat minlon maxlat maxlon] [--dry-run]

The NGA API endpoint used:
  https://msi.nga.mil/api/publications/ngalol/all-query?output=geoJson
  (with minLatitude, maxLatitude, minLongitude, maxLongitude query params)
"""

import argparse
import json
import math
import os
import sys
import urllib.request
import urllib.parse

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
DATA_DIR    = os.path.normpath(os.path.join(SCRIPT_DIR, '../www/data'))
OVERRIDES   = os.path.join(SCRIPT_DIR, 'light_name_overrides.json')

NGA_API     = 'https://msi.nga.mil/api/publications/ngalol/all-query'
MATCH_RADIUS_M = 200   # metres — generous to allow for datum differences
CHECK_CHARS    = True  # require characteristic prefix to match


# ── helpers ──────────────────────────────────────────────────────────────────

def haversine_m(lon1, lat1, lon2, lat2):
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


def char_prefix(s):
    """First two space-separated tokens of a characteristic, lowercased.
    E.g. 'Fl(1) W 5s' → 'fl w',  'Fl W 5s' → 'fl w'."""
    if not s:
        return ''
    tokens = s.replace('(', ' ').replace(')', ' ').split()
    return ' '.join(t.lower() for t in tokens[:2] if not t.isdigit())


def load_geojson(path):
    with open(path) as f:
        return json.load(f)


def save_geojson(fc, path):
    with open(path, 'w') as f:
        json.dump(fc, f, separators=(',', ':'))


# ── NGA fetch ─────────────────────────────────────────────────────────────────

def fetch_nga(minlat, minlon, maxlat, maxlon):
    """Download NGA light list GeoJSON for the given bounding box."""
    params = urllib.parse.urlencode({
        'output':       'geoJson',
        'minLatitude':  minlat,
        'maxLatitude':  maxlat,
        'minLongitude': minlon,
        'maxLongitude': maxlon,
    })
    url = f'{NGA_API}?{params}'
    print(f'Fetching NGA data: {url}')
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f'ERROR fetching NGA data: {e}')
        print('Try downloading manually and passing --nga-file path/to/file.geojson')
        sys.exit(1)

    features = data.get('features', [])
    print(f'  NGA returned {len(features)} lights in bounding box')
    return features


def parse_nga_features(features):
    """Extract (lat, lon, name, characteristic) from NGA GeoJSON features."""
    lights = []
    for feat in features:
        props = feat.get('properties', {})
        name  = (props.get('name') or '').strip()
        if not name:
            continue
        # NGA GeoJSON has a proper geometry point
        geom = feat.get('geometry') or {}
        coords = geom.get('coordinates')
        if coords and len(coords) == 2:
            lon, lat = coords
        else:
            continue
        characteristic = (props.get('characteristic') or '').strip()
        lights.append({'lat': lat, 'lon': lon, 'name': name, 'characteristic': characteristic})
    return lights


# ── overrides ─────────────────────────────────────────────────────────────────

def load_overrides():
    if not os.path.exists(OVERRIDES):
        return []
    with open(OVERRIDES) as f:
        return json.load(f)


# ── bounding box from navaid_raw ───────────────────────────────────────────────

def bbox_from_navaids(features):
    lons = [f['geometry']['coordinates'][0] for f in features]
    lats = [f['geometry']['coordinates'][1] for f in features]
    pad = 0.05
    return min(lats)-pad, min(lons)-pad, max(lats)+pad, max(lons)+pad


# ── matching ──────────────────────────────────────────────────────────────────

def find_best_nga_match(lon, lat, enc_char, nga_lights):
    """Return the best NGA match within MATCH_RADIUS_M, or None."""
    best = None
    best_dist = MATCH_RADIUS_M
    enc_prefix = char_prefix(enc_char)

    for nga in nga_lights:
        d = haversine_m(lon, lat, nga['lon'], nga['lat'])
        if d >= best_dist:
            continue
        if CHECK_CHARS and enc_prefix and nga['characteristic']:
            if char_prefix(nga['characteristic']) != enc_prefix:
                continue
        best = nga
        best_dist = d
    return best, best_dist


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--bbox', nargs=4, type=float, metavar=('MINLAT','MINLON','MAXLAT','MAXLON'),
                    help='Override bounding box (default: derived from navaid_raw.geojson)')
    ap.add_argument('--nga-file', metavar='PATH',
                    help='Use a locally downloaded NGA GeoJSON instead of fetching')
    ap.add_argument('--dry-run', action='store_true',
                    help='Print matches without writing files')
    ap.add_argument('--radius', type=float, default=MATCH_RADIUS_M,
                    help=f'Match radius in metres (default: {MATCH_RADIUS_M})')
    args = ap.parse_args()

    global MATCH_RADIUS_M
    MATCH_RADIUS_M = args.radius

    # Load raw navaid data
    navaid_path = os.path.join(DATA_DIR, 'navaid_raw.geojson')
    places_path = os.path.join(DATA_DIR, 'named_places_raw.geojson')
    navaid_fc   = load_geojson(navaid_path)
    places_fc   = load_geojson(places_path)

    navaids = navaid_fc['features']
    unnamed_lights = [
        f for f in navaids
        if f['properties'].get('objtype') == 'LIGHTS'
        and not f['properties'].get('name')
    ]
    print(f'Unnamed LIGHTS in navaid_raw: {len(unnamed_lights)} of {len(navaids)} total navaids')

    # Load NGA data
    if args.nga_file:
        print(f'Loading NGA data from {args.nga_file}')
        with open(args.nga_file) as f:
            raw = json.load(f)
        nga_lights = parse_nga_features(raw.get('features', []))
    else:
        if args.bbox:
            minlat, minlon, maxlat, maxlon = args.bbox
        else:
            minlat, minlon, maxlat, maxlon = bbox_from_navaids(navaids)
        nga_features = fetch_nga(minlat, minlon, maxlat, maxlon)
        nga_lights   = parse_nga_features(nga_features)
    print(f'NGA named lights available for matching: {len(nga_lights)}')

    # Load manual overrides
    overrides = load_overrides()
    print(f'Manual overrides loaded: {len(overrides)}')

    # Build override lookup: (rounded_lat, rounded_lon) → name
    def override_key(lat, lon):
        return (round(lat, 4), round(lon, 4))
    override_map = {override_key(o['lat'], o['lon']): o['name'] for o in overrides}

    # Match and patch
    matched_nga = 0
    matched_override = 0
    new_place_names = set(
        f['properties'].get('name_lower', '') for f in places_fc['features']
    )

    for feat in navaids:
        if feat['properties'].get('objtype') != 'LIGHTS':
            continue
        if feat['properties'].get('name'):
            continue  # already named

        lon, lat = feat['geometry']['coordinates']
        enc_char = feat['properties'].get('characteristic', '')

        # Check manual overrides first
        key = override_key(lat, lon)
        if key in override_map:
            name = override_map[key]
            source = 'override'
            dist = 0.0
        else:
            nga_match, dist = find_best_nga_match(lon, lat, enc_char, nga_lights)
            if not nga_match:
                continue
            name = nga_match['name'].title()  # convert UPPERCASE to Title Case
            source = f'NGA ({dist:.0f}m)'

        if args.dry_run:
            print(f'  WOULD NAME [{source}]: {name}  char={enc_char}  ({lat:.4f},{lon:.4f})')
            if source.startswith('NGA'):
                matched_nga += 1
            else:
                matched_override += 1
            continue

        # Patch navaid feature
        feat['properties']['name'] = name
        feat['properties']['name_lower'] = name.lower()
        if source.startswith('NGA'):
            matched_nga += 1
        else:
            matched_override += 1
        print(f'  Named [{source}]: {name}  ({lat:.4f},{lon:.4f})')

        # Add to named_places_raw so bearing queries resolve by name
        name_lower = name.lower()
        if name_lower not in new_place_names:
            new_place_names.add(name_lower)
            places_fc['features'].append({
                'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
                'properties': {
                    'objtype': 'LIGHTS',
                    'label':   'light',
                    'name':    name,
                    'name_lower': name_lower,
                },
            })

    print(f'\nResults: {matched_nga} from NGA, {matched_override} from overrides')

    if args.dry_run:
        print('Dry run — no files written.')
        return

    if matched_nga + matched_override > 0:
        save_geojson(navaid_fc, navaid_path)
        save_geojson(places_fc, places_path)
        print(f'Updated {navaid_path}')
        print(f'Updated {places_path}')
    else:
        print('No changes — files unchanged.')

    print('\nDone. Run merge_charts.py next.')


if __name__ == '__main__':
    main()
