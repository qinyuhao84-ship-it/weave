"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  BookText, Network, MessagesSquare, ShieldCheck, History, Settings as SettingsIcon, LoaderCircle,
  PanelLeftClose, PanelLeftOpen, Menu, X, Pencil, Trash2, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppData } from "@/components/app-provider";
import { useIngest } from "@/components/ingest/ingest-provider";
import { JobIndicators } from "@/components/jobs/job-indicator";
import { apiFetch } from "@/hooks/use-api";
import { SessionListDialog } from "@/components/chat/session-list-dialog";
import { WeaveMark } from "@/components/ui/weave-mark";

/**
 * 左侧导航。
 *
 * 结构改动：原来是 6 项平级的顶部横向导航。现在是左侧栏，六项并列 ——
 * 新对话 / 知识库 / 关系网络 / 版本 / 体检 / 设置，**刻意不给「知识库」做分组**：
 * 关系网络与版本本来就是与知识库同层的三个视图，多一层缩进只是多一次理解。
 * 设置紧跟在体检之后，不再钉在栏底。下面「最近对话」是一组，栏底只留知识库状态。
 *
 * 折叠状态全部由 CSS 驱动（:root[data-sidebar="collapsed"]），React 只负责
 * 切属性 + 记住偏好。好处是服务端渲染的 HTML 与客户端首帧一致 —— 用 state 的话
 * 会先按展开态画一遍再塌下去，闪一下。
 */

const COLLAPSE_KEY = "weave-sidebar";

/* ------------------------------------------------------------ 折叠状态 */
let collapsedCache: boolean | null = null;
const collapseListeners = new Set<() => void>();

function readCollapsed(): boolean {
  if (collapsedCache === null) {
    // 内联脚本（app/layout.tsx）已经在首屏前把属性写好了，这里只读结果。
    collapsedCache =
      typeof document !== "undefined" &&
      document.documentElement.dataset.sidebar === "collapsed";
  }
  return collapsedCache;
}

function subscribeCollapsed(listener: () => void): () => void {
  collapseListeners.add(listener);
  return () => collapseListeners.delete(listener);
}

function toggleCollapsed(): void {
  const next = !readCollapsed();
  collapsedCache = next;
  document.documentElement.dataset.sidebar = next ? "collapsed" : "expanded";
  try {
    localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
  } catch {
    /* 存不进去不影响本次会话 */
  }
  for (const listener of collapseListeners) listener();
}

/* ------------------------------------------------------------- 导航模型 */

type NavLeaf = {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  badge?: number;
};

/** 判断某个 href 是否命中当前地址。带 query 的目标要连查询串一起比 —— 
    否则 /wiki 与 /wiki?view=graph 会同时高亮。 */
