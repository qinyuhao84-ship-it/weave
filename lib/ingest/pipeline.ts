import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { diffChars } from "diff";

import { getDb } from "@/lib/db/client";
import { sources, reviewItems, jobs } from "@/lib/db/schema";
import { RAW_DIR, WORK_DIR, type PageType } from "@/lib/vault/paths";
import { sha256, writeFileAtomic, readFileIfExists } from "@/lib/vault/atomic";
import { datePrefix, localISOString, truncate } from "@/lib/utils";
import { slugify } from "@/lib/vault/slug";
import { applyIngestBatch, loadPageFile, appendLog, ConflictError } from "@/lib/vault/service";
import { buildCatalog, findSimilarTitles } from "@/lib/index/catalog";
import { backupVault } from "@/lib/git/auto-commit";
import {
  enqueue, saveDraft, readDraft, finishJob,
  claimAwaitingReview, releaseAwaitingReview, getJob,
} from "@/lib/jobs/runner";
import { buildTitleIndex, relatedPagesFromTitles } from "@/lib/review/related-pages";
import { normalizeQuestion, MAX_ANSWER_LENGTH } from "@/lib/review/questions";
import { startReviewBatch } from "@/lib/review/batch-run";
import { isLlmConfigured } from "@/lib/settings";
import { recentDecisions } from "@/lib/lint";
import { normalizeLinkTarget } from "@/lib/vault/wikilinks";

import { parseDocument, estimateTokens, assertReadable, stripPageMarkers } from "./parse/router";
import { ParseQualityError } from "./parse/types";
import { titleFromFilename } from "./parse/node-parsers";
import { createProvider, LlmError } from "@/lib/llm";
import { completeStructured } from "@/lib/llm/structured";
import {
  AnalysisSchema, DraftSchema, buildAnalysisPrompt, buildDraftPrompt,
  verifyQuote,
  type Analysis, type Draft,
} from "@/lib/llm/prompts";
import type { LlmProvider } from "@/lib/llm/types";
import { combineAnalyses, combineDrafts, splitMarkdown } from "./long-document";
import { knowledgeContextForDocument } from "./knowledge-context";
import { loadCheckpoint, saveCheckpoint, clearCheckpoint } from "./checkpoint";
import { normalizeSourceSummary } from "./normalize-draft";

/**
 * 结构化抽取的单次调用超时。
 *
 * 15 分钟，比 provider 的默认值（5 分钟）宽松得多，理由是**这两个调用跑在后台
 * 任务里**：用户不是盯着一个转圈的按钮，他可以关掉窗口去干别的，进度条会自己走。
 * 而超时发生在第 5 分钟意味着什么？实测过一次：一份 16KB 的资料，分析用掉两分多，
 * 草稿写到一半被 5 分钟的上限掐断，整条流水线作废 —— 前面七分钟的等待全白费。
 * 对后台任务来说，多等一会儿的代价远小于白干一场。
 */
const STRUCTURED_TIMEOUT_MS = 15 * 60_000;

/**
 * ============================================================================
 * 导入流水线 —— 七态状态机
 * ============================================================================
 *
 *   uploaded → parsing → analyzing → drafting → reviewing → committing → done
 *
 * 三个设计要点，每一个都对应一类真实的失败：
 *
 * 1. **切成 analyzing / drafting 两步**（对齐原始 LLM Wiki 理念的两步 CoT）。
 *    一步到位让模型「读长文档同时产出十几个词条」质量必然崩；
 *    分开之后每一步都能单独检查、单独重试，中间还能插人工审阅。
 *
 * 2. **审阅闸门（reviewing）**。原理念是对话式人在环中，我们做成正式闸门。
 *    这不是偏离，而是补短板 —— 原文自己承认「wiki 由 LLM 写、LLM 维护、
 *    LLM 查询」，错误会静默复利。
 *
 * 3. **提交前做哈希冲突检测**。LLM 只产出草稿，用户改完才落盘；
 *    落盘时重读目标文件比对哈希，被外部改动就报冲突而不是静默覆盖。
 */

/* ------------------------------------------------------------ 输入与产出 */

export type StartIngestInput = {
  /** 原始文件名（含扩展名） */
  fileName: string;
  /** 文件字节；用 Buffer 而不是路径，便于直接接收上传流 */
  buffer: Buffer;
  /** 允许注入 provider 以便测试 */
  provider?: LlmProvider;
  /** 指定 jobId，便于调用方提前订阅 */
  jobId?: string;
  /** 重新处理已有原件时复用对应来源行 */
  reprocessSourceId?: string;
  /** 内部恢复路径，沿用原任务。 */
  resume?: boolean;
};

export type DuplicateInfo = {
  kind: "exact" | "similar";
  /** 已存在的来源文档名 */
  existingName: string;
  existingId: string;
  importedAt: string;
  /** 相似度 0..1，仅 kind=similar 时有 */
  score?: number;
};

type IngestUpdatedPage = Draft["updatedPages"][number] & {
  /** 生成改写草稿时的原正文快照，仅用于审阅展示 */
  originalContent?: string;
  /** 服务端保存的乐观并发版本，不接受客户端覆盖 */
  expectedHash?: string;
};

export type IngestDraft = {
  jobId: string;
  source: {
    id: string;
    docPath: string;
    originalName: string;
    sha256: string;
    byteSize: number;
    pageCount: number | null;
    parser: string;
    importedAt: string;
  };
  /** 解析出的 Markdown（内部使用，含页码标记） */
  markdown: string;
  tokenEstimate: number;
  analysis: Analysis;
  /** 已有关联来源摘要页的生成时版本；旧草稿没有基线时禁止覆盖。 */
  sourceSummarySnapshot?: { pageId: string; expectedHash: string };
  draft: Omit<Draft, "updatedPages"> & { updatedPages: IngestUpdatedPage[] };
  warnings: string[];
  /** 升级建议，例如安装 docling */
  upgradeHint: string | null;
  reviewRevision?: number;
  aiReviewJobId?: string;
  reviewState?: { skippedTitles: string[]; decisions: Array<[number, { decision?: "accepted" | "dismissed"; note: string; answer: string; choiceId: string | null }]> };
};

/* ------------------------------------------------------------ 启动导入 */

