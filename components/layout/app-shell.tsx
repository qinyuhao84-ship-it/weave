"use client";

import * as React from "react";
import { AppNav } from "./sidebar";
import { useTheme } from "@/hooks/use-theme";

/**
 * 应用外壳：左侧导航 + 主区 + 背景光斑。
 *
 * 这里只渲染**一次** —— 由 app/(app)/layout.tsx 拥有。
 * 原来每个页面的 workspace 组件各自实例化一次外壳（8 处），
 * 于是每次路由切换都要把导航、主题开关、背景光斑整棵卸载重挂；
 * 侧栏落地后这个代价更明显（折叠状态、会话列表、滚动位置都会被重置）。
 *
 * 外壳不再接收 pendingReview / onOpenIngest 之类的页面数据：
 * 那些由侧栏自己按需取，页面只管自己的内容。
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  // 常驻订阅主题。prefers-color-scheme 的监听挂在 useTheme 的 subscribe 里，
  // 而 subscribe 只有在有组件真正调用 useTheme 时才会被 React 调用 ——
  // 原来只有设置页与图谱页在调，于是停在知识库/对话页时，系统切深浅色不会生效，
  // 必须刷新。默认设置就是「跟随系统」，所以受影响的是大多数人。
  useTheme();

  return (
    // 移动端必须是纵向堆叠：AppNav 在窄屏下渲染的是一条顶部导航条，
    // 如果父容器是 flex-row，那条导航会变成主区左边的一列，把主区挤成窄条。
    <div className="flex min-h-dvh flex-col md:flex-row">
      <a href="#main-content" className="skip-navigation">跳到主要内容</a>
      {/* 背景光斑：blur(100px) + opacity .06，两个错开 -10s 避免同步呼吸。
          用 --primary（近黑）而不是 --ring（蓝）：蓝色是「注意力该到这里」的信号色，
          拿它铺背景会让整页泛蓝，也削弱了它在 AI 工作态里的作用。 */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
        <div className="blob left-[4%] top-[-6%] h-[420px] w-[420px] bg-primary" />
        <div className="blob right-[2%] top-[34%] h-[360px] w-[360px] bg-[var(--warning)]" />
      </div>

      {/* 侧栏用到 useSearchParams（要把 /wiki 与 /wiki?view=graph 区分开），
          必须裹 Suspense，否则静态渲染阶段会报错。fallback 占住宽度避免布局跳动。 */}
      <React.Suspense
        fallback={<div className="hidden shrink-0 md:block" style={{ width: "var(--sidebar-w)" }} />}
      >
        <AppNav />
      </React.Suspense>

      <main id="main-content" tabIndex={-1} className="relative z-10 min-w-0 flex-1">{children}</main>
    </div>
  );
}
