import { z } from "zod";
import { PROVIDER_PRESETS } from "./llm/presets";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { settings as settingsTable } from "@/lib/db/schema";
import { localISOString } from "@/lib/utils";

/**
 * 应用设置。
 *
 * 一条安全纪律贯穿本文件：**API Key 绝不出现在返回给前端的对象里**。
 * 对外一律用 hasApiKey 布尔值代替，前端只知道自己「配没配」，
 * 拿不到也不需要拿到明文。这比事后在前端做屏蔽可靠 ——
 * 屏蔽是消除症状，不返回才是消除病因。
 */

/**
 * 说话语气的取值 —— **唯一真源**。
 *
 * zod 的枚举与界面的选项都从它派生（见下面 TONE_COPY 与 PERSONALITY_PRESETS），
 * 所以不存在「改了枚举、界面选不到」或反过来的可能：加一档只需要在两处各加一行，
 * 少加一处会被 tsc 直接拦下（TONE_COPY 是 Record，漏 key 编译不过）。
 *
 * ⚠️ 旧的 rigorous / plain / casual **一个都不能删**。zod 的 .default() 只在键
 * 缺失时兜底，值非法会直接抛 —— 老库里存着的语气值一旦不在枚举里，
 * 所有读设置的接口会一起挂掉。这条抛错路径由 tests/security.test.ts 保护。
 */
const TONE_ENUM = [
  "rigorous",
  "plain",
  "casual",
  "gentle",
  "sassy",
  "humorous",
  "mentor",
] as const;

/** 每一档的界面文案。漏一个 key 会被 tsc 拦下 —— 这是派生的那一半保证。 */
const TONE_COPY: Record<(typeof TONE_ENUM)[number], { label: string; hint: string }> = {
  rigorous: { label: "严谨学术", hint: "用词精确，结论保守，标注不确定性" },
  plain: { label: "平实直白", hint: "像同事聊天，不绕弯子" },
  casual: { label: "轻松口语", hint: "活泼一些，可用比喻" },
  gentle: { label: "温柔耐心", hint: "语气柔和，直接回答，不指责" },
  sassy: { label: "毒舌犀利", hint: "直言不讳，专挑漏洞，不客套" },
  humorous: { label: "幽默风趣", hint: "用类比和调侃把话说活" },
  mentor: { label: "导师口吻", hint: "循循善诱，多问一句为什么" },
};

export const PERSONALITY_PRESETS = {
  tone: {
    label: "说话语气",
    options: TONE_ENUM.map((value) => ({ value, ...TONE_COPY[value] })),
  },
  style: {
    label: "说话风格",
    options: [
      { value: "conclusion_first", label: "结论先行", hint: "先给答案，再展开依据" },
      { value: "progressive", label: "层层递进", hint: "从背景讲到结论" },
      { value: "socratic", label: "苏格拉底式", hint: "多用追问引导思考" },
    ],
  },
  emoji: {
    label: "emoji 用量",
    options: [
      { value: "none", label: "不用", hint: "纯文字" },
      { value: "light", label: "少量点缀", hint: "关键处偶尔用" },
      { value: "rich", label: "较多", hint: "段落标题与要点处使用" },
    ],
  },
  length: {
    label: "回答长度",
    options: [
      { value: "concise", label: "精简", hint: "只说要点" },
      { value: "balanced", label: "适中", hint: "要点加必要解释" },
      { value: "detailed", label: "详尽", hint: "充分展开，附例子" },
    ],
  },
  noAnswer: {
    label: "知识库里找不到时",
    options: [
      { value: "admit", label: "直接说没有", hint: "明确告知知识库中没有相关内容" },
      { value: "infer", label: "给出推测并标注", hint: "说明这是推测而非知识库内容" },
    ],
  },
  terminology: {
    label: "术语偏好",
    options: [
      { value: "chinese", label: "中文术语优先", hint: "优先使用中文译名" },
      { value: "original", label: "保留英文原词", hint: "技术名词保持英文" },
    ],
  },
} as const;

export type PersonalityKey = keyof typeof PERSONALITY_PRESETS;
export type PersonalityValue<K extends PersonalityKey> =
  (typeof PERSONALITY_PRESETS)[K]["options"][number]["value"];

