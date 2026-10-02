export type DataScope = "all" | "knowledge" | "sessions" | "review" | "settings";
export type DataVersions = { data: number; knowledge: number; sessions: number; review: number; settings: number };
export const initialDataVersions: DataVersions = { data: 0, knowledge: 0, sessions: 0, review: 0, settings: 0 };

/** 原生 reducer 足够管理失效范围；会话更新不重取知识库与设置。 */
export function advanceDataVersions(current: DataVersions, scope: DataScope): DataVersions {
  return {
    data: current.data + (scope === "sessions" ? 0 : 1),
    knowledge: current.knowledge + (scope === "all" || scope === "knowledge" ? 1 : 0),
    sessions: current.sessions + (scope === "all" || scope === "sessions" ? 1 : 0),
    review: current.review + (scope === "all" || scope === "knowledge" || scope === "review" ? 1 : 0),
    settings: current.settings + (scope === "all" || scope === "settings" ? 1 : 0),
  };
}
