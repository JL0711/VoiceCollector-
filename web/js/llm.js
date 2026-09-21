// llm.js —— 完全离线的本地小语言模型：给课堂笔记做「自然语言合成」
//
// 为什么需要它：
//   localnlp.js 已经能从转写稿里**抽**出定义、考点、作业、术语、枚举、公式。
//   这些事实是可靠的（它们本来就是老师说过的原话），但读起来很硬 ——
//   整份笔记就是一堆英文句子的摘录，对一个中国留学生来说还是要自己翻译、自己组织。
//   缺的那一步是「把已经抽出来的事实用通顺的中文讲清楚」。这就是本文件负责的部分。
//
// 定位（非常重要，别越界）：
//   本模块**不是**拿去让小模型从零读懂整节课的。0.5B~1.5B 的模型做不到，
//   真让它读 3000 句转写稿再写总结，它会编。
//   正确用法是「**在 localnlp 抽好的可靠事实之上做改写**」：
//     · 每次只喂给它一小撮已经验证过的素材（4 条定义 / 6 条考点 / 一组枚举）；
//     · 每次只让它做一件小事（解释清楚、组织成段落、翻成中文）；
//     · system prompt 里死命强调「只能用素材里的信息」；
//     · 输出过一遍 sanity check（见 checkOutput），不可信就**原样退回抽取式结果**。
//   这样即使模型很笨，最坏情况也只是「笔记回到原来的抽取式样子」，
//   而不是「用户拿到一份胡说八道的笔记」—— 后者对考试复习是灾难。
//
// 依赖：@huggingface/transformers 4.3.0（已 vendor 到 web/vendor/transformers/）
//   运行时初始化写法（LIB_URL / env / WebGPU 探测 / dtype 按设备选 / 进度回调 /
//   推理串行化）刻意和 whisper.js 保持一致，方便对照着读。
//
// 纯 ES Module，无构建步骤，可被 <script type="module"> 直接 import。

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

// vendor 目录相对于本文件（web/js/llm.js -> web/vendor/transformers/）
const LIB_URL = new URL('../vendor/transformers/transformers.web.min.js', import.meta.url).href
const ORT_DIR = new URL('../vendor/transformers/ort/', import.meta.url).href

