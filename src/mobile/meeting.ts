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
import { renderBlankSurface, renderBlankPage, reopenBook, openPdfFromUrl, importPdfFromUrl, cancelActiveRender } from '../surface/renderer';
import { redrawInk } from '../capture/ink';
import { flushRegion } from '../app/annotation-loop';
import { flushBedrock } from '../local/bedrock-recorder';
import { createPager, mountPagerBar, type Pager, type PagerBar } from '../surface/virtual-pager';
import {
  listWorkspaces, listAllMeetings, getWorkspace, listMeetings,
  createMeeting, getMeeting, updateMeeting, getFoldedMarks, getFoldedMarksByContext, listBooks, upsertFeishuWorkspace, startSimMeeting,
  createDiaryDoc, renameDiary, setActiveDoc, setLastReadPage, getDoc, upsertPanelWorkspace, upsertScheduleWorkspace,
} from '../local/store';
import { esc } from '../core/escape';
import { infoSheet, formSheet, pickSheet, pickOneSheet } from './sheet';
import { renderRecapCard, wireRecapCard, loadRecapView, resetRecapView, recapHandleBack, refreshPanelSummaryCache } from './meeting-recap'; // summarizeMeeting 迁 recap 内调用(M2b)
import type { MeetingStatus, PersistedMeeting, PersistedWorkspace, PersistedDoc, PersistedMark } from '../core/store-format';
import { pollPanelMeetingEvents, listActivePanelMeetings, type PanelFeishuMeeting, type PanelMeetingEvent } from '../integration/panel-feishu/client';
import { listMeetingGroupMaterialFiles, materialDocId, pdfSourceUrl, syncMeetingGroupMaterials } from '../features/meeting/feishu-materials';
import { forgetClaim, meetingNoFromUrl, resolveClaim, rememberClaim } from '../features/meeting/group-claims';

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
const fsEventWhen = (e: FeishuEvent): number => {
  const ts = e.start_time?.timestamp;
  if (ts) return Number(ts) * 1000;
  const d = e.start_time?.date;
  return d ? new Date(d.replace(/-/g, '/')).getTime() : 0;
};
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
let liveMtg: { id: string; title: string; chatId?: string; status: MeetingStatus; startedAt: number; frozenAt: number } | null = null;
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

