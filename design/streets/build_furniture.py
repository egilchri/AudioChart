# New York's bus stop shelters and newsstands (v1200, asked: "add newsstands and bus stop shelters to the sidewalks"):
# NYC Open Data's "Bus Stop Shelters" (t4f2-8md7, NYC DOT, 3,300) and "Newsstands" (w9zq-xm8b, licensed by Consumer and
# Worker Protection, 360): each one's place and the street it's on, for streets3d.js to stand on that street's sidewalk.
#
#   python3 build_furniture.py
#
# (v1200, asked: "add subway entrances to the sidewalks") and the subway's street entrances: data.ny.gov's "MTA Subway
# Entrances and Exits: 2024" (i9wp-a4ja), its stairs and street elevators, at the stations "MTA Subway Stations"
# (39hk-dx4f) has underground (structure Subway; an elevated station's stairs go up, and the els draw their own).
#
# writes ../../www/data/streets/furniture-new-york-harbor.json:
#   { credit, shelters: [[lon, lat, on street], ...], newsstands: [[lon, lat, on street], ...],
#     subway: [[lon, lat, 0 stair | 1 elevator, 1 if you can go in there, its routes], ...] }
import json, os, urllib.request
UA = {'User-Agent': 'AudioChart furniture build (github.com/egilchri/AudioChart)'}
get = lambda ds, dom='data.cityofnewyork.us': json.loads(urllib.request.urlopen(urllib.request.Request(f'https://{dom}/resource/{ds}.json?$limit=20000', headers=UA), timeout=120).read())
sh = [[round(float(r['longitude']), 6), round(float(r['latitude']), 6), r.get('on_street', '')] for r in get('t4f2-8md7') if r.get('longitude') and r.get('latitude')]
ns = [[round(float(r['longitude']), 6), round(float(r['latitude']), 6), r.get('street_on', '')] for r in get('w9zq-xm8b') if r.get('longitude') and r.get('latitude')]
under = {r['gtfs_stop_id'] for r in get('39hk-dx4f', 'data.ny.gov') if r.get('structure') == 'Subway'}
sub = [[round(float(r['entrance_longitude']), 6), round(float(r['entrance_latitude']), 6), 1 if r['entrance_type'] == 'Elevator' else 0, 1 if r.get('entry_allowed') == 'YES' else 0, r.get('daytime_routes', '')]
       for r in get('i9wp-a4ja', 'data.ny.gov') if r.get('gtfs_stop_id') in under and r.get('entrance_longitude') and (r['entrance_type'].startswith('Stair') or r['entrance_type'] == 'Elevator')]
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'www', 'data', 'streets', 'furniture-new-york-harbor.json')
json.dump({'credit': 'Bus shelters and newsstands: NYC Open Data (NYC DOT; Consumer and Worker Protection); subway entrances: MTA (data.ny.gov)', 'shelters': sh, 'newsstands': ns, 'subway': sub}, open(out, 'w'), separators=(',', ':'))
print(len(sh), 'shelters,', len(ns), 'newsstands,', len(sub), 'subway entrances ->', out, os.path.getsize(out), 'bytes')
