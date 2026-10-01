import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  const response = await request.patch('/api/settings', { data: {
    providers: [{ id: 'delivery-model', label: '本地验收模型', baseUrl: 'http://127.0.0.1:3301', model: 'audit-model', contextWindow: 32768 }],
    activeProviderId: 'delivery-model',
  } });
  expect(response.ok()).toBe(true);
});

test('导入 → 人工审阅保存 → 问答 → 归档 → 清空与恢复', async ({ page }) => {
  await page.goto('/wiki');
  const open = page.getByRole('button', { name: '导入资料', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: '导入资料' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await open.click();
  await dialog.getByRole('button', { name: '粘贴文字', exact: true }).click();
  await dialog.getByLabel('粘贴内容标题').fill('浏览器验收样本');
  await dialog.getByLabel('要导入的文字').fill('推荐算法用于预测用户偏好。\n\n协同过滤分为基于用户与基于物品两类。');
  await dialog.getByRole('button', { name: '加入队列', exact: true }).click();
  await dialog.getByRole('button', { name: '推荐算法 概念 预测用户偏好', exact: true }).click();
  await dialog.getByLabel('词条标题', { exact: true }).fill('人工修订后的推荐算法');
  await dialog.getByRole('button', { name: '编辑', exact: true }).click();
  await dialog.getByLabel('人工修订后的推荐算法的草稿正文').fill('人工补充事实：探索比例为27%。\n\n关联 [[协同过滤]]。');
  await page.reload();
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  await dialog.getByRole('button', { name: '人工修订后的推荐算法 概念 预测用户偏好', exact: true }).click();
  await expect(dialog.getByText('人工补充事实：探索比例为27%。', { exact: false })).toBeVisible();
  await dialog.getByLabel('词条标题', { exact: true }).fill('推荐算法');
  await dialog.getByRole('button', { name: /^审计样本 来源/ }).click();
  await dialog.getByLabel('来源摘要标题', { exact: true }).fill('推荐算法');
  await dialog.getByRole('button', { name: '确认写入', exact: true }).click();
  await expect(dialog.getByText(/请展开来源摘要并修改标题后再次确认写入/)).toBeVisible();
  await dialog.getByLabel('来源摘要标题', { exact: true }).fill('审计样本（来源）');
  await dialog.getByRole('button', { name: '确认写入', exact: true }).click();
  await expect(dialog.getByText('已写入知识库', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.goto('/chat');
  await page.getByLabel('向知识库提问').fill('推荐算法是什么？');
  await page.getByRole('button', { name: '开始提问', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\?s=/);
  const sessionUrl = page.url();
  await expect(page.getByRole('button', { name: '1 推荐算法', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '归档为新词条', exact: true }).click();
  await page.getByLabel('词条标题', { exact: true }).fill('交付验收问答');
  await page.getByRole('button', { name: '创建词条', exact: true }).click();
  await expect(page.getByText('已归档为词条', { exact: true })).toBeVisible();
  await page.goto(sessionUrl);
  await expect(page.getByText('已归档为词条', { exact: true })).toBeVisible();
  await page.goto('/settings');
  await page.getByRole('button', { name: '清空知识库', exact: true }).click();
  await page.getByLabel('输入清空以确认').fill('清空');
  await page.getByRole('button', { name: '确认清空并归档', exact: true }).click();
  await expect(page.getByText('知识库已清空', { exact: false })).toBeVisible();
  await page.goto('/trash');
  await page.getByRole('button', { name: '恢复整批', exact: true }).click();
  await expect(page.getByText('已恢复', { exact: true })).toBeVisible();
  await page.goto('/wiki');
  await expect(page.getByRole('button', { name: /推荐算法 概念/ })).toBeVisible();
  await expect(page.getByRole('link', { name: '版本', exact: true })).toHaveCount(0);
});

test('API boundary：拒绝外站请求与错误 JSON 类型', async ({ request }) => {
  const external = await request.post('/api/chat', { headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, data: '{"question":"x"}' });
  expect(external.status()).toBe(403);
  for (const body of [null, { question: 123 }, { question: ['x'] }]) {
    const response = await request.post('/api/chat', { headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(body) });
    expect(response.status()).toBe(400); expect((await response.json()).ok).toBe(false);
  }
});
