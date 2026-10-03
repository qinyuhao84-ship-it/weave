import { beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, dropAllIndexTables } from "@/lib/db/client";
import { chatSessions } from "@/lib/db/schema";
import { getSettings, saveSettings, ProviderEntrySchema } from "@/lib/settings";
import { restoreChatConfig, type ChatConfig } from "@/lib/chat/config";
import { resolveChatConfig } from "@/lib/chat/config-server";
import { createSession, saveSessionConfig, getSession, beginChatRun, getChatRun } from "@/lib/chat/sessions";

const old: ChatConfig = { providerId: "opencode-go", model: "deepseek-v4.1-flash", reasoningEffort: "max", contextWindow: 1_000_000, showMe: true };
const provider = (id = "deepseek") => ProviderEntrySchema.parse({ id, label: id, baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", reasoningEffort: "default", contextWindow: 32768 });
beforeEach(() => { dropAllIndexTables(); saveSettings({ providers: [provider()], activeProviderId: "deepseek" }); });

it("删除旧网关后，历史会话使用当前服务且保留 HTML 偏好；不改写历史快照", () => {
  const id = createSession(); saveSessionConfig(id, old);
  const run = beginChatRun(id, "旧问题", old);
  const config = getSession(id)!.config!;
  expect(config).toEqual({ providerId: "deepseek", model: "deepseek-flash", reasoningEffort: "default", contextWindow: 32768, showMe: true });
  expect(resolveChatConfig(config)).toEqual({ ...config, reasoningEffort: "high" });
  expect(getChatRun(run.id)?.config).toEqual(old);
  expect(JSON.parse(getDb().select().from(chatSessions).where(eq(chatSessions.id, id)).get()!.configJson!)).toEqual(old);
});
it("保留仍然有效的会话服务、其他型号与独立档位", () => {
  saveSettings({ providers: [provider(), provider("other")], activeProviderId: "deepseek" });
  const chosen = { ...old, providerId: "other", model: "deepseek-v4-pro", reasoningEffort: "low" as const };
  expect(restoreChatConfig(chosen, getSettings())).toEqual(chosen);
});
it("无配置返回空选择，重新添加服务后旧会话自动恢复", () => {
  const id = createSession(); saveSessionConfig(id, old);
  saveSettings({ providers: [], activeProviderId: "" });
  expect(getSession(id)?.config).toBeNull();
  saveSettings({ providers: [provider("replacement")], activeProviderId: "replacement" });
  expect(getSession(id)?.config?.providerId).toBe("replacement");
});
it("空地址的旧服务回到当前服务；新会话采用当前默认", () => {
  saveSettings({ providers: [provider(), { ...provider("opencode-go"), baseUrl: "" }], activeProviderId: "deepseek" });
  expect(restoreChatConfig(old, getSettings())?.providerId).toBe("deepseek");
  expect(restoreChatConfig(null, getSettings())).toMatchObject({ providerId: "deepseek", showMe: false });
});
it("显式提交不存在的服务仍拒绝，避免把错误选择静默发送给其他服务", () => {
  expect(() => resolveChatConfig(old)).toThrow("已移除");
});

it("未知型号的旧会话不继承未经证实的高思考参数", () => {
  saveSettings({ providers: [{ ...provider(), model: 'unannounced-model', reasoningEffort: 'high' }], activeProviderId: 'deepseek' });
  expect(resolveChatConfig({ ...old, providerId: 'deepseek', model: 'unannounced-model', reasoningEffort: 'high' }).reasoningEffort).toBe('default');
});
