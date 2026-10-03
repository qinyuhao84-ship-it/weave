import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function signingConfiguration(environment, identities = '') {
  const identity = environment.WEAVE_MAC_SIGNING_IDENTITY?.trim();
  const profile = environment.WEAVE_MAC_NOTARY_PROFILE?.trim();
  if (profile && !identity) throw new Error('公证需要显式配置 WEAVE_MAC_SIGNING_IDENTITY。');
  if (!identity) return { identity: null, profile: null, status: 'preview-ad-hoc' };
  const available = identities.split('\n').some(line => line.includes('"Developer ID Application:') && (line.includes(`"${identity}"`) || line.trim().split(/\s+/)[1] === identity));
  if (!available) throw new Error('未找到指定的有效 Developer ID Application 身份；正式构建不会回退为预览签名。');
  return { identity, profile: profile || null, status: profile ? 'developer-id-pending-notarization' : 'developer-id-not-notarized' };
}

export function bundleInventory(root) {
  const files = []; let symlinks = 0; let bytes = 0;
  const absolute = path.resolve(root);
  const realRoot = fs.realpathSync(absolute);
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name); const relative = path.relative(absolute, filename);
      if (entry.name === '.env' || entry.name.startsWith('.env.') || ['.weave', '.eval-cache', 'vault-location.json', 'location.json'].includes(entry.name) || /\.(db|sqlite|sqlite3)(-wal|-shm)?$/i.test(entry.name)) throw new Error(`安装包含禁止分发的数据文件：${relative}`);
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(filename);
        const resolvedRelative = path.relative(realRoot, resolved);
        if (path.isAbsolute(resolvedRelative) || resolvedRelative === '..' || resolvedRelative.startsWith(`..${path.sep}`)) throw new Error(`安装包存在包外依赖：${relative}`);
        symlinks++; files.push({ path: relative, link: fs.readlinkSync(filename) });
      } else if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) {
        const data = fs.readFileSync(filename); bytes += data.length;
        files.push({ path: relative, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
      }
    }
  }
  visit(absolute);
  return { bytes, fileCount: files.filter(file => !file.link).length, symlinkCount: symlinks, sha256: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

export function sourceFingerprint(root) {
  const include = ['app', 'components', 'hooks', 'lib', 'types', 'desktop', 'scripts', 'drizzle', 'public'];
  const files = ['package.json', 'pnpm-lock.yaml', 'next.config.ts', 'instrumentation.ts', 'proxy.ts', 'tsconfig.json'];
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename); else if (entry.isFile()) files.push(path.relative(root, filename));
    }
  }
  include.forEach(directory => visit(path.join(root, directory)));
  const hash = crypto.createHash('sha256');
  for (const filename of files.sort()) if (fs.existsSync(path.join(root, filename))) hash.update(filename + '\0').update(fs.readFileSync(path.join(root, filename)));
  return hash.digest('hex');
}

export function machOFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) {
        const descriptor = fs.openSync(filename, 'r'); const header = Buffer.alloc(4);
        try { if (fs.readSync(descriptor, header, 0, 4, 0) === 4 && ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))) files.push(filename); }
        finally { fs.closeSync(descriptor); }
      }
    }
  }
  visit(root); return files.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
}
