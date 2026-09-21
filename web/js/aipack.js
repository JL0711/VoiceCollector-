// aipack.js —— 把一节课打包成可以直接粘贴进任何 AI 聊天框的「学习包」
//
// 为什么需要它：
//   这个软件里内置不了 Claude（调用它必须有 API Key）。但你可以把课堂内容
//   整理成一份结构良好的提示词，粘进 ChatGPT / Claude.ai / Kimi / DeepSeek 的
//   免费网页版，让它们当你的助教。这个文件负责把内容组织好、切成能塞进
//   聊天框的段落、并写好「该怎么教我」的指令。
//
// 核心思路：素材必须是真的（来自转写稿和你自己的笔记），指令负责规定 AI 怎么用这些素材。

import { mmss, dateCN } from './util.js';

// 各家免费网页版单条消息的安全长度（保守估计，单位：字符）
export const TARGETS = {
  claude:   { label: 'Claude（claude.ai）', chunk: 30000, note: '上下文最大，能一次吃下整节课' },
  chatgpt:  { label: 'ChatGPT',            chunk: 12000, note: '分 2-3 段贴通常没问题' },
  kimi:     { label: 'Kimi',               chunk: 20000, note: '长文本友好' },
  deepseek: { label: 'DeepSeek',           chunk: 12000, note: '免费且够用' },
  tongyi:   { label: '通义千问',            chunk: 12000, note: '中文课程友好' },
  generic:  { label: '其他 / 不确定',       chunk: 8000,  note: '最保守，分段最多' }
};

export const MODES = {
  review:  { label: '📘 帮我复习这节课', desc: '整理成复习笔记，讲清楚每个知识点' },
  quiz:    { label: '📝 给我出题',       desc: '根据这节课出练习题并批改' },
  explain: { label: '🔍 逐点给我讲懂',   desc: '把我没听懂的地方一个个讲明白' },
  exam:    { label: '🎯 帮我押考点',     desc: '分析老师的暗示，预测考什么' },
  polish:  { label: '🌏 翻译 + 润色',    desc: '把讲稿翻成通顺中文并补全漏掉的地方' }
};

const HEAD = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

function instructions(mode, ctx, hasNotes, parts) {
  const who = `你现在是我的大学课程助教。我是一名在国外读书的中国学生，母语中文，上课用英语。`;
  const mat = `我会把一节课的**录音转写稿**${hasNotes ? '和**我自己记的笔记**' : ''}贴给你。` +
    (parts > 1 ? `内容比较长，我会分 ${parts} 段发给你。**收到第 1 到 ${parts - 1} 段时，你只回复「收到第 N 段」四个字，不要做任何分析**，等我发完最后一段再开始。` : '');

  const rules = `
重要规则（请严格遵守）：
1. 转写稿是语音识别自动生成的，**会有听错的词**。遇到明显不通顺的地方，请按上下文推断老师真正想说的是什么，并在括号里标注「（原文识别为 xxx，我推测是 yyy）」。
2. **不要编造老师没讲过的内容**。如果某个知识点老师只是带过、讲得不完整，就直说「老师这里只提了一句，建议查教材」，不要自己补一套。
3. 所有输出用**简体中文**。专业术语用「中文（English）」的格式，因为我考试时看到的是英文。
4. 涉及公式时用清晰的排版写出来，并解释每个符号的含义。
5. 老师提到的任何**作业、截止日期、考试范围、quiz**，一条都不能漏。`;

  const task = {
    review: `
你的任务：帮我把这节课整理成一份**真正能拿来复习的中文笔记**，结构如下：
- 一句话总结这节课在讲什么
- 本节脉络（按时间顺序的提纲）
- 核心概念与定义（每个概念先给定义，再用一个生活化的例子帮我理解）
- 重点与可能的考点（说明你为什么认为它是考点）
- 公式 / 例题 / 推导（把老师的例题完整重做一遍）
- 作业、截止日期、考试通知
- 生词与术语对照表
- 这节课和前面内容的关联
- 我需要额外补的背景知识（老师默认我们已经会的东西）`,
    quiz: `
你的任务：基于这节课的内容给我出题，帮我检验有没有真的学懂。
- 先出 5 道概念题（问定义、问区别、问为什么）
- 再出 3 道计算/应用题，难度接近老师课上举的例子
- 最后出 1 道综合题，需要串联本节多个知识点
- **先只给题目，不要给答案。** 等我做完发给你，你再逐题批改，指出我错在哪、对应课上哪一段。`,
    explain: `
你的任务：把这节课**逐个知识点讲到我真的懂**。
- 先列出这节课一共有哪几个知识点（编号）
- 然后从第 1 个开始，用「是什么 → 为什么需要它 → 怎么用 → 常见误区」四步讲
- **每讲完一个就停下来问我「懂了吗，还是需要换个说法？」**，等我回复再讲下一个
- 如果我说不懂，换一个完全不同的角度重讲，不要把原话再说一遍`,
    exam: `
你的任务：像一个押题老师一样，分析这节课**会考什么**。
- 找出老师所有的「暗示信号」：说了 remember / important / this will be on the exam / write this down / I like to ask 之类的地方，原句引用出来
- 老师花了多少时间在每个知识点上（时间戳能反映权重）
- 根据这些，列出**高/中/低**三档考点预测，并说明判断依据
- 针对高档考点，各出一道最可能的考题
- 最后给一份「如果只剩 2 小时复习，按这个顺序看」的清单`,
    polish: `
你的任务：把这份英文转写稿整理成**中英对照的完整讲稿**。
- 按意群分段，每段先英文（修正识别错误后的版本），再中文翻译
- 翻译要通顺自然，不要直译腔；专业术语保留英文并加中文
- 老师的口头禅、重复、"um/uh" 之类的可以删掉
- 在每段前保留时间戳，方便我对照录音`
  }[mode] || '';

  return `${who}\n${mat}\n${rules}\n${task}\n\n课程信息：\n- 学科：${ctx.course || '未填写'}\n- 老师：${ctx.teacher || '未填写'}\n- 本节标题：${ctx.title || ''}\n- 时间：${ctx.date || ''}\n`;
}

