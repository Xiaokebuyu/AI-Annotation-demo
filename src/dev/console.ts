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
 *   · 设置：迁出旧 dev 抽屉的全部设置控件 + 「诊断」段（坐标自测/延迟指标/预处理进度/trace 导出）；
 *     按代码审计**诚实标注每项可用性**（生效/调试叠层/弱效/失效）。【已实现】
 *
 * 旧 `#dev` 抽屉已整体退役（dev-drawer.ts 删除、index.html 标记移除）；dev-overlay（画布叠层）独立保留，
 * 由设置页的 devOverlay/showRegion/showRelations 控。
 *
 * 非「阅读」的页面渲染进 #app-pages（覆盖正文区、不挡侧栏）。侧栏可折叠（键 m / 折叠钮），折叠时正文占满。
 */
import { bus, state, settings, saveSettings, type Placement } from '../app/state';
import { resetBook } from '../chat/buffer';
import { listBooks, getBookAiTurns, getFoldedMarks, createWorkspace, listWorkspaces, getWorkspace, upsertFeishuWorkspace, createMeeting, listMeetings, listAllMeetings, getMeeting, updateMeeting, startSimMeeting } from '../local/store';
import { reopenBook, renderBlankSurface } from '../surface/renderer';
import type { MeetingStatus, PersistedAiTurn, PersistedDoc, PersistedMark, PersistedMeeting } from '../core/store-format';
import type { HMP, PipelineStage, PipelineStageIO, SurfaceObject } from '../core/contracts';
import { downloadTrace, traceCount } from '../core/trace';
import { snapshot } from '../core/metrics';
import { selfTest } from '../core/transform';

const esc = (s: string): string => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));

type PageId = 'reader' | 'meeting' | 'chat' | 'hmp' | 'settings';
const PAGES: Array<{ id: PageId; icon: string; label: string; ready: boolean }> = [
  { id: 'reader', icon: '📖', label: '阅读', ready: true },
  { id: 'meeting', icon: '🗓', label: '会议', ready: true }, // 群聊工作区 → 会议日程 + 资料书架（阶段一脚手架）
  { id: 'chat', icon: '💬', label: 'AI 会话', ready: true }, // 含逐组件处理流水线，已取代旧「上下文监控」
  { id: 'hmp', icon: '🔬', label: '采集取证', ready: true }, // 合并 HMP 取证 + SurfaceIndex 对象，深度联动
  { id: 'settings', icon: '⚙', label: '设置', ready: true }, // 全部设置 + 逐项可用性标注
];
// 导航布局：顶层目的地（阅读 / 会议）+ 折叠的 dev 抽屉（AI会话 / 采集取证 / 设置 收进去）
const TOP_NAV: PageId[] = ['reader', 'meeting'];
const DEV_NAV: PageId[] = ['chat', 'hmp', 'settings'];
const pageDef = (id: PageId): { id: PageId; icon: string; label: string; ready: boolean } => PAGES.find((p) => p.id === id)!;

