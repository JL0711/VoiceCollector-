// VoiceCollector 桌面版 · 主进程
//
// 干的事情（按启动顺序）：
//   1. 单实例锁 —— 只允许开一个，第二次点图标就把已有窗口拉到前面
//   2. 在 127.0.0.1 上起一个本地 http 静态服务（端口自动挑空闲的），再 loadURL
//      —— 绝对不用 file://，理由见 lib/server.js 顶部注释
//   3. 放行麦克风权限（含 macOS 系统级 TCC 弹窗）
//   4. 装中文菜单（否则 mac 上 Cmd+C 会失效）
//   5. powerSaveBlocker：录制时不让系统休眠，停止时立刻放开（省电）
//   6. 关窗前如果页面说还在录制，二次确认
//
// 调试参数：
//   --smoke-test   启动后等 3 秒，把窗口标题/URL/隔离状态打到 stdout，然后自动退出
//   --dev          自动打开开发者工具

'use strict';

const {
  app, BrowserWindow, session, ipcMain, dialog, shell,
  powerSaveBlocker, systemPreferences, screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const { createStaticServer } = require('./lib/server');
const winState = require('./lib/window-state');
const { buildMenu } = require('./lib/menu');

const IS_MAC = process.platform === 'darwin';
const ARGV = process.argv.slice(1);
const SMOKE = ARGV.includes('--smoke-test');
const DEV = ARGV.includes('--dev');

let mainWindow = null;
let httpServer = null;      // createStaticServer 的返回值
// powerSaveBlocker 的 id。注意：第一个 blocker 的 id 就是 0，
// 所以不能拿 0 当「没开」的哨兵，必须用 -1。（这个坑是跑 --smoke-test 时踩出来的）
let sleepBlockerId = -1;
let allowClose = false;     // 二次确认通过之后置 true，避免死循环

// ───────────────────────── 找 web/ 目录 ─────────────────────────
// 开发时（desktop/ 旁边就是 web/）直接用 ../web，改了文件刷新就生效；
// 打包后 electron-builder 把 web/ 复制进了 desktop/app-web/（见 scripts/sync-web.js），
// 这时 __dirname 指向 app.asar 内部，fs 读 asar 是 Electron 打过补丁的，能正常读。
function resolveWebRoot() {
  const candidates = [
    { mode: 'dev', dir: path.join(__dirname, '..', 'web') },
    { mode: 'packed', dir: path.join(__dirname, 'app-web') },
    { mode: 'resources', dir: path.join(process.resourcesPath || '', 'web') }
  ];
  for (const c of candidates) {
    try {
      if (c.dir && fs.existsSync(path.join(c.dir, 'index.html'))) return c;
    } catch (_) { /* 忽略 */ }
  }
  return null;
}

// ───────────────────────── Chromium 开关 ─────────────────────────
// 放在 app ready 之前才生效
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // 回放录音不用先点一下
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');        // 配合 COOP/COEP，Whisper 多线程要用
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling'); // 别抢系统播放键

// 省电说明：这里故意【不】调 app.disableHardwareAcceleration()。
// GPU 加速对我们是净省电的 —— Whisper 走 WebGPU 比纯 CPU 快好几倍，
// 早算完早进空闲，整体耗电反而更低。

// ───────────────────────── 单实例 ─────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ───────────────────────── 权限 ─────────────────────────
function setupPermissions(ses) {
  // 允许的权限：麦克风/音频、剪贴板写、本地网络（我们自己的 127.0.0.1）
  // 注意：这些字符串必须是 Electron 真实的权限名（对着 electron.d.ts 的联合类型核过），
  // 写错的名字不会报错，只会永远匹配不上 —— 表现就是「某个功能莫名其妙用不了」。
  const ALLOW = new Set([
    'media',                    // getUserMedia（麦克风）
    'mediaKeySystem',
    'clipboard-sanitized-write',
    'local-network',            // Chromium 新版本会拦本地网络访问
    'loopback-network',
    'persistent-storage',       // IndexedDB 不被系统清掉
    'fullscreen',
    'notifications',
    'background-sync',
    'storage-access',
    'idle-detection',
    // web/js/mic.js 的 keepAwake() 会调 navigator.wakeLock.request('screen')，
    // 对应的权限名就是 screen-wake-lock。少了它不会报错（mic.js 自己 try/catch 了），
    // 但「设置 → 录制时不让屏幕睡」这个开关会变成一句空话。
    'screen-wake-lock',
    'system-wake-lock'
  ]);

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    let ok = ALLOW.has(permission);
    // Info.plist 里写了「不使用摄像头」，这里就真的一个摄像头请求都不放过。
    // details.mediaTypes 是 ['audio'] / ['video'] / 两个都有。
    if (ok && permission === 'media') {
      const types = (details && details.mediaTypes) || [];
      if (types.indexOf('video') >= 0) {
        console.log('[权限] 拒绝：media(video) —— 本 App 不用摄像头');
        ok = false;
      }
    }
    if (!ok) console.log('[权限] 拒绝：' + permission);
    callback(ok);
  });

  // 有些 Web API（比如 navigator.permissions.query、enumerateDevices 的 label）
  // 走的是同步的 check 而不是 request，两个都要实现才算完整。
  ses.setPermissionCheckHandler((wc, permission /*, origin, details */) => {
    return ALLOW.has(permission);
  });

  // 注意：这个 handler 只管 hid / serial / usb 三种设备，管不到麦克风。
  // 我们不需要任何外接设备，一律拒绝，免得被网页脚本探测硬件。
  ses.setDevicePermissionHandler(details => {
    console.log('[设备权限] 拒绝：' + details.deviceType);
    return false;
  });

  // 不设 CSP！Whisper 要从 huggingface.co / cdn.jsdelivr.net 下模型，
  // AI 总结要连 api.openai.com 之类，加了严格 CSP 会直接把这些掐死。
  // 页面来源是我们自己的 127.0.0.1 本地文件，没有第三方脚本注入面，风险可控。

  // 这里刻意不注册任何 webRequest 拦截器：
  // 模型下载（huggingface.co / cdn.jsdelivr.net）和 AI 接口请求必须畅通。
}