/**
 * 启动一次导入。立即返回 jobId，实际工作跑在后台任务里。
 *
 * 为什么不直接 await 完成：一次导入是分钟级的（解析 + 两次 LLM 调用），
 * 而 next dev 的 HMR 会杀掉请求生命周期里的长任务。放进 job runner 之后，
 * 前端通过 SSE 实时看进度，页面刷新也不会丢。
 */
export function startIngest(input: StartIngestInput): { jobId: string } {
  input = { ...input, provider: input.provider ?? (isLlmConfigured() ? createProvider() : undefined) };
  const jobId = input.jobId ?? ulid();
  const originalName = path.posix.basename(input.fileName.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 255);
  const extension = path.extname(originalName).toLowerCase();
  // 请求返回前持久化输入，排队期间退出进程也不会丢失已完成上传。
  const inputPath = ingestInputPath(jobId);
  if (!input.resume) {
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    writeFileAtomic(inputPath, input.buffer);
  }

  input = { ...input, buffer: Buffer.alloc(0) };
  enqueue({
    kind: "ingest",
    jobId,
    payload: { fileName: originalName, resumable: true, reprocessSourceId: input.reprocessSourceId },
    resume: input.resume,
    handler: async (context) => {
      /**
       * 这次导入对应的来源行 id。
       *
       * 在 try 外面声明、在插入（或复用）之后立刻赋值：取消时 catch 块要靠它把
       * 那一行从「解析中」回收成「待处理」。赋值点与插入之间没有 await，
       * 所以不存在「行还没建出来就被取消」的窗口。
       */
      let sourceRowId: string | null = null;
      try {
        const buffer = fs.readFileSync(inputPath);
        // ---- ① uploaded：落盘原始文件 + 查重 ----
        context.setStage("uploaded", "正在接收文件");
        const bufferHash = sha256(buffer);

        const exact = getDb()
          .select()
          .from(sources)
          .where(eq(sources.sha256, bufferHash))
          .get();

        if (exact && hasUnfinishedIngestDraft(exact.id)) {
          throw new Error("这份资料已有草稿等待处理，请先提交、放弃或解决现有草稿。");
        }

        // 只有**已经编译完**的那一条才算重复。
        //
        // 早先只要 sha256 命中就拦，于是「一次失败」等于「这份文件再也导不进来」：
        // 解析失败、起草时模型超时、用户放弃草稿 —— 这三种情况下那一行都不是
        // parsed，但旧代码不看状态，用户重新导入只会得到一句「已经导入过了」，
        // 而知识库里其实什么都没有。sha256 是内容指纹，不是「这件事办完了」的凭证。
        //
        // parsed 表示处理流程已经产出草稿；界面只写「已处理」，不暗示草稿一定已写入 Wiki。
        if (exact?.status === "parsed" && !input.reprocessSourceId) {
          context.log(`这份文件与已导入的《${exact.originalName}》完全相同，跳过重复导入。`, "warning");
          fs.rmSync(inputPath, { force: true });
          return {
            duplicate: {
              kind: "exact" as const,
              existingName: exact.originalName,
              existingId: exact.id,
              importedAt: exact.importedAt,
            },
          };
        }

        const now = localISOString();
        // 同一个 sha256 只允许有一行来源记录（schema 上是唯一索引），所以「重新导入」
        // 复用的是同一行，不是插一行新的 —— 同一份字节本来就是同一份资料，
        // 之前那次失败不该让它变成两份。
        const sourceId = exact?.id ?? ulid();
        if (input.reprocessSourceId && sourceId !== input.reprocessSourceId) {
          throw new Error("原始资料记录与文件内容不一致，无法重新处理。");
        }
        sourceRowId = sourceId;
        let docRelative: string;

        if (exact) {
          // 之前那次没走完：原件早就在 raw/ 里躺着，不必再拷一份。
          // 状态回到「解析中」，把上一轮残留的解析产物指纹一并清掉。
          docRelative = exact.docPath;
          getDb()
            .update(sources)
            .set({ status: "parsing", importedAt: now, parsedPath: null, parser: null, pageCount: null })
            .where(eq(sources.id, sourceId))
            .run();
          context.log(`这份文件上次没有编译完，这次重新处理（原件仍在 ${docRelative}）。`);
        } else {
          const storedName = `${datePrefix()}-${slugify(titleFromFilename(originalName)) || "untitled"}${extension}`;
          docRelative = path.posix.join("raw", uniqueRawName(storedName));
          fs.mkdirSync(RAW_DIR, { recursive: true });
          writeFileAtomic(path.join(RAW_DIR, path.basename(docRelative)), buffer);
          context.log(`原件已存入 ${docRelative}`);

          getDb()
            .insert(sources)
            .values({
              id: sourceId,
              docPath: docRelative,
              originalName,
              sha256: bufferHash,
              byteSize: buffer.byteLength,
              title: titleFromFilename(originalName),
              importedAt: now,
              status: "parsing",
              parser: null,
              metaJson: null,
            })
            .run();
        }

        const docAbsolute = path.join(RAW_DIR, path.basename(docRelative));
        const checkpoint = loadCheckpoint(sourceId, bufferHash);

        // 真实锚点：这一步做完了，进度条立刻认账，不用等估算曲线慢慢爬
        context.setFraction(1);
        context.throwIfCancelled();

        // ---- ② parsing：格式路由转 Markdown ----
        context.setStage("parsing", "正在解析文档");
        assertReadable(docAbsolute);

        let parsed = checkpoint.parsed;
        try {
          if (!parsed) parsed = await parseDocument({
            absolutePath: docAbsolute,
            originalName,
            byteSize: buffer.byteLength,
            // docling 侧车解析一份 PDF 要几十秒，这是整条流水线里唯一能被中断的解析
            signal: context.signal,
          });
        } catch (error) {
          // 失败与「被用户停止」要分开记：前者说明这份资料有问题，后者说明
          // 这份资料还好好的、只是这次不导了 —— 状态回到「待处理」，随时能重来。
          getDb()
            .update(sources)
            .set({ status: context.isCancelled() ? "pending" : "failed" })
            .where(eq(sources.id, sourceId))
            .run();
          throw error;
        }

        if (!stripPageMarkers(parsed.markdown).trim()) {
          throw new ParseQualityError("没有从这份文件提取到可用正文。请检查文件内容，或将文件转换为支持的格式后重试。");
        }

        const tokenEstimate = estimateTokens(parsed.markdown);
        if (tokenEstimate > 250_000) throw new ParseQualityError("资料正文超过 250,000 个估算 token，请拆成较小文件后导入，以控制处理成本。");

        checkpoint.parsed = parsed;
        saveCheckpoint(sourceId, checkpoint);
        if (input.resume) context.log("已载入保存的解析进度，继续处理未完成部分。");

        // 解析产物存到 .weave/parsed/（派生数据，不进 git）
        const parsedRelative = path.posix.join(".weave", "parsed", `${sourceId}.md`);
        const parsedAbsolute = path.join(WORK_DIR, "parsed", `${sourceId}.md`);
        writeFileAtomic(parsedAbsolute, parsed.markdown);

        // 只记解析产物，**不翻状态**：状态要等到草稿真的生成出来才算数，
        // 否则起草阶段失败会留下一行「已编译」而知识库里空无一物（见上面的查重）
        getDb()
          .update(sources)
          .set({
            parsedPath: parsedRelative,
            pageCount: parsed.pageCount,
            parser: parsed.parser,
          })
          .where(eq(sources.id, sourceId))
          .run();

        for (const warning of parsed.warnings) context.log(warning, "warning");
        if (parsed.upgradeHint) context.log(parsed.upgradeHint, "info");

        context.setFraction(1);
        context.log(`${parsed.parser} 解析完成，约 ${tokenEstimate.toLocaleString("zh-CN")} token`);

        context.throwIfCancelled();

        // ---- ③ analyzing：LLM 第一步 ----
        const chunks = checkpoint.chunks.length ? checkpoint.chunks : splitMarkdown(parsed.markdown);
        if (chunks.length > 1) {
          context.log(`资料较长，已按段落与页码拆成 ${chunks.length} 段逐段处理，完成后再合并结果。`);
        }
        context.setStage("analyzing", chunks.length > 1 ? `正在分析内容（共 ${chunks.length} 段）` : "正在分析内容");
        const provider = input.provider;
        if (!provider) throw new LlmError("请先在设置中配置你的模型服务，再重新处理资料。");
        const catalog = buildCatalog({ includeSummaries: false });
        const catalogHash = sha256(JSON.stringify(catalog.map(entry => ({ id: entry.id, hash: sha256(readFileIfExists(path.join(WORK_DIR, "..", entry.filePath)) ?? "") }))));
        if (checkpoint.catalogHash && checkpoint.catalogHash !== catalogHash) {
          checkpoint.analyses = []; checkpoint.drafts = [];
          context.log("知识库内容已变化，保留解析结果并重新分析，避免复用过期的改写建议。", "warning");
        }
        checkpoint.catalogHash = catalogHash; checkpoint.chunks = chunks;
        saveCheckpoint(sourceId, checkpoint);
        const existingIndex = knowledgeContextForDocument(catalog, parsed.markdown);
        let sourceSummarySnapshot: IngestDraft["sourceSummarySnapshot"];
        for (const entry of catalog) {
          if (entry.type !== "source") continue;
          try {
            const file = loadPageFile(entry.id);
            if (file.data.sources.some((source) => source.doc === docRelative)) {
              sourceSummarySnapshot = { pageId: entry.id, expectedHash: sha256(file.raw) };
              break;
            }
          } catch {
            // 摘要页在目录读取期间被删除时，提交前会按缺失目标提示冲突。
          }
        }

        // 相似度提示：防止同一份资料换个文件名又被导进来
        const similar = findSimilarTitles(catalog, titleFromFilename(originalName), 0.6);
        if (similar.length > 0) {
          context.log(
            `知识库里已有相似词条：${similar.map((s) => `《${s.entry.title}》`).join("、")}，分析时会重点判断是否为同一事物。`,
          );
        }

        const analysisParts: Analysis[] = checkpoint.analyses;
        context.setFraction(analysisParts.length / chunks.length);
        for (let index = analysisParts.length; index < chunks.length; index++) {
          context.throwIfCancelled();
          const analysisResult = await completeStructured({
            provider,
            schema: AnalysisSchema,
            schemaName: "wiki_analysis",
            temperature: 0.2,
            timeoutMs: STRUCTURED_TIMEOUT_MS,
            signal: context.signal,
            messages: [{
              role: "user",
              content: buildAnalysisPrompt({
                sourceTitle: titleFromFilename(originalName),
                sourcePath: docRelative,
                markdown: chunks[index],
                existingIndex,
                decisions: recentDecisions(),
              }),
            }],
            onAttempt: (attempt, error) => {
              context.log(`模型第 ${attempt} 次输出不符合格式要求，已自动重试：${truncate(error, 80)}`, "warning");
            },
          });
          analysisParts.push(analysisResult.data);
          saveCheckpoint(sourceId, checkpoint);
          context.setFraction((index + 1) / chunks.length);
          if (chunks.length > 1) context.log(`已分析第 ${index + 1}/${chunks.length} 段。`);
        }

        const analysis = combineAnalyses(analysisParts);
        context.log(
          `识别出 ${analysis.entities.length} 个实体、${analysis.concepts.length} 个概念、${analysis.relations.length} 条关系` +
            (analysis.contradictions.length > 0 ? `，发现 ${analysis.contradictions.length} 处与已有知识矛盾` : ""),
        );

        context.throwIfCancelled();

        // ---- ④ drafting：LLM 第二步 ----
        context.setStage("drafting", chunks.length > 1 ? `正在撰写词条草稿（共 ${chunks.length} 段）` : "正在撰写词条草稿");

        // 只把模型判断为「相同 / 相关」的已有页面作为改写候选，并把完整正文
        // 一并交给模型。过长正文不进入整页改写路径，仍可用 append-only 安全追加。
        const updateSnapshots = new Map<string, { content: string | null; expectedHash: string }>();
        for (const overlap of analysis.overlaps) {
          if (overlap.verdict === "different") continue;
          const entry = catalog.find((item) => item.title.toLowerCase() === overlap.existing.toLowerCase());
          if (!entry) continue;
          try {
            const file = loadPageFile(entry.id);
            updateSnapshots.set(entry.title.toLowerCase(), {
              content: chunks.length === 1 && file.content.length <= 16_000 ? file.content : null,
              expectedHash: sha256(file.raw),
            });
          } catch {
            // 页面在本次分析期间消失时，不把它作为改写目标。
          }
        }

        const draftParts: Draft[] = checkpoint.drafts;
        context.setFraction(draftParts.length / chunks.length);
        for (let index = draftParts.length; index < chunks.length; index++) {
          context.throwIfCancelled();
          const chunkAnalysis = analysisParts[index];
          const allowedTitles = planPageTitles(chunkAnalysis, catalog);
          const currentPages = chunks.length === 1
            ? [...updateSnapshots.entries()].flatMap(([title, snapshot]) => snapshot.content === null ? [] : [{
                title: catalog.find((entry) => entry.title.toLowerCase() === title)?.title ?? title,
                content: snapshot.content,
              }])
            : [];
          const draftResult = await completeStructured({
            provider,
            schema: DraftSchema,
            schemaName: "wiki_draft",
            temperature: 0.4,
            timeoutMs: STRUCTURED_TIMEOUT_MS,
            signal: context.signal,
            messages: [{
              role: "user",
              content: buildDraftPrompt({
                sourceTitle: titleFromFilename(originalName),
                sourcePath: docRelative,
                markdown: chunks[index],
                analysis: chunkAnalysis,
                allowedTitles,
                currentPages,
                decisions: recentDecisions(),
              }),
            }],
            onAttempt: (attempt, error) => {
              context.log(`模型第 ${attempt} 次输出不符合格式要求，已自动重试：${truncate(error, 80)}`, "warning");
            },
          });
          draftParts.push(draftResult.data);
          saveCheckpoint(sourceId, checkpoint);
          context.setFraction((index + 1) / chunks.length);
          if (chunks.length > 1) context.log(`已撰写第 ${index + 1}/${chunks.length} 段。`);
        }

        const draft = normalizeSourceSummary(combineDrafts(draftParts));

        // 引用校验：模型给出的原文片段必须真的存在于原文里
        const verifiedDraft = verifyCitations(draft, parsed.markdown, context, parsed.pageCount);
        for (const update of verifiedDraft.updatedPages) {
          const key = update.title.toLowerCase();
          if (updateSnapshots.has(key)) continue;
          const entry = catalog.find((item) => item.title.toLowerCase() === key);
          if (!entry) continue;
          try {
            const file = loadPageFile(entry.id);
            updateSnapshots.set(key, {
              content: chunks.length === 1 && file.content.length <= 16_000 ? file.content : null,
              expectedHash: sha256(file.raw),
            });
          } catch {
            // 提交前会把失效目标作为冲突提示给用户。
          }
        }
        const draftWithVerifiedCitations = {
          ...verifiedDraft,
          updatedPages: verifiedDraft.updatedPages.map((update) => {
            const snapshot = updateSnapshots.get(update.title.toLowerCase());
            const proposedContent = update.proposedContent.trim() ? update.proposedContent : "";
            if (!snapshot && proposedContent) {
              context.log(`「${update.title}」没有可用的完整正文快照，已移除整页改写建议以避免覆盖旧内容。`, "warning");
              return { ...update, proposedContent: "" };
            }
            return snapshot
              ? {
                  ...update,
                  ...(proposedContent && snapshot.content !== null
                    ? { proposedContent, originalContent: snapshot.content }
                    : proposedContent ? { proposedContent: "" } : {}),
                  expectedHash: snapshot.expectedHash,
                }
              : update;
          }),
        };

        context.setFraction(1);
        context.log(
          `草稿完成：新建 ${draftWithVerifiedCitations.newPages.length} 个词条、` +
            `更新 ${draftWithVerifiedCitations.updatedPages.length} 个已有词条`,
        );

        // ---- ⑤ reviewing：交给人 ----
        const result: IngestDraft = {
          jobId,
          source: {
            id: sourceId,
            docPath: docRelative,
            originalName,
            sha256: bufferHash,
            byteSize: buffer.byteLength,
            pageCount: parsed.pageCount,
            parser: parsed.parser,
            importedAt: now,
          },
          markdown: parsed.markdown,
          tokenEstimate,
          analysis,
          sourceSummarySnapshot,
          draft: draftWithVerifiedCitations,
          warnings: parsed.warnings,
          upgradeHint: parsed.upgradeHint,
        };

        // 草稿是分钟级生成的，用户完全可能在这期间点了停止 —— 那就别再落草稿了。
        // 少了这一道，停止后草稿照样出现在抽屉里，用户会以为停止没生效。
        context.throwIfCancelled();
        saveDraft(jobId, result);
        getDb().update(sources).set({ status: "awaiting_review" }).where(eq(sources.id, sourceId)).run();
        context.setStage("reviewing", "等待你审阅");
        context.log("草稿已生成，等待审阅确认后写入知识库。");

        return { awaitingReview: true };
      } catch (error) {
        // 被停止时把来源行收回「待处理」。
        //
        // 不做这件事的话，来源列表里会永远挂着一行「解析中」—— 那是一个早就
        // 不存在的任务留下的状态，用户除了困惑什么也做不了，而且重新导入时
        // 那一行的 sha256 已经存在，他会怀疑自己是不是重复导入了。
        // 原件留在 raw/ 原地不动：停止不等于删除，资料随时可以重来。
        if (context.isCancelled() && sourceRowId) {
          getDb().update(sources).set({ status: "pending" }).where(eq(sources.id, sourceRowId)).run();
          appendLog("INGEST", `导入《${originalName}》已停止，原件保留在 raw/，可以重新处理。`);
          backupVault(`停止导入《${originalName}》`);
        } else if (sourceRowId) {
          getDb().update(sources).set({ status: "failed" }).where(eq(sources.id, sourceRowId)).run();
        }
        throw error;
      }
    },
  });

  return { jobId };
}

