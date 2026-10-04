/** 仅提供接入地址，型号、容量与权限以使用者账号和服务商文档为准。 */
const preset = (label: string, baseUrl: string, note = "填写账号可用的模型名与实际上下文容量。", docs = "", defaultModel = "", defaultHeaders: Record<string, string> = {}) => ({ label, baseUrl, note, docs, defaultModel, defaultHeaders, supportsStrictSchema: false });

/** 官方 Go 文档标注为 Chat Completions 的模型；其他 Go 模型走不同协议。 */
export const OPENCODE_GO_CHAT_COMPLETION_MODELS = [
  "glm-5.3-flash", "glm-5.3", "glm-5.2",
  "kimi-k3", "kimi-k2.7-code", "kimi-k2.6",
  "longcat-2.0", "longcat-2.5-preview-free",
  "deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp",
  "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.5", "mimo-v2.5-pro",
  "hy4-preview", "hy3", "space-bunny-free",
] as const;
export const OPENCODE_GO_USER_AGENT = "weave/0.2.3";

export function isOpenCodeGoBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.origin === "https://opencode.ai" && url.pathname.replace(/\/+$/, "") === "/zen/go/v1" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export const PROVIDER_PRESETS = {
  openai: preset("OpenAI", "https://api.openai.com/v1", undefined, "https://platform.openai.com/docs/api-reference"),
  claude: preset("Anthropic Claude（兼容接口）", "https://api.anthropic.com/v1", "使用官方 OpenAI 兼容接口，支持文本问答；高级原生能力不在此接口范围内。", "https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk"),
  gemini: preset("Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "使用 Gemini 的 OpenAI 兼容接口；地址可按代理服务修改。", "https://ai.google.dev/gemini-api/docs/openai"),
  deepseek: preset("DeepSeek 官方", "https://api.deepseek.com/v1", undefined, "https://api-docs.deepseek.com/"),
  "opencode-go": preset(
    "OpenCode Go",
    "https://opencode.ai/zen/go/v1",
    "只支持 Go 文档标注为 Chat Completions 的模型。默认 DeepSeek V4.1 Flash，并自动添加 Go 会话请求头。",
    "https://opencode.ai/docs/go/",
    "deepseek-v4.1-flash",
    { "x-opencode-session": "weave" },
  ),
  dashscope: preset("阿里云百炼 · 通义千问", "https://dashscope.aliyuncs.com/compatible-mode/v1", "按账号区域与计费方案确认地址；Coding Plan 地址与通用 API 不同。", "https://help.aliyun.com/zh/model-studio/"),
  moonshot: preset("月之暗面 · Kimi", "https://api.moonshot.cn/v1", undefined, "https://platform.moonshot.cn/docs/"),
  zhipu: preset("智谱 · GLM", "https://open.bigmodel.cn/api/paas/v4", "通用 API 地址；Coding Plan 用户请改为套餐专用地址。", "https://docs.bigmodel.cn/"),
  doubao: preset("火山方舟 · 豆包", "https://ark.cn-beijing.volces.com/api/v3", "填写模型 ID 或推理接入点 ID；Coding Plan 用户请确认专用地址。", "https://docs.volcengine.com/docs/ark/base-url-and-authentication"),
  minimax: preset("MiniMax", "https://api.minimax.io/v1", "按账号区域与套餐确认 API 地址。", "https://platform.minimax.io/docs/api-reference/text-openai-api"),
  siliconflow: preset("硅基流动", "https://api.siliconflow.cn/v1", undefined, "https://api-docs.siliconflow.cn/docs/userguide/quickstart"),
  openrouter: preset("OpenRouter", "https://openrouter.ai/api/v1", undefined, "https://openrouter.ai/docs/quickstart"),
  hunyuan: preset("腾讯混元", "https://api.hunyuan.cloud.tencent.com/v1", undefined, "https://cloud.tencent.com/document/product/1729/111007"),
  spark: preset("讯飞星火", "https://spark-api-open.xf-yun.com/v1", "密钥填写控制台 HTTP 接口的 APIPassword；模型名按所开通版本填写。", "https://www.xfyun.cn/doc/spark/HTTP调用文档.html"),
  stepfun: preset("阶跃星辰", "https://api.stepfun.com/v1", "通用 API 地址；Step Plan 用户请在高级设置改为套餐地址。", "https://platform.stepfun.com/"),
  qianfan: preset("百度千帆 · 文心", "https://qianfan.baidubce.com/v2", undefined, "https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y"),
  xai: preset("xAI · Grok", "https://api.x.ai/v1", undefined, "https://docs.x.ai/developers/rest-api-reference/inference"),
  mistral: preset("Mistral", "https://api.mistral.ai/v1", undefined, "https://docs.mistral.ai/resources/migration-guides"),
  groq: preset("Groq", "https://api.groq.com/openai/v1", undefined, "https://console.groq.com/docs/overview"),
  together: preset("Together AI", "https://api.together.xyz/v1", undefined, "https://www.together.ai/serverless-inference"),
  cohere: preset("Cohere", "https://api.cohere.ai/compatibility/v1", undefined, "https://docs.cohere.com/docs/compatibility-api"),
  nvidia: preset("NVIDIA NIM", "https://integrate.api.nvidia.com/v1", undefined, "https://docs.nvidia.com/nim-operator/latest/guardrail.html"),
  fireworks: preset("Fireworks AI", "https://api.fireworks.ai/inference/v1", undefined, "https://fireworks.ai/docs/api-reference/post-responses"),
  ollama: preset("Ollama（本地）", "http://127.0.0.1:11434/v1", "先在本机启动 Ollama 并拉取模型；无认证时密钥可留空。", "https://docs.ollama.com/api/openai-compatibility"),
  lmstudio: preset("LM Studio（本地）", "http://127.0.0.1:1234/v1", "先在 LM Studio 加载模型并启动服务；无认证时密钥可留空。", "https://lmstudio.ai/docs/developer/openai-compat"),
  openaiCompatible: preset("自定义兼容服务 / 网关", "", "填写支持 /chat/completions 的 API 基础地址，可添加多个配置。"),
} as const;
export type ProviderPresetKey = keyof typeof PROVIDER_PRESETS;
export function isPresetKey(value: string): value is ProviderPresetKey { return Object.hasOwn(PROVIDER_PRESETS, value); }
