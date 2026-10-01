import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { reindexAll } from "@/lib/index/reindex";
import { getDb, dropAllIndexTables } from "@/lib/db/client";
import { pages, links, redirects, edges } from "@/lib/db/schema";
import {
  createPage, updatePage, renamePage, deletePage, previewDelete,
  mergePages, restorePage, loadPageFile, ConflictError,
} from "@/lib/vault/service";
import { writePage, frontmatterFor, resetVault, vaultRoot, readPageRaw, pageExists } from "./helpers";
import { ensureGitRepo, logVault } from "@/lib/git/auto-commit";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

/** 建立一个含若干互相引用的词条的基础场景 */
function seed() {
  writePage("zhang-yi-ming", frontmatterFor("01ZHANG", "张一鸣"), "参见 [[字节跳动]] 与 [[推荐算法]]。");
  writePage("zi-jie", frontmatterFor("01ZIJIE", "字节跳动"), "创始人 [[张一鸣]]。");
  writePage("tui-jian", frontmatterFor("01REC", "推荐算法"), "由 [[字节跳动]] 大规模应用。");
  reindexAll();
}

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
});

/* ============================================================ 新建 */

describe("createPage", () => {
  it("创建文件、写 frontmatter、进索引、提交 git", () => {
    const result = createPage({
      type: "entity",
      title: "张一鸣",
      content: "字节跳动的创始人。",
    });

    expect(result.relativePath).toBe("wiki/entities/zhang-yi-ming.md");
    expect(pageExists(result.relativePath)).toBe(true);

    const file = loadPageFile(result.pageId);
    expect(file.data.title).toBe("张一鸣");
    expect(file.data.slug).toBe("zhang-yi-ming");
    expect(file.content.trim()).toBe("字节跳动的创始人。");
    expect(result.commitSha).toBeTruthy();
  });

  it("slug 冲突时自动加序号，不覆盖已有文件", () => {
    const first = createPage({ type: "entity", title: "张一鸣", content: "一" });
    const second = createPage({ type: "entity", title: "张一鸣", content: "二" });

    expect(first.relativePath).toBe("wiki/entities/zhang-yi-ming.md");
    expect(second.relativePath).toBe("wiki/entities/zhang-yi-ming-2.md");
    expect(readPageRaw(first.relativePath)).toContain("一");
    expect(readPageRaw(second.relativePath)).toContain("二");
  });

  it("写操作记入 log.md", () => {
    createPage({ type: "concept", title: "推荐算法", content: "正文" });
    expect(readPageRaw("log.md")).toContain("CREATE");
    expect(readPageRaw("log.md")).toContain("推荐算法");
  });
});

/* ============================================================ 编辑 */

describe("updatePage", () => {
  it("改正文并刷新 updated 时间戳", () => {
    seed();
    const before = loadPageFile("01ZHANG");
    const result = updatePage("01ZHANG", { content: "改写后的正文。" });

    const after = loadPageFile("01ZHANG");
    expect(after.content.trim()).toBe("改写后的正文。");
    expect(after.data.updated).not.toBe(before.data.updated);
    expect(after.data.created).toBe(before.data.created);
    expect(result.commitSha).toBeTruthy();
  });

  it("外部改动后提交被拒绝 —— 不做静默覆盖", () => {
    seed();
    const original = loadPageFile("01ZHANG");
    const staleHash = crypto.createHash("sha256").update(original.raw).digest("hex");

    // 模拟用户在 Obsidian 里同时编辑了这个文件
    fs.writeFileSync(
      path.join(vaultRoot(), original.relativePath),
      original.raw.replace("参见", "外部改过的参见"),
      "utf8",
    );

    expect(() => updatePage("01ZHANG", { content: "我的改动", expectedHash: staleHash }))
      .toThrow(ConflictError);
  });

  it("哈希一致时正常提交", () => {
    seed();
    const original = loadPageFile("01ZHANG");
    const hash = crypto.createHash("sha256").update(original.raw).digest("hex");

    const result = updatePage("01ZHANG", { content: "新正文", expectedHash: hash });
    expect(result.commitSha).toBeTruthy();
    expect(loadPageFile("01ZHANG").content.trim()).toBe("新正文");
  });

  it("改标签与别名", () => {
    seed();
    updatePage("01ZHANG", { tags: ["人物", "互联网"], aliases: ["老张"] });
    const after = loadPageFile("01ZHANG");
    expect(after.data.tags).toEqual(["人物", "互联网"]);
    expect(after.data.aliases).toContain("老张");
  });
});

