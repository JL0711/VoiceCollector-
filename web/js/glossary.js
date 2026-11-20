// 术语表 + 译文质量守卫
//
// 这一层不依赖任何大模型，纯字符串处理，立刻见效：
//   · GLOSSARY          英→中术语对照（按学科分组，启动时合并成一个 Map）
//   · shouldTranslate   这段话值不值得送去翻译（省电 + 避免「预 期」这种垃圾）
//   · preprocess        送进模型之前的清理（口头禅、空格、句末标点、专有名词大小写）
//   · looksDegenerate   抓小翻译模型的退化输出（复读、漏译、抄英文、乱码）
//   · applyGlossary     用术语表纠正译文里的术语，并给首次出现的术语补英文原词
//
// 纯 ES Module，无依赖，不联网，全部数据内嵌。

/* ===========================================================================
 * 一、术语表数据
 * ---------------------------------------------------------------------------
 * 每条形如 ['Supreme Court', '最高法院'] 或 ['stare decisis', '遵循先例', '（拉丁语法律原则）']
 * 原则：只收真正的专有名词和固定术语。
 *   · 会误伤的普通词一律不收：state / case / court / trial / will / warrant /
 *     discovery / standing / mean / mode / section / function / solution /
 *     concentration / reduction / compound / depression ……
 *   · 这些词要么换成含上下文的多词术语（"search warrant"、"clinical depression"），
 *     要么干脆不收。
 * ========================================================================= */

// ---- 法律 / 宪法 ----
const LAW = [
  ['Supreme Court', '最高法院'],
  ['Supreme Court of the United States', '美国联邦最高法院'],
  ['SCOTUS', '美国联邦最高法院'],
  ['U.S. Constitution', '美国宪法'],
  ['United States Constitution', '美国宪法'],
  ['constitutional law', '宪法学'],
  ['constitutional right', '宪法权利'],
  ['constitutional amendment', '宪法修正案'],
  ['constitutional convention', '制宪会议'],
  ['Bill of Rights', '权利法案'],
  ['First Amendment', '第一修正案'],
  ['Second Amendment', '第二修正案'],
  ['Fourth Amendment', '第四修正案'],
  ['Fifth Amendment', '第五修正案'],
  ['Sixth Amendment', '第六修正案'],
  ['Eighth Amendment', '第八修正案'],
  ['Tenth Amendment', '第十修正案'],
  ['Fourteenth Amendment', '第十四修正案'],
  ['Fifteenth Amendment', '第十五修正案'],
  ['Nineteenth Amendment', '第十九修正案'],
  ['due process', '正当程序'],
  ['due process of law', '正当法律程序'],
  ['procedural due process', '程序性正当程序'],
  ['substantive due process', '实体性正当程序'],
  ['equal protection', '平等保护'],
  ['equal protection clause', '平等保护条款'],
  ['commerce clause', '州际贸易条款'],
  ['supremacy clause', '联邦法至上条款'],
  ['necessary and proper clause', '必要且适当条款'],
  ['establishment clause', '宗教确立条款', '（政教分离）'],
  ['free exercise clause', '宗教自由行使条款'],
  ['free speech', '言论自由'],
  ['freedom of speech', '言论自由'],
  ['freedom of the press', '新闻自由'],
  ['freedom of assembly', '集会自由'],
  ['freedom of religion', '宗教自由'],
  ['separation of church and state', '政教分离'],
  ['judicial review', '司法审查'],
  ['judicial restraint', '司法克制'],
  ['judicial activism', '司法能动主义'],
  ['judicial independence', '司法独立'],
  ['stare decisis', '遵循先例', '（拉丁语法律原则）'],
  ['binding precedent', '有约束力的先例'],
  ['persuasive precedent', '具说服力的先例'],
  ['legal precedent', '法律先例'],
  ['common law', '普通法'],
  ['case law', '判例法'],
  ['civil law', '民法'],
  ['criminal law', '刑法'],
  ['administrative law', '行政法'],
  ['international law', '国际法'],
  ['statute', '成文法条'],
  ['statutory law', '制定法'],
  ['statutory interpretation', '法条解释'],
  ['legislative intent', '立法意图'],
  ['originalism', '原旨主义'],
  ['textualism', '文本主义'],
  ['living constitution', '活的宪法'],
  ['strict scrutiny', '严格审查标准'],
  ['intermediate scrutiny', '中度审查标准'],
  ['rational basis review', '合理依据审查'],
  ['compelling government interest', '迫切的政府利益'],
  ['compelling state interest', '迫切的政府利益'],
  ['amicus brief', '法庭之友意见书'],
  ['amicus curiae', '法庭之友', '（拉丁语）'],
  ['certiorari', '调卷令', '（最高法院受理上诉的令状）'],
  ['writ of certiorari', '调卷令'],
  ['cert petition', '调卷申请'],
  ['habeas corpus', '人身保护令', '（拉丁语）'],
  ['writ of habeas corpus', '人身保护令'],
  ['plaintiff', '原告'],
  ['defendant', '被告'],
  ['prosecutor', '检察官'],
  ['prosecution', '控方'],
  ['defense counsel', '辩护律师'],
  ['attorney', '律师'],
  ['attorney general', '司法部长'],
  ['litigation', '诉讼'],
  ['litigant', '诉讼当事人'],
  ['lawsuit', '诉讼案件'],
  ['legal standing', '诉讼资格'],
  ['jurisdiction', '管辖权'],
  ['tort', '侵权行为'],
  ['tort law', '侵权法'],
  ['negligence', '过失'],
  ['duty of care', '注意义务'],
  ['breach of duty', '违反义务'],
  ['proximate cause', '近因'],
  ['strict liability', '严格责任'],
  ['legal liability', '法律责任'],
  ['contract law', '合同法'],
  ['breach of contract', '违约'],
  ['offer and acceptance', '要约与承诺'],
  ['specific performance', '实际履行'],
  ['punitive damages', '惩罚性赔偿'],
  ['compensatory damages', '补偿性赔偿'],
  ['monetary damages', '金钱赔偿'],
  ['remedy', '救济措施'],
  ['burden of proof', '举证责任'],
  ['beyond a reasonable doubt', '排除合理怀疑'],
  ['preponderance of the evidence', '优势证据'],
  ['clear and convincing evidence', '清楚且有说服力的证据'],
  ['presumption of innocence', '无罪推定'],
  ['reasonable person standard', '合理人标准'],
  ['mens rea', '犯罪意图', '（拉丁语）'],
  ['actus reus', '犯罪行为', '（拉丁语）'],
  ['felony', '重罪'],
  ['misdemeanor', '轻罪'],
  ['indictment', '起诉书'],
  ['grand jury', '大陪审团'],
  ['jury', '陪审团'],
  ['jury trial', '陪审团审判'],
  ['voir dire', '陪审员遴选', '（法语）'],
  ['verdict', '裁决'],
  ['acquittal', '无罪判决'],
  ['conviction', '定罪'],
  ['plea bargain', '辩诉交易'],
  ['sentencing', '量刑'],
  ['parole', '假释'],
  ['probation', '缓刑'],
  ['appellate court', '上诉法院'],
  ['appellant', '上诉人'],
  ['appellee', '被上诉人'],
  ['circuit court', '巡回上诉法院'],
  ['district court', '联邦地区法院'],
  ['federal court', '联邦法院'],
  ['state court', '州法院'],
  ['trial court', '初审法院'],
  ['lower court', '下级法院'],
  ['majority opinion', '多数意见'],
  ['dissenting opinion', '异议意见'],
  ['concurring opinion', '协同意见'],
  ['per curiam', '法院集体意见', '（拉丁语）'],
  ['holding', '判决要旨'],
  ['obiter dictum', '附带意见', '（拉丁语）'],
  ['remand', '发回重审'],
  ['reverse and remand', '撤销并发回重审'],
  ['overrule', '推翻先例'],
  ['injunction', '禁令'],
  ['restraining order', '限制令'],
  ['subpoena', '传票'],
  ['deposition', '证词笔录'],
  ['pretrial discovery', '审前证据开示'],
  ['settlement', '和解'],
  ['class action', '集体诉讼'],
  ['due diligence', '尽职调查'],
  ['statute of limitations', '诉讼时效'],
  ['double jeopardy', '一事不再理'],
  ['self-incrimination', '自证其罪'],
  ['Miranda rights', '米兰达权利'],
  ['Miranda warning', '米兰达警告'],
  ['search and seizure', '搜查与扣押'],
  ['unreasonable search', '不合理搜查'],
  ['search warrant', '搜查令'],
  ['probable cause', '合理根据'],
  ['exclusionary rule', '非法证据排除规则'],
  ['right to counsel', '获得律师协助权'],
  ['cruel and unusual punishment', '残酷而不寻常的惩罚'],
  ['capital punishment', '死刑'],
  ['death penalty', '死刑'],
  ['civil rights', '民权'],
  ['civil liberties', '公民自由'],
  ['human rights', '人权'],
  ['voting rights', '投票权'],
  ['affirmative action', '平权行动'],
  ['racial segregation', '种族隔离'],
  ['desegregation', '废除种族隔离'],
  ['Jim Crow laws', '吉姆·克劳法'],
  ['separate but equal', '隔离但平等'],
  ['right to privacy', '隐私权'],
  ['reasonable expectation of privacy', '合理隐私期待'],
  ['privacy law', '隐私法'],
  ['data protection', '数据保护'],
  ['GDPR', '通用数据保护条例'],
  ['third-party doctrine', '第三方原则'],
  ['intellectual property', '知识产权'],
  ['copyright', '版权'],
  ['fair use', '合理使用'],
  ['patent', '专利'],
  ['trademark', '商标'],
  ['trade secret', '商业秘密'],
  ['defamation', '诽谤'],
  ['libel', '书面诽谤'],
  ['slander', '口头诽谤'],
  ['obscenity', '淫秽内容'],
  ['incitement', '煽动'],
  ['hate speech', '仇恨言论'],
  ['clear and present danger', '明显而现实的危险'],
  ['prior restraint', '事前限制'],
  ['content neutral', '内容中立'],
  ['public forum', '公共论坛'],
  ['chilling effect', '寒蝉效应'],
  ['Section 230', '第230条', '（美国《通信规范法》）'],
  ['rule of law', '法治'],
  ['Roe v. Wade', '罗诉韦德案'],
  ['Brown v. Board of Education', '布朗诉教育委员会案'],
  ['Marbury v. Madison', '马伯里诉麦迪逊案'],
  ['Miranda v. Arizona', '米兰达诉亚利桑那案'],
  ['Plessy v. Ferguson', '普莱西诉弗格森案'],
  ['Gideon v. Wainwright', '吉迪恩诉温赖特案'],
  ['Tinker v. Des Moines', '廷克诉得梅因案'],
  ['New York Times v. Sullivan', '纽约时报诉沙利文案'],
  ['Citizens United', '联合公民案'],
  ['Obergefell v. Hodges', '奥贝格费尔诉霍奇斯案'],
  ['Dobbs v. Jackson', '多布斯诉杰克逊案'],
  ['Katz v. United States', '卡茨诉美国案'],
  ['Carpenter v. United States', '卡朋特诉美国案'],
  ['Riley v. California', '莱利诉加利福尼亚案'],
  ['Loving v. Virginia', '洛文诉弗吉尼亚案'],
  ['Griswold v. Connecticut', '格里斯沃尔德诉康涅狄格州案'],
  ['Mapp v. Ohio', '马普诉俄亥俄案'],
  ['Schenck v. United States', '申克诉美国案'],
  ['Brandenburg v. Ohio', '布兰登堡诉俄亥俄案'],
  ['McCulloch v. Maryland', '麦卡洛克诉马里兰案'],
  ['Gibbons v. Ogden', '吉本斯诉奥格登案'],
  ['Korematsu v. United States', '是松诉美国案'],
  ['Bush v. Gore', '布什诉戈尔案'],
  ['United States v. Nixon', '美国诉尼克松案'],
  ['Lawrence v. Texas', '劳伦斯诉得克萨斯案'],
  ['Shelby County v. Holder', '谢尔比县诉霍尔德案'],
  ['Masterpiece Cakeshop', '杰作蛋糕店案'],
  ['Heart of Atlanta Motel', '亚特兰大之心汽车旅馆案'],
  // —— 主协调者临时版里有、这里补齐的条目 ——
  ['precedent', '先例'],
  ['summary judgment', '即决判决'],
  ['reasonable doubt', '合理怀疑'],
  ['unconstitutional', '违宪'],
  ['rational basis', '合理依据审查'],
  ['oral argument', '口头辩论'],
  ['testimony', '证词'],
  ['damages', '损害赔偿'],
  ['liability', '法律责任'],
  ['ruling', '裁决'],
  ['appeal', '上诉'],
  ['judiciary', '司法部门'],
  ['legislature', '立法机关']
];

