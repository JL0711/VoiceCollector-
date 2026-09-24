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
  app, BrowserWindow, session, ipcMain, dialog, shell, net,
  powerSaveBlocker, systemPreferences, screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const { createStaticServer, resolveSafe, MIME } = require('./lib/server');
const updater = require('./lib/updater');
const winState = require('./lib/window-state');
const { buildMenu } = require('./lib/menu');

const IS_MAC = process.platform === 'darwin';
const ARGV = process.argv.slice(1);
const SMOKE = ARGV.includes('--smoke-test');
const DEV = ARGV.includes('--dev');

let mainWindow = null;
let httpServer = null;      // createStaticServer 的返回值
let overlayInfo = null;     // 当前生效的网页层更新（null = 用 App 内置的那份）
let lastUpdateInfo = null;  // 最近一次 check 的结果，装的时候要用
let allowCloseForUpdate = false;
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

let mainWindowCreated = false;
function createWindow(indexUrl) {
  mainWindowCreated = true;
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
    if (allowClose || allowCloseForUpdate || SMOKE) return;
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
    userData: app.getPath('userData'),
    // 给冒烟测试用：录制中必须为 true，否则她切到别的窗口时 Mac 会睡、整段录音停掉
    preventSleep: sleepBlockerId >= 0
  }));

  ipcMain.handle('vc:prevent-sleep', (e, on) => setPreventSleep(!!on));

  // ── 旧端口数据迁移 ──
  ipcMain.handle('vc:migration-take', async () => {
    // 迁移可能还在后台跑，等它一会儿；超过 25 秒就不等了，这次先正常启动，下次再合并
    if (migrationPromise) {
      try { await withTimeout(migrationPromise, 25000, '迁移'); } catch (_) {}
    }
    const m = pendingMigration;
    return m ? { dumps: m.dumps } : null;
  });
  ipcMain.handle('vc:migration-done', (e, ok) => {
    if (ok && pendingMigration) {
      writeMigrated([...new Set([...readMigrated(), ...pendingMigration.ports])]);
      console.log('[迁移] 界面已合并，记账：' + pendingMigration.ports.join(', '));
    }
    pendingMigration = null;
    return true;
  });

  // ── 更新（只换网页层，见 lib/updater.js 顶部） ──
  // 更新源：GitHub Releases。仓库是公开的，任何装了这个 App 的人都能收到更新提示，
  // 不需要登录、不需要 Key。
  const UPD = { owner: 'MartinMax0711', repo: 'VoiceCollector-' };
  const bundledVersion = () => {
    const m = httpServer ? updater.readManifest(httpServer.root) : null;
    return (m && m.version) || '0.0.0';
  };
  const currentVersion = () => (overlayInfo && overlayInfo.version) || bundledVersion();

  ipcMain.handle('vc:update-state', () => ({
    current: currentVersion(),
    bundled: bundledVersion(),
    shell: app.getVersion(),
    usingUpdate: !!overlayInfo
  }));

  ipcMain.handle('vc:update-check', async () => {
    try {
      const r = await updater.check({ ...UPD, currentVersion: currentVersion(), shellVersion: app.getVersion() });
      lastUpdateInfo = r.available ? r : null;
      return r;
    } catch (e) {
      return { available: false, error: true, reason: '现在连不上更新服务器，不影响使用，有网的时候再点一次（' + e.message + '）' };
    }
  });

  ipcMain.handle('vc:update-install', async (e) => {
    if (!lastUpdateInfo || lastUpdateInfo.full) return { ok: false, reason: '没有可以直接安装的更新' };
    try {
      const r = await updater.install(lastUpdateInfo, app.getPath('userData'), p => {
        try { e.sender.send('vc:update-progress', p); } catch (_) {}
      });
      lastUpdateInfo = null;
      return r;
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  // 重启生效。网页层换了，本地服务的 overlay 目录也要跟着换，最稳的办法就是整个重启。
  ipcMain.handle('vc:update-relaunch', () => {
    setPreventSleep(false);
    allowCloseForUpdate = true;
    app.relaunch();
    app.exit(0);
  });

  // 出问题时的出口：丢掉所有更新层，退回 App 内置的版本
  ipcMain.handle('vc:update-revert', () => {
    updater.revert(app.getPath('userData'));
    allowCloseForUpdate = true;
    app.relaunch();
    app.exit(0);
  });

  // 界面 init() 跑完才调 —— 证明这个网页层能正常起来，撤掉 .pending
  ipcMain.handle('vc:boot-ok', () => {
    if (overlayInfo) {
      const ok = updater.confirmBoot(overlayInfo.dir);
      if (ok) console.log('[更新] ' + overlayInfo.version + ' 启动成功，确认保留');
    }
    return true;
  });

  // 只允许打开本仓库的 Release 页，别让页面借这个口子打开任意链接
  ipcMain.handle('vc:open-release', (e, url) => {
    const ok = typeof url === 'string'
      && url.indexOf('https://github.com/' + UPD.owner + '/' + UPD.repo + '/') === 0;
    if (ok) shell.openExternal(url);
    return ok;
  });

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
            // 没有「My Drive」= Google Drive 桌面版没在同步这个账号（没登录或已退出）。
            // 写进去的文件不会上传，所以不能当成可用的云盘给她选。
            const my = path.join(full, 'My Drive');
            const acct = name.replace(/^GoogleDrive-/i, '');
            if (fs.existsSync(my)) add('Google Drive（' + acct + '）', my, 'gdrive');
            else out.push({ label: 'Google Drive（' + acct + '）— 未在同步，请先打开 Google Drive 登录', dir: '', kind: 'gdrive', stale: true });
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
    return out.filter(x => (!x.dir || seen.has(x.dir) ? !x.dir : (seen.add(x.dir), true)));
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

  // ── 录音留档：每节课一个文件夹，通用格式，放在 App 外面 ──
  // 为什么要这个：以前「自动备份」开着但备份位置从来是空的，一次都没备份过 ——
  // 所有录音只存在 App 自己的数据库里，App 数据一坏就全没了。
  // 存档用的全是通用格式（录音文件 / Markdown / 课程包），以后就算不用这个 App 也打得开。
  const defaultArchiveRoot = () => {
    const home = app.getPath('home');
    const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    // iCloud 云盘优先：macOS 自带、自动同步到云端、换电脑/手机也在
    if (process.env.VC_ARCHIVE_ROOT) return process.env.VC_ARCHIVE_ROOT;
    // ⚠️ 冒烟测试 / 演练绝不能写进她的 iCloud —— 一晚上跑几十次就是几十个测试文件夹
    if (SMOKE) return path.join(app.getPath('userData'), 'archive-test');
    if (fs.existsSync(icloud)) return path.join(icloud, 'VoiceCollector 存档');
    return path.join(app.getPath('documents'), 'VoiceCollector 存档');
  };
  ipcMain.handle('vc:archive-default', () => defaultArchiveRoot());

  ipcMain.handle('vc:archive-write', async (e, payload) => {
    try {
      const root = String((payload && payload.root) || defaultArchiveRoot());
      const rel = String((payload && payload.rel) || '');
      const data = payload && payload.data;
      if (!rel || data == null) return { ok: false, error: '参数不全' };
      // 只允许写在存档根目录里面，防止 ../ 之类跑出去
      const target = path.resolve(root, rel);
      if (!target.startsWith(path.resolve(root) + path.sep)) return { ok: false, error: '非法路径' };
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      // 先写临时文件再改名：写到一半断电/同步中途，不会留下一个坏文件
      const tmp = target + '.part';
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, target);
      return { ok: true, path: target, size: buf.length };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), code: err && err.code };
    }
  });

  ipcMain.handle('vc:archive-open', async (e, dir) => {
    const d = String(dir || defaultArchiveRoot());
    try { await fsp.mkdir(d, { recursive: true }); } catch (_) {}
    return shell.openPath(d);
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
  // 总看门狗：不管卡在哪一步，120 秒还没出结果就判失败。
  // 「网络卡死」这类问题的表现恰恰就是永远不结束，没有这个的话测试会一直挂着。
  const watchdog = setTimeout(() => {
    console.log('===VC_SMOKE_BEGIN===');
    console.log(JSON.stringify({ ok: false, error: '120 秒没跑完 —— 卡死了', hung: true,
      net: { mode: process.env.VC_NET || 'normal', external: externalRequests.slice() } }, null, 2));
    console.log('===VC_SMOKE_END===');
    app.exit(1);
  }, 120000);
  const out = res => {
    clearTimeout(watchdog);
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

        // ── 真的点一次「开始录制」 ──
        // 只验「页面渲染出来了」是不够的。app.js 里任何一个运行时错误（少写一个
        // 常量、改名忘了改引用）都只有在真正走 startRecording 的时候才炸，
        // 而那正是她在教室里唯一会做的事。14:27 那一版就是这么发出去的：
        // 界面完全正常，一点「开始录制」直接 "FRAG is not defined"。
        const rec = await win.webContents.executeJavaScript(`(async () => {
          const r = { ok:false, error:'', addedTeacher:false, addedCourse:false,
                      started:false, stopped:false, engine:'', segs:0, sessionId:'' };
          // window.VC 是 init() 最后才赋值的。init 里现在要先等旧数据迁移，
          // 所以不能「页面加载完 3 秒」就认定它该有了 —— 等最多 60 秒。
          for (let i = 0; i < 300 && !(window.VC && window.VC._test); i++) await new Promise(res => setTimeout(res, 200));
          const VC = window.VC;
          if (!VC || !VC._test || !VC._test.startRecording) {
            r.error = 'window.VC._test 不存在 —— init() 很可能已经抛异常了';
            return r;
          }
          const q = s => document.querySelector(s);
          const sleep = ms => new Promise(res => setTimeout(res, ms));
          const toastText = () => { const t = q('#toast'); return (t && !t.hidden && t.textContent) || ''; };
          // 等条件成立，最多 ms 毫秒
          const until = async (fn, ms) => {
            const end = Date.now() + ms;
            while (Date.now() < end) { if (fn()) return true; await sleep(120); }
            return false;
          };
          // 走真正的「＋ 新增」对话框，不是往 select 里塞 option ——
          // 她明早第一件事就是点这两个 ＋，这条路也不能坏。
          const addVia = async (btnSel, selSel, name) => {
            const btn = q(btnSel); if (!btn) throw new Error('缺少 ' + btnSel);
            btn.click();
            if (!await until(() => q('#dlg') && q('#dlg').open && q('#dlgBody input'), 4000))
              throw new Error(btnSel + ' 没有弹出新增对话框');
            const inp = q('#dlgBody input');
            inp.value = name;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            q('#dlgOk').click();
            if (!await until(() => { const el = q(selSel); return el && el.value && el.selectedOptions[0] && el.selectedOptions[0].textContent === name; }, 4000))
              throw new Error(btnSel + ' 新增后 ' + selSel + ' 没有选中新条目');
            return true;
          };
          // 更新：当前用的是哪个版本（演练「更新」「坏更新自动退回」要看这个）
          try { r.updState = await window.VCDesktop.update.state(); } catch (e) { r.updState = { error: e.message }; }
          if (${JSON.stringify(process.env.VC_SMOKE_UPDATE || '')} === 'install') {
            try {
              r.updCheck = await window.VCDesktop.update.check();
              r.updInstall = r.updCheck && r.updCheck.available ? await window.VCDesktop.update.install() : null;
            } catch (e) { r.updInstall = { ok: false, reason: e.message }; }
          }
          // 数据库里现在有什么（迁移之后用来核对）
          try {
            r.counts = {
              teachers: (await VC.db.all('teachers')).map(x => x.name),
              courses:  (await VC.db.all('courses')).map(x => x.name),
              sessions: (await VC.db.all('sessions')).length,
              titles: (await VC.db.all('sessions')).map(x => x.title),
              port: location.port
            };
          } catch (_) {}
          try {
            const FLOW = ${JSON.stringify(process.env.VC_SMOKE_FLOW || 'full')};
            r.flow = FLOW;
            const WITH_ZH = ${JSON.stringify(process.env.VC_SMOKE_TRANSLATE === '1')};
            if (q('#selDstLang')) q('#selDstLang').value = WITH_ZH ? 'zh-Hans' : 'off';
            if (FLOW === 'quick') {
              // ⚡ 立即开始：什么都不填，一键开录
              r.addedTeacher = r.addedCourse = true;   // 这个流程不需要
              q('#btnQuick').click();
            } else {
              r.addedTeacher = await addVia('#btnAddTeacher', '#selTeacher', '冒烟测试老师');
              r.addedCourse  = await addVia('#btnAddCourse',  '#selCourse',  '冒烟测试学科');
              if (q('#inpTitle')) q('#inpTitle').value = '冒烟测试';
              // ── 真的点一次「开始录制」 ──
              // 注意 #btnStart 的 onclick 里有 .catch(e => toast(...))，异常不会冒出来，
              // 所以失败要从 S.cur 和 toast 文案上判断 —— 她看到的也正是那行 toast。
              q('#btnStart').click();
            }
            // ⚠️ 只等 S.cur 是不够的：startRecording 里 S.cur 赋值得很早，
            // 后面还有 await（写 IndexedDB、准备翻译引擎），这时候界面还没切过去。
            // 必须等到录制卡片真的显示出来，否则探针会和 startRecording 赛跑。
            const up = await until(() => (VC.S && VC.S.cur && q('#liveCard') && !q('#liveCard').hidden
                                          && q('#statusPill') && /录音中|识别模型/.test(q('#statusPill').textContent))
                                        || /失败|无法|请先/.test(toastText()), 30000);
            await sleep(300);
            if (VC.S && VC.S.cur) r.started = true;
            if (!r.started) { r.error = toastText() || (up ? '开始录制失败' : '点了开始录制，30 秒内没反应'); return r; }

            r.sessionId = VC.S.cur.id;
            r.engine = VC.S.cur.engine || '';
            r.wmodel = VC.S.cur.wmodel || '';
            if (FLOW === 'quick') {
              r.quickNoMeta = !VC.S.cur.teacherId && !VC.S.cur.courseId;
              r.quickTitle = VC.S.cur.title;
            }

            // 纯 Whisper 要 25 秒才出第一段字，这期间必须有「正在听」的提示，
            // 否则她看到的就是一片空白 + 0 段 0 词，会以为没录上。
            r.waitingShown = !!q('#liveTranscript .waiting');

            // 顺手把落段这条链路走通：Electron 里没有 Web Speech，
            // 不直接喂它的话这段代码在桌面版永远测不到。
            VC._test.addSegment({ text: 'The Supreme Court decided this case in nineteen sixty four.', kind: 'speech', t: 0 });
            await sleep(200);
            if (WITH_ZH) {
              // 实时翻译要在 40 秒内出中文（本地 opus-mt，第一次要加载模型）
              await until(() => (VC.S.cur && VC.S.cur.segments || []).some(x => x.zh && /[\u4e00-\u9fff]/.test(x.zh)), 40000);
              const sg = (VC.S.cur && VC.S.cur.segments || []).find(x => x.kind === 'speech');
              r.zh = sg ? (sg.zh || '') : '';
            }
            r.waitingCleared = !q('#liveTranscript .waiting');   // 出字之后提示要撤掉
            await until(() => (VC.S.cur.segments || []).length > 0, 4000);
            r.segs = (VC.S.cur.segments || []).length;

            // 桌面版不该再去碰浏览器实时识别 —— Electron 里那个引擎永远连不上，
            // 之前就是它一直在弹「识别服务网络异常，正在自动重连…」。
            r.srSupported = (await import('./js/asr.js')).SR_SUPPORTED;
            r.warnVisible = !!(q('#warnBox') && !q('#warnBox').hidden);
            r.warnText = ((q('#warnBox') && q('#warnBox').textContent) || '').trim();
            // 界面上不该出现「晗晗」字样
            r.brandLeak = (document.body.innerText || '').includes('晗晗');
            // 连点 5 下左上角图标要能打开藏起来的那一页
            const lg = document.querySelector('.brand .logo');
            if (lg) for (let i = 0; i < 5; i++) lg.click();
            await sleep(250);
            r.dedication = !!(q('#dlgHi') && q('#dlgHi').open);
            if (r.dedication) q('#dlgHi').close();

            // 首屏诊断条里不能有红叉。桌面版 SR_SUPPORTED 恒为 false，
            // 以前会渲染成红色「✗ 此浏览器不支持实时识别 — 请用 Chrome/Edge」，
            // 她一打开 App 第一眼就看见，会以为坏了不敢按录制。
            r.diagRed = Array.from(document.querySelectorAll('#diag span.no')).map(x => x.textContent.trim());

            // 录制中必须阻止 Mac 休眠，否则她切到别的窗口记笔记时整段录音会停。
            r.sleepBlocked = (await window.VCDesktop.info()).preventSleep !== false;

            // 课堂概要绝不能是「Model not available in Chromium + 英文讲稿复读」。
            // Electron 里 self.Summarizer 存在、create() 成功、summarize() 回桩，
            // 三道闸门以前全部放行，她下课拿到的笔记就是那坨东西。
            try {
              const fake = { id: 'smoke', segments: [
                { id: '1', t: 0,     kind: 'speech', text: 'Good morning, today we define judicial review as the power of a court to invalidate a statute.', zh: '' },
                { id: '2', t: 30000, kind: 'speech', text: 'This will be on the midterm, so write it down. The reading is due next Friday.', zh: '' }
              ], myNotes: '', startedAt: 0, endedAt: 60000 };
              const sum = await window.VC.summarize(fake, { teacher: 'T', course: 'C' }, () => {});
              r.summaryOk = !!sum && !/model not available/i.test(sum);
              r.summaryHead = String(sum || '').slice(0, 70).split(String.fromCharCode(10)).join(' ');
            } catch (e) { r.summaryOk = false; r.summaryHead = 'throw: ' + e.message; }

            // stopRecording 会一路跑到生成概要，慢，而且不是这次要验的东西。
            // 只要它别抛异常就行（FRAG.flush() 就在它开头）。
            await Promise.race([ VC._test.stopRecording(), sleep(15000) ]);
            r.stopped = !(VC.S && VC.S.cur);
            // 下课自动存档（写到临时目录，见 defaultArchiveRoot）
            if (r.stopped) {
              await until(() => VC.S.detail && VC.S.detail.id === r.sessionId && (VC.S.detail.archivedAt || VC.S.detail.archiveError), 20000);
              const sx = await VC.db.get('sessions', r.sessionId);
              r.archived = !!(sx && sx.archivedAt);
              r.archiveRel = (sx && sx.archiveRel) || '';
              r.archiveError = (sx && sx.archiveError) || '';
            }
            // 概要编辑器：改一句，保存，数据库和存档都要跟着变
            if (r.stopped && FLOW !== 'quick') {
              await until(() => VC.S.detail && VC.S.detail.id === r.sessionId, 8000);
              q('#btnSumEdit').click();
              await until(() => !q('#sumEditor').hidden, 3000);
              q('#sumText').value = ['# 我改过的概要', '', '- 冒烟测试编辑器'].join(String.fromCharCode(10));
              const before = (await VC.db.get('sessions', r.sessionId)).archivedAt || 0;
              q('#btnSumSave').click();
              await until(() => q('#sumEditor').hidden, 3000);
              const sy = await VC.db.get('sessions', r.sessionId);
              r.editedSaved = !!(sy && /冒烟测试编辑器/.test(sy.summary || ''));
              // 等存档重写一次
              for (let i = 0; i < 60; i++) {
                const sz = await VC.db.get('sessions', r.sessionId);
                if (sz && sz.archivedAt && sz.archivedAt > before) { r.editedArchived = true; break; }
                await sleep(150);
              }
              // 「总结」页要能看到它
              document.querySelector('[data-go="notes"]').click();
              await until(() => q('#notesList .note-card'), 5000);
              r.notesShows = Array.from(document.querySelectorAll('#notesList .note-card')).some(c => /冒烟测试编辑器/.test(c.textContent));
              // 设置页：存档区要显示出来、位置对、「全部补存」能跑完
              document.querySelector('[data-go="settings"]').click();
              await until(() => q('#archiveBox') && !q('#archiveBox').hidden, 5000);
              r.archiveBoxWhere = (q('#archiveWhere') && q('#archiveWhere').textContent) || '';
              q('#btnArchiveAll').click();
              const DONE_RE = new RegExp('已存档 ([0-9]+) / ([0-9]+) 节');
              // 设置页一打开就会显示「已存档 1 / N」，所以不能一匹配就算完；
              // 「正在存档…」又可能一闪而过抓不到。等补存结束时的 toast「存好了 N 节」（停留 4 秒）。
              await until(() => toastText().includes('存好了'), 30000);
              await until(() => DONE_RE.test((q('#archiveMsg') || {}).textContent || ''), 5000);
              r.archiveMsg = (q('#archiveMsg') || {}).textContent || '';
              const dm = DONE_RE.exec(r.archiveMsg);
              r.archiveAllOk = !!dm && dm[1] === dm[2];
            }
            if (FLOW === 'quick' && r.stopped) {
              // 注意：go('session') 是同步切页，openSession 才异步读库、设提示条。
              // 只等「页面可见」会抢跑 —— 要等到这节课真的渲染完（S.detail 就是它）。
              await until(() => VC.S.detail && VC.S.detail.id === r.sessionId
                                && q('#sMetaMiss') && !q('#sMetaMiss').hidden, 10000);
              r.metaMissShown = !!(q('#sMetaMiss') && !q('#sMetaMiss').hidden);
              // 下课补填：直接打一个**新**老师名字 + 一个新学科
              q('#btnFillMeta').click();
              if (await until(() => q('#dlg').open && q('#dlgBody [name=teacher]'), 4000)) {
                q('#dlgBody [name=teacher]').value = '快速测试老师';
                q('#dlgBody [name=course]').value = '快速测试学科';
                q('#dlgOk').click();
                await until(() => q('#sMetaMiss') && q('#sMetaMiss').hidden, 5000);
              }
              const sAfter = await VC.db.get('sessions', r.sessionId);
              const t = sAfter && (await VC.db.get('teachers', sAfter.teacherId));
              const c = sAfter && (await VC.db.get('courses', sAfter.courseId));
              r.filled = !!(t && t.name === '快速测试老师' && c && c.name === '快速测试学科');
              r.metaMissHiddenAfter = !!(q('#sMetaMiss') && q('#sMetaMiss').hidden);
            }
          } catch (e) {
            r.error = String((e && (e.name + ': ' + e.message)) || e);
          }
          r.ok = r.addedTeacher && r.addedCourse && r.started && r.segs > 0 && !r.error
                 && r.srSupported === false && r.warnVisible === false
                 && r.brandLeak === false && r.dedication === true
                 && r.waitingShown === true && r.waitingCleared === true
                 && (r.diagRed || []).length === 0 && r.sleepBlocked === true
                 && r.summaryOk === true && r.archived === true
                 && (r.flow === 'quick' || (r.editedSaved && r.editedArchived && r.notesShows && /archive-test/.test(r.archiveBoxWhere) && r.archiveAllOk))
                 && (!${JSON.stringify(process.env.VC_SMOKE_TRANSLATE === '1')} || /[\u4e00-\u9fff]/.test(r.zh || ''))
                 && (r.flow !== 'quick' || (r.quickNoMeta && r.engine === 'whisper'
                      && /whisper-base/.test(r.wmodel) && r.metaMissShown && r.filled && r.metaMissHiddenAfter));
          return r;
        })()`, true);

        out({
          ok: probe.title.indexOf('VoiceCollector') >= 0
            && probe.url.indexOf('127.0.0.1') >= 0
            && probe.hasVCDesktop
            && probe.domReady
            && !probe.ipc.error
            && probe.ipc.sleepOn === true
            && probe.ipc.sleepOff === false
            && rec.ok,
          mode: web.mode,
          webRoot: web.dir,
          serverOrigin: httpServer ? httpServer.origin : '',
          recording: rec,
          net: { mode: process.env.VC_NET || 'normal', external: externalRequests.slice(), local: localModelRequests.slice() },
          probe: probe
        });
      } catch (err) {
        out({ ok: false, error: String(err && err.message || err) });
      }
    }, 3000);
  });
}

