/**
 * 全局导航壳（常驻左侧栏）——整个应用的导航中枢，不是一个"控制台页"。
 *
 * 形态参照桌面端：侧栏常驻在最左、正文整体右移给它让位（body padding-left，非浮层覆盖）。
 * 侧栏列出**所有可用页面**，「阅读」是第一个、默认目的地，其余是平级目的地：
 *   · 阅读：主业务页（PDF 阅读 + 标注），其实是 body 原有的 topbar/main，侧栏只把它右移。
 *   · AI 会话：ChatGPT 式对话流 + 每轮「处理流水线」逐组件时间线（收到→产出+图）+ 思考过程。【已实现】
 *     —— 它已**取代**旧「上下文监控」面板（那面板的"喂了什么/回了什么/看到的图"被流水线全覆盖且更细、可持久，
 *        故不再单列入口；旧 inspect 面板仍留在 #dev 供直达，离线 dev-telemetry 镜像也照旧）。
 *   · 采集取证（感知层）：一页两段、深度联动——「HMP 取证（全书逐笔）」+「SurfaceIndex 对象（本页对象表）」；
 *     二者是同一批对象 id 的消费者/生产者（HMP.target_object_refs 指进对象表），命中 ref ↔ 对象行互跳。
 *     看"感知对不对"，是 AI 会话的姊妹镜。【已实现】
 *   · 设置：迁移中，暂跳旧 dev 页(#dev)，逐步搬进来后退役它。
 *
 * 非「阅读」的页面渲染进 #app-pages（覆盖正文区、不挡侧栏）。侧栏可折叠（键 m / 折叠钮），折叠时正文占满。
 */
import { bus, state } from '../app/state';
import { resetBook } from '../chat/buffer';
import { listBooks, getBookAiTurns, getFoldedMarks } from '../local/store';
import type { PersistedAiTurn, PersistedMark } from '../core/store-format';
import type { HMP, PipelineStage, PipelineStageIO, SurfaceObject } from '../core/contracts';

const esc = (s: string): string => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));

type PageId = 'reader' | 'chat' | 'hmp' | 'settings';
const PAGES: Array<{ id: PageId; icon: string; label: string; ready: boolean }> = [
  { id: 'reader', icon: '📖', label: '阅读', ready: true },
  { id: 'chat', icon: '💬', label: 'AI 会话', ready: true }, // 含逐组件处理流水线，已取代旧「上下文监控」
  { id: 'hmp', icon: '🔬', label: '采集取证', ready: true }, // 合并 HMP 取证 + SurfaceIndex 对象，深度联动
  { id: 'settings', icon: '⚙', label: '设置', ready: false },
];

let activePage: PageId = 'reader';
let selectedBook: string | null = null;

const fmtTime = (iso: string): string => {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return iso; }
};
const TRIGGER_CN: Record<string, { t: string; c: string }> = {
  idle: { t: '长停顿综合', c: '#3b82f6' },
  handwriting: { t: '手写定向', c: '#22c55e' },
  discussion: { t: '段落讨论', c: '#8a877f' },
};

