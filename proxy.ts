import { NextResponse, type NextRequest } from "next/server";
import { isLocalRequest } from "@/lib/local-access";

export function proxy(request: NextRequest) {
  if (!isLocalRequest(request.url, request.headers)) {
    return NextResponse.json({ ok: false, error: "织识仅接受本机页面的请求。请从启动时显示的本机地址打开应用。" }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
