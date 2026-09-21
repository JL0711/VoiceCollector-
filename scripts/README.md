# 离线模型下载脚本

这个目录里只有一个脚本：`fetch-models.mjs`。它负责把 AI 模型**提前下载到本地**，
打包进软件里，让晗晗拿到 App 之后：

- **不用注册任何账号**
- **不用申请任何 API Key**
- **不用联网**（第一次装好之后，飞机上、地下室、教学楼信号死角都能用）

整条链路 —— 录音 → 语音识别 → 翻译成中文 → 生成中文课堂笔记 —— 全部在本机跑完。

> 脚本**零依赖**，只用 Node 自带的 `fs / https / http / path / url`。
> 不需要 `npm install`，有 Node 18+ 就能跑。

---

## 一、快速上手

```bash
# 看看有哪些模型（不联网，秒出）
node scripts/fetch-models.mjs --list

# 下载推荐套餐（Whisper Base + 英中翻译，约 193 MB）
node scripts/fetch-models.mjs --profile default

# 网络不好，或者人在中国大陆（huggingface.co 访问不了）：加镜像
node scripts/fetch-models.mjs --profile default --mirror hf-mirror.com
```

下载好的文件会放在 `web/models/` 下面，目录结构长这样：

```
web/models/
├── .gitignore
├── onnx-community/
│   └── whisper-base/
│       ├── config.json
│       ├── generation_config.json
│       ├── preprocessor_config.json
│       ├── tokenizer.json
│       ├── tokenizer_config.json
│       └── onnx/
│           ├── encoder_model_quantized.onnx
│           └── decoder_model_merged_quantized.onnx
└── Xenova/
    └── opus-mt-en-zh/
        ├── config.json
        ├── tokenizer.json
        └── onnx/
            ├── encoder_model_quantized.onnx
            └── decoder_model_merged_quantized.onnx
```

这个结构不是随便摆的，是 transformers.js 期望的格式。前端只要这样配：

```js
import { env } from '../vendor/transformers/transformers.js';

env.allowRemoteModels = false;   // 关键：禁止联网抓模型
env.localModelPath   = './models/';  // 相对 web/ 的路径

// 之后照常用模型 id，它会去 ./models/onnx-community/whisper-base/ 读
await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', { dtype: 'q8' });
```

---

## 二、有哪些模型

### 语音识别（ASR）

| 名字 | HF 仓库 | 参数量 | q8 体积 | 什么时候用 |
|---|---|---|---|---|
| `whisper-tiny` | `onnx-community/whisper-tiny` | 39M | **41.7 MB** | 老电脑应急，或只想先验证链路通不通。远场、口音、专业术语容易错。 |
| `whisper-base` | `onnx-community/whisper-base` | 74M | **76.1 MB** | **推荐默认。** 体积和准确率的平衡点，日常课堂够用。 |
| `whisper-small` | `onnx-community/whisper-small` | 244M | **240.3 MB** | 追求识别质量。远场、口音重、术语多的课提升最明显。需要 WebGPU，纯 CPU 会跟不上实时。 |
| `whisper-large-v3-turbo` | `onnx-community/whisper-large-v3-turbo` | 809M | **537 MB** (q4f16) | 最准的一档，`web/js/whisper.js` 里的「最准」就是它。必须有独显或 M 系列芯片。显卡不支持 fp16 或只能用 CPU 时要改下 q4（724 MB）：`-m whisper-large-v3-turbo --dtype q4`。 |

**关于「50 米外老师用扩音器」这个需求**：光换大模型是不够的，真正决定成败的是
`web/js/audio.js` 里的前端音频处理（增益、降噪、VAD）。模型大小的影响是二阶的。
建议的组合是：`whisper-base` 起步，如果机器有 WebGPU 且用户觉得识别不准，
再引导他下 `whisper-small`。

**质量大致排序**（英文授课，远场）：
`whisper-large-v3-turbo` > `whisper-small` > `whisper-base` >> `whisper-tiny` >> 浏览器自带的 Web Speech API。

