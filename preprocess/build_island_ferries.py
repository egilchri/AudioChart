#!/usr/bin/env python3
"""Add the Chebeague Transportation and Bustins Island ferries to www/data/ferries.json (v998), run to their timetables.

    python3 preprocess/build_island_ferries.py

- Chebeague Transportation Company (CTC), Cousins Island (Yarmouth) - Chebeague's Stone Wharf, the Independence (2019,
  Washburn & Doughty, 54 ft; the Islander, 1985, is her back-up). Line: OpenStreetMap way 1547409708 (ODbL), the
  wharf at Cousins Island to the Stone Wharf. Timetable from ctcferry.org (published as images): the off-season table
  effective 13 Oct 2026 and the season table effective 16 May 2025; the same runs but for the 22:30 boat, Friday
  only off season, Friday and Saturday in season. She leaves Chebeague on the hour (or near it), Cousins Island a
  quarter-hour later, and lies at Chebeague overnight. Holiday schedules are left out.
- Bustins Island Village Corporation's Lilly B (2000, built by Bradley Simmons to an Al Spalding design, 44
  passengers), South Freeport town wharf - Bustins Island's Steamer Dock. Line: OSM way 329759736 (ODbL). Timetable
  from bivc.net's 2026 Ferry Schedule and Fares: the regular season 19 Jun-7 Sep, the off seasons 15 May-16 Jun and
  8 Sep-13 Oct, Memorial Day and Columbus Day; 20 minutes each way. Her length isn't published: 42 ft is our
  estimate, from photos.
"""
import json, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'www', 'data', 'ferries.json')
CTC_LINE = [[-70.1394788, 43.7517587], [-70.108258, 43.7521322]]   # OSM way 1547409708
BUSTINS_LINE = [[-70.1056244, 43.8202722], [-70.1054264, 43.820421], [-70.1048988, 43.8200834], [-70.1046367, 43.8194763],
                [-70.1057818, 43.8091977], [-70.1055755, 43.807895], [-70.0809212, 43.7967994], [-70.0789977, 43.7965001],
                [-70.0786371, 43.7966146]]   # OSM way 329759736
m = lambda hm: int(hm[:-3]) * 60 + int(hm[-2:])


def day(runs, home, away, run):
    """A boat's day from her round trips [(leave home, leave away)], landing `home` (0 or 1) to `away`: under way
    `run` minutes each way, alongside between."""
    segs = []
    for i, (a, b) in enumerate(runs):
        a, b = m(a), m(b)
        if segs: segs.append([segs[-1][1], a, home])
        segs += [[a, a + run, home, away], [a + run, b, away], [b, b + run, away, home]]
    return segs


# CTC: (leaves Chebeague, leaves Cousins Island)
CTC_WEEK = [('06:30', '06:45'), ('08:00', '08:15'), ('10:00', '10:15'), ('12:00', '12:15'), ('14:00', '14:15'), ('15:45', '16:00'),
            ('16:45', '17:00'), ('18:15', '18:30'), ('20:00', '20:15'), ('21:15', '21:30')]
CTC_LATE = CTC_WEEK + [('22:30', '22:45')]
CTC_SUN = [('08:00', '08:15'), ('10:00', '10:15'), ('12:00', '12:15'), ('14:00', '14:15'), ('15:45', '16:00'), ('16:45', '17:00'), ('19:15', '19:30')]
# Bustins: (leaves South Freeport, leaves Bustins)
def bus(*pairs): return list(pairs)
BUS = {
    'reg_week': bus(('08:00', '08:40'), ('11:00', '11:40'), ('15:00', '15:40'), ('17:00', '17:40')),
    'reg_fri': bus(('08:00', '08:40'), ('11:00', '11:40'), ('15:00', '15:40'), ('17:00', '17:40'), ('19:00', '19:30')),
    'reg_wkend': bus(('08:00', '08:40'), ('11:00', '11:40'), ('13:00', '13:40'), ('15:00', '15:40'), ('17:00', '17:40')),
    'tue': bus(('08:00', '08:40'), ('11:00', '11:40')),
    'spring_fri': bus(('11:00', '11:40'), ('15:00', '15:40'), ('18:00', '18:30')),
    'fall_fri': bus(('11:00', '11:40'), ('15:00', '15:40'), ('17:00', '17:40')),
    'sat': bus(('09:00', '09:40'), ('11:00', '11:40'), ('15:00', '15:40')),
    'sun': bus(('09:00', '09:40'), ('11:00', '11:40'), ('15:00', '15:40'), ('17:00', '17:40')),
    'holiday': bus(('11:00', '11:40'), ('15:00', '15:40'), ('17:00', '17:40')),
}


def main():
    names = list(BUS)
    V = {k: i for i, k in enumerate(names)}
    ctc = {
        'kind': 'ctc', 'says': 'Ferry', 'called': 'Chebeague ferry', 'name': 'Chebeague Transportation – Cousins Island', 'from': 'Cousins Island',
        'to': 'Chebeague Island', 'knots': 10, 'osm': [1547409708], 'line': CTC_LINE, 'vessel': 'INDEPENDENCE', 'length_m': 16.5,
        'timetable': {
            # (0 = Sunday, as JS's getDay; the in-season period first, as the first match wins)
            'periods': [{'md': ['05-16', '10-12'], 'days': [2, 0, 0, 0, 0, 1, 1]}, {'md': ['10-13', '05-15'], 'days': [2, 0, 0, 0, 0, 1, 0]}],
            'variants': [[day(CTC_WEEK, 1, 0, 11)], [day(CTC_LATE, 1, 0, 11)], [day(CTC_SUN, 1, 0, 11)]],
        },
    }
    N = None
    lilly = {
        'kind': 'launch', 'look': 'lillyb', 'says': 'Ferry', 'called': 'Bustins Island ferry', 'name': 'Bustins Island Ferry', 'from': 'South Freeport',
        'to': 'Bustins Island', 'knots': 8, 'osm': [329759736], 'line': BUSTINS_LINE, 'vessel': 'LILLY B', 'length_m': 12.8,
        'timetable': {
            'periods': [
                {'md': ['05-25', '05-25'], 'days': [V['holiday']] * 7}, {'md': ['10-12', '10-12'], 'days': [V['holiday']] * 7},
                {'md': ['05-15', '06-16'], 'days': [V['sun'], N, V['tue'], N, N, V['spring_fri'], V['sat']]},
                {'md': ['06-19', '09-07'], 'days': [V['reg_wkend'], V['reg_week'], V['reg_week'], V['reg_week'], V['reg_week'], V['reg_fri'], V['reg_wkend']]},
                {'md': ['09-08', '10-13'], 'days': [V['sun'], N, V['tue'], N, N, V['fall_fri'], V['sat']]},
            ],
            'variants': [[day(BUS[k], 0, 1, 20)] for k in names],
        },
    }
    d = json.load(open(OUT))
    d['ferries'] = [f for f in d['ferries'] if f['name'] not in (ctc['name'], lilly['name'])] + [ctc, lilly]
    d['island_ferries_source'] = ('Chebeague Transportation Company timetables (ctcferry.org), Bustins Island Village Corporation 2026 '
                                  'ferry schedule (bivc.net), fetched 2026-10-24; lines OpenStreetMap contributors (ODbL), ways 1547409708, '
                                  '329759736; see preprocess/build_island_ferries.py')
    json.dump(d, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    open(OUT, 'a').write('\n')
    for f in (ctc, lilly):
        print(f['name'], [len(v[0]) for v in f['timetable']['variants']])


if __name__ == '__main__':
    main()
