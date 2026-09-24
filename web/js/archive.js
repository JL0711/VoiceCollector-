// 录音留档：每节课下课后，在 App 外面存一个文件夹，全是通用格式。
//
// 为什么：以前设置里「自动备份」是开着的，但备份位置从来是空的 —— 一次都没备份过。
// 她所有的录音只存在 App 自己的数据库里，App 数据一坏（或者像之前那样每次换端口）就全没了。
//
// 放在哪：默认 iCloud 云盘/VoiceCollector 存档（macOS 自带，自动同步到云端，换电脑手机都在）。
//        没有 iCloud 就放「文稿/VoiceCollector 存档」。设置里可以改。
//
// 存什么（全是以后不用这个 App 也能打开的格式）：
//   <学科>/<日期 时间 标题>/
//     录音.webm                    原始录音
//     课堂概要.md                  下课自动生成的概要（她在 App 里改过的话是改过的版本）
//     讲稿（英文+中文）.md          老师说的每一句话 + 翻译，带时间点
//     我的笔记.md                  她自己记的（有才写）
//     课程包.vcpack                 拖回 App「导入课程包」就能完整恢复
//     说明.txt
//
// 桌面版才有（网页版用原来的下载 / 选文件夹备份）。

import { mmss, dateCN } from './util.js';

// 文件名里不能有的字符：/ 换成 -（日期好看），: 换成 .（时间好看），其余换成 _
const safe = s => String(s || '').replace(/\//g, '-').replace(/:/g, '.')
  .replace(/[\\*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || '未命名';
const pad = n => String(n).padStart(2, '0');

export const available = () => !!(window.VCDesktop && window.VCDesktop.archive);

export async function root(st) {
  if (!available()) return '';
  if (st && st.archiveDir) return st.archiveDir;
  try { return await window.VCDesktop.archive.defaultRoot(); } catch (_) { return ''; }
}

export function folderFor(s, ctx) {
  if (s.archiveRel) return s.archiveRel;          // 第一次定下来就不变，改标题也不会生出第二个文件夹
  const d = new Date(s.startedAt || Date.now());
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${safe(ctx.course || '未分类')}/${stamp} ${safe(s.title)}`;
}

function transcriptMd(s, ctx) {
  const lines = [`# ${s.title}`, '', [ctx.course, ctx.teacher, dateCN(s.startedAt)].filter(Boolean).join(' · '), ''];
  for (const x of s.segments || []) {
    if (x.kind === 'mark') { lines.push(`**⭐ [${mmss(x.t || 0)}] 标记重点**`, ''); continue; }
    if (x.kind === 'note') { lines.push(`> 📝 [${mmss(x.t || 0)}] ${x.text}`, ''); continue; }
    if (x.kind !== 'speech' || !x.text) continue;
    lines.push(`**[${mmss(x.t || 0)}]** ${x.text}`);
    if (x.zh) lines.push(`　　${x.zh}`);
    lines.push('');
  }
  return lines.join('\n');
}

const README = (s, ctx) => `这是 VoiceCollector 自动存下来的一节课。

课程：${s.title}
${[ctx.course, ctx.teacher].filter(Boolean).join(' · ')}
时间：${dateCN(s.startedAt)}　时长 ${mmss(s.durationMs || 0)}

录音.webm              原始录音（Chrome、VLC、QuickTime 都能播）
课堂概要.md            概要（任何文本编辑器都能打开）
讲稿（英文+中文）.md   老师说的每一句话和翻译，带时间点
我的笔记.md            自己记的笔记
课程包.vcpack          在 VoiceCollector 里「导入课程包」可以完整恢复这节课

这个文件夹在 App 外面，App 删掉、电脑重装，只要云盘在，它就在。
`;

/**
 * 把一节课整个存到存档文件夹。已经存过的会覆盖成最新版本。
 * @param {object} s    session
 * @param {object} ctx  { teacher, course }
 * @param {object} deps { st, audio: Blob|null, pack: Blob|null }
 * @returns {Promise<{ok:boolean, dir?:string, rel?:string, error?:string}>}
 */
export async function saveSession(s, ctx, { st, audio, pack } = {}) {
  if (!available()) return { ok: false, error: '只有桌面版有存档' };
  const base = await root(st);
  if (!base) return { ok: false, error: '找不到存档位置' };
  const rel = folderFor(s, ctx);
  const W = (name, data) => window.VCDesktop.archive.write(base, `${rel}/${name}`, data);

  const files = [
    ['课堂概要.md', s.summary || '（这节课还没有概要）'],
    ['讲稿（英文+中文）.md', transcriptMd(s, ctx)],
    ['说明.txt', README(s, ctx)]
  ];
  if (s.myNotes) files.push(['我的笔记.md', s.myNotes]);

  for (const [name, text] of files) {
    const r = await W(name, text);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || '写入失败', code: r && r.code };
  }
  // 大文件放后面：前面的小文件先落盘，万一录音太大写失败，至少文字都在
  if (audio && audio.size) {
    const ext = /mp4|m4a|aac/.test(audio.type || '') ? 'm4a' : /ogg/.test(audio.type || '') ? 'ogg' : 'webm';
    const r = await W('录音.' + ext, await audio.arrayBuffer());
    if (!r || !r.ok) return { ok: false, error: '录音没存上：' + ((r && r.error) || ''), code: r && r.code };
  }
  if (pack && pack.size) {
    const r = await W('课程包.vcpack', await pack.arrayBuffer());
    if (!r || !r.ok) return { ok: false, error: '课程包没存上：' + ((r && r.error) || '') };
  }
  return { ok: true, dir: base + '/' + rel, rel };
}
