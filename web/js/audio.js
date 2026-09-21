// 远场音频处理 + 格式转换
// 场景：大阶梯教室，老师用话筒 + PA 扩音喇叭，学生坐在 50m 外的后排，用笔记本内置麦克风录。
// 信号特点：电平其实不算低（PA 是为全场设计的），真正的敌人是
//   ① 混响（大厅 RT60 常常 1.5~2.5s，把辅音糊掉）
//   ② 人群噪声（翻书、咳嗽、低语，宽带且随机）
//   ③ 低频隆隆声（空调、投影仪风扇、房间模态、桌椅）
//   ④ 笔记本麦克风的 AGC 抽风（安静时猛拉增益，把底噪抬成"沙沙"）
// 本模块只做信号处理与格式转换，不碰 UI、不碰设置、不碰网络。

// ---------------------------------------------------------------------------
// 一、增强链 buildChain
// ---------------------------------------------------------------------------

// 各预设的调参表。注释写清楚「为什么是这个数」，以后要调有据可依。
export const CHAIN_PRESETS = {
  // 近场：前排、领夹麦、或者直接录电脑外放。信号本来就干净，只做最轻的修饰。
  near: {
    hp:    { freq: 80,   Q: 0.707 },        // 只切掉次低频。男声基频最低到 85Hz，不能再往上切。
    mud:   { freq: 220,  gain: -2 },        // 轻微去浑浊
    pres:  { freq: 2800, Q: 1.0,  gain: 3 },// 辅音微抬
    lp:    { freq: 8000, Q: 0.707 },        // 16kHz 采样的奈奎斯特是 8k，到这儿为止
    comp:  { threshold: -30, knee: 24, ratio: 3, attack: 0.006, release: 0.20 },
    limit: { threshold: -2,  knee: 0,  ratio: 20, attack: 0.001, release: 0.06 }
  },

  // 大厅：50m + PA + 强混响。这是本项目的主力预设。
  hall: {
    // 高通 120Hz：50m 外 PA 的低频在大厅里堆成隆隆声（房间模态集中在 40~120Hz），
    // 空调和投影仪风扇也全在这一段。120Hz 以下几乎不携带可懂度信息，
    // 切掉最大的好处是：后面的压缩器不会被低频能量"骗"着去压真正的人声。
    hp:    { freq: 120,  Q: 0.707 },

    // 低架衰减 300Hz / -5dB：大厅混响能量主要堆在 150~400Hz，这段"糊"会
    // 向上掩蔽辅音（upward masking）。降 5dB 是扩声调音里的常规手法，
    // 对识别率的提升比任何增益都明显。
    mud:   { freq: 300,  gain: -5 },

    // presence 提升 3kHz / +6dB / Q 0.9：/s/ /t/ /k/ /f/ 这些辅音的能量在 2~4kHz，
    // 正是混响和人群噪声最先吃掉的部分，也是 Whisper 最敏感的频段。
    // Q 取 0.9 是为了做成宽带的"抬亮"，而不是一个窄共振峰（窄了会有金属声）。
    pres:  { freq: 3000, Q: 0.9,  gain: 6 },

    // 低通 7.5kHz：① 7.5k 以上基本只剩笔记本麦克风自噪声和人群嘶声，没有语音信息；
    // ② 16kHz 重采样的奈奎斯特是 8kHz，提前滚降等于抗混叠的第一道防线。
    lp:    { freq: 7500, Q: 0.707 },

    // 压缩器：50m 外人声的电平在 -45 ~ -30dBFS 之间飘，门限要压到 -42 才抓得住句尾。
    // ratio 5 = 把 15dB 的动态压成 3dB。
    // attack 5ms：太快会把 /t/ /k/ 的爆破起音削掉，5ms 刚好放过起音、压住后面的元音。
    // release 280ms 是最关键的一个数：放得太快（<100ms）压缩器会在词与词的空隙里
    // 把混响尾巴和人群噪声一起抬上来，听感更糊、识别更差；280ms 刚好跨过一个音节间隙。
    comp:  { threshold: -42, knee: 20, ratio: 5, attack: 0.005, release: 0.28 },

    // 限幅：boost 之后峰值很容易撞 0dBFS，削波产生的谐波会让 Whisper 直接吐垃圾。
    // -1.5dB 门限 + 20:1 + 1ms attack 近似砖墙，是最后一道保险。
    limit: { threshold: -1.5, knee: 0, ratio: 20, attack: 0.001, release: 0.05 }
  },

  // 自定义：频响基本拉平，只保留很温和的压缩和限幅，让用户自己用 boost 控制。
  custom: {
    hp:    { freq: 60,   Q: 0.707 },
    mud:   { freq: 250,  gain: 0 },
    pres:  { freq: 3000, Q: 1.0,  gain: 0 },
    lp:    { freq: 9000, Q: 0.707 },
    comp:  { threshold: -24, knee: 30, ratio: 2, attack: 0.010, release: 0.25 },
    limit: { threshold: -1.5, knee: 0, ratio: 20, attack: 0.001, release: 0.05 }
  }
};