// ───────────────────────── 网络监视 / 模拟（只给测试用） ─────────────────────────
// 她明确要求「网络很差的时候照样能用」。要证明这一点，就得知道 App 在关键路径上
// 到底往外发了什么请求，并且在断网 / 网络卡死的情况下真的跑一遍。
//   VC_NET=offline   对外请求一律立刻失败（断网）
//   VC_NET=blackhole 对外请求一律挂起、永不返回（最糟的「网络差」：连得上但不回）
// 不设就是正常联网，只做记录。本机 127.0.0.1 的请求永远放行。
const externalRequests = [];
const localModelRequests = [];
function setupNetworkWatch(ses) {
  const mode = process.env.VC_NET || '';
  if (!SMOKE && !mode) return;
  const note = (d, what) => {
    if (/\/(models|vendor)\//.test(d.url || '') && localModelRequests.length < 120) {
      localModelRequests.push((d.method || 'GET') + ' ' + what + ' ' + String(d.url).replace(/^https?:\/\/[^/]+/, '').slice(0, 110));
    }
  };
  ses.webRequest.onCompleted(d => note(d, String(d.statusCode) + (d.fromCache ? '(缓存)' : '')));
  ses.webRequest.onErrorOccurred(d => note(d, 'ERR ' + d.error));
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url || '';
    if (/^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(u) || !/^(https?|wss?):/i.test(u)) return cb({});
    if (externalRequests.length < 200) externalRequests.push(u.slice(0, 160));
    if (mode === 'offline') return cb({ cancel: true });
    if (mode === 'blackhole') return;          // 永远不回调 = 请求一直挂着
    cb({});
  });
}

