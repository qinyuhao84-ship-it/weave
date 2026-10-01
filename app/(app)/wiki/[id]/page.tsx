import { PageDetail } from "@/components/wiki/page-detail";

export const dynamic = "force-dynamic";

export default async function PageDetailRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PageDetail pageId={id} />;
}
