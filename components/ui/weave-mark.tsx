import { cn } from "@/lib/utils";

/** 四根交错的线：在交点轮流断开，保留真正的经纬穿插，而不是叠两条斜线。 */
export function WeaveMark({ className, animate = false }: { className?: string; animate?: boolean }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      className={cn("shrink-0", animate && "weave-arrival", className)}
      aria-hidden="true"
    >
      <path pathLength="1" d="M5 21 8 18M12 14 21 5" />
      <path pathLength="1" d="M11 27 20 18M24 14 27 11" />
      <path pathLength="1" d="M5 11 14 20M18 24 21 27" />
      <path pathLength="1" d="M11 5 14 8M18 12 27 21" />
    </svg>
  );
}
