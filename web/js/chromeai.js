// chromeai.js —— 用 Chrome 内置的 AI（Gemini Nano）做翻译
//
// 为什么优先用它：
//   · 质量比 opus-mt 这类小翻译模型高一大截：认得 Supreme Court 这种专有名词、
//     能结合上下文、不会出现「最高法院最高法院」这种复读。
//   · 模型由 Chrome 统一管理，不占应用体积，多个网站共用一份。
//   · 完全在本机跑，不联网、不要 API Key、免费。
//
// 限制：
//   · 只有 Chrome 138+ 有；模型首次要下载（几 GB，由 Chrome 下，不占我们的空间）。
//   · 触发下载**必须在用户手势里**（点击事件中），否则会被拒绝或一直挂着。
//   · 这些 API 还在演进，所有调用都必须带超时——实测 Translator.availability() 在某些
//     版本上会永远不返回。

const race = (p, ms, fallback) => Promise.race([
  Promise.resolve(p).catch(() => fallback),
  new Promise(r => setTimeout(() => r(fallback), ms))
]);

const LM = () => (typeof self !== 'undefined' ? self.LanguageModel : null);
const TR = () => (typeof self !== 'undefined' ? (self.Translator || (self.ai && self.ai.translator)) : null);

export function chromeAIPresent() { return !!(LM() || TR()); }

/** 探测两套 API 的状态，全部带超时，绝不会卡住调用方 */
export async function chromeAIStatus() {
  const out = { languageModel: 'unavailable', translator: 'unavailable' };
  const lm = LM();
  if (lm && lm.availability) out.languageModel = await race(lm.availability(), 6000, 'unavailable');
  const tr = TR();
  if (tr && tr.availability) {
    out.translator = await race(tr.availability({ sourceLanguage: 'en', targetLanguage: 'zh-Hans' }), 6000, 'unavailable');
  }
  return out;
}

const SYS = `你是大学课堂的同传译者，把英文课堂内容翻译成简体中文。

规则：
1. 只输出译文，不要任何解释、前言、引号或原文。
2. 专业术语和专有名词，首次出现时用「中文（English）」的格式，例如：最高法院（Supreme Court）、第一修正案（First Amendment）。
3. 原文来自语音识别，可能有听错的词、缺标点、有口头禅。按上下文推断老师真正要说的意思，去掉 um / uh / you know 这类语气词。
4. 拿不准的专有名词，保留英文原样，不要硬译。
5. 保持口语的自然度，不要翻译腔。`;

/**
 * 必须在用户手势（click 事件）里调用，否则模型下载会被浏览器拒绝。
 * onProgress: (0..100) => void
 */
export async function enableChromeAI(onProgress) {
  const lm = LM();
  if (!lm) throw new Error('这个浏览器没有 Chrome 内置 AI（需要 Chrome 138 以上）');
  const av = await race(lm.availability(), 8000, 'unavailable');
  if (av === 'unavailable') throw new Error('Chrome 内置 AI 在这台机器上不可用（可能是系统版本或磁盘空间不够）');

  const session = await lm.create({
    initialPrompts: [{ role: 'system', content: SYS }],
    temperature: 0.2,
    topK: 3,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        const pct = typeof e.loaded === 'number' ? (e.loaded <= 1 ? e.loaded * 100 : e.loaded) : 0;
        try { onProgress && onProgress(Math.round(pct)); } catch (_) {}
      });
    }
  });
  try { session.destroy && session.destroy(); } catch (_) {}
  return true;
}

export class ChromeAITranslator {
  constructor({ onStatus } = {}) {
    this.onStatus = onStatus || (() => {});
    this.ready = false;
    this._chain = Promise.resolve();      // 推理串行化
  }

  async load() {
    if (this.ready) return true;
    const lm = LM();
    if (!lm) throw new Error('没有 Chrome 内置 AI');
    const av = await race(lm.availability(), 8000, 'unavailable');
    if (av !== 'available') throw new Error('Chrome 内置 AI 还没就绪（状态：' + av + '），请先在设置里点「启用 Chrome 内置 AI」');
    this.session = await race(lm.create({ initialPrompts: [{ role: 'system', content: SYS }], temperature: 0.2, topK: 3 }), 60000, null);
    if (!this.session) throw new Error('Chrome 内置 AI 会话创建超时');
    this.ready = true;
    this.onStatus('ready');
    return true;
  }

  // 每次用一个克隆的会话，避免上下文越积越长（会话有 token 上限，满了就报错）
  async _ask(prompt, ms = 45000) {
    const run = async () => {
      let s = null;
      try {
        s = this.session.clone ? await this.session.clone() : this.session;
        const r = await race(s.prompt(prompt), ms, null);
        return typeof r === 'string' ? r.trim() : '';
      } finally {
        if (s && s !== this.session) { try { s.destroy && s.destroy(); } catch (_) {} }
      }
    };
    this._chain = this._chain.then(run, run);
    return this._chain;
  }

  async translate(text) {
    if (!text || !text.trim()) return '';
    if (!this.ready) await this.load();
    const out = await this._ask(`把下面这段课堂原话翻译成简体中文：\n\n${text}`);
    return (out || '').replace(/^译文[:：]\s*/, '').trim();
  }

  /**
   * 批量翻译：一次给模型多句（带编号），它能看到上下文，质量和速度都更好。
   * items: [{id, text}]，onEach(item, zh) 增量回调。
   * 严格对齐：输出条数对不上就缩小批次重试，最后退回逐句，绝不会把译文安错位置。
   */
  async translateMany(items, { onEach, batchSize = 6 } = {}) {
    if (!this.ready) await this.load();
    const results = new Array(items.length).fill('');

    const doBatch = async (slice, offset, size) => {
      if (!slice.length) return;
      if (slice.length === 1 || size <= 1) {
        for (let i = 0; i < slice.length; i++) {
          const zh = await this.translate(slice[i].text);
          results[offset + i] = zh;
          if (onEach) try { onEach(slice[i], zh); } catch (_) {}
        }
        return;
      }
      const numbered = slice.map((x, i) => `${i + 1}. ${x.text}`).join('\n');
      const prompt = `把下面 ${slice.length} 句课堂原话翻译成简体中文。
严格按照 "序号|译文" 的格式逐行输出，一句一行，不要输出任何其他内容，不要合并或拆分句子。

${numbered}`;
      const raw = await this._ask(prompt, 60000);
      const map = new Map();
      for (const line of String(raw || '').split('\n')) {
        const m = line.match(/^\s*(\d+)\s*[|｜.、:：]\s*(.+?)\s*$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n >= 1 && n <= slice.length && !map.has(n)) map.set(n, m[2].trim());
        }
      }
      if (map.size === slice.length) {                     // 完美对齐，采用
        for (let i = 0; i < slice.length; i++) {
          const zh = map.get(i + 1) || '';
          results[offset + i] = zh;
          if (onEach) try { onEach(slice[i], zh); } catch (_) {}
        }
        return;
      }
      // 对不齐就把批次砍半重来，最终退到逐句。宁可慢，也绝不让译文错位。
      const half = Math.max(1, Math.floor(slice.length / 2));
      await doBatch(slice.slice(0, half), offset, Math.max(1, Math.floor(size / 2)));
      await doBatch(slice.slice(half), offset + half, Math.max(1, Math.floor(size / 2)));
    };

    for (let i = 0; i < items.length; i += batchSize) {
      await doBatch(items.slice(i, i + batchSize), i, batchSize);
    }
    return results;
  }

  close() {
    try { this.session && this.session.destroy && this.session.destroy(); } catch (_) {}
    this.session = null;
    this.ready = false;
  }
}