// ---- 政治 / 政府 ----
const POLITICS = [
  ['separation of powers', '三权分立'],
  ['checks and balances', '制衡'],
  ['federalism', '联邦制'],
  ['executive branch', '行政部门'],
  ['legislative branch', '立法部门'],
  ['judicial branch', '司法部门'],
  ['Congress', '国会'],
  ['Senate', '参议院'],
  ['senator', '参议员'],
  ['House of Representatives', '众议院'],
  ['member of Congress', '国会议员'],
  ['Speaker of the House', '众议院议长'],
  ['filibuster', '冗长辩论', '（阻挠议事）'],
  ['cloture', '终止辩论程序'],
  ['pocket veto', '口袋否决'],
  ['veto power', '否决权'],
  ['impeachment', '弹劾'],
  ['executive order', '行政命令'],
  ['executive privilege', '行政特权'],
  ['electoral college', '选举人团'],
  ['popular vote', '普选票'],
  ['swing state', '摇摆州'],
  ['gerrymandering', '选区划分操纵'],
  ['redistricting', '重新划分选区'],
  ['incumbent', '在任者'],
  ['primary election', '初选'],
  ['caucus', '党团会议'],
  ['midterm election', '中期选举'],
  ['ballot initiative', '公民创制案'],
  ['referendum', '公民投票'],
  ['voter turnout', '投票率'],
  ['lobbying', '游说'],
  ['interest group', '利益集团'],
  ['political action committee', '政治行动委员会'],
  ['super PAC', '超级政治行动委员会'],
  ['campaign finance', '竞选资金'],
  ['partisanship', '党派立场'],
  ['bipartisan', '两党合作的'],
  ['political polarization', '政治两极分化'],
  ['public opinion', '民意'],
  ['approval rating', '支持率'],
  ['civil society', '公民社会'],
  ['bureaucracy', '官僚体系'],
  ['federal agency', '联邦机构'],
  ['deregulation', '放松管制'],
  ['welfare state', '福利国家'],
  ['social contract', '社会契约'],
  ['liberalism', '自由主义'],
  ['conservatism', '保守主义'],
  ['libertarianism', '自由意志主义'],
  ['populism', '民粹主义'],
  ['authoritarianism', '威权主义'],
  ['totalitarianism', '极权主义'],
  ['representative democracy', '代议制民主'],
  ['direct democracy', '直接民主'],
  ['liberal democracy', '自由民主制'],
  ['sovereignty', '主权'],
  ['political legitimacy', '政治正当性'],
  ['nation state', '民族国家'],
  ['foreign policy', '外交政策'],
  ['soft power', '软实力'],
  ['United Nations', '联合国'],
  ['NATO', '北约'],
  ['World Trade Organization', '世界贸易组织'],
  ['European Union', '欧盟'],
  ['diplomacy', '外交'],
  ['economic sanctions', '经济制裁'],
  ['think tank', '智库'],
  ['grassroots movement', '草根运动'],
  ['civil disobedience', '公民不服从']
];

// ---- 经济学 ----
const ECON = [
  ['supply and demand', '供给与需求'],
  ['demand curve', '需求曲线'],
  ['supply curve', '供给曲线'],
  ['equilibrium price', '均衡价格'],
  ['market equilibrium', '市场均衡'],
  ['elasticity', '弹性'],
  ['price elasticity of demand', '需求价格弹性'],
  ['income elasticity', '收入弹性'],
  ['marginal utility', '边际效用'],
  ['diminishing marginal utility', '边际效用递减'],
  ['marginal cost', '边际成本'],
  ['marginal revenue', '边际收益'],
  ['marginal benefit', '边际效益'],
  ['opportunity cost', '机会成本'],
  ['sunk cost', '沉没成本'],
  ['fixed cost', '固定成本'],
  ['variable cost', '可变成本'],
  ['economies of scale', '规模经济'],
  ['comparative advantage', '比较优势'],
  ['absolute advantage', '绝对优势'],
  ['consumer surplus', '消费者剩余'],
  ['producer surplus', '生产者剩余'],
  ['deadweight loss', '无谓损失'],
  ['market failure', '市场失灵'],
  ['externality', '外部性'],
  ['negative externality', '负外部性'],
  ['positive externality', '正外部性'],
  ['public good', '公共物品'],
  ['free rider problem', '搭便车问题'],
  ['tragedy of the commons', '公地悲剧'],
  ['moral hazard', '道德风险'],
  ['adverse selection', '逆向选择'],
  ['asymmetric information', '信息不对称'],
  ['perfect competition', '完全竞争'],
  ['monopoly', '垄断'],
  ['oligopoly', '寡头垄断'],
  ['monopolistic competition', '垄断竞争'],
  ['price discrimination', '价格歧视'],
  ['price ceiling', '价格上限'],
  ['price floor', '价格下限'],
  ['antitrust', '反垄断'],
  ['GDP', '国内生产总值'],
  ['gross domestic product', '国内生产总值'],
  ['GNP', '国民生产总值'],
  ['real GDP', '实际国内生产总值'],
  ['nominal GDP', '名义国内生产总值'],
  ['GDP per capita', '人均国内生产总值'],
  ['inflation', '通货膨胀'],
  ['deflation', '通货紧缩'],
  ['stagflation', '滞胀'],
  ['consumer price index', '消费者价格指数'],
  ['CPI', '消费者价格指数'],
  ['unemployment rate', '失业率'],
  ['structural unemployment', '结构性失业'],
  ['frictional unemployment', '摩擦性失业'],
  ['cyclical unemployment', '周期性失业'],
  ['business cycle', '经济周期'],
  ['economic recession', '经济衰退'],
  ['economic growth', '经济增长'],
  ['fiscal policy', '财政政策'],
  ['monetary policy', '货币政策'],
  ['central bank', '中央银行'],
  ['Federal Reserve', '美联储'],
  ['interest rate', '利率'],
  ['money supply', '货币供给'],
  ['quantitative easing', '量化宽松'],
  ['aggregate demand', '总需求'],
  ['aggregate supply', '总供给'],
  ['multiplier effect', '乘数效应'],
  ['crowding out', '挤出效应'],
  ['budget deficit', '财政赤字'],
  ['budget surplus', '财政盈余'],
  ['national debt', '国债'],
  ['trade deficit', '贸易逆差'],
  ['trade surplus', '贸易顺差'],
  ['tariff', '关税'],
  ['import quota', '进口配额'],
  ['free trade', '自由贸易'],
  ['protectionism', '贸易保护主义'],
  ['globalization', '全球化'],
  ['exchange rate', '汇率'],
  ['purchasing power parity', '购买力平价'],
  ['game theory', '博弈论'],
  ['Nash equilibrium', '纳什均衡'],
  ["prisoner's dilemma", '囚徒困境'],
  ['zero-sum game', '零和博弈'],
  ['invisible hand', '看不见的手'],
  ['Keynesian economics', '凯恩斯主义经济学'],
  ['behavioral economics', '行为经济学'],
  ['microeconomics', '微观经济学'],
  ['macroeconomics', '宏观经济学'],
  ['utility function', '效用函数'],
  ['indifference curve', '无差异曲线'],
  ['budget constraint', '预算约束'],
  ['production possibility frontier', '生产可能性边界'],
  ['Gini coefficient', '基尼系数'],
  ['income inequality', '收入不平等'],
  ['human capital', '人力资本'],
  ['labor force', '劳动力'],
  ['minimum wage', '最低工资'],
  ['cost-benefit analysis', '成本效益分析'],
  ['return on investment', '投资回报率'],
  ['compound interest', '复利'],
  ['stock market', '股票市场'],
  ['venture capital', '风险投资'],
  ['equilibrium', '均衡'],
  ['price elasticity', '价格弹性'],
  ['diminishing returns', '收益递减']
];

