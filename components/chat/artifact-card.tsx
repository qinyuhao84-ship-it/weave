"use client";
import { useI18n } from "@/components/i18n-provider";

import { Code2 } from "lucide-react";
import { DocumentReader } from "@/components/documents/document-reader";
import type { ChatArtifact } from "@/lib/chat/config";

export function ArtifactCard({ artifact }: { artifact: ChatArtifact }) {
  return <div className="mt-4"><DocumentReader name={artifact.name} mediaType={artifact.mediaType} status={artifact.status}
    contentUrl={`/api/chat/artifacts/${artifact.id}`} downloadUrl={`/api/chat/artifacts/${artifact.id}?download=1`} testId="chat-artifact" /></div>;
}

export function ArtifactPlaceholder() {
  const { t } = useI18n();
  return <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-dashed border-[color-mix(in_srgb,var(--waiting-accent)_35%,var(--border))] px-4 py-4 text-[12px] text-muted-foreground"><Code2 size={16} className="text-[var(--waiting-accent)]" aria-hidden /><span>{t("chat_artifact_card.m001")}</span></div>;
}
