/** 恢复上次进程退出时遗留的后台任务状态。 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // 先完成待执行的知识库迁移，再加载会固定 VAULT_ROOT 的模块。
  const { applyPendingVaultMove } = await import("@/lib/vault/location");
  applyPendingVaultMove();

  const { markInterruptedAsFailed, findInterruptedJobs } = await import("@/lib/jobs/runner");
  const interrupted = findInterruptedJobs().filter(job => ["queued", "running"].includes(job.status));
  const count = markInterruptedAsFailed();
  if (count > 0) console.warn(`[jobs] 已保留 ${count} 个中断任务的进度与草稿。`);
  // 让 Finder / Obsidian 中直接修改的 Markdown 在几秒内重建索引并通知前端。
  const { startWatcher } = await import("@/lib/index/watcher");
  await startWatcher();
  const { recoverInterruptedIngests } = await import("@/lib/ingest/pipeline");
  recoverInterruptedIngests(interrupted.filter(job => job.kind === "ingest").map(job => job.id));
  const { startLintJob } = await import("@/lib/lint");
  for (const job of interrupted.filter(job => job.kind === "lint")) {
    try { startLintJob({ mechanicalOnly: Boolean((job.payload as { mechanicalOnly?: boolean })?.mechanicalOnly), resumeJobId: job.id }); }
    catch { /* 配置不可用时保留任务，用户可在体检页重新检查。 */ }
  }

  const {
    markInterruptedChatRunsFailed,
    markInterruptedSessionTitleSummariesFailed,
  } = await import("@/lib/chat/sessions");
  const interruptedChats = markInterruptedChatRunsFailed();
  if (interruptedChats > 0) {
    console.warn(`[chat] 已将 ${interruptedChats} 个中断回答标记为失败并保留部分正文。`);
  }
  const interruptedTitles = markInterruptedSessionTitleSummariesFailed();
  if (interruptedTitles > 0) {
    console.warn(`[chat] 已将 ${interruptedTitles} 个中断的会话名称总结标记为失败。`);
  }

}
