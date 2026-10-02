import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { indexMeta } from "@/lib/db/schema";
import { VAULT_ROOT, WORK_DIR, absolutePath, ensureVaultLayout } from "./paths";
import { readFileIfExists, writeFileAtomic, removeFileIfExists, syncDirectory } from "./atomic";

const journalDirectory = path.join(WORK_DIR, "transactions");
const Schema = z.object({
  version: z.literal(1), id: z.uuid(),
  files: z.array(z.object({ relative: z.string(), original: z.string().nullable(), next: z.string().nullable().optional() })),
  moves: z.array(z.object({ from: z.string(), to: z.string(), hashes: z.record(z.string(), z.string()) })).optional(),
  copies: z.array(z.object({ to: z.string(), hash: z.string() })).optional(),
  removeOnCommit: z.array(z.string()).optional(),
});
export type Journal = z.infer<typeof Schema>;
const markerKey = (id: string) => `vault-transaction:${id}`;
const fileFor = (id: string) => path.join(journalDirectory, `${id}.json`);

/** 恢复未完成时阻止后续写入覆盖证据；已提交但未清理的日志可安全保留。 */
export function hasUnfinishedVaultTransaction(): boolean {
  if (!fs.existsSync(journalDirectory)) return false;
  return fs.readdirSync(journalDirectory).filter(name => name.endsWith(".json")).some(name => {
    const id = name.slice(0, -5);
    return !getDb().select().from(indexMeta).where(eq(indexMeta.key, markerKey(id))).get();
  });
}

/** 必须在第一个文件修改前同步落盘；SQLite 标记在同一写入事务内提交。 */
export function prepareJournal(files: Journal["files"], operations: Pick<Journal, "moves" | "copies" | "removeOnCommit"> = {}): Journal {
  const journal: Journal = { version: 1, id: randomUUID(), files, ...operations };
  fs.mkdirSync(journalDirectory, { recursive: true });
  syncDirectory(WORK_DIR);
  writeFileAtomic(fileFor(journal.id), JSON.stringify(journal));
  return journal;
}
export function markJournalCommitted(id: string): void {
  getDb().insert(indexMeta).values({ key: markerKey(id), value: "committed", updatedAt: new Date().toISOString() }).run();
}
export function finishJournal(id: string): void {
  // 先移除日志，再删标记。反过来会将已提交写入误判成待回滚。
  removeFileIfExists(fileFor(id));
  getDb().delete(indexMeta).where(eq(indexMeta.key, markerKey(id))).run();
}


/** Persist an exact metadata intent before its atomic write. */
export function journalWriteIntent(journal: Journal, relative: string, next: string): void {
  const file = journal.files.find(file => file.relative === relative);
  if (!file) throw new Error("恢复日志缺少待写文件。");
  file.next = next;
  writeFileAtomic(fileFor(journal.id), JSON.stringify(journal));
}

export function journalRelative(target: string): string {
  return path.relative(VAULT_ROOT, target).split(path.sep).join("/");
}

export function fileDigest(target: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(target, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let length: number;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

export function directoryDigests(target: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!fs.existsSync(target)) return files;
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error("归档路径不能包含符号链接。");
  if (fs.statSync(target).isFile()) return { "": fileDigest(target) };
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("归档目录不能包含符号链接。");
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files[path.relative(target, next).split(path.sep).join("/")] = fileDigest(next);
    }
  };
  walk(target);
  return files;
}

function safeTarget(relative: string): string {
  const roots = ["wiki/", "raw/", "parsed/", ".weave/parsed", ".weave/trash/", ".weave/trash-purge-", ".weave/ingest-", ".weave/lint-checkpoints"];
  if (!(relative === "log.md" || relative === "index.md" || ["wiki", "raw", "parsed"].includes(relative) || roots.some(root => relative.startsWith(root))) || relative.includes("\\") || relative.split("/").some(part => part === ".." || part === ".") || path.isAbsolute(relative)) throw new Error("知识库恢复日志路径无效。");
  const target = absolutePath(relative);
  for (let current = target; current !== VAULT_ROOT; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("知识库恢复路径包含符号链接。");
  }
  return target;
}

