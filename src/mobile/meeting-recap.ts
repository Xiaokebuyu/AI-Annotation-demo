/**
 * WS2-C「会后记录」—— 会议转写 + 手写档案 +（近似）时间对照。
 * 挂在会议详情(renderDetail)里：关联飞书妙记 → 读转写 + 手写档案 → AI 思路总结。
 *
 * ⚠️「近似对照」非「精确对齐」：t0 用 panel 会议 start_time 近似·mark 时间是落账时刻偏后·
 * 全程用「附近/同时段」语义 + 明示校准状态（未校准/约对齐/已人工校准），绝不当精确。
 */
import { esc } from '../core/escape';
import { infoSheet, pickOneSheet } from './sheet';
import { getMeeting, updateMeeting, getFoldedMarksByContext, getCachedMinute, putCachedMinute } from '../local/store';
import { postNdjson } from '../core/api';
import { settings } from '../app/state';
import { listRecentPanelMeetings, getMinuteTranscript, bindPanelMinute, getPanelMeetingSummary, generatePanelMeetingSummary, type PanelFeishuMeeting, type PanelMeetingSummaryStatus } from '../integration/panel-feishu/client';
import { parseSrtTranscript, type TranscriptCue } from '../integration/panel-feishu/align';
import { buildSegments, buildSegmentMarks, type RecapSegment } from '../integration/panel-feishu/segment';
import { publishEntityToVault } from '../integration/inksurface/vault-publish-device';
import type { PersistedMeeting, PersistedMark, PanelMeetingSummaryRecord } from '../core/store-format';

const SUMMARY_TRANSCRIPT_CAP = 16000; // 喂 AI 的转写字数软上限（长转写分块留 P5）

const ALIGN_LABEL: Record<NonNullable<PersistedMeeting['align_state']>, string> = {
  uncalibrated: '未校准',
  approx: '约对齐',
  event: '会议 t0·录音起点未校准',
  manual: '已人工校准',
};

