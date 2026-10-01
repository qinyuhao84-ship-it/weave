import { handle } from "@/lib/api";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 外壳只需读取 Agent 名称，避免为此探测导入侧车等设置页能力。 */
export async function GET() {
  return handle(() => ({ agentName: getSettings().agentName }));
}
