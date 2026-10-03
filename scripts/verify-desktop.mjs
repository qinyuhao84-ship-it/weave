import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { bundleInventory, sourceFingerprint } from './desktop-package-utils.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceOnly = process.argv.includes('--service-only');
const keepOpen = process.argv.includes('--keep-open');
const dmgArgument = process.argv.slice(2).find(argument => !argument.startsWith('--'));
const dmg = dmgArgument ? path.resolve(dmgArgument) : null;
if (serviceOnly && keepOpen) throw new Error('--service-only 不启动 Cocoa 窗口，不能与 --keep-open 同时使用。');
if (process.platform !== 'darwin' || !dmg || !fs.existsSync(dmg)) {
  throw new Error('用法：pnpm verify:desktop -- <macOS arm64 DMG 路径>；验收需在 macOS 上运行。');
}

const packageVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const reportPath = path.join(path.dirname(dmg), `Weave-${packageVersion}-macOS-arm64.acceptance.json`);
const report = {
  version: packageVersion,
  platform: process.platform,
  architecture: process.arch,
  executionMode: serviceOnly ? 'launcher-service-only' : 'native-app',
  testedAt: new Date().toISOString(),
  dmg: { path: path.basename(dmg), bytes: fs.statSync(dmg).size, sha256: hashFile(dmg) },
  nativeAppLaunched: false,
  isolation: '临时知识库与临时配置目录；启动进程使用 PATH=/usr/bin:/bin；未读取或修改日常知识库与模型凭据。',
  checks: [],
  result: 'running',
};
let temporary;
let mountPoint;
let mounted = false;
let fakeModel;
let activeApp;
const trackedPids = new Set();
const packageProcesses = [];

