// llm-client.js —— 主线程侧的本地小 AI 代理（全部调用带超时）
const URL_ = new URL('./llm-worker.js', import.meta.url);
const to = (ms, l) => new Promise((_, rej) => setTimeout(() => rej(new Error(`${l} 超时`)), ms));

export class LLMWorker {
  constructor({ onStatus, onProgress, onStep } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onProgress = onProgress || (() => {});
    this.onStep = onStep || (() => {});
    this._seq = 0; this._waits = new Map();
  }
  _spawn() {
    if (this.w) return this.w;
    this.w = new Worker(URL_, { type: 'module' });
    this.w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'status') return this.onStatus(m.status, m.detail);
      if (m.type === 'progress') return this.onProgress(m.progress);
      if (m.type === 'step') return this.onStep(m.step);
      const w = this._waits.get(m.id);
      if (!w) return;
      this._waits.delete(m.id);
      if (m.type === 'error') w.rej(new Error(m.message)); else w.res(m);
    };
    this.w.onerror = () => this.onStatus('error', { message: '本地 AI 线程出错' });
    return this.w;
  }
  _call(msg, ms, label) {
    const w = this._spawn();
    const id = ++this._seq;
    const p = new Promise((res, rej) => this._waits.set(id, { res, rej }));
    w.postMessage({ ...msg, id });
    return Promise.race([p, to(ms, label)]);
  }
  available() { return this._call({ type: 'available' }, 20000, '探测本地 AI'); }
  load(model) { return this._call({ type: 'load', model }, 1800000, '加载本地 AI 模型'); }
  async polish(analysis, ctx, opts = {}) {
    const r = await this._call({ type: 'polish', analysis, ctx, ...opts }, opts.budgetMs || 900000, '本地 AI 整理笔记');
    return r.markdown;
  }
  async ask(question, analysis, session) {
    const r = await this._call({ type: 'ask', question, analysis, session }, 300000, '本地 AI 回答');
    return r.answer;
  }
  async close() { try { await this._call({ type: 'close' }, 8000, '关闭'); } catch (_) {} this.terminate(); }
  terminate() { try { this.w && this.w.terminate(); } catch (_) {} this.w = null; }
}
