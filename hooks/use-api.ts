"use client";

import * as React from "react";
import { clientLocale, localizeApiError } from "@/lib/i18n/errors";

/**
 * 极简的数据获取 hook。
 *
 * 没上 SWR / React Query：本机单用户场景下只有一个客户端，
 * 缓存失效的复杂度远大于收益。**这里也刻意不做跨时间的缓存** ——
 * Markdown 是真源、索引只是它的投影，任何一次写操作都会让索引变，
 * 「什么时候该失效」的正确性成本高于收益。
 *
 * 但有一件事必须做：**丢弃过期响应**。快速连点不同词条时，
 * 先发的请求可能后到，把新词条的内容覆盖成旧词条。
 * 用请求序号判定，只有最新那次允许写 state。
 *
 * 这里**没有**做在途去重。曾经加过一版模块级 Map 合并同 path 的并发请求，
 * 但盘点后 7 个调用点互不重叠：/api/pages 的两个调用点分属 /wiki 与 /wiki/[id]
 * 两个互斥路由，/api/graph 在体检页走的是裸 apiFetch 而非本 hook。
 * 也就是说去重当前没有任何消费者，却引入了一份全局可变状态 ——
 * 一个永不 settle 的请求会把那个 path 永久占住（连接恢复后新请求也发不出去）。
 * 将来真出现同 path 双消费者时再加，并且要带上超时。
 */

export type ApiState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); this.name = "ApiError"; }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const payload = (await response.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error: string; code?: string }
    | null;

  if (!payload) throw new ApiError(localizeApiError(clientLocale(), "REQUEST_FAILED", `请求失败（${response.status}）`), response.status, "REQUEST_FAILED");
  if (!payload.ok) throw new ApiError(localizeApiError(clientLocale(), payload.code ?? "REQUEST_FAILED", payload.error), response.status, payload.code ?? "REQUEST_FAILED");
  const warning = (payload.data as { backupWarning?: unknown } | null)?.backupWarning;
  if (typeof warning === "string" && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("weave-backup-warning", { detail: warning }));
  return payload.data;
}

export function useApi<T>(path: string | null, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [failure, setFailure] = React.useState<{ path: string; message: string } | null>(null);
  const [loading, setLoading] = React.useState(Boolean(path));

  // 每次请求领一个序号。只有序号仍然是最新的那次，结果才允许写进 state。
  const generation = React.useRef(0);
  const request = React.useRef<AbortController | null>(null);
  const previousPath = React.useRef(path);

  const load = React.useCallback(async () => {
    const current = ++generation.current;
    request.current?.abort();
    if (!path) {
      setData(null);
      setFailure(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const result = await apiFetch<T>(path, { signal: controller.signal });
      if (current !== generation.current) return;
      setData(result);
      setFailure(null);
    } catch (err) {
      if (current !== generation.current) return;
      setFailure({ path, message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [path]);

  React.useEffect(() => {
    if (previousPath.current !== path) {
      previousPath.current = path;
      setFailure(null);
    }
    void load();
    // path 变化或组件卸载时作废在途结果：序号一推，旧响应回来也写不进去。
    return () => {
      // 清理时递增请求序号，作废此 effect 期间的手动 refresh。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      request.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 调用方提供刷新依赖；load 随 path 稳定更新。
  }, [load, ...deps]);

  return { data, error: failure?.path === path ? failure.message : null, loading, refresh: load };
}

/** 提交类请求的状态管理 */
export function useMutation<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
): {
  mutate: (input: TInput) => Promise<TOutput | null>;
  loading: boolean;
  error: string | null;
  reset: () => void;
} {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const mutate = React.useCallback(
    async (input: TInput) => {
      setLoading(true);
      setError(null);
      try {
        const result = await fn(input);
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [fn],
  );

  return { mutate, loading, error, reset: () => setError(null) };
}