/* 线性图标（inline SVG·stroke 跟随 currentColor）——替代 emoji，统一线性风格。 */
const ICON_PATHS: Record<string, string> = {
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v6h6"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
};
const NAV_ICON: Record<PageId, string> = { reader: 'book', meeting: 'calendar', chat: 'message', hmp: 'scan', settings: 'settings' };
function icon(name: string, cls = ''): string {
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ''}</svg>`;
}

let activePage: PageId = 'reader';
let selectedBook: string | null = null;

const fmtTime = (iso: string): string => {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return iso; }
};
const fmtDate = (iso: string): string => {
  try { return new Date(iso).toLocaleDateString('zh-CN'); } catch { return iso; }
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

  /* 按页分组折叠：最新页默认展开、旧页收起成一行摘要（body 懒渲染，DOM 变轻） */
  .grp { border: 1px solid var(--line); border-radius: 12px; margin: 0 0 12px; background: var(--page); overflow: hidden; }
  .grp > summary.grp-sum { cursor: pointer; padding: 11px 14px; list-style: none; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .grp > summary.grp-sum::-webkit-details-marker { display: none; }
  .grp > summary.grp-sum::before { content: '▸'; color: var(--hint); flex-shrink: 0; }
  .grp[open] > summary.grp-sum::before { content: '▾'; }
  .grp[open] > summary.grp-sum { border-bottom: 1px solid var(--line); background: var(--hl); }
  .grp-pg { font-weight: 700; font-size: 13.5px; flex-shrink: 0; }
  .grp-count { font-size: 11px; color: var(--mut); background: var(--hl); border-radius: 20px; padding: 1px 8px; flex-shrink: 0; }
  .grp[open] .grp-count { background: var(--page); }
  .grp-time { font-size: 11px; color: var(--hint); flex-shrink: 0; }
  .grp-prev { font-size: 12px; color: var(--hint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  .grp[open] .grp-prev { display: none; }
  .grp-body { padding: 13px 14px 2px; }

  /* 设置页：分组 + 逐项可用性徽标 */
  .cset-wrap { max-width: 740px; margin: 0 auto; padding: 6px 24px 48px; }
  .cset-sec { margin-top: 24px; }
  .cset-sec-h { font-size: 12px; font-weight: 700; color: var(--mut); letter-spacing: .04em; margin: 0 0 5px; }
  .cset-sec-note { font-size: 11.5px; color: var(--hint); margin: 0 0 8px; line-height: 1.5; }
  .cset-row { display: flex; align-items: flex-start; gap: 14px; padding: 11px 2px; border-bottom: 1px solid var(--line); }
  .cset-text { flex: 1; min-width: 0; }
  .cset-l { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cset-label { font-size: 13px; color: var(--ink); }
  .cset-hint { font-size: 11px; color: var(--hint); margin-top: 3px; line-height: 1.5; }
  .cset-control { flex-shrink: 0; display: flex; align-items: center; gap: 5px; padding-top: 1px; }
  .cset-control select, .cset-control input[type="number"] { font: 12.5px var(--sans); padding: 5px 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--page); color: var(--ink); }
  .cset-control input[type="number"] { width: 62px; text-align: right; }
  .cset-control input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
  .cset-unit { font-size: 11px; color: var(--hint); }
  .set-badge { font-size: 10px; font-weight: 600; padding: 1px 7px; border-radius: 20px; white-space: nowrap; }
  .set-badge.live { background: #dcf2e6; color: #1f6b46; }
  .set-badge.dev { background: #e4ecf7; color: #355a86; }
  .set-badge.weak { background: #f8eecf; color: #836315; }
  .set-badge.dead { background: var(--hl); color: var(--hint); }
  details.cset-fold > summary { cursor: pointer; font-size: 12px; font-weight: 700; color: var(--mut); letter-spacing: .04em; padding: 4px 2px; list-style: none; }
  details.cset-fold > summary::-webkit-details-marker { display: none; }
  details.cset-fold > summary::before { content: '▸ '; color: var(--hint); }
  details.cset-fold[open] > summary::before { content: '▾ '; }
  .cset-actions { margin-top: 24px; }
  .cset-danger { color: var(--bad); border-color: var(--bad); }

  /* 线性图标（inline SVG，stroke=currentColor）*/
  .ico { width: 16px; height: 16px; flex-shrink: 0; display: inline-block; vertical-align: -3px; }
  .rail-item .rail-ico { display: flex; align-items: center; justify-content: center; }
  .rail-item .rail-ico .ico { width: 17px; height: 17px; vertical-align: 0; opacity: .9; }
  .rail-item.active .rail-ico .ico { opacity: 1; }
  .cns-head h2 { display: inline-flex; align-items: center; gap: 8px; }
  .cns-head h2 .ico { width: 17px; height: 17px; color: var(--mut); }

  /* dev 抽屉（折叠组）：AI会话 / 采集取证 / 设置 收进去 */
  .rail-group .rail-caret { margin-left: auto; display: flex; align-items: center; color: var(--hint); transition: transform .16s ease; }
  .rail-group .rail-caret .ico { width: 14px; height: 14px; vertical-align: 0; }
  .rail-group.open .rail-caret { transform: rotate(90deg); }
  .rail-sub { display: none; margin: 1px 0 1px 9px; padding-left: 8px; border-left: 1px solid var(--line); }
  .rail-sub.open { display: block; }
  .rail-sub-item { font-size: 12.5px; padding: 7px 10px; }

  /* 会议页：纯白风格（ChatGPT / 飞书）——独立于暖色纸感主题 */
  #app-pages .mtg-page { flex: 1; min-height: 0; background: #fff; color: #0d0d0d; display: flex; flex-direction: column; font-family: var(--sans); }
  .mtg-top { display: flex; align-items: center; gap: 10px; padding: 15px 28px; border-bottom: 1px solid #ededed; flex-shrink: 0; }
  .mtg-title { margin: 0; font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 9px; white-space: nowrap; }
  .mtg-title .ico { width: 18px; height: 18px; color: #5b5b66; }
  .mtg-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .mtg-ghost { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; flex-shrink: 0; font: 13px var(--sans); color: #5b5b66; background: #fff; border: 1px solid #e6e6e6; border-radius: 8px; padding: 6px 11px; cursor: pointer; }
  .mtg-ghost:hover { background: #f7f7f8; }
  .mtg-ghost.primary { color: #fff; background: #0d0d0d; border-color: #0d0d0d; }
  .mtg-ghost.primary:hover { background: #2a2a2a; }
  .mtg-ghost[disabled] { opacity: .45; cursor: not-allowed; }
  .mtg-ghost .ico { width: 14px; height: 14px; }
  .mtg-back { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: 1px solid #e6e6e6; border-radius: 8px; background: #fff; color: #5b5b66; cursor: pointer; flex-shrink: 0; }
  .mtg-back:hover { background: #f7f7f8; }
  .mtg-back .ico { width: 16px; height: 16px; }
  .mtg-title { min-width: 0; }
  .mtg-scroll { flex: 1; min-height: 0; overflow-y: auto; background: #fff; }
  .mtg-wrap { max-width: 880px; margin: 0 auto; padding: 26px 28px 60px; }
  .mtg-note { font-size: 12.5px; color: #8e8ea0; line-height: 1.7; margin: 0 0 28px; }
  .mtg-note b { color: #5b5b66; font-weight: 600; }
  .mtg-sec { margin-bottom: 34px; }
  .mtg-sec-h { font-size: 13px; font-weight: 600; color: #0d0d0d; margin: 0 0 13px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; white-space: nowrap; }
  .mtg-sec-h .ico { width: 16px; height: 16px; color: #9a9aa6; }
  .mtg-soon { font-size: 11px; font-weight: 400; color: #9a9aa6; background: #f5f5f6; border-radius: 6px; padding: 2px 9px; margin-left: 2px; }
  .mtg-sched { border: 1px dashed #e4e4e7; border-radius: 14px; background: #fcfcfd; }
  .mtg-empty { color: #9a9aa6; font-size: 13px; text-align: center; line-height: 1.75; padding: 38px 18px; }
  .mtg-shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .mtg-mat { display: flex; align-items: center; gap: 12px; text-align: left; padding: 14px 15px; border: 1px solid #ececec; border-radius: 14px; background: #fff; color: #0d0d0d; cursor: pointer; font-family: var(--sans); transition: border-color .12s ease, box-shadow .12s ease; }
  .mtg-mat:hover { border-color: #d7d7dc; box-shadow: 0 2px 12px rgba(0,0,0,.05); }
  a.mtg-mat { text-decoration: none; color: #0d0d0d; }
  .mtg-mat .ico { width: 19px; height: 19px; color: #8e8ea0; }
  .mtg-mat-body { display: flex; flex-direction: column; min-width: 0; }
  .mtg-mat-name { font-size: 13.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mtg-mat-meta { font-size: 11.5px; color: #9a9aa6; margin-top: 2px; }
  /* 会议行（日程 / 工作区会议列表）：主体=进入会议，尾部小钮=详情 */
  .mtg-mrow { display: flex; align-items: stretch; border: 1px solid #ececec; border-radius: 12px; background: #fff; margin-bottom: 8px; overflow: hidden; transition: border-color .12s ease, box-shadow .12s ease; }
  .mtg-mrow:hover { border-color: #d7d7dc; box-shadow: 0 2px 12px rgba(0,0,0,.05); }
  .mtg-mrow-hit { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; text-align: left; padding: 12px 14px; background: none; border: none; color: #0d0d0d; cursor: pointer; font-family: var(--sans); }
  .mtg-mrow-detail { flex-shrink: 0; width: 44px; border: none; border-left: 1px solid #f2f2f4; background: none; color: #c4c4cc; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .mtg-mrow-detail:hover { background: #f7f7f8; color: #8e8ea0; }
  .mtg-mrow-detail .ico { width: 16px; height: 16px; }
  .mtg-st { font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 20px; white-space: nowrap; flex-shrink: 0; }
  .mtg-mrow-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .mtg-mrow-title { font-size: 13.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mtg-mrow-sub { font-size: 11.5px; color: #9a9aa6; margin-top: 2px; }
  .mtg-mrow-sub .ico { width: 12px; height: 12px; color: #b3b3bd; vertical-align: -2px; }
  .mtg-chev { color: #c4c4cc; flex-shrink: 0; display: flex; }
  .mtg-chev .ico { width: 16px; height: 16px; }
  /* 群聊卡片网格 */
  .mtg-ws-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .mtg-ws { display: flex; align-items: center; gap: 12px; text-align: left; padding: 14px 15px; border: 1px solid #ececec; border-radius: 14px; background: #fff; color: #0d0d0d; cursor: pointer; font-family: var(--sans); transition: border-color .12s ease, box-shadow .12s ease; }
  .mtg-ws:hover { border-color: #d7d7dc; box-shadow: 0 2px 12px rgba(0,0,0,.05); }
  .mtg-ws .ico { width: 20px; height: 20px; color: #8e8ea0; flex-shrink: 0; }
  /* 思路总结 */
  .mtg-summary { font-size: 13px; line-height: 1.7; color: #2a2a32; background: #fcfcfd; border: 1px solid #ececec; border-radius: 14px; padding: 16px 18px; white-space: pre-wrap; }
  /* 飞书来源徽标 + 参会人 */
  .mtg-fs-badge { font-size: 10px; font-weight: 500; color: #2563a8; background: #e8f1fb; border-radius: 5px; padding: 1px 6px; margin-left: 7px; vertical-align: 1px; }
  .mtg-member-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .mtg-member { font-size: 12.5px; color: #2a2a32; background: #f5f5f6; border: 1px solid #ececec; border-radius: 20px; padding: 4px 12px; }
  /* 群动态（飞书群消息）*/
  .mtg-feed { border: 1px solid #ececec; border-radius: 14px; overflow: hidden; }
  .mtg-feed-item { display: flex; align-items: baseline; gap: 10px; padding: 9px 14px; border-bottom: 1px solid #f2f2f4; font-size: 12.5px; }
  .mtg-feed-item:last-child { border-bottom: 0; }
  .mtg-feed-item.asset { background: #fcfbf7; }
  .mtg-feed-who { color: #5b5b66; font-weight: 600; flex-shrink: 0; min-width: 60px; }
  .mtg-feed-text { color: #2a2a32; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mtg-feed-tag { font-size: 10px; color: #9a6b00; background: #fdf3df; border-radius: 5px; padding: 1px 6px; flex-shrink: 0; }
  .mtg-feed-time { color: #b3b3bd; font-size: 11px; flex-shrink: 0; }
  /* 飞书日历日程：只读行（不可点）+ 已连接徽标 */
  .mtg-mrow.mtg-mrow-static { cursor: default; }
  .mtg-mrow.mtg-mrow-static:hover { border-color: #ececec; box-shadow: none; }
  .mtg-fs-ok { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #2563a8; background: #e8f1fb; border: 1px solid #d6e6fa; border-radius: 8px; padding: 5px 11px; white-space: nowrap; }
  .mtg-fs-ok .ico { width: 14px; height: 14px; }
  /* 会议日程 横向时间线 */
  .mtl { position: relative; padding: 4px 2px 2px; }
  .mtl-line { position: absolute; left: 10px; right: 10px; top: 102px; height: 2px; background: #ececec; z-index: 0; }
  .mtl-cols { position: relative; display: flex; z-index: 1; }
  .mtl-col { flex: 1; display: grid; grid-template-rows: 92px 22px 92px; min-width: 0; }
  .mtl-up { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; }
  .mtl-dn { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; }
  .mtl-mid { display: flex; align-items: center; justify-content: center; }
  .mtl-card { width: 112px; box-sizing: border-box; background: #fff; border: 1px solid #ececec; border-radius: 10px; padding: 7px 9px; text-align: left; }
  .mtl-conn { width: 1px; height: 12px; background: #dcdce0; }
  .mtl-dot { width: 13px; height: 13px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #ececec; z-index: 2; }
  .mtl-dt { font-size: 11px; color: #9a9aa6; white-space: nowrap; }
  .mtl-tm { font-size: 15px; font-weight: 600; color: #0d0d0d; line-height: 1.15; margin-top: 1px; }
  .mtl-ti { font-size: 12px; color: #2a2a32; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mtl-bd { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 5px; margin-top: 5px; }
  .mtl-bd.rec { background: #e8f1fb; color: #2563a8; }
  .mtl-bd.one { background: #f5f5f6; color: #5b5b66; }
  .mtl-origin { font-size: 11px; color: #9a9aa6; text-align: center; line-height: 1.4; margin-top: 5px; white-space: nowrap; }
  .mtl-more { text-align: right; font-size: 11.5px; color: #9a9aa6; padding: 6px 6px 0; }
  .mtl-local { margin-top: 16px; }
  /* 会中浮层：常驻退出钮 + 右侧半掩资料栏（hover 展开）*/
  .mtg-exit { position: fixed; top: 13px; right: 18px; z-index: 60; display: inline-flex; align-items: center; gap: 6px; font: 13px var(--sans); color: #5b5b66; background: #fff; border: 1px solid #e6e6e6; border-radius: 8px; padding: 6px 12px; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.07); }
  .mtg-exit:hover { background: #f7f7f8; }
  .mtg-exit .ico { width: 15px; height: 15px; }
  .mtg-side { position: fixed; top: 54px; right: 0; bottom: 0; width: 224px; z-index: 50; background: #fff; border-left: 1px solid #ececec; box-shadow: -8px 0 22px rgba(0,0,0,.06); display: flex; flex-direction: column; font-family: var(--sans); transform: translateX(160px); transition: transform .18s ease; }
  .mtg-side:hover, .mtg-side:focus-within { transform: translateX(0); }
  .mtg-side-h { font-size: 12px; font-weight: 600; color: #0d0d0d; padding: 12px 14px; border-bottom: 1px solid #f2f2f4; display: flex; align-items: center; gap: 7px; white-space: nowrap; }
  .mtg-side-h .ico { width: 15px; height: 15px; color: #8e8ea0; }
  .mtg-side-body { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .mtg-side-empty { color: #9a9aa6; font-size: 12px; padding: 10px; }
  .mtg-side-card { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border: 1px solid #ececec; border-radius: 10px; text-decoration: none; color: #0d0d0d; background: #fff; }
  .mtg-side-card:hover { border-color: #d7d7dc; box-shadow: 0 2px 10px rgba(0,0,0,.05); }
  .mtg-side-thumb .ico { width: 18px; height: 18px; color: #8e8ea0; }
  .mtg-side-main { display: flex; flex-direction: column; min-width: 0; }
  .mtg-side-name { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mtg-side-time { font-size: 11px; color: #b3b3bd; margin-top: 1px; }
  `;
  document.head.appendChild(s);
}

function buildShell(): void {
  if (document.getElementById('app-rail')) return;
  injectStyle();

  const railItem = (id: PageId, sub = false): string =>
    `<button class="rail-item${sub ? ' rail-sub-item' : ''}" data-page="${id}"><span class="rail-ico">${icon(NAV_ICON[id])}</span><span>${esc(pageDef(id).label)}</span></button>`;
  const rail = document.createElement('nav');
  rail.id = 'app-rail';
  rail.innerHTML =
    `<div class="rail-head"><span class="rail-brand">◐ InkLoop</span><button class="rail-iconbtn" id="rail-collapse" title="收起侧栏（m）">«</button></div>`
    + TOP_NAV.map((id) => railItem(id)).join('')
    + `<button class="rail-item rail-group" id="rail-dev-toggle" title="开发 / 调试页"><span class="rail-ico">${icon('sliders')}</span><span>dev</span><span class="rail-caret">${icon('chevron')}</span></button>`
    + `<div class="rail-sub" id="rail-dev-sub">` + DEV_NAV.map((id) => railItem(id, true)).join('') + `</div>`
    + `<div class="rail-spacer"></div>`;
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
  rail.querySelector('#rail-dev-toggle')!.addEventListener('click', () => setDevExpanded(!railDevOpen()));
  rail.querySelector('#rail-collapse')!.addEventListener('click', () => setCollapsed(true));
  reopen.addEventListener('click', () => setCollapsed(false));
}