function ingestInputPath(jobId: string): string {
  if (!/^[0-9A-Z]{26}$/.test(jobId)) throw new Error("无效的任务标识。");
  return path.join(WORK_DIR, "ingest-inputs", `${jobId}.bin`);
}

/** 原任务恢复：不重复上传、不创建另一条待处理任务。 */
export function resumeIngest(jobId: string, provider?: LlmProvider): { jobId: string } {
  const job = getJob(jobId);
  if (!job || job.kind !== "ingest") throw new Error("找不到这次导入任务。");
  if (["queued", "running", "awaiting_review", "committing", "discarding"].includes(job.status)) return { jobId };
  const payload = job.payload as { fileName?: string; resumable?: boolean; reprocessSourceId?: string } | null;
  if (!payload?.resumable || !payload.fileName || !fs.existsSync(ingestInputPath(jobId))) {
    throw new Error("这次旧任务没有保存完整输入。请从资料管理重新处理，或重新选择文件。");
  }
  return startIngest({ fileName: payload.fileName, buffer: fs.readFileSync(ingestInputPath(jobId)), provider, jobId, resume: true, reprocessSourceId: payload.reprocessSourceId });
}

export function recoverInterruptedIngests(jobIds: string[]): number {
  let resumed = 0;
  for (const jobId of jobIds) {
    try { resumeIngest(jobId); resumed++; }
    catch (error) { console.warn("[ingest] 中断任务保留，等待手动重试：", error instanceof Error ? error.message : "无法恢复"); }
  }
  return resumed;
}

