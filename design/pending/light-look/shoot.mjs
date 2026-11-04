// node shoot.mjs out.png "type=CH7A&reg=N383AC&view=side" [...more pairs]: renders each via headless Chrome on 9611
import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9611); const errs = [];
c.ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.slice(0, 400)); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errs.push(JSON.stringify(d.params.args.map(a => a.description || a.value)).slice(0, 300)); });
await c.cmd('Network.setCacheDisabled', { cacheDisabled: true });
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i += 2) {
  const [out, q] = [a[i], a[i + 1]], w = /w=(\d+)/.exec(q)?.[1] || 1200, h = /h=(\d+)/.exec(q)?.[1] || 600;
  await c.cmd('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: false });
  await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8811/design/pending/light-look/view.html?' + q });
  for (let k = 0; k < 40; k++) { await sleep(250); if (await c.ev('window.__done === true') === true) break; }
  const nan = await c.ev('JSON.stringify(window.__nan)'); if (nan !== '[]') console.log(out, 'NaN', nan);
  await c.shot(out);
}
if (errs.length) console.log('ERRORS', errs.join('\n'));
process.exit(0);
