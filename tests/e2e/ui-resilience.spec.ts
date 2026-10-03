import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const [routePath, endpoint] of [
  ['/wiki', '**/api/pages?*'],
  ['/sources', '**/api/sources?*'],
  ['/trash', '**/api/vault/trash'],
  ['/settings', '**/api/settings'],
  ['/wiki?view=graph', '**/api/graph'],
]) {
  test(`${routePath} 首次读取失败可原位恢复，失败状态可被读屏识别`, async ({ page }) => {
    if (routePath === '/wiki') {
      await page.setViewportSize({ width: 320, height: 844 });
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    }
    let attempts = 0;
    await page.route(endpoint, async route => {
      if (++attempts === 1) await route.fulfill({ status: 503, json: { ok: false, error: '模拟首次读取中断' } });
      else await route.continue();
    });
    await page.goto(routePath);
    const alert = page.locator('main').getByRole('alert').filter({ hasText: '模拟首次读取中断' });
    await expect(alert).toBeVisible();
    if (routePath === '/wiki') {
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.screenshot({ path: 'test-results/resilience-error-320-dark.png', fullPage: true });
    }
    await page.locator('main').getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(alert).toHaveCount(0);
    expect(attempts).toBeGreaterThanOrEqual(2);
    await expect(page.locator('main').getByRole('heading', { level: 1 })).toBeVisible();
  });
}

test('知识库状态未知不能显示正常，重新检查可恢复真实统计', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/vault', route => route.fulfill(++attempts === 1
    ? { status: 503, json: { ok: false, error: '模拟知识库状态中断' } }
    : { json: { ok: true, data: { stats: { pages: 17, links: 3 }, indexHealthy: true } } }));
  await page.goto('/wiki');
  const status = page.locator('aside .vault-status');
  await expect(status).toContainText('知识库状态未确认');
  await expect(status).not.toContainText('知识库正常');
  await expect(status.locator('.sidebar-label').last()).not.toHaveText('0');
  await status.getByRole('button', { name: '重新检查知识库状态' }).click();
  await expect(status).toContainText('知识库正常');
  await expect(status).toContainText('17');
});

test('图谱已有数据时刷新失败仍明确告知，保留图谱并可重新加载', async ({ page }) => {
  let release!: () => void;
  const changes = new Promise<void>(resolve => { release = resolve; });
  let changed = false;
  await page.route('**/api/vault/changes', async route => {
    await changes;
    await route.fulfill({ contentType: 'text/event-stream', body: changed ? ': keepalive\n\n' : 'data: {"type":"change"}\n\n' });
    changed = true;
  });
  let attempts = 0;
  const graph = { nodes: [{ id: 'recovery-node', title: '保留的关系节点', type: 'concept', degree: 0, isolated: true }], links: [], stats: { pages: 1, links: 0, edges: 0, orphans: 1, dangling: 0 }, truncated: false };
  await page.route('**/api/graph', route => route.fulfill(++attempts === 2
    ? { status: 503, json: { ok: false, error: '模拟图谱更新中断' } }
    : { json: { ok: true, data: graph } }));
  try {
    await page.goto('/wiki?view=graph');
    await expect(page.locator('main canvas').first()).toBeVisible();
    release();
    await expect(page.getByRole('alert').filter({ hasText: '模拟图谱更新中断' })).toBeVisible();
    await expect(page.locator('main canvas').first()).toBeVisible();
    await page.locator('main').getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '模拟图谱更新中断' })).toHaveCount(0);
    expect(attempts).toBeGreaterThanOrEqual(3);
  } finally { release(); }
});

