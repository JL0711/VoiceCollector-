// 窗口尺寸/位置记忆
// 存在 userData/window-state.json，下次打开还是上次的大小。
// 纯 node 实现，不 require electron，方便单测。

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = { width: 1180, height: 800, x: undefined, y: undefined, maximized: false };

function readState(file, defaults) {
  const base = Object.assign({}, DEFAULTS, defaults || {});
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    const num = v => (typeof v === 'number' && isFinite(v) ? Math.round(v) : undefined);
    const st = {
      width: num(j.width) || base.width,
      height: num(j.height) || base.height,
      x: num(j.x),
      y: num(j.y),
      maximized: !!j.maximized
    };
    // 兜底：别让坏数据把窗口撑成 1 像素或者甩到屏幕外
    if (st.width < 640) st.width = base.width;
    if (st.height < 480) st.height = base.height;
    return st;
  } catch (_) {
    return base;
  }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 绑定到一个 BrowserWindow：窗口移动/缩放/最大化时防抖写盘，关闭时再写一次。
 * @param {object} win BrowserWindow
 * @param {string} file 存档路径
 */
function track(win, file) {
  let timer = null;
  const snapshot = () => {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    // 最大化/全屏状态下 getBounds 是屏幕尺寸，别覆盖掉用户原来的窗口大小
    if (maximized || win.isFullScreen() || win.isMinimized()) {
      const prev = readState(file);
      return writeState(file, Object.assign({}, prev, { maximized: maximized }));
    }
    const b = win.getBounds();
    writeState(file, { width: b.width, height: b.height, x: b.x, y: b.y, maximized: false });
  };
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(snapshot, 400);
  };
  ['resize', 'move', 'maximize', 'unmaximize'].forEach(ev => win.on(ev, later));
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    snapshot();
  });
}

module.exports = { readState, writeState, track, DEFAULTS };
