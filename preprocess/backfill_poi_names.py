#!/usr/bin/env python3
"""
PROTOTYPE — augment named_places.geojson with maritime-relevant points of
interest from OpenStreetMap that NOAA charts simply don't include: sailing/
maritime schools and academies, marinas, yacht clubs, boatbuilders. NOAA
ENC data only charts navigational features (settlements, harbors,
anchorages, land regions) — it was never going to have "WoodenBoat School"
or "Maine Maritime Academy" by name, no matter how the chart-parsing code
is tuned. This is a different data source, not a bigger hammer for the
existing one.

Reuses the exact OSM/Overpass approach already proven in
backfill_light_names.py (free, no API key) — this is the SAME technique
applied to a different tag set, merged into named_places.geojson instead of
navaid.geojson, tagged with source: 'osm_poi' so it's trivially
distinguishable from NOAA-derived entries later.

Filtering strategy (this is the part a real, non-prototype version would
need to tune against actual results, not just trust blindly):
  - "Strong" tags — leisure=marina, craft=boatbuilder, club=yacht — are
    already maritime-specific by construction. Any named one is kept.
  - "Weak" tags — amenity=school/college/university — are NOT maritime-
    specific (every ordinary elementary school in the bbox has one of
    these) and only kept if the name itself contains a maritime keyword
    (boat, marine, maritime, sail, yacht, naval, nautical, mariner).
This is a real, working filter, not a placeholder — but it's a
name-keyword heuristic, not a guarantee; run --dry-run and read the output
before trusting a new region's results.

Once merged, these resolve through the exact same Query.findPlaceByName
path every NOAA-derived named place already uses (www/js/query.js), water-
snap included — no new lookup code needed.

Usage:
    python3 backfill_poi_names.py --region penobscot-bay --bbox 43.8,44.8,-69.6,-68.0 [--dry-run]
"""

import argparse
import json
import os
import re
import sys
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '..', 'www', 'data'))

OVERPASS_URL = 'https://lz4.overpass-api.de/api/interpreter'

MARITIME_KEYWORDS = ['boat', 'marine', 'maritime', 'sail', 'yacht', 'naval', 'nautical', 'mariner']

# tag -> label used in the merged named_places feature
STRONG_TAGS = {
    ('leisure', 'marina'): 'marina',
    ('craft', 'boatbuilder'): 'boatbuilder',
    ('club', 'yacht'): 'yacht club',
}
WEAK_TAGS = {
    ('amenity', 'school'): 'school',
    ('amenity', 'college'): 'college',
    ('amenity', 'university'): 'university',
}

OSM_QUERY = """
[out:json][timeout:25];
(
  node["leisure"="marina"]({s},{w},{n},{e});
  way["leisure"="marina"]({s},{w},{n},{e});
  node["craft"="boatbuilder"]({s},{w},{n},{e});
  way["craft"="boatbuilder"]({s},{w},{n},{e});
  node["club"="yacht"]({s},{w},{n},{e});
  way["club"="yacht"]({s},{w},{n},{e});
  node["amenity"~"^(school|college|university)$"]({s},{w},{n},{e});
  way["amenity"~"^(school|college|university)$"]({s},{w},{n},{e});
);
out center;
"""


