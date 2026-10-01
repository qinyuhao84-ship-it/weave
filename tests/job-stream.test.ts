import { beforeEach, expect, it } from 'vitest';
import { enqueue, getJob, saveDraft } from '@/lib/jobs/runner';
import { GET } from '@/app/api/jobs/[id]/stream/route';
import { dropAllIndexTables } from '@/lib/db/client';
import { resetVault } from './helpers';
beforeEach(() => { resetVault(); dropAllIndexTables(); });
for (const review of [false, true]) {
  it(`同步补发${review ? '待审阅' : '完成'}历史时正确关闭订阅`, async () => {
    const jobId = enqueue({ kind: 'ingest', handler: async context => {
      if (review) { saveDraft(context.jobId, { fixture: true }); return { awaitingReview: true }; }
      return {};
    } });
    for (let i = 0; i < 100; i++) {
      if (['done', 'awaiting_review'].includes(getJob(jobId)?.status ?? '')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const response = await GET(new Request('http://localhost/api/jobs/fixture/stream'), { params: Promise.resolve({ id: jobId }) });
    const text = await response.text();
    expect(text).toContain(review ? 'awaiting_review' : 'done');
  });
}
