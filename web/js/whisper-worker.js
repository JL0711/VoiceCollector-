// whisper-worker.js —— 把本地 Whisper 关进 Web Worker 里跑
//
// 为什么必须这么做（血的教训）：
//   ONNX Runtime 创建推理会话时会长时间占住所在线程，某些 dtype/后端组合（比如 int8 权重
//   碰上 WebGPU）甚至会直接卡死。如果这发生在主线程上，整个界面连同**录音**一起冻住——
//   上课上到一半黑屏，这是不可接受的。
//   放进 Worker 之后，最坏情况只是识别停了，录音、计时、界面、自动保存全都照常，
//   下课后还能用完整录音重新转写。
//
// 协议：主线程 postMessage({type, id, ...})，Worker 回 postMessage({type, id, ...})

let SW = null;          // StreamingWhisper 实例
let mod = null;

async function lib() {
  if (!mod) mod = await import('./whisper.js');
  return mod;
}

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    switch (m.type) {
      case 'probe': {
        const W = await lib();
        post({ type: 'probe:ok', id: m.id, webgpu: await W.webgpuAvailable(), recommended: await W.estimateSpeed(),
               models: W.WHISPER_MODELS.map(x => ({ id: x.id, label: x.label, sizeMB: x.sizeMB, quality: x.quality, note: x.note })) });
        break;
      }
      case 'start': {
        const W = await lib();
        SW = new W.StreamingWhisper({
          model: m.model, language: m.language, device: m.device,
          windowSec: m.windowSec || 25, overlapSec: m.overlapSec || 3,
          onPartial: (t) => post({ type: 'partial', text: t }),
          onFinal: (text, a, b) => post({ type: 'final', text, startMs: a, endMs: b }),
          onStatus: (s, d) => post({ type: 'status', status: typeof s === 'string' ? s : (s && s.status) || '', detail: d || null })
        });
        await SW.start();
        post({ type: 'start:ok', id: m.id, device: SW.device });
        break;
      }
      case 'push': {
        if (SW && m.pcm) SW.push(new Float32Array(m.pcm));
        break;
      }
      case 'flush': {
        if (SW) await SW.flush();
        post({ type: 'flush:ok', id: m.id });
        break;
      }
      case 'stop': {
        try { SW && SW.stop(); } catch (_) {}
        SW = null;
        post({ type: 'stop:ok', id: m.id });
        break;
      }
      // 整段离线转写（课后「重新转写」用）
      case 'transcribe': {
        const W = await lib();
        const lw = new W.LocalWhisper({ model: m.model, language: m.language, device: m.device,
          onStatus: (s, d) => post({ type: 'status', status: typeof s === 'string' ? s : (s && s.status) || '', detail: d || null }),
          onProgress: (p) => post({ type: 'progress', progress: p }) });
        await lw.load();
        const r = await lw.transcribe(new Float32Array(m.pcm), { language: m.language });
        try { await lw.close(); } catch (_) {}
        post({ type: 'transcribe:ok', id: m.id, text: r && r.text, chunks: r && r.chunks });
        break;
      }
      case 'preload': {
        const W = await lib();
        const lw = new W.LocalWhisper({ model: m.model, language: m.language, device: m.device,
          onStatus: (s, d) => post({ type: 'status', status: typeof s === 'string' ? s : (s && s.status) || '', detail: d || null }),
          onProgress: (p) => post({ type: 'progress', progress: p }) });
        await lw.load();
        try { await lw.close(); } catch (_) {}
        post({ type: 'preload:ok', id: m.id });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: String((err && err.message) || err).slice(0, 400) });
  }
};