// ---- 计算机 / 数据 ----
const CS = [
  ['machine learning', '机器学习'],
  ['deep learning', '深度学习'],
  ['artificial intelligence', '人工智能'],
  ['neural network', '神经网络'],
  ['supervised learning', '监督学习'],
  ['unsupervised learning', '无监督学习'],
  ['reinforcement learning', '强化学习'],
  ['training data', '训练数据'],
  ['test set', '测试集'],
  ['validation set', '验证集'],
  ['overfitting', '过拟合'],
  ['underfitting', '欠拟合'],
  ['regularization', '正则化'],
  ['gradient descent', '梯度下降'],
  ['stochastic gradient descent', '随机梯度下降'],
  ['backpropagation', '反向传播'],
  ['loss function', '损失函数'],
  ['learning rate', '学习率'],
  ['hyperparameter', '超参数'],
  ['feature engineering', '特征工程'],
  ['cross validation', '交叉验证'],
  ['confusion matrix', '混淆矩阵'],
  ['false positive', '假阳性'],
  ['false negative', '假阴性'],
  ['decision tree', '决策树'],
  ['random forest', '随机森林'],
  ['support vector machine', '支持向量机'],
  ['k-means clustering', 'K均值聚类'],
  ['natural language processing', '自然语言处理'],
  ['large language model', '大语言模型'],
  ['computer vision', '计算机视觉'],
  ['speech recognition', '语音识别'],
  ['fine-tuning', '微调'],
  ['prompt engineering', '提示词工程'],
  ['word embedding', '词向量'],
  ['algorithmic bias', '算法偏见'],
  ['algorithm', '算法'],
  ['data structure', '数据结构'],
  ['time complexity', '时间复杂度'],
  ['space complexity', '空间复杂度'],
  ['big O notation', '大O表示法'],
  ['binary search', '二分查找'],
  ['linked list', '链表'],
  ['hash table', '哈希表'],
  ['hash function', '哈希函数'],
  ['call stack', '调用栈'],
  ['binary tree', '二叉树'],
  ['graph traversal', '图遍历'],
  ['recursion', '递归'],
  ['dynamic programming', '动态规划'],
  ['greedy algorithm', '贪心算法'],
  ['sorting algorithm', '排序算法'],
  ['quicksort', '快速排序'],
  ['merge sort', '归并排序'],
  ['cache', '缓存'],
  ['memory leak', '内存泄漏'],
  ['garbage collection', '垃圾回收'],
  ['compiler', '编译器'],
  ['source code', '源代码'],
  ['API', '应用程序接口'],
  ['REST API', 'REST 接口'],
  ['database', '数据库'],
  ['relational database', '关系型数据库'],
  ['SQL', '结构化查询语言'],
  ['primary key', '主键'],
  ['foreign key', '外键'],
  ['data normalization', '数据归一化'],
  ['encryption', '加密'],
  ['end-to-end encryption', '端到端加密'],
  ['public key', '公钥'],
  ['private key', '私钥'],
  ['firewall', '防火墙'],
  ['malware', '恶意软件'],
  ['phishing', '网络钓鱼'],
  ['data breach', '数据泄露'],
  ['cybersecurity', '网络安全'],
  ['open source', '开源'],
  ['version control', '版本控制'],
  ['operating system', '操作系统'],
  ['distributed system', '分布式系统'],
  ['cloud computing', '云计算'],
  ['bandwidth', '带宽'],
  ['latency', '延迟'],
  ['network protocol', '网络协议'],
  ['IP address', 'IP 地址'],
  ['front end', '前端'],
  ['back end', '后端'],
  ['unit test', '单元测试'],
  ['pseudocode', '伪代码'],
  ['Boolean', '布尔值'],
  ['floating point', '浮点数'],
  ['for loop', 'for 循环'],
  ['while loop', 'while 循环'],
  ['metadata', '元数据'],
  ['data mining', '数据挖掘'],
  ['big data', '大数据'],
  ['data set', '数据集'],
  ['user interface', '用户界面'],
  ['machine translation', '机器翻译'],
  ['facial recognition', '人脸识别'],
  ['content moderation', '内容审核'],
  ['net neutrality', '网络中立'],
  ['surveillance capitalism', '监控资本主义'],
  ['digital divide', '数字鸿沟'],
  ['authentication', '身份验证'],
  ['data privacy', '数据隐私'],
  ['anonymization', '匿名化'],
  ['surveillance', '监控'],
  ['digital age', '数字时代']
];

// ---- 统计 / 研究方法 ----
const STATS = [
  ['p-value', 'p 值'],
  ['statistical significance', '统计显著性'],
  ['significance level', '显著性水平'],
  ['null hypothesis', '零假设'],
  ['alternative hypothesis', '备择假设'],
  ['hypothesis testing', '假设检验'],
  ['confidence interval', '置信区间'],
  ['margin of error', '误差范围'],
  ['standard deviation', '标准差'],
  ['standard error', '标准误'],
  ['sample mean', '样本均值'],
  ['arithmetic mean', '算术平均数'],
  ['median', '中位数'],
  ['correlation', '相关性'],
  ['correlation coefficient', '相关系数'],
  ['causation', '因果关系'],
  ['causal inference', '因果推断'],
  ['regression', '回归分析'],
  ['linear regression', '线性回归'],
  ['multiple regression', '多元回归'],
  ['logistic regression', '逻辑回归'],
  ['regression coefficient', '回归系数'],
  ['R-squared', '决定系数'],
  ['residual', '残差'],
  ['outlier', '离群值'],
  ['normal distribution', '正态分布'],
  ['bell curve', '钟形曲线'],
  ['skewed distribution', '偏态分布'],
  ['central limit theorem', '中心极限定理'],
  ['law of large numbers', '大数定律'],
  ['sample size', '样本量'],
  ['random sample', '随机样本'],
  ['representative sample', '代表性样本'],
  ['stratified sampling', '分层抽样'],
  ['convenience sample', '便利样本'],
  ['sampling bias', '抽样偏差'],
  ['selection bias', '选择偏差'],
  ['response bias', '应答偏差'],
  ['survivorship bias', '幸存者偏差'],
  ['confounding variable', '混淆变量'],
  ['independent variable', '自变量'],
  ['dependent variable', '因变量'],
  ['control group', '对照组'],
  ['treatment group', '实验组'],
  ['randomized controlled trial', '随机对照试验'],
  ['clinical trial', '临床试验'],
  ['experimental design', '实验设计'],
  ['double blind', '双盲'],
  ['placebo', '安慰剂'],
  ['placebo effect', '安慰剂效应'],
  ['peer review', '同行评审'],
  ['literature review', '文献综述'],
  ['research question', '研究问题'],
  ['qualitative research', '定性研究'],
  ['quantitative research', '定量研究'],
  ['qualitative data', '定性数据'],
  ['quantitative data', '定量数据'],
  ['mixed methods', '混合研究方法'],
  ['case study', '个案研究'],
  ['ethnography', '民族志'],
  ['participant observation', '参与式观察'],
  ['focus group', '焦点小组'],
  ['survey research', '问卷调查研究'],
  ['questionnaire', '问卷'],
  ['content analysis', '内容分析'],
  ['thematic analysis', '主题分析'],
  ['grounded theory', '扎根理论'],
  ['internal validity', '内部效度'],
  ['external validity', '外部效度'],
  ['construct validity', '建构效度'],
  ['inter-rater reliability', '评分者间信度'],
  ['generalizability', '可推广性'],
  ['Type I error', '第一类错误'],
  ['Type II error', '第二类错误'],
  ['statistical power', '统计效力'],
  ['effect size', '效应量'],
  ['meta-analysis', '元分析'],
  ['descriptive statistics', '描述性统计'],
  ['inferential statistics', '推断统计'],
  ['chi-square test', '卡方检验'],
  ['t-test', 't 检验'],
  ['ANOVA', '方差分析'],
  ['probability distribution', '概率分布'],
  ['conditional probability', '条件概率'],
  ['Bayes theorem', '贝叶斯定理'],
  ['informed consent', '知情同意'],
  ['institutional review board', '机构伦理审查委员会'],
  ['IRB', '机构伦理审查委员会'],
  ['research ethics', '研究伦理'],
  ['data visualization', '数据可视化'],
  ['scatter plot', '散点图'],
  ['histogram', '直方图'],
  ['time series', '时间序列'],
  ['cross-sectional study', '横断面研究'],
  ['longitudinal study', '纵向研究'],
  ['pilot study', '预实验'],
  ['operational definition', '操作性定义'],
  ['replication crisis', '可重复性危机'],
  ['variance', '方差'],
  ['qualitative', '定性'],
  ['quantitative', '定量'],
  ['peer-reviewed', '经同行评审的']
];