/** 给 raw/ 文件名去重：已存在就加序号 */
function uniqueRawName(candidate: string): string {
  if (!fs.existsSync(path.join(RAW_DIR, candidate))) return candidate;
  const extension = path.extname(candidate);
  const base = path.basename(candidate, extension);
  for (let i = 2; i < 1000; i++) {
    const next = `${base}-${i}${extension}`;
    if (!fs.existsSync(path.join(RAW_DIR, next))) return next;
  }
  return `${base}-${Date.now()}${extension}`;
}

/**
 * 规划这次会新建哪些词条，产出一份白名单。
 *
 * 为什么要白名单：模型在生成草稿时容易「顺手多造几个词条」，
 * 而这些名字如果不在分析结果里，往往就是它临时编的 —— 造出来的词条
 * 要么内容空洞，要么与已有词条重复。把范围限定住，质量立刻稳定。
 */
function planPageTitles(analysis: Analysis, catalog: ReturnType<typeof buildCatalog>): string[] {
  const existingTitles = new Set(catalog.map((entry) => entry.title.toLowerCase()));
  const titles: string[] = [];

  for (const entity of analysis.entities) {
    if (!existingTitles.has(entity.name.toLowerCase())) titles.push(entity.name);
  }
  for (const concept of analysis.concepts) {
    if (!existingTitles.has(concept.name.toLowerCase())) titles.push(concept.name);
  }

  // 分析里判定为「同一个东西」的，不该再新建
  const sameAsExisting = new Set(
    analysis.overlaps.filter((o) => o.verdict === "same").map((o) => o.incoming.toLowerCase()),
  );

  return titles.filter((title) => !sameAsExisting.has(title.toLowerCase()));
}

