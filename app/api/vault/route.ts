import { handle } from "@/lib/api";
import { getSqlite } from "@/lib/db/client";
import { reindexAll } from "@/lib/index/reindex";
import { rebuildIndexFile } from "@/lib/index/index-file";
import { ensureVaultLayout, VAULT_ROOT, RAW_DIR, WIKI_DIR, WORK_DIR } from "@/lib/vault/paths";
import { commitVault, ensureGitRepo, hasUncommittedChanges } from "@/lib/git/auto-commit";
import { graphStats } from "@/lib/index/catalog";
import fs from "node:fs";
import { isVaultPathOverridden, pendingVaultMove } from "@/lib/vault/location";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 知识库状态总览：路径、规模、索引健康度 */
export async function GET() {
  return handle(() => {
    ensureVaultLayout();
    ensureGitRepo();
    const sqlite = getSqlite();
    const dbSize = fs.existsSync(WORK_DIR)
      ? fs.statSync(`${WORK_DIR}/weave.db`).size
      : 0;

    return {
      vaultRoot: VAULT_ROOT,
      canOpenLocation: process.platform === "darwin",
      canChangeLocation: process.platform === "darwin" && !isVaultPathOverridden(),
      pendingVaultRoot: pendingVaultMove()?.to ?? null,
      rawDir: RAW_DIR,
      wikiDir: WIKI_DIR,
      stats: graphStats(),
      dbSizeBytes: dbSize,
      hasUncommitted: hasUncommittedChanges(),
      /** 索引与文件的条目数是否一致，不一致说明需要重建 */
      indexHealthy: checkIndexHealth(),
      ftsRows: (
        sqlite.prepare("SELECT COUNT(*) AS n FROM pages_fts").get() as { n: number }
      ).n,
    };
  });
}

/**
 * 全量重建索引。
 *
 * 仅从 Markdown 重建派生的词条、链接与全文检索索引，保留会话、草稿、
 * 来源与裁决等应用记录。整个 SQLite 数据库不可删除后重建。
 */
export async function POST() {
  return handle(() => {
    ensureVaultLayout();
    const report = reindexAll();
    rebuildIndexFile();
    // 重建会重写 index.md —— 它是 vault 根目录里被 git 跟踪的文件。
    // 不提交的话工作区永远脏着：「改动记录」页会常驻显示「有改动正在写入」，
    // 而实际什么都没在写；重建出的目录也永远进不了版本历史。
    // 所有写路径都必须以一次提交收尾（CLAUDE.md 不变式 2）。
    const { sha } = commitVault("从 Markdown 重建索引");
    return {
      commitSha: sha,
      ...report,
      note: `索引已从 ${report.pages} 个词条重建完成。`,
    };
  });
}

function checkIndexHealth(): boolean {
  try {
    const sqlite = getSqlite();
    const indexed = (sqlite.prepare("SELECT COUNT(*) AS n FROM pages WHERE status = 'active'").get() as { n: number }).n;
    const onDisk = countMarkdownFiles(WIKI_DIR);
    return indexed === onDisk;
  } catch {
    return false;
  }
}

function countMarkdownFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) count += countMarkdownFiles(full);
    else if (entry.name.endsWith(".md")) count++;
  }
  return count;
}