/** 七维个性化设置 + 主题 */
export const PersonalitySchema = z.object({
  tone: z.enum(TONE_ENUM).default("gentle"),
  style: z.enum(["conclusion_first", "progressive", "socratic"]).default("conclusion_first"),
  emoji: z.enum(["none", "light", "rich"]).default("light"),
  length: z.enum(["concise", "balanced", "detailed"]).default("concise"),
  noAnswer: z.enum(["admit", "infer"]).default("admit"),
  terminology: z.enum(["chinese", "original"]).default("original"),
  /** 对用户的称谓；空字符串表示不称呼 */
  address: z.string().max(20).default(""),
});

export type Personality = z.infer<typeof PersonalitySchema>;

export const EffortSchema = z.enum([
  "default", "none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max",
]);
export type Effort = z.infer<typeof EffortSchema>;

/**
 * 一个模型服务接入点。
 *
 * 做成列表而不是单份配置，是因为「换服务商」在实践中不是替换而是并置：
 * 官方端点便宜、网关套餐覆盖的模型多，两者各有各的用处，用户会来回切。
 * 把旧配置删掉再输一遍是很糟糕的体验。
 */
/** 兼容已有配置的默认窗口。新配置应填写模型实际支持的 token 容量。 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export const ProviderEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  baseUrl: z.string().default(""),
  apiKey: z.string().default(""),
  model: z.string().default(""),
  /** 轻量任务（摘要/标签/分类）用的便宜模型，留空则复用主力 */
  lightModel: z.string().default(""),
  /**
   * 是否支持严格 JSON Schema。
   *
   * 默认 false，而且**填错也不会出事** —— provider 在运行期检测到不支持会
   * 自动降级。这个开关只是省掉一次试探请求，不是正确性的依赖。
   */
  supportsStrictSchema: z.boolean().default(false),
  temperature: z.number().min(0).max(2).default(0.3),
  /**
   * 思考强度。档位差距是数量级的：同一道证明题，
   * low 思考约 660-850 字，max 思考约 3000 字。
   */
  reasoningEffort: EffortSchema.default("high"),
  /**
   * 附加请求头。有些网关要求特定头才能路由 ——
   * 实测 opencode go 需要 x-opencode-session，缺了直接 400。
   */
  headers: z.record(z.string(), z.string()).default({}),
  /**
   * 该模型的上下文窗口，单位是 token。问答界面用它当分母算「上下文占用」，
   * 也是自动压缩摘要的触发基准（占用 ≥ 85% 时压缩）。
   */
  contextWindow: z.number().int().min(1000).max(10_000_000).default(DEFAULT_CONTEXT_WINDOW),
});

export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

/** 旧的单 provider 形状，读取时自动迁移，不让用户重输 */
const LegacyLlmSchema = z.object({
  preset: z.string().default("dashscope"),
  baseUrl: z.string().default(""),
  apiKey: z.string().default(""),
  model: z.string().default(""),
  lightModel: z.string().default(""),
  supportsStrictSchema: z.boolean().default(false),
  temperature: z.number().min(0).max(2).default(0.3),
  reasoningEffort: EffortSchema.default("high"),
  contextWindow: z.number().int().min(1000).max(10_000_000).default(DEFAULT_CONTEXT_WINDOW),
});

