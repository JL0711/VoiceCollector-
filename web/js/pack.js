// pack.js —— 课程包：把一节课（讲稿 + 翻译 + 笔记 + 概要 + 原始录音）打成一个文件
//
// 为什么需要：
//   桌面 App（Electron）和 Chrome 各有各的 IndexedDB，是两个完全独立的数据库。
//   用 App 录的课，在浏览器里看不到。反过来也一样。
//   所以给一个能搬运的单文件格式：App 里导出 → 拖进浏览器版 → 一切照旧，
//   包括**原始录音**，所以到了浏览器那边还能重新识别、重新翻译、让 AI 讲解。
//
// 文件格式（自己定的，够简单就行，不依赖任何压缩库）：
//   "VCPACK1\n"                    8 字节魔数
//   "<headerLen>\n"                头部长度，十进制 ASCII，后跟换行
//   <header>                       UTF-8 的 JSON：课程元数据 + 各段二进制的长度
//   <body>                         录音字节，然后是各个分段音频的字节，按头部里的顺序拼接
//
// 之所以不用 zip：浏览器里没有内置的 zip 编码器，引第三方库不值得。
// 录音本身已经是压缩过的 opus，再套一层 zip 基本不会变小。

const MAGIC = 'VCPACK1\n';
const enc = new TextEncoder();
const dec = new TextDecoder();

/** 把一节课打成 Blob。audio / chunks 传 null 表示不带 */
export function buildPack(session, ctx, audioBlob, chunkList) {
  const parts = [];
  const header = {
    v: 1,
    exportedAt: Date.now(),
    app: 'VoiceCollector',
    ctx: { teacher: (ctx && ctx.teacher) || '', course: (ctx && ctx.course) || '' },
    session: { ...session },
    audio: null,
    chunks: []
  };
  // session 里不该带二进制
  delete header.session.__audio;

  if (audioBlob && audioBlob.size) {
    header.audio = { type: audioBlob.type || 'audio/webm', size: audioBlob.size };
    parts.push(audioBlob);
  }
  for (const c of (chunkList || [])) {
    if (!c || !c.blob || !c.blob.size) continue;
    header.chunks.push({ i: c.i, at: c.at || 0, type: c.blob.type || 'audio/webm', size: c.blob.size });
    parts.push(c.blob);
  }

  const headBytes = enc.encode(JSON.stringify(header));
  return new Blob([MAGIC, String(headBytes.length) + '\n', headBytes, ...parts],
    { type: 'application/octet-stream' });
}

/** 解析课程包。返回 {header, session, ctx, audioBlob, chunks} */
export async function parsePack(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (dec.decode(head) !== MAGIC) throw new Error('这不是 VoiceCollector 的课程包文件');

  // 头部长度那一行最多不会超过 20 字节
  const lenRaw = dec.decode(new Uint8Array(await file.slice(8, 28).arrayBuffer()));
  const nl = lenRaw.indexOf('\n');
  if (nl < 0) throw new Error('课程包已损坏（读不到头部长度）');
  const headerLen = parseInt(lenRaw.slice(0, nl), 10);
  if (!(headerLen > 0)) throw new Error('课程包已损坏（头部长度不合法）');

  const headStart = 8 + nl + 1;
  const header = JSON.parse(dec.decode(new Uint8Array(await file.slice(headStart, headStart + headerLen).arrayBuffer())));

  let off = headStart + headerLen;
  let audioBlob = null;
  if (header.audio && header.audio.size) {
    audioBlob = file.slice(off, off + header.audio.size, header.audio.type);
    off += header.audio.size;
  }
  const chunks = [];
  for (const c of header.chunks || []) {
    chunks.push({ i: c.i, at: c.at, blob: file.slice(off, off + c.size, c.type) });
    off += c.size;
  }
  return { header, session: header.session, ctx: header.ctx, audioBlob, chunks };
}

/** 文件名：日期_学科_老师_标题.vcpack */
export function packName(session, ctx) {
  const d = new Date(session.startedAt || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const safe = (t) => String(t || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${safe(ctx && ctx.course)}_${safe(ctx && ctx.teacher)}_${safe(session.title)}.vcpack`
    .replace(/_+/g, '_');
}

/** 人能看懂的体积 */
export function humanSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