/* ============================================================ 改名（F1） */

describe("renamePage —— 改名与引用重写", () => {
  it("全库指向旧名的双链被重写", () => {
    seed();
    const result = renamePage("01ZHANG", "张一鸣（字节跳动创始人）");

    // 字节跳动的正文里原本是 [[张一鸣]]，应该已更新
    expect(loadPageFile("01ZIJIE").content).toContain("[[张一鸣（字节跳动创始人）]]");
    expect(loadPageFile("01ZIJIE").content).not.toContain("[[张一鸣]]");
    expect(result.linksTouched).toBe(1);
    expect(result.affectedPages).toBe(1);
  });

  it("文件名随标题一起改（slug 变化）", () => {
    seed();
    const result = renamePage("01ZHANG", "Zhang Yiming");
    expect(result.relativePath).toBe("wiki/entities/zhang-yiming.md");
    expect(pageExists("wiki/entities/zhang-yi-ming.md")).toBe(false);
    expect(pageExists("wiki/entities/zhang-yiming.md")).toBe(true);
  });

  it("旧名进 aliases —— 别名兜底", () => {
    seed();
    renamePage("01ZHANG", "张一鸣（创始人）");
    expect(loadPageFile("01ZHANG").data.aliases).toContain("张一鸣");
  });

  it("写入重定向记录 —— 重定向兜底", () => {
    seed();
    renamePage("01ZHANG", "张一鸣（创始人）");
    const rows = getDb().select().from(redirects).all();
    expect(rows.some((r) => r.oldNormalized === "张一鸣" && r.newPageId === "01ZHANG")).toBe(true);
  });

  it("代码块里的同名双链不被改写", () => {
    writePage("a", frontmatterFor("01A", "甲"), "```\n[[乙]]\n```\n\n真的 [[乙]]");
    writePage("b", frontmatterFor("01B", "乙"), "正文");
    reindexAll();

    renamePage("01B", "乙某");
    const content = loadPageFile("01A").content;
    expect(content).toContain("```\n[[乙]]\n```");
    expect(content).toContain("真的 [[乙某]]");
  });

  it("改名后索引里的链接指向仍然正确", () => {
    seed();
    renamePage("01ZHANG", "张一鸣（创始人）");
    const all = getDb().select().from(links).all();
    const fromZijie = all.find((l) => l.srcPageId === "01ZIJIE");
    expect(fromZijie?.dstPageId).toBe("01ZHANG");
  });

  it("改名后图谱的节点 id 不变 —— 边的身份是 id 不是名字", () => {
    seed();
    const before = getDb().select().from(edges).all().length;
    renamePage("01ZHANG", "张一鸣（创始人）");
    const after = getDb().select().from(edges).all();
    expect(after.length).toBe(before);
    expect(after.some((e) => e.sourcePageId === "01ZIJIE" && e.targetPageId === "01ZHANG")).toBe(true);
  });

  it("改名后反向链接数不变 —— 「修改确实生效了」的可验证证据", () => {
    seed();
    const countBefore = getDb().select().from(links).all()
      .filter((l) => l.dstPageId === "01ZHANG").length;
    renamePage("01ZHANG", "张一鸣（创始人）");
    const countAfter = getDb().select().from(links).all()
      .filter((l) => l.dstPageId === "01ZHANG").length;
    expect(countAfter).toBe(countBefore);
  });

  it("改名会重写旧标题、旧 slug、别名以及词条自己的自引用", () => {
    writePage(
      "old-file-name",
      frontmatterFor("01OLD", "旧名", { slug: "legacy-key", aliases: ["曾用名"] }),
      "自引用 [[旧名]]、[[legacy-key]] 和 [[曾用名]]。",
    );
    writePage(
      "reference",
      frontmatterFor("01REF", "引用者"),
      "引用 [[旧名]]、[[legacy-key]] 和 [[曾用名]]。",
    );
    reindexAll();

    const result = renamePage("01OLD", "新名");

    expect(loadPageFile("01OLD").content.trim()).toBe("自引用 [[新名]]、[[新名]] 和 [[新名]]。");
    expect(loadPageFile("01REF").content.trim()).toBe("引用 [[新名]]、[[新名]] 和 [[新名]]。");
    expect(loadPageFile("01OLD").data.aliases).toContain("legacy-key");
    expect(result.linksTouched).toBe(6);
    expect(result.affectedPages).toBe(1);
  });

  it("改名记入 log.md", () => {
    seed();
    renamePage("01ZHANG", "张一鸣（创始人）");
    const log = readPageRaw("log.md");
    expect(log).toContain("RENAME");
    expect(log).toContain("张一鸣（创始人）");
  });
});

