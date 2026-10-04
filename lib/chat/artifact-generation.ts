import { createDocument } from "@mixmark-io/domino";
import { buildContextBlock, wrapUntrusted, type ContextChunk } from "@/lib/llm/prompts";
import { LlmError, type LlmProvider } from "@/lib/llm/types";
import { enqueue, getJob } from "@/lib/jobs/runner";
import { chatProvider } from "./config-server";
import type { ChatConfig, ChatArtifact } from "./config";
import type { CitationView } from "./citations";
import { estimateMessagesContextTokens } from "./tokens";
import { SHOW_ME_PROMPT, HtmlAnswerStream, getArtifact, prepareHtml, saveArtifact, updateArtifact, htmlCitationReport } from "./artifacts";

type ArtifactInput = {
  sessionId: string;
  messageId: string;
  question: string;
  text: string;
  chunks: ContextChunk[];
  citations: CitationView[];
  config: ChatConfig;
};

export function queueAnswerArtifact(input: ArtifactInput, provider?: LlmProvider): ChatArtifact {
  const artifact = saveArtifact({ messageId: input.messageId, content: "", status: "pending" });
  enqueueArtifact(artifact.id, input, false, provider);
  return artifact;
}

export function retryAnswerArtifact(id: string): void {
  const artifact = getArtifact(id);
  const job = getJob(id);
  if (!artifact || job?.kind !== "chat_artifact" || !["failed", "cancelled"].includes(job.status)) {
    throw new LlmError("这个交互页面无法重新生成，请刷新对话后重试。", 409);
  }
  updateArtifact(id, "", "pending");
  enqueueArtifact(id, job.payload as ArtifactInput, true);
}

function enqueueArtifact(id: string, input: ArtifactInput, resume: boolean, injected?: LlmProvider): void {
  enqueue({ jobId: id, kind: "chat_artifact", payload: input, resume, handler: async context => {
    context.throwIfCancelled();
    if (!getArtifact(id)) throw new LlmError("交互页面所属的对话已移除。", 404);
    context.setStage("generating", "文字回答已完成，正在生成交互页面");
    // 页面只使用已经完成的回答和它的引用，沿用本轮证据编号。
    const chunks = input.chunks.filter(chunk => input.citations.some(citation => citation.index === chunk.index));
    const provider = injected ?? chatProvider(input.config);
    const stream = new HtmlAnswerStream();
    const messages = [
        { role: "system", content: SHOW_ME_PROMPT + "\n普通回答已经完成。这次只输出完整 HTML，放在 <weave-html> 与 </weave-html> 之间。根据已完成回答制作交互页面，保留它的结论与引用编号，不加入新的事实。" },
        { role: "user", content: `${buildContextBlock(chunks)}\n\n${wrapUntrusted(input.question, "用户问题")}\n\n${wrapUntrusted(input.text, "已完成的回答")}` },
      ] as const;
    if (estimateMessagesContextTokens([...messages]) > input.config.contextWindow) throw new LlmError("交互页面资料超过所选模型的上下文容量，请缩小问题范围。", 400);
    const iterator = provider.stream({
      sessionId: input.sessionId,
      signal: context.signal,
      messages: [...messages],
    });
    let step = await iterator.next();
    while (!step.done) {
      context.throwIfCancelled();
      stream.push(step.value);
      step = await iterator.next();
    }
    stream.finish();
    context.throwIfCancelled();
    if (step.value.truncated || !stream.complete) throw new LlmError("交互页面尚未生成完整，可以重新生成。", 502);
    const document = createDocument(stream.html);
    if (!/<html\b/i.test(stream.html) || !/<body\b/i.test(stream.html) || !/<\/html\s*>/i.test(stream.html) || !document.body.textContent?.trim()) {
      throw new LlmError("模型没有返回完整的交互页面，可以重新生成。", 502);
    }
    if (htmlCitationReport(stream.html, chunks).hallucinatedIndices.length) throw new LlmError("交互页面包含无效的来源引用，可以重新生成。", 502);
    context.setStage("validating", "正在检查页面并保存");
    if (!getArtifact(id)) throw new LlmError("交互页面所属的对话已移除。", 404);
    updateArtifact(id, prepareHtml(stream.html, chunks, input.citations), "ready");
    return { artifactId: id };
  } });
}
