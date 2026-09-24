// VoiceCollector 本地启动器（Node 版，没装 Python 时用）—— 行为和 server.py 保持一致。
//
// 以前这个文件有三个问题（server.py 修过，这里一直没跟上）：
//   · 没配 .mjs / .wasm 的类型 → 浏览器拒绝加载 ORT 的 .mjs 模块，Whisper 和翻译都起不来
//   · 没有 COOP/COEP 头 → 没有 SharedArrayBuffer，识别只能单线程，慢好几倍
//   · 双击两次会另开一个端口 → 浏览器按网址存数据，换了端口就「以前的课都没了」
const http = require('http'), fs = require('fs'), path = require('path'), { exec } = require('child_process');
const ROOT = path.join(__dirname, 'web');
const PORTS = process.env.VC_PORT ? [Number(process.env.VC_PORT)] : [8787, 8788, 8799, 8080, 9123];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.onnx': 'application/octet-stream'
};

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch (_) { res.writeHead(400).end(); return; }
  if (p === '/') p = '/index.html';
  const file = path.resolve(ROOT, '.' + path.posix.normalize(p));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404'); return; }
    const cacheable = p.startsWith('/models/') || p.startsWith('/vendor/');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': cacheable ? 'public, max-age=604800' : 'no-store',
      // 跨源隔离：ONNX 才能多线程（快很多）
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});

function openBrowser(url) {
  if (process.env.VC_NO_BROWSER === '1') return;       // 自动化测试时别在屏幕上弹浏览器
  const cmd = process.platform === 'darwin' ? `open -a "Google Chrome" "${url}" || open "${url}"`
    : process.platform === 'win32' ? `start chrome "${url}" || start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// 这个端口上是不是已经跑着我们自己（上一次双击开的）
function alreadyRunning(port) {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port, path: '/version.json', timeout: 1500 }, rsp => {
      let b = ''; rsp.on('data', d => { b += d; });
      rsp.on('end', () => { try { res('version' in JSON.parse(b)); } catch (_) { res(false); } });
    });
    r.on('error', () => res(false));
    r.on('timeout', () => { r.destroy(); res(false); });
  });
}

(async () => {
  // 已经开着一个了（比如双击了两次）→ 直接打开那一个，绝不另起一个新端口
  if (await alreadyRunning(PORTS[0])) {
    const url = `http://localhost:${PORTS[0]}/index.html`;
    console.log('VoiceCollector 已经在运行了，直接打开它：', url);
    openBrowser(url);
    return;
  }
  (function listen(i) {
    if (i >= PORTS.length) { console.log('端口都被占用了：', PORTS.join(', ')); return; }
    server.once('error', () => listen(i + 1));
    server.listen(PORTS[i], '127.0.0.1', () => {
      const url = `http://localhost:${PORTS[i]}/index.html`;
      console.log('='.repeat(58));
      console.log('  VoiceCollector 课堂助手（网页版）已启动');
      console.log('  浏览器地址： ' + url);
      console.log('  关掉这个窗口 = 关掉程序（先在网页里结束录制！）');
      if (i > 0) {
        console.log('');
        console.log(`  ⚠️ 平时用的 ${PORTS[0]} 端口被别的程序占用了，这次临时用 ${PORTS[i]}。`);
        console.log('     浏览器按网址存数据，所以这次看不到以前的课（它们没丢）。');
        console.log(`     关掉占用 ${PORTS[0]} 的程序、再重新打开，就都回来了。`);
      }
      console.log('='.repeat(58));
      setTimeout(() => openBrowser(url), 700);
    });
  })(0);
})();
