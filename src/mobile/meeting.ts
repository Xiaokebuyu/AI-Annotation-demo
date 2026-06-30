/**
 * 移动版（电纸屏）会议 controller —— 复用 web 同一批 store/feishu/引擎数据，换 mobile.html 的黑白 markup。
 * 不 import 桌面 features/meeting/meeting.ts（那套绑 #app-pages / .mtg-* 桌面类 / host.go 导航壳，移动版用不上）。
 *
 * 四级视图（body[data-mtg]）：home 日程聚合 → ws 群会议三桶 → detail 四区块 → live 会中工作台。
 * 会中白板：渲染器是单画布深单例，故进会议时把 #stage-wrap 物理搬进 #mtg-stage-host（renderer 持元素引用、搬动后照常），
 * 退会议搬回 #rv-new；新建 meetingCtx + setActiveContext + renderBlankSurface('mtgboard_<id>')，标注落本会议白板账本。
 */
import { bus, state, settings, setActiveContext, getActiveContext } from '../app/state';
import { SurfaceContext } from '../app/surface-context';
import { renderBlankSurface, renderBlankPage, reopenBook, openPdfFromUrl } from '../surface/renderer';
import { redrawInk } from '../capture/ink';
import { flushRegion } from '../app/annotation-loop';
import { flushBedrock } from '../local/bedrock-recorder';
import { createPager, mountPagerBar, type Pager, type PagerBar } from '../surface/virtual-pager';
import {
  listWorkspaces, listAllMeetings, getWorkspace, listMeetings,
  createMeeting, getMeeting, updateMeeting, getFoldedMarks, getFoldedMarksByContext, listBooks, upsertFeishuWorkspace, startSimMeeting,
  createDiaryDoc, renameDiary, setActiveDoc, setLastReadPage, getDoc, upsertPanelWorkspace,
} from '../local/store';
import { esc } from '../core/escape';
import { infoSheet, formSheet, pickSheet } from './sheet';
import { renderRecapCard, wireRecapCard, loadRecapView, summarizeMeeting, resetRecapView, recapHandleBack, refreshPanelSummaryCache } from './meeting-recap';
import type { MeetingStatus, PersistedMeeting, PersistedWorkspace, PersistedDoc, PersistedMark } from '../core/store-format';
import { pollPanelMeetingEvents, listActivePanelMeetings, type PanelFeishuMeeting, type PanelMeetingEvent } from '../integration/panel-feishu/client';
import { syncMeetingGroupMaterials } from '../features/meeting/feishu-materials';

// ── 飞书后端（feishu-service）+ 文档转换（convert-service）：同 web 默认端口；服务不在则静默退回纯本地 ──
const FEISHU_BASE = ((import.meta.env.VITE_FEISHU_BASE_URL as string | undefined) ?? 'http://localhost:4321').replace(/\/+$/, '');
const CONVERT_BASE = ((import.meta.env.VITE_CONVERT_BASE_URL as string | undefined) ?? 'http://localhost:4330').replace(/\/+$/, '');
async function feishuGet<T>(path: string): Promise<T | null> {
  try { const r = await fetch(FEISHU_BASE + path); return r.ok ? (await r.json() as T) : null; }
  catch { return null; }
}

interface FeishuMsg { message_id: string; msg_type: string; sender_id?: string; create_time?: string; text?: string; file_name?: string; file_key?: string; image_key?: string; }
interface FeishuEvent { event_id: string; summary?: string; start_time?: { timestamp?: string; date?: string }; end_time?: { timestamp?: string }; recurring?: boolean; has_meeting?: boolean; vchat?: { meeting_url?: string; vc_type?: string } | null }
const isConvertible = (f: FeishuMsg): boolean => f.msg_type === 'file' && /\.html?$/i.test(f.file_name || '');
function feishuFileUrl(f: FeishuMsg): string {
  const img = f.msg_type === 'image';
  const key = img ? f.image_key : f.file_key;
  const name = img ? '［图片］' : (f.file_name || '文件');
  return `${FEISHU_BASE}/api/feishu/messages/${encodeURIComponent(f.message_id)}/file/${encodeURIComponent(key || '')}?type=${img ? 'image' : 'file'}&name=${encodeURIComponent(name)}`;
}
const convertedPdfUrl = (f: FeishuMsg): string => `${CONVERT_BASE}/convert/to-pdf?url=${encodeURIComponent(feishuFileUrl(f))}`;

// ── 时间/格式 ──
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const fsEventWhen = (e: FeishuEvent): number => {
  const ts = e.start_time?.timestamp;
  if (ts) return Number(ts) * 1000;
  const d = e.start_time?.date;
  return d ? new Date(d.replace(/-/g, '/')).getTime() : 0;
};
function fsDayLabel(ms: number): string {
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const d0 = new Date(ms); d0.setHours(0, 0, 0, 0);
  const diff = Math.round((d0.getTime() - t0.getTime()) / 86400000);
  const rel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : '';
  const d = new Date(ms);
  const base = `${d.getMonth() + 1}/${d.getDate()} ${WD[d.getDay()]}`;
  return rel ? `${rel} · ${base}` : base;
}
const fsHHMM = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const fmtMs = (ms?: string): string => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? fmtDateTime(new Date(n).toISOString()) : ''; };
const fmtDateTime = (iso: string): string => {
  try { return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return iso; }
};
function parseWhen(s: string): string {
  const t = s.trim();
  if (!t) return new Date().toISOString();
  const d = new Date(t.replace(/-/g, '/'));
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}
const clk = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

// ── 内联 SVG（mobile 黑白线性）──
const SVG_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/></svg>';
const SVG_IMG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 14l4-3 4 3 4-4 4 3"/></svg>';
const SVG_GO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const SVG_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>';
const SVG_USERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-1a4 4 0 0 1 4-4H10"/><path d="M15 5.2a3 3 0 0 1 0 5.6"/><path d="M14 14h.5a4 4 0 0 1 4 4v1"/></svg>';
const SVG_PEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l.8-3.2L16.2 5.4a2 2 0 0 1 2.8 0l-.4-.4a2 2 0 0 1 0 2.8L7.2 19.2 4 20z"/></svg>';

const ST: Record<MeetingStatus, [string, string]> = { live: ['live', '进行中'], upcoming: ['up', '待开始'], ended: ['end', '已结束'] };
const stBadge = (s: MeetingStatus): string => `<span class="st ${ST[s][0]}"><span class="d"></span>${ST[s][1]}</span>`;

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// ── controller 内部状态 ──
let mv: { wsId?: string; mtgId?: string } = {};
let readerCtx: SurfaceContext;
// 会中
let meetingCtx: SurfaceContext | null = null;
let liveMtg: { id: string; title: string; chatId?: string; startedAt: number; frozenAt: number } | null = null;
let clockTimer = 0;
let prevGesture = true;
let liveMarkCount = 0;
let liveNoteDoc: PersistedDoc | null = null;            // 当前会议手记 doc（=会中白板物化成的 diary doc）
// 会中基岩 lease（三个模块级标志·能跨 visibility 抖动存活）：
let bedrockLeased = false;        // 当前持租约（防切后台再切回时重复 start）
let bedrockAutoEnabled = false;   // 本次租约是我们替它开的 → 退出/收租要还原成关
let bedrockUserOverride = false;  // 本场会议里用户手动设过 bedrock → 续租/退出都别动它（每场 enterMeeting 重置）
const RULED = { ruledLines: false } as const;            // 同日记：引擎不画线，稿纸线走 CSS 叠层 #diary-lines
const noteIdOf = (mtgId: string): string => 'mtgboard_' + mtgId; // 会议手记 doc id = 既有白板 marks 的 document_id（零迁移·createDiaryDoc 幂等）