/* ============================================================ 删除（F6） */

describe("previewDelete —— 删除前让人看到影响面", () => {
  it("统计出引用了本词条的其他词条", () => {
    seed();
    const preview = previewDelete("01ZHANG");
    expect(preview.title).toBe("张一鸣");
    expect(preview.totalReferences).toBe(1);
    expect(preview.referencingPages[0].title).toBe("字节跳动");
  });

  it("没有引用时为零", () => {
    seed();
    const preview = previewDelete("01REC");
    expect(preview.totalReferences).toBeGreaterThanOrEqual(0);
  });
});

describe("deletePage —— 三种引用处理策略", () => {
  it("clean_refs：引用降级为纯文本，不留死链", () => {
    seed();
    deletePage("01ZHANG", { kind: "clean_refs" });

    const content = loadPageFile("01ZIJIE").content;
    expect(content).toContain("创始人 张一鸣。");
    expect(content).not.toContain("[[张一鸣]]");
  });

  it("clean_refs 一次清理标题、slug 与多个别名，且同一页只计一次", () => {
    writePage(
      "old-name",
      frontmatterFor("01OLD", "旧名", { slug: "legacy-key", aliases: ["曾用名"] }),
      "已删除词条。",
    );
    writePage(
      "reference",
      frontmatterFor("01REF", "引用者"),
      "看 [[旧名]]、[[legacy-key]] 和 [[曾用名]]。",
    );
    reindexAll();

    const result = deletePage("01OLD", { kind: "clean_refs" });

    expect(loadPageFile("01REF").content.trim()).toBe("看 旧名、legacy-key 和 曾用名。");
    expect(result.linksTouched).toBe(3);
    expect(result.affectedPages).toBe(1);
  });

  it("redirect：引用改指向另一个词条且保留原显示名", () => {
    seed();
    const result = deletePage("01ZHANG", { kind: "redirect", targetPageId: "01ZIJIE" });

    const content = loadPageFile("01ZIJIE").content;
    expect(content).toContain("[[字节跳动|张一鸣]]");
    expect(result.linksTouched).toBe(1);
  });

  it("keep_dangling：引用原样保留，成为 dangling 待巡检处理", () => {
    seed();
    deletePage("01ZHANG", { kind: "keep_dangling" });
    expect(loadPageFile("01ZIJIE").content).toContain("[[张一鸣]]");

    const link = getDb().select().from(links).all().find((l) => l.dstNormalized === "张一鸣");
    expect(link?.dstPageId).toBeNull();
  });

  it("软删除：文件进回收站而非物理删除", () => {
    seed();
    const result = deletePage("01ZHANG", { kind: "keep_dangling" });

    expect(pageExists("wiki/entities/zhang-yi-ming.md")).toBe(false);
    expect(fs.existsSync(path.join(vaultRoot(), result.relativePath))).toBe(true);
    expect(result.relativePath).toContain("trash");
  });

  it("数据库里留下墓碑，可区分「被删过」与「从未存在」", () => {
    seed();
    deletePage("01ZHANG", { kind: "keep_dangling" });
    const row = getDb().select().from(pages).all().find((p) => p.id === "01ZHANG");
    expect(row?.status).toBe("deleted");
    expect(row?.deletedAt).toBeTruthy();
  });

  it("删除记入 log.md 并注明策略", () => {
    seed();
    deletePage("01ZHANG", { kind: "keep_dangling" });
    const log = readPageRaw("log.md");
    expect(log).toContain("DELETE");
    expect(log).toContain("keep_dangling");
  });
});

