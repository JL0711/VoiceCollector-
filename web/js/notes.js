// 课堂笔记整理：把「我自己记的笔记」整理成人话，并且能和「老师讲稿」交叉合并成复习文档。
// 设计原则：有 AI 就用 AI，没有 AI（或调用失败）一律回落到本地离线版本，
// 对外导出的 4 个函数**永远不抛异常**，保证用户任何时候点下去都能拿到东西。
import { ask, aiReady } from './ai.js';
import { mmss, dateCN } from './util.js';

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

// 安全地喊一声进度（onStep 是可选的，坏了也不能影响主流程）
function step(onStep, msg) {
  try { if (typeof onStep === 'function') onStep(msg); } catch (_) {}
}

// 按行切块，尽量不把一行劈开。
// 注意：整段粘贴进来的笔记 / 长转写句常常**整篇只有一行**，
// 所以超过 size 的单行必须硬切，否则会攒出一个几十万字的请求直接把接口打爆。
function chunk(text, size = 9000) {
  const out = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur); cur = ''; };
  for (const line of String(text || '').split('\n')) {
    // 先把过长的单行硬切成若干片（尽量在空格/标点处断，断不了就直接切）
    for (const piece of hardSplit(line, size)) {
      if (cur.length + piece.length > size && cur) push();
      cur += piece + '\n';
    }
  }
  push();
  return out;
}

