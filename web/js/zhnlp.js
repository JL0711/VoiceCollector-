// zhnlp.js —— 中文讲课的离线分析（localnlp.js 的中文版）
//
// 为什么单独一个文件：localnlp.js 从切句、词干、术语到「考点 / 作业」的识别全是按英文写的
// （空格分词、will be on the exam、due next Friday …）。2026-10-13 拿一段中文课测下来，
// 概要里只剩「本节脉络」两行 —— 老师明明说了「期中考试一定会考，请大家记下来」
// 「下周三之前交一篇一千字的读书报告」，一条都没抓到。
//
// analyzeZh(segments) 返回和 localnlp.analyze() **一模一样的结构**，外加 lang: 'zh'，
// 渲染（buildNotes）继续用同一套，只在几个地方按 lang 换说法。
// localnlp.analyze() 看到讲稿以中文为主时自动转过来，调用方不用管。

const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff'
const CJK_RE = new RegExp('[' + CJK + ']', 'g')
const HAN = new RegExp('^[' + CJK + ']+$')

/** 讲稿是不是以中文为主（汉字数 > 英文词数） */
export function isMostlyChinese (segments) {
  let han = 0, words = 0
  for (const s of segments || []) {
    if (!s || s.kind === 'mark') continue
    const t = String(s.text || '')
    han += (t.match(CJK_RE) || []).length
    words += (t.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) || []).length
    if (han + words > 4000) break        // 够判断了
  }
  return han > 0 && han / 1.6 > words
}

// 汉字按 1.6 个字一个词估算，外文按空格；给打分 / 阈值用（和英文那边的 words 同量级）
export function zhWords (text) {
  const t = String(text || '')
  const han = (t.match(CJK_RE) || []).length
  const lat = (t.match(/[A-Za-z0-9]+/g) || []).length
  return Math.round(han / 1.6) + lat
}
const hanLen = t => (String(t || '').match(CJK_RE) || []).length

/* ============================== 切句 ============================== */

function toSentencesZh (segments) {
  const out = []
  for (const seg of segments) {
    if (!seg || seg.kind === 'mark') continue
    const raw = String(seg.text || '').replace(/\s+/g, ' ').trim()
    if (!raw) continue
    const t0 = Number(seg.t) || 0
    const span = Number(seg.end != null ? seg.end - t0 : seg.dur || seg.durationMs || 0) || 0
    const conf = seg.conf != null ? Number(seg.conf) : seg.confidence != null ? Number(seg.confidence) : null
    // 句末标点切；英文句点后面要有空格才切（别切 3.5 / U.S.）
    const parts = raw.split(/(?<=[。！？!?；;…])|(?<=\.)\s+/).map(x => x.trim()).filter(Boolean)
    const pieces = []
    for (const p of parts) {
      if (hanLen(p) <= 70) { pieces.push(p); continue }
      // Whisper 有时一整段只有逗号：按逗号攒到 30~60 字一句；连逗号都没有就 40 字硬切
      let buf = ''
      for (const c of p.split(/(?<=[，,、])/)) {
        if (buf && hanLen(buf + c) > 60) { pieces.push(buf); buf = '' }
        buf += c
        if (hanLen(buf) >= 30 && /[，,、]$/.test(buf)) { pieces.push(buf); buf = '' }
      }
      if (buf) pieces.push(buf)
    }
    const final = []
    for (const p of pieces) {
      if (hanLen(p) <= 80) { final.push(p); continue }
      const cs = [...p]
      for (let k = 0; k < cs.length; k += 40) final.push(cs.slice(k, k + 40).join(''))
    }
    const total = final.reduce((n, p) => n + p.length, 0) || 1
    let acc = 0
    for (const text of final) {
      const t = span > 0 ? Math.round(t0 + span * (acc / total)) : t0
      acc += text.length
      out.push({ i: out.length, t, text, zh: '', segId: seg.id, kind: seg.kind || 'asr', conf, words: zhWords(text) })
    }
  }
  return out
}

/* ============================== 关键词 ============================== */

