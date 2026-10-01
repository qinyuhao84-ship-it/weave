/**
 * 上下文预算用的 token 估算。
 *
 * 为什么不引 tokenizer：本仓对依赖一贯克制（见 CLAUDE.md 不变式 7 关于不引向量库的
 * 同一取舍），而这里的用途只需要「量级正确」—— 这是 128K 级的预算判断，差几千
 * token 不影响结论。真值优先：provider 返回的 usage.promptTokens 一旦拿到就会覆盖
 * 估算（见 lib/chat/context.ts 里 ContextUsage.measured 的说明）。
 *
 * 口径刻意**偏高**（中文 1 字算 1 token）：
 * 真实 tokenizer 对中文的切分在 0.6~1.0 token/字之间浮动（DeepSeek 系约 0.6，
 * GPT-4o 的 o200k 约 1.0），厂商之间的差异可达 1.6 倍。预算控制这个用途上，
 * 高估的代价只是提前压缩一次（可接受），低估的代价是请求超窗直接失败（不可接受）。
 * 对以中文散文为主的问答 prompt，这个函数实际是 token 数的**上界**。
 *
 * ⚠️ 本仓另有一个 lib/ingest/parse/router.ts#estimateTokens，口径是
 *    「1 token ≈ 1.5 个汉字」（偏低），给导入成本预估用 —— 那个用途宁可想得便宜
 *    一点，偏置方向与本文件相反。两者**刻意不共用、也不合并**：硬合并会逼其中一方
 *    接受错误的偏置。名字里的 Context 就是用来区分这两个口径的。
 */

/**
 * 按「一个字符 ≈ 一个 token」计价的字符区间。
 *
 * 收三段全角字符：中文标点（，。「」等 U+3000–U+303F）、CJK 基本区汉字
 * （U+4E00–U+9FFF）、全角形式（ＡＢ１２！？等 U+FF00–U+FFEF）。
 * 只收汉字是不够的 —— 中文散文里标点能占到一成多，把逗号句号按「4 字符 1 token」
 * 算会让估算整体低估一成，正好抵消掉上面刻意留出的高估余量。
 *
 * 代价：CJK 扩展区的生僻字（𠀀 之类）落在区间外，会被按 4 字符 1 token 低估。
 * 日常语料里可以忽略 —— 为它单独列区间不值得。
 */
const WIDE_CHAR = /[　-〿一-鿿＀-￯]/g;

/** 每条消息的固定开销：role 标记与分隔符。ChatML 的口径约 3~4。 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** 每次请求的固定开销：对话模板的收尾标记。 */
export const REQUEST_OVERHEAD_TOKENS = 3;

/** 估算一段文本的 token 数。向上取整 —— 预算是硬上限，宁可多算一个。 */
export function estimateContextTokens(text: string): number {
  if (!text) return 0;
  const wide = (text.match(WIDE_CHAR) ?? []).length;
  return Math.ceil(wide + (text.length - wide) / 4);
}

/** 估算一组消息的总 token 数（含每条消息与整次请求的固定开销）。 */
export function estimateMessagesContextTokens(
  messages: Array<{ content: string }>,
): number {
  let total = REQUEST_OVERHEAD_TOKENS;
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS + estimateContextTokens(message.content);
  }
  return total;
}

/**
 * 自动压缩的触发线：上下文占用达到窗口的这个比例就压缩。
 *
 * 定义在这个文件里而不是 lib/chat/context.ts，是因为**客户端也要用它** ——
 * 头部那个占用指示器要按同一个数字变色。context.ts 依赖 settings 与 db，
 * 前端 import 它会把整个数据库层拖进浏览器 bundle；tokens.ts 零依赖，可以随便引。
 * 阈值只有一处定义，改这里两边同时生效。
 */
export const COMPRESS_THRESHOLD = 0.85;

/** 超过这个比例就该提醒用户了（还没到压缩线，但已经该注意） */
export const CONTEXT_WARN_THRESHOLD = 0.6;
