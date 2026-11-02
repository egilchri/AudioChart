// Live aircraft in Bird's-eye (v1098): ADS-B, the air's AIS, through the relay's GET /aircraft (relay/ais/core.mjs,
// from adsb.lol). Each aircraft flies at her reported altitude, moved on between reports at her ground speed and
// track, with a faint line down to the water so you can tell how high she is, and her flight and height beside her.
// On with 📡 Live; like Live AIS it needs an internet connection. Her label shows only while the pointer is over
// her, or after a tap on her until the next (v1101, reported: "Too much writing on the plane label").
import * as THREE from 'three';
import { relayUrl } from './ais.js';
import { makeAirliner } from './airliner3d.js';

export const ADSB_CREDIT = 'Aircraft from adsb.lol (ODbL)';
const FT = 0.3048, KT = 1852 / 3600, DEG = Math.PI / 180;

// A plain airliner shape, nose to -z (as the vessels), about 1 m long: scaled by her category
function planeModel(colour) {
  const g = new THREE.Group(), m = new THREE.MeshLambertMaterial({ color: colour });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.035, 1, 8), m); body.rotation.x = Math.PI / 2; g.add(body);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.015, 0.16), m); wing.position.z = 0.02; g.add(wing);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.012, 0.09), m); tail.position.z = 0.44; g.add(tail);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.16, 0.1), m); fin.position.set(0, 0.08, 0.44); g.add(fin);
  return g;
}
// ADS-B emitter category: A1 light, A2 small, A3 large, A4 757, A5 heavy, A7 rotorcraft; B* gliders, balloons, drones
const LEN = { A1: 9, A2: 15, A3: 38, A4: 47, A5: 65, A6: 20, A7: 15 };
const lengthOf = a => LEN[a.cat] || (a.cat?.[0] === 'B' ? 8 : 35);
const colourOf = a => a.cat === 'A7' ? 0xffb347 : a.cat === 'A1' || a.cat === 'A2' ? 0xbfe8ff : 0xf2f4f7;

export function labelSprite() {
  const c = document.createElement('canvas'); c.width = 384; c.height = 64;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, sizeAttenuation: false }));
  s.scale.set(0.135, 0.0225, 1); s.center.set(-0.08, 0.5); s.renderOrder = 11;
  s.userData.draw = text => {
    if (s.userData.text === text) return; s.userData.text = text;
    const x = c.getContext('2d'); x.clearRect(0, 0, 384, 64);
    x.font = '600 26px system-ui, sans-serif'; x.lineWidth = 6; x.strokeStyle = 'rgba(10,20,28,0.85)'; x.fillStyle = '#ffffff';
    x.strokeText(text, 6, 40); x.fillText(text, 6, 40); tex.needsUpdate = true;
  };
  return s;
}

