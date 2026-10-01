import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    // srcdoc 自身限制网络；父页面策略同时禁止 iframe 自行导航到外部站点。
    return ["/chat", "/sources/:path*"].map(source => ({ source, headers: [{ key: "Content-Security-Policy", value: "frame-src 'self'; object-src 'none'" }] }));
  },
  /**
   * 「关系网络」并入知识库、版本界面移除之后，旧地址仍要能用 —— 老书签、
   * 浏览器历史、以及用户手输的 /graph 都还指向那里。
   *
   * 用 307（permanent: false）而不是 308：308 会被浏览器永久缓存，
   * 万一以后目的地要改，用户那边的旧缓存清不掉。
   */
  async redirects() {
    return [
      { source: "/graph", destination: "/wiki?view=graph", permanent: false },
      { source: "/history", destination: "/wiki", permanent: false },
    ];
  },
};

export default nextConfig;