function isActive(href: string, pathname: string, params: URLSearchParams): boolean {
  const [path, query] = href.split("?");
  const inPath = pathname === path || pathname.startsWith(`${path}/`);
  if (!inPath) return false;
  if (!query) {
    // 不带查询串的目标：当前也不能带着「用来区分同一路由不同视图」的参数。
    // /chat 用 s 区分会话、/wiki 用 view 区分视图 —— 少了这一步，
    // 打开某段对话时「新对话」与那条会话会同时高亮，出现两个 aria-current。
    if (path === "/chat") return !params.get("s");
    if (path === "/wiki") return !params.get("view");
    return true;
  }
  for (const [key, value] of new URLSearchParams(query)) {
    if (params.get(key) !== value) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ 组件 */

export function AppNav() {
  return (
    <>
      {/* 桌面端固定侧栏 */}
      <aside
        // z-20：main 是 relative z-10，而 aside 自身构成 stacking context
        //（sticky + backdrop-blur），弹层在它的子树里抬不出去 —— 不加这一层的话，
        // 折叠态（侧栏只有 60px、弹层有 256px）下弹层右半边会被 main 盖住，
        // 点「从 Markdown 重建索引」只会把弹层关掉。那是数据库损坏时唯一的手动自救入口。
        className="sidebar-collapsible sticky top-0 z-20 hidden h-dvh shrink-0 flex-col border-r border-border bg-[color-mix(in_srgb,var(--background)_86%,transparent)] backdrop-blur-sm md:flex"
        style={{ width: "var(--sidebar-w)" }}
      >
        <SidebarBody />
      </aside>

      {/* 移动端：细顶栏 + 抽屉 */}
      <MobileNav />
    </>
  );
}

function SidebarBody({
  onClose,
}: {
  /** 传了就是移动端抽屉：右上角变成「关闭」而不是「折叠」 */
  onClose?: () => void;
}) {
  const collapsed = React.useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  // 这三份数据由 AppDataProvider 统一取（外壳层只有一份实例），
  // 侧栏在这里只读 —— 桌面栏与移动端抽屉各挂一份也不会重复请求。
  const { vault, sessions: allSessions, pendingReview, bumpData, agentName } = useAppData();
  const [sessionMenu, setSessionMenu] = React.useState<{
    id: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);
  const [sessionMenuError, setSessionMenuError] = React.useState<string | null>(null);
  const [renamingSession, setRenamingSession] = React.useState(false);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [showSessions, setShowSessions] = React.useState(false);
  const [summarizingSessionId, setSummarizingSessionId] = React.useState<string | null>(null);
  const sessionMenuRef = React.useRef<HTMLDivElement>(null);
  const sessionMenuTriggerRef = React.useRef<HTMLElement | null>(null);
  // 当前会话可能不在最近 8 条里（用旧书签打开一段很久没动的对话就会这样）。
  // 那时「新对话」因为带 s 被判为不活跃、列表里那条又没渲染，侧栏一个高亮都没有 ——
  // 所以把当前这条顶进来，而不是只改高亮：用户也需要在列表里看到自己在哪。
  const currentSessionId = params.get("s");
  const sessions = React.useMemo(() => {
    const recent = allSessions.slice(0, 8);
    if (currentSessionId && !recent.some((s) => s.id === currentSessionId)) {
      const current = allSessions.find((s) => s.id === currentSessionId);
      if (current) return [current, ...recent.slice(0, 7)];
    }
    return recent;
  }, [allSessions, currentSessionId]);
  const sessionMenuSession = sessionMenu
    ? allSessions.find((session) => session.id === sessionMenu.id) ?? null
    : null;

  React.useEffect(() => {
    if (!sessionMenu) return;
    if (!renamingSession) {
      sessionMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!sessionMenuRef.current?.contains(event.target as Node)) setSessionMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSessionMenu(null);
        sessionMenuTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sessionMenu, renamingSession]);

  const openSessionMenu = React.useCallback(
    (x: number, y: number, id: string, title: string) => {
      setSessionMenuError(null);
      setRenamingSession(false);
      setRenameDraft(title);
      setSessionMenu({
        id,
        title,
        x: Math.max(8, Math.min(x, window.innerWidth - 188)),
        y: Math.max(8, Math.min(y, window.innerHeight - 176)),
      });
    },
    [],
  );

  const runSessionAction = React.useCallback(
    async (action: () => Promise<void>) => {
      setSessionMenuError(null);
      try {
        await action();
        setSessionMenu(null);
        bumpData();
      } catch (error) {
        setSessionMenuError(error instanceof Error ? error.message : "操作失败。");
      }
    },
    [bumpData],
  );

  // 全部并列，不再给「知识库」做一层分组 —— 分组把「关系网络 / 版本」说成了
  // 知识库的子功能，但它们本来就是同一层的三个视图，多一层缩进只是多一次理解。
  const primaryNav: NavLeaf[] = [
    { href: "/chat", label: "新对话", icon: MessagesSquare },
    { href: "/wiki", label: "知识库", icon: BookText },
    { href: "/trash", label: "回收站", icon: Trash2 },
    { href: "/wiki?view=graph", label: "关系网络", icon: Network },
    { href: "/review", label: "体检", icon: ShieldCheck, badge: pendingReview },
    { href: "/settings", label: "设置", icon: SettingsIcon },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 折叠按钮与导航图标共用固定位置，文字随栏宽淡出。 */}
      <div className={cn("flex h-14 shrink-0 items-center gap-2 overflow-hidden", onClose ? "px-3" : "px-2")}>
        {!onClose && <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "展开导航" : "收起导航"}
          aria-expanded={!collapsed}
          title={collapsed ? "展开导航" : "收起导航"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground transition-colors duration-150 hover:bg-[var(--muted)] hover:text-foreground"
        >
          {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.8} /> : <PanelLeftClose size={16} strokeWidth={1.8} />}
        </button>}
        <Link href="/wiki" aria-label={agentName} tabIndex={collapsed && !onClose ? -1 : undefined} className="sidebar-label flex min-w-0 flex-1 items-center gap-1.5">
          <WeaveMark className="h-5 w-5 text-foreground" />
          <span className="truncate text-[14px] font-semibold tracking-[0.06em] text-foreground">{agentName}</span>
        </Link>
        {onClose && <button type="button" onClick={onClose} aria-label="关闭导航" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors duration-150 hover:bg-[var(--muted)] hover:text-foreground"><X size={15} strokeWidth={1.8} /></button>}
      </div>

      <nav className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-2">
        {/* 「添加资料」不在这里：导入是知识库页的一个动作，已经在那里有入口，
            导航栏再放一个是同一个动作的第二个入口，只会让人犹豫该点哪个。 */}
        <div className="space-y-0.5">
          {primaryNav.map((item) => (
            <NavItem key={item.href} item={item} pathname={pathname} params={params} />
          ))}
        </div>

        {/* 最近对话 */}
        {sessions.length > 0 && (
          <>
            <GroupLabel>最近对话</GroupLabel>
            <div className="space-y-0.5">
              {sessions.map((session) => {
                const active = pathname === "/chat" && params.get("s") === session.id;
                return (
                  // 选中态必须有别于 hover 态：之前两者都是「灰底 + 深字」，
                  // 用户根本看不出侧栏里哪段对话是打开着的。这里复用导航项的
                  // 左侧竖条，与顶部导航保持同一套「当前所在」的语言。
                  <Link
                    key={session.id}
                    href={`/chat?s=${session.id}`}
                    aria-current={active ? "page" : undefined}
                    aria-haspopup="menu"
                    title={`${session.title || "未命名对话"} · 右键管理`}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      sessionMenuTriggerRef.current = event.currentTarget;
                      openSessionMenu(
                        event.clientX,
                        event.clientY,
                        session.id,
                        session.title || "未命名对话",
                      );
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                      event.preventDefault();
                      sessionMenuTriggerRef.current = event.currentTarget;
                      const rect = event.currentTarget.getBoundingClientRect();
                      openSessionMenu(rect.left, rect.bottom, session.id, session.title || "未命名对话");
                    }}
                    className={cn(
                      // sidebar-item 让折叠态把图标居中；sidebar-label 只加在文字上
                      // （加在整行上的话，折叠后连图标和选中竖条一起消失，
                      //   收起侧栏就再没有切换会话的入口了）
                      "sidebar-item sidebar-session group relative flex items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-[12.5px] transition-colors duration-150",
                      active
                        ? "bg-[var(--muted)] font-medium text-foreground"
                        : "text-muted-foreground hover:bg-[var(--muted)] hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute left-0 top-1/2 w-[2px] -translate-y-1/2 rounded-full bg-foreground transition-[height] duration-200",
                        active ? "h-3" : "h-0",
                      )}
                      aria-hidden
                    />
                    {session.generating
                      ? <LoaderCircle size={13} strokeWidth={1.8} className="shrink-0 animate-spin text-[var(--ring)]" aria-label="正在生成回答" />
                      : session.titleSummaryStatus === "pending" || session.titleSummaryStatus === "generating"
                        ? <Sparkles size={13} strokeWidth={1.8} className="shrink-0 animate-pulse text-[var(--ring)]" aria-label="正在总结会话名称" />
                        : <MessagesSquare size={13} strokeWidth={1.8} className="shrink-0 opacity-70" />}
                    <span className="sidebar-label truncate">{session.title || "未命名对话"}</span>
                  </Link>
                );
              })}
            </div>
          </>
        )}
        <button type="button" className="sidebar-item mt-2 flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setShowSessions(true)} aria-label="查看全部对话"><History size={14} className="shrink-0" /><span className="sidebar-label">全部对话</span></button>
      </nav>
      {showSessions && <SessionListDialog onClose={() => { setShowSessions(false); onClose?.(); }} />}

      {/* 底部固定区 */}
      <div className="sidebar-footer shrink-0 overflow-hidden border-t border-border p-2">
        <IngestIndicator />
        <JobIndicators />
        <VaultStatus pages={vault?.stats.pages ?? 0} healthy={vault?.indexHealthy ?? true} />
      </div>

      {sessionMenu && createPortal(
        <div
          ref={sessionMenuRef}
          role={renamingSession ? undefined : "menu"}
          aria-label={`${sessionMenu.title}的操作`}
          className="fixed z-[60] w-44 rounded-[10px] border border-border bg-popover p-1 shadow-dialog"
          style={{ left: sessionMenu.x, top: sessionMenu.y }}
        >
          {renamingSession ? (
            <form
              className="space-y-2 p-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void runSessionAction(async () => {
                  await apiFetch(`/api/chat/sessions/${sessionMenu.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ title: renameDraft }),
                  });
                });
              }}
            >
              <label htmlFor="sidebar-session-title" className="sr-only">对话名称</label>
              <input
                id="sidebar-session-title"
                autoFocus
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                maxLength={60}
                className="h-8 w-full rounded-md border border-[var(--input)] bg-card px-2 text-[12px] text-foreground outline-none focus:border-[var(--focus-ring)]"
              />
              <div className="flex justify-end gap-1">
                <button
                  type="button"
                  className="rounded-full px-2.5 py-1 text-[11.5px] text-muted-foreground hover:bg-[var(--muted)] hover:text-foreground"
                  onClick={() => { setRenamingSession(false); setSessionMenuError(null); }}
                >
                  取消
                </button>
                <button type="submit" className="rounded-full bg-primary px-2.5 py-1 text-[11.5px] text-primary-foreground hover:bg-primary/90">
                  保存
                </button>
              </div>
            </form>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={
                  summarizingSessionId === sessionMenu.id ||
                  sessionMenuSession?.titleSummaryStatus === "pending" ||
                  sessionMenuSession?.titleSummaryStatus === "generating" ||
                  sessionMenuSession?.generating ||
                  !sessionMenuSession
                }
                title={sessionMenuSession?.generating ? "请等当前回答完成后再总结名称" : undefined}
                className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[12.5px] text-foreground transition-colors hover:bg-[var(--muted)] disabled:cursor-wait disabled:opacity-55"
                onClick={() => {
                  const id = sessionMenu.id;
                  setSummarizingSessionId(id);
                  void runSessionAction(async () => {
                    await apiFetch(`/api/chat/sessions/${id}/summarize`, { method: "POST" });
                  }).finally(() => setSummarizingSessionId(null));
                }}
              >
                {summarizingSessionId === sessionMenu.id ||
                  sessionMenuSession?.titleSummaryStatus === "pending" ||
                  sessionMenuSession?.titleSummaryStatus === "generating"
                  ? <LoaderCircle size={13} strokeWidth={1.8} className="animate-spin text-[var(--ring)]" />
                  : <Sparkles size={13} strokeWidth={1.8} className="text-[var(--ring)]" />}
                {summarizingSessionId === sessionMenu.id ||
                  sessionMenuSession?.titleSummaryStatus === "pending" ||
                  sessionMenuSession?.titleSummaryStatus === "generating"
                  ? "正在总结名称…"
                  : sessionMenuSession?.titleSummaryStatus === "failed"
                    ? "重试 AI 总结"
                    : sessionMenuSession?.titleOrigin === "ai"
                      ? "AI 重新总结名称"
                      : "AI 总结名称"}
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[12.5px] text-foreground transition-colors hover:bg-[var(--muted)]"
                onClick={() => { setRenamingSession(true); setRenameDraft(sessionMenu.title); }}
              >
                <Pencil size={13} strokeWidth={1.8} />
                重命名
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[12.5px] text-[var(--destructive)] transition-colors hover:bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)]"
                onClick={() =>
                  void runSessionAction(async () => {
                    await apiFetch(`/api/chat/sessions/${sessionMenu.id}`, { method: "DELETE" });
                    if (currentSessionId === sessionMenu.id) router.replace("/chat");
                  })
                }
              >
                <Trash2 size={13} strokeWidth={1.8} />
                删除对话
              </button>
            </>
          )}
          {sessionMenuError && (
            <p role="alert" className="px-2.5 pb-1.5 pt-1 text-[11px] leading-relaxed text-[var(--destructive)]">
              {sessionMenuError}
            </p>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="sidebar-label sidebar-group-label px-2.5 pb-1 pt-4 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * 导航项。
 *
 * 选中态用灰底圆角（对齐参考站的视觉）。同时保留 design DNA 的签名「生长」动效 ——
 * 顶部横向导航里它是下划线宽度 0→100%，在这里转译成左边缘一根从 0 长到 14px 的竖条：
 * 横排变竖排时，把「生长」的方向一起转 90° 才是同一个语言。
 */
function NavItem({
  item,
  pathname,
  params,
}: {
  item: NavLeaf;
  pathname: string;
  params: URLSearchParams;
}) {
  const active = isActive(item.href, pathname, params);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={item.label}
      className={cn(
        "sidebar-item group relative flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[13px] font-medium transition-colors duration-150",
        active
          ? "bg-[var(--muted)] text-foreground"
          : "text-muted-foreground hover:bg-[var(--muted)] hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "absolute left-0 top-1/2 w-[2px] -translate-y-1/2 rounded-full bg-foreground transition-[height] duration-200 ease-out",
          active ? "h-3.5" : "h-0 group-hover:h-2",
        )}
        aria-hidden
      />
      <Icon size={15} strokeWidth={1.8} className="shrink-0" />
      <span className="sidebar-label truncate">{item.label}</span>
      {item.badge !== undefined && item.badge > 0 && (
        <span className="sidebar-label ml-auto rounded-full bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] px-1.5 text-[10.5px] font-semibold tabular-nums text-[var(--warning)]">
          {item.badge}
        </span>
      )}
    </Link>
  );
}

/**
 * 后台导入的指示器。
 *
 * 为什么必须存在：导入是分钟级的，而用户不该被扣在那个抽屉里。任务状态住在
 * IngestProvider 里，抽屉关掉之后总得有个地方能看见它 —— 否则「可以关掉窗口」
 * 就变成了「关掉之后就再也找不到进度了」。
 *
 * 三种状态各说一句话，都不是装饰：跑着（还差多少）、待审（该你了）、
 * 上次没成（可以重来）。没有任务时整块不渲染，不占位置。
 */
function IngestIndicator() {
  const { phase, progress, stageLabel, error, openDrawer } = useIngest();

  const running = phase === "running";
  // 只有三种情况值得占位置：跑着、等你审、上一次没成。
  // done / duplicate 都是「已经看完结论」的状态，抽屉正开着，不必再挂一个指示器。
  const visible = running || phase === "review" || (phase === "idle" && Boolean(error));
  if (!visible) return null;
  const label = running
    ? `${stageLabel || "导入中"} ${Math.round(progress)}%`
    : phase === "review"
      ? "导入草稿待你审阅"
      : "上次导入没完成";

  // 整行可点，打开抽屉 —— 停止是抽屉里的动作，栏底只显示进度。
  // 在 60px 宽的折叠栏里塞进第二个按钮，误点的代价是丢掉几分钟的工作。
  return (
    <button
      type="button"
      onClick={openDrawer}
      title={label}
      className="flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-[var(--muted)] hover:text-foreground"
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          running && "animate-pulse",
        )}
        style={{
          background: running ? "var(--ring)" : phase === "review" ? "var(--warning)" : "var(--destructive)",
        }}
        aria-hidden
      />
      <span className="sidebar-label min-w-0 flex-1 truncate">{label}</span>
      {running && (
        <span className="sidebar-label h-1 w-8 shrink-0 overflow-hidden rounded-full bg-[var(--muted)]">
          <span
            className="block h-full origin-left rounded-full bg-[var(--ring)] transition-transform duration-500 ease-out"
            style={{ transform: `scaleX(${Math.max(0, Math.min(100, progress)) / 100})` }}
          />
        </span>
      )}
    </button>
  );
}

/**
 * 知识库状态。纯展示，不可点击。
 *
 * 「从 Markdown 重建索引」搬去了设置页最后一节：它是索引损坏时的自救入口，
 * 一年也用不上一次，摆在常驻的侧栏里只会让人以为需要经常点。
 * 这里只回答一个问题 —— 知识库现在正常吗。
 */
function VaultStatus({ pages, healthy }: { pages: number; healthy: boolean }) {
  return (
    <div
      title={healthy ? `知识库正常 · ${pages} 个词条` : "索引状态异常 —— 可在设置页重建索引"}
      className="flex items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[12.5px] text-muted-foreground"
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: healthy ? "var(--success)" : "var(--warning)" }}
        aria-hidden
      />
      <span className="sidebar-label truncate">{healthy ? "知识库正常" : "索引状态异常"}</span>
      <span className="sidebar-label ml-auto tabular-nums">{pages}</span>
    </div>
  );
}

/* -------------------------------------------------------------- 移动端 */

function MobileNav() {
  const [open, setOpen] = React.useState(false);
  const { agentName } = useAppData();
  const pathname = usePathname();
  const params = useSearchParams();
  const drawerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  // 主动关闭时把焦点还给汉堡按钮。抽屉是条件渲染，关闭时被聚焦的元素连同整棵子树
  // 一起卸载、焦点掉回 <body>；而这里声明了 aria-modal，等于承诺焦点管理是完整的。
  // 注意只用于「用户主动关闭」——路由变化那种收起应该让焦点随新页面走。
  const closeDrawer = React.useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // 焦点陷阱 + Escape。没有陷阱就不该声明 aria-modal ——
  // 那会让读屏用户以为背景不可达，而键盘用户其实还能 Tab 到背后看不见的元素上。
  React.useEffect(() => {
    if (!open) return;
    const root = drawerRef.current;
    if (!root) return;

    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);

    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, closeDrawer]);

  // 路由变化后自动收起，避免点完链接抽屉还盖在内容上。
  // 依赖里必须带上查询串：/wiki → /wiki?view=graph 与 /chat → /chat?s=<id>
  // 这两类跳转只改查询串，pathname 不动 —— 只盯 pathname 的话，
  // 用户点了「关系网络」抽屉还盖在上面，看起来像点了没反应。
  React.useEffect(() => {
    setOpen(false);
  }, [pathname, params]);

  return (
    <>
      <div className="sticky top-0 z-[var(--z-index-header)] flex h-12 items-center gap-3 border-b border-border bg-[color-mix(in_srgb,var(--background)_88%,transparent)] px-3 backdrop-blur-sm md:hidden">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="打开导航"
          aria-expanded={open}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[7px] text-foreground transition-colors hover:bg-[var(--muted)]"
        >
          <Menu size={17} strokeWidth={1.8} />
        </button>
        <WeaveMark className="h-5 w-5 text-foreground" />
        <span className="min-w-0 truncate text-[14px] font-semibold tracking-[0.06em] text-foreground">{agentName}</span>
      </div>

      {open && (
        <div
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="导航"
          className="fixed inset-0 z-[var(--z-index-modal)] md:hidden"
        >
          <div
            className="absolute inset-0 bg-[color-mix(in_srgb,var(--foreground)_18%,transparent)]"
            onClick={closeDrawer}
            aria-hidden
          />
          <div className="panel-in absolute inset-y-0 left-0 flex w-[248px] flex-col border-r border-border bg-background">
            <SidebarBody onClose={closeDrawer} />
          </div>
        </div>
      )}
    </>
  );
}
