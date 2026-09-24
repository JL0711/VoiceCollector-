// 把旧端口数据库里的东西合并进当前库（桌面版启动时跑一次）。
//
// 背景：以前桌面版每次启动端口都不一样，浏览器数据按「网址」隔离，
// 所以每次打开都是一个全新的空库 —— 老师、学科、上过的课看上去全「消失」了。
// 端口现在固定了（main.js listenStable），这里负责把以前散落在各个旧库里的东西收回来。
//
// 合并规则（宁可多留，不可丢）：
//   · 老师 / 学科：按名字去重。每个旧库第一次打开都会自动建一个「未命名老师」，
//     21 个库就是 21 个同名的，合成一个。
//   · 课程：按 id，已有的不覆盖；老师 / 学科 id 按上面去重的结果改指过去。
//   · 录音 / 分段：只跟着导进来的课一起进来。
//   · 设置：当前还没有设置时才采用旧的（并把 lastTeacher / lastCourse 改指过去）。
// 任何一步出错都不影响 App 启动 —— 旧库原地不动，下次启动会再试。

import * as db from './db.js';

const SETTINGS_KEY = 'vc.settings.v1';
const BUNDLED_MODELS = /whisper-(base|small)(\.en)?$/;

function unpack(v) {
  if (v == null || typeof v !== 'object') return v;
  if (typeof v.__blob === 'string') {
    const bin = atob(v.__blob);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: v.type || '' });
  }
  if (Array.isArray(v)) return v.map(unpack);
  const o = {};
  for (const k of Object.keys(v)) o[k] = unpack(v[k]);
  return o;
}

const norm = s => String(s || '').trim().toLowerCase();

/**
 * @returns {Promise<{teachers:number, courses:number, sessions:number, audio:number}|null>}
 */
export async function importMigration() {
  const D = window.VCDesktop;
  if (!D || !D.migration) return null;
  let pack = null;
  try { pack = await D.migration.take(); } catch (_) { return null; }
  if (!pack || !Array.isArray(pack.dumps) || !pack.dumps.length) return null;

  const n = { teachers: 0, courses: 0, sessions: 0, audio: 0 };
  try {
    const cur = {
      teachers: await db.all('teachers'),
      courses: await db.all('courses'),
      sessions: new Set((await db.all('sessions')).map(s => s.id))
    };
    const byName = { teachers: new Map(), courses: new Map() };
    for (const k of ['teachers', 'courses']) for (const x of cur[k]) byName[k].set(norm(x.name), x.id);
    const remap = { teachers: new Map(), courses: new Map() };

    // 课程多的库先合并：它们最可能是真正用过的那几次
    const dumps = pack.dumps.slice().sort((a, b) =>
      ((b.stores && b.stores.sessions || []).length) - ((a.stores && a.stores.sessions || []).length));

    const imported = new Set();
    for (const d of dumps) {
      const st = d.stores || {};
      for (const k of ['teachers', 'courses']) {
        for (const x of st[k] || []) {
          if (!x || !x.id) continue;
          const hit = byName[k].get(norm(x.name));
          if (hit) { remap[k].set(x.id, hit); continue; }
          await db.put(k, x);
          byName[k].set(norm(x.name), x.id);
          remap[k].set(x.id, x.id);
          n[k]++;
        }
      }
      const hasAudio = new Set((st.audio || []).map(a => a && a.sessionId));
      for (const s0 of st.sessions || []) {
        if (!s0 || !s0.id || cur.sessions.has(s0.id)) continue;
        // 完全空的记录不要：一句话都没有、没写笔记、没录音、不到 1 秒。
        // 9/21 那个 FRAG bug 每点一次「开始录制」都会先写一条这样的记录再崩，她点了 11 次。
        const said = (s0.segments || []).some(x => x && x.text);
        if (!said && !s0.myNotes && !hasAudio.has(s0.id) && (s0.durationMs || 0) < 1000) continue;
        const s = unpack(s0);
        s.teacherId = remap.teachers.get(s.teacherId) || s.teacherId;
        s.courseId = remap.courses.get(s.courseId) || s.courseId;
        await db.put('sessions', s);
        cur.sessions.add(s.id);
        imported.add(s.id);
        n.sessions++;
      }
      for (const a of st.audio || []) {
        if (!a || !imported.has(a.sessionId)) continue;
        await db.put('audio', unpack(a));
        n.audio++;
      }
      for (const c of st.chunks || []) {
        if (!c || !imported.has(c.sessionId)) continue;
        await db.put('chunks', unpack(c));
      }
      for (const kv of st.kv || []) {
        if (!kv || !kv.k || kv.k === 'cloud.dir') continue;   // 文件夹句柄跨网址带不走
        try { if (await db.get('kv', kv.k)) continue; } catch (_) {}
        await db.put('kv', unpack(kv));
      }
    }

    // 设置：当前还没有才用旧的
    let hasSettings = false;
    try { hasSettings = !!localStorage.getItem(SETTINGS_KEY); } catch (_) {}
    if (!hasSettings) {
      const src = dumps.find(d => d.local && d.local[SETTINGS_KEY]);
      if (src) {
        try {
          const st = JSON.parse(src.local[SETTINGS_KEY]);
          if (st.lastTeacher) st.lastTeacher = remap.teachers.get(st.lastTeacher) || st.lastTeacher;
          if (st.lastCourse) st.lastCourse = remap.courses.get(st.lastCourse) || st.lastCourse;
          // 没内置的大模型（比如 large-v3-turbo）要联网下几百 MB，教室里会卡死，别带过来
          if (st.whisperModel && !BUNDLED_MODELS.test(st.whisperModel)) delete st.whisperModel;
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(st));
        } catch (_) {}
      }
    }

    await D.migration.done(true);
    return n;
  } catch (e) {
    console.warn('[迁移] 合并失败，旧数据原地不动，下次启动再试：', e);
    try { await D.migration.done(false); } catch (_) {}
    return null;
  }
}