function injectStyle(): void {
  if (document.getElementById('shell-style')) return;
  const s = document.createElement('style');
  s.id = 'shell-style';
  s.textContent = `
  body { --rail-w: 220px; padding-left: var(--rail-w); transition: padding-left .16s ease; }
  body.rail-collapsed { --rail-w: 0px; }
  #app-rail { position: fixed; left: 0; top: 0; bottom: 0; width: 220px; z-index: 46; display: flex; flex-direction: column;
    padding: 12px 10px; gap: 3px; background: var(--page); border-right: 1px solid var(--line); transition: transform .16s ease; }
  body.rail-collapsed #app-rail { transform: translateX(-220px); }
  .rail-head { display: flex; align-items: center; gap: 8px; padding: 4px 6px 10px; }
  .rail-brand { font: 600 14.5px var(--sans); flex: 1; }
  .rail-iconbtn { border: 0; background: transparent; color: var(--mut); font-size: 15px; cursor: pointer; padding: 4px 6px; border-radius: 7px; }
  .rail-iconbtn:hover { background: var(--hl); color: var(--ink); }
  .rail-item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 9px 10px; border: 0; border-radius: 9px;
    background: transparent; color: var(--ink); font-size: 13.5px; cursor: pointer; font-family: var(--sans); }
  .rail-item:hover { background: var(--hl); }
  .rail-item.active { background: var(--ink); color: var(--page); }
  .rail-item .rail-ico { width: 18px; text-align: center; }
  .rail-item .rail-soon { margin-left: auto; font-size: 10px; color: var(--hint); }
  .rail-item.active .rail-soon { color: var(--hl); }
  .rail-spacer { flex: 1; }
  .rail-foot { border-top: 1px solid var(--line); padding-top: 8px; }
  #rail-reopen { position: fixed; left: 10px; top: 9px; z-index: 47; display: none; width: 32px; height: 32px; border: 1px solid var(--line);
    border-radius: 8px; background: var(--page); color: var(--ink); cursor: pointer; font-size: 15px; }
  body.rail-collapsed #rail-reopen { display: block; }

  #app-pages { position: fixed; left: var(--rail-w); top: 0; right: 0; bottom: 0; z-index: 38; background: var(--paper); color: var(--ink);
    font-family: var(--sans); transition: left .16s ease; display: none; }
  #app-pages.show { display: flex; flex-direction: column; }
  #app-page-content { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }

  .cns-head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 14px 20px; border-bottom: 1px solid var(--line); }
  .cns-head h2 { margin: 0; font-size: 16px; font-weight: 600; white-space: nowrap; }
  .cns-head-ctl { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cns-head-ctl select, .cns-btn { font-family: var(--sans); font-size: 12.5px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px;
    background: var(--page); color: var(--ink); cursor: pointer; max-width: 240px; white-space: nowrap; flex-shrink: 0; }
  .cns-btn:hover { background: var(--hl); }
  .cns-empty { color: var(--hint); font-size: 13px; text-align: center; padding: 48px 16px; }
  .cns-placeholder { margin: auto; text-align: center; color: var(--hint); }
  .cns-placeholder .cns-btn { margin-top: 14px; }

  /* ChatGPT 式对话流 */
  .cns-thread { flex: 1; overflow-y: auto; padding: 22px 0; min-height: 0; }
  .cns-thread-inner { max-width: 820px; margin: 0 auto; padding: 0 24px; }
  .cns-turn { margin-bottom: 24px; }
  .cns-label { font-size: 11px; color: var(--hint); margin: 0 2px 4px; }
  .cns-row { display: flex; }
  .cns-row.user { justify-content: flex-end; }
  .cns-row.user .cns-label { text-align: right; }
  .cns-col { max-width: 88%; display: flex; flex-direction: column; }
  .cns-bub { border-radius: 14px; padding: 11px 14px; font-size: 13.5px; line-height: 1.62; white-space: pre-wrap; word-break: break-word; }
  .cns-bub.user { background: var(--ink); color: var(--page); border-bottom-right-radius: 4px; }
  .cns-bub.ai { background: var(--page); color: var(--ink); border: 1px solid var(--line); border-bottom-left-radius: 4px; }
  .cns-meta { font-size: 11px; color: var(--hint); margin: 4px 2px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .cns-row.user .cns-meta { justify-content: flex-end; }
  .cns-trig { font-size: 10px; font-weight: 600; padding: 1px 7px; border-radius: 20px; color: #fff; }
  .cns-think { margin-top: 8px; border: 1px dashed var(--ai-line); border-radius: 10px; background: var(--ai-bg); }
  .cns-think summary { cursor: pointer; padding: 7px 12px; font-size: 12px; color: var(--mut); list-style: none; }
  .cns-think summary::-webkit-details-marker { display: none; }
  .cns-think summary::before { content: '▸ '; }
  .cns-think[open] summary::before { content: '▾ '; }
  .cns-think-body { padding: 4px 12px 11px; font-size: 12.5px; line-height: 1.62; color: var(--mut); white-space: pre-wrap; word-break: break-word; border-top: 1px dashed var(--ai-line); }
  .cns-nothink { font-size: 11px; color: var(--hint); margin-top: 6px; font-style: italic; }

  /* 用户内容块：全流程上下文分类展示（结构化卡片） */
  .cns-userwrap { width: 100%; }
  .cns-usercard { width: 100%; background: var(--hl); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
  .cns-sec { font-size: 11px; font-weight: 600; color: var(--mut); margin: 12px 0 5px; letter-spacing: .03em; }
  .cns-sec:first-child { margin-top: 0; }
  .cns-kv { font-size: 12.5px; line-height: 1.62; margin: 3px 0; word-break: break-word; }
  .cns-kv .k { color: var(--hint); }
  .cns-chip { display: inline-block; font-size: 11.5px; background: var(--page); border: 1px solid var(--line); border-radius: 7px; padding: 2px 8px; margin: 2px 5px 2px 0; }
  .cns-yes { color: var(--ok); font-weight: 600; }
  .cns-no { color: var(--bad); font-weight: 600; }
  .cns-ctx { margin-top: 8px; border: 1px solid var(--line); border-radius: 9px; background: var(--page); }
  .cns-ctx summary { cursor: pointer; padding: 7px 11px; font-size: 12px; color: var(--mut); list-style: none; display: flex; gap: 9px; align-items: baseline; }
  .cns-ctx summary::-webkit-details-marker { display: none; }
  .cns-ctx summary::before { content: '▸'; color: var(--hint); flex-shrink: 0; }
  .cns-ctx[open] summary::before { content: '▾'; }
  .cns-ctx-h { font-weight: 600; white-space: nowrap; flex-shrink: 0; }
  .cns-ctx-prev { color: var(--hint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .cns-ctx[open] .cns-ctx-prev { display: none; }
  .cns-ctx-body { padding: 4px 12px 11px; font-size: 12px; line-height: 1.62; color: var(--ink); white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow-y: auto; border-top: 1px dashed var(--line); }

  /* 处理流水线：逐组件「收到什么 → 产出什么」时间线 */
  .cns-pl { margin-top: 4px; position: relative; padding-left: 14px; }
  .cns-pl::before { content: ''; position: absolute; left: 4px; top: 6px; bottom: 6px; width: 2px; background: var(--line); border-radius: 2px; }
  .cns-pl-stage { position: relative; border: 1px solid var(--line); border-radius: 10px; margin: 8px 0; background: var(--page); }
  .cns-pl-stage::before { content: ''; position: absolute; left: -12px; top: 13px; width: 8px; height: 8px; border-radius: 50%; background: var(--ink); border: 2px solid var(--page); }
  .cns-pl-stage.skipped { opacity: .72; border-style: dashed; }
  .cns-pl-stage.skipped::before { background: var(--hint); }
  .cns-pl-stage.error { border-color: var(--bad); }
  .cns-pl-stage.error::before { background: var(--bad); }
  .cns-pl-sum { cursor: pointer; padding: 8px 11px; font-size: 12.5px; display: flex; gap: 7px; align-items: baseline; list-style: none; flex-wrap: wrap; }
  .cns-pl-sum::-webkit-details-marker { display: none; }
  .cns-pl-sum::before { content: '▸'; color: var(--hint); flex-shrink: 0; }
  .cns-pl-stage[open] .cns-pl-sum::before { content: '▾'; }
  .cns-pl-name { font-weight: 600; flex-shrink: 0; }
  .cns-pl-tag { font-size: 10px; padding: 1px 6px; border-radius: 10px; flex-shrink: 0; }
  .cns-pl-tag.skipped { background: var(--hl); color: var(--mut); }
  .cns-pl-tag.error { background: var(--bad); color: #fff; }
  .cns-pl-note { color: var(--hint); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  .cns-pl-mark { font-size: 10px; background: var(--hl); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; color: var(--mut); flex-shrink: 0; }
  .cns-pl-body { padding: 3px 12px 11px; border-top: 1px dashed var(--line); }
  .cns-pl-io { margin: 9px 0 0; }
  .cns-pl-io-h { font-size: 10.5px; font-weight: 600; letter-spacing: .04em; color: var(--mut); margin-bottom: 3px; }
  .cns-pl-io-h.out { color: var(--ok); }
  .cns-pl-kv { font-size: 12px; line-height: 1.6; margin: 2px 0; word-break: break-word; }
  .cns-pl-kv .k { color: var(--hint); }
  .cns-pl-kv .v { white-space: pre-wrap; }
  .cns-pl-kv .v.long { display: block; margin-top: 2px; max-height: 200px; overflow-y: auto; background: var(--hl); border-radius: 6px; padding: 6px 8px; }
  .cns-pl-imgs { display: flex; gap: 9px; flex-wrap: wrap; margin-top: 9px; }
  .cns-pl-img { display: flex; flex-direction: column; gap: 3px; align-items: center; }
  .cns-pl-img img { max-height: 100px; max-width: 150px; border: 1px solid var(--line); border-radius: 6px; cursor: zoom-in; background: #fff; }
  .cns-pl-img span { font-size: 10px; color: var(--hint); max-width: 150px; text-align: center; }

  /* 图片放大 lightbox */
  .cns-lb { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.8); display: none; align-items: center; justify-content: center; padding: 28px; cursor: zoom-out; }
  .cns-lb.show { display: flex; }
  .cns-lb img { max-width: 95%; max-height: 95%; border-radius: 6px; background: #fff; box-shadow: 0 10px 50px rgba(0,0,0,.55); }

  /* 标注取证 HMP 页：逐 mark 取证卡 */
  .hmp-inner { max-width: 880px; margin: 0 auto; padding: 0 24px; }
  .hmp-note { font-size: 11.5px; color: var(--hint); margin: 0 2px 16px; line-height: 1.65; }
  .hmp-card { border: 1px solid var(--line); border-radius: 12px; background: var(--page); padding: 12px 14px; margin-bottom: 14px; }
  .hmp-chead { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
  .hmp-mode { font-size: 11px; font-weight: 600; padding: 1px 9px; border-radius: 20px; color: #fff; flex-shrink: 0; }
  .hmp-act { font-weight: 600; font-size: 13.5px; }
  .hmp-feat { font-size: 10.5px; color: var(--mut); background: var(--hl); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; }
  .hmp-live { font-size: 10px; color: var(--ok); border: 1px solid var(--ok); border-radius: 6px; padding: 1px 6px; }
  .hmp-cmeta { margin-left: auto; font-size: 11px; color: var(--hint); white-space: nowrap; }
  .hmp-body { display: flex; gap: 14px; margin-top: 11px; align-items: flex-start; }
  .hmp-shots { display: flex; gap: 8px; flex-shrink: 0; }
  .hmp-shot { display: flex; flex-direction: column; gap: 3px; align-items: center; }
  .hmp-shot img { max-height: 104px; max-width: 150px; border: 1px solid var(--line); border-radius: 6px; cursor: zoom-in; background: #fff; }
  .hmp-shot span { font-size: 10px; color: var(--hint); }
  .hmp-noshot { flex-shrink: 0; width: 132px; min-height: 70px; border: 1px dashed var(--line); border-radius: 8px; color: var(--hint); font-size: 11px; line-height: 1.5; display: flex; align-items: center; justify-content: center; text-align: center; padding: 8px; }
  .hmp-fields { flex: 1; min-width: 0; }
  .hmp-fields .cns-kv { margin: 3px 0; }
  .hmp-miss { color: var(--bad); font-weight: 600; }
  .hmp-xpage { color: var(--hint); }

  /* 采集取证页：分段切换 + 对象表 + ref↔对象 互跳 */
  #cap-seg { display: flex; gap: 4px; margin-left: 14px; background: var(--hl); border-radius: 9px; padding: 3px; }
  .cap-segbtn { border: 0; background: transparent; color: var(--mut); font: 600 12.5px var(--sans); padding: 5px 12px; border-radius: 7px; cursor: pointer; white-space: nowrap; }
  .cap-segbtn.active { background: var(--page); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .cap-pane { display: none; }
  #cap-wrap[data-seg="hmp"] .cap-hmp { display: block; }
  #cap-wrap[data-seg="objects"] .cap-obj { display: block; }
  .obj-inner { max-width: 1080px; margin: 0 auto; padding: 0 24px; }
  .cap-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
  .cap-tbl th, .cap-tbl td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .cap-tbl th { color: var(--mut); font-weight: 600; position: sticky; top: 0; background: var(--paper); z-index: 1; }
  .cap-tbl tr[data-objid]:hover { background: var(--hl); }
  .cap-mono { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; color: var(--mut); word-break: break-all; }
  .cap-dim { color: var(--hint); }
  .cap-link { color: #3b6fb3; text-decoration: underline dotted; text-underline-offset: 2px; cursor: pointer; }
  .cap-link:hover { color: #2a5894; background: var(--hl); border-radius: 4px; }
  .cap-markchip { display: inline-block; font-size: 11px; background: var(--hl); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; margin: 1px 4px 1px 0; cursor: pointer; color: var(--mut); }
  .cap-markchip:hover { background: var(--page); color: var(--ink); }
  .cap-tbl tr.cap-flash { animation: capflashbg 1.4s ease; }
  .hmp-card.cap-flash { animation: capflashcard 1.4s ease; }
  @keyframes capflashbg { 0%, 28% { background: #fde68a; } 100% { background: transparent; } }
  @keyframes capflashcard { 0%, 28% { background: #fde68a; } 100% { background: var(--page); } }
  `;
  document.head.appendChild(s);
}