// ───────────────────────── 下载（导出文件）─────────────────────────
function setupDownloads(ses) {
  ses.on('will-download', (e, item) => {
    // 页面里 util.js 的 download() 用的是 <a download>，在 Electron 里会走下载流程。
    // 强制弹一个保存对话框，让晗晗自己选地方，而不是闷声存进「下载」文件夹。
    item.setSaveDialogOptions({
      title: '导出文件',
      defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
      buttonLabel: '保存'
    });
  });
}

// ───────────────────────── 窗口 ─────────────────────────
// 上次记下来的窗口位置，可能属于一块已经拔掉的外接屏。
// 直接拿去 new BrowserWindow 的话，窗口会开在看不见的地方，
// 用户看到的现象是「双击图标没反应 / App 打不开」。
// 只要标题栏没有任何一块落在当前的显示器里，就丢掉坐标改为居中。
function clampToVisibleDisplay(st) {
  if (typeof st.x !== 'number' || typeof st.y !== 'number') return st;
  try {
    const seen = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      const overlapX = st.x + st.width > a.x + 60 && st.x < a.x + a.width - 60;
      const overlapY = st.y + 40 > a.y && st.y < a.y + a.height - 40;
      return overlapX && overlapY;
    });
    if (seen) return st;
  } catch (_) {
    return st;   // 拿不到显示器信息就别自作聪明
  }
  console.log('[窗口] 上次的位置不在任何显示器里，改为居中');
  return Object.assign({}, st, { x: undefined, y: undefined });
}