// ───────────────────────── 固定端口 ─────────────────────────
// ⚠️ 以前这里是端口 0（让系统每次随便给一个）。这是「每次重新打开都出问题」的真正原因：
//    浏览器的 IndexedDB / localStorage 是按「网址」隔离的，而端口是网址的一部分。
//    端口一变 = 换了一个网站 = 一个全新的空数据库。她添加的老师、学科、设置、
//    **上过的课和录音**，下次打开就全「消失」了（其实被困在旧端口的库里）。
//    她的配置目录里实测有 21 个互相隔离的数据库，一个端口一个。
//
// 现在：固定用一个端口，并且记在 userData/port.json 里，以后永远用它。
// 被别的程序占了才往后顺延，选中的那个同样记下来。万一真的换了端口，
// 旧端口里的数据会在下次启动时被 migrateOrigins() 搬过来（见下面），不会再丢。
const PREFERRED_PORT = 47823;
let busySavedPort = 0;   // 这次启动时，原来的端口被别的程序占着（它下面的数据得换个办法读）
const PORT_FILE = () => path.join(app.getPath('userData'), 'port.json');

function readSavedPort() {
  try {
    const j = JSON.parse(fs.readFileSync(PORT_FILE(), 'utf8'));
    if (Number.isInteger(j.port) && j.port > 1024 && j.port < 65536) return j.port;
  } catch (_) {}
  return 0;
}
function savePort(port) {
  try { fs.writeFileSync(PORT_FILE(), JSON.stringify({ port, savedAt: new Date().toISOString() })); } catch (_) {}
}

