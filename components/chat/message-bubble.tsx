"use client";
import * as React from "react";
import { BookMarked } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { Badge } from "@/components/ui";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import type { WikilinkResolver } from "@/lib/markdown/wikilink-plugin";
import { cn, truncate } from "@/lib/utils";
import { WaitingStatus } from "./waiting-status";
import { ArtifactCard, ArtifactPlaceholder } from "./artifact-card";
import type { Citation, Message } from "./types";

/**
 * 回答上方那一行小字。
 *
 * 存在的理由只有一个：**它必须始终在、且高度固定**。
 * 流式时它写「正在检索 / 正在生成」，完成后它写引用统计 —— 同一行、同一高度，
 * 所以正文的起始位置从等待到落定始终不动。这正是「生成回答时跳一下」的解法：
 * 不是把动画调快，而是让状态切换根本不改变布局。
 *
 * 用 h-5 钉死高度、truncate 保证不换行：换行会让高度重新变成变量，
 * 那就等于把刚修好的坑又挖回来。
 */
function AnswerMeta({
  working = false,
  label,
  parts,
}: {
  working?: boolean;
  /** 流式状态下的那句话 */
  label?: string;
  /** 完成后的统计片段，用 · 连接 */
  parts?: React.ReactNode[];
}) {
  return (
    <div className="mb-2 flex h-5 items-center gap-1.5 text-[11.5px] text-muted-foreground">
      {working ? (
        <>
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--ring)]" aria-hidden />
          <span className="truncate">{label}</span>
        </>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {(parts ?? []).map((part, index) => (
            <React.Fragment key={index}>
              {index > 0 && <span aria-hidden>·</span>}
              {part}
            </React.Fragment>
          ))}
        </span>
      )}
    </div>
  );
}

export const MessageBubble = React.memo(function MessageBubble({
  message,
  animate,
  resolveWikilink,
  onCitationClick,
  onFile,
  onNavigate,
  working,
}: {
  message: Message;
  /** 这条消息是不是刚出现。false = 它已经在屏幕上待过了，别重播入场动效 */
  animate: boolean;
  /** 必须引用稳定：换个函数身份，这条消息的 markdown 就整篇重解析 */
  resolveWikilink: WikilinkResolver;
  onCitationClick: (citation: Citation) => void;
  onFile: (messageId: string) => void;
  onNavigate: (pageId: string) => void;
  working: boolean;
}) {
  const { t } = useI18n();
  const citations = React.useMemo(() => message.citations?.list ?? [], [message.citations?.list]);
  const quality = message.citations?.quality;

  const citationMap = React.useMemo(() => {
    const map = new Map<number, { pageId: string; title: string; sourcePage: number | null }>();
    for (const citation of citations) {
      map.set(citation.index, {
        pageId: citation.pageId,
        title: citation.pageTitle,
        sourcePage: citation.sourcePage,
      });
    }
    return map;
  }, [citations]);

  if (message.role === "user") {
    return (
      <div className={cn("flex justify-end", animate && "msg-in")}>
        <div className="max-w-[85%] rounded-[16px] rounded-br-[6px] bg-primary px-4 py-2.5 text-[13.5px] leading-relaxed text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  // 引用统计放在正文上方的状态行里（与流式时那一行同一个位置），
  // 不再在正文下面另起一个标题行 —— 一屏里两处说同一件事，读起来是噪音。
  const metaParts: React.ReactNode[] = [];
  if (!working && message.interrupted) {
    metaParts.push(
      <span key="interrupted" className="text-[var(--warning)]">
        {t("chat_workspace.m081")}</span>,
    );
  }
  if (!working && citations.length > 0) {
    metaParts.push(t("chat_workspace.m082", {v0: citations.length}));
  } else if (!working && quality?.isNoAnswer) {
    metaParts.push(t("chat_workspace.m083"));
  } else if (!working && message.runStatus !== "failed") {
    metaParts.push(t("chat_workspace.m084"));
  }
  if (message.runStatus === "failed") {
    metaParts.push(
      <span key="failed" className="text-[var(--warning)]">
        {message.runError ? t("chat_workspace.m085", {v0: message.runError}) : t("chat_workspace.m086")}
      </span>,
    );
  }
  if (quality && quality.hallucinationCount > 0) {
    metaParts.push(
      <span key="hallucination" className="text-[var(--warning)]">
        {t("chat_workspace.m087")}{quality.hallucinationCount} {t("chat_workspace.m088")}</span>,
    );
  }

  return (
    <div className={cn("group", animate && "msg-in")}>
      {working && <WaitingStatus createdAt={message.createdAt} hasText={Boolean(message.content.trim())} />}
      {!working && <AnswerMeta parts={metaParts} />}

      {message.content.trim() ? (
      <MarkdownRenderer
        content={message.content}
        resolveWikilink={resolveWikilink}
        // 回答里指向不存在词条的 [[X]] 直接当普通文字：对读者来说
        // 「这个词条还没有」不是他能处理的事，虚线只会让回答看着像坏了
        brokenWikilinks="plain"
        citations={citationMap}
        pendingCitations={working}
        onCitationClick={(index) => {
          const citation = citations.find((c) => c.index === index);
          if (citation) onCitationClick(citation);
        }}
        onWikilinkClick={(pageId) => pageId && onNavigate(pageId)}
        density="conversation"
        className={working ? "streaming-caret" : undefined}
      />
      ) : working ? null : message.interrupted || message.runStatus === "cancelled" ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t("chat_workspace.m089")}</p>
      ) : message.runStatus === "failed" ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t("chat_workspace.m090")}</p>
      ) : (
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t("chat_workspace.m091")}</p>
      )}

      {message.artifacts?.map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} />)}
      {working && message.config?.showMe && !message.artifacts?.length && <ArtifactPlaceholder />}

      {/* 引用列表 */}
      {citations.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex flex-wrap gap-1.5">
            {citations.map((citation) => (
              <button
                key={citation.index}
                type="button"
                onClick={() => onCitationClick(citation)}
                className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11.5px] transition-colors hover:border-[var(--focus-ring)] hover:bg-[var(--muted)]"
              >
                <span className="font-semibold tabular-nums text-[var(--ring)]">
                  {citation.index}
                </span>
                <span className="text-foreground">{truncate(citation.pageTitle, 16)}</span>
                {citation.sourcePage && (
                  <span className="text-muted-foreground">p.{citation.sourcePage}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 回填 wiki */}
      {/* 隐藏用的是父容器的 opacity —— 祖先的 opacity 会乘到整棵子树，
          子元素加 focus-visible:opacity-100 是反超不了的（这是同一个 opacity 的两个层级）。
          键盘用户 Tab 到这个会真的写数据的按钮上时必须能看见它，所以把 focus-within
          加在父容器上。 */}
      <div className="mt-2.5 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {message.filedAsPageId ? (
          <Badge tone="success">
            <BookMarked size={9} />
            {t("chat_workspace.m092")}</Badge>
        ) : (
          <button
            type="button"
            onClick={() => onFile(message.id)}
            className="flex items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <BookMarked size={11} />
            {t("chat_workspace.m093")}</button>
        )}
      </div>
    </div>
  );
});
