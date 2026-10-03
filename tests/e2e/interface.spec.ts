import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import { waitForVisualSettling, waitForCanvasSettling } from './visual-settling';

test('主要界面：桌面与窄屏、亮色与深色、键盘和溢出检查', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const findings: unknown[] = [];
  await request.patch('/api/settings', { data: { providers: [{ id: 'audit-ui', label: '界面验收服务', baseUrl: 'http://127.0.0.1:3301', model: 'audit-model', contextWindow: 32768 }], activeProviderId: 'audit-ui' } });
  const pages = (await (await request.get('/api/pages')).json()).data;
  const records = Array.isArray(pages) ? pages : pages.pages ?? [];
  const detail = records[0]?.id;
  for (const width of [1366, 390]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme as 'light' | 'dark', reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const routes = ['/chat', '/wiki', '/wiki?view=graph', '/sources', '/trash', '/review', '/settings', ...(detail ? [`/wiki/${detail}`] : [])];
      for (const [index, route] of routes.entries()) {
        const endpoint = route === '/chat' || route === '/settings' ? '/api/settings' : route === '/wiki' ? '/api/pages' : route.includes('view=graph') ? '/api/graph' : route === '/sources' ? '/api/sources' : route === '/trash' ? '/api/vault/trash' : route === '/review' ? '/api/lint' : `/api/pages/${detail}`;
        await Promise.all([page.waitForResponse(response => response.url().includes(endpoint) && response.status() === 200), page.goto(route)]);
        await expect(page.locator('main')).toBeVisible();
        if (route === '/settings') await expect(page.getByRole('button', { name: '添加模型服务', exact: true })).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        if (route.includes('view=graph') && detail) {
          await expect(page.locator('main canvas').first()).toBeVisible();
          await expect.poll(() => page.locator('main canvas').first().evaluate((canvas: HTMLCanvasElement) => {
            const context = canvas.getContext('2d');
            return context && context.getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
          })).toBe(true);
          await waitForCanvasSettling(page);
        }
        await waitForVisualSettling(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} at ${width}/${theme}`).toBe(true);
        if ((width === 1366 && theme === 'light') || (width === 390 && theme === 'dark')) {
          const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
          if (audit.violations.length) findings.push({ route, width, theme, violations: audit.violations.map(v => ({ id: v.id, impact: v.impact, description: v.description, nodes: v.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })) });
        }
        fs.writeFileSync('test-results/ui-accessibility.json', JSON.stringify(findings, null, 2));
        await page.screenshot({ path: `test-results/ui-${width}-${theme}-${index}.png`, fullPage: true });
      }
      if (width === 1366) {
        await page.goto('/chat');
        const sidebar = page.locator('aside.sidebar-collapsible');
        const sessionCount = (await (await request.get('/api/chat/sessions')).json()).data.sessions.length;
        await expect(sidebar.locator('nav a[href^="/chat?s="]')).toHaveCount(sessionCount);
        const coordinates = () => page.evaluate(() => Array.from(document.querySelectorAll('.sidebar-collapsible nav .sidebar-item')).map(item => {
          const rect = item.querySelector('svg')!.getBoundingClientRect();
          return { x: rect.x, y: rect.y };
        }));
        const before = await coordinates();
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect(sidebar).toHaveCSS('transition-duration', '0.22s');
        const toggle = page.getByRole('button', { name: '收起导航', exact: true });
        const toggleBefore = await toggle.boundingBox();
        const brand = await sidebar.locator('.sidebar-brand').boundingBox();
        expect(brand && toggleBefore && brand.x + brand.width <= toggleBefore.x).toBeTruthy();
        await toggle.click();
        await expect(sidebar).toHaveCSS('width', '60px');
        await waitForVisualSettling(page);
        const after = await coordinates();
        expect(after).toHaveLength(before.length);
        after.slice(0, 6).forEach((point, index) => {
          expect(Math.abs(point.x - before[index].x)).toBeLessThan(1);
          expect(Math.abs(point.y - before[index].y)).toBeLessThan(1);
        });
        const expand = page.getByRole('button', { name: '展开导航', exact: true });
        const toggleAfter = await expand.boundingBox();
        expect(toggleBefore && toggleAfter).toBeTruthy();
        const icon = await sidebar.locator('nav .sidebar-item svg').first().boundingBox();
        expect(Math.abs(toggleAfter!.x + toggleAfter!.width / 2 - icon!.x - icon!.width / 2)).toBeLessThan(1);
        expect(toggleAfter?.y).toBe(toggleBefore?.y);
        await page.screenshot({ path: `test-results/sidebar-collapsed-${theme}.png`, fullPage: true });
        await page.reload();
        await expect(sidebar).toHaveCSS('width', '60px');
        const switcher = sidebar.getByRole('button', { name: /^(展开导航|收起导航)$/ });
        await switcher.click();
        await switcher.click();
        await switcher.click();
        await expect(sidebar).toHaveCSS('width', '232px');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(sidebar).toHaveCSS('transition-duration', '0s');
      }
      await page.goto('/settings');
      await page.getByRole('button', { name: '添加模型服务', exact: true }).click();
      await expect(page.getByLabel('API Key', { exact: true })).toBeFocused();
      await page.getByText('高级设置', { exact: true }).click();
      await waitForVisualSettling(page);
      if ((width === 1366 && theme === 'light') || (width === 390 && theme === 'dark')) {
        const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        if (audit.violations.length) findings.push({ route: 'model-form', width, theme, violations: audit.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })) });
      }
      await page.screenshot({ path: `test-results/ui-${width}-${theme}-model-form.png`, fullPage: true });
      expect(errors).toEqual([]);
      await context.close();
    }
  }
  fs.writeFileSync('test-results/ui-accessibility.json', JSON.stringify(findings, null, 2));
  expect(findings).toEqual([]);
});