async function listenStable(root, opt) {
  const saved = readSavedPort();
  const tries = [];
  if (saved) tries.push(saved);
  for (let p = PREFERRED_PORT; p < PREFERRED_PORT + 10; p++) if (!tries.includes(p)) tries.push(p);
  let lastErr = null;
  for (const port of tries) {
    try {
      const srv = await createStaticServer(root, Object.assign({}, opt, { port }));
      if (port !== saved) {
        if (saved) {
          console.log('[端口] 原来的 ' + saved + ' 被占用了，改用 ' + port + '（旧数据会自动搬过来）');
          busySavedPort = saved;
        }
        savePort(port);
      }
      return srv;
    } catch (e) {
      lastErr = e;
      if (e && e.code !== 'EADDRINUSE') break;   // 不是「被占用」就别再试了
    }
  }
  // 实在不行才退回随机端口，并大声记一笔
  console.log('[端口] 固定端口全被占用（' + (lastErr && lastErr.message) + '），这次用随机端口');
  return createStaticServer(root, Object.assign({}, opt, { port: 0 }));
}

// ───────────────────────── 旧端口数据迁移 ─────────────────────────
// 以前每次启动端口都不一样，每个端口都有一个自己的数据库（她的配置里实测 21 个）。
// 启动时把「当前端口以外」的所有旧库读出来，交给界面合并进当前库。
//   · 只读旧库，绝不删改 —— 迁移出岔子，原数据还在原地
//   · 界面确认合并成功才记账（migrated.json），没成功下次再来
//   · 以后万一因为端口被占用换了端口，也是靠这个把数据带过去
let pendingMigration = null;
let migrationPromise = null;
const MIGRATED_FILE = () => path.join(app.getPath('userData'), 'migrated.json');

