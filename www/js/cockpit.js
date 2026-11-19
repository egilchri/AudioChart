// The cockpit you look out of (v1135, requested: "recursively improve the cockpit views"). Riding in a plane's
// cockpit used to put the eye inside her own 3D shell: grey inner faces and her propeller's disc, nothing outside.
// Now her model is hidden from inside and this draws the cockpit round the view instead: a glareshield and
// instrument panel along the bottom, window pillars at the sides, and her instruments reading her own ADS-B: round
// dials (airspeed, altimeter, heading, climb) in a light plane or a helicopter, glass screens in a jet.
// makeCockpit(el) → { show(kind), hide(), update({ gs, alt, hdg, vr, ground }) }; kind: 'light' | 'heli' | 'jet'
// (v1161, asked: "work on the cab views of the subways ... when we pull into a station and see the people on the
// platforms") 'train': a subway or railroad cab's front, its window's frame and the storm door's post, and a low
// desk with her speed and the next stop in amber; update({ gs: mph, next, dest })
const NS = 'http://www.w3.org/2000/svg';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = n => Math.round(n).toLocaleString('en-US');

// a round dial (viewBox -50..50): its ticks and figures, and the needles to turn
function dial(label, ticks, ly = -13) {
  return `<svg viewBox="-50 -50 100 100" class="dial"><circle r="47" class="rim"/><circle r="43" class="face"/>${label ? `<text y="${ly}" class="lab">${label}</text>` : ''}${ticks}</svg>`;
}
const tickRing = (n, from, span, long = 1, r0 = 37, r1 = 43) => {
  let s = '';
  for (let i = 0; i <= n; i++) {
    const a = (from + span * i / n) * Math.PI / 180, L = i % long === 0;
    s += `<line x1="${Math.sin(a) * (L ? r0 - 3 : r0)}" y1="${-Math.cos(a) * (L ? r0 - 3 : r0)}" x2="${Math.sin(a) * r1}" y2="${-Math.cos(a) * r1}" class="${L ? 'tk L' : 'tk'}"/>`;
  }
  return s;
};
const figs = (vals, from, span, r = 28) => vals.map((v, i) => {
  const a = (from + span * i / (vals.length - 1)) * Math.PI / 180;
  return `<text x="${(Math.sin(a) * r).toFixed(1)}" y="${(-Math.cos(a) * r + 3.5).toFixed(1)}" class="fig">${v}</text>`;
}).join('');
const needle = (cls, len, w = 2.6) => `<g class="${cls}"><path d="M${-w / 2},6 L0,${-len} L${w / 2},6 Z" class="ndl"/></g>`;

// (v1167, asked: "The helm of a tug or ship should look like you are peering out from the pilot house") 'wheelhouse':
// the deckhead over you, the front windows' posts, and the console under them: the radar sweeping, her heading and
// speed, two throttles, her wheel; update({ hdg, gs: knots })
function wheelPanel() {
  const radar = `<svg viewBox="-50 -50 100 100" class="radar"><circle r="47" class="rim"/><circle r="43" class="scope"/><circle r="29" class="ring"/><circle r="15" class="ring"/><line x1="-43" y1="0" x2="43" y2="0" class="ring"/><line x1="0" y1="-43" x2="0" y2="43" class="ring"/><g class="sweep"><path d="M0,0 L0,-43 A43,43 0 0,1 26,-34 Z" class="beam"/></g>${[[12, -20], [-18, 8], [25, 14], [-8, -30], [30, -8]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.8" class="blip"/>`).join('')}<line x1="0" y1="0" x2="0" y2="-43" class="head"/></svg>`;
  const levers = `<svg viewBox="0 0 70 100" class="tlever"><rect x="0" y="0" width="70" height="100" rx="8" class="tbase"/><rect x="12" y="10" width="12" height="80" rx="5" class="slot"/><rect x="46" y="10" width="12" height="80" rx="5" class="slot"/><text x="35" y="14" class="tlab">AHD</text><text x="35" y="93" class="tlab">AST</text><g class="n-thr"><rect x="4" y="44" width="28" height="11" rx="4" class="knob"/><rect x="38" y="44" width="28" height="11" rx="4" class="knob"/></g></svg>`;
  const vhf = `<div class="vhf"><div class="vlcd">CH <b>16</b></div><div class="vknobs"><i></i><i></i><i></i></div></div>`;
  const plot = `<svg viewBox="-50 -40 100 80" class="plotter"><rect x="-50" y="-40" width="100" height="80" rx="4" class="pbez"/><rect x="-45" y="-35" width="90" height="70" class="psea"/><g class="n-chart"><path d="M-45,-35 L-10,-35 C-18,-20 -30,-10 -45,-6 Z M45,10 C30,8 22,20 18,35 L45,35 Z" class="pland"/><path d="M-20,25 L-8,-30 M10,30 L22,-28" class="ptrk"/></g><path d="M0,-6 L4,5 L0,3 L-4,5 Z" class="pown"/><line x1="0" y1="-6" x2="0" y2="-30" class="phead"/></svg>`;
  const led = `<div class="tled wled"><div class="n-hdg"></div><div class="n-cog"></div><div class="n-spd"></div></div>`;
  return `<div class="gauges gl">${vhf}${radar}${led}${levers}</div><div class="gauges gr">${plot}</div>`;   // (v1171: either side of the wheel)
}
// (v1171, asked: "The steering wheel looks like a toy") a ship's wheel as it is from behind it: big, close, its foot below
// the view; a wooden rim, shaded, with brass bands where the spokes go through; eight spokes, tapered, turned handles
// beyond the rim; a brass hub. Stands in front of the console, turning as she turns.
function bigWheel() {
  const spoke = `<path d="M-2.6,-11 L-1.9,-46 L1.9,-46 L2.6,-11 Z" fill="url(#bwSp)"/>
