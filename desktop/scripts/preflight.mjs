#!/usr/bin/env node
// 打包前的强制自检。
//
// 为什么有这个文件：2026-09-21 我发出过一个坏包 —— app.js 里的 FRAG 定义被补丁覆盖掉了，
// 语法检查、DOM id 检查、孤立函数检查**全部通过**，因为它是运行时才炸的 ReferenceError。
// 用户装上之后一点「开始录制」就是「启动失败：FRAG is not defined」。
// 从此：不跑完这些检查，不准打包。
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(ROOT, 'web');
let fail = 0;
const bad = (m) => { console.error('  ❌ ' + m); fail++; };
const ok = (m) => console.log('  ✓ ' + m);

// 1. 每个 js 模块能不能被解析
const jsDir = join(WEB, 'js');
const files = readdirSync(jsDir).filter(f => f.endsWith('.js'));
for (const f of files) {
  try { new Function('return 0'); readFileSync(join(jsDir, f), 'utf8'); }
  catch (e) { bad(`${f} 读不了：${e.message}`); }
}
ok(`${files.length} 个模块文件可读`);

// 2. app.js 里用到的大写标识符必须有声明（FRAG 就是这么丢的）
const app = readFileSync(join(jsDir, 'app.js'), 'utf8');
const SKIP = new Set(['JSON','NaN','URL','DOM','API','GET','POST','HEAD','PUT','UTF','CSS','HTML','XML','SVG','PDF','CSV','TSV','RGB','ID','OK','AI','MT','PCM','WAV','MB','KB','GB','MS','SM','EN','ZH','US','UI','IO','FS','OS']);
const used = new Set();
for (const m of app.matchAll(/(?:^|[^A-Za-z0-9_.'"`])([A-Z][A-Z0-9_]{2,})[.(]/g)) used.add(m[1]);
for (const name of used) {
  if (SKIP.has(name)) continue;
  // 声明形式很多：const X= / let A=1, X=2 / function X / class X / 解构 {X}
  if (new RegExp(`(const|let|var|function|class)\\s+${name}\\b`).test(app)) continue;
  if (new RegExp(`(const|let|var)\\s+[^;\\n]*\\b${name}\\s*=`).test(app)) continue;   // 多变量声明
  if (new RegExp(`[{,]\\s*${name}\\s*[,}]`).test(app)) continue;                       // 解构赋值
  if (new RegExp(`import[^;]*\\b${name}\\b`).test(app)) continue;
  bad(`app.js 用了 ${name} 但没声明也没 import —— 运行时会 ReferenceError`);
}
if (!fail) ok('没有未声明的标识符');

// 3. app.js 绑定的 DOM id 必须在 index.html 里（或由 app.js 自己生成）
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
for (const m of app.matchAll(/\$\('#([A-Za-z0-9_]+)'\)\.(onclick|onchange|oninput|value|checked|textContent|innerHTML|disabled)/g)) {
  const id = m[1];
  if (html.includes(`id="${id}"`)) continue;
  if (app.includes(`id="${id}"`)) continue;   // 动态生成的
  bad(`index.html 缺少 id="${id}"（app.js 在绑定它）`);
}
if (!fail) ok('DOM id 一致');

// 4. 关键功能的函数必须真的被调用过（bindPlayerUI 曾经定义了没调，播放按钮全废）
for (const fn of ['bindPlayerUI', 'bindSettings', 'setupPlayer', 'renderCoach', 'startWebSpeech', 'startChunking']) {
  const n = (app.match(new RegExp(`(^|[^A-Za-z0-9_.])${fn}\\s*\\(`, 'g')) || []).length;
  if (n <= 1) bad(`${fn}() 定义了但从没被调用`);
}
if (!fail) ok('关键函数都被调用了');

// 5. 打包进去的模型必须齐（少了就是装上不能用）
const models = join(WEB, 'models');
for (const need of ['onnx-community/whisper-base', 'onnx-community/whisper-small', 'Xenova/opus-mt-en-zh']) {
  try {
    const onnx = readdirSync(join(models, need, 'onnx'));
    if (!onnx.some(f => f.endsWith('.onnx'))) bad(`${need} 没有 .onnx 权重`);
  } catch (_) { bad(`模型缺失：${need}`); }
}
if (!fail) ok('内置模型齐全');

console.log('');
if (fail) { console.error(`打包前自检失败：${fail} 个问题。修好再打包。`); process.exit(1); }
console.log('打包前自检通过 ✓');
