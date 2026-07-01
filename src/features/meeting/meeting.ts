/**
 * 会议 feature（F4b：从 dev/console.ts 整块迁出，保持 active）。
 *
 * 会议是「捕捉+思考设备」底座上的一个一等模式（不是 dev 页）。本模块自持三级视图机
 * （home 日程聚合 → workspace 群会议 → meeting 档案）+ 会中工作台（进存档主阅读 / 退还原 +
 * 半掩群资料栏）+ 飞书接入（群/成员/群动态/日历 OAuth，feishu-service 不在则静默退回纯本地）。
 *
 * 与导航壳的边界（双向解耦成单一桥 MeetingHost）：
 *   壳 → 会议：导航壳在 boot 调 initMeeting(host)，并在路由时调 renderMeeting / rerenderMeeting / syncMtgChrome。
 *   会议 → 壳：只经 host.go(page) 切页、host.activePage() 读当前页——不再直接抓壳内部的 go/activePage。
 * 底座（不属会议、会议只借用）：renderBlankSurface（白板=日记也要）/ openPdfFromUrl / reopenBook /
 *   SurfaceContext / setActiveContext / 账本 store。交接给另一位开发者后边界干净。
 */
import { getActiveContext, setActiveContext } from '../../app/state';
import { listBooks, getFoldedMarks, createWorkspace, listWorkspaces, getWorkspace, upsertFeishuWorkspace, createMeeting, listMeetings, listAllMeetings, getMeeting, updateMeeting, startSimMeeting } from '../../local/store';
import { reopenBook, renderBlankSurface, openPdfFromUrl } from '../../surface/renderer';
import { SurfaceContext } from '../../app/surface-context';
import { icon } from '../../surface/icons';
import { esc } from '../../core/escape';
import type { MeetingStatus, PersistedDoc, PersistedMeeting } from '../../core/store-format';
import { apiUrl } from '../../core/api';
import './meeting.css';

