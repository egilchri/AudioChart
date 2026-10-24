#!/usr/bin/env python3
"""Add the Casco Bay Lines ferries to www/data/ferries.json (v993), run to their published timetables.

    python3 preprocess/build_cbl.py [--cache DIR]

Two lines, from OpenStreetMap (ODbL): Portland - Peaks Island (way 30770334), and the "down the bay" chain Portland -
Little Diamond - Great Diamond - Diamond Cove - Long Island - Chebeague (Chandler Cove) - Cliff Island (ways 30765707,
996909129, 996909128, 996909127, 996909126, 996909125), its landings OSM's ferry terminals.

The times are Casco Bay Lines' own (cascobaylines.com/schedules/<island>-schedule/<season>/): for each island and
season, a table per group of days of the boats leaving Portland for it and the boats leaving it. The island pages
list each island's own departures, not the boats' runs, so the runs are put back together here:
- Peaks: each boat leaving Portland comes back on the first Peaks departure after she gets there.
- Down the bay: the boats leaving Portland at the same time for several islands are one boat calling at each of
  them in turn, out to the farthest; she leaves that one at its first listed time after she gets there, and comes
  home calling at each island that lists a departure about when she passes. An island departure listed while she's
  on her way out (Chebeague at 06:00 on the 05:00 boat, before Cliff) is taken as that call's.
- The boats: each run goes to the first boat back at Portland in time for it (five minutes to turn round), else to
  another; the Peaks car-ferry runs (cf) to the car ferry first.
Notes in the tables: XF except Friday, FO Friday only, fso and ⁕ Friday and Saturday only, "ends 10/31". The
Diamond Cove page has no summer table (the summer boats pass it by). Which boat runs which route is assumed
(Machigonne II, the car ferry, on Peaks with a passenger boat for the rest; Maquoit II, Aucocisco III and Wabanaki
down the bay); Battery Steele, the new Peaks ferry, isn't in service yet.
"""
import html, json, math, os, re, sys, time, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'www', 'data', 'ferries.json')
UA = {'User-Agent': 'Mozilla/5.0 (AudioChart; egilchri.github.io)'}
SEASONS = {'spring': ('05-22', '06-19'), 'summer': ('06-20', '09-07'), 'fall': ('09-08', '10-12'), 'winter': ('10-13', '05-21')}
PAGES = {'Peaks Island': 'peaks-island', 'Little Diamond': 'little-diamond-island', 'Great Diamond': 'great-diamond',
         'Diamond Cove': 'diamond-cove', 'Long Island': 'long-island', 'Chebeague Island': 'chebeague-island', 'Cliff Island': 'cliff-island'}
DOWN_WAYS = [30765707, 996909129, 996909128, 996909127, 996909126, 996909125]
PEAKS_WAY = 30770334
DOWN = ['Portland', 'Little Diamond', 'Great Diamond', 'Diamond Cove', 'Long Island', 'Chebeague Island', 'Cliff Island']
LANDINGS = {   # OSM's ferry terminals (amenity=ferry_terminal)
    'Portland': (-70.24778, 43.65637), 'Peaks Island': (-70.20005, 43.65544), 'Little Diamond': (-70.20959, 43.66281),
    'Great Diamond': (-70.19936, 43.67048), 'Diamond Cove': (-70.1913, 43.68471), 'Long Island': (-70.1686, 43.68971),
    'Chebeague Island': (-70.12665, 43.71627), 'Cliff Island': (-70.11012, 43.69502)}
DAYS = {'MON. - SUN.': [0, 1, 2, 3, 4, 5, 6], 'MON./TUE.': [1, 2], 'WED. - SUN.': [3, 4, 5, 6, 0], 'Mon-Fri': [1, 2, 3, 4, 5],
        'Sat/Sun': [6, 0], 'Sun.-Thurs.': [0, 1, 2, 3, 4], 'Fri./Sat.': [5, 6]}   # (0 = Sunday, as JS's getDay)