// ---- 心理学 / 社会学 ----
const PSYCH = [
  ['cognitive dissonance', '认知失调'],
  ['confirmation bias', '确认偏误'],
  ['cognitive bias', '认知偏差'],
  ['availability heuristic', '可得性启发'],
  ['anchoring effect', '锚定效应'],
  ['framing effect', '框架效应'],
  ['heuristic', '启发式'],
  ['classical conditioning', '经典条件反射'],
  ['operant conditioning', '操作性条件反射'],
  ['positive reinforcement', '正强化'],
  ['negative reinforcement', '负强化'],
  ['behaviorism', '行为主义'],
  ['attachment theory', '依恋理论'],
  ['attachment style', '依恋类型'],
  ['developmental psychology', '发展心理学'],
  ['cognitive psychology', '认知心理学'],
  ['social psychology', '社会心理学'],
  ['clinical psychology', '临床心理学'],
  ['nature versus nurture', '先天与后天之争'],
  ['working memory', '工作记忆'],
  ['long-term memory', '长期记忆'],
  ['short-term memory', '短期记忆'],
  ['implicit bias', '内隐偏见'],
  ['stereotype', '刻板印象'],
  ['stereotype threat', '刻板印象威胁'],
  ['prejudice', '偏见'],
  ['in-group', '内群体'],
  ['out-group', '外群体'],
  ['conformity', '从众'],
  ['obedience to authority', '服从权威'],
  ['bystander effect', '旁观者效应'],
  ['groupthink', '群体思维'],
  ['social identity', '社会认同'],
  ['self-esteem', '自尊'],
  ['self-efficacy', '自我效能感'],
  ['intrinsic motivation', '内在动机'],
  ['extrinsic motivation', '外在动机'],
  ['emotional regulation', '情绪调节'],
  ['fight or flight', '战或逃反应'],
  ['stress response', '应激反应'],
  ['anxiety disorder', '焦虑症'],
  ['clinical depression', '抑郁症'],
  ['mental health', '心理健康'],
  ['PTSD', '创伤后应激障碍'],
  ['ADHD', '注意缺陷多动障碍'],
  ['autism spectrum', '自闭症谱系'],
  ['cognitive behavioral therapy', '认知行为疗法'],
  ['neuroplasticity', '神经可塑性'],
  ['socialization', '社会化'],
  ['social norm', '社会规范'],
  ['social construct', '社会建构'],
  ['social construction of reality', '现实的社会建构'],
  ['social stratification', '社会分层'],
  ['social mobility', '社会流动'],
  ['social capital', '社会资本'],
  ['cultural capital', '文化资本'],
  ['class structure', '阶级结构'],
  ['working class', '工人阶级'],
  ['middle class', '中产阶级'],
  ['socioeconomic status', '社会经济地位'],
  ['structural inequality', '结构性不平等'],
  ['institutional racism', '制度性种族主义'],
  ['systemic racism', '系统性种族主义'],
  ['intersectionality', '交叉性'],
  ['gender roles', '性别角色'],
  ['gender identity', '性别认同'],
  ['patriarchy', '父权制'],
  ['feminism', '女性主义'],
  ['identity politics', '身份政治'],
  ['deviance', '越轨行为'],
  ['labeling theory', '标签理论'],
  ['anomie', '失范'],
  ['social control', '社会控制'],
  ['urbanization', '城市化'],
  ['demography', '人口学'],
  ['ethnocentrism', '种族中心主义'],
  ['cultural relativism', '文化相对主义'],
  ['symbolic interactionism', '符号互动论'],
  ['structural functionalism', '结构功能主义'],
  ['conflict theory', '冲突理论'],
  ['collective action', '集体行动'],
  ['social movement', '社会运动'],
  ['Max Weber', '马克斯·韦伯'],
  ['Emile Durkheim', '埃米尔·涂尔干'],
  ['Karl Marx', '卡尔·马克思'],
  ['Sigmund Freud', '西格蒙德·弗洛伊德'],
  ['Michel Foucault', '米歇尔·福柯'],
  ['Erving Goffman', '欧文·戈夫曼'],
  ['Pierre Bourdieu', '皮埃尔·布尔迪厄'],
  ['reinforcement', '强化'],
  ['stratification', '社会分层']
];

// ---- 生物 / 化学 / 物理 ----
const SCIENCE = [
  ['cell membrane', '细胞膜'],
  ['mitochondria', '线粒体'],
  ['cell nucleus', '细胞核'],
  ['ribosome', '核糖体'],
  ['chromosome', '染色体'],
  ['DNA', '脱氧核糖核酸'],
  ['RNA', '核糖核酸'],
  ['gene expression', '基因表达'],
  ['genotype', '基因型'],
  ['phenotype', '表型'],
  ['allele', '等位基因'],
  ['genetic mutation', '基因突变'],
  ['natural selection', '自然选择'],
  ['evolution', '演化'],
  ['ecosystem', '生态系统'],
  ['photosynthesis', '光合作用'],
  ['cellular respiration', '细胞呼吸'],
  ['enzyme', '酶'],
  ['protein synthesis', '蛋白质合成'],
  ['amino acid', '氨基酸'],
  ['metabolism', '新陈代谢'],
  ['homeostasis', '稳态'],
  ['mitosis', '有丝分裂'],
  ['meiosis', '减数分裂'],
  ['stem cell', '干细胞'],
  ['antibody', '抗体'],
  ['antigen', '抗原'],
  ['immune system', '免疫系统'],
  ['bacteria', '细菌'],
  ['neuron', '神经元'],
  ['synapse', '突触'],
  ['neurotransmitter', '神经递质'],
  ['dopamine', '多巴胺'],
  ['serotonin', '血清素'],
  ['hormone', '激素'],
  ['biodiversity', '生物多样性'],
  ['food chain', '食物链'],
  ['climate change', '气候变化'],
  ['global warming', '全球变暖'],
  ['greenhouse effect', '温室效应'],
  ['greenhouse gas', '温室气体'],
  ['carbon dioxide', '二氧化碳'],
  ['carbon footprint', '碳足迹'],
  ['renewable energy', '可再生能源'],
  ['fossil fuel', '化石燃料'],
  ['periodic table', '元素周期表'],
  ['atomic number', '原子序数'],
  ['atomic mass', '原子质量'],
  ['isotope', '同位素'],
  ['covalent bond', '共价键'],
  ['ionic bond', '离子键'],
  ['hydrogen bond', '氢键'],
  ['chemical compound', '化合物'],
  ['chemical reaction', '化学反应'],
  ['catalyst', '催化剂'],
  ['oxidation', '氧化'],
  ['pH scale', 'pH 值'],
  ['mole', '摩尔', '（化学计量单位）'],
  ['stoichiometry', '化学计量'],
  ['thermodynamics', '热力学'],
  ['entropy', '熵'],
  ['kinetic energy', '动能'],
  ['potential energy', '势能'],
  ['conservation of energy', '能量守恒'],
  ['momentum', '动量'],
  ['acceleration', '加速度'],
  ['velocity', '速度'],
  ['friction', '摩擦力'],
  ['gravity', '重力'],
  ["Newton's laws", '牛顿运动定律'],
  ['electromagnetic', '电磁的'],
  ['wavelength', '波长'],
  ['quantum mechanics', '量子力学'],
  ['theory of relativity', '相对论'],
  ['nuclear fission', '核裂变'],
  ['nuclear fusion', '核聚变'],
  ['half-life', '半衰期'],
  ['scientific method', '科学方法'],
  ['control variable', '控制变量'],
  ['empirical evidence', '实证证据'],
  ['epidemiology', '流行病学'],
  ['public health', '公共卫生'],
  ['second law of thermodynamics', '热力学第二定律'],
  ['equilibrium constant', '平衡常数']
];

// ---- 校园与课务 ----
const CAMPUS = [
  ['syllabus', '教学大纲'],
  ['course syllabus', '课程大纲'],
  ['lecture', '讲座课'],
  ['lecture hall', '阶梯教室'],
  ['seminar', '研讨课'],
  ['discussion section', '讨论课'],
  ['office hours', '答疑时间'],
  ['teaching assistant', '助教'],
  ['TA', '助教'],
  ['professor', '教授'],
  ['lecturer', '讲师'],
  ['academic advisor', '学业导师'],
  ['registrar', '教务处'],
  ['midterm', '期中考试'],
  ['midterm exam', '期中考试'],
  ['final exam', '期末考试'],
  ['finals week', '期末考试周'],
  ['quiz', '小测验'],
  ['pop quiz', '随堂小测'],
  ['problem set', '习题集'],
  ['pset', '习题集'],
  ['assignment', '作业'],
  ['homework', '作业'],
  ['term paper', '学期论文'],
  ['research paper', '研究论文'],
  ['thesis statement', '论点陈述'],
  ['dissertation', '学位论文'],
  ['rough draft', '初稿'],
  ['final draft', '定稿'],
  ['peer feedback', '同伴反馈'],
  ['peer editing', '同伴互评'],
  ['rubric', '评分标准'],
  ['letter grade', '等第成绩'],
  ['GPA', '平均绩点'],
  ['grade point average', '平均绩点'],
  ['transcript', '成绩单'],
  ['credit hours', '学分'],
  ['course credit', '课程学分'],
  ['prerequisite', '先修课程'],
  ['elective', '选修课'],
  ['required course', '必修课'],
  ['core curriculum', '核心课程'],
  ['declare a major', '确定专业'],
  ['double major', '双专业'],
  ['undergraduate', '本科生'],
  ['graduate student', '研究生'],
  ['freshman', '大一新生'],
  ['sophomore', '大二学生'],
  ['junior year', '大三'],
  ['senior year', '大四'],
  ['semester', '学期'],
  ['fall semester', '秋季学期'],
  ['spring semester', '春季学期'],
  ['summer session', '暑期课程'],
  ['course registration', '选课注册'],
  ['add/drop', '加退选'],
  ['waitlist', '候补名单'],
  ['pass/fail', '通过/不通过评分'],
  ['class attendance', '课堂出勤'],
  ['class participation', '课堂参与'],
  ['due date', '截止日期'],
  ['deadline', '截止时间'],
  ['extension', '延期'],
  ['late penalty', '迟交扣分'],
  ['plagiarism', '抄袭'],
  ['academic integrity', '学术诚信'],
  ['academic dishonesty', '学术不端'],
  ['honor code', '荣誉准则'],
  ['citation', '引用'],
  ['works cited', '引用文献'],
  ['bibliography', '参考文献'],
  ['annotated bibliography', '注释书目'],
  ['footnote', '脚注'],
  ['in-text citation', '文内引注'],
  ['MLA format', 'MLA 格式'],
  ['APA style', 'APA 格式'],
  ['Chicago style', '芝加哥格式'],
  ['reading list', '阅读书目'],
  ['required reading', '必读材料'],
  ['assigned reading', '指定阅读'],
  ['course reader', '课程读本'],
  ['textbook', '教科书'],
  ['handout', '讲义'],
  ['slides', '幻灯片'],
  ['slide deck', '幻灯片'],
  ['lecture notes', '课堂笔记'],
  ['study guide', '复习指南'],
  ['review session', '复习课'],
  ['extra credit', '附加分'],
  ['open book exam', '开卷考试'],
  ['take-home exam', '带回家考试'],
  ['oral presentation', '口头报告'],
  ['group project', '小组项目'],
  ['lab report', '实验报告'],
  ['field trip', '实地考察'],
  ['internship', '实习'],
  ['letter of recommendation', '推荐信'],
  ['study abroad', '海外交流学习'],
  ['financial aid', '助学金'],
  ['scholarship', '奖学金'],
  ['tuition', '学费'],
  ['dorm', '宿舍'],
  ['campus', '校园'],
  ['writing center', '写作中心'],
  ['learning management system', '学习管理系统'],
  ['class discussion', '课堂讨论'],
  ['discussion board', '讨论区'],
  ['grading curve', '评分曲线'],
  ['course evaluation', '课程评估'],
  ['academic probation', '学业警告'],
  ['commencement', '毕业典礼'],
  ['alumni', '校友'],
  ['open book', '开卷'],
  ['closed book', '闭卷'],
  ['class presentation', '课堂展示']
];

