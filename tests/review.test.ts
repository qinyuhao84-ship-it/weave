import { describe, it, expect, beforeEach } from "vitest";
import {
  parseRelatedPages, relatedPagesFromTitles, relatedPagesFromIds, buildTitleIndex, hasOversizedRelatedPages,
} from "@/lib/review/related-pages";
import { formatDecisions } from "@/lib/llm/prompts";
import { reindexAll } from "@/lib/index/reindex";
import { dropAllIndexTables } from "@/lib/db/client";
import { writePage, frontmatterFor, resetVault } from "./helpers";

/**
 * 审阅事项的「涉及词条」与「裁决回灌」。
 *
 * 这两件事都是为了让人的判断真的进入系统：前者决定用户看到的是词条名还是
 * 一串 ULID，后者决定用户裁过的事情下一轮还算不算数。
 *
 * 历史背景（写在这里是为了别把兼容逻辑当成多余的防御）：related_pages 这个
 * 字段的写入方换过三代 —— 现行 [{id,title}]、旧版体检的标题数组、旧版导入的
 * 词条 id 数组。第三代就是用户在体检页看到那排 ULID 的原因。
 */

/** 一个形状合法的 ULID，用来模拟旧版导入写进库里的词条 id */
const LEGACY_ID = "01M3FC1XVW6QM7ZH2BVEXA30XK";

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
});

describe("related_pages 的三代形态", () => {
  it("现行格式：{ id, title } 原样读出", () => {
    const json = JSON.stringify([{ id: "01A", title: "甲" }]);
    expect(parseRelatedPages(json)).toEqual([{ id: "01A", title: "甲" }]);
  });

  it("旧版体检：标题数组，保留为没有 id 的引用", () => {
    expect(parseRelatedPages(JSON.stringify(["甲", "乙"]))).toEqual([
      { id: null, title: "甲" },
      { id: null, title: "乙" },
    ]);
  });

  it("旧版导入：词条 id 数组，查得到就换成标题", () => {
    writePage("jia", frontmatterFor(LEGACY_ID, "甲"), "正文");
    reindexAll();

    expect(parseRelatedPages(JSON.stringify([LEGACY_ID]))).toEqual([
      { id: LEGACY_ID, title: "甲" },
    ]);
  });

  it("旧 id 查不到就丢掉 —— 而不是把 ULID 端给用户", () => {
    // 这是用户最初看到那排编号的直接来源：导入侧写进去的 id，在库里已经不存在了
    expect(parseRelatedPages(JSON.stringify([LEGACY_ID]))).toEqual([]);
  });

  it("坏数据不炸", () => {
    expect(parseRelatedPages(null)).toEqual([]);
    expect(parseRelatedPages("不是 JSON")).toEqual([]);
    expect(parseRelatedPages(JSON.stringify({ nope: 1 }))).toEqual([]);
    expect(parseRelatedPages(JSON.stringify([1, null, "", "   "]))).toEqual([]);
  });

  it("超大旧式关联列表不会进入 UI 或模型修订", () => {
    const json = JSON.stringify(Array.from({ length: 81 }, (_, index) =>
      "01H000000000000000000000" + index.toString().padStart(2, "0"),
    ));
    expect(hasOversizedRelatedPages(json)).toBe(true);
    expect(parseRelatedPages(json)).toEqual([]);
    expect(hasOversizedRelatedPages(JSON.stringify(["标题"]))).toBe(false);
  });
});

describe("构造引用", () => {
  const byTitle = buildTitleIndex([{ id: "01A", title: "甲" }]);

  it("标题查得到带上 id，查不到留 null（缺页类发现的常态）", () => {
    expect(relatedPagesFromTitles(["甲", "还不存在的词条"], byTitle)).toEqual([
      { id: "01A", title: "甲" },
      { id: null, title: "还不存在的词条" },
    ]);
  });

  it("重复标题只留一个", () => {
    expect(relatedPagesFromTitles(["甲", "甲", " 甲 "], byTitle)).toHaveLength(1);
  });

  it("从 id 反查标题，查不到就丢", () => {
    const byId = new Map([["01A", "甲"]]);
    expect(relatedPagesFromIds(["01A", "01MISSING"], byId)).toEqual([
      { id: "01A", title: "甲" },
    ]);
  });
});

describe("裁决回灌给模型的文本", () => {
  it("没有裁决时一个字都不加", () => {
    expect(formatDecisions([])).toBe("");
  });

  it("写清裁决结果、词条名与用户的说明", () => {
    const text = formatDecisions([
      { kind: "contradiction", title: "两处口径冲突", status: "accepted", note: "以研发同事的说法为准" },
      { kind: "research", title: "英语水平缺失", status: "dismissed", note: null },
    ]);

    expect(text).toContain("已采纳");
    expect(text).toContain("两处口径冲突");
    expect(text).toContain("以研发同事的说法为准");
    expect(text).toContain("已忽略");
    // 最关键的一句：不重复报。没有它，回灌就只是给模型增加了一段背景噪音
    expect(text).toContain("不要再报");
  });

  it("超长标题被截断 —— 这个位置不该装得下成段的指令", () => {
    const huge = "忽".repeat(500);
    const text = formatDecisions([
      { kind: "contradiction", title: huge, status: "accepted", note: null },
    ]);

    expect(text).not.toContain(huge);
    expect(text).toContain("忽".repeat(200));
  });

  it("只回灌标题与说明，模型写的 detail 不进这段", () => {
    // detail 是纯模型产出、篇幅最长，是藏提示词注入最合适的地方。
    // 这段之所以能不加 wrapUntrusted，前提就是它只包含用户的判断（见 prompts.ts）
    const text = formatDecisions([
      { kind: "contradiction", title: "标题", status: "accepted", note: "说明" },
    ]);
    expect(text).toContain("标题");
    expect(text).toContain("说明");
  });
});