function setMtg(view: 'home' | 'ws' | 'detail' | 'live' | 'recap'): void {
  document.body.dataset.mtg = view;
  document.body.classList.toggle('writable', view === 'live'); // 会中白板=可写（露工具格子）
}

// 会议各视图（mview）每次 render 重建 innerHTML（含 .mbody）→ scroll 容器被换掉，
// 故每次渲染末尾给新 .mbody 建一个新 pager（先销毁旧的断 observer）；bar 挂到 mview，下次 innerHTML 自然清掉旧 bar。
const mtgPagers = new Map<string, Pager>();
function pageMbody(viewEl: HTMLElement, key: string, land: 'first' | 'keep' = 'first'): void {
  mtgPagers.get(key)?.destroy();
  const sc = viewEl.querySelector<HTMLElement>('.mbody');
  if (!sc) { mtgPagers.delete(key); return; }
  let bar: PagerBar | undefined;
  const pager = createPager(sc, { onChange: (i) => bar?.update(i) });
  bar = mountPagerBar(pager, viewEl);
  pager.relayout(land);
  mtgPagers.set(key, pager);
}

// ════ L1：panel 飞书会议同步（VC all_meeting_started/ended → 本地会议·带真 t0）════
const PANEL_CURSOR_KEY = 'inkloop.panelMeeting.cursor.v1';
const panelUpserts = new Map<string, Promise<void>>(); // 按 meeting_id 串行·防 events+active 并发同一会议重复建
type PanelMeetingUpsertType = 'started' | 'ended' | 'metadata'; // metadata=minute_bound/summary_ready 带来的元数据更新·不改 status/时间

/** 事件内嵌会议上的当前妙记 token（顶层 minute_token 优先·回退 match.minute_token）。 */
function panelMinuteToken(mt: PanelFeishuMeeting): string | null {
  return mt.minute_token || mt.match?.minute_token || null;
}
async function findLocalPanelMeeting(panelMeetingId: string): Promise<PersistedMeeting | null> {
  return (await listAllMeetings()).find((x) => x.feishu_meeting_id === panelMeetingId) ?? null;
}

/** panel 会议 → 落成本地会议。靠 feishu_meeting_id 幂等去重·同一 meeting_id 串行（防并发重复建）。本地写失败会抛 → 上层不推 cursor。 */
async function upsertPanelMeeting(mt: PanelFeishuMeeting, type: PanelMeetingUpsertType): Promise<void> {
  if (!mt.meeting_id) return;
  const key = mt.meeting_id;
  const prev = panelUpserts.get(key) ?? Promise.resolve();
  const job = prev.catch(() => {}).then(() => upsertPanelMeetingInner(mt, type)).finally(() => {
    if (panelUpserts.get(key) === job) panelUpserts.delete(key);
  });
  panelUpserts.set(key, job);
  await job;
}

async function upsertPanelMeetingInner(mt: PanelFeishuMeeting, type: PanelMeetingUpsertType): Promise<void> {
  const existing = await findLocalPanelMeeting(mt.meeting_id);
  const existingWs = existing ? await getWorkspace(existing.workspace_id) : null;
  // C：start_time 缺失时**不伪装成真会议 t0**——优先已存真 t0，否则只拿同步时刻占位（不标 vc_event）。
  const hasRealStart = typeof mt.start_time === 'number' && Number.isFinite(mt.start_time);
  const realT0 = hasRealStart ? mt.start_time! : (typeof existing?.vc_meeting_start_t0 === 'number' ? existing.vc_meeting_start_t0 : 0);
  const startMs = realT0 || Date.now();
  // 无真 t0 时不覆盖已有时间（metadata 事件常无 start_time·别把时间刷成同步时刻）。
  const startIso = realT0 ? new Date(startMs).toISOString() : (existing?.started_at || existing?.scheduled_at || new Date(startMs).toISOString());
  const endMs = typeof mt.end_time === 'number' && mt.end_time > 0 ? mt.end_time : 0;
  // B：无 group_ids 不建飞书伪群（renderWs 拉 members 必失败），落 manual「飞书会议」桶；已在真群则复用。
  const ws = mt.group_ids?.[0]
    ? await upsertFeishuWorkspace(mt.group_ids[0], mt.topic || existingWs?.name || '飞书会议')
    : (existingWs && existingWs.source === 'feishu' ? existingWs : await upsertPanelWorkspace('飞书会议'));
  const base = existing ?? await createMeeting(ws.workspace_id, { title: mt.topic || '飞书会议', scheduled_at: startIso });
  const ended = type === 'ended' || endMs > 0;
  // metadata 事件不改既有 status（minute_bound/summary_ready 不该把已结束会议刷回 live、或反之）。
  const nextStatus: MeetingStatus = type === 'metadata' && existing ? existing.status : ended ? 'ended' : 'live';
  const minuteToken = panelMinuteToken(mt);
  const saved = await updateMeeting(base.meeting_id, {
    workspace_id: ws.workspace_id,                 // 迁移到正确 workspace（无群→manual·后续拿到真群→迁真群）
    title: mt.topic || base.title,
    scheduled_at: startIso,
    status: nextStatus,
    started_at: startIso,
    ...(endMs ? { ended_at: new Date(endMs).toISOString() } : {}),
    feishu_meeting_id: mt.meeting_id,
    feishu_meeting_no: mt.meeting_no,
    feishu_topic: mt.topic,
    // C：只有真 start_time（或已存真 t0）才标 vc_event；否则 t0 是同步兜底·诚实标 uncalibrated·不假装精确。
    ...(realT0
      ? { vc_meeting_start_t0: realT0, t0_source: 'vc_event', align_state: 'event', panel_meeting_start: realT0 }
      : { t0_source: 'local_enter', align_state: 'uncalibrated' }),
    ...(minuteToken ? { feishu_minute_token: minuteToken } : {}),
    ...(mt.minute_url ? { feishu_minute_url: mt.minute_url } : {}),
  });
  if (!saved) throw new Error(`本地会议写入失败（同步 panel 会议 ${mt.meeting_id}）`); // 写失败 → 上层不推 cursor·下次重放
  // 正在会中这场 → 热更 t0（仅当有真 t0·事件迟到/补发时不丢时间脊基准）
  if (liveMtg && liveMtg.id === base.meeting_id && realT0) {
    liveMtg.startedAt = realT0;
    startClock();
    void refreshSpine();
  }
}

/** minute_bound：把妙记 token 写回本地会议（解锁转写对轴）。缺 token=数据问题·跳过不堵流；本地写失败=抛·不推 cursor。 */
async function applyPanelMinuteBound(mt: PanelFeishuMeeting): Promise<void> {
  if (!mt.meeting_id) return;
  if (!panelMinuteToken(mt)) { console.warn('[panel] minute_bound 缺 token·跳过', mt.meeting_id); return; }
  await upsertPanelMeeting(mt, 'metadata');
}

