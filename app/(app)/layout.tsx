import { AppShell } from "@/components/layout/app-shell";
import { AppDataProvider } from "@/components/app-provider";

/**
 * 应用外壳的路由组。
 *
 * 用 (app) 这个路由组把带外壳的页面收在一起，URL 完全不受影响
 * （括号目录不参与路径）。好处是外壳与导入抽屉都只挂载一次，
 * 页面之间切换时它们保持存活 —— 侧栏的折叠状态、滚动位置、
 * 会话列表不会被每次导航重置。
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppDataProvider>
      <AppShell>{children}</AppShell>
    </AppDataProvider>
  );
}
