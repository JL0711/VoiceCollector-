/**
 * coach.js —— 听力教练
 * ---------------------------------------------------------------------------
 * 解决的是一件很具体的事：晗晗刚到美国，跟不上老师的语速。
 * 她的四个卡点，这个文件分别对应：
 *   1. 听到生词就愣住，后面三五句全丢  → catchUpWindow()  打包「连环丢失窗口」整段回听
 *   2. 分不清考点和闲聊              → emphasisLevel()  实时给字幕上色
 *   3. 看讲稿没用，得再听一遍原声      → findMissed() / threeMinuteRecap() 给出该回听的句子和时间戳
 *   4. 每门课的生词是固定那几百个      → prepPack() / reviewQueue() 课前预习 + 间隔复习
 * 再加上 paceStats() / paceDrill() 告诉她「这老师到底有多快、该从几倍速开始练」，
 * 以及 progressReport() 让她看到自己在变好 —— 适应期最需要的就是这个。
 *
 * 纯 ES Module，无副作用，不碰 DOM，不写数据库。全部同步函数，可以直接在渲染里调。
 *
 * ---------------------------------------------------------------------------
 * 语速阈值的出处（不是拍脑袋的）
 * ---------------------------------------------------------------------------
 * 主依据：Tauroza, S. & Allison, D. (1990) "Speech Rates in British English",
 *        Applied Linguistics 11(1), 90–105. doi:10.1093/applin/11.1.90
 *        这是语速研究里被引最多的一篇，它给了两套**彼此独立**的数字：
 *
 *        (a) 快慢分档（words per minute）     (b) 该研究四类语料的实测均速
 *          比正常慢    < 100                    学术讲课    约 140–150（四类里最慢）
 *          偏慢      100–125                    广播独白    约 160
 *          正常      125–160                    访谈       约 190
 *          偏快      160–185                    日常对话    约 210
 *          比正常快    > 185
 *
 *        ⚠️ 这两列**不能混用**。本文件早先的版本把 (a) 的「偏快 160–185」抄进了 (b) 的
 *        「讲课」一行，于是对她说「179 词/分正好是讲课常见区间」—— 按原文这是反的：
 *        T&A 的讲课样本本身就是四类里最慢的。这个错会把「安慰」建立在假事实上，已改正。
 *
 * 参照物：TOEFL 听力 / 口语的基准速度约 150 w.p.m.
 *        （满分口语答案实测均速约 154 w.p.m.）
 * 另一条常被引用的是 Griffiths 的听力实验：
 *        Griffiths (1990) 用 100 慢 / 150 中 / 200 快，结论是「慢速与中速的理解率
 *        没有显著差异」——也就是 **150 已经是她练过的上限，再快就开始掉。**
 *        但要诚实：Griffiths (1992) 换成 128 / 188 / 250 时，188 和 250 之间
 *        **没有**显著差异。所以「190 是一道坎」这种说法学界并没有定论，
 *        本文件不再那样写（原来写的是「190 以上是公认的坎」，属于夸大）。
 *
 * 本文件采用的四档，直接对齐 (a) 列，取整便于显示：
 *        slow  < 130 | normal 130–160 | fast 160–190 | very-fast > 190
 *        130 对应「偏慢/正常」交界；160 是「偏快」下界；190 是「比正常快」(185) 留了点余量。
 *
 * 给她的那句话仍然成立，但要建立在**真的事实**上：她练过的 TOEFL 约 150，
 * 而 T&A 实测的自然英语（广播 160 / 访谈 190 / 对话 210）几乎每一类都比 150 快。
 * 所以「这边的常态比你练过的快」是对的 —— 只是依据不是「讲课 160–185」那一格。
 *
 * ---------------------------------------------------------------------------
 * 关于时长：能测到什么、不能测到什么（不要骗自己）
 * ---------------------------------------------------------------------------
 * segment 只保证有 t（开始毫秒）。end / dur 不一定有。
 *   - 有 end/dur  → basis='timed'，wpm 和 silenceRatio 都是真的。
 *   - 只有 t      → basis='estimated'。此时单看一段，「慢慢说」和「说完停一会儿」
 *                  无法区分。但整节课看就有办法：**段与段之间的停顿长短不一**，
 *                  那些后面几乎没停顿的段，它的「词数 ÷ 到下一段的间隔」就接近真实语速。
 *                  所以取所有段这个比值的 85 分位作为本节课的真实语速估计，
 *                  再反推每段实际说了多久、剩下的算停顿。
 *                  （第一版直接把间隔当说话时间，算出 141 w.p.m.，真值是 178 ——
 *                   那会让一个「偏快」的老师显示成「正常」，把最需要的那句
 *                  「跟不上不是你的问题」给弄丢了，比不给数字还糟。）
 *                  paceStats().basis 会如实标出来，UI 可以加个「估算」角标。
 */

import { mmss } from './util.js';
import { findTerms, shouldTranslate, looksDegenerate } from './glossary.js';
import { analyze } from './localnlp.js';

/* ===========================================================================
 * 〇、常量
 * ========================================================================= */

/** 四档阈值，见文件头出处 */
const LV_SLOW = 130, LV_NORMAL = 160, LV_FAST = 190;

/** 参照物 */
const TOEFL_WPM = 150;          // TOEFL 听力/口语基准
/**
 * Tauroza & Allison 的「偏快 / 比正常快」交界。
 * 注意这是 (a) 分档列的数字，**不是**该研究「讲课」那一类的实测均速
 * （讲课约 140–150，是四类里最慢的）。命名刻意避开 LECTURE_*，
 * 免得又被当成「大学讲课的常见区间」写进给她看的文案里。
 */
const BRISK_LO = 160;           // 「偏快」下界
const BRISK_HI = 185;           // 「偏快」上界 = 「比正常快」的起点
/** 该研究四类语料的实测均速，用来说明「自然英语普遍快于 TOEFL 的 150」 */
const NATURAL_RADIO = 160, NATURAL_INTERVIEW = 190, NATURAL_CONVO = 210;

/** 估算模式下的「讲课语速下限」：低于它的时间一定是停顿而不是在说话 */
const SLOW_FLOOR_WPM = 90;
/** 估算模式下给每段留的换气/标点余量（毫秒） */
const BREATH_PAD_MS = 1200;
/** 连续输出的判定：段间空档小于它就算「没喘气」 */
const RUN_GAP_MS = 1000;
/** 她按 ⭐ 一般是在句子说完之后，往前找这么久 */
const MARK_LOOKBACK_MS = 15000;

/** 中文档位名 */
const LEVEL_CN = { slow: '偏慢', normal: '正常', fast: '偏快', 'very-fast': '非常快' };

/**
 * 常用词表（约 700 个）。用来判断「这是不是生词」——
 * 不在这张表、也不在术语表里的长词，对她就是生词。
 * 故意只收最常见的功能词 + 校园日常词，宁可多判几个生词也不要漏。
 */