// 词首 / 词尾不能是这些字（虚词、代词、量词），不然「的工业」「革命的」都会被当成词
const EDGE_BAD = new Set([...'的了着过是在和与及或而就也都还又再才只很太更最被把让给对从向往于跟同这那哪我你他她它们个位些种样么吗呢吧啊呀嘛哦嗯哈啦不没有上下来去说讲看想要会能可得地之其此该每各某'])
// 整个就是口头禅 / 讲课套话的二、三字串
const COMMON_ZH = new Set(('我们 你们 他们 她们 大家 同学 同学们 今天 现在 这个 那个 一个 什么 怎么 为什么 因为 所以 但是 然后 如果 就是 可以 这样 那样 这种 那种 一下 一些 时候 知道 觉得 东西 老师 上课 下课 这里 那里 已经 还是 或者 而且 不是 没有 自己 出来 起来 下来 开始 进行 非常 比较 其实 一定 应该 需要 希望 可能 主要 第一 第二 第三 第四 第五 首先 其次 最后 好的 好了 对吧 是吧 一样 这些 那些 讲到 来讲 来看 看一下 说到 刚才 上节课 下节课 这节课 节课 一部分 这一 部分 一点 地方 方面 情况 内容 意思 问题 一种 一次 两个 三个 几个 很多 许多 所有 任何 其他 另外 当然 比如 例如 也就是 就是说 也是 不同 重要 很重要 特别 大量 一千 一篇 之前 以后 以前 之后 下周 这周 本周 期中 期末 考试 作业 提前 请大家 记下来 谢谢 谢谢大家 今天就 讲到这里 到这里 好今天 那么 这么 多么 怎样 如何 同时 之间 当中 其中 一直 一起 不再 不能 不会 能够 可能会 变成 成为 作为 对于 关于 通过 因此 于是 只是 还有 包括 以及 并且 而是 不过 可是 虽然 即使 无论 只要 只有 除了 一方面 另一方面 一般 基本 所谓 叫做 称为 指的 指的是 是指 的话').split(' '))

function cjkNgrams (text, n) {
  const out = []
  for (const run of String(text).match(new RegExp('[' + CJK + ']{' + n + ',}', 'g')) || []) {
    const cs = [...run]
    for (let i = 0; i + n <= cs.length; i++) out.push(cs.slice(i, i + n).join(''))
  }
  return out
}

