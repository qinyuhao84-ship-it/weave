"use client";

import { useI18n } from "@/components/i18n-provider";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 基础 UI 原子组件。
 *
 * 全部严格遵循 design/design-dna.json 里的令牌，不引入设计系统之外的值。
 * 三条纪律在每个组件里都成立：
 *   1. 主色是近黑 #111，交互外框用中性色，蓝色外框只用于等待回答
 *   2. 分层靠 1px 发丝边框，不靠阴影
 *   3. 圆角三档分工：pill 给按钮徽章、16px 给面板、22px 给卡片
 */

/* ------------------------------------------------------------------ 按钮 */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  /** 加载态：显示边框扫光而不是 spinner */
  loading?: boolean;
  icon?: React.ReactNode;
};

export function Button({
  className,
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const variants = {
    // 主按钮带内压印阴影与点击缩放 —— 物理反馈是这套 DNA 的手感来源
    primary:
      "bg-primary text-primary-foreground shadow-inset hover:bg-primary/90 active:scale-[0.98]",
    secondary:
      "bg-card text-foreground border border-border hover:bg-muted active:scale-[0.98]",
    ghost: "text-muted-foreground hover:text-foreground hover:bg-muted",
    danger:
      "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:scale-[0.98]",
  }[variant];

  const sizes = {
    sm: "h-11 sm:h-7 px-3 text-[14px] sm:text-[12px] gap-1.5",
    md: "h-11 sm:h-9 px-4 text-[14px] sm:text-[13px] gap-2",
    lg: "h-11 px-6 text-[14px] gap-2",
  }[size];

  return (
    <button
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-full font-medium",
        "transition-[color,background-color,border-color,transform,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-40",
        variants,
        sizes,
        className,
      )}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Spinner size={size === "lg" ? 14 : 12} /> : icon}
      {children}
    </button>
  );
}

/** 轻量加载指示器。用于按钮内联，不用于大块等待态（那里用边框扫光）。 */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={cn("animate-spin shrink-0", className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ 卡片 */

export function Card({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-[22px] border border-border bg-card", className)}
      {...props}
    >
      {children}
    </div>
  );
}

/** 嵌套在卡片里的次级面板 —— 用页面底色制造「凹陷」而不是「凸起」 */
export function InsetPanel({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-[16px] border border-border bg-background p-4", className)}
      {...props}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ 徽章 */

export type PageType = "entity" | "concept" | "source" | "query" | "overview";

const TYPE_META: Record<PageType, { label: string; color: string }> = {
  entity: { label: "pageTypes.entity", color: "var(--type-entity)" },
  concept: { label: "pageTypes.concept", color: "var(--type-concept)" },
  source: { label: "pageTypes.source", color: "var(--type-source)" },
  query: { label: "pageTypes.query", color: "var(--type-query)" },
  overview: { label: "pageTypes.overview", color: "var(--type-overview)" },
};

/**
 * 词条类型徽章。
 * 用 pill + 10% 透明底 + 语义色文字，不用饱和色块填满 —— 那会破坏全站的色彩纪律。
 */
export function TypeBadge({
  type,
  className,
  showDot = true,
}: {
  type: string;
  className?: string;
  showDot?: boolean;
}) {
  const { t } = useI18n();
  const meta = TYPE_META[type as PageType] ?? { label: type, color: "var(--muted-foreground)" };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-[2px] text-[11.5px] font-medium leading-none",
        className,
      )}
      style={{
        color: meta.color,
        background: `color-mix(in srgb, ${meta.color} 10%, transparent)`,
      }}
    >
      {showDot && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: meta.color }}
          aria-hidden
        />
      )}
      {t.has(meta.label) ? t(meta.label) : meta.label}
    </span>
  );
}

/** 通用徽章 —— 用于计数、状态等 */
export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  className?: string;
}) {
  const tones = {
    neutral: "text-muted-foreground bg-[var(--muted)]",
    accent: "text-[color-mix(in_srgb,var(--ring)_80%,var(--foreground))] bg-[color-mix(in_srgb,var(--ring)_10%,transparent)]",
    success: "text-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)]",
    warning: "text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]",
    danger: "text-[var(--destructive)] bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)]",
  }[tone];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[11.5px] font-medium leading-none tabular-nums",
        tones,
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ 输入 */

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-11 sm:h-9 w-full rounded-md border border-[var(--input)] bg-card px-3 text-base sm:text-[13px]",
        "placeholder:text-muted-foreground transition-colors duration-150",
        "focus:border-[var(--focus-ring)]",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-md border border-[var(--input)] bg-card px-3 py-2 text-base sm:text-[13px] leading-relaxed",
        "placeholder:text-muted-foreground transition-colors duration-150",
        "focus:border-[var(--focus-ring)] resize-none",
        className,
      )}
      {...props}
    />
  );
}

/** 下拉选择。原生 select 保持键盘可达性，只做样式覆盖。 */
export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-11 sm:h-9 w-full appearance-auto rounded-md border border-[var(--input)] bg-card px-3 pr-8 text-base sm:text-[13px]",
        "transition-colors duration-150 focus:border-[var(--focus-ring)]",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

