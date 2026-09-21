/**
 * fuse.js —— 双模型译文的「确定性评分与择优器」
 *
 * 背景（真实实测，不是猜的）：
 *   opus-mt（Marian, web/js/mt.js）      短句准、术语准、数字日期准，但长句会整段漏译、会复读。
 *   Qwen LLM（web/js/translate-llm.js）  长句完整、懂上下文，但会把术语简化（First Amendment → 「宪法」）、
 *                                        会把数字/时间译错（before midnight → 「凌晨」）。
 *
 * 所以「逐句取优」是有价值的。但评判者必须是**确定性规则**：
 * 再叫一个模型来当裁判只会引入第三种错误，而且慢到没法在结束 session 时跑几千句。
 * 本文件是纯同步、无 IO、无推理的打分器，几千句在几十毫秒内跑完。
 *
 * 只依赖 glossary.js（已稳定）。不碰 mt.js / translate-llm.js / translate.js。
 *
 * 导出：
 *   scoreTranslation(en, zh, opts) -> {score, checks, fatal}
 *   pickBest(en, candidates, opts) -> {zh, from, score, runnerUp, reason, allScores}
 *   fuseMany(items, opts)          -> {results, stats}
 *   explainStats(stats)            -> string
 *   （附带 WEIGHTS / ENGINE_NAMES / DEFAULTS 供主协调者调参和展示）
 */

import { findTerms, looksDegenerate } from './glossary.js';

/* ===========================================================================
 * 〇、权重与阈值
 * ---------------------------------------------------------------------------
 * 权重依据（按「译错了对留学生的实际伤害」排序，不是按语言学重要性）：
 *
 *   numeric  45  数字/日期/时间保真。作业截止时间译错 = 直接挂科，伤害最大且不可挽回。
 *                这是唯一一个「错了比没翻还糟」的维度，所以给最高权重，并且错译（conflict）
 *                比漏译（missing）罚得更狠。
 *   coverage 27  内容覆盖度。opus-mt 的典型故障是「后半句整个丢了」，而丢掉的那半句
 *                用户根本不知道自己丢了 —— 静默失败，危害仅次于数字错。
 *   glossary 20  术语正确性。术语被简化（第一修正案 → 宪法）会让笔记失去法学含义，
 *                但学生通常能从上下文补回来，且 applyGlossary 事后还能纠正一部分，
 *                所以低于前两项。
 *   fluency   8  流畅度启发。基于标点/字频的猜测，本身就不可靠，只用来打破平局，
 *                绝不允许它单独翻盘。
 *
 * 合计 100 分。退化（looksDegenerate）直接 fatal，不参与加权。
 * ========================================================================= */

export const WEIGHTS = Object.freeze({
  numeric: 45,
  coverage: 27,
  glossary: 20,
  fluency: 8
});

export const ENGINE_NAMES = Object.freeze({
  mt: 'opus-mt',
  llm: 'Qwen LLM',
  local: '本地模型',
  cloud: '云端模型'
});

export const DEFAULTS = Object.freeze({
  // 分数差小于这个值就算「打平」，改用优先级规则裁定。
  // 取 6：单个术语命中/漏掉 = 20/N 分，单个时间词错 ≈ 20 分以上，
  // 6 分大致等于「只有流畅度和长度上的细微差别」，那种差别不足以信任。
  tie: 6,
  // 长句门槛：超过这么多英文词就认为 LLM 的上下文优势开始起作用
  longWords: 25,
  // 短句门槛：不超过这么多词的句子 opus-mt 几乎不会漏译，反而更准
  shortWords: 12
});

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const S = v => String(v == null ? '' : v);

