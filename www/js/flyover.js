// Flyover (v1046, requested: "a flyover feature in the app ... a table of places, and they would check which ones
// they wanted to fly over"; v1048: "I want the helicopter to fly around, giving the tour"): the red helicopter from
// the sailors-page videos (heli3d.js) flies Bird's-eye through a list of stops, the camera riding just behind her,
// climbing for the long hops and coming down low at each place. Each stop's name is said as it comes into view
// (tts.js, the device's voice), and the camera turns slowly round it for a few seconds before going on. A stop can be a
// vessel (bay3d.js adds the ships near the way): the camera keeps up with her while she moves, and her card opens.
// Any drag, zoom or tap pauses the tour: she hovers where she is while you look round; ▶ and she comes back in
// front of you and goes on to the same stop; ✕ ends it.
// This module is only the flying, the voice and the bar along the top; bay3d.js chooses and orders the stops.

import * as THREE from 'three';
import { makeHeli } from './heli3d.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// what the device's voice gets instead (the names it says wrong; design/pending/voice/lexicon.json has Piper's)
const RESPELL = { Vinalhaven: 'Vynalhaven', Carquinez: 'Carkeenez', Rafael: 'Ruffelle', Tiburon: 'Tibberon', buoy: 'booey' };
const spoken = s => s.replace(/\b[A-Za-z]+\b/g, w => RESPELL[w] || RESPELL[w.toLowerCase()] || w);

let TTS = null;
import('./tts.js').then(m => { TTS = m; }).catch(() => {});   // (no speech on this device: the tour flies silent)

// stop: { name, say?, target() → { x, z, dist, az, tilt } (radians), hold (s), onArrive?(), onLeave?() }
export function makeFlyover({ view, bar, camera, scene, onEnd }) {
  let tour = null;
  // the helicopter: ahead of the camera and a little below, her nose the way we look, banked into the turns (as the
  // videos' recorder put her); paused, she hovers where she was
  const heli = makeHeli(); heli.group.visible = false; scene.add(heli.group);
  const H = { prevAz: null, roll: 0, back: 1, hover: new THREE.Vector3() }, dir = new THREE.Vector3(), at = new THREE.Vector3();
  const text = bar.querySelector('.fly-text'), playBtn = bar.querySelector('.fly-play'), endBtn = bar.querySelector('.fly-end');
  const caption = s => { text.textContent = s; };
  const speak = s => { if (tour?.talk && s) try { TTS?.sayImmediate(spoken(s)); } catch (_) {} };
  const hush = () => { try { TTS?.stop(); } catch (_) {} };

  function leg(now) {   // from wherever the camera is now to stop i
    const S = tour.stops[tour.i], to = S.target(), from = { ...view };
    const hop = Math.hypot(to.x - from.x, to.z - from.z);
    // long hops fly higher, as flyTo does, and take longer, but never so fast the ground can't keep up
    const peak = Math.max(from.dist, to.dist, hop * 0.6);
    let daz = (to.az - from.az) % (2 * Math.PI); if (daz > Math.PI) daz -= 2 * Math.PI; if (daz < -Math.PI) daz += 2 * Math.PI;
    Object.assign(tour, { phase: 'fly', t0: now, from, daz, dur: clamp(3.5 + hop / 1300, 4, 18) * 1000,
      bump: Math.max(0, Math.log(peak) - Math.max(Math.log(from.dist), Math.log(to.dist))), spoke: false });
    caption(`${tour.i + 1} of ${tour.stops.length} · ${S.name}`);
  }
  function arrive() {
    const S = tour.stops[tour.i];
    tour.spoke = true; speak(S.say ?? S.name); S.onArrive?.();
  }
  function next(now) {
    tour.stops[tour.i].onLeave?.();
    tour.i++;
    if (tour.i >= tour.stops.length) { end('done'); return; }
    leg(now);
  }
  function step(now, dt) {
    if (!tour || tour.paused) return;
    const S = tour.stops[tour.i], to = S.target?.();
    if (!to) { next(now); return; }   // (a vessel that's gone)
    if (tour.phase === 'fly') {
      const u = clamp((now - tour.t0) / tour.dur, 0, 1), e = u * u * (3 - 2 * u), f = tour.from;
      view.x = f.x + (to.x - f.x) * e; view.z = f.z + (to.z - f.z) * e;
      view.az = f.az + tour.daz * e; view.tilt = f.tilt + (to.tilt - f.tilt) * e;
      view.dist = Math.exp(Math.log(f.dist) + (Math.log(to.dist) - Math.log(f.dist)) * e + tour.bump * Math.sin(Math.PI * u));
      if (!tour.spoke && u > 0.7) arrive();
      if (u >= 1) { tour.phase = 'hold'; tour.t0 = now; tour.az = view.az; }
    } else {   // round her slowly, keeping up if she's under way
      tour.az += dt * 0.07;
      Object.assign(view, { x: to.x, z: to.z, dist: to.dist, tilt: to.tilt, az: tour.az });
      if (now - tour.t0 > S.hold * 1000) next(now);
    }
  }
  // after the camera's placed for the frame (bay3d.js)
  function place(dt) {
    if (!heli.group.visible) return;
    heli.rotor.rotation.y += dt * 22; heli.tail.rotation.x += dt * 32;
    if (tour?.paused) return;   // (hovering)
    const cam = camera.position;
    dir.set(view.x - cam.x, -cam.y, view.z - cam.z).normalize();
    const D = Math.min(60, 26 + view.dist * 0.004) * (camera.aspect < 1 ? 1.5 : 1);   // (a phone held upright: a little further off)
    at.set(cam.x + dir.x * D, cam.y + dir.y * D - D * 0.34, cam.z + dir.z * D);
    if (H.back < 1) { H.back = Math.min(1, H.back + dt / 1.5); const k = H.back * H.back * (3 - 2 * H.back); at.lerpVectors(H.hover, at, k); }   // (back in front of you after a pause)
    heli.group.position.copy(at);
    let turn = 0; if (H.prevAz != null && dt > 0) { let d = view.az - H.prevAz; d = Math.atan2(Math.sin(d), Math.cos(d)); turn = d / dt * 180 / Math.PI; }
    H.prevAz = view.az;
    H.roll += (clamp(-turn * 1.6, -28, 28) - H.roll) * Math.min(1, dt * 2);
    heli.group.rotation.set(0, 0, 0); heli.group.rotateY(-view.az); heli.group.rotateZ(H.roll * Math.PI / 180); heli.group.rotateX(-0.09);
  }
  function start(stops, { talk = true } = {}) {
    if (!stops.length) return;
    end();
    tour = { stops, i: 0, talk, paused: false };
    heli.group.visible = true; H.prevAz = null; H.roll = 0; H.back = 1;
    bar.hidden = false; playBtn.textContent = '⏸'; playBtn.title = 'Pause the flyover';
    leg(performance.now());
  }
  function pause() {
    if (!tour || tour.paused) return;
    tour.paused = true; hush(); H.hover.copy(heli.group.position);
    playBtn.textContent = '▶'; playBtn.title = 'Go on with the flyover';
    caption(`Paused · next: ${tour.stops[tour.i].name}`);
  }
  function resume() {
    if (!tour || !tour.paused) return;
    tour.paused = false; playBtn.textContent = '⏸'; playBtn.title = 'Pause the flyover'; H.back = 0; H.prevAz = null;
    leg(performance.now());   // (back to the stop it was at, from wherever you've moved to)
  }
  function end(why) {
    if (!tour) return;
    const t = tour; tour = null;
    t.stops[t.i]?.onLeave?.(); hush();
    if (why === 'done') { caption('Flyover done'); playBtn.hidden = true; setTimeout(() => { if (!tour) { bar.hidden = true; playBtn.hidden = false; heli.group.visible = false; } }, 2500); }
    else { bar.hidden = true; heli.group.visible = false; }
    onEnd?.(why);
  }
  playBtn.addEventListener('click', () => tour?.paused ? resume() : pause());
  endBtn.addEventListener('click', () => end());
  addEventListener('keydown', e => { if (e.key === 'Escape' && tour) end(); });
  return { start, step, place, pause, end, active: () => !!tour && !tour.paused, on: () => !!tour };
}

// the order to fly them in: nearest first from where you are, then any two crossing legs uncrossed (2-opt)
export function orderStops(stops, from) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z), left = stops.slice(), out = [];
  let at = from;
  while (left.length) { left.sort((a, b) => d(at, a) - d(at, b)); at = left.shift(); out.push(at); }
  const len = r => r.reduce((s, p, i) => s + d(i ? r[i - 1] : from, p), 0);
  for (let better = true, n = 0; better && n < 50; n++) {
    better = false;
    for (let i = 0; i < out.length - 1; i++) for (let j = i + 1; j < out.length; j++) {
      const r = [...out.slice(0, i), ...out.slice(i, j + 1).reverse(), ...out.slice(j + 1)];
      if (len(r) < len(out) - 1) { out.splice(0, out.length, ...r); better = true; }
    }
  }
  return out;
}

// how far a point is from the line between two others (for the ships near the way)
export function offLeg(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1, u = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / L2, 0, 1);
  return { d: Math.hypot(p.x - (a.x + dx * u), p.z - (a.z + dz * u)), u };
}