> **和前端的对应关系**：`web/js/whisper.js` 的 `WHISPER_MODELS` 里列了三档
> （`whisper-base` / `whisper-small` / `whisper-large-v3-turbo`）。
> **前端能选的每一档，这个脚本都必须能下到本地**，否则用户在 UI 里选了「最准」，
> 要么加载失败，要么偷偷跑去 huggingface.co 拉 —— 那就违背「不依赖网站」这条底线了。
> 前端加了新档位，记得回来往 `MODELS` 里补一条。

### 翻译（MT）

| 名字 | HF 仓库 | q8 体积 | 说明 |
|---|---|---|---|
| `opus-mt-en-zh` | `Xenova/opus-mt-en-zh` | **117.2 MB** | Helsinki-NLP 的英→中翻译模型。句子级翻译质量稳定，完全离线。 |

这是「不填 API Key 也能翻译」的兜底方案。质量上：

- 云端大模型（要 API Key）> Chrome 内置 Translator（要 Chrome 且要下语言包）> **OPUS-MT（本文的离线方案）** > 不翻译
- OPUS-MT 的特点是**稳**：句子结构规整的学术英语翻得不错；口语化、跳跃的内容会生硬一些。
- 实测样例：
  - `Today we will discuss the second law of thermodynamics.`
    → `今天我们将讨论热力学的第二定律`
  - `Please remember the deadline for the final essay is next Friday.`
    → `请记住最后论文的截止时间是下周五。`

### 课堂笔记总结

**不需要额外下模型。** `web/js/notes.js` 的中文笔记是基于已经识别+翻译好的文本做
抽取式总结（分段、抽关键句、提取术语和待办），不跑第二个神经网络。
这样既省几百 MB，也省内存 —— 录音的时候 Whisper 已经很吃资源了。
如果用户愿意填 API Key，`ai.js` 会自动升级成大模型生成式总结，但那是锦上添花，不是底线。

---

## 三、量化精度（`--dtype`）怎么选

同一个模型有好几个精度版本，文件名后缀不同（这是 transformers.js 的约定，
对应 `src/utils/dtypes.js` 里的 `DEFAULT_DTYPE_SUFFIX_MAPPING`）：

| dtype | 文件名后缀 | 说明 |
|---|---|---|
| `q8` | `_quantized` | **默认。** 8 位量化，体积最小，CPU(WASM) 后端的默认选择。 |
| `q4` | `_q4` | 4 位量化。注意：**不一定比 q8 小**，Whisper 的 decoder q4 反而比 q8 大。 |
| `fp16` | `_fp16` | 半精度。WebGPU 后端跑得最顺，但体积是 q8 的两倍左右。 |
| `fp32` | （无后缀） | 原始精度。体积最大，一般没必要。 |

**建议**：打包就打 `q8`。它在 WASM 和 WebGPU 上都能跑，体积最小。
只有当确认目标机器有 WebGPU、而且用户抱怨速度时，才考虑额外提供 `fp16`。

想一次下多个精度：`--dtype q8,fp16`。

各精度实测体积（含配置和分词器文件，2026-09 从 HF API 取的真实字节数）：

| 模型 | q8 | q4 | fp16 | fp32 |
|---|---|---|---|---|
| whisper-tiny | 41.7 MB | 94.0 MB | 75.3 MB | 147.2 MB |
| whisper-base | 76.1 MB | 138.5 MB | 142.0 MB | 280.2 MB |
| whisper-small | 240.3 MB | 288.2 MB | 465.4 MB | 926.0 MB |
| opus-mt-en-zh | 117.2 MB | 292.7 MB | 222.4 MB | 434.4 MB |

---

## 四、预设套餐（`--profile`）

| 套餐 | 内容 | 总体积 (q8) | 适合 |
|---|---|---|---|
| `min` | whisper-tiny + opus-mt-en-zh | **158.8 MB** | 安装包要小；老电脑；只要能跑 |
| `default` | whisper-base + opus-mt-en-zh | **193.2 MB** | **推荐**，日常上课这套就够 |
| `full` | whisper-small + opus-mt-en-zh | **357.4 MB** | 识别质量优先，机器较新 |
| `max` | whisper-large-v3-turbo(q4f16) + opus-mt-en-zh | **≈654 MB** | 大阶梯教室 + 扩音器，且确定机器有 WebGPU |

### 「只打包 base」还是「全都打包」？

**推荐：只打包 `default` 套餐（193 MB）。** 理由：

