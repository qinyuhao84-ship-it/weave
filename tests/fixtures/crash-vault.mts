import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearKnowledgeBase, restoreArchiveBatch, purgeTrash } from "../../lib/vault/archive-batches";
import { renamePage } from "../../lib/vault/service";

const root = process.env.WEAVE_VAULT ?? "";
if (process.env.WEAVE_CRASH_TEST !== "1" || !path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith("weave-test-")) throw new Error("中断夹具只能操作隔离测试库。");
const [phase, pageId, operation = "rename"] = process.argv.slice(2);
const rename = fs.renameSync;
const unlink = fs.unlinkSync;
if (phase === "writing") fs.renameSync = (...args) => {
  rename(...args);
  const destination = String(args[1]);
  if ((operation === "rename" && destination.includes(`${path.sep}wiki${path.sep}`)) ||
      (operation === "clear" && destination.includes(`${path.sep}trash${path.sep}batches${path.sep}`) && destination.endsWith(`${path.sep}wiki`)) ||
      (operation === "purge" && destination.includes(`${path.sep}trash-purge-`))) process.kill(process.pid, "SIGKILL");
};
else if (phase === "committed") fs.unlinkSync = (...args) => {
  if (String(args[0]).includes(`${path.sep}transactions${path.sep}`) && String(args[0]).endsWith(".json")) process.kill(process.pid, "SIGKILL");
  unlink(...args);
};
else throw new Error("未知中断阶段。");
if (phase === "writing" && operation === "restore") {
  const link = fs.linkSync;
  fs.linkSync = (...args) => { link(...args); if (String(args[1]).includes(`${path.sep}wiki${path.sep}`)) process.kill(process.pid, "SIGKILL"); };
}
if (operation === "clear") clearKnowledgeBase();
else if (operation === "restore") restoreArchiveBatch(pageId);
else if (operation === "purge") purgeTrash({ kind: "batch", id: pageId });
else renamePage(pageId, "中断后新名");
throw new Error("未触发预期的中断。");
