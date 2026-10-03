import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

let tempDir: string | null = null;
let sqlite: Database.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

it("从 0011 数据库迁移时保留会话、用户裁决与旧摘要，并只唯一约束活跃路径", () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "weave-migration-"));
  sqlite = new Database(path.join(tempDir, "old-schema.db"));
  const migrationDir = path.join(process.cwd(), "drizzle");
  const oldMigrations = fs.readdirSync(migrationDir)
    .filter(file => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) <= 11)
    .sort();
  for (const file of oldMigrations) sqlite.exec(fs.readFileSync(path.join(migrationDir, file), "utf8"));

  sqlite.prepare("INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("session-1", "保留的会话", "2026-01-01", "2026-01-02");
  sqlite.prepare("INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("message-1", "session-1", "user", "原始问题", "2026-01-01");
  sqlite.prepare(`INSERT INTO review_items (id, kind, title, status, decision_note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run("decision-1", "contradiction", "用户裁决", "dismissed", "保留人工判断", "2026-01-01");
  sqlite.prepare(`INSERT INTO chat_summaries
    (session_id, content, covered_to_message_id, covered_message_count, compression_count, token_count, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("session-1", "原摘要", "message-1", 1, 2, 12, "fixture", "2026-01-01", "2026-01-02");
  sqlite.prepare(`INSERT INTO pages
    (id, slug, type, title, file_path, content_hash, frontmatter_json, normalized_names, status, created_at, updated_at, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("active-1", "page", "entity", "词条", "wiki/entities/page.md", "hash", "{}", "[]", "active", "2026-01-01", "2026-01-01", "2026-01-01");

  sqlite.exec(fs.readFileSync(path.join(migrationDir, "0012_history_policy_and_active_paths.sql"), "utf8"));

  expect(sqlite.prepare("SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = ?").get("session-1"))
    .toEqual({ id: "session-1", title: "保留的会话", created_at: "2026-01-01", updated_at: "2026-01-02" });
  expect(sqlite.prepare("SELECT status, decision_note FROM review_items WHERE id = ?").get("decision-1"))
    .toEqual({ status: "dismissed", decision_note: "保留人工判断" });
  expect(sqlite.prepare("SELECT content, covered_message_count, history_policy FROM chat_summaries WHERE session_id = ?").get("session-1"))
    .toEqual({ content: "原摘要", covered_message_count: 1, history_policy: "legacy" });

  sqlite.prepare(`INSERT INTO pages
    (id, slug, type, title, file_path, content_hash, frontmatter_json, normalized_names, status, created_at, updated_at, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("old-1", "old", "entity", "旧身份", "wiki/entities/page.md", "hash", "{}", "[]", "deleted", "2026-01-01", "2026-01-01", "2026-01-01");
  expect(() => sqlite!.prepare(`INSERT INTO pages
    (id, slug, type, title, file_path, content_hash, frontmatter_json, normalized_names, status, created_at, updated_at, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("active-2", "page-2", "entity", "重复活跃路径", "wiki/entities/page.md", "hash", "{}", "[]", "active", "2026-01-01", "2026-01-01", "2026-01-01"))
    .toThrow(/UNIQUE constraint failed/);
});
