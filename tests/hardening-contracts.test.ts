import fs from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { loadCheckpoint, saveCheckpoint, clearCheckpoint } from "@/lib/ingest/checkpoint";
import { AnalysisSchema } from "@/lib/llm/prompts";
import * as atomic from "@/lib/vault/atomic";
import { initialDataVersions, advanceDataVersions } from "@/lib/app-data-versions";
import { fail } from "@/lib/api";
import { estimateTokens } from "@/lib/ingest/parse/router";
import { estimateContextTokens } from "@/lib/chat/tokens";
import { splitMarkdown } from "@/lib/ingest/long-document";
import { resetVault, vaultRoot } from "./helpers";

beforeEach(() => { resetVault(); vi.restoreAllMocks(); });
afterEach(() => vi.restoreAllMocks());
const sourceId = "01M3W000000000000000000000";

it("分段检查点后续仅写新增结果，重启可读且兼容旧版", () => {
  clearCheckpoint(sourceId);
  const checkpoint = loadCheckpoint(sourceId, "hash");
  checkpoint.parsed = { markdown: "正文".repeat(5000), parser: "direct", pageCount: null, warnings: [], upgradeHint: null };
  checkpoint.chunks = Array(8).fill("分段正文");
  checkpoint.catalogHash = "目录";
  saveCheckpoint(sourceId, checkpoint);
  const write = vi.spyOn(atomic, "writeFileAtomic");
  for (let index = 0; index < 8; index++) {
    checkpoint.analyses.push(AnalysisSchema.parse({ gist: `已完成分段${index}`, language: "中文", entities: [], concepts: [], relations: [], overlaps: [], contradictions: [], gaps: [] }));
    saveCheckpoint(sourceId, checkpoint);
  }
  expect(write).toHaveBeenCalledTimes(8);
  expect(write.mock.calls.every(([file, content]) => file.includes(".parts") && String(content).length < 1000)).toBe(true);
  expect(loadCheckpoint(sourceId, "hash").analyses).toEqual(checkpoint.analyses);
  const legacy = path.join(vaultRoot(), ".weave/ingest-checkpoints", `${sourceId}.json`);
  fs.writeFileSync(legacy, JSON.stringify(checkpoint));
  expect(loadCheckpoint(sourceId, "hash").analyses).toEqual(checkpoint.analyses);
  clearCheckpoint(sourceId);
  expect(fs.readdirSync(path.dirname(legacy)).some(name => name.startsWith(sourceId))).toBe(false);
});

it("聊天刷新只失效会话，知识写入失效词条与体检，设置更新仅失效设置", () => {
  const sessions = advanceDataVersions(initialDataVersions, "sessions");
  expect(sessions).toEqual({ data: 0, knowledge: 0, sessions: 1, review: 0, settings: 0 });
  const knowledge = advanceDataVersions(sessions, "knowledge");
  expect(knowledge).toEqual({ data: 1, knowledge: 1, sessions: 1, review: 1, settings: 0 });
  expect(advanceDataVersions(knowledge, "settings")).toEqual({ ...knowledge, data: 2, settings: 1 });
});

it("API 错误码不随中文说明变更", async () => {
  expect((await fail("旧说明", 409).json()).code).toBe("CONFLICT");
  expect((await fail("新说明", 409).json()).code).toBe("CONFLICT");
  expect((await fail("缺少配置", 412).json()).code).toBe("PRECONDITION_FAILED");
});

it("导入、分段和聊天的 token 口径相同，中文标点和页码仍计入预算", () => {
  const text = "<!-- page:3 -->\n\n" + "中文全角标点，。Ａ！".repeat(100);
  expect(estimateTokens(text)).toBe(estimateContextTokens(text));
  const chunks = splitMarkdown(text, 200);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every(chunk => estimateContextTokens(chunk) <= 200)).toBe(true);
  expect(chunks.every(chunk => chunk.includes("<!-- page:3 -->"))).toBe(true);
});
