// VoiceCollector 本地启动器（Node 版，没装 Python 时用）—— 晗晗专属
const http = require('http'), fs = require('fs'), path = require('path'), { exec } = require('child_process');
const ROOT = path.join(__dirname, 'web');
const PORTS = [8787, 8788, 8799, 8080, 9123];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' ) p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});

(function listen(i) {
  if (i >= PORTS.length) { console.log('端口都被占用了'); return; }
  server.once('error', () => listen(i + 1));
  server.listen(PORTS[i], '127.0.0.1', () => {
    const url = `http://localhost:${PORTS[i]}/index.html`;
    console.log('='.repeat(58));
    console.log('  VoiceCollector · 晗晗专属课堂助手 已启动');
    console.log('  浏览器地址： ' + url);
    console.log('  关掉这个窗口 = 关掉程序（先在网页里结束录制！）');
    console.log('='.repeat(58));
    const cmd = process.platform === 'darwin' ? `open -a "Google Chrome" "${url}" || open "${url}"`
      : process.platform === 'win32' ? `start chrome "${url}" || start "" "${url}"` : `xdg-open "${url}"`;
    setTimeout(() => exec(cmd, () => {}), 700);
  });
})(0);