/**
 * 校验草稿里的引用是否真的存在于原文。
 *
 * 这一步是控制幻觉的关键：只让模型输出引用而不校验，等于没做引用 ——
 * 模型会编出看起来非常合理的"原文片段"。校验通过的保留，不通过的剔除并记录。
 */
export function verifyCitations(draft: Draft, sourceMarkdown: string, context: { log: (m: string, l?: "info" | "warning" | "error") => void }, pageCount: number | null = null): Draft {
  let verified = 0;
  let rejected = 0;

  const check = <T extends { citations: Array<{ page: number | null; quote: string }> }>(item: T): T => {
    const kept = item.citations.flatMap((citation) => {
      const ok = verifyQuote(citation.quote, sourceMarkdown);
      if (ok) verified++;
      else rejected++;
      if (!ok) return [];
      let page: number | null = null;
      if (pageCount && citation.page && citation.page >= 1 && citation.page <= pageCount) {
        const segments = [...sourceMarkdown.matchAll(/<!--\s*page:(\d+)\s*-->/g)];
        const marker = segments.find((match) => Number(match[1]) === citation.page);
        const next = marker ? segments.find((match) => match.index! > marker.index!) : null;
        if (marker && verifyQuote(citation.quote, sourceMarkdown.slice(marker.index! + marker[0].length, next?.index))) page = citation.page;
      }
      return [{ ...citation, page }];
    });
    return { ...item, citations: kept };
  };

  const result: Draft = {
    ...draft,
    newPages: draft.newPages.map(check),
    updatedPages: draft.updatedPages.map(check),
  };

  if (rejected > 0) {
    context.log(
      `引用校验：${verified} 条通过，${rejected} 条在原文中找不到对应片段，已剔除。`,
      "warning",
    );
  } else if (verified > 0) {
    context.log(`引用校验：${verified} 条引用全部能在原文中定位。`);
  }

  return result;
}

/* ------------------------------------------------------------ 提交入库 */

/**
 * 用户在导入审阅界面里，对某一条「需要你判断的事项」做出的裁决。
 *
 * 用下标而不是标题来定位：草稿在前端内存里，reviewItems 不会被编辑，
 * 下标在这次提交的整个生命周期内稳定；而标题有可能重复（模型偶尔会写出
 * 两条字面相同的事项），拿它当 key 会串。
 */
export type IngestDecision = {
  /** 对应 draft.reviewItems 里的下标 */
  index: number;
  /**
   * 裁决。**可以为空**：用户可以只回答不裁决 —— 那种情况下这条事项会落成
   * answered，等着批量处理，而不是在这里就结案。
   */
  decision?: "accepted" | "dismissed";
  /** 可选的一句话说明，会一起回灌给下一轮模型 */
  note?: string;
  /** 用户对这条事项的回答（选了某个选项的文案，或自己写的一句） */
  answer?: string;
  /** 选中的选项 id；为空表示自由输入 */
  choiceId?: string;
};

export type CommitIngestOptions = {
  jobId: string;
  reviewRevision?: number;
  /** 用户审阅、增删改之后的草稿 */
  draft: Draft;
  /** 用户在审阅界面确认的最终标题等覆盖项 */
  overrides?: {
    sourceTitle?: string;
    /** 明确要跳过的词条（用户删掉的） */
    skippedTitles?: string[];
  };
  /**
   * 用户在导入界面当场做掉的裁决。没裁决的条目按 pending 入队，等他在体检页处理 ——
   * 两条路都要通，因为用户可能在这里就看得明白，也可能想攒着一起看。
   */
  decisions?: IngestDecision[];
};

