import { $, $$, uid, hhmmss, mmss, dateCN, esc, words, download, debounce, md2html } from './util.js';
import * as db from './db.js';
import { settings, save as saveSettings, PRESETS, LANGS } from './store.js';
import { ASR, SR_SUPPORTED, IS_DESKTOP } from './asr.js';
import { Mic, listMics, keepAwake } from './mic.js';
import * as T from './translate.js';
import { summarize, localSummary } from './summarize.js';
import { aiReady, aiName, whisperReady, transcribe } from './ai.js';
import { saveAll, toMarkdown } from './export.js';

/* ============================== 全局状态 ============================== */
const S = {
  teachers: [], courses: [], sessions: [],
  cur: null,          // 正在录制的 session
  view: 'record',
  mic: null, asr: null, wake: null,
  t0: 0, paused: false, pausedMs: 0, pauseAt: 0,
  timer: null, raf: null,
  transQ: [], transRunning: 0,
  detail: null
};

const LIVE_KEEP = 120;   // 实时视图最多保留多少条

// 实时判断「老师在不在强调这句」，用来给字幕上色。
// ⚠️ 不能在模块顶层就 mod('coach') —— 那时 lazy 还在暂时性死区（TDZ），
//    抛出的 ReferenceError 会被 .catch 吞掉，表现为「上色功能静默失效」。
//    所以放到 init() 里加载。
let COACH_EMPH = null;

// 绑事件的安全包装：元素不存在时只警告，不让整个 init 崩掉。
// （之前就吃过亏：HTML 里少了一个 id，init 抛异常中断，**后面所有按钮全部没绑上**，
//   表面上看是「有些功能点了没反应」，极难排查。）
function on(sel, evt, fn) {
  const el = document.querySelector(sel);
  if (!el) { console.warn('[VC] 找不到元素，跳过绑定：' + sel); return null; }
  el.addEventListener(evt, fn);
  return el;
}

const toast = (msg, ms = 2600) => {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms);
};