// 必须和 @huggingface/transformers@4.3.0 锁定的 onnxruntime-web 版本一致。
// 和 whisper.js 里的常量是同一个值 —— 那边已经注释过原因，这里不重复。
// 只有本地 web/vendor/transformers/ort/ 里没放 .wasm 时才用得上。
const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0'
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`

// 本地模型目录（web/models/）。
//
// ⚠️ 这里**必须**是「路径」而不是「完整 URL」，原因在 transformers 4.3.0 的
// src/utils/hub.js 里：
//   buildResourcePaths() 会算出 localPath = pathJoin(env.localModelPath, '<repo>/<file>')，
//   而「文件是否存在」的探测函数（压缩包里是 OS()，对应源码 getModelFileInfo）判定是
//       if (env.allowLocalModels && !isValidUrl(localPath, ['http:', 'https:'])) { 走本地 }
//   —— 注意它判的是 **localPath**，不是 requestURL。
//   一旦 localModelPath 写成 'https://host/web/models/'，isValidUrl() 直接为 true，
//   整个本地分支被跳过，transformers 会当作「本地没有」直接去 Hugging Face 下 1GB。
//   （对照 getModelFile 那条路径判的是 requestURL，所以症状是「时好时坏」，更难查。）
// 用 .pathname 拿到的是 '/web/models/'（或 file:// 下的绝对路径），
// new URL('/web/models/...') 会抛异常 → isValidUrl 为 false → 本地分支正常走。
const LOCAL_MODELS_PATH = new URL('../models/', import.meta.url).pathname

// ---------------------------------------------------------------------------
// 模型清单
// ---------------------------------------------------------------------------
// 三个仓库都在 2026-09 用 https://huggingface.co/api/models/<repo> 和
// .../tree/main/onnx 逐个核实过：仓库存在、pipeline_tag 是 text-generation、
// onnx/ 下有下面写的量化文件。sizeMB 是**实际会被下载的那一个 .onnx 文件**的体积
// （来自 HF tree API 的 size 字段，**除以 1048576**，即 MiB，四舍五入到整数），
// 不是仓库总大小 —— 仓库里 fp32/fp16/int8/q4/q4f16 全加起来要大好几倍。
// ⚠️ 单位统一用 MiB。Hugging Face 网页上显示的是十进制 MB/GB，会比这里大 4~7%，
//    比如 1.5B 的 q4f16 这里写 1165，HF 网页显示 1.22 GB —— 是同一个文件。
//    三行的单位必须一致，否则 UI 上「哪个更小」会给出错误的印象。
//
// 除了 .onnx，每个仓库还要额外下载 tokenizer.json / vocab.json / merges.txt /
// config.json 等，合计约 8~12MB，UI 上提示体积时可以加个 10MB 的余量。
//
// dtypes 按 device 分三档，含义和 whisper.js 完全一致：
//   webgpu       —— 支持 shader-f16 的 WebGPU（Apple 芯片、独显基本都支持）
//   webgpuNoFp16 —— 有 WebGPU 但不支持 fp16，只能退回纯整数量化
//   wasm         —— 没有 WebGPU，CPU 跑；wasm 后端不支持 fp16
// 这三个仓库都是「单文件模型」（文件名就是 model），所以 dtype 直接给字符串即可，
// 不需要像 Whisper 那样按 encoder/decoder 分别指定。
export const LLM_MODELS = [
  {
    id: 'onnx-community/Qwen2.5-0.5B-Instruct',
    label: '轻量版（省电、下得快）',
    sizeMB: 461,
    quality: '一般',
    note: '0.5B 参数。句子通顺，但概念解释比较表面，偶尔会把两条素材揉成一条。' +
      '内存小 / 没独显 / 流量紧张时选它。WebGPU 下载 461MB，纯 CPU 档 488MB。',
    dtypes: { webgpu: 'q4f16', webgpuNoFp16: 'q4', wasm: 'q8' },
    // 精确字节：q4f16 483,003,582 / q4 786,156,820 / q8 512,096,557
    sizeMBByDevice: { webgpu: 461, webgpuNoFp16: 750, wasm: 488 },
    minRAM: 8,
    // Qwen2.5 的 chat template 里没有 thinking 开关
    thinking: false
  },
  {
    id: 'onnx-community/Qwen3-0.6B-ONNX',
    label: '推荐（M 系列芯片默认）',
    sizeMB: 543,
    quality: '好',
    note: '0.6B 参数，比 Qwen2.5-0.5B 新一代，中文表达明显更自然。' +
      'M1/M2/M3 + WebGPU 上整理一节 90 分钟的课大约 1~3 分钟。' +
      '注意它默认会先输出一段 <think> 思考过程，本模块已经关掉（enable_thinking=false）。',
    dtypes: { webgpu: 'q4f16', webgpuNoFp16: 'q4', wasm: 'q8' },
    // 精确字节：q4f16 569,789,750 / q4 919,096,585 / q8 617,687,575
    // （仓库里还有 model.onnx 315MB + model.onnx_data 2090MB 的 fp32 档，我们不碰）
    sizeMBByDevice: { webgpu: 543, webgpuNoFp16: 877, wasm: 589 },
    minRAM: 8,
    // Qwen3 的 chat template 支持 enable_thinking 变量，必须显式关掉，
    // 否则每次生成都要先吐几百个 token 的思考过程，慢且容易跑飞
    thinking: true
  },
  {
    id: 'onnx-community/Qwen2.5-1.5B-Instruct',
    label: '最好（需 16GB 内存 + 支持 fp16 的 WebGPU）',
    sizeMB: 1165,
    quality: '最好',
    note: '1.5B 参数，解释知识点的水平明显高一档，是这三个里唯一能把一段枚举' +
      '真正组织成人话的。代价：首次下载 1.1GB，跑起来占 2GB 左右显存/内存。' +
      '没有 fp16 的机器只能下 1.7GB 的 q4，不划算，recommendModel() 不会推荐。',
    dtypes: { webgpu: 'q4f16', webgpuNoFp16: 'q4', wasm: 'q8' },
    // 精确字节：q4f16 1,221,878,940（单文件，没有配套 .onnx_data）/ q4 1,787,566,590 / q8 1,578,954,293
    sizeMBByDevice: { webgpu: 1165, webgpuNoFp16: 1705, wasm: 1506 },
    minRAM: 16,
    thinking: false
  }
]

// 回退表：万一某个仓库被删/改名，UI 可以拿这里的替代品顶上。
export const LLM_MODEL_FALLBACKS = {
  'onnx-community/Qwen2.5-1.5B-Instruct': 'onnx-community/Qwen3-0.6B-ONNX',
  'onnx-community/Qwen3-0.6B-ONNX': 'onnx-community/Qwen2.5-0.5B-Instruct',
  'onnx-community/Qwen2.5-0.5B-Instruct': 'onnx-community/Qwen3-0.6B-ONNX'
}

const DEFAULT_MODEL = 'onnx-community/Qwen3-0.6B-ONNX'

export function findLLMModel (id) {
  return LLM_MODELS.find((m) => m.id === id) || null
}

// ---------------------------------------------------------------------------
// 运行时配置（懒加载 transformers）
// ---------------------------------------------------------------------------
// 只有真的要用小模型时才会 import 那 450KB 的库 —— 只想看抽取式笔记的用户
// 一个字节都不用多下。

let _runtime = null
let _ortLocal = false
let _runtimeOpts = {
  // 换成 'https://hf-mirror.com/' 可以走国内镜像（结尾必须有斜杠）
  remoteHost: 'https://huggingface.co/',
  cacheKey: 'transformers-cache',
  // 本地模型目录；设成 null 表示「不找本地，直接远端下」
  localModelPath: LOCAL_MODELS_PATH,
  // 省电：wasm 线程数。默认砍到一半核心，最多 4 个。
  numThreads: null
}

// 在 load() 之前调用才有意义。用于换 HF 镜像、改本地模型目录、调线程数（省电）。
export function configureRuntime (patch) {
  if (_runtime) throw new Error('LLM 运行时已经初始化，configureRuntime 必须在 load() 之前调用')
  _runtimeOpts = { ..._runtimeOpts, ...patch }
}

// 诊断用：ORT 的 WASM 是不是从本地 vendor 目录加载的。load() 之后才有意义。
export function ortIsLocal () {
  return _ortLocal
}

// 复刻 transformers 4.3.0 env.js 里的 isSafariBelow26()（和 whisper.js 同一份逻辑）。
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

async function exists (url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'force-cache' })
    return res.ok
  } catch (_) {
    return false
  }
}

// 决定 ORT 去哪里加载 WASM 工厂(.mjs)和二进制(.wasm)。
// 和 whisper.js 里的 resolveOrtPaths 完全一样：dist 打包产物里 env.versions.web
// 没被赋值，库自带的「默认走 jsDelivr」那段是死代码，wasmPaths 不显式设就会 404。
async function resolveOrtPaths (hasWebGPU) {
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
    const { pipeline, env, TextStreamer, StoppingCriteria, StoppingCriteriaList } = mod

    env.allowRemoteModels = true
    env.remoteHost = _runtimeOpts.remoteHost
    env.remotePathTemplate = '{model}/resolve/{revision}/'

    // 权重和 ort wasm 都进浏览器 Cache Storage —— 第二次开课就完全离线了
    env.useBrowserCache = true
    env.useWasmCache = true
    env.cacheKey = _runtimeOpts.cacheKey

    // ⚠️ allowLocalModels / localModelPath 故意**不在这里**设死，改成每次 load()
    // 之前按需设置，见 LocalLLM._prepareLocal()。
    //
    // 澄清一个容易搞错的点：本文件 import 的是 transformers.**web**.min.js，
    // 而 whisper.js import 的是 transformers.min.js（两个不同的打包产物）。
    // URL 不同 → 不同的模块实例 → **各自有一份 env**，所以这里改 env 不会影响 Whisper，
    // 反过来 Whisper 把它那份 env.allowLocalModels 设成 false 也影响不到我们。
    // 但「每次 load() 前按需设置」这个写法照样保留：
    // 同一个 LocalLLM 实例可能先后加载不同的模型，本地有没有那份权重是按模型变的。
    // 代价是页面上会有两份库 + 两套 ORT 运行时（约 1MB JS），换来的是两边互不干扰。

    const wasmEnv = env.backends?.onnx?.wasm
    if (wasmEnv) {
      const hasWebGPU = await webgpuAvailable()
      const paths = await resolveOrtPaths(hasWebGPU)
      // 和 whisper.js 算出来的是同一组路径，谁先设都一样，重复设置无害
      wasmEnv.wasmPaths = { wasm: paths.wasm, mjs: paths.mjs }
      _ortLocal = paths.local

      // 省电：默认砍掉一半 CPU 核心
      const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
      const isolated = typeof globalThis.crossOriginIsolated !== 'undefined' && globalThis.crossOriginIsolated
      wasmEnv.numThreads = _runtimeOpts.numThreads != null
        ? _runtimeOpts.numThreads
        : (isolated ? Math.min(4, Math.max(1, Math.floor(cores / 2))) : 1)
    }

    return { pipeline, env, TextStreamer, StoppingCriteria, StoppingCriteriaList }
  })()
  return _runtime
}

// ---------------------------------------------------------------------------
// 设备能力探测
// ---------------------------------------------------------------------------

let _gpuProbe = null

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

/**
 * 这台机器能不能跑本地小模型。
 * 不下载任何东西，只看硬件特征 —— UI 可以在用户点「启用本地 AI」之前先问一下。
 * @returns {Promise<{ok:boolean, reason:string, device:'webgpu'|'wasm'|null, fp16:boolean, memGB:number, cores:number}>}
 */
export async function llmAvailable () {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0
  // deviceMemory 只有 Chromium 系有；Safari 返回 undefined，按 8GB 保守估
  const memGB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8
  const gpu = await probeGPU()

  if (gpu.ok) {
    // 1GB 级别的权重要一口气喂进 GPU，maxStorageBufferBindingSize 太小的核显直接放弃
    if (gpu.maxStorageBufferBindingSize && gpu.maxStorageBufferBindingSize < (128 << 20)) {
      return {
        ok: false,
        reason: '这块显卡单个缓冲区上限太小（不到 128MB），装不下小模型的权重。笔记会用离线抽取式生成。',
        device: null, fp16: !!gpu.fp16, memGB, cores
      }
    }
    return {
      ok: true,
      reason: gpu.fp16
        ? 'WebGPU 可用且支持 fp16，可以跑 q4f16 量化，速度和体积都最好。'
        : 'WebGPU 可用但不支持 fp16，只能跑纯整数量化（下载体积会大一些，速度慢一些）。',
      device: 'webgpu', fp16: !!gpu.fp16, memGB, cores
    }
  }

  // 没有 WebGPU 就只能 CPU(wasm)。小模型在 CPU 上是「能跑」不是「能用」，
  // 这里如实告诉用户，别让他等半小时才发现慢。
  if (memGB < 8 || cores && cores < 4) {
    return {
      ok: false,
      reason: `没有检测到 WebGPU，而且这台机器只有约 ${memGB}GB 内存 / ${cores || '未知'} 个核心，` +
        '跑本地小模型会非常慢（一节课可能要半小时以上）。建议继续用离线抽取式笔记。',
      device: null, fp16: false, memGB, cores
    }
  }
  return {
    ok: true,
    reason: '没有检测到 WebGPU，只能用 CPU 跑。能出结果，但一节课可能要 10 分钟以上，而且很费电。' +
      '建议插着电源用，或者只对单个小节点「润色」而不是整篇。',
    device: 'wasm', fp16: false, memGB, cores
  }
}

/**
 * 粗略判断这台机器适合哪个模型，返回 LLM_MODELS 里的一个 id。
 * 和 whisper.js 的 estimateSpeed() 思路一样：不跑 benchmark（那要先下模型，本末倒置），
 * 只看硬件特征。
 * @returns {Promise<string>} model id
 */
export async function recommendModel () {
  const LIGHT = 'onnx-community/Qwen2.5-0.5B-Instruct'
  const MID = 'onnx-community/Qwen3-0.6B-ONNX'
  const BIG = 'onnx-community/Qwen2.5-1.5B-Instruct'

  const gpu = await probeGPU()
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
  const memGB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8

  // CPU 档：模型越小越好，别让用户等到下课
  if (!gpu.ok) return LIGHT

  const vendor = String(gpu.info.vendor || '').toLowerCase()
  const arch = String(gpu.info.architecture || '').toLowerCase()
  const isApple = vendor.includes('apple') || arch.includes('apple') || arch.includes('metal')
  const isDiscrete = vendor.includes('nvidia') || vendor.includes('amd') ||
    arch.includes('rdna') || arch.includes('ampere') || arch.includes('ada')
  // 1.5B 的 q4f16 单文件就有 1.1GB，缓冲区上限小于 1GB 的直接别想
  const bigBuffers = gpu.maxStorageBufferBindingSize >= (1 << 30)

  // 1.5B 只推荐给「fp16 + 16GB 内存 + 大缓冲区 + Apple 芯片或独显」
  // 注意 Safari 的 deviceMemory 是 undefined，会落到默认值 8，于是 M 系列的 Mac
  // 在 Safari 上只会被推荐 0.6B —— 这是刻意的保守，宁可慢一点也别把内存打爆。
  if (gpu.fp16 && memGB >= 16 && cores >= 8 && bigBuffers && (isApple || isDiscrete)) return BIG
  if (gpu.fp16) return MID
  // 有 WebGPU 但没 fp16：q4 体积翻倍（877MB vs 543MB），退一档
  if (memGB >= 8 && cores >= 8) return MID
  return LIGHT
}

// 根据探测到的设备挑 dtype。未知模型给一组保守默认值。
function pickDtype (modelId, device, fp16) {
  const entry = findLLMModel(modelId)
  const key = device === 'webgpu' ? (fp16 ? 'webgpu' : 'webgpuNoFp16') : 'wasm'
  if (entry && entry.dtypes && entry.dtypes[key]) return entry.dtypes[key]
  if (device === 'webgpu') return fp16 ? 'q4f16' : 'q4'
  return 'q8'
}

// ---------------------------------------------------------------------------
// LocalLLM —— 加载 + 串行化 + 超时 + 流式
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60000     // 单次生成的软上限
const HARD_TIMEOUT_SLACK = 20000     // 软上限之后再等这么久还不回来就硬放弃

export class LocalLLM {
  // model      : LLM_MODELS 里的 id，默认 Qwen3-0.6B
  // onProgress : ({ pct, loadedMB, totalMB, file }) => void  下载进度（模型 500MB~1.2GB，必须有）
  // onStatus   : (status, detail) => void  'downloading' | 'loading' | 'ready' | 'error' | 'closed'
  // timeoutMs  : 单次 generate 的超时，默认 60s
  constructor ({ model, onProgress, onStatus, timeoutMs } = {}) {
    this.modelId = model || DEFAULT_MODEL
    this.onProgress = typeof onProgress === 'function' ? onProgress : null
    this.onStatus = typeof onStatus === 'function' ? onStatus : null
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS

    this.device = null      // 实际用上的后端：'webgpu' | 'wasm'
    this.dtype = null       // 实际用上的精度
    this.fromLocal = false  // 权重是不是从 web/models/ 本地目录读的
    this.ready = false

    this._pipe = null
    this._loading = null
    this._closed = false
    // 同一时刻只跑一个 generate（ONNX session 不能并发 run）
    this._queue = Promise.resolve()
    // 当前正在跑的那个原始 promise。硬超时后队列要等它真正结束，
    // 否则下一次 generate 会和还没死透的这次撞在一起。
    this._inflight = null
  }

  _status (s, detail) {
    if (this.onStatus) {
      try { this.onStatus(s, detail) } catch (_) {}
    }
  }

  // 探测 web/models/<repo>/config.json 在不在，决定这次 load 要不要开本地分支。
  //
  // 为什么不无脑开 allowLocalModels=true：本地没有时 transformers 会对每个文件先发一次
  // 注定 404 的请求，有些 dev server 对 404 返回 200 + index.html，
  // 那就会拿一份 HTML 去当 tokenizer.json 解析，报一堆看不懂的错。
  // 自己先探一次最稳。
  async _prepareLocal (env) {
    const base = _runtimeOpts.localModelPath
    let ok = false
    if (base) {
      try {
        const res = await fetch(`${base}${this.modelId}/config.json`, { cache: 'force-cache' })
        if (res.ok) {
          const ct = String(res.headers.get('content-type') || '')
          // 有些静态服务器把 .json 标成 text/plain，所以不能只看 content-type，
          // 真解析一下最保险（config.json 只有几 KB）
          if (!ct.includes('html')) {
            const txt = await res.text()
            const obj = JSON.parse(txt)
            ok = !!(obj && (obj.model_type || obj.architectures))
          }
        }
      } catch (_) {
        ok = false
      }
    }
    env.allowLocalModels = ok
    if (ok) env.localModelPath = base
    this.fromLocal = ok
    return ok
  }

  // 幂等：重复调用返回同一个 promise
  async load () {
    if (this._pipe) return this._pipe
    if (this._loading) return this._loading

    this._loading = (async () => {
      try {
        const rt = await getRuntime()
        const { pipeline, env } = rt
        const gpu = await probeGPU()

        await this._prepareLocal(env)

        // 下载进度：transformers 会发 'progress_total' 事件，里面是所有文件的合计字节数，
        // 直接当总进度用。模型 500MB~1.2GB，没有进度条用户会以为卡死了。
        let sawDownload = false
        let finished = false
        const progress_callback = (info) => {
          if (this._closed) return
          if (info.status === 'initiate' || info.status === 'download') {
            if (!sawDownload) {
              sawDownload = true
              this._status('downloading', { model: this.modelId, local: this.fromLocal })
            }
          } else if (info.status === 'progress_total') {
            if (!sawDownload) {
              sawDownload = true
              this._status('downloading', { model: this.modelId, local: this.fromLocal })
            }
            if (this.onProgress) {
              try {
                this.onProgress({
                  pct: Math.max(0, Math.min(100, info.progress || 0)),
                  loadedMB: +((info.loaded || 0) / 1048576).toFixed(1),
                  totalMB: +((info.total || 0) / 1048576).toFixed(1),
                  file: null
                })
              } catch (_) {}
            }
            if (!finished && (info.progress || 0) >= 99.9) {
              finished = true
              // 权重下完了，接下来是建 ONNX session（WebGPU 编译 shader 要十几秒，且不发事件）
              this._status('loading', { model: this.modelId })
            }
          } else if (info.status === 'progress' && this.onProgress && !sawDownload) {
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
          const pipe = await pipeline('text-generation', this.modelId, {
            device,
            dtype,
            progress_callback
          })
          this.device = device
          this.dtype = dtype
          return pipe
        }

        // 优先 WebGPU（比 CPU 快一个数量级，而且 GPU 定点算比 CPU 满载省电），
        // 失败自动退回 wasm。
        let pipe = null
        if (gpu.ok) {
          try {
            pipe = await build('webgpu')
          } catch (err) {
            console.warn('[llm] WebGPU 初始化失败，退回 CPU(wasm)：', err)
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
        this._status('ready', {
          model: this.modelId, device: this.device, dtype: this.dtype, local: this.fromLocal
        })
        return pipe
      } catch (err) {
        this._loading = null
        this.ready = false
        this._status('error', { model: this.modelId, message: String((err && err.message) || err) })
        throw err
      }
    })()

    return this._loading
  }

  /**
   * 生成一段文本。**串行**：同一时刻只跑一个，后来的排队。
   *
   * @param {string} prompt    用户消息（把素材和任务都写在这里）
   * @param {Object} [opts]
   * @param {string} [opts.system]      system prompt，默认用 GROUND_RULES
   * @param {number} [opts.maxTokens]   默认 256。省电：默认就限制长度，别让它写小作文。
   * @param {number} [opts.temperature] 默认 0.3；<=0 走贪心解码
   * @param {number} [opts.timeoutMs]   覆盖构造时的超时
   * @param {(chunk:string, full:string)=>void} [opts.onToken] 流式回调
   * @returns {Promise<string>} 生成的文本（已 trim，已去掉 <think> 块）
   */
  async generate (prompt, opts = {}) {
    if (this._closed) throw new Error('LLM 已关闭')
    const pipe = await this.load()
    const rt = await getRuntime()

    const system = opts.system != null ? String(opts.system) : GROUND_RULES
    const maxTokens = Math.max(16, Math.min(1024, Number(opts.maxTokens) || 256))
    const temperature = opts.temperature != null ? Number(opts.temperature) : 0.3
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : this.timeoutMs
    const onToken = typeof opts.onToken === 'function' ? opts.onToken : null
    const entry = findLLMModel(this.modelId)

    const run = async () => {
      // 超时的时钟从「真正轮到自己」开始算，而不是从排队开始算
      const deadline = Date.now() + timeoutMs

      // 软超时：自定义 StoppingCriteria，在每生成一个 token 之后被调用一次，
      // 到点就让 generate 自己收尾。比硬 kill 干净 —— 已经生成的部分还能用。
      const Deadline = class extends rt.StoppingCriteria {
        _call (input_ids) {
          const stop = Date.now() >= deadline
          return new Array(input_ids.length).fill(stop)
        }
      }
      const criteria = new rt.StoppingCriteriaList()
      criteria.push(new Deadline())

      let full = ''
      const streamer = new rt.TextStreamer(pipe.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (txt) => {
          full += txt
          if (onToken) {
            try { onToken(txt, full) } catch (_) {}
          }
        }
      })

      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: String(prompt) }
      ]

      const genOpts = {
        max_new_tokens: maxTokens,
        do_sample: temperature > 0,
        stopping_criteria: criteria,
        // 小模型最爱的毛病就是原地打转，轻微的重复惩罚能压住大半
        repetition_penalty: 1.08,
        streamer
      }
      if (temperature > 0) {
        genOpts.temperature = temperature
        genOpts.top_p = 0.9
      }
      // Qwen3 的 chat template 默认 enable_thinking=true，会先吐一大段 <think>。
      // 源码 src/pipelines/text-generation.js 里 tokenizer_encode_kwargs 会被原样
      // 展开进 apply_chat_template 的参数，所以这里能把它关掉。
      if (entry && entry.thinking) {
        genOpts.tokenizer_encode_kwargs = { enable_thinking: false }
      }

      const raw = pipe(messages, genOpts)
      this._inflight = raw

      // 硬超时：软超时只在两个 token 之间生效；万一卡在某一次 forward 里出不来，
      // 再等 HARD_TIMEOUT_SLACK 就放弃等待（底层的 promise 交给队列去等）。
      let timer = null
      const guard = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`生成超时（${Math.round((timeoutMs + HARD_TIMEOUT_SLACK) / 1000)}s）`)),
          timeoutMs + HARD_TIMEOUT_SLACK
        )
      })

      try {
        const out = await Promise.race([raw, guard])
        const last = out && out[0] && out[0].generated_text
        // chat 输入时 generated_text 是消息数组，取最后一条 assistant 消息
        const text = Array.isArray(last)
          ? String((last[last.length - 1] && last[last.length - 1].content) || '')
          : String(last || '')
        return stripThinking(text || full)
      } catch (err) {
        // 软超时时已经流出来的那部分仍然可用；能用就用，不够长就往上抛
        const partial = stripThinking(full)
        if (partial.length >= 24) return partial
        throw err
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    // 队列：下一次 generate 必须等到「上一次的 run 结束」**并且**
    // 「上一次的底层 pipe 调用也结束」才开始。
    const task = this._queue.then(run, run)
    this._queue = task.then(
      () => (this._inflight || Promise.resolve()).catch(() => {}),
      () => (this._inflight || Promise.resolve()).catch(() => {})
    )
    return task
  }

  // 主动释放显存 / 内存。跑完一份笔记就该调 —— 1GB 级别的权重挂在显存里很费电。
  async close () {
    this._closed = true
    this.ready = false
    const pipe = this._pipe
    this._pipe = null
    this._loading = null
    if (pipe) {
      try { await pipe.dispose() } catch (_) {}
    }
    this._status('closed', { model: this.modelId })
  }
}

// 去掉 Qwen3 之类模型的 <think>...</think> 思考块（正常情况下已经用
// enable_thinking=false 关掉了，这里是兜底；也处理只有半个标签的截断情况）
function stripThinking (s) {
  let t = String(s || '')
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '')
  t = t.replace(/^[\s\S]*?<\/think>/i, '')
  t = t.replace(/<think>[\s\S]*$/i, '')
  return t.trim()
}

// ---------------------------------------------------------------------------
// 提示词：所有调用共用的「铁律」
// ---------------------------------------------------------------------------
//
// 这段是整个模块最重要的 20 行。小模型不会自己守规矩，规矩必须写死、写短、写具体，
// 而且每一次调用都要带上（不能只在第一轮说）。

export const GROUND_RULES = [
  '你是一名帮中国留学生整理课堂笔记的助手。你要处理的素材来自课堂录音的自动转写，可能有识别错误。',
  '',
  '必须遵守：',
  '1. 只能使用【素材】里出现的信息。素材里没有的内容，一个字都不许加。',
  '2. 不许编造人名、数字、日期、公式、单位、结论、例子。素材里没写就不要写。',
  '3. 素材看不懂、信息不够时，直接写「素材不足，无法确认」，不要猜。',
  '4. 全部用简体中文。英文的专业术语可以保留原词，但解释必须是中文。',
  '5. 只输出要求的内容。不要写「好的」「以下是」这类开场白，不要重复题目，不要写总结之外的评论。',
  '6. 按要求的条数和格式输出，不要多写也不要少写。'
].join('\n')

// ---------------------------------------------------------------------------
// Sanity check —— 判断模型这次输出能不能信
// ---------------------------------------------------------------------------
//
// 小模型跑飞的几种典型形态，每一种都得拦住：
//   a) 空 / 几乎是空的
//   b) 原地打转：同一句话重复 N 遍、同一个词刷屏
//   c) 根本没说中文：整段英文、或者复读素材原文
//   d) 乱码：控制字符、私用区字符、同一个字符连着几十个
//   e) 长度异常：要求一句话它写了 2000 字，或者超长到明显在编
//   f) 提示词泄漏：把 system prompt / 【素材】/ <|im_start|> 原样吐出来
//   g) 数字幻觉：输出里出现素材里根本没有的日期 / 数字（最危险的一种，
//      「作业周五交」被编成「周三交」会直接害人）
//
// 返回 { ok, reason }。ok=false 时调用方**必须**退回抽取式输出。

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/g
const GARBAGE_RE = /[ --�-]/
const LEAK_RE = /<\|im_(start|end)\|>|<\|endoftext\|>|【素材】|【任务】|^system\b|你是一名帮中国留学生整理课堂笔记/im

// 英文词接地检查的白名单：这些词就算素材里没有也允许出现
// （排版词 / 通用说法 / 本模块自己让模型写的固定短语）
const LATIN_ALLOW = new Set([
  'note', 'notes', 'todo', 'ok', 'okay', 'etc', 'https', 'http', 'www',
  'pdf', 'ppt', 'slide', 'slides', 'email', 'wifi'
])

// 「说错了就会害人」的语境词：出现这些词时，时间说法必须字字有据
const DEADLINE_WORDS = /交|提交|截止|之前|以前|due|deadline|考试|测验|小测|期中|期末|上交|提交截止/i

// 中文时间说法 -> 素材里必须能找到的对应说法。
// en 这一侧故意放宽（「下周」允许被素材里的 next Friday / next class 支撑），
// 目的是拦「凭空冒出来的时间」，不是拦「换了个说法的时间」。
const TIME_GROUND_RULES = [
  { label: '周一', zh: /周一|週一|星期一|礼拜一/, en: /\bmon(day)?\b/ },
  { label: '周二', zh: /周二|週二|星期二|礼拜二/, en: /\btue(s|sday)?\b/ },
  { label: '周三', zh: /周三|週三|星期三|礼拜三/, en: /\bwed(nesday)?\b/ },
  { label: '周四', zh: /周四|週四|星期四|礼拜四/, en: /\bthu(r|rs|rsday)?\b/ },
  { label: '周五', zh: /周五|週五|星期五|礼拜五/, en: /\bfri(day)?\b/ },
  { label: '周六', zh: /周六|週六|星期六|礼拜六/, en: /\bsat(urday)?\b/ },
  { label: '周日', zh: /周日|週日|星期日|星期天|礼拜天/, en: /\bsun(day)?\b/ },
  { label: '明天', zh: /明天|明日/, en: /\btomorrow\b/ },
  { label: '后天', zh: /后天/, en: /day after tomorrow/ },
  // 「今天这节课讲了…」「这周的内容」「周末复习一下」都是无害的口头禅，
  // 只有当同一段话里还出现「交 / 截止 / 考试」这类词时，说错才真的会害人。
  // 所以这三条加 near 限定，避免把正常的中文表达误杀成幻觉。
  { label: '今天', zh: /今天|今日/, en: /\btoday\b|\btonight\b/, near: DEADLINE_WORDS },
  { label: '本周', zh: /本周|这周|這週|这个星期/, en: /\bthis\b/, near: DEADLINE_WORDS },
  { label: '周末', zh: /周末|週末/, en: /\bweekend\b/, near: DEADLINE_WORDS },
  { label: '下周', zh: /下周|下週|下个星期|下星期|下节课|下一节课/, en: /\bnext\b/ },
  { label: '下个月', zh: /下个月|下個月/, en: /\bnext month\b/ },
  { label: '月底', zh: /月底/, en: /end of (the )?month/ }
]

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// 「十一」-> 11。只认 1~99，认不出来返回 null（返回 null 时调用方放过，不误杀）。
function zhNumeral (s) {
  const D = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const t = String(s || '')
  if (t.length === 1) return t === '十' ? 10 : (D[t] != null ? D[t] : null)
  const i = t.indexOf('十')
  if (i < 0) return null
  const hi = i === 0 ? 1 : D[t[0]]
  const lo = i === t.length - 1 ? 0 : D[t[i + 1]]
  if (hi == null || lo == null) return null
  return hi * 10 + lo
}

// 把模型输出里会破坏笔记结构的东西清掉。
// 模型输出是直接拼进 Markdown 的，一个 `</details>` 或者一个 `# 大标题`
// 就能把整份笔记的结构掀翻（实测小模型真的会模仿我们给它的格式吐 HTML 标签）。
// 这一步只做结构清理，不改内容 —— 内容可信度交给 checkOutput。
export function sanitizeModelText (text) {
  let t = String(text == null ? '' : text)
  t = t.replace(/```+[^\n]*/g, '')                    // 代码围栏
  t = t.replace(/<\/?[A-Za-z][^<>]{0,80}>/g, '')      // 任何 HTML 标签（details/summary/think/script…）
  t = t.split('\n').map((line) => line
    .replace(/^\s{0,3}#{1,6}\s*/, '')                 // 标题降级成正文
    .replace(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/, '') // 分隔线
    .replace(/^\s{0,3}>\s?/, '')                      // 引用块（我们自己会加 >）
  ).join('\n')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

/**
 * @param {string} text   模型输出
 * @param {Object} [opts]
 * @param {string} [opts.material]  这次喂给模型的素材原文，用来做数字/日期接地检查
 * @param {number} [opts.minLen=8]  最短可接受长度（字符）
 * @param {number} [opts.maxLen=4000] 最长可接受长度
 * @param {number} [opts.minCjkRatio=0.3] 中文字符占「非空白字符」的最低比例
 * @param {boolean} [opts.checkNumbers=true] 是否做数字接地检查
 * @returns {{ok:boolean, reason:string}}
 */
export function checkOutput (text, opts = {}) {
  const minLen = opts.minLen != null ? opts.minLen : 8
  const maxLen = opts.maxLen != null ? opts.maxLen : 4000
  const minCjkRatio = opts.minCjkRatio != null ? opts.minCjkRatio : 0.3
  const checkNumbers = opts.checkNumbers !== false
  const checkLatin = opts.checkLatin !== false
  const material = String(opts.material || '')

  const t = String(text == null ? '' : text).trim()

  // a) 空
  if (!t) return { ok: false, reason: '输出为空' }
  if (t.length < minLen) return { ok: false, reason: `输出太短（${t.length} 字符，至少要 ${minLen}）` }
  // e) 超长
  if (t.length > maxLen) return { ok: false, reason: `输出异常长（${t.length} 字符，上限 ${maxLen}）` }

  // f) 提示词泄漏
  if (LEAK_RE.test(t)) return { ok: false, reason: '输出里混进了提示词模板' }

  // d) 乱码 / 控制字符 / 私用区
  if (GARBAGE_RE.test(t)) return { ok: false, reason: '输出里有乱码或控制字符' }
  if (/(.)\1{14,}/.test(t)) return { ok: false, reason: '同一个字符连续重复十几遍' }

  // c) 中文比例。英文术语可以有，但整段英文说明它只是在复读素材。
  const nonSpace = t.replace(/\s+/g, '')
  const cjk = (t.match(CJK_RE) || []).length
  if (nonSpace.length >= 12) {
    const ratio = cjk / nonSpace.length
    if (ratio < minCjkRatio) {
      return { ok: false, reason: `中文太少（只有 ${(ratio * 100).toFixed(0)}%），大概率是在复读英文原文` }
    }
  }

  // b) 重复检测之一：整行重复
  const lines = t.split('\n').map((x) => x.replace(/^\s*[-*\d.、)）]+\s*/, '').trim()).filter((x) => x.length >= 4)
  if (lines.length >= 3) {
    const uniq = new Set(lines)
    if (uniq.size / lines.length < 0.6) {
      return { ok: false, reason: `${lines.length} 行里只有 ${uniq.size} 行不一样，模型在原地打转` }
    }
  }

  // b) 重复检测之二：句子级。按中英文句末标点切。
  const sents = t.split(/[。！？!?；;\n]+/).map((x) => x.trim()).filter((x) => x.length >= 6)
  if (sents.length >= 4) {
    const uniq = new Set(sents)
    if (uniq.size / sents.length < 0.6) {
      return { ok: false, reason: `${sents.length} 句里只有 ${uniq.size} 句不一样，模型在原地打转` }
    }
  }

  // b) 重复检测之三：n-gram 刷屏。取 6 字窗口，出现次数占比过高就判死。
  //    （专门抓「明天交明天交明天交…」这种没有标点的重复）
  if (nonSpace.length >= 60) {
    const counts = new Map()
    let top = 0
    for (let i = 0; i + 6 <= nonSpace.length; i++) {
      const g = nonSpace.slice(i, i + 6)
      const c = (counts.get(g) || 0) + 1
      counts.set(g, c)
      if (c > top) top = c
    }
    const windows = nonSpace.length - 5
    if (top >= 6 && top / windows > 0.08) {
      return { ok: false, reason: `同一个片段重复了 ${top} 次，模型在原地打转` }
    }
  }

  // h) 英文词接地：输出里出现的英文单词必须在素材里出现过。
  //    GROUND_RULES 允许保留英文专业术语 —— 但那些术语只能来自素材。
  //    凭空冒出来的英文词/人名（"Gauss"、"Ito calculus"、"Chapter Nine"）
  //    就是典型的「一本正经地编」，这条能便宜地拦掉一大半。
  if (checkLatin && material) {
    const matWords = new Set((material.toLowerCase().match(/[a-z][a-z'’-]*/g) || []))
    const grounded = (w) => {
      if (matWords.has(w)) return true
      // 单复数 / 简单词形变化：素材 martingales，输出 martingale（或反过来）
      for (const suf of ['s', 'es', 'd', 'ed', 'ing']) {
        if (matWords.has(w + suf)) return true
        if (w.endsWith(suf) && matWords.has(w.slice(0, -suf.length))) return true
      }
      return false
    }
    for (const w of (t.toLowerCase().match(/[a-z][a-z'’-]*/g) || [])) {
      // 1~3 个字母的多半是排版/缩写噪音（a、is、of、AI、OK），放过
      if (w.length < 4) continue
      if (LATIN_ALLOW.has(w)) continue
      if (grounded(w)) continue
      return { ok: false, reason: `输出里出现了素材里没有的英文词「${w}」，可能是编的` }
    }
  }

  // i) 时间说法接地：中文的星期 / 相对日期必须在素材里有对应说法。
  //    这是整个模块最要命的一种幻觉 —— 「next Friday 交」被写成「下周三交」，
  //    学生照着笔记交作业就直接迟交。数字接地拦不住它（「下周三」里一个数字都没有）。
  if (checkNumbers && material) {
    const ml = material.toLowerCase()
    for (const rule of TIME_GROUND_RULES) {
      if (!rule.zh.test(t)) continue
      if (rule.near && !rule.near.test(t)) continue  // 不在「会害人」的语境里，放过
      if (rule.zh.test(material)) continue      // 素材本身就是中文的，直接放过
      if (rule.en.test(ml)) continue
      return { ok: false, reason: `输出里出现了素材里没有的时间说法（${rule.label}），可能是编的` }
    }
    // 中文数字写的月/日（「十一月」「十四号」），换算成数字后同样要能在素材里找到
    for (const m of (t.match(/([零一二三四五六七八九十]{1,3})\s*([月日号])/g) || [])) {
      const mm = m.match(/([零一二三四五六七八九十]{1,3})\s*([月日号])/)
      const n = zhNumeral(mm[1])
      if (n == null) continue
      const isMonth = mm[2] === '月'
      const okDigit = new RegExp(`(^|\\D)0?${n}(\\D|$)`).test(material)
      const okName = isMonth && new RegExp(MONTH_NAMES[n - 1] || '\\u0000', 'i').test(ml)
      const okZh = material.includes(mm[1] + mm[2])
      if (!okDigit && !okName && !okZh) {
        return { ok: false, reason: `输出里出现了素材里没有的日期「${m}」，可能是编的` }
      }
    }
  }

  // g) 数字接地：输出里的「数字串」必须在素材里出现过。
  //    这是拦住「把 Friday 5pm 编成 Wednesday 3pm」的最后一道闸。
  //    只查 2 位以上的数字和显式年份，1 位数（「第 3 点」「共 5 条」）是排版用的，放过。
  if (checkNumbers && material) {
    const matNums = new Set((material.match(/\d+/g) || []))
    const ml2 = material.toLowerCase()
    // 「October」写成「10 月」是我们希望它做的翻译，不是幻觉。
    // 所以先把素材里出现过的英文月份名换算成月份数字，一并当作「素材里有的数字」。
    const monthNums = new Set()
    MONTH_NAMES.forEach((name, i) => { if (new RegExp('\\b' + name, 'i').test(ml2)) monthNums.add(String(i + 1)) })
    for (const n of (t.match(/\d+/g) || [])) {
      // 1 位数放过：「第 3 点」「共 5 条」这种是排版用的，不是事实
      if (n.length < 2) continue
      if (matNums.has(n)) continue
      // 只有「<数字>月」这种写法才吃月份豁免，避免把任意的 10/11/12 都放过
      if (monthNums.has(n) && new RegExp(n + '\\s*月').test(t)) continue
      // 唯一允许的宽松情况：素材里有个**更长**的数字包含它（素材 "2026"，输出 "26"）。
      // 反方向（输出 "11" 而素材只有 "1"）**不能**放过 —— 那正是编造日期的典型形态。
      let found = false
      for (const m of matNums) {
        if (m.length > n.length && m.includes(n)) { found = true; break }
      }
      if (!found) return { ok: false, reason: `输出里出现了素材里没有的数字「${n}」，可能是编的` }
    }
  }

  return { ok: true, reason: '' }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function mmss (ms) {
  const s = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

function at (t) { return '`[' + mmss(t) + ']`' }

function trimTail (s, n) {
  const t = String(s || '').trim()
  if (t.length <= n) return t
  return t.slice(0, n).replace(/\s+\S*$/, '') + '…'
}

function titleCase (s) {
  return String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

// 把模型输出切成「条目」：允许 `1. xxx` / `- xxx` / 裸行 三种写法
function toItems (text) {
  return String(text || '')
    .split('\n')
    .map((x) => x.replace(/^\s*(?:[-*•]|\d+[.、)）]|[（(]\d+[）)])\s*/, '').trim())
    .filter((x) => x.length >= 2)
}

// ---------------------------------------------------------------------------
// polishNotes —— 核心：在抽取式事实之上做自然语言合成
// ---------------------------------------------------------------------------
//
// 【整体策略】
// 分批、小任务、逐节回退。每一小节都是一次独立的 generate：
//   素材（来自 analysis，全是真的） -> 一个很具体的小任务 -> sanity check -> 用或不用。
// 任何一节失败都只影响那一节，其余照常；全部失败就等价于原来的抽取式笔记。
//
// 【哪些小节交给模型，哪些不交】
//   交：一句话总结、脉络里每段的中文说明、定义的中文解释、考点的组织、
//       枚举整理成步骤、术语表的中文释义、课后行动清单的开头一句。
//   不交：公式/例题、作业的日期、课堂问答的原话、可能听错的地方、我的标记。
//       ——这些一旦被改写就可能出错，而且它们本来就是「照抄原话 + 时间戳」最有价值。
//       特别是日期：小模型把 "next Friday" 写成「下周三」是真实会发生的，
//       所以作业小节永远以抽取式为准，模型最多在旁边加一句提醒。

const SECTION_ORDER = [
  'summary', 'outline', 'definitions', 'emphases', 'formulas',
  'enumerations', 'tasks', 'qa', 'glossary', 'suspects', 'marks', 'todo'
]

/**
 * 把 analyze() 的结果变成一份「读起来像人话」的中文 Markdown 笔记。
 *
 * @param {Object} analysis analyze() 的返回值
 * @param {Object} [opts]
 * @param {Object} [opts.ctx]   { course, teacher, title, startedAt }
 * @param {LocalLLM} [opts.llm] 已经 new 好的引擎；不传 / 传 null 就直接走抽取式
 * @param {(step:{key:string,label:string,index:number,total:number,status:string,reason?:string})=>void} [opts.onStep]
 * @param {number} [opts.maxCalls=16]   最多调用模型多少次（防止一节 200 页的课跑一小时）
 * @param {number} [opts.budgetMs=480000] 整体时间预算，超了就把剩下的小节全部走抽取式
 * @returns {Promise<string>} Markdown
 */
export async function polishNotes (analysis, opts = {}) {
  const ctx = opts.ctx || {}
  const llm = opts.llm || null
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : null
  const maxCalls = Number(opts.maxCalls) > 0 ? Number(opts.maxCalls) : 16
  const budgetMs = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 480000
  const started = Date.now()

  if (!analysis || analysis.empty || !analysis.sentences || !analysis.sentences.length) {
    return '（这节课没有记录到可分析的内容。）'
  }

  // 没有模型：完全等价于原来的离线抽取式笔记，直接交给 localnlp 自己渲染。
  if (!llm) return fallbackNotes(analysis, opts)

  const stats = { calls: 0, ok: 0, failed: 0 }
  const step = (key, label, index, total, status, reason) => {
    if (!onStep) return
    try { onStep({ key, label, index, total, status, reason: reason || '' }) } catch (_) {}
  }

  // 统一的「调用 + 检查 + 回退」包装。这是本文件唯一允许调用模型的地方。
  const ask = async (key, label, index, prompt, material, checkOpts, maxTokens) => {
    if (stats.calls >= maxCalls) {
      step(key, label, index, SECTION_ORDER.length, 'fallback', '已用完模型调用次数')
      return null
    }
    if (Date.now() - started > budgetMs) {
      step(key, label, index, SECTION_ORDER.length, 'fallback', '已用完时间预算')
      return null
    }
    step(key, label, index, SECTION_ORDER.length, 'start')
    stats.calls++
    let out = ''
    try {
      // 先做结构清理（去 HTML 标签 / 标题 / 分隔线），再做可信度检查。
      // 顺序不能反：checkOutput 的长度和重复判断应该针对「真正会写进笔记的那段文字」。
      out = sanitizeModelText(await llm.generate(prompt, { maxTokens: maxTokens || 300, temperature: 0.3 }))
    } catch (err) {
      stats.failed++
      const reason = String((err && err.message) || err)
      step(key, label, index, SECTION_ORDER.length, 'fallback', reason)
      return null
    }
    const chk = checkOutput(out, { material, ...(checkOpts || {}) })
    if (!chk.ok) {
      stats.failed++
      console.warn(`[llm] ${label} 的输出没通过检查：${chk.reason}`)
      step(key, label, index, SECTION_ORDER.length, 'fallback', chk.reason)
      return null
    }
    stats.ok++
    step(key, label, index, SECTION_ORDER.length, 'ok')
    return out.trim()
  }

  const { meta, topics, definitions, emphases, tasks, enumerations, formulas, terms, qa, suspects, marks } = analysis
  const L = []
  const mins = Math.round(meta.durationMs / 60000)

  /* ---- 标题 ---- */
  const title = ctx.title || ctx.course || '课堂笔记'
  L.push(`# ${title}`)
  const head = []
  if (ctx.course && ctx.course !== title) head.push(`课程：${ctx.course}`)
  if (ctx.teacher) head.push(`老师：${ctx.teacher}`)
  if (ctx.startedAt) head.push(`时间：${ctx.startedAt}`)
  head.push(`时长：约 ${mins} 分钟`)
  head.push(`转写 ${meta.sentenceCount} 句`)
  L.push(head.join('　|　'))
  L.push('')

  /* ---- 1. 一句话总结 ---- */
  {
    const topTopics = topics.slice(0, 6).map((t, i) => `${i + 1}. ${t.title}`)
    const topTerms = terms.slice(0, 8).map((t) => titleCase(t.term))
    const bestSents = analysis.sentences.slice().sort((a, b) => b.score - a.score).slice(0, 4)
      .sort((a, b) => a.t - b.t).map((s) => '- ' + trimTail(s.text, 180))
    const material = [
      `课程时长：约 ${mins} 分钟，共 ${meta.sentenceCount} 句转写。`,
      topTopics.length ? '主题段落：\n' + topTopics.join('\n') : '',
      topTerms.length ? '高频术语：' + topTerms.join('、') : '',
      bestSents.length ? '最关键的几句原话：\n' + bestSents.join('\n') : ''
    ].filter(Boolean).join('\n\n')

    const out = await ask('summary', '一句话总结', 0,
      `【素材】\n${material}\n\n【任务】\n用 2~3 句中文写一段总结，说明这节课讲了什么、主线怎么走。` +
      `只能用素材里的信息。不要列清单，写成连贯的一段话。不要超过 150 字。`,
      // maxLen 要和上面要求的字数对得上：模型一旦开始超长输出，多半就是在自由发挥了。
      // 实测 Qwen2.5-0.5B 写超长时会顺手编出素材里没有的例子，卡死长度是最便宜的拦截。
      material, { minLen: 20, maxLen: 320 }, 220)

    L.push('## 一句话总结')
    if (out) {
      L.push(out)
    } else {
      // 回退：原来的抽取式写法
      let one = `本节课约 ${mins} 分钟，共 ${meta.sentenceCount} 句转写`
      if (topics.length > 1) one += `，自动切分为 ${topics.length} 个主题段`
      one += '。'
      if (topics.length) one += `主线是 **${topics.slice(0, 4).map((t) => t.title).join(' → ')}**。`
      if (topTerms.length) one += `本节最核心的术语：${topTerms.slice(0, 6).map((t) => '`' + t + '`').join('、')}。`
      L.push(one)
    }
    L.push('')
  }

  /* ---- 2. 本节脉络：每段一句中文说明 + 原话保留 ---- */
  if (topics.length) {
    L.push('## 本节脉络')
    // 只对最长的几段花模型算力，短段落直接抽取式
    const worth = topics.slice().sort((a, b) => b.sentenceCount - a.sentenceCount).slice(0, 5)
    const worthIdx = new Set(worth.map((t) => t.index))

    for (const tp of topics) {
      L.push(`\n**${tp.index + 1}. ${tp.title}** ${at(tp.tStart)} – ${at(tp.tEnd)}　（${tp.sentenceCount} 句）`)
      if (worthIdx.has(tp.index) && tp.keySentences.length) {
        const material = tp.keySentences.map((k, i) => `${i + 1}. ${trimTail(k.text, 200)}`).join('\n')
        const out = await ask('outline', `脉络第 ${tp.index + 1} 段`, 1,
          `【素材】\n这一段课堂转写的关键句：\n${material}\n\n【任务】\n用 1~2 句中文说明这一段在讲什么。` +
          `只能用素材里的信息，不许补充背景知识。不要超过 80 字，不要分点。`,
          // 同上：要求「不超过 80 字」，就把上限卡在 170 字符。
          // 实测放到 300 时，0.5B 会在这里编出一个素材里根本没有的例题。
          material, { minLen: 12, maxLen: 170 }, 160)
        if (out) L.push(`\n> ${out.replace(/\n+/g, ' ')}`)
      }
      for (const k of tp.keySentences) {
        L.push(`- ${at(k.t)} ${trimTail(k.text, 220)}`)
        if (k.zh) L.push(`  - ${k.zh}`)
      }
    }
    L.push('')
  }

  /* ---- 3. 核心概念与定义：每 4 条一批，让模型用中文讲清楚 ---- */
  if (definitions.length) {
    L.push('## 核心概念与定义')
    const picked = definitions.slice(0, 12)
    for (let i = 0; i < picked.length; i += 4) {
      const batch = picked.slice(i, i + 4)
      const material = batch
        .map((d, k) => `${k + 1}. 术语：${d.term}\n   老师原话：${trimTail(d.def || d.text, 220)}`)
        .join('\n')
      const out = await ask('definitions', `定义第 ${Math.floor(i / 4) + 1} 批`, 2,
        `【素材】\n${material}\n\n【任务】\n把上面 ${batch.length} 条定义分别用中文解释清楚。` +
        `严格按「序号. 解释」的格式输出 ${batch.length} 行，每行一条，每条不超过 60 字。` +
        `只能用该条素材里的信息，不许引入别的知识。某条素材说不清楚就写「素材不足，无法确认」。`,
        material, { minLen: 10, maxLen: 1200 }, 360)

      const items = out ? toItems(out) : []
      const usable = items.length === batch.length
      if (out && !usable) console.warn(`[llm] 定义批次条数对不上（要 ${batch.length} 条，给了 ${items.length} 条），退回抽取式`)

      batch.forEach((d, k) => {
        L.push(`- ${at(d.t)} **${titleCase(d.term)}**`)
        L.push(`  - 原话：${trimTail(d.text, 220)}`)
        if (usable) L.push(`  - 中文解释：${items[k]}`)
        else if (d.zh) L.push(`  - 中文：${d.zh}`)
      })
    }
    L.push('')
  }

  /* ---- 4. 重点与可能的考点：把零散要点组织成中文清单 ---- */
  if (emphases.length) {
    const list = emphases.slice(0, 12).sort((a, b) => a.t - b.t)
    const material = list.map((e, k) => `${k + 1}. [${e.tag}] ${trimTail(e.text, 200)}`).join('\n')
    const out = await ask('emphases', '重点与考点', 3,
      `【素材】\n老师专门强调过的句子：\n${material}\n\n【任务】\n把它们整理成一份中文考点清单，` +
      `每条以「- 」开头，一行一条，最多 ${Math.min(8, list.length)} 条，每条不超过 50 字。` +
      `意思相近的可以合并。只能用素材里的信息，不许加自己的判断。`,
      material, { minLen: 12, maxLen: 1200 }, 380)

    L.push('## 重点与可能的考点')
    if (out) {
      L.push(out)
      L.push('')
      L.push('<details><summary>对应的老师原话（点开核对）</summary>')
      L.push('')
      for (const e of list) L.push(`- ${at(e.t)} **[${e.tag}]** ${trimTail(e.text, 220)}`)
      L.push('')
      L.push('</details>')
    } else {
      for (const e of list) {
        L.push(`- ${at(e.t)} **[${e.tag}]** ${trimTail(e.text, 220)}`)
        if (e.zh) L.push(`  - ${e.zh}`)
      }
    }
    L.push('')
  }

  /* ---- 5. 公式 / 例题：**故意不给模型碰** ---- */
  // 小模型改写公式几乎必错（会把 1/2 写成 2、把 squared 丢掉）。
  // 这一节永远是原话 + 时间戳。
  if (formulas.length) {
    L.push('## 公式 / 例题 / 推导')
    L.push('> 这一节保留老师原话，没有让本地 AI 改写 —— 小模型改写公式很容易算错。')
    for (const f of formulas.slice(0, 10).sort((a, b) => a.t - b.t)) {
      L.push(`- ${at(f.t)} ${trimTail(f.text, 220)}`)
      if (f.zh) L.push(`  - ${f.zh}`)
    }
    L.push('')
  }

  /* ---- 6. 分点与步骤：整理成中文步骤 ---- */
  if (enumerations.length) {
    L.push('## 课堂上的分点与步骤')
    for (const g of enumerations.slice(0, 4)) {
      L.push(`\n**${titleCase(g.title)}** ${at(g.t)}`)
      const material = g.items.map((it) => `${it.ord}. ${trimTail(it.text, 200)}`).join('\n')
      const out = await ask('enumerations', `分点「${trimTail(g.title, 20)}」`, 5,
        `【素材】\n${material}\n\n【任务】\n把上面的分点整理成中文步骤，` +
        `按「序号. 内容」输出 ${g.items.length} 行，顺序和素材一致，每条不超过 50 字。` +
        `只能用素材里的信息。`,
        material, { minLen: 10, maxLen: 1000 }, 320)

      const items = out ? toItems(out) : []
      if (items.length === g.items.length) {
        g.items.forEach((it, k) => {
          L.push(`${k + 1}. ${items[k]}`)
          L.push(`   - 原话 ${at(it.t)}：${trimTail(it.text, 180)}`)
        })
      } else {
        let n = 1
        for (const it of g.items) {
          L.push(`${n}. ${at(it.t)} ${it.text}`)
          if (it.zh) L.push(`   - ${it.zh}`)
          n++
        }
      }
    }
    L.push('')
  }

  /* ---- 7. 作业 / 截止日期：**日期永远以抽取为准** ---- */
  if (tasks.length) {
    L.push('## 作业、截止日期、考试通知')
    L.push('> 日期和原话直接取自转写稿，没有让本地 AI 改写 —— 这是最不能出错的地方。')
    const sorted = tasks.slice().sort((a, b) => (b.urgent - a.urgent) || (a.t - b.t))
    for (const x of sorted.slice(0, 16)) {
      const when = x.dates.length
        ? x.dates.map((d) => `**${d.zh}**（${d.raw}）`).join('、')
        : '（没说具体时间）'
      L.push(`- 【${x.tags.join('/')}】${when} — ${at(x.t)}`)
      L.push(`  - 原话：${trimTail(x.text, 220)}`)
      if (x.zh) L.push(`  - 中文：${x.zh}`)
    }
    L.push('')
  }

  /* ---- 8. 课堂问答：原话 ---- */
  if (qa.length) {
    L.push('## 课堂问答')
    for (const p of qa) {
      L.push(`- ${at(p.q.t)} **问：** ${p.q.text}`)
      if (p.q.zh) L.push(`  - ${p.q.zh}`)
      if (p.a) {
        L.push(`  - **答：** ${p.a.text}`)
        if (p.a.zh) L.push(`    - ${p.a.zh}`)
      }
    }
    L.push('')
  }

  /* ---- 9. 术语表：让模型给中文释义，但只认素材里的词 ---- */
  const glossary = terms.filter((t) => t.count >= 2 || t.n === 2).slice(0, 20)
  if (glossary.length) {
    L.push('## 生词与术语对照表')
    const defMap = new Map(definitions.map((d) => [d.term.toLowerCase(), d]))
    const zhMap = new Map()

    for (let i = 0; i < glossary.length; i += 8) {
      const batch = glossary.slice(i, i + 8)
      // 给每个词配一句它出现过的原话，模型才有的可依据
      const ctxLine = (term) => {
        const s = analysis.sentences.find((x) => x.text.toLowerCase().includes(term.toLowerCase()))
        return s ? trimTail(s.text, 120) : ''
      }
      const material = batch
        .map((g) => `${g.term} —— 出现在：${ctxLine(g.term) || '（本节多次出现）'}`)
        .join('\n')
      const out = await ask('glossary', `术语第 ${Math.floor(i / 8) + 1} 批`, 8,
        `【素材】\n${material}\n\n【任务】\n给上面每个英文术语一个简短的中文说法或解释，` +
        `严格按「英文术语 :: 中文」的格式输出 ${batch.length} 行，中文不超过 20 字。` +
        `只能参考该词在素材里的用法。拿不准就写「本节未充分说明」。`,
        // 这一节的输出天然有一半是英文术语本身（`term :: 中文`），
        // 所以中文比例门槛要放低，否则正常输出也会被误杀
        material, { minLen: 6, maxLen: 800, minCjkRatio: 0.1 }, 300)

      if (out) {
        for (const line of out.split('\n')) {
          const m = line.match(/^\s*(?:[-*]\s*)?(.+?)\s*(?:::|：:|::|：|:)\s*(.+?)\s*$/)
          if (!m) continue
          const key = m[1].trim().toLowerCase().replace(/^\d+[.、)）]\s*/, '')
          const val = m[2].trim()
          // 接地：模型只能给「我给它的那几个词」配释义，多出来的一律丢掉
          if (batch.some((g) => g.term.toLowerCase() === key)) zhMap.set(key, trimTail(val, 40))
        }
      }
    }

    for (const g of glossary) {
      const zh = zhMap.get(g.term.toLowerCase()) || ''
      const d = defMap.get(g.term.toLowerCase())
      const note = d ? '老师在 `[' + mmss(d.t) + ']` 下过定义' : (g.n === 2 ? '固定搭配' : '本节高频')
      L.push(`- **${titleCase(g.term)}**${zh ? '：' + zh : ''}　×${g.count}　_${note}_`)
    }
    L.push('')
  }

  /* ---- 10. 可能听错的地方：原样保留 ---- */
  if (suspects && suspects.length) {
    L.push('## 可能听错的地方（建议回听）')
    for (const s of suspects) {
      L.push(`- ${at(s.t)} 【${s.reason}】${s.detail ? s.detail + '　' : ''}${s.text}`)
    }
    L.push('')
  }

  /* ---- 11. 我在课上标记的地方 ---- */
  if (marks && marks.length) {
    L.push('## 我在课上标记的地方')
    for (const m of marks.slice(0, 30)) {
      L.push(`- ${at(m.t)} ${m.kind === 'note' ? '📝 ' : '⭐ '}${m.text}`)
    }
    L.push('')
  }

  /* ---- 12. 课后行动清单 ---- */
  {
    L.push('## 课后行动清单')
    const todo = []
    for (const x of tasks.filter((t) => t.urgent).slice(0, 8)) {
      const when = x.dates.length ? x.dates[0].zh : '时间待确认'
      todo.push(`- [ ] 【${x.tags[0]}】${when}：${trimTail(x.text, 90)}`)
    }
    for (const d of definitions.slice(0, 5)) {
      todo.push(`- [ ] 背下 **${titleCase(d.term)}** 的定义（${at(d.t)}）`)
    }
    if (emphases.length) todo.push(`- [ ] 把「重点与可能的考点」里的 ${Math.min(12, emphases.length)} 条过一遍`)
    if (glossary.length) todo.push(`- [ ] 查清术语表里还不认识的词（共 ${glossary.length} 个）`)
    if (suspects && suspects.length) todo.push(`- [ ] 回听「可能听错的地方」列出的 ${suspects.length} 处，确认没记错`)
    if (!todo.length) todo.push('- [ ] 通读本节脉络，把没听懂的段落回听一遍')
    L.push(...todo)
    L.push('')
  }

  /* ---- 页脚：如实交代这份笔记是怎么来的 ---- */
  const modelLabel = (findLLMModel(llm.modelId) || {}).label || llm.modelId
  L.push('---')
  L.push('')
  L.push(
    `> 这份笔记由**本机离线生成**（没有联网、没有用任何 API Key）。` +
    `事实部分（定义、考点、作业、日期、术语）由本地规则从转写稿里抽取，` +
    `中文叙述部分由本地小模型 \`${modelLabel}\`（${llm.device || '未知后端'} / ${llm.dtype || '未知精度'}）改写。`
  )
  L.push(
    `> 本次共请求模型 ${stats.calls} 次，${stats.ok} 次采用、${stats.failed} 次因输出不可信被丢弃并退回原始摘录。` +
    `小模型可能把话说得不准，**考试相关的内容请对照上面的老师原话和时间戳再确认一遍**。`
  )
  L.push('')

  return L.join('\n')
}

