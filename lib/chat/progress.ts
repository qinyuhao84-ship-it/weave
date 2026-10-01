/** 实际执行阶段，用于实时展示和回答完成后的过程回看。 */
export type ChatProgress = {
  stage: "titles" | "fulltext" | "graph" | "reading" | "context" | "compressing" | "generating" | "validating";
  label: string;
  elapsedMs: number;
  pages?: Array<{ pageId: string; title: string; matchedBy: string }>;
};
