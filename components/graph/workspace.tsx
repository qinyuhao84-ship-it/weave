"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Network, Filter, X, Info } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { useAppData } from "@/components/app-provider";
import { Badge, TypeBadge, Button, Card, Spinner, EmptyState, Hairline, Select } from "@/components/ui";
import { useApi } from "@/hooks/use-api";
import { useTheme } from "@/hooks/use-theme";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

// react-force-graph 依赖 window，必须禁用 SSR
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Spinner size={18} />
    </div>
  ),
});

type GraphNode = {
  id: string;
  title: string;
  type: string;
  degree: number;
  isolated: boolean;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
};

type GraphLink = {
  id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  relType: string;
  weight: number;
  signals: { occurrences?: number; sourceType?: string } | null;
  evidence: string | null;
};

type GraphData = {
  nodes: GraphNode[];
  links: GraphLink[];
  stats: { pages: number; links: number; edges: number; orphans: number; dangling: number };
  truncated: boolean;
  note?: string;
};

/** 主题变量缺失时的兜底（只在服务端渲染那一帧会用到） */
const TYPE_FALLBACK: Record<string, string> = {
  entity: "pageTypes.entity", concept: "pageTypes.concept", source: "pageTypes.source",
  query: "pageTypes.query", overview: "pageTypes.overview",
};

/**
 * 把 CSS 变量解析成浏览器规范化之后的 rgb()/rgba() 字符串。
 *
 * 自定义属性的返回值只是 token 流（可能是 #11111114 这种 8 位十六进制），
 * canvas 不一定接受。借一个探针元素让浏览器算一次，拿到的就是标准形式。
 */
function resolveVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const raw = styles.getPropertyValue(name).trim();
  if (!raw) return fallback;
  const probe = document.createElement("span");
  probe.style.color = raw;
  if (!probe.style.color) return fallback; // 无效值会被浏览器丢弃
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved || fallback;
}

function withAlpha(color: string, alpha: number): string {
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) return color;
  const [r, g, b] = match[1].split(",").map((part) => Number.parseFloat(part));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 画布上读不到 CSS 变量，所以渲染时把当前主题的实际色值取出来。
 *
 * 依赖 resolved（已解析「跟随系统」）而不是 theme：选跟随系统的用户
 * 在系统切深浅色时也要重画。原来是写死的 #111111 与 rgba(17,17,17,…)，
 * 暗色下深色画在 #18181b 上，节点与边基本消失。
 */
