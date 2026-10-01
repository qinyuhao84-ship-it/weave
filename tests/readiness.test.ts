import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dropAllIndexTables } from '@/lib/db/client';
import { saveSettings } from '@/lib/settings';
import { checkReadiness } from '@/lib/readiness';
import { resetDoclingCache } from '@/lib/ingest/parse/docling';

beforeEach(() => {
  dropAllIndexTables(); resetDoclingCache();
  saveSettings({ providers: [{ id: 'local', label: '本地测试', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture-model', apiKey: '', lightModel: '', contextWindow: 32768, temperature: 0.3, reasoningEffort: 'high', headers: {}, supportsStrictSchema: false }], activeProviderId: 'local' });
});
afterEach(() => { vi.unstubAllGlobals(); resetDoclingCache(); });

it.each([[401, 'error'], [404, 'warning'], [200, 'ok']] as const)('模型检查 HTTP %i 明确反馈且不调用生成接口', async (status, expected) => {
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/health')) return new Response('', { status: 503 });
    expect(String(url)).toBe('http://127.0.0.1:11434/v1/models');
    expect(init?.headers).not.toHaveProperty('Authorization');
    return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }], message: 'upstream-fixture-secret' }), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  const checks = await checkReadiness(true);
  expect(checks.find(check => check.name === '模型服务')?.status).toBe(expected);
  expect(checks.find(check => check.name === '文档解析')?.status).toBe('warning');
  expect(JSON.stringify(checks)).not.toContain('upstream-fixture-secret');
  expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('chat/completions'))).toBe(true);
});
it('模型连接超时提供恢复指引，解析服务不可用不影响其他检查', async () => {
  vi.stubGlobal('fetch', async () => { throw new DOMException('timed out', 'TimeoutError'); });
  const checks = await checkReadiness(true);
  const model = checks.find(check => check.name === '模型服务');
  expect(model?.status).toBe('error'); expect(model?.detail).toContain('地址');
  expect(checks.find(check => check.name === '知识库权限')?.status).toBe('ok');
});

it('Claude 可用性检查复用原生模型列表鉴权，不回显凭据', async () => {
  saveSettings({ providers: [{ id: 'claude', label: '测试', baseUrl: 'https://api.anthropic.com/v1', model: 'fixture-model', apiKey: 'fixture-api-key', lightModel: '', contextWindow: 32768, temperature: 0.3, reasoningEffort: 'default', headers: {}, supportsStrictSchema: false }], activeProviderId: 'claude' });
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/health')) return new Response('', { status: 503 });
    expect(String(url)).toBe('https://api.anthropic.com/v1/models');
    expect(init?.headers).toMatchObject({ 'x-api-key': 'fixture-api-key', 'anthropic-version': '2023-06-01' });
    expect(init?.headers).not.toHaveProperty('Authorization');
    return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
  });
  const checks = await checkReadiness(true);
  expect(checks.find(check => check.name === '模型服务')?.status).toBe('ok');
  expect(JSON.stringify(checks)).not.toContain('fixture-api-key');
});

it.each([{ data: [] }, { invalid: true }])('模型未确认或列表形状不支持时返回警告：%j', async body => {
  vi.stubGlobal('fetch', async (url: string | URL | Request) => String(url).endsWith('/health')
    ? new Response('', { status: 503 }) : new Response(JSON.stringify(body)));
  expect((await checkReadiness(true)).find(check => check.name === '模型服务')?.status).toBe('warning');
});
