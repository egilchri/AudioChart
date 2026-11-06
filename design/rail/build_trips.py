#!/usr/bin/env python3
"""Each train's run, from the railroads' published GTFS timetables (v1117, requested: "For the trains I need to know
their destination, their origin, and the ETA"). 511's live positions name a train by its trip (Caltrain's train number;
SMART's GTFS trip_id), so this writes, per railroad and trip, {n: the train's number, s: its stops in order, [name, lon, lat, minutes after midnight]}.

    python3 design/rail/build_trips.py <dir with smart.zip and caltrain.zip> > www/data/rail/sf-bay-trips.json

The zips: https://data.trilliumtransit.com/gtfs/smart-ca-us/smart-ca-us.zip and
https://data.trilliumtransit.com/gtfs/caltrain-ca-us/caltrain-ca-us.zip. Rebuild when either railroad's timetable changes.
"""
import csv, io, json, re, sys, zipfile

def rows(z, name):
    return list(csv.DictReader(io.TextIOWrapper(z.open(name), encoding='utf-8-sig')))

def short(n):   # "San Francisco Caltrain Station" -> "San Francisco"; "SMART Santa Rosa Downtown" -> "Santa Rosa Downtown"
    n = re.sub(r'\s+(Caltrain\s+)?Station\b.*$', '', n, flags=re.I)
    return re.sub(r'^SMART\s+', '', n).strip()

def build(path, key):
    z = zipfile.ZipFile(path)
    stops = {s['stop_id']: s for s in rows(z, 'stops.txt')}
    def place(sid):   # a platform's parent station, for its name
        s = stops[sid]
        return stops.get(s.get('parent_station') or '', s)
    trips = {t['trip_id']: t for t in rows(z, 'trips.txt')}
    runs = {}
    for st in rows(z, 'stop_times.txt'):
        t = st['arrival_time'] or st['departure_time']
        if not t: continue
        h, m, s = map(int, t.split(':'))
        runs.setdefault(st['trip_id'], []).append((int(st['stop_sequence']), st['stop_id'], h * 60 + m + s / 60))
    out = {}
    for tid, seq in runs.items():
        seq.sort()
        k = trips[tid]['trip_short_name'] if key == 'short' else tid
        n = re.sub(r'^Trip\s+', '', trips[tid]['trip_short_name'] or '')
        out[k] = {'n': n, 's': [[short(place(sid)['stop_name']), round(float(place(sid)['stop_lon']), 5), round(float(place(sid)['stop_lat']), 5), round(mins, 1)] for _, sid, mins in seq]}
    return out

d = sys.argv[1]
json.dump({'credit': 'Timetables: SMART and Caltrain GTFS (Trillium)', 'SMART': build(f'{d}/smart.zip', 'id'), 'Caltrain': build(f'{d}/caltrain.zip', 'short')}, sys.stdout, separators=(',', ':'))
