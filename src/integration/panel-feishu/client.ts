/**
 * WS2-C panel 飞书事件中枢 client（会后对照取数）。
 * 走同源 `/api/panel-feishu/*` → vite dev proxy（注入 x-inkloop-secret·secret 不进前端）→ panel `/api/feishu/*`。
 * 经 `core/api.ts` 的 `getJson`（覆盖 dev 同源 + 生产 VITE_API_BASE_URL）·不裸 fetch。
 * 旧 `feishuGet`(:4321) 只管群/会议/消息/文件·与本 client（妙记转写）是两套·别混。
 */
import { getJson } from '../../core/api';

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
