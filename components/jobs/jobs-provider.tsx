"use client";

import * as React from "react";
import { apiFetch } from "@/hooks/use-api";

/**
 * 活动任务的宿主：**除了导入之外**那些后台任务的状态（体检、按批注修订……）。
 *
 * 为什么要有它：体检从「请求里跑完再返回」改成后台任务之后，用户点完
 * 「开始体检」就能去干别的了 —— 那么问题来了：进度在哪看？关掉页面再回来，
 * 怎么知道它还在跑？导入早就解决了这件事（左下角那个常驻指示器），
 * 但那份状态住在 IngestProvider 里，是为导入的草稿流程量身定做的，
 * 体检借用不了。所以这一层只管一件事：**现在有哪些任务在跑**，以及**怎么停**。
 *
 * 这一层是**只读**的：它只回答「现在有哪些任务在跑」。停止是各个任务自己界面里的
 * 动作（导入抽屉里停导入、体检页里停体检）—— 常驻在栏底的是一个指示器，
 * 不该同时是一排会丢掉几分钟工作的按钮。
 *
 * 为什么导入不由它管：导入那一条要显示的不只是进度（还有「草稿待你审阅」
 * 与「上次没导入成」），而且它的进度来自一条实时 SSE 连接。把两份状态合成
 * 一份的收益，小于动那段已经稳了的代码的风险。界面上它们长得一样、挨在一起，
 * 用户看到的就是「一排任务」—— 内部有几个 provider 与他无关。
 *
 * 轮询而不是 SSE：这里要看的是**一个集合**（任务会来来去去），而 SSE 是按
 * 单个任务订阅的 —— 要么为每个任务开一条连接，要么再加一层任务变更通知。
 * 本机单用户、活动任务通常只有一个，轮询的代价是一次本地 SQLite 查询。
 * 有任务时快一点（1.2s），没任务时慢一点（6s），两者都用 `?active=1` 这个
 * 已经存在的接口。
 */

export type ActiveJob = {
  id: string;
  kind: string;
  status: string;
  stage: string;
  stageLabel: string;
  progress: number;
  message: string | null;
  payload: { title?: string; mode?: string; itemIds?: string[]; fileName?: string; itemId?: string; mechanicalOnly?: boolean } | null;
  createdAt: string;
};

type JobsValue = {
  /** 正在跑或排队的任务（不含导入，见文件顶部说明） */
  jobs: ActiveJob[];
  /** 立刻重取一次。刚起了一个任务之后调它，左下角才不用等下一次轮询 */
  refresh: () => Promise<void>;
};

const JobsContext = React.createContext<JobsValue | null>(null);

export function useJobs(): JobsValue {
  const value = React.useContext(JobsContext);
  if (!value) throw new Error("useJobs 必须在 JobsProvider 内使用");
  return value;
}

/** 有任务在跑时的轮询间隔：够实时，又不至于把日志刷满 */
const POLL_ACTIVE_MS = 1_200;
/** 没任务时的兜底间隔：用户可能在别处起了任务，总得发现它 */
const POLL_IDLE_MS = 6_000;

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = React.useState<ActiveJob[]>([]);

  // 下一轮该等多久，取决于这一轮拿到了什么 —— 所以是递归 setTimeout 而不是
  // setInterval：周期固定的定时器只能二选一（要么空转浪费、要么反应迟钝）。
  const jobsRef = React.useRef<ActiveJob[]>([]);
  React.useLayoutEffect(() => { jobsRef.current = jobs; }, [jobs]);

  const load = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ jobs: ActiveJob[] }>("/api/jobs?active=1");
      // 导入任务交给侧栏的导入指示器（它订阅实时 SSE，比这里的轮询更细）。
      // 这里滤掉它，免得同一个任务在左下角出现两行。
      setJobs(data.jobs.filter((job) => job.kind !== "ingest"));
    } catch {
      // 取不到就维持现状。下一次轮询会自愈，界面不该因为一次网络抖动清空
    }
  }, []);

  React.useEffect(() => {
    let alive = true;
    let timer: number | null = null;

    const tick = async () => {
      if (!alive) return;
      await load();
      if (!alive) return;
      timer = window.setTimeout(tick, jobsRef.current.length > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    void tick();

    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [load]);

  const value = React.useMemo<JobsValue>(
    () => ({ jobs, refresh: load }),
    [jobs, load],
  );

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}
