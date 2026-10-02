import path from "node:path";
import { parseArgs } from "node:util";
import { prepare } from "./eval/prepare";
import { measure } from "./eval/run";
import { freeze, compare } from "./eval/report";
import { answerEvaluation, reviewAnswers } from "./eval/answers";
import { experiment } from "./eval/experiment";

const [command, ...arguments_] = process.argv.slice(2).filter(argument => argument !== "--");
const controller = new AbortController();
const cancel = () => controller.abort(new Error("评测已取消，逐题进度已保留"));
process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
try {
  const { values } = parseArgs({ args: arguments_, options: { data: { type: "string", default: ".eval-cache/dataset-v2" }, cache: { type: "string", default: ".eval-cache/retrieval.sqlite" }, out: { type: "string" }, methods: { type: "string", default: "original,current,bm25,vector,rrf-rerank" }, split: { type: "string", default: "dev" }, suite: { type: "string", default: "retrieval" }, dev: { type: "string" }, freeze: { type: "string" }, original: { type: "string" }, previous: { type: "string" }, baseline: { type: "string" }, seed: { type: "string", default: "20261002" }, reviews: { type: "string" }, offline: { type: "boolean", default: false } } });
  let result: unknown;
  if (command === "prepare") {
    const seed = Number(values.seed); if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed 必须为 uint32");
    result = await prepare(path.resolve(values.data!), path.resolve(path.dirname(values.cache!), "downloads"), seed, values.previous);
  } else if (command === "measure") {
    if (!values.out || !["dev", "test"].includes(values.split!) || !["retrieval", "evidence"].includes(values.suite!)) throw new Error("measure 需要 --out；split=dev|test，suite=retrieval|evidence");
    result = await measure({ directory: path.resolve(values.data!), cacheFile: path.resolve(values.cache!), output: path.resolve(values.out), methods: values.methods!.split(","), split: values.split as "dev" | "test", suite: values.suite as "retrieval" | "evidence", offline: values.offline, freeze: values.freeze, original: values.original, signal: controller.signal });
  } else if (command === "freeze") {
    if (!values.dev || !values.out) throw new Error("freeze 需要 --dev 和 --out"); result = freeze(values.dev, values.out);
  } else if (command === "compare") {
    if (!values.dev || !values.out || !values.baseline) throw new Error("compare 需要 --dev（待比较结果目录）、--baseline 和 --out"); result = compare(values.dev, values.baseline, values.out);
  } else if (command === "answers") {
    if (!values.out) throw new Error("answers 需要 --out"); result = await answerEvaluation(values.data!, values.out, values.cache!, controller.signal);
  } else if (command === "review") {
    if (!values.out || !values.reviews) throw new Error("review 需要 --out（问答结果目录）和 --reviews"); result = reviewAnswers(values.data!, values.out, values.reviews);
  } else if (command === "experiment") {
    if (!values.out || !values.dev) throw new Error("experiment 需要 --dev 和 --out"); result = experiment(values.data!, values.dev, values.out);
  } else throw new Error("用法：pnpm eval <prepare|measure|experiment|freeze|compare|answers|review>；完整说明见 docs/retrieval-evaluation.md");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  const message = error instanceof SyntaxError || error instanceof TypeError ? "配置、数据或响应无效，未输出原始内容" : error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[端点已脱敏]") : "未知错误";
  process.stderr.write(`评测未完成：${message}\n`); process.exitCode = 1;
} finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