<path d="M-2.2,-51 C-3.6,-52.5 -3.6,-55 -2.4,-56 C-3.4,-57.5 -3.4,-60.5 -2.2,-62 C-2.6,-64 -1.6,-65.5 0,-65.5 C1.6,-65.5 2.6,-64 2.2,-62 C3.4,-60.5 3.4,-57.5 2.4,-56 C3.6,-55 3.6,-52.5 2.2,-51 Z" fill="url(#bwSp)"/>
<rect x="-3.3" y="-50.5" width="6.6" height="4" rx="0.8" fill="url(#bwBr)"/>`;
  return `<svg viewBox="-68 -68 136 136" class="bigwheel"><defs>
<linearGradient id="bwSp" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#3e230f"/><stop offset="0.35" stop-color="#a8703a"/><stop offset="0.55" stop-color="#7a4a22"/><stop offset="1" stop-color="#2e190a"/></linearGradient>
<linearGradient id="bwRim" x1="0" x2="0.3" y1="0" y2="1"><stop offset="0" stop-color="#b07842"/><stop offset="0.5" stop-color="#6e4120"/><stop offset="1" stop-color="#3a200c"/></linearGradient>
<radialGradient id="bwBr" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#ffe9a8"/><stop offset="0.45" stop-color="#c99a3a"/><stop offset="1" stop-color="#5c3f10"/></radialGradient>
</defs><g class="n-helm">${[0, 45, 90, 135, 180, 225, 270, 315].map(a => `<g transform="rotate(${a})">${spoke}</g>`).join('')}
<circle r="44" fill="none" stroke="#1e1006" stroke-width="10.5"/><circle r="44" fill="none" stroke="url(#bwRim)" stroke-width="8.5"/>
<circle r="46.6" fill="none" stroke="rgba(255,220,170,0.28)" stroke-width="0.8"/><circle r="40.6" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="0.8"/>
<circle r="15" fill="url(#bwRim)" stroke="#1e1006" stroke-width="1.2"/><circle r="11" fill="url(#bwBr)" stroke="#4a320c" stroke-width="0.8"/><circle r="4.2" fill="url(#bwBr)" stroke="#4a320c" stroke-width="0.6"/>
${[0, 45, 90, 135, 180, 225, 270, 315].map(a => `<rect x="-2.6" y="-48.6" width="5.2" height="9.2" rx="0.8" transform="rotate(${a})" fill="url(#bwBr)" opacity="0.9"/>`).join('')}</g></svg>`;
}
// (v1170) an open boat's console: a low windscreen in its frame, the dash under it, white gelcoat; on it her compass (its
// card turning), a little screen with her speed and course, a wheel, a throttle
function consolePanel() {
  const card = `<g class="n-card">${Array.from({ length: 36 }, (_, i) => `<line x1="0" y1="-30" x2="0" y2="${i % 9 === 0 ? -22 : -26}" transform="rotate(${i * 10})" class="ctk"/>`).join('')}${[['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([t, a]) => `<text transform="rotate(${a}) translate(0 -12)" class="cfig">${t}</text>`).join('')}</g>`;
  const compass = `<svg viewBox="-40 -40 80 80" class="binn"><circle r="38" class="bowl"/><circle r="32" class="cface"/>${card}<line x1="0" y1="-36" x2="0" y2="-28" class="lub"/><ellipse cx="-10" cy="-16" rx="14" ry="7" class="glint"/></svg>`;
  const screen = `<div class="cscreen"><div class="n-spd"></div><div class="n-cog"></div></div>`;
  const wheel = `<svg viewBox="-50 -50 100 100" class="cwheel"><g class="n-helm"><circle r="40" class="crim"/><circle r="7" class="chub"/>${[0, 120, 240].map(a => `<line x1="0" y1="0" x2="0" y2="-40" transform="rotate(${a})" class="cspoke"/>`).join('')}</g></svg>`;
  const thr = `<svg viewBox="0 0 40 100" class="cthr"><rect x="4" y="58" width="32" height="40" rx="6" class="cbox"/><g class="n-thr"><line x1="20" y1="70" x2="20" y2="28" class="carm"/><circle cx="20" cy="24" r="8" class="cknob"/></g></svg>`;
  return `<div class="whwin cwin">${bowSvg(BOWS.open)}</div><div class="cwind"></div><div class="cdash"><div class="gauges">${screen}${compass}${wheel}${thr}</div></div>`;
}
// (v1169) the wheelhouse's frame: the deckhead, the windows (four panes, between posts, rounded), their wipers, the glass;
// and ahead of them her own bow, its deck by her kind: a tug's red deck and black fender, a ship's rust, a ferry's grey and white
const BOWS = {
  tug: { deck: '#6e3426', rail: '#1d1e20', cap: '#e9e6df', stem: 0.52, fender: true },
  work: { deck: '#59626a', rail: '#e2c33a', cap: '#2a2b2d', stem: 0.48 },
  ferry: { deck: '#8d9398', rail: '#eceae4', cap: '#c7c4bc', stem: 0.62 },
  ship: { deck: '#6a3428', rail: '#c9c6bf', cap: '#8f8c86', stem: 0.78, mast: true },
  open: { deck: '#ebe8e0', rail: '#b9bec3', cap: '#f7f7f5', stem: 0.85, open: true },   // (v1170: an open boat's white foredeck, her stainless rail)
};
function wheelFrame() {
  const panes = innerWidth < innerHeight ? [[30, 320], [345, 655], [680, 970]] : [[30, 238], [262, 488], [512, 738], [762, 970]], R = 26, T = 175;   // (v1170: three panes on a phone held upright, four were slats)
  const hole = ([a, b]) => `M${a + R},${T} H${b - R} Q${b},${T} ${b},${T + R} V${975 - R} Q${b},975 ${b - R},975 H${a + R} Q${a},975 ${a},${975 - R} V${T + R} Q${a},${T} ${a + R},${T} Z`;
  const wiper = ([a, b]) => { const c = (a + b) / 2; return `<g class="wiper"><line x1="${c + 70}" y1="985" x2="${c - 40}" y2="958"/><line x1="${c - 95}" y1="963" x2="${c + 45}" y2="952" class="blade"/></g>`; };   // (parked, along the foot of the pane) };
  return `<svg class="whframe" viewBox="0 0 1000 1000" preserveAspectRatio="none"><defs><linearGradient id="whg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.07"/><stop offset="0.45" stop-color="#fff" stop-opacity="0"/><stop offset="0.6" stop-color="#bfe0ff" stop-opacity="0.05"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
${panes.map(p => `<path d="${hole(p)}" fill="url(#whg)"/>`).join('')}${wiper(panes[1])}${wiper(panes[2])}
<path fill-rule="evenodd" class="frame" d="M0,0 H1000 V1000 H0 Z ${panes.map(hole).join(' ')}"/>
<rect x="0" y="0" width="1000" height="150" class="deckhead"/><rect x="0" y="150" width="1000" height="12" class="beam"/>
<rect x="0" y="985" width="1000" height="15" class="sill"/></svg>`;
}
function bowSvg(b) {
  const sy = 300 - 230 * b.stem;   // (the stem's height on it: a ship's farther, nearer the horizon)
  const W = 260 * (1.15 - b.stem * 0.6);   // (how wide she looks at the sill)
  return `<svg class="whbow" viewBox="-500 0 1000 300" preserveAspectRatio="none"><defs><linearGradient id="bowsh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.12"/><stop offset="1" stop-color="#000" stop-opacity="0.38"/></linearGradient></defs>
<path d="M${-W - 260},300 L${-W * 0.42},${sy + 40} Q0,${sy - 8} ${W * 0.42},${sy + 40} L${W + 260},300 Z" fill="${b.deck}"/><path d="M${-W - 260},300 L${-W * 0.42},${sy + 40} Q0,${sy - 8} ${W * 0.42},${sy + 40} L${W + 260},300 Z" fill="url(#bowsh)"/>
<path d="M${-W - 260},300 L${-W * 0.42},${sy + 40} Q0,${sy - 8} ${W * 0.42},${sy + 40} L${W + 260},300" fill="none" stroke="${b.rail}" stroke-width="22"/>
<path d="M${-W - 260},290 L${-W * 0.42},${sy + 32} Q0,${sy - 16} ${W * 0.42},${sy + 32} L${W + 260},290" fill="none" stroke="${b.cap}" stroke-width="5"/>
${b.fender ? `<path d="M${-W * 0.5},${sy + 46} Q0,${sy - 20} ${W * 0.5},${sy + 46}" fill="none" stroke="#111" stroke-width="26" stroke-linecap="round"/>` : ''}
${b.open ? '' : `<g fill="#202224"><rect x="-70" y="${sy + 95}" width="16" height="22" rx="3"/><rect x="54" y="${sy + 95}" width="16" height="22" rx="3"/><ellipse cx="0" cy="${sy + 150}" rx="34" ry="12"/></g>`}${b.open ? `<path d="M-40,${sy + 60} L0,${sy + 30} L40,${sy + 60}" fill="none" stroke="#c9ced3" stroke-width="4"/><rect x="-60" y="${sy + 120}" width="120" height="40" rx="10" fill="#dcd8ce"/>` : ''}
${b.mast ? `<rect x="-5" y="${sy - 70}" width="10" height="110" fill="#d8d4cc"/><rect x="-30" y="${sy - 52}" width="60" height="6" fill="#d8d4cc"/>` : ''}
<line x1="0" y1="${sy + 10}" x2="0" y2="${sy - 40}" stroke="#ddd" stroke-width="3"/></svg>`;
}
function trainPanel(rr) {   // her speed (0-60 mph a subway's, 0-100 a railroad's), the amber line of the next stop and where she's bound, the controller's handle
  const spd = dial('MPH', tickRing(rr ? 10 : 12, -135, 270, 2) + figs(rr ? ['0', '20', '40', '60', '80', '100'] : ['0', '10', '20', '30', '40', '50', '60'], -135, 270) + needle('n-asi', 36) + '<circle r="3.5" class="hub"/>');
  return `<div class="gauges">${spd}<div class="tled"><div class="n-next"></div><div class="n-dest"></div></div><svg viewBox="0 0 60 100" class="tlever"><rect x="22" y="8" width="16" height="84" rx="6" class="slot"/><g class="n-lever"><rect x="14" y="44" width="32" height="12" rx="4" class="knob"/></g></svg></div>`;
}
function lightPanel() {
  const asi = dial('KNOTS', tickRing(20, -150, 300, 2) + figs(['0', '40', '80', '120', '160', '200'], -150, 300) + needle('n-asi', 38) + '<circle r="3.5" class="hub"/>');
  const alt = dial('FEET', tickRing(50, 0, 360, 5) + figs(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].concat(['']), 0, 360) + '<rect x="-14" y="8" width="28" height="10" rx="1.5" class="win"/><text y="16" class="dig n-altd">0</text>' + needle('n-alt10', 22, 4) + needle('n-alt', 38) + '<circle r="3.5" class="hub"/>');
  let card = '';
  for (let d = 0; d < 360; d += 30) {
    const a = d * Math.PI / 180, t = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] ?? String(d / 10);
    card += `<text x="${(Math.sin(a) * 30).toFixed(1)}" y="${(-Math.cos(a) * 30 + 3.5).toFixed(1)}" class="fig${d % 90 ? '' : ' card'}" transform="rotate(${d} ${(Math.sin(a) * 30).toFixed(1)} ${(-Math.cos(a) * 30).toFixed(1)})">${t}</text>`;
  }
  const hdg = dial('', `<g class="n-card">${tickRing(72, 0, 360, 2, 39, 43)}${card}</g><path d="M0,-44 L-3.5,-36 L3.5,-36 Z" class="lubber"/><path d="M0,-14 L0,12 M-11,-2 L11,-2 M-5,10 L5,10" class="mini"/>`);
  const vsi = dial('FT/MIN ×100', tickRing(16, -260, 340, 4) + figs(['20', '10', '0', '10', '20'], -260, 340) + '<text x="-17" y="-19" class="lab">UP</text><text x="-17" y="23" class="lab">DN</text>' + needle('n-vsi', 38) + '<circle r="3.5" class="hub"/>');
  return `<div class="gauges">${asi}${alt}${hdg}${vsi}</div>`;
}
function jetPanel() {
  const pfd = `<svg viewBox="0 0 200 140" class="screen">
    <defs><clipPath id="ckclip"><rect x="40" y="10" width="120" height="110"/></clipPath><clipPath id="ckst"><rect x="6" y="13" width="32" height="107"/></clipPath><clipPath id="ckat"><rect x="162" y="13" width="34" height="107"/></clipPath></defs>
    <g clip-path="url(#ckclip)"><g class="n-att"><rect x="-100" y="-235" width="400" height="300" class="sky"/><rect x="-100" y="65" width="400" height="300" class="gnd"/><line x1="-100" y1="65" x2="300" y2="65" class="hz"/>
      ${[-20, -10, 10, 20].map(p => `<line x1="${p % 20 ? 90 : 82}" y1="${65 - p * 2.2}" x2="${p % 20 ? 110 : 118}" y2="${65 - p * 2.2}" class="pl"/>`).join('')}</g></g>
    <path d="M70,65 L92,65 L92,71 M130,65 L108,65 L108,71" class="wing"/><rect x="98" y="63" width="4" height="4" class="wing"/>
    <rect x="6" y="10" width="32" height="110" class="tape"/><rect x="162" y="10" width="34" height="110" class="tape"/><g clip-path="url(#ckst)" class="n-stape"></g><g clip-path="url(#ckat)" class="n-atape"></g>
    <rect x="4" y="56" width="36" height="18" class="box"/><text x="22" y="69" class="big n-spd">0</text>
    <rect x="158" y="56" width="41" height="18" class="box"/><text x="178.5" y="68.5" class="big alt n-alt">0</text>
    <text x="22" y="8.5" class="sm">GS KT</text><text x="179" y="8.5" class="sm">FT</text>
    <text x="179" y="133" class="sm n-vs"></text>
    <rect x="80" y="122" width="40" height="15" class="box"/><text x="100" y="133" class="mid n-hdg">000</text></svg>`;
  let rose = '';
  for (let d = 0; d < 360; d += 10) {
    const a = d * Math.PI / 180, big = d % 30 === 0, r1 = 58, r0 = big ? 51 : 54;
    rose += `<line x1="${(Math.sin(a) * r0).toFixed(1)}" y1="${(-Math.cos(a) * r0).toFixed(1)}" x2="${(Math.sin(a) * r1).toFixed(1)}" y2="${(-Math.cos(a) * r1).toFixed(1)}" class="tk"/>`;
    if (big) rose += `<text x="${(Math.sin(a) * 44).toFixed(1)}" y="${(-Math.cos(a) * 44 + 3).toFixed(1)}" class="fig" transform="rotate(${d} ${(Math.sin(a) * 44).toFixed(1)} ${(-Math.cos(a) * 44).toFixed(1)})">${{ 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] ?? d / 10}</text>`;
  }
  const nd = `<svg viewBox="0 0 200 140" class="screen"><g transform="translate(100,82)"><g class="n-rose">${rose}</g><path d="M0,-9 L5,7 L0,4 L-5,7 Z" class="me"/><line x1="0" y1="-60" x2="0" y2="-66" class="lubber"/></g>
    <text x="8" y="16" class="sm l">GS <tspan class="n-gs">0</tspan></text><text x="192" y="16" class="sm r">TRK <tspan class="n-trk">000</tspan>°</text></svg>`;
  return `<div class="gauges jet">${pfd}${nd}</div>`;
}

