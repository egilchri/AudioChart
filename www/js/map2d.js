// 🗺 Map (v1217, asked: "I'd like to be able to switch to map view, where I see the city in two dimensions, with labelled
// streets", then "use the OpenStreetMap map"): the city flat, OpenStreetMap's own street map (its standard tiles, every
// street, park and station named) in Leaflet (www/js/lib/leaflet.js, as the boaters' chart uses), over the whole scene.
// Opened centred where the 3D view looks (at street level, where you stand), at about its scale; your blue dot on it.
// ◀ 3D here takes the 3D view to where the map's been moved; ✕ or Esc just closes it. Loaded by bay3d.js on its first use.
// Needs the internet (the tiles), as the rest of the armchair layer does.
//
// (v1218, asked: "add the live buses and trains to the map") With Live on: the trains as dots in their lines' colours
// (hollow underground), the buses small and MTA blue, those in view drawn again every 2 s; tap one for its name and
// where it's going. The bar counts them.

let L = null, box = null, map = null, me = null, ctx = null, movers = null, timer = 0, renderer = null;

// the subway's own line colours (MTA), and the other railways'
const LINE = { '1': '#EE352E', '2': '#EE352E', '3': '#EE352E', '4': '#00933C', '5': '#00933C', '6': '#00933C', '7': '#B933AD',
  A: '#0039A6', C: '#0039A6', E: '#0039A6', B: '#FF6319', D: '#FF6319', F: '#FF6319', M: '#FF6319', G: '#6CBE45', J: '#996633', Z: '#996633',
  L: '#A7A9AC', N: '#FCCC0A', Q: '#FCCC0A', R: '#FCCC0A', W: '#FCCC0A', S: '#808183' };
const RAIL = { 'Staten Island Railway': '#0039A6', LIRR: '#0F61A9', 'Metro-North': '#C4122F', PATH: '#004D6F', Amtrak: '#1B5FAA' };
const BUS = '#2A5DB0';
function colourOf(rail) { const m = /^(\w) train$/.exec(rail || ''); return m ? LINE[m[1]] || '#555' : RAIL[rail] || '#555'; }
const esc = t => String(t ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!document.querySelector('link[href$="leaflet.css"]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = './css/leaflet.css'; document.head.appendChild(l);
  }
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = './js/lib/leaflet.js';
    s.onload = () => res(window.L); s.onerror = () => rej(new Error('leaflet.js did not load')); document.head.appendChild(s);
  });
}

function build() {
  const st = document.createElement('style');
  st.textContent = `
    #map2d { position: fixed; inset: 0; z-index: 60; background: #e8e4da; }
    #map2d .m2map { position: absolute; inset: 0; }
    #map2d .m2bar { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 1000; display: flex; gap: 8px; align-items: center;
      background: rgba(20, 28, 36, 0.86); color: #fff; padding: 6px 8px; border-radius: 10px; font: 600 14px system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    #map2d .m2bar button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 0; background: #e2b04a; color: #1b1b1b; cursor: pointer; }
    #map2d .m2bar button.x { background: #3a4652; color: #fff; }
    #map2d .m2cross { position: absolute; left: 50%; top: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px; z-index: 900; pointer-events: none; opacity: 0.7;
      background: linear-gradient(#c33, #c33) center / 2px 100% no-repeat, linear-gradient(#c33, #c33) center / 100% 2px no-repeat; }`;
  document.head.appendChild(st);
  box = document.createElement('div'); box.id = 'map2d'; box.hidden = true;
  box.innerHTML = '<div class="m2map"></div><div class="m2cross" title="Where ◀ 3D here takes you"></div><div class="m2bar"><button type="button" class="here" title="The 3D view, over the middle of the map (the red cross)">◀ 3D here</button><span class="m2title">Map</span><button type="button" class="x" title="Back to the 3D view as it was (Esc)">✕</button></div>';
  document.body.appendChild(box);
  // (the scene's own keys and drags stay out of it while it's open)
  for (const ev of ['pointerdown', 'wheel', 'touchstart', 'keydown']) box.addEventListener(ev, e => e.stopPropagation());
  box.querySelector('.here').addEventListener('click', () => { const c = map.getCenter(); close(); ctx.back?.({ lon: c.lng, lat: c.lat, zoom: map.getZoom() }); });
  box.querySelector('.x').addEventListener('click', () => close());
  addEventListener('keydown', e => { if (e.key === 'Escape' && box && !box.hidden) { close(); e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  map = L.map(box.querySelector('.m2map'), { zoomControl: true, attributionControl: true, maxZoom: 19, minZoom: 3 });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  L.control.scale({ imperial: true, metric: false }).addTo(map);
  renderer = L.canvas({ padding: 0.2 });
  movers = L.featureGroup().addTo(map);   // (a feature group: its dots' clicks come up to it, a layer group's don't)
  movers.on('click', e => { const o = e.layer.options; L.popup({ offset: [0, -4] }).setLatLng(e.latlng).setContent(`<b>${esc(o.t)}</b>${o.l && o.l !== o.t ? `<br>${esc(o.l)}` : ''}`).openOn(map); });
  map.on('moveend zoomend', drawMovers);
}

// the buses and trains in view (and a little round it), drawn again
function drawMovers() {
  if (!map || !box || box.hidden) return;
  movers.clearLayers();
  const all = ctx?.movers?.() || [], b = map.getBounds().pad(0.15), z = map.getZoom();
  let nb = 0, nt = 0;
  for (const v of all) if (v.bus && b.contains([v.lat, v.lon])) { nb++; L.circleMarker([v.lat, v.lon], { renderer, radius: z >= 15 ? 5 : z >= 13 ? 3.5 : 2.5, weight: 1, color: '#fff', fillColor: BUS, fillOpacity: 0.95, t: v.title, l: v.label }).addTo(movers); }
  for (const v of all) if (!v.bus && b.contains([v.lat, v.lon])) {   // (the trains over the buses)
    nt++; const col = colourOf(v.rail);
    L.circleMarker([v.lat, v.lon], { renderer, radius: z >= 14 ? 7 : 5, weight: v.under ? 2.5 : 1.5, color: v.under ? col : '#fff', fillColor: col, fillOpacity: v.under ? 0.25 : 1, t: v.title, l: v.label }).addTo(movers);
  }
  box.querySelector('.m2title').textContent = all.length ? `Map · 🚆 ${nt} · 🚌 ${nb} in view` : 'Map · Live is off: no buses or trains';
}

function close() { if (box) box.hidden = true; clearInterval(timer); timer = 0; ctx?.closed?.(); }

export const isOpen = () => !!box && !box.hidden;
window.__map2d = () => map;   // (testing)

// c: { lon, lat, zoom, me: { lon, lat } | null, movers: () => [{ lon, lat, bus, rail, title, label, under }], back({ lon, lat, zoom }), closed() }
export async function openMap(c) {
  ctx = c; L = await loadLeaflet();
  if (!box) build();
  box.hidden = false;
  map.invalidateSize();
  map.setView([c.lat, c.lon], Math.max(3, Math.min(19, Math.round(c.zoom))), { animate: false });
  if (me) { me.remove(); me = null; }
  if (c.me) me = L.circleMarker([c.me.lat, c.me.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#2f7df6', fillOpacity: 1 }).bindTooltip('You').addTo(map);
  me?.bringToFront();
  drawMovers(); clearInterval(timer); timer = setInterval(drawMovers, 2000);
}