test('原始资料解析失败显示恢复动作，成功重试后展示正确正文', async ({ page }) => {
  const sourceId = 'ui-recovery-source';
  await page.route(`**/api/sources/${sourceId}`, route => route.fulfill({ json: { ok: true, data: { id: sourceId, originalName: '恢复验收资料.md', title: '恢复验收资料', byteSize: 128, pageCount: null, status: 'ready', importedAt: '2026-10-03T00:00:00Z' } } }));
  let attempts = 0;
  await page.route(`**/api/sources/${sourceId}/parsed`, route => route.fulfill(++attempts === 1
    ? { status: 503, json: { error: '模拟原文读取中断' } }
    : { contentType: 'text/plain', body: '# 正确来源正文\n\n恢复后原文与当前资料一致。' }));
  await page.goto(`/sources/${sourceId}`);
  await expect(page.getByRole('alert').filter({ hasText: '模拟原文读取中断' })).toBeVisible();
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByRole('heading', { name: '正确来源正文' })).toBeVisible();
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const download = page.getByRole('link', { name: '下载原件', exact: true });
  await expect(download).toBeVisible();
  expect((await download.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test('切换词条搜索路径时清除旧请求错误并显示加载状态', async ({ page }) => {
  let releaseSearch!: () => void;
  let startSearch!: () => void;
  const searchStarted = new Promise<void>(resolve => { startSearch = resolve; });
  const searchGate = new Promise<void>(resolve => { releaseSearch = resolve; });
  await page.route('**/api/pages?*', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query) {
      startSearch();
      await searchGate;
      await route.fulfill({ json: { ok: true, data: { pages: [], total: 0, offset: 0, limit: 50, counts: {}, stats: { pages: 0, links: 0, edges: 0, orphans: 0, dangling: 0 }, pendingReview: 0 } } });
      return;
    }
    await route.fulfill({ status: 503, json: { ok: false, error: '模拟初始词条列表中断' } });
  });
  await page.route('**/api/search?*', route => route.fulfill({ json: { ok: true, data: { results: [] } } }));
  await page.goto('/wiki');
  const main = page.locator('main');
  const oldError = main.getByRole('alert').filter({ hasText: '模拟初始词条列表中断' });
  await expect(oldError).toBeVisible();
  await page.getByRole('textbox', { name: '搜索知识库' }).fill('切换后的词条');
  await searchStarted;
  await expect(oldError).toHaveCount(0);
  await expect(main.getByRole('status').filter({ hasText: '正在加载…' })).toBeVisible();
  releaseSearch();
  await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
});

test('中文候选确认与 Shift Enter 不发送，普通 Enter 发送失败保留问题', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { providers: [{ id: 'ui-ime', label: '输入法验收', baseUrl: 'http://127.0.0.1:3301', model: 'audit-model', contextWindow: 32768 }], activeProviderId: 'ui-ime' } });
  let sends = 0;
  await page.route('**/api/chat', route => { sends++; return route.fulfill({ status: 503, json: { ok: false, error: '模拟发送中断' } }); });
  await page.goto('/chat');
  const input = page.getByLabel('向知识库提问');
  await input.fill('中文候选确认不应发送');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: false });
  await expect(input).toHaveValue('中文候选确认不应发送');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: true });
  await input.press('Shift+Enter');
  expect(sends).toBe(0);
  await input.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: '模拟发送中断' })).toBeVisible();
  await expect(input).toHaveValue('中文候选确认不应发送');
  expect(sends).toBe(1);
});

test('窄屏正文搜索长标题不溢出，模型开关保持 44px 点击区域', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  let release!: () => void;
  const pagesReady = new Promise<void>(resolve => { release = resolve; });
  const title = 'AnUnbrokenReferenceTitle'.repeat(18);
  await page.route('**/api/pages?*', async route => {
    await pagesReady;
    await route.fulfill({ json: { ok: true, data: { pages: [], total: 0, offset: 0, limit: 50, counts: {}, stats: { pages: 1, links: 0, edges: 0, orphans: 1, dangling: 0 }, pendingReview: 0 } } });
  });
  await page.route('**/api/search?*', route => route.fulfill({ json: { ok: true, data: { results: [{ pageId: 'long-search', title, type: 'concept', score: 1, snippet: '长标题引用 https://example.com/' + 'long-unbroken-reference-'.repeat(15) }] } } }));
  await page.goto('/wiki');
  try {
    await expect(page.locator('main').getByRole('status').filter({ hasText: '正在加载…' })).toBeVisible();
    await page.screenshot({ path: 'test-results/resilience-loading-320.png', fullPage: true });
  } finally { release(); }
  await page.getByRole('textbox', { name: '搜索知识库' }).fill('长标题');
  const result = page.getByRole('button', { name: title, exact: false });
  await expect(result).toBeVisible();
  await expect(page.getByText('没有匹配「长标题」的词条。', { exact: true })).toHaveCount(0);
  expect(await result.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'test-results/resilience-search-320.png', fullPage: true });
  await request.patch('/api/settings', { data: { providers: [], activeProviderId: '' } });
  await page.goto('/settings');
  await page.getByRole('button', { name: '添加模型服务', exact: true }).click();
  await page.getByText('高级设置', { exact: true }).click();
  const control = page.getByRole('switch', { name: '严格 JSON Schema', exact: true });
  await expect(control).toBeVisible();
  const bounds = (await control.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: 'test-results/resilience-switch-320.png', fullPage: true });
});
