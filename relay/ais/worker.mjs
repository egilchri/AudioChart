// The live-AIS relay as a Cloudflare Worker (see README.md). GET /vessels answers with the vessels heard in the
// bays; one Durable Object keeps one upstream connection to each feed (core.mjs FEEDS: AISStream, and Open Waters
// since v1011), opened by the first request and closed after a few minutes with nobody asking (AISStream allows 3
// connections per key, Open Waters 2 per personal token). Names, types and sizes are kept in the object's
// storage, since AIS sends them only every six minutes.
import { makeTable, subscription, corsHeaders, FEEDS } from './core.mjs';

const IDLE_MS = 5 * 60e3;

export class AisHub {
  constructor(state, env) {
    this.state = state; this.env = env; this.ws = {}; this.errs = {}; this.errAt = {}; this.lastAsk = 0; this.opened = 0;
    this.table = makeTable({ onStatic: (mmsi, st) => this.state.storage.put('s:' + mmsi, st) });
    this.ready = this.state.blockConcurrencyWhile(async () => {
      for (const [k, st] of await this.state.storage.list({ prefix: 's:' })) this.table.setStatic(k.slice(2), st);
    });
  }
  feeds() { return FEEDS.filter(f => this.env[f.key]); }
  async openFeed(f) {
    if (this.ws[f.name] || Date.now() - (this.errAt[f.name] || 0) < 60e3) return;   // (a failed feed waits a minute)
    const r = await fetch(f.url.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket' } });
    const ws = r.webSocket; if (!ws) throw new Error(`${f.name}: ${r.status}`);
    ws.accept(); this.ws[f.name] = ws; delete this.errs[f.name];
    ws.send(subscription(this.env[f.key]));
    const dec = new TextDecoder();
    ws.addEventListener('message', e => {
      try { this.table.ingest(JSON.parse(typeof e.data === 'string' ? e.data : dec.decode(e.data))); } catch (_) {}
      if (Date.now() - this.lastAsk > IDLE_MS) this.close();
    });
    const gone = () => { if (this.ws[f.name] === ws) delete this.ws[f.name]; };
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
  }
  async open() {
    const feeds = this.feeds();
    if (!Object.keys(this.ws).length) this.opened = Date.now();   // listening since the first feed (re)opened
    await Promise.all(feeds.map(f => this.openFeed(f).catch(e => { this.errs[f.name] = String(e.message || e); this.errAt[f.name] = Date.now(); })));
    if (Object.keys(this.ws).length) await this.state.storage.setAlarm(Date.now() + IDLE_MS);
    if (!Object.keys(this.ws).length) throw new Error(Object.values(this.errs).join('; ') || 'no feed');
  }
  close() { for (const ws of Object.values(this.ws)) try { ws.close(1000, 'idle'); } catch (_) {} this.ws = {}; }
  async alarm() {   // a quiet bay sends little: close on the clock too
    if (Date.now() - this.lastAsk > IDLE_MS) this.close();
    else await this.state.storage.setAlarm(Date.now() + IDLE_MS);
  }
  async fetch(req) {
    await this.ready;
    this.lastAsk = Date.now();
    let err = null;
    try { await this.open(); } catch (e) { err = String(e.message || e); }
    const snap = this.table.snapshot();
    snap.listening = Math.round((Date.now() - this.opened) / 1000);
    snap.feeds = Object.keys(this.ws);
    if (err) snap.error = err;
    return new Response(JSON.stringify(snap), { headers: corsHeaders(req.headers.get('Origin')) });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin');
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...corsHeaders(origin), 'Access-Control-Allow-Methods': 'GET' } });
    if (url.pathname !== '/vessels') return new Response('AudioChart live AIS relay: GET /vessels', { status: 404 });
    if (!FEEDS.some(f => env[f.key])) return new Response(JSON.stringify({ error: 'no key' }), { status: 503, headers: corsHeaders(origin) });
    return env.AIS_HUB.get(env.AIS_HUB.idFromName('penobscot')).fetch(req);
  },
};
