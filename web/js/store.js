// 设置（localStorage）
const KEY = 'vc.settings.v1';
const DEFAULTS = {
  provider: 'none', apiKey: '', baseUrl: '', model: '',
  srcLang: 'en-US', dstLang: 'zh-Hans',
  micId: '', lastTeacher: '', lastCourse: '',
  audioBackup: true, cloudASR: false, agc: true, ns: false,
  liveTranslate: true, wakeLock: true,
  farMode: false, boost: 1, keepChunks: false, chunkSec: 30, asrModel: 'whisper-1',
  engine: 'auto', whisperModel: '', mtModel: '', useLocalLLM: false, llmModel: '',
  powerSaver: false, mtEngine: 'auto', llmMtModel: '', autoPerfect: false
};

let cache = null;
export function settings() {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch (_) { cache = { ...DEFAULTS }; }
  return cache;
}
export function save(patch) {
  cache = { ...settings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) {}
  return cache;
}

export const PRESETS = {
  deepseek: { provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  moonshot: { provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu:    { provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  openai:   { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama:   { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' }
};

export const LANGS = [
  ['en-US', '英语（美国） English'], ['en-GB', '英语（英国） English'], ['en-AU', '英语（澳洲）'],
  ['en-CA', '英语（加拿大）'], ['en-IN', '英语（印度口音）'], ['en-NZ', '英语（新西兰）'],
  ['zh-CN', '中文（普通话）'], ['zh-HK', '中文（粤语）'], ['zh-TW', '中文（台湾）'],
  ['ja-JP', '日语'], ['ko-KR', '韩语'], ['fr-FR', '法语'], ['de-DE', '德语'],
  ['es-ES', '西班牙语'], ['it-IT', '意大利语'], ['ru-RU', '俄语'], ['pt-BR', '葡萄牙语（巴西）']
];
