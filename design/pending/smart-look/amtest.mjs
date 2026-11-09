// node amtest.mjs: Amtrak trains through a local relay (:8791); each one's place every 10 s for a minute, on track or not
import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9567); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 400)); });
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true }); await c.cmd('Network.setBypassServiceWorker', { bypass: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=http://127.0.0.1:8791' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
for (let i = 0; i < 120; i++) { await sleep(1000); if (await c.ev(`__bay3d.rail.items().some(p => p.a.rail === 'Amtrak')`) === true) break; }
await sleep(3000);
console.log(await c.ev(`JSON.stringify(__bay3d.rail.items().filter(p=>p.a.rail==='Amtrak').map(p=>[p.title, p.label]),null,1)`));
let prev = {};
for (let k = 0; k < 7; k++) {
  const r = JSON.parse(await c.ev(`JSON.stringify(__bay3d.rail.items().filter(p=>p.a.rail==='Amtrak').map(p=>({id:p.title,x:p.x,z:p.z,on:__bay3d.rail.nearTrack(p.x,p.z,3),v:+(p.v*2.237).toFixed(0),ft:!!p.ft})))`));
  console.log(r.map(t => `${t.id} ${t.v}mph ${t.on ? 'on' : 'OFF'}${t.ft ? '' : ' nofix'} +${prev[t.id] ? Math.hypot(t.x - prev[t.id].x, t.z - prev[t.id].z).toFixed(0) : '-'}m`).join(' | '));
  for (const t of r) prev[t.id] = t; await sleep(10000);
}
console.log('ERRORS', errs.join('\n')); process.exit(0);
