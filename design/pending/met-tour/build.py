# (2026-11-22) Builds met-tour.mp4 from rec/ and narr/ (record.mjs, Eric's voice): ../piper/bin/python build.py (from ../bus-video/build.py)
# (v1203) NARR=narr-brian OUT=bus-video-brian.mp4 for the ElevenLabs voice (eleven.py narr ...)
import json, subprocess, os
NARR, OUT = os.environ.get('NARR', 'narr'), os.environ.get('OUT', 'met-tour.mp4')
from PIL import Image, ImageDraw, ImageFont
def run(*a): subprocess.run(a, check=True, capture_output=True)
m = json.load(open('rec/meta.json')); fps, n = m['fps'], m['frames']; dur = n / fps
# the titles: a band across the lower third, at the start and the end
F = '/System/Library/Fonts/Supplemental/'
def card(name, big, small):
    im = Image.new('RGBA', (1280, 720), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rectangle([0, 520, 1280, 640], fill=(12, 20, 28, 170)); d.rectangle([0, 520, 1280, 523], fill=(224, 168, 67, 255))
    fb, fs = ImageFont.truetype(F + 'Georgia Bold.ttf', 44), ImageFont.truetype(F + 'Georgia Italic.ttf', 24)
    d.text((60, 536), big, font=fb, fill=(246, 240, 226, 255)); d.text((62, 596), small, font=fs, fill=(224, 168, 67, 255))
    im.save(name)
card('title.png', 'Brooklyn to the Met', 'By subway and bus  ·  Ted’s Birdseye')
card('end.png', 'Ted’s Birdseye', 'egilchri.github.io/birdseye  ·  New York  ·  Live')
os.makedirs('norm', exist_ok=True)
inputs, filt = [], []
for j, mk in enumerate(m['marks']):
    run('ffmpeg', '-y', '-i', f"{NARR}/{mk['name']}.wav", '-af', 'loudnorm=I=-16:TP=-2:LRA=7', '-ar', '44100', '-ac', '1', f"norm/{mk['name']}.wav")
    inputs += ['-i', f"norm/{mk['name']}.wav"]; ms = int(mk['t'] * 1000)
    filt.append(f'[{j + 3}:a]adelay={ms}|{ms}[a{j}]')
k = len(m['marks'])
filt.append(''.join(f'[a{j}]' for j in range(k)) + f'amix=inputs={k}:normalize=0:dropout_transition=0,apad,atrim=0:{dur:.3f}[aout]')
filt.append(f"[1:v]format=rgba,fade=in:st=0.8:d=0.6:alpha=1,fade=out:st=6.6:d=0.7:alpha=1[t1]")
filt.append(f"[2:v]format=rgba,fade=in:st={dur - 4.5:.2f}:d=0.7:alpha=1[t2]")
filt.append(f"[0:v][t1]overlay=0:0:enable='lt(t,7.4)'[v1];[v1][t2]overlay=0:0:enable='gt(t,{dur - 4.6:.2f})',format=yuv420p,fade=in:st=0:d=0.5,fade=out:st={dur - 0.6:.2f}:d=0.6[vout]")
run('ffmpeg', '-y', '-framerate', str(fps), '-i', 'rec/%05d.jpg', '-loop', '1', '-framerate', str(fps), '-t', f'{dur:.3f}', '-i', 'title.png',
    '-loop', '1', '-framerate', str(fps), '-t', f'{dur:.3f}', '-i', 'end.png', *inputs,
    '-filter_complex', ';'.join(filt), '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-crf', '29', '-preset', 'slow',
    '-c:a', 'aac', '-b:a', '128k', '-t', f'{dur:.3f}', '-movflags', '+faststart', OUT)
print(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration,size', '-of', 'csv=p=0', OUT]).decode())
