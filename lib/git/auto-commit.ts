import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { VAULT_ROOT } from "@/lib/vault/paths";
import { writeFileAtomic } from "@/lib/vault/atomic";

type CommitOperation = { id: string; title: string };
const commitOperation = new AsyncLocalStorage<CommitOperation>();

/** Group all commits produced by one user action or background job in the history view. */
export function withCommitOperation<T>(title: string, action: () => T): T {
  const current = commitOperation.getStore();
  if (current) return action();
  return commitOperation.run(
    { id: ulid(), title: title.replace(/[\r\n]+/g, " ").trim().slice(0, 120) || "知识库操作" },
    action,
  );
}

/**
 * vault 的自动版本管理。
 *
 * 为什么这不是可选项：LLM Wiki 明确不是确定性编译器（原文称之为
 * "a living draft maintained by an LLM"），同一份资料两次 ingest 的产出可以不同。
 * 因此「改坏了」是常态而非异常，必须有一份不依赖本应用的后悔药。
 * git 是成本最低、最不该省的那一个。
 */

/**
 * 当前版本的排除段。
 *
 * 回收站那两行是关键：墓碑（被删除词条的 frontmatter，带着 redirect_to）住在
 * .weave/trash/ 里，而它是「旧名当初指向哪里」**唯一**的文件证据 —— 删除时引用
 * 被就地改写成新目标，旧名既不进任何词条的 aliases，也不留在 wiki/ 里。
 * 把整个 .weave/ 排除掉，换台机器、clone 一份新的、或者顺手 rm -rf .weave
 * 之后，redirects 表就再也建不起来，[[旧名]] 变成永久死链 ——
 * 所以回收站墓碑是索引重建仍需保留的知识数据，不能跟 SQLite 一起丢掉。
 *
 * 写法上必须先排除 .weave/* 再单独放行回收站目录：git 不会为一个「父目录已被排除」
 * 的文件破例，所以放行的必须是目录本身。
 */
const IGNORE_BLOCK = `# SQLite 应用数据与解析产物不进版本管理；weave.db 含需单独备份的用户状态
.weave/*

# 回收站例外：墓碑是删除类重定向唯一的文件证据，被删词条的正文本身也不可重建，
# 它们必须进版本管理（详见本文件顶部与 lib/vault/read.ts#scanTombstones）。
!.weave/trash/
`;

/** 旧版本的排除段 —— 保留原文以精确升级已有知识库的 .gitignore */
const LEGACY_IGNORE_BLOCK = `# 派生数据：全部可从 raw/ 与 wiki/ 重建，不进版本管理
.weave/
`;

const GITIGNORE_CONTENT = `${IGNORE_BLOCK}
# 系统与编辑器
.DS_Store
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.trash/
`;

/**
 * 把旧版 .gitignore 升级到当前版本；返回是否改动过。
 *
 * 已存在的 vault 不会重写 .gitignore（用户可能往里加了自己的规则），所以做一次
 * **定向替换**：只换掉我们自己写的那一段，文件里其余内容一个字都不动。
 */
function upgradeGitignore(ignorePath: string): boolean {
  const current = fs.readFileSync(ignorePath, "utf8");
  // 已经是新版（或用户自己加过放行规则），不动
  if (current.includes("!.weave/trash/")) return false;
  // 不是我们写的、或已经被改得认不出来 —— 宁可不动，也不要覆盖用户的内容
  if (!current.includes(LEGACY_IGNORE_BLOCK)) return false;

  writeFileAtomic(ignorePath, current.replace(LEGACY_IGNORE_BLOCK, IGNORE_BLOCK));
  return true;
}

/** 织识自己的提交身份，不污染用户的全局 git 配置 */
const IDENTITY = [
  "-c",
  "user.name=织识",
  "-c",
  "user.email=weave@localhost",
];

