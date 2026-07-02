/**
 * Vault 同步计划器（交付路线 Y · 消费端/下载器侧 · 纯函数）——给远端 release manifest + 本地同步状态，
 * 算出「下载哪些 / 删哪些 / 哪些是用户改过的冲突 / 哪些没变跳过 / 哪些路径非法拒掉」。
 * 下载器（Obsidian 插件）只围着这个纯核做 I/O（拉 blob / 写盘 / 删文件）→ 难的判定全在这测得到。
 *
 * 堵 codex 压测的头号 P0「『只读』被用户编辑打脸 → 无声毁数据」：
 *  · 本地文件 hash ≠ 上次同步 hash = 用户在 Obsidian 改过 → 标 conflict，**绝不静默覆盖/删除**。
 *  · mark-and-sweep：上次同步过的受管文件在新 manifest 缺席 → 删（重命名/删除的概念枢纽不留尸）；
 *    **从没同步过的（用户自建）文件不在 local 状态里 → 一律不碰**。
 *  · 未变（远端 == 本地当前）→ 跳过（不重下/不重写）。
 *  · 路径校验：manifest path 必须 InkLoop/ 开头、禁 `..`/反斜杠/空段/NUL（防写出受管根之外·配合下载器 realpath 兜底）。
 *
 * 纯·确定性·无 DOM/fs/store 依赖（下载器把 fs 适配进来）。
 */

export const MANAGED_ROOT = 'InkLoop/';

/** release manifest 里一条文件（与 vault-release 的 VaultReleaseFileEntry 同形·此处独立定义保持消费端解耦）。 */
export interface ReleaseManifestFile {
  path: string;
  content_hash: string; // 'sha256:<hex>'
  bytes: number;
}

/** 本地受管文件的同步状态：lastSyncedHash=上次写盘时的内容 hash（存在 .inkloop-sync-state）；currentHash=当前盘上 hash（null=本地已不存在）。 */
export interface SyncLocalEntry {
  lastSyncedHash: string;
  currentHash: string | null;
}

export type ConflictReason = 'local_edited_remote_changed' | 'local_edited_remote_deleted';

export interface VaultSyncPlan {
  download: ReleaseManifestFile[]; // 新增 / 远端更新且本地未被用户改 → 拉下来写
  delete: string[]; // 受管文件远端已无、本地未被改 → 删
  conflicts: { path: string; reason: ConflictReason }[]; // 用户改过 → 不动·留给下载器报冲突（跳过 or 写 .conflict.md）
  unchanged: string[]; // 远端 == 本地当前 → 跳过
  rejected: { path: string; reason: string }[]; // manifest 里非法路径 → 拒（不写盘）
}

function validateManagedPath(p: string): string | null {
  if (typeof p !== 'string' || !p) return 'empty';
  if (!p.startsWith(MANAGED_ROOT)) return `not under ${MANAGED_ROOT}`;
  if (p.includes('\\') || p.includes('\0')) return 'illegal char';
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return 'illegal segment';
  return null;
}

/**
 * 纯·确定性。manifestFiles=远端 release 全量文件集；local=本地受管文件 path→{lastSyncedHash, currentHash}。
 * 不变量：用户改过的文件（currentHash≠lastSyncedHash）永远进 conflicts，绝不进 download/delete（不毁数据）。
 */
export function buildVaultSyncPlan(manifestFiles: ReleaseManifestFile[], local: Record<string, SyncLocalEntry>): VaultSyncPlan {
  const plan: VaultSyncPlan = { download: [], delete: [], conflicts: [], unchanged: [], rejected: [] };

  const remote = new Map<string, ReleaseManifestFile>();
  for (const f of manifestFiles) {
    const bad = validateManagedPath(f.path);
    if (bad) { plan.rejected.push({ path: f.path, reason: bad }); continue; }
    remote.set(f.path, f); // 同 path 后者覆盖（manifest 本应去重·稳妥起见）
  }

  // 远端文件：下载 / 跳过 / 冲突
  for (const [path, f] of remote) {
    const l = local[path];
    if (!l || l.currentHash === null) { plan.download.push(f); continue; } // 本地无（新增）或本地被删（恢复）→ 下载
    if (l.currentHash === f.content_hash) { plan.unchanged.push(path); continue; } // 已是目标内容 → 跳过
    if (l.currentHash !== l.lastSyncedHash) { plan.conflicts.push({ path, reason: 'local_edited_remote_changed' }); continue; } // 用户改过 + 远端也变 → 不覆盖
    plan.download.push(f); // 本地未改（==上次同步）但远端更新了 → 安全覆盖
  }

  // 受管本地文件远端已无：删 / 冲突（mark-and-sweep）
  for (const [path, l] of Object.entries(local)) {
    if (remote.has(path) || l.currentHash === null) continue;
    if (l.currentHash !== l.lastSyncedHash) { plan.conflicts.push({ path, reason: 'local_edited_remote_deleted' }); continue; } // 用户改过但远端删了 → 别静默删
    plan.delete.push(path); // 未改 + 远端删 → 安全删
  }

  return plan;
}