// ---- 哲学 / 历史 / 写作 ----
const HUMANITIES = [
  ['epistemology', '认识论'],
  ['ontology', '本体论'],
  ['metaphysics', '形而上学'],
  ['ethics', '伦理学'],
  ['utilitarianism', '功利主义'],
  ['deontology', '义务论'],
  ['categorical imperative', '绝对命令'],
  ['virtue ethics', '德性伦理学'],
  ['social justice', '社会正义'],
  ['distributive justice', '分配正义'],
  ['veil of ignorance', '无知之幕'],
  ['trolley problem', '电车难题'],
  ['free will', '自由意志'],
  ['determinism', '决定论'],
  ['empiricism', '经验主义'],
  ['rationalism', '理性主义'],
  ['skepticism', '怀疑论'],
  ['dualism', '二元论'],
  ['existentialism', '存在主义'],
  ['nihilism', '虚无主义'],
  ['phenomenology', '现象学'],
  ['dialectic', '辩证法'],
  ['syllogism', '三段论'],
  ['logical fallacy', '逻辑谬误'],
  ['straw man', '稻草人谬误'],
  ['ad hominem', '人身攻击谬误', '（拉丁语）'],
  ['slippery slope', '滑坡谬误'],
  ['false dichotomy', '非此即彼谬误'],
  ['begging the question', '窃取论题'],
  ['circular reasoning', '循环论证'],
  ['deductive reasoning', '演绎推理'],
  ['inductive reasoning', '归纳推理'],
  ['counterargument', '反方论点'],
  ['counterexample', '反例'],
  ['topic sentence', '主题句'],
  ['rhetoric', '修辞'],
  ['rhetorical question', '反问'],
  ['narrative', '叙事'],
  ['Enlightenment', '启蒙运动'],
  ['Renaissance', '文艺复兴'],
  ['Industrial Revolution', '工业革命'],
  ['American Revolution', '美国独立战争'],
  ['Civil War', '南北战争'],
  ['Reconstruction', '重建时期'],
  ['Cold War', '冷战'],
  ['World War I', '第一次世界大战'],
  ['World War II', '第二次世界大战'],
  ['Great Depression', '大萧条'],
  ['New Deal', '新政'],
  ['Civil Rights Movement', '民权运动'],
  ['Declaration of Independence', '独立宣言'],
  ['Founding Fathers', '建国先贤'],
  ['Articles of Confederation', '邦联条例'],
  ['Federalist Papers', '联邦党人文集'],
  ['Manifest Destiny', '昭昭天命'],
  ['Great Migration', '黑人大迁徙'],
  ['abolition', '废奴运动'],
  ['suffrage', '选举权'],
  ["women's suffrage", '女性选举权'],
  ['colonialism', '殖民主义'],
  ['imperialism', '帝国主义'],
  ['capitalism', '资本主义'],
  ['socialism', '社会主义'],
  ['communism', '共产主义'],
  ['Marxism', '马克思主义'],
  ['primary source', '一手史料'],
  ['secondary source', '二手资料'],
  ['historiography', '史学史'],
  ['periodization', '历史分期'],
  ['oral history', '口述史'],
  ['archive', '档案'],
  ['Plato', '柏拉图'],
  ['Aristotle', '亚里士多德'],
  ['Immanuel Kant', '康德'],
  ['John Locke', '约翰·洛克'],
  ['John Stuart Mill', '约翰·斯图尔特·密尔'],
  ['Thomas Hobbes', '霍布斯'],
  ['Jean-Jacques Rousseau', '卢梭'],
  ['John Rawls', '约翰·罗尔斯'],
  ['Adam Smith', '亚当·斯密'],
  ['Alexis de Tocqueville', '托克维尔']
];

/** 按学科分组的术语表（源数据） */
export const GLOSSARY_BY_FIELD = Object.freeze({
  law: LAW, politics: POLITICS, economics: ECON, cs: CS,
  stats: STATS, psychology: PSYCH, science: SCIENCE,
  campus: CAMPUS, humanities: HUMANITIES
});

/** 英→中术语对照表（扁平数组，每项 [英文, 中文] 或 [英文, 中文, 备注]） */
export const GLOSSARY = Object.freeze(
  Object.keys(GLOSSARY_BY_FIELD).reduce((all, f) => all.concat(GLOSSARY_BY_FIELD[f]), [])
);

/* ===========================================================================
 * 二、常见错译别名
 * ---------------------------------------------------------------------------
 * 键 = 标准译法，值 = 小模型常见的错译/异译。
 * 只有在原文里确实出现了对应术语时才会替换，所以安全（见 applyGlossary）。
 * ========================================================================= */
const ALIASES = {
  '最高法院': ['最高法庭', '至高法院', '高等法院', '最高裁判所'],
  '第一修正案': ['第一条修正案', '首次修正案', '第一修改案'],
  '第十四修正案': ['第十四条修正案'],
  '正当程序': ['适当程序', '应有程序', '正当手续'],
  '司法审查': ['司法复审', '司法审核'],
  '遵循先例': ['依循先例', '尊重先例'],
  '法庭之友': ['法院之友'],
  '调卷令': ['证明书', '调案令'],
  '人身保护令': ['人身保护法'],
  '陪审团': ['评审团', '陪审员团'],
  '大陪审团': ['大评审团'],
  '权利法案': ['人权法案', '权利草案'],
  '言论自由': ['自由言论', '发言自由'],
  '三权分立': ['权力分立', '权力的分离'],
  '制衡': ['检查与平衡', '检查和平衡', '支票与平衡', '支票和结余'],
  '联邦制': ['联邦主义'],
  '众议院': ['代表院', '代表议院'],
  '弹劾': ['弹劾程序化'],
  '选举人团': ['选举学院', '选举团学院'],
  '冗长辩论': ['阻挠者'],
  '知识产权': ['智慧财产权', '智力财产权'],
  '合理使用': ['公平使用', '正当使用'],
  '隐私权': ['私隐权'],
  '侵权行为': ['折磨', '酷刑'],
  '正当法律程序': ['法律的正当手续'],
  '国内生产总值': ['国民生产总值', '本地生产总值'],
  '机会成本': ['机遇成本', '机会费用'],
  '边际效用': ['边缘效用', '边际用途'],
  '边际成本': ['边缘成本'],
  '沉没成本': ['下沉成本', '沉船成本'],
  '弹性': ['弹力', '伸缩性'],
  '供给与需求': ['供应与需求', '供应和需求'],
  '通货膨胀': ['膨胀'],
  '美联储': ['联邦储备', '联邦储备局'],
  '垄断': ['专卖'],
  '囚徒困境': ['囚犯困境', '囚徒两难'],
  '公地悲剧': ['公共悲剧', '公地的悲哀'],
  '机器学习': ['机械学习'],
  '过拟合': ['过度拟合', '过度适应', '超配'],
  '梯度下降': ['坡度下降', '渐变下降'],
  '时间复杂度': ['时间复杂性'],
  '缓存': ['高速缓存', '快取'],
  '数据集': ['数据组'],
  '零假设': ['无效假设', '虚无假设', '空假设'],
  '置信区间': ['信赖区间', '可信区间', '信心区间'],
  'p 值': ['P 值', 'P值', 'p价值', 'P价值'],
  '回归分析': ['倒退', '退化', '回归作用'],
  '标准差': ['标准偏差'],
  '样本量': ['抽样规模', '样本大小'],
  '对照组': ['控制组', '管制组'],
  '自变量': ['独立变量'],
  '因变量': ['依赖变量', '从属变量'],
  '安慰剂': ['假药'],
  '知情同意': ['告知同意', '知情许可'],
  '同行评审': ['同行审查', '同侪评议'],
  '认知失调': ['认知不协调', '认知失谐'],
  '确认偏误': ['验证偏误', '确认偏向'],
  '刻板印象': ['陈规定型', '定型观念'],
  '社会化': ['社交化'],
  '摩尔': ['鼹鼠'],
  '大萧条': ['大抑郁', '大萧条症'],
  '冷战': ['寒战'],
  '新政': ['新交易', '新协议'],
  '独立宣言': ['独立声明'],
  '功利主义': ['实用主义'],
  '演绎推理': ['扣除推理', '减法推理'],
  '归纳推理': ['感应推理', '诱导推理'],
  '滑坡谬误': ['滑溜斜坡', '湿滑的斜坡', '滑坡'],
  '教学大纲': ['教学摘要', '课程摘要', '大纲摘要'],
  '助教': ['教学助理', '教学助手'],
  '期中考试': ['中期考试', '中期'],
  '期末考试': ['最后考试', '决赛', '期末'],
  '答疑时间': ['办公时间', '办公室时间', '上班时间'],
  '习题集': ['问题集', '问题组', '一套问题'],
  '学分': ['信用小时', '学分小时', '信贷时数'],
  '平均绩点': ['平均积分点'],
  '成绩单': ['抄本', '誊本'],
  '先修课程': ['先决条件', '前提条件'],
  '截止日期': ['到期日', '应付日期', '期限日'],
  '幻灯片': ['滑梯', '幻灯'],
  '课堂笔记': ['演讲笔记'],
  '抄袭': ['剽窃行为'],
  '学术诚信': ['学术完整性', '学术一致性'],
  '评分标准': ['规则书'],
  '大一新生': ['新生人'],
  '学期': ['半学期'],
  '实习': ['实习期']
};

