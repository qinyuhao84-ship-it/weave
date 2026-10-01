import { textSimilarity } from "@/lib/utils";

/**
 * 「事项配的问题 + 候选答案」的归一化与解析。
 *
 * 与 lib/review/related-pages.ts 同构，理由也一样：这个字段有多个写入方
 * （体检的 queueFindings、导入的 commitIngest）、多个读取方（体检页、导入抽屉、
 * 批量处理引擎），解析逻辑只留一份 —— 否则格式一换就要改五处，而漏掉的那处
 * 通常要到用户看见脏数据才被发现。
 *
 * 这里做的是**确定性净化**，不是「补全」：模型给不出有区分度的选项时，正确的
 * 动作是把问题清空、让界面退回旧的「采纳 / 忽略 / 写批注」，而不是替它编一个。
 * 硬凑的问题比没有问题更糟 —— 它会让用户以为必须选一个才能往下走。
 *
 * 为什么净化必须由程序做而不是靠 prompt 祈愿（不变式 5）：prompt 里当然会写
 * 「不要给雷同的选项」，但模型的服从度是不可控的，而「两个选项意思一样」
 * 这件事用字符二元组相似度就能确定地判出来。
 */

/** 上限与 schema 保持一致；这里再兜一次是因为非严格模式下 schema 不生效 */
export const MAX_OPTIONS = 4;
export const MAX_QUESTION_LENGTH = 300;
export const MAX_OPTION_LABEL_LENGTH = 80;
export const MAX_OPTION_IMPACT_LENGTH = 160;
/**
 * 用户答复的长度上限，与裁决说明的 MAX_NOTE_LENGTH 对齐。
 *
 * 这个数在安全上是有意义的：回答在处理完成后会被写进 decision_note，而
 * decision_note 是 formatDecisions 唯一回灌、且**不包裹 UNTRUSTED_CONTENT**
 * 的那段内容。它之所以配得上这份信任，是因为「用户亲手写下的」——所以长度
 * 必须有个上限，免得一次粘贴把整段 prompt 淹掉。
 */
export const MAX_ANSWER_LENGTH = 500;

/** 两个选项的措辞相似到这个程度就算同一个意思 */
const OPTION_DUPLICATE_THRESHOLD = 0.6;
/** 问题与事项标题相似到这个程度，说明它只是在复述问题本身 */
const QUESTION_ECHOES_TITLE_THRESHOLD = 0.8;

export type ReviewOption = {
  /** 短标识（a / b / c…），作答时回填用 */
  id: string;
  /** 这个选项的答案，一句话 */
  label: string;
  /** 选了会发生什么。界面要内联显示它 —— 用户是照着它做决定的 */
  impact: string;
};

export type ReviewQuestion = {
  /** null = 这条事项没有值得用户拍板的问题 */
  question: string | null;
  /** 空数组 = 退回旧的「采纳 / 忽略 / 写批注」交互 */
  options: ReviewOption[];
};

/** 归一化时丢掉了什么。丢掉的事实必须能说出来（日志与测试都靠它） */
export type NormalizeResult = ReviewQuestion & { dropped: string[] };

/** 模型产出的原始形状 —— 宽容地接收，严格地输出 */
export type RawQuestion = {
  question?: string | null;
  options?: Array<Partial<ReviewOption>> | null;
} | null | undefined;

export function normalizeQuestion(raw: RawQuestion, title: string): NormalizeResult {
  const dropped: string[] = [];
  const empty: NormalizeResult = { question: null, options: [], dropped };

  if (!raw) return empty;

  // --- 选项：逐条过筛，顺序即优先级 ---
  const kept: ReviewOption[] = [];
  const seenIds = new Set<string>();
  const rawOptions = Array.isArray(raw.options) ? raw.options : [];

  for (const [index, option] of rawOptions.entries()) {
    if (kept.length >= MAX_OPTIONS) {
      dropped.push(`超出的选项（每条事项最多 ${MAX_OPTIONS} 个）`);
      break;
    }
    if (!option || typeof option !== "object") {
      dropped.push("形状不对的选项");
      continue;
    }

    const label = clean(option.label).slice(0, MAX_OPTION_LABEL_LENGTH);
    if (!label) {
      // 模型偶尔产出 {"label": ""}
      dropped.push("没有文字的选项");
      continue;
    }

    // id 缺失时按位置补一个确定性的短标识 —— 它不是内容，是作答回填的键，
    // 缺了界面就没法把「用户点了哪个」说清楚。补它不等于替模型编答案。
    const id = (clean(option.id) || `opt${index + 1}`).slice(0, 8);
    if (seenIds.has(id)) {
      // id 是回填键，重复会让回填产生歧义
      dropped.push(`「${label}」（id 与前面的选项重复）`);
      continue;
    }

    // 直接回答「高度雷同的选项」：「是」/「是的」/「确定」
    const twin = kept.find((k) => isDuplicateOption(k.label, label));
    if (twin) {
      dropped.push(`「${label}」（与「${twin.label}」是同一个意思）`);
      continue;
    }

    seenIds.add(id);
    kept.push({ id, label, impact: clean(option.impact).slice(0, MAX_OPTION_IMPACT_LENGTH) });
  }

  // 一个选项不构成选择
  if (kept.length < 2) {
    if (kept.length === 1) dropped.push(`「${kept[0].label}」（只有这一个选项，不成其为选择）`);
    return { question: null, options: [], dropped };
  }

  // --- 问题本身 ---
  let question: string | null = clean(raw.question).slice(0, MAX_QUESTION_LENGTH) || null;
  if (question && textSimilarity(question, title) >= QUESTION_ECHOES_TITLE_THRESHOLD) {
    // 「问题」不能是原问题的复述 —— 那等于没问
    dropped.push(`问题「${question}」（只是在复述事项标题）`);
    question = null;
  }
  if (!question) {
    // 没有问句的选项是悬空的：界面无法呈现「一个没有问题的选择」。
    // 两者一起清空，退回旧交互。
    if (kept.length > 0) dropped.push("选项（没有配套的问题）");
    return { question: null, options: [], dropped };
  }

  return { question, options: kept, dropped };
}