function transcriptText(session, { withZh = false, maxChars = Infinity } = {}) {
  const out = [];
  let n = 0;
  for (const g of session.segments || []) {
    if (g.kind === 'mark') continue;
    const line = g.kind === 'note'
      ? `[${mmss(g.t)}] （我的笔记）${g.text}`
      : `[${mmss(g.t)}] ${g.text}${withZh && g.zh ? `\n         → ${g.zh}` : ''}`;
    n += line.length;
    if (n > maxChars) { out.push('……（后面还有，见下一段）'); break; }
    out.push(line);
  }
  return out.join('\n');
}

// 按字符数切段，尽量在空行/句子边界切
function splitText(text, size) {
  if (text.length <= size) return [text];
  const parts = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > i + size * 0.6) end = nl;
    }
    parts.push(text.slice(i, end));
    i = end;
  }
  return parts;
}

/**
 * 打包一节课
 * @returns {{title, parts: [{label, text}], chars, target, mode}}
 */
export function buildPack(session, ctx = {}, { mode = 'review', target = 'claude', withZh = false, includeNotes = true, includeSummary = true } = {}) {
  const T = TARGETS[target] || TARGETS.generic;
  const notes = includeNotes ? (session.myNotes || '').trim() : '';
  const body = [];

  if (includeSummary && session.summary) {
    body.push(`${HEAD}\n【软件自动生成的概要（仅供参考，可能有误）】\n${HEAD}\n${session.summary}`);
  }
  if (notes) {
    body.push(`${HEAD}\n【我自己在课上记的笔记】\n${HEAD}\n${notes}`);
  }
  body.push(`${HEAD}\n【课堂录音转写稿（老师说的每一句，带时间戳）】\n${HEAD}\n${transcriptText(session, { withZh })}`);

  const content = body.join('\n\n');
  const head = instructions(mode, { ...ctx, title: session.title, date: dateCN(session.startedAt) }, !!notes, 1);

  // 先按「指令 + 内容」整体估长度，决定要不要分段
  const budget = Math.max(2000, T.chunk - head.length - 400);
  const chunks = splitText(content, budget);

  if (chunks.length === 1) {
    return {
      title: session.title, mode, target, chars: head.length + content.length,
      parts: [{ label: '全部内容（一次贴完）', text: head + '\n' + content + '\n\n' + HEAD + '\n以上就是全部内容，请开始。' }]
    };
  }

  const realHead = instructions(mode, { ...ctx, title: session.title, date: dateCN(session.startedAt) }, !!notes, chunks.length);
  const parts = chunks.map((c, i) => ({
    label: `第 ${i + 1} / ${chunks.length} 段`,
    text: (i === 0 ? realHead + '\n' : `（接上文，第 ${i + 1} / ${chunks.length} 段）\n\n`) + c +
      (i === chunks.length - 1
        ? `\n\n${HEAD}\n以上就是全部内容，请按最开始说的要求开始。`
        : `\n\n${HEAD}\n（还没发完，请只回复「收到第 ${i + 1} 段」）`)
  }));
  return { title: session.title, mode, target, chars: realHead.length + content.length, parts };
}