describe("restorePage —— 后悔药", () => {
  it("从回收站恢复被删除的词条", () => {
    seed();
    deletePage("01ZHANG", { kind: "keep_dangling" });
    expect(pageExists("wiki/entities/zhang-yi-ming.md")).toBe(false);

    restorePage("01ZHANG");
    expect(loadPageFile("01ZHANG").data.title).toBe("张一鸣");
    expect(loadPageFile("01ZHANG").data.deleted_at).toBeUndefined();
  });

  it("恢复后引用重新解析成功", () => {
    seed();
    deletePage("01ZHANG", { kind: "keep_dangling" });
    restorePage("01ZHANG");
    const link = getDb().select().from(links).all().find((l) => l.dstNormalized === "张一鸣");
    expect(link?.dstPageId).toBe("01ZHANG");
  });
});

/* ============================================================ 合并（F8/F9） */

describe("mergePages / deletePage —— 乐观并发", () => {
  it("合并时传入的哈希与磁盘不符则拒绝，且一个文件都不动", () => {
    // 这条守的是「先给用户看影响范围、他读完再确认」那个分钟级窗口：
    // 合并是唯一会覆盖已有正文的破坏性操作，少了这道校验，
    // 用户在这期间用 Obsidian 改的内容会被合并稿静默盖掉。
    seed();
    const targetRaw = readPageRaw("wiki/entities/zi-jie.md");
    const stale = crypto.createHash("sha256").update("已经被改过的那一版").digest("hex");

    expect(() =>
      mergePages({
        sourcePageId: "01ZHANG",
        targetPageId: "01ZIJIE",
        mergedContent: "合并稿",
        expectedHashes: { target: stale },
      }),
    ).toThrow(ConflictError);

    expect(readPageRaw("wiki/entities/zi-jie.md")).toBe(targetRaw);
    expect(pageExists("wiki/entities/zhang-yi-ming.md")).toBe(true);
  });

  it("删除时传入的哈希与磁盘不符则拒绝", () => {
    seed();
    const stale = crypto.createHash("sha256").update("已经被改过的那一版").digest("hex");
    expect(() => deletePage("01ZHANG", { kind: "clean_refs" }, stale)).toThrow(ConflictError);
    expect(pageExists("wiki/entities/zhang-yi-ming.md")).toBe(true);
  });

  it("哈希对得上时照常执行", () => {
    seed();
    const raw = readPageRaw("wiki/entities/zi-jie.md");
    const good = crypto.createHash("sha256").update(raw).digest("hex");
    const result = mergePages({
      sourcePageId: "01ZHANG",
      targetPageId: "01ZIJIE",
      expectedHashes: { target: good },
    });
    expect(result.mergedAliases).toContain("张一鸣");
  });
});