/* ============================== 对话框 ============================== */
function dialog(title, fields, okText = '确定') {
  return new Promise(res => {
    const d = $('#dlg');
    $('#dlgTitle').textContent = title;
    $('#dlgOk').textContent = okText;
    $('#dlgBody').innerHTML = fields.map(f => `
      <label class="field"><span>${esc(f.label)}</span>
      ${f.type === 'select'
        ? `<select name="${f.name}">${f.options.map(o => `<option value="${esc(o.v)}" ${o.v === f.value ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`
        : f.type === 'combo'
        ? `<input name="${f.name}" type="text" list="dl-${f.name}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off">
           <datalist id="dl-${f.name}">${(f.options || []).map(o => `<option value="${esc(o)}">`).join('')}</datalist>`
        : f.type === 'textarea'
        ? `<textarea name="${f.name}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
        : `<input name="${f.name}" type="text" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}">`}
      </label>`).join('');
    d.returnValue = '';
    d.showModal();
    const first = d.querySelector('#dlgBody input,#dlgBody textarea,#dlgBody select');
    if (first) setTimeout(() => first.focus(), 30);
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') return res(null);
      const out = {};
      $$('#dlgBody [name]').forEach(el => out[el.name] = el.value.trim());
      res(out);
    }, { once: true });
  });
}

/* ============================== 路由 ============================== */
function go(view, arg) {
  S.view = view;
  $$('.view').forEach(v => v.hidden = true);
  const el = $('#view-' + view);
  if (el) el.hidden = false;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.go === view));
  if (view === 'library') renderLibrary();
  if (view === 'notes') renderNotes();
  if (view === 'settings') renderSettings();
  if (view === 'session') openSession(arg);
}

// 按需加载重模块：不用到就不加载，省内存也省电
const lazy = {};
async function mod(name) {
  if (lazy[name]) return lazy[name];
  try { lazy[name] = await import(`./${name}.js`); }
  catch (e) { throw new Error(`模块 ${name}.js 加载失败：${e.message}`); }
  return lazy[name];
}

/* ============================== 老师 / 学科 ============================== */
async function loadLists() {
  S.teachers = (await db.all('teachers')).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  S.courses = (await db.all('courses')).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const st = settings();
  // 优先保留「界面上现在选的那个」。
  // 因为新增学科也会调 loadLists()，而它会把两个下拉框都重建一遍 ——
  // 只认 settings 里的 lastTeacher 的话，刚新增并选好的老师会在这次重建里被清掉，
  // 接着点「开始录制」就会莫名其妙弹「请先选择老师」。开学第一节课最容易踩到。
  const cur = sel => { const el = $(sel); return el ? el.value : ''; };
  const pick = (list, ...prefer) => {
    for (const id of prefer) if (id && list.some(x => x.id === id)) return id;
    return list.length === 1 ? list[0].id : '';
  };
  fillSelect($('#selTeacher'), S.teachers, pick(S.teachers, cur('#selTeacher'), st.lastTeacher), '— 不选也可以 —');
  fillSelect($('#selCourse'), S.courses, pick(S.courses, cur('#selCourse'), st.lastCourse), '— 不选也可以 —');
}
function fillSelect(el, list, selected, placeholder) {
  el.innerHTML = `<option value="">${placeholder}</option>` +
    list.map(x => `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
}
const nameOf = (list, id) => (list.find(x => x.id === id) || {}).name || '';

async function addEntity(store, label) {
  const r = await dialog('新增' + label, [{ name: 'name', label: label + '名称', placeholder: label === '老师' ? '例如：Prof. Smith' : '例如：微观经济学 ECON101' }]);
  if (!r || !r.name) return null;
  // 重名就直接选中已有的，不再建一个同名的（以前她那里攒了 21 个「未命名老师」）
  const list = store === 'teachers' ? S.teachers : S.courses;
  const hit = list.find(x => String(x.name || '').trim().toLowerCase() === r.name.trim().toLowerCase());
  const item = hit || { id: uid(), name: r.name.trim(), createdAt: Date.now() };
  if (!hit) await db.put(store, item);
  await loadLists();
  const sel = store === 'teachers' ? $('#selTeacher') : $('#selCourse');
  sel.value = item.id;
  return item;
}

function bindDedication() {
  const logo = document.querySelector('.brand .logo');
  if (!logo) return;
  logo.style.cursor = 'pointer';
  logo.title = '';                       // 不给提示，不然就不叫藏了
  let n = 0, t = null;
  logo.onclick = () => {
    n++;
    clearTimeout(t);
    t = setTimeout(() => { n = 0; }, 3000);   // 3 秒内连点才算
    if (n < 5) return;
    n = 0;
    const d = $('#dlgHi');
    if (d && !d.open) d.showModal();
  };
}

/* ============================== 更新 ============================== */
// 只换网页层（约 1MB），不碰 App 本体，不需要签名 —— 见 desktop/lib/updater.js。
// 规矩：
//   · 发现新版只亮一个小按钮，**绝不弹窗打断**，更不会在录制中动任何东西
//   · 她点了才下载；下载完也要她点「重启生效」
//   · 新版本起不来会自动退回（main 进程的 .pending 机制），设置里也有手动「退回上一版」
// 默认识别模型。2026-10-06 第一次真实课堂录音（59 分钟现代艺术课）实测：
//   small 比 base 准得多 —— base 把 ancient Greek wall 听成 brick wall、urban 听成 herbal、
//   「bring art and art together」听成「crime and crime」；死循环也少得多（3 处 vs 24 处）。
//   small 在 Apple 芯片上整段识别 9 倍实时，上课实时识别 25 秒一段约 3 秒识别完，完全跟得上。
// 所以快速开始和普通录制都用 small；只有没有 WebGPU 的老电脑（只能 CPU 跑，small 会跟不上）才退回 base。
const SMALL_MODEL = 'onnx-community/whisper-small';
const BASE_MODEL = 'onnx-community/whisper-base';
const defaultModel = info => (info && info.webgpu === false ? BASE_MODEL : SMALL_MODEL);
const UPD = () => (IS_DESKTOP && window.VCDesktop && window.VCDesktop.update) || null;
let UPD_INFO = null;

async function checkUpdate({ silent = false } = {}) {
  const U = UPD(); if (!U) return null;
  let r;
  try { r = await U.check(); } catch (e) { r = { available: false, reason: '检查失败：' + e.message }; }
  UPD_INFO = r && r.available ? r : null;
  $('#btnUpdPill').hidden = !UPD_INFO;
  if (!silent) {
    if (UPD_INFO) openUpdateDialog();
    else toast(r && r.reason ? r.reason : '已经是最新版', 3500);
  }
  return r;
}

function openUpdateDialog() {
  const r = UPD_INFO; if (!r) return;
  const d = $('#dlgUpd');
  $('#updTitle').textContent = '新版本 ' + r.version;
  $('#updNotes').innerHTML = (r.notes || []).map(n => `<li>${esc(n)}</li>`).join('');
  $('#updBar').hidden = true; $('#updBarFill').style.width = '0';
  const go = $('#btnUpdGo'), later = $('#btnUpdLater');
  go.disabled = false; later.disabled = false;
  if (S.cur) {
    $('#updMsg').textContent = '正在录课，现在不更新。下课点「结束」之后再来点这里。';
    go.hidden = true;
  } else if (r.full) {
    $('#updMsg').textContent = r.reason || '这次需要下载完整安装包。';
    go.hidden = false; go.textContent = '去下载';
    go.onclick = () => { U_open(r.pageUrl); d.close(); };
  } else {
    const mb = r.size ? (r.size / 1048576).toFixed(1) + ' MB' : '';
    $('#updMsg').textContent = `只更新界面和程序逻辑${mb ? '（' + mb + '）' : ''}，识别模型不用重新下载。你的课程和录音不受影响。`;
    go.hidden = false; go.textContent = '更新';
    go.onclick = () => installUpdate();
  }
  later.onclick = () => d.close();
  if (!d.open) d.showModal();
}

function U_open(url) { const U = UPD(); if (U && url) U.openPage(url); }

async function installUpdate() {
  const U = UPD(); if (!U || !UPD_INFO) return;
  if (S.cur) return toast('正在录课，下课再更新');
  const go = $('#btnUpdGo'), later = $('#btnUpdLater');
  go.disabled = true; later.disabled = true;
  $('#updBar').hidden = false;
  $('#updMsg').textContent = '正在下载…';
  const off = U.onProgress(p => { $('#updBarFill').style.width = Math.round(p * 100) + '%'; });
  let r;
  try { r = await U.install(); } catch (e) { r = { ok: false, reason: e.message }; }
  off();
  later.disabled = false;
  if (!r || !r.ok) {
    $('#updMsg').textContent = '没装成：' + ((r && r.reason) || '未知原因') + '。现在的版本照常能用。';
    go.disabled = false; go.textContent = '重试';
    return;
  }
  $('#updBarFill').style.width = '100%';
  $('#updMsg').textContent = '装好了，重启一下就生效（几秒钟）。';
  $('#btnUpdPill').hidden = true;
  go.disabled = false; go.textContent = '重启生效';
  go.onclick = () => { if (S.cur) return toast('正在录课，下课再重启'); U.relaunch(); };
  later.textContent = '下次打开再说';
}

async function bindUpdater() {
  const U = UPD(); if (!U) return;
  // 能跑到这里 = 这个网页层能正常起来，告诉主进程撤掉 .pending（否则下次启动会自动退回）
  try { await U.bootOk(); } catch (_) {}

  $('#btnUpdPill').onclick = openUpdateDialog;
  $('#btnUpdCheck').onclick = () => checkUpdate({ silent: false });
  $('#btnUpdRevert').onclick = () => {
    if (S.cur) return toast('正在录课，下课再说');
    if (confirm('退回 App 自带的版本？你的课程和录音都不受影响。')) U.revert();
  };

  let st = null;
  try { st = await U.state(); } catch (_) {}
  if (st) {
    $('#updRow').hidden = false;
    $('#updVer').textContent = '版本 ' + st.current + (st.usingUpdate ? '（已在线更新）' : '');
    $('#btnUpdRevert').hidden = !st.usingUpdate;
  }

  // 开 App 10 秒后悄悄查一次。只亮顶栏小按钮，不弹窗。
  // 正在录课、或者没联网，都直接跳过，什么也不说。
  setTimeout(() => {
    if (S.cur || !navigator.onLine) return;
    checkUpdate({ silent: true }).catch(() => {});
  }, 10000);
}

/* ============================== 诊断 ============================== */
async function renderDiag() {
  const box = $('#diag');
  const items = [];
  const push = (c, t) => items.push([c, t]);
  const draw = () => box.innerHTML = items.map(([c, t]) => `<span class="${c}">${esc(t)}</span>`).join('');

  // 桌面版 SR_SUPPORTED 恒为 false（asr.js 顶部），但那是**设计如此**，不是坏了。
  // 直接拿它当好/坏上色的话，她一打开 App 第一眼就是「开始录制」按钮正上方一条红色的
  // 「✗ 此浏览器不支持实时识别 — 请用 Chrome/Edge」—— 在一个我们让她用的桌面 App 里，
  // 还指她去用手边没有的 Chrome。她不会调试，只会得出「坏了」或者「不敢点」。
  push(IS_DESKTOP || SR_SUPPORTED ? 'ok' : 'no',
       IS_DESKTOP    ? '✓ 本地 Whisper 识别（离线，断网也能用）'
     : SR_SUPPORTED  ? '✓ 浏览器支持实时识别'
     :                 '✗ 此浏览器不支持实时识别 — 请用 Chrome/Edge');
  push(window.isSecureContext ? 'ok' : 'no', window.isSecureContext ? '✓ 安全上下文' : '✗ 非 https/localhost，麦克风不可用');
  const st = settings();
  push(aiReady() ? 'ok' : 'mid', aiReady() ? '✓ AI 已配置：' + aiName() : '· 未配置 AI（概要将用离线算法）');
  draw();

  let perm = 'prompt';
  try { perm = (await navigator.permissions.query({ name: 'microphone' })).state; } catch (_) {}
  // 桌面版：navigator.permissions 报的是 Chromium 内部的状态，
  // 真正会卡住她的是 macOS 系统级的麦克风权限（TCC），这里看不见。
  // 所以别给一个可能是假的绿勾，直接告诉她怎么自查。
  items.splice(2, 0, IS_DESKTOP
    ? (perm === 'denied'
        ? ['no', '✗ 麦克风被拒绝 — 系统设置 → 隐私与安全性 → 麦克风，勾上 VoiceCollector']
        : ['mid', '· 麦克风：点下面「麦克风试音」确认音量条在动'])
    : perm === 'granted' ? ['ok', '✓ 麦克风已授权']
    : perm === 'denied' ? ['no', '✗ 麦克风被拒绝 — 点地址栏左侧图标开启']
    : ['mid', '· 麦克风待授权（点开始时会询问）']);
  draw();

  let tItem;
  if (st.dstLang === 'off') tItem = ['mid', '· 已关闭翻译'];
  else {
    const av = await T.builtinAvailability(st.srcLang, st.dstLang);
    if (av === 'available') tItem = ['ok', '✓ 浏览器内置翻译（离线）'];
    else if (aiReady()) tItem = ['ok', '✓ 用 AI 翻译'];
    else {
      // 本地翻译模型是否已经打包进来了
      let local = false;
      try {
        const r = await fetch('./models/Xenova/opus-mt-en-zh/config.json', { method: 'HEAD' });
        local = r.ok;
      } catch (_) {}
      tItem = local ? ['ok', '✓ 本地翻译模型（已内置，离线可用）']
        : (av === 'downloadable' || av === 'downloading') ? ['mid', '· 内置翻译需下载语言包（开始时自动下）']
        : ['no', '✗ 没有可用的翻译：跑一次 scripts/fetch-models.mjs，或在设置里填 API Key'];
    }
  }
  items.push(tItem);
  draw();
}

/* ============================== 麦克风试音 ============================== */
async function micTest() {
  const btn = $('#btnMicTest');
  btn.disabled = true;
  const box = $('#testBox'); box.hidden = false;
  $('#testText').textContent = '正在打开麦克风…';
  const st = settings();
  const m = new Mic();
  let asr = null;
  try {
    await m.start({ deviceId: st.micId, agc: st.agc, ns: st.ns });
  } catch (e) {
    $('#testText').textContent = '打不开麦克风：' + e.message;
    btn.disabled = false; return;
  }
  $('#testText').textContent = '请说话……（10 秒）';
  let peak = 0;
  const loop = () => { const l = m.level(); peak = Math.max(peak, l); $('#testMeter').style.width = (l * 100) + '%'; S.raf = requestAnimationFrame(loop); };
  loop();
  let heard = '';
  if (SR_SUPPORTED) {
    asr = new ASR({
      lang: st.srcLang,
      onFinal: t => { heard += t + ' '; $('#testText').textContent = heard; },
      onInterim: t => { if (t) $('#testText').textContent = heard + t; },
      onError: (c, f, msg) => { if (msg) $('#testText').textContent = msg; }
    });
    asr.start();
  }
  setTimeout(async () => {
    cancelAnimationFrame(S.raf);
    asr && asr.stop();
    m.stop();
    $('#testMeter').style.width = '0%';
    const lvl = peak < 0.03 ? '❌ 几乎没听到声音，请检查麦克风或把音量调大'
      : peak < 0.12 ? '⚠️ 声音有点小，老师离得远的话建议打开「自动增益」或用外接麦克风'
      : '✅ 音量正常';
    $('#testText').textContent = `${lvl}（峰值 ${(peak * 100).toFixed(0)}%）` + (heard ? `\n识别到：${heard}` : (SR_SUPPORTED ? '\n没识别到文字——说几句英文再试一次。' : ''));
    $('#testText').style.whiteSpace = 'pre-wrap';
    btn.disabled = false;
    renderDiag();
  }, 10000);
}

/* ============================== 识别引擎 ============================== */
function resolveEngine() {
  const st = settings();
  const e = st.engine || 'auto';
  // 桌面版没有浏览器实时识别（见 asr.js 顶部）。
  // 这里必须把**存档里的旧值**也纠正过来 —— 她之前在浏览器里用过 hybrid，
  // 那个值会一直留在 localStorage 里，不纠正的话装了桌面版还是会去启动一个
  // 永远连不上的引擎，然后一直弹「识别服务网络异常」。
  if (IS_DESKTOP && (e === 'webspeech' || e === 'hybrid')) return 'whisper';
  if (e !== 'auto') return e;
  if (!SR_SUPPORTED) return 'whisper';      // Electron 桌面版 / Safari：浏览器实时识别不可用
  // 省电模式只跑一个引擎（浏览器识别几乎不耗本机算力，是在 Google 服务器上算的）
  if (st.powerSaver) return 'webspeech';
  // 默认双引擎：浏览器出实时字幕让你跟得上，本地 Whisper 在后台跑出更准的最终稿。
  // 代价很小 —— 实测 WebGPU 上 Whisper 是 32 倍实时，一节 90 分钟的课 GPU 只工作 3 分钟左右。
  return 'hybrid';
}

const ENGINE_DESC = {
  webspeech: '浏览器实时识别：字幕几乎没有延迟，但老师离得远就会明显变差。',
  whisper: '本地 Whisper：完全离线、不要 Key，对远距离和噪声强得多；每 20 多秒出一段，不是逐字实时。',
  hybrid: '双引擎：浏览器负责实时字幕让你跟得上，本地 Whisper 在后台跑，下课时用 Whisper 的结果替换成最终稿。最稳，但最耗电。',
  cloud: '云端 Whisper：准确率最高，但需要 API Key，而且要联网。'
};

async function startWhisperEngine(mic, st, engine) {
  const [A, C] = await Promise.all([mod('audio'), mod('whisper-client')]);
  // 先在 Worker 里探测设备能力，主线程完全不碰模型
  const probeW = new C.WhisperWorker({});
  let info = null;
  try { info = await probeW.probe(); } catch (_) {}
  probeW.terminate();
  // 默认只用**已经打包在本地**的模型，绝不在上课时才去下载 500MB。见 defaultModel 上面的说明。
  let model = st.whisperModel || defaultModel(info);
  if (S.cur) S.cur.wmodel = model;
  // 上课时最怕卡住：大模型 90 秒还没就绪就退回 base，宁可准确率低一点也不能不出字
  const FALLBACK = 'onnx-community/whisper-base';
  const onStat = (x) => {
    const code = typeof x === 'string' ? x : (x && x.status) || '';
    const pct = typeof x === 'object' && x ? (x.progress ?? x.percent) : null;
    if (code === 'downloading') setStatus('warn', `下载识别模型 ${pct != null ? Math.round(pct) + '%' : '…'}`);
    else if (code === 'loading') setStatus('warn', '加载识别模型…');
    else if (code === 'ready') setStatus('rec', '录音中');
    else if (code === 'lagging') showWarn('电脑有点跟不上，识别在排队 —— 字幕会延后，但录音一个字都不会少，下课后能重新转写。上课中不用管它。');
    else if (code === 'error') showWarn('Whisper 引擎出错：' + ((x && x.message) || '未知') + '。录音仍在继续，下课后可以重新转写。');
  };

  const sw = new C.WhisperWorker({
    model,
    language: String(st.srcLang || 'en').split('-')[0],
    windowSec: 25, overlapSec: 3,
    onPartial: (t) => { if (engine !== 'hybrid') $('#interim').textContent = t ? '…' + t : ''; },
    onFinal: (text, startMs) => {
      if (!S.cur || !text) return;
      if (engine === 'hybrid') {
        if (!S.cur.segmentsW) S.cur.segmentsW = [];
        S.cur.segmentsW.push({ id: uid(), t: startMs == null ? elapsed() : startMs, text, zh: '', kind: 'speech', src: 'whisper' });
        S.lastHeard = Date.now();
        if (S._quietWarned) { S._quietWarned = false; $('#warnBox').hidden = true; }
        persist();
      } else {
        addSegment({ text, kind: 'speech', src: 'whisper', t: startMs });
      }
    },
    onStatus: onStat
  });
  try {
    await sw.start();
  } catch (e) {
    // 模型加载不动（太大 / 显存不够 / 卡死）→ 换最小的再来一次。
    // 因为跑在 Worker 里，这里卡住也不会冻住界面和录音。
    sw.terminate();
    if (model !== FALLBACK) {
      showWarn(`模型「${model}」加载失败（${e.message}），已自动改用基础版。`);
      const sw2 = new C.WhisperWorker({ ...sw.opts, model: FALLBACK });
      sw2.onPartial = sw.onPartial; sw2.onFinal = sw.onFinal; sw2.onStatus = sw.onStatus;
      await sw2.start();
      S.whisper = sw2;
      const tap2 = new A.PCMTap(mic.ctx, mic.chainOut || mic.src, { targetRate: 16000, onSamples: f => { if (!S.paused) sw2.push(f); } });
      await tap2.connect();
      S.tap = tap2;
      return sw2;
    }
    throw e;
  }
  S.whisper = sw;

  const tap = new A.PCMTap(mic.ctx, mic.chainOut || mic.src, {
    targetRate: 16000,
    onSamples: (f32) => { if (!S.paused) sw.push(f32); }
  });
  const mode = await tap.connect();
  if (mode === 'script') console.info('[VC] PCMTap 回退到 ScriptProcessor（比 AudioWorklet 费电）');
  S.tap = tap;
  return sw;
}

async function stopWhisperEngine() {
  try { S.tap && S.tap.disconnect(); } catch (_) {}
  S.tap = null;
  if (S.whisper) {
    try { await S.whisper.flush(); } catch (_) {}
    try { await S.whisper.stop(); } catch (_) {}
    S.whisper = null;
  }
}

/* ============================== 录制 ============================== */
// quick = 「⚡ 立即开始」：紧急情况下不填任何东西直接录，下课再补老师/学科/标题。
// 老师和学科现在都是可选的 —— 以前不选就不让录，开学第一节课手忙脚乱时最容易卡在这。
async function startRecording({ quick = false } = {}) {
  if (S.cur) return;
  const teacherId = quick ? '' : ($('#selTeacher').value || '');
  const courseId  = quick ? '' : ($('#selCourse').value || '');

  const saved = saveSettings({
    srcLang: $('#selSrcLang').value,
    dstLang: $('#selDstLang').value,
    micId: $('#selMic').value,
    ...(quick ? {} : { lastTeacher: teacherId, lastCourse: courseId })
  });
  // 快速开始只用最稳的一套，**不改她保存的设置**：
  //   本地 Whisper + 按设备选的内置模型（有 WebGPU 用 small，否则 base；见 defaultModel），
  //   不开大教室增强、不开自动精修。全程离线，网络再差也不受影响。
  const st = quick
    ? { ...saved, engine: 'whisper', whisperModel: '', farMode: false, boost: 1, autoPerfect: false }
    : saved;

  const engine = quick ? 'whisper' : resolveEngine();
  const boost = st.farMode ? Math.max(2, st.boost) : st.boost;

  // 远场音频链（audio.js 里针对大教室 + 扩音器调过参）
  let chainFactory = null;
  try {
    const A = await mod('audio');
    chainFactory = (ctx, src) => A.buildChain(ctx, src, { preset: st.farMode ? 'hall' : 'near', boost });
  } catch (_) { /* 没有 audio.js 就用 mic.js 内置的链路 */ }

  // 远场模式下必须关掉系统 AGC：笔记本 AGC 在老师停顿时会猛拉增益，把底噪抬成沙沙声，
  // 既污染录音也会破坏 VAD 的包络判据。增益交给 audio.js 的链路做，可控得多。
  const useAgc = st.farMode ? false : st.agc;
  const mic = new Mic();
  try {
    await mic.start({ deviceId: st.micId, agc: useAgc, ns: st.ns,
                      boost, enhance: st.farMode || boost > 1, chainFactory });
  } catch (e) {
    return toast('无法打开麦克风：' + e.message + '（请允许麦克风权限）');
  }
  S.mic = mic;
  await db.requestPersist();

  // 借这次点击的用户手势，把翻译能力准备好（内置翻译可能要下语言包；本地模型可能要下权重）
  if (st.dstLang !== 'off') {
    T.prepare(st.srcLang, st.dstLang, () => {}).then(t => { if (t) toast('浏览器内置翻译已就绪（离线可用）'); });
    if (T.warmLocalMT) T.warmLocalMT();
    if (st.mtEngine === 'llm') {
      getHQ((s2) => { if (s2 === 'ready') toast('高质量翻译模型已就绪'); })
        .catch(e => showWarn('高质量翻译模型加载失败：' + e.message + '，已改用快速模型'));
    }
  }

  const now = new Date();
  const title = (!quick && $('#inpTitle').value.trim()) ||
    (quick ? `快速记录 ${now.toLocaleDateString('zh-CN')} ${now.toTimeString().slice(0, 5)}`
           : `${nameOf(S.courses, courseId) || '课堂记录'} ${now.toLocaleDateString('zh-CN')}`);

  S.cur = {
    id: uid(), teacherId, courseId, title,
    startedAt: Date.now(), endedAt: null, durationMs: 0,
    srcLang: st.srcLang, dstLang: st.dstLang,
    segments: [], summary: '', hasAudio: false,
    engine, farMode: !!st.farMode, boost, quick: !!quick,
    wmodel: ''   // startWhisperEngine 决定用哪个模型后填上
  };
  await db.put('sessions', S.cur);

  S.t0 = Date.now(); S.paused = false; S.pausedMs = 0;
  S.lastHeard = Date.now(); S._quietWarned = false;
  FRAG.reset();
  $('#setupCard').hidden = true; $('#liveCard').hidden = false; $('#warnBox').hidden = true;
  $('#liveTitle').textContent = title;
  $('#liveMeta').textContent = (courseId || teacherId)
    ? [nameOf(S.courses, courseId), nameOf(S.teachers, teacherId)].filter(Boolean).join(' · ')
    : '没填老师和学科 —— 下课后在这节课里点「✏️ 修改信息」补上就行';
  $('#liveTranscript').innerHTML = ''; $('#interim').textContent = '';
  // 纯 Whisper 是 25 秒一个窗口才出第一段字。这 25 秒里字幕区全空、
  // 右边又写着「0 段 · 0 词」，看上去就像根本没录上 —— 她会以为坏了然后去乱点。
  // 所以明确告诉她在等什么、还要等多久。
  if (engine === 'whisper') showWaiting();
  $('#btnPause').textContent = '⏸ 暂停';
  setStatus('rec', '录音中');

  if (st.audioBackup) mic.recordStart();
  if (st.wakeLock && !st.powerSaver) keepAwake().then(w => S.wake = w);
  // navigator.wakeLock 只在页面可见时有效：她切到 Word 记笔记、或者窗口被别的 App 盖住，
  // 锁就被释放了，Mac 照样休眠 → 录音和 Whisper 一起停，而计时器还在走（用 Date.now 算的），
  // 她回来只会看到「中间那段字怎么没了」。桌面版必须用主进程的 powerSaveBlocker。
  if (IS_DESKTOP && window.VCDesktop.setPreventSleep) {
    window.VCDesktop.setPreventSleep(true).catch(() => {});
  }

  // ---- 本地 Whisper ----
  if (engine === 'whisper' || engine === 'hybrid') {
    setStatus('warn', '正在准备识别模型…');
    startWhisperEngine(mic, st, engine).catch(e => {
      showWarn('本地 Whisper 启动失败：' + e.message + (SR_SUPPORTED ? '，已改用浏览器实时识别。' : '，这节课只会留下录音，下课后可以重新转写。'));
      if (SR_SUPPORTED && engine === 'whisper' && !S.asr) startWebSpeech(st);
    });
  }

  // ---- 浏览器实时识别 ----
  if ((engine === 'webspeech' || engine === 'hybrid') && SR_SUPPORTED) startWebSpeech(st);
  else if (engine === 'webspeech' && !SR_SUPPORTED) {
    showWarn('这个浏览器不支持实时识别，已自动改用本地 Whisper。');
    startWhisperEngine(mic, st, 'whisper').catch(e => showWarn('Whisper 也启动失败：' + e.message));
  }

  startChunking(mic, st, engine);

  S.timer = setInterval(tick, 1000);
  meterLoop();
  window.addEventListener('beforeunload', beforeUnload);
  document.addEventListener('visibilitychange', onVisible);
}

// 浏览器识别会把一句话切成「pre」「chapter section」这种碎片，
// 每个碎片单独成段、单独翻译，中文就变成「前」「章节」这种废话。
// 所以先攒起来，凑成一个完整句子再落段。
const FRAG = {
  parts: [], t0: null, timer: null,
  push(text) {
    if (!text) return;
    if (this.t0 == null) this.t0 = elapsed();
    this.parts.push(text);
    S.lastHeard = Date.now();
    if (S._quietWarned) { S._quietWarned = false; $('#warnBox').hidden = true; }
    clearTimeout(this.timer);
    const joined = this.parts.join(' ');
    const n = words(joined);
    const ended = /[.!?。！？][”"')\]]?\s*$/.test(joined);
    // 句子说完了、或者已经攒够一句的长度 → 立刻落段
    if ((ended && n >= 5) || n >= 24) return this.flush();
    // 否则等 2.2 秒；老师停顿了就当一句结束
    this.timer = setTimeout(() => this.flush(), 2200);
  },
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.parts.length) return;
    const text = this.parts.join(' ').replace(/\s+/g, ' ').trim();
    const t = this.t0;
    this.parts = []; this.t0 = null;
    if (text) addSegment({ text, kind: 'speech', t });
  },
  reset() { clearTimeout(this.timer); this.timer = null; this.parts = []; this.t0 = null; }
};

function startWebSpeech(st) {
  S.asr = new ASR({
      lang: st.srcLang,
      onFinal: (text) => FRAG.push(text),
      onInterim: (t) => { $('#interim').textContent = t ? '…' + t : ''; },
      onStatus: (s) => {
        if (S.paused) return;
        if (s === 'listening') setStatus('rec', '录音中');
        else if (s === 'reconnecting') setStatus('warn', '重连中…');
      },
    onError: (code, fatal, msg) => {
      if (msg) showWarn(msg);
      if (fatal) setStatus('warn', '识别已停止');
    }
  });
  S.asr.start();
}

// 分段录音：实时送云端转写 和/或 存起来供课后整段重转
function startChunking(mic, st, engine) {
  const liveCloud = (st.cloudASR || engine === 'cloud') && whisperReady();
  const keep = st.keepChunks || st.farMode;
  if (liveCloud || keep) {
    const sid = S.cur.id;
    let saved = 0;
    mic.chunkStart(st.chunkSec || 30, async (blob, i, at) => {
      if (keep) {
        try { await db.put('chunks', { key: sid + '#' + String(i).padStart(5, '0'), sessionId: sid, i, at, blob }); saved++; }
        catch (_) {}
      }
      if (liveCloud && !S.paused) {
        try {
          const txt = await transcribe(blob, st.srcLang);
          if (txt) addSegment({ text: txt, kind: 'speech', src: 'cloud' });
        } catch (e) { /* 静默失败，主引擎还在跑 */ }
      }
      if (keep && saved === 1 && S.cur) { S.cur.hasChunks = true; persist(); }
    }, () => elapsed());
  }
  if (engine === 'cloud' && !liveCloud) {
    showWarn('选了「云端 Whisper」但没配置 API Key / Base URL，已只保留录音。请去设置里配置，或改用「本地 Whisper」。');
  }
}

function onVisible() {
  if (document.visibilityState !== 'visible') return;
  const _st = settings();
  if (S.cur && !S.paused && _st.wakeLock && !_st.powerSaver && !S.wake) keepAwake().then(w => S.wake = w);
  pumpTranslate();
}
// ⚠️ 桌面版一定要直接 return。
// Electron 不会像浏览器那样弹「确定离开吗」——它只是把关窗**静默取消**掉：
// 点红叉 / Cmd+Q 完全没反应，她会以为 App 死机去强制退出，
// 而那时整节课的录音还只在内存里（要 stopRecording 才写进 IndexedDB）= 全丢。
// 桌面版改走 VCDesktop.onBeforeQuit，主进程会弹一个真的有「继续录制 / 仍然退出」的对话框。
function beforeUnload(e) {
  if (IS_DESKTOP) return;
  if (S.cur) { e.preventDefault(); e.returnValue = '正在录制中，真的要离开吗？'; }
}

function setStatus(cls, text) {
  const p = $('#statusPill');
  p.className = 'pill ' + cls;
  p.textContent = text;
}
function showWarn(msg) { const w = $('#warnBox'); w.hidden = false; w.textContent = '⚠️ ' + msg; }

function elapsed() { return Date.now() - S.t0 - S.pausedMs - (S.paused ? Date.now() - S.pauseAt : 0); }

function tick() {
  $('#timer').textContent = hhmmss(elapsed());
  if (S.cur && !S.paused) {
    const quiet = Date.now() - (S.lastHeard || S.t0);
    if (quiet > 90000 && !S._quietWarned) {
      S._quietWarned = true;
      showWarn('已经 90 秒没有识别到任何文字。先看右上角音量条：在动=声音收到了，' +
        '多半只是老师停下来了，不用管。完全不动的话，点「⏸ 暂停」→ 回到上一页换一个麦克风→再「继续」。' +
        '⚠️ 不要结束这节课 —— 录音一直在存，下课后可以整节重新转写，一个字都不会丢。');
    }
  }
  const n = S.cur ? S.cur.segments.filter(s => s.kind === 'speech').length : 0;
  const w = S.cur ? S.cur.segments.reduce((a, s) => a + words(s.text), 0) : 0;
  $('#liveStats').textContent = `${n} 段 · ${w} 词`;
  tickWaiting();
}

/* 纯 Whisper 模式下「还没出第一段字」时的等待提示。
   Whisper 攒满一个 25 秒的窗口才吐一次，中间完全没有输出，
   不说清楚的话她只会看到一片空白 + 0 段 0 词。 */
const WHISPER_FIRST_MS = 26000;
function showWaiting() {
  const box = $('#liveTranscript');
  if (!box || box.querySelector('.waiting')) return;
  // 已经有字了就别再摆「正在听」—— 恢复未完成的课、或者识别抢先出结果时会碰到
  if (S.cur && S.cur.segments.some(x => x.kind === 'speech')) return;
  box.innerHTML = `<div class="waiting">
    <div class="waiting-dots"><i></i><i></i><i></i></div>
    <p class="waiting-main">正在听老师讲话…</p>
    <p class="waiting-sub">本地识别是攒满一段再翻译，<b>第一段大约 25 秒</b>后出现。<br>
       这段时间是正常的，<b>不用点任何东西</b>。右上角音量条在动就说明收到声音了。</p>
    <p class="waiting-count" id="waitCount"></p>
  </div>`;
}
function tickWaiting() {
  const el = $('#waitCount');
  if (!el || !S.cur || S.paused) return;
  const left = Math.ceil((WHISPER_FIRST_MS - elapsed()) / 1000);
  el.textContent = left > 0 ? `第一段字大约还有 ${left} 秒` : '快出来了…';
}
function clearWaiting() {
  const w = $('#liveTranscript') && $('#liveTranscript').querySelector('.waiting');
  if (w) w.remove();
}
// 省电：音量表不用 60fps 的 requestAnimationFrame，8fps 足够看，页面切走时完全停掉
function meterLoop() {
  clearInterval(S.meterTimer);
  const bar = $('#liveMeter');
  const period = settings().powerSaver ? 500 : 125;   // 省电模式 2fps，平时 8fps
  S.meterTimer = setInterval(() => {
    if (!S.mic) { clearInterval(S.meterTimer); return; }
    if (document.hidden) { if (bar.style.width !== '0%') bar.style.width = '0%'; return; }
    bar.style.width = (S.mic.level() * 100) + '%';
  }, period);
}
function meterStop() { clearInterval(S.meterTimer); S.meterTimer = null; }

// 省电：整份 session 写 IndexedDB 越到后面越贵，拉长到 4 秒；关键时刻用 persistNow() 立刻写
const persist = debounce(() => { if (S.cur) db.put('sessions', S.cur).catch(() => {}); }, 4000);
const persistNow = () => { if (S.cur) return db.put('sessions', S.cur).catch(() => {}); };

function addSegment({ text, kind = 'speech', src = 'live', t = null }) {
  if (!S.cur) return;
  const seg = { id: uid(), t: t == null ? elapsed() : t, text, zh: '', kind, src };
  S.cur.segments.push(seg);
  if (kind === 'speech') {
    S.lastHeard = Date.now();
    if (S._quietWarned) { S._quietWarned = false; $('#warnBox').hidden = true; }
  }
  clearWaiting();
  renderSeg(seg, $('#liveTranscript'), true);
  persist();
  const st = settings();
  if (kind === 'speech' && st.dstLang !== 'off' && st.liveTranslate) queueTranslate(seg);
}

function renderSeg(seg, host, autoscroll) {
  const near = host.scrollHeight - host.scrollTop - host.clientHeight < 120;
  const div = document.createElement('div');
  // 老师在强调的句子用颜色标出来，上课时扫一眼就知道哪句必须抓住
  let emph = '';
  if (seg.kind === 'speech' && COACH_EMPH) {
    try { const lv = COACH_EMPH(seg.text); if (lv) emph = ' emph' + lv; } catch (_) {}
  }
  div.className = 'seg' + (seg.kind === 'mark' ? ' mark' : seg.kind === 'note' ? ' note' : emph);
  div.dataset.id = seg.id;
  const badge = seg.zhFrom === 'mt' ? ' <i class="who" title="opus-mt 胜出">MT</i>'
    : seg.zhFrom === 'llm' ? ' <i class="who llm" title="本地大模型胜出">AI</i>' : '';
  const tools = (seg.kind === 'speech' && host.id === 'fullBody')
    ? `<span class="row-tools"><button data-play="${seg.id}" title="播放这一句的原声">▶</button>` +
      `<button data-loop3="${seg.id}" title="这一句连放 3 遍（跟读用）">🔂</button>` +
      `<button data-shadow="${seg.id}" title="跟读：先听原声，再录你自己说一遍">🎤</button></span>`
    : '';
  div.innerHTML = `<div class="t">${tools}[${mmss(seg.t)}]${seg.src === 'cloud' ? ' ☁︎' : ''}${seg.src === 'whisper-redo' ? ' ↻' : ''}${seg.kind === 'mark' ? ' ⭐ 重点' : seg.kind === 'note' ? ' 📝 笔记' : ''}${badge}</div>
    <div class="en">${esc(seg.text)}</div>
    <div class="zh${seg.zh ? '' : ' pending'}${seg.zhAlt ? ' has-alt' : ''}"${seg.zhAlt ? ` title="${esc(seg.zhWhy || '')}\n点一下看${seg.zhAltFrom === 'llm' ? '本地大模型' : seg.zhAltFrom === 'mt' ? 'opus-mt' : '另一个模型'}的版本：${esc(seg.zhAlt)}"` : ''}>${seg.zh ? esc(seg.zh) : ''}</div>`;
  if (seg.zhAlt) {
    const zhEl = div.querySelector('.zh');
    zhEl.onclick = () => {
      const showingAlt = zhEl.dataset.alt === '1';
      zhEl.textContent = showingAlt ? seg.zh : seg.zhAlt;
      zhEl.dataset.alt = showingAlt ? '' : '1';
      zhEl.classList.toggle('alt', !showingAlt);
    };
  }
  host.appendChild(div);
  // 省电 + 防卡：实时视图只保留最近 LIVE_KEEP 条节点，完整内容始终在内存和数据库里，导出不受影响
  if (autoscroll && host.childElementCount > LIVE_KEEP) {
    while (host.childElementCount > LIVE_KEEP) host.removeChild(host.firstElementChild);
    if (!host.dataset.trimmed) {
      host.dataset.trimmed = '1';
      const tip = document.createElement('div');
      tip.className = 'seg';
      tip.style.cssText = 'text-align:center;color:#5f6d8f;font-size:12px;border-left-color:transparent';
      tip.textContent = '（为了省电和流畅，这里只显示最近的内容，完整讲稿在下课后的文档里）';
      host.insertBefore(tip, host.firstElementChild);
    }
  }
  if (autoscroll && near) host.scrollTop = host.scrollHeight;
}

// 攒一批一起翻。本地翻译模型每调用一次就要唤醒一次 CPU，
// 逐句翻 = 一节课几百次唤醒，CPU 始终进不了深度睡眠，这是实时翻译最费电的地方。
// 攒 8 秒（省电模式 20 秒）再一次性翻，唤醒次数降一个数量级，译文质量还更好（有上下文）。
const TRANS_BATCH_MS = 8000, TRANS_BATCH_MS_SAVER = 20000;

function queueTranslate(seg) {
  S.transQ.push(seg);
  if (S._transTimer) return;
  const st = settings();
  const wait = st.powerSaver ? TRANS_BATCH_MS_SAVER : TRANS_BATCH_MS;
  S._transTimer = setTimeout(() => { S._transTimer = null; pumpTranslate(); }, wait);
}

async function pumpTranslate() {
  const st = settings();
  if (S.transRunning || !S.transQ.length) return;
  // 省电：页面在后台时不翻译，回到前台再补（录音和识别完全不受影响）
  if (document.hidden && S.cur) {
    clearTimeout(S._transWake);
    S._transWake = setTimeout(pumpTranslate, 8000);
    return;
  }
  const batch = S.transQ.splice(0, 24);
  S.transRunning = 1;
  try {
    await T.translateMany(batch, st.srcLang, st.dstLang, (seg, zh) => {
      if (!zh) return;
      seg.zh = zh;
      const el = document.querySelector(`.seg[data-id="${seg.id}"] .zh`);
      if (el) { el.textContent = zh; el.classList.remove('pending'); }
    }, st.powerSaver ? 1 : 2);
    persist();
  } catch (_) {}
  S.transRunning = 0;
  // 还有剩的就接着翻，但留 1.5 秒间隔，别把 CPU 连续占死
  if (S.transQ.length && !S._transTimer) {
    S._transTimer = setTimeout(() => { S._transTimer = null; pumpTranslate(); }, 1500);
  }
}

function togglePause() {
  if (!S.cur) return;
  S.paused = !S.paused;
  if (S.paused) {
    S.pauseAt = Date.now();
    FRAG.flush();
    S.asr && S.asr.stop();
    S.mic && S.mic.recordPause();
    setStatus('warn', '已暂停');
    $('#btnPause').textContent = '▶️ 继续';
    $('#interim').textContent = '';
    persistNow();
  } else {
    S.pausedMs += Date.now() - S.pauseAt;
    S.asr && S.asr.start();
    S.mic && S.mic.recordResume();
    setStatus('rec', '录音中');
    $('#btnPause').textContent = '⏸ 暂停';
  }
}

async function markPoint() {
  addSegment({ text: '（重点）', kind: 'mark' });
  await persistNow();
  toast('已标记 ⭐');
}
async function addNote() {
  const r = await dialog('插入我的笔记', [{ name: 'note', type: 'textarea', label: '写点什么', placeholder: '老师说这个会考…' }]);
  if (r && r.note) { addSegment({ text: r.note, kind: 'note' }); await persistNow(); }
}

async function stopRecording() {
  if (!S.cur) return;
  const cur = S.cur;
  window.removeEventListener('beforeunload', beforeUnload);
  document.removeEventListener('visibilitychange', onVisible);
  clearInterval(S.timer); cancelAnimationFrame(S.raf); meterStop();
  FRAG.flush();
  S.asr && S.asr.stop();
  try { S.wake && S.wake.release(); } catch (_) {} S.wake = null;
  if (IS_DESKTOP && window.VCDesktop.setPreventSleep) {
    window.VCDesktop.setPreventSleep(false).catch(() => {});
  }

  cur.endedAt = Date.now();
  cur.durationMs = elapsed();

  $('#liveCard').hidden = true; $('#busyCard').hidden = false;
  const step = m => { $('#busyMsg').textContent = m; };
  $('#busyTitle').textContent = '正在整理这节课…';

  // Whisper 还有没处理完的尾巴，先让它吐完（这时 S.cur 还不能清空）
  if (S.whisper || S.tap) {
    step('识别引擎正在处理最后几十秒…');
    await stopWhisperEngine();
  }
  S.cur = null;

  // 双引擎收尾：在「浏览器实时识别」和「Whisper」两份稿子里挑一份做最终稿。
  // 按**词数**比，不是按段数比 —— Whisper 一段能装 25 秒的话，段数天然比实时识别少得多，
  // 按段数比会在浏览器识别挂掉时把 Whisper 的结果错误地丢掉（那正是最需要它的时候）。
  // 另外：落选的那份也完整保留，永远不丢东西。
  if (cur.segmentsW && cur.segmentsW.length) {
    const marks = cur.segments.filter(x => x.kind !== 'speech');
    const live = cur.segments.filter(x => x.kind === 'speech');
    const wW = cur.segmentsW.reduce((a, x) => a + words(x.text), 0);
    const wL = live.reduce((a, x) => a + words(x.text), 0);
    if (wW > 0 && (wL === 0 || wW >= wL * 0.6)) {
      cur.segmentsLive = live;                       // 实时那版留作参考
      cur.segments = [...cur.segmentsW, ...marks].sort((a, b) => a.t - b.t);
      step(`已用 Whisper 的结果作为最终稿（${cur.segmentsW.length} 段 / ${wW} 词）`);
    } else {
      cur.segmentsWhisper = cur.segmentsW;           // Whisper 那版留作参考
      step(`保留浏览器实时识别的稿子（${wL} 词，比 Whisper 的 ${wW} 词更完整）`);
    }
    delete cur.segmentsW;
  }

  step('保存录音…');

  if (S.mic) {
    S.mic.chunkStop();
    const blob = await S.mic.recordStop();
    if (blob && blob.size > 1000) {
      try { await db.put('audio', { sessionId: cur.id, blob, type: blob.type }); cur.hasAudio = true; cur.audioSize = blob.size; } catch (_) {}
    }
    S.mic.stop(); S.mic = null;
  }

  const st = settings();
  // 补齐所有没翻译的句子
  if (st.dstLang !== 'off') {
    const need = cur.segments.filter(s => s.kind === 'speech' && !s.zh && s.text);
    if (need.length) {
      $('#busyTitle').textContent = '正在翻译…';
      let done = 0;
      await T.translateMany(need, cur.srcLang, st.dstLang, (item, zh) => {
        item.zh = zh; done++;
        step(`翻译 ${done}/${need.length}`);
      }, 3);
    }
  }

  $('#busyTitle').textContent = '正在生成课堂概要…';
  const ctx = { teacher: nameOf(S.teachers, cur.teacherId), course: nameOf(S.courses, cur.courseId),
                useLocalLLM: st.useLocalLLM, llmModel: st.llmModel };
  try { cur.summary = await summarize(cur, ctx, step); }
  catch (e) { cur.summary = localSummary(cur, ctx); }

  await db.put('sessions', cur);
  $('#busyCard').hidden = true; $('#setupCard').hidden = false;
  $('#inpTitle').value = '';
  toast('这节课已保存 ✓');
  go('session', cur.id);
  // 下课自动存档到 App 外面（默认 iCloud 云盘，通用格式；失败不打扰，课程页能看到状态）
  archiveOne(cur).then(r => {
    if (!r || !r.ok) return;
    toast('已存档到「' + (r.rel || '').split('/').pop() + '」☁️', 3500);
    // 顺手把以前没存过的课补上（新版之前录的都没存过）。只补一次、不打扰。
    if (!settings().archiveBackfilled) {
      saveSettings({ archiveBackfilled: true });
      setTimeout(() => archiveAll({ onlyMissing: true }).catch(() => {}), 5000);
    }
  }).catch(e => console.warn('[VC] 自动存档失败', e));
  // 下课自动备份到云盘（失败不打扰，设置页能看到状态）
  if (settings().autoBackup) {
    backupOne(cur).then(r => { if (r && r.ok && !r.skipped) toast('已备份到云盘 ☁️', 3000); })
      .catch(e => console.warn('[VC] 自动备份失败', e));
  }
  if (settings().autoPerfect) {
    setTimeout(() => {
      toast('开始自动精修（双模型），可以先去干别的', 6000);
      perfectPass(true).catch(e => toast('自动精修失败：' + e.message));
    }, 1200);
  }
}

/* ============================== 资料库 ============================== */
async function renderLibrary() {
  S.sessions = await db.sessionsSorted();
  fillFilter($('#libTeacher'), S.teachers, '全部老师');
  fillFilter($('#libCourse'), S.courses, '全部学科');
  drawLibrary();
}
function fillFilter(el, list, ph) {
  const v = el.value;
  el.innerHTML = `<option value="">${ph}</option>` + list.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  el.value = v;
}
function drawLibrary() {
  const q = $('#libSearch').value.trim().toLowerCase();
  const tf = $('#libTeacher').value, cf = $('#libCourse').value;
  const list = S.sessions.filter(s => {
    if (tf && s.teacherId !== tf) return false;
    if (cf && s.courseId !== cf) return false;
    if (!q) return true;
    const hay = (s.title + ' ' + nameOf(S.teachers, s.teacherId) + ' ' + nameOf(S.courses, s.courseId) + ' ' +
      s.segments.slice(0, 400).map(x => x.text + ' ' + (x.zh || '')).join(' ')).toLowerCase();
    return hay.includes(q);
  });
  const host = $('#libList');
  if (!list.length) { host.innerHTML = `<div class="empty">还没有记录。<br>去「录制」开始你的第一节课吧 🎙</div>`; return; }
  const groups = new Map();
  for (const s of list) {
    const k = `${nameOf(S.courses, s.courseId) || '未分类'} · ${nameOf(S.teachers, s.teacherId) || '未填写'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  host.innerHTML = [...groups.entries()].map(([k, arr]) => `
    <div class="lib-group">${esc(k)} （${arr.length} 节）</div>
    ${arr.map(s => `<div class="lib-item" data-id="${s.id}">
      <div><b>${esc(s.title)}</b><div class="sub">${dateCN(s.startedAt)} · ${s.segments.filter(x => x.kind === 'speech').length} 段${s.hasAudio ? ' · 🎧' : ''}${s.hasChunks ? ' · ☁︎可重转' : ''}${s.summary ? '' : ' · ⚠ 无概要'}</div></div>
      <div class="r">${mmss(s.durationMs || 0)}<br><button class="del" data-del="${s.id}">🗑 删除</button></div></div>`).join('')}`).join('');
  $$('.lib-item', host).forEach(el => el.onclick = () => go('session', el.dataset.id));
  $$('[data-del]', host).forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    const s = S.sessions.find(x => x.id === b.dataset.del);
    if (!s) return;
    if (!confirm(`删除「${s.title}」？\n讲稿、概要和录音都会一起删掉，无法恢复。`)) return;
    await removeSession(s.id);
    S.sessions = await db.sessionsSorted();
    drawLibrary();
    toast('已删除');
  });
}

/* ============================== 单节课 ============================== */
async function openSession(id) {
  const s = await db.get('sessions', id);
  if (!s) { toast('找不到这节课'); return go('library'); }
  S.detail = s;
  const st0 = settings();
  const ctx = { teacher: nameOf(S.teachers, s.teacherId), course: nameOf(S.courses, s.courseId),
                useLocalLLM: st0.useLocalLLM, llmModel: st0.llmModel };
  S.detailCtx = ctx;
  $('#sTitle').textContent = s.title;
  $('#sMeta').textContent = [ctx.course, ctx.teacher, dateCN(s.startedAt), '时长 ' + mmss(s.durationMs || 0),
    s.segments.filter(x => x.kind === 'speech').length + ' 段'].filter(Boolean).join(' · ');
  const miss = !s.teacherId && !s.courseId;
  $('#sMetaMiss').hidden = !miss;
  $('#pane-sum').innerHTML = md2html(s.summary || '（还没有概要，点上面的「重新生成概要」）');
  closeSumEditor();
  showArchiveState(s);
  const host = $('#fullBody'); host.innerHTML = '';
  s.segments.forEach(seg => renderSeg(seg, host, false));
  $('#fullSearch').value = '';
  $('#myNotes').value = s.myNotes || '';
  $('#notesOut').innerHTML = s.notesSummary ? md2html(s.notesSummary) : '';
  $('#studyBody').innerHTML = s.studyDoc ? md2html(s.studyDoc) : '<p class="muted">还没有复习文档。去「📝 我的笔记」里点「生成复习文档」，会把老师讲的和你记的合并起来，标出你漏记的和需要确认的地方。</p>';
  showPane(s.segments.length ? 'sum' : 'notes');

  setupPlayer(s).catch(e => console.warn('[VC] 播放器初始化失败', e));
  renderCoach(s).catch(e => console.warn('[VC] 回听清单生成失败', e));

  const a = $('#player');
  if (s.hasAudio) {
    const rec = await db.get('audio', s.id);
    if (rec && rec.blob) {
      a.src = URL.createObjectURL(rec.blob);
      $('#audioMsg').textContent = `录音大小 ${(rec.blob.size / 1048576).toFixed(1)} MB`;
    }
  } else { a.removeAttribute('src'); $('#audioMsg').textContent = '这节课没有保存录音。'; }
}
const PANES = ['sum', 'full', 'coach', 'notes', 'study', 'audio'];
function showPane(p) {
  $$('.stab').forEach(b => b.classList.toggle('active', b.dataset.pane === p));
  PANES.forEach(x => { const el = $('#pane-' + x); if (el) el.hidden = x !== p; });
}

async function regenSummary() {
  const s = S.detail; if (!s) return;
  $('#pane-sum').innerHTML = '<p class="muted">正在生成…</p>';
  showPane('sum');
  try {
    s.summary = await summarize(s, S.detailCtx, m => { $('#pane-sum').innerHTML = `<p class="muted">${esc(m)}</p>`; });
  } catch (e) { s.summary = localSummary(s, S.detailCtx); }
  await db.put('sessions', s);
  $('#pane-sum').innerHTML = md2html(s.summary);
  toast('概要已更新');
}

async function retranslate() {
  const s = S.detail; if (!s) return;
  const dst = s.dstLang && s.dstLang !== 'off' ? s.dstLang : settings().dstLang;
  if (dst === 'off') return toast('当前设置为不翻译');
  const need = s.segments.filter(x => x.kind === 'speech' && !x.zh && x.text);
  if (!need.length) return toast('已经全部翻译过了');
  await Promise.race([T.prepare(s.srcLang || 'en-US', dst), new Promise(r => setTimeout(r, 20000))]);
  toast(`正在翻译 ${need.length} 段…`);
  let done = 0;
  await T.translateMany(need, s.srcLang || 'en-US', dst, (item, zh) => {
    item.zh = zh; done++;
    const el = document.querySelector(`#fullBody .seg[data-id="${item.id}"] .zh`);
    if (el && zh) { el.textContent = zh; el.classList.remove('pending'); }
    if (done % 10 === 0) $('#sMeta').textContent = `翻译中 ${done}/${need.length}…`;
  }, 3);
  await db.put('sessions', s);
  openSession(s.id);
  toast('翻译完成');
}

// 快速开始录的课下课后在这里补信息。老师/学科可以从已有的里选，也可以直接打一个新名字
// （自动建好），空着就是不填。以前这里是下拉框，只能选已有的 —— 快速开始之后没法补新老师。
/* ============================== 录音存档设置 ============================== */
async function renderArchiveBox() {
  if (!IS_DESKTOP || !window.VCDesktop.archive) return;
  const A = await mod('archive');
  const st = settings();
  const def = await window.VCDesktop.archive.defaultRoot();
  let clouds = [];
  try { clouds = await window.VCDesktop.cloudFolders(); } catch (_) {}
  // 选项：默认（iCloud 优先）+ 检测到的、**正在同步**的云盘。没在同步的 Google Drive 只显示不给选。
  const opts = [{ v: '', t: '默认：' + def.replace(/^.*\/(com~apple~CloudDocs|Documents)\//, (m, k) => k === 'Documents' ? '文稿/' : 'iCloud 云盘/') }];
  for (const c of clouds) {
    if (c.stale) opts.push({ v: '', t: c.label, disabled: true });
    else if (c.kind !== 'icloud') opts.push({ v: c.dir + '/VoiceCollector 存档', t: c.label + ' / VoiceCollector 存档' });
  }
  const sel = $('#selArchive');
  sel.innerHTML = opts.map(o => `<option value="${esc(o.v)}"${o.disabled ? ' disabled' : ''}>${esc(o.t)}</option>`).join('');
  sel.value = st.archiveDir || '';
  $('#archiveWhere').textContent = await A.root(st);
  const all = await db.all('sessions');
  const done = all.filter(x => x.archivedAt).length;
  const failed = all.filter(x => x.archiveError);
  $('#archiveMsg').textContent = all.length
    ? `已存档 ${done} / ${all.length} 节课` + (failed.length ? `　⚠️ ${failed.length} 节没存上：${failed[0].archiveError}` : '')
    : '';
  $('#archiveBox').hidden = false;
}

// 把还没存过档的课补存一遍（今晚之前录的都没存过）。一节一节来，不抢资源。
async function archiveAll({ onlyMissing = true } = {}) {
  if (S.cur) return toast('正在录课，下课再存');
  const all = await db.all('sessions');
  const todo = all.filter(x => !onlyMissing || !x.archivedAt);
  let ok = 0, bad = 0;
  for (const x of todo) {
    if (S.cur) break;                              // 中途开始录课就停下，别抢资源
    const r = await archiveOne(x);
    if (r && r.ok) ok++; else bad++;
    const m = $('#archiveMsg'); if (m) m.textContent = `正在存档 ${ok + bad} / ${todo.length}…`;
  }
  return { ok, bad, total: todo.length };
}

/* ============================== 概要编辑 / 所有总结 ============================== */
// 「editor platform」：所有课的概要集中在「总结」页，哪一节都能直接改；
// 改完自动写回数据库，并同步更新 App 外面的存档（archive.js）。
function showArchiveState(s) {
  const el = $('#sumArchive'); if (!el) return;
  if (!IS_DESKTOP) { el.textContent = ''; return; }
  el.textContent = s.archiveError ? '⚠️ 存档没成功：' + s.archiveError
    : s.archivedAt ? '☁️ 已存档 ' + new Date(s.archivedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
}
function openSumEditor() {
  const s = S.detail; if (!s) return;
  $('#sumText').value = s.summary || '';
  $('#pane-sum').hidden = true; $('#sumEditor').hidden = false; $('#btnSumEdit').hidden = true;
  $('#sumText').focus();
}
function closeSumEditor() {
  if (!$('#sumEditor')) return;
  $('#pane-sum').hidden = false; $('#sumEditor').hidden = true; $('#btnSumEdit').hidden = false;
}
async function saveSumEditor() {
  const s = S.detail; if (!s) return;
  const text = $('#sumText').value;
  s.summary = text;
  s.summaryEditedAt = Date.now();
  await db.put('sessions', s);
  $('#pane-sum').innerHTML = md2html(text || '（空）');
  closeSumEditor();
  toast('概要已保存');
  archiveOne(s).then(() => showArchiveState(S.detail || s)).catch(() => {});
}

async function renderNotes() {
  S.sessions = await db.sessionsSorted();
  const sel = $('#notesCourse');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部学科</option><option value="__none">未分类</option>' +
    S.courses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = cur;
  const q = ($('#notesQ').value || '').trim().toLowerCase();
  const cf = sel.value;
  const list = S.sessions.filter(s => {
    if (cf === '__none' && s.courseId) return false;
    if (cf && cf !== '__none' && s.courseId !== cf) return false;
    if (q && !((s.title + ' ' + (s.summary || '')).toLowerCase().includes(q))) return false;
    return true;
  });
  const host = $('#notesList');
  if (!list.length) {
    host.innerHTML = `<div class="note-empty">${S.sessions.length ? '没有符合条件的总结' : '还没有课。上完第一节课，概要会自动出现在这里。'}</div>`;
    return;
  }
  const groups = new Map();
  for (const s of list) {
    const k = nameOf(S.courses, s.courseId) || '未分类';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  let html = '';
  for (const [k, arr] of groups) {
    html += `<div class="note-group">${esc(k)} · ${arr.length} 节</div>`;
    for (const s of arr) {
      html += `<div class="note-card" data-id="${s.id}">
        <div class="note-head"><b>${esc(s.title)}</b>
          <span class="muted">${[nameOf(S.teachers, s.teacherId), dateCN(s.startedAt), s.summaryEditedAt ? '改过' : ''].filter(Boolean).join(' · ')}</span>
          <span class="grow"></span>
          <button class="ghost" data-act="edit">✏️ 编辑</button>
          <button class="ghost" data-act="open">打开这节课</button>
        </div>
        <div class="note-body markdown">${md2html(s.summary || '（这节课还没有概要）')}</div>
      </div>`;
    }
  }
  host.innerHTML = html;
}

async function renameSession() {
  const s = S.detail; if (!s) return;
  const r = await dialog('修改信息', [
    { name: 'title', label: '标题', value: s.title },
    { name: 'teacher', label: '老师（选已有的，或直接打新名字；空着=不填）', type: 'combo',
      value: nameOf(S.teachers, s.teacherId), placeholder: '例如：Prof. Smith', options: S.teachers.map(t => t.name) },
    { name: 'course', label: '学科', type: 'combo',
      value: nameOf(S.courses, s.courseId), placeholder: '例如：ECON 101', options: S.courses.map(c => c.name) }
  ]);
  if (!r) return;
  s.title = r.title || s.title;
  s.teacherId = await entityByName('teachers', r.teacher);
  s.courseId = await entityByName('courses', r.course);
  await db.put('sessions', s);
  await loadLists();
  openSession(s.id);
  toast('已保存');
  archiveOne(s).catch(() => {});
}

// 按名字找老师/学科，没有就新建；空名字 = 不填
async function entityByName(store, name) {
  const n = String(name || '').trim();
  if (!n) return '';
  const list = store === 'teachers' ? S.teachers : S.courses;
  const hit = list.find(x => String(x.name || '').trim().toLowerCase() === n.toLowerCase());
  if (hit) return hit.id;
  const item = { id: uid(), name: n, createdAt: Date.now() };
  await db.put(store, item);
  list.push(item);
  return item.id;
}

async function removeSession(id) {
  await db.del('sessions', id);
  try { await db.del('audio', id); } catch (_) {}
  try { await db.delByIndex('chunks', 'sessionId', id); } catch (_) {}
}

async function deleteSession() {
  const s = S.detail; if (!s) return;
  if (!confirm(`删除「${s.title}」？\n讲稿、概要和录音都会一起删掉，无法恢复。`)) return;
  await removeSession(s.id);
  S.sessions = await db.sessionsSorted();
  toast('已删除');
  go('library');
}

/* ---------- 课后用【本地 Whisper】把整段录音重新识别一遍 ----------
   这是最重要的兜底：只要录音还在，哪怕上课时实时识别整个挂掉，
   下课后也能把老师说的每一句话完整找回来。不需要联网，不需要 API Key。   */
async function redoLocal() {
  const s = S.detail; if (!s) return;
  if (!s.hasAudio) return toast('这节课没有保存录音，没法重新识别');

  const rec = await db.get('audio', s.id);
  if (!rec || !rec.blob) return toast('录音文件找不到了');

  const r = await dialog('用录音重新识别整节课', [
    { name: 'model', label: '用哪个模型（都已内置，不用联网）', type: 'select', value: settings().whisperModel || SMALL_MODEL,
      options: [{ v: 'onnx-community/whisper-base', t: '基础版 — 快（约 1 分钟/小时课程）' },
                { v: 'onnx-community/whisper-small', t: '标准版 — 更准，大教室推荐（约 3 分钟/小时课程）' }] },
    { name: 'mode', label: '怎么处理现在的讲稿', type: 'select', value: 'replace',
      options: [{ v: 'replace', t: '替换掉（推荐，原来那份会留作参考）' }, { v: 'append', t: '追加在后面' }] }
  ], '开始识别');
  if (!r) return;

  showPane('full');
  const setMsg = (m) => { $('#sMeta').textContent = m; };
  setMsg('正在解码录音…');
  let pcm;
  try {
    const A = await mod('audio');
    pcm = await A.blobToPCM16k(rec.blob);
  } catch (e) { setMsg(''); return toast('录音解码失败：' + e.message); }

  setMsg(`正在识别 ${Math.round(pcm.length / 16000 / 60)} 分钟的录音…（跑在后台线程，界面不会卡）`);
  let text = '', redoChunks = [];
  try {
    const C = await mod('whisper-client');
    const w = new C.WhisperWorker({ model: r.model, language: String(s.srcLang || 'en').split('-')[0],
      onStatus: (st) => setMsg('识别中…（' + st + '）') });
    const res = await w.transcribeWithChunks(pcm, { model: r.model, language: String(s.srcLang || 'en').split('-')[0], ms: 1800000 });
    w.terminate();
    text = res.text; redoChunks = res.chunks;
  } catch (e) { setMsg(''); return toast('识别失败：' + e.message); }

  if (!text || !text.trim()) { setMsg(''); return toast('没识别出内容 —— 录音里可能确实没有人声'); }

  // 用 Whisper 给的真实时间戳（以前是按句数把时长平均摊，点句子回放会对不上）
  let fresh = chunksToSegments(redoChunks, 'whisper-redo');
  if (!fresh.length) {
    const sentences = text.split(/(?<=[.!?。！？])\s+/).map(x => x.trim()).filter(Boolean);
    const total = s.durationMs || (pcm.length / 16000 * 1000);
    fresh = sentences.map((t, i) => ({ id: uid(), t: Math.round(total * i / Math.max(1, sentences.length)), text: t, zh: '', kind: 'speech', src: 'whisper-redo' }));
  }

  const keep = s.segments.filter(x => x.kind !== 'speech');
  if (r.mode === 'replace') {
    s.segmentsPrev = s.segments.filter(x => x.kind === 'speech');   // 原来那份留着，不丢
    s.segments = [...fresh, ...keep].sort((a, b) => a.t - b.t);
  } else {
    s.segments = [...s.segments, ...fresh].sort((a, b) => a.t - b.t);
  }
  s.redoneAt = Date.now();
  await db.put('sessions', s);
  toast(`重新识别完成，共 ${fresh.length} 句`);
  await openSession(s.id);
  await retranslate();
  await regenSummary();
}

// Whisper 整段识别出来的片段是半句半句的（带真实时间戳）。按句号合成整句，时间用这句第一个片段的时间。
// 一句最长 40 个词就断开 —— 太长的句子本地翻译模型容易崩。
function chunksToSegments(chunks, src, offsetSec = 0) {
  const segs = [];
  let buf = '', t0 = null;
  const flush = () => {
    const x = buf.trim();
    if (x) segs.push({ id: uid(), t: Math.round((offsetSec + (t0 || 0)) * 1000), text: x, zh: '', kind: 'speech', src });
    buf = ''; t0 = null;
  };
  for (const c of chunks || []) {
    const ts = c.timestamp || [];
    if (t0 === null) t0 = ts[0] || 0;
    buf += ' ' + String(c.text || '').trim();
    if (/[.!?]["')\]]?$/.test(buf.trim()) || buf.split(/\s+/).length > 40) flush();
  }
  flush();
  return segs;
}

/* ---------- 导入录音：手机录的、别的 App 录的，拿进来和 App 里录的课一样处理 ---------- */
// 2026-10-06 她第一次拿真实课堂测试，用的是 iPhone 录的 m4a —— App 却只能自己录，导不进外部录音。
// 每个文件导入成一节课：本地识别（带真实时间戳）→ 清洗 → 翻译 → 概要 → 存档。全程离线。
let IMPORTING = false;
async function importAudioFiles(fileList) {
  if (S.cur) return toast('正在录课，下课再导入');
  if (IMPORTING) return toast('上一批还在导入，等它做完');
  const list = [...(fileList || [])].filter(f => f && f.size).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  if (!list.length) return;
  IMPORTING = true;
  // 首页（录制页）和资料库各有一个进度框，从哪里点的都看得到
  const boxes = $$('.import-msg');
  const say = m => boxes.forEach(b => { b.hidden = false; b.textContent = m; });
  let lastId = '';
  const st = settings();
  const lang = String(st.srcLang || 'en').split('-')[0];
  let ok = 0;
  try {
    const A = await mod('audio'), C = await mod('whisper-client');
    let info = null;
    try { const pw = new C.WhisperWorker({}); info = await pw.probe(); pw.terminate(); } catch (_) {}
    const model = st.whisperModel || defaultModel(info);
    const speed = model === SMALL_MODEL ? 9 : 19;        // 实测整段识别的倍速（Apple 芯片）
    for (const [i, f] of list.entries()) {
      const tag = list.length > 1 ? `（${i + 1}/${list.length}）` : '';
      say(`正在导入「${f.name}」${tag}：解码录音…`);
      let pcm;
      try { pcm = await A.blobToPCM16k(f); }
      catch (e) { toast(`「${f.name}」解码失败：${e.message}`, 6000); continue; }
      const minutes = pcm.length / 16000 / 60;
      say(`正在导入「${f.name}」${tag}：识别 ${Math.round(minutes)} 分钟的录音，大约要 ${Math.max(1, Math.round(minutes / speed))} 分钟。` +
          '跑在后台线程里，可以先去做别的，别关 App。');
      const w = new C.WhisperWorker({ model, language: lang });
      let r;
      try { r = await w.transcribeWithChunks(pcm, { model, language: lang, ms: Math.max(1800000, minutes * 120000) }); }
      catch (e) { toast(`「${f.name}」识别失败：${e.message}`, 6000); continue; }
      finally { w.terminate(); }
      const segs = chunksToSegments(r.chunks, 'whisper-import');
      if (!segs.length) { toast(`「${f.name}」里没识别出说话的内容`, 6000); continue; }

      const durationMs = Math.round(minutes * 60000);
      const endedAt = f.lastModified || Date.now();      // 文件时间大约是录完的时候
      const s = {
        id: uid(), teacherId: '', courseId: '', title: f.name.replace(/\.[^.]+$/, ''),
        startedAt: endedAt - durationMs, endedAt, durationMs,
        srcLang: st.srcLang, dstLang: st.dstLang, segments: segs, summary: '',
        hasAudio: true, audioSize: f.size, engine: 'whisper', wmodel: model, imported: f.name
      };
      await db.put('audio', { sessionId: s.id, blob: f, type: f.type || 'audio/mp4' });
      await db.put('sessions', s);

      if (st.dstLang !== 'off') {
        let done = 0;
        await T.translateMany(segs, s.srcLang, st.dstLang, (item, zh) => {
          item.zh = zh; done++;
          if (done % 10 === 0) say(`正在导入「${f.name}」${tag}：翻译 ${done}/${segs.length}…`);
        }, 3);
      }
      say(`正在导入「${f.name}」${tag}：生成概要…`);
      const ctx = { teacher: '', course: '', useLocalLLM: st.useLocalLLM, llmModel: st.llmModel };
      try { s.summary = await summarize(s, ctx, () => {}); } catch (_) { s.summary = localSummary(s, ctx); }
      await db.put('sessions', s);
      archiveOne(s).catch(() => {});
      lastId = s.id;
      ok++;
    }
  } finally {
    IMPORTING = false;
  }
  say(ok ? `导入完成：${ok} 节课。点进去可以补上老师和学科（「现在补上」）。` : '没有导入成功的录音。');
  setTimeout(() => { boxes.forEach(b => { b.hidden = true; }); }, 10000);
  if (ok) toast(`导入完成 ${ok} 节 ✓`, 4000);
  // 只传了一个文件、人还停在录制页 / 资料库 → 直接打开这节课看结果（正在看别的课、在设置页就不打扰）
  if (ok === 1 && lastId && !S.cur && (S.view === 'record' || S.view === 'library')) go('session', lastId);
  else if (S.view === 'library') renderLibrary();
  return ok;
}

// 把录音文件直接拖进窗口 = 上传识别。
// 顺带也挡住了 Electron 的默认行为：文件拖进窗口会直接「打开」它、把整个页面换掉 ——
// 录课时手一滑拖进来一个文件，界面就没了。
const AUDIO_EXT = /\.(?:m4a|mp3|wav|aac|flac|ogg|oga|opus|webm|caf|mp4|m4b|aif|aiff|amr|3gp|wma)$/i;
const isAudioFile = f => !!f && (/^audio\//.test(f.type || '') || f.type === 'video/mp4' || AUDIO_EXT.test(f.name || ''));
function bindDropImport() {
  const hint = $('#dropHint');
  const hasFiles = e => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  let depth = 0, idle = 0;
  const hide = () => { depth = 0; hint.hidden = true; clearTimeout(idle); };
  // 拖到一半按 Esc / 拖出窗口时 dragleave 不一定配对，提示框可能卡在屏幕上；
  // 悬停时 dragover 每几十毫秒来一次，停了就说明拖动已经结束
  const keepAlive = () => { clearTimeout(idle); idle = setTimeout(hide, 700); };
  window.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth++;
    hint.hidden = false;
    keepAlive();
  });
  window.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    keepAlive();
  });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) hide();
  });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); hide();
    const files = Array.from(e.dataTransfer.files || []);
    const audio = files.filter(isAudioFile);
    if (audio.length) return importAudioFiles(audio).catch(err => toast('导入失败：' + err.message));
    if (files.some(f => /\.vcpack$/i.test(f.name))) return toast('课程包请到「资料库」点「📥 导入课程包」');
    toast('拖进来的不是录音文件（支持 m4a / mp3 / wav / aac / flac 等）', 5000);
  });
}

