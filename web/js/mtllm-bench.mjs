// mtllm-bench.mjs —— 本地 LLM 翻译（translate-llm.js）的速度 / 对齐基准
//
// ⚠️ 这个文件**不参与运行时**。它不会被 index.html 或任何业务模块 import，
//    只在 node 里手动跑，用来复现 mtllm-tune.md 里的那几张表。
//    业务代码一行都不改 —— 本脚本只读 translate-llm.js 的导出。
//
// ───────────────────────────────────────────────────────────────────────────
// 怎么跑
// ───────────────────────────────────────────────────────────────────────────
//   node web/js/mtllm-bench.mjs --sim                    # 不加载模型，只统计 generate 调用次数（秒级）
//   node web/js/mtllm-bench.mjs --real --lib <path>      # 真的加载 Qwen 跑（分钟级）
//   node web/js/mtllm-bench.mjs --all  --lib <path>
//
// --lib 指向一份 **node 版** transformers 打包产物，例如：
//   <某处>/node_modules/@huggingface/transformers/dist/transformers.node.mjs
// 不能用 web/vendor/transformers/transformers.min.js —— 那是浏览器包，
// 在 node 里没有 onnxruntime-node，会去找 wasm 然后失败。
// 装一份：mkdir -p /tmp/mtbench && cd /tmp/mtbench && npm i @huggingface/transformers@4.3.0
//
// 其它开关：
//   --model <repo>     默认 onnx-community/Qwen2.5-1.5B-Instruct
//   --dtype <dtype>    默认 q4f16（web/models/ 下只预下了这一档）
//   --device <dev>     默认 cpu（node 端只有 cpu；WebGPU 要在浏览器里量）
//   --batch 1,3,5,6,8  要扫的 batchSize 列表（只影响表 B）
//   --n 24             用多少句语料（只影响表 C / 表 E）
//   --group 6          表 C / 表 E 每批几句（默认 6，和 mtllm-client.js 传的值一致）
//
// ⚠️ 2026-09-21 状态：mtllm-tune.md 里的建议 ①（编号行不过 META_STRICT_RE）、
//    ②（打捞式降级 + 放宽 strayHigh）、③ 的前半（第一次就贪心）**已经落地**到
//    translate-llm.js。所以现在跑表 A / 表 C，量到的是**修复后**的行为：
//    表 A 的放大倍数应该落在 1~7x（修复前是 4~10x），表 C 两列应该都是 n/n。
//    想看修复前的行为，用表 C 里的 parseLegacy（本文件内自带一份旧解析器复刻）。
//
// ───────────────────────────────────────────────────────────────────────────
// 这个脚本回答什么
// ───────────────────────────────────────────────────────────────────────────
//   表 A（--sim）  批量对齐失败时，translateMany 会把 1 次生成放大成几次？
//                  用假 _generate 注入**真实的模型输出形态**（截断、多吐一条、
//                  丢分隔符、自由发挥……），数 generate 调用次数。不用加载模型。
//   表 B（--real） batchSize 扫描：prompt token、实际生成 token、每句耗时、对齐成功率。
//   表 C（--real） 同一批输出，生产版 parseNumbered vs「去掉客套话过滤」的解析器，
//                  对齐成功率差多少 —— 这是本次调查的核心结论。
//   表 D（--real） max_new_tokens 收紧到什么程度还安全。
//   表 E（--real） 编号分隔 `k|` vs 纯换行分隔。
//
// 纯 ES Module，无构建步骤，不 import npm 包名（--lib 传绝对路径动态 import）。

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ───────────────────────────────────────────────────────────────────────────
// 〇、参数
// ───────────────────────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));            // web/js
const MODELS_DIR = path.join(HERE, '..', 'models') + path.sep;        // web/models/
const TRANSLATE_LLM = new URL('./translate-llm.js', import.meta.url).href;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes(`--${name}`);

const OPT = {
  lib: arg('lib', null),
  model: arg('model', 'onnx-community/Qwen2.5-1.5B-Instruct'),
  dtype: arg('dtype', 'q4f16'),
  device: arg('device', 'cpu'),
  batches: String(arg('batch', '1,3,5,6,8')).split(',').map(Number).filter(Boolean),
  n: Number(arg('n', 24)),
  group: Math.max(1, Number(arg('group', 6)) || 6)
};
const WANT_SIM = has('sim') || has('all') || (!has('sim') && !has('real') && !has('all'));
const WANT_REAL = has('real') || has('all');