export const AppSettingsSchema = z.object({
  agentName: z.string().trim().min(1).max(20).default("织识"),
  /** 所有已配置的模型服务 */
  providers: z.array(ProviderEntrySchema).prefault([]),
  /** 当前使用哪个 */
  activeProviderId: z.string().default(""),
  /** 用户在界面选择服务后，启动配置不再覆盖所选服务。 */
  preferSavedModels: z.boolean().default(false),
  /** 旧版单 provider 字段，仅用于迁移 */
  llm: LegacyLlmSchema.prefault({}),
  personality: PersonalitySchema.prefault({}),
  theme: z.enum(["light", "dark", "system"]).default("system"),
  /** 问答检索时最多读取多少个词条 */
  retrievalLimit: z.number().int().min(1).max(50).default(12),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

const SETTINGS_KEY = "app";

/** 环境变量兜底：让用户可以不把 key 写进数据库（例如 CI 或临时试用） */
function envOverrides(): {
  baseUrl?: string; apiKey?: string; model?: string; lightModel?: string;
  reasoningEffort?: Effort; headers?: Record<string, string>; contextWindow?: number;
} {
  const overrides: ReturnType<typeof envOverrides> = {};
  if (process.env.WEAVE_LLM_BASE_URL) overrides.baseUrl = process.env.WEAVE_LLM_BASE_URL;
  // 去除粘贴或文件读取时带入的首尾空白。
  const envApiKey = process.env.WEAVE_LLM_API_KEY?.trim();
  if (envApiKey) overrides.apiKey = envApiKey;
  if (process.env.WEAVE_LLM_MODEL) overrides.model = process.env.WEAVE_LLM_MODEL;
  if (process.env.WEAVE_LLM_LIGHT_MODEL) overrides.lightModel = process.env.WEAVE_LLM_LIGHT_MODEL;
  if (process.env.WEAVE_LLM_REASONING_EFFORT) {
    const parsed = EffortSchema.safeParse(process.env.WEAVE_LLM_REASONING_EFFORT);
    if (parsed.success) overrides.reasoningEffort = parsed.data;
  }
  // 上下文窗口。非法值（非数字、太小、太大）一律忽略而不是抛错 ——
  // 这是个可选的调优项，环境变量写错不该让整个应用起不来。
  if (process.env.WEAVE_LLM_CONTEXT_WINDOW) {
    const parsed = Number(process.env.WEAVE_LLM_CONTEXT_WINDOW);
    if (Number.isFinite(parsed) && parsed >= 1000 && parsed <= 10_000_000) {
      overrides.contextWindow = Math.trunc(parsed);
    }
  }
  // 网关卡要求的请求头，例如 WEAVE_LLM_HEADER_X_CUSTOM_HEADER=your-value
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("WEAVE_LLM_HEADER_") || !value) continue;
    const headerName = key
      .slice("WEAVE_LLM_HEADER_".length)
      .toLowerCase()
      .replace(/_/g, "-");
    overrides.headers = { ...overrides.headers, [headerName]: value };
  }
  return overrides;
}

function effectiveModelEnv(stored: AppSettings): ReturnType<typeof envOverrides> {
  return stored.preferSavedModels && stored.providers.length > 0 ? {} : envOverrides();
}

/** 地址参考仅用于识别配置来源；模型名和容量由使用者填写。 */
export const BUILTIN_PROVIDERS = [
  ...Object.entries(PROVIDER_PRESETS).map(([id, preset]) => ({ id, ...preset })),
  { id: "deepseek-official", ...PROVIDER_PRESETS.deepseek },
  { id: "opencode-go", label: "OpenCode 网关", baseUrl: "https://opencode.ai/zen/go/v1", note: "请求头和模型权限以网关文档为准。" },
];

/** 读取并兼容迁移原始设置，不合并环境变量，供读取和保存共用。 */
export function readStoredSettings(): AppSettings {
  const row = getDb().select().from(settingsTable).where(eq(settingsTable.key, SETTINGS_KEY)).get();

  let stored: unknown = {};
  if (row) {
    try {
      stored = JSON.parse(row.valueJson);
    } catch {
      stored = {};
    }
  }

  const parsed = AppSettingsSchema.parse(stored);
  const legacy = parsed.llm;
  if (parsed.providers.length === 0 && (legacy.baseUrl || legacy.apiKey)) {
    parsed.providers = [ProviderEntrySchema.parse({
      ...legacy,
      id: legacy.preset && legacy.preset !== "dashscope" ? legacy.preset : "migrated",
      label: "从旧配置迁移",
      headers: {},
    })];
  }
  // 迁移后不再保留第二份凭据；下一次保存会完成持久化迁移。
  return { ...parsed, llm: LegacyLlmSchema.parse({}) };
}