export type CommitIngestResult = {
  createdPages: Array<{ id: string; title: string; path: string }>;
  updatedPages: Array<{ id: string; title: string; addedChars: number }>;
  reviewItemCount: number;
  /**
   * 分析阶段发现、起草阶段漏掉、由后端补进队列的矛盾条数。
   *
   * 单独报出来是因为这是一处**后端替模型兜底**的地方：用户有权知道队列里有几条
   * 不是模型主动报的，而不是让它悄悄混进去。
   */
  supplementedContradictions: number;
  /**
   * 接着起的那批回答处理任务的 id。null = 这次没有回答，或者没配模型。
   *
   * 前端在**同一个抽屉里**接着跟它，不跳页（用户在草稿上答完题，期待的是
   * 「确认写入」之后一路跑完，而不是被丢到另一个页面去看进度）。
   */
  batchJobId: string | null;
  commitSha: string | null;
  backupWarning: string | null;
  /** 冲突：提交时发现目标文件被外部改过 */
  conflicts: string[];
};

/**
 * 把审阅通过的草稿写入知识库。
 *
 * 这是「事务性落盘」：先在内存里算出全部改动，再逐个原子写，
 * 任何一步失败都回滚（由服务层的 VaultTransaction 保证）。
 * 提交前会比对外部改动 —— 用户在 Obsidian 里同时编辑过的文件会被报为冲突，
 * 而不是被静默覆盖。
 */
/**
 * 把分析阶段发现的矛盾补进审阅队列 —— 不能指望起草阶段「自觉」写进去。
 *
 * 为什么必须有这一步：`analysis.contradictions` 是第一遍分析（模型只读资料与目录）
 * 的产物，而 `draft.reviewItems` 是第二遍起草（模型此时在写正文、理双链）的产物。
 * 实测第二遍对「还有矛盾没报」这件事的注意力很低，漏掉的那条就只剩一行日志 ——
 * 抽屉里那一段是只读展示，没有任何入口，用户永远看不到。
 *
 * 去重判据是「已有事项是否指向同一个已有词条」，而不是标题字面相等：模型对同一件
 * 事的措辞每次都不一样，字面比对等于没比。
 *
 * 补出来的标题写成规范式，因为 queueFindings 的去重键是 `kind::title` ——
 * 同一份资料失败重来时，规范标题能保证它不会变成第二条。
 */
function supplementContradictions(
  analysis: Analysis,
  items: Draft["reviewItems"],
  sourceTitle: string,
): Draft["reviewItems"] {
  const covered = items
    .filter((item) => item.kind === "contradiction")
    .flatMap((item) => item.relatedTitles ?? [])
    .map((title) => normalizeLinkTarget(title));

  const added: Draft["reviewItems"] = [];
  for (const contradiction of analysis.contradictions) {
    const target = normalizeLinkTarget(contradiction.existing);
    if (!target || covered.includes(target)) continue;
    covered.push(target);

    added.push({
      kind: "contradiction",
      title: `「${contradiction.existing}」与《${sourceTitle}》的说法矛盾`,
      detail: `资料里说：${contradiction.claim}\n与已有知识的冲突：${contradiction.conflict}`,
      severity: "warning",
      relatedTitles: [contradiction.existing],
      // 问题与选项在第一步就由模型产出，直接搬过来；为空就退回旧交互
      question: contradiction.question,
      options: contradiction.options,
    });
  }
  return added;
}