const clampBoost = v => Math.min(8, Math.max(1, Number(v) || 1));

// 平滑地改 AudioParam，避免"拉链噪声"（直接赋值会在采样点上产生阶跃）
function ramp(param, value, ctx, tc = 0.02) {
  if (!param) return;
  try { param.setTargetAtTime(value, ctx.currentTime, tc); }
  catch (_) { try { param.value = value; } catch (__) {} }
}

/**
 * 搭一条远场增强链。
 * @param {BaseAudioContext} audioCtx
 * @param {AudioNode} sourceNode  一般是 createMediaStreamSource(麦克风流)
 * @param {{preset?:'near'|'hall'|'custom', boost?:number}} opts
 * @returns {{output: AudioNode, setBoost:(v:number)=>void, setPreset:(name:string)=>void, nodes:object}}
 *
 * 链路：source → 高通 → 低架去浑浊 → presence 提升 → 低通 → 压缩 → 增益 → 限幅 → output
 * 调用方自己负责把 output 接到 MediaStreamDestination / PCMTap / Analyser。
 * 本函数不会主动连到 audioCtx.destination（连上去就是啸叫）。
 */
export function buildChain(audioCtx, sourceNode, opts = {}) {
  const ctx = audioCtx;
  const name = CHAIN_PRESETS[opts.preset] ? opts.preset : 'hall';

  const hp = ctx.createBiquadFilter();    hp.type = 'highpass';
  const mud = ctx.createBiquadFilter();   mud.type = 'lowshelf';
  const pres = ctx.createBiquadFilter();  pres.type = 'peaking';
  const lp = ctx.createBiquadFilter();    lp.type = 'lowpass';
  const comp = ctx.createDynamicsCompressor();
  const gain = ctx.createGain();
  const limit = ctx.createDynamicsCompressor();

  const nodes = { hp, mud, pres, lp, comp, gain, limit };

  // 先把参数填上（不做 ramp，初始化阶段直接赋值更准）
  let current = name;
  applyPreset(name, true);

  if (sourceNode) { try { sourceNode.connect(hp); } catch (_) {} }
  hp.connect(mud); mud.connect(pres); pres.connect(lp);
  lp.connect(comp); comp.connect(gain); gain.connect(limit);

  gain.gain.value = clampBoost(opts.boost);

  function applyPreset(n, instant) {
    const p = CHAIN_PRESETS[n];
    if (!p) return;
    const set = (param, v) => { if (instant) { try { param.value = v; } catch (_) {} } else ramp(param, v, ctx); };
    set(hp.frequency, p.hp.freq);       set(hp.Q, p.hp.Q);
    set(mud.frequency, p.mud.freq);     set(mud.gain, p.mud.gain);
    set(pres.frequency, p.pres.freq);   set(pres.Q, p.pres.Q);   set(pres.gain, p.pres.gain);
    set(lp.frequency, p.lp.freq);       set(lp.Q, p.lp.Q);
    set(comp.threshold, p.comp.threshold); set(comp.knee, p.comp.knee);
    set(comp.ratio, p.comp.ratio);         set(comp.attack, p.comp.attack);
    set(comp.release, p.comp.release);
    set(limit.threshold, p.limit.threshold); set(limit.knee, p.limit.knee);
    set(limit.ratio, p.limit.ratio);         set(limit.attack, p.limit.attack);
    set(limit.release, p.limit.release);
    current = n;
  }

  return {
    output: limit,
    nodes,
    setBoost(v) { ramp(gain.gain, clampBoost(v), ctx, 0.05); },
    setPreset(n) { if (CHAIN_PRESETS[n] && n !== current) applyPreset(n, false); },
    // 额外的小工具：当前压缩器的增益衰减量（dB，负数），可以拿来做「正在压多狠」的指示
    // 老 WebKit 上 reduction 是个 AudioParam 而不是 number，这里统一取成数字。
    reduction() {
      try {
        const r = comp.reduction;
        const v = (r && typeof r === 'object') ? r.value : r;
        return typeof v === 'number' && isFinite(v) ? v : 0;
      } catch (_) { return 0; }
    },
    presetName() { return current; }
  };
}

