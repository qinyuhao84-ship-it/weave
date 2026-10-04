/** 一本书的来源页同时保存书籍介绍，避免同名页面阻止整批写入。 */
export function normalizeSourceSummary<T extends { sourceSummary: { title: string; content: string }; newPages: Array<{ title: string; content: string }> }>(draft: T): T {
  const title = draft.sourceSummary.title.trim().toLowerCase();
  const duplicates = draft.newPages.filter(page => page.title.trim().toLowerCase() === title);
  if (!duplicates.length) return draft;
  const content = [...new Set([draft.sourceSummary.content, ...duplicates.map(page => page.content)].filter(text => text.trim()))].join("\n\n");
  return {
    ...draft,
    sourceSummary: { ...draft.sourceSummary, content },
    newPages: draft.newPages.filter(page => page.title.trim().toLowerCase() !== title),
  };
}
