import { NO_ANSWER_PHRASE, type ContextChunk } from "@/lib/llm/prompts";

/**
 * ============================================================================
 * 引用校验 —— 控制幻觉最要紧的一环
 * ============================================================================
 *
 * 核心判断：**只让模型写引用编号，原文由后端补齐**。
 * 让模型自己复制原文片段，既慢又贵，而且引入一个全新的幻觉面（它会改写原文）。
 *
 * 处理链分三步，每一步都对应一类真实的模型行为：
 *
 *   1. **坏格式修复**：模型会稳定地产出多种畸形引用 —— (ID:12)、[ID: 12]、
 *      【ID: 12】、ref12、(**ID:5**)。不做修复的话，这些既点不开也校验不了，
 *      等于引用白写了。
 *   2. **范围展开**：[ID:1-3] 无法解析到单一来源，必须展开成三个独立标记。
 *   3. **白名单校验**：编号必须落在本次检索到的片段范围内。
 *      越界 = 模型编造了一个不存在的来源，这是最典型的幻觉引用。
 *
 * 一个反直觉但重要的细节：**裸角标 [5] 必须保留**。
 * 它可能只是脚注、版本号或年份，删掉会破坏用户可见的正文；
 * 而带 ID: 前缀的标记如果解析不到就必须删 —— 因为它明确声称是个引用，
 * 点不开会让用户以为是自己操作错了。
 */

/** 能识别的引用标记形态（按优先级从高到低） */
const CITATION_PATTERNS: RegExp[] = [
  // 标准形态： [ID:1]  [ID: 1]
  /\[\s*ID\s*[:：]\s*(\d+)\s*\]/gi,
  // 全角方括号： 【ID:1】
  /【\s*ID\s*[:：]\s*(\d+)\s*】/gi,
  // 圆括号： (ID:1)
  /\(\s*ID\s*[:：]\s*(\d+)\s*\)/gi,
  // 带 markdown 强调： (**ID:5**)
  /\(\s*\*{1,2}\s*ID\s*[:：]\s*(\d+)\s*\*{1,2}\s*\)/gi,
  // ref 前缀： ref12、[ref12]
  /\[?\s*ref\s*[:：]?\s*(\d+)\s*\]?/gi,
];

/** 范围形态：[ID:1-3] 或 [ID:1~3] */
const RANGE_PATTERN = /\[\s*ID\s*[:：]\s*(\d+)\s*[-–~至]\s*(\d+)\s*\]/gi;

export type ParsedCitation = {
  /** 编号（1-based，对应上下文里的 ID） */
  index: number;
  /** 在答案里的原始文本 */
  raw: string;
  start: number;
  end: number;
  valid: boolean;
};

export type ValidationReport = {
  /** 修复后的答案（坏格式已归一、越界引用已剔除） */
  text: string;
  /** 通过校验的编号，去重且有序 */
  usedIndices: number[];
  /** 越界被剔除的编号 —— 这些是幻觉引用，应当记录并纳入质量指标 */
  hallucinatedIndices: number[];
  /** 修复了多少处坏格式 */
  repairedCount: number;
  /** 模型是否声称知识库里没有答案 */
  isNoAnswer: boolean;
};

/**
 * 第一步：范围展开。必须在校验之前做，否则 [ID:1-3] 会被当成无效标记删掉，
 * 而它其实是模型在正确引用三个来源。
 */
export function expandRanges(text: string, maxIndex: number): { text: string; expanded: number } {
  let expanded = 0;
  const result = text.replace(RANGE_PATTERN, (_match, from: string, to: string) => {
    const start = Number(from);
    const rawEnd = Number(to);
    if (!Number.isFinite(start) || !Number.isFinite(rawEnd) || rawEnd < start) return _match;

    // 先按上下文长度裁剪，再判断规模。
    // 顺序很重要：模型常见的行为是写出 [ID:1-99] 这种远超实际片段数的范围
    // （它在表达"这些都支持我"），裁剪后就是合法的 [ID:1..3]。
    // 如果先判断规模就会把这种正常意图误当成异常输入丢掉。
    const end = Math.min(rawEnd, maxIndex);
    // 裁剪后仍然过大，说明是异常输入（或上下文本身极长），防御性放弃展开
    if (end - start > 20 || end < start) return _match;

    expanded++;
    const parts: string[] = [];
    for (let i = start; i <= end; i++) parts.push(`[ID:${i}]`);
    return parts.join("");
  });
  return { text: result, expanded };
}

/** 第二步：收集所有引用标记（含坏格式） */
export function collectCitations(text: string): ParsedCitation[] {
  const found = new Map<string, ParsedCitation>();

  for (const pattern of CITATION_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const key = `${start}:${end}`;
      // 同一位置已被更早（更精确）的规则命中就跳过，避免重复计数
      if (found.has(key)) continue;
      if ([...found.values()].some((c) => c.start < end && c.end > start)) continue;
      found.set(key, {
        index: Number(match[1]),
        raw: match[0],
        start,
        end,
        valid: false,
      });
    }
  }

  return [...found.values()].sort((a, b) => a.start - b.start);
}

/**
 * 主入口：校验并净化答案里的引用。
 *
 * chunks 是本次真正检索到的上下文。任何不在这份清单里的编号都是编造的。
 */