/** summary_ready：写回元数据后按 meeting_id 拉 panel 总结缓存。拉总结失败=best-effort 吞掉（下次进 recap 再拉）；本地会议写失败=抛·不推 cursor。 */
async function applyPanelSummaryReady(mt: PanelFeishuMeeting): Promise<void> {
  if (!mt.meeting_id) return;
  await upsertPanelMeeting(mt, 'metadata'); // 写会议元数据·失败抛
  const local = await findLocalPanelMeeting(mt.meeting_id);
  if (!local) return;
  const prevAt = local.panel_summary?.generated_at ?? 0;
  try {
    const r = await refreshPanelSummaryCache(local);
    // 后台到达「更新的」总结 → 标未读（home/detail 提醒·进 recap 时清）。重放同一份 generated_at 不变 → 不重复标。
    if (r.summary && r.summary.generated_at > prevAt) await updateMeeting(local.meeting_id, { panel_summary_unread: true });
  } catch (e) { console.warn('[panel] summary_ready 拉总结失败（进 recap 时再拉）：', e); }
}

/** 分发一条 panel 事件。未知类型忽略（向前兼容）。本地写失败冒泡 → syncPanelMeetings 中断 → 不推 cursor → 下次重放。 */
async function consumePanelMeetingEvent(ev: PanelMeetingEvent): Promise<void> {
  switch (ev.type) {
    case 'started':
    case 'ended': await upsertPanelMeeting(ev.meeting, ev.type); return;
    case 'minute_bound': await applyPanelMinuteBound(ev.meeting); return;
    case 'summary_ready': await applyPanelSummaryReady(ev.meeting); return;
    default: return;
  }
}

/** 拉 panel 增量会议事件 + 进行中快照，落成本地会议。失败静默（不阻断 home·退回纯本地）。 */
async function syncPanelMeetings(): Promise<void> {
  const since = Number(localStorage.getItem(PANEL_CURSOR_KEY) || 0) || 0;
  const feed = await pollPanelMeetingEvents(since);
  // 逐条消费·任一条本地写失败即抛 → 中断循环 → 不推 cursor → 下次重放（不静默丢同步）。
  for (const ev of feed.events) await consumePanelMeetingEvent(ev);
  if (feed.cursor && feed.cursor !== since) localStorage.setItem(PANEL_CURSOR_KEY, String(feed.cursor));
  // 无 cursor / 迟到打开：补进行中会议（active·12h 内未结束）
  for (const mt of await listActivePanelMeetings()) await upsertPanelMeeting(mt, 'started');
}

// ════ home：日程时间线 + 群聊书架 ════
async function renderHome(): Promise<void> {
  await syncPanelMeetings().catch(() => {}); // L1：先把 panel 飞书会议拉成本地会议，再聚合渲染
  // 飞书群 → 幂等同步成工作区
  const wsRes = await feishuGet<{ workspaces: Array<{ chat_id: string; name: string; chat_status: string }> }>('/api/feishu/workspaces');
  if (wsRes) for (const w of wsRes.workspaces || []) if (w.chat_status === 'normal') await upsertFeishuWorkspace(w.chat_id, w.name);
  // 飞书日历
  let fsEvents: FeishuEvent[] = [];
  const oauth = await feishuGet<{ connected: boolean }>('/api/feishu/oauth/status');
  const fsConnected = !!oauth?.connected;
  if (fsConnected) {
    const ev = await feishuGet<{ events: FeishuEvent[] }>('/api/feishu/my/events');
    fsEvents = (ev?.events || []).slice().sort((a, b) => fsEventWhen(a) - fsEventWhen(b));
  }
  const [workspaces, allMeetings] = await Promise.all([listWorkspaces(), listAllMeetings()]);
  const wsName = new Map(workspaces.map((w) => [w.workspace_id, w.name]));
  const count = new Map<string, number>();
  for (const m of allMeetings) count.set(m.workspace_id, (count.get(m.workspace_id) ?? 0) + 1);
  const sched = allMeetings.filter((m) => m.status !== 'ended').sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''));

  const fsOk = fsConnected
    ? `<span class="fs-ok"><span class="d"></span>飞书已连${fsEvents.length ? ` · ${fsEvents.length} 条` : ''}</span>`
    : '';
  const tl = timeline(fsEvents);
  // #1 会后总结可感知：summary_ready 后台到达的总结标了 panel_summary_unread → home 顶部提醒。
  const unread = allMeetings.filter((m) => m.panel_summary_unread);
  const unreadBar = unread.length
    ? `<button class="hbtn" id="mh-unread" style="display:block;width:calc(100% - 36px);margin:10px 18px 0;text-align:left;font-weight:600">📋 ${unread.length} 场会议总结已同步 · 点开看 ›</button>`
    : '';
  const schedRows = sched.map((m) => mrow(m, wsName.get(m.workspace_id))).join('')
    || (tl ? '' : `<p class="empty">还没接飞书日历，本地也没有会议。飞书群同步后，会在群聊书架里出现。</p>`);
  const wsGrid = workspaces.length
    ? `<div class="ws-grid">${workspaces.map((w) => wsCard(w, count.get(w.workspace_id) ?? 0)).join('')}</div>`
    : `<p class="empty">还没有群聊。机器人所在的飞书群会自动同步进来。</p>`;

  el('mv-home').innerHTML =
    `<div class="vhead"><h1>会议</h1><span class="cnt">${workspaces.length} 群 · ${allMeetings.length} 场</span><span class="sp"></span>`
    + `<button class="hbtn" id="mh-sim">模拟会议</button></div>`
    + `<div class="mbody">${unreadBar}`
    + `<section class="msec"><div class="msec-h"><span class="mt">会议日程</span><span class="mb">飞书 + 本地 · 待开始/进行中</span>${fsOk}</div>${tl}${schedRows}</section>`
    + `<section class="msec"><div class="msec-h"><span class="mt">群聊书架</span><span class="mb">以群聊为单位</span></div>${wsGrid}</section>`
    + `</div>`;

  el('mv-home').querySelector('#mh-sim')?.addEventListener('click', async () => {
    const m = await startSimMeeting();
    if (!m) { await infoSheet({ title: '模拟会议', message: '先连一个飞书群（机器人所在群会自动同步成工作区）再开模拟会议。' }); return; }
    mv = { wsId: m.workspace_id, mtgId: m.meeting_id }; setMtg('detail'); void renderDetail();
  });
  el('mv-home').querySelector('#mh-unread')?.addEventListener('click', () => { // 跳第一场有新总结的会议详情（其会后记录卡标「新总结」）
    const first = unread[0];
    if (!first) return;
    mv = { wsId: first.workspace_id, mtgId: first.meeting_id }; setMtg('detail'); void renderDetail();
  });
  el('mv-home').querySelectorAll<HTMLElement>('.ws-card[data-ws]').forEach((c) => c.addEventListener('click', () => { mv = { wsId: c.dataset.ws }; setMtg('ws'); void renderWs(); }));
  wireRows(el('mv-home'));
  pageMbody(el('mv-home'), 'home');
}