function setCollapsed(c: boolean): void {
  document.body.classList.toggle('rail-collapsed', c);
  try { localStorage.setItem('inkloop.rail.collapsed', c ? '1' : '0'); } catch { /* ignore */ }
}

const railDevOpen = (): boolean => !!document.getElementById('rail-dev-sub')?.classList.contains('open');
/** 展开/收起 dev 抽屉（AI会话 / 采集取证 / 设置）。 */
function setDevExpanded(open: boolean): void {
  document.getElementById('rail-dev-sub')?.classList.toggle('open', open);
  document.getElementById('rail-dev-toggle')?.classList.toggle('open', open);
  try { localStorage.setItem('inkloop.rail.dev', open ? '1' : '0'); } catch { /* ignore */ }
}

function highlight(): void {
  document.querySelectorAll<HTMLButtonElement>('#app-rail .rail-item[data-page]')
    .forEach((b) => b.classList.toggle('active', b.dataset.page === activePage));
}

/** 导航到某页（reader 收起页面层；其余渲染进 #app-pages）。所有页均已实现，无"迁移中"跳转。 */
function go(id: PageId): void {
  if (id === 'reader') {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    showPage('reader');
  } else {
    if (location.hash !== '#' + id) location.hash = id; else showPage(id);
  }
}

function showPage(id: PageId): void {
  activePage = id;
  highlight();
  syncMtgChrome(); // 会中浮层（资料栏/退出钮）只在阅读页+会中模式显示
  if (DEV_NAV.includes(id)) setDevExpanded(true); // 进 dev 子页时保持抽屉展开，露出高亮项
  const pages = document.getElementById('app-pages');
  if (!pages) return;
  if (id === 'reader') { pages.classList.remove('show'); return; }
  pages.classList.add('show');
  const content = document.getElementById('app-page-content') as HTMLDivElement | null;
  if (content) renderPage(id, content);
}

function renderPage(id: PageId, content: HTMLDivElement): void {
  if (id === 'meeting') { renderMeeting(content); return; }
  if (id === 'chat') { renderChat(content); return; }
  if (id === 'hmp') { renderCapture(content); return; }
  if (id === 'settings') { renderSettings(content); return; }
}

/* ── 会议页（群聊工作区 → 会议日程 + 资料书架；阶段一脚手架）─────────────────────────
 * 顶层实体 = 群聊/工作区，持有 [会议日程, 资料书架]；会议 = 群里的时间事件，开始后才长出
 * 录音 / 实时转写 / 对照阅读（后续逐步叠加）。本阶段先搭壳：
 *   · 日程区：占位（来源＝飞书日历，接线后置，先把结构摆出来）。
 *   · 书架区：复用 listBooks 列出已导入资料，点开经 reopenBook 借「阅读」页阅读标注
 *            （"书架点开借阅读器"最纯复用闭环）。按群聊归类待工作区 store 落地。 */
/* 会议页 = 三级视图机：home(日程聚合 + 群聊书架) → workspace(三状态会议) → meeting(文件/手写档案/思路总结)。
 * 子视图用模块内 mtgView 状态 + 重渲（不入 hash），切走再回保持原位；纯白风格、线性图标。 */
type MtgLevel = 'home' | 'workspace' | 'meeting';
let mtgView: { level: MtgLevel; wsId?: string; mtgId?: string } = { level: 'home' };

const MTG_STATUS: Record<MeetingStatus, { t: string; c: string; bg: string }> = {
  live: { t: '进行中', c: '#0a7c4a', bg: '#e3f5ec' },
  upcoming: { t: '待开始', c: '#9a6b00', bg: '#fdf3df' },
  ended: { t: '已结束', c: '#5b5b66', bg: '#f0f0f2' },
};

// 独立飞书后端（feishu-service）。dev 默认 localhost:4321；服务不在就静默退回纯本地。
const FEISHU_BASE = ((import.meta.env.VITE_FEISHU_BASE_URL as string | undefined) ?? 'http://localhost:4321').replace(/\/+$/, '');
async function feishuGet<T>(path: string): Promise<T> {
  const r = await fetch(FEISHU_BASE + path);
  if (!r.ok) throw new Error('feishu-service ' + r.status);
  return r.json() as Promise<T>;
}

interface FeishuMsg { message_id: string; msg_type: string; sender_id?: string; create_time?: string; text?: string; file_name?: string; file_key?: string; image_key?: string; }
const fmtMs = (ms?: string): string => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? fmtDateTime(new Date(n).toISOString()) : ''; };

// 飞书日历日程（user OAuth 拉到的「我本人」日程；后端已展开循环会成每次 occurrence，只读源）
interface FeishuEvent { event_id: string; summary?: string; start_time?: { timestamp?: string; date?: string }; event_organizer?: { display_name?: string }; recurring?: boolean }
/** 日程开始墙钟（ms）：优先 timestamp(秒)，全天日程用 date。 */
const fsEventWhen = (e: FeishuEvent): number => {
  const ts = e.start_time?.timestamp;
  if (ts) return Number(ts) * 1000;
  const d = e.start_time?.date;
  return d ? new Date(d.replace(/-/g, '/')).getTime() : 0;
};
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** 相对天 + 月/日 周几（今天/明天/后天高亮）。 */
function fsDayLabel(ms: number): string {
  const d = new Date(ms), t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const d0 = new Date(ms); d0.setHours(0, 0, 0, 0);
  const diff = Math.round((d0.getTime() - t0.getTime()) / 86400000);
  const rel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : '';
  const base = `${d.getMonth() + 1}/${d.getDate()} ${WD[d.getDay()]}`;
  return rel ? `${rel} · ${base}` : base;
}
const fsHHMM = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** 一列时间线节点（上/下交错；蓝=每周循环、灰=单次）。 */
function fsTlCol(e: FeishuEvent, above: boolean): string {
  const ms = fsEventWhen(e), rec = !!e.recurring;
  const card = `<div class="mtl-card"><div class="mtl-dt">${esc(fsDayLabel(ms))}</div>`
    + `<div class="mtl-tm">${esc(fsHHMM(ms))}</div>`
    + `<div class="mtl-ti" title="${esc(e.summary || '')}">${esc(e.summary || '(无标题日程)')}</div>`
    + `<span class="mtl-bd ${rec ? 'rec' : 'one'}">${rec ? '每周' : '单次'}</span></div>`;
  const dot = `<div class="mtl-mid"><div class="mtl-dot" style="background:${rec ? '#2563a8' : '#9a9aa6'}"></div></div>`;
  return above
    ? `<div class="mtl-col"><div class="mtl-up">${card}<div class="mtl-conn"></div></div>${dot}<div></div></div>`
    : `<div class="mtl-col"><div></div>${dot}<div class="mtl-dn"><div class="mtl-conn"></div>${card}</div></div>`;
}
/** 横向时间线（会议日程区；契合日程宽度，从「今天」起展示最近 max 场）。 */
function feishuTimeline(events: FeishuEvent[], max = 6): string {
  const items = events.slice(0, max);
  if (!items.length) return '';
  const today = fsDayLabel(Date.now()).split(' · ').pop() || '';
  const origin = `<div class="mtl-col"><div></div><div class="mtl-mid"><div class="mtl-dot" style="background:#0d0d0d"></div></div>`
    + `<div class="mtl-dn"><div class="mtl-conn"></div><div class="mtl-origin">今天<br>${esc(today)}</div></div></div>`;
  const cols = items.map((e, i) => fsTlCol(e, i % 2 === 0)).join('');
  const more = events.length > max ? `<div class="mtl-more">还有 ${events.length - max} 场</div>` : '';
  return `<div class="mtl"><div class="mtl-line"></div><div class="mtl-cols">${origin}${cols}</div>${more}</div>`;
}

