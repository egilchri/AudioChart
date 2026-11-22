# ElevenLabs voices for the bus video (2026-11-22, asked: "try generating the video with one of their voices").
# The key is read from ~/.config/elevenlabs/key (the user saves it there; never in chat or the repo) and never printed.
#   python3 eleven.py voices                       the account's voices: id, name, labels
#   python3 eleven.py say VOICE_ID out.mp3 "text"  one clip
#   python3 eleven.py narr VOICE_ID narr.json DIR  every line of narr.json → DIR/<key>.wav (+ durations.json)
import json, os, re, subprocess, sys, urllib.request, urllib.error

KEY = open(os.path.expanduser('~/.config/elevenlabs/key')).read().strip()
API = 'https://api.elevenlabs.io/v1'
MODEL = os.environ.get('EL_MODEL', 'eleven_multilingual_v2')

def call(path, body=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body else None,
                                 headers={'xi-api-key': KEY, 'Content-Type': 'application/json', 'Accept': '*/*'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return r.read()
    except urllib.error.HTTPError as e:   # (the body says why; the key isn't in it)
        sys.exit(f'ElevenLabs {e.code}: {e.read()[:400].decode(errors="replace")}')

# what ElevenLabs should say for what's written (it reads "M104" and "MTA" its own way)
SPEAK = [('M T A', 'M.T.A.'), ("Ted's Birdseye", "Ted's Birds-eye")]
ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split()
TENS = 'x x twenty thirty forty fifty sixty seventy eighty ninety'.split()
def words(n): return ONES[n] if n < 20 else TENS[n // 10] + ('-' + ONES[n % 10] if n % 10 else '')
def spoken(t):
    for a, b in SPEAK: t = t.replace(a, b)
    # "1,500" as "fifteen hundred" (Eric read it "one fifth hundred")
    t = re.sub(r'\b(\d),(\d)00\b', lambda m: f'{words(int(m[1] + m[2]))} hundred', t)
    return t

def say(voice, out, text):
    mp3 = call(f'/text-to-speech/{voice}?output_format=mp3_44100_128',
               {'text': spoken(text), 'model_id': MODEL, 'voice_settings': {'stability': 0.5, 'similarity_boost': 0.75}})
    open(out, 'wb').write(mp3)

def dur(f):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]))

cmd = sys.argv[1]
if cmd == 'voices':
    for v in json.loads(call('/voices'))['voices']:
        lb = v.get('labels') or {}
        print(v['voice_id'], '|', v['name'], '|', v.get('category', ''), '|', ', '.join(f'{k}: {x}' for k, x in lb.items()))
elif cmd == 'say':
    say(sys.argv[2], sys.argv[3], sys.argv[4]); print(sys.argv[3], f'{dur(sys.argv[3]):.2f} s')
elif cmd == 'music':   # python3 eleven.py music out.mp3 SECONDS "prompt": an original track (Eleven Music)
    out, secs, prompt = sys.argv[2], float(sys.argv[3]), sys.argv[4]
    open(out, 'wb').write(call('/music?output_format=mp3_44100_128', {'prompt': prompt, 'music_length_ms': int(secs * 1000), 'model_id': 'music_v1'}))
    print(out, f'{dur(out):.2f} s')
elif cmd == 'narr':
    voice, narr, out = sys.argv[2], json.load(open(sys.argv[3])), sys.argv[4]
    os.makedirs(out, exist_ok=True); D = {}
    for k, t in narr.items():
        mp3 = f'{out}/{k}.mp3'; say(voice, mp3, t)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', mp3, '-ar', '22050', '-ac', '1', f'{out}/{k}.wav'], check=True)
        D[k] = round(dur(f'{out}/{k}.wav'), 3); print(k, D[k])
    json.dump(D, open(f'{out}/durations.json', 'w'), indent=1)
