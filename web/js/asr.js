// 实时语音识别：Web Speech API + 自动重连 + 看门狗
// 这是整个应用最关键的部分——必须保证从头到尾都在听。
// ⚠️ 不能拿「构造函数在不在」当「功能能不能用」。
// Electron 的 Chromium 里 webkitSpeechRecognition **是存在的**，但 Electron 不带
// Google 的语音后端，一 start() 立刻 error（network / not-allowed），然后无限重连，
// 界面上就永远挂着一条红色的「识别服务网络异常，正在自动重连…」，而且一个字都出不来。
// 所以桌面版直接判定为不支持，一律走本地 Whisper —— 它离线、对远场更准、
// 而且不用把教授的声音传给任何人。浏览器里（Chrome/Edge）照旧用实时识别。
export const IS_DESKTOP = !!(window.VCDesktop && window.VCDesktop.isDesktop);
export const SR_SUPPORTED = !IS_DESKTOP && !!(window.SpeechRecognition || window.webkitSpeechRecognition);

const WATCHDOG_MS = 25000;   // 25 秒完全没有任何音频事件 → 判定引擎假死，强制重启
const MAX_BACKOFF = 3000;

export class ASR {
  constructor(opts = {}) {
    this.lang = opts.lang || 'en-US';
    this.onFinal = opts.onFinal || (() => {});
    this.onInterim = opts.onInterim || (() => {});
    this.onStatus = opts.onStatus || (() => {});   // 'listening' | 'reconnecting' | 'stopped'
    this.onError = opts.onError || (() => {});     // (code, fatal, msg)
    this.want = false;
    this.rec = null;
    this.retry = 0;
    this.lastBeat = 0;
    this.restarts = 0;
    this._lastFinal = '';
    this._lastFinalAt = 0;
  }

  start() {
    if (!SR_SUPPORTED) { this.onError('unsupported', true, '此浏览器不支持实时语音识别，请使用 Chrome 或 Edge'); return; }
    this.want = true;
    this.lastBeat = Date.now();
    this._spawn();
    clearInterval(this._timer);
    this._timer = setInterval(() => this._watch(), 4000);
  }

  stop() {
    this.want = false;
    clearInterval(this._timer);
    this._kill();
    this.onStatus('stopped');
  }

  setLang(l) {
    this.lang = l;
    if (this.want) { this._kill(); this._spawn(); }
  }

  _kill() {
    const r = this.rec;
    this.rec = null;
    if (!r) return;
    r.onresult = r.onerror = r.onend = r.onstart = r.onaudiostart = r.onsoundstart = r.onspeechstart = r.onspeechend = null;
    try { r.abort(); } catch (_) {}
    try { r.stop(); } catch (_) {}
  }

  _spawn() {
    if (!this.want) return;
    this._kill();
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let r;
    try { r = new SR(); } catch (e) { this.onError('create', true, String(e)); return; }
    r.lang = this.lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    const beat = () => { this.lastBeat = Date.now(); };

    r.onstart = () => { this.retry = 0; beat(); this.onStatus('listening'); };
    r.onaudiostart = beat;
    r.onsoundstart = beat;
    r.onspeechstart = beat;
    r.onspeechend = beat;

    r.onresult = (e) => {
      beat();
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = (res[0] && res[0].transcript) || '';
        if (res.isFinal) {
          const clean = txt.trim();
          if (!clean) continue;
          // 重连瞬间偶尔会重复推送同一句，去重
          const now = Date.now();
          if (clean === this._lastFinal && now - this._lastFinalAt < 4000) continue;
          this._lastFinal = clean; this._lastFinalAt = now;
          this.onFinal(clean, res[0].confidence ?? null);
        } else {
          interim += txt;
        }
      }
      this.onInterim(interim.trim());
    };

    r.onerror = (e) => {
      const code = e.error || 'unknown';
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.want = false;
        clearInterval(this._timer);
        this.onError(code, true, '麦克风权限被拒绝。请点击地址栏左边的图标允许使用麦克风，然后重新开始。');
        this.onStatus('stopped');
        return;
      }
      if (code === 'audio-capture') {
        this.onError(code, false, '找不到麦克风输入。请检查：麦克风是否插好、是否被其他程序（Zoom/腾讯会议）占用；若一直不行，可在「设置」里关掉「同时保存原始录音」再试。');
        return;
      }
      if (code === 'network') { this.onError(code, false, '识别服务网络异常，正在自动重连…'); return; }
      // no-speech / aborted 都是正常现象，交给 onend 重连
    };

    r.onend = () => {
      if (!this.want) { this.onStatus('stopped'); return; }
      this.onStatus('reconnecting');
      this.restarts++;
      const wait = Math.min(MAX_BACKOFF, 120 * Math.pow(1.7, this.retry++));
      setTimeout(() => this._spawn(), wait);
    };

    this.rec = r;
    try {
      r.start();
    } catch (err) {
      // "already started" —— 稍后重试
      setTimeout(() => this._spawn(), 400);
    }
  }

  _watch() {
    if (!this.want) return;
    if (Date.now() - this.lastBeat > WATCHDOG_MS) {
      this.lastBeat = Date.now();
      this.onStatus('reconnecting');
      this._spawn();            // 强制换一个新实例
    }
  }
}
