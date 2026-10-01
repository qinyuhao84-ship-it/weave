import { describe, it, expect, beforeEach, vi } from "vitest";
import * as atomic from "@/lib/vault/atomic";
import { retrieve, searchFullText, extractTerms, toContextChunks } from "@/lib/chat/retrieve";
import { GET as searchGet } from "@/app/api/search/route";
import { answer, emptyKnowledgeBaseAnswer } from "@/lib/chat/answer";
import {
  createSession, listSessions, getMessages, renameSession, deleteSession,
  appendMessage, buildHistory, readSummary, writeSummary,
} from "@/lib/chat/sessions";
import { reindexAll } from "@/lib/index/reindex";
import { dropAllIndexTables } from "@/lib/db/client";
import { FakeProvider } from "@/lib/llm/fake";
import { saveSettings, PERSONALITY_PRESETS } from "@/lib/settings";
import { writePage, frontmatterFor, resetVault } from "./helpers";

function seedKnowledgeBase() {
  writePage("zhang-yi-ming", frontmatterFor("01ZHANG", "张一鸣", {
    aliases: ["Zhang Yiming"],
  }), "张一鸣是 [[字节跳动]] 的创始人，主导了 [[推荐算法]] 的工程化落地。");
  writePage("zi-jie", frontmatterFor("01ZIJIE", "字节跳动"), "一家科技公司，旗下有抖音与今日头条。");
  writePage("tui-jian", frontmatterFor("01REC", "推荐算法", { type: "concept" }), "推荐算法是信息过滤技术的子类，用于预测用户偏好。");
  writePage("cf", frontmatterFor("01CF", "协同过滤", { type: "concept" }), "协同过滤分为基于用户与基于物品两类。");
  reindexAll();
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetVault();
  dropAllIndexTables();
});

it("大库检索只读取命中的正文，过程按真实阶段记录并随回答保存", async () => {
  seedKnowledgeBase();
  for (let index = 0; index < 100; index++) writePage(`unrelated-${index}`, frontmatterFor(`UNRELATED${index}`, `无关条目${index}`), "与本次问题没有关系的正文。");
  reindexAll();
  const read = vi.spyOn(atomic, "readFileIfExists");
  const events: Array<{ stage: string }> = [];
  const sessionId = createSession("检索验收");
  const result = await answer({ sessionId, question: "张一鸣", provider: new FakeProvider({ responses: ["他是创始人。[ID:1]"] }), onProgress: event => events.push(event) });
  expect(read.mock.calls.length).toBeLessThan(15);
  expect(events.map(event => event.stage)).toEqual(expect.arrayContaining(["titles", "fulltext", "graph", "reading", "context", "generating", "validating"]));
  expect(result.retrieved.map(page => page.title)).toContain("张一鸣");
  const stored = getMessages(sessionId).find(message => message.id === result.messageId)!;
  expect((stored.citations as { process: unknown[] }).process).toEqual(result.process);
  vi.restoreAllMocks();
});

describe("extractTerms —— 中文没有空格，抽词要另想办法", () => {
  it("英文按单词切", () => {
    expect(extractTerms("what is RAG")).toContain("rag");
  });

  it("短中文串整体作为一个词", () => {
    expect(extractTerms("推荐算法")).toContain("推荐算法");
  });

  it("长中文串按 2/3/4 字滑窗", () => {
    const terms = extractTerms("协同过滤的基本原理");
    expect(terms).toContain("协同过滤");
    expect(terms).toContain("基本");
    expect(terms).toContain("原理");
  });

  it("中英混排", () => {
    const terms = extractTerms("Transformer 架构");
    expect(terms).toContain("transformer");
    expect(terms).toContain("架构");
  });

  it("保留纯数字和中英数字混排查询", () => {
    expect(extractTerms("2024")).toContain("2024");
    expect(extractTerms("版本2024发布")).toContain("2024");
  });

  it("长词排在前面（更具体，优先匹配）", () => {
    const terms = extractTerms("推荐算法的协同过滤实现");
    expect([...terms[0]].length).toBeGreaterThanOrEqual(2);
  });

  it("空查询返回空", () => {
    expect(extractTerms("   ")).toEqual([]);
  });
});

