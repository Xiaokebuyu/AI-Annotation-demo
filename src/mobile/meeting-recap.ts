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
import { parseSrtTranscript, buildProximityIndex, type TranscriptCue, type ProximityIndex } from '../integration/panel-feishu/align';
import type { PersistedMeeting, PersistedMark } from '../core/store-format';

const PAGE_SIZE = 40;            // 每页转写句数
const QUALITY_WINDOW_MS = 45_000; // 质量态「附近」窗（比对照略宽·只标有无附近手写）
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

// ════ P2 recap 阅读视图：转写句列 + 手写档案（纯文本·近似对照）════

interface RecapData { meeting: PersistedMeeting; cues: TranscriptCue[]; marks: PersistedMark[]; prox: ProximityIndex }
let recapState: { data: RecapData; page: number } | null = null;
// 防异步串会：打开 A 后快速返回/打开 B，A 的晚到结果不能覆盖 B 的视图/状态。
let recapLoadSeq = 0;
export function resetRecapView(): void { recapLoadSeq++; recapState = null; }
function recapAlive(seq: number, bodyEl: HTMLElement): boolean {
  return seq === recapLoadSeq && document.body.dataset.mtg === 'recap' && document.body.contains(bodyEl);
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
const archiveText = (mk: PersistedMark): string => (mk.marked_text || '').trim() || (mk.feature_type === 'drawing' ? '（图形标注/圈画）' : '（手写）');

/** 进 recap 视图：拉转写 + 手写档案 + 构建质量索引 → 填 #recap-body。bodyEl/titleEl 由 meeting.ts 给。 */
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
  if (!loaded || !loaded.cues.length) { bodyEl.innerHTML = '<p class="rc-note">转写为空或还在生成。</p>'; return; }

  const marks = (await getFoldedMarksByContext('mtg_' + m.meeting_id)).filter((mk) => !mk.is_tombstone).sort((a, b) => a.abs_timestamp - b.abs_timestamp);
  if (!recapAlive(seq, bodyEl)) return;
  const t0 = m.feishu_recording_t0 ?? m.panel_meeting_start ?? (m.started_at ? Date.parse(m.started_at) : 0);
  const prox = buildProximityIndex({
    marks: marks.map((mk) => ({ mark_id: mk.mark_id, abs_timestamp: mk.abs_timestamp, document_id: mk.document_id, page_id: mk.page_id })),
    cues: loaded.cues, t0AbsMs: t0, offsetMs: m.align_offset_ms ?? 0, windowMs: QUALITY_WINDOW_MS,
  });
  recapState = { data: { meeting: m, cues: loaded.cues, marks, prox }, page: 0 };
  renderRecapBody(bodyEl);
}

function renderRecapBody(bodyEl: HTMLElement): void {
  if (!recapState) return;
  const { data, page } = recapState;
  const { meeting, cues, marks, prox } = data;
  const totalPages = Math.max(1, Math.ceil(cues.length / PAGE_SIZE));
  const p = Math.min(page, totalPages - 1);
  const slice = cues.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);

  const stateLabel = meeting.align_state ? ALIGN_LABEL[meeting.align_state] : '约对齐';
  const orphan = prox.orphanMarkIds.length;
  const note = `时间对照为<b>近似</b>（按会议开始时刻估算·非精确对齐）·当前「${esc(stateLabel)}」。`
    + `转写 ${cues.length} 句·手写 ${marks.length} 处·其中 ${prox.stats.matchedCueCount} 句附近有手写`
    + (orphan ? `·另有 ${orphan} 处手写未靠近任何转写。` : '。');

  const cueRows = slice.map((c) => {
    const hasInk = (prox.cueToNearbyMarkIds.get(c.index) ?? []).length;
    const sp = c.speaker ? `<span class="sp">${esc(c.speaker)}：</span>` : '';
    const nb = hasInk ? `<span class="nb">✎${hasInk}</span>` : '';
    return `<div class="rc-cue${hasInk ? ' has' : ''}"><div class="t">${clk(c.startMs)}</div><div class="x">${sp}${esc(c.text)}${nb}</div></div>`;
  }).join('');

  const t0 = meeting.feishu_recording_t0 ?? meeting.panel_meeting_start ?? (meeting.started_at ? Date.parse(meeting.started_at) : 0);
  const off = meeting.align_offset_ms ?? 0;
  const archRows = marks.length
    ? marks.map((mk) => {
        const txt = (mk.marked_text || '').trim();
        const x = txt ? esc(txt) : `<span style="color:var(--ink2)">${mk.feature_type === 'drawing' ? '（图形标注/圈画）' : '（未识别·原笔迹在第' + (mk.page_index + 1) + '页）'}</span>`;
        const pg = `<span class="nb" style="color:var(--ink2)">第${mk.page_index + 1}页</span>`;
        return `<div class="rc-arch"><div class="t">${clk(mk.abs_timestamp - t0 - off)}</div><div class="x">${x} ${pg}</div></div>`;
      }).join('')
    : '<div class="empty">这场会议没有留下手写档案。</div>';

  const pager = totalPages > 1
    ? `<div class="rc-pager"><button class="hbtn" id="rc-prev"${p === 0 ? ' disabled style="opacity:.4"' : ''}>‹ 上一页</button><span class="t" style="font:11px var(--mono)">第 ${p + 1}/${totalPages} 页</span><button class="hbtn" id="rc-next"${p >= totalPages - 1 ? ' disabled style="opacity:.4"' : ''}>下一页 ›</button></div>`
    : '';

  bodyEl.innerHTML = `<div class="rc-note">${note}</div>`
    + `<div class="rc-h">会议转写<span class="mb">✎ = 附近±45s 有手写·非精确对应本句</span></div>${cueRows}${pager}`
    + `<div class="rc-h">你的手写档案<span class="mb">按会议相对时刻</span></div>${archRows}`;

  bodyEl.querySelector('#rc-prev')?.addEventListener('click', () => { if (recapState) { recapState.page = p - 1; renderRecapBody(bodyEl); bodyEl.scrollTop = 0; } });
  bodyEl.querySelector('#rc-next')?.addEventListener('click', () => { if (recapState) { recapState.page = p + 1; renderRecapBody(bodyEl); bodyEl.scrollTop = 0; } });
}

// ════ P3 AI 思路总结（接 md-sum·防污染输入·不喂易错精确关系）════

/** 组装喂 AI 的结构化文本：转写（可能截断）+ 手写文字列表（各带近似时间）；**不喂** linked_cue 精确关系。
 *  返回是否截断 + 实际喂了几句，供 summary_source 记录 + UI 透明告知（防"看起来是全文总结"误导）。 */
function buildSummaryPrompt(m: PersistedMeeting, cues: TranscriptCue[], marks: PersistedMark[]): { prompt: string; truncated: boolean; usedCueCount: number } {
  const t0 = m.feishu_recording_t0 ?? m.panel_meeting_start ?? (m.started_at ? Date.parse(m.started_at) : 0);
  const off = m.align_offset_ms ?? 0;
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
