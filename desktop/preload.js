// VoiceCollector 桌面版 · preload
//
// 只往页面里塞一个极小的 window.VCDesktop。
// app.js 靠 `if (window.VCDesktop)` 判断自己是不是跑在桌面版里，
// 所以下面这些名字【不要改】。
//
// contextIsolation + sandbox 都是开着的：页面永远拿不到 Node，
// 能做的事只有下面这几个白名单方法。

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 版本号和平台由主进程通过 additionalArguments 传进来（同步可读，不用 await）
function argOf(name, fallback) {
  try {
    const hit = (process.argv || []).find(a => a.indexOf('--' + name + '=') === 0);
    return hit ? hit.slice(name.length + 3) : fallback;
  } catch (_) {
    return fallback;
  }
}

const PLATFORM = argOf('vc-platform', process.platform || 'unknown');
const VERSION = argOf('vc-version', '0.0.0');

// ── 退出确认：页面注册的回调 ──
// 主进程在用户点关闭/Cmd+Q 时发 'vc:before-quit-query'，
// 我们依次问每个回调，只要有一个说「别退」，就把理由回给主进程弹确认框。
const quitHandlers = [];

ipcRenderer.on('vc:before-quit-query', async (e, id) => {
  let verdict = true; // 默认允许退出
  for (const fn of quitHandlers) {
    try {
      let r = fn();
      if (r && typeof r.then === 'function') r = await r;
      // 回调可以返回：
      //   true / undefined      → 可以退出
      //   false                 → 不建议退出（用默认提示语）
      //   '正在录制第 3 节课'    → 不建议退出，并把这句话当提示语
      //   {allow:false, reason} → 同上
      if (r === false || typeof r === 'string' || (r && typeof r === 'object' && r.allow === false)) {
        verdict = r;
        break;
      }
    } catch (_) { /* 回调自己炸了就当它同意退出 */ }
  }
  try { ipcRenderer.send('vc:before-quit-reply', id, verdict); } catch (_) {}
});

const VCDesktop = {
  /** 恒为 true。app.js 用它来判断「我在桌面版里」 */
  isDesktop: true,

  /** 探测这台电脑上有哪些云盘文件夹（Google Drive / iCloud / OneDrive…） */
  cloudFolders: () => ipcRenderer.invoke('vc:cloud-folders'),

  /** 把课程包写进云盘文件夹（会自动建一个 VoiceCollector 子目录） */
  writeBackup: async (dir, name, blob) => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    return ipcRenderer.invoke('vc:write-backup', { dir, name, data: buf });
  },


  /** 'darwin' | 'win32' | 'linux' */
  platform: PLATFORM,

  /** 桌面 App 的版本号，来自 desktop/package.json */
  version: VERSION,

  /**
   * 录制时调 setPreventSleep(true)，停止时调 setPreventSleep(false)。
   * 作用：阻止系统休眠 + 关掉窗口后台降频（保证计时器和分段录音不飘）。
   * 停止后立刻恢复降频，空闲时几乎不吃电。
   * @param {boolean} on
   * @returns {Promise<boolean>} 当前是否处于「阻止休眠」状态
   */
  setPreventSleep(on) {
    return ipcRenderer.invoke('vc:prevent-sleep', !!on);
  },

  /**
   * 用系统默认浏览器打开链接（只放行 http / https）。
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  openExternal(url) {
    return ipcRenderer.invoke('vc:open-external', String(url || ''));
  },

  /**
   * 导出文件：弹出系统「存储为」对话框。
   * @param {string} name     默认文件名，例如 '2026-03-05 微观经济学.md'
   * @param {string} mimetype MIME，例如 'text/markdown'（只用于对话框的类型过滤）
   * @param {string|ArrayBuffer|Uint8Array|Blob} [data]
   *        可选。传了就由主进程直接写盘；不传就只返回用户选的路径。
   * @returns {Promise<{ok:boolean, canceled:boolean, path:string, written?:boolean, bytes?:number, error?:string}>}
   */
  async showSaveDialog(name, mimetype, data) {
    let payload = data;
    // Blob 不能直接过 IPC，先读成字节
    if (payload && typeof payload === 'object' && typeof payload.arrayBuffer === 'function') {
      payload = new Uint8Array(await payload.arrayBuffer());
    } else if (payload instanceof ArrayBuffer) {
      payload = new Uint8Array(payload);
    }
    return ipcRenderer.invoke('vc:save-file', {
      name: String(name || 'VoiceCollector-导出.txt'),
      mime: String(mimetype || ''),
      data: payload === undefined ? null : payload
    });
  },

  /**
   * 注册「退出前询问」回调。返回一个取消注册的函数。
   * 用法：VCDesktop.onBeforeQuit(() => recording ? '课堂正在录制中' : true)
   * @param {() => (boolean|string|{allow:boolean,reason?:string}|Promise<any>)} cb
   * @returns {() => void}
   */
  onBeforeQuit(cb) {
    if (typeof cb !== 'function') return () => {};
    quitHandlers.push(cb);
    return () => {
      const i = quitHandlers.indexOf(cb);
      if (i >= 0) quitHandlers.splice(i, 1);
    };
  },

  /**
   * 额外的小工具（可选，不用也没关系）：
   * 取主进程的运行信息，调试用。
   * @returns {Promise<object>}
   */
  info() {
    return ipcRenderer.invoke('vc:info');
  },

  /**
   * 额外的小工具（可选）：在访达 / 资源管理器里显示某个文件。
   * @param {string} filePath
   */
  showInFolder(filePath) {
    return ipcRenderer.invoke('vc:show-in-folder', String(filePath || ''));
  },

  /**
   * 更新（只换网页层，约 1MB；见 desktop/lib/updater.js）。
   * 流程：checkUpdate() → 有新版就提示 → 用户点了才 installUpdate() → relaunchForUpdate()。
   */
  /** 旧端口数据迁移：界面启动时取一次，合并完报账（见 main.js migrateOrigins） */
  migration: {
    take: () => ipcRenderer.invoke('vc:migration-take'),
    done: ok => ipcRenderer.invoke('vc:migration-done', !!ok)
  },

  update: {
    state:    () => ipcRenderer.invoke('vc:update-state'),
    check:    () => ipcRenderer.invoke('vc:update-check'),
    install:  () => ipcRenderer.invoke('vc:update-install'),
    relaunch: () => ipcRenderer.invoke('vc:update-relaunch'),
    revert:   () => ipcRenderer.invoke('vc:update-revert'),
    openPage: url => ipcRenderer.invoke('vc:open-release', String(url || '')),
    /** 界面 init() 成功后调一次，证明这个版本能正常起来（否则下次启动会自动退回） */
    bootOk:   () => ipcRenderer.invoke('vc:boot-ok'),
    onProgress(cb) {
      if (typeof cb !== 'function') return () => {};
      const h = (e, p) => { try { cb(p); } catch (_) {} };
      ipcRenderer.on('vc:update-progress', h);
      return () => ipcRenderer.removeListener('vc:update-progress', h);
    }
  }
};

contextBridge.exposeInMainWorld('VCDesktop', VCDesktop);
