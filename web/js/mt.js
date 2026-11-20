// mt.js —— 完全离线的本地机器翻译引擎（英 → 中）
//
// 为什么要有这个文件：
//   translate.js 走的是 Chrome 138+ 内置翻译 API 或者云端 AI（要 API Key）。
//   但 Electron 里的 Chromium **没有** 内置翻译 API，而晗晗也不会去申请任何 Key。
//   所以桌面版必须自带一个翻译模型 —— 就是这里的 LocalMT。
//   目标：不填任何 Key、完全断网，也能把英文课堂内容翻成中文。
//
// 技术选型（都是实际核对过的，不是凭记忆写的）：
//   模型  Xenova/opus-mt-en-zh（Helsinki-NLP OPUS-MT 英中模型的 ONNX 版本）
//         已核实仓库存在，根目录有 config.json / tokenizer.json / tokenizer_config.json /
//         generation_config.json / source.spm / target.spm / vocab.json，
//         onnx/ 目录下有各种 dtype 的权重（体积见下面 MT_MODELS）。
//   库    @huggingface/transformers 4.3.0，从 vendor 目录相对路径 import。
//         translation pipeline 的真实签名（读 types/pipelines/translation.d.ts 与
//         src/pipelines/text2text-generation.js 确认）：
//           const t = await pipeline('translation', repo, { dtype, device, progress_callback });
//           const out = await t(texts, generate_kwargs);   // -> [{ translation_text }]
//         generate_kwargs 是**平铺的一层**，max_new_tokens / num_beams 直接放在这一层。
//         src_lang / tgt_lang **只对** NLLB / M2M100 / mBART 这类 tokenizer 有效
//         （它们实现了 _build_translation_inputs）；Marian（OPUS-MT）是单语向模型，
//         方向写死在权重里，**绝对不要**传 src_lang/tgt_lang，否则会被当成未知的
//         generation 参数塞进 GenerationConfig。
//
// 模型硬限制（从 config.json / tokenizer_config.json 核实）：
//   max_position_embeddings = 512，model_max_length = 512，
//   generation_config 默认 num_beams = 4（太慢，上课场景我们覆盖成 1 贪心解码）。
//   → 长句必须自己切分，见下面 splitForMT()。

import { pipeline, env } from '../vendor/transformers/transformers.min.js';
import { ortWasmPaths, isBundled } from './ort-paths.js';
import { looksDegenerate } from './glossary.js';

// ───────────────────────────────────────────────────────────────────────────
// 运行时：本地模型优先（完全离线），本地没有才去远端下载
// ───────────────────────────────────────────────────────────────────────────
// localModelPath 必须是「路径」而不是完整 URL：transformers 的 buildResourcePaths 里用
// isValidUrl(localPath, ['http:','https:']) 判断，传完整 URL 会直接跳过本地分支。
let _envReady = false;
function setupEnv() {
  if (_envReady) return;
  _envReady = true;
  try {
    env.allowLocalModels = true;
    try { env.localModelPath = new URL('../models/', import.meta.url).pathname; }
    catch (_) { env.localModelPath = '/models/'; }
    env.allowRemoteModels = true;              // 本地没有时的兜底
    env.useBrowserCache = true;
    env.useWasmCache = true;
    // remoteHost / remotePathTemplate 故意不碰：whisper.js 可能已经指到国内镜像了，
    // env 是全局共享的，这里再写一遍会把用户选的镜像覆盖掉。
    const w = env.backends && env.backends.onnx && env.backends.onnx.wasm;
    if (w) {
      // whisper.js 会把 wasmPaths 设成 { wasm, mjs } 对象（带变体选择，比这里精确）。
      // 它先跑过就别覆盖 —— 覆盖成字符串会让 transformers 的 wasm 预缓存失效。
      // wasmPaths 在 _doLoad() 里用 ortWasmPaths() 设成 { wasm, mjs } 对象。
      // ⚠️ 以前这里是字符串前缀 —— 开着 useWasmCache 时 transformers 只认对象形式，
      //    字符串会被它换成 jsDelivr 的地址，翻译引擎一直在从 CDN 拉 wasm（断网就起不来）。
      if (!w.numThreads) {
        const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
        const isolated = typeof globalThis.crossOriginIsolated !== 'undefined' && globalThis.crossOriginIsolated;
        w.numThreads = isolated ? Math.min(4, Math.max(1, Math.floor(cores / 2))) : 1;   // 省电
      }
    }
  } catch (_) {}
}

// ───────────────────────────────────────────────────────────────────────────
// 一、可选模型清单
// ───────────────────────────────────────────────────────────────────────────
// sizeMB = onnx/ 目录里该 dtype 的 encoder_model_* + decoder_model_merged_* 实测体积之和。
// transformers 4.3.0 对 Seq2Seq 只会加载这两个 session
// （src/models/session_config.js：{ model: 'encoder_model', decoder_model_merged: 'decoder_model_merged' }），
// decoder_with_past_model_* / decoder_model_*（非 merged）**不会**被下载，所以不计入体积。
// 另外还要加上根目录的 tokenizer.json 6.38MB + vocab.json 1.75MB ≈ 8MB。

