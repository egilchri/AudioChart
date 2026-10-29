# OSM maps the big bridges' towers as buildings (80-105 m, brown walls), drawn over the modelled towers (v1066): drop
# any footprint within 60 m of a tower in bridges/new-york-harbor.json, on its line. Run after building a New York tile.
import json, math, glob, os
HERE=os.path.dirname(os.path.abspath(__file__)); D=os.path.join(HERE,'../../www/data/buildings')
B=json.load(open(os.path.join(HERE,'../../www/data/bridges/new-york-harbor.json')))['bridges']
k=math.cos(math.radians(40.7)); M=111320
xy=lambda lo,la:(lo*M*k, la*M)
def dseg(p,a,b):
    dx,dy=b[0]-a[0],b[1]-a[1];L=dx*dx+dy*dy
    t=0 if L==0 else max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L))
    return math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)
big=[]
for b in B:
    if not b.get('towers'): continue
    pts=b['pts'] if isinstance(b['pts'],list) else json.loads(b['pts'].replace('None','null'))
    big.append((b,[xy(p[0],p[1]) for p in pts],[xy(t['lon'],t['lat']) for t in b['towers']]))
for f in sorted(glob.glob(D+'/*.json')):
    n=os.path.basename(f)
    if not n.startswith(('nyc-','bk-','qn-')): continue
    raw=open(f).read(); J=json.loads(raw); keep=[]; gone=[]
    for bl in J['buildings']:
        c=xy(sum(q[0] for q in bl['p'])/len(bl['p']), sum(q[1] for q in bl['p'])/len(bl['p']))
        hit=None
        for b,P,T in big:
            if min(math.hypot(c[0]-t[0],c[1]-t[1]) for t in T)<60 and min(dseg(c,P[j],P[j+1]) for j in range(len(P)-1))<b['w']/2+15: hit=b['name']
        (gone.append((hit,bl['r'])) if hit else keep.append(bl))
    if gone:
        J['buildings']=keep
        json.dump(J, open(f,'w'), separators=(',',':')) if raw.lstrip()[:2]!='{\n' else json.dump(J, open(f,'w'), indent=1)
        print(n,'dropped',gone)
