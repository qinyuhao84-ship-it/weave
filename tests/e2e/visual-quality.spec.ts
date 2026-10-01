import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { waitForVisualSettling, waitForCanvasSettling } from './visual-settling';

// 只拦截读接口，不把长标题压力样本写进知识库。
const longTitle = '知识不是孤立的词条：在持续阅读中建立可以追溯的联系与判断'.repeat(3);
const sample = {
  ok: true,
  data: {
    pages: [{ id: 'visual-sample', title: longTitle, type: 'concept',
      summary: 'https://example.com/' + 'an-unbroken-source-reference-'.repeat(12),
      aliases: ['AnUnbrokenAlias'.repeat(12)], tags: [], sourceCount: 1, inboundLinks: 3 }],
    total: 1, offset: 0, limit: 50, counts: { concept: 1 },
    stats: { pages: 1, links: 3, edges: 3, orphans: 0, dangling: 0 }, pendingReview: 0,
  },
};

test('排版压力：长标题、连续链接、筛选与键盘跳转在各尺寸可用', async ({ browser }) => {
  for (const width of [320, 768, 1024, 1920]) {
    for (const theme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.route('**/api/pages?*', route => route.fulfill({ json: sample }));
      await page.goto('/wiki');
      const card = page.getByRole('button', { name: longTitle, exact: false });
      await expect(card).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: '跳到主要内容' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('main')).toBeFocused();
      const filter = page.getByRole('button', { name: '概念 1', exact: true });
      await filter.click();
      await expect(filter).toHaveAttribute('aria-pressed', 'true');
      await expect(card).toBeVisible();
      await waitForVisualSettling(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // 容器内的连续字符也必须换行，文档无溢出并不能证明卡片本身没有裁切。
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect((await card.boundingBox())!.height).toBeLessThan(320);
      if (width === 768) expect((await card.boundingBox())!.width).toBeGreaterThan(320);
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(audit.violations).toEqual([]);
      await page.screenshot({ path: `test-results/craft-wiki-${width}-${theme}.png`, fullPage: true });
      await context.close();
    }
  }
});

test('图谱可从键盘选择节点、查看关系并打开词条', async ({ page, request }) => {
  const graph = (await (await request.get('/api/graph')).json()).data;
  expect(graph.nodes.length).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/wiki?view=graph');
  const canvas = page.locator('main canvas').first();
  await expect(canvas).toBeVisible();
  await waitForCanvasSettling(page);
  // 读取画布中实际绘制出的类型色点，验证鼠标命中区与可见节点一致。
  const locateNode = () => canvas.evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const channels = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      if (pixels[offset + 3] > 150 && Math.max(...channels) - Math.min(...channels) > 50) {
        const index = offset / 4;
        return { x: (index % canvas.width) * canvas.clientWidth / canvas.width, y: Math.floor(index / canvas.width) * canvas.clientHeight / canvas.height };
      }
    }
    return null;
  });
  await expect.poll(locateNode).not.toBeNull();
  await canvas.click({ position: (await locateNode())! });
  await expect(page.getByText('影响范围', { exact: true })).toBeVisible();
  const picker = page.getByLabel('选择词条查看关联');
  await picker.focus();
  await expect(picker).toBeFocused();
  await picker.selectOption(graph.nodes[0].id);
  await expect(page.getByText('影响范围', { exact: true })).toBeVisible();
  await waitForVisualSettling(page);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByRole('link', { name: '打开词条', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/wiki/${graph.nodes[0].id}$`));
});

test('低高度窗口：输入与发送始终可见，减少动效仍有完整标识', async ({ browser }) => {
  for (const [width, height] of [[320, 568], [390, 400], [844, 390], [1366, 600]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('/chat');
    const input = page.getByLabel('向知识库提问');
    await expect(input).toBeVisible();
    await input.fill('用一个短问题验证输入与发送位置。');
    const send = page.getByRole('button', { name: '开始提问', exact: true });
    await expect(send).toBeEnabled();
    for (const control of [input, send]) {
      const rect = await control.boundingBox();
      expect(rect!.y).toBeGreaterThanOrEqual(0);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const animation = await page.locator('.weave-arrival path').first().evaluate(element => ({
      animation: getComputedStyle(element).animationName,
      offset: getComputedStyle(element).strokeDashoffset,
    }));
    expect(animation).toEqual({ animation: 'none', offset: '0px' });
    await page.screenshot({ path: `test-results/craft-chat-${width}-${height}.png`, fullPage: true });
    await context.close();
  }
});

test('图谱筛选：五种词条类型同时出现时，窄主区仍可操作', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/graph', route => route.fulfill({ json: {
    ok: true,
    data: {
      nodes: ['entity', 'concept', 'source', 'query', 'overview'].map((type, index) => ({ id: `node-${index}`, title: `压力样本 ${index}`, type, degree: 0, isolated: true })),
      links: [], stats: { pages: 5, links: 0, edges: 0, orphans: 5, dangling: 0 }, truncated: false,
    },
  } }));
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/wiki?view=graph');
    await expect(page.locator('main canvas').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '复位视图', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const picker = page.getByLabel('选择词条查看关联');
    await picker.selectOption('node-0');
    await expect(page.getByText('影响范围', { exact: true })).toBeVisible();
    await waitForCanvasSettling(page);
    await page.screenshot({ path: `test-results/craft-graph-${width}.png`, fullPage: true });
  }
});
