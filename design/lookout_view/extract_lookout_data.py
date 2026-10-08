import json, math
D='/Users/edgargilchrist/tools/AudioChart/www/data/'
W,E,S,N = -69.30, -68.58, 43.95, 44.28
route=[[-69.088,44.103],[-68.94485,44.09785],[-68.93611,44.10108],[-68.91291,44.11412],[-68.90639,44.12188],[-68.89765,44.12535],[-68.8862,44.12717],[-68.86317,44.12095],[-68.86033,44.11681],[-68.86162,44.1151],[-68.8602,44.11716],[-68.85427,44.12141],[-68.85498,44.12743],[-68.84227,44.13398],[-68.82984,44.13362],[-68.81607,44.13179],[-68.8122,44.12857],[-68.79023,44.12946]]
inb=lambda p: W<=p[0]<=E and S<=p[1]<=N
def rings(g):
    t=g['type']; c=g['coordinates']
    if t=='Polygon': return [c[0]]
    if t=='MultiPolygon': return [p[0] for p in c]
    return []
land=json.load(open(D+'land.geojson'))
full=[]
for f in land['features']:
    for r in rings(f['geometry']):
        if any(inb(p) for p in r): full.append(r)
key=lambda a,b: tuple(sorted([(round(a[0],6),round(a[1],6)),(round(b[0],6),round(b[1],6))]))
owner={}
for rid,r in enumerate(full):
    for i in range(len(r)-1): owner.setdefault(key(r[i],r[i+1]),set()).add(rid)
par=list(range(len(full)))
def find(a):
    while par[a]!=a: par[a]=par[par[a]]; a=par[a]
    return a
for k,o in owner.items():
    o=list(o)
    for x in o[1:]: par[find(x)]=find(o[0])
kx=math.cos(math.radians(44.1))
gb={}
for rid,r in enumerate(full):
    g=find(rid); xs=[p[0] for p in r]; ys=[p[1] for p in r]
    b=gb.get(g,[1e9,1e9,-1e9,-1e9]); gb[g]=[min(b[0],min(xs)),min(b[1],min(ys)),max(b[2],max(xs)),max(b[3],max(ys))]
def hgt(g):
    b=gb[g]; size_nm=max((b[2]-b[0])*kx*60,(b[3]-b[1])*60)
    return 4 if size_nm<0.08 else 12 if size_nm<0.4 else 25 if size_nm<1.5 else 40
lines=[]; seams=0
for rid,r in enumerate(full):
    g=find(rid); h=hgt(g); cur=[]
    for i in range(len(r)-1):
        a,b=r[i],r[i+1]
        keep=(inb(a) or inb(b)) and len(owner[key(a,b)])==1
        if not keep: seams+= (len(owner[key(a,b)])>1)
        if keep:
            if not cur: cur=[a]
            cur.append(b)
        elif cur:
            lines.append({'r':g,'h':h,'p':cur}); cur=[]
    if cur: lines.append({'r':g,'h':h,'p':cur})
print('seam edges dropped',seams,'groups',len(set(find(i) for i in range(len(full)))))
def pip(pt,r):
    x,y=pt; c=False; j=len(r)-1
    for i in range(len(r)):
        xi,yi=r[i]; xj,yj=r[j]
        if (yi>y)!=(yj>y) and x<(xj-xi)*(y-yi)/(yj-yi)+xi: c=not c
        j=i
    return c
nav=[]
for f in json.load(open(D+'regions/penobscot-bay/navaid.geojson'))['features']:
    p=f['properties']; c=f['geometry']['coordinates']
    if not inb(c) or p['objtype'] not in ('BOYLAT','BCNLAT','BOYSAW','BOYSPP','BOYCAR','BOYISD','LIGHTS'): continue
    nav.append({'t':p['objtype'],'n':p.get('name'),'c':p.get('colour'),'s':p.get('shape'),'ch':p.get('characteristic'),'x':round(c[0],5),'y':round(c[1],5)})
places=[]
for f in json.load(open(D+'regions/penobscot-bay/named_places.geojson'))['features']:
    p=f['properties']; g=f['geometry']
    if g['type']!='Point' or not inb(g['coordinates']) or p['objtype'] not in ('LNDARE','LNDRGN','LIGHTS','BUAARE'): continue
    c=g['coordinates']; rid=-1
    for i,r in enumerate(full):
        xs=[q[0] for q in r]
        if min(xs)<=c[0]<=max(xs) and pip(c,r): rid=find(i); break
    places.append({'t':p['objtype'],'n':p['name'],'x':round(c[0],5),'y':round(c[1],5),'r':rid})
for l in lines: l['p']=[[round(a,5),round(b,5)] for a,b in l['p']]
out={'route':route,'land':lines,'nav':nav,'places':places}
s=json.dumps(out,separators=(',',':'))
open('data.json','w').write(s)
print(len(lines),sum(len(l['p']) for l in lines),len(nav),len(places),len(s))
print([p['n'] for p in places if p['t']=='LIGHTS'], sum(1 for p in places if p['r']<0))
print(sorted(set(n['t'] for n in nav)), [n for n in nav if n['t']=='LIGHTS'][:3])
