import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "织识",
  description: "从一堆散落的资料，到一座会自己生长的知识库。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 与 design DNA 一致：底色是暖米白，不是纯白
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfbf9" },
    { media: "(prefers-color-scheme: dark)", color: "#111111" },
  ],
};

/**
 * 主题要在首屏渲染之前应用，否则会出现「先白后黑」的闪烁。
 * 这段内联脚本在 <body> 之前同步执行，是本机单用户场景下最可靠的做法
 * （用 next-themes 之类会引入 hydration 不一致的额外风险）。
 */
const THEME_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("weave-theme") || "system";
    var focus = localStorage.getItem("weave-theme-focus") === "1";
    var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var dark = stored === "dark" || (stored === "system" && prefersDark);
    if (dark) document.documentElement.classList.add("dark");
    if (focus) document.documentElement.setAttribute("data-theme", "focus");
    // 侧栏折叠态也要在首屏前定下来，否则会先画成展开再塌下去
    document.documentElement.setAttribute(
      "data-sidebar",
      localStorage.getItem("weave-sidebar") === "1" ? "collapsed" : "expanded",
    );
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