// ───────────────────────────────────────────────────────────────────────────
// 一、语料：24 句真实形态的法学/社科课堂转写
// ───────────────────────────────────────────────────────────────────────────
// 刻意保留了 ASR 的毛病：没有标点、口语填充词（um / okay so / well）、
// 长而散的从句、以及**作业和日期**（opus-mt 强、LLM 弱的那一类）。
// ⚠️ 第 4、17、19、22 句以 "okay so" / "alright" / "well" 开头 —— 这不是凑数，
//    正是它们的正确译文（「好的，…」）触发了生产解析器的误杀，见表 C。
const CORPUS = [
  'The Supreme Court ruled that the First Amendment protects this kind of speech.',
  "we're not going to read that right if it's a lot but that is something that it leads into the question of the changing interpretation and the changing nature of privacy in the digital age.",
  'Your homework is problem set four, due next Friday before midnight.',
  'okay so the reading for next week is the chapter on privacy and technology',
  'and that raises the question of whether the government can compel disclosure of that information',
  'any questions before we move on to the next case',
  'so in Katz the court said that the Fourth Amendment protects people not places',
  'um the dissent argued that the majority was reading the due process clause too broadly',
  'this is the kind of thing that shows up on the exam so write it down',
  'the plaintiff had standing because she suffered a concrete and particularized injury',
  "let's take a ten minute break and then we'll come back to the compelled speech cases",
  'remember that stare decisis is a policy not an inexorable command',
  'the statute was struck down as an unconstitutional content based restriction',
  'and Justice Brandeis called it the right to be let alone',
  'your response paper is due the Tuesday after spring break at five pm',
  'the third party doctrine says you lose your expectation of privacy in shared data',
  'okay so lets look at how the circuits have split on this question',
  'she argued that strict scrutiny should apply to any prior restraint',
  'okay so lets turn to the compelled speech line of cases now',
  'the court applied rational basis review and upheld the regulation',
  'well I think the better reading is that the clause is jurisdictional',
  'alright everyone thats all for today see you on Thursday',
  'and note that the concurrence would have gone further than the majority',
  'the exam is open book but you may not use any generative AI tools'
];

// few-shot 的内容必须和 translate-llm.js 里的 FEWSHOT_* 一致，否则量出来的
// prompt token 数和线上对不上。那两个常量没有导出，这里照抄一份。
const FS_EN = ['okay so the court said that kind of speech is protected', 'due process'];
const FS_ZH = ['好，法院说这类言论是受保护的', '正当程序（due process）'];

const chunk = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };
const toItems = (arr) => arr.map((t, i) => ({ id: i + 1, text: t }));
// 生产版 _runBatch() 算字符数时会先 oneLine()（压掉多余空白），这里照抄，
// 否则原文里有换行/连续空格时算出来的 max_new_tokens 会和线上对不上。
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const chars = (items) => items.reduce((a, x) => a + oneLine(x.text).length, 0);

// 生产版 _runBatch() 里的 max_new_tokens 公式，照抄，别改
const prodCap = (items) =>
  Math.max(64, Math.min(1024, Math.ceil(chars(items) * 1.2) + 24 * items.length + 32));

// ───────────────────────────────────────────────────────────────────────────
// 二、表 A：假 llm，数 generate 调用次数
// ───────────────────────────────────────────────────────────────────────────

