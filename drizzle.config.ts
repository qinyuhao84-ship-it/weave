import { defineConfig } from "drizzle-kit";
import path from "node:path";
import os from "node:os";
import { loadEnvConfig } from "@next/env";
import { resolveVaultRoot } from "./lib/vault/location";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
const vaultRoot = resolveVaultRoot(path.join(os.homedir(), "Documents", "织识"));

export default defineConfig({
  dialect: "sqlite",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: path.join(vaultRoot, ".weave", "weave.db"),
  },
  verbose: true,
  strict: false,
});
