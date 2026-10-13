/**
 * 拒答闸门（双闸门机制）
 * --------------------------------------------------------------
 * 闸门1（别名快判）：命中校园别名/校园生活词 → 直接放行；命中明显无关模式 → 直接拒绝。
 * 闸门2（大模型意图分类兜底）：快判无法判定时，调用大模型二分类，决定放行或拒绝。
 * 设计目标：既不能误杀"食堂在哪/考研分数"等校园问题，也要拦下"讲笑话/写代码"等无关问题。
 */

export type GateDecision = 'campus' | 'offtopic' | 'unknown';

const CAMPUS_ALIASES = [
  '中国计量大学', '中量大', '量大', 'CJLU', '计量大学', '计量', '本校', '我校', '学校', '校园', '校区',
  '校训', '校歌', '校庆', '学院', '专业', '学科', '招生', '录取', '考研', '研究生', '博士', '硕士',
  '老师', '教师', '学生', '宿舍', '食堂', '图书馆', '课程', '考试', '社团', '逸夫', '博物馆',
  '下沙', '学源街', '就业', '奖学金', '毕业', '培养', '知识产权', '光电', '测控', '自动化',
  '安全工程', '食品', '工商管理', '标准化', '学费', '分数线', '宿舍', '食堂', '自习室', '操场',
];

const OFFTOPIC_PATTERNS: RegExp[] = [
  /讲个?笑话|讲个?段子|说个?笑话/,
  /写(一段|一个|个)?(代码|程序|脚本|贪吃蛇|函数|算法)|python|java|javascript|c\+\+|html|css/,
  /天气|气温|下雨|下雪|台风|空气质量/,
  /股票|基金|比特币|炒股|期货|彩票/,
  /做(红烧肉|饭|菜|蛋糕|面包|奶茶)|菜谱|怎么做饭/,
  /其他大学|北京大学|清华大学|复旦大学|浙江大学|上海交大|哈佛|麻省|斯坦福|牛津|剑桥/,
  /唱歌|跳舞|画画|作曲|写诗|写小说|写歌/,
  /翻译(一下|成)?|帮我翻译/,
  /美国总统|特朗普|拜登|俄乌|世界杯|NBA|欧冠|明星|娱乐圈/,
  /帮我(算|解|求)|1\+1|方程|微积分/,
];

const GREETINGS: RegExp[] = [
  /^(你好|您好|你们好|hi|hello|嗨|在吗|在么|早上好|中午好|晚上好|老师好)[\s!！。.~～]*$/i,
];

const IDENTITY: RegExp[] = [
  /^(你是谁|你叫什么|介绍一下你自己|你是什么|你是干嘛的|你是做什么的)[?？!！。.]*$/i,
];

export function hasCampusTerm(text: string): boolean {
  return CAMPUS_ALIASES.some((k) => text.includes(k));
}

export function quickGate(question: string): GateDecision {
  const s = question.trim();
  if (!s) return 'offtopic';
  if (GREETINGS.some((re) => re.test(s))) return 'campus';
  if (IDENTITY.some((re) => re.test(s))) return 'campus';
  if (CAMPUS_ALIASES.some((k) => s.includes(k))) return 'campus';
  if (OFFTOPIC_PATTERNS.some((re) => re.test(s))) return 'offtopic';
  return 'unknown';
}

/**
 * 闸门2：大模型意图分类。
 * @param question 用户问题
 * @param callLLM  调用大模型的函数（注入，解耦 deepseek 依赖），返回模型原始文本
 */
export async function classifyIntent(
  question: string,
  callLLM: (system: string, user: string) => Promise<string>,
): Promise<'campus' | 'offtopic'> {
  const system = [
    '你是一个严格的意图分类器。',
    '判断用户问题是否与中国计量大学（中量大/CJLU）的校园、教学、招生、校园生活相关。',
    '校园相关的问题（校训、专业、校区、食堂、宿舍、考研、分数线、课程等）回答 YES；',
    '与校园完全无关的问题（讲笑话、写代码、天气、股票、娱乐等）回答 NO。',
    '只回答一个词：YES 或 NO，不要输出任何其他内容。',
  ].join('\n');
  try {
    const ans = (await callLLM(system, question)).trim().toUpperCase();
    return ans.includes('YES') ? 'campus' : 'offtopic';
  } catch {
    // 分类器不可用时保守处理：视为无关（由提示词层兜底）
    return 'offtopic';
  }
}

export const REFUSAL_TEXT =
  '抱歉，我是中国计量大学的校园问答机器人，只能回答与本校校园相关的问题哦～\n' +
  '你可以试着问我："我们学校的特色专业是什么？"';
