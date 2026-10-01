import { test, expect } from '@playwright/test';

test('替换模型服务后，旧会话恢复当前服务并可继续问答，新会话也可用', async ({ page, request }) => {
  const provider = (id: string, model: string) => ({ id, label: id, baseUrl: 'http://127.0.0.1:3301', model, reasoningEffort: 'default', contextWindow: 32768 });
  expect((await request.patch('/api/settings', { data: { providers: [provider('old-gateway', 'audit-model')], activeProviderId: 'old-gateway', preferSavedModels: true } })).ok()).toBe(true);
  const id = (await (await request.post('/api/chat/sessions', { data: { title: '服务替换回归' } })).json()).data.sessionId;
  expect((await request.patch(`/api/chat/sessions/${id}`, { data: { config: { providerId: 'old-gateway', model: 'audit-model', reasoningEffort: 'default', contextWindow: 32768, showMe: false } } })).ok()).toBe(true);
  expect((await request.patch('/api/settings', { data: { providers: [provider('replacement', 'audit-fast')], activeProviderId: 'replacement', preferSavedModels: true } })).ok()).toBe(true);
  if (!(await (await request.get('/api/pages')).json()).data.pages?.length) {
    const response = await request.post('/api/ingest', { multipart: { file: { name: 'model-recovery.md', mimeType: 'text/markdown', buffer: Buffer.from('推荐算法用于预测用户偏好。协同过滤分为基于用户与基于物品两类。') } } });
    const ingest = (await response.json()).data;
    const job = ingest.jobId ?? ingest.id;
    await expect.poll(async () => (await (await request.get(`/api/jobs/${job}`)).json()).data.status, { timeout: 20000 }).toBe('awaiting_review');
    const draft = (await (await request.get(`/api/jobs/${job}`)).json()).data.draft;
    expect((await request.post(`/api/ingest/${job}/commit`, { data: { draft: draft.draft } })).ok()).toBe(true);
  }
  await page.goto(`/chat?s=${id}`);
  await expect(page.getByRole('button', { name: '选择问答模型，当前 audit-fast' })).toBeVisible();
  await page.getByLabel('向知识库提问').fill('推荐算法');
  await page.getByRole('button', { name: '开始提问', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/api/chat/sessions/${id}`)).json()).data.activeRun).toBeNull();
  await expect.poll(async () => (await (await request.get(`/api/chat/sessions/${id}`)).json()).data.messages.at(-1)?.content).toContain('推荐算法');
  const restored = (await (await request.get(`/api/chat/sessions/${id}`)).json()).data.session.config;
  expect(restored).toMatchObject({ providerId: 'replacement', model: 'audit-fast' });
  await page.reload();
  await expect(page.getByRole('button', { name: '选择问答模型，当前 audit-fast' })).toBeVisible();
  await page.goto('/chat');
  await expect(page.getByRole('button', { name: '选择问答模型，当前 audit-fast' })).toBeVisible();
  await page.getByLabel('向知识库提问').fill('推荐算法');
  await page.getByRole('button', { name: '开始提问', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\?s=/);
  const newId = new URL(page.url()).searchParams.get('s')!;
  expect(newId).not.toBe(id);
  await expect.poll(async () => (await (await request.get(`/api/chat/sessions/${newId}`)).json()).data.messages.at(-1)?.content).toContain('推荐算法');
});
