import json, urllib.request, urllib.parse, sys
SVC = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"
def fetch(prefix, west, east, south, north, nx, ny, maxw=4000):
    tiles = []
    tw, th = (east - west) / nx, (north - south) / ny
    for j in range(ny):          # north row first
        for i in range(nx):
            w, e = west + i * tw, west + (i + 1) * tw
            n, s = north - j * th, north - (j + 1) * th
            res = max(tw, th * 1.0) / maxw if tw >= th else th / maxw
            W, H = round(tw / res), round(th / res)
            q = dict(bbox=f"{w},{s},{e},{n}", bboxSR=4326, imageSR=4326, size=f"{W},{H}", format="jpg", compressionQuality=82)
            meta = json.load(urllib.request.urlopen(SVC + "?" + urllib.parse.urlencode({**q, "f": "json"}), timeout=120))
            ext = meta["extent"]
            name = f"{prefix}_{j}{i}.jpg"
            urllib.request.urlretrieve(SVC + "?" + urllib.parse.urlencode({**q, "f": "image"}), "sim2/" + name)
            tiles.append(dict(file=name, west=ext["xmin"], east=ext["xmax"], south=ext["ymin"], north=ext["ymax"], w=meta["width"], h=meta["height"]))
            print(name, meta["width"], meta["height"], ext["xmin"], ext["ymin"], ext["xmax"], ext["ymax"], flush=True)
    return tiles
out = {
  "thorofare": fetch("thor", -68.975, -68.765, 44.075, 44.165, 3, 2),
  "rockland": fetch("rock", -69.13, -68.97, 44.055, 44.135, 2, 2),
  "far": fetch("far", -69.16, -68.62, 43.98, 44.28, 1, 1),
}
json.dump(out, open("sim2/tiles.json", "w"), indent=1)
