// The live-AIS relay as a Cloudflare Worker (see README.md). GET /vessels answers with the vessels heard in the
// bay; one Durable Object keeps the single upstream connection to AISStream, opened by the first request and
// closed after a few minutes with nobody asking (AISStream allows 3 connections per key). Names, types and sizes
// are kept in the object's storage, since AIS sends them only every six minutes.
import { makeTable, subscription, corsHeaders } from './core.mjs';

const IDLE_MS = 5 * 60e3;

export class AisHub {
  constructor(state, env) {
    this.state = state; this.env = env; this.ws = null; this.lastAsk = 0; this.opened = 0;
    this.table = makeTable({ onStatic: (mmsi, st) => this.state.storage.put('s:' + mmsi, st) });
    this.ready = this.state.blockConcurrencyWhile(async () => {
      for (const [k, st] of await this.state.storage.list({ prefix: 's:' })) this.table.setStatic(k.slice(2), st);
    });
  }
  async open() {
    if (this.ws) return;
    const r = await fetch('https://stream.aisstream.io/v0/stream', { headers: { Upgrade: 'websocket' } });
    const ws = r.webSocket; if (!ws) throw new Error(`upstream: ${r.status}`);
    ws.accept(); this.ws = ws; this.opened = Date.now();
    ws.send(subscription(this.env.AISSTREAM_KEY));
    const dec = new TextDecoder();
    ws.addEventListener('message', e => {
      try { this.table.ingest(JSON.parse(typeof e.data === 'string' ? e.data : dec.decode(e.data))); } catch (_) {}
      if (Date.now() - this.lastAsk > IDLE_MS) this.close();
    });
    const gone = () => { if (this.ws === ws) this.ws = null; };
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
    await this.state.storage.setAlarm(Date.now() + IDLE_MS);
  }
  close() { try { this.ws?.close(1000, 'idle'); } catch (_) {} this.ws = null; }
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
    if (err) snap.error = err;
    return new Response(JSON.stringify(snap), { headers: corsHeaders(req.headers.get('Origin')) });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin');
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...corsHeaders(origin), 'Access-Control-Allow-Methods': 'GET' } });
    if (url.pathname !== '/vessels') return new Response('AudioChart live AIS relay: GET /vessels', { status: 404 });
    if (!env.AISSTREAM_KEY) return new Response(JSON.stringify({ error: 'no key' }), { status: 503, headers: corsHeaders(origin) });
    return env.AIS_HUB.get(env.AIS_HUB.idFromName('penobscot')).fetch(req);
  },
};
