import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { startLintJob } from '@/lib/lint';
import { dropAllIndexTables } from '@/lib/db/client';
import { getJob } from '@/lib/jobs/runner';
import { FakeProvider } from '@/lib/llm/fake';
import * as service from '@/lib/vault/service';
import { resetVault } from './helpers';
beforeEach(() => { resetVault(); dropAllIndexTables(); });
afterEach(() => vi.restoreAllMocks());
async function settle(id: string) {
  for (let i = 0; i < 100; i++) {
    const job = getJob(id);
    if (job && ['done', 'failed'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('任务未收尾');
}
it('模型判断已完成但收尾失败时，恢复体检不重复调用模型', async () => {
  service.createPage({ type: 'concept', title: '体检样本', content: '体检完成结果应当保留。' });
  const provider = new FakeProvider({ responses: ['{"findings":[]}'] });
  vi.spyOn(service, 'appendLog').mockImplementationOnce(() => { throw new Error('simulated process interruption'); });
  const { jobId } = startLintJob({ provider });
  expect((await settle(jobId)).status).toBe('failed');
  expect(provider.calls).toHaveLength(1);
  const resumed = new FakeProvider({ responses: [{ error: 'should never call' }] });
  startLintJob({ provider: resumed, resumeJobId: jobId });
  expect((await settle(jobId)).status).toBe('done');
  expect(resumed.calls).toHaveLength(0);
});