def fetch_osm(minlat, minlon, maxlat, maxlon):
    query = OSM_QUERY.format(s=minlat, w=minlon, n=maxlat, e=maxlon)
    print(f'Fetching OSM POI data from Overpass ({minlat:.2f},{minlon:.2f} -> {maxlat:.2f},{maxlon:.2f})...')
    req = urllib.request.Request(
        OVERPASS_URL,
        data=query.encode('utf-8'),
        headers={'Content-Type': 'application/x-www-form-urlencoded',
                 'User-Agent': 'AudioChart-poi-backfill/1.0 (prototype)'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            result = json.loads(resp.read())
    except Exception as e:
        print(f'ERROR fetching OSM data: {e}')
        sys.exit(1)
    elements = result.get('elements', [])
    print(f'  OSM returned {len(elements)} raw elements')
    return elements


def _tag_match(tags):
    """Return (category_label, is_strong) for the first matching tag, or (None, None)."""
    for (k, v), label in STRONG_TAGS.items():
        if tags.get(k) == v:
            return label, True
    for (k, v), label in WEAK_TAGS.items():
        if tags.get(k) == v:
            return label, False
    return None, None


def _has_maritime_keyword(name):
    lower = name.lower()
    return any(kw in lower for kw in MARITIME_KEYWORDS)


def parse_osm_elements(elements):
    """OSM elements -> [{lat, lon, name, label}], deduped, weak-tag entries
    filtered to maritime-keyword names only."""
    pois = []
    seen = set()
    dropped_weak = 0
    for e in elements:
        tags = e.get('tags', {})
        name = (tags.get('name') or '').strip()
        if not name:
            continue
        label, is_strong = _tag_match(tags)
        if label is None:
            continue
        if not is_strong and not _has_maritime_keyword(name):
            dropped_weak += 1
            continue

        if e['type'] == 'node':
            lat, lon = e.get('lat'), e.get('lon')
        else:
            center = e.get('center') or {}
            lat, lon = center.get('lat'), center.get('lon')
        if lat is None or lon is None:
            continue

        key = (round(lat, 4), round(lon, 4))
        if key in seen:
            continue
        seen.add(key)
        pois.append({'lat': lat, 'lon': lon, 'name': name, 'label': label})

    print(f'  {len(pois)} maritime POI(s) kept after filtering '
          f'({dropped_weak} non-maritime school/college/university dropped)')
    return pois


def load_geojson(path):
    if not os.path.exists(path):
        return {'type': 'FeatureCollection', 'features': []}
    with open(path) as f:
        return json.load(f)


def save_geojson(fc, path):
    with open(path, 'w') as f:
        json.dump(fc, f, separators=(',', ':'))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--region', required=True,
                     help='Region key — e.g. penobscot-bay. Used to label output and, unless '
                          '--places overrides it, to locate www/data/regions/<region>/named_places.geojson')
    ap.add_argument('--bbox', required=True, help='minlat,maxlat,minlon,maxlon')
    ap.add_argument('--places', default=None,
                     help='Explicit named_places.geojson path — use this to target the bundled '
                          'default (../www/data/named_places.geojson) instead of a regions/<id>/ subdir')
    ap.add_argument('--dry-run', action='store_true', help='Print matches without writing files')
    args = ap.parse_args()

    minlat, maxlat, minlon, maxlon = (float(x) for x in args.bbox.split(','))

    places_path = args.places or os.path.join(DATA_DIR, 'regions', args.region, 'named_places.geojson')
    places_fc = load_geojson(places_path)
    existing_names = {f['properties'].get('name_lower', '') for f in places_fc['features']}
    print(f'Loaded {len(places_fc["features"])} existing named places from {places_path}')

    elements = fetch_osm(minlat, minlon, maxlat, maxlon)
    pois = parse_osm_elements(elements)

    added = 0
    for p in pois:
        name_lower = p['name'].lower()
        marker = 'NEW' if name_lower not in existing_names else 'skip (name exists)'
        print(f'  [{p["label"]:>10}] {p["name"]} ({p["lat"]:.4f},{p["lon"]:.4f}) — {marker}')
        if name_lower in existing_names:
            continue
        existing_names.add(name_lower)
        if not args.dry_run:
            places_fc['features'].append({
                'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [p['lon'], p['lat']]},
                'properties': {
                    'objtype': 'OSMPOI',
                    'label': p['label'],
                    'name': p['name'],
                    'name_lower': name_lower,
                    'source': 'osm_poi',
                },
            })
        added += 1

    print(f'\n{added} new POI(s) {"would be" if args.dry_run else ""} added')

    if args.dry_run:
        print('Dry run — no files written. Re-run build_channel_graph.py/refresh_data_version '
              'afterward if you do apply this, so the IndexedDB cache picks it up (see '
              'project_buoy_chain_channels memory on why that step matters).')
        return

    if added > 0:
        save_geojson(places_fc, places_path)
        print(f'Updated {places_path}')
    else:
        print('No changes — file unchanged.')


if __name__ == '__main__':
    main()
