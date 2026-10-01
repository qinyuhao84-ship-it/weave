import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { reindexAll } from "@/lib/index/reindex";
import { getDb, dropAllIndexTables } from "@/lib/db/client";
import { pages, links, edges, redirects, reviewItems } from "@/lib/db/schema";
import { mergePages, deletePage } from "@/lib/vault/service";
import { writePage, frontmatterFor, resetVault, vaultRoot } from "./helpers";

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reindexAll —— 基本索引", () => {
  it("把 wiki 里的词条索引进数据库", () => {
    writePage("zhang-yi-ming", frontmatterFor("01A", "张一鸣"), "字节跳动的创始人。");
    writePage("zi-jie-tiao-dong", frontmatterFor("01B", "字节跳动"), "一家科技公司。");

    const report = reindexAll();
    expect(report.pages).toBe(2);
    expect(report.broken).toHaveLength(0);

    const rows = getDb().select().from(pages).all();
    expect(rows.map((r) => r.title).sort()).toEqual(["字节跳动", "张一鸣"].sort());
  });

  it("解析失败的词条被报告但不阻断索引", () => {
    writePage("good", frontmatterFor("01A", "好词条"), "正文");
    // 故意写一个缺字段的坏文件
    writePage("bad", { id: "01BAD" }, "正文");

    const report = reindexAll();
    expect(report.pages).toBe(1);
    expect(report.broken).toHaveLength(1);
    expect(report.broken[0].error).toContain("校验失败");
  });

  it("重复索引是幂等的", () => {
    writePage("a", frontmatterFor("01A", "甲"), "正文");
    const first = reindexAll();
    const second = reindexAll();
    expect(second.pages).toBe(first.pages);
    expect(getDb().select().from(pages).all()).toHaveLength(1);
  });
});

describe("reindexAll —— 双链解析", () => {
  it("解析出词条之间的链接", () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[乙]]。");
    writePage("b", frontmatterFor("01B", "乙"), "正文");

    const report = reindexAll();
    expect(report.links).toBe(1);

    const link = getDb().select().from(links).all()[0];
    expect(link.srcPageId).toBe("01A");
    expect(link.dstPageId).toBe("01B");
    expect(link.dstRaw).toBe("乙");
  });

  it("通过别名解析链接", () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[老张]]。");
    writePage("b", frontmatterFor("01B", "张一鸣", { aliases: ["老张", "Zhang Yiming"] }), "正文");

    reindexAll();
    const link = getDb().select().from(links).all()[0];
    expect(link.dstPageId).toBe("01B");
  });

  it("通过 slug 解析链接", () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[zhang-yi-ming]]。");
    writePage("zhang-yi-ming", frontmatterFor("01B", "张一鸣", { slug: "zhang-yi-ming" }), "正文");

    reindexAll();
    expect(getDb().select().from(links).all()[0].dstPageId).toBe("01B");
  });

  it("链接解析大小写不敏感", () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[TRANSFORMER]]。");
    writePage("t", frontmatterFor("01B", "Transformer"), "正文");

    reindexAll();
    expect(getDb().select().from(links).all()[0].dstPageId).toBe("01B");
  });

  it("指向不存在词条的链接记为死链（unresolved）", () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[根本不存在的词条]]。");
    reindexAll();

    const link = getDb().select().from(links).all()[0];
    expect(link.dstPageId).toBeNull();
    expect(link.dstNormalized).toBe("根本不存在的词条");
  });

  it("代码块里的双链不产生链接", () => {
    writePage("a", frontmatterFor("01A", "甲"), "```\n[[乙]]\n```\n\n真的 [[乙]]");
    writePage("b", frontmatterFor("01B", "乙"), "正文");

    reindexAll();
    const rows = getDb().select().from(links).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrences).toBe(1);
  });

  it("同一目标的多次出现被聚合计数", () => {
    writePage("a", frontmatterFor("01A", "甲"), "[[乙]] 一次，[[乙|乙某]] 又一次，[[乙]] 再一次。");
    writePage("b", frontmatterFor("01B", "乙"), "正文");

    reindexAll();
    const rows = getDb().select().from(links).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrences).toBe(3);
  });
});

describe("reindexAll —— 关系图", () => {
  it("从双链生成边", () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[乙]]。");
    writePage("b", frontmatterFor("01B", "乙"), "参见 [[甲]]。");

    const report = reindexAll();
    expect(report.edges).toBe(2);

    const rows = getDb().select().from(edges).all();
    expect(rows.map((e) => `${e.sourcePageId}->${e.targetPageId}`).sort()).toEqual([
      "01A->01B",
      "01B->01A",
    ]);
  });

  it("自环不入图", () => {
    writePage("a", frontmatterFor("01A", "甲"), "自我引用 [[甲]]。");
    expect(reindexAll().edges).toBe(0);
  });

  it("边带 provenance —— 记下它是哪个词条提出的", () => {
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[乙]]。");
    writePage("b", frontmatterFor("01B", "乙"), "正文");

    reindexAll();
    const edge = getDb().select().from(edges).all()[0];
    expect(edge.evidencePagePath).toBe("wiki/entities/a.md");
    expect(edge.relType).toBe("mentions");
    expect(edge.weight).toBeGreaterThan(0);
  });
});

