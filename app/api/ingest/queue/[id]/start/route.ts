import { fail, handle } from "@/lib/api";
import { IngestQueueError, startQueuedIngest } from "@/lib/ingest/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handle(async () => {
    try {
      return await startQueuedIngest(id);
    } catch (error) {
      if (error instanceof IngestQueueError) return fail(error.message, error.status);
      throw error;
    }
  });
}
