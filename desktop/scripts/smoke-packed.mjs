#!/usr/bin/env node
// 打包之后的最后一道关：在**真的打出来的 App 里**点一次「开始录制」。
//
// 为什么非要有这一步：
//   2026-09-21 14:27 那一版发出去的时候，语法检查、DOM 检查、孤立函数检查全过了，
//   App 也能正常打开、界面完全正常。但 app.js 里 FRAG 的定义被一次补丁覆盖没了，
//   一点「开始录制」就是 "FRAG is not defined"。
//   她第二天早上第一节课要用，而我在打包前没有真的开一次录音。
//   静态检查挡不住这类错误在别处的变种，所以这里必须真的跑一遍。
//
// 用独立的 --user-data-dir，绝不碰她本机的课堂数据。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(import.meta.dirname, '..', 'dist');

const CANDIDATES = [
  ['arm64', join(DIST, 'mac-arm64', 'VoiceCollector.app', 'Contents', 'MacOS', 'VoiceCollector')],
  ['x64',   join(DIST, 'mac',       'VoiceCollector.app', 'Contents', 'MacOS', 'VoiceCollector')]
];

function runOne(label, bin) {
  return new Promise(res => {
    const profile = mkdtempSync(join(tmpdir(), 'vc-smoke-'));
    let p;
    try { p = spawn(bin, ['--smoke-test', `--user-data-dir=${profile}`], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) {
      // -86 = Bad CPU type：Apple 芯片的 Mac 没装 Rosetta 就跑不了 Intel 版，这台机器上测不了，不算失败
      try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
      return res({ label, skipped: e.errno === -86 || /-86/.test(String(e.code)), error: e, raw: '' });
    }
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 180000);
    p.on('close', code => {
      clearTimeout(kill);
      try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
      const m = out.match(/===VC_SMOKE_BEGIN===\s*([\s\S]*?)\s*===VC_SMOKE_END===/);
      let json = null;
      if (m) { try { json = JSON.parse(m[1]); } catch (_) {} }
      res({ label, code, json, raw: out });
    });
  });
}

const found = CANDIDATES.filter(([, bin]) => existsSync(bin));
if (!found.length) {
  console.error('找不到打好的 .app —— 是不是 electron-builder 没跑完？');
  process.exit(1);
}

let bad = 0;
for (const [label, bin] of found) {
  process.stdout.write(`\n▸ 在打包好的 App 里实测（${label}）…\n`);
  const r = await runOne(label, bin);
  if (r.skipped) { console.log(`  ⚠️ 跳过：这台 Mac 没装 Rosetta，跑不了 ${label} 版（不是 App 的问题，Intel 版要在别的电脑上测）`); continue; }
  if (r.error) { console.error(`  ❌ ${label}：启动失败 ${r.error.message}`); bad++; continue; }
  const j = r.json;
  if (!j) {
    console.error(`  ❌ ${label}：App 没有输出冒烟测试结果（退出码 ${r.code}）`);
    console.error(r.raw.split('\n').slice(-25).join('\n'));
    bad++; continue;
  }
  const rec = j.recording || {};
  const mic = (j.probe && j.probe.mic) || {};
  const line = (ok, s) => console.log(`  ${ok ? '✓' : '❌'} ${s}`);
  line(!!mic.ok, `麦克风可用${mic.label ? '：' + mic.label : ''}${mic.error ? ' —— ' + mic.error : ''}`);
  line(!!(j.probe && j.probe.crossOriginIsolated), '跨源隔离已开（多线程 WASM 可用）');
  line(!!rec.addedTeacher, '能新增老师（＋ 对话框）');
  line(!!rec.addedCourse, '能新增学科（＋ 对话框）');
  line(!!rec.started, `能开始录制${rec.engine ? '（引擎：' + rec.engine + '）' : ''}`);
  line(rec.segs > 0, `落段正常（${rec.segs || 0} 段）`);
  line(!!rec.stopped, '能正常结束并保存');
  line(rec.srSupported === false, '没有去碰浏览器实时识别（桌面版里它永远连不上）');
  line(rec.warnVisible === false, `录制时没有红色警告${rec.warnText ? '：' + rec.warnText : ''}`);
  line(rec.brandLeak === false, '界面上没有「晗晗」字样');
  line(rec.dedication === true, '连点 5 下图标能打开藏起来的那一页');
  line(rec.waitingShown === true, '等第一段字时有「正在听」提示（不是一片空白）');
  line(rec.waitingCleared === true, '出字之后提示会撤掉');
  line((rec.diagRed || []).length === 0, `首屏没有红色叉${(rec.diagRed||[]).length ? '：' + rec.diagRed.join(' / ') : ''}`);
  line(rec.sleepBlocked === true, '录制中已阻止 Mac 休眠');
  line(rec.summaryOk === true, `课堂概要不是 Chromium 那坨垃圾${rec.summaryHead ? '（开头：' + rec.summaryHead + '）' : ''}`);
  if (rec.error) console.error(`  ❌ 录制报错：${rec.error}`);
  if (!j.ok) bad++;
}

if (bad) {
  console.error(`\n打包后实测失败 —— 这个包不能给她。\n`);
  process.exit(1);
}
console.log('\n打包后实测通过 ✓ 这个包可以装了\n');