/* ===========================================================================
 * 三、索引（懒构建）
 * ---------------------------------------------------------------------------
 * 600+ 条术语不可能每句话跑 600 次正则。做法：
 *   1. 把英文术语按同一套分词规则切成 token，归一化后拼成 key，存进 Map；
 *   2. 扫描句子时也切 token，用首词集合（firstTok）快速跳过；
 *   3. 命中时从最长 n-gram 往短试，保证「circuit court」优先于「circuit」。
 * 复杂度 ≈ O(句子词数 × 最长术语词数)，与术语表大小无关。
 * ========================================================================= */

// token：字母开头的词（允许词内 ' . -），或数字
const TOKEN_RE = /[A-Za-z][A-Za-z'’.\-]*|\d+(?:\.\d+)?/g;

// token 归一化：小写、弯引号转直引号、去掉点号（U.S. → us；court. → court）、去掉首尾连字符
function normTok(t) {
  return String(t).toLowerCase()
    .replace(/’/g, "'")
    .replace(/\./g, '')
    .replace(/^-+|-+$/g, '');
}

// 切词并记录字符位置
function tokenize(text) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const n = normTok(m[0]);
    if (n) out.push({ raw: m[0], n, s: m.index, e: m.index + m[0].length });
  }
  return out;
}

// 粗糙的单数还原（只对最后一个词做，够用了）
function singular(w) {
  if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && /[^s]s$/.test(w)) return w.slice(0, -1);
  return '';
}

let INDEX = null;       // Map: key → entry
let FIRST_TOK = null;   // Set: 所有术语的首词
let MAX_WORDS = 1;

function buildIndex() {
  INDEX = new Map();
  FIRST_TOK = new Set();
  MAX_WORDS = 1;
  const fields = Object.keys(GLOSSARY_BY_FIELD);
  for (const field of fields) {
    for (const row of GLOSSARY_BY_FIELD[field]) {
      const en = row[0], zh = row[1], note = row[2] || '';
      const toks = tokenize(en).map(t => t.n);
      if (!toks.length) continue;
      const entry = {
        en, zh, note, field,
        words: toks.length,
        // 需要在中文后补英文原词的：专有名词（含大写）或带备注的（拉丁语等）
        ann: /[A-Z]/.test(en) || !!note
      };
      const keys = [toks.join(' ')];
      // 连字符变体：cost-benefit analysis ↔ cost benefit analysis
      if (/-/.test(toks.join(' '))) {
        const alt = tokenize(en.replace(/-/g, ' ')).map(t => t.n).join(' ');
        if (alt && alt !== keys[0]) keys.push(alt);
      }
      for (const k of keys) {
        if (!INDEX.has(k)) INDEX.set(k, entry);
        const n = k.split(' ').length;
        if (n > MAX_WORDS) MAX_WORDS = n;
        FIRST_TOK.add(k.split(' ')[0]);
      }
    }
  }
}

function ensureIndex() { if (!INDEX) buildIndex(); return INDEX; }

/** 术语条数（自检用） */
export function glossarySize() { ensureIndex(); return INDEX.size; }

/**
 * 在英文里找出所有术语命中，按出现顺序返回
 * @returns {{en:string, zh:string, note:string, field:string, start:number, end:number, text:string}[]}
 */
export function findTerms(en) {
  ensureIndex();
  const text = String(en || '');
  if (!text) return [];
  const toks = tokenize(text);
  const hits = [];
  let i = 0;
  while (i < toks.length) {
    const t0 = toks[i].n;
    if (!FIRST_TOK.has(t0) && !FIRST_TOK.has(singular(t0))) { i++; continue; }
    let hit = null, len = 0;
    const maxL = Math.min(MAX_WORDS, toks.length - i);
    for (let L = maxL; L >= 1; L--) {
      const parts = [];
      for (let k = 0; k < L; k++) parts.push(toks[i + k].n);
      const key = parts.join(' ');
      let e = INDEX.get(key);
      if (!e) {                                  // 复数还原（只动最后一个词）
        const sg = singular(parts[L - 1]);
        if (sg) {
          parts[L - 1] = sg;
          e = INDEX.get(parts.join(' '));
        }
      }
      if (e) { hit = e; len = L; break; }
    }
    if (hit) {
      hits.push({
        en: hit.en, zh: hit.zh, note: hit.note, field: hit.field, ann: hit.ann,
        start: toks[i].s, end: toks[i + len - 1].e,
        text: text.slice(toks[i].s, toks[i + len - 1].e)
      });
      i += len;
    } else i++;
  }
  return hits;
}

/* ===========================================================================
 * 四、shouldTranslate —— 值不值得翻
 * ========================================================================= */

// 纯语气词 / 口头禅
const FILLERS = new Set([
  'um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'er', 'erm', 'ah', 'ahh', 'oh', 'mm', 'mmm',
  'mhm', 'mhmm', 'hmm', 'hmmm', 'huh', 'yeah', 'yea', 'yep', 'yup', 'nope', 'ok', 'okay',
  'right', 'alright', 'so', 'well', 'like', 'anyway', 'anyways', 'sure', 'hey', 'hi',
  'hello', 'thanks', 'thank', 'you', 'know', 'i', 'mean', 'just', 'actually', 'basically',
  'literally', 'kinda', 'sorta', 'gonna'
]);

