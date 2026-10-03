import { selectChoice } from './select-choice';
import { test, expect } from '@playwright/test';

test('新用户：无配置启动 → 本地模型 → 凭据编辑 → 切换与删除', async ({ page, request }) => {
  const reset = await request.patch('/api/settings', { data: { providers: [], activeProviderId: '' } });
  expect(reset.ok()).toBe(true);
  await page.goto('/chat');
  await expect(page.getByText('先配置你的模型', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '去配置模型' }).click();
  await page.getByRole('button', { name: '添加模型服务', exact: true }).click();
  await selectChoice(page, page.getByLabel('服务商', { exact: true }), 'openaiCompatible');
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByLabel('服务名称', { exact: true }).fill('我的本地服务');
  await page.getByLabel('API 地址', { exact: true }).fill('http://127.0.0.1:3301');
  await page.getByLabel('模型名', { exact: true }).fill('audit-model');
  
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
  await expect(page.getByText('模型配置已保存。新任务会使用当前模型，无需重启。', { exact: true })).toBeVisible();
  expect((await (await request.get('/api/settings')).json()).data.model.configured).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '编辑 我的本地服务', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await page.getByLabel('API Key', { exact: true }).fill('e2e-fixture-secret');
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
  await expect(page.getByText('模型配置已保存。新任务会使用当前模型，无需重启。', { exact: true })).toBeVisible();
  const configured = await (await request.get('/api/settings')).json();
  expect(configured.data.settings.providers[0].hasApiKey).toBe(true);
  expect(JSON.stringify(configured)).not.toContain('e2e-fixture-secret');
  await page.getByRole('button', { name: '编辑 我的本地服务', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByLabel('服务名称', { exact: true }).fill('修改后的服务');
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑 修改后的服务', exact: true })).toBeVisible();
  expect((await (await request.get('/api/settings')).json()).data.settings.providers[0].hasApiKey).toBe(true);
  await page.getByRole('button', { name: '编辑 修改后的服务', exact: true }).click();
  await page.getByRole('button', { name: '清除已保存密钥', exact: true }).click();
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑 修改后的服务', exact: true })).toBeVisible();
  expect((await (await request.get('/api/settings')).json()).data.settings.providers[0].hasApiKey).toBe(false);
  await page.getByRole('button', { name: '添加模型服务', exact: true }).click();
  await selectChoice(page, page.getByLabel('服务商', { exact: true }), 'openaiCompatible');
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByLabel('服务名称', { exact: true }).fill('第二个服务');
  await page.getByLabel('API 地址', { exact: true }).fill('http://127.0.0.1:3301');
  await page.getByLabel('模型名', { exact: true }).fill('audit-model');
  
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑 第二个服务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '使用', exact: true }).click();
  await expect(page.getByText('已切换模型。新任务会使用所选服务。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑 第二个服务', exact: true }).click();
  await page.getByRole('button', { name: '删除此服务', exact: true }).click();
  await page.getByRole('button', { name: '确认删除服务', exact: true }).click();
  await expect(page.getByText('模型服务已删除。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑 第二个服务', exact: true })).toBeHidden();
});

test('窄屏设置与模型表单不出现横向溢出', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { providers: [], activeProviderId: '' } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings');
  await page.getByRole('button', { name: '添加模型服务', exact: true }).click();
  await page.getByText('高级设置', { exact: true }).click();
  await expect(page.getByLabel('附加请求头（JSON）', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/settings-mobile.png', fullPage: true });
});

test('供应商模板、模型列表与精简设置入口', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { providers: [], activeProviderId: '' } });
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: '清空知识库', exact: true })).toBeVisible();
  await expect(page.getByText('如何获取 API Key？查看逐步教程与费用说明', { exact: true })).toBeVisible();
  await page.getByText('如何获取 API Key？查看逐步教程与费用说明', { exact: true }).click();
  await expect(page.getByRole('link', { name: '打开 API keys 页面', exact: true })).toHaveAttribute('href', 'https://platform.deepseek.com/api_keys');
  await expect(page.getByText('示例回答约 0.02–0.04 元；按实际用量扣费。', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: '添加模型服务', exact: true }).click();
  await expect(page.getByLabel('服务商', { exact: true })).toHaveAttribute('data-value', 'deepseek');
  await expect(page.getByLabel('模型名', { exact: true })).toHaveValue('deepseek-flash');
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('placeholder', '粘贴刚复制的 DeepSeek API Key');
  await expect(page.getByLabel('上下文窗口（token）', { exact: true })).toBeHidden();
  const select = page.getByLabel('服务商', { exact: true });
  await select.click();
  await expect(page.getByRole('option')).toHaveCount(7);
  await page.locator('[role=option][data-value="ollama"]').click();
  
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByLabel('高级 API 地址', { exact: true }).fill('http://127.0.0.1:3301');
  await page.getByRole('button', { name: '读取可用模型', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '模型名', exact: true })).toBeVisible();
  await selectChoice(page, page.getByLabel('模型名', { exact: true }), 'audit-model');
  await expect(page.getByRole('combobox', { name: '模型名', exact: true })).toHaveAttribute('data-value', 'audit-model');
  
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
  await page.getByRole('button', { name: '编辑 Ollama（本地）', exact: true }).click();
  await expect(page.getByRole('button', { name: '测试连接', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '连接通过' })).toBeVisible();
  await expect(page.getByText('会话回收站', { exact: true })).toHaveCount(0);
  await expect(page.getByText('旧段落格式修复', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '使用准备', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '版本', exact: true })).toHaveCount(0);
  expect((await request.get('/api/git')).status()).toBe(404);
  await page.goto('/trash');
  await expect(page.getByRole('heading', { name: '回收站', exact: true })).toBeVisible();
});
