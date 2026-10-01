import { handle } from "@/lib/api";
import { checkReadiness } from "@/lib/readiness";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { return handle(async () => ({ checks: await checkReadiness() })); }
/** 仅请求模型列表，不执行生成，不把凭据返回浏览器。 */
export async function POST() { return handle(async () => ({ checks: await checkReadiness(true) })); }
