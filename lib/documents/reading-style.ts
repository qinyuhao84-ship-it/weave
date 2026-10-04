export const READING_STYLE_ID = "weave-reading-style";

const DARK_TOKENS = `color-scheme:dark;--background:#111111;--foreground:#fcfbf9;--card:#18181b;--muted:#fcfbf914;--muted-foreground:#fcfbf9b8;--border:#fcfbf926;--primary:#fcfbf9;--primary-foreground:#111111;--reading-gold:#d7b67a;--reading-gold-soft:#d7b67a14;--focus-ring:#fcfbf9b3;--reading-info:#93c5fd;--reading-success:#86efac;--reading-warning:#fcd34d;--reading-danger:#fca5a5;`;

export const READING_CSS = `
html[data-weave-reading="1"]{color-scheme:light;--background:#fcfbf9;--foreground:#111111;--card:#fff;--muted:#1111110a;--muted-foreground:#111111ad;--border:#11111114;--primary:#111111;--primary-foreground:#fff;--reading-gold:#87612c;--reading-gold-soft:#87612c0d;--focus-ring:#111111b3;--reading-info:#1d4ed8;--reading-success:#166534;--reading-warning:#92400e;--reading-danger:#b91c1c;--reading-ease:cubic-bezier(.16,1,.3,1);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;-webkit-text-size-adjust:100%;scrollbar-color:var(--border) var(--background)}
@media(prefers-color-scheme:dark){html[data-weave-reading="1"]:not([data-weave-theme="light"]){${DARK_TOKENS}}}
html[data-weave-reading="1"][data-weave-theme="dark"]{${DARK_TOKENS}}
html[data-weave-reading="1"] *,html[data-weave-reading="1"] *::before,html[data-weave-reading="1"] *::after{box-sizing:border-box}
html[data-weave-reading="1"] body{margin:0;background:var(--background);color:var(--foreground);font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;overflow-wrap:anywhere;accent-color:var(--reading-gold)}
html[data-weave-reading="1"] main{width:100%;max-width:76ch;margin:0 auto;padding:28px 24px 40px;container-type:inline-size;container-name:weave-reading}
html[data-weave-reading="1"] h1{font-size:clamp(22px,4vw,30px);line-height:1.3;margin:0 0 16px;font-weight:650;text-wrap:balance}
html[data-weave-reading="1"] h2{font-size:20px;line-height:1.4;margin:28px 0 12px}
html[data-weave-reading="1"] h3{font-size:17px;line-height:1.5;margin:20px 0 8px}
html[data-weave-reading="1"] p{margin:0 0 14px}
html[data-weave-reading="1"] a{color:inherit;text-underline-offset:3px}
html[data-weave-reading="1"] ::selection{background:var(--reading-gold-soft);color:var(--foreground)}
html[data-weave-reading="1"] :focus-visible{outline:2px solid var(--focus-ring);outline-offset:3px}
html[data-weave-reading="1"] button,html[data-weave-reading="1"] input,html[data-weave-reading="1"] select{font:inherit;color:inherit;max-width:100%;caret-color:var(--foreground)}
html[data-weave-reading="1"] button{min-height:40px;padding:8px 14px;border:1px solid var(--border);border-radius:6px;background:var(--card);cursor:pointer;transition:background-color 150ms,color 150ms,border-color 150ms}
html[data-weave-reading="1"] button:hover:not(:disabled){background:var(--muted);border-color:var(--focus-ring)}
html[data-weave-reading="1"] button[aria-pressed="true"],html[data-weave-reading="1"] button[aria-selected="true"]{color:var(--reading-gold);background:var(--reading-gold-soft);border-color:var(--reading-gold)}
html[data-weave-reading="1"] button:disabled{opacity:.5;cursor:not-allowed}
html[data-weave-reading="1"] details{border-bottom:1px solid var(--border);padding:14px 0}
html[data-weave-reading="1"] summary{cursor:pointer;font-weight:600;min-height:40px;padding:6px 0}
html[data-weave-reading="1"] details p{margin:8px 0;white-space:pre-wrap}
html[data-weave-reading="1"] [hidden]{display:none!important}
.weave-panel{border:1px solid var(--border);border-radius:12px;background:var(--card);padding:18px}
.weave-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px}
.weave-grid>*{min-width:0}
html[data-weave-reading="1"] main>section+section{margin-top:24px}
.weave-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:16px 0}
.weave-muted,.weave-caption{color:var(--muted-foreground)}
.weave-caption{font-size:14px;line-height:1.6;margin:10px 0 16px}
.weave-diagram{display:block;width:100%;height:auto;color:var(--foreground);overflow:visible}
.weave-diagram text{font-family:inherit}
html[data-weave-reading="1"] [aria-label="知识库来源"]{max-width:76ch;margin:24px auto 0;padding:20px 24px 32px;border-top:1px solid var(--border);font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif}
html[data-weave-reading="1"] [aria-label="知识库来源"] h2{font-size:16px;margin:0 0 12px}
@media(max-width:640px){html[data-weave-reading="1"] body{font-size:15px}html[data-weave-reading="1"] main{padding:22px 16px 32px}html[data-weave-reading="1"] button,html[data-weave-reading="1"] summary{min-height:44px}.weave-panel{padding:14px}html[data-weave-reading="1"] [aria-label="知识库来源"]{padding:20px 16px}}
@media(prefers-reduced-motion:reduce){html[data-weave-reading="1"] *,html[data-weave-reading="1"] *::before,html[data-weave-reading="1"] *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

/** 仅在新附件生成时加入，历史附件读取时保留原样。 */
export function installReadingStyle(document: Document): void {
  document.documentElement.setAttribute("data-weave-reading", "1");
  document.documentElement.removeAttribute("data-weave-theme");
  document.getElementById(READING_STYLE_ID)?.remove();
  const style = document.createElement("style");
  style.id = READING_STYLE_ID;
  style.textContent = READING_CSS;
  document.head.insertBefore(style, document.head.firstChild);
}