// 把一行超长文本切成 ≤ size 的若干片；优先在最后一个空格或句读处断开
function hardSplit(line, size) {
  if (line.length <= size) return [line];
  const out = [];
  let rest = line;
  while (rest.length > size) {
    let cut = size;
    const win = rest.slice(Math.floor(size * 0.8), size);
    const m = win.match(/[\s，。；！？、,.;!?][^\s，。；！？、,.;!?]*$/);
    if (m) cut = Math.floor(size * 0.8) + m.index + 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

// 截断超长文本，避免把上下文撑爆
function clip(text, max) {
  const t = String(text || '');
  if (t.length <= max) return t;
  return t.slice(0, max) + '\n\n…（内容过长，已截断）';
}

// 课程抬头信息，所有 prompt 都带上，AI 才知道自己在整理哪节课
function header(ctx = {}, session = null) {
  const date = ctx.date ||
    (session && session.startedAt ? dateCN(session.startedAt) : '') ||
    '未填写';
  return [
    '课程：' + (ctx.course || '未填写'),
    '老师：' + (ctx.teacher || '未填写'),
    '标题：' + (ctx.title || (session && session.title) || '未填写'),
    '日期：' + date
  ].join('\n') + '\n';
}

// 调 AI，失败/空结果都返回空字符串，由调用方决定怎么兜底
async function tryAsk(opts, onStep, what) {
  try {
    const r = await ask(opts);
    const t = String(r || '').trim();
    if (!t) { step(onStep, (what || 'AI') + '：返回了空结果'); return ''; }
    return t;
  } catch (e) {
    step(onStep, (what || 'AI') + ' 失败：' + ((e && e.message) || e));
    return '';
  }
}

// ---------------------------------------------------------------------------
// 笔记 → 纯文本
// ---------------------------------------------------------------------------

// notes 可能是字符串、字符串数组、对象数组（{text,zh,t,at,title}）或 {text}/{notes}/{md} 对象。
// 一律拍平成一段可以塞给 AI 的纯文本。
export function notesToPlain(notes) {
  if (notes == null) return '';
  if (typeof notes === 'string') return notes.trim();

  if (Array.isArray(notes)) {
    return notes
      .map(n => notesToPlain(n))
      .filter(t => t)
      .join('\n')
      .trim();
  }

  if (typeof notes === 'object') {
    // 单条笔记对象：尽量带上时间点，方便和讲稿对齐
    const body = notes.text != null ? notes.text
      : notes.content != null ? notes.content
      : notes.body != null ? notes.body
      : notes.md != null ? notes.md
      : notes.notes != null ? notesToPlain(notes.notes)
      : '';
    let t = String(body || '').trim();
    if (!t) return '';
    const at = typeof notes.t === 'number' ? notes.t
      : typeof notes.at === 'number' ? notes.at
      : null;
    if (at != null) t = '[' + mmss(at) + '] ' + t;
    if (notes.title) t = '### ' + String(notes.title).trim() + '\n' + t;
    if (notes.zh && String(notes.zh).trim() && String(notes.zh).trim() !== String(body).trim()) {
      t += '\n（译）' + String(notes.zh).trim();
    }
    return t;
  }

  return String(notes).trim();
}

// 把讲稿（老师说的话）拍平；note/mark 类型的段落不算讲稿，它们是我自己记的
function transcriptPlain(session) {
  if (!session || !Array.isArray(session.segments)) return '';
  return session.segments
    .filter(s => s && s.kind !== 'mark' && s.kind !== 'note' && s.text)
    .map(s => {
      const zh = s.zh && String(s.zh).trim() && String(s.zh).trim() !== String(s.text).trim()
        ? '\n    （译）' + String(s.zh).trim() : '';
      return '[' + mmss(s.t || 0) + '] ' + s.text + zh;
    })
    .join('\n')
    .trim();
}

// 课上随手打的标记 / 内嵌笔记，也算「我的笔记」的一部分
function inSessionNotes(session) {
  if (!session || !Array.isArray(session.segments)) return '';
  return session.segments
    .filter(s => s && (s.kind === 'note' || s.kind === 'mark') && s.text)
    .map(s => '[' + mmss(s.t || 0) + '] ' + (s.kind === 'mark' ? '⭐ ' : '') + s.text)
    .join('\n')
    .trim();
}

// 把外部传入的笔记、session 上存着的笔记、课上的内嵌笔记合成一份。
// app.js 会把「我的笔记」文本框存进 session.myNotes，调用方不传 notes 时要能自己找到它。
function allNotes(notes, session) {
  let a = notesToPlain(notes);
  const saved = session && session.myNotes ? String(session.myNotes).trim() : '';
  // 调用方常常把 session.myNotes 又原样传一遍，别重复塞两份
  if (saved && !(a && a.includes(saved))) a = a ? a + '\n' + saved : saved;

  const b = inSessionNotes(session);
  if (a && b) return a + '\n\n---（下面是我在课上随手标记的）---\n' + b;
  return a || b;
}

// ---------------------------------------------------------------------------
// 1) 只整理我自己的笔记
// ---------------------------------------------------------------------------

const SYS_NOTES = `你是一位顶尖的学习助理，正在帮一位中国留学生整理她**自己手写/手打的课堂笔记**。
这些笔记是在课上匆忙记下的：有缩写、有错别字、有半句话、有中英夹杂、顺序可能乱。
你的任务不是"总结得更短"，而是把它**还原并补全成一份能直接拿去复习的笔记**。

请输出**中文** Markdown，结构如下（没内容的小节直接省略，绝对不要编造知识点）：

## 一句话总结
## 笔记要点（按主题分组）
（把零散的条目归到几个主题下；每条都写成完整的一句话，不要保留"…"这种半截话）
## 缩写与简写还原
（Markdown 表格，必须带首尾竖线和分隔行，像这样：
 \`| 我写的 | 应该是 | 说明 |\` 换行 \`| --- | --- | --- |\` 换行 \`| eq | equation | 方程 |\`。
 比如 "eq" → equation、"∵" → 因为；只还原你有把握的）
## 核心概念与定义
（术语用「中文（English）」的形式）
## 公式 / 例题 / 步骤
## 作业、截止日期、考试通知
（笔记里出现的任何 due / deadline / exam / quiz / 作业 / 考试 / 交 都要抓出来，一条都不能漏）
## 看不懂 / 需要确认的地方
（原文照抄那几行，然后说清楚为什么看不懂：是缩写不明、是逻辑断了、还是术语拼错了；并给出你的猜测）
## 复习清单
（[ ] 待办形式，具体到"去查什么""去问谁""重做哪道题"）

硬性要求：
- 只能基于笔记里已有的信息推断，不许凭空补充课程内容。你的补全和猜测必须明确标注「（推测）」。
- 具体、可复习、不说空话。宁可啰嗦也不要漏掉知识点。`;

export async function summarizeNotes(opts) {
  const { notes, ctx = {}, onStep } = opts || {};
  const text = notesToPlain(notes);
  if (!text.trim()) return '（还没有笔记内容。在「我的笔记」里写点东西，再回来点整理。）';

  if (aiReady()) {
    const md = await cloudNotes(text, ctx, onStep);
    if (md) return md;
    step(onStep, '云端整理没成功，改用离线整理');
  } else {
    step(onStep, '没有配置 AI，使用离线整理');
  }
  return localNotesSummary({ notes: text });
}

async function cloudNotes(text, ctx, onStep) {
  const head = header(ctx);
  const parts = chunk(text, 9000);

  if (parts.length === 1) {
    step(onStep, 'AI 正在整理我的笔记…');
    return await tryAsk({
      system: SYS_NOTES,
      user: head + '\n下面是我的课堂笔记原文：\n\n' + parts[0],
      maxTokens: 16000
    }, onStep, '整理笔记');
  }

  // 笔记很长：先分块抽要点，再汇总（map-reduce）
  const digests = [];
  for (let i = 0; i < parts.length; i++) {
    step(onStep, `AI 正在读我的笔记 ${i + 1}/${parts.length}…`);
    const d = await tryAsk({
      system: '你在逐段阅读一位中国留学生匆忙记下的课堂笔记，为后续汇总做准备。' +
              '用中文分条列出：这一段记了什么、涉及哪些概念与定义、公式与例题、出现的缩写及其可能含义、' +
              '任何作业与截止日期、以及看不懂的原句。保留原有的时间点。不要总结，要保留细节。',
      user: head + '\n第 ' + (i + 1) + '/' + parts.length + ' 段笔记：\n\n' + parts[i],
      maxTokens: 8000
    }, onStep, '分段整理');
    if (d) digests.push(d);
  }
  if (!digests.length) return '';

  step(onStep, 'AI 正在汇总整份笔记…');
  return await tryAsk({
    system: SYS_NOTES,
    user: head + '\n下面是我这份笔记分段整理出的要点，请汇总成完整的一份笔记整理：\n\n' +
          clip(digests.join('\n\n---\n\n'), 60000),
    maxTokens: 16000
  }, onStep, '汇总笔记');
}

// ---------------------------------------------------------------------------
// 2) 核心：讲稿 + 我的笔记 → 复习文档
// ---------------------------------------------------------------------------

const SYS_MERGE = `你是一位顶尖的学习助理。手上有同一节大学课的两份材料：
（A）课堂录音的自动转写稿——老师实际讲的话，可能有识别错误、口语和重复；
（B）这位中国留学生自己在课上记的笔记——匆忙、有缩写、可能记错或记漏。

你的任务是把两者**交叉核对并合并**成一份真正能拿去复习的中文文档，重点是让她知道：
哪些她记对了、哪些老师强调过但她漏了、哪些她记了但老师根本没讲（很可能是听错或她自己的理解）。

请输出**中文** Markdown，结构如下（没内容的小节省略，不要编造）：

## 本节主题
（两三句话说清这节课到底在讲什么）

## 知识点逐条
（这是全文最重要的部分。每个知识点一条，条目开头用【】标注来源，四选一：
 【老师讲了 · 我记了】两边都有，说明我记对了——把两边合并成一条完整准确的表述；
 【只有老师讲了 — 我漏了】老师讲过（尤其是强调过、重复过、写在板书上的）但我笔记里没有；
 【只有我记了 — 需确认】我笔记里有但转写稿里找不到——注明可能是听错、可能是转写漏了、还是我自己的理解；
 【对不上 — 有冲突】我记的和老师讲的不一致——把两种说法都写出来，指出差在哪，并说明以哪个为准。
 每条都要写清楚内容本身，不能只写标签。涉及老师原话时，附上时间点如 \`[12:30]\`。）

## 公式与例题
（老师推导过的、我笔记里抄下来的，都整理进来；标明哪些我抄错了或抄漏了步骤）

## 作业与 deadline
（转写稿和笔记里出现的任何 homework / assignment / due / deadline / quiz / exam / reading / 作业 / 考试 / 交，
 一条都不能漏，注明出处是老师说的还是我记的）

## 我的疑问
（我笔记里写着看不懂的、打了问号的地方；能从转写稿里找到答案的，直接回答；找不到的，写清楚该去问老师什么）

## 复习清单
（[ ] 待办形式，按优先级排；漏记的内容优先级最高）

硬性要求：
- 判断"我漏了"要有依据：老师讲到但笔记里确实没有对应内容才算。
- 术语用「中文（English）」的形式。
- 具体、可复习、不说空话。宁可详细也不要漏掉知识点。`;

export async function mergeStudyDoc(opts) {
  const { session, notes, ctx = {}, onStep } = opts || {};
  const myNotes = allNotes(notes, session);
  const script = transcriptPlain(session);

  if (!myNotes.trim() && !script.trim()) {
    return '（这节课既没有讲稿也没有笔记，没有可以合并的内容。）';
  }
  // 只有一边有内容时，退化成对那一边的整理
  if (!script.trim()) {
    step(onStep, '这节课没有讲稿，只整理我的笔记');
    return await summarizeNotes({ notes: myNotes, ctx, onStep });
  }
  if (!myNotes.trim()) {
    step(onStep, '这节课没有我的笔记，只能给出讲稿一侧的内容');
    if (aiReady()) {
      const md = await cloudMerge(script, '（这节课我没有记笔记。）', session, ctx, onStep);
      if (md) return md;
    }
    return localMerge(script, '', session, ctx);
  }

  if (aiReady()) {
    const md = await cloudMerge(script, myNotes, session, ctx, onStep);
    if (md) return md;
    step(onStep, '云端合并没成功，改用离线对照');
  } else {
    step(onStep, '没有配置 AI，使用离线对照');
  }
  return localMerge(script, myNotes, session, ctx);
}

async function cloudMerge(script, myNotes, session, ctx, onStep) {
  const head = header(ctx, session);
  const notesPart = clip(myNotes, 30000);
  const parts = chunk(script, 9000);

  if (parts.length === 1) {
    step(onStep, 'AI 正在对照讲稿和我的笔记…');
    return await tryAsk({
      system: SYS_MERGE,
      user: head +
        '\n===== A. 老师讲稿（自动转写） =====\n' + parts[0] +
        '\n\n===== B. 我的笔记 =====\n' + notesPart,
      maxTokens: 16000
    }, onStep, '合并复习文档');
  }

  // 讲稿很长：先把讲稿分块压成详细要点，再拿要点去和笔记对照
  const digests = [];
  for (let i = 0; i < parts.length; i++) {
    step(onStep, `AI 正在读讲稿 ${i + 1}/${parts.length}…`);
    const d = await tryAsk({
      system: '你在逐段阅读大学课堂的自动转写稿，为后续"和学生自己的笔记做交叉核对"做准备。' +
              '用中文分条列出：老师讲了什么、关键定义、公式与推导、举的例子、明确强调或重复的内容、' +
              '任何作业与截止日期。每条都带上时间点。不要总结，要保留细节和老师的强调语气。',
      user: head + '\n第 ' + (i + 1) + '/' + parts.length + ' 段讲稿：\n\n' + parts[i],
      maxTokens: 8000
    }, onStep, '分段读讲稿');
    if (d) digests.push(d);
  }
  if (!digests.length) return '';

  step(onStep, 'AI 正在对照讲稿和我的笔记…');
  return await tryAsk({
    system: SYS_MERGE,
    user: head +
      '\n===== A. 老师讲稿（已分段整理成详细要点，按时间顺序） =====\n' +
      clip(digests.join('\n\n---\n\n'), 60000) +
      '\n\n===== B. 我的笔记 =====\n' + notesPart,
    maxTokens: 16000
  }, onStep, '合并复习文档');
}

// ---------------------------------------------------------------------------
// 3) 跨多节课的总复习提纲
// ---------------------------------------------------------------------------

const SYS_REVIEW = `你是一位顶尖的学习助理，正在帮一位中国留学生做**期中/期末总复习提纲**。
输入是同一门课好几节课的内容摘要（按时间先后排列）。

请输出**中文** Markdown，结构如下（没内容的小节省略，不要编造）：

## 这门课在讲什么
（三五句话说清整门课的主线）

## 知识地图
（分主题的层级提纲，用嵌套列表；每个主题下面注明它来自第几节课，如 \`（第 2、5 节）\`）

## 高频重点 = 高概率考点
（跨课反复出现、老师反复强调的内容。每条注明"在第 X、Y 节都出现过"，出现次数越多排越前面。
 老师明确说过"会考""重点""记住"的，单独标上 ⭐）

## 前后关联
（哪节课的概念是哪节课的基础、哪些概念容易混淆、哪些是同一个东西的不同说法）

## 公式与方法汇总
（整门课用得上的公式和解题套路，集中列出来）

## 作业与考试节点
（所有 deadline、quiz、exam，按时间排）

## 还没搞懂的地方
（各节课里标记为存疑、漏记、需确认的内容，汇总在一起）

## 自测题
（12-20 道题，覆盖上面的高频重点。先列题目，最后统一给「参考答案」小节。
 题目要能真正检验理解，不要问"XX 是什么意思"这种背定义的问题）

硬性要求：具体、可复习、不说空话。只能基于输入的内容，不许自行扩充这门课没讲过的东西。`;

export async function reviewAcross(opts) {
  const { sessions, ctx = {}, onStep } = opts || {};
  const list = (Array.isArray(sessions) ? sessions : [sessions]).filter(Boolean);
  if (!list.length) return '（没有选中任何课程记录。）';

  // 每节课先取一份"数字摘要"：优先用已有的 summary，没有就用讲稿+笔记
  const items = list.map((s, i) => ({
    idx: i + 1,
    title: (s && s.title) || ('第 ' + (i + 1) + ' 节'),
    date: s && s.startedAt ? dateCN(s.startedAt) : '',
    body: sessionDigestSource(s)
  })).filter(it => it.body.trim());

  if (!items.length) return '（选中的课程记录里没有任何内容。）';

  if (!aiReady()) {
    step(onStep, '没有配置 AI，使用离线总复习提纲');
    return localReview(items, ctx);
  }

  const md = await cloudReview(items, ctx, onStep);
  if (md) return md;
  step(onStep, '云端总复习没成功，改用离线提纲');
  return localReview(items, ctx);
}

// 一节课拿来做跨课复习的原料：讲稿侧优先用已有的概要（省调用、省电），
// **我自己记的笔记永远要带上**——总复习最该复习的就是我记下来的那些。
function sessionDigestSource(s) {
  if (!s) return '';
  let out = '';
  if (s.summary && String(s.summary).trim()) {
    out = String(s.summary).trim();
  } else {
    out = transcriptPlain(s);
  }
  const mine = allNotes(null, s);
  if (mine) out += (out ? '\n\n【我的课堂笔记】\n' : '【我的课堂笔记】\n') + mine;
  return out;
}

async function cloudReview(items, ctx, onStep) {
  const head = header(ctx);

  // map：每节课压成一份紧凑的要点（已有 summary 的短课可以直接用，省一次调用和电）
  const digests = [];
  for (const it of items) {
    const label = `第 ${it.idx} 节《${it.title}》${it.date ? '（' + it.date + '）' : ''}`;
    if (it.body.length <= 2500) {
      digests.push('【' + label + '】\n' + it.body);
      continue;
    }
    step(onStep, `AI 正在浓缩 ${label}…`);
    const parts = chunk(it.body, 9000);
    const sub = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts.length > 1) step(onStep, `AI 正在浓缩 ${label} ${i + 1}/${parts.length}…`);
      const d = await tryAsk({
        system: '你在为"跨多节课的总复习提纲"准备素材。把这节课的内容压缩成中文要点：' +
                '核心主题、概念与定义、公式与方法、老师明确强调或说会考的内容、例题、作业与考试节点、' +
                '以及学生标记为没搞懂的地方。分条写，保留具体内容，不要写成空泛的总结。',
        user: head + '\n' + label + (parts.length > 1 ? `（第 ${i + 1}/${parts.length} 部分）` : '') +
              '：\n\n' + parts[i],
        maxTokens: 4000
      }, onStep, '浓缩单节课');
      if (d) sub.push(d);
    }
    if (sub.length) digests.push('【' + label + '】\n' + sub.join('\n'));
    else digests.push('【' + label + '】\n' + clip(it.body, 2500));
  }
  if (!digests.length) return '';

  // reduce：要点还是太长就先两两合并，再出最终提纲
  let pool = digests;
  let round = 0;
  while (pool.join('\n\n').length > 40000 && pool.length > 1 && round < 3) {
    round++;
    const groups = chunk(pool.join('\n\n===\n\n'), 30000);
    const merged = [];
    for (let i = 0; i < groups.length; i++) {
      step(onStep, `AI 正在合并素材 ${i + 1}/${groups.length}（第 ${round} 轮）…`);
      const d = await tryAsk({
        system: '把下面几节课的要点合并成一份更紧凑的中文要点，' +
                '保留所有概念、公式、强调过的重点、作业考试节点，并保留"来自第几节课"的标注。不要丢信息。',
        user: groups[i],
        maxTokens: 8000
      }, onStep, '合并素材');
      merged.push(d || clip(groups[i], 20000));
    }
    pool = merged;
  }

  step(onStep, 'AI 正在生成总复习提纲…');
  return await tryAsk({
    system: SYS_REVIEW,
    user: head + `\n一共 ${items.length} 节课，按时间先后排列如下：\n\n` +
          clip(pool.join('\n\n===\n\n'), 60000),
    maxTokens: 16000
  }, onStep, '生成总复习提纲');
}

