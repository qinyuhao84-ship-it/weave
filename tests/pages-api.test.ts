import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/pages/route";
import { dropAllIndexTables } from "@/lib/db/client";
import { reindexAll } from "@/lib/index/reindex";
import { frontmatterFor, resetVault, writePage } from "./helpers";

beforeEach(() => {
  resetVault();
  dropAllIndexTables();
});

describe("GET /api/pages", () => {
  it("可翻到默认 500 条上限之后，并返回全库总数", async () => {
    for (let index = 0; index < 503; index++) {
      const suffix = String(index).padStart(4, "0");
      writePage(`page-${suffix}`, frontmatterFor(`01PAGE${suffix}`, `页面${suffix}`), `第 ${suffix} 条内容。`);
    }
    reindexAll();

    const response = await GET(new Request("http://localhost/api/pages?limit=50&offset=500"));
    const payload = await response.json();

    expect(payload.data.total).toBe(503);
    expect(payload.data.offset).toBe(500);
    expect(payload.data.pages).toHaveLength(3);
  });

  it("服务端按标题、别名、标签与类型筛选", async () => {
    writePage("target", frontmatterFor("01TARGET", "目标词条", { type: "concept", tags: ["数字检索"], aliases: ["目标别名"] }), "内容。", "concept");
    writePage("other", frontmatterFor("01OTHER", "其他词条"), "内容。", "entity");
    reindexAll();

    const response = await GET(new Request("http://localhost/api/pages?limit=50&q=%E7%9B%AE%E6%A0%87%E5%88%AB%E5%90%8D&type=concept"));
    const payload = await response.json();
    expect(payload.data.total).toBe(1);
    expect(payload.data.pages[0].title).toBe("目标词条");
    expect(payload.data.counts.concept).toBe(1);
    expect(payload.data.counts.entity).toBe(1);
  });
});