/**
 * 读侧解析：一行存库的 question + options_json → 可渲染的问题。
 *
 * 坏 JSON 一律当作没有 —— 与 parseRemediation 同一条纪律：界面不该因为一行
 * 脏数据整页崩掉，最多是这条事项退回旧交互。
 */
export function parseQuestion(
  question: string | null | undefined,
  optionsJson: string | null | undefined,
): ReviewQuestion {
  const text = (question ?? "").trim();
  if (!text) return { question: null, options: [] };

  let options: ReviewOption[] = [];
  if (optionsJson) {
    try {
      const parsed = JSON.parse(optionsJson) as unknown;
      if (Array.isArray(parsed)) {
        options = parsed
          .filter((item): item is ReviewOption => {
            if (!item || typeof item !== "object") return false;
            const candidate = item as Partial<ReviewOption>;
            return Boolean(clean(candidate.id) && clean(candidate.label));
          })
          .slice(0, MAX_OPTIONS)
          .map((item) => ({
            id: clean(item.id).slice(0, 8),
            label: clean(item.label).slice(0, MAX_OPTION_LABEL_LENGTH),
            impact: clean(item.impact).slice(0, MAX_OPTION_IMPACT_LENGTH),
          }));
      }
    } catch {
      options = [];
    }
  }

  // 落库前已经过 normalizeQuestion，这里只需要防脏数据：少于两个选项等于没有
  if (options.length < 2) return { question: text.slice(0, MAX_QUESTION_LENGTH), options: [] };
  return { question: text.slice(0, MAX_QUESTION_LENGTH), options };
}

/**
 * 用户答复的归一化。
 *
 * 两种来源互斥：点了某个选项（choiceId 有值，answer 是那个选项的 label），
 * 或者自由输入（choiceId 为 null）。选中项不存在时**降级为自由输入**而不是
 * 拒绝 —— 选项可能在这期间被重新生成过，用户的意图还在那句话里。
 */
export function normalizeAnswer(input: {
  answer?: string | null;
  choiceId?: string | null;
  options: ReviewOption[];
}): { answer: string; choiceId: string | null; source: "option" | "freeform" } | null {
  const chosen = input.choiceId ? input.options.find((o) => o.id === input.choiceId) : undefined;
  const text = clean(chosen ? chosen.label : input.answer).slice(0, MAX_ANSWER_LENGTH);
  if (!text) return null;
  return { answer: text, choiceId: chosen?.id ?? null, source: chosen ? "option" : "freeform" };
}

/**
 * 两个选项是不是同一个意思。
 *
 * 为什么不能只用 bigram 相似度：它对**短文本**几乎失效 —— 「是」的字符二元组
 * 集合是 {"是"}、「是的」是 {"是的"}，交集为 0，相似度算出来是 0。
 * （textSimilarity 在长度 1 时会退化成整串入集合，跨长度就完全对不上。）
 *
 * 那为什么短选项不干脆用「包含关系」补？因为试过，它错得更离谱：
 * 「不是」包含「是」，两个字面相反的答案会被判成同一个，然后**有效选项被删掉**。
 *
 * 所以规则按「误判的代价」来定：
 *   · 短选项（≤ 6 字）只认**完全相同**。漏判只是让界面上多出一个近义选项，
 *     用户仍然能分辨、能选；误判却是把一个真实存在的选项从用户眼前拿掉。
 *     两者的代价不对称，所以宁可漏。
 *   · 长选项才交给相似度 —— 句子够长时 bigram 才有区分力，0.6 这个阈值也才站得住。
 */
function isDuplicateOption(a: string, b: string): boolean {
  const width = (text: string) => text.replace(/[\s，。！？、；：""''（）]/g, "").length;
  if (width(a) <= 6 && width(b) <= 6) {
    return normalizeForCompare(a) === normalizeForCompare(b);
  }
  return textSimilarity(a, b) >= OPTION_DUPLICATE_THRESHOLD;
}

/** 比对前抹掉空白与中文标点：「是」与「是。」是同一个答案 */
function normalizeForCompare(text: string): string {
  return text.replace(/[\s，。！？、；：""''（）]/g, "").toLowerCase();
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
