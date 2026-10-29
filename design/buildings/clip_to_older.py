# A new tile that overlaps tiles already in index.json (v1066: Long Island City's box takes in Midtown's east edge):
# drop its buildings whose middle is in an older tile's box, so none is drawn twice.
#   python clip_to_older.py <new tile id> ...
import json, os, sys
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../www/data/buildings')
idx = json.load(open(os.path.join(D, 'index.json')))
new = set(sys.argv[1:])
older = [t for t in idx if t['file'][:-5] not in new]
for tid in sys.argv[1:]:
    f = os.path.join(D, tid + '.json'); J = json.load(open(f)); W, S, E, N = J['bbox']
    over = [t for t in older if t['bbox'][0] < E and t['bbox'][2] > W and t['bbox'][1] < N and t['bbox'][3] > S]
    def inside(b):
        x = sum(p[0] for p in b['p']) / len(b['p']); y = sum(p[1] for p in b['p']) / len(b['p'])
        return any(t['bbox'][0] <= x <= t['bbox'][2] and t['bbox'][1] <= y <= t['bbox'][3] for t in over)
    n = len(J['buildings']); J['buildings'] = [b for b in J['buildings'] if not inside(b)]
    json.dump(J, open(f, 'w'), separators=(',', ':'))
    print(tid, 'overlaps', [t['file'] for t in over], 'dropped', n - len(J['buildings']))