/** 群消息 → 群动态 section（文件/图片标「资料」）。 */
function renderFeed(msgs: FeishuMsg[], nameOf: Map<string, string>): string {
  if (!msgs.length) return '';
  const assetN = msgs.filter((m) => m.msg_type === 'file' || m.msg_type === 'image').length;
  const rows = msgs.map((m) => {
    const who = m.sender_id ? (nameOf.get(m.sender_id) || (m.sender_id.startsWith('cli_') ? '机器人' : '成员')) : '系统';
    let body: string, asset = false;
    if (m.msg_type === 'text') body = m.text || '';
    else if (m.msg_type === 'image') { body = '［图片］'; asset = true; }
    else if (m.msg_type === 'file') { body = '［文件］' + (m.file_name || ''); asset = true; }
    else if (m.msg_type === 'interactive') body = '［卡片］';
    else if (m.msg_type === 'system') body = '［系统消息］';
    else body = `［${m.msg_type}］`;
    return `<div class="mtg-feed-item${asset ? ' asset' : ''}"><span class="mtg-feed-who">${esc(who)}</span>`
      + `<span class="mtg-feed-text">${esc(body)}</span>${asset ? '<span class="mtg-feed-tag">资料</span>' : ''}`
      + `<span class="mtg-feed-time">${esc(fmtMs(m.create_time))}</span></div>`;
  }).join('');
  return `<section class="mtg-sec"><div class="mtg-sec-h">${icon('message')} 群动态 <span class="mtg-soon">近 ${msgs.length} 条 · 飞书群消息${assetN ? ` · ${assetN} 资料` : ''}</span></div><div class="mtg-feed">${rows}</div></section>`;
}
const fmtDateTime = (iso: string): string => {
  try { return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return iso; }
};
/** 解析手输时间（"2026-06-25 14:30"，留空/非法=现在）。 */
function parseWhen(s: string): string {
  const t = s.trim();
  if (!t) return new Date().toISOString();
  const d = new Date(t.replace(/-/g, '/')); // Safari 友好
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

/** 重渲当前会议视图（动作后 / 切书后调）。 */
function rerenderMeeting(): void {
  if (activePage !== 'meeting') return;
  const content = document.getElementById('app-page-content') as HTMLDivElement | null;
  if (content) renderMeeting(content);
}
function mtgGoHome(): void { mtgView = { level: 'home' }; rerenderMeeting(); }
function mtgGoWorkspace(wsId: string): void { mtgView = { level: 'workspace', wsId }; rerenderMeeting(); }
function mtgGoMeeting(mtgId: string, wsId?: string): void { mtgView = { level: 'meeting', mtgId, wsId: wsId ?? mtgView.wsId }; rerenderMeeting(); }

/* ── 会中工作台：点会议=直达画板（方案A：进存档主阅读 / 退还原）+ 右侧半掩群资料栏 ──────────── */
let mtgMode: { meetingId: string; wsId: string; chatId?: string; title: string } | null = null;
let savedReaderDoc: { id: string; name: string } | null = null; // 进会议前主阅读在看的真书，退出还原

/** 进入会议 = 直达画板（不经详情页）。方案A：存下主阅读正看的真书；渲染会议空白手写页；挂右侧资料栏。 */
async function enterMeeting(mtgId: string): Promise<void> {
  const m = await getMeeting(mtgId);
  if (!m) return;
  const ws = await getWorkspace(m.workspace_id);
  // 方案A：只在当前是真书（PDF、非白板）时存档，退出 reopenBook 还原
  savedReaderDoc = (state.documentId && state.surfaceType === 'pdf' && !state.documentId.startsWith('mtgboard_'))
    ? { id: state.documentId, name: state.fileName } : null;
  if (m.status !== 'live' || !m.started_at) await updateMeeting(mtgId, { status: 'live', started_at: m.started_at ?? new Date().toISOString() }); // 时间脊原点
  mtgMode = { meetingId: mtgId, wsId: m.workspace_id, chatId: ws?.feishu_chat_id, title: m.title };
  go('reader');
  renderBlankSurface('mtgboard_' + mtgId, m.title);
  await mountMtgSide();
}

/** 退出会议：拆资料栏 + 还原主阅读（如有）+ 回到该群会议列表。 */
async function exitMeeting(): Promise<void> {
  const wsId = mtgMode?.wsId;
  mtgMode = null;
  document.getElementById('mtg-side')?.remove();
  document.getElementById('mtg-exit')?.remove();
  const saved = savedReaderDoc; savedReaderDoc = null;
  if (saved) await reopenBook(saved.id, saved.name); // 主阅读还原（留在阅读页）
  if (wsId) mtgView = { level: 'workspace', wsId };
  go('meeting');
}

/** 一张群资料预览卡（侧栏用，点开经 im:resource 下载查看）。 */
function mtgSideCard(f: FeishuMsg): string {
  const img = f.msg_type === 'image';
  const key = img ? f.image_key : f.file_key;
  const name = img ? '［图片］' : (f.file_name || '文件');
  const url = `${FEISHU_BASE}/api/feishu/messages/${encodeURIComponent(f.message_id)}/file/${encodeURIComponent(key || '')}?type=${img ? 'image' : 'file'}&name=${encodeURIComponent(name)}`;
  return `<a class="mtg-side-card" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(name)}">`
    + `<span class="mtg-side-thumb">${icon('file')}</span>`
    + `<span class="mtg-side-main"><span class="mtg-side-name">${esc(name)}</span><span class="mtg-side-time">${esc(fmtMs(f.create_time))}</span></span></a>`;
}

/** 挂会中右侧资料栏（半掩·hover 展开）+ 常驻「退出会议」。资料 = 从群筛出的近期文件。 */
async function mountMtgSide(): Promise<void> {
  document.getElementById('mtg-side')?.remove();
  document.getElementById('mtg-exit')?.remove();
  if (!mtgMode) return;
  const exit = document.createElement('button');
  exit.id = 'mtg-exit'; exit.className = 'mtg-exit'; exit.innerHTML = `${icon('back')} 退出会议`;
  exit.addEventListener('click', () => { void exitMeeting(); });
  document.body.appendChild(exit);
  const side = document.createElement('aside');
  side.id = 'mtg-side'; side.className = 'mtg-side';
  side.innerHTML = `<div class="mtg-side-h">${icon('file')} 可能有用的文件</div><div class="mtg-side-body" id="mtg-side-body"><p class="mtg-side-empty">加载中…</p></div>`;
  document.body.appendChild(side);
  const body = side.querySelector('#mtg-side-body') as HTMLElement;
  let files: FeishuMsg[] = [];
  if (mtgMode.chatId) {
    try {
      const res = await feishuGet<{ messages: FeishuMsg[] }>(`/api/feishu/workspaces/${mtgMode.chatId}/messages?limit=50`);
      files = (res.messages || []).filter((x) => (x.msg_type === 'file' && x.file_key) || (x.msg_type === 'image' && x.image_key));
    } catch { /* feishu-service 不在 → 空 */ }
  }
  body.innerHTML = files.length ? files.map(mtgSideCard).join('') : `<p class="mtg-side-empty">群里近期没有文件。</p>`;
}

/** 换页时联动会中浮层：只在阅读页 + 会中模式显示资料栏/退出钮。 */
function syncMtgChrome(): void {
  const on = activePage === 'reader' && !!mtgMode;
  const side = document.getElementById('mtg-side');
  const exit = document.getElementById('mtg-exit');
  if (side) side.style.display = on ? '' : 'none';
  if (exit) exit.style.display = on ? '' : 'none';
}

function mtgShell(title: string, actions: string, body: string): string {
  return `<div class="mtg-page"><header class="mtg-top">${title}<div class="mtg-actions">${actions}</div></header>`
    + `<div class="mtg-scroll"><div class="mtg-wrap">${body}</div></div></div>`;
}
/** 一条会议行（日程 / 工作区里复用）。主体点击=进入会议(直达画板)；尾部小钮=会议详情(单独入口)。 */
function meetingRow(m: PersistedMeeting, wsLabel?: string): string {
  const s = MTG_STATUS[m.status];
  const sub = `${icon('clock')} ${esc(fmtDateTime(m.scheduled_at))}` + (wsLabel ? ` · ${esc(wsLabel)}` : '');
  return `<div class="mtg-mrow">`
    + `<button class="mtg-mrow-hit" data-enter="${esc(m.meeting_id)}" title="进入会议（画板）">`
    + `<span class="mtg-st" style="color:${s.c};background:${s.bg}">${s.t}</span>`
    + `<span class="mtg-mrow-main"><span class="mtg-mrow-title">${esc(m.title)}</span><span class="mtg-mrow-sub">${sub}</span></span></button>`
    + `<button class="mtg-mrow-detail" data-detail="${esc(m.meeting_id)}" data-ws="${esc(m.workspace_id)}" title="会议详情 / 档案">${icon('file')}</button>`
    + `</div>`;
}
/** 一份资料卡（文件区 / 手写档案区复用）。 */
function materialCard(b: PersistedDoc, iconName: string, meta: string): string {
  return `<button class="mtg-mat" data-doc="${esc(b.document_id)}" data-name="${esc(b.filename)}" title="点开，借「阅读」页阅读标注">`
    + `${icon(iconName)}<span class="mtg-mat-body"><span class="mtg-mat-name">${esc(b.filename || '(未命名)')}</span>`
    + `<span class="mtg-mat-meta">${esc(meta)}</span></span></button>`;
}
/** 资料卡点击 → 借阅读器打开。 */
function wireMaterialCards(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('.mtg-mat[data-doc]').forEach((btn) => btn.addEventListener('click', () => {
    const doc = btn.dataset.doc;
    if (!doc) return;
    go('reader');
    void reopenBook(doc, btn.dataset.name || '');
  }));
}

/** 会议页入口：按 mtgView 分发到三级。 */
function renderMeeting(c: HTMLDivElement): void {
  if (mtgView.level === 'workspace' && mtgView.wsId) { void renderMtgWorkspace(c, mtgView.wsId); return; }
  if (mtgView.level === 'meeting' && mtgView.mtgId) { void renderMtgDetail(c, mtgView.mtgId); return; }
  void renderMtgHome(c);
}

/* ── 一级：会议日程聚合 + 群聊书架 ─────────────────────────────────────────── */
async function renderMtgHome(c: HTMLDivElement): Promise<void> {
  const title = `<h2 class="mtg-title">${icon('calendar')} 会议</h2>`;
  const actions = `<button class="mtg-ghost" id="mtg-refresh">${icon('refresh')} 刷新</button>`
    + `<button class="mtg-ghost" id="mtg-sim">${icon('play')} 模拟会议</button>`
    + `<button class="mtg-ghost primary" id="mtg-new-ws">${icon('plus')} 新建群聊</button>`;
  c.innerHTML = mtgShell(title, actions, `<div id="mtg-body"><p class="mtg-empty">加载中…</p></div>`);
  c.querySelector('#mtg-refresh')?.addEventListener('click', () => rerenderMeeting());
  c.querySelector('#mtg-sim')?.addEventListener('click', async () => {
    const m = await startSimMeeting();
    if (!m) { window.alert('先连一个飞书群（机器人所在群会自动同步成工作区）再开模拟会议。'); return; }
    mtgGoMeeting(m.meeting_id, m.workspace_id);
  });
  c.querySelector('#mtg-new-ws')?.addEventListener('click', async () => {
    const name = window.prompt('新建群聊 / 工作区名称');
    if (name == null) return;
    await createWorkspace(name);
    rerenderMeeting();
  });

  // 飞书群 → 同步成工作区(source=feishu,幂等);feishu-service 不在就仅本地
  try {
    const res = await feishuGet<{ workspaces: Array<{ chat_id: string; name: string; chat_status: string }> }>('/api/feishu/workspaces');
    for (const w of res.workspaces || []) if (w.chat_status === 'normal') await upsertFeishuWorkspace(w.chat_id, w.name);
  } catch { /* feishu-service 不可用 → 仅本地工作区 */ }

  // 飞书日历(user OAuth) → 会议日程源:已连接就拉「我本人」近期日程
  let fsConnected = false, fsEvents: FeishuEvent[] = [];
  try {
    const st = await feishuGet<{ connected: boolean }>('/api/feishu/oauth/status');
    fsConnected = !!st.connected;
    if (fsConnected) {
      const ev = await feishuGet<{ events: FeishuEvent[] }>('/api/feishu/my/events');
      fsEvents = (ev.events || []).slice().sort((a, b) => fsEventWhen(a) - fsEventWhen(b));
    }
  } catch { /* feishu-service 不在 → 跳过日历 */ }

  const [workspaces, allMeetings] = await Promise.all([listWorkspaces(), listAllMeetings()]);
  const wsName = new Map(workspaces.map((w) => [w.workspace_id, w.name]));
  const count = new Map<string, number>();
  for (const m of allMeetings) count.set(m.workspace_id, (count.get(m.workspace_id) ?? 0) + 1);
  const sched = allMeetings.filter((m) => m.status !== 'ended').sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''));

  // 连接状态控件(放日程区标题右侧):未连→按钮跳授权;已连→徽标 + 条数
  const connectCtl = fsConnected
    ? `<span class="mtg-fs-ok">${icon('calendar')} 飞书日历已连接${fsEvents.length ? ` · ${fsEvents.length} 条` : ''}</span>`
    : `<button class="mtg-ghost" id="mtg-fs-connect" style="margin-left:auto">${icon('calendar')} 连接飞书日历</button>`;
  const localRows = sched.map((m) => meetingRow(m, wsName.get(m.workspace_id))).join('');
  const schedHtml = (fsEvents.length || sched.length)
    ? feishuTimeline(fsEvents) + (localRows ? `<div class="mtl-local">${localRows}</div>` : '')
    : `<div class="mtg-sched"><p class="mtg-empty">${fsConnected
        ? '飞书日历近期没有日程，本地也还没有会议。'
        : '还没接飞书日历。点右上「连接飞书日历」拉你的真实日程；或进群聊「新建会议」。'}</p></div>`;
  const wsHtml = workspaces.length
    ? `<div class="mtg-ws-grid">` + workspaces.map((w) =>
        `<button class="mtg-ws" data-ws="${esc(w.workspace_id)}">${icon('users')}<span class="mtg-mat-body"><span class="mtg-mat-name">${esc(w.name)}${w.source === 'feishu' ? '<span class="mtg-fs-badge">飞书</span>' : ''}</span><span class="mtg-mat-meta">${count.get(w.workspace_id) ?? 0} 场会议</span></span></button>`
      ).join('') + `</div>`
    : `<p class="mtg-empty" style="text-align:left;padding:14px 2px">还没有群聊。点右上「新建群聊」建一个（接飞书后从群自动汇入）。</p>`;

  const body = document.getElementById('mtg-body');
  if (!body) return;
  body.innerHTML =
    `<section class="mtg-sec"><div class="mtg-sec-h">${icon('calendar')} 会议日程 <span class="mtg-soon">飞书日历 + 本地 · 待开始 / 进行中</span>${connectCtl}</div>${schedHtml}</section>`
    + `<section class="mtg-sec"><div class="mtg-sec-h">${icon('library')} 群聊书架 <span class="mtg-soon">以群聊为单位</span></div>${wsHtml}</section>`;
  body.querySelector('#mtg-fs-connect')?.addEventListener('click', () => { window.open(FEISHU_BASE + '/api/feishu/oauth/login', '_blank', 'noopener'); });
  body.querySelectorAll<HTMLButtonElement>('.mtg-ws[data-ws]').forEach((b) => b.addEventListener('click', () => mtgGoWorkspace(b.dataset.ws!)));
  wireMeetingRows(body);
}