function hashFile(filename) { return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
function check(name, passed, detail) {
  report.checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  if (!passed) throw new Error(`桌面验收失败：${name}${detail ? `（${detail}）` : ''}`);
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} 失败：${(result.stderr || result.stdout || `退出码 ${result.status}`).trim()}`);
  return result.stdout;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function getProcess(pid) {
  try {
    const output = run('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,stat=,command=']);
    const match = output.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\s\S]+)$/);
    return match ? { pid: Number(match[1]), parent: Number(match[2]), state: match[3], command: match[4] } : null;
  } catch { return null; }
}
function processTable() {
  const output = run('/bin/ps', ['-axo', 'pid=,ppid=,stat=,command=']);
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\s\S]+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), state: match[3], command: match[4] }] : [];
  });
}
function descendants(rootPid, table = processTable()) {
  const result = [];
  const parents = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of table) if (!parents.has(process.pid) && parents.has(process.parent)) {
      parents.add(process.pid); result.push(process); changed = true;
    }
  }
  return result;
}
function lsofNames(pid, selector) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), ...selector, '-Fn'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1)) : [];
}
function listeningPorts(pid) {
  const ports = lsofNames(pid, ['-iTCP', '-sTCP:LISTEN']).flatMap(name => {
    const match = name.match(/^127\.0\.0\.1:(\d+)$/);
    return match ? [Number(match[1])] : [];
  });
  return [...new Set(ports)];
}
function packagedNodeForPid(pid, runtimeBin) {
  const expected = fs.realpathSync(path.join(runtimeBin, 'node'));
  return lsofNames(pid, ['-d', 'txt']).find(filename => {
    try { return fs.realpathSync(filename) === expected; } catch { return false; }
  }) ?? null;
}
function isAlive(pid) { const process = getProcess(pid); return Boolean(process && !process.state.includes('Z')); }
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function waitFor(predicate, label, timeout = 90_000, interval = 200) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await predicate(); if (result) return result; }
    catch (error) { if (error?.fatal) throw error; lastError = error; }
    await sleep(interval);
  }
  throw new Error(`${label} 超时${lastError instanceof Error ? `：${lastError.message}` : ''}`);
}
async function getApi(baseURL, route, init) {
  const response = await fetch(`${baseURL}${route}`, { signal: AbortSignal.timeout(8_000), ...init });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${route} 返回非 JSON（HTTP ${response.status}）。`); }
  if (!response.ok || payload?.ok !== true) throw new Error(`${route} 请求失败（HTTP ${response.status}）：${payload?.error ?? '未知错误'}`);
  return payload.data;
}
async function startNativeApp(appPath, testRoot) {
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Weave');
  const child = spawn(executable, [], {
    env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LANG: 'zh_CN.UTF-8', WEAVE_DESKTOP_TEST_ROOT: testRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let outputBytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      if (outputBytes >= 16_384) return;
      const captured = String(chunk).slice(0, 16_384 - outputBytes);
      output += captured; outputBytes += Buffer.byteLength(captured);
    });
  }
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.once('error', error => { child.startError = error; });
  if (child.pid) trackedPids.add(child.pid);
  const app = { child, closed, executable, testRoot, output: () => output };
  packageProcesses.push(app);
  return app;
}
async function startLauncher(appPath, testRoot) {
  let output = '';
  const resources = path.join(appPath, 'Contents', 'Resources');
  const executable = path.join(resources, 'runtime', 'bin', 'node');
  const child = spawn(executable, [path.join(resources, 'launcher.mjs')], {
    env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin', HOME: os.homedir(), LANG: 'zh_CN.UTF-8', WEAVE_DESKTOP_TEST_ROOT: testRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.once('error', error => { child.startError = error; });
  if (child.pid) trackedPids.add(child.pid);
  const app = { child, closed, executable, appPath, output: () => output };
  packageProcesses.push(app);
  return app;
}
async function waitForApp(baseApp, appPath, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  const runtimeBin = path.join(appPath, 'Contents', 'Resources', 'runtime', 'bin');
  const diagnostics = () => {
    const details = [];
    if (baseApp.output().trim()) details.push(`原生 stdout/stderr：${baseApp.output().slice(-8_000)}`);
    const logPath = path.join(baseApp.testRoot, 'desktop.log');
    if (fs.existsSync(logPath)) details.push(`隔离 desktop.log：${fs.readFileSync(logPath, 'utf8').slice(-8_000)}`);
    return details.length ? `\n${details.join('\n')}` : '';
  };
  while (Date.now() < deadline) {
    if (baseApp.child.startError) throw baseApp.child.startError;
    if (baseApp.child.exitCode !== null) throw new Error(`原生应用启动后立即退出（${baseApp.child.signalCode ?? baseApp.child.exitCode}）。${diagnostics()}`);
    const tree = descendants(baseApp.child.pid);
    const launcher = tree.find(process => process.command.includes('launcher.mjs'));
    const server = launcher && tree.find(process => {
      const parent = tree.find(candidate => candidate.pid === process.parent);
      return parent?.pid === launcher.pid && listeningPorts(process.pid).length > 0;
    });
    if (server) {
      trackedPids.add(server.pid);
      const port = listeningPorts(server.pid)[0];
      const nodeExecutable = packagedNodeForPid(server.pid, runtimeBin);
      if (!nodeExecutable) throw new Error(`服务进程没有映射包内 Node：${server.command}`);
      if (port) {
        const baseURL = `http://127.0.0.1:${port}`;
        try {
          const ready = await getApi(baseURL, '/api/pages?limit=1');
          return { baseURL, nativePid: baseApp.child.pid, serverPid: server.pid, nodeExecutable, ready };
        } catch { /* Wait for Next.js to finish startup. */ }
      }
    }
    await sleep(250);
  }
  throw new Error(`实际原生应用没有启动包内服务。${diagnostics()}`);
}
async function waitForLauncher(app, timeout = 90_000) {
  return await waitFor(async () => {
    if (app.child.startError) throw app.child.startError;
    if (app.child.exitCode !== null) throw new Error(`包内启动器立即退出（${app.child.signalCode ?? app.child.exitCode}）：${app.output()}`);
    const line = app.output().split('\n').find(item => item.startsWith('{"url"'));
    if (!line) return null;
    const record = JSON.parse(line);
    if (!record.url || !record.serverPid) return null;
    const serverPid = Number(record.serverPid);
    trackedPids.add(serverPid);
    const ready = await getApi(record.url, '/api/pages?limit=1');
    return { baseURL: record.url, nativePid: app.child.pid, serverPid, ready };
  }, 'DMG 内置启动器', timeout, 250);
}
async function startPackageApp(appPath, testRoot) {
  return serviceOnly ? startLauncher(appPath, testRoot) : startNativeApp(appPath, testRoot);
}
async function waitForPackageApp(app, appPath) {
  return serviceOnly ? waitForLauncher(app) : waitForApp(app, appPath);
}
async function stopNativeApp(app) {
  if (!app?.child?.pid || !isAlive(app.child.pid)) return;
  app.child.kill('SIGTERM');
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), 12_000));
  const result = await Promise.race([app.closed, timeout]);
  if (result === null && isAlive(app.child.pid)) {
    app.child.kill('SIGKILL');
    await Promise.race([app.closed, new Promise(resolve => setTimeout(resolve, 3_000))]);
  }
}
async function waitPidsStopped(pids, timeout = 10_000) {
  const stillRunning = () => [...pids].filter(isAlive);
  await waitFor(() => stillRunning().length === 0, '应用、启动器与本地服务完全退出', timeout, 100);
}
function unwrapFileTree(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) files.push({ path: relative, link: fs.readlinkSync(absolute) });
      else if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.push({ path: relative, bytes: stat.size, sha256: hashFile(absolute) });
    }
  }
  visit(root);
  return files;
}
function manifestHash(files) { return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'); }
function backupTree(source, destination) {
  fs.cpSync(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
  const original = unwrapFileTree(source);
  const copy = unwrapFileTree(destination);
  return { matches: JSON.stringify(original) === JSON.stringify(copy), fileCount: original.filter(file => !file.link).length, sha256: manifestHash(original) };
}
function copyAppBundle(source, destination) {
  run('/usr/bin/ditto', [source, destination]);
}
async function startupDuration(testRoot) {
  // API 可能先于启动器下一轮探测就绪；等待启动器自己的记录，避免健康检查竞态。
  const record = await waitFor(() => {
    const log = fs.readFileSync(path.join(testRoot, 'desktop.log'), 'utf8');
    const matches = [...log.matchAll(/就绪，用时\s+(\d+)\s*ms/g)];
    return matches.length ? { ms: Number(matches[matches.length - 1][1]) } : null;
  }, `隔离启动日志中的就绪耗时 ${testRoot}`, 10_000, 100);
  return record.ms;
}
async function waitForJob(baseURL, jobId, timeout = 180_000) {
  return await waitFor(async () => {
    const job = await getApi(baseURL, `/api/jobs/${jobId}`);
    if (job.status === 'failed' || job.status === 'cancelled') {
      const error = new Error(`后台任务${job.status}：${job.error ?? ''}`); error.fatal = true; throw error;
    }
    if (job.status === 'awaiting_review' || job.status === 'done') return job;
    return null;
  }, `导入任务 ${jobId}`, timeout, 250);
}
async function uploadFile(baseURL, fileName, bytes) {
  const form = new FormData();
  form.set('file', new File([bytes], fileName));
  const staged = await getApi(baseURL, '/api/ingest/queue', { method: 'POST', body: form });
  const started = await getApi(baseURL, `/api/ingest/queue/${staged.id}/start`, { method: 'POST' });
  return { queueId: staged.id, ...started };
}
async function chatOnce(baseURL) {
  const response = await getApi(baseURL, '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    question: '推荐算法是什么？',
    config: { providerId: 'desktop-acceptance', model: 'audit-model', reasoningEffort: 'default', contextWindow: 32768, showMe: false },
  }) });
  return await waitFor(async () => {
    const run = await getApi(baseURL, `/api/chat/runs/${response.runId}`);
    if (run.status === 'failed' || run.status === 'cancelled') {
      const error = new Error(`模拟问答${run.status}：${run.error ?? ''}`); error.fatal = true; throw error;
    }
    return run.status === 'done' ? { ...run, sessionId: response.sessionId } : null;
  }, '本地模拟问答', 90_000, 250);
}

