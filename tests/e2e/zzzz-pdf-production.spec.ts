import fs from 'node:fs';
import { test, expect } from '@playwright/test';

test('生产构建的导入接口使用内置解析器读取中文 PDF 正文', async ({ request }) => {
  const settings = await request.patch('/api/settings', { data: {
    providers: [{ id: 'pdf-production', label: '本地 PDF 验收', baseUrl: 'http://127.0.0.1:3301', model: 'audit-model', contextWindow: 32768 }],
    activeProviderId: 'pdf-production',
  } });
  expect(settings.ok()).toBe(true);
  const uploaded = await request.post('/api/ingest', { multipart: {
    file: { name: 'production-cjk.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync('tests/fixtures/sample.pdf') },
  } });
  expect(uploaded.ok()).toBe(true);
  const { jobId } = (await uploaded.json()).data;
  try {
    await expect.poll(async () => {
      const response = await request.get(`/api/jobs/${jobId}`);
      expect(response.ok()).toBe(true);
      const { status } = (await response.json()).data;
      return ['awaiting_review', 'failed', 'cancelled'].includes(status);
    }, { timeout: 30_000 }).toBe(true);
    const job = (await (await request.get(`/api/jobs/${jobId}`)).json()).data;
    expect(job.status, job.error ?? 'PDF 导入应生成审阅草稿').toBe('awaiting_review');
    expect(job.draft.source.parser).toBe('unpdf');
    expect(job.draft.markdown).toContain('卢曼的卡片盒笔记法');
    expect(job.draft.markdown).toContain('知识管理方法论');
    expect(job.draft.markdown).toContain('LLM Wiki');
  } finally {
    await request.delete(`/api/jobs/${jobId}`);
  }
});
