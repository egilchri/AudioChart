// Live AIS for AudioChart's 3D views: the vessel table the relay keeps from AISStream's feed (aisstream.io) and
// Open Waters' (openwaters.io/ais, v1011), which adds AISHub's receivers. Shared by the Cloudflare Worker
// (worker.mjs) and the local relay (dev.mjs). Neither feed lets a browser connect (the key would be in the page),
// so the relay holds the keys, keeps one upstream connection to each for both bays, and serves the vessels it has
// heard as JSON.

// Penobscot Bay and its approaches, Casco Bay (v994), San Francisco Bay (v1019), the Piscataqua (v1028), New York Harbor (v1032) and Boston Harbor (v1138), each a little wider
// than Bird's-eye's overview of it ([lat, lon] corners; www/js/regions3d.js). One upstream connection listens to all.
export const BOX = [[43.6, -69.6], [44.9, -67.8]];
export const CASCO_BOX = [[43.4, -70.6], [44.05, -69.6]];
export const SF_BOX = [[37.35, -122.75], [38.25, -121.95]];
export const PISCATAQUA_BOX = [[42.8, -71.05], [43.3, -70.4]];   // (v1028)
export const NYC_BOX = [[40.35, -74.4], [41.05, -73.55]];   // (v1032)
export const BOSTON_BOX = [[42.1, -71.3], [42.6, -70.65]];   // (v1138)
// Two relays from this code (v1153): AudioChart's boaters' (Maine's bays, both feeds) and Ted's Birdseye's
// (worker.mjs ROLE 'birdseye': the armchair bays, AISStream only, with /trains and /aircraft), so Bird's-eye's
// releases never restart the relay a boater's Live AIS comes from. dev.mjs (local) listens to them all.
export const MAINE_BOXES = [BOX, CASCO_BOX, PISCATAQUA_BOX];
export const ARMCHAIR_BOXES = [SF_BOX, NYC_BOX, BOSTON_BOX];
export const BOXES = [...MAINE_BOXES, ...ARMCHAIR_BOXES];
// ?bbox=w,s,e,n on /vessels (v1019): only the vessels in it (the app asks for its own bay's; San Francisco's
// hundreds needn't go to a viewer in Maine). Without it, all of them, as before.
export function bboxOf(url) {
  const b = new URL(url, 'http://x').searchParams.get('bbox')?.split(',').map(Number);
  return b?.length === 4 && b.every(Number.isFinite) ? b : null;
}
export const TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
export const subscription = (key, boxes = BOXES) => JSON.stringify({ APIKey: key, BoundingBoxes: boxes, FilterMessageTypes: TYPES });
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

