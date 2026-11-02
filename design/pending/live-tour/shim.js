// Injected before the page loads (from sf-flyover/shim.js): a clock we can stop and step one video frame at a time,
// and the relay's last answers replayed while it's stopped, moved on in the stopped clock so everything keeps its real
// speed: ships by their age (the page dead-reckons them), aircraft along their track at their ground speed and climb,
// trains at the speed and heading the page worked out from their last two real reports.
(() => {
  const rP = performance.now.bind(performance), rD = Date.now;
  let fz = null, vt = 0; const q = [];
  performance.now = () => fz ? fz.p + vt : rP();
  Date.now = () => fz ? fz.d + vt : rD();
  window.requestAnimationFrame = cb => { q.push(cb); return q.length; };
  const pump = setInterval(() => { for (const cb of q.splice(0)) { try { cb(rP()); } catch (e) { console.error(e); } } }, 33);
  window.__q = () => q.length;
  let railVH = {};
  window.__freeze = () => {
    clearInterval(pump); fz = { p: rP(), d: rD() };
    for (const t of window.__bay3d?.rail?.list() || []) railVH[t.id] = { v: t.v, h: t.h };
  };
  window.__step = ms => { vt += ms; const cbs = q.splice(0); for (const cb of cbs) { try { cb(fz.p + vt); } catch (e) { window.__err = e.stack; console.error(e); } } return cbs.length; };
  const rf = window.fetch.bind(window), snap = {}, snapT = {};
  const KT = 1852 / 3600, DEG = Math.PI / 180;
  const move = (o, m, deg) => ({ lat: o.lat + m * Math.cos(deg * DEG) / 111120, lon: o.lon + m * Math.sin(deg * DEG) / (111320 * Math.cos(o.lat * DEG)) });
  const kindOf = u => ['/vessels', '/aircraft', '/trains'].find(k => String(u).includes(k));
  window.__snaps = () => ({ vessels: snap['/vessels']?.vessels?.length, aircraft: snap['/aircraft']?.aircraft?.length, trains: snap['/trains']?.trains?.length });
  window.fetch = async (u, o) => {
    const k = kindOf(u); if (!k) return rf(u, o);
    if (!fz || !snap[k]) { const r = await rf(u, o); try { const j = await r.clone().json(); if (r.ok) { snap[k] = j; snapT[k] = rD(); } } catch (_) {} return r; }
    const dt = (Date.now() - snapT[k]) / 1000, j = { ...snap[k] };
    if (k === '/vessels') j.vessels = j.vessels.map(v => ({ ...v, age: (v.age || 0) + dt }));
    if (k === '/aircraft') j.aircraft = j.aircraft.map(a => {
      if (a.ground || !a.gs) return { ...a, age: 0 };
      const tt = (a.age || 0) + dt, p = move(a, a.gs * KT * tt, a.trk || 0);
      return { ...a, ...p, alt: Math.max(0, (a.alt || 0) + (a.vr || 0) / 60 * tt), age: 0 };
    });
    if (k === '/trains') j.trains = j.trains.map(t => {
      const vh = railVH[t.id]; if (!vh || !vh.v) return { ...t, age: (t.age || 0) + dt };
      return { ...t, ...move(t, vh.v * ((t.age || 0) + dt), vh.h), age: 0 };
    });
    return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  };
})();
