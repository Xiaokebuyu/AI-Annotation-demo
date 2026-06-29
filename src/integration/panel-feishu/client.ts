/**
 * WS2-C panel 飞书事件中枢 client（会后对照取数）。
 * 走同源 `/api/panel-feishu/*` → vite dev proxy（注入 x-inkloop-secret·secret 不进前端）→ panel `/api/feishu/*`。
 * 经 `core/api.ts` 的 `getJson`（覆盖 dev 同源 + 生产 VITE_API_BASE_URL）·不裸 fetch。
 * 旧 `feishuGet`(:4321) 只管群/会议/消息/文件·与本 client（妙记转写）是两套·别混。
 */
import { getJson, postJson } from '../../core/api';
import type { PanelMeetingSummaryRecord } from '../../core/store-format';

const BASE = '/api/panel-feishu';

/** panel 落库的飞书会议（含 t0 近似 start_time + 关联到的 minute_token）。 */
export interface PanelFeishuMeeting {
  meeting_id: string;
  meeting_no?: string;
  topic?: string;
  start_time?: number;   // epoch ms（录音 t0 近似）
  end_time?: number;     // epoch ms
  owner_open_id?: string;
  group_ids?: string[];
  minute_token?: string | null;
  minute_url?: string | null;
  /** 妙记↔会议关联可信度（panel WS2）：exact=端侧/人工显式绑定 · heuristic=topic/时间窗推测 · none=无。 */
  match?: MinuteMatch;
}

/** panel 妙记匹配元信息（向后兼容：老接口无此字段时为 undefined）。 */
export interface MinuteMatch {
  minute_token: string | null;
  confidence: 'exact' | 'heuristic' | 'none';
  source: 'explicit' | 'topic' | 'time_window' | null;
  matched_by?: string | null;
}

export interface PanelMinuteMeta {
  token?: string;
  title?: string;
  url?: string;
  duration?: string;
  create_time?: string;
  owner_id?: string;
}

/** 最近会议（按 start_time 倒序·已附最可能的 minute_token）。 */
export async function listRecentPanelMeetings(limit = 20, opts?: { signal?: AbortSignal }): Promise<PanelFeishuMeeting[]> {
  const r = await getJson<{ meetings: PanelFeishuMeeting[] }>(`${BASE}/meetings/recent?limit=${encodeURIComponent(String(limit))}`, opts);
  return r.meetings ?? [];
}

/** L1+L5 增量事件（设备增量轮询·seq 游标）：一条 event 内嵌完整会议（带真 start_time + match + 当前 minute_token）。 */
export interface PanelMeetingEvent {
  seq: number;
  type: 'started' | 'ended' | 'minute_bound' | 'summary_ready';
  occurred_at: number;          // epoch ms（started=会议开始 / ended=会议结束 / minute_bound=妙记绑定 / summary_ready=总结生成）
  created_at: number;           // epoch ms（panel 落库时刻）
  meeting: PanelFeishuMeeting;
}

/**
 * 拉自 since(游标 seq) 之后的会议开始/结束事件。设备休眠/离线/无公网 → 增量轮询而非推送。
 * 返回 cursor 存本地，下次带上；server_time 供时钟漂移参考。
 */
export async function pollPanelMeetingEvents(since = 0, opts?: { signal?: AbortSignal }): Promise<{ server_time: number; cursor: number; events: PanelMeetingEvent[] }> {
  return getJson<{ server_time: number; cursor: number; events: PanelMeetingEvent[] }>(
    `${BASE}/meetings/events?since=${encodeURIComponent(String(since))}`,
    opts,
  );
}

/** 当前进行中的会议快照（新设备无 cursor / 迟到打开时补 active·12h 内开始且未结束）。 */
export async function listActivePanelMeetings(limit = 20, opts?: { signal?: AbortSignal }): Promise<PanelFeishuMeeting[]> {
  const r = await getJson<{ meetings: PanelFeishuMeeting[] }>(`${BASE}/meetings/active?limit=${encodeURIComponent(String(limit))}`, opts);
  return r.meetings ?? [];
}

/** 妙记带时间戳转写（SRT 文本·cue 时间相对录音 t=0）。 */
export async function getMinuteTranscript(token: string, format: 'srt' | 'txt' = 'srt', opts?: { signal?: AbortSignal }): Promise<string> {
  const r = await getJson<{ transcript: string }>(`${BASE}/minutes/${encodeURIComponent(token)}/transcript?format=${format}`, opts);
  return r.transcript ?? '';
}

/** 妙记元信息（标题/时长/url）。 */
export async function getMinuteMeta(token: string, opts?: { signal?: AbortSignal }): Promise<PanelMinuteMeta> {
  const r = await getJson<{ minute: PanelMinuteMeta }>(`${BASE}/minutes/${encodeURIComponent(token)}`, opts);
  return r.minute ?? {};
}

/**
 * 显式把 minute_token 绑定到 panel 会议（端侧确认关联后回写）。
 * 把 panel 的 topic/时间窗 heuristic 升成 exact；失败返回 null（不阻断本地关联，本地已存 token）。
 */
export async function bindPanelMinute(meetingId: string, minuteToken: string, opts?: { signal?: AbortSignal }): Promise<PanelFeishuMeeting | null> {
  try {
    const r = await postJson<{ meeting: PanelFeishuMeeting }>(
      `${BASE}/meetings/${encodeURIComponent(meetingId)}/bind-minute`,
      { minute_token: minuteToken, bound_by: 'inkloop' },
      opts,
    );
    return r.meeting ?? null;
  } catch {
    return null;
  }
}

/** L5 总结取数状态：ready=已生成 · not_generated=未生成(可触发) · missing_minute=没关联妙记 · not_found=panel 无此会议 · failed=出错。 */
export type PanelMeetingSummaryStatus = 'ready' | 'not_generated' | 'missing_minute' | 'not_found' | 'failed';

/** GET 已生成的 panel 五要素总结（不触发生成·未生成时 summary=null·status 指示原因）。 */
export async function getPanelMeetingSummary(meetingId: string, opts?: { signal?: AbortSignal }): Promise<{ status: PanelMeetingSummaryStatus; summary: PanelMeetingSummaryRecord | null }> {
  return getJson<{ status: PanelMeetingSummaryStatus; summary: PanelMeetingSummaryRecord | null }>(
    `${BASE}/meetings/${encodeURIComponent(meetingId)}/summary`,
    opts,
  );
}

/** POST 触发 panel 现总结并落库（用户点「生成总结」时·panel 侧 in-flight 去重·M3 一次几秒~十几秒）。 */
export async function generatePanelMeetingSummary(meetingId: string, opts?: { signal?: AbortSignal }): Promise<{ status: PanelMeetingSummaryStatus; summary: PanelMeetingSummaryRecord | null }> {
  return postJson<{ status: PanelMeetingSummaryStatus; summary: PanelMeetingSummaryRecord | null }>(
    `${BASE}/meetings/${encodeURIComponent(meetingId)}/summary`,
    {},
    opts,
  );
}
