import { describe, it, expect } from "vitest";
import {
  parsePage,
  serializePage,
  createFrontmatter,
  touch,
  type PageFrontmatter,
} from "@/lib/vault/frontmatter";

function sampleData(): PageFrontmatter {
  return {
    id: "01JD2K3M4N5P6Q7R8S9T0V",
    type: "entity",
    title: "张一鸣",
    slug: "zhang-yi-ming",
    aliases: ["Zhang Yiming"],
    tags: ["人物", "互联网"],
    sources: [{ doc: "raw/2026-09-26-某访谈.pdf", page: 12 }],
    related: ["[[字节跳动]]"],
    created: "2026-09-26T18:30:00+08:00",
    updated: "2026-09-26T18:30:00+08:00",
    confidence: "high",
  };
}

describe("parsePage", () => {
  it("解析合法的 frontmatter 与正文", () => {
    const raw = `---\nid: abc\ntype: entity\ntitle: 张一鸣\nslug: zhang-yi-ming\ncreated: "2026-01-01T00:00:00+08:00"\nupdated: "2026-01-01T00:00:00+08:00"\n---\n\n正文内容\n`;
    const parsed = parsePage(raw, "test.md");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.title).toBe("张一鸣");
    expect(parsed.data.type).toBe("entity");
    expect(parsed.content.trim()).toBe("正文内容");
  });

  it("缺少 frontmatter 时返回失败而非抛异常", () => {
    const parsed = parsePage("没有 frontmatter 的纯文本", "test.md");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("缺少 frontmatter");
  });

  it("YAML 语法错误时返回失败", () => {
    const raw = `---\nid: [未闭合\ntype: entity\n---\n\n正文\n`;
    const parsed = parsePage(raw, "test.md");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("YAML 解析失败");
  });

  it("缺少必填字段时返回具体的字段名", () => {
    const raw = `---\nid: abc\ntype: entity\n---\n\n正文\n`;
    const parsed = parsePage(raw, "test.md");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("frontmatter 校验失败");
    expect(parsed.error).toContain("title");
  });

  it("非法的 type 值被拒", () => {
    const raw = `---\nid: abc\ntype: 不存在的类型\ntitle: X\nslug: x\ncreated: c\nupdated: u\n---\n\n正文\n`;
    expect(parsePage(raw, "t.md").ok).toBe(false);
  });

  it("可选的 sources.page 被正确解析为数字", () => {
    const data = sampleData();
    const parsed = parsePage(serializePage(data, "正文"), "t.md");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.sources[0].page).toBe(12);
  });

  it("缺失的可选数组字段被补成空数组", () => {
    const raw = `---\nid: abc\ntype: concept\ntitle: X\nslug: x\ncreated: c\nupdated: u\n---\n\n正文\n`;
    const parsed = parsePage(raw, "t.md");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.aliases).toEqual([]);
    expect(parsed.data.tags).toEqual([]);
    expect(parsed.data.related).toEqual([]);
    expect(parsed.data.confidence).toBe("high");
  });

  it("CRLF 换行也能解析", () => {
    const raw = "---\r\nid: abc\r\ntype: entity\r\ntitle: X\r\nslug: x\r\ncreated: c\r\nupdated: u\r\n---\r\n\r\n正文\r\n";
    expect(parsePage(raw, "t.md").ok).toBe(true);
  });
});

describe("serializePage 与往返一致性", () => {
  it("序列化后再解析得到等价数据", () => {
    const data = sampleData();
    const parsed = parsePage(serializePage(data, "正文内容"), "t.md");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data).toEqual(data);
  });

  it("中文不被转义成 unicode 转义序列", () => {
    const text = serializePage(sampleData(), "正文");
    expect(text).toContain("张一鸣");
    expect(text).not.toContain("\\u5f20");
  });

  it("字段顺序稳定 —— 保证 git diff 干净", () => {
    const text = serializePage(sampleData(), "正文");
    const keys = [...text.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual([
      "id", "type", "title", "slug", "aliases", "tags",
      "sources", "related", "created", "updated", "confidence",
    ]);
  });

  it("空数组字段被省略，不写进文件", () => {
    const data = { ...sampleData(), aliases: [], tags: [], related: [] };
    const text = serializePage(data, "正文");
    expect(text).not.toContain("aliases:");
    expect(text).not.toContain("tags:");
    expect(text).not.toContain("related:");
  });

  it("可选的墓碑字段在存在时被写入", () => {
    const data = { ...sampleData(), deleted_at: "2026-09-26T19:00:00+08:00" };
    expect(serializePage(data, "正文")).toContain("deleted_at:");
  });

  it("正文结尾统一为单个换行", () => {
    const text = serializePage(sampleData(), "正文\n\n\n");
    expect(text.endsWith("正文\n")).toBe(true);
    expect(text.endsWith("\n\n\n")).toBe(false);
  });

  it("文件以 --- 开头，格式可被 Obsidian 识别", () => {
    expect(serializePage(sampleData(), "正文").startsWith("---\n")).toBe(true);
  });

  it("长中文句子不被折行 —— 折行会破坏 frontmatter 可读性", () => {
    const long = "这".repeat(120);
    const data = { ...sampleData(), title: long };
    const text = serializePage(data, "正文");
    const titleLine = text.split("\n").find((l) => l.startsWith("title:"));
    expect(titleLine).toContain(long);
  });
});

describe("createFrontmatter 与 touch", () => {
  it("新建的词条带 ULID 且 created 与 updated 相同", () => {
    const data = createFrontmatter({ type: "concept", title: "推荐算法", slug: "tui-jian-suan-fa" });
    expect(data.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(data.created).toBe(data.updated);
    expect(data.confidence).toBe("high");
  });

  it("两次新建产生不同的 id", () => {
    const a = createFrontmatter({ type: "concept", title: "A", slug: "a" });
    const b = createFrontmatter({ type: "concept", title: "A", slug: "a" });
    expect(a.id).not.toBe(b.id);
  });

  it("touch 只改 updated，不动 created 与 id", () => {
    const data = sampleData();
    const next = touch(data, "2027-01-01T00:00:00+08:00");
    expect(next.updated).toBe("2027-01-01T00:00:00+08:00");
    expect(next.created).toBe(data.created);
    expect(next.id).toBe(data.id);
  });
});