// 真实观察到的模型输出形态。base 是「本该输出的 n 条译文」。
const SHAPES = {
  perfect:     (n, b) => b.map((z, i) => `${i + 1}|${z}`).join('\n'),
  loose_dot:   (n, b) => b.map((z, i) => `${i + 1}. ${z}`).join('\n'),
  preamble:    (n, b) => '好的，以下是翻译：\n' + b.map((z, i) => `${i + 1}|${z}`).join('\n'),
  // 生成到 max_new_tokens / 软超时被截断，只吐出前 60%
  truncated:   (n, b) => b.slice(0, Math.max(1, Math.floor(n * 0.6))).map((z, i) => `${i + 1}|${z}`).join('\n'),
  // 模型自己续编了第 n+1 条 -> collectNumbered 的 sawStray 直接判失败
  stray_extra: (n, b) => b.map((z, i) => `${i + 1}|${z}`).join('\n') + `\n${n + 1}|以上就是全部翻译。`,
  // 把两句合并成一行 -> 少一个编号
  merged:      (n, b) => b.slice(0, n - 1).map((z, i) => `${i + 1}|${z}`).join('\n'),
  // repetition_penalty 压掉了分隔符，后半段丢编号
  lost_sep:    (n, b) => b.map((z, i) => (i < 2 ? `${i + 1}|${z}` : z)).join('\n'),
  freeform:    (n, b) => b.join('\n'),
  // 一条复读劣化，其余对齐 -> 只该重翻那一条
  one_degen:   (n, b) => b.map((z, i) => `${i + 1}|${i === 2 ? '最高法院最高法院最高法院最高法院' : z}`).join('\n'),
  // 【关键形态】模型完全对齐，但其中一条的正确译文以「好的，」开头
  okay_so:     (n, b) => b.map((z, i) => `${i + 1}|${i === 3 ? '好的，下一周的阅读材料是隐私和技术章节。' : z}`).join('\n')
};

const FAKE_ZH = [
  '最高法院（Supreme Court）裁定，第一修正案（First Amendment）保护这类言论。',
  '如果篇幅很长我们就不读了，但这引出了数字时代隐私的解释与性质如何变化的问题。',
  '你们的作业是第四套习题，下周五午夜之前交。',
  '好，下周的阅读是关于隐私与技术的那一章。',
  '这就引出了政府能否强制披露的问题。',
  '在进入下一个案子之前还有问题吗？',
  '在 Katz 案里，法院说第四修正案保护的是人，不是地方。',
  '反对意见认为多数意见把正当程序条款读得太宽了。'
];

async function tableA(M) {
  console.log('\n## 表 A：批量对齐失败时 generate 调用次数的放大（假 llm，不加载模型）\n');

  async function run(shape, n, batchSize) {
    const tr = new M.LLMTranslator({ model: OPT.model });
    let calls = 0;
    tr.load = async () => ({});          // 不真的加载
    tr._generate = async (userPrompt) => {
      calls++;
      const m = String(userPrompt).match(/共 (\d+) 句/);
      if (!m) return '这是一条完整的中文译文，长度足够通过质量守卫，内容与原文对应。';
      const cnt = parseInt(m[1], 10);
      // 「批小了模型就数得对」：n<=2 一律给完美输出，这是对生产代码最有利的假设，
      // 所以下面量到的放大倍数是**下界**。
      const base = FAKE_ZH.slice(0, cnt);
      if (cnt <= 2) return SHAPES.perfect(cnt, base);
      return (SHAPES[shape] || SHAPES.perfect)(cnt, base);
    };
    const out = await tr.translateMany(toItems(CORPUS.slice(0, n)), { batchSize });
    return { calls, empty: out.filter((x) => !x).length };
  }

  const quiet = console.warn; console.warn = () => {};
  console.log('| 模型输出形态 | 说明 | generate 次数 | 相对理想 | 空译文 |');
  console.log('|---|---|---|---|---|');
  const DESC = {
    perfect: '完美编号输出', loose_dot: '改用 `1.` 分隔', preamble: '开头有「好的，以下是翻译：」',
    truncated: '被 max_new_tokens/超时截断', stray_extra: '多吐了第 n+1 条', merged: '两句合并成一行',
    lost_sep: '后半段丢了 `|` 分隔符', freeform: '完全没有编号', one_degen: '其中一条复读劣化',
    okay_so: '完全对齐，但一条译文以「好的，」开头'
  };
  for (const s of Object.keys(SHAPES)) {
    const r = await run(s, 6, 6);
    console.log(`| ${s} | ${DESC[s]} | ${r.calls} | ${r.calls}x | ${r.empty} |`);
  }

  console.log('\n> 注：建议 ①②③ 已落地，所以上表量到的是**修复后**的放大倍数（1~7x）。' +
    '\n> 修复前同一张表是 1 / 1 / 1 / 10 / 10 / 10 / 10 / 10 / 2 / 4。\n');

  console.log('\n### batchSize 对放大的影响（6 句，输出形态 = truncated）\n');
  console.log('| batchSize | 理想 generate 次数 | 实际 | 放大 |');
  console.log('|---|---|---|---|');
  for (const bs of [1, 2, 3, 4, 5, 6, 8]) {
    const r = await run('truncated', 6, bs);
    const ideal = Math.ceil(6 / bs);
    console.log(`| ${bs} | ${ideal} | ${r.calls} | ${(r.calls / ideal).toFixed(1)}x |`);
  }
  console.warn = quiet;
}