// 完全退回 localnlp 的抽取式笔记。localnlp 是懒加载的 —— 本模块可以脱离它单独测试。
async function fallbackNotes (analysis, opts) {
  try {
    const mod = await import('./localnlp.js')
    return await mod.buildNotes(analysis, { ctx: opts.ctx || {}, translateFn: opts.translateFn || null })
  } catch (err) {
    console.warn('[llm] 退回 localnlp.buildNotes 失败：', err)
    return '（本地 AI 不可用，且抽取式笔记生成失败。请检查控制台。）'
  }
}

// ---------------------------------------------------------------------------
// answerQuestion —— 基于本节课内容的问答（RAG 风格）
// ---------------------------------------------------------------------------
//
// 流程：检索 -> 拼素材 -> 让模型只根据素材回答 -> sanity check -> 不过就直接把
// 检索到的片段摆给用户看（摆原话总比编答案强）。
//
// 检索不用向量（那要再下一个 embedding 模型），用「关键词重合 + 结构加权」：
//   · 问题里出现「作业 / due / deadline / 交」-> tasks 全部加进候选
//   · 出现「重点 / 考 / exam」-> emphases 加权
//   · 出现「定义 / 是什么 / what is」-> definitions 加权
//   · 其余走词重合打分
// 对一节课（几百到几千句）这个量级，纯 JS 打分是毫秒级的，没必要上向量。

