// vocab.js —— 自动生词本
//
// 为什么要有这个模块：
//   晗晗跟不上老师语速，直接原因常常不是「整体听力不行」，而是**一个不认识的词卡住整句**，
//   愣神两秒，后面三五句全丢。而一门课的高频生词其实就固定的一两百个，
//   提前认识，听力压力立刻下降一大截。
//   手动记生词没人能坚持，所以这些词必须**从她自己上过的课里自动攒出来**。
//
// 这个文件做七件事（主协调者按导出名严格集成，勿改名）：
//   extractCandidates(session, opts)         从一节课里挑出她可能不认识的词
//   mergeIntoBook(book, candidates, meta)    跨课累积成生词本
//   reviewQueue(book, opts)                  间隔重复排序（简化版 SM-2）
//   grade(book, word, ok)                    复习反馈，更新间隔
//   toAnki(book, opts) / toCSV(book) / toMarkdown(book)   导出
//   bookStats(book)                          统计
//
// 纯 ES Module，无构建步骤，不联网，词表全部内嵌。
// 依赖：glossary.js（术语命中）、localnlp.js（定义句/考点句）、util.js（时间戳格式化）。
// 这三个文件本模块只读不改。

import { findTerms } from './glossary.js';
import { analyze } from './localnlp.js';
import { mmss } from './util.js';

/* ===========================================================================
 * 一、内置词表（关键！不用词频排序糊弄）
 * ---------------------------------------------------------------------------
 * BASE_WORDS：英语最常用词 + 课堂口水词。命中这里的词一律不算生词。
 *   收录口径 = 一个考过托福/雅思、准备来美国读书的中国学生**几乎肯定认识**的词。
 *   只收原形，屈折变化（复数 / -ed / -ing / -ly）由 lemma() 还原后再查。
 *   故意**不收**的词：syllabus / midterm / prerequisite / statute / precedent /
 *   liability / elasticity / arbitrary / constitute / inherent ……
 *   这些正是她要学的，收进来就等于白做。
 * ========================================================================= */

const BASE_WORDS = `
a able about above accept accident according account ache across act action active activity actor actual actually add
address admit adult advantage advice advise affect afraid after afternoon again against age ago agree agreement ahead
aid aim air airport alive all allow almost alone along aloud already alright also although always am among amount an
analysis ancient and anger angry animal announce annoy another answer any anybody anymore anyone anything anyway anyways
anywhere apart apartment apologize appear apple apply appointment approach april are area argue argument arm army around
arrange arrive art article artist as ask asleep aspect assignment assist assume at attack attempt attend attention
attitude attract audience august aunt author authority autumn available average avoid awake award aware away awful
baby back background bad bag bake balance ball band bank bar base baseball basic basically basis basket basketball bath
bathroom be beach bear beat beautiful beauty became because become becomes bed bedroom bee beef beer before began begin
beginning begun behavior behind belief believe bell belong below belt bench bend beneath benefit beside besides best bet
better between beyond bicycle big bike bill billion bird birth birthday bit bite black blame blank blanket blind block
blood blow blue board boat body boil bone book boot border bore born borrow boss both bother bottle bottom bowl box boy
brain branch brave bread break breakfast breath breathe brick bridge brief bright bring broad broke broken brother
brought brown brush budget build building built bunch burn bus bush business busy but butter button buy by
cake call calm came camera camp campus can cancel candidate candle candy cap capital captain car card care career
careful carry case cash cat catch cause ceiling celebrate cell cent center central century certain certainly chain
chair challenge chance change channel chapter character charge chart cheap check cheese chemical chest chicken chief
child childhood children choice choose chose church cigarette circle citizen city civil claim class classic classroom
clean clear clerk clever click climb clock close cloth clothes cloud club coach coal coast coat code coffee coin cold
collect college color column combine come comfort comfortable command comment commercial commit committee common
communicate community company compare compete complain complete complex computer concern concert condition conference
confidence confirm conflict confuse connect consider consist constant contact contain content contest context continue
contract contrast control convenient conversation cook cool copy corn corner correct cost cotton could count country
couple courage course court cousin cover cow crazy cream create credit crime criminal crisis critical criticize crop
cross crowd cry cultural culture cup curious current custom customer cut cycle
dad daily damage dance danger dangerous dark data date daughter day dead deal dear death debate debt decade december
decide decision declare decline decrease deep defeat defend defense define definitely degree delay deliver demand
democracy department depend depth describe description desert design desire desk despite destroy detail determine
develop development device devote dictionary did die diet difference different difficult difficulty dig dinner direct
direction director dirty disagree disappear disappoint discover discuss discussion disease dish distance distant
district divide do doctor document does dog dollar domestic done door double doubt down downtown dozen draw drawn
dream dress drink drive driven driver drop drove drug dry due during dust duty
each ear early earn earth ease easily east easy eat economic economics economy edge editor education effect effective
efficient effort egg eight either elect election electric electricity element elementary eleven else email emerge
emergency emotion employ employee employer empty encourage end enemy energy engine engineer english enjoy enough enter
entertainment entire entrance environment equal equipment error escape especially essay essential establish estimate
even evening event eventually ever every everybody everyday everyone everything everywhere evidence exact exactly exam
examine example excellent except exchange excited exciting excuse exercise exist exit expand expect expensive
experience experiment expert explain explanation express expression extend extra extreme eye
face fact factor factory fail failure fair fall false familiar family famous fan far farm farmer fashion fast fat
father fault favor favorite fear feature february federal fee feed feel feeling fell fellow felt female fence festival
few field fifteen fifth fifty fight figure file fill film final finally finance financial find fine finger finish fire
firm first fish fit five fix flag flat flight floor flow flower fly focus fold folks follow food foot football for
force foreign forest forever forget forgive fork form formal former forty forward found foundation four fourth frame
free freedom freeze frequent fresh friday friend friendly friendship from front fruit fuel full fun function fund
funny furniture further future
gain game gap garbage garden gas gate gather gave general generally generation gentle gentleman get gift girl give
given glad glass global go goal god gold golf gone good goods got govern government grab grade graduate grain grand
grandfather grandmother grant grass gray great green greet grew grocery ground group grow growth guarantee guard guess
guest guide guilty gun guy guys
habit had hair half hall hand handle hang happen happy hard hardly harm has hat hate have he head health healthy hear
heard heart heat heavy height held hell hello help helpful her here hero herself hey hi hid hide high highway hill him
himself hire his historical history hit hobby hold hole holiday home homework honest honor hope horse hospital host hot
hotel hour house housing how however huge human humor hundred hunger hungry hunt hurry hurt husband
ice idea ideal identify if ignore ill illegal image imagine immediate impact important impossible impress improve in
inch include income increase indeed independent index indicate individual industry influence inform information
initial injury inside insist instance instead institution instruction instrument insurance intend interest interesting
internal international internet interview into introduce invent invest investment invite involve iron is island issue
it item its itself
jacket january job join joke journal journey joy judge juice july jump june junior just justice
keep kept key kick kid kill kind king kiss kitchen knee knew knife knock know knowledge known
lab labor lack lady laid lake lamp land landscape language large last late later latter laugh launch law lawyer lay
layer lazy lead leader leaf league learn least leather leave lecture led left leg legal lemon lend length less lesson
let letter level library license lie life lift light like likely limit line link lip liquid list listen literally
literature little live living load loan local locate location lock long look lose loss lost lot loud love low luck
lucky lunch
machine mad made magazine magic mail main maintain major majority make male man manage management manager manner many
map march mark market marriage marry mass master match material math mathematics matter may maybe me meal mean meaning
meanwhile measure meat media medical medicine medium meet meeting member memory men mention menu mess message met metal
meter method middle might mile military milk million mind mine minister minor minute mirror miss mission mistake mix
mobile model modern moment monday money monitor month mood moon moral more moreover morning most mother motion motor
mountain mouse mouth move movement movie much multiple murder muscle museum music musical must my myself mystery
nail name narrow nation national native natural nature near nearby nearly necessary neck need negative neighbor neither
nerve nervous net network never nevertheless new news newspaper next nice night nine nineteen ninety no noise none noon
nor normal north nose not note nothing notice novel november now nowhere nuclear number numerous nurse nut
object objective observe obtain obvious obviously occasion occur ocean october odd of off offer office officer official
often oh oil okay old on once one online only onto open operate operation opinion opportunity oppose opposite option or
orange order ordinary organ organization organize origin original other otherwise ought our ours ourselves out outcome
outdoor outside over overall owe own owner
pace pack package page pain paint painting pair pale panel paper parent park part participate particular particularly
partner party pass passage passenger past path patient pattern pay payment peace pen pencil people pepper per percent
perfect perform performance perhaps period permanent permit person personal personality perspective persuade pet phase
phone photo photograph phrase physical physics piano pick picture piece pig pile pill pilot pink pipe place plan plane
planet plant plastic plate play player pleasant please pleasure plenty plus pocket poem poet point police policy polite
political politics pollution pool poor pop popular population port portion position positive possess possibility
possible post pot potato potential pound pour poverty power powerful practical practice praise pray predict prefer
pregnant prepare presence present president press pressure pretend pretty prevent previous price pride primary prime
print prior prison private prize probably problem procedure proceed process produce product production professional
professor profit program progress project promise promote proof proper property proposal propose protect protection
proud prove provide public publish pull punish purchase pure purpose push put
quality quantity quarter queen question quick quiet quit quite quote
race radio rail rain raise ran range rank rapid rare rate rather reach react read ready real reality realize really
reason reasonable receive recent recently reception recipe recognize recommend record recover red reduce refer
reference reflect refuse regard region register regular reject relate relation relationship relative relax release
relevant relief religion religious rely remain remember remind remove rent repair repeat replace reply report
represent republic reputation request require research reserve resident resist resource respect respond response
responsibility rest restaurant result retire return reveal review rice rich ride right ring rise risk river road rock
role roll roof room root rope rough round route row royal rub rule run rural rush
sad safe safety said sail salary sale salt same sample sand sandwich sat satisfy saturday sauce save saw say scale
scared scene schedule scheme school science scientific scientist score screen sea search season seat second secret
secretary section sector secure security see seed seek seem seen select self sell send senior sense sentence separate
september series serious serve service session set settle seven several severe sex shade shadow shake shall shame
shape share sharp she sheet shelf shell shift shine ship shirt shock shoe shoot shop shopping short shot should
shoulder shout show shower shut sick side sight sign signal significant silence silent silver similar simple simply
since sing singer single sink sir sister sit site situation six sixteen sixty size skill skin skirt sky sleep slide
slight slightly slip slow small smart smell smile smoke smooth snow so social society sock soft software soil solar
sold soldier solid solution solve some somebody somehow someone something sometimes somewhat somewhere son song soon
sorry sort sorta soul sound soup source south space speak special species specific speech speed spell spend spent
spirit spite split spoke spoken sport spot spread spring square stable staff stage stair stand standard star start
state statement station stay steady steal steel step stick still stock stomach stone stood stop store storm story
straight strange stranger strategy stream street strength stress stretch strict strike strong structure struggle
student studio study stuff stupid style subject submit substance succeed success successful such sudden suddenly
suffer sugar suggest suit suitable summer sun sunday supply support suppose sure surface surprise surround survey
survive suspect sweet swim switch symbol sympathy system
table tail take taken talk tall tape target task taste taught tax tea teach teacher team tear technical technique
technology telephone television tell temperature temporary ten tend tendency tennis tension term terrible test text
than thank that the theater their theirs them theme themselves then theory there therefore these they thick thin thing
think third thirsty thirty this those though thought thousand threat threaten three throat through throughout throw
thursday thus ticket tie tight time tiny tip tired title to today toe together told tomorrow tone tonight too took tool
tooth top topic total touch tough tour tourist toward towards towel tower town toy track trade tradition traditional
traffic train training transfer transform translate transport travel treat treatment tree trend trial trip trouble
truck true trust truth try tuesday turn twelve twenty twice two type typical
ugly uh um ultimate unable uncle under understand understanding unemployment unfair unfortunately uniform union unique
unit united universal university unknown unless until unusual up upon upper upset urban urge us use useful user usual
usually
vacation valley valuable value variety various vast vegetable vehicle version very via victim victory video view
village violence virtual visit visitor visual vital voice volume vote voyage
wage wait wake walk wall want war warm warn was wash waste watch water wave way we weak wealth weapon wear weather web
wedding wednesday week weekend weight welcome well went were west western wet what whatever wheel when whenever where
wherever whether which while whisper white who whole whom whose why wide wife wild will win wind window wine wing
winner winter wire wise wish with within without witness woman women wonder wonderful wood word wore work worker world
worn worry worse worst worth would wound wrap write writer writing written wrong wrote
yard yeah year yellow yep yes yesterday yet you young your yours yourself youth
zero zone
gonna wanna gotta kinda cannot dont doesnt didnt isnt arent wasnt werent cant couldnt wouldnt shouldnt havent hasnt
hadnt wont lets im ive id ill youre youve youd youll hes shes its theyre theyve theyd theyll were weve wed well thats
whats heres theres
mhm hmm huh erm ahh yup nope ok
`;