// ───────────────────────────────────────────────────────────────────────────
// 三、真实模型
// ───────────────────────────────────────────────────────────────────────────

async function loadPipe() {
  if (!OPT.lib) {
    console.error('\n缺少 --lib。需要一份 node 版 transformers，例如：');
    console.error('  mkdir -p /tmp/mtbench && cd /tmp/mtbench && npm i @huggingface/transformers@4.3.0');
    console.error('  node web/js/mtllm-bench.mjs --real --lib /tmp/mtbench/node_modules/@huggingface/transformers/dist/transformers.node.mjs\n');
    process.exit(1);
  }
  const { pipeline, env } = await import(path.resolve(OPT.lib));
  // 只读 web/models/ 下已经预下载的权重，绝不联网 —— 基准要可重复。
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = MODELS_DIR;
  const t = Date.now();
  const pipe = await pipeline('text-generation', OPT.model, { device: OPT.device, dtype: OPT.dtype });
  console.log(`\n# 模型 ${OPT.model} (${OPT.dtype}/${OPT.device}) 载入耗时 ${((Date.now() - t) / 1000).toFixed(1)}s` +
    `  层数=${pipe.model.config.num_hidden_layers} hidden=${pipe.model.config.hidden_size}`);
  return pipe;
}

// ⚠️ 这里复刻的是**修复前**的生产解析器（2026-09-21 09:33 之前的 translate-llm.js）：
//   · 编号行的正文要过 META_STRICT_RE —— 「1|好的，…」被整条删成空 → 缺号 → 判整批失败；
//   · 任何 1..n 之外的编号（哪怕只是末尾多写了第 n+1 条）一律判失败。
// 现行生产版这两条都已经改掉了，所以表 C 的对比是「旧版 vs 现行」，
// 不再是「现行 vs 假想的修好版」。留着它是为了让结论 1 随时可复现，
// 也为了万一有人把这两条改回去时能立刻看出代价。
const NUM_RE = /^[\s>*-]*[【\[(（]?\s*(\d{1,3})\s*[】\])）]?\s*[|｜]\s*(.*)$/;
const LEGACY_META_RE = /^(好的[，,、]|当然[，,、]|以下是|下面是|翻译如下|译文如下|以上是|Here (is|are)\b|Sure[,，]|Translation\s*[：:]|Note\s*[：:]\s*$)/i;
function parseLegacy(raw, n) {
  const got = new Map();
  let stray = false;
  for (const line of String(raw).split(/\r?\n/)) {
    const m = line.trim().match(NUM_RE);
    if (!m) continue;
    const i = parseInt(m[1], 10);
    let v = m[2].trim().replace(/^["'“”『「《]+/, '').replace(/["'“”』」》]+$/, '');
    if (LEGACY_META_RE.test(v)) v = '';        // ← 就是这一行把合法译文删空的
    if (!(i >= 1 && i <= n)) { stray = true; continue; }
    if (!v) continue;
    if (!got.has(i)) got.set(i, v);
  }
  if (stray || got.size !== n) return null;
  return Array.from({ length: n }, (_, i) => got.get(i + 1));
}

async function tablesBCDE(M, pipe) {
  const enc = (s) => pipe.tokenizer.encode(s).length;
  const fsBatch = () => [
    { role: 'user', content: M.buildBatchPrompt(toItems(FS_EN), '') },
    { role: 'assistant', content: FS_ZH.map((t, i) => `${i + 1}|${t}`).join('\n') }
  ];
  const msgsFor = (items, fewshot = true) =>
    [{ role: 'system', content: M.MT_SYSTEM_PROMPT }]
      .concat(fewshot ? fsBatch() : [])
      .concat([{ role: 'user', content: M.buildBatchPrompt(items, '') }]);

  async function gen(msgs, cap, sample = false) {
    const o = { max_new_tokens: cap, do_sample: !!sample, repetition_penalty: 1.08 };
    if (sample) { o.temperature = 0.2; o.top_p = 0.9; }
    const t = Date.now();
    const out = await pipe(msgs, o);
    const txt = String((out[0].generated_text.at(-1) || {}).content || '');
    return { ms: Date.now() - t, txt, tok: enc(txt) };
  }

  // ── 表 B：batchSize 扫描 ────────────────────────────────────────────────
  console.log('\n## 表 B：batchSize 扫描（贪心，带 few-shot，生产版 max_new_tokens 公式）\n');
  console.log('| batchSize | prompt tok | max_new 上限 | 实际生成 tok | 耗时 s | 每句 s | 解码 tok/s | 生产解析器对齐 |');
  console.log('|---|---|---|---|---|---|---|---|');
  const fit = [];
  for (const n of OPT.batches) {
    const items = toItems(CORPUS.slice(0, n));
    const cap = prodCap(items);
    const msgs = msgsFor(items);
    const pt = msgs.reduce((a, m) => a + enc(m.content), 0);
    const r = await gen(msgs, cap);
    fit.push({ tok: r.tok, s: r.ms / 1000 });
    console.log(`| ${n} | ${pt} | ${cap} | ${r.tok} | ${(r.ms / 1000).toFixed(1)} | ` +
      `${(r.ms / 1000 / n).toFixed(2)} | ${(r.tok / (r.ms / 1000)).toFixed(1)} | ${M.parseNumbered(r.txt, n) ? '✅' : '❌'} |`);
  }
  // 线性拟合 耗时 = 固定成本 + 每 token 成本 * token 数
  if (fit.length >= 2) {
    const k = fit.length;
    const sx = fit.reduce((a, x) => a + x.tok, 0), sy = fit.reduce((a, x) => a + x.s, 0);
    const sxx = fit.reduce((a, x) => a + x.tok * x.tok, 0), sxy = fit.reduce((a, x) => a + x.tok * x.s, 0);
    const b = (k * sxy - sx * sy) / (k * sxx - sx * sx);
    console.log(`\n拟合：每次 generate 固定成本 ≈ ${((sy - b * sx) / k).toFixed(2)}s，解码 ≈ ${(1 / b).toFixed(1)} tok/s`);
    console.log('→ 固定成本是常数，所以 batchSize 越大每句越便宜；但对齐风险也越大，见表 C。');
  }

  // ── 表 C：现行解析器 vs 修复前的旧解析器（核心结论）─────────────────────
  console.log(`\n## 表 C：同一批模型输出，现行 parseNumbered vs 修复前的旧解析器（核心）\n`);
  const groups = chunk(CORPUS.slice(0, OPT.n), OPT.group);
  let okProd = 0, okOld = 0, totMs = 0, totTok = 0;
  const falseKills = [];
  for (const g of groups) {
    const items = toItems(g);
    const r = await gen(msgsFor(items), prodCap(items));
    totMs += r.ms; totTok += r.tok;
    const a = !!M.parseNumbered(r.txt, items.length);
    const b = !!parseLegacy(r.txt, items.length);
    if (a) okProd++;
    if (b) okOld++;
    if (a && !b) falseKills.push(r.txt);
    console.log(`  批 ${items.length} 句: 现行 parseNumbered=${a ? '✅' : '❌'}  修复前=${b ? '✅' : '❌'}  ` +
      `${(r.ms / 1000).toFixed(1)}s ${r.tok}tok`);
  }
  console.log(`\n现行 parseNumbered ${okProd}/${groups.length}   修复前的旧解析器 ${okOld}/${groups.length}`);
  console.log(`纯生成耗时 ${(totMs / 1000).toFixed(1)}s / ${OPT.n} 句 = ${(totMs / 1000 / OPT.n).toFixed(2)} s/句（无放大）`);
  if (falseKills.length) {
    console.log('\n### 模型完全对齐、现行解析器收得下、但会被修复前的解析器判失败的批：');
    falseKills.forEach((t) => console.log('  ' + JSON.stringify(t.slice(0, 240))));
  }

  // ── 表 D：max_new_tokens 收紧 ──────────────────────────────────────────
  //
  // ⚠️ 「被截断」不能用 `生成 tok >= cap - 2` 来判 —— 那是个**假阳性制造机**：
  //    译文正好用掉 94 token 时，cap=96 会被误判成「已截断」，而它其实和不设限的
  //    输出一字不差。这里改成和**不设限那一档的输出逐字对比**：文本不同才算截断。
  //    （第一版报告就是栽在这个假阳性上，把真实截断阈值 88 报成了 96。）
  const six = toItems(CORPUS.slice(0, 6));
  console.log('\n## 表 D：max_new_tokens 收紧（6 句一批，贪心）\n');
  console.log(`（6 句英文共 ${chars(six)} 字符，生产公式给 ${prodCap(six)} token）\n`);
  console.log('| max_new_tokens | 生成 tok | 耗时 s | 对齐 | 与不设限输出一致 | 被截断 |');
  console.log('|---|---|---|---|---|---|');
  let baseTxt = null;
  for (const cap of [prodCap(six), 256, 160, 120, 96, 88, 80, 72, 64]) {
    const r = await gen(msgsFor(six), cap);
    if (baseTxt === null) baseTxt = r.txt;
    const same = r.txt === baseTxt;
    const aligned = !!M.parseNumbered(r.txt, 6);
    // 截断 = 撞上了上限 **并且** 吐出来的东西和不设限那一档不一样
    const cut = !same && r.tok >= cap - 2;
    console.log(`| ${cap} | ${r.tok} | ${(r.ms / 1000).toFixed(1)} | ${aligned ? '✅' : '❌'} | ` +
      `${same ? '是' : '否'} | ${cut ? '是 ⚠️' : '否'} |`);
    // 最危险的一格：被截断了，编号却还是 1..n 齐全 —— 解析器看不出来，
    // 界面拿到的是**半句话**。这是收紧 max_new_tokens 的真正代价。
    if (cut && aligned) {
      console.log(`  ⚠️ cap=${cap}：已截断但仍通过 parseNumbered —— **静默截断**。` +
        `末行 = ${JSON.stringify(r.txt.split(/\r?\n/).pop().slice(-24))}`);
    }
  }

  // ── 表 E：编号分隔 vs 纯换行分隔 ───────────────────────────────────────
  console.log(`\n## 表 E：编号 \`k|\` vs 纯换行（贪心，每批 ${OPT.group} 句）\n`);
  const nlPrompt = (items) => [
    `【待翻译】共 ${items.length} 句，每行一句：`,
    ...items.map((it) => it.text.replace(/\s+/g, ' ').trim()),
    '',
    `只输出 ${items.length} 行中文译文，每行对应上面同一行的原文。不要编号，不要输出英文，不要解释。`
  ].join('\n');
  let nlOk = 0, nlMs = 0, nlTok = 0;
  for (const g of groups) {
    const items = toItems(g);
    const msgs = [
      { role: 'system', content: M.MT_SYSTEM_PROMPT },
      { role: 'user', content: nlPrompt(toItems(FS_EN)) },
      { role: 'assistant', content: FS_ZH.join('\n') },
      { role: 'user', content: nlPrompt(items) }
    ];
    const r = await gen(msgs, Math.ceil(chars(items) * 1.2) + 32);
    nlMs += r.ms; nlTok += r.tok;
    const lines = r.txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length === items.length) nlOk++;
    console.log(`  行数 ${lines.length}/${items.length}  ${(r.ms / 1000).toFixed(1)}s ${r.tok}tok`);
  }
  console.log(`\n纯换行：对齐 ${nlOk}/${groups.length}，${(nlMs / 1000).toFixed(1)}s，生成 ${nlTok} tok（编号版生成 ${totTok} tok）`);
  console.log('→ 纯换行少生成约 ' + Math.max(0, totTok - nlTok) + ' token，但丢掉了「编号能自证对齐」这个安全属性。');
}

// ───────────────────────────────────────────────────────────────────────────
// 四、main
// ───────────────────────────────────────────────────────────────────────────
const M = await import(TRANSLATE_LLM);
if (WANT_SIM) await tableA(M);
if (WANT_REAL) {
  const pipe = await loadPipe();
  await tablesBCDE(M, pipe);
}
console.log('\n完成。结论见 web/js/mtllm-tune.md。');
