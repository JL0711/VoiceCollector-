// 麦克风：音量表 + 完整录音备份 + 可选的分段录音（送云端转写）
export function pickMime() {
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const m of c) { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; }
  return '';
}

export async function listMics() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter(d => d.kind === 'audioinput');
  } catch (_) { return []; }
}

export class Mic {
  constructor() { this.stream = null; this.chunks = []; this.mime = pickMime(); }

  // chainFactory: 可选，(audioCtx, sourceNode) => {output, setBoost}，用来接 audio.js 里调好的远场链路
  async start({ deviceId, agc = true, ns = false, boost = 1, enhance = false, chainFactory = null } = {}) {
    const audio = {
      echoCancellation: false,
      noiseSuppression: !!ns,
      autoGainControl: !!agc,
      channelCount: 1
    };
    if (deviceId) audio.deviceId = { ideal: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (_) {} }
    this.src = this.ctx.createMediaStreamSource(this.stream);

    // 音量表接在「原始」信号上，显示的是教室里真实的音量，不会被增益骗到
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 1024;
    this.buf = new Uint8Array(this.an.fftSize);
    this.src.connect(this.an);

    // 远距离增强链：高通滤掉空调/桌面低频嗡嗡 → 压缩把远处人声抬起来 → 增益
    this.outStream = this.stream;
    this.chainOut = this.src;

    if (chainFactory) {
      // 优先用 audio.js 里针对「大教室 + 扩音器 + 混响」调过参的链路
      try {
        const c = chainFactory(this.ctx, this.src);
        const dest = this.ctx.createMediaStreamDestination();
        c.output.connect(dest);
        this.chain = c;
        this.chainOut = c.output;
        this.outStream = dest.stream;
        this.enhanced = true;
        return this.stream;
      } catch (_) { /* 掉回下面的内置链路 */ }
    }

    if (enhance || boost > 1) {
      try {
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 85;
        const pres = this.ctx.createBiquadFilter();
        pres.type = 'peaking'; pres.frequency.value = 2600; pres.Q.value = 0.9; pres.gain.value = 4;  // 人声清晰度
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -45; comp.knee.value = 30; comp.ratio.value = 6;
        comp.attack.value = 0.004; comp.release.value = 0.25;
        const g = this.ctx.createGain();
        g.gain.value = Math.max(1, boost);
        const dest = this.ctx.createMediaStreamDestination();
        this.src.connect(hp); hp.connect(pres); pres.connect(comp); comp.connect(g); g.connect(dest);
        this.gain = g;
        this.chainOut = g;
        this.outStream = dest.stream;
        this.enhanced = true;
      } catch (_) { this.outStream = this.stream; }
    }
    return this.stream;
  }

  setBoost(v) {
    if (this.chain && this.chain.setBoost) return this.chain.setBoost(v);
    if (this.gain) this.gain.gain.value = Math.max(1, v);
  }

  // 增强后的电平（用来提示「增强后够不够」）
  boostedLevel() { return Math.min(1, this.level() * (this.gain ? this.gain.gain.value : 1)); }

  level() {
    if (!this.an) return 0;
    this.an.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) { const v = (this.buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / this.buf.length);
    return Math.min(1, rms * 4.2);           // 0..1，已放大便于显示
  }

  recordStart() {
    const src = this.outStream || this.stream;
    if (!src || !window.MediaRecorder) return false;
    this.chunks = [];
    try {
      this.mr = new MediaRecorder(src, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 32000 } : undefined);
    } catch (_) {
      try { this.mr = new MediaRecorder(src); } catch (e) { return false; }
    }
    this.mr.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.start(5000);
    return true;
  }

  recordPause() { try { this.mr && this.mr.state === 'recording' && this.mr.pause(); } catch (_) {} }
  recordResume() { try { this.mr && this.mr.state === 'paused' && this.mr.resume(); } catch (_) {} }

  recordStop() {
    return new Promise(res => {
      if (!this.mr || this.mr.state === 'inactive') { res(this.chunks.length ? new Blob(this.chunks, { type: this.mime || 'audio/webm' }) : null); return; }
      this.mr.onstop = () => res(new Blob(this.chunks, { type: this.mime || 'audio/webm' }));
      try { this.mr.stop(); } catch (_) { res(null); }
    });
  }

  // 每 sec 秒产出一个可独立解码的音频片段（用于云端 Whisper 转写）
  chunkStart(sec, onChunk, clock) {
    const src = this.outStream || this.stream;
    if (!src || !window.MediaRecorder) return false;
    this._chunkOn = true;
    this._chunkIdx = 0;
    const mime = this.mime;
    const cycle = () => {
      if (!this._chunkOn) return;
      let parts = [];
      let mr;
      try { mr = new MediaRecorder(src, mime ? { mimeType: mime } : undefined); }
      catch (_) { this._chunkOn = false; return; }
      this._cmr = mr;
      const i = this._chunkIdx++;
      const at = clock ? clock() : 0;
      mr.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
      mr.onstop = () => {
        if (parts.length) {
          const b = new Blob(parts, { type: mime || 'audio/webm' });
          if (b.size > 2000) { try { onChunk(b, i, at); } catch (_) {} }
        }
        if (this._chunkOn) cycle();
      };
      mr.start();
      setTimeout(() => { try { mr.state !== 'inactive' && mr.stop(); } catch (_) {} }, sec * 1000);
    };
    cycle();
    return true;
  }
  chunkStop() {
    this._chunkOn = false;
    try { this._cmr && this._cmr.state !== 'inactive' && this._cmr.stop(); } catch (_) {}
  }

  stop() {
    this.chunkStop();
    try { this.stream && this.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { this.ctx && this.ctx.close(); } catch (_) {}
    this.stream = null; this.an = null;
  }
}

export async function keepAwake() {
  try {
    if ('wakeLock' in navigator) return await navigator.wakeLock.request('screen');
  } catch (_) {}
  return null;
}