const KNOWN_BASE = new Set(
  BASE_WORDS.toLowerCase().split(/\s+/).filter(w => w.length > 0)
);

// 补充：常见派生形 / 常见校园生活词 / 常见学科名 —— 这些也不算生词。
// 单独一块是为了方便以后「误伤了某个词」时往这里补，不用动上面的主表。
const BASE_EXTRA = `
ability absolutely academic accurate achieve across activity addition advanced afford agency ahead algebra alongside
altogether ambition analyze angle anybody apparently appreciate approve april arrival assignment atmosphere attempt
attendance average backpack badly bachelor balcony bedroom behave belonging beverage biology bookstore borrowed
breakdown briefly broadly brotherhood cafeteria calendar calculate calculator carefully carelessly ceremony chairman
chemistry childish choir citizenship classmate clearly climate clinic closely coffeehouse collection colorful
combination comfortably commonly communication companion comparison competition completely composition concentration
conclusion confidence confusion connection consideration construction continuous conversation cooperation correctly
countryside courtyard creation creative creature crowded curiosity daily dangerous darkness decoration definition
delicious delivery departure dependent depression describe desperate destruction detailed determination difficulty
directly disability disappointed discovery distribution division dormitory downstairs dramatic driving earthquake
easily economics editor educational effectively electronic elevator emotional employment encouragement endless
engineering enormous entertainment entrance environmental equality equally especially essential establishment
everyday exactly examination excitement exclude exhausted existence expectation expensive experienced explanation
exploration expression extremely failure fairly faithful familiar fantastic farewell fashionable favorable feedback
finally financially firmly fitness flexible fluent forecast forgotten formally fortunately freely freshman friendship
frequently frightened frustrated fully furniture generally generous gently geography gladly graduation grammar
grateful greatly greenhouse guidance handwriting happily hardware harmful headache healthcare heavily helpful
highlight historical homeless homework honestly hopefully hopeless horrible hospitality household humanity identity
immediately importance impossible impressive improvement inability incorrect increasingly independence indoor
industrial inexpensive informal injured innocent inspection installation instructor intelligent intention interaction
interesting internship interruption introduction invitation involvement jealous journalism judgment junior keyboard
kindergarten kindness knowledgeable laboratory landlord laptop largely laughter leadership learner legally lengthy
librarian lifestyle lifetime likewise limited literally lively loneliness luckily luggage mainly maintenance majority
management manager marriage mathematics meaningful measurement mechanic membership memorize mentally merely midnight
mistaken mostly motivation movement musician mysterious nationality naturally naughty necessarily neighborhood
nervously newly nicely nowadays nursery obviously occasionally offering officially operator opposition organized
originally outdoors overcome overnight painful painter painting partly passenger passport patience patiently
peaceful percentage performance permission personally persuasive photographer physically physician planning pleasant
pleased poetry politely politician popularity possibly postcard poverty powerful practically precious preference
pregnancy preparation presentation presence presently preserve previously printer privately probability professor
programming progressive promotion pronunciation properly proposal protective proudly psychology publicly punishment
purchase qualified quality quickly quietly rainfall rapidly rarely reaction readily realistic reasonable recently
recognition recommendation recording recovery reduction refresh refrigerator regularly relatively relaxed reliable
religion remarkable removal repeatedly replacement representative requirement reservation resignation responsible
restaurant restroom retirement revision roommate roughly rudely sadly safely satisfaction scholarship scientific
seemingly selection selfish semester seriously servant settlement shortly shyly signature significantly silently
similarly simply sincerely sleepy slightly slowly smoothly sociology softly solution sometime specially specifically
speedy spelling spending sporting statistics steadily storage straightforward strangely strongly studio stylish
subway successfully sufficiently suggestion suitcase summary sunlight sunshine superior supermarket supportive
surely surprising surprisingly surroundings suspicious swimming teaching teamwork technical technological teenager
telephone temporarily terribly textbook thankful thoroughly thoughtful threatening throughout tightly timetable
tiredness tomorrow toothbrush totally tourism traditional traffic tragedy trainer translation transportation
treatment truly typically typing unable unbelievable uncomfortable unconscious underground understandable unemployed
unexpected unfair unhappy unhealthy unimportant university unknown unlike unlikely unnecessary unpleasant unusual
upstairs urgently useless usefulness vacation valuable variety various vegetarian verbal violent visible vocabulary
voluntary waiter wallet warning weakness wealthy weekday weekly welcome wellness wheelchair widely willing willingly
windy wisdom wonderfully wooden workplace worldwide worried worthy writer yearly youthful
means versus doing being going having appropriate acquire external circumstance commitment
expansion administrative commission conduct resolve capable capacity category welfare
alternative principle exception distinction limitation coordinate precisely traditionally
virtually implicitly essentially concrete bind bound binding repetition complicate
complicated conclusion admittedly nowadays somewhat hypothetical
whereas furthermore moreover nonetheless likewise hence
elsewhere elsewise prioritize prioritise priority systematic systematically unsystematic
filter filters filtering vary varies varied varying
selective selectively variable variables input inputs output outputs feedback
`;
for (const w of BASE_EXTRA.toLowerCase().split(/\s+/)) if (w) KNOWN_BASE.add(w);

/* ---------------------------------------------------------------------------
 * 学术通用词表（Academic Word List 风格，570 个词头 + 中文释义）
 * 这一份才是重点：AWL 的词在课堂上高频、在日常英语里低频，
 * 正好是「托福背过一点但听力里反应不过来」的那一档。
 * 格式：词 中文（中间一个空格，中文里不许有空格）
 * 注意：和上面 BASE_WORDS 重合的词（area / create / issue / major ……）不会被收成生词，
 *      因为 isKnown() 先跑；这里留着是为了给派生形（如 creation）提供词根释义。
 * ------------------------------------------------------------------------- */