// ── Aircraft (ADS-B), the air's AIS: GET /aircraft?bbox=w,s,e,n ──
// From adsb.lol's open API (api.adsb.lol, ODbL: credit it), which needs no key but sends no CORS header, so the
// page asks through the relay. One circle round the box's middle that takes in its corners (adsb.lol caps the
// radius at 250 nm), then only the aircraft in the box, trimmed to what Bird's-eye draws.
export const ADSB_CREDIT = 'Aircraft from adsb.lol (ODbL)';
export function aircraftUpstream(bbox) {
  const [w, s, e, n] = bbox, lat = (s + n) / 2, lon = (w + e) / 2;
  const nm = Math.hypot((n - s) / 2 * 60, (e - w) / 2 * 60 * Math.cos(lat * Math.PI / 180));
  return `https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${Math.min(250, Math.ceil(nm))}`;
}
// Her height above the sea (v1113). ADS-B's geometric altitude is above the WGS84 ellipsoid, not the sea: round the
// bays the geoid is 26–33 m under it, so every aircraft flew ~100 ft low and one landing at SFO went under the
// runway (reported: "after this plane landed, it flew under the surface of the runway", at −100 ft). The geoid's
// height (EGM96, m) at the bays we serve, weighted by nearness; her pressure altitude, set right for the day's
// pressure (nav_qnh, ~27 ft a hectopascal), when she sends no geometric one.
const GEOID = [[37.62, -122.38, -32.3], [38.1, -122.5, -31.6], [37.3, -121.9, -32.6], [40.7, -74.0, -32.8], [43.07, -70.76, -28.5], [43.66, -70.26, -27.4], [44.1, -69.1, -26.1], [44.4, -68.2, -25.0]];
export function geoidN(lat, lon) {
  let w = 0, v = 0;
  for (const [la, lo, n] of GEOID) { const d = Math.hypot(la - lat, (lo - lon) * Math.cos(lat * Math.PI / 180)), k = 1 / (d * d + 1e-4); w += k; v += k * n; }
  return v / w;
}
export function seaAlt(a, lat, lon) {
  const geom = num(a.alt_geom), baro = num(a.alt_baro), qnh = num(a.nav_qnh);
  if (geom != null) return Math.round(geom - geoidN(lat, lon) / 0.3048);
  if (baro != null) return Math.round(baro + (qnh && qnh > 950 && qnh < 1060 ? (qnh - 1013.25) * 27.3 : 0));
  return null;
}
export function trimAircraft(j, bbox, now = Date.now()) {
  const out = [];
  for (const a of j?.ac || []) {
    const lat = num(a.lat), lon = num(a.lon);
    if (lat == null || lon == null || (a.seen_pos ?? 0) > 60) continue;
    if (bbox && !(lon >= bbox[0] && lat >= bbox[1] && lon <= bbox[2] && lat <= bbox[3])) continue;
    const ground = a.alt_baro === 'ground';
    out.push({ hex: a.hex, flight: clean(a.flight), reg: clean(a.r), type: clean(a.t), cat: a.category || '',
      lat: +lat.toFixed(5), lon: +lon.toFixed(5), alt: ground ? 0 : seaAlt(a, lat, lon), msl: 1, ground,
      gs: num(a.gs), trk: num(a.track) ?? num(a.true_heading), vr: num(a.geom_rate) ?? num(a.baro_rate), squawk: a.squawk || '',
      age: Math.round(a.seen_pos ?? a.seen ?? 0) });
  }
  return { t: now, aircraft: out };
}