// ---------------------------------------------------------------------------
// 二、多相重采样核心（抗混叠）
//     下面这个函数会被「原样序列化」进 AudioWorklet 的代码里（见 workletSource），
//     所以它必须完全自包含：只能用 Math，不能引用模块里任何其他标识符。
// ---------------------------------------------------------------------------

function vcBuildBank(ratio, HW, P) {
  // 生成 P 组多相滤波器系数。每组对应一个「小数相位」frac = p/P。
  // 核是加了 Blackman 窗的 sinc 低通，截止频率固定在 0.45 × 输出采样率
  // （48k→16k 时就是 7200Hz），这样降采样前就把奈奎斯特以上的能量滤干净了，
  // 不会出现「简单抽样」那种把 10kHz 的嘶声折回到 6kHz 上去污染人声的问题。
  const N = HW * 2;
  const fc = ratio > 1 ? 0.45 / ratio : 0.45;   // 归一化到「输入采样率」的截止频率
  const bank = [];
  for (let p = 0; p < P; p++) {
    const frac = p / P;
    const h = new Float32Array(N);
    let sum = 0;
    for (let k = 0; k < N; k++) {
      const d = k - HW + 1 - frac;              // 该抽头到目标位置的距离（单位：输入样本）
      const x = 2 * fc * d;
      const s = Math.abs(x) < 1e-8 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * k / (N - 1)) + 0.08 * Math.cos(4 * Math.PI * k / (N - 1));
      const v = 2 * fc * s * w;
      h[k] = v;
      sum += v;
    }
    if (sum) for (let k = 0; k < N; k++) h[k] /= sum;   // 直流增益归一化为 1，避免整体音量漂移
    bank.push(h);
  }
  return bank;
}

const RS_HW = 16;    // 单边抽头数（总 32 抽头）
const RS_P = 32;     // 相位数，小数位置量化到 1/32 个输入样本，误差可忽略

/**
 * 流式重采样器（模块内部用；PCMTap 的 ScriptProcessor 回退路径和 blobToPCM16k 都用它）。
 * push(Float32Array) → Float32Array，内部保留尾部历史，跨块连续，不会在块边界产生咔哒声。
 */
function makeResampler(inRate, outRate) {
  const HW = RS_HW, P = RS_P, N = HW * 2, TAIL = HW * 2;
  const ratio = inRate / outRate;
  const bank = vcBuildBank(ratio, HW, P);
  const tail = new Float32Array(TAIL);
  let pos = TAIL;          // 下一个输出样本在 buf 坐标系里的小数位置
  let buf = null;

  return function push(input) {
    const n = input.length;
    if (!n) return new Float32Array(0);
    if (!buf || buf.length !== TAIL + n) buf = new Float32Array(TAIL + n);
    buf.set(tail, 0);
    buf.set(input, TAIL);
    const total = TAIL + n;
    const cap = Math.max(0, Math.ceil((total - HW - pos) / ratio)) + 2;
    const out = new Float32Array(cap);
    let m = 0;
    while (Math.floor(pos) + HW < total && m < cap) {
      const i0 = Math.floor(pos);
      let p = ((pos - i0) * P) | 0;
      if (p >= P) p = P - 1;
      const h = bank[p];
      const base = i0 - HW + 1;
      let acc = 0;
      for (let k = 0; k < N; k++) acc += h[k] * buf[base + k];
      out[m++] = acc;
      pos += ratio;
    }
    tail.set(buf.subarray(total - TAIL, total));
    pos -= n;                // 坐标平移：下一块的 buf[0] 就是这一块的 buf[total-TAIL]
    return m === cap ? out : out.subarray(0, m);
  };
}