function timeline(events: FeishuEvent[]): string {
  if (!events.length) return '';
  const today = fsDayLabel(Date.now()).split(' · ').pop() || '';
  const cards = events.slice(0, 6).map((e) => {
    const ms = fsEventWhen(e);
    const badge = e.has_meeting ? '📹 会议' : (e.recurring ? '每周' : '单次'); // L2：区分视频会议日程 vs 普通日程
    return `<div class="tl-card${e.has_meeting ? ' tl-meet' : ''}"><div class="d">${esc(fsDayLabel(ms))}</div><div class="t">${esc(fsHHMM(ms))}</div><div class="n">${esc(e.summary || '(无标题日程)')}</div><span class="bd">${badge}</span></div>`;
  }).join('');
  const more = events.length > 6 ? `<div class="tl-more">还有 ${events.length - 6} 场 ›</div>` : '';
  return `<div class="tl"><div class="tl-now"><span class="d"></span><span class="l">今天<br>${esc(today)}</span></div>${cards}${more}</div>`;
}
function mrow(m: PersistedMeeting, wsLabel?: string): string {
  return `<button class="mrow" data-mtgid="${esc(m.meeting_id)}" data-wsid="${esc(m.workspace_id)}">${stBadge(m.status)}`
    + `<span class="mc"><span class="mt">${esc(m.title)}</span><span class="mm">${esc(fmtDateTime(m.scheduled_at))}${wsLabel ? ` · ${esc(wsLabel)}` : ''}</span></span>`
    + `<span class="go">${SVG_GO}</span></button>`;
}
function wsCard(w: PersistedWorkspace, n: number): string {
  return `<div class="ws-card" data-ws="${esc(w.workspace_id)}"><div class="ico">${SVG_USERS}</div>`
    + `<div class="wn">${esc(w.name)}${w.source === 'feishu' ? ' <span class="fs">飞书</span>' : ''}</div><div class="wm">${n} 场会议</div></div>`;
}
/** 会议行点击 → 进详情。 */
function wireRows(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.mrow[data-mtgid]').forEach((b) => b.addEventListener('click', () => {
    mv = { wsId: b.dataset.wsid, mtgId: b.dataset.mtgid }; setMtg('detail'); void renderDetail();
  }));
}

// ════ ws：一个群聊的会议（参会人 + 群动态 + 三桶）════
async function renderWs(): Promise<void> {
  const ws = mv.wsId ? await getWorkspace(mv.wsId) : null;
  if (!ws) { setMtg('home'); void renderHome(); return; }
  const meetings = await listMeetings(ws.workspace_id);
  let membersHtml = '', feedHtml = '';
  if (ws.source === 'feishu' && ws.feishu_chat_id) {
    const cid = ws.feishu_chat_id;
    const [mem, msg] = await Promise.all([
      feishuGet<{ total: number; members: Array<{ open_id: string; name: string }> }>(`/api/feishu/workspaces/${cid}/members`),
      feishuGet<{ messages: FeishuMsg[] }>(`/api/feishu/workspaces/${cid}/messages?limit=30`),
    ]);
    if (mem) {
      membersHtml = `<section class="msec"><div class="msec-h"><span class="mt">参会人</span><span class="mb">${mem.total} 人 · 飞书群成员</span></div>`
        + `<div class="chips">${mem.members.map((p) => `<span class="chip">${esc(p.name)}</span>`).join('')}</div></section>`;
      feedHtml = feed(msg?.messages || [], new Map(mem.members.map((p) => [p.open_id, p.name])));
    } else {
      membersHtml = `<section class="msec"><div class="msec-h"><span class="mt">参会人</span></div><p class="empty">加载失败（feishu-service 未运行 / 权限不足？）</p></section>`;
    }
  }
  const buckets: Array<[MeetingStatus, string]> = [['live', '进行中'], ['upcoming', '待开始'], ['ended', '已结束']];
  const secs = buckets.map(([st, label]) => {
    const ms = meetings.filter((m) => m.status === st);
    return ms.length ? `<section class="msec"><div class="msec-h"><span class="mt">${label}</span><span class="mb">${ms.length}</span></div>${ms.map((m) => mrow(m)).join('')}</section>` : '';
  }).join('') || `<p class="empty" style="padding:16px 18px">这个群聊还没有会议。可以点右上「+ 新建会议」先建一场本地会议。</p>`;

  el('mv-ws').innerHTML =
    `<div class="mtop"><span class="bk" data-back="home">${SVG_BACK}</span><span class="ti">${esc(ws.name)}</span><span class="sp"></span><button class="hbtn" id="mw-new">+ 新建会议</button></div>`
    + `<div class="mbody">${membersHtml}${feedHtml}${secs}</div>`;
  el('mv-ws').querySelector('#mw-new')?.addEventListener('click', async () => {
    const form = await formSheet({
      title: '新建会议',
      fields: [
        { key: 'title', label: '会议标题', placeholder: '如 架构评审 v4' },
        { key: 'when', label: '计划时间', placeholder: '如 2026-06-28 14:30，留空=现在' },
      ],
      confirm: '创建',
    });
    if (!form || !form.title) return;
    await createMeeting(ws.workspace_id, { title: form.title, scheduled_at: parseWhen(form.when) }); void renderWs();
  });
  wireBack(el('mv-ws')); wireRows(el('mv-ws'));
  pageMbody(el('mv-ws'), 'ws');
}
function feed(msgs: FeishuMsg[], nameOf: Map<string, string>): string {
  if (!msgs.length) return '';
  const assetN = msgs.filter((m) => m.msg_type === 'file' || m.msg_type === 'image').length;
  const rows = msgs.map((m) => {
    const who = m.sender_id ? (nameOf.get(m.sender_id) || (m.sender_id.startsWith('cli_') ? '机器人' : '成员')) : '系统';
    let body = '', asset = false;
    if (m.msg_type === 'text') body = m.text || '';
    else if (m.msg_type === 'image') { body = '［图片］'; asset = true; }
    else if (m.msg_type === 'file') { body = '［文件］' + (m.file_name || ''); asset = true; }
    else if (m.msg_type === 'interactive') body = '［卡片］';
    else if (m.msg_type === 'system') body = '［系统消息］';
    else body = `［${m.msg_type}］`;
    return `<div class="fitem"><span class="fs-n">${esc(who)}</span><span class="fb${asset ? ' mat' : ''}">${esc(body)}${asset ? '<span class="matbadge">资料</span>' : ''}</span><span class="ft">${esc(fmtMs(m.create_time))}</span></div>`;
  }).join('');
  return `<section class="msec"><div class="msec-h"><span class="mt">群动态</span><span class="mb">近 ${msgs.length} 条${assetN ? ` · ${assetN} 资料` : ''}</span></div><div class="feed">${rows}</div></section>`;
}