- 加上 Electron 运行时（约 200 MB）和 transformers.js + ort wasm（约 50 MB），
  `default` 方案的安装包落在 **400～450 MB** 量级。这个大小用户还能接受，
  下载一次 10 分钟以内。
- 换成 `full`，安装包直接涨到 **570～620 MB**。对一个留学生用的小工具来说太重了，
  而且 whisper-small 在没有 WebGPU 的机器上根本跑不动实时，白白多背 160 MB。
- 大模型可以**后补**：App 里放一个「提升识别精度」的按钮，点了之后在后台跑同一个脚本
  去下 whisper-small。下不到也不影响用 —— base 一直在那。

**什么时候该选 `full`**：确定目标机器是近几年的 Mac 或带独显的 Windows（有 WebGPU），
而且课程内容术语密集、老师口音重。这种情况识别质量的收益值那 160 MB。

**什么时候该选 `min`**：给一台很老的电脑做应急版，或者只是想先把整条链路跑通看看效果。

---

## 五、全部参数

```
常用
  --list, -l              列出所有可下载的模型（不联网）
  --model, -m <名字>      下载指定模型，可重复或用逗号分隔
                          例：-m whisper-base -m opus-mt-en-zh
  --profile <名字>        按预设套餐下载：min / default / full / max
  --all, -a               下载全部模型（很大，看清体积再用）

网络
  --mirror <站点>         用国内镜像，例：--mirror hf-mirror.com
                          也可以用环境变量 HF_ENDPOINT=https://hf-mirror.com
  --retries <次数>        单个文件失败重试次数，默认 3
  --concurrency, -c <N>   同时下载几个文件，默认 4

其它
  --dtype, -d <类型>      量化精度：q8(默认) / q4 / fp16 / fp32，可写多个
  --out, -o <目录>        输出目录，默认 web/models
  --configs-only          只下载小的配置和分词器文件，跳过 onnx 权重
  --force, -f             忽略已有文件，全部重新下载
  --dry-run, -n           只算体积、列文件，不真的下载
  --revision <分支>       模型仓库分支，默认 main
  --help, -h              帮助
```

### 脚本做了哪些保护

- **断点续传**：中途 Ctrl+C、断网、或被中间代理掐断，已下的字节留在 `.part` 里，
  旁边的 `.part.meta` 记着「这个半成品对应哪个 URL、该有多大」。下次用 HTTP Range 接着下，
  **不会从头再来**。如果 `.part.meta` 对不上（换了分支、换了 dtype、仓库更新过），
  脚本会主动丢弃这个断点重下，避免拼出一个大小刚好、内容是烂的文件。
  实测续传出来的文件和一次下完的**字节完全一致**。
- **大小校验**：每个文件下完都和 Hugging Face API 报的字节数对一遍，
  对不上就删掉重来，绝不在硬盘上留一个坏模型 —— 坏模型引发的报错非常难查。
- **已存在就跳过**：目标文件存在且大小一致，直接跳过，重复跑脚本很便宜。
  大小不一致（上次下坏了、或者上游更新了）会自动重下。
- **失败重试 3 次**，指数退避。
- **并发限制 4 个**，不会把网络打满。
- **全中文提示**，出错会直接告诉你该怎么办（连不上就提示加 `--mirror`）。

---

## 六、打包进 Electron 要注意什么

> 这一节是写给做 `desktop/` 的那位同学和主协调者看的。

模型文件是**纯数据**，不能走 asar 打包（asar 里的文件读起来慢，而且几百 MB 的
asar 会让启动变慢）。必须用 `extraResources` 原样复制出去。

`desktop/package.json` 里 `build` 段需要加上：

```json
{
  "build": {
    "appId": "com.voicecollector.app",
    "asar": true,
    "files": [
      "main.js",
      "preload.js",
      "!**/*.onnx"
    ],
    "extraResources": [
      {
        "from": "../web",
        "to": "web",
        "filter": ["**/*", "!**/.DS_Store", "!**/*.part", "!**/*.part.meta"]
      }
    ]
  }
}
```

要点：

1. **`web/models/` 必须跟着 `web/` 一起进 `extraResources`。**
   如果 `files` 里写了排除规则，注意别把 `models` 排掉了。
