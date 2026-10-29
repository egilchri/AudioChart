// Flyover (v1046, requested: "a flyover feature in the app ... a table of places, and they would check which ones
// they wanted to fly over"; v1048: "I want the helicopter to fly around, giving the tour"): the red helicopter from
// the sailors-page videos (heli3d.js) flies Bird's-eye through a list of stops, the camera riding just behind her,
// climbing for the long hops and coming down low at each place. Each stop's name is said as it comes into view
// (tts.js, the device's voice), and the camera turns slowly round it for a few seconds before going on. A stop can be a
// vessel (bay3d.js adds the ships near the way): the camera keeps up with her while she moves, and her card opens.
// She takes off from a pad (the bay's heliport, regions3d.js, or a spot you pick; v1049: "We should always take off
// from the same place ... a way to specify takeoff and landing spot"): the rotors wind up, she lifts off and climbs
// away, the camera swinging round from her side to astern of her. At the end she comes in over the landing pad (the
// take-off one, unless you've picked another, or none), settles down onto it and winds down, and waits there.
// A stop can be a landing on the way (v1056, requested: "designate some landing spots during the flyover. For example,
// Crow Island in the Cranberry Isles, or the open soccer field on Islesford"): she comes in, settles onto it, sits a
// few seconds with the rotors idling, and lifts off again for the next stop.
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
// spot (take-off and landing): { name, x, z, y() → the ground's height there }
// a landing on the way: { name, say?, touch: true, spot, hold? } (its target is worked out here)
export function makeFlyover({ view, bar, camera, scene, onEnd, brgTxt = t => `${Math.round(t)}°`, groundY = () => 0 }) {
  let tour = null, spots = { from: null, to: null }, parked = null;
  // the helicopter: ahead of the camera and a little below, her nose the way we look, banked into the turns (as the
  // videos' recorder put her); paused, she hovers where she was; between tours she waits on her pad
  const heli = makeHeli(); heli.group.visible = false; scene.add(heli.group);
  const H = { prevAz: null, roll: 0, back: 1, hover: new THREE.Vector3() }, dir = new THREE.Vector3(), at = new THREE.Vector3();
  const SKID = 1.6, HIGH = 45;   // (her skids, below her middle; how high she climbs straight up)
  // helipads: a grey disc with a white ring and H, at the take-off and landing spots
  const padTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
    x.fillStyle = '#4a4f55'; x.beginPath(); x.arc(128, 128, 126, 0, 7); x.fill();
    x.strokeStyle = '#f2f2ee'; x.lineWidth = 12; x.beginPath(); x.arc(128, 128, 104, 0, 7); x.stroke();
    x.fillStyle = '#f2f2ee'; x.fillRect(84, 66, 20, 124); x.fillRect(152, 66, 20, 124); x.fillRect(84, 118, 88, 20);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const pads = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.CircleGeometry(11, 40), new THREE.MeshLambertMaterial({ map: padTex, polygonOffset: true, polygonOffsetFactor: -4 })); m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m); return m; });
  const putPads = () => [spots.from, spots.to].forEach((p, i) => { pads[i].visible = !!p; if (p) pads[i].position.set(p.x, p.y() + 0.25, p.z); });
  const text = bar.querySelector('.fly-text'), playBtn = bar.querySelector('.fly-play'), endBtn = bar.querySelector('.fly-end');
  const caption = s => { text.textContent = s; };
  const speak = s => { if (tour?.talk && s) try { TTS?.sayImmediate(spoken(s)); } catch (_) {} };
  const hush = () => { try { TTS?.stop(); } catch (_) {} };
  const smooth = u => u * u * (3 - 2 * u);
  // a leg's way along (0 to 1) at time u (0 to 1): speeding up for the first a of it, at speed, slowing down for
  // the last a (so the speed shown is the speed she cruises at, not an average under a peak half as fast again)
  const trap = (u, a) => { const v = 1 / (1 - a); return u < a ? v * u * u / (2 * a) : u > 1 - a ? 1 - v * (1 - u) * (1 - u) / (2 * a) : v * (u - a / 2); };
  // her speed (v1053, requested: realistic, sped up on long legs): a touring helicopter's 130 knots, in real time
  // for a leg of up to 15 s; past that, the time is squeezed (a 5 km leg takes 38 s, not 75; 20 km 77 s, not 5 min),
  // and the bar says how much faster than real it is
  const CRUISE = 130 * 1852 / 3600, REAL_S = 15;
  const bearing = (a, b) => Math.atan2(b.x - a.x, -(b.z - a.z));
  const turn = (a, b) => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };
  // where the camera is over the ground for a view (as bay3d.js's placeCamera puts it), and the view back from it
  const camAt = v => { const h = v.dist * Math.sin(v.tilt); return { x: v.x - Math.sin(v.az) * h, z: v.z + Math.cos(v.az) * h }; };

  // the view of her over a pad: e = 0 on it (from her side, close), 1 up at HIGH (astern of her, further back). The
  // target is where the line through her meets sea level, so she's in the middle however high the ground is.
  function padView(p, e, nose, hy) {
    const az = nose + (1 - e) * 1.25, tilt = (64 - 6 * e) * Math.PI / 180, fwd = hy * Math.tan(tilt);
    return { x: p.x + Math.sin(az) * fwd, z: p.z - Math.cos(az) * fwd, dist: 48 + 140 * e, tilt, az };
  }
  // a leg's time (the 15%: the time speeding up and slowing down takes)
  const legSec = hop => { const real = hop / CRUISE; return Math.max(4, (real <= REAL_S ? real : REAL_S + (real - REAL_S) ** 0.7) * 1.15); };
  // the clock (v1062, requested: "a clock or some way of showing elapsed time and how much time to go"): time flown
  // (not counting pauses), and the tour's time to go, worked out again at the start of each leg from the stops left
  const timeEl = bar.querySelector('.fly-time');
  const flown = now => (tour.paused ? tour.pausedAt : now) - tour.started - tour.pausedMs;
  const atStop = S => S.land ? (SETTLE + DOWN + WIND) / 1000 + (S.hold || 0) + (S.final ? 0 : (UP + CLIMB) / 1000) : S.hold || 0;
  const toGo = (i, p) => { let t = 0; for (; i < tour.stops.length; i++) { const S = tour.stops[i]; t += legSec(Math.hypot(S.x - p.x, S.z - p.z)) + atStop(S); p = S; } return t; };
  const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  let shownAt = 0;
  function showTime(now) {
    if (!timeEl || now - shownAt < 250) return;
    shownAt = now; const f = flown(now) / 1000;
    timeEl.textContent = `⏱ ${mmss(f)} · ${mmss(Math.max(0, tour.eta - f))} to go`; timeEl.hidden = false;
  }
  function leg(now) {   // from wherever the camera is now to stop i
    const S = tour.stops[tour.i];
    if (S.land) tour.landNose = bearing(camAt(view), S);   // (she comes in over the pad on the line she's flying)
    const to = S.target(), from = { ...view };
    // she flies the straight line between where the camera is now and where it'll be over the stop (the camera, and
    // she just ahead of it, going at an even speed; not the point it looks at, which swings round as it turns)
    const cf = camAt(from), ct = camAt(to), hop = Math.hypot(ct.x - cf.x, ct.z - cf.z), track = bearing(cf, ct);
    // long hops fly higher, as flyTo does, but no higher than a helicopter would (the ground has to keep up)
    const peak = Math.max(from.dist, to.dist, Math.min(hop * 0.6, 1800));
    const real = hop / CRUISE, sec = legSec(hop), a = Math.min(5, sec / 3) / sec;
    const fast = hop / (1 - a) / sec / CRUISE;   // (how much faster than real she cruises)
    Object.assign(tour, { phase: 'fly', t0: now, from, cf, track, dur: sec * 1000, a, pin: null,
      bump: Math.max(0, Math.log(peak) - Math.max(Math.log(from.dist), Math.log(to.dist))), spoke: false,
      fastTxt: fast >= 1.5 ? ` · ⏩ ×${Math.round(fast)} speed` : '', rb: real > REAL_S ? 0 : null });
    tour.eta = flown(now) / 1000 + sec + atStop(S) + toGo(tour.i + 1, S);
    stopCaption(tour.fastTxt);
  }
  function stopCaption(extra = '') {
    const S = tour.stops[tour.i], n = tour.stops.filter(s => !s.final).length;
    caption((S.final ? S.name : `${tour.i + 1} of ${n} · ${S.name}`) + extra);
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
  // the take-off: on the pad 3 s (the rotors winding up), then 4.5 s straight up and away, the view swinging round
  // from her side to astern of her
  const UP = 3000, CLIMB = 4500;
  function takeoff(now) {
    const p = tour.pad, L = now - tour.t0, e = smooth(clamp((L - UP) / CLIMB, 0, 1)), gy = p.y();
    tour.spin = clamp(L / UP, 0.15, 1);
    const hy = gy + SKID + HIGH * e * e;
    Object.assign(view, padView(p, e, tour.noseAz, hy));
    tour.pin = { x: p.x, y: hy, z: p.z, nose: tour.noseAz, pitch: -0.12 * e };
    if (L >= UP + CLIMB) {
      tour.ground = false; tour.spin = 1; H.hover.set(p.x, hy, p.z); H.back = 0; H.prevAz = null;
      if (tour.liftNext) { tour.liftNext = false; next(now); } else leg(now);   // (off a landing on the way: on to the next stop)
    }
  }
  // the landing: 2 s to settle over the pad, 4.5 s down (the view swinging round to her side), 2.5 s winding down
  const SETTLE = 2000, DOWN = 4500, WIND = 2500;
  function landing(now) {
    const p = tour.stops[tour.i], L = now - tour.t0, e = 1 - smooth(clamp((L - SETTLE) / DOWN, 0, 1)), gy = p.y();
    const hy = gy + SKID + HIGH * e * e, k = smooth(clamp(L / SETTLE, 0, 1));
    Object.assign(view, padView(p, e, tour.landNose, hy));
    at.set(p.x, hy, p.z).lerp(H.hover, 1 - k);
    tour.pin = { x: at.x, y: at.y, z: at.z, nose: tour.landNose, pitch: -0.12 * e };
    tour.spin = 1 - 0.85 * clamp((L - SETTLE - DOWN) / WIND, 0, 1);
    if (L < SETTLE + DOWN + WIND) return;
    // down: she sits there (on a landing on the way, then takes off on the heading she came in on) while the view
    // looks round where she's come down
    Object.assign(tour, { phase: 'sit', t0: now, pad: p, noseAz: tour.landNose, liftNext: !p.final, close: { ...view } });
    caption(p.final ? `Landed at ${p.spotName}` : `On the ground at ${p.spotName}`);
  }
  // the look round (v1058, requested: "more focus to the surrounding landscape, when we land"): the view rises off
  // her and back, low, to see the place round her and the hills beyond, turning slowly round her; on a landing on the
  // way it comes back in to her for the take-off
  const OUT = 3500, BACK = 3000, WIDE = 600, WIDE_TILT = 76 * Math.PI / 180;
  function lookRound(L, T, back) {
    const c = tour.close, p = tour.pad, w = smooth(clamp(L / OUT, 0, 1)) * (back ? 1 - smooth(clamp((L - (T - BACK)) / BACK, 0, 1)) : 1);
    Object.assign(view, { x: c.x + (p.x - c.x) * w, z: c.z + (p.z - c.z) * w, tilt: c.tilt + (WIDE_TILT - c.tilt) * w,
      dist: Math.exp(Math.log(c.dist) + (Math.log(WIDE) - Math.log(c.dist)) * w), az: c.az + L * 0.00006 * w });
    // looking higher down on her where a hill behind would hide her (or the camera be in it)
    for (let k = 0; k < 25; k++) { const g = camAt(view); if (view.dist * Math.cos(view.tilt) > groundY(g.x, g.z) + 40) break; view.tilt -= 2 * Math.PI / 180; }
  }
  function step(now, dt) {
    if (!tour || tour.paused) return;
    showTime(now);
    if (tour.ground) { takeoff(now); return; }
    if (tour.phase === 'land') { landing(now); return; }
    if (tour.phase === 'sit') {
      const S = tour.stops[tour.i], L = now - tour.t0, T = S.hold * 1000;
      lookRound(L, T, !S.final);
      if (L > T) { if (S.final) end('landed'); else { tour.ground = true; tour.t0 = now; caption(`Taking off from ${tour.pad.spotName}`); } }
      return;
    }
    const S = tour.stops[tour.i], to = S.target?.();
    if (!to) { next(now); return; }   // (a vessel that's gone)
    if (tour.phase === 'fly') {
      const u = clamp((now - tour.t0) / tour.dur, 0, 1), e = trap(u, tour.a), f = tour.from, cf = tour.cf, ct = camAt(to);
      // she turns onto her track as she sets off, flies it looking ahead, and turns to the stop's view as she comes in
      const r = Math.min(0.5, 6000 / tour.dur), w1 = smooth(clamp(u / r, 0, 1)), w2 = smooth(clamp((u - (1 - r)) / r, 0, 1));
      const az1 = f.az + turn(f.az, tour.track) * w1;
      view.az = az1 + turn(az1, to.az) * w2; view.tilt = f.tilt + (to.tilt - f.tilt) * e;
      view.dist = Math.exp(Math.log(f.dist) + (Math.log(to.dist) - Math.log(f.dist)) * e + tour.bump * Math.sin(Math.PI * u));
      const h = view.dist * Math.sin(view.tilt), cx = cf.x + (ct.x - cf.x) * e, cz = cf.z + (ct.z - cf.z) * e;
      view.x = cx + Math.sin(view.az) * h; view.z = cz - Math.cos(view.az) * h;
      if (!tour.spoke && u > Math.max(0.7, 1 - 4000 / tour.dur)) arrive();   // (its name, a few seconds out)
      // on a long leg (v1057, requested: "For longer legs, please put the range and bearing to the place"): from her
      // to it, a few times a second, till she's there
      if (tour.rb != null && now - tour.rb > 250 && u < 1) {
        tour.rb = now;
        const P = S.land ? S : to, hp = heli.group.position, d = Math.hypot(P.x - hp.x, P.z - hp.z) / 1852;
        const deg = (Math.atan2(P.x - hp.x, -(P.z - hp.z)) * 180 / Math.PI + 360) % 360;
        stopCaption(` · ${d < 10 ? d.toFixed(1) : Math.round(d)} nm ${brgTxt(deg)}${tour.fastTxt}`);
      }
      if (u >= 1) {
        if (S.land) { tour.phase = 'land'; tour.t0 = now; H.hover.copy(heli.group.position); stopCaption(); }
        else { tour.phase = 'hold'; tour.t0 = now; tour.az = view.az; stopCaption(); }
      }
    } else {   // round her slowly, keeping up if she's under way
      tour.az += dt * 0.07;
      Object.assign(view, { x: to.x, z: to.z, dist: to.dist, tilt: to.tilt, az: tour.az });
      if (now - tour.t0 > S.hold * 1000) next(now);
    }
  }
  const pose = (x, y, z, nose, pitch = 0) => { heli.group.position.set(x, y, z); heli.group.rotation.set(0, 0, 0); heli.group.rotateY(-nose); heli.group.rotateX(pitch); };
  // after the camera's placed for the frame (bay3d.js)
  function place(dt) {
    if (!tour) {   // waiting on her pad (the ground under it may still be loading)
      if (parked) pose(parked.p.x, parked.p.y() + SKID, parked.p.z, parked.nose);
      if (spots.from || spots.to) putPads();
      return;
    }
    heli.rotor.rotation.y += dt * 22 * tour.spin; heli.tail.rotation.x += dt * 32 * tour.spin;
    if (tour.paused) return;   // (hovering)
    putPads();
    if (tour.pin) { const P = tour.pin; pose(P.x, P.y, P.z, P.nose, P.pitch); return; }   // (taking off or landing)
    const cam = camera.position;
    dir.set(view.x - cam.x, -cam.y, view.z - cam.z).normalize();
    const D = Math.min(60, 26 + view.dist * 0.004) * (camera.aspect < 1 ? 1.5 : 1);   // (a phone held upright: a little further off)
    at.set(cam.x + dir.x * D, cam.y + dir.y * D - D * 0.34, cam.z + dir.z * D);
    if (H.back < 1) { H.back = Math.min(1, H.back + dt / 1.5); at.lerpVectors(H.hover, at, smooth(H.back)); }   // (back in front of you after a pause or the take-off)
    heli.group.position.copy(at);
    let turn = 0; if (H.prevAz != null && dt > 0) { let d = view.az - H.prevAz; d = Math.atan2(Math.sin(d), Math.cos(d)); turn = d / dt * 180 / Math.PI; }
    H.prevAz = view.az;
    H.roll += (clamp(-turn * 1.6, -28, 28) - H.roll) * Math.min(1, dt * 2);
    heli.group.rotation.set(0, 0, 0); heli.group.rotateY(-view.az); heli.group.rotateZ(H.roll * Math.PI / 180); heli.group.rotateX(-0.09);
  }
  function park(p, nose = 0) { parked = p ? { p, nose } : null; heli.group.visible = !!p; }
  // where she takes off from and lands (null: no landing, the tour ends in the air); she waits on the take-off pad
  function setSpots(from, to) {
    spots = { from, to }; putPads();
    if (!tour) park(from, parked?.p === from ? parked.nose : 0);
  }
  function start(stops, { talk = true } = {}) {
    if (!stops.length) return;
    end();
    const to = spots.to, from = spots.from;
    const pad = (s, spot) => ({ ...s, land: true, x: spot.x, z: spot.z, y: spot.y, spotName: spot.name, target: () => padView(spot, 1, tour.landNose, spot.y() + SKID + HIGH) });
    stops = stops.map(s => s.touch ? pad({ hold: 14, ...s }, s.spot) : s);   // (v1058: 14 s, for the look round)
    if (to) stops = [...stops, pad({ name: `Landing at ${to.name}`, say: `Landing at ${to.name}`, final: true, hold: 9 }, to)];
    const t0 = performance.now();
    tour = { stops, i: 0, talk, paused: false, spin: 1, pin: null, started: t0, pausedMs: 0, pausedAt: 0 };
    tour.eta = from ? (UP + CLIMB) / 1000 + toGo(0, from) : 0;   // (none: leg() works it out)
    parked = null; heli.group.visible = true; H.prevAz = null; H.roll = 0; H.back = 1;
    bar.hidden = false; playBtn.textContent = '⏸'; playBtn.title = 'Pause the flyover';
    if (from) {   // on the pad, her nose toward the first stop
      Object.assign(tour, { ground: true, pad: from, t0: performance.now(), noseAz: bearing(from, stops[0]), spin: 0.15 });
      caption(`Taking off from ${from.name}`); speak(`Taking off from ${from.name}`);
      takeoff(tour.t0);
    } else leg(performance.now());
  }
  function pause() {
    if (!tour || tour.paused) return;
    tour.paused = true; tour.pausedAt = performance.now(); hush(); H.hover.copy(heli.group.position);
    playBtn.textContent = '▶'; playBtn.title = 'Go on with the flyover';
    caption(`Paused · next: ${tour.stops[tour.i].name}`);
  }
  function resume() {
    if (!tour || !tour.paused) return;
    tour.pausedMs += performance.now() - tour.pausedAt;
    tour.paused = false; playBtn.textContent = '⏸'; playBtn.title = 'Pause the flyover'; H.back = 0; H.prevAz = null;
    tour.ground = false; tour.spin = 1;   // (paused on the pad or climbing: she goes straight on to the first stop; landing: she comes round again)
    if (tour.phase === 'sit' && tour.stops[tour.i].final) { end('landed'); return; }   // (paused looking round where she ended)
    if (tour.liftNext) { tour.liftNext = false; next(performance.now()); }   // (paused on, or lifting off, a landing on the way: on to the next)
    else leg(performance.now());   // (back to the stop it was at, from wherever you've moved to)
  }
  function end(why) {
    if (!tour) return;
    const t = tour; tour = null; if (timeEl) timeEl.hidden = true;
    t.stops[t.i]?.onLeave?.(); hush();
    const later = (s, then) => { caption(s); playBtn.hidden = true; setTimeout(() => { if (!tour) { bar.hidden = true; playBtn.hidden = false; then?.(); } }, 2500); };
    if (why === 'landed') { const p = t.stops[t.i]; park(p, t.landNose); later(`Landed at ${p.spotName}`); }
    else if (why === 'done') later('Flyover done', () => park(spots.from));
    else { bar.hidden = true; park(spots.from); }
    onEnd?.(why);
  }
  playBtn.addEventListener('click', () => tour?.paused ? resume() : pause());
  endBtn.addEventListener('click', () => end());
  addEventListener('keydown', e => { if (e.key === 'Escape' && tour) end(); });
  return { start, step, place, pause, end, setSpots, heliAt: () => heli.group.visible ? heli.group.position : null, active: () => !!tour && !tour.paused, on: () => !!tour };
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
