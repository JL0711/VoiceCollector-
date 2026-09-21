// translate-llm.js —— 用本地小语言模型做「英文课堂内容 → 中文」的高质量翻译
//
// ───────────────────────────────────────────────────────────────────────────
// 为什么要有这个文件（mt.js 的 opus-mt 哪里不够用）
// ───────────────────────────────────────────────────────────────────────────
// opus-mt-en-zh 是 2020 年的句子级 NMT 小模型：没有上下文、不认专有名词、
// 训练语料里几乎没有美国法学课堂的说法。实测（浏览器里真跑出来的）：
//
//   "the Supreme Court"  -> 最高法院          ✅
//   "supreme court"      -> 最高法院最高法院   ❌ 短输入退化复读
//   "chapter section"    -> 章次章节           ❌ 同上
//   "pre"                -> 预 期              ❌
//   "actually reading is the kind of pre chapter section the one that talks
//    about privacy and technology, we're not going to read that if it's a lot."
//     -> "读物其实是前一章章节的章节 讨论隐私和技术, 我们不会读,如果它很多。"  ❌
//
// 复读是 NMT 的经典失效模式：输入短到没有足够的上下文时，decoder 的 beam
// 会在同一小段上循环，长度惩罚又逼着它凑够长度，于是把同一个词吐两遍。
// 这个毛病**无法**靠调参数修好，只能换模型。
//
// 换成中文原生的 instruct 模型（Qwen 系）之后：
//   · 认得 Supreme Court / First Amendment / due process / Roe v. Wade 这些专名；
//   · 能一次看见好几句，用上下文消解 "that"、"it"、"this kind of" 的指代；
//   · 识别稿里听错的词（"pre chapter section" 其实是 "pre-chapter section"）
//     能靠语义猜回来；
//   · 短输入不会复读 —— 它是在「续写对话」，不是在「凑翻译长度」。
// 代价是要下 500MB~1.2GB 的权重、每句慢几百毫秒。所以本模块的定位是
// **课后重翻 / 高质量档**，实时直播那一路仍然可以留给更快的引擎。
//
// ───────────────────────────────────────────────────────────────────────────
// 和其它模块的关系
// ───────────────────────────────────────────────────────────────────────────
//   translate.js   调度层。它决定什么时候用本模块（本文件**不**自己调度）。
//   llm.js         同样的本地小模型，用来生成课堂笔记。
//                  ⚠️ 本模块**刻意复用 llm.js 里挑好的同一批模型仓库**，
//                     这样「AI 笔记」和「AI 翻译」共用一份权重，用户只下载一次。
//                     LLM_MT_MODELS 的体积数字和 llm.js 的 LLM_MODELS 是同一批，
//                     都在 2026-09 用 https://huggingface.co/api/models/<repo>/tree/main/onnx
//                     逐个核对过（见下面每条的精确字节数）。
//   glossary.js    术语表 + 劣化检测（由另一个模块提供），见「质量守卫」一节。
//
// 纯 ES Module，无构建步骤，可被 <script type="module"> 直接 import。

// ───────────────────────────────────────────────────────────────────────────
// 〇、运行时路径常量
// ───────────────────────────────────────────────────────────────────────────

// vendor 目录相对于本文件（web/js/translate-llm.js -> web/vendor/transformers/）。
//
// 这里给两个候选，按顺序尝试：
//   1) transformers.web.min.js —— 纯浏览器打包产物。llm.js 用的就是它。
//      它和 mt.js / whisper.js 用的 transformers.min.js 是**不同的模块实例**，
//      各自有一份 env，谁改 env 都影响不到对方 —— 这正是我们想要的隔离。
//   2) transformers.min.js —— 一定存在的那一份（mt.js 在用）。
//      退到这一档时 env 是**共享**的，改 env 会影响 mt.js / whisper.js，
//      所以 _prepareLocal() 里有一条「只开不关」的规则，见那里的注释。
const LIB_CANDIDATES = [
  new URL('../vendor/transformers/transformers.web.min.js', import.meta.url).href,
  new URL('../vendor/transformers/transformers.min.js', import.meta.url).href
];

const ORT_DIR = new URL('../vendor/transformers/ort/', import.meta.url).href;

// 必须和 @huggingface/transformers@4.3.0 锁定的 onnxruntime-web 版本一致
// （和 llm.js / whisper.js 是同一个常量，原因那边注释过）。
const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// 本地模型目录（web/models/）。
//
// ⚠️ 必须是「路径」不是「完整 URL」。transformers 4.3.0 src/utils/hub.js 里
// buildResourcePaths() 算出 localPath = pathJoin(env.localModelPath, '<repo>/<file>')，
// 然后用 `env.allowLocalModels && !isValidUrl(localPath, ['http:','https:'])` 判断
// 要不要走本地分支 —— 判的是 **localPath**。
// 一旦 localModelPath 写成 'https://host/web/models/'，isValidUrl() 为 true，
// 本地分支整个被跳过，库会直接去 Hugging Face 下 1GB。
// .pathname 拿到的是 '/web/models/'，new URL() 对它会抛异常 → isValidUrl 为 false → 正常走本地。
let LOCAL_MODELS_PATH = '/models/';
try { LOCAL_MODELS_PATH = new URL('../models/', import.meta.url).pathname; } catch (_) {}

// ───────────────────────────────────────────────────────────────────────────
// 一、可选模型清单
// ───────────────────────────────────────────────────────────────────────────
//
// 三个仓库都在 2026-09 用 HF API（/api/models/<repo>/tree/main/onnx）核实过：
// 仓库存在、onnx/ 下有下面写的量化文件、字节数就是注释里那一串。
//
// sizeMB = **实际会被下载的那一个 .onnx 文件**的体积，单位统一 MiB（字节 / 1048576）。
// ⚠️ Hugging Face 网页上显示的是十进制 MB/GB，会比这里大 4~7%，是同一个文件。
// 除 .onnx 外还要下 tokenizer.json / config.json 等，合计约 8~12MB，UI 提示体积时留 10MB 余量。
//
// dtypes 按 device 分三档（含义和 llm.js / whisper.js 一致）：
//   webgpu       —— 支持 shader-f16 的 WebGPU
//   webgpuNoFp16 —— 有 WebGPU 但不支持 fp16
//   wasm         —— 纯 CPU；wasm 后端不支持 fp16
//
// speed 是「翻一句 20 词左右的课堂英文」的量级感受（WebGPU / M 系列芯片）：
//   快 ≈ 0.3~0.8s，中 ≈ 0.6~1.5s，慢 ≈ 1.5~4s。批量翻（translateMany）会摊薄很多。
export const LLM_MT_MODELS = [
  {
    id: 'onnx-community/Qwen2.5-0.5B-Instruct',
    label: '轻量版（下得快、够用）',
    sizeMB: 461,
    quality: '良好',
    speed: '快',
    // 这条是 2026-09 在 node(cpu/q8) 上用 8 句真实课堂转写实测出来的，不是估计：
    // ✅ 认得 Supreme Court / due process / Roe v. Wade / 隐私权，短输入「supreme court」
    //    也不再复读（opus-mt 在这句上会输出「最高法院最高法院」）。
    // ⚠️ 但它会**丢细节**：First Amendment 被笼统译成「宪法」，Roe v. Wade 写成
    //    「罗伊 v. wade」（没转成通用译名「罗诉韦德案」），长从句偶尔会漏一截。
    note: '0.5B 参数，三档里最省。常见法律/社科专名认得，短语也不会像旧引擎那样复读；' +
      '但细节会丢（实测把 First Amendment 简化成「宪法」、Roe v. Wade 写成「罗伊 v. wade」）。' +
      '内存小 / 没独显 / 流量紧张时选它。WebGPU 下载 461MB，纯 CPU 档 488MB。' +
      '和「AI 笔记」共用同一份权重，只需下载一次。',
    dtypes: { webgpu: 'q4f16', webgpuNoFp16: 'q4', wasm: 'q8' },
    // 精确字节：q4f16 483,003,582 / q4 786,156,820 / q8(model_quantized) 512,096,557
    sizeMBByDevice: { webgpu: 461, webgpuNoFp16: 750, wasm: 488 },
    minRAM: 8,
    thinking: false      // Qwen2.5 的 chat template 没有 thinking 开关
  },
  {
    id: 'onnx-community/Qwen3-0.6B-ONNX',
    label: '推荐（M 系列芯片默认）',
    sizeMB: 543,
    quality: '很好',
    speed: '中',
    // 说明：本档和 1.5B 档没有在本机实测过（只实测了 0.5B），下面是基于
    // 同系列模型公开能力的合理预期，UI 上不要写成「实测」。
    note: '0.6B 参数，比 Qwen2.5-0.5B 新一代，中文表达通常更自然、术语更稳。' +
      '⚠️ 它默认会先输出一段 <think> 思考过程，本模块已显式关掉（enable_thinking=false），' +
      '否则每句都要先吐几百个 token。和「AI 笔记」共用同一份权重。',
    dtypes: { webgpu: 'q4f16', webgpuNoFp16: 'q4', wasm: 'q8' },
    // 精确字节：q4f16 569,789,750 / q4 919,096,585 / q8 617,687,575
    // （仓库里还有 model.onnx 315MB + model.onnx_data 2090MB 的 fp32 档，我们不碰）
    sizeMBByDevice: { webgpu: 543, webgpuNoFp16: 877, wasm: 589 },
    minRAM: 8,
    thinking: true
  },
  {
    id: 'onnx-community/Qwen2.5-1.5B-Instruct',
    label: '最好（需 16GB 内存 + 支持 fp16 的 WebGPU）',
    sizeMB: 1165,
    quality: '最好',
    speed: '慢',
    note: '1.5B 参数，三档里最大。长难句、法学术语、指代消解（that / the one that… 指谁）' +
      '通常明显更好，丢细节的情况也更少。代价：首次下载 1.1GB，跑起来占 2GB 左右显存/内存。' +
      '没有 fp16 的机器只能下 1.7GB 的 q4，不划算。',
    dtypes: { webgpu: 'q4f16', webgpuNoFp16: 'q4', wasm: 'q8' },
    // 精确字节：q4f16 1,221,878,940（单文件，无配套 .onnx_data）/ q4 1,787,566,590 / q8 1,578,954,293
    sizeMBByDevice: { webgpu: 1165, webgpuNoFp16: 1705, wasm: 1506 },
    minRAM: 16,
    thinking: false
  }
];