// ── Trains: GET /trains?bbox=w,s,e,n (v1099) ──
// Commuter rail's live positions from 511.org's SIRI VehicleMonitoring (a 511 Open Data key, FIVE11_KEY, held by
// the relay). 511 allows 60 requests an hour per key, so each railroad is asked only every `ttl` seconds, whoever
// is watching: Caltrain every 90 s (40/h), SMART and ACE every 5 and 10 min (12/h and 6/h): 58 an hour at most.
// 511's Bearing is always 0 (2026-11-02): the app takes her heading from her last two positions.
export const NYC_BBOX = [-74.35, 40.4, -73.6, 41.0];   // ([w, s, e, n]: www/js/regions3d.js new-york-harbor's overview)
export const RAIL = [
  { id: 'CT', name: 'Caltrain', ttl: 90 },
  { id: 'SA', name: 'SMART', ttl: 300 },
  { id: 'CE', name: 'ACE', ttl: 600 },
  // (v1121, asked from a seat on one: Amtrak, every train in the country (the Capitol Corridor, San Joaquins, Coast
  // Starlight and Zephyr here; the Downeaster in Maine), from Amtraker (amtraker.com, Amtrak's own Track Your Train
  // made readable; no key, and not 511's quota). Amtrak updates a train about every 5 min; asked every 2)
  { id: 'AM', name: 'Amtrak', ttl: 120, url: () => 'https://api-v3.amtraker.com/v3/trains', trim: (text, rail, now) => trimAmtrak(text, rail, now) },
  // (v1138, Boston: "airport, trains, maybe the 'T'"): the MBTA's commuter rail, subway and Green Line trolleys, from its
  // own V3 API (no key needed at 20 asks a minute; with MBTA_KEY set as a secret, 1000). Every vehicle in one ask.
  { id: 'MB', name: 'MBTA', ttl: 20, url: () => 'https://api-v3.mbta.com/vehicles?filter%5Broute_type%5D=0,1,2&include=trip,stop,route'
      + '&fields%5Bvehicle%5D=latitude,longitude,bearing,current_status,label,speed,updated_at,direction_id&fields%5Btrip%5D=headsign,name'
      + '&fields%5Bstop%5D=name&fields%5Broute%5D=long_name,short_name,type,direction_destinations',
    headers: env => env?.MBTA_KEY ? { 'x-api-key': env.MBTA_KEY } : {}, trim: (text, rail, now) => trimMbta(text, rail, now) },
  // (v1154, New York: "I don't think we've done New York Subways, have we?") the subway and the Staten Island Railway,
  // from the MTA's own GTFS-realtime feeds (no key), one per group of lines; protobuf, so `binary`. Asked only when
  // someone's looking at New York (`box`).
  ...['', '-ace', '-bdfm', '-g', '-jz', '-nqrw', '-l', '-si'].map(f => ({ id: 'NY' + (f.slice(1) || '1234567'), name: 'NYC Subway', ttl: 30, binary: true, box: NYC_BBOX,
    url: () => `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs${f}`, trim: async (buf, rail, now) => trimNyct(buf, rail, now, await nycData()) })),
  // (v1160, "do PATH and the LIRR next") the LIRR: the MTA's feed, each train's own place (GPS); her branch from her trip
  { id: 'LI', name: 'LIRR', ttl: 30, binary: true, box: NYC_BBOX, url: () => 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr',
    trim: async (buf, rail, now) => trimLirr(buf, rail, now, await lirrData()) },
  // (v1163) Metro-North: the MTA's feed for it, her own place by GPS (those running; the rest are only timetabled)
  { id: 'MN', name: 'Metro-North', ttl: 30, binary: true, box: NYC_BBOX, url: () => 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr',
    trim: async (buf, rail, now) => trimMnr(buf, rail, now, await mnrData()) },
  // PATH: the Port Authority's next trains at each station; her place worked out from them (trimPath)
  { id: 'PA', name: 'PATH', ttl: 30, box: NYC_BBOX, url: () => 'https://www.panynj.gov/bin/portauthority/ridepath.json',
    trim: async (text, rail, now) => trimPath(text, rail, now, await pathData()) },
];
// The MBTA's answer (JSON:API) to its trains, in the shape the others are: the T's lines by their own names (the
// Red Line, the Green Line's B to E, Mattapan), the commuter rail as "Commuter Rail" with her line (Worcester Line)
const MBTA_T = { Red: 'Red Line', Orange: 'Orange Line', Blue: 'Blue Line', Mattapan: 'Mattapan Trolley' };
export function trimMbta(text, rail, now = Date.now()) {
  let j; try { j = JSON.parse(text); } catch (_) { return []; }
  const inc = {}; for (const x of j?.included || []) inc[`${x.type}:${x.id}`] = x.attributes || {};
  const out = [];
  for (const v of j?.data || []) {
    const a = v.attributes || {}, lat = Number(a.latitude), lon = Number(a.longitude), R = v.relationships || {};
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const rid = R.route?.data?.id || '', route = inc[`route:${rid}`] || {}, trip = inc[`trip:${R.trip?.data?.id}`] || {}, stop = inc[`stop:${R.stop?.data?.id}`] || {};
    const cr = rid.startsWith('CR-'), green = rid.startsWith('Green-');
    const name = cr ? 'Commuter Rail' : green ? 'Green Line' : MBTA_T[rid] || route.long_name || rid;
    const line = cr ? clean(route.long_name || rid.slice(3)) : green ? `${rid.slice(6)} branch` : '';
    const at = Date.parse(a.updated_at || ''), mps = Number(a.speed);
    out.push({ id: `${rail.id}:${v.id}`, rail: name, line, trip: clean(trip.name || ''), dest: clean(trip.headsign || route.direction_destinations?.[a.direction_id] || ''),
      dir: '', lat: +lat.toFixed(5), lon: +lon.toFixed(5), brg: num(Number(a.bearing)), at: Number.isFinite(at) ? Math.min(at, now) : now,
      mph: Number.isFinite(mps) && a.speed != null ? +(mps * 2.23694).toFixed(1) : null, car: clean(a.label || ''),
      from: '', next: clean(stop.name || ''), atStop: a.current_status === 'STOPPED_AT' });
  }
  return out;
}
export const TRAIN_CREDIT = 'Trains from 511.org';
export const railUpstream = (id, key) => `https://api.511.org/transit/VehicleMonitoring?api_key=${encodeURIComponent(key)}&agency=${id}&format=json`;
const ms = v => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };
function callsOf(m) {   // her next stop (MonitoredCall) and her last (OnwardCalls' last, or DestinationAimedArrivalTime)
  const one = v => Array.isArray(v) ? v[0] : v, mc = m.MonitoredCall || {}, oc = m.OnwardCalls?.OnwardCall, onward = Array.isArray(oc) ? oc : oc ? [oc] : [], last = onward[onward.length - 1] || {};
  return { next: clean(one(mc.StopPointName) || ''), nextAim: ms(mc.AimedArrivalTime || mc.AimedDepartureTime), nextExp: ms(mc.ExpectedArrivalTime || mc.ExpectedDepartureTime), atStop: mc.VehicleAtStop === true || mc.VehicleAtStop === 'true',
    destAim: ms(last.AimedArrivalTime || m.DestinationAimedArrivalTime), destExp: ms(last.ExpectedArrivalTime), fromAim: ms(m.OriginAimedDepartureTime) };
}
// Amtraker's answer to the trains in it, in the shape 511's are (trimTrains), with her speed (mph) as Amtrak gives it
const HEADING = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
export function trimAmtrak(text, rail, now = Date.now()) {
  let j; try { j = JSON.parse(text); } catch (_) { return []; }
  const out = [];
  for (const t of Object.values(j || {}).flat()) {
    const lat = Number(t?.lat), lon = Number(t?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || t.trainState === 'Completed') continue;
    const S = t.stations || [], nx = S.find(s => s.status !== 'Departed') || S[S.length - 1] || {}, last = S[S.length - 1] || {}, first = S[0] || {};
    const at = Date.parse(t.lastValTS || t.updatedAt || ''), mph = Number(t.velocity);
    out.push({ id: `${rail.id}:${t.trainID || t.trainNum}`, rail: rail.name, line: clean(t.routeName || ''), trip: String(t.trainNum || ''),
      dest: clean(t.destName || ''), dir: t.heading || '', lat: +lat.toFixed(5), lon: +lon.toFixed(5), brg: HEADING[t.heading] ?? null,
      at: Number.isFinite(at) ? Math.min(at, now) : now, mph: Number.isFinite(mph) ? +mph.toFixed(1) : null,
      from: clean(t.origName || ''), next: clean(nx.name || ''), nextAim: ms(nx.schArr || nx.schDep), nextExp: ms(nx.arr || nx.dep),
      atStop: nx.status === 'Station' || t.trainState === 'Predeparture', destAim: ms(last.schArr), destExp: ms(last.arr), fromAim: ms(first.schDep) });
  }
  return out;
}
// SIRI's answer (with a byte-order mark first) to the trains in it
export function trimTrains(text, rail, now = Date.now()) {
  let j; try { j = JSON.parse(String(text).replace(/^﻿/, '')); } catch (_) { return []; }
  const del = j?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery, acts = (Array.isArray(del) ? del : [del]).flatMap(d => d?.VehicleActivity || []);
  const out = [];
  for (const va of acts) {
    const m = va?.MonitoredVehicleJourney, loc = m?.VehicleLocation, lat = Number(loc?.Latitude), lon = Number(loc?.Longitude);
    if (!m || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    // (SMART reports every railcar, parked ones too: only those on a run, with a line or a destination)
    if (!(Array.isArray(m.PublishedLineName) ? m.PublishedLineName[0] : m.PublishedLineName) && !m.LineRef && !(Array.isArray(m.DestinationName) ? m.DestinationName[0] : m.DestinationName)) continue;
    const at = Date.parse(va.RecordedAtTime || ''), one = v => Array.isArray(v) ? v[0] : v;
    out.push({ id: `${rail.id}:${m.VehicleRef || m.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || out.length}`, rail: rail.name,
      line: clean(one(m.PublishedLineName) || m.LineRef || ''), trip: clean(m.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || ''),
      dest: clean(one(m.DestinationName) || ''), dir: clean(m.DirectionRef || ''), lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      brg: num(Number(m.Bearing)), at: Number.isFinite(at) ? Math.min(at, now) : now,
      // (v1117, requested: "their destination, their origin, and the ETA"): where she set out from, her next stop and
      // when she's due there, and when she's due at the end of her run (aimed, and expected where 511 says)
      from: clean(one(m.OriginName) || ''), ...callsOf(m) });
  }
  return out;
}

// ---- New York's subway (v1154) ----
// The MTA's feeds give no positions: a train is STOPPED_AT a station, or INCOMING_AT / IN_TRANSIT_TO the next, with
// the times she's due at each stop ahead. Her route pattern's path and stops (www/data/rail/nyc-subway.json, built
// by design/rail/build_nyc_subway.py from the MTA's static GTFS) put her on it: at her station, or between her last
// and her next by how soon she's due. The page then lays her on OpenStreetMap's track, as every train.
export const NYC_DATA_URL = 'https://egilchri.github.io/AudioChart/data/rail/nyc-subway.json';
let nycPromise = null;
export function nycData(load = () => fetch(NYC_DATA_URL).then(r => { if (!r.ok) throw new Error(`nyc-subway.json ${r.status}`); return r.json(); })) {
  return nycPromise ||= load().then(prepNyc).catch(e => { nycPromise = null; throw e; });
}
const metres = (a, b) => { const k = Math.cos((a[1] + b[1]) / 2 * Math.PI / 180); return Math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 110540); };
export function prepNyc(j) {
  const byKey = new Map();   // 'A..S' → its paths
  for (const [sid, sh] of Object.entries(j.shapes)) {
    sh.id = sid; sh.cum = [0]; for (let i = 1; i < sh.p.length; i++) sh.cum.push(sh.cum[i - 1] + metres(sh.p[i - 1], sh.p[i]));
    sh.at = new Map(sh.s.map(([st, d], i) => [st, i]));
    const m = sid.match(/^(.+?)\.\.([NS])/), k = m ? `${m[1]}..${m[2]}` : sid;
    (byKey.get(k) || byKey.set(k, []).get(k)).push(sh);
  }
  return { stops: j.stops, shapes: j.shapes, byKey };
}
// a point and heading `d` metres along a path
function along(sh, d) {
  const c = sh.cum, n = c.length; d = Math.max(0, Math.min(c[n - 1], d));
  let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m; }
  const a = sh.p[lo], b = sh.p[hi], t = c[hi] > c[lo] ? (d - c[lo]) / (c[hi] - c[lo]) : 0, k = Math.cos(a[1] * Math.PI / 180);
  const brg = (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180 / Math.PI + 360) % 360;
  return { lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, brg };
}
// the path she's on: her trip's own pattern ('A..S58R'), else the one of her line and direction that has her next
// stops (a trip id gives only 'A..S' at times)
function pathFor(nyc, tripId, route, stops) {
  const key = tripId.slice(tripId.indexOf('_') + 1);
  if (nyc.shapes[key]) return nyc.shapes[key];
  const dir = (key.match(/\.\.([NS])/) || [])[1] || (stops[0] || '').slice(-1), cands = nyc.byKey.get(`${route}..${dir}`) || [];
  let best = null, score = 0;
  for (const sh of cands) { const n = stops.filter(st => sh.at.has(st.slice(0, -1))).length; if (n > score) { best = sh; score = n; } }
  return best;
}
// the MTA's protobuf, read by field number (GTFS-realtime: FeedMessage 2 entity; FeedEntity 3 trip_update, 4 vehicle;
// TripDescriptor 1 trip_id, 5 route_id; VehiclePosition 1 trip, 3 stop sequence, 4 status, 5 timestamp, 7 stop_id;
// TripUpdate 1 trip, 2 stop_time_update; StopTimeUpdate 2 arrival, 3 departure, 4 stop_id; StopTimeEvent 2 time)
export function pbRead(buf, s = 0, e = buf.length) {
  const out = {}; let p = s;
  const varint = () => { let r = 0, m = 1, b; do { b = buf[p++]; r += (b & 127) * m; m *= 128; } while (b & 128 && p < e); return r; };
  while (p < e) {
    const key = varint(), f = Math.floor(key / 8), t = key & 7; let v;
    if (t === 0) v = varint(); else if (t === 2) { const n = varint(); v = [p, p + n]; p += n; } else if (t === 1) { v = null; p += 8; } else if (t === 5) { v = { f32: p }; p += 4; } else break;   // (a float's place: f32, v1160)
    (out[f] ||= []).push(v);
  }
  return out;
}
const NYC_STATUS = ['incoming', 'stopped', 'transit'];
export function trimNyct(buf, rail, now = Date.now(), nyc) {
  if (!(buf instanceof Uint8Array) || !nyc) return [];
  const dec = new TextDecoder(), str = r => r ? dec.decode(buf.subarray(r[0], r[1])) : '', ups = new Map(), vehs = [];
  for (const r of pbRead(buf)[2] || []) {
    const en = pbRead(buf, ...r);
    if (en[3]) {
      const u = pbRead(buf, ...en[3][0]), tr = pbRead(buf, ...u[1][0]);
      ups.set(str(tr[1]?.[0]), (u[2] || []).map(x => { const q = pbRead(buf, ...x), a = q[2] && pbRead(buf, ...q[2][0]), d = q[3] && pbRead(buf, ...q[3][0]);
        return { stop: str(q[4]?.[0]), arr: (a?.[2]?.[0] || d?.[2]?.[0] || 0) * 1000 }; }));
    }
    if (en[4]) {
      const v = pbRead(buf, ...en[4][0]), tr = v[1] && pbRead(buf, ...v[1][0]);
      if (tr) vehs.push({ trip: str(tr[1]?.[0]), route: str(tr[5]?.[0]), stop: str(v[7]?.[0]), status: NYC_STATUS[v[4]?.[0] ?? 2], at: (v[5]?.[0] || 0) * 1000 });
    }
  }
  const out = [];
  for (const v of vehs) {
    if (v.at && now - v.at > 15 * 60e3) continue;   // (a trip the feed still lists hours after her last report: gone, not stopped)
    const ahead = ups.get(v.trip) || [], stops = ahead.map(s => s.stop), stop = v.stop || stops[0] || '', st = stop.slice(0, -1);
    const sh = stop && pathFor(nyc, v.trip, v.route, [stop, ...stops]); if (!sh) continue;
    const i = sh.at.get(st); if (i == null) continue;
    let d = sh.s[i][1];
    if (v.status !== 'stopped' && i > 0) {   // between her last stop and this one, by how soon she's due here
      const prev = sh.s[i - 1][1], due = ahead.find(s => s.stop === stop)?.arr || 0, gap = Math.max(60e3, (d - prev) / 9 * 1000);   // (~20 mph between stops)
      const f = due ? Math.max(0, Math.min(1, 1 - (due - now) / gap)) : 0.5;
      d = prev + (d - prev) * f;
    }
    // her line as riders say it: 'A train', '1 train' (the 6X and 7X expresses too), 'S train' for the shuttles (GS, FS, H)
    const pt = along(sh, d), last = stops[stops.length - 1] || stop, r = v.route.replace(/X$/, ''), line = r === 'SI' ? 'SIR' : /^(GS|FS|H)$/.test(r) ? 'S' : r;
    out.push({ id: `${rail.id}:${v.trip}`, rail: line === 'SIR' ? 'Staten Island Railway' : `${line} train`, line, trip: v.trip.split('_')[0], dest: nyc.stops[last.slice(0, -1)]?.[2] || '',
      dir: stop.slice(-1) === 'N' ? 'N' : 'S', lat: +pt.lat.toFixed(5), lon: +pt.lon.toFixed(5), brg: Math.round(pt.brg), at: Math.min(v.at || now, now),
      mph: null, from: '', next: nyc.stops[st]?.[2] || '', nextExp: ahead.find(s => s.stop === stop)?.arr || null, atStop: v.status === 'stopped' });
  }
  return out;
}

