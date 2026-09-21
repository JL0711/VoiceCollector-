// mtllm-worker.js —— 把本地 LLM 翻译关进 Worker（模型推理绝不能占住主线程）
let TR = null, mod = null;
const lib = async () => (mod || (mod = await import('./translate-llm.js')));
const post = (m) => self.postMessage(m);

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    switch (m.type) {
      case 'probe': {
        const L = await lib();
        post({ type: 'probe:ok', id: m.id,
          info: await L.llmMTAvailable(), recommended: await L.recommendMTModel(),
          models: L.LLM_MT_MODELS.map(x => ({ id: x.id, label: x.label, sizeMB: x.sizeMB, quality: x.quality, note: x.note })) });
        break;
      }
      case 'load': {
        const L = await lib();
        TR = new L.LLMTranslator({ model: m.model, targetLang: m.targetLang || 'zh-Hans',
          onStatus: (s, d) => post({ type: 'status', status: typeof s === 'string' ? s : (s && s.status) || '', detail: d || null }),
          onProgress: (p) => post({ type: 'progress', progress: p }) });
        await TR.load();
        post({ type: 'load:ok', id: m.id, device: TR.device, dtype: TR.dtype });
        break;
      }
      case 'one': {
        if (!TR) throw new Error('翻译模型还没加载');
        post({ type: 'one:ok', id: m.id, zh: await TR.translate(m.text, { context: m.context }) });
        break;
      }
      case 'many': {
        if (!TR) throw new Error('翻译模型还没加载');
        const zhs = await TR.translateMany(m.items, {
          batchSize: m.batchSize,
          onEach: (item, zh) => post({ type: 'each', id: m.id, itemId: item && item.id, zh })
        });
        post({ type: 'many:ok', id: m.id, zhs });
        break;
      }
      case 'close': {
        try { TR && await TR.close(); } catch (_) {}
        TR = null;
        post({ type: 'close:ok', id: m.id });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: String((err && err.message) || err).slice(0, 400) });
  }
};
