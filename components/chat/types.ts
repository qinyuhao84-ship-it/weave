import type { ChatProgress } from "@/lib/chat/progress";
import type { ChatConfig, ChatArtifact } from "@/lib/chat/config";

export type Citation = {
  index: number;
  pageId: string;
  pageTitle: string;
  pageType: string;
  sourcePage: number | null;
  sourceDoc: string | null;
  excerpt: string;
  sourceRefs?: Array<{
    sourceId: string | null;
    originalName: string;
    page: number | null;
    quote: string | null;
  }>;
};

export type Quality = {
  citationCount: number;
  hallucinationCount: number;
  hallucinationRate: number;
  hasNoCitations: boolean;
  isNoAnswer: boolean;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: { list?: Citation[]; quality?: Quality; hallucinated?: number[]; process?: ChatProgress[] } | null;
  filedAsPageId: string | null;
  /** 这条回答是被用户中途停掉的。界面要如实标出来，不能让它看起来像答完了 */
  interrupted?: boolean;
  runStatus?: "running" | "done" | "failed" | "cancelled" | null;
  runError?: string | null;
  process?: ChatProgress[];
  createdAt: string;
  config?: ChatConfig | null;
  artifacts?: ChatArtifact[];
};