const AWL_RAW = `
analyse 分析 approach 方法/途径 area 领域 assess 评估 assume 假定/认为 authority 权威/当局 available 可获得的
benefit 益处 concept 概念 consist 由…组成 constitute 构成/组成 context 语境/背景 contract 合同 create 创造
data 数据 define 定义 derive 得出/源自 distribute 分配 economy 经济 environment 环境 establish 建立 estimate 估计
evident 明显的 export 出口 factor 因素 finance 金融/资金 formula 公式 function 功能/函数 identify 识别
income 收入 indicate 表明 individual 个体的 interpret 解释/解读 involve 涉及 issue 问题/议题 labour 劳动力
legal 法律的 legislate 立法 major 主要的 method 方法 occur 发生 percent 百分比 period 时期 policy 政策
principle 原则 proceed 进行 process 过程 require 要求 research 研究 respond 回应 role 角色 section 部分
sector 部门/行业 significant 显著的 similar 相似的 source 来源 specific 具体的 structure 结构 theory 理论 vary 变化
achieve 达成 acquire 获得 administrate 管理 affect 影响 appropriate 恰当的 aspect 方面 assist 协助 category 类别
chapter 章节 commission 委员会/佣金 community 社群 complex 复杂的 compute 计算 conclude 得出结论 conduct 实施
consequent 随之而来的 construct 建构 consume 消费 credit 信贷/学分 culture 文化 design 设计 distinct 明显不同的
element 要素 equate 等同 evaluate 评价 feature 特征 final 最终的 focus 焦点 impact 影响 injure 伤害
institute 机构/设立 invest 投资 item 项目 journal 期刊 maintain 维持 normal 正常的 obtain 获得 participate 参与
perceive 感知 positive 正面的 potential 潜在的 previous 先前的 primary 首要的 purchase 购买 range 范围
region 地区 regulate 监管 relevant 相关的 reside 居住 resource 资源 restrict 限制 secure 保障/稳妥的 seek 寻求
select 挑选 site 场所 strategy 策略 survey 调查 text 文本 tradition 传统 transfer 转移
alternative 替代方案 circumstance 情形 comment 评论 compensate 补偿 component 组成部分 consent 同意
considerable 相当大的 constant 恒定的 constrain 约束 contribute 贡献 convene 召集 coordinate 协调 core 核心
corporate 公司的 correspond 对应/通信 criteria 标准 deduce 推断 demonstrate 论证/展示 document 文件 dominate 主导
emphasis 强调 ensure 确保 exclude 排除 framework 框架 fund 资金 illustrate 举例说明 immigrate 移入
imply 暗示 initial 最初的 instance 实例 interact 互动 justify 证明…正当 layer 层 link 联系 locate 定位
maximise 最大化 minor 次要的 negate 否定 outcome 结果 partner 伙伴 philosophy 哲学 physical 物理的/身体的
proportion 比例 publish 发表 react 反应 register 登记 rely 依赖 remove 移除 scheme 方案 sequence 顺序
shift 转变 specify 明确规定 sufficient 充分的 task 任务 technical 技术性的 technique 技巧 technology 技术
valid 有效的 volume 量/卷
access 获取/进入 adequate 足够的 annual 年度的 apparent 表面上的/明显的 approximate 大致的 attitude 态度
attribute 归因于/属性 civil 民事的/公民的 code 法典/代码 commit 承诺/犯下 communicate 沟通 concentrate 集中
confer 协商/授予 contrast 对比 cycle 周期 debate 辩论 despite 尽管 dimension 维度 domestic 国内的/家庭的
emerge 浮现 error 误差 ethnic 族裔的 goal 目标 grant 授予 hence 因此 hypothesis 假设 implement 实施
implicate 牵连 impose 强加 integrate 整合 internal 内部的 investigate 调查 label 标签 mechanism 机制
obvious 明显的 occupy 占据 option 选项 output 产出 overall 总体的 parallel 平行的 parameter 参数 phase 阶段
predict 预测 principal 主要的/校长 prior 在先的 professional 专业的 project 项目 promote 促进 regime 政体/制度
resolve 解决 retain 保留 series 系列 statistic 统计数据 status 地位/状态 stress 强调/压力 subsequent 随后的
sum 总和 summary 摘要 undertake 着手做
academy 学院 adjust 调整 alter 改变 amend 修订 aware 意识到的 capacity 容量/能力 challenge 挑战 clause 条款
compound 复合物/复合的 conflict 冲突 consult 咨询 contact 接触 decline 下降/拒绝 discrete 离散的 draft 草案
enable 使能够 energy 能量 enforce 执行 entity 实体 equivalent 等价的 evolve 演化 expand 扩张 expose 暴露
external 外部的 facilitate 促进 fundamental 根本的 generate 产生 generation 世代 image 形象 liberal 自由派的
licence 许可 logic 逻辑 margin 边际/差额 medical 医学的 mental 心理的 modify 修改 monitor 监测 network 网络
notion 观念 objective 客观的/目标 orient 定向 perspective 视角 precise 精确的 prime 首要的 psychology 心理学
pursue 追求 ratio 比率 reject 拒绝 revenue 收入/税收 stable 稳定的 style 风格 substitute 替代 sustain 维持
symbol 符号 target 目标 transit 运输/过境 trend 趋势 version 版本 welfare 福利 whereas 然而/鉴于
abstract 抽象的/摘要 accurate 准确的 acknowledge 承认 aggregate 总量/聚合 allocate 分配 assign 指派 attach 附上
author 作者 bond 债券/纽带 brief 简短的 capable 有能力的 cite 引用 cooperate 合作 discriminate 歧视/区分
display 展示 diverse 多样的 domain 领域 edit 编辑 enhance 提升 estate 财产/地产 exceed 超过 expert 专家
explicit 明确的 federal 联邦的 fee 费用 flexible 灵活的 furthermore 此外 gender 性别 ignorant 无知的
incentive 激励 incidence 发生率 incorporate 纳入/法人化 index 指数 inhibit 抑制 initiate 发起 input 投入
instruct 指导 intelligence 智力/情报 interval 间隔 lecture 讲座 migrate 迁移 minimum 最小值 ministry 部
motive 动机 neutral 中立的 nevertheless 尽管如此 overseas 海外的 precede 先于 presume 推定 rational 理性的
recover 恢复 reveal 揭示 scope 范围 subsidy 补贴 tape 磁带 trace 追溯 transform 转变 transport 运输
underlie 构成…的基础 utilise 利用
adapt 适应 adult 成年人 advocate 主张/倡导者 aid 援助 channel 渠道 chemical 化学的 classic 经典的
comprehensive 全面的 comprise 包含 confirm 确认 contrary 相反的 convert 转换 couple 一对 decade 十年
definite 明确的 deny 否认 differentiate 区分 dispose 处置 dynamic 动态的 eliminate 消除 empirical 实证的
equip 装备 extract 提取 file 文件 finite 有限的 foundation 基础/基金会 globe 全球 grade 等级/成绩
guarantee 保证 hierarchy 层级 identical 完全相同的 ideology 意识形态 infer 推断 innovate 创新 insert 插入
intervene 介入 isolate 隔离 media 媒体 mode 模式 paradigm 范式 phenomenon 现象 priority 优先事项
prohibit 禁止 publication 出版物 quote 引述 release 发布 reverse 反转 simulate 模拟 sole 唯一的
somewhat 有点 submit 提交 successor 继任者 survive 幸存 thesis 论点/论文 topic 话题 transmit 传输
ultimate 最终的 unique 独特的 visible 可见的 voluntary 自愿的
abandon 放弃 accompany 伴随 accumulate 累积 ambiguous 含糊的 append 附加 appreciate 理解/感激
arbitrary 武断的/任意的 automate 自动化 bias 偏见 chart 图表 clarify 澄清 commodity 商品 complement 补足
conform 遵从 contemporary 当代的 contradict 矛盾 crucial 至关重要的 currency 货币 denote 表示 detect 检测
deviate 偏离 displace 取代 drama 戏剧 eventual 最终的 exhibit 展现 exploit 利用/剥削 fluctuate 波动
guideline 准则 highlight 突出 implicit 隐含的 induce 引起 inevitable 不可避免的 infrastructure 基础设施
inspect 检查 intense 强烈的 manipulate 操纵 minimise 最小化 nuclear 核的 offset 抵消 paragraph 段落
plus 加 practitioner 从业者 predominant 占主导的 prospect 前景 radical 激进的/根本的 random 随机的
reinforce 强化 restore 恢复 revise 修订 schedule 日程 tense 紧张的/时态 terminate 终止 theme 主题
thereby 从而 uniform 统一的 vehicle 载体/车辆 via 经由 virtual 虚拟的/实际上的 visual 视觉的 widespread 广泛的
accommodate 容纳/迁就 analogy 类比 anticipate 预期 assure 保证 attain 达到 behalf 代表 bulk 大部分/散装
cease 停止 coherent 连贯的 coincide 巧合/重合 commence 开始 incompatible 不相容的 concurrent 并行的
confine 限制 controversy 争议 converse 相反的 device 装置 devote 投入 diminish 减少 distort 扭曲
duration 持续时间 erode 侵蚀 ethic 伦理 format 格式 founded 建立的 inherent 固有的 insight 洞见
integral 不可或缺的 intermediate 中间的 manual 手动的/手册 mature 成熟的 mediate 调解 medium 媒介/中等的
military 军事的 minimal 最低限度的 mutual 相互的 norm 规范 overlap 重叠 passive 被动的 portion 部分
preliminary 初步的 protocol 协议 qualitative 定性的 refine 提炼 relax 放松 restrain 抑制 revolution 革命
rigid 刚性的 route 路线 scenario 情景 sphere 领域 subordinate 从属的 supplement 补充 suspend 暂停
team 团队 temporary 临时的 trigger 触发 unify 统一 violate 违反 vision 视野/愿景
adjacent 毗邻的 albeit 尽管 assemble 组装/集合 collapse 崩溃 colleague 同事 compile 汇编 conceive 构想
convince 说服 depress 压低/使沮丧 encounter 遭遇 enormous 巨大的 forthcoming 即将到来的 incline 倾向
integrity 完整性/正直 intrinsic 内在的 invoke 援引 levy 征收 likewise 同样地 nonetheless 尽管如此
notwithstanding 尽管 odd 奇怪的/奇数的 ongoing 持续进行的 panel 小组/面板 persist 持续 pose 造成/摆姿势
reluctance 不情愿 straightforward 直截了当的 undergo 经历 whereby 凭此
`;

const AWL = new Map();           // 词头 -> 中文
{
  const toks = AWL_RAW.trim().split(/\s+/);
  for (let i = 0; i + 1 < toks.length; i += 2) {
    AWL.set(toks[i].toLowerCase(), toks[i + 1]);
  }
}

/* ---------------------------------------------------------------------------
 * 补充释义表：大学课堂（尤其法学 / 经济学）高频、但 AWL 和术语表都没收的词。
 * 也用来**覆盖**派生词根推出来的错误释义 —— 比如 constitution 会被推成
 * 「构成/组成」（词根 constitute），在宪法课上这是纯粹的误导，必须硬改成「宪法」。
 * 查表顺序：术语表 > EXTRA_GLOSS > AWL 本身 > AWL 词根。
 * ------------------------------------------------------------------------- */
const EXTRA_GLOSS_RAW = `
constitution 宪法 constitutional 宪法的 unconstitutional 违宪的 constitutionality 合宪性
amendment 修正案 statutory 成文法的 doctrine 学说/原则 doctrinal 学理上的 preemption 优先适用/排除适用
preempt 优先适用而排除 preemptive 先发制人的 justiciability 可诉性 justiciable 可受理的
standing 诉讼资格 ripeness 成熟性 mootness 争议消失 moot 已无实益的 dicta 附带意见
dictum 附带意见 mandamus 履行职务令 writ 令状 certiorari 调卷令 habeas 人身保护
plaintiff 原告 defendant 被告 litigant 诉讼当事人 litigate 提起诉讼 plead 答辩/主张
pleading 诉状 posture 诉讼阶段/情势 remand 发回重审 affirm 维持原判 reverse 撤销原判
vacate 撤销 remedial 补救性的 prophylactic 预防性的 congruence 契合 congruent 契合的
proportionality 比例原则 redressability 可救济性 redress 救济 traceable 可追溯到的
grievance 申诉/不满 enumerate 列举 plenary 完全的/全权的 repugnant 抵触的
nullify 使无效 invalidate 使无效 void 无效的 voidable 可撤销的 vest 授予/归属
dormant 休眠的/潜在的 evenhanded 不偏不倚的 facially 表面上 facial 表面上的
discriminatory 歧视性的 nondiscriminatory 非歧视的 deferential 尊重/谦抑的 defer 尊重/推迟
deference 尊重/谦抑 aggregation 累加 aggregate 累加/总量 commandeer 征用/强制指挥
coercive 强制性的 coerce 胁迫 coercion 胁迫 sovereign 主权的 sovereignty 主权
immunity 豁免 immune 豁免的 injunction 禁令 injunctive 禁令性的 declaratory 宣告性的
dissent 异议 dissenting 持异议的 concur 附议 concurring 协同意见的 majority 多数意见
holding 判决要旨 overrule 推翻 precedent 先例 precedential 具先例效力的 stare 遵循
threshold 门槛 substantive 实体性的 procedural 程序性的 scrutiny 审查标准 tier 层级
rational 合理的 compelling 极为重要的 narrowly 严格地 tailored 量身裁剪的
indispensable 不可或缺的 conducive 有助于的 obliterate 抹除 asymmetry 不对称
asymmetric 不对称的 instrumentality 工具/机构 channel 渠道 interstate 州际的 intrastate 州内的
commerce 商业/贸易 tariff 关税 antitrust 反垄断 fiduciary 受信义务的 tort 侵权
negligence 过失 liability 责任 liable 负有责任的 damages 损害赔偿 injunction 禁令
jurisprudence 法理学 legislature 立法机关 legislative 立法的 judiciary 司法机关
judicial 司法的 executive 行政的/执行的 delegate 授权/代表 delegation 授权 ratify 批准
ratification 批准 promulgate 颁布 codify 法典化 charter 特许/章程 municipal 市政的
federalism 联邦制 sovereignty 主权 secession 脱离 abstention 弃权/回避
pervasive 无处不在的 inference 推论 presumption 推定 rebut 反驳 rebuttable 可反驳的
burden 举证责任 prong 要件/分支 nexus 关联 pretext 借口 animus 恶意
elasticity 弹性 equilibrium 均衡 marginal 边际的 surplus 剩余 deficit 赤字
monopoly 垄断 oligopoly 寡头 externality 外部性 subsidy 补贴 inflation 通货膨胀
deflation 通货紧缩 fiscal 财政的 monetary 货币的 utility 效用 scarcity 稀缺
opportunity 机会 tradeoff 权衡取舍 incentive 激励 arbitrage 套利 leverage 杠杆
depreciation 折旧 amortize 摊销 aggregate 总量 endogenous 内生的 exogenous 外生的
heterogeneous 异质的 homogeneous 同质的 regression 回归分析 correlation 相关性
causation 因果关系 covariance 协方差 variance 方差 skew 偏态 outlier 离群值
syllabus 教学大纲 midterm 期中考 prerequisite 先修课 handout 讲义 rubric 评分标准
transcript 成绩单 registrar 教务处 advisor 学业导师 recitation 习题课 curve 调分
plagiarism 抄袭 citation 引注 bibliography 参考文献 appendix 附录 footnote 脚注
belabor 反复纠缠 skim 略读 hypothetical 假设题 outline 提纲
legitimate 正当的/合法的 illegitimate 不正当的 retrospective 溯及既往的
prospective 前瞻性的/未来的 formalistic 形式主义的 progressive 进步主义的
deferential 谦抑的 particularized 具体化的 generalized 泛化的 cumulative 累积的
incidental 附带的 putative 据称的 excessive 过度的 evading 规避 evade 规避
transaction 交易 distortion 扭曲 inelastic 缺乏弹性的 elastic 有弹性的 nonrival 非竞争性的
nonexcludable 非排他性的 negligible 微不足道的 accrue 产生/累积 determinant 决定因素
responsiveness 反应程度 wedge 楔子/价差 sunk 沉没的 diminishing 递减的 optimal 最优的
overproduction 过度生产 bargain 议价 substitute 替代品 necessity 必需品 deadweight 无谓的
invoke 援引 compel 强制 compelling 极具说服力的 conscript 强征 obstruct 妨碍
pervade 弥漫 infer 推断 nullification 废止 abstain 弃权 recuse 回避
`;
const EXTRA_GLOSS = new Map();
{
  const toks = EXTRA_GLOSS_RAW.trim().split(/\s+/);
  for (let i = 0; i + 1 < toks.length; i += 2) EXTRA_GLOSS.set(toks[i].toLowerCase(), toks[i + 1]);
}