function setMtg(view: 'home' | 'detail' | 'live' | 'recap'): void {
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
async function upsertPanelMeeting(mt: PanelFeishuMeeting, type: PanelMeetingUpsertType, occurredAt = 0): Promise<void> {
  if (!mt.meeting_id) return;
  const key = mt.meeting_id;
  const prev = panelUpserts.get(key) ?? Promise.resolve();
  const job = prev.catch(() => {}).then(() => upsertPanelMeetingInner(mt, type, occurredAt)).finally(() => {
    if (panelUpserts.get(key) === job) panelUpserts.delete(key);
  });
  panelUpserts.set(key, job);
  await job;
}

/** 归群「两条腿」：① group_ids 自动归真群 → ② 认领映射 → ③ 已在真飞书群保持 → ④ 日历会议无群保持日程占位 → ⑤ 无群桶。 */
async function resolveMeetingWorkspace(mt: PanelFeishuMeeting, existing: PersistedMeeting | null, existingWs: PersistedWorkspace | null): Promise<PersistedWorkspace> {
  if (mt.group_ids?.[0]) return upsertFeishuWorkspace(mt.group_ids[0], mt.topic || existingWs?.name || '飞书会议'); // ① 自动归群
  const claimed = resolveClaim({ meetingNo: mt.meeting_no, topic: mt.topic });                                     // ② 认领映射（用户准备会议时认领过）
  if (claimed) { const w = await getWorkspace(claimed); if (w) return w; }
  if (existingWs && existingWs.source === 'feishu') return existingWs;                                              // ③ 已在真飞书群·保持
  if (existing?.source_kind === 'calendar' && existingWs) return existingWs;                                       // ④ 日历会议无群·保持日程占位群
  return upsertPanelWorkspace('飞书会议');                                                                          // ⑤ 无群桶
}

async function upsertPanelMeetingInner(mt: PanelFeishuMeeting, type: PanelMeetingUpsertType, occurredAt = 0): Promise<void> {
  let existing = await findLocalPanelMeeting(mt.meeting_id);
  // B 归群桥：feishu_meeting_id 未命中时，用会议号匹配已落库的日历日程会议 → 合并升级同一张卡（不新建第二张）。
  if (!existing && mt.meeting_no) {
    const no = String(mt.meeting_no);
    existing = (await listAllMeetings()).find((m) => !m.feishu_meeting_id && m.calendar_meeting_no === no) ?? null;
  }
  const existingWs = existing ? await getWorkspace(existing.workspace_id) : null;
  // M1·status 严格飞书驱动 + started_at(时间轴 t0)用飞书真实开始时间：
  //   t0 = start_time → started 事件 occurred_at → 已存真 t0；都没有则不写 started_at（不再用本机 now 伪造）。
  const eventMs = Number.isFinite(occurredAt) && occurredAt > 0 ? occurredAt : 0;
  const hasRealStart = typeof mt.start_time === 'number' && Number.isFinite(mt.start_time) && mt.start_time > 0;
  const existingT0 = typeof existing?.vc_meeting_start_t0 === 'number' && Number.isFinite(existing.vc_meeting_start_t0) ? existing.vc_meeting_start_t0 : 0;
  const realT0 = hasRealStart ? mt.start_time! : (type === 'started' && eventMs > 0 ? eventMs : existingT0);
  const endMs = typeof mt.end_time === 'number' && mt.end_time > 0 ? mt.end_time : (type === 'ended' ? eventMs : 0);
  const scheduledIso = realT0 ? new Date(realT0).toISOString() : (existing?.scheduled_at || existing?.started_at || new Date().toISOString());
  const ws = await resolveMeetingWorkspace(mt, existing, existingWs); // 归群「两条腿」（自动 group_ids / 认领映射 / 保持）
  const base = existing ?? await createMeeting(ws.workspace_id, { title: mt.topic || '飞书会议', scheduled_at: scheduledIso });
  // started/active 快照→live（除非本地已 ended·防 active 把已结束刷回 live）；ended→ended；metadata→保持既有 status。
  const nextStatus: MeetingStatus = type === 'ended'
    ? 'ended'
    : type === 'started'
      ? (existing?.status === 'ended' ? 'ended' : 'live')
      : (existing?.status ?? 'upcoming');
  const minuteToken = panelMinuteToken(mt);
  const saved = await updateMeeting(base.meeting_id, {
    workspace_id: ws.workspace_id,                 // 迁移到正确 workspace（无群→manual·后续拿到真群→迁真群）
    title: mt.topic || base.title,
    scheduled_at: scheduledIso,
    status: nextStatus,
    ...(realT0 ? { started_at: new Date(realT0).toISOString() } : {}),  // 只有飞书真实 t0 才落 started_at（M1·不伪造）
    ...(endMs ? { ended_at: new Date(endMs).toISOString() } : {}),
    feishu_meeting_id: mt.meeting_id,
    feishu_meeting_no: mt.meeting_no,
    feishu_topic: mt.topic,
    source_kind: 'vc',                                                                  // panel VC 接管（syncCalendarMeetings 不再回刷此卡）
    ...(mt.meeting_no && !base.calendar_meeting_no ? { calendar_meeting_no: String(mt.meeting_no) } : {}),
    ...(realT0 ? { vc_meeting_start_t0: realT0, t0_source: 'vc_event', align_state: 'event', panel_meeting_start: realT0 } : {}),
    ...(minuteToken ? { feishu_minute_token: minuteToken } : {}),
    ...(mt.minute_url ? { feishu_minute_url: mt.minute_url } : {}),
  });
  if (!saved) throw new Error(`本地会议写入失败（同步 panel 会议 ${mt.meeting_id}）`); // 写失败 → 上层不推 cursor·下次重放
  // 正在这场记录工作台里 → 事件迟到时热更 status/t0/结束时长（不强制跳页·用户还在画板·只更状态条/脊）。
  if (liveMtg && liveMtg.id === base.meeting_id) {
    liveMtg.status = nextStatus;
    if (realT0) liveMtg.startedAt = realT0;
    if (nextStatus === 'ended') { liveMtg.frozenAt = (endMs || Date.now()); stopMeetingBedrock(); }
    else if (nextStatus === 'live') { liveMtg.frozenAt = 0; startMeetingBedrock(); }
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
    case 'ended': await upsertPanelMeeting(ev.meeting, ev.type, ev.occurred_at); return; // occurred_at=飞书会议真实开始/结束时刻（M1·t0 基准）
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

// ════ A：飞书日历日程 → 落成 upcoming 会议对象（日程卡=会议卡统一·可准备/可被 started 归群合并）════
/** 拉 my/events，把「带视频会议」的日程幂等落成本地 upcoming 会议（feishu_calendar_event_id 去重）。
 *  返回 {connected, events} 供 renderHome 复用、避免重复请求。已被 panel started 升级成 vc 的不回刷。 */
async function syncCalendarMeetings(): Promise<{ connected: boolean; events: FeishuEvent[] }> {
  const oauth = await feishuGet<{ connected: boolean }>('/api/feishu/oauth/status');
  if (!oauth?.connected) return { connected: false, events: [] };
  const ev = await feishuGet<{ events: FeishuEvent[] }>('/api/feishu/my/events');
  const events = ev?.events || [];
  const all = await listAllMeetings();
  const byCalId = new Map(all.filter((m) => m.feishu_calendar_event_id).map((m) => [m.feishu_calendar_event_id!, m] as const));
  let schedWsId = '';
  for (const e of events.filter((x) => x.has_meeting)) {        // 只落「带视频会议」的日程（纯日程不进会议列表）
    const startIso = new Date(fsEventWhen(e)).toISOString();
    const meetingNo = meetingNoFromUrl(e.vchat?.meeting_url);
    const existing = byCalId.get(e.event_id);
    if (existing) {
      if (existing.source_kind === 'vc') continue;             // 已被 panel started 接管，日历不插手
      await updateMeeting(existing.meeting_id, {
        title: e.summary || existing.title, scheduled_at: startIso,
        ...(meetingNo ? { calendar_meeting_no: meetingNo } : {}),
      });
      continue;
    }
    const claimedWs = resolveClaim({ meetingNo, topic: e.summary });   // 认领映射命中→直接归群；否则落日程占位群
    if (!claimedWs && !schedWsId) schedWsId = (await upsertScheduleWorkspace()).workspace_id;
    const m = await createMeeting(claimedWs || schedWsId, { title: e.summary || '会议日程', scheduled_at: startIso });
    await updateMeeting(m.meeting_id, {
      source_kind: 'calendar', feishu_calendar_event_id: e.event_id, feishu_topic: e.summary,
      ...(meetingNo ? { calendar_meeting_no: meetingNo } : {}),
      ...(claimedWs ? { group_claimed_at: new Date().toISOString() } : {}),
    });
  }
  return { connected: true, events };
}

// ════ home：日程子页 / 群聊子页（data-meet 切换·仿阅读页二级导航）════
let fsConnectedCache = false; // 飞书日历连接态（syncHomeData 更新·日程子页 badge 用·切子页免重新请求）

/** 同步会议数据：panel 事件 + 日历日程落库 + 飞书群→工作区。进入会议页 / 后台轮询时跑；切子页不跑。 */
async function syncHomeData(): Promise<void> {
  await syncPanelMeetings().catch(() => {}); // L1：panel VC 会议 → 本地会议（真 t0 + 归群）
  const cal = await syncCalendarMeetings().catch(() => ({ connected: false, events: [] as FeishuEvent[] })); // A：日历日程 → 本地 upcoming 会议
  fsConnectedCache = cal.connected;
  const wsRes = await feishuGet<{ workspaces: Array<{ chat_id: string; name: string; chat_status: string }> }>('/api/feishu/workspaces');
  if (wsRes) for (const w of wsRes.workspaces || []) if (w.chat_status === 'normal') await upsertFeishuWorkspace(w.chat_id, w.name);
}

/** 会议首页：data-meet 决定渲染「日程」(待开始/进行中会议纵向列表) 或「群聊」(群聊书架)。
 *  opts.sync 默认 true=先 syncHomeData；切子页传 false 只重渲（电纸屏瞬时·不重新网络同步）。 */
async function renderHome(opts?: { sync?: boolean; keepPage?: boolean }): Promise<void> {
  if (opts?.sync !== false) await syncHomeData();
  const [workspaces, allMeetings] = await Promise.all([listWorkspaces(), listAllMeetings()]);
  const wsName = new Map(workspaces.map((w) => [w.workspace_id, w.name]));
  // #1 会后总结可感知：summary_ready 后台到达标了 panel_summary_unread → 顶部提醒（两子页都挂）。
  const unread = allMeetings.filter((m) => m.panel_summary_unread);
  const unreadBar = unread.length
    ? `<button class="hbtn" id="mh-unread" style="display:block;width:calc(100% - 36px);margin:10px 18px 0;text-align:left;font-weight:600">📋 ${unread.length} 场会议总结已同步 · 点开看 ›</button>`
    : '';

  {
    // 会议列表（meeting-flow 单状态机·点会议按 status 直达）：未结束（进行中+待开始·升序）+ 已结束历史（降序·最近 20）。
    const sched = allMeetings.filter((m) => m.status !== 'ended').sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''));
    const ended = allMeetings.filter((m) => m.status === 'ended').sort((a, b) => (b.scheduled_at || b.started_at || '').localeCompare(a.scheduled_at || a.started_at || '')).slice(0, 20);
    const fsOk = fsConnectedCache ? `<span class="fs-ok"><span class="d"></span>飞书已连</span>` : '';
    const schedRows = sched.map((m) => mrow(m, wsName.get(m.workspace_id))).join('')
      || `<p class="empty">还没有待开始或进行中的会议。接飞书日历后，日程会自动出现在这里。</p>`;
    // 已结束=历史：点进直达「会后时间轴对齐」(openMeeting→openRecap)。段头用裸 div（不包 mrow·避免超高单块被 pager 推成空首页）。
    const endedRows = ended.length
      ? `<div class="msec-h" style="padding:12px 18px 2px"><span class="mt">已结束 · 会后记录</span><span class="mb">${ended.length}</span></div>${ended.map((m) => mrow(m, wsName.get(m.workspace_id))).join('')}`
      : '';
    // 模拟会议仅 DEV 联调用、且需先有真飞书群（startSimMeeting 依赖群）→ 生产/无群时隐藏，空态才自洽（#6）
    const hasFeishuGroup = workspaces.some((w) => w.workspace_id !== 'ws_schedule' && w.source === 'feishu');
    const simBtn = import.meta.env.DEV && hasFeishuGroup ? '<button class="hbtn" id="mh-sim">模拟会议</button>' : '';
    el('mv-home').innerHTML =
      `<div class="vhead"><h1>会议</h1><span class="cnt">${sched.length} 进行中/待开始 · ${ended.length} 历史</span><span class="sp"></span>${fsOk}${simBtn}</div>`
      + `<div class="mbody">${unreadBar}${schedRows}${endedRows}</div>`; // mrow 各自作 pager 块
    wireRows(el('mv-home'));
    el('mv-home').querySelector('#mh-sim')?.addEventListener('click', async () => {
      const m = await startSimMeeting();
      if (!m) { await infoSheet({ title: '模拟会议', message: '先连一个飞书群（机器人所在群会自动同步成工作区）再开模拟会议。' }); return; }
      void openMeeting(m.workspace_id, m.meeting_id);
    });
  }
  el('mv-home').querySelector('#mh-unread')?.addEventListener('click', () => { // 跳第一场有新总结的会议详情
    const first = unread[0];
    if (!first) return;
    void openMeeting(first.workspace_id, first.meeting_id);
  });
  pageMbody(el('mv-home'), 'home', opts?.keepPage ? 'keep' : 'first');
}

// ════ E：实时状态后台轮询（会议开始/结束秒级反映 + 文件窗口抓取·不打断当前活动）════
let meetingPollTimer = 0;
let lastMeetingSig = '';
const lastMaterialSync = new Map<string, number>(); // 每会议群文件抓取节流（≥5min/场）
const HOUR_MS = 3600_000;
/** 会议在「开始前 1h ~ 结束后 1h」捕获窗口内（未结束按 now 当上界）。 */
function inCaptureWindow(m: PersistedMeeting): boolean {
  const start = new Date(m.scheduled_at).getTime();
  const end = m.ended_at ? new Date(m.ended_at).getTime() : Date.now();
  const now = Date.now();
  return Number.isFinite(start) && now >= start - HOUR_MS && now <= end + HOUR_MS;
}
/** 一拍：同步 panel/日历（实时归类）→ 窗口内已归真群的会议抓群文件（节流）→ 数据变了才重渲首页（守翻页·不打断 ws/detail/live）。 */
async function meetingPollTick(): Promise<void> {
  if (document.hidden || document.body.dataset.mode !== 'meet') return;
  // 会中(记录工作台)也要消费 panel started/ended 事件(M1·status 飞书驱动)，但只轻量同步、不抓群文件/不重渲 home（保 P0 不抢资源/不打断画板）。
  if (document.body.dataset.mtg === 'live') { await syncPanelMeetings().catch(() => {}); return; }
  try { await syncHomeData(); } catch { return; }
  for (const m of await listAllMeetings()) { // 文件捕获窗口：窗口内 + 已归真飞书群（会前1h只对已知群生效）
    const ws = m.workspace_id ? await getWorkspace(m.workspace_id) : null;
    if (!(ws?.source === 'feishu' && ws.feishu_chat_id && inCaptureWindow(m))) continue;
    if (Date.now() - (lastMaterialSync.get(m.meeting_id) || 0) < 5 * 60_000) continue;
    lastMaterialSync.set(m.meeting_id, Date.now());
    void syncMeetingGroupMaterials({ meetingId: m.meeting_id, chatId: ws.feishu_chat_id, feishuBase: FEISHU_BASE, convertBase: CONVERT_BASE });
  }
  const sig = (await listAllMeetings()).map((m) => m.meeting_id + m.status + m.workspace_id).sort().join('|');
  if (sig === lastMeetingSig) return;          // 无变化不重渲（电纸屏免无谓刷新）
  lastMeetingSig = sig;
  if (document.body.dataset.mtg === 'home') await renderHome({ sync: false, keepPage: true }).catch(() => {});
}
function startMeetingPoll(): void {
  if (meetingPollTimer) return;
  meetingPollTimer = window.setInterval(() => void meetingPollTick(), 12000);            // 前台可见每 12s
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void meetingPollTick(); }); // 回前台立即追一拍
}

