"use client";
import { useI18n } from "@/components/i18n-provider";

import { useIngest } from "@/components/ingest/ingest-provider";
import { cn } from "@/lib/utils";

/**
 * 后台导入的指示器。
 *
 * 为什么必须存在：导入是分钟级的，而用户不该被扣在那个抽屉里。任务状态住在
 * IngestProvider 里，抽屉关掉之后总得有个地方能看见它 —— 否则「可以关掉窗口」
 * 就变成了「关掉之后就再也找不到进度了」。
 *
 * 三种状态各说一句话，都不是装饰：跑着（还差多少）、待审（该你了）、
 * 上次没成（可以重来）。没有任务时整块不渲染，不占位置。
 */
export function IngestIndicator() {
  const { t, locale } = useI18n();
  const { phase, progress, stage, stageLabel, error, openDrawer } = useIngest();
  const currentStageLabel = locale === "en" && t.has("stages." + stage) ? t("stages." + stage) : stageLabel;

  const running = phase === "running";
  // 只有三种情况值得占位置：跑着、等你审、上一次没成。
  // done / duplicate 都是「已经看完结论」的状态，抽屉正开着，不必再挂一个指示器。
  const visible = running || phase === "review" || (phase === "idle" && Boolean(error));
  if (!visible) return null;
  const label = running
    ? `${currentStageLabel || t("layout_sidebar.m029")} ${Math.round(progress)}%`
    : phase === "review"
      ? t("layout_sidebar.m030")
      : t("layout_sidebar.m031");

  // 整行可点，打开抽屉 —— 停止是抽屉里的动作，栏底只显示进度。
  // 在 60px 宽的折叠栏里塞进第二个按钮，误点的代价是丢掉几分钟的工作。
  return (
    <button
      type="button"
      onClick={openDrawer}
      title={label}
      className="flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-[var(--muted)] hover:text-foreground"
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          running && "animate-pulse",
        )}
        style={{
          background: running ? "var(--ring)" : phase === "review" ? "var(--warning)" : "var(--destructive)",
        }}
        aria-hidden
      />
      <span className="sidebar-label min-w-0 flex-1 truncate">{label}</span>
      {running && (
        <span className="sidebar-label h-1 w-8 shrink-0 overflow-hidden rounded-full bg-[var(--muted)]">
          <span
            className="block h-full origin-left rounded-full bg-[var(--ring)] transition-transform duration-500 ease-out"
            style={{ transform: `scaleX(${Math.max(0, Math.min(100, progress)) / 100})` }}
          />
        </span>
      )}
    </button>
  );
}