/** 打包多节课（总复习用）：只带概要和要点，不带完整讲稿，否则一定超长 */
export function buildReviewPack(sessions, ctx = {}, { target = 'claude', mode = 'exam' } = {}) {
  const T = TARGETS[target] || TARGETS.generic;
  const head = `你现在是我的大学课程助教。我是在国外读书的中国学生，母语中文。
我会把一门课**多节课**的笔记合起来发给你，帮我做期中/期末复习。

重要规则：
1. 内容来自课堂录音的自动转写和整理，**可能有识别错误**，遇到不通顺的地方按上下文推断并标注出来。
2. **不要编造没出现过的内容**。
3. 全部用简体中文回答，专业术语用「中文（English）」格式。

你的任务：
- 画出这门课的**知识地图**：有哪几大块，彼此怎么关联
- 找出**反复出现**的概念（在多节课里都提到的 = 高概率考点），并说明它们在不同节里的侧重有什么不同
- 列出所有提到过的**作业、deadline、考试范围**，按时间排序
- 给出**高/中/低**三档考点预测和判断依据
- 出一套自测题（10 道，覆盖各章），先只给题目
- 最后给一份「冲刺复习顺序」清单

课程信息：
- 学科：${ctx.course || '未填写'}
- 老师：${ctx.teacher || '未填写'}
- 共 ${sessions.length} 节课
`;

  const blocks = sessions.map((s, i) => {
    const notes = (s.myNotes || '').trim();
    return `${HEAD}\n【第 ${i + 1} 节】${s.title}　${dateCN(s.startedAt)}\n${HEAD}\n` +
      (s.summary ? s.summary : '（这节没有概要）') +
      (notes ? `\n\n— 我这节课自己记的笔记 —\n${notes}` : '');
  }).join('\n\n');

  const budget = Math.max(2000, T.chunk - head.length - 400);
  const chunks = splitText(blocks, budget);
  if (chunks.length === 1) {
    return { title: '总复习', mode, target, chars: head.length + blocks.length,
      parts: [{ label: '全部内容（一次贴完）', text: head + '\n' + blocks + `\n\n${HEAD}\n以上就是全部内容，请开始。` }] };
  }
  return {
    title: '总复习', mode, target, chars: head.length + blocks.length,
    parts: chunks.map((c, i) => ({
      label: `第 ${i + 1} / ${chunks.length} 段`,
      text: (i === 0 ? head + `\n内容较长，分 ${chunks.length} 段发。收到前面几段时请只回复「收到第 N 段」。\n` : `（接上文，第 ${i + 1} / ${chunks.length} 段）\n\n`) + c +
        (i === chunks.length - 1 ? `\n\n${HEAD}\n以上就是全部内容，请开始。` : `\n\n${HEAD}\n（还没发完，请只回复「收到第 ${i + 1} 段」）`)
    }))
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // 退回到老办法（有些环境不给 clipboard 权限）
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (__) { return false; }
  }
}

export const AI_LINKS = [
  ['Claude', 'https://claude.ai/new'],
  ['ChatGPT', 'https://chat.openai.com/'],
  ['Kimi', 'https://kimi.moonshot.cn/'],
  ['DeepSeek', 'https://chat.deepseek.com/'],
  ['通义千问', 'https://tongyi.aliyun.com/qianwen/']
];