function buildShell(): void {
  if (document.getElementById('app-rail')) return;
  injectStyle();

  const rail = document.createElement('nav');
  rail.id = 'app-rail';
  rail.innerHTML =
    `<div class="rail-head"><span class="rail-brand">◐ InkLoop</span><button class="rail-iconbtn" id="rail-collapse" title="收起侧栏（m）">«</button></div>`
    + PAGES.map((p) => `<button class="rail-item" data-page="${p.id}"><span class="rail-ico">${p.icon}</span><span>${esc(p.label)}</span>${p.ready ? '' : '<span class="rail-soon">迁移中</span>'}</button>`).join('')
    + `<div class="rail-spacer"></div>`
    + `<div class="rail-foot"><button class="rail-item" id="rail-dev" style="font-size:12px;color:var(--mut)"><span class="rail-ico">⌗</span><span>旧 dev 面板（d）</span></button></div>`;
  document.body.appendChild(rail);

  const reopen = document.createElement('button');
  reopen.id = 'rail-reopen';
  reopen.title = '展开侧栏（m）';
  reopen.textContent = '☰';
  document.body.appendChild(reopen);

  const pages = document.createElement('div');
  pages.id = 'app-pages';
  pages.innerHTML = `<div id="app-page-content"></div>`;
  document.body.appendChild(pages);

  // 图片放大层（流水线里的缩略图点开看大图）
  const lb = document.createElement('div');
  lb.id = 'cns-lightbox';
  lb.className = 'cns-lb';
  lb.innerHTML = '<img alt="">';
  lb.addEventListener('click', () => lb.classList.remove('show'));
  document.body.appendChild(lb);

  rail.querySelectorAll<HTMLButtonElement>('.rail-item[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => go(btn.dataset.page as PageId));
  });
  rail.querySelector('#rail-dev')!.addEventListener('click', () => { location.hash = 'dev'; });
  rail.querySelector('#rail-collapse')!.addEventListener('click', () => setCollapsed(true));
  reopen.addEventListener('click', () => setCollapsed(false));
}