/* ===========================================================================
 * 二、形态还原
 * ---------------------------------------------------------------------------
 * 分两层，这个区分很重要，不然会把该收的词漏掉：
 *
 *   lemma()      —— **屈折**变化：复数 -s/-es/-ies、过去式 -ed、-ing、比较级 -er/-est。
 *                   这些不改变词的身份，ruled / rules / ruling 都是 rule。
 *                   这一层的结果就是生词本里的 key。
 *
 *   derivRoots() —— **派生**变化：-tion/-ment/-ness/-ity/-ive/-al/-ous/-ate/-ly ……
 *                   这一层**不**用来合并词条：regulation 和 regulate 对她是两个词，
 *                   听到 regulation 反应不过来不等于认识 regulate。
 *                   它只用来做两件事：
 *                     (a) -ly / -ness 是完全透明的派生（quickly ← quick，
 *                         happiness ← happy），词根认识就算认识；
 *                     (b) 别的派生后缀用来查 AWL 词根、借中文释义、并作为
 *                         「拉丁语源学术词形」的难度信号。
 * ========================================================================= */

const IRREGULAR = new Map(Object.entries({
  children: 'child', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth', geese: 'goose',
  mice: 'mouse', people: 'person', criteria: 'criterion', phenomena: 'phenomenon',
  data: 'datum', analyses: 'analysis', theses: 'thesis', hypotheses: 'hypothesis',
  bases: 'basis', crises: 'crisis', indices: 'index', appendices: 'appendix',
  matrices: 'matrix', vertices: 'vertex', formulae: 'formula', dicta: 'dictum',
  curricula: 'curriculum', memoranda: 'memorandum', media: 'medium', strata: 'stratum',
  // 课堂里最常见的不规则动词（ASR 直接给原文，所以得还原）
  held: 'hold', found: 'find', brought: 'bring', bought: 'buy', taught: 'teach',
  thought: 'think', sought: 'seek', caught: 'catch', paid: 'pay', said: 'say',
  made: 'make', took: 'take', taken: 'take', gave: 'give', given: 'give',
  wrote: 'write', written: 'write', drew: 'draw', drawn: 'draw', arose: 'arise',
  arisen: 'arise', bound: 'bind', struck: 'strike', stricken: 'strike',
  overruled: 'overrule', underlay: 'underlie', underlain: 'underlie',
  lay: 'lie', lain: 'lie', led: 'lead', meant: 'mean', dealt: 'deal',
  chose: 'choose', chosen: 'choose', drove: 'drive', driven: 'drive'
}));

// 以 -s 结尾但本来就是原形的词（不能当复数砍掉）
const S_SINGULAR = new Set([
  'analysis', 'basis', 'thesis', 'crisis', 'hypothesis', 'emphasis', 'synthesis', 'diagnosis',
  'business', 'process', 'access', 'class', 'glass', 'pass', 'press', 'address', 'witness',
  'illness', 'status', 'campus', 'bonus', 'focus', 'virus', 'census', 'consensus', 'surplus',
  'news', 'series', 'species', 'means', 'economics', 'politics', 'physics', 'ethics',
  'statistics', 'mathematics', 'less', 'unless', 'always', 'perhaps', 'yes', 'this', 'us',
  'is', 'was', 'has', 'gas', 'its', 'his', 'thus', 'plus', 'versus', 'dismiss', 'discuss',
  'express', 'assess', 'possess', 'stress', 'cross', 'loss', 'across', 'gross', 'mass'
]);

// 常见双写辅音结尾（跑 -ed/-ing 还原时用）
const DOUBLE_OK = /([bdfglmnprt])\1$/;

function deSuffix(w, suf, adds) {
  if (!w.endsWith(suf) || w.length - suf.length < 2) return [];
  const stem = w.slice(0, w.length - suf.length);
  const out = [];
  // i->y 必须排在最前：murkiest 的正确原形是 murky，不是 murkie
  if (stem.endsWith('i')) out.push(stem.slice(0, -1) + 'y');
  // 双写辅音的还原必须排在**光秃秃的词干之前**：tagged 的原形是 tag 不是 "tagg"，
  // cramming 是 cram 不是 "cramm"。词表查不到时兜底取第一个候选，
  // 排在最后等于这条规则永远用不上（上一版就是这样漏掉的）。
  if (DOUBLE_OK.test(stem)) out.push(stem.slice(0, -1));       // stopped -> stop
  out.push(stem);
  for (const a of adds) out.push(stem + a);
  return out;
}

/** 三张词表里任何一张查得到 —— 说明这是个真实存在的词形 */
function inAnyDict(x) { return KNOWN_BASE.has(x) || AWL.has(x) || EXTRA_GLOSS.has(x); }

/**
 * 屈折还原：返回一个「最可能的原形」。
 * 策略是生成候选，优先返回在已知词表 / AWL 里能查到的那个；
 * 都查不到就返回最保守的那个（通常是直接砍后缀）。
 */
function lemma(raw) {
  let w = String(raw || '').toLowerCase();
  if (!w) return '';
  if (IRREGULAR.has(w)) return IRREGULAR.get(w);
  if (w.length <= 3) return w;

  const inDict = inAnyDict;
  if (inDict(w)) return w;

  // -ly：副词还原。只有还原结果确实在词表里才采纳，
  // 否则 anomaly / assembly / monopoly 会被砍成 anomal / assembl / monopol。
  if (w.endsWith('ly') && w.length > 4) {
    for (const c of [w.slice(0, -2), w.slice(0, -2) + 'e', w.slice(0, -3) + 'y']) {
      if (c.length >= 3 && inDict(c)) return c;
    }
  }

  let cands = [];
  if (w.endsWith('ies') && w.length > 4) cands.push(w.slice(0, -3) + 'y', w.slice(0, -1));
  if (/(ches|shes|sses|xes|zes|oes)$/.test(w)) cands.push(w.slice(0, -2));
  // 拉丁语尾（-us/-is/-as/-os）本来就是单数：mandamus / corpus / habeas / certiorari 一类，
  // 砍成 mandamu 会让整个词条作废，这是上一版实测踩到的坑。
  const latinS = /(us|is|as|os)$/.test(w);
  if (w.endsWith('s') && !w.endsWith('ss') && !latinS && !S_SINGULAR.has(w)) cands.push(w.slice(0, -1));
  if (w.endsWith('ied') && w.length > 4) cands.push(w.slice(0, -3) + 'y');
  if (w.endsWith('ed')) cands.push(...deSuffix(w, 'ed', ['e']));
  if (w.endsWith('ing')) cands.push(...deSuffix(w, 'ing', ['e']));

  // -er / -est：英语里以 -er 收尾的**名词**（filter / buffer / water / Miller / Roediger）
  // 远多于生僻形容词的比较级。砍掉 -er 会造出 "filt" / "buff" / "underwat" / "mill" 这种
  // 英语里根本不存在的串，而它就是印在复习卡正面的那个词。
  // 所以这一档降成「弱候选」：词表里确认得到才用（bigger->big、stronger->strong），
  // 确认不到就保留原词。-ier / -iest 是明确的比较级信号，仍然算强候选（murkiest->murky）。
  const weak = [];
  const iComp = /(ier|iest)$/.test(w);
  if (w.endsWith('est') && w.length > 5) (iComp ? cands : weak).push(...deSuffix(w, 'est', ['e']));
  if (w.endsWith('er') && w.length > 5) (iComp ? cands : weak).push(...deSuffix(w, 'er', ['e']));

  cands = cands.filter(c => c && c.length >= 2);
  for (const c of cands) if (inDict(c)) return c;
  for (const c of weak) if (c && c.length >= 2 && inDict(c)) return c;
  // 词表里都查不到：-ied/-ies/-iest/-ier 一律还原成 -y（studied->study, murkiest->murky），
  // 其余情况取最长候选（最保守），避免把 statutes -> statut 砍太狠。
  if (/(ied|ies|iest|ier)$/.test(w)) {
    const y = cands.find(c => c.endsWith('y'));
    if (y) return y;
  }
  // 兜底取**第一个**候选而不是最长的：deSuffix 已经按「最可能」排好序了，
  // 取最长会把 anticommandeering 还原成 anticommandeere 这种根本不存在的词。
  return cands.length ? cands[0] : w;
}

