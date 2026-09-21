// player.js —— 句子级原声回放
//
// 为什么这是最重要的功能：
//   适应英语课堂语速，唯一有效的练习是**反复听真实语速的原声**。
//   读一百遍讲稿也不会让耳朵变快。所以要能做到：
//   点讲稿里任意一句 → 立刻播放那一句的原声 → 可以放慢、可以循环跟读。
//
// ⚠️ 核心技术坑：MediaRecorder 录出来的 webm **没有时长信息**。
//   浏览器读到的 duration 是 Infinity，导致 currentTime 赋值无效、进度条也画不出来。
//   通用解法（下面 fixDuration 干的事）：先把 currentTime 设成一个巨大的值，
//   浏览器会被迫去扫描整个文件算出真实时长并触发 durationchange，之后定位就正常了。

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
export const PLAYBACK_SPEEDS = SPEEDS;

export class SegmentPlayer {
  /**
   * @param {HTMLAudioElement} el   页面上的 <audio>
   * @param {Object} [opts]
   * @param {(info)=>void} [opts.onState]  播放状态变化：{playing, segId, rate, loop, loopsLeft, t, dur}
   */
  constructor(el, { onState } = {}) {
    this.el = el;
    this.onState = onState || (() => {});
    this.ready = false;
    this.duration = 0;
    this.rate = 1;
    this.loop = 0;              // 0 = 不循环；N = 这一句重复播 N 遍
    this._loopsLeft = 0;
    this._cur = null;           // {id, start, end} —— 单句模式才有
    this._segs = [];            // 连续模式用：[{id, t, endT}]，按时间升序
    this._activeId = null;      // 当前播到哪一句（字幕跟读滚动用）
    this.onActive = null;       // (segId) => void

    el.addEventListener('timeupdate', () => this._tick());
    el.addEventListener('ended', () => this._onEnd());
    el.addEventListener('pause', () => this._emit());
    el.addEventListener('play', () => this._emit());
  }

  /** 把录音装进播放器，并修好 webm 的时长问题 */
  async load(blob) {
    this.ready = false;
    if (this._url) { try { URL.revokeObjectURL(this._url); } catch (_) {} }
    this._url = URL.createObjectURL(blob);
    this.el.src = this._url;
    this.el.preload = 'auto';
    this.duration = await fixDuration(this.el);
    this.ready = true;
    this._emit();
    return this.duration;
  }

  setRate(r) {
    this.rate = Math.min(2, Math.max(0.4, Number(r) || 1));
    // preservesPitch: 变速不变调，否则 0.5 倍速听起来像低音怪物，练听力没用
    try { this.el.preservesPitch = true; this.el.mozPreservesPitch = true; this.el.webkitPreservesPitch = true; } catch (_) {}
    this.el.playbackRate = this.rate;
    this._emit();
  }

  setLoop(n) { this.loop = Math.max(0, n | 0); this._emit(); }

  /**
   * 告诉播放器整篇讲稿的时间轴，这样连续播放时它能算出「现在播到哪一句」。
   * @param {{id:string,t:number,endT:number}[]} list 按时间升序
   */
  setSegments(list) {
    this._segs = (list || []).filter(x => x && typeof x.t === 'number').sort((a, b) => a.t - b.t);
  }

