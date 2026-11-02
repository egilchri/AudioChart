// Live aircraft in Bird's-eye (v1098): ADS-B, the air's AIS, through the relay's GET /aircraft (relay/ais/core.mjs,
// from adsb.lol). Each aircraft flies at her reported altitude, moved on between reports at her ground speed and
// track, with a faint line down to the water so you can tell how high she is, and her flight and height beside her.
// On with 📡 Live; like Live AIS it needs an internet connection.
import * as THREE from 'three';
import { relayUrl } from './ais.js';

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

export function makeAircraft({ scene, bbox, wx, wz, every = 5000, onCount }) {
  const planes = new Map();   // hex -> { a, g, model, line, label, fix, x, y, z, h }
  let on = false, timer = null, inflight = null;
  const lineMat = new THREE.LineBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.35 });
  function drop(p) { scene.remove(p.g); p.g.traverse(o => { o.geometry?.dispose(); if (o.material && o.material !== lineMat) { o.material.map?.dispose(); o.material.dispose(); } }); planes.delete(p.a.hex); }
  function data(j) {
    const now = Date.now(), seen = new Set();
    for (const a of j.aircraft || []) {
      seen.add(a.hex);
      let p = planes.get(a.hex);
      if (!p) {
        const g = new THREE.Group(), model = planeModel(colourOf(a)), label = labelSprite();
        const line = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), lineMat);
        line.frustumCulled = false; g.add(model, label); scene.add(g, line);
        p = { g, model, line, label, x: wx(a.lon), z: wz(a.lat), y: (a.alt || 0) * FT, h: a.trk || 0, placed: false };
        g.userData.lineObj = line; planes.set(a.hex, p);
      }
      p.a = a; p.fix = { x: wx(a.lon), z: wz(a.lat), y: (a.alt || 0) * FT, t: now - (a.age || 0) * 1000 };
      const alt = a.ground ? 'on the ground' : a.alt >= 18000 ? `FL${Math.round(a.alt / 100)}` : `${Math.round(a.alt / 100) * 100} ft`;
      p.label.userData.draw(`${a.flight || a.reg || a.hex} · ${alt}`);
    }
    for (const p of [...planes.values()]) if (!seen.has(p.a.hex)) { scene.remove(p.line); p.line.geometry.dispose(); drop(p); }
    onCount?.(planes.size);
  }
  async function poll() {
    if (!on) return;
    const ctl = new AbortController(); inflight = ctl; const kill = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(`${relayUrl()}/aircraft?bbox=${bbox.map(v => v.toFixed(3)).join(',')}`, { signal: ctl.signal, cache: 'no-store' });
      const j = await r.json(); if (on && r.ok) data(j);
    } catch (_) {} finally { clearTimeout(kill); if (inflight === ctl) inflight = null; }
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
      p.g.position.set(p.x, p.y, p.z); p.model.rotation.y = -p.h * DEG;
      // big enough to see from afar: her real size near, about 0.9% of the distance away from her farther off
      const d = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z), L = lengthOf(a);
      p.model.scale.setScalar(Math.max(L, d * 0.014));
      const P = p.line.geometry.attributes.position; P.setXYZ(0, p.x, p.y, p.z); P.setXYZ(1, p.x, 0, p.z); P.needsUpdate = true;
      p.line.visible = p.y > 30; p.label.visible = !a.ground;
    }
  }
  return {
    start() { if (on) return; on = true; poll(); },
    stop() { on = false; clearTimeout(timer); inflight?.abort(); clear(); },
    update,
    get on() { return on; },
    get count() { return planes.size; },
    list: () => [...planes.values()].map(p => ({ ...p.a, y: Math.round(p.y) })),
  };
}