// ---------------------------------------------------------------------------
// 三、PCMTap：实时抽出 16kHz 单声道 Float32
// ---------------------------------------------------------------------------

// AudioWorklet 的源码。用 Blob URL 加载：项目没有构建步骤，也不想多一个网络请求。
// 注意 worklet 是独立的全局作用域，所以 vcBuildBank 必须整个塞进来。
function workletSource() {
  return `
${vcBuildBank.toString()}

class VCPcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.outRate = o.outRate || 16000;
    this.frame = o.frame || 1024;          // 攒够这么多输出样本再 postMessage 一次，减少线程通信次数（省电）
    this.HW = o.HW || 16;
    this.P = o.P || 32;
    this.N = this.HW * 2;
    this.TAIL = this.HW * 2;
    this.ratio = sampleRate / this.outRate;
    this.bank = vcBuildBank(this.ratio, this.HW, this.P);
    this.tail = new Float32Array(this.TAIL);
    this.pos = this.TAIL;
    this.buf = null;
    this.out = new Float32Array(this.frame);
    this.m = 0;
    this.dead = false;
    this.port.onmessage = e => { if (e.data && e.data.cmd === 'stop') this.dead = true; };
  }

  process(inputs) {
    if (this.dead) return false;           // 只有收到 stop 才返回 false，让节点自然回收
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;    // 没输入也要继续活着（麦克风可能只是短暂静默）

    const n = ch.length;
    const TAIL = this.TAIL, N = this.N, HW = this.HW, P = this.P;
    if (!this.buf || this.buf.length !== TAIL + n) this.buf = new Float32Array(TAIL + n);
    const buf = this.buf;
    buf.set(this.tail, 0);
    buf.set(ch, TAIL);
    const total = TAIL + n;
    let pos = this.pos;

    while (Math.floor(pos) + HW < total) {
      const i0 = Math.floor(pos);
      let p = ((pos - i0) * P) | 0;
      if (p >= P) p = P - 1;
      const h = this.bank[p];
      const base = i0 - HW + 1;
      let acc = 0;
      for (let k = 0; k < N; k++) acc += h[k] * buf[base + k];
      this.out[this.m++] = acc;
      if (this.m >= this.frame) {
        const copy = new Float32Array(this.out);           // 必须复制，this.out 要复用
        this.port.postMessage({ samples: copy }, [copy.buffer]);
        this.m = 0;
      }
      pos += this.ratio;
    }

    this.tail.set(buf.subarray(total - TAIL, total));
    this.pos = pos - n;
    return true;
  }
}

registerProcessor('vc-pcm-tap', VCPcmTapProcessor);
`;
}

let workletURL = null;
function getWorkletURL() {
  if (!workletURL) workletURL = URL.createObjectURL(new Blob([workletSource()], { type: 'text/javascript' }));
  return workletURL;
}

/**
 * 把实时音频持续转成 16kHz 单声道 Float32Array 喂给 onSamples（Whisper 要的就是这个格式）。
 *
 *   const tap = new PCMTap(ctx, chain.output, { onSamples: f32 => ... });
 *   await tap.connect();          // connect() 是 async（要 addModule），但不 await 也能用
 *   ...
 *   tap.disconnect();
 *
 * 优先 AudioWorklet（跑在音频线程，不抢主线程，能耗和卡顿都远好于 ScriptProcessor）；
 * 不可用时自动回退到 ScriptProcessorNode（bufferSize 4096，刻意取大一点以减少主线程唤醒次数）。
 */
export class PCMTap {
  constructor(audioCtx, sourceNode, { targetRate = 16000, onSamples, frame = 1024 } = {}) {
    this.ctx = audioCtx;
    this.source = sourceNode;
    this.targetRate = targetRate || 16000;
    this.onSamples = typeof onSamples === 'function' ? onSamples : () => {};
    this.frame = frame;
    this.node = null;
    this.sink = null;
    this.mode = '';          // 'worklet' | 'script' | ''
    this._on = false;
  }