/** 会议行的两个入口：主体=进入会议(直达画板)，尾部小钮=会议详情。 */
function wireMeetingRows(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('.mtg-mrow-hit[data-enter]').forEach((b) => b.addEventListener('click', () => { void enterMeeting(b.dataset.enter!); }));
  root.querySelectorAll<HTMLButtonElement>('.mtg-mrow-detail[data-detail]').forEach((b) => b.addEventListener('click', () => mtgGoMeeting(b.dataset.detail!, b.dataset.ws)));
}

/* ── 二级：一个群聊里的会议（进行中 / 待开始 / 已结束）────────────────────────── */
async function renderMtgWorkspace(c: HTMLDivElement, wsId: string): Promise<void> {
  const ws = await getWorkspace(wsId);
  if (!ws) { mtgGoHome(); return; }
  const title = `<button class="mtg-back" id="mtg-back">${icon('back')}</button><h2 class="mtg-title">${icon('users')} ${esc(ws.name)}</h2>`;
  const actions = `<button class="mtg-ghost primary" id="mtg-new-mtg">${icon('plus')} 新建会议</button>`;
  c.innerHTML = mtgShell(title, actions, `<div id="mtg-body"><p class="mtg-empty">加载中…</p></div>`);
  c.querySelector('#mtg-back')?.addEventListener('click', () => mtgGoHome());
  c.querySelector('#mtg-new-mtg')?.addEventListener('click', async () => {
    const t = window.prompt('会议标题');
    if (t == null) return;
    const when = window.prompt('计划时间（如 2026-06-25 14:30，留空=现在）', '') ?? '';
    await createMeeting(wsId, { title: t, scheduled_at: parseWhen(when) });
    rerenderMeeting();
  });

  const meetings = await listMeetings(wsId);
  const body = document.getElementById('mtg-body');
  if (!body) return;
  const buckets: Array<[MeetingStatus, string]> = [['live', '进行中'], ['upcoming', '待开始'], ['ended', '已结束']];
  const secs = buckets.map(([st, label]) => {
    const ms = meetings.filter((m) => m.status === st);
    return ms.length ? `<section class="mtg-sec"><div class="mtg-sec-h">${esc(label)} <span class="mtg-soon">${ms.length}</span></div>${ms.map((m) => meetingRow(m)).join('')}</section>` : '';
  }).join('');
  // 飞书来源工作区：拉群成员 → 参会人 + 群消息 → 群动态/资料
  let membersHtml = '', feedHtml = '';
  if (ws.source === 'feishu' && ws.feishu_chat_id) {
    const cid = ws.feishu_chat_id;
    try {
      const [m, msg] = await Promise.all([
        feishuGet<{ total: number; members: Array<{ open_id: string; name: string }> }>(`/api/feishu/workspaces/${cid}/members`),
        feishuGet<{ messages: FeishuMsg[] }>(`/api/feishu/workspaces/${cid}/messages?limit=30`),
      ]);
      const nameOf = new Map(m.members.map((p) => [p.open_id, p.name]));
      membersHtml = `<section class="mtg-sec"><div class="mtg-sec-h">${icon('users')} 参会人 <span class="mtg-soon">${m.total} 人 · 飞书群成员</span></div>`
        + `<div class="mtg-member-grid">${m.members.map((p) => `<span class="mtg-member">${esc(p.name)}</span>`).join('')}</div></section>`;
      feedHtml = renderFeed(msg.messages || [], nameOf);
    } catch { membersHtml = `<section class="mtg-sec"><div class="mtg-sec-h">${icon('users')} 参会人</div><p class="mtg-empty" style="text-align:left;padding:8px 2px">加载失败（feishu-service 未运行 / 权限不足？）</p></section>`; }
  }
  body.innerHTML = membersHtml + feedHtml + (secs || `<p class="mtg-empty" style="text-align:left;padding:14px 2px">这个群聊还没有会议。点右上「新建会议」建一个。</p>`);
  wireMeetingRows(body);
}

