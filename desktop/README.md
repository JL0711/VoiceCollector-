# VoiceCollector 桌面版（macOS / Windows）

把 `web/` 里那个纯网页版，用 Electron 包成一个真正的桌面 App。
网页代码一行都没改 —— 桌面版只是给它换了一个更好的运行环境：

- 麦克风权限是**系统级**的，授权一次永久有效，不会像浏览器那样每次问、切标签页就断
- 录制时**不让电脑休眠**，停止录制立刻放开（省电）
- 关窗前会问一句「还在录制，确定退出？」
- 本地 Whisper 识别跑在**跨源隔离**环境里，多线程 WASM 能跑满 CPU，识别更快
- 有原生的中文菜单，Cmd+C / Cmd+V 正常工作

---

## 一、开发时怎么跑

```bash
cd desktop
npm install        # 第一次要下 Electron，大概 100MB，慢一点正常
npm start          # 直接打开 App
```

改了 `web/` 里的任何文件，在 App 里按 **Cmd+R**（菜单：文件 → 重新加载界面）就能看到效果，
不用重启 App，也不用重新打包。

其他命令：

| 命令 | 作用 |
| --- | --- |
| `npm start` | 正常启动 |
| `npm run dev` | 启动并自动打开开发者工具 |
| `npm run smoke` | 自检：启动 → 等 3 秒 → 把窗口标题/URL/接口状态打到终端 → 自动退出 |
| `npm run sync` | 把 `../web` 同步成 `desktop/app-web`（打包前会自动跑） |
| `npm run dist:mac` | 打 macOS 的 .dmg + .zip |
| `npm run dist:win` | 打 Windows 的安装包 |
| `npm run dist:dir` | 只解包不压缩，用来快速验证打包配置 |

`npm run smoke` 正常的输出长这样（`"ok": true` 就是通过）：

```
[web 目录] dev → /.../VoiceCollector-/web
[本地服务] http://127.0.0.1:53695/index.html
[麦克风] 系统授权：已允许
===VC_SMOKE_BEGIN===
{ "ok": true, "probe": { "crossOriginIsolated": true, "hasVCDesktop": true, ... } }
===VC_SMOKE_END===
```

---

## 二、打包成 .dmg

```bash
cd desktop
npm run dist:mac
```

产物在 **`desktop/dist/`**：

```
desktop/dist/
├─ VoiceCollector-1.0.0-arm64.dmg     ← Apple 芯片（M1/M2/M3/M4）装这个
├─ VoiceCollector-1.0.0.dmg           ← Intel 芯片的 Mac 装这个
├─ VoiceCollector-1.0.0-arm64-mac.zip ← 免安装版
├─ VoiceCollector-1.0.0-mac.zip
├─ mac-arm64/VoiceCollector.app       ← 没压缩的 App，可以直接双击试
└─ mac/VoiceCollector.app
```

Windows 版：`npm run dist:win` → `desktop/dist/VoiceCollector Setup 1.0.0.exe`。
注意 Windows 包必须在 Windows 上打（或者用 CI），在 Mac 上打 Windows 包会缺东西。

> **包会比较大。** 如果 `web/models/` 里放了随包分发的 Whisper / 翻译模型，
> 整个 App 会到 400MB 以上（模型本身就 160MB）。这是正常的 —— 换来的是
> 装完就能离线识别，不用第一次上课时现场等下载。
> 不想随包分发就把 `web/models/` 清空，让 App 第一次用的时候自己去 huggingface.co 下。

---

## 三、macOS 第一次打开被拦住怎么办

这个 App 没有 Apple 开发者签名（一年 99 美元，个人自用没必要），
所以 macOS 会拦一下。这不是病毒警告，是「没交钱买证书」的警告。

**方法 1（最简单）**：在「应用程序」里找到 VoiceCollector，
**按住 Control 键点它 → 选「打开」→ 弹窗里再点一次「打开」**。
只需要做这一次，以后双击就能开。

