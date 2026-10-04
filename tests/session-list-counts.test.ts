import { beforeEach, expect, it } from "vitest";
import { getSqlite } from "@/lib/db/client";
import { listSessions, listTrashedSessions } from "@/lib/chat/sessions";

beforeEach(() => {
  const sqlite = getSqlite();
  sqlite.exec("DELETE FROM chat_runs; DELETE FROM chat_messages; DELETE FROM chat_sessions;");
  const session = sqlite.prepare("INSERT INTO chat_sessions(id, title, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)");
  const message = sqlite.prepare("INSERT INTO chat_messages(id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)");
  sqlite.transaction(() => {
    for (const [id, title, date, deletedAt, count] of [
      ["latest", "专题最新", "2026-10-04", null, 3],
      ["empty", "专题空白", "2026-10-03", null, 0],
      ["older", "普通旧会话", "2026-10-02", null, 7],
      ["trashed", "已删除会话", "2026-10-01", "2026-10-04", 5],
    ] as const) {
      session.run(id, title, date, date, deletedAt);
      for (let i = 0; i < count; i++) message.run(`${id}-${i}`, id, "独立测试知识库中真实保存的消息。", date);
    }
    sqlite.prepare("INSERT INTO chat_runs(id, session_id, question_message_id, assistant_message_id, status, created_at, updated_at) VALUES ('running', 'latest', 'latest-0', 'latest-1', 'running', '2026-10-04', '2026-10-04')").run();
  })();
});

it("分页和搜索只返回所选会话的准确计数，并保留正在生成的状态", () => {
  expect(listSessions(1).map(({ id, messageCount, generating, activeRunId }) => ({ id, messageCount, generating, activeRunId }))).toEqual([
    { id: "latest", messageCount: 3, generating: true, activeRunId: "running" },
  ]);
  expect(listSessions(1, 1, "专题").map(({ id, messageCount, generating, activeRunId }) => ({ id, messageCount, generating, activeRunId }))).toEqual([
    { id: "empty", messageCount: 0, generating: false, activeRunId: null },
  ]);
  expect(listSessions(1, 2).map(({ id, messageCount }) => ({ id, messageCount }))).toEqual([{ id: "older", messageCount: 7 }]);
  expect(listSessions(20, 0, "没有对应标题")).toEqual([]);
});

it("会话回收站的消息数量独立于活跃会话，空分页保持为空", () => {
  expect(listTrashedSessions().map(({ id, messageCount, generating, activeRunId }) => ({ id, messageCount, generating, activeRunId }))).toEqual([
    { id: "trashed", messageCount: 5, generating: false, activeRunId: null },
  ]);
  expect(listTrashedSessions(0)).toEqual([]);
});
