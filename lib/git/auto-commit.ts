import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { VAULT_ROOT } from "@/lib/vault/paths";

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

  fs.writeFileSync(ignorePath, current.replace(LEGACY_IGNORE_BLOCK, IGNORE_BLOCK), "utf8");
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
    fs.writeFileSync(ignorePath, GITIGNORE_CONTENT, "utf8");
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
 * 于是「历史/回滚」界面天然就有了数据。
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

export type VaultCommit = {
  sha: string;
  /** 是否是仓库的第一条记录。界面据此不提供撤销（服务端也会拒绝）。 */
  isRoot: boolean;
  /** 简写 sha，用于界面展示 */
  shortSha: string;
  message: string;
  authorName: string;
  /** ISO 8601 带偏移 */
  date: string;
  /** 相对时间，如「3 分钟前」 */
  relative: string;
  filesChanged: number;
  operationId: string | null;
  operationTitle: string | null;
  revertReason?: string | null;
};

/** 读取提交历史，用于「历史/回滚」界面 */
export function logVault(limit = 50, offset = 0): VaultCommit[] {
  if (!fs.existsSync(path.join(VAULT_ROOT, ".git"))) return [];

  const format = "%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%(trailers:key=Weave-Operation,valueonly)%x1f%(trailers:key=Weave-Operation-Title,valueonly)%x1e";
  const raw = git(["log", `-${limit}`, `--skip=${offset}`, `--pretty=format:${format}`], { allowFailure: true });
  if (!raw) return [];

  // 根提交（可能不止一个，例如历史上的合并）标出来，界面不提供撤销
  const roots = new Set(
    git(["rev-list", "--max-parents=0", "HEAD"], { allowFailure: true })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );

  return raw
    .split("\x1e")
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, message, authorName, date, operationId, operationTitle] = line.trim().split("\x1f");
      return {
        sha,
        isRoot: roots.has(sha),
        shortSha,
        message,
        authorName,
        date,
        relative: relativeTime(date),
        filesChanged: 0,
        operationId: operationId?.trim() || null,
        operationTitle: operationTitle?.trim() || null,
        revertReason: revertBlockReason(sha),
      };
    });
}

/** 某个提交改了哪些文件 */
export function commitFiles(sha: string): Array<{ status: string; path: string }> {
  const raw = git(["show", "--name-status", "--pretty=format:", sha], { allowFailure: true });
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, path: rest.join("\t") };
    });
}

/**
 * 撤销某次改动遇到冲突。
 *
 * 单独建一个错误类型而不是直接抛 git 的英文 stderr：后者会经 lib/api.ts 的兜底
 * 原样吐给用户（「error: could not revert…」），而这条信息要表达的是
 * 「什么都没变，你可以手动改回来」，是个可操作的结论。
 */
/**
 * 不能撤销仓库的根提交。
 *
 * 撤销它等于把 log.md、schema.md 这些建库时就存在的文件一起删掉 —— 也就是
 * 「把知识库清空」。而界面上的文案是「知识库会回到这次改动之前的样子」，
 * 这句话在根提交上与「清空」等价，用户不会这样理解。
 *
 * 这不是理论风险：一次实测里真的把 wiki/ 与 raw/ 清空了，log.md 与 schema.md
 * 一起消失（两者都已从 git 恢复）。所以拦在服务端，而不是靠前端不显示按钮。
 */
export class RootRevertError extends Error {
  constructor() {
    super(
      "这是知识库的第一条记录，没有「更早」可以回去 —— 撤销它会把建库文件一起删掉，所以这里不做。",
    );
    this.name = "RootRevertError";
  }
}

export class RevertConflictError extends Error {
  constructor() {
    super(
      "这次改动没法自动撤销 —— 它和之后的改动改到了同一处地方。" +
        "知识库已经回到撤销前的状态，什么都没有变。可以手动把内容改回来。",
    );
    this.name = "RevertConflictError";
  }
}

/** SQLite 用户状态不在 Git 中，资料归档应通过对应恢复流程处理。 */
export class ApplicationStateRevertError extends Error {}

export function revertBlockReason(sha: string): string | null {
  const files = commitFiles(sha);
  if (files.some(file => file.path.startsWith(".weave/trash/batches/") || file.path.startsWith("raw/"))) {
    return "这条记录包含原始资料或整库归档，不能只撤销文件。请在回收站恢复批次，或重新处理原始资料；词条内容可单独编辑后撤销。";
  }
  return null;
}

