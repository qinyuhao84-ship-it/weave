import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { loadEnvConfig } from "@next/env";
import type { RetrievalModelSettings } from "../../lib/settings";

/** 不导入应用配置模块：它可能打开真实库的写连接。 */
export function loadEvaluationEnv() { loadEnvConfig(process.cwd(), false, { info() {}, error() {} }); }
export function readRetrievalConfig(): RetrievalModelSettings {
  loadEvaluationEnv();
  const directory = process.env.WEAVE_CONFIG_DIR || path.join(os.homedir(), process.platform === "darwin" ? "Library/Application Support/Weave" : ".config/weave");
  let location: { activeRoot?: string } = {}; try { location = JSON.parse(fs.readFileSync(path.join(directory, "vault-location.json"), "utf8")); } catch {}
  const root = process.env.WEAVE_VAULT || location.activeRoot || path.join(os.homedir(), "Documents/织识");
  const file = path.join(root, ".weave/weave.db");
  let saved: Partial<RetrievalModelSettings> = {};
  if (fs.existsSync(file)) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try { saved = JSON.parse((db.prepare("SELECT value_json FROM settings LIMIT 1").get() as { value_json?: string } | undefined)?.value_json || "{}").retrievalModel || {}; } finally { db.close(); }
  }
  const config: RetrievalModelSettings = { enabled: true, baseUrl: saved.baseUrl || "https://api.siliconflow.cn/v1", apiKey: process.env.WEAVE_EVAL_RETRIEVAL_API_KEY || saved.apiKey || "", embeddingModel: "BAAI/bge-m3", rerankModel: "BAAI/bge-reranker-v2-m3", chunkChars: 2000 };
  if (new URL(config.baseUrl).origin !== "https://api.siliconflow.cn" || !config.apiKey) throw new Error("缺少既定免费检索入口的配置；不会切换付费模型或其他服务");
  return config;
}

export function isolateVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weave-real-eval-"));
  process.env.WEAVE_VAULT = root; process.env.WEAVE_CONFIG_DIR = path.join(root, "config");
  for (const name of Object.keys(process.env)) if (name.startsWith("WEAVE_LLM_")) delete process.env[name];
  return root;
}
