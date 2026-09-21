// cloud.js —— 把课程自动备份到云盘文件夹（iCloud / Google Drive / OneDrive / 坚果云…）
//
// 为什么是这个方案，而不是"真正的云端账号"：
//   · 真云端需要我搭一台服务器、她注册账号、录音上传给第三方。
//     这既违背「不要账号不要 Key」，也意味着老师的课堂录音要交给别人保管。
//   · 而她电脑上本来就有 iCloud Drive / Google Drive。只要把课程包写进那个文件夹，
//     云盘自己就会同步。零注册、零配置、离线照常用、换设备文件还在。
//
// 工作方式：
//   IndexedDB 仍然是**主存储**（快、支持搜索、离线），云盘文件夹是**自动备份**。
//   每节课结束后自动写一个 .vcpack 进去（讲稿 + 翻译 + 笔记 + 原始录音，单文件）。
//   电脑坏了 / 换电脑，在新机器上「导入课程包」就全回来了。
//
// 技术：File System Access API（Chrome / Edge / Electron 都支持）。
//   目录句柄存在 IndexedDB 里，下次打开自动恢复，不用每次重选。
//   ⚠️ 权限不是永久的：浏览器重启后第一次写入需要用户点一下确认。

import { put, get } from './db.js';

const KEY = 'cloud.dir';

export function supported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** 让用户选一个文件夹（必须在点击事件里调用） */
export async function pickFolder() {
  if (!supported()) throw new Error('这个浏览器不支持选择文件夹（需要 Chrome / Edge，或用桌面版）');
  const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'vc-backup', startIn: 'documents' });
  await put('kv', { k: KEY, handle: dir, name: dir.name, at: Date.now() });
  return dir;
}

/** 取回上次选的文件夹（可能需要重新授权） */
export async function getFolder({ prompt = false } = {}) {
  let rec = null;
  try { rec = await get('kv', KEY); } catch (_) { return null; }
  if (!rec || !rec.handle) return null;
  const dir = rec.handle;
  let perm = 'prompt';
  try { perm = await dir.queryPermission({ mode: 'readwrite' }); } catch (_) { return null; }
  if (perm === 'granted') return dir;
  if (!prompt) return null;                       // 不在用户手势里，别弹权限框
  try {
    perm = await dir.requestPermission({ mode: 'readwrite' });
  } catch (_) { return null; }
  return perm === 'granted' ? dir : null;
}

export async function folderName() {
  try { const rec = await get('kv', KEY); return rec && rec.name || ''; } catch (_) { return ''; }
}

export async function forget() {
  try { await put('kv', { k: KEY, handle: null, name: '', at: Date.now() }); } catch (_) {}
}

/** 写一个文件进去（同名覆盖） */
export async function writeFile(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return true;
}

/** 列出文件夹里的课程包 */
export async function listPacks(dir) {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file' || !name.endsWith('.vcpack')) continue;
    try {
      const f = await h.getFile();
      out.push({ name, size: f.size, at: f.lastModified, handle: h });
    } catch (_) {}
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function readPack(entry) { return entry.handle.getFile(); }

/**
 * 备份一节课。已经备份过且没变动就跳过（避免每次打开都重写几十 MB 到云盘）。
 * @returns {Promise<{ok:boolean, skipped?:boolean, name?:string, size?:number, reason?:string}>}
 */
export async function backupSession(session, ctx, { dir, buildPack, packName, getAudio, getChunks, force = false } = {}) {
  if (!dir) return { ok: false, reason: '没有选备份文件夹' };
  const name = packName(session, ctx);

  // 指纹：内容没变就不重复写（云盘同步很贵，别浪费流量和 SSD 寿命）
  const stamp = [session.id, session.segments.length, session.endedAt || 0,
    (session.summary || '').length, (session.myNotes || '').length,
    session.perfectedAt || 0, session.redoneAt || 0].join('-');
  if (!force) {
    try {
      const done = await get('kv', 'cloud.done.' + session.id);
      if (done && done.stamp === stamp) return { ok: true, skipped: true, name };
    } catch (_) {}
  }

  const audio = session.hasAudio && getAudio ? await getAudio(session.id) : null;
  const chunks = session.hasChunks && getChunks ? await getChunks(session.id) : [];
  const blob = buildPack(session, ctx, audio, chunks);
  await writeFile(dir, name, blob);
  try { await put('kv', { k: 'cloud.done.' + session.id, stamp, at: Date.now(), name, size: blob.size }); } catch (_) {}
  return { ok: true, name, size: blob.size };
}

/** 批量备份，逐个回调进度 */
export async function backupAll(sessions, opts, onEach) {
  let ok = 0, skipped = 0, fail = 0, bytes = 0;
  for (const s of sessions) {
    try {
      const r = await backupSession(s, opts.ctxOf(s), opts);
      if (r.skipped) skipped++; else { ok++; bytes += r.size || 0; }
      if (onEach) onEach(s, r);
    } catch (e) {
      fail++;
      if (onEach) onEach(s, { ok: false, reason: e.message });
    }
  }
  return { ok, skipped, fail, bytes };
}

/** 常见云盘在 macOS 上的位置，用来给用户一点提示 */
export const CLOUD_HINTS = [
  ['iCloud 云盘', '访达侧边栏的「iCloud 云盘」，在里面新建一个「课堂录音」文件夹'],
  ['Google Drive', '装了 Google Drive 桌面版之后，访达里会有「Google Drive」'],
  ['OneDrive', '访达侧边栏的「OneDrive」'],
  ['坚果云 / Dropbox', '它们的同步文件夹，通常在个人目录下']
];
