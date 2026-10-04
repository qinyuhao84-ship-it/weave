export type Phase = "idle" | "running" | "review" | "done" | "duplicate";

export type IngestQueueItem = {
  id: string;
  originalName: string;
  byteSize: number;
  status: "queued" | "processing" | "awaiting_review" | "failed" | "paused";
  jobId: string | null;
  error: string | null;
  createdAt: string;
};

export type LogEntry = { message: string; level: "info" | "warning" | "error" };

export type JobEvent =
  | { type: "status"; status: string; stage: string }
  | { type: "stage"; stage: string; label: string; message?: string }
  | { type: "progress"; progress: number; total: number }
  | { type: "delta"; text: string }
  | { type: "log"; message: string; level?: "info" | "warning" | "error" }
  | { type: "error"; message: string }
  | { type: "done" };

export type JobView = {
  id: string;
  kind: string;
  status: string;
  stage: string;
  stageLabel: string;
  progress: number;
  message: string | null;
  error: string | null;
  payload: { fileName?: string } | null;
  createdAt: string;
};

export type DuplicateInfo = {
  kind: "exact" | "similar";
  existingName: string;
  existingId: string;
  importedAt: string;
};

export type DraftPage = {
  type: string;
  title: string;
  summary: string;
  content: string;
  aliases: string[];
  tags: string[];
  confidence: "high" | "medium" | "low";
  citations: Array<{ page: number | null; quote: string }>;
};

export type DraftUpdate = {
  title: string;
  reason: string;
  proposedContent?: string;
  originalContent?: string;
  expectedHash?: string;
  appendContent: string;
  addAliases: string[];
  addTags: string[];
  citations: Array<{ page: number | null; quote: string }>;
};

export type DraftReviewItem = {
  kind: string;
  title: string;
  detail: string;
  severity: string;
  relatedTitles: string[];
  /** 系统提的问题与候选答案。两者同时为空 = 没有值得拍板的问题，退回旧交互 */
  question?: string;
  options?: Array<{ id: string; label: string; impact: string }>;
};

export type Draft = {
  sourceSummary: { title: string; content: string };
  newPages: DraftPage[];
  updatedPages: DraftUpdate[];
  reviewItems: DraftReviewItem[];
};

export type IngestDraft = {
  jobId: string;
  source: { docPath: string; originalName: string; pageCount: number | null; parser: string };
  analysis: {
    gist: string;
    entities: Array<{ name: string; type: string }>;
    concepts: Array<{ name: string }>;
    contradictions: Array<{ existing: string; claim: string; conflict: string }>;
  };
  draft: Draft;
  warnings: string[];
  upgradeHint: string | null;
  sourceSummarySnapshot?: { pageId: string; expectedHash: string };
  reviewRevision?: number;
  aiReviewJobId?: string;
  reviewState?: { skippedTitles: string[]; decisions: Array<[number, ReviewDecisionDraft]> };
};

/**
 * 用户在草稿上对一条事项做过的事。
 *
 * 裁决与回答是两件独立的事，都可能只发生一半：只回答不裁决的条目会落成
 * answered 等模型处理；只裁决不回答的按老路子直接结案。
 */
export type ReviewDecisionDraft = {
  decision?: "accepted" | "dismissed";
  note: string;
  answer: string;
  choiceId: string | null;
};

export type CommitResult = {
  createdPages: Array<{ id: string; title: string; path: string }>;
  updatedPages: Array<{ id: string; title: string; addedChars: number }>;
  reviewItemCount: number;
  /** 接着起的那批回答处理任务。null = 这次没有回答，或者没配模型 */
  batchJobId: string | null;
  commitSha: string | null;
  conflicts: string[];
};
