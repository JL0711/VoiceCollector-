#!/usr/bin/env node
// 生成 web/js/zhconv.js —— 繁简转换表（Whisper 识别中文时繁简混着出，见 zhconv.js 开头）。
//
// 字表来自 macOS 自带的 ICU 转换（Hant-Hans / Hans-Hant），在本机跑一次生成，
// App 里不需要联网也不需要任何依赖。只在 macOS 上能跑（要 osascript）：
//   node desktop/scripts/gen-zhconv.mjs
//
// 逐字表是有歧义的（发→發/髮、后→後/后、著名≠着名），下面几张手工表就是处理这些的：
//   T2S_KEEP     繁→简时保持原样的字（它们在简体里本来就是正常字：姊妹、摔跤、大阪）
//   S2T_DEFAULT  一个简体字对应多个繁体 / 本身也是繁体字时，默认用哪个（不在表里的就不动）
//   S2T_PHRASES  按词覆盖（头发→頭髮、皇后→皇后、公里→公里）

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUT = resolve(import.meta.dirname, '..', '..', 'web', 'js', 'zhconv.js');

// ---- 1. 用 ICU 跑一遍所有 CJK 统一汉字 ----
const jxa = `
ObjC.import('Foundation');
function conv(s, t){ return ObjC.unwrap($(s).stringByApplyingTransformReverse(t, false)); }
var R=[[0x4E00,0x9FFF],[0x3400,0x4DBF],[0xF900,0xFAFF]], all='';
for (var r=0;r<R.length;r++) for (var c=R[r][0]; c<=R[r][1]; c++) all += String.fromCharCode(c) + '\\n';
JSON.stringify({ src: all, t2s: conv(all, 'Hant-Hans'), s2t: conv(all, 'Hans-Hant') });`;
const tmp = mkdtempSync(join(tmpdir(), 'zhconv-'));
const jxaFile = join(tmp, 'gen.js');
writeFileSync(jxaFile, jxa);
const raw = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', jxaFile], { maxBuffer: 64 << 20 }).toString());
rmSync(tmp, { recursive: true, force: true });
const src = raw.src.split('\n'), t2sOut = raw.t2s.split('\n');
if (src.length !== t2sOut.length) throw new Error('ICU 输出行数对不上');

// ---- 2. Big5 / GB2312 字集（判断「这个字在另一边是不是也是正常字」）----
const charset = (enc, hi, lo) => {
  const dec = new TextDecoder(enc), set = new Set();
  for (let a = hi[0]; a <= hi[1]; a++) for (const [b0, b1] of lo) for (let b = b0; b <= b1; b++) {
    const ch = dec.decode(new Uint8Array([a, b]));
    if (ch.length === 1 && ch !== '�') set.add(ch);
  }
  return set;
};
const BIG5 = charset('big5', [0xA4, 0xF9], [[0x40, 0x7E], [0xA1, 0xFE]]);
const GB2312 = charset('gbk', [0xB0, 0xF7], [[0xA1, 0xFE]]);

// ---- 3. 繁 → 简 ----
// 这些繁体字在简体里也是常用字，逐字转会出错（姊妹→姐妹、摔跤→摔交、大阪→大坂、与时俱进→与时具进）
const T2S_KEEP = new Set([...'俱吒姊苎跤阪麴']);
// 这几个要看上下文，交给 zhconv.js 里的规则（乾隆、著名、狼藉）
const T2S_CONTEXT = new Set([...'乾著藉']);
const t2s = new Map();
for (let i = 0; i < src.length; i++) {
  const c = src[i], s = t2sOut[i];
  if (!c || !s || s === c || s.length !== 1) continue;          // 只要基本平面内的单字（不出生僻的扩展区字）
  if (T2S_KEEP.has(c) || T2S_CONTEXT.has(c)) continue;
  t2s.set(c, s);
}

