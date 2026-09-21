#!/usr/bin/env node
/**
 * fetch-models.mjs —— 把 AI 模型预先下载到本地，打进软件里
 *
 * 目标：用户拿到 App 就能用，不联网、不注册账号、不填任何 API Key。
 *
 * 只用 Node 内置模块（fs / https / http / path / stream / url），零 npm 依赖。
 * 运行：node scripts/fetch-models.mjs --list
 *
 * 下载后的目录结构完全按 transformers.js 的期望摆放：
 *   web/models/<org>/<repo>/config.json
 *   web/models/<org>/<repo>/onnx/encoder_model_quantized.onnx
 * 前端只要设置：
 *   env.allowRemoteModels = false;
 *   env.localModelPath = './models/';
 * 就会从 `<localModelPath><org>/<repo>/<file>` 读取，全程不碰网络。
 * （依据：node_modules/@huggingface/transformers/src/env.js 里
 *   remotePathTemplate = '{model}/resolve/{revision}/'，本地路径同构。）
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'web', 'models');

// ───────────────────────────────────────────────────────────────────────────
// 1. 模型清单
//
// 这些仓库名和文件名都是 2026-09 实测 huggingface.co API 确认存在的，
// 不是猜的。核对命令：
//   curl https://huggingface.co/api/models/<repo>/tree/main?recursive=true
//
// transformers.js 对 Seq2Seq 类模型（Whisper / Marian 都属于）需要两个 onnx
// session：'encoder_model' 和 'decoder_model_merged'
// （依据：src/models/session_config.js 里 MODEL_TYPES.Seq2Seq 的 sessions()）。
// tokenizer 只需要 tokenizer.json + tokenizer_config.json
// （依据：src/utils/model_registry/get_tokenizer_files.js）。
// ───────────────────────────────────────────────────────────────────────────

/** dtype 后缀映射，抄自 src/utils/dtypes.js 的 DEFAULT_DTYPE_SUFFIX_MAPPING */
const DTYPE_SUFFIX = {
  fp32: '',
  fp16: '_fp16',
  q8: '_quantized',
  q4: '_q4',
  int8: '_int8',
  uint8: '_uint8',
  q4f16: '_q4f16',
  q2: '_q2',
  q2f16: '_q2f16',
  q1: '_q1',
  q1f16: '_q1f16',
  bnb4: '_bnb4',
};

/** Whisper 系列共用的小文件（配置 + 分词器） */
const WHISPER_CONFIGS = [
  { file: 'config.json' },
  { file: 'generation_config.json' },
  { file: 'preprocessor_config.json' },
  { file: 'tokenizer.json' },
  { file: 'tokenizer_config.json' },
  // 下面这几个 transformers.js v4 不一定会读，但都很小，一起带上更保险
  { file: 'special_tokens_map.json', optional: true },
  { file: 'added_tokens.json', optional: true },
  { file: 'normalizer.json', optional: true },
];

/** OPUS-MT（Marian）系列共用的小文件 */
const MARIAN_CONFIGS = [
  { file: 'config.json' },
  { file: 'generation_config.json' },
  { file: 'tokenizer.json' },
  { file: 'tokenizer_config.json' },
  { file: 'special_tokens_map.json', optional: true },
  { file: 'vocab.json', optional: true },
  { file: 'source.spm', optional: true },
  { file: 'target.spm', optional: true },
];

/** Seq2Seq 的两个 onnx session 名 */
const SEQ2SEQ_SESSIONS = ['encoder_model', 'decoder_model_merged'];

/**
 * approxMB 是 2026-09 实测 HF tree API 的字节数换算，含小文件。
 * 用于 --list 离线展示和体积预估，真实校验仍以 API 返回的 size 为准。
 */
