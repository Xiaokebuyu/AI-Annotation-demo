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
const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, MarkdownRenderer } = require('obsidian');

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

// ───────────── 富插件：预览侧把整页 fallback SVG 换成交互式重渲染（读 .inkloop sidecar；缺失则保留静态 SVG） ─────────────
const SURFACE_SIDECAR_SCHEMA = 'inkloop.sidecar.surface.v1';
const SVG_NS = 'http://www.w3.org/2000/svg';

function safeSidecarDocId(input) {
  return String(input || '').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
}
function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, String(v));
  return el;
}
function finiteNum(n) { return typeof n === 'number' && Number.isFinite(n); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function validColor(c, tool) { return /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : tool === 'highlighter' ? '#facc15' : '#1a1a1a'; }

function buildSurfaceWidget(plugin, ctx, page, notes) {
  const width = finiteNum(page && page.surface && page.surface.width) ? page.surface.width : 720;
  const height = finiteNum(page && page.surface && page.surface.height) ? page.surface.height : 1018;
  const root = document.createElement('div');
  root.className = 'inkloop-surface-widget';

  const svg = svgEl('svg', { class: 'inkloop-surface-svg', viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const viewport = svgEl('g', { class: 'inkloop-surface-viewport' });
  viewport.appendChild(svgEl('rect', { x: 0, y: 0, width, height, fill: (page.surface.background && page.surface.background.color) || '#ffffff', stroke: 'rgba(0,0,0,0.14)' }));
  if (page.surface.background && page.surface.background.kind === 'ruled') {
    for (let y = 32; y < height; y += 32) viewport.appendChild(svgEl('line', { x1: 0, y1: y, x2: width, y2: y, stroke: 'rgba(0,0,0,0.06)' }));
  }

  for (const stroke of page.strokes || []) {
    const pts = (stroke.points || []).filter((p) => finiteNum(p.x) && finiteNum(p.y));
    if (!pts.length) continue;
    const color = validColor(stroke.color, stroke.tool);
    const sw = stroke.tool === 'highlighter' ? Math.max(8, width * 0.012) : Math.max(1.6, width * 0.0032);
    const hasNote = !!(notes && notes[stroke.ko_id]);
    const common = { 'data-inkloop-ko': stroke.ko_id, class: hasNote ? 'inkloop-surface-stroke has-note' : 'inkloop-surface-stroke' };
    const el = pts.length === 1
      ? svgEl('circle', { ...common, cx: pts[0].x, cy: pts[0].y, r: sw, fill: color, opacity: stroke.tool === 'highlighter' ? 0.35 : 0.9 })
      : svgEl('path', { ...common, d: pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '), fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: stroke.tool === 'highlighter' ? 0.35 : 0.9 });
    viewport.appendChild(el);
  }

  svg.appendChild(viewport);
  root.appendChild(svg);

  const pop = document.createElement('div');
  pop.className = 'inkloop-surface-note';
  pop.hidden = true;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.className = 'inkloop-surface-note-close';
  const title = document.createElement('div');
  title.className = 'inkloop-surface-note-title';
  const body = document.createElement('div');
  body.className = 'inkloop-surface-note-body';
  close.addEventListener('click', () => { pop.hidden = true; });
  pop.append(close, title, body);
  root.appendChild(pop);

  let scale = 1, tx = 0, ty = 0;
  const apply = () => viewport.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
  const clientToSvg = (ev) => {
    const r = svg.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) * width) / Math.max(1, r.width), y: ((ev.clientY - r.top) * height) / Math.max(1, r.height) };
  };

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = clientToSvg(ev);
    const wx = (p.x - tx) / scale;
    const wy = (p.y - ty) / scale;
    scale = clamp(scale * (ev.deltaY < 0 ? 1.12 : 0.89), 0.5, 8);
    tx = p.x - wx * scale;
    ty = p.y - wy * scale;
    apply();
  }, { passive: false });

  let dragging = false, moved = false, suppressClick = false, lastX = 0, lastY = 0;
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true; moved = false; lastX = ev.clientX; lastY = ev.clientY;
    if (svg.setPointerCapture) svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const r = svg.getBoundingClientRect();
    const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    tx += (dx * width) / Math.max(1, r.width);
    ty += (dy * height) / Math.max(1, r.height);
    lastX = ev.clientX; lastY = ev.clientY;
    apply();
  });
  const endDrag = () => { if (moved) suppressClick = true; dragging = false; };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  svg.addEventListener('click', (ev) => {
    if (suppressClick) { suppressClick = false; return; }
    const target = ev.target && ev.target.closest ? ev.target.closest('[data-inkloop-ko]') : null;
    const note = target ? (notes && notes[target.getAttribute('data-inkloop-ko') || '']) : null;
    if (!note) return;
    title.textContent = note.title || note.kind || 'InkLoop';
    body.replaceChildren();
    try { void MarkdownRenderer.renderMarkdown(note.body_md || '', body, (ctx && ctx.sourcePath) || '', plugin); }
    catch (_) { body.textContent = note.body_md || ''; }
    const box = root.getBoundingClientRect();
    pop.style.left = `${clamp(ev.clientX - box.left + 12, 8, Math.max(8, box.width - 328))}px`;
    pop.style.top = `${clamp(ev.clientY - box.top + 12, 8, Math.max(8, box.height - 180))}px`;
    pop.hidden = false;
  });

  return root;
}

