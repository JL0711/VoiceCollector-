#!/usr/bin/env node
// 打包前把 ../web 复制进 desktop/app-web
//
// 为什么要复制？
//   electron-builder 的 files 字段只认「项目目录（= desktop/）以内」的路径，
//   写 "../web/**/*" 它会当成 app 目录下的 web 再往上跳，结果要么报错要么什么都不打。
//   另一条路是 extraResources: [{from:'../web', to:'web'}]，能把文件放到
//   Contents/Resources/web，但那样文件散在 asar 外面、路径依赖 process.resourcesPath，
//   而且和「asar 内读文件」的写法不统一。
//   直接在打包前把 web/ 同步成 desktop/app-web/，是最简单、最好验证的方案：
//   files 里就是普通的 "app-web/**/*"，全部塞进 asar，main.js 用 __dirname 就能读到
//   （Electron 给 fs 打了补丁，读 asar 内的文件跟读普通文件一样）。
//
// 顺带把 web/icons/icon-512.png 复制成 build/icon.png，
// electron-builder 会拿它自动生成 .icns / .ico。
//
// 用法：node scripts/sync-web.js

'use strict';

const fs = require('fs');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const SRC = path.resolve(DESKTOP, '..', 'web');
const DST = path.join(DESKTOP, 'app-web');
const ICON_SRC = path.join(SRC, 'icons', 'icon-512.png');
const ICON_DST = path.join(DESKTOP, 'build', 'icon.png');

// 不需要打进 App 的东西
const SKIP_DIR = new Set(['node_modules', '.git', '.DS_Store']);
const SKIP_FILE = new Set(['.DS_Store', 'Thumbs.db']);
// 没下完的模型分片（.part）不要打进包里，否则装出来的 App 一用就报模型损坏
const SKIP_EXT = ['.part', '.crdownload', '.tmp', '.download'];

let fileCount = 0;
let byteCount = 0;
const skipped = [];

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      if (SKIP_DIR.has(name)) continue;
      copyDir(s, d);
    } else if (st.isFile()) {
      if (SKIP_FILE.has(name)) continue;
      if (SKIP_EXT.some(x => name.toLowerCase().endsWith(x))) {
        console.warn('  ! 跳过未下载完的文件：' + path.relative(SRC, s));
        skipped.push(path.relative(SRC, s));
        continue;
      }
      fs.copyFileSync(s, d);
      fileCount++;
      byteCount += st.size;
    }
  }
}

function main() {
  if (!fs.existsSync(path.join(SRC, 'index.html'))) {
    console.error('✗ 找不到 ' + SRC + '/index.html');
    console.error('  请确认 desktop/ 和 web/ 是同一级目录。');
    process.exit(1);
  }

  console.log('同步网页文件：');
  console.log('  从  ' + SRC);
  console.log('  到  ' + DST);
  rmrf(DST);
  copyDir(SRC, DST);
  console.log('  ✓ ' + fileCount + ' 个文件，' + (byteCount / 1024 / 1024).toFixed(1) + ' MB');
  if (skipped.length) {
    console.warn('  ! 有 ' + skipped.length + ' 个文件还没下载完，已跳过。');
    console.warn('    如果本地 Whisper / 翻译模型是随包分发的，请等模型下完再重新打包。');
  }

  // 图标
  if (fs.existsSync(ICON_SRC)) {
    fs.mkdirSync(path.dirname(ICON_DST), { recursive: true });
    fs.copyFileSync(ICON_SRC, ICON_DST);
    console.log('  ✓ 图标 build/icon.png（来自 web/icons/icon-512.png）');
  } else {
    console.warn('  ! 没找到 ' + ICON_SRC + '，打包会用 Electron 默认图标');
  }

  // 自检：关键文件必须在
  const must = ['index.html', 'css/style.css', 'js/app.js', 'manifest.webmanifest'];
  const missing = must.filter(f => !fs.existsSync(path.join(DST, f)));
  if (missing.length) {
    console.error('✗ 同步后仍缺少：' + missing.join(', '));
    process.exit(1);
  }
  console.log('  ✓ 自检通过：' + must.join('、') + ' 都在');
}

main();