const QUESTION_STOP = new Set(
  ('the a an of to in on at is are was were be been do does did what which who whom how why when where ' +
   'and or but if then this that these those for with about from as it its i we you he she they me my our ' +
   '请 问 的 了 吗 呢 是 在 有 和 与 或 把 被 给 这 那 些 个 什么 怎么 为什么 哪 哪些 什么时候 老师 这节课 本节课 课上')
    .split(/\s+/).filter(Boolean)
)

function qTokens (s) {
  const out = []
  const str = String(s || '').toLowerCase()
  for (const w of (str.match(/[a-z][a-z'’-]{1,}/g) || [])) {
    if (w.length < 3 || QUESTION_STOP.has(w)) continue
    out.push(w)
  }
  for (const c of (str.match(CJK_RE) || [])) {
    if (QUESTION_STOP.has(c)) continue
    out.push(c)
  }
  return out
}

/**
 * 让学生对着这节课提问。完全离线。
 *
 * @param {Object} args
 * @param {string} args.question 学生的问题（中文或英文都行）
 * @param {Object} args.analysis analyze() 的结果
 * @param {Object} [args.session] { ctx, segments } —— 可选，用来补课程名和已有的中文翻译
 * @param {LocalLLM} [args.llm]  没有就只返回检索结果
 * @param {number} [args.topK=8] 检索多少条片段
 * @returns {Promise<string>} Markdown 回答
 */
export async function answerQuestion ({ question, analysis, session, llm, topK } = {}) {
  const q = String(question || '').trim()
  if (!q) return '（请先输入一个问题。）'
  if (!analysis || analysis.empty || !analysis.sentences || !analysis.sentences.length) {
    return '（这节课还没有可供查询的内容。）'
  }

  const K = Number(topK) > 0 ? Number(topK) : 8
  const ql = q.toLowerCase()
  const qt = qTokens(q)
  const qset = new Set(qt)

  // --- 意图识别（很粗，但够用）---
  const wantTask = /\b(homework|assignment|due|deadline|submit|hand\s*in|exam|quiz|midterm|final)\b/.test(ql) ||
    /作业|截止|什么时候交|交上去|deadline|考试|期中|期末|小测/.test(q)
  const wantEmph = /\b(important|key|focus|exam|test)\b/.test(ql) || /重点|考点|要考|重要/.test(q)
  const wantDef = /\b(what\s+is|define|definition|meaning)\b/.test(ql) || /是什么|定义|什么意思|怎么理解/.test(q)

  // --- 候选片段打分 ---
  const hits = []
  // bonus > 0 表示这条是被「意图」选中的（作业 / 考点 / 定义 / 我的标记），
  // 即使一个词都没对上也要保留；普通句子必须**至少命中一个关键词**才进候选，
  // 否则问一个八竿子打不着的问题也会捞回一堆句子，然后模型就开始瞎编。
  // tie 只在已经命中关键词时用来排序（句子本身的重要度），不能靠它把句子捞进来
  const pushHit = (t, text, zh, bonus, tag, tie) => {
    // 连中文翻译一起匹配：学生多半用中文提问，而转写稿是英文的
    const tl = (String(text) + ' ' + String(zh || '')).toLowerCase()
    let hit = 0
    for (const w of qset) if (tl.includes(w)) hit += w.length > 1 ? 1.2 : 0.6
    if (hit <= 0 && !(bonus > 0)) return
    hits.push({
      t,
      text: trimTail(text, 260),
      zh: zh || '',
      score: hit + (bonus || 0) + (hit > 0 ? (tie || 0) : 0),
      tag: tag || ''
    })
  }

  for (const s of analysis.sentences) {
    if (s.words < 4) continue
    pushHit(s.t, s.text, s.zh, 0, '', (s.score || 0) * 0.15)
  }
  if (wantTask) for (const x of analysis.tasks) {
    pushHit(x.t, x.text, x.zh, 4, '作业/截止：' + (x.dates.length ? x.dates.map((d) => d.zh).join('、') : '未说时间'))
  }
  if (wantEmph) for (const e of analysis.emphases.slice(0, 12)) pushHit(e.t, e.text, e.zh, 3, '重点[' + e.tag + ']')
  if (wantDef) for (const d of analysis.definitions) pushHit(d.t, d.text, d.zh, 3, '定义：' + d.term)
  // 我在课上打的标记：只有问到标记/没听懂时才无条件带上，否则也要命中关键词，
  // 不然「这里没听懂」会挂在每一个问题的依据里
  const wantMark = /标记|没听懂|没跟上|\bmark(ed)?\b/i.test(q)
  for (const m of (analysis.marks || [])) pushHit(m.t, m.text, '', wantMark ? 3 : 0, '我的标记', 1.5)

  // 同一时间点的重复片段去掉
  const seen = new Set()
  const top = hits.sort((a, b) => b.score - a.score).filter((h) => {
    const k = h.t + '|' + h.text.slice(0, 40)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).slice(0, K).sort((a, b) => a.t - b.t)

  if (!top.length) {
    return '这节课的转写里没有找到和这个问题相关的内容。换个说法再问一次，或者直接回听录音。'
  }

  const refBlock = top.map((h) => `- ${at(h.t)} ${h.tag ? '【' + h.tag + '】' : ''}${h.text}`).join('\n')

  // 没有模型：直接把检索到的原话摆出来。摆原话永远比编答案强。
  if (!llm) {
    return `**没有启用本地 AI，下面是转写稿里和你的问题最相关的片段：**\n\n${refBlock}`
  }

  const material = top.map((h, i) => `${i + 1}. [${mmss(h.t)}] ${h.text}${h.zh ? '（中文：' + h.zh + '）' : ''}`).join('\n')
  const course = (session && session.ctx && session.ctx.course) || ''

  let out = ''
  try {
    out = await llm.generate(
      `【素材】\n以下是${course ? '《' + course + '》' : '这节课'}转写稿里和问题相关的片段（方括号里是录音时间）：\n${material}\n\n` +
      `【问题】\n${q}\n\n` +
      `【任务】\n只根据上面的素材，用中文回答这个问题，不超过 120 字。` +
      `素材里没有答案就直接说「这节课的录音里没有讲到这个」，不要猜，不要补充课外知识。` +
      `涉及时间、数字时必须原样照抄素材里的写法。`,
      { maxTokens: 260, temperature: 0.2 }
    )
    // 回答会直接拼进 Markdown（外面还包了一层 <details>），必须先去掉结构性标记
    out = sanitizeModelText(out)
  } catch (err) {
    console.warn('[llm] 问答生成失败：', err)
    out = ''
  }

  const chk = out ? checkOutput(out, { material: material + ' ' + q, minLen: 8, maxLen: 800 }) : { ok: false, reason: '生成失败' }
  if (!chk.ok) {
    console.warn(`[llm] 问答输出没通过检查：${chk.reason}`)
    return `**本地 AI 这次没给出可信的回答（${chk.reason}），下面是转写稿里最相关的片段，请自己判断：**\n\n${refBlock}`
  }

  return `${out.trim()}\n\n<details><summary>依据（转写稿原文 ${top.length} 处）</summary>\n\n${refBlock}\n\n</details>`
}

export default {
  LLM_MODELS,
  LLM_MODEL_FALLBACKS,
  findLLMModel,
  configureRuntime,
  ortIsLocal,
  webgpuAvailable,
  llmAvailable,
  recommendModel,
  LocalLLM,
  GROUND_RULES,
  checkOutput,
  sanitizeModelText,
  polishNotes,
  answerQuestion
}
