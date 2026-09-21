// mtllm-client.js —— 主线程侧的高质量翻译代理。所有调用带超时，Worker 挂了也不影响录音。
const URL_ = new URL('./mtllm-worker.js', import.meta.url);
const to = (ms, l) => new Promise((_, rej) => setTimeout(() => rej(new Error(`${l} 超时`)), ms));

export class MTLLM {
  constructor({ model, targetLang = 'zh-Hans', onStatus, onProgress } = {}) {
    this.model = model; this.targetLang = targetLang;
    this.onStatus = onStatus || (() => {});
    this.onProgress = onProgress || (() => {});
    this.ready = false; this.device = null;
    this._seq = 0; this._waits = new Map(); this._each = new Map();
  }
  _spawn() {
    if (this.w) return this.w;
    this.w = new Worker(URL_, { type: 'module' });
    this.w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'status') return this.onStatus(m.status, m.detail);
      if (m.type === 'progress') return this.onProgress(m.progress);
      if (m.type === 'each') { const cb = this._each.get(m.id); if (cb) cb(m.itemId, m.zh); return; }
      const w = this._waits.get(m.id);
      if (!w) return;
      this._waits.delete(m.id); this._each.delete(m.id);
      if (m.type === 'error') w.rej(new Error(m.message)); else w.res(m);
    };
    this.w.onerror = () => this.onStatus('error', { message: '翻译线程出错' });
    return this.w;
  }
  _call(msg, ms, label, onEach) {
    const w = this._spawn();
    const id = ++this._seq;
    if (onEach) this._each.set(id, onEach);
    const p = new Promise((res, rej) => this._waits.set(id, { res, rej }));
    w.postMessage({ ...msg, id });
    return Promise.race([p, to(ms, label)]);
  }
  probe() { return this._call({ type: 'probe' }, 20000, '探测翻译模型'); }
  async load() {
    const r = await this._call({ type: 'load', model: this.model, targetLang: this.targetLang }, 1800000, '加载翻译模型');
    this.ready = true; this.device = r.device;
    return r;
  }
  async translate(text, context) {
    if (!this.ready) return '';
    try { const r = await this._call({ type: 'one', text, context }, 90000, '翻译'); return r.zh || ''; }
    catch (_) { return ''; }
  }
  async translateMany(items, onEach) {
    if (!this.ready) return [];
    // 超时给 2 小时。之前是 1 小时，而对齐放大没修之前 300 句要跑 ~100 分钟 ——
    // 一超时 _call 直接 reject，**整节课的重译全部丢失**。
    const r = await this._call({ type: 'many', items, batchSize: 6 }, 7200000, '批量翻译',
      (itemId, zh) => { const it = items.find(x => x.id === itemId); if (it && onEach) onEach(it, zh); });
    return r.zhs || [];
  }
  async close() { try { await this._call({ type: 'close' }, 8000, '关闭'); } catch (_) {} this.terminate(); }
  terminate() { try { this.w && this.w.terminate(); } catch (_) {} this.w = null; this.ready = false; }
}
