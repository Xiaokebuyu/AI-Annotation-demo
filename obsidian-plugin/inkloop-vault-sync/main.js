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
const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, MarkdownRenderer, MarkdownView } = require('obsidian');

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

/** 页内文字行距估计（text_runs 相邻 y 差的中位数）：给笔迹聚类/上下文裁剪当"行"单位。无文字时给固定值。 */
function lineSpacingOf(page) {
  const ys = [...new Set((page.text_runs || []).filter((r) => r && finiteNum(r.y)).map((r) => Math.round(r.y)))].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ys.length; i++) { const g = ys[i] - ys[i - 1]; if (g > 4) gaps.push(g); }
  if (!gaps.length) return 36;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** 把一页笔迹按纵向邻近聚成簇，每簇给一个裁剪 viewBox（整宽 × 笔迹 bbox ± 约两三行文字）。
 *  用户预期是"每段手写 + 它周围两三行"的小片段，不是整页一大块；数据仍是整页 sidecar，纯展示侧裁剪。 */
function clusterPageStrokes(page, width, height) {
  const boxes = [];
  for (const s of page.strokes || []) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of s.points || []) {
      if (!finiteNum(p.x) || !finiteNum(p.y)) continue;
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    if (finiteNum(y0) && finiteNum(y1)) boxes.push({ y0, y1 });
  }
  if (!boxes.length) return [];
  const line = lineSpacingOf(page);
  const pad = (page.text_runs || []).length ? line * 2.5 : 48; // 有文字底图留两三行上下文；日记（已裁过）留固定边距
  boxes.sort((a, b) => a.y0 - b.y0);
  const clusters = [];
  for (const b of boxes) {
    const last = clusters[clusters.length - 1];
    // 合并阈值 = 2*pad：两簇加完上下文补白后若会重叠，就并成一个片段（免得同一段文字渲两遍）
    if (last && b.y0 <= last.y1 + pad * 2) { last.y1 = Math.max(last.y1, b.y1); }
    else clusters.push({ y0: b.y0, y1: b.y1 });
  }
  const crops = clusters.map((c) => {
    let y = Math.max(0, c.y0 - pad);
    let yEnd = Math.min(height, c.y1 + pad);
    // 行吸附：切线若落在某个 text_run 中间，扩到完整包含该行（±4px 呼吸边）——
    // 绝不切半行字（上一版切线=bbox+固定pad，落在行中间被用户点名难看）。扩张可能新交到
    // 相邻行，迭代到稳定（有限行数必收敛，5 轮兜底）。
    for (let it = 0; it < 5; it++) {
      let changed = false;
      for (const r of page.text_runs || []) {
        if (!finiteNum(r.y) || !finiteNum(r.h)) continue;
        const r0 = r.y - 4, r1 = r.y + r.h + 4;
        if (r1 > y && r0 < yEnd) {
          if (r0 < y) { y = Math.max(0, r0); changed = true; }
          if (r1 > yEnd) { yEnd = Math.min(height, r1); changed = true; }
        }
      }
      if (!changed) break;
    }
    return { x: 0, y, w: width, h: Math.max(1, yEnd - y) };
  });
  // 吸附扩张后相邻片段可能重叠 → 再并一遍，免得同几行文字渲两遍
  const merged = [];
  for (const c of crops) {
    const last = merged[merged.length - 1];
    if (last && c.y <= last.y + last.h) {
      const yEnd = Math.max(last.y + last.h, c.y + c.h);
      last.h = yEnd - last.y;
    } else merged.push(c);
  }
  return merged;
}

/** 旁注列的 kind 小标签（参考设备桌面版的 EXCERPT/QA/… 小字大写标签形态）。 */
// 与 SDK 渲染器 CALLOUT_LABEL 同词表——手写侧旁注卡和原文侧 [!inkloop] 旁注视觉上是同一种东西
const KIND_BADGE = { ai_note: 'AI 批注', qa: '问答', excerpt: '摘录', annotation: '批注', summary: '总结', concept: '概念', task: '待办' };
const cssEscape = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));