function mrow(m: PersistedMeeting, wsLabel?: string): string {
  return `<button class="mrow" data-mtgid="${esc(m.meeting_id)}" data-wsid="${esc(m.workspace_id)}">${stBadge(m.status)}`
    + `<span class="mc"><span class="mt">${esc(m.title)}</span><span class="mm">${esc(fmtDateTime(m.scheduled_at))}${wsLabel ? ` · ${esc(wsLabel)}` : ''}</span></span>`
    + `<span class="go">${SVG_GO}</span></button>`;
}
/** 会议行点击 → 按会议状态直达对应态（meeting-flow 单状态机·会后整合）。 */
function wireRows(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.mrow[data-mtgid]').forEach((b) => b.addEventListener('click', () => {
    void openMeeting(b.dataset.wsid, b.dataset.mtgid!);
  }));
}
/** meeting-flow 路由：点会议按 status 直达——会前(upcoming)=资料+参加 detail / 会中(live)=白板 / 会后(ended)=时间轴对齐 recap。
 *  去掉「统一进 detail 再分」中转：会后直进对齐、不再 detail→会后记录→recap 多层钻（用户拍板·大改单状态机）。 */
async function openMeeting(wsId: string | undefined, mtgId: string): Promise<void> {
  const m = await getMeeting(mtgId);
  if (!m) { setMtg('home'); void renderHome(); return; }
  mv = { wsId: wsId ?? m.workspace_id, mtgId };
  if (m.status === 'live') void enterMeeting(mtgId);     // 会中：继续记录
  else if (m.status === 'ended') void openRecap(mtgId);  // 会后：直进时间轴对齐
  else { setMtg('detail'); void renderDetail(); }        // 会前：资料 + 参加
}

