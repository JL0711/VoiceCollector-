// 导出：Markdown / Word(.doc) / 纯文本 / 字幕 / JSON
import { mmss, dateCN, dateFile, esc, md2html, download } from './util.js';

const BRAND = 'VoiceCollector · 晗晗专属';

function meta(s, ctx) {
  return { teacher: ctx.teacher || '未填写', course: ctx.course || '未填写' };
}

export function toMarkdown(s, ctx = {}) {
  const m = meta(s, ctx);
  let o = `# ${s.title}\n\n`;
  o += `- **学科**：${m.course}\n- **老师**：${m.teacher}\n- **时间**：${dateCN(s.startedAt)}\n`;
  o += `- **时长**：${mmss(s.durationMs || 0)}\n- **记录**：${BRAND}\n\n---\n\n`;
  o += `# 一、课堂概要\n\n${s.summary || '（未生成）'}\n\n---\n\n`;
  o += `# 二、完整讲稿（老师说的每一句）\n\n`;
  for (const g of s.segments) {
    if (g.kind === 'mark') { o += `\n> ⭐ **重点标记** \`[${mmss(g.t)}]\` ${g.text || ''}\n\n`; continue; }
    if (g.kind === 'note') { o += `\n> 📝 **我的笔记** \`[${mmss(g.t)}]\` ${g.text}\n\n`; continue; }
    o += `**[${mmss(g.t)}]** ${g.text}\n`;
    if (g.zh) o += `> ${g.zh}\n`;
    o += `\n`;
  }
  return o;
}

export function toText(s, ctx = {}) {
  const m = meta(s, ctx);
  let o = `${s.title}\n${'='.repeat(30)}\n学科：${m.course}\n老师：${m.teacher}\n时间：${dateCN(s.startedAt)}\n时长：${mmss(s.durationMs || 0)}\n\n【课堂概要】\n${(s.summary || '').replace(/[#*`>]/g, '')}\n\n【完整讲稿】\n`;
  for (const g of s.segments) {
    const tag = g.kind === 'mark' ? '⭐ ' : g.kind === 'note' ? '📝 ' : '';
    o += `[${mmss(g.t)}] ${tag}${g.text}\n`;
    if (g.zh) o += `        ${g.zh}\n`;
  }
  return o;
}

export function toDocHtml(s, ctx = {}) {
  const m = meta(s, ctx);
  let body = `<h1>${esc(s.title)}</h1>
<p style="color:#666">学科：${esc(m.course)} ｜ 老师：${esc(m.teacher)} ｜ 时间：${dateCN(s.startedAt)} ｜ 时长：${mmss(s.durationMs || 0)}</p>
<p style="color:#999;font-size:10pt">${BRAND}</p><hr>
<h1>一、课堂概要</h1>${md2html(s.summary || '（未生成）')}
<div style="page-break-before:always"></div><h1>二、完整讲稿</h1>`;
  for (const g of s.segments) {
    if (g.kind === 'mark' || g.kind === 'note') {
      body += `<p style="background:#fff7e0;border-left:4px solid #f0a500;padding:6px 10px"><b>${g.kind === 'mark' ? '⭐ 重点' : '📝 笔记'} [${mmss(g.t)}]</b> ${esc(g.text)}</p>`;
      continue;
    }
    body += `<p style="margin:0 0 10px"><span style="color:#999;font-size:9pt">[${mmss(g.t)}]</span> ${esc(g.text)}`;
    if (g.zh) body += `<br><span style="color:#0a6b3d">${esc(g.zh)}</span>`;
    body += `</p>`;
  }
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(s.title)}</title>
<style>body{font-family:"PingFang SC","Microsoft YaHei",Calibri,sans-serif;font-size:11pt;line-height:1.6}
h1{font-size:17pt}h2{font-size:14pt}h3{font-size:12pt}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:4px 8px}
blockquote{border-left:3px solid #7c5cff;margin:8px 0;padding:4px 12px;color:#333}</style></head><body>${body}</body></html>`;
}