2. **`asar` 里不要放 `.onnx`。** 上面 `files` 中的 `"!**/*.onnx"` 就是干这个的。
   onnxruntime 需要用真实文件路径去 mmap 权重，asar 里的虚拟路径它读不了。
3. 打包后模型在 `process.resourcesPath + '/web/models/'`，
   主进程加载页面时用 `file://` 指向 `process.resourcesPath + '/web/index.html'`，
   这样页面里 `env.localModelPath = './models/'` 这个相对路径就自然对上了，
   不需要额外改代码。
4. **`web/vendor/transformers/` 里的 `.wasm` 也要一起出来**，同理不能进 asar。
   上面的 `extraResources` 已经把整个 `web/` 复制出去了，所以自动满足。
5. **打包前务必先跑一次下载脚本**，否则打出来的 App 里没有模型。
   建议在 `desktop/package.json` 加个 prepack 钩子：

   ```json
   "scripts": {
     "prepack": "node ../scripts/fetch-models.mjs --profile default"
   }
   ```

6. macOS 公证（notarize）会逐个文件签名，几百 MB 的模型会让公证明显变慢（多几分钟），
   这是正常的，不是卡死了。

---

## 七、模型文件为什么不进 Git

`web/models/.gitignore` 排除了两类东西：

1. **权重**：`*.onnx`、`*.bin`、`*.safetensors`、`*.part`、`*.part.meta` 等。
   几百 MB 的二进制进 Git 会让仓库永久性地变大（Git 的历史删不干净）。
2. **词表**：`tokenizer.json`、`vocab.json`、`merges.txt`、`*.spm`。
   这些虽然是文本，但一个就有好几 MB（opus 的 `tokenizer.json` 7 MB，
   whisper 的 2.4 MB），而且是机器生成的，review 也看不出名堂。

**留在仓库里的**是真正的小配置：`config.json`、`generation_config.json`、
`preprocessor_config.json`、`tokenizer_config.json`、`special_tokens_map.json`、
`added_tokens.json`、`normalizer.json`。一个模型大概 300 KB 以内。

这样做有两个好处：

1. 目录结构不会丢（Git 不跟踪空目录，靠这些小文件撑着）。
2. 模型配置能进 code review，万一有人手改了采样参数、语言设置，能一眼看出来。

需要权重的时候重新跑脚本就行，很快：

```bash
node scripts/fetch-models.mjs --profile default
```

---

## 八、常见问题

**Q: 提示 `getaddrinfo ENOTFOUND` 或者卡住不动？**
A: 网络到不了 huggingface.co。加镜像：
```bash
node scripts/fetch-models.mjs --profile default --mirror hf-mirror.com
```
镜像站 `hf-mirror.com` 的文件和官方站**字节完全一致**（已实测比对过）。

**Q: 下到一半断了怎么办？**
A: 重新跑同一条命令。已经下好的会跳过，下了一半的会接着下。

**Q: 报「下载不完整：拿到 X，应该是 Y」？**
A: 说明网络中途出了问题。脚本已经自动把坏文件删了，重跑一次即可。
如果反复出现，八成是中间有代理在改内容，换镜像或者换网络试试。

**Q: 提示「仓库 XXX 里没有某某文件」？**
A: 说明上游仓库改了文件名。**不要自己猜着改脚本里的文件名**，
先用下面这条命令看看仓库里到底有什么，再来改：
```bash
curl "https://huggingface.co/api/models/onnx-community/whisper-base/tree/main?recursive=true"
```

**Q: 完全下不下来怎么办？**
A: 不影响 App 能用。没有本地模型时，`whisper.js` 会退回到浏览器自带的
Web Speech API，`translate.js` 会退回到 Chrome 内置翻译。
只是效果差一些，而且要联网。本地模型是为了「彻底不依赖任何网站」这个目标准备的。

---

## 九、模型的来源和许可

| 模型 | 上游 | 许可 |
|---|---|---|
| Whisper (tiny/base/small) | OpenAI，由 `onnx-community` 转成 ONNX | Apache-2.0 |
| OPUS-MT en-zh | Helsinki-NLP，由 `Xenova` 转成 ONNX | Apache-2.0 / CC-BY-4.0 |

两个都是可以自由分发的开源许可，随 App 一起打包没有问题。
建议在 App 的「关于」页面里署名一下上游作者。
