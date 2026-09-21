// 云端 AI：Anthropic (Claude) 或任意 OpenAI 兼容接口
import { settings } from './store.js';

export function aiReady() {
  const s = settings();
  if (s.provider === 'anthropic') return !!s.apiKey;
  if (s.provider === 'openai') return !!(s.baseUrl && (s.apiKey || /localhost|127\.0\.0\.1/.test(s.baseUrl)));
  return false;
}

export function aiName() {
  const s = settings();
  if (!aiReady()) return '';
  return s.provider === 'anthropic' ? (s.model || 'claude-opus-5') : (s.model || 'model');
}

const DEFAULT_CLAUDE = 'claude-opus-5';

async function callAnthropic({ system, user, maxTokens, effort, signal }) {
  const s = settings();
  const body = {
    model: s.model || DEFAULT_CLAUDE,
    max_tokens: maxTokens || 8000,
    system,
    messages: [{ role: 'user', content: user }]
  };
  if (effort) body.output_config = { effort };

  const doFetch = (withFallback) => {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': s.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    const b = { ...body };
    if (withFallback) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; b.fallbacks = 'default'; }
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(b), signal
    });
  };

  let r = await doFetch(true);
  if (r.status === 400) {                       // 老账号/老模型可能不认这个 beta，去掉再试一次
    const txt = await r.text();
    if (/beta|fallback|output_config|effort/i.test(txt)) {
      delete body.output_config;
      r = await doFetch(false);
    } else {
      throw new Error('Anthropic 400: ' + txt.slice(0, 300));
    }
  }
  if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  if (j.stop_reason === 'refusal') throw new Error('模型拒绝了这次请求（stop_reason: refusal）');
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

async function callOpenAI({ system, user, maxTokens, signal }) {
  const s = settings();
  const base = (s.baseUrl || '').replace(/\/+$/, '');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(s.apiKey ? { authorization: 'Bearer ' + s.apiKey } : {}) },
    signal,
    body: JSON.stringify({
      model: s.model || 'gpt-4o-mini',
      max_tokens: maxTokens || 4000,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  });
  if (!r.ok) throw new Error('AI ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  return ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
}

export async function ask({ system, user, maxTokens, effort, signal }) {
  const s = settings();
  if (!aiReady()) throw new Error('未配置 AI 服务');
  if (s.provider === 'anthropic') return callAnthropic({ system, user, maxTokens, effort, signal });
  return callOpenAI({ system, user, maxTokens, signal });
}

// 云端语音转写（OpenAI 兼容的 /audio/transcriptions，如 OpenAI / Groq / 硅基流动）
export function whisperReady() {
  const s = settings();
  return s.provider === 'openai' && !!s.baseUrl;
}
export async function transcribe(blob, lang) {
  const s = settings();
  const base = (s.baseUrl || '').replace(/\/+$/, '');
  const fd = new FormData();
  fd.append('file', blob, 'chunk.webm');
  fd.append('model', s.asrModel || 'whisper-1');
  if (lang) fd.append('language', String(lang).split('-')[0]);
  fd.append('response_format', 'json');
  const r = await fetch(base + '/audio/transcriptions', {
    method: 'POST',
    headers: { ...(s.apiKey ? { authorization: 'Bearer ' + s.apiKey } : {}) },
    body: fd
  });
  if (!r.ok) throw new Error('转写 ' + r.status);
  const j = await r.json();
  return (j.text || '').trim();
}

export async function testConnection() {
  const t = await ask({ system: '你是一个连通性测试。', user: '只回复两个字：正常', maxTokens: 64, effort: 'low' });
  return t;
}
