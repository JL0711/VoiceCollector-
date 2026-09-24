// 更新：只换「网页层」，不碰 App 本体
//
// 为什么不是 electron-updater / Squirrel：
//   那套在 macOS 上要求 App 有正规的 Developer ID 签名，会校验新旧签名是否同源。
//   我们的包是 adhoc 签名（没有 Apple 开发者账号），Squirrel 会直接报
//   "Could not get code signature for running application" 然后什么都不做。
//
// 这条路反而更合适：
//   · 真正会改的只有 web/js、web/css、index.html，加起来约 1MB；
//     vendor/（67MB transformers）和 models/（662MB Whisper 权重）几乎不变。
//   · 更新包下载 1MB 而不是 614MB，教室 WiFi 也能秒下。
//   · 完全不写 /Applications，不需要管理员密码，不需要签名。
//   · 装在 userData 里，卸载 App 就一起没了，不留垃圾。
//
// 落地方式：解压到 userData/web-update/<版本>/，交给 lib/server.js 当 overlay
// （优先读它，没有的文件穿透回 App 内置的 web/）。
//
// ⚠️ 自愈：每次用新版本启动前先写一个 .pending 标记，界面 init() 成功后才删掉。
//    启动时发现 .pending 还在 → 说明上一次用这个版本没能正常起来 → 自动退回内置版。
//    （这条是有来由的：2026-09-21 我发过一个一点「开始录制」就炸的包。）

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

const DIR_NAME = 'web-update';
const PENDING = '.pending';
const MAX_BYTES = 64 * 1024 * 1024;   // 网页层不可能有这么大，超了一定是拿错文件了

/* ───────────────────────── 版本号 ───────────────────────── */

function parseVer(v) {
  return String(v || '0').split('.').map(x => parseInt(x, 10) || 0);
}
/** a 比 b 新返回 >0 */
function cmpVer(a, b) {
  const x = parseVer(a), y = parseVer(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

function readManifest(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
    if (j && typeof j.version === 'string') return j;
  } catch (_) {}
  return null;
}

/* ───────────────────────── 当前装着的更新层 ───────────────────────── */

function rootDir(userData) { return path.join(userData, DIR_NAME); }

/**
 * 找出当前该用的更新层。顺带做自愈：
 * 上一次带着 .pending 启动却没能确认成功的版本，直接删掉。
 * @returns {{dir:string, version:string, notes:string[]}|null}
 */
function activeOverlay(userData, bundledVersion) {
  const root = rootDir(userData);
  let names = [];
  try { names = fs.readdirSync(root); } catch (_) { return null; }

  const good = [];
  for (const name of names) {
    const dir = path.join(root, name);
    let st = null;
    try { st = fs.statSync(dir); } catch (_) { continue; }
    if (!st.isDirectory()) continue;

    // 上次没起来 → 这个版本有问题，删掉，退回内置版
    if (fs.existsSync(path.join(dir, PENDING))) {
      console.log('[更新] ' + name + ' 上次没能正常启动，已丢弃，回到内置版本');
      rmrf(dir);
      continue;
    }
    const m = readManifest(dir);
    if (!m || !fs.existsSync(path.join(dir, 'index.html'))) { rmrf(dir); continue; }
    // 内置版反超了（用户装了更新的完整包）→ 更新层没用了
    if (cmpVer(m.version, bundledVersion) <= 0) { rmrf(dir); continue; }
    good.push({ dir, version: m.version, notes: Array.isArray(m.notes) ? m.notes : [] });
  }
  if (!good.length) return null;
  good.sort((a, b) => cmpVer(b.version, a.version));
  // 只留最新的一个，旧的清掉，别在她硬盘上堆东西
  for (let i = 1; i < good.length; i++) rmrf(good[i].dir);
  return good[0];
}

/** 标记「正在试这个版本」。界面 init() 成功后调 confirmBoot 删掉。 */
function markPending(overlayDir) {
  try { fs.writeFileSync(path.join(overlayDir, PENDING), String(Date.now())); } catch (_) {}
}
function confirmBoot(overlayDir) {
  try { fs.unlinkSync(path.join(overlayDir, PENDING)); return true; } catch (_) { return false; }
}

/** 手动退回内置版本（设置里给一个「出问题了，退回上一版」的出口） */
function revert(userData) {
  rmrf(rootDir(userData));
  return true;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

/* ───────────────────────── 查新版本 ───────────────────────── */

// 测试时可以用 VC_UPDATE_API 指到本地的假 GitHub（http://127.0.0.1:xxxx），正式版不设就是 api.github.com
const mod = url => (String(url).startsWith('http://') ? http : https);

function getJSON(url, redirects) {
  return new Promise((resolve, reject) => {
    const req = mod(url).get(url, {
      headers: { 'User-Agent': 'VoiceCollector', 'Accept': 'application/vnd.github+json' },
      timeout: 15000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 5) {
        res.resume();
        return resolve(getJSON(res.headers.location, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('GitHub 返回 ' + res.statusCode));
      }
      let b = '';
      res.setEncoding('utf8');
      res.on('data', d => { b += d; if (b.length > 4e6) { req.destroy(); reject(new Error('响应过大')); } });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('返回的不是 JSON')); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('连接超时')); });
    req.on('error', reject);
  });
}

/**
 * 去 GitHub Releases 看有没有更新的网页层。
 * 约定：Release 里带一个名为 web-<版本>.zip 的附件，
 *       正文里写一行 `sha256: <64位十六进制>` 作为完整性校验。
 * @returns {Promise<{available:boolean, version?:string, notes?:string[], url?:string, size?:number, sha256?:string, reason?:string, full?:boolean, pageUrl?:string}>}
 */
