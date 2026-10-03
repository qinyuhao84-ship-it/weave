import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const defaultResources = path.dirname(fileURLToPath(import.meta.url));
const LOG_LIMIT = 2 * 1024 * 1024;

// 保留上两次启动的证据，且限制每份日志大小；重启不能覆盖刚发生的故障。
function openLog(support) {
  fs.mkdirSync(support, { recursive: true, mode: 0o700 });
  const filename = path.join(support, 'desktop.log');
  let descriptor;
  let bytes = 0;
  const rotate = () => {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(`${filename}.2`, { force: true });
    if (fs.existsSync(`${filename}.1`)) fs.renameSync(`${filename}.1`, `${filename}.2`);
    if (fs.existsSync(filename)) fs.renameSync(filename, `${filename}.1`);
    descriptor = fs.openSync(filename, 'w', 0o600);
    bytes = 0;
  };
  rotate();
  return {
    write(chunk) {
      const data = Buffer.from(chunk);
      if (bytes + data.length > LOG_LIMIT) rotate();
      const bounded = data.subarray(Math.max(0, data.length - LOG_LIMIT));
      fs.writeSync(descriptor, bounded); bytes += bounded.length;
    },
    close() { fs.closeSync(descriptor); },
  };
}

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

// 参数只供隔离的子进程回归使用，安装应用固定使用一分钟启动和八秒退出上限。
export async function launchDesktop({ resources = defaultResources, environment = process.env, startupMs = 60_000, shutdownMs = 8_000, onReady = record => process.stdout.write(JSON.stringify(record) + '\n'), monitorParent = false } = {}) {
  const testRoot = environment.WEAVE_DESKTOP_TEST_ROOT;
  const support = testRoot || path.join(os.homedir(), 'Library', 'Application Support', 'Weave');
  const log = openLog(support);
  const started = Date.now();
  let server;
  let stopping = false;
  let failure = false;
  let exited = false;
  let forceTimer;
  let parentTimer;
  const startupAbort = new AbortController();
  const diagnostic = message => { log.write(`[desktop] ${new Date().toISOString()} ${message}\n`); process.stderr.write(message + '\n'); };
  const stop = () => {
    if (stopping) return;
    stopping = true; startupAbort.abort();
    if (!server || exited) return;
    log.write('[desktop] 正在停止本地服务。\n');
    server.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      if (!exited) { diagnostic('本地服务退出超时，已终止进程；下次启动将执行恢复检查。'); server.kill('SIGKILL'); }
    }, shutdownMs);
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    const port = await availablePort();
    const childEnvironment = { ...environment, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', PATH: `${path.join(resources, 'runtime', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` };
    for (const key of Object.keys(childEnvironment)) if (key.startsWith('WEAVE_EVAL_')) delete childEnvironment[key];
    if (testRoot) {
      for (const key of Object.keys(childEnvironment)) if (key.startsWith('WEAVE_LLM_')) delete childEnvironment[key];
      childEnvironment.WEAVE_VAULT = path.join(testRoot, 'vault'); childEnvironment.WEAVE_CONFIG_DIR = path.join(testRoot, 'config');
    }
    if (stopping) return 0;
    server = spawn(process.execPath, ['server.js'], { cwd: path.join(resources, 'server'), env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => server.once('close', (code, signal) => {
      exited = true; startupAbort.abort();
      if (!stopping) { failure = true; diagnostic(`本地服务意外停止（${signal || code || '正常退出'}），请查看 desktop.log。`); }
      resolve();
    }));
    server.stdout.on('data', chunk => log.write(chunk)); server.stderr.on('data', chunk => log.write(chunk));
    server.once('error', () => { failure = true; diagnostic('无法启动本地服务，请查看 desktop.log。'); });
    if (monitorParent) {
      const parentPid = process.ppid;
      parentTimer = setInterval(() => { if (process.ppid !== parentPid) stop(); }, 1000);
      parentTimer.unref();
    }
    const url = `http://127.0.0.1:${port}`;
    const deadline = started + startupMs;
    let healthy = false;
    while (!exited && !stopping && Date.now() < deadline) {
      try {
        const remaining = Math.max(1, Math.min(1000, deadline - Date.now()));
        const response = await fetch(`${url}/api/pages?limit=1`, { signal: AbortSignal.any([startupAbort.signal, AbortSignal.timeout(remaining)]) });
        healthy = response.ok && (await response.json()).ok === true;
      } catch { /* 尚未监听或正在恢复时，在同一真实截止时间内重试。 */ }
      if (healthy) break;
      try { await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal: startupAbort.signal }); } catch { break; }
    }
    if (healthy && !stopping && !exited) {
      log.write(`[desktop] 就绪，用时 ${Date.now() - started} ms。\n`);
      onReady({ url, startupMs: String(Date.now() - started), serverPid: String(server.pid) });
    } else if (!stopping && !exited) {
      failure = true; diagnostic('本地服务未能在启动期限内就绪，请查看 desktop.log。'); stop();
    }
    await closed;
    return failure ? 1 : 0;
  } finally {
    clearTimeout(forceTimer); clearInterval(parentTimer);
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); log.close();
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isDirectExecution()) {
  try { process.exitCode = await launchDesktop({ monitorParent: true }); }
  catch { process.stderr.write('无法初始化桌面服务或日志目录。请检查应用支持目录的权限和剩余空间。\n'); process.exitCode = 1; }
}