// ws 群页已删（单页面收敛·阶段②）：群成员/动态/三桶对「参加会议」价值低 → 会议统一走 home 列表。
// 手动「新建会议」入口随之移除（真实会议来自飞书日历/panel 同步）；DEV 仍可走「模拟会议」。
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

  // 「群里收集到的资料」区块已下沉到会中资料抽屉（mountSide·B 方案 detail 瘦身·阶段②）：
  // detail 不再重复浏览群文件，只显示已入库的会议资料（mats·含上面 408 后台抓取转 PDF 的群文件）。
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
  // 思路总结已迁 recap（M2b·会后态显示+生成）。detail 准备区不再有思路总结块。
  // 「进入会议」即开始（enterMeeting 内置置 live + 落 started_at），故不再单列「开始会议」按钮，去职责重叠。
  const enterLabel = m.status === 'live' ? '✏ 进入会议（继续）' : '✏ 进入画板 · 开始记录'; // 会前可进画板写(M1·进画板≠开始)·ended 不进 detail(走 recap)
  const endBtn = m.status === 'live' ? '<button class="hbtn" id="md-end">⏹ 结束会议</button>' : '';
  const needClaim = (ws?.source ?? 'manual') !== 'feishu'; // 未归真飞书群（日程占位/无群桶）→ 给「归到群」认领入口
  const claimHtml = needClaim
    ? '<button class="lk" id="md-claim">📍 归到群</button>'
    : `${esc(ws?.name || '已归群')} <button class="lk" id="md-unclaim" style="margin-left:8px">移除</button>`; // M4 归群可逆：已归群显群名+移除
  // 准备区会议信息卡（M2·对齐后）：时间 + 会议号 + 状态 + 归属(归到群/移除·M4 可逆)。不显会议链接(电纸屏非开会终端·会议号够标识)。
  const whenStr = fmtDateTime(m.scheduled_at);
  const noStr = m.feishu_meeting_no || m.calendar_meeting_no || '';
  const stText = m.status === 'live' ? '进行中' : m.status === 'ended' ? '已结束' : '待开始';
  const infoCard =
    `<section class="msec"><div class="mcard">`
    + `<div class="ir"><span class="il">时间</span><span class="iv">${esc(whenStr)}</span></div>`
    + (noStr ? `<div class="ir"><span class="il">会议号</span><span class="iv">${esc(noStr)}</span></div>` : '')
    + `<div class="ir"><span class="il">状态</span><span class="iv">${stText}</span></div>`
    + `<div class="ir"><span class="il">归属</span><span class="iv">${claimHtml}</span></div>`
    + `</div></section>`;

  el('mv-detail').innerHTML =
    `<div class="mtop"><span class="bk" data-back="home">${SVG_BACK}</span><span class="ti">${esc(m.title)}</span>${stBadge(m.status).replace('class="st', 'style="margin-left:8px" class="st')}</div>` // ws 页已删→detail 恒回 home（阶段②）
    + `<div class="mbody">`
    + `<div class="dact"><button class="hbtn pri" id="md-enter">${enterLabel}</button>${endBtn}</div>` // 主动作=进画板(会前可写)；结束仅 live(手动兜底·md-end)
    + infoCard
    + `<section class="msec"><div class="msec-h"><span class="mt">会议资料</span><span class="mb">${mats.length} 份</span><span class="sp" style="flex:1"></span><button class="hbtn sm" id="md-add">+ 添加资料</button></div>${filesHtml}</section>`
    + `<section class="msec"><div class="msec-h"><span class="mt">你的手写档案</span></div>${archiveHtml}</section>`
    + `</div>`;

  // ended 不再进 detail(走 recap)→ recap card 死分支已删(清死分支·M2)。
  el('mv-detail').querySelector('#md-enter')?.addEventListener('click', () => { void enterMeeting(m.meeting_id); });
  el('mv-detail').querySelector('#md-end')?.addEventListener('click', async () => { await updateMeeting(m.meeting_id, { status: 'ended', ended_at: new Date().toISOString() }); void openRecap(m.meeting_id); }); // 结束会议→直进会后时间轴对齐（会后整合·单状态机）
  // 思路总结生成已迁 recap（M2b·detail 不再有 md-sum）。
  el('mv-detail').querySelector('#md-add')?.addEventListener('click', async () => {
    // M3 资料双来源：先选来源（飞书群文件 / 本地文档·让用户知道两个来源都能拉）。
    const hasFeishuSource = !!(ws?.source === 'feishu' && ws.feishu_chat_id);
    const source = await pickOneSheet({
      title: '添加资料',
      items: [
        { id: 'feishu', label: hasFeishuSource ? '飞书群文件' : '飞书群文件（需先归群）', sub: hasFeishuSource ? '从当前归属群选择文件' : '先在会议信息卡归到飞书群' },
        { id: 'local', label: '本地文档', sub: '从已导入 PDF 选择' },
      ],
      defaultId: hasFeishuSource ? 'feishu' : 'local',
      confirm: '下一步',
    });
    if (!source) return;
    if (source === 'feishu') {
      if (!ws?.feishu_chat_id) { await infoSheet({ title: '先归到群', message: '飞书群文件来自会议归属群。请先在会议信息卡点「归到群」，再从群文件添加资料。' }); return; }
      let files: Awaited<ReturnType<typeof listMeetingGroupMaterialFiles>> = [];
      try { files = await listMeetingGroupMaterialFiles({ chatId: ws.feishu_chat_id, feishuBase: FEISHU_BASE, limit: 50 }); }
      catch (e) { await infoSheet({ title: '拉取群文件失败', message: String((e as Error)?.message || e) }); return; }
      const candidates = files
        .map((f) => ({ f, docId: materialDocId(m.meeting_id, f.message_id), src: pdfSourceUrl(f, FEISHU_BASE, CONVERT_BASE) }))
        .filter((x) => !!x.src && !m.material_doc_ids.includes(x.docId));
      const add = await pickSheet({
        title: '添加飞书群文件',
        items: candidates.map((c) => ({ id: c.docId, label: c.f.file_name || '群文件', sub: [/\.pdf$/i.test(c.f.file_name || '') ? 'PDF' : '将转成 PDF', fmtMs(c.f.create_time)].filter(Boolean).join(' · ') })),
        empty: '这个群最近没有可添加的 PDF / HTML / 图片文件，或都已在本场资料里。',
        confirm: '添加',
      });
      if (!add?.length) return;
      const byId = new Map(candidates.map((c) => [c.docId, c] as const));
      const docIds = new Set(m.material_doc_ids);
      let ok = 0, failed = 0;
      for (const id of add) {
        const c = byId.get(id);
        if (!c?.src) continue;
        try { await importPdfFromUrl(c.docId, c.f.file_name || '群文件', c.src); docIds.add(c.docId); ok++; }
        catch { failed++; } // 单文件转换/下载失败不阻断其它
      }
      if (ok) await updateMeeting(m.meeting_id, { material_doc_ids: [...docIds] });
      if (failed) await infoSheet({ title: '部分资料导入失败', message: `${failed} 个群文件转换或下载失败，其他已添加。` });
      void renderDetail();
      return;
    }
    const avail = books.filter((b) => !m.material_doc_ids.includes(b.document_id));
    const add = await pickSheet({
      title: '添加本地文档',
      items: avail.map((b) => ({ id: b.document_id, label: b.filename || '(未命名)', sub: `${b.page_count} 页` })),
      empty: '没有可添加的资料。先到「阅读 · 书籍」导入 PDF。',
      confirm: '添加',
    });
    if (add && add.length) { await updateMeeting(m.meeting_id, { material_doc_ids: [...new Set([...m.material_doc_ids, ...add])] }); void renderDetail(); }
  });
  el('mv-detail').querySelector('#md-claim')?.addEventListener('click', async () => {
    const realWs = (await listWorkspaces()).filter((w) => w.source === 'feishu');
    const pick = await pickOneSheet({
      title: '归到群聊',
      items: realWs.map((w) => ({ id: w.workspace_id, label: w.name, sub: w.workspace_id === m.workspace_id ? '当前' : '' })),
      empty: '还没有飞书群。机器人所在的群会自动同步进来。',
      confirm: '归类',
    });
    if (!pick) return;
    // 记住认领（会议号 + 标题）→ 之后同号/同名周期会自动归；并把这场迁过去。
    rememberClaim({ meetingNo: m.calendar_meeting_no || m.feishu_meeting_no, topic: m.feishu_topic || m.title }, pick);
    await updateMeeting(m.meeting_id, { workspace_id: pick, group_claimed_at: new Date().toISOString() });
    void renderDetail();
  });
  el('mv-detail').querySelector('#md-unclaim')?.addEventListener('click', async () => {
    // M4 归群可逆：撤销认领 + 会议移回占位群（日历来源→日程占位 ws_schedule·否则无群桶）。只迁 workspace_id/group_claimed_at·不碰 material_doc_ids/marks/context_id（笔和资料不丢）。
    forgetClaim({ meetingNo: m.calendar_meeting_no || m.feishu_meeting_no, topic: m.feishu_topic || m.title });
    const fallback = (m.source_kind === 'calendar' || m.feishu_calendar_event_id) ? await upsertScheduleWorkspace() : await upsertPanelWorkspace('飞书会议');
    await updateMeeting(m.meeting_id, { workspace_id: fallback.workspace_id, group_claimed_at: undefined });
    void renderDetail();
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
  el('recap-back').onclick = () => { if (recapHandleBack()) return; resetRecapView(); setMtg('home'); void renderHome(); }; // 会后整合：recap 是 ended 主体·返回回 home 列表（不再回 detail）
  await loadRecapView(mtgId, el('recap-body'), el('recap-title'));
}

const MATERIAL_OPEN_TIMEOUT_MS = 60_000; // 会中打开资料总超时：转换服务/下载/pdfjs 解码任一 hang 都不让 UI 永久卡死（P0）
/** 给任意 promise 加超时：到点 reject，不真正中断底层（底层各自有 AbortController/cancel/loadGeneration 守卫兜底）。 */
function timeoutAfter<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = window.setTimeout(() => { if (!done) { done = true; reject(new Error(`${label}超时`)); } }, ms);
    p.then(
      (v) => { if (!done) { done = true; window.clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; window.clearTimeout(timer); reject(e); } },
    );
  });
}
function materialOpenError(e: unknown): string {
  const msg = String((e as Error)?.message || e || '未知错误');
  return /超时|timeout|AbortError/i.test(msg)
    ? '资料打开超时：可能是文件下载、转换服务或 PDF 解码没有响应。已回到会议手记，请稍后重试。'
    : msg;
}

