import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('Node 启动脚本与 Next 共用 .env.local，进程变量优先于文件', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-env-check-'));
  try {
    fs.writeFileSync(path.join(directory, '.env'), 'DOCLING_ENDPOINT=http://127.0.0.1:4500\nWEAVE_VAULT=/synthetic/base\n');
    fs.writeFileSync(path.join(directory, '.env.local'), 'DOCLING_ENDPOINT=http://127.0.0.1:4501\nWEAVE_VAULT=/synthetic/local\n');
    const moduleUrl = pathToFileURL(path.resolve('scripts/env.mjs')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { loadLocalEnv } from ${JSON.stringify(moduleUrl)}; loadLocalEnv('start'); console.log(JSON.stringify({ endpoint: process.env.DOCLING_ENDPOINT, vault: process.env.WEAVE_VAULT, mode: process.env.NODE_ENV }));`], {
      cwd: directory, encoding: 'utf8', env: { NODE_ENV: 'production', PATH: process.env.PATH, WEAVE_VAULT: '/synthetic/process' },
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({ endpoint: 'http://127.0.0.1:4501', vault: '/synthetic/process', mode: 'production' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
