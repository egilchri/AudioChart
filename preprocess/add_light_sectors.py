#!/usr/bin/env python3
"""Add sector data to a region's lights (v918).

The merge keeps one LIGHTS feature per position, so a sector light like Browns
Head (fixed white, with red sectors 1-50 and 61-91 degrees) came through as
whichever record won the merge, here "F R", and the 3D views showed it red from
every direction. This reads the region's ENC cells again and, for each light in
navaid.geojson, adds

    "sectors": [{"c": "red", "a": 1.0, "b": 50.0, "r": 11.0}, ...]

a, b: true bearings FROM SEAWARD (looking at the light from the boat), clockwise
from a to b, as S-57 SECTR1/SECTR2; r: nominal range, nm. When the light also has
an all-round entry (the "main" light, usually white), that one becomes the
feature's characteristic and colour, shown wherever no sector covers. Without
one ("sector_only": true), the light shows only inside its sectors. Emergency lights (CATLIT 17) are
skipped.

Re-runnable: it replaces any sectors it wrote before. It writes the file back in
the same compact one-line form it reads (checked byte for byte before writing).

    python3 preprocess/add_light_sectors.py \
        --chart-dir ~/Documents/Charts/ENC/penobscot_bay_only \
        www/data/regions/penobscot-bay/navaid.geojson

Regenerate data-version.json afterwards, or cached browsers never see it.
"""
import argparse, glob, json, math, os, sys

import fiona

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s57_to_geojson import build_light_characteristic  # noqa: E402
from s57_codes import COLOUR_LABEL  # noqa: E402


def colours(props):
    c = props.get('COLOUR') or []
    return [COLOUR_LABEL.get(int(x), str(x)) for x in (c if isinstance(c, list) else [c])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chart-dir', required=True)
    ap.add_argument('navaid', nargs='+')
    args = ap.parse_args()

    raw = []   # (lon, lat, props)
    for p in sorted(glob.glob(os.path.join(os.path.expanduser(args.chart_dir), '**', '*.000'), recursive=True)):
        try:
            if 'LIGHTS' not in fiona.listlayers(p):
                continue
        except Exception:
            continue
        with fiona.open(p, layer='LIGHTS') as src:
            for f in src:
                g = f.get('geometry')
                if g:
                    raw.append((g['coordinates'][0], g['coordinates'][1], dict(f['properties'])))
    print(f'{len(raw)} raw LIGHTS records')

    for path in args.navaid:
        text = open(path).read()
        gj = json.loads(text)
        ascii_ = next((a for a in (True, False) if json.dumps(gj, separators=(',', ':'), ensure_ascii=a) == text.rstrip('\n')), None)
        if ascii_ is None:
            sys.exit(f'{path}: not in compact one-line form; refusing to rewrite it')
        # unnamed lights named in light_name_overrides.json (within 60 m) get their name here too
        overrides = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'light_name_overrides.json')))
        n = 0
        for feat in gj['features']:
            pr = feat['properties']
            if pr.get('objtype') != 'LIGHTS':
                continue
            pr.pop('sectors', None); pr.pop('sector_only', None)
            lon, lat = feat['geometry']['coordinates'][:2]
            k = math.cos(math.radians(lat))
            if not pr.get('name'):
                for o in overrides:
                    if math.hypot((o['lon'] - lon) * 111320 * k, (o['lat'] - lat) * 111320) < 60:
                        pr['name'] = o['name']; pr['name_lower'] = o['name'].lower()
            here = [r for r in raw if math.hypot((r[0] - lon) * 111320 * k, (r[1] - lat) * 111320) < 10
                    and 17 not in [int(c) for c in (r[2].get('CATLIT') or [])]]
            sect, mains, keys = [], [], set()
            for _, _, rp in here:
                if rp.get('SECTR1') is not None and rp.get('SECTR2') is not None:
                    key = (tuple(colours(rp)), rp['SECTR1'], rp['SECTR2'])
                    if key in keys:
                        continue
                    keys.add(key)
                    sect.append({'c': '/'.join(colours(rp)), 'a': float(rp['SECTR1']), 'b': float(rp['SECTR2']), 'r': rp.get('VALNMR')})
                else:
                    mains.append(rp)
            if not sect:
                continue
            sect.sort(key=lambda s: s['a'])
            pr['sectors'] = sect
            if not mains:
                pr['sector_only'] = True   # dark outside its sectors
            if mains:   # the all-round light is the one to name it by
                m = max(mains, key=lambda rp: rp.get('VALNMR') or 0)
                pr['characteristic'] = build_light_characteristic(m) or pr.get('characteristic')
                pr['colour'] = '/'.join(colours(m)) or pr.get('colour')
                pr['range_nm'] = m.get('VALNMR') or pr.get('range_nm')
            n += 1
            print(f'  {pr.get("name") or "(unnamed)"} {lat:.4f},{lon:.4f}: {pr.get("characteristic")}; ' +
                  ', '.join(f'{s["c"]} {s["a"]:g}-{s["b"]:g}' for s in sect))
        with open(path, 'w') as f:
            f.write(json.dumps(gj, separators=(',', ':'), ensure_ascii=ascii_) + ('\n' if text.endswith('\n') else ''))
        print(f'{path}: {n} lights with sectors')


if __name__ == '__main__':
    main()
