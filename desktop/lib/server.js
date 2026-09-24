// 本地静态 HTTP 服务器
//
// 为什么非要起一个 http 服务？
//   桌面版如果用 file:// 直接加载 index.html，会同时踩三个坑：
//   1) ES Module（<script type="module">）在 file:// 下被 CORS 规则拒绝，整个 app.js 加载不起来；
//   2) file:// 的 origin 是 null，getUserMedia 拿不到麦克风权限；
//   3) IndexedDB / ServiceWorker 在 null origin 下行为不可靠，资料库会丢。
//   所以主进程先在 127.0.0.1 上起一个只读的小服务，再 loadURL('http://127.0.0.1:端口/index.html')。
//
// 这个文件是纯 CommonJS、只用 node 内置模块，不依赖 electron，
// 方便单独用 node 跑起来做验证。

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// MIME 表。.js 必须是 text/javascript，否则 Chromium 拒绝执行 ES Module。
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webm': 'audio/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.bin': 'application/octet-stream',
  '.onnx': 'application/octet-stream'
};

// 桌面版专用的 sw.js 替身：把旧的 Service Worker 注销掉。
// 原因：桌面版所有静态文件本来就在本机（asar 里），离线缓存没有任何收益；
// 反而升级 App 之后 SW 会继续吐出旧版本的 app.js，造成“改了没生效”的灵异问题。
// 需要保留真实 sw.js 时设环境变量 VC_KEEP_SW=1。
const SW_STUB = [
  '// VoiceCollector 桌面版：静态文件都在本机，不需要离线缓存。',
  '// 这个 Service Worker 只做一件事：把自己和旧缓存清掉。',
  "self.addEventListener('install', () => self.skipWaiting());",
  "self.addEventListener('activate', e => {",
  '  e.waitUntil((async () => {',
  '    try {',
  '      const ks = await caches.keys();',
  '      await Promise.all(ks.map(k => caches.delete(k)));',
  '    } catch (_) {}',
  '    try { await self.registration.unregister(); } catch (_) {}',
  '    try { await self.clients.claim(); } catch (_) {}',
  '  })());',
  '});',
  ''
].join('\n');