function readMigrated() {
  try { const j = JSON.parse(fs.readFileSync(MIGRATED_FILE(), 'utf8')); return Array.isArray(j.ports) ? j.ports : []; }
  catch (_) { return []; }
}
function writeMigrated(ports) {
  try { fs.writeFileSync(MIGRATED_FILE(), JSON.stringify({ ports, at: new Date().toISOString() })); } catch (_) {}
}

function oldPorts(currentPort) {
  const done = new Set(readMigrated());
  const found = new Set();
  const scan = (sub, re) => {
    try {
      for (const n of fs.readdirSync(path.join(app.getPath('userData'), sub))) {
        const m = re.exec(n);
        if (m) found.add(parseInt(m[1], 10));
      }
    } catch (_) {}
  };
  scan('IndexedDB', /^http_127\.0\.0\.1_(\d+)\.indexeddb\.leveldb$/);
  return [...found].filter(p => p !== currentPort && !done.has(p)).sort((a, b) => a - b);
}

const withTimeout = (p, ms, what) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' 超时')), ms))
]);

async function exportOrigin(root, port) {
  const origin = 'http://127.0.0.1:' + port;
  // ⚠️ 早期版本在这些旧网址里注册过 Service Worker（后来因为它会返回旧文件被废掉了），
  //    但它还留在旧网址的存储里，会拦截 migrate.html 的请求 → ERR_FAILED。
  //    只清 Service Worker，IndexedDB / localStorage 一个字节都不碰。
  try { await session.defaultSession.clearStorageData({ origin, storages: ['serviceworkers', 'cachestorage'] }); } catch (_) {}

  let srv = null, win = null;
  try {
    srv = await createStaticServer(root, { port, coi: true });
  } catch (e) {
    // 旧端口现在被别的程序占着 —— 这次读不了，下次再试（不记账）
    return { port, skipped: true, reason: e.code || e.message };
  }
  try {
    win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    await withTimeout(win.loadURL(origin + '/migrate.html'), 8000, '加载');
    for (let i = 0; i < 50; i++) {
      if (await win.webContents.executeJavaScript('!!window.__vcReady', true)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const dump = await withTimeout(win.webContents.executeJavaScript('window.__vcExport()', true), 20000, '读取');
    return { port, dump };
  } catch (e) {
    return { port, skipped: true, reason: e.message };
  } finally {
    try { win && !win.isDestroyed() && win.destroy(); } catch (_) {}
    try { srv && await srv.close(); } catch (_) {}
  }
}

// 旧端口正被别的程序占着 → 没法在那个端口起临时服务器 → 但数据库是按「网址」存的，
// 只要浏览器以为自己在那个网址下就能读。所以：在 App 内部拦截对那个网址的 http 请求，
// 直接从磁盘把 migrate.html 等文件给它，根本不碰那个端口。
// ⚠️ 拦截对整个 session 生效，所以只在「主窗口打开之前」做、做完立刻撤掉，
//    正常情况（端口没被占）永远不会走到这里。
async function exportOriginIntercept(root, port) {
  const origin = 'http://127.0.0.1:' + port;
  const ses = session.defaultSession;
  try { await ses.clearStorageData({ origin, storages: ['serviceworkers', 'cachestorage'] }); } catch (_) {}
  ses.protocol.handle('http', async req => {
    if (req.url.startsWith(origin + '/')) {
      const file = resolveSafe(root, new URL(req.url).pathname);
      try {
        const buf = await fsp.readFile(file);
        return new Response(buf, { headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
      } catch (_) { return new Response('', { status: 404 }); }
    }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
  let win = null;
  try {
    win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    await withTimeout(win.loadURL(origin + '/migrate.html'), 8000, '加载');
    for (let i = 0; i < 50; i++) {
      if (await win.webContents.executeJavaScript('!!window.__vcReady', true)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const dump = await withTimeout(win.webContents.executeJavaScript('window.__vcExport()', true), 20000, '读取');
    return { port, dump };
  } catch (e) {
    return { port, skipped: true, reason: e.message };
  } finally {
    try { win && !win.isDestroyed() && win.destroy(); } catch (_) {}
    try { ses.protocol.unhandle('http'); } catch (_) {}
  }
}

let preDumps = [];   // 主窗口打开前就读好的（被占端口那一份）

async function migrateOrigins(root, currentPort) {
  const pre = new Set(preDumps.map(d => d.port));
  const ports = oldPorts(currentPort).filter(p => !pre.has(p));
  if (!ports.length && !preDumps.length) return;
  console.log('[迁移] 发现 ' + ports.length + ' 个旧端口的数据库：' + ports.join(', '));
  const dumps = preDumps.filter(r => r.dump).map(r => r.dump);
  const empty = [];
  for (const p of ports) {
    const r = await exportOrigin(root, p);
    if (r.skipped) { console.log('[迁移] 端口 ' + p + ' 这次读不了：' + r.reason); continue; }
    const st = r.dump && r.dump.stores || {};
    const n = Object.values(st).reduce((a, rows) => a + (rows ? rows.length : 0), 0);
    if (n || Object.keys(r.dump.local || {}).length) dumps.push(r.dump);
    else empty.push(p);
  }
  // 完全空的旧库直接记账，不用麻烦界面
  if (empty.length) writeMigrated([...new Set([...readMigrated(), ...empty])]);
  if (dumps.length) {
    pendingMigration = { dumps, ports: dumps.map(d => parseInt(String(d.origin).split(':').pop(), 10)) };
    console.log('[迁移] 有数据的旧库 ' + dumps.length + ' 个，等界面合并');
  }
}

// ───────────────────────── 启动 ─────────────────────────
async function boot() {
  // 冒烟测试时连 Dock 图标都别出来。
  // 窗口本来就不显示（见 ready-to-show），但 Electron 默认还是会在 Dock 里
  // 弹一个原子球图标出来 —— 她在用电脑的时候会被这个吓一跳，
  // 以为自己装了个叫 Electron 的东西。
  if (SMOKE && IS_MAC && app.dock) { try { app.dock.hide(); } catch (_) {} }

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

  // 更新层：userData 里装着的、比内置版新的网页层。
  // activeOverlay 顺带做自愈 —— 上次带着 .pending 启动却没确认成功的版本会被丢掉。
  const bundled = updater.readManifest(web.dir);
  const bundledVer = (bundled && bundled.version) || '0.0.0';
  try {
    overlayInfo = (SMOKE && process.env.VC_TEST_UPDATE !== '1') ? null : updater.activeOverlay(app.getPath('userData'), bundledVer);
  } catch (e) { console.log('[更新] 检查更新层出错：' + e.message); overlayInfo = null; }
  if (overlayInfo) {
    console.log('[更新] 使用更新层 ' + overlayInfo.version + '（内置 ' + bundledVer + '）');
    updater.markPending(overlayInfo.dir);   // 界面起来后会 confirmBoot 删掉
  }

  httpServer = await listenStable(web.dir, {
    coi: process.env.VC_NO_COI !== '1',
    keepServiceWorker: process.env.VC_KEEP_SW === '1',
    overlay: overlayInfo ? overlayInfo.dir : null
  });
  console.log('[本地服务] ' + httpServer.indexUrl);
  // 原来的端口被别的程序占着：它下面的数据只能靠拦截来读，而拦截必须在主窗口打开前做完。
  // 只有这种少见情况会让窗口晚一两秒出来。
  if (busySavedPort && (!SMOKE || process.env.VC_TEST_MIGRATE === '1')) {
    try {
      const r = await withTimeout(exportOriginIntercept(web.dir, busySavedPort), 30000, '读取被占端口');
      if (r && r.dump) { preDumps = [r]; console.log('[迁移] 端口 ' + busySavedPort + ' 被占着，已用拦截的办法读出旧数据'); }
      else console.log('[迁移] 端口 ' + busySavedPort + ' 被占着，这次没读出来：' + (r && r.reason));
    } catch (e) { console.log('[迁移] 读取被占端口失败：' + e.message); }
  }
  // 迁移放后台跑，**绝不能挡住开窗口**：万一哪个旧库卡住，App 至少要能打开能录课。
  if (!SMOKE || process.env.VC_TEST_MIGRATE === '1') {
    migrationPromise = migrateOrigins(web.dir, httpServer.port)
      .catch(e => console.log('[迁移] 出错，跳过（旧数据原地不动）：' + e.message));
  }

  const ses = session.defaultSession;
  setupNetworkWatch(ses);
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
  // ⚠️ 主窗口还没建出来的时候不算。启动时读旧数据会开一个隐藏窗口、读完关掉，
  //    那一刻「所有窗口都关了」—— 不拦的话 App 会在启动途中把自己关掉
  //    （will-quit 把 httpServer 置空，接着 boot 里就是 null.port 崩溃）。
  if (!mainWindowCreated) return;
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
