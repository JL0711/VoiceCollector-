// localnlp.js —— 纯离线（无 API Key、无网络）的课堂转写稿分析与中文笔记生成。
//
// 设计目标：用户不会去申请任何 API Key，所以「断网也能出一份能用的中文复习笔记」这条路必须做扎实。
// 这里不做词频抽句那种糊弄事，而是实打实做了 9 件事：
//   1. TextTiling 风格的主题切分（词汇衔接 + 滑动窗口余弦相似度 + 深度分数）
//   2. 定义句抽取（X is defined as / refers to / we call this ...）
//   3. 重点考点句（remember / important / on the exam ...）
//   4. 作业与截止日期（含日期、星期的抽取与中文化）
//   5. 枚举与步骤还原（first / second / step one / there are three reasons ...）
//   6. 公式与数字句（数学符号、单位、百分比、公式读法）
//   7. 术语表（对照内置常用词表做 TF-IDF 风格打分，不是裸词频）
//   8. 问答对（any questions / good question / yes, so ...）
//   9. 识别错误提示（重复词、碎片、低置信度、与高频术语只差 1~2 个字母的孤词）
//
// 全部纯 JS、无依赖、浏览器里直接跑。算法都是线性或近线性的，
// 1.5 小时的课（几千句、上万词）在普通笔记本上 < 1 秒。
//
// 对外只暴露两个函数（主协调者按此集成，勿改名）：
//   analyze(segments) -> 结构化分析结果
//   buildNotes(analysis, { ctx, translateFn }) -> Promise<Markdown 字符串>

import { mmss } from './util.js';

/* ============================== 内置词表 ============================== */

// 停用词：纯功能词 + 课堂口水词。这些词永远不会进术语表，也不参与主题相似度计算。
const STOP_WORDS = `
a about above across after again against all almost alone along already also although always am among an and another any
anybody anyone anything anyway are around as aside at away back be became because become becomes been before began begin
behind being below beside besides best better between beyond both but by came can cannot cant come comes coming could
couldnt did didnt do does doesnt doing done dont down during each either else enough especially etc even ever every
everybody everyone everything except far few finally for from further get gets getting give given go goes going gone got
had hadnt has hasnt have havent having he hed her here hers herself hes him himself his how however i id if im in indeed
instead into is isnt it its itself ive just keep kept let lets like likely little ll made make makes many may maybe me
mean means might mine more moreover most mostly much must my myself near need needs neither never nevertheless new next
no nobody none nor not nothing now of off often oh ok okay on once one only onto or other others otherwise ought our ours
ourselves out over own per perhaps please probably quite rather re really right said same saw say saying says see seem
seemed seems seen several shall she shes should shouldnt since so some somebody somehow someone something sometimes
somewhat soon still such sure take taken than that thats the their theirs them themselves then there thereby therefore
these they theyre theyve thing things think this those though through throughout thus to together too toward towards
under unless until up upon us usually ve very was wasnt way we well were werent weve what whatever when whenever where
whereas whether which while who whoever whom whose why will with within without wont would wouldnt yeah yep yes yet you
youd your yours yourself youre youve
um uh uhh er erm ah ahh hmm mhm huh gonna wanna gotta kinda sorta alright anyways basically actually literally obviously
essentially sort kind lot bit stuff guys folks everybody okay yknow
`.trim().split(/\s+/);
const STOP = new Set(STOP_WORDS);

// 英语常用词 / 课堂通用词：用来做 IDF 的「参照系」。
// 命中这里的词权重会被压低（不是清零——物理课的 force、经济课的 market 仍然要能冒出来），
// 没命中的词视为本节课特有的专业词汇，拿满权重。
const COMMON_WORDS = `
able add addition advance affect age ago agree air allow alone amount analysis analyze answer appear application apply
approach appropriate area argue argument arrive article ask assume attention author available average avoid
bad base basic beat beautiful become begin behavior believe benefit big black blood board body book bottom box boy break
bring brother build building business buy
call car care carry case catch cause center central century certain chance change character charge check chief child
choice choose church city civil claim clear close coach cold collection college color come commercial common community
company compare complete computer concern condition conference consider consumer contain continue contract control cost
country couple course cover create crime cultural culture current customer cut
dark data daughter day dead deal death debate decade decide decision deep defense degree democratic describe design
despite detail determine develop development die difference different difficult dinner direction director discover
discuss discussion disease do doctor dog door draw dream drive drop drug
early east easy eat economic economy edge education effect effort eight either election employee end energy engine
equal equals equation divided multiply multiplied versus approximately roughly plus minus point squared cubed
root power ratio sum total product value variable graph curve axis
english enjoy enter entire environment especially establish event ever evidence exactly example executive exist expect
experience expert explain eye
face fact factor fail fall family father fear federal feel feeling few field fight figure fill film final finally
financial find fine finger finish fire firm first fish five floor fly focus follow food foot football force foreign
forget form former forward four free friend from front full fund future
game garden gas general generation get girl give glass go goal good government great green ground group grow growth
guess gun guy
hair half hand hang happen happy hard head health hear heart heat heavy help her here herself high him himself his
history hit hold home hope hospital hot hotel hour house however huge human hundred husband
idea identify image imagine impact important improve include including increase indeed indicate individual industry
information inside instead institution interest international interview introduce investment involve issue item
job join judge jump just
keep key kid kill kitchen knowledge know
land language large last late later laugh law lawyer lay lead leader learn leave left leg legal less lesson let letter
level lie life light like likely limit line list listen little live local long look lose loss lot love low
machine magazine main maintain major majority make man manage management manager many market marriage material matter
may maybe mayor mean measure media medical meet meeting member memory mention message method middle might military
million mind minute miss mission model modern moment money month morning mother mouth move movement movie much music
must
name nation national natural nature near nearly necessary need network never new news newspaper next nice night none
north note nothing notice now number
occur offer office officer official often oil old once one only open operation opportunity option order organization
other others outside over own
page pain painting paper parent part participant particular particularly partner party pass past patient pattern pay
peace people per percent percentage perform performance perhaps period person personal phone physical pick picture piece place plan plant
play player point police policy political politics poor popular population position positive possible power practice
prepare present president press pressure pretty prevent price private probably problem process produce product
production professional professor program project property protect prove provide public pull purpose push put
quality question quick quickly quite
race radio raise range rate rather reach read ready real reality realize really reason receive recent recently recognize
record red reduce reflect region relate relationship religious remain remember remove report represent republican
require research resource respond response responsibility rest result return reveal rich right rise risk road rock role
room rule run
safe same save say scene school science scientist score sea season seat second section security seek seem sell send
senior sense series serious serve service set seven several sex shake share she shoot short shot should shoulder show
side sign significant similar simple simply since sing single sister sit site situation six size skill skin small smile
social society soldier solution some somebody someone something son song soon sort sound source south southern space
speak special specific speech spend sport spring staff stage stand standard star start state statement station stay step
still stock stop store story strategy street strong structure student study stuff style subject success successful such
suddenly suffer suggest summer support sure surface system
table take talk task tax teach teacher team technology television tell ten tend term test text than thank theory thing
think third thought thousand threat three throw thus time today together tonight top total tough toward town trade
traditional training travel treat treatment tree trial trip trouble true truth try turn tv type
understand union unit united university unless until upon us use usually
value various very victim video view violence visit voice vote
wait walk wall want war watch water way we wear week weight well west western whatever whether while white whole whom
whose wide wife will win wind window wish within without woman wonder word work worker working world worry would write
writer wrong
yard yeah year yes yet young
zero one two three four five six seven eight nine ten eleven twelve thirteen fifteen twenty thirty forty fifty sixty
seventy eighty ninety hundred thousand million billion half double triple once twice
lecture lecturer class classroom course chapter section slide slides syllabus semester quarter term homework assignment
assignments exam exams quiz quizzes midterm midterms final finals test tests problem problems set sets question
questions answer answers example examples note notes topic today tomorrow yesterday week weeks monday tuesday wednesday
thursday friday saturday sunday morning afternoon evening page pages read reading write writing due deadline submit
turn hand study review exercise exercises practice homework office hours
`.trim().split(/\s+/);
const COMMON = new Set(COMMON_WORDS);

// 星期 / 时间词的中文对照，用来把 deadline 变成中国学生一眼能懂的形式。
const CN_TIME = {
  monday: '周一', tuesday: '周二', wednesday: '周三', thursday: '周四',
  friday: '周五', saturday: '周六', sunday: '周日',
  today: '今天', tomorrow: '明天', tonight: '今晚', yesterday: '昨天',
  next: '下', this: '这', last: '上', coming: '下', week: '周', weeks: '周',
  month: '月', months: '月', day: '天', days: '天', semester: '学期',
  morning: '早上', afternoon: '下午', evening: '晚上', noon: '中午',
  midnight: '午夜', weekend: '周末', class: '上课前', end: '末',
  january: '1月', february: '2月', march: '3月', april: '4月', may: '5月', june: '6月',
  july: '7月', august: '8月', september: '9月', october: '10月', november: '11月', december: '12月',
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10'
};