/* ---------- 课后用云端 Whisper 把整节课重新转写（需要 API Key） ---------- */
async function retranscribe() {
  const s = S.detail; if (!s) return;
  if (!whisperReady()) return toast('需要先在「设置」里选 OpenAI 兼容服务商并填 Base URL / API Key');
  const chunks = (await db.byIndex('chunks', 'sessionId', s.id)).sort((a, b) => a.i - b.i);
  if (!chunks.length) return toast('这节课没有保存分段音频（下次上课前在设置里打开「远距离模式」或「保存分段音频」）');

  const r = await dialog('用云端重新转写整节课', [
    { name: 'mode', label: `共 ${chunks.length} 段音频（约 ${Math.round(chunks.length * (settings().chunkSec || 30) / 60)} 分钟）`, type: 'select', value: 'replace',
      options: [{ v: 'replace', t: '替换现有讲稿（推荐，远距离时实时识别不准）' }, { v: 'append', t: '追加到现有讲稿后面' }] }
  ], '开始转写');
  if (!r) return;

  const old = s.segments;
  const keep = old.filter(x => x.kind === 'mark' || x.kind === 'note');
  const fresh = [];
  $('#sMeta').textContent = '转写中 0/' + chunks.length;
  let fail = 0;
  for (let k = 0; k < chunks.length; k++) {
    try {
      const txt = await transcribe(chunks[k].blob, s.srcLang || 'en-US');
      if (txt) fresh.push({ id: uid(), t: chunks[k].at || k * (settings().chunkSec || 30) * 1000, text: txt, zh: '', kind: 'speech', src: 'cloud' });
    } catch (e) { fail++; }
    $('#sMeta').textContent = `转写中 ${k + 1}/${chunks.length}${fail ? `（失败 ${fail} 段）` : ''}`;
  }
  if (!fresh.length) { openSession(s.id); return toast('转写没拿到结果，检查 API Key / Base URL 是否正确'); }

  s.segments = r.mode === 'replace'
    ? [...fresh, ...keep].sort((a, b) => a.t - b.t)
    : [...old, ...fresh].sort((a, b) => a.t - b.t);
  s.retranscribedAt = Date.now();
  await db.put('sessions', s);
  toast(`转写完成，共 ${fresh.length} 段${fail ? `，${fail} 段失败` : ''}`);
  await openSession(s.id);
  await retranslate();
  await regenSummary();
}

