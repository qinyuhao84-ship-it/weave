import { describe, it, expect, beforeEach } from "vitest";
import { buildWikilinkTable } from "@/lib/index/wikilink-table";
import { reindexAll } from "@/lib/index/reindex";
import { getDb, dropAllIndexTables } from "@/lib/db/client";
import { redirects } from "@/lib/db/schema";
import { resetVault, writePage, frontmatterFor } from "./helpers";

/**
 * 双链解析表。
 *
 * 这张表决定「回答里的 [[X]] 点不点得动」，而它的正确性标准只有一个：
 * **与索引器同规则**（title > slug > alias）。两边一旦分叉，就会出现
 * 「索引认为这条链接是死的，界面却渲染成能点的胶囊」这种自相矛盾。
 */

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
});

describe("buildWikilinkTable —— 名字到词条", () => {
  it("标题与 slug 都进表", () => {
    writePage("suan-lu", frontmatterFor("01A", "算路科技", { slug: "suan-lu" }), "正文", "entity");
    reindexAll();

    const table = buildWikilinkTable();
    expect(table["算路科技"]?.pageId).toBe("01A");
    expect(table["suan-lu"]?.pageId).toBe("01A");
  });

  it("别名进表，且不覆盖同名的标题", () => {
    writePage("a", frontmatterFor("01A", "推荐算法", { aliases: ["信息流"] }), "正文", "concept");
    writePage("b", frontmatterFor("01B", "信息流", {}), "正文", "concept");
    reindexAll();

    const table = buildWikilinkTable();
    // 别名与某个词条的标题同名时，标题赢 —— 与索引器的优先级一致
    expect(table["信息流"]?.pageId).toBe("01B");
    expect(table["推荐算法"]?.pageId).toBe("01A");
  });

  it("大小写与空白按归一化规则匹配", () => {
    writePage("mcp", frontmatterFor("01A", "MCP 协议"), "正文", "concept");
    reindexAll();

    const table = buildWikilinkTable();
    expect(table["mcp 协议"]?.pageId).toBe("01A");
  });

  it("重定向的旧名能解析到新词条 —— 改名之后老链接仍然点得动", () => {
    writePage("new-name", frontmatterFor("01A", "新名字"), "正文", "entity");
    reindexAll();

    getDb()
      .insert(redirects)
      .values({
        oldNormalized: "旧名字",
        oldRaw: "旧名字",
        newPageId: "01A",
        reason: "rename",
        createdAt: "2026-01-01T00:00:00+08:00",
      })
      .run();

    const table = buildWikilinkTable();
    expect(table["旧名字"]).toEqual({ pageId: "01A", title: "新名字" });
  });

  it("解析不出来的名字不在表里（调用方据此判断「渲染成普通文字」）", () => {
    writePage("a", frontmatterFor("01A", "算路科技"), "正文", "entity");
    reindexAll();

    expect(buildWikilinkTable()["没有这个词条"]).toBeUndefined();
  });
});
