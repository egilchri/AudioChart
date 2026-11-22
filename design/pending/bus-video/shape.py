# (v1201) a bus's route on the street, for the recording to carry her along it (record.mjs): her trip's shape from the
# MTA's static GTFS (the trip ids in Bus Time's feed are the timetable's), else her route's longest shape that way.
#   python3 shape.py <gtfs dir: nyct_manhattan.zip etc.> <trip id> <route> <direction 0|1>   → [[lon, lat], ...] on stdout
import csv, io, json, sys, zipfile, glob
D, trip, route, d = sys.argv[1:5]
for z in sorted(glob.glob(D + '/*.zip')):
    with zipfile.ZipFile(z) as Z:
        trips = list(csv.DictReader(io.TextIOWrapper(Z.open('trips.txt'), 'utf-8-sig')))
        mine = [t for t in trips if t['route_id'] == route]
        if not mine: continue
        sid = next((t['shape_id'] for t in mine if t['trip_id'] == trip), None)
        pts = {}
        for r in csv.DictReader(io.TextIOWrapper(Z.open('shapes.txt'), 'utf-8-sig')):
            pts.setdefault(r['shape_id'], []).append((int(r['shape_pt_sequence']), float(r['shape_pt_lon']), float(r['shape_pt_lat'])))
        if not sid:
            cands = {t['shape_id'] for t in mine if t['direction_id'] == d}
            sid = max(cands, key=lambda s: len(pts.get(s, [])))
        print(json.dumps([[lo, la] for _, lo, la in sorted(pts[sid])])); sys.exit(0)
sys.exit('no such route')