  async connect() {
    if (this._on) return this.mode;
    this._on = true;

    // Web Audio 只「拉动」通向 destination 的节点。抽头节点本身不出声，
    // 所以接一个 gain=0 的静音汇合点再去 destination，保证它一定被调度到，又绝不会啸叫。
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;

    const ok = await this._tryWorklet();
    if (!ok) this._useScriptProcessor();

    // 只有真的建起了抽头节点才去接 destination。两条路都不可用时（mode 为 ''）
    // 接上去只会白白唤醒音频输出设备，白费电，而且什么也抽不到。
    if (this.node) { try { this.sink.connect(this.ctx.destination); } catch (_) {} }
    return this.mode;
  }

  async _tryWorklet() {
    if (!this.ctx.audioWorklet || typeof AudioWorkletNode !== 'function') return false;
    try {
      await this.ctx.audioWorklet.addModule(getWorkletURL());
      if (!this._on) return true;                       // connect 期间已经被 disconnect 了
      const node = new AudioWorkletNode(this.ctx, 'vc-pcm-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { outRate: this.targetRate, frame: this.frame, HW: RS_HW, P: RS_P }
      });
      node.port.onmessage = e => {
        const s = e.data && e.data.samples;
        if (s && this._on) { try { this.onSamples(s); } catch (_) {} }
      };
      try { this.source.connect(node); } catch (_) {}
      node.connect(this.sink);
      this.node = node;
      this.mode = 'worklet';
      return true;
    } catch (_) {
      return false;
    }
  }

  _useScriptProcessor() {
    const make = this.ctx.createScriptProcessor || this.ctx.createJavaScriptNode;
    if (!make) { this.mode = ''; return; }
    const resample = makeResampler(this.ctx.sampleRate, this.targetRate);
    // 4096 @48k ≈ 85ms 一次回调。对分段送云端转写完全够用，
    // 而 buffer 取小（1024/2048）只会让主线程每秒被唤醒更多次，白费电。
    const sp = make.call(this.ctx, 4096, 1, 1);
    let acc = [];
    let accLen = 0;
    sp.onaudioprocess = e => {
      if (!this._on) return;
      const out = resample(e.inputBuffer.getChannelData(0));
      if (!out.length) return;
      acc.push(out); accLen += out.length;
      while (accLen >= this.frame) {
        const chunk = new Float32Array(this.frame);
        let need = this.frame, w = 0;
        while (need > 0) {
          const head = acc[0];
          const take = Math.min(need, head.length);
          chunk.set(head.subarray(0, take), w);
          w += take; need -= take; accLen -= take;
          if (take === head.length) acc.shift();
          else acc[0] = head.subarray(take);
        }
        try { this.onSamples(chunk); } catch (_) {}
      }
    };
    try { this.source.connect(sp); } catch (_) {}
    sp.connect(this.sink);
    this.node = sp;
    this.mode = 'script';
  }

  disconnect() {
    this._on = false;
    const n = this.node;
    if (n) {
      try { this.source.disconnect(n); } catch (_) {}
      try { n.disconnect(); } catch (_) {}
      if (n.port) { try { n.port.postMessage({ cmd: 'stop' }); n.port.onmessage = null; } catch (_) {} }
      if ('onaudioprocess' in n) { try { n.onaudioprocess = null; } catch (_) {} }
    }
    if (this.sink) { try { this.sink.disconnect(); } catch (_) {} }
    this.node = null;
    this.sink = null;
  }
}

// ---------------------------------------------------------------------------
// 四、离线解码与重采样
// ---------------------------------------------------------------------------

// 解码上限。16kHz 单声道 Float32 = 64KB/s，3 小时 ≈ 690MB，再往上浏览器标签页必崩。
// 而且 decodeAudioData 本身要先把原始采样率（通常 48k）的整段解出来，峰值内存是这个数的 3 倍。
// 超过上限时抛错，调用方应该改用 mic.chunkStart 的分段 blob 逐段处理。
export const MAX_DECODE_SECONDS = 3 * 3600;
const MAX_BLOB_BYTES = 400 * 1024 * 1024;