// ════ detail：四区块 + 动作 ════
async function renderDetail(): Promise<void> {
  const m = mv.mtgId ? await getMeeting(mv.mtgId) : null;
  if (!m) { setMtg('home'); void renderHome(); return; }
  const books = await listBooks();
  const bookMap = new Map(books.map((b) => [b.document_id, b]));
  const mats = m.material_doc_ids.map((id) => bookMap.get(id)).filter((b): b is PersistedDoc => !!b);
  // 资料上的「本场会议手写档案」按 context_id 过滤（与 recap/AI 一致·别混入同一资料在别场会议/阅读态的笔）
  const mtgCtx = 'mtg_' + m.meeting_id;
  const markLists = await Promise.all(mats.map((b) => getFoldedMarks(b.document_id).then((ms) => ms.filter((mk) => mk.context_id === mtgCtx))));
  const ws = await getWorkspace(m.workspace_id);
  // 进会议详情自动抓群文件 → 转 PDF → 入资料书架（幂等去重·后台不阻塞渲染·有新增则重渲）。
  if (ws?.source === 'feishu' && ws.feishu_chat_id) {
    void syncMeetingGroupMaterials({ meetingId: m.meeting_id, chatId: ws.feishu_chat_id, feishuBase: FEISHU_BASE, convertBase: CONVERT_BASE })
      .then((r) => { if (r.changed && mv.mtgId === m.meeting_id) void renderDetail(); });
  }
  // 会议手记（白板物化的 diary doc）：列进手写档案区·点击=进会议回到手记
  const noteId = noteIdOf(m.meeting_id);
  const [noteDoc, noteMarks] = await Promise.all([getDoc(noteId), getFoldedMarks(noteId)]);
  const noteArchiveHtml = (noteDoc || noteMarks.length)
    ? `<div class="matcard" data-note="1"><span class="ic">${SVG_PEN}</span><div><div class="nm">${esc(noteDoc?.filename || m.title + ' 手记')}</div><div class="mt">${noteDoc?.page_count || 1} 页 · ${noteMarks.length} 笔 · 会议手记</div></div></div>`
    : '';

  // 群里收集到的资料（飞书）
  let groupSec = '';
  if (ws?.source === 'feishu' && ws.feishu_chat_id) {
    const res = await feishuGet<{ messages: FeishuMsg[] }>(`/api/feishu/workspaces/${ws.feishu_chat_id}/messages?limit=50`);
    const fileMsgs = (res?.messages || []).filter((x) => (x.msg_type === 'file' && x.file_key) || (x.msg_type === 'image' && x.image_key));
    const cards = fileMsgs.map((f) => {
      const img = f.msg_type === 'image';
      const name = img ? '［图片］' : (f.file_name || '文件');
      if (isConvertible(f)) {
        return `<div class="matcard" data-conv="${esc(convertedPdfUrl(f))}" data-docid="mtgdoc_${esc(m.meeting_id)}_${esc(f.message_id)}" data-name="${esc(name)}"><span class="ic">${SVG_FILE}</span><div><div class="nm">${esc(name)}</div><div class="mt">群文件 · ${esc(fmtMs(f.create_time))} · 可批注</div></div></div>`;
      }
      return `<a class="matcard" href="${esc(feishuFileUrl(f))}" target="_blank" rel="noopener"><span class="ic">${img ? SVG_IMG : SVG_FILE}</span><div><div class="nm">${esc(name)}</div><div class="mt">群文件 · ${esc(fmtMs(f.create_time))}</div></div></a>`;
    }).join('') || `<p class="empty">群里近期没有文件。</p>`;
    groupSec = `<section class="msec"><div class="msec-h"><span class="mt">群里收集到的资料</span><span class="mb">机器人捞 · ${esc(ws.name)}</span></div>${res ? cards : '<p class="empty">拉取群资料失败（feishu-service 未运行？）</p>'}</section>`;
  }

  const filesHtml = mats.length
    ? mats.map((b) => `<div class="matcard" data-docid="${esc(b.document_id)}" data-name="${esc(b.filename)}"><span class="ic">${SVG_FILE}</span><div><div class="nm">${esc(b.filename || '(未命名)')}</div><div class="mt">${b.page_count} 页 · 借阅读器打开</div></div></div>`).join('')
    : `<p class="empty">还没有资料。点右上「+ 添加资料」从已导入的 PDF 里挑。</p>`;
  const matsArchiveHtml = mats.length
    ? mats.map((b, i) => {
        const hand = markLists[i].filter((mk) => mk.feature_type === 'handwriting').length;
        return `<div class="matcard" data-docid="${esc(b.document_id)}" data-name="${esc(b.filename)}"><span class="ic">${SVG_PEN}</span><div><div class="nm">${esc(b.filename || '(未命名)')}</div><div class="mt">${markLists[i].length} 处标注 · 手写 ${hand}</div></div></div>`;
      }).join('')
    : '';
  const archiveHtml = (noteArchiveHtml + matsArchiveHtml)
    || `<div class="empty">${m.status === 'ended' ? '本场会议没有留下手写档案。' : '会议进行 / 结束后，你在手记与资料上的手写会汇总在这里。'}</div>`;
  // 旧总结陈旧：summary 是基于和当前不同的关联(minute_token)生成的 → 明示别当对应当前转写（防 #2 误导）
  const summaryStale = !!(m.summary && m.summary_source?.feishu_minute_token && m.summary_source.feishu_minute_token !== m.feishu_minute_token);
  const summaryHtml = m.summary
    ? `${summaryStale ? '<div class="empty" style="margin-bottom:6px">⚠ 此总结基于旧的飞书关联生成，可能不对应当前转写，建议重新生成。</div>' : ''}<div class="summary">${esc(m.summary)}</div>`
    : `<div class="empty">${m.status === 'ended' ? '还没生成思路总结。先在「会后记录」关联飞书妙记，再生成。' : '会议结束后可对手写档案做思路总结。'}</div>`;
  const sumBtnLabel = m.summary ? '重新生成' : '生成思路总结';
  // 「进入会议」即开始（enterMeeting 内置置 live + 落 started_at），故不再单列「开始会议」按钮，去职责重叠。
  const enterLabel = m.status === 'live' ? '✏ 进入会议（继续）' : m.status === 'ended' ? '✏ 回看记录' : '✏ 进入会议';
  const endBtn = m.status === 'live' ? '<button class="hbtn" id="md-end">⏹ 结束会议</button>' : '';

  el('mv-detail').innerHTML =
    `<div class="mtop"><span class="bk" data-back="ws">${SVG_BACK}</span><span class="ti">${esc(m.title)}</span>${stBadge(m.status).replace('class="st', 'style="margin-left:8px" class="st')}</div>`
    + `<div class="mbody">`
    + `<div class="dact"><button class="hbtn pri" id="md-enter">${enterLabel}</button>${endBtn}<button class="hbtn" id="md-add">+ 添加资料</button></div>`
    + `<section class="msec"><div class="msec-h"><span class="mt">可能有用的文件</span><span class="mb">${mats.length} 份</span></div>${filesHtml}</section>`
    + groupSec
    + `<section class="msec"><div class="msec-h"><span class="mt">你的手写档案</span></div>${archiveHtml}</section>`
    + (m.status === 'ended' ? renderRecapCard(m) : '')
    + `<section class="msec"><div class="msec-h"><span class="mt">思路总结</span><span class="sp" style="flex:1"></span><button class="hbtn" id="md-sum"${m.status === 'ended' ? '' : ' disabled style="opacity:.45"'}>${sumBtnLabel}</button></div>${summaryHtml}</section>`
    + `</div>`;

  if (m.status === 'ended') wireRecapCard(el('mv-detail'), m.meeting_id, () => void renderDetail(), () => void openRecap(m.meeting_id));
  el('mv-detail').querySelector('#md-enter')?.addEventListener('click', () => { void enterMeeting(m.meeting_id); });
  el('mv-detail').querySelector('#md-end')?.addEventListener('click', async () => { await updateMeeting(m.meeting_id, { status: 'ended', ended_at: new Date().toISOString() }); void renderDetail(); });
  el('mv-detail').querySelector('#md-sum')?.addEventListener('click', () => void (async () => {
    const btn = el<HTMLButtonElement>('md-sum');
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1'; btn.textContent = '生成中…'; btn.disabled = true;
    const sumEl = el('mv-detail').querySelector<HTMLElement>('.summary, .msec:last-child .empty');
    let lastPaint = 0;
    try {
      const out = await summarizeMeeting(m.meeting_id, (full) => {
        const now = Date.now();
        if (now - lastPaint < 500) return; // 电纸屏 500ms 合并刷新·防残影
        lastPaint = now;
        if (sumEl) { sumEl.className = 'summary'; sumEl.textContent = full; }
      });
      void out; void renderDetail(); // 成功/失败都重渲染：清掉半截流式残留 + 还原按钮态（失败时 summary 没落库·显回空态）
    } catch { void renderDetail(); }
  })());
  el('mv-detail').querySelector('#md-add')?.addEventListener('click', async () => {
    const avail = books.filter((b) => !m.material_doc_ids.includes(b.document_id));
    const add = await pickSheet({
      title: '添加资料',
      items: avail.map((b) => ({ id: b.document_id, label: b.filename || '(未命名)', sub: `${b.page_count} 页` })),
      empty: '没有可添加的资料。先到「阅读 · 书籍」导入 PDF。',
      confirm: '添加',
    });
    if (add && add.length) { await updateMeeting(m.meeting_id, { material_doc_ids: [...new Set([...m.material_doc_ids, ...add])] }); void renderDetail(); }
  });
  // 资料卡 → 进这场会议的工作台并开进该资料（不跳全局阅读·批注归本会议时间脊）。本地 PDF / 群 HTML 转 PDF 都由 enterMeeting→openMaterialInMeeting 处理。
  el('mv-detail').querySelectorAll<HTMLElement>('.matcard[data-docid]').forEach((card) => card.addEventListener('click', () => {
    void enterMeeting(m.meeting_id, { docId: card.dataset.docid!, name: card.dataset.name || '资料', conv: card.dataset.conv });
  }));
  el('mv-detail').querySelector<HTMLElement>('.matcard[data-note]')?.addEventListener('click', () => { void enterMeeting(m.meeting_id); }); // 会议手记卡 → 进会议回到手记白板
  wireBack(el('mv-detail'));
  pageMbody(el('mv-detail'), 'detail');
}

