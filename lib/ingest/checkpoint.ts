import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
type Cursor = { generation: string; parsed: IngestCheckpoint["parsed"]; chunks: string[]; catalogHash: string; hash: string; analyses: number; drafts: number };
const cursors = new WeakMap<IngestCheckpoint, Cursor>();
function partsFor(sourceId: string, generation: string) { return `${fileFor(sourceId)}.${generation}.parts`; }
function fileFor(sourceId: string) {
  if (!/^[0-9A-Z]{26}$/.test(sourceId)) throw new Error("无效的资料标识。");
  return path.join(WORK_DIR, "ingest-checkpoints", `${sourceId}.json`);
}
export function loadCheckpoint(sourceId: string, hash: string): IngestCheckpoint {
  try {
    const saved = JSON.parse(fs.readFileSync(fileFor(sourceId), "utf8"));
    if (saved.version === 2) {
      const generation = z.uuid().parse(saved.generation);
      const directory = partsFor(sourceId, generation);
      const parts = (stage: "analyses" | "drafts") => {
        const items: unknown[] = [];
        for (let index = 0; index < (saved.chunks?.length ?? 0); index++) {
          const file = path.join(directory, `${stage}-${index}.json`);
          if (!fs.existsSync(file)) break;
          items.push(JSON.parse(fs.readFileSync(file, "utf8")));
        }
        return items;
      };
      const checkpoint = CheckpointSchema.parse({ ...saved, version: 1, analyses: parts("analyses"), drafts: parts("drafts") });
      if (checkpoint.hash === hash) {
        cursors.set(checkpoint, { generation, parsed: checkpoint.parsed, chunks: checkpoint.chunks, catalogHash: checkpoint.catalogHash, hash, analyses: checkpoint.analyses.length, drafts: checkpoint.drafts.length });
        return checkpoint;
      }
    } else {
      const checkpoint = CheckpointSchema.parse(saved);
      if (checkpoint.hash === hash) return checkpoint;
    }
  } catch { /* 旧版或不完整缓存不能阻塞重新处理。 */ }
  return { version: 1, hash, catalogHash: "", chunks: [], analyses: [], drafts: [] };
}
export function saveCheckpoint(sourceId: string, checkpoint: IngestCheckpoint) {
  let cursor = cursors.get(checkpoint);
  let metadata: string | undefined;
  if (!cursor || cursor.parsed !== checkpoint.parsed || cursor.chunks !== checkpoint.chunks || cursor.catalogHash !== checkpoint.catalogHash || cursor.hash !== checkpoint.hash || checkpoint.analyses.length < cursor.analyses || checkpoint.drafts.length < cursor.drafts) {
    const generation = randomUUID();
    // 大字段只在解析/分段/目录版本变化时写一次；后续仅写新完成的分段。
    metadata = JSON.stringify({ version: 2, generation, hash: checkpoint.hash, catalogHash: checkpoint.catalogHash, parsed: checkpoint.parsed, chunks: checkpoint.chunks });
    cursor = { generation, parsed: checkpoint.parsed, chunks: checkpoint.chunks, catalogHash: checkpoint.catalogHash, hash: checkpoint.hash, analyses: 0, drafts: 0 };
  }
  const directory = partsFor(sourceId, cursor.generation);
  for (const stage of ["analyses", "drafts"] as const) {
    while (cursor[stage] < checkpoint[stage].length) {
      const index = cursor[stage];
      writeFileAtomic(path.join(directory, `${stage}-${index}.json`), JSON.stringify(checkpoint[stage][index]));
      cursor[stage]++;
    }
  }
  if (metadata) writeFileAtomic(fileFor(sourceId), metadata);
  cursors.set(checkpoint, cursor);
}
export function clearCheckpoint(sourceId: string) {
  const file = fileFor(sourceId);
  fs.rmSync(file, { force: true });
  const directory = path.dirname(file);
  if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
    if (name.startsWith(`${sourceId}.json.`) && name.endsWith(".parts")) fs.rmSync(path.join(directory, name), { recursive: true, force: true });
  }
}