/** 会中打开资料：**不退出会议**。把 PDF 载进会中共享画布（loadIntoState 载入当前活跃 meetingCtx），
 *  时钟/时间脊照常，资料上的笔带同一 context_id='mtg_<id>' → 汇入时间脊。返回白板=点抽屉「空白笔记页」。
 *  P0：加总超时 + 失败/超时自动回退到会议手记（取消在途渲染、收资料态、弹提示），任何资料都不会让会中永久卡死。 */
async function openMaterialInMeeting(docId: string, name: string, convUrl?: string): Promise<void> {
  const mtg = liveMtg, ctx = meetingCtx; // capture：转 PDF/解码慢时用户退会再进别场，迟到结果不能写当前 live UI
  if (!mtg || !ctx) return;
  flushRegion('manual'); // 切资料前收口手记/上一面在途区域（否则刚写的笔在 6s 收口前被切走丢账）
  document.body.classList.remove('side-open'); // 收起资料抽屉
  document.body.classList.remove('mtg-note-open'); // 资料态隐手记 bar（翻页/标题是手记的，不是资料的）
  el('mlive-title').textContent = `正在打开：${name}`; // 即时反馈：电纸屏无 loading 动画，先让用户知道在加载
  try {
    if (convUrl) {
      await timeoutAfter(openPdfFromUrl(docId, name, convUrl), MATERIAL_OPEN_TIMEOUT_MS, '打开会议资料');
    } else {
      const ok = await timeoutAfter(reopenBook(docId, name), MATERIAL_OPEN_TIMEOUT_MS, '打开本地资料');
      if (!ok) throw new Error('本地资料缓存不存在，请回详情重新添加或重新导入。'); // reopenBook 返回 false=没字节，原来会静默假成功（停在空白资料态）
    }
  } catch (e) {
    if (liveMtg === mtg && getActiveContext() === ctx) { // 仍在本场会议才动 UI（迟到失败不打扰已切走的用户）
      ctx.loadGeneration++; ctx.renderGeneration++; cancelActiveRender(); // 抢占/取消在途资料载入与渲染，防慢资料迟到覆盖恢复后的手记
      document.body.classList.remove('side-open');
      document.body.classList.remove('mtg-note-open');
      el('mlive-title').textContent = mtg.title;
      void infoSheet({ title: '打开失败', message: materialOpenError(e) });
      void openMeetingNote(mtg.id); // 回退到会议手记，保证会议仍可用（不是卡在半坏的资料态）
    }
    return;
  }
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
  // M1·进画板 ≠ 开始：enterMeeting 只进记录工作台，**不改 status、不落 started_at**（status/t0 严格由飞书事件驱动）。
  // t0 取已有飞书真实开始时间（vc_meeting_start_t0 / started_at）；会前（无 t0）时 startedMs=0 → startClock 显「会前记录」、时间脊显「会前」。
  const vcT0 = typeof m.vc_meeting_start_t0 === 'number' && Number.isFinite(m.vc_meeting_start_t0) ? m.vc_meeting_start_t0 : 0;
  const startedAtMs = m.started_at ? Date.parse(m.started_at) : NaN;
  const startedMs = vcT0 || (Number.isFinite(startedAtMs) ? startedAtMs : 0);
  const reviewing = m.status === 'ended';
  const endedAtMs = reviewing && m.ended_at ? Date.parse(m.ended_at) : NaN;
  const endedMs = Number.isFinite(endedAtMs) ? endedAtMs : 0;
  liveMtg = { id: mtgId, title: m.title, chatId: ws?.feishu_chat_id, status: m.status, startedAt: startedMs, frozenAt: startedMs > 0 ? (endedMs || (reviewing ? startedMs : 0)) : 0 };
  liveMarkCount = 0;
  bedrockUserOverride = false; // 新会议：清上一场的手动接管标记
  if (m.status === 'live') startMeetingBedrock(); // 只有飞书已判 live 才录基岩；会前工作台 / 已结束回看不录。
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
  // M1·状态条按飞书口径：会前（飞书还没 started·无 t0）不跑表，显「会前记录」；已结束显「已结束」。
  // M5 画板状态条：三态明示飞书口径到哪——会前记录中 / 进行中·时长 / 已结束·时长。
  if (liveMtg.status === 'ended') {
    const dur = liveMtg.startedAt > 0 && liveMtg.frozenAt ? ` · ${clk(Math.max(0, liveMtg.frozenAt - liveMtg.startedAt))}` : '';
    el('mtg-clk').innerHTML = `<span class="dot off"></span>已结束${dur}`;
    return;
  }
  if (liveMtg.status === 'upcoming' || liveMtg.startedAt <= 0) {
    el('mtg-clk').innerHTML = '<span class="dot off"></span>会前记录中'; // 飞书还没 started·会前可写
    return;
  }
  // 进行中（飞书 started·有真 t0）：跑表 + 「进行中」明示
  const tick = (): void => { if (liveMtg) el('mtg-clk').innerHTML = `<span class="dot"></span>进行中 · ${clk(Date.now() - liveMtg.startedAt)}`; };
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
    const rel = mtg.startedAt > 0 ? clk(Math.max(0, (mk.abs_timestamp || 0) - mtg.startedAt)) : '会前'; // M1·会前（t0 未定）笔标「会前」；精确会前段对齐留 M6(recap)
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
    else if (to === 'detail') { setMtg('detail'); void renderDetail(); }
  }));
}

