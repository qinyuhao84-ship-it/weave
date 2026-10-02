import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import * as schema from "./schema";
import { DB_FILE, ensureVaultLayout } from "@/lib/vault/paths";

export type WeaveDb = BetterSQLite3Database<typeof schema>;

type Connection = {
  sqlite: Database.Database;
  db: WeaveDb;
};

/**
 * 用 globalThis 缓存连接：Next.js 在开发模式会重复求值模块，
 * 不做缓存会开出多个 SQLite 句柄，WAL 模式下容易互相阻塞。
 */
const globalForDb = globalThis as unknown as { __weaveDb?: Connection };

/**
 * 全文检索的虚拟表。
 *
 * 分词器选 trigram 而不是默认的 unicode61 —— 这是个关键决定：
 * unicode61 按空白与标点切词，而中文没有空格，会把整段中文当成一个 token，
 * 导致「推荐算法」搜不到「字节跳动的创始人，提出推荐算法是核心」。
 * trigram 按三字滑窗建索引，对中英文都能做子串匹配。
 *
 * 代价：trigram 要求查询词至少 3 个字符，短词查不到，需要在查询层用 LIKE 兜底。
 */
const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  page_id UNINDEXED,
  title,
  body,
  tags,
  tokenize='trigram'
);
`;

/** 名称属于派生索引；触发器确保改名、删除与名称检索同事务生效。 */
const NAMES_DDL = `
CREATE TABLE IF NOT EXISTS page_names (name TEXT NOT NULL, page_id TEXT NOT NULL, PRIMARY KEY(name, page_id));
CREATE INDEX IF NOT EXISTS idx_page_names_page ON page_names(page_id);
CREATE TRIGGER IF NOT EXISTS page_names_insert AFTER INSERT ON pages WHEN new.status = 'active' BEGIN
  INSERT INTO page_names SELECT DISTINCT value, new.id FROM json_each(new.normalized_names) WHERE value <> '' ON CONFLICT(name, page_id) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS page_names_update AFTER UPDATE OF normalized_names, status ON pages BEGIN
  DELETE FROM page_names WHERE page_id = old.id;
  INSERT INTO page_names SELECT DISTINCT value, new.id FROM json_each(new.normalized_names) WHERE new.status = 'active' AND value <> '' ON CONFLICT(name, page_id) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS page_names_delete AFTER DELETE ON pages BEGIN
  DELETE FROM page_names WHERE page_id = old.id;
END;
INSERT OR IGNORE INTO page_names SELECT names.value, pages.id FROM pages, json_each(pages.normalized_names) AS names WHERE pages.status = 'active' AND names.value <> '';
`;

const EMBEDDINGS_DDL = `
CREATE TABLE IF NOT EXISTS page_embeddings (
  profile TEXT NOT NULL, page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk_start INTEGER NOT NULL,
  dimensions INTEGER NOT NULL, vector BLOB NOT NULL,
  PRIMARY KEY(profile, page_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_page_embeddings_page ON page_embeddings(page_id);
CREATE TRIGGER IF NOT EXISTS page_embeddings_update AFTER UPDATE OF content_hash, status, title, file_path ON pages
WHEN old.content_hash <> new.content_hash OR old.status <> new.status OR old.title <> new.title OR old.file_path <> new.file_path BEGIN
  DELETE FROM page_embeddings WHERE page_id = new.id;
END;
`;

/** 建立表结构。迁移是幂等的，重复调用安全。 */
function initialize(sqlite: Database.Database, db: WeaveDb): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = FULL");
  sqlite.pragma("busy_timeout = 5000");

  const migrationsFolder = path.join(process.cwd(), "drizzle");
  try {
    migrate(db, { migrationsFolder });
  } catch (error) {
    // 表结构未迁移时继续启动会把后续错误伪装成随机查询故障。
    // 让服务明确失败，部署包必须包含 drizzle/ 迁移目录。
    throw new Error("[db] SQLite 迁移失败，服务无法安全启动。", { cause: error });
  }

  sqlite.exec(FTS_DDL);
  sqlite.exec(NAMES_DDL);
  sqlite.exec(EMBEDDINGS_DDL);
}

export function getConnection(): Connection {
  if (globalForDb.__weaveDb) return globalForDb.__weaveDb;

  ensureVaultLayout();
  const sqlite = new Database(DB_FILE);
  const db = drizzle(sqlite, { schema });
  initialize(sqlite, db);

  globalForDb.__weaveDb = { sqlite, db };
  return globalForDb.__weaveDb;
}

export function getDb(): WeaveDb {
  return getConnection().db;
}

export function getSqlite(): Database.Database {
  return getConnection().sqlite;
}

/** 关闭连接（测试与进程退出时用） */
export function closeDb(): void {
  if (!globalForDb.__weaveDb) return;
  globalForDb.__weaveDb.sqlite.close();
  globalForDb.__weaveDb = undefined;
}

/**
 * 测试库全量清空。
 *
 * 仅允许在隔离测试数据库调用：此方法删除所有 SQLite 表，包括无法从文件恢复的
 * 应用状态。生产环境修复索引应调用 reindexAll()，它会保留用户记录。
 */
export function dropAllIndexTables(): void {
  const sqlite = getSqlite();
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_drizzle%'")
    .all() as Array<{ name: string }>;
  sqlite.pragma("foreign_keys = OFF");
  for (const { name } of tables) {
    sqlite.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  sqlite.pragma("foreign_keys = ON");
  initialize(sqlite, getDb());
}
