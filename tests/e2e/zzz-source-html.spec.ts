import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { waitForVisualSettling } from './visual-settling';

test('原始 HTML：渲染交互、切换解析稿、全屏与下载', async ({ page, request }) => {
  const settings = await request.patch('/api/settings', { data: { providers: [{ id: 'source-html', label: 'HTML 测试服务', baseUrl: 'http://127.0.0.1:3301', model: 'audit-model', contextWindow: 32768 }], activeProviderId: 'source-html', preferSavedModels: true } });
  expect(settings.ok()).toBe(true);
  const filename = 'original-preview.html';
  const sourceHtml = '<!DOCTYPE html><html lang="zh-CN"><head><title>原始资料示例</title><style>body{background:#fcfbf9;color:#191714;font:16px/1.7 system-ui;padding:24px}button{background:white;color:#191714;border:1px solid #675b48;padding:12px}button:focus-visible{outline:2px solid #675b48}</style></head><body><h1>原件可以直接阅读</h1><p>推荐算法用于预测用户偏好。</p><button onclick="this.textContent=\'交互已生效\'">展开资料</button></body></html>';
  const created = await request.post('/api/ingest', { multipart: { file: { name: filename, mimeType: 'text/html', buffer: Buffer.from(sourceHtml) } } });
  expect(created.ok(), await created.text()).toBe(true);
  const jobId = (await created.json()).data.jobId;
  await expect.poll(async () => (await (await request.get(`/api/jobs/${jobId}`)).json()).data.status).toBe('awaiting_review');
  const sources = (await (await request.get('/api/sources')).json()).data.sources;
  const id = sources.find((source: { originalName: string }) => source.originalName === filename).id;
  await page.goto(`/sources/${id}`);
  const frame = page.frameLocator(`iframe[title="${filename} · 预览"]`);
  await expect(frame.getByRole('heading', { name: '原件可以直接阅读' })).toBeVisible();
  await frame.getByRole('button', { name: '展开资料' }).click();
  await expect(frame.getByRole('button', { name: '交互已生效' })).toBeVisible();
  await page.getByRole('button', { name: '全屏阅读', exact: true }).click();
  await expect(page.getByRole('dialog', { name: `全屏阅读 ${filename}` })).toBeVisible();
  await page.getByRole('button', { name: '退出全屏阅读', exact: true }).click();
  await expect(page.getByRole('button', { name: '全屏阅读', exact: true })).toBeFocused();
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载 HTML', exact: true }).click();
  expect((await downloading).suggestedFilename()).toBe(filename);
  await page.getByRole('button', { name: '解析稿', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByText('推荐算法用于预测用户偏好。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '原件', exact: true }).click();
  await expect(frame.getByRole('heading')).toBeVisible();
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light', reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(width === 390);
    await waitForVisualSettling(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(audit.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) }))).toEqual([]);
    await page.screenshot({ path: `test-results/source-html-${width}.png`, fullPage: true });
  }
});
