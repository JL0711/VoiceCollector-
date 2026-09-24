// 在旧端口的网址下运行：把 voicecollector 数据库和 localStorage 整个读出来。
// 主进程用 executeJavaScript('window.__vcExport()') 来取。
//
// 只读，绝不修改旧库 —— 万一迁移出了岔子，原数据还在原地。

const NAME = 'voicecollector';
const STORES = ['teachers', 'courses', 'sessions', 'audio', 'chunks', 'kv'];

function blobToB64(b) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

// 把记录里的 Blob 换成 {__blob, type}，把没法跨网址带走的东西（文件夹句柄之类）丢掉
async function pack(v, depth = 0) {
  if (v == null || depth > 6) return v;
  if (v instanceof Blob) return { __blob: await blobToB64(v), type: v.type || '' };
  if (typeof FileSystemHandle !== 'undefined' && v instanceof FileSystemHandle) return undefined;
  if (Array.isArray(v)) return Promise.all(v.map(x => pack(x, depth + 1)));
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      const p = await pack(v[k], depth + 1);
      if (p !== undefined) o[k] = p;
    }
    return o;
  }
  return v;
}

async function dbExists() {
  // 不先查的话，indexedDB.open 会在这个旧网址下凭空建一个空库出来
  if (!indexedDB.databases) return true;
  try { return (await indexedDB.databases()).some(d => d.name === NAME); } catch (_) { return true; }
}

function openRO() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(NAME);           // 不指定版本 = 按现有版本打开，不触发升级
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
    req.onupgradeneeded = () => { req.transaction.abort(); rej(new Error('库不存在')); };
  });
}

function readAll(db, store) {
  return new Promise(res => {
    if (!db.objectStoreNames.contains(store)) return res([]);
    try {
      const rq = db.transaction(store, 'readonly').objectStore(store).getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    } catch (_) { res([]); }
  });
}

window.__vcExport = async function () {
  const out = { origin: location.origin, stores: {}, local: {}, ok: true };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out.local[k] = localStorage.getItem(k);
    }
  } catch (_) {}
  if (!(await dbExists())) return out;
  let db;
  try { db = await openRO(); } catch (e) { return out; }
  for (const s of STORES) {
    const rows = await readAll(db, s);
    out.stores[s] = [];
    for (const r of rows) out.stores[s].push(await pack(r));
  }
  try { db.close(); } catch (_) {}
  return out;
};
window.__vcReady = true;
