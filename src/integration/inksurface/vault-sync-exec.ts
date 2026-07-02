/**
 * Vault 同步执行器（交付路线 Y · 下载器侧 · I/O 注入·可测）——拿 buildVaultSyncPlan 的计划 + 注入式 I/O 口，
 * 执行「下载写盘 / 删陈旧 / 跳冲突」，并算出**更新后的 sync-state**（写回 .inkloop-sync-state）。
 * Obsidian 插件只实现 SyncIoPort（vault.adapter 写 + fetch 拉 blob），调用本执行器 → 难逻辑全测得到。
 *
 * 不变量（承接 vault-sync-plan）：
 *  · conflicts（用户改过的）**不写不删**·保留其旧 lastSyncedHash（下次仍判冲突·直到用户/远端收敛）。
 *  · 下载/未变 → 把 sync-state 更新成远端 content_hash（之后用户再改即可被检出）。
 *  · 删除 → 从 sync-state 移除。失败项进 failed·**不**更新 state（下次重试）。
 */
import type { VaultSyncPlan } from './vault-sync-plan';

export interface ReleaseFileLite {
  path: string;
  content_hash: string;
}

/** 下载器注入的 I/O：拉 blob / 原子写 / 删。实现侧（Obsidian 插件）负责 staging→rename 原子性。 */
export interface SyncIoPort {
  download(contentHash: string): Promise<string>; // 按 content_hash 拉 blob 正文
  writeFile(path: string, markdown: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
}

export type SyncState = Record<string, { lastSyncedHash: string }>; // path → 上次同步 hash

export interface SyncExecResult {
  downloaded: string[];
  deleted: string[];
  conflicts: VaultSyncPlan['conflicts'];
  rejected: VaultSyncPlan['rejected'];
  failed: { path: string; error: string }[];
  newState: SyncState; // 写回 .inkloop-sync-state
}

/**
 * 执行同步计划。manifestFiles=远端全量（取 content_hash 更新 state）；prevState=上次 sync-state；io=注入实现。
 * 纯逻辑 + 注入 I/O：给定相同 io 行为 → 确定性。失败容错（单文件失败不中断其余）。
 */
export async function executeSyncPlan(plan: VaultSyncPlan, manifestFiles: ReleaseFileLite[], prevState: SyncState, io: SyncIoPort): Promise<SyncExecResult> {
  const hashByPath = new Map(manifestFiles.map((f) => [f.path, f.content_hash] as const));
  const newState: SyncState = {};
  const downloaded: string[] = [];
  const deleted: string[] = [];
  const failed: { path: string; error: string }[] = [];

  // 冲突：原样保留旧 state（不动盘·下次仍判冲突）
  const conflictPaths = new Set(plan.conflicts.map((c) => c.path));
  for (const c of plan.conflicts) {
    const prev = prevState[c.path];
    if (prev) newState[c.path] = prev;
  }

  // 下载：拉 → 写 → state=远端 hash（单个失败进 failed·不更新 state）
  for (const f of plan.download) {
    try {
      const md = await io.download(f.content_hash);
      await io.writeFile(f.path, md);
      newState[f.path] = { lastSyncedHash: f.content_hash };
      downloaded.push(f.path);
    } catch (e) {
      failed.push({ path: f.path, error: e instanceof Error ? e.message : String(e) });
      const prev = prevState[f.path]; // 失败：保留旧 state（下次重试）
      if (prev) newState[f.path] = prev;
    }
  }

  // 未变：不写盘·但把 state 校准成远端 hash（已一致）
  for (const path of plan.unchanged) {
    const h = hashByPath.get(path);
    if (h) newState[path] = { lastSyncedHash: h };
    else if (prevState[path]) newState[path] = prevState[path];
  }

  // 删除：删盘 → 从 state 移除（失败进 failed·保留 state）
  for (const path of plan.delete) {
    if (conflictPaths.has(path)) continue; // 防御：冲突优先
    try {
      await io.deleteFile(path);
      deleted.push(path);
    } catch (e) {
      failed.push({ path, error: e instanceof Error ? e.message : String(e) });
      if (prevState[path]) newState[path] = prevState[path];
    }
  }

  return { downloaded, deleted, conflicts: plan.conflicts, rejected: plan.rejected, failed, newState };
}