function createWindow(indexUrl) {
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  const st = clampToVisibleDisplay(winState.readState(stateFile));

  mainWindow = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d14',
    title: 'VoiceCollector',
    // 用系统默认标题栏：网页顶部本来就有自己的 topbar，
    // 换成 hiddenInset 的话 mac 的红绿灯按钮会压在「VoiceCollector」标题上。
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,              // 省一点内存和 CPU
      backgroundThrottling: true,     // 默认允许后台降频；录制时再由 IPC 关掉
      additionalArguments: [
        '--vc-version=' + app.getVersion(),
        '--vc-platform=' + process.platform
      ]
    }
  });

  if (st.maximized) mainWindow.maximize();
  winState.track(mainWindow, stateFile);

  mainWindow.once('ready-to-show', () => {
    if (!SMOKE) mainWindow.show();
  });

  // 页面里的 target=_blank / window.open → 系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 拦住页面内的外部导航（防止整个 App 被导航走，回不来）
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (httpServer && url.startsWith(httpServer.origin)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // 页面一旦重新加载（Cmd+R、崩溃后重载、导航），渲染进程里的 JS 全没了，
  // 它再也不会调 setPreventSleep(false)。不在这里复位的话，
  // powerSaveBlocker 和「关掉后台降频」会一直挂着，电脑永远睡不着 —— 直接违背「能省电就省电」。
  // 页面重新起来后，app.js 开始录制时会自己再调一次 setPreventSleep(true)。
  mainWindow.webContents.on('did-start-loading', () => {
    if (sleepBlockerId >= 0) console.log('[省电] 页面重新加载，先把休眠阻断复位');
    setPreventSleep(false);
  });

  // 渲染进程崩了别留个白窗口
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    console.error('[渲染进程退出]', details.reason);
    setPreventSleep(false);   // 崩溃时同样要放开，不然机器一直醒着
    if (!SMOKE) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '界面崩溃了',
        message: '界面进程意外退出（' + details.reason + '）',
        detail: '点「重新加载」通常就能恢复，录制中的内容已经存在本地数据库里。',
        buttons: ['重新加载', '关闭']
      }).then(r => {
        if (r.response === 0 && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      });
    }
  });

  // 关窗前问页面：还在录制吗？
  mainWindow.on('close', e => {
    if (allowClose || SMOKE) return;
    e.preventDefault();
    askRendererBeforeQuit().then(verdict => {
      if (verdict.allow) {
        allowClose = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
        return;
      }
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '还在录制',
        message: verdict.reason || '课堂还在录制中，现在退出会中断本节课的记录。',
        detail: '建议先点「停止」把这节课存好，再退出。',
        buttons: ['继续录制', '仍然退出'],
        defaultId: 0,
        cancelId: 0
      }).then(r => {
        if (r.response === 1) {
          allowClose = true;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
        }
      });
    });
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadURL(indexUrl);
  if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  return mainWindow;
}

// ───────────────────────── 退出前问页面 ─────────────────────────
let quitQueryId = 0;
const quitWaiters = new Map();

ipcMain.on('vc:before-quit-reply', (e, id, result) => {
  const w = quitWaiters.get(id);
  if (!w) return;
  quitWaiters.delete(id);
  w(normalizeVerdict(result));
});

// 页面回给我们的东西可能是 true / false / 一句话，统一成 {allow, reason}
function normalizeVerdict(r) {
  if (r === true || r === undefined || r === null) return { allow: true, reason: '' };
  if (r === false) return { allow: false, reason: '课堂还在录制中，现在退出会中断本节课的记录。' };
  if (typeof r === 'string') return { allow: false, reason: r };
  if (typeof r === 'object') {
    if (r.allow === true) return { allow: true, reason: '' };
    return { allow: false, reason: String(r.reason || '课堂还在录制中。') };
  }
  return { allow: true, reason: '' };
}

function askRendererBeforeQuit() {
  return new Promise(resolve => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
      return resolve({ allow: true, reason: '' });
    }
    const id = ++quitQueryId;
    let done = false;
    const finish = v => { if (!done) { done = true; quitWaiters.delete(id); resolve(v); } };
    quitWaiters.set(id, finish);
    // 页面没注册回调、或者卡住了，1.5 秒后按“可以退出”处理，别让 App 关不掉
    setTimeout(() => finish({ allow: true, reason: '' }), 1500);
    try {
      mainWindow.webContents.send('vc:before-quit-query', id);
    } catch (_) {
      finish({ allow: true, reason: '' });
    }
  });
}

// ───────────────────────── 省电：休眠阻断 ─────────────────────────
function setPreventSleep(on) {
  if (on) {
    if (sleepBlockerId < 0) {
      // 用 prevent-app-suspension 而不是 prevent-display-sleep：
      // 只要系统别睡就行，屏幕该关还是关，这样录 90 分钟的课省一大截电。
      sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      console.log('[省电] 录制中，阻止系统休眠 id=' + sleepBlockerId);
    }
    // 录制时窗口可能被切到后台，这时必须关掉后台降频，
    // 否则计时器被节流，分段录音和时间轴会飘。
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setBackgroundThrottling(false);
  } else {
    if (sleepBlockerId >= 0) {
      try { powerSaveBlocker.stop(sleepBlockerId); } catch (_) {}
      console.log('[省电] 停止录制，恢复系统休眠');
      sleepBlockerId = -1;
    }
    // 不录制了就让 Chromium 正常降频，空闲时几乎不吃 CPU
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setBackgroundThrottling(true);
  }
  return sleepBlockerId >= 0 && powerSaveBlocker.isStarted(sleepBlockerId);
}

