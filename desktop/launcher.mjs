import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const resources = path.dirname(fileURLToPath(import.meta.url));
const testRoot = process.env.WEAVE_DESKTOP_TEST_ROOT;
const support = testRoot || path.join(os.homedir(), 'Library', 'Application Support', 'Weave');
fs.mkdirSync(support, { recursive: true });
const log = fs.createWriteStream(path.join(support, 'desktop.log'), { flags: 'w', mode: 0o600 });
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const environment = { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', PATH: `${path.join(resources, 'runtime', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` };
for (const key of Object.keys(environment)) if (key.startsWith('WEAVE_EVAL_')) delete environment[key];
if (testRoot) { environment.WEAVE_VAULT = path.join(testRoot, 'vault'); environment.WEAVE_CONFIG_DIR = path.join(testRoot, 'config'); }
const server = spawn(process.execPath, ['server.js'], { cwd: path.join(resources, 'server'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
let ready = false; let startupLog = "";
server.stdout.on('data', chunk => { log.write(chunk); startupLog = (startupLog + chunk.toString()).slice(-4096); if (startupLog.includes('Ready in')) ready = true; });
server.stderr.on('data', chunk => log.write(chunk));
server.once('error', () => { process.stderr.write('无法启动本地服务，请查看 desktop.log\n'); process.exitCode = 1; });
server.once('close', code => { log.end(); process.exit(code || 0); });
const stop = () => { if (server.exitCode === null) server.kill('SIGTERM'); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
const url = `http://127.0.0.1:${port}`;
let healthy = false;
for (let attempt = 0; attempt < 600 && server.exitCode === null; attempt++) {
  if (ready) { try { healthy = (await fetch(`${url}/api/pages`, { signal: AbortSignal.timeout(1000) })).ok; } catch {} }
  if (healthy) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!healthy) { process.stderr.write('本地服务未能在一分钟内就绪，请查看 desktop.log\n'); stop(); process.exitCode = 1; }
else process.stdout.write(JSON.stringify({ url }) + '\n');