export const MT_MODELS = [
  {
    id: 'opus-mt-en-zh-q8',
    repo: 'Xenova/opus-mt-en-zh',
    dtype: 'q8',
    device: 'wasm',
    label: 'OPUS-MT 英→中（轻量版，推荐）',
    sizeMB: 121,          // 52.9(encoder_quantized) + 60.2(decoder_merged_quantized) + 8(分词器)
    pair: 'en-zh',
    quality: '良好',
    joinWith: '',         // 中文不用空格拼接
    recommended: true,
    note: '8bit 量化，CPU(wasm) 就能跑，最省内存最稳。课堂逐句翻译够用。这一档的权重随安装包自带（web/models/），装好即用、全程不联网。',
  },
  {
    id: 'opus-mt-en-zh-q4f16',
    repo: 'Xenova/opus-mt-en-zh',
    dtype: 'q4f16',
    device: 'webgpu',
    label: 'OPUS-MT 英→中（WebGPU 加速版）',
    sizeMB: 168,          // 77.9 + 82.2 + 8
    pair: 'en-zh',
    quality: '良好',
    joinWith: '',
    note: '4bit 权重 + fp16 计算，需要显卡支持 WebGPU 的 fp16。比 wasm 快数倍，适合整段回顾重翻。⚠️ 这一档的权重**不在**安装包里，首次选用需要联网下载约 168MB；显卡不支持时自动退回轻量版。',
  },
  {
    id: 'opus-mt-en-zh-fp16',
    repo: 'Xenova/opus-mt-en-zh',
    dtype: 'fp16',
    device: 'webgpu',
    label: 'OPUS-MT 英→中（高精度版）',
    sizeMB: 231,          // 105 + 118 + 8
    pair: 'en-zh',
    quality: '最好',
    joinWith: '',
    note: '不量化，译文质量最接近原始模型。需要 WebGPU 且显存充足，体积也最大。⚠️ 权重**不在**安装包里，首次选用需要联网下载约 231MB。断网只能用轻量版。',
  },
];

const DEFAULT_MODEL_ID = 'opus-mt-en-zh-q8';

/** 按 id 或 HF 仓库名找到模型配置；找不到就按裸仓库名兜底。 */
function resolveModel(model) {
  if (!model) return MT_MODELS.find(m => m.id === DEFAULT_MODEL_ID);
  if (typeof model === 'object') return { ...MT_MODELS[0], ...model };
  const byId = MT_MODELS.find(m => m.id === model);
  if (byId) return byId;
  const byRepo = MT_MODELS.find(m => m.repo === model);
  if (byRepo) return byRepo;
  // 调用方直接给了一个 HF 仓库名，尊重它，但参数取保守值
  return {
    id: model, repo: model, dtype: 'q8', device: 'wasm',
    label: model, sizeMB: 0, pair: 'en-zh', quality: '未知', joinWith: '',
    note: '调用方自定义模型',
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 二、环境可用性
// ───────────────────────────────────────────────────────────────────────────

let _webgpuCache = null;
let _fp16Cache = null;

/** WebGPU 是否真的能用（不只是有 navigator.gpu，还要真的能拿到 adapter）。 */
async function hasWebGPU() {
  if (_webgpuCache !== null) return _webgpuCache;
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      _fp16Cache = false;
      return (_webgpuCache = false);
    }
    const adapter = await navigator.gpu.requestAdapter();
    _webgpuCache = !!adapter;
    // 顺手把 fp16 能力也问出来，省一次 requestAdapter。
    // 判据抄自 transformers 4.3.0 src/utils/dtypes.js 的 isWebGpuFp16Supported()。
    _fp16Cache = !!(adapter && adapter.features && adapter.features.has('shader-f16'));
  } catch (_) {
    _webgpuCache = false;
    _fp16Cache = false;
  }
  return _webgpuCache;
}

/**
 * 显卡是否支持 fp16 着色器。
 * 为什么要单独探：fp16 / q4f16 两档的权重是 168MB / 231MB，
 * 显卡不支持 fp16 的话它们会在**下载完之后**才在 ORT 初始化时炸，
 * 然后我们再退回 q8 又得下 121MB —— 等于白白浪费一次大下载。
 * 所以加载前先问一句，不支持就直接走 q8。
 */
async function hasWebGpuFp16() {
  if (_fp16Cache === null) await hasWebGPU();
  return !!_fp16Cache;
}

let _availCache = null;

/**
 * 本地翻译引擎是否可用。
 * 只做轻量探测：确认 transformers 库真的被 vendor 进来了、确认有 wasm 或 WebGPU 后端。
 * **不会**下载模型（那要一百多 MB，不能在探测阶段做）。
 * @returns {Promise<boolean>}
 */
export async function mtAvailable() {
  if (_availCache !== null) return _availCache;
  try {
    // 1) 库本身必须可用。vendor 目录缺失时这里 import 阶段就已经抛错了，
    //    所以用 typeof 检查兜住"文件在但没导出 pipeline"的情况。
    if (typeof pipeline !== 'function') return (_availCache = false);

    // 2) 后端：wasm 是保底，只要浏览器支持 WebAssembly 就行。
    const wasmOk = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
    const gpuOk = await hasWebGPU();
    _availCache = wasmOk || gpuOk;
  } catch (_) {
    _availCache = false;
  }
  return _availCache;
}