export function toSrt(s) {
  const stamp = ms => {
    const t = Math.max(0, ms), h = Math.floor(t / 3600000), m = Math.floor(t % 3600000 / 60000),
          sec = Math.floor(t % 60000 / 1000), ms3 = Math.floor(t % 1000);
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(h)}:${p(m)}:${p(sec)},${p(ms3, 3)}`;
  };
  const segs = s.segments.filter(g => g.kind !== 'mark');
  return segs.map((g, i) => {
    const end = segs[i + 1] ? segs[i + 1].t : g.t + 5000;
    return `${i + 1}\n${stamp(g.t)} --> ${stamp(Math.max(end, g.t + 900))}\n${g.text}${g.zh ? '\n' + g.zh : ''}\n`;
  }).join('\n');
}

// 只有老师说的话 —— 最常用的一个导出
export function toPlainTranscript(s, ctx = {}) {
  const m = meta(s, ctx);
  let o = `${s.title}\n${m.course} ｜ ${m.teacher} ｜ ${dateCN(s.startedAt)} ｜ 时长 ${mmss(s.durationMs || 0)}\n${'-'.repeat(50)}\n\n`;
  for (const g of s.segments) {
    if (g.kind !== 'speech') continue;
    o += `[${mmss(g.t)}] ${g.text}\n`;
    if (g.zh) o += `          ${g.zh}\n`;
    o += '\n';
  }
  return o;
}

export function toPlainDocHtml(s, ctx = {}) {
  const m = meta(s, ctx);
  let body = `<h1>${esc(s.title)}</h1>
<p style="color:#666">${esc(m.course)} ｜ ${esc(m.teacher)} ｜ ${dateCN(s.startedAt)} ｜ 时长 ${mmss(s.durationMs || 0)} ｜ 共 ${s.segments.filter(x => x.kind === 'speech').length} 句</p>
<p style="color:#999;font-size:10pt">${BRAND} · 以下是这节课老师说的每一句话</p><hr>`;
  for (const g of s.segments) {
    if (g.kind !== 'speech') continue;
    body += `<p style="margin:0 0 12px"><span style="color:#999;font-size:9pt">[${mmss(g.t)}]</span> ${esc(g.text)}`;
    if (g.zh) body += `<br><span style="color:#0a6b3d">${esc(g.zh)}</span>`;
    body += `</p>`;
  }
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(s.title)}</title>
<style>body{font-family:"PingFang SC","Microsoft YaHei",Calibri,sans-serif;font-size:11pt;line-height:1.7}h1{font-size:17pt}</style>
</head><body>${body}</body></html>`;
}

export function fileBase(s, ctx = {}) {
  const safe = t => String(t || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  return `${dateFile(s.startedAt)}_${safe(ctx.course)}_${safe(ctx.teacher)}_${safe(s.title)}`.replace(/_+/g, '_');
}

export function saveAll(kind, s, ctx) {
  const b = fileBase(s, ctx);
  if (kind === 'md')   return download(b + '.md',  toMarkdown(s, ctx), 'text/markdown;charset=utf-8');
  if (kind === 'txt')  return download(b + '.txt', toText(s, ctx), 'text/plain;charset=utf-8');
  if (kind === 'doc')  return download(b + '.doc', '﻿' + toDocHtml(s, ctx), 'application/msword;charset=utf-8');
  if (kind === 'srt')  return download(b + '.srt', toSrt(s), 'text/plain;charset=utf-8');
  if (kind === 'json') return download(b + '.json', JSON.stringify({ ...s, _ctx: ctx }, null, 2), 'application/json');
  if (kind === 'plain') return download(b + '_老师原话.txt', toPlainTranscript(s, ctx), 'text/plain;charset=utf-8');
  if (kind === 'fulldoc') return download(b + '_老师原话.doc', '\ufeff' + toPlainDocHtml(s, ctx), 'application/msword;charset=utf-8');
}