// Each aircraft is also a 'vessel' to Bird's-eye's card, Follow and ride views (v1104): kind 'air', group, x/y/z, h,
// L (her length, m), label (what she's doing), title, and a cockpit (group.userData.helm, her frame, nose to −z).
// focus(p): true while her card is open or she's followed, so her label shows; onDrop(p) when she's gone.
// riding(p): true while you ride with her (no line down from her then: clutter beside her)
export function makeAircraft({ scene, bbox, wx, wz, every = 5000, onCount, focus = () => false, onDrop = () => {}, riding = () => false }) {
  const planes = new Map();   // hex -> { a, g, model, line, label, fix, x, y, z, h }
  let on = false, timer = null, inflight = null, hover = null;
  const pinned = new Set(), _v = new THREE.Vector3();
  const lineMat = new THREE.LineBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.35 });
  const free = o => { o.geometry?.dispose(); if (o.material && o.material !== lineMat && !o.material.userData?.shared) { o.material.map?.dispose(); o.material.dispose(); } };
  function drop(p) { pinned.delete(p); if (hover === p) hover = null; planes.delete(p.a.hex); onDrop(p); scene.remove(p.g); p.g.traverse(free); planes.delete(p.a.hex); }
  // her shape (v1108): an airliner of her type in her airline's colours (airliner3d.js), with her gear down on the
  // ground and on the way in; or, a type it doesn't know, the small plane. Built again only when that changes.
  function setModel(p, a) {
    const gear = !!a.ground || (a.alt ?? 0) < 1000 || ((a.alt ?? 0) < 2500 && (a.vr ?? 0) < -100);
    const key = `${a.type}|${(a.flight || '').slice(0, 3)}|${gear}`;
    if (p.modelKey === key) return; p.modelKey = key;
    const al = makeAirliner(a.type, a.flight, { gear }), m = al ? al.group : planeModel(colourOf(a));
    if (p.model) { p.g.remove(p.model); p.model.traverse(free); }
    p.model = m; p.g.add(m); p.real = !!al; p.L = al ? al.L : lengthOf(a);
    p.g.userData.helm = al ? al.cockpit : [0, p.L * 0.03, -p.L * 0.43];   // (the cockpit: up in her nose)
  }
  function data(j) {
    const now = Date.now(), seen = new Set();
    for (const a of j.aircraft || []) {
      seen.add(a.hex);
      let p = planes.get(a.hex);
      if (!p) {
        const g = new THREE.Group(), label = labelSprite();
        const line = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), lineMat);
        line.frustumCulled = false; g.add(label); scene.add(g, line);
        p = { kind: 'air', g, group: g, model: null, line, tag: label, x: wx(a.lon), z: wz(a.lat), y: (a.alt || 0) * FT, h: a.trk || 0, placed: false };
        g.userData.lineObj = line; planes.set(a.hex, p);
      }
      p.a = a; p.fix = { x: wx(a.lon), z: wz(a.lat), y: (a.alt || 0) * FT, t: now - (a.age || 0) * 1000, lon: a.lon, lat: a.lat };
      const alt = a.ground ? 'on the ground' : a.alt >= 18000 ? `FL${Math.round(a.alt / 100)}` : `${Math.round(a.alt / 100) * 100} ft`;
      p.tag.userData.draw(`${a.flight || a.reg || a.hex} · ${alt}`);
      setModel(p, a); p.title = a.flight || a.reg || a.hex.toUpperCase();
      const climb = a.ground ? '' : (a.vr ?? 0) < -300 ? ', descending' : (a.vr ?? 0) > 300 ? ', climbing' : '';
      p.label = a.ground ? `On the ground${a.gs >= 3 ? `, taxiing at ${Math.round(a.gs)} kn` : ''}` : `${alt}, ${Math.round(a.gs || 0)} kn${climb}`;
    }
    for (const p of [...planes.values()]) if (!seen.has(p.a.hex)) { scene.remove(p.line); p.line.geometry.dispose(); drop(p); }
    onCount?.(planes.size);
  }
  async function poll() {
    if (!on) return;
    const ctl = new AbortController(); inflight = ctl; const kill = setTimeout(() => ctl.abort(), 8000); let got = null;
    try {
      const r = await fetch(`${relayUrl()}/aircraft?bbox=${bbox.map(v => v.toFixed(3)).join(',')}`, { signal: ctl.signal, cache: 'no-store' });
      const j = await r.json(); if (on && r.ok) got = j;
    } catch (_) {} finally { clearTimeout(kill); if (inflight === ctl) inflight = null; }   // (the network's failures, quietly)
    try { if (got) data(got); } catch (e) { console.error('[live] couldn\'t take in the answer', e); }   // (ours, loudly: v1104 lost all but one plane a poll to a quiet one)
    if (on) timer = setTimeout(poll, every);
  }
  function clear() { for (const p of [...planes.values()]) { scene.remove(p.line); p.line.geometry.dispose(); drop(p); } onCount?.(0); }
  function update(dt, camera) {
    if (!planes.size) return;
    const now = Date.now(), cp = camera.position;
    for (const p of planes.values()) {
      const a = p.a, sec = Math.min(Math.max((now - p.fix.t) / 1000, 0), 60), s = (a.gs || 0) * KT * sec, trk = a.trk ?? p.h;
      const tx = p.fix.x + Math.sin(trk * DEG) * s, tz = p.fix.z - Math.cos(trk * DEG) * s;
      const ty = Math.max(0, p.fix.y + (a.ground ? 0 : (a.vr || 0) * FT / 60 * sec));
      const k = p.placed ? Math.min(1, dt * 1.5) : 1; p.placed = true;   // a new report eases her across, no jump
      p.x += (tx - p.x) * k; p.z += (tz - p.z) * k; p.y += (ty - p.y) * k;
      const turn = ((trk - p.h + 540) % 360) - 180; p.h = (p.h + Math.max(-30 * dt, Math.min(30 * dt, turn)) + 360) % 360;
      p.g.position.set(p.x, p.y, p.z);
      // her attitude (v1109, against a United Express E175 on final): nose up 3° coming in, 8° climbing, 2° level
      const want = !p.real || a.ground ? 0 : (a.vr ?? 0) < -300 ? 3 : (a.vr ?? 0) > 500 ? 8 : 2;
      p.pitch = (p.pitch ?? want) + (want - (p.pitch ?? want)) * Math.min(1, dt * 0.5);
      p.model.rotation.order = 'YXZ'; p.model.rotation.set(p.pitch * DEG, -p.h * DEG, 0);
      // big enough to see from afar: her real size near, about 0.9% of the distance away from her farther off
      const d = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z), L = lengthOf(a);
      p.model.scale.setScalar(p.real ? Math.max(1, d * 0.014 / p.L) : Math.max(L, d * 0.014));   // (an airliner is built in metres; the small plane is 1 m long)
      const P = p.line.geometry.attributes.position; P.setXYZ(0, p.x, p.y, p.z); P.setXYZ(1, p.x, 0, p.z); P.needsUpdate = true;
      p.line.visible = p.y > 30 && !riding(p); p.tag.visible = p === hover || pinned.has(p) || focus(p);
    }
  }
  return {
    start() { if (on) return; on = true; poll(); },
    stop() { on = false; clearTimeout(timer); inflight?.abort(); clear(); },
    update,
    // the aircraft under a point on the screen (client px), within reach px of her: for hover and tap
    at(cx, cy, camera, rect, reach = 22) {
      let best = null, bd = reach;
      for (const p of planes.values()) {
        _v.copy(p.g.position).project(camera); if (_v.z >= 1) continue;
        const d = Math.hypot(rect.left + (_v.x + 1) / 2 * rect.width - cx, rect.top + (1 - _v.y) / 2 * rect.height - cy);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    },
    set hover(p) { hover = p; },
    has: p => planes.get(p?.a?.hex) === p,
    items: () => [...planes.values()],
    toggle(p) { if (pinned.has(p)) pinned.delete(p); else pinned.add(p); },
    pin(hex, show = true) { const p = planes.get(hex); if (p) { if (show) pinned.add(p); else pinned.delete(p); } return !!p; },   // (for a recording)
    unpinAll() { const any = pinned.size > 0; pinned.clear(); return any; },
    get on() { return on; },
    get count() { return planes.size; },
    list: (camera, rect) => [...planes.values()].map(p => {   // (for checking from a script: where she is on the screen, and whether her label shows)
      const o = { ...p.a, y: Math.round(p.y), shown: p.tag.visible, at: { lon: p.fix.lon + (p.x - p.fix.x) / (111320 * Math.cos(p.fix.lat * DEG)), lat: p.fix.lat - (p.z - p.fix.z) / 111120 } };
      if (camera && rect) { _v.copy(p.g.position).project(camera); if (_v.z < 1) { o.sx = Math.round(rect.left + (_v.x + 1) / 2 * rect.width); o.sy = Math.round(rect.top + (1 - _v.y) / 2 * rect.height); } }
      return o;
    }),
  };
}
