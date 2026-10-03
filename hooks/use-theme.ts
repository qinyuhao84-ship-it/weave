"use client";

import * as React from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "weave-theme";

type ThemeState = {
  theme: Theme;
  /** 把「跟随系统」解析之后的结果也放进快照。
      没有它的话，选「跟随系统」的用户在系统切到深色时，界面不会跟着变 ——
      因为 theme 字段本身没变，订阅者收不到任何通知。这是默认选项，
      所以受影响的是大多数人。 */
  resolved: "light" | "dark";
};

/**
 * 主题管理。
 *
 * 深色模式是用户明确要求的 —— 知识库是长时间阅读场景，晚上看白底很伤眼。
 *
 * 状态放在**模块级**而不是组件里：主题开关会同时出现在导航栏底部与设置页，
 * 两个 useTheme 实例各自持有一份 state 就会互相不同步 —— 改了侧栏那个，
 * 设置页那个还显示旧值。外面用 useSyncExternalStore 订阅，两个入口共享同一个真源。
 */

/* ------------------------------------------------------------ 存储读写
   localStorage 在隐私模式或禁用站点数据时会直接抛错。读不出来只是回到默认值，
   不该把整个页面带崩，所以读写都兜住。 */
function readStored<T extends string>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    // 显式判 null 与空串。用 ?? 会把空串当成合法值，
    // 而首屏内联脚本（app/layout.tsx:27）用的是 `|| "system"` —— 空串在那里等于未设置。
    // 两处语义不一致的话，一旦 key 是空串，首屏按「跟随系统」上色，
    // hook 却会因为 theme 既不等于 "dark" 也不等于 "system" 而把页面钉死在亮色。
    return raw === null || raw === "" ? fallback : (raw as T);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 存不进去就算了，本次会话内仍然生效 */
  }
}

/* ---------------------------------------------------------------- 真源 */
/** 服务端与 hydration 阶段固定用这个常量。
    不能让它指向 state —— state 会被 hydrate() 整个替换掉，
    那样 getServerSnapshot 在 hydration 之后就会返回客户端值，
    与服务端渲染出的 HTML 不一致。 */
const INITIAL: ThemeState = { theme: "system", resolved: "light" };

let state: ThemeState = INITIAL;
let hydrated = false;
let mediaBound = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 把 theme 解析成实际的亮/暗。跟随系统时要看系统偏好。 */
function resolve(next: Omit<ThemeState, "resolved">): ThemeState {
  const dark = next.theme === "dark" || (next.theme === "system" && prefersDark());
  return { ...next, resolved: dark ? "dark" : "light" };
}

/** 把状态写进 <html>。首屏防闪脚本（app/layout.tsx）已经写过一次，
    这里保证后续每一次切换都同步。 */
function apply(next: ThemeState): void {
  const root = document.documentElement;
  root.classList.toggle("dark", next.resolved === "dark");
  root.removeAttribute("data-theme");
}

/** 挂载后才读 localStorage —— 模块顶层读会在服务端炸掉。 */
function hydrate(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  state = resolve({
    theme: readStored<Theme>(STORAGE_KEY, "system"),
  });
}

/** getSnapshot 必须返回稳定引用，每次新建对象会让 React 判定为无限更新。 */
function getSnapshot(): ThemeState {
  hydrate();
  return state;
}

/** SSR 阶段没有 localStorage，固定用初始值；hydration 后由 getSnapshot 纠正。 */
function getServerSnapshot(): ThemeState {
  return INITIAL;
}

function subscribe(onStoreChange: () => void): () => void {
  hydrate();
  // 在这里用真值校正 DOM，而不是在 hook 的 effect 里用渲染快照。
  // hydration 首帧的 snapshot 来自 getServerSnapshot 常量 INITIAL（system/false），
  // 拿它去 apply 会先用推导值覆盖内联脚本写好的 <html>，再被纠正回来。
  apply(state);
  // 跟随系统主题时，系统切换要能实时反映出来。只绑一次。
  if (!mediaBound && typeof window !== "undefined") {
    mediaBound = true;
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (state.theme !== "system") return;
      // 必须 emit：resolved 变了，订阅者（图谱画布、依赖底色的一切实色）要重画
      state = resolve(state);
      apply(state);
      emit();
    });
  }
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function update(patch: Partial<Omit<ThemeState, "resolved">>): void {
  state = resolve({ ...state, ...patch });
  apply(state);
  emit();
}

/* --------------------------------------------------------------- 写入口
   放在模块级而不是 hook 里：任何地方都能调用，不依赖组件是否挂载。 */
export function setTheme(next: Theme): void {
  writeStored(STORAGE_KEY, next);
  update({ theme: next });
}

export function useTheme() {
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return {
    theme: snapshot.theme,
    /** 实际生效的亮/暗（已解析「跟随系统」）。画布、图表这类读不到 CSS 的地方用它。 */
    resolved: snapshot.resolved,
    setTheme,
  };
}
