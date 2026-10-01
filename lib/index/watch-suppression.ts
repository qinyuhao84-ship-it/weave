/**
 * 写操作抑制窗口。
 *
 * 服务层写文件时会触发 chokidar，导致一次多余的索引重建。虽然重建是幂等的、
 * 代价也可接受，但每次写操作都做两遍没有意义，而且会让「外部变更」的提示
 * 在用户自己的操作后误报。
 *
 * 单独放一个模块是为了避免 watcher.ts ←→ service.ts 的循环依赖。
 */
let suppressUntil = 0;

/** 在接下来的 ms 毫秒内忽略文件系统事件 */
export function suppressWatcher(ms = 1500): void {
  suppressUntil = Date.now() + ms;
}

export function isWatcherSuppressed(): boolean {
  return Date.now() < suppressUntil;
}

export function clearSuppression(): void {
  suppressUntil = 0;
}
