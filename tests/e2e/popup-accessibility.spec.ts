import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('搜索浮层逐字输入保持焦点，展开时符合无障碍结构', async ({ page }) => {
  await page.route('**/api/graph', route => route.fulfill({ json: { ok: true, data: {
    nodes: Array.from({ length: 20 }, (_, index) => ({ id: `node-${index}`, title: `搜索词条 ${index}`, type: 'concept', degree: 0, isolated: true })), links: [], stats: { pages: 20, links: 0, edges: 0, orphans: 20, dangling: 0 }, truncated: false,
  } } }));
  await page.goto('/wiki?view=graph');
  await page.getByRole('combobox', { name: '选择词条查看关联' }).click();
  const search = page.getByRole('combobox', { name: '搜索选项…', exact: true });
  await search.pressSequentially('词条 12', { delay: 40 });
  await expect(search).toHaveValue('词条 12');
  await expect(search).toBeFocused();
  await expect(page.getByRole('option')).toHaveCount(1);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});
