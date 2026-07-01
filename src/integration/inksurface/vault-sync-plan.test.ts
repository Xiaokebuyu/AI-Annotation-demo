import { describe, expect, it } from 'vitest';
import { buildVaultSyncPlan, type ReleaseManifestFile, type SyncLocalEntry } from './vault-sync-plan';

const f = (path: string, hash: string, bytes = 10): ReleaseManifestFile => ({ path, content_hash: `sha256:${hash}`, bytes });
const local = (lastSynced: string, current: string | null): SyncLocalEntry => ({ lastSyncedHash: `sha256:${lastSynced}`, currentHash: current === null ? null : `sha256:${current}` });

describe('buildVaultSyncPlan', () => {
  it('新增（本地无）→ download', () => {
    const p = buildVaultSyncPlan([f('InkLoop/a.md', 'h1')], {});
    expect(p.download.map((x) => x.path)).toEqual(['InkLoop/a.md']);
  });

  it('未变（本地当前 == 远端）→ unchanged·不重下', () => {
    const p = buildVaultSyncPlan([f('InkLoop/a.md', 'h1')], { 'InkLoop/a.md': local('h1', 'h1') });
    expect(p.unchanged).toEqual(['InkLoop/a.md']);
    expect(p.download).toEqual([]);
  });

  it('远端更新 + 本地未改（当前==上次同步）→ 安全覆盖 download', () => {
    const p = buildVaultSyncPlan([f('InkLoop/a.md', 'h2')], { 'InkLoop/a.md': local('h1', 'h1') });
    expect(p.download.map((x) => x.path)).toEqual(['InkLoop/a.md']);
    expect(p.conflicts).toEqual([]);
  });

  it('⭐P0：远端更新 + 本地被用户改过（当前≠上次同步）→ conflict·绝不覆盖', () => {
    const p = buildVaultSyncPlan([f('InkLoop/a.md', 'h2')], { 'InkLoop/a.md': local('h1', 'user-edited') });
    expect(p.conflicts).toEqual([{ path: 'InkLoop/a.md', reason: 'local_edited_remote_changed' }]);
    expect(p.download).toEqual([]);
  });

  it('远端删了 + 本地未改 → 安全 delete（mark-and-sweep·陈旧不留尸）', () => {
    const p = buildVaultSyncPlan([], { 'InkLoop/old.md': local('h1', 'h1') });
    expect(p.delete).toEqual(['InkLoop/old.md']);
  });

  it('⭐P0：远端删了 + 本地被用户改过 → conflict·绝不静默删', () => {
    const p = buildVaultSyncPlan([], { 'InkLoop/old.md': local('h1', 'user-edited') });
    expect(p.conflicts).toEqual([{ path: 'InkLoop/old.md', reason: 'local_edited_remote_deleted' }]);
    expect(p.delete).toEqual([]);
  });

  it('用户自建文件（不在 local 受管状态·不在远端）→ 一律不碰', () => {
    const p = buildVaultSyncPlan([f('InkLoop/a.md', 'h1')], {}); // 用户的 notes/my.md 根本不在 local → 不出现在任何列表
    expect(p.delete).toEqual([]);
    expect(p.conflicts).toEqual([]);
  });

  it('本地曾同步但已被用户删（currentHash=null）：远端还在→恢复 download；远端也无→不重复删', () => {
    expect(buildVaultSyncPlan([f('InkLoop/a.md', 'h1')], { 'InkLoop/a.md': local('h1', null) }).download.map((x) => x.path)).toEqual(['InkLoop/a.md']);
    const gone = buildVaultSyncPlan([], { 'InkLoop/a.md': local('h1', null) });
    expect(gone.delete).toEqual([]);
    expect(gone.conflicts).toEqual([]);
  });

  it('非法路径（非 InkLoop/ 开头 / 含 .. / 反斜杠）→ rejected·不写盘', () => {
    const p = buildVaultSyncPlan([
      f('InkLoop/ok.md', 'h1'),
      f('../escape.md', 'h2'),
      f('InkLoop/../secrets.md', 'h3'),
      f('Other/x.md', 'h4'),
      f('InkLoop\\win.md', 'h5'),
    ], {});
    expect(p.download.map((x) => x.path)).toEqual(['InkLoop/ok.md']);
    expect(p.rejected.map((x) => x.path).sort()).toEqual(['../escape.md', 'InkLoop\\win.md', 'InkLoop/../secrets.md', 'Other/x.md'].sort());
  });

  it('页级重构迁移：旧「一 KO 一文件」发布后不在新 manifest 里——未改则安全删除、用户手改过则冲突保留，新页文件正常下载', () => {
    const p = buildVaultSyncPlan(
      [
        f('InkLoop/Reading/书/书.md', 'hub2'), // hub 内容变了（从列 KO 变成页面目录）
        f('InkLoop/Reading/书/书 · 第 1 页.md', 'page1'), // 新增的页文件
      ],
      {
        'InkLoop/Reading/书/书.md': local('hub1', 'hub1'), // 旧 hub：本地未改，安全覆盖成新内容
        'InkLoop/Reading/书/旧 KO.md': local('leaf1', 'leaf1'), // 旧 KO leaf：本地未改，新 manifest 里没有 → 删
        'InkLoop/Reading/书/用户改过的 KO.md': local('leaf2', 'user-edited'), // 用户在 Obsidian 编辑过 → 冲突保留，不删
      },
    );

    expect(p.download.map((x) => x.path).sort()).toEqual(['InkLoop/Reading/书/书 · 第 1 页.md', 'InkLoop/Reading/书/书.md']);
    expect(p.delete).toEqual(['InkLoop/Reading/书/旧 KO.md']);
    expect(p.conflicts).toEqual([{ path: 'InkLoop/Reading/书/用户改过的 KO.md', reason: 'local_edited_remote_deleted' }]);
  });
});