/** WS2-C：进「会后记录」阅读视图（纯文本·转写 + 手写档案）。返回=回 detail。 */
async function openRecap(mtgId: string): Promise<void> {
  setMtg('recap');
  // 顶栏返回：详情段视图先退回概览（recapHandleBack 处理）；已在概览才退出 recap 回 detail。
  el('recap-back').onclick = () => { if (recapHandleBack()) return; resetRecapView(); setMtg('detail'); void renderDetail(); };
  await loadRecapView(mtgId, el('recap-body'), el('recap-title'));
}

/** 会中打开资料：**不退出会议**。把 PDF 载进会中共享画布（loadIntoState 载入当前活跃 meetingCtx），
 *  时钟/时间脊照常，资料上的笔带同一 context_id='mtg_<id>' → 汇入时间脊。返回白板=点抽屉「空白笔记页」。 */
async function openMaterialInMeeting(docId: string, name: string, convUrl?: string): Promise<void> {
  const mtg = liveMtg, ctx = meetingCtx; // capture：转 PDF/解码慢时用户退会再进别场，迟到结果不能写当前 live UI
  if (!mtg) return;
  flushRegion('manual'); // 切资料前收口手记/上一面在途区域（否则刚写的笔在 6s 收口前被切走丢账）
  document.body.classList.remove('side-open'); // 收起资料抽屉
  document.body.classList.remove('mtg-note-open'); // 资料态隐手记 bar（翻页/标题是手记的，不是资料的）
  try {
    if (convUrl) await openPdfFromUrl(docId, name, convUrl);
    else await reopenBook(docId, name);
  } catch (e) { void infoSheet({ title: '打开失败', message: String((e as Error)?.message || e) }); return; }
  if (liveMtg !== mtg || getActiveContext() !== ctx) return; // 已退会/切会：不改标题、不刷脊
  el('mlive-title').textContent = name; // 顶栏显当前资料名
  void refreshSpine();
}

// ════ 会中基岩录制 lease：进 live 自动开、退出还原；只改内存不落盘（不污染日常）；尊重用户手动设定 ════
function startMeetingBedrock(): void {
  if (bedrockLeased) return;                                          // 已持租约（如从后台切回）→ 不重复
  bedrockLeased = true;
  bedrockAutoEnabled = !settings.bedrock && !bedrockUserOverride;     // 用户已手动接管则不替它开
  if (bedrockAutoEnabled) settings.bedrock = true;                    // bedrockTap 实时读此值，无需 emit/init；不 saveSettings 故重启即复默认关
}
function stopMeetingBedrock(): void {
  if (bedrockLeased && bedrockAutoEnabled && !bedrockUserOverride && settings.bedrock) settings.bedrock = false; // 只关「我们替它开的、且用户没手动接管的」；override 用模块级标志（跨 visibility 收租仍记得）
  bedrockLeased = false;
  bedrockAutoEnabled = false;
  void flushBedrock();                                               // 落库 500ms 定时缓冲（raw_ref 已写进 mark，chunk 别迟到）
}

// ════ 会议手记：把会中白板物化成一个 diary 式文档（命名/多页/重开），仍归属本会议（context 不变·零迁移）════
async function ensureMeetingNoteDoc(m: PersistedMeeting): Promise<PersistedDoc> {
  return createDiaryDoc(noteIdOf(m.meeting_id), `${m.title || '会议'} 手记`, 1); // 幂等：首次建、之后取既有
}
function updateNotePageInd(): void {
  const total = Math.max(state.pageCount || 1, state.pageIndex + 1); // 空白新页显 N/N（未写不缩），同日记
  el('mtg-note-ind').textContent = `${state.pageIndex + 1}/${total}`;
}
/** 打开/回到本会议手记白板：物化 doc → 挂 active doc(令 mark:resolved 的 materialize 生效) → 还原页数/末读页/笔迹。 */
async function openMeetingNote(mtgId: string): Promise<void> {
  const m = await getMeeting(mtgId);
  if (!m || !meetingCtx || !liveMtg || liveMtg.id !== mtgId) return; // await 期间退会/切会 → 丢弃
  const doc = await ensureMeetingNoteDoc(m);
  if (!meetingCtx || !liveMtg || liveMtg.id !== mtgId) return;
  flushRegion('manual');                            // 收口上一面在途区域（quiet-6s 前切走否则该笔丢账）
  meetingCtx.loadGeneration++;                      // latest-wins：抢占在途资料载入（renderer fresh() 判此值），慢资料迟到不再覆盖手记
  liveNoteDoc = doc;
  document.body.classList.add('mtg-note-open');     // 露手记标题/翻页 bar
  document.body.classList.remove('side-open');
  el('mtg-note-title').textContent = doc.filename || `${m.title} 手记`;
  el('mlive-title').textContent = m.title;          // 顶栏回会议名（资料态被覆成资料名，回手记复位）
  const host = el('mtg-stage-host');
  renderBlankSurface(doc.document_id, doc.filename || m.title, { ...RULED, width: host.clientWidth, height: host.clientHeight });
  state.pageCount = doc.page_count || 1;            // renderBlankSurface 写死 1 → 复原真页数
  meetingCtx.storeDoc = doc; setActiveDoc(doc);     // current=手记 doc：materialize/末读页/改名都落到它
  const page = Math.min(doc.last_read_page ?? 0, Math.max(0, state.pageCount - 1));
  if (page > 0) renderBlankPage(page, RULED);
  redrawInk();
  updateNotePageInd();
  void refreshSpine();
}
function gotoMeetingNotePage(delta: number): void {
  if (!liveNoteDoc || state.surfaceType !== 'whiteboard') return;
  const idx = state.pageIndex + delta;
  if (idx < 0) return;                              // 同日记：可无限向前翻空白新页，写了才落盘
  flushRegion('manual');                            // 翻页前收口本页在途区域（page:rendered 会 resetAssembly，否则未落账的笔丢）
  renderBlankPage(idx, RULED);
  redrawInk();
  setLastReadPage(idx);
  updateNotePageInd();
}

