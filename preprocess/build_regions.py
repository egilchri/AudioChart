#!/usr/bin/env python3
"""
Build pre-computed regional GeoJSON files from charts.db for static hosting.

Run from the project root:
    python3 preprocess/build_regions.py

Outputs:
    www/data/regions/penobscot-bay.json
    www/data/regions/casco-bay.json

Also refreshes the bundled fallback static files:
    www/data/hazards.geojson
    www/data/named_places.geojson
    www/data/navaid.geojson
(These default to Penobscot Bay so the app works out of the box.)

Run this whenever ENC charts are updated, then commit and push.
GitHub Actions deploys automatically to GitHub Pages.
"""
import datetime
import json
import math
import os
import sqlite3
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(SCRIPT_DIR, '../server/charts.db')
OUT_DIR = os.path.join(SCRIPT_DIR, '../www/data/regions')
STATIC_DIR = os.path.join(SCRIPT_DIR, '../www/data')

REGIONS = {
    'penobscot-bay': {
        'name':    'Penobscot Bay',
        'lat_min': 43.8, 'lat_max': 44.8,
        'lon_min': -69.6, 'lon_max': -68.0,
    },
    'casco-bay': {
        'name':    'Casco Bay',
        'lat_min': 43.5, 'lat_max': 44.1,
        'lon_min': -70.6, 'lon_max': -69.7,
    },
}


def build_region(db, region_id, cfg):
    lat_min, lat_max = cfg['lat_min'], cfg['lat_max']
    lon_min, lon_max = cfg['lon_min'], cfg['lon_max']

    rows = db.execute('''
        SELECT category, objtype, label, lat, lon, name, props
        FROM features
        WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
    ''', (lat_min, lat_max, lon_min, lon_max)).fetchall()

    hazards, places, navaids = [], [], []
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

    count = len(hazards) + len(places) + len(navaids)
    print(f'  {cfg["name"]}: {len(hazards)} hazards, {len(places)} places, '
          f'{len(navaids)} navaids, magvar={magvar_val}°  ({count} total)')

    return {
        'region':  cfg['name'],
        'magvar':  magvar_val,
        'hazards': {'type': 'FeatureCollection', 'features': hazards},
        'places':  {'type': 'FeatureCollection', 'features': places},
        'navaids': {'type': 'FeatureCollection', 'features': navaids},
        'count':   count,
    }


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    size_kb = os.path.getsize(path) / 1024
    print(f'  → {os.path.relpath(path)} ({size_kb:.0f} KB)')


def main():
    if not os.path.exists(DB_PATH):
        print(f'ERROR: charts.db not found at {DB_PATH}')
        print('Run the server once first to process ENC charts.')
        sys.exit(1)

    db = sqlite3.connect(DB_PATH)

    print('Building regional data files...')
    built = {}
    for region_id, cfg in REGIONS.items():
        print(f'\n[{region_id}]')
        data = build_region(db, region_id, cfg)
        out_path = os.path.join(OUT_DIR, f'{region_id}.json')
        write_json(out_path, data)
        built[region_id] = data

    # Refresh bundled fallback static files from Penobscot Bay
    print('\nUpdating bundled static fallback files (Penobscot Bay)...')
    pb = built['penobscot-bay']
    write_json(os.path.join(STATIC_DIR, 'hazards.geojson'),      pb['hazards'])
    write_json(os.path.join(STATIC_DIR, 'named_places.geojson'), pb['places'])
    write_json(os.path.join(STATIC_DIR, 'navaid.geojson'),       pb['navaids'])

    db.close()
    print('\nDone. Commit www/data/ and push to deploy.')


if __name__ == '__main__':
    main()