export function validateCitations(
  answer: string,
  chunks: ContextChunk[],
): ValidationReport {
  const maxIndex = Math.max(0, ...chunks.map(chunk => chunk.index));
  const allowed = new Set(chunks.map((c) => c.index));

  // ① 范围展开
  const { text: expandedText } = expandRanges(answer, maxIndex);

  // ② 收集与判定
  const citations = collectCitations(expandedText);
  const usedIndices = new Set<number>();
  const hallucinated = new Set<number>();
  let repairedCount = 0;

  for (const citation of citations) {
    if (allowed.has(citation.index)) {
      citation.valid = true;
      usedIndices.add(citation.index);
    } else {
      citation.valid = false;
      hallucinated.add(citation.index);
    }
    // 不是标准 [ID:n] 形态的都记一次修复
    if (citation.raw !== `[ID:${citation.index}]`) repairedCount++;
  }

  // ③ 从后往前替换：这样前面标记的偏移量不会因为文本长度变化而失效
  let result = expandedText;
  for (let i = citations.length - 1; i >= 0; i--) {
    const citation = citations[i];
    const replacement = citation.valid ? `[ID:${citation.index}]` : "";
    if (citation.raw !== replacement) {
      result = result.slice(0, citation.start) + replacement + result.slice(citation.end);
    }
  }

  // 清理因删除引用而留下的空括号与多余空格
  result = result
    .replace(/\(\s*\)/g, "")
    .replace(/（\s*）/g, "")
    .replace(/【\s*】/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([，。、；：！？])/g, "$1")
    .trim();

  return {
    text: result,
    usedIndices: [...usedIndices].sort((a, b) => a - b),
    hallucinatedIndices: [...hallucinated].sort((a, b) => a - b),
    repairedCount,
    isNoAnswer: detectNoAnswer(result),
  };
}

/**
 * 判断模型是否在说「知识库里没有」。
 *
 * 匹配前必须剥离引用标记与空白 —— 模型可能在句中插标记（如「因 [ID:3]此」），
 * 把关键词切开导致漏判。这是生产实现里踩过的坑。
 */
export function detectNoAnswer(text: string): boolean {
  const stripped = text
    .replace(/\[\s*ID\s*[:：]\s*\d+\s*\]/gi, "")
    .replace(/[\s　]+/g, "");
  const needle = NO_ANSWER_PHRASE.replace(/[\s　]+/g, "").replace(/。$/, "");
  return stripped.includes(needle);
}

/* ------------------------------------------------------------ 输出结构 */

export type CitationView = {
  index: number;
  pageId: string;
  pageTitle: string;
  pagePath: string;
  pageType: string;
  /** 原文页码，用于「跳转到原文第 N 页」 */
  sourcePage: number | null;
  sourceDoc: string | null;
  /** 当前检索命中的 wiki 正文片段；编号校验不代表语义蕴含验证 */
  excerpt: string;
  sourceRefs: NonNullable<ContextChunk["sourceRefs"]>;
};

/** 把校验通过的编号映射回具体的引用信息，供前端渲染角标与来源列表 */
export function buildCitationViews(
  usedIndices: number[],
  chunks: ContextChunk[],
  retrievedIds: string[],
): CitationView[] {
  const byIndex = new Map(chunks.map((c) => [c.index, c]));
  return usedIndices
    .map((index) => {
      const chunk = byIndex.get(index);
      if (!chunk) return null;
      const position = chunks.findIndex((c) => c.index === index);
      return {
        index,
        pageId: retrievedIds[position] ?? "",
        pageTitle: chunk.pageTitle,
        pagePath: chunk.pagePath,
        pageType: chunk.pageType,
        sourcePage: chunk.sourcePage,
        // 保留原始相对路径供旧调用方使用；显示名称由 sourceRefs 提供。
        sourceDoc: chunk.sourceDoc,
        excerpt: chunk.content.slice(0, 400),
        sourceRefs: chunk.sourceRefs ?? [],
      };
    })
    .filter((v): v is CitationView => v !== null);
}

/**
 * 把正文里的 [ID:n] 转成 HTML 锚点，供前端渲染成可点击角标。
 *
 * 在 Markdown 渲染之前调用；产出的 <sup> 结构会被 react-markdown 原样保留。
 */
export function renderCitationAnchors(text: string, views: CitationView[]): string {
  const byIndex = new Map(views.map((v) => [v.index, v]));
  return text.replace(/\[ID:(\d+)\]/g, (match, indexText: string) => {
    const index = Number(indexText);
    const view = byIndex.get(index);
    if (!view) return match;
    const title = escapeAttribute(view.pageTitle);
    const page = view.sourcePage ? ` data-source-page="${view.sourcePage}"` : "";
    return `<sup class="citation-ref" data-citation="${index}" data-page-id="${escapeAttribute(view.pageId)}"${page} title="${title}">${index}</sup>`;
  });
}

function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 回答质量指标。
 *
 * 把「引用准确率」变成可量化、可跟踪的数字 —— 否则控制幻觉这件事
 * 就只能靠感觉。hallucinationRate 是核心指标：越界引用占比，
 * 正常应该接近 0，持续高于 5% 说明检索或 prompt 出了问题。
 */
export type AnswerQuality = {
  citationCount: number;
  hallucinationCount: number;
  hallucinationRate: number;
  /** 是否压根没给出引用（可能是纯常识性回答，也可能是失败的检索） */
  hasNoCitations: boolean;
  isNoAnswer: boolean;
};

export function assessQuality(report: ValidationReport): AnswerQuality {
  const total = report.usedIndices.length + report.hallucinatedIndices.length;
  return {
    citationCount: report.usedIndices.length,
    hallucinationCount: report.hallucinatedIndices.length,
    hallucinationRate: total === 0 ? 0 : report.hallucinatedIndices.length / total,
    hasNoCitations: report.usedIndices.length === 0,
    isNoAnswer: report.isNoAnswer,
  };
}