/**
 * 撤销某个提交。
 *
 * 用 `git revert` 而不是 `git reset --hard`：revert 会生成一个新的反向提交，
 * 历史保持线性且不丢失任何东西 —— 用户撤销错了还能再撤销回来。
 */
export function revertCommit(sha: string): CommitResult {
  // 开工前先看一眼仓库里有没有**本来**就残留的未完成 revert。
  // 有的话 git 会直接拒绝开工（"Reverting is not possible because you have unmerged files"），
  // 而那时 REVERT_HEAD 是早就存在的 —— 只看调用之后的状态会把它误判成「和后续改动撞车」，
  // 给出的自救建议（手动改回来）也是错的，真正该做的是先把上一次收尾。
  const stuckBefore = fs.existsSync(path.join(VAULT_ROOT, ".git", "REVERT_HEAD"));

  // 根提交不能撤销，理由见 RootRevertError
  const target = git(["rev-parse", sha], { allowFailure: true });
  const roots = git(["rev-list", "--max-parents=0", "HEAD"], { allowFailure: true })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (target && roots.includes(target)) throw new RootRevertError();
  const blocked = revertBlockReason(sha);
  if (blocked) throw new ApplicationStateRevertError(blocked);

  // 先记下原提交的标题：git revert 没有 --message（-m 是 --mainline），
  // 直接让它生成的话标题是 Revert "改写「张三」" —— 英文引号包裹，
  // 而「改动记录」页是逐字显示提交信息的，其余六种记录的文案又都已是中文。
  const subject = git(["log", "-1", "--format=%s", sha], { allowFailure: true });

  try {
    git(["revert", "--no-edit", sha]);
  } catch (error) {
    // 判据是「是否真的停在 revert 中间态」，不是「git 有没有报错」。
    // sha 不存在、索引里有未提交改动、仓库已有残留中间态 —— 这几种都会让 git 报错，
    // 但都不是冲突。把它们一律说成「和后续改动撞车」等于给用户一个未经核实的结论，
    // 还把他引向「手动改回来」这条错误的自救路径。
    const stuck = fs.existsSync(path.join(VAULT_ROOT, ".git", "REVERT_HEAD"));
    if (stuck && stuckBefore) {
      // 上一次撤销没收尾。abort 掉它，然后把实情说出来 —— 不说成「撞车」。
      git(["revert", "--abort"], { allowFailure: true });
      console.error("[vault] 仓库里残留着未完成的撤销，已清理", error);
      throw new Error(
        "知识库里有上一次没收尾的撤销，已经帮你清掉了。现在可以重新点一次撤销。",
      );
    }
    if (stuck) {
      // 停在中间态时：git 会把冲突标记写进 wiki/*.md，而且之后**每一次**撤销都会
      // fatal（"a revert is already in progress"）。先 abort 回到撤销前的样子再报错。
      git(["revert", "--abort"], { allowFailure: true });
      console.error("[vault] 撤销冲突，已 abort 回滚到撤销前状态", error);
      throw new RevertConflictError();
    }
    console.error("[vault] 撤销未能应用", error);
    throw new Error(
      subject ? `撤销「${subject}」没能应用，知识库没有变化。` : "这次撤销没能应用，知识库没有变化。",
    );
  }

  // 换掉 git 自动生成的英文标题。换标题失败不影响撤销本身（改动已经落下了）。
  if (subject) {
    git(["commit", "--amend", "-m", `撤销「${subject}」`], { allowFailure: true });
  }

  const newSha = git(["rev-parse", "HEAD"], { allowFailure: true }) || null;
  return { committed: true, sha: newSha, filesChanged: 0 };
}

/** 当前是否有未提交的变更（用于一致性巡检） */
export function hasUncommittedChanges(): boolean {
  if (!fs.existsSync(path.join(VAULT_ROOT, ".git"))) return false;
  const status = git(["status", "--porcelain"], { allowFailure: true });
  return status.length > 0;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSeconds = Math.round((Date.now() - then) / 1000);
  if (diffSeconds < 60) return "刚刚";
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)} 分钟前`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)} 小时前`;
  if (diffSeconds < 2592000) return `${Math.floor(diffSeconds / 86400)} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}
