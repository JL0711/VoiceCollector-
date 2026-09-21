// 翻译调度。
//
// 优先级（目标是**完全本地、能打包进桌面 App**，所以 Chrome 内置的那套只是网页版的加分项）：
//   1. 本地 LLM 翻译（translate-llm.js，Qwen）—— 质量最好，认得专有名词，Electron 里也能跑
//   2. 本地 opus-mt（mt.js）+ 术语表 + 劣化检测 —— 快，做实时字幕
//   3. Chrome 内置翻译 —— 只有网页版 + Chrome 138+ 才有，桌面版没有
//   4. 云端 AI —— 需要 API Key
import { ask, aiReady } from './ai.js';

const cache = new Map();

// ---- 本地翻译模型（mt.js，离线、不要 Key）。Electron 里没有 Chrome 内置翻译，全靠它 ----
let localMT = null, localMTTried = false, localMTLoading = null;

async function getLocalMT() {
  if (localMT) return localMT;
  if (localMTTried && !localMTLoading) return null;
  if (localMTLoading) return localMTLoading;
  localMTTried = true;
  localMTLoading = (async () => {
    try {
      const M = await import('./mt.js');
      const id = (M.MT_MODELS && M.MT_MODELS[0] && M.MT_MODELS[0].id) || '';
      const m = new M.LocalMT({ model: id });
      await m.load();
      localMT = m;
      return m;
    } catch (_) { return null; }
    finally { localMTLoading = null; }
  })();
  return localMTLoading;
}

// 提前把本地翻译模型热起来（在用户点「开始录制」那次手势里调用）
export function warmLocalMT() { getLocalMT().catch(() => {}); }
export function localMTReady() { return !!localMT; }

// 浏览器内置 AI 的接口在某些环境下会永远不返回，必须加超时兜底
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(res => setTimeout(() => res(fallback), ms))
  ]);
}
let translator = null, translatorKey = '', translatorTried = false;

function api() { return self.Translator || (self.ai && self.ai.translator) || null; }

export { withTimeout };

export function builtinSupported() { return !!api(); }

export async function builtinAvailability(src, dst) {
  const T = api();
  if (!T) return 'unavailable';
  try {
    const opt = { sourceLanguage: base(src), targetLanguage: dst };
    if (T.availability) return await withTimeout(T.availability(opt), 2500, 'unavailable');
    if (T.capabilities) {                       // 旧版 API
      const c = await withTimeout(T.capabilities(), 2500, null);
      if (!c) return 'unavailable';
      const r = c.languagePairAvailable && c.languagePairAvailable(base(src), dst);
      return r === 'readily' ? 'available' : r === 'after-download' ? 'downloadable' : 'unavailable';
    }
  } catch (_) {}
  return 'unavailable';
}

const base = l => String(l || 'en').split('-')[0];

// 必须在用户点击（手势）之后调用，否则 Chrome 不会开始下载语言包
export async function prepare(src, dst, onProgress) {
  if (dst === 'off') return null;
  const key = base(src) + '>' + dst;
  if (translator && translatorKey === key) return translator;
  const T = api();
  if (!T) { translatorTried = true; return null; }
  translatorTried = true;
  // 先问可用性（带超时），不可用就根本不要 create —— create 挂住会拖死整条翻译链
  const av = await builtinAvailability(src, dst);
  if (av === 'unavailable') { translator = null; return null; }
  try {
    const opts = { sourceLanguage: base(src), targetLanguage: dst };
    if (onProgress) opts.monitor = m => m.addEventListener('downloadprogress', e => onProgress(e.loaded ?? 0));
    // 需要下载语言包时给 90 秒，已就绪的话 20 秒足够
    translator = await withTimeout(T.create(opts), av === 'available' ? 20000 : 90000, null);
    translatorKey = translator ? key : '';
  } catch (e) {
    translator = null;
  }
  return translator;
}

export function localReady() { return !!translator; }

// ---- 劣化检测：小翻译模型在短输入上会复读（"最高法院最高法院"、"章次章节"）----
// glossary.js（由另一个模块提供）里有更完整的版本，有就优先用那个。
let _guard = null;
async function guard() {
  if (_guard !== null) return _guard;
  try {
    const G = await import('./glossary.js');
    // 整句正好是一个术语时直接查表（不惊动模型，也就不会复读）
    const term = (en) => {
      try {
        const t = String(en || '').trim().replace(/^(the|a|an)\s+/i, '').replace(/[.,!?;:]+$/, '');
        const hits = G.findTerms(t);
        if (hits && hits.length === 1) {
          const h = hits[0];
          const cn = h.zh || h.cn || h[1];
          const src = h.en || h.term || h[0] || t;
          // 命中的词覆盖了整句，才算「这句就是个术语」
          if (cn && String(src).length >= t.length - 2) return cn + '（' + t + '）';
        }
      } catch (_) {}
      return '';
    };
    _guard = { bad: G.looksDegenerate, fix: G.applyGlossary, skip: G.shouldTranslate, pre: G.preprocess, term };
  } catch (_) {
    _guard = { bad: fallbackBad, fix: (en, zh) => zh, skip: fallbackSkip, pre: (t) => t, term: () => '' };
  }
  return _guard;
}

