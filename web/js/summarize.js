// 课堂概要：云端 AI（最好） → Chrome 内置摘要 → 本地离线摘要（永远兜底，保证一定有结果）
import { ask, aiReady } from './ai.js';
import { translate, withTimeout } from './translate.js';
import { mmss } from './util.js';

const SYS = `你是一位顶尖的学习助理，正在帮一位中国留学生整理大学课堂笔记。
输入是课堂录音的自动转写稿（可能有识别错误、口语、重复，请自行判断并纠正明显的错词）。
请输出一份**中文**的课堂笔记，使用 Markdown，结构如下（没有内容的小节就省略，不要编造）：

## 一句话总结
## 本节脉络
（按时间顺序的提纲，每条前面标上时间点，如 \`[12:30]\`）
## 核心概念与定义
（术语用「中文（English）」的形式）
## 重点与可能的考点
## 公式 / 例题 / 推导
## 作业、截止日期、考试通知
（老师提到的任何 deadline、quiz、exam、reading 都要抓出来，一条都不能漏）
## 老师原话摘录
（3-8 条最关键的英文原句，每条下面跟一行中文翻译）
## 生词与术语对照表
（表格：English | 中文 | 说明）
## 课后行动清单
## 可能听错 / 存疑的地方

要求：具体、可复习，不要空话。宁可详细也不要遗漏知识点。`;

function chunk(text, size = 9000) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length > size) { out.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function plain(session) {
  return session.segments
    .filter(s => s.kind !== 'mark')
    .map(s => `[${mmss(s.t)}] ${s.kind === 'note' ? '（我的笔记）' : ''}${s.text}`)
    .join('\n');
}

function header(session, ctx) {
  return `课程：${ctx.course || '未填写'}\n老师：${ctx.teacher || '未填写'}\n标题：${session.title}\n日期：${new Date(session.startedAt).toLocaleString('zh-CN')}\n`;
}

export async function summarize(session, ctx = {}, onStep = () => {}) {
  const text = plain(session);
  if (!text.trim()) return '（这节课没有记录到任何内容。）';

  if (aiReady()) {
    try { return await cloudSummary(text, session, ctx, onStep); }
    catch (e) { onStep('云端概要失败（' + e.message + '），改用浏览器内置/离线摘要'); }
  }
  try {
    const b = await builtinSummary(text, onStep);
    if (b) return b;
  } catch (_) {}

  // 离线结构化分析（localnlp.js）：不用 Key、不用联网，也能抽出定义、考点、作业、术语
  try {
    onStep('正在离线分析这节课…');
    const L = await import('./localnlp.js');
    const analysis = L.analyze(session.segments);

    // 开了「本地小 AI」就让它在抽取结果之上做一次中文改写（跑在 Worker 里，卡住不影响界面）
    if (ctx.useLocalLLM) {
      try {
        onStep('本地小 AI 正在改写…（第一次要下载模型，会比较久）');
        const { LLMWorker } = await import('./llm-client.js');
        const w = new LLMWorker({ onStatus: (st) => onStep('本地 AI：' + st), onStep: (x) => onStep('本地 AI：' + (x && x.label || '')) });
        await w.load(ctx.llmModel || undefined);
        const polished = await w.polish(analysis, { ...ctx, title: session.title }, { budgetMs: 600000 });
        await w.close();
        if (polished && polished.trim()) return polished;
      } catch (e) { onStep('本地 AI 没跑成（' + e.message + '），用抽取式笔记'); }
    }

    const md = await L.buildNotes(analysis, {
      ctx: { ...ctx, title: session.title, date: new Date(session.startedAt).toLocaleString('zh-CN') },
      translateFn: async (t) => { try { return await translate(t, session.srcLang || 'en-US', session.dstLang || 'zh-Hans'); } catch (_) { return ''; } }
    });
    if (md && md.trim()) return md;
  } catch (e) { onStep('离线分析不可用（' + e.message + '），改用简易摘要'); }

  onStep('使用简易离线摘要');
  return localSummary(session, ctx);
}

async function cloudSummary(text, session, ctx, onStep) {
  const parts = chunk(text);
  const head = header(session, ctx);
  if (parts.length === 1) {
    onStep('AI 正在阅读整节课…');
    return await ask({ system: SYS, user: head + '\n转写稿：\n' + parts[0], maxTokens: 16000 });
  }
  const notes = [];
  for (let i = 0; i < parts.length; i++) {
    onStep(`AI 正在阅读第 ${i + 1}/${parts.length} 部分…`);
    notes.push(await ask({
      system: '你在给一段大学课堂转写稿做详细中文要点记录，供后续汇总使用。用中文分条列出：讲了什么、关键定义、公式、例子、老师强调的内容、任何作业与截止日期。保留时间点。不要写成总结，要保留细节。',
      user: head + '\n第 ' + (i + 1) + '/' + parts.length + ' 部分：\n' + parts[i],
      maxTokens: 8000
    }));
  }
  onStep('AI 正在汇总整节课…');
  return await ask({
    system: SYS,
    user: head + '\n下面是这节课分段整理出的要点，请汇总成完整的课堂笔记：\n\n' + notes.join('\n\n---\n\n'),
    maxTokens: 16000
  });
}

async function builtinSummary(text, onStep) {
  const S = self.Summarizer || (self.ai && self.ai.summarizer);
  if (!S) return '';
  onStep('使用 Chrome 内置摘要…');
  const mk = async (opts) => { try { return await withTimeout(S.create(opts), 60000, null); } catch (_) { return null; } };
  const opts = { type: 'key-points', format: 'markdown', length: 'long',
                 sharedContext: 'A university lecture transcript. Produce study notes.' };
  let s = await mk({ ...opts, outputLanguage: 'zh' }) || await mk(opts);
  if (!s) return '';
  const parts = chunk(text, 3500);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    onStep(`内置摘要 ${i + 1}/${parts.length}…`);
    try { const r = await withTimeout(s.summarize(parts[i]), 60000, ''); if (r) out.push(r); } catch (_) {}
  }
  try { s.destroy && s.destroy(); } catch (_) {}
  let md = out.join('\n');
  if (!md.trim()) return '';
  if (!/[一-龥]/.test(md)) {
    onStep('翻译摘要…');
    const zh = await translate(md.slice(0, 5000), 'en', 'zh-Hans');
    if (zh) md = zh + '\n\n---\n\n<原文摘要>\n' + md;
  }
  return '## 课堂要点（Chrome 内置摘要生成）\n\n' + md;
}