// 派生后缀表：[后缀, 还原时要试的补字, 是否「完全透明」]
const DERIV = [
  ['ly', ['', 'e'], true],          // quickly <- quick   透明
  ['ness', ['', 'y'], true],        // happiness <- happy 透明（-iness -> y）
  ['ication', ['y', 'ify', 'icate'], false],   // justification <- justify
  // ⚠ ['ation'] 必须排在 ['tion'] 前面。任何 -ation 结尾的词同时也以 -tion 结尾，
  //   排在后面这条规则就**永远轮不到**（上一版就是死代码）：
  //   representation 被剥成 "representa" 而不是 represent，
  //   于是「她认识词根的派生词」全部当成完全陌生的长词，顶到生词本最前面，
  //   把 hippocampus / amygdala 这种真生词挤到 50 名开外。
  ['ations', ['', 'e', 'ate'], false],
  ['ation', ['', 'e', 'ate'], false],  // representation <- represent / regulation <- regulate
  ['tions', ['', 'e', 'te'], false],
  ['sions', ['', 'e', 'd', 'de'], false],
  ['ments', ['', 'e'], false],
  ['tion', ['', 'e', 'te'], false],
  ['sion', ['', 'e', 'd', 'de'], false],
  ['ment', ['', 'e'], false],       // judgment <- judge / enforcement <- enforce
  ['ity', ['', 'e', 'y'], false],   // liability <- liable / validity <- valid
  ['ties', ['ty', 'te'], false],
  ['ive', ['', 'e'], false],        // legislative <- legislate
  ['ative', ['', 'e', 'ate'], false],
  ['ure', ['', 'e', 'ate'], false], // legislature <- legislate
  ['ance', ['', 'e'], false],
  ['ence', ['', 'e'], false],
  ['ant', ['', 'e'], false],
  ['ent', ['', 'e'], false],
  ['able', ['', 'e', 'ate'], false],
  ['ible', ['', 'e'], false],
  ['ical', ['', 'e', 'y'], false],
  ['ial', ['', 'e', 'y'], false],
  ['al', ['', 'e'], false],         // constitutional <- constitution
  ['ous', ['', 'e', 'y'], false],
  ['ism', ['', 'e'], false],
  ['ist', ['', 'e'], false],
  ['ize', ['', 'e'], true],        // internalize <- internal   基本透明
  ['ise', ['', 'e'], true],
  ['ify', ['', 'e', 'y'], false],
  ['ate', ['', 'e'], false],
  ['ory', ['', 'e', 'or'], false],  // regulatory <- regulate
  ['ary', ['', 'e'], false],
  ['ful', ['', 'e'], false],
  ['less', ['', 'e'], false],
  ['er', ['', 'e'], false],         // 名词化 -er：plaintiff? 不，如 employer <- employ
  ['or', ['', 'e'], false]
];

/**
 * 派生还原：返回 { roots:[候选词根…], transparent:bool, suffix:string }
 * 只剥一层 —— 两层（constitutionality → constitutional → constitution）
 * 由调用方递归一次就够了，再深容易还原过头。
 */
function derivStep(w) {
  for (const [suf, adds, transparent] of DERIV) {
    if (!w.endsWith(suf)) continue;
    const stem = w.slice(0, w.length - suf.length);
    if (stem.length < 3) continue;
    const roots = [stem];
    for (const a of adds) if (a) roots.push(stem + a);
    if (stem.endsWith('i')) roots.push(stem.slice(0, -1) + 'y', stem.slice(0, -1) + 'ye');
    if (DOUBLE_OK.test(stem)) roots.push(stem.slice(0, -1));
    return { roots: roots.filter(r => r.length >= 3), transparent, suffix: suf };
  }
  return null;
}

/** 剥到两层为止，返回所有候选词根（含中间形） */
function derivRoots(w) {
  const out = [];
  let cur = w, depth = 0, transparentAll = true, suffixes = [];
  while (depth < 2) {
    const step = derivStep(cur);
    if (!step) break;
    suffixes.push(step.suffix);
    if (!step.transparent) transparentAll = false;
    for (const r of step.roots) if (!out.includes(r)) out.push(r);
    // 下一层从最短候选继续剥（最保守）
    cur = step.roots[0];
    depth++;
  }
  return { roots: out, transparent: transparentAll && suffixes.length > 0, suffixes };
}

/** 她（几乎）肯定认识吗？ */
function isKnownWord(lem) {
  if (KNOWN_BASE.has(lem)) return true;
  const d = derivRoots(lem);
  if (d.transparent) {                     // -ly / -ness：词根认识就算认识
    for (const r of d.roots) if (KNOWN_BASE.has(r)) return true;
  }
  return false;
}

/**
 * 这个词是不是「她认识的词 + 一个常规后缀」？
 * 例：justification ← justify、conditional ← condition、discoverable ← discover。
 * 这类词不该被当成生词排到 mandamus 前面去，但也不能直接扔掉
 * （-tion / -ment 并不像 -ly 那样完全透明，听力里照样会绊一下），所以只降权、不排除。
 */
function derivedFromKnown(lem) {
  const d = derivRoots(lem);
  for (const r of d.roots) if (KNOWN_BASE.has(r) && r.length >= 4) return true;
  return false;
}

/**
 * 查释义。顺序：补充表（精确） > AWL（精确） > 补充表（词根） > AWL（词根）。
 * 精确命中时 root === lem；靠词根猜出来的释义会被调用方标注成「词根 X」，
 * 免得把 constitution 说成「构成」这种事再发生一次。
 */
function awlLookup(lem) {
  if (EXTRA_GLOSS.has(lem)) return { zh: EXTRA_GLOSS.get(lem), root: lem, exact: true, src: 'extra' };
  if (AWL.has(lem)) return { zh: AWL.get(lem), root: lem, exact: true, src: 'awl' };
  const d = derivRoots(lem);
  for (const r of d.roots) if (EXTRA_GLOSS.has(r)) return { zh: EXTRA_GLOSS.get(r), root: r, exact: false, src: 'extra' };
  for (const r of d.roots) if (AWL.has(r)) return { zh: AWL.get(r), root: r, exact: false, src: 'awl' };
  return null;
}

// 拉丁 / 希腊语源的学术词形：这类后缀本身就是「听起来难」的信号
const ACADEMIC_SHAPE = /(tion|sion|ment|ity|ance|ence|ology|ographic|ism|ize|ise|ify|ate|ive|ous|able|ible|ary|ory|eous|ual|ic)$/;
const LATIN_PREFIX = /^(ab|ad|ante|anti|circum|com|con|contra|de|dis|ex|extra|inter|intra|intro|juris|mal|non|ob|per|post|pre|pro|re|retro|sub|super|trans|ultra|counter|quasi)/;

// 这些词在课堂转写里高频出现但没有学习价值（口水 + 板书标记）
const NOISE = new Set([
  'okay', 'alright', 'yeah', 'right', 'well', 'like', 'know', 'mean', 'sort', 'kind', 'thing',
  'stuff', 'guys', 'folks', 'gonna', 'wanna', 'gotta', 'kinda', 'sorta', 'lemme', 'cuz',
  'inaudible', 'crosstalk', 'unintelligible', 'laughter', 'applause', 'silence', 'music'
]);

/* ===========================================================================
 * 三、extractCandidates —— 从一节课里挑生词
 * ========================================================================= */

