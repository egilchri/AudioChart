import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9567); const req = new Map();
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data);
  if (d.method === 'Network.requestWillBeSent') req.set(d.params.requestId, d.params.request.url);
  if (d.method === 'Network.loadingFinished' || d.method === 'Network.loadingFailed') req.delete(d.params.requestId);
  if (d.method === 'Runtime.exceptionThrown') console.log('EXC', JSON.stringify(d.params.exceptionDetails).slice(0, 400)); });
await c.cmd('Network.enable'); await c.cmd('Network.setBypassServiceWorker', { bypass: true });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
await sleep(25000); console.log([...req.values()].map(u => u.slice(0, 160)).join('\n')); console.log(await c.ev(`document.getElementById('status')?.textContent`)); process.exit(0);
