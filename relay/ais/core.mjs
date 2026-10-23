// Live AIS for AudioChart's 3D views: the vessel table the relay keeps from AISStream's feed (aisstream.io).
// Shared by the Cloudflare Worker (worker.mjs) and the local relay (dev.mjs). AISStream doesn't let a browser
// connect (the account key would be in the page), so the relay holds the key, keeps one upstream connection for
// the bay, and serves the vessels it has heard as JSON.

// Penobscot Bay and its approaches, a little wider than Bird's-eye's overview ([lat, lon] corners)
export const BOX = [[43.6, -69.6], [44.9, -67.8]];
export const TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
export const subscription = key => JSON.stringify({ APIKey: key, BoundingBoxes: [BOX], FilterMessageTypes: TYPES });

const MOVING_KEEP = 15 * 60e3, STILL_KEEP = 40 * 60e3;   // a vessel not heard from in this long is dropped
const clean = s => typeof s === 'string' ? s.replace(/@+$/, '').replace(/\s+/g, ' ').trim() : '';
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const dims = d => d && (d.A + d.B > 0) ? { L: d.A + d.B, B: (d.C + d.D) || null } : null;
// her ETA as 'MM-DD HH:MM' (AIS's 0 month, 0 day, hour 24 and minute 60 mean not given)
const etaOf = e => e && e.Month > 0 && e.Month <= 12 && e.Day > 0 ? `${String(e.Month).padStart(2, '0')}-${String(e.Day).padStart(2, '0')}${e.Hour < 24 && e.Minute < 60 ? ` ${String(e.Hour).padStart(2, '0')}:${String(e.Minute).padStart(2, '0')}` : ''}` : null;
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
      const s = get(mmsi), sog = num(body.Sog), cog = num(body.Cog), hdg = num(body.TrueHeading);
      Object.assign(s, { lat, lon, at: now, sog: sog != null && sog < 102.3 ? sog : null, cog: cog != null && cog < 360 ? cog : null, hdg: hdg != null && hdg < 360 ? hdg : null });
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
  function snapshot(now = Date.now()) {
    const vessels = [];
    for (const [mmsi, s] of ships) {
      if (s.at == null) continue;
      const still = (s.sog ?? 0) < 0.5 || s.status === 1 || s.status === 5;
      if (now - s.at > (still ? STILL_KEEP : MOVING_KEEP)) { delete s.lat; delete s.lon; delete s.at; continue; }
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