const MONTHS = 'january february march april may june july august september october november december';
const WEEKDAYS = 'monday tuesday wednesday thursday friday saturday sunday';
const MO = MONTHS.split(' ').join('|');   // 正则用的「或」形式
const WD = WEEKDAYS.split(' ').join('|');

// 日期 / 截止时间的识别模板（顺序有意义：先长后短，避免「next friday」被拆成「friday」）
const DATE_PATTERNS = [
  new RegExp('\\b(?:next|this|last|coming|following)\\s+(?:' + WD + '|week|month|class|lecture|session)\\b', 'gi'),
  new RegExp('\\b(?:' + MO + ')\\s+\\d{1,2}(?:st|nd|rd|th)?\\b', 'gi'),
  new RegExp('\\b\\d{1,2}(?:st|nd|rd|th)\\s+of\\s+(?:' + MO + ')\\b', 'gi'),
  /\bin\s+(?:a|an|one|two|three|four|five|six|seven|ten|\d+)\s+(?:day|days|week|weeks|hour|hours|month|months)\b/gi,
  /\bend\s+of\s+(?:the\s+)?(?:week|month|day|semester|quarter|term|class)\b/gi,
  new RegExp('\\b(?:by|before|until|till|on)\\s+(?:the\\s+)?(?:next\\s+|this\\s+)?(?:' + WD + '|end\\s+of\\s+(?:the\\s+)?\\w+|midnight|noon|tonight|tomorrow|class|then)\\b', 'gi'),
  /\b(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|o'clock)\b/gi,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\b(?:tomorrow|tonight|this\s+weekend|two\s+weeks\s+from\s+now)\b/gi,
  new RegExp('\\b(?:' + WD + ')\\b', 'gi')
];

// 定义句模板：捕获组 1 = 术语，捕获组 2 = 定义主体（有的模板只有其一）
const DEF_PATTERNS = [
  // strong: 老师明确在下定义，术语可以是任何词
  { re: /\b(?:the\s+)?(?:formal\s+)?definition\s+of\s+(?:the\s+)?([a-z][\w'\- ]{2,40}?)\s+is\s+(.{8,240})/i, t: 1, d: 2, strong: true },
  { re: /\b([A-Za-z][\w'\- ]{2,40}?)\s+is\s+defined\s+as\s+(.{6,240})/i, t: 1, d: 2, strong: true },
  { re: /\b(?:this|that|it)\s+is\s+(?:what\s+we\s+call|called|known\s+as|referred\s+to\s+as)\s+(?:the\s+|a\s+|an\s+)?([a-z][\w'\- ]{2,40})/i, t: 1, d: 0, strong: true },
  { re: /\b(?:we\s+)?(?:define|call)\s+(?:this|that|it)\s*(?:as\s+)?(?:the\s+|a\s+|an\s+)?([a-z][\w'\- ]{2,40})/i, t: 1, d: 0, strong: true },
  { re: /\b(?:the\s+term|the\s+word|the\s+concept\s+of)\s+([a-z][\w'\- ]{2,40}?)\s+(?:means|describes|is\s+used\s+for|refers\s+to)\s+(.{6,240})/i, t: 1, d: 2, strong: true },
  { re: /\b([A-Za-z][\w'\- ]{2,40}?)\s+refers?\s+to\s+(.{6,240})/i, t: 1, d: 2, strong: true },
  { re: /\b([A-Za-z][\w'\- ]{2,40}?)\s+means\s+(?:that\s+)?(.{6,240})/i, t: 1, d: 2, strong: true },
  { re: /\b(?:what\s+we\s+mean\s+by|by)\s+([a-z][\w'\- ]{2,40}?)\s+(?:we\s+mean|is\s+meant)\s+(.{6,240})/i, t: 1, d: 2, strong: true },
  // weak: 「a X is a Y」这类句式太常见，术语必须像专业词才收
  { re: /\b([A-Za-z][\w'\- ]{2,40}?)\s+is\s+(?:the\s+)?(?:measure|ratio|rate|amount|process|study|idea|concept|principle|law|theory|fraction|share)\s+(?:of|that|where|which)\s+(.{6,240})/i, t: 1, d: 2, strong: false },
  { re: /\b(?:an?|the)\s+([a-z][\w'\- ]{2,40}?)\s+is\s+(?:an?|the)\s+(.{8,240})/i, t: 1, d: 2, strong: false }
];

// 强调 / 考点标记词（权重代表「有多像考点」）
const EMPHASIS_MARKERS = [
  { re: /\b(?:will\s+be|is|are|show(?:s)?\s+up)\s+on\s+the\s+(?:exam|test|midterm|final|quiz)\b/i, w: 3.0, tag: '考点' },
  { re: /\b(?:this|that|it)\s+(?:will|is\s+going\s+to)\s+(?:be\s+)?(?:on|in)\s+the\s+(?:exam|test|midterm|final)\b/i, w: 3.0, tag: '考点' },
  { re: /\bexam\s+question\b|\btest\s+question\b|\bfair\s+game\b/i, w: 2.6, tag: '考点' },
  { re: /\b(?:remember|memorize|don'?t\s+forget|keep\s+in\s+mind|bear\s+in\s+mind)\b/i, w: 2.2, tag: '要记住' },
  { re: /\b(?:very\s+)?(?:important|crucial|critical|essential|fundamental|the\s+key|key\s+(?:point|idea|thing|concept)|main\s+point|takeaway|take\s+away)\b/i, w: 2.0, tag: '重点' },
  { re: /\b(?:note\s+that|notice\s+that|pay\s+attention|be\s+careful|watch\s+out|a\s+common\s+mistake|students?\s+(?:often|always)\s+(?:get|mess|confuse))\b/i, w: 2.0, tag: '易错' },
  { re: /\b(?:make\s+sure|you\s+(?:need|have)\s+to|i\s+want\s+you\s+to|you\s+should\s+(?:all\s+)?(?:know|be\s+able)|be\s+able\s+to)\b/i, w: 1.8, tag: '要求' },
  { re: /\b(?:the\s+(?:whole|entire)\s+point|what\s+matters\s+(?:here|most)|if\s+you\s+(?:only\s+)?remember\s+one\s+thing|bottom\s+line)\b/i, w: 2.4, tag: '重点' },
  { re: /\b(?:this\s+is\s+(?:really|the)\s+(?:the\s+)?(?:core|heart|crux))\b/i, w: 2.0, tag: '重点' }
];

// 作业 / 考试 / 阅读任务
const TASK_PATTERNS = [
  { re: /\b(?:problem\s+set|p\.?\s?set|pset)\s*#?\s*\d*/i, tag: '习题集' },
  { re: /\bhomework\b|\bhw\s*#?\s*\d*/i, tag: '作业' },
  { re: /\bassignment\b|\bessay\b|\bpaper\s+(?:is\s+)?due\b|\bwrite[-\s]?up\b/i, tag: '作业' },
  { re: /\b(?:read|reading)\s+(?:chapter|chapters|ch\.?|section|pages?|pp\.?)\s*\d+/i, tag: '阅读' },
  { re: /\bquiz\b/i, tag: '小测' },
  { re: /\bmidterm\b/i, tag: '期中考' },
  { re: /\bfinal\s+(?:exam|test)\b|\bfinals\b/i, tag: '期末考' },
  { re: /\bexam\b|\btest\s+(?:is|will|on)\b/i, tag: '考试' },
  { re: /\b(?:due|deadline|submit|hand\s+in|turn\s+in|upload|post\s+it)\b/i, tag: '截止' },
  { re: /\blab\s+report\b|\bproject\s+(?:is\s+)?due\b|\bpresentation\b/i, tag: '项目' },
  { re: /\boffice\s+hours?\b/i, tag: 'Office Hour' }
];

// 枚举 / 步骤标记
const ORDINAL_WORDS = {
  first: 1, firstly: 1, second: 2, secondly: 2, third: 3, thirdly: 3, fourth: 4, fourthly: 4,
  fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  finally: 99, lastly: 99, last: 99
};
const COUNT_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// 公式 / 数字句的信号
const MATH_SYMBOL = /[=＝+×÷≤≥≈≠∑∫√π∞^%]|\b\d+\s*\/\s*\d+\b/;
const MATH_WORDS = /\b(?:squared|cubed|square\s+root|cube\s+root|divided\s+by|multiplied\s+by|times|equals?|equal\s+to|plus|minus|to\s+the\s+power|exponent|logarithm|log\s+of|derivative|integral|sum\s+of|delta|sigma|percent|percentage\s+change|percentage|ratio|proportional\s+to|inversely\s+proportional|per\s+(?:unit|second|hour|kilogram|meter)|formula|equation|denominator|numerator|absolute\s+value|average\s+of)\b/gi;
// 读出来的数字：ten percent / zero point four / a hundred cups
const NUM_SPELLED = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand|half|point)\b/i;
const UNIT_WORDS = /\b\d+(?:\.\d+)?\s*(?:%|percent|kg|kilograms?|grams?|km|kilometers?|meters?|m\/s|m\/s2|cm|mm|seconds?|minutes?|hours?|hz|hertz|volts?|amps?|ohms?|joules?|newtons?|watts?|degrees?|celsius|dollars?|euros?|units?)\b/i;

// 问答标记
const Q_MARKERS = /\b(?:i\s+have\s+a\s+question|quick\s+question|can\s+you\s+(?:explain|repeat|clarify|go\s+over)|could\s+you\s+(?:explain|repeat)|sorry,?\s+(?:can|could))\b/i;
// 老师的「还有问题吗」只是招呼语，不是内容，单独识别后丢掉
const Q_SMALLTALK = /\b(?:any\s+questions?|does\s+that\s+make\s+sense|everyone\s+(?:okay|with\s+me)|make\s+sense\?)/i;
const Q_ACK = /^(?:yes|yeah|right|okay|sure|exactly|good\s+question|great\s+question|uh\s+huh)[\s,.!？?]*$/i;
const A_MARKERS = /\b(?:good\s+question|great\s+question|that'?s\s+a\s+(?:good|great|fair)\s+(?:question|point)|yes,?\s+so\b|right,?\s+so\b|exactly,?\s+(?:so|and)|the\s+answer\s+is)\b/i;

/* ============================== 基础工具 ============================== */

/** 极简词干化：只处理最常见的复数 / 时态，够做词汇衔接用。 */
function stem(w) {
  if (w.length <= 4) return w;
  if (w.endsWith('ies') && w.length > 5) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses') || w.endsWith('shes') || w.endsWith('ches')) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 6) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 5) return w.slice(0, -2);
  return w;
}

/** 取出英文单词（保留大小写信息由调用方自己判断）。 */
function tokens(text) {
  return String(text || '').toLowerCase().match(/[a-z][a-z'’\-]*[a-z]|[a-z]/g) || [];
}

function wordCount(text) {
  const m = String(text || '').match(/[A-Za-z0-9'’\-]+/g);
  return m ? m.length : 0;
}

/** 把一个词的「稀有度」映射成权重：停用词 0，常用词 0.22，其余 1。 */
function rarity(w) {
  if (STOP.has(w) || w.length < 3) return 0;
  if (COMMON.has(w) || COMMON.has(stem(w))) return 0.22;
  return w.length >= 9 ? 1.15 : 1;
}

/** 有上界的编辑距离（超过 max 立刻放弃），用来找「只差一两个字母」的疑似听错词。 */
function editDistance(a, b, max) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    let best = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[lb];
}

/** 稀疏向量余弦相似度（传入 Map<string, number>）。 */
function cosine(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, v] of small) { const u = big.get(k); if (u) dot += v * u; }
  if (!dot) return 0;
  let na = 0, nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function titleCase(s) {
  return String(s || '').replace(/\b[a-z]/g, c => c.toUpperCase());
}

function cleanPhrase(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/^[\s,;:.\-—]+|[\s,;:.\-—]+$/g, '').trim();
}

function trimTail(s, n) {
  const t = cleanPhrase(s);
  if (t.length <= n) return t;
  return t.slice(0, n).replace(/\s+\S*$/, '') + '…';
}

/* ============================== 句子切分 ============================== */

/**
 * 把 segments 摊平成句子数组。
 * ASR 出来的段落不一定有标点，所以既按句末标点切，也对超长无标点的段做软切分。
 */
function toSentences(segments) {
  const out = [];
  for (const seg of segments) {
    if (!seg || seg.kind === 'mark') continue;
    const raw = String(seg.text || '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    const t0 = Number(seg.t) || 0;
    // 段内时间插值：有 end / dur 就按字符比例摊开，没有就全部算在段首
    const span = Number(seg.end != null ? seg.end - t0 : seg.dur || seg.durationMs || 0) || 0;
    const conf = seg.conf != null ? Number(seg.conf)
      : seg.confidence != null ? Number(seg.confidence) : null;

    let parts = raw.split(/(?<=[.!?。！？])\s+/);
    const soft = [];
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      if (wordCount(s) <= 45) { soft.push(s); continue; }
      // 没标点的长段：按逗号 / 连接词软切，避免一句话吞掉半节课
      let buf = '';
      for (const chunk of s.split(/(?<=,)\s+|\s+(?=(?:and then|but then|so then|however|okay so|alright so)\b)/i)) {
        buf = buf ? buf + ' ' + chunk : chunk;
        if (wordCount(buf) >= 28) { soft.push(buf.trim()); buf = ''; }
      }
      if (buf.trim()) soft.push(buf.trim());
    }
    // 兜底硬切：有的 ASR 整段不给任何标点（连逗号都没有），软切会切不动，
    // 一句话吞掉几百个词之后后面所有打分/摘要都废了，所以按词数强行断开。
    const pieces = [];
    for (const s of soft) {
      if (wordCount(s) <= 60) { pieces.push(s); continue; }
      const ws = s.split(/\s+/);
      for (let k = 0; k < ws.length; k += 30) pieces.push(ws.slice(k, k + 30).join(' '));
    }

    const totalChars = pieces.reduce((n, p) => n + p.length, 0) || 1;
    let acc = 0;
    let firstPiece = true;
    for (const text of pieces) {
      const t = span > 0 ? Math.round(t0 + span * (acc / totalChars)) : t0;
      acc += text.length;
      // segment 自带的中文挂在本段的第一句上（原来写的是 out.length === 0，
      // 结果只有整节课的第一句能拿到 zh，其余多句段的中文全被丢掉、白白多跑本地翻译）
      const useZh = firstPiece;
      firstPiece = false;
      out.push({
        i: out.length,
        t,
        text,
        zh: useZh ? (seg.zh || '') : '',
        segId: seg.id,
        kind: seg.kind || 'asr',
        conf,
        words: wordCount(text)
      });
    }
  }
  return out;
}

/* ============================== 主题切分（TextTiling） ============================== */

/**
 * TextTiling：把词流切成伪句块，比较左右窗口的词汇重合度，
 * 相似度的「谷底 + 深度」就是主题边界。复杂度 O(词数)。
 */
function detectTopics(sents, termWeight) {
  const n = sents.length;
  if (n === 0) return [];
  // 句子少的时候不折腾，按时间均分
  if (n < 24) {
    const k = Math.max(1, Math.min(3, Math.ceil(n / 8)));
    const res = [];
    for (let i = 0; i < k; i++) {
      res.push({ start: Math.floor(n * i / k), end: Math.floor(n * (i + 1) / k) - 1 });
    }
    return res.filter(s => s.end >= s.start);
  }

  // 1) 词流（去停用词、词干化），记录每个词属于哪一句
  const flow = [];
  for (let i = 0; i < n; i++) {
    for (const w of tokens(sents[i].text)) {
      if (STOP.has(w) || w.length < 3) continue;
      flow.push({ w: stem(w), i });
    }
  }
  if (flow.length < 200) {
    const k = Math.max(2, Math.min(6, Math.round(n / 20)));
    const res = [];
    for (let i = 0; i < k; i++) res.push({ start: Math.floor(n * i / k), end: Math.floor(n * (i + 1) / k) - 1 });
    return res.filter(s => s.end >= s.start);
  }

  // 2) 伪句块
  const W = 20;                              // 每个伪句 20 个内容词
  const K = Math.max(4, Math.min(8, Math.round(flow.length / W / 12))); // 窗口块数
  const nps = Math.floor(flow.length / W);
  if (nps < 2 * K + 2) {
    const k = Math.max(2, Math.min(6, Math.round(n / 20)));
    const res = [];
    for (let i = 0; i < k; i++) res.push({ start: Math.floor(n * i / k), end: Math.floor(n * (i + 1) / k) - 1 });
    return res.filter(s => s.end >= s.start);
  }
  const ps = [];
  for (let b = 0; b < nps; b++) {
    const m = new Map();
    for (let j = b * W; j < (b + 1) * W; j++) {
      const w = flow[j].w;
      m.set(w, (m.get(w) || 0) + (termWeight.get(w) || 0.4));
    }
    ps.push(m);
  }

  // 3) 每个块间隙算左右窗口相似度
  const sim = new Array(nps).fill(1);
  for (let g = K; g <= nps - K; g++) {
    const L = new Map(), R = new Map();
    for (let b = g - K; b < g; b++) for (const [k2, v] of ps[b]) L.set(k2, (L.get(k2) || 0) + v);
    for (let b = g; b < g + K; b++) for (const [k2, v] of ps[b]) R.set(k2, (R.get(k2) || 0) + v);
    sim[g] = cosine(L, R);
  }

  // 4) 平滑
  const sm = sim.slice();
  for (let g = K + 1; g < nps - K; g++) sm[g] = (sim[g - 1] + 2 * sim[g] + sim[g + 1]) / 4;

  // 5) 谷底 + 深度分数
  const cands = [];
  for (let g = K + 1; g < nps - K; g++) {
    if (!(sm[g] <= sm[g - 1] && sm[g] <= sm[g + 1])) continue;
    let l = sm[g]; for (let x = g - 1; x >= K && sm[x] >= l; x--) l = sm[x];
    let r = sm[g]; for (let x = g + 1; x <= nps - K && sm[x] >= r; x++) r = sm[x];
    cands.push({ g, depth: (l - sm[g]) + (r - sm[g]) });
  }
  if (!cands.length) return [{ start: 0, end: n - 1 }];
  const mean = cands.reduce((a, c) => a + c.depth, 0) / cands.length;
  const sd = Math.sqrt(cands.reduce((a, c) => a + (c.depth - mean) ** 2, 0) / cands.length);
  const thr = mean - sd * 0.25;   // TextTiling 常用 mean - sd/2，这里略保守

  // 6) 边界落回句子下标；主题数量与最短长度都做限制，别切得太碎
  const maxTopics = Math.max(3, Math.min(12, Math.round(n / 14)));
  // 目标段数：一节课大约每 22 句一个主题。整节课话题很集中时（比如通篇讲同一个概念），
  // 阈值法可能一个边界都挑不出来，这时退而求其次按「深度排序」补齐，保证脉络不会只有一坨。
  const target = Math.max(2, Math.min(maxTopics, Math.round(n / 22)));
  const minLen = Math.max(5, Math.floor(n / (maxTopics * 2)));
  const strong = cands.filter(c => c.depth >= thr).sort((a, b) => b.depth - a.depth);
  const rest = cands.filter(c => c.depth < thr && c.depth > 0).sort((a, b) => b.depth - a.depth);
  const bounds = [];
  const tryPush = (c, limit) => {
    if (bounds.length >= limit - 1) return;
    const si = flow[Math.min(flow.length - 1, c.g * W)].i;
    if (si <= minLen || si >= n - minLen) return;
    if (bounds.some(b => Math.abs(b - si) < minLen)) return;
    bounds.push(si);
  };
  for (const c of strong) tryPush(c, maxTopics);
  for (const c of rest) { if (bounds.length >= target - 1) break; tryPush(c, target); }
  bounds.sort((a, b) => a - b);

  const topics = [];
  let start = 0;
  for (const b of bounds.concat([n])) {
    if (b - start <= 0) continue;
    topics.push({ start, end: b - 1 });
    start = b;
  }
  return topics.length ? topics : [{ start: 0, end: n - 1 }];
}

/* ============================== 术语打分 ============================== */

/**
 * TF-IDF 风格的术语抽取：tf 用对数压缩，idf 用「是否在内置常用词表里」做代理，
 * 再叠加三个加分项：出现在定义句里、句中大写（专有名词）、稳定的二元搭配。
 */
function extractTerms(sents, defHintSet) {
  const tf = new Map();          // stem -> 次数
  const surface = new Map();     // stem -> 最常见的原始写法
  const capHits = new Map();     // stem -> 句中大写次数
  const bi = new Map();          // "a b" -> 次数
  const acro = new Map();        // stem -> Map(原始写法 -> 次数)：只记 ATP / NADH / CoA 这种内部带大写的缩写

  for (const s of sents) {
    const rawWords = String(s.text).match(/[A-Za-z][A-Za-z'’\-]*/g) || [];
    let prev = null;
    for (let k = 0; k < rawWords.length; k++) {
      const raw = rawWords[k];
      const w = raw.toLowerCase();
      if (STOP.has(w) || w.length < 3) { prev = null; continue; }
      const st = stem(w);
      tf.set(st, (tf.get(st) || 0) + 1);
      const cur = surface.get(st);
      if (!cur || w.length < cur.length) surface.set(st, w);
      if (k > 0 && /^[A-Z]/.test(raw)) capHits.set(st, (capHits.get(st) || 0) + 1);
      if (/[A-Z]/.test(raw.slice(1))) {                    // ATP / NADH / CoA / DNA
        let mm = acro.get(st);
        if (!mm) { mm = new Map(); acro.set(st, mm); }
        mm.set(raw, (mm.get(raw) || 0) + 1);
      }
      if (prev) { const key = prev + ' ' + st; bi.set(key, (bi.get(key) || 0) + 1); }
      prev = st;
    }
  }

  // 展示用写法：缩写要保持原样（ATP 不能写成 Atp、NADH 不能写成 Nadh），
  // 打分仍然用小写的 surface，免得影响停用词 / 常用词判断。
  const display = new Map();
  for (const [st, c] of tf) {
    const mm = acro.get(st);
    let best = '', bc = 0;
    if (mm) for (const [f, n] of mm) if (n > bc) { bc = n; best = f; }
    display.set(st, (bc >= Math.max(2, c * 0.5)) ? best : (surface.get(st) || st));
  }
  const disp = st => display.get(st) || surface.get(st) || st;

  // 单词打分
  const scored = [];
  for (const [st, c] of tf) {
    const r = rarity(surface.get(st) || st);
    if (r <= 0) continue;
    let sc = (1 + Math.log(c)) * r;
    if (capHits.get(st) >= Math.max(2, c * 0.4)) sc *= 1.35;   // 专有名词
    if (defHintSet && defHintSet.has(st)) sc *= 2.2;           // 老师专门下过定义
    if (c === 1) sc *= 0.45;                                    // 只出现一次的先压一压
    scored.push({ key: st, term: disp(st), count: c, score: sc, n: 1 });
  }

  // 二元短语打分：只有两词一起出现的比例够高才算一个术语
  for (const [key, c] of bi) {
    if (c < 2) continue;
    const [a, b] = key.split(' ');
    const ca = tf.get(a) || 1, cb = tf.get(b) || 1;
    const cohesion = c / Math.min(ca, cb);
    if (cohesion < 0.55) continue;
    const sa = surface.get(a) || a, sb = surface.get(b) || b;
    const aCommon = COMMON.has(sa) || COMMON.has(a);
    const bCommon = COMMON.has(sb) || COMMON.has(b);
    if (aCommon && bCommon) continue;           // ten percent 这种没信息量
    if ((aCommon || bCommon) && c < 3) continue; // 一半常用词的搭配，出现少就不算术语
    const r = Math.max(rarity(sa), rarity(sb));
    if (r <= 0) continue;
    const sc = (1 + Math.log(c)) * r * 1.7;
    scored.push({
      key, term: disp(a) + ' ' + disp(b),
      count: c, score: sc, n: 2, parts: [a, b]
    });
  }

  scored.sort((x, y) => y.score - x.score);

  // 去重：二元短语已经收了，就把被它吃掉的单词降下去
  // 原来的判断是 it.count <= tf.get(it.key) * 1.0 —— 这两个值永远相等，条件恒为真，等于没去重，
  // 于是「Carbon Dioxide」和「Carbon」、「Transport Chain」和「Chain」会一起塞进术语表。
  // 改成跟「短语出现次数」比：单词基本只在短语里出现就不单列，单词自己活跃才保留。
  const phraseCount = new Map();
  for (const it of scored) {
    if (it.n !== 2 || it.score <= 1.4) continue;
    it.parts.forEach(p => phraseCount.set(p, Math.max(phraseCount.get(p) || 0, it.count)));
  }
  const final = [];
  const seen = new Set();
  for (const it of scored) {
    if (seen.has(it.key)) continue;
    if (it.n === 1 && phraseCount.has(it.key) && it.count <= phraseCount.get(it.key) * 1.5) continue;
    seen.add(it.key);
    final.push(it);
    if (final.length >= 60) break;
  }
  return { terms: final, tf, surface, display };
}

/* ============================== 各类抽取 ============================== */

function extractDefinitions(sents) {
  const out = [];
  const seen = new Set();
  for (const s of sents) {
    if (s.words < 5) continue;
    for (const p of DEF_PATTERNS) {
      const m = s.text.match(p.re);
      if (!m) continue;
      let term = cleanPhrase(m[p.t] || '');
      // 把「the / a / an / this」之类的前缀、以及结尾的副词剥掉
      term = term.replace(/^(?:the|a|an|this|that|these|those|our|its|some|any|each|every)\s+/i, '')
                 .replace(/\s+(?:here|there|now|today|again|too|also|then|really)$/i, '').trim();
      if (!term || term.length < 3 || term.length > 42) continue;
      const tw = term.toLowerCase().split(/\s+/);
      if (tw.length > 4) continue;
      if (STOP.has(term.toLowerCase())) continue;
      if (!p.strong) {
        // 弱模板：术语里不能夹停用词/数字，且至少要有一个「不常见」的词，否则全是 the good / two curves 这种噪音
        if (tw.some(w => STOP.has(w) || /^\d/.test(w) || COUNT_WORDS[w])) continue;
        if (!tw.some(w => !COMMON.has(w) && !COMMON.has(stem(w)))) continue;
      }
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        i: s.i, t: s.t, term,
        def: p.d ? trimTail(m[p.d], 200) : '',
        text: s.text, zh: s.zh || ''
      });
      break;
    }
  }
  return out;
}

function extractEmphasis(sents) {
  const out = [];
  for (const s of sents) {
    if (s.words < 4) continue;
    let w = 0, tag = '';
    for (const m of EMPHASIS_MARKERS) {
      if (m.re.test(s.text)) { if (m.w > w) { w = m.w; tag = m.tag; } }
    }
    if (!w) continue;
    out.push({ i: s.i, t: s.t, text: s.text, zh: s.zh || '', weight: w, tag });
  }
  out.sort((a, b) => b.weight - a.weight || a.t - b.t);
  return out;
}

function chineseDate(raw) {
  const low = raw.toLowerCase();
  let zh = low;
  // in two weeks / in 3 days
  let m = low.match(/^in\s+(a|an|one|two|three|four|five|six|seven|ten|\d+)\s+(day|days|week|weeks|hour|hours|month|months)$/);
  if (m) {
    const num = /^\d+$/.test(m[1]) ? m[1] : (CN_TIME[m[1]] || '1');
    const unit = m[2].startsWith('day') ? '天' : m[2].startsWith('week') ? '周' : m[2].startsWith('hour') ? '小时' : '个月';
    return num + unit + '后';
  }
  m = low.match(/^(next|this|last|coming|following)\s+(\w+)$/);
  if (m) {
    const pre = m[1] === 'last' ? '上' : m[1] === 'this' ? '这' : '下';
    const unit = CN_TIME[m[2]] || m[2];
    if (WEEKDAYS.includes(m[2])) return (m[1] === 'this' ? '本' : pre) + '周' + unit.replace('周', '');
    if (m[2] === 'week') return pre + '周';
    if (m[2] === 'month') return pre + '个月';
    if (m[2] === 'class' || m[2] === 'lecture' || m[2] === 'session') return pre + '次课';
    return pre + unit;
  }
  m = low.match(new RegExp('^(' + MO + ')\\s+(\\d{1,2})'));
  if (m) return (CN_TIME[m[1]] || m[1]) + m[2] + '日';
  m = low.match(new RegExp('^(\\d{1,2})(?:st|nd|rd|th)\\s+of\\s+(' + MO + ')'));
  if (m) return (CN_TIME[m[2]] || m[2]) + m[1] + '日';
  m = low.match(/^(by|before|until|till|on)\s+(.+)$/);
  if (m) {
    const inner = chineseDate(m[2]);
    return m[1] === 'on' ? inner : inner + '之前';
  }
  m = low.match(/^end\s+of\s+(?:the\s+)?(\w+)$/);
  if (m) return (CN_TIME[m[1]] || m[1]) + '末';
  m = low.match(/^(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'clock)?$/);
  if (m) {
    const ap = (m[3] || '').startsWith('p') ? '下午' : (m[3] || '').startsWith('a') ? '上午' : '';
    return ap + m[1] + '点' + (m[2] ? m[2] + '分' : '');
  }
  if (/^\d{1,2}\/\d{1,2}/.test(low)) {
    const [a, b] = low.split('/');
    return Number(a) + '月' + Number(b) + '日';
  }
  if (low === 'this weekend') return '这个周末';
  if (CN_TIME[low]) return WEEKDAYS.includes(low) ? CN_TIME[low] : CN_TIME[low];
  return raw;
}

function extractDates(text) {
  const found = [];
  const taken = [];
  for (const re of DATE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const a = m.index, b = m.index + m[0].length;
      if (taken.some(([x, y]) => a < y && b > x)) continue;   // 已被更长的模板吃掉
      taken.push([a, b]);
      const raw = cleanPhrase(m[0]);
      found.push({ raw, zh: chineseDate(raw), at: a });
      if (found.length >= 4) { found.sort((x, y) => x.at - y.at); return found; }
    }
  }
  found.sort((x, y) => x.at - y.at);   // 模板是先长后短扫的，要按句子里的先后还原
  return found;
}

function extractTasks(sents) {
  const out = [];
  for (const s of sents) {
    if (s.words < 4) continue;
    const tags = [];
    for (const p of TASK_PATTERNS) if (p.re.test(s.text)) tags.push(p.tag);
    if (!tags.length) continue;
    // 只命中「截止」但没有任何作业名词的，多半是口语「due to」，过滤掉
    if (tags.length === 1 && tags[0] === '截止' && /\bdue\s+to\b/i.test(s.text)) continue;
    const dates = extractDates(s.text);
    // 只是顺口提了一句 exam / midterm（没有时间、没有范围），属于考点不属于待办，交给「重点」小节去管
    const examOnly = tags.every(x => x === '考试' || x === '期中考' || x === '期末考');
    if (examOnly && !dates.length &&
        !/\b(?:covers?|is\s+on|will\s+be\s+held|scheduled|worth|points|bring|closed\s+book|open\s+book|review\s+session|format)\b/i.test(s.text)) continue;
    out.push({
      i: s.i, t: s.t, text: s.text, zh: s.zh || '',
      tags: [...new Set(tags)],
      dates,
      urgent: dates.length > 0 || /\b(due|deadline|submit|hand\s+in|turn\s+in)\b/i.test(s.text)
    });
  }
  return out;
}

function extractEnumerations(sents) {
  // 1) 找出所有带序数标记的句子
  const marks = [];
  for (const s of sents) {
    const head = s.text.slice(0, 60).toLowerCase();
    let ord = 0, label = '';
    // 前面的 (?<!…) 是为了挡掉「two point five」这种读出来的小数：
    // 不加的话 "point five" 会被当成「第 5 点」，把一条数字句塞进步骤列表里。
    let m = head.match(/(?<!\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|\d{1,4})\s)\b(?:step|number|point|part|reason|rule|case|type)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/);
    // COUNT_WORDS 里没有 one（它是给「there are two/three…」用的），
    // 直接查会让「step one / reason one」这种第一条永远丢掉，所以单独兜一下。
    if (m) { ord = (m[1] === 'one' ? 1 : COUNT_WORDS[m[1]]) || Number(m[1]) || 0; label = m[0]; }
    if (!ord) {
      m = head.match(/(?:^|,\s*)(?:and\s+|then\s+|so\s+|okay,?\s+|alright,?\s+|now,?\s+)?(first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth(?:ly)?|fifth|sixth|seventh|eighth|ninth|tenth|finally|lastly)\b/);
      if (m) { ord = ORDINAL_WORDS[m[1]] || 0; label = m[1]; }
    }
    if (!ord) {
      m = head.match(/\bthe\s+(first|second|third|fourth|fifth)\s+(?:one|thing|reason|step|point|type|kind|way|is)\b/);
      if (m) { ord = ORDINAL_WORDS[m[1]] || 0; label = m[0]; }
    }
    if (ord) marks.push({ s, ord, label });
  }
  if (marks.length < 2) return [];

  // 2) 找触发句：「there are three reasons / we have two cases」
  const triggers = [];
  for (const s of sents) {
    const m = s.text.match(/\b(?:there\s+are|we\s+have|i'?ll\s+give\s+you|let'?s\s+look\s+at|there\s+is)\s+(two|three|four|five|six|\d+)\s+([a-z][a-z\- ]{2,55}?)(?=[,.;:]|$)/i);
    if (m) triggers.push({ i: s.i, t: s.t, count: COUNT_WORDS[m[1].toLowerCase()] || Number(m[1]) || 0, what: cleanPhrase(m[2]), text: s.text });
  }

  // 3) 把序数标记聚成组（同组内序号递增、句距不超过 30 句）
  const groups = [];
  let cur = [];
  for (const mk of marks) {
    if (!cur.length) { cur = [mk]; continue; }
    const prev = cur[cur.length - 1];
    const close = mk.s.i - prev.s.i <= 30;
    const rising = mk.ord > prev.ord || mk.ord === 99;
    if (close && rising) cur.push(mk);
    else { if (cur.length >= 2) groups.push(cur); cur = [mk]; }
  }
  if (cur.length >= 2) groups.push(cur);

  return groups.map(g => {
    const firstI = g[0].s.i;
    const trg = triggers.filter(x => x.i <= firstI && firstI - x.i <= 6).pop();
    let title = trg ? trimTail(trg.what, 40) : '';
    if (!title) {
      const prev = sents[Math.max(0, firstI - 1)];
      title = prev ? trimTail(prev.text, 60) : '课堂分点';
    }
    return {
      t: g[0].s.t,
      title,
      count: trg ? trg.count : g.length,
      items: g.map((mk, k) => ({
        i: mk.s.i, t: mk.s.t,
        ord: mk.ord === 99 ? g.length : (k + 1),
        text: trimTail(mk.s.text, 180),
        zh: mk.s.zh || ''
      }))
    };
  }).filter(g => g.items.length >= 2).slice(0, 6);
}

function extractFormulas(sents) {
  const out = [];
  for (const s of sents) {
    MATH_WORDS.lastIndex = 0;
    const hits = (s.text.match(MATH_WORDS) || []).length;
    const hasSym = MATH_SYMBOL.test(s.text);
    const hasUnit = UNIT_WORDS.test(s.text);
    const hasNum = /\d/.test(s.text) || NUM_SPELLED.test(s.text);
    let score = 0;
    if (hasSym) score += 2;
    score += Math.min(3, hits) * 1.1;
    if (hasUnit) score += 1.2;
    if (hasNum && (hits > 0 || hasSym)) score += 0.9;
    if (/\b(?:formula|equation|derive|derivation|proof|solve\s+for|plug\s+in|compute|calculate)\b/i.test(s.text)) score += 1.3;
    // 「我会发一张公式纸」这种只是提到 formula，没有任何数字、符号、也没有第二个数学词，不是公式句
    if (!hasSym && !/\d/.test(s.text) && hits < 2) continue;
    if (score < 2.2) continue;
    if (s.words < 4) continue;
    out.push({ i: s.i, t: s.t, text: s.text, zh: s.zh || '', score });
  }
  out.sort((a, b) => b.score - a.score || a.t - b.t);
  return out;
}

function extractQA(sents) {
  const out = [];
  for (let k = 0; k < sents.length; k++) {
    const s = sents[k];
    if (Q_SMALLTALK.test(s.text)) continue;
    const isQ = Q_MARKERS.test(s.text) || (/\?\s*$/.test(s.text.trim()) && s.words >= 4);
    if (!isQ) continue;
    // 往后最多看 5 句找回答；「Good question.」这种应答词跳过，取真正的内容句
    let ans = null;
    for (let j = k + 1; j <= Math.min(sents.length - 1, k + 5); j++) {
      const c = sents[j];
      if (Q_ACK.test(c.text.trim()) || c.words < 7) continue;
      if (/\?\s*$/.test(c.text.trim())) continue;
      ans = c; break;
    }
    out.push({
      t: s.t,
      q: { t: s.t, text: trimTail(s.text, 180), zh: s.zh || '' },
      a: ans ? { t: ans.t, text: trimTail(ans.text, 220), zh: ans.zh || '' } : null
    });
    if (ans) k = ans.i;   // 直接用句子下标，别用 indexOf（会变成 O(n²)）
  }
  // 只留有回答的、且问句本身像个问题的
  return out.filter(x => x.a).slice(0, 8);
}

function detectSuspects(sents, topTerms, tf) {
  const out = [];
  const seenIdx = new Set();
  const push = (s, reason, detail) => {
    // 同一句同一种原因只报一次；不同原因（既有「the the」又有听错的术语）分别报，信息不一样
    const k = s.i + '|' + reason;
    if (out.length >= 14 || seenIdx.has(k)) return;
    seenIdx.add(k);
    out.push({ i: s.i, t: s.t, text: trimTail(s.text, 160), reason, detail: detail || '' });
  };
  // 只有语音识别出来的句子才可能「听错」；用户自己在课上敲的笔记（kind: note）不算，
  // 以前会把中文笔记当成「不成句的碎片」报出来，用户看了只会一脸问号。
  const isAsr = s => s.kind === 'asr' && /[A-Za-z]/.test(s.text);

  // A) 重复词 / 重复短语 / 碎片
  for (const s of sents) {
    if (!isAsr(s)) continue;
    const rep = s.text.match(/\b([A-Za-z]{3,})\s+\1\b/i);
    if (rep) { push(s, '重复词', '“' + rep[1] + ' ' + rep[1] + '”'); continue; }
    const rep2 = s.text.match(/\b([A-Za-z]+\s+[A-Za-z]+)\s+\1\b/i);
    if (rep2) { push(s, '整段重复', '“' + rep2[1] + '”'); continue; }
    if (s.words > 0 && s.words <= 3 && !/[.!?]$/.test(s.text) && !/^[A-Z]{2,}$/.test(s.text)) {
      push(s, '不成句的碎片', '');
    }
  }

  // A2) 低置信度：conf 是整段的属性，一段拆成好几句会重复报，所以每段只报一次，挑最长的那句
  const lowBySeg = new Map();
  for (const s of sents) {
    if (!isAsr(s) || s.conf == null || !(Number(s.conf) < 0.5)) continue;
    const k = s.segId != null ? 'g' + s.segId : 'i' + s.i;
    const cur = lowBySeg.get(k);
    if (!cur || s.words > cur.words) lowBySeg.set(k, s);
  }
  for (const s of [...lowBySeg.values()].sort((a, b) => a.t - b.t)) {
    push(s, '识别置信度低', '置信度 ' + Number(s.conf).toFixed(2));
  }

  // B) 孤词 vs 高频术语：只差 1~2 个字母，多半是把术语听错了
  const top = topTerms.filter(t => t.n === 1 && t.count >= 3).slice(0, 40).map(t => String(t.term).toLowerCase());
  if (top.length) {
    const seenWord = new Set();
    for (const s of sents) {
      if (!isAsr(s)) continue;
      for (const raw of (String(s.text).match(/[A-Za-z][A-Za-z'’\-]{4,}/g) || [])) {
        const w = raw.toLowerCase();
        if (STOP.has(w) || COMMON.has(w) || COMMON.has(stem(w))) continue;
        if ((tf.get(stem(w)) || 0) > 1) continue;     // 出现多次就不像听错
        if (seenWord.has(w)) continue;
        for (const term of top) {
          if (term === w) continue;
          if (Math.abs(term.length - w.length) > 2) continue;
          // 只是词形变化（mitochondria / mitochondrial、curve / curves）不是听错，别误报
          if (term.startsWith(w) || w.startsWith(term)) continue;
          if (stem(w) === stem(term)) continue;
          const d = editDistance(w, term, 1);
          if (d === 1 && term.length >= 6) {
            seenWord.add(w);
            push(s, '疑似听错术语', '“' + raw + '” 可能应该是 “' + term + '”');
            break;
          }
        }
        if (out.length >= 14) break;
      }
      if (out.length >= 14) break;
    }
  }
  return out;
}

/* ============================== 句子打分 ============================== */

function scoreSentences(sents, termWeight, defIdx, empIdx, taskIdx, formulaIdx) {
  for (const s of sents) {
    const ws = tokens(s.text);
    let v = 0, cnt = 0;
    for (const w of ws) {
      if (STOP.has(w) || w.length < 3) continue;
      v += termWeight.get(stem(w)) || 0;
      cnt++;
    }
    let sc = cnt ? v / Math.sqrt(cnt) : 0;
    if (s.words < 6) sc *= 0.35;
    if (s.words > 45) sc *= 0.8;
    if (defIdx.has(s.i)) sc *= 2.1;
    if (empIdx.has(s.i)) sc *= 1.9;
    if (taskIdx.has(s.i)) sc *= 1.6;
    if (formulaIdx.has(s.i)) sc *= 1.4;
    if (s.kind === 'note') sc *= 1.5;      // 用户自己敲的笔记，肯定重要
    s.score = sc;
  }
}

/* ============================== 主题标题 ============================== */

function titleForTopic(sents, topic, termWeight, disp) {
  const local = new Map();
  for (let i = topic.start; i <= topic.end; i++) {
    const ws = tokens(sents[i].text);
    let prev = null;
    for (const w of ws) {
      if (STOP.has(w) || w.length < 3) { prev = null; continue; }
      const st = stem(w);
      local.set(st, (local.get(st) || 0) + 1);
      if (prev) { const k = prev + ' ' + st; local.set(k, (local.get(k) || 0) + 1.6); }
      prev = st;
    }
  }
  const cand = [];
  for (const [k, c] of local) {
    if (c < 2) continue;
    const parts = k.split(' ');
    const wgt = parts.reduce((a, p) => a + (termWeight.get(p) || 0), 0) / parts.length;
    if (wgt <= 0.05) continue;
    cand.push({ k, score: (1 + Math.log(c)) * wgt * (parts.length === 2 ? 1.5 : 1) });
  }
  cand.sort((a, b) => b.score - a.score);
  const names = [];
  const used = new Set();
  for (const c of cand) {
    const parts = c.k.split(' ');
    if (parts.some(p => used.has(p))) continue;
    parts.forEach(p => used.add(p));
    names.push(parts.map(p => disp(p)).join(' '));
    if (names.length >= 2) break;
  }
  if (!names.length) {
    const s = sents[topic.start];
    return trimTail(s ? s.text : '这一段', 36);
  }
  return names.map(titleCase).join(' / ');
}

/* ============================== analyze ============================== */

/**
 * 分析一节课的转写稿。
 * @param {Array} segments [{id, t, text, zh, kind}]
 * @returns {Object} 结构化分析结果
 */
export function analyze(segments) {
  const segs = Array.isArray(segments) ? segments
    : (segments && Array.isArray(segments.segments) ? segments.segments : []);

  const marks = segs.filter(s => s && (s.kind === 'mark' || s.kind === 'note') && s.text)
    .map(s => ({ t: Number(s.t) || 0, text: String(s.text), kind: s.kind }));

  const sents = toSentences(segs);
  const empty = {
    meta: { segmentCount: segs.length, sentenceCount: 0, wordCount: 0, durationMs: 0, topicCount: 0 },
    sentences: [], topics: [], definitions: [], emphases: [], tasks: [],
    enumerations: [], formulas: [], terms: [], qa: [], suspects: [], marks, empty: true
  };
  if (!sents.length) return empty;

  // 先跑一遍定义抽取，拿到「老师专门定义过的词」，作为术语打分的先验
  const defs0 = extractDefinitions(sents);
  const defHint = new Set();
  for (const d of defs0) for (const w of tokens(d.term)) if (!STOP.has(w)) defHint.add(stem(w));

  const { terms, tf, surface, display } = extractTerms(sents, defHint);
  const disp = st => display.get(st) || surface.get(st) || st;

  // 词权重表：给主题切分和句子打分共用
  const termWeight = new Map();
  for (const t of terms) {
    if (t.n === 1) termWeight.set(t.key, t.score);
    else t.parts.forEach(p => termWeight.set(p, Math.max(termWeight.get(p) || 0, t.score * 0.8)));
  }
  for (const [st, c] of tf) {
    if (termWeight.has(st)) continue;
    const r = rarity(surface.get(st) || st);
    if (r > 0) termWeight.set(st, (1 + Math.log(c)) * r * 0.5);
  }

  const emphases = extractEmphasis(sents);
  const tasks = extractTasks(sents);
  const formulas = extractFormulas(sents);
  const enumerations = extractEnumerations(sents);
  const qa = extractQA(sents);
  const suspects = detectSuspects(sents, terms, tf);

  const defIdx = new Set(defs0.map(d => d.i));
  const empIdx = new Set(emphases.map(e => e.i));
  const taskIdx = new Set(tasks.map(x => x.i));
  const fmlIdx = new Set(formulas.map(x => x.i));
  scoreSentences(sents, termWeight, defIdx, empIdx, taskIdx, fmlIdx);

  // 主题切分 + 每段标题 + 每段关键句
  const rawTopics = detectTopics(sents, termWeight);
  const topics = rawTopics.map((tp, idx) => {
    const slice = sents.slice(tp.start, tp.end + 1);
    const key = slice.filter(s => s.words >= 7)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .sort((a, b) => a.t - b.t);
    return {
      index: idx,
      start: tp.start, end: tp.end,
      tStart: slice.length ? slice[0].t : 0,
      tEnd: slice.length ? slice[slice.length - 1].t : 0,
      sentenceCount: slice.length,
      title: titleForTopic(sents, tp, termWeight, disp),
      keySentences: key.map(s => ({ i: s.i, t: s.t, text: s.text, zh: s.zh || '' }))
    };
  });

  const totalWords = sents.reduce((a, s) => a + s.words, 0);
  // 注意：不能用 Math.max(...arr)，几千段会爆栈
  let durationMs = sents[sents.length - 1].t;
  for (const s of segs) {
    const e = Number((s && (s.end != null ? s.end : s.t)) || 0);
    if (e > durationMs) durationMs = e;
  }

  return {
    meta: {
      segmentCount: segs.length,
      sentenceCount: sents.length,
      wordCount: totalWords,
      durationMs,
      topicCount: topics.length
    },
    sentences: sents,
    topics,
    definitions: defs0,
    emphases,
    tasks,
    enumerations,
    formulas,
    terms,
    qa,
    suspects,
    marks,
    empty: false
  };
}

/* ============================== 翻译辅助 ============================== */

/**
 * 带缓存、带预算上限的翻译器：没有 translateFn 就返回空串。
 * 本地翻译模型一句要几百毫秒，所以必须限量；
 * 而且分成「长句池」和「术语池」两个预算，免得脉络把额度用光、生词表一个中文都没有。
 */
function makeTranslator(translateFn, budget, termBudget) {
  const cache = new Map();
  let used = 0, usedTerm = 0;
  return async function tr(text, fallback, isTerm) {
    const t = cleanPhrase(text);
    if (!t) return '';
    if (fallback) return fallback;                 // segment 里已经有中文，直接用，省时间
    if (!translateFn) return '';
    if (cache.has(t)) return cache.get(t);
    if (isTerm) { if (usedTerm >= termBudget) return ''; usedTerm++; }
    else { if (used >= budget) return ''; used++; }
    try {
      const r = await translateFn(t);
      const zh = cleanPhrase(r || '');
      cache.set(t, zh);
      return zh;
    } catch (_) {
      cache.set(t, '');
      return '';
    }
  };
}

/* ============================== buildNotes ============================== */

/**
 * 把分析结果渲染成中文课堂笔记（Markdown）。
 * 小节结构与 summarize.js 里云端 AI 版本保持一致，没有内容的小节自动省略。
 *
 * @param {Object} analysis analyze() 的返回值
 * @param {Object} opts { ctx: {course, teacher, title, startedAt}, translateFn: async (en)=>zh }
 * @returns {Promise<string>} Markdown
 */
export async function buildNotes(analysis, opts = {}) {
  const ctx = opts.ctx || {};
  const translateFn = opts.translateFn || null;
  const tr = makeTranslator(translateFn, Number(opts.budget) || 55, Number(opts.termBudget) || 30);

  if (!analysis || analysis.empty || !Array.isArray(analysis.sentences) || !analysis.sentences.length) {
    return '（这节课没有记录到可分析的内容。）';
  }

  // 全部给默认值：万一调用方自己拼了一个半成品 analysis，也不能让整份笔记炸掉
  const A = k => (Array.isArray(analysis[k]) ? analysis[k] : []);
  const meta = analysis.meta || { sentenceCount: analysis.sentences.length, durationMs: 0 };
  const topics = A('topics'), definitions = A('definitions'), emphases = A('emphases');
  const tasks = A('tasks'), enumerations = A('enumerations'), formulas = A('formulas');
  const terms = A('terms'), qa = A('qa'), suspects = A('suspects'), marks = A('marks');
  const L = [];
  const at = t => '`[' + mmss(t) + ']`';
  const mins = Math.round(meta.durationMs / 60000);

  /* ---- 一句话总结 ---- */
  const topTopics = topics.slice().sort((a, b) => b.sentenceCount - a.sentenceCount).slice(0, 4)
    .sort((a, b) => a.index - b.index).map(t => t.title);
  const topTerms = terms.slice(0, 6).map(t => titleCase(t.term));
  L.push('## 一句话总结');
  let one = `本节课约 ${mins} 分钟，共 ${meta.sentenceCount} 句转写`;
  if (topics.length > 1) one += `，自动切分为 ${topics.length} 个主题段`;
  one += '。';
  if (topTopics.length) one += `主线是 **${topTopics.join(' → ')}**。`;
  if (topTerms.length) one += `本节最核心的术语：${topTerms.map(t => '`' + t + '`').join('、')}。`;
  if (tasks.length) one += `另外老师提到了 ${tasks.length} 处作业 / 考试 / 截止时间，见下面的清单。`;
  L.push(one);
  // 最高分那句话给一个中文的「核心内容」
  const best = analysis.sentences.slice().sort((a, b) => b.score - a.score)[0];
  if (best) {
    const zh = await tr(best.text, best.zh);
    if (zh) L.push('\n核心内容：' + zh);
  }
  L.push('');
  L.push('> 这份笔记由**本机离线分析**生成（没有联网、没有用任何 API Key）。术语、定义、考点、作业都是从转写稿里自动抽取的，可能有遗漏，重要的地方建议对照录音再确认一遍。');
  L.push('');

  /* ---- 本节脉络 ---- */
  if (topics.length) {
    L.push('## 本节脉络');
    for (const tp of topics) {
      L.push(`\n**${tp.index + 1}. ${tp.title}** ${at(tp.tStart)} – ${at(tp.tEnd)}　（${tp.sentenceCount} 句）`);
      let tz = 0;
      for (const k of tp.keySentences) {
        L.push(`- ${at(k.t)} ${k.text}`);
        if (tz < 2) { const zh = await tr(k.text, k.zh); if (zh) { L.push(`  - ${zh}`); tz++; } }
      }
    }
    L.push('');
  }

  /* ---- 核心概念与定义 ---- */
  if (definitions.length) {
    L.push('## 核心概念与定义');
    for (const d of definitions.slice(0, 14)) {
      const termZh = await tr(d.term, '', true);
      const head = termZh ? `**${titleCase(d.term)}（${termZh}）**` : `**${titleCase(d.term)}**`;
      L.push(`- ${at(d.t)} ${head}`);
      L.push(`  - 原话：${trimTail(d.text, 220)}`);
      const zh = await tr(d.def || d.text, d.zh);
      if (zh) L.push(`  - 中文：${zh}`);
    }
    L.push('');
  }

  /* ---- 重点与可能的考点 ---- */
  if (emphases.length) {
    L.push('## 重点与可能的考点');
    const list = emphases.slice(0, 12).sort((a, b) => a.t - b.t);
    for (const e of list) {
      L.push(`- ${at(e.t)} **[${e.tag}]** ${trimTail(e.text, 220)}`);
      const zh = await tr(e.text, e.zh);
      if (zh) L.push(`  - ${zh}`);
    }
    L.push('');
  }

  /* ---- 公式 / 例题 / 推导 ---- */
  if (formulas.length) {
    L.push('## 公式 / 例题 / 推导');
    for (const f of formulas.slice(0, 10).sort((a, b) => a.t - b.t)) {
      L.push(`- ${at(f.t)} ${trimTail(f.text, 220)}`);
      const zh = await tr(f.text, f.zh);
      if (zh) L.push(`  - ${zh}`);
    }
    L.push('');
  }

  /* ---- 课堂上的分点与步骤（枚举还原） ---- */
  if (enumerations.length) {
    L.push('## 课堂上的分点与步骤');
    for (const g of enumerations) {
      L.push(`\n**${titleCase(g.title)}** ${at(g.t)}`);
      let n = 1;
      for (const it of g.items) {
        // 不用「1. 2. 3.」的 Markdown 有序列表：中间夹一行中文翻译时，
        // util.js 的 md2html 会把 <ol> 关掉重开，序号会全部变成 1。
        L.push(`- **${n}.** ${at(it.t)} ${it.text}`);
        const zh = await tr(it.text, it.zh);
        if (zh) L.push(`  - ${zh}`);
        n++;
      }
    }
    L.push('');
  }

  /* ---- 作业、截止日期、考试通知 ---- */
  if (tasks.length) {
    L.push('## 作业、截止日期、考试通知');
    const sorted = tasks.slice().sort((a, b) => (b.urgent - a.urgent) || (a.t - b.t));
    for (const x of sorted.slice(0, 16)) {
      const when = x.dates.length
        ? x.dates.map(d => `**${d.zh}**（${d.raw}）`).join('、')
        : '（没说具体时间）';
      L.push(`- 【${x.tags.join('/')}】${when} — ${at(x.t)}`);
      L.push(`  - 原话：${trimTail(x.text, 220)}`);
      const zh = await tr(x.text, x.zh);
      if (zh) L.push(`  - 中文：${zh}`);
    }
    L.push('');
  }

  /* ---- 课堂问答 ---- */
  if (qa.length) {
    L.push('## 课堂问答');
    for (const p of qa) {
      L.push(`- ${at(p.q.t)} **问：** ${p.q.text}`);
      const qz = await tr(p.q.text, p.q.zh);
      if (qz) L.push(`  - ${qz}`);
      if (p.a) {
        L.push(`  - **答：** ${p.a.text}`);
        const az = await tr(p.a.text, p.a.zh);
        if (az) L.push(`    - ${az}`);
      }
    }
    L.push('');
  }

  /* ---- 老师原话摘录 ---- */
  const quotePool = [];
  const qSeen = new Set();
  for (const e of emphases.slice(0, 6)) { if (!qSeen.has(e.i)) { qSeen.add(e.i); quotePool.push({ t: e.t, text: e.text, zh: e.zh }); } }
  for (const s of analysis.sentences.slice().sort((a, b) => b.score - a.score)) {
    if (quotePool.length >= 8) break;
    if (qSeen.has(s.i) || s.words < 8) continue;
    qSeen.add(s.i);
    quotePool.push({ t: s.t, text: s.text, zh: s.zh });
  }
  if (quotePool.length) {
    L.push('## 老师原话摘录');
    for (const q of quotePool.sort((a, b) => a.t - b.t)) {
      L.push(`- ${at(q.t)} “${trimTail(q.text, 240)}”`);
      const zh = await tr(q.text, q.zh);
      if (zh) L.push(`  - ${zh}`);
    }
    L.push('');
  }

  /* ---- 生词与术语对照表 ---- */
  const glossary = terms.filter(t => t.count >= 2 || t.n === 2).slice(0, 22);
  if (glossary.length) {
    L.push('## 生词与术语对照表');
    const defMap = new Map(definitions.map(d => [d.term.toLowerCase(), d]));
    for (const g of glossary) {
      const zh = await tr(g.term, '', true);
      const d = defMap.get(g.term.toLowerCase());
      const note = d ? '老师在 `[' + mmss(d.t) + ']` 下过定义' : (g.n === 2 ? '固定搭配' : '本节高频');
      L.push(`- **${titleCase(g.term)}**${zh ? '：' + zh : ''}　×${g.count}　_${note}_`);
    }
    L.push('');
  }

  /* ---- 我在课上标记的地方 ---- */
  if (marks && marks.length) {
    L.push('## 我在课上标记的地方');
    for (const m of marks.slice(0, 30)) {
      L.push(`- ${at(m.t)} ${m.kind === 'note' ? '📝 ' : '⭐ '}${m.text}`);
    }
    L.push('');
  }

  /* ---- 课后行动清单 ---- */
  L.push('## 课后行动清单');
  const todo = [];
  for (const x of tasks.filter(t => t.urgent).slice(0, 8)) {
    const when = x.dates.length ? x.dates[0].zh : '时间待确认';
    // 行动清单是给学生直接照着做的，能出中文就别塞英文原句（上面已经翻过，这里走缓存不额外花预算）
    const zh = await tr(x.text, x.zh);
    todo.push(`- [ ] 【${x.tags[0]}】${when}：${trimTail(zh || x.text, 90)}`);
  }
  for (const d of definitions.slice(0, 5)) {
    todo.push(`- [ ] 背下 **${titleCase(d.term)}** 的定义（${at(d.t)}）`);
  }
  if (emphases.length) todo.push(`- [ ] 把「重点与可能的考点」里的 ${Math.min(12, emphases.length)} 条过一遍`);
  if (glossary.length) todo.push(`- [ ] 查清术语表里还不认识的词（共 ${glossary.length} 个）`);
  if (suspects.length) todo.push(`- [ ] 回听「可能听错的地方」列出的 ${suspects.length} 处，确认没记错`);
  if (!todo.length) todo.push('- [ ] 通读本节脉络，把没听懂的段落回听一遍');
  L.push(...todo);
  L.push('');

  /* ---- 可能听错 / 存疑的地方 ---- */
  if (suspects.length) {
    L.push('## 可能听错 / 存疑的地方');
    L.push('语音识别不可能 100% 准确，下面这些地方机器觉得可疑，建议回听确认：');
    for (const s of suspects.sort((a, b) => a.t - b.t)) {
      L.push(`- ${at(s.t)} **${s.reason}**${s.detail ? ' ' + s.detail : ''}：${s.text}`);
    }
    L.push('');
  }

  /* ---- 页脚 ---- */
  const parts = [];
  if (ctx.course) parts.push('课程：' + ctx.course);
  if (ctx.teacher) parts.push('老师：' + ctx.teacher);
  parts.push('离线笔记生成于 ' + new Date().toLocaleString('zh-CN'));
  L.push('---');
  L.push('<small>' + parts.join('　·　') + '</small>');

  return L.join('\n');
}

/** 便捷入口：一步到位。（主协调者可用可不用） */
export async function localNotes(segments, opts = {}) {
  return buildNotes(analyze(segments), opts);
}

export default { analyze, buildNotes, localNotes };
