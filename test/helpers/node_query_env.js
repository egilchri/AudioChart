/**
 * Minimal browser-API shims so www/js/query.js (and, through it, router.js)
 * can run in plain Node against real chart data — no browser, no test
 * framework, just enough of indexedDB/localStorage/fetch for query.js's
 * loadData() to complete its normal caching logic without erroring.
 *
 * Node-only, test-only: none of this ships to the browser. See the
 * reliability-overhaul plan for why this exists — router.js was extracted
 * from app.js specifically so the routing regression suite could call the
 * real router against real data instead of maintaining a separate port of
 * its logic that could silently drift from the shipped code.
 */
const fs = require('fs');
const path = require('path');

class FakeIDBRequest {
  constructor() { this.onsuccess = null; this.onerror = null; this.onupgradeneeded = null; }
  _succeed(result) { this.result = result; if (this.onsuccess) this.onsuccess({ target: this }); }
}
class FakeIDBStore {
  constructor(map) { this.map = map; }
  get(key) {
    const req = new FakeIDBRequest();
    queueMicrotask(() => req._succeed(this.map.has(key) ? this.map.get(key) : null));
    return req;
  }
  put(value, key) {
    this.map.set(key, value);
    const req = new FakeIDBRequest();
    queueMicrotask(() => req._succeed(undefined));
    return req;
  }
}
class FakeIDBTransaction {
  constructor(map) {
    this.store = new FakeIDBStore(map);
    this.oncomplete = null;
    this.onerror = null;
    queueMicrotask(() => { if (this.oncomplete) this.oncomplete(); });
  }
  objectStore() { return this.store; }
}
class FakeIDBDatabase {
  constructor() { this.map = new Map(); }
  transaction() { return new FakeIDBTransaction(this.map); }
}

/**
 * Installs global.indexedDB, global.localStorage, and global.fetch (serving
 * files straight off disk under wwwDataDir, mapping "./data/..." request
 * URLs the same way the browser app addresses them). Call once per process
 * before importing query.js/router.js. Idempotent.
 */
function installNodeQueryEnv(wwwDataDir) {
  if (!global.indexedDB) {
    global.indexedDB = {
      open() {
        const req = new FakeIDBRequest();
        if (!global.__nodeQueryEnvDb) global.__nodeQueryEnvDb = new FakeIDBDatabase();
        queueMicrotask(() => req._succeed(global.__nodeQueryEnvDb));
        return req;
      },
    };
  }
  if (!global.localStorage || typeof global.localStorage.getItem !== 'function') {
    const store = new Map();
    global.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  }
  if (!global.fetch || !global.fetch.__isNodeQueryEnvShim) {
    const fetchShim = async (url) => {
      const rel = String(url).replace(/^\.\/data\//, '');
      const filePath = path.join(wwwDataDir, rel);
      try {
        const buf = fs.readFileSync(filePath, 'utf8');
        return { ok: true, json: async () => JSON.parse(buf) };
      } catch (_) {
        return { ok: false, status: 404 };
      }
    };
    fetchShim.__isNodeQueryEnvShim = true;
    global.fetch = fetchShim;
  }
}

module.exports = { installNodeQueryEnv };