/* ── 三级：一场会议（文件 / 手写档案 / 思路总结）────────────────────────────── */
async function renderMtgDetail(c: HTMLDivElement, mtgId: string): Promise<void> {
  const m = await getMeeting(mtgId);
  if (!m) { mtgGoHome(); return; }
  const s = MTG_STATUS[m.status];
  const title = `<button class="mtg-back" id="mtg-back">${icon('back')}</button>`
    + `<h2 class="mtg-title">${esc(m.title)} <span class="mtg-st" style="color:${s.c};background:${s.bg}">${s.t}</span></h2>`;
  const statusBtn = m.status === 'upcoming' ? `<button class="mtg-ghost" id="mtg-start">${icon('play')} 开始会议</button>`
    : m.status === 'live' ? `<button class="mtg-ghost" id="mtg-end">${icon('stop')} 结束会议</button>` : '';
  const actions = `<button class="mtg-ghost primary" id="mtg-enter">${icon('pen')} 进入会议</button>` + statusBtn + `<button class="mtg-ghost" id="mtg-add-mat">${icon('plus')} 添加资料</button>`;
  c.innerHTML = mtgShell(title, actions, `<div id="mtg-body"><p class="mtg-empty">加载中…</p></div>`);
  c.querySelector('#mtg-back')?.addEventListener('click', () => mtgGoWorkspace(m.workspace_id));
  // 进入会议 = 直达画板（enterMeeting：方案A 存档主阅读 + 会议空白页 + 右侧群资料栏）。详情页此处只是另一处入口。
  c.querySelector('#mtg-enter')?.addEventListener('click', () => { void enterMeeting(mtgId); });
  c.querySelector('#mtg-start')?.addEventListener('click', async () => { await updateMeeting(mtgId, { status: 'live' }); rerenderMeeting(); });
  c.querySelector('#mtg-end')?.addEventListener('click', async () => { await updateMeeting(mtgId, { status: 'ended' }); rerenderMeeting(); });
  c.querySelector('#mtg-add-mat')?.addEventListener('click', async () => {
    const books = await listBooks();
    const avail = books.filter((b) => !m.material_doc_ids.includes(b.document_id));
    if (!avail.length) { window.alert('没有可添加的资料。先到「阅读」页导入 PDF。'); return; }
    const pick = window.prompt('添加资料（输入序号，逗号分隔）：\n' + avail.map((b, i) => `${i + 1}. ${b.filename}`).join('\n'));
    if (pick == null) return;
    const add = pick.split(/[,，\s]+/).map((x) => parseInt(x, 10) - 1).filter((i) => i >= 0 && i < avail.length).map((i) => avail[i].document_id);
    if (add.length) { await updateMeeting(mtgId, { material_doc_ids: [...new Set([...m.material_doc_ids, ...add])] }); rerenderMeeting(); }
  });

  const body = document.getElementById('mtg-body');
  if (!body) return;
  const books = await listBooks();
  const bookMap = new Map(books.map((b) => [b.document_id, b]));
  const mats = m.material_doc_ids.map((id) => bookMap.get(id)).filter((b): b is PersistedDoc => !!b);
  const markLists = await Promise.all(mats.map((b) => getFoldedMarks(b.document_id)));

  const filesHtml = mats.length
    ? mats.map((b) => materialCard(b, 'file', `${b.page_count} 页`)).join('')
    : `<p class="mtg-empty" style="text-align:left;padding:14px 2px">还没有资料。点右上「添加资料」从已导入的 PDF 里挑。</p>`;
  const archiveHtml = mats.length
    ? mats.map((b, i) => {
        const hand = markLists[i].filter((mk) => mk.feature_type === 'handwriting').length;
        return materialCard(b, 'pen', `${markLists[i].length} 处标注 · 手写 ${hand}`);
      }).join('')
    : `<p class="mtg-empty" style="text-align:left;padding:14px 2px">${m.status === 'ended' ? '本场会议没有留下手写档案。' : '会议进行 / 结束后，你在资料与转写上的手写会汇总在这里。'}</p>`;
  const summaryHtml = m.summary
    ? `<div class="mtg-summary">${esc(m.summary)}</div>`
    : `<div class="mtg-sched"><p class="mtg-empty">${m.status === 'ended' ? '还没生成思路总结。' : '会议结束后可对手写档案做思路总结。'}<br>会后 AI 综合（送云端处理）——接线后置。</p></div>`;
  const genBtn = `<button class="mtg-ghost" id="mtg-gen-sum" style="margin-left:auto"${m.status === 'ended' ? '' : ' disabled'}>${icon('lightbulb')} 生成思路总结</button>`;

  // 飞书工作区（含模拟会议）：从群里真实拉资料（文件/图片消息）→ 会前「群里收集到的资料」。点击经 im:resource 下载查看。
  const ws = await getWorkspace(m.workspace_id);
  let groupHtml = '';
  if (ws?.source === 'feishu' && ws.feishu_chat_id) {
    try {
      const res = await feishuGet<{ messages: FeishuMsg[] }>(`/api/feishu/workspaces/${ws.feishu_chat_id}/messages?limit=50`);
      const files = (res.messages || []).filter((x) => (x.msg_type === 'file' && x.file_key) || (x.msg_type === 'image' && x.image_key));
      groupHtml = files.length
        ? `<div class="mtg-shelf">` + files.map((f) => {
            const img = f.msg_type === 'image';
            const key = img ? f.image_key : f.file_key;
            const name = img ? '［图片］' : (f.file_name || '文件');
            const url = `${FEISHU_BASE}/api/feishu/messages/${encodeURIComponent(f.message_id)}/file/${encodeURIComponent(key || '')}?type=${img ? 'image' : 'file'}&name=${encodeURIComponent(name)}`;
            return `<a class="mtg-mat" href="${esc(url)}" target="_blank" rel="noopener" title="从群下载查看（im:resource）">`
              + `${icon('file')}<span class="mtg-mat-body"><span class="mtg-mat-name">${esc(name)}</span>`
              + `<span class="mtg-mat-meta">群文件 · ${esc(fmtMs(f.create_time))}</span></span></a>`;
          }).join('') + `</div>`
        : `<p class="mtg-empty" style="text-align:left;padding:10px 2px">群里近期没有文件。</p>`;
    } catch { groupHtml = `<p class="mtg-empty" style="text-align:left;padding:10px 2px">拉取群资料失败（feishu-service 未运行？）</p>`; }
  }
  const groupSec = ws?.source === 'feishu'
    ? `<section class="mtg-sec"><div class="mtg-sec-h">${icon('message')} 群里收集到的资料 <span class="mtg-soon">机器人自动捞取 · ${esc(ws.name)}</span></div>${groupHtml}</section>`
    : '';

  body.innerHTML =
    `<section class="mtg-sec"><div class="mtg-sec-h">${icon('file')} 可能有用的文件 <span class="mtg-soon">${mats.length}</span></div>${filesHtml}</section>`
    + groupSec
    + `<section class="mtg-sec"><div class="mtg-sec-h">${icon('pen')} 你的手写档案</div>${archiveHtml}</section>`
    + `<section class="mtg-sec"><div class="mtg-sec-h">${icon('lightbulb')} 思路总结 ${genBtn}</div>${summaryHtml}</section>`;
  wireMaterialCards(body);
  // 思路总结：架构决议(2026-06-24)= 暴露成 MCP（公共基础设施，阅读+会议共用）——底座层开个 MCP 面
  // （读 marks/ai_turns、按 surface/meeting 取、请求综合），外部 agent 走 MCP 来。这轮不做，记为底座目标。
  document.getElementById('mtg-gen-sum')?.addEventListener('click', () => window.alert('思路总结：会后经 MCP 把手写档案 + 转写交外部 agent 综合（公共基础设施，阅读也用同一个）——待接入。'));
}

/* ── AI 会话页（ChatGPT 式对话流）─────────────────────────────────────────── */

