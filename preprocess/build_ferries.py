#!/usr/bin/env python3
"""Build www/data/ferries.json (v934): the ferries the 3D views show, on their OpenStreetMap tracks.

    python3 preprocess/build_ferries.py

Each ferry's line runs from its `from` end to its `to` end through its `stops` (name, lon, lat), and
`service` says when it runs in a view with a clock (Bird's-eye): from `start` to `end`, the first boat
leaving the `first` end, a few minutes at each landing. These are approximations from the published trip
counts and terminal hours, not the timetables.

Sources (checked 2026-10-18):
- Tracks: OpenStreetMap contributors (ODbL), ways listed per ferry below, via the Overpass API.
- Maine State Ferry Service: vessels and lengths from its 2024 listing (Thompson 154 ft, Burgess 130 ft,
  Margaret Chase Smith 166 ft, Captain Henry Lee 130 ft); Islesboro 3 mi, ~20 min, 9 round trips a day,
  terminal 07:00-16:30; Swan's Island 6 mi, 40 min (the Henry Lee also runs to Frenchboro, left out here).
- Beal & Bunker (the mail boat Double B): year round, Northeast Harbor to Islesford, Great Cranberry and
  Sutton; six trips a day in summer from 07:30 to 18:45, four in spring and fall 08:15-17:15 (MaineDOT
  2019 locally coordinated plan, Cranberry Isles appendix). OSM has no Beal & Bunker way: its line here is
  OSM's Northeast Harbor-Great Cranberry commuter track and the Great Cranberry-Islesford track, and the
  order of the stops is assumed. Sutton Island (summer homes only; served on request, Cruising Club guide)
  is taken as a summer stop: in the summer hours her `summer_line` turns in to the town float on Sutton's
  south shore (OSM way 1316039157, at the end of Dock Path, with a ferry shelter), with our own approach
  around the island's west end.
- Cranberry Cove Ferry (Downeast Windjammer): Southwest Harbor, Manset, Great Cranberry, Islesford, late May
  to October, five trips a day 07:15-17:15 in summer (downeastwindjammer.com). Season end taken as 15 Oct.
"""
import json, os, sys, time, urllib.parse, urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'www', 'data', 'ferries.json')
WAYS = [11490267, 11425830, 11428675, 731120557, 11432849, 11426785, 220345351, 220345355]