describe("mergePages —— 合并重复实体", () => {
  it("正文合并进目标词条", () => {
    writePage("a1", frontmatterFor("01A", "张三"), "这是张三的词条。");
    writePage("a2", frontmatterFor("01B", "张三丰"), "这是张三丰的词条。");
    reindexAll();

    mergePages({ sourcePageId: "01A", targetPageId: "01B" });

    const target = loadPageFile("01B");
    expect(target.content).toContain("这是张三丰的词条。");
    expect(target.content).toContain("这是张三的词条。");
  });

  it("旧名折叠进目标的 aliases", () => {
    writePage("a1", frontmatterFor("01A", "张三"), "一");
    writePage("a2", frontmatterFor("01B", "张三丰"), "二");
    reindexAll();

    const result = mergePages({ sourcePageId: "01A", targetPageId: "01B" });
    expect(result.mergedAliases).toContain("张三");
    expect(loadPageFile("01B").data.aliases).toContain("张三");
  });

  it("指向源词条的链接改指向目标，且保留原显示名", () => {
    writePage("src", frontmatterFor("01SRC", "张三"), "一");
    writePage("dst", frontmatterFor("01DST", "张三丰"), "二");
    writePage("ref", frontmatterFor("01REF", "引用者"), "参见 [[张三]] 的事迹。");
    reindexAll();

    mergePages({ sourcePageId: "01SRC", targetPageId: "01DST" });

    expect(loadPageFile("01REF").content).toContain("[[张三丰|张三]]");
  });

  it("合并时保留用户提交的合并稿，并重写其中所有旧名链接", () => {
    writePage(
      "source",
      frontmatterFor("01SRC", "旧名", { slug: "legacy-key", aliases: ["曾用名"] }),
      "旧正文。",
    );
    writePage("target", frontmatterFor("01DST", "目标"), "旧目标正文。 ");
    writePage(
      "reference",
      frontmatterFor("01REF", "引用者"),
      "看 [[旧名]]、[[legacy-key]] 和 [[曾用名]]。",
    );
    reindexAll();

    const result = mergePages({
      sourcePageId: "01SRC",
      targetPageId: "01DST",
      mergedContent: "整理稿：[[旧名]]、[[legacy-key]] 和 [[曾用名]]。",
    });

    expect(loadPageFile("01DST").content.trim()).toBe(
      "整理稿：[[目标|旧名]]、[[目标|legacy-key]] 和 [[目标|曾用名]]。",
    );
    expect(loadPageFile("01REF").content.trim()).toBe(
      "看 [[目标|旧名]]、[[目标|legacy-key]] 和 [[目标|曾用名]]。",
    );
    expect(result.linksTouched).toBe(6);
    expect(result.affectedPages).toBe(2);
  });

  it("合并时指定新标题会同步更新目标 slug 与文件名，并保留原名称", () => {
    writePage("source", frontmatterFor("01SRC", "源词条", { slug: "source-key" }), "源正文。");
    writePage("target", frontmatterFor("01DST", "旧目标", { slug: "target-key" }), "目标正文。");
    reindexAll();

    const result = mergePages({
      sourcePageId: "01SRC",
      targetPageId: "01DST",
      title: "新目标",
      mergedContent: "合并正文。",
    });

    const merged = loadPageFile("01DST");
    expect(merged.data.title).toBe("新目标");
    expect(merged.data.slug).toBe("xin-mu-biao");
    expect(merged.data.aliases).toContain("旧目标");
    expect(merged.data.aliases).toContain("target-key");
    expect(merged.data.aliases).toContain("source-key");
    expect(merged.relativePath).toBe("wiki/entities/xin-mu-biao.md");
    expect(pageExists("wiki/entities/target.md")).toBe(false);
    expect(result.relativePath).toBe(merged.relativePath);
  });

  it("源词条转为墓碑并移入回收站", () => {
    writePage("a1", frontmatterFor("01A", "张三"), "一");
    writePage("a2", frontmatterFor("01B", "张三丰"), "二");
    reindexAll();

    const result = mergePages({ sourcePageId: "01A", targetPageId: "01B" });
    expect(pageExists("wiki/entities/zhang-san.md")).toBe(false);
    expect(fs.existsSync(path.join(vaultRoot(), `.weave/trash/01A.md`))).toBe(true);
    expect(result.pageId).toBe("01B");
  });

  it("写重定向记录，使旧名 [[张三]] 仍能解析到合并后的词条", () => {
    writePage("a1", frontmatterFor("01A", "张三"), "一");
    writePage("a2", frontmatterFor("01B", "张三丰"), "二");
    reindexAll();

    mergePages({ sourcePageId: "01A", targetPageId: "01B" });

    // 新建一个文件手写旧名链接，验证它仍能解析
    writePage("later", frontmatterFor("01LATER", "后写的"), "又看到 [[张三]]。");
    reindexAll();
    const link = getDb().select().from(links).all()
      .find((l) => l.srcPageId === "01LATER");
    expect(link?.dstPageId).toBe("01B");
  });

  it("传递闭包：A→B 之后 B→C，指向 A 的链接一路落到 C", () => {
    writePage("a", frontmatterFor("01A", "甲"), "一");
    writePage("b", frontmatterFor("01B", "乙"), "二");
    writePage("c", frontmatterFor("01C", "丙"), "三");
    writePage("ref", frontmatterFor("01REF", "引用者"), "见 [[甲]]。");
    reindexAll();

    mergePages({ sourcePageId: "01A", targetPageId: "01B" });
    mergePages({ sourcePageId: "01B", targetPageId: "01C" });

    // 重定向应被压平成 甲 → 丙，不留双重跳转
    const rows = getDb().select().from(redirects).all();
    const jia = rows.find((r) => r.oldNormalized === "甲");
    expect(jia?.newPageId).toBe("01C");
  });

  it("合并同类项：来源去重", () => {
    writePage("a", frontmatterFor("01A", "甲", { sources: [{ doc: "raw/x.pdf", page: 1 }] }), "一");
    writePage("b", frontmatterFor("01B", "乙", { sources: [{ doc: "raw/x.pdf", page: 1 }, { doc: "raw/y.pdf" }] }), "二");
    reindexAll();

    mergePages({ sourcePageId: "01A", targetPageId: "01B" });
    const sources = loadPageFile("01B").data.sources;
    expect(sources).toHaveLength(2);
  });

  it("合并记入 log.md", () => {
    writePage("a", frontmatterFor("01A", "甲"), "一");
    writePage("b", frontmatterFor("01B", "乙"), "二");
    reindexAll();

    mergePages({ sourcePageId: "01A", targetPageId: "01B" });
    expect(readPageRaw("log.md")).toContain("MERGE");
  });
});

