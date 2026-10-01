import { test, expect } from '@playwright/test';

test('正文搜索失败可重试，失败不会被描述成无匹配', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/search?**', route => {
    attempts++;
    return route.fulfill({ status: attempts === 1 ? 503 : 200, contentType: 'application/json', body: JSON.stringify(attempts === 1 ? { ok: false, error: '测试连接中断' } : { ok: true, data: { results: [{ pageId: 'recovery', title: '恢复后的结果', type: 'concept', score: 1, snippet: '已恢复正文搜索' }] } }) });
  });
  await page.goto('/wiki');
  await page.getByRole('textbox', { name: '搜索知识库' }).fill('恢复测试');
  const searchAlert = page.getByRole('alert').filter({ hasText: '正文搜索失败' });
  await expect(searchAlert).toContainText('测试连接中断');
  await expect(page.getByText('正文里没有匹配内容', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: '重试搜索' }).click();
  await expect(page.getByText('恢复后的结果', { exact: true })).toBeVisible();
  await expect(searchAlert).toHaveCount(0);
  expect(attempts).toBe(2);
});

test('快速改搜索词会取消旧搜索，旧结果不出现', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let oldStarted = false;
  let oldCancelled = false;
  page.on('requestfailed', request => { if (request.url().includes('/api/search?q=old')) oldCancelled = true; });
  await page.route('**/api/search?**', async route => {
    const old = route.request().url().includes('q=old');
    if (old) { oldStarted = true; await held; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { results: [{ pageId: old ? 'old' : 'new', title: old ? '过期搜索结果' : '最新搜索结果', type: 'concept', score: 1, snippet: '匹配内容' }] } }) }).catch(() => {});
  });
  try {
    await page.goto('/wiki');
    const input = page.getByRole('textbox', { name: '搜索知识库' });
    await input.fill('old');
    await expect.poll(() => oldStarted).toBe(true);
    await input.fill('new');
    await expect(page.getByText('最新搜索结果', { exact: true })).toBeVisible();
    release();
    await expect.poll(() => oldCancelled).toBe(true);
    await expect(page.getByText('过期搜索结果', { exact: true })).toHaveCount(0);
  } finally { release(); }
});

test('聊天先探测当前服务，展开模型选择器再探测其他服务', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { providers: [
    { id: 'perf-current', label: '当前服务', baseUrl: 'http://127.0.0.1:3301', model: 'audit-model', contextWindow: 32768 },
    { id: 'perf-other', label: '备用服务', baseUrl: 'http://127.0.0.1:3301', model: 'audit-model', contextWindow: 32768 },
  ], activeProviderId: 'perf-current' } });
  const requested: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/settings/models')) requested.push(request.postDataJSON().providerId); });
  await page.goto('/chat');
  await expect.poll(() => requested).toEqual(['perf-current']);
  await page.getByRole('button', { name: '选择问答模型，当前 audit-model' }).click();
  await expect(page.getByRole('group', { name: '问答模型', exact: true })).toBeVisible();
  await expect.poll(() => requested).toEqual(['perf-current', 'perf-other']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '选择问答模型，当前 audit-model' }).click();
  expect(requested).toEqual(['perf-current', 'perf-other']);
});