// ───────────────────────── IPC ─────────────────────────
function setupIpc() {
  ipcMain.handle('vc:info', () => ({
    isDesktop: true,
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    packaged: app.isPackaged,
    origin: httpServer ? httpServer.origin : '',
    port: httpServer ? httpServer.port : 0,
    webRoot: httpServer ? httpServer.root : '',
    userData: app.getPath('userData')
  }));

  ipcMain.handle('vc:prevent-sleep', (e, on) => setPreventSleep(!!on));

  ipcMain.handle('vc:open-external', (e, target) => {
    const u = String(target || '');
    if (!/^https?:\/\//i.test(u)) return false;   // 只放行 http/https，挡住 file:// 之类
    shell.openExternal(u);
    return true;
  });

  // 导出文件：页面把文件名 + MIME + 内容丢过来，主进程弹保存框并写盘
  ipcMain.handle('vc:save-file', async (e, payload) => {
    const p = payload || {};
    const name = safeFileName(p.name);
    const mime = String(p.mime || '');
    const filters = filtersFor(name, mime);
    const win = BrowserWindow.fromWebContents(e.sender) || mainWindow || undefined;
    const r = await dialog.showSaveDialog(win, {
      title: '导出文件',
      defaultPath: path.join(app.getPath('downloads'), name),
      buttonLabel: '保存',
      filters: filters
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true, path: '' };
    if (p.data === undefined || p.data === null) {
      // 只要路径、内容页面自己处理的情况
      return { ok: true, canceled: false, path: r.filePath, written: false };
    }
    try {
      const buf = toBuffer(p.data);
      await fs.promises.writeFile(r.filePath, buf);
      return { ok: true, canceled: false, path: r.filePath, written: true, bytes: buf.length };
    } catch (err) {
      return { ok: false, canceled: false, path: r.filePath, error: String(err && err.message || err) };
    }
  });

  // 保存完之后在访达里显示（可选，页面不调也没关系）
  // 探测常见云盘文件夹，给「自动备份到云盘」用。
  // 只返回真实存在的路径，前端据此显示「检测到你的 Google Drive」这样的按钮。
  ipcMain.handle('vc:cloud-folders', () => {
    const home = app.getPath('home');
    const out = [];
    const add = (label, dir, kind) => {
      try { if (fs.existsSync(dir)) out.push({ label, dir, kind }); } catch (_) {}
    };
    // Google Drive：新版挂在 CloudStorage 下，名字带邮箱，要扫一遍
    try {
      const cs = path.join(home, 'Library', 'CloudStorage');
      if (fs.existsSync(cs)) {
        for (const name of fs.readdirSync(cs)) {
          const full = path.join(cs, name);
          if (/^GoogleDrive-/i.test(name)) {
            const my = path.join(full, 'My Drive');
            add('Google Drive（' + name.replace(/^GoogleDrive-/i, '') + '）', fs.existsSync(my) ? my : full, 'gdrive');
          } else if (/^OneDrive/i.test(name)) {
            add('OneDrive', full, 'onedrive');
          } else if (/^Dropbox/i.test(name)) {
            add('Dropbox', full, 'dropbox');
          }
        }
      }
    } catch (_) {}
    add('Google Drive（旧版路径）', path.join(home, 'Google Drive', 'My Drive'), 'gdrive');
    add('iCloud 云盘', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), 'icloud');
    add('Dropbox', path.join(home, 'Dropbox'), 'dropbox');
    add('坚果云', path.join(home, 'Nutstore Files'), 'nutstore');
    // 去重（同一个 dir 可能被加两次）
    const seen = new Set();
    return out.filter(x => (seen.has(x.dir) ? false : (seen.add(x.dir), true)));
  });

  // 直接把课程包写进指定文件夹（桌面版走原生 fs，不用 File System Access 的权限流程）
  ipcMain.handle('vc:write-backup', async (e, payload) => {
    try {
      const dir = String((payload && payload.dir) || '');
      const name = String((payload && payload.name) || '').replace(/[\\/]/g, '_');
      const data = payload && payload.data;
      if (!dir || !name || !data) return { ok: false, error: '参数不全' };
      const target = path.join(dir, 'VoiceCollector');
      await fsp.mkdir(target, { recursive: true });
      const file = path.join(target, name);
      await fsp.writeFile(file, Buffer.from(data));
      return { ok: true, path: file, size: (await fsp.stat(file)).size };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('vc:show-in-folder', (e, p) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(p);
    return true;
  });
}

// 导出的文件名是页面拼出来的（课程名 + 老师名 + 标题），
// 课程名里完全可能出现 '/'（比如「微观经济学/宏观经济学」）。
// 直接 path.join(下载目录, name) 会变成一个不存在的子目录，保存框一打开就报错；
// '..' 更是能把默认路径指到下载目录外面去。这里统一洗一遍。
function safeFileName(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/[\x00-\x1f]/g, '');          // 控制字符
  s = s.replace(/[\/\\]/g, '_');              // 路径分隔符（两个平台都挡）
  s = s.replace(/[:*?"<>|]/g, '_');           // Windows 不允许的字符
  s = s.replace(/^\.+/, '');                  // 开头的点：'..' 和隐藏文件
  s = s.trim();
  if (!s) s = 'VoiceCollector-导出.txt';
  // macOS / Windows 的单个文件名上限是 255 字节，留点余量，按字节裁，
  // 但扩展名要留着（不然保存框认不出类型）
  if (Buffer.byteLength(s, 'utf8') > 200) {
    const ext = path.extname(s).slice(0, 16);
    let base = s.slice(0, s.length - path.extname(s).length);
    while (Buffer.byteLength(base + ext, 'utf8') > 200 && base.length > 1) base = base.slice(0, -1);
    s = base + ext;
  }
  return s;
}

function toBuffer(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (Array.isArray(data)) return Buffer.from(Uint8Array.from(data));
  return Buffer.from(String(data), 'utf8');
}

function filtersFor(name, mime) {
  const ext = (path.extname(name) || '').replace('.', '').toLowerCase();
  const table = {
    md: ['Markdown 文档', 'md'],
    txt: ['纯文本', 'txt'],
    html: ['网页', 'html'],
    json: ['JSON 数据', 'json'],
    csv: ['表格 CSV', 'csv'],
    docx: ['Word 文档', 'docx'],
    pdf: ['PDF 文档', 'pdf'],
    webm: ['音频 WebM', 'webm'],
    mp3: ['音频 MP3', 'mp3'],
    wav: ['音频 WAV', 'wav'],
    m4a: ['音频 M4A', 'm4a'],
    zip: ['压缩包', 'zip']
  };
  const hit = table[ext];
  const out = [];
  if (hit) out.push({ name: hit[0], extensions: [hit[1]] });
  else if (mime) out.push({ name: mime, extensions: [ext || '*'] });
  out.push({ name: '所有文件', extensions: ['*'] });
  return out;
}

// ───────────────────────── 冒烟测试 ─────────────────────────
// 无头/CI 环境下用：`npx electron . --smoke-test`
function runSmokeTest(win, web) {
  const out = res => {
    console.log('===VC_SMOKE_BEGIN===');
    console.log(JSON.stringify(res, null, 2));
    console.log('===VC_SMOKE_END===');
    setTimeout(() => app.exit(res.ok ? 0 : 1), 100);
  };

  const hardTimeout = setTimeout(() => {
    out({ ok: false, error: '30 秒内页面没有加载完成', webRoot: web.dir, mode: web.mode });
  }, 30000);

  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    clearTimeout(hardTimeout);
    out({ ok: false, error: '加载失败 ' + code + ' ' + desc, url: url });
  });

  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      clearTimeout(hardTimeout);
      try {
        const probe = await win.webContents.executeJavaScript(`(async () => {
          // 顺便把 IPC 通路也走一遍：省电开关、主进程信息、退出回调注册
          const D = window.VCDesktop || {};
          let sleepOn = null, sleepOff = null, info = null, unhook = null, ipcError = '';
          try {
            sleepOn = await D.setPreventSleep(true);
            sleepOff = await D.setPreventSleep(false);
            info = await D.info();
            unhook = typeof D.onBeforeQuit(() => true) === 'function';
          } catch (err) { ipcError = String(err && err.message || err); }

          // 真的去开一次麦克风。
          // 只验「navigator.mediaDevices 存在」是不够的：权限 handler 写错名字、
          // 系统 TCC 没给、Info.plist 少了 NSMicrophoneUsageDescription，
          // 表现都是 getUserMedia 直接 reject 或者拿到一条静音轨，
          // 而这正是这个 App 唯一不能坏的功能。
          const mic = { ok: false, error: '', label: '', sampleRate: 0, channelCount: 0, live: false, devices: 0 };
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const track = stream.getAudioTracks()[0];
            if (track) {
              const s = track.getSettings ? track.getSettings() : {};
              mic.ok = true;
              mic.label = track.label || '(无标签)';
              mic.live = track.readyState === 'live';
              mic.sampleRate = s.sampleRate || 0;
              mic.channelCount = s.channelCount || 0;
            }
            stream.getTracks().forEach(t => t.stop());
            // 拿到权限之后 enumerateDevices 才会带设备名（大教室里要选外接麦克风）
            const list = await navigator.mediaDevices.enumerateDevices();
            mic.devices = list.filter(d => d.kind === 'audioinput').length;
          } catch (err) {
            mic.error = String(err && (err.name + ': ' + err.message) || err);
          }

          return {
          mic: mic,
          title: document.title,
          url: location.href,
          crossOriginIsolated: !!self.crossOriginIsolated,
          hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
          hasVCDesktop: !!window.VCDesktop,
          vcDesktopKeys: window.VCDesktop ? Object.keys(window.VCDesktop) : [],
          hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
          moduleLoaded: !!document.querySelector('script[type=module]'),
          domReady: !!document.querySelector('#view-record'),
          bodyLen: document.body ? document.body.innerHTML.length : 0,
          ipc: { sleepOn: sleepOn, sleepOff: sleepOff, unhookIsFunction: unhook, error: ipcError },
          mainInfo: info
        };
        })()`, true);
        out({
          ok: probe.title.indexOf('VoiceCollector') >= 0
            && probe.url.indexOf('127.0.0.1') >= 0
            && probe.hasVCDesktop
            && probe.domReady
            && !probe.ipc.error
            && probe.ipc.sleepOn === true
            && probe.ipc.sleepOff === false,
          mode: web.mode,
          webRoot: web.dir,
          serverOrigin: httpServer ? httpServer.origin : '',
          probe: probe
        });
      } catch (err) {
        out({ ok: false, error: String(err && err.message || err) });
      }
    }, 3000);
  });
}

