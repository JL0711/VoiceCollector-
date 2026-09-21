// IndexedDB 封装：老师 / 学科 / 课程记录 / 录音
const NAME = 'voicecollector', VER = 2;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const req = indexedDB.open(NAME, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('teachers')) db.createObjectStore('teachers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('courses')) db.createObjectStore('courses', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('startedAt', 'startedAt');
      }
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'sessionId' });
      if (!db.objectStoreNames.contains('chunks')) {
        const c = db.createObjectStore('chunks', { keyPath: 'key' });
        c.createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}

function run(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    let out;
    try { out = fn(t.objectStore(store)); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('aborted'));
  }));
}

export const put    = (store, val) => run(store, 'readwrite', s => s.put(val));
export const get    = (store, key) => run(store, 'readonly',  s => s.get(key));
export const del    = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const all    = (store)      => run(store, 'readonly',  s => s.getAll());
export const clear  = (store)      => run(store, 'readwrite', s => s.clear());

export function byIndex(store, index, value) {
  return run(store, 'readonly', s => s.index(index).getAll(value));
}

export async function delByIndex(store, index, value) {
  const db_ = await open();
  return new Promise((res, rej) => {
    const t = db_.transaction(store, 'readwrite');
    const req = t.objectStore(store).index(index).openKeyCursor(IDBKeyRange.only(value));
    let n = 0;
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      t.objectStore(store).delete(c.primaryKey); n++;
      c.continue();
    };
    t.oncomplete = () => res(n);
    t.onerror = () => rej(t.error);
  });
}

export async function sessionsSorted() {
  const list = await all('sessions');
  return list.sort((a, b) => b.startedAt - a.startedAt);
}

export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (!(await navigator.storage.persisted())) await navigator.storage.persist();
    }
  } catch (_) {}
}

export async function usage() {
  try {
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0 };
  } catch (_) { return { used: 0, quota: 0 }; }
}
