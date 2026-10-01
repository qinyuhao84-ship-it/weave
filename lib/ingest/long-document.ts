import type { Analysis, Draft } from "@/lib/llm/prompts";

const PAGE_MARKER = /^<!--\s*page:\d+\s*-->\s*$/;

/** Split Markdown at paragraph boundaries while retaining PDF page markers. */
export function splitMarkdown(markdown: string, maxTokens = 5_000): string[] {
  const blocks = markdown.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const chunks: string[] = [];
  let current: string[] = [];
  let tokenCount = 0;
  let pageMarker = "";

  const flush = () => {
    const content = current.join("\n\n").trim();
    if (content) chunks.push(content);
    current = pageMarker ? [pageMarker] : [];
    tokenCount = pageMarker ? estimatePartTokens(pageMarker) : 0;
  };

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    if (PAGE_MARKER.test(block)) {
      pageMarker = block;
      if (current.length === 0) {
        current.push(block);
        tokenCount = estimatePartTokens(block);
      } else if (tokenCount + estimatePartTokens(block) > maxTokens) {
        flush();
        pageMarker = block;
        current = [block];
        tokenCount = estimatePartTokens(block);
      } else {
        current.push(block);
        tokenCount += estimatePartTokens(block);
      }
      continue;
    }

    const parts = splitOversizedBlock(block, maxTokens);
    for (const part of parts) {
      const partTokens = estimatePartTokens(part);
      if (current.length > 0 && tokenCount + partTokens > maxTokens) flush();
      current.push(part);
      tokenCount += partTokens;
      if (partTokens >= maxTokens) flush();
    }
  }

  const finalChunk = current.join("\n\n").trim();
  if (finalChunk) chunks.push(finalChunk);
  const contentChunks = chunks.filter((chunk) =>
    chunk.replace(/<!--\s*page:\d+\s*-->/g, "").trim().length > 0,
  );
  return contentChunks.length > 0 ? contentChunks : [markdown];
}

function splitOversizedBlock(block: string, maxTokens: number): string[] {
  if (estimatePartTokens(block) <= maxTokens) return [block];

  // Prefer sentence boundaries for prose, then fall back to a bounded code point scan
  // for long URLs, minified HTML, or a single unbroken line.
  const sentences = block.split(/(?<=[。！？.!?])\s*/u).filter(Boolean);
  const out: string[] = [];
  let current = "";
  let count = 0;
  const append = (part: string) => {
    const tokens = estimatePartTokens(part);
    if (current && count + tokens > maxTokens) {
      out.push(current);
      current = "";
      count = 0;
    }
    current += part;
    count += tokens;
  };

  for (const sentence of sentences.length ? sentences : [block]) {
    if (estimatePartTokens(sentence) <= maxTokens) {
      append(sentence);
      continue;
    }
    for (const character of sentence) {
      const weight = /[\u3400-\u9fff]/u.test(character) ? 2 / 3 : 1 / 4;
      if (current && count + weight > maxTokens) {
        out.push(current);
        current = "";
        count = 0;
      }
      current += character;
      count += weight;
    }
  }
  if (current) out.push(current);
  return out;
}

function estimatePartTokens(text: string): number {
  let estimate = 0;
  for (const character of text) {
    estimate += /[\u3400-\u9fff]/u.test(character) ? 2 / 3 : 1 / 4;
  }
  return estimate;
}

