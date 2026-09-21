export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));

export function hhmmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor(s % 3600 / 60)).padStart(2, '0');
  const x = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${x}`;
}
export const mmss = ms => hhmmss(ms).replace(/^00:/, '');

export function dateCN(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function dateFile(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const words = t => (String(t || '').trim().match(/[一-龥]|[A-Za-z0-9'’-]+/g) || []).length;

export function download(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// 极简 Markdown → HTML（支持概要/笔记里会出现的语法：标题、列表、引用、表格、代码、分割线）
export function md2html(md) {
  // 去掉 HTML 注释（离线分析里会用注释标注备用内容）
  const src = String(md || '').replace(/<!--[\s\S]*?-->/g, '');
  const lines = src.split('\n');
  let out = '', list = null, inCode = false, codeBuf = '';

  const inline = t => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  const isRow = l => /^\s*\|.*\|\s*$/.test(l);
  const isSep = l => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\s+$/, '');

    if (/^\s*```/.test(l)) {
      if (inCode) { out += `<pre><code>${esc(codeBuf)}</code></pre>`; codeBuf = ''; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf += lines[i] + '\n'; continue; }

    // 表格：一行表头 + 一行分隔 + 若干行数据
    if (isRow(l) && isRow(lines[i + 1] || '') && isSep(lines[i + 1])) {
      closeList();
      const head = cells(l);
      let body = '';
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) {
        body += '<tr>' + cells(lines[j]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
        j++;
      }
      out += `<table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
      i = j - 1;
      continue;
    }

    let m;
    if (!l.trim()) { closeList(); continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { closeList(); const n = Math.min(6, m[1].length + 1); out += `<h${n}>${inline(m[2])}</h${n}>`; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(l)) { closeList(); out += '<hr>'; continue; }
    // 任务清单 - [ ] / - [x]
    if ((m = l.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out += '<ul class="task">'; list = 'ul'; }
      out += `<li><input type="checkbox" disabled ${m[1].toLowerCase() === 'x' ? 'checked' : ''}> ${inline(m[2])}</li>`;
      continue;
    }
    if ((m = l.match(/^\s*[-*•]\s+(.*)$/))) { if (list !== 'ul') { closeList(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { closeList(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = l.match(/^>\s?(.*)$/))) { closeList(); out += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if (/^\s{2,}[-*•]\s+/.test(lines[i])) {          // 二级缩进的子项
      if (list) { out += `<li style="margin-left:18px;list-style:circle">${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`; continue; }
    }
    if (/^<(small|div|p|table|br|hr)/i.test(l.trim())) { closeList(); out += l; continue; }   // 允许少量原样 HTML
    closeList(); out += `<p>${inline(l)}</p>`;
  }
  if (inCode && codeBuf) out += `<pre><code>${esc(codeBuf)}</code></pre>`;
  closeList();
  return out;
}