function extractTermsZh (sents, defTerms) {
  const tf = new Map(), spread = new Map()
  const bump = (k, i) => {
    tf.set(k, (tf.get(k) || 0) + 1)
    if (!spread.has(k)) spread.set(k, new Set())
    spread.get(k).add(i)
  }
  const strong = new Map()        // 带引号 / 书名号的、老师下过定义的、夹在中文里的外文术语
  for (const s of sents) {
    for (let n = 2; n <= 5; n++) for (const g of cjkNgrams(s.text, n)) bump(g, s.i)
    for (const m of s.text.matchAll(/[「“"《『‘]([^」”"》』’]{2,16})[」”"》』’]/g)) strong.set(m[1].trim(), (strong.get(m[1].trim()) || 0) + 2)
    // 夹在中文里的外文词：Impressionism、Industrial Revolution、DNA
    for (const m of s.text.matchAll(/[A-Za-z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,3}/g)) {
      const w = m[0].trim()
      if (w.length >= 3 && !/^(?:ok|okay|yes|no|so|and|the|a|an|is|it|i)$/i.test(w)) strong.set(w, (strong.get(w) || 0) + 2)
    }
  }
  for (const d of defTerms) strong.set(d, (strong.get(d) || 0) + 3)

  const ok = g => {
    const cs = [...g]
    if (EDGE_BAD.has(cs[0]) || EDGE_BAD.has(cs[cs.length - 1])) return false
    if (COMMON_ZH.has(g)) return false
    // 里面含一个套话（「我们的绘画」→ 含「我们」）的也不要
    for (let a = 0; a < cs.length - 1; a++) for (let b = a + 2; b <= cs.length; b++) {
      const sub = cs.slice(a, b).join('')
      if (sub !== g && COMMON_ZH.has(sub) && sub.length >= 2 && !['一种', '一点'].includes(sub)) return false
    }
    return true
  }
  let cands = []
  for (const [g, c] of tf) {
    const n = [...g].length
    const need = n === 2 ? 3 : 2
    if (c < need || !ok(g)) continue
    cands.push({ term: g, count: c, n, spread: spread.get(g).size })
  }
  // 长词吃掉短词：「工业革命」出现 2 次，「工业」「革命」也各 2 次 → 只留「工业革命」
  cands.sort((a, b) => b.n - a.n)
  const kept = []
  for (const c of cands) {
    if (kept.some(k => k.term.includes(c.term) && k.count >= c.count * 0.75)) continue
    // 反过来：短词出现次数比所有包含它的长词多得多，长词只是碰巧（「印象派的画」 vs 「印象派」）
    kept.push(c)
  }
  for (let i = kept.length - 1; i >= 0; i--) {
    const c = kept[i]
    const shorter = kept.find(k => k !== c && c.term.includes(k.term) && k.count >= c.count * 1.6)
    if (shorter && c.count < 3) kept.splice(i, 1)
  }
  const out = kept.map(c => ({
    term: c.term, key: c.term, n: c.n >= 4 ? 2 : 1, parts: [c.term], count: c.count,
    score: c.count * Math.pow(c.n, 0.7) * (1 + Math.log(c.spread)) + (strong.get(c.term) || 0) * 2
  }))
  for (const [w, sc] of strong) {
    if (out.some(o => o.term === w)) continue
    const count = sents.reduce((n, s) => n + (s.text.includes(w) ? 1 : 0), 0)
    if (!count) continue
    out.push({ term: w, key: w, n: 1, parts: [w], count, score: sc * 2 + count * 2 })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, 40)
}

/* ============================== 定义 / 重点 / 作业 / 分点 ============================== */

const LEAD_JUNK = /^(?:所以|因为|那么|而且|但是|然后|其实|这个|那个|我们说|我们把|也就是说|就是说|就是|而|那|这|好|嗯|啊|对)+/
const cleanTerm = s => String(s || '').replace(/[，,。！？、：:；;“”「」"\s]/g, '').replace(LEAD_JUNK, '').trim()

const DEF_PATTERNS_ZH = [
  // 所谓印象，指的就是这种瞬间的视觉经验
  { re: /所谓(?:的)?[「“"]?([^，,。！？「」“”"]{2,12}?)[」”"]?[，,]?\s*(?:指的(?:就)?是|就是|是指|也就是|是)([^。！？]{3,80})/, t: 1, d: 2 },
  // 我们把这种画法叫做印象派
  { re: /(?:我们|大家|人们|学界|历史上)?(?:把|将)([^。！？，,]{2,30}?)(?:叫做|叫作|称为|称作|称之为|定义为)[「“"]?([^，,。！？「」“”"]{2,12})/, t: 2, d: 1 },
  // 印象派是指 / 印象派指的是 / 印象派的定义是 / 印象派被定义为
  { re: /([^，,。！？；;：:]{2,14}?)(?:是指|指的是|的定义是|被定义为|定义为|的意思是)([^。！？]{3,80})/, t: 1, d: 2 },
  // 印象派，也就是 Impressionism —— 中英对照，术语就是左边
  { re: /([^，,。！？；;：:]{2,10}?)[，,]?\s*(?:也就是|又叫|也叫|英文叫|英文是|英文里叫)\s*([A-Za-z][A-Za-z\s'’-]{2,40})/, t: 1, d: 2, alias: true }
]

function extractDefinitionsZh (sents) {
  const out = [], seen = new Set()
  for (const s of sents) {
    if (hanLen(s.text) < 6) continue
    for (const p of DEF_PATTERNS_ZH) {
      const m = s.text.match(p.re)
      if (!m) continue
      let term = cleanTerm(m[p.t])
      // 「X是指」前面那一截可能吃进来一整句，取最后 8 个字以内的那部分
      if ([...term].length > 8) term = [...term].slice(-8).join('').replace(LEAD_JUNK, '')
      if (!term || [...term].length < 2 || COMMON_ZH.has(term)) continue
      let def = String(m[p.d] || '').replace(/^[，,：:\s]+/, '').trim()
      if (p.alias) def = '英文：' + def
      const key = term
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ i: s.i, t: s.t, term, def: def.slice(0, 120), text: s.text, zh: '' })
      break
    }
  }
  return out
}

const EMPHASIS_ZH = [
  { re: /(?:一定|肯定|必然|绝对)会考|必考|考试(?:一定|肯定)?会(?:考|出)|会出(?:在)?(?:考试|试卷|期中|期末)|考点|考试范围|出题/, w: 4.0, tag: '考点' },
  { re: /(?:期中|期末|考试|测验|小测|quiz|exam|midterm|final).{0,10}(?:会|要|考|出现|涉及)/i, w: 3.0, tag: '考点' },
  { re: /划重点|重中之重|一定要记住|务必|千万(?:要|别|不要)|必须(?:掌握|记住|理解)|大家(?:一定)?要(?:掌握|记住|理解)/, w: 3.0, tag: '重点' },
  { re: /(?:很|非常|特别|极其|最)(?:重要|关键)|(?:这|这一点|这部分|这个)(?:是)?(?:重点|关键)|记下来|记一下|注意(?:一下)?[，,]|请(?:大家)?注意|别忘了|要记住/, w: 2.0, tag: '重点' },
  { re: /总结一下|总的来说|简单来说|核心(?:观点|思想|问题)|最重要的(?:是|一点)/, w: 1.5, tag: '总结' }
]

function extractEmphasisZh (sents) {
  const out = []
  for (const s of sents) {
    if (hanLen(s.text) < 4) continue
    let w = 0, tag = ''
    for (const m of EMPHASIS_ZH) if (m.re.test(s.text) && m.w > w) { w = m.w; tag = m.tag }
    if (!w) continue
    out.push({ i: s.i, t: s.t, text: s.text, zh: '', weight: w, tag })
  }
  out.sort((a, b) => b.weight - a.weight || a.t - b.t)
  return out
}

const NUM = '[0-9０-９一二两三四五六七八九十]'
const DAY = '[一二三四五六日天末]'
const DATE_RE_ZH = new RegExp([
  NUM + '{1,3}月' + NUM + '{1,3}(?:日|号)(?:之前|以前|前)?',
  '(?:下|这|本|上)?(?:周|星期|礼拜)' + DAY + '(?:之前|以前|前|晚上|上午|下午|中午)?',
  '(?:下|这|本)(?:周|星期|个月|学期)(?:之前|以前|内)?',
  '下(?:节|次)课(?:之前|以前|前)?',
  '(?:明天|后天|今晚|今天晚上|月底|月初|期中(?:考试)?(?:之)?前|期末(?:考试)?(?:之)?前|这学期结束(?:之)?前)',
  NUM + '{1,2}(?:号|日)(?:之前|以前|前)?',
  '(?:' + NUM + '{1,2}|几)(?:天|周|个星期)(?:之内|以内|内|后)'
].join('|'), 'g')

const TASK_ZH = [
  { re: /作业|习题|练习题|题目/, tag: '作业' },
  { re: /报告|论文|小论文|读书报告|essay|paper|文章/i, tag: '论文/报告' },
  { re: /阅读|预习|复习|读一下|读完|读教材|看教材|第[一二三四五六七八九十0-9]+章|读物|reading/i, tag: '阅读' },
  { re: /展示|汇报|演讲|presentation|小组/i, tag: '展示' },
  { re: /期中|期末|测验|小测|quiz|exam|midterm|考试/i, tag: '考试' },
  { re: /截止|之前交|前交|提交|交上来|交给我|交一[篇份个]|上传|deadline|due/i, tag: '截止' }
]

function extractTasksZh (sents) {
  const out = []
  for (const s of sents) {
    const tags = []
    for (const p of TASK_ZH) if (p.re.test(s.text)) tags.push(p.tag)
    if (!tags.length) continue
    const dates = []
    DATE_RE_ZH.lastIndex = 0
    for (const m of s.text.matchAll(DATE_RE_ZH)) { if (dates.length < 3) dates.push({ raw: m[0], zh: m[0], at: m.index }) }
    // 「还有，作业。」这种只有个名词、没时间没内容的不算
    if (hanLen(s.text) < 8 && !dates.length) continue
    // 只是提了一句考试（没时间）—— 归「重点」，不进待办
    if (tags.every(x => x === '考试') && !dates.length) continue
    // 「题目是现代性与城市生活」这种只因为「题目」命中的，要么有时间要么有别的作业词
    if (tags.length === 1 && tags[0] === '作业' && !dates.length && !/作业|习题/.test(s.text)) continue
    out.push({
      i: s.i, t: s.t, text: s.text, zh: '', tags: [...new Set(tags)], dates,
      urgent: dates.length > 0 || /截止|提交|交上来|交给我|交一|之前交/.test(s.text)
    })
  }
  return out
}

const ORD_ZH = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const ORD_HEAD = /^(?:第([一二三四五六七八九十])(?:点|个|条|步|方面)?|([一二三四五六七八九十])是|首先|其次|再次|然后|最后|另外)[，,、：:\s]*/

function extractEnumerationsZh (sents) {
  const groups = []
  // ① 一句话里自己就列了「第一……；第二……；第三……」
  for (const s of sents) {
    const parts = s.text.split(/[；;]|(?=第[一二三四五六七八九十][点个条步]?[，,、：:])/).map(x => x.trim()).filter(Boolean)
    const items = parts.filter(p => ORD_HEAD.test(p))
    if (items.length >= 2) {
      const prev = sents[s.i - 1]
      const title = prev && s.t - prev.t < 30000 && hanLen(prev.text) <= 40 ? prev.text.replace(/[。！？]$/, '') : '老师列的几点'
      groups.push({ t: s.t, title, items: items.map(p => ({ t: s.t, text: p.replace(/[。；;]$/, '') })) })
    }
  }
  // ② 连着几句分别以「第一 / 第二 / 首先 / 其次 / 最后」开头
  let run = []
  const flush = () => {
    if (run.length >= 2) {
      const first = run[0], prev = sents[first.i - 1]
      const title = prev && first.t - prev.t < 30000 && hanLen(prev.text) <= 40 ? prev.text.replace(/[。！？]$/, '') : '老师列的几点'
      if (!groups.some(g => g.items.some(it => it.t === first.t))) {
        groups.push({ t: first.t, title, items: run.map(s => ({ t: s.t, text: s.text })) })
      }
    }
    run = []
  }
  for (const s of sents) {
    const m = s.text.match(ORD_HEAD)
    if (m && !/[；;]/.test(s.text)) {
      const n = m[1] ? ORD_ZH[m[1]] : m[2] ? ORD_ZH[m[2]] : 0
      if (run.length && n === 1) flush()
      run.push(s)
    } else if (run.length) flush()
  }
  flush()
  return groups.sort((a, b) => a.t - b.t).slice(0, 8)
}

function extractFormulasZh (sents) {
  return sents.filter(s => /[=＝+×÷≤≥≈≠√π^]|等于|乘以|除以|加上|减去|平方|开方|公式|方程|导数|积分|百分之/.test(s.text) && /[0-9０-９a-zA-Z一二三四五六七八九十百千万]/.test(s.text) && hanLen(s.text) >= 6)
    .map(s => ({ i: s.i, t: s.t, text: s.text, zh: '' }))
}

// 学生提问：「老师，我有个问题」「请问」「能不能再讲一下」，下一句不是问句就当回答
function extractQAZh (sents) {
  const out = []
  for (let k = 0; k < sents.length && out.length < 10; k++) {
    const s = sents[k]
    if (!/^(?:老师[，,]|请问|我有(?:一)?个问题|我想问|能不能再|可以再(?:讲|解释)|不好意思[，,]?(?:老师)?)/.test(s.text)) continue
    const a = sents[k + 1] && !/[？?]$/.test(sents[k + 1].text) && sents[k + 1].t - s.t < 60000 ? sents[k + 1] : null
    out.push({ q: { t: s.t, text: s.text, zh: '' }, a: a ? { t: a.t, text: a.text, zh: '' } : null })
  }
  return out
}

/* ============================== 打分 / 主题 ============================== */

const FILLER_ZH = /嗯+|啊+|呃+|那个那个|就是说|然后呢|对吧|是吧|好吧|对不对|你知道|怎么说呢/g

function scoreSentencesZh (sents, terms, defIdx, empIdx, taskIdx) {
  const tw = terms.slice(0, 25)
  for (const s of sents) {
    let v = 0
    for (const t of tw) if (s.text.includes(t.term)) v += t.score
    const len = Math.max(4, hanLen(s.text))
    v = v / Math.sqrt(len) * 3
    if (defIdx.has(s.i)) v += 3
    if (empIdx.has(s.i)) v += 2.5
    if (taskIdx.has(s.i)) v += 1.5
    v /= 1 + 0.4 * ((s.text.match(FILLER_ZH) || []).length)
    if (len < 8) v *= 0.4
    if (len > 90) v *= 0.7
    s.score = v
  }
}

// 每句一个「字二元组」词袋，相邻窗口比相似度，谷底就是换话题的地方（TextTiling 的中文版）
function bag (text) {
  const m = new Map()
  for (const g of cjkNgrams(text, 2)) {
    const cs = [...g]
    if (EDGE_BAD.has(cs[0]) && EDGE_BAD.has(cs[1])) continue
    m.set(g, (m.get(g) || 0) + 1)
  }
  for (const w of String(text).match(/[A-Za-z]{3,}/g) || []) { const k = w.toLowerCase(); m.set(k, (m.get(k) || 0) + 1) }
  return m
}
function cos (a, b) {
  let dot = 0, na = 0, nb = 0
  for (const [k, v] of a) { na += v * v; if (b.has(k)) dot += v * b.get(k) }
  for (const v of b.values()) nb += v * v
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}
function merged (sents, a, b) {
  const m = new Map()
  for (let i = Math.max(0, a); i < Math.min(sents.length, b); i++) for (const [k, v] of sents[i]._bag) m.set(k, (m.get(k) || 0) + v)
  return m
}

function detectTopicsZh (sents, durationMs) {
  const n = sents.length
  if (!n) return []
  const want = Math.max(1, Math.min(8, Math.round(durationMs / 360000) || 1, Math.floor(n / 6) || 1))
  if (want <= 1 || n < 12) return [{ start: 0, end: n - 1 }]
  for (const s of sents) s._bag = bag(s.text)
  const K = 4
  const gaps = []
  for (let g = 1; g < n; g++) gaps.push({ g, sim: cos(merged(sents, g - K, g), merged(sents, g, g + K)) })
  // 深度 = 两边最高点到谷底的落差
  for (let k = 0; k < gaps.length; k++) {
    let l = gaps[k].sim, r = gaps[k].sim
    for (let j = k - 1; j >= 0 && gaps[j].sim >= l; j--) l = gaps[j].sim
    for (let j = k + 1; j < gaps.length && gaps[j].sim >= r; j++) r = gaps[j].sim
    gaps[k].depth = (l - gaps[k].sim) + (r - gaps[k].sim)
  }
  const MIN = Math.max(4, Math.floor(n / (want * 2)))
  const cuts = []
  for (const x of gaps.slice().sort((a, b) => b.depth - a.depth)) {
    if (cuts.length >= want - 1 || x.depth <= 0.05) break
    if (x.g < MIN || n - x.g < MIN || cuts.some(c => Math.abs(c - x.g) < MIN)) continue
    cuts.push(x.g)
  }
  for (const s of sents) delete s._bag
  cuts.sort((a, b) => a - b)
  const out = []
  let st = 0
  for (const c of cuts) { out.push({ start: st, end: c - 1 }); st = c }
  out.push({ start: st, end: n - 1 })
  return out
}

function titleForTopicZh (slice, terms, allSents) {
  // 这一段里出现得最多、而在别的段里相对少的关键词
  const inSlice = new Set(slice.map(s => s.i))
  const best = terms.slice(0, 30).map(t => {
    let here = 0, else_ = 0
    for (const s of allSents) if (s.text.includes(t.term)) (inSlice.has(s.i) ? here++ : else_++)
    return { t, v: here ? here * t.score / (1 + else_ * 0.6) : 0 }
  }).filter(x => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 2).map(x => x.t.term)
  if (best.length) return best.join('、')
  const first = slice.find(s => hanLen(s.text) >= 6) || slice[0]
  const clause = String(first.text).split(/[，,。！？；;]/).find(c => hanLen(c) >= 4) || first.text
  return [...clause].length > 16 ? [...clause].slice(0, 16).join('') + '…' : clause
}

/* ============================== 入口 ============================== */

export function analyzeZh (segs) {
  const marks = segs.filter(s => s && (s.kind === 'mark' || s.kind === 'note') && s.text)
    .map(s => ({ t: Number(s.t) || 0, text: String(s.text), kind: s.kind }))
  const sents = toSentencesZh(segs)
  const base = { lang: 'zh', marks }
  if (!sents.length) {
    return { ...base, meta: { segmentCount: segs.length, sentenceCount: 0, wordCount: 0, durationMs: 0, topicCount: 0 },
      sentences: [], topics: [], definitions: [], emphases: [], tasks: [], enumerations: [], formulas: [], terms: [], qa: [], suspects: [], empty: true }
  }
  let durationMs = sents[sents.length - 1].t
  for (const s of segs) { const e = Number((s && (s.end != null ? s.end : s.t)) || 0); if (e > durationMs) durationMs = e }

  const definitions = extractDefinitionsZh(sents)
  const terms = extractTermsZh(sents, definitions.map(d => d.term))
  const emphases = extractEmphasisZh(sents)
  const tasks = extractTasksZh(sents)
  const enumerations = extractEnumerationsZh(sents)
  const formulas = extractFormulasZh(sents)
  const qa = extractQAZh(sents)
  scoreSentencesZh(sents, terms, new Set(definitions.map(d => d.i)), new Set(emphases.map(e => e.i)), new Set(tasks.map(x => x.i)))

  const topics = detectTopicsZh(sents, durationMs).map((tp, idx) => {
    const slice = sents.slice(tp.start, tp.end + 1)
    const key = slice.filter(s => hanLen(s.text) >= 10).sort((a, b) => b.score - a.score).slice(0, 3).sort((a, b) => a.t - b.t)
    return {
      index: idx, start: tp.start, end: tp.end,
      tStart: slice[0].t, tEnd: slice[slice.length - 1].t, sentenceCount: slice.length,
      title: titleForTopicZh(slice, terms, sents),
      keySentences: key.map(s => ({ i: s.i, t: s.t, text: s.text, zh: '' }))
    }
  })

  return {
    ...base,
    meta: { segmentCount: segs.length, sentenceCount: sents.length, wordCount: sents.reduce((a, s) => a + s.words, 0), durationMs, topicCount: topics.length },
    sentences: sents, topics, definitions, emphases, tasks, enumerations, formulas, terms, qa, suspects: [], empty: false
  }
}

/** 「核心内容」候选：讲内容的句子 —— 中等长度、不是问句、口头禅少、分数高；作业通知和「第一第二第三」那种提纲句不算 */
export function coreCandidatesZh (analysis) {
  const sents = (analysis && analysis.sentences) || []
  const skip = new Set([...(analysis.tasks || []).map(x => x.i), ...(analysis.emphases || []).filter(e => e.tag === '考点').map(e => e.i)])
  return sents.filter(s => s.kind !== 'note' && !skip.has(s.i) && hanLen(s.text) >= 12 && hanLen(s.text) <= 90 &&
                           !/[？?]$/.test(s.text) && !ORD_HEAD.test(s.text) && !/^(?:下节课|下次课|好[，,]|今天就)/.test(s.text))
    .map(s => ({ s, v: (s.score || 0) / (1 + 0.5 * ((s.text.match(FILLER_ZH) || []).length)) }))
    .sort((a, b) => b.v - a.v).slice(0, 3).map(x => x.s)
}

export const _test = { toSentencesZh, extractTermsZh, extractDefinitionsZh, extractEmphasisZh, extractTasksZh, extractEnumerationsZh, detectTopicsZh }
