import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import { VAULT_ROOT, WIKI_DIR, RAW_DIR } from "@/lib/vault/paths";
import { reindexAll, type ReindexReport } from "./reindex";
import { isWatcherSuppressed } from "./watch-suppression";

/**
 * vault 文件监听器。
 *
 * 存在意义只有一个：让「用 Obsidian / VS Code 直接改文件」也能生效。
 *
 * 这是用户担心的「修改不生效」的正解。业界最致命的失效模式是：自动更新链接
 * 的机制挂在应用的事件上，绕过应用直接改文件就绕过了同步 —— 于是链接静默断掉
 * 而没有任何报错。我们的对策是反过来：文件系统永远是真相，索引只是它的投影；
 * 投影过期了就重建投影，而不是去阻止用户改文件。
 *
 * 分工纪律：监听器**只重建索引，绝不修改任何文件**。所有写入仍然必须经过
 * lib/vault/service.ts。这样即使有人在 Obsidian 里改名字改出了死链，
 * 我们也是「如实反映」而不是「悄悄替他改回去」。
 */

export type ExternalChange = {
  kind: "add" | "change" | "unlink";
  relativePath: string;
  at: string;
};

type Listener = (event: { changes: ExternalChange[]; report: ReindexReport }) => void;

let watcher: FSWatcher | null = null;
let readyPromise: Promise<void> | null = null;
let watcherGeneration = 0;
let debounceTimer: NodeJS.Timeout | null = null;
const pending = new Map<string, ExternalChange>();
const listeners = new Set<Listener>();

/** 订阅外部变更事件（供 SSE 推送给前端） */
export function onExternalChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(changes: ExternalChange[], report: ReindexReport): void {
  for (const listener of listeners) {
    try {
      listener({ changes, report });
    } catch {
      // 单个订阅者出错不影响其他订阅者
    }
  }
}

function runReindex(changes: ExternalChange[]): void {
  if (changes.length === 0) return;
  try {
    const report = reindexAll();
    notify(changes, report);
  } catch (error) {
    console.error("[watcher] 索引重建失败：", error);
  }
}

/**
 * 防抖重建。
 *
 * 300ms 是刻意的：编辑器保存时常常「先写临时文件再 rename」，一次保存会触发
 * 多个事件；用户连续敲 Cmd+S 时也不该每次都重建整个索引。
 */
function scheduleReindex(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (isWatcherSuppressed()) {
      pending.clear();
      return;
    }
    const changes = [...pending.values()];
    pending.clear();
    runReindex(changes);
  }, 300);
}

function record(kind: ExternalChange["kind"], absolutePath: string): void {
  const relative = path.relative(VAULT_ROOT, absolutePath).split(path.sep).join("/");
  if (!relative.startsWith("wiki/") && !relative.startsWith("raw/")) return;
  if (!relative.endsWith(".md") && !relative.startsWith("raw/")) return;
  pending.set(relative, { kind, relativePath: relative, at: new Date().toISOString() });
}

/**
 * 启动监听，并等待 chokidar 完成首次全盘扫描。
 *
 * 为什么必须等待 ready：
 * chokidar 用 ignoreInitial 跳过「启动时已存在」的文件（这是对的，否则每次启动
 * 都会把整个 vault 当成新增变更刷一遍）。但副作用是 —— 在它扫描期间刚创建的
 * 文件会被误判为「启动时已存在」，于是既不触发事件、也不会被我们感知。
 * 应用启动那一瞬间用户恰好从剪贴板导入一份资料，就会静默丢失。
 *
 * 对策：等 ready 之后再补一次全量重建，把那段时间窗口里发生的变更捞回来。
 * 这次重建是幂等的，没有变更时开销可以忽略。
 */
export async function startWatcher(): Promise<void> {
  if (readyPromise) return readyPromise;

  let resolveReady!: () => void;
  readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const generation = ++watcherGeneration;
  createWatcher(false, generation, resolveReady);
  return readyPromise;
}

function createWatcher(
  usePolling: boolean,
  generation: number,
  resolveReady: () => void,
): void {
  const currentWatcher = chokidar.watch([WIKI_DIR, RAW_DIR], {
    ignoreInitial: true,
    persistent: true,
    depth: 6,
    usePolling,
    // 轮询只会在本机文件系统监控句柄耗尽时启用，放宽间隔以限制空闲开销。
    ...(usePolling ? { interval: 500, binaryInterval: 1000 } : {}),
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: [
      /(^|[/\\])\../,       // 隐藏文件与目录
      "**/.weave/**",
      "**/.git/**",
      "**/.obsidian/**",
      "**/.trash/**",
    ],
  });
  watcher = currentWatcher;
  let fallbackStarted = false;
  const isCurrent = () => watcher === currentWatcher && watcherGeneration === generation;

  currentWatcher
    .on("add", (p) => { if (isCurrent()) { record("add", p); scheduleReindex(); } })
    .on("change", (p) => { if (isCurrent()) { record("change", p); scheduleReindex(); } })
    .on("unlink", (p) => { if (isCurrent()) { record("unlink", p); scheduleReindex(); } })
    .on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      const resourceExhausted = code === "EMFILE" || code === "ENOSPC";
      if (resourceExhausted && !usePolling && isCurrent()) {
        if (fallbackStarted) return;
        fallbackStarted = true;
        console.warn("[watcher] 文件监控句柄不足，切换到低频轮询。", error);
        watcher = null;
        void currentWatcher.close().catch((closeError) => {
          console.error("[watcher] 关闭原监听器失败：", closeError);
        }).finally(() => {
          if (watcherGeneration === generation && readyPromise) {
            createWatcher(true, generation, resolveReady);
          }
        });
        return;
      }
      // 关闭旧监听器期间可能还会到达同一批资源错误，不重复报日志。
      if (!fallbackStarted) console.error("[watcher] 监听出错：", error);
    });

  currentWatcher.once("ready", async () => {
    if (!isCurrent()) return;
    // 补一次重建，覆盖「扫描窗口期内发生的变更」
    try {
      reindexAll();
    } catch (error) {
      console.error("[watcher] 启动补扫失败：", error);
    }
    // chokidar 的 ready 只表示「初始扫描完成」，不保证底层 FSEvents 流已经
    // 挂好。在 macOS 上紧接着发生的文件变更可能整批丢失 —— 实测在密集
    // 创建/删除的场景下会复现。给它一小段静置时间再对外宣称就绪，
    // 让调用方（以及测试）不会在事件通道尚未接通时就开始改动文件。
    await new Promise((r) => setTimeout(r, 400));
    if (isCurrent()) resolveReady();
  });
}

/** 等待监听器就绪（测试与 API 层用） */
export async function waitUntilReady(): Promise<void> {
  if (!readyPromise) await startWatcher();
  else await readyPromise;
}

export async function stopWatcher(): Promise<void> {
  watcherGeneration++;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pending.clear();
  const currentWatcher = watcher;
  watcher = null;
  if (currentWatcher) await currentWatcher.close();
  readyPromise = null;
}

export function isWatching(): boolean {
  return watcher !== null;
}