// 默认模型：和 llm.js 的 DEFAULT_MODEL 保持一致，共用权重
const DEFAULT_MT_MODEL = 'onnx-community/Qwen3-0.6B-ONNX';

/** 按 id 找模型配置；找不到返回 null。 */
export function findLLMMTModel(id) {
  return LLM_MT_MODELS.find(m => m.id === id) || null;
}

// ───────────────────────────────────────────────────────────────────────────
// 二、提示词
// ───────────────────────────────────────────────────────────────────────────
//
// 这一段决定译文质量，比任何代码都重要。几条经验（都是被小模型坑出来的）：
//   · 规则要**短、具体、可执行**。写「翻译要信达雅」没有任何作用；
//     写「专有名词第一次出现时写成 中文（English）」它就会照做。
//   · 必须明确禁止「输出原文 / 加解释 / 写开场白」，否则小模型极爱写
//     「好的，以下是翻译：」然后再来一遍英文。
//   · 输出格式必须像模板一样给死，解析端再做容错。
//   · 「不确定就保留英文原词」这条很关键：识别稿里必然有听错的词，
//     硬译出来的中文是错的且看不出来，留英文至少用户能自己判断。

/**
 * 默认 system prompt（简体中文）。
 * 导出是为了让云端 AI 那一路（translate.js / ai.js）能复用同一套规则 ——
 * 本地模型和云端模型用同一份要求，译文风格才不会在两档之间跳来跳去。
 */
export const MT_SYSTEM_PROMPT = [
  '你是大学课堂的同声传译译者，把英文课堂内容翻译成简体中文。',
  '',
  '必须遵守：',
  '1. 只输出译文本身。不要写「好的」「以下是翻译」，不要输出英文原文，不要加解释、注释、拼音或括注说明。',
  '2. 专业术语和专有名词**第一次出现**时用「中文（English）」的格式，例如：最高法院（Supreme Court）、第一修正案（First Amendment）、正当程序（due process）。同一批里再次出现就只写中文。',
  '3. 保持口语的自然语序，但删掉 um / uh / you know / like 这类语气词和无意义的重复。',
  '4. 文本来自语音识别，可能有听错的词。请结合上下文推断说话人的真实意思，不要逐字硬译。',
  '5. 实在不确定的词（人名、案件名、缩写、听不出来的专有名词）**保留英文原词**，不要瞎编中文。',
  '6. 不要扩写、不要补充原文没有的信息、不要总结。原文多长，译文就多长。',
  '7. 原文是残缺的片段时，就翻译这个片段，不要替它补完整句子。'
].join('\n');

const MT_SYSTEM_PROMPT_HANT = MT_SYSTEM_PROMPT
  .replace('翻译成简体中文', '翻譯成繁體中文（台灣用語）');

function systemPromptFor(targetLang) {
  return String(targetLang || '').toLowerCase().includes('hant')
    ? MT_SYSTEM_PROMPT_HANT
    : MT_SYSTEM_PROMPT;
}

// 批量翻译时每行的分隔符。选 '|' 是因为：
//   · 它几乎不会出现在课堂英文里（不像 ':' '-' '.'）；
//   · 模型不会把它当成句子的一部分；
//   · 输入也用同样的格式，模型照着抄就行（小模型模仿格式的能力远强于理解格式说明）。
const SEP = '|';

/**
 * 拼出「一次翻多句」的用户消息。
 * 导出是为了能单独测试 / 给云端复用。
 *
 * @param {{id:string|number, text:string}[]} items
 * @param {string} [context] 前文（只用于理解，不翻译）
 * @returns {string}
 */
export function buildBatchPrompt(items, context) {
  const n = items.length;
  const lines = [];
  const ctx = String(context || '').trim();
  if (ctx) {
    lines.push('【前文】（只用来理解上下文，**不要**翻译它、不要输出它）');
    lines.push(ctx);
    lines.push('');
  }
  lines.push(`【待翻译】共 ${n} 句，编号 1 到 ${n}：`);
  // 输入也写成 `编号|原文`，和要求的输出格式一模一样 —— 模型照抄格式即可
  items.forEach((it, i) => {
    lines.push(`${i + 1}${SEP}${oneLine(it.text)}`);
  });
  lines.push('');
  lines.push('【输出格式】');
  // ⚠️ 这里**绝对不能**写「1|第一句的中文译文」这种占位样例。
  // 实测（Qwen2.5-0.5B，node，2026-09）：写了占位样例之后，8 句的译文
  // 原样全是「第1句的中文译文」「第二句的中文译文」—— 模型把占位符当成了
  // 要它写的内容。小模型分不清「这是格式说明」和「这是正文」。
  // 格式靠下面 fewShotBatch() 里那一轮 assistant 示例去绑定，那是「已经答过的话」，
  // 模型只会模仿它的形状，不会抄它的内容。
  lines.push(`只输出 ${n} 行。第 k 行以「k${SEP}」开头，紧跟着写第 k 句的中文译文。`);
  lines.push('不要输出英文原文，不要写解释，不要多写行也不要少写行。');
  return lines.join('\n');
}

// ── 少样本示例（few-shot）──────────────────────────────────────────────
// 写成一轮真实的「用户问 → 助手答」对话，而不是塞进 prompt 文字里，原因见上。
// 例句刻意选成课堂口语 + 一个术语，同时示范三件事：
//   去语气词（okay so → 好）、术语用「中文（English）」、编号格式。
const FEWSHOT_EN = ['okay so the court said that kind of speech is protected', 'due process'];
const FEWSHOT_ZH = {
  hans: ['好，法院说这类言论是受保护的', '正当程序（due process）'],
  hant: ['好，法院說這類言論是受保護的', '正當程序（due process）']
};
const FEWSHOT_SINGLE_EN = 'supreme court';
const FEWSHOT_SINGLE_ZH = { hans: '最高法院（Supreme Court）', hant: '最高法院（Supreme Court）' };

function zhKey(targetLang) {
  return String(targetLang || '').toLowerCase().includes('hant') ? 'hant' : 'hans';
}

