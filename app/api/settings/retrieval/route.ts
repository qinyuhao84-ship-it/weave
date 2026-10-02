import { handle, fail } from "@/lib/api";
import { embeddingIndexStatus, startEmbeddingIndex } from "@/lib/index/embeddings";
import { getSettings } from "@/lib/settings";
import { embedTexts, rerankTexts } from "@/lib/llm/retrieval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() { return handle(() => embeddingIndexStatus()); }
/** PUT 仅用固定测试文本检查已保存配置，不发送知识库正文。 */
export async function PUT(request: Request) {
  return handle(async () => {
    const config = getSettings().retrievalModel;
    const [vector] = await embedTexts(config, ["织识知识检索 / knowledge retrieval"], request.signal);
    if (config.rerankModel) await rerankTexts(config, "知识检索", ["知识检索帮助查找相关资料。", "天气晴朗。"], request.signal);
    return { connected: true, dimensions: vector.length, rerank: Boolean(config.rerankModel) };
  });
}
export async function POST() {
  if (!getSettings().retrievalModel.enabled) return fail("请先保存并启用混合检索。", 400);
  return handle(() => { const jobId = startEmbeddingIndex(); return { ...embeddingIndexStatus(), jobId }; });
}
