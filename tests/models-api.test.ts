import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/settings/models/route';
import { dropAllIndexTables } from '@/lib/db/client';
import { getSettings, saveSettings } from '@/lib/settings';
import { cachedModelCapability } from '@/lib/llm/models';
beforeEach(() => { dropAllIndexTables(); saveSettings({ providers: [{ id: 'fixture', label: 'Fixture', baseUrl: 'http://localhost/v1', apiKey: 'saved-fixture-secret', model: 'model-a', lightModel: '', supportsStrictSchema: false, reasoningEffort: 'default', temperature: 0.3, headers: {}, contextWindow: 32768 }], activeProviderId: 'fixture' }); });
afterEach(() => { vi.unstubAllGlobals(); });
const request = (body: unknown) => new Request('http://localhost/api/settings/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
it('配置前读取模型，沿用隐藏密钥，返回去重列表且不保存草稿', async () => {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe('http://localhost/new/models'); expect(init.headers).toMatchObject({ Authorization: 'Bearer saved-fixture-secret' });
    return Response.json({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, { id: 123 }] });
  });
  const response = await POST(request({ provider: { id: 'fixture', baseUrl: 'http://localhost/new', apiKey: '' } }));
  expect((await response.json()).data).toMatchObject({ models: ['a', 'b'], supported: true });
  expect(getSettings().providers[0].baseUrl).toBe('http://localhost/v1');
});
it('无模型列表端点时允许手动配置', async () => {
  vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
  expect((await (await POST(request({ providerId: 'fixture' }))).json()).data).toEqual({ models: [], supported: false });
});
it('模型能力信息按服务端返回映射并缓存，忽略无效容量和档位', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'model-a', context_length: 16384, reasoning_efforts: ['low', 'high', 'not-an-effort'] }, { id: 'bad', context_window: -1 }] }));
  const data = (await (await POST(request({ providerId: 'fixture' }))).json()).data;
  expect(data.details).toEqual([{ id: 'model-a', contextWindow: 16384, reasoningEfforts: ['low', 'high'] }, { id: 'bad' }]);
  expect(cachedModelCapability('http://localhost/v1', 'model-a')?.reasoningEfforts).toEqual(['low', 'high']);
  expect(JSON.stringify(data)).not.toContain('saved-fixture-secret');
});
it('鉴权错误不回传上游正文与凭据', async () => {
  vi.stubGlobal('fetch', async () => new Response('upstream-sensitive-body', { status: 401 }));
  const response = await POST(request({ providerId: 'fixture' }));
  const text = await response.text();
  expect(response.status).toBe(502); expect(text).toContain('凭据被拒绝'); expect(text).not.toContain('upstream-sensitive-body'); expect(text).not.toContain('saved-fixture-secret');
});
it('识别 DeepSeek 官方 effort 对象与上下文元数据', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'deepseek-flash', context_window: 1048576, effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }] }));
  const data = (await (await POST(request({ providerId: 'fixture' }))).json()).data;
  expect(data.details).toEqual([{ id: 'deepseek-flash', contextWindow: 1048576, reasoningEfforts: ['low', 'high', 'max'] }]);
});
it('DeepSeek 官方 supported_levels 未列 none 时保留关闭思考，显式空列表仍优先', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'deepseek-flash', effort: { supported_levels: ['low', 'high', 'max'] } }, { id: 'explicit', reasoning_efforts: [], effort: { supported_levels: ['low'] } }] }));
  const data = (await (await POST(request({ provider: { id: 'new', baseUrl: 'https://api.deepseek.com/v1' } }))).json()).data;
  expect(data.details[0].reasoningEfforts).toEqual(['none', 'low', 'high', 'max']);
  expect(data.details[1].reasoningEfforts).toEqual([]);
});
it('非法地址、请求头与缺失服务明确拒绝', async () => {
  expect((await POST(request({ provider: { id: 'x', baseUrl: 'file:///tmp/test' } }))).status).toBe(400);
  expect((await POST(request({ providerId: 'missing' }))).status).toBe(400);
});
it('连接测试调用所选模型的生成接口，沿用隐藏密钥且不保存配置', async () => {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe('http://localhost/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer saved-fixture-secret' });
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('model-a'); expect(body.messages).toEqual([{ role: 'user', content: 'Reply OK.' }]);
    return Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
  });
  const response = await POST(request({ providerId: 'fixture', test: true }));
  expect(response.status).toBe(200);
  expect((await response.json()).data).toMatchObject({ connected: true, model: 'model-a' });
  expect(getSettings().providers[0].model).toBe('model-a');
});
it('推理模型耗尽短测试预算但已返回正文时仍判定连接可用', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ choices: [{ message: { content: 'OK', reasoning_content: 'Thinking' }, finish_reason: 'length' }] }));
  const response = await POST(request({ providerId: 'fixture', test: true }));
  expect(response.status).toBe(200);
  expect((await response.json()).data).toMatchObject({ connected: true, model: 'model-a' });
});
it('连接测试使用保存/草稿的温度与思考档位，草稿不写回', async () => {
  const saved = getSettings().providers[0];
  saveSettings({ providers: [{ ...saved, model: 'deepseek-flash', reasoningEffort: 'low', temperature: 0.7 }] });
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
  });
  expect((await POST(request({ providerId: 'fixture', test: true }))).status).toBe(200);
  expect((await POST(request({ provider: { id: 'fixture', baseUrl: saved.baseUrl, model: 'deepseek-flash', reasoningEffort: 'high', temperature: 0.9 }, test: true }))).status).toBe(200);
  expect(bodies[0]).toMatchObject({ reasoning_effort: 'low', temperature: 0.7 });
  expect(bodies[1]).toMatchObject({ reasoning_effort: 'high', temperature: 0.9 });
  expect(getSettings().providers[0].reasoningEffort).toBe('low');
});
