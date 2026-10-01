"use client";

import { Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { ReviewOption } from "@/lib/review/questions";

/** 用户对一条事项的回答：选了某个选项，或者自己写了一段话 */
export type AnswerDraft = { answer: string; choiceId: string | null };

/**
 * 一个处理问题 + 候选方向 + 一个批注框。
 *
 * 这是交互式确认的入口：模型在报问题的同时给出几个可点选的答案，用户选一个
 * 或写一段批注，之后统一通过卡片上的提交按钮交给模型处理。
 *
 * 三条交互纪律：
 *
 * ① **选项与自由输入互斥**：选了选项就清空输入框，写了字就取消选中。两者同时
 *    有值时「用户到底想要哪个」是歧义的，服务端的归一化只能替用户猜 —— 而那
 *    恰恰是最不该猜的地方。
 *
 * ② **选中项的 impact 内联显示**，不塞进 title 悬停提示：触屏和键盘用户看不到
 *    悬停，而「选了会发生什么」正是他做决定的主要依据。
 *
 * ③ 选择只更新当前草稿，不会立即发请求；导入与体检都由各自的提交动作统一保存。
 */
export function QuestionPicker({
  question,
  options,
  value,
  onChange,
  disabled = false,
}: {
  question: string;
  options: ReviewOption[];
  value: AnswerDraft;
  /** 每次改动都调。用于即时回显 */
  onChange: (next: AnswerDraft) => void;
  disabled?: boolean;
}) {
  const selected = options.find((option) => option.id === value.choiceId) ?? null;

  return (
    <div className="mt-3 rounded-[16px] bg-background p-3">
      <p className="text-[12.5px] font-medium leading-relaxed text-foreground">
        {question}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={question}>
        {options.map((option) => {
          const active = value.choiceId === option.id;
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() =>
                onChange(
                  active
                    ? { answer: "", choiceId: null }
                    : { answer: option.label, choiceId: option.id },
                )
              }
              className={cn(
                "rounded-full border px-3 py-1.5 text-[12.5px] transition-colors duration-150 disabled:opacity-50",
                active
                  ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
                  : "border-[var(--border)] text-muted-foreground hover:border-[var(--input)] hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {selected?.impact && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {selected.impact}
        </p>
      )}

      <Textarea
        className="mt-2"
        rows={2}
        disabled={disabled}
        // 选中选项时输入框显示为空 —— 那两个值不该同时出现在眼前
        value={value.choiceId ? "" : value.answer}
        placeholder="或写下你希望如何处理…"
        aria-label={`${question}：自由回答`}
        maxLength={500}
        onChange={(event) => onChange({ answer: event.target.value, choiceId: null })}
      />
    </div>
  );
}