function fallbackSkip(en) {
  const t = String(en || '').trim();
  if (!t) return false;
  if (/^[\d\s\p{P}]+$/u.test(t)) return false;                      // 纯数字/标点
  if (/^(um+|uh+|yeah|ok|okay|mhm+|hmm+|right|so)[\s.,!?]*$/i.test(t)) return false;
  const n = (t.match(/[A-Za-z0-9'’-]+/g) || []).length;
  return n >= 3 || /[.!?]$/.test(t);                                 // 太短的碎片不翻，翻了也是垃圾
}

// 对外暴露，给「高质量重翻」做结果校验用
export function isDegenerate(zh, en) { return fallbackBad(zh, en); }

function fallbackBad(zh, en) {
  const z = String(zh || '').replace(/\s/g, '');
  if (!z) return { bad: true, reason: '空' };
  if (!/[\u4e00-\u9fa5]/.test(z)) return { bad: true, reason: '没有中文' };
  // 连续重复。两条规则，避开「一步一步」「各种各样」这类正常的叠词：
  //   · 重复单元 ≥3 字、出现 ≥2 次   → "最高法院最高法院"
  //   · 重复单元 2 字、出现 ≥3 次     → "预期预期预期"
  const m3 = z.match(/(.{3,8})\1+/);
  if (m3 && m3[0].length / z.length > 0.5) return { bad: true, reason: '复读：' + m3[1] };
  const m2 = z.match(/(.{2})\1{2,}/);
  if (m2 && m2[0].length / z.length > 0.5) return { bad: true, reason: '复读：' + m2[1] };
  // 译文长度相对原文异常膨胀
  const w = (String(en || '').match(/[A-Za-z0-9'’-]+/g) || []).length;
  if (w > 0 && w <= 4 && z.length > w * 6) return { bad: true, reason: '短句译文过长' };
  return { bad: false, reason: '' };
}

// opus-mt 这类模型的输出经常在汉字之间夹空格（"改变解释 和改变隐私的性质 在数字时代"）。
// 这不是错误，只是它的 detokenizer 习惯。**必须先清理再做质量判断**，
// 否则会把大量完全可用的译文当成"逐字拼接"给毙掉，用户就一句中文都看不到了。
function tidyCJK(zh) {
  if (!zh) return '';
  let t = String(zh);
  const CJK = '\\u4e00-\\u9fa5\\u3000-\\u303f\\uff00-\\uffef';
  // 汉字（或中文标点）之间的空格去掉，英文/数字两侧的空格保留
  for (let i = 0; i < 3; i++) {
    t = t.replace(new RegExp('([' + CJK + '])[ \\t]+(?=[' + CJK + '])', 'g'), '$1');
  }
  return t.replace(/\s{2,}/g, ' ').replace(/\s+([，。、；：？！）】」』])/g, '$1').trim();
}

// 高质量引擎（本地 LLM）。由 app.js 在需要时注入，避免 translate.js 直接依赖大模块。
let hiq = null;
export function setHighQualityEngine(engine) { hiq = engine; }
export function highQualityReady() { return !!(hiq && hiq.ready); }

// opts.skipHQ = true → 强制走快速模型（opus-mt），不碰高质量引擎。
// 「课后精修」需要两个模型**各自独立**翻一遍再比较，如果这里默认优先用高质量引擎，
// 两轮跑的就是同一个模型，双模型择优直接退化成单模型 —— 这个坑踩过一次。
export async function translate(text, src, dst, opts) {
  if (!text || dst === 'off') return '';
  const key = (opts && opts.skipHQ ? 'fast|' : '') + dst + '|' + text;
  if (cache.has(key)) return cache.get(key);

  const G = await guard();
  if (!G.skip(text)) return '';                    // 碎片/语气词直接跳过

  // 整句就是一个术语（"supreme court"）→ 直接查表，既准又不会触发模型复读
  const direct = G.term ? G.term(text) : '';
  if (direct) { cache.set(key, direct); return direct; }

  const src_ = G.pre(text);

  let out = '';

  // 第一梯队：本地 LLM（质量最好）
  if (hiq && hiq.ready && !(opts && opts.skipHQ)) {
    try { out = tidyCJK((await withTimeout(hiq.translate(src_), 60000, '')) || ''); } catch (_) {}
    if (out) {
      const v = G.bad(out, src_);
      if (v.bad) out = '';
    }
  }
  if (!out && translator) {
    try { out = tidyCJK((await withTimeout(translator.translate(src_), 15000, '')) || ''); }
    catch (_) { out = ''; }
  }
  if (!out && !translatorTried) {
    await prepare(src, dst);
    if (translator) { try { out = ((await withTimeout(translator.translate(text), 15000, '')) || '').trim(); } catch (_) {} }
  }
  // 本地 OPUS-MT（快，做实时字幕），出来的结果要过劣化检测
  if (!out) {
    const m = await getLocalMT();
    if (m) {
      try { out = tidyCJK((await withTimeout(m.translate(src_), 30000, '')) || ''); } catch (_) {}
      if (out) {
        const v = G.bad(out, src_);
        if (v.bad) out = '';                       // 复读之类的垃圾，宁可不给，也不给错的
      }
    }
  }
  if (!out && aiReady()) {
    try {
      out = await ask({
        system: '你是课堂同传翻译。把用户给的课堂原话翻译成' + (dst === 'zh-Hant' ? '繁体中文' : '简体中文') +
                '。只输出译文本身，不要解释、不要加引号、不要加任何前缀。保留专业术语，必要时在术语后用括号附上英文原词。',
        user: text, maxTokens: 1500, effort: 'low'
      });
    } catch (_) { out = ''; }
  }
  if (out) {
    try { out = G.fix(src_, out); } catch (_) {}   // 术语表纠正
    cache.set(key, out);
  }
  return out;
}

// 批量翻译（下课后补翻译用），带并发控制
export async function translateMany(list, src, dst, onEach, concurrency = 3, opts) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, list.length)) }, async () => {
    while (i < list.length) {
      const idx = i++;
      const item = list[idx];
      const zh = await translate(item.text, src, dst, opts);
      if (onEach) onEach(item, zh, idx);
    }
  });
  await Promise.all(workers);
}
