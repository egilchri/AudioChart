// An airliner coming in to land, ships and the Bay Bridge behind her: node landingshot.mjs [out.png]
import { connect, sleep } from '../live-tour/cdp.mjs';
const OUT = process.argv[2] || 'landing.png', c = await connect(9567); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 300)); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errs.push(JSON.stringify(d.params.args.map(a => a.description || a.value)).slice(0, 300)); });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true }); await c.cmd('Network.setBypassServiceWorker', { bypass: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
const J = async x => JSON.parse(await c.ev(`JSON.stringify(${x})`)); const R = `document.querySelector('#scene canvas').getBoundingClientRect()`;
const km = (a, b) => Math.hypot((a.lon - b.lon) * 88.0, (a.lat - b.lat) * 111.1);
let pick = null;
const BRIDGE = { lat: 37.80, lon: -122.36 };   // (the Bay Bridge, between Yerba Buena and Oakland)
for (let tries = 0; tries < 100 && !pick; tries++) {   // (an airliner on her way in, gear down, over the water)
  await sleep(tries ? 8000 : 20000);
  const air = await J(`__bay3d.air.list()`);
  const cands = air.filter(a => /^[A-Z]{3}\d/.test(a.flight || '') && /^(A3|B7|E1|E7|BC)/.test(a.type || '') && !a.ground && a.alt > 500 && a.alt < 2400 && (a.vr ?? 0) < -250 && a.at.lon > -122.42 && a.at.lon < -122.12 && a.at.lat > 37.5 && a.at.lat < 37.79);   // (SFO's arrivals over the south bay, and Oakland's, nearer the bridge)
  for (const k of cands) k.water = await c.ev(`__bay3d.waterAt(${k.at.lon}, ${k.at.lat})`);
  const ok = cands.filter(k => k.water === true && km(k.at, BRIDGE) < 16).sort((x, y) => km(x.at, BRIDGE) - km(y.at, BRIDGE));   // (the nearer the bridge, the more of it behind her)
  if (tries % 3 === 0 || ok.length) log('arrivals', cands.map(k => `${k.flight} ${k.type} ${k.alt}ft vr${k.vr} water=${k.water}`).join(' | ') || 'none yet');
  if (ok.length) pick = ok[0];
}
if (!pick) { log('no airliner on her way in over the bay; try again later'); process.exit(3); }
const A = pick; log('pick', A.flight, A.type, A.alt, 'ft', 'vr', A.vr, 'trk', A.trk);
// the camera looks from her toward the Bay Bridge: Side's camera sits at her heading + yaw (−90 to start), looking that way
const want = (Math.atan2((BRIDGE.lon - A.at.lon) * 88, (BRIDGE.lat - A.at.lat) * 111.1) * 180 / Math.PI + 360) % 360;
const turn = ((want - (A.trk - 90)) % 360 + 540) % 360 - 180;
log('bridge bears', Math.round(want), 'turn the camera', Math.round(turn), 'deg');
await c.ev(`__bay3d.applyConditions?.({ vis: 'clear' })`);
await c.ev(`__bay3d.setView(${JSON.stringify({ lat: A.at.lat, lon: A.at.lon, dist: 6000, az: 0, tilt: 40 })})`); await sleep(2500);
for (let k = 0; k < 5; k++) { const me = (await J(`__bay3d.air.list(__bay3d.camera, ${R})`)).find(x => x.hex === A.hex); if (me?.sx != null) { await c.click(me.sx, me.sy); await sleep(600); } if (await c.ev(`!document.getElementById('aisinfo').hidden`) === true) break; }
await c.ev(`[...document.querySelectorAll('#aisinfo .go button')].find(b => b.dataset.m === 'side').click()`); await sleep(1500);
log('riding:', await c.ev(`document.getElementById('ridename').textContent`));
const key = async (k, n) => { for (let i = 0; i < n; i++) { await c.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[k] }); await c.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k }); } };
await c.ev(`document.activeElement?.blur()`);
await key(turn > 0 ? 'ArrowRight' : 'ArrowLeft', Math.round(Math.abs(turn) / 4));   // (round her to look toward the bridge: 4° a press)
await key('ArrowDown', 1);   // (just above her: the bay, its ships and the bridge behind)
await c.cmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 960, y: 540, deltaX: 0, deltaY: -90 });   // (in a little closer)
await c.ev(`(() => { const st = document.createElement('style'); st.textContent = '.panel,#scale,#help,#nesthud,#ridechart,#aisinfo,#followhud,#livemarks,#labels,#ovmap,#credit,#loading,#bayswitch,#nestrep,#wxpanel{display:none!important}'; document.head.appendChild(st); })()`);
for (let w = 0; w < 60 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(1000);
await sleep(2500);
await c.shot(OUT); log('shot', OUT, A.flight, A.type, 'gear', await c.ev(`(() => { const p = __bay3d.air.items().find(p => p.a.hex === ${JSON.stringify(A.hex)}); return p?.modelKey; })()`));
console.log('ERRORS', errs.slice(0, 5).join('\n'));
process.exit(0);
