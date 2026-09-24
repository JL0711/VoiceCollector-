// 本地模型 / ONNX Runtime 路径：whisper.js、mt.js、translate-llm.js 共用。
//
// 为什么要抽出来：同一个坑以前修了一个漏了一个。
//   · whisper.js 把 wasmPaths 设成 { wasm, mjs } 对象 → 本地加载，正常。
//   · mt.js 设的是字符串前缀 → 开着 env.useWasmCache 时，transformers 的 wasm 预加载
//     只认对象形式，字符串形式它会自己拼出 jsDelivr 的地址 —— 翻译引擎一直在从 CDN 拉 wasm。
//   · 模型文件同理：transformers 加载 fp16 之前会先探测一次 fp32 的 encoder_model.onnx，
//     我们没内置 fp32 → 本地 404 → allowRemoteModels=true 就悄悄去 huggingface.co 拿。
// 有网时这些全都看不出来；网络差时会卡住，断网时直接起不来。
// 2026-09-24 用「网络监视」抓到的：录一节课往外发了 4 个请求。

const ORT_DIR = new URL('../vendor/transformers/ort/', import.meta.url).href
const MODELS_DIR = new URL('../models/', import.meta.url).href
export const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0'
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`

// 复刻 transformers 4.3.0 env.js 里的 isSafariBelow26()。
// 它决定用哪个 ort wasm 变体：Safari 26 以下且没有 WebGPU 时不能用 asyncify 版本。
export function isSafariBelow26 () {
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
export async function exists (url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'force-cache' })
    return res.ok
  } catch (_) {
    return false
  }
}

/**
 * ORT 的 wasm 工厂(.mjs)和二进制(.wasm)在哪。**必须返回对象形式**（见文件顶部）。
 * 本地有就用本地；本地没有（比如网页版被人单独拷走了 js）才回退 jsDelivr。
 */
export async function ortWasmPaths (hasWebGPU) {
  const suffix = isSafariBelow26() && !hasWebGPU ? '' : '.asyncify'
  const name = `ort-wasm-simd-threaded${suffix}`
  const wasm = `${ORT_DIR}${name}.wasm`
  const mjs = `${ORT_DIR}${name}.mjs`
  const [okWasm, okMjs] = await Promise.all([exists(wasm), exists(mjs)])
  if (okWasm && okMjs) return { wasm, mjs, local: true }
  return { wasm: `${ORT_CDN}${name}.wasm`, mjs: `${ORT_CDN}${name}.mjs`, local: false }
}

// 这个模型是不是已经打包在 web/models/ 里（看 config.json 在不在）
const _bundled = new Map()
export async function isBundled (modelId) {
  if (_bundled.has(modelId)) return _bundled.get(modelId)
  const ok = await exists(MODELS_DIR + modelId + '/config.json')
  _bundled.set(modelId, ok)
  return ok
}
