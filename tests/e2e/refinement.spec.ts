import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { waitForVisualSettling } from './visual-settling';

const removedSettings = ['语言', '管理已连接的服务，选择默认模型。', '学习问答推荐 DeepSeek 官方 Flash（付费）。', '回答中使用的助手名称；留空会恢复为织识', '语气柔和，直接回答，不指责', '先给答案，再展开依据', '关键处偶尔用', '只说要点', '明确告知知识库中没有相关内容', '技术名词保持英文', '专注配色', '当目录、搜索结果与已保存内容不一致时，可以重新整理查找数据。', '清空当前知识内容时，会先归档为可恢复批次。'];

test('标注1–16：删去指定说明、语言与专注模式，保留设置能力', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('weave-theme-focus', '1'));
  await page.goto('/settings');
  await expect(page.getByLabel('对你的称谓', { exact: true })).toHaveAttribute('placeholder', '例如：老板');
  for (const text of removedSettings) await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  await expect(page.getByText(/^已准备 \d+ \/ \d+ 个词条$/)).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'focus');
  await expect(page.getByRole('button', { name: '深色', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '清空知识库', exact: true })).toBeVisible();
});

test('标注20、21、28–30：导航排序、品牌静态、最近对话滚动折叠与搜索', async ({ page }) => {
  await page.setViewportSize({ width: 796, height: 744 });
  const sessions = Array.from({ length: 40 }, (_, index) => ({ id: `ui-session-${index}`, title: `侧栏会话 ${String(index + 1).padStart(2, '0')}`, generating: false }));
  await page.route('**/api/chat/sessions*', async route => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get('q') ?? '';
    const matches = sessions.filter(item => item.title.includes(query));
    await route.fulfill({ json: { ok: true, data: { sessions: matches, total: matches.length } } });
  });
  await page.goto('/chat');
  const sidebar = page.locator('aside.sidebar-collapsible');
  await expect(sidebar.locator('nav > div > a')).toHaveText(['新对话', '知识库', '关系网络', '体检', '回收站', '设置']);
  await expect(sidebar.locator('.sidebar-brand')).not.toHaveAttribute('href');
  await expect(sidebar.locator('.sidebar-session')).toHaveCount(40);
  const list = sidebar.locator('#sidebar-recent-sessions');
  expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(sidebar.getByRole('link', { name: '侧栏会话 40', exact: true })).toBeInViewport();
  await sidebar.getByRole('button', { name: '收起最近对话', exact: true }).click();
  await expect(sidebar.locator('.sidebar-session')).toHaveCount(0);
  await sidebar.getByRole('button', { name: '展开最近对话', exact: true }).click();
  await expect(sidebar.locator('.sidebar-session')).toHaveCount(40);
  await expect(sidebar.getByRole('button', { name: '查看全部对话', exact: true })).toHaveCount(0);
  await sidebar.getByRole('button', { name: '搜索对话', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('40');
  await expect(dialog.getByRole('link')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await sidebar.getByRole('button', { name: '收起导航', exact: true }).click();
  await waitForVisualSettling(page);
  const centers = await sidebar.evaluate(element => {
    const toggle = element.querySelector('.sidebar-toggle svg')!.getBoundingClientRect();
    const nav = element.querySelector('nav .sidebar-item svg')!.getBoundingClientRect();
    return { toggle: toggle.x + toggle.width / 2, nav: nav.x + nav.width / 2 };
  });
  expect(Math.abs(centers.toggle - centers.nav)).toBeLessThan(1);
});

test('标注18：统一下拉支持搜索、键盘选择、空结果与焦点恢复', async ({ page }) => {
  await page.route('**/api/graph', route => route.fulfill({ json: { ok: true, data: {
    nodes: Array.from({ length: 40 }, (_, index) => ({ id: `node-${index}`, title: `搜索词条 ${index}`, type: 'concept', degree: 0, isolated: true })),
    links: [], stats: { pages: 40, links: 0, edges: 0, orphans: 40, dangling: 0 }, truncated: false,
  } } }));
  for (const width of [796, 320]) {
    await page.setViewportSize({ width, height: 744 });
    await page.goto('/wiki?view=graph');
    const picker = page.getByRole('combobox', { name: '选择词条查看关联' });
    await picker.click();
    const search = page.getByRole('combobox', { name: '搜索选项…', exact: true });
    await search.fill('不存在');
    await expect(page.getByText('没有匹配的选项', { exact: true })).toBeVisible();
    await search.fill('搜索词条 27');
    await expect(page.getByRole('option')).toHaveCount(1);
    await search.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(picker).toHaveAttribute('data-value', 'node-27');
    await expect(picker).toBeFocused();
    await picker.press('ArrowDown');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('标注19、22、26：思考按服务元数据列档并默认中档，输入仅一句提示', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { providers: [{ id: 'ui-tiers', label: '档位测试', baseUrl: 'http://127.0.0.1:3301', model: 'audit-model', reasoningEffort: 'default', contextWindow: 32768 }], activeProviderId: 'ui-tiers' } });
  await page.goto('/chat');
  await expect(page.getByLabel('向知识库提问')).toHaveAttribute('placeholder', '向知识库提问…');
  await expect(page.getByText('资料保存在本机，入库前可以检查 AI 生成的变更。', { exact: true })).toHaveCount(0);
  const effort = page.locator('[aria-controls="chat-effort-picker"]');
  await expect(effort).toContainText('思考 · 中');
  await effort.click();
  await expect(page.locator('#chat-effort-picker button')).toHaveText(['思考 · 低', '思考 · 中', '思考 · 高']);
  await page.keyboard.press('Escape');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('标注24、25、27、31：回答分区与状态统一，上下文保留真实用量', async ({ page }) => {
  const config = { providerId: 'ui-tiers', model: 'audit-model', reasoningEffort: 'medium', contextWindow: 32768, showMe: false };
  await page.route('**/api/chat/sessions/ui-visual', route => route.fulfill({ json: { ok: true, data: {
    session: { id: 'ui-visual', title: '界面验收', config }, context: { usedTokens: 1000, maxTokens: 32768, ratio: 1000 / 32768, measured: true, breakdown: { system: 300, summary: 0, history: 200, context: 490, question: 10 }, historyMessages: 4, summarizedMessages: 0, compressionCount: 0, droppedMessages: 0 },
    messages: [{ id: 'sample-user', role: 'user', content: '你好', createdAt: new Date().toISOString() }, { id: 'sample-answer', role: 'assistant', content: '这是用于检查视觉层级的回答。', citations: { list: [], quality: { isNoAnswer: false, hallucinationCount: 0 } }, createdAt: new Date().toISOString() }], activeRun: null,
  } } }));
  for (const width of [1366, 796, 390, 320]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 744 });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.goto('/chat?s=ui-visual');
      await expect(page.locator('.answer-surface').getByText('这是用于检查视觉层级的回答。', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /上下文占用.*点击展开明细/ }).click();
      await expect(page.getByText(/逐字保留/)).toHaveCount(0);
      await expect(page.locator('main').getByRole('button', { name: '新对话', exact: true })).toHaveCount(0);
      await expect(page.locator('.chat-context-panel')).toContainText('1,000 / 32,768 tokens');
      await expect(page.locator('.answer-meta')).toContainText('这次回答没有引用知识库内容');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.screenshot({ path: `test-results/refinement-chat-${width}-${colorScheme}.png` });
    }
  }
});