function setCollapsed(c: boolean): void {
  document.body.classList.toggle('rail-collapsed', c);
  try { localStorage.setItem('inkloop.rail.collapsed', c ? '1' : '0'); } catch { /* ignore */ }
}

function highlight(): void {
  document.querySelectorAll<HTMLButtonElement>('#app-rail .rail-item[data-page]')
    .forEach((b) => b.classList.toggle('active', b.dataset.page === activePage));
}

/** 导航到某页（迁移中的页跳旧 dev；reader 收起页面层；其余渲染进 #app-pages）。 */
function go(id: PageId): void {
  const def = PAGES.find((p) => p.id === id);
  if (def && !def.ready) { location.hash = 'dev'; return; }
  if (id === 'reader') {
    if (location.hash === '#chat') history.replaceState(null, '', location.pathname + location.search);
    showPage('reader');
  } else {
    if (location.hash !== '#' + id) location.hash = id; else showPage(id);
  }
}

function showPage(id: PageId): void {
  activePage = id;
  highlight();
  const pages = document.getElementById('app-pages');
  if (!pages) return;
  if (id === 'reader') { pages.classList.remove('show'); return; }
  pages.classList.add('show');
  const content = document.getElementById('app-page-content') as HTMLDivElement | null;
  if (content) renderPage(id, content);
}

function renderPage(id: PageId, content: HTMLDivElement): void {
  if (id === 'chat') { renderChat(content); return; }
  if (id === 'hmp') { renderCapture(content); return; }
  const label = PAGES.find((p) => p.id === id)?.label ?? '';
  content.innerHTML = `<div class="cns-placeholder"><div style="font-size:15px">「${esc(label)}」迁移中</div>`
    + `<div style="font-size:12.5px;margin-top:6px">暂时还在旧 dev 页，稍后搬进来。</div>`
    + `<button class="cns-btn" id="cns-open-dev">打开旧 dev 页（d）</button></div>`;
  content.querySelector('#cns-open-dev')?.addEventListener('click', () => { location.hash = 'dev'; });
}

/* ── AI 会话页（ChatGPT 式对话流）─────────────────────────────────────────── */

function renderChat(c: HTMLDivElement): void {
  if (!selectedBook) selectedBook = state.documentId ?? null;
  c.innerHTML =
    `<div class="cns-head"><h2>💬 AI 会话</h2><div class="cns-head-ctl">`
    + `<select id="cns-book-sel"></select>`
    + `<button class="cns-btn" id="cns-refresh">⟳ 刷新</button>`
    + `<button class="cns-btn" id="cns-clear" title="清空这本书模型当下记得的对话上下文（≤24 轮滑动窗），不影响账本">🗑 清空上下文</button>`
    + `</div></div>`
    + `<div class="cns-thread" id="cns-thread"><div class="cns-thread-inner" id="cns-thread-inner"></div></div>`;

  const sel = c.querySelector<HTMLSelectElement>('#cns-book-sel');
  sel?.addEventListener('change', () => { selectedBook = sel.value; void renderConversation(); });
  c.querySelector('#cns-refresh')?.addEventListener('click', () => { void fillBookSelect().then(() => renderConversation()); });
  c.querySelector('#cns-clear')?.addEventListener('click', () => { if (selectedBook) { resetBook(selectedBook); } });

  // 先填书目（异步、可能自动选第一本书设 selectedBook）→ 再渲染对话，避免在 selectedBook 落定前渲染出空。
  void fillBookSelect().then(() => renderConversation());
}

async function fillBookSelect(selId = 'cns-book-sel'): Promise<void> {
  const sel = document.getElementById(selId) as HTMLSelectElement | null;
  if (!sel) return;
  const books = (await listBooks()).map((b) => ({ id: b.document_id, name: b.filename }));
  const opts = books.length ? books : (selectedBook ? [{ id: selectedBook, name: '(当前书)' }] : []);
  sel.innerHTML = opts.map((b) => `<option value="${esc(b.id)}"${b.id === selectedBook ? ' selected' : ''}>${esc(b.name || b.id)}</option>`).join('')
    || '<option value="">（暂无书籍）</option>';
  if (!selectedBook && opts[0]) selectedBook = opts[0].id;
}

async function renderConversation(): Promise<void> {
  const inner = document.getElementById('cns-thread-inner');
  const thread = document.getElementById('cns-thread');
  if (!inner) return;
  const turns: PersistedAiTurn[] = selectedBook ? await getBookAiTurns(selectedBook) : [];
  const shown = turns.filter((t) => t.overlay_state !== 'dismissed'); // 时间序（旧→新），最新在底
  if (!shown.length) {
    inner.innerHTML = `<p class="cns-empty">这本书还没有 AI 对话。<br>圈/划/写一处、停笔，每一轮「发送给 AI 的内容 + 回复 + 思考」会在这里成串出现。</p>`;
    return;
  }
  const marks = selectedBook ? await getFoldedMarks(selectedBook) : [];
  const markMap = new Map(marks.map((m) => [m.mark_id, m]));
  inner.innerHTML = shown.map((t, i) => turnBlock(t, i + 1, markMap)).join('');
  if (thread) thread.scrollTop = thread.scrollHeight; // 像聊天：滚到最新
}