/* -------------------------------------------------------------- 分隔与标签 */

export function Hairline({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-[var(--border)]", className)} />;
}

export function Label({
  children,
  hint,
  className,
  htmlFor,
}: {
  children: React.ReactNode;
  hint?: string;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn("mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1", className)}>
      <label htmlFor={htmlFor} className="shrink-0 text-[12px] font-semibold tracking-[0.06em] text-foreground">
        {children}
      </label>
      {hint && <span className="text-[11.5px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ 开关 */

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[22px] w-[38px] shrink-0 rounded-full border transition-colors duration-200",
        checked ? "border-transparent bg-primary" : "border-[var(--input)] bg-[var(--muted)]",
        disabled && "opacity-40",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] h-[16px] w-[16px] rounded-full bg-card shadow-ambient transition-transform duration-200",
          checked ? "translate-x-[19px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ 空态 */

/**
 * 空状态。
 * 文案纪律：给出下一步动作，不说「暂无数据」。
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-16 text-center", className)}>
      {icon && <div className="mb-4 text-muted-foreground opacity-60">{icon}</div>}
      <p className="text-[15px] font-medium text-foreground">{title}</p>
      {description && (
        <p className="mt-2 max-w-md text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ AI 工作态 */

/**
 * 「AI 正在工作」的容器。
 *
 * 工作态使用 1.5px 边框扫光；聊天等待用蓝色，其他任务用中性色。
 * 机制是双层背景 —— 内层用卡片色填满 padding-box 遮住中间，
 * 外层 conic-gradient 只在 border-box 的边框区域可见。
 * 比任何 spinner 都高级，而且它只在 AI 真的工作时出现，
 * 于是「看到蓝光」就等同于「系统在为我干活」。
 */
export function AiWorkingFrame({
  children,
  working,
  className,
  tone = "neutral",
}: {
  children: React.ReactNode;
  working: boolean;
  className?: string;
  tone?: "neutral" | "answer";
}) {
  return (
    <div
      className={cn(working && "ai-working", "rounded-[16px]", className)}
      data-working-tone={tone}
      {...(working ? { "aria-busy": true } : {})}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ 进度 */

/**
 * 进度条。
 *
 * 现状是实色填充 + 宽度过渡，**没有**用 DNA 里的 shimmer 扫光 ——
 * 早先的注释声称用了，但实现从来不是那样，那条注释还引用了已删除的 .shimmer 类。
 * 两个待办留到 UI 批次一起做：
 *   ① 扫光按 design-dna 的 aiToolScan 定义做成独立的渐变叠加层，用 transform 位移驱动，
 *      不要去动画 background-position（那是主线程重绘）；
 *   ② 把 width 过渡换成 transform: scaleX + origin-left —— 现在动 width 会触发重排。
 */
export function ProgressBar({
  value,
  max = 100,
  label,
  className,
}: {
  value: number;
  max?: number;
  label?: string;
  className?: string;
}) {
  const percent = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={cn("w-full", className)}>
      {label && (
        <div className="mb-1.5 flex items-baseline justify-between text-[12px]">
          <span className="text-foreground">{label}</span>
          <span className="tabular-nums text-muted-foreground">{Math.round(percent)}%</span>
        </div>
      )}
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-[var(--muted)]"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(label ? { "aria-label": label } : {})}
      >
        {/* 用 scaleX 而不是 width：width 每帧都要重排，scaleX 交给合成器。
            4px 高的圆角在横向缩放下的形变肉眼看不出来。 */}
        <div
          className="h-full origin-left rounded-full bg-primary transition-transform duration-500 ease-out"
          style={{ transform: `scaleX(${percent / 100})` }}
        />
      </div>
    </div>
  );
}

/**
 * 环形进度 —— 用于导入解析这类需要强调「正在进行」的场景。
 *
 * tone 决定前景弧的颜色，默认仍是 --ring（蓝）。
 * ⚠️ 蓝色在本 DNA 里被限定给「焦点环」与「AI 正在工作」两件事，别拿它做一般的
 * 状态指示 —— 那会稀释这道光的含义。表达状态请用 neutral / warning / danger。
 */
export function ProgressRing({
  value,
  size = 28,
  strokeWidth = 2,
  tone = "accent",
  className,
}: {
  value: number;
  size?: number;
  strokeWidth?: number;
  tone?: "accent" | "neutral" | "warning" | "danger";
  className?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(1, value / 100)));
  const stroke = {
    accent: "var(--ring)",
    neutral: "var(--foreground)",
    warning: "var(--warning)",
    danger: "var(--destructive)",
  }[tone];

  return (
    <svg
      width={size}
      height={size}
      className={cn("-rotate-90", className)}
      // 装饰性：旁边一定有文字把百分比说出来，读屏器重复念一遍是噪音
      aria-hidden
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--border)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        style={{ transition: "stroke-dashoffset 400ms cubic-bezier(0.4, 0, 0.2, 1)" }}
      />
    </svg>
  );
}