export function combineAnalyses(items: Analysis[]): Analysis {
  const entities = new Map<string, Analysis["entities"][number]>();
  const concepts = new Map<string, Analysis["concepts"][number]>();
  const relations = new Map<string, Analysis["relations"][number]>();
  const overlaps = new Map<string, Analysis["overlaps"][number]>();
  const contradictions = new Map<string, Analysis["contradictions"][number]>();
  const gaps = new Map<string, string>();

  for (const item of items) {
    for (const entity of item.entities) {
      const key = normalize(entity.name);
      const previous = entities.get(key);
      entities.set(key, previous ? {
        ...previous,
        mentions: previous.mentions + entity.mentions,
        evidence: mergeEvidence(previous.evidence, entity.evidence),
      } : entity);
    }
    for (const concept of item.concepts) {
      const key = normalize(concept.name);
      const previous = concepts.get(key);
      concepts.set(key, previous ? { ...previous, evidence: mergeEvidence(previous.evidence, concept.evidence) } : concept);
    }
    for (const relation of item.relations) {
      const key = [relation.source, relation.target, relation.type].map(normalize).join("::");
      if (!relations.has(key)) relations.set(key, relation);
    }
    for (const overlap of item.overlaps) {
      const key = `${normalize(overlap.existing)}::${normalize(overlap.incoming)}`;
      const previous = overlaps.get(key);
      if (!previous || overlap.verdict === "same" || (overlap.verdict === "related" && previous.verdict === "different")) {
        overlaps.set(key, overlap);
      }
    }
    for (const contradiction of item.contradictions) {
      const key = `${normalize(contradiction.existing)}::${normalize(contradiction.claim)}`;
      if (!contradictions.has(key)) contradictions.set(key, contradiction);
    }
    for (const gap of item.gaps) gaps.set(normalize(gap), gap);
  }

  const languages = new Map<string, number>();
  for (const item of items) languages.set(item.language, (languages.get(item.language) ?? 0) + 1);
  const language = [...languages].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "未知";

  return {
    gist: uniqueLines(items.map((item) => item.gist)).join("\n\n"),
    language,
    entities: [...entities.values()],
    concepts: [...concepts.values()],
    relations: [...relations.values()],
    overlaps: [...overlaps.values()],
    contradictions: [...contradictions.values()],
    gaps: [...gaps.values()],
  };
}

export function combineDrafts(items: Draft[]): Draft {
  const newPages = new Map<string, Draft["newPages"][number]>();
  const updatedPages = new Map<string, Draft["updatedPages"][number]>();
  const reviewItems = new Map<string, Draft["reviewItems"][number]>();

  for (const item of items) {
    for (const page of item.newPages) {
      const key = normalize(page.title);
      const previous = newPages.get(key);
      if (!previous) {
        newPages.set(key, page);
      } else {
        newPages.set(key, {
          ...previous,
          summary: previous.summary || page.summary,
          content: mergeMarkdown(previous.content, page.content),
          aliases: uniqueStrings([...previous.aliases, ...page.aliases]),
          tags: uniqueStrings([...previous.tags, ...page.tags]),
          citations: mergeCitations(previous.citations, page.citations),
          confidence: previous.confidence === "low" || page.confidence === "low" ? "low" : previous.confidence,
        });
      }
    }
    for (const page of item.updatedPages) {
      const key = normalize(page.title);
      const previous = updatedPages.get(key);
      if (!previous) {
        updatedPages.set(key, page);
      } else {
        updatedPages.set(key, {
          ...previous,
          reason: uniqueLines([previous.reason, page.reason]).join("；"),
          proposedContent: mergeMarkdown(previous.proposedContent, page.proposedContent),
          appendContent: mergeMarkdown(previous.appendContent, page.appendContent),
          addAliases: uniqueStrings([...previous.addAliases, ...page.addAliases]),
          addTags: uniqueStrings([...previous.addTags, ...page.addTags]),
          citations: mergeCitations(previous.citations, page.citations),
        });
      }
    }
    for (const finding of item.reviewItems) {
      const key = `${finding.kind}::${normalize(finding.title)}`;
      if (!reviewItems.has(key)) reviewItems.set(key, finding);
    }
  }

  return {
    sourceSummary: {
      title: items[0]?.sourceSummary.title ?? "资料摘要",
      content: uniqueLines(items.map((item) => item.sourceSummary.content)).join("\n\n"),
    },
    newPages: [...newPages.values()],
    updatedPages: [...updatedPages.values()],
    reviewItems: [...reviewItems.values()],
  };
}

function mergeMarkdown(first: string, second: string): string {
  const sections = uniqueLines([first, second].flatMap((text) => text.split(/\n\s*\n/)));
  return sections.join("\n\n");
}

function mergeEvidence(first: string, second: string): string {
  return uniqueLines([first, second]).join("；").slice(0, 800);
}

function mergeCitations<T extends { page: number | null; quote: string }>(first: T[], second: T[]): T[] {
  const found = new Map<string, T>();
  for (const item of [...first, ...second]) {
    const key = `${item.page ?? ""}::${normalize(item.quote)}`;
    if (item.quote.trim()) found.set(key, item);
  }
  return [...found.values()].slice(0, 40);
}

function uniqueStrings(items: string[]): string[] {
  return uniqueLines(items.map((item) => item.trim()).filter(Boolean));
}

function uniqueLines(items: string[]): string[] {
  const found = new Set<string>();
  return items.map((item) => item.trim()).filter((item) => {
    const key = normalize(item);
    if (!key || found.has(key)) return false;
    found.add(key);
    return true;
  });
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}
