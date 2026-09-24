// 中文应用菜单
//
// 为什么一定要自己装菜单？
//   Electron 在 macOS 上如果不设置菜单，系统只给一个最简菜单，
//   Cmd+C / Cmd+V / Cmd+A 这些编辑快捷键全都失效（它们靠菜单项的 role 绑定）。
//   所以下面每个编辑项都带 role，只是把英文标题换成中文。

'use strict';

const { app, Menu, shell, dialog, BrowserWindow } = require('electron');

const IS_MAC = process.platform === 'darwin';

/**
 * @param {{ onAbout?: Function, onOpenMicSettings?: Function, appVersion?: string }} [hooks]
 */
function buildMenu(hooks) {
  const h = hooks || {};
  const version = h.appVersion || app.getVersion();

  const about = () => {
    if (h.onAbout) return h.onAbout();
    dialog.showMessageBox({
      type: 'info',
      title: '关于 VoiceCollector',
      message: 'VoiceCollector ' + version,
      detail: [
        '大学课堂实时记录与中文翻译',
        '',
        'Electron ' + process.versions.electron,
        'Chromium ' + process.versions.chrome,
        'Node ' + process.versions.node
      ].join('\n'),
      buttons: ['好的']
    });
  };

  const template = [];

  // ── macOS 的应用菜单（第一个菜单，标题永远是 App 名字）──
  if (IS_MAC) {
    template.push({
      label: 'VoiceCollector',
      submenu: [
        { label: '关于 VoiceCollector', click: about },
        { type: 'separator' },
        {
          label: '麦克风权限设置…',
          click: () => {
            if (h.onOpenMicSettings) return h.onOpenMicSettings();
            shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
          }
        },
        { type: 'separator' },
        { label: '服务', role: 'services', submenu: [] },
        { type: 'separator' },
        { label: '隐藏 VoiceCollector', role: 'hide' },
        { label: '隐藏其他', role: 'hideOthers' },
        { label: '全部显示', role: 'unhide' },
        { type: 'separator' },
        { label: '退出 VoiceCollector', role: 'quit' }
      ]
    });
  }

  // ── 文件 ──
  template.push({
    label: '文件',
    submenu: [
      {
        label: '重新加载界面',
        accelerator: 'CmdOrCtrl+R',
        click: () => {
          const w = BrowserWindow.getFocusedWindow();
          if (w) w.webContents.reload();
        }
      },
      { type: 'separator' },
      IS_MAC ? { label: '关闭窗口', role: 'close' } : { label: '退出', role: 'quit' }
    ]
  });

  // ── 编辑（这些 role 负责 Cmd+C/V/X/Z/A 快捷键）──
  template.push({
    label: '编辑',
    submenu: [
      { label: '撤销', role: 'undo' },
      { label: '重做', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', role: 'cut' },
      { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' },
      { label: '粘贴为纯文本', role: 'pasteAndMatchStyle' },
      { label: '删除', role: 'delete' },
      { label: '全选', role: 'selectAll' },
      { type: 'separator' },
      IS_MAC
        ? { label: '语音', submenu: [{ label: '开始朗读', role: 'startSpeaking' }, { label: '停止朗读', role: 'stopSpeaking' }] }
        : { type: 'separator' }
    ]
  });

  // ── 视图 ──
  template.push({
    label: '视图',
    submenu: [
      { label: '强制重新加载', role: 'forceReload' },
      { label: '开发者工具', role: 'toggleDevTools' },
      { type: 'separator' },
      { label: '实际大小', role: 'resetZoom' },
      { label: '放大', role: 'zoomIn' },
      { label: '缩小', role: 'zoomOut' },
      { type: 'separator' },
      { label: '全屏', role: 'togglefullscreen' }
    ]
  });

  // ── 窗口 ──
  template.push({
    label: '窗口',
    role: 'window',
    submenu: IS_MAC
      ? [
          { label: '最小化', role: 'minimize' },
          { label: '缩放', role: 'zoom' },
          { type: 'separator' },
          { label: '前置全部窗口', role: 'front' }
        ]
      : [
          { label: '最小化', role: 'minimize' },
          { label: '关闭', role: 'close' }
        ]
  });

  // ── 帮助 ──
  template.push({
    label: '帮助',
    role: 'help',
    submenu: [
      { label: '关于 VoiceCollector', click: about },
      {
        label: '使用说明（README）',
        click: () => {
          const w = BrowserWindow.getFocusedWindow();
          dialog.showMessageBox(w || undefined, {
            type: 'info',
            title: '使用说明',
            message: '大教室怎么用？',
            detail: [
              '1) 坐得远、老师用扩音喇叭时，请在「设置」里打开「远场模式」，',
              '   并把识别引擎切到 Whisper（桌面版只能用 Whisper，原因见下）。',
              '2) 桌面版的 Chromium 里没有 Google 的语音服务密钥，',
              '   浏览器实时识别（Web Speech API）用不了，必须用本机 Whisper 或云端转写。',
              '3) 录制时电脑不会休眠；停止录制后会自动放开，尽量省电。',
              '4) 首次使用 Whisper 需要联网下载模型，之后可以离线。'
            ].join('\n'),
            buttons: ['知道了']
          });
        }
      },
      { type: 'separator' },
      {
        label: '打开数据目录',
        click: () => { shell.openPath(app.getPath('userData')); }
      }
    ]
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { buildMenu };
