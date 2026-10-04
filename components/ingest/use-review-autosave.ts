"use client";
import * as React from "react";
import { apiFetch } from "@/hooks/use-api";
import type { Draft, IngestDraft, ReviewDecisionDraft } from "./ingest-provider";

export type Snapshot = { draft: Draft; reviewState: { skippedTitles: string[]; decisions: Array<[number, ReviewDecisionDraft]> } };
type CachedReview = { revision: number; snapshot: Snapshot; sentSnapshot?: Snapshot | null; savedAt?: number; cacheVersion?: string };
export type RecoverableReviewDraft = { key: string; savedAt: number; title: string; cacheVersion: string };
function legacyCacheVersion(raw: string): string {
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  return `legacy-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
}
function getCacheVersion(raw: string, cache: CachedReview): string {
  return cache.cacheVersion ?? legacyCacheVersion(raw);
}
function parseCachedReview(raw: string | null): CachedReview | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as Partial<CachedReview> | null;
  if (!value?.snapshot?.draft) return null;
  const reviewState = value.snapshot.reviewState ?? { skippedTitles: [], decisions: [] };
  if (!Array.isArray(reviewState.skippedTitles) || !Array.isArray(reviewState.decisions)) return null;
  return {
    revision: typeof value.revision === "number" ? value.revision : 0,
    snapshot: { draft: value.snapshot.draft, reviewState },
    sentSnapshot: value.sentSnapshot ?? null,
    savedAt: typeof value.savedAt === "number" && Number.isFinite(value.savedAt) ? value.savedAt : undefined,
    cacheVersion: typeof value.cacheVersion === "string" && value.cacheVersion.length > 0 ? value.cacheVersion : undefined,
  };
}
/** 只有服务端内容等于本浏览器刚发送的版本，才接续刷新前尚未发送的输入。 */
export function canResumePendingReview(local: CachedReview, serverRevision: number, server: Snapshot): boolean {
  return local.revision + 1 === serverRevision && Boolean(local.sentSnapshot) && JSON.stringify(local.sentSnapshot) === JSON.stringify(server);
}
const legacyCacheKey = (id: string) => `weave-ingest-review:${id}`;
const tabCacheKey = (id: string, tabId: string) => `${legacyCacheKey(id)}:tab:${tabId}`;
const legacyMigratedKey = (id: string) => `weave-ingest-review-migrated:${id}`;
const ignoreLegacyKey = (id: string) => `weave-ingest-review-ignore-legacy:${id}`;
const TAB_SESSION_ID_KEY = "weave-ingest-review-tab-id";

/** 本机缓存立即保存输入；服务器保存串行执行，刷新不会丢防抖窗口里的编辑。 */
export function useReviewAutosave(active: boolean, jobId: string | null, draft: IngestDraft | null, skipped: Set<string>, decisions: Map<number, ReviewDecisionDraft>) {
  const identity = React.useRef<string | null>(null);
  const revision = React.useRef(0);
  const saved = React.useRef("");
  const latest = React.useRef<Snapshot | null>(null);
  const inFlight = React.useRef<Promise<void> | null>(null);
  const cached = React.useRef(false);
  const sending = React.useRef<Snapshot | null>(null);
  const recoveredSource = React.useRef<{ jobId: string; key: string; version: string } | null>(null);
  const tabId = React.useRef<string | null>(null);
  const tabIdPersisted = React.useRef(false);
  const [status, setStatus] = React.useState("已保存");
  const [error, setError] = React.useState<string | null>(null);
  const [recoverableDrafts, setRecoverableDrafts] = React.useState<RecoverableReviewDraft[]>([]);

  const getTabCacheKey = React.useCallback((id: string) => {
    if (!tabId.current) {
      try {
        const savedId = sessionStorage.getItem(TAB_SESSION_ID_KEY);
        const nextId = savedId && !window.opener ? savedId : crypto.randomUUID();
        if (nextId !== savedId) sessionStorage.setItem(TAB_SESSION_ID_KEY, nextId);
        tabId.current = nextId;
        tabIdPersisted.current = true;
      } catch {
        // 没有可恢复的标签页编号时，不写共享缓存，离开页面时会提醒用户。
        tabId.current = crypto.randomUUID();
        tabIdPersisted.current = false;
      }
    }
    return tabId.current ? tabCacheKey(id, tabId.current) : null;
  }, []);

  const writeCache = React.useCallback((id: string, value: CachedReview) => {
    const key = getTabCacheKey(id);
    if (!key || !tabIdPersisted.current) {
      cached.current = false;
      return;
    }
    try {
      const nextVersion = crypto.randomUUID();
      localStorage.setItem(key, JSON.stringify({ ...value, savedAt: Date.now(), cacheVersion: nextVersion }));
      localStorage.removeItem(`${key}:recovered`);
      cached.current = true;
      if (JSON.stringify(value.snapshot) !== saved.current) setRecoverableDrafts([]);
    } catch {
      cached.current = false;
    }
  }, [getTabCacheKey]);

  const findRecoverableDrafts = React.useCallback((id: string, ownKey: string | null) => {
    const prefix = `${legacyCacheKey(id)}:tab:`;
    const currentServerSnapshot = saved.current;
    const found: RecoverableReviewDraft[] = [];
    try {
      const ownRaw = ownKey ? localStorage.getItem(ownKey) : null;
      const ownValue = parseCachedReview(ownRaw);
      if (ownRaw && (!ownValue || JSON.stringify(ownValue.snapshot) !== currentServerSnapshot)) {
        setRecoverableDrafts([]);
        return;
      }
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(prefix) || key === ownKey || key.endsWith(":recovered")) continue;
        try {
          const raw = localStorage.getItem(key);
          const value = parseCachedReview(raw);
          if (!value) continue;
          if (JSON.stringify(value.snapshot) === currentServerSnapshot) continue;
          const version = getCacheVersion(raw!, value);
          if (localStorage.getItem(`${key}:recovered`) === version) continue;
          found.push({
            key,
            savedAt: value.savedAt ?? 0,
            title: value.snapshot.draft.sourceSummary?.title ?? "",
            cacheVersion: version,
          });
        } catch {
          // 损坏的副本不应阻止查找其他可恢复副本。
        }
      }
      const legacyKey = legacyCacheKey(id);
      const legacyRaw = localStorage.getItem(legacyKey);
      const legacy = parseCachedReview(legacyRaw);
      if (legacy && JSON.stringify(legacy.snapshot) !== currentServerSnapshot) {
        const version = getCacheVersion(legacyRaw!, legacy);
        if (localStorage.getItem(`${legacyKey}:recovered`) === version) {
          setRecoverableDrafts(found.sort((a, b) => b.savedAt - a.savedAt));
          return;
        }
        found.push({
          key: legacyKey,
          savedAt: legacy.savedAt ?? 0,
          title: legacy.snapshot.draft.sourceSummary?.title ?? "",
          cacheVersion: version,
        });
      }
      setRecoverableDrafts(found.sort((a, b) => b.savedAt - a.savedAt));
    } catch {
      setRecoverableDrafts([]);
    }
  }, []);

  const readCache = React.useCallback((id: string, ignoreLocal: boolean): CachedReview | null => {
    const ownKey = getTabCacheKey(id);
    findRecoverableDrafts(id, ownKey);
    if (ignoreLocal) {
      try { if (ownKey && tabIdPersisted.current) localStorage.removeItem(ownKey); } catch { /* 本地缓存不可用 */ }
      try { sessionStorage.setItem(ignoreLegacyKey(id), "1"); } catch { /* 本地缓存不可用 */ }
      cached.current = false;
      return null;
    }

    if (ownKey && tabIdPersisted.current) {
      try {
        const ownValue = localStorage.getItem(ownKey);
        if (ownValue) {
          cached.current = true;
          try { localStorage.setItem(legacyMigratedKey(id), "1"); } catch { /* 仍可读取标签页自己的缓存 */ }
          return parseCachedReview(ownValue);
        }
      } catch {
        cached.current = false;
        return null;
      }
    }

    try {
      if (sessionStorage.getItem(ignoreLegacyKey(id)) === "1") return null;
      if (localStorage.getItem(legacyMigratedKey(id)) === "1") return null;
      const legacyValue = localStorage.getItem(legacyCacheKey(id));
      if (!legacyValue) {
        if (tabIdPersisted.current) {
          try { localStorage.setItem(legacyMigratedKey(id), "1"); } catch { /* 不影响读取服务端版本 */ }
        }
        return null;
      }
      const restored = parseCachedReview(legacyValue);
      if (!restored) return null;
      if (ownKey && tabIdPersisted.current) {
        localStorage.setItem(ownKey, legacyValue);
        cached.current = true;
        try { localStorage.setItem(legacyMigratedKey(id), "1"); } catch { /* 标签页副本已经安全保存 */ }
      } else {
        cached.current = false;
      }
      return restored;
    } catch {
      cached.current = false;
      return null;
    }
  }, [findRecoverableDrafts, getTabCacheKey]);

  React.useEffect(() => {
    if (!active || !jobId || identity.current !== jobId) return;
    const prefix = `${legacyCacheKey(jobId)}:tab:`;
    const refreshCopies = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(prefix)) findRecoverableDrafts(jobId, getTabCacheKey(jobId));
    };
    window.addEventListener("storage", refreshCopies);
    return () => window.removeEventListener("storage", refreshCopies);
  }, [active, findRecoverableDrafts, getTabCacheKey, jobId]);

  const restore = React.useCallback((server: IngestDraft, ignoreLocal = false): Snapshot => {
    if (ignoreLocal || (recoveredSource.current && recoveredSource.current.jobId !== server.jobId)) recoveredSource.current = null;
    identity.current = server.jobId;
    cached.current = false;
    revision.current = server.reviewRevision ?? 0;
    sending.current = null;
    const snapshot: Snapshot = { draft: server.draft, reviewState: server.reviewState ?? { skippedTitles: [], decisions: [] } };
    saved.current = JSON.stringify(snapshot);
    latest.current = snapshot;
    setStatus("已保存"); setError(null);
    const local = readCache(server.jobId, ignoreLocal);
    if (local?.snapshot && (local.revision === revision.current || canResumePendingReview(local, revision.current, snapshot))) return local.snapshot;
    // 服务端已经收到上一次保存：只丢掉相同的本地副本，保留冲突副本供用户复制。
    if (local?.snapshot && JSON.stringify(local.snapshot) !== saved.current) {
      revision.current = local.revision;
      setStatus("仅保存在此浏览器");
      setError("草稿已在另一页面更新。当前修改保留在此浏览器，请复制需要的内容后载入已保存版本。");
      return local.snapshot;
    }
    return snapshot;
  }, [readCache]);

  const flush = React.useCallback(async function flushPending(): Promise<void> {
    if (inFlight.current) { await inFlight.current; return flushPending(); }
    const id = identity.current;
    const task = async () => {
      while (id && identity.current === id && latest.current && JSON.stringify(latest.current) !== saved.current) {
        const snapshot = latest.current;
        setStatus("正在保存");
        sending.current = snapshot;
        writeCache(id, { revision: revision.current, snapshot: latest.current, sentSnapshot: snapshot });
        try {
          const result = await apiFetch<{ revision: number }>(`/api/ingest/${id}/draft`, { method: "PATCH", body: JSON.stringify({ ...snapshot, revision: revision.current }) });
          if (identity.current !== id) return;
          revision.current = result.revision;
          sending.current = null;
          saved.current = JSON.stringify(snapshot);
          setError(null);
          writeCache(id, { revision: revision.current, snapshot: latest.current, sentSnapshot: sending.current });
          const recovered = recoveredSource.current;
          if (recovered) {
            if (recovered.jobId === id) {
              try {
                const raw = localStorage.getItem(recovered.key);
                const source = parseCachedReview(raw);
                if (raw && source && getCacheVersion(raw, source) === recovered.version) {
                  localStorage.setItem(`${recovered.key}:recovered`, recovered.version);
                }
              } catch {
                // 新草稿已经保存；标记写入失败时，旧副本会再次出现。
              }
            }
            recoveredSource.current = null;
          }
          findRecoverableDrafts(id, getTabCacheKey(id));
        } catch (cause) {
          if (identity.current === id) { setStatus("仅保存在此浏览器"); setError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
          throw cause;
        }
      }
      if (identity.current === id) setStatus("已保存");
    };
    inFlight.current = task().finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, [findRecoverableDrafts, getTabCacheKey, writeCache]);

  const recoverLocalDraft = React.useCallback((cacheKey: string): Snapshot => {
    const id = identity.current;
    if (!id) throw new Error("没有正在审阅的导入任务。");
    const ownKey = getTabCacheKey(id);
    if (!ownKey || !tabIdPersisted.current) throw new Error("当前页面无法保存本地副本，请先复制需要的内容。");
    const prefix = `${legacyCacheKey(id)}:tab:`;
    const isLegacyCopy = cacheKey === legacyCacheKey(id);
    const isTabCopy = cacheKey.startsWith(prefix) && cacheKey !== ownKey && !cacheKey.endsWith(":recovered");
    if (!isLegacyCopy && !isTabCopy) throw new Error("这份副本不属于当前导入任务。");
    const ownValue = localStorage.getItem(ownKey);
    if (ownValue) {
      const own = parseCachedReview(ownValue);
      if (!own || JSON.stringify(own.snapshot) !== saved.current) throw new Error("当前页面已有本地草稿。请先保存或载入已保存草稿，再恢复其他副本。");
      localStorage.removeItem(ownKey);
      cached.current = false;
    }
    const candidateRaw = localStorage.getItem(cacheKey);
    const candidate = parseCachedReview(candidateRaw);
    if (!candidate) throw new Error("这份草稿副本已不存在或无法读取，请重新载入后再试。");

    const serverRevision = revision.current;
    const serverSnapshot = JSON.parse(saved.current) as Snapshot;
    const canContinuePendingSave = canResumePendingReview(candidate, serverRevision, serverSnapshot);
    if (candidate.revision !== serverRevision && !canContinuePendingSave) {
      revision.current = candidate.revision;
      setStatus("仅保存在此浏览器");
      setError("这份副本与已保存草稿存在冲突。副本内容已保留；保存失败时请复制内容，或载入已保存版本。");
    } else {
      revision.current = serverRevision;
      setStatus(JSON.stringify(candidate.snapshot) === saved.current ? "已保存" : "正在保存");
      setError(null);
    }
    recoveredSource.current = { jobId: id, key: cacheKey, version: getCacheVersion(candidateRaw!, candidate) };
    latest.current = candidate.snapshot;
    sending.current = candidate.sentSnapshot ?? null;
    writeCache(id, { revision: revision.current, snapshot: candidate.snapshot, sentSnapshot: candidate.sentSnapshot ?? null });
    setRecoverableDrafts([]);
    return candidate.snapshot;
  }, [getTabCacheKey, writeCache]);

  React.useEffect(() => {
    if (!active || !jobId || !draft || identity.current !== jobId) return;
    latest.current = { draft: draft.draft, reviewState: { skippedTitles: [...skipped], decisions: [...decisions] } };
    if (JSON.stringify(latest.current) === saved.current) return;
    writeCache(jobId, { revision: revision.current, snapshot: latest.current, sentSnapshot: sending.current });
    setStatus("正在保存");
    const timer = window.setTimeout(() => { void flush().catch(() => undefined); }, 300);
    return () => window.clearTimeout(timer);
  }, [active, jobId, draft, skipped, decisions, flush, writeCache]);

  React.useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (active && !cached.current && latest.current && JSON.stringify(latest.current) !== saved.current) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const forget = React.useCallback((id: string) => {
    if (identity.current === id) { identity.current = null; latest.current = null; }
    if (recoveredSource.current?.jobId === id) recoveredSource.current = null;
    const ownKey = getTabCacheKey(id);
    try {
      if (ownKey && tabIdPersisted.current) localStorage.removeItem(ownKey);
      localStorage.removeItem(legacyCacheKey(id));
      localStorage.removeItem(legacyMigratedKey(id));
    } catch { /* no cached copy */ }
    try { sessionStorage.removeItem(ignoreLegacyKey(id)); } catch { /* no cached copy */ }
  }, [getTabCacheKey]);
  const getRevision = React.useCallback(() => revision.current, []);
  return { restore, flush, forget, getRevision, status, error, recoverableDrafts, recoverLocalDraft };
}