**方法 2（如果提示「已损坏，无法打开」）**：打开「终端」，粘贴这两行：

```bash
xattr -cr /Applications/VoiceCollector.app
codesign --force --deep --sign - /Applications/VoiceCollector.app
```

第一行是去掉「从网上下载」的隔离标记，第二行是本地临时签名
（Apple 芯片的 Mac 要求 App 至少有个签名才肯跑）。

**方法 3**：系统设置 → 隐私与安全性 → 往下滑，会看到
「已阻止 VoiceCollector」→ 点「仍要打开」。

### 麦克风没声音 / 音量表一直是 0

系统设置 → 隐私与安全性 → **麦克风** → 把 VoiceCollector 的开关打开，
然后**完全退出 App 再重开**（macOS 的权限要重启进程才生效）。

App 菜单里也有快捷入口：**VoiceCollector → 麦克风权限设置…**

---

## 四、⚠️ 为什么桌面版必须用 Whisper，不能用浏览器实时识别

这是桌面版和网页版**唯一**的功能差别，务必搞清楚。

网页版用的是 **Web Speech API**（`webkitSpeechRecognition`）。
这个 API 在 Chrome 里能用，不是因为 Chrome 自己会识别语音 ——
它是把麦克风音频**发到 Google 的语音服务器**上去识别，再把文字传回来。
调用这个服务需要一把 Google 的 API 密钥，而这把密钥是
**Google 只发给官方 Chrome 构建的**。

Electron 内置的 Chromium 是开源构建，**拿不到这把密钥**。
所以在桌面版里：

```js
new webkitSpeechRecognition()   // 对象能创建出来
recognition.start()             // 也不报错
// 然后 …… 永远不会触发 onresult，几秒后静默失败
```

这不是 bug，也不是配置问题，**没有任何办法绕过**
（除非自己去申请 Google Cloud Speech 的密钥并改用它的收费 REST 接口）。

所以桌面版的识别只能走这两条路，两条都在设置页里能选：

| 引擎 | 怎么跑 | 适合 |
| --- | --- | --- |
| **本地 Whisper** | 模型跑在你自己电脑上（WebGPU / 多线程 WASM），完全离线 | 日常上课，不花钱，隐私最好 |
| **云端转写**（OpenAI Whisper API 等） | 把分段音频传到云端识别 | 追求最高准确率、网速好的时候 |

**第一次打开 App，请先去「设置」把识别引擎切到 Whisper。**
主协调者会在 `app.js` 里检测 `window.VCDesktop`，在桌面版自动隐藏
「浏览器实时识别」这个选项并默认切到 Whisper —— 如果你看到它还在，说明那部分还没接上。

---

## 五、大教室 / 50 米 / 老师用扩音喇叭

这是这个项目的核心场景，几点务必注意（这些开关在网页版的「设置」里）：

1. **打开「远场模式」。** 它会关掉浏览器默认的回声消除和自动增益，
   因为那套算法是给「嘴离麦克风 20 厘米的视频会议」调的，
   用在「声音从 30 米外的喇叭传过来」的场景里，会把老师的声音当成噪声压掉。
2. **用 Whisper，别用云端逐句流式。** Whisper 是整段一起看的，
   有上下文，对混响和背景噪声的鲁棒性比逐字流式识别强很多。
3. **能插耳机/外接麦就插。** 笔记本内置麦克风在阶梯教室后排基本是极限。
   一个 200 块的领夹麦或指向性 USB 麦，效果提升比换任何软件都大。
4. **录音备份一定开着。** 就算实时识别当场没识别好，
   课后还能拿完整录音重新跑一遍 Whisper（而且可以用更大的模型）。

---

## 六、省电设计

需求里说「能降低电脑能耗就降低」，桌面版是这么做的：

