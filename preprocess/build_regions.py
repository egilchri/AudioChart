#!/usr/bin/env python3
"""
Build pre-computed regional GeoJSON files from charts.db for static hosting.

Run from the project root:
    python3 preprocess/build_regions.py                  # rebuild every region in regions.yaml
    python3 preprocess/build_regions.py --region <id>     # rebuild just one (must be in regions.yaml)
    python3 preprocess/build_regions.py --region <id> --bbox minlat,maxlat,minlon,maxlon --name "Display Name"
                                                            # define a NEW region inline (no regions.yaml edit needed) —
                                                            # used by build_region.py's orchestrator

Outputs:
    www/data/regions/<id>.json  (one per region)

Region definitions live in preprocess/regions.yaml (previously a hardcoded
dict here). Does NOT touch the bundled top-level www/data/hazards.geojson
etc. — those are owned by merge_charts.py (the default/bundled region), and
having two pipelines write the same files was a real footgun (this script
used to silently overwrite merge_charts.py's richer polygon-based hazards
with Penobscot Bay's point-only subset on every bare run).

Run this whenever ENC charts are updated, then commit and push.
GitHub Actions deploys automatically to GitHub Pages.
"""
import argparse
import datetime
import json
import math
import os
import sqlite3
import sys

import yaml

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(SCRIPT_DIR, '../server/charts.db')
OUT_DIR = os.path.join(SCRIPT_DIR, '../www/data/regions')
REGIONS_CONFIG = os.path.join(SCRIPT_DIR, 'regions.yaml')


def load_regions():
    if not os.path.exists(REGIONS_CONFIG):
        return {}
    with open(REGIONS_CONFIG) as f:
        return yaml.safe_load(f) or {}


def build_region(db, region_id, cfg):
    lat_min, lat_max = cfg['lat_min'], cfg['lat_max']
    lon_min, lon_max = cfg['lon_min'], cfg['lon_max']

    rows = db.execute('''
        SELECT category, objtype, label, lat, lon, name, props
        FROM features
        WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
    ''', (lat_min, lat_max, lon_min, lon_max)).fetchall()

    hazards, places, navaids, restrictions = [], [], [], []
    for cat, objtype, label, flat, flon, name, props_json in rows:
        props = json.loads(props_json) if props_json else {}
        props.update({'objtype': objtype, 'label': label})
        if name:
            props['name'] = name
            props['name_lower'] = name.lower()
        feat = {
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [flon, flat]},
            'properties': props,
        }
        if cat == 'hazard':
            hazards.append(feat)
        elif cat == 'place':
            places.append(feat)
        elif cat == 'restriction':
            restrictions.append(feat)
        else:
            navaids.append(feat)

    # Average MAGVAR across the region with annual correction
    mv_rows = db.execute('''
        SELECT valmag, valacm, ryrmgv FROM magvar
        WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
    ''', (lat_min, lat_max, lon_min, lon_max)).fetchall()

    magvar_val = None
    if mv_rows:
        current_year = datetime.datetime.now().year
        vals = []
        for valmag, valacm, ryrmgv in mv_rows:
            ref_year = int(ryrmgv) if ryrmgv and str(ryrmgv).isdigit() else current_year
            annual_deg = (float(valacm) / 60.0) if valacm else 0
            vals.append(valmag + annual_deg * (current_year - ref_year))
        magvar_val = round(sum(vals) / len(vals), 1)

    count = len(hazards) + len(places) + len(navaids) + len(restrictions)
    print(f'  {cfg["name"]}: {len(hazards)} hazards, {len(places)} places, '
          f'{len(navaids)} navaids, {len(restrictions)} restrictions, '
          f'magvar={magvar_val}°  ({count} total)')

    return {
        'region':       cfg['name'],
        'magvar':       magvar_val,
        'hazards':      {'type': 'FeatureCollection', 'features': hazards},
        'places':       {'type': 'FeatureCollection', 'features': places},
        'navaids':      {'type': 'FeatureCollection', 'features': navaids},
        'restrictions': {'type': 'FeatureCollection', 'features': restrictions},
        'count':        count,
    }


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    size_kb = os.path.getsize(path) / 1024
    print(f'  → {os.path.relpath(path)} ({size_kb:.0f} KB)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--region', default=None,
                     help='Build just this region (default: build every region in regions.yaml)')
    ap.add_argument('--bbox', default=None,
                     help='minlat,maxlat,minlon,maxlon — define --region inline instead of '
                          'requiring it to already be in regions.yaml (used by build_region.py)')
    ap.add_argument('--name', default=None, help='Display name, paired with --bbox')
    args = ap.parse_args()

    if not os.path.exists(DB_PATH):
        print(f'ERROR: charts.db not found at {DB_PATH}')
        print('Run server/chartdb.py (or the server once) first to process ENC charts.')
        sys.exit(1)

    regions = load_regions()
    if args.region and args.bbox:
        lat_min, lat_max, lon_min, lon_max = (float(x) for x in args.bbox.split(','))
        targets = {args.region: {
            'name': args.name or args.region,
            'lat_min': lat_min, 'lat_max': lat_max, 'lon_min': lon_min, 'lon_max': lon_max,
        }}
    elif args.region:
        if args.region not in regions:
            print(f'ERROR: region "{args.region}" not in {REGIONS_CONFIG} — pass --bbox to define it inline')
            sys.exit(1)
        targets = {args.region: regions[args.region]}
    else:
        targets = regions

    if not targets:
        print(f'ERROR: no regions to build (nothing in {REGIONS_CONFIG}, no --region given)')
        sys.exit(1)

    db = sqlite3.connect(DB_PATH)

    print('Building regional data files...')
    for region_id, cfg in targets.items():
        print(f'\n[{region_id}]')
        data = build_region(db, region_id, cfg)
        out_path = os.path.join(OUT_DIR, f'{region_id}.json')
        write_json(out_path, data)

    db.close()
    print('\nDone. Commit www/data/regions/ and push to deploy.')


if __name__ == '__main__':
    main()
