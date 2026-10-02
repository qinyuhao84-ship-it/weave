"use client";
import * as React from "react";
import type { ChangePlanView } from "@/components/review/plan-confirm-panel";
import type { Phase, LogEntry, DuplicateInfo, IngestDraft, ReviewDecisionDraft, CommitResult, IngestQueueItem } from "./types";

type IngestState = {
  open: boolean;
  phase: Phase;
  recovered: boolean;
  jobId: string | null;
  fileName: string | null;
  progress: number;
  stage: string;
  stageLabel: string;
  message: string | null;
  startedAt: number | null;
  logs: LogEntry[];
  error: string | null;
  duplicate: DuplicateInfo | null;
  draft: IngestDraft | null;
  skipped: Set<string>;
  decisions: Map<number, ReviewDecisionDraft>;
  batchJobId: string | null;
  batchStage: string;
  batchProgress: number;
  batchPlan: ChangePlanView | null;
  batchBusy: boolean;
  committing: boolean;
  stopping: boolean;
  notice: string | null;
  commitProgress: number;
  result: CommitResult | null;
  queueItems: IngestQueueItem[];
  queueUploading: boolean;
};

function initialState(): IngestState {
  return {
    open: false,
    phase: "idle",
    recovered: false,
    jobId: null,
    fileName: null,
    progress: 0,
    stage: "uploaded",
    stageLabel: "",
    message: null,
    startedAt: null,
    logs: [],
    error: null,
    duplicate: null,
    draft: null,
    skipped: new Set(),
    decisions: new Map(),
    batchJobId: null,
    batchStage: "",
    batchProgress: 0,
    batchPlan: null,
    batchBusy: false,
    committing: false,
    stopping: false,
    notice: null,
    commitProgress: 0,
    result: null,
    queueItems: [],
    queueUploading: false,
  };
}

/** 单一状态宿主；稳定的字段操作复用现有事件与自动保存流程。 */
export function useIngestState() {
  const [state, dispatch] = React.useReducer(
    (current: IngestState, update: (current: IngestState) => Partial<IngestState>) => ({ ...current, ...update(current) }),
    undefined,
    initialState,
  );
  const setters = React.useMemo(() => {
    function field<K extends keyof IngestState>(key: K): React.Dispatch<React.SetStateAction<IngestState[K]>> {
      return value => dispatch(current => ({ [key]: typeof value === "function"
        ? (value as (previous: IngestState[K]) => IngestState[K])(current[key]) : value }));
    }
    return {
      setOpen: field("open"),
      setPhase: field("phase"),
      setRecovered: field("recovered"),
      setJobId: field("jobId"),
      setFileName: field("fileName"),
      setProgress: field("progress"),
      setStage: field("stage"),
      setStageLabel: field("stageLabel"),
      setMessage: field("message"),
      setStartedAt: field("startedAt"),
      setLogs: field("logs"),
      setError: field("error"),
      setDuplicate: field("duplicate"),
      setDraft: field("draft"),
      setSkipped: field("skipped"),
      setDecisions: field("decisions"),
      setBatchJobId: field("batchJobId"),
      setBatchStage: field("batchStage"),
      setBatchProgress: field("batchProgress"),
      setBatchPlan: field("batchPlan"),
      setBatchBusy: field("batchBusy"),
      setCommitting: field("committing"),
      setStopping: field("stopping"),
      setNotice: field("notice"),
      setCommitProgress: field("commitProgress"),
      setResult: field("result"),
      setQueueItems: field("queueItems"),
      setQueueUploading: field("queueUploading"),
    };
  }, []);
  return { ...state, ...setters };
}
