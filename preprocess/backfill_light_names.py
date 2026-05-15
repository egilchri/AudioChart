#!/usr/bin/env python3
"""
Backfill proper names for unnamed lights in navaid_raw.geojson using two sources:

  1. OpenStreetMap via Overpass API — queries for lighthouses and named seamark
     lights within the chart bounding box.  OSM has excellent coverage of major
     named lights and is freely accessible without an API key.

  2. light_name_overrides.json — manual name patches that survive pipeline re-runs.
     Format: [{"lat": 44.104041, "lon": -69.0775453, "name": "Rockland Breakwater Light"}, ...]

Matching strategy:
  - Find the nearest OSM light within MATCH_RADIUS_M metres of each unnamed ENC light.
  - Characteristic matching is skipped because OSM and S-57 use incompatible formats.
  - A tighter radius (default 150 m) keeps false positives rare.

Run after s57_to_geojson.py and before merge_charts.py:
  python3 backfill_light_names.py [--dry-run] [--radius 150]
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

OVERPASS_URL   = 'https://lz4.overpass-api.de/api/interpreter'
MATCH_RADIUS_M = 150   # metres — tight enough to avoid false positives


# ── helpers ──────────────────────────────────────────────────────────────────

def haversine_m(lon1, lat1, lon2, lat2):
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


def load_geojson(path):
    with open(path) as f:
        return json.load(f)


def save_geojson(fc, path):
    with open(path, 'w') as f:
        json.dump(fc, f, separators=(',', ':'))


# ── OSM / Overpass fetch ──────────────────────────────────────────────────────

OSM_QUERY = """
[out:json];
(
  node["man_made"="lighthouse"]({s},{w},{n},{e});
  node["seamark:type"="light"]({s},{w},{n},{e});
  node["seamark:type"="light_major"]({s},{w},{n},{e});
  node["seamark:type"="landmark"]["man_made"="lighthouse"]({s},{w},{n},{e});
);
out body;
"""

def fetch_osm(minlat, minlon, maxlat, maxlon):
    query = OSM_QUERY.format(s=minlat, w=minlon, n=maxlat, e=maxlon)
    print(f'Fetching OSM data from Overpass ({minlat:.2f},{minlon:.2f} → {maxlat:.2f},{maxlon:.2f})...')
    data = query.encode('utf-8')
    req = urllib.request.Request(
        OVERPASS_URL,
        data=data,
        headers={'Content-Type': 'application/x-www-form-urlencoded',
                 'User-Agent': 'AudioChart-backfill/1.0'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
    except Exception as e:
        print(f'ERROR fetching OSM data: {e}')
        sys.exit(1)

    elements = result.get('elements', [])
    print(f'  OSM returned {len(elements)} raw elements')
    return elements


def parse_osm_elements(elements):
    """Extract (lat, lon, name) from OSM node elements. Skip unnamed nodes."""
    lights = []
    seen = set()
    for e in elements:
        tags = e.get('tags', {})
        name = (tags.get('name') or tags.get('seamark:name') or '').strip()
        if not name:
            continue
        lat = e.get('lat')
        lon = e.get('lon')
        if lat is None or lon is None:
            continue
        key = (round(lat, 4), round(lon, 4))
        if key in seen:
            continue
        seen.add(key)
        lights.append({'lat': lat, 'lon': lon, 'name': name})
    print(f'  {len(lights)} named lights after dedup')
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

def find_best_match(lon, lat, candidates, radius_m):
    """Return the nearest candidate within radius_m, or None."""
    best, best_dist = None, radius_m
    for c in candidates:
        d = haversine_m(lon, lat, c['lon'], c['lat'])
        if d < best_dist:
            best, best_dist = c, d
    return best, best_dist


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dry-run', action='store_true',
                    help='Print matches without writing files')
    ap.add_argument('--radius', type=float, default=MATCH_RADIUS_M,
                    help=f'Match radius in metres (default: {MATCH_RADIUS_M})')
    args = ap.parse_args()

    radius_m = args.radius

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

    # Bounding box from the navaid data
    minlat, minlon, maxlat, maxlon = bbox_from_navaids(navaids)

    # Fetch OSM data
    osm_elements = fetch_osm(minlat, minlon, maxlat, maxlon)
    osm_lights   = parse_osm_elements(osm_elements)

    # Load manual overrides
    overrides = load_overrides()
    override_map = {}
    for o in overrides:
        key = (round(o['lat'], 4), round(o['lon'], 4))
        override_map[key] = o['name']
    print(f'Manual overrides: {len(overrides)}')

    # Match and patch
    matched_osm = 0
    matched_override = 0
    existing_place_names = set(
        f['properties'].get('name_lower', '') for f in places_fc['features']
    )

    for feat in navaids:
        if feat['properties'].get('objtype') != 'LIGHTS':
            continue
        if feat['properties'].get('name'):
            continue

        lon, lat = feat['geometry']['coordinates']

        # Manual overrides take priority
        key = (round(lat, 4), round(lon, 4))
        if key in override_map:
            name   = override_map[key]
            source = 'override'
            dist   = 0.0
        else:
            osm_match, dist = find_best_match(lon, lat, osm_lights, radius_m)
            if not osm_match:
                continue
            name   = osm_match['name']
            source = f'OSM ({dist:.0f}m)'

        if args.dry_run:
            print(f'  WOULD NAME [{source}]: {name}  ({lat:.4f},{lon:.4f})')
        else:
            feat['properties']['name']       = name
            feat['properties']['name_lower'] = name.lower()
            print(f'  Named [{source}]: {name}  ({lat:.4f},{lon:.4f})')

            name_lower = name.lower()
            if name_lower not in existing_place_names:
                existing_place_names.add(name_lower)
                places_fc['features'].append({
                    'type': 'Feature',
                    'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
                    'properties': {
                        'objtype':    'LIGHTS',
                        'label':      'light',
                        'name':       name,
                        'name_lower': name_lower,
                    },
                })

        if source == 'override':
            matched_override += 1
        else:
            matched_osm += 1

    print(f'\nResults: {matched_osm} from OSM, {matched_override} from overrides')

    if args.dry_run:
        print('Dry run — no files written.')
        return

    if matched_osm + matched_override > 0:
        save_geojson(navaid_fc, navaid_path)
        save_geojson(places_fc, places_path)
        print(f'Updated {navaid_path}')
        print(f'Updated {places_path}')
    else:
        print('No changes — files unchanged.')

    print('\nDone. Run merge_charts.py next.')


if __name__ == '__main__':
    main()