  /** 二分查找当前时间落在哪一句上 */
  _segAt(ms) {
    const a = this._segs;
    if (!a.length) return null;
    let lo = 0, hi = a.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid].t <= ms) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (ans < 0) return null;
    const s = a[ans];
    // 落在这句的区间内才算（中间有长停顿时不要硬挂到上一句）
    if (s.endT != null && ms > s.endT + 1500) return null;
    return s;
  }

  /**
   * 连续播放：从某个时间点一直往下放，字幕会跟着走。
   * @param {number} startMs 从哪里开始；不传就从当前位置继续
   */
  async playFrom(startMs) {
    if (!this.ready) return false;
    this._cur = null;                 // 退出单句模式
    this._loopsLeft = 0;
    try {
      if (startMs != null) this.el.currentTime = Math.max(0, startMs / 1000);
      this.el.playbackRate = this.rate;
      await this.el.play();
    } catch (e) { console.warn('[player] 播放失败：', e); return false; }
    this._emit();
    return true;
  }

  /** 跳到下一句 / 上一句（键盘 ← → 用） */
  step(dir) {
    const a = this._segs;
    if (!a.length) return null;
    const cur = this._segAt(this.el.currentTime * 1000);
    let i = cur ? a.indexOf(cur) : -1;
    i = Math.max(0, Math.min(a.length - 1, i + (dir > 0 ? 1 : -1)));
    const target = a[i];
    if (target) {
      if (this._cur) this.play(target.id, target.t, target.endT);
      else this.playFrom(target.t);
    }
    return target;
  }

  /**
   * 播放一句。
   * @param {string} segId
   * @param {number} startMs  这句开始的毫秒
   * @param {number} endMs    下一句开始的毫秒（没有就传 null，默认放 8 秒）
   * @param {Object} [o] {pad=250} 前面多留一点，避免把句首第一个词切掉
   */
  async play(segId, startMs, endMs, { pad = 250 } = {}) {
    if (!this.ready) return false;
    const start = Math.max(0, (startMs - pad) / 1000);
    let end = endMs != null ? endMs / 1000 : start + 8;
    if (!(end > start)) end = start + 2;
    if (this.duration && end > this.duration) end = this.duration;
    this._cur = { id: segId, start, end };
    this._loopsLeft = this.loop;
    try {
      this.el.currentTime = start;
      this.el.playbackRate = this.rate;
      await this.el.play();
    } catch (e) {
      console.warn('[player] 播放失败：', e);
      return false;
    }
    this._emit();
    return true;
  }

  stop() {
    this._cur = null;
    this._loopsLeft = 0;
    try { this.el.pause(); } catch (_) {}
    this._emit();
  }

  toggle() {
    if (this.el.paused) { this.el.play().catch(() => {}); } else { this.el.pause(); }
  }

  get playing() { return !this.el.paused && !this.el.ended; }
  get currentSegId() { return this._cur && this._cur.id; }

  _tick() {
    const c = this._cur;
    if (!c) { this._emit(); return; }
    if (this.el.currentTime >= c.end) {
      if (this._loopsLeft > 0) {
        this._loopsLeft--;
        this.el.currentTime = c.start;      // 循环跟读
      } else {
        this.el.pause();
        this._cur = null;
      }
    }
    this._emit();
  }

  _onEnd() { this._cur = null; this._emit(); }

  _emit() {
    // 字幕跟读：算出现在播到哪一句，变了就通知界面高亮 + 滚动
    if (this._segs.length) {
      const hit = this._segAt(this.el.currentTime * 1000);
      const id = (this._cur && this._cur.id) || (hit && hit.id) || null;
      if (id !== this._activeId) {
        this._activeId = id;
        if (this.onActive) { try { this.onActive(id); } catch (_) {} }
      }
    }
    try {
      this.onState({
        playing: this.playing,
        segId: this._cur && this._cur.id,
        rate: this.rate,
        loop: this.loop,
        loopsLeft: this._loopsLeft,
        t: this.el.currentTime,
        dur: this.duration,
        activeId: this._activeId
      });
    } catch (_) {}
  }

  destroy() {
    this.stop();
    if (this._url) { try { URL.revokeObjectURL(this._url); } catch (_) {} this._url = null; }
  }
}

/**
 * 修好 MediaRecorder 录出来的 webm 没有时长的问题。
 * 返回真实时长（秒）；实在拿不到就返回 0（调用方仍可顺序播放，只是没法定位）。
 */
export function fixDuration(el, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener('durationchange', onDur);
      el.removeEventListener('loadedmetadata', onMeta);
      try { el.currentTime = 0; } catch (_) {}
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    };
    const onDur = () => {
      const d = el.duration;
      if (Number.isFinite(d) && d > 0) finish(d);
    };
    const onMeta = () => {
      const d = el.duration;
      if (Number.isFinite(d) && d > 0) { finish(d); return; }
      // duration 是 Infinity —— 强制浏览器扫完整个文件把真实时长算出来
      try { el.currentTime = 1e101; } catch (_) { finish(0); }
    };
    const timer = setTimeout(() => finish(el.duration), timeoutMs);
    el.addEventListener('durationchange', onDur);
    el.addEventListener('loadedmetadata', onMeta);
    if (el.readyState >= 1) onMeta();
  });
}