let decodeCtx = null;
function getDecodeCtx() {
  if (decodeCtx) return decodeCtx;
  // 优先用 OfflineAudioContext 解码：它不占用硬件音频设备，也不算进浏览器
  // 对「同时存在的 AudioContext 数量」的限制里。
  try { decodeCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100); }
  catch (_) {
    try { decodeCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (__) { decodeCtx = null; }
  }
  return decodeCtx;
}

function decodeAudio(ctx, arrayBuf) {
  return new Promise((res, rej) => {
    let p;
    try { p = ctx.decodeAudioData(arrayBuf, res, rej); } catch (e) { rej(e); return; }
    if (p && typeof p.then === 'function') p.then(res, rej);   // 老 Safari 只有回调版
  });
}

/**
 * 把任意录好的音频 blob 解码 + 下混单声道 + 重采样成 16kHz。
 * 用于「课后整段重新转写」。
 * @param {Blob} blob
 * @returns {Promise<Float32Array>} 16kHz 单声道
 *
 * 内存策略：解码这一步没法分段（blob 是压缩容器，必须整体交给浏览器），
 * 但重采样是分块跑的（每块 30 秒），只用一个复用的临时缓冲区 + 一个预分配的输出数组，
 * 不会额外产生「整段的副本」。超过 MAX_DECODE_SECONDS 直接抛错。
 */
export async function blobToPCM16k(blob) {
  if (!blob || !blob.size) return new Float32Array(0);
  if (blob.size > MAX_BLOB_BYTES) throw new Error('音频文件太大，无法整段解码，请改用分段转写');

  const ctx = getDecodeCtx();
  if (!ctx) throw new Error('当前环境不支持音频解码');

  const ab = await blob.arrayBuffer();
  // decodeAudioData 失败时浏览器抛的是英文 DOMException（"Unable to decode audio data"），
  // 直接冒到界面上用户看不懂。这里统一换成中文，并指明出路。
  // 注意：压缩容器在解码前拿不到时长，所以下面 MAX_DECODE_SECONDS 那道检查是「事后」的；
  // 真正超长的录音往往在这一步就因为内存不够而失败，所以这个提示是主要的兜底。
  let buf;
  try {
    buf = await decodeAudio(ctx, ab);
  } catch (e) {
    throw new Error('音频解码失败（可能是录音太长导致内存不足，或格式不被支持），请改用分段转写');
  }
  if (buf.duration > MAX_DECODE_SECONDS) {
    throw new Error(`录音太长（${Math.round(buf.duration / 60)} 分钟，上限 ${MAX_DECODE_SECONDS / 3600} 小时），请改用分段转写`);
  }

  const chs = buf.numberOfChannels;
  const inRate = buf.sampleRate;
  const total = buf.length;

  // 采样率已经对上、又是单声道：直接拷一份返回，别白跑一遍滤波器。
  if (chs === 1 && inRate === 16000) return new Float32Array(buf.getChannelData(0));

  const data = [];
  for (let c = 0; c < chs; c++) data.push(buf.getChannelData(c));

  const resample = makeResampler(inRate, 16000);
  const BLOCK = Math.max(4096, Math.floor(inRate * 30));     // 每次处理 30 秒
  const mono = new Float32Array(BLOCK);
  // 预分配输出：多留 64 个样本，吃掉滤波器时延带来的取整误差
  const out = new Float32Array(Math.ceil(total * 16000 / inRate) + 64);
  let w = 0;

  for (let off = 0; off < total; off += BLOCK) {
    const len = Math.min(BLOCK, total - off);
    if (chs === 1) {
      mono.set(data[0].subarray(off, off + len));
    } else {
      // 下混：直接平均。远场录音各声道内容基本一致，平均能顺带降一点不相关的底噪。
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < chs; c++) s += data[c][off + i];
        mono[i] = s / chs;
      }
    }
    const piece = resample(len === BLOCK ? mono : mono.subarray(0, len));
    if (piece.length) {
      const take = Math.min(piece.length, out.length - w);
      out.set(take === piece.length ? piece : piece.subarray(0, take), w);
      w += take;
    }
  }
  return w === out.length ? out : out.subarray(0, w);
}

// ---------------------------------------------------------------------------
// 五、WAV 编码
// ---------------------------------------------------------------------------