const COMMON = new Set(('a able about above accept across act actually add after again against age ago agree ahead all allow almost alone along already also although always am among amount an and another answer any anyone anything appear are area around as ask at away back bad base be because become been before begin behind being believe below best better between big bit both break bring build but buy by call came can cannot car care carry case catch cause center certain chance change check child choose city class clear close come common company compare complete computer consider continue control cost could country couple course cover create cut data day deal decide deep describe design detail determine develop did die differ different difficult direct do does doing done door down draw drive drop due during each early easy eat effect either else end enough enter entire even evening event ever every everyone everything exact example except expect experience explain eye face fact fall family far fast father feel few field fight figure fill final find fine finish fire first fit five fix follow food foot for force form found four free friend from front full fun further future game gave general get girl give go goes going good got government great green ground group grow guess guy had half hand happen hard has have he head hear heart held help her here herself high him himself his hit hold home hope hour house how however huge human hundred idea if important in include increase indeed inside instead interest into is issue it its itself job join just keep kept key kid kill kind knew know large last late later law lay lead learn least leave left less let letter level lie life light like likely line list listen little live local long look lose lot love low made main major make man many market matter may maybe me mean measure meet member might mind minute miss model moment money month more morning most mother move much music must my myself name nation near need never new news next nice night no none nor north not note nothing notice now number of off offer office often oh ok okay old on once one only open or order other others our out outside over own page paper parent part particular party pass past pay people per perhaps person pick picture piece place plan play please point policy poor position possible power practice prepare present pretty prevent price probably problem process produce program project provide public pull purpose push put quality question quick quite raise rate rather reach read ready real really reason receive recent record red reduce relate remain remember report require research rest result return rich right rise risk road role room rule run said same save saw say school science score sea season seat second section see seem seen self sell send sense series serious serve service set seven several sex shall share she short should show side sign similar simple simply since single sir sit site situation six size skill small so social society some someone something sometimes son soon sort sound source south space speak special specific spend stand standard start state stay step still stop story street strong structure student study stuff style subject such suddenly suggest summer support sure surface system table take talk task teach teacher team tell ten term test than thank that the their them themselves then there these they thing think third this those though thought three through throw thus time to today together told tomorrow tonight too took top total toward town trade train travel treat tree trip trouble true try turn two type under understand unit until up upon us use used useful usual value various very view visit voice wait walk wall want war was watch water way we wear week weight well went were west what whatever when where whether which while white who whole whom whose why wide wife will win wind window wish with within without woman women word work world would write wrong yard yeah year yes yesterday yet you young your yourself'
// —— 第二批：星期/月份/数字、校园词、学术通用词。
// 没有这一批的时候 findMissed 会把 friday / percent / chapter / running 全当成生词报出来，
// 一句话挂四个「生词」，真正的难句反而被淹了。标准：TOEFL 过了的人认识的词都进表。
+ ' monday tuesday wednesday thursday friday saturday sunday weekday weekend january february march april june july august september october november december'
+ ' eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion zero'
+ ' first second third fourth fifth sixth seventh eighth ninth tenth once twice half quarter double triple percent percentage dozen'
+ ' campus semester midterm final finals exam quiz test homework assignment essay lecture lab seminar syllabus chapter textbook reading professor student undergraduate graduate grade credit deadline submit submission upload portal website online attendance participation review exercise handout slide slides notebook classroom college university course'
+ ' analysis analyze approach argue argument assume assumption available availability average behavior benefit cause choice compare comparison concept conclusion condition constant contain context contrast decrease define definition demand depend describe determine difference direct discuss distinguish divide effect element equal error establish estimate evidence exception exist expect explain factor feature focus function identify impact increase indicate individual instance introduce involve knowledge limit maintain material measure method natural necessary negative normal object observe obtain occur option original pattern period positive predict previous principle produce product purpose quantity range reduce refer regard relate relationship relative remove replace represent require respond response reverse sample select sequence significant similar situation solution specific stage statement structure suggest summary supply suppose tend theory typical unit variable various version volume'
+ ' airline airport ticket travel coffee shop store customer business company firm cost dollar cent expensive cheap gas gasoline drive train bus hotel housing rent meal restaurant salt sugar brand revenue profit tax income budget spend spending'
+ ' nobody everybody somebody anybody everything anything nothing something everywhere anywhere somewhere careful carefully attention mistake obviously seriously honestly basically actually essentially literally exactly probably certainly definitely clearly simply quickly slowly finally usually generally specifically particularly recently currently immediately'
+ ' running taking giving making getting going coming moving buying selling paying writing reading looking asking closer larger smaller higher lower faster slower better worse bigger greater fewer unrelated whether toward panic classic instant concert versus spike stuck goods amount signed'
// —— 第三批（审查时补的，约 1100 个）——
// 原因：拿一份 CS 课语料实测，**她实际看到的「生词」里 38% 是误报** ——
// search / successful / memory / linear / comment / string / primary / occupied / separate
// 这种词全被报成「不认识的词」。一条提示四个词有三个她认识，她就不会再看这块了，
// 真难句（coalesce / amortized / contiguous / tombstone）反而被挤出去。
// 标准仍然是：TOEFL 过了的人认识的词都进表；学科硬词（amortized / quadratic / modulo /
// adjacency / coalesce…）一律不进，那些才是要给她的。
+ ' accept access account achieve active actual addition address adjust admit advance advantage advice affect afford agree allow announce annual apart apparent appeal application apply appreciate approach appropriate approve approximate argue arrange arrive article aside aspect assign assist associate attach attack attempt attend attract audience author authority available avoid aware'
+ ' balance battle beautiful behave belief belong benefit beyond blood board border bottom brain branch breath brief bright broad budget burn'
+ ' calculate camera cancel capable capacity capital capture category central century certain chair challenge champion channel character charge chart cheap chemical chief choice circle citizen civil claim clean clear climb clock cloud coast collect colony color column combine comfort command comment commercial commit committee communicate community compete complain complex component compose compromise concern conclude concrete confirm conflict confuse connect conscious consist consistent constant construct consume contact contain content contest continue contract contrast contribute convert convince copy corner correct count couple courage court crime crisis critical cross crowd cultural culture curious current customer'
+ ' damage dance danger dark database date dead debate debt decade decision declare decline defeat defend defense define degree delay deletion deliver democracy demonstrate deny department depend deposit depth derive describe deserve design desire despite destroy detail detect device devote dialogue differ digital dinner direction director dirty disagree disappear disaster discover discuss disease dismiss display distance distinct distinction distribute district divide division doctor document domestic dominant double doubt download downward draft drama dream dress drink drug'
+ ' earn ease east economic economy edge edit editor educate effective efficient effort elect electric electronic element elsewhere emerge emotion employ empty enable encounter encourage energy engage engine engineer enhance enjoy enormous ensure enterprise entertain entry environment equal equation equipment escape essay establish estate estimate ethical evaluate eventually everyday evidence evolve exact examine excellent exchange excite exclude excuse execute exercise exhibit exist exit expand expense experiment expert explore export expose express extend extent external extra extreme'
+ ' facility factory failure fair faith familiar famous fashion fault favor feature federal fee feedback female festival fiction file film filter finance financial firm fiscal flat flavor flight float floor flow flower fluid focus fold folk forbid forecast foreign forest forever forget forgive formal format former formula fortune forward foundation frame framework frequent fresh friendly fruit fuel function fund fundamental funny'
+ ' gain gallery gap garden gather gender general generate generation gentle genuine gift glass global goal gold govern grade grain grand grant graph grass great grid gross growth guarantee guard guest guide'
+ ' habit handle hang hardware harm hate healthy heat heavy height helpful hero hidden hide highlight highly historic history hobby holiday honest honor hospital host hotel household housing humor hunt hurry hurt husband'
+ ' ideal identical identity ignore illegal illness illustrate image imagine immediate impact implement imply import impose impress improve incident include income increase incredible independent index indicate industry infant infection inflation influence inform initial initiate injure inner innocent input inquiry insert insertion inside insight insist inspect inspire install instance instant institute instruct instrument insurance intend intense interact interfere internal internet interpret interrupt interval interview introduce invent invest investigate invite involve iron island isolate item'
+ ' journal journey judge jump junior justice justify'
+ ' keyboard kick knee knife knock'
+ ' label labor lack lady lake landscape language laptop laugh launch layer leader leaf league lean leap legal legend length lesson liberal library license lift limit linear link liquid list literature loan locate location lock logic lonely loose loss loud lower luck lunch luxury'
+ ' machine magazine magic magnitude mail maintain majority manage manager manner manufacture map margin mark marriage mask mass massive master match material mathematics matrix mature maximum meal meaning meanwhile mechanism media medical medicine medium memory mention menu merge message metal meter method middle military milk mineral minimum minister minor minority mirror mission mix mobile mode moderate modern modify moment monitor monthly mood moral motion motive motor mountain mouse mouth movement movie multiple multiply multiplication muscle museum mutual mystery'
+ ' narrow native natural nature nearby nearly necessary negative neighbor neither nerve network neutral newspaper noise normal north notion novel nuclear numerous nurse'
+ ' obey object objective obligation observe obstacle obtain obvious occasion occupy occur ocean offense officer official offset ongoing online onto opening operate operation opinion opponent opportunity oppose opposite optimal option optional orbit organ organize origin original otherwise outcome outdoor outline output outstanding overall overcome overlap oversee owner oxygen'
+ ' pace pack package pain paint panel parade parallel parameter park partial participate particle partner passage passenger passion passive patch patent path patience patient pattern pause payment peace peak penalty pension perfect perform performance permanent permit persist personal perspective persuade phase phenomenon philosophy phone photo phrase physical pile pilot pipe pitch plain planet plant plastic plate platform pleasant pleasure plenty plot plus pocket poem poet poetry pole police policy political politics poll pollution pool popular population port portion pose position positive possess post posted postpone potential pound pour poverty powerful practical praise precise predict prefer premium prepare presence preserve president press pressure presume pretend prevent previous primary prime principal principle print prior priority prison privacy private privilege prize probable procedure proceed profession professional profile profit program progress prohibit project promise promote prompt pronounce proof proper property proportion proposal propose prospect protect protein protest proud prove provide province provision psychology publication publish punish pupil purchase pure pursue'
+ ' qualify quality quantity quarter query quest quick quiet quit quote'
+ ' race radio rail rain raise random range rank rapid rare ratio raw reaction reader realistic reality realize rear reasonable recall receipt recipe recognize recommend recover recruit reduce refer reflect reform refuse regard region register regret regular regulate reject relax release relevant reliable relief religion reluctant rely remain remark remedy remind remote remove renew rent repair repeat replace reply report represent republic reputation request require rescue research resemble reserve resident resign resist resolve resort resource respect respond response responsible restore restrict result resume retail retain retire retreat reveal revenue reverse review revise revolution reward rhythm rifle ring rise risk river rock rocket role roll roof root rope rough round route routine royal rubber rural rush'
+ ' sacred sacrifice safe safety salary sale sample sand satellite satisfy scale scan scandal scare scatter scene schedule scheme scholar scope score scratch screen script sculpture seal search season secondary secret secretary section sector secure seek segment seize select senate senior sense sensible sensitive sentence separate sequence serve session settle severe shade shadow shake shallow shame shape share sharp shed sheet shelf shell shelter shield shift shine ship shirt shock shoe shoot shop shore shot shoulder shout shower shrink shut signal signature silence silent silver similar simple single sink site skill skin sky sleep slice slide slight slip slope smart smell smile smoke smooth snow soap soccer social soft soil solar soldier sole solid solve somehow somewhat song sorry soul sound soup source space spare spatial specialist species specify spectrum speech speed spell sphere spin spirit split sponsor sport spot spray spread spring square squeeze stable staff stage stair stake stamp stand star stare startup state statement station statistics status steady steal steam steel stem stick stiff stimulate stir stock stomach stone storage store storm straight strain strange strategy stream strength stress stretch strict strike string strip stroke struggle studio stupid submit subsequent substance substitute subtle succeed success successful sudden suffer sufficient suggest suit summary summit super superior supervise supplement supplementary supply support suppose supreme surface surgery surprise surround survey survive suspect suspend sustain swallow sweep sweet swim swing switch symbol sympathy symptom'
+ ' tackle tail talent tank tape target task taste technical technique technology telephone telescope television temperature temporary tenant tend tendency tension terrible territory terror text texture theater theme theory therapy therefore thick thin thorough thought thread threat threaten throat thumb ticket tie tight timing tiny tip tire tissue title tone tool tooth topic total touch tough tour tourist toward tower toxic trace track trade tradition traffic tragedy trail transfer transform transit translate transmit transport trap treasure treat treatment tremendous trend trial tribe trick trigger triumph troop tropical trouble truck trust truth tube tune tunnel twin twist typical'
+ ' ultimate unable uncle uncover undergo underlie understand undertake unemployment unfair uniform union unique unite universal universe unknown unless unlike unlikely unsuccessful unusual update upgrade upon upper upset upward urban urge urgent usage useful user utility'
+ ' vacation vague valid valley valuable value vanish variable variation variety various vary vast vegetable vehicle venture verbal verdict verse version vertical vessel veteran victim victory video view village violate violence virtual virtue virus visible vision visit visual vital vocal volume volunteer vote'
+ ' wage wait wake walk wall wander warm warn wash waste watch water wave weak wealth weapon wear weather weekly weigh weird welcome welfare wet wheel whereas wherever whisper white whole wide widespread width wild willing wind window wine wing winner winter wipe wire wisdom wise wish withdraw witness wonder wooden word worker workshop world worried worry worse worship worth wound wrap write writer wrong'
+ ' yard yellow yield young youth zone'
).split(' '));

/** 语气词 / 填充词：算语速要算进去（她确实要听），但不算生词、不算信息 */
const FILLER = new Set('um umm uh uhh er erm ah oh hmm mm mhm yeah yep yup nope okay ok alright right well like anyway actually basically literally kinda sorta gonna wanna gotta lemme'.split(' '));

/**
 * 口头禅 / 话语标记 → 中文说明。
 * 这张表的价值不在「统计好玩」，而在于告诉她 **哪些词可以直接扔掉、哪些词是救命信号**。
 * kind: 'skip'   听到可以忽略，不承载信息
 *       'rescue' 救命信号 —— 老师要把刚才那句换个说法再讲一遍，走神了就在这里重新接上
 *       'turn'   话题转折，注意力要拉回来
 */