const SHAPE_CN: Record<string, string> = { circle: '圈', underline: '划线', highlight: '高亮', arrow: '箭头', margin_note: '手写', stroke: '标记', tap_region: '点选' };
/** 一个 mark 的"识别结果"标签：手写/画/markup + 识别出的文字（识别分类器的产物）。 */
function featureLabel(m: PersistedMark): string {
  const txt = (m.marked_text || '').replace(/\s+/g, ' ').slice(0, 18);
  if (m.feature_type === 'handwriting') return `手写「${txt || '…'}」`;
  if (m.feature_type === 'drawing') return `画${txt ? `「${txt}」` : '（无字）'}`;
  return `${SHAPE_CN[m.scored_type] || '标记'}「${txt || '—'}」`;
}

/* ── 处理流水线渲染（逐组件「收到什么 → 产出什么」时间线）─────────────────────── */

function ioRows(rows?: PipelineStageIO[]): string {
  if (!rows?.length) return '';
  return rows.map((r) => {
    const val = r.v || '';
    const long = val.length > 64 || val.includes('\n');
    return `<div class="cns-pl-kv"><span class="k">${esc(r.k)}：</span><span class="v${long ? ' long' : ''}">${esc(val || '—')}</span></div>`;
  }).join('');
}
function imgRow(imgs?: Array<{ role: string; thumb: string }>): string {
  if (!imgs?.length) return '';
  return `<div class="cns-pl-imgs">`
    + imgs.map((im) => `<div class="cns-pl-img"><img class="cns-zoom" src="${im.thumb}" alt=""><span>${esc(im.role)}</span></div>`).join('')
    + `</div>`;
}
/** 一个组件阶段卡：summary（mark 标 + 名 + 状态 + note）+ body（收到 → 图 → 产出）。 */
function stageCard(st: PipelineStage): string {
  const open = (st.stage === 'model' || st.stage === 'inferview') ? ' open' : ''; // 末两步默认展开
  const tag = st.status === 'skipped' ? '<span class="cns-pl-tag skipped">跳过</span>'
    : st.status === 'error' ? '<span class="cns-pl-tag error">出错</span>' : '';
  const markChip = st.mark_ord ? `<span class="cns-pl-mark">mark ${st.mark_ord}·${esc(st.mark_label || '')}</span>` : '';
  return `<details class="cns-pl-stage ${st.status ?? ''}"${open}>`
    + `<summary class="cns-pl-sum">${markChip}<span class="cns-pl-name">${esc(st.label)}</span>${tag}<span class="cns-pl-note">${esc(st.note || '')}</span></summary>`
    + `<div class="cns-pl-body">`
    + (st.input?.length ? `<div class="cns-pl-io"><div class="cns-pl-io-h">↓ 收到（输入）</div>${ioRows(st.input)}</div>` : '')
    + imgRow(st.images)
    + (st.output?.length ? `<div class="cns-pl-io"><div class="cns-pl-io-h out">↑ 产出（输出）</div>${ioRows(st.output)}</div>` : '')
    + `</div></details>`;
}
function pipelineSection(stages: PipelineStage[]): string {
  return `<div class="cns-sec">处理流水线（逐组件：收到什么 → 产出什么 · ${stages.length} 步）</div>`
    + `<div class="cns-pl">` + stages.map(stageCard).join('') + `</div>`;
}

/** 旧轮（无 pipeline 快照）的兜底展示：保留分类器判定 + 蒸馏字段 + 正文/prompt 折叠块。 */
function legacySection(t: PersistedAiTurn, markMap: Map<string, PersistedMark>): string {
  const v = t.inference_view;
  const diag = t.diag ?? {};
  const classify = diag.classify
    ? `<div class="cns-kv"><span class="k">上下文分类器：</span>${diag.classify.respond ? '<span class="cns-yes">回应 ✓</span>' : '<span class="cns-no">折叠 ✗</span>'} — ${esc(diag.classify.reason || '')}</div>`
    : `<div class="cns-kv"><span class="k">上下文分类器：</span>未触发（长停顿综合走 idle，无需判定）</div>`;
  const chips = (t.anchor?.mark_ids ?? []).map((id) => markMap.get(id)).filter((m): m is PersistedMark => !!m)
    .map((m) => `<span class="cns-chip">${esc(featureLabel(m))}</span>`).join('');
  const markRow = `<div class="cns-kv"><span class="k">识别（逐 mark）：</span>${chips || '<span class="cns-chip" style="color:var(--hint)">（无 mark 记录）</span>'}</div>`;
  const q = v?.question ? `<div class="cns-kv"><span class="k">手写问：</span>${esc(v.question)}</div>` : '';
  const sentImg = diag.sent_image ? '<span class="cns-yes">有</span>' : '无';
  const ctx = v?.page_context || '';
  const ctxBlock = ctx
    ? `<details class="cns-ctx"><summary><span class="cns-ctx-h">📄 正文块（滑动窗 ${ctx.length} 字）</span><span class="cns-ctx-prev">${esc(ctx.slice(0, 150))}…</span></summary><div class="cns-ctx-body">${esc(ctx)}</div></details>`
    : `<div class="cns-kv"><span class="k">正文块：</span>（无）</div>`;
  const prompt = t.prompt_snapshot || '';
  const promptBlock = `<details class="cns-ctx"><summary><span class="cns-ctx-h">🧾 完整 prompt（${prompt.length} 字）</span><span class="cns-ctx-prev">${esc(prompt.slice(0, 130))}…</span></summary><div class="cns-ctx-body">${esc(prompt || '—')}</div></details>`;
  return `<div class="cns-sec">分类器判定</div>` + classify + markRow
    + `<div class="cns-sec">蒸馏后喂入（inference-view）</div>`
    + `<div class="cns-kv"><span class="k">关系叙事：</span>${esc(v?.narrative || '—')}</div>`
    + `<div class="cns-kv"><span class="k">所标内容：</span>${esc(v?.marked || '—')}</div>`
    + q
    + `<div class="cns-kv"><span class="k">锚点：</span>${t.anchor?.object_refs?.length ?? 0} 对象 / ${t.anchor?.mark_ids?.length ?? 0} 笔 · 随发图：${sentImg}</div>`
    + ctxBlock + promptBlock;
}

/**
 * 一轮 = 用户内容块 + AI 回复气泡（含思考过程）。
 *   用户块：有处理流水线快照(pipeline)→渲染逐组件「收到→产出」时间线（含图）；
 *   旧轮无快照→兜底走 legacySection（分类器判定 + 蒸馏字段 + 正文/prompt 折叠）。
 */