// ---- 4. 简 → 繁 ----
const sources = new Map();          // 简体字 → 能转成它的繁体字（只算 Big5 里的正常繁体字）
for (const [t, s] of t2s) if (BIG5.has(t)) (sources.get(s) || sources.set(s, []).get(s)).push(t);
for (const c of T2S_CONTEXT) {
  const s = { 乾: '干', 著: '着', 藉: '借' }[c];
  (sources.get(s) || sources.set(s, []).get(s)).push(c);
}
// 一对多 / 本身也是繁体字的简体字：默认转成哪个。没列出来的就保持原样（宁可不转也不转错）
const S2T_DEFAULT = {
  并: '並', 仑: '侖', 个: '個', 尽: '盡', 净: '淨', 别: '別', 铲: '鏟', 勋: '勳', 汇: '匯', 叹: '嘆',
  尝: '嘗', 哗: '嘩', 当: '當', 啮: '嚙', 团: '團', 埙: '塤', 坛: '壇', 袅: '裊', 弥: '彌', 复: '復',
  凄: '淒', 忧: '憂', 挂: '掛', 构: '構', 历: '歷', 枪: '槍', 棂: '欞', 毁: '毀', 冲: '衝', 湿: '濕',
  卤: '滷', 炼: '煉', 烟: '煙', 笺: '箋', 获: '獲', 发: '發', 荡: '蕩', 钳: '鉗', 签: '簽', 纤: '纖',
  脏: '髒', 铺: '鋪', 艳: '豔', 药: '藥', 证: '證', 谥: '諡', 赞: '贊', 迹: '跡', 舆: '輿', 锤: '錘',
  钟: '鐘', 鉴: '鑑', 闲: '閒', 须: '須', 饥: '飢', 馈: '饋', 鳌: '鰲',
  杰: '傑', 价: '價', 优: '優', 儿: '兒', 胜: '勝', 吨: '噸', 坏: '壞', 宁: '寧', 岭: '嶺', 几: '幾',
  厂: '廠', 后: '後', 怜: '憐', 怀: '懷', 忏: '懺', 扑: '撲', 据: '據', 扰: '擾', 于: '於', 昵: '暱',
  晒: '曬', 栖: '棲', 极: '極', 杠: '槓', 机: '機', 柜: '櫃', 气: '氣', 涌: '湧', 洁: '潔', 淀: '澱',
  泞: '濘', 洒: '灑', 炖: '燉', 异: '異', 痒: '癢', 确: '確', 种: '種', 范: '範', 筑: '築', 檐: '簷',
  帘: '簾', 篱: '籬', 网: '網', 茧: '繭', 羡: '羨', 圣: '聖', 听: '聽', 腊: '臘', 与: '與', 庄: '莊',
  万: '萬', 荐: '薦', 苹: '蘋', 虫: '蟲', 蝎: '蠍', 蜡: '蠟', 蚕: '蠶', 里: '裡', 触: '觸', 夸: '誇',
  丰: '豐', 赶: '趕', 适: '適', 离: '離', 云: '雲', 愿: '願', 惊: '驚', 肮: '骯', 体: '體', 咸: '鹹',
  么: '麼', 党: '黨', 余: '餘'
};
// 按词覆盖：先于逐字转换。左边是简体，右边是正确的繁体
const S2T_PHRASES = {
  头发: '頭髮', 理发: '理髮', 发型: '髮型', 白发: '白髮', 毛发: '毛髮', 假发: '假髮', 短发: '短髮', 长发: '長髮', 染发: '染髮', 发夹: '髮夾',
  皇后: '皇后', 王后: '王后', 太后: '太后', 母后: '母后', 天后: '天后', 影后: '影后', 后羿: '后羿',
  公里: '公里', 英里: '英里', 海里: '海里', 千里: '千里', 万里: '萬里', 故里: '故里', 邻里: '鄰里', 里程: '里程', 里长: '里長',
  茶几: '茶几', 几乎: '幾乎',
  复杂: '複雜', 重复: '重複', 复习: '複習', 复制: '複製', 复数: '複數', 复印: '複印', 复合: '複合', 复述: '複述', 繁复: '繁複', 反复: '反覆', 答复: '答覆', 覆盖: '覆蓋',
  日历: '日曆', 历法: '曆法', 农历: '農曆', 阳历: '陽曆', 阴历: '陰曆', 挂历: '掛曆', 台历: '檯曆',
  钟爱: '鍾愛', 钟情: '鍾情', 钟意: '鍾意',
  冲洗: '沖洗', 冲水: '沖水', 冲泡: '沖泡', 冲澡: '沖澡', 冲刷: '沖刷', 冲积: '沖積', 冲凉: '沖涼',
  心脏: '心臟', 内脏: '內臟', 肝脏: '肝臟', 肾脏: '腎臟', 脏器: '臟器', 五脏: '五臟',
  胡须: '鬍鬚', 胡子: '鬍子', 胡同: '衚衕', 须发: '鬚髮',
  干净: '乾淨', 干燥: '乾燥', 饼干: '餅乾', 干杯: '乾杯', 干脆: '乾脆', 晒干: '曬乾', 干旱: '乾旱', 干枯: '乾枯', 干涸: '乾涸',
  干部: '幹部', 干活: '幹活', 干什么: '幹什麼', 干嘛: '幹嘛', 干吗: '幹嘛', 能干: '能幹', 才干: '才幹', 树干: '樹幹', 主干: '主幹', 骨干: '骨幹', 干线: '幹線', 苦干: '苦幹', 实干: '實幹',
  台风: '颱風', 台灯: '檯燈', 柜台: '櫃檯', 吧台: '吧檯', 台球: '檯球',
  面条: '麵條', 面包: '麵包', 面粉: '麵粉', 方便面: '方便麵', 拉面: '拉麵', 面食: '麵食', 凉面: '涼麵', 汤面: '湯麵',
  制造: '製造', 制作: '製作', 制品: '製品', 绘制: '繪製', 研制: '研製', 印制: '印製', 录制: '錄製', 拍制: '拍製', 制成: '製成', 制药: '製藥', 定制: '定製', 仿制: '仿製', 缝制: '縫製', 烹制: '烹製', 炮制: '炮製',
  准备: '準備', 标准: '標準', 准确: '準確', 水准: '水準', 准时: '準時', 精准: '精準', 瞄准: '瞄準', 基准: '基準', 准则: '準則', 对准: '對準',
  尽管: '儘管', 尽量: '儘量', 尽快: '儘快', 尽早: '儘早',
  合并: '合併', 兼并: '兼併', 吞并: '吞併',
  词汇: '詞彙', 汇编: '彙編', 汇总: '彙總', 汇集: '彙集',
  采取: '採取', 采用: '採用', 采访: '採訪', 采集: '採集', 采购: '採購', 开采: '開採', 采纳: '採納',
  谷物: '穀物', 稻谷: '稻穀', 五谷: '五穀',
  收获: '收穫',
  香烟: '香菸', 烟草: '菸草', 抽烟: '抽菸', 吸烟: '吸菸', 戒烟: '戒菸',
  锻炼: '鍛鍊', 标签: '標籤', 书签: '書籤', 抽签: '抽籤',
  称赞: '稱讚', 赞美: '讚美', 赞扬: '讚揚', 点赞: '點讚', 赞叹: '讚嘆',
  饥荒: '饑荒', 别扭: '彆扭',
  关系: '關係', 没关系: '沒關係', 联系: '聯繫', 维系: '維繫',
  精致: '精緻', 细致: '細緻', 别致: '別緻', 景致: '景緻', 雅致: '雅緻',
  计划: '計劃', 规划: '規劃', 划分: '劃分', 策划: '策劃', 区划: '區劃',
  特征: '特徵', 象征: '象徵', 征求: '徵求', 征兆: '徵兆', 征收: '徵收', 征集: '徵集', 征文: '徵文',
  舍不得: '捨不得', 舍弃: '捨棄', 取舍: '取捨', 施舍: '施捨', 割舍: '割捨',
  朴素: '樸素', 简朴: '簡樸', 淳朴: '淳樸', 朴实: '樸實',
  尸体: '屍體', 凶手: '兇手', 仆人: '僕人', 萝卜: '蘿蔔',
  委托: '委託', 托付: '託付', 信托: '信託', 寄托: '寄託', 推托: '推託',
  注释: '註釋', 注册: '註冊', 注解: '註解', 批注: '批註', 备注: '備註', 脚注: '腳註',
  杂志: '雜誌', 标志: '標誌', 日志: '日誌',
  周末: '週末', 周一: '週一', 周二: '週二', 周三: '週三', 周四: '週四', 周五: '週五', 周六: '週六', 周日: '週日', 周年: '週年', 周期: '週期', 周刊: '週刊', 周报: '週報', 一周: '一週', 每周: '每週', 上周: '上週', 下周: '下週', 本周: '本週', 这周: '這週', 两周: '兩週',
  游戏: '遊戲', 旅游: '旅遊', 游客: '遊客', 游览: '遊覽', 游行: '遊行', 导游: '導遊', 游玩: '遊玩', 郊游: '郊遊',
  丑陋: '醜陋', 丑闻: '醜聞', 出丑: '出醜',
  手表: '手錶', 钟表: '鐘錶', 表带: '錶帶', 老板: '老闆', 开辟: '開闢', 精辟: '精闢',
  刮风: '颳風', 放松: '放鬆', 轻松: '輕鬆', 松散: '鬆散', 宽松: '寬鬆', 松懈: '鬆懈',
  战斗: '戰鬥', 奋斗: '奮鬥', 斗争: '鬥爭', 争斗: '爭鬥', 搏斗: '搏鬥',
  忧郁: '憂鬱', 郁闷: '鬱悶', 抑郁: '抑鬱', 防御: '防禦', 抵御: '抵禦', 呼吁: '呼籲',
  一只: '一隻', 两只: '兩隻', 几只: '幾隻', 这只: '這隻', 那只: '那隻', 每只: '每隻',
  余下: '餘下'
};
const s2t = new Map();
for (const [s, ts] of sources) {
  if (S2T_DEFAULT[s]) { s2t.set(s, S2T_DEFAULT[s]); continue; }
  if (ts.length === 1 && !BIG5.has(s)) s2t.set(s, ts[0]);     // 只有一个繁体、而且简体字本身不是繁体字 → 安全
}
for (const [s, t] of Object.entries(S2T_DEFAULT)) if (!s2t.has(s)) s2t.set(s, t);
// 词表里的繁体要和逐字表自洽（左边逐字转完不能比词表更「对」）
for (const [s, t] of Object.entries(S2T_PHRASES)) if ([...s].length !== [...t].length) throw new Error('词长不一致：' + s);

