import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9567); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 300)); });
await c.cmd('Network.enable'); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true }); await c.cmd('Network.setBypassServiceWorker', { bypass: true });
await c.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
for (let i = 0; i < 90; i++) { await sleep(1000); if (await c.ev(`__bay3d.rail.items().length > 3`) === true) break; }
await sleep(2000);
console.log(await c.ev(`JSON.stringify(__bay3d.rail.items().map(p => [p.title, p.label, p.run && [p.run.next, p.run.late?.toFixed(1)]]), null, 1)`));
await c.ev(`document.getElementById('underwaybtn')?.click()`); await sleep(500);
await c.ev(`document.querySelector('.uwtabs button[data-tab=rail]')?.click()`); await sleep(800);
await c.shot('eta_list.png');
await c.ev(`document.querySelector('#underway button.info')?.click()`); await sleep(800);
await c.shot('eta_card.png');
console.log('ERRORS', errs.join('\n')); process.exit(0);
