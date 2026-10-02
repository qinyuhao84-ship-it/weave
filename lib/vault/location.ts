import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./atomic";

type PendingMove = { from: string; to: string };
type LocationConfig = { activeRoot?: string; pendingMove?: PendingMove };

function configFile(): string {
  const base = process.env.WEAVE_CONFIG_DIR || (process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Weave")
    : path.join(os.homedir(), ".config", "weave"));
  return path.join(base, "vault-location.json");
}

function readConfig(): LocationConfig {
  try {
    const value = JSON.parse(fs.readFileSync(configFile(), "utf8")) as LocationConfig;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeConfig(value: LocationConfig): void {
  const file = configFile();
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function isVaultPathOverridden(): boolean {
  return Boolean(process.env.WEAVE_VAULT?.trim());
}

/** Current path, honoring test/deployment override before the user's saved location. */
export function resolveVaultRoot(defaultRoot: string): string {
  if (isVaultPathOverridden()) return path.resolve(process.env.WEAVE_VAULT!.trim());
  const movedRoot = applyPendingVaultMove();
  return path.resolve(movedRoot ?? readConfig().activeRoot ?? defaultRoot);
}

export function pendingVaultMove(): PendingMove | null {
  return readConfig().pendingMove ?? null;
}

/** Queue a whole-vault relocation. The move itself runs before the next server opens SQLite. */
export function requestVaultMove(fromRoot: string, toRoot: string): PendingMove {
  if (isVaultPathOverridden()) throw new Error("WEAVE_VAULT 环境变量指定了知识库位置，不能在设置中修改。");
  const from = path.resolve(fromRoot);
  const to = path.resolve(toRoot);
  if (from === to) return { from, to };

  const current = readConfig();
  if (current.pendingMove) throw new Error("已有一个知识库位置变更等待重启后执行。");
  if (to.startsWith(`${from}${path.sep}`)) {
    throw new Error("新位置不能放在当前知识库目录内部。");
  }
  if (fs.existsSync(to)) {
    throw new Error("目标知识库目录已存在。请选择其他文件夹。");
  }

  const pendingMove = { from, to };
  writeConfig({ ...current, pendingMove });
  return pendingMove;
}

/**
 * Finish a requested move before consumers open the vault database.
 * Copy to a sibling staging directory, verify every path and file hash, then switch config.
 */
export function applyPendingVaultMove(): string | null {
  if (isVaultPathOverridden()) return null;
  const config = readConfig();
  const move = config.pendingMove;
  if (!move) return null;

  const from = path.resolve(move.from);
  const to = path.resolve(move.to);
  if (from === to) {
    writeConfig({ activeRoot: to });
    return to;
  }

  if (fs.existsSync(to)) {
    if (fs.existsSync(from) && !sameTree(from, to)) {
      throw new Error("新位置已出现不同内容，知识库尚未迁移。请清空目标文件夹后重启重试。");
    }
  } else {
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
      throw new Error(`找不到原知识库目录：${from}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const suffix = createHash("sha256").update(`${from}\0${to}`).digest("hex").slice(0, 10);
    const staging = path.join(path.dirname(to), `.${path.basename(to)}.weave-move-${suffix}`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(from, staging, { recursive: true, preserveTimestamps: true, dereference: false });
    if (!sameTree(from, staging)) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error("知识库复制校验未通过，原目录保持不变。");
    }
    if (fs.existsSync(to)) {
      if (fs.readdirSync(to).length > 0) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw new Error("迁移过程中目标目录出现了内容，原目录保持不变。");
      }
      fs.rmdirSync(to);
    }
    fs.renameSync(staging, to);
  }

  // 先切换活动位置；之后即使清理旧目录失败，新库也已经是唯一活动库。
  writeConfig({ activeRoot: to });
  try { if (fs.existsSync(from)) fs.rmSync(from, { recursive: true, force: true }); } catch { console.warn("[vault] 新位置已生效，旧目录清理失败，请关闭服务后手动清理：", from); }
  return to;
}

function treeManifest(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (directory: string, relative = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        result.set(rel, `link:${fs.readlinkSync(full)}`);
      } else if (stat.isDirectory()) {
        result.set(`${rel}/`, "directory");
        visit(full, rel);
      } else if (stat.isFile()) {
        const hash = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        result.set(rel, `file:${stat.size}:${hash}`);
      } else {
        result.set(rel, `other:${stat.mode}:${stat.size}`);
      }
    }
  };
  visit(root);
  return result;
}

function sameTree(left: string, right: string): boolean {
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  const a = treeManifest(left);
  const b = treeManifest(right);
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}
