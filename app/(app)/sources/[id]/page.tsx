import { SourceDetailWorkspace } from "@/components/sources/workspace";

export const dynamic = "force-dynamic";

export default async function SourceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SourceDetailWorkspace sourceId={id} />;
}