function searchFull() {
  const q = $('#fullSearch').value.trim();
  $$('#fullBody .seg').forEach(el => {
    const en = el.querySelector('.en'), zh = el.querySelector('.zh');
    const raw = { en: en.textContent, zh: zh.textContent };
    if (!q) { en.innerHTML = esc(raw.en); zh.innerHTML = esc(raw.zh); el.style.display = ''; return; }
    const hit = (raw.en + raw.zh).toLowerCase().includes(q.toLowerCase());
    el.style.display = hit ? '' : 'none';
    if (hit) {
      const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      en.innerHTML = esc(raw.en).replace(re, '<mark>$1</mark>');
      zh.innerHTML = esc(raw.zh).replace(re, '<mark>$1</mark>');
    }
  });
}

/* ============================== 我的笔记 / 复习文档 ============================== */
const saveNotes = debounce(async () => {
  const s = S.detail; if (!s) return;
  s.myNotes = $('#myNotes').value;
  await db.put('sessions', s);
}, 900);

function noteCtx() {
  const s = S.detail;
  return { ...S.detailCtx, title: s.title, date: dateCN(s.startedAt) };
}

async function tidyNotes() {
  const s = S.detail; if (!s) return;
  const notes = $('#myNotes').value.trim();
  if (!notes) return toast('先写点笔记，或者从文件导入');
  s.myNotes = notes; await db.put('sessions', s);
  $('#notesOut').innerHTML = '<p class="muted">正在整理…</p>';
  try {
    const N = await mod('notes');
    s.notesSummary = await N.summarizeNotes({ notes, ctx: noteCtx(), onStep: m => $('#notesOut').innerHTML = `<p class="muted">${esc(m)}</p>` });
  } catch (e) {
    try { const N = await mod('notes'); s.notesSummary = N.localNotesSummary({ notes, session: s }); }
    catch (_) { $('#notesOut').innerHTML = `<p class="muted">整理失败：${esc(e.message)}</p>`; return; }
  }
  await db.put('sessions', s);
  $('#notesOut').innerHTML = md2html(s.notesSummary);
  toast('笔记已整理');
}