function localStartMs(m: PersistedMeeting): number {
  const s = m.started_at || m.scheduled_at;
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function fmtClock(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDiff(deltaMs: number): string {
  const s = Math.round(deltaMs / 1000);
  const a = Math.abs(s);
  const sign = s >= 0 ? '+' : '-';
  if (a < 90) return `${sign}${a}s`;
  if (a < 5400) return `${sign}${Math.round(a / 60)}min`;
  return `${sign}${(a / 3600).toFixed(1)}h`;
}

/** detail 里「会后记录」卡的 HTML（含关联状态）。 */
export function renderRecapCard(m: PersistedMeeting): string {
  // 放宽：有飞书会议(feishu_meeting_id)即可进 recap 看 panel 总结；妙记(token)绑了再补转写对轴。
  const associated = !!(m.feishu_meeting_id || m.feishu_minute_token);
  if (associated) {
    const hasMinute = !!m.feishu_minute_token;
    const state = hasMinute ? (m.align_state ? ALIGN_LABEL[m.align_state] : '约对齐') : (m.panel_summary ? 'panel 总结已同步' : '等 panel 绑定妙记');
    const linked = [m.feishu_topic, m.panel_meeting_start ? fmtClock(m.panel_meeting_start) : ''].filter(Boolean).join(' · ');
    const nm = hasMinute ? '飞书妙记转写' : '飞书会后记录';
    const desc = hasMinute
      ? `已关联${linked ? '：' + esc(linked) : ''} · 点开读转写 + 手写档案`
      : `已关联飞书会议${linked ? '：' + esc(linked) : ''} · 点开看 panel 总结，妙记绑定后补转写`;
    return `<section class="msec" id="recap-sec"><div class="msec-h"><span class="mt">会后记录</span><span class="mb">${esc(state)}</span></div>`
      + `<div class="matcard" id="recap-open"><span class="ic">${SVG_DOC}</span><div><div class="nm">${nm}${m.panel_summary_unread ? ' · <b>新总结</b>' : ''}</div>`
      + `<div class="mt">${desc}</div></div></div>`
      + `<div class="dact" style="padding:8px 0 2px"><button class="hbtn" id="recap-reassoc">改关联会议</button></div></section>`;
  }
  return `<section class="msec" id="recap-sec"><div class="msec-h"><span class="mt">会后记录</span><span class="mb">需关联飞书会议</span></div>`
    + `<div class="empty">把这场会议关联到对应的飞书会议，会后就能读 panel 总结；妙记绑定后会补齐转写。</div>`
    + `<div class="dact" style="padding:8px 0 2px"><button class="hbtn pri" id="recap-assoc">关联飞书会议</button></div></section>`;
}

const SVG_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z"/><path d="M9 13h6M9 17h6"/></svg>';

/** 关联飞书会议：拉最近会议 → 按时间近推荐 → 单选确认 → 存 token + 三时间字段。 */
async function associate(m: PersistedMeeting): Promise<boolean> {
  let meetings: PanelFeishuMeeting[];
  try {
    meetings = await listRecentPanelMeetings(20);
  } catch (e) {
    await infoSheet({ title: '拉取失败', message: `连不上 panel 飞书中枢：${String((e as Error)?.message || e)}` });
    return false;
  }
  if (!meetings.length) {
    await infoSheet({ title: '没有可关联的会议', message: '飞书中枢还没有会议记录。请确认机器人在会议群里、且会议已结束并生成了妙记。' });
    return false;
  }
  const ls = localStartMs(m);
  const sorted = [...meetings].sort((a, b) => Math.abs((a.start_time ?? 0) - ls) - Math.abs((b.start_time ?? 0) - ls));
  // 时间差大（>30min）→ 不默认选中、标风险（防用户盲点确认关到错会议·codex #1）
  const FAR_MS = 30 * 60 * 1000;
  const items = sorted.map((mt, i) => {
    const dms = mt.start_time && ls ? mt.start_time - ls : null;
    const far = dms != null && Math.abs(dms) > FAR_MS;
    const diff = dms != null ? `相差${fmtDiff(dms)}${far ? '⚠时间差大' : ''}` : '时间未知';
    const dur = mt.start_time && mt.end_time ? `${Math.max(1, Math.round((mt.end_time - mt.start_time) / 60000))}分钟` : '';
    const conf = mt.match?.confidence;
    const tok = !mt.minute_token ? '无转写' : conf === 'exact' ? '妙记·已确认' : conf === 'heuristic' ? '妙记·推测' : '有转写';
    const no = mt.meeting_no ? `会议号${mt.meeting_no}` : '';
    const tag = i === 0 && !far ? '推荐 · ' : '';
    return { id: mt.meeting_id, label: `${tag}${mt.topic || '(无主题会议)'}`, sub: [fmtClock(mt.start_time), dur, diff, no, tok].filter(Boolean).join(' · ') };
  });
  // 最近一场就时间差很大 → 不预选(defaultId 给个不存在的)·逼用户主动选
  const nearestFar = sorted[0]?.start_time != null && ls > 0 && Math.abs((sorted[0].start_time ?? 0) - ls) > FAR_MS;
  const picked = await pickOneSheet({ title: '关联飞书会议（本地会议：' + (m.title || '') + '）', items, defaultId: nearestFar ? '__none__' : items[0].id, confirm: '确认关联' });
  if (!picked) return false;
  const mt = sorted.find((x) => x.meeting_id === picked);
  if (!mt) return false;
  if (!mt.minute_token) {
    await infoSheet({ title: '这场会议还没有妙记', message: '所选会议没有可拉取的妙记转写（可能未开云录制 / 妙记还在生成 / 卡片未转发到机器人群）。' });
    return false;
  }
  // offset 推断留到读转写时（需 cues）；此处先存 offset=0。
  // mt.start_time = vc all_meeting_started 的会议开始时刻（真 t0）·非录音开始（录音可能晚几秒~分钟·残差由 recap 文案诚实标出）
  await updateMeeting(m.meeting_id, {
    feishu_meeting_id: mt.meeting_id,
    feishu_meeting_no: mt.meeting_no,
    feishu_topic: mt.topic,
    feishu_minute_token: mt.minute_token,
    feishu_minute_url: mt.minute_url ?? undefined,
    panel_meeting_start: mt.start_time,         // 保留 raw panel 值供核对/兜底
    vc_meeting_start_t0: mt.start_time,         // 会议开始真 t0（替掉旧的「假录音 t0」）
    t0_source: 'vc_event',
    align_offset_ms: 0,
    align_state: 'event',
    feishu_match_confirmed_at: new Date().toISOString(),
  });
  // 端侧确认即权威：回写 panel 显式绑定，覆盖它的 topic/时间窗推测（fire-and-forget·失败不阻断本地关联）
  void bindPanelMinute(mt.meeting_id, mt.minute_token);
  return true;
}

/** 绑定「会后记录」卡的按钮。rerender = 重渲染 detail；openRecap = 进 recap 阅读视图。 */
export function wireRecapCard(root: HTMLElement, meetingId: string, rerender: () => void, openRecap: () => void): void {
  const onAssoc = async (): Promise<void> => {
    const m = await getMeeting(meetingId);
    if (!m) return;
    if (await associate(m)) rerender();
  };
  root.querySelector('#recap-assoc')?.addEventListener('click', () => void onAssoc());
  root.querySelector('#recap-reassoc')?.addEventListener('click', () => void onAssoc());
  root.querySelector('#recap-open')?.addEventListener('click', () => openRecap());
}

// ════ V2 recap：分段对轴时间线（概览段级 ⇄ 详情句级 · 翻页 · 近似对照）════

const OV_PAGE = 6;             // 概览每页段数
const DT_PAGE = 12;            // 详情每页句数
const MARKS_CAP = 3;          // 概览段内手写最多列几条（余下折成「＋另 N 处」·详情看全）

/** overview=时间脊(默认主体) · detail=段级详情(overview 下钻) · summary=思路总结整页 · panel=panel总结整页——
 *  后两者是左侧 #recap-nav 三个入口里的两个，彼此平级（点入口直切·非抽屉）。 */
interface RecapV2 {
  meeting: PersistedMeeting;
  segments: RecapSegment[];
  view: 'overview' | 'detail' | 'summary' | 'panel';
  detailIdx: number;            // detail 视图当前段下标
  ovPage: number;               // 概览翻页
  dtPage: number;               // 详情翻页
  bodyEl: HTMLElement;          // 供 recapHandleBack / 各页重渲复用
  transcriptMissing: boolean;   // 转写为空/未就绪但仍展示手写档案（提示用·防误以为没内容）
  panelSummary: PanelMeetingSummaryRecord | null; // L5：panel 五要素总结（独立整页·和时间脊互补）
  panelSummaryStatus: string;   // loading / ready / not_generated / missing_minute / generating / failed
}
let recapState: RecapV2 | null = null;
// 防异步串会：打开 A 后快速返回/打开 B，A 的晚到结果（转写/AI 摘要）不能覆盖 B 的视图/状态。
let recapLoadSeq = 0;
export function resetRecapView(): void { recapLoadSeq++; recapState = null; updateExportButton(); updateRecapNav(); }
function recapAlive(seq: number, bodyEl: HTMLElement): boolean {
  // 含 data-mode：底部导航离开会议页后，晚到的异步 digest 不再更新隐藏 state/缓存（codex A#5）。
  return seq === recapLoadSeq && document.body.dataset.mode === 'meet' && document.body.dataset.mtg === 'recap' && document.body.contains(bodyEl);
}

/** 顶栏「返回」：在详情段视图时先退回概览（返回 true）；已在概览则交调用方退出 recap（返回 false）。 */
export function recapHandleBack(): boolean {
  if (recapState && recapState.view === 'detail') {
    recapState.view = 'overview';
    renderRecap(recapState.bodyEl);
    recapState.bodyEl.scrollTop = 0;
    return true;
  }
  return false;
}

/** 拉转写：**在线先拉最新**（妙记可能后续补全/修订）→ 写缓存；离线/失败回退缓存（会后复盘不丢）。 */
async function loadTranscript(m: PersistedMeeting): Promise<{ srt: string; cues: TranscriptCue[] } | null> {
  const token = m.feishu_minute_token;
  if (!token) return null;
  const cached = await getCachedMinute(token);
  try {
    const srt = await getMinuteTranscript(token, 'srt');
    if (srt.trim()) {
      await putCachedMinute({ minute_token: token, meeting_id: m.meeting_id, srt, fetched_at: new Date().toISOString() });
      return { srt, cues: parseSrtTranscript(srt) };
    }
  } catch (e) {
    if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt) }; // 离线回退缓存
    throw e;
  }
  // 在线拉到空 → 回退缓存（妙记还在生成时别覆盖已有缓存）
  if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt) };
  return { srt: '', cues: [] };
}

