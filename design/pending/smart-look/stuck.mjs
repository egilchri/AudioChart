// node stuck.mjs: each train in view's state: shown speed, gap to target, her track place, her target's run-on
import { connect, sleep } from '../live-tour/cdp.mjs';
const c = await connect(9567);
await c.cmd('Network.enable'); await c.cmd('Network.setBypassServiceWorker', { bypass: true }); await c.cmd('Network.setCacheDisabled', { cacheDisabled: true });
await c.cmd('Page.navigate', { url: 'http://127.0.0.1:8793/bay3d.html?region=sf-bay&ais=https://audiochart-ais.egilchri.workers.dev' });
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`!!window.__bay3d?.camera`) === true) break; }
for (let i = 0; i < 60; i++) { await sleep(1000); if (await c.ev(`__bay3d.rail.list().length > 10`) === true) break; }
for (let r = 0; r < 3; r++) {
  await sleep(10000);
  console.log(await c.ev(`JSON.stringify(__bay3d.rail.items().filter(p => p.v > 3).map(p => [p.id, +p.v.toFixed(1), p.vs?.toFixed(1), p.gapT?.toFixed(0), !!p.cur, p.cur && [p.cur.k, +p.cur.t.toFixed(2), p.cur.dir], Math.round((Date.now() - p.fix.t) / 1000), p.a.atStop, p.a.nextExp ? Math.round((p.a.nextExp - Date.now()) / 1000) : null]))`));
}
process.exit(0);
