// (v1201, the bus video: from ../live-tour/shim.js, and New York's city buses too: each carried on at the speed and
// heading the page had for her when the clock stopped, a fresh report each time the page asks)
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
  let railVH = {}, busVH = {};
  window.__freeze = () => {
    clearInterval(pump); fz = { p: rP(), d: rD() };
    for (const t of window.__bay3d?.rail?.list() || []) railVH[t.id] = { v: t.v, h: t.h };
    for (const p of window.__bay3d?.rail?.items() || []) if (p.mta) busVH[p.id] = { v: p.vKnown ? p.v : 0, h: p.h };
  };
  window.__step = ms => { vt += ms; const cbs = q.splice(0); for (const cb of cbs) { try { cb(fz.p + vt); } catch (e) { window.__err = e.stack; console.error(e); } } return cbs.length; };
  const rf = window.fetch.bind(window), snap = {}, snapT = {};
  const KT = 1852 / 3600, DEG = Math.PI / 180;
  const move = (o, m, deg) => ({ lat: o.lat + m * Math.cos(deg * DEG) / 111120, lon: o.lon + m * Math.sin(deg * DEG) / (111320 * Math.cos(o.lat * DEG)) });
  // a point d metres on along the line pts ([[lon, lat], ...]) from the place on it nearest o
  const along = (pts, o, d) => {
    const kx = 111320 * Math.cos(o.lat * DEG), ky = 111120, xy = ([lo, la]) => [(lo - o.lon) * kx, (la - o.lat) * ky];
    let best = 0, bd = Infinity, bu = 0;
    for (let i = 0; i + 1 < pts.length; i++) { const [ax, ay] = xy(pts[i]), [bx, by] = xy(pts[i + 1]), L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1, u = Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / L2)), d2 = (ax + (bx - ax) * u) ** 2 + (ay + (by - ay) * u) ** 2; if (d2 < bd) { bd = d2; best = i; bu = u; } }
    let i = best, u = bu;
    for (;;) { const [ax, ay] = xy(pts[i]), [bx, by] = xy(pts[i + 1]), L = Math.hypot(bx - ax, by - ay), left = L * (1 - u);
      if (d <= left || i + 2 >= pts.length) { const f = Math.min(1, u + (L ? d / L : 0)); return { lon: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, lat: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f }; }
      d -= left; i++; u = 0; }
  };
  const kindOf = u => ['/vessels', '/aircraft', '/trains', '/mtabus'].find(k => String(u).includes(k));
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
    // (her, the bus followed: carried along her route's own line, window.__busPath, at her speed; the rest as they were,
    // a straight line off her last report having run her through the blocks)
    if (k === '/mtabus') j.buses = j.buses.map(b => {
      const P = window.__busPath, vh = busVH['mta:' + b.id];
      if (!P || P.id !== 'mta:' + b.id || !vh || vh.v < 0.5) return { ...b, age: (b.age || 0) + dt };
      return { ...b, ...along(P.pts, b, vh.v * ((b.age || 0) + dt)), age: 0 };
    });
    return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  };
})();
