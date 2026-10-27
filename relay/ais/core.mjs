// Live AIS for AudioChart's 3D views: the vessel table the relay keeps from AISStream's feed (aisstream.io) and
// Open Waters' (openwaters.io/ais, v1011), which adds AISHub's receivers. Shared by the Cloudflare Worker
// (worker.mjs) and the local relay (dev.mjs). Neither feed lets a browser connect (the key would be in the page),
// so the relay holds the keys, keeps one upstream connection to each for both bays, and serves the vessels it has
// heard as JSON.

// Penobscot Bay and its approaches, Casco Bay (v994), San Francisco Bay (v1019), the Piscataqua (v1028) and New York Harbor (v1032), each a little wider
// than Bird's-eye's overview of it ([lat, lon] corners; www/js/regions3d.js). One upstream connection listens to all.
export const BOX = [[43.6, -69.6], [44.9, -67.8]];
export const CASCO_BOX = [[43.4, -70.6], [44.05, -69.6]];
export const SF_BOX = [[37.35, -122.75], [38.25, -121.95]];
export const PISCATAQUA_BOX = [[42.8, -71.05], [43.3, -70.4]];   // (v1028)
export const NYC_BOX = [[40.35, -74.4], [41.05, -73.55]];   // (v1032)
export const BOXES = [BOX, CASCO_BOX, SF_BOX, PISCATAQUA_BOX, NYC_BOX];
// ?bbox=w,s,e,n on /vessels (v1019): only the vessels in it (the app asks for its own bay's; San Francisco's
// hundreds needn't go to a viewer in Maine). Without it, all of them, as before.
export function bboxOf(url) {
  const b = new URL(url, 'http://x').searchParams.get('bbox')?.split(',').map(Number);
  return b?.length === 4 && b.every(Number.isFinite) ? b : null;
}
export const TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
export const subscription = key => JSON.stringify({ APIKey: key, BoundingBoxes: BOXES, FilterMessageTypes: TYPES });
// The upstream feeds, each in AISStream's wire format (Open Waters' /v0/stream is a drop-in for it). A feed whose
// key isn't set is skipped. Open Waters is free on a personal token; its AISHub reports must be credited (CREDIT).
export const FEEDS = [
  { name: 'aisstream', url: 'wss://stream.aisstream.io/v0/stream', key: 'AISSTREAM_KEY' },
  { name: 'openwaters', url: 'wss://ais.openwaters.io/v0/stream', key: 'OPENWATERS_KEY' },
];

const MOVING_KEEP = 15 * 60e3, STILL_KEEP = 40 * 60e3;   // a vessel not heard from in this long is dropped
const clean = s => typeof s === 'string' ? s.replace(/@+$/, '').replace(/\s+/g, ' ').trim() : '';
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const dims = d => d && (d.A + d.B > 0) ? { L: d.A + d.B, B: (d.C + d.D) || null } : null;
// her ETA as 'MM-DD HH:MM' (AIS's 0 month, 0 day, hour 24 and minute 60 mean not given)
const etaOf = e => e && e.Month > 0 && e.Month <= 12 && e.Day > 0 ? `${String(e.Month).padStart(2, '0')}-${String(e.Day).padStart(2, '0')}${e.Hour < 24 && e.Minute < 60 ? ` ${String(e.Hour).padStart(2, '0')}:${String(e.Minute).padStart(2, '0')}` : ''}` : null;
// when she was heard, from the feed's 'YYYY-MM-DD HH:MM:SS[.fff…] +0000 UTC' (never later than now)
const heardAt = (meta, now) => {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d{1,3})?\d* \+0000/.exec(meta.time_utc || ''), t = m ? Date.parse(`${m[1]}T${m[2]}${m[3] || ''}Z`) : NaN;
  return Number.isFinite(t) ? Math.min(t, now) : now;
};
const STATIC = ['name', 'type', 'L', 'B', 'dest', 'callsign', 'imo', 'draught', 'eta'];

