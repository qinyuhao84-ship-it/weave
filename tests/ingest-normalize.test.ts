import { expect, it } from "vitest";
import { normalizeSourceSummary } from "@/lib/ingest/normalize-draft";

it("书籍词条与来源摘要同名时保留全部正文，链接名称不变", () => {
  const draft = {
    sourceSummary: { title: "小团队管理手册", content: "# 来源摘要\n作者介绍。" },
    newPages: [
      { title: " 小团队管理手册 ", content: "章节目录与书籍介绍。" },
      { title: "目标管理", content: "参见[[小团队管理手册]]。" },
    ],
  };
  const result = normalizeSourceSummary(draft);
  expect(result.sourceSummary.title).toBe("小团队管理手册");
  expect(result.sourceSummary.content).toContain("作者介绍。");
  expect(result.sourceSummary.content).toContain("章节目录与书籍介绍。");
  expect(result.newPages).toEqual([draft.newPages[1]]);
  expect(normalizeSourceSummary(result)).toEqual(result);
  expect(draft.newPages).toHaveLength(2);
});

it("不同标题的书籍词条保留原有资料结构", () => {
  const draft = { sourceSummary: { title: "资料摘要", content: "原始摘要。" }, newPages: [{ title: "目标管理", content: "正文。" }] };
  expect(normalizeSourceSummary(draft)).toBe(draft);
});
