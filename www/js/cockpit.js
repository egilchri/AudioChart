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
  let kind = null, q = {}, lastS = null, lastA = null;
  const set = (sel, fn) => { for (const n of el.querySelectorAll(sel)) fn(n); };
  const rot = (sel, deg) => set(sel, n => n.setAttribute('transform', `rotate(${deg.toFixed(1)})`));
  const txt = (sel, t) => set(sel, n => { if (n.textContent !== t) n.textContent = t; });
  return {
    show(k) {
      if (k !== kind) {
        kind = k; lastS = lastA = null; el.className = `ck-${k === 'railroad' ? 'train' : k}`;
        el.innerHTML = `<div class="pillar l"></div><div class="pillar r"></div>${k === 'jet' || k === 'train' || k === 'railroad' ? '<div class="pillar c"></div>' : ''}${k === 'train' || k === 'railroad' ? '<div class="theader"></div>' : ''}<div class="ckpanel">${k === 'jet' ? jetPanel() : k === 'train' || k === 'railroad' ? trainPanel(k === 'railroad') : lightPanel()}</div>`;
      }
      el.hidden = false; document.body.classList.add('incockpit');
    },
    hide() { el.hidden = true; document.body.classList.remove('incockpit'); },
    update({ gs = 0, alt = 0, hdg = 0, vr = 0, ground = false, next = '', dest = '' } = {}) {
      if (el.hidden) return;
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