function git(args: string[], options: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync("git", ["-C", VAULT_ROOT, ...IDENTITY, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
      killSignal: "SIGKILL",
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : String(error);
    throw new Error(`git ${args.join(" ")} 失败：${stderr}`);
  }
}

/** 确保 vault 是一个 git 仓库，并写好 .gitignore。已初始化时是幂等的。 */
export function ensureGitRepo(): boolean {
  const gitDir = path.join(VAULT_ROOT, ".git");
  const existed = fs.existsSync(gitDir);

  if (!existed) {
    fs.mkdirSync(VAULT_ROOT, { recursive: true });
    git(["init", "-q"]);
    // 统一用 main，与用户全局配置一致
    git(["symbolic-ref", "HEAD", "refs/heads/main"], { allowFailure: true });
  }

  // .gitignore 由我们托管；不要覆盖用户自己写的内容
  const ignorePath = path.join(VAULT_ROOT, ".gitignore");
  if (!fs.existsSync(ignorePath)) {
    writeFileAtomic(ignorePath, GITIGNORE_CONTENT);
  } else {
    upgradeGitignore(ignorePath);
  }

  return !existed;
}

export type CommitResult = {
  committed: boolean;
  sha: string | null;
  filesChanged: number;
};

/**
 * 提交 vault 的当前状态。
 *
 * 空提交会被跳过（git commit 在无变更时返回非零，这是正常的，不该当错误处理）。
 * 调用方是服务层的每个写操作 —— 每次改名/删除/合并/编辑各产生一个 commit，
 * 便于用户通过本地 Git 核对和备份内容。
 */
export function commitVault(message: string): CommitResult {
  ensureGitRepo();
  git(["add", "-A"]);

  // 看有没有真的变更
  const staged = git(["diff", "--cached", "--name-only"], { allowFailure: true });
  if (!staged) {
    return { committed: false, sha: null, filesChanged: 0 };
  }

  const filesChanged = staged.split("\n").filter(Boolean).length;
  const operation = commitOperation.getStore() ?? { id: ulid(), title: message };
  const title = operation.title.replace(/[\r\n]+/g, " ").trim().slice(0, 120) || message;
  git([
    "commit", "-q", "-m", message,
    "-m", `Weave-Operation: ${operation.id}\nWeave-Operation-Title: ${title}`,
  ]);
  const sha = git(["rev-parse", "HEAD"], { allowFailure: true }) || null;

  return { committed: true, sha, filesChanged };
}

/** 内容已保存后尽力备份；Git 故障不能改变业务写入结果。 */
export function backupVault(message: string): CommitResult & { commitSha: string | null; backupWarning: string | null } {
  const indexPath = path.join(VAULT_ROOT, ".git", "index");
  let index: Buffer | null | undefined;
  try {
    ensureGitRepo();
    index = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null;
    const result = commitVault(message);
    return { ...result, commitSha: result.sha, backupWarning: null };
  } catch (error) {
    console.error("[vault] 内容已保存，Git 备份失败：", error);
    try {
      // 遵守另一 Git 进程的锁；不能在它更新暂存区时覆盖其工作。
      if (fs.existsSync(`${indexPath}.lock`)) return { committed: false, sha: null, filesChanged: 0, commitSha: null, backupWarning: "内容已保存，但本地 Git 备份失败。请检查备份仓库后重试备份。" };
      if (index) writeFileAtomic(indexPath, index);
      else if (index === null) fs.rmSync(indexPath, { force: true });
    } catch (error) { console.error("[vault] Git 暂存恢复失败：", error); }
    return { committed: false, sha: null, filesChanged: 0, commitSha: null, backupWarning: "内容已保存，但本地 Git 备份失败。请检查备份仓库后重试备份。" };
  }
}

/** 当前是否有未提交的变更（用于一致性巡检） */
export function hasUncommittedChanges(): boolean {
  if (!fs.existsSync(path.join(VAULT_ROOT, ".git"))) return false;
  const status = git(["status", "--porcelain"], { allowFailure: true });
  return status.length > 0;
}