/** 给一组 segments 算出每一句的结束时间（下一句的开始，最后一句用总时长） */
export function withEndTimes(segments, totalMs) {
  const sp = segments.filter(s => s.kind === 'speech');
  return sp.map((s, i) => ({
    ...s,
    endT: i + 1 < sp.length ? sp[i + 1].t : (totalMs || s.t + 8000)
  }));
}

// ───────────────────────────────────────────────────────────────────────────
// 跟读录音（shadowing）
// ───────────────────────────────────────────────────────────────────────────
//
// 为什么要这个：听得懂 ≠ 跟得上。适应语速最后一步是**嘴跟得上**——
// 对着原声复述，逼自己用同样的时间说完同样的内容。
// 而「原声 3.2 秒，你用了 5.1 秒」这个数字本身就是最直接的进步指标。

export class ShadowRecorder {
  constructor({ onState } = {}) {
    this.onState = onState || (() => {});
    this.stream = null;
    this.mr = null;
    this.chunks = [];
    this.recording = false;
    this.startedAt = 0;
  }

  /** 取一次麦克风权限，之后复用同一个流（反复申请会让浏览器每次都闪权限条） */
  async arm() {
    if (this.stream && this.stream.active) return true;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    return true;
  }

  async start() {
    await this.arm();
    this.chunks = [];
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    this.mr = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
    this.mr.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.start();
    this.recording = true;
    this.startedAt = Date.now();
    this.onState({ recording: true, ms: 0 });
    clearInterval(this._t);
    this._t = setInterval(() => {
      if (this.recording) this.onState({ recording: true, ms: Date.now() - this.startedAt });
    }, 100);
    return true;
  }

  /** @returns {Promise<{blob:Blob, ms:number}|null>} */
  stop() {
    clearInterval(this._t);
    if (!this.mr || this.mr.state === 'inactive') {
      this.recording = false;
      this.onState({ recording: false, ms: 0 });
      return Promise.resolve(null);
    }
    const ms = Date.now() - this.startedAt;
    return new Promise(res => {
      this.mr.onstop = () => {
        this.recording = false;
        this.onState({ recording: false, ms });
        const blob = new Blob(this.chunks, { type: this.mr.mimeType || 'audio/webm' });
        res(blob.size > 500 ? { blob, ms } : null);
      };
      try { this.mr.stop(); } catch (_) { res(null); }
    });
  }

  /** 松手就停：不用点两次，按住说完松开即可 */
  dispose() {
    clearInterval(this._t);
    try { this.mr && this.mr.state !== 'inactive' && this.mr.stop(); } catch (_) {}
    try { this.stream && this.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    this.stream = null; this.mr = null; this.recording = false;
  }
}

/**
 * 跟读结果对比。
 * @param {number} originalMs 原声这句多长
 * @param {number} yourMs     她说了多长
 */
export function compareShadow(originalMs, yourMs) {
  if (!originalMs || !yourMs) return { ratio: 0, verdict: '', tone: 'neutral' };
  const ratio = yourMs / originalMs;
  const pct = Math.round((ratio - 1) * 100);
  if (ratio <= 1.1) return { ratio, verdict: `跟上了！用时和原声基本一致（${(yourMs / 1000).toFixed(1)}s vs ${(originalMs / 1000).toFixed(1)}s）`, tone: 'great' };
  if (ratio <= 1.35) return { ratio, verdict: `很接近，比原声慢 ${pct}%。再跟两遍就能压到同速`, tone: 'good' };
  if (ratio <= 1.8) return { ratio, verdict: `比原声慢 ${pct}%。先用 0.75 倍速跟熟，再回到原速`, tone: 'mid' };
  return { ratio, verdict: `比原声慢 ${pct}%。这句偏难，建议先听三遍再开口，或者从 0.5 倍速开始`, tone: 'slow' };
}