def overpass(ids):
    q = f'[out:json][timeout:60];way(id:{",".join(map(str, ids))});out geom tags;'
    for attempt in range(6):
        for host in ('overpass-api.de/api/interpreter', 'overpass.kumi.systems/api/interpreter', 'overpass.private.coffee/api/interpreter'):
            try:
                req = urllib.request.Request(f'https://{host}', data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': 'AudioChart/1.0 (egilchri.github.io)'})
                with urllib.request.urlopen(req, timeout=90) as r:
                    return {e['id']: [[round(p['lon'], 6), round(p['lat'], 6)] for p in e['geometry']] for e in json.load(r)['elements']}
            except Exception as err:
                print(f'  {host}: {err}', file=sys.stderr)
        time.sleep(15 * (attempt + 1))
    sys.exit('Overpass unavailable')


def join(*parts):
    """Ways end to end (each already oriented), dropping the repeated joint."""
    line = []
    for p in parts:
        line += p[1:] if line and line[-1] == p[0] else p
    return line


# The Maine State ferries' slips (v943): the head of each slip (where the transfer bridge meets the car deck) and the
# bearing out of it to sea. From OpenStreetMap: Rockland's "Ramp 1" and "Ramp 2" (man_made=bridge, ways 896563317 and
# 896563318; which ferry uses which is assumed), the slip walls at Vinalhaven (ways 660609028/9) and North Haven
# (660608925/6) meeting at the terminal node; elsewhere the terminal node and the line's approach.
SLIPS = {"Rockland – North Haven": {"from": [-69.107897, 44.107703, 74], "to": [-68.873157, 44.126625, 215]}, "Rockland – Vinalhaven": {"from": [-69.107885, 44.107541, 91], "to": [-68.839459, 44.043099, 147]}, "Lincolnville – Islesboro": {"from": [-69.005659, 44.280496, 76], "to": [-68.94289, 44.280859, 202]}, "Bass Harbor – Swan's Island": {"from": [-68.348445, 44.234856, 277], "to": [-68.423436, 44.181293, 240]}}


SUTTON = [-68.2644, 44.27095]   # alongside the Sutton Island town float (OSM way 1316039157)


def via_sutton(line):
    """Northeast Harbor-Great Cranberry, turning in to Sutton's float: in round the island's west end, out
    to the south, back on the track below the island."""
    i = next(k for k, p in enumerate(line) if p[1] < 44.28)   # the track's first point south of Bear Island
    j = next(k for k, p in enumerate(line) if p[1] < 44.266)  # and where it rejoins, off Great Cranberry
    return line[:i] + [[-68.2735, 44.2738], [-68.2702, 44.2713], SUTTON, [-68.2675, 44.2695], [-68.2688, 44.2672]] + line[j:]


def main():
    w = overpass(WAYS)
    rev = lambda p: list(reversed(p))
    old = {f['name']: f for f in json.load(open(OUT))['ferries']}
    ferries = [
        old['Rockland – Vinalhaven'] | {'service': {'start': '06:00', 'end': '19:00', 'first': 'to'}},
        old['Rockland – North Haven'] | {'service': {'start': '06:00', 'end': '19:00', 'first': 'to'}},
        {'name': 'Lincolnville – Islesboro', 'from': 'Lincolnville', 'to': 'Islesboro', 'knots': 9.5,
         'vessel': 'MARGARET CHASE SMITH', 'length_m': 50.6, 'osm': [11490267], 'line': w[11490267],
         'service': {'start': '07:30', 'end': '16:45', 'first': 'to'}},
        {'name': 'Bass Harbor – Swan\'s Island', 'from': 'Bass Harbor', 'to': 'Swan\'s Island', 'knots': 9.5,
         'vessel': 'CAPT. HENRY LEE', 'length_m': 39.6, 'osm': [11425830], 'line': w[11425830],
         'service': {'start': '07:30', 'end': '17:30', 'first': 'to'}},
        {'name': 'Beal & Bunker mail boat', 'kind': 'launch', 'says': 'Mail boat', 'from': 'Northeast Harbor', 'to': 'Islesford',
         'knots': 10, 'vessel': 'DOUBLE B', 'length_m': 15, 'osm': [11426785, 11432849],
         'line': join(rev(w[11426785]), rev(w[11432849])),
         'summer_line': join(via_sutton(rev(w[11426785])), rev(w[11432849])),
         'stops': [{'name': 'Sutton Island', 'lon': SUTTON[0], 'lat': SUTTON[1], 'summer': True},
                   {'name': 'Great Cranberry', 'lon': w[11432849][-1][0], 'lat': w[11432849][-1][1]}],
         'service': {'start': '08:15', 'end': '17:15', 'first': 'from', 'summer': ['06-15', '09-10', '07:30', '18:45']}},
        {'name': 'Cranberry Cove Ferry', 'kind': 'launch', 'says': 'Ferry', 'from': 'Southwest Harbor', 'to': 'Islesford',
         'knots': 10, 'vessel': 'CRANBERRY COVE', 'length_m': 14, 'osm': [11428675, 731120557, 11432849],
         'line': join(w[11428675], w[731120557], rev(w[11432849])),
         'stops': [{'name': 'Manset', 'lon': w[11428675][-1][0], 'lat': w[11428675][-1][1]},
                   {'name': 'Great Cranberry', 'lon': w[731120557][-1][0], 'lat': w[731120557][-1][1]}],
         'service': {'start': '07:15', 'end': '17:15', 'first': 'from', 'season': ['05-25', '10-15']}},
    ]
    for f in ferries:
        if f['name'] in SLIPS: f['slips'] = {k: {'lon': v[0], 'lat': v[1], 'brg': v[2]} for k, v in SLIPS[f['name']].items()}
        print(f"{f['name']}: {len(f['line'])} points, {f['line'][0]} -> {f['line'][-1]}")
    out = {
        'source': 'OpenStreetMap contributors (ODbL), ways ' + ', '.join(map(str, WAYS)) + ', fetched ' + time.strftime('%Y-%m-%d') + '; see preprocess/build_ferries.py for the services',
        'vessels_note': 'Maine State Ferry Service vessels and lengths from its 2024 listing (Thompson 154 ft, Burgess 130 ft, Margaret Chase Smith 166 ft, Captain Henry Lee 130 ft). Look (red hull, black boot-top, white sides and houses) from Commons photos of the MSFS fleet. The Cranberry boats are small passenger launches; their lengths are estimates.',
        'ferries': ferries,
    }
    json.dump(out, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    open(OUT, 'a').write('\n')


if __name__ == '__main__':
    main()
