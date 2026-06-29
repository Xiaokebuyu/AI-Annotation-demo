import { describe, expect, it } from 'vitest';
import { executeSyncPlan, type ReleaseFileLite, type SyncIoPort, type SyncState } from './vault-sync-exec';
import type { VaultSyncPlan } from './vault-sync-plan';

const ch = (h: string) => `sha256:${h}`;
const emptyPlan = (): VaultSyncPlan => ({ download: [], delete: [], conflicts: [], unchanged: [], rejected: [] });

// 记录型 fake I/O：download 返 `body:<hash>`，可注入失败路径集。
function fakeIo(failWrite = new Set<string>(), failDelete = new Set<string>()): SyncIoPort & { writes: Map<string, string>; deletes: string[] } {
  const writes = new Map<string, string>();
  const deletes: string[] = [];
  return {
    writes, deletes,
    async download(hash: string) { return `body:${hash}`; },
    async writeFile(path: string, md: string) { if (failWrite.has(path)) throw new Error('write boom'); writes.set(path, md); },
    async deleteFile(path: string) { if (failDelete.has(path)) throw new Error('del boom'); deletes.push(path); },
  };
}

describe('executeSyncPlan', () => {
  it('download → 写盘 + state 更新成远端 hash', async () => {
    const plan = { ...emptyPlan(), download: [{ path: 'InkLoop/a.md', content_hash: ch('h1'), bytes: 5 }] };
    const io = fakeIo();
    const r = await executeSyncPlan(plan, [{ path: 'InkLoop/a.md', content_hash: ch('h1') }], {}, io);
    expect(r.downloaded).toEqual(['InkLoop/a.md']);
    expect(io.writes.get('InkLoop/a.md')).toBe(`body:${ch('h1')}`);
    expect(r.newState['InkLoop/a.md']).toEqual({ lastSyncedHash: ch('h1') });
  });

  it('⭐conflict → 不写不删·保留旧 state（下次仍判冲突）', async () => {
    const plan = { ...emptyPlan(), conflicts: [{ path: 'InkLoop/a.md', reason: 'local_edited_remote_changed' as const }] };
    const io = fakeIo();
    const r = await executeSyncPlan(plan, [{ path: 'InkLoop/a.md', content_hash: ch('h2') }], { 'InkLoop/a.md': { lastSyncedHash: ch('h1') } }, io);
    expect(io.writes.size).toBe(0);
    expect(io.deletes).toEqual([]);
    expect(r.newState['InkLoop/a.md']).toEqual({ lastSyncedHash: ch('h1') }); // 旧 state 原样保留
  });

  it('delete → 删盘 + 从 state 移除', async () => {
    const plan = { ...emptyPlan(), delete: ['InkLoop/old.md'] };
    const io = fakeIo();
    const r = await executeSyncPlan(plan, [], { 'InkLoop/old.md': { lastSyncedHash: ch('h1') } }, io);
    expect(io.deletes).toEqual(['InkLoop/old.md']);
    expect(r.newState['InkLoop/old.md']).toBeUndefined();
  });

  it('unchanged → 不写盘·state 校准成远端 hash', async () => {
    const plan = { ...emptyPlan(), unchanged: ['InkLoop/a.md'] };
    const io = fakeIo();
    const r = await executeSyncPlan(plan, [{ path: 'InkLoop/a.md', content_hash: ch('h1') }], { 'InkLoop/a.md': { lastSyncedHash: ch('h1') } }, io);
    expect(io.writes.size).toBe(0);
    expect(r.newState['InkLoop/a.md']).toEqual({ lastSyncedHash: ch('h1') });
  });

  it('download 失败 → 进 failed·保留旧 state（不写坏 state·下次重试）', async () => {
    const plan = { ...emptyPlan(), download: [{ path: 'InkLoop/a.md', content_hash: ch('h2'), bytes: 5 }] };
    const io = fakeIo(new Set(['InkLoop/a.md']));
    const r = await executeSyncPlan(plan, [{ path: 'InkLoop/a.md', content_hash: ch('h2') }], { 'InkLoop/a.md': { lastSyncedHash: ch('h1') } }, io);
    expect(r.failed).toEqual([{ path: 'InkLoop/a.md', error: 'write boom' }]);
    expect(r.newState['InkLoop/a.md']).toEqual({ lastSyncedHash: ch('h1') }); // 没更新成 h2
    expect(r.downloaded).toEqual([]);
  });

  it('混合一轮：下载 + 删除 + 冲突 + 未变 各归其位', async () => {
    const plan: VaultSyncPlan = {
      download: [{ path: 'InkLoop/new.md', content_hash: ch('n'), bytes: 1 }],
      delete: ['InkLoop/gone.md'],
      conflicts: [{ path: 'InkLoop/mine.md', reason: 'local_edited_remote_changed' }],
      unchanged: ['InkLoop/same.md'],
      rejected: [{ path: '../bad.md', reason: 'illegal segment' }],
    };
    const manifest: ReleaseFileLite[] = [{ path: 'InkLoop/new.md', content_hash: ch('n') }, { path: 'InkLoop/same.md', content_hash: ch('s') }, { path: 'InkLoop/mine.md', content_hash: ch('m2') }];
    const prev: SyncState = { 'InkLoop/gone.md': { lastSyncedHash: ch('g') }, 'InkLoop/same.md': { lastSyncedHash: ch('s') }, 'InkLoop/mine.md': { lastSyncedHash: ch('m1') } };
    const io = fakeIo();
    const r = await executeSyncPlan(plan, manifest, prev, io);
    expect(r.downloaded).toEqual(['InkLoop/new.md']);
    expect(r.deleted).toEqual(['InkLoop/gone.md']);
    expect(r.rejected).toHaveLength(1);
    expect(r.newState).toEqual({
      'InkLoop/new.md': { lastSyncedHash: ch('n') },
      'InkLoop/same.md': { lastSyncedHash: ch('s') },
      'InkLoop/mine.md': { lastSyncedHash: ch('m1') }, // 冲突保旧
    });
  });
});
