import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestVaultMove, applyPendingVaultMove, pendingVaultMove, resolveVaultRoot } from '@/lib/vault/location';
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-location-test-')); vi.stubEnv('WEAVE_CONFIG_DIR', path.join(directory, 'config')); vi.stubEnv('WEAVE_VAULT', ''); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });
function seed() { const from = path.join(directory, 'old'); fs.mkdirSync(path.join(from, '.weave'), { recursive: true }); fs.writeFileSync(path.join(from, '.weave', 'weave.db'), Buffer.from([0, 255, 17, 23])); return from; }
it('迁移复制并验证隐藏文件和数据库，之后唯一活动位置为新目录', () => {
  const from = seed(); const to = path.join(directory, 'new'); requestVaultMove(from, to); expect(pendingVaultMove()?.to).toBe(to);
  expect(applyPendingVaultMove()).toBe(to); expect(fs.existsSync(from)).toBe(false); expect(fs.readFileSync(path.join(to, '.weave/weave.db'))).toEqual(Buffer.from([0, 255, 17, 23])); expect(resolveVaultRoot('unused')).toBe(to); expect(pendingVaultMove()).toBeNull();
});
it('排队后目标被其他文件占用时保留原目录和迁移计划，清理冲突后可重试', () => {
  const from = seed(); const to = path.join(directory, 'new'); requestVaultMove(from, to); fs.mkdirSync(to); fs.writeFileSync(path.join(to, 'external'), '不能覆盖');
  expect(() => applyPendingVaultMove()).toThrow('不同内容'); expect(fs.existsSync(from)).toBe(true); expect(pendingVaultMove()).not.toBeNull();
  fs.rmSync(to, { recursive: true }); expect(applyPendingVaultMove()).toBe(to);
});
it('已有未完成迁移及目标目录重名在排队前拒绝，不改动任何资料', () => {
  const from = seed(); expect(() => requestVaultMove(from, path.join(from, 'nested'))).toThrow('内部'); expect(() => requestVaultMove(from, from + '/..')).toThrow('已存在');
  requestVaultMove(from, path.join(directory, 'first')); expect(() => requestVaultMove(from, path.join(directory, 'second'))).toThrow('等待重启'); expect(fs.existsSync(from)).toBe(true);
});
it('环境指定位置优先，不执行用户位置配置里的迁移', () => {
  const from = seed(); requestVaultMove(from, path.join(directory, 'new')); vi.stubEnv('WEAVE_VAULT', path.join(directory, 'override'));
  expect(resolveVaultRoot('unused')).toBe(path.join(directory, 'override')); expect(fs.existsSync(from)).toBe(true); expect(() => requestVaultMove(from, path.join(directory, 'other'))).toThrow('环境变量');
});