async function check({ owner, repo, currentVersion, shellVersion }) {
  const base = process.env.VC_UPDATE_API || 'https://api.github.com';
  const api = `${base}/repos/${owner}/${repo}/releases/latest`;
  const rel = await getJSON(api);
  if (!rel || rel.draft) return { available: false, reason: '还没有正式发布的版本' };

  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const web = assets.find(a => /^web-.*\.zip$/i.test(a.name || ''));
  const tag = String(rel.tag_name || '').replace(/^v/i, '');
  if (!web) {
    return { available: false, reason: '这个版本没有网页层更新包', pageUrl: rel.html_url };
  }
  const ver = (/^web-(.+)\.zip$/i.exec(web.name) || [])[1] || tag;
  if (cmpVer(ver, currentVersion) <= 0) {
    return { available: false, reason: '已经是最新版（' + currentVersion + '）' };
  }

  const body = String(rel.body || '');
  const sha = (/sha256:\s*([0-9a-f]{64})/i.exec(body) || [])[1] || '';
  // 更新包声明它需要的最低外壳版本，外壳太旧就别装，改叫用户下完整包
  const need = (/minShell:\s*([0-9.]+)/i.exec(body) || [])[1] || '';
  if (need && cmpVer(need, shellVersion) > 0) {
    return { available: true, full: true, version: ver, pageUrl: rel.html_url,
             notes: bodyNotes(body),
             reason: '这次更新需要新的程序本体（当前 ' + shellVersion + '，需要 ' + need + '），要下载完整安装包' };
  }
  if (web.size > MAX_BYTES) return { available: false, reason: '更新包异常地大，没敢下' };

  return {
    available: true, full: false, version: ver, notes: bodyNotes(body),
    url: web.browser_download_url, size: web.size, sha256: sha, pageUrl: rel.html_url
  };
}

function bodyNotes(body) {
  return String(body || '')
    .split('\n')
    .map(l => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter(l => l && !/^sha256:/i.test(l) && !/^minShell:/i.test(l))
    .slice(0, 12);
}

/* ───────────────────────── 下载并安装 ───────────────────────── */

function download(url, dest, onProgress, redirects) {
  return new Promise((resolve, reject) => {
    const req = mod(url).get(url, { headers: { 'User-Agent': 'VoiceCollector' }, timeout: 20000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 5) {
        res.resume();
        return resolve(download(res.headers.location, dest, onProgress, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载失败 ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      if (total > MAX_BYTES) { req.destroy(); return reject(new Error('更新包异常地大')); }
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(dest);
      let got = 0;
      res.on('data', d => {
        got += d.length;
        if (got > MAX_BYTES) { req.destroy(); out.destroy(); return reject(new Error('更新包异常地大')); }
        hash.update(d);
        if (onProgress && total) onProgress(got / total);
      });
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => resolve({ sha256: hash.digest('hex'), bytes: got }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
    req.on('error', reject);
  });
}

// macOS 和 Win10+ 自带的 tar 都能解 zip（bsdtar / libarchive），不用引第三方依赖
function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', zipPath, '-C', destDir], { timeout: 120000 }, err => {
      if (err) return reject(new Error('解压失败：' + err.message));
      resolve();
    });
  });
}

/**
 * 下载 → 校验 → 解压 → 原子换上。全程不碰 /Applications。
 * @returns {Promise<{ok:boolean, version:string, dir:string}>}
 */
async function install(info, userData, onProgress) {
  if (!info || !info.url) throw new Error('没有可安装的更新包');
  const root = rootDir(userData);
  fs.mkdirSync(root, { recursive: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-upd-'));
  const zip = path.join(tmp, 'web.zip');
  try {
    const got = await download(info.url, zip, onProgress);
    if (info.sha256 && got.sha256 !== info.sha256) {
      throw new Error('校验不通过（文件可能在传输中损坏），没有安装');
    }

    const stage = path.join(tmp, 'stage');
    fs.mkdirSync(stage);
    await unzip(zip, stage);

    // 有的打包工具会多套一层目录，自动钻进去
    let src = stage;
    if (!fs.existsSync(path.join(src, 'index.html'))) {
      const kids = fs.readdirSync(src).filter(n => {
        try { return fs.statSync(path.join(src, n)).isDirectory(); } catch (_) { return false; }
      });
      if (kids.length === 1 && fs.existsSync(path.join(src, kids[0], 'index.html'))) src = path.join(src, kids[0]);
    }

    // 装之前先验一遍：没有 index.html 或 version.json 对不上，就不装
    const m = readManifest(src);
    if (!m) throw new Error('更新包里没有 version.json');
    if (!fs.existsSync(path.join(src, 'index.html'))) throw new Error('更新包里没有 index.html');
    if (cmpVer(m.version, info.version) !== 0) {
      throw new Error('更新包版本对不上（说是 ' + info.version + '，里面写的是 ' + m.version + '）');
    }

    const finalDir = path.join(root, m.version);
    rmrf(finalDir);
    fs.renameSync(src, finalDir);          // 同一个卷内，rename 是原子的
    markPending(finalDir);                 // 下次启动要是没起来，会自动丢弃
    return { ok: true, version: m.version, dir: finalDir };
  } finally {
    rmrf(tmp);
  }
}

module.exports = {
  cmpVer, readManifest, activeOverlay, markPending, confirmBoot, revert,
  check, install, rootDir
};
