import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function readLines<T>(file: string): T[] { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
export function writeJson(file: string, data: unknown) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.tmp`; fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(temporary, file); }
export function writeLines(file: string, rows: unknown[]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 }); }
