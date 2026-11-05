// Live trains in Bird's-eye (v1099): Caltrain, SMART and ACE, from 511.org through the relay's GET /trains
// (relay/ais/core.mjs RAIL). 511 is asked at most every 90 s per railroad, so between reports each train runs on
// at the speed and heading of her last two positions (511's own bearing is always 0), for up to a minute, then
// waits for the next. On with 📡 Live; needs an internet connection. Her label shows only while the pointer is
// over her, or after a tap on her until the next (v1102, as the aircraft's since v1101).
import * as THREE from 'three';
import { relayUrl } from './ais.js';
import { labelSprite } from './aircraft3d.js';
import { makeCaltrain } from './caltrain3d.js';

export const TRAIN_CREDIT = 'Trains from 511.org';
const DEG = Math.PI / 180;
// each railroad's train: cars, car length (m), and livery (body, band)
const LOOK = {
  Caltrain: { cars: 6, len: 26, body: 0xd8dadc, band: 0xc8102e },
  SMART: { cars: 2, len: 25, body: 0xf1f1ee, band: 0x2e8b57 },
  ACE: { cars: 6, len: 26, body: 0xe6e3ee, band: 0x5b2a86 },
};
function trainModel(look) {   // the cars in a line along -z (her front), 1 unit = 1 m
  const g = new THREE.Group(), body = new THREE.MeshLambertMaterial({ color: look.body }), band = new THREE.MeshLambertMaterial({ color: look.band });
  const roof = new THREE.MeshLambertMaterial({ color: look.band, emissive: look.band, emissiveIntensity: 0.45 });
  const L = look.len, gap = 1.2;
  for (let i = 0; i < look.cars; i++) {
    const z = i * (L + gap) - (look.cars - 1) * (L + gap) / 2;
    const car = new THREE.Mesh(new THREE.BoxGeometry(3.1, 4.6, L), body); car.position.set(0, 2.3 + 0.6, z); g.add(car);
    const b = new THREE.Mesh(new THREE.BoxGeometry(3.16, 0.7, L * 0.98), band); b.position.set(0, 1.6, z); g.add(b);
    const r = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, L * 0.96), roof); r.position.set(0, 5.26, z); g.add(r);   // (her roof in her colour: from above, silver on a grey city didn't show, v1105)
  }
  return g;
}
// "San Francisco Caltrain Station Northbound" -> "San Francisco"; "Stockton - Robert J Cabral Sta" -> "Stockton"
const place = d => (d || '').replace(/\s+(Caltrain\s+)?Station\b.*$/i, '').replace(/\s+-\s+.*$/, '').replace(/^SMART\s+/i, '').trim();
const lonOf = p => p.fix.lon + (p.x - p.fix.x) / (111320 * Math.cos(p.fix.lat * DEG)), latOf = p => p.fix.lat - (p.z - p.fix.z) / 111120;   // (where she's drawn now)
const metres = (a, b) => Math.hypot((b.lon - a.lon) * 111320 * Math.cos(a.lat * DEG), (b.lat - a.lat) * 111120);