function installSurfaceStyles(plugin) {
  const style = document.createElement('style');
  style.textContent = `
.inkloop-surface-widget{position:relative;overflow:hidden;border:1px solid var(--background-modifier-border);background:var(--background-primary);margin:8px 0}
.inkloop-surface-svg{display:block;width:100%;height:auto;max-height:72vh;cursor:grab;touch-action:none}
.inkloop-surface-svg:active{cursor:grabbing}
.inkloop-surface-stroke.has-note{cursor:pointer}
.inkloop-surface-note{position:absolute;z-index:20;width:min(320px,calc(100% - 16px));max-height:240px;overflow:auto;padding:10px 12px;border:1px solid var(--background-modifier-border);border-radius:6px;background:var(--background-primary);box-shadow:0 8px 24px rgba(0,0,0,.18)}
.inkloop-surface-note-close{float:right}
.inkloop-surface-note-title{font-weight:600;margin-right:28px;margin-bottom:6px}
`;
  document.head.appendChild(style);
  plugin.register(() => style.remove());
}

module.exports = class InkloopVaultSync extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, data.settings || {});
    this.surfaceSidecarCache = new Map();
    installSurfaceStyles(this);
    this.registerMarkdownPostProcessor((el, ctx) => this.enhanceInkLoopSurfaces(el, ctx));
    this.addCommand({ id: 'inkloop-sync', name: 'InkLoop: 同步知识库', callback: () => this.runSync() });
    this.addSettingTab(new InkloopSettingTab(this.app, this));
  }

  async saveSettings() {
    const data = (await this.loadData()) || {};
    await this.saveData({ ...data, settings: this.settings });
  }

  /** 读某 doc 的 surface sidecar（缓存 promise；缺失/JSON错/schema错 → null，调用方保留静态 SVG fallback）。 */
  async readSurfaceSidecar(docId) {
    const path = `InkLoop/.inkloop/docs/${safeSidecarDocId(docId)}/surface.json`;
    if (this.surfaceSidecarCache.has(path)) return this.surfaceSidecarCache.get(path);
    const promise = (async () => {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) return null;
      const parsed = JSON.parse(await adapter.read(path));
      if (!parsed || parsed.schema !== SURFACE_SIDECAR_SCHEMA || !Array.isArray(parsed.pages)) return null;
      return parsed;
    })().catch((e) => { console.warn('[InkLoop] surface sidecar fallback kept:', path, e); return null; });
    this.surfaceSidecarCache.set(path, promise);
    return promise;
  }

  enhanceInkLoopSurfaces(el, ctx) {
    for (const node of el.querySelectorAll('.inkloop-page-surface-fallback[data-inkloop-doc][data-inkloop-page]')) {
      if (node.dataset.inkloopEnhanced) continue;
      node.dataset.inkloopEnhanced = '1';
      void this.enhanceInkLoopSurface(node, ctx);
    }
  }

  async enhanceInkLoopSurface(node, ctx) {
    const docId = node.getAttribute('data-inkloop-doc');
    const pageIndex = Number(node.getAttribute('data-inkloop-page'));
    if (!docId || !Number.isFinite(pageIndex)) return;
    const sidecar = await this.readSurfaceSidecar(docId);
    if (!sidecar) return; // 缺失/失败 → 保留原静态 SVG（绝不弄成空白）
    const surface = node.getAttribute('data-inkloop-surface');
    const coord = node.getAttribute('data-inkloop-coord-space');
    const pages = sidecar.pages.filter((p) => p.page_index === pageIndex);
    const page = pages.find((p) => p.surface && p.surface.capture_surface === surface && p.surface.coord_space === coord) || pages[0];
    if (!page) return;
    node.replaceChildren(buildSurfaceWidget(this, ctx, page, sidecar.notes || {}));
    node.classList.add('inkloop-page-surface-enhanced');
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
      if (this.surfaceSidecarCache) this.surfaceSidecarCache.clear(); // sidecar 可能刚更新，清缓存下次重读
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
