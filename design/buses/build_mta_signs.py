# What a New York bus's destination sign says (v1195, asked: "show each bus's real route on its sign"): from the MTA's
# static GTFS for the five boroughs' NYCT buses and the MTA Bus Company's, each route's usual headsign each way.
# Bus Time's live feed gives a bus's route and direction (0/1), not her headsign; the short-turn trips (about 1 in 15,
# e.g. an M5 to Broadway-135 St) would need their trip ids, 870 KB, so they show the route's usual sign.
#
#   python3 build_mta_signs.py <dir to download the zips into>
#
# writes ../../www/data/buses/mta-signs.json: { credit, signs: { route: [direction 0's sign, direction 1's], ... } }
import collections, csv, io, json, os, sys, urllib.request, zipfile
D = sys.argv[1] if len(sys.argv) > 1 else '.'
FEEDS = {f'nyct_{b}': f'http://web.mta.info/developers/data/nyct/bus/google_transit_{b}.zip' for b in ['manhattan', 'bronx', 'brooklyn', 'queens', 'staten_island']}
FEEDS['bus_company'] = 'http://web.mta.info/developers/data/busco/google_transit.zip'
cnt = collections.defaultdict(collections.Counter)
for name, url in FEEDS.items():
    p = os.path.join(D, name + '.zip')
    if not os.path.exists(p): urllib.request.urlretrieve(url, p)
    with zipfile.ZipFile(p) as Z:
        for r in csv.DictReader(io.TextIOWrapper(Z.open('trips.txt'), 'utf-8-sig')):
            cnt[r['route_id']][(r['direction_id'], r['trip_headsign'].strip())] += 1
signs = {}
for route, c in sorted(cnt.items()):
    pair = ['', '']
    for d in ('0', '1'):
        best = max(((n, h) for (dd, h), n in c.items() if dd == d), default=(0, ''))
        pair[int(d)] = best[1]
    signs[route] = pair
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'www', 'data', 'buses', 'mta-signs.json')
json.dump({'credit': 'Bus destinations: MTA static GTFS', 'signs': signs}, open(out, 'w'), separators=(',', ':'))
print(len(signs), 'routes ->', out, os.path.getsize(out), 'bytes')
