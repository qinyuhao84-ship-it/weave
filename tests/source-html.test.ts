import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { getDb, dropAllIndexTables } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { RAW_DIR } from "@/lib/vault/paths";
import { GET } from "@/app/api/sources/[id]/raw/route";
import { resetVault } from "./helpers";

const html = '<!DOCTYPE html><html><body><h1>原始 HTML</h1><button onclick="this.textContent=\'已展开\'">展开</button><script>window.testReady=true;</script><script src="https://outside.example/a.js"></script></body></html>';
beforeEach(() => {
  resetVault(); dropAllIndexTables();
  getDb().delete(sources).run();
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(path.join(RAW_DIR, "fixture.html"), html);
  getDb().insert(sources).values({ id: "HTML-SOURCE", originalName: "fixture.html", mimeType: "text/html", docPath: "raw/fixture.html", sha256: "fixture-hash", byteSize: Buffer.byteLength(html), importedAt: new Date().toISOString() }).run();
});
it("HTML 原件默认下载，预览只读取隔离渲染版本", async () => {
  const context = { params: Promise.resolve({ id: "HTML-SOURCE" }) };
  const download = await GET(new Request("http://localhost/api/sources/HTML-SOURCE/raw"), context);
  expect(await download.text()).toBe(html);
  expect(download.headers.get("Content-Disposition")).toContain("attachment");
  const preview = await GET(new Request("http://localhost/api/sources/HTML-SOURCE/raw?view=1"), context);
  const text = await preview.text();
  expect(text).toContain("原始 HTML"); expect(text).toContain("window.testReady=true"); expect(text).not.toContain("outside.example");
  expect(text).toContain("weave-artifact-escape");
  expect(preview.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
  expect(preview.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
});
it("原件路径越界与缺失仍被拒绝", async () => {
  const response = await GET(new Request("http://localhost/api/sources/missing/raw?view=1"), { params: Promise.resolve({ id: "missing" }) });
  expect(response.status).toBe(404);
});