export function makeTable({ onStatic } = {}) {
  const ships = new Map();   // mmsi -> { mmsi, at, lat, lon, sog, cog, hdg, rot, acc, status, and the STATIC fields }
  const get = mmsi => { let s = ships.get(mmsi); if (!s) ships.set(mmsi, s = { mmsi }); return s; };
  function setStatic(mmsi, st) {   // name, type and size: kept apart from position, so they survive a restart
    const s = get(mmsi), pick = () => Object.fromEntries(STATIC.map(k => [k, s[k] ?? null])), before = JSON.stringify(pick());
    for (const k of STATIC) if (st[k] != null && st[k] !== '' && st[k] !== 0) s[k] = st[k];
    if (onStatic && JSON.stringify(pick()) !== before) onStatic(mmsi, pick());
  }
  function ingest(msg, now = Date.now()) {
    const t = msg?.MessageType, body = msg?.Message?.[t], meta = msg?.MetaData || {};
    if (!body) return;
    const mmsi = String(meta.MMSI ?? body.UserID ?? '');
    if (!/^\d{9}$/.test(mmsi)) return;
    if (t === 'PositionReport' || t === 'StandardClassBPositionReport' || t === 'ExtendedClassBPositionReport') {
      const lat = num(body.Latitude ?? meta.latitude ?? meta.Latitude), lon = num(body.Longitude ?? meta.longitude ?? meta.Longitude);
      if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      // Two feeds hear the same vessels, Open Waters' AISHub reports a minute or so late: keep the newest report
      const at = heardAt(meta, now), s = get(mmsi);
      if (s.at != null && at <= s.at) { if (!s.name && clean(meta.ShipName)) s.name = clean(meta.ShipName); return; }
      const sog = num(body.Sog), cog = num(body.Cog), hdg = num(body.TrueHeading);
      Object.assign(s, { lat, lon, at, sog: sog != null && sog < 102.3 ? sog : null, cog: cog != null && cog < 360 ? cog : null, hdg: hdg != null && hdg < 360 ? hdg : null });
      if (t === 'PositionReport') { s.status = num(body.NavigationalStatus); const r = num(body.RateOfTurn); s.rot = r != null && r !== -128 ? r : null; }
      if (typeof body.PositionAccuracy === 'boolean') s.acc = body.PositionAccuracy;
      if (!s.name && clean(meta.ShipName)) s.name = clean(meta.ShipName);
      if (t === 'ExtendedClassBPositionReport') setStatic(mmsi, { name: clean(body.Name), type: num(body.Type), ...dims(body.Dimension) });
    } else if (t === 'ShipStaticData') {
      const dr = num(body.MaximumStaticDraught);
      setStatic(mmsi, { name: clean(body.Name), type: num(body.Type), dest: clean(body.Destination), callsign: clean(body.CallSign), imo: num(body.ImoNumber), draught: dr > 0 ? dr : null, eta: etaOf(body.Eta), ...dims(body.Dimension) });
    } else if (t === 'StaticDataReport') {   // Class B, in two parts
      if (body.ReportA?.Valid) setStatic(mmsi, { name: clean(body.ReportA.Name) });
      if (body.ReportB?.Valid) setStatic(mmsi, { type: num(body.ReportB.ShipType), callsign: clean(body.ReportB.CallSign), ...dims(body.ReportB.Dimension) });
    }
  }
  function snapshot(now = Date.now(), bbox = null) {
    const vessels = [];
    for (const [mmsi, s] of ships) {
      if (s.at == null) continue;
      const still = (s.sog ?? 0) < 0.5 || s.status === 1 || s.status === 5;
      if (now - s.at > (still ? STILL_KEEP : MOVING_KEEP)) { delete s.lat; delete s.lon; delete s.at; continue; }
      if (bbox && !(s.lon >= bbox[0] && s.lat >= bbox[1] && s.lon <= bbox[2] && s.lat <= bbox[3])) continue;
      vessels.push({ mmsi, name: s.name || '', lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5), sog: s.sog, cog: s.cog == null ? null : +s.cog.toFixed(1), hdg: s.hdg, status: s.status ?? null, type: s.type ?? null, L: s.L ?? null, B: s.B ?? null, dest: s.dest || '', callsign: s.callsign || '', imo: s.imo ?? null, draught: s.draught ?? null, eta: s.eta ?? null, rot: s.rot ?? null, acc: s.acc ?? null, age: Math.round((now - s.at) / 1000) });
    }
    return { t: now, vessels };
  }
  return { ships, ingest, snapshot, setStatic };
}

// The relay's answer to the app: CORS open to AudioChart's pages (and a local server while developing)
export const ORIGINS = [/^https:\/\/egilchri\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
export function corsHeaders(origin) {
  const ok = origin && ORIGINS.some(r => r.test(origin));
  return { 'Access-Control-Allow-Origin': ok ? origin : 'https://egilchri.github.io', 'Vary': 'Origin', 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
}