describe("reindexAll —— 删除与墓碑", () => {
  it("文件被删掉的词条标记为 deleted 而非物理删除", () => {
    const relative = writePage("a", frontmatterFor("01A", "甲"), "正文");
    reindexAll();
    expect(getDb().select().from(pages).all()[0].status).toBe("active");

    // 模拟外部删除文件
    fs.unlinkSync(path.join(process.env.WEAVE_VAULT!, relative));

    reindexAll();
    const row = getDb().select().from(pages).all()[0];
    expect(row.status).toBe("deleted");
    expect(row.deletedAt).toBeTruthy();
  });

  it("指向已删除词条的链接记为 dangling，与从未存在区分开", () => {
    const relative = writePage("b", frontmatterFor("01B", "乙"), "正文");
    writePage("a", frontmatterFor("01A", "甲"), "参见 [[乙]]。");
    reindexAll();

    fs.unlinkSync(path.join(process.env.WEAVE_VAULT!, relative));
    reindexAll();

    const link = getDb().select().from(links).all()[0];
    expect(link.dstPageId).toBeNull();
  });

  it("带 deleted_at 的词条不进索引", () => {
    writePage("a", frontmatterFor("01A", "甲", { deleted_at: "2026-09-26T19:00:00+08:00" }), "正文");
    const report = reindexAll();
    expect(report.pages).toBe(0);
  });
});

describe("reindexAll —— 重名冲突", () => {
  it("两个词条抢同一个名字时记入审阅队列", () => {
    writePage("a1", frontmatterFor("01A", "张一鸣"), "正文一");
    writePage("a2", frontmatterFor("01B", "张一鸣"), "正文二");

    const report = reindexAll();
    expect(report.nameConflicts).toHaveLength(1);
    expect(report.nameConflicts[0].name).toBe("张一鸣");
    expect([...report.nameConflicts[0].pageIds].sort()).toEqual(["01A", "01B"]);
  });

  it("用户裁决过的冲突不会被下一次索引重建抹掉", () => {
    // 这条守的是一个真实缺陷：这段代码曾经是「删光全部 duplicate 事项再重建」，
    // 重建会给每条冲突换一个新 ULID，于是用户对「这两个词条该合并」的裁决会在
    // 下一次任意写操作之后消失 —— 而每次写操作都会触发一次全量重建。
    writePage("a1", frontmatterFor("01A", "张一鸣"), "正文一");
    writePage("a2", frontmatterFor("01B", "张一鸣"), "正文二");
    reindexAll();

    const before = getDb().select().from(reviewItems).all().find((r) => r.kind === "duplicate")!;
    expect(before).toBeTruthy();
    getDb()
      .update(reviewItems)
      .set({ status: "dismissed", decisionNote: "这两个不是同一个人" })
      .where(eq(reviewItems.id, before.id))
      .run();

    reindexAll();

    const after = getDb().select().from(reviewItems).all().filter((r) => r.kind === "duplicate");
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].status).toBe("dismissed");
    expect(after[0].decisionNote).toBe("这两个不是同一个人");
  });

  it("冲突消失后只清掉没人碰过的重复事项，已答过的留着", () => {
    writePage("a1", frontmatterFor("01A", "张一鸣"), "正文一");
    writePage("a2", frontmatterFor("01B", "张一鸣"), "正文二");
    reindexAll();

    const row = getDb().select().from(reviewItems).all().find((r) => r.kind === "duplicate")!;
    getDb()
      .update(reviewItems)
      .set({ status: "answered", answer: "是同一个东西" })
      .where(eq(reviewItems.id, row.id))
      .run();

    // 冲突消失：其中一个词条被删掉了
    fs.unlinkSync(path.join(vaultRoot(), "wiki/entities/a2.md"));
    reindexAll();

    const after = getDb().select().from(reviewItems).all().filter((r) => r.kind === "duplicate");
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("answered");
  });
});

/**
 * 重定向表的全量重建。
 *
 * 这组用例守的是不变式 1 的最后一块：dropAllIndexTables() + reindexAll() 之后，
 * 知识库的**查询能力**必须与重建前一致 —— 不只是词条和链接，还包括
 * 「[[一个改过名/被合并掉的旧名]] 还能不能找到落点」。
 */