function turnBlock(t: PersistedAiTurn, idx: number, markMap: Map<string, PersistedMark>): string {
  const trig = TRIGGER_CN[t.trigger] ?? { t: t.trigger, c: '#8a877f' };
  const reply = t.ai_reply || '（空回复）';
  const think = (t.thinking || '').trim();
  const userInner = (t.pipeline && t.pipeline.length) ? pipelineSection(t.pipeline) : legacySection(t, markMap);

  const thinkBlock = think
    ? `<details class="cns-think"><summary>💭 思考过程（${think.length} 字）</summary><div class="cns-think-body">${esc(think)}</div></details>`
    : `<div class="cns-nothink">无思考过程返回（当前模型不回传；切到 claude-sonnet-4-6 可见）</div>`;

  return `<div class="cns-turn">`
    + `<div class="cns-label">发送给 AI 的内容 · 第 ${(t.page_index ?? 0) + 1} 页 · <span class="cns-trig" style="background:${trig.c}">${esc(trig.t)}</span> · ${fmtTime(t.created_at)}</div>`
    + `<div class="cns-userwrap"><div class="cns-usercard">` + userInner + `</div></div>`
    + `<div class="cns-label" style="margin-top:14px">AI 回复</div>`
    + `<div class="cns-row ai"><div class="cns-col"><div class="cns-bub ai">${esc(reply)}</div>`
    + thinkBlock
    + `<div class="cns-meta">#${idx} · ${esc(t.model || '')}${t.supersedes ? ' · 改写' : ''}</div></div></div>`
    + `</div>`;
}

/* ── 采集取证 / 感知层页（合并 HMP 取证 + SurfaceIndex 对象，深度联动）────────────────
 * 一页两段：① HMP 取证（全书逐笔，新→旧）② SurfaceIndex 对象（本页对象表，refs 的字典）。
 * 二者是同一批对象 id 的消费者/生产者——HMP.target_object_refs 指进对象表。互跳：点 HMP 命中
 * 对象 ref → 跳对象段高亮那行；对象行「被命中」chip → 跳 HMP 段高亮那张卡。
 * 对象 id 是页内的，故互跳/原文解析天然只对当前页成立（state.surfaceIndex 只有当前页）。
 * HMP 段骨架=每本书折叠 mark 账本（getFoldedMarks，持久·全量·跨 reload），叠本会话 state.lastHmps
 * 的取证图（落库剥 crop/ink，仅本会话标注带图）+ 未落库最新一笔即时占位。 */

let captureSeg: 'hmp' | 'objects' = 'hmp';

const HMP_MODE: Record<string, { t: string; c: string }> = {
  anchored: { t: '锚定原文', c: '#22c55e' }, self_content: { t: '自身内容', c: '#f59e0b' },
  mixed: { t: '混合', c: '#3b82f6' }, unknown: { t: '未命中', c: '#ef4444' },
};
const HMP_ACTION: Record<string, string> = { enclosure: '圈', underline: '划线', cross: '叉', arrow: '箭头', handwriting: '手写', sketch: '草图', highlight: '高亮', unknown: '未知' };
const HMP_HINT: Record<string, string> = { text: '文字', image_region: '图区', ui_region: 'UI', blank: '空白', diagram: '图表', unknown: '未知' };
const HMP_FEAT: Record<string, string> = { markup: '标记', handwriting: '手写', drawing: '画' };

/** 一行取证记录：账本 mark 为骨架，可叠本会话取证图。 */
interface HmpRow {
  key: string; hmp: HMP; marked: string; feature: string;
  page_index: number; page_id: string; seq: number; live: boolean; unsaved: boolean;
}

function featureFromAction(action: string): string {
  if (action === 'handwriting') return 'handwriting';
  if (action === 'sketch') return 'drawing';
  return 'markup';
}

async function buildHmpRows(book: string): Promise<HmpRow[]> {
  const persisted = (await getFoldedMarks(book)).filter((m) => m.hmp);
  const liveById = new Map(state.lastHmps.map((h) => [h.hmp_id, h]));
  const seen = new Set<string>();
  const rows: HmpRow[] = persisted.map((m) => {
    const id = m.hmp!.hmp_id; seen.add(id);
    const live = liveById.get(id);
    // 账本剥了图：若本会话还留着同一条 HMP，把 crop/ink 借回来显示
    const hmp = live && (live.crop_ref || live.vector_ref) ? { ...m.hmp!, crop_ref: live.crop_ref, vector_ref: live.vector_ref } : m.hmp!;
    return { key: m.mark_id, hmp, marked: m.marked_text, feature: m.feature_type, page_index: m.page_index, page_id: m.page_id, seq: m.seq, live: !!live, unsaved: false };
  });
  // 未落库的最新一笔（hmp:updated 早于 appendMarkEntry 一个 tick）：即时占位。lastHmps 是全局的，
  // 只在"选中书=当前打开的书"时才并入，避免把别的书的未落库笔串进来。
  if (selectedBook === state.documentId) {
    for (const h of state.lastHmps) {
      if (seen.has(h.hmp_id)) continue;
      rows.push({ key: h.hmp_id, hmp: h, marked: h.text_hint || '', feature: featureFromAction(h.action), page_index: state.pageIndex, page_id: h.surface_id, seq: Number.MAX_SAFE_INTEGER, live: true, unsaved: true });
    }
  }
  return rows.sort((a, b) => b.seq - a.seq); // 新→旧：未落库的最新在最上
}

function hmpShots(hmp: HMP): string {
  const shot = (data: string | undefined, cap: string): string => data
    ? `<div class="hmp-shot"><img class="cns-zoom" src="${data}" alt="${esc(cap)}"><span>${esc(cap)}</span></div>` : '';
  const crop = shot(hmp.crop_ref, 'composite 叠原文');
  const ink = shot(hmp.vector_ref, '笔迹 ink');
  return (crop || ink)
    ? `<div class="hmp-shots">${crop}${ink}</div>`
    : `<div class="hmp-noshot">无取证图<br>（历史标注落库已剥图）</div>`;
}

/** 一笔的短 chip 标签（对象段「被命中」用）。 */
function markChipLabel(feature: string, marked: string): string {
  const t = (marked || '').replace(/\s+/g, ' ').slice(0, 10);
  return `${HMP_FEAT[feature] ?? feature}${t ? `「${t}」` : ''}`;
}

