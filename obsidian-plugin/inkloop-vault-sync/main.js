'use strict';
/**
 * InkLoop Vault Sync · Obsidian 插件（交付路线 Y 消费端）。
 * 把 Obsidian I/O（vault.adapter 读写删 + requestUrl 拉 manifest/blob）围着 sync-core 的 syncVault 接起来。
 * 「只读消费层」由技术兜底：本地改过的文件判 conflict·绝不覆盖/删（见 sync-core 不变量）。只动 InkLoop/ 子树。
 *
 * 装法：把本目录（manifest.json + main.js + sync-core.js）放进 <vault>/.obsidian/plugins/inkloop-vault-sync/ → 启用。
 * 设置里填 panel 地址（…/api/inkloop/vault）、x-inkloop-secret、userId → 命令面板「InkLoop: 同步知识库」。
 * sync-state（每文件上次同步 hash）存插件 data.json（不进 vault·用户看不到）。
 */
const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian');
const { syncVault } = require('./sync-core.js');

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
            const dir = p.split('/').slice(0, -1).join('/');
            if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
            const tmp = `${p}.inkloop-tmp`; // 原子-ish：写 tmp → 删旧 → rename
            await adapter.write(tmp, md);
            if (await adapter.exists(p)) await adapter.remove(p);
            await adapter.rename(tmp, p);
          },
          deleteFile: async (p) => { if (await adapter.exists(p)) await adapter.remove(p); },
        },
      });
      await this.saveData({ settings: this.settings, syncState: result.newState });
      const r = result;
      const msg = `InkLoop 同步完成：下载 ${r.downloaded.length}·删 ${r.deleted.length}·冲突 ${r.conflicts.length}·失败 ${r.failed.length}`;
      new Notice(msg, 8000);
      if (r.conflicts.length) console.warn('[InkLoop] 本地改过·已跳过不覆盖：', r.conflicts);
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
