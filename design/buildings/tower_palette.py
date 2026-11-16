# A city's towers in glass and grey (v1142, requested: "make the downtown towers glass and grey"): the buildings in
# the given files at least TALL m high (roof above ground) get a tower's wall colour, by their id, from glass
# (blue-grey, dark) and stone (light grey, grey, warm granite), the glass ones as curtain walls (cw: big panes on tall
# floors, terrain3d.js), and grey roofs. The rest keep build_buildings.py's colours. Edits the files in place,
# keeping their compact form.
#   python3 tower_palette.py [TALL] ../../www/data/buildings/bos-downtown.json ...
import hashlib, json, sys
args = sys.argv[1:]
TALL = float(args.pop(0)) if args and args[0].replace('.', '').isdigit() else 35.0
TOWER = [((112, 130, 148), 30, True), ((78, 92, 108), 18, True), ((150, 168, 180), 10, True),   # glass: blue-grey, dark, pale
         ((192, 194, 192), 18, False), ((150, 154, 158), 14, False), ((178, 170, 158), 10, False)]   # stone: light, grey, granite
def pick(seed):
    t = int(hashlib.md5(str(seed).encode()).hexdigest()[:8], 16) % sum(w for _, w, _ in TOWER)
    for c, w, glass in TOWER:
        if t < w: return c, glass
        t -= w
    return TOWER[0][0], True
for f in args:
    d = json.load(open(f)); n = 0
    for i, b in enumerate(d['buildings']):
        if b.get('r', 0) < TALL: continue
        c, glass = pick(json.dumps(b['p'][0]) + str(i)); b['wc'] = list(c); b['rc'] = [118, 122, 126]
        if glass: b['cw'] = 1
        else: b.pop('cw', None)
        n += 1
    json.dump(d, open(f, 'w'), separators=(',', ':'))
    print(f, n, 'towers of', len(d['buildings']))
