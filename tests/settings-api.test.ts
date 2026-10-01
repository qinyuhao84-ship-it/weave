import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PATCH } from "@/app/api/settings/route";
import { dropAllIndexTables, getDb } from "@/lib/db/client";
import { settings as table } from "@/lib/db/schema";
import { createProvider } from "@/lib/llm";
import { getContextWindow, getPublicSettings, getSettings, readStoredSettings, saveSettings, type PublicProvider } from "@/lib/settings";

const input = (id = "one") => ({ id, label: `服务 ${id}`, baseUrl: "http://127.0.0.1:11434/v1", model: "local-test-model", contextWindow: 32768 });
const update = (body: unknown) => PATCH(new NextRequest("http://localhost/api/settings", { method: "PATCH", body: JSON.stringify(body) }));
function editable(provider: PublicProvider) {
  const { hasApiKey: _key, hasHeaders: _headers, apiKeySource: _source, overriddenFields: _fields, environmentOnly: _env, ...rest } = provider;
  return rest;
}
beforeEach(() => { dropAllIndexTables(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("本机模型配置 API", () => {
  it("首次启动无模型也可以读写个人偏好", async () => {
    const body = await (await GET()).json();
    expect(body.data.settings.providers).toEqual([]);
    expect(body.data.model.configured).toBe(false);
    expect((await update({ personality: { tone: "plain" } })).status).toBe(200);
    expect(getSettings().personality.tone).toBe("plain");
  });
  it("新增、切换、删除本地服务，空密钥不发送 Authorization", async () => {
    expect((await update({ providers: [input()], activeProviderId: "one" })).status).toBe(200);
    expect(getPublicSettings().providers[0].hasApiKey).toBe(false);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: "local-test-model", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await createProvider().complete({ messages: [{ role: "user", content: "test" }] })).text).toBe("ok");
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
    expect((await update({ providers: [input(), input("two")], activeProviderId: "two" })).status).toBe(200);
    expect(getSettings().activeProviderId).toBe("two");
    expect((await update({ providers: [input()], activeProviderId: "one" })).status).toBe(200);
    expect((await update({ providers: [], activeProviderId: "" })).status).toBe(200);
    expect(getSettings().providers).toEqual([]);
  });
  it("凭据和请求头不回显，省略或空密钥保留，清除需显式操作", async () => {
    const first = await update({ providers: [{ ...input(), apiKey: "fixture-secret", headers: { authorization: "fixture-header" } }], activeProviderId: "one" });
    const publicBody = await first.json();
    expect(JSON.stringify(publicBody)).not.toContain("fixture-secret");
    expect(JSON.stringify(publicBody)).not.toContain("fixture-header");
    const provider = publicBody.data.settings.providers[0];
    expect(provider.hasHeaders).toBe(true);
    expect((await update({ providers: [{ ...editable(provider), apiKey: "", label: "修改名称" }] })).status).toBe(200);
    expect(getSettings().providers[0].apiKey).toBe("fixture-secret");
    expect(getSettings().providers[0].headers).toEqual({ authorization: "fixture-header" });
    await update({ providers: [{ ...input(), apiKey: "replacement-secret" }] });
    expect(getSettings().providers[0].apiKey).toBe("replacement-secret");
    await update({ providers: [{ ...input(), clearApiKey: true, headers: {} }] });
    expect(getSettings().providers[0].apiKey).toBe("");
    expect(getSettings().providers[0].headers).toEqual({});
  });
  it("环境覆盖只标记当前服务，修改表单不固化覆盖且保留原凭据", async () => {
    await update({ providers: [{ ...input(), apiKey: "stored-key", headers: { "x-token": "stored-header" } }, { ...input("two"), apiKey: "other-key" }], activeProviderId: "one" });
    vi.stubEnv("WEAVE_LLM_BASE_URL", "https://env.example/v1");
    vi.stubEnv("WEAVE_LLM_API_KEY", "env-secret");
    vi.stubEnv("WEAVE_LLM_MODEL", "env-model");
    vi.stubEnv("WEAVE_LLM_CONTEXT_WINDOW", "64000");
    vi.stubEnv("WEAVE_LLM_HEADER_X_TOKEN", "env-header");
    const view = getPublicSettings();
    expect(view.providers[0].apiKeySource).toBe("env");
    expect(view.providers[1].apiKeySource).toBe("database");
    expect(view.providers[1].overriddenFields).toEqual([]);
    expect(view.providers[0].overriddenFields).toContain("contextWindow");
    await update({ providers: view.providers.map(editable), activeProviderId: "one" });
    await update({ personality: { tone: "plain" } });
    const stored = readStoredSettings().providers[0];
    expect(stored.baseUrl).toBe(input().baseUrl);
    expect(stored.apiKey).toBe("stored-key");
    expect(stored.model).toBe(input().model);
    expect(stored.contextWindow).toBe(32768);
    expect(stored.headers).toEqual({ "x-token": "stored-header" });
    const rows = JSON.stringify(getDb().select().from(table).all());
    expect(rows).not.toContain("env-secret"); expect(rows).not.toContain("env-model"); expect(rows).not.toContain("env-header");
    vi.unstubAllEnvs();
    expect(getSettings().providers[0].apiKey).toBe("stored-key");
  });
  it("仅环境配置无需密钥，保存偏好不会将其复制进数据库", async () => {
    vi.stubEnv("WEAVE_LLM_BASE_URL", "http://127.0.0.1:11434/v1");
    vi.stubEnv("WEAVE_LLM_MODEL", "environment-model");
    const response = await (await GET()).json();
    expect(response.data.model.configured).toBe(true);
    expect(response.data.settings.providers[0].environmentOnly).toBe(true);
    await update({ theme: "dark" });
    expect(readStoredSettings().providers).toEqual([]);
    vi.unstubAllEnvs();
    expect(getSettings().providers).toEqual([]);
  });
  it("显式保存启动配置时服务端沿用隐藏凭据，保存后可编辑", async () => {
    vi.stubEnv("WEAVE_LLM_BASE_URL", "https://api.deepseek.com/v1");
    vi.stubEnv("WEAVE_LLM_MODEL", "deepseek-flash");
    vi.stubEnv("WEAVE_LLM_API_KEY", "environment-only-secret");
    vi.stubEnv("WEAVE_LLM_HEADER_X_CUSTOM", "hidden-header");
    const current = getPublicSettings().providers[0];
    const response = await update({ providers: [editable(current)], activeProviderId: current.id, preferSavedModels: true });
    expect(response.status).toBe(200);
    expect(readStoredSettings().providers[0]).toMatchObject({ apiKey: "environment-only-secret", headers: { "x-custom": "hidden-header" } });
    const text = await response.text();
    expect(text).not.toContain("environment-only-secret"); expect(text).not.toContain("hidden-header");
    expect(getPublicSettings().providers[0]).toMatchObject({ environmentOnly: false, overriddenFields: [] });
  });
  it("界面新增和切换服务优先于启动配置，保留旧配置并在全部删除后兜底", async () => {
    await update({ providers: [{ ...input(), apiKey: "stored-key" }], activeProviderId: "one" });
    vi.stubEnv("WEAVE_LLM_BASE_URL", "https://env.example/v1");
    vi.stubEnv("WEAVE_LLM_API_KEY", "env-secret");
    vi.stubEnv("WEAVE_LLM_MODEL", "env-model");
    vi.stubEnv("WEAVE_LLM_CONTEXT_WINDOW", "64000");
    const previous = getPublicSettings().providers.map(editable);
    const next = { ...input("two"), baseUrl: "https://selected.example/v1", apiKey: "new-secret", model: "selected-model", contextWindow: 128000 };
    expect((await update({ providers: [...previous, next], activeProviderId: "two", preferSavedModels: true })).status).toBe(200);
    const active = getSettings().providers.find(provider => provider.id === "two");
    expect(active).toMatchObject(next);
    expect(getContextWindow()).toBe(128000);
    expect(getPublicSettings().providers.every(provider => provider.overriddenFields.length === 0)).toBe(true);
    expect(readStoredSettings().providers[0]).toMatchObject(input());
    expect(JSON.stringify(readStoredSettings())).not.toContain("env-secret");
    expect(JSON.stringify(readStoredSettings())).not.toContain("env-model");
    await update({ activeProviderId: "one", preferSavedModels: true });
    expect(getSettings().providers[0].apiKey).toBe("stored-key");
    expect(getContextWindow()).toBe(32768);
    await update({ providers: [], activeProviderId: "" });
    expect(getSettings().providers[0]).toMatchObject({ baseUrl: "https://env.example/v1", model: "env-model", apiKey: "env-secret" });
    expect(readStoredSettings().providers).toEqual([]);
  });
  it("旧版 llm 自动迁移且绝不通过公开视图泄露", async () => {
    getDb().insert(table).values({ key: "app", valueJson: JSON.stringify({ llm: { ...input(), apiKey: "legacy-secret" } }), updatedAt: new Date().toISOString() }).run();
    expect(getSettings().providers[0].apiKey).toBe("legacy-secret");
    const body = await (await GET()).json();
    expect(body.data.settings).not.toHaveProperty("llm");
    expect(JSON.stringify(body)).not.toContain("legacy-secret");
    expect((await update({ providers: body.data.settings.providers.map(editable) })).status).toBe(200);
    expect(getSettings().providers[0].apiKey).toBe("legacy-secret");
    saveSettings({ theme: "dark" });
    expect(readStoredSettings().llm.apiKey).toBe("");
    expect(readStoredSettings().providers[0].apiKey).toBe("legacy-secret");
    await update({ providers: [] });
    expect(getSettings().providers).toEqual([]);
  });
  it.each([
    null, { providers: [input(), input()] }, { activeProviderId: "missing" },
    { providers: [{ ...input(), baseUrl: "file:///tmp/example" }] },
    { providers: [{ ...input(), baseUrl: "https://user:password@example.com/v1" }] },
    { providers: [{ ...input(), contextWindow: 1 }] },
    { providers: [{ ...input(), model: " " }] },
    { providers: [{ ...input(), headers: { "bad name": "x" } }] },
    { providers: [{ ...input(), headers: { "x-test": "a\nb" } }] },
    { personality: { unexpected: "x" } },
  ])("拒绝无效配置且不改变原设置 %j", async body => {
    await update({ providers: [input()], activeProviderId: "one" });
    const before = readStoredSettings();
    expect((await update(body)).status).toBe(400);
    expect(readStoredSettings()).toEqual(before);
  });
});
