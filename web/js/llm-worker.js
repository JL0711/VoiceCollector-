// llm-worker.js —— 本地小语言模型也关进 Worker 里跑
// 理由和 whisper-worker 一样：模型推理绝不能占住主线程，否则界面和录音一起卡死。
let LLM = null, mod = null;

async function lib() { if (!mod) mod = await import('./llm.js'); return mod; }
const post = (m) => self.postMessage(m);

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    switch (m.type) {
      case 'available': {
        const L = await lib();
        post({ type: 'available:ok', id: m.id, info: await L.llmAvailable(), recommended: await L.recommendModel(),
               models: L.LLM_MODELS.map(x => ({ id: x.id, label: x.label, sizeMB: x.sizeMB, quality: x.quality, note: x.note })) });
        break;
      }
      case 'load': {
        const L = await lib();
        LLM = new L.LocalLLM({ model: m.model,
          onStatus: (s, d) => post({ type: 'status', status: typeof s === 'string' ? s : (s && s.status) || '', detail: d || null }),
          onProgress: (p) => post({ type: 'progress', progress: p }) });
        await LLM.load();
        post({ type: 'load:ok', id: m.id });
        break;
      }
      case 'polish': {
        const L = await lib();
        const md = await L.polishNotes(m.analysis, { ctx: m.ctx, llm: LLM,
          onStep: (s) => post({ type: 'step', step: s }), maxCalls: m.maxCalls, budgetMs: m.budgetMs });
        post({ type: 'polish:ok', id: m.id, markdown: md });
        break;
      }
      case 'ask': {
        const L = await lib();
        const a = await L.answerQuestion({ question: m.question, analysis: m.analysis, session: m.session, llm: LLM });
        post({ type: 'ask:ok', id: m.id, answer: a });
        break;
      }
      case 'close': {
        try { LLM && await LLM.close(); } catch (_) {}
        LLM = null;
        post({ type: 'close:ok', id: m.id });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: String((err && err.message) || err).slice(0, 400) });
  }
};
