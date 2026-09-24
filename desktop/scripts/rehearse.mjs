#!/usr/bin/env node
// 演练：把她会遇到的每一种情况，在真的 App 里各跑很多遍。
//
// 冒烟测试（--smoke-test）只证明「这一次能跑」。这里证明的是：
//   · 关掉再开，数据还在（她说「每次很久没打开重新打开都出问题」的真正原因就是这个）
//   · 断网、网络卡死（连得上但永远不回）照样能录、能识别、能翻译
//   · 旧版本留下的数据能收回来；端口被别的程序占了也不丢数据
//   · 更新能装上；更新包是坏的也能自己退回去
//
// 用法：
//   node scripts/rehearse.mjs                       开发版（web/ 源码）
//   node scripts/rehearse.mjs --app <可执行文件>    打包好的 App
//   node scripts/rehearse.mjs --rounds 4            普通场景每个跑几遍
//   node scripts/rehearse.mjs --only persist,update 只跑某几个
// 全程用临时配置目录，绝不碰她的真实数据；存档写临时目录，不进她的 iCloud。

import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const APP = opt('--app');
const ROUNDS = parseInt(opt('--rounds') || '4', 10);
const ONLY = (opt('--only') || '').split(',').filter(Boolean);
const TMP = mkdtempSync(join(tmpdir(), 'vc-rehearse-'));
const ELECTRON = join(DESKTOP, 'node_modules', '.bin', 'electron');

let seq = 0;
const newProfile = () => { const d = join(TMP, 'p' + (++seq)); return d; };