// ---- PATH and the LIRR (v1160) ----
const SITE = 'https://egilchri.github.io/AudioChart/data/rail/';
const once = (name, prep) => { let pr = null; return (load = () => fetch(SITE + name).then(r => { if (!r.ok) throw new Error(`${name} ${r.status}`); return r.json(); })) => pr ||= load().then(prep).catch(e => { pr = null; throw e; }); };
export const lirrData = once('lirr.json', j => j), mnrData = once('mnr.json', j => j);
export const pathData = once('path.json', j => {
  for (const L of Object.values(j.lines)) { L.cum = [0]; for (let i = 1; i < L.p.length; i++) L.cum.push(L.cum[i - 1] + metres(L.p[i - 1], L.p[i])); }
  return j;
});
const f32 = (buf, v) => v?.f32 != null ? new DataView(buf.buffer, buf.byteOffset + v.f32, 4).getFloat32(0, true) : null;
// the LIRR's: VehiclePosition 1 trip, 2 position (1 latitude, 2 longitude, 3 bearing, 5 speed m/s), 4 status, 5 time, 7 stop
export const trimLirr = (buf, rail, now, L) => trimMtaRail(buf, rail, now, L, t => L?.trips[t], t => t.split('_').pop());
// (v1163) Metro-North's: the same feed's shape; her trip is her train number, her line and end from it
export const trimMnr = (buf, rail, now, M) => trimMtaRail(buf, rail, now, M, t => M?.trains[t], t => t);
function trimMtaRail(buf, rail, now = Date.now(), L, find, num) {
  if (!(buf instanceof Uint8Array) || !L) return [];
  const dec = new TextDecoder(), str = r => r ? dec.decode(buf.subarray(r[0], r[1])) : '', out = [];
  for (const r of pbRead(buf)[2] || []) {
    const en = pbRead(buf, ...r); if (!en[4]) continue;
    const v = pbRead(buf, ...en[4][0]), tr = v[1] && pbRead(buf, ...v[1][0]), ps = v[2] && pbRead(buf, ...v[2][0]); if (!ps) continue;
    const lat = f32(buf, ps[1]?.[0]), lon = f32(buf, ps[2]?.[0]), brg = f32(buf, ps[3]?.[0]), sp = f32(buf, ps[5]?.[0]); if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const trip = str(tr?.[1]?.[0]), [rid, head] = find(trip) || [], route = L.routes[rid], at = (v[5]?.[0] || 0) * 1000;
    if (at && now - at > 15 * 60e3) continue;   // (gone, not stopped)
    out.push({ id: `${rail.id}:${trip}`, rail: rail.name, line: route?.[0] || '', trip: num(trip), dest: head || '', dir: '',
      lat: +lat.toFixed(5), lon: +lon.toFixed(5), brg: Number.isFinite(brg) ? Math.round(brg) : null, at: Math.min(at || now, now),
      mph: Number.isFinite(sp) ? +(sp * 2.23694).toFixed(1) : null, from: '', next: L.stops[str(v[7]?.[0])] || '', atStop: v[4]?.[0] === 1 });
  }
  return out;
}
// PATH's: each station's next trains by line colour and where they're bound, in seconds. On each line toward each end,
// a train due at a station in less than the run to it from the one before is between the two (a train due within
// 20 s, at it); the same train seen again (its time at the end of the line within 2 minutes of one kept) keeps her id.
const pathKept = new Map(); let pathSeq = 0;
export function trimPath(text, rail, now = Date.now(), P) {
  let j; try { j = JSON.parse(text); } catch (_) { return []; }
  if (!P) return [];
  const due = new Map();   // 'colour:end:station' -> seconds to the first
  for (const st of j?.results || []) for (const de of st.destinations || []) for (const m of de.messages || []) {
    const sec = Number(m.secondsToArrival); if (!Number.isFinite(sec)) continue;
    for (const col of String(m.lineColor || '').toUpperCase().split(',')) { const k = `${col}:${m.target}:${st.consideredStation}`; if (!(due.get(k) <= sec)) due.set(k, sec); }
  }
  const out = [], seen = new Set();
  for (const [key, L] of Object.entries(P.lines)) {
    const [col, end] = key.split(':'), S = L.s, cands = [];
    for (let i = 1; i < S.length; i++) {
      const t = due.get(`${col}:${end}:${S[i][0]}`); if (t == null) continue;
      const run = S[i][2] || 120; if (t > run) continue;
      const f = t <= 20 ? 1 : 1 - t / run, d = S[i - 1][1] + (S[i][1] - S[i - 1][1]) * f;
      let rest = t; for (let k = i + 1; k < S.length; k++) rest += S[k][2] + 25;   // (her time to the end of the line, stops and all)
      cands.push({ d, i, t, eta: now + rest * 1000 });
    }
    cands.sort((a, b) => a.d - b.d);
    const kept = pathKept.get(key) || [], next = [];
    for (const c of cands) {
      if (next.length && c.d - next.at(-1).d < 150) continue;   // (one train, seen at two stations)
      const prev = kept.filter(k => !seen.has(k.id) && Math.abs(k.eta - c.eta) < 120e3).sort((a, b) => Math.abs(a.eta - c.eta) - Math.abs(b.eta - c.eta))[0];
      const id = prev?.id || `${rail.id}:${col}-${end}-${++pathSeq}`; seen.add(id); next.push({ ...c, id });
      const pt = along(L, c.d), nx = S[c.i][0];
      out.push({ id, rail: rail.name, line: L.name, trip: '', dest: P.stops[end]?.[2] || end, dir: '', lat: +pt.lat.toFixed(5), lon: +pt.lon.toFixed(5), brg: Math.round(pt.brg),
        at: now, mph: null, from: '', next: P.stops[nx]?.[2] || nx, nextExp: now + c.t * 1000, atStop: c.t <= 20, col: '#' + col });
    }
    pathKept.set(key, next);
  }
  return out;
}