/** 入口：mobile-main boot 时调一次。绑定会议 nav 进入 + live 静态控件 + 标注计数刷新。 */
export function initMobileMeeting(opts: { readerCtx: SurfaceContext }): void {
  readerCtx = opts.readerCtx;

  // 会议 rail 进入 → home（inline 已切 data-mode=meet + 高亮；这里补真数据）
  document.querySelector('.nav [data-mode="meet"]')?.addEventListener('click', () => { teardownLive(); setMtg('home'); void renderHome(); });
  // 会议子导航（群聊/日程双子页）已删 → 单页面会议流：home 直接是会议列表（单页面收敛·阶段①）
  // 离开会议面（点阅读/dev）→ 若在会中，先收起白板搬回阅读
  document.querySelectorAll('.nav [data-mode="read"], .nav [data-mode="dev"]').forEach((b) => b.addEventListener('click', () => teardownLive()));
  startMeetingPoll(); // E 实时状态：会议面可见时每 12s 同步 panel/日历 + 抓窗口内群文件 + 变化重渲（不打断当前活动）

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
  bus.on('bedrock:user-set', () => { if (liveMtg && liveMtg.status === 'live' && !liveMtg.frozenAt) bedrockUserOverride = true; }); // 仅飞书已判 live 的会议里用户手动设过才接管（会前/已结束不接管·M1）
  window.addEventListener('pagehide', stopMeetingBedrock);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopMeetingBedrock();
    else if (liveMtg && liveMtg.status === 'live' && !liveMtg.frozenAt) startMeetingBedrock(); // 切回前台且在飞书已判 live 的会议 → 续租（会前不录·M1）
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