| 做法 | 效果 |
| --- | --- |
| 只在**录制时**调 `powerSaveBlocker`，用 `prevent-app-suspension` 而不是 `prevent-display-sleep` | 系统不休眠，但**屏幕照常关**。录 90 分钟的课，这一条就省一大截 |
| 停止录制立刻 `stop()` | 不会出现「录完课电脑一整天不睡觉」 |
| 后台降频（`backgroundThrottling`）平时开着，只在录制时关 | 不录课的时候，App 切到后台几乎不吃 CPU |
| 关掉拼写检查（`spellcheck: false`） | 少一个常驻词典进程 |
| 所有窗口关掉就退出进程（不像普通 mac App 留在 Dock 里） | 不留后台空耗 |
| **保留** GPU 硬件加速（故意不调 `disableHardwareAcceleration`） | Whisper 走 WebGPU 比纯 CPU 快好几倍，早算完早空闲，总耗电反而更低 |
| 本地 HTTP 服务发 `COOP/COEP` 头，开启跨源隔离 | Whisper 的多线程 WASM 才能用 `SharedArrayBuffer` 跑满多核，同样省的是「总时长」 |

---

## 七、网页能调用的桌面接口：`window.VCDesktop`

`preload.js` 通过 `contextBridge` 只暴露这几个方法（页面永远拿不到 Node）：

```js
window.VCDesktop = {
  isDesktop: true,          // 恒为 true，用来判断「我在桌面版里」
  platform: 'darwin',       // 'darwin' | 'win32' | 'linux'
  version: '1.0.0',         // desktop/package.json 里的版本号

  // 录制开始时 true，停止时 false。阻止系统休眠 + 关掉后台降频。
  setPreventSleep(on): Promise<boolean>,

  // 用系统默认浏览器打开链接（只放行 http / https）
  openExternal(url): Promise<boolean>,

  // 导出文件。传了 data 就由主进程直接写盘；不传就只返回用户选的路径。
  // data 支持 string / ArrayBuffer / Uint8Array / Blob
  showSaveDialog(name, mimetype, data?):
    Promise<{ ok, canceled, path, written?, bytes?, error? }>,

  // 退出前询问。返回取消注册的函数。
  // 回调返回 true/undefined = 可以退出；false 或一句话 = 弹确认框
  onBeforeQuit(cb): () => void,

  // 附赠的小工具，不用也行
  info(): Promise<object>,            // 主进程运行信息，调试用
  showInFolder(path): Promise<true>   // 在访达里显示某个文件
}
```

典型用法（写在 `web/js/app.js` 里）：

```js
const D = window.VCDesktop

// 开始录制
if (D) D.setPreventSleep(true)
// 停止录制
if (D) D.setPreventSleep(false)

// 退出确认
if (D) D.onBeforeQuit(() => isRecording ? '课堂正在录制中，还没保存。' : true)

// 导出（替代 util.js 的 download()）
if (D) {
  const r = await D.showSaveDialog('2026-03-05 微观经济学.md', 'text/markdown', mdText)
  if (r.ok) D.showInFolder(r.path)
}
```

> 就算 `app.js` 完全不调这些方法，桌面版也能正常跑 ——
> 原来用 `<a download>` 的导出会被主进程接管，照样弹保存框；
> 退出时页面没注册回调，1.5 秒后自动按「可以退出」处理。

---

## 八、目录结构 / 打包方案说明

```
desktop/
├─ package.json                 依赖 + electron-builder 的 build 配置
├─ main.js                      主进程：本地服务、权限、菜单、省电、退出确认
├─ preload.js                   contextBridge → window.VCDesktop
├─ lib/
│  ├─ server.js                 127.0.0.1 静态服务（纯 node，可单独测）
│  ├─ window-state.js           窗口尺寸记忆
│  └─ menu.js                   中文菜单
├─ scripts/
│  └─ sync-web.js               打包前把 ../web 复制成 desktop/app-web
├─ build/
│  ├─ icon.png                  由 sync-web.js 从 web/icons/icon-512.png 生成
│  └─ entitlements.mac.plist    签名时用的权限声明（含麦克风）
├─ app-web/                     ← 生成物，已 gitignore
└─ dist/                        ← 打包产物，已 gitignore
```