/** 命中对象行：当前页→每 ref 渲成可跳 cap-link（解析回原文，dangling 标红）；非当前页只显条数（不误报"缺"）。 */
function hmpTargetRow(row: HmpRow, objMap: Map<string, SurfaceObject> | null): string {
  const refs = row.hmp.target_object_refs;
  if (!refs.length) return `<div class="cns-kv"><span class="k">命中对象：</span><span class="hmp-xpage">空（未命中 / 自身内容）</span></div>`;
  if (objMap) {
    const parts = refs.map((id) => {
      const o = objMap.get(id);
      return o
        ? `<span class="cap-link" data-ref="${esc(id)}" title="跳到对象表这一行">${esc(id)}「${esc((o.text || '·' + o.type).slice(0, 24))}」</span>`
        : `${esc(id)}<span class="hmp-miss">(缺)</span>`;
    });
    return `<div class="cns-kv"><span class="k">命中对象（${refs.length}）：</span>${parts.join('　')}</div>`;
  }
  return `<div class="cns-kv"><span class="k">命中对象：</span><span class="hmp-xpage">${refs.length} 个（在第 ${row.page_index + 1} 页，切到该页可解析回原文 + 互跳）</span></div>`;
}

function hmpCard(row: HmpRow, objMap: Map<string, SurfaceObject> | null): string {
  const h = row.hmp;
  const mode = HMP_MODE[h.mode] ?? { t: h.mode, c: '#8a877f' };
  const region = `[${h.target_region.map((n) => n.toFixed(3)).join(', ')}]`;
  return `<div class="hmp-card" data-mark="${esc(row.key)}">`
    + `<div class="hmp-chead">`
    + `<span class="hmp-mode" style="background:${mode.c}">${esc(mode.t)}</span>`
    + `<span class="hmp-act">${esc(HMP_ACTION[h.action] ?? h.action)}</span>`
    + `<span class="hmp-feat">${esc(HMP_FEAT[row.feature] ?? row.feature)}</span>`
    + (row.unsaved ? `<span class="hmp-live">本次会话·未落库</span>` : row.live ? `<span class="hmp-live">本次会话</span>` : '')
    + `<span class="hmp-cmeta">${esc(HMP_HINT[h.object_hint] ?? h.object_hint)} · 信心 ${h.confidence.toFixed(2)} · v${esc(h.version)} · 第 ${row.page_index + 1} 页</span>`
    + `</div>`
    + `<div class="hmp-body">${hmpShots(h)}<div class="hmp-fields">`
    + `<div class="cns-kv"><span class="k">所标内容：</span>${esc(row.marked || '（未提取到文字）')}</div>`
    + hmpTargetRow(row, objMap)
    + `<div class="cns-kv"><span class="k">读出 text_hint：</span>${esc(h.text_hint || '—')}</div>`
    + `<div class="cns-kv"><span class="k">区域 region：</span>${region}</div>`
    + `</div></div></div>`;
}