function fewShotBatch(targetLang) {
  const k = zhKey(targetLang);
  const items = FEWSHOT_EN.map((t, i) => ({ id: i + 1, text: t }));
  return [
    { role: 'user', content: buildBatchPrompt(items, '') },
    { role: 'assistant', content: FEWSHOT_ZH[k].map((t, i) => `${i + 1}${SEP}${t}`).join('\n') }
  ];
}

function fewShotSingle(targetLang) {
  const k = zhKey(targetLang);
  return [
    { role: 'user', content: buildSinglePrompt(FEWSHOT_SINGLE_EN, '') },
    { role: 'assistant', content: FEWSHOT_SINGLE_ZH[k] }
  ];
}

// 「模板回声 / 示例回声」检测。
// looksDegenerate() 抓不住这一类：「第1句的中文译文」中文比例正常、不重复、长度也正常，
// 但它显然不是译文。这是小模型特有的失效模式，必须单独拦。
const TEMPLATE_ECHO_RE = /^第?\s*[0-9０-９一二三四五六七八九十]*\s*句?的?中文译文$|^中文译文$|^译文$|^k\s*[|｜]/;

function looksEcho(zh, en) {
  const t = String(zh || '').trim();
  if (!t) return true;
  if (TEMPLATE_ECHO_RE.test(t)) return true;
  // 把 few-shot 的答案原样抄回来（而原文和示例毫无关系）也是回声
  const all = [].concat(FEWSHOT_ZH.hans, FEWSHOT_ZH.hant, FEWSHOT_SINGLE_ZH.hans);
  if (all.includes(t)) {
    const low = String(en || '').toLowerCase();
    const related = /court|speech|protect|due process|supreme/.test(low);
    if (!related) return true;
  }
  return false;
}

/** 拼出「单句翻译」的用户消息。 */
function buildSinglePrompt(text, context) {
  const lines = [];
  const ctx = String(context || '').trim();
  if (ctx) {
    lines.push('【前文】（只用来理解上下文，**不要**翻译它、不要输出它）');
    lines.push(ctx);
    lines.push('');
  }
  lines.push('【待翻译】');
  lines.push(oneLine(text));
  lines.push('');
  lines.push('只输出这段话的中文译文，一行写完，不要输出原文，不要解释：');
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// 三、输出解析（**最容易出 bug 的地方，认真看**）
// ───────────────────────────────────────────────────────────────────────────
//
// 「一次翻多句」的全部风险都集中在这里：只要模型少输出一行、多输出一行、
// 或者把两句合并成一行，**后面所有句子的译文就会整体错位**。
// 错位比翻错严重得多 —— 用户看到的是「每句都配着别句的中文」，而且
// 完全看不出哪里出了问题（每一句单看都通顺）。
//
// 所以策略是「**解析容错 + 对齐严格**」：
//   容错（尽量把模型那点小毛病吃下来）：
//     · 允许 `1|x`、`1．x`、`1. x`、`1、x`、`1：x`、`1) x`、`【1】x`、`(1) x`
//     · 允许全角竖线 `｜`
//     · 允许行与行之间有空行
//     · 允许开头有「好的，以下是翻译：」这种废话行（没有编号的行直接丢弃）
//     · 允许末尾有「希望对你有帮助」这种废话行（同上）
//     · 允许 <think>…</think>
//   严格（宁可退回也不要错位）：
//     · 编号必须正好覆盖 1..n，一个不少；
//     · 每条译文不能为空；
//     · 同一个编号出现两次，取**第一次**（后面那次多半是模型在重复）；
//     · 出现 1..n 之外的编号 → 直接判失败（说明模型在自由发挥）。
//   判失败之后的退路见 _translateChunk()：同批重试一次 → 对半拆 → 逐句翻。
//   逐句翻一定不会错位（一个输入一个输出），所以整条链路的最坏情况是
//   「慢一点」，而不是「错位」。
//
/**
 * @param {string} raw 模型原始输出
 * @param {number} n   期望的条数
 * @returns {string[]|null} 长度为 n 的数组；对不齐返回 null
 */
// 严格：只认我们在提示词里要求的 `k|` / `k｜`（竖线几乎不会出现在中文译文里）。
const NUM_RE_STRICT = /^[\s>*-]*[【\[(（]?\s*(\d{1,3})\s*[】\])）]?\s*[|｜]\s*(.*)$/;
// 宽松：容忍模型改用 `k.` `k、` `k：` `k)` 这些分隔符。
// ⚠️ 只在严格解析失败时才用，因为它会把译文的**续行**误当成编号行：
//    「3、4两个条款」会被读成「第 3 条 = 4两个条款」—— 内容被截断且看不出来。
const NUM_RE_LOOSE = /^[\s>*-]*[【\[(（]?\s*(\d{1,3})\s*[】\])）]?\s*[|｜：:．.、)）]\s*(.*)$/;

function collectNumbered(text, n, RE) {
  const got = new Map();
  let sawStray = false;      // 出现了 < 1 的编号 —— 真错位，不能信
  let strayHigh = false;     // 只是多吐了 > n 的编号 —— 模型在末尾续写，1..n 仍然可信

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(RE);
    if (!m) continue;                       // 没编号的行 = 客套话 / 续行，丢弃
    const idx = parseInt(m[1], 10);
    const val = cleanTranslation(m[2], true);
    if (!(idx >= 1 && idx <= n)) { if (idx < 1) sawStray = true; else strayHigh = true; continue; }
    if (!val) continue;                     // 空译文不算数，留给「缺号」逻辑去判失败
    if (!got.has(idx)) got.set(idx, val);   // 重复编号取第一次
  }

  // 出现 1..n 之外的编号：模型在自己编条目（多半是把某句拆成了两条，
  // 或者续写了第 n+1 条客套话）。这时哪怕 1..n 恰好都齐了也**不能信** ——
  // 多出来的那条说明它没在按我们给的编号走，1..n 很可能已经整体挪过位了。
  // 宁可退回重试，也不要把错位的译文送出去。
  if (sawStray) return null;
  // 多出来的编号都 > n 且 1..n 全齐：模型只是在末尾续写了一条，直接采纳 1..n
  if (got.size !== n) return null;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const v = got.get(i);
    if (!v) return null;
    out.push(v);
  }
  return out;
}

/**
 * 打捞式解析：拿到几条算几条，缺的用 null 占位。
 * 对齐失败时不再推翻整批重来（那会把 1 次 generate 放大到 10 次），
 * 而是只把缺的那几条拿去单独重翻。最坏情况退化成逐句，永远不会更差。
 */
export function parseNumberedPartial(raw, n) {
  const text = stripThinking(raw);
  if (!text) return { values: new Array(n).fill(null), conflict: true };
  for (const RE of [NUM_RE_STRICT, NUM_RE_LOOSE]) {
    const got = new Map();
    let conflict = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = line.match(RE);
      if (!m) continue;
      const idx = parseInt(m[1], 10);
      const val = cleanTranslation(m[2], true);
      if (idx < 1) { conflict = true; continue; }   // 编号 < 1 说明模型没按我们的编号走
      if (idx > n) continue;                        // 末尾续写，忽略即可
      if (!val) continue;
      if (!got.has(idx)) got.set(idx, val);
    }
    if (got.size) {
      const values = [];
      for (let i = 1; i <= n; i++) values.push(got.has(i) ? got.get(i) : null);
      return { values, conflict };
    }
  }
  return { values: new Array(n).fill(null), conflict: false };
}

export function parseNumbered(raw, n) {
  const text = stripThinking(raw);
  if (!text) return null;
  // 先按我们要求的格式严格解析；模型听话时（绝大多数情况）就到此为止，
  // 续行里的「3、」之类根本没机会被误读成编号。严格失败了再放宽。
  return collectNumbered(text, n, NUM_RE_STRICT) || collectNumbered(text, n, NUM_RE_LOOSE);
}