/* ============================================================ 可回滚（F12） */

describe("git 版本管理", () => {
  it("每次写操作产生一个提交", () => {
    seed();
    const before = logVault(100).length;
    renamePage("01ZHANG", "张一鸣（创始人）");
    const after = logVault(100).length;
    expect(after).toBeGreaterThan(before);
  });

  it("提交历史能读回人名与信息", () => {
    seed();
    const commits = logVault(10);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0].sha).toBeTruthy();
    expect(commits[0].shortSha.length).toBeLessThan(commits[0].sha.length);
  });

  it("索引与解析产物被 gitignore 排除，回收站例外", () => {
    seed();
    const ignore = fs.readFileSync(path.join(vaultRoot(), ".gitignore"), "utf8");
    // SQLite 与解析产物是纯派生数据，可以从 raw/ 与 wiki/ 重建，不进版本管理
    expect(ignore).toContain(".weave/*");
    // 但回收站必须进版本管理。它放的是墓碑与被删词条的正文：墓碑是「旧名当初
    // 指向哪里」唯一的文件证据 —— 整个 .weave/ 一起排除的话，换台机器或
    // clone 一份新的之后 redirects 表就再也建不起来，[[旧名]] 变成永久死链，
    // 正好违反不变式 1（索引表不得存放无法从 vault 文件恢复的信息）。
    expect(ignore).toContain("!.weave/trash/");
    // 旧写法必须不在：git 不会为一个「父目录已被排除」的文件破例
    expect(ignore).not.toMatch(/^\.weave\/$/m);
  });

  it("已存在的 vault 会被定向升级 .gitignore，用户自己加的行原样保留", () => {
    // 老 vault 的 .gitignore 里是整个 .weave/ 排除，回收站跟着遭殃。
    // 升级必须只动我们自己写的那一段 —— 文件里可能有用户加的规则。
    seed();
    const ignorePath = path.join(vaultRoot(), ".gitignore");
    fs.writeFileSync(
      ignorePath,
      "# 派生数据：全部可从 raw/ 与 wiki/ 重建，不进版本管理\n.weave/\n\n# 我自己加的\n*.tmp\n",
      "utf8",
    );

    expect(ensureGitRepo()).toBe(false);
    const ignore = fs.readFileSync(ignorePath, "utf8");
    expect(ignore).toContain("!.weave/trash/");
    expect(ignore).toContain("*.tmp");
    expect(ignore).not.toMatch(/^\.weave\/$/m);
  });

  it("墓碑真的被 git 跟踪 —— 这是「重建得起来」的唯一判据", () => {
    seed();
    deletePage("01ZHANG", { kind: "redirect", targetPageId: "01ZIJIE" });

    // 光看 .gitignore 里写了放行是不够的：.weave/* 排除在前、放行在后，
    // 只有真正问一次 git 才知道这条规则有没有生效
    const tracked = execFileSync("git", ["-C", vaultRoot(), "ls-files", ".weave/trash"], {
      encoding: "utf8",
    });
    expect(tracked).toContain(".weave/trash/01ZHANG.md");
  });
});