function sameDigests(a: Record<string, string>, b: Record<string, string>): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([name, hash]) => b[name] === hash);
}

/** 只在服务启动、任务与 watcher 启动之前执行，不覆盖退出后的外部编辑。 */
export function recoverVaultTransactions(): number {
  ensureVaultLayout();
  if (!fs.existsSync(journalDirectory)) return 0;
  let recovered = 0;
  for (const name of fs.readdirSync(journalDirectory).filter(name => name.endsWith(".json")).sort()) {
    const journal = Schema.parse(JSON.parse(fs.readFileSync(path.join(journalDirectory, name), "utf8")));
    if (name !== `${journal.id}.json`) throw new Error("知识库恢复日志标识不一致。");
    const committed = getDb().select().from(indexMeta).where(eq(indexMeta.key, markerKey(journal.id))).get();
    if (!committed) {
      const checked = journal.files.map(file => {
        const target = safeTarget(file.relative);
        const current = readFileIfExists(target);
        if (file.relative !== "index.md" && current !== file.original && current !== file.next) {
          throw new Error("中断操作涉及的文件已被外部修改。已保留恢复日志与现有文件，请停止服务并核对完整备份。");
        }
        return { ...file, target };
      });
      // Preflight every directory and copied file before restoring anything.
      const moves = (journal.moves ?? []).map(move => {
        const from = safeTarget(move.from), to = safeTarget(move.to);
        if (fs.existsSync(to)) {
          if (!sameDigests(directoryDigests(to), move.hashes) || Object.keys(directoryDigests(from)).length) throw new Error("中断归档涉及的目录已被外部修改，已保留恢复日志和现有资料。");
        } else if (!sameDigests(directoryDigests(from), move.hashes)) throw new Error("中断归档涉及的目录已被外部修改，已保留恢复日志和现有资料。");
        return { from, to };
      });
      const copies = (journal.copies ?? []).map(copy => {
        const target = safeTarget(copy.to);
        if (fs.existsSync(target) && fileDigest(target) !== copy.hash) throw new Error("中断恢复涉及的文件已被外部修改，已保留恢复日志和现有资料。");
        return target;
      });
      for (const target of copies.reverse()) removeFileIfExists(target);
      for (const { from, to } of moves.reverse()) if (fs.existsSync(to)) {
        if (fs.existsSync(from)) fs.rmSync(from, { recursive: true });
        fs.mkdirSync(path.dirname(from), { recursive: true });
        fs.renameSync(to, from);
        syncDirectory(path.dirname(from)); syncDirectory(path.dirname(to));
      }
      for (const file of checked.reverse()) {
        if (file.original === null) removeFileIfExists(file.target);
        else writeFileAtomic(file.target, file.original);
      }
      recovered++;
    }
    if (committed) for (const relative of journal.removeOnCommit ?? []) {
      if (!/^\.weave\/trash-purge-[0-9A-HJKMNP-TV-Z]{26}$/.test(relative)) throw new Error("归档清理路径无效。");
      const target = safeTarget(relative);
      fs.rmSync(target, { recursive: true, force: true }); syncDirectory(path.dirname(target));
    }
    finishJournal(journal.id);
  }
  // 清理已经删除日志、尚未清理标记时退出的记录。
  for (const row of getDb().select().from(indexMeta).all()) {
    if (row.key.startsWith("vault-transaction:") && !fs.existsSync(fileFor(row.key.slice("vault-transaction:".length)))) {
      getDb().delete(indexMeta).where(eq(indexMeta.key, row.key)).run();
    }
  }
  return recovered;
}

/** 仅清理织识原子写入命名的临时文件，不删除编辑器的普通 .tmp 文件。 */
export function cleanAtomicTemps(directory = VAULT_ROOT): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && ![".git", ".obsidian", "config"].includes(entry.name)) cleanAtomicTemps(target);
    else if (entry.isFile() && /^\..+\.\d+\.(?:\d{13}|[0-9a-f-]{36})\.tmp$/.test(entry.name)) {
      fs.unlinkSync(target);
      syncDirectory(directory);
    }
  }
}
