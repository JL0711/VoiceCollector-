// whisper-client.js —— 主线程这边的 Worker 代理
// 对外接口刻意做成和 whisper.js 的 StreamingWhisper 一样，app.js 可以无痛替换。
//
// 关键保证：所有调用都带超时。Worker 卡死了也只是识别停摆，主线程和录音完全不受影响。

const WORKER_URL = new URL('./whisper-worker.js', import.meta.url);

function timeout(ms, label) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时（${Math.round(ms / 1000)}秒）`)), ms));
}

export class WhisperWorker {
  constructor({ model, language, windowSec = 25, overlapSec = 3, onPartial, onFinal, onStatus, device = 'auto' } = {}) {
    // device 'auto'：优先 WebGPU（快 5-10 倍也更省电），失败或超过 45 秒自动退回 CPU。
    // （曾经以为 WebGPU 会卡死，实际是本地服务器单线程导致的假象，已修复。）
    this.opts = { model, language, windowSec, overlapSec, device };
    this.onPartial = onPartial || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onStatus = onStatus || (() => {});
    this.device = null;
    this.ready = false;
    this._seq = 0;
    this._waits = new Map();
    this._dead = false;
  }

  _spawn() {
    if (this.w) return this.w;
    this.w = new Worker(WORKER_URL, { type: 'module' });
    this.w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'partial') return this.onPartial(m.text);
      if (m.type === 'final') return this.onFinal(m.text, m.startMs, m.endMs);
      if (m.type === 'status') return this.onStatus(m.status, m.detail);
      if (m.type === 'progress') return this.onStatus('downloading', m.progress);
      if (m.type === 'error') {
        const w = this._waits.get(m.id);
        if (w) { this._waits.delete(m.id); w.rej(new Error(m.message)); }
        else this.onStatus('error', { message: m.message });
        return;
      }
      const w = this._waits.get(m.id);
      if (w) { this._waits.delete(m.id); w.res(m); }
    };
    this.w.onerror = (e) => {
      this.onStatus('error', { message: '识别线程出错：' + (e.message || '未知') });
    };
    return this.w;
  }

  _call(msg, ms, label, transfer) {
    const w = this._spawn();
    const id = ++this._seq;
    const p = new Promise((res, rej) => this._waits.set(id, { res, rej }));
    w.postMessage({ ...msg, id }, transfer || []);
    return Promise.race([p, timeout(ms, label)]);
  }

  async probe() { return this._call({ type: 'probe' }, 20000, '探测'); }

  async start() {
    const r = await this._call({ type: 'start', ...this.opts }, 180000, '加载识别模型');
    this.device = r.device;
    this.ready = true;
    return r;
  }

  push(f32) {
    if (!this.w || this._dead) return;
    // 拷一份再转移所有权，避免动到调用方的缓冲区
    const buf = f32.slice().buffer;
    try { this.w.postMessage({ type: 'push', pcm: buf }, [buf]); } catch (_) {}
  }

  async flush() { try { await this._call({ type: 'flush' }, 120000, '收尾转写'); } catch (_) {} }

  async stop() {
    try { await this._call({ type: 'stop' }, 5000, '停止'); } catch (_) {}
    this.terminate();
  }

  terminate() {
    this._dead = true;
    try { this.w && this.w.terminate(); } catch (_) {}
    this.w = null;
    this.ready = false;
  }

  // 整段转写（课后重转用）
  async transcribeAll(pcm, { model, language, ms = 600000 } = {}) {
    const buf = pcm.slice().buffer;
    const r = await this._call({ type: 'transcribe', pcm: buf, model: model || this.opts.model, language: language || this.opts.language, device: this.opts.device },
      ms, '整段转写', [buf]);
    return r.text || '';
  }

  async preload(model, language) {
    return this._call({ type: 'preload', model, language, device: this.opts.device }, 600000, '下载模型');
  }
}