describe("searchFullText —— FTS5 中文检索", () => {
  beforeEach(() => seedKnowledgeBase());

  it("中文长词能检索到", () => {
    const results = searchFullText("推荐算法", 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it("中文短词走 LIKE 兜底 —— trigram 需要 3 个字符以上", () => {
    // 「算法」是 2 个字，trigram 匹配不到，必须靠 LIKE
    const results = searchFullText("算法", 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it("英文能检索到", () => {
    writePage("tf", frontmatterFor("01TF", "Transformer", { type: "concept" }), "attention is all you need");
    reindexAll();
    expect(searchFullText("attention", 5).length).toBeGreaterThan(0);
  });

  it("纯数字能检索正文", () => {
    writePage("version", frontmatterFor("01VERSION", "模型版本"), "版本 2024 正式发布。编号 7 已停用。");
    reindexAll();
    expect(searchFullText("2024", 5).map((hit) => hit.pageId)).toContain("01VERSION");
    expect(searchFullText("7", 5).map((hit) => hit.pageId)).toContain("01VERSION");
  });

  it("搜索接口优先返回标题精确命中的词条", async () => {
    writePage("extra", frontmatterFor("01EXTRA", "推荐系统"), "推荐算法 推荐算法 推荐算法。");
    reindexAll();
    const response = await searchGet(new Request("http://localhost/api/search?q=推荐算法"));
    const payload = await response.json();
    expect(payload.data.results[0].title).toBe("推荐算法");
  });

  it("搜索接口能返回纯数字命中的词条", async () => {
    writePage("version", frontmatterFor("01VERSION", "模型版本"), "版本号 2024。");
    reindexAll();
    const response = await searchGet(new Request("http://localhost/api/search?q=2024"));
    const payload = await response.json();
    expect(payload.data.results.some((item: { title: string }) => item.title === "模型版本")).toBe(true);
  });

  it("无结果的查询返回空数组而不是报错", () => {
    expect(searchFullText("完全不存在的词xyzzy", 5)).toEqual([]);
  });
});

describe("retrieve —— 检索路径", () => {
  beforeEach(() => seedKnowledgeBase());

  it("标题命中优先", () => {
    const results = retrieve("张一鸣");
    expect(results[0].title).toBe("张一鸣");
    expect(results[0].matchedBy).toBe("title");
  });

  it("通过别名也能命中", () => {
    const results = retrieve("Zhang Yiming");
    expect(results.some((r) => r.title === "张一鸣")).toBe(true);
  });

  it("正文关键词命中", () => {
    const results = retrieve("信息过滤技术的子类");
    expect(results.some((r) => r.title === "推荐算法")).toBe(true);
  });

  it("图谱扩展把关联词条也带进来 —— 这是 wiki 相对普通检索的价值", () => {
    const results = retrieve("张一鸣");
    // 张一鸣的词条里引用了字节跳动，一跳邻居应当被带进来
    expect(results.length).toBeGreaterThan(1);
  });

  it("返回的内容不含 frontmatter", () => {
    const results = retrieve("张一鸣");
    expect(results[0].content).not.toContain("---");
    expect(results[0].content).not.toContain("id:");
  });

  it("结果数量受 limit 约束", () => {
    expect(retrieve("算法", { limit: 2 }).length).toBeLessThanOrEqual(2);
  });

  it("字符预算约束生效", () => {
    const results = retrieve("张一鸣", { limit: 10, charBudget: 50 });
    expect(results.reduce((sum, page) => sum + page.content.length, 0)).toBeLessThanOrEqual(50);
  });

  it("空知识库返回空", () => {
    resetVault();
    dropAllIndexTables();
    expect(retrieve("任何问题")).toEqual([]);
  });
});

describe("toContextChunks —— 编号即位置", () => {
  beforeEach(() => seedKnowledgeBase());

  it("编号从 1 开始且连续", () => {
    const chunks = toContextChunks(retrieve("张一鸣"));
    expect(chunks[0].index).toBe(1);
    chunks.forEach((chunk, i) => expect(chunk.index).toBe(i + 1));
  });

  it("带上页码与来源文档，供引用跳转", () => {
    const chunks = toContextChunks(retrieve("张一鸣"));
    expect(chunks[0]).toHaveProperty("sourcePage");
    expect(chunks[0]).toHaveProperty("sourceDoc");
  });
});

describe("answer —— 完整问答流程", () => {
  beforeEach(() => {
    seedKnowledgeBase();
    saveSettings({
      providers: [{
        id: "test", label: "测试", baseUrl: "http://localhost", apiKey: "test",
        model: "test", lightModel: "", supportsStrictSchema: false,
        temperature: 0.3, reasoningEffort: "high", headers: {}, contextWindow: 1_000_000,
      }],
      activeProviderId: "test",
    });
  });

  it("流式产出文本并落库", async () => {
    const provider = new FakeProvider({
      responses: ["张一鸣是字节跳动的创始人 [ID:1]。"],
    });
    const sessionId = createSession();
    appendMessage({ sessionId, role: "user", content: "张一鸣是谁？" });

    const result = await answer({ sessionId, question: "张一鸣是谁？", provider });

    expect(result.text).toContain("张一鸣");
    expect(result.messageId).toBeTruthy();
    expect(getMessages(sessionId)).toHaveLength(2);
  });

  it("增量回调被逐个触发 —— 前端据此做流式渲染", async () => {
    const provider = new FakeProvider({ responses: ["一段比较长的回答内容用于测试流式分片。"] });
    const sessionId = createSession();
    const deltas: string[] = [];

    await answer({ sessionId, question: "问题", provider, onDelta: (t) => deltas.push(t) });

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toContain("流式分片");
  });

  it("检索完成时回调，前端可以先展示命中词条", async () => {
    const provider = new FakeProvider({ responses: ["答案 [ID:1]。"] });
    const sessionId = createSession();
    let retrievedCount = 0;

    await answer({
      sessionId, question: "张一鸣", provider,
      onRetrieved: (pages) => { retrievedCount = pages.length; },
    });

    expect(retrievedCount).toBeGreaterThan(0);
  });

  it("越界引用被剔除，幻觉率被记录", async () => {
    const provider = new FakeProvider({
      responses: ["张一鸣是创始人 [ID:1]，另外这一点 [ID:99] 也有依据。"],
    });
    const sessionId = createSession();

    const result = await answer({ sessionId, question: "张一鸣是谁？", provider });

    expect(result.text).not.toContain("[ID:99]");
    expect(result.quality.hallucinationCount).toBe(1);
    expect(result.quality.hallucinationRate).toBeGreaterThan(0);
  });

  it("引用被映射成可跳转的实体", async () => {
    const provider = new FakeProvider({ responses: ["张一鸣是创始人 [ID:1]。"] });
    const sessionId = createSession();

    const result = await answer({ sessionId, question: "张一鸣是谁？", provider });

    expect(result.citations.length).toBe(result.quality.citationCount);
    if (result.citations.length > 0) {
      expect(result.citations[0].pageId).toBeTruthy();
      expect(result.citations[0].pageTitle).toBeTruthy();
    }
  });

  it("system prompt 被注入为第一条消息，且包含防注入规则", async () => {
    const provider = new FakeProvider({ responses: ["答案"] });
    const sessionId = createSession();

    await answer({ sessionId, question: "问题", provider });

    const messages = provider.calls[0].messages;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("不能透露");
    expect(messages[0].content).toContain("内容边界");
    expect(messages[0].content).toContain("<context>");
  });

  it("上下文里有检索到的词条，并被包在 <context> 里", async () => {
    const provider = new FakeProvider({ responses: ["答案 [ID:1]"] });
    const sessionId = createSession();

    await answer({ sessionId, question: "张一鸣", provider });

    const lastMessage = provider.calls[0].messages.at(-1)!;
    expect(lastMessage.content).toContain("<context>");
    expect(lastMessage.content).toContain("张一鸣");
    expect(lastMessage.content).toContain("# 用户的问题");
  });

  it("个性化设置被翻译成 prompt 里的具体约束", async () => {
    saveSettings({
      personality: { tone: "casual", style: "socratic", emoji: "none", address: "秦小" },
    });
    const provider = new FakeProvider({ responses: ["答案"] });
    const sessionId = createSession();

    await answer({ sessionId, question: "问题", provider });

    const system = provider.calls[0].messages[0].content;
    expect(system).toContain("秦小");
    expect(system).toContain("emoji");
    expect(system).toContain("追问");
  });

  it("七档语气各进 prompt，且引用规则始终优先于语气", async () => {
    // 毒舌与幽默最容易让模型为了效果省掉引用编号。引用本身由后端回填校验，
    // 但模型漏写 [ID:n] 就等于论断失去了可核查的来源 —— 这条断言守住那条优先级。
    // 语气列表写死在这里是有意的：枚举一变，这个文件就编译不过，逼着一起更新。
    const TONES = ["rigorous", "plain", "casual", "gentle", "sassy", "humorous", "mentor"] as const;
    const KEYWORD: Record<(typeof TONES)[number], string> = {
      rigorous: "标注不确定性",
      plain: "像跟同事聊天",
      casual: "可以用比喻",
      gentle: "语气柔和",
      sassy: "直言不讳",
      humorous: "准确优先于好笑",
      mentor: "多问一句",
    };

    // 界面选项必须与枚举一一对应，少一个用户就永远选不到
    expect(PERSONALITY_PRESETS.tone.options.map((option) => option.value).sort()).toEqual(
      [...TONES].sort(),
    );

    for (const tone of TONES) {
      saveSettings({ personality: { tone } });
      const provider = new FakeProvider({ responses: ["答案"] });
      await answer({ sessionId: createSession(), question: "问题", provider });

      const system = provider.calls[0].messages[0].content;
      expect(system, `语气 ${tone} 没有进 prompt`).toContain(KEYWORD[tone]);
      expect(system, `语气 ${tone} 下缺少「引用优先于语气」的声明`).toContain("优先于任何语气");
    }
  });

  it("无答案设置影响 prompt 里的兜底指令", async () => {
    saveSettings({ personality: { noAnswer: "admit" } });
    const provider = new FakeProvider({ responses: ["答案"] });
    const sessionId = createSession();
    await answer({ sessionId, question: "问题", provider });
    expect(provider.calls[0].messages[0].content).toContain("不要给出任何推测");

    saveSettings({ personality: { noAnswer: "infer" } });
    const provider2 = new FakeProvider({ responses: ["答案"] });
    const sessionId2 = createSession();
    await answer({ sessionId: sessionId2, question: "问题", provider: provider2 });
    expect(provider2.calls[0].messages[0].content).toContain("以下是我的推测");
  });

  it("多轮对话带上历史上下文", async () => {
    const sessionId = createSession();
    appendMessage({ sessionId, role: "user", content: "张一鸣是谁？" });
    appendMessage({ sessionId, role: "assistant", content: "他是字节跳动的创始人 [ID:1]。" });

    const provider = new FakeProvider({ responses: ["答案"] });
    await answer({ sessionId, question: "那字节跳动呢？", provider });

    const messages = provider.calls[0].messages;
    expect(messages.some((m) => m.content.includes("他是字节跳动的创始人"))).toBe(true);
  });

  it("历史消息里的引用标记被剥掉，避免污染模型", async () => {
    const sessionId = createSession();
    appendMessage({ sessionId, role: "assistant", content: "结论 [ID:1][ID:2]。" });

    const provider = new FakeProvider({ responses: ["答案"] });
    await answer({ sessionId, question: "追问", provider });

    const history = provider.calls[0].messages.find(
      (m) => m.role === "assistant" && m.content.includes("结论"),
    );
    expect(history).toBeTruthy();
    expect(history!.content).not.toContain("[ID:");
  });

  it("知识库为空时给出可操作的提示，而不是编造", () => {
    expect(emptyKnowledgeBaseAnswer()).toContain("先导入一份资料");
  });
});

describe("会话管理", () => {
  it("创建会话", () => {
    const id = createSession();
    expect(getMessages(id)).toEqual([]);
  });

  it("首条用户消息成为会话标题", () => {
    const sessionId = createSession();
    appendMessage({ sessionId, role: "user", content: "张一鸣的推荐算法是怎么落地的？" });
    expect(listSessions()[0].title).toContain("张一鸣");
  });

  it("重命名会话", () => {
    const sessionId = createSession();
    renameSession(sessionId, "关于推荐算法的讨论");
    expect(listSessions()[0].title).toBe("关于推荐算法的讨论");
  });

  it("空标题回落到默认名", () => {
    const sessionId = createSession();
    renameSession(sessionId, "   ");
    expect(listSessions()[0].title).toBe("未命名对话");
  });

  it("删除会话连同其消息", () => {
    const sessionId = createSession();
    appendMessage({ sessionId, role: "user", content: "问题" });
    deleteSession(sessionId);
    expect(listSessions()).toHaveLength(0);
    expect(getMessages(sessionId)).toEqual([]);
  });

  it("会话按更新时间倒序", () => {
    const first = createSession("旧会话");
    createSession("新会话");
    appendMessage({ sessionId: first, role: "user", content: "更新一下" });
    expect(listSessions()[0].id).toBe(first);
  });

  it("没有摘要时历史不被腰斩 —— 收窄历史是压缩的职责，不是固定窗口的职责", () => {
    // 这条守住一个很容易写出来的设计错误：给逐字历史设一个固定的轮数上限。
    // 那样一来，被上限挤出去的消息既没进摘要、又没进 prompt，凭空消失 ——
    // 而压缩要等到 85% 才发生，中间一大段区间完全没有保护。
    const sessionId = createSession();
    for (let i = 0; i < 20; i++) {
      appendMessage({ sessionId, role: "user", content: `问题${i}` });
      appendMessage({ sessionId, role: "assistant", content: `回答${i}` });
    }
    const history = buildHistory(sessionId);
    expect(history.summary).toBeNull();
    expect(history.messages).toHaveLength(40);
    expect(history.messages[0].content).toContain("问题0");
    expect(history.messages.at(-1)!.content).toContain("回答19");
  });

  it("按 message id 排除本轮提问，而不是按内容比较", () => {
    const sessionId = createSession();
    appendMessage({ sessionId, role: "user", content: "同一句话" });
    appendMessage({ sessionId, role: "assistant", content: "第一次的回答" });
    const current = appendMessage({ sessionId, role: "user", content: "同一句话" });

    // 用户把同一句话问了两遍：按内容排除会连上一次那条一起删掉
    const history = buildHistory(sessionId, { excludeMessageId: current });
    expect(history.messages.map((m) => m.content)).toEqual(["同一句话", "第一次的回答"]);
  });

  it("已摘要条数只算真的进过 prompt 的消息 —— 空白消息不算被摘要覆盖", () => {
    // 摘要的输入就是「会进 prompt 的那些消息」，所以水位线之前的空白消息
    // （被过滤掉、从没喂给摘要器）不该计进这个数。先切分再过滤会把它算进去，
    // 界面上就会出现一个比事实大的「已摘要 N 条」，还和同一块面板里的
    // coveredMessageCount 对不上。
    const sessionId = createSession();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(appendMessage({ sessionId, role: i % 2 === 0 ? "user" : "assistant", content: `第${i}条内容` }));
      if (i === 3) appendMessage({ sessionId, role: "assistant", content: "   " });
    }
    // 水位线落在 ids[5] 上：它之前有 6 条消息，其中一条是空白
    writeSummary({
      sessionId, content: "一份足够长的摘要，覆盖了前面这些轮次的对话内容。",
      coveredToMessageId: ids[5], coveredMessageCount: 6,
      compressionCount: 1, tokenCount: 30, model: "fake",
    });

    const history = buildHistory(sessionId);
    expect(history.summarizedCount).toBe(6);
    // 水位线之后的消息逐字保留，空白那条也不在
    expect(history.messages.map((m) => m.content)).toEqual([
      "第6条内容", "第7条内容", "第8条内容", "第9条内容",
    ]);
  });

  it("历史里的引用标记被剥掉，摘要水位线之后的消息才逐字保留", () => {
    const sessionId = createSession();
    appendMessage({ sessionId, role: "user", content: "第一问" });
    appendMessage({ sessionId, role: "assistant", content: "第一答 [ID:1]" });
    appendMessage({ sessionId, role: "user", content: "第二问" });
    appendMessage({ sessionId, role: "assistant", content: "第二答" });

    const history = buildHistory(sessionId);
    expect(history.messages[1].content).not.toContain("[ID:");
    expect(history.summarizedCount).toBe(0);
    expect(readSummary(sessionId)).toBeNull();
  });
});