// ───────────────────────────────────────────────────────────────────────────
// 三、句子切分 —— 整个文件最容易出 bug 的地方，写仔细一点
// ───────────────────────────────────────────────────────────────────────────
//
// 为什么必须切：Marian 的 max_position_embeddings = 512，tokenizer 的
// model_max_length 也是 512。transformers 的 text2text pipeline 调 tokenizer 时
// 传的是 { padding: true, truncation: true }，也就是说**超长部分会被静默截断**，
// 翻译结果会凭空少掉一大截，而且不报错 —— 这种 bug 最难发现。
//
// 而且实际上远不用喂到 512：
//   - Marian 是在句子级语料上训的，一次喂一整段，质量反而下降、容易漏译。
//   - 解码是自回归的，长度翻倍耗时超过翻倍。
//   - 课堂场景要低延迟，切碎了还能提前吐出前半句。
// 所以默认每块预算 192 token，硬上限 480（给特殊符号留余量）。

const HARD_TOKEN_LIMIT = 480;   // 512 减去特殊 token 和保险余量
const DEFAULT_CHUNK_TOKENS = 192;

// 句号后面不算句子结束的常见缩写（小写比较）。漏一个最多是多切一刀，不致命；
// 但把 "Dr. Smith" 切开会让模型丢上下文，所以常见的都列上。
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'rev', 'hon',
  'vs', 'etc', 'al', 'ca', 'cf', 'ibid', 'esp', 'approx',
  'fig', 'figs', 'eq', 'eqs', 'ref', 'refs', 'vol', 'no', 'nos', 'pp', 'ch', 'chap',
  'ed', 'eds', 'dept', 'univ', 'inc', 'ltd', 'co', 'corp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'min', 'max', 'sec', 'hr', 'hrs', 'wk', 'mo', 'yr',
  'i.e', 'e.g', 'a.m', 'p.m', 'u.s', 'u.k', 'ph.d', 'b.s', 'm.s',
]);

/** 取句号前面那个"词"，用来判断是不是缩写。 */
function tokenBefore(text, dotIndex) {
  let i = dotIndex - 1;
  // 往前吃掉字母、数字和内部的点（这样 "e.g" / "U.S" 能被整体取到）
  while (i >= 0 && /[A-Za-z0-9.]/.test(text[i])) i--;
  return text.slice(i + 1, dotIndex).toLowerCase();
}

/**
 * 第一层切分：把一段文本切成句子。
 * 规则：
 *   - 换行 = 硬边界（ASR 的分段、PPT 的分行都应该断开）。
 *   - . ! ? … 后面跟空白且下一个非空白字符像新句子开头（大写/数字/引号/括号）→ 边界。
 *   - 点号前是缩写、单个大写字母（人名缩写 J. K. Rowling）、或点号两边都是数字（3.14）→ 不切。
 *   - ; 视为软边界，只在句子过长时才用（见 splitLongUnit），这里不切。
 */