// ───────────────────────── 启动 ─────────────────────────
async function boot() {
  const web = resolveWebRoot();
  if (!web) {
    const msg = '找不到 web/ 目录。开发时请保证 desktop/ 与 web/ 是同级目录；打包前先跑 npm run sync。';
    console.error('[致命] ' + msg);
    if (SMOKE) {
      console.log('===VC_SMOKE_BEGIN===');
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
      console.log('===VC_SMOKE_END===');
      return app.exit(1);
    }
    dialog.showErrorBox('启动失败', msg);
    return app.quit();
  }
  console.log('[web 目录] ' + web.mode + ' → ' + web.dir);

  httpServer = await createStaticServer(web.dir, {
    coi: process.env.VC_NO_COI !== '1',
    keepServiceWorker: process.env.VC_KEEP_SW === '1'
  });
  console.log('[本地服务] ' + httpServer.indexUrl);

  const ses = session.defaultSession;
  setupPermissions(ses);
  setupDownloads(ses);
  setupIpc();
  buildMenu({ appVersion: app.getVersion() });

  const win = createWindow(httpServer.indexUrl);

  // macOS 的系统级麦克风授权（TCC）。不调这个，getUserMedia 会直接被系统拒，
  // 而且不会弹窗，表现就是「音量表一直是 0」。
  // 故意【不 await】：这个系统弹窗要等用户点，先 await 再建窗口的话，
  // 用户在没看到任何界面的情况下被问权限，不点就一直是一个空 Dock 图标。
  if (IS_MAC) {
    systemPreferences.askForMediaAccess('microphone')
      .then(ok => console.log('[麦克风] 系统授权：' + (ok ? '已允许' : '被拒绝')))
      .catch(err => console.log('[麦克风] 系统授权请求失败：' + err));
  }

  if (SMOKE) runSmokeTest(win, web);
}

if (gotLock) {
  app.whenReady().then(boot).catch(err => {
    console.error('[启动异常]', err);
    if (SMOKE) {
      console.log('===VC_SMOKE_BEGIN===');
      console.log(JSON.stringify({ ok: false, error: String(err && err.stack || err) }, null, 2));
      console.log('===VC_SMOKE_END===');
    }
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  // 所有平台都退出：留个后台进程在 Dock 里空耗电没意义（需求 3：能省电就省电）
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && httpServer) {
    createWindow(httpServer.indexUrl);
  }
});

app.on('will-quit', () => {
  if (sleepBlockerId >= 0) {
    try { powerSaveBlocker.stop(sleepBlockerId); } catch (_) {}
    sleepBlockerId = -1;
  }
  if (httpServer) {
    try { httpServer.close(); } catch (_) {}
    httpServer = null;
  }
});
