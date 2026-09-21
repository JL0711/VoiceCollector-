/**
 * fuse.testdata.js —— fuse.js 的回归评测集
 *
 * 每条 {en, mt, llm, want, why}：
 *   en   原文（法学/社科课堂口语，来自真实课程的典型句型）
 *   mt   opus-mt 的译文
 *   llm  Qwen LLM 的译文
 *   want 期望胜者：'mt' | 'llm' | ''（两边都不可用）
 *   why  为什么期望它赢
 *
 * 覆盖四种实测出来的典型情况：
 *   A 术语准 vs 术语被简化      → 期望 opus-mt
 *   B 长句完整 vs 后半句漏译    → 期望 LLM
 *   C 数字/日期对 vs 错         → 期望译对的那一边
 *   D 复读/退化 vs 正常         → 期望正常的那一边
 *   E 中性句 + 平局优先级规则   → 期望规则指定的那一边
 *
 * 用法：
 *   import { CASES, toItems } from './fuse.testdata.js';
 *   import { fuseMany } from './fuse.js';
 *   const { results } = fuseMany(toItems());
 *   results.forEach((r, i) => console.log(r.from === CASES[i].want ? 'OK' : 'MISS', r.reason));
 */

export const CASES = [
  /* ---------- A. 术语准 vs 术语被简化（期望 opus-mt） ---------- */
  {
    group: 'A',
    en: 'The Supreme Court ruled that the First Amendment protects this kind of speech.',
    mt: '最高法院裁定,第一修正案保护这种言论。',
    llm: '最高法院裁定这类型的言论受到宪法保障。',
    want: 'mt',
    why: 'LLM 把 First Amendment 简化成「宪法」，术语丢了'
  },
  {
    group: 'A',
    en: 'The Fourth Amendment requires probable cause before the police can get a search warrant.',
    mt: '第四修正案要求警方在取得搜查令之前必须具备合理根据。',
    llm: '警察要拿到搜查证,必须先有足够的理由。',
    want: 'mt',
    why: 'LLM 同时丢了第四修正案、合理根据、搜查令三个术语'
  },
  {
    group: 'A',
    en: 'Under strict scrutiny the state must prove a compelling government interest.',
    mt: '在严格审查标准下,州政府必须证明存在迫切的政府利益。',
    llm: '在很严的审查之下,州必须证明政府有重大的利益。',
    want: 'mt',
    why: 'LLM 把 strict scrutiny 译成「很严的审查」，不是标准译法'
  },
  {
    group: 'A',
    en: 'Stare decisis means that the court follows binding precedent.',
    mt: '遵循先例意味着法院遵守有约束力的先例。',
    llm: '这个原则意味着法院会按照以前的判决来处理。',
    want: 'mt',
    why: 'LLM 把拉丁语术语整个抹掉了'
  },
  {
    group: 'A',
    en: 'The plaintiff lacks legal standing to bring this claim.',
    mt: '原告没有提起这项主张的诉讼资格。',
    llm: '起诉的那一方没有资格提出这个请求。',
    want: 'mt',
    why: 'LLM 丢了「原告」和「诉讼资格」'
  },
  {
    group: 'A',
    en: 'The dissenting opinion argued for a broader right to privacy.',
    mt: '异议意见主张更广泛的隐私权。',
    llm: '反对的那份意见认为应该有更大的个人空间保护。',
    want: 'mt',
    why: 'LLM 把「隐私权」译成「个人空间保护」'
  },
  {
    group: 'A',
    en: 'The Supreme Court granted certiorari in that case last term.',
    mt: '最高法院上学期在那个案子里签发了调卷令。',
    llm: '最高法院在上一个开庭期受理了那个案子。',
    want: 'mt',
    why: 'LLM 丢了「调卷令」，也没把 last term 对上'
  },

  /* ---------- B. 长句完整 vs 后半句漏译（期望 LLM） ---------- */
  {
    group: 'B',
    en: "we're not going to read that right if it's a lot but that is something that it leads into the question of the changing interpretation and the changing nature of privacy in the digital age.",
    mt: '"我们不会读,如果它很多。"',
    llm: '我们不会读到那句,除非它是一个很大的问题,否则这将引导进入关于数字时代隐私变化的问题。',
    want: 'llm',
    why: 'opus-mt 后半句整个丢了（实测原样）'
  },
  {
    group: 'B',
    en: 'So what I want you to notice here is that the court is not actually saying that the statute is unconstitutional on its face, it is saying that as applied to these particular facts it fails.',
    mt: '所以我想让你注意的是,法院并没有说这项法规。',
    llm: '所以我希望你们注意的是,法院实际上并没有说这条法律本身就违宪,而是说它适用于这些具体事实时站不住脚。',
    want: 'llm',
    why: 'opus-mt 在「法规」处提前收尾，丢了转折后的整个主句'
  },
  {
    group: 'B',
    en: "And that tension between the government's interest in security and the individual's expectation of privacy is really what the whole line of cases from Katz forward is about.",
    mt: '政府对安全的兴趣和个人的隐私期望之间的紧张关系。',
    llm: '而政府在安全上的利益与个人隐私期待之间的这种张力,正是从 Katz 案往后整条判例线索真正讨论的东西。',
    want: 'llm',
    why: 'opus-mt 只译出主语短语，谓语部分全丢'
  },
  {
    group: 'B',
    en: 'If you look at the way the majority frames the question, they are essentially asking whether a person who voluntarily hands information over to a third party still retains any constitutional protection in that information.',
    mt: '如果你看看多数派如何提出这个问题。',
    llm: '如果你看多数意见是怎么界定这个问题的,他们本质上是在问:一个自愿把信息交给第三方的人,是否还对这些信息保有宪法上的保护。',
    want: 'llm',
    why: 'opus-mt 只译了条件从句'
  },
  {
    group: 'B',
    en: 'Now I know that is a lot to take in at once but the point I want you to walk away with is that the doctrine has been shifting steadily over the last two decades.',
    mt: '我知道这一下子很难消化。',
    llm: '我知道这些一下子不好消化,但我希望你们记住的一点是,这套原则在过去二十年里一直在稳步变化。',
    want: 'llm',
    why: 'opus-mt 丢了主句，连 two decades 也一起丢了'
  },
  {
    group: 'B',
    en: 'The reason we spend so much time on this case is not because the holding itself is complicated, but because the reasoning tells you a great deal about how the court thinks about new technology.',
    mt: '我们花这么多时间在这个案子上的原因并不是因为这个案子本身很复杂。',
    llm: '我们在这个案子上花这么多时间,不是因为判决本身复杂,而是因为它的说理能告诉你很多关于法院如何看待新技术的东西。',
    want: 'llm',
    why: 'opus-mt 丢了 but 之后的整个后半句'
  },
  {
    group: 'B',
    en: 'What I find most interesting about this opinion is not the outcome but the way the justices talk past each other about what the constitutional text actually requires in a world of ubiquitous digital surveillance.',
    mt: '我发现这个意见最有趣的不是结果,而是法官们如何相互交谈。',
    llm: '我觉得这份意见里最有意思的不是结论,而是大法官们在「宪法文本在一个无处不在的数字监控世界里到底要求什么」这件事上各说各话。',
    want: 'llm',
    why: 'opus-mt 在「相互交谈」处截断，丢了整个宾语从句'
  },
  {
    group: 'B',
    en: 'Remember that when we come back on the other side of the break we are going to pick up with the concurrence, because it actually does more work than the majority does here.',
    mt: '记住,当我们回来的时候。',
    llm: '记住,休息回来之后我们会接着讲协同意见,因为它在这里其实比多数意见做了更多的工作。',
    want: 'llm',
    why: 'opus-mt 只留了半句话'
  },

  /* ---------- C. 数字 / 日期（期望译对的那一边） ---------- */
  {
    group: 'C',
    en: 'Your homework is problem set four, due next Friday before midnight.',
    mt: '你的作业是四号问题,下星期五午夜前就要交。',
    llm: '你的作业是第四题,截止日期为下周五凌晨。',
    want: 'mt',
    why: 'LLM 把 before midnight 译成「凌晨」，作业时间错了最危险'
  },
  {
    group: 'C',
    en: 'The midterm is on October fifteenth at two in the afternoon.',
    mt: '期中考试在10月15日下午两点。',
    llm: '期中考试定在10月15日上午两点。',
    want: 'mt',
    why: 'LLM 把 afternoon 译成「上午」'
  },
  {
    group: 'C',
    en: "Please read chapter seven before Thursday's lecture.",
    mt: '请在周四的课之前读完第七章。',
    llm: '请在周三上课前读完第七章。',
    want: 'mt',
    why: 'LLM 把 Thursday 译成「周三」'
  },
  {
    group: 'C',
    en: 'The paper is due next Monday, not this Monday.',
    mt: '论文下周一截止,不是这周一。',
    llm: '论文这周一就要交了。',
    want: 'mt',
    why: 'LLM 把 next Monday 译成「这周一」，还丢了对比'
  },
  {
    group: 'C',
    en: 'About sixty percent of the class got that question wrong.',
    mt: '班上大约60%的同学答错了那道题。',
    llm: '班上大概有一半人答错了这道题。',
    want: 'mt',
    why: 'LLM 把 sixty percent 改写成「一半」'
  },
  {
    group: 'C',
    en: 'The deadline is tomorrow at noon.',
    mt: '截止时间是中午。',
    llm: '截止时间是明天中午。',
    want: 'llm',
    why: '这次是 opus-mt 丢了 tomorrow'
  },
  {
    group: 'C',
    en: 'We will meet again next week to finish the second half of the argument.',
    mt: '我们下周再见面。',
    llm: '我们下周再碰一次,把论证的后半部分讲完。',
    want: 'llm',
    why: 'opus-mt 漏译后半句，LLM 日期也没错'
  },
  {
    group: 'C',
    en: 'Your final exam is on December twelfth and it covers everything after week eight.',
    mt: '你的期末考试在12月12日,涵盖第八周之后的所有内容。',
    llm: '期末考试在12月12日,内容包括第8周以后的全部。',
    want: 'mt',
    why: '两边日期都对，分数接近；含日期时按规则优先 opus-mt'
  },
  {
    group: 'C',
    en: 'Office hours are Wednesday from three to five.',
    mt: '答疑时间是周三三点到五点。',
    llm: '答疑时间是周三从三点到五点。',
    want: 'mt',
    why: '两边都对，含日期 → 平局规则优先 opus-mt'
  },
  {
    group: 'C',
    en: 'Read pages forty to fifty two for Tuesday.',
    mt: '周二之前读40到52页。',
    llm: '请在周二之前读第40页到第52页。',
    want: 'mt',
    why: '两边数字都对，平局规则优先 opus-mt'
  },
  {
    group: 'C',
    en: 'For next Wednesday I want you to read the first forty pages of the casebook and come prepared to discuss the three questions that I posted on the course website last night.',
    mt: '下周三我要你们读案例书的前40页,并准备好讨论我昨晚在课程网站上发布的三个问题。',
    llm: '下周三我希望大家读完案例集的前四十页,并准备好讨论我昨天晚上贴在课程网站上的那三个问题。',
    want: 'mt',
    why: '长句但含多个数字/日期 —— 规则 1 压过规则 2，优先 opus-mt'
  },
  {
    group: 'C',
    en: 'The case was decided in 2018 by a five to four vote.',
    mt: '这个案子在2018年以五比四的票数判决。',
    llm: '这个案子是在2018年判的,当时的表决结果很接近。',
    want: 'mt',
    why: 'LLM 把 five to four 模糊成「很接近」，票数丢了'
  },

  /* ---------- D. 复读 / 退化 vs 正常 ---------- */
  {
    group: 'D',
    en: 'supreme court',
    mt: '最高法院最高法院',
    llm: '最高法院（Supreme Court）',
    want: 'llm',
    why: 'opus-mt 复读（实测原样）'
  },
  {
    group: 'D',
    en: 'The court applied the reasonable expectation of privacy test.',
    mt: '法院适用了合理隐私期待合理隐私期待检验。',
    llm: '法院适用了合理隐私期待标准。',
    want: 'llm',
    why: 'opus-mt 把术语复读了一遍'
  },
  {
    group: 'D',
    en: 'privacy law',
    mt: '隐私法隐私法',
    llm: '隐私法（privacy law）',
    want: 'llm',
    why: 'opus-mt 两字块复读'
  },
  {
    group: 'D',
    en: 'The court disagreed with that reading of the statute.',
    mt: '法院 不 同意 对 该 法规 的 这种 解读',
    llm: '法院不同意对这条法规的这种解读。',
    want: 'llm',
    why: 'opus-mt 输出成了逐字拼接（中文里混空格）'
  },
  {
    group: 'D',
    en: 'Any questions?',
    mt: '有问题吗?',
    llm: '同学们,关于我刚才讲的这些内容,大家还有什么想问的问题吗?欢迎随时提出来。',
    want: 'mt',
    why: 'LLM 对着两个词的短句自由发挥，严重超长'
  },
  {
    group: 'D',
    en: 'The statute was struck down.',
    mt: '法规法规法规被被被推翻。',
    llm: 'The statute was struck down.',
    want: '',
    why: '一边复读、一边原样抄回原文，两边都不可用'
  },

  /* ---------- E. 中性句 + 平局优先级规则 ---------- */
  {
    group: 'E',
    en: 'He argued that the search was unreasonable because the officers had no search warrant.',
    mt: '他辩称,这次搜查是不合理的,因为警官没有,',
    llm: '他辩称这次搜查不合理,因为警察没有搜查令。',
    want: 'llm',
    why: 'opus-mt 停在逗号上、丢了「搜查令」'
  },
  {
    group: 'E',
    en: 'We are going to talk about three cases today.',
    mt: '我们今天要讲三个案子。',
    llm: '我们今天要讨论几个案例。',
    want: 'mt',
    why: 'LLM 把 three 模糊成「几个」'
  },
  {
    group: 'E',
    en: 'Let me give you a quick example.',
    mt: '让我给你举一个简单的例子。',
    llm: '我给你举个简单的例子。',
    want: 'mt',
    why: '中短句、无数字无术语，平局规则默认 opus-mt'
  },
  {
    group: 'E',
    en: 'The professor said the assigned reading is optional but strongly recommended.',
    mt: '教授说指定阅读是可选的,但强烈推荐。',
    llm: '教授说这份材料可以不读,但很建议读一下。',
    want: 'mt',
    why: 'LLM 丢了「指定阅读」这个术语'
  },
  {
    group: 'E',
    en: 'That is the question we will come back to at the end of the semester.',
    mt: '这就是我们在学期末会回来的问题。',
    llm: '这就是我们会在学期末再回来讨论的那个问题。',
    want: 'llm',
    why: 'opus-mt 的「会回来的问题」是明显机翻腔，LLM 更完整'
  },
  {
    group: 'E',
    en: 'This is one of those cases where everybody agrees on the result and nobody agrees on why, which is exactly the situation that produces bad law down the road.',
    mt: '这是每个人都同意结果的案例之一。',
    llm: '这属于那种所有人都认同结论、却没人认同理由的案子,而这恰恰是日后会催生坏法律的局面。',
    want: 'llm',
    why: '长句无日期 → 规则 2，且 opus-mt 确实漏译了后半'
  }
];

/** 转成 fuseMany 要的 items 形状 */
export function toItems() {
  return CASES.map((c, i) => ({ id: i, en: c.en, mt: c.mt, llm: c.llm }));
}

export default CASES;
