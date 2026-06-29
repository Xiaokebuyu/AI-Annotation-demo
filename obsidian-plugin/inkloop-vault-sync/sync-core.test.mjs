// 同步核 Node 自测（无 obsidian 依赖）：node obsidian-plugin/inkloop-vault-sync/sync-core.test.mjs
import { createRequire } from 'module';
import crypto from 'crypto';
const require = createRequire(import.meta.url);
const { syncVault, buildVaultSyncPlan } = require('./sync-core.js');

const sha = (s) => `sha256:${crypto.createHash('sha256').update(s, 'utf8').digest('hex')}`;
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`✓ ${m}`); } else { fail++; console.log(`✗ FAIL ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

// 内存 vault adapter（模拟 Obsidian I/O）+ fake 远端 blob 表。
function harness(remoteFiles /* {path:md} */, localFiles /* {path:md} */, prevState) {
  const local = { ...localFiles };
  const blobs = new Map(); // content_hash -> md
  const manifestFiles = Object.entries(remoteFiles).map(([path, md]) => { const ch = sha(md); blobs.set(ch, md); return { path, content_hash: ch, bytes: Buffer.byteLength(md, 'utf8') }; });
  const io = {
    download: async (ch) => { if (!blobs.has(ch)) throw new Error('no blob'); return blobs.get(ch); },
    writeFile: async (p, md) => { local[p] = md; },
    deleteFile: async (p) => { delete local[p]; },
  };
  const deps = { fetchLatest: async () => ({ manifest: { files: manifestFiles } }), hashOf: async (p) => (p in local ? sha(local[p]) : null), prevState: prevState || {}, io };
  return { deps, local };
}

(async () => {
  // 1 首同步：远端 2 文件·本地空 → 全下载
  {
    const { deps, local } = harness({ 'InkLoop/a.md': 'AAA', 'InkLoop/b.md': 'BBB' }, {}, {});
    const { result } = await syncVault(deps);
    ok(result.downloaded.length === 2 && local['InkLoop/a.md'] === 'AAA' && local['InkLoop/b.md'] === 'BBB', '首同步：2 文件下载落盘');
    ok(result.newState['InkLoop/a.md'].lastSyncedHash === sha('AAA'), 'state 记录 a 的 hash');
  }
  // 2 二次同步无变化 → unchanged·不重写
  {
    const prev = { 'InkLoop/a.md': { lastSyncedHash: sha('AAA') } };
    const { deps, local } = harness({ 'InkLoop/a.md': 'AAA' }, { 'InkLoop/a.md': 'AAA' }, prev);
    const { plan } = await syncVault(deps);
    eq(plan.unchanged, ['InkLoop/a.md'], '无变化 → unchanged');
    ok(plan.download.length === 0, '不重下');
  }
  // 3 ⭐用户在 Obsidian 改了 a → 远端也更新 → conflict·不覆盖
  {
    const prev = { 'InkLoop/a.md': { lastSyncedHash: sha('AAA') } };
    const { deps, local } = harness({ 'InkLoop/a.md': 'REMOTE-NEW' }, { 'InkLoop/a.md': 'USER-EDITED' }, prev);
    const { result } = await syncVault(deps);
    eq(result.conflicts, [{ path: 'InkLoop/a.md', reason: 'local_edited_remote_changed' }], '用户改过+远端变 → conflict');
    ok(local['InkLoop/a.md'] === 'USER-EDITED', '⭐用户编辑没被覆盖');
  }
  // 4 远端删了 + 本地没改 → 删；本地改过 → 不删（conflict）
  {
    const prev = { 'InkLoop/gone.md': { lastSyncedHash: sha('OLD') } };
    const r1 = harness({}, { 'InkLoop/gone.md': 'OLD' }, prev);
    const { result } = await syncVault(r1.deps);
    ok(result.deleted.includes('InkLoop/gone.md') && !('InkLoop/gone.md' in r1.local), '远端删+本地没改 → 删');
    const r2 = harness({}, { 'InkLoop/gone.md': 'USER-EDITED' }, prev);
    const out2 = await syncVault(r2.deps);
    ok(out2.result.conflicts.some((c) => c.reason === 'local_edited_remote_deleted') && r2.local['InkLoop/gone.md'] === 'USER-EDITED', '远端删+本地改 → conflict·不删');
  }
  // 5 ⭐用户撞名（本地有 InkLoop/x.md·从没同步过·内容≠远端）→ conflict·不覆盖
  {
    const { deps, local } = harness({ 'InkLoop/x.md': 'REMOTE' }, { 'InkLoop/x.md': 'USER-OWN' }, {});
    const { result } = await syncVault(deps);
    ok(result.conflicts.length === 1 && local['InkLoop/x.md'] === 'USER-OWN', '撞名未同步文件 → conflict·不覆盖');
  }
  // 6 用户自建文件（不在 InkLoop/·不在 state）→ 完全不碰
  {
    const { deps, local } = harness({ 'InkLoop/a.md': 'AAA' }, { 'MyNotes/diary.md': 'mine' }, {});
    await syncVault(deps);
    ok(local['MyNotes/diary.md'] === 'mine', '非 InkLoop/ 用户文件 → 不碰');
  }
  // 7 非法路径 manifest → rejected·不写
  {
    const plan = buildVaultSyncPlan([{ path: '../escape.md', content_hash: sha('x'), bytes: 1 }], {});
    ok(plan.rejected.length === 1 && plan.download.length === 0, '非法路径 → rejected 不下载');
  }

  console.log(`\n==== ${pass} passed / ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