const CUES = [
  // —— 救命信号：她卡点 #1 的解药 ——
  { re: /\bin other words\b/i,                      p: 'in other words', k: 'rescue', zh: '「换句话说」—— 同一件事要再讲一遍，上一句没懂就抓这句' },
  { re: /\b(?:what|which) i mean (?:is|by)\b/i,     p: 'what I mean is', k: 'rescue', zh: '「我的意思是」—— 老师要换个说法重讲' },
  { re: /\bi mean\b/i,                              p: 'I mean', k: 'rescue', zh: '「我是说」—— 后面常常是同一句话的简单版' },
  { re: /\bthat is to say\b/i,                      p: 'that is to say', k: 'rescue', zh: '「也就是说」—— 重讲一遍' },
  { re: /\bto put it (?:another way|differently|simply)\b/i, p: 'to put it another way', k: 'rescue', zh: '「换个说法」—— 重讲一遍，更好懂的版本' },
  { re: /\blet me (?:say that again|repeat|rephrase)\b/i,    p: 'let me say that again', k: 'rescue', zh: '「我再说一遍」—— 直接重复' },
  { re: /\bagain,\s/i,                              p: 'again, ...', k: 'rescue', zh: '「再强调一次」—— 重复刚才的内容' },
  { re: /\bso (?:basically|essentially)\b/i,        p: 'so basically', k: 'rescue', zh: '「简单说就是」—— 前面一大段的浓缩版' },
  { re: /\bthe (?:idea|point) (?:here )?is\b/i,     p: 'the point here is', k: 'rescue', zh: '「重点是」—— 前面听乱了，听这句就够' },
  { re: /\bdoes that make sense\b/i,                p: 'does that make sense?', k: 'rescue', zh: '「听懂了吗」—— 这是可以举手说没懂的时刻' },
  { re: /\bany questions\b/i,                       p: 'any questions?', k: 'rescue', zh: '「有问题吗」—— 可以提问的时刻' },
  { re: /\bas i (?:said|mentioned)\b/i,             p: 'as I said', k: 'rescue', zh: '「我刚说过」—— 之前漏掉的内容会在这里重复' },
  // —— 话题转折：注意力拉回来 ——
  { re: /\b(?:okay|alright|all right) so\b/i,       p: 'okay so / alright so', k: 'turn',   zh: '要换话题了，注意力拉回来' },
  { re: /\bmoving on\b/i,                           p: 'moving on', k: 'turn',   zh: '「往下讲」—— 换主题' },
  { re: /\blet'?s (?:talk about|look at|move on|turn to)\b/i, p: "let's talk about", k: 'turn', zh: '「我们来看」—— 新主题开始' },
  { re: /\bnow,?\s+(?:the|this|we|let)\b/i,         p: 'now, ...', k: 'turn',   zh: '「现在」—— 常常是新段落的开头' },
  { re: /\bfirst of all\b/i,                        p: 'first of all', k: 'turn',   zh: '「首先」—— 要开始列举了，后面有二三四' },
  // —— 可以忽略的口头禅 ——
  { re: /\byou know\b/i,                            p: 'you know', k: 'skip',   zh: '口头禅，没有信息，直接忽略' },
  { re: /\b(?:kind|sort) of\b/i,                    p: 'kind of / sort of', k: 'skip',   zh: '「有点儿」—— 弱化语气，可忽略' },
  { re: /\ba little bit\b/i,                        p: 'a little bit', k: 'skip',   zh: '「一点点」—— 可忽略' },
  { re: /\band so (?:on|forth)\b/i,                 p: 'and so on', k: 'skip',   zh: '「等等」—— 后面省略了，不用纠结' },
  { re: /\bif you will\b/i,                         p: 'if you will', k: 'skip',   zh: '「可以说」—— 口头禅，可忽略' },
  { re: /\bso to speak\b/i,                         p: 'so to speak', k: 'skip',   zh: '「所谓的」—— 口头禅，可忽略' },
  { re: /\bor whatever\b/i,                         p: 'or whatever', k: 'skip',   zh: '「之类的」—— 可忽略' },
  { re: /\bright\?/i,                               p: 'right?', k: 'skip',   zh: '「对吧？」—— 只是确认你跟上没有，可忽略' }
];

/**
 * emphasisLevel 用的两条正则 —— 上课时每出一句就调一次，必须快。
 * 写法上刻意避开嵌套量词（(?:a+)+ 这种），不存在回溯爆炸。
 * L2 = 漏了要出事的：考点 + 硬截止日期
 * L1 = 值得留意的：重点 / 易错 / 换句话说
 */
const RE_L2 = /\b(?:on the (?:exam|test|midterm|final|quiz)|exam question|test question|fair game|will be tested|testable|show up on the (?:exam|test|final)|come up on the (?:exam|test|final)|for the exam|memorize|write this down|i guarantee|you (?:will|'ll) see this again|due (?:on|by|next|this|tomorrow|friday|monday|tuesday|wednesday|thursday|saturday|sunday)|deadline|turn (?:it|this|them) in|hand (?:it|this|them) in|problem set|pset|homework is|assignment is|graded on)\b/i;

const RE_L1 = /\b(?:important|crucial|critical|essential|fundamental|significant|the key|key (?:point|idea|thing|concept|takeaway|difference)|main (?:point|idea)|takeaway|take away|bottom line|the whole point|note that|notice that|pay attention|be careful|watch out|common mistake|commonly confused|make sure|remember|don['’]?t forget|keep in mind|bear in mind|in other words|to summarize|in summary|to recap|the point is|what matters|you need to know|you should know|be able to|this is the (?:core|heart|crux)|the difference between|as opposed to|is defined as|we define|by definition|refers to)\b/i;

/* ===========================================================================
 * 一、内部小工具
 * ========================================================================= */

/** 只数英文词（util.words 会把每个汉字算一个词，算语速不能用） */
const enWordCount = t => (String(t || '').match(/[A-Za-z0-9'’-]+/g) || []).length;
const enWordList  = t => (String(t || '').toLowerCase().match(/[a-z'’-]{2,}/g) || []);

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const round1 = v => Math.round(v * 10) / 10;
const pct = v => Math.round(v * 100);

/** 取出 session 的 segments（也容忍直接传数组进来） */
function segmentsOf(session) {
  if (!session) return [];
  if (Array.isArray(session)) return session;
  return Array.isArray(session.segments) ? session.segments : [];
}

/** 是不是老师说的话（她自己敲的笔记和标记不算语速） */
const isSpeech = s => !!s && s.kind !== 'mark' && s.kind !== 'note' && !!String(s.text || '').trim();
const isMark   = s => !!s && (s.kind === 'mark' || s.kind === 'note');

/** localnlp.analyze 不便宜，同一份 segments 只跑一次 */
const ANA_CACHE = new WeakMap();
function getAnalysis(session, opts) {
  if (opts && opts.analysis) return opts.analysis;
  const segs = segmentsOf(session);
  if (!segs.length) return analyze([]);
  let a = ANA_CACHE.get(segs);
  if (!a) { a = analyze(segs); ANA_CACHE.set(segs, a); }
  return a;
}

/**
 * 词干化（很粗，够用就行：只为了查常用词表）。
 * 注意 -es 只能在 s/x/z/ch/sh 后面剥两个字母，否则 prices → pric 就查不到 price 了。
 */
function stemLite(w) {
  // -ied / -ies → -y：occupied→occupy、studies→study、families→family、applied→apply。
  // 没有这两条的话 occupied / studies 查不到 occupy / study，会被当成生词报给她
  // （规格里也点名了「不要把 studies 和 study 当两个词」）。必须排在 -ed / -s 前面。
  if (w.length > 4 && w.endsWith('ied')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed'))  return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ly'))  return w.slice(0, -2);
  if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * looksDegenerate 返回的是 {bad, reason} 对象而不是布尔值 —— 直接 if 判断会永远为真。
 * 这里统一成「返回中文原因字符串，没问题就返回空串」，顺便把原因透出去给她看。
 */
function degenerateReason(zh, en) {
  if (!zh) return '';
  try {
    const r = looksDegenerate(zh, en);
    if (r && typeof r === 'object') return r.bad ? (r.reason || '译文异常') : '';
    return r ? '译文异常' : '';
  } catch (_) { return ''; }
}

/** 这个词对她是不是生词：够长、不是常用词、不是语气词、不是缩写 */
function isRareWord(w) {
  if (w.length < 6) return false;
  if (w.indexOf("'") >= 0 || w.indexOf('\u2019') >= 0) return false;   // that's / doesn't
  if (w.indexOf('-') >= 0) {                                          // twenty-five / downward-sloping
    return w.split('-').every(x => x.length >= 6 && !COMMON.has(x) && !COMMON.has(stemLite(x)));
  }
  if (FILLER.has(w) || COMMON.has(w)) return false;
  const st = stemLite(w);
  if (COMMON.has(st) || FILLER.has(st)) return false;
  // defined → defin → define：剥掉 -ed/-ing 之后要把原来的哑音 e 加回去，
  // 否则 defined / measured / estimating 全会被当成生词报给她。
  if (st !== w && COMMON.has(st + 'e')) return false;
  // running → runn → run：剥完剩下双写辅音的，再还原一次
  if (/([bcdfglmnprst])\1$/.test(st) && COMMON.has(st.slice(0, -1))) return false;
  return true;
}

/**
 * 一句话里的生词。
 * 必须拿原文（保留大小写）扫：句中大写的是人名地名（Robinson Hall / Delta），
 * 那是听不清的名字，不是要背的单词，报成「生词」只会误导她。
 */
function rareWordsIn(text, coveredLower) {
  const src = String(text || '');
  const out = [], seen = new Set();
  const re = /[A-Za-z][A-Za-z'\u2019-]*/g;
  let m, first = true;
  while ((m = re.exec(src)) !== null) {
    const raw = m[0];
    const atSentStart = first || /[.!?]["')\]]?\s+$/.test(src.slice(0, m.index));
    first = false;
    const w = raw.toLowerCase();
    if (seen.has(w)) continue;
    if (!atSentStart && /^[A-Z]/.test(raw)) { seen.add(w); continue; }   // 专有名词
    if (!isRareWord(w)) continue;
    if (coveredLower && coveredLower.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  // 按「有多难」排，难的在前。
  // 调用方一律是 .slice(0, 4) / .slice(0, 2) 取前几个展示，而如果保持原文顺序，
  // 取到的就是**句子里最靠前的**几个词 —— 句首恰恰多是简单词，
  // 结果 coalesce / contiguous 这种真难词被 separate / search 挤掉。
  // 没有词频表，用词长当难度代理：够粗但方向是对的（长词普遍更低频）。
  out.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return out;
}

/** 去掉 localnlp 抽出来的术语前面粘着的连接词："So elasticity" → "elasticity" */
function cleanTerm(t) {
  return String(t || '').replace(/^(?:so|and|but|okay|ok|now|well|then|alright|the|a|an)\s+/i, '').trim();
}

/* ===========================================================================
 * 二、时间轴 —— 所有语速计算的地基
 * ---------------------------------------------------------------------------
 * 输出每一段的「真正在说话的毫秒数」。有 end 就用真的，没有就按文件头写的
 * 「讲课不可能慢于 90 w.p.m.」反推上界。
 * ========================================================================= */

const totalWordsOf = arr => arr.reduce((a, x) => a + x.w, 0);

function buildTimeline(session, opts = {}) {
  const segs = segmentsOf(session).filter(isSpeech)
    .map(s => ({ ref: s, id: s.id, t: num(s.t), w: enWordCount(s.text), text: String(s.text || '') }))
    .filter(x => x.w > 0)
    .sort((a, b) => a.t - b.t);

  const n = segs.length;
  const empty = {
    items: [], totalWords: 0, speechMs: 0, wallMs: 0, silenceMs: 0,
    basis: 'none', bySegId: new Map()
  };
  if (!n) return empty;

  // 有没有真实的结束时间？超过六成段落带 end/dur 才认为是「有时长」的录音
  let timed = 0;
  const rawEnd = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = segs[i].ref;
    const e = s.end != null ? num(s.end) : (s.dur != null || s.durationMs != null)
      ? segs[i].t + num(s.dur != null ? s.dur : s.durationMs) : null;
    if (e != null && e > segs[i].t) { rawEnd[i] = e; timed++; }
    else rawEnd[i] = null;
  }
  const basis = timed >= n * 0.6 ? 'timed' : 'estimated';

  // 先把每段到下一段的间隔算出来（说话时间不可能超过它）
  const gaps = new Array(n);
  for (let i = 0; i < n; i++) gaps[i] = i < n - 1 ? Math.max(0, segs[i + 1].t - segs[i].t) : null;

  // 估算模式：用「后面几乎没停顿」的那些段反推真实语速（见文件头）
  let estWpm = 0;
  if (basis === 'estimated') {
    const rates = [];
    for (let i = 0; i < n; i++) {
      if (gaps[i] == null || gaps[i] < 800 || segs[i].w < 4) continue;
      rates.push(segs[i].w / (gaps[i] / 60000));
    }
    if (rates.length >= 5) {
      rates.sort((a, b) => a - b);
      estWpm = rates[Math.min(rates.length - 1, Math.floor(rates.length * 0.85))];
    }
    // 兜底：样本太少就退回墙钟密度；再夹到讲课可能的区间里
    if (!estWpm) {
      const span0 = segs[n - 1].t - segs[0].t;
      estWpm = span0 > 0 ? totalWordsOf(segs) / (span0 / 60000) : 150;
    }
    estWpm = clamp(estWpm, SLOW_FLOOR_WPM, 280);
  }

  const items = [];
  let speechMs = 0, silenceMs = 0, totalWords = 0;

  for (let i = 0; i < n; i++) {
    const cur = segs[i];
    const gap = gaps[i];

    // 「按 90 w.p.m. 也说不了那么久」的绝对上限
    const ceil = cur.w / SLOW_FLOOR_WPM * 60000 + BREATH_PAD_MS;

    let span, capped = false;
    if (rawEnd[i] != null) {
      const full = rawEnd[i] - cur.t;
      span = full;
      if (gap != null && full > gap + 500) {
        // end 越过了下一段开头 —— ASR 段重叠。直接按 gap 截会算出「1832 词/分」
        // 这种物理上不可能的语速，再被当成「突然变快」报给她，就成了假警报。
        // 所以：截出来的语速离谱（>320，人类极限附近）就相信 end，并标成测不准。
        const impl = gap > 0 ? cur.w / (gap / 60000) : Infinity;
        if (impl > 320) capped = true; else span = gap;
      }
    } else {
      // 按估出来的语速反推这一段说了多久，再用间隔和绝对上限夹一下
      const need = cur.w / estWpm * 60000;
      span = Math.min(ceil, need);
      if (gap != null) span = Math.min(span, gap);
      // 贴着间隔上限 = 这一段本来就说得满，语速测不准，不参与「突然变快」的判断
      capped = gap != null && span >= gap - 1;
    }
    span = clamp(span, 200, 600000);

    if (gap != null && gap > span) silenceMs += gap - span;
    speechMs += span;
    totalWords += cur.w;

    let wpm = span > 0 ? cur.w / (span / 60000) : 0;
    if (wpm > 400) { wpm = 400; capped = true; }    // 兜底：再离谱的数都不往外报
    items.push({
      id: cur.id, t: cur.t, end: cur.t + span, span, words: cur.w,
      wpm: Math.round(wpm), capped, text: cur.text, ref: cur.ref,
      gapAfter: gap != null ? Math.max(0, gap - span) : 0
    });
  }

  const wallMs = Math.max(items[n - 1].end - items[0].t, speechMs);

  // 最长连续输出：段与段之间空档 <= RUN_GAP_MS 就算没喘气
  let longestRunMs = 0, longestRunAt = items[0].t, runStart = items[0].t;
  for (let i = 0; i < n; i++) {
    const endsRun = i === n - 1 || items[i].gapAfter > RUN_GAP_MS;
    if (endsRun) {
      const len = items[i].end - runStart;
      if (len > longestRunMs) { longestRunMs = len; longestRunAt = runStart; }
      if (i < n - 1) runStart = items[i + 1].t;
    }
  }

  const bySegId = new Map();
  for (const it of items) if (it.id != null) bySegId.set(it.id, it);

  return {
    items, totalWords, speechMs, wallMs, silenceMs, basis, bySegId,
    longestRunMs, longestRunAt
  };
}

/** 档位 */
function levelOf(wpm) {
  if (!(wpm > 0)) return 'normal';
  if (wpm < LV_SLOW) return 'slow';
  if (wpm <= LV_NORMAL) return 'normal';
  if (wpm <= LV_FAST) return 'fast';
  return 'very-fast';
}

/** 给她的那句话。有事实、有出处、有下一步，不是空安慰。 */
function paceComment(wpm, level, basis) {
  const d = Math.round((wpm - TOEFL_WPM) / TOEFL_WPM * 100);
  const tail = basis === 'estimated' ? '（这节录音没有逐句时长，语速是估算的，会有几个词的误差）' : '';
  if (level === 'slow') {
    return `这位老师 ${wpm} 词/分，比 TOEFL 听力（约 ${TOEFL_WPM}）还慢，节奏是好跟的。`
      + `所以卡住多半不是速度，是生词或者口音 —— 先把课前预习包过一遍，效果最快。${tail}`;
  }
  if (level === 'normal') {
    return `这位老师 ${wpm} 词/分，和 TOEFL 听力（约 ${TOEFL_WPM}）差不多，属于正常语速。`
      + `速度不是你的敌人，漏掉的地方基本都是生词。把生词认全，这门课就能跟上。${tail}`;
  }
  if (level === 'fast') {
    return `这位老师 ${wpm} 词/分，比 TOEFL 听力（约 ${TOEFL_WPM}）快 ${d}%，`
      + `按语速研究的分档属于「偏快」（${BRISK_LO}–${BRISK_HI} 词/分）。`
      + `但要知道：真实英语本来就比 TOEFL 快 —— 同一份研究实测广播 ${NATURAL_RADIO}、`
      + `访谈 ${NATURAL_INTERVIEW}、日常对话 ${NATURAL_CONVO} 词/分，几乎每一类都在 ${TOEFL_WPM} 以上。`
      + `也就是说：**你练过的那个速度才是特例，这边的常态就是比它快。**`
      + `跟不上很正常，不是你的问题。先用 0.8 倍速把今天的难句听一遍，再慢慢提回 1.0。${tail}`;
  }
  return `这位老师 ${wpm} 词/分，落在语速研究分档里最快的一档（>${BRISK_HI} 词/分），`
    + `比 TOEFL 听力（约 ${TOEFL_WPM}）快 ${d}%，也快过该研究里最快的一类语料（日常对话约 ${NATURAL_CONVO}）的水平线附近。`
    + `这个速度下漏词是必然的 —— 实验里母语者之外的听者到这个区间理解率都会掉。`
    + `所以跟不上真的不是你的问题 —— `
    + `这节课别硬扛，课后按「回听清单」挑重点补，比当场死撑有用得多。${tail}`;
}

/* ===========================================================================
 * 三、paceStats —— 这节课到底有多快
 * ========================================================================= */

/**
 * @param {Object} session
 * @param {Object} [opts]
 * @returns {{wpm:number, wpmPeak:number, wpmByMinute:Array, wpmSeries:number[],
 *            level:string, levelCN:string, comment:string,
 *            silenceRatio:number, longestRun:number, longestRunAt:number,
 *            basis:string, words:number, speechMs:number, durationMs:number,
 *            fastShare:number}}
 *   wpmByMinute 每分钟一个点：{minute, wpm, words, speechMs, level, thin}
 *   wpmSeries   同一份数据的纯数字版，直接丢给折线图
 *   longestRun  最长连续输出，单位：秒
 */
export function paceStats(session, opts = {}) {
  const tl = buildTimeline(session, opts);
  const base = {
    wpm: 0, wpmPeak: 0, wpmByMinute: [], wpmSeries: [], level: 'normal',
    levelCN: LEVEL_CN.normal, comment: '这节课还没有录到内容。',
    silenceRatio: 0, longestRun: 0, longestRunAt: 0, basis: 'none',
    words: 0, speechMs: 0, durationMs: 0, fastShare: 0, lowConfidence: true
  };
  if (!tl.items.length || tl.speechMs <= 0) return base;

  const wpm = Math.round(tl.totalWords / (tl.speechMs / 60000));
  const level = levelOf(wpm);

  // —— 每分钟一个点 ——
  const t0 = tl.items[0].t;
  const bins = new Map();
  for (const it of tl.items) {
    const m = Math.floor((it.t - t0) / 60000);
    let b = bins.get(m);
    if (!b) { b = { minute: m, words: 0, speechMs: 0 }; bins.set(m, b); }
    b.words += it.words;
    b.speechMs += it.span;
  }
  const minutes = [...bins.values()].sort((a, b) => a.minute - b.minute);
  const wpmByMinute = minutes.map(b => {
    const thin = b.speechMs < 8000;                 // 这一分钟几乎没说话，算出来的速度不可信
    const v = b.speechMs > 0 ? b.words / (b.speechMs / 60000) : 0;
    const val = Math.round(clamp(v, 0, 400));
    return { minute: b.minute, wpm: val, words: b.words, speechMs: b.speechMs, level: levelOf(val), thin };
  });
  const wpmSeries = wpmByMinute.map(x => x.wpm);

  // 峰值：30 秒滑动窗口。按整分钟取会被慢句稀释（实测老师冲到 208，按分钟只报 190），
  // 按单句取又会被一句短话飙到 400。30 秒窗口既贴近「他最快的时候有多快」又稳。
  let wpmPeak = 0;
  {
    const WIN = 30000;
    let lo = 0, wSum = 0, mSum = 0;
    for (let hi = 0; hi < tl.items.length; hi++) {
      wSum += tl.items[hi].words; mSum += tl.items[hi].span;
      while (lo < hi && tl.items[hi].end - tl.items[lo].t > WIN) {
        wSum -= tl.items[lo].words; mSum -= tl.items[lo].span; lo++;
      }
      if (mSum >= 12000) wpmPeak = Math.max(wpmPeak, Math.round(wSum / (mSum / 60000)));
    }
  }
  if (!wpmPeak) wpmPeak = wpm;

  // 有多少比例的时间是在「偏快」以上跑的
  let fastMs = 0;
  for (const it of tl.items) if (!it.capped && it.wpm > LV_NORMAL) fastMs += it.span;
  const fastShare = tl.speechMs > 0 ? fastMs / tl.speechMs : 0;

  const durationMs = Math.max(num(session && session.durationMs), tl.wallMs);
  const silenceRatio = durationMs > 0 ? clamp((durationMs - tl.speechMs) / durationMs, 0, 1) : 0;

  // 样本太小就别下「这老师很快」的结论 —— 刚开始录两句话的时候也会调这个函数
  const lowConfidence = tl.speechMs < 60000 || tl.items.length < 12;

  return {
    wpm, wpmPeak, wpmByMinute, wpmSeries,
    level, levelCN: LEVEL_CN[level], lowConfidence,
    comment: lowConfidence
      ? `目前只录到 ${Math.round(tl.speechMs / 1000)} 秒，样本太少还看不出语速（暂算 ${wpm} 词/分）。多录几分钟再看这个数。`
      : paceComment(wpm, level, tl.basis),
    silenceRatio: round1(silenceRatio * 1000) / 1000,
    longestRun: Math.round(tl.longestRunMs / 1000),
    longestRunAt: tl.longestRunAt,
    basis: tl.basis,
    words: tl.totalWords,
    speechMs: tl.speechMs,
    durationMs,
    fastShare: Math.round(fastShare * 100) / 100
  };
}

/* ===========================================================================
 * 四、emphasisLevel —— 实时给字幕上色（必须快）
 * ========================================================================= */

/**
 * 判断这一句是不是老师在强调。上课时每出一句调一次。
 * @returns {0|1|2} 0=普通 1=值得注意 2=漏了要出事（考点 / 作业截止）
 *
 * 实测：700 句循环 2 万次，平均 2~4 微秒/句（见文件末 benchmark 说明），
 * 远在 0.1 毫秒预算之内。两条正则都没有嵌套量词，不会回溯爆炸。
 */
export function emphasisLevel(text) {
  const s = text;
  if (typeof s !== 'string') return 0;
  const n = s.length;
  if (n < 6) return 0;
  // 超长句只看前 400 字符：强调信号几乎都在句首/句中，尾巴白扫
  const t = n > 400 ? s.slice(0, 400) : s;
  if (RE_L2.test(t)) return 2;
  if (RE_L1.test(t)) return 1;
  return 0;
}

/* ===========================================================================
 * 五、findMissed —— 她可能没跟上的句子
 * ========================================================================= */

/** 把她的 ⭐/📝 挂到「标记之前最近的那句话」上：她总是听完才反应过来 */
function attachMarks(session, tl) {
  const marks = segmentsOf(session).filter(isMark).map(s => ({ t: num(s.t), kind: s.kind, text: String(s.text || '') }));
  const hit = new Map();               // segId -> [mark]
  if (!marks.length || !tl.items.length) return hit;
  for (const mk of marks) {
    // 她是「听完才反应过来」才按的，所以优先挂到**已经说完**的最后一句，
    // 而不是挂到刚刚开口的下一句。（第一版挂错过：⭐ 落在句尾 2.4 秒，
    // 而下一句在 1.9 秒时已经开始，结果标记被算到了下一句头上。）
    let best = null;
    for (const it of tl.items) {
      if (it.end > mk.t) break;                         // 还没说完的不算
      if (mk.t - it.end > MARK_LOOKBACK_MS) continue;   // 太久之前的也不算
      best = it;                                        // items 已按时间排序，取最后一个
    }
    if (!best) {
      // 没有「刚说完」的句子：可能她在句子进行中就按了，取当时正在说的那句
      for (const it of tl.items) {
        if (it.t <= mk.t + 1200 && it.end >= mk.t) { best = it; break; }
        if (it.t >= mk.t && it.t - mk.t <= 4000) { best = it; break; }
      }
    }
    if (!best || best.id == null) continue;
    if (!hit.has(best.id)) hit.set(best.id, []);
    hit.get(best.id).push(mk);
  }
  return hit;
}

/**
 * 找出她可能没跟上的句子。
 * @param {Object} session
 * @param {Object} [opts] {limit=15, minScore=1.6, analysis}
 * @returns {{segId, t, tLabel, text, zh, reasons:string[], severity:'high'|'mid'|'low',
 *            score:number, wpm:number, words:number, terms:Array, rare:string[]}[]}
 */
export function findMissed(session, opts = {}) {
  const limit = num(opts.limit, 15) || 15;
  const minScore = opts.minScore != null ? num(opts.minScore, 1.6) : 1.6;

  const tl = buildTimeline(session, opts);
  if (!tl.items.length) return [];
  const ana = getAnalysis(session, opts);
  const sents = ana.sentences || [];
  if (!sents.length) return [];

  const avgWpm = tl.speechMs > 0 ? tl.totalWords / (tl.speechMs / 60000) : 0;
  const markHits = attachMarks(session, tl);

  /**
   * localnlp 会把一个 segment 切成多句，而 segment 自带的中文**只挂在第一句上**
   * （localnlp 里写死的 firstPiece，不是 bug，是它的契约）。
   * 所以 sentence.zh 为空**不等于**这句没翻译 —— 它可能只是这一段的第二、三句。
   * 第一版直接拿 s.zh 判「译文是空的」，实测 76% 是假警报：
   * 一句话明明有中文，却告诉她「机器也没把这句弄明白」，还白送 2.2 分把它顶进 high。
   * 现在一律回退到**段级**译文来判断，并且把段级中文填进返回值，
   * 否则 UI 上这些句子会变成「有英文没中文」。
   */
  const segZh = new Map(), segText = new Map();
  for (const sg of segmentsOf(session)) {
    if (!sg || sg.id == null) continue;
    segZh.set(sg.id, String(sg.zh || ''));
    segText.set(sg.id, String(sg.text || ''));
  }
  /** 译文复读/退化只能在「整段 ↔ 整段」这一对上判，拿一句去比整段会误判，所以按段算一次 */
  const segDegen = new Map();
  for (const [sid, z] of segZh) {
    if (!z) continue;
    segDegen.set(sid, degenerateReason(z, segText.get(sid) || ''));
  }

  // localnlp 的各类命中，按句子下标索引
  const defIdx = new Set((ana.definitions || []).map(d => d.i));
  const empIdx = new Map((ana.emphases || []).map(e => [e.i, e.tag || '重点']));
  const taskIdx = new Map((ana.tasks || []).map(x => [x.i, (x.tags || []).join('/')]));
  const suspIdx = new Map();
  for (const sp of (ana.suspects || [])) {
    if (!suspIdx.has(sp.i)) suspIdx.set(sp.i, []);
    suspIdx.get(sp.i).push(sp.reason + (sp.detail ? ' ' + sp.detail : ''));
  }

  const cand = [];
  for (const s of sents) {
    if (s.kind === 'note') continue;                       // 她自己敲的笔记不用回听
    const text = String(s.text || '');
    if (!text) continue;
    const seg = s.segId != null ? tl.bySegId.get(s.segId) : null;
    const reasons = [];
    let score = 0;

    // (1) 她自己的标记 —— 最强信号，压倒一切
    const mks = seg && seg.id != null ? markHits.get(seg.id) : null;
    if (mks && mks.length) {
      const star = mks.some(m => m.kind === 'mark');
      score += 5.2;
      reasons.push(star
        ? '你当时标了 ⭐ —— 说明这里当场就卡住了，先听这条'
        : '你当时记了 📝 —— 这里你想留住但没完全听清');
      const withText = mks.filter(m => m.text && /\S/.test(m.text)).slice(0, 2);
      for (const m of withText) reasons.push('你的备注：' + m.text.slice(0, 60));
    }

    // (2) 这一段突然变快
    let segWpm = 0;
    if (seg && !seg.capped && avgWpm > 0) {
      segWpm = seg.wpm;
      const ratio = segWpm / avgWpm;
      if (ratio >= 1.5)       { score += 2.4; reasons.push(`语速 ${segWpm} 词/分，比你这节课的平均（${Math.round(avgWpm)}）快 ${pct(ratio - 1)}% —— 这一串是冲上去的`); }
      else if (ratio >= 1.3)  { score += 1.6; reasons.push(`语速 ${segWpm} 词/分，比平均快 ${pct(ratio - 1)}%`); }
      else if (ratio >= 1.18) { score += 0.9; reasons.push(`语速 ${segWpm} 词/分，略快于平均`); }
      if (segWpm > LV_FAST && ratio < 1.18) { score += 0.7; reasons.push(`语速 ${segWpm} 词/分，绝对值已经很快了`); }
    }

    // (3) 一口气太长
    const w = num(s.words, enWordCount(text));
    if (w >= 38)      { score += 2.0; reasons.push(`一口气 ${w} 个词没断开，中间没有喘气的地方`); }
    else if (w >= 30) { score += 1.3; reasons.push(`这句 ${w} 个词，偏长`); }

    // (4) 生词扎堆
    const terms = findTerms(text) || [];
    const covered = new Set();
    for (const tm of terms) for (const p of enWordList(tm.text || tm.en)) covered.add(p);
    const rare = rareWordsIn(text, covered);
    const density = w > 0 ? (terms.length + rare.length * 0.7) / w * 10 : 0;
    if (terms.length >= 4)      { score += 2.0; }
    else if (terms.length === 3) { score += 1.4; }
    else if (terms.length === 2) { score += 0.8; }
    if (terms.length >= 2) {
      reasons.push('术语扎堆：' + terms.slice(0, 4).map(x => `${x.en}（${x.zh}）`).join('、'));
    }
    if (rare.length >= 3)      { score += 1.5; reasons.push('还有不认识的词：' + rare.slice(0, 4).join('、')); }
    else if (rare.length === 2) { score += 0.7; reasons.push('生词：' + rare.join('、')); }
    if (density >= 2.2 && w >= 12) { score += 0.8; reasons.push('这句里几乎每五个词就有一个是你要查的'); }

    // (5) 连机器都没弄明白
    // 句级 zh 为空只说明「这句不是本段第一句」，要看段级有没有译文（见上面的注释）
    const zhSent = String(s.zh || '');
    const zhSeg = s.segId != null ? (segZh.get(s.segId) || '') : '';
    const zh = zhSent || zhSeg;
    if (!zh && shouldTranslate(text)) {
      // 译文空了有两种原因：句子太长太难（真信号），或者翻译器就是抽了一下（噪音）。
      // 短句上的翻译失败说明不了她没跟上，所以按句长打折 —— 9 个词的句子只给 1.2 分，
      // 单独这一条进不了榜；26 个词的长句才给满 2.2 分。
      score += 2.2 * Math.min(1, w / 16);
      reasons.push('译文是空的 —— 机器也没把这句弄明白，很可能是听错了或者太长');
    } else {
      // 句级有译文就按句判；否则用「整段 ↔ 整段」那次的结论，绝不拿一句去比整段
      const bad = zhSent
        ? degenerateReason(zhSent, text)
        : (s.segId != null ? (segDegen.get(s.segId) || '') : '');
      if (bad) { score += 2.0; reasons.push(`译文不对劲（${bad}）—— 别信字幕，直接听原声`); }
    }

    // (6) 重要 + 难 = 最该回听
    const isDef = defIdx.has(s.i);
    const empTag = empIdx.get(s.i);
    const taskTag = taskIdx.get(s.i);
    const hardish = w >= 26 || (segWpm > 0 && avgWpm > 0 && segWpm / avgWpm >= 1.2) || terms.length >= 3;
    if (isDef)  { score += 1.2; reasons.push('老师在这里下定义 —— 定义句基本都是考点'); }
    if (empTag) { score += 1.2; reasons.push(`老师在这里强调（${empTag}）`); }
    if (taskTag){ score += 0.9; reasons.push(`这句里有作业/考试信息（${taskTag}）—— 漏了代价最大`); }
    if ((isDef || empTag) && hardish) {
      score += 1.1; reasons.push('又重要又难 —— 全课最该花时间回听的就是这种句子');
    }

    // (7) 识别质量可疑
    const susp = suspIdx.get(s.i);
    if (susp && susp.length) {
      score += 1.5; reasons.push('识别质量可疑（' + susp.slice(0, 2).join('；') + '）—— 字幕可能是错的');
    }
    if (s.conf != null && Number(s.conf) < 0.5 && !(susp && susp.length)) {
      score += 0.8; reasons.push(`识别置信度只有 ${Number(s.conf).toFixed(2)}`);
    }

    // 太短的句子即使信号齐全也不该算「没跟上」——「The average quantity is eighty.」
    // 只有 5 个词，就算译文空了也不是听力问题。但她自己标记的那 5.2 分不能降。
    if (w < 8) {
      const markPart = Math.min(score, mks && mks.length ? 5.2 : 0);
      score = markPart + (score - markPart) * 0.5;
    }

    if (score < minScore || !reasons.length) continue;
    cand.push({
      segId: s.segId != null ? s.segId : (seg ? seg.id : null),
      sentIndex: s.i,
      t: num(s.t), tLabel: mmss(num(s.t)),
      text, zh,
      reasons, score: round1(score),
      severity: score >= 5 ? 'high' : score >= 3 ? 'mid' : 'low',
      wpm: segWpm || (seg ? seg.wpm : 0),
      words: w, terms, rare
    });
  }

  // 同一段里只留最难的那句（回听是按段播的，报三条一样的没意义）
  const bySeg = new Map();
  const loose = [];
  for (const c of cand) {
    if (c.segId == null) { loose.push(c); continue; }
    const cur = bySeg.get(c.segId);
    if (!cur) { bySeg.set(c.segId, c); continue; }
    if (c.score > cur.score) { c.alsoHard = (cur.alsoHard || 0) + 1; bySeg.set(c.segId, c); }
    else cur.alsoHard = (cur.alsoHard || 0) + 1;
  }
  const merged = [...bySeg.values(), ...loose];
  for (const c of merged) {
    if (c.alsoHard) c.reasons.push(`这一段里还有 ${c.alsoHard} 句同样偏难，建议整段回听`);
  }

  const rank = { high: 0, mid: 1, low: 2 };
  merged.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (a.t - b.t));
  return merged.slice(0, limit);
}

/* ===========================================================================
 * 六、catchUpWindow —— 「一个生词把后面三五句全带走了」
 * ---------------------------------------------------------------------------
 * 这是她最具体的痛点：不是某一句难，是某一句难之后**整段塌方**。
 * 所以不给单句，给一个可以整段回放的时间窗（主协调者直接拿 tStart/tEnd 变速循环）。
 * ========================================================================= */

/**
 * @param {Object} session
 * @param {Object} [opts] {limit=5, follow=4, maxSpanMs=45000, analysis}
 * @returns {{tStart, tEnd, durationMs, tLabel, segIds:number[]|string[],
 *            trigger:{t,text,zh,why}, items:Array, rescue:Object|null,
 *            severity:string, suggestRate:number, note:string}[]}
 */
export function catchUpWindow(session, opts = {}) {
  const limit = num(opts.limit, 5) || 5;
  const follow = num(opts.follow, 4) || 4;
  const maxSpan = num(opts.maxSpanMs, 45000) || 45000;

  const tl = buildTimeline(session, opts);
  if (tl.items.length < 2) return [];
  const missed = findMissed(session, Object.assign({}, opts, { limit: 40, minScore: 2.2 }));
  if (!missed.length) return [];

  const idxOf = new Map();
  tl.items.forEach((it, i) => { if (it.id != null) idxOf.set(it.id, i); });

  const raw = [];
  for (const m of missed) {
    // 只有「生词/术语触发」和「她自己标记」才会引起塌方；单纯长句不算
    const triggered = m.rare.length >= 2 || m.terms.length >= 2
      || m.reasons.some(r => r.startsWith('你当时标'));
    if (!triggered) continue;
    const i0 = m.segId != null && idxOf.has(m.segId) ? idxOf.get(m.segId) : -1;
    if (i0 < 0) continue;

    const chunk = [tl.items[i0]];
    for (let k = i0 + 1; k < tl.items.length && chunk.length <= follow; k++) {
      const it = tl.items[k];
      if (it.t - tl.items[i0].t > maxSpan) break;
      chunk.push(it);
    }
    if (chunk.length < 2) continue;

    // 这个窗口里老师有没有自己重讲一遍？有的话回听的收益特别高
    let rescue = null;
    for (const it of chunk) {
      for (const c of CUES) {
        if (c.k !== 'rescue') continue;
        if (c.re.test(it.text)) { rescue = { t: it.t, tLabel: mmss(it.t), zh: c.zh, text: it.text }; break; }
      }
      if (rescue) break;
    }

    // 她自己标过的，就直说是从她标的那句开始 —— 那是最确定的信息。
    // （原来把「她的标记」放在最后兜底，结果一句她标了 ⭐ 的话被解释成
    //  「从 textbook / professor 这两个术语开始」，而那两个词根本不是她卡住的原因。）
    const marked = m.reasons.some(r => r.startsWith('你当时标') || r.startsWith('你当时记'));
    const why = marked
      ? '从你当时标记的那一句开始'
      : m.rare.length >= 2
        ? `从「${m.rare.slice(0, 2).join(' / ')}」这两个生词开始`
        : m.terms.length >= 2
          ? `从「${m.terms.slice(0, 2).map(x => x.en).join(' / ')}」这两个术语开始`
          : '从这一句开始';

    const tStart = chunk[0].t;
    const tEnd = chunk[chunk.length - 1].end;
    raw.push({
      tStart, tEnd, durationMs: tEnd - tStart, tLabel: mmss(tStart),
      segIds: chunk.map(x => x.id),
      trigger: { t: m.t, tLabel: m.tLabel, text: m.text, zh: m.zh, why },
      items: chunk.map(x => ({ id: x.id, t: x.t, tLabel: mmss(x.t), text: x.text, wpm: x.wpm })),
      rescue,
      severity: m.severity,
      score: m.score + (rescue ? 1.2 : 0),
      suggestRate: 0.8,
      note: rescue
        ? `这段里老师自己换了个说法重讲（${mmss(rescue.t)}）—— 当时没懂，听到那儿就能接上`
        : `${why}，后面 ${chunk.length - 1} 句很可能一起丢了，整段听一遍`
    });
  }

  // 合并重叠的窗口 —— 但**必须封顶**。
  // 第一版没封顶，相邻触发点一个接一个地串起来，最后合出一个 120 秒 18 句的大块，
  // 那已经不是「回听一小段」而是「重听半节课」了，等于没做这个功能。
  const RANK0 = { high: 0, mid: 1, low: 2 };
  raw.sort((a, b) => a.tStart - b.tStart);
  const out = [];
  for (const w of raw) {
    const last = out[out.length - 1];
    if (last && w.tStart <= last.tEnd) {
      const wouldBe = Math.max(last.tEnd, w.tEnd) - last.tStart;
      if (wouldBe > maxSpan) {
        // 合不下了：重叠度高就丢掉（音频段基本重复），否则另起一个窗口
        if (w.tEnd <= last.tEnd) continue;
        out.push(w);
        continue;
      }
      if (w.tEnd > last.tEnd) {
        last.tEnd = w.tEnd;
        last.durationMs = last.tEnd - last.tStart;
        last.segIds = [...new Set(last.segIds.concat(w.segIds))];
        last.items = last.items.concat(w.items.filter(x => !last.items.some(y => y.id === x.id)));
      }
      last.score = Math.max(last.score, w.score);
      if (RANK0[w.severity] < RANK0[last.severity]) last.severity = w.severity;
      if (!last.rescue && w.rescue) { last.rescue = w.rescue; last.note = w.note; }
      continue;
    }
    out.push(w);
  }
  out.sort((a, b) => b.score - a.score || a.tStart - b.tStart);
  return out.slice(0, limit);
}

/* ===========================================================================
 * 七、teacherProfile —— 同一位老师的多节课汇总
 * ========================================================================= */

/**
 * 话语标记核心词。抽口头禅必须含其中至少一个 ——
 * 第一版只要求「大部分是虚词」，结果抽出来的是 "in the" / "by the" / "change in"，
 * 那是普通英语搭配不是口头禅，对她毫无用处。口头禅的定义是**不承载命题内容**，
 * 而不承载内容的词就是下面这些。
 */
const DISCOURSE_CORE = new Set(('know mean sort kind right okay ok alright anyway actually basically '
  + 'literally essentially obviously honestly frankly seriously whatever guys folks um uh yeah sure').split(' '));

/**
 * 抽口头禅。两条路：
 *   1) 先按 CUES 表数 —— 这些有现成的中文解释，对她最有用（哪些能扔、哪些是救命信号）
 *   2) 再挖这位老师自己的高频话语标记（必须含 DISCOURSE_CORE 词）
 */
function extractQuirks(sessionTexts, sessionCount) {
  const result = [];
  sessionCount = Math.max(1, num(sessionCount, sessionTexts.length));

  // 1) 表内命中
  for (const c of CUES) {
    let count = 0;
    const inSess = new Set();
    for (let si = 0; si < sessionTexts.length; si++) {
      for (const line of sessionTexts[si]) {
        if (c.re.test(line)) { count++; inSess.add(si); }
      }
    }
    // 说 1~2 次不叫口头禅。（prepPack 的「救命信号」小节另有兜底，不受这条影响。）
    if (count >= 3) {
      result.push({ phrase: c.p, count, sessions: inSess.size, kind: c.k, zh: c.zh, curated: true });
    }
  }

  // 2) 自由发现
  const gram = new Map();
  for (let si = 0; si < sessionTexts.length; si++) {
    for (const line of sessionTexts[si]) {
      const ws = enWordList(line);
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= ws.length; i++) {
          const parts = ws.slice(i, i + n);
          let hasCore = false, allSoft = true;
          for (const w of parts) {
            if (DISCOURSE_CORE.has(w)) hasCore = true;
            if (!COMMON.has(w) && !FILLER.has(w) && !DISCOURSE_CORE.has(w)) { allSoft = false; break; }
          }
          if (!hasCore || !allSoft) continue;
          const key = parts.join(' ');
          let g = gram.get(key);
          if (!g) { g = { count: 0, sessions: new Set() }; gram.set(key, g); }
          g.count++; g.sessions.add(si);
        }
      }
    }
  }
  const minCount = Math.max(4, sessionCount * 2);
  let found = [];
  for (const [phrase, g] of gram) {
    if (g.count < minCount) continue;
    if (sessionCount >= 2 && g.sessions.size < 2) continue;
    found.push({ phrase, count: g.count, sessions: g.sessions.size, n: phrase.split(' ').length });
  }
  // 留最长的那个：有「you know what i mean」就不要「you know」
  found.sort((a, b) => b.n - a.n || b.count - a.count);
  const kept = [];
  for (const it of found) {
    if (kept.some(k => k.n > it.n && k.phrase.indexOf(it.phrase) >= 0 && k.count >= it.count * 0.6)) continue;
    kept.push(it);
  }
  // 已经被 CUES 表覆盖的不重复报
  const covered = result.map(r => r.phrase.toLowerCase());
  for (const it of kept) {
    if (covered.some(c => c.indexOf(it.phrase) >= 0 || it.phrase.indexOf(c.split(' / ')[0]) >= 0)) continue;
    result.push({
      phrase: it.phrase, count: it.count, sessions: it.sessions, kind: 'skip',
      zh: '他的口头禅，不承载信息 —— 听到可以直接跳过，不用停下来想', curated: false
    });
  }

  result.sort((a, b) => b.count - a.count);
  return result.slice(0, 14);
}

/**
 * @param {Array} sessions 同一位老师的若干节课
 * @returns {{wpm, trend, quirks, topTerms, hardestSessions, sessionCount, levelCN, comment}}
 */
export function teacherProfile(sessions, opts = {}) {
  const list = (Array.isArray(sessions) ? sessions : [sessions]).filter(s => s && segmentsOf(s).length);
  // 字段必须和正常路径一模一样：少了 level / sessions，调用方一个
  // profile.sessions.map(...) 就在「还没上课」这个最常见的状态下炸掉。
  const empty = {
    wpm: 0, level: 'normal', trend: { dir: 'flat', slope: 0, text: '课还太少，看不出变化' },
    quirks: [], topTerms: [], hardestSessions: [], sessionCount: 0, sessions: [],
    levelCN: '—', comment: '还没有足够的课可以分析。'
  };
  if (!list.length) return empty;

  list.sort((a, b) => num(a.startedAt) - num(b.startedAt));

  const per = [];
  const texts = [];
  const termCount = new Map();

  for (const s of list) {
    const st = paceStats(s, opts);
    const segs = segmentsOf(s).filter(isSpeech);
    const lines = segs.map(x => String(x.text || ''));
    texts.push(lines);

    // 术语统计
    for (const line of lines) {
      for (const tm of (findTerms(line) || [])) {
        const k = tm.en.toLowerCase();
        let e = termCount.get(k);
        if (!e) { e = { en: tm.en, zh: tm.zh, field: tm.field, count: 0, sessions: new Set() }; termCount.set(k, e); }
        e.count++; e.sessions.add(s.id);
      }
    }

    // 这节课难不难
    const missed = findMissed(s, { limit: 60, minScore: 2.2 });
    const highs = missed.filter(m => m.severity === 'high').length;
    const mins = Math.max(1, st.speechMs / 60000);
    const longShare = segs.length ? segs.filter(x => enWordCount(x.text) >= 30).length / segs.length : 0;
    // 只有 3 分钟的课，1 句难句就等于「每十分钟 3.3 句」，会把短课顶到最难。
    // 按样本量往下收缩（不足 10 分钟按比例打折），避免短课虚高。
    const shrink = Math.min(1, mins / 10);
    const hardScore = (st.wpm / 10) + (highs / mins) * 6 * shrink + longShare * 20 + st.fastShare * 10;

    per.push({
      id: s.id, title: s.title || '（未命名）', startedAt: num(s.startedAt),
      wpm: st.wpm, wpmPeak: st.wpmPeak, level: st.level, levelCN: st.levelCN,
      minutes: Math.round(mins), hardCount: highs, hardPerTenMin: round1(highs / mins * 10),
      longSentenceShare: Math.round(longShare * 100) / 100,
      score: round1(hardScore), speechMs: st.speechMs, words: st.words
    });
  }

  // 加权平均语速（按说话时长加权，不是按节数）
  const totalW = per.reduce((a, x) => a + x.words, 0);
  const totalMs = per.reduce((a, x) => a + x.speechMs, 0);
  const wpm = totalMs > 0 ? Math.round(totalW / (totalMs / 60000)) : 0;

  // 趋势：对节次做最小二乘
  let trend = { dir: 'flat', slope: 0, text: '课还太少，看不出变化' };
  if (per.length >= 3) {
    const n = per.length;
    const mx = (n - 1) / 2;
    const my = per.reduce((a, x) => a + x.wpm, 0) / n;
    let sxy = 0, sxx = 0;
    per.forEach((x, i) => { sxy += (i - mx) * (x.wpm - my); sxx += (i - mx) * (i - mx); });
    const slope = sxx > 0 ? sxy / sxx : 0;
    const total = slope * (n - 1);
    if (total >= 8)       trend = { dir: 'up',   slope: round1(slope), text: `这几节课他在越讲越快（整体快了约 ${Math.round(total)} 词/分）—— 多半是开学的客气劲过去了，别以为是你退步了` };
    else if (total <= -8) trend = { dir: 'down', slope: round1(slope), text: `他在放慢（整体慢了约 ${Math.round(-total)} 词/分）—— 也可能是你越来越听得懂了` };
    else                  trend = { dir: 'flat', slope: round1(slope), text: '语速很稳定，这是好事：稳定的节奏最容易适应' };
  }

  const quirks = extractQuirks(texts, per.length);

  const topTerms = [...termCount.values()]
    .sort((a, b) => b.count - a.count || b.sessions.size - a.sessions.size)
    .slice(0, num(opts.termLimit, 30) || 30)
    .map(e => ({ en: e.en, zh: e.zh, field: e.field, count: e.count, sessions: e.sessions.size }));

  const hardestSessions = per.slice().sort((a, b) => b.score - a.score).slice(0, 5).map(x => ({
    id: x.id, title: x.title, startedAt: x.startedAt, wpm: x.wpm, score: x.score,
    hardCount: x.hardCount,
    why: `${x.wpm} 词/分（${x.levelCN}）、${x.minutes} 分钟里有 ${x.hardCount} 句高难度、`
       + `${pct(x.longSentenceShare)}% 的句子超过 30 个词`
  }));

  const level = levelOf(wpm);
  const comment = per.length === 1
    ? paceComment(wpm, level, 'timed')
    : `这位老师 ${per.length} 节课平均 ${wpm} 词/分（${LEVEL_CN[level]}）。${trend.text}。`
      + (quirks.length && quirks[0].count >= 5
          ? `他有几个固定口头禅，「${quirks[0].phrase}」就说了 ${quirks[0].count} 次 —— 这些词不用听。`
          : quirks.length
            ? `他常用的话语标记有 ${quirks.length} 个（最多的是「${quirks[0].phrase}」，${quirks[0].count} 次），预习包里有解释。`
            : '');

  return { wpm, level, levelCN: LEVEL_CN[level], trend, quirks, topTerms, hardestSessions, sessionCount: per.length, sessions: per, comment };
}

/* ===========================================================================
 * 八、prepPack —— 课前五分钟过一遍
 * ========================================================================= */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function say2(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10), o = n % 10;
  return o ? TENS[t] + '-' + ONES[o] : TENS[t];
}

/** 年份怎么念 —— 听数字是中国学生最经典的失分点 */
function sayYear(y) {
  if (y < 1000 || y > 2999) return '';
  const hi = Math.floor(y / 100), lo = y % 100;
  if (y % 1000 === 0) return say2(Math.floor(y / 1000)) + ' thousand';
  if (lo === 0) return say2(hi) + ' hundred';
  if (hi === 20 && lo < 10) return 'two thousand ' + ONES[lo];      // 2007 → two thousand seven
  if (lo < 10) return say2(hi) + ' oh ' + ONES[lo];                 // 1905 → nineteen oh five
  return say2(hi) + ' ' + say2(lo);                                 // 1789 → seventeen eighty-nine
}

/**
 * 数字。**关键**：语音转写出来的数字是拼写的，不是阿拉伯数字 ——
 * 老师说的是 "chapter five"、"ten percent"、"nineteen ninety-three"、"eleven fifty-nine"，
 * 只匹配 \d+ 的话一节课一个都抓不到（第一版就是这样，numbers 永远是空的）。
 */
// 必须长的在前：正则的 | 是「先匹配到谁算谁」，
// 把 eight 放在 eighteen 前面的话 "problems eleven through eighteen" 会被切成 "...through eight"。
const NW = '(?:seventeen|thirteen|fourteen|eighteen|nineteen|thousand|fifteen|sixteen|seventy'
  + '|hundred|million|billion|eleven|twelve|twenty|thirty|eighty|ninety|three|seven|eight'
  + '|forty|fifty|sixty|four|five|nine|zero|one|two|six|ten)';
const NUMX = '(?:' + NW + '(?:[- ]' + NW + ')*|\\d+(?:\\.\\d+)?)';

const NUM_PATTERNS = [
  { re: new RegExp('\\b(chapter|section|unit|module|lecture|week|problem|problems|question|questions|figure|table|appendix|page|pages)s?\\s+(' + NUMX + '(?:\\s+(?:through|to|and|[-–])\\s+' + NUMX + ')?)', 'gi'), kind: '章节/页码' },
  { re: new RegExp('\\b(' + NUMX + ')\\s*(?:%|percent)\\b', 'gi'), kind: '百分比' },
  { re: /\$\s?\d+(?:[,.]\d+)*\b/g, kind: '金额' },
  { re: new RegExp('\\b(' + NUMX + ')\\s+dollars?\\b', 'gi'), kind: '金额' },
  { re: /\b(1[5-9]\d{2}|20\d{2})\b/g, kind: '年份' },
  // 念出来的年份：nineteen ninety-three / nineteen ninety seven / two thousand seven / nineteen oh five
  // 个位那一节**空格和连字符都要认**：原来只写了 (?:-\w+)?，
  // 于是 "nineteen ninety seven" 只截到 "nineteen ninety"，
  // 预习包里把 1997 教成 1990 —— 数字本来就是她最容易漏的东西，给错比不给更糟。
  { re: /\b(?:nineteen|eighteen|seventeen|sixteen)\s+(?:oh[-\s]+(?:one|two|three|four|five|six|seven|eight|nine)|hundred|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?)\b/gi, kind: '年份（念出来的）' },
  { re: /\btwo thousand(?:\s+(?:and\s+)?\w+)?\b/gi, kind: '年份（念出来的）' },
  // 时间：eleven fifty-nine pm / two to four
  { re: new RegExp('\\b' + NUMX + '\\s+' + NUMX + '\\s*(?:a\\.?m\\.?|p\\.?m\\.?)', 'gi'), kind: '时间' },
  { re: new RegExp('\\b(' + NUMX + ')\\s*(kg|grams?|km|meters?|cm|mm|seconds?|minutes?|hours?|degrees?|volts?|joules?|hertz|hz)\\b', 'gi'), kind: '数值+单位' }
];

/**
 * 课前预习包：把这门课之前所有课的术语、口头禅、救命信号、数字都汇总成一张纸。
 * @param {Array} sessions
 * @param {Object} [opts] {termLimit=40, phraseLimit=10, numberLimit=15, minCount=2, courseName, teacherName}
 * @returns {{terms, phrases, rescues, numbers, markdown, meta}}
 */
export function prepPack(sessions, opts = {}) {
  const list = (Array.isArray(sessions) ? sessions : [sessions]).filter(s => s && segmentsOf(s).length);
  const termLimit = num(opts.termLimit, 40) || 40;
  const numberLimit = num(opts.numberLimit, 15) || 15;
  const minCount = num(opts.minCount, 2) || 2;

  const termMap = new Map();
  const rareMap = new Map();
  const numMap = new Map();
  const texts = [];
  let totalWords = 0, totalMs = 0;

  for (const s of list) {
    const segs = segmentsOf(s).filter(isSpeech);
    const lines = segs.map(x => String(x.text || ''));
    texts.push(lines);
    const st = paceStats(s, {});
    totalWords += st.words; totalMs += st.speechMs;

    for (const line of lines) {
      const hits = findTerms(line) || [];
      const covered = new Set();
      for (const tm of hits) {
        for (const p of enWordList(tm.text || tm.en)) covered.add(p);
        const k = tm.en.toLowerCase();
        let e = termMap.get(k);
        if (!e) { e = { en: tm.en, zh: tm.zh, note: tm.note, field: tm.field, count: 0, sessions: new Set() }; termMap.set(k, e); }
        e.count++; e.sessions.add(s.id);
      }
      // 不在术语表里、但反复出现的生词 —— 这门课自己的行话
      for (const w of rareWordsIn(line, covered)) {
        let e = rareMap.get(w);
        if (!e) { e = { en: w, count: 0, sessions: new Set() }; rareMap.set(w, e); }
        e.count++; e.sessions.add(s.id);
      }
      // 数字
      for (const p of NUM_PATTERNS) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(line)) !== null) {
          const phrase = m[0].trim();
          const k = p.kind + '|' + phrase.toLowerCase();
          let e = numMap.get(k);
          if (!e) {
            const say = p.kind === '年份' ? sayYear(Number(m[0])) : '';
            e = { text: phrase, kind: p.kind, spoken: say, count: 0, sample: line.trim().slice(0, 120) };
            numMap.set(k, e);
          }
          e.count++;
        }
      }
    }
  }

  const terms = [...termMap.values()]
    .sort((a, b) => b.count - a.count || b.sessions.size - a.sessions.size)
    .slice(0, termLimit)
    .map(e => ({ en: e.en, zh: e.zh, note: e.note || '', field: e.field, count: e.count, sessions: e.sessions.size }));

  const jargon = [...rareMap.values()]
    .filter(e => e.count >= Math.max(minCount, 3))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map(e => ({ en: e.en, count: e.count, sessions: e.sessions.size }));

  const quirkList = extractQuirks(texts, list.length);
  const phrases = quirkList.filter(q => q.kind === 'skip' || q.kind === 'turn');
  const rescues = quirkList.filter(q => q.kind === 'rescue');
  // 救命信号即使这位老师说得不多，也要让她知道存在 —— 这是通用技能
  const rescueSet = new Set(rescues.map(r => r.phrase));
  for (const c of CUES) {
    if (c.k !== 'rescue' || rescues.length >= 8) continue;
    if (rescueSet.has(c.p)) continue;
    rescueSet.add(c.p);
    rescues.push({ phrase: c.p, count: 0, sessions: 0, kind: 'rescue', zh: c.zh });
  }

  // 排序：章节/时间/年份这类「结构性数字」优先 —— 漏了就找不到作业在哪、考试几点。
  // 例题里的算术（六美元、八美元）只有重复出现才值得放进预习包。
  const NUM_RANK = { '章节/页码': 0, '时间': 0, '年份': 1, '年份（念出来的）': 1, '数值+单位': 2, '百分比': 3, '金额': 3 };
  const numbers = [...numMap.values()]
    .filter(e => (NUM_RANK[e.kind] <= 1) || e.count >= 2)
    .sort((a, b) => (NUM_RANK[a.kind] - NUM_RANK[b.kind]) || (b.count - a.count))
    .slice(0, numberLimit);

  const wpm = totalMs > 0 ? Math.round(totalWords / (totalMs / 60000)) : 0;
  const course = opts.courseName || (list[0] && list[0].title) || '这门课';
  const teacher = opts.teacherName || '';

  /* —— Markdown —— */
  const L = [];
  L.push(`# 课前五分钟：${course}${teacher ? ' · ' + teacher : ''}`);
  L.push('');
  L.push(`> 基于之前 **${list.length}** 节课整理。${wpm ? `老师平均 **${wpm} 词/分**（${LEVEL_CN[levelOf(wpm)]}）。` : ''}`);
  L.push('> 上课前把下面四块扫一遍就行，不用背 —— **认出来**比**想起来**重要得多。');
  L.push('');

  if (terms.length) {
    L.push(`## 一、这门课一定会出现的词（${terms.length} 个）`);
    L.push('');
    L.push('| 英文 | 中文 | 出现 | 几节课 |');
    L.push('| --- | --- | --- | --- |');
    for (const t of terms) L.push(`| ${t.en} | ${t.zh}${t.note ? '（' + t.note + '）' : ''} | ${t.count} | ${t.sessions} |`);
    L.push('');
  }
  if (jargon.length) {
    L.push('## 二、这位老师爱用、但不在标准术语表里的词');
    L.push('');
    L.push('（这些是这门课自己的行话，查一下意思，下次听到就不会愣住）');
    L.push('');
    for (const j of jargon) L.push(`- **${j.en}** —— 出现 ${j.count} 次`);
    L.push('');
  }
  L.push('## 三、听到这些，说明老师要再讲一遍 —— 这是你补救的机会');
  L.push('');
  L.push('> 这一条最重要。你说「听到生词就愣住，后面三五句全丢」——');
  L.push('> 其实老师讲课有个习惯：重要的东西一定会换个说法再说一次。');
  L.push('> **愣住的时候不要去想那个词，去等下面这些信号。** 听到了，就能重新接上。');
  L.push('');
  for (const r of rescues.slice(0, 8)) {
    L.push(`- **${r.phrase}**${r.count ? `（他说过 ${r.count} 次）` : ''} —— ${r.zh}`);
  }
  L.push('');
  if (phrases.length) {
    L.push('## 四、这些是口头禅，听到直接扔掉');
    L.push('');
    L.push('（不用听懂，不用翻译，它们不承载任何信息 —— 省下来的注意力留给内容）');
    L.push('');
    for (const p of phrases.slice(0, 10)) L.push(`- **${p.phrase}** × ${p.count} —— ${p.zh}`);
    L.push('');
  }
  if (numbers.length) {
    L.push('## 五、数字（口语里最容易漏的东西）');
    L.push('');
    for (const nEntry of numbers) {
      L.push(`- \`${nEntry.text}\` · ${nEntry.kind}${nEntry.spoken ? ` · 念作 **${nEntry.spoken}**` : ''}${nEntry.count > 1 ? ` · 出现 ${nEntry.count} 次` : ''}`);
    }
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('**用法**：不要逐个背。从头扫到尾，每个词看一眼中文就翻篇，全程不超过 5 分钟。');
  L.push('目标只有一个 —— 上课时这些词从耳朵进来的时候，你不会停下来想「这是什么」。');
  L.push('');

  return {
    terms, jargon, phrases, rescues, numbers,
    markdown: L.join('\n'),
    meta: { sessionCount: list.length, wpm, level: levelOf(wpm), termTotal: termMap.size }
  };
}

/* ===========================================================================
 * 九、threeMinuteRecap —— 下课路上三分钟
 * ========================================================================= */

/**
 * 从一节课里挑 8~12 句最值得回听的。
 * @param {Object} session
 * @param {Object} [opts] {min=8, max=12, analysis}
 * @returns {{items:[{t,tLabel,text,zh,why,kind,segId}], markdown, meta}}
 */
export function threeMinuteRecap(session, opts = {}) {
  const minN = num(opts.min, 8) || 8;
  const maxN = num(opts.max, 12) || 12;
  const ana = getAnalysis(session, opts);
  const sents = ana.sentences || [];
  if (!sents.length) return { items: [], markdown: '# 三分钟速览\n\n这节课还没有内容。\n', meta: { count: 0 } };

  const st = paceStats(session, opts);
  const missed = findMissed(session, Object.assign({}, opts, { limit: 30, minScore: 2.2 }));
  const missedBySent = new Map(missed.map(m => [m.sentIndex, m]));

  const pool = new Map();   // sentIndex -> {w, why, kind}
  const add = (i, w, why, kind) => {
    const s = sents[i];
    if (!s || !String(s.text || '').trim()) return;
    if (s.words < 5) return;
    let e = pool.get(i);
    if (!e) { e = { i, w: 0, why: [], kind }; pool.set(i, e); }
    e.w += w;
    if (why && !e.why.includes(why)) e.why.push(why);
    if (kind && !e.kind) e.kind = kind;
  };

  // 她自己标记的 —— 权重最高
  for (const m of missed) {
    if (m.reasons.some(r => r.startsWith('你当时标'))) add(m.sentIndex, 6, '你当时标记了这里', '⭐ 你的标记');
  }
  // 考点 / 强调
  for (const e of (ana.emphases || []).slice(0, 8)) add(e.i, 4.5 + (e.weight || 0) * 0.4, `老师明确强调（${e.tag || '重点'}）`, '考点');
  // 定义
  for (const d of (ana.definitions || []).slice(0, 8)) add(d.i, 4.2, `老师给「${cleanTerm(d.term)}」下了定义`, '定义');
  // 作业 / 考试
  for (const tk of (ana.tasks || []).slice(0, 6)) {
    add(tk.i, tk.urgent ? 5.5 : 4.0,
      `作业/考试信息${tk.dates && tk.dates.length ? '：' + tk.dates.map(x => x.zh || x.raw || x).join('、') : ''}`, '待办');
  }
  // 公式
  for (const f of (ana.formulas || []).slice(0, 4)) add(f.i, 3.4, '公式/数字，听一遍比看一遍准', '公式');
  // 各主题的关键句，保证覆盖全课而不是挤在一段
  for (const tp of (ana.topics || [])) {
    const k = (tp.keySentences || [])[0];
    if (k) add(k.i, 2.6, `「${tp.title}」这一段的主句`, '脉络');
  }
  // 她可能没跟上的高难句
  for (const m of missed) {
    if (m.severity === 'high') add(m.sentIndex, 3.0, '这句你很可能没跟上', '难句');
  }

  let cands = [...pool.values()].sort((a, b) => b.w - a.w);

  // 时间上别挤在一起：同一个 20 秒窗口里最多留一条
  const picked = [];
  const usedWindow = new Set();
  for (const c of cands) {
    if (picked.length >= maxN) break;
    const s = sents[c.i];
    const win = Math.floor(num(s.t) / 20000);
    if (usedWindow.has(win) && picked.length >= minN) continue;
    if (usedWindow.has(win) && picked.some(p => Math.abs(num(sents[p.i].t) - num(s.t)) < 8000)) continue;
    usedWindow.add(win);
    picked.push(c);
  }
  // 还不够 minN 就放宽
  if (picked.length < minN) {
    for (const c of cands) {
      if (picked.length >= minN) break;
      if (!picked.includes(c)) picked.push(c);
    }
  }

  picked.sort((a, b) => num(sents[a.i].t) - num(sents[b.i].t));

  // 同 findMissed：段级中文只挂在本段第一句上，不回退的话速览里大半条目会「只有英文没中文」
  const recapSegZh = new Map();
  for (const sg of segmentsOf(session)) if (sg && sg.id != null) recapSegZh.set(sg.id, String(sg.zh || ''));

  const items = picked.map(c => {
    const s = sents[c.i];
    const m = missedBySent.get(c.i);
    return {
      segId: s.segId != null ? s.segId : null,
      sentIndex: c.i,
      t: num(s.t), tLabel: mmss(num(s.t)),
      text: String(s.text || ''),
      zh: String(s.zh || '') || (s.segId != null ? (recapSegZh.get(s.segId) || '') : ''),
      kind: c.kind || '重点',
      why: c.why.join('；'),
      hard: !!m,
      weight: round1(c.w)
    };
  });

  /* —— Markdown —— */
  const title = (session && session.title) || '这节课';
  const L = [];
  L.push(`# 三分钟速览 · ${title}`);
  L.push('');
  L.push(`> 全课 ${Math.round(st.durationMs / 60000)} 分钟，挑出 **${items.length}** 句。`);
  L.push(`> 老师 ${st.wpm} 词/分（${st.levelCN}）。${st.level === 'fast' || st.level === 'very-fast' ? '今天确实偏快，漏了很正常。' : ''}`);
  L.push('> 点时间戳直接听原声 —— **看文字没用，得让耳朵再过一遍这个速度。**');
  L.push('');
  for (const it of items) {
    L.push(`### \`${it.tLabel}\` · ${it.kind}${it.hard ? ' · 你可能没跟上' : ''}`);
    L.push('');
    L.push(`> ${it.text}`);
    if (it.zh) L.push(`>`, `> ${it.zh}`);
    L.push('');
    L.push(`*${it.why}*`);
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('**怎么用**：走路回宿舍的时候，从上往下点一遍，每条听原声，不要看字。');
  L.push('能听懂的就跳过，卡住的那条按 0.8 倍速再听两遍 —— 三分钟，比看半小时讲稿有用。');
  L.push('');

  return {
    items,
    markdown: L.join('\n'),
    meta: { count: items.length, wpm: st.wpm, level: st.level, durationMs: st.durationMs }
  };
}

/* ===========================================================================
 * 十、paceDrill —— 变速阶梯（直接对接「点一句 → 变速播放」）
 * ========================================================================= */

/**
 * 根据这节课的实际语速，算出她该从几倍速开始练、什么时候提速。
 * 目标锚点是 TOEFL 听力的 150 词/分 —— 那是她已经适应过的速度。
 * @param {Object} session
 * @param {Object} [opts] {target=150}
 */
export function paceDrill(session, opts = {}) {
  const target = num(opts.target, TOEFL_WPM) || TOEFL_WPM;
  const st = paceStats(session, opts);
  // 同 teacherProfile：空课时也要给齐 level / target，否则 UI 读这两个字段会拿到 undefined
  if (!st.wpm) return { wpm: 0, level: 'normal', target, startRate: 1, ladder: [], markdown: '# 变速阶梯\n\n这节课还没有内容。\n' };

  // 起步倍速：让「听上去的语速」≈ 她熟悉的 150，向下取到 0.05 的整数倍
  let start = Math.floor(target / st.wpm * 20) / 20;
  start = clamp(start, 0.6, 1);

  const ladder = [];
  for (let r = start; r <= 1.0001; r = Math.round((r + 0.1) * 100) / 100) {
    const rr = Math.min(1, Math.round(r * 100) / 100);
    const eff = Math.round(st.wpm * rr);
    ladder.push({
      rate: rr, effectiveWpm: eff, level: levelOf(eff), levelCN: LEVEL_CN[levelOf(eff)],
      goal: rr >= 1
        ? '原速。能不看字幕听懂一半就算过关 —— 不用追求全懂，母语同学也不是全懂。'
        : `听上去相当于 ${eff} 词/分（${LEVEL_CN[levelOf(eff)]}）。同一段连听两遍，第二遍能跟上就升一档。`
    });
    if (rr >= 1) break;
  }
  // 超速一档：在 1.1 待一会儿再回 1.0，原速会突然变得很轻松。这是听力训练里很有效的一招。
  ladder.push({
    rate: 1.1, effectiveWpm: Math.round(st.wpm * 1.1), level: 'very-fast', levelCN: LEVEL_CN['very-fast'],
    goal: '加练档：在 1.1 倍速下听一遍（会很难受，正常），然后马上切回 1.0 —— 原速会突然变慢。'
  });

  const L = [];
  L.push('# 变速阶梯');
  L.push('');
  L.push(`> 这位老师 **${st.wpm} 词/分**（${st.levelCN}）。你练过的 TOEFL 听力大约 ${target} 词/分。`);
  L.push(`> 所以从 **${start.toFixed(2)} 倍速** 开始最合适 —— 那是你耳朵已经认识的速度。`);
  L.push('');
  L.push('| 倍速 | 听上去的语速 | 这一档要做到 |');
  L.push('| --- | --- | --- |');
  for (const s of ladder) L.push(`| ${s.rate.toFixed(2)}× | ${s.effectiveWpm} 词/分（${s.levelCN}） | ${s.goal} |`);
  L.push('');
  L.push('**别跳档。** 适应语速靠的是重复听真实语速的音频，不是听懂内容 ——');
  L.push('同一段在 0.8 倍速听十遍，比十段不同的内容在 1.0 倍速各听一遍有用。');
  L.push('');

  return { wpm: st.wpm, level: st.level, target, startRate: start, ladder, markdown: L.join('\n') };
}

/* ===========================================================================
 * 十一、shadowingPlan —— 跟读训练
 * ========================================================================= */

/**
 * 挑出适合跟读的句子：长度适中、语速接近老师平均、生词不多。
 * 跟读（shadowing）是适应语速最直接的练法 —— 嘴巴跟得上，耳朵就跟得上。
 * @param {Object} session
 * @param {Object} [opts] {count=6, minWords=8, maxWords=20}
 */
export function shadowingPlan(session, opts = {}) {
  const count = num(opts.count, 6) || 6;
  const minW = num(opts.minWords, 8) || 8;
  const maxW = num(opts.maxWords, 20) || 20;

  const tl = buildTimeline(session, opts);
  const st = paceStats(session, opts);
  if (!tl.items.length) return { items: [], markdown: '# 跟读训练\n\n这节课还没有内容。\n' };

  const scored = [];
  for (const it of tl.items) {
    if (it.words < minW || it.words > maxW) continue;
    const terms = findTerms(it.text) || [];
    const covered = new Set();
    for (const tm of terms) for (const p of enWordList(tm.text || tm.en)) covered.add(p);
    const rare = rareWordsIn(it.text, covered);
    if (rare.length > 2) continue;                       // 生词太多就不是练语速而是练单词了
    if (!/[a-z]/i.test(it.text)) continue;
    // 越接近平均语速越有代表性
    const dev = st.wpm > 0 && !it.capped ? Math.abs(it.wpm - st.wpm) / st.wpm : 0.5;
    const s = 3 - dev * 3 + (terms.length ? 0.6 : 0) + (it.words >= 12 && it.words <= 18 ? 0.8 : 0);
    scored.push({ it, s, terms, rare });
  }
  scored.sort((a, b) => b.s - a.s);

  // 时间上摊开，别全挑同一段
  const items = [];
  for (const c of scored) {
    if (items.length >= count) break;
    if (items.some(x => Math.abs(x.t - c.it.t) < 30000)) continue;
    items.push({
      segId: c.it.id, t: c.it.t, tLabel: mmss(c.it.t),
      text: c.it.text, words: c.it.words, wpm: c.it.wpm,
      terms: c.terms.map(x => ({ en: x.en, zh: x.zh })),
      rates: [0.75, 0.9, 1.0]
    });
  }
  items.sort((a, b) => a.t - b.t);

  const L = [];
  L.push('# 跟读训练（每天 10 分钟）');
  L.push('');
  L.push('> 跟读是适应语速最直接的办法：**嘴巴跟得上的速度，耳朵才跟得上。**');
  L.push('> 下面这几句是从今天课上挑的，长度和语速都最有代表性。');
  L.push('');
  L.push('每句三轮：`0.75×` 看着字幕读 → `0.9×` 不看字幕读 → `1.0×` 同步跟上老师。');
  L.push('');
  for (const it of items) {
    L.push(`### \`${it.tLabel}\` · ${it.words} 词 · ${it.wpm} 词/分`);
    L.push('');
    L.push(`> ${it.text}`);
    if (it.terms.length) L.push('', `术语：${it.terms.map(t => `${t.en}（${t.zh}）`).join('、')}`);
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('读不顺的地方就是你听不出来的地方 —— 那个连读、那个吞音，正是课上漏掉它的原因。');
  L.push('');

  return { items, markdown: L.join('\n') };
}

/* ===========================================================================
 * 十二、reviewQueue —— 生词的间隔复习
 * ========================================================================= */

/**
 * 「每门课的生词其实是固定的那几百个」—— 那就按出现频次 + 时间衰减排个队，
 * 每天只过 20 个。不依赖任何额外存储：已经会的词由调用方通过 opts.known 传进来。
 * @param {Array} sessions
 * @param {Object} [opts] {limit=20, known=[], now=Date.now()}
 */
export function reviewQueue(sessions, opts = {}) {
  const list = (Array.isArray(sessions) ? sessions : [sessions]).filter(s => s && segmentsOf(s).length);
  const limit = num(opts.limit, 20) || 20;
  const now = num(opts.now, Date.now()) || Date.now();
  const known = new Set((opts.known || []).map(x => String(x).toLowerCase()));

  const map = new Map();
  for (const s of list) {
    const when = num(s.startedAt, now);
    for (const seg of segmentsOf(s).filter(isSpeech)) {
      const line = String(seg.text || '');
      const hits = findTerms(line) || [];
      const covered = new Set();
      for (const tm of hits) {
        for (const p of enWordList(tm.text || tm.en)) covered.add(p);
        const k = tm.en.toLowerCase();
        if (known.has(k)) continue;
        let e = map.get(k);
        if (!e) {
          e = { en: tm.en, zh: tm.zh, note: tm.note || '', field: tm.field, count: 0,
                sessions: new Set(), first: when, last: when, sample: '' };
          map.set(k, e);
        }
        e.count++; e.sessions.add(s.id);
        e.first = Math.min(e.first, when); e.last = Math.max(e.last, when);
        if (!e.sample && line.length > 20) e.sample = line.trim().slice(0, 140);
      }
    }
  }

  const DAY = 86400000;
  const out = [...map.values()].map(e => {
    const daysSince = Math.max(0, (now - e.last) / DAY);
    // 频次越高越该会，但隔得越久越该复习；只在一节课出现过的先往后放
    const recall = Math.exp(-daysSince / (3 + e.count * 1.5));    // 估计的「还记得吗」，0~1
    // 当天就打开复习时 daysSince≈0 → recall≈1 → (1-recall)≈0，
    // 于是**每个词的 priority 都是 0**，排序完全退化成「谁先在转写里出现」：
    // 下课当晚点开「今天复习这 20 个词」，给的是开场白里的词，不是这节课最重要的词。
    // 所以给个频次底盘：遗忘程度只决定 25%~100% 的加权，剩下的永远由「出现多少次、
    // 跨多少节课」说了算 —— 刚下课时按重要性排，隔了几天才按「快忘了」往前顶。
    const urgency = 0.25 + 0.75 * (1 - recall);
    const value = urgency * (Math.log(1 + e.count) + e.sessions.size * 0.6);
    return {
      en: e.en, zh: e.zh, note: e.note, field: e.field,
      count: e.count, sessions: e.sessions.size,
      lastSeen: e.last, daysSince: Math.round(daysSince),
      recall: Math.round(recall * 100) / 100,
      priority: round1(value),
      sample: e.sample,
      why: e.sessions.size >= 3 ? `${e.sessions.size} 节课里都出现过，是这门课的地基词`
        : daysSince >= 7 ? `${Math.round(daysSince)} 天没见了，该翻出来了`
        : `出现过 ${e.count} 次`
    };
  }).sort((a, b) => b.priority - a.priority).slice(0, limit);

  const L = [];
  L.push(`# 今天复习这 ${out.length} 个词`);
  L.push('');
  L.push('> 按「你多半快忘了 + 这词还会再出现」排的序。每天只过这一屏，不要贪多。');
  L.push('');
  for (const e of out) {
    L.push(`- **${e.en}** — ${e.zh}${e.note ? `（${e.note}）` : ''}  \`${e.why}\``);
    if (e.sample) L.push(`  > ${e.sample}`);
  }
  L.push('');
  return { items: out, markdown: L.join('\n'), meta: { pool: map.size, limit } };
}

/* ===========================================================================
 * 十三、progressReport —— 她在变好，得让她看见
 * ========================================================================= */

/**
 * 适应期最难熬的是「感觉自己一直没进步」。这个函数用可量化的指标给她证据：
 * 同一位老师、同样的语速下，每十分钟「高难度漏句」的条数在不在下降。
 * @param {Array} sessions
 */
export function progressReport(sessions, opts = {}) {
  const list = (Array.isArray(sessions) ? sessions : [sessions])
    .filter(s => s && segmentsOf(s).length)
    .sort((a, b) => num(a.startedAt) - num(b.startedAt));

  if (list.length < 2) {
    return {
      points: [], trend: { dir: 'flat', text: '至少上满两节课才能看出变化。今天先把三分钟速览听完就够了。' },
      headline: '刚开始，先不用看曲线', markdown: '# 听力进度\n\n至少上满两节课才能看出变化。\n'
    };
  }

  const points = list.map(s => {
    const st = paceStats(s, {});
    const missed = findMissed(s, { limit: 80, minScore: 2.2 });
    const mins = Math.max(1, st.speechMs / 60000);
    const high = missed.filter(m => m.severity === 'high').length;
    const marks = segmentsOf(s).filter(isMark).length;
    return {
      id: s.id, title: s.title || '（未命名）', startedAt: num(s.startedAt),
      wpm: st.wpm, level: st.level, minutes: Math.round(mins),
      hardPerTenMin: round1(high / mins * 10),
      marksPerTenMin: round1(marks / mins * 10),
      hardCount: high, markCount: marks
    };
  });

  // 对「每十分钟难句数」做最小二乘；语速本身也要一起看，不然快课会污染结论
  const n = points.length;
  const mx = (n - 1) / 2;
  const my = points.reduce((a, p) => a + p.hardPerTenMin, 0) / n;
  let sxy = 0, sxx = 0;
  points.forEach((p, i) => { sxy += (i - mx) * (p.hardPerTenMin - my); sxx += (i - mx) * (i - mx); });
  const slope = sxx > 0 ? sxy / sxx : 0;
  const total = slope * (n - 1);

  const wpmFirst = points[0].wpm, wpmLast = points[n - 1].wpm;
  const fasterNow = wpmLast > wpmFirst + 5;

  let trend, headline;
  if (total <= -0.8) {
    trend = {
      dir: 'better', slope: round1(slope),
      text: `每十分钟卡住的句子从 ${points[0].hardPerTenMin} 条降到 ${points[n - 1].hardPerTenMin} 条`
        + (fasterNow ? `，而且老师还比第一节课快了 ${wpmLast - wpmFirst} 词/分 —— 也就是说，难度上去了你反而卡得更少。` : '。')
    };
    headline = '你在适应，而且是真的在适应';
  } else if (total >= 0.8) {
    trend = {
      dir: 'harder', slope: round1(slope),
      text: `最近几节卡住的句子变多了（每十分钟 ${points[0].hardPerTenMin} → ${points[n - 1].hardPerTenMin} 条）`
        + (fasterNow ? `，不过老师也快了 ${wpmLast - wpmFirst} 词/分，内容多半也更难了 —— 不是你退步。` : '。课程内容进入难的部分了，很正常。')
    };
    headline = '内容变难了，不是你退步';
  } else {
    trend = { dir: 'flat', slope: round1(slope), text: `每十分钟大约 ${round1(my)} 条难句，基本持平。适应语速是按周算的，不是按天算的。` };
    headline = '持平 —— 这个阶段持平就是正常的';
  }

  const L = [];
  L.push('# 听力进度');
  L.push('');
  L.push(`## ${headline}`);
  L.push('');
  L.push(`> ${trend.text}`);
  L.push('');
  L.push('| 日期 | 课 | 语速 | 时长 | 每 10 分钟卡住 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const p of points) {
    const d = p.startedAt ? new Date(p.startedAt) : null;
    const ds = d ? `${d.getMonth() + 1}/${d.getDate()}` : '—';
    L.push(`| ${ds} | ${p.title} | ${p.wpm} 词/分 | ${p.minutes} 分 | ${p.hardPerTenMin} 条 |`);
  }
  L.push('');
  L.push('> 注：「卡住」是软件按语速突变、生词密度、译文失败、你自己的标记综合判断的，');
  L.push('> 只是个参考指标 —— 它下降说明你需要回听的东西变少了。');
  L.push('');

  return { points, trend, headline, markdown: L.join('\n') };
}

/* ===========================================================================
 * 十四、默认导出
 * ========================================================================= */

export default {
  paceStats, teacherProfile, findMissed, prepPack, threeMinuteRecap, emphasisLevel,
  catchUpWindow, paceDrill, shadowingPlan, reviewQueue, progressReport
};
