import json, math, urllib.request, sys, collections
BASE='https://s3-us-west-2.amazonaws.com/usgs-lidar-public/ME_MidCoast_2_2021/'
R=6378137.0
def merc(lon,lat): return (math.radians(lon)*R, math.log(math.tan(math.pi/4+math.radians(lat)/2))*R)
W,S_,E,N=-68.85,44.035,-68.82,44.06
x0,y0=merc(W,S_); x1,y1=merc(E,N)
ept=json.load(open(sys.argv[1]))
b=ept['bounds']
def get(u): return json.load(urllib.request.urlopen(BASE+u, timeout=60))
hier={}
def load(key):
    h=get(f'ept-hierarchy/{key}.json'); hier.update(h)
load('0-0-0-0')
def nb(key):
    d,x,y,z=map(int,key.split('-')); s=(b[3]-b[0])/2**d
    return b[0]+x*s, b[1]+y*s, b[0]+(x+1)*s, b[1]+(y+1)*s
out=[]; stack=['0-0-0-0']
while stack:
    k=stack.pop()
    if k not in hier: continue
    if hier[k]==-1: load(k)
    bx0,by0,bx1,by1=nb(k)
    if bx1<x0 or bx0>x1 or by1<y0 or by0>y1: continue
    out.append((k,hier[k]))
    d,x,y,z=map(int,k.split('-'))
    for dx in (0,1):
        for dy in (0,1):
            for dz in (0,1): stack.append(f'{d+1}-{2*x+dx}-{2*y+dy}-{2*z+dz}')
c=collections.Counter(); 
for k,n in out: c[int(k.split('-')[0])]+=n
print(sorted(c.items()))
json.dump(out, open(sys.argv[2],'w'))
