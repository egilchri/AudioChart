import json, sys, os, math, urllib.request, concurrent.futures as cf
import numpy as np, laspy
BASE='https://s3-us-west-2.amazonaws.com/usgs-lidar-public/ME_MidCoast_2_2021/'
R=6378137.0
def merc(lon,lat): return (math.radians(lon)*R, math.log(math.tan(math.pi/4+math.radians(lat)/2))*R)
W,S_,E,N=-68.85,44.035,-68.82,44.06
x0,y0=merc(W,S_); x1,y1=merc(E,N)
nodes=[k for k,n in json.load(open(sys.argv[1])) if int(k.split('-')[0])<=int(sys.argv[3])]
def one(k):
    data=urllib.request.urlopen(BASE+f'ept-data/{k}.laz', timeout=120).read()
    las=laspy.read(__import__('io').BytesIO(data))
    x,y,z=np.asarray(las.x),np.asarray(las.y),np.asarray(las.z)
    m=(x>=x0)&(x<=x1)&(y>=y0)&(y<=y1)
    return np.stack([x[m],y[m],z[m],np.asarray(las.classification)[m],np.asarray(las.return_number)[m],np.asarray(las.number_of_returns)[m]],1).astype(np.float64)
parts=[]
with cf.ThreadPoolExecutor(12) as ex:
    for i,a in enumerate(ex.map(one,nodes)): parts.append(a)
P=np.concatenate(parts); np.save(sys.argv[2],P)
print(len(nodes),'nodes',len(P),'points; classes',dict(zip(*np.unique(P[:,3],return_counts=True))))