export function getSettings(): AppSettings {
  const parsed = readStoredSettings();
  let providers = [...parsed.providers];

  // 环境变量兜底：没有配置时用 env 造一条，方便 CI 与临时试用
  const env = effectiveModelEnv(parsed);
  if (providers.length === 0 && env.baseUrl) {
    // 地址匹配仅用于标注来源，型号和能力仍由使用者配置。
    const matched = BUILTIN_PROVIDERS.find(
      (preset) => preset.baseUrl && env.baseUrl && env.baseUrl.startsWith(preset.baseUrl.replace(/\/v1$/, "")),
    );
    providers = [
      {
        id: matched?.id ?? "from-env",
        label: matched?.label ?? "（来自环境变量）",
        baseUrl: env.baseUrl,
        apiKey: env.apiKey ?? "",
        model: env.model ?? "",
        lightModel: env.lightModel ?? "",
        supportsStrictSchema: false,
        temperature: 0.3,
        reasoningEffort: env.reasoningEffort ?? "default",
        contextWindow: env.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        // 请求头由使用者明确配置，不按厂商猜测。
        headers: env.headers ?? {},
      },
    ];
  }

  // 环境变量只覆盖当前服务的对应字段，原始保存值保持独立。
  if (Object.keys(env).length > 0) {
    const targetId = providers.some(p => p.id === parsed.activeProviderId) ? parsed.activeProviderId : providers[0]?.id;
    providers = providers.map((entry) =>
      entry.id === targetId
        ? {
            ...entry,
            ...(env.baseUrl ? { baseUrl: env.baseUrl } : {}),
            ...(env.apiKey ? { apiKey: env.apiKey } : {}),
            ...(env.model ? { model: env.model } : {}),
            ...(env.lightModel ? { lightModel: env.lightModel } : {}),
            ...(env.reasoningEffort ? { reasoningEffort: env.reasoningEffort } : {}),
            ...(env.contextWindow ? { contextWindow: env.contextWindow } : {}),
            ...(env.headers ? { headers: { ...entry.headers, ...env.headers } } : {}),
          }
        : entry,
    );
  }

  const activeProviderId =
    parsed.activeProviderId && providers.some((p) => p.id === parsed.activeProviderId)
      ? parsed.activeProviderId
      : (providers[0]?.id ?? "");

  return { ...parsed, providers, activeProviderId };
}

/** 取当前生效的接入点；没有配置时返回 null */
export function getActiveProvider(): ProviderEntry | null {
  const settings = getSettings();
  return settings.providers.find((p) => p.id === settings.activeProviderId) ?? null;
}

/**
 * 当前生效的上下文窗口（token）。
 *
 * 没有配置接入点时回落到默认值而不是 0 —— 占用率的分母一旦是 0，
 * 前端会算出 NaN% 或 Infinity%。宁可显示一个可能不准的分母，
 * 也不要让界面出现无法解释的符号。
 */
export function getContextWindow(): number {
  // 环境变量优先，且**不经过 providers 列表** —— 库里一条 provider 都没有时
  // （全新环境、只想先试试）它同样要生效，那时 providers 是空数组，
  // 上面那段 map 合并根本没机会执行。
  const settings = getSettings();
  const fromEnv = effectiveModelEnv(settings).contextWindow;
  if (fromEnv !== undefined) return fromEnv;

  // 这里**不能**写成 getActiveProvider()：那个函数自己会再调一次 getSettings()，
  // 于是每调一次本函数就多出一遍「读 SQLite + JSON.parse + 整个设置对象的 zod
  // 校验」，而这一遍的结果只为了取一个整数。调用点不便宜 —— 每个 /api/chat
  // 请求、每次打开会话都要走这里。读一次、自己找激活项。
  return (
    settings.providers.find((p) => p.id === settings.activeProviderId)?.contextWindow
    ?? DEFAULT_CONTEXT_WINDOW
  );
}

export const REASONING_EFFORT_OPTIONS = [
  { value: "default", label: "不发送参数", hint: "兼容优先，使用模型服务默认行为" },
  { value: "none", label: "关闭", hint: "不思考，最快最省" },
  { value: "minimal", label: "极少", hint: "只做最低限度的推理" },
  { value: "low", label: "低", hint: "快问快答" },
  { value: "medium", label: "中", hint: "" },
  { value: "high", label: "高", hint: "默认档，日常够用" },
  { value: "xhigh", label: "较高", hint: "" },
  { value: "ultra", label: "极高", hint: "" },
  { value: "max", label: "最高", hint: "长文档整理与复杂推理，最慢也最贵" },
] as const;

export function saveSettings(patch: {
  providers?: ProviderEntry[];
  activeProviderId?: string;
  preferSavedModels?: boolean;
  agentName?: string;
  personality?: Partial<Personality>;
  theme?: AppSettings["theme"];
  retrievalLimit?: number;
}): AppSettings {
  // 从原始配置合并，绝不将环境变量的生效视图写回数据库。
  const current = readStoredSettings();
  const stored = AppSettingsSchema.parse({
    ...current,
    ...patch,
    personality: { ...current.personality, ...patch.personality },
  });
  if (!stored.providers.some(entry => entry.id === stored.activeProviderId)) {
    stored.activeProviderId = stored.providers[0]?.id ?? "";
  }

  const now = localISOString();
  getDb()
    .insert(settingsTable)
    .values({ key: SETTINGS_KEY, valueJson: JSON.stringify(stored), updatedAt: now })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { valueJson: JSON.stringify(stored), updatedAt: now },
    })
    .run();

  // 返回生效值（含环境变量）—— 调用方拿到的是「现在实际会用哪套配置」
  return getSettings();
}

