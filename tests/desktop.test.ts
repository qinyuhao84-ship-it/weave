import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { bundleInventory, signingConfiguration } from '../scripts/desktop-package-utils.mjs';

const directories: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture(server: string, options = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-desktop-regression-')); directories.push(directory);
  fs.mkdirSync(path.join(directory, 'server')); fs.mkdirSync(path.join(directory, 'support'));
  fs.writeFileSync(path.join(directory, 'server/server.js'), server);
  fs.writeFileSync(path.join(directory, 'runner.mjs'), `import { launchDesktop } from ${JSON.stringify(pathToFileURL(path.resolve('desktop/launcher.mjs')).href)}; process.exitCode = await launchDesktop({ resources: ${JSON.stringify(directory)}, startupMs: 500, shutdownMs: 150, ${options} });`);
  const child = spawn(process.execPath, [path.join(directory, 'runner.mjs')], { env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin', WEAVE_DESKTOP_TEST_ROOT: path.join(directory, 'support') }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  let output = ''; let errors = '';
  child.stdout!.on('data', chunk => output += String(chunk)); child.stderr!.on('data', chunk => errors += String(chunk));
  const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  return { child, directory, closed, output: () => output, errors: () => errors };
}
function directFixture(server: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-desktop-direct-entry-')); directories.push(directory);
  fs.mkdirSync(path.join(directory, 'server')); fs.mkdirSync(path.join(directory, 'support'));
  fs.writeFileSync(path.join(directory, 'server/server.js'), server);
  const launcher = path.join(directory, 'launcher.mjs');
  fs.copyFileSync(path.resolve('desktop/launcher.mjs'), launcher);
  const entry = path.join(directory, 'launcher-entry.mjs'); fs.symlinkSync(launcher, entry);
  const child = spawn(process.execPath, [entry], { env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin', WEAVE_DESKTOP_TEST_ROOT: path.join(directory, 'support') }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  let output = ''; let errors = '';
  child.stdout!.on('data', chunk => output += String(chunk)); child.stderr!.on('data', chunk => errors += String(chunk));
  const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  return { child, directory, entry, closed, output: () => output, errors: () => errors };
}
async function ready(output: () => string) {
  const until = Date.now() + 3000;
  while (Date.now() < until) { if (output().includes('"url"')) return JSON.parse(output().trim()) as { url: string; serverPid: string }; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Desktop did not become ready');
}
const healthyServer = `const http = require('node:http'); const server = http.createServer((_request, response) => { response.setHeader('content-type','application/json'); response.end('{"ok":true}'); }); server.listen(process.env.PORT,'127.0.0.1'); process.once('SIGTERM', () => server.close(() => process.exit(0)));`;

it('通过真实 Node 直接入口启动 launcher 并在终止后干净退出', async () => {
  const app = directFixture(healthyServer);
  expect(fs.realpathSync(app.entry)).not.toBe(path.resolve(app.entry));
  const record = await ready(app.output);
  expect(record.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  app.child.kill('SIGTERM'); expect(await app.closed).toBe(0);
  expect(fs.readFileSync(path.join(app.directory, 'support/desktop.log'), 'utf8')).toContain('就绪，用时');
  expect(() => process.kill(Number(record.serverPid), 0)).toThrow();
});

it('桌面健康检查不依赖 Next 的 stdout 文案，退出后子服务停止', async () => {
  const app = fixture(healthyServer);
  const record = await ready(app.output);
  expect(record.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  app.child.kill('SIGTERM'); expect(await app.closed).toBe(0);
  expect(() => process.kill(Number(record.serverPid), 0)).toThrow();
});
it('挂起的 HTTP 健康请求受真实截止时间限制，并终止忽略 SIGTERM 的子服务', async () => {
  const started = Date.now();
  const app = fixture(`const http = require('node:http'); http.createServer(() => {}).listen(process.env.PORT,'127.0.0.1'); process.on('SIGTERM', () => {});`);
  expect(await app.closed).toBe(1); expect(Date.now() - started).toBeLessThan(2000);
  expect(app.errors()).toContain('启动期限'); expect(app.errors()).toContain('退出超时'); expect(app.output()).toBe('');
});
it('健康请求已返回响应头但正文挂起时仍受启动期限限制', async () => {
  const started = Date.now();
  const app = fixture(`const fs = require('node:fs'); const path = require('node:path'); const http = require('node:http'); const server = http.createServer((_request, response) => { fs.writeFileSync(path.join(process.env.WEAVE_DESKTOP_TEST_ROOT,'health-requested'), String(process.pid)); response.writeHead(200, {'content-type':'application/json'}); response.flushHeaders(); }).listen(process.env.PORT,'127.0.0.1'); process.once('SIGTERM', () => server.close(() => process.exit(0)));`, 'startupMs: 1200');
  expect(await app.closed).toBe(1); expect(Date.now() - started).toBeLessThan(3000);
  const serverPid = Number(fs.readFileSync(path.join(app.directory, 'support/health-requested'), 'utf8'));
  expect(serverPid).toBeGreaterThan(0); expect(() => process.kill(serverPid, 0)).toThrow();
  expect(app.errors()).toContain('启动期限');
});
it('意外信号退出报告失败，并在下次启动保留故障日志', async () => {
  const app = fixture(`const fs = require('node:fs'); const path = require('node:path'); fs.writeFileSync(path.join(process.env.WEAVE_DESKTOP_TEST_ROOT,'server-pid'), String(process.pid)); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);`, 'startupMs: 5000');
  fs.writeFileSync(path.join(app.directory, 'support/desktop.log'), 'previous active log');
  fs.writeFileSync(path.join(app.directory, 'support/desktop.log.1'), 'previous failure evidence');
  expect(await app.closed).toBe(1); expect(app.errors()).toContain('SIGTERM');
  expect(() => process.kill(Number(fs.readFileSync(path.join(app.directory, 'support/server-pid'), 'utf8')), 0)).toThrow();
  expect(fs.readFileSync(path.join(app.directory, 'support/desktop.log'), 'utf8')).toContain('SIGTERM');
  expect(fs.readFileSync(path.join(app.directory, 'support/desktop.log.1'), 'utf8')).toBe('previous active log');
  expect(fs.readFileSync(path.join(app.directory, 'support/desktop.log.2'), 'utf8')).toBe('previous failure evidence');
});
it('退出等待有上限，正常退出请求不会被标成启动故障', async () => {
  const app = fixture(healthyServer.replace("process.once('SIGTERM', () => server.close(() => process.exit(0)));", "process.on('SIGTERM', () => {});"));
  const record = await ready(app.output); app.child.kill('SIGTERM');
  expect(await app.closed).toBe(0); expect(app.errors()).toContain('退出超时');
  expect(() => process.kill(Number(record.serverPid), 0)).toThrow();
});
it('安装清单拒绝个人资料与指向包外的依赖', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-bundle-regression-')); directories.push(directory);
  fs.writeFileSync(path.join(directory, 'safe.txt'), 'synthetic');
  const safe = bundleInventory(directory); expect(safe.fileCount).toBe(1); expect(safe.bytes).toBe(9);
  fs.writeFileSync(path.join(directory, '.env.local'), 'synthetic only'); expect(() => bundleInventory(directory)).toThrow('禁止分发'); fs.unlinkSync(path.join(directory, '.env.local'));
  fs.symlinkSync(os.tmpdir(), path.join(directory, 'external')); expect(() => bundleInventory(directory)).toThrow('包外依赖');
});
it('符号链接形式的安装根接受包内依赖并拒绝指向包外的链接', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-bundle-alias-regression-')); directories.push(directory);
  const bundle = path.join(directory, 'bundle'); const alias = path.join(directory, 'mount-alias');
  fs.mkdirSync(path.join(bundle, 'node_modules', '.pnpm', 'dependency'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'node_modules', '.pnpm', 'dependency', 'index.js'), 'synthetic');
  fs.symlinkSync('.pnpm/dependency', path.join(bundle, 'node_modules', 'dependency'));
  fs.symlinkSync(bundle, alias, 'dir');

  const direct = bundleInventory(bundle); const throughAlias = bundleInventory(alias);
  expect(throughAlias.sha256).toBe(direct.sha256);
  expect(throughAlias.symlinkCount).toBe(1);

  fs.writeFileSync(path.join(directory, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(directory, 'outside.txt'), path.join(bundle, 'node_modules', '.pnpm', 'dependency', 'escape'));
  expect(() => bundleInventory(alias)).toThrow('包外依赖');
});
it('正式签名显式启用且失败关闭，开发证书不能冒充 Developer ID', () => {
  expect(signingConfiguration({}, '')).toEqual({ identity: null, profile: null, status: 'preview-ad-hoc' });
  expect(() => signingConfiguration({ WEAVE_MAC_NOTARY_PROFILE: 'synthetic' }, '')).toThrow('显式配置');
  expect(() => signingConfiguration({ WEAVE_MAC_SIGNING_IDENTITY: 'Apple Development: Synthetic' }, '1) HASH "Apple Development: Synthetic"')).toThrow('Developer ID Application');
  expect(() => signingConfiguration({ WEAVE_MAC_SIGNING_IDENTITY: 'missing' }, '')).toThrow('不会回退');
  expect(signingConfiguration({ WEAVE_MAC_SIGNING_IDENTITY: 'Developer ID Application: Synthetic', WEAVE_MAC_NOTARY_PROFILE: 'synthetic' }, '1) HASH "Developer ID Application: Synthetic"').status).toBe('developer-id-pending-notarization');
});