async function makeStudyDoc() {
  const s = S.detail; if (!s) return;
  const notes = $('#myNotes').value.trim();
  s.myNotes = notes; await db.put('sessions', s);
  if (!notes && !s.segments.length) return toast('既没有讲稿也没有笔记，先录一节课或写点笔记');
  showPane('study');
  $('#studyBody').innerHTML = '<p class="muted">正在合并讲稿和你的笔记…</p>';
  try {
    const N = await mod('notes');
    s.studyDoc = await N.mergeStudyDoc({ session: s, notes, ctx: noteCtx(), onStep: m => $('#studyBody').innerHTML = `<p class="muted">${esc(m)}</p>` });
    await db.put('sessions', s);
    $('#studyBody').innerHTML = md2html(s.studyDoc);
    toast('复习文档已生成');
  } catch (e) {
    $('#studyBody').innerHTML = `<p class="muted">生成失败：${esc(e.message)}</p>`;
  }
}

async function newNotebook() {
  const teacherId = S.teachers[0] && S.teachers[0].id;
  const courseId = S.courses[0] && S.courses[0].id;
  const r = await dialog('新建笔记本', [
    { name: 'title', label: '标题', value: '课堂笔记 ' + new Date().toLocaleDateString('zh-CN') },
    { name: 'teacherId', label: '老师', type: 'select', value: settings().lastTeacher || teacherId, options: S.teachers.map(t => ({ v: t.id, t: t.name })) },
    { name: 'courseId', label: '学科', type: 'select', value: settings().lastCourse || courseId, options: S.courses.map(c => ({ v: c.id, t: c.name })) }
  ], '创建');
  if (!r) return;
  const s = {
    id: uid(), teacherId: r.teacherId, courseId: r.courseId, title: r.title || '课堂笔记',
    startedAt: Date.now(), endedAt: Date.now(), durationMs: 0,
    srcLang: settings().srcLang, dstLang: settings().dstLang,
    segments: [], summary: '', myNotes: '', hasAudio: false, notesOnly: true
  };
  await db.put('sessions', s);
  S.sessions = await db.sessionsSorted();
  go('session', s.id);
}

async function reviewAll() {
  const q = $('#libSearch').value.trim().toLowerCase();
  const tf = $('#libTeacher').value, cf = $('#libCourse').value;
  const list = S.sessions.filter(s => (!tf || s.teacherId === tf) && (!cf || s.courseId === cf));
  if (!list.length) return toast('当前筛选下没有课');
  if (list.length > 30 && !confirm(`共 ${list.length} 节课，内容很多，生成会比较慢。继续？`)) return;
  S.reviewList = list;
  S.reviewCtx = { course: nameOf(S.courses, cf) || '多门学科', teacher: nameOf(S.teachers, tf) || '多位老师' };

  go('review');
  $('#rvTitle').textContent = '总复习';
  $('#rvMeta').textContent = `${list.length} 节课 · ${nameOf(S.courses, cf) || '全部学科'} · ${nameOf(S.teachers, tf) || '全部老师'}`;
  $('#rvBody').innerHTML = '<p class="muted">正在汇总…</p>';
  try {
    const N = await mod('notes');
    S.review = await N.reviewAcross({
      sessions: list,
      ctx: { course: nameOf(S.courses, cf) || '多门学科', teacher: nameOf(S.teachers, tf) || '多位老师' },
      onStep: m => $('#rvBody').innerHTML = `<p class="muted">${esc(m)}</p>`
    });
    $('#rvBody').innerHTML = md2html(S.review);
  } catch (e) {
    $('#rvBody').innerHTML = `<p class="muted">生成失败：${esc(e.message)}</p>`;
  }
}

/* ============================== 高质量翻译（本地 LLM） ============================== */
// 单例：模型很大，加载一次反复用
let hqMT = null;

async function getHQ(onStatus) {
  if (hqMT && hqMT.ready) return hqMT;
  const C = await mod('mtllm-client');
  const st = settings();
  // 默认只用已经打包进来的那个，绝不在用的时候才去下载 1GB
  const id = st.llmMtModel || 'onnx-community/Qwen2.5-1.5B-Instruct';
  hqMT = new C.MTLLM({
    model: id,
    targetLang: st.dstLang === 'zh-Hant' ? 'zh-Hant' : 'zh-Hans',
    onStatus: (s2, d) => onStatus && onStatus(typeof s2 === 'string' ? s2 : '', d),
    onProgress: (p) => onStatus && onStatus('downloading', p)
  });
  await hqMT.load();
  T.setHighQualityEngine(hqMT);
  return hqMT;
}

async function retranslateHQ() {
  const s = S.detail; if (!s) return;
  const dst = (s.dstLang && s.dstLang !== 'off') ? s.dstLang : settings().dstLang;
  if (dst === 'off') return toast('当前设置为不翻译');
  const items = s.segments.filter(x => x.kind === 'speech' && x.text && x.text.trim());
  if (!items.length) return toast('这节课没有可翻译的内容');

  const mins = Math.max(1, Math.ceil(items.length * SEC_PER_LINE / 60));
  if (!confirm(`用本地大模型重新翻译 ${items.length} 句。\n\n` +
    `实测约 ${SEC_PER_LINE} 秒/句，这次大概 ${mins} 分钟，比较吃电。\n` +
    `建议插上电源、放着让它跑。期间可以正常用其他功能。\n\n` +
    `（译文如果还不如现在的，会自动保留原来的，不会越改越差）\n\n开始吗？`)) return;

  showPane('full');
  const meta = $('#sMeta');
  const orig = meta.textContent;
  const setMsg = (m) => { meta.textContent = m; };
  setMsg('正在加载高质量翻译模型…（第一次会久一点）');

  let tr;
  try {
    tr = await getHQ((st2, d) => {
      if (st2 === 'downloading' && d) {
        const pct = typeof d === 'number' ? d : (d.pct ?? d.progress ?? 0);
        setMsg(`下载翻译模型 ${Math.round(pct)}%…`);
      } else if (st2) setMsg('翻译模型：' + st2);
    });
  } catch (e) { setMsg(orig); return toast('翻译模型加载失败：' + e.message); }

  let done = 0, good = 0, bad = 0;
  const G = await import('./translate.js');
  setMsg(`正在重新翻译 ${items.length} 句…（跑在后台线程，界面不会卡）`);
  try {
    await tr.translateMany(items.map(x => ({ id: x.id, text: x.text })), (item, zh) => {
      const seg = s.segments.find(x => x.id === item.id);
      // 译文为空或明显劣化的，**保留原来的译文**，绝不把已有的好结果擦掉
      const ok = zh && zh.trim() && !(G.isDegenerate && G.isDegenerate(zh, item.text).bad);
      if (ok) good++; else bad++;
      if (seg && ok) {
        seg.zh = zh;
        const el = document.querySelector(`#fullBody .seg[data-id="${seg.id}"] .zh`);
        if (el) { el.textContent = zh; el.classList.remove('pending'); }
      }
      done++;
      const left = Math.max(1, Math.ceil((items.length - done) * 3 / 60));
      setMsg(`重新翻译中 ${done}/${items.length}　·　成功 ${good} 失败 ${bad}　·　预计还要 ${left} 分钟`);
    });
  } catch (e) { toast('翻译中断：' + e.message); }

  await db.put('sessions', s);
  if (good === 0) {
    toast(`这个模型没翻出可用结果（${bad} 句全部失败），已保留原译文。建议在设置里换更大的模型。`, 7000);
  } else {
    s.translatedBy = 'llm';
    await db.put('sessions', s);
    toast(`高质量翻译完成：${good} 句更新${bad ? `，${bad} 句失败保留原译文` : ''}`, 5000);
  }
  await openSession(s.id);
}

async function testMtQuality() {
  const box = $('#mtTestOut');
  box.innerHTML = '<p class="muted">正在加载模型并翻译测试句…</p>';
  const CASES = [
    'The Supreme Court ruled that the First Amendment protects this kind of speech.',
    'In Roe v. Wade, the Court established a constitutional right to privacy.',
    "we're not going to read that right if it's a lot but that is something that it leads into the question of the changing interpretation and the changing nature of privacy in the digital age.",
    'Your homework is problem set four, due next Friday before midnight.'
  ];
  const rows = [];
  try {
    const tr = await getHQ((s2, d) => {
      if (s2 === 'downloading' && d) {
        const pct = typeof d === 'number' ? d : (d.pct ?? d.progress ?? 0);
        box.innerHTML = `<p class="muted">下载模型 ${Math.round(pct)}%…</p>`;
      }
    });
    const t0 = Date.now();
    const zhs = await tr.translateMany(CASES.map((t, i) => ({ id: 'c' + i, text: t })));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    CASES.forEach((en, i) => rows.push(`**${i + 1}.** ${en}\n\n→ ${zhs[i] || '（失败）'}\n`));
    box.innerHTML = md2html(`### 高质量模型（${tr.device}）· 用时 ${secs} 秒\n\n` + rows.join('\n'));
  } catch (e) {
    box.innerHTML = `<p class="muted">测试失败：${esc(e.message)}</p>`;
  }
}

/* ============================== 回听清单（语速 + 该重听哪几句） ============================== */
async function renderCoach(session) {
  const box = $('#paceCard'), recap = $('#recapList'), miss = $('#missList');
  if (!box) return;
  let C;
  try { C = await mod('coach'); }
  catch (e) { box.innerHTML = `<p class="muted">听力分析模块没加载出来：${esc(e.message)}</p>`; return; }

  // 语速卡片
  try {
    const p = C.paceStats(session);
    const cls = { slow: 'pace-slow', normal: 'pace-normal', fast: 'pace-fast', 'very-fast': 'pace-veryfast' }[p.level] || 'pace-normal';
    const label = { slow: '偏慢', normal: '正常', fast: '偏快', 'very-fast': '非常快' }[p.level] || '';
    box.innerHTML = `<div><span class="big">${p.wpm}<span class="unit">词/分钟</span></span>
      <span class="tag ${cls}">${label}</span></div><p>${esc(p.comment || '')}</p>`;
  } catch (e) { box.innerHTML = `<p class="muted">语速统计失败：${esc(e.message)}</p>`; }

  const row = (x, kind) => {
    const sev = x.severity ? ` sev-${x.severity}` : '';
    const why = (x.reasons && x.reasons.length) ? x.reasons.join('；') : (x.why || '');
    return `<div class="miss-item${sev}">
      <div class="hd"><button data-goplay="${esc(x.segId || x.id || '')}" title="听这一句的原声">▶</button>
        <span>[${mmss(x.t || 0)}]</span>${kind === 'recap' ? '' : `<span>${x.severity === 'high' ? '最该回听' : x.severity === 'mid' ? '建议回听' : '可以看看'}</span>`}</div>
      <div class="en">${esc(x.text || '')}</div>
      ${x.zh ? `<div class="zh">${esc(x.zh)}</div>` : ''}
      ${why ? `<div class="why">${esc(why)}</div>` : ''}</div>`;
  };

  try {
    const r = C.threeMinuteRecap(session);
    recap.innerHTML = (r.items || []).length ? r.items.map(x => row(x, 'recap')).join('')
      : '<p class="muted">这节课太短，没什么可速览的。</p>';
  } catch (e) { recap.innerHTML = `<p class="muted">速览生成失败：${esc(e.message)}</p>`; }

  try {
    const m = C.findMissed(session, { limit: 15 });
    miss.innerHTML = (m || []).length ? m.map(x => row(x, 'miss')).join('')
      : '<p class="muted">没发现明显跟不上的地方 —— 这节课的语速对你应该不成问题。</p>';
  } catch (e) { miss.innerHTML = `<p class="muted">分析失败：${esc(e.message)}</p>`; }
}

/* ============================== 原声回放 + 跟读 ============================== */
// 适应语速唯一有效的练习：反复听真实语速的原声，再对着它复述。
// 读讲稿不会让耳朵变快。

let PL = null, SHADOW = null;

async function setupPlayer(session) {
  const P = await mod('player');
  const bar = $('#playBar');
  if (!session.hasAudio) { bar.hidden = true; if (PL) { PL.destroy(); PL = null; } return; }

  const rec = await db.get('audio', session.id);
  if (!rec || !rec.blob || !rec.blob.size) {
    // 标着有录音却读不出来（导入的包不完整、存的时候出错、被清理过…）
    // 一定要明说，否则用户只会看到「点了没反应」。
    bar.hidden = false;
    bar.innerHTML = '<span class="muted">⚠️ 这节课标记了有录音，但录音文件读不出来（可能导入时不完整，或被「清理录音」删过）。文字内容不受影响。</span>';
    if (PL) { PL.destroy(); PL = null; }
    return;
  }

  if (PL) PL.destroy();
  PL = new P.SegmentPlayer($('#player'), {
    onState: (st) => {
      const m = Math.floor(st.t / 60), sec = Math.floor(st.t % 60);
      $('#pbTime').textContent = `${m}:${String(sec).padStart(2, '0')}` + (st.dur ? ` / ${Math.floor(st.dur / 60)}:${String(Math.floor(st.dur % 60)).padStart(2, '0')}` : '');
      $('#pbPlay').textContent = st.playing ? '⏸' : '▶';
    }
  });
  PL.onActive = (segId) => highlightPlaying(segId);
  PL.setSegments(P.withEndTimes(session.segments, session.durationMs));

  bar.hidden = false;
  $('#pbTime').textContent = '正在读取录音…';
  const dur = await PL.load(rec.blob);
  $('#pbTime').textContent = dur ? '0:00 / ' + Math.floor(dur / 60) + ':' + String(Math.floor(dur % 60)).padStart(2, '0')
    : '⚠️ 这段录音无法定位（只能从头播）';
  PL.setRate(Number($('#pbRate').value) || 1);
  PL.setLoop($('#pbLoop').checked ? 3 : 0);
}

function highlightPlaying(segId) {
  const host = $('#fullBody');
  const prev = host.querySelector('.seg.playing');
  if (prev && prev.dataset.id === segId) return;
  if (prev) prev.classList.remove('playing');
  if (!segId) return;
  const el = host.querySelector(`.seg[data-id="${segId}"]`);
  if (!el) return;
  el.classList.add('playing');
  if ($('#pbFollow').checked) {
    const r = el.getBoundingClientRect();
    if (r.top < 120 || r.bottom > window.innerHeight - 80) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

function segRange(segId) {
  const s = S.detail; if (!s) return null;
  const sp = s.segments.filter(x => x.kind === 'speech');
  const i = sp.findIndex(x => x.id === segId);
  if (i < 0) return null;
  return { start: sp[i].t, end: i + 1 < sp.length ? sp[i + 1].t : (s.durationMs || sp[i].t + 8000), text: sp[i].text };
}

/** 跟读：先放原声，再录她说一遍，然后对比用时 */
async function shadowPractice(segId) {
  const r = segRange(segId); if (!r || !PL) return toast('这节课没有可回放的录音');
  const P = await mod('player');
  const box = $('#shadowBox');
  box.hidden = false;
  const origMs = r.end - r.start;
  box.innerHTML = `<div class="sb-en">${esc(r.text)}</div><div class="sb-row"><span class="muted">先听一遍原声…</span></div>`;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  await PL.play(segId, r.start, r.end);
  await new Promise(res => setTimeout(res, Math.min(20000, origMs / PL.rate + 500)));

  if (!SHADOW) SHADOW = new P.ShadowRecorder({});
  box.innerHTML = `<div class="sb-en">${esc(r.text)}</div>
    <div class="sb-row"><button class="danger" id="sbStop">⏹ 我说完了</button>
    <span class="muted" id="sbTimer">录音中… 0.0s（原声 ${(origMs/1000).toFixed(1)}s）</span></div>`;
  SHADOW.onState = (st) => { if (st.recording) $('#sbTimer').textContent = `录音中… ${(st.ms/1000).toFixed(1)}s（原声 ${(origMs/1000).toFixed(1)}s）`; };
  try { await SHADOW.start(); }
  catch (e) { box.innerHTML = `<div class="muted">打不开麦克风：${esc(e.message)}</div>`; return; }

  const done = await new Promise(res => {
    $('#sbStop').onclick = async () => res(await SHADOW.stop());
    setTimeout(async () => { if (SHADOW.recording) res(await SHADOW.stop()); }, Math.min(30000, origMs * 4 + 4000));
  });
  if (!done) { box.innerHTML = '<div class="muted">没录到声音，再试一次</div>'; return; }

  const cmp = P.compareShadow(origMs, done.ms);
  const url = URL.createObjectURL(done.blob);
  box.innerHTML = `<div class="sb-en">${esc(r.text)}</div>
    <div class="sb-verdict sb-${cmp.tone}">${esc(cmp.verdict)}</div>
    <div class="sb-row">
      <button class="ghost" id="sbOrig">▶ 原声 ${(origMs/1000).toFixed(1)}s</button>
      <button class="ghost" id="sbMine">▶ 我的 ${(done.ms/1000).toFixed(1)}s</button>
      <button class="ghost" id="sbAgain">🔁 再来一次</button>
      <button class="ghost" id="sbClose">关闭</button>
    </div>`;
  const mine = new Audio(url);
  $('#sbOrig').onclick = () => PL.play(segId, r.start, r.end);
  $('#sbMine').onclick = () => { mine.currentTime = 0; mine.play().catch(() => {}); };
  $('#sbAgain').onclick = () => shadowPractice(segId);
  $('#sbClose').onclick = () => { box.hidden = true; try { URL.revokeObjectURL(url); } catch (_) {} };
}

function bindPlayerUI() {
  on('#pbPlay', 'click', () => { if (PL) PL.toggle(); });
  on('#pbPrev', 'click', () => { if (PL) PL.step(-1); });
  on('#pbNext', 'click', () => { if (PL) PL.step(1); });
  on('#pbRate', 'change', (e) => { if (PL) PL.setRate(Number(e.target.value)); });
  on('#pbLoop', 'change', (e) => { if (PL) PL.setLoop(e.target.checked ? 3 : 0); });

  // 回听清单里的 ▶：切到讲稿、滚过去、播放那一句
  on('#pane-coach', 'click', (e) => {
    const b = e.target.closest('[data-goplay]');
    if (!b) return;
    const id = b.dataset.goplay;
    if (!id) return;
    showPane('full');
    setTimeout(() => {
      const el = $(`#fullBody .seg[data-id="${id}"]`);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const r = segRange(id);
      if (PL && PL.ready && r) PL.play(id, r.start, r.end);
      else toast(PL ? '录音还在读取中，稍等一下再点' : '这节课没有可播放的录音，只能看文字', 4000);
    }, 120);
  });

  // 句子上的三个按钮（事件委托，段落是动态渲染的）
  on('#fullBody', 'click', (e) => {
    const b = e.target.closest('[data-play],[data-loop3],[data-shadow]');
    if (!b) return;
    e.stopPropagation();
    if (!PL) return toast('这节课没有保存录音');
    const id = b.dataset.play || b.dataset.loop3 || b.dataset.shadow;
    const r = segRange(id);
    if (!r) return;
    if (b.dataset.shadow) return shadowPractice(id).catch(err => toast(err.message));
    if (b.dataset.loop3) { PL.setLoop(3); $('#pbLoop').checked = true; return PL.play(id, r.start, r.end); }
    PL.play(id, r.start, r.end);
  });

  // 键盘：空格播放/暂停，左右切句
  document.addEventListener('keydown', (e) => {
    if (!PL || $('#view-session').hidden || !$('#pane-full') || $('#pane-full').hidden) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.code === 'Space') { e.preventDefault(); PL.toggle(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); PL.step(-1); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); PL.step(1); }
  });
}