function renderChat(c: HTMLDivElement): void {
  if (!selectedBook) selectedBook = state.documentId ?? null;
  c.innerHTML =
    `<div class="cns-head"><h2>${icon('message')} AI 会话</h2><div class="cns-head-ctl">`
    + `<select id="cns-book-sel"></select>`
    + `<button class="cns-btn" id="cns-refresh">⟳ 刷新</button>`
    + `<button class="cns-btn" id="cns-clear" title="清空这本书模型当下记得的对话上下文（≤3 轮滑动窗），不影响账本">🗑 清空上下文</button>`
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

/* ── 按页分组折叠：把无限增长的列表（会话/取证）归到页里，最新页默认展开、旧页收一行摘要 ──
 * body 懒渲染：只有最新组立即填，其余点开才插 DOM（避免几百条 + 取证图一次性压垮渲染）。 */
interface PageGroup { page_index: number; latestSeq: number; time: string; preview: string; count: number; bodyHtml: string }

function groupSummary(g: PageGroup, unit: string): string {
  return `<details class="grp" data-page="${g.page_index}">`
    + `<summary class="grp-sum"><span class="grp-pg">第 ${g.page_index + 1} 页</span><span class="grp-count">${g.count} ${unit}</span><span class="grp-time">${esc(g.time)}</span><span class="grp-prev">${esc(g.preview || '—')}</span></summary>`
    + `<div class="grp-body"></div></details>`;
}
/** 渲染分组列表：最新组立即填 body，其余懒填。返回 page→bodyHtml 供程序化展开（互跳用）。 */
function renderGroupList(container: HTMLElement, groups: PageGroup[], unit: string): Map<number, string> {
  const bodies = new Map<number, string>(groups.map((g) => [g.page_index, g.bodyHtml]));
  container.innerHTML = groups.map((g) => groupSummary(g, unit)).join('');
  groups.forEach((g, gi) => {
    const det = container.querySelector(`details.grp[data-page="${g.page_index}"]`) as HTMLDetailsElement | null;
    const body = det?.querySelector('.grp-body') as HTMLElement | null;
    if (!det || !body) return;
    if (gi === 0) { body.innerHTML = g.bodyHtml; body.dataset.filled = '1'; det.open = true; }
    else det.addEventListener('toggle', () => { if (det.open && body.dataset.filled !== '1') { body.innerHTML = bodies.get(g.page_index) ?? ''; body.dataset.filled = '1'; } });
  });
  return bodies;
}
/** 程序化展开某页组并补填 body（对象表→HMP 卡互跳时，目标卡可能在收起的旧页组里）。 */
function openHmpGroup(pg: number): void {
  const det = document.querySelector(`#hmp-grp details.grp[data-page="${pg}"]`) as HTMLDetailsElement | null;
  if (!det) return;
  const body = det.querySelector('.grp-body') as HTMLElement | null;
  if (body && body.dataset.filled !== '1') { body.innerHTML = hmpBodyByPage.get(pg) ?? ''; body.dataset.filled = '1'; }
  det.open = true;
}
let hmpPageOfMark = new Map<string, number>(); // mark_id → page_index（互跳定位用）
let hmpBodyByPage = new Map<number, string>(); // page_index → 该页 HMP 卡 html（懒填/互跳用）

async function renderConversation(): Promise<void> {
  const inner = document.getElementById('cns-thread-inner');
  const thread = document.getElementById('cns-thread');
  if (!inner) return;
  const turns: PersistedAiTurn[] = selectedBook ? await getBookAiTurns(selectedBook) : [];
  const shown = turns.filter((t) => t.overlay_state !== 'dismissed'); // 时间序（旧→新）
  if (!shown.length) {
    inner.innerHTML = `<p class="cns-empty">这本书还没有 AI 对话。<br>圈/划/写一处、停笔，每一轮「发送给 AI 的内容 + 回复 + 思考」会在这里成串出现。</p>`;
    return;
  }
  const marks = selectedBook ? await getFoldedMarks(selectedBook) : [];
  const markMap = new Map(marks.map((m) => [m.mark_id, m]));
  const idxMap = new Map(shown.map((t, i) => [t.entry_id, i + 1])); // 全局 1-based 轮号（按时间序）
  const byPage = new Map<number, PersistedAiTurn[]>();
  for (const t of shown) { const p = t.page_index ?? 0; const a = byPage.get(p); if (a) a.push(t); else byPage.set(p, [t]); }
  const groups: PageGroup[] = [...byPage.entries()].map(([page_index, ts]) => {
    const sorted = ts.slice().sort((a, b) => b.seq - a.seq); // 组内新→旧
    const latest = sorted[0];
    const prev = (latest.inference_view?.question || latest.inference_view?.marked || latest.ai_reply || '').replace(/\s+/g, ' ').slice(0, 34);
    return { page_index, latestSeq: latest.seq, time: fmtTime(latest.created_at), preview: prev, count: sorted.length, bodyHtml: sorted.map((t) => turnBlock(t, idxMap.get(t.entry_id) ?? 0, markMap)).join('') };
  }).sort((a, b) => b.latestSeq - a.latestSeq); // 最近活动的页在最上
  renderGroupList(inner, groups, '轮');
  if (thread) thread.scrollTop = 0; // 最新页在最上、默认展开 → 滚顶即见最新
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
  const folded = t.overlay_state === 'folded'; // 手写被判「写给自己」→ 静默未回应，仍入账供此处复盘
  const reply = t.ai_reply || '（空回复）';
  const think = (t.thinking || '').trim();
  const userInner = (t.pipeline && t.pipeline.length) ? pipelineSection(t.pipeline) : legacySection(t, markMap);

  const thinkBlock = think
    ? `<details class="cns-think"><summary>💭 思考过程（${think.length} 字）</summary><div class="cns-think-body">${esc(think)}</div></details>`
    : `<div class="cns-nothink">无思考过程返回（当前模型不回传；切到 claude-sonnet-4-6 可见）</div>`;

  // 折叠轮：不渲 AI 气泡，改给一条"未回应"说明（判否理由已在上方 legacySection 的「分类器判定」里）。
  const resultSection = folded
    ? `<div class="cns-label" style="margin-top:14px">结果</div>`
      + `<div class="cns-row ai"><div class="cns-col"><div class="cns-bub" style="background:#f3efe7;border:1px dashed #d8cdbb;color:#6d655c">`
      + `🚫 折叠为「写给自己的笔记」——上下文分类器判无需回应，未触发主模型。这条手写仍留在 session，计入下次长停顿综合。`
      + `</div><div class="cns-meta">#${idx} · 未回应（fold）</div></div></div>`
    : `<div class="cns-label" style="margin-top:14px">AI 回复</div>`
      + `<div class="cns-row ai"><div class="cns-col"><div class="cns-bub ai">${esc(reply)}</div>`
      + thinkBlock
      + `<div class="cns-meta">#${idx} · ${esc(t.model || '')}${t.supersedes ? ' · 改写' : ''}</div></div></div>`;

  return `<div class="cns-turn">`
    + `<div class="cns-label">发送给 AI 的内容 · 第 ${(t.page_index ?? 0) + 1} 页 · <span class="cns-trig" style="background:${trig.c}">${esc(trig.t)}</span>${folded ? ' · <span class="cns-trig" style="background:#a99">折叠</span>' : ''} · ${fmtTime(t.created_at)}</div>`
    + `<div class="cns-userwrap"><div class="cns-usercard">` + userInner + `</div></div>`
    + resultSection
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
  page_index: number; page_id: string; seq: number; created_at: string; live: boolean; unsaved: boolean;
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
    return { key: m.mark_id, hmp, marked: m.marked_text, feature: m.feature_type, page_index: m.page_index, page_id: m.page_id, seq: m.seq, created_at: m.created_at, live: !!live, unsaved: false };
  });
  // 未落库的最新一笔（hmp:updated 早于 appendMarkEntry 一个 tick）：即时占位。lastHmps 是全局的，
  // 只在"选中书=当前打开的书"时才并入，避免把别的书的未落库笔串进来。
  if (selectedBook === state.documentId) {
    for (const h of state.lastHmps) {
      if (seen.has(h.hmp_id)) continue;
      rows.push({ key: h.hmp_id, hmp: h, marked: h.text_hint || '', feature: featureFromAction(h.action), page_index: state.pageIndex, page_id: h.surface_id, seq: Number.MAX_SAFE_INTEGER, created_at: '', live: true, unsaved: true });
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
  if (!rows.length) {
    hmpInner.innerHTML = `<p class="cns-empty">这本书还没有标注取证记录。<br>圈/划/写一处、停笔，每一笔的 HMP（命中了什么 / 读出什么 / 取证图）会在这里出现。</p>`;
    hmpPageOfMark = new Map(); hmpBodyByPage = new Map();
  } else {
    // 按页分组（rows 已新→旧，per-page 数组保序）
    const byPage = new Map<number, HmpRow[]>();
    for (const r of rows) { const a = byPage.get(r.page_index); if (a) a.push(r); else byPage.set(r.page_index, [r]); }
    hmpPageOfMark = new Map(rows.map((r) => [r.key, r.page_index]));
    const groups: PageGroup[] = [...byPage.entries()].map(([page_index, rs]) => {
      const latest = rs[0];
      return { page_index, latestSeq: latest.seq, time: latest.created_at ? fmtTime(latest.created_at) : '本会话', preview: markChipLabel(latest.feature, latest.marked), count: rs.length,
        bodyHtml: rs.map((r) => hmpCard(r, (objMap && si && r.page_id === si.surface_id) ? objMap : null)).join('') };
    }).sort((a, b) => b.latestSeq - a.latestSeq);
    hmpInner.innerHTML = `<p class="hmp-note">逐笔 HMP 取证——按页分组，最新页默认展开、旧页收起。点蓝色「命中对象」可跳对象表对照。共 ${rows.length} 笔。</p><div id="hmp-grp"></div>`;
    const grp = document.getElementById('hmp-grp');
    hmpBodyByPage = grp ? renderGroupList(grp, groups, '笔') : new Map();
  }
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
    `<div class="cns-head"><h2>${icon('scan')} 采集取证</h2>`
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

/* ── 设置页（迁出旧 #dev 抽屉；按代码审计诚实标注每项是否真生效）─────────────────────
 * settings 落 localStorage('inkloop.settings.v1')；多数项改完 effect='changed'（emit settings:changed
 * → main 取消在途计时 + 清当前 session），少数仅 saveSettings()。可用性徽标来自本会话审计：
 * 生效=v3 主路真读；调试叠层=只影响可视化；弱效=仅下次导入文档时生效（预排版预热）。 */

type SetBadge = { t: string; c: 'live' | 'dev' | 'weak' | 'dead' };
const B_LIVE: SetBadge = { t: '生效', c: 'live' };
const B_DEV: SetBadge = { t: '调试叠层', c: 'dev' };
const B_WEAK: SetBadge = { t: '弱效', c: 'weak' };

type SetRow =
  | { kind: 'check'; label: string; badge: SetBadge; hint?: string; get: () => boolean; set: (v: boolean) => void; effect: 'changed' | 'save' }
  | { kind: 'select'; label: string; badge: SetBadge; hint?: string; opts: Array<[string, string]>; get: () => string; set: (v: string) => void; effect: 'changed' | 'save' }
  | { kind: 'number'; label: string; badge: SetBadge; hint?: string; min: number; max: number; unit: string; get: () => number; set: (v: number) => void; effect: 'changed' | 'save' };
interface SetSection { title: string; note?: string; fold?: boolean; rows: SetRow[] }

function setSections(): SetSection[] {
  const g = settings.gesture, p = settings.preprocess;
  return [
    { title: '核心 · 影响真实行为', rows: [
      { kind: 'select', label: '推理模型（答问 · 分类器默认）', badge: B_LIVE, opts: [['kimi-k2.6', 'kimi-k2.6（中文笔迹稳）'], ['claude-opus-4-8', 'claude-opus-4-8（最新·慢）'], ['claude-opus-4-7', 'claude-opus-4-7（质量·慢）'], ['claude-sonnet-4-6', 'claude-sonnet-4-6（快·能回思考）'], ['gemini-3.5-flash', 'gemini-3.5-flash'], ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite（快）']], get: () => settings.inferModel, set: (v) => { settings.inferModel = v; }, effect: 'changed' },
      { kind: 'select', label: '识别分类器模型 · /api/interpret（空=继承推理模型）', badge: B_LIVE, opts: [['', '继承推理模型'], ['__local_hwr__', '端侧手写·OpenVINO 英文(徐方案·走本地端点)'], ['kimi-k2.6', 'kimi-k2.6'], ['claude-opus-4-8', 'claude-opus-4-8'], ['claude-sonnet-4-6', 'claude-sonnet-4-6'], ['gemini-3.5-flash', 'gemini-3.5-flash'], ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite']], get: () => settings.interpretModel, set: (v) => { settings.interpretModel = v; }, effect: 'changed' },
      { kind: 'select', label: '上下文分类器模型 · /api/classify-context（空=继承推理模型）', badge: B_LIVE, opts: [['', '继承推理模型'], ['__local_rules__', '端侧规则·徐 IntentClassifier（驱动 respond/fold·不调云）'], ['kimi-k2.6', 'kimi-k2.6'], ['claude-opus-4-8', 'claude-opus-4-8'], ['claude-sonnet-4-6', 'claude-sonnet-4-6'], ['gemini-3.5-flash', 'gemini-3.5-flash'], ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite']], get: () => settings.classifyModel, set: (v) => { settings.classifyModel = v; }, effect: 'changed' },
      { kind: 'check', label: '送合成图给模型', hint: '强制把合成图/笔迹图也送进主模型；默认关＝纯文字取证路线（徐方案）', badge: B_LIVE, get: () => settings.sendMarkImage, set: (v) => { settings.sendMarkImage = v; }, effect: 'changed' },
      { kind: 'select', label: '输出落点', badge: B_LIVE, opts: [['margin', '右侧留白'], ['inline', '贴正文浮动']], get: () => settings.placement, set: (v) => { settings.placement = v as Placement; }, effect: 'changed' },
      { kind: 'check', label: '手势响应（总开关）', hint: '关掉后停笔不再生成 HMP+旁注、不触发综合', badge: B_LIVE, get: () => g.enabled, set: (v) => { g.enabled = v; }, effect: 'changed' },
      { kind: 'number', label: '长停顿综合阈值', unit: '秒', min: 10, max: 600, hint: '停笔多少秒触发整段 session 综合（v3 主线，默认 90）；调小可冒烟测', badge: B_LIVE, get: () => g.idleSeconds ?? 90, set: (v) => { g.idleSeconds = v; }, effect: 'changed' },
      { kind: 'select', label: '重排引擎', badge: B_LIVE, opts: [['ai', 'AI 结构重建（主线·保 bbox）'], ['local', '仅启发式'], ['hybrid', '启发式+模型精修'], ['vision', '启发式+视觉重排'], ['rewrite', 'VLM 看图重写']], get: () => settings.reflowProvider, set: (v) => { settings.reflowProvider = v; }, effect: 'changed' },
      { kind: 'select', label: '重排模型', badge: B_LIVE, opts: [['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite（默认·快）'], ['gemini-3.5-flash', 'gemini-3.5-flash'], ['kimi-k2.6', 'kimi-k2.6（慢·对照）'], ['claude-sonnet-4-6', 'claude-sonnet-4-6（准·对照）']], get: () => settings.reflowModel, set: (v) => { settings.reflowModel = v; }, effect: 'changed' },
      { kind: 'check', label: '重排前置（渲染即后台急算）', hint: '每次翻页后台预排当前页·烧 token；默认关', badge: B_LIVE, get: () => settings.reflowEager, set: (v) => { settings.reflowEager = v; }, effect: 'save' },
    ] },
    { title: '调试叠层 · 只影响可视化、不碰推理', rows: [
      { kind: 'check', label: '显示 bbox 叠层（对象框+命中高亮+HMP 浮窗）', badge: B_DEV, get: () => settings.devOverlay, set: (v) => { settings.devOverlay = v; }, effect: 'changed' },
      { kind: 'check', label: '显示组装区域（手写实时框）', badge: B_DEV, get: () => settings.showRegion, set: (v) => { settings.showRegion = v; }, effect: 'changed' },
      { kind: 'check', label: '显示关联框（综合后紫色虚框）', badge: B_DEV, get: () => settings.showRelations, set: (v) => { settings.showRelations = v; }, effect: 'changed' },
    ] },
    { title: '历史 / 弱效 · 仅特定时机生效（按代码审计标注）', note: '保留可调，但仅下次导入文档时生效。', fold: true, rows: [
      { kind: 'check', label: '预排版前 N 页', hint: '仅下次导入文档时生效', badge: B_WEAK, get: () => p.reflowEnabled, set: (v) => { p.reflowEnabled = v; }, effect: 'save' },
      { kind: 'number', label: '预排版页数', unit: '页', min: 0, max: 100, badge: B_WEAK, get: () => p.reflowPages, set: (v) => { p.reflowPages = v; }, effect: 'save' },
    ] },
  ];
}

function setRowHtml(r: SetRow, id: string): string {
  const badge = `<span class="set-badge ${r.badge.c}">${esc(r.badge.t)}</span>`;
  const hint = r.hint ? `<div class="cset-hint">${esc(r.hint)}</div>` : '';
  let ctl: string;
  if (r.kind === 'check') ctl = `<input type="checkbox" id="${id}"${r.get() ? ' checked' : ''}>`;
  else if (r.kind === 'select') ctl = `<select id="${id}">${r.opts.map(([v, t]) => `<option value="${esc(v)}"${v === r.get() ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  else ctl = `<input type="number" id="${id}" min="${r.min}" max="${r.max}" step="1" value="${r.get()}"><span class="cset-unit">${esc(r.unit)}</span>`;
  return `<div class="cset-row"><div class="cset-text"><div class="cset-l"><span class="cset-label">${esc(r.label)}</span>${badge}</div>${hint}</div><div class="cset-control">${ctl}</div></div>`;
}

function applySetEffect(effect: 'changed' | 'save'): void {
  if (effect === 'changed') bus.emit('settings:changed'); // → main cancelTimers + clearSession
  saveSettings();
}

/* 诊断（迁自旧 #dev 抽屉的几个孤儿读数：坐标自测 / 延迟指标 / 预处理进度 / trace 导出）。 */
function diagHtml(): string {
  return `<details class="cset-fold cset-sec" id="cset-diag"><summary>诊断 · 迁自旧 dev 面板</summary>`
    + `<div class="cset-sec-note">坐标变换自测、各阶段延迟、预处理进度、trace 导出——旧 #dev 退役后搬到这里。</div>`
    + `<div class="cset-row"><div class="cset-text"><div class="cset-l"><span class="cset-label">坐标自测</span></div><div class="cset-hint" id="cset-selftest">…</div></div></div>`
    + `<div class="cset-row"><div class="cset-text"><div class="cset-l"><span class="cset-label">预处理进度</span></div><div class="cset-hint" id="cset-pp">未运行</div></div></div>`
    + `<div class="cset-row"><div class="cset-text" style="width:100%"><div class="cset-l"><span class="cset-label">延迟指标（last / P50）</span></div><table class="cap-tbl" id="cset-metrics" style="margin-top:7px"><tbody></tbody></table></div></div>`
    + `<div class="cset-row"><div class="cset-text"><div class="cset-l"><span class="cset-label">Trace 事件日志</span></div><div class="cset-hint" id="cset-tracecount">导出本会话所有 trace（NDJSON），离线核对采集/推理细节</div></div><div class="cset-control"><button class="cns-btn" id="cset-dl-trace">下载 JSONL</button></div></div>`
    + `</details>`;
}
function fillDiag(): void {
  const st = document.getElementById('cset-selftest');
  if (st) { const r = selfTest(); st.textContent = r.samples ? `${r.ok ? '✓' : '✗'} ${r.samples} 点 · maxErr ${r.maxErr.toExponential(1)} · zoom ${Math.round(state.zoom * 100)}%` : '等待页面渲染'; }
  const mb = document.getElementById('cset-metrics')?.querySelector('tbody');
  if (mb) mb.innerHTML = snapshot().map((r) => `<tr><td>${esc(r.label)}</td><td class="cap-mono">${r.last == null ? '–' : r.last + 'ms'}</td><td class="cap-mono">${r.p50 == null ? '–' : r.p50 + 'ms'}</td></tr>`).join('') || '<tr><td class="cap-dim" colspan="3">暂无计时</td></tr>';
  const tc = document.getElementById('cset-tracecount');
  if (tc) tc.textContent = `本会话 ${traceCount()} 条 trace；导出 NDJSON 离线核对采集/推理细节`;
}

let resetArmed = false;
function renderSettings(c: HTMLDivElement): void {
  let n = 0;
  const flat: Array<{ id: string; row: SetRow }> = [];
  const secHtml = setSections().map((s) => {
    const rowsHtml = s.rows.map((row) => { const id = `cset-${n++}`; flat.push({ id, row }); return setRowHtml(row, id); }).join('');
    const note = s.note ? `<div class="cset-sec-note">${esc(s.note)}</div>` : '';
    return s.fold
      ? `<details class="cset-fold cset-sec"><summary>${esc(s.title)}</summary>${note}${rowsHtml}</details>`
      : `<div class="cset-sec"><div class="cset-sec-h">${esc(s.title)}</div>${note}${rowsHtml}</div>`;
  }).join('');
  c.innerHTML =
    `<div class="cns-head"><h2>${icon('settings')} 设置</h2><div class="cns-head-ctl">`
    + `<button class="cns-btn" id="cset-reset" title="清掉 localStorage 里存的设置、重载回代码默认">恢复默认设置</button>`
    + `</div></div>`
    + `<div class="cns-thread"><div class="cset-wrap">${secHtml}${diagHtml()}`
    + `<div class="cset-actions"><span class="cset-hint">设置存于浏览器 localStorage（inkloop.settings.v1），即时生效；个别项需翻页/重导/清上下文才显现，已在各项标注。徽标含义：生效=v3 主路真读 · 调试叠层=只影响可视化 · 弱效=读它的路径当前主路不走或仅导入时生效 · 失效=当前无人按它分流。</span></div>`
    + `</div></div>`;
  document.getElementById('cset-dl-trace')?.addEventListener('click', () => downloadTrace());
  fillDiag();
  for (const { id, row } of flat) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) continue;
    el.addEventListener('change', () => {
      if (row.kind === 'check') row.set((el as HTMLInputElement).checked);
      else if (row.kind === 'select') row.set(el.value);
      else { const v = Math.min(row.max, Math.max(row.min, Math.round(+el.value || 0))); row.set(v); (el as HTMLInputElement).value = String(v); }
      applySetEffect(row.effect);
    });
  }
  resetArmed = false;
  const resetBtn = c.querySelector<HTMLButtonElement>('#cset-reset');
  resetBtn?.addEventListener('click', () => {
    if (!resetArmed) { resetArmed = true; resetBtn.textContent = '再点一次确认（清存档·重载）'; resetBtn.classList.add('cset-danger'); return; }
    try { localStorage.removeItem('inkloop.settings.v1'); } catch { /* ignore */ }
    location.reload();
  });
}

/* ── 路由 / 初始化 ───────────────────────────────────────────────────────── */

function syncFromHash(): void {
  const id = location.hash.replace(/^#/, '') as PageId;
  const def = PAGES.find((p) => p.id === id);
  if (def && def.ready && id !== 'reader') showPage(id); // #chat / #hmp / #settings 已实现页
  else showPage('reader'); // 其余（含历史 #dev 链接）一律回到阅读底
}

export function initNavShell(): void {
  buildShell();

  try { if (localStorage.getItem('inkloop.rail.collapsed') === '1') document.body.classList.add('rail-collapsed'); } catch { /* ignore */ }
  try { if (localStorage.getItem('inkloop.rail.dev') === '1') setDevExpanded(true); } catch { /* ignore */ }

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
    if (markEl?.dataset.mark) {
      setSeg('hmp');
      const pg = hmpPageOfMark.get(markEl.dataset.mark); // 目标卡可能在收起的旧页组里 → 先展开补填
      if (pg != null) openHmpGroup(pg);
      flashTarget(`#hmp-inner .hmp-card[data-mark="${CSS.escape(markEl.dataset.mark)}"]`);
    }
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
  // 设置页「诊断」读数实时刷新（迁自旧 #dev：延迟指标 / 坐标自测 / 预处理进度）
  const liveDiag = () => { if (activePage === 'settings') fillDiag(); };
  bus.on('metrics', liveDiag);
  bus.on('page:rendered', liveDiag);
  bus.on('preprocess:progress', (i, n) => { const el = document.getElementById('cset-pp'); if (el) el.textContent = `预处理中 ${i as number}/${n as number} 页…`; });
  bus.on('preprocess:done', () => { const el = document.getElementById('cset-pp'); if (el) el.textContent = '预处理完成'; });
  // 切书后默认跟随当前书
  bus.on('document:loaded', () => {
    selectedBook = state.documentId ?? selectedBook;
    if (activePage === 'chat') { void fillBookSelect(); void renderConversation(); }
    if (activePage === 'hmp') { void fillBookSelect('cap-book-sel').then(() => renderCaptureContent()); }
    if (activePage === 'meeting') rerenderMeeting();
  });

  window.addEventListener('hashchange', syncFromHash);
  syncFromHash();
}
