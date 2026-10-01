import { WikiWorkspace } from "@/components/wiki/workspace";
import { GraphWorkspace } from "@/components/graph/workspace";
import { ensureVaultLayout } from "@/lib/vault/paths";
import { ensureGitRepo } from "@/lib/git/auto-commit";

export const dynamic = "force-dynamic";

/**
 * 知识库。列表、大纲与图谱共用一个入口。
 *
 * 用查询参数（?view=graph）而不是 /wiki/graph 这样的静态段，有两个原因：
 * ① /wiki/[id] 已经被词条占用，静态段会和词条 id 抢路径；
 * ② 数据库里 slug **刻意不做唯一约束** —— 用户可能在 Obsidian 里手工造出
 *    名叫 graph 或 history 的文件。静态段会埋下「词条不许叫 graph」这种新规约，
 *    与既有取向冲突。
 *
 * 查询参数还顺带把深链与浏览器后退都保住了。
 */
export default async function WikiPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string; missing?: string }>;
}) {
  // 首次访问时把 vault 骨架建起来 —— 用户不需要知道有这一步
  ensureVaultLayout();
  ensureGitRepo();

  const { view, q, missing } = await searchParams;

  if (view === "graph") return <GraphWorkspace />;

  // ?q= 来自体检页的条目，?missing= 来自正文里的断链 ——
  // 两者都落进搜索框，用户跳过来就能看见「在找什么」。
  return <WikiWorkspace initialQuery={q ?? missing ?? ""} />;
}