/* ============================== 课后精修（双模型融合） ============================== */
// 实测（修掉批量对齐放大之后）：Qwen 1.5B 贪心解码 1.33 秒/句。
// 这里按 3 秒/句报给用户，留足余量（偶尔有单句回退，浏览器和 node 也有差异）。
const SEC_PER_LINE = 3;

// 思路：两个翻译模型性格互补 ——
//   opus-mt：短句准、术语准、**数字和日期准**，但长句会漏掉后半截
//   本地 LLM：长句完整、懂上下文，但会把术语简化、**把 before midnight 译成"凌晨"**
// 所以两边各翻一遍，再用**确定性规则**逐句打分取优（不再叫第三个模型来评判，
// 那只会引入第三种错误还更慢）。数字/日期保真权重最高——作业和考试时间错了危害最大。

async function loadFuser() {
  try {
    const F = await mod('fuse');
    // 校验接口齐全再用 —— 万一文件被写坏/写了一半，宁可退回简易版也不能崩
    if (F && typeof F.fuseMany === 'function' && typeof F.explainStats === 'function') return F;
    console.warn('[VC] fuse.js 接口不完整，退回简易择优');
  } catch (e) { console.warn('[VC] fuse.js 加载失败，退回简易择优：', e.message); }
  {
    // fuse.js 还没到位时的简易版：只保证不崩，规则粗糙
    const G = await import('./glossary.js');
    return {
      fuseMany(items) {
        const results = items.map(it => {
          const cands = [{ zh: it.mt, from: 'mt' }, { zh: it.llm, from: 'llm' }]
            .filter(c => c.zh && c.zh.trim() && !G.looksDegenerate(c.zh, it.en).bad);
          if (!cands.length) return { id: it.id, zh: '', from: '', reason: '两边都不可用' };
          // 原文里有数字就信 opus-mt，长句就信 LLM，其余选长的
          const hasNum = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteenth|midnight|noon|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(it.en);
          const words = (it.en.match(/[A-Za-z0-9'’-]+/g) || []).length;
          let pick;
          if (hasNum) pick = cands.find(c => c.from === 'mt') || cands[0];
          else if (words > 25) pick = cands.find(c => c.from === 'llm') || cands[0];
          else pick = cands.sort((a, b) => b.zh.length - a.zh.length)[0];
          const other = cands.find(c => c !== pick);
          return { id: it.id, zh: pick.zh, from: pick.from, runnerUp: other ? other.zh : '', reason: hasNum ? '含数字/日期，优先精确的那个' : (words > 25 ? '长句，优先完整的那个' : '取信息更全的') };
        });
        const stats = { mt: results.filter(r => r.from === 'mt').length, llm: results.filter(r => r.from === 'llm').length, none: results.filter(r => !r.from).length };
        return { results, stats };
      },
      explainStats: (st) => `opus-mt 胜出 ${st.mt} 句，本地大模型胜出 ${st.llm} 句，${st.none} 句两边都没译出来。`
    };
  }
}

async function perfectPass(silent) {
  const s = S.detail; if (!s) return;
  const speech = s.segments.filter(x => x.kind === 'speech' && x.text && x.text.trim());
  if (!speech.length && !s.hasAudio) return toast('这节课既没有讲稿也没有录音');

  const canRedo = !!s.hasAudio;
  const n = speech.length || 200;
  const mins = Math.max(2, Math.ceil(n * 3 / 60) + (canRedo ? 3 : 0));

  const r = silent ? { redo: canRedo ? 'yes' : 'no', go: '开始' } : await dialog('🏆 课后精修', [
    { name: 'redo', label: '第一步：重新识别', type: 'select', value: canRedo ? 'yes' : 'no',
      options: canRedo
        ? [{ v: 'yes', t: '用更准的 Whisper 重新识别整段录音（推荐）' }, { v: 'no', t: '跳过，用现在的讲稿' }]
        : [{ v: 'no', t: '这节课没有录音，只能用现在的讲稿' }] },
    { name: 'go', label:
        `第二步：两个翻译模型各翻一遍，逐句取优。\n\n` +
        `⚠️ 全程大约 ${mins} 分钟（${n} 句 × 约 20 秒），很吃电，建议插电后放着跑。\n` +
        `期间可以正常用软件的其他功能。\n\n输入「开始」确认：`,
      placeholder: '开始' }
  ], '开始精修');
  if (!r || r.go !== '开始') return toast('已取消');

  showPane('full');
  const meta = $('#sMeta');
  const setMsg = (m) => { meta.textContent = m; };

  // ---- 第一步：重新识别 ----
  if (r.redo === 'yes') {
    setMsg('【1/4】正在解码录音…');
    try {
      const rec = await db.get('audio', s.id);
      const A = await mod('audio');
      const pcm = await A.blobToPCM16k(rec.blob);
      setMsg(`【1/4】正在用 Whisper 重新识别 ${Math.round(pcm.length / 16000 / 60)} 分钟录音…`);
      const C = await mod('whisper-client');
      const w = new C.WhisperWorker({ model: 'onnx-community/whisper-small', language: String(s.srcLang || 'en').split('-')[0] });
      const text = await w.transcribeAll(pcm, { model: 'onnx-community/whisper-small', ms: 3600000 });
      w.terminate();
      if (text && text.trim()) {
        const sents = text.split(/(?<=[.!?。！？])\s+/).map(x => x.trim()).filter(Boolean);
        const total = s.durationMs || (pcm.length / 16000 * 1000);
        s.segmentsPrev = s.segments.filter(x => x.kind === 'speech');
        const keep = s.segments.filter(x => x.kind !== 'speech');
        s.segments = [...sents.map((t, i) => ({ id: uid(), t: Math.round(total * i / Math.max(1, sents.length)), text: t, zh: '', kind: 'speech', src: 'whisper-redo' })), ...keep]
          .sort((a, b) => a.t - b.t);
        await db.put('sessions', s);
        setMsg(`【1/4】重新识别完成，共 ${sents.length} 句`);
      }
    } catch (e) { toast('重新识别失败：' + e.message + '，继续用现有讲稿'); }
  }

  // 把上课时的译文留一份，等下当作第二个候选参与比较
  for (const seg of s.segments) if (seg.kind === 'speech' && seg.zh) seg._oldZh = seg.zh;
  const items = s.segments.filter(x => x.kind === 'speech' && x.text && x.text.trim())
    .map(x => ({ id: x.id, en: x.text }));
  if (!items.length) { openSession(s.id); return toast('没有可翻译的内容'); }

  // ---- 第二步：opus-mt（快）----
  setMsg(`【2/4】opus-mt 正在翻译 ${items.length} 句…`);
  try {
    let k = 0;
    await T.translateMany(items.map(x => ({ text: x.en, _id: x.id })), s.srcLang || 'en-US',
      (s.dstLang && s.dstLang !== 'off') ? s.dstLang : 'zh-Hans',
      (item, zh) => { const it = items.find(y => y.id === item._id); if (it) it.mt = zh; if (++k % 20 === 0) setMsg(`【2/4】opus-mt ${k}/${items.length}`); },
      3, { skipHQ: true });   // ← 必须显式跳过高质量引擎，否则这一轮也会走 LLM，双模型就白做了
  } catch (e) { toast('opus-mt 翻译出错：' + e.message); }

  // ---- 第三步：本地大模型（**默认关闭**）----
  // 实测结论：1.5B 在浏览器里 WebGPU 数值崩溃、WASM 内存不足；0.5B 能跑但会编造内容
  //（把 "changing nature of privacy in the digital age" 译成「这是一个好问题但需要时间回答」，
  // 把 "due Friday before midnight" 译成「明天凌晨四点」）。三条测试全部被择优器拦下，0 胜 3 负。
  // 所以默认不跑它 —— 与其花 488MB 和大把时间换一堆会被丢弃的译文，不如老实用 opus-mt。
  // 想自己试的人可以在设置里打开。
  if (!settings().useLocalLLM) {
    setMsg('【3/4】跳过本地大模型（默认关闭，设置里可开）');
  } else try {
    const tr = await getHQ((st2, d) => {
      if (st2 === 'downloading' && d) {
        const pct = typeof d === 'number' ? d : (d.pct ?? d.progress ?? 0);
        setMsg(`【3/4】下载模型 ${Math.round(pct)}%…`);
      }
    });
    let k = 0;
    await tr.translateMany(items.map(x => ({ id: x.id, text: x.en })), (item, zh) => {
      // 这个回调里**绝对不能抛异常** —— 一抛就会把整批翻译中断在第一句上。
      try {
      const it = items.find(y => y.id === item.id);
      if (it) it.llm = zh;
      k++;
      const left = Math.max(1, Math.ceil((items.length - k) * SEC_PER_LINE / 60));
      setMsg(`【3/4】本地大模型 ${k}/${items.length}　·　预计还要 ${left} 分钟`);
      } catch (err) { console.warn('[VC] 进度回调出错（已忽略，不影响翻译）：', err); }
    });
  } catch (e) { toast('大模型翻译中断：' + e.message + '，将只用 opus-mt 的结果'); }

  // ---- 第四步：逐句取优 ----
  // LLM 关掉时仍然是**双候选**：这次重新识别+重新翻译出来的新译文，
  // 对比上课时那一版旧译文。重新识别用的是更准的 whisper-small，原文都可能不一样，
  // 所以这是货真价实的两个候选，不是自己跟自己比。
  setMsg('【4/4】正在逐句对比打分…');
  const useLLM = settings().useLocalLLM;
  if (!useLLM) {
    for (const it of items) {
      const seg = s.segments.find(x => x.id === it.id);
      it.llm = (seg && seg._oldZh) || '';      // 旧译文当第二个候选
    }
  }
  const F = await loadFuser();
  if (window.__vcDebugFuse) window.__vcFuseInput = JSON.parse(JSON.stringify(items));
  const { results, stats } = F.fuseMany(items, useLLM ? undefined : {
    names: { mt: '重新翻译', llm: '上课时的译文' }
  });
  let changed = 0;
  for (const res of results) {
    const seg = s.segments.find(x => x.id === res.id);
    if (!seg || !res.zh) continue;
    if (seg.zh !== res.zh) changed++;
    seg.zh = res.zh;
    // runnerUp 可能是 {zh, from, score} 对象（fuse.js），也可能是字符串（简易版），两种都兼容
    const ru = res.runnerUp;
    seg.zhAlt = typeof ru === 'string' ? ru : (ru && typeof ru.zh === 'string' ? ru.zh : '');
    seg.zhAltFrom = (ru && ru.from) || '';
    seg.zhFrom = res.from;
    seg.zhWhy = res.reason || '';
  }
  s.perfectedAt = Date.now();
  s.perfectStats = stats;
  await db.put('sessions', s);

  toast('精修完成：' + (F.explainStats ? F.explainStats(stats) : `更新了 ${changed} 句`), 8000);
  await openSession(s.id);
  await regenSummary();
}

/* ============================== AI 学习包 ============================== */
let aiPack = null;

async function openAiPack(kind) {
  const P = await mod('aipack');
  const d = $('#aiDlg');
  const tSel = $('#aiTarget'), mSel = $('#aiMode');
  if (!tSel.dataset.filled) {
    tSel.innerHTML = Object.entries(P.TARGETS).map(([k, v]) => `<option value="${k}">${esc(v.label)} — ${esc(v.note)}</option>`).join('');
    mSel.innerHTML = Object.entries(P.MODES).map(([k, v]) => `<option value="${k}">${esc(v.label)} — ${esc(v.desc)}</option>`).join('');
    $('#aiLinks').innerHTML = '打开 AI：' + P.AI_LINKS.map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener">${esc(n)}</a>`).join('');
    tSel.dataset.filled = '1';
  }
  const rebuild = () => {
    const opts = { target: tSel.value, mode: mSel.value, withZh: $('#aiZh').checked };
    aiPack = kind === 'all'
      ? P.buildReviewPack(S.reviewList || [], S.reviewCtx || {}, opts)
      : P.buildPack(S.detail, S.detailCtx || {}, opts);
    const host = $('#aiParts');
    host.innerHTML = aiPack.parts.map((p, i) =>
      `<button type="button" class="ghost" data-part="${i}">📋 复制${esc(p.label)}</button>`).join('') +
      `<span class="muted" style="align-self:center">共 ${aiPack.chars.toLocaleString()} 字${aiPack.parts.length > 1 ? `，分 ${aiPack.parts.length} 段按顺序贴` : ''}</span>`;
    $('#aiPreview').value = aiPack.parts[0].text;
    $$('[data-part]', host).forEach(b => b.onclick = async () => {
      const p = aiPack.parts[+b.dataset.part];
      $('#aiPreview').value = p.text;
      if (await P.copyText(p.text)) { b.classList.add('done'); b.textContent = '✓ 已复制' + p.label; toast('已复制，去 AI 那边粘贴（⌘V）'); }
      else toast('复制失败，请手动全选下面的文本框');
    });
  };
  tSel.onchange = mSel.onchange = $('#aiZh').onchange = rebuild;
  $('#aiSave').onclick = () => aiPack && download(
    `AI学习包_${(aiPack.title || '').replace(/[\\/:*?"<>|]/g, '_')}.txt`,
    aiPack.parts.map(p => `===== ${p.label} =====\n${p.text}`).join('\n\n'), 'text/plain;charset=utf-8');
  $('#aiClose').onclick = () => d.close();
  rebuild();
  d.showModal();
}

/* ============================== 课程包：在 App 和浏览器之间搬运 ============================== */
async function exportPack() {
  const s = S.detail; if (!s) return;
  const P = await mod('pack');
  toast('正在打包（含录音，可能要几秒）…', 4000);
  const rec = s.hasAudio ? await db.get('audio', s.id) : null;
  let chunks = [];
  try { chunks = (await db.byIndex('chunks', 'sessionId', s.id)).sort((a, b) => a.i - b.i); } catch (_) {}
  const blob = P.buildPack(s, S.detailCtx, rec && rec.blob, chunks);
  download(P.packName(s, S.detailCtx), blob);
  toast(`已导出 ${P.humanSize(blob.size)}。拖进浏览器版或别的电脑就能完整恢复。`, 7000);
}

async function importPacks(files) {
  const P = await mod('pack');
  let ok = 0, fail = 0;
  for (const f of files) {
    try {
      const { session, ctx, audioBlob, chunks } = await P.parsePack(f);

      // 老师/学科按名字合并，没有就新建（不同设备上的 id 不一样，只能按名字认）
      const findOrAdd = async (store, list, name) => {
        if (!name) return (list[0] && list[0].id) || '';
        const hit = list.find(x => x.name === name);
        if (hit) return hit.id;
        const item = { id: uid(), name, createdAt: Date.now() };
        await db.put(store, item);
        return item.id;
      };
      session.teacherId = await findOrAdd('teachers', S.teachers, ctx && ctx.teacher);
      await loadLists();
      session.courseId = await findOrAdd('courses', S.courses, ctx && ctx.course);
      await loadLists();

      // id 撞车就换一个，别覆盖本机已有的课
      const exists = await db.get('sessions', session.id);
      if (exists) {
        session.id = uid();
        session.title = session.title + '（导入）';
      }
      session.hasAudio = !!audioBlob;
      session.hasChunks = chunks.length > 0;
      await db.put('sessions', session);
      if (audioBlob) await db.put('audio', { sessionId: session.id, blob: audioBlob, type: audioBlob.type });
      for (const c of chunks) {
        await db.put('chunks', { key: session.id + '#' + String(c.i).padStart(5, '0'), sessionId: session.id, i: c.i, at: c.at, blob: c.blob });
      }
      ok++;
    } catch (e) { fail++; console.warn('[VC] 导入失败', f.name, e); }
  }
  S.sessions = await db.sessionsSorted();
  drawLibrary();
  toast(`导入完成：成功 ${ok} 节${fail ? `，失败 ${fail} 节（文件可能损坏）` : ''}`, 6000);
}

/* ============================== 云盘备份 ============================== */
// 本机 IndexedDB 仍是主存储；云盘文件夹是自动备份。
// 桌面版走 Electron 原生 fs（不用走浏览器的权限流程），网页版走 File System Access API。

const isDesktop = () => !!(window.VCDesktop && window.VCDesktop.isDesktop);

async function cloudCtx(sess) {
  return { teacher: nameOf(S.teachers, sess.teacherId), course: nameOf(S.courses, sess.courseId) };
}

/** 备份一节课。返回 {ok, skipped?, name?, reason?} */
// 录音留档（见 archive.js）：下课、改概要、改信息之后都调一次，存档永远是最新版本。
// 失败不打扰上课 —— 记在这节课上，设置页和课程页能看到，下次再试。
async function archiveOne(sess) {
  let A; try { A = await mod('archive'); } catch (_) { return { ok: false }; }
  if (!A.available()) return { ok: false };
  const st = settings();
  if (st.archive === false) return { ok: false, skipped: true };
  try {
    const P = await mod('pack');
    const ctx = { teacher: nameOf(S.teachers, sess.teacherId), course: nameOf(S.courses, sess.courseId) };
    const rec = sess.hasAudio ? await db.get('audio', sess.id) : null;
    let chunks = [];
    if (sess.hasChunks) { try { chunks = (await db.byIndex('chunks', 'sessionId', sess.id)).sort((a, b) => a.i - b.i); } catch (_) {} }
    const pack = P.buildPack(sess, ctx, rec && rec.blob, chunks);
    const r = await A.saveSession(sess, ctx, { st, audio: rec && rec.blob, pack });
    const fresh = await db.get('sessions', sess.id) || sess;
    if (r.ok) { fresh.archiveRel = r.rel; fresh.archivedAt = Date.now(); fresh.archiveError = ''; }
    else fresh.archiveError = r.error || '存档失败';
    await db.put('sessions', fresh);
    if (S.detail && S.detail.id === fresh.id) Object.assign(S.detail, { archiveRel: fresh.archiveRel, archivedAt: fresh.archivedAt, archiveError: fresh.archiveError });
    return r;
  } catch (e) {
    console.warn('[VC] 存档失败', e);
    return { ok: false, error: e.message };
  }
}

async function backupOne(sess, { force = false } = {}) {
  const st = settings();
  const P = await mod('pack');
  const ctx = await cloudCtx(sess);
  const name = P.packName(sess, ctx);

  // 指纹：内容没变就不重复写（云盘同步很贵）
  const stamp = [sess.id, sess.segments.length, sess.endedAt || 0, (sess.summary || '').length,
                 (sess.myNotes || '').length, sess.perfectedAt || 0, sess.redoneAt || 0].join('-');
  if (!force) {
    try { const d = await db.get('kv', 'cloud.done.' + sess.id); if (d && d.stamp === stamp) return { ok: true, skipped: true, name }; }
    catch (_) {}
  }

  const rec = sess.hasAudio ? await db.get('audio', sess.id) : null;
  let chunks = [];
  if (sess.hasChunks) { try { chunks = (await db.byIndex('chunks', 'sessionId', sess.id)).sort((a, b) => a.i - b.i); } catch (_) {} }
  const blob = P.buildPack(sess, ctx, rec && rec.blob, chunks);

  if (isDesktop() && st.cloudDir) {
    const r = await window.VCDesktop.writeBackup(st.cloudDir, name, blob);
    if (!r || !r.ok) return { ok: false, reason: (r && r.error) || '写入失败' };
  } else {
    const C = await mod('cloud');
    const dir = await C.getFolder({ prompt: false });
    if (!dir) return { ok: false, reason: '备份文件夹没有权限，去设置里点一下重新授权' };
    await C.writeFile(dir, name, blob);
  }
  try { await db.put('kv', { k: 'cloud.done.' + sess.id, stamp, at: Date.now(), name, size: blob.size }); } catch (_) {}
  return { ok: true, name, size: blob.size };
}

async function renderCloudFolders() {
  const box = $('#cloudFolders');
  if (!box) return;
  const st = settings();
  if (!isDesktop()) {
    const C = await mod('cloud').catch(() => null);
    box.innerHTML = C && C.supported()
      ? '<span class="muted">网页版：点右边「自己选一个文件夹」，选你的 iCloud 云盘或 Google Drive 文件夹。</span>'
      : '<span class="muted">这个浏览器不支持选文件夹，请用桌面版，或用「导出全部数据」手动备份。</span>';
    return;
  }
  let list = [];
  try { list = await window.VCDesktop.cloudFolders(); } catch (_) {}
  if (!list.length) { box.innerHTML = '<span class="muted">没检测到云盘文件夹。装好 Google Drive 或打开 iCloud 云盘后再来，或者自己选一个。</span>'; return; }
  box.innerHTML = list.map((f, i) =>
    `<button class="${st.cloudDir === f.dir ? 'primary' : 'ghost'}" data-cloud="${i}">${st.cloudDir === f.dir ? '✓ ' : ''}${esc(f.label)}</button>`).join('');
  $$('[data-cloud]', box).forEach(b => b.onclick = async () => {
    const f = list[+b.dataset.cloud];
    saveSettings({ cloudDir: f.dir });
    toast('备份目标：' + f.label + '/VoiceCollector', 5000);
    renderCloudFolders(); renderCloudStatus();
  });
}

async function renderCloudStatus() {
  const el = $('#cloudStatus'); if (!el) return;
  const st = settings();
  let where = '';
  if (isDesktop() && st.cloudDir) where = st.cloudDir + '/VoiceCollector';
  else { try { const C = await mod('cloud'); where = await C.folderName(); } catch (_) {} }
  if (!where) { el.textContent = '还没设置备份文件夹'; return; }
  let done = 0;
  try { done = (await db.all('kv')).filter(x => String(x.k).startsWith('cloud.done.')).length; } catch (_) {}
  el.textContent = `备份到：${where}　·　已备份 ${done} 节课`;
}

async function pickCloudFolder() {
  if (isDesktop()) {
    toast('桌面版请直接点上面检测到的云盘按钮；想用别的位置，把课程包手动导出到那里即可', 6000);
    return;
  }
  const C = await mod('cloud');
  try {
    const dir = await C.pickFolder();
    saveSettings({ cloudDir: dir.name });
    toast('已选择：' + dir.name, 4000);
    renderCloudStatus();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    toast('选择失败：' + e.message);
  }
}

async function backupAllNow() {
  const st = settings();
  if (!st.cloudDir && !isDesktop()) {
    const C = await mod('cloud');
    if (!(await C.getFolder({ prompt: true }))) return toast('请先选一个备份文件夹');
  }
  if (isDesktop() && !st.cloudDir) return toast('请先在上面选一个云盘文件夹');
  const list = await db.sessionsSorted();
  if (!list.length) return toast('还没有课程');
  let ok = 0, skip = 0, fail = 0;
  for (let i = 0; i < list.length; i++) {
    $('#cloudStatus').textContent = `备份中 ${i + 1}/${list.length}…`;
    try { const r = await backupOne(list[i]); if (r.skipped) skip++; else if (r.ok) ok++; else fail++; }
    catch (_) { fail++; }
  }
  toast(`备份完成：新写 ${ok} 节，已是最新 ${skip} 节${fail ? `，失败 ${fail} 节` : ''}`, 6000);
  renderCloudStatus();
}

/* ============================== 整学期归档 ============================== */
function semesterSessions() {
  const tf = $('#libTeacher').value, cf = $('#libCourse').value;
  return {
    list: S.sessions.filter(s => (!tf || s.teacherId === tf) && (!cf || s.courseId === cf)),
    teacher: nameOf(S.teachers, tf), course: nameOf(S.courses, cf)
  };
}

/** 把一门课整学期的讲稿合成一份 Word，复习期中期末用 */
async function semesterDoc() {
  const { list, teacher, course } = semesterSessions();
  if (!list.length) return toast('当前筛选下没有课');
  const E = await mod('export');
  const ordered = [...list].sort((a, b) => a.startedAt - b.startedAt);
  const title = `${course || '全部学科'}${teacher ? ' · ' + teacher : ''} 整学期讲稿`;
  let body = `<h1>${esc(title)}</h1><p style="color:#666">共 ${ordered.length} 节课 · ${dateCN(ordered[0].startedAt)} 至 ${dateCN(ordered[ordered.length - 1].startedAt)} · VoiceCollector</p>`;
  body += '<h2>目录</h2><ol>' + ordered.map(s => `<li>${esc(s.title)}（${dateCN(s.startedAt)}）</li>`).join('') + '</ol>';
  for (const s of ordered) {
    body += `<div style="page-break-before:always"></div><h1>${esc(s.title)}</h1>`;
    body += `<p style="color:#666">${dateCN(s.startedAt)} · 时长 ${mmss(s.durationMs || 0)}</p>`;
    if (s.summary) body += `<h2>课堂概要</h2>` + md2html(s.summary);
    if (s.myNotes) body += `<h2>我的笔记</h2><pre style="white-space:pre-wrap;font-family:inherit">${esc(s.myNotes)}</pre>`;
    body += `<h2>完整讲稿</h2>`;
    for (const g of s.segments) {
      if (g.kind !== 'speech') continue;
      body += `<p style="margin:0 0 10px"><span style="color:#999;font-size:9pt">[${mmss(g.t)}]</span> ${esc(g.text)}`;
      if (g.zh) body += `<br><span style="color:#0a6b3d">${esc(g.zh)}</span>`;
      body += '</p>';
    }
  }
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:"PingFang SC","Microsoft YaHei",Calibri,sans-serif;font-size:11pt;line-height:1.65}h1{font-size:17pt}h2{font-size:14pt}</style></head><body>${body}</body></html>`;
  download(`${title.replace(/[\\/:*?"<>|]/g, '_')}.doc`, '\ufeff' + html, 'application/msword;charset=utf-8');
  toast(`已导出 ${ordered.length} 节课的合并讲稿`, 5000);
}

/** 整学期逐节打包备份（云盘或下载） */
async function semesterPack() {
  const { list, course } = semesterSessions();
  if (!list.length) return toast('当前筛选下没有课');
  const st = settings();
  const toCloud = isDesktop() ? !!st.cloudDir : !!(await (await mod('cloud')).getFolder({ prompt: true }));
  if (!toCloud && !confirm(`没有设置云盘文件夹，将逐个下载 ${list.length} 个课程包到「下载」文件夹。继续？`)) return;
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    toast(`打包中 ${i + 1}/${list.length}…`, 2000);
    try {
      if (toCloud) { const r = await backupOne(list[i], { force: true }); if (r.ok) ok++; }
      else {
        const P = await mod('pack');
        const ctx = await cloudCtx(list[i]);
        const rec = list[i].hasAudio ? await db.get('audio', list[i].id) : null;
        download(P.packName(list[i], ctx), P.buildPack(list[i], ctx, rec && rec.blob, []));
        ok++;
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (_) {}
  }
  toast(`${course || '全部'}：完成 ${ok}/${list.length} 节`, 6000);
  renderCloudStatus();
}

/* ============================== 数据管理 ============================== */
async function openManager(store, label) {
  const list = store === 'teachers' ? S.teachers : S.courses;
  const field = store === 'teachers' ? 'teacherId' : 'courseId';
  const sessions = await db.sessionsSorted();
  const countOf = id => sessions.filter(x => x[field] === id).length;

  const d = $('#dlg');
  $('#dlgTitle').textContent = '管理' + label;
  $('#dlgOk').textContent = '完成';
  const draw = () => {
    const cur = store === 'teachers' ? S.teachers : S.courses;
    $('#dlgBody').innerHTML = cur.length ? cur.map(x => `
      <div class="mgr-row" data-id="${x.id}">
        <input value="${esc(x.name)}" data-name>
        <span class="n">${countOf(x.id)} 节</span>
        <button type="button" class="ghost" data-save title="保存改名">✓</button>
        <button type="button" class="danger" data-rm title="删除">🗑</button>
      </div>`).join('') + `<p class="muted">改完名字点 ✓ 保存。删除${label}不会删掉课，那些课会变成「未分类」。</p>`
      : `<p class="muted">还没有${label}。</p>`;
    bind();
  };
  const bind = () => {
    $$('#dlgBody [data-save]').forEach(b => b.onclick = async () => {
      const row = b.closest('.mgr-row');
      const name = row.querySelector('[data-name]').value.trim();
      if (!name) return;
      const item = (store === 'teachers' ? S.teachers : S.courses).find(x => x.id === row.dataset.id);
      await db.put(store, { ...item, name });
      await loadLists();
      toast('已改名');
      draw();
    });
    $$('#dlgBody [data-rm]').forEach(b => b.onclick = async () => {
      const row = b.closest('.mgr-row');
      const item = (store === 'teachers' ? S.teachers : S.courses).find(x => x.id === row.dataset.id);
      const n = countOf(item.id);
      if (!confirm(n ? `删除「${item.name}」？\n名下还有 ${n} 节课，那些课不会被删，只会变成「未分类」。`
                     : `删除「${item.name}」？`)) return;
      await db.del(store, item.id);
      await loadLists();
      toast('已删除');
      draw();
    });
  };
  draw();
  d.returnValue = '';
  d.showModal();
  d.addEventListener('close', async () => { await loadLists(); renderSettings(); }, { once: true });
}

async function purge(kind) {
  const sessions = await db.sessionsSorted();
  if (kind === 'chunks') {
    if (!confirm('删除所有「分段音频」？\n这些是留给「云端重新转写」用的。删掉不影响已生成的讲稿和概要。')) return;
    await db.clear('chunks');
    for (const s of sessions) if (s.hasChunks) { s.hasChunks = false; await db.put('sessions', s); }
    toast('分段音频已清理');
  } else {
    if (!confirm('删除所有录音文件？\n文字讲稿和概要都会保留，但以后没法重听、也没法重新转写了。')) return;
    await db.clear('audio');
    await db.clear('chunks');
    for (const s of sessions) { s.hasAudio = false; s.hasChunks = false; await db.put('sessions', s); }
    toast('录音已清理');
  }
  S.sessions = await db.sessionsSorted();
  renderSettings();
}

async function wipeAll() {
  const r = await dialog('清空全部数据', [
    { name: 'c', label: '这会删掉所有课程记录、讲稿、概要、录音、老师和学科，无法恢复。\n建议先「导出全部数据」备份。\n\n确认请输入「全部删除」：', placeholder: '全部删除' }
  ], '永久删除');
  if (!r || r.c !== '全部删除') return toast('已取消');
  for (const st of ['sessions', 'audio', 'chunks', 'teachers', 'courses']) {
    try { await db.clear(st); } catch (_) {}
  }
  await loadLists();
  S.sessions = [];
  toast('已清空');
  go('library');
}

/* ============================== 设置 ============================== */
function renderSettings() {
  const s = settings();
  renderArchiveBox().catch(() => {});
  $('#setProvider').value = s.provider;
  $('#setKey').value = s.apiKey;
  $('#setBase').value = s.baseUrl;
  $('#setModel').value = s.model;
  $('#setAudioBackup').checked = s.audioBackup;
  $('#setCloudASR').checked = s.cloudASR;
  $('#setAGC').checked = s.agc;
  $('#setNS').checked = s.ns;
  $('#setLiveTrans').checked = s.liveTranslate;
  $('#setWake').checked = s.wakeLock;
  $('#setFar').checked = s.farMode;
  $('#setBoost').value = s.boost;
  $('#boostVal').textContent = Number(s.boost).toFixed(1) + '×';
  $('#setKeepChunks').checked = s.keepChunks;
  $('#setLLM').checked = s.useLocalLLM;
  $('#setPower').checked = s.powerSaver;
  $('#setAutoPerfect').checked = s.autoPerfect;
  $('#setAutoBackup').checked = s.autoBackup;
  renderCloudFolders(); renderCloudStatus();
  $('#setMtEngine').value = s.mtEngine || 'auto';
  if (!$('#setMtModel').dataset.filled) {
    mod('mtllm-client').then(async C => {
      const w = new C.MTLLM({});
      try {
        const p = await w.probe();
        // 只有打包进来的模型才标「已内置」，其余会现场联网下载（上课时千万别选）
        const BUNDLED = ['onnx-community/Qwen2.5-1.5B-Instruct'];
        $('#setMtModel').innerHTML = p.models.map(m =>
          `<option value="${m.id}">${esc(m.label)} · ${m.sizeMB}MB${BUNDLED.includes(m.id) ? ' · 已内置' : ' · 需联网下载'}</option>`).join('');
        $('#setMtModel').dataset.filled = '1';
        $('#setMtModel').value = s.llmMtModel || BUNDLED[0];
      } catch (_) { $('#setMtModel').innerHTML = '<option value="">（模块未就绪）</option>'; }
      w.terminate();
    }).catch(() => {});
  }
  db.usage().then(u => {
    $('#storageInfo').textContent = u.quota
      ? `已用 ${(u.used / 1048576).toFixed(1)} MB / 可用约 ${(u.quota / 1073741824).toFixed(1)} GB（${S.sessions.length} 节课）`
      : '—';
  });
  db.all('chunks').then(cs => {
    const mb = cs.reduce((a, c) => a + (c.blob ? c.blob.size : 0), 0) / 1048576;
    if (cs.length) $('#storageInfo').textContent += ` · 分段音频 ${cs.length} 段 / ${mb.toFixed(1)} MB`;
  }).catch(() => {});
}
function bindSettings() {
  const put = () => saveSettings({
    provider: $('#setProvider').value,
    apiKey: $('#setKey').value.trim(),
    baseUrl: $('#setBase').value.trim(),
    model: $('#setModel').value.trim(),
    audioBackup: $('#setAudioBackup').checked,
    cloudASR: $('#setCloudASR').checked,
    agc: $('#setAGC').checked,
    ns: $('#setNS').checked,
    liveTranslate: $('#setLiveTrans').checked,
    wakeLock: $('#setWake').checked,
    farMode: $('#setFar').checked,
    boost: Number($('#setBoost').value) || 1,
    keepChunks: $('#setKeepChunks').checked,
    powerSaver: $('#setPower').checked,
    autoPerfect: $('#setAutoPerfect').checked,
    autoBackup: $('#setAutoBackup').checked,
    useLocalLLM: $('#setLLM').checked,
    llmModel: $('#selLLM').value || ''
  });
  // 切「大教室模式」时，没手动选过模型的话要让下拉框跟着变（base ⇄ small）
  $('#setFar').addEventListener('change', () => {
    const sel = $('#selWModel');
    if (sel && sel.dataset.filled && !settings().whisperModel) {
      sel.value = SMALL_MODEL;
    }
  });
  ['#setProvider', '#setKey', '#setBase', '#setModel', '#setAudioBackup', '#setCloudASR',
   '#setAGC', '#setNS', '#setLiveTrans', '#setWake', '#setFar', '#setKeepChunks', '#setLLM', '#selLLM', '#setPower', '#setAutoPerfect', '#setAutoBackup'].forEach(sel => {
    $(sel).addEventListener('change', () => { put(); renderDiag(); renderEngineUI(); });
  });
  $('#setBoost').addEventListener('input', () => {
    $('#boostVal').textContent = Number($('#setBoost').value).toFixed(1) + '×';
    put();
    if (S.mic) S.mic.setBoost(Number($('#setBoost').value));
  });
  $('#setPower').addEventListener('change', () => {
    if ($('#setPower').checked && $('#setFar').checked) {
      toast(IS_DESKTOP
      ? '省电模式已开：音量表和翻译放慢，识别照常跑，准确率不受影响'
      : '注意：大教室模式下开省电，会关掉 Whisper，远距离准确率会明显下降', 6000);
    }
  });
  $('#setFar').addEventListener('change', () => {
    if ($('#setFar').checked) {
      $('#setKeepChunks').checked = true;
      $('#setAGC').checked = true;
      if (Number($('#setBoost').value) < 3) { $('#setBoost').value = 3; $('#boostVal').textContent = '3.0×'; }
      put();
      toast('已开启大教室模式：增强 + 分段保存 + 自动增益');
    }
  });
  $('#setLLM').addEventListener('change', async () => {
    if (!$('#setLLM').checked || $('#selLLM').dataset.filled) return;
    try {
      const { LLMWorker } = await import('./llm-client.js');
      const w = new LLMWorker({});
      const r = await w.available();
      w.terminate();
      $('#selLLM').innerHTML = r.models.map(m =>
        `<option value="${m.id}">${esc(m.label)} · ${m.sizeMB}MB · ${esc(m.quality || '')}${m.id === r.recommended ? '（推荐）' : ''}</option>`).join('');
      $('#selLLM').dataset.filled = '1';
      $('#selLLM').value = settings().llmModel || r.recommended;
      if (!r.info || !r.info.ok) toast('这台电脑可能跑不动本地小 AI：' + ((r.info && r.info.reason) || '未知'), 5000);
    } catch (e) { $('#selLLM').innerHTML = '<option value="">（本地 AI 模块不可用）</option>'; }
  });
  $('#btnManageTeachers').onclick = () => openManager('teachers', '老师');
  $('#btnManageCourses').onclick = () => openManager('courses', '学科');
  $('#btnPurgeChunks').onclick = () => purge('chunks');
  $('#btnPurgeAudio').onclick = () => purge('audio');
  $('#btnWipe').onclick = wipeAll;
  $('#setPreset').addEventListener('change', e => {
    const p = PRESETS[e.target.value];
    if (!p) return;
    $('#setProvider').value = p.provider; $('#setBase').value = p.baseUrl; $('#setModel').value = p.model;
    put(); renderDiag(); toast('已填入预设，记得填 API Key');
  });
  $('#btnBackup').onclick = async () => {
    const data = {
      version: 1, exportedAt: Date.now(),
      teachers: await db.all('teachers'), courses: await db.all('courses'),
      sessions: await db.all('sessions')
    };
    download(`VoiceCollector备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
    toast('已导出（不含录音文件）');
  };
  $('#btnRestore').onclick = () => $('#fileRestore').click();
  $('#fileRestore').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      for (const t of d.teachers || []) await db.put('teachers', t);
      for (const c of d.courses || []) await db.put('courses', c);
      for (const s of d.sessions || []) await db.put('sessions', s);
      await loadLists(); toast('导入完成');
    } catch (err) { toast('导入失败：' + err.message); }
    e.target.value = '';
  };
}

async function recoverUnfinished() {
  const broken = S.sessions.filter(s => !s.endedAt && s.segments && s.segments.length);
  for (const s of broken) {
    const last = s.segments[s.segments.length - 1];
    s.endedAt = s.startedAt + (last.t || 0);
    s.durationMs = last.t || 0;
    s.recovered = true;
    await db.put('sessions', s);
  }
  if (broken.length) {
    setTimeout(() => toast(`恢复了 ${broken.length} 节没有正常结束的课，去「资料库」里点「重新生成概要」`, 6000), 1200);
  }
}

/* ============================== 引擎与模型界面 ============================== */
async function renderEngineUI() {
  const st = settings();
  // 桌面版里「浏览器实时识别」和「双引擎」根本跑不起来（asr.js 顶部有原因），
  // 留在下拉框里只会让人选了之后奇怪为什么没反应，所以直接摘掉。
  if (IS_DESKTOP) {
    $$('#selEngine option').forEach(o => {
      if (o.value === 'webspeech' || o.value === 'hybrid') o.remove();
    });
    const autoOpt = $('#selEngine').querySelector('option[value="auto"]');
    if (autoOpt) autoOpt.textContent = '自动 — 本地 Whisper（推荐）';
  }
  $('#selEngine').value = st.engine || 'auto';
  if (!$('#selEngine').value) $('#selEngine').value = 'auto';   // 存档里是已摘掉的选项
  const eff = resolveEngine();
  const info = $('#engineInfo');
  const usesWhisper = eff === 'whisper' || eff === 'hybrid';
  $('#wModelField').style.display = usesWhisper ? '' : 'none';
  info.hidden = false;
  info.innerHTML = `实际使用：<b>${({ webspeech: '浏览器实时识别', whisper: '本地 Whisper', hybrid: '双引擎', cloud: '云端 Whisper' })[eff]}</b>　${esc(ENGINE_DESC[eff] || '')}`;

  if (!usesWhisper) return;
  const sel = $('#selWModel');
  if (!sel.dataset.filled) {
    try {
      const C = await mod('whisper-client');
      const w = new C.WhisperWorker({});
      const p = await w.probe();
      w.terminate();
      sel.innerHTML = p.models.map(m =>
        `<option value="${m.id}">${esc(m.label)} · ${m.sizeMB}MB · ${esc(m.quality || '')}${/base|small/.test(m.id) ? '（已内置）' : '（需联网下载）'}</option>`).join('');
      sel.dataset.filled = '1';
      sel.value = st.whisperModel || defaultModel(p);
      // ⚠️ 这里以前会 saveSettings({whisperModel: sel.value})。
      // 第一次打开 App 时 farMode 还是关的，于是 whisper-base 被写死进设置，
      // 之后 startRecording 里的 `st.whisperModel || LOCAL_DEFAULT` 永远走前半段，
      // 她再打开「大教室模式」也换不成 small —— 开了等于没开。
      // 所以不存：没存过就跟着 farMode 走，她自己在下拉框里选过才存（见 #selWModel.onchange）。
      info.innerHTML += `<br>加速方式：<b>${p.webgpu ? 'WebGPU（快、省电）' : 'CPU / WASM（慢一些，建议选小模型）'}</b>　识别跑在独立线程里，卡住也不会影响录音。`;
    } catch (e) {
      sel.innerHTML = '<option value="">（Whisper 模块未就绪）</option>';
      info.innerHTML += '<br>⚠️ 本地 Whisper 模块加载失败：' + esc(e.message);
    }
  }
}

async function prefetchModels() {
  const btn = $('#btnPrefetch');
  btn.disabled = true;
  const box = $('#dlMeterBox'), bar = $('#dlMeter');
  box.hidden = false;
  const setPct = p => bar.style.width = Math.max(2, Math.min(100, p)) + '%';
  try {
    const C = await mod('whisper-client');
    const st = settings();
    const probe = new C.WhisperWorker({});
    const p0 = await probe.probe().catch(() => null);
    probe.terminate();
    // 不用 p0.recommended：在 Apple 芯片上它会推荐 large-v3-turbo（没内置，要联网下 500MB+）
    const id = st.whisperModel || defaultModel(p0);
    toast('开始准备识别模型，第一次会久一点…', 5000);
    const w = new C.WhisperWorker({ model: id, language: String(st.srcLang || 'en').split('-')[0],
      onStatus: (s, d) => {
        if (s === 'downloading' && d) setPct(typeof d === 'number' ? d : (d.pct ?? d.progress ?? 0));
        $('#modelInfo').textContent = '识别模型：' + s;
      } });
    await w.preload(id, String(st.srcLang || 'en').split('-')[0]);
    w.terminate();
    setPct(100);
    toast('识别模型已就绪，以后断网也能用 ✓', 4000);
  } catch (e) {
    toast('下载失败：' + e.message, 5000);
  }
  try {
    const M = await mod('mt');
    const st = settings();
    const id = st.mtModel || (M.MT_MODELS && M.MT_MODELS[0] && M.MT_MODELS[0].id);
    if (id) {
      $('#modelInfo').textContent = '正在下载翻译模型…';
      const m = new M.LocalMT({ model: id, onProgress: p => setPct(typeof p === 'number' ? p : (p && (p.progress ?? p.percent)) || 0) });
      await m.load(); await m.close();
      toast('翻译模型也就绪了 ✓', 4000);
    }
  } catch (_) { /* 翻译模型可选 */ }
  box.hidden = true;
  btn.disabled = false;
  renderModelInfo();
}

async function renderModelInfo() {
  const el = $('#modelInfo');
  const bits = [];
  try {
    const C = await mod('whisper-client');
    const w = new C.WhisperWorker({});
    const p = await w.probe();
    w.terminate();
    bits.push(p.webgpu ? 'WebGPU 可用（快）' : 'WebGPU 不可用，将用 CPU');
  } catch (_) { bits.push('Whisper 模块未就绪'); }
  try {
    const ks = await caches.keys();
    const has = ks.some(k => /transformers|onnx|hf|model/i.test(k));
    bits.push(has ? '已缓存模型文件' : '尚未下载模型');
  } catch (_) {}
  el.textContent = bits.join(' · ') || '—';
}

async function clearModels() {
  if (!confirm('清除已下载的 AI 模型缓存？\n下次用到时需要重新下载（要联网）。')) return;
  try {
    const ks = await caches.keys();
    for (const k of ks) if (/transformers|onnx|hf|model/i.test(k)) await caches.delete(k);
    toast('模型缓存已清除');
  } catch (e) { toast('清除失败：' + e.message); }
  renderModelInfo();
}

/* ============================== 启动 ============================== */
async function init() {
  if (location.protocol === 'file:') { $('#fileWarn').hidden = false; return; }

  // 先把旧端口数据库里的东西收回来（桌面版以前每次启动端口都不一样，见 migrate-import.js）。
  // 必须在第一次 settings() 之前：settings() 有缓存，晚了采用的旧设置就不生效。
  // 出任何错都不能挡住 App 启动。
  if (IS_DESKTOP) {
    try {
      const M = await mod('migrate-import');
      const got = await M.importMigration();
      if (got && (got.sessions || got.teachers || got.courses)) {
        setTimeout(() => toast(`已找回以前的记录：${got.sessions} 节课、${got.teachers} 位老师、${got.courses} 门学科`, 6000), 800);
      }
    } catch (e) { console.warn('[迁移] 跳过：', e && e.message); }
  }

  // 以前设置页一打开就把 whisper-base 自动写进设置（bug，2026-09-24 修了），她并没有选过。
  // 不清掉的话，「默认改成 small」对已经装过的人不生效 —— 她那里存的就是这个 base。
  // 以后只有她在下拉框里亲手选过（whisperModelChosen）才算数。
  { const s0 = settings(); if (s0.whisperModel && !s0.whisperModelChosen) saveSettings({ whisperModel: '' }); }

  $('#selSrcLang').innerHTML = LANGS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  const st = settings();
  $('#selSrcLang').value = st.srcLang;
  $('#selDstLang').value = st.dstLang;

  // 以前第一次打开会自动塞一个「未命名老师 / 未命名学科」，因为那时不选就不让录。
  // 现在老师和学科都是可选的，不需要了 —— 而且以前每换一次端口就塞一对，她那里攒了 21 个。
  await loadLists();
  S.sessions = await db.sessionsSorted();
  await recoverUnfinished();

  // 麦克风列表（授权后才有名字）
  const refreshMics = async () => {
    const mics = await listMics();
    $('#selMic').innerHTML = `<option value="">系统默认</option>` +
      mics.map((d, i) => `<option value="${d.deviceId}">${esc(d.label || '麦克风 ' + (i + 1))}</option>`).join('');
    $('#selMic').value = settings().micId || '';
  };
  refreshMics();
  try { navigator.mediaDevices.addEventListener('devicechange', refreshMics); } catch (_) {}

  try {
  $$('.tab').forEach(b => b.onclick = () => go(b.dataset.go));
  $$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  // 藏起来的那一页：连点左上角图标 5 下（3 秒内）才出来。
  // 她不用一打开 App 就看见「专属」两个字有压力，但想看随时点得开。
  bindDedication();
  bindUpdater();
  // 录制中点红叉 / Cmd+Q，让主进程弹「继续录制 / 仍然退出」，而不是无声无息什么都不发生
  if (IS_DESKTOP && window.VCDesktop.onBeforeQuit) {
    window.VCDesktop.onBeforeQuit(() => S.cur
      ? '「' + (S.cur.title || '这节课') + '」正在录制中，现在退出会丢掉还没保存的录音。'
      : true);
  }
  $('#btnAddTeacher').onclick = () => addEntity('teachers', '老师');
  $('#btnAddCourse').onclick = () => addEntity('courses', '学科');
  $('#btnStart').onclick = () => startRecording().catch(e => toast('启动失败：' + e.message));
  $('#btnQuick').onclick = () => startRecording({ quick: true }).catch(e => toast('启动失败：' + e.message));
  $('#btnMicTest').onclick = micTest;
  $('#btnPause').onclick = togglePause;
  $('#btnMark').onclick = markPoint;
  $('#btnNote').onclick = addNote;
  $('#btnStop').onclick = () => { if (confirm('结束这节课并生成文档？')) stopRecording(); };
  $('#selSrcLang').onchange = e => { saveSettings({ srcLang: e.target.value }); renderDiag(); if (S.asr) S.asr.setLang(e.target.value); };
  $('#selDstLang').onchange = e => { saveSettings({ dstLang: e.target.value }); renderDiag(); };
  $('#selEngine').onchange = e => { saveSettings({ engine: e.target.value }); renderEngineUI(); };
  // 她自己在下拉框里选过才算数（whisperModelChosen），见 init 里的一次性清理
  $('#selWModel').onchange = e => saveSettings({ whisperModel: e.target.value, whisperModelChosen: true });
  $('#btnPrefetch').onclick = prefetchModels;
  $('#btnModelClear').onclick = clearModels;
  $('#libSearch').oninput = debounce(drawLibrary, 200);
  $('#libTeacher').onchange = drawLibrary;
  $('#libCourse').onchange = drawLibrary;
  $('#fullSearch').oninput = debounce(searchFull, 200);
  $$('.stab').forEach(b => b.onclick = () => showPane(b.dataset.pane));
  $('#exMd').onclick = () => saveAll('md', S.detail, S.detailCtx);
  $('#exTxt').onclick = () => saveAll('txt', S.detail, S.detailCtx);
  $('#exDoc').onclick = () => saveAll('doc', S.detail, S.detailCtx);
  $('#exSrt').onclick = () => saveAll('srt', S.detail, S.detailCtx);
  $('#exJson').onclick = () => saveAll('json', S.detail, S.detailCtx);
  $('#exPlain').onclick = () => saveAll('plain', S.detail, S.detailCtx);
  $('#exFullDoc').onclick = () => saveAll('fulldoc', S.detail, S.detailCtx);
  $('#btnAiPack').onclick = () => openAiPack('one').catch(e => toast(e.message));
  $('#btnAiPackAll').onclick = () => openAiPack('all').catch(e => toast(e.message));
  $('#exPrint').onclick = () => { $$('.pane').forEach(p => p.hidden = false); setTimeout(() => window.print(), 80); };
  $('#exAudio').onclick = async () => {
    const rec = await db.get('audio', S.detail.id);
    if (!rec) return toast('这节课没有录音');
    download(S.detail.title.replace(/[\\/:*?"<>|]/g, '_') + '.webm', rec.blob);
  };
  $('#myNotes').addEventListener('input', saveNotes);
  $('#btnTidyNotes').onclick = () => tidyNotes().catch(e => toast(e.message));
  $('#btnMergeNotes').onclick = () => makeStudyDoc().catch(e => toast(e.message));
  $('#btnRemake').onclick = () => makeStudyDoc().catch(e => toast(e.message));
  $('#btnImportNotes').onclick = () => $('#fileNotes').click();
  $('#fileNotes').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const txt = await f.text();
    const cur = $('#myNotes').value;
    $('#myNotes').value = cur ? cur + '\n\n' + txt : txt;
    saveNotes(); toast('已导入 ' + f.name);
    e.target.value = '';
  };
  $('#btnNewNote').onclick = newNotebook;
  $('#btnSemesterDoc').onclick = () => semesterDoc().catch(e => toast(e.message));
  $('#btnSemesterPack').onclick = () => semesterPack().catch(e => toast(e.message));
  $('#btnPickCloud').onclick = () => pickCloudFolder().catch(e => toast(e.message));
  $('#btnBackupNow').onclick = () => backupAllNow().catch(e => toast(e.message));
  $('#btnForgetCloud').onclick = async () => {
    saveSettings({ cloudDir: '' });
    try { const C = await mod('cloud'); await C.forget(); } catch (_) {}
    toast('已取消云盘备份'); renderCloudFolders(); renderCloudStatus();
  };
  $('#exPack').onclick = () => exportPack().catch(e => toast('导出失败：' + e.message));
  $('#btnImportPack').onclick = () => $('#filePack').click();
  $('#filePack').onchange = async (e) => {
    const fs = [...e.target.files];
    e.target.value = '';
    if (fs.length) await importPacks(fs).catch(err => toast('导入失败：' + err.message));
  };
  $('#btnReviewAll').onclick = () => reviewAll().catch(e => toast(e.message));
  $('#exStudyMd').onclick = () => S.detail && S.detail.studyDoc &&
    download(`复习文档_${S.detail.title}.md`.replace(/[\\/:*?"<>|]/g, '_'), S.detail.studyDoc, 'text/markdown;charset=utf-8');
  $('#exStudyDoc').onclick = () => S.detail && S.detail.studyDoc &&
    download(`复习文档_${S.detail.title}.doc`.replace(/[\\/:*?"<>|]/g, '_'),
      '\ufeff<html><head><meta charset="utf-8"></head><body style="font-family:PingFang SC,Microsoft YaHei;line-height:1.7">' +
      md2html(S.detail.studyDoc) + '</body></html>', 'application/msword;charset=utf-8');
  $('#exRvMd').onclick = () => S.review && download('总复习.md', S.review, 'text/markdown;charset=utf-8');
  $('#exRvDoc').onclick = () => S.review && download('总复习.doc',
      '\ufeff<html><head><meta charset="utf-8"></head><body style="font-family:PingFang SC,Microsoft YaHei;line-height:1.7">' +
      md2html(S.review) + '</body></html>', 'application/msword;charset=utf-8');
  $('#exRvPrint').onclick = () => window.print();
  $('#btnResum').onclick = regenSummary;
  $('#btnRetrans').onclick = retranslate;
  $('#btnRetransHQ').onclick = () => retranslateHQ().catch(e => toast(e.message));
  $('#btnTestMt').onclick = () => testMtQuality().catch(e => toast(e.message));
  $('#setMtEngine').onchange = e => saveSettings({ mtEngine: e.target.value });
  $('#setMtModel').onchange = e => saveSettings({ llmMtModel: e.target.value });
  $('#btnPerfect').onclick = () => perfectPass().catch(e => toast('精修失败：' + e.message));
  $('#btnRedoLocal').onclick = () => redoLocal().catch(e => toast('重新识别失败：' + e.message));
  $('#btnRetranscribe').onclick = () => retranscribe().catch(e => toast('转写失败：' + e.message));
  $('#btnRename').onclick = renameSession;
  $('#btnFillMeta').onclick = renameSession;
  $('#btnImportAudio').onclick = () => $('#fileAudio').click();
  $('#btnUploadHome').onclick = () => $('#fileAudio').click();
  bindDropImport();
  $('#fileAudio').onchange = e => { const fs = e.target.files; importAudioFiles(fs).catch(err => toast('导入失败：' + err.message)).finally(() => { e.target.value = ''; }); };
  $('#btnSumEdit').onclick = openSumEditor;
  if (IS_DESKTOP && window.VCDesktop.archive) {
    $('#selArchive').onchange = e => { saveSettings({ archiveDir: e.target.value }); renderArchiveBox(); };
    $('#btnArchiveOpen2').onclick = async () => { const A = await mod('archive'); window.VCDesktop.archive.open(await A.root(settings())); };
    $('#btnArchiveAll').onclick = async () => {
      const r = await archiveAll({ onlyMissing: false });
      if (r) toast(`存好了 ${r.ok} 节${r.bad ? `，${r.bad} 节没存上` : ''}`, 4000);
      renderArchiveBox();
    };
  }
  $('#btnSumCancel').onclick = closeSumEditor;
  $('#btnSumSave').onclick = () => saveSumEditor().catch(e => toast('保存失败：' + e.message));
  $('#notesQ').oninput = debounce(() => renderNotes(), 250);
  $('#notesCourse').onchange = () => renderNotes();
  $('#notesList').onclick = async e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const id = b.closest('.note-card').dataset.id;
    go('session', id);
    if (b.dataset.act === 'edit') {
      // 等这节课渲染完再打开编辑器（openSession 是异步的）
      for (let i = 0; i < 40 && !(S.detail && S.detail.id === id); i++) await new Promise(r => setTimeout(r, 50));
      openSumEditor();
    }
  };
  if (IS_DESKTOP && window.VCDesktop.archive) {
    $('#btnArchiveOpen').hidden = false;
    $('#btnArchiveOpen').onclick = async () => {
      const A = await mod('archive');
      window.VCDesktop.archive.open(await A.root(settings()));
    };
  }
  $('#btnDelete').onclick = deleteSession;
  } catch (e) {
    // 有元素没找到之类的问题，只报警不中断 —— 否则后面所有按钮都绑不上
    console.error('[VC] 绑定事件时出错：', e);
    toast('界面初始化有一处出错（' + e.message + '），大部分功能仍可用', 6000);
  }
  mod('coach').then(C => { COACH_EMPH = C.emphasisLevel; }).catch(e => console.warn('[VC] 强调上色不可用：', e.message));
  try { bindPlayerUI(); } catch (e) { console.error('[VC] 播放器绑定出错：', e); }
  try { bindSettings(); } catch (e) { console.error('[VC] 设置页绑定出错：', e); }
  renderDiag();
  renderEngineUI();
  renderModelInfo();
  go('record');

  // 主动清掉以前注册过的 Service Worker —— 它缓存旧代码会导致修复不生效。
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(rs => rs.forEach(r => r.unregister().catch(() => {})))
      .catch(() => {});
    caches.keys().then(ks => ks.forEach(k => { if (k.startsWith('vc-')) caches.delete(k); })).catch(() => {});
  }
  window.VC = { S, db, T, summarize, settings, _test: { addSegment, stopRecording, startRecording, perfectPass, importAudioFiles,
    setHQ: (e) => { hqMT = e; T.setHighQualityEngine(e); },
    get player() { return PL; }, segRange, shadowPractice } };   // 方便排查问题
}

init();