// 单句输出的清洗：模型可能写成 `译文：xxx`、`"xxx"`、`1| xxx`，也可能多吐一行客套话。
function parseSingle(raw) {
  const text = stripThinking(raw);
  if (!text) return '';
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) {
      // 已经拿到内容之后遇到空行 → 后面多半是客套话，停手
      if (out.length) break;
      continue;
    }
    // 已经有译文了：后面再冒出客套话（严格或宽松）就停手
    if (out.length && (META_STRICT_RE.test(line) || META_TRAILING_RE.test(line))) break;
    // 还没有译文：只丢弃「一眼就是客套话」的那种，别把「注意：考试在周五」当客套话删了
    if (!out.length && META_STRICT_RE.test(line)) continue;
    // 模型有时会带上批量格式的编号，剥掉
    line = line.replace(/^[\s>*-]*[【\[(（]?\s*\d{1,3}\s*[】\])）]?\s*[|｜]\s*/, '');
    const v = cleanTranslation(line);
    if (v) out.push(v);
  }
  // 中文不用空格拼接
  return out.join('').trim();
}

// 明显是「模型在跟你说话」而不是译文的行。
//
// ⚠️ 分两档，因为课堂英文里这些词**本来就会出现**：
//   "Note: the exam is on Friday"  → 译文「注意：考试在周五」
//   "I hope you all read chapter 3" → 译文「希望大家读完第三章」
// 把 `注意[：:]` / `希望` 无条件当客套话扔掉，会把这类**正确译文整条删成空**，
// 而且在批量里还会连累整批对不齐（空译文 → 缺号 → 重试 → 拆批 → 逐句 → 还是空）。
// 所以：
//   STRICT —— 一眼就是客套话，任何位置都能丢（「好的，以下是翻译：」）；
//   TRAILING —— 只有在**已经拿到译文之后**才认（末尾的「希望对你有帮助」），
//               出现在开头时按正文处理。
const META_STRICT_RE = /^(好的[，,、]|当然[，,、]|以下是|下面是|翻译如下|译文如下|以上是|Here (is|are)\b|Sure[,，]|Translation\s*[：:]|Note\s*[：:]\s*$)/i;
const META_TRAILING_RE = /^(希望|注[：:]|说明[：:]|注意[：:]|备注[：:]|以上)/;

