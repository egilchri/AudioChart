// 🗺 Map (v1217, asked: "I'd like to be able to switch to map view, where I see the city in two dimensions, with labelled
// streets", then "use the OpenStreetMap map"): the city flat, OpenStreetMap's own street map (its standard tiles, every
// street, park and station named) in Leaflet (www/js/lib/leaflet.js, as the boaters' chart uses), over the whole scene.
// Opened centred where the 3D view looks (at street level, where you stand), at about its scale; your blue dot on it.
// ◀ 3D here takes the 3D view to where the map's been moved; ✕ or Esc just closes it. Loaded by bay3d.js on its first use.
// Needs the internet (the tiles), as the rest of the armchair layer does.

let L = null, box = null, map = null, me = null, ctx = null;

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
  box.innerHTML = '<div class="m2map"></div><div class="m2cross" title="Where ◀ 3D here takes you"></div><div class="m2bar"><button type="button" class="here" title="The 3D view, over the middle of the map (the red cross)">◀ 3D here</button><span>Map</span><button type="button" class="x" title="Back to the 3D view as it was (Esc)">✕</button></div>';
  document.body.appendChild(box);
  // (the scene's own keys and drags stay out of it while it's open)
  for (const ev of ['pointerdown', 'wheel', 'touchstart', 'keydown']) box.addEventListener(ev, e => e.stopPropagation());
  box.querySelector('.here').addEventListener('click', () => { const c = map.getCenter(); close(); ctx.back?.({ lon: c.lng, lat: c.lat, zoom: map.getZoom() }); });
  box.querySelector('.x').addEventListener('click', () => close());
  addEventListener('keydown', e => { if (e.key === 'Escape' && box && !box.hidden) { close(); e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  map = L.map(box.querySelector('.m2map'), { zoomControl: true, attributionControl: true, maxZoom: 19, minZoom: 3 });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  L.control.scale({ imperial: true, metric: false }).addTo(map);
}

function close() { if (box) box.hidden = true; ctx?.closed?.(); }

export const isOpen = () => !!box && !box.hidden;
window.__map2d = () => map;   // (testing)

// c: { lon, lat, zoom, me: { lon, lat } | null, back({ lon, lat, zoom }), closed() }
export async function openMap(c) {
  ctx = c; L = await loadLeaflet();
  if (!box) build();
  box.hidden = false;
  map.invalidateSize();
  map.setView([c.lat, c.lon], Math.max(3, Math.min(19, Math.round(c.zoom))), { animate: false });
  if (me) { me.remove(); me = null; }
  if (c.me) me = L.circleMarker([c.me.lat, c.me.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#2f7df6', fillOpacity: 1 }).bindTooltip('You').addTo(map);
}