// ---------- 离线摘要：无网络、无 Key 也一定能出东西 ----------
const STOP = new Set(('a an the and or but if then than that this these those of in on at to for from with without by as is are was were be been being it its we you they he she i do does did not no so such can could will would should may might must have has had about into over under again more most other some any each which who whom what when where why how there here also very just like one two okay ok right so-called yeah um uh well gonna wanna lets let us').split(' '));

export function localSummary(session, ctx = {}) {
  const segs = session.segments.filter(s => s.kind !== 'mark' && s.text);
  const marks = session.segments.filter(s => s.kind === 'mark' || s.kind === 'note');
  const text = segs.map(s => s.text).join(' ');
  const sentences = [];
  for (const s of segs) {
    for (const raw of s.text.split(/(?<=[.!?。！？])\s+/)) {
      const t = raw.trim();
      if (t.split(/\s+/).length >= 5) sentences.push({ t, at: s.t, zh: s.zh || '' });
    }
  }
  // 词频
  const freq = new Map();
  for (const w of (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [])) {
    if (STOP.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  const score = s => {
    const ws = s.t.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
    let v = 0;
    for (const w of ws) if (!STOP.has(w)) v += freq.get(w) || 0;
    if (/\b(important|remember|exam|test|quiz|homework|assignment|due|deadline|key|note that|make sure|will be on)\b/i.test(s.t)) v *= 1.8;
    return v / Math.sqrt(ws.length || 1);
  };
  const best = [...sentences].sort((a, b) => score(b) - score(a)).slice(0, 14).sort((a, b) => a.at - b.at);

  const hw = sentences.filter(s => /\b(homework|assignment|due|deadline|submit|quiz|midterm|final|exam|read chapter|problem set)\b/i.test(s.t)).slice(0, 12);

  let md = `## 一句话总结\n本节课约 ${Math.round((session.durationMs || 0) / 60000)} 分钟，共记录 ${segs.length} 段发言。` +
           `高频关键词：${top.slice(0, 8).map(t => t[0]).join('、') || '—'}。\n\n`;
  md += `> ⚠️ 这是**离线摘要**（没有配置 AI 服务，或调用失败时的兜底）。在「设置」里填上 API Key 后，点这节课里的「重新生成概要」可以得到高质量的中文笔记。\n\n`;

  md += '## 本节脉络（自动抽取的关键句）\n';
  for (const s of best) md += `- \`[${mmss(s.at)}]\` ${s.t}${s.zh ? `\n  - ${s.zh}` : ''}\n`;

  if (hw.length) {
    md += '\n## 作业 / 考试 / 截止日期（关键词命中）\n';
    for (const s of hw) md += `- \`[${mmss(s.at)}]\` ${s.t}\n`;
  }
  if (marks.length) {
    md += '\n## 我在课上标记的地方\n';
    for (const m of marks) md += `- \`[${mmss(m.t)}]\` ${m.kind === 'note' ? '📝 ' : '⭐ '}${m.text}\n`;
  }
  md += '\n## 高频术语\n';
  md += top.slice(0, 20).map(([w, n]) => `- **${w}** ×${n}`).join('\n');
  md += `\n\n## 课后行动清单\n- [ ] 复习上面的关键句\n- [ ] 查清高频术语里不认识的词\n- [ ] 核对作业与截止日期\n`;
  return md;
}