// ════ live：会中工作台（白板搬进 #mtg-stage-host + 时间脊 + 资料栏 + 计时）════
async function enterMeeting(mtgId: string, material?: { docId: string; name: string; conv?: string }): Promise<void> {
  const m = await getMeeting(mtgId);
  if (!m) return;
  const ws = await getWorkspace(m.workspace_id);
  // t0 优先级：vc 会议事件真 start_time（L1·迟到进入也按真会议起点对·非本机进入时刻）→ 已存 started_at → 本机现在
  const vcT0 = typeof m.vc_meeting_start_t0 === 'number' && Number.isFinite(m.vc_meeting_start_t0) ? m.vc_meeting_start_t0 : 0;
  const startedIso = vcT0 ? new Date(vcT0).toISOString() : (m.started_at ?? new Date().toISOString());
  // 已结束=回看模式：不复活成 live、时钟冻结在会议时长。只有 upcoming/缺 started_at/有真 t0 才置 live + 落开始墙钟。
  const reviewing = m.status === 'ended';
  if (!reviewing && (m.status !== 'live' || !m.started_at || vcT0)) {
    await updateMeeting(mtgId, { status: 'live', started_at: startedIso, ...(vcT0 ? { t0_source: 'vc_event', align_state: 'event' } : {}) });
  }
  const startedMs = new Date(startedIso).getTime();
  const endedMs = reviewing && m.ended_at ? new Date(m.ended_at).getTime() : 0;
  liveMtg = { id: mtgId, title: m.title, chatId: ws?.feishu_chat_id, startedAt: startedMs, frozenAt: endedMs || (reviewing ? startedMs : 0) };
  liveMarkCount = 0;
  bedrockUserOverride = false; // 新会议：清上一场的手动接管标记
  if (!reviewing) startMeetingBedrock(); // 进行中会议=录基岩（回看模式不录）
  setMtg('live');
  el('mlive-title').textContent = m.title; // 默认会议标题；直接开资料时 openMaterialInMeeting 覆成资料名
  // 白板搬进 live 视图（renderer 持元素引用，搬动后照常工作）
  el('mtg-stage-host').appendChild(el('stage-wrap'));
  // 会中关实时 AI：暂停手势综合（marks 仍捕获、落本会议白板账本）
  prevGesture = settings.gesture.enabled; settings.gesture.enabled = false; bus.emit('settings:changed');
  meetingCtx = new SurfaceContext('mtg_' + mtgId, 'meeting');
  setActiveContext(meetingCtx);
  startClock(); // 立即起表（不等资料解码）
  if (material) {
    // 从详情页直接点资料进会议：开进该资料（免先闪一下白板）。资料载进 meetingCtx → 批注汇本会议时间脊。
    await openMaterialInMeeting(material.docId, material.name, material.conv);
  } else {
    await openMeetingNote(mtgId); // 会议手记（白板物化成 diary doc）→ document:loaded 还原墨迹 + 刷脊
  }
  void mountSide();
}

function teardownLive(): void {
  if (!liveMtg) return;
  liveMtg = null;
  liveNoteDoc = null;
  stopClock();
  stopMeetingBedrock(); // 关基岩（若是我们替它开的）+ flush
  settings.gesture.enabled = prevGesture; bus.emit('settings:changed'); // 恢复手势综合
  // 白板搬回 #rv-new（diary-bar 之后、whisper-layer 之前）
  el('rv-new').insertBefore(el('stage-wrap'), el('whisper-layer'));
  meetingCtx = null;
  if (readerCtx) setActiveContext(readerCtx); // 切回主阅读实例
  document.body.classList.remove('side-open');
  document.body.classList.remove('mtg-note-open');
  el('mtg-spine').hidden = true;
}
function exitToDetail(): void { teardownLive(); setMtg('detail'); void renderDetail(); }

function startClock(): void {
  stopClock();
  if (!liveMtg) return;
  if (liveMtg.frozenAt) { // 回看已结束会议：冻结在会议时长、不跑表、空心点表示非进行中
    el('mtg-clk').innerHTML = `<span class="dot off"></span>${clk(liveMtg.frozenAt - liveMtg.startedAt)}`;
    return;
  }
  const tick = (): void => { if (liveMtg) el('mtg-clk').innerHTML = `<span class="dot"></span>${clk(Date.now() - liveMtg.startedAt)}`; };
  tick();
  clockTimer = window.setInterval(tick, 1000);
}
function stopClock(): void { if (clockTimer) { window.clearInterval(clockTimer); clockTimer = 0; } }

let sidePager: Pager | null = null;
let sideBar: PagerBar | null = null;
async function mountSide(): Promise<void> {
  const mtg = liveMtg; // capture：await 期间退会/切会则丢弃，不写错会议侧栏
  if (!mtg) return;
  const list = el('mtg-side-list');
  const pager = sidePager ?? (sidePager = createPager(list, { onChange: (i) => sideBar?.update(i) }));
  if (!sideBar) sideBar = mountPagerBar(pager, el('mtg-side'));
  // ① 会议本地资料（material_doc_ids，添加资料挑的本地 PDF）——之前抽屉漏列，这里补上
  const [m, books] = await Promise.all([getMeeting(mtg.id), listBooks()]);
  if (liveMtg !== mtg) return;
  const bookMap = new Map(books.map((b) => [b.document_id, b]));
  const locals = (m?.material_doc_ids || []).map((id) => bookMap.get(id)).filter((b): b is PersistedDoc => !!b);
  const localCards = locals.map((b) =>
    `<div class="scard" data-docid="${esc(b.document_id)}" data-name="${esc(b.filename)}"><div class="fn">${SVG_FILE}${esc(b.filename || '(未命名)')}</div><div class="fm">${b.page_count} 页 · 本地 · 可批注</div></div>`
  ).join('');
  // ② 飞书群文件
  let files: FeishuMsg[] = [];
  if (mtg.chatId) {
    const res = await feishuGet<{ messages: FeishuMsg[] }>(`/api/feishu/workspaces/${mtg.chatId}/messages?limit=50`);
    if (liveMtg !== mtg) return;
    files = (res?.messages || []).filter((x) => (x.msg_type === 'file' && x.file_key) || (x.msg_type === 'image' && x.image_key));
  }
  const feishuCards = files.map((f) => {
    const img = f.msg_type === 'image';
    const name = img ? '［图片］' : (f.file_name || '文件');
    if (isConvertible(f)) {
      return `<div class="scard" data-conv="${esc(convertedPdfUrl(f))}" data-docid="mtgdoc_${esc(mtg.id)}_${esc(f.message_id)}" data-name="${esc(name)}"><div class="fn">${SVG_FILE}${esc(name)}</div><div class="fm">群文件 · 可批注</div></div>`;
    }
    return `<a class="scard" href="${esc(feishuFileUrl(f))}" target="_blank" rel="noopener"><div class="fn">${img ? SVG_IMG : SVG_FILE}${esc(name)}</div><div class="fm">群文件</div></a>`;
  }).join('');

  el('mtg-side-tab').textContent = `资料 ${locals.length + files.length}`;
  const cards = localCards + feishuCards;
  pager.content.innerHTML = `<div class="scard blank" id="mside-blank">✏ 会议手记 · 白板</div>${cards || '<p class="empty" style="padding:8px">还没有资料。回详情「+ 添加资料」或在群里发文件。</p>'}`;
  pager.relayout('first');
  // 回手记：reload 本会议手记 doc（document:loaded → 还原墨迹）+ 复位顶栏/页码
  list.querySelector('#mside-blank')?.addEventListener('click', () => {
    if (!liveMtg) return;
    document.body.classList.remove('side-open');
    void openMeetingNote(liveMtg.id);
  });
  // 资料卡：会中打开（保活会议）。本地无 conv 走 reopenBook，群 HTML 带 conv 走 openPdfFromUrl。
  list.querySelectorAll<HTMLElement>('.scard[data-docid]').forEach((c) => c.addEventListener('click', () => {
    void openMaterialInMeeting(c.dataset.docid!, c.dataset.name || '资料', c.dataset.conv);
  }));
}