// ---------------------------------------------------------------------------
// 4) 离线兜底：没有 AI 也一定能出东西
// ---------------------------------------------------------------------------

const STOP = new Set(('a an the and or but if then than that this these those of in on at to for from with without by as is are was were be been being it its we you they he she i do does did not no so such can could will would should may might must have has had about into over under again more most other some any each which who whom what when where why how there here also very very just like one two okay ok right yeah um uh well gonna wanna lets let us my me our your their them his her'
).split(' '));

// 作业 / 考试 / 截止日期 关键词（中英都要抓）
// 注意：单字 `考` `交` 和裸的 \btest\b \bfinal\b \bpaper\b 误报太凶
// （"交流""交换律""外交""final answer""test case" 全会命中），所以一律要求上下文。
const DUE_RE = new RegExp([
  '\\bdue\\b', '\\bdeadline\\b', '\\bhomework\\b', '\\bhw\\s?\\d', '\\bassignment\\b',
  '\\bsubmit\\b', '\\bhand (it|them|this) in\\b', '\\bturn (it|them|this) in\\b',
  '\\bquiz\\b', '\\bmidterm\\b', '\\bexam\\b', '\\bfinal (exam|test|paper|project)\\b',
  '\\bproblem set\\b', '\\bpset\\b', '\\bread(ing)? chapter\\b', '\\bpresentation\\b', '\\bessay\\b',
  '考试', '测验', '小测', '会考', '要考', '必考', '考点', '期中', '期末',
  '作业', '截止', '提交', '上交', '论文', '实验报告', '课程报告',
  '[周日号天前点末一二三四五六七八九十0-9]\\s*之?前?\\s*交',   // 下周五交 / 明天交 / 周五之前交
  '交\\s*(作业|论文|报告|上去|上来|给老师)'
].join('|'), 'i');
// 存疑 / 没听懂 关键词
const DOUBT_RE = /(\?\?|？？|\bTODO\b|\bTBD\b|\bnot sure\b|不确定|没听清|没听懂|不懂|存疑|待确认|问老师|回头查|\?$|？$)/i;
// 重点 关键词
const KEY_RE = /(\bimportant\b|\bremember\b|\bkey\b|\bnote that\b|\bmake sure\b|\bwill be on\b|重点|重要|记住|划重点|必考|会考|强调)/i;

