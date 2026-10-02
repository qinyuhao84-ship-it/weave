"use client";
import { useI18n } from "@/components/i18n-provider";

import { useAppData } from "@/components/app-provider";
import { SessionListDialog } from "@/components/chat/session-list-dialog";
import { JobIndicators } from "@/components/jobs/job-indicator";
import { WeaveMark } from "@/components/ui/weave-mark";
import { apiFetch } from "@/hooks/use-api";
import { cn } from "@/lib/utils";
import {
  BookText,
  History,
  LoaderCircle,
  Menu,
  MessagesSquare,
  Network,
  PanelLeftClose, PanelLeftOpen,
  Pencil,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { createPortal } from "react-dom";

import { IngestIndicator } from "@/components/ingest/ingest-indicator";
import { GroupLabel, NavItem, VaultStatus, type NavLeaf } from "./navigation-item";

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
  const { t } = useI18n();
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
        bumpData("sessions");
      } catch (error) {
        setSessionMenuError(error instanceof Error ? error.message : t("layout_sidebar.m001"));
      }
    },
    [bumpData, t],
  );

  // 全部并列，不再给「知识库」做一层分组 —— 分组把「关系网络 / 版本」说成了
  // 知识库的子功能，但它们本来就是同一层的三个视图，多一层缩进只是多一次理解。
  const primaryNav: NavLeaf[] = [
    { href: "/chat", label: t("layout_sidebar.m002"), icon: MessagesSquare },
    { href: "/wiki", label: t("layout_sidebar.m003"), icon: BookText },
    { href: "/trash", label: t("layout_sidebar.m004"), icon: Trash2 },
    { href: "/wiki?view=graph", label: t("layout_sidebar.m005"), icon: Network },
    { href: "/review", label: t("layout_sidebar.m006"), icon: ShieldCheck, badge: pendingReview },
    { href: "/settings", label: t("layout_sidebar.m007"), icon: SettingsIcon },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 折叠按钮与导航图标共用固定位置，文字随栏宽淡出。 */}
      <div className={cn("flex h-14 shrink-0 items-center gap-2 overflow-hidden", onClose ? "px-3" : "px-2")}>
        {!onClose && <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? t("layout_sidebar.m008") : t("layout_sidebar.m009")}
          aria-expanded={!collapsed}
          title={collapsed ? t("layout_sidebar.m008") : t("layout_sidebar.m009")}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground transition-colors duration-150 hover:bg-[var(--muted)] hover:text-foreground"
        >
          {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.8} /> : <PanelLeftClose size={16} strokeWidth={1.8} />}
        </button>}
        <Link href="/wiki" aria-label={agentName} tabIndex={collapsed && !onClose ? -1 : undefined} className="sidebar-label flex min-w-0 flex-1 items-center gap-1.5">
          <WeaveMark className="h-5 w-5 text-foreground" />
          <span className="truncate text-[14px] font-semibold tracking-[0.06em] text-foreground">{agentName}</span>
        </Link>
        {onClose && <button type="button" onClick={onClose} aria-label={t("layout_sidebar.m010")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors duration-150 hover:bg-[var(--muted)] hover:text-foreground"><X size={15} strokeWidth={1.8} /></button>}
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
            <GroupLabel>{t("layout_sidebar.m011")}</GroupLabel>
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
                    title={t("layout_sidebar.m013", {v0: session.title || t("layout_sidebar.m012")})}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      sessionMenuTriggerRef.current = event.currentTarget;
                      openSessionMenu(
                        event.clientX,
                        event.clientY,
                        session.id,
                        session.title || t("layout_sidebar.m012"),
                      );
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                      event.preventDefault();
                      sessionMenuTriggerRef.current = event.currentTarget;
                      const rect = event.currentTarget.getBoundingClientRect();
                      openSessionMenu(rect.left, rect.bottom, session.id, session.title || t("layout_sidebar.m012"));
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
                      ? <LoaderCircle size={13} strokeWidth={1.8} className="shrink-0 animate-spin text-[var(--ring)]" aria-label={t("layout_sidebar.m014")} />
                      : session.titleSummaryStatus === "pending" || session.titleSummaryStatus === "generating"
                        ? <Sparkles size={13} strokeWidth={1.8} className="shrink-0 animate-pulse text-[var(--ring)]" aria-label={t("layout_sidebar.m015")} />
                        : <MessagesSquare size={13} strokeWidth={1.8} className="shrink-0 opacity-70" />}
                    <span className="sidebar-label truncate">{session.title || t("layout_sidebar.m012")}</span>
                  </Link>
                );
              })}
            </div>
          </>
        )}
        <button type="button" className="sidebar-item mt-2 flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setShowSessions(true)} aria-label={t("layout_sidebar.m016")}><History size={14} className="shrink-0" /><span className="sidebar-label">{t("layout_sidebar.m017")}</span></button>
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
          aria-label={t("layout_sidebar.m018", {v0: sessionMenu.title})}
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
              <label htmlFor="sidebar-session-title" className="sr-only">{t("layout_sidebar.m019")}</label>
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
                  {t("layout_sidebar.m020")}</button>
                <button type="submit" className="rounded-full bg-primary px-2.5 py-1 text-[11.5px] text-primary-foreground hover:bg-primary/90">
                  {t("layout_sidebar.m021")}</button>
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
                title={sessionMenuSession?.generating ? t("layout_sidebar.m022") : undefined}
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
                  ? t("layout_sidebar.m023")
                  : sessionMenuSession?.titleSummaryStatus === "failed"
                    ? t("layout_sidebar.m024")
                    : sessionMenuSession?.titleOrigin === "ai"
                      ? t("layout_sidebar.m025")
                      : t("layout_sidebar.m026")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[12.5px] text-foreground transition-colors hover:bg-[var(--muted)]"
                onClick={() => { setRenamingSession(true); setRenameDraft(sessionMenu.title); }}
              >
                <Pencil size={13} strokeWidth={1.8} />
                {t("layout_sidebar.m027")}</button>
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
                {t("layout_sidebar.m028")}</button>
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

/* -------------------------------------------------------------- 移动端 */

function MobileNav() {
  const { t } = useI18n();
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
          aria-label={t("layout_sidebar.m036")}
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
          aria-label={t("layout_sidebar.m037")}
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