export async function commitIngest(options: CommitIngestOptions): Promise<CommitIngestResult> {
  const staged = readDraft<IngestDraft>(options.jobId);
  if (!staged) throw new ConflictError("找不到这次导入的草稿，可能已经处理过。", "导入草稿");
  if (staged.aiReviewJobId && ["queued", "running"].includes(getJob(staged.aiReviewJobId)?.status ?? "")) throw new ConflictError("AI 正在判断这份草稿，请完成或停止后再确认写入。", "导入草稿");
  if (options.reviewRevision !== undefined && options.reviewRevision !== (staged.reviewRevision ?? 0)) throw new ConflictError("草稿已在另一页面更新，请载入已保存版本后再确认写入。", "导入草稿");
  if (!claimAwaitingReview(options.jobId, "committing")) {
    throw new ConflictError("这份草稿已被提交、放弃，或正在由另一个请求处理。", "导入草稿");
  }

  try {
    const draft = normalizeSourceSummary(verifyCitations(DraftSchema.parse(options.draft), staged.markdown, { log: () => undefined }, staged.source.pageCount));
    const requestedSkips = options.overrides?.skippedTitles;
    const skipped = new Set(
      (Array.isArray(requestedSkips) ? requestedSkips : [])
        .filter((title): title is string => typeof title === "string")
        .map((title) => title.trim().toLowerCase()),
    );
    const rawSourceTitle = options.overrides?.sourceTitle;
    const sourceTitle = typeof rawSourceTitle === "string" && rawSourceTitle.trim()
      ? rawSourceTitle.trim().slice(0, 120)
      : titleFromFilename(staged.source.originalName);
    const catalog = buildCatalog();
    const byTitle = new Map(catalog.map((entry) => [entry.title.trim().toLowerCase(), entry]));
    const conflicts: string[] = [];
    const addConflict = (message: string) => {
      if (conflicts.length < 8) conflicts.push(message);
    };

    // 在任何文件、索引或审阅记录写入前检查整份草稿。
    const sourceRow = getDb().select().from(sources).where(eq(sources.id, staged.source.id)).get();
    if (!sourceRow) addConflict("原始资料记录已不存在，请重新导入。");

    const summaryTitle = draft.sourceSummary.title.trim() || sourceTitle;
    const summarySkipped = skipped.has(summaryTitle.toLowerCase());
    let existingSummary: ReturnType<typeof loadPageFile> | null = null;
    for (const entry of catalog) {
      if (entry.type !== "source") continue;
      try {
        const file = loadPageFile(entry.id);
        if (file.data.sources.some((source) => source.doc === staged.source.docPath)) {
          existingSummary = file;
          break;
        }
      } catch {
        // 索引里的摘要页已丢失，后续按冲突提示处理。
      }
    }

    if (!summarySkipped && existingSummary) {
      const snapshot = staged.sourceSummarySnapshot;
      if (!snapshot || snapshot.pageId !== existingSummary.pageId) {
        addConflict("来源摘要《" + existingSummary.data.title + "》缺少生成时版本，无法安全覆盖；请重新处理这份资料。");
      } else if (sha256(existingSummary.raw) !== snapshot.expectedHash) {
        addConflict("来源摘要《" + existingSummary.data.title + "》在草稿生成后已修改，请重新处理或先解决冲突。");
      }
    } else if (!summarySkipped) {
      const titleCollision = byTitle.get(summaryTitle.toLowerCase());
      if (titleCollision) addConflict("来源摘要《" + summaryTitle + "》与现有词条重名，请修改标题或重新处理。");
    }

    const newTitles = new Set<string>();
    for (const page of draft.newPages) {
      const key = page.title.trim().toLowerCase();
      if (skipped.has(key)) continue;
      if (!key) addConflict("新词条标题不能为空。");
      else if (newTitles.has(key)) addConflict("草稿内部有多个同名词条《" + page.title + "》，请先修改草稿。");
      else if (byTitle.has(key)) addConflict("《" + page.title + "》在审阅期间已存在，请跳过该词条或重新处理。");
      else if (page.title.trim().length > 120) addConflict("《" + page.title + "》标题超过 120 个字。");
      newTitles.add(key);
    }
    if (!summarySkipped && newTitles.has(summaryTitle.toLowerCase())) {
      addConflict("来源摘要《" + summaryTitle + "》与本次新词条重名，请展开来源摘要并修改标题后再次确认写入。");
    }

    const updateTargets = new Map<string, { pageId: string; hash: string; file: ReturnType<typeof loadPageFile> }>();
    for (const update of draft.updatedPages) {
      const key = update.title.trim().toLowerCase();
      if (skipped.has(key)) continue;
      const entry = byTitle.get(key);
      if (!entry) {
        addConflict("要更新的《" + update.title + "》已不存在，请重新处理。");
        continue;
      }
      const snapshot = staged.draft.updatedPages.find(
        (candidate) => candidate.title.trim().toLowerCase() === key,
      );
      if (!snapshot?.expectedHash) {
        addConflict("《" + update.title + "》缺少生成时版本，无法安全追加或改写；请重新处理。");
        continue;
      }
      try {
        const file = loadPageFile(entry.id);
        if (sha256(file.raw) !== snapshot.expectedHash) {
          addConflict("《" + update.title + "》在草稿生成后已修改，请重新处理或先解决冲突。");
          continue;
        }
        if (update.proposedContent.trim() && !snapshot.originalContent) {
          addConflict("《" + update.title + "》的完整正文快照不完整，请重新处理以避免覆盖。");
          continue;
        }
        updateTargets.set(key, { pageId: entry.id, hash: snapshot.expectedHash, file });
      } catch {
        addConflict("《" + update.title + "》当前无法读取，请刷新知识库后重新处理。");
      }
    }

    if (conflicts.length > 0) {
      throw new ConflictError(
        "这份草稿与当前知识库有冲突，未写入任何内容：" + conflicts.join("；"),
        "导入草稿",
      );
    }

    const creates: Array<Parameters<typeof applyIngestBatch>[0]["creates"][number]> = [];
    const updates: Array<Parameters<typeof applyIngestBatch>[0]["updates"][number]> = [];
    const updatedTitles = new Map<string, number>();

    if (!summarySkipped && !existingSummary) {
      const id = ulid();
      creates.push({
        id,
        type: "source",
        title: summaryTitle,
        content: draft.sourceSummary.content,
        tags: ["来源"],
        sources: [{ doc: staged.source.docPath }],
        confidence: "high",
      });
    } else if (!summarySkipped && existingSummary) {
      updates.push({
        pageId: existingSummary.pageId,
        input: {
          content: draft.sourceSummary.content,
          sources: existingSummary.data.sources.some((source) => source.doc === staged.source.docPath)
            ? existingSummary.data.sources
            : [...existingSummary.data.sources, { doc: staged.source.docPath }],
          expectedHash: staged.sourceSummarySnapshot!.expectedHash,
        },
      });
      updatedTitles.set(existingSummary.pageId, draft.sourceSummary.content.length);
    }

    for (const page of draft.newPages) {
      if (skipped.has(page.title.trim().toLowerCase())) continue;
      const id = ulid();
      creates.push({
        id,
        type: page.type as PageType,
        title: page.title.trim(),
        content: page.content,
        aliases: page.aliases,
        tags: page.tags,
        confidence: page.confidence,
        sources: page.citations.map((citation) => ({
          doc: staged.source.docPath,
          ...(citation.page ? { page: citation.page } : {}),
          quote: truncate(citation.quote, 200),
        })),
      });
    }

    for (const update of draft.updatedPages) {
      const key = update.title.trim().toLowerCase();
      if (skipped.has(key)) continue;
      const target = updateTargets.get(key)!;
      const appended = update.appendContent.trim();
      const proposed = update.proposedContent.trim() ? update.proposedContent : undefined;
      const nextContent = proposed ?? (
        appended ? target.file.content.trim() + "\n\n" + appended : target.file.content
      );
      const sourceRefs = [
        ...target.file.data.sources,
        ...update.citations.map((citation) => ({
          doc: staged.source.docPath,
          ...(citation.page ? { page: citation.page } : {}),
          quote: truncate(citation.quote, 200),
        })),
      ];
      const mergedSources = [...new Map(
        sourceRefs.map((ref) => [ref.doc + ":" + (ref.page ?? "") + ":" + (ref.quote ?? ""), ref]),
      ).values()];
      updates.push({
        pageId: target.pageId,
        input: {
          content: nextContent,
          aliases: [...new Set([...target.file.data.aliases, ...update.addAliases])],
          tags: [...new Set([...target.file.data.tags, ...update.addTags])],
          sources: mergedSources,
          expectedHash: target.hash,
        },
      });
      const changes = proposed ? diffChars(target.file.content, nextContent, { timeout: 100 }) : undefined;
      updatedTitles.set(target.pageId, proposed ? changes?.reduce((count, part) => count + (part.added ? part.value.length : 0), 0) ?? nextContent.length : appended.length);
    }

    const byTitleAfter = buildTitleIndex([
      ...catalog.map((entry) => ({ id: entry.id, title: entry.title })),
      ...creates.map(({ id, title }) => ({ id, title })),
    ]);
    const decisionsByIndex = new Map((options.decisions ?? []).map((decision) => [decision.index, decision]));
    const supplemented = supplementContradictions(staged.analysis, draft.reviewItems, sourceTitle);
    const allItems = [...draft.reviewItems, ...supplemented];
    const insertedIds = allItems.map(() => ulid());
    const now = localISOString();
    const answeredIds: string[] = [];

    const applied = applyIngestBatch({
      creates,
      updates,
      message: "导入《" + staged.source.originalName + "》：新建 " + creates.length + " 个词条，更新 " + updates.length + " 个，" + allItems.length + " 条审阅事项",
      beforeCommit: () => {
        allItems.forEach((item, index) => {
          const verdict = decisionsByIndex.get(index);
          const clean = normalizeQuestion({ question: item.question, options: item.options }, item.title);
          const relatedTitles = item.relatedTitles ?? [];
          const oversizedRelatedTitles = relatedTitles.length > 12;
          const safeRelatedTitles = oversizedRelatedTitles ? [] : relatedTitles;
          // 新交互把「批注」也作为提交内容交给模型；保留 note 回退以兼容旧草稿。
          const submittedAnswer = verdict?.answer?.trim() || (!verdict?.decision ? verdict?.note?.trim() : "") || "";
          const answered = !verdict?.decision && Boolean(submittedAnswer);

          getDb()
            .insert(reviewItems)
            .values({
              id: insertedIds[index],
              kind: item.kind,
              title: item.title,
              detail: oversizedRelatedTitles
                ? item.detail + "\n\n系统提示：关联词条数量异常，已清空关联，请在审阅时人工核对。"
                : item.detail,
              severity: item.severity,
              relatedPagesJson: JSON.stringify(relatedPagesFromTitles(safeRelatedTitles, byTitleAfter)),
              question: clean.question,
              optionsJson: clean.options.length > 0 ? JSON.stringify(clean.options) : null,
              ...(answered
                ? {
                    answer: submittedAnswer.slice(0, MAX_ANSWER_LENGTH),
                    answerChoiceId: verdict!.choiceId ?? null,
                    answerSource: verdict!.choiceId ? "option" : "freeform",
                    answeredAt: now,
                  }
                : {}),
              status: verdict?.decision ?? (answered ? "answered" : "pending"),
              decisionNote: verdict?.note?.trim() || null,
              resolvedAt: verdict?.decision ? now : null,
              createdAt: now,
            })
            .run();
          if (answered) answeredIds.push(insertedIds[index]);
        });

        getDb()
          .update(sources)
          .set({ status: "parsed" })
          .where(eq(sources.id, staged.source.id))
          .run();
        getDb()
          .update(jobs)
          .set({
            status: "done",
            stage: "committing",
            progress: 100,
            message: "已写入 " + creates.length + " 个词条",
            draftJson: null,
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(jobs.id, options.jobId))
          .run();
      },
    });

    try {
      finishJob(options.jobId, {
        status: "done",
        stage: "committing",
        progress: 100,
        message: "已写入 " + applied.created.length + " 个词条",
        clearDraft: true,
      });
    } catch (error) {
      // 状态已在文件批次的 SQLite 事务里收尾；推送失败不应让客户端重试写入。
      console.error("[ingest] 导入已写入，但任务状态事件未发送：", error);
    }

    let batchJobId: string | null = null;
    if (answeredIds.length > 0 && isLlmConfigured()) {
      try {
        batchJobId = startReviewBatch({ mode: "answers", itemIds: answeredIds }).jobId;
      } catch (error) {
        console.error("[ingest] 导入已写入，回答处理任务启动失败：", error);
      }
    }

    try { clearCheckpoint(staged.source.id); fs.rmSync(ingestInputPath(options.jobId), { force: true }); } catch { /* 已写入，缓存清理失败不改变结果。 */ }
    return {
      createdPages: applied.created.map((entry) => ({
        id: entry.pageId,
        title: entry.title,
        path: entry.relativePath,
      })),
      updatedPages: applied.updated.map((entry) => ({
        id: entry.pageId,
        title: entry.title,
        addedChars: updatedTitles.get(entry.pageId) ?? 0,
      })),
      reviewItemCount: allItems.length,
      supplementedContradictions: supplemented.length,
      batchJobId,
      commitSha: applied.commitSha,
      backupWarning: applied.backupWarning,
      conflicts: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "提交失败，草稿已保留。";
    releaseAwaitingReview(options.jobId, message);
    getDb().update(sources).set({ status: "awaiting_review" }).where(eq(sources.id, staged.source.id)).run();
    throw error;
  }
}

/** 丢弃一次导入的草稿（用户点了取消） */
export function discardIngest(jobId: string): void {
  const staged = readDraft<IngestDraft>(jobId);
  if (!staged) return;
  if (!claimAwaitingReview(jobId, "discarding")) {
    throw new ConflictError("这份草稿已被提交、放弃，或正在由另一个请求处理。", "导入草稿");
  }

  try {
    // 原件保留在 raw/ 下 —— 用户可能只是想稍后再处理，不该把资料删掉。
    appendLog("INGEST", `放弃导入《${staged.source.originalName}》的草稿，原件保留在 ${staged.source.docPath}`);
    backupVault(`放弃导入《${staged.source.originalName}》`);
    getDb()
      .update(sources)
      .set({ status: "pending" })
      .where(eq(sources.id, staged.source.id))
      .run();
    clearCheckpoint(staged.source.id);
    fs.rmSync(ingestInputPath(jobId), { force: true });
    finishJob(jobId, {
      status: "cancelled",
      message: "这次导入已放弃，原件保留在 raw/",
      clearDraft: true,
    });
  } catch (error) {
    releaseAwaitingReview(jobId, error instanceof Error ? error.message : undefined);
    throw error;
  }
}

/** 来源已经有未完成的导入草稿时，禁止并行重新处理同一原件。 */
export function hasUnfinishedIngestDraft(sourceId: string): boolean {
  const rows = getDb()
    .select({ status: jobs.status, draftJson: jobs.draftJson })
    .from(jobs)
    .where(eq(jobs.kind, "ingest"))
    .all();
  return rows.some((row) => {
    if (!row.draftJson || !["awaiting_review", "committing", "discarding", "failed"].includes(row.status)) return false;
    try {
      return (JSON.parse(row.draftJson) as { source?: { id?: string } }).source?.id === sourceId;
    } catch {
      return false;
    }
  });
}

/** 供 API 层查询草稿 */
export { readDraft as loadIngestDraft };

/** 已导入的来源列表 */
export function listSources(limit = 100) {
  return getDb()
    .select()
    .from(sources)
    .all()
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      docPath: row.docPath,
      originalName: row.originalName,
      title: row.title,
      byteSize: row.byteSize,
      pageCount: row.pageCount,
      parser: row.parser,
      status: row.status,
      importedAt: row.importedAt,
    }));
}
