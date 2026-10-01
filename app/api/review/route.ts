import { handle, intParam } from "@/lib/api";
import { listReviewItems } from "@/lib/lint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") ?? "pending") as
    | "pending" | "answered" | "accepted" | "dismissed" | "all";
  const limit = intParam(url.searchParams.get("limit"), 100, 1, 500);

  return handle(() => ({
    items: listReviewItems(status).slice(0, limit),
    counts: {
      pending: listReviewItems("pending").length,
      // 已回答待处理。它必须出现在界面上 —— 已回答却处理失败的事项不会再被
      // 重新入队（queueFindings 的去重是全表 kind::title），用户不主动去看
      // 「已回答」页签就会以为它消失了
      answered: listReviewItems("answered").length,
      accepted: listReviewItems("accepted").length,
      dismissed: listReviewItems("dismissed").length,
    },
  }));
}
