/** 本机单用户服务的访问边界，包含 DNS rebinding 与跨站写请求。 */
export function isLocalRequest(url: string, headers: Headers): boolean {
  try {
    const host = headers.get("host");
    if (!host) return false;
    const target = new URL(url);
    const authority = new URL(`${target.protocol}//${host}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(authority.hostname)) return false;
    if (headers.get("sec-fetch-site") === "cross-site") return false;
    const origin = headers.get("origin");
    return !origin || new URL(origin).origin === authority.origin;
  } catch {
    return false;
  }
}
