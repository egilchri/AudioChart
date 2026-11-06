// node town.mjs <tag> id...: fly to each town by its button, wait for tiles and buildings, shoot
import { connect, sleep } from '../live-tour/cdp.mjs';
const [tag, ...ids] = process.argv.slice(2), c = await connect(+process.env.PORT || 9567); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 400)); });
await c.cmd('Network.enable'); await c.cmd('Network.setBypassServiceWorker', { bypass: true }); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay' });
for (let i = 0; i < 120; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
await sleep(20000);
for (const id of ids) {
  console.log(id, await c.ev(`(()=>{const b=document.querySelector('#towns button[data-id="${id}"]'); if(!b) return 'nobutton'; b.click(); return 'ok'})()`));
  await sleep(+process.env.WAIT || 25000);
  for (let w = 0; w < 120 && await c.ev(`__bay3d.tiles.some(T=>T.state==='loading'||(T.state==='ready'&&T.photo==='pending'))`); w++) await sleep(1000);
  await sleep(6000); await c.shot(`${tag}_${id}.png`);
}
console.log('ERRORS', errs.slice(0, 10).join('\n')); process.exit(0);
