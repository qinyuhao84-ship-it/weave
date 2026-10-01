import { describe, it, expect, beforeEach } from "vitest";
import { reindexAll } from "@/lib/index/reindex";
import { rebuildIndexFile } from "@/lib/index/index-file";
import { dropAllIndexTables } from "@/lib/db/client";
import { createPage, renamePage, deletePage } from "@/lib/vault/service";
import { writePage, frontmatterFor, resetVault, readPageRaw } from "./helpers";

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
});

describe("rebuildIndexFile", () => {
  it("生成按类型分组的目录", () => {
    writePage("a", frontmatterFor("01A", "张一鸣"), "字节跳动的创始人。");
    writePage("b", frontmatterFor("01B", "推荐算法", { type: "concept" }), "一种信息过滤技术。");
    reindexAll();
    rebuildIndexFile();

    const index = readPageRaw("index.md");
    expect(index).toContain("## 实体（1）");
    expect(index).toContain("## 概念（1）");
    expect(index).toContain("[[张一鸣]]");
    expect(index).toContain("[[推荐算法]]");
  });

  it("每条带一句话摘要", () => {
    writePage("a", frontmatterFor("01A", "张一鸣"), "字节跳动的创始人，主导了推荐算法的工程化。");
    reindexAll();
    rebuildIndexFile();
    expect(readPageRaw("index.md")).toContain("字节跳动的创始人");
  });

  it("摘要去掉行内双链标记，读起来干净", () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[乙]] 的说明。");
    writePage("b", frontmatterFor("01B", "乙"), "正文");
    reindexAll();
    rebuildIndexFile();
    const index = readPageRaw("index.md");
    expect(index).toContain("参见 乙 的说明");
    expect(index).not.toContain("参见 [[乙]]");
  });

  it("空分类显示占位，不留空白节", () => {
    writePage("a", frontmatterFor("01A", "甲"), "正文");
    reindexAll();
    rebuildIndexFile();
    const index = readPageRaw("index.md");
    expect(index).toContain("## 概念（0）");
    expect(index).toContain("_（暂无）_");
  });

  it("标注别名与来源数", () => {
    writePage("a", frontmatterFor("01A", "张一鸣", {
      aliases: ["老张"],
      sources: [{ doc: "raw/x.pdf", page: 3 }],
    }), "正文");
    reindexAll();
    rebuildIndexFile();
    const index = readPageRaw("index.md");
    expect(index).toContain("别名：老张");
    expect(index).toContain("1 个来源");
  });

  it("内容没变时不重写文件（保证 git diff 干净）", () => {
    writePage("a", frontmatterFor("01A", "甲"), "正文");
    reindexAll();
    const first = rebuildIndexFile();
    const second = rebuildIndexFile();
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
  });

  it("已删除的词条不出现在目录里", () => {
    writePage("a", frontmatterFor("01A", "甲"), "正文");
    writePage("b", frontmatterFor("01B", "乙"), "正文");
    reindexAll();
    deletePage("01B", { kind: "keep_dangling" });

    const index = readPageRaw("index.md");
    expect(index).toContain("[[甲]]");
    expect(index).not.toContain("[[乙]]");
  });

  it("新建词条后目录自动更新（服务层已接入）", () => {
    createPage({ type: "entity", title: "新词条", content: "刚建的。" });
    const index = readPageRaw("index.md");
    expect(index).toContain("[[新词条]]");
    expect(index).toContain("## 实体（1）");
  });

  it("改名后目录里是新名字", () => {
    const created = createPage({ type: "entity", title: "旧名", content: "正文" });
    renamePage(created.pageId, "新名");
    const index = readPageRaw("index.md");
    expect(index).toContain("[[新名]]");
    expect(index).not.toContain("[[旧名]]");
  });
});