'use strict';
/**
 * InkLoop Vault Sync · Obsidian 插件（交付路线 Y 消费端）。
 * 把 Obsidian I/O（vault.adapter 读写删 + requestUrl 拉 manifest/blob）围着同步核的 syncVault 接起来。
 * 「只读消费层」由技术兜底：本地改过的文件判 conflict·绝不覆盖/删（见同步核不变量）。只动 InkLoop/ 子树。
 *
 * 装法：把本目录（manifest.json + main.js）放进 <vault>/.obsidian/plugins/inkloop-vault-sync/ → 启用。
 * 设置里填 panel 地址（…/api/inkloop/vault）、x-inkloop-secret、userId → 命令面板「InkLoop: 同步知识库」。
 * sync-state（每文件上次同步 hash）存插件 data.json（不进 vault·用户看不到）。
 *
 * ⚠️Obsidian 不支持相对 require('./sync-core.js')（只注入 obsidian + node 内置）→ 同步核必须内联在本文件（单文件自包含）。
 *   下面这段「同步核」是 sync-core.js 的内联副本·**改逻辑两处同步**·真值以 sync-core.js + 其 11 项自测为准。
 */
const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian');

// ───────────────────────── 同步核（sync-core.js 内联副本·见上注） ─────────────────────────
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
    const bad = validateManagedPath(path);
    if (bad) { plan.rejected.push({ path, reason: bad }); continue; } // 坏 state 路径不进 delete（守住只动 InkLoop/）
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
    if (validateManagedPath(p)) continue; // 非法路径（坏 manifest/坏 state）：不读盘·不进 plan（守住只动 InkLoop/·避免 hashOf 读 InkLoop 外）
    const prev = (deps.prevState || {})[p];
    const cur = await deps.hashOf(p); // null=本地不存在
    if (prev || cur !== null) local[p] = { lastSyncedHash: prev ? prev.lastSyncedHash : '', currentHash: cur };
  }
  const plan = buildVaultSyncPlan(files, local);
  const result = await executeSyncPlan(plan, files, deps.prevState || {}, deps.io);
  return { plan, result };
}
// ─────────────────────────────── 同步核结束 ───────────────────────────────

const DEFAULTS = { panelBase: '', secret: '', userId: '' };

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

module.exports = class InkloopVaultSync extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, data.settings || {});
    this.addCommand({ id: 'inkloop-sync', name: 'InkLoop: 同步知识库', callback: () => this.runSync() });
    this.addSettingTab(new InkloopSettingTab(this.app, this));
  }

  async saveSettings() {
    const data = (await this.loadData()) || {};
    await this.saveData({ ...data, settings: this.settings });
  }

  async runSync() {
    const { panelBase, secret, userId } = this.settings;
    if (!panelBase || !secret || !userId) { new Notice('InkLoop：先在设置里填 panel 地址 / secret / userId'); return; }
    const base = panelBase.replace(/\/+$/, '');
    const headers = { 'x-inkloop-secret': secret };
    const adapter = this.app.vault.adapter;
    const data = (await this.loadData()) || {};
    const prevState = data.syncState || {};
    new Notice('InkLoop：同步中…');
    try {
      const { result } = await syncVault({
        fetchLatest: async () => {
          const r = await requestUrl({ url: `${base}/users/${encodeURIComponent(userId)}/releases/latest`, headers, throw: false });
          if (r.status === 404) return { manifest: { files: [] } }; // 还没 release → 当空（不误删本地·全是 conflict/unchanged 走不到）
          if (r.status !== 200) throw new Error(`latest ${r.status}`);
          return r.json;
        },
        hashOf: async (p) => (await adapter.exists(p)) ? sha256(await adapter.read(p)) : null,
        prevState,
        io: {
          download: async (contentHash) => {
            const hex = String(contentHash).replace('sha256:', '');
            const r = await requestUrl({ url: `${base}/users/${encodeURIComponent(userId)}/blobs/sha256/${hex}`, headers, throw: false });
            if (r.status !== 200) throw new Error(`blob ${hex.slice(0, 8)} ${r.status}`);
            const md = r.text;
            if ((await sha256(md)) !== contentHash) throw new Error(`blob ${hex.slice(0, 8)} hash 不符`); // 下载完整性兜底
            return md;
          },
          writeFile: async (p, md) => {
            // 写前复核：本地文件若在 plan→write 之间被用户改动（hash≠上次同步值）→ 抛错不覆盖。
            // 堵「同步进行中用户正好在编辑」的竞态（plan 时判 unchanged、写盘时已变）·守住「绝不覆盖用户改动」。
            if (await adapter.exists(p)) {
              const prevHash = prevState[p] && prevState[p].lastSyncedHash;
              const curHash = await sha256(await adapter.read(p));
              if (!prevHash || curHash !== prevHash) throw new Error(`${p} 同步期间本地有改动·跳过不覆盖`);
            }
            const dir = p.split('/').slice(0, -1).join('/');
            if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
            const tmp = `${p}.inkloop-tmp`; // 原子-ish：写 tmp → 删旧 → rename
            try {
              await adapter.write(tmp, md);
              if (await adapter.exists(p)) await adapter.remove(p);
              await adapter.rename(tmp, p);
            } catch (e) {
              try { if (await adapter.exists(tmp)) await adapter.remove(tmp); } catch (_) {} // 失败清残留 tmp（内容寻址·下次同步重下自愈）
              throw e;
            }
          },
          deleteFile: async (p) => {
            if (!(await adapter.exists(p))) return;
            // 删前复核：本地文件若被改动 → 抛错不删（同 writeFile 竞态守卫）。
            const prevHash = prevState[p] && prevState[p].lastSyncedHash;
            const curHash = await sha256(await adapter.read(p));
            if (!prevHash || curHash !== prevHash) throw new Error(`${p} 同步期间本地有改动·跳过不删`);
            await adapter.remove(p);
          },
        },
      });
      await this.saveData({ settings: this.settings, syncState: result.newState });
      const r = result;
      const msg = `InkLoop 同步完成：下载 ${r.downloaded.length}·删 ${r.deleted.length}·冲突 ${r.conflicts.length}·失败 ${r.failed.length}·拒绝 ${r.rejected.length}`;
      new Notice(msg, 8000);
      if (r.conflicts.length) console.warn('[InkLoop] 本地改过·已跳过不覆盖：', r.conflicts);
      if (r.rejected.length) console.warn('[InkLoop] manifest/state 路径非法·已跳过：', r.rejected);
      if (r.failed.length) console.error('[InkLoop] 失败：', r.failed);
    } catch (e) {
      new Notice(`InkLoop 同步失败：${e && e.message ? e.message : e}`, 8000);
      console.error('[InkLoop] sync error', e);
    }
  }
};

class InkloopSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    new Setting(containerEl).setName('Panel vault 地址').setDesc('如 https://nodeskweb.xiaobuyu.trade/api/inkloop/vault')
      .addText((t) => t.setValue(s.panelBase).onChange((v) => { s.panelBase = v.trim(); void save(); }));
    new Setting(containerEl).setName('共享密钥 (x-inkloop-secret)').setDesc('⚠️MVP 单用户·多用户前换 per-user token')
      .addText((t) => { t.inputEl.type = 'password'; t.setValue(s.secret).onChange((v) => { s.secret = v.trim(); void save(); }); });
    new Setting(containerEl).setName('User ID').setDesc('InkLoop 账号稳定 ID（单用户用固定值）')
      .addText((t) => t.setValue(s.userId).onChange((v) => { s.userId = v.trim(); void save(); }));
  }
}