// numbered=true 表示这一行已经带了编号。
// ⚠️ 实测教训：模型不会给客套话编号，所以 `1|好的，下一周的阅读材料是…` 里的
//    「好的，」是**正文**，不是客套话。之前在这里跑 META_STRICT_RE，
//    把这种行整条删成空串 → 缺号 → 判定整批对齐失败 → 触发重试和递归拆批，
//    一次 generate 被放大到 4~10 次。24 句语料实测对齐成功率只有 1/4。
//    而 "okay so" / "alright" / "well" 正是美国课堂最高频的句首词。
function cleanTranslation(s, numbered) {
  let t = String(s == null ? '' : s).trim();
  t = t.replace(/^(译文|翻译|中文|中文译文)\s*[：:]\s*/i, '');
  t = t.replace(/^["'“”『「《]+/, '').replace(/["'“”』」》]+$/, '');
  t = t.replace(/^\s*[|｜]\s*/, '');
  // 模型偶尔会把编号写两遍（`1|1|译文`），第二个编号会留在内容里，剥掉
  t = t.replace(/^\s*\d{1,3}\s*[|｜]\s*/, '');
  t = t.trim();
  // 有编号的行一律当正文，不做客套话判断（见上面的注释）
  if (!numbered && META_STRICT_RE.test(t)) return '';
  return t;
}

// 去掉 Qwen3 之类模型的 <think> 块（正常情况下 enable_thinking=false 已经关掉，这是兜底；
// 也处理只剩半个标签的截断情况）
function stripThinking(s) {
  let t = String(s || '');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  t = t.replace(/^[\s\S]*?<\/think>/i, '');
  t = t.replace(/<think>[\s\S]*$/i, '');
  return t.trim();
}

// 把多行原文压成一行 —— 批量格式是「一行一条」，原文里的换行会直接把格式冲垮
function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// 只有标点/空白/纯数字的输入不值得叫模型（也最容易触发复读）
function isTranslatable(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return false;
  return /[A-Za-zÀ-ɏ]/.test(t);
}

// ───────────────────────────────────────────────────────────────────────────
// 四、质量守卫（glossary.js）
// ───────────────────────────────────────────────────────────────────────────
//
// looksDegenerate(zh, en) / applyGlossary(en, zh) 由 glossary.js 提供。
// 这里用**懒加载的动态 import**而不是顶层 import，有两个原因：
//   1) 本模块的其余部分（提示词、解析、对齐）可以在没有 glossary.js 的环境里
//      单独测试（node 里跑对齐逻辑时不需要它）；
//   2) 万一那个文件暂时不在，本模块降级成「用内置的粗检测」而不是整个模块
//      import 失败 —— 一个 404 把翻译功能整体打死是不可接受的。
// 正常情况下永远走 glossary.js 那一份（它比内置的这份好得多）。
// ⚠️ 契约适配：glossary.js 的 looksDegenerate() 返回的是 **对象** `{bad, reason}`，
// 不是布尔值。`!!{bad:false}` 恒为 true —— 直接当布尔用会把**每一条**译文判成劣化，
// 整个模块对任何输入都返回空字符串（实测：完美的批量输出也全军覆没，
// 而且每条还要白白重试两次，慢 3 倍）。内置兜底那份返回的又是布尔，
// 所以这里统一归一化：对象取 .bad，布尔直接用。
// 顺手把 reason 透出来，日志里能看见是被哪条规则拦的。
function normalizeDegenerate(v) {
  if (v && typeof v === 'object') {
    return { bad: !!v.bad, reason: String(v.reason || '') };
  }
  return { bad: !!v, reason: v ? '内置粗检测' : '' };
}

let _glossaryPromise = null;
function getGlossary() {
  if (_glossaryPromise) return _glossaryPromise;
  _glossaryPromise = import('./glossary.js').then(
    (m) => ({
      looksDegenerate: typeof m.looksDegenerate === 'function' ? m.looksDegenerate : fallbackLooksDegenerate,
      applyGlossary: typeof m.applyGlossary === 'function' ? m.applyGlossary : ((en, zh) => zh)
    }),
    (err) => {
      console.warn('[translate-llm] 载入 glossary.js 失败，改用内置的粗劣化检测：', err);
      return { looksDegenerate: fallbackLooksDegenerate, applyGlossary: (en, zh) => zh };
    }
  );
  return _glossaryPromise;
}

// 「中文（English）」里那段英文括注是 MT_SYSTEM_PROMPT **要求**模型写的，不是劣化。
// 判断译文好坏之前必须先把它摘掉，否则：
//   「最高法院（Supreme Court）」长度 21 > 原文 "supreme court" 13×1.6，
//   中文占比 4/20 < 25% —— 一条完全正确的译文会被两条规则同时误杀。
// （实测踩到过：node 里 "supreme court" 的正确译文被连拦两次，最后返回了空字符串。）
// 传给 glossary.js 的 looksDegenerate() 之前也做同样的摘除，免得那边有同类阈值。
export function stripGloss(zh) {
  return String(zh || '')
    .replace(/[（(]\s*[A-Za-z0-9][A-Za-z0-9 .,'’&\/-]*\s*[）)]/g, '')
    .trim();
}

/**
 * 统一的质量判定：模板回声 → 劣化检测（两处调用点共用，免得改了一处漏了另一处）。
 * @returns {{bad:boolean, reason:string}}
 */
function judgeQuality(looksDegenerate, zh, en) {
  if (looksEcho(zh, en)) return { bad: true, reason: '模板回声' };
  let verdict;
  try {
    // 判劣化用「摘掉英文括注」的版本 —— 括注是 MT_SYSTEM_PROMPT 要求模型写的，不是劣化；
    // 但返回给调用方的仍是带括注的完整译文。
    verdict = normalizeDegenerate(looksDegenerate(stripGloss(zh), en));
  } catch (err) {
    // 守卫自己炸了不该把译文一起拖下水：放行，交给上层看。
    console.warn('[translate-llm] looksDegenerate 抛错，按「未劣化」放行：', err);
    return { bad: false, reason: '' };
  }
  // 摘掉括注后可能太短而被「译文过短」误杀，用完整译文再判一次；两次都说坏才算坏。
  if (verdict.bad && /过短|漏译/.test(verdict.reason)) {
    try {
      const second = normalizeDegenerate(looksDegenerate(String(zh || ''), en));
      if (!second.bad) return second;
    } catch (_) {}
  }
  return verdict;
}

// 内置兜底：只抓最明显的几种劣化。glossary.js 在的时候不会用到这份。
const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/g;
function fallbackLooksDegenerate(zhRaw, en) {
  const t = stripGloss(zhRaw);
  if (!t) return true;
  // a) 同一个字符连续刷屏
  if (/(.)\1{9,}/.test(t)) return true;
  // b) 把同一个 2~6 字的片段连着重复三遍以上（「最高法院最高法院最高法院」）
  if (/(.{2,6})\1{2,}/.test(t)) return true;
  // c) 译文长度是原文的好几倍 —— 英译中一般会**变短**（按字符算大约 0.4~0.8 倍）
  const enLen = String(en || '').trim().length;
  if (enLen >= 8 && t.length > enLen * 1.6) return true;
  // d) 几乎没有中文（模型在复读英文原文）
  const nonSpace = t.replace(/\s+/g, '');
  if (nonSpace.length >= 8 && (t.match(CJK_RE) || []).length / nonSpace.length < 0.25) return true;
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// 五、运行时（懒加载 transformers）
// ───────────────────────────────────────────────────────────────────────────

let _runtime = null;
let _ortLocal = false;
let _libShared = false;     // true = 退到了和 mt.js 共用的 transformers.min.js
let _runtimeOpts = {
  libUrl: null,             // 指定库文件（node 测试用；浏览器里留 null 走 LIB_CANDIDATES）
  remoteHost: 'https://huggingface.co/',
  cacheKey: 'transformers-cache',
  localModelPath: LOCAL_MODELS_PATH,
  // 文件系统缓存目录。浏览器里没有文件系统，留 null 即可（权重进 Cache Storage）；
  // 只有 node / Electron 主进程这类有 fs 的环境才用得上。
  // ⚠️ transformers 4.3.0 的默认值是「**库文件所在目录**下的 .cache」，
  //    不是当前工作目录下的 .cache（src/env.js 的 DEFAULT_CACHE_DIR）——
  //    想让权重落在自己指定的地方就必须显式传。
  cacheDir: null,
  numThreads: null
};

/**
 * 在 load() 之前调用才有意义。用于换 HF 镜像、改本地模型目录、调线程数（省电）、
 * 或者在 node 里指定库文件做离线测试。
 */
export function configureLLMMTRuntime(patch) {
  if (_runtime) throw new Error('翻译模型运行时已初始化，configureLLMMTRuntime 必须在 load() 之前调用');
  _runtimeOpts = { ..._runtimeOpts, ...(patch || {}) };
}

/** 诊断用：ORT 的 WASM 是不是从本地 vendor 目录加载的。 */
export function ortIsLocal() { return _ortLocal; }

// 复刻 transformers 4.3.0 env.js 里的 isSafariBelow26()（和 llm.js 同一份逻辑）
function isSafariBelow26() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isSafari =
    (navigator.vendor || '').indexOf('Apple') > -1 &&
    !ua.match(/CriOS|FxiOS|EdgiOS|OPiOS|mercury|brave/i) &&
    !ua.includes('Chrome') &&
    !ua.includes('Android');
  if (!isSafari) return false;
  const m = ua.match(/Version\/(\d+)/);
  return m ? parseInt(m[1], 10) < 26 : false;
}

async function exists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'force-cache' });
    return res.ok;
  } catch (_) { return false; }
}

// dist 打包产物里 env.versions.web 没被赋值，库自带的「默认走 jsDelivr」那段是死代码，
// wasmPaths 不显式设就会 404。和 llm.js / whisper.js 算出来的是同一组路径。
async function resolveOrtPaths(hasWebGPU) {
  const suffix = isSafariBelow26() && !hasWebGPU ? '' : '.asyncify';
  const name = `ort-wasm-simd-threaded${suffix}`;
  const wasm = `${ORT_DIR}${name}.wasm`;
  const mjs = `${ORT_DIR}${name}.mjs`;
  const [okWasm, okMjs] = await Promise.all([exists(wasm), exists(mjs)]);
  if (okWasm && okMjs) return { wasm, mjs, local: true };
  return { wasm: `${ORT_CDN}${name}.wasm`, mjs: `${ORT_CDN}${name}.mjs`, local: false };
}

async function importLib() {
  const urls = _runtimeOpts.libUrl ? [_runtimeOpts.libUrl] : LIB_CANDIDATES;
  let lastErr = null;
  for (let i = 0; i < urls.length; i++) {
    try {
      const mod = await import(/* @vite-ignore */ urls[i]);
      if (typeof mod.pipeline !== 'function') throw new Error('模块里没有 pipeline 具名导出');
      // 用到第 2 个候选（transformers.min.js）说明 env 是和 mt.js 共享的
      _libShared = !_runtimeOpts.libUrl && i > 0;
      return mod;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('无法加载 transformers 运行时');
}

async function getRuntime() {
  if (_runtime) return _runtime;
  _runtime = (async () => {
    const mod = await importLib();
    const { pipeline, env, TextStreamer, StoppingCriteria, StoppingCriteriaList } = mod;

    env.allowRemoteModels = true;
    if (_runtimeOpts.remoteHost) {
      env.remoteHost = _runtimeOpts.remoteHost;
      env.remotePathTemplate = '{model}/resolve/{revision}/';
    }
    // 浏览器 Cache Storage：权重和 ort wasm 都进缓存，第二次开课就完全离线了。
    // ⚠️ 必须先确认真的有 caches —— transformers 4.3.0 的 getCache() 在没有
    // Cache Storage 的环境（node、以及 file:// 下的部分浏览器）里是直接 throw 的，
    // 不是静默降级。无脑设 true 会让 load() 在 loadConfig 阶段就炸掉。
    const hasCacheStorage = typeof caches !== 'undefined' && typeof window !== 'undefined';
    env.useBrowserCache = hasCacheStorage;
    env.useWasmCache = hasCacheStorage;
    if (hasCacheStorage && _runtimeOpts.cacheKey) env.cacheKey = _runtimeOpts.cacheKey;
    if (_runtimeOpts.cacheDir) env.cacheDir = _runtimeOpts.cacheDir;

    // allowLocalModels / localModelPath 不在这里设死，见 LLMTranslator._prepareLocal()

    const wasmEnv = env.backends && env.backends.onnx && env.backends.onnx.wasm;
    if (wasmEnv && typeof window !== 'undefined') {
      const hasWebGPU = await webgpuAvailable();
      const paths = await resolveOrtPaths(hasWebGPU);
      // mt.js 可能已经把 wasmPaths 设成字符串前缀；对象形式更精确，覆盖掉没关系
      wasmEnv.wasmPaths = { wasm: paths.wasm, mjs: paths.mjs };
      _ortLocal = paths.local;

      const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
      const isolated = typeof globalThis.crossOriginIsolated !== 'undefined' && globalThis.crossOriginIsolated;
      wasmEnv.numThreads = _runtimeOpts.numThreads != null
        ? _runtimeOpts.numThreads
        : (isolated ? Math.min(4, Math.max(1, Math.floor(cores / 2))) : 1);   // 省电
    }

    return { pipeline, env, TextStreamer, StoppingCriteria, StoppingCriteriaList };
  })();
  return _runtime;
}

// ───────────────────────────────────────────────────────────────────────────
// 六、设备能力探测
// ───────────────────────────────────────────────────────────────────────────

let _gpuProbe = null;
async function probeGPU() {
  if (_gpuProbe) return _gpuProbe;
  _gpuProbe = (async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu) return { ok: false, fp16: false, info: {} };
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return { ok: false, fp16: false, info: {} };
      return {
        ok: true,
        fp16: !!(adapter.features && adapter.features.has('shader-f16')),
        info: adapter.info || {},
        maxStorageBufferBindingSize: (adapter.limits && adapter.limits.maxStorageBufferBindingSize) || 0
      };
    } catch (_) { return { ok: false, fp16: false, info: {} }; }
  })();
  return _gpuProbe;
}

export async function webgpuAvailable() { return (await probeGPU()).ok; }

