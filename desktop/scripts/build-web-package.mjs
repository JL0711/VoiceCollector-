#!/usr/bin/env node
// 打「网页版」：整个 web/（含内置模型，完全离线）+ server.py + 双击启动的 .command + 说明。
// 解压后双击「启动网页版.command」，会在 Chrome 里打开 http://localhost:8787 。
//
// 用 ditto 打包而不是 zip：ditto 会保留 .command 的可执行权限，解压后直接能双击。

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const OUT = resolve(import.meta.dirname, '..', 'dist');
const ver = JSON.parse(readFileSync(join(REPO, 'web', 'version.json'), 'utf8')).version;

const stage = mkdtempSync(join(tmpdir(), 'vc-webpkg-'));
const dir = join(stage, 'VoiceCollector 网页版');
mkdirSync(dir);
cpSync(join(REPO, 'web'), join(dir, 'web'), { recursive: true, filter: s => !s.endsWith('.DS_Store') });
cpSync(join(REPO, 'server.py'), join(dir, 'server.py'));
// 没装 Python 的 Mac（新版 macOS 不自带）会退到 node server.js —— 以前没打进来，那条路是断的
cpSync(join(REPO, 'server.js'), join(dir, 'server.js'));
cpSync(join(REPO, '启动.command'), join(dir, '启动网页版.command'));
chmodSync(join(dir, '启动网页版.command'), 0o755);
writeFileSync(join(dir, '使用说明.txt'), `VoiceCollector 课堂助手 · 网页版 ${ver}

怎么打开
  双击「启动网页版.command」。会弹出一个黑色窗口，然后自动用 Chrome 打开 http://localhost:8787
  第一次打开 macOS 可能说「无法验证开发者」：右键这个文件 → 打开 → 打开。

用的时候
  · 黑色窗口别关，关了网页就停了（先在网页里点「结束」再关）
  · 地址一定要是 http://localhost:8787 —— 浏览器按网址存数据，换了地址就看不到以前的课
  · 双击两次没关系，会直接打开已经在运行的那一个
  · 需要 Python 3 或 Node.js 其中一个（都没有的话，窗口里会告诉你去哪下 Python）

和桌面版的区别
  · 在 Chrome 里用时，完整流程会同时用 Chrome 自带的实时识别（字幕更快，但要联网）
    和本地 Whisper（离线）。网络不好时点「⚡ 立即开始录音」—— 那个只用本地识别，完全离线。
  · 桌面版有、网页版没有：下课自动存档到 iCloud、App 内更新。
  · 数据存在浏览器里。清浏览器数据会把课删掉，重要的课记得在课程页里导出。
`);

mkdirSync(OUT, { recursive: true });
const zip = join(OUT, `VoiceCollector-网页版-${ver}.zip`);
rmSync(zip, { force: true });
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', dir, zip]);
rmSync(stage, { recursive: true, force: true });
console.log(`✓ ${zip}  ${(statSync(zip).size / 1048576).toFixed(0)} MB`);
