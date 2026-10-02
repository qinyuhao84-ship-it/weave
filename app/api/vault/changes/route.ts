import { onExternalChange, startWatcher } from "@/lib/index/watcher";

import { sseResponse } from "@/lib/sse";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Push external Markdown edits to the app after the watcher has reindexed them. */
export async function GET(request: Request) {
  await startWatcher();
  return sseResponse(request, ({ send, onCleanup }) => {
    send({ type: "ready" });
    onCleanup(onExternalChange(({ changes, report }) => send({ type: "change", changes, report })));
  });
}