/** 会议 ↔ 导航壳的唯一桥。壳在 boot 时经 initMeeting 注入实现。 */
export interface MeetingHost {
  /** 切换导航壳到某页（会议进/退要回阅读底或会议列表）。 */
  go: (id: 'reader' | 'meeting') => void;
  /** 当前激活的导航页（会中浮层显隐 / 重渲判定用）。 */
  activePage: () => string;
}
let host: MeetingHost = { go: () => { /* 未注入：默认空操作 */ }, activePage: () => '' };
/** 导航壳 boot 时调用：注入壳桥 + 捕获 boot 主阅读实例（进/退会议时切回它）。 */
export function initMeeting(h: MeetingHost): void {
  host = h;
  readerCtx = getActiveContext();
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

// P0 安全止血：feishu-service/convert-service 之前零鉴权、前端直连裸端口（见项目记忆盲区扫描发现）。
// 浏览器请求一律走同源代理（secret 服务端注入）；FEISHU_ABSOLUTE 只用于拼「喂给 convert-service 当抓取源」的地址
// （convert-service 服务端 fetch，自己代填 secret，见 mobile/meeting.ts 同款注释）。
const FEISHU_PROXY = '/api/feishu-svc';
const CONVERT_PROXY = '/api/convert';
const FEISHU_ABSOLUTE = ((import.meta.env.VITE_FEISHU_SERVICE_ABSOLUTE as string | undefined) ?? 'http://localhost:4321').replace(/\/+$/, '');
/** 该群文件能不能直接转成可标注 PDF（v1 只 HTML）。 */
const isConvertible = (f: FeishuMsg): boolean => f.msg_type === 'file' && /\.html?$/i.test(f.file_name || '');
const feishuFilePath = (f: FeishuMsg): string => {
  const img = f.msg_type === 'image';
  const key = img ? f.image_key : f.file_key;
  const name = img ? '［图片］' : (f.file_name || '文件');
  return `/api/feishu/messages/${encodeURIComponent(f.message_id)}/file/${encodeURIComponent(key || '')}?type=${img ? 'image' : 'file'}&name=${encodeURIComponent(name)}`;
};
/** 群文件的飞书下载 URL（浏览器直接点开用·走同源代理）。apiUrl() 包一层：安卓静态包下要落到 VITE_API_BASE_URL。 */
function feishuFileUrl(f: FeishuMsg): string { return apiUrl(`${FEISHU_PROXY}${feishuFilePath(f)}`); }
/** HTML 群文件 → convert-service 转出的可标注 PDF 的 URL（内嵌的抓取源要用真绝对地址）。 */
const convertedPdfUrl = (f: FeishuMsg): string => apiUrl(`${CONVERT_PROXY}/to-pdf?url=${encodeURIComponent(FEISHU_ABSOLUTE + feishuFilePath(f))}`);
async function feishuGet<T>(path: string): Promise<T> {
  const r = await fetch(apiUrl(FEISHU_PROXY + path));
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
export function rerenderMeeting(): void {
  if (host.activePage() !== 'meeting') return;
  const content = document.getElementById('app-page-content') as HTMLDivElement | null;
  if (content) renderMeeting(content);
}
function mtgGoHome(): void { mtgView = { level: 'home' }; rerenderMeeting(); }
function mtgGoWorkspace(wsId: string): void { mtgView = { level: 'workspace', wsId }; rerenderMeeting(); }
function mtgGoMeeting(mtgId: string, wsId?: string): void { mtgView = { level: 'meeting', mtgId, wsId: wsId ?? mtgView.wsId }; rerenderMeeting(); }

/* ── 会中工作台：点会议=直达画板（方案A：进存档主阅读 / 退还原）+ 右侧半掩群资料栏 ──────────── */
let mtgMode: { meetingId: string; wsId: string; chatId?: string; title: string } | null = null;
// 方案 B Stage 1：阅读与每个会议各持独立 SurfaceContext。readerCtx=主阅读实例（initNavShell 捕获 boot context）；
// meetingCtx=当前会议实例（进会议新建、退会议释放）。进/退 = setActiveContext 切换激活实例（取代旧 savedReaderDoc 存档恢复）。
let readerCtx: SurfaceContext | null = null;
let meetingCtx: SurfaceContext | null = null;

/** 进入会议 = 直达画板（不经详情页）。方案B：会议持独立实例 meetingCtx，切过去渲染空白手写页；挂右侧资料栏。
 *  主阅读实例 readerCtx 原封不动（不再被覆写）→ 退会议切回即瞬时复原、不重新 decode。 */
async function enterMeeting(mtgId: string): Promise<void> {
  const m = await getMeeting(mtgId);
  if (!m) return;
  const ws = await getWorkspace(m.workspace_id);
  if (m.status !== 'live' || !m.started_at) await updateMeeting(mtgId, { status: 'live', started_at: m.started_at ?? new Date().toISOString() }); // 时间脊原点
  mtgMode = { meetingId: mtgId, wsId: m.workspace_id, chatId: ws?.feishu_chat_id, title: m.title };
  // 每次进会议新建会议实例（白板/资料笔迹都在账本，renderBlankSurface 从账本重建 → 无损）。
  meetingCtx = new SurfaceContext('mtg_' + mtgId, 'meeting');
  host.go('reader');
  setActiveContext(meetingCtx);                    // 切到会议实例（fresh：pdf=null → context:switched 不触发异步重渲，无竞态）
  renderBlankSurface('mtgboard_' + mtgId, m.title); // 写入 meetingCtx → document:loaded → 重绘白板 + 还原本会议墨迹
  await mountMtgSide();
}

/** 退出会议：拆资料栏 + 切回主阅读实例（瞬时复原，不重新 decode）+ 回到该群会议列表。 */
async function exitMeeting(): Promise<void> {
  const wsId = mtgMode?.wsId;
  mtgMode = null;
  meetingCtx = null; // 释放会议实例（笔迹已在账本，下次进会议重建）
  document.getElementById('mtg-side')?.remove();
  document.getElementById('mtg-exit')?.remove();
  if (readerCtx) setActiveContext(readerCtx); // 切回主阅读实例 → context:switched：pdf 还在则 renderPage 瞬时复原；无书则回空屏
  if (wsId) mtgView = { level: 'workspace', wsId };
  host.go('meeting');
}

/** 一张群资料预览卡。HTML→点开转成可标注 PDF 进画板读写；其它→新标签下载查看。 */
function mtgSideCard(f: FeishuMsg): string {
  const name = f.msg_type === 'image' ? '［图片］' : (f.file_name || '文件');
  const time = esc(fmtMs(f.create_time));
  if (isConvertible(f)) {
    const docId = `mtgdoc_${mtgMode?.meetingId ?? 'x'}_${f.message_id}`;
    return `<button class="mtg-side-card" data-doc="${esc(docId)}" data-name="${esc(name)}" data-conv="${esc(convertedPdfUrl(f))}" title="打开批注：${esc(name)}">`
      + `<span class="mtg-side-thumb">${icon('file')}</span>`
      + `<span class="mtg-side-main"><span class="mtg-side-name">${esc(name)}</span><span class="mtg-side-time">${time} · 可批注</span></span></button>`;
  }
  return `<a class="mtg-side-card" href="${esc(feishuFileUrl(f))}" target="_blank" rel="noopener" title="${esc(name)}">`
    + `<span class="mtg-side-thumb">${icon('file')}</span>`
    + `<span class="mtg-side-main"><span class="mtg-side-name">${esc(name)}</span><span class="mtg-side-time">${time}</span></span></a>`;
}

/** 点会中侧栏 HTML 资料：转成 PDF 进阅读器读写。docId 稳定 → 落库免重转、标注归它。 */
async function openMtgMaterial(btn: HTMLElement): Promise<void> {
  const doc = btn.dataset.doc, conv = btn.dataset.conv, name = btn.dataset.name || '资料';
  if (!doc || !conv) return;
  const nameEl = btn.querySelector('.mtg-side-name');
  const orig = nameEl?.textContent ?? '';
  if (nameEl) nameEl.textContent = '转换中…';
  btn.classList.add('loading');
  try { await openPdfFromUrl(doc, name, conv); }
  catch (e) { window.alert('转换/打开失败：' + ((e as Error)?.message || e)); }
  finally { if (nameEl) nameEl.textContent = orig; btn.classList.remove('loading'); }
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
  // 顶上「空白笔记页」回到画板；下面是群资料（HTML 可点开批注）
  const blank = `<button class="mtg-side-card mtg-side-blank" id="mtg-side-blank" title="回到空白手写页"><span class="mtg-side-thumb">${icon('pen')}</span><span class="mtg-side-main"><span class="mtg-side-name">空白笔记页</span><span class="mtg-side-time">画板</span></span></button>`;
  body.innerHTML = blank + (files.length ? files.map(mtgSideCard).join('') : `<p class="mtg-side-empty">群里近期没有文件。</p>`);
  body.querySelector('#mtg-side-blank')?.addEventListener('click', () => { if (mtgMode) renderBlankSurface('mtgboard_' + mtgMode.meetingId, mtgMode.title); });
  body.querySelectorAll<HTMLElement>('.mtg-side-card[data-conv]').forEach((b) => b.addEventListener('click', () => { void openMtgMaterial(b); }));
}

/** 换页时联动会中浮层：只在阅读页 + 会中模式显示资料栏/退出钮。 */
export function syncMtgChrome(): void {
  const on = host.activePage() === 'reader' && !!mtgMode;
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
    host.go('reader');
    void reopenBook(doc, btn.dataset.name || '');
  }));
}

/** 会议页入口：按 mtgView 分发到三级。 */
export function renderMeeting(c: HTMLDivElement): void {
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
  body.querySelector('#mtg-fs-connect')?.addEventListener('click', () => { window.open(apiUrl(FEISHU_PROXY + '/api/feishu/oauth/login'), '_blank', 'noopener'); });
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
            const name = img ? '［图片］' : (f.file_name || '文件');
            const url = feishuFileUrl(f);
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
