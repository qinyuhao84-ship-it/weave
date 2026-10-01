"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Archive, RotateCcw, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge, Button, Card, EmptyState, Spinner } from "@/components/ui";
import { useAppData } from "@/components/app-provider";
import { apiFetch, useApi } from "@/hooks/use-api";
import { formatDate } from "@/lib/utils";

type TrashData = {
  batches: Array<{ id: string; createdAt: string; pageCount: number; sourceCount: number; archivedFiles: number; restoredAt: string | null }>;
  pages: Array<{ id: string; title: string; deletedAt: string | null; redirectTo: string | null }>;
};

export function TrashWorkspace() {
  const { dataVersion, bumpData } = useAppData();
  const { data, loading, error, refresh } = useApi<TrashData>("/api/vault/trash", [dataVersion]);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const remove = async (kind: "page" | "batch" | "all", id?: string, title?: string) => {
    if (!window.confirm(kind === "all" ? "清空整个回收站？所有项目将无法从回收站恢复。" : `删除“${title}”？该项目将无法从回收站恢复。`)) return;
    setBusyId(id ?? "all"); setActionError(null); setNotice(null);
    try {
      await apiFetch("/api/vault/trash", { method: "DELETE", body: JSON.stringify({ kind, ...(id ? { id } : {}) }) });
      setNotice(kind === "all" ? "回收站已清空。" : "已从回收站删除。");
      bumpData(); await refresh();
    } catch (err) { setActionError(err instanceof Error ? err.message : "删除没有完成。"); }
    finally { setBusyId(null); }
  };

  const restore = async (id: string, kind: "batch" | "page", title: string) => {
    setBusyId(id);
    setActionError(null);
    setNotice(null);
    try {
      await apiFetch(kind === "batch" ? `/api/vault/trash/batches/${id}/restore` : `/api/pages/${id}/restore`, { method: "POST" });
      setNotice(kind === "batch" ? `已恢复“${title}”批次。` : `已恢复“${title}”。`);
      bumpData();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "恢复没有完成。");
    } finally {
      setBusyId(null);
    }
  };

  const batches = data?.batches ?? [];
  const pages = data?.pages ?? [];
  return (
    <>
      <PageHeader
        title="回收站"
        description="单条删除的词条与清空知识库时归档的整批资料都会保留在这里。"
        meta={<><Badge tone="neutral">{batches.length} 个归档批次</Badge><Badge tone="neutral">{pages.length} 个已删除词条</Badge></>}
        actions={<><Button size="sm" variant="danger" icon={<Trash2 size={13} />} loading={busyId === "all"} disabled={busyId !== null || !data || batches.length + pages.length === 0} onClick={() => void remove("all")}>清空回收站</Button><Link href="/wiki" className="inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><ArrowLeft size={13} />回到知识库</Link></>}
      />
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-6 md:px-6 md:py-8">
        {actionError && <Card className="border-[color-mix(in_srgb,var(--destructive)_30%,transparent)] p-3.5"><p role="alert" className="text-[12px] text-[var(--destructive)]">{actionError}</p></Card>}
        {notice && <p role="status" className="text-[12px] text-muted-foreground">{notice}</p>}
        {loading && !data ? <div className="flex justify-center py-20"><Spinner size={18} /></div> : error ? (
          <Card className="p-4"><p role="alert" className="text-[12.5px] text-[var(--destructive)]">{error}</p></Card>
        ) : (
          <>
            <section>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-[13px] font-semibold text-foreground">清空归档</h2>
                  <p className="mt-1 text-[11.5px] text-muted-foreground">每次清空都会新建一份完整快照；恢复前会检查同名文件，避免覆盖新资料。</p>
                </div>
              </div>
              {batches.length === 0 ? (
                <Card className="p-5"><EmptyState icon={<Archive size={24} />} title="还没有归档批次" description="清空知识库时，当前词条、原始资料和解析稿会先存入这里。" /></Card>
              ) : (
                <Card className="divide-y divide-[var(--border)]">
                  {batches.map((batch) => (
                    <div key={batch.id} className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between md:px-5">
                      <div className="min-w-0">
                        <p className="text-[12.5px] font-medium text-foreground">知识库快照 · {formatDate(batch.createdAt)}</p>
                        <p className="mt-1 break-all font-mono text-[10.5px] text-muted-foreground">批次 {batch.id}</p>
                        <p className="mt-1 text-[11.5px] text-muted-foreground">{batch.pageCount} 个词条 · {batch.sourceCount} 份原始资料 · {batch.archivedFiles} 个文件</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {batch.restoredAt ? <Badge tone="success">已恢复</Badge> : (
                          <Button
                            size="sm"
                            icon={<RotateCcw size={12} />}
                            loading={busyId === batch.id}
                            disabled={busyId !== null}
                            onClick={() => void restore(batch.id, "batch", `知识库快照 · ${formatDate(batch.createdAt)}`)}
                          >恢复整批</Button>
                        )}
                        <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} disabled={busyId !== null} onClick={() => void remove("batch", batch.id, `知识库快照 · ${formatDate(batch.createdAt)}`)}>删除批次</Button>
                      </div>
                    </div>
                  ))}
                </Card>
              )}
            </section>

            <section>
              <div className="mb-3">
                <h2 className="text-[13px] font-semibold text-foreground">已删除词条</h2>
                <p className="mt-1 text-[11.5px] text-muted-foreground">这些词条仍保留在回收站，可单独恢复。</p>
              </div>
              {pages.length === 0 ? (
                <Card className="px-4 py-5 text-[11.5px] text-muted-foreground">没有单独删除的词条。</Card>
              ) : (
                <Card className="divide-y divide-[var(--border)]">
                  {pages.map((page) => (
                    <div key={page.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 md:px-5">
                      <div className="min-w-0">
                        <p className="break-words text-[12.5px] font-medium text-foreground">{page.title}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">{page.deletedAt ? `删除于 ${formatDate(page.deletedAt)}` : "已删除"}{page.redirectTo ? " · 曾合并到其他词条" : ""}</p>
                      </div>
                      <div className="flex shrink-0 gap-2"><Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} loading={busyId === page.id} disabled={busyId !== null} onClick={() => void restore(page.id, "page", page.title)}>恢复词条</Button><Button size="sm" variant="ghost" icon={<Trash2 size={12} />} disabled={busyId !== null} onClick={() => void remove("page", page.id, page.title)}>删除</Button></div>
                    </div>
                  ))}
                </Card>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}
