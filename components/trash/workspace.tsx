"use client";
import { useI18n } from "@/components/i18n-provider";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Archive, RotateCcw, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge, Button, Card, EmptyState, LoadingCards, RequestError } from "@/components/ui";
import { useAppData } from "@/components/app-provider";
import { apiFetch, useApi } from "@/hooks/use-api";
import { formatDate } from "@/lib/utils";

type TrashData = {
  batches: Array<{ id: string; createdAt: string; pageCount: number; sourceCount: number; archivedFiles: number; restoredAt: string | null }>;
  pages: Array<{ id: string; title: string; deletedAt: string | null; redirectTo: string | null }>;
};

export function TrashWorkspace() {
  const { t, locale } = useI18n();
  const { dataVersion, bumpData } = useAppData();
  const { data, loading, error, refresh } = useApi<TrashData>("/api/vault/trash", [dataVersion]);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const remove = async (kind: "page" | "batch" | "all", id?: string, title?: string) => {
    if (!window.confirm(kind === "all" ? t("trash_workspace.m001") : t("trash_workspace.m002", {v0: title ?? ""}))) return;
    setBusyId(id ?? "all"); setActionError(null); setNotice(null);
    try {
      await apiFetch("/api/vault/trash", { method: "DELETE", body: JSON.stringify({ kind, ...(id ? { id } : {}) }) });
      setNotice(kind === "all" ? t("trash_workspace.m003") : t("trash_workspace.m004"));
      bumpData(); await refresh();
    } catch (err) { setActionError(err instanceof Error ? err.message : t("trash_workspace.m005")); }
    finally { setBusyId(null); }
  };

  const restore = async (id: string, kind: "batch" | "page", title: string) => {
    setBusyId(id);
    setActionError(null);
    setNotice(null);
    try {
      await apiFetch(kind === "batch" ? `/api/vault/trash/batches/${id}/restore` : `/api/pages/${id}/restore`, { method: "POST" });
      setNotice(kind === "batch" ? t("trash_workspace.m006", {v0: title}) : t("trash_workspace.m007", {v0: title}));
      bumpData();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("trash_workspace.m008"));
    } finally {
      setBusyId(null);
    }
  };

  const batches = data?.batches ?? [];
  const pages = data?.pages ?? [];
  return (
    <>
      <PageHeader
        title={t("trash_workspace.m009")}
        description={t("trash_workspace.m010")}
        meta={data && <><Badge tone="neutral">{batches.length} {t("trash_workspace.m011")}</Badge><Badge tone="neutral">{pages.length} {t("trash_workspace.m012")}</Badge></>}
        actions={<><Button size="sm" variant="danger" icon={<Trash2 size={13} />} loading={busyId === "all"} disabled={busyId !== null || !data || batches.length + pages.length === 0} onClick={() => void remove("all")}>{t("trash_workspace.m013")}</Button><Link href="/wiki" className="inline-flex h-11 items-center sm:h-7 gap-1.5 rounded-full px-3 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><ArrowLeft size={13} />{t("trash_workspace.m014")}</Link></>}
      />
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-6 md:px-6 md:py-8">
        {actionError && <Card className="border-[color-mix(in_srgb,var(--destructive)_30%,transparent)] p-3.5"><p role="alert" className="text-[12px] text-[var(--destructive)]">{actionError}</p></Card>}
        {notice && <p role="status" className="text-[12px] text-muted-foreground">{notice}</p>}
        {loading && !data && !error ? <LoadingCards /> : error ? (
          <RequestError error={error} onRetry={() => void refresh()} retrying={loading} />
        ) : (
          <>
            <section>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-[13px] font-semibold text-foreground">{t("trash_workspace.m015")}</h2>
                  <p className="mt-1 text-[11.5px] text-muted-foreground">{t("trash_workspace.m016")}</p>
                </div>
              </div>
              {batches.length === 0 ? (
                <Card className="p-5"><EmptyState icon={<Archive size={24} />} title={t("trash_workspace.m017")} description={t("trash_workspace.m018")} /></Card>
              ) : (
                <Card className="divide-y divide-[var(--border)]">
                  {batches.map((batch) => (
                    <div key={batch.id} className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between md:px-5">
                      <div className="min-w-0">
                        <p className="text-[12.5px] font-medium text-foreground">{t("trash_workspace.m019")}{formatDate(batch.createdAt, locale)}</p>
                        <p className="mt-1 break-all font-mono text-[10.5px] text-muted-foreground">{t("trash_workspace.m020")}{batch.id}</p>
                        <p className="mt-1 text-[11.5px] text-muted-foreground">{batch.pageCount} {t("trash_workspace.m021")}{batch.sourceCount} {t("trash_workspace.m022")}{batch.archivedFiles} {t("trash_workspace.m023")}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {batch.restoredAt ? <Badge tone="success">{t("trash_workspace.m024")}</Badge> : (
                          <Button
                            size="sm"
                            icon={<RotateCcw size={12} />}
                            loading={busyId === batch.id}
                            disabled={busyId !== null}
                            onClick={() => void restore(batch.id, "batch", t("trash_workspace.m025", {v0: formatDate(batch.createdAt, locale)}))}
                          >{t("trash_workspace.m026")}</Button>
                        )}
                        <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} disabled={busyId !== null} onClick={() => void remove("batch", batch.id, t("trash_workspace.m025", {v0: formatDate(batch.createdAt, locale)}))}>{t("trash_workspace.m027")}</Button>
                      </div>
                    </div>
                  ))}
                </Card>
              )}
            </section>

            <section>
              <div className="mb-3">
                <h2 className="text-[13px] font-semibold text-foreground">{t("trash_workspace.m028")}</h2>
                <p className="mt-1 text-[11.5px] text-muted-foreground">{t("trash_workspace.m029")}</p>
              </div>
              {pages.length === 0 ? (
                <Card className="px-4 py-5 text-[11.5px] text-muted-foreground">{t("trash_workspace.m030")}</Card>
              ) : (
                <Card className="divide-y divide-[var(--border)]">
                  {pages.map((page) => (
                    <div key={page.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 md:px-5">
                      <div className="min-w-0">
                        <p className="break-words text-[12.5px] font-medium text-foreground">{page.title}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">{page.deletedAt ? t("trash_workspace.m031", {v0: formatDate(page.deletedAt, locale)}) : t("trash_workspace.m032")}{page.redirectTo ? t("trash_workspace.m033") : ""}</p>
                      </div>
                      <div className="flex shrink-0 gap-2"><Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} loading={busyId === page.id} disabled={busyId !== null} onClick={() => void restore(page.id, "page", page.title)}>{t("trash_workspace.m034")}</Button><Button size="sm" variant="ghost" icon={<Trash2 size={12} />} disabled={busyId !== null} onClick={() => void remove("page", page.id, page.title)}>{t("trash_workspace.m035")}</Button></div>
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