### 为什么一定要起本地 HTTP 服务，不用 `file://`

直接 `loadFile('../web/index.html')` 会同时踩三个坑：

1. `<script type="module">` 在 `file://` 下被 CORS 规则拒绝 —— `app.js` 整个加载不起来；
2. `file://` 的 origin 是 `null`，`getUserMedia()` 拿不到麦克风；
3. IndexedDB / ServiceWorker 在 null origin 下行为不可靠，资料库可能丢。

所以主进程先在 `127.0.0.1` 上起一个**只读**的小 HTTP 服务（端口自动挑空闲的，
不写死 8080 免得撞车），再 `loadURL('http://127.0.0.1:端口/index.html')`。
这个服务只接受 GET、只认 `127.0.0.1` 的 Host、带 Origin 的跨源请求一律 403、
挡住 `../` 路径穿越 —— 别的本地程序扫到这个端口也读不到东西。

### 为什么要复制 `web/` 而不是 `extraResources`

`electron-builder` 的 `files` 字段只认**项目目录（`desktop/`）以内**的路径，
写 `"../web/**/*"` 它会当成 app 目录下的 `web` 再往上跳，结果什么都打不进去。

所以 `npm run dist` 会先跑 `scripts/sync-web.js`，把 `../web` 复制成
`desktop/app-web/`，`files` 里就是普通的 `"app-web/**/*"`，全部塞进 `app.asar`。
`main.js` 启动时自动判断：

- `../web/index.html` 存在 → **dev 模式**，直接读源目录（改完刷新就生效）
- 否则读 `__dirname/app-web` → **打包模式**（Electron 给 `fs` 打过补丁，读 asar 内的文件和读普通文件一样）

`sync-web.js` 会跳过 `.part` / `.crdownload` 这类没下完的模型分片，
免得把半个模型打进包里。

### 图标

`sync-web.js` 会把 `web/icons/icon-512.png` 复制成 `build/icon.png`，
`electron-builder` 自动转成 macOS 的 `.icns` 和 Windows 的 `.ico`，不用手工生成。

想要更清晰的图标（Retina 下 512 是下限，1024 更好），可以自己做一个 `.icns`：

```bash
mkdir icon.iconset
sips -z 16 16     icon-1024.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon-1024.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon-1024.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon-1024.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon-1024.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon-1024.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon-1024.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 icon-1024.png --out icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o build/icon.icns
```

然后把 `package.json` 里 `build.mac.icon` 改成 `"build/icon.icns"`。

### Service Worker

桌面版会把 `/sw.js` 换成一个「自我注销」的空壳。
原因：所有静态文件本来就在本机（asar 里），离线缓存没有任何收益；
反而升级 App 之后旧 SW 会继续吐出旧版本的 `app.js`，造成「改了没生效」的灵异问题。
真要保留原版 SW，启动时加环境变量 `VC_KEEP_SW=1`。

### 可调的环境变量

| 变量 | 作用 |
| --- | --- |
| `VC_NO_COI=1` | 关掉 COOP/COEP 跨源隔离。只有在怀疑某个跨域资源被它挡住时才用 —— 关了之后 Whisper 多线程会退化成单线程，慢很多 |
| `VC_KEEP_SW=1` | 保留网页版原来的 Service Worker |

---

## 九、代码签名与公证（可选，个人自用不用管）

如果以后想分发给别人、不想让他们右键打开：

1. 交 99 美元加入 Apple Developer Program，拿到 **Developer ID Application** 证书；
2. `package.json` 里把 `build.mac.hardenedRuntime` 改成 `true`
   （`build/entitlements.mac.plist` 已经写好了，含麦克风和 JIT 权限）；
3. 设环境变量后打包：

```bash
export APPLE_ID="你的开发者账号"
export APPLE_APP_SPECIFIC_PASSWORD="应用专用密码"
export APPLE_TEAM_ID="你的 Team ID"
npm run dist:mac
```

`electron-builder` 会自动签名并送去公证。