function tapeSvg(val, step, every, px, x0, x1, xt, anchor) {
  let s = '';
  const span = 58 / px, lo = Math.floor((val - span) / step) * step;
  for (let v = Math.max(0, lo); v <= val + span; v += step) {
    const y = (65 - (v - val) * px).toFixed(1), big = v % every === 0;
    s += `<line x1="${big ? x0 - 3 * Math.sign(x1 - x0) : x0}" y1="${y}" x2="${x1}" y2="${y}" class="tk"/>`;
    if (big) s += `<text x="${xt}" y="${(+y + 2.5).toFixed(1)}" class="tp" text-anchor="${anchor}">${v}</text>`;
  }
  return s;
}
export function makeCockpit(el) {
  let kind = null, q = {}, lastS = null, lastA = null, bowK = 'work';
  const set = (sel, fn) => { for (const n of el.querySelectorAll(sel)) fn(n); };
  const rot = (sel, deg) => set(sel, n => n.setAttribute('transform', `rotate(${deg.toFixed(1)})`));
  // (v1169) her bow, ahead whichever way you look: off to the side as you turn your head, gone past 70°; up and down with it
  const bowAt = (yaw, pitch, fov) => set('.whbow', n => { const W = innerWidth, H = innerHeight, vf = fov || 50, hf = 2 * Math.atan(Math.tan(vf * Math.PI / 360) * W / H) * 180 / Math.PI;
    n.style.display = Math.abs(yaw) > 70 ? 'none' : ''; n.style.transform = `translate(${(-yaw / hf * W).toFixed(0)}px, ${((pitch + 3) / vf * H).toFixed(0)}px)`; });
  const txt = (sel, t) => set(sel, n => { if (n.textContent !== t) n.textContent = t; });
  return {
    show(k, opt = {}) {
      if (k === 'wheelhouse' && opt.bow && opt.bow !== bowK) { kind = null; bowK = opt.bow; }
      if (k !== kind) {
        kind = k; lastS = lastA = null; el.className = `ck-${k === 'railroad' ? 'train' : k}`;
        el.innerHTML = `${k === 'console' ? '' : '<div class="pillar l"></div><div class="pillar r"></div>'}${k === 'jet' || k === 'train' || k === 'railroad' ? '<div class="pillar c"></div>' : ''}${k === 'train' || k === 'railroad' ? '<div class="theader"></div>' : ''}${k === 'wheelhouse' ? `<div class="whwin">${bowK === 'none' ? '' : bowSvg(BOWS[bowK] || BOWS.work)}${wheelFrame()}<div class="whover"><div class="rep"><span>RUDDER</span><div class="rbar"><i class="n-rud"></i></div></div><div class="rep"><span>HEADING</span><b class="n-ohdg"></b></div></div></div>` : ''}${k === 'console' ? consolePanel() : ''}${k === 'wheelhouse' ? bigWheel() : ''}<div class="ckpanel"${k === 'console' ? ' hidden' : ''}>${k === 'jet' ? jetPanel() : k === 'train' || k === 'railroad' ? trainPanel(k === 'railroad') : k === 'wheelhouse' ? wheelPanel() : lightPanel()}</div>`;
      }
      // (v1170) above the bar of buttons when a phone has it along the bottom (it had covered the console)
      const bar = document.getElementById('scale')?.getBoundingClientRect();
      el.style.setProperty('--lift', bar && bar.height && bar.top > innerHeight * 0.5 ? `${Math.round(innerHeight - bar.top + 4)}px` : '0px');
      el.hidden = false; document.body.classList.add('incockpit');
    },
    hide() { el.hidden = true; document.body.classList.remove('incockpit'); },
    update({ gs = 0, alt = 0, hdg = 0, vr = 0, ground = false, next = '', dest = '', cog = null, turn = 0, yaw = 0, pitch = -3, fov = 50 } = {}) {
      if (el.hidden) return;
      if (kind === 'console') {   // (v1170) an open boat's: her compass card, her speed and course, the wheel and the throttle
        const d3 = a => String(Math.round(((a % 360) + 360) % 360) % 360).padStart(3, '0');
        rot('.n-card', -hdg); txt('.n-spd', `${gs.toFixed(1)} kn`); txt('.n-cog', `${cog != null ? 'COG' : 'HDG'} ${d3(cog ?? hdg)}°`);
        rot('.n-helm', clamp(turn / 20, -1, 1) * 90); set('.n-thr', n => n.setAttribute('transform', `rotate(${(-40 * clamp(gs / 25, 0, 1)).toFixed(1)} 20 70)`));
        bowAt(yaw, pitch, fov); return;
      }
      if (kind === 'wheelhouse') {   // (v1167) her heading and speed; the throttles forward as she makes way
        const d3 = a => String(Math.round(((a % 360) + 360) % 360) % 360).padStart(3, '0');
        txt('.n-hdg', `HDG ${d3(hdg)}°`); txt('.n-cog', cog != null ? `COG ${d3(cog)}°` : ''); txt('.n-spd', `SOG ${gs.toFixed(1)} kn`); txt('.n-ohdg', `${d3(hdg)}°`);
        set('.n-thr', n => n.setAttribute('transform', `translate(0 ${(-26 * clamp(gs / 18, 0, 1)).toFixed(1)})`));
        const rud = clamp(turn / 20, -1, 1); rot('.n-helm', rud * 120); set('.n-rud', n => { n.style.left = `${50 + rud * 45}%`; });
        bowAt(yaw, pitch, fov); return;
      }
      if (kind === 'train' || kind === 'railroad') {   // (v1161) her speed, the next stop, the controller back as she slows
        const top = kind === 'railroad' ? 100 : 60; rot('.n-asi', -135 + 270 * clamp(gs, 0, top) / top); txt('.n-next', next ? `Next: ${next}` : ''); txt('.n-dest', dest ? `To ${dest}` : '');
        set('.n-lever', n => n.setAttribute('transform', `translate(0 ${(-28 * clamp(gs / 45, 0, 1)).toFixed(1)})`)); return;
      }
      q = { gs, alt, hdg, vr };
      const h = ((hdg % 360) + 360) % 360, h3 = String(Math.round(h) % 360).padStart(3, '0');
      if (kind === 'jet') {
        txt('.n-spd', fmt(gs)); txt('.n-alt', fmt(Math.round(alt / 10) * 10)); txt('.n-hdg', h3); txt('.n-gs', fmt(gs)); txt('.n-trk', h3);
        txt('.n-vs', Math.abs(vr) >= 100 ? `${vr > 0 ? '↑' : '↓'}${fmt(Math.abs(Math.round(vr / 50) * 50))}` : '');
        rot('.n-rose', -h);
        const s1 = Math.round(gs), a1 = Math.round(alt / 10) * 10;
        if (s1 !== lastS) { lastS = s1; set('.n-stape', n => { n.innerHTML = tapeSvg(s1, 10, 20, 1.6, 31, 38, 28, 'end'); }); }
        if (a1 !== lastA) { lastA = a1; set('.n-atape', n => { n.innerHTML = tapeSvg(a1, 100, 500, 0.08, 169, 162, 172, 'start'); }); }
        const pitch = ground ? 0 : clamp(vr / 600, -5, 10);   // (her nose: up climbing, a little down descending)
        set('.n-att', n => n.setAttribute('transform', `translate(0 ${(pitch * 2.2).toFixed(1)})`));
      } else {
        rot('.n-asi', -150 + 300 * clamp(gs, 0, 200) / 200);
        rot('.n-alt', 360 * ((alt % 1000) + 1000) % 1000 / 1000); rot('.n-alt10', 360 * ((alt % 10000) + 10000) % 10000 / 10000);
        txt('.n-altd', fmt(Math.round(alt / 10) * 10));
        rot('.n-card', -h);
        rot('.n-vsi', -90 + 170 * clamp(vr / 2000, -1, 1));
      }
    },
    get kind() { return el.hidden ? null : kind; },
  };
}
