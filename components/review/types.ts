import type { ChangePlanView, FixPlanView } from "./plan-confirm-panel";
export type ReviewStatus = "pending" | "answered";

export type RelatedPage = { id: string | null; title: string };

/** 与 lib/review/remediate.ts 的 RemediationRecord 对应 */
export type RemediationRecord = {
  summary: string;
  edits: Array<{ pageId: string; title: string; reason: string; added: number; removed: number }>;
  created: Array<{ id: string; title: string }>;
  rejected: string[];
  noChangeReason: string | null;
  /** 这次修订留下几条版本记录 —— 服务层一次写一条，所以通常不止一条 */
  commits: number;
};

export type ReviewItem = {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  severity: string;
  relatedPages: RelatedPage[];
  suggestedAction: string | null;
  status: string;
  decisionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** 「让模型按批注去修」的执行记录。null = 不是那么处理的 */
  remediation: RemediationRecord | null;
  /** 那次修订的 git 提交 */
  appliedSha: string | null;
  /** 系统提的问题与候选答案。两者同时为空 = 没有值得拍板的问题，退回旧交互 */
  question: string | null;
  options: Array<{ id: string; label: string; impact: string }>;
  /** 用户的回答。它是「我的口径」不是「我认不认」，还要等模型处理 */
  answer: string | null;
  answerChoiceId: string | null;
  answerSource: "option" | "freeform" | null;
  answeredAt: string | null;
  /** 正在处理这批回答的任务 id。非空 = 界面上显示「处理中」 */
  batchId: string | null;
};

export type ReviewBatchJob = {
  id: string;
  createdAt?: string;
  status: string;
  progress: number;
  stageLabel: string | null;
  error: string | null;
  payload: { mode?: string; itemIds?: string[] } | null;
  draft: ChangePlanView | FixPlanView | null;
};

