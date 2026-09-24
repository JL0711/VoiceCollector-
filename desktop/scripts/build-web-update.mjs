#!/usr/bin/env node
// 打「网页层更新包」：web/ 里除了 models/（662MB）和 vendor/（67MB）以外的全部文件，约 1MB。
// App 里的「检查更新」下载的就是这个（见 desktop/lib/updater.js）。
//
// 用法：
//   node scripts/build-web-update.mjs                   按 web/version.json 的版本打包
//   node scripts/build-web-update.mjs --version 1.0.2   指定版本（会写进包里的 version.json）
//   node scripts/build-web-update.mjs --out /tmp/x      输出目录（默认 dist/release）
//   node scripts/build-web-update.mjs --break           测试用：故意打一个坏包（app.js 一加载就抛错），
//                                                       用来验证「新版起不来会自动退回」
// 输出最后一行是 JSON：{ file, size, sha256, version } —— 发 Release 时 sha256 要写进正文。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const WEB = resolve(import.meta.dirname, '..', '..', 'web');
const OUT = resolve(opt('--out') || resolve(import.meta.dirname, '..', 'dist', 'release'));
const BREAK = args.includes('--break');

const manifest = JSON.parse(readFileSync(join(WEB, 'version.json'), 'utf8'));
const version = opt('--version') || manifest.version;
// 这些不进更新包：体积大、几乎不变，App 本体里已经有了（lib/server.js 的 overlay 会穿透过去）
const SKIP = new Set(['models', 'vendor', 'node_modules', '.DS_Store']);

const stage = mkdtempSync(join(tmpdir(), 'vc-webupd-'));
const root = join(stage, 'web');
cpSync(WEB, root, {
  recursive: true,
  filter: src => {
    const rel = src.slice(WEB.length).replace(/^\/+/, '');
    const top = rel.split('/')[0];
    return !SKIP.has(top) && !rel.endsWith('.DS_Store');
  }
});
writeFileSync(join(root, 'version.json'), JSON.stringify({ ...manifest, version }, null, 2) + '\n');
if (BREAK) {
  const p = join(root, 'js', 'app.js');
  writeFileSync(p, "throw new Error('故意打坏的更新包（测试自动退回用）');\n" + readFileSync(p, 'utf8'));
}

mkdirSync(OUT, { recursive: true });
const file = join(OUT, `web-${version}.zip`);
rmSync(file, { force: true });
execFileSync('zip', ['-qr', file, '.'], { cwd: root });
rmSync(stage, { recursive: true, force: true });

const buf = readFileSync(file);
const sha256 = createHash('sha256').update(buf).digest('hex');
const info = { file, size: statSync(file).size, sha256, version, broken: BREAK || undefined };
if (!existsSync(file) || info.size < 10000) { console.error('更新包异常地小，没打成'); process.exit(1); }
console.log(`✓ web-${version}.zip  ${(info.size / 1024).toFixed(0)} KB  sha256 ${sha256.slice(0, 16)}…`);
console.log(JSON.stringify(info));