describe("reindexAll —— 从墓碑恢复重定向", () => {
  it("全量重建后，合并建立的重定向从墓碑恢复", () => {
    writePage("a", frontmatterFor("01A", "甲"), "一");
    writePage("b", frontmatterFor("01B", "乙"), "二");
    reindexAll();
    mergePages({ sourcePageId: "01A", targetPageId: "01B" });

    // 丢掉全部索引，只留 wiki/ 里的 markdown 与 .weave/trash/ 里的墓碑
    dropAllIndexTables();
    const report = reindexAll();

    expect(report.redirects).toBeGreaterThan(0);
    const rows = getDb().select().from(redirects).all();
    expect(rows.some((r) => r.oldNormalized === "甲" && r.newPageId === "01B")).toBe(true);
  });

  it("链式合并在全量重建后压平到最终目标，不停在中间那个已经不存在的词条", () => {
    writePage("a", frontmatterFor("01A", "甲"), "一");
    writePage("b", frontmatterFor("01B", "乙"), "二");
    writePage("c", frontmatterFor("01C", "丙"), "三");
    reindexAll();
    mergePages({ sourcePageId: "01A", targetPageId: "01B" });
    mergePages({ sourcePageId: "01B", targetPageId: "01C" });

    dropAllIndexTables();
    reindexAll();

    const rows = getDb().select().from(redirects).all();
    expect(rows.find((r) => r.oldNormalized === "甲")?.newPageId).toBe("01C");
  });

  it("重复重建不改写已有重定向的来历与时间", () => {
    // reindexAll 跑得很频繁：每次写操作之后、每次 watcher 事件之后都会全量重跑。
    // 无条件 upsert 会把服务层写下的 createdAt 每次都刷成「现在」——
    // 界面上「这个旧名从什么时候开始重定向」于是永远显示最近一次重建的时间，
    // reason 更是全被盖成 merge，一次删除也会被报成合并。
    writePage("a", frontmatterFor("01A", "甲"), "一");
    writePage("b", frontmatterFor("01B", "乙"), "二");
    reindexAll();
    mergePages({ sourcePageId: "01A", targetPageId: "01B" });

    const rowOf = () => getDb().select().from(redirects).all().find((r) => r.oldNormalized === "甲");
    const before = rowOf();
    expect(before?.createdAt).toBeTruthy();

    // 隔一分钟再重建一次（假时钟，免得真等）
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    reindexAll();

    const after = rowOf();
    expect(after?.newPageId).toBe("01B");
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.reason).toBe(before?.reason);
  });

  it("删除时选择重指向，全量重建后旧名仍能解析", () => {
    writePage("a", frontmatterFor("01A", "甲"), "一");
    writePage("b", frontmatterFor("01B", "乙"), "二");
    reindexAll();
    deletePage("01A", { kind: "redirect", targetPageId: "01B" });

    dropAllIndexTables();
    reindexAll();

    const rows = getDb().select().from(redirects).all();
    expect(rows.some((r) => r.oldNormalized === "甲" && r.newPageId === "01B")).toBe(true);
  });

  it("保留死链的删除不产生重定向 —— 没有落点就不该编一个出来", () => {
    writePage("a", frontmatterFor("01A", "甲"), "一");
    writePage("b", frontmatterFor("01B", "乙"), "二");
    reindexAll();
    deletePage("01A", { kind: "keep_dangling" });

    dropAllIndexTables();
    reindexAll();

    const rows = getDb().select().from(redirects).all();
    expect(rows.some((r) => r.oldNormalized === "甲")).toBe(false);
  });

  it("全量重建之后手写的旧名，仍能解析到重指向的目标", () => {
    // 用「删除 + 重指向」而不是「合并」来测这一条，是因为两者兜底的深度不同：
    //   合并   —— 旧名被折叠进目标词条的 aliases，重建后光靠 aliases 就能解析，
    //             重定向表只是第二重保险（丢了也不断链）
    //   删除   —— 引用被就地改写指向新目标，但旧名**不**进 aliases，
    //             重定向表是它唯一的落点。表一丢，[[甲]] 就真的成了死链。
    // 所以端到端意义上，这条用例才是重定向重建真正救回来的东西。
    writePage("a", frontmatterFor("01A", "甲"), "一");
    writePage("b", frontmatterFor("01B", "乙"), "二");
    reindexAll();
    deletePage("01A", { kind: "redirect", targetPageId: "01B" });

    dropAllIndexTables();
    reindexAll();

    // 引用是在重建之后才出现的 —— 它只能靠重定向表找到落点
    writePage("later", frontmatterFor("01LATER", "后写的"), "又见 [[甲]]。");
    reindexAll();

    const link = getDb().select().from(links).all().find((l) => l.srcPageId === "01LATER");
    expect(link?.dstPageId).toBe("01B");
  });
});