// 负 ms＝会前（M6·segment.ts 不再 clamp≥0）：保留负号，如 -9:52。⚠️s 四舍五入到 0 时别显 "-0:00"（codex 抓）。
const clk = (ms: number): string => { const s = Math.round(Math.abs(ms) / 1000); const neg = ms < 0 && s > 0; return `${neg ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const rng = (a: number, b: number): string => `${clk(a)}–${clk(b)}`;
// t0/offset 防 NaN（started_at 可能解析失败·codex A#1）：取第一个有限值，否则 0。
const finiteMs = (...xs: Array<number | null | undefined>): number => { for (const x of xs) if (typeof x === 'number' && Number.isFinite(x)) return x; return 0; };
// t0 优先级：真录音事件 t0 > vc 会议开始 t0 > legacy feishu_recording_t0（旧数据装的 panel 近似）> panel_start > started_at。
// 会后对轴优先「录音 t0」；拿不到才退「会议事件 t0」，并由 UI 明示录音残差未消除。
const meetingT0 = (m: PersistedMeeting): number =>
  m.t0_source === 'recording_event' && Number.isFinite(m.feishu_recording_t0)
    ? (m.feishu_recording_t0 as number)
    : finiteMs(m.vc_meeting_start_t0, m.feishu_recording_t0, m.panel_meeting_start, m.started_at ? Date.parse(m.started_at) : NaN);
const inkLabel = (feat: string): string => (feat === 'drawing' ? '◇ 图形' : '✎ 手写');
const inkText = (text: string, feat: string): string => text.trim() || (feat === 'drawing' ? '（图形标注 / 圈画）' : '（未识别手写）');

/** 进 recap 视图：拉转写 + 手写档案 → 分段 → 渲染概览（段级时间线为主体·左侧 #recap-nav 三个入口切到思路总结/panel总结整页）；
 *  并异步补 active 段 AI 摘要。 */
export async function loadRecapView(meetingId: string, bodyEl: HTMLElement, titleEl: HTMLElement): Promise<void> {
  const seq = ++recapLoadSeq;
  recapState = null;
  updateExportButton(); // 加载中先隐藏导出按钮/nav（还没有有效 recapState）
  updateRecapNav();
  bodyEl.innerHTML = '<p class="rc-note">正在拉取转写…</p>';
  const m = await getMeeting(meetingId);
  if (!recapAlive(seq, bodyEl)) return;
  if (!m) { bodyEl.innerHTML = '<p class="rc-note">会议不存在。</p>'; return; }
  titleEl.textContent = `${m.title || '会议'} · 会后记录`;
  if (m.panel_summary_unread) void updateMeeting(m.meeting_id, { panel_summary_unread: false }); // 进 recap 即「已读」·清 home/detail 提醒
  const hasPanelMeeting = !!m.feishu_meeting_id;
  const hasMinute = !!m.feishu_minute_token;
  // codex 扫描出的真 bug：新版单页面 recap 没挂旧 detail 卡片的关联入口，日历来的会议一旦没关联上飞书会议就卡死在死文案、
  // 用户没有任何办法自救。这里直接把 recap 空态变成一个可操作的关联入口（复用 associate()，成功后原地重载 recap）。
  if (!hasPanelMeeting && !hasMinute) {
    bodyEl.innerHTML = '<p class="rc-note">尚未关联飞书会议——关联后才能读 panel 总结和转写对轴。</p>'
      + '<button class="hbtn pri" id="recap-assoc-empty" style="margin-top:2px">关联飞书会议</button>';
    bodyEl.querySelector('#recap-assoc-empty')?.addEventListener('click', () => {
      void (async () => {
        if (!recapAlive(seq, bodyEl)) return;
        if (await associate(m)) { if (recapAlive(seq, bodyEl)) void loadRecapView(meetingId, bodyEl, titleEl); }
      })();
    });
    return;
  }

  // 有妙记才拉转写；只有 panel 会议（妙记未绑）时跳过转写，靠 panel 总结 + 手写档案撑起 recap。
  let loaded: { srt: string; cues: TranscriptCue[] } | null = null;
  if (hasMinute) {
    try { loaded = await loadTranscript(m); }
    catch (e) { if (!recapAlive(seq, bodyEl)) return; bodyEl.innerHTML = `<p class="rc-note">拉取转写失败：${esc(String((e as Error)?.message || e))}（已关联的转写若曾缓存可离线读）。</p>`; return; }
    if (!recapAlive(seq, bodyEl)) return;
  }
  const cues = loaded?.cues ?? [];

  const marks = (await getFoldedMarksByContext('mtg_' + m.meeting_id)).filter((mk) => !mk.is_tombstone).sort((a, b) => a.abs_timestamp - b.abs_timestamp);
  if (!recapAlive(seq, bodyEl)) return;
  const t0 = meetingT0(m);
  const segMarks = buildSegmentMarks(
    marks.map((mk) => ({ mark_id: mk.mark_id, abs_timestamp: mk.abs_timestamp, feature_type: mk.feature_type, marked_text: mk.marked_text, page_index: mk.page_index })),
    t0, finiteMs(m.align_offset_ms),
  );
  // 转写与手写都空 → 无可展示；但**转写未就绪而有手写时仍要把手写档案露出来**（否则用户的手写被整页静默隐藏）。
  if (!cues.length && !segMarks.length && !hasPanelMeeting) { bodyEl.innerHTML = '<p class="rc-note">转写为空或还在生成，本场也没有手写档案。</p>'; return; }

  const segments = buildSegments({ cues, marks: segMarks });
  recapState = { meeting: m, segments, view: 'overview', detailIdx: 0, ovPage: 0, dtPage: 0, bodyEl, transcriptMissing: !cues.length,
    panelSummary: m.panel_summary ?? null, panelSummaryStatus: m.panel_summary ? 'ready' : (m.panel_summary_status ?? 'loading') };
  renderRecap(bodyEl);
  updateExportButton();
  wireRecapExportButton();
  updateRecapNav();
  wireRecapNav();
  void loadPanelSummary(seq, bodyEl, m); // L5：异步拉 panel 总结（不阻塞时间线·拉到后按当前 view 重渲）
}

function renderRecap(bodyEl: HTMLElement): void {
  if (!recapState) return;
  if (recapState.view === 'detail') renderRecapDetail(bodyEl);
  else if (recapState.view === 'summary') renderRecapSummaryPage(bodyEl);
  else if (recapState.view === 'panel') renderRecapPanelPage(bodyEl);
  else renderRecapOverview(bodyEl);
}

/** 导航脊 #recap-sub：时间脊/思路总结/panel总结三个入口互为平级页（点即切·非抽屉·同 #read-sub/#dev-sub 的图标+文字样式）。 */
function updateRecapNav(): void {
  if (!recapState) return; // 显隐交给 CSS(body[data-mtg="recap"])；无有效 recapState 时不瞎改高亮
  const view = recapState.view;
  document.querySelectorAll<HTMLElement>('#recap-sub [data-rc]').forEach((b) => {
    // detail 是时间脊的下钻，没有独立入口——停在 detail 时"时间脊"仍高亮。
    const on = b.dataset.rc === view || (b.dataset.rc === 'overview' && view === 'detail');
    b.classList.toggle('on', on); b.classList.toggle('dim', !on);
    b.closest('.rl-item')?.classList.toggle('cur', on);
  });
}
function wireRecapNav(): void {
  document.querySelectorAll<HTMLElement>('#recap-sub [data-rc]').forEach((b) => {
    b.onclick = () => {
      if (!recapState) return;
      const rc = b.dataset.rc as RecapV2['view'] | undefined;
      if (rc !== 'overview' && rc !== 'summary' && rc !== 'panel') return;
      recapState.view = rc;
      renderRecap(recapState.bodyEl);
      updateRecapNav();
    };
  });
}

/** 翻页条（id 前缀区分概览/详情）。 */
function pagerHtml(id: string, page: number, total: number): string {
  if (total <= 1) return '';
  return `<div class="tl-pager"><button class="hbtn" id="${id}-prev"${page === 0 ? ' disabled style="opacity:.4"' : ''}>‹ 上一页</button>`
    + `<span class="tl-pn">${page + 1} / ${total}</span>`
    + `<button class="hbtn" id="${id}-next"${page >= total - 1 ? ' disabled style="opacity:.4"' : ''}>下一页 ›</button></div>`;
}

/** 页码钳到 [0, total-1]（防负/越界渲染空页·codex A#6）。 */
const clampPage = (p: number, total: number): number => Math.max(0, Math.min(p, total - 1));

// M2b·思路总结：本地 m.summary（summarizeMeeting 生成·手写档案 AI 综合）——左侧 #recap-nav「思路总结」入口整页，
// 与 panel AI 总结（另一入口）分开（时间脊为主体这版布局：三个入口互为平级页，时间脊只呈现"我何时写了什么"）。
function meetingSummaryHtml(): string {
  if (!recapState) return '';
  const m = recapState.meeting;
  const stale = !!(m.summary && m.summary_source?.feishu_minute_token && m.summary_source.feishu_minute_token !== m.feishu_minute_token);
  const body = m.summary
    ? `${stale ? '<div class="empty" style="margin:0 0 6px">⚠ 此总结基于旧的飞书关联生成，可能不对应当前转写，建议重新生成。</div>' : ''}<div class="summary" id="rs-body">${esc(m.summary)}</div>`
    : `<div class="empty" id="rs-body">${recapState.panelSummary ? '还没生成设备端思路总结；下方已同步 panel AI 总结。可点生成，把飞书转写和本场手写合在一起。' : (m.feishu_minute_token ? '还没生成思路总结。可基于飞书妙记转写和本场手写生成。' : '还没生成思路总结。先关联飞书妙记后再生成。')}</div>`;
  const label = m.summary ? '重新生成' : '生成思路总结';
  const disabled = m.feishu_minute_token ? '' : ' disabled style="opacity:.45"';
  return `<div class="rc-msum">`
    + `<div class="rc-msum-h"><b>思路总结</b><button class="hbtn" id="rs-gen"${disabled}>${label}</button></div>`
    + body + `</div>`;
}
async function generateMeetingSummary(seq: number, bodyEl: HTMLElement, meetingId: string): Promise<void> {
  if (!recapState || !recapAlive(seq, bodyEl) || recapState.meeting.meeting_id !== meetingId) return;
  const btn = bodyEl.querySelector<HTMLButtonElement>('#rs-gen');
  if (btn?.dataset.busy) return;
  if (btn) { btn.dataset.busy = '1'; btn.textContent = '生成中…'; btn.disabled = true; }
  let lastPaint = 0;
  try {
    const out = await summarizeMeeting(meetingId, (full) => {
      const now = Date.now();
      if (now - lastPaint < 500) return; // 电纸屏 500ms 合并刷新·防残影
      lastPaint = now;
      if (!recapAlive(seq, bodyEl)) return;
      const sumEl = bodyEl.querySelector<HTMLElement>('#rs-body');
      if (sumEl) { sumEl.className = 'summary'; sumEl.textContent = full; }
    });
    if (!out || !recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meetingId) return;
    const fresh = await getMeeting(meetingId); // 刷新 recapState.meeting → renderRecap 重渲（不重 loadRecapView·免重拉转写/重算分段）
    if (fresh && recapAlive(seq, bodyEl) && recapState && recapState.meeting.meeting_id === meetingId) recapState.meeting = fresh;
  } finally {
    if (recapAlive(seq, bodyEl)) renderRecap(bodyEl);
  }
}
function wireMeetingSummaryButton(bodyEl: HTMLElement): void {
  bodyEl.querySelector('#rs-gen')?.addEventListener('click', () => {
    if (!recapState) return;
    void generateMeetingSummary(recapLoadSeq, bodyEl, recapState.meeting.meeting_id);
  });
}
/** 左侧 nav「思路总结」入口整页。 */
function renderRecapSummaryPage(bodyEl: HTMLElement): void {
  if (!recapState) return;
  bodyEl.innerHTML = meetingSummaryHtml();
  wireMeetingSummaryButton(bodyEl);
}

// ── 阶段⑤·按需导出：顶栏「导出到 Obsidian」按钮（单会议触发·见 vault-publish-device.ts publishEntityToVault 头注） ──
const fmtExportedAt = (iso: string): string => {
  try { return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return iso; }
};
/** 按当前 recapState 刷新顶栏导出按钮的文案/可见性（不动忙态——忙态由 runVaultExport 自己管）。 */
function updateExportButton(): void {
  const btn = document.getElementById('recap-export-btn') as HTMLButtonElement | null;
  if (!btn) return;
  if (!recapState) { btn.hidden = true; return; }
  btn.hidden = false;
  if (btn.dataset.busy) return;
  const m = recapState.meeting;
  btn.textContent = m.exported_at ? '重新导出' : '导出到 Obsidian';
  btn.title = m.exported_at ? `上次导出 · ${fmtExportedAt(m.exported_at)}` : '';
  btn.disabled = false;
}
async function runVaultExport(seq: number, bodyEl: HTMLElement, meetingId: string): Promise<void> {
  if (!recapState || !recapAlive(seq, bodyEl) || recapState.meeting.meeting_id !== meetingId) return;
  const btn = document.getElementById('recap-export-btn') as HTMLButtonElement | null;
  if (btn?.dataset.busy) return;
  if (btn) { btn.dataset.busy = '1'; btn.disabled = true; btn.textContent = '收集中…'; }
  try {
    const r = await publishEntityToVault({ mode: 'meeting', meetingId }, {
      concepts: false, // 单会议按需导出：跳过概念层 LLM 抽取（慢·且概念是跨文档的，单次触发意义不大）
    });
    if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meetingId) return;
    if (!r.ok) {
      await infoSheet({ title: r.entityEmpty ? '没有可导出内容' : '导出到 Obsidian 失败', message: r.error || '未知错误' });
      return;
    }
    const fresh = await getMeeting(meetingId); // 刷新 exported_at（同思路总结的刷新模式·不重 loadRecapView）
    if (fresh && recapAlive(seq, bodyEl) && recapState && recapState.meeting.meeting_id === meetingId) recapState.meeting = fresh;
  } finally {
    if (btn) { delete btn.dataset.busy; btn.disabled = false; }
    if (recapAlive(seq, bodyEl)) updateExportButton();
  }
}
/** 顶栏导出按钮是静态 DOM（不随 renderRecap 重建），每次 loadRecapView 用 onclick 幂等重绑一次即可。 */
function wireRecapExportButton(): void {
  const btn = document.getElementById('recap-export-btn');
  if (!btn) return;
  btn.onclick = () => {
    if (!recapState) return;
    void runVaultExport(recapLoadSeq, recapState.bodyEl, recapState.meeting.meeting_id);
  };
}

type StoredPanelSummaryStatus = NonNullable<PersistedMeeting['panel_summary_status']>;
function toStoredPanelSummaryStatus(status: PanelMeetingSummaryStatus): StoredPanelSummaryStatus {
  if (status === 'ready' || status === 'not_generated' || status === 'missing_minute' || status === 'not_found') return status;
  return 'failed'; // 'failed' 外的取数态都落库，下次进 recap 直接显示而非永远 loading。
}

/**
 * 按 feishu_meeting_id 拉 panel 五要素总结、写入本地缓存。事件消费(summary_ready)与 recap 内共用。
 * 远端拉取失败 / 本地写失败都会抛 —— 由调用方决定 best-effort（吞掉下次再拉）还是中断（不推 cursor）。
 */
export async function refreshPanelSummaryCache(m: PersistedMeeting): Promise<{ status: PanelMeetingSummaryStatus; summary: PanelMeetingSummaryRecord | null }> {
  if (!m.feishu_meeting_id) {
    await updateMeeting(m.meeting_id, { panel_summary_status: 'missing_minute' });
    return { status: 'missing_minute', summary: null };
  }
  const r = await getPanelMeetingSummary(m.feishu_meeting_id);
  const fetchedAt = new Date().toISOString();
  if (r.summary) await updateMeeting(m.meeting_id, { panel_summary: r.summary, panel_summary_fetched_at: fetchedAt, panel_summary_status: 'ready' });
  else await updateMeeting(m.meeting_id, { panel_summary_fetched_at: fetchedAt, panel_summary_status: toStoredPanelSummaryStatus(r.status) });
  return r;
}

/** L5：recap 内异步拉 panel 总结、拉到后按当前 view 重渲。失败标 failed（best-effort·不影响时间线）。 */
async function loadPanelSummary(seq: number, bodyEl: HTMLElement, m: PersistedMeeting): Promise<void> {
  try {
    const r = await refreshPanelSummaryCache(m);
    if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== m.meeting_id) return;
    recapState.panelSummary = r.summary ?? recapState.panelSummary;
    recapState.panelSummaryStatus = r.summary ? 'ready' : r.status;
  } catch {
    // codex 扫描出的真 bug：漏了这条守卫时，A 会议请求晚到失败会污染此刻正在看的 B 会议的状态。
    if (recapAlive(seq, bodyEl) && recapState && recapState.meeting.meeting_id === m.meeting_id) {
      recapState.panelSummaryStatus = recapState.panelSummary ? 'ready' : 'failed';
    }
  }
  if (recapAlive(seq, bodyEl)) renderRecap(bodyEl);
}

/** L5：用户点「生成总结」→ POST 触发 panel 现总结（M3·几秒~十几秒·panel 侧 in-flight 去重）。 */
async function generatePanelSummary(seq: number, bodyEl: HTMLElement, localMeetingId: string): Promise<void> {
  const m = recapState?.meeting;
  if (!m?.feishu_meeting_id || !recapAlive(seq, bodyEl) || m.meeting_id !== localMeetingId || !recapState) return;
  const panelMeetingId = m.feishu_meeting_id;
  recapState.panelSummaryStatus = 'generating';
  renderRecap(bodyEl);
  try {
    const r = await generatePanelMeetingSummary(panelMeetingId);
    // 串会守卫：生成期间快速切到别的会议 recap，晚到结果不能覆盖当前 state。
    if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== localMeetingId) return;
    recapState.panelSummary = r.summary ?? null;
    recapState.panelSummaryStatus = r.summary ? 'ready' : r.status;
    if (r.summary) await updateMeeting(localMeetingId, { panel_summary: r.summary, panel_summary_fetched_at: new Date().toISOString(), panel_summary_status: 'ready' });
  } catch (e) {
    if (recapAlive(seq, bodyEl) && recapState) recapState.panelSummaryStatus = 'failed';
    await infoSheet({ title: '生成 panel 总结失败', message: String((e as Error)?.message || e) });
  }
  if (recapAlive(seq, bodyEl)) renderRecap(bodyEl);
}

/** L5：panel 五要素总结块（左侧 nav「panel 总结」入口整页「会议讲了什么」·和时间脊「我何时写了什么」互补）。 */
function panelSummaryHtml(): string {
  if (!recapState) return '';
  const rec = recapState.panelSummary;
  const status = recapState.panelSummaryStatus;
  const box = (inner: string): string => `<div class="rc-psum">${inner}</div>`;
  if (rec?.summary) {
    const s = rec.summary;
    const blk = (label: string, items: string[]): string => items.length
      ? `<div class="rc-blk"><span class="rc-blk-h">${label}</span>${items.map((x) => `<span class="rc-blk-li">${esc(x)}</span>`).join('')}</div>` : '';
    const ai = s.action_items.length
      ? `<div class="rc-blk"><span class="rc-blk-h">行动项</span>${s.action_items.map((a) => `<span class="rc-blk-li">${esc(a.task)}${a.owner && a.owner !== '未指定' ? `<span class="who">${esc(a.owner)}</span>` : ''}${a.due ? `<span class="who">${esc(a.due)}</span>` : ''}</span>`).join('')}</div>`
      : '';
    return box(`<div class="rc-psum-h"><b>panel AI 总结 · 会议讲了什么</b>${rec.model ? `<span class="mdl">${esc(rec.model)}</span>` : ''}</div>`
      + blk('结论', s.conclusions) + ai + blk('风险', s.risks) + blk('待决', s.open_questions) + blk('后续', s.next_steps));
  }
  if (status === 'missing_minute') return box('这场会议在 panel 端还没拿到妙记转写——AI 总结会在妙记绑定后自动同步过来，设备会自己刷新，无需操作。');
  if (status === 'loading' || status === 'generating') return box(status === 'generating' ? '正在生成 panel 总结…（M3 读完整场转写，稍候）' : '正在拉取 panel 总结…');
  if (status === 'failed') return box('拉取 panel 总结失败（网络/服务波动）。<button class="hbtn rc-psum-retry" id="ps-refresh">刷新重试</button>');
  if (status === 'not_found') return box('panel 没找到这场会议（可能关联错了，可回上一页改关联）。<button class="hbtn rc-psum-retry" id="ps-refresh">刷新</button>');
  // not_generated → 可主动触发生成
  return box('panel 还没生成这场会议的 AI 总结。<button class="hbtn rc-psum-retry" id="ps-gen">生成总结</button>');
}

/** 绑定 panel 总结块的按钮（生成 / 刷新重试）——正常态与空态共用。 */
function wirePanelSummaryButtons(bodyEl: HTMLElement): void {
  bodyEl.querySelector('#ps-gen')?.addEventListener('click', () => { // 生成 panel 总结（带 seq/会议守卫·防串会）
    if (!recapState) return;
    void generatePanelSummary(recapLoadSeq, bodyEl, recapState.meeting.meeting_id);
  });
  bodyEl.querySelector('#ps-refresh')?.addEventListener('click', () => { // 失败/未找到时重拉
    if (!recapState) return;
    recapState.panelSummaryStatus = 'loading';
    renderRecap(bodyEl);
    void loadPanelSummary(recapLoadSeq, bodyEl, recapState.meeting);
  });
}

/** 左侧 nav「panel 总结」入口整页。 */
function renderRecapPanelPage(bodyEl: HTMLElement): void {
  if (!recapState) return;
  bodyEl.innerHTML = panelSummaryHtml();
  wirePanelSummaryButtons(bodyEl);
}

/** 概览：段级中轴时间线。active 段左摘要右手写、quiet 段轴上塌缩站点。点段→详情。 */
function renderRecapOverview(bodyEl: HTMLElement): void {
  if (!recapState) return;
  const { meeting, segments } = recapState;
  // 空态：有飞书会议但无转写无手写——别渲空时间轴误导用户「内容没加载出来」（意图 #3）。
  if (!segments.length) {
    bodyEl.innerHTML = `<div class="rc-note">这场会议已关联飞书会议；panel 总结生成后会自动同步到侧边栏。当前还没有转写和手写档案。</div>`;
    return;
  }
  const stateLabel = meeting.align_state ? ALIGN_LABEL[meeting.align_state] : '约对齐';
  const hasInk = segments.some((s) => s.kind === 'active');
  const note = recapState.transcriptMissing
    ? `⚠ 飞书转写为空或还在生成——下面是<b>本场手写档案</b>（按时间）。转写就绪后再来即可看到会议内容对照。`
    : !hasInk
      ? `本场<b>没有手写锚点</b>——下面是整场转写（点开浏览）。时间<b>非精确对齐</b>·当前「${esc(stateLabel)}」。`
      : `一根时间轴贯穿全会（时间为<b>近似</b>·非精确对齐·当前「${esc(stateLabel)}」）。`
        + `左＝会议在讲什么·右＝你那时的手写；<b>实心●</b>＝你写了东西的段，<b>空心○</b>＝你没写（右侧留空）。点任意段看逐句详情。`;

  const total = Math.max(1, Math.ceil(segments.length / OV_PAGE));
  const p = clampPage(recapState.ovPage, total);
  recapState.ovPage = p;
  const slice = segments.slice(p * OV_PAGE, (p + 1) * OV_PAGE);

  const rows = slice.map((s, j) => {
    const idx = p * OV_PAGE + j;
    if (s.kind === 'active') {
      const sum = s.heuristicSummary;
      const shown = s.marks.slice(0, MARKS_CAP);
      const marksHtml = shown.map((mk) => `<span class="tl-ink${mk.feature_type === 'drawing' ? ' tl-draw' : ''}"><span class="tl-ic">${inkLabel(mk.feature_type)}</span>${esc(inkText(mk.marked_text, mk.feature_type))}</span>`).join('')
        + (s.marks.length > MARKS_CAP ? `<span class="tl-more">＋另 ${s.marks.length - MARKS_CAP} 处</span>` : '');
      // 整段落在 t0 之前（endMs<=0）＝会前记录（M6）：换标签别再叫「会议」误导成会中内容。
      const kindLb = s.endMs <= 0 ? '会前' : '会议';
      const left = `<span class="tl-lb">${kindLb} · ${rng(s.startMs, s.endMs)} · ${s.cues.length}句</span><span class="tl-txt">${esc(sum)}</span><span class="tl-hint">详情 ›</span>`;
      const mid = `<div class="tl-mid"><span class="tl-md"></span><span class="tl-mt">${clk(s.startMs)}</span></div>`;
      return `<div class="tl-row tl-click" data-seg="${idx}"><div class="tl-cl">${left}</div>${mid}<div class="tl-cr">${marksHtml}</div></div>`;
    }
    // quiet（无手写）：内容左置·文字弱化·右侧留空·小空心点。点开仍可读该段转写。
    const left = `<span class="tl-lb">无手写 · ${rng(s.startMs, s.endMs)} · ${s.cues.length}句</span><span class="tl-txt">${esc(s.heuristicSummary)}</span><span class="tl-hint">详情 ›</span>`;
    const mid = `<div class="tl-mid"><span class="tl-md tl-hollow"></span><span class="tl-mt tl-dim">${clk(s.startMs)}</span></div>`;
    return `<div class="tl-row tl-click tl-quiet" data-seg="${idx}"><div class="tl-cl">${left}</div>${mid}<div class="tl-cr"></div></div>`;
  }).join('');

  // 末页（真已到时间线尽头，不是被翻页截断）在最后一段后补一条空态行——脊柱本身靠 CSS flex 拉到页底
  // 不需要这条也能到底，这条纯粹是「后面暂时没有了」的明确交代（用户拍板：左右两侧各放一句「暂时无内容」）。
  const tailEmpty = p === total - 1
    ? `<div class="tl-row tl-empty"><div class="tl-cl"><span class="tl-txt">暂时无内容</span></div>`
      + `<div class="tl-mid"><span class="tl-md tl-pending"></span></div>`
      + `<div class="tl-cr"><span class="tl-txt">暂时无内容</span></div></div>`
    : '';
  bodyEl.innerHTML = `<div class="tl-page"><div class="rc-note">${note}</div>`
    + `<div class="tl-seg"><div class="tl-ax"></div>${rows}${tailEmpty}</div>`
    + pagerHtml('ov', p, total) + `</div>`;

  bodyEl.querySelectorAll<HTMLElement>('[data-seg]').forEach((el) => el.addEventListener('click', () => {
    if (!recapState) return;
    const idx = Number(el.dataset.seg);
    if (!Number.isInteger(idx) || idx < 0 || idx >= recapState.segments.length) return; // 防脏 dataset
    recapState.view = 'detail'; recapState.detailIdx = idx; recapState.dtPage = 0;
    renderRecap(bodyEl); bodyEl.scrollTop = 0;
  }));
  bodyEl.querySelector('#ov-prev')?.addEventListener('click', () => { if (recapState) { recapState.ovPage = p - 1; renderRecap(bodyEl); bodyEl.scrollTop = 0; } });
  bodyEl.querySelector('#ov-next')?.addEventListener('click', () => { if (recapState) { recapState.ovPage = p + 1; renderRecap(bodyEl); bodyEl.scrollTop = 0; } });
}

const NEAR_CUE_MS = 90_000; // 手写卡片下方带「附近转写」引用的最大间隔（超出就不硬凑上下文·近似语义）

/** 段内离手写落点 relMs 最近的一句转写（超出 NEAR_CUE_MS 判无关联，返回 null）。 */
function nearestCue(cues: TranscriptCue[], t: number): { text: string; speaker?: string; before: boolean } | null {
  let best: TranscriptCue | null = null; let bd = Infinity;
  for (const c of cues) { const d = Math.abs(c.startMs - t); if (d < bd) { bd = d; best = c; } }
  if (!best || bd > NEAR_CUE_MS) return null;
  return { text: best.text, speaker: best.speaker, before: best.startMs <= t };
}

/** 详情：单段单栏时间流（转写句 + 手写按时刻共享一条轴·手写卡片带「附近转写」引用）+ 翻页 + 返回概览。 */
function renderRecapDetail(bodyEl: HTMLElement): void {
  if (!recapState) return;
  if (recapState.detailIdx < 0 || recapState.detailIdx >= recapState.segments.length) { recapState.view = 'overview'; renderRecapOverview(bodyEl); return; }
  const seg = recapState.segments[recapState.detailIdx];
  if (!seg) { recapState.view = 'overview'; renderRecapOverview(bodyEl); return; }
  type Item = { t: number; side: 'L' | 'R'; speaker?: string; text: string; feat?: string };
  const items: Item[] = [];
  for (const c of seg.cues) items.push({ t: c.startMs, side: 'L', speaker: c.speaker, text: c.text });
  for (const mk of seg.marks) items.push({ t: mk.relMs, side: 'R', text: inkText(mk.marked_text, mk.feature_type), feat: mk.feature_type });
  items.sort((a, b) => a.t - b.t);

  const total = Math.max(1, Math.ceil(items.length / DT_PAGE));
  const p = clampPage(recapState.dtPage, total);
  recapState.dtPage = p;
  const slice = items.slice(p * DT_PAGE, (p + 1) * DT_PAGE);

  let lastNearKey = ''; // 连续多笔手写离同一句转写最近时，只在第一笔标出来，别把同一句复读一整串
  const rows = slice.map((it) => {
    if (it.side === 'L') {
      lastNearKey = '';
      const sp = it.speaker ? `<span class="tl-sp">${esc(it.speaker)}</span>` : '';
      return `<div class="tl-fit"><span class="tl-ftm">${clk(it.t)}</span><span class="tl-fcue-txt">${sp}${esc(it.text)}</span></div>`;
    }
    const near = nearestCue(seg.cues, it.t);
    const nearKey = near ? `${near.before ? 0 : 1}:${near.speaker || ''}:${near.text}` : '';
    const showNear = !!near && nearKey !== lastNearKey;
    if (near) lastNearKey = nearKey;
    const nearHtml = showNear && near
      ? `<span class="tl-fnear">${near.before ? '之前' : '之后'}${near.speaker ? esc(near.speaker) + '：' : '：'}${esc(near.text)}</span>` : '';
    return `<div class="tl-fit tl-fmark"><span class="tl-ftm">~${clk(it.t)}</span><span class="tl-ink${it.feat === 'drawing' ? ' tl-draw' : ''}"><span class="tl-ic">${inkLabel(it.feat || '')}</span>${esc(it.text)}</span>${nearHtml}</div>`;
  }).join('');

  const sum = seg.heuristicSummary;
  const head = seg.kind === 'active' ? `你在这段写了 ${seg.marks.length} 处` : '这段你没有手写';
  bodyEl.innerHTML = `<div class="tl-dtop"><button class="hbtn" id="tl-back">‹ 返回概览</button><span class="tl-tt">${rng(seg.startMs, seg.endMs)}</span></div>`
    + `<div class="rc-note">${head}：${esc(sum)}（逐句时刻为<b>近似</b>）。</div>`
    + `<div class="tl-flow">${rows}</div>`
    + pagerHtml('dt', p, total);

  bodyEl.querySelector('#tl-back')?.addEventListener('click', () => { if (recapState) { recapState.view = 'overview'; renderRecap(bodyEl); bodyEl.scrollTop = 0; } });
  bodyEl.querySelector('#dt-prev')?.addEventListener('click', () => { if (recapState) { recapState.dtPage = p - 1; renderRecap(bodyEl); bodyEl.scrollTop = 0; } });
  bodyEl.querySelector('#dt-next')?.addEventListener('click', () => { if (recapState) { recapState.dtPage = p + 1; renderRecap(bodyEl); bodyEl.scrollTop = 0; } });
}

// ════ P3 AI 思路总结（接 md-sum·防污染输入·不喂易错精确关系）════

/** 组装喂 AI 的结构化文本：转写（可能截断）+ 手写文字列表（各带近似时间）；**不喂** linked_cue 精确关系。
 *  返回是否截断 + 实际喂了几句，供 summary_source 记录 + UI 透明告知（防"看起来是全文总结"误导）。 */
function buildSummaryPrompt(m: PersistedMeeting, cues: TranscriptCue[], marks: PersistedMark[]): { prompt: string; truncated: boolean; usedCueCount: number } {
  const t0 = meetingT0(m);
  const off = finiteMs(m.align_offset_ms);
  const lines: string[] = [`会议标题：${m.title || '(未命名)'}`];
  if (m.started_at) lines.push(`开始时间：${m.started_at}`);
  lines.push('', '<转写 可能因过长被截断·见末尾标记>');
  let used = 0; let usedCueCount = 0; let truncated = false;
  for (const c of cues) {
    const row = `[${clk(c.startMs)}]${c.speaker ? c.speaker + '：' : ''}${c.text}`;
    if (used + row.length > SUMMARY_TRANSCRIPT_CAP) { lines.push(`…（转写在此截断·后 ${cues.length - usedCueCount} 句未提供·别对未提供部分下结论）`); truncated = true; break; }
    lines.push(row); used += row.length; usedCueCount++;
  }
  lines.push('</转写>', '');
  lines.push('<手写标注 各为用户当时的强调·时间是近似会议相对时刻·非与某句转写的精确对应>');
  if (marks.length) for (const mk of marks) {
    const txt = (mk.marked_text || '').trim();
    lines.push(txt ? `[${clk(mk.abs_timestamp - t0 - off)}] ${txt}` : `[${clk(mk.abs_timestamp - t0 - off)}] （一处${mk.feature_type === 'drawing' ? '图形/圈画' : '无法识别的手写'}·别推断其文字含义）`);
  }
  else lines.push('（本场没有手写标注）');
  lines.push('</手写标注>', '', '请按系统要求产出会后思路总结。');
  return { prompt: lines.join('\n'), truncated, usedCueCount };
}

/** 会后思路总结：拉转写 + 手写档案 → 流式 /api/chat（meeting_summary role·不走 chatTurn 不污染书 buffer）→ 写 summary。 */
export async function summarizeMeeting(meetingId: string, onDelta: (full: string) => void): Promise<string | null> {
  const m = await getMeeting(meetingId);
  if (!m) return null;
  if (!m.feishu_minute_token) { await infoSheet({ title: '先关联飞书妙记', message: '生成思路总结需要先在「会后记录」里关联这场会议的飞书妙记转写。' }); return null; }
  let loaded: { srt: string; cues: TranscriptCue[] } | null;
  try { loaded = await loadTranscript(m); } catch (e) { await infoSheet({ title: '拉取转写失败', message: String((e as Error)?.message || e) }); return null; }
  if (!loaded || !loaded.cues.length) { await infoSheet({ title: '转写为空', message: '没有可用于总结的转写内容。' }); return null; }
  const marks = (await getFoldedMarksByContext('mtg_' + m.meeting_id)).filter((mk) => !mk.is_tombstone).sort((a, b) => a.abs_timestamp - b.abs_timestamp);

  const { prompt, truncated, usedCueCount } = buildSummaryPrompt(m, loaded.cues, marks);
  let full = '';
  let streamDone = false;
  let streamError = '';
  try {
    await postNdjson<{ k?: string; d?: string }>(
      '/api/chat',
      { messages: [{ role: 'user', content: prompt }], role: 'meeting_summary', model: settings.inferModel, maxTokens: 1600 },
      (frame) => {
        if (frame.k === 'e') { streamError = frame.d || '生成中断'; return; }
        if (frame.k === 'done') { streamDone = true; return; }
        if (frame.k === 't' && frame.d) { full += frame.d; onDelta(full); } // 只收正文帧·丢思考帧 r
      },
    );
  } catch (e) { await infoSheet({ title: '生成失败', message: String((e as Error)?.message || e) }); return null; }
  // 流没真完成（中途断/出错）→ 丢弃半截·不写库
  if (streamError || !streamDone) { await infoSheet({ title: '生成失败', message: streamError || '连接中断，已丢弃未完成内容。' }); return null; }
  let summary = full.trim();
  if (!summary) return null;
  // 截断时给 summary 顶一行透明告知（防"看起来是全文总结"误导·UI 直接可见）
  if (truncated) summary = `〔注：本总结基于前 ${usedCueCount}/${loaded.cues.length} 句转写 + 全部手写生成，后半场转写过长未参与〕\n\n${summary}`;
  await updateMeeting(m.meeting_id, {
    summary,
    summary_generated_at: new Date().toISOString(),
    summary_source: { feishu_minute_token: m.feishu_minute_token, align_offset_ms: m.align_offset_ms ?? 0, mark_count: marks.length, cue_count: loaded.cues.length, transcript_truncated: truncated, used_cue_count: usedCueCount },
  });
  return summary;
}
