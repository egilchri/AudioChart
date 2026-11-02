# python cmpplane.py <tag>: the drawing's side/top/front beside the renders, each cropped to the plane and scaled alike
import sys
from PIL import Image, ImageChops
SP = '/private/tmp/claude-501/-Users-edgargilchrist-tools-AudioChart/6ba97262-8823-4e7c-bb7c-e2fa5f6838e5/scratchpad/refs/air/'
tag = sys.argv[1]
d = Image.open(SP + 'a1w.jpg').convert('RGB')
def trim(im, bg=(255, 255, 255)):
    diff = ImageChops.difference(im, Image.new('RGB', im.size, bg)).convert('L').point(lambda v: 255 if v > 40 else 0)
    return im.crop(diff.getbbox())
refs = {'side': d.crop((30, 30, 990, 326)), 'top': d.crop((25, 405, 990, 1235)), 'front': d.crop((1060, 30, 1890, 326))}
rows = []
for v in ['side', 'top', 'front']:
    a = trim(refs[v]); b = trim(Image.open(f'{tag}_{v}.png').convert('RGB'))
    w = 760; a = a.resize((w, int(a.height * w / a.width))); b = b.resize((w, int(b.height * w / b.width)))
    row = Image.new('RGB', (2 * w + 20, max(a.height, b.height)), (255, 255, 255)); row.paste(a, (0, 0)); row.paste(b, (w + 20, 0)); rows.append(row)
H = sum(r.height for r in rows) + 20 * len(rows)
o = Image.new('RGB', (rows[0].width, H), (200, 200, 200)); y = 0
for r in rows: o.paste(r, (0, y)); y += r.height + 20
o.save(f'cmp_{tag}.jpg', quality=86)
t = Image.open(f'{tag}_three.png').convert('RGB').resize((800, 500)); b = Image.open(f'{tag}_below.png').convert('RGB').resize((800, 500))
o2 = Image.new('RGB', (1600, 500)); o2.paste(t, (0, 0)); o2.paste(b, (800, 0)); o2.save(f'cmp_{tag}_3d.jpg', quality=86)
