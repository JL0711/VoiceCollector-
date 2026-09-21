# web/vendor —— 第三方运行时文件

这里的文件都是从 npm 包里原样复制出来的，**没有经过任何修改、重新打包或压缩**。
放在仓库里是为了让 `web/` 保持「无构建步骤、双击就能跑」，同时不依赖任何 CDN。

**我（whisper 子任务）复制进来的部分总体积：约 528 KB。**
目录里另外还有 ~68 MB 的 `.wasm` / `.jsep.*` 文件，不是我放的（见文末「目录里多出来的文件」）。

---

## transformers/transformers.web.min.js

| | |
|---|---|
| 来源包 | [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) |
| 版本 | **4.3.0** |
| 原始路径 | `node_modules/@huggingface/transformers/dist/transformers.web.min.js` |
| 体积 | 440 KB |
| 许可证 | Apache-2.0（全文见同目录 `LICENSE-transformers.txt`） |
| 版权 | Copyright 2023 The HuggingFace Inc. team |

这是 transformers.js 的浏览器版 ESM 打包产物，导出 `pipeline`、`env` 等。
`web/js/whisper.js` 用 `import()` 动态加载它 —— 不开本地识别就不会下载这 440 KB。

官方还提供 `transformers.min.js`（581 KB，同时含 node 分支）和未压缩的
`transformers.web.js`（1.1 MB）。我们只需要 web + 压缩版，所以只复制了一个文件。

---

## transformers/ort/*.mjs

| | |
|---|---|
| 来源包 | [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) |
| 版本 | **1.31.0-dev.20260914-8d85527a0**（由 `@huggingface/transformers@4.3.0` 锁定） |
| 原始路径 | `node_modules/onnxruntime-web/dist/` |
| 许可证 | MIT（Copyright (c) Microsoft Corporation，包里未附 LICENSE 文件，见 npm 页面的 `"license": "MIT"`） |

复制了两个 WASM 工厂脚本：

| 文件 | 体积 | 什么时候用 |
|---|---|---|
| `ort-wasm-simd-threaded.asyncify.mjs` | 46 KB | 默认。WebGPU 和普通 CPU 推理都走这个 |
| `ort-wasm-simd-threaded.mjs` | 24 KB | Safari 26 以下且没有 WebGPU 时的回退 |

选哪个变体的判断逻辑抄自 transformers 4.3.0 的 `src/backends/onnx.js`，
`web/js/whisper.js` 里的 `isSafariBelow26()` / `resolveOrtPaths()` 跟它保持一致。

`onnxruntime-web/dist/` 下还有 `ort.*.min.mjs` 一大堆文件，**一个都不需要** ——
transformers 的 web 打包产物已经把 ORT 的 JS 部分内联进去了，外部只差 WASM 工厂和 WASM 二进制。

---

## ORT 的 .wasm 二进制（可选，但强烈建议本地化）

| 文件 | 体积 | 说明 |
|---|---|---|
| `ort-wasm-simd-threaded.asyncify.wasm` | **26.8 MB** | 默认变体，WebGPU / CPU 都用它 |
| `ort-wasm-simd-threaded.wasm` | 14.2 MB | Safari 26 以下且无 WebGPU 时的回退 |

`web/js/whisper.js` 启动时会 HEAD 探测 `ort/` 下有没有这两个文件：

- **有** → `env.backends.onnx.wasm.wasmPaths` 指向本地，完全不联网。
- **没有** → 指向 jsDelivr 上锁定版本的同名文件。因为我们打开了 `env.useWasmCache`，
  取回来之后会存进浏览器 Cache Storage，第二次开课照样离线 —— 和模型权重同一套缓存。

没有的话可以这样补上（打 Electron 桌面版前务必跑一次）：

```bash
bash web/vendor/fetch-ort-wasm.sh
```

体积太大，**别直接 commit**，加进 `.gitignore` 或用 git-lfs：

```gitignore
web/vendor/transformers/ort/*.wasm
```

### ⚠️ 为什么必须显式设置 wasmPaths（踩过的坑）

transformers 4.3.0 的 `src/backends/onnx.js` 里有一段「自动填 jsDelivr 默认值」的代码，
条件是 `ONNX_ENV.versions?.web && !ONNX_ENV.wasm.wasmPaths`。

但在 `dist/transformers.web.min.js` 这个打包产物里，**`env.versions.web` 从来没有被赋值**
（在 bundle 里 grep `versions.web=` 是 0 个命中，只有两处读取）。也就是说那段默认逻辑
是死代码，`wasmPaths` 会一直是 `undefined`，ORT 转而按自己的 `import.meta.url` 去找文件 ——
解析到 `web/vendor/transformers/` 而不是它的 `ort/` 子目录，必然 404。

所以 `whisper.js` 里的 `resolveOrtPaths()` 总是显式写入 `wasmPaths`（本地或 CDN 二选一），
**不能删掉这段逻辑**。附带好处：`wasmPaths` 必须是同时含 `wasm` 和 `mjs` 两个键的对象，
才会触发 `env.useWasmCache` 的预加载缓存（见 `src/backends/utils/cacheWasm.js` 里的
`shouldUseWasmCache`），显式设置之后 WASM 缓存才真的生效。

---

## 目录里多出来的文件

`ort/` 下还有 `ort-wasm-simd-threaded.jsep.mjs` 和 `ort-wasm-simd-threaded.jsep.wasm`
（合计约 28 MB）。**whisper.js 用不到它们** —— jsep 是 ORT 1.23 之前 WebGPU 变体的旧名字，
1.31 里对应的是 `.asyncify`。如果不是别的地方在用，可以删掉省 28 MB。

---

## 模型权重

**不在这里**，也不该放进仓库。`onnx-community/whisper-*` 的权重第一次用时从
huggingface.co 下载，之后由浏览器 Cache Storage 缓存（cacheKey 默认
`transformers-cache`）。体积见 `web/js/whisper.js` 里的 `WHISPER_MODELS`，
从 139 MB（base）到 537 MB（large-v3-turbo）。

国内网络拉不动 huggingface.co 的话，在 `load()` 之前调一次：

```js
import { configureRuntime } from './whisper.js'
configureRuntime({ remoteHost: 'https://hf-mirror.com/' })  // 结尾的斜杠不能少
```

---

## 怎么升级这些文件

```bash
npm i @huggingface/transformers@<新版本>
cp node_modules/@huggingface/transformers/dist/transformers.web.min.js web/vendor/transformers/
cp node_modules/@huggingface/transformers/LICENSE                      web/vendor/transformers/LICENSE-transformers.txt
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs web/vendor/transformers/ort/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs          web/vendor/transformers/ort/
```

升级后必须重新确认两件事（它们在 4.x 里改过好几次）：

1. `src/backends/onnx.js` 里默认 wasm 变体的后缀还是不是 `.asyncify`；
2. `src/models/session.js` 里 `selectDtype(dtype, fileName, ...)` 的 key 还是不是
   ONNX 文件名（`encoder_model` / `decoder_model_merged`）。

`web/js/whisper.js` 依赖这两点。
