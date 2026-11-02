import fs from 'fs';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function connect(port = 9557) {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {}; const listeners = [];
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } else if (d.method) listeners.forEach(f => f(d)); };
  const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async x => { const r = await cmd('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? ('ERR ' + (r.result?.exceptionDetails?.exception?.description || JSON.stringify(r.result?.exceptionDetails))); };
  const shot = async n => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(n, Buffer.from(r.result.data, 'base64')); };
  const click = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
  const move = (x, y) => cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  // Screencast: frames saved as dir/NNNNN.jpg with timestamps
  let rec = null;
  listeners.push(d => {
    if (d.method === 'Page.screencastFrame') {
      cmd('Page.screencastFrameAck', { sessionId: d.params.sessionId });
      if (rec) { const n = String(rec.frames.length).padStart(5, '0'); fs.writeFileSync(`${rec.dir}/${n}.jpg`, Buffer.from(d.params.data, 'base64')); rec.frames.push(d.params.metadata.timestamp); }
    }
  });
  const startRec = async dir => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); rec = { dir, frames: [], t0: Date.now() / 1000, marks: [] }; await cmd('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1 }); };
  const mark = name => { rec.marks.push({ name, t: Date.now() / 1000 - rec.t0 }); };
  const stopRec = async () => { await cmd('Page.stopScreencast'); const r = rec; rec = null; fs.writeFileSync(`${r.dir}/meta.json`, JSON.stringify({ t0: r.t0, frames: r.frames, marks: r.marks })); return r; };
  await cmd('Page.enable'); await cmd('Runtime.enable');
  return { ws, cmd, ev, shot, click, move, startRec, stopRec, mark };
}
