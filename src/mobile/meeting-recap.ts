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
import { listRecentPanelMeetings, getMinuteTranscript, type PanelFeishuMeeting } from '../integration/panel-feishu/client';
import { parseSrtTranscript, type TranscriptCue } from '../integration/panel-feishu/align';
import { buildSegments, buildSegmentMarks, digestCacheKey, type RecapSegment } from '../integration/panel-feishu/segment';
import type { PersistedMeeting, PersistedMark } from '../core/store-format';

const SUMMARY_TRANSCRIPT_CAP = 16000; // 喂 AI 的转写字数软上限（长转写分块留 P5）

const ALIGN_LABEL: Record<NonNullable<PersistedMeeting['align_state']>, string> = {
  uncalibrated: '未校准',
  approx: '约对齐',
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
  const associated = !!m.feishu_minute_token;
  if (associated) {
    const state = m.align_state ? ALIGN_LABEL[m.align_state] : '约对齐';
    const linked = [m.feishu_topic, m.panel_meeting_start ? fmtClock(m.panel_meeting_start) : ''].filter(Boolean).join(' · ');
    return `<section class="msec" id="recap-sec"><div class="msec-h"><span class="mt">会后记录</span><span class="mb">${esc(state)}</span></div>`
      + `<div class="matcard" id="recap-open"><span class="ic">${SVG_DOC}</span><div><div class="nm">飞书妙记转写</div>`
      + `<div class="mt">已关联${linked ? '：' + esc(linked) : ''} · 点开读转写 + 手写档案</div></div></div>`
      + `<div class="dact" style="padding:8px 0 2px"><button class="hbtn" id="recap-reassoc">换关联</button></div></section>`;
  }
  return `<section class="msec" id="recap-sec"><div class="msec-h"><span class="mt">会后记录</span><span class="mb">需关联飞书妙记</span></div>`
    + `<div class="empty">把这场会议关联到对应的飞书妙记，会后就能读完整转写、看自己的手写档案。</div>`
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
    const tok = mt.minute_token ? '有转写' : '无转写';
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
  // offset 推断留到读转写时（需 cues）；此处先存近似态 offset=0
  await updateMeeting(m.meeting_id, {
    feishu_meeting_id: mt.meeting_id,
    feishu_meeting_no: mt.meeting_no,
    feishu_topic: mt.topic,
    feishu_minute_token: mt.minute_token,
    feishu_minute_url: mt.minute_url ?? undefined,
    panel_meeting_start: mt.start_time,
    feishu_recording_t0: mt.start_time, // 当前用 panel start 近似；真录音 t0 待 vc 事件
    align_offset_ms: 0,
    align_state: 'approx',
    feishu_match_confirmed_at: new Date().toISOString(),
  });
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
const DIGEST_CONCURRENCY = 4; // active 段 AI 摘要并发上限
const MARKS_CAP = 3;          // 概览段内手写最多列几条（余下折成「＋另 N 处」·详情看全）

interface RecapV2 {
  meeting: PersistedMeeting;
  segments: RecapSegment[];
  digests: Record<string, string>; // 段 cueHash → AI 一句话（缓存命中 + 新生成合并）
  view: 'overview' | 'detail';
  detailIdx: number;            // detail 视图当前段下标
  ovPage: number;               // 概览翻页
  dtPage: number;               // 详情翻页
  bodyEl: HTMLElement;          // 供 recapHandleBack 复用重渲
  transcriptMissing: boolean;   // 转写为空/未就绪但仍展示手写档案（提示用·防误以为没内容）
}
let recapState: RecapV2 | null = null;
// 防异步串会：打开 A 后快速返回/打开 B，A 的晚到结果（转写/AI 摘要）不能覆盖 B 的视图/状态。
let recapLoadSeq = 0;
export function resetRecapView(): void { recapLoadSeq++; recapState = null; }
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

const clk = (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const rng = (a: number, b: number): string => `${clk(a)}–${clk(b)}`;
// t0/offset 防 NaN（started_at 可能解析失败·codex A#1）：取第一个有限值，否则 0。
const finiteMs = (...xs: Array<number | null | undefined>): number => { for (const x of xs) if (typeof x === 'number' && Number.isFinite(x)) return x; return 0; };
const meetingT0 = (m: PersistedMeeting): number => finiteMs(m.feishu_recording_t0, m.panel_meeting_start, m.started_at ? Date.parse(m.started_at) : NaN);
const inkLabel = (feat: string): string => (feat === 'drawing' ? '◇ 图形' : '✎ 手写');
const inkText = (text: string, feat: string): string => text.trim() || (feat === 'drawing' ? '（图形标注 / 圈画）' : '（未识别手写）');

/** 进 recap 视图：拉转写 + 手写档案 → 分段 → 渲染概览（段级时间线）；并异步补 active 段 AI 摘要。 */
export async function loadRecapView(meetingId: string, bodyEl: HTMLElement, titleEl: HTMLElement): Promise<void> {
  const seq = ++recapLoadSeq;
  recapState = null;
  bodyEl.innerHTML = '<p class="rc-note">正在拉取转写…</p>';
  const m = await getMeeting(meetingId);
  if (!recapAlive(seq, bodyEl)) return;
  if (!m) { bodyEl.innerHTML = '<p class="rc-note">会议不存在。</p>'; return; }
  titleEl.textContent = `${m.title || '会议'} · 会后记录`;
  if (!m.feishu_minute_token) { bodyEl.innerHTML = '<p class="rc-note">尚未关联飞书妙记。</p>'; return; }

  let loaded: { srt: string; cues: TranscriptCue[] } | null;
  try { loaded = await loadTranscript(m); }
  catch (e) { if (!recapAlive(seq, bodyEl)) return; bodyEl.innerHTML = `<p class="rc-note">拉取转写失败：${esc(String((e as Error)?.message || e))}（已关联的转写若曾缓存可离线读）。</p>`; return; }
  if (!recapAlive(seq, bodyEl)) return;
  const cues = loaded?.cues ?? [];

  const marks = (await getFoldedMarksByContext('mtg_' + m.meeting_id)).filter((mk) => !mk.is_tombstone).sort((a, b) => a.abs_timestamp - b.abs_timestamp);
  if (!recapAlive(seq, bodyEl)) return;
  const t0 = meetingT0(m);
  const segMarks = buildSegmentMarks(
    marks.map((mk) => ({ mark_id: mk.mark_id, abs_timestamp: mk.abs_timestamp, feature_type: mk.feature_type, marked_text: mk.marked_text, page_index: mk.page_index })),
    t0, finiteMs(m.align_offset_ms),
  );
  // 转写与手写都空 → 无可展示；但**转写未就绪而有手写时仍要把手写档案露出来**（否则用户的手写被整页静默隐藏）。
  if (!cues.length && !segMarks.length) { bodyEl.innerHTML = '<p class="rc-note">转写为空或还在生成，本场也没有手写档案。</p>'; return; }

  const segments = buildSegments({ cues, marks: segMarks });
  recapState = { meeting: m, segments, digests: { ...(m.segment_digests ?? {}) }, view: 'overview', detailIdx: 0, ovPage: 0, dtPage: 0, bodyEl, transcriptMissing: !cues.length };
  renderRecap(bodyEl);
  if (cues.length) void generateDigests(seq, bodyEl, m, segments); // 有转写才补 AI 段摘要（无转写没东西可总结）
}

/** 只留当前分段 active 段的缓存键（剪掉旧分段/旧 prompt 版本残留键·codex A#4）。 */
function keepCurrentDigests(segments: RecapSegment[], digests: Record<string, string>): Record<string, string> {
  const keep: Record<string, string> = {};
  for (const s of segments) { const k = digestCacheKey(s); if (s.kind === 'active' && digests[k]) keep[k] = digests[k]; }
  return keep;
}
const sameMap = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const ak = Object.keys(a); return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
};

// ── active 段一句话 AI 摘要（缺缓存才调·并发受限·完成后单次重渲·失败回退启发式）──
async function generateDigests(seq: number, bodyEl: HTMLElement, m: PersistedMeeting, segments: RecapSegment[]): Promise<void> {
  // 全无 pending 也要把缓存剪到当前键（旧分段/旧 prompt 版本残留键清掉·A#4），与重渲解耦。
  const persistPrune = async (): Promise<void> => {
    if (seq !== recapLoadSeq || !recapState) return;
    const keep = keepCurrentDigests(segments, recapState.digests);
    if (!sameMap(m.segment_digests ?? {}, keep)) { try { await updateMeeting(m.meeting_id, { segment_digests: keep }); } catch { /* 缓存失败不阻断显示 */ } }
  };
  const pending = segments.filter((s) => s.kind === 'active' && s.cues.length && !recapState?.digests[digestCacheKey(s)]);
  if (!pending.length) { await persistPrune(); return; }
  let changed = false;
  await runPool(pending, DIGEST_CONCURRENCY, async (seg) => {
    const text = await digestSegment(seg);
    if (!text || seq !== recapLoadSeq || !recapState) return;
    recapState.digests[digestCacheKey(seg)] = text;
    changed = true;
  });
  if (seq !== recapLoadSeq || !recapState) return;
  await persistPrune();
  if (changed && recapAlive(seq, bodyEl)) renderRecap(bodyEl);
}

/** 单段 AI 一句话摘要（segment_digest role·纯文本·不走 chatTurn 不污染书 buffer）。失败/中断返回 null（回退启发式）。 */
async function digestSegment(seg: RecapSegment): Promise<string | null> {
  const transcript = seg.cues.map((c) => (c.speaker ? c.speaker + '：' : '') + c.text).join('\n');
  const prompt = `会议某时段转写片段（请只据此用一句话概括）：\n${transcript}`;
  let full = ''; let done = false; let err = '';
  try {
    await postNdjson<{ k?: string; d?: string }>(
      '/api/chat',
      { messages: [{ role: 'user', content: prompt }], role: 'segment_digest', model: settings.inferModel, maxTokens: 120 },
      (frame) => {
        if (frame.k === 'e') { err = frame.d || '中断'; return; }
        if (frame.k === 'done') { done = true; return; }
        if (frame.k === 't' && frame.d) full += frame.d;
      },
    );
  } catch { return null; }
  if (err || !done) return null;
  const out = full.trim().replace(/^摘要[:：]\s*/, '').replace(/[。.\s]+$/, '');
  return out || null;
}

/** 并发池：items 经 n 路 worker 跑 fn，单项失败不影响其它。 */
async function runPool<T>(items: T[], n: number, fn: (it: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async (): Promise<void> => { while (i < items.length) { const it = items[i++]; await fn(it).catch(() => {}); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function renderRecap(bodyEl: HTMLElement): void {
  if (!recapState) return;
  if (recapState.view === 'detail') renderRecapDetail(bodyEl);
  else renderRecapOverview(bodyEl);
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

/** 概览：段级中轴时间线。active 段左摘要右手写、quiet 段轴上塌缩站点。点段→详情。 */
function renderRecapOverview(bodyEl: HTMLElement): void {
  if (!recapState) return;
  const { meeting, segments, digests } = recapState;
  const stateLabel = meeting.align_state ? ALIGN_LABEL[meeting.align_state] : '约对齐';
  const hasInk = segments.some((s) => s.kind === 'active');
  const note = recapState.transcriptMissing
    ? `⚠ 飞书转写为空或还在生成——下面是<b>本场手写档案</b>（按时间）。转写就绪后再来即可看到会议内容对照。`
    : !hasInk
      ? `本场<b>没有手写锚点</b>——下面是整场转写（点开浏览）。时间为<b>近似</b>·非精确对齐。`
      : `一根时间轴贯穿全会（时间为<b>近似</b>·非精确对齐·当前「${esc(stateLabel)}」）。`
        + `左＝会议在讲什么·右＝你那时的手写；<b>实心●</b>＝你写了东西的段，<b>空心○</b>＝你没写（右侧留空）。点任意段看逐句详情。`;

  const total = Math.max(1, Math.ceil(segments.length / OV_PAGE));
  const p = clampPage(recapState.ovPage, total);
  recapState.ovPage = p;
  const slice = segments.slice(p * OV_PAGE, (p + 1) * OV_PAGE);

  const rows = slice.map((s, j) => {
    const idx = p * OV_PAGE + j;
    if (s.kind === 'active') {
      const sum = digests[digestCacheKey(s)] || s.heuristicSummary;
      const shown = s.marks.slice(0, MARKS_CAP);
      const marksHtml = shown.map((mk) => `<span class="tl-ink${mk.feature_type === 'drawing' ? ' tl-draw' : ''}"><span class="tl-ic">${inkLabel(mk.feature_type)}</span>${esc(inkText(mk.marked_text, mk.feature_type))}</span>`).join('')
        + (s.marks.length > MARKS_CAP ? `<span class="tl-more">＋另 ${s.marks.length - MARKS_CAP} 处</span>` : '');
      const left = `<span class="tl-lb">会议 · ${rng(s.startMs, s.endMs)} · ${s.cues.length}句</span><span class="tl-txt">${esc(sum)}</span><span class="tl-hint">详情 ›</span>`;
      const mid = `<div class="tl-mid"><span class="tl-md"></span><span class="tl-mt">${clk(s.startMs)}</span></div>`;
      return `<div class="tl-row tl-click" data-seg="${idx}"><div class="tl-cl">${left}</div>${mid}<div class="tl-cr">${marksHtml}</div></div>`;
    }
    // quiet（无手写）：内容左置·文字弱化·右侧留空·小空心点。点开仍可读该段转写。
    const left = `<span class="tl-lb">无手写 · ${rng(s.startMs, s.endMs)} · ${s.cues.length}句</span><span class="tl-txt">${esc(s.heuristicSummary)}</span><span class="tl-hint">详情 ›</span>`;
    const mid = `<div class="tl-mid"><span class="tl-md tl-hollow"></span><span class="tl-mt tl-dim">${clk(s.startMs)}</span></div>`;
    return `<div class="tl-row tl-click tl-quiet" data-seg="${idx}"><div class="tl-cl">${left}</div>${mid}<div class="tl-cr"></div></div>`;
  }).join('');

  bodyEl.innerHTML = `<div class="rc-note">${note}</div>`
    + `<div class="tl-seg"><div class="tl-ax"></div>${rows}</div>`
    + pagerHtml('ov', p, total);

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

/** 详情：单段句级中轴时间线（左转写右手写按时刻）+ 翻页 + 返回概览。 */
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

  const rows = slice.map((it) => {
    if (it.side === 'L') {
      // 转写句：左·小空心点·精确时刻（cue 相对录音 t=0 是准的）
      const mid = `<div class="tl-mid"><span class="tl-md tl-hollow"></span><span class="tl-mt tl-dim">${clk(it.t)}</span></div>`;
      const sp = it.speaker ? `<span class="tl-sp">${esc(it.speaker)}</span>` : '';
      return `<div class="tl-row"><div class="tl-cl"><span class="tl-txt">${sp}${esc(it.text)}</span></div>${mid}<div class="tl-cr"></div></div>`;
    }
    // 手写：右·实心点·时刻带「~」（落点是估算的·别当精确锚定）
    const mid = `<div class="tl-mid"><span class="tl-md"></span><span class="tl-mt">~${clk(it.t)}</span></div>`;
    return `<div class="tl-row"><div class="tl-cl"></div>${mid}<div class="tl-cr"><span class="tl-ink${it.feat === 'drawing' ? ' tl-draw' : ''}"><span class="tl-ic">${inkLabel(it.feat || '')}</span>${esc(it.text)}</span></div></div>`;
  }).join('');

  const sum = recapState.digests[digestCacheKey(seg)] || seg.heuristicSummary;
  const head = seg.kind === 'active' ? `你在这段写了 ${seg.marks.length} 处` : '这段你没有手写';
  bodyEl.innerHTML = `<div class="tl-dtop"><button class="hbtn" id="tl-back">‹ 返回概览</button><span class="tl-tt">${rng(seg.startMs, seg.endMs)}</span></div>`
    + `<div class="rc-note">${head}：${esc(sum)}（逐句时刻为<b>近似</b>）。</div>`
    + `<div class="tl-seg"><div class="tl-ax"></div>${rows}</div>`
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