const MODELS = [
  {
    id: 'whisper-tiny',
    repo: 'onnx-community/whisper-tiny',
    kind: 'asr',
    title: 'Whisper Tiny · 语音识别（最小）',
    note: '39M 参数。速度最快、最省内存，但远场/口音/专业术语容易错。适合老旧电脑应急，或只想先验证链路能跑通。',
    configs: WHISPER_CONFIGS,
    sessions: SEQ2SEQ_SESSIONS,
    defaultDtype: 'q8',
    approxMB: { q8: 42, q4: 94, fp16: 75, fp32: 147 },
    profiles: ['min'],
  },
  {
    id: 'whisper-base',
    repo: 'onnx-community/whisper-base',
    kind: 'asr',
    title: 'Whisper Base · 语音识别（推荐默认）',
    note: '74M 参数。体积和准确率的平衡点，日常课堂够用。50 米外老师用扩音器的场景，配合 audio.js 的降噪/增益通常能出可读的稿子。',
    configs: WHISPER_CONFIGS,
    sessions: SEQ2SEQ_SESSIONS,
    defaultDtype: 'q8',
    approxMB: { q8: 76, q4: 139, fp16: 142, fp32: 280 },
    profiles: ['default'],
  },
  {
    id: 'whisper-small',
    repo: 'onnx-community/whisper-small',
    kind: 'asr',
    title: 'Whisper Small · 语音识别（高精度）',
    note: '244M 参数。远场、口音重、术语多的课最明显的提升在这一档。需要 WebGPU 才跑得动实时，纯 CPU(WASM) 会跟不上。',
    configs: WHISPER_CONFIGS,
    sessions: SEQ2SEQ_SESSIONS,
    defaultDtype: 'q8',
    approxMB: { q8: 240, q4: 288, fp16: 465, fp32: 926 },
    profiles: ['full'],
  },
  {
    id: 'whisper-large-v3-turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    kind: 'asr',
    title: 'Whisper Large v3 Turbo · 语音识别（最准）',
    note: '809M 参数。远场扩音、口音、专业术语都最稳，是 50 米大阶梯教室真正靠谱的一档。必须有独显或 M 系列芯片（WebGPU），纯 CPU 跑不动实时。默认下 q4f16（537MB）；显卡不支持 fp16 或只能用 CPU 时要另外下 q4：--dtype q4。',
    configs: WHISPER_CONFIGS,
    sessions: SEQ2SEQ_SESSIONS,
    defaultDtype: 'q4f16',
    approxMB: { q4f16: 537, q4: 724, q8: 1035, fp16: 1544 },
    profiles: ['max'],
  },
  {
    id: 'opus-mt-en-zh',
    repo: 'Xenova/opus-mt-en-zh',
    kind: 'mt',
    title: 'OPUS-MT 英→中 · 离线翻译',
    note: 'Helsinki-NLP 的英中翻译模型，句子级翻译质量稳定，完全离线。这是「不填 API Key 也能翻译」的兜底方案。',
    configs: MARIAN_CONFIGS,
    sessions: SEQ2SEQ_SESSIONS,
    defaultDtype: 'q8',
    approxMB: { q8: 117, q4: 293, fp16: 222, fp32: 434 },
    profiles: ['min', 'default', 'full', 'max'],
  },
];

const MODELS_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

// ───────────────────────────────────────────────────────────────────────────
// 2. 终端输出小工具
// ───────────────────────────────────────────────────────────────────────────

const IS_TTY = Boolean(process.stdout.isTTY);
const C = IS_TTY
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    }
  : { dim: (s) => s, bold: (s) => s, green: (s) => s, yellow: (s) => s, red: (s) => s, cyan: (s) => s };

const log = (...a) => console.log(...a);
const fail = (...a) => console.error(C.red('[错误]'), ...a);

function mb(bytes) {
  return (bytes / 1048576).toFixed(1);
}