/** 英文词数 */
function enWordCount(en) {
  return (S(en).match(/[A-Za-z0-9'’-]+/g) || []).length;
}

/**
 * 英文虚词表。中文翻译会把这些词整个吃掉（不译成字），
 * 所以估算「译文该有多长」时它们不能按实词算。
 */
const STOPWORDS = new Set(('a an the of to in on at for with by from as into out up down over under ' +
  'is are was were be been being am do does did done have has had having ' +
  'will would shall should can could may might must ' +
  'that this these those it its he she they them his her their we you i me my your our us ' +
  'and or but so if then than there here what which who whom whose when where why how ' +
  'not no nor very really actually probably basically essentially just about going want ' +
  'kind sort lot much many some any all both each again own same too s t re ve ll d m o')
  .split(/\s+/));

/** 有效词数：虚词只按 0.45 个词算（系数由实测的「简洁但正确」样本拟合得到） */
function effectiveWordCount(en) {
  const ws = S(en).match(/[A-Za-z0-9'’-]+/g) || [];
  let sum = 0;
  for (const w of ws) {
    const k = w.toLowerCase().replace(/['’].*$/, '');
    sum += STOPWORDS.has(k) ? 0.45 : 1;
  }
  return sum;
}

/**
 * 译文「有效长度」：汉字算 1，一个英文单词算 1.5（术语注解「最高法院（Supreme Court）」
 * 里的英文是有信息量的，不能当空气），一串数字算 1。
 */
function zhLen(zh) {
  const s = S(zh);
  const cjk = (s.match(/[㐀-䶿一-鿿]/g) || []).length;
  const latin = (s.match(/[A-Za-z]+/g) || []).length;
  const digits = (s.match(/\d+/g) || []).length;
  return cjk + latin * 1.5 + digits;
}

/* ===========================================================================
 * 一、数字 / 日期 / 时间 事实抽取
 * ---------------------------------------------------------------------------
 * 思路：从英文里抽出一串「事实」，每个事实带
 *   accept   —— 译文里出现任意一个就算保住了
 *   conflict —— accept 全都没命中、却出现了这里的词，说明**译错了**（比漏掉更危险）
 *   w        —— 该事实的重要性
 * 然后 numeric 分 = 命中权重 / 总权重，出现 conflict 再额外重罚。
 * ========================================================================= */

// 英文数词 → 十进制值
const NUM_WORD = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1000000,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, thirtieth: 30
});

const CN_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 一个数值在中文里可能的写法（「four」既可能译成「四」「第四」也可能是「4」） */
function cnForms(n) {
  const out = [];
  if (!isFinite(n)) return out;
  if (Number.isInteger(n)) {
    if (n >= 0 && n <= 9) out.push(CN_DIGIT[n]);
    else if (n === 10) out.push('十');
    else if (n > 10 && n < 20) out.push('十' + CN_DIGIT[n - 10]);
    else if (n >= 20 && n < 100) {
      const t = Math.floor(n / 10), o = n % 10;
      out.push(CN_DIGIT[t] + '十' + (o ? CN_DIGIT[o] : ''));
    }
    if (n === 2) out.push('两');
    if (n === 100) out.push('百');
    if (n === 1000) out.push('千');
    if (n === 10000) out.push('万');
    if (n === 1000000) out.push('百万');
    // 年份：2025 → 二〇二五 / 二零二五
    if (n >= 1000 && n <= 2999) {
      const ds = String(n).split('');
      out.push(ds.map(d => (d === '0' ? '〇' : CN_DIGIT[+d])).join(''));
      out.push(ds.map(d => CN_DIGIT[+d]).join(''));
    }
  }
  return out;
}

/** 半角数字串的全角写法 */
function fullWidth(s) {
  return s.replace(/[0-9]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WD_CN = ['[日天]', '一', '二', '三', '四', '五', '六']; // 日天/一/二/三/四/五/六
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// 时间词/相对时间词表。accept 命中即算保真；accept 全灭而 conflict 命中 = 译错。
const TIME_TABLE = [
  { re: /\bmidnight\b/i,            label: 'midnight',   w: 1.7, accept: ['午夜', '半夜', '子夜', '零点', '零時', '零时', '12点', '十二点', '24点'], conflict: ['凌晨', '清晨', '早上', '上午', '中午', '下午', '傍晚'] },
  { re: /\bnoon\b|\bmidday\b/i,     label: 'noon',       w: 1.6, accept: ['中午', '正午', '晌午', '12点', '十二点'], conflict: ['午夜', '半夜', '凌晨', '晚上', '早上'] },
  { re: /\btonight\b/i,             label: 'tonight',    w: 1.5, accept: ['今晚', '今夜', '今天晚上', '今天夜里'], conflict: ['明晚', '昨晚', '明天晚上', '昨天晚上'] },
  // 注意：tomorrow / yesterday 这两行是拿 maskCompoundDays() 处理过的文本去匹配的，
  // 「the day after tomorrow」已经被换成占位符，不会再命中这里 ——
  // 否则「后天」这种**完全正确**的译法会被当成 tomorrow 的 conflict 误杀。
  // （这里故意不用 (?<!...) 逆向断言：旧 Safari 不支持，会在**解析期**就报语法错，
  //   整个无构建的 ES Module 会直接加载失败。）
  { re: /\btomorrow\b/i,           label: 'tomorrow',   w: 1.6, accept: ['明天', '明日', '明早', '明晚', '次日'], conflict: ['昨天', '昨日', '后天', '前天', '今天'] },
  { re: /\byesterday\b/i,          label: 'yesterday',  w: 1.5, accept: ['昨天', '昨日', '昨晚'], conflict: ['明天', '今天', '前天', '后天'] },
  { re: /\btoday\b/i,               label: 'today',      w: 1.3, accept: ['今天', '今日', '本日', '当天', '今晚'], conflict: ['明天', '昨天'] },
  { re: /\bnext\s+week\b/i,         label: 'next week',  w: 1.6, accept: ['下周', '下星期', '下个星期', '下個星期', '下週', '下礼拜'], conflict: ['上周', '上星期', '本周', '这周', '上週'] },
  { re: /\bthis\s+week\b/i,         label: 'this week',  w: 1.3, accept: ['本周', '这周', '这个星期', '本星期', '本週'], conflict: ['下周', '上周', '下星期', '上星期'] },
  { re: /\blast\s+week\b/i,         label: 'last week',  w: 1.4, accept: ['上周', '上星期', '上週', '上礼拜'], conflict: ['下周', '本周', '下星期'] },
  { re: /\bnext\s+month\b/i,        label: 'next month', w: 1.5, accept: ['下个月', '下月', '下個月'], conflict: ['上个月', '本月', '这个月', '上月'] },
  { re: /\blast\s+month\b/i,        label: 'last month', w: 1.3, accept: ['上个月', '上月', '上個月'], conflict: ['下个月', '本月', '下月'] },
  { re: /\bnext\s+(?:year|semester|term)\b/i, label: 'next year/semester', w: 1.4, accept: ['明年', '下一年', '下年', '下学期', '下個學期'], conflict: ['去年', '今年', '上学期', '本学期'] },
  { re: /\blast\s+(?:year|semester|term)\b/i, label: 'last year/semester', w: 1.3, accept: ['去年', '上一年', '上学期'], conflict: ['明年', '今年', '下学期'] },
  { re: /\bthis\s+(?:year|semester|term)\b/i, label: 'this year/semester', w: 1.2, accept: ['今年', '本年', '本学期', '这学期'], conflict: ['明年', '去年', '下学期', '上学期'] },
  { re: /\bweekend\b/i,             label: 'weekend',    w: 1.1, accept: ['周末', '週末'], conflict: ['工作日', '平日'] },
  { re: /\bmorning\b/i,             label: 'morning',    w: 1.3, accept: ['早上', '上午', '早晨', '清晨', '早间'], conflict: ['下午', '晚上', '午夜', '中午'] },
  { re: /\bafternoon\b/i,           label: 'afternoon',  w: 1.3, accept: ['下午', '午后'], conflict: ['上午', '早上', '早晨', '晚上', '午夜'] },
  // 「five in the evening」中文说「下午五点」是完全正确的（不是错译），
  // 所以「下午」必须进 accept；它本来也不在 conflict 里，加进来不会削弱冲突检测。
  { re: /\bevening\b/i,             label: 'evening',    w: 1.2, accept: ['晚', '夜', '傍晚', '下午'], conflict: ['上午', '早上', '中午'] },
  { re: /\blast\s+night\b/i,        label: 'last night', w: 1.4, accept: ['昨晚', '昨天晚上', '昨夜', '昨天夜里'], conflict: ['今晚', '明晚', '今天晚上', '明天晚上'] },
  { re: /\bnight\b/i,               label: 'night',      w: 1.1, accept: ['晚', '夜'], conflict: ['早上', '上午', '中午'] },
  { re: /\ba\.?m\.?\b/i,            label: 'a.m.',       w: 1.2, accept: ['上午', '早上', '凌晨', '早晨', 'am', 'AM', 'a.m'], conflict: ['下午', '晚上', 'pm', 'PM'] },
  { re: /\bp\.?m\.?\b/i,            label: 'p.m.',       w: 1.2, accept: ['下午', '晚上', '傍晚', '夜', 'pm', 'PM', 'p.m'], conflict: ['上午', '早上', 'am', 'AM'] },
  { re: /\bo'?clock\b/i,            label: "o'clock",    w: 0.7, accept: ['点', '时'], conflict: [] },
  { re: /\b(?:percent|per\s*cent)\b|%/i, label: 'percent', w: 1.3, accept: ['%', '％', '百分'], conflict: [] }
];

// 截止边界词：「before midnight」丢掉「before」也很危险
const BOUND_TABLE = [
  { re: /\b(?:before|by|prior\s+to|no\s+later\s+than|until|till)\b/i, label: 'before/by', w: 0.6, accept: ['前', '之前', '以前', '截止', '截至', '不晚于', '为止', '以内'], conflict: [] },
  { re: /\bafter\b/i,   label: 'after', w: 0.5, accept: ['后', '之后', '以后', '此后'], conflict: [] },
  { re: /\bdue\b/i,     label: 'due',   w: 0.8, accept: ['截止', '到期', '期限', '交', '提交', '上交', 'due'], conflict: [] }
];

/** 这个位置是否落在某个术语的跨度里（术语内部的 first/second 不当数字处理） */
function inTerm(pos, spans) {
  for (let i = 0; i < spans.length; i++) {
    if (pos >= spans[i][0] && pos < spans[i][1]) return true;
  }
  return false;
}

/**
 * 从英文抽出所有数字/日期/时间事实
 * @returns {{label:string, w:number, accept:(string|RegExp)[], conflict:(string|RegExp)[], kind:string}[]}
 */
function extractFacts(en, termSpans) {
  const text = S(en);
  const spans = termSpans || [];
  const facts = [];
  const seen = new Set();
  const push = f => {
    const k = f.kind + ':' + f.label;
    if (seen.has(k)) return;
    seen.add(k);
    facts.push(f);
  };

  // --- 1) 阿拉伯数字（含百分号、千分位、小数）---
  const digitRe = /\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = digitRe.exec(text)) !== null) {
    if (inTerm(m.index, spans)) continue;
    const raw = m[0].replace(/,/g, '');
    const n = Number(raw);
    const accept = [raw, fullWidth(raw)];
    // 千分位原样出现也算（1,000）
    if (m[0] !== raw) accept.push(m[0]);
    for (const f of cnForms(n)) accept.push(f);
    push({ kind: 'digit', label: m[0], w: 1.3, accept, conflict: [] });
  }

  // --- 2) 英文数词 / 序数词 ---
  const wordRe = /[A-Za-z']+/g;
  const lower = text.toLowerCase();
  let wm;
  while ((wm = wordRe.exec(text)) !== null) {
    const w = wm[0].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(NUM_WORD, w)) continue;
    if (inTerm(wm.index, spans)) continue;          // First Amendment 里的 First 不算数字
    // 「one of them」「no one」里的 one 是代词，不是数字
    if (w === 'one') {
      const after = lower.slice(wm.index + 3, wm.index + 12);
      const before = lower.slice(Math.max(0, wm.index - 12), wm.index);
      if (/^\s+(of|another|who|that|which)\b/.test(after)) continue;
      if (/\b(no|any|some|every|each|that)\s+$/.test(before)) continue;
    }
    // 「the first forty pages」「the first three cases」里的 first 是量化前缀，
    // 中文说「前40页」「前三个案子」，根本不会出现「一」。当数字事实会造成大面积误判。
    if (w === 'first' && /^\s+(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|thirty|forty|fifty|sixty|hundred|few|couple|several)\b/
        .test(lower.slice(wm.index + 5, wm.index + 22))) continue;
    const n = NUM_WORD[w];
    const accept = [String(n), fullWidth(String(n))].concat(cnForms(n));
    if (w === 'first') accept.push('首', '最初', '起初');
    if (w === 'second' && n === 2) accept.push('其次', '后半');
    // 钟点里的 thirty / fifteen：中文说「八点半」「八点一刻」，不会说「八点三十」。
    // 不加这条会把**正确**的「八点半」判成漏掉了 thirty（误杀）。
    // 只在确有钟点语境时放宽，避免「thirty students」也接受「半」。
    if (n === 30 || n === 15) {
      const before = lower.slice(Math.max(0, wm.index - 14), wm.index);
      const clock = /\b(?:o'?clock|a\.?m\.?|p\.?m\.?)\b/i.test(text) ||
        /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\s+$/.test(before);
      if (clock) accept.push(n === 30 ? '半' : '一刻');
    }
    push({ kind: 'numword', label: wm[0], w: 1.0, accept, conflict: [] });
  }

  // --- 3) 星期 ---
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const re = new RegExp('\\b' + WEEKDAYS[i] + 's?\\b', 'i');
    if (!re.test(text)) continue;
    const accept = [new RegExp('(?:周|週|星期|礼拜|禮拜)\\s*' + WD_CN[i]),
                    new RegExp(WEEKDAYS[i], 'i')];
    const conflict = [];
    for (let j = 0; j < WD_CN.length; j++) {
      if (j === i) continue;
      conflict.push(new RegExp('(?:周|週|星期|礼拜|禮拜)\\s*' + WD_CN[j]));
    }
    push({ kind: 'weekday', label: WEEKDAYS[i], w: 1.5, accept, conflict });
  }

  // --- 4) 月份 ---
  for (let i = 0; i < MONTHS.length; i++) {
    const name = MONTHS[i];
    // march / may / august 也是普通词，要求首字母大写才认（preprocess 已经做过大小写还原）
    const strict = (name === 'march' || name === 'may' || name === 'august');
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    const re = strict ? new RegExp('\\b' + cap + '\\b') : new RegExp('\\b' + name + '\\b', 'i');
    if (!re.test(text)) continue;
    const num = i + 1;
    const accept = [num + '月', fullWidth(String(num)) + '月']
      .concat(cnForms(num).map(f => f + '月'))
      .concat([new RegExp(name, 'i')])
      // 「12/15」「10-15」这类纯数字日期写法也是对的，不能算漏掉月份
      .concat([new RegExp('(?:^|[^\\d])' + num + '[\\/\\-.]\\d{1,2}')]);
    const conflict = [];
    for (let j = 1; j <= 12; j++) {
      if (j === num) continue;
      conflict.push(new RegExp('(?:^|[^\\d])' + j + '月'));
      for (const f of cnForms(j)) conflict.push(f + '月');
    }
    push({ kind: 'month', label: name, w: 1.5, accept, conflict });
  }

  // --- 5) 时间词 / 相对时间 ---
  // 先把「the day after tomorrow」「the day before yesterday」整体摘掉再扫 TIME_TABLE，
  // 它们各自是独立的事实，不能让内部的 tomorrow / yesterday 再匹配一次。
  if (/\bday\s+after\s+tomorrow\b/i.test(text)) {
    push({ kind: 'time', label: 'day after tomorrow', w: 1.6,
           accept: ['后天', '後天'], conflict: ['明天', '昨天', '前天', '今天'] });
  }
  if (/\bday\s+before\s+yesterday\b/i.test(text)) {
    push({ kind: 'time', label: 'day before yesterday', w: 1.5,
           accept: ['前天'], conflict: ['昨天', '明天', '后天', '今天'] });
  }
  const timeText = text
    .replace(/\bday\s+after\s+tomorrow\b/ig, ' \u0001 ')
    .replace(/\bday\s+before\s+yesterday\b/ig, ' \u0001 ');
  for (const row of TIME_TABLE) {
    if (!row.re.test(timeText)) continue;
    push({ kind: 'time', label: row.label, w: row.w, accept: row.accept, conflict: row.conflict });
  }

  // --- 6) next/last + 星期（「next Friday」丢掉 next 就成了本周五）---
  if (/\bnext\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(text)) {
    push({ kind: 'time', label: 'next <weekday>', w: 0.9,
           accept: ['下周', '下星期', '下個', '下週', '下礼拜', '下个'],
           conflict: ['上周', '上星期', '本周', '这周'] });
  }
  if (/\blast\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(text)) {
    push({ kind: 'time', label: 'last <weekday>', w: 0.9,
           accept: ['上周', '上星期', '上週', '上个'],
           conflict: ['下周', '下星期', '本周'] });
  }

  // --- 7) 截止边界词（只在已经有时间/数字事实时才算，否则 before/after 太泛）---
  if (facts.length) {
    for (const row of BOUND_TABLE) {
      if (!row.re.test(text)) continue;
      push({ kind: 'bound', label: row.label, w: row.w, accept: row.accept, conflict: row.conflict });
    }
  }

  // --- 8) 百分比的「成」写法：twenty percent → 两成 / 二成，fifty percent → 一半。
  // 这是完全正确的中文，不放进 accept 就会误杀。
  const pctM = /(\d+|[A-Za-z]+)\s*(?:%|\bpercent\b|\bper\s*cent\b)/i.exec(text);
  if (pctM) {
    const tok = pctM[1].toLowerCase();
    const pv = /^\d+$/.test(tok)
      ? Number(tok)
      : (Object.prototype.hasOwnProperty.call(NUM_WORD, tok) ? NUM_WORD[tok] : NaN);
    const extra = [];
    if (isFinite(pv) && pv % 10 === 0 && pv >= 10 && pv <= 90) {
      for (const f of cnForms(pv / 10)) extra.push(f + '成');
    }
    if (pv === 50) extra.push('一半', '半数');
    if (extra.length) {
      for (const f of facts) {
        if ((f.kind === 'digit' || f.kind === 'numword') && String(f.label).toLowerCase() === tok) {
          f.accept = f.accept.concat(extra);
        }
        if (f.kind === 'time' && f.label === 'percent') f.accept = f.accept.concat(extra);
      }
    }
  }

  return facts;
}

/**
 * 送进 looksDegenerate 之前的归一化。
 * applyGlossary（以及 LLM 自己）会产出「最高法院（Supreme Court）」和句末的
 * 「［Supreme Court＝最高法院］」，这些注解是我们**想要**的产物，
 * 却会触发 looksDegenerate 的「短句译文过长」「中文里混入空格」两条规则而误判为退化。
 * 打分时先摘掉注解，只拿正文去判退化；长度/覆盖度仍然用原文算（注解里的英文有信息量）。
 */
function stripAnnotations(zh) {
  const out = S(zh)
    .replace(/[［\[][^］\]]*[＝=][^］\]]*[］\]]/g, '')
    .replace(/（[A-Za-z0-9 .,'’&/-]+）/g, '')
    .replace(/\([A-Za-z0-9 .,'’&/-]+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out || S(zh).trim();
}

/**
 * 事实匹配前的归一化：去掉所有空白。
 * 译文里「下星期五 12 点前交」「星期天 24 点前交」是常见排版，
 * accept 表里写的是「12点」「24点」，不去空格就会把**正确**的译法判成漏译（误杀）。
 * accept 里的英文项（'a.m'/'AM'/'pm'）本身不含空格，去空格不影响它们。
 */
function normalizeForMatch(zh) {
  return S(zh).replace(/\s+/g, '');
}

/** zh 里是否出现 needle（字符串按子串、正则按 test） */
function hasAny(zh, list) {
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (!n) continue;
    if (typeof n === 'string') { if (zh.indexOf(n) >= 0) return n; }
    else { const r = n.exec(zh); if (r) return r[0]; }
  }
  return '';
}

/* ===========================================================================
 * 二、四个维度的打分
 * ========================================================================= */

/** 数字/日期保真 */
function checkNumeric(en, zh, termSpans) {
  const facts = extractFacts(en, termSpans);
  const out = {
    weight: WEIGHTS.numeric, score: 1, points: WEIGHTS.numeric,
    facts: facts.length, covered: 0, conflicts: 0, missing: [], penalty: 0,
    hard: false, note: ''
  };
  if (!facts.length) { out.note = '原文无数字/日期'; return out; }

  const zhN = normalizeForMatch(zh);   // 去空白后再匹配，避免「12 点」这类排版被误杀
  let total = 0, got = 0, confW = 0;
  for (const f of facts) {
    total += f.w;
    const hit = hasAny(zhN, f.accept);
    if (hit) { got += f.w; out.covered++; continue; }
    const bad = hasAny(zhN, f.conflict);
    if (bad) {
      out.conflicts++; confW += f.w;
      out.missing.push({ en: f.label, why: 'conflict', got: bad, w: f.w });
    } else {
      out.missing.push({ en: f.label, why: 'missing', got: '', w: f.w });
    }
  }

  let s = total > 0 ? got / total : 1;
  if (out.conflicts > 0) {
    // 译错比漏掉危险得多：先把分数砍到 4 折，再扣一笔固定分。
    // 这样「时间译错」几乎一定会输给「时间译对」的那一条。
    s *= 0.4;
    out.penalty = 8;
  }
  out.score = clamp01(s);
  out.points = out.score * WEIGHTS.numeric - out.penalty;
  // 极端情况：高权重的时间事实全错（冲突权重 >= 3.0 且几乎没保住）→ 这条根本不能给学生看
  out.hard = (confW >= 3.0 && out.score < 0.25);
  out.note = out.conflicts
    ? ('数字/日期译错 ' + out.conflicts + ' 处')
    : (out.missing.length ? ('漏掉 ' + out.missing.length + ' 处数字/日期') : '数字日期完整');
  return out;
}

/** 术语正确性 */
function checkGlossary(en, zh, terms) {
  const out = {
    weight: WEIGHTS.glossary, score: 1, points: WEIGHTS.glossary,
    total: 0, hit: 0, missing: [], note: ''
  };
  const list = terms || [];
  if (!list.length) { out.note = '原文无术语'; return out; }

  const zhLower = zh.toLowerCase();
  const seen = new Set();
  for (const t of list) {
    const key = t.en;
    if (seen.has(key)) continue;
    seen.add(key);
    out.total++;
    // 命中条件：标准译法出现，或英文原词出现（applyGlossary 会补「中文（English）」）
    let ok = t.zh && zh.indexOf(t.zh) >= 0;
    if (!ok && t.en && zhLower.indexOf(t.en.toLowerCase()) >= 0) ok = true;
    // 宽松兜底：术语中文 >= 4 字时，末 3 字出现也算（「美国联邦最高法院」vs「最高法院」两向兼容）
    if (!ok && t.zh && t.zh.length >= 4 && zh.indexOf(t.zh.slice(-3)) >= 0) ok = true;
    if (ok) out.hit++;
    else out.missing.push({ en: t.en, zh: t.zh });
  }
  out.score = out.total ? out.hit / out.total : 1;
  out.points = out.score * WEIGHTS.glossary;
  out.note = out.hit + '/' + out.total + ' 个术语命中';
  return out;
}

/**
 * 内容覆盖度 —— 长度模型
 * ---------------------------------------------------------------------------
 * 依据：英译中在这类课堂口语材料上，「有效中文长度 / 英文词数」稳定落在 1.3–1.8 之间
 * （汉字信息密度高于英文单词，但中文要补出英文省略的量词、连词、语气）。取 1.55 作中心。
 * 短句另加常数补偿：句子越短，固定开销（主语、标点、量词）占比越大，
 *   w<=4 时 +3，其余 +1.2。
 * 容忍带随句长收紧：长句的比例估计更可靠，短句噪声大，所以短句放宽。
 *   w>=12 : 正常 [0.75, 1.45]，到 0.30 / 2.6 归零
 *   6..11 : 正常 [0.65, 1.60]，到 0.22 / 3.0 归零
 *   w<6   : 正常 [0.50, 1.90]，到 0.12 / 3.6 归零
 * 低侧掉得比高侧快 —— 漏译（静默丢内容）比啰嗦危险。
 * 例：原文 35 词 → 期望 55.5 字；译文 12 字 → r=0.22 → 0 分，正好抓住 opus-mt 的半句漏译。
 */
function checkCoverage(en, zh) {
  const w = enWordCount(en);
  const z = zhLen(zh);
  const out = {
    weight: WEIGHTS.coverage, score: 1, points: WEIGHTS.coverage,
    words: w, chars: Math.round(z * 10) / 10, ratio: 1, expect: 0, effWords: w, note: ''
  };
  if (!w) { out.note = '原文为空'; return out; }

  // 短句要用「有效词数」而不是词数：课堂短句几乎全是虚词
  // （"I think that is probably all we have time for." 10 个词，实词只有 3 个），
  // 中文会把这些虚词整个吃掉，「时间差不多了」是完整且正确的译文。
  // 用原始词数算期望会把这类译文一律判成漏译 —— 实测 10/10 全部误扣，
  // 而且因为 opus-mt 更简洁、LLM 更啰嗦，这个偏差是**系统性偏向 LLM** 的，
  // 正好和「短句优先 opus-mt」的设计意图相反。
  // 长句（>=12 词）实词占比稳定，1.55 的经验系数成立，所以不动，
  // 以免削弱对「后半句整段漏译」的检测 —— 那才是 coverage 这一维的主要职责。
  const ew = w < 12 ? effectiveWordCount(en) : w;
  out.effWords = Math.round(ew * 10) / 10;

  const expect = 1.55 * ew + (ew <= 4 ? 3 : 1.2);
  const r = z / expect;
  out.expect = Math.round(expect * 10) / 10;
  out.ratio = Math.round(r * 100) / 100;

  let lo, hi, zLo, zHi;
  if (w >= 12) { lo = 0.75; hi = 1.45; zLo = 0.30; zHi = 2.6; }
  else if (w >= 6) { lo = 0.65; hi = 1.60; zLo = 0.22; zHi = 3.0; }
  else { lo = 0.50; hi = 1.90; zLo = 0.12; zHi = 3.6; }

  let s;
  if (r < lo) s = clamp01((r - zLo) / (lo - zLo));
  else if (r > hi) s = clamp01((zHi - r) / (zHi - hi));
  else s = 1;

  out.score = s;
  out.points = s * WEIGHTS.coverage;
  out.note = r < lo
    ? ('偏短：原文 ' + w + ' 词，译文约 ' + out.chars + ' 字（期望 ' + out.expect + ' 字）')
    : r > hi
      ? ('偏长：原文 ' + w + ' 词，译文约 ' + out.chars + ' 字（期望 ' + out.expect + ' 字）')
      : '长度合理';
  return out;
}

/* ---------------------------------------------------------------------------
 * 局部复读检测
 * ---------------------------------------------------------------------------
 * glossary.js 的 looksDegenerate 只在复读**占满大半句**时才判 fatal
 * （3~12 字单元要求 >40% 句长或 >=10 字；2 字单元要求重复 3 次或占 >60%）。
 * 可是 opus-mt 最常见的故障是**局部**复读：
 *   「样本量样本量太小太小无法检测到效应。」
 * 这条在 looksDegenerate 眼里完全正常，四个维度也全是满分 —— 会拿到 100 分，
 * 反过来打败正确的译文。复读是本模块存在的首要理由，不能只靠 glossary 兜底。
 *
 * 这里按「冗余字数占比」给一笔独立扣分（不进四维权重，直接从总分里减），
 * 严重时才升级为 fatal —— fatal 会让译文变空，所以门槛卡得比扣分高得多。
 * ------------------------------------------------------------------------- */

// 合法叠词，别误伤（「渐渐」这类单字叠词本来就不会被 {2,} 的单元规则命中，
// 这里收的是 2 字单元的合法重复）
const REPEAT_OK = new Set([
  '一个一个', '一次一次', '一步一步', '一点一点', '一天一天', '一遍一遍',
  '各种各样', '有的有的', '自言自语'
]);

function detectRepeat(zh, en) {
  const z = S(zh).replace(/\s+/g, '');
  // 原文自己就重复了（口语里「very very important」「no no no」很常见），
  // 译文跟着重复是**忠实**，不是退化。这种情况只保留严重级别的判定。
  const srcRepeats = /\b([A-Za-z']+)\b[\s,]+\1\b/i.test(S(en));
  const cjk = (z.match(/[一-鿿]/g) || []).length;
  const out = { bad: false, hard: false, unit: '', excess: 0, ratio: 0, penalty: 0, note: '' };
  if (cjk < 4) return out;

  let excess = 0, worst = '', worstLen = 0;

  // 2~12 字单元连续重复：「样本量样本量」冗余 3 字
  const reUnit = /([一-鿿]{2,12})\1+/g;
  let m;
  while ((m = reUnit.exec(z)) !== null) {
    if (REPEAT_OK.has(m[0])) continue;
    const ex = m[0].length - m[1].length;
    excess += ex;
    if (ex > worstLen) { worstLen = ex; worst = m[1]; }
  }
  // 单字连续出现 3 次以上：「被被被」（looksDegenerate 要 4 次以上才管）
  const reChar = /([一-鿿])\1{2,}/g;
  while ((m = reChar.exec(z)) !== null) {
    const ex = m[0].length - 1;
    excess += ex;
    if (ex > worstLen) { worstLen = ex; worst = m[1]; }
  }

  if (!excess) return out;
  const severe = (excess / cjk >= 0.4) || excess >= 8;
  if (srcRepeats && !severe) return out;
  out.bad = true;
  out.unit = worst;
  out.excess = excess;
  out.ratio = Math.round((excess / cjk) * 100) / 100;
  // 冗余占比越高罚越重；起罚 12 分，封顶 30 分 —— 保证一定超过平局阈值 6 分，
  // 但不至于把一条「只是多说了两个字」的译文彻底废掉。
  out.penalty = Math.min(30, 12 + 40 * (excess / cjk));
  out.penalty = Math.round(out.penalty * 10) / 10;
  // 冗余超过四成句长、或一口气重复了 8 个以上冗余字 → 这条已经没法看了
  out.hard = severe;
  out.note = '复读「' + worst + '」（冗余 ' + excess + ' 字，占 ' + Math.round(out.ratio * 100) + '%）';
  return out;
}

/** 流畅度启发（权重最低，只用来打破平局） */
function checkFluency(zh) {
  const issues = [];
  let pen = 0;
  const s = zh;
  const cjk = (s.match(/[一-鿿]/g) || []).length;

  if (/的的|了了|是是|在在/.test(s)) { pen += 0.28; issues.push('叠字（的的/了了）'); }
  if (/^[，。、；：,.;:!?！？）)\]】]/.test(s.trim())) { pen += 0.22; issues.push('以标点开头'); }
  if (cjk >= 12 && !/[。！？…”』」)）]$/.test(s.trim())) { pen += 0.22; issues.push('句末没有终止标点（疑似半句截断）'); }
  if (/[，,]\s*$/.test(s.trim())) { pen += 0.3; issues.push('句子停在逗号上'); }

  // 半角标点夹在汉字中间：opus-mt 的典型输出「最高法院裁定,第一修正案…」
  if (/[一-鿿][,;:!?][一-鿿]/.test(s)) { pen += 0.12; issues.push('中文里用了半角标点'); }

  // 「的」密度过高 = 定语堆叠的机翻腔
  if (cjk >= 10) {
    const de = (s.match(/的/g) || []).length;
    if (de / cjk > 0.17) { pen += 0.2; issues.push('「的」过密'); }
  }

  // 被标点切出的单字片段过多 = 逐词硬拼
  const segs = s.split(/[，。、；：,.;:!?！？\s]+/).filter(x => x);
  if (segs.length >= 3) {
    const single = segs.filter(x => (x.match(/[一-鿿]/g) || []).length === 1).length;
    if (single >= 3 || (single >= 2 && single / segs.length > 0.5)) {
      pen += 0.25; issues.push('多个单字片段');
    }
  }

  // 括号/引号不配对
  const pairs = [['（', '）'], ['(', ')'], ['「', '」'], ['“', '”'], ['【', '】'], ['［', '］']];
  for (const [a, b] of pairs) {
    const ca = s.split(a).length - 1, cb = s.split(b).length - 1;
    if (ca !== cb) { pen += 0.18; issues.push('括号/引号不配对'); break; }
  }

  // 英文残留比中文还多（术语注解除外，注解通常在括号里）
  const letters = (s.replace(/[（(][^）)]*[）)]/g, '').match(/[A-Za-z]/g) || []).length;
  if (cjk > 0 && letters > cjk) { pen += 0.3; issues.push('英文残留过多'); }

  const score = clamp01(1 - pen);
  return {
    weight: WEIGHTS.fluency, score, points: score * WEIGHTS.fluency,
    issues, note: issues.length ? issues.join('、') : '无明显问题'
  };
}

/* ===========================================================================
 * 三、scoreTranslation
 * ========================================================================= */

/**
 * 给一条译文打分。score 越高越好（满分 100），fatal=true 表示这条根本不能用。
 * @param {string} en 原文
 * @param {string} zh 译文
 * @param {{terms?:Array}} [opts] terms 可传预先算好的 findTerms(en) 结果，避免重复计算
 * @returns {{score:number, checks:Object, fatal:boolean}}
 */
export function scoreTranslation(en, zh, opts) {
  const o = opts || {};
  const src = S(en);
  const out = S(zh).trim();

  if (!out) {
    return {
      score: -1, fatal: true,
      checks: { degenerate: { bad: true, reason: '空译文' }, fatalReason: '空译文' }
    };
  }

  const terms = o.terms || findTerms(src);
  const spans = terms.map(t => [t.start, t.end]);

  const deg = looksDegenerate(stripAnnotations(out), src);
  const numeric = checkNumeric(src, out, spans);
  const glos = checkGlossary(src, out, terms);
  const cov = checkCoverage(src, out);
  const flu = checkFluency(out);
  const rep = detectRepeat(stripAnnotations(out), src);

  const score = Math.round(
    (numeric.points + glos.points + cov.points + flu.points - rep.penalty) * 10
  ) / 10;
  const fatal = !!deg.bad || numeric.hard || rep.hard;

  return {
    score,
    fatal,
    checks: {
      numeric, glossary: glos, coverage: cov, fluency: flu,
      degenerate: deg,
      repeat: rep,
      fatalReason: deg.bad
        ? deg.reason
        : (rep.hard
            ? rep.note
            : (numeric.hard ? ('数字/日期严重译错：' + numeric.note) : ''))
    }
  };
}

/* ===========================================================================
 * 四、pickBest —— 逐句取优
 * ---------------------------------------------------------------------------
 * 平局规则的论证（来自实测的性格差异表）：
 *
 *   1) 句中含数字 / 日期 / 时间 → 优先 opus-mt。
 *      实测 opus-mt 把「before midnight」译成「午夜前」（对），
 *      Qwen 译成「凌晨」（错）。LLM 会「顺手改写」时间表达，Marian 是逐段对齐的，
 *      反而不会动数字。作业截止时间错了代价最大，平局时宁可信 opus-mt。
 *
 *   2) 长句（> 25 词）→ 优先 Qwen LLM。
 *      实测 35 词那句 opus-mt 后半句整个丢了，Qwen 完整。Marian 的
 *      beam search 在长输入上容易提前收尾，这是结构性缺陷，不是偶然。
 *
 *   3) 短句（<= 12 词）且含术语 → 优先 opus-mt。
 *      实测「First Amendment」Qwen 简化成「宪法」。短句里 LLM 的上下文优势用不上，
 *      却保留了改写倾向。
 *
 *   4) 其余：句长 > 18 词偏 LLM，否则偏 opus-mt（opus-mt 在中短句上整体更稳）。
 *
 *   规则 1 优先于 2：一句 30 词的作业通知，宁可句式糙一点也不能把日期译错。
 * ========================================================================= */

function engineName(from, names) {
  const n = names || ENGINE_NAMES;
  return n[from] || from || '未知引擎';
}

/** 平局时的优先级：返回排好序的引擎名数组（越靠前越优先） */
function tiePriority(en, facts, terms, opts) {
  const o = opts || {};
  const w = enWordCount(en);
  const base = o.priority || ['mt', 'llm'];
  if (facts > 0) return { order: ['mt', 'llm'], why: '句中含数字/日期，优先采信 ' + engineName('mt', o.names) };
  if (w > (o.longWords || DEFAULTS.longWords)) return { order: ['llm', 'mt'], why: '长句（' + w + ' 词），优先采信 ' + engineName('llm', o.names) };
  if (terms > 0 && w <= (o.shortWords || DEFAULTS.shortWords)) return { order: ['mt', 'llm'], why: '短句含术语，优先采信 ' + engineName('mt', o.names) };
  if (w > 18) return { order: ['llm', 'mt'], why: '偏长句，优先采信 ' + engineName('llm', o.names) };
  return { order: base.slice(), why: '中短句，优先采信 ' + engineName(base[0], o.names) };
}

/** 找出胜者相对亚军差距最大的维度，生成一句中文理由 */
function buildReason(win, lose, names) {
  const wn = engineName(win.from, names);
  const ln = engineName(lose.from, names);

  if (lose.fatal) {
    const r = lose.checks && lose.checks.fatalReason ? lose.checks.fatalReason : '不可用';
    return '选了 ' + wn + '：' + ln + ' 的译文被判为不可用 —— ' + r;
  }

  // 局部复读不在四个加权维度里，单独判，优先级排在维度差之前
  const lr = lose.checks && lose.checks.repeat;
  const wr = win.checks && win.checks.repeat;
  if (lr && lr.bad && !(wr && wr.bad) && lr.penalty >= 10) {
    return '选了 ' + wn + '：' + ln + ' 出现了' + lr.note;
  }

  const dims = [
    ['numeric', win.checks.numeric, lose.checks.numeric],
    ['coverage', win.checks.coverage, lose.checks.coverage],
    ['glossary', win.checks.glossary, lose.checks.glossary],
    ['fluency', win.checks.fluency, lose.checks.fluency]
  ];
  let best = null, gap = 0;
  for (const [k, a, b] of dims) {
    const g = (a.points || 0) - (b.points || 0);
    if (g > gap) { gap = g; best = k; }
  }
  if (!best || gap < 0.8) return '选了 ' + wn + '：两条译文质量接近，综合得分略高';

  if (best === 'numeric') {
    const miss = lose.checks.numeric.missing;
    if (miss && miss.length) {
      const m = miss.slice().sort((x, y) => y.w - x.w)[0];
      return m.why === 'conflict'
        ? '选了 ' + wn + '：' + ln + ' 把「' + m.en + '」译成了「' + m.got + '」'
        : '选了 ' + wn + '：' + ln + ' 漏掉了「' + m.en + '」';
    }
    return '选了 ' + wn + '：' + ln + ' 的数字/日期不可靠';
  }
  if (best === 'coverage') {
    const c = lose.checks.coverage;
    return c.ratio < 1
      ? '选了 ' + wn + '：' + ln + ' 明显漏译（原文 ' + c.words + ' 词，译文只有约 ' + Math.round(c.chars) + ' 字）'
      : '选了 ' + wn + '：' + ln + ' 译文冗长（原文 ' + c.words + ' 词，译文约 ' + Math.round(c.chars) + ' 字）';
  }
  if (best === 'glossary') {
    const miss = lose.checks.glossary.missing;
    if (miss && miss.length) {
      const m = miss[0];
      return '选了 ' + wn + '：' + ln + ' 漏掉了术语「' + m.en + '（' + m.zh + '）」';
    }
    return '选了 ' + wn + '：' + ln + ' 的术语译法不标准';
  }
  const iss = lose.checks.fluency.issues;
  return '选了 ' + wn + '：' + ln + ' 的中文读着更别扭（' + (iss && iss.length ? iss[0] : '标点/断句') + '）';
}

/**
 * 在多条候选译文里挑一条最好的
 * @param {string} en
 * @param {{zh:string, from:string}[]} candidates 任意条数，例如 [{zh,from:'mt'},{zh,from:'llm'}]
 * @param {{terms?:Array, tie?:number, priority?:string[], names?:Object,
 *          longWords?:number, shortWords?:number}} [opts]
 * @returns {{zh:string, from:string, score:number,
 *            runnerUp:{zh:string,from:string,score:number}|null,
 *            reason:string, tie:boolean, allScores:Array}}
 *          tie=true 表示两条分数接近、是靠优先级规则裁定的（UI 可以提示「可切换」）
 */
export function pickBest(en, candidates, opts) {
  const o = opts || {};
  const src = S(en);
  const list = (candidates || []).filter(c => c && S(c.zh).trim());
  const terms = o.terms || findTerms(src);

  const scored = list.map(c => {
    const r = scoreTranslation(src, c.zh, { terms });
    return { zh: S(c.zh).trim(), from: c.from || '', score: r.score, fatal: r.fatal, checks: r.checks };
  });

  const allScores = scored.map(s => ({
    from: s.from, zh: s.zh, score: s.score, fatal: s.fatal, checks: s.checks
  }));

  // 没有任何候选
  if (!scored.length) {
    return { zh: '', from: '', score: -1, runnerUp: null, reason: '没有可用的译文', tie: false, allScores };
  }

  const usable = scored.filter(s => !s.fatal);

  // 全部 fatal
  if (!usable.length) {
    const why = scored.map(s => engineName(s.from, o.names) + '（' + (s.checks.fatalReason || '不可用') + '）').join('，');
    const head = scored.length === 1 ? '唯一一版译文不可用：' : '各版译文都不可用：';
    return {
      zh: '', from: '', score: -1, runnerUp: null,
      reason: head + why, tie: false, allScores
    };
  }

  // 只剩一条可用
  if (usable.length === 1) {
    const only = usable[0];
    const dead = scored.filter(s => s.fatal);
    const reason = dead.length
      ? buildReason(only, dead.sort((a, b) => b.score - a.score)[0], o.names)
      : '只有 ' + engineName(only.from, o.names) + ' 给出了可用译文';
    return {
      zh: only.zh, from: only.from, score: only.score,
      runnerUp: dead.length ? { zh: dead[0].zh, from: dead[0].from, score: dead[0].score } : null,
      reason, tie: false, allScores
    };
  }

  // 多条可用：先按分数排
  const sorted = usable.slice().sort((a, b) => b.score - a.score);
  let win = sorted[0], second = sorted[1];
  const tie = o.tie == null ? DEFAULTS.tie : o.tie;
  let reason, isTie = false;

  if (win.score - second.score < tie) {
    isTie = true;
    // 打平 → 走优先级规则
    const facts = win.checks.numeric.facts || second.checks.numeric.facts || 0;
    const pri = tiePriority(src, facts, terms.length, o);
    const near = sorted.filter(s => win.score - s.score < tie);
    let chosen = null;
    for (const eng of pri.order) {
      const c = near.find(s => s.from === eng);
      if (c) { chosen = c; break; }
    }
    if (!chosen) chosen = win;
    if (chosen !== win) { second = win; win = chosen; }
    else second = sorted.find(s => s !== win) || second;
    reason = '两条译文质量接近（差 ' + (Math.round(Math.abs(win.score - second.score) * 10) / 10) +
             ' 分）：' + pri.why;
  } else {
    reason = buildReason(win, second, o.names);
  }

  return {
    zh: win.zh, from: win.from, score: win.score,
    runnerUp: { zh: second.zh, from: second.from, score: second.score },
    reason, tie: isTie, allScores
  };
}

/* ===========================================================================
 * 五、fuseMany —— 批量融合（纯同步，几千句 < 1 秒）
 * ========================================================================= */

/**
 * @param {{id:*, en:string, mt?:string, llm?:string, [k:string]:*}[]} items
 * @param {{engines?:string[], tie?:number, priority?:string[], names?:Object,
 *          keepScores?:boolean}} [opts]
 *        engines 默认 ['mt','llm']，想加第三个引擎就传 ['mt','llm','cloud']
 *        keepScores 为 true 时结果里保留完整 allScores（体积大，默认不保留）
 * @returns {{results:Array, stats:Object}}
 */
export function fuseMany(items, opts) {
  const o = opts || {};
  const engines = o.engines || ['mt', 'llm'];
  const list = Array.isArray(items) ? items : [];
  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  const stats = {
    total: 0,
    wins: {},               // 引擎 → 胜出条数
    bothFatal: 0,           // 有候选、但全部不可用
    noCandidate: 0,         // 这一行压根没有任何候选译文
    onlyOne: 0,             // 只有一个引擎给出可用译文
    tieBroken: 0,           // 分数接近、由优先级规则裁定
    numericFlagged: 0,      // 触发了数字/日期扣分（漏或错）
    numericConflict: 0,     // 数字/日期被**译错**（不是漏）
    withFacts: 0,           // 原文含数字/日期的句数
    termMiss: 0,            // 胜出译文仍然漏了术语
    scoreSum: 0,
    avgScore: 0,
    ms: 0
  };
  for (const e of engines) stats.wins[e] = 0;

  const results = [];
  for (const it of list) {
    if (!it) continue;
    stats.total++;
    const en = S(it.en);
    const cands = [];
    for (const e of engines) {
      const v = it[e];
      if (v != null && S(v).trim()) cands.push({ zh: S(v).trim(), from: e });
    }
    const terms = findTerms(en);
    const r = pickBest(en, cands, Object.assign({}, o, { terms }));

    const win = r.allScores.find(s => s.from === r.from && s.zh === r.zh);
    const facts = win ? (win.checks.numeric.facts || 0) : 0;
    if (facts > 0) stats.withFacts++;

    // 区分「两个模型都译坏了」和「这一行压根没有候选译文」——
    // 后者不该在小结里说成「两个模型都没给出可用译文」
    if (!r.zh) {
      if (!cands.length) stats.noCandidate++;
      else stats.bothFatal++;
    }
    else {
      if (stats.wins[r.from] == null) stats.wins[r.from] = 0;
      stats.wins[r.from]++;
      stats.scoreSum += r.score;
      if (win) {
        if (win.checks.numeric.missing.length) stats.numericFlagged++;
        if (win.checks.numeric.conflicts) stats.numericConflict++;
        if (win.checks.glossary.missing.length) stats.termMiss++;
      }
      const usable = r.allScores.filter(s => !s.fatal);
      if (usable.length === 1 && r.allScores.length > 1) stats.onlyOne++;
      else if (r.tie) stats.tieBroken++;
    }

    const row = {
      id: it.id,
      en,
      zh: r.zh,
      from: r.from,
      score: r.score,
      reason: r.reason,
      runnerUp: r.runnerUp,
      // pickBest 的平局标记要带出来：批量路径（结束 session 后重跑）同样需要
      // 让 UI 知道这条是靠优先级规则裁定的，可以提示「可切换到另一版」。
      tie: r.tie,
      terms: terms.length,
      facts
    };
    if (o.keepScores) row.allScores = r.allScores;
    results.push(row);
  }

  const won = stats.total - stats.bothFatal - stats.noCandidate;
  stats.avgScore = won ? Math.round((stats.scoreSum / won) * 10) / 10 : 0;
  const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  stats.ms = Math.round(t1 - t0);
  return { results, stats };
}

/* ===========================================================================
 * 六、explainStats —— 写给用户看的中文小结
 * ========================================================================= */

/**
 * @param {Object} stats fuseMany 返回的 stats
 * @param {Object} [names] 引擎显示名
 * @returns {string}
 */
export function explainStats(stats, names) {
  const s = stats || {};
  const n = names || ENGINE_NAMES;
  const total = s.total || 0;
  if (!total) return '这节课没有可以融合的句子。';

  const pct = v => (total ? Math.round((v / total) * 100) : 0);
  const parts = [];

  const wins = s.wins || {};
  const winLine = Object.keys(wins)
    .filter(k => wins[k] > 0)
    .sort((a, b) => wins[b] - wins[a])
    .map(k => (n[k] || k) + ' ' + wins[k] + ' 句（' + pct(wins[k]) + '%）')
    .join('、');

  parts.push('双模型对照完成，共 ' + total + ' 句。');
  if (winLine) parts.push('逐句取优的结果：' + winLine + '。');

  if (s.bothFatal) {
    parts.push('有 ' + s.bothFatal + ' 句两个模型都没给出可用译文（多半是识别本身就乱了），已留空等你手动确认。');
  }
  if (s.noCandidate) {
    parts.push('另有 ' + s.noCandidate + ' 句没有拿到任何译文（翻译可能没跑完），已留空。');
  }
  if (s.onlyOne) {
    parts.push('另有 ' + s.onlyOne + ' 句只有一个模型的译文能用，直接采用了它。');
  }
  if (s.withFacts) {
    parts.push('含数字或日期的句子 ' + s.withFacts + ' 句' +
      (s.numericConflict
        ? ('，其中 ' + s.numericConflict + ' 句即便是胜出的那一版也把时间/数字译得可疑，建议对照原文再看一眼。')
        : (s.numericFlagged
            ? ('，其中 ' + s.numericFlagged + ' 句胜出译文漏掉了部分数字，其余都对上了。')
            : '，全部对上了原文。')));
  }
  if (s.tieBroken) {
    parts.push(s.tieBroken + ' 句两边分数接近，按「有日期优先 opus-mt、长句优先 LLM」的规则裁定。');
  }
  if (s.termMiss) {
    parts.push('还有 ' + s.termMiss + ' 句的术语没被译成标准说法，已交给术语表做二次纠正。');
  }
  if (s.avgScore) parts.push('整体质量分 ' + s.avgScore + '/100。');
  if (s.ms != null) parts.push('耗时 ' + s.ms + ' 毫秒。');

  return parts.join('');
}

export default { scoreTranslation, pickBest, fuseMany, explainStats, WEIGHTS, ENGINE_NAMES, DEFAULTS };
