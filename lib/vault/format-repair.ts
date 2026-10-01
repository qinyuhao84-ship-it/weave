import { buildCatalog } from "@/lib/index/catalog";
import { loadPageFile, updatePage } from "./service";
import { protectedRanges } from "./wikilinks";
import { sha256 } from "./atomic";

/** 只替换正文中的旧段落分隔，保留围栏、缩进与行内代码；其余歧义由人工预览决定。 */
export function repairEscapedParagraphs(content: string): string {
  let fence: { char: string; length: number } | null = null;
  return content.split("\n").map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const token = marker[1];
      if (!fence) fence = { char: token[0], length: token.length };
      else if (token[0] === fence.char && token.length >= fence.length && line.slice(marker[0].length).trim() === "") fence = null;
      return line;
    }
    if (fence || /^( {4}|\t)/.test(line)) return line;
    const ranges = protectedRanges(line);
    return line.replace(/(?<!\\)\\n\\n/g, (match, offset: number) => ranges.some(([start, end]) => offset >= start && offset < end) ? match : "\n\n");
  }).join("\n");
}
export function listFormatRepairs() {
  return buildCatalog().flatMap(entry => {
    const file = loadPageFile(entry.id);
    const repaired = repairEscapedParagraphs(file.content);
    return repaired === file.content ? [] : [{ id: entry.id, title: entry.title, expectedHash: sha256(file.raw), before: file.content, after: repaired }];
  });
}
export function applyFormatRepair(id: string, expectedHash: string) {
  const file = loadPageFile(id);
  return updatePage(id, { content: repairEscapedParagraphs(file.content), expectedHash });
}