KN = 12          # her speed under way
DWELL = 3        # minutes alongside at a landing on the way
TURN = 5         # minutes at Portland between runs
VESSELS = {
    'peaks': [{'vessel': 'MACHIGONNE II', 'length_m': 37.2}, {'vessel': 'BAY MIST', 'length_m': 25.9}, {'vessel': 'WABANAKI', 'length_m': 33.5}],
    'down': [{'vessel': 'MAQUOIT II', 'length_m': 29.9}, {'vessel': 'AUCOCISCO III', 'length_m': 33.5}, {'vessel': 'WABANAKI', 'length_m': 33.5}, {'vessel': 'BAY MIST', 'length_m': 25.9}],
}


def get(url, cache):
    fn = os.path.join(cache, re.sub(r'\W+', '_', url)) if cache else None
    if fn and os.path.exists(fn): return open(fn, encoding='utf-8').read()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r: t = r.read().decode('utf-8')
    except urllib.error.HTTPError as err:
        if err.code != 404: raise
        t = ''   # (no such season's page: Diamond Cove in summer)
    if fn: open(fn, 'w', encoding='utf-8').write(t)
    return t


def overpass(ids):
    q = f'[out:json][timeout:60];way(id:{",".join(map(str, ids))});out geom;'
    for attempt in range(6):
        for host in ('overpass-api.de/api/interpreter', 'overpass.kumi.systems/api/interpreter'):
            try:
                req = urllib.request.Request(f'https://{host}', data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': 'AudioChart/1.0 (egilchri.github.io)'})
                with urllib.request.urlopen(req, timeout=90) as r:
                    return {e['id']: [[round(p['lon'], 6), round(p['lat'], 6)] for p in e['geometry']] for e in json.load(r)['elements']}
            except Exception as err:
                print(f'  {host}: {err}', file=sys.stderr)
        time.sleep(15 * (attempt + 1))
    sys.exit('Overpass unavailable')


# ── the timetables ──
def tables(page):
    """[{days, P: [(min, flags)], I: [(min, flags)]}] from one season's page for an island."""
    cell = lambda c: html.unescape(re.sub(r'<[^>]+>', ' ', c)).replace('\xa0', ' ').strip()
    out = []
    for tb in re.findall(r'<table[^>]*tablepress[^>]*>(.*?)</table>', page, re.S):
        cur, pm = None, False
        for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', tb, re.S):
            r = [cell(c) for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', tr, re.S)]
            lab = [c for c in r if c in DAYS]
            if lab: cur = {'days': DAYS[lab[0]], 'P': [], 'I': []}; out.append(cur); pm = False; continue
            if cur is None or any(c.startswith('Depart') for c in r): continue
            if r and r[0] in ('AM', 'PM'): pm = r[0] == 'PM'; r = r[1:]
            for col, key in ((0, 'P'), (1, 'I')):
                m = re.match(r'(\d{1,2}):(\d\d)', r[col]) if len(r) > col else None
                if not m: continue
                h = int(m.group(1)) % 12 + (12 if pm else 0)
                fl = {k for k in ('XF', 'FO', 'fso', '⁕', 'cf') if k in r[col]}
                e = re.search(r'ends (\d+)/(\d+)', r[col])
                if e: fl.add('until %02d-%02d' % (int(e.group(1)), int(e.group(2))))
                cur[key].append((h * 60 + int(m.group(2)), fl))
    return out


def runs_today(fl, wd, md):
    if 'XF' in fl and wd == 5: return False
    if 'FO' in fl and wd != 5: return False
    if ('fso' in fl or '⁕' in fl) and wd not in (5, 6): return False
    return not any(f.startswith('until ') and md > f[6:] for f in fl)


def lists(tabs, wd, md):
    for t in tabs:
        if wd in t['days']:
            return ([m for m, fl in t['P'] if runs_today(fl, wd, md)], [m for m, fl in t['I'] if runs_today(fl, wd, md)],
                    {m for m, fl in t['P'] if 'cf' in fl and runs_today(fl, wd, md)})
    return [], [], set()


# ── the runs ──
def nm(a, b):
    return math.hypot((a[0] - b[0]) * 60 * math.cos(math.radians(43.7)), (a[1] - b[1]) * 60)


def along(line):
    c = [0.0]
    for i in range(1, len(line)): c.append(c[-1] + nm(line[i - 1], line[i]))
    return c


def at_landing(line, c, p):
    return c[min(range(len(line)), key=lambda i: nm(line[i], p))]


def down_runs(P, I, D):
    """P[island] / I[island]: departures from Portland for it / from it; D[landing]: nm along the line.
    Each run: (start, [(t0, t1, a, b, bound) | (t0, t1, a)], end) with landings as indices into DOWN."""
    used = {k: set() for k in I}
    leg = lambda a, b: abs(D[DOWN[b]] - D[DOWN[a]]) / KN * 60
    def take(isl, lo, hi):
        for t in sorted(I.get(isl, [])):
            if lo <= t <= hi and t not in used[isl]: used[isl].add(t); return t
        return None
    runs = []
    for T in sorted({t for isl in P for t in P[isl]}):
        calls = sorted(DOWN.index(isl) for isl in P if T in P[isl])
        far, t, pos, segs = calls[-1], T, 0, []
        # her time leaving the farthest island: its first listed departure after she could be there
        reach = T + leg(0, far) + DWELL * (len(calls) - 1)
        tf = next((x for x in sorted(I.get(DOWN[far], [])) if reach - 10 <= x <= reach + 60 and x not in used[DOWN[far]]), None)
        for i in calls:
            arr = t + leg(pos, i); segs.append((t, arr, pos, i, far)); t = arr
            if i == far:
                dep = max(t + 2, tf) if tf is not None else t + 10
                if tf is not None: used[DOWN[i]].add(tf)
            else:   # (a departure on the way out only if she'd still make the farthest island's)
                x = next((x for x in sorted(I.get(DOWN[i], [])) if t - 3 <= x <= t + 25 and x not in used[DOWN[i]] and (tf is None or x + leg(i, far) <= tf + 2)), None)
                if x is not None: used[DOWN[i]].add(x)
                dep = max(t + DWELL, x or 0)
            segs.append((t, dep, i)); t, pos = dep, i
        for j in range(far - 1, 0, -1):   # home, calling where an island lists a departure about when she passes
            est = t + leg(pos, j)
            dep = take(DOWN[j], est - 5, est + 20)
            if dep is None: continue
            segs.append((t, est, pos, j, 0)); segs.append((est, max(est + 2, dep), j)); t, pos = max(est + 2, dep), j
        arr = t + leg(pos, 0); segs.append((t, arr, pos, 0, 0))
        runs.append((T, segs, arr))
    left = sum(len(set(I[k]) - used[k]) for k in I)
    return runs, left


def peaks_runs(P, I, D, cf):
    used, runs = set(), []
    run = (D['Peaks Island'] - D['Portland']) / KN * 60
    for T in sorted(P):
        arr = T + run
        dep = next((t for t in sorted(I) if arr + 2 <= t <= arr + 60 and t not in used), None)
        if dep is None: dep = arr + 10
        else: used.add(dep)
        runs.append((T, [(T, arr, 0, 1, 1), (arr, dep, 1), (dep, dep + run, 1, 0, 0)], dep + run, T in cf))
    return runs, len(set(I) - used)


def boats(runs, first=lambda r: False):
    """Runs to boats: each to the first boat back at Portland in time; `first` runs (the car ferry's) to boat 0."""
    out = []
    free = lambda b, r: all(q[2] + TURN <= r[0] or r[2] + TURN <= q[0] for q in b)
    for pref in (True, False):
        for r in sorted((r for r in runs if bool(first(r)) == pref), key=lambda r: r[0]):
            # (the others to another boat than the car ferry, as the evening Peaks runs are a passenger boat's)
            b = next((b for b in (out[1:] if not pref and any(first(q) for q in runs) else out) if free(b, r)), None)
            if b is None: b = []; out.append(b)
            b.append(r)
    for b in out: b.sort(key=lambda r: r[0])
    return out


def day_of(boat):
    """One boat's segments, alongside at Portland between her runs; minutes rounded to 0.1."""
    segs = []
    for k, (T, ss, end, *_) in enumerate(boat):
        if k: segs.append((boat[k - 1][2], T, 0))
        segs += ss
    return [[round(x, 1) if i < 2 else x for i, x in enumerate(s)] for s in segs]


def main():
    cache = sys.argv[sys.argv.index('--cache') + 1] if '--cache' in sys.argv else None
    if cache: os.makedirs(cache, exist_ok=True)
    w = overpass(DOWN_WAYS + [PEAKS_WAY])
    down_line = []
    for i in DOWN_WAYS: down_line += w[i][1:] if down_line and down_line[-1] == w[i][0] else w[i]
    peaks_line = w[PEAKS_WAY]
    Dd = {k: at_landing(down_line, along(down_line), LANDINGS[k]) for k in DOWN}
    Dp = {k: at_landing(peaks_line, along(peaks_line), LANDINGS[k]) for k in ('Portland', 'Peaks Island')}
    print('down the bay, nm:', {k: round(v, 2) for k, v in Dd.items()})
    tabs = {(isl, se): tables(get(f'https://www.cascobaylines.com/schedules/{pg}-schedule/{se}/', cache)) for isl, pg in PAGES.items() for se in SEASONS}
    # the year's periods: each season, winter split at 10/31 (a run that "ends 10/31")
    periods = [('spring', '05-22', '06-19'), ('summer', '06-20', '09-07'), ('fall', '09-08', '10-12'), ('winter', '10-13', '10-31'), ('winter', '11-01', '05-21')]
    out = {'peaks': {'periods': [], 'variants': []}, 'down': {'periods': [], 'variants': []}}
    nboats = {'peaks': 1, 'down': 1}
    for se, a, b in periods:
        md = a
        pd = {'peaks': [], 'down': []}
        for wd in range(7):
            Pp, Ip, cf = lists(tabs[('Peaks Island', se)], wd, md)
            pr, pleft = peaks_runs(Pp, Ip, Dp, cf)
            P, I = {}, {}
            for isl in DOWN[1:]:
                P[isl], I[isl], _ = lists(tabs[(isl, se)], wd, md)
            dr, dleft = down_runs(P, I, Dd)
            for key, runs, first in (('peaks', pr, lambda r: r[3]), ('down', dr, lambda r: False)):
                bs = boats(runs, first)
                v = [day_of(bt) for bt in bs]
                nboats[key] = max(nboats[key], len(v))
                vs = out[key]['variants']
                if v not in vs: vs.append(v)
                pd[key].append(vs.index(v))
            print(f'{se} {a}..{b} day {wd}: peaks {len(pr)} runs ({pleft} Peaks departures left over), down the bay {len(dr)} runs ({dleft} island departures left over)')
        for key in out: out[key]['periods'].append({'md': [a, b], 'days': pd[key]})
    data = json.load(open(OUT))
    ferries = [f for f in data['ferries'] if f.get('kind') != 'cbl']
    base = {'kind': 'cbl', 'says': 'Casco Bay Lines', 'knots': KN}
    ferries.append({**base, 'name': 'Casco Bay Lines – Peaks Island', 'from': 'Portland', 'to': 'Peaks Island', 'osm': [PEAKS_WAY], 'line': peaks_line,
                    'vessel': VESSELS['peaks'][0]['vessel'], 'length_m': VESSELS['peaks'][0]['length_m'], 'boats': VESSELS['peaks'][:nboats['peaks']], 'timetable': out['peaks']})
    ferries.append({**base, 'name': 'Casco Bay Lines – down the bay', 'from': 'Portland', 'to': 'Cliff Island', 'osm': DOWN_WAYS, 'line': down_line,
                    'stops': [{'name': k, 'lon': LANDINGS[k][0], 'lat': LANDINGS[k][1]} for k in DOWN[1:-1]],
                    'vessel': VESSELS['down'][0]['vessel'], 'length_m': VESSELS['down'][0]['length_m'], 'boats': VESSELS['down'][:nboats['down']], 'timetable': out['down']})
    data['ferries'] = ferries
    data['cbl_source'] = ('Casco Bay Lines timetables (cascobaylines.com/schedules), fetched ' + time.strftime('%Y-%m-%d') +
                          '; lines OpenStreetMap contributors (ODbL), ways ' + ', '.join(map(str, DOWN_WAYS + [PEAKS_WAY])) + '; see preprocess/build_cbl.py')
    if nboats['down'] > len(VESSELS['down']) or nboats['peaks'] > len(VESSELS['peaks']): sys.exit(f'more boats than names: {nboats}')
    json.dump(data, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    open(OUT, 'a').write('\n')
    print('boats:', nboats, 'variants:', {k: len(v['variants']) for k, v in out.items()})


if __name__ == '__main__':
    main()