/** 公开视图只返回凭据状态，不返回凭据值或旧版 llm 字段。 */
export type ProviderOverrideField = keyof ReturnType<typeof envOverrides>;
export type PublicProvider = Omit<ProviderEntry, "apiKey" | "headers"> & {
  hasApiKey: boolean;
  hasHeaders: boolean;
  apiKeySource: "env" | "database" | "none";
  overriddenFields: ProviderOverrideField[];
  environmentOnly: boolean;
};

export type PublicSettings = Omit<AppSettings, "providers" | "llm"> & {
  providers: PublicProvider[];
  hint: string | null;
};

export function getPublicSettings(): PublicSettings {
  const { providers: entries, llm: _legacy, ...settings } = getSettings();
  const stored = readStoredSettings();
  const env = effectiveModelEnv(stored);
  const providers: PublicProvider[] = entries.map(entry => {
    const { apiKey, headers, ...rest } = entry;
    const active = entry.id === settings.activeProviderId;
    return {
      ...rest,
      hasApiKey: Boolean(apiKey),
      hasHeaders: Object.keys(headers).length > 0,
      apiKeySource: active && env.apiKey ? "env" : apiKey ? "database" : "none",
      overriddenFields: active ? Object.keys(env) as ProviderOverrideField[] : [],
      environmentOnly: !stored.providers.some(p => p.id === entry.id),
    };
  });
  const active = providers.find(p => p.id === settings.activeProviderId);
  return {
    ...settings,
    providers,
    hint: active?.baseUrl && active.model ? null : "请在设置中配置你的模型服务，再开始导入或问答。",
  };
}

/** 已填写地址和模型；端点与凭据的有效性需通过连接检查验证。 */
export function isLlmConfigured(): boolean {
  const active = getActiveProvider();
  return Boolean(active?.baseUrl && active?.model);
}

const HttpUrlSchema = z.string().trim().url("请输入完整的 API 地址").refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, "地址需使用 HTTP 或 HTTPS，且不能包含凭据、查询参数或片段");

/** 浏览器编辑模型时，凭据省略或留空表示保留；清除必须显式指定。 */
export const ProviderInputSchema = ProviderEntrySchema.omit({ apiKey: true, headers: true }).extend({
  label: z.string().trim().min(1, "请填写服务名称").max(80),
  baseUrl: HttpUrlSchema,
  model: z.string().trim().min(1, "请填写模型名"),
  contextWindow: z.number().int().min(1000).max(10_000_000),
  reasoningEffort: EffortSchema.default("default"),
  apiKey: z.string().trim().optional(),
  clearApiKey: z.boolean().optional(),
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "请求头名称不合法"), z.string().refine(value => !/[\r\n]/.test(value), "请求头不能包含换行")).optional(),
}).strict();

export type ProviderInput = z.infer<typeof ProviderInputSchema>;

/** 将表单合并到原始配置，保留未提交的凭据及被环境覆盖的原始字段。 */
export function mergeProviderInputs(inputs: ProviderInput[]): ProviderEntry[] {
  const stored = readStoredSettings();
  const effective = getSettings();
  const env = effectiveModelEnv(stored);
  const overriddenId = stored.providers.some(entry => entry.id === stored.activeProviderId) ? stored.activeProviderId : stored.providers[0]?.id;
  return inputs.map(input => {
    const storedPrevious = stored.providers.find(p => p.id === input.id);
    // 保存启动配置时由服务端沿用凭据，浏览器始终只拿到「已配置」状态。
    const previous = storedPrevious ?? effective.providers.find(p => p.id === input.id);
    const { clearApiKey, ...values } = input;
    const entry = ProviderEntrySchema.parse({
      ...values,
      apiKey: clearApiKey ? "" : input.apiKey || previous?.apiKey || "",
      headers: input.headers ?? previous?.headers ?? {},
    });
    if (storedPrevious && entry.id === overriddenId) {
      const original = previous ?? ProviderEntrySchema.parse({ id: entry.id, label: entry.label });
      for (const field of Object.keys(env) as ProviderOverrideField[]) {
        Object.assign(entry, { [field]: original[field] });
      }
    }
    return entry;
  });
}