/** 启动一次 App（冒烟模式），返回它吐出来的结果 */
function launch(profile, env = {}) {
  return new Promise(res => {
    const argv = [...(APP ? [] : ['.']), '--smoke-test', `--user-data-dir=${profile}`];
    const bin = APP || ELECTRON;
    const t0 = Date.now();
    const p = spawn(bin, argv, { cwd: DESKTOP, env: { ...process.env, VC_SMOKE_TRANSLATE: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    const kill = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 170000);
    p.on('close', () => {
      clearTimeout(kill);
      const m = out.match(/===VC_SMOKE_BEGIN===\s*([\s\S]*?)\s*===VC_SMOKE_END===/);
      let j = null;
      if (m) { try { j = JSON.parse(m[1]); } catch (_) {} }
      if (!j) j = { ok: false, error: '没有输出结果（进程被杀或崩溃）', tail: out.slice(-600) };
      j._ms = Date.now() - t0;
      j._log = out;
      res(j);
    });
  });
}

const R = j => (j && j.recording) || {};
const C = j => R(j).counts || {};
const EXT = j => ((j && j.net && j.net.external) || []).length;

const results = [];
function record(scenario, name, pass, detail, ms) {
  results.push({ scenario, name, pass: !!pass, detail: detail || '', ms: ms || 0 });
  const mark = pass ? '✓' : '✗';
  console.log(`  ${mark} ${name.padEnd(34)} ${ms ? (ms / 1000).toFixed(0).padStart(3) + 's' : '    '}  ${pass ? '' : detail}`);
}
const why = j => [j.error, R(j).error, j.tail && ('…' + j.tail.slice(-200).replace(/\s+/g, ' '))].filter(Boolean).join(' | ') ||
  JSON.stringify(Object.fromEntries(Object.entries(R(j)).filter(([k, v]) => v === false || (Array.isArray(v) && v.length && k === 'diagRed'))));

/* ───────────────────────── 场景 ───────────────────────── */

const SCENARIOS = {
  // 全新安装：完整流程（新增老师学科 → 录 → 翻译出中文 → 结束 → 概要 → 存档 → 编辑概要）
  async fresh() {
    for (let i = 1; i <= ROUNDS; i++) {
      const j = await launch(newProfile(), { VC_SMOKE_FLOW: 'full' });
      record('fresh', `全新安装 · 完整流程 #${i}`, j.ok && EXT(j) === 0, why(j) + ` 外网=${EXT(j)}`, j._ms);
    }
  },

  // ⚡ 立即开始：什么都不填直接录，下课补老师学科（直接打新名字）
  async quick() {
    for (let i = 1; i <= ROUNDS; i++) {
      const j = await launch(newProfile(), { VC_SMOKE_FLOW: 'quick' });
      const r = R(j);
      const ok = j.ok && r.engine === 'whisper' && /whisper-base/.test(r.wmodel || '') && r.filled;
      record('quick', `快速开始 #${i}`, ok, why(j), j._ms);
    }
  },

  // 断网：对外请求一律立刻失败
  async offline() {
    for (let i = 1; i <= ROUNDS; i++) {
      const flow = i % 2 ? 'full' : 'quick';
      const j = await launch(newProfile(), { VC_NET: 'offline', VC_SMOKE_FLOW: flow });
      record('offline', `断网 · ${flow === 'full' ? '完整' : '快速'} #${i}`, j.ok && EXT(j) === 0,
        why(j) + ` 外网=${EXT(j)}`, j._ms);
    }
  },

  // 网络卡死：对外请求连得上但永远不回 —— 「网络特别差」最常见的样子
  async blackhole() {
    for (let i = 1; i <= ROUNDS; i++) {
      const flow = i % 2 ? 'full' : 'quick';
      const j = await launch(newProfile(), { VC_NET: 'blackhole', VC_SMOKE_FLOW: flow });
      record('blackhole', `网络卡死 · ${flow === 'full' ? '完整' : '快速'} #${i}`, j.ok && !j.hung && EXT(j) === 0,
        why(j) + ` 外网=${EXT(j)}`, j._ms);
    }
  },

  // 关掉再开：同一个配置连续开 6 次，每次录一节。数据必须一直在、端口必须不变。
  // 这是她说「每次重新打开都出问题」的那个 bug（以前端口每次随机 → 每次一个新的空数据库）。
  async persist() {
    const prof = newProfile();
    let port = null;
    for (let k = 0; k < 6; k++) {
      const flow = k % 2 ? 'quick' : 'full';
      const j = await launch(prof, { VC_SMOKE_FLOW: flow });
      const c = C(j);
      if (port == null) port = c.port;
      const dupT = (c.teachers || []).filter(n => n === '冒烟测试老师').length;
      const ok = j.ok && c.sessions === k && c.port === port && dupT <= 1;
      record('persist', `第 ${k + 1} 次打开（应有 ${k} 节课）`, ok,
        `实际 ${c.sessions} 节，端口 ${c.port}（第一次是 ${port}），同名老师 ${dupT} 个 ${j.ok ? '' : why(j)}`, j._ms);
    }
  },

  // 老版本升级：拿她真实配置里的旧数据库（22 个端口各一个）做一份副本来迁移
  async migrate() {
    const real = join(homedir(), 'Library', 'Application Support', 'VoiceCollector');
    if (!existsSync(join(real, 'IndexedDB'))) { record('migrate', '（没有真实旧数据，跳过）', true, ''); return; }
    const prof = newProfile();
    for (const sub of ['IndexedDB', 'Local Storage', 'Service Worker', 'Session Storage']) {
      if (existsSync(join(real, sub))) cpSync(join(real, sub), join(prof, sub), { recursive: true });
    }
    const dbPorts = readdirSync(join(prof, 'IndexedDB')).map(n => (/^http_127\.0\.0\.1_(\d+)\.indexeddb\.leveldb$/.exec(n) || [])[1]).filter(Boolean);
    const j1 = await launch(prof, { VC_TEST_MIGRATE: '1', VC_SMOKE_FLOW: 'full' });
    const c1 = C(j1);
    // App 这次用的端口的库是「当前库」，不是要迁移的旧库（她用过新版之后，真实配置里就会有这个）
    const oldPorts = dbPorts.filter(p => p !== String(c1.port)).length;
    let marked = 0;
    try { marked = JSON.parse(readFileSync(join(prof, 'migrated.json'), 'utf8')).ports.length; } catch (_) {}
    record('migrate', `第一次打开：收回旧数据`, j1.ok && c1.sessions >= 1 && marked >= oldPorts,
      `旧库 ${oldPorts} 个，已记账 ${marked} 个，收回 ${c1.sessions} 节课 ${j1.ok ? '' : why(j1) + ' 存档：' + (R(j1).archiveMsg || '')}`, j1._ms);
    const noDefault = !(c1.teachers || []).filter(n => n === '未命名老师').length || (c1.teachers || []).filter(n => n === '未命名老师').length === 1;
    record('migrate', `21 个「未命名老师」合成最多 1 个`, noDefault, JSON.stringify(c1.teachers));
    const j2 = await launch(prof, { VC_TEST_MIGRATE: '1', VC_SMOKE_FLOW: 'quick' });
    const c2 = C(j2);
    record('migrate', `第二次打开：不重复导入`, j2.ok && c2.sessions === c1.sessions + 1,
      `第一次 ${c1.sessions} 节 → 第二次 ${c2.sessions} 节（应该 +1，是第一次演练录的那节）`, j2._ms);
  },

  // 端口被别的程序占了：换一个端口，但数据要跟过来（迁移兜底）
  async portbusy() {
    const prof = newProfile();
    const j1 = await launch(prof, { VC_SMOKE_FLOW: 'full' });
    const p1 = C(j1).port;
    record('portbusy', `第一次打开（端口 ${p1}）`, j1.ok, why(j1), j1._ms);
    // 占住它
    const blocker = createTcp(() => {});
    const busy = await new Promise(r => blocker.listen(parseInt(p1, 10), '127.0.0.1', () => r(true)).on('error', () => r(false)));
    if (!busy) { record('portbusy', '（占不住端口，跳过）', true, ''); return; }
    const j2 = await launch(prof, { VC_SMOKE_FLOW: 'quick', VC_TEST_MIGRATE: '1' });
    const c2 = C(j2);
    record('portbusy', `端口被占：换端口且数据跟过来`, j2.ok && c2.port !== p1 && c2.sessions === 1,
      `新端口 ${c2.port}，看到 ${c2.sessions} 节课（应该 1） ${j2.ok ? '' : why(j2)}`, j2._ms);
    blocker.close();
    const j3 = await launch(prof, { VC_SMOKE_FLOW: 'full', VC_TEST_MIGRATE: '1' });
    const c3 = C(j3);
    record('portbusy', `端口放开后：记住新端口、数据都在`, j3.ok && c3.port === c2.port && c3.sessions === 2,
      `端口 ${c3.port}，${c3.sessions} 节课（应该 2）`, j3._ms);
  },

  // 更新：假 GitHub → 检查 → 下载安装 → 重开是新版本、数据还在
  async update() {
    const pkg = buildUpdate('1.0.2', false);
    const gh = await fakeGitHub(pkg);
    const prof = newProfile();
    const env = { VC_TEST_UPDATE: '1', VC_UPDATE_API: gh.url };
    const j1 = await launch(prof, { ...env, VC_SMOKE_UPDATE: 'install', VC_SMOKE_FLOW: 'full' });
    const r1 = R(j1);
    record('update', `发现新版本并安装`, j1.ok && r1.updCheck && r1.updCheck.available && r1.updInstall && r1.updInstall.ok,
      JSON.stringify({ check: r1.updCheck && (r1.updCheck.reason || r1.updCheck.version), install: r1.updInstall }), j1._ms);
    const j2 = await launch(prof, { ...env, VC_SMOKE_FLOW: 'quick' });
    const r2 = R(j2);
    record('update', `重开后用的是新版本 1.0.2`, j2.ok && r2.updState && r2.updState.current === '1.0.2' && r2.updState.usingUpdate,
      JSON.stringify(r2.updState) + ' ' + (j2.ok ? '' : why(j2)), j2._ms);
    record('update', `更新之后数据还在`, C(j2).sessions === 1, `看到 ${C(j2).sessions} 节课（应该 1）`);
    const j3 = await launch(prof, { ...env, VC_SMOKE_FLOW: 'full' });
    record('update', `再开一次仍是新版本（不会被误退回）`, j3.ok && R(j3).updState && R(j3).updState.current === '1.0.2',
      JSON.stringify(R(j3).updState), j3._ms);
    gh.close();
  },

  // 坏更新：新版本一打开就崩 → 下一次打开自动退回 App 自带的版本
  async badupdate() {
    const pkg = buildUpdate('1.0.3', true);
    const gh = await fakeGitHub(pkg);
    const prof = newProfile();
    const env = { VC_TEST_UPDATE: '1', VC_UPDATE_API: gh.url };
    const j1 = await launch(prof, { ...env, VC_SMOKE_UPDATE: 'install', VC_SMOKE_FLOW: 'full' });
    record('badupdate', `装上一个坏的更新包`, j1.ok && R(j1).updInstall && R(j1).updInstall.ok, JSON.stringify(R(j1).updInstall), j1._ms);
    const j2 = await launch(prof, { ...env, VC_SMOKE_FLOW: 'quick' });
    record('badupdate', `用坏版本打开：确实起不来（预期）`, !j2.ok, j2.ok ? '居然能跑？坏包没打坏' : '', j2._ms);
    const j3 = await launch(prof, { ...env, VC_SMOKE_FLOW: 'full' });
    const st = R(j3).updState || {};
    record('badupdate', `下一次打开：自动退回、正常可用`, j3.ok && st.usingUpdate === false,
      JSON.stringify(st) + ' ' + (j3.ok ? '' : why(j3)), j3._ms);
    record('badupdate', `退回后第一次的课还在`, C(j3).sessions >= 1, `看到 ${C(j3).sessions} 节课`);
    gh.close();
  },

  // 更新服务器连不上 / 没有新版本：不能影响正常使用
  async updnone() {
    const j1 = await launch(newProfile(), { VC_TEST_UPDATE: '1', VC_UPDATE_API: 'http://127.0.0.1:9', VC_SMOKE_UPDATE: 'install', VC_SMOKE_FLOW: 'full' });
    record('updnone', `更新服务器连不上：照常可用`, j1.ok && R(j1).updCheck && R(j1).updCheck.available === false,
      JSON.stringify(R(j1).updCheck), j1._ms);
    // 还没发布过任何 Release（GitHub 回 404）：不能显示成「检查失败」
    const none = await new Promise(r => { const sv = createServer((q, s) => { s.writeHead(404); s.end('{"message":"Not Found"}'); });
      sv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${sv.address().port}`, close: () => sv.close() })); });
    const j0 = await launch(newProfile(), { VC_TEST_UPDATE: '1', VC_UPDATE_API: none.url, VC_SMOKE_UPDATE: 'install', VC_SMOKE_FLOW: 'quick' });
    const c0 = R(j0).updCheck || {};
    record('updnone', `还没发布过版本：显示「已是最新」而不是「失败」`, j0.ok && c0.available === false && !c0.error && !/失败/.test(c0.reason || ''),
      JSON.stringify(c0), j0._ms);
    none.close();
    const pkg = buildUpdate('1.0.1', false);          // 和内置版本一样
    const gh = await fakeGitHub(pkg);
    const j2 = await launch(newProfile(), { VC_TEST_UPDATE: '1', VC_UPDATE_API: gh.url, VC_SMOKE_UPDATE: 'install', VC_SMOKE_FLOW: 'quick' });
    record('updnone', `已是最新版：不提示更新`, j2.ok && R(j2).updCheck && R(j2).updCheck.available === false,
      JSON.stringify(R(j2).updCheck), j2._ms);
    gh.close();
  }
};

/* ───────────────────────── 假 GitHub ───────────────────────── */

function buildUpdate(version, broken) {
  const out = join(TMP, 'rel');
  const a = ['scripts/build-web-update.mjs', '--version', version, '--out', out];
  if (broken) a.push('--break');
  const lines = execFileSync(process.execPath, a, { cwd: DESKTOP }).toString().trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

function fakeGitHub(pkg) {
  return new Promise(res => {
    const srv = createServer((req, rsp) => {
      const port = srv.address().port;
      if (/\/releases\/latest$/.test(req.url)) {
        rsp.writeHead(200, { 'Content-Type': 'application/json' });
        return rsp.end(JSON.stringify({
          tag_name: 'v' + pkg.version, draft: false,
          html_url: 'https://github.com/MartinMax0711/VoiceCollector-/releases/tag/v' + pkg.version,
          body: `- 测试用更新\nsha256: ${pkg.sha256}\n`,
          assets: [{ name: `web-${pkg.version}.zip`, size: pkg.size,
                     browser_download_url: `http://127.0.0.1:${port}/dl/web-${pkg.version}.zip` }]
        }));
      }
      if (req.url.startsWith('/dl/')) {
        rsp.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': pkg.size });
        return rsp.end(readFileSync(pkg.file));
      }
      rsp.writeHead(404); rsp.end();
    });
    srv.listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }));
  });
}

/* ───────────────────────── 跑 ───────────────────────── */

const names = ONLY.length ? ONLY : Object.keys(SCENARIOS);
const T0 = Date.now();
console.log(`演练对象：${APP ? '打包好的 App ' + APP : '开发版（web/ 源码）'}　普通场景每个 ${ROUNDS} 遍\n`);
for (const n of names) {
  if (!SCENARIOS[n]) { console.log(`（没有场景 ${n}）`); continue; }
  console.log(`▸ ${n}`);
  try { await SCENARIOS[n](); } catch (e) { record(n, '场景本身出错', false, e.message); }
}
rmSync(TMP, { recursive: true, force: true });

const pass = results.filter(r => r.pass).length;
const fail = results.filter(r => !r.pass);
console.log(`\n共 ${results.length} 项，通过 ${pass}，失败 ${fail.length}　用时 ${((Date.now() - T0) / 60000).toFixed(1)} 分钟`);
if (fail.length) {
  console.log('\n失败的：');
  for (const f of fail) console.log(`  ✗ [${f.scenario}] ${f.name}：${f.detail}`);
  process.exit(1);
}
console.log('全部通过 ✓');