function humanSize(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function humanTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(Math.min(m, 99)).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ───────────────────────────────────────────────────────────────────────────
// 3. HTTP 工具：跟随跳转的 GET（HF 的 resolve 链接会 302 到 CDN）
// ───────────────────────────────────────────────────────────────────────────

const MAX_REDIRECTS = 10;
const UA = 'VoiceCollector-fetch-models/1.0 (+node)';

/**
 * 发起一个会自动跟随 3xx 跳转的请求，拿到最终的 response 流。
 * @param {string} url
 * @param {{headers?:Record<string,string>, timeoutMs?:number}} [opt]
 * @returns {Promise<{res: import('node:http').IncomingMessage, finalUrl: string}>}
 */
function requestFollow(url, opt = {}) {
  const { headers = {}, timeoutMs = 60000 } = opt;
  let redirects = 0;

  return new Promise((resolve, reject) => {
    const go = (current) => {
      let target;
      try {
        target = new URL(current);
      } catch {
        return reject(new Error(`URL 不合法：${current}`));
      }
      const mod = target.protocol === 'http:' ? http : https;
      const req = mod.request(
        target,
        { method: 'GET', headers: { 'User-Agent': UA, ...headers } },
        (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume(); // 丢弃 body，避免 socket 卡住
            if (++redirects > MAX_REDIRECTS) {
              return reject(new Error('跳转次数过多（>10），可能是镜像配置有问题'));
            }
            return go(new URL(res.headers.location, target).toString());
          }
          resolve({ res, finalUrl: target.toString() });
        }
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒没有响应）`));
      });
      req.on('error', reject);
      req.end();
    };
    go(url);
  });
}

/** 读取一个 JSON 接口，返回 { data, linkHeader } */
async function getJSON(url) {
  const { res } = await requestFollow(url, { headers: { Accept: 'application/json' } });
  const code = res.statusCode || 0;
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  if (code !== 200) {
    const err = new Error(`接口返回 HTTP ${code}：${url}\n${body.slice(0, 300)}`);
    err.statusCode = code;
    throw err;
  }
  try {
    return { data: JSON.parse(body), link: res.headers.link || '' };
  } catch {
    throw new Error(`接口返回的不是合法 JSON（${url}），可能被网络中间设备拦截了`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Hugging Face 接口封装（支持镜像）
// ───────────────────────────────────────────────────────────────────────────

function makeEndpoint(raw) {
  // 允许写 'hf-mirror.com'、'https://hf-mirror.com'、'https://hf-mirror.com/'
  let s = String(raw || '').trim();
  if (!s) return 'https://huggingface.co';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

/** 列出仓库里的全部文件（带真实字节数），自动处理分页 */
async function listRepoFiles(endpoint, repo, revision) {
  let url = `${endpoint}/api/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=true`;
  const out = new Map();
  for (let page = 0; page < 20 && url; page++) {
    const { data, link } = await getJSON(url);
    if (!Array.isArray(data)) throw new Error(`仓库 ${repo} 的文件列表格式不对`);
    for (const e of data) {
      if (e.type !== 'file') continue;
      // LFS 文件（.onnx 这种大文件）真实大小在 lfs.size，普通文件在 size
      const size = (e.lfs && typeof e.lfs.size === 'number' ? e.lfs.size : e.size) ?? 0;
      out.set(e.path, { path: e.path, size, oid: (e.lfs && e.lfs.oid) || e.oid || '' });
    }
    const next = /<([^>]+)>;\s*rel="next"/.exec(link || '');
    url = next ? next[1] : null;
  }
  if (out.size === 0) throw new Error(`仓库 ${repo} 看起来是空的，仓库名可能写错了`);
  return out;
}

function fileURL(endpoint, repo, revision, relPath) {
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  return `${endpoint}/${repo}/resolve/${encodeURIComponent(revision)}/${encoded}`;
}

// ───────────────────────────────────────────────────────────────────────────
// 5. 总进度显示（并发下载时，单行聚合比每个文件各画一条进度条清爽得多）
// ───────────────────────────────────────────────────────────────────────────

class Progress {
  constructor(totalBytes, totalFiles) {
    this.totalBytes = totalBytes;
    this.totalFiles = totalFiles;
    this.doneFiles = 0;
    this.doneBytes = 0; // 已完成文件累计
    this.live = new Map(); // 正在下载的文件 -> 已收字节
    this.startAt = Date.now();
    this.lastAt = this.startAt;
    this.lastBytes = 0;
    this.speed = 0; // 字节/秒，指数平滑
    this.stopped = false;
    this.timer = setInterval(() => this.render(), IS_TTY ? 200 : 5000);
    if (this.timer.unref) this.timer.unref();
  }

  current() {
    let n = this.doneBytes;
    for (const v of this.live.values()) n += v;
    return n;
}

  tick(key, bytes) {
    this.live.set(key, bytes);
  }

  finishFile(key, size) {
    this.live.delete(key);
    this.doneBytes += size;
    this.doneFiles += 1;
  }

  /** 跳过的文件不占下载量，但要算进「已完成」 */
  skipFile(size) {
    this.doneBytes += size;
    this.doneFiles += 1;
  }

  render() {
    if (this.stopped) return;
    const now = Date.now();
    const cur = this.current();
    const dt = (now - this.lastAt) / 1000;
    if (dt >= 0.15) {
      const inst = (cur - this.lastBytes) / dt;
      this.speed = this.speed === 0 ? inst : this.speed * 0.7 + inst * 0.3;
      this.lastAt = now;
      this.lastBytes = cur;
    }
    const pct = this.totalBytes > 0 ? Math.min(100, (cur / this.totalBytes) * 100) : 0;
    const eta = this.speed > 1024 ? (this.totalBytes - cur) / this.speed : Infinity;
    const width = 24;
    const filled = Math.round((pct / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const line =
      `  ${bar} ${pct.toFixed(1).padStart(5)}%  ` +
      `${mb(cur)}/${mb(this.totalBytes)} MB  ` +
      `${(this.speed / 1048576).toFixed(2)} MB/s  ` +
      `剩余 ${humanTime(eta)}  ` +
      `文件 ${this.doneFiles}/${this.totalFiles}`;
    if (IS_TTY) {
      process.stdout.write('\r' + line.padEnd(100).slice(0, 118));
    } else {
      process.stdout.write(line.trim() + '\n');
    }
  }

  /** 临时收起进度条，打印一条普通日志，再继续 */
  say(text) {
    if (IS_TTY) process.stdout.write('\r' + ' '.repeat(118) + '\r');
    log(text);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    if (IS_TTY) process.stdout.write('\r' + ' '.repeat(118) + '\r');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 6. 单个文件的下载（断点续传 + 大小校验 + 重试）
// ───────────────────────────────────────────────────────────────────────────

async function statSize(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

/**
 * .part 旁边记一份「这个半成品是给多大的哪个文件下的」。
 * 没有这份记录，一个过期的 .part（比如仓库换了版本、或换了 dtype 复用了文件名）
 * 会被当成有效断点接着下，拼出一个大小刚好、内容是烂的文件。
 */
async function readPartMeta(metaPath) {
  try {
    return JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

async function writePartMeta(metaPath, meta) {
  try {
    await fsp.writeFile(metaPath, JSON.stringify(meta));
  } catch {
    /* 记不上就算了，大不了退回「不续传」 */
  }
}

async function dropPart(partPath) {
  await fsp.rm(partPath, { force: true });
  await fsp.rm(partPath + '.meta', { force: true });
}

/**
 * 下载一个文件到 destPath。
 * - 目标文件已存在且字节数一致 → 直接跳过
 * - 存在 .part 半成品且 .part.meta 对得上 → 用 Range 续传
 * - 下载短了 → 保留 .part，下次接着下（断点续传的关键）
 * - 下载多了 / 来源对不上 → 丢掉重来（绝不留下坏文件）
 */
async function downloadOne({ url, destPath, expectedSize, progress, key, retries, force }) {
  const partPath = destPath + '.part';
  const metaPath = partPath + '.meta';

  if (!force) {
    const have = await statSize(destPath);
    if (have >= 0) {
      if (expectedSize > 0 && have === expectedSize) {
        progress.skipFile(expectedSize);
        return { status: 'skipped', bytes: expectedSize };
      }
      // 大小对不上 = 上次下坏了或者上游更新了，删掉重来
      progress.say(C.yellow(`  · ${path.basename(destPath)} 本地大小 ${humanSize(have)} 与线上 ${humanSize(expectedSize)} 不符，重新下载`));
      await fsp.rm(destPath, { force: true });
    }
  } else {
    await fsp.rm(destPath, { force: true });
    await dropPart(partPath);
  }

  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  // 进程启动时遗留下来的 .part：只有 meta 对得上才敢拿来续传
  {
    const stale = await statSize(partPath);
    if (stale > 0) {
      const meta = await readPartMeta(metaPath);
      if (!meta || meta.size !== expectedSize || meta.url !== url) {
        progress.say(C.yellow(`  · ${path.basename(destPath)} 的断点记录对不上（可能是上个版本留下的），丢弃重下`));
        await dropPart(partPath);
      }
    }
  }
  await writePartMeta(metaPath, { size: expectedSize, url });

  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    let received = 0;
    try {
      let offset = await statSize(partPath);
      if (offset < 0) offset = 0;
      if (expectedSize > 0 && offset >= expectedSize) {
        // .part 已经够长了（多半是上次写完没改名），截断重来最稳
        await dropPart(partPath);
        await writePartMeta(metaPath, { size: expectedSize, url });
        offset = 0;
      }

      const headers = {};
      if (offset > 0) headers.Range = `bytes=${offset}-`;

      const { res } = await requestFollow(url, { headers, timeoutMs: 60000 });
      const code = res.statusCode || 0;

      if (code === 401 || code === 403) {
        res.resume();
        throw Object.assign(new Error('没有权限访问这个文件（401/403）。这几个模型仓库都是公开的，通常是镜像站代理出了问题'), { fatal: true });
      }
      if (code === 404) {
        res.resume();
        throw Object.assign(new Error('文件不存在（404）'), { fatal: true, notFound: true });
      }
      if (code !== 200 && code !== 206) {
        res.resume();
        throw new Error(`服务器返回 HTTP ${code}`);
      }

      // 服务器不支持续传就从头来
      let appendMode = code === 206 && offset > 0;
      if (!appendMode && offset > 0) {
        await fsp.rm(partPath, { force: true });
        offset = 0;
      }

      received = offset;
      progress.tick(key, received);

      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(partPath, { flags: appendMode ? 'a' : 'w' });
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          err ? reject(err) : resolve();
        };
        res.on('data', (chunk) => {
          received += chunk.length;
          progress.tick(key, received);
        });
        res.on('error', (e) => {
          out.destroy();
          done(e);
        });
        out.on('error', done);
        out.on('close', () => done(null));
        res.pipe(out);
      });

      // 校验：字节数必须和 HF API 报的一致
      const got = await statSize(partPath);
      if (expectedSize > 0 && got !== expectedSize) {
        if (got > expectedSize) {
          // 比线上还大 = 这个 .part 的来源不可信（换了分支/文件被改过），只能丢掉
          await dropPart(partPath);
          throw new Error(`下载的字节数比线上还多（${humanSize(got)} > ${humanSize(expectedSize)}），已丢弃重来`);
        }
        // 短了 = 连接被掐断。**保留 .part**，下一次重试用 Range 接着下。
        // 千万不要删：删了就等于每次断线都从 0 开始，大模型在弱网下永远下不完。
        throw new Error(`传输中断：拿到 ${humanSize(got)} / ${humanSize(expectedSize)}，已保留断点`);
      }

      await fsp.rm(metaPath, { force: true });
      await fsp.rename(partPath, destPath);
      progress.finishFile(key, expectedSize > 0 ? expectedSize : got);
      return { status: 'downloaded', bytes: got };
    } catch (e) {
      lastErr = e;
      progress.live.delete(key);
      if (e.fatal) break;
      if (attempt < retries) {
        const wait = attempt * 1500;
        progress.say(C.yellow(`  · ${path.basename(destPath)} 第 ${attempt} 次失败（${e.message}），${wait / 1000} 秒后重试`));
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr || new Error('下载失败，原因未知');
}

// ───────────────────────────────────────────────────────────────────────────
// 7. 并发池
// ───────────────────────────────────────────────────────────────────────────

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: e, item: items[i] };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

// ───────────────────────────────────────────────────────────────────────────
// 8. 参数解析
// ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opt = {
    models: [],
    dtypes: [],
    all: false,
    list: false,
    help: false,
    mirror: '',
    revision: 'main',
    out: DEFAULT_OUT_DIR,
    concurrency: 4,
    retries: 3,
    force: false,
    dryRun: false,
    configsOnly: false,
    profile: '',
  };
  const push = (arr, v) => String(v).split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => arr.push(s));

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 后面缺少取值`);
      return v;
    };
    switch (a) {
      case '--model': case '-m': push(opt.models, next()); break;
      case '--dtype': case '-d': push(opt.dtypes, next()); break;
      case '--profile': opt.profile = next(); break;
      case '--all': case '-a': opt.all = true; break;
      case '--list': case '-l': opt.list = true; break;
      case '--mirror': opt.mirror = next(); break;
      case '--revision': opt.revision = next(); break;
      case '--out': case '-o': opt.out = path.resolve(next()); break;
      case '--concurrency': case '-c': opt.concurrency = Math.max(1, Math.min(16, parseInt(next(), 10) || 4)); break;
      case '--retries': opt.retries = Math.max(1, Math.min(10, parseInt(next(), 10) || 3)); break;
      case '--force': case '-f': opt.force = true; break;
      case '--dry-run': case '-n': opt.dryRun = true; break;
      case '--configs-only': opt.configsOnly = true; break;
      case '--help': case '-h': opt.help = true; break;
      default:
        if (a.startsWith('--model=')) push(opt.models, a.slice(8));
        else if (a.startsWith('--dtype=')) push(opt.dtypes, a.slice(8));
        else if (a.startsWith('--mirror=')) opt.mirror = a.slice(9);
        else if (a.startsWith('--out=')) opt.out = path.resolve(a.slice(6));
        else if (a.startsWith('--profile=')) opt.profile = a.slice(10);
        else throw new Error(`不认识的参数：${a}（用 --help 看用法）`);
    }
  }
  return opt;
}

function printHelp() {
  log(`
${C.bold('fetch-models.mjs')} —— 把离线 AI 模型下载到 web/models/，让 App 不联网也能用

${C.bold('用法')}
  node scripts/fetch-models.mjs [参数]

${C.bold('常用')}
  --list, -l              列出所有可下载的模型（不联网）
  --model, -m <名字>      下载指定模型，可重复或用逗号分隔
                          例：-m whisper-base -m opus-mt-en-zh
  --profile <名字>        按预设套餐下载：min / default / full / max
  --all, -a               下载全部模型（很大，看清体积再用）

${C.bold('网络')}
  --mirror <站点>         用国内镜像，例：--mirror hf-mirror.com
                          也可以用环境变量 HF_ENDPOINT=https://hf-mirror.com
  --retries <次数>        单个文件失败重试次数，默认 3
  --concurrency, -c <N>   同时下载几个文件，默认 4

${C.bold('其它')}
  --dtype, -d <类型>      量化精度：q8(默认,最小) / q4 / fp16 / fp32
                          可写多个：--dtype q8,fp16
  --out, -o <目录>        输出目录，默认 web/models
  --configs-only          只下载小的配置和分词器文件，跳过 onnx 权重
  --force, -f             忽略已有文件，全部重新下载
  --dry-run, -n           只算体积、列文件，不真的下载
  --revision <分支>       模型仓库分支，默认 main

${C.bold('例子')}
  node scripts/fetch-models.mjs --list
  node scripts/fetch-models.mjs --profile default
  node scripts/fetch-models.mjs -m whisper-base -m opus-mt-en-zh --mirror hf-mirror.com
  node scripts/fetch-models.mjs --all --dtype q8 --dry-run
`);
}

function printList() {
  log('');
  log(C.bold('  可下载的模型：'));
  log('');
  for (const m of MODELS) {
    const kind = m.kind === 'asr' ? '语音识别' : '翻译';
    log(`  ${C.cyan(m.id.padEnd(16))} ${m.title}`);
    log(`  ${' '.repeat(16)} ${C.dim('仓库 ' + m.repo + '  用途 ' + kind)}`);
    const sizes = Object.entries(m.approxMB).map(([d, v]) => `${d} ≈${v}MB`).join('  ');
    log(`  ${' '.repeat(16)} ${C.dim('体积 ' + sizes)}`);
    log(`  ${' '.repeat(16)} ${m.note}`);
    log('');
  }
  log(C.bold('  预设套餐（--profile）：'));
  for (const p of ['min', 'default', 'full', 'max']) {
    const ms = MODELS.filter((m) => m.profiles.includes(p));
    // 体积要按每个模型「实际会下的那档精度」算。turbo 默认是 q4f16 而不是 q8，
    // 这里如果一律按 q8 报数，会把 537MB 的套餐说成 1035MB，吓跑人。
    const total = ms.reduce((s, m) => s + (m.approxMB[m.defaultDtype] || 0), 0);
    const dtypeNote = [...new Set(ms.map((m) => m.defaultDtype))].join('/');
    const desc = { min: '能跑就行，装进老电脑', default: '推荐：日常上课这套就够', full: '大教室 / 扩音器，需要好一点的机器', max: '最高识别质量，必须有独显或 M 系列芯片' }[p];
    log(`  ${C.cyan(p.padEnd(16))} ${desc}`);
    log(`  ${' '.repeat(16)} ${C.dim(ms.map((m) => m.id).join(' + ') + '  合计 ≈' + total + ' MB (' + dtypeNote + ')')}`);
  }
  log('');
  log(C.dim('  下载后的位置：web/models/<组织>/<仓库名>/'));
  log(C.dim('  前端需要设置 env.allowRemoteModels = false; env.localModelPath = \'./models/\';'));
  log('');
}

// ───────────────────────────────────────────────────────────────────────────
// 9. 主流程
// ───────────────────────────────────────────────────────────────────────────

/** 把一个模型展开成「要下载的文件清单」 */
function planFiles(model, dtypes, configsOnly) {
  const wanted = [];
  for (const c of model.configs) wanted.push({ path: c.file, optional: !!c.optional, small: true });
  if (!configsOnly) {
    for (const dtype of dtypes) {
      const suffix = DTYPE_SUFFIX[dtype];
      if (suffix === undefined) throw new Error(`不支持的 dtype：${dtype}（可用：${Object.keys(DTYPE_SUFFIX).join(' / ')}）`);
      for (const s of model.sessions) {
        wanted.push({ path: `onnx/${s}${suffix}.onnx`, optional: false, small: false, dtype });
      }
    }
  }
  return wanted;
}

function networkHint(endpoint, err) {
  const msg = String((err && err.message) || err);
  const lines = [];
  lines.push(C.red('  连不上模型服务器：') + msg);
  lines.push('');
  if (/huggingface\.co/.test(endpoint)) {
    lines.push('  ' + C.bold('八成是网络被挡了。') + '在中国大陆 huggingface.co 通常访问不了，请改用镜像：');
    lines.push('');
    lines.push(C.cyan('      node scripts/fetch-models.mjs --mirror hf-mirror.com ' + process.argv.slice(2).filter((a) => a !== '--mirror').join(' ')));
    lines.push('');
    lines.push('  或者设一次环境变量，之后都走镜像：');
    lines.push(C.cyan('      export HF_ENDPOINT=https://hf-mirror.com'));
  } else {
    lines.push('  这次用的是镜像 ' + C.bold(endpoint) + '，镜像也可能临时挂掉。可以试试：');
    lines.push('    1. 去掉 --mirror，直连 huggingface.co（需要能正常访问国外网站）');
    lines.push('    2. 换一个镜像地址');
    lines.push('    3. 过几分钟再跑一次，脚本支持断点续传，已经下好的不会重下');
  }
  lines.push('');
  lines.push(C.dim('  实在下不动也不影响用：App 会退回到浏览器自带的识别/翻译，只是效果差一些。'));
  return lines.join('\n');
}

async function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (e) {
    fail(e.message);
    process.exit(2);
  }

  if (opt.help) return printHelp();
  if (opt.list) return printList();

  // 选模型
  let chosen = [];
  if (opt.all) {
    chosen = MODELS.slice();
  } else if (opt.profile) {
    chosen = MODELS.filter((m) => m.profiles.includes(opt.profile));
    if (chosen.length === 0) {
      fail(`没有叫 "${opt.profile}" 的套餐，可用：min / default / full / max`);
      process.exit(2);
    }
  } else if (opt.models.length) {
    for (const id of opt.models) {
      const m = MODELS_BY_ID.get(id);
      if (!m) {
        fail(`没有叫 "${id}" 的模型。用 --list 看有哪些。`);
        process.exit(2);
      }
      if (!chosen.includes(m)) chosen.push(m);
    }
  } else {
    log('');
    log('  没指定要下载什么。先看看有哪些模型：');
    log('');
    log(C.cyan('      node scripts/fetch-models.mjs --list'));
    log('');
    log('  或者直接下推荐套餐（Whisper Base + 英中翻译，约 193 MB）：');
    log('');
    log(C.cyan('      node scripts/fetch-models.mjs --profile default'));
    log('');
    return;
  }

  const dtypes = opt.dtypes.length ? opt.dtypes : null;

  // dtype 在任何联网动作之前就校验掉：写错一个字母不该先等一轮网络请求才报错
  for (const d of opt.dtypes) {
    if (DTYPE_SUFFIX[d] === undefined) {
      fail(`不支持的 dtype：${d}（可用：${Object.keys(DTYPE_SUFFIX).join(' / ')}）`);
      process.exit(2);
    }
  }
  const endpoint = makeEndpoint(opt.mirror || process.env.HF_ENDPOINT || 'huggingface.co');
  const usingMirror = !/^https:\/\/huggingface\.co$/i.test(endpoint);

  log('');
  log(C.bold('  VoiceCollector 离线模型下载'));
  log(C.dim(`  来源：${endpoint}${usingMirror ? '（镜像）' : ''}`));
  log(C.dim(`  存到：${opt.out}`));
  log('');

  // ── 第一步：问清单、算体积 ────────────────────────────────────────────
  log('  正在查询模型文件清单…');
  const tasks = [];
  let totalBytes = 0;
  const perModel = [];

  for (const m of chosen) {
    const useDtypes = dtypes || [m.defaultDtype];
    let tree;
    try {
      tree = await listRepoFiles(endpoint, m.repo, opt.revision);
    } catch (e) {
      log('');
      console.error(networkHint(endpoint, e));
      log('');
      process.exit(1);
    }

    let plan;
    try {
      plan = planFiles(m, useDtypes, opt.configsOnly);
    } catch (e) {
      fail(e.message);
      process.exit(2);
    }

    let modelBytes = 0;
    const modelTasks = [];
    for (const want of plan) {
      const entry = tree.get(want.path);
      if (!entry) {
        if (want.optional) continue;
        fail(`仓库 ${m.repo} 里没有 ${want.path}。`);
        fail('这一般说明仓库更新了文件名，请把这个信息反馈给开发者，不要自己乱改。');
        process.exit(1);
      }
      const addTask = (relPath, size) => {
        modelBytes += size;
        modelTasks.push({
          model: m,
          rel: relPath,
          size,
          url: fileURL(endpoint, m.repo, opt.revision, relPath),
          destPath: path.join(opt.out, ...m.repo.split('/'), ...relPath.split('/')),
          key: `${m.repo}/${relPath}`,
        });
      };

      addTask(want.path, entry.size);

      // 超过 2GB 的 ONNX 会把权重拆到旁边的 <名字>.onnx_data 里（protobuf 的硬上限）。
      // 少下这个 sidecar，.onnx 本身看着"下载成功"，一加载就报 missing external data。
      // 例：onnx-community/whisper-large-v3-turbo 的 encoder_model.onnx 只有 429KB，
      //     真正的 2.4GB 权重全在 encoder_model.onnx_data 里。
      for (const suffix of ['_data', '.data']) {
        const sidecar = want.path + suffix;
        const se = tree.get(sidecar);
        if (se) addTask(sidecar, se.size);
      }
    }
    totalBytes += modelBytes;
    perModel.push({ model: m, bytes: modelBytes, count: modelTasks.length, dtypes: useDtypes });
    tasks.push(...modelTasks);
  }

  for (const p of perModel) {
    log(`  · ${C.cyan(p.model.id.padEnd(16))} ${String(p.count).padStart(2)} 个文件  ${humanSize(p.bytes).padStart(9)}  ${C.dim('精度 ' + p.dtypes.join(','))}`);
  }
  log('');
  log(`  合计 ${C.bold(humanSize(totalBytes))}，共 ${tasks.length} 个文件`);
  log('');

  if (opt.dryRun) {
    log(C.dim('  （--dry-run：只是算一算，没有真的下载）'));
    for (const t of tasks) {
      log(C.dim(`    ${humanSize(t.size).padStart(9)}  ${t.model.repo}/${t.rel}`));
    }
    log('');
    return;
  }

  // ── 第二步：并发下载 ─────────────────────────────────────────────────
  const progress = new Progress(totalBytes, tasks.length);
  const t0 = Date.now();

  const results = await runPool(tasks, opt.concurrency, async (t) => {
    const r = await downloadOne({
      url: t.url,
      destPath: t.destPath,
      expectedSize: t.size,
      progress,
      key: t.key,
      retries: opt.retries,
      force: opt.force,
    });
    return { ...r, task: t };
  });

  progress.stop();

  // ── 第三步：汇报 ─────────────────────────────────────────────────────
  const failed = results.filter((r) => r && !r.ok);
  const skipped = results.filter((r) => r && r.ok && r.value.status === 'skipped');
  const got = results.filter((r) => r && r.ok && r.value.status === 'downloaded');
  const gotBytes = got.reduce((s, r) => s + r.value.bytes, 0);
  const secs = (Date.now() - t0) / 1000;

  log('');
  if (got.length) {
    log(`  ${C.green('✓')} 新下载 ${got.length} 个文件，${humanSize(gotBytes)}，用时 ${humanTime(secs)}` +
        (secs > 1 ? C.dim(`（平均 ${(gotBytes / 1048576 / secs).toFixed(2)} MB/s）`) : ''));
  }
  if (skipped.length) log(`  ${C.green('✓')} 跳过 ${skipped.length} 个已存在且完整的文件`);

  if (failed.length) {
    log('');
    fail(`有 ${failed.length} 个文件没下成功：`);
    for (const f of failed) {
      log(`    ${C.red('×')} ${f.item.model.repo}/${f.item.rel}`);
      log(`      ${C.dim(String(f.error && f.error.message))}`);
    }
    log('');
    log('  ' + C.bold('重新跑一遍同样的命令就行') + '，已经下好的会自动跳过，只补没下完的。');
    if (!usingMirror) {
      log('  如果一直失败，八成是网络问题，加上镜像再试：');
      log(C.cyan('      --mirror hf-mirror.com'));
    }
    log('');
    process.exit(1);
  }

  log('');
  const rel = path.relative(PROJECT_ROOT, opt.out);
  const shown = !rel || rel.startsWith('..') || path.isAbsolute(rel) ? opt.out : rel;
  log(`  ${C.green(C.bold('全部就绪。'))}模型已经放在 ${C.cyan(shown)} 下。`);
  log('');
  log(C.dim('  前端记得这样配置 transformers.js（离线读本地）：'));
  log(C.dim("      env.allowRemoteModels = false;"));
  log(C.dim("      env.localModelPath = './models/';"));
  for (const p of perModel) {
    log(C.dim(`      // ${p.model.id} → '${p.model.repo}'`));
  }
  log('');
}

main().catch((e) => {
  log('');
  fail(String((e && e.stack) || e));
  log('');
  process.exit(1);
});
