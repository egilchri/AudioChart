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
const titleCase = t => t.toLowerCase().replace(/(^|[\s.'&-])[a-z]/g, c => c.toUpperCase()).replace(/\b(Ii|Iii|Iv)\b/g, r => r.toUpperCase());   // (Maquoit II, Aucocisco III: v993)
// Vessels we know by their full names (the ferries, and the windjammers, v990): AIS cuts a name at 20 characters
// ("CAPT.E.FRANK THOMPSO"), so a broadcast name that begins one of these is that vessel; "SCHOONER", "S/V" and the
// like in front don't count ("SCHOONER MARY DAY" is Mary Day). setKnown([{ name, box?, ...anything }]): one with a box
// ([west, south, east, north]) is only her when she's heard inside it (v998: the Chebeague ferry Independence, a name
// plenty of other boats have).
let known = [];
const letters = t => (t || '').toUpperCase().replace(/^\s*(SCHOONER|WINDJAMMER|KETCH|S\/?V|S\/?Y)\b\.?\s*/, '').replace(/[^A-Z]/g, '');
export function setKnown(list) { known = list.filter(k => k.name).map(k => ({ ...k, key: letters(k.name) })); }
export function knownFor(name, lon, lat) {
  const k = letters(name), out = o => o.box && lon != null && (lon < o.box[0] || lon > o.box[2] || lat < o.box[1] || lat > o.box[3]);
  return k.length >= 6 ? known.find(o => o.key.startsWith(k) && !out(o)) || null : null;
}
const tidy = t => titleCase(t.replace(/\.(?=\S)/g, '. ').replace(/\s*&\s*/g, ' & ')).replace(/^Capt\.? /, 'Captain ');
export const aisName = v => { const k = knownFor(v.name, v.lon, v.lat); return k ? tidy(k.name) : v.name ? tidy(v.name) : `Vessel ${v.mmsi}`; };
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

// ── For the vessel's AIS card (v988, requested: "if I click on a vessel ... a table that shows you all the data
// AIS has on it") ──
// Her flag, from the first three digits of her MMSI (the Maritime Identification Digits); the flags seen on this
// coast, not the whole ITU list.
const MID = [[[338, 366, 367, 368, 369], 'United States'], [[303], 'United States (Alaska)'], [[316], 'Canada'], [[232, 233, 234, 235], 'United Kingdom'],
  [[308, 309, 311], 'Bahamas'], [[310], 'Bermuda'], [[304, 305], 'Antigua and Barbuda'], [[351, 352, 353, 354, 355, 356, 357, 370, 371, 372, 373, 374], 'Panama'],
  [[636, 637], 'Liberia'], [[538], 'Marshall Islands'], [[215, 229, 248, 249, 256], 'Malta'], [[209, 210, 212], 'Cyprus'], [[257, 258, 259], 'Norway'],
  [[219, 220], 'Denmark'], [[211, 218], 'Germany'], [[244, 245, 246], 'Netherlands'], [[226, 227, 228], 'France'], [[237, 239, 240, 241], 'Greece'],
  [[224, 225], 'Spain'], [[247], 'Italy'], [[255, 263], 'Portugal'], [[265, 266], 'Sweden'], [[230], 'Finland'], [[205], 'Belgium'], [[250], 'Ireland'],
  [[251], 'Iceland'], [[563, 564, 565, 566], 'Singapore'], [[477], 'Hong Kong'], [[412, 413, 414], 'China'], [[431, 432], 'Japan'], [[440, 441], 'South Korea'],
  [[341], 'Saint Kitts and Nevis'], [[375, 376, 377], 'Saint Vincent and the Grenadines'], [[378], 'British Virgin Islands'], [[319], 'Cayman Islands']];
export function aisFlag(mmsi) {
  const m = String(mmsi || '');
  if (!/^[2-7]\d{8}$/.test(m)) return '';   // (a coast station, a craft's AIS-SART, an aid to navigation: no flag)
  const mid = Number(m.slice(0, 3));
  return MID.find(([ids]) => ids.includes(mid))?.[1] || `MID ${mid}`;
}
// rate of turn: AIS sends it as 4.733 × √(degrees a minute), signed (+ to starboard); ±127, turning but unmeasured
export function aisRot(r) {
  if (r == null) return '';
  if (r === 0) return 'Steady';
  if (Math.abs(r) >= 127) return `Turning to ${r > 0 ? 'starboard' : 'port'}`;
  const dpm = (r / 4.733) ** 2;
  return `${dpm < 10 ? dpm.toFixed(1) : Math.round(dpm)}° a minute to ${r > 0 ? 'starboard' : 'port'}`;
}
const dm = (v, pos, neg, w) => { const a = Math.abs(v), d = Math.floor(a); return `${String(d).padStart(w, '0')}°${((a - d) * 60).toFixed(2).padStart(5, '0')}′${v >= 0 ? pos : neg}`; };
export const aisPos = (lat, lon) => `${dm(lat, 'N', 'S', 2)} ${dm(lon, 'E', 'W', 3)}`;
export const aisAgo = s => s < 60 ? `${Math.max(1, Math.round(s))} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`;
// VesselFinder (v995): its pages are keyed by MMSI; MarineTraffic's mmsi: URLs didn't land on the vessel (its
// pages go by its own ship id, which AIS doesn't carry)
export const aisLookup = mmsi => `https://www.vesselfinder.com/vessels/details/${mmsi}`;
// her IMO number, only if it's a real one (v989): 7 digits, the last a check digit on the first six; AIS often
// carries placeholders (0, 999999999, the MMSI)
export function aisImo(n) {
  const s = String(n ?? '');
  if (!/^\d{7}$/.test(s)) return '';
  const d = [...s].map(Number);
  return (d[0] * 7 + d[1] * 6 + d[2] * 5 + d[3] * 4 + d[4] * 3 + d[5] * 2) % 10 === d[6] ? s : '';
}
// a call sign that's a call sign (not "0", "NONE" or a run of one character)
export const aisCallsign = c => /^[A-Z0-9]{3,7}$/i.test(c || '') && !/^(.)\1+$/.test(c) && !/^NONE$/i.test(c) ? c.toUpperCase() : '';