// ---- 5. 写出 ----
const keys = m => [...m.keys()].join(''), vals = m => [...m.values()].join('');
const js = `// 自动生成，别手改 —— 改 desktop/scripts/gen-zhconv.mjs 然后重新跑它。
// 繁简转换 + 中文标点规范化（Whisper 识别中文专用）。
//
// 为什么要有这个：Whisper 识别普通话时繁简是混着出的 —— 2026-10-13 实测一段 2 分钟的中文课，
// 前半段「同學們好，今天我們來講現代藝術」，后半段又变回简体，中间还夹着半角逗号。
// 表来自 macOS 的 ICU（Hant-Hans / Hans-Hant），逐字表 + 少量按词覆盖，完全离线。
//
//   toHans(text)          繁 → 简（老师讲课语言选「中文（普通话）」时用）
//   toHant(text)          简 → 繁（台湾 / 粤语）—— 只转确定不会错的字
//   normalizeZh(text, script)  繁简 + 标点：中文之间的半角 , ? ! : ; . → 全角，去掉汉字之间多余的空格
//   zhScript(srcLang, dstLang) 这节课该用简体还是繁体：'hans' | 'hant'

const T2S_FROM = ${JSON.stringify(keys(t2s))};
const T2S_TO = ${JSON.stringify(vals(t2s))};
const S2T_FROM = ${JSON.stringify(keys(s2t))};
const S2T_TO = ${JSON.stringify(vals(s2t))};
const S2T_PHRASES = ${JSON.stringify(S2T_PHRASES)};

let T2S = null, S2T = null, S2T_RE = null;
const table = (from, to) => { const m = new Map(), a = [...from], b = [...to]; a.forEach((c, i) => m.set(c, b[i])); return m; };

export const CJK = '\\\\u3400-\\\\u4dbf\\\\u4e00-\\\\u9fff\\\\uf900-\\\\ufaff';
const HAS_CJK = new RegExp('[' + CJK + ']');
export const hasCJK = s => HAS_CJK.test(String(s || ''));

export function toHans (text) {
  const s = String(text || '');
  if (!HAS_CJK.test(s)) return s;
  if (!T2S) T2S = table(T2S_FROM, T2S_TO);
  let out = '';
  for (const c of s) out += T2S.get(c) || c;
  // 看上下文的三个字
  out = out.replace(/乾(?!隆|坤|元)/g, '干');
  // 著名、著作、显著、原著 …… 保持「著」；看著 / 著急 → 着
  out = out.replace(/(^|[^显原名巨编论专遗昭卓土])著(?![名作称述书者录])/g, '$1着');
  out = out.replace(/(^|[^狼慰枕蕴])藉(?!藉)/g, '$1借');
  out = out.replace(/家俱/g, '家具');
  return out;
}

export function toHant (text) {
  const s = String(text || '');
  if (!HAS_CJK.test(s)) return s;
  if (!S2T) {
    S2T = table(S2T_FROM, S2T_TO);
    const ks = Object.keys(S2T_PHRASES).sort((a, b) => b.length - a.length);
    S2T_RE = new RegExp(ks.join('|'), 'g');
  }
  // 先按词（头发→頭髮），词里的字不再逐字转；其余逐字
  let out = '', last = 0;
  const conv = seg => { let r = ''; for (const c of seg) r += S2T.get(c) || c; return r; };
  s.replace(S2T_RE, (m, i) => { out += conv(s.slice(last, i)) + S2T_PHRASES[m]; last = i + m.length; return m; });
  return out + conv(s.slice(last));
}

// 中文标点：只动「挨着汉字」的半角标点，英文句子、数字（1,000 / 3.5）不受影响
const C = '[' + CJK + ']';
const PUNCT = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' };
const RE_SPACE = new RegExp('(' + C + ')[ \\\\t]+(?=' + C + ')', 'g');
const RE_AFTER = new RegExp('(' + C + ')\\\\s*([,?!:;])\\\\s*', 'g');
const RE_BEFORE = new RegExp('\\\\s*([,?!:;])\\\\s*(?=' + C + ')', 'g');
const RE_DOTS = new RegExp('(' + C + ')\\\\s*(?:\\\\.{3,}|…+)', 'g');
const RE_DOT = new RegExp('(' + C + ')\\\\s*\\\\.(?![0-9.])\\\\s*', 'g');
const RE_SP_PUNCT = /\\s+([，。？！：；、）」』”])/g;
const RE_PUNCT_SP = new RegExp('([，。？！：；、])[ \\\\t]+(?=' + C + ')', 'g');
export function zhPunct (text) {
  let s = String(text || '');
  if (!HAS_CJK.test(s)) return s;
  s = s.replace(RE_SPACE, '$1')
       .replace(RE_DOTS, '$1……')
       .replace(RE_AFTER, (m, c, p) => c + PUNCT[p])
       .replace(RE_BEFORE, (m, p) => PUNCT[p])
       .replace(RE_DOT, '$1。')
       .replace(RE_SP_PUNCT, '$1')
       .replace(RE_PUNCT_SP, '$1');
  return s;
}

export function zhScript (srcLang, dstLang) {
  const src = String(srcLang || '').toLowerCase(), dst = String(dstLang || '').toLowerCase();
  if (/^zh-(tw|hk|mo|hant)/.test(src)) return 'hant';
  if (/^zh/.test(src)) return 'hans';
  return /hant|tw|hk/.test(dst) ? 'hant' : 'hans';
}

export function normalizeZh (text, script = 'hans') {
  const s = String(text || '');
  if (!HAS_CJK.test(s)) return s;
  return zhPunct(script === 'hant' ? toHant(s) : toHans(s));
}
`;
writeFileSync(OUT, js);
console.log(`✓ ${OUT}  繁→简 ${t2s.size} 字，简→繁 ${s2t.size} 字 + ${Object.keys(S2T_PHRASES).length} 词，${(Buffer.byteLength(js) / 1024).toFixed(0)} KB`);