try {
  run('/usr/bin/hdiutil', ['verify', dmg]);
  check('DMG 校验', true, 'hdiutil verify 退出码为 0');

  const manifestPath = path.join(path.dirname(dmg), `Weave-${packageVersion}-macOS-arm64.build.json`);
  check('构建清单存在', fs.existsSync(manifestPath));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  check('清单标记 ad-hoc 预览构建', manifest.signing === 'preview-ad-hoc' && manifest.notarized === false, String(manifest.signing));
  check('清单记录源代码指纹', /^[a-f0-9]{64}$/.test(manifest.sourceSha256));
  check('清单记录依赖清单', Array.isArray(manifest.dependencies) && manifest.dependencies.length > 0);
  check('清单记录逐文件包体指纹', Array.isArray(manifest.bundle?.files) && manifest.bundle.files.length > 0);
  check('DMG 指纹与清单一致', manifest.dmg?.sha256 === hashFile(dmg));
  if (manifest.sourceSha256 !== sourceFingerprint(repo)) throw new Error('DMG 源代码指纹与当前源码不一致。');
  report.build = { signing: manifest.signing, sourceSha256: manifest.sourceSha256, nextBuildId: manifest.nextBuildId, runtime: manifest.runtime, dependencies: manifest.dependencies.length };

  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-desktop-acceptance-'));
  mountPoint = path.join(temporary, 'mounted'); fs.mkdirSync(mountPoint);
  run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmg]); mounted = true;
  const entries = fs.readdirSync(mountPoint);
  const appName = entries.find(name => name.endsWith('.app'));
  check('DMG 包含应用、安装引导和 Applications 快捷入口', Boolean(appName) && entries.includes('安装与备份说明.html') && fs.lstatSync(path.join(mountPoint, 'Applications')).isSymbolicLink());
  const mountedApp = path.join(mountPoint, appName);
  const guidance = fs.readFileSync(path.join(mountPoint, '安装与备份说明.html'), 'utf8');
  check('安装引导说明拖入 Applications 与完整备份', /Applications/.test(guidance) && /\.weave/.test(guidance) && /\.git/.test(guidance));

  const installRoot = path.join(temporary, 'independent-install', 'Applications');
  fs.mkdirSync(installRoot, { recursive: true });
  const installedApp = path.join(installRoot, appName);
  copyAppBundle(mountedApp, installedApp);
  check('应用已从只读 DMG 复制到独立安装目录', !installedApp.startsWith(mountPoint) && fs.existsSync(path.join(installedApp, 'Contents', 'MacOS', 'Weave')));
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installedApp]);
  const installedInventory = bundleInventory(installedApp);
  check('安装包结构及依赖指纹与构建清单一致', installedInventory.sha256 === manifest.bundle.sha256 && installedInventory.fileCount === manifest.bundle.fileCount && installedInventory.bytes === manifest.bundle.bytes);
  check('安装包不含环境文件、数据库或知识库数据', true, `${installedInventory.fileCount} 个文件已逐项扫描`);
  report.installedBundle = { fileCount: installedInventory.fileCount, symlinkCount: installedInventory.symlinkCount, bytes: installedInventory.bytes, sha256: installedInventory.sha256 };

  const testRoot = path.join(temporary, 'isolated-data');
  const vault = path.join(testRoot, 'vault');
  fs.mkdirSync(path.join(vault, 'wiki', 'entities'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'wiki', 'entities', 'keep-existing.md'), `---\nid: acceptance-preserve-20261003\ntype: entity\ntitle: 安装验收保留词条\nslug: 安装验收保留词条\ncreated: 2026-10-03T00:00:00+08:00\nupdated: 2026-10-03T00:00:00+08:00\n---\n\n已有资料保留标记：weave-desktop-acceptance-20261003。\n`, 'utf8');
  const originalMarker = 'weave-desktop-acceptance-20261003';
  const modelPort = await freePort();
  fakeModel = spawn(process.execPath, [path.join(repo, 'tests/e2e/mock-model.mjs')], { env: { PATH: '/usr/bin:/bin', WEAVE_E2E_MODEL_PORT: String(modelPort) }, stdio: 'ignore' });
  if (fakeModel.pid) trackedPids.add(fakeModel.pid);
  await waitFor(async () => {
    try { const response = await fetch(`http://127.0.0.1:${modelPort}/health`, { signal: AbortSignal.timeout(1_000) }); return response.ok; }
    catch { return false; }
  }, '本地模拟模型', 10_000, 100);

  activeApp = await startPackageApp(installedApp, testRoot);
  const first = await waitForPackageApp(activeApp, installedApp);
  const coldStartMs = await startupDuration(testRoot);
  report.startup = { coldStartMs };
  report.nativeAppLaunched = !serviceOnly;
  report.packageProcess = { pid: first.nativePid, executable: path.relative(temporary, activeApp.executable), servicePid: first.serverPid, url: first.baseURL };
  if (serviceOnly) check('由 DMG 内置 Node 启动包内 standalone 服务', path.resolve(activeApp.executable).startsWith(installedApp) && first.ready !== null, activeApp.executable);
  else check('由 DMG 内原生 Cocoa 可执行文件启动服务', path.resolve(activeApp.executable).startsWith(installedApp) && first.ready !== null, activeApp.executable);
  const runtimeBin = path.join(installedApp, 'Contents', 'Resources', 'runtime', 'bin');
  const packagedNode = first.nodeExecutable ?? packagedNodeForPid(first.serverPid, runtimeBin);
  const packagedNodeRelative = packagedNode ? path.relative(fs.realpathSync(installedApp), fs.realpathSync(packagedNode)) : null;
  check('以最小初始 PATH 启动且实际服务映射包内 Node', Boolean(packagedNodeRelative) && !packagedNodeRelative.startsWith('..'), packagedNodeRelative ?? undefined);
  report.runtimeEvidence = { initialPath: '/usr/bin:/bin', serverNodeExecutable: packagedNodeRelative };

  if (!serviceOnly) {
    const duplicate = await startNativeApp(installedApp, testRoot);
    const duplicateExit = await Promise.race([duplicate.closed, sleep(15_000).then(() => null)]);
    check('第二次启动激活已有窗口并退出自身', Boolean(duplicateExit) && duplicateExit.code === 0 && isAlive(first.nativePid), JSON.stringify(duplicateExit));
    const firstTree = descendants(first.nativePid);
    const runningServers = firstTree.filter(process => {
      const parent = firstTree.find(candidate => candidate.pid === process.parent);
      return parent?.command.includes('launcher.mjs') && listeningPorts(process.pid).length > 0;
    });
    check('重复启动没有创建第二个本地服务', runningServers.length === 1, `当前服务进程数 ${runningServers.length}`);
  } else {
    report.checks.push({ name: '原生单实例窗口验收', passed: null, skipped: true, detail: 'GitHub macOS runner 使用 service-only 模式；本机运行完整模式可验收窗口与重复启动。' });
  }

  await getApi(first.baseURL, '/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    providers: [{ id: 'desktop-acceptance', label: '本地模拟验收', baseUrl: `http://127.0.0.1:${modelPort}`, model: 'audit-model', contextWindow: 32768 }], activeProviderId: 'desktop-acceptance',
  }) });
  const ready = await getApi(first.baseURL, '/api/readiness');
  check('模拟服务已配置且不使用真实凭据', ready.checks !== undefined);

  const markdown = Buffer.from('# 桌面安装验收\n\n推荐算法用于预测用户偏好。协同过滤分为基于用户与基于物品两类。\n', 'utf8');
  const imported = await uploadFile(first.baseURL, '桌面安装验收.md', markdown);
  const markdownJob = await waitForJob(first.baseURL, imported.jobId);
  check('实际应用导入 Markdown 并完成审阅草稿', markdownJob.status === 'awaiting_review' && markdownJob.draft?.markdown?.includes('推荐算法'));
  const committed = await getApi(first.baseURL, `/api/ingest/${imported.jobId}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: markdownJob.draft.draft, reviewRevision: markdownJob.draft.reviewRevision ?? 0 }) });
  check('Markdown 词条写入并完成 Git 备份', Boolean(committed.commitSha) && committed.backupWarning === null, committed.backupWarning ?? undefined);

  const pdfBytes = fs.readFileSync(path.join(repo, 'tests/fixtures/sample.pdf'));
  const pdfImport = await uploadFile(first.baseURL, 'desktop-cjk-parser.pdf', pdfBytes);
  const pdfJob = await waitForJob(first.baseURL, pdfImport.jobId);
  const extracted = pdfJob.draft?.markdown ?? '';
  check('安装包内 PDF 解析离线提取中文正文', extracted.includes('知识管理方法论') && extracted.includes('卢曼') && extracted.includes('LLM Wiki'), `parser=${pdfJob.draft?.source?.parser ?? 'unknown'}; chars=${[...extracted].length}`);
  report.pdf = { parser: pdfJob.draft.source.parser, extractedCharacters: [...extracted].length, terms: ['知识管理方法论', '卢曼', 'LLM Wiki'] };
  await getApi(first.baseURL, `/api/jobs/${pdfImport.jobId}`, { method: 'DELETE' });

  const search = await getApi(first.baseURL, '/api/search?q=协同过滤');
  check('全文检索命中已导入 Markdown', search.results.some(result => result.title === '协同过滤'));
  const answer = await chatOnce(first.baseURL);
  check('模拟问答成功且引用通过后端校验', answer.status === 'done' && answer.citations?.list?.length > 0, `citations=${answer.citations?.list?.length ?? 0}`);
  report.chat = { status: answer.status, citationCount: answer.citations.list.length, sessionId: answer.sessionId };

  const vaultState = await getApi(first.baseURL, '/api/vault');
  check('Git 工作区干净且现有知识文件仍在', vaultState.hasUncommitted === false && fs.readFileSync(path.join(vault, 'wiki', 'entities', 'keep-existing.md'), 'utf8').includes(originalMarker));
  const preRestartPids = new Set([first.nativePid, ...descendants(first.nativePid).map(process => process.pid)]);
  await stopNativeApp(activeApp); activeApp = null;
  await waitPidsStopped(preRestartPids);
  check('第一次退出后包进程与本地服务均已停止', true, `${preRestartPids.size} 个已记录进程全部退出`);

  activeApp = await startPackageApp(installedApp, testRoot);
  const restarted = await waitForPackageApp(activeApp, installedApp);
  report.startup.restartMs = await startupDuration(testRoot);
  const afterRestart = await getApi(restarted.baseURL, `/api/chat/sessions/${answer.sessionId}`);
  check('重启后词条、会话、回答和引用仍存在', afterRestart.messages.some(message => message.role === 'assistant' && message.citations?.list?.length > 0) && (await getApi(restarted.baseURL, '/api/search?q=协同过滤')).results.length > 0);
  const finalPids = new Set([restarted.nativePid, ...descendants(restarted.nativePid).map(process => process.pid)]);
  await stopNativeApp(activeApp); activeApp = null;
  await waitPidsStopped(finalPids);
  check('最终退出后全部应用进程停止', true, `${finalPids.size} 个已记录进程全部退出`);

  const backupPath = path.join(temporary, 'complete-vault-backup');
  const backup = backupTree(vault, backupPath);
  check('完整备份保留 Markdown、原件、SQLite 与 Git 历史', backup.matches && fs.existsSync(path.join(backupPath, '.weave', 'weave.db')) && fs.existsSync(path.join(backupPath, '.git', 'HEAD')) && fs.existsSync(path.join(backupPath, 'raw')) && fs.readFileSync(path.join(backupPath, 'wiki', 'entities', 'keep-existing.md'), 'utf8').includes(originalMarker), `${backup.fileCount} 个文件逐项哈希相同`);
  report.backup = { fileCount: backup.fileCount, sha256: backup.sha256, byteForByteMatchesVault: backup.matches, preservesExistingMarker: true, includes: ['wiki', 'raw', '.weave/weave.db', '.git'] };

  const restoreRoot = path.join(temporary, 'restored-data');
  const restoredVault = path.join(restoreRoot, 'vault');
  fs.mkdirSync(restoreRoot, { recursive: true });
  fs.cpSync(backupPath, restoredVault, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
  fs.rmSync(installedApp, { recursive: true, force: true });
  check('卸载独立安装副本后知识库与完整备份仍保留', !fs.existsSync(installedApp) && fs.existsSync(vault) && fs.existsSync(backupPath) && fs.readFileSync(path.join(vault, 'wiki', 'entities', 'keep-existing.md'), 'utf8').includes(originalMarker));

  const restoredInstall = path.join(temporary, 'restored-install', 'Applications');
  fs.mkdirSync(restoredInstall, { recursive: true });
  const restoredApp = path.join(restoredInstall, appName);
  copyAppBundle(mountedApp, restoredApp);
  activeApp = await startPackageApp(restoredApp, restoreRoot);
  const recovered = await waitForPackageApp(activeApp, restoredApp);
  report.startup.restoredInstallMs = await startupDuration(restoreRoot);
  const recoveredSession = await getApi(recovered.baseURL, `/api/chat/sessions/${answer.sessionId}`);
  check('从完整备份重新安装后原词条、会话与引用均可恢复', (await getApi(recovered.baseURL, '/api/search?q=协同过滤')).results.length > 0 && recoveredSession.messages.some(message => message.role === 'assistant' && message.citations?.list?.length > 0) && fs.readFileSync(path.join(restoredVault, 'wiki', 'entities', 'keep-existing.md'), 'utf8').includes(originalMarker));
  const recoveredPids = new Set([recovered.nativePid, ...descendants(recovered.nativePid).map(process => process.pid)]);
  await stopNativeApp(activeApp); activeApp = null;
  await waitPidsStopped(recoveredPids);
  report.restore = { reinstalledFromDmg: true, restoredSearchAndSession: true, originalVaultPreservedAfterUninstall: fs.existsSync(vault), backupSha256: backup.sha256 };
  if (keepOpen && !serviceOnly) {
    activeApp = await startNativeApp(restoredApp, restoreRoot);
    const uiRun = await waitForApp(activeApp, restoredApp);
    report.uiInspection = { appPath: restoredApp, testRoot: restoreRoot, baseURL: uiRun.baseURL };
    process.stdout.write(`原生窗口已留在前台供 UI 复核。应用：${restoredApp}\n临时知识库：${restoreRoot}\n复核后向验收进程发送 SIGINT 或 SIGTERM，即会关闭应用并清理临时数据。\n`);
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  }
  report.checks.push({ name: '仅清理验收新建的临时目录', passed: true });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error instanceof Error ? error.message : String(error);
} finally {
  for (const app of packageProcesses) await stopNativeApp(app).catch(() => undefined);
  for (const pid of trackedPids) if (isAlive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await sleep(250);
  for (const pid of trackedPids) if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  if (fakeModel?.pid && isAlive(fakeModel.pid)) { fakeModel.kill('SIGTERM'); await sleep(100); if (isAlive(fakeModel.pid)) fakeModel.kill('SIGKILL'); }
  if (mounted && mountPoint) { try { run('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet']); } catch { try { run('/usr/bin/hdiutil', ['detach', mountPoint, '-force', '-quiet']); } catch {} } }
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}

if (report.result !== 'passed') {
  process.stderr.write(`${report.error ?? '桌面验收失败'}\n机器记录：${reportPath}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`DMG 独立安装验收通过（${report.executionMode}）：${reportPath}\n`);
}
