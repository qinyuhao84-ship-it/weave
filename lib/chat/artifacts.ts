import { createDocument } from "@mixmark-io/domino";
import { and, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { getDb } from "@/lib/db/client";
import { chatArtifacts, chatMessages, chatSessions, jobs } from "@/lib/db/schema";
import { localISOString } from "@/lib/utils";
import { validateCitations, type CitationView } from "./citations";
import type { ContextChunk } from "@/lib/llm/prompts";
import type { ChatArtifact } from "./config";
import { HTML_START, HTML_END } from "./html-guidance";
import { installReadingStyle } from "@/lib/documents/reading-style";

export { HTML_START, HTML_END, SHOW_ME_PROMPT } from "./html-guidance";

/** 只缓存可能跨分片的边界前缀；HTML 增量从不进入聊天正文。 */
export class HtmlAnswerStream {
  private buffer = "";
  private phase: "text" | "html" | "done" = "text";
  private end = HTML_END;
  private includeEnd = false;
  text = "";
  html = "";
  started = false;
  complete = false;
  overflow = false;
  push(delta: string): string {
    if (this.phase === "done") return "";
    this.buffer += delta;
    let visible = "";
    while (this.phase !== "done") {
      const markers = this.phase === "text" ? [HTML_START, "```html\n", "```html\r\n", "<!DOCTYPE html>", "<!doctype html>", "<html"] : [this.end];
      const found = markers.map(marker => ({ marker, at: this.buffer.indexOf(marker) })).filter(match => match.at >= 0).sort((a, b) => a.at - b.at)[0];
      const at = found?.at ?? -1;
      const marker = found?.marker ?? markers[0];
      if (at >= 0) {
        const part = this.buffer.slice(0, at);
        if (this.phase === "text") {
          visible += part; this.text += part; this.started = true; this.phase = "html";
          this.end = marker.startsWith("```") ? "```" : marker === HTML_START ? HTML_END : "</html>";
          this.includeEnd = this.end === "</html>";
          if (this.includeEnd) this.addHtml(marker);
        }
        else { this.addHtml(part + (this.includeEnd ? marker : "")); this.complete = !this.overflow; this.phase = "done"; }
        this.buffer = this.buffer.slice(at + marker.length);
        continue;
      }
      let held = 0;
      for (const candidate of markers) {
        for (let size = Math.min(candidate.length - 1, this.buffer.length); size > held; size--) {
          if (this.buffer.endsWith(candidate.slice(0, size))) { held = size; break; }
        }
      }
      const part = this.buffer.slice(0, this.buffer.length - held);
      this.buffer = this.buffer.slice(this.buffer.length - held);
      if (this.phase === "text") { visible += part; this.text += part; }
      else this.addHtml(part);
      break;
    }
    return visible;
  }
  finish(): string {
    const tail = this.phase === "text" ? this.buffer : "";
    if (this.phase === "html") this.addHtml(this.buffer);
    this.text += tail; this.buffer = "";
    return tail;
  }
  private addHtml(part: string) {
    const remaining = Math.max(0, 1_000_000 - this.html.length);
    if (part.length > remaining) this.overflow = true;
    this.html += part.slice(0, remaining);
  }
}

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function basicHtml(text: string, title = "回答图解"): string {
  const sections = text.trim().split(/\n\s*\n/).filter(Boolean);
  const document = createDocument(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title></head><body><main><h1>${escape(title)}</h1><p class="weave-caption">点击段落可展开或收起</p>${sections.map((section, index) => `<details open><summary>${escape(section.split("\n")[0].replace(/^#+\s*/, "").slice(0, 60) || `段落 ${index + 1}`)}</summary><p>${escape(section)}</p></details>`).join("")}</main></body></html>`);
  installReadingStyle(document);
  return `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
}

/** 只校验可见文本节点，不能把 Markdown 的空白清理应用到 JS/CSS。 */
export function prepareHtml(html: string, chunks: ContextChunk[], citations: CitationView[]): string {
  const document = createDocument(html);
  installReadingStyle(document);
  const visit = (node: Node) => {
    if (node.nodeType === 1 && /^(SCRIPT|STYLE|PRE|CODE|TEXTAREA)$/i.test((node as Element).tagName)) return;
    if (node.nodeType === 3) { node.nodeValue = validateCitations(node.nodeValue ?? "", chunks).text; return; }
    Array.from(node.childNodes).forEach(visit);
  };
  visit(document.body);
  document.querySelectorAll("[data-citation]").forEach(element => {
    if (element.closest("script,style,pre,code,textarea")) return;
    const index = Number(element.getAttribute("data-citation"));
    element.textContent = chunks.some(chunk => chunk.index === index) ? `[ID:${index}]` : "";
  });
  return formatHtmlCitations(`<!DOCTYPE html>\n${document.documentElement.outerHTML}`, citations);
}

/** 供新附件和历史附件共用；只处理正文，不改写脚本、样式或属性。 */
export function formatHtmlCitations(html: string, citations: CitationView[]): string {
  const document = createDocument(html);
  const byIndex = new Map(citations.map(citation => [citation.index, citation]));
  const superscript = (index: number) => {
    const citation = byIndex.get(index);
    if (!citation) return null;
    const sup = document.createElement("sup");
    sup.setAttribute("data-citation", String(index));
    sup.setAttribute("class", "weave-citation");
    sup.setAttribute("style", "font-size:.72em;vertical-align:super;line-height:0;margin:0 .15em;font-weight:600");
    const link = document.createElement("a");
    link.setAttribute("href", `#weave-source-${index}`);
    link.setAttribute("class", "weave-citation-link");
    link.setAttribute("style", "color:inherit;text-decoration:none");
    link.setAttribute("title", citation.pageTitle);
    link.setAttribute("aria-label", `引用 ${index}：${citation.pageTitle}`);
    link.textContent = String(index);
    sup.appendChild(link);
    return sup;
  };
  const visit = (node: Node) => {
    if (node.nodeType === 1) {
      const element = node as Element;
      if (/^(SCRIPT|STYLE|PRE|CODE|TEXTAREA)$/i.test(element.tagName)) return;
      if (element.hasAttribute("data-citation")) {
        const replacement = superscript(Number(element.getAttribute("data-citation")));
        if (replacement) element.parentNode?.replaceChild(replacement, element);
        else element.textContent = "";
        return;
      }
    }
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? "";
      const matches = [...value.matchAll(/\[ID:(\d+)\]/g)];
      if (!matches.length) return;
      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const match of matches) {
        fragment.appendChild(document.createTextNode(value.slice(offset, match.index)));
        const sup = superscript(Number(match[1]));
        if (sup) fragment.appendChild(sup);
        offset = match.index! + match[0].length;
      }
      fragment.appendChild(document.createTextNode(value.slice(offset)));
      node.parentNode?.replaceChild(fragment, node);
      return;
    }
    Array.from(node.childNodes).forEach(visit);
  };
  // 之前生成的来源列表也采用同一组锚点，反复读取不会重复附加。
  document.querySelectorAll('section[aria-label="知识库来源"]').forEach(section => section.remove());
  visit(document.body);
  if (!document.getElementById("weave-citation-style")) {
    const style = document.createElement("style");
    style.id = "weave-citation-style";
    style.textContent = ".weave-citation-link:focus-visible,[id^='weave-source-']:focus-visible{outline:2px solid currentColor;outline-offset:3px;border-radius:3px}.weave-citation-link:hover{text-decoration:underline!important}";
    document.head.appendChild(style);
  }
  if (citations.length) {
    const section = document.createElement("section");
    section.setAttribute("aria-label", "知识库来源");
    section.setAttribute("style", "max-width:70ch;margin:24px auto;padding:24px;font:14px/1.7 system-ui,sans-serif;border-top:1px solid #ded8ce");
    section.innerHTML = `<h2>知识库来源</h2><ol>${citations.map(citation => `<li id="weave-source-${citation.index}" value="${citation.index}">${escape(citation.pageTitle)}${citation.sourcePage ? ` · 第 ${citation.sourcePage} 页` : ""}</li>`).join("")}</ol>`;
    document.body.appendChild(section);
  }
  return `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
}

export function htmlCitationReport(html: string, chunks: ContextChunk[]) {
  const document = createDocument(html);
  document.querySelectorAll("script,style,pre,code,textarea").forEach(element => element.remove());
  document.querySelectorAll("[data-citation]").forEach(element => { element.textContent = `[ID:${element.getAttribute("data-citation")}]`; });
  return validateCitations(document.body.textContent ?? "", chunks);
}

export { previewHtml } from "@/lib/documents/html";

export function saveArtifact(input: { messageId: string; content: string; status: ChatArtifact["status"]; name?: string; mediaType?: string }): ChatArtifact {
  const artifact: ChatArtifact = { id: ulid(), messageId: input.messageId, name: input.name ?? "回答图解.html", mediaType: input.mediaType ?? "text/html", status: input.status };
  getDb().insert(chatArtifacts).values({ ...artifact, content: input.content, createdAt: localISOString() }).run();
  return artifact;
}

export function messageArtifacts(messageId: string): ChatArtifact[] {
  return getDb().select({ id: chatArtifacts.id, messageId: chatArtifacts.messageId, name: chatArtifacts.name, mediaType: chatArtifacts.mediaType, status: chatArtifacts.status }).from(chatArtifacts).where(eq(chatArtifacts.messageId, messageId)).all() as ChatArtifact[];
}

export function updateArtifact(id: string, content: string, status: ChatArtifact["status"]): void {
  const result = getDb().update(chatArtifacts).set({ content, status }).where(eq(chatArtifacts.id, id)).run();
  if (!result.changes) throw new Error("交互页面所属的回答已删除。");
}

export function getArtifact(id: string) {
  const row = getDb().select({ artifact: chatArtifacts, citationsJson: chatMessages.citationsJson }).from(chatArtifacts)
    .innerJoin(chatMessages, eq(chatArtifacts.messageId, chatMessages.id))
    .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
    .where(and(eq(chatArtifacts.id, id), isNull(chatSessions.deletedAt))).get();
  if (!row) return null;
  let citations: CitationView[] | undefined;
  if (row.citationsJson) {
    try {
      const stored = JSON.parse(row.citationsJson);
      const list = Array.isArray(stored) ? stored : stored?.list;
      if (Array.isArray(list)) citations = list;
    } catch { /* 旧附件没有可用来源元数据时保留原内容。 */ }
  }
  const job = row.artifact.status === "pending" ? getDb().select({ status: jobs.status, error: jobs.error }).from(jobs).where(eq(jobs.id, id)).get() : undefined;
  const status = job?.status === "failed" || job?.status === "cancelled" ? job.status : row.artifact.status;
  return { ...row.artifact, status: status as ChatArtifact["status"], citations, error: job?.error ?? null };
}