// Each train is also a 'vessel' to Bird's-eye's card, Follow and ride views (v1104): kind 'rail', as the aircraft's
// (aircraft3d.js), her cab at the front of her first car.
export function makeTrains({ scene, bbox, wx, wz, heightAt, every = 30000, onCount, focus = () => false, onDrop = () => {} }) {
  const trains = new Map();   // id -> { a, g, model, label, fix, prev, v (m/s), h, x, z }
  let on = false, timer = null, inflight = null, hover = null;
  const pinned = new Set(), _v = new THREE.Vector3();
  // the railway's tracks (v1116, reported: the Caltrains at 4th & King "weren't pointing down the tracks"; a train
  // standing at a platform had only a guess at her heading, south-east or north-west, and 4th & King's platforms run
  // south-west): OSM's main lines and their sidings (www/data/rail/, design/rail/build_rail.py), cut into segments in
  // a 250 m grid. Each train is laid on the nearest one within 40 m, pointing along it.
  const CELL = 250, grid = new Map(); let segs = null;
  function setTracks(lines) {
    const S = []; grid.clear();
    for (const l of lines) for (let i = 1; i < l.length; i++) {
      const x1 = wx(l[i - 1][0]), z1 = wz(l[i - 1][1]), x2 = wx(l[i][0]), z2 = wz(l[i][1]), k = S.length / 4; S.push(x1, z1, x2, z2);
      const n = Math.ceil(Math.hypot(x2 - x1, z2 - z1) / (CELL / 2)) + 1;
      for (let j = 0; j <= n; j++) { const key = `${Math.floor((x1 + (x2 - x1) * j / n) / CELL)},${Math.floor((z1 + (z2 - z1) * j / n) / CELL)}`; const c = grid.get(key); if (!c) grid.set(key, [k]); else if (c[c.length - 1] !== k) c.push(k); }
    }
    segs = new Float64Array(S);
  }
  // the nearest track to (x, z): the point on it, and its two headings' first (°, as p.h: 0 north, 90 east)
  function onTrack(x, z, reach = 40) {
    if (!segs) return null;
    let best = null, bd = reach * reach; const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const k of grid.get(`${cx + i},${cz + j}`) || []) {
      const x1 = segs[k * 4], z1 = segs[k * 4 + 1], dx = segs[k * 4 + 2] - x1, dz = segs[k * 4 + 3] - z1, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / L2)), px = x1 + dx * t, pz = z1 + dz * t, d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < bd) { bd = d; best = { x: px, z: pz, h: (Math.atan2(dx, -dz) / DEG + 360) % 360 }; }
    }
    return best;
  }
  const near = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
  function drop(p) { pinned.delete(p); if (hover === p) hover = null; trains.delete(p.id); onDrop(p); scene.remove(p.g); p.g.traverse(o => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); }); trains.delete(p.id); }
  function data(j) {
    const now = Date.now(), seen = new Set();
    for (const a of j.trains || []) {
      seen.add(a.id);
      let p = trains.get(a.id);
      if (!p) {
        // Caltrain: her Stadler KISS, modelled from photos (caltrain3d.js, v1107); SMART and ACE, simple cars for now
        const look = LOOK[a.rail] || LOOK.Caltrain, kiss = a.rail === 'Caltrain' ? makeCaltrain() : null;
        const g = new THREE.Group(), model = kiss ? kiss.group : trainModel(look), label = labelSprite();
        g.add(model, label); scene.add(g);
        const L = kiss ? kiss.length : look.cars * look.len + (look.cars - 1) * 1.2;
        g.userData.helm = kiss ? kiss.cab : [0, 3.6, -L / 2 + 1.6];   // (her cab: the front of her first car)
        // (L sizes the ride views' distances: her whole 160 m put the drone 380 m back, end-on she was a post; as a
        // 45 m vessel it stands ~100 m off. len is her real length)
        p = { kind: 'rail', id: a.id, g, group: g, L: 45, len: L, y: 0, model, tag: label, x: wx(a.lon), z: wz(a.lat), h: a.dir === 'S' ? 135 : a.dir === 'N' ? 315 : 0, v: 0, placed: false };
        trains.set(a.id, p);
      }
      const at = now - (a.age || 0) * 1000;
      // a new report: her speed and heading from the last one. (The relay asks 511 every 90 s, we ask it every 30: the
      // same report again comes back a second later by its rounded age, and was taken for a new one that hadn't moved,
      // so every train stopped between reports. v1106: only a report 5 s newer is new)
      if (!p.fix || at > p.fix.t + 5000) {
        if (p.fix) {
          const d = metres(p.fix, a), s = (at - p.fix.t) / 1000;
          p.v = s > 5 && d / s < 50 ? d / s : 0;   // (a stand at a station is 0; a jump of over 50 m/s is no speed)
          if (s > 5) p.vKnown = true;   // (her speed needs two reports, 90 s apart: till then it isn't known, v1106)
          if (d > 30) { p.h = (Math.atan2((a.lon - p.fix.lon) * Math.cos(a.lat * DEG), a.lat - p.fix.lat) / DEG + 360) % 360; p.moved = true; }
        }
        p.fix = { lon: a.lon, lat: a.lat, x: wx(a.lon), z: wz(a.lat), t: at };
      }
      p.a = a;
      p.tag.userData.draw(`${a.rail} ${/^\d{1,4}$/.test(a.trip) ? a.trip : ''} → ${place(a.dest) || '?'}`.replace(/\s+/g, ' '));
      p.title = `${a.rail} ${/^\d{1,4}$/.test(a.trip) ? a.trip : ''}`.trim(); p.dest = place(a.dest);
      p.label = `${!p.vKnown ? 'Speed due in a minute or so' : p.v >= 1 ? `About ${Math.round(p.v * 2.237)} mph` : 'Stopped'}${p.dest ? `, bound for ${p.dest}` : ''}`;   // (Caltrain's train number; SMART's trip ids are long)
    }
    for (const p of [...trains.values()]) if (!seen.has(p.id)) drop(p);
    onCount?.(trains.size);
  }
  async function poll() {
    if (!on) return;
    const ctl = new AbortController(); inflight = ctl; const kill = setTimeout(() => ctl.abort(), 8000); let got = null;
    try {
      const r = await fetch(`${relayUrl()}/trains?bbox=${bbox.map(v => v.toFixed(3)).join(',')}`, { signal: ctl.signal, cache: 'no-store' });
      const j = await r.json(); if (on && r.ok) got = j;
    } catch (_) {} finally { clearTimeout(kill); if (inflight === ctl) inflight = null; }   // (the network's failures, quietly)
    try { if (got) data(got); } catch (e) { console.error('[live] couldn\'t take in the answer', e); }   // (ours, loudly: v1104 lost all but one plane a poll to a quiet one)
    if (on) timer = setTimeout(poll, every);
  }
  function update(dt, camera) {
    if (!trains.size) return;
    const now = Date.now(), cp = camera.position;
    for (const p of trains.values()) {
      const s = p.v * Math.min(Math.max((now - p.fix.t) / 1000, 0), 60);
      const tx = p.fix.x + Math.sin(p.h * DEG) * s, tz = p.fix.z - Math.cos(p.h * DEG) * s;
      const k = p.placed ? Math.min(1, dt * 0.8) : 1; p.placed = true;
      p.x += (tx - p.x) * k; p.z += (tz - p.z) * k;
      // on her track, along it: the way she's going if she's been seen to move, or else her direction's way (a
      // southbound train the end of it nearer south). Off any track (none within 40 m), as before
      const tr = onTrack(p.x, p.z);
      let dh = p.h;
      if (tr) {
        const ref = p.moved ? p.h : p.a.dir === 'S' ? 180 : p.a.dir === 'N' ? 0 : p.h, alt = (tr.h + 180) % 360;
        dh = near(tr.h, ref) <= near(alt, ref) ? tr.h : alt; p.x = tr.x; p.z = tr.z;
        if (!p.moved) p.h = dh;   // (and her heading's this till she's seen to move: her card's and her map's too)
      }
      const turn = ((dh - (p.dh ?? dh) + 540) % 360) - 180; p.dh = ((p.dh ?? dh) + (p.placedH ? Math.max(-20 * dt, Math.min(20 * dt, turn)) : turn) + 360) % 360; p.placedH = true;
      const lon = p.fix.lon + (p.x - p.fix.x) / (111320 * Math.cos(p.fix.lat * DEG)), lat = p.fix.lat - (p.z - p.fix.z) / 111120;
      // on the ground under her whole length, not just her middle (v1107: a 190 m Caltrain set at her middle's height
      // sank into the rise ahead of her, and showed in two pieces): the ground under her front and back too, she sits
      // at the higher of her middle and her ends' mean, tilted to their slope (no more than a railway's 2°)
      const hl = (p.len || 160) / 2 * (p.model.scale.z || 1), fx = Math.sin(p.dh * DEG) * hl, fz = -Math.cos(p.dh * DEG) * hl;
      const gAt = (x, z) => Math.max(0, heightAt(p.fix.lon + (x - p.fix.x) / (111320 * Math.cos(p.fix.lat * DEG)), p.fix.lat - (z - p.fix.z) / 111120) || 0);
      const hF = gAt(p.x + fx, p.z + fz), hB = gAt(p.x - fx, p.z - fz), hC = Math.max(0, heightAt(lon, lat) || 0);
      p.y = Math.max(hC, (hF + hB) / 2); p.g.position.set(p.x, p.y, p.z);
      p.model.rotation.order = 'YXZ'; p.model.rotation.set(Math.max(-0.035, Math.min(0.035, Math.atan2(hF - hB, 2 * hl))), -p.dh * DEG, 0);
      // her real size near; farther off, big enough to see (v1105, reported: "It's hard to see trains"): about 4 px
      // wide whatever the distance (a 3 m train is a fraction of a pixel from 20 km), and long in proportion
      const d = Math.hypot(p.x - cp.x, cp.y - p.g.position.y, p.z - cp.z), w = Math.max(1, d * 0.0058 / 3.1), l = Math.max(1, d * 0.02 / 160, w * 0.35);
      p.model.scale.set(w, Math.max(1, w * 0.5), l);
      p.tag.visible = p === hover || pinned.has(p) || focus(p);
    }
  }
  return {
    start() { if (on) return; on = true; poll(); },
    stop() { on = false; clearTimeout(timer); inflight?.abort(); for (const p of [...trains.values()]) drop(p); onCount?.(0); },
    update, setTracks,
    // the train under a point on the screen (client px), within reach px of her middle: for hover and tap
    at(cx, cy, camera, rect, reach = 22) {
      let best = null, bd = reach;
      for (const p of trains.values()) {
        _v.copy(p.g.position).project(camera); if (_v.z >= 1) continue;
        const d = Math.hypot(rect.left + (_v.x + 1) / 2 * rect.width - cx, rect.top + (1 - _v.y) / 2 * rect.height - cy);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    },
    set hover(p) { hover = p; },
    has: p => trains.get(p?.id) === p,
    items: () => [...trains.values()],
    toggle(p) { if (pinned.has(p)) pinned.delete(p); else pinned.add(p); },
    pin(id, show = true) { const p = trains.get(id); if (p) { if (show) pinned.add(p); else pinned.delete(p); } return !!p; },   // (for a recording)
    get on() { return on; },
    get count() { return trains.size; },
    list: (camera, rect) => [...trains.values()].map(p => {   // (for checking from a script)
      const o = { id: p.id, rail: p.a.rail, trip: p.a.trip, dest: place(p.a.dest), v: +p.v.toFixed(1), h: Math.round(p.dh ?? p.h), shown: p.tag.visible, lat: latOf(p), lon: lonOf(p) };
      if (camera && rect) { _v.copy(p.g.position).project(camera); if (_v.z < 1) { o.sx = Math.round(rect.left + (_v.x + 1) / 2 * rect.width); o.sy = Math.round(rect.top + (1 - _v.y) / 2 * rect.height); } }
      return o;
    }),
  };
}
