// 网页版演练：用一个「没有桌面版外壳」的窗口打开 server.py 起的网页，
// 走的是浏览器那套代码路径（IS_DESKTOP=false）。
// 只测快速开始 —— 完整流程在浏览器里会用 Chrome 的实时识别，Electron 模拟不了。
//   VC_WEB_URL=http://localhost:18787/index.html  VC_NET=offline|blackhole
const { app, BrowserWindow, session } = require('electron');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');   // 自动允许麦克风，不弹框
app.whenReady().then(async () => {
  if (app.dock) try { app.dock.hide(); } catch (_) {}
  const ext = [];
  const mode = process.env.VC_NET || '';
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    if (/^(https?|wss?):\/\/(127\.0\.0\.1|localhost)[:/]/.test(d.url) || !/^(https?|wss?):/.test(d.url)) return cb({});
    ext.push(d.url.slice(0, 120));
    if (mode === 'offline') return cb({ cancel: true });
    if (mode === 'blackhole') return;
    cb({});
  });
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true));
  const done = r => { console.log('===WEB===' + JSON.stringify({ ...r, ext }) + '===WEB==='); app.exit(r.ok ? 0 : 1); };
  const wd = setTimeout(() => done({ ok: false, error: '120 秒没跑完 —— 卡死了' }), 120000);
  const w = new BrowserWindow({ show: false });
  const errs = [];
  w.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 3) errs.push(String(msg).slice(0, 160)); });
  try { await w.loadURL(process.env.VC_WEB_URL); } catch (e) { clearTimeout(wd); return done({ ok: false, error: '打不开：' + e.message }); }
  const r = await w.webContents.executeJavaScript(`(async () => {
    const r = { ok: false };
    const q = s => document.querySelector(s), sleep = ms => new Promise(x => setTimeout(x, ms));
    const until = async (f, ms) => { const e = Date.now() + ms; while (Date.now() < e) { if (f()) return true; await sleep(150); } return false; };
    if (!await until(() => window.VC && window.VC._test, 40000)) { r.error = 'init 没跑完'; return r; }
    r.isDesktop = !!window.VCDesktop;
    r.title = document.title;
    r.brandLeak = (document.body.innerText || '').includes('晗晗');
    q('#selDstLang').value = 'zh-Hans';
    q('#btnQuick').click();
    if (!await until(() => VC.S.cur && !q('#liveCard').hidden, 30000)) { r.error = '快速开始没开起来：' + (q('#toast') && q('#toast').textContent); return r; }
    r.engine = VC.S.cur.engine;
    VC._test.addSegment({ text: 'The Supreme Court decided this case in nineteen sixty four.', kind: 'speech', t: 0 });
    await until(() => (VC.S.cur.segments || []).some(x => x.zh && /[一-鿿]/.test(x.zh)), 40000);
    r.zh = ((VC.S.cur.segments || []).find(x => x.kind === 'speech') || {}).zh || '';
    const id = VC.S.cur.id;
    await Promise.race([VC._test.stopRecording(), sleep(20000)]);
    const s = await VC.db.get('sessions', id);
    r.saved = !!s; r.summary = !!(s && s.summary && !/model not available/i.test(s.summary));
    r.ok = r.engine === 'whisper' && /[一-鿿]/.test(r.zh) && r.saved && r.summary && !r.brandLeak && !r.isDesktop;
    return r;
  })()`, true).catch(e => ({ ok: false, error: e.message }));
  clearTimeout(wd);
  done({ ...r, errs: errs.slice(0, 5) });
});