const enWords = t => (String(t || '').match(/[A-Za-z0-9'’-]+/g) || []);

/**
 * 这段英文值不值得送去翻译
 * 跳过：空 / 纯数字 / 纯标点 / 纯语气词 / 太短且不是术语
 */
export function shouldTranslate(en) {
  const t = String(en || '').trim();
  if (!t) return false;
  if (!/[A-Za-z]/.test(t)) return false;                 // 没字母：纯数字、纯标点、纯符号
  const ws = enWords(t);
  if (!ws.length) return false;

  // 去掉语气词后还剩什么
  const meaty = ws.filter(w => !FILLERS.has(w.toLowerCase().replace(/[^a-z']/g, '')));
  if (!meaty.length) return false;                       // 整句都是 um / yeah / okay / you know

  if (ws.length >= 3) return true;
  // 少于 3 个词：只有命中术语表才翻（"Supreme Court"、"certiorari" 要翻，"pre" 不翻）
  return findTerms(t).length > 0;
}

/* ===========================================================================
 * 五、preprocess —— 送进模型之前的清理
 * ========================================================================= */

// 允许折叠「只出现两次」的重复词（ASR 常见口吃）。刻意不收 that / had 这类合法叠词
const STUTTER_OK = new Set([
  'the', 'a', 'an', 'and', 'i', 'to', 'it', 'is', 'of', 'in', 'on', 'we', 'you', 'they',
  'he', 'she', 'but', 'or', 'so', 'this', 'what', 'was', 'are', 'do', 'my', 'me', 'be'
]);

// 单独成词的语气词，删掉不改变内容（长的写在前面，避免 "uh-huh" 被切成 "-huh"）
const DROP_WORDS = /\b(?:uh[-\s]?huh|mm[-\s]?hmm|mhm+|um+|uh+|erm|hmm+)\b[,\s]*/gi;

// 星期 / 月份：ASR 经常给小写，补回大写能让翻译模型认出这是日期
// （故意不收 march / may / august —— 它们也是普通词，改了会误导模型）
const DATE_WORDS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|april|june|july|september|october|november|december)\b/g;

/**
 * 送进翻译模型之前的清理：
 * 口头禅、重复词、空格、句末标点、专有名词大小写。不改变实际内容。
 */
export function preprocess(en) {
  let t = String(en || '');
  if (!t) return '';

  // 1) 统一空白 + 去控制字符
  t = t.replace(/[\u00a0\u2007\u202f]/g, ' ')
       .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
       .replace(/\s+/g, ' ')
       .trim();
  if (!t) return '';

  // 2) 删掉独立的语气词（um / uh / hmm）
  t = t.replace(DROP_WORDS, '').replace(/\s+/g, ' ').trim();

  // 3) 折叠重复词："the the the" → "the"，"is is" → "is"
  t = t.replace(/\b([A-Za-z']+)((?:\s+\1\b)+)/gi, (m, w, rest) => {
    const times = 1 + (rest.match(/\S+/g) || []).length;
    const lw = w.toLowerCase();
    if (times >= 3) return w;                     // 连说三遍以上，一定是口吃
    return STUTTER_OK.has(lw) ? w : m;            // 只说两遍：只折叠常见口吃词
  });

  // 4) 标点 / 空格规范
  t = t.replace(/\s+([,.;:!?])/g, '$1')           // 标点前不留空格
       .replace(/([,;:])(?=[^\s])/g, '$1 ')       // 标点后补空格
       .replace(/([.!?]){3,}/g, '$1$1$1')         // "......" → "..."
       .replace(/,{2,}/g, ',')
       .replace(/\s+/g, ' ')
       .replace(/^[,;:\s]+/, '')                  // 开头的孤立标点
       .trim();
  if (!t) return '';

  // 5) 专有名词大小写还原："supreme court" → "Supreme Court"
  //    （只在词完全一致时替换，只改大小写，不动内容）
  const hits = findTerms(t);
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (!/[A-Z]/.test(h.en)) continue;
    if (h.text === h.en) continue;
    if (h.text.toLowerCase() !== h.en.toLowerCase()) continue;   // 复数/连字符变体：不碰
    t = t.slice(0, h.start) + h.en + t.slice(h.end);
  }

  // 6) 星期 / 月份大写
  t = t.replace(DATE_WORDS, w => w[0].toUpperCase() + w.slice(1));

  // 7) 句首大写（小模型对全小写输入表现更差）
  if (/^[a-z]/.test(t)) t = t[0].toUpperCase() + t.slice(1);

  // 8) 补句末标点
  if (/[A-Za-z0-9'’")\]]$/.test(t)) t += '.';

  return t;
}

/* ===========================================================================
 * 六、looksDegenerate —— 抓小模型的退化输出
 * ========================================================================= */

// 合法的叠词/成语白名单：避免把「各种各样」「一步一步」「法律法规」误判成复读
const REDUP_OK = new Set([
  '一步一步', '各种各样', '各式各样', '各行各业', '一心一意', '一模一样', '自言自语',
  '自由自在', '无影无踪', '无穷无尽', '不知不觉', '半信半疑', '全心全意', '十全十美',
  '一五一十', '有始有终', '无法无天', '人山人海', '实事求是', '多种多样', '一分一秒',
  '法律法规', '教育教学', '语言文字', '生生不息', '时时刻刻', '家家户户', '人人平等',
  '日日夜夜', '年年岁岁', '千千万万', '形形色色', '林林总总', '方方面面', '点点滴滴',
  '是是非非', '大大小小', '高高兴兴', '干干净净', '平平安安', '认认真真', '仔仔细细',
  '越来越多', '越来越少', '越来越大', '越来越好', '越来越快', '想来想去', '说来说去'
]);

// 虚词：以它们开头的两字块共享首字很常见（越来越…），不当作复读
const FUNC_HEAD = new Set(['越', '又', '更', '再', '很', '一', '不', '没', '好', '每', '还', '也', '就', '都', '自', '各', '无', '有']);

const CJK_RE = /[㐀-䶿一-鿿]/;
const CJK_G = /[㐀-䶿一-鿿]/g;

// 标点打架：句号/问号/感叹号后面紧跟逗号（「。,」「?,」），或逗号后面紧跟句号/逗号（「,,」「,。」）。
// 正常中文不会这样写，这是 opus-mt 陷进复读循环、把一段段半截话硬拼起来时留下的接缝。
// 刻意不收「。。」「??」「...」：模型照抄原文的省略号/问号很常见，读起来没问题。
// 英文句点只在前面不是字母/数字时才算（免得「U.S.,」「2.,」被误算）。
const PUNCT_CLASH_G = /[。!！?？][,，、]|(?<![A-Za-z0-9])\.[,，、]|[,，、][。!！?？,，、]|[,，、]\.(?!\.)/g;

// 切小句用的分隔符（中英文标点 + 空白）
const CLAUSE_SPLIT = /[。！？；，、,.!?;…:：\s]+/;

/** 数组里出现次数最多的元素出现了几次 */
function maxCount(arr) {
  const m = new Map();
  let best = 0;
  for (const x of arr) {
    const n = (m.get(x) || 0) + 1;
    m.set(x, n);
    if (n > best) best = n;
  }
  return best;
}

/**
 * 原文自己重复了多少次：同一个小句出现几次，或同一个词连着说几次（"no, no, no" / "again again"）
 * 用来给译文的复读「留额度」—— 原文说了三遍「不」，译文三遍「不」是对的。
 */
function enRepeatAllowance(src) {
  const s = String(src || '').toLowerCase();
  const clauses = s.split(/[.,!?;:]+/).map(x => x.trim()).filter(Boolean);
  let best = maxCount(clauses);
  const ws = enWords(s);
  let run = 1;
  for (let i = 1; i < ws.length; i++) {
    run = ws[i] === ws[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return Math.max(1, best);
}

/** 原文里有没有重复出现的三词短语（口语里说话人自己重说一遍很常见，译文跟着重复是对的） */
function enHasRepeatedPhrase(src) {
  const ws = enWords(src).map(w => w.toLowerCase());
  const seen = new Set();
  for (let i = 0; i + 3 <= ws.length; i++) {
    const k = ws[i] + ' ' + ws[i + 1] + ' ' + ws[i + 2];
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

/**
 * 不相邻地重复出现的长中文片段（≥6 字），返回第一个找到的片段，没有返回 ''。
 * 「我们开始做一些新的……我们开始做一些新的东西」这种隔几句又绕回来的复读，
 * 上面「连续重复」的规则抓不到。
 */
function repeatedLongRun(zhOnly) {
  if (zhOnly.length < 12) return '';
  for (let L = 6; L <= 12; L++) {
    for (let i = 0; i + 2 * L <= zhOnly.length; i++) {
      const piece = zhOnly.slice(i, i + L);
      if (zhOnly.indexOf(piece, i + L) >= 0) return piece;
    }
  }
  return '';
}

/**
 * 检测译文是否退化
 * @param {string} zh 译文
 * @param {string} en 原文（用于长度/内容参照）
 * @returns {{bad:boolean, reason:string}}
 */
export function looksDegenerate(zh, en) {
  const raw = String(zh == null ? '' : zh);
  const src = String(en == null ? '' : en);
  const BAD = r => ({ bad: true, reason: r });
  const OK = { bad: false, reason: '' };

  if (!raw.trim()) return BAD('空译文');

  // --- 乱码 / 控制字符 ---
  if (/\ufffd/.test(raw)) return BAD('乱码（U+FFFD）');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)) return BAD('含控制字符');
  if (/[\ue000-\uf8ff]/.test(raw)) return BAD('乱码（私用区字符）');
  if (/[\ud800-\udfff]/.test(raw) && !/[\ud800-\udbff][\udc00-\udfff]/.test(raw)) return BAD('乱码（半个代理对）');

  const cjk = (raw.match(CJK_G) || []).length;
  const letters = (raw.match(/[A-Za-z]/g) || []).length;

  // --- 根本没翻 ---
  if (!cjk) return BAD('没有中文');
  const flat = s => s.toLowerCase().replace(/[\s\p{P}]/gu, '');
  if (src && flat(raw) === flat(src)) return BAD('原样抄回原文');
  if (letters > 10 && cjk / (cjk + letters) < 0.15) return BAD('几乎没翻译（大段英文）');

  // --- 标点 / 空格异常 ---
  if (/([\p{P}\p{S}])\1{3,}/u.test(raw)) return BAD('标点重复');
  if (/\s{4,}/.test(raw)) return BAD('空格异常');
  const cjkGap = (raw.match(/[一-鿿]\s+[一-鿿]/g) || []).length;
  if (cjkGap >= 2 || (cjkGap >= 1 && cjk <= 8)) return BAD('中文里混入空格（疑似逐字拼接）');
  if (/(.)\1{4,}/.test(raw)) return BAD('字符重复');

  // --- 复读 ---
  const z = raw.replace(/\s+/g, '');
  // 3~12 字的单元连续重复
  const m3 = z.match(/([一-鿿]{3,12})\1+/);
  if (m3 && !REDUP_OK.has(m3[0]) && (m3[0].length / z.length > 0.4 || m3[0].length >= 10)) {
    return BAD('复读：' + m3[1]);
  }
  // 2 字单元重复：重复 3 次以上一定有问题，重复 2 次要占到大半句
  const m2 = z.match(/([一-鿿]{2})\1+/);
  if (m2 && !REDUP_OK.has(m2[0])) {
    const times = m2[0].length / 2;
    if (times >= 3) return BAD('复读：' + m2[1]);
    if (m2[0].length / z.length > 0.6) return BAD('复读：' + m2[1]);
  }
  // 整句被切成两字块、且多块共享首字："章次章节"、"最高法院法院"
  const zhOnly = (z.match(new RegExp(CJK_RE.source, 'g')) || []).join('');
  if (zhOnly === z && z.length >= 4 && z.length <= 10 && z.length % 2 === 0 && !REDUP_OK.has(z)) {
    const chunks = z.match(/.{2}/g) || [];
    const heads = new Set(chunks.map(c => c[0]));
    if (heads.size < chunks.length && !chunks.some(c => FUNC_HEAD.has(c[0]))) {
      return BAD('疑似复读：' + chunks.join('/'));
    }
  }
  const w = enWords(src).length;
  const zLen = z.length;

  // 整句级重复："他说这个。他说这个。"
  // 口语里说话人自己重复一句是正常的（原文也会重复），所以额外要求译文相对原文明显偏长
  const clauses = raw.split(/[。！？；，,!?;\n]+/).map(s => s.trim()).filter(s => s.length >= 4);
  if (clauses.length >= 2) {
    const uniq = new Set(clauses);
    const dupRate = (clauses.length - uniq.size) / clauses.length;
    if (uniq.size < clauses.length && dupRate >= 0.5 && (!w || zLen > w * 2.2)) {
      return BAD('整句复读');
    }
  }

  // --- 复读循环的拼接痕迹（真实课堂录音里 opus-mt 崩出来的样子）---
  // 例：「……在工厂里。。。,我们开始做一些新的,,我们做一些东西,比如……,我们开始做一些新的东西,,我们做一些东西,比如, 做」
  // 单看任何一条都可能是正常口语译文偶尔带的毛病，所以：一条够硬就直接判，否则要两条以上同时出现。
  const clash = (z.match(PUNCT_CLASH_G) || []).length;
  if (clash >= 3) return BAD('标点堆叠（疑似复读拼接）');

  // 同一个小句被念了好几遍，原文却没这么说：「你这混蛋,你这混蛋,你这混蛋」「我明白,我明白,我明白,我明白」
  // （小模型在句尾凭空编出来的复读尾巴，中文比例、长度都正常，前面的规则全放过了）
  // 只看 3 个字以上的小句：「是的,是的,是的」常常是 yes / yeah / yep 被翻成同一个词，
  // 一个人连着应三声也很正常；真正的复读尾巴（你这混蛋、我明白）都在 3 个字以上。
  const zhClauses = raw.split(CLAUSE_SPLIT).filter(c => c && [...c.trim()].length >= 3);
  const clauseRep = maxCount(zhClauses);
  if (clauseRep >= 3 && clauseRep > enRepeatAllowance(src) + 1) return BAD('小句复读');

  const signs = [];
  if (clash) signs.push('标点堆叠');
  if (clash >= 2) signs.push('标点堆叠×2');
  // 中文比英文应有的长度长出一大截（正常口语译文大约 1.2~2 个汉字/词）
  if (w >= 5 && cjk > w * 2.2 + 6) signs.push('偏长');
  // 结尾半截：长句最后停在「, 做」「,我」这种逗号后孤零零一个字上
  if (cjk >= 20 && /[,，、][一-鿿]$/.test(z)) signs.push('结尾半截');
  // 隔开重复的长片段（≥6 字），而原文并没有重复的短语
  const longRep = repeatedLongRun(zhOnly);
  if (longRep && !enHasRepeatedPhrase(src)) signs.push('重复片段「' + longRep + '」');
  if (signs.length >= 2) return BAD('疑似复读拼接：' + signs.join('、'));

  // --- 长度异常（拿原文做参照）---
  if (w > 0) {
    if (w <= 4 && zLen > w * 6 + 2) return BAD('短句译文过长');
    if (w >= 3 && zLen > w * 4.5 + 8) return BAD('译文过长（疑似复读）');
    if (w >= 8 && zLen < w * 0.5) return BAD('译文过短（疑似漏译）');
  }

  return OK;
}

/* ===========================================================================
 * 七、applyGlossary —— 用术语表纠正译文
 * ========================================================================= */

// 把 needle 全部替换成 rep（不走正则，省得转义出事）
function replaceAll(s, needle, rep) {
  if (!needle || needle === rep || s.indexOf(needle) < 0) return s;
  return s.split(needle).join(rep);
}

// 最多给几个术语补英文原词（多了反而碍眼）
const MAX_ANNOTATE = 2;
// 一节课里同一个术语最多补几次英文（不然每句字幕都挂着「（Supreme Court）」很吵）
const MAX_ANNOTATE_PER_TERM = 2;

const annMemory = new Map();   // 术语中文 → 本节课已经补过几次

/** 清空「已经补过英文原词」的记忆（换一节课 / 重新翻译整篇时调用） */
export function resetGlossaryMemory() { annMemory.clear(); }

/**
 * 拿原文和译文，纠正术语
 *  1) 折叠「最高法院最高法院」这种术语复读
 *  2) 把常见错译（办公时间 / 支票与平衡 / 抄本）换成标准译法
 *  3) 首次出现的专有名词后面补英文原词：最高法院（Supreme Court）
 *  4) 译文里彻底漏掉的术语，句末补一条提示：　［Supreme Court＝最高法院］
 * @param {string} en 原文
 * @param {string} zh 译文
 * @param {{annotate?:boolean, maxAnnotate?:number, noteMissing?:boolean,
 *          maxNote?:number, session?:boolean}} [opts]
 * @returns {string}
 */
export function applyGlossary(en, zh, opts) {
  let out = String(zh == null ? '' : zh);
  const src = String(en == null ? '' : en);
  if (!out.trim() || !src.trim()) return out;

  const o = opts || {};
  const annotate = o.annotate !== false;
  const maxAnn = typeof o.maxAnnotate === 'number' ? o.maxAnnotate : MAX_ANNOTATE;
  // session=false 时只在本次调用内去重（无跨句记忆）
  const useMemory = o.session !== false;

  // 原文里命中的术语，按出现顺序去重
  const raw = findTerms(src);
  if (!raw.length) return out;
  const seen = new Set();
  const hits = [];
  for (const h of raw) {
    if (seen.has(h.zh)) continue;
    seen.add(h.zh);
    hits.push(h);
  }

  // --- 1) 折叠术语自身的复读 ---
  for (const h of hits) {
    if (h.zh.length < 2) continue;
    let guard = 0;
    while (out.indexOf(h.zh + h.zh) >= 0 && guard++ < 8) {
      out = replaceAll(out, h.zh + h.zh, h.zh);
    }
  }

  // --- 2) 错译纠正 ---
  for (const h of hits) {
    const alts = ALIASES[h.zh];
    if (!alts) continue;
    // 关键保护：正确译法已经出现在译文里，说明模型这次没译错。
    // 此时句子里的「别名」多半是另一个意思的普通词，不是错译，硬换会把通顺的句子改坏：
    //   「评分标准在大纲上，看一下论文的标题」→ 标题 被换成 评分标准
    //   「在侵权行为里我们不研究酷刑」      → 酷刑 被换成 侵权行为
    //   「新政是政府和劳工之间的新协议」    → 新协议 被换成 新政
    //   「向下滑动看幻灯片」                → 滑动 被换成 幻灯片
    // 宁可漏纠一个词，也不能把已经对的句子改成病句。
    if (out.indexOf(h.zh) >= 0) continue;
    for (const a of alts) {
      if (!a || a === h.zh) continue;
      if (seen.has(a)) continue;                       // 这个说法是本句里另一个术语的标准译法，别动
      if (h.zh.indexOf(a) >= 0 || a.indexOf(h.zh) >= 0) continue;  // 互为子串，替换会越改越乱
      if (out.indexOf(a) < 0) continue;
      out = replaceAll(out, a, h.zh);
    }
  }
  // 替换完可能又造出复读，再折叠一次
  for (const h of hits) {
    let guard = 0;
    while (h.zh.length >= 2 && out.indexOf(h.zh + h.zh) >= 0 && guard++ < 8) {
      out = replaceAll(out, h.zh + h.zh, h.zh);
    }
    // 部分重叠也要折叠：译文里原本是「倒退分析」，把「倒退」换成「回归分析」之后
    // 变成「回归分析分析」——重复的是标准译法的**尾巴**，上面那条整词折叠抓不到。
    for (let k = h.zh.length - 1; k >= 2; k--) {
      const tail = h.zh.slice(h.zh.length - k);
      let g2 = 0;
      while (out.indexOf(h.zh + tail) >= 0 && g2++ < 8) {
        out = replaceAll(out, h.zh + tail, h.zh);
      }
    }
  }

  // --- 3) 首次出现补英文原词 ---
  if (annotate && maxAnn > 0) {
    let done = 0;
    const lower = () => out.toLowerCase();
    for (const h of hits) {
      if (done >= maxAnn) break;
      if (!h.ann) continue;                            // 只给专有名词/拉丁术语补
      if (h.zh.length < 2) continue;
      if (useMemory && (annMemory.get(h.zh) || 0) >= MAX_ANNOTATE_PER_TERM) continue;
      const at = out.indexOf(h.zh);
      if (at < 0) continue;                            // 译文里根本没这个词，不硬塞
      if (lower().indexOf(h.en.toLowerCase()) >= 0) continue;   // 已经有英文了
      const after = out.slice(at + h.zh.length, at + h.zh.length + 1);
      if (after === '（' || after === '(') continue;   // 后面已经跟着括号注释
      out = out.slice(0, at + h.zh.length) + '（' + h.en + '）' + out.slice(at + h.zh.length);
      if (useMemory) annMemory.set(h.zh, (annMemory.get(h.zh) || 0) + 1);
      done++;
    }
  }

  // --- 4) 译文里彻底漏掉的术语：句末补一条「英文＝中文」提示 ---
  //     不去动译文本身（改了容易越改越乱），只在末尾挂一个小尾巴
  if (o.noteMissing !== false) {
    const maxNote = typeof o.maxNote === 'number' ? o.maxNote : 2;
    const notes = [];
    for (const h of hits) {
      if (notes.length >= maxNote) break;
      if (!h.ann || h.zh.length < 2) continue;
      if (out.indexOf(h.zh) >= 0) continue;                       // 译对了
      if (out.toLowerCase().indexOf(h.en.toLowerCase()) >= 0) continue;  // 英文已经在了
      if (useMemory && (annMemory.get(h.zh) || 0) >= MAX_ANNOTATE_PER_TERM) continue;
      notes.push(h.en + '＝' + h.zh);
      if (useMemory) annMemory.set(h.zh, (annMemory.get(h.zh) || 0) + 1);
    }
    if (notes.length) out = out.replace(/\s*$/, '') + '　［' + notes.join('；') + '］';
  }

  // --- 5) 收尾：清掉可能出现的重复括号注释 ---
  out = out.replace(/（([^（）]{1,40})）(?:（\1）)+/g, '（$1）');
  return out;
}

/**
 * 一步到位：拿到模型译文后调用，返回 {zh, bad, reason}
 * （给上层省事用的便捷函数，主流程也可以只用上面四个）
 */
export function refine(en, zh) {
  const v = looksDegenerate(zh, en);
  if (v.bad) return { zh: '', bad: true, reason: v.reason };
  return { zh: applyGlossary(en, zh), bad: false, reason: '' };
}
