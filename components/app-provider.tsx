"use client";

import * as React from "react";
import { IngestDrawer } from "@/components/ingest/ingest-drawer";
import { IngestProvider } from "@/components/ingest/ingest-provider";
import { JobsProvider } from "@/components/jobs/jobs-provider";
import { useApi } from "@/hooks/use-api";
import { normalizeLinkTarget } from "@/lib/vault/wikilinks";
import type { WikilinkResolver } from "@/lib/markdown/wikilink-plugin";

/**
 * 应用级共享状态的宿主。
 *
 * 两件事放在这里，因为它们的消费者都在外壳层：
 *
 * ① **导入抽屉**。抽屉原本挂在知识库页里，与页面级的 drawerOpen 状态绑在一起。
 *    提到外壳层之后，知识库页的「导入资料」按钮可以直接唤起它，不必把状态与回调
 *    在组件之间透传。
 *    （侧栏不再放「添加资料」入口 —— 导入是知识库页的一个动作，一个动作一个入口。）
 *    开关抽屉的入口现在归 IngestProvider（`useIngest().openDrawer()`）：导入任务
 *    本身住在那里，抽屉开关只是它的一个视图状态，不该分裂成两份。
 *
 * ② **数据版本号**。导入提交、会话增删、词条增删改之后，别的组件（侧栏的最近对话
 *    与体检角标、各页面的列表）都需要重新取数。与其让外壳去调用每个页面各自的刷新
 *    函数，不如广播一个递增的版本号：消费方把它放进 useApi 的 deps，数据自己就会重取。
 *    这样外壳不需要知道任何页面怎么取数。写操作之后忘记 bumpData()，症状是
 *    「本页更新了、侧栏数字纹丝不动」。
 *
 * ③ **侧栏的三份摘要数据**（vault / sessions / pendingReview）。侧栏在桌面固定栏与
 *    移动端抽屉里各挂一份，放在侧栏组件内部会让同一份数据取两遍、且抽屉每开一次
 *    重取一遍；提到这一层就只有一份实例。
 */

export type VaultSummary = {
  stats: { pages: number; links: number };
  indexHealthy: boolean;
  /** 当前知识库位置，用于本机管理与备份 */
  vaultRoot?: string;
  canChangeLocation?: boolean;
  canOpenLocation?: boolean;
  pendingVaultRoot?: string | null;
};

export type SessionSummary = {
  id: string;
  title: string;
  titleOrigin: "legacy" | "fallback" | "ai" | "manual";
  titleSummaryStatus: "idle" | "pending" | "generating" | "failed";
  updatedAt: string;
  generating: boolean;
  activeRunId: string | null;
};

type AppDataValue = {
  /** 页面把 dataVersion 放进 useApi 的 deps，即可在数据变化后自动重取。 */
  dataVersion: number;
  /**
   * 双链解析器：把正文里的 [[名字]] 变成可点击的词条链接。
   * 提到这一层是因为至少有两个消费者（对话回答、导入审阅的草稿卡片），
   * 而它必须**引用稳定** —— 每次渲染换个函数，markdown 就会整篇重解析。
   */
  resolveWikilink: WikilinkResolver;
  /** 任何会改变页面上数据的事件（导入提交、会话增删、词条增删改）都调用它。 */
  bumpData: () => void;
  /** 侧栏用的三份摘要数据，提到这里统一取，见下面注释。 */
  vault: VaultSummary | null;
  sessions: SessionSummary[];
  pendingReview: number;
  agentName: string;
};

const AppDataContext = React.createContext<AppDataValue | null>(null);

export function useAppData(): AppDataValue {
  const value = React.useContext(AppDataContext);
  if (!value) {
    throw new Error("useAppData 必须在 AppDataProvider 内使用");
  }
  return value;
}

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const [dataVersion, setDataVersion] = React.useState(0);
  const [sessionRefresh, setSessionRefresh] = React.useState(0);

  // Finder / Obsidian 直接编辑 Markdown 时由服务端监听器重建索引；收到事件后，
  // 页面列表、体检角标与关系网络都共用同一个版本号同步刷新。
  React.useEffect(() => {
    const source = new EventSource("/api/vault/changes");
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string };
        if (payload.type === "change") setDataVersion((version) => version + 1);
      } catch {
        // Ignore malformed or keepalive frames.
      }
    };
    return () => source.close();
  }, []);

  // 侧栏要用的三份摘要数据提到外壳层。
  //
  // 侧栏在桌面固定栏与移动端抽屉里各挂一份（CSS 的 hidden 不等于卸载），
  // 放在侧栏组件内部会让同一份数据取两遍；而抽屉里那份是全新实例，
  // 每开一次就重新转圈取一遍。提到外壳层就只有一份实例。
  //
  // 这也兑现了 hooks/use-api.ts 里那句「将来真出现同 path 双消费者时再加去重」——
  // 与其加一层全局去重，不如让同一个数据只有一个所有者。
  const { data: vault } = useApi<VaultSummary>("/api/vault", [dataVersion]);
  const { data: sessionData } = useApi<{ sessions: SessionSummary[] }>(
    "/api/chat/sessions",
    [dataVersion, sessionRefresh],
  );
  const { data: identityData } = useApi<{ agentName: string }>("/api/settings/identity", [dataVersion]);
  // limit=1：只要 counts，不要列表本体
  const { data: reviewData } = useApi<{ counts: { pending: number } }>(
    "/api/review?status=pending&limit=1",
    [dataVersion],
  );
  // 双链解析表。跟着 dataVersion 走 —— 导入提交之后新建的词条立刻可点，
  // 否则刚写进库的 [[新词条]] 要等刷新才认得出来。
  const { data: wikilinkData } = useApi<{
    table: Record<string, { pageId: string; title: string }>;
  }>("/api/wikilinks", [dataVersion]);

  // 只在回答或标题仍在后台生成时轮询会话状态；其他页面不额外请求。
  React.useEffect(() => {
    if (!sessionData?.sessions.some((session) =>
      session.generating ||
      session.titleSummaryStatus === "pending" ||
      session.titleSummaryStatus === "generating"
    )) return;
    const timer = window.setInterval(() => setSessionRefresh((value) => value + 1), 1200);
    return () => window.clearInterval(timer);
  }, [sessionData]);

  const resolveWikilink = React.useMemo<WikilinkResolver>(() => {
    const table = wikilinkData?.table ?? {};
    return (target: string) => table[normalizeLinkTarget(target)] ?? null;
  }, [wikilinkData]);

  const value = React.useMemo<AppDataValue>(
    () => ({
      dataVersion,
      resolveWikilink,
      bumpData: () => setDataVersion((v) => v + 1),
      vault: vault ?? null,
      sessions: sessionData?.sessions ?? [],
      pendingReview: reviewData?.counts.pending ?? 0,
      agentName: identityData?.agentName ?? "织识",
    }),
    [dataVersion, vault, sessionData, reviewData, identityData, resolveWikilink],
  );

  return (
    <AppDataContext.Provider value={value}>
      {/* IngestProvider 裹在 children 外面：侧栏的导入指示器与页面里的
          「导入资料」按钮都要读同一份任务状态。
          JobsProvider 管的是**除导入之外**的后台任务（体检、按批注修订……）——
          它们同样要在侧栏底部常驻显示，同样要能一键停掉。 */}
      <IngestProvider>
        <JobsProvider>
          {children}
          <IngestDrawer onCommitted={() => setDataVersion((v) => v + 1)} />
        </JobsProvider>
      </IngestProvider>
    </AppDataContext.Provider>
  );
}