/** 时间脊（会中工作台左缘）：按 context_id 聚合本场会议**所有 surface**（白板 + 各资料）的标注，
 *  按「会议相对时刻」排。资料上的笔靠会中保持 meetingCtx 活跃而带同一 context_id，故一并汇入。chip 点击切显隐。 */
async function refreshSpine(): Promise<void> {
  const mtg = liveMtg; // capture：await 期间可能退会/切会，迟到结果不能用新 liveMtg 解释（跨会污染/空指针）
  if (!mtg) return;
  const marks = (await getFoldedMarksByContext('mtg_' + mtg.id)).sort((a, b) => (a.abs_timestamp || 0) - (b.abs_timestamp || 0));
  if (liveMtg !== mtg) return;
  liveMarkCount = marks.length;
  el('mtg-chip-n').textContent = `${marks.length} 笔`;
  // surface 源标签：白板 + 各资料文件名，让聚合后的脊能区分笔来自哪儿
  const boardId = 'mtgboard_' + mtg.id;
  const nameOf = new Map((await listBooks()).map((b) => [b.document_id, b.filename || '(未命名)']));
  if (liveMtg !== mtg) return;
  const labelFor = (docId: string): string => (docId === boardId ? (liveNoteDoc?.filename || '会议手记') : nameOf.get(docId) || '资料'); // 脊上手记来源标签跟手记名（升格后不再叫"白板"）
  const blocks = marks.map((mk: PersistedMark) => {
    const rel = clk(Math.max(0, (mk.abs_timestamp || 0) - mtg.startedAt));
    const lines = (mk.marked_text || '').split('\n').filter(Boolean);
    const body = lines.length ? lines.map((l) => `<div class="hw"${/[一-龥]/.test(l) ? ' style="font-size:24px"' : ''}>${esc(l)}</div>`).join('') : '<div class="hw" style="color:var(--mut2);font-size:20px">（图形标注）</div>';
    return `<div class="mblk"><span class="tk"></span><div class="t">${rel}</div><div class="c"><div class="src">${esc(labelFor(mk.document_id))}</div>${body}</div></div>`;
  }).join('');
  el('mtg-spine').innerHTML = `<div class="mpg"><div class="mspine"></div>${blocks || '<p class="empty" style="padding:20px">还没有标注。在白板或资料上写下的内容会按会议时刻出现在这里。</p>'}</div>`;
}

function wireBack(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-back]').forEach((b) => b.addEventListener('click', () => {
    const to = b.dataset.back;
    if (to === 'home') { setMtg('home'); void renderHome(); }
    else if (to === 'ws') { setMtg('ws'); void renderWs(); }
    else if (to === 'detail') { setMtg('detail'); void renderDetail(); }
  }));
}

/** 入口：mobile-main boot 时调一次。绑定会议 nav 进入 + live 静态控件 + 标注计数刷新。 */
export function initMobileMeeting(opts: { readerCtx: SurfaceContext }): void {
  readerCtx = opts.readerCtx;

  // 会议 rail 进入 → home（inline 已切 data-mode=meet + 高亮；这里补真数据）
  document.querySelector('.nav [data-mode="meet"]')?.addEventListener('click', () => { teardownLive(); setMtg('home'); void renderHome(); });
  // 离开会议面（点阅读/dev）→ 若在会中，先收起白板搬回阅读
  document.querySelectorAll('.nav [data-mode="read"], .nav [data-mode="dev"]').forEach((b) => b.addEventListener('click', () => teardownLive()));

  // live 静态控件
  el('mlive-back').addEventListener('click', () => exitToDetail());
  el('mtg-side-tab').addEventListener('click', () => document.body.classList.toggle('side-open'));
  el('mtg-chip').addEventListener('click', () => { const sp = el('mtg-spine'); sp.hidden = !sp.hidden; if (!sp.hidden) void refreshSpine(); });

  // 会议手记 bar：翻页（瞬时·电纸屏无滑）+ 标题改名（落 doc）。
  el('mtg-note-prev').addEventListener('click', () => gotoMeetingNotePage(-1));
  el('mtg-note-next').addEventListener('click', () => gotoMeetingNotePage(1));
  el('mtg-note-title').addEventListener('blur', () => {
    if (!liveNoteDoc) return;
    const t = (el('mtg-note-title').textContent || '').trim() || liveNoteDoc.filename || '会议手记';
    el('mtg-note-title').textContent = t;
    liveNoteDoc.filename = t;
    void renameDiary(liveNoteDoc.document_id, t);
  });
  el('mtg-note-title').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); } });

  // 基岩 lease 配套：用户会议中手动设过基岩 → 标记 override（退出别误关）；切后台/关页 flush 并按 lease 处理。
  bus.on('bedrock:user-set', () => { if (liveMtg && !liveMtg.frozenAt) bedrockUserOverride = true; }); // 仅进行中会议里用户手动设过才接管（跨 visibility 收租后续租也认）
  window.addEventListener('pagehide', stopMeetingBedrock);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopMeetingBedrock();
    else if (liveMtg && !liveMtg.frozenAt) startMeetingBedrock(); // 切回前台且在进行中会议 → 续租
  });

  // 白板新标注 → 刷新计数（会中时）。document:loaded=进会议还原后首刷。
  // 计数即时更新；时间脊重建去抖（普通笔逐笔发 mark:resolved，连续手写别逐笔重建 spine·过刷电纸屏）。
  let spineRefreshTimer = 0;
  bus.on('mark:resolved', () => {
    if (!liveMtg) return;
    liveMarkCount += 1; el('mtg-chip-n').textContent = `${liveMarkCount} 笔`;
    if (el('mtg-spine').hidden) return;
    clearTimeout(spineRefreshTimer);
    spineRefreshTimer = window.setTimeout(() => void refreshSpine(), 800);
  });
}