function useCanvasColors(resolved: "light" | "dark", focusMode: boolean) {
  return React.useMemo(() => {
    if (typeof window === "undefined") {
      return {
        node: "#111111", label: "#11111199", edge: "#11111114",
        accent: "#2563eb", type: TYPE_FALLBACK,
      };
    }
    const styles = getComputedStyle(document.documentElement);
    const type: Record<string, string> = {};
    for (const key of Object.keys(TYPE_FALLBACK)) {
      type[key] = resolveVar(styles, `--type-${key}`, TYPE_FALLBACK[key]);
    }
    return {
      node: resolveVar(styles, "--foreground", "#111111"),
      label: resolveVar(styles, "--muted-foreground", "#11111199"),
      edge: resolveVar(styles, "--border", "#11111114"),
      accent: resolveVar(styles, "--ring", "#2563eb"),
      type,
    };
    // resolved / focusMode 是 CSS 变量变化的失效信号，必须保留依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, focusMode]);
}

const TYPE_LABEL: Record<string, string> = {
  entity: "pageTypes.entity", concept: "pageTypes.concept", source: "pageTypes.source", query: "pageTypes.query", overview: "pageTypes.overview",
};

/**
 * 关系网络视图。
 *
 * 节点位置、类型与边都来自知识库索引。初始视口自动适配，选择节点后只强调
 * 直接关联和两跳邻域，避免装饰动画与常驻标签干扰阅读。
 */
export function GraphWorkspace() {
  const { t } = useI18n();
  const { resolved, focusMode } = useTheme();
  const reducedMotion = useReducedMotion();
  const colors = useCanvasColors(resolved, focusMode);
  const { dataVersion } = useAppData();
  const { data, loading, error } = useApi<GraphData>("/api/graph", [dataVersion]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [hiddenTypes, setHiddenTypes] = React.useState<Set<string>>(new Set());
  const graphRef = React.useRef<{
    centerAt: (x: number, y: number, ms: number) => void;
    zoom: (k: number, ms: number) => void;
    zoomToFit: (ms: number, px: number) => void;
    d3Force: (name: string) => { distance?: (value: number) => unknown; strength?: (value: number) => unknown } | undefined;
  } | null>(null);
  const graphContainerRef = React.useRef<HTMLDivElement | null>(null);
  const [graphSize, setGraphSize] = React.useState({ width: 0, height: 0 });
  const previousGraphSize = React.useRef({ width: 0, height: 0 });
  const [forcesReady, setForcesReady] = React.useState(false);
  const fitPending = React.useRef(false);

  React.useEffect(() => {
    // 空库会卸载画布；之后重新导入时，新实例仍需先配置力参数。
    if (data?.nodes.length === 0) setForcesReady(false);
  }, [data?.nodes.length]);

  React.useEffect(() => {
    const container = graphContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setGraphSize({ width, height });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [data?.nodes.length]);

  // 尺寸变化后重新适配当前画布。仅更新 canvas 宽高会让原来的平移/缩放沿用，
  // 小屏时节点可能全落在视口外；等一次布局帧后重新 fit，让图谱始终完整可见。
  React.useEffect(() => {
    const previous = previousGraphSize.current;
    previousGraphSize.current = graphSize;
    if (previous.width === 0 || previous.height === 0 || graphSize.width === 0 || graphSize.height === 0) return;
    if (previous.width === graphSize.width && previous.height === graphSize.height) return;
    const frame = requestAnimationFrame(() => graphRef.current?.zoomToFit(reducedMotion ? 0 : 450, 72));
    return () => cancelAnimationFrame(frame);
  }, [graphSize, reducedMotion]);

  /** 邻域计算：选中节点及其 2 跳内的节点 —— 一次算完，供所有绘制层复用 */
  const neighborhood = React.useMemo(() => {
    if (!data || !selectedId) return { nodes: new Set<string>(), depth: new Map<string, number>() };

    // 邻接表
    const adjacency = new Map<string, Set<string>>();
    for (const link of data.links) {
      const source = typeof link.source === "string" ? link.source : link.source.id;
      const target = typeof link.target === "string" ? link.target : link.target.id;
      if (!adjacency.has(source)) adjacency.set(source, new Set());
      if (!adjacency.has(target)) adjacency.set(target, new Set());
      adjacency.get(source)!.add(target);
      adjacency.get(target)!.add(source);
    }

    const depth = new Map<string, number>([[selectedId, 0]]);
    let frontier = [selectedId];

    for (let hop = 1; hop <= 2; hop++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const neighbor of adjacency.get(node) ?? []) {
          if (!depth.has(neighbor)) {
            depth.set(neighbor, hop);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }

    return { nodes: new Set(depth.keys()), depth };
  }, [data, selectedId]);

  const visible = React.useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    const nodes = data.nodes.filter((n) => !hiddenTypes.has(n.type));
    const ids = new Set(nodes.map((n) => n.id));
    const links = data.links.filter((l) => {
      const source = typeof l.source === "string" ? l.source : l.source.id;
      const target = typeof l.target === "string" ? l.target : l.target.id;
      return ids.has(source) && ids.has(target);
    });
    return { nodes, links };
  }, [data, hiddenTypes]);

  // 新数据到达后等力导向布局停止，再适配视口，避免节点继续移动后被裁切。
  React.useEffect(() => {
    if (visible.nodes.length === 0) return;
    fitPending.current = true;
  }, [visible]);

  const selectedNode = React.useMemo(
    () => data?.nodes.find((n) => n.id === selectedId) ?? null,
    [data, selectedId],
  );

  const selectedLinks = React.useMemo(() => {
    if (!data || !selectedId) return [];
    return data.links
      .filter((l) => {
        const source = typeof l.source === "string" ? l.source : l.source.id;
        const target = typeof l.target === "string" ? l.target : l.target.id;
        return source === selectedId || target === selectedId;
      })
      .slice(0, 12);
  }, [data, selectedId]);

  const typeCounts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const node of data?.nodes ?? []) map.set(node.type, (map.get(node.type) ?? 0) + 1);
    return map;
  }, [data]);

  const selectNode = (id: string | null) => {
    setSelectedId(id);
    const node = visible.nodes.find(node => node.id === id);
    if (node?.x !== undefined && node.y !== undefined) {
      graphRef.current?.centerAt(node.x, node.y, reducedMotion ? 0 : 600);
      graphRef.current?.zoom(2.4, reducedMotion ? 0 : 600);
    }
  };

  return (
    <div className="flex h-[calc(100dvh-3rem)] min-h-0 flex-col overflow-hidden md:h-dvh">
      <div className="shrink-0">
      <PageHeader
        title={t("graph_workspace.m001")}
        compact
        meta={
          data && (
            <>
              <Badge tone="neutral">{data.stats.pages} {t("graph_workspace.m002")}</Badge>
              <Badge tone="neutral">{data.stats.edges} {t("graph_workspace.m003")}</Badge>
              {data.stats.orphans > 0 && <Badge tone="warning">{data.stats.orphans} {t("graph_workspace.m004")}</Badge>}
              {data.truncated && <Badge tone="warning">{t("graph_workspace.m005")}</Badge>}
            </>
          )
        }
        actions={
          <>
            <div className="hidden items-center gap-1.5 md:flex">
              {Object.entries(TYPE_LABEL).map(([type, label]) => {
                const count = typeCounts.get(type) ?? 0;
                if (count === 0) return null;
                const hidden = hiddenTypes.has(type);
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() =>
                      setHiddenTypes((prev) => {
                        const next = new Set(prev);
                        if (next.has(type)) next.delete(type);
                        else next.add(type);
                        return next;
                      })
                    }
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition-all duration-150",
                      hidden
                        ? "border-[var(--border)] text-muted-foreground opacity-50"
                        : "border-[var(--border)] text-foreground",
                    )}
                    aria-pressed={!hidden}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: hidden ? "var(--muted-foreground)" : colors.type[type] }}
                    />
                    {t(label)}
                    <span className="tabular-nums text-muted-foreground">{count}</span>
                  </button>
                );
              })}
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={<Filter size={13} />}
              onClick={() => {
                setSelectedId(null);
                graphRef.current?.zoomToFit(reducedMotion ? 0 : 600, 72);
              }}
            >
              {t("graph_workspace.m006")}</Button>
          </>
        }
      />
      </div>

      <div className="relative mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-3 py-3 md:px-5 md:py-4">
        {loading && !data && (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Spinner size={18} />
          </div>
        )}

        {error && !data && (
          <Card className="p-4">
            <p className="text-[13px] text-[var(--destructive)]">{error}</p>
          </Card>
        )}

        {data && data.nodes.length === 0 && (
          <Card className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={<Network size={30} strokeWidth={1.3} />}
              title={t("graph_workspace.m007")}
              description={t("graph_workspace.m008")}
              action={
                <Link href="/wiki" className="inline-flex h-11 items-center justify-center rounded-full bg-primary px-4 text-[14px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 sm:h-9 sm:text-[13px]">
                  {t("graph_workspace.m009")}</Link>
              }
            />
          </Card>
        )}

        {data && data.nodes.length > 0 && (
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,40dvh)] gap-2 lg:grid-cols-[minmax(0,1fr)_300px] lg:grid-rows-1 lg:gap-3">
            <Card
              className="relative min-h-0 overflow-hidden p-0"
              style={{
                backgroundImage: "radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--border) 65%, transparent) 1px, transparent 0)",
                backgroundSize: "24px 24px",
              }}
            >
              <div ref={graphContainerRef} className="absolute inset-0">
              {graphSize.width > 0 && graphSize.height > 0 && <ForceGraph2D
                ref={graphRef as never}
                width={graphSize.width}
                height={graphSize.height}
                graphData={visible}
                backgroundColor="transparent"
                nodeRelSize={3.8}
                // 先设置力参数，再触发预计算；不能在预计算之后才调力并直接停帧。
                warmupTicks={forcesReady ? (reducedMotion ? 160 : 50) : 0}
                cooldownTicks={forcesReady && !reducedMotion ? 110 : 0}
                d3AlphaDecay={0.035}
                d3VelocityDecay={0.38}
                onEngineStop={() => {
                  if (!forcesReady) {
                    const linkForce = graphRef.current?.d3Force("link");
                    const chargeForce = graphRef.current?.d3Force("charge");
                    linkForce?.distance?.(92);
                    chargeForce?.strength?.(-150);
                    setForcesReady(true);
                    return;
                  }
                  if (fitPending.current) {
                    fitPending.current = false;
                    requestAnimationFrame(() => {
                      requestAnimationFrame(() => graphRef.current?.zoomToFit(reducedMotion ? 0 : 650, 72));
                    });
                  }
                }}
                onNodeClick={((raw: unknown) => {
                  // 库的泛型签名较松，这里收窄成我们自己的节点类型
                  const node = raw as GraphNode;
                  selectNode(selectedId === node.id ? null : node.id);
                }) as never}
                onBackgroundClick={() => setSelectedId(null)}
                /* ---------- 节点：克制的类型色与邻域强调 ---------- */
                nodeCanvasObject={((raw: unknown, ctx: CanvasRenderingContext2D, scale: number) => {
                  const node = raw as GraphNode;
                  const inNeighborhood = neighborhood.depth.has(node.id);
                  const isSelected = node.id === selectedId;
                  const isDimmed = selectedId !== null && !inNeighborhood;

                  ctx.globalAlpha = isDimmed ? 0.13 : inNeighborhood ? 1 : 0.78;
                  const baseRadius = 3.1 + Math.min(node.degree, 10) * 0.42;
                  // 自动适配一两个节点时缩放倍率很大；限制屏幕尺寸，避免巨大的色块。
                  const radius = Math.min(isSelected ? baseRadius * 1.35 : baseRadius, (isSelected ? 10 : 8) / scale);

                  if (isSelected) {
                    ctx.beginPath();
                    ctx.arc(node.x!, node.y!, radius + 5 / scale, 0, 2 * Math.PI);
                    ctx.fillStyle = withAlpha(colors.accent, 0.12);
                    ctx.fill();
                  }

                  ctx.beginPath();
                  ctx.arc(node.x!, node.y!, radius, 0, 2 * Math.PI);
                  ctx.fillStyle = isSelected ? colors.accent : colors.type[node.type] ?? colors.node;
                  ctx.fill();

                  ctx.globalAlpha = 1;

                  // 只在选中或放大查看高关联节点时显示标签，防止整团文字重叠。
                  const showLabel = isSelected || (scale > 1.28 && node.degree > 1);
                  if (showLabel) {
                    const fontSize = (isSelected ? 12 : 10.5) / scale;
                    ctx.font = `${isSelected ? "600 " : ""}${fontSize}px -apple-system, "PingFang SC", sans-serif`;
                    ctx.textAlign = "center";
                    ctx.textBaseline = "top";
                    ctx.fillStyle = isDimmed
                      ? withAlpha(colors.label, 0.2)
                      : isSelected
                        ? colors.accent
                        : colors.label;
                    const label =
                      node.title.length > 10 ? `${node.title.slice(0, 9)}…` : node.title;
                    ctx.fillText(label, node.x!, node.y! + radius + 3 / scale);
                  }
                }) as never}
                nodePointerAreaPaint={((raw: unknown, color: string, ctx: CanvasRenderingContext2D, scale: number) => {
                  const node = raw as GraphNode;
                  const base = 3.1 + Math.min(node.degree, 10) * 0.42;
                  const selected = node.id === selectedId;
                  const radius = Math.min(selected ? base * 1.35 : base, (selected ? 10 : 8) / scale);
                  // 命中区跟随实际画出的节点，再留一点余量，不能沿用无限放大的默认圆。
                  ctx.beginPath();
                  ctx.arc(node.x!, node.y!, radius + 4 / scale, 0, 2 * Math.PI);
                  ctx.fillStyle = color;
                  ctx.fill();
                }) as never}
                /* ---------- 边手绘：常态极淡，邻域内升为蓝 ---------- */
                linkCanvasObject={((raw: unknown, ctx: CanvasRenderingContext2D, scale: number) => {
                  const link = raw as GraphLink;
                  const source = typeof link.source === "string" ? null : link.source;
                  const target = typeof link.target === "string" ? null : link.target;
                  if (!source || !target || source.x === undefined || target.x === undefined) return;

                  const touchesSelection =
                    selectedId !== null &&
                    (source.id === selectedId || target.id === selectedId);
                  const inNeighborhood =
                    selectedId !== null &&
                    neighborhood.nodes.has(source.id) &&
                    neighborhood.nodes.has(target.id);
                  const dimmed = selectedId !== null && !touchesSelection && !inNeighborhood;

                  ctx.beginPath();
                  ctx.moveTo(source.x, source.y!);
                  ctx.lineTo(target.x, target.y!);

                  if (touchesSelection) {
                    ctx.strokeStyle = withAlpha(colors.accent, 0.6);
                    ctx.lineWidth = (1 + link.weight * 0.8) / scale;
                  } else if (dimmed) {
                    // 绝对值语义：withAlpha 是「把 alpha 设成这个数」，不是乘法。
                    // colors.edge 已经被 resolveVar 规范化成 rgba(17,17,17,0.08)，
                    // 传 0.5 会得到 6 倍于常态边的黑度 —— 淡化反而成了强调。
                    ctx.strokeStyle = withAlpha(colors.edge, 0.04);
                    ctx.lineWidth = 0.6 / scale;
                  } else {
                    ctx.strokeStyle = colors.edge;
                    ctx.lineWidth = (0.6 + link.weight * 0.5) / scale;
                  }
                  ctx.stroke();

                }) as never}
                linkCanvasObjectMode={() => "replace"}
                enableNodeDrag
                enablePanInteraction
                enableZoomInteraction
              />}
              </div>

              {/* 图例 */}
              <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 rounded-full border border-border bg-[color-mix(in_srgb,var(--card)_92%,transparent)] px-3 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm">
                <span className="hidden sm:inline">{t("graph_workspace.m010")}</span>
                <span className="hidden h-3 w-px bg-[var(--border)] sm:block" />
                <span>{t("graph_workspace.m011")}</span>
              </div>

              {data.note && (
                <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] px-2.5 py-1 text-[11px] text-[var(--warning)]">
                  <Info size={10} />
                  {data.note}
                </div>
              )}
            </Card>

            {/* 侧栏：选中节点的联动面板 */}
            <div className="min-h-0 space-y-2 overflow-y-auto lg:space-y-3">
              <div className="px-1">
                <label htmlFor="graph-node" className="mb-1.5 block text-[12px] font-medium text-muted-foreground">{t("graph_workspace.m012")}</label>
                <Select id="graph-node" value={selectedId ?? ""} onChange={event => selectNode(event.target.value || null)}>
                  <option value="">{t("graph_workspace.m013")}</option>
                  {visible.nodes.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}
                </Select>
              </div>
              {selectedNode ? (
                <Card className="panel-in p-4 max-lg:bg-[color-mix(in_srgb,var(--card)_94%,transparent)]">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[14px] font-medium text-foreground [overflow-wrap:anywhere]">{selectedNode.title}</p>
                      <div className="mt-1"><TypeBadge type={selectedNode.type} /></div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedId(null)}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--muted)] hover:text-foreground"
                      aria-label={t("graph_workspace.m014")}
                    >
                      <X size={12} />
                    </button>
                  </div>

                  <Hairline className="mb-3" />

                  <div className="space-y-1.5 text-[12px]">
                    <Row label={t("graph_workspace.m015")} value={String(selectedNode.degree)} />
                    <Row
                      label={t("graph_workspace.m016")}
                      value={t("graph_workspace.m017", {v0: Math.max(0, neighborhood.nodes.size - 1)})}
                    />
                    <Row label={t("graph_workspace.m018")} value={String(selectedLinks.length)} />
                  </div>

                  {selectedLinks.length > 0 && (
                    <div className="mt-3 border-t border-border pt-3">
                      <p className="mb-1.5 text-[11.5px] font-semibold tracking-[0.08em] text-muted-foreground">
                        {t("graph_workspace.m019")}</p>
                      <div className="space-y-1">
                        {selectedLinks.map((link) => {
                          const source = typeof link.source === "string" ? link.source : link.source.id;
                          const target = typeof link.target === "string" ? link.target : link.target.id;
                          const otherId = source === selectedId ? target : source;
                          const other = data.nodes.find((n) => n.id === otherId);
                          if (!other) return null;
                          return (
                            <button
                              key={link.id}
                              type="button"
                              onClick={() => selectNode(otherId)}
                              className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-[var(--muted)]"
                            >
                              <span className="truncate text-foreground">{other.title}</span>
                              {link.signals?.occurrences && link.signals.occurrences > 1 && (
                                <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                                  ×{link.signals.occurrences}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <Link href={`/wiki/${selectedNode.id}`} className="mt-4 flex h-11 w-full items-center justify-center rounded-full border border-border bg-card px-3 text-[14px] font-medium text-foreground transition-colors hover:bg-muted sm:h-7 sm:text-[12px]">
                    {t("graph_workspace.m020")}</Link>
                </Card>
              ) : (
                <Card className="p-4 max-lg:bg-[color-mix(in_srgb,var(--card)_94%,transparent)]">
                  <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                    {t("graph_workspace.m021")}</p>
                </Card>
              )}

              <Card className="p-4 max-lg:bg-[color-mix(in_srgb,var(--card)_94%,transparent)]">
                <p className="mb-2 text-[11.5px] font-semibold tracking-[0.08em] text-muted-foreground">
                  {t("graph_workspace.m022")}</p>
                <div className="space-y-1.5 text-[12px]">
                  <Row label={t("graph_workspace.m023")} value={String(data.stats.pages)} />
                  <Row label={t("graph_workspace.m024")} value={String(data.stats.edges)} />
                  <Row
                    label={t("graph_workspace.m025")}
                    value={String(data.stats.orphans)}
                    warn={data.stats.orphans > 0}
                  />
                  <Row
                    label={t("graph_workspace.m026")}
                    value={String(data.stats.dangling)}
                    warn={data.stats.dangling > 0}
                  />
                </div>
                {(data.stats.orphans > 0 || data.stats.dangling > 0) && (
                  <Link href="/review" className="mt-3 flex h-11 w-full items-center justify-center rounded-full px-3 text-[14px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:h-7 sm:text-[12px]">
                    {t("graph_workspace.m027")}</Link>
                )}
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums", warn ? "text-[var(--warning)]" : "text-foreground")}>
        {value}
      </span>
    </div>
  );
}