/** 等元素真正挂进 DOM 再回调（代码块处理器拿到的 el 此刻还没 attach，closest 爬不到 preview view）。 */
function whenAttached(el, cb) {
  let tries = 0;
  const tick = () => {
    if (el.isConnected) { cb(); return; }
    if (++tries < 120) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function buildSurfaceWidget(plugin, ctx, page, notes, crop) {
  const width = finiteNum(page && page.surface && page.surface.width) ? page.surface.width : 720;
  const height = finiteNum(page && page.surface && page.surface.height) ? page.surface.height : 1018;
  const vb = crop || { x: 0, y: 0, w: width, h: height };
  const root = document.createElement('div');
  root.className = 'inkloop-surface-widget';

  const svg = svgEl('svg', { class: 'inkloop-surface-svg', viewBox: `${vb.x} ${vb.y} ${vb.w} ${vb.h}`, role: 'img' });
  const viewport = svgEl('g', { class: 'inkloop-surface-viewport' });
  viewport.appendChild(svgEl('rect', { x: 0, y: 0, width, height, fill: (page.surface.background && page.surface.background.color) || '#ffffff', stroke: 'rgba(0,0,0,0.14)' }));
  if (page.surface.background && page.surface.background.kind === 'ruled') {
    for (let y = 32; y < height; y += 32) viewport.appendChild(svgEl('line', { x1: 0, y1: y, x2: width, y2: y, stroke: 'rgba(0,0,0,0.06)' }));
  }

  // reader 文字背景（视觉行 text_runs）：底层文字、上层笔迹，同 reader_px 坐标→对齐
  if ((page.text_runs || []).length) {
    const textLayer = svgEl('g', { class: 'inkloop-reader-text', 'pointer-events': 'none' });
    for (const run of page.text_runs) {
      if (!run || !run.text || !finiteNum(run.x) || !finiteNum(run.y)) continue;
      const tAttrs = { x: run.x, y: run.y, 'font-size': finiteNum(run.font_size) ? Math.max(1, run.font_size) : 16, fill: run.fill || '#111111' };
      if (run.font_family) tAttrs['font-family'] = run.font_family;
      if (run.font_weight) tAttrs['font-weight'] = run.font_weight;
      if (run.font_style) tAttrs['font-style'] = run.font_style;
      const t = svgEl('text', tAttrs);
      t.textContent = run.text;
      textLayer.appendChild(t);
    }
    viewport.appendChild(textLayer);
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

  // ── 双栏（参考设备桌面版放置形式）：左=内容快照（图⇄文原位切换），右=旁注列（kind小标签+标题+正文） ──
  const cols = document.createElement('div');
  cols.className = 'inkloop-surface-cols';
  const pane = document.createElement('div');
  pane.className = 'inkloop-surface-pane';
  pane.appendChild(svg);
  cols.appendChild(pane);
  root.appendChild(cols);

  let scale = 1, tx = 0, ty = 0;
  const apply = () => viewport.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
  const clientToSvg = (ev) => {
    const r = svg.getBoundingClientRect();
    return { x: vb.x + ((ev.clientX - r.left) * vb.w) / Math.max(1, r.width), y: vb.y + ((ev.clientY - r.top) * vb.h) / Math.max(1, r.height) };
  };

  svg.addEventListener('wheel', (ev) => {
    // 只有 Ctrl/⌘+滚轮（触控板捏合自带 ctrlKey）才缩放；普通滚轮放行给页面滚动。
    // 否则滚动经过快照时滚轮被劫走 → 页面"强直跳变" + 误缩放把内容平移出画框（实测踩过）。
    if (!ev.ctrlKey && !ev.metaKey) return;
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
    if (scale === 1) return; // 未放大不接管拖拽——基础态拖动会把内容平移出画框，且干扰点击笔迹的交互
    dragging = true; moved = false; lastX = ev.clientX; lastY = ev.clientY;
    if (svg.setPointerCapture) svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const r = svg.getBoundingClientRect();
    const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    tx += (dx * vb.w) / Math.max(1, r.width);
    ty += (dy * vb.h) / Math.max(1, r.height);
    lastX = ev.clientX; lastY = ev.clientY;
    apply();
  });
  const endDrag = () => { if (moved) suppressClick = true; dragging = false; };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  // ── 工具条：缩放复位（悬停浮现，不占版面）。图⇄文切换是**页面级**的事（右上悬浮「手写｜原文」·
  //    控件 ⇄ markdown 正文互斥），不在快照内做局部文字替换（text_runs 拼行那版被用户否了，已删）。──
  const bar = document.createElement('div');
  bar.className = 'inkloop-surface-bar';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = '⤾';
  reset.title = '复位缩放/平移';
  reset.addEventListener('click', () => { scale = 1; tx = 0; ty = 0; apply(); });
  bar.appendChild(reset);
  pane.appendChild(bar);

  // ── 旁注列：本片段范围内有笔记的 ko（按笔迹出现顺序去重）。悬停旁注→高亮对应笔迹（其余压暗）。 ──
  const koIds = [];
  for (const stroke of page.strokes || []) {
    if (!notes || !notes[stroke.ko_id] || koIds.includes(stroke.ko_id)) continue;
    if (crop) {
      let y0 = Infinity, y1 = -Infinity;
      for (const p of stroke.points || []) if (finiteNum(p.y)) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      if (!(finiteNum(y0) && y1 >= vb.y && y0 <= vb.y + vb.h)) continue;
    }
    koIds.push(stroke.ko_id);
  }
  const cardByKo = new Map();
  if (koIds.length) {
    const notesCol = document.createElement('div');
    notesCol.className = 'inkloop-surface-notes';
    // 每条笔记的锚点 = 该 ko 在裁剪范围内笔迹 bbox 的纵向中心（旁注要贴着它批的那一笔，不是从顶上顺序堆）
    const anchorOf = (koId) => {
      let y0 = Infinity, y1 = -Infinity;
      for (const s of page.strokes || []) {
        if (s.ko_id !== koId) continue;
        for (const p of s.points || []) {
          if (!finiteNum(p.y)) continue;
          if (crop && (p.y < vb.y - 40 || p.y > vb.y + vb.h + 40)) continue;
          y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        }
      }
      return finiteNum(y0) ? (y0 + y1) / 2 : vb.y;
    };
    const noteMeta = [];
    for (const koId of koIds) {
      const note = notes[koId];
      const card = notesCol.createEl('div', { cls: 'inkloop-note-card' });
      card.createEl('div', { cls: 'inkloop-note-kind', text: KIND_BADGE[note.kind] || 'NOTE' });
      // 「书名 · pN」这类设备侧自动生成的标题信息量为零（同页每张卡都一样），旁注列里不重复渲
      if (note.title && !/·\s*p\d+\s*$/.test(note.title)) card.createEl('div', { cls: 'inkloop-note-title', text: note.title });
      const body = card.createEl('div', { cls: 'inkloop-note-body inkloop-note-md' }); // inkloop-note-md=后处理器排除标记
      try { void MarkdownRenderer.renderMarkdown(note.body_md || '', body, (ctx && ctx.sourcePath) || '', plugin); }
      catch (_) { body.textContent = note.body_md || ''; }
      cardByKo.set(koId, card);
      noteMeta.push({ card, anchor: anchorOf(koId) });
      const focus = (on) => {
        svg.classList.toggle('has-focus', on);
        for (const el of svg.querySelectorAll(`[data-inkloop-ko="${cssEscape(koId)}"]`)) el.classList.toggle('is-active', on);
      };
      card.addEventListener('mouseenter', () => focus(true));
      card.addEventListener('mouseleave', () => focus(false));
    }
    noteMeta.sort((a, b) => a.anchor - b.anchor);
    cols.appendChild(notesCol);

    // 旁注纵向对位（约束版）：目标=每张卡贴着它批的那笔的高度，且**整列绝不超出快照底边**。
    // 步骤：①量自然高度，总高装不下 → 先全部折叠（6行截断·点卡展开）②锚定+前向下推消重叠
    // ③底边溢出 → 反向回推收进快照高度内 ④再前向修一遍重叠。窄屏（上下堆叠）退回文档流。
    const GAP = 14;
    const layoutNotes = () => {
      const wide = typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 761px)').matches;
      if (!wide) {
        notesCol.classList.remove('is-anchored');
        notesCol.style.minHeight = '';
        for (const m of noteMeta) { m.card.style.top = ''; m.card.classList.remove('is-clamped'); }
        return;
      }
      const paneH = pane.getBoundingClientRect().height;
      if (!paneH) return;
      notesCol.classList.add('is-anchored');

      const natural = () => noteMeta.reduce((sum, m) => sum + m.card.getBoundingClientRect().height, 0) + GAP * (noteMeta.length - 1);
      for (const m of noteMeta) m.card.classList.remove('is-clamped');
      if (natural() > paneH && noteMeta.length) {
        for (const m of noteMeta) if (!m.card.classList.contains('is-expanded')) m.card.classList.add('is-clamped');
      }
      const h = noteMeta.map((m) => m.card.getBoundingClientRect().height);
      const tops = [];
      for (let i = 0; i < noteMeta.length; i++) {
        const want = ((noteMeta[i].anchor - vb.y) / Math.max(1, vb.h)) * paneH - 10;
        tops[i] = Math.max(0, want, i > 0 ? tops[i - 1] + h[i - 1] + GAP : 0);
      }
      if (noteMeta.length) {
        const last = noteMeta.length - 1;
        if (tops[last] + h[last] > paneH) {
          tops[last] = Math.max(0, paneH - h[last]); // 反向回推：整列收进快照高度内（除非单卡本身就超高）
          for (let i = last - 1; i >= 0; i--) tops[i] = Math.max(0, Math.min(tops[i], tops[i + 1] - GAP - h[i]));
          for (let i = 1; i < noteMeta.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + h[i - 1] + GAP); // 再修重叠
        }
        for (let i = 0; i < noteMeta.length; i++) noteMeta[i].card.style.top = `${tops[i]}px`;
        notesCol.style.minHeight = `${Math.max(paneH, tops[noteMeta.length - 1] + h[noteMeta.length - 1])}px`;
      }
    };
    for (const m of noteMeta) {
      m.card.addEventListener('click', () => { // 折叠态点卡展开全文（再点收回），展开后重排
        if (!m.card.classList.contains('is-clamped') && !m.card.classList.contains('is-expanded')) return;
        m.card.classList.toggle('is-expanded');
        layoutNotes();
      });
    }
    // 锚定对位布局随「选节」一起暂时下线（有列高失控的 bug）：不调 layoutNotes → notesCol 保持
    // 默认 flex 顺序堆叠，卡片全文显示。重启用选节时把下面这块恢复即可。
    const ANCHORED_NOTES_ENABLED = false;
    if (ANCHORED_NOTES_ENABLED) {
      whenAttached(notesCol, () => {
        layoutNotes();
        setTimeout(layoutNotes, 250); // MarkdownRenderer 异步填充正文后卡高会变，再排一次
        setTimeout(layoutNotes, 800);
        if (typeof ResizeObserver === 'function') new ResizeObserver(() => layoutNotes()).observe(pane);
      });
    }
  }

  // 点笔迹 → 滚到并闪一下对应旁注卡（替代旧浮层弹窗）
  svg.addEventListener('click', (ev) => {
    if (suppressClick) { suppressClick = false; return; }
    const target = ev.target && ev.target.closest ? ev.target.closest('[data-inkloop-ko]') : null;
    const card = target ? cardByKo.get(target.getAttribute('data-inkloop-ko') || '') : null;
    if (!card) return;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    card.classList.add('is-flash');
    setTimeout(() => card.classList.remove('is-flash'), 900);
  });

  return root;
}

function installSurfaceStyles(plugin) {
  const style = document.createElement('style');
  style.textContent = `
.inkloop-surface-mount{margin:6px 0 10px}
.inkloop-surface-header{display:flex;align-items:center;gap:10px;padding:3px 2px;font-size:.82em;color:var(--text-muted)}
/* ── 页面级图/文互斥（状态类由插件挂在 .markdown-preview-view 上，file-open 时清扫防串文件）：
   图模式：正文段/略过占位/未定位标题/callout（后处理器打了 inkloop-prose 标记的 section）全藏，
           只留页标题 + 手写控件；文模式：控件收起只剩头栏，页面文字 + callout 旁注显示。
   ⚠️不用 :has()/兄弟选择器——部分安装版内核不支持（上一版互斥就是死在这），标记全由 JS 打。 */
.markdown-preview-view.inkloop-mode-image .inkloop-prose{display:none}
.markdown-preview-view.inkloop-mode-text .inkloop-surface-snippets{display:none}

/* ── 被标注段的下划线（<u> 由导出侧包，插件只做精修样式；无插件时浏览器默认下划线兜底）。
      整段实线满屏拉线太吵（用户嫌丑），收敛成细点线 + 浅色 + 大偏移，只当"这段被标过"的轻提示。 ── */
.markdown-preview-view.inkloop-doc u{text-decoration-style:dotted;text-decoration-color:var(--text-faint);text-decoration-thickness:1px;text-underline-offset:5px}

/* ── 原文模式排版：正规双栏（Tufte 旁注栏方案）。
      sizer 右侧留出固定 340px 批注栏（padding-right），正文占满左列；
      [!inkloop] 旁注用 float:right + 负右边距整体拉进批注栏——正文永不回绕、
      旁注天然停在自己批注的那段文字的高度上，双栏对照关系稳定。
      「略过 N 段」降为小字浅色分隔符。 ── */
.markdown-preview-view.inkloop-doc .markdown-preview-sizer{max-width:min(1150px,96%);padding-top:34px}
@media (min-width:1000px){
  .markdown-preview-view.inkloop-mode-text .markdown-preview-sizer{padding-right:340px}
  .markdown-preview-view.inkloop-mode-text .callout[data-callout="inkloop"]{
    float:right;clear:right;
    width:310px;
    margin:2px -340px 16px 20px;
  }
}
.inkloop-gap p{font-size:.76em;color:var(--text-faint);letter-spacing:.1em;margin:.4em 0}

/* ── 右上悬浮「手写｜原文」切换 + 右侧浮动页码导航（host 的 position:relative 由 JS 内联设，不靠 :has） ── */
.inkloop-view-controls{position:absolute;top:8px;right:14px;z-index:30;display:flex;border:1px solid var(--background-modifier-border);border-radius:6px;overflow:hidden;background:var(--background-primary);box-shadow:0 2px 8px rgba(0,0,0,.06)}
.inkloop-view-controls button{font-size:.8em;padding:3px 14px;border:none;border-radius:0;background:transparent;color:var(--text-muted);cursor:pointer;box-shadow:none}
.inkloop-view-controls button.is-active{background:var(--background-modifier-hover);color:var(--text-normal);font-weight:600}
.inkloop-page-toc{position:absolute;right:10px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:6px;z-index:30}
.inkloop-page-toc-item{width:26px;height:26px;padding:0;border-radius:50%;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);font-size:.75em;line-height:1;cursor:pointer;box-shadow:none;opacity:.75}
.inkloop-page-toc-item:hover{opacity:1;color:var(--text-normal);border-color:var(--interactive-accent,var(--text-accent))}
.inkloop-surface-widget{margin:6px 0}
.inkloop-surface-cols{display:flex;gap:18px;align-items:flex-start}
.inkloop-surface-pane{flex:1 1 auto;min-width:0;position:relative;overflow:hidden;border:1px solid var(--background-modifier-border);border-radius:6px;background:var(--background-primary)}
.inkloop-surface-notes{flex:0 0 300px;max-width:42%;display:flex;flex-direction:column;gap:16px;padding-top:4px}
/* 宽屏下旁注卡纵向锚定到对应笔迹（top 由 JS 算），列本身转相对定位画布 */
.inkloop-surface-notes.is-anchored{display:block;position:relative;padding-top:0}
.inkloop-surface-notes.is-anchored .inkloop-note-card{position:absolute;left:0;right:0}
@media (max-width:760px){.inkloop-surface-cols{flex-direction:column}.inkloop-surface-notes{flex:none;max-width:none;width:100%}}
/* 高度帽 70vh：**必须有**——section 比视口高时，Obsidian 阅读视图的分段虚拟化会在滚到
   它中间时把整段内容摘掉（顶底都出屏 → 误判不可见 → 图"消失"，实测踩过）。帽内是 SVG
   preserveAspectRatio=meet 的整体缩放（居中、留白边），不会裁切内容；此前"被截断"的观感
   real 元凶是滚轮误缩放（已修），不是帽子。 */
.inkloop-surface-svg{display:block;width:100%;height:auto;max-height:70vh;cursor:grab;touch-action:none}
.inkloop-surface-svg:active{cursor:grabbing}
.inkloop-reader-text{user-select:none;text-rendering:geometricPrecision}
.inkloop-surface-stroke.has-note{cursor:pointer}
.inkloop-surface-svg.has-focus .inkloop-surface-stroke{opacity:.15}
.inkloop-surface-svg.has-focus .inkloop-surface-stroke.is-active{opacity:1}
.inkloop-surface-bar{position:absolute;top:6px;right:6px;display:flex;gap:4px;z-index:5;opacity:0;transition:opacity .15s}
.inkloop-surface-pane:hover .inkloop-surface-bar{opacity:1}
.inkloop-surface-bar button{font-size:.78em;padding:2px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);cursor:pointer;box-shadow:none}
.inkloop-surface-bar button:hover{color:var(--text-normal)}
.inkloop-surface-textview{padding:12px 16px;max-height:46vh;overflow:auto;font-size:.95em;line-height:1.75}
.inkloop-text-line{white-space:pre-wrap}
/* 标签/正文与原文侧 [!inkloop] 旁注同款：灰色小标签 + 正文常规体，无框无竖线 */
.inkloop-note-kind{font-size:.78em;letter-spacing:.08em;color:var(--text-faint)}
.inkloop-note-title{font-weight:600;font-size:.9em;line-height:1.45;margin:2px 0}
.inkloop-note-body{font-size:.84em;color:var(--text-muted);line-height:1.6;font-style:italic}
.inkloop-note-body p{margin:.3em 0}
/* 折叠态：正文截断 6 行，卡片可点展开（列总高超过快照高度时自动进入） */
.inkloop-note-card.is-clamped{cursor:pointer}
.inkloop-note-card.is-clamped .inkloop-note-body{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;overflow:hidden}
.inkloop-note-card.is-clamped::after{content:'⋯ 点击展开';display:block;font-size:.72em;color:var(--text-faint);margin-top:2px}
.inkloop-note-card.is-expanded{cursor:pointer}
.inkloop-note-card{border-radius:6px;padding:2px 8px;transition:background .3s}
.inkloop-note-card:hover{background:var(--background-modifier-hover)}
.inkloop-note-card.is-flash{background:var(--background-modifier-hover)}
.inkloop-surface-hint{color:var(--text-muted);font-style:italic;padding:4px 0}

/* ── InkLoop 文件隐藏属性框（tag 药丸太丑；tag 数据仍在，搜索/图谱不受影响）。
      inkloop-doc 类由插件读 frontmatter 后自己挂到 preview view（不赌 Obsidian cssclasses 的落点——实测
      挂 .markdown-preview-view 的紧凑选择器没生效过）；宽松版 .inkloop-note 选择器留作双保险。 */
.markdown-preview-view.inkloop-doc .metadata-container,
.inkloop-note .metadata-container,
.markdown-preview-view.inkloop-note .metadata-container{display:none}

/* ── [!inkloop] 旁注：替代默认蓝色 callout。无框无竖线（用户点名去掉引用符号），
      只留灰色小标签 + 正文，视觉与手写侧旁注卡完全同款。 */
.callout[data-callout="inkloop"]{
  background:transparent;
  border:none;
  border-radius:0;
  padding:2px 0;
  margin:6px 0 10px;
  font-size:.88em;
  line-height:1.6;
  --callout-color:var(--color-accent-rgb,var(--interactive-accent));
}
.callout[data-callout="inkloop"] .callout-title{
  color:var(--text-faint);
  font-size:.82em;
  letter-spacing:.08em;
  padding:0;
  margin-bottom:2px;
}
.callout[data-callout="inkloop"] .callout-title .callout-icon{display:none}
.callout[data-callout="inkloop"] .callout-content{color:var(--text-muted);padding:0;font-style:italic}
.callout[data-callout="inkloop"] .callout-content p{margin:.35em 0}
@media (min-width: 1000px){
  .markdown-reading-view .callout[data-callout="inkloop"]{
    float:right;clear:right;
    width:min(44%,300px);
    margin:2px 0 12px 20px;
  }
  /* 页标题/新段落前清掉浮动，旁注不越段乱窜 */
  .markdown-reading-view :is(h1,h2,h3){clear:right}
}
`;
  document.head.appendChild(style);
  plugin.register(() => style.remove());
}

const TEL_PATH = '.obsidian/plugins/inkloop-vault-sync/devtel.jsonl';
const TEL_BUILD = 'tel-14'; // 每次改插件 bump，日志里能看出跑的是哪个构建

module.exports = class InkloopVaultSync extends Plugin {
  /** 调试遥测：关键事件追加 JSONL 到插件目录（devtel.jsonl），供外部直接读文件诊断（无 devtools 时的替代）。 */
  tel(event, data) {
    try {
      const line = JSON.stringify({ t: new Date().toISOString(), e: event, ...(data || {}) }) + '\n';
      void this.app.vault.adapter.append(TEL_PATH, line).catch(() => {});
    } catch (_) { /* 遥测绝不影响功能 */ }
  }

  /** DOM 快照遥测：把 preview view 的类名、prose/挂载点/控件计数、前 40 个 section 的标签+类名全 dump。 */
  telSnapshot(reason) {
    try {
      const views = [...document.querySelectorAll('.markdown-preview-view')].map((v) => {
        const sizer = v.querySelector('.markdown-preview-sizer');
        return {
          cls: String(v.className),
          prose: v.querySelectorAll('.inkloop-prose').length,
          mounts: v.querySelectorAll('.inkloop-surface-mount').length,
          meta: v.querySelectorAll('.metadata-container').length,
          sections: [...((sizer && sizer.children) || [])].slice(0, 60).map((s) => {
            const cs = getComputedStyle(s);
            const mount = s.querySelector('.inkloop-surface-mount');
            const svg = s.querySelectorAll('.inkloop-surface-svg').length;
            const notes = s.querySelector('.inkloop-surface-notes');
            return `${s.tagName}:${String(s.className).replace(/\s+/g, '.')}`
              + ` h=${Math.round(s.getBoundingClientRect().height)} d=${cs.display}`
              + (mount ? ` [mount svg=${svg} paneH=${Math.round((s.querySelector('.inkloop-surface-pane') || s).getBoundingClientRect().height)} notesH=${notes ? Math.round(notes.getBoundingClientRect().height) : 0} notesMin=${notes ? notes.style.minHeight : ''}]` : '')
              + ((s.querySelector('pre') && !mount) ? ' [raw-pre]' : '')
              + ` «${(s.textContent || '').replace(/\s+/g, ' ').slice(0, 16)}»`;
          }),
        };
      });
      this.tel('snapshot', {
        reason,
        controls: document.querySelectorAll('.inkloop-view-controls').length,
        tocs: document.querySelectorAll('.inkloop-page-toc').length,
        sourceViews: document.querySelectorAll('.markdown-source-view').length,
        views,
      });
    } catch (e) { this.tel('snapshot-error', { err: String(e) }); }
  }

  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, data.settings || {});
    this.surfaceSidecarCache = new Map();
    this.tel('onload', { build: TEL_BUILD });
    this.addCommand({ id: 'inkloop-debug-snapshot', name: 'InkLoop: 调试快照', callback: () => this.telSnapshot('manual') });
    installSurfaceStyles(this);
    // 手写快照挂载点走代码块处理器：Obsidian 保证代码块拿到原文，不受阅读模式对裸 HTML class/data-* 的清洗影响
    //（实测裸 div 的 data-inkloop-* 会被清洗掉、postprocessor 定位不到→控件永不出现，故弃用 div 走代码块）。
    this.registerMarkdownCodeBlockProcessor('inkloop-surface', (source, el, ctx) => this.renderSurfaceCodeBlock(source, el, ctx));
    // InkLoop 文件（frontmatter cssclasses 带 inkloop-note）→ 给 preview view 挂 inkloop-doc 类（藏属性框用）。
    // 自己挂类而不是依赖 Obsidian 的 cssclasses 落点——后者版本间不一致，实测过选择器落空。
    // 有手写控件的文件（inkloop-surface-doc）再给"正文段/未定位标题/callout"的 section 打 inkloop-prose 标记，
    // 图模式靠它隐藏正文——**不用 :has()/兄弟选择器**（部分安装版内核不支持，上一版图文互斥就是死在这）。
    this.registerMarkdownPostProcessor((el, ctx) => {
      // ⚠️控件内部用 MarkdownRenderer 渲的笔记正文也会进这个后处理器（同 sourcePath）——必须先排除，
      // 否则旁注卡正文被打上 inkloop-prose、图模式下被自己藏掉（实测踩过：AI NOTE 只剩标签没内容）。
      if (el.closest && el.closest('.inkloop-note-md, .inkloop-surface-mount')) return;
      const cache = this.app.metadataCache.getCache((ctx && ctx.sourcePath) || '');
      const cls = [].concat((cache && cache.frontmatter && cache.frontmatter.cssclasses) || []);
      if (!cls.includes('inkloop-note')) return;
      whenAttached(el, () => {
        const view = el.closest('.markdown-preview-view');
        if (view) view.classList.add('inkloop-doc');
      });
      if (!cls.includes('inkloop-surface-doc')) return;
      const skip = !!el.querySelector('h1, h2, .inkloop-surface-mount, pre, code'); // 页标题/挂载点/代码块 section 不算正文
      const tagged = !skip && !!el.querySelector('p, h3, .callout');
      if (tagged) {
        el.classList.add('inkloop-prose');
        // 「⋯ 略过 N 段 ⋯」占位段单独打标：排版上降为小字浅色，不再跟正文一个视觉量级
        if (/^\s*⋯ 略过 \d+ 段 ⋯\s*$/.test(String(el.textContent || ''))) el.classList.add('inkloop-gap');
      }
      this.tel('pp-section', { skip, tagged, elCls: String(el.className), head: String(el.textContent || '').slice(0, 24) });
    });
    // 切换文件时清掉图/文模式类、inkloop-doc 类、悬浮控件和页码导航（preview view 元素会被复用，不清会把
    // 上一个文件的状态带给下一个；InkLoop 文件自己的挂载点/后处理器渲染时会重新设置）。
    // 另外：InkLoop 文件默认以**阅读视图**打开（导出是消费优先的成品，编辑要手动 Cmd/Ctrl+E 进）——
    // 属性框/原始语法不再进视野，图文互斥也只需要在阅读视图成立。
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      for (const el of document.querySelectorAll('.inkloop-mode-image, .inkloop-mode-text, .inkloop-doc')) el.classList.remove('inkloop-mode-image', 'inkloop-mode-text', 'inkloop-doc');
      for (const el of document.querySelectorAll('.inkloop-page-toc, .inkloop-view-controls')) el.remove();
      if (!file) return;
      const cache = this.app.metadataCache.getFileCache(file);
      const cls = [].concat((cache && cache.frontmatter && cache.frontmatter.cssclasses) || []);
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      this.tel('file-open', { path: file.path, inkloop: cls.includes('inkloop-note'), viewMode: view ? view.getMode() : 'none' });
      if (!cls.includes('inkloop-note')) return;
      if (!view || view.file !== file || view.getMode() !== 'source') return;
      const st = view.leaf.getViewState();
      st.state.mode = 'preview';
      void view.leaf.setViewState(st);
      this.tel('auto-preview', { path: file.path });
    }));
    this.addCommand({ id: 'inkloop-sync', name: 'InkLoop: 同步知识库', callback: () => this.runSync() });
    // 本地无线同步（WiFi 直连路的插件壳）：child_process 拉起 eink/sync-wifi.sh——
    // 发现设备→回环中继(绕 Shadowrocket 按进程拦截)→adb-TCP→CDP 让设备打包→逐文件落 vault。
    // 只是脚本的壳（绑定本机 adb/脚本路径），去 adb 化的正路=设备端内建 HTTP 服务+插件原生拉取（待做）。
    this.addCommand({ id: 'inkloop-local-wifi-sync', name: 'InkLoop: 本地无线同步（WiFi 直连拉取）', callback: () => this.runLocalWifiSync() });
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

  /** 「这个文件被用户在 Obsidian 里改过吗」：当前内容 hash ≠ 上次同步 hash（syncState 由插件同步或
   *  USB 拉取工具 pull-vault.py 写入）→ 改过。无 syncState 记录（从没同步过）按"没改过"处理。
   *  用途：决定手写快照默认展开（没改过→图优先）还是收起（改过→原文优先）。每次现读 data.json，
   *  USB 拉取后不用重载插件也能拿到新 state。 */
  async isFileEdited(path) {
    try {
      const data = (await this.loadData()) || {};
      const st = data.syncState && data.syncState[path];
      if (!st || !st.lastSyncedHash) return false;
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) return false;
      return (await sha256(await adapter.read(path))) !== st.lastSyncedHash;
    } catch (_) { return false; }
  }

  /** 代码块 `inkloop-surface`：body 是 {doc,page,surface,coord,layout} JSON。读同源 sidecar → 按笔迹聚类
   *  渲成若干"手写片段"小控件（每段手写 + 周围两三行文字，不是整页一大块），带头栏图/文切换：
   *  文件没被本地编辑过 → 默认展开（图优先）；编辑过 → 默认收起（原文优先，正文就在挂载点下方）。
   *  sidecar 缺失/未装同步 → 只显示一行提示（不空白）。这条不受阅读模式 HTML 清洗影响，是手写快照的可靠入口。 */
  async renderSurfaceCodeBlock(source, el, ctx) {
    // ⚠️别再加"section 高度占位/min-height 预留"——试过（tel-12），图模式防跳变没防住，
    // 反而在原文模式（控件隐藏）下留出巨大空白 section。虚拟化跳变问题接受现状。
    let spec = {};
    try { spec = JSON.parse(source); } catch (_) { /* 容错：坏 JSON 当空 spec，往下显示提示 */ }
    const docId = spec.doc;
    const pageIndex = Number(spec.page);
    const hint = el.createEl('div', { cls: 'inkloop-surface-hint', text: `手写页面 · 需 InkLoop 插件预览${spec.strokes ? `（${spec.strokes} 笔）` : ''}` });
    if (!docId || !Number.isFinite(pageIndex)) return;
    const sidecar = await this.readSurfaceSidecar(docId);
    if (!sidecar) return; // 缺失/失败 → 保留提示（绝不空白）
    const surface = spec.surface;
    const coord = spec.coord;
    const layout = String(spec.layout || '');
    const pages = sidecar.pages.filter((p) => p.page_index === pageIndex);
    const page = pages.find((p) => p.surface && p.surface.capture_surface === surface && p.surface.coord_space === coord && String(p.layout_id || '') === layout)
      || pages.find((p) => p.surface && p.surface.capture_surface === surface && p.surface.coord_space === coord)
      || pages[0];
    if (!page) return;
    hint.remove();

    const width = finiteNum(page.surface && page.surface.width) ? page.surface.width : 720;
    const height = finiteNum(page.surface && page.surface.height) ? page.surface.height : 1018;
    // 选节重启用（v2·行吸附版）：整页快照被用户否掉（区块太大+滚动跳变），
    // 小片段形态回归，切线吸附行边界不再切半行。
    const crops = clusterPageStrokes(page, width, height);

    const mount = el.createEl('div', { cls: 'inkloop-surface-mount' });
    const header = mount.createEl('div', { cls: 'inkloop-surface-header' });
    header.createEl('span', { cls: 'inkloop-surface-label', text: `✎ 手写 · ${(page.strokes || []).length} 笔` });
    const bodyEl = mount.createEl('div', { cls: 'inkloop-surface-snippets' });
    for (const crop of crops.length ? crops : [null]) bodyEl.appendChild(buildSurfaceWidget(this, ctx, page, sidecar.notes || {}, crop));

    // 挂进 DOM 后：设默认图/文模式（没编辑过→图优先；本地改过→原文优先）+ 建右上悬浮切换/页码导航。
    // live preview 里 closest 拿不到 preview view → 自然跳过（图文互斥只在阅读视图成立；InkLoop 文件
    // 由 file-open 钩子默认切到阅读视图）。
    whenAttached(mount, () => {
      void (async () => {
        const view = mount.closest('.markdown-preview-view');
        this.tel('mount-attached', { page: pageIndex, view: !!view });
        if (!view) return;
        if (!view.classList.contains('inkloop-mode-image') && !view.classList.contains('inkloop-mode-text')) {
          const edited = await this.isFileEdited((ctx && ctx.sourcePath) || '');
          view.classList.add(edited ? 'inkloop-mode-text' : 'inkloop-mode-image');
          this.tel('mode-default', { edited, viewCls: String(view.className) });
        }
        this.buildViewChrome(view, (ctx && ctx.sourcePath) || '');
        setTimeout(() => this.telSnapshot('after-chrome'), 1500); // 渲染稳定后自动 dump 一份 DOM 状态
      })();
    });
    el.classList.add('inkloop-page-surface-enhanced');
  }

  /** 右上悬浮「手写｜原文」切换（页面级一键互斥·文件级状态）+ 右侧浮动页码导航（长文档快速索引）。
   *  页码从 metadataCache 取 `## 第 N 页` 标题而不是扒 DOM——阅读视图虚拟渲染，后面的页可能还没进 DOM。 */
  buildViewChrome(view, sourcePath) {
    const host = view.closest('.view-content') || view.parentElement;
    if (!host || !sourcePath) return;
    host.style.position = 'relative'; // 悬浮件锚 host（不靠 :has 之类的新选择器）
    for (const old of host.querySelectorAll(':scope > .inkloop-view-controls, :scope > .inkloop-page-toc')) old.remove();

    const controls = host.createEl('div', { cls: 'inkloop-view-controls' });
    const btns = [
      { mode: 'inkloop-mode-image', text: '手写' },
      { mode: 'inkloop-mode-text', text: '原文' },
    ].map(({ mode, text }) => {
      const b = controls.createEl('button', { text });
      b.type = 'button';
      b.addEventListener('click', () => {
        view.classList.toggle('inkloop-mode-image', mode === 'inkloop-mode-image');
        view.classList.toggle('inkloop-mode-text', mode === 'inkloop-mode-text');
        sync();
        this.tel('mode-toggle', { mode, viewCls: String(view.className) });
        setTimeout(() => this.telSnapshot('after-toggle'), 300);
      });
      return { b, mode };
    });
    const sync = () => { for (const { b, mode } of btns) b.classList.toggle('is-active', view.classList.contains(mode)); };
    sync();

    const cache = this.app.metadataCache.getCache(sourcePath);
    const pages = ((cache && cache.headings) || []).filter((h) => h.level === 2 && /^第\s*\d+\s*页$/.test(h.heading));
    if (pages.length < 2) return;
    const toc = host.createEl('nav', { cls: 'inkloop-page-toc' });
    for (const h of pages) {
      const chip = toc.createEl('button', { cls: 'inkloop-page-toc-item', text: (h.heading.match(/\d+/) || ['·'])[0] });
      chip.type = 'button';
      chip.title = h.heading;
      chip.addEventListener('click', () => { void this.app.workspace.openLinkText(`#${h.heading}`, sourcePath); });
    }
  }

  /** 本地无线同步（WiFi 直连路的壳）：桌面版专用，child_process 跑 sync-wifi.sh，
   *  进度尾行滚动显示在 Notice 里。脚本自己会写 vault + 更新本插件 data.json 的 syncState。 */
  runLocalWifiSync() {
    if (this.localSyncBusy) { new Notice('InkLoop：本地无线同步已在进行中'); return; }
    let spawn, fs;
    try { ({ spawn } = require('child_process')); fs = require('fs'); }
    catch (_) { new Notice('InkLoop：本地无线同步仅支持桌面版'); return; }
    const SCRIPT = '/Users/edy/Desktop/Nova_project/eink/sync-wifi.sh';
    if (!fs.existsSync(SCRIPT)) { new Notice(`InkLoop：找不到同步脚本 ${SCRIPT}`); return; }
    this.localSyncBusy = true;
    this.tel('local-sync-start', {});
    const notice = new Notice('⏳ 本地无线同步：寻找设备…', 0);
    const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, ''); // 去 ANSI 色码
    let out = '';
    const child = spawn('/bin/bash', [SCRIPT], { env: Object.assign({}, process.env) });
    const onData = (buf) => {
      out += strip(buf);
      const lines = out.trim().split('\n');
      const tail = lines[lines.length - 1] || '';
      try { notice.setMessage(`⏳ 本地无线同步\n${tail.slice(0, 140)}`); } catch (_) { /* 老版 Notice 无 setMessage */ }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      this.localSyncBusy = false;
      try { notice.hide(); } catch (_) { }
      new Notice(`❌ 本地无线同步启动失败：${e && e.message ? e.message : e}`, 10000);
      this.tel('local-sync-fail', { err: String(e) });
    });
    child.on('close', (code) => {
      this.localSyncBusy = false;
      try { notice.hide(); } catch (_) { }
      if (code === 0) {
        const m = out.match(/wrote (\d+) files \((\d+)b\)/);
        new Notice(`✅ 本地无线同步完成${m ? `：${m[1]} 个文件 · ${(Number(m[2]) / 1048576).toFixed(1)}MB` : ''}`, 6000);
      } else {
        const tail = out.trim().split('\n').slice(-3).join('\n');
        new Notice(`❌ 本地无线同步失败（退出码 ${code}）\n${tail}`, 12000);
      }
      this.tel('local-sync-done', { code, tail: out.slice(-400) });
    });
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
