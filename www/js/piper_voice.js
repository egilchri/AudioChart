// The narrator's own voice (v1083, requested: "Can the recording include the narration?" … "go ahead with the built-in
// voice"): Piper (a neural voice, en_US lessac, medium) run in the page with onnxruntime-web, so its sound goes through
// Web Audio: to the speakers, and to stream() for a recording of the flight. The system voice (speechSynthesis, tts.js)
// can't be recorded: the browser hands it to the OS. Same calls as tts.js: say (queued), sayImmediate, stop,
// isSpeaking. It speaks a sentence at a time, the next one made while this one plays.
//
// The first time, about 90 MB comes down (the runtime, the phonemizer's data, the voice); the library keeps the voice in
// the browser's own storage (OPFS) and sw.js keeps the rest, so after that it works offline. All pinned versions.
const LIB = 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-tts-web.js';
const VOICE = 'en_US-lessac-medium';
const WASM = {
  onnxWasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/',
  piperData: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data',
  piperWasm: 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm',
};

let session = null, loading = null, failed = false, progress = 0;
let ctx = null, recDest = null;
let queue = [], playing = null, gen = 0, chain = Promise.resolve();

export const ready = () => !!session;
export const state = () => ({ ready: !!session, loading: !!loading && !session, progress, failed });

// get the voice ready (the download, the first time): resolves true when it can speak, false if it can't here
export function load(onProgress) {
  if (session) return Promise.resolve(true);
  if (loading) return loading;
  loading = (async () => {
    try {
      const m = await import(LIB);
      session = await m.TtsSession.create({
        voiceId: VOICE, wasmPaths: WASM,
        progress: p => { if (p?.total && /\.onnx$/.test(p.url || '')) { progress = p.loaded / p.total; onProgress?.(progress); } },
      });
      return true;
    } catch (err) { console.warn('[voice] Piper unavailable', err); failed = true; loading = null; return false; }
  })();
  return loading;
}

function audio() {
  if (!ctx) {
    ctx = new AudioContext(); recDest = ctx.createMediaStreamDestination();
    // a constant, inaudible signal into the recording's line, so its silences are recorded as silence: with nothing
    // playing, Chrome sends the recorder no sound at all and it runs the sentences together, out of step with the picture
    const keep = ctx.createConstantSource(); keep.offset.value = 1e-4; keep.connect(recDest); keep.start();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
export function unlock() { try { audio(); } catch (_) {} }   // (from a click: a page's audio starts only after one)
export function stream() { audio(); return recDest.stream; }   // (what she says, for the recording)

const sentences = t => t.split(/(?<!\b(?:[A-Z]|Mr|Mrs|Ms|Dr|St|Mt|Capt|Gen|Lt|Col|Rev|Jr|Sr|No|vs)\.)(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);   // (not after U.S., Mt., St.…: v1084)
// made one at a time (one model session), in order; a stop() drops what's no longer wanted
function synth(item, g) {
  return chain = chain.then(async () => {
    if (g !== gen) return null;
    const blob = await session.predict(item.s);
    if (g !== gen) return null;
    return audio().decodeAudioData(await blob.arrayBuffer());
  }).catch(err => { console.warn('[voice]', err); return null; });
}
async function pump() {
  if (playing || !queue.length) return;
  const g = gen, item = queue[0];
  playing = item;
  item.buf = item.buf || synth(item, g);
  if (queue[1] && !queue[1].buf) queue[1].buf = synth(queue[1], g);   // (the next one, while this plays)
  const buf = await item.buf;
  if (g !== gen) return;
  queue.shift();
  if (!buf) { playing = null; pump(); return; }
  const src = audio().createBufferSource(); src.buffer = buf;
  src.connect(ctx.destination); src.connect(recDest);
  item.src = src;
  src.onended = () => { if (playing === item) { playing = null; pump(); } };
  src.start();
}

export function say(text) { if (!session || !text) return; for (const s of sentences(text)) queue.push({ s, buf: null }); pump(); }
export function sayImmediate(text) { stop(); say(text); }
export function stop() { gen++; queue = []; try { playing?.src?.stop(); } catch (_) {} playing = null; }
export function isSpeaking() { return !!playing || queue.length > 0; }
