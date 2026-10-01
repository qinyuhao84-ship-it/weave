"use client";

import * as React from "react";

/**
 * 是否开启了「减少动态效果」。
 *
 * CSS 的 @media (prefers-reduced-motion) 只能关掉 CSS 动画 ——
 * 我们用 requestAnimationFrame 手绘的那些（图谱涟漪、边上的电流）
 * 它管不到，必须在这里自己判断。这是无障碍里最容易漏的一类：
 * 会在 CSS 里写降级，却忘了 JS 驱动的动效。
 *
 * 用 useSyncExternalStore 而不是 useState + useEffect。两者的差别分两种路径：
 * 客户端路由切换后的首次渲染，getSnapshot 在渲染阶段就给出真值，
 * 不会像 useState 那样先渲染 false 再在 effect 里纠正；
 * 而直接刷新页面（SSR + hydration）时，hydration 那一帧仍然走
 * getServerSnapshot 的 false，真值在同一次 commit 的被动效应里被纠正 —— 这一帧消不掉。
 * 所以：**挂载即播的 JS 动效不要只靠这个 hook 门控**，
 * 那类效果需要和首屏防闪脚本一样，在渲染前就把结论写进 DOM。
 */

const QUERY = "(prefers-reduced-motion: reduce)";

// MediaQueryList 缓存一份。getSnapshot 每次渲染都会被调用，
// 每次都 matchMedia 会白白新建对象。
let cachedMedia: MediaQueryList | null = null;

function mediaQuery(): MediaQueryList {
  if (!cachedMedia) cachedMedia = window.matchMedia(QUERY);
  return cachedMedia;
}

function subscribe(onStoreChange: () => void): () => void {
  const media = mediaQuery();
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

function getSnapshot(): boolean {
  return mediaQuery().matches;
}

/** 服务端与 hydration 帧没有 matchMedia，按「不降级」渲染；客户端随后纠正。 */
function getServerSnapshot(): boolean {
  return false;
}

export function useReducedMotion(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
