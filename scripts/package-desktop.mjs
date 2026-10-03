import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { bundleInventory, sourceFingerprint, signingConfiguration, machOFiles } from './desktop-package-utils.mjs';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('此安装包构建支持 macOS Apple Silicon。');
const signing = signingConfiguration(process.env, process.env.WEAVE_MAC_SIGNING_IDENTITY ? execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }) : '');
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const sourceSha256 = sourceFingerprint(path.resolve('.'));
const staging = path.resolve('.eval-cache/desktop-stage');
const runtime = path.resolve('.eval-cache/desktop-runtime');
fs.mkdirSync(runtime, { recursive: true });
async function download(name, url, sha256) {
  const file = path.join(runtime, name);
  if (!fs.existsSync(file)) { const response = await fetch(url); if (!response.ok) throw new Error('官方运行时下载失败'); fs.writeFileSync(file, Buffer.from(await response.arrayBuffer())); }
  if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== sha256) throw new Error('运行时 SHA-256 不匹配');
  return file;
}
const nodeArchive = await download('node-v26.3.1-darwin-arm64.tar.gz', 'https://nodejs.org/dist/v26.3.1/node-v26.3.1-darwin-arm64.tar.gz', '3f624ab0d774553c0d28b968e141d8c676a35a2811fb0b7b356ba9cbdce15f74');
const gitArchive = await download('git-2.56.0.tar.xz', 'https://www.kernel.org/pub/software/scm/git/git-2.56.0.tar.xz', '26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3');
execFileSync('tar', ['-xf', nodeArchive, '-C', runtime]);
// 上游 Makefile 不支持带空格的源码路径，使用独立临时目录编译。
const gitTemporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-git-build-'));
try {
execFileSync('tar', ['-xf', gitArchive, '-C', gitTemporary]);
const gitSource = path.join(gitTemporary, 'git-2.56.0');
execFileSync('make', ['-j4', 'NO_RUST=YesPlease', 'NO_OPENSSL=YesPlease', 'NO_CURL=YesPlease', 'NO_EXPAT=YesPlease', 'NO_TCLTK=YesPlease', 'NO_GETTEXT=YesPlease', 'NO_PERL=YesPlease', 'NO_PYTHON=YesPlease', 'git'], { cwd: gitSource, stdio: 'inherit', env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: '13.5' } });
if (!fs.existsSync('.next/standalone/server.js')) throw new Error('请先运行 pnpm build 生成 standalone。');
fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging, { recursive: true });
const app = path.join(staging, '织识.app');
const contents = path.join(app, 'Contents'); const resources = path.join(contents, 'Resources');
fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true }); fs.mkdirSync(resources, { recursive: true });
fs.cpSync('.next/standalone', path.join(resources, 'server'), { recursive: true, verbatimSymlinks: true });
fs.cpSync('.next/static', path.join(resources, 'server/.next/static'), { recursive: true });
if (fs.existsSync('public')) fs.cpSync('public', path.join(resources, 'server/public'), { recursive: true });
fs.cpSync('drizzle', path.join(resources, 'server/drizzle'), { recursive: true });
// Next 的启动配置可能记录构建目录；运行时只需包内路径。
const serverEntry = path.join(resources, 'server/server.js');
fs.writeFileSync(serverEntry, fs.readFileSync(serverEntry, 'utf8').replaceAll(JSON.stringify(path.resolve('.')), JSON.stringify('.')));
fs.mkdirSync(path.join(resources, 'runtime/bin'), { recursive: true });
fs.copyFileSync(path.join(runtime, 'node-v26.3.1-darwin-arm64/bin/node'), path.join(resources, 'runtime/bin/node'));
fs.copyFileSync(path.join(gitSource, 'git'), path.join(resources, 'runtime/bin/git'));
fs.chmodSync(path.join(resources, 'runtime/bin/git'), 0o755);
fs.copyFileSync('desktop/launcher.mjs', path.join(resources, 'launcher.mjs'));
fs.copyFileSync('desktop/使用说明.html', path.join(resources, '使用说明.html'));
const licenses = path.join(resources, 'licenses'); fs.mkdirSync(licenses);
for (const [source, name] of [['LICENSE', 'Weave-LICENSE.txt'], ['NOTICE.md', 'Weave-NOTICE.md'], [path.join(runtime, 'node-v26.3.1-darwin-arm64/LICENSE'), 'Node-LICENSE.txt'], [path.join(gitSource, 'COPYING'), 'Git-COPYING.txt']]) fs.copyFileSync(source, path.join(licenses, name));
const thirdParty = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { encoding: 'utf8' }));
const licenseManifest = [];
for (const packages of Object.values(thirdParty)) for (const item of packages) {
  licenseManifest.push({ name: item.name, versions: item.versions, license: item.license, homepage: item.homepage });
  for (const directory of item.paths) for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^(license|copying|notice)(\..*)?$/i.test(entry.name)) {
      const target = path.join(licenses, 'packages', `${item.name.replace(/[^a-zA-Z0-9._-]/g, '_')}-${item.versions.join('_')}`);
      fs.mkdirSync(target, { recursive: true }); fs.copyFileSync(path.join(directory, entry.name), path.join(target, entry.name));
    }
  }
}
fs.writeFileSync(path.join(licenses, 'third-party.json'), JSON.stringify(licenseManifest, null, 2));
// standalone 会复制环境文件；任何真实配置与资料都不能随安装包分发。
function scrub(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.name === '.env' || entry.name.startsWith('.env.') || entry.name === '.weave' || entry.name === '.eval-cache' || /\.(db|sqlite|sqlite3)(-wal|-shm)?$/.test(entry.name)) fs.rmSync(file, { recursive: true, force: true });
    else if (entry.isDirectory()) scrub(file);
  }
}
scrub(resources);
// Next 的服务清单不需要构建机器的绝对路径。
const requiredFiles = path.join(resources, 'server/.next/required-server-files.json');
if (fs.existsSync(requiredFiles)) fs.writeFileSync(requiredFiles, fs.readFileSync(requiredFiles, 'utf8').replaceAll(JSON.stringify(path.resolve('.')), JSON.stringify('.')));
fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>织识</string><key>CFBundleDisplayName</key><string>织识</string><key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundleIdentifier</key><string>org.weave.desktop</string><key>CFBundleExecutable</key><string>Weave</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>13.5</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict><key>NSDocumentsFolderUsageDescription</key><string>用于保存和读取您的织识知识库。</string></dict></plist>`);
execFileSync('xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macos13.5', 'desktop/Main.swift', '-o', path.join(contents, 'MacOS/Weave')], { stdio: 'inherit' });
const iconset = path.join(gitTemporary, 'Weave.iconset'); fs.mkdirSync(iconset);
const iconPng = path.join(gitTemporary, 'icon.png');
execFileSync('xcrun', ['swift', 'desktop/Icon.swift', iconPng]);
for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) execFileSync('sips', ['-z', String(size * scale), String(size * scale), iconPng, '--out', path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
execFileSync('iconutil', ['-c', 'icns', iconset, '--output', path.join(resources, 'AppIcon.icns')]);
function verifyLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink() && !fs.realpathSync(file).startsWith(app + path.sep)) throw new Error('安装包存在包外依赖');
    if (entry.isDirectory()) verifyLinks(file);
  }
}
verifyLinks(app);
bundleInventory(app);
if (signing.identity) {
  // 按内部到外部签名；Node 只取得 Apple Silicon V8 必需的 JIT 权限。
  for (const executable of machOFiles(app)) {
    const arguments_ = ['--force', '--sign', signing.identity, '--options', 'runtime', '--timestamp'];
    if (executable === path.join(resources, 'runtime/bin/node')) arguments_.push('--entitlements', 'desktop/Node.entitlements.plist');
    execFileSync('codesign', [...arguments_, executable], { stdio: 'inherit' });
  }
  execFileSync('codesign', ['--force', '--sign', signing.identity, '--options', 'runtime', '--timestamp', app], { stdio: 'inherit' });
  const guidance = path.join(resources, '使用说明.html');
  // 说明在签名之前写入；下方重新封装签名以覆盖更新后的资源。
  fs.writeFileSync(guidance, fs.readFileSync(guidance, 'utf8').replace('预览包使用 ad-hoc 签名，尚未 Apple 公证。', signing.profile ? '本包使用 Developer ID 签名；公证状态以随包构建清单为准。' : '本包使用 Developer ID 签名，尚未 Apple 公证。'));
  execFileSync('codesign', ['--force', '--sign', signing.identity, '--options', 'runtime', '--timestamp', app], { stdio: 'inherit' });
} else execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
fs.copyFileSync(path.join(resources, '使用说明.html'), path.join(staging, '安装与备份说明.html'));
// 预生成的纯布局模板不包含机器路径；CI 无需 Finder 自动化或额外 Python 依赖。
fs.copyFileSync('desktop/InstallLayout.store', path.join(staging, '.DS_Store'));
const output = path.resolve(process.env.WEAVE_DESKTOP_OUTPUT_DIR || 'dist'); fs.mkdirSync(output, { recursive: true });
const dmg = path.join(output, `Weave-${version}-macOS-arm64.dmg`); fs.rmSync(dmg, { force: true });
execFileSync('hdiutil', ['create', '-volname', `织识 ${version}`, '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' });
if (signing.identity) execFileSync('codesign', ['--force', '--sign', signing.identity, '--timestamp', dmg], { stdio: 'inherit' });
if (signing.profile) {
  const notarization = JSON.parse(execFileSync('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', signing.profile, '--wait', '--timeout', '20m', '--output-format', 'json'], { encoding: 'utf8', timeout: 1_260_000 }));
  if (notarization.status !== 'Accepted') throw new Error(`Apple 公证未通过（${notarization.status || '未知状态'}），不会声明可正式分发。`);
  execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'validate', dmg], { stdio: 'inherit' });
  execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { stdio: 'inherit' });
  signing.status = 'developer-id-notarized';
}
execFileSync('hdiutil', ['verify', dmg], { stdio: 'inherit' });
fs.copyFileSync(gitArchive, path.join(output, 'git-2.56.0.tar.xz'));
const manifest = path.join(output, `Weave-${version}-macOS-arm64.build.json`);
const inventory = bundleInventory(app);
const dependencies = licenseManifest.map(({ name, versions, license }) => ({ name, versions, license })).sort((a, b) => `${a.name}@${a.versions.join(',')}`.localeCompare(`${b.name}@${b.versions.join(',')}`));
fs.writeFileSync(manifest, JSON.stringify({ version, platform: 'darwin', architecture: 'arm64', minimumMacOS: '13.5', builtAt: new Date().toISOString(), sourceSha256, nextBuildId: fs.readFileSync(path.join(resources, 'server/.next/BUILD_ID'), 'utf8').trim(), signing: signing.status, notarized: signing.status === 'developer-id-notarized', bundle: inventory, dependencies, dmg: { bytes: fs.statSync(dmg).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex') }, runtime: { node: '26.3.1', git: '2.56.0' } }, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), [dmg, manifest, path.join(output, 'git-2.56.0.tar.xz')].map(file => `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}`).join('\n') + '\n');
console.log(`已生成 ${dmg}；签名状态：${signing.status}。构建清单：${path.basename(manifest)}`);
} finally { fs.rmSync(gitTemporary, { recursive: true, force: true }); }