export function localNotesSummary(opts) {
  const { notes, session } = opts || {};
  const text = allNotes(notes, session);
  if (!text.trim()) return '（还没有笔记内容。）';

  const lines = text.split('\n').map(l => l.replace(/\s+$/, ''));
  const heads = [];   // markdown 标题
  const bullets = []; // 列表项
  const todos = [];   // [ ] 待办
  const codes = [];   // 公式 / 代码行
  const plains = [];  // 普通句子
  const dues = [];
  const doubts = [];
  const keys = [];

  let inFence = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;

    if (/^```/.test(l)) { inFence = !inFence; continue; }
    if (inFence) { codes.push(l); continue; }

    let m;
    if ((m = l.match(/^(#{1,6})\s+(.+)$/))) { heads.push({ lv: m[1].length, t: m[2].trim() }); continue; }
    if ((m = l.match(/^\s*[-*•]\s*\[( |x|X)\]\s*(.+)$/))) { todos.push({ done: m[1] !== ' ', t: m[2].trim() }); collect(m[2]); continue; }
    if ((m = l.match(/^\s*[-*•]\s+(.+)$/))) { bullets.push(m[1].trim()); collect(m[1]); continue; }
    if ((m = l.match(/^\s*\d+[.)]\s+(.+)$/))) { bullets.push(m[1].trim()); collect(m[1]); continue; }
    if (/^\s*(\$\$|\\\[)/.test(l) || /[=≈≤≥∑∫√±→]/.test(l)) { codes.push(l); collect(l); continue; }
    plains.push(l);
    collect(l);
  }

  function collect(s) {
    const t = String(s).trim();
    if (!t) return;
    if (DUE_RE.test(t)) dues.push(t);
    if (DOUBT_RE.test(t)) doubts.push(t);
    if (KEY_RE.test(t)) keys.push(t);
  }

  // 术语统计：英文词频 + Markdown 里 **加粗** / `代码` / 「引号」里的词
  const freq = new Map();
  for (const w of (text.toLowerCase().match(/[a-z][a-z'’-]{2,}/g) || [])) {
    if (STOP.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const marked = new Map();
  const bump = t => {
    const k = String(t).trim();
    if (k && k.length <= 40) marked.set(k, (marked.get(k) || 0) + 1);
  };
  for (const m of text.matchAll(/\*\*([^*\n]{1,40})\*\*/g)) bump(m[1]);
  for (const m of text.matchAll(/`([^`\n]{1,40})`/g)) bump(m[1]);
  for (const m of text.matchAll(/[「『]([^」』\n]{1,40})[」』]/g)) bump(m[1]);

  const topWords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const topMarked = [...marked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  const uniq = arr => [...new Set(arr)];
  const nChars = text.replace(/\s/g, '').length;

  let md = '## 一句话总结\n';
  md += `这份笔记约 ${nChars} 字，共 ${lines.filter(l => l.trim()).length} 行`;
  if (heads.length) md += `，有 ${heads.length} 个小标题`;
  if (bullets.length) md += `，${bullets.length} 条要点`;
  md += '。';
  if (topMarked.length) md += `重点标记的术语：${topMarked.slice(0, 6).map(t => t[0]).join('、')}。`;
  else if (topWords.length) md += `高频词：${topWords.slice(0, 6).map(t => t[0]).join('、')}。`;
  md += '\n\n';

  md += '> ⚠️ 这是**离线整理**（没有配置 AI 服务，或调用失败时的兜底）。' +
        '在「设置」里填上 API Key 之后，重新点一次「整理笔记」就能拿到真正读懂内容的中文整理。\n\n';

  if (heads.length) {
    md += '## 笔记结构\n';
    for (const h of heads) md += '  '.repeat(Math.max(0, h.lv - 1)) + '- ' + h.t + '\n';
    md += '\n';
  }

  if (bullets.length) {
    md += '## 要点（原文抽取）\n';
    for (const b of uniq(bullets).slice(0, 60)) md += '- ' + b + '\n';
    md += '\n';
  }

  if (!heads.length && !bullets.length && plains.length) {
    md += '## 笔记原文（按行）\n';
    for (const p of plains.slice(0, 60)) md += '- ' + p + '\n';
    md += '\n';
  }

  if (codes.length) {
    md += '## 公式 / 符号行\n';
    for (const c of uniq(codes).slice(0, 30)) md += '- `' + c + '`\n';
    md += '\n';
  }

  if (keys.length) {
    md += '## 我标成重点的地方（关键词命中）\n';
    for (const k of uniq(keys).slice(0, 30)) md += '- ' + k + '\n';
    md += '\n';
  }

  if (dues.length) {
    md += '## 作业 / 考试 / 截止日期（关键词命中）\n';
    for (const d of uniq(dues).slice(0, 30)) md += '- ' + d + '\n';
    md += '\n';
  }

  if (doubts.length) {
    md += '## 没搞懂 / 需要确认（关键词命中）\n';
    for (const d of uniq(doubts).slice(0, 30)) md += '- ' + d + '\n';
    md += '\n';
  }

  if (topMarked.length || topWords.length) {
    md += '## 术语统计\n';
    if (topMarked.length) {
      md += '被我特别标出来的：\n';
      for (const [w, n] of topMarked) md += `- **${w}**${n > 1 ? ' ×' + n : ''}\n`;
    }
    if (topWords.length) {
      md += (topMarked.length ? '\n高频英文词：\n' : '');
      md += topWords.map(([w, n]) => `- ${w} ×${n}`).join('\n') + '\n';
    }
    md += '\n';
  }

  md += '## 复习清单\n';
  if (todos.length) for (const t of todos) md += `- [${t.done ? 'x' : ' '}] ${t.t}\n`;
  if (dues.length) md += '- [ ] 核对上面抓出来的作业与截止日期\n';
  if (doubts.length) md += '- [ ] 把「没搞懂」那几条去问老师或查资料\n';
  md += '- [ ] 查清术语统计里不认识的词\n';
  md += '- [ ] 对照录音讲稿，补全笔记里漏掉的内容\n';
  return md;
}

// 离线版的「讲稿 vs 我的笔记」对照：靠关键词重合度做粗略比对
function localMerge(script, myNotes, session, ctx) {
  const lines = script.split('\n').filter(l => l.trim());
  const noteText = String(myNotes || '');

  // 我的笔记里出现过的实词集合，用来判断"老师讲了但我好像没记"
  const noteWords = new Set();
  for (const w of (noteText.toLowerCase().match(/[a-z][a-z'’-]{2,}/g) || [])) {
    if (!STOP.has(w)) noteWords.add(w);
  }
  for (const c of (noteText.match(/[一-龥]{2,}/g) || [])) noteWords.add(c);

  // 讲稿里老师强调过 / 提到作业考试的句子
  const keyLines = [];
  const dueLines = [];
  for (const l of lines) {
    if (DUE_RE.test(l)) dueLines.push(l);
    else if (KEY_RE.test(l)) keyLines.push(l);
  }

  // 粗略判断：强调句里的实词在我的笔记里一个都没出现 → 大概率漏记了
  const covered = l => {
    const ws = [
      ...((l.toLowerCase().match(/[a-z][a-z'’-]{2,}/g) || []).filter(w => !STOP.has(w))),
      ...((l.match(/[一-龥]{2,}/g) || []))
    ];
    if (!ws.length) return true;
    let hit = 0;
    for (const w of ws) if (noteWords.has(w)) hit++;
    return hit / ws.length >= 0.25;
  };

  const missed = keyLines.filter(l => !covered(l)).slice(0, 25);
  const matched = keyLines.filter(l => covered(l)).slice(0, 25);

  const dur = session && session.durationMs ? Math.round(session.durationMs / 60000) : 0;

  let md = '# 复习文档（离线对照）\n\n';
  md += header(ctx, session).split('\n').filter(Boolean).map(l => '- ' + l).join('\n') + '\n\n';
  md += '## 本节主题\n';
  md += `本节约 ${dur} 分钟，讲稿 ${lines.length} 行`;
  md += noteText.trim() ? `，我的笔记 ${noteText.replace(/\s/g, '').length} 字。\n\n` : '，我这节课没有记笔记。\n\n';
  md += '> ⚠️ 这是**离线对照**（没有配置 AI 服务，或调用失败时的兜底）。' +
        '离线版只能靠关键词做粗略比对，判断不一定准。' +
        '在「设置」里填上 API Key 之后重新生成，才能得到真正逐条交叉核对的复习文档。\n\n';

  if (matched.length) {
    md += '## 知识点逐条 ·【老师讲了 · 我记了】（关键词重合）\n';
    for (const l of matched) md += '- ' + l + '\n';
    md += '\n';
  }
  if (missed.length) {
    md += '## 知识点逐条 ·【只有老师讲了 — 我可能漏了】（老师强调过，但我的笔记里找不到对应词）\n';
    for (const l of missed) md += '- ' + l + '\n';
    md += '\n';
  }
  if (dueLines.length) {
    md += '## 作业与 deadline（老师讲稿里的关键词命中）\n';
    for (const l of [...new Set(dueLines)].slice(0, 30)) md += '- ' + l + '\n';
    md += '\n';
  }

  if (noteText.trim()) {
    md += '---\n\n# 我的笔记（离线整理）\n\n';
    md += localNotesSummary({ notes: noteText });
    md += '\n';
  }

  md += '\n## 复习清单\n';
  if (missed.length) md += '- [ ] 重点看上面「我可能漏了」那几条，补进笔记\n';
  if (dueLines.length) md += '- [ ] 把作业和 deadline 记到日历里\n';
  md += '- [ ] 配置 AI 后重新生成，拿到逐条交叉核对的版本\n';
  return md;
}

// 离线版跨课复习提纲：靠词频找"反复出现 = 可能考点"
function localReview(items, ctx) {
  // 统计每个词出现在多少节课里
  const inSessions = new Map();
  const perSessionTop = [];
  for (const it of items) {
    const freq = new Map();
    for (const w of (it.body.toLowerCase().match(/[a-z][a-z'’-]{2,}/g) || [])) {
      if (STOP.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
    for (const c of (it.body.match(/[一-龥]{2,6}/g) || [])) {
      freq.set(c, (freq.get(c) || 0) + 1);
    }
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    perSessionTop.push({ it, top });
    for (const [w] of top) {
      if (!inSessions.has(w)) inSessions.set(w, []);
      inSessions.get(w).push(it.idx);
    }
  }
  const repeated = [...inSessions.entries()]
    .filter(([, arr]) => arr.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 30);

  const dues = [];
  const doubts = [];
  for (const it of items) {
    for (const l of it.body.split('\n')) {
      const t = l.trim();
      if (!t) continue;
      if (DUE_RE.test(t)) dues.push(`（第 ${it.idx} 节）` + t);
      if (DOUBT_RE.test(t)) doubts.push(`（第 ${it.idx} 节）` + t);
    }
  }

  let md = '# 总复习提纲（离线版）\n\n';
  md += header(ctx).split('\n').filter(Boolean).map(l => '- ' + l).join('\n') + '\n\n';
  md += '> ⚠️ 这是**离线提纲**（没有配置 AI 服务，或调用失败时的兜底）。' +
        '离线版只能做词频统计，出不了真正的知识地图和自测题。' +
        '在「设置」里填上 API Key 之后重新生成。\n\n';

  md += `## 这门课在讲什么\n一共 ${items.length} 节课：\n`;
  for (const it of items) md += `- 第 ${it.idx} 节《${it.title}》${it.date ? '（' + it.date + '）' : ''}\n`;
  md += '\n';

  md += '## 知识地图（各节课的高频词）\n';
  for (const { it, top } of perSessionTop) {
    md += `- **第 ${it.idx} 节《${it.title}》**\n`;
    for (const [w, n] of top.slice(0, 8)) md += `  - ${w} ×${n}\n`;
  }
  md += '\n';

  if (repeated.length) {
    md += '## 高频重点 = 高概率考点（跨课重复出现）\n';
    for (const [w, arr] of repeated) {
      md += `- **${w}** —— 在第 ${[...new Set(arr)].join('、')} 节都出现过（${arr.length} 节）\n`;
    }
    md += '\n';
  }

  if (dues.length) {
    md += '## 作业与考试节点（关键词命中）\n';
    for (const d of [...new Set(dues)].slice(0, 40)) md += '- ' + d + '\n';
    md += '\n';
  }
  if (doubts.length) {
    md += '## 还没搞懂的地方（关键词命中）\n';
    for (const d of [...new Set(doubts)].slice(0, 40)) md += '- ' + d + '\n';
    md += '\n';
  }

  md += '## 复习清单\n';
  md += '- [ ] 按上面「高频重点」的顺序逐条复习，出现次数多的先看\n';
  if (dues.length) md += '- [ ] 核对所有 deadline 和考试时间\n';
  if (doubts.length) md += '- [ ] 把「还没搞懂」那几条集中问一次老师\n';
  md += '- [ ] 配置 AI 后重新生成，拿到知识地图和自测题\n';
  return md;
}