const WORD_RE = /[A-Za-z][A-Za-z'’-]*/g;

/** 去掉所有格和常见缩写尾巴 */
function normWord(s) {
  return String(s || '')
    .replace(/[’]/g, "'")
    .replace(/'(s|ll|ve|re|d|m)$/i, '')
    .replace(/n't$/i, '')
    .replace(/^[-']+|[-']+$/g, '')
    .toLowerCase();
}

/** 把 session 整理成句子列表；优先复用 localnlp 的切句结果，这样定义句/考点句的下标能直接对上 */
function buildCorpus(session, opts) {
  const segs = Array.isArray(session) ? session
    : (session && Array.isArray(session.segments) ? session.segments : []);
  const usable = segs.filter(s => s && s.kind !== 'mark' && s.kind !== 'note' && String(s.text || '').trim());

  let analysis = opts && opts.analysis;
  if (!analysis) {
    try { analysis = analyze(usable); } catch (_) { analysis = null; }
  }
  if (analysis && Array.isArray(analysis.sentences) && analysis.sentences.length) {
    return { sentences: analysis.sentences, analysis };
  }
  // 兜底：analyze 挂了也要能出词
  return {
    sentences: usable.map((s, i) => ({
      i, t: Number(s.t) || 0, text: String(s.text), zh: s.zh || '', segId: s.id, words: 0
    })),
    analysis: null
  };
}

/**
 * 从一节课的 segments 里挑出她可能不认识的词。
 *
 * @param {Object} session  {id,title,segments:[{id,t,text,zh,kind}], courseId, ...}
 * @param {Object} opts     {max=60, known=Set<string>, analysis=localnlp 的结果（可选，省一次重算）,
 *                           minScore=1.0, properNouns=true}
 * @returns {Array<{word,lemma,count,firstAt,sentences,score,why,level,zh,field}>}
 */
export function extractCandidates(session, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : 60;
  const knownSet = opts.known instanceof Set ? opts.known
    : new Set(Array.isArray(opts.known) ? opts.known.map(w => String(w).toLowerCase()) : []);
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 1.0;
  const wantProper = opts.properNouns !== false;

  const { sentences, analysis } = buildCorpus(session, opts);
  if (!sentences.length) return [];

  // --- 1. 定义句 / 考点句下标 ---
  const defIdx = new Map();     // 句子下标 -> 被定义的词（可能为空串）
  const empIdx = new Set();
  if (analysis) {
    for (const d of (analysis.definitions || [])) defIdx.set(d.i, String(d.term || ''));
    for (const e of (analysis.emphases || [])) if ((e.weight || 0) >= 1.5) empIdx.add(e.i);
  }

  // --- 2. 术语表命中：多词术语单独成条，并记下被覆盖的字符区间 ---
  const termAgg = new Map();    // 术语原形(小写) -> 聚合
  const covered = new Map();    // 句子下标 -> [[start,end], ...]
  for (const s of sentences) {
    let hits = [];
    try { hits = findTerms(s.text) || []; } catch (_) { hits = []; }
    if (!hits.length) continue;
    const ranges = [];
    for (const h of hits) {
      ranges.push([h.start, h.end]);
      const key = String(h.en || '').toLowerCase();
      if (!key) continue;
      let a = termAgg.get(key);
      if (!a) {
        a = { word: h.en, zh: h.zh || '', note: h.note || '', field: h.field || '',
              multi: /\s/.test(h.en), count: 0, firstAt: s.t, sents: [] };
        termAgg.set(key, a);
      }
      a.count++;
      if (a.sents.length < 8) a.sents.push(s);
    }
    covered.set(s.i, ranges);
  }

  // --- 3. 逐词统计 ---
  const agg = new Map();        // lemma -> 统计
  for (const s of sentences) {
    const ranges = covered.get(s.i) || [];
    const inDef = defIdx.has(s.i);
    const inEmp = empIdx.has(s.i);
    WORD_RE.lastIndex = 0;
    let m, pos = 0;
    while ((m = WORD_RE.exec(s.text))) {
      const surface = m[0];
      const start = m.index;
      pos++;
      const w = normWord(surface);
      if (!w || w.length < 3) continue;
      if (NOISE.has(w)) continue;
      if (/^\d+$/.test(w)) continue;

      const lem = lemma(w);
      if (!lem || lem.length < 3) continue;

      // 被多词术语吃掉的位置：记一笔覆盖，后面用来压掉「due」「process」这种碎片
      const isCovered = ranges.some(([a, b]) => start >= a && start < b);

      let a = agg.get(lem);
      if (!a) {
        a = { lemma: lem, surfaces: new Map(), count: 0, coveredCount: 0,
              firstAt: s.t, sents: [], defHit: 0, empHit: 0, capMid: 0, capTotal: 0, allCapsHit: 0 };
        agg.set(lem, a);
      }
      a.count++;
      if (isCovered) a.coveredCount++;
      if (inDef) a.defHit++;
      if (inEmp) a.empHit++;
      a.surfaces.set(surface, (a.surfaces.get(surface) || 0) + 1);
      // 专有名词判定：句中（非首词）出现大写
      if (/^[A-Z]/.test(surface)) { a.capTotal++; if (pos > 1) a.capMid++; }
      if (/^[A-Z]{2,}$/.test(surface)) a.allCapsHit++;
      if (a.sents.length < 12 && !a.sents.some(x => x.i === s.i)) a.sents.push(s);
    }
  }

  // --- 3b. 哑音 e 的裂条合并 ---
  // 词干还原不可能百分百准：encoding 会被剥成 "encod"，而同一节课里的 encode 还原成 "encode"，
  // 同一个词裂成两条、次数各算一半，排名一起往下掉。
  // 凡是**词表里查不到**的词干（说明它多半是剥出来的、不是真词形），
  // 只要加个 e 正好等于另一条已存在的词条，就并过去。
  // 只动查不到的那一档，所以 hop/hope、tap/tape 这类真·不同词不会被误并。
  for (const key of [...agg.keys()]) {
    if (inAnyDict(key)) continue;
    const dst = agg.get(key + 'e'), src = agg.get(key);
    if (!dst || !src) continue;
    dst.count += src.count; dst.coveredCount += src.coveredCount;
    dst.defHit += src.defHit; dst.empHit += src.empHit;
    dst.capMid += src.capMid; dst.capTotal += src.capTotal; dst.allCapsHit += src.allCapsHit;
    dst.firstAt = Math.min(dst.firstAt, src.firstAt);
    for (const [sf, n] of src.surfaces) dst.surfaces.set(sf, (dst.surfaces.get(sf) || 0) + n);
    for (const s of src.sents) if (dst.sents.length < 12 && !dst.sents.some(x => x.i === s.i)) dst.sents.push(s);
    agg.delete(key);
  }

  // 多词术语的成分词：收了 "Supreme Court" 就不该再单独收一条 "Supreme"。
  // 只有当这个词**脱离术语单独出现**至少 2 次时才值得单收（比如 commerce 就该单收）。
  const termParts = new Set();
  for (const [key, a] of termAgg) {
    if (!a.multi) continue;
    for (const p of key.split(/[^a-z']+/)) if (p.length >= 3) termParts.add(lemma(p));
  }

  // --- 4. 打分 ---
  const out = [];
  const seen = new Set();

  const pushCand = c => {
    const k = c.lemma.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };

  // 例句挑选：这些句子最后会印在复习卡上，也是她点回去听原声的锚点，
  // 所以不能简单取前三句 —— 老师写板书时随口说的那句 "Preemption." 当例句毫无用处。
  // 优先级：长度适中（听得出完整意思）> 已有中文译文 > 是定义句 > 时间靠前。
  const sampleSents = (list, n = 3) => {
    const scored = list.map(s => {
      const wc = (String(s.text).match(/[A-Za-z']+/g) || []).length;
      let v = 0;
      if (wc >= 8 && wc <= 32) v += 3;
      else if (wc >= 5) v += 1.5;
      else v -= 2;                       // "Preemption." 这种碎句压到最后
      if (s.zh) v += 1;
      if (defIdx.has(s.i)) v += 2;
      else if (empIdx.has(s.i)) v += 1;
      return { s, v };
    });
    scored.sort((a, b) => b.v - a.v || a.s.t - b.s.t);
    return scored.slice(0, n)
      .sort((a, b) => a.s.t - b.s.t)     // 选完再按时间排，听起来才顺
      .map(({ s }) => ({
        t: Number(s.t) || 0,
        at: mmss(Number(s.t) || 0),
        text: s.text,
        zh: s.zh || '',
        segId: s.segId || ''
      }));
  };

  // 4a. 术语表命中（含多词术语）—— 学科核心词，最高优先级
  for (const [key, a] of termAgg) {
    const lem = a.multi ? key : lemma(key);
    if (knownSet.has(key) || knownSet.has(lem)) continue;
    // 单词术语如果她肯定认识（比如 glossary 里收了个常用词），仍然收 —— 术语表是人工挑的，可信
    const stat = agg.get(lem);
    const defHit = stat ? stat.defHit : 0;
    const empHit = stat ? stat.empHit : 0;
    let score = 4.2 + Math.log2(1 + a.count) * 1.1;
    if (a.multi) score += 0.8;                      // 多词固定搭配她更不可能猜出来
    if (defHit) score += 2.2;
    if (empHit) score += 1.2;
    const why = [];
    why.push(a.field ? `学科术语（${fieldCN(a.field)}）` : '学科术语');
    if (defHit) why.push('老师专门下过定义');
    else if (empHit) why.push('出现在考点句里');
    if (a.count >= 3) why.push(`本节出现 ${a.count} 次`);
    pushCand({
      word: a.word, lemma: lem, count: a.count, firstAt: a.firstAt,
      sentences: sampleSents(a.sents), score: round2(score),
      why: why.slice(0, 2).join(' · '), level: 'core',
      zh: a.zh + (a.note ? a.note : ''), field: a.field
    });
  }

  // 4b. 普通词 / 学术词
  for (const [lem, a] of agg) {
    if (seen.has(lem)) continue;
    if (knownSet.has(lem)) continue;
    if (isKnownWord(lem)) continue;                 // 高频词表：她肯定认识，跳过

    // 被多词术语吃掉的词（due / process 出现在 "due process" 里）：
    // 脱离术语的独立出现不足 2 次就不单收。
    const solo = a.count - a.coveredCount;
    if (termParts.has(lem) && solo < 2) continue;
    if (a.count > 0 && a.coveredCount / a.count >= 0.8) continue;

    const surface = bestSurface(a.surfaces);
    // 卡片正面印的那个词**必须是英语里真实存在的词形**。词干是算法剥出来的，
    // 词表里查不到、课堂上也没原样出现过（"encod" / "filt" / "tulv"）就一定是假词，
    // 这时改印她实际听到的那个词形。lemma 仍然当去重 key 不变。
    const seenSurface = new Set([...a.surfaces.keys()].map(x => normWord(x)));
    const display = (inAnyDict(lem) || seenSurface.has(lem)) ? lem : (normWord(surface) || lem);
    const proper = a.capTotal > 0 && a.capMid / Math.max(1, a.count) >= 0.6 && !AWL.has(lem);
    if (proper && !wantProper) continue;

    const awl = awlLookup(lem);
    let level = awl ? 'academic' : 'general';
    const why = [];
    // 「完全陌生」：三张词表都查不到、也不是认识的词加后缀。见下面起评分那段的说明。
    const opaque = !awl && !derivedFromKnown(lem);

    // ---- 起评分：「她有多大概率不认识这个词」----
    // 关键判断（上一版就是这里错了）：一个词**同时**不在 2500 高频表、也不在 AWL 里，
    // 说明它在日常英语里罕见 —— redressability / plenary / repugnant / mandamus 就是这一类，
    // 恰恰是把她整句听力打断的那种词，应该排在 capacity / category 这种 AWL 词**前面**。
    // AWL 词属于「背过但反应不过来」的中间档，起评分反而要低一点。
    let score;
    if (awl && awl.exact && awl.src === 'extra') {
      // 补充表是人工挑的大学课堂必学词（mandamus / plenary / ripeness / 弹性 / 边际……），
      // 一次没听懂就整句丢掉，优先级要压过 capacity / category 这种泛用学术词。
      score = 3.4;
      why.push('大学课堂高频专业词，日常英语里基本见不到');
    } else if (awl) {
      score = 2.0 + (lem.length >= 10 ? 0.6 : 0);
      why.push(awl.root === lem
        ? '学术通用词，各科都会碰到'
        : `学术词（词根 ${awl.root} ${awl.zh}）`);
    } else if (!opaque) {
      // 高频词加常规后缀：降到最低档，只有反复出现或进了定义句才可能翻身
      score = 0.9;
      why.push('常见词的派生形，听的时候容易反应慢半拍');
    } else {
      // 走到这里说明这个词**同时**满足：不在 2713 高频表、不在 AWL、也不是任何
      // 她认识的词加后缀 —— 它在日常英语里根本见不到，对她就是一团完全陌生的音
      // （hippocampus / amygdala / anterograde / mnemonic / dichotic / heuristic）。
      // 这正是把整句听力打断的那一类，必须压过「背过但反应不过来」的 AWL 词（2.0）
      // 和派生词（0.9）。
      //
      // ⚠ 上一版这里只按长度给分（6 字母起评 1.3），等于默认「难词 = 长词」。
      //   那只在法学/经济学成立，因为补充释义表恰好是按这两科挑的。
      //   换成心理学实测：cortex(6) / amnesia(7) / amygdala(8) 全掉到 AWL 词下面，
      //   hippocampus 排到 57 名、amygdala 163 名、cortex 216 名，
      //   而 capacity 那一档的泛用词排在前面 —— 跟作者自己说要避免的错法一模一样。
      //   所以改成「陌生」本身就是高分信号，长度只做微调。
      score = 2.8 + (lem.length >= 12 ? 0.6 : lem.length >= 9 ? 0.4 : lem.length >= 7 ? 0.2 : 0);
      why.push(lem.length >= 9
        ? '日常英语里根本见不到的长词，最容易一听就断片'
        : '日常英语里根本见不到的词，一听就断片');
    }

    score += Math.log2(1 + a.count) * 1.15;
    if (a.defHit) { score += 2.3; why.unshift('老师在定义句里用了它'); }
    else if (a.empHit) { score += 1.3; why.unshift('出现在考点句里'); }
    if (a.count >= 4) why.push(`本节出现 ${a.count} 次，是这节课的高频词`);
    else if (a.count >= 2) why.push(`本节出现 ${a.count} 次`);

    if (ACADEMIC_SHAPE.test(lem)) score += 0.6;
    if (LATIN_PREFIX.test(lem) && lem.length >= 8) score += 0.3;

    if (proper) {
      // 专有名词（Marbury / Lochner / Rehnquist）：她当然不认识，但这是「记住」而不是「学会」，
      // 起评分压到真正的词汇下面，只有反复出现才值得进生词本。
      level = 'core';
      score = 1.5 + Math.log2(1 + a.count) * 1.15 + (a.defHit ? 1.2 : 0) + (a.empHit ? 0.8 : 0);
      why.length = 0;
      why.push(a.allCapsHit ? '本节反复出现的缩写/专名' : '专有名词（案例名、人名、机构名）');
      if (a.count >= 3) why.push(`本节出现 ${a.count} 次，八成要考`);
      if (a.count < 2) score -= 1.0;                // 只蹦一次的大写词多半是识别噪声
    }

    // 只出现一次、又没进定义句/考点句的短词：多半是老师随口一提，降权。
    // 但**完全陌生的词不适用** —— cortex / gyrus / dicta 只有六七个字母，
    // 在她耳朵里照样是一团听不懂的音，出现一次也值得收。
    // （上一版这条把 cortex 压到 197 名、amygdala 压到 140 名。）
    if (!opaque && a.count === 1 && !a.defHit && !a.empHit && lem.length < 7) score -= 1.2;

    if (score < minScore) continue;
    pushCand({
      word: proper ? surface : display,
      lemma: lem, count: a.count, firstAt: a.firstAt,
      sentences: sampleSents(a.sents),
      score: round2(score),
      why: why.slice(0, 2).join(' · ') || '本节的生词',
      level,
      // 专有名词不借词根释义（Amendment 借 amend 会变成「修订」，是错的）；
      // 靠词根猜出来的释义一律标注，绝不冒充精确释义。
      zh: !awl ? '' : awl.exact ? awl.zh : (proper ? '' : `${awl.zh}（词根 ${awl.root}）`),
      field: ''
    });
  }

  out.sort((x, y) => y.score - x.score || x.firstAt - y.firstAt);
  return out.slice(0, max);
}

function bestSurface(map) {
  let best = '', n = -1;
  for (const [s, c] of map) if (c > n) { best = s; n = c; }
  return best;
}
function round2(x) { return Math.round(x * 100) / 100; }

const FIELD_CN = {
  law: '法律', stats: '统计', econ_: '经济', econ: '经济', economics: '经济', business: '商科', cs: '计算机', math: '数学',
  stat: '统计', statistics: '统计', bio: '生物', biology: '生物', chem: '化学', chemistry: '化学',
  physics: '物理', psych: '心理学', psychology: '心理学', socio: '社会学', sociology: '社会学',
  history: '历史', philosophy: '哲学', poli: '政治学', politics: '政治学', medicine: '医学',
  engineering: '工程', edu: '教育', campus: '校园', academic: '通用学术'
};
function fieldCN(f) { return FIELD_CN[String(f || '').toLowerCase()] || f || '专业'; }

/* ===========================================================================
 * 四、生词本：合并 / 间隔重复
 * ---------------------------------------------------------------------------
 * book 结构（纯 JSON，可直接 put 进 IndexedDB）：
 * {
 *   v: 1, id, createdAt, updatedAt,
 *   words: {
 *     "<lemma 小写>": {
 *       word, lemma, zh, level, field,
 *       count,                      // 跨课累计出现次数
 *       why,                        // 最强的一条收录理由（中文）
 *       firstSeen, lastSeen,
 *       sessions: [{id,title,course,at}],            // 出处课程，最多 5
 *       sentences: [{text,zh,t,at,segId,sessionId,sessionTitle}],  // 例句最多 5，优先留不同课
 *       srs: {state,reps,lapses,ef,interval,due,last,known}
 *     }
 *   }
 * }
 * ========================================================================= */

const DAY = 86400000;

function newSrs(now) {
  return {
    state: 'new',      // new / learning / review / mastered
    reps: 0,           // 连续答对次数
    lapses: 0,         // 「没记住」的次数
    ef: 2.5,           // 难度系数（SM-2 的 easiness factor）
    interval: 0,       // 当前间隔（天）
    due: now,          // 到期时间戳（新词立刻到期）
    last: 0,           // 上次复习时间
    known: false       // 她手动标记「这个我认识」
  };
}

export function emptyBook(id) {
  const now = Date.now();
  return { v: 1, id: id || 'vocab-book', createdAt: now, updatedAt: now, words: {} };
}

function ensureBook(book) {
  if (!book || typeof book !== 'object') return emptyBook();
  if (!book.words || typeof book.words !== 'object') book.words = {};
  if (!book.v) book.v = 1;
  if (!book.createdAt) book.createdAt = Date.now();
  return book;
}

/**
 * 把一节课的候选词合并进生词本。
 * 同一个词跨课累积次数；例句最多留 5 条，**优先留来自不同课的**，
 * 这样她复习时能看到这个词在不同语境下怎么用。
 *
 * @param {Object} book          已有生词本（可传 null，会自动新建）
 * @param {Array}  candidates    extractCandidates 的结果
 * @param {Object} sessionMeta   {id, title, course, teacher, startedAt}
 */
export function mergeIntoBook(book, candidates, sessionMeta = {}) {
  const b = ensureBook(book);
  const now = Date.now();
  const sid = String(sessionMeta.id || '');
  const stitle = String(sessionMeta.title || '');
  const scourse = String(sessionMeta.course || sessionMeta.courseName || '');
  const sat = Number(sessionMeta.startedAt) || now;

  for (const c of (candidates || [])) {
    if (!c || !c.lemma) continue;
    const key = String(c.lemma).toLowerCase();
    let e = b.words[key];
    if (!e) {
      e = {
        word: c.word || c.lemma, lemma: key, zh: c.zh || '', level: c.level || 'general',
        field: c.field || '', count: 0, why: c.why || '', score: c.score || 0,
        firstSeen: sat, lastSeen: sat, sessions: [], sentences: [], srs: newSrs(now)
      };
      b.words[key] = e;
    }
    e.count += Number(c.count) || 1;
    e.lastSeen = Math.max(e.lastSeen || 0, sat);
    e.firstSeen = Math.min(e.firstSeen || sat, sat);
    if (!e.zh && c.zh) e.zh = c.zh;
    if (!e.field && c.field) e.field = c.field;
    // level 只升不降：general -> academic -> core
    const rank = { general: 0, academic: 1, core: 2 };
    if ((rank[c.level] ?? 0) > (rank[e.level] ?? 0)) { e.level = c.level; e.why = c.why || e.why; }
    if ((c.score || 0) > (e.score || 0)) { e.score = c.score; if (c.why) e.why = c.why; }

    if (sid && !e.sessions.some(s => s.id === sid)) {
      e.sessions.push({ id: sid, title: stitle, course: scourse, at: sat });
      if (e.sessions.length > 5) e.sessions = e.sessions.slice(-5);
    }

    // 例句合并：先去重，再按「课程多样性」裁剪
    for (const s of (c.sentences || [])) {
      const text = String(s.text || '').trim();
      if (!text) continue;
      if (e.sentences.some(x => x.text === text)) continue;
      e.sentences.push({
        text, zh: s.zh || '', t: Number(s.t) || 0, at: s.at || mmss(Number(s.t) || 0),
        segId: s.segId || '', sessionId: sid, sessionTitle: stitle
      });
    }
    e.sentences = pickDiverse(e.sentences, 5);
  }

  b.updatedAt = now;
  return b;
}

/** 例句裁剪：每节课先各留一条，不够 5 条再回头补 */
function pickDiverse(list, n) {
  if (list.length <= n) return list;
  const bySession = new Map();
  for (const s of list) {
    const k = s.sessionId || '';
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push(s);
  }
  const out = [];
  let round = 0;
  while (out.length < n && round < 20) {
    let added = false;
    for (const arr of bySession.values()) {
      if (arr.length > round) { out.push(arr[round]); added = true; if (out.length >= n) break; }
    }
    if (!added) break;
    round++;
  }
  return out.slice(0, n);
}

/* ---------------------------- 简化版 SM-2 ---------------------------- */

/**
 * 复习队列。出队顺序：
 *   1. 标记过「没记住」且已到期的（bucket 1）—— 刚答错的词排最前
 *   2. 新词（bucket 0）和到期复习（bucket 2）**交替**出队
 *   3. 还没到期的（bucket 3）只用来凑满 limit
 * 同一档里：逾期久的 / 出现次数多的排前面。
 *
 * @param {Object} book
 * @param {Object} opts {limit=20, now=Date.now(), level, includeMastered=false}
 */
export function reviewQueue(book, opts = {}) {
  const b = ensureBook(book);
  const limit = Number.isFinite(opts.limit) ? opts.limit : 20;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const wantLevel = opts.level || '';

  const rows = [];
  for (const key of Object.keys(b.words)) {
    const e = b.words[key];
    if (!e || !e.srs) continue;
    if (e.srs.known) continue;                                   // 她说认识 -> 不再考
    if (wantLevel && e.level !== wantLevel) continue;
    if (e.srs.state === 'mastered' && !opts.includeMastered && e.srs.due > now) continue;

    const due = Number(e.srs.due) || 0;
    const overdue = now - due;
    let bucket;
    if (e.srs.state === 'new') bucket = 0;
    else if (overdue >= 0 && e.srs.lapses > 0) bucket = 1;
    else if (overdue >= 0) bucket = 2;
    else bucket = 3;

    rows.push({
      word: e.word, lemma: e.lemma, zh: e.zh, level: e.level, why: e.why,
      count: e.count, due, overdueDays: Math.floor(overdue / DAY),
      state: e.srs.state, reps: e.srs.reps, lapses: e.srs.lapses,
      interval: e.srs.interval, ef: e.srs.ef,
      sentences: e.sentences, sessions: e.sessions,
      bucket
    });
  }

  const lapsed = rows.filter(r => r.bucket === 1)
    .sort((a, c) => (c.overdueDays - a.overdueDays) || (c.lapses - a.lapses));
  const fresh = rows.filter(r => r.bucket === 0)
    .sort((a, c) => (c.count - a.count) || a.word.localeCompare(c.word));
  const due = rows.filter(r => r.bucket === 2)
    .sort((a, c) => (c.overdueDays - a.overdueDays) || (c.count - a.count));
  const future = rows.filter(r => r.bucket === 3).sort((a, c) => a.due - c.due);

  // 「没记住」的排最前 —— 刚答错的词十分钟后就该再撞一次。
  // 然后新词和到期复习**交替**出队：生词本攒到一两百个新词之后，
  // 如果按桶硬排，到期要复习的词会被新词整块埋掉，永远轮不到，等于间隔重复失效。
  const out = lapsed.slice();
  for (let i = 0, j = 0; i < fresh.length || j < due.length;) {
    if (i < fresh.length) out.push(fresh[i++]);
    if (j < due.length) out.push(due[j++]);
  }
  out.push(...future);
  return out.slice(0, limit);
}

/**
 * 复习反馈。ok=true「记住了」/ ok=false「没记住」。
 * 简化版 SM-2：
 *   记住了 -> q=4，间隔 1天 -> 3天 -> interval*ef，ef 不变
 *   没记住 -> q=2，reps 归零、lapses+1、ef 降 0.32（下限 1.3）、10 分钟后重来
 *   连续答对 >=4 次且间隔 >=21 天 -> 标记 mastered
 * 返回同一个 book（已就地更新），方便 `book = grade(book, w, true)` 这样写。
 */
export function grade(book, word, ok, opts = {}) {
  const b = ensureBook(book);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const key = String(word || '').toLowerCase();
  const e = b.words[key] || b.words[lemma(key)];
  if (!e) return b;
  if (!e.srs) e.srs = newSrs(now);
  const s = e.srs;
  // book 会在 IndexedDB 里跨版本长期躺着，也可能被导入/手改过。
  // srs 里只要缺一个数字字段，下面的算式立刻算出 NaN，due=NaN 之后
  // 这个词会永远卡在复习队列最前面，而且再也修不回来。先补齐。
  if (!Number.isFinite(s.ef) || s.ef < 1.3) s.ef = 2.5;
  if (!Number.isFinite(s.reps) || s.reps < 0) s.reps = 0;
  if (!Number.isFinite(s.lapses) || s.lapses < 0) s.lapses = 0;
  if (!Number.isFinite(s.interval) || s.interval < 0) s.interval = 0;
  if (!Number.isFinite(s.due)) s.due = now;

  if (ok) {
    const q = 4;
    s.ef = Math.max(1.3, s.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    s.reps += 1;
    if (s.reps === 1) s.interval = 1;
    else if (s.reps === 2) s.interval = 3;
    else s.interval = Math.max(1, Math.round(s.interval * s.ef));
    if (s.interval > 365) s.interval = 365;
    s.due = now + s.interval * DAY;
    s.state = (s.reps >= 4 && s.interval >= 21) ? 'mastered' : 'review';
  } else {
    const q = 2;
    s.ef = Math.max(1.3, s.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    s.reps = 0;
    s.lapses += 1;
    s.interval = 0;
    s.due = now + 10 * 60000;          // 10 分钟后再来一次
    s.state = 'learning';
  }
  s.last = now;
  b.updatedAt = now;
  return b;
}

/** 她标记「这个词我本来就认识」—— 以后不再出现在队列里，也不会再被 extract 收 */
export function markKnown(book, word, known = true) {
  const b = ensureBook(book);
  const key = String(word || '').toLowerCase();
  const e = b.words[key] || b.words[lemma(key)];
  if (e) { if (!e.srs) e.srs = newSrs(Date.now()); e.srs.known = !!known; b.updatedAt = Date.now(); }
  return b;
}

/** 供 extractCandidates 的 opts.known 用：把生词本里「已掌握 / 已认识」的词导出成 Set */
export function knownSet(book, opts = {}) {
  const b = ensureBook(book);
  const includeMastered = opts.includeMastered !== false;
  const out = new Set();
  for (const key of Object.keys(b.words)) {
    const e = b.words[key];
    if (!e || !e.srs) continue;
    if (e.srs.known || (includeMastered && e.srs.state === 'mastered')) out.add(key);
  }
  return out;
}

/* ===========================================================================
 * 五、导出
 * ========================================================================= */

const LEVEL_CN = { core: '学科核心', academic: '学术通用', general: '普通生词' };

function sortedEntries(book, opts = {}) {
  const b = ensureBook(book);
  const rank = { core: 0, academic: 1, general: 2 };
  return Object.keys(b.words)
    .map(k => b.words[k])
    .filter(e => e && (opts.includeKnown || !(e.srs && e.srs.known)))
    .filter(e => !opts.level || e.level === opts.level)
    .sort((a, c) =>
      (rank[a.level] ?? 3) - (rank[c.level] ?? 3) ||
      (c.score || 0) - (a.score || 0) ||
      (c.count || 0) - (a.count || 0) ||
      a.lemma.localeCompare(c.lemma));
}

/** Anki 字段转义：制表符会把字段切断、换行会把行切断，都必须处理掉 */
function ankiField(s, html) {
  let t = String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ');
  if (html) {
    t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
         // Anki 的 TSV 解析器沿用 CSV 的引号规则：**以双引号开头的字段**会被当成引号字段，
         // 读到下一个引号就截断。老师课上引用一句带引号的话、或课程名带引号，
         // 整张卡片的背面就会在那儿断掉。实体化最省事，Anki 渲染出来照样是引号。
         .replace(/"/g, '&quot;')
         .replace(/\n/g, '<br>');
  } else {
    t = t.replace(/\n/g, ' ').replace(/"/g, '');
  }
  return t;
}

/**
 * 导出成 Anki 能直接导入的 TSV。
 * 正面 = 英文单词；背面 = 中文释义 + 例句（带原句中文）+ 出处课程；第三列 = 标签。
 *
 * @param {Object} book
 * @param {Object} opts {deck='晗晗·课堂生词', tags=[], html=true, includeMastered=false,
 *                       includeKnown=false, level='', limit=0, maxSentences=2}
 */
export function toAnki(book, opts = {}) {
  const html = opts.html !== false;
  const deck = String(opts.deck || '晗晗·课堂生词');
  const extraTags = (opts.tags || []).map(t => String(t).replace(/\s+/g, '_'));
  const maxS = Number.isFinite(opts.maxSentences) ? opts.maxSentences : 2;

  let rows = sortedEntries(book, opts);
  if (!opts.includeMastered) rows = rows.filter(e => !(e.srs && e.srs.state === 'mastered'));
  if (opts.limit > 0) rows = rows.slice(0, opts.limit);

  const lines = [
    '#separator:tab',
    '#html:' + (html ? 'true' : 'false'),
    '#columns:Front\tBack\tTags',
    '#deck:' + deck.replace(/\t/g, ' ')
  ];

  for (const e of rows) {
    const back = [];
    if (e.zh) back.push(e.zh);
    if (e.why) back.push('【为什么收它】' + e.why);
    const ss = (e.sentences || []).slice(0, maxS);
    if (ss.length) {
      back.push('');
      for (const s of ss) {
        back.push('· ' + s.text + (s.zh ? '\n  ' + s.zh : '') + '  [' + (s.at || '') + ']');
      }
    }
    const src = (e.sessions || []).map(x => x.course || x.title).filter(Boolean);
    if (src.length) back.push('', '出处：' + [...new Set(src)].join('、'));

    const tags = ['课堂生词', LEVEL_CN[e.level] || e.level, ...extraTags]
      .concat((e.sessions || []).map(x => String(x.course || '').replace(/\s+/g, '_')).filter(Boolean))
      .filter(Boolean);

    lines.push([
      ankiField(e.word, html),
      ankiField(back.join('\n'), html),
      ankiField([...new Set(tags)].join(' '), false)
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** CSV（RFC4180 引号转义），Excel / Numbers 直接能开 */
export function toCSV(book) {
  const q = s => {
    const t = String(s == null ? '' : s).replace(/\r\n?/g, '\n');
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const head = ['单词', '中文', '难度档', '学科', '累计出现', '收录理由',
                '例句1', '例句1中文', '例句1时间', '出处课程',
                '状态', '复习次数', '没记住次数', '下次复习'];
  const lines = [head.map(q).join(',')];
  for (const e of sortedEntries(book, { includeKnown: true })) {
    const s0 = (e.sentences || [])[0] || {};
    const srs = e.srs || {};
    lines.push([
      e.word, e.zh || '', LEVEL_CN[e.level] || e.level, fieldCN(e.field) === e.field ? (e.field || '') : fieldCN(e.field),
      e.count || 0, e.why || '',
      s0.text || '', s0.zh || '', s0.at || '',
      [...new Set((e.sessions || []).map(x => x.course || x.title).filter(Boolean))].join('；'),
      srs.known ? '已认识' : (srs.state || 'new'),
      srs.reps || 0, srs.lapses || 0,
      srs.due ? new Date(srs.due).toISOString().slice(0, 10) : ''
    ].map(q).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Markdown：打印出来贴墙上 / 上课前扫一眼那种 */
export function toMarkdown(book) {
  const b = ensureBook(book);
  const st = bookStats(b);
  const out = [];
  out.push('# 我的课堂生词本');
  out.push('');
  out.push(`共 **${st.total}** 个词　·　学科核心 ${st.byLevel.core}　学术通用 ${st.byLevel.academic}　普通生词 ${st.byLevel.general}`);
  out.push(`今天该复习 **${st.dueToday}** 个　·　已掌握 ${st.mastered} 个　·　本周新增 ${st.newThisWeek} 个`);
  out.push('');
  out.push('> 上课前花三分钟扫一遍「学科核心」，这节课就不会被同一个词卡住第二次。');
  out.push('');

  for (const level of ['core', 'academic', 'general']) {
    const rows = sortedEntries(b, { level });
    if (!rows.length) continue;
    out.push(`## ${LEVEL_CN[level]}（${rows.length}）`);
    out.push('');
    for (const e of rows) {
      const head = `### ${e.word}` + (e.zh ? ` —— ${e.zh}` : '');
      out.push(head);
      const meta = [];
      if (e.count) meta.push(`累计出现 ${e.count} 次`);
      if (e.why) meta.push(e.why);
      const src = [...new Set((e.sessions || []).map(x => x.course || x.title).filter(Boolean))];
      if (src.length) meta.push('出处：' + src.join('、'));
      if (meta.length) out.push('*' + meta.join('　·　') + '*');
      out.push('');
      for (const s of (e.sentences || []).slice(0, 3)) {
        out.push(`- \`${s.at || '--:--'}\` ${s.text}`);
        if (s.zh) out.push(`  ${s.zh}`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

/* ===========================================================================
 * 六、统计
 * ========================================================================= */

/**
 * @returns {{total,byLevel:{core,academic,general},dueToday,mastered,newThisWeek,
 *            known,learning,totalOccurrences}}
 */
export function bookStats(book, opts = {}) {
  const b = ensureBook(book);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const endOfToday = (() => {
    const d = new Date(now); d.setHours(23, 59, 59, 999); return d.getTime();
  })();
  const weekAgo = now - 7 * DAY;

  const st = {
    total: 0,
    byLevel: { core: 0, academic: 0, general: 0 },
    dueToday: 0, mastered: 0, newThisWeek: 0,
    known: 0, learning: 0, totalOccurrences: 0
  };
  for (const key of Object.keys(b.words)) {
    const e = b.words[key];
    if (!e) continue;
    const srs = e.srs || {};
    st.totalOccurrences += Number(e.count) || 0;
    if (srs.known) { st.known++; continue; }        // 标记认识的不算进生词总数
    st.total++;
    if (st.byLevel[e.level] == null) st.byLevel[e.level] = 0;
    st.byLevel[e.level]++;
    if (srs.state === 'mastered') st.mastered++;
    else if (srs.state === 'learning' || srs.state === 'review') st.learning++;
    if ((Number(srs.due) || 0) <= endOfToday && srs.state !== 'mastered') st.dueToday++;
    if ((Number(e.firstSeen) || 0) >= weekAgo) st.newThisWeek++;
  }
  return st;
}

/* 一步到位的便捷入口：录完一节课直接调这个 */
export function ingestSession(book, session, sessionMeta = {}, opts = {}) {
  const b = ensureBook(book);
  const cands = extractCandidates(session, { ...opts, known: opts.known || knownSet(b) });
  return { book: mergeIntoBook(b, cands, sessionMeta), candidates: cands };
}

export default {
  extractCandidates, mergeIntoBook, reviewQueue, grade,
  toAnki, toCSV, toMarkdown, bookStats,
  emptyBook, markKnown, knownSet, ingestSession
};
