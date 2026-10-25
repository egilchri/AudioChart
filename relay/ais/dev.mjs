// The live-AIS relay on this computer, for developing (see README.md):
//   AISSTREAM_KEY=... OPENWATERS_KEY=... node relay/ais/dev.mjs   the real feeds (either or both), at http://localhost:8790/vessels
//   node relay/ais/dev.mjs --fake                   made-up vessels in AIS's own message format, no key needed
// Then open Bird's-eye with ?ais=http://localhost:8790 (or set it once: localStorage 'audiochart-ais-relay').
import http from 'node:http';
import { makeTable, subscription, corsHeaders, FEEDS, bboxOf } from './core.mjs';

const PORT = Number(process.env.PORT) || 8790, FAKE = process.argv.includes('--fake');
const table = makeTable();
let opened = Date.now(), lastErr = null;
const open = new Set();

function connect(f) {   // one connection per feed whose key is set (core.mjs FEEDS)
  const key = process.env[f.key];
  const ws = new WebSocket(f.url); ws.binaryType = 'arraybuffer';
  const dec = new TextDecoder();
  ws.onopen = () => { ws.send(subscription(key)); if (!open.size) opened = Date.now(); open.add(f.name); lastErr = null; console.log(f.name, 'open'); };
  ws.onmessage = e => { try { table.ingest(JSON.parse(typeof e.data === 'string' ? e.data : dec.decode(e.data))); } catch (_) {} };
  ws.onerror = e => { lastErr = `${f.name}: ${e.message || 'upstream error'}`; };
  ws.onclose = e => { console.log(f.name, 'closed', e.code, e.reason); open.delete(f.name); setTimeout(() => connect(f), 10000); };
}
function connectAll() {
  const feeds = FEEDS.filter(f => process.env[f.key]);
  if (!feeds.length) { lastErr = 'no key'; console.log('no AISSTREAM_KEY or OPENWATERS_KEY: use --fake, or set a key'); return; }
  feeds.forEach(connect);
}

// Made-up traffic, as AIS messages: a tanker up West Penobscot Bay for Searsport, the Vinalhaven ferry, a
// windjammer off Camden, a lobster boat working off Owls Head, and a tug at anchor off Rockland
const fakes = [
  { mmsi: '366000001', name: 'NORDIC FREEDOM', type: 80, L: 183, B: 32, dest: 'SEARSPORT', path: [[43.86, -68.92], [44.05, -68.98], [44.25, -68.92], [44.44, -68.89]], kn: 11 },
  { mmsi: '366000002', name: 'CAPT E FRANK THOMPSON', type: 60, L: 46, B: 12, dest: 'VINALHAVEN', path: [[44.104, -69.095], [44.09, -69.0], [44.07, -68.88], [44.047, -68.84]], kn: 11 },
  { mmsi: '366000003', name: 'MARY DAY', type: 36, L: 32, B: 7, dest: 'CAMDEN', path: [[44.2, -69.04], [44.17, -68.97], [44.21, -68.93], [44.2, -69.04]], kn: 6 },
  { mmsi: '366000004', name: 'PATRIOT', type: 30, L: 12, B: 4, dest: '', path: [[44.08, -69.04], [44.07, -69.02], [44.075, -69.0], [44.08, -69.04]], kn: 4 },
  { mmsi: '366000006', name: 'SCHOONER LEWIS R FRENCH', type: 36, L: 31, B: 6, dest: 'CAMDEN', path: [[44.19, -69.0], [44.16, -68.95]], kn: 5 },
  { mmsi: '366000007', name: 'MAQUOIT II', type: 60, L: 30, B: 9, dest: 'CLIFF ISLAND', path: [[43.6566, -70.2468], [43.6705, -70.1995], [43.6897, -70.1686]], kn: 11 },   // (Casco Bay, v994)
  { mmsi: '366000005', name: 'GRACE MCALLISTER', type: 52, L: 30, B: 10, dest: 'ROCKLAND', path: [[44.095, -69.07], [44.095, -69.07]], kn: 0 },
];
const t0 = Date.now();
function fakeTick() {
  const now = Date.now();
  for (const f of fakes) {
    // along the path at kn knots, there and back
    const seg = f.path.slice(1).map((p, i) => { const a = f.path[i], dy = (p[0] - a[0]) * 60, dx = (p[1] - a[1]) * 60 * Math.cos(a[0] * Math.PI / 180); return Math.hypot(dx, dy); });
    const L = seg.reduce((a, b) => a + b, 0) || 1, run = (now - t0) / 3600e3 * f.kn, k = run % (2 * L), d = k < L ? k : 2 * L - k, back = k >= L;
    let i = 0, left = d; while (i < seg.length - 1 && left > seg[i]) left -= seg[i++];
    const a = f.path[i], b = f.path[i + 1] || a, u = seg[i] ? left / seg[i] : 0;
    const lat = a[0] + (b[0] - a[0]) * u, lon = a[1] + (b[1] - a[1]) * u;
    let cog = (Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI + 360) % 360; if (back) cog = (cog + 180) % 360;
    table.ingest({ MessageType: 'PositionReport', MetaData: { MMSI: +f.mmsi, ShipName: f.name, latitude: lat, longitude: lon },
      Message: { PositionReport: { UserID: +f.mmsi, Latitude: lat, Longitude: lon, Sog: f.kn, Cog: cog, TrueHeading: Math.round(cog), NavigationalStatus: f.kn ? 0 : 1, RateOfTurn: f.kn ? 3 : 0, PositionAccuracy: true } } }, now);
    table.ingest({ MessageType: 'ShipStaticData', MetaData: { MMSI: +f.mmsi },
      Message: { ShipStaticData: { UserID: +f.mmsi, Name: f.name.padEnd(20, '@'), Type: f.type, Destination: f.dest, CallSign: 'WDC' + f.mmsi.slice(-4), ImoNumber: f.L > 40 ? 9100000 + Number(f.mmsi.slice(-3)) : 0, MaximumStaticDraught: f.L > 100 ? 10.4 : f.L > 40 ? 3.2 : 0, Eta: f.dest ? { Month: 10, Day: 24, Hour: 6, Minute: 30 } : { Month: 0, Day: 0, Hour: 24, Minute: 60 }, Dimension: { A: Math.round(f.L * 0.6), B: Math.round(f.L * 0.4), C: Math.round(f.B / 2), D: Math.round(f.B / 2) } } } }, now);
  }
}

if (FAKE) { fakeTick(); setInterval(fakeTick, 5000); } else connectAll();

http.createServer((req, res) => {
  const h = corsHeaders(req.headers.origin);
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...h, 'Access-Control-Allow-Methods': 'GET' }); return res.end(); }
  if (!req.url.startsWith('/vessels')) { res.writeHead(404); return res.end('GET /vessels'); }
  const snap = table.snapshot(Date.now(), bboxOf(req.url)); snap.listening = Math.round((Date.now() - opened) / 1000); snap.feeds = [...open]; if (lastErr && !FAKE) snap.error = lastErr;
  res.writeHead(200, h); res.end(JSON.stringify(snap));
}).listen(PORT, () => console.log(`AIS relay${FAKE ? ' (fake vessels)' : ''}: http://localhost:${PORT}/vessels`));