/**
 * 标准 16-bit PCM WAV。
 * 传 16k WAV 给云端 Whisper 比传 48k webm 又小又准（Whisper 内部本来就要降到 16k，
 * 我们自己降一次，顺便把抗混叠做对了，服务端也少一次解码）。
 * @param {Float32Array} float32
 * @param {number} sampleRate
 * @returns {Blob} audio/wav
 */
export function encodeWAV(float32, sampleRate = 16000) {
  const n = float32 ? float32.length : 0;
  const bytes = n * 2;
  const ab = new ArrayBuffer(44 + bytes);
  const v = new DataView(ab);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);          // fmt 块长度
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // 单声道
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);   // 字节率 = 采样率 × 声道 × 位深/8
  v.setUint16(32, 2, true);           // 块对齐
  v.setUint16(34, 16, true);          // 位深
  str(36, 'data');
  v.setUint32(40, bytes, true);

  let off = 44;
  for (let i = 0; i < n; i++, off += 2) {
    let s = float32[i];
    s = s < -1 ? -1 : s > 1 ? 1 : s;                       // 先夹紧，防止溢出绕回变成爆音
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// ---------------------------------------------------------------------------
// 六、电平工具
// ---------------------------------------------------------------------------

/**
 * 峰值归一化。**返回新数组**，不改原数组（原数组可能还要被别的地方用）。
 * 注意：这是纯峰值归一化，一声桌子磕碰就能把整段压下去。
 * 所以链路里应该先过 buildChain 的限幅器，再来归一化，效果才稳。
 */
export function normalize(float32, targetPeak = 0.95) {
  const n = float32 ? float32.length : 0;
  const out = new Float32Array(n);
  if (!n) return out;
  let peak = 0;
  for (let i = 0; i < n; i++) { const a = float32[i] < 0 ? -float32[i] : float32[i]; if (a > peak) peak = a; }
  if (peak < 1e-6) { out.set(float32); return out; }        // 基本是静音，别去放大底噪
  const g = targetPeak / peak;
  for (let i = 0; i < n; i++) out[i] = float32[i] * g;
  return out;
}

/**
 * RMS 电平（dBFS，负数）。用来判断「音量够不够」。
 * 经验值：后排 50m 录到的老师人声，过完增强链大概在 -30 ~ -18dB；
 * 低于 -45dB 基本没救，要提示用户挪位置或者外接麦。
 */
export function rmsDb(float32) {
  const n = float32 ? float32.length : 0;
  if (!n) return -100;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += float32[i] * float32[i];
  const rms = Math.sqrt(sum / n);
  if (rms < 1e-7) return -100;
  return 20 * Math.log10(rms);
}

/**
 * 简单 VAD：能量 + 过零率 + 包络调制度。
 * 用来跳过纯静音/纯噪声的窗口 —— 这能显著省电（不用唤醒识别）也省 API 钱（不用上传）。
 *
 * @param {Float32Array} float32  建议喂 0.5~2 秒的窗口
 * @param {object} opts
 *   rate  采样率，默认 16000。**下面所有过零率门限都是按 16kHz 写的**，
 *     传了 rate 会自动换算。不传而实际是 48k，低音男声会被 zcrMin 误杀
 *     （同一段人声 16k 下 zcr≈0.017，48k 下只有 0.010，门限却没跟着变）。
 *   rmsDbMin  能量门限，默认 -50dB。远场信号弱，门限不能设太高。
 *   zcrMin/zcrMax  过零率区间（16kHz 基准），默认 0.010~0.38。
 *     —— 空调隆隆声几乎不过零，宽带嘶声/风噪过零率很高，
 *        语音（浊音低 + 擦音高）混在一起落在中间。
 *        这一项只负责「别误杀」，真正分辨噪声靠下面的调制度。
 *   modMin  包络调制度，默认 1.6。
 *     —— 这是远场 VAD 最管用的一招：人说话有音节间隙，短时能量包络一定有起伏；
 *        稳态的人群嗡嗡声、风扇声、嘶声包络很平。混响也压不掉这个起伏。
 *   modOff  设 true 关掉调制度判据（窗口 <0.2s 时会自动跳过，一般不用手动关）
 * @returns {boolean}
 *
 * 调制度的定义：把窗口切成**固定 32ms** 的子帧，算每帧 RMS，取 p90/p10。
 * 早先用的是「固定切 12 段，取 max/mean」，那个写法有个致命缺陷：
 * 子帧时长会随窗口变长而变长，窗口一长子帧就跨过整个音节周期，起伏被平均掉，
 * 比值迅速塌向 1。实测 1 秒窗口还有 1.75，2 秒掉到 1.22，3 秒只剩 1.01，
 * 全都低于当时 1.35 的门限 —— 也就是说**超过 1 秒的真人讲话会被整段丢掉**，
 * 语速快一点（6Hz 音节率）连 1 秒窗口都过不了。改成定长子帧 + 分位数之后，
 * 各类噪声落在 1.05~1.27，各种语速/混响/长度的语音落在 13~30，余量极大。
 */
export function detectSpeech(float32, opts = {}) {
  const n = float32 ? float32.length : 0;
  if (n < 64) return false;

  const rate = opts.rate > 0 ? opts.rate : 16000;
  const k = 16000 / rate;                 // 过零率门限从 16kHz 基准换算到实际采样率
  const rmsDbMin = opts.rmsDbMin == null ? -50 : opts.rmsDbMin;
  const zcrMin = (opts.zcrMin == null ? 0.010 : opts.zcrMin) * k;
  const zcrMax = (opts.zcrMax == null ? 0.38 : opts.zcrMax) * k;
  const modMin = opts.modMin == null ? 1.6 : opts.modMin;

  // 1) 能量
  let sum = 0;
  for (let i = 0; i < n; i++) sum += float32[i] * float32[i];
  const rms = Math.sqrt(sum / n);
  const db = rms < 1e-7 ? -100 : 20 * Math.log10(rms);
  if (db < rmsDbMin) return false;

  // 2) 过零率。加一个 rms*0.08 的死区，免得贴着零线的底噪被算成一堆过零。
  const dead = rms * 0.08;
  let zc = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const x = float32[i];
    const s = x > dead ? 1 : x < -dead ? -1 : 0;
    if (s !== 0) { if (prev !== 0 && s !== prev) zc++; prev = s; }
  }
  const zcr = zc / n;
  if (zcr < zcrMin || zcr > zcrMax) return false;

  // 3) 包络调制度：定长 32ms 子帧的 RMS，取 p90/p10
  if (!opts.modOff) {
    const step = Math.max(64, Math.round(rate * 0.032));
    const cnt = Math.floor(n / step);
    if (cnt >= 6) {                       // 少于 6 个子帧统计不可靠，直接跳过这一项
      const e = new Float64Array(cnt);
      for (let b = 0; b < cnt; b++) {
        let s2 = 0;
        const from = b * step, to = from + step;
        for (let i = from; i < to; i++) s2 += float32[i] * float32[i];
        e[b] = Math.sqrt(s2 / step);
      }
      e.sort();                           // TypedArray.sort 默认就是数值升序
      const q = p => e[Math.min(cnt - 1, Math.max(0, Math.round(p * (cnt - 1))))];
      const hi = q(0.90), lo = q(0.10);
      // lo 夹一个下限，避免整段近似静音时除出 Infinity
      if (hi > 1e-9 && hi / Math.max(lo, hi * 1e-4) < modMin) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 七、小工具
// ---------------------------------------------------------------------------

/** 把若干段 Float32Array 拼成一段（攒够一个转写窗口时用）。空值/空列表返回空数组。 */
export function concatPCM(list) {
  if (!list || !list.length) return new Float32Array(0);
  let n = 0;
  for (const a of list) if (a) n += a.length;
  const out = new Float32Array(n);
  let w = 0;
  for (const a of list) { if (a) { out.set(a, w); w += a.length; } }
  return out;
}

/** 便捷组合：Float32(16k) → 16k 单声道 WAV Blob，可选先归一化。 */
export function pcmToWavBlob(float32, { normalizeFirst = true, targetPeak = 0.95, sampleRate = 16000 } = {}) {
  return encodeWAV(normalizeFirst ? normalize(float32, targetPeak) : float32, sampleRate);
}
