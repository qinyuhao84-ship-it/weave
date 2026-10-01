import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WORK_DIR } from "@/lib/vault/paths";
import { writeFileAtomic } from "@/lib/vault/atomic";
import { AnalysisSchema, DraftSchema } from "@/lib/llm/prompts";

const CheckpointSchema = z.object({
  version: z.literal(1), hash: z.string(), catalogHash: z.string().default(""),
  parsed: z.object({ markdown: z.string(), parser: z.string(), pageCount: z.number().nullable(), warnings: z.array(z.string()), upgradeHint: z.string().nullable() }).optional(),
  chunks: z.array(z.string()).default([]),
  analyses: z.array(AnalysisSchema).default([]), drafts: z.array(DraftSchema).default([]),
}).refine(value => value.analyses.length <= value.chunks.length && value.drafts.length <= value.analyses.length && (!value.chunks.length || Boolean(value.parsed)));
export type IngestCheckpoint = z.infer<typeof CheckpointSchema>;
function fileFor(sourceId: string) {
  if (!/^[0-9A-Z]{26}$/.test(sourceId)) throw new Error("无效的资料标识。");
  return path.join(WORK_DIR, "ingest-checkpoints", `${sourceId}.json`);
}
export function loadCheckpoint(sourceId: string, hash: string): IngestCheckpoint {
  try {
    const checkpoint = CheckpointSchema.parse(JSON.parse(fs.readFileSync(fileFor(sourceId), "utf8")));
    if (checkpoint.hash === hash) return checkpoint;
  } catch { /* 旧版或不完整缓存不能阻塞重新处理。 */ }
  return { version: 1, hash, catalogHash: "", chunks: [], analyses: [], drafts: [] };
}
export function saveCheckpoint(sourceId: string, checkpoint: IngestCheckpoint) {
  writeFileAtomic(fileFor(sourceId), JSON.stringify(checkpoint));
}
export function clearCheckpoint(sourceId: string) {
  fs.rmSync(fileFor(sourceId), { force: true });
}
