'use strict';
/**
 * InkLoop Vault Sync · 同步核（纯·无 obsidian 依赖·可 Node 自测）。
 * 计划器/执行器是 annotation-loop-demo 的 vault-sync-plan.ts / vault-sync-exec.ts 的忠实 JS port（那两份有 vitest）。
 * main.js 只填 Obsidian I/O（vault.adapter + requestUrl）调 syncVault。
 *
 * 头号不变量（堵无声毁数据）：用户在 Obsidian 改过的文件（currentHash≠lastSyncedHash）→ conflict·绝不覆盖/删。
 */
const MANAGED_ROOT = 'InkLoop/';

function validateManagedPath(p) {
  if (typeof p !== 'string' || !p) return 'empty';
  if (!p.startsWith(MANAGED_ROOT)) return 'not under InkLoop/';
  if (p.includes('\\') || p.includes('\0')) return 'illegal char';
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return 'illegal segment';
  return null;
}

/** manifestFiles=远端全量 [{path, content_hash}]; local=path→{lastSyncedHash, currentHash|null}。纯·确定性。 */
function buildVaultSyncPlan(manifestFiles, local) {
  const plan = { download: [], delete: [], conflicts: [], unchanged: [], rejected: [] };
  const remote = new Map();
  for (const f of manifestFiles) {
    const bad = validateManagedPath(f.path);
    if (bad) { plan.rejected.push({ path: f.path, reason: bad }); continue; }
    remote.set(f.path, f);
  }
  for (const [path, f] of remote) {
    const l = local[path];
    if (!l || l.currentHash === null) { plan.download.push(f); continue; }
    if (l.currentHash === f.content_hash) { plan.unchanged.push(path); continue; }
    if (l.currentHash !== l.lastSyncedHash) { plan.conflicts.push({ path, reason: 'local_edited_remote_changed' }); continue; }
    plan.download.push(f);
  }
  for (const path of Object.keys(local)) {
    const l = local[path];
    if (remote.has(path) || l.currentHash === null) continue;
    if (l.currentHash !== l.lastSyncedHash) { plan.conflicts.push({ path, reason: 'local_edited_remote_deleted' }); continue; }
    plan.delete.push(path);
  }
  return plan;
}

/** io: {download(content_hash)->md, writeFile(path,md), deleteFile(path)}。失败容错·算新 sync-state。 */
async function executeSyncPlan(plan, manifestFiles, prevState, io) {
  const hashByPath = new Map(manifestFiles.map((f) => [f.path, f.content_hash]));
  const newState = {};
  const downloaded = [];
  const deleted = [];
  const failed = [];
  const conflictPaths = new Set(plan.conflicts.map((c) => c.path));

  for (const c of plan.conflicts) { if (prevState[c.path]) newState[c.path] = prevState[c.path]; } // 冲突保旧 state

  for (const f of plan.download) {
    try {
      const md = await io.download(f.content_hash);
      await io.writeFile(f.path, md);
      newState[f.path] = { lastSyncedHash: f.content_hash };
      downloaded.push(f.path);
    } catch (e) {
      failed.push({ path: f.path, error: e && e.message ? e.message : String(e) });
      if (prevState[f.path]) newState[f.path] = prevState[f.path]; // 失败保旧·下次重试
    }
  }
  for (const path of plan.unchanged) {
    const h = hashByPath.get(path);
    if (h) newState[path] = { lastSyncedHash: h };
    else if (prevState[path]) newState[path] = prevState[path];
  }
  for (const path of plan.delete) {
    if (conflictPaths.has(path)) continue;
    try { await io.deleteFile(path); deleted.push(path); }
    catch (e) { failed.push({ path, error: e && e.message ? e.message : String(e) }); if (prevState[path]) newState[path] = prevState[path]; }
  }
  return { downloaded, deleted, conflicts: plan.conflicts, rejected: plan.rejected, failed, newState };
}

/**
 * 编排：拉最新 manifest → 建 localState（受管文件 = prevState 键 ∪ manifest 路径·读盘算 currentHash）→ plan → exec。
 * deps: { fetchLatest():{manifest,...}, hashOf(path):Promise<string|null>, prevState, io }。注入式·便于 Node 自测。
 * ⚠️本地存在但从没同步过、且与 manifest 同名的文件（用户撞名 InkLoop/）→ lastSyncedHash='' ≠ currentHash → 判 conflict·不覆盖（安全）。
 */
async function syncVault(deps) {
  const data = await deps.fetchLatest();
  const files = (data && data.manifest && data.manifest.files) || [];
  const paths = new Set([...Object.keys(deps.prevState || {}), ...files.map((f) => f.path)]);
  const local = {};
  for (const p of paths) {
    const prev = (deps.prevState || {})[p];
    const cur = await deps.hashOf(p); // null=本地不存在
    if (prev || cur !== null) local[p] = { lastSyncedHash: prev ? prev.lastSyncedHash : '', currentHash: cur };
  }
  const plan = buildVaultSyncPlan(files, local);
  const result = await executeSyncPlan(plan, files, deps.prevState || {}, deps.io);
  return { plan, result };
}

module.exports = { MANAGED_ROOT, validateManagedPath, buildVaultSyncPlan, executeSyncPlan, syncVault };
