// whisper.js —— 浏览器内本地 Whisper 语音识别引擎
//
// 为什么需要它：
//   大阶梯教室里老师在 50m 外用 PA 扩音器讲课，麦克风收到的是「远场 + 混响 + 扩音器失真」
//   的信号。浏览器自带的 Web Speech API（走 Google 云端）在这种信噪比下基本废掉，而且
//   Electron 的 Chromium 根本没有 Web Speech。Whisper 这类端到端模型对远场语音鲁棒得多，
//   而且完全本地跑：离线、免费、不上传课堂录音。
//
// 依赖：@huggingface/transformers 4.3.0（已 vendor 到 web/vendor/transformers/）
//   - 库本身 100% 本地，不联网
//   - 只有「模型权重」第一次需要从 Hugging Face 下载，之后由浏览器 Cache Storage 缓存
//
// 纯 ES Module，无构建步骤，可被 <script type="module"> 直接 import。

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

// vendor 目录相对于本文件（web/js/whisper.js -> web/vendor/transformers/）
const LIB_URL = new URL('../vendor/transformers/transformers.min.js', import.meta.url).href
const ORT_DIR = new URL('../vendor/transformers/ort/', import.meta.url).href

// 必须和 @huggingface/transformers@4.3.0 锁定的 onnxruntime-web 版本一致，
// 见 node_modules/@huggingface/transformers/package.json 的 dependencies。
// 只有本地没放 .wasm 时才用得上（走 jsDelivr）。
const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0'
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`

const SAMPLE_RATE = 16000

// ---------------------------------------------------------------------------
// 模型清单
// ---------------------------------------------------------------------------
// id 都是 huggingface.co/onnx-community 下**实际存在**的 ONNX 仓库（2026-09 用
// https://huggingface.co/api/models/onnx-community/<name> 逐个验证过，均返回 200）。
// sizeMB 是「按下面 dtypes 选中的那组 .onnx 文件」的实际下载体积（同样来自 HF 的
// tree API，四舍五入到整数），不是仓库总大小 —— 仓库里各种精度加起来要大得多。
//
// dtypes 按 device 分三档：
//   webgpu       —— 支持 shader-f16 的 WebGPU（Apple 芯片、独显基本都支持）
//   webgpuNoFp16 —— 有 WebGPU 但不支持 fp16，只能退回整数量化
//   wasm         —— 没有 WebGPU，CPU 跑；wasm 后端不支持 fp16，只能 fp32 / q8
// key 是 ONNX 文件名（encoder_model / decoder_model_merged），这是 transformers 4.3.0
// ⚠️ 实测确认：dtype 表是按 **文件名** 查的，encoder 的键就是 'encoder_model'
//    （写成 'model' 会被忽略，encoder 静默退回 fp32，白下 280MB 还慢）。
//    也可以直接传一个字符串（如 dtype: 'fp16'）让所有 session 用同一精度。
export const WHISPER_MODELS = [
  {
    id: 'onnx-community/whisper-base',
    label: '基础版（快）',
    sizeMB: 142,
    quality: '一般',
    note: '老机器 / 没有独显时用。安静的小教室够用，远场扩音会丢词。',
    // ⚠️ 实测教训：q8(int8) 权重在 ORT 的 WebGPU 后端上会卡死（缺 int8 算子，
    //    图分区时会挂住主线程）。所以 WebGPU 必须用 fp16 / q4，只有 WASM 才用 q8。
    dtypes: {
      webgpu: { encoder_model: 'fp16', decoder_model_merged: 'fp16' },
      webgpuNoFp16: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' }
    },
    // wasm 档实际体积比 webgpu 档小/大都有可能，这里给个粗略值供 UI 提示
    sizeMBByDevice: { webgpu: 142, webgpuNoFp16: 280, wasm: 76 }
  },
  {
    id: 'onnx-community/whisper-small',
    label: '标准版（准）',
    sizeMB: 288,
    quality: '好',
    note: '大阶梯教室 + 扩音器的推荐档。M 系列芯片实时跑得动。',
    // 同上：WebGPU 走 fp16 编码器 + q4 解码器，WASM 才用 q8
    dtypes: {
      // small 全档统一 q4：fp16 的 encoder 有 465MB，塞进安装包不值得，
      // 而 q4 在远场场景实测和 fp16 差别很小。
      webgpu: { encoder_model: 'q4', decoder_model_merged: 'q4' },
      webgpuNoFp16: { encoder_model: 'q4', decoder_model_merged: 'q4' },
      wasm: { encoder_model: 'q4', decoder_model_merged: 'q4' }
    },
    sizeMBByDevice: { webgpu: 288, webgpuNoFp16: 288, wasm: 288 }
  },
  {
    id: 'onnx-community/whisper-large-v3-turbo',
    label: '最准（需独显 / M 系列芯片）',
    sizeMB: 537,
    quality: '最好',
    note: '远场、口音、专业术语都最稳。首次下载 500MB+，务必连校园 WiFi 下好再进教室。',
    dtypes: {
      // 这个仓库的 encoder fp16 有 1.2GB，太大了；q4f16 只要 353MB 且质量掉得很少
      webgpu: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' },
      webgpuNoFp16: { encoder_model: 'q4', decoder_model_merged: 'q4' },
      // CPU 上跑 turbo 基本不可能实时，这里只是为了「能跑」而不是「能用」
      wasm: { encoder_model: 'q4', decoder_model_merged: 'q4' }
    },
    sizeMBByDevice: { webgpu: 537, webgpuNoFp16: 724, wasm: 724 }
  }
]

// 回退表：万一某个仓库将来被删/改名，UI 可以拿这里的替代品顶上。
// Xenova/* 是 transformers.js 作者的旧镜像，结构和 onnx-community 一致。
export const WHISPER_MODEL_FALLBACKS = {
  'onnx-community/whisper-base': 'Xenova/whisper-base',
  'onnx-community/whisper-small': 'Xenova/whisper-small',
  'onnx-community/whisper-large-v3-turbo': 'onnx-community/whisper-small'
}

// ---------------------------------------------------------------------------
// 运行时配置（懒加载 transformers）
// ---------------------------------------------------------------------------

let _runtime = null
// 初始化后为 true 表示 ORT 的 WASM 是从 web/vendor 本地加载的（而不是 jsDelivr）
let _ortLocal = false
let _runtimeOpts = {
  // 换成 'https://hf-mirror.com/' 可以走国内镜像（结尾必须有斜杠）
  remoteHost: 'https://huggingface.co/',
  cacheKey: 'transformers-cache',
  // wasm 线程数：线程越多越快也越费电。默认砍到一半核心，最多 4 个。
  // 只有页面处于 cross-origin isolated 状态时多线程才真的生效，否则 ORT 自己退回 1。
  numThreads: null
}

// 在 load() 之前调用才有意义。用于换 HF 镜像、调线程数（省电）。
export function configureRuntime (patch) {
  if (_runtime) throw new Error('Whisper 运行时已经初始化，configureRuntime 必须在 load() 之前调用')
  _runtimeOpts = { ..._runtimeOpts, ...patch }
}

// 诊断用：ORT 的 WASM 是不是从本地 vendor 目录加载的。load() 之后才有意义。
export function ortIsLocal () {
  return _ortLocal
}

// 复刻 transformers 4.3.0 env.js 里的 isSafariBelow26()。
// 它决定用哪个 ort wasm 变体：Safari 26 以下且没有 WebGPU 时不能用 asyncify 版本。
function isSafariBelow26 () {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const isSafari =
    (navigator.vendor || '').indexOf('Apple') > -1 &&
    !ua.match(/CriOS|FxiOS|EdgiOS|OPiOS|mercury|brave/i) &&
    !ua.includes('Chrome') &&
    !ua.includes('Android')
  if (!isSafari) return false
  const m = ua.match(/Version\/(\d+)/)
  return m ? parseInt(m[1], 10) < 26 : false
}

// 探测某个 URL 是否真的存在（HEAD 请求）。file:// 下会抛异常，当作不存在。
async function exists (url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'force-cache' })
    return res.ok
  } catch (_) {
    return false
  }
}

// 决定 ORT 去哪里加载 WASM 工厂(.mjs)和二进制(.wasm)。
//
// ⚠️ 这里**必须**显式设置，不能指望 transformers 的默认值：
// 它在 src/backends/onnx.js 里是 `if (ONNX_ENV.versions?.web && !wasmPaths) { ...jsDelivr... }`，
// 但 dist/transformers.min.js 这个打包产物里 `env.versions.web` 根本没被赋值
// （在 bundle 里 grep `versions.web=` 是 0 个命中，只有两处读取）。
// 所以那段默认逻辑是死代码，wasmPaths 会一直是 undefined，ORT 转而按自己的
// import.meta.url 去找文件 —— 也就是 web/vendor/transformers/ 而不是它的 ort/ 子目录，
// 必然 404。
//
// 顺带一提：wasmPaths 是个含 wasm + mjs 两个键的对象，正是 env.useWasmCache 预加载
// 生效的前提（见 src/backends/utils/cacheWasm.js），所以显式设置之后
// WASM 也会被存进 Cache Storage，第二次开课完全离线。
//
// 优先本地；本地没有就回退到 jsDelivr（版本号写死，和库锁定的版本对齐）。
async function resolveOrtPaths (hasWebGPU) {
  // 变体选择逻辑抄自 transformers 4.3.0 src/backends/onnx.js
  const suffix = isSafariBelow26() && !hasWebGPU ? '' : '.asyncify'
  const name = `ort-wasm-simd-threaded${suffix}`
  const wasm = `${ORT_DIR}${name}.wasm`
  const mjs = `${ORT_DIR}${name}.mjs`
  const [okWasm, okMjs] = await Promise.all([exists(wasm), exists(mjs)])
  if (okWasm && okMjs) return { wasm, mjs, local: true }
  return { wasm: `${ORT_CDN}${name}.wasm`, mjs: `${ORT_CDN}${name}.mjs`, local: false }
}

async function getRuntime () {
  if (_runtime) return _runtime
  _runtime = (async () => {
    const mod = await import(/* @vite-ignore */ LIB_URL)
    const { pipeline, env } = mod

    // 模型权重：只从远端仓库拉，不去猜本地 /models/ 路径（浏览器里默认就是 false，
    // 这里显式写出来，免得 Electron 环境探测出错时跑去请求 file:///models/...）
    // 本地优先：web/models/ 下有就直接用（完全离线），没有再去远端下载。

    // 注意 localModelPath 必须是「路径」而不是完整 URL —— transformers 的 buildResourcePaths

    // 里会用 isValidUrl(localPath, ['http:','https:']) 判断，传完整 URL 会直接跳过本地分支。

    env.allowLocalModels = true;

    try { env.localModelPath = new URL('../models/', import.meta.url).pathname; } catch (_) { env.localModelPath = '/models/'; }
    env.allowRemoteModels = true
    env.remoteHost = _runtimeOpts.remoteHost
    env.remotePathTemplate = '{model}/resolve/{revision}/'

    // 权重和 ort wasm 都进浏览器 Cache Storage —— 第二次开课就完全离线了
    env.useBrowserCache = true
    env.useWasmCache = true
    env.cacheKey = _runtimeOpts.cacheKey

    const wasmEnv = env.backends?.onnx?.wasm
    if (wasmEnv) {
      const hasWebGPU = await webgpuAvailable()
      const paths = await resolveOrtPaths(hasWebGPU)
      wasmEnv.wasmPaths = { wasm: paths.wasm, mjs: paths.mjs }
      _ortLocal = paths.local

      // 省电：默认砍掉一半 CPU 核心
      const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
      const isolated = typeof globalThis.crossOriginIsolated !== 'undefined' && globalThis.crossOriginIsolated
      wasmEnv.numThreads = _runtimeOpts.numThreads != null
        ? _runtimeOpts.numThreads
        : (isolated ? Math.min(4, Math.max(1, Math.floor(cores / 2))) : 1)
    }

    return { pipeline, env }
  })()
  return _runtime
}

// ---------------------------------------------------------------------------
// 设备能力探测
// ---------------------------------------------------------------------------

let _gpuProbe = null

// 拿一次 adapter 就缓存住，反复 requestAdapter() 很贵
async function probeGPU () {
  if (_gpuProbe) return _gpuProbe
  _gpuProbe = (async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu) return { ok: false }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) return { ok: false }
      return {
        ok: true,
        fp16: !!(adapter.features && adapter.features.has('shader-f16')),
        info: adapter.info || {},
        maxBufferSize: adapter.limits?.maxBufferSize || 0,
        maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize || 0
      }
    } catch (_) {
      return { ok: false }
    }
  })()
  return _gpuProbe
}

export async function webgpuAvailable () {
  return (await probeGPU()).ok
}

// 粗略判断这台机器适合哪个模型，返回 WHISPER_MODELS 里的一个 id。
// 不跑真实 benchmark（那要先下模型，本末倒置），只看硬件特征：
//   - 没有 WebGPU  -> base（CPU 上 small 都很勉强）
//   - 有 WebGPU 但显存/内存小 -> base 或 small
//   - Apple 芯片 / 独显 + 内存充足 -> large-v3-turbo
export async function estimateSpeed () {
  const gpu = await probeGPU()
  const BASE = 'onnx-community/whisper-base'
  const SMALL = 'onnx-community/whisper-small'
  const TURBO = 'onnx-community/whisper-large-v3-turbo'

  if (!gpu.ok) return BASE

  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
  // deviceMemory 只有 Chromium 系有，Safari 返回 undefined，按 8GB 保守估
  const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8
  const vendor = String(gpu.info.vendor || '').toLowerCase()
  const arch = String(gpu.info.architecture || '').toLowerCase()

  const isApple = vendor.includes('apple') || arch.includes('apple') || arch.includes('metal')
  const isDiscrete = vendor.includes('nvidia') || vendor.includes('amd') || arch.includes('rdna') || arch.includes('ampere') || arch.includes('ada')
  // turbo 的单个权重文件 350MB+，maxBufferSize 太小的核显直接放弃
  const bigBuffers = gpu.maxStorageBufferBindingSize >= 1 << 30

  if (gpu.fp16 && (isApple || isDiscrete) && mem >= 8 && cores >= 8 && bigBuffers) return TURBO
  if (gpu.fp16 && mem >= 8) return SMALL
  if (mem >= 8 && cores >= 8) return SMALL
  return BASE
}

function findModel (id) {
  return WHISPER_MODELS.find((m) => m.id === id) || null
}

// 根据探测到的设备挑 dtype。未知模型给一组保守默认值。
function pickDtype (modelId, device, fp16) {
  const entry = findModel(modelId)
  const key = device === 'webgpu' ? (fp16 ? 'webgpu' : 'webgpuNoFp16') : 'wasm'
  if (entry && entry.dtypes && entry.dtypes[key]) return entry.dtypes[key]
  if (device === 'webgpu') {
    return fp16
      ? { encoder_model: 'fp16', decoder_model_merged: 'q4' }
      : { encoder_model: 'q4', decoder_model_merged: 'q4' }
  }
  return { encoder_model: 'q8', decoder_model_merged: 'q8' }
}

// ---------------------------------------------------------------------------
// LocalWhisper —— 一次性转写整段音频
// ---------------------------------------------------------------------------

export class LocalWhisper {
  // model     : WHISPER_MODELS 里的 id，默认 whisper-base
  // language  : Whisper 语言标记，'en' / 'zh' / 'english' 都行；null = 自动检测
  // onProgress: ({ pct, loadedMB, totalMB, file }) => void  下载进度
  // onStatus  : (status, detail) => void  'downloading' | 'loading' | 'ready' | 'error'
  constructor ({ model, language, onProgress, onStatus, device } = {}) {
    // device: 'auto'（默认，先试 WebGPU）| 'webgpu' | 'wasm'
    // 实测教训：某些机器上 ORT 的 WebGPU 后端编译 Whisper 的 shader 要两分钟以上，
    // 上课根本等不起。所以 app.js 默认传 'wasm'，用户想试 GPU 再手动开。
    this.forceDevice = device || 'auto'
    this.modelId = model || 'onnx-community/whisper-base'
    this.language = language || null
    this.onProgress = typeof onProgress === 'function' ? onProgress : null
    this.onStatus = typeof onStatus === 'function' ? onStatus : null

    this.device = null      // 实际用上的后端：'webgpu' | 'wasm'
    this.dtype = null       // 实际用上的精度
    this.ready = false

    this._pipe = null
    this._loading = null
    this._closed = false
    // 同一时刻只跑一个推理
    this._queue = Promise.resolve()
    this._warnedPrompt = false
  }

  _status (s, detail) {
    if (this.onStatus) {
      try { this.onStatus(s, detail) } catch (_) {}
    }
  }

  // 幂等：重复调用返回同一个 promise
  async load () {
    // close() 之后再 load() 会把模型整个重新下载 + 重新编译一遍，跑完才发现
    // this._closed 然后 dispose 掉 —— 白白烧几十秒 CPU/GPU 和几百 MB 流量。直接拦掉。
    if (this._closed) throw new Error('引擎已关闭')
    if (this._pipe) return this._pipe
    if (this._loading) return this._loading

    this._loading = (async () => {
      try {
        const { pipeline } = await getRuntime()
        const gpu = await probeGPU()

        // 下载进度：transformers 会发 'progress_total' 事件，里面是所有文件的合计字节数，
        // 正好可以直接当总进度用，不用自己按文件累加。
        let sawDownload = false
        let finished = false
        let lastPct = -1
        const progress_callback = (info) => {
          if (this._closed) return
          if (info.status === 'initiate' || info.status === 'download') {
            if (!sawDownload) {
              sawDownload = true
              this._status('downloading', { model: this.modelId, pct: 0 })
            }
          } else if (info.status === 'progress_total') {
            const pct = Math.max(0, Math.min(100, info.progress || 0))
            const loadedMB = +((info.loaded || 0) / 1048576).toFixed(1)
            const totalMB = +((info.total || 0) / 1048576).toFixed(1)
            // 百分比也放进 status 的 detail：StreamingWhisper 只有 onStatus 一条回调，
            // 没有这个的话「下载 391MB 模型」这十几分钟界面上只能干写「下载中…」。
            // 每涨 1% 报一次，不刷屏。
            if (!sawDownload || pct - lastPct >= 1) {
              sawDownload = true
              lastPct = pct
              this._status('downloading', { model: this.modelId, pct, loadedMB, totalMB })
            }
            if (this.onProgress) {
              try {
                this.onProgress({ pct, loadedMB, totalMB, file: null })
              } catch (_) {}
            }
            if (!finished && (info.progress || 0) >= 99.9) {
              finished = true
              // 权重下完了，接下来是建 ONNX session（WebGPU 编译 shader 要几秒，且不发事件）
              this._status('loading', { model: this.modelId })
            }
          } else if (info.status === 'progress' && this.onProgress && !sawDownload) {
            // 理论上 progress_total 一定会来，这里只是兜底
            try {
              this.onProgress({
                pct: Math.max(0, Math.min(100, info.progress || 0)),
                loadedMB: +((info.loaded || 0) / 1048576).toFixed(1),
                totalMB: +((info.total || 0) / 1048576).toFixed(1),
                file: info.file || null
              })
            } catch (_) {}
          }
        }

        const build = async (device) => {
          const dtype = pickDtype(this.modelId, device, gpu.fp16)
          const pipe = await pipeline('automatic-speech-recognition', this.modelId, {
            device,
            dtype,
            progress_callback
          })
          this.device = device
          this.dtype = dtype
          return pipe
        }

        // 模型已经在 Cache Storage 里时一个下载事件都不会发，如果这里不先报一次，
        // WebGPU 编译 shader 的那十几秒界面上就是完全静默的（用户以为卡死了）。
        this._status('loading', { model: this.modelId })

        // 优先 WebGPU（快 5-10 倍，而且 GPU 定点算比 CPU 满载省电），失败自动退回 wasm
        let pipe = null
        const wantGPU = this.forceDevice === 'webgpu' || (this.forceDevice === 'auto' && gpu.ok)
        if (wantGPU) {
          try {
            // 给 WebGPU 45 秒。ORT 在有些机器上编译 shader 会卡好几分钟，
            // 与其干等，不如退回 CPU —— CPU 慢但一定能出字。
            pipe = await Promise.race([
              build('webgpu'),
              new Promise((_, rej) => setTimeout(() => rej(new Error('WebGPU 初始化超过 45 秒')), 45000))
            ])
          } catch (err) {
            console.warn('[whisper] WebGPU 不可用或太慢，退回 CPU(wasm)：', err)
            this._status('loading', { model: this.modelId, fallback: 'wasm' })
            pipe = null
          }
        }
        if (!pipe) {
          this._status('loading', { model: this.modelId })
          pipe = await build('wasm')
        }

        if (this._closed) {
          try { await pipe.dispose() } catch (_) {}
          throw new Error('引擎已关闭')
        }

        this._pipe = pipe
        this.ready = true
        this._status('ready', { model: this.modelId, device: this.device, dtype: this.dtype })
        return pipe
      } catch (err) {
        this._loading = null
        this.ready = false
        this._status('error', { model: this.modelId, message: String(err && err.message || err) })
        throw err
      }
    })()

    return this._loading
  }

  // float32At16k: Float32Array，16kHz 单声道，取值 [-1, 1]
  // options.language : 覆盖构造时的语言
  // options.prompt   : ⚠️ transformers.js 4.3.0 的 WhisperForConditionalGeneration.generate()
  //                    里 prompt_ids 是被注释掉的（见 src/models/whisper/modeling_whisper.js
  //                    第 110 行），传进去不会生效。保留这个参数是为了接口稳定，
  //                    将来上游实现了直接接上即可。
  // options.timestamps: 是否要 chunks 级时间戳。true 会走 _generate_with_seek，慢不少也费电，
  //                    流式识别用不上，所以 StreamingWhisper 内部传 false。
  // 返回 { text, chunks }
  async transcribe (float32At16k, options = {}) {
    if (!(float32At16k instanceof Float32Array)) {
      throw new TypeError('transcribe() 需要 Float32Array（16kHz 单声道 PCM）')
    }
    if (options.prompt && !this._warnedPrompt) {
      this._warnedPrompt = true
      console.warn('[whisper] transformers.js 4.3.0 尚未实现 Whisper prompt_ids，prompt 参数被忽略')
    }

    const pipe = await this.load()
    const language = options.language !== undefined ? options.language : this.language
    const timestamps = options.timestamps !== false

    // 串行化：ONNX session 不能并发 run，transformers 内部虽然也排队，
    // 但在这里排队能让调用方 await 到真正属于自己的那次结果。
    const run = async () => {
      if (float32At16k.length === 0) return { text: '', chunks: [] }
      const opts = {
        return_timestamps: timestamps,
        // Whisper 一次最多吃 30s；超长音频交给 pipeline 自己切窗 + 拼接
        chunk_length_s: 30,
        stride_length_s: 5
      }
      // ⚠️ language / task 只在「有语言 且 不是纯英文模型」时才传。
      // transformers 4.3.0 的 _retrieve_init_tokens()（src/models/whisper/modeling_whisper.js）
      // 对 is_multilingual=false 的模型（whisper-base.en / small.en 这类）只要收到
      // language 或 task 就直接抛 'Cannot specify `task` or `language` for an English-only model'。
      // 多语言模型下不传 task 也默认就是 transcribe（上游写的是 `task ?? 'transcribe'`），
      // 所以省掉它没有副作用。
      const englishOnly = /\.en$/i.test(this.modelId)
      if (language && !englishOnly) {
        opts.language = language
        opts.task = 'transcribe'
      }
      const out = await pipe(float32At16k, opts)
      return {
        text: (out && out.text ? String(out.text) : '').trim(),
        chunks: (out && out.chunks) || []
      }
    }

    this._queue = this._queue.then(run, run)
    return this._queue
  }

  async close () {
    this._closed = true
    this.ready = false
    const pipe = this._pipe
    this._pipe = null
    this._loading = null
    if (pipe) {
      try { await pipe.dispose() } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------------------
// 分词 + 重叠去重拼接
// ---------------------------------------------------------------------------
//
// 这是整个流式识别里最容易写错的地方，单独说明一下。
//
// 【问题】
// 相邻两个窗口共享 overlapSec 秒音频（不重叠会把边界上的词切碎，识别质量塌掉）。
// 于是上一窗口结尾那几秒的文字，会在这一窗口开头又被识别一遍。不处理的话，
// 每 22 秒就会重复一句话。
//
// 【算法】词级别的「最长公共后缀 / 前缀」匹配
//   1. 把上一窗口的文字和这一窗口的文字都切成词（CJK 按字切，拉丁按空格切）。
//   2. 只在重叠区可能覆盖的范围内找：maxK ≈ overlapSec × 8 个词。
//      不设上限的话，遇到「同一句话讲两遍」这种真实重复会被误删。
//   3. 从 k = maxK 往下数到 1，检查 prev 的最后 k 个词是否 **逐个等于** cur 的前 k 个词。
//      第一个命中的 k 就是最长公共后缀/前缀长度 —— 从长往短找保证了「最长」。
//   4. 精确匹配失败时做一次模糊匹配：同样从长往短扫，统计逐位相等的比例，
//      ≥70% 且 k ≥ 3 就认；取得分最高的 k。这是必要的，因为两个窗口的声学上下文
//      不同，Whisper 对同一段音频可能给出 "fifty meters" / "50 meters" 这种差异。
//   5. 输出 cur 从第 k 个词开始的部分。
//
// 【为什么按「词」不按「字符」】
// 字符级 LCS 会在 "the" / "there" 这种地方切在词中间，拼出半个单词。
//
// 【比较用的规范化】
// 小写化 + 去掉首尾标点。标点在两次识别里极不稳定（这次有逗号下次没有），
// 参与比较只会让匹配失败。但输出时用的是**原始字符串的切片**，标点、空格
// 原样保留 —— 所以 token 里存的是在原串中的起始下标，而不是词本身。

const TOKEN_RE = /[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ'’-]*|[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]|[^\s]/g

// 返回 [{ n: 规范化后的词, start: 在原串中的起始下标 }]，纯标点的 token 会被丢掉
function tokenize (text) {
  const out = []
  if (!text) return out
  TOKEN_RE.lastIndex = 0
  let m
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const raw = m[0]
    const n = raw.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (!n) continue
    out.push({ n, start: m.index })
  }
  return out
}

// 找 prev 的后缀和 cur 的前缀的最长匹配长度（以词为单位）。找不到返回 0。
// 导出出来是为了能单测；主协调者不用管。
export function overlapJoinLength (prev, cur, maxK) {
  const limit = Math.min(maxK, prev.length, cur.length)
  if (limit <= 0) return 0

  // 第一轮：精确匹配，从长往短，第一个命中就是最长的
  let exactK = 0
  for (let k = limit; k >= 1; k--) {
    let ok = true
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i].n !== cur[i].n) { ok = false; break }
    }
    if (ok) { exactK = k; break }
  }

  // 第二轮：模糊匹配，容忍个别词识别不一致。
  // ⚠️ 这一轮**不能**只在精确匹配落空时才跑：精确匹配很容易在 k=1/2 上撞到巧合
  //（两个窗口边界上碰巧都有个 "the"、"的"），一旦提前 return，真正长得多的重叠
  // 就没人去重了，笔记里每个窗口边界都会多出几个重复的词。所以两轮都跑，取更长的。
  let bestK = 0
  let bestScore = 0
  for (let k = limit; k >= 3; k--) {
    if (k <= exactK) break   // 从长往短扫，到这里后面只会更短，没意义了
    let hit = 0
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i].n === cur[i].n) hit++
    }
    const score = hit / k
    if (score >= 0.7 && score > bestScore) {
      bestScore = score
      bestK = k
    }
  }
  return Math.max(exactK, bestK)
}

// ---------------------------------------------------------------------------
// StreamingWhisper —— 边录边识别
// ---------------------------------------------------------------------------

export class StreamingWhisper {
  // model      : 同 LocalWhisper
  // language   : 同 LocalWhisper
  // windowSec  : 每次送进模型的音频长度，默认 25s（Whisper 上限 30s，留点余量）
  // overlapSec : 相邻窗口的重叠，默认 3s
  // onPartial  : (rawText) => void   —— 本窗口识别出的**原始**文字，含与上一窗口重复的部分，
  //                                     适合拿去刷「正在识别…」的灰色预览
  // onFinal    : (text, startMs, endMs) => void —— 去重后已确定的文字，直接往笔记里写
  // onStatus   : (status, detail) => void
  //              'downloading' | 'loading' | 'ready' | 'running' | 'lagging' | 'stopped' | 'error'
  // onProgress : ({ pct, loadedMB, totalMB, file }) => void —— 模型下载进度，
  //              和 LocalWhisper 的同名回调一样；不传的话 onStatus('downloading', detail)
  //              的 detail 里也有 pct / loadedMB / totalMB。
  constructor ({ model, language, windowSec = 25, overlapSec = 3, onPartial, onFinal, onStatus, onProgress, device } = {}) {
    if (!(overlapSec > 0) || overlapSec >= windowSec) {
      throw new Error('overlapSec 必须大于 0 且小于 windowSec')
    }
    this.windowSec = windowSec
    this.overlapSec = overlapSec
    this.onPartial = typeof onPartial === 'function' ? onPartial : null
    this.onFinal = typeof onFinal === 'function' ? onFinal : null
    this.onStatus = typeof onStatus === 'function' ? onStatus : null
    this.onProgress = typeof onProgress === 'function' ? onProgress : null

    this._engine = new LocalWhisper({
      device,
      model,
      language,
      onProgress: this.onProgress,
      onStatus: (s, d) => this._status(s, d)
    })

    this._winSamples = Math.round(windowSec * SAMPLE_RATE)
    this._stepSamples = Math.round((windowSec - overlapSec) * SAMPLE_RATE)
    this._overlapSamples = this._winSamples - this._stepSamples
    // 重叠区最多能覆盖多少个词。8 词/秒对中文（按字算）和英文都够宽松。
    this._maxOverlapTokens = Math.max(8, Math.ceil(overlapSec * 8))
    // 积压超过这么多样本就认为跟不上了，丢最旧的
    this._lagLimit = this._stepSamples * 2
    // flush 时短于这个长度的尾巴直接丢（0.4s 以内基本是噪声）
    this._minTail = Math.round(0.4 * SAMPLE_RATE)

    // 环形缓冲：_buf[0] 对应绝对样本号 _base，有效长度 _len，已消费到 _cursor
    this._cap = this._winSamples * 3
    this._buf = new Float32Array(this._cap)
    this._len = 0
    this._base = 0
    this._cursor = 0

    this._running = false
    this._busy = false
    this._task = Promise.resolve()
    this._prevTokens = []
    // 因为丢帧造成时间轴不连续时置位：下一窗口不做去重
    this._discontinuous = false
    // 已经 onFinal 出去的最晚时间点，用来保证时间轴单调不回退
    this._lastEndMs = 0
  }

  get device () { return this._engine.device }
  get ready () { return this._engine.ready }

  _status (s, detail) {
    if (this.onStatus) {
      try { this.onStatus(s, detail) } catch (_) {}
    }
  }

  // 下载 + 加载模型。必须在 push() 之前 await。
  async start () {
    if (this._running) return
    await this._engine.load()
    this._running = true
    this._status('running', { device: this._engine.device })
  }

  // float32At16k: Float32Array，16kHz 单声道。内部会拷贝，调用方可以复用同一个缓冲区。
  push (float32At16k) {
    if (!this._running) return
    if (!float32At16k || float32At16k.length === 0) return
    this._append(float32At16k)
    this._pump()
  }

  _append (chunk) {
    let data = chunk
    let n = data.length

    // 一次送进来的音频比整个环形缓冲（windowSec×3，默认 75s）还长。
    // 不先处理的话，下面的 drop 会算出比 _len 还大的值，_len 变成负数，
    // 最后 _buf.set(chunk, 负数) 直接抛 RangeError —— 而且是从同步的 push() 里抛出去。
    // 这种情况只保留最后 _cap 个样本，前面的连同缓冲里没来得及处理的一起丢掉。
    if (n > this._cap) {
      const skip = n - this._cap
      const newBase = this._base + this._len + skip
      const dropped = Math.max(0, newBase - this._cursor)
      data = data.subarray(skip)
      n = data.length
      this._base = newBase
      this._len = 0
      if (this._cursor < newBase) {
        this._cursor = newBase
        this._discontinuous = true
        this._prevTokens = []
        this._status('lagging', { droppedSec: +(dropped / SAMPLE_RATE).toFixed(1), reason: 'buffer-full' })
      }
    }

    if (this._len + n > this._cap) {
      // 先回收游标之前已经消费掉的样本
      const consumed = Math.max(0, Math.min(this._cursor - this._base, this._len))
      if (consumed > 0) {
        this._buf.copyWithin(0, consumed, this._len)
        this._len -= consumed
        this._base += consumed
      }
    }

    if (this._len + n > this._cap) {
      // 还是放不下 —— 说明推理严重跟不上，丢掉最旧的未处理音频
      const drop = this._len + n - this._cap
      this._buf.copyWithin(0, drop, this._len)
      this._len -= drop
      this._base += drop
      if (this._cursor < this._base) {
        this._cursor = this._base
        this._discontinuous = true
        this._prevTokens = []
        this._status('lagging', { droppedSec: +(drop / SAMPLE_RATE).toFixed(1), reason: 'buffer-full' })
      }
    }

    this._buf.set(data, this._len)
    this._len += n
  }

  // 取绝对区间 [from, from+count) 的拷贝
  _slice (from, count) {
    const off = from - this._base
    return this._buf.slice(off, off + count)
  }

  _pump () {
    if (this._busy || !this._running) return
    const end = this._base + this._len
    let avail = end - this._cursor
    if (avail < this._winSamples) return

    // 积压太多：直接把游标跳到「最新的一个整窗」的起点，丢掉中间的音频。
    // 这样界面永远跟着老师当前讲的内容走，而不是越落越远。
    if (avail > this._winSamples + this._lagLimit) {
      const newCursor = end - this._winSamples
      const dropped = newCursor - this._cursor
      this._cursor = newCursor
      this._discontinuous = true
      this._prevTokens = []
      avail = this._winSamples
      this._status('lagging', { droppedSec: +(dropped / SAMPLE_RATE).toFixed(1), reason: 'slow-inference' })
    }

    const wStart = this._cursor
    const win = this._slice(wStart, this._winSamples)
    this._cursor = wStart + this._stepSamples
    this._busy = true

    this._task = this._task
      .then(() => this._runWindow(win, wStart, this._winSamples))
      .catch((err) => {
        this._status('error', { message: String(err && err.message || err) })
      })
      .then(() => {
        this._busy = false
        // 期间可能又攒够了一个窗口
        this._pump()
      })
    return this._task
  }

  async _runWindow (pcm, startSample, lenSamples) {
    const discontinuous = this._discontinuous
    this._discontinuous = false

    // 流式不要时间戳：return_timestamps 会走 seek 循环，慢一大截也更费电
    const out = await this._engine.transcribe(pcm, { timestamps: false })
    const raw = (out.text || '').trim()

    if (this.onPartial) {
      try { this.onPartial(raw) } catch (_) {}
    }
    if (!raw) {
      this._prevTokens = []
      return
    }

    const curTokens = tokenize(raw)
    const k = discontinuous ? 0 : overlapJoinLength(this._prevTokens, curTokens, this._maxOverlapTokens)
    this._prevTokens = curTokens

    // 输出原串切片，标点和空格原样保留
    const text = k >= curTokens.length ? '' : raw.slice(curTokens[k] ? curTokens[k].start : 0).trim()
    if (!text) return

    // 时间轴：窗口 i 覆盖 [wStart, wStart+window]，去掉的前 k 个词正好对应前 overlapSec，
    // 所以确定下来的文字对应 [wStart+overlap, wStart+window]。相邻窗口首尾正好接上。
    const winStartMs = (startSample / SAMPLE_RATE) * 1000
    const winEndMs = ((startSample + lenSamples) / SAMPLE_RATE) * 1000
    const offsetMs = (discontinuous || k === 0) ? 0 : (this._overlapSamples / SAMPLE_RATE) * 1000
    // 丢帧时允许回退到新的绝对位置，正常情况下保证不倒退
    const floorMs = discontinuous ? 0 : this._lastEndMs
    const startMs = Math.max(Math.round(winStartMs + offsetMs), floorMs)
    const endMs = Math.max(Math.round(winEndMs), startMs)
    this._lastEndMs = endMs

    if (this.onFinal) {
      try { this.onFinal(text, startMs, endMs) } catch (_) {}
    }
  }

  // 把缓冲区里剩下的音频全部识别完。下课时调用，await 完再 stop()。
  async flush () {
    if (!this._running) return

    // 把在途的那一轮、以及还够整窗的部分全部跑完。
    // 注意不能写成「await 一次再 while」：_pump 会在上一轮的 then 里递归再起一轮，
    // 只 await 最初拿到的那个 promise 会提前返回，跟后面的尾巴处理打架。
    for (;;) {
      await this._task.catch(() => {})
      if (this._busy) continue
      if (this._base + this._len - this._cursor >= this._winSamples) {
        this._pump()
        continue
      }
      break
    }

    // 剩下的尾巴（不足一个整窗）单独跑一次。
    // 如果一个整窗都没跑过（录音很短），不管多短都要跑；否则尾巴里长度不超过
    // overlap 的部分是上一窗口已经识别过的音频，再跑一遍纯属浪费电。
    const end = this._base + this._len
    const tail = end - this._cursor
    const neverRan = this._cursor === 0
    if (tail >= this._minTail && (neverRan || tail > this._overlapSamples + this._minTail)) {
      const wStart = this._cursor
      const pcm = this._slice(wStart, tail)
      this._cursor = end
      try {
        await this._runWindow(pcm, wStart, tail)
      } catch (err) {
        this._status('error', { message: String(err && err.message || err) })
      }
    }
  }

  // 停止接收音频并释放模型。停了之后要重新用必须再 new 一个。
  stop () {
    this._running = false
    this._len = 0
    this._base = 0
    this._cursor = 0
    this._prevTokens = []
    this._buf = new Float32Array(0)
    this._status('stopped', null)
    // 释放是异步的，但 stop() 按约定是同步的，所以不 await
    this._engine.close().catch(() => {})
  }
}