// 把 URL 路径安全地映射到磁盘路径，挡住 ../../ 穿越
function resolveSafe(root, pathname) {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch (_) {
    return null;
  }
  if (p.indexOf('\0') >= 0) return null;
  // 去掉开头的斜杠，交给 path.join 规范化
  const rel = p.replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

// 拒绝来自别的本地程序的跨源探测（DNS rebinding 之类）
function originAllowed(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true; // 页面自己发出的普通导航/子资源请求没有 Origin
  return origin === 'http://127.0.0.1:' + port || origin === 'http://localhost:' + port;
}

function hostAllowed(req) {
  const host = String(req.headers.host || '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '';
}

// 解析 Range 头。只支持单区间（bytes=a-b / bytes=a- / bytes=-n），
// 这已经覆盖 <audio> 拖进度条和 transformers.js 的 `bytes=0-0` 探测。
// 返回值：null = 没有 Range（整包发）；'invalid' = 要回 416；{start,end} = 闭区间。
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;                     // 多区间之类的看不懂，就当没 Range，整包发（HTTP 允许）
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return 'invalid';
  if (size === 0) return 'invalid';
  let start;
  let end;
  if (!hasStart) {
    // bytes=-500 → 最后 500 字节
    const n = parseInt(m[2], 10);
    if (n <= 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = hasEnd ? parseInt(m[2], 10) : size - 1;
    if (start >= size) return 'invalid';
    if (end >= size) end = size - 1;       // 超出末尾按规范夹到末尾，不算错
    if (end < start) return 'invalid';
  }
  return { start: start, end: end };
}

/**
 * 起一个只读的本地静态服务。
 * @param {string} root 要暴露的目录（web/ 的绝对路径）
 * @param {{ coi?: boolean, keepServiceWorker?: boolean, host?: string, port?: number, overlay?: string }} [opt]
 *   overlay: 「更新层」目录，优先于 root。找得到就用它的，找不到就穿透回 root。
 *        这样一次更新只需要下载真正变了的文件（js/css/html 加起来约 1MB），
 *        而 vendor/（67MB）和 models/（662MB）继续用 App 内置的那份 —— 它们几乎不变。
 *        另一个好处：这条路完全不碰 App 本体，所以不需要 Apple 代码签名
 *        （Squirrel.Mac 那套自动更新要求正规签名，我们没有开发者账号）。
 *   coi: 是否发 COOP/COEP 头。开了之后页面处于“跨源隔离”状态，
 *        SharedArrayBuffer 可用 —— Whisper（onnxruntime-web / transformers.js）
 *        的多线程 WASM 才能跑满多核，识别快很多、也更省电（早点算完早点空闲）。
 *        用 credentialless 而不是 require-corp，这样 huggingface.co 上
 *        没有 CORP 头的模型文件也照样能下。
 * @returns {Promise<{port:number, origin:string, indexUrl:string, root:string, close:()=>Promise<void>}>}
 */
function createStaticServer(root, opt) {
  const o = opt || {};
  const overlay = o.overlay || null;
  const coi = o.coi !== false;
  const keepSW = !!o.keepServiceWorker;
  const host = o.host || '127.0.0.1';
  const wantPort = typeof o.port === 'number' ? o.port : 0; // 0 = 让系统给一个空闲端口

  const server = http.createServer((req, res) => {
    const send = (code, body, headers) => {
      const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
      if (coi) {
        h['Cross-Origin-Opener-Policy'] = 'same-origin';
        h['Cross-Origin-Embedder-Policy'] = 'credentialless';
        h['Cross-Origin-Resource-Policy'] = 'same-origin';
      }
      res.writeHead(code, h);
      if (req.method === 'HEAD') return res.end();
      res.end(body);
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(405, '只读服务，只接受 GET', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (!hostAllowed(req)) {
      return send(403, '仅限本机访问', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    // 用 WHATWG URL 解析（url.parse 已废弃），base 随便给一个合法的就行
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname || '/';
    } catch (_) {
      return send(400, '非法请求', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    if (!originAllowed(req, port)) {
      return send(403, '跨源访问被拒绝', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    if (pathname === '/' || pathname === '') pathname = '/index.html';

    // sw.js 换成注销用的替身（除非显式要求保留）
    if (!keepSW && (pathname === '/sw.js' || pathname === '/web/sw.js')) {
      return send(200, SW_STUB, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Service-Worker-Allowed': '/'
      });
    }

    const base = resolveSafe(root, pathname);
    if (!base) return send(400, '非法路径', { 'Content-Type': 'text/plain; charset=utf-8' });
    // 更新层优先。注意 resolveSafe 对两个根都做了穿越防护，
    // overlay 解析失败（比如 ../ ）就当没有，直接用内置那份。
    let file = base;
    if (overlay) {
      const over = resolveSafe(overlay, pathname);
      try { if (over && fs.statSync(over).isFile()) file = over; } catch (_) { /* 更新层没有就穿透 */ }
    }

    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        return send(404, '找不到：' + pathname, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        // 声明支持断点：<audio> 拖进度条、以及大模型文件的分段取用都要靠它
        'Accept-Ranges': 'bytes'
      };
      if (coi) {
        headers['Cross-Origin-Opener-Policy'] = 'same-origin';
        headers['Cross-Origin-Embedder-Policy'] = 'credentialless';
        headers['Cross-Origin-Resource-Policy'] = 'same-origin';
      }

      const rg = parseRange(req.headers.range, st.size);
      if (rg === 'invalid') {
        headers['Content-Range'] = 'bytes */' + st.size;
        res.writeHead(416, headers);
        return res.end();
      }

      const code = rg ? 206 : 200;
      const start = rg ? rg.start : 0;
      const end = rg ? rg.end : st.size - 1;          // end 是闭区间
      headers['Content-Length'] = String(st.size === 0 ? 0 : end - start + 1);
      if (rg) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;

      res.writeHead(code, headers);
      if (req.method === 'HEAD' || st.size === 0) return res.end();

      const rs = fs.createReadStream(file, { start: start, end: end });
      rs.on('error', () => { try { res.destroy(); } catch (_) {} });
      // 浏览器中途取消（切页面、播放器重开一个连接）时要把文件句柄放掉，
      // 否则 160MB 的模型文件反复请求会攒一堆 fd。
      res.on('close', () => { try { rs.destroy(); } catch (_) {} });
      rs.pipe(res);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(wantPort, host, () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      const origin = 'http://' + host + ':' + port;
      resolve({
        port: port,
        origin: origin,
        indexUrl: origin + '/index.html',
        root: path.resolve(root),
        // 先掐掉 keep-alive 连接，不然 server.close() 会一直等到它们自己超时（迁移时会卡住）
        close: () => new Promise(done => {
          try { server.closeAllConnections && server.closeAllConnections(); } catch (_) {}
          server.close(() => done());
        })
      });
    });
  });
}

module.exports = { createStaticServer, MIME, resolveSafe, parseRange };
