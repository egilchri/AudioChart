# Ted's Birdseye's home-screen icon (v1068): the bay from above, an island and its shoals in a dark sea, the red
# Flyover helicopter over it, and AudioChart's own icon as a badge (AudioChart stays the parent brand). Drawn 4x and
# scaled down. Everything that matters sits in the middle 80% (the safe zone of a maskable icon).
#   python make_icon.py   (needs pillow) → design/birdseye/site/icons/birdseye-{512,192,180}.png
import math, os
from PIL import Image, ImageDraw, ImageFilter
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, 'site/icons')
Z = 2048; img = Image.new('RGB', (Z, Z))
d = ImageDraw.Draw(img)
for y in range(Z):   # sea, lighter toward the top (the light from the horizon)
    t = y / Z; d.line([(0, y), (Z, y)], fill=(int(40 - 22 * t), int(92 - 44 * t), int(128 - 50 * t)))
def blob(cx, cy, r, n, seed, wob):
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        k = 1 + wob * (math.sin(3 * a + seed) * 0.5 + math.sin(5 * a + 2 * seed) * 0.3 + math.sin(9 * a + seed * 3) * 0.2)
        pts.append((cx + r * k * math.cos(a), cy + r * 0.82 * k * math.sin(a)))
    return pts
shoal = Image.new('L', (Z, Z)); ImageDraw.Draw(shoal).polygon(blob(1000, 1180, 640, 180, 1.3, 0.22), fill=255)
shoal = shoal.filter(ImageFilter.GaussianBlur(60))
img.paste((88, 160, 170), mask=shoal.point(lambda v: v * 0.55))
land = blob(1000, 1180, 520, 180, 1.3, 0.24)
d.polygon(land, fill=(206, 192, 150))   # the beach
d.polygon(blob(1000, 1185, 470, 180, 1.3, 0.25), fill=(78, 112, 66))   # the woods
d.polygon(blob(930, 1130, 250, 120, 4.1, 0.3), fill=(58, 92, 52))
for x, y, r in [(1460, 640, 70), (1560, 760, 46), (540, 1640, 60)]:   # ledges and islets
    d.ellipse([x - r, y - r * 0.8, x + r, y + r * 0.8], fill=(206, 192, 150)); d.ellipse([x - r * 0.7, y - r * 0.55, x + r * 0.7, y + r * 0.55], fill=(78, 112, 66))
# the helicopter from above, a little up and right, its shadow on the island below
def heli(dr, ox, oy, body, rotor, tail):
    dr.ellipse([ox - 120, oy - 170, ox + 120, oy + 150], fill=body)   # cabin
    dr.polygon([(ox - 34, oy + 110), (ox + 34, oy + 110), (ox + 16, oy + 520), (ox - 16, oy + 520)], fill=body)   # tail boom
    dr.rectangle([ox - 90, oy + 480, ox + 90, oy + 520], fill=tail)   # stabiliser
    for a in (math.radians(25), math.radians(115)):   # rotor
        dx, dy = math.cos(a) * 560, math.sin(a) * 560
        dr.line([(ox - dx, oy - dy), (ox + dx, oy + dy)], fill=rotor, width=46)
    dr.ellipse([ox - 40, oy - 40, ox + 40, oy + 40], fill=rotor)
sh = Image.new('L', (Z, Z)); heli(ImageDraw.Draw(sh), 860, 1360, 255, 255, 255)
img.paste((20, 30, 26), mask=sh.filter(ImageFilter.GaussianBlur(14)).point(lambda v: v * 0.45))
heli(d, 1060, 860, (200, 32, 42), (40, 44, 50), (200, 32, 42))
d.ellipse([1060 - 70, 860 - 140, 1060 + 70, 860 - 30], fill=(143, 184, 216))   # canopy
# AudioChart's icon as a badge, lower right, in a white ring
ac = Image.open(os.path.join(HERE, '../../www/icons/icon-512.png')).convert('RGB').resize((470, 470), Image.LANCZOS)
m = Image.new('L', (470, 470)); ImageDraw.Draw(m).ellipse([0, 0, 469, 469], fill=255)
bx, by = 1300, 1300
d.ellipse([bx - 20, by - 20, bx + 490, by + 490], fill=(244, 242, 236))
img.paste(ac, (bx, by), m)
for s, n in [(512, 'birdseye-512.png'), (192, 'birdseye-192.png'), (180, 'birdseye-180.png')]:
    img.resize((s, s), Image.LANCZOS).save(os.path.join(OUT, n), optimize=True)
print('ok')
