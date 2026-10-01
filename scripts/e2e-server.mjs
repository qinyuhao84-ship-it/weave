import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-e2e-'));
// 先加载，再覆盖所有模型变量，避免作者本机 .env 影响隔离测试。
const { loadLocalEnv } = await import('./env.mjs');
loadLocalEnv('start');
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key, key.startsWith('WEAVE_LLM_') ? '' : value]));
const environment = { ...cleanEnvironment, WEAVE_VAULT: vault, WEAVE_CONFIG_DIR: path.join(vault, '.config'), WEAVE_LLM_BASE_URL: '', WEAVE_LLM_API_KEY: '', WEAVE_LLM_MODEL: '', DOCLING_ENDPOINT: 'http://127.0.0.1:3301' };
const mock = spawn(process.execPath, ['tests/e2e/mock-model.mjs'], { env: environment, stdio: 'inherit' });
for (let attempt = 0; attempt < 50; attempt++) {
  try { if ((await fetch('http://127.0.0.1:3301/health')).ok) break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
  if (attempt === 49) { mock.kill('SIGTERM'); throw new Error('Mock model did not become ready'); }
}
const server = spawn(process.execPath, ['scripts/with-docling.mjs', 'start', '-p', '3300'], { env: environment, stdio: 'inherit' });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  mock.kill('SIGTERM'); server.kill('SIGTERM');
}
process.once('SIGTERM', stop); process.once('SIGINT', stop);
server.on('exit', code => { stop(); fs.rmSync(vault, { recursive: true, force: true }); process.exitCode = code ?? 0; });
mock.on('exit', code => { if (!stopping) { console.error('Mock model exited unexpectedly'); stop(); process.exitCode = code ?? 1; } });
