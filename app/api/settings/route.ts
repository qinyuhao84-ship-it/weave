import { NextRequest } from "next/server";
import { z } from "zod";
import { fail, handle, readJsonObject } from "@/lib/api";
import {
  getPublicSettings, readStoredSettings, saveSettings, mergeProviderInputs,
  PERSONALITY_PRESETS, PersonalitySchema, ProviderInputSchema, isLlmConfigured,
  RetrievalModelInputSchema, mergeRetrievalModelInput,
} from "@/lib/settings";
import { checkDocling } from "@/lib/ingest/parse/docling";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => ({
    settings: getPublicSettings(),
    personalityPresets: PERSONALITY_PRESETS,
    model: { configured: isLlmConfigured() },
    docling: { available: (await checkDocling()).available },
  }));
}

const SettingsPatchSchema = z.object({
  personality: PersonalitySchema.partial().strict().optional(),
  agentName: z.string().trim().min(1).max(20).optional(),
  theme: z.enum(["light", "dark", "system"]).optional(),
  retrievalLimit: z.number().int().min(1).max(50).optional(),
  providers: z.array(ProviderInputSchema).max(30).optional(),
  activeProviderId: z.string().optional(),
  preferSavedModels: z.boolean().optional(),
  retrievalModel: RetrievalModelInputSchema.optional(),
}).strict();

export async function PATCH(request: NextRequest) {
  return handle(async () => {
    const parsed = SettingsPatchSchema.parse(await readJsonObject(request));
    const stored = readStoredSettings();
    const providers = parsed.providers ?? stored.providers;
    if (new Set(providers.map(p => p.id)).size !== providers.length) {
      return fail("模型服务的标识不能重复。", 400);
    }
    const activeId = parsed.activeProviderId ??
      (providers.some(p => p.id === stored.activeProviderId) ? stored.activeProviderId : providers[0]?.id ?? "");
    if (activeId && !providers.some(p => p.id === activeId)) {
      return fail("请选择已保存的模型服务。", 400);
    }
    const { providers: providerInputs, retrievalModel, ...preferences } = parsed;
    saveSettings({
      ...preferences,
      ...(providerInputs ? { providers: mergeProviderInputs(providerInputs) } : {}),
      ...(retrievalModel ? { retrievalModel: mergeRetrievalModelInput(retrievalModel) } : {}),
      activeProviderId: activeId,
    });
    if (retrievalModel) {
      const { scheduleEmbeddingIndex, stopEmbeddingIndex } = await import("@/lib/index/embeddings");
      stopEmbeddingIndex();
      scheduleEmbeddingIndex();
    }
    return { settings: getPublicSettings(), model: { configured: isLlmConfigured() } };
  });
}
