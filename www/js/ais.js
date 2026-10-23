// Live AIS (v986, requested: "add AIS data, in real time, for boats and ships broadcasting a signal", starting
// with an internet feed for the armchair views). The vessels come from AudioChart's relay (relay/ais/), which
// holds the AISStream key and keeps one upstream connection for the bay; this asks it for the vessels every few
// seconds while Live is on. With no internet, or no relay, it says so and there are simply no live vessels.
// ?ais=<relay url> or localStorage 'audiochart-ais-relay' points it at another relay (relay/ais/dev.mjs).

export const RELAY_DEFAULT = 'https://audiochart-ais.egilchri.workers.dev';
const RELAY_KEY = 'audiochart-ais-relay';
export function relayUrl() {
  try { const q = new URLSearchParams(location.search).get('ais'); if (q) return q.replace(/\/$/, ''); } catch (_) {}
  try { const s = localStorage.getItem(RELAY_KEY); if (s) return s.replace(/\/$/, ''); } catch (_) {}
  return RELAY_DEFAULT;
}

// What she is, from the AIS ship type (and her length when the type's missing): the model to draw her with,
// and a word for the lists. https://api.vtexplorer.com/docs/ref-aistypes.html
export function aisClass(type, L) {
  const t = type || 0, len = L || 0;
  if (t === 36) return { model: 'sail', what: 'Sailing vessel' };
  if (t === 37) return { model: len > 14 ? 'launch' : 'power', what: 'Pleasure craft' };
  if (t === 30) return { model: 'power', what: 'Fishing vessel' };
  if (t === 31 || t === 32 || t === 52) return { model: len > 45 ? 'ship' : 'launch', what: 'Tug' };
  if (t === 50) return { model: 'launch', what: 'Pilot boat' };
  if (t === 51) return { model: 'launch', what: 'Search and rescue' };
  if (t === 55) return { model: 'launch', what: 'Law enforcement' };
  if (t === 35) return { model: len > 60 ? 'ship' : 'launch', what: 'Military vessel' };
  if (t === 33) return { model: 'ship', what: 'Dredger' };
  if (t >= 40 && t <= 49) return { model: 'launch', what: 'High-speed craft' };
  if (t >= 60 && t <= 69) return { model: len > 110 ? 'cruise' : len >= 25 ? 'ferry' : 'launch', what: len > 110 ? 'Cruise ship' : 'Passenger vessel' };
  if (t >= 70 && t <= 79) return { model: 'ship', what: 'Cargo ship' };
  if (t >= 80 && t <= 89) return { model: 'ship', what: 'Tanker' };
  return { model: len > 60 ? 'ship' : len > 14 ? 'launch' : 'power', what: 'Vessel' };
}
const STATUS = { 0: 'under way', 1: 'at anchor', 2: 'not under command', 3: 'restricted in her ability to manoeuvre', 5: 'moored', 7: 'fishing', 8: 'under sail' };
export const aisStatus = s => STATUS[s] || '';
const titleCase = t => t.toLowerCase().replace(/(^|[\s.'&-])[a-z]/g, c => c.toUpperCase());
// Vessels we know by their full names (the ferries): AIS cuts a name at 20 characters ("CAPT.E.FRANK THOMPSO"),
// so a broadcast name that begins one of these is that vessel. setKnown([{ name, ...anything }]).
let known = [];
const letters = t => (t || '').toUpperCase().replace(/[^A-Z]/g, '');
export function setKnown(list) { known = list.filter(k => k.name).map(k => ({ ...k, key: letters(k.name) })); }
export function knownFor(name) { const k = letters(name); return k.length >= 6 ? known.find(o => o.key.startsWith(k)) || null : null; }
const tidy = t => titleCase(t.replace(/\.(?=\S)/g, '. ').replace(/\s*&\s*/g, ' & ')).replace(/^Capt\.? /, 'Captain ');
export const aisName = v => { const k = knownFor(v.name); return k ? tidy(k.name) : v.name ? tidy(v.name) : `Vessel ${v.mmsi}`; };
// where she says she's bound, if it reads as a place (a destination field often holds codes or garbage)
export const aisDest = d => /^[A-Z][A-Z .,&'\/-]{2,}$/i.test(d || '') && /[A-Z]{4}/i.test(d) ? tidy(d) : '';

// The feed: polls the relay while on. onData({ vessels, t }) with each answer; onState({ state, note }) with
// 'listening' (connected, nothing heard yet), 'live', or 'offline' (no internet, or the relay's not there).
export function makeAisFeed({ onData, onState, every = 10000 }) {
  let on = false, timer = null, inflight = null, state = '';
  const say = (s, note = '') => { if (s !== state || note) { state = s; onState?.({ state: s, note }); } };
  async function poll() {
    if (!on) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { say('offline', 'No internet connection'); return schedule(); }
    const ctl = new AbortController(); inflight = ctl;
    const kill = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(relayUrl() + '/vessels', { signal: ctl.signal, cache: 'no-store' });
      const j = await r.json();
      if (!on) return;
      if (!r.ok || j.error && !j.vessels?.length) { say('offline', j.error || `Relay answered ${r.status}`); }
      else { onData?.(j); say(j.vessels.length ? 'live' : 'listening', j.vessels.length ? '' : 'Listening for ships…'); }
    } catch (e) {
      if (on) say('offline', 'Live AIS needs an internet connection');
    } finally { clearTimeout(kill); if (inflight === ctl) inflight = null; }
    schedule();
  }
  function schedule() { clearTimeout(timer); if (on) timer = setTimeout(poll, every); }
  return {
    start() { if (on) return; on = true; say('listening', 'Connecting…'); poll(); },
    stop() { on = false; clearTimeout(timer); inflight?.abort(); say('off'); },
    get on() { return on; },
  };
}