/**
 * 这台机器能不能用「AI 翻译」这一档。不下载任何东西，只看硬件特征。
 * @returns {Promise<{ok:boolean, reason:string, device:'webgpu'|'wasm'|null}>}
 */
export async function llmMTAvailable() {
  const gpu = await probeGPU();
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0;
  const memGB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8;
  if (gpu.ok) {
    if (gpu.maxStorageBufferBindingSize && gpu.maxStorageBufferBindingSize < (128 << 20)) {
      return { ok: false, reason: '这块显卡单个缓冲区上限太小，装不下模型权重。继续用普通翻译引擎。', device: null };
    }
    return {
      ok: true,
      reason: gpu.fp16
        ? 'WebGPU 可用且支持 fp16，AI 翻译速度和体积都最好。'
        : 'WebGPU 可用但不支持 fp16，下载体积会大一些。',
      device: 'webgpu'
    };
  }
  if (memGB < 8 || (cores && cores < 4)) {
    return { ok: false, reason: '没有 WebGPU，而且内存/核心数偏少，AI 翻译会非常慢。建议用普通翻译引擎。', device: null };
  }
  return { ok: true, reason: '没有 WebGPU，只能用 CPU 跑。能出结果，但每句要等一两秒，建议课后重翻时再用。', device: 'wasm' };
}

/** 粗略推荐一个模型 id（思路同 llm.js 的 recommendModel）。 */
export async function recommendMTModel() {
  const LIGHT = 'onnx-community/Qwen2.5-0.5B-Instruct';
  const MID = 'onnx-community/Qwen3-0.6B-ONNX';
  const BIG = 'onnx-community/Qwen2.5-1.5B-Instruct';
  const gpu = await probeGPU();
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  const memGB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8;
  if (!gpu.ok) return LIGHT;
  const vendor = String(gpu.info.vendor || '').toLowerCase();
  const arch = String(gpu.info.architecture || '').toLowerCase();
  const isApple = vendor.includes('apple') || arch.includes('apple') || arch.includes('metal');
  const isDiscrete = vendor.includes('nvidia') || vendor.includes('amd') ||
    arch.includes('rdna') || arch.includes('ampere') || arch.includes('ada');
  const bigBuffers = (gpu.maxStorageBufferBindingSize || 0) >= (1 << 30);
  if (gpu.fp16 && memGB >= 16 && cores >= 8 && bigBuffers && (isApple || isDiscrete)) return BIG;
  if (gpu.fp16) return MID;
  if (memGB >= 8 && cores >= 8) return MID;
  return LIGHT;
}

function pickDtype(modelId, device, fp16) {
  const entry = findLLMMTModel(modelId);
  const key = device === 'webgpu' ? (fp16 ? 'webgpu' : 'webgpuNoFp16') : 'wasm';
  if (entry && entry.dtypes && entry.dtypes[key]) return entry.dtypes[key];
  if (device === 'webgpu') return fp16 ? 'q4f16' : 'q4';
  return 'q8';
}

// ───────────────────────────────────────────────────────────────────────────
// 七、LLMTranslator
// ───────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 45000;    // 单次生成的软上限
const HARD_TIMEOUT_SLACK = 20000;    // 软上限之后再等这么久就硬放弃
const DEFAULT_BATCH = 5;             // 一次翻几句：3~8 之间，5 是质量/风险的折中
const MAX_BATCH = 8;
const CONTEXT_CHARS = 320;           // 滚动上下文的长度上限
const CACHE_MAX = 400;

export class LLMTranslator {
  /**
   * @param {Object} [opts]
   * @param {string}   [opts.model]      LLM_MT_MODELS 里的 id
   * @param {Function} [opts.onProgress] ({pct, loadedMB, totalMB, file}) => void  下载进度
   * @param {Function} [opts.onStatus]   (status, detail) => void
   *                                     'downloading'|'loading'|'ready'|'error'|'closed'
   * @param {string}   [opts.targetLang] 'zh-Hans'(默认) | 'zh-Hant'
   * @param {number}   [opts.timeoutMs]  单次生成超时
   * @param {string}   [opts.device]     强制后端（'webgpu'|'wasm'|'cpu'），一般不用传
   * @param {string}   [opts.dtype]      强制精度，一般不用传
   */
  constructor({ model, onProgress, onStatus, targetLang = 'zh-Hans', timeoutMs, device, dtype } = {}) {
    this.modelId = model || DEFAULT_MT_MODEL;
    this.targetLang = targetLang || 'zh-Hans';
    this.onProgress = typeof onProgress === 'function' ? onProgress : null;
    this.onStatus = typeof onStatus === 'function' ? onStatus : null;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;

    this.system = systemPromptFor(this.targetLang);
    this.dtype = null;
    this.fromLocal = false;

    this._forcedDevice = device || null;
    this._forcedDtype = dtype || null;
    this._device = null;
    this._ready = false;

    this._pipe = null;
    this._loading = null;
    this._closed = false;
    // 同一时刻只跑一次生成（ONNX session 不能并发 run）
    this._queue = Promise.resolve();
    this._inflight = null;
    // 重复句子的小缓存（课堂里「okay so」「right」这种会反复出现）。
    // 只缓存**不带上下文**的翻译 —— 带上下文的结果换个上下文就不成立了。
    this._cache = new Map();
  }

  /** 只读：模型是否已就绪 */
  get ready() { return this._ready; }
  /** 只读：实际用上的后端 'webgpu' | 'wasm' | 'cpu' | null */
  get device() { return this._device; }

  _status(s, detail) {
    if (this.onStatus) { try { this.onStatus(s, detail); } catch (_) {} }
  }

  // 探测 web/models/<repo>/config.json 在不在，决定这次 load 要不要开本地分支。
  //
  // 为什么不无脑开 allowLocalModels=true：本地没有时库会对每个文件先发一次注定 404 的请求，
  // 有些 dev server 对 404 返回 200 + index.html，那就会拿一份 HTML 去当 tokenizer.json 解析。
  //
  // ⚠️ 「只开不关」：退到共享的 transformers.min.js 时（_libShared），env 是和 mt.js
  // 共用的 —— mt.js 需要 allowLocalModels=true 才能读本地的 opus-mt。
  // 所以这里**只在本地有权重时把它设成 true，绝不把它设回 false**，
  // 否则会把 mt.js 的离线能力顺手关掉（而且症状极其难查）。
  async _prepareLocal(env) {
    const base = _runtimeOpts.localModelPath;
    let ok = false;
    if (base) {
      try {
        const res = await fetch(`${base}${this.modelId}/config.json`, { cache: 'force-cache' });
        if (res.ok) {
          const ct = String(res.headers.get('content-type') || '');
          if (!ct.includes('html')) {
            const obj = JSON.parse(await res.text());
            ok = !!(obj && (obj.model_type || obj.architectures));
          }
        }
      } catch (_) { ok = false; }
    }
    if (ok) {
      env.allowLocalModels = true;
      env.localModelPath = base;
    } else if (!_libShared) {
      // 独立的 env，随便关
      env.allowLocalModels = false;
    }
    this.fromLocal = ok;
    return ok;
  }