export function splitSentences(text) {
  const out = [];
  const src = String(text || '');
  let start = 0;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    // 换行：硬边界
    if (ch === '\n' || ch === '\r') {
      const piece = src.slice(start, i).trim();
      if (piece) out.push(piece);
      start = i + 1;
      continue;
    }

    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;

    // 小数 / 版本号 / 序号：3.14、v1.2
    if (ch === '.' && /[0-9]/.test(src[i - 1] || '') && /[0-9]/.test(src[i + 1] || '')) continue;

    // 缩写 / 人名首字母
    if (ch === '.') {
      const w = tokenBefore(src, i);
      if (ABBREVIATIONS.has(w)) continue;
      if (w.length === 1 && /[a-z]/.test(w)) continue;      // "J." 这种首字母
    }

    // 吃掉连续的句末标点和右引号/右括号，一起算进本句
    let j = i;
    while (j + 1 < src.length && /[.!?…"'）)\]』」”’]/.test(src[j + 1])) j++;

    const after = src.slice(j + 1);
    // 句末必须跟空白或字符串结束
    if (after && !/^\s/.test(after)) continue;

    // 下一个非空白字符要像新句子的开头
    const nextChar = after.replace(/^\s+/, '')[0];
    if (nextChar && !/[A-Z0-9"'“‘（(\[【]/.test(nextChar)) continue;

    const piece = src.slice(start, j + 1).trim();
    if (piece) out.push(piece);
    start = j + 1;
  }

  const tail = src.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

// 句子还是太长时，按优先级依次尝试的分隔符。
// 每一级都保留分隔符本身跟在前半段末尾，这样译文里的标点是模型自己生成的，
// 拼回去的时候不用我们手工补标点（补标点极容易补错）。
const SOFT_SEPARATORS = [
  /(?<=;)\s+/,                                  // 分号
  /(?<=:)\s+/,                                  // 冒号
  /\s+(?=—|--)\s*/,                             // 破折号
  /(?<=,)\s+(?=(?:and|but|or|so|because|which|while|although|however|therefore|thus)\b)/i, // 逗号 + 连词
  /(?<=,)\s+/,                                  // 任意逗号
  /\s+(?=(?:and|but|or|because|which|that|while|when|if|although|however)\b)/i,            // 裸连词
];

/**
 * 第二层切分：一个"单元"超预算时继续往下切。
 * 依次尝试软分隔符；都不行就按词硬切（宁可切坏一句，也不能被模型静默截断）。
 * @param {string} unit
 * @param {number} budget 单块 token 预算
 * @param {(s:string)=>number} count token 计数函数
 * @returns {string[]}
 */
function splitLongUnit(unit, budget, count) {
  if (count(unit) <= budget) return [unit];

  for (const sep of SOFT_SEPARATORS) {
    let parts;
    try {
      parts = unit.split(sep).map(s => s.trim()).filter(Boolean);
    } catch (_) {
      continue; // 老浏览器不支持 lookbehind 的话跳过这一级
    }
    if (parts.length < 2) continue;

    // 切开后贪心回填：相邻的小块能合并就合并，避免切得太碎丢上下文
    const packed = packByBudget(parts, budget, count);
    // 如果还有块超预算，对那一块递归继续切
    const result = [];
    for (const p of packed) {
      if (count(p) <= budget) result.push(p);
      else result.push(...splitLongUnit(p, budget, count));
    }
    return result;
  }

  // 所有软分隔符都失败（比如一长串没有标点的口语）→ 按词硬切
  const words = unit.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    // 连词都切不动（超长单词/乱码），按字符硬切，保证不超模型上限
    const step = Math.max(1, Math.floor(unit.length * budget / Math.max(1, count(unit))));
    const out = [];
    for (let i = 0; i < unit.length; i += step) out.push(unit.slice(i, i + step));
    return out;
  }
  return packByBudget(words, budget, count, ' ');
}

/** 贪心装箱：把小片按顺序塞进不超预算的块里。 */
function packByBudget(pieces, budget, count, glue = ' ') {
  const out = [];
  let cur = '';
  for (const p of pieces) {
    const merged = cur ? cur + glue + p : p;
    if (cur && count(merged) > budget) {
      out.push(cur);
      cur = p;
    } else {
      cur = merged;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 对外的完整切分：文本 → 若干块，每块保证 token 数 ≤ budget。
 * @param {string} text
 * @param {number} budget
 * @param {(s:string)=>number} count
 * @returns {string[]}
 */
export function splitForMT(text, budget = DEFAULT_CHUNK_TOKENS, count = estimateTokens) {
  const b = Math.min(Math.max(16, budget | 0), HARD_TOKEN_LIMIT);
  const sentences = splitSentences(text);
  const chunks = [];
  for (const s of sentences) {
    if (count(s) <= b) {
      chunks.push(s);
    } else {
      chunks.push(...splitLongUnit(s, b, count));
    }
  }
  // 最后一道保险：任何块都不能超过模型硬上限
  return chunks.flatMap(c => (count(c) <= HARD_TOKEN_LIMIT ? [c] : splitLongUnit(c, HARD_TOKEN_LIMIT, count)));
}

/**
 * 没有 tokenizer 时的 token 数估算（load() 之前、或 tokenizer 调用失败时用）。
 * 依据：OPUS-MT 用 SentencePiece，英文平均 1 个词 ≈ 1.3~1.5 个 token，
 * 这里按 1.6 偏保守（宁可多切一刀，也不能超限被模型静默截断）。
 *
 * 特别注意长词：光按"词数 × 1.6"算，一个 5000 字符的连写串（ASR 偶尔会
 * 吐出这种东西，或者是 URL、化学式）会被算成 2 个 token，于是永远不会被切分，
 * 到了模型那儿直接被截断。所以每个词再按字符数兜一个底：长度超过约 6 的词
 * 按 len/4 计（SentencePiece 英文大致 4 字符一个 subword）。
 * 正常单词（≤6 字符）走 1.6 那条分支，不会造成过度切分。
 */
export function estimateTokens(text) {
  const s = String(text || '').trim();
  if (!s) return 0;
  let n = 0;
  for (const w of s.split(/\s+/)) {
    n += Math.max(1.6, Math.ceil(w.length / 4));
  }
  const puncts = (s.match(/[^\w\s]/g) || []).length;
  return Math.ceil(n + puncts * 0.5) + 2;
}

// ───────────────────────────────────────────────────────────────────────────
// 四、缓存
// ───────────────────────────────────────────────────────────────────────────

/** FNV-1a 32位 × 2 轮，拼成一个足够长的十六进制串，碰撞概率可忽略。 */
function hashKey(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0')
        + (h2 >>> 0).toString(16).padStart(8, '0')
        + s.length.toString(16));
}

// 持久化层。
// 注意：db.js 当前版本（VER=2）里的 object store 只有
// teachers / courses / sessions / audio / chunks，**没有 'kv'**。
// 直接对不存在的 store 开事务会抛 NotFoundError。db.js 不归我改，
// 所以这里先探测 db.js 的 'kv' 是否可用，不可用就退回到本模块自带的
// 独立 IndexedDB（voicecollector-mt / kv）。等 db.js 加了 'kv' store，
// 这里会自动切回去用它，无需改代码。
let _persist = undefined;   // undefined = 还没探测，null = 不可用

async function getPersist() {
  if (_persist !== undefined) return _persist;
  // 1) 先试 db.js 的 'kv'
  try {
    const db = await import('./db.js');
    if (typeof db.get === 'function' && typeof db.put === 'function') {
      await db.get('kv', '__mt_probe__');   // store 不存在会在这里抛
      _persist = {
        kind: 'app-db',
        get: k => db.get('kv', k),
        // keyPath 未知，把常见几种都带上，兼容 'id' / 'key' / 'k'
        put: rec => db.put('kv', { id: rec.k, key: rec.k, k: rec.k, ...rec }),
      };
      return _persist;
    }
  } catch (_) { /* 落到下面的自带库 */ }

  // 2) 自带的独立库
  try {
    const own = await openOwnDB();
    _persist = {
      kind: 'own-db',
      get: k => idbReq(own, 'kv', 'readonly', s => s.get(k)),
      put: rec => idbReq(own, 'kv', 'readwrite', s => s.put(rec)),
    };
  } catch (_) {
    _persist = null;   // 隐私模式等场景下 IndexedDB 不可用，只走内存缓存
  }
  return _persist;
}

// 磁盘缓存的键前缀。2026-10-06 从 'mt:' 换成 'mt2:'：旧版凑批翻译（见 _batchSize）把大量乱码
// 按句子存进了缓存，迁移旧数据时还跟着搬到了新端口；不换前缀的话，升级以后同样的句子会直接读到旧乱码。
// 旧前缀的记录在 cleanupOldCache() 里清一次。
const MT_CACHE_PREFIX = 'mt2:';
let _cleanupStarted = false;
async function cleanupOldCache() {
  if (_cleanupStarted) return;
  _cleanupStarted = true;
  try {
    const db = await import('./db.js');
    if (await db.get('kv', 'mt.cache.cleaned.v2')) return;
    const all = await db.all('kv');
    for (const r of all) {
      const k = r && (r.k || r.key || r.id);
      if (typeof k === 'string' && k.startsWith('mt:')) await db.del('kv', k);
    }
    await db.put('kv', { k: 'mt.cache.cleaned.v2', id: 'mt.cache.cleaned.v2', key: 'mt.cache.cleaned.v2', at: Date.now() });
  } catch (_) { /* 清不掉也不影响翻译，只是占点空间 */ }
}

function openOwnDB() {
  return new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no indexedDB'));
    const req = indexedDB.open('voicecollector-mt', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function idbReq(db, store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    let r;
    try { r = fn(t.objectStore(store)); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(r instanceof IDBRequest ? r.result : r);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('aborted'));
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 五、主类
// ───────────────────────────────────────────────────────────────────────────

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;

/** 判断一段文本是不是已经是中文了（避免把中文再"翻"一遍）。 */
function looksChinese(s) {
  const t = String(s || '');
  if (!t) return false;
  let cjk = 0, letters = 0;
  for (const ch of t) {
    if (CJK_RE.test(ch)) cjk++;
    else if (/[A-Za-z]/.test(ch)) letters++;
  }
  return cjk > 0 && cjk >= letters;
}

export class LocalMT {
  /**
   * @param {object} [opts]
   * @param {string|object} [opts.model]      MT_MODELS 里的 id，或 HF 仓库名，或自定义配置对象
   * @param {(p:object)=>void} [opts.onProgress] 下载/加载进度 {status,file,progress,loadedMB,totalMB}
   * @param {(s:string)=>void} [opts.onStatus]   人话状态文案
   * @param {number} [opts.chunkTokens]       单块 token 预算，默认 192
   * @param {number} [opts.batchSize]         批处理大小，默认按设备自动
   * @param {boolean} [opts.persist]          是否落 IndexedDB，默认 true
   * @param {number} [opts.memCacheMax]       内存缓存条数上限，默认 4000
   */
  constructor({ model, onProgress, onStatus, chunkTokens, batchSize, persist, memCacheMax } = {}) {
    this.cfg = resolveModel(model);
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {};
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.chunkTokens = Math.min(Math.max(16, chunkTokens || DEFAULT_CHUNK_TOKENS), HARD_TOKEN_LIMIT);
    this._userBatch = batchSize;
    this.persist = persist !== false;
    this.memCacheMax = memCacheMax || 4000;

    this.pipe = null;
    this.device = null;          // 真正用上的后端，load() 之后才有值
    this.dtype = null;
    this.ready = false;
    this.closed = false;

    /** @type {Map<string,string>} 块级内存缓存，key = 原文块 */
    this._mem = new Map();
    /** 推理串行队列：同一时刻只允许一个 generate 在跑 */
    this._chain = Promise.resolve();
    this.pending = 0;

    this._loadPromise = null;
  }

  // ── 加载 ────────────────────────────────────────────────────────────────

  /**
   * 加载模型。可重复调用，只会真正加载一次。
   * WebGPU 档位在设备不支持时会自动降级到 wasm + q8，不会直接报错 ——
   * 上课时候弹个"你的显卡不支持"对用户毫无意义。
   */
  async load() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._doLoad().catch(e => {
      this._loadPromise = null;   // 失败后允许重试
      throw e;
    });
    return this._loadPromise;
  }

  async _doLoad() {
    if (this.closed) throw new Error('引擎已关闭');

    // ⚠️ 必须在 pipeline() 之前跑。transformers 4.3.0 在浏览器里
    // allowLocalModels 默认是 **false**（src/env.js: !(IS_BROWSER_ENV || ...)），
    // 不显式打开的话，即使 web/models/ 里已经躺着权重，它也会绕过本地直接去
    // huggingface.co 下载；ORT 的 wasm 同理会去 jsdelivr CDN。
    // 这两条都会让「断网可用」这个底线直接失效。
    setupEnv();
    // 本地 wasm（对象形式，见 ort-paths.js）+ 模型已内置就禁止联网
    // ⚠️ 必须**无条件**覆盖：transformers 一被 import 就会把 wasmPaths 预设成 jsDelivr 的
    //    地址（bundle 里 `pt.versions?.web && !pt.wasm.wasmPaths` 那段，它是会执行的）。
    //    以前这里写成「没设过才设」，结果永远看到的是它预设的 CDN 地址，直接跳过了。
    //    ortWasmPaths() 只有本地真没有文件时才会给 CDN。
    try {
      const w = env.backends && env.backends.onnx && env.backends.onnx.wasm;
      if (w) {
        const pth = await ortWasmPaths(await hasWebGPU());
        w.wasmPaths = { wasm: pth.wasm, mjs: pth.mjs };
      }
    } catch (_) {}
    env.allowRemoteModels = !(await isBundled(this.cfg.repo));

    let device = this.cfg.device || 'wasm';
    let dtype = this.cfg.dtype || 'q8';

    if (device === 'webgpu' && !(await hasWebGPU())) {
      this.onStatus('当前设备不支持 WebGPU，已自动改用 CPU 轻量模式');
      device = 'wasm';
      dtype = 'q8';
    }

    // fp16 / q4f16 的权重里是半精度张量，显卡没有 shader-f16 就跑不了。
    // 不提前拦的话要先下 168~231MB，失败后再下 121MB，白费一次大流量。
    if (device === 'webgpu' && /f(p)?16/.test(dtype) && !(await hasWebGpuFp16())) {
      this.onStatus('显卡不支持 fp16 运算，已自动改用 CPU 轻量模式');
      device = 'wasm';
      dtype = 'q8';
    }

    const load = async (dev, dt) => {
      const fallback = (dev !== (this.cfg.device || 'wasm')) || (dt !== (this.cfg.dtype || 'q8'));
      const label = fallback ? MT_MODELS[0].label : this.cfg.label;
      const sizeMB = fallback ? MT_MODELS[0].sizeMB : this.cfg.sizeMB;
      this.onStatus(`正在准备本地翻译模型（${label}，约 ${sizeMB}MB，首次需要下载）`);
      return pipeline('translation', this.cfg.repo, {
        device: dev,
        dtype: dt,
        progress_callback: p => this._emitProgress(p),
      });
    };

    try {
      this.pipe = await load(device, dtype);
      this.device = device;
      this.dtype = dtype;
    } catch (e) {
      if (device === 'webgpu') {
        // WebGPU 真跑起来才炸（比如不支持 fp16 shader）——再降一级
        this.onStatus('WebGPU 初始化失败，已自动改用 CPU 轻量模式');
        this.pipe = await load('wasm', 'q8');
        this.device = 'wasm';
        this.dtype = 'q8';
      } else {
        throw e;
      }
    }

    this.ready = true;
    this.onStatus('本地翻译模型已就绪，现在断网也能翻译');
    return this;
  }

  _emitProgress(p) {
    if (!p || typeof p !== 'object') return;
    const total = p.total || 0, loaded = p.loaded || 0;
    this.onProgress({
      status: p.status,
      file: p.file,
      progress: typeof p.progress === 'number' ? Math.round(p.progress) : (total ? Math.round(loaded * 100 / total) : 0),
      loadedMB: loaded ? +(loaded / 1048576).toFixed(1) : 0,
      totalMB: total ? +(total / 1048576).toFixed(1) : 0,
    });
  }

  // ── token 计数（有 tokenizer 用真的，没有就估） ─────────────────────────

  _count(text) {
    const tk = this.pipe && this.pipe.tokenizer;
    if (!tk) return estimateTokens(text);
    try {
      const enc = tk(text, { add_special_tokens: true });
      const dims = enc && enc.input_ids && enc.input_ids.dims;
      if (dims && dims.length) return dims[dims.length - 1];
    } catch (_) { /* 落回估算 */ }
    return estimateTokens(text);
  }

  // ── 批大小 ──────────────────────────────────────────────────────────────
  //
  // 批处理为什么快：encoder 一次前向能同时处理 N 句；decoder 每一步的
  // 矩阵乘法从 [1,d]×[d,V] 变成 [N,d]×[d,V]，算子启动开销被摊薄，
  // wasm 下实测收益最明显（单句时大量时间花在 kernel 调度上）。
  //
  // 为什么不能开太大：批内所有句子会被 pad 到最长那句的长度，
  // 浪费的算力 = (maxLen - avgLen) × N；而且 decoder 的 KV cache 是
  // N × layers × heads × maxNewTokens × headDim，显存/内存随 N 线性增长。
  // 我们在 _translateChunks 里按长度排序分桶，把 pad 浪费压到最低。
  //
  // 取值依据（Marian base：6 层 encoder + 6 层 decoder，d_model=512，词表 65001）：
  //   wasm q8   → 8。再大时 pad 浪费和内存压力超过收益，且会明显阻塞主线程。
  //   webgpu    → 16。显存主要被 65001 维的 logits 吃掉：16 × 65001 × 4B ≈ 4MB/步，安全。
  _batchSize() {
    if (this._userBatch) return Math.max(1, this._userBatch | 0);
    // ⚠️ 默认一句一句翻，**不凑批**。2026-10-06 用真实课堂录音实测：几句凑成一批推理时，
    //    批里短的那几句会一直生成到长度上限，拖出「。。。。」「,我...,我...」或者整句复读 ——
    //    同样 53 块，凑批翻坏 48 块，单独翻只坏 2 块；而且单独翻并不更慢（不用陪着生成一长串垃圾）。
    //    以前合成语音测试句子短而整齐，凑批的毛病一直没暴露。
    return 1;
  }

  // ── 串行队列 ────────────────────────────────────────────────────────────
  //
  // 上课时 ASR 会连续吐句子，如果每句都立刻并发调 generate，
  // onnxruntime 的 session 会被多个请求同时占用，轻则排队变慢，
  // 重则 wasm 内存暴涨把页面卡死。所以所有推理都串到一条 Promise 链上。
  _run(fn) {
    this.pending++;
    const next = this._chain.then(fn, fn);   // 前一个失败也不阻断后面的
    this._chain = next.then(() => {}, () => {});
    return next.finally(() => { this.pending--; });
  }

  // ── 缓存读写 ────────────────────────────────────────────────────────────

  _memKey(chunk) { return this.cfg.id + '\\u0000' + chunk; }

  _memGet(chunk) { return this._mem.get(this._memKey(chunk)); }

  _memSet(chunk, out) {
    const k = this._memKey(chunk);
    if (this._mem.has(k)) this._mem.delete(k);       // 重新插到队尾，做个简易 LRU
    this._mem.set(k, out);
    while (this._mem.size > this.memCacheMax) {
      this._mem.delete(this._mem.keys().next().value);
    }
  }

  async _diskGet(chunk) {
    if (!this.persist) return undefined;
    cleanupOldCache();   // 不 await：后台清，清一次就记账
    try {
      const p = await getPersist();
      if (!p) return undefined;
      const rec = await p.get(MT_CACHE_PREFIX + this.cfg.id + ':' + hashKey(chunk));
      // 必须比对原文：哈希再长也可能碰撞，翻错一句比慢一点严重得多
      if (rec && rec.src === chunk && typeof rec.out === 'string') return rec.out;
    } catch (_) {}
    return undefined;
  }

  async _diskSet(chunk, out) {
    if (!this.persist) return;
    try {
      const p = await getPersist();
      if (!p) return;
      await p.put({ k: MT_CACHE_PREFIX + this.cfg.id + ':' + hashKey(chunk), src: chunk, out, t: Date.now() });
    } catch (_) {}
  }

  // ── 核心：翻译一组"块" ──────────────────────────────────────────────────

  /**
   * @param {string[]} chunks 已经切好的块（每块保证不超 token 上限）
   * @returns {Promise<Map<string,string>>} 原文块 → 译文
   */
  async _translateChunks(chunks) {
    const result = new Map();
    const need = [];

    // 1) 先查缓存：内存 → 磁盘
    for (const c of new Set(chunks)) {
      const m = this._memGet(c);
      if (m !== undefined) { result.set(c, m); continue; }
      const d = await this._diskGet(c);
      if (d !== undefined) { this._memSet(c, d); result.set(c, d); continue; }
      need.push(c);
    }
    if (!need.length) return result;

    // 2) 按 token 长度排序再分批：长短句混在一批里会被 pad 到最长，白算很多。
    //    排序后同一批里的句子长度接近，pad 浪费最小。
    const withLen = need.map(c => ({ c, n: this._count(c) })).sort((a, b) => a.n - b.n);
    const bs = this._batchSize();

    for (let i = 0; i < withLen.length; i += bs) {
      const batch = withLen.slice(i, i + bs);
      const texts = batch.map(x => x.c);
      const maxSrc = batch.reduce((m, x) => Math.max(m, x.n), 0);

      // 英→中的译文 token 数通常少于原文（中文一个字往往就是一个 token，
      // 而英文一个词常被切成 1~2 个 subword），1.6 倍 + 16 足够宽松。
      const maxNew = Math.min(HARD_TOKEN_LIMIT, Math.max(32, Math.round(maxSrc * 1.6) + 16));

      const outs = await this._run(async () => {
        if (this.closed || !this.pipe) throw new Error('引擎已关闭');
        // 注意：generate 参数是平铺的一层。
        // num_beams 必须显式设成 1 —— 该模型 generation_config.json 里默认是 4，
        // beam search 会让耗时变成约 4 倍，课堂实时场景完全扛不住。
        // Marian 是单向模型，**不要**传 src_lang / tgt_lang。
        return this.pipe(texts, {
          max_new_tokens: maxNew,
          num_beams: 1,
          do_sample: false,
        });
      });

      for (let k = 0; k < texts.length; k++) {
        const raw = outs && outs[k] ? (outs[k].translation_text ?? outs[k].generated_text ?? '') : '';
        const out = String(raw).trim();
        result.set(texts[k], out);
        // 乱码不进缓存：存进去的话这句以后永远拿到同一份乱码（生成是确定性的）
        let bad = false;
        try { bad = !!(out && looksDegenerate(out, texts[k]).bad); } catch (_) {}   // 签名是 (中文, 英文)
        if (!bad) {
          this._memSet(texts[k], out);
          this._diskSet(texts[k], out);   // 故意不 await，落盘失败不该拖慢翻译
        }
      }
    }
    return result;
  }

  // ── 对外 API ────────────────────────────────────────────────────────────

  /**
   * 翻译一段文本（英 → 中）。内部会自动切句、批量推理、拼回。
   * @param {string} text
   * @returns {Promise<string>}
   */
  async translate(text) {
    const src = String(text ?? '').trim();
    if (!src) return '';
    if (looksChinese(src)) return src;        // 已经是中文，原样返回

    if (!this.ready) await this.load();

    // 整段级缓存：一模一样的整段不用再切再翻
    const whole = this._memGet(src);
    if (whole !== undefined) return whole;

    const chunks = splitForMT(src, this.chunkTokens, s => this._count(s));
    if (!chunks.length) return '';

    const map = await this._translateChunks(chunks);
    // 按原顺序拼回。中文不用空格，joinWith 默认为 ''。
    // 各块的标点是模型根据原文标点自己生成的，这里绝不手工补标点 ——
    // 手工补最容易在"原句本来就没结束"的地方补出一个莫名其妙的句号。
    const joined = chunks.map(c => map.get(c) || '').filter(Boolean).join(this.cfg.joinWith ?? '');

    if (chunks.length > 1) this._memSet(src, joined);   // 整段也缓存一份
    return joined;
  }

  /**
   * 批量翻译多段文本。
   * @param {string[]} texts
   * @param {object} [opts]
   * @param {number} [opts.concurrency=4] 一次合并处理几段原文。
   *        注意：**推理本身永远是串行的**（见 _run），这个值只决定
   *        "一次把多少段原文的句子拢到一起去凑批"，越大批处理效率越高，
   *        但 onEach 的回调会来得越晚。默认 4，兼顾吞吐和反馈及时性。
   * @param {(index:number, out:string, src:string)=>void} [opts.onEach] 每段完成时回调
   * @returns {Promise<string[]>} 与输入等长、顺序一致
   */
  async translateMany(texts, { concurrency = 4, onEach } = {}) {
    const list = Array.isArray(texts) ? texts : [texts];
    const out = new Array(list.length).fill('');
    if (!list.length) return out;

    if (!this.ready) await this.load();
    const group = Math.max(1, concurrency | 0);
    const cb = typeof onEach === 'function' ? onEach : null;

    for (let i = 0; i < list.length; i += group) {
      const slice = list.slice(i, i + group);

      // 先把这一组里每段各自切好块，记下"哪段由哪些块组成"
      const plans = slice.map(t => {
        const src = String(t ?? '').trim();
        if (!src) return { src, passthrough: '' };
        if (looksChinese(src)) return { src, passthrough: src };
        const cached = this._memGet(src);
        if (cached !== undefined) return { src, passthrough: cached };
        return { src, chunks: splitForMT(src, this.chunkTokens, s => this._count(s)) };
      });

      // 把整组的块合并成一个大池子去凑批 —— 这正是批处理省时间的地方
      const pool = [];
      for (const p of plans) if (p.chunks) pool.push(...p.chunks);
      const map = pool.length ? await this._translateChunks(pool) : new Map();

      for (let k = 0; k < plans.length; k++) {
        const p = plans[k];
        const idx = i + k;
        if (p.passthrough !== undefined) {
          out[idx] = p.passthrough;
        } else {
          out[idx] = p.chunks.map(c => map.get(c) || '').filter(Boolean).join(this.cfg.joinWith ?? '');
          if (p.chunks.length > 1) this._memSet(p.src, out[idx]);
        }
        if (cb) { try { cb(idx, out[idx], list[idx]); } catch (_) {} }
      }
    }
    return out;
  }

  /** 释放模型占用的内存 / 显存。关闭后需要重新 new 一个实例。 */
  async close() {
    this.closed = true;
    this.ready = false;
    const p = this.pipe;
    this.pipe = null;
    this._loadPromise = null;
    this._mem.clear();
    if (p && typeof p.dispose === 'function') {
      try { await p.dispose(); } catch (_) {}
    }
  }
}

export default LocalMT;