/** SurfaceIndex 对象段：本页对象表（step① 源头）+ 每行「被命中」的笔 chip（可跳 HMP 卡）。 */
function renderObjTable(objMarks: Map<string, Array<{ id: string; label: string }>>): string {
  const si = state.surfaceIndex;
  if (!si || !si.objects.length) return `<p class="cns-empty">本页无 SurfaceIndex 对象。<br>打开一本 PDF、翻到某页——这里显示该页被解析出的对象表（HMP 的 refs 就指向它们）。</p>`;
  const CAP = 150;
  const shown = si.objects.slice(0, CAP);
  const dist: Record<string, number> = {};
  for (const o of si.objects) dist[o.type] = (dist[o.type] ?? 0) + 1;
  const distStr = Object.entries(dist).map(([k, n]) => `${k} ${n}`).join(' · ');
  const body = shown.map((o) => {
    const hits = objMarks.get(o.id) ?? [];
    const chips = hits.length
      ? hits.map((h) => `<span class="cap-markchip" data-mark="${esc(h.id)}" title="跳到 HMP 这张卡">${esc(h.label)}</span>`).join('')
      : '<span class="cap-dim">—</span>';
    return `<tr data-objid="${esc(o.id)}"><td class="cap-mono">${esc(o.id)}</td><td>${esc(o.type)}</td><td>${esc(o.role || '—')}</td><td class="cap-mono">${o.bbox.map((n) => n.toFixed(3)).join(',')}</td><td>${esc((o.text || '').slice(0, 40) || '—')}</td><td>${esc(o.source)}</td><td>${chips}</td></tr>`;
  }).join('');
  return `<p class="hmp-note">本页 SurfaceIndex 对象表（step①：页被解析成什么）——HMP 的 target_object_refs 指向这些 id。surface=${esc(si.surface_type)} · 共 ${si.objects.length} 个 · ${esc(distStr)}${si.objects.length > CAP ? ` · 仅显前 ${CAP}` : ''}。「被命中」可点回 HMP 卡。</p>`
    + `<table class="cap-tbl"><thead><tr><th>id</th><th>type</th><th>role</th><th>bbox</th><th>text</th><th>src</th><th>被命中</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** 渲染两段内容（HMP 取证 + 对象表），并备好 ref↔对象 互跳所需的映射。 */
async function renderCaptureContent(): Promise<void> {
  const hmpInner = document.getElementById('hmp-inner');
  const objInner = document.getElementById('obj-inner');
  if (!hmpInner || !objInner) return;
  if (!selectedBook) {
    hmpInner.innerHTML = `<p class="cns-empty">还没有书籍。导入一本 PDF、圈/划/写一处，取证记录会出现在这里。</p>`;
    objInner.innerHTML = renderObjTable(new Map());
    return;
  }
  const rows = await buildHmpRows(selectedBook);
  const si = state.surfaceIndex; // 仅当前页对象表 → 只有当前页的 mark 能解析回原文/互跳
  const objMap = si ? new Map(si.objects.map((o) => [o.id, o])) : null;
  // 对象→命中它的笔（仅当前页：对象 id 是页内的）。从已合并的 rows 派生，含未落库的本会话笔。
  const objMarks = new Map<string, Array<{ id: string; label: string }>>();
  if (si) for (const r of rows) {
    if (r.page_id !== si.surface_id) continue;
    for (const ref of r.hmp.target_object_refs) {
      const arr = objMarks.get(ref) ?? [];
      arr.push({ id: r.key, label: markChipLabel(r.feature, r.marked) });
      objMarks.set(ref, arr);
    }
  }
  hmpInner.innerHTML = rows.length
    ? `<p class="hmp-note">逐笔 HMP 取证——命中了哪个对象、读出/转写了什么、归到哪种 mode、取证图截对没。点蓝色「命中对象」可跳到对象表对照。共 ${rows.length} 笔，新→旧。</p>`
      + rows.map((r) => hmpCard(r, (objMap && si && r.page_id === si.surface_id) ? objMap : null)).join('')
    : `<p class="cns-empty">这本书还没有标注取证记录。<br>圈/划/写一处、停笔，每一笔的 HMP（命中了什么 / 读出什么 / 取证图）会在这里出现。</p>`;
  objInner.innerHTML = renderObjTable(objMarks);
}

/** 切段（HMP 取证 ↔ SurfaceIndex 对象）。 */
function setSeg(seg: 'hmp' | 'objects'): void {
  captureSeg = seg;
  document.getElementById('cap-wrap')?.setAttribute('data-seg', seg);
  document.querySelectorAll<HTMLButtonElement>('#cap-seg .cap-segbtn').forEach((b) => b.classList.toggle('active', b.dataset.seg === seg));
}

/** 滚到目标元素并闪一下高亮（互跳定位）。 */
function flashTarget(sel: string): void {
  const el = document.querySelector(sel) as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('cap-flash'); void el.offsetWidth; el.classList.add('cap-flash');
  window.setTimeout(() => el.classList.remove('cap-flash'), 1500);
}

function renderCapture(c: HTMLDivElement): void {
  if (!selectedBook) selectedBook = state.documentId ?? null;
  c.innerHTML =
    `<div class="cns-head"><h2>🔬 采集取证</h2>`
    + `<div id="cap-seg"><button class="cap-segbtn" data-seg="hmp">HMP 取证</button><button class="cap-segbtn" data-seg="objects">SurfaceIndex 对象</button></div>`
    + `<div class="cns-head-ctl"><select id="cap-book-sel"></select><button class="cns-btn" id="cap-refresh">⟳ 刷新</button></div></div>`
    + `<div class="cns-thread"><div id="cap-wrap" data-seg="${captureSeg}">`
    + `<div class="cap-pane cap-hmp"><div class="hmp-inner" id="hmp-inner"></div></div>`
    + `<div class="cap-pane cap-obj"><div class="obj-inner" id="obj-inner"></div></div>`
    + `</div></div>`;
  const sel = c.querySelector<HTMLSelectElement>('#cap-book-sel');
  sel?.addEventListener('change', () => { selectedBook = sel.value; void renderCaptureContent(); });
  c.querySelector('#cap-refresh')?.addEventListener('click', () => { void fillBookSelect('cap-book-sel').then(() => renderCaptureContent()); });
  c.querySelectorAll<HTMLButtonElement>('#cap-seg .cap-segbtn').forEach((b) => b.addEventListener('click', () => setSeg(b.dataset.seg as 'hmp' | 'objects')));
  setSeg(captureSeg);
  void fillBookSelect('cap-book-sel').then(() => renderCaptureContent());
}

/* ── 路由 / 初始化 ───────────────────────────────────────────────────────── */

function syncFromHash(): void {
  const id = location.hash.replace(/^#/, '') as PageId;
  const def = PAGES.find((p) => p.id === id);
  if (def && def.ready && id !== 'reader') showPage(id); // #chat / #hmp 等已实现页
  else showPage('reader'); // 含 #dev：让 dev 模块接管覆盖，本壳回到阅读底
}

export function initNavShell(): void {
  buildShell();

  try { if (localStorage.getItem('inkloop.rail.collapsed') === '1') document.body.classList.add('rail-collapsed'); } catch { /* ignore */ }

  // 流水线/取证缩略图 → 点开放大（事件委托，重渲后仍生效）
  document.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement;
    if (!tgt?.classList?.contains('cns-zoom')) return;
    const lb = document.getElementById('cns-lightbox');
    const img = lb?.querySelector('img');
    if (lb && img) { img.setAttribute('src', (tgt as HTMLImageElement).src); lb.classList.add('show'); }
  });

  // 采集取证页互跳：HMP 命中对象 ref ↔ 对象表行（对象 id 页内唯一，互跳只对当前页成立）
  document.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement;
    const refEl = tgt?.closest?.('.cap-link') as HTMLElement | null;
    if (refEl?.dataset.ref) { setSeg('objects'); flashTarget(`#obj-inner tr[data-objid="${CSS.escape(refEl.dataset.ref)}"]`); return; }
    const markEl = tgt?.closest?.('.cap-markchip') as HTMLElement | null;
    if (markEl?.dataset.mark) { setSeg('hmp'); flashTarget(`#hmp-inner .hmp-card[data-mark="${CSS.escape(markEl.dataset.mark)}"]`); }
  });

  // 键 m：折叠/展开侧栏（输入框内不触发）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'm' && !(e.target as HTMLElement)?.isContentEditable
      && !['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName ?? '')) {
      setCollapsed(!document.body.classList.contains('rail-collapsed'));
    }
  });

  // 账本新落一轮（aiturn:appended 在 appendAiTurnEntry 之后发，保证读到最新）/ 新推理 → 会话页开着就刷新
  const live = () => { if (activePage === 'chat') void renderConversation(); };
  bus.on('aiturn:appended', live);
  bus.on('inspect', live);
  // 新 HMP 取证 / 翻页换页对象表 → 采集取证页开着就刷新两段（surface:indexed 让命中解析/互跳在切到该页后补上）
  const liveHmp = () => { if (activePage === 'hmp') void renderCaptureContent(); };
  bus.on('hmp:updated', liveHmp);
  bus.on('surface:indexed', liveHmp);
  // 切书后默认跟随当前书
  bus.on('document:loaded', () => {
    selectedBook = state.documentId ?? selectedBook;
    if (activePage === 'chat') { void fillBookSelect(); void renderConversation(); }
    if (activePage === 'hmp') { void fillBookSelect('cap-book-sel').then(() => renderCaptureContent()); }
  });

  window.addEventListener('hashchange', syncFromHash);
  syncFromHash();
}