  /** 幂等：重复调用返回同一个 promise。 */
  async load() {
    if (this._pipe) return this._pipe;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      try {
        const { pipeline, env } = await getRuntime();
        const gpu = await probeGPU();
        await this._prepareLocal(env);

        let sawDownload = false;
        let finished = false;
        const progress_callback = (info) => {
          if (this._closed) return;
          if (info.status === 'initiate' || info.status === 'download') {
            if (!sawDownload) {
              sawDownload = true;
              this._status('downloading', { model: this.modelId, local: this.fromLocal });
            }
          } else if (info.status === 'progress_total') {
            if (!sawDownload) {
              sawDownload = true;
              this._status('downloading', { model: this.modelId, local: this.fromLocal });
            }
            if (this.onProgress) {
              try {
                this.onProgress({
                  pct: Math.max(0, Math.min(100, info.progress || 0)),
                  loadedMB: +((info.loaded || 0) / 1048576).toFixed(1),
                  totalMB: +((info.total || 0) / 1048576).toFixed(1),
                  file: null
                });
              } catch (_) {}
            }
            if (!finished && (info.progress || 0) >= 99.9) {
              finished = true;
              // 权重下完了，接下来建 ONNX session（WebGPU 编译 shader 要十几秒且不发事件）
              this._status('loading', { model: this.modelId });
            }
          } else if (info.status === 'progress' && this.onProgress && !sawDownload) {
            try {
              this.onProgress({
                pct: Math.max(0, Math.min(100, info.progress || 0)),
                loadedMB: +((info.loaded || 0) / 1048576).toFixed(1),
                totalMB: +((info.total || 0) / 1048576).toFixed(1),
                file: info.file || null
              });
            } catch (_) {}
          }
        };

        const build = async (device) => {
          const dt = this._forcedDtype || pickDtype(this.modelId, device, gpu.fp16);
          const pipe = await pipeline('text-generation', this.modelId, { device, dtype: dt, progress_callback });
          this._device = device;
          this.dtype = dt;
          return pipe;
        };

        let pipe = null;
        if (this._forcedDevice) {
          this._status('loading', { model: this.modelId });
          pipe = await build(this._forcedDevice);
        } else {
          // 优先 WebGPU（比 CPU 快一个数量级，而且 GPU 定点算比 CPU 满载省电）
          if (gpu.ok) {
            try {
              pipe = await build('webgpu');
            } catch (err) {
              console.warn('[translate-llm] WebGPU 初始化失败，退回 CPU(wasm)：', err);
              this._status('loading', { model: this.modelId, fallback: 'wasm' });
              pipe = null;
            }
          }
          if (!pipe) {
            this._status('loading', { model: this.modelId });
            pipe = await build('wasm');
          }
        }

        if (this._closed) {
          try { await pipe.dispose(); } catch (_) {}
          throw new Error('翻译引擎已关闭');
        }

        this._pipe = pipe;
        this._ready = true;
        this._status('ready', {
          model: this.modelId, device: this._device, dtype: this.dtype, local: this.fromLocal
        });
        return pipe;
      } catch (err) {
        this._loading = null;
        this._ready = false;
        this._status('error', { model: this.modelId, message: String((err && err.message) || err) });
        throw err;
      }
    })();

    return this._loading;
  }

  // ── 低层：一次生成（串行 + 软/硬超时）────────────────────────────────────
  async _generate(userPrompt, { maxTokens, temperature, timeoutMs, fewshot } = {}) {
    if (this._closed) throw new Error('翻译引擎已关闭');
    const pipe = await this.load();
    const rt = await getRuntime();
    const entry = findLLMMTModel(this.modelId);

    const maxNew = Math.max(24, Math.min(1024, Number(maxTokens) || 256));
    const temp = temperature != null ? Number(temperature) : 0.2;
    const tmo = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs;

    const run = async () => {
      // 超时的时钟从「真正轮到自己」开始算，而不是从排队开始算
      const deadline = Date.now() + tmo;

      // 软超时：自定义 StoppingCriteria，每生成一个 token 被调一次，到点就让它收尾。
      // 比硬 kill 干净 —— 已经生成的部分还能用。
      const Deadline = class extends rt.StoppingCriteria {
        _call(input_ids) {
          const stop = Date.now() >= deadline;
          return new Array(input_ids.length).fill(stop);
        }
      };
      const criteria = new rt.StoppingCriteriaList();
      criteria.push(new Deadline());

      let full = '';
      const streamer = new rt.TextStreamer(pipe.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (txt) => { full += txt; }
      });

      // system → （可选）一轮 few-shot 示例对话 → 真正的请求
      const messages = [{ role: 'system', content: this.system }]
        .concat(Array.isArray(fewshot) ? fewshot : [])
        .concat([{ role: 'user', content: String(userPrompt) }]);

      const genOpts = {
        max_new_tokens: maxNew,
        do_sample: temp > 0,
        stopping_criteria: criteria,
        // 翻译任务里复读是头号敌人（opus-mt 就是栽在这上面），轻微的重复惩罚能压住大半。
        // 注意别调太高：中文里「的、了、是」本来就该反复出现，>1.15 会让译文变得别扭。
        repetition_penalty: 1.08,
        streamer
      };
      if (temp > 0) { genOpts.temperature = temp; genOpts.top_p = 0.9; }
      // Qwen3 的 chat template 默认 enable_thinking=true，会先吐一大段 <think>。
      // types/pipelines/text-generation.d.ts 里 tokenizer_encode_kwargs 会被原样
      // 展开进 apply_chat_template，所以能在这里关掉。
      if (entry && entry.thinking) genOpts.tokenizer_encode_kwargs = { enable_thinking: false };

      const raw = pipe(messages, genOpts);
      this._inflight = raw;

      // 硬超时：软超时只在两个 token 之间生效；万一卡在某一次 forward 里出不来，
      // 再等 HARD_TIMEOUT_SLACK 就放弃等待（底层 promise 交给队列去等）。
      let timer = null;
      const guard = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`翻译生成超时（${Math.round((tmo + HARD_TIMEOUT_SLACK) / 1000)}s）`)),
          tmo + HARD_TIMEOUT_SLACK
        );
      });

      try {
        const out = await Promise.race([raw, guard]);
        const last = out && out[0] && out[0].generated_text;
        const text = Array.isArray(last)
          ? String((last[last.length - 1] && last[last.length - 1].content) || '')
          : String(last || '');
        return text || full;
      } catch (err) {
        // 软超时时已经流出来的那部分仍然可用
        if (full.trim()) return full;
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    // 队列：下一次生成必须等「上一次的 run 结束」**并且**「上一次的底层 pipe 调用结束」
    const task = this._queue.then(run, run);
    this._queue = task.then(
      () => (this._inflight || Promise.resolve()).catch(() => {}),
      () => (this._inflight || Promise.resolve()).catch(() => {})
    );
    return task;
  }

  // ── 单句翻译（含质量守卫 + 一次降温重试）──────────────────────────────
  async _translateOne(text, context) {
    const en = oneLine(text);
    if (!isTranslatable(en)) return '';

    const cacheKey = context ? null : en;
    if (cacheKey && this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    const { looksDegenerate, applyGlossary } = await getGlossary();
    // 英译中大致会变短；给 1.2 倍字符 + 48 的余量，再按 token 粗算（1 token ≈ 1.2 中文字）
    const maxTokens = Math.max(48, Math.min(512, Math.ceil(en.length * 1.2) + 48));

    let zh = '';
    // 第一次：低温采样（一点点随机性能帮它跳出模板化的硬译）
    // 第二次：贪心解码（temperature = 0），这是对付劣化最有效的一招 ——
    //         劣化往往是采样把 decoder 带进了一个循环，贪心不会有这个问题。
    for (const temp of [0.2, 0]) {
      let raw = '';
      try {
        raw = await this._generate(buildSinglePrompt(en, context), {
          maxTokens, temperature: temp, fewshot: fewShotSingle(this.targetLang)
        });
      } catch (err) {
        console.warn('[translate-llm] 单句翻译失败：', err);
        continue;
      }
      const cand = parseSingle(raw);
      if (!cand) continue;
      const v = judgeQuality(looksDegenerate, cand, en);
      if (!v.bad) { zh = cand; break; }
      console.warn('[translate-llm] 译文疑似劣化（' + v.reason + '），降温重试：', JSON.stringify(cand).slice(0, 120));
    }

    // 两次都劣化 → 返回空字符串，让调用方走降级（opus-mt / 云端 / 干脆不显示）。
    // **不要**在这里退而求其次地返回劣化的译文：给用户一条「最高法院最高法院」
    // 比不给更糟，她会以为是自己没看懂。
    if (!zh) return '';

    try { zh = String(applyGlossary(en, zh) || zh); } catch (_) {}
    if (cacheKey) this._putCache(cacheKey, zh);
    return zh;
  }

  _putCache(k, v) {
    if (this._cache.size >= CACHE_MAX) {
      // 简单的 FIFO 淘汰：Map 的迭代顺序就是插入顺序
      const first = this._cache.keys().next();
      if (!first.done) this._cache.delete(first.value);
    }
    this._cache.set(k, v);
  }

  // ── 一批（尝试一次「多句一起翻」）────────────────────────────────────
  // 返回对齐好的 string[]，对不齐返回 null。
  async _runBatch(chunk, context, temperature) {
    const n = chunk.length;
    const totalChars = chunk.reduce((a, it) => a + oneLine(it.text).length, 0);
    // 每条留 24 token 的编号/换行开销 + 原文字符数 * 1.2
    // 实测：6 句英文 551 字符时，生产公式给 838 token，而模型实际只生成 94 token。
    // 给得过大没有直接坏处，但会让「被截断」这种失败模式更晚才暴露，也拖慢采样。
    // 收紧到 chars*0.30 + 16n + 24（实测 120 token 仍能完整输出 6 句，96 才开始截断）。
    const maxTokens = Math.max(64, Math.min(1024, Math.ceil(totalChars * 0.30) + 16 * n + 24));
    let raw = '';
    try {
      raw = await this._generate(buildBatchPrompt(chunk, context), {
        maxTokens, temperature, fewshot: fewShotBatch(this.targetLang)
      });
    } catch (err) {
      console.warn('[translate-llm] 批量生成失败：', err);
      this._lastRaw = '';
      return null;
    }
    this._lastRaw = raw;          // 对不齐时留给「打捞式降级」用，别浪费这次生成
    return parseNumbered(raw, n);
  }

  // ── 一批 + 全部退路 ──────────────────────────────────────────────────
  //
  // 对齐失败的处理顺序（**这段是整个模块的安全带**）：
  //   1. 第一次就贪心解码（实测采样版对齐率更低）；
  //   2. 对不齐 → **打捞**：这次生成里解析出几条算几条，只把缺的那几条单独重翻；
  //   3. 编号出现冲突（< 1）或一条都没解析出来 → 整批逐句翻。
  // 最坏情况退化成逐句（n 次），**永远不会超过逐句** —— 之前的递归对半拆会超过。
  // 因此最坏情况是「慢」，不是「错位」。
  async _translateChunk(chunk, context) {
    if (chunk.length === 0) return [];
    if (chunk.length === 1) return [await this._translateOne(chunk[0].text, context)];

    // 第一次就用贪心解码：实测采样版对齐率更低，失败了还要整批重跑，得不偿失
    let res = await this._runBatch(chunk, context, 0);

    // 对不齐就**打捞**：拿到几条算几条，只把缺的那几条单独重翻。
    // 之前是整批作废 + 递归对半拆，一次 generate 能放大到 10 次（实测 56% 的时间在白跑）。
    if (!res) {
      const raw = this._lastRaw || '';
      const { values, conflict } = parseNumberedPartial(raw, chunk.length);
      const okCount = values.filter(v => v != null).length;
      if (!conflict && okCount > 0) {
        console.warn(`[translate-llm] 批量对齐不完整（${okCount}/${chunk.length}），只补缺的 ${chunk.length - okCount} 条`);
        res = values;
      } else {
        console.warn(`[translate-llm] ${chunk.length} 句完全对不齐，逐句翻`);
        res = new Array(chunk.length).fill(null);
      }
      for (let i = 0; i < res.length; i++) {
        if (res[i] == null) res[i] = await this._translateOne(oneLine(chunk[i].text), context);
      }
    }

    // 批量出来的每一条还要单独过一遍质量守卫：
    // 模型可能 9 条都对、唯独第 3 条复读了，这时只重翻第 3 条，不必推翻整批。
    const { looksDegenerate, applyGlossary } = await getGlossary();
    const out = new Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      const en = oneLine(chunk[i].text);
      let zh = res[i];
      const v = judgeQuality(looksDegenerate, zh, en);
      if (v.bad) {
        console.warn('[translate-llm] 批量结果里第', i + 1, '条疑似劣化（' + v.reason + '），单独重翻');
        zh = await this._translateOne(en, context);   // 里面还会再守卫一次
      } else {
        try { zh = String(applyGlossary(en, zh) || zh); } catch (_) {}
      }
      out[i] = zh || '';
    }
    return out;
  }

  /**
   * 翻译一段文本。
   * @param {string} text
   * @param {Object} [opts]
   * @param {string} [opts.context] 前文（可选），用来消解 it / that / this kind of 的指代
   * @returns {Promise<string>} 中文译文；质量守卫判定劣化时返回 ''（调用方应降级）
   */
  async translate(text, { context } = {}) {
    return this._translateOne(text, context ? oneLine(context).slice(-CONTEXT_CHARS) : '');
  }

  /**
   * 批量翻译（**核心方法**）。
   *
   * 为什么要批量：一次把 3~8 句编号后一起给模型，模型能看见上下文 ——
   * "we're not going to read that" 里的 that 指什么、"the one that talks about
   * privacy" 挂在哪个名词上，都要靠前后句才能翻对。顺便还省掉了 N-1 次
   * prompt 预填充（system prompt 有 300 多字，每句重算一遍很浪费）。
   *
   * @param {{id:*, text:string}[]} items
   * @param {Object} [opts]
   * @param {(item:{id:*,text:string}, zh:string, index:number)=>void} [opts.onEach]
   *        每翻完一批就按条回调，界面可以增量刷新（不用等整篇翻完）
   * @param {number} [opts.batchSize=5] 每批几句，会被夹到 1..8
   * @param {string} [opts.context]     整篇开头的前文
   * @returns {Promise<string[]>} 和 items 等长、按序对齐的译文数组；某条劣化则该条为 ''
   */
  async translateMany(items, { onEach, batchSize, context } = {}) {
    const list = Array.isArray(items) ? items : [];
    const out = new Array(list.length).fill('');
    if (!list.length) return out;

    const size = Math.max(1, Math.min(MAX_BATCH, Number(batchSize) || DEFAULT_BATCH));
    const cb = typeof onEach === 'function' ? onEach : null;

    // 空白 / 纯标点的条目直接跳过，不占批次名额也不叫模型
    const work = [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i] || {};
      if (isTranslatable(it.text)) work.push({ index: i, item: it });
      else if (cb) { try { cb(it, '', i); } catch (_) {} }
    }

    // 滚动上下文：用**上一批的原文**（不是译文）当前文。
    // 原文更短、信息更准，而且模型对英文上下文的利用比对中文译文更直接。
    let rolling = context ? oneLine(context).slice(-CONTEXT_CHARS) : '';

    for (let p = 0; p < work.length; p += size) {
      if (this._closed) break;
      const slice = work.slice(p, p + size);
      const chunk = slice.map(w => ({ id: w.item.id, text: w.item.text }));

      let zhs;
      try {
        zhs = await this._translateChunk(chunk, rolling);
      } catch (err) {
        console.warn('[translate-llm] 整批翻译抛错，这批留空走降级：', err);
        zhs = new Array(chunk.length).fill('');
      }

      // 再保一道：无论上面走了哪条退路，长度都必须和输入一致。
      // 这是最后一道防错位的闸 —— 与其让界面拿到错位的数组，不如补空。
      if (!Array.isArray(zhs) || zhs.length !== chunk.length) {
        console.warn('[translate-llm] 内部返回长度不符（期望', chunk.length, '实得', zhs && zhs.length, '），这批全部留空');
        zhs = new Array(chunk.length).fill('');
      }

      for (let k = 0; k < slice.length; k++) {
        const zh = String(zhs[k] || '');
        out[slice[k].index] = zh;
        if (cb) { try { cb(slice[k].item, zh, slice[k].index); } catch (_) {} }
      }

      rolling = buildContext(rolling, chunk);
    }

    return out;
  }

  /** 释放显存/内存。翻完一篇就该调 —— 1GB 权重挂在显存里很费电。 */
  async close() {
    this._closed = true;
    this._ready = false;
    this._cache.clear();
    const pipe = this._pipe;
    this._pipe = null;
    this._loading = null;
    if (pipe) { try { await pipe.dispose(); } catch (_) {} }
    this._status('closed', { model: this.modelId });
  }
}

// 把「旧上下文 + 刚翻完的这批原文」拼成新的滚动上下文，尾部截断到 CONTEXT_CHARS。
// 截断从**后面**保留，因为离得近的句子对指代消解才有用。
function buildContext(prev, chunk) {
  const tail = chunk.map(it => oneLine(it.text)).join(' ');
  const merged = `${String(prev || '')} ${tail}`.trim();
  if (merged.length <= CONTEXT_CHARS) return merged;
  return merged.slice(merged.length - CONTEXT_CHARS).replace(/^\S*\s/, '');
}
