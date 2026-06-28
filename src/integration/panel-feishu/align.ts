/**
 * WS2-C 会后对照引擎（纯数据·无 DOM/store import·vitest 可测）。
 *
 * ⚠️这是「近似对照」不是「精确对齐」（plan 头号风险）：
 *  - 录音真 t0 拿不到（机器人没入会）→ 用 panel 会议 start_time 近似·误差几秒~几分钟。
 *  - mark `abs_timestamp` 是 `await captureMark` 后落账时刻·比起笔系统性偏后·非笔级精确。
 * 故用**时间窗模型**（每笔取附近 ±windowMs 的转写段·非单句强对应）吸收这些误差，
 * 上层 UI 一律呈现「附近/同时段」+ 校准状态，绝不当精确关联。
 */

// ── 转写 cue（解析自 SRT）──
export interface TranscriptCue {
  index: number;     // 1-based 序号
  startMs: number;   // 相对录音 t=0
  endMs: number;
  speaker?: string;  // "说话人 1" / "Speaker 1" / "张三"，无则 undefined
  text: string;      // 去掉说话人前缀后的正文
  rawText: string;   // 原始（含说话人前缀·多说话人时保留行内信息）
}

// ── 对照输入 ──
export interface AlignMark { mark_id: string; abs_timestamp: number; document_id?: string; page_id?: string }
export interface ProximityInput {
  marks: AlignMark[];
  cues: TranscriptCue[];
  t0AbsMs: number;       // 录音 t0 绝对墙钟近似（= panel start_time）
  offsetMs: number;      // 用户/启发式微调（cueAbs = t0 + offset + cue.startMs）
  windowMs?: number;     // 笔↔句"附近"窗·默认 30s
}

export interface ProximityIndex {
  cueAbs: Array<TranscriptCue & { absStartMs: number; absEndMs: number }>;
  cueToNearbyMarkIds: Map<number, string[]>;   // cue.index → 附近窗内的笔
  markToNearbyCues: Map<string, number[]>;     // mark_id → 附近窗内的 cue.index（按时间近→远）
  orphanMarkIds: string[];                     // 附近窗内无任何转写的笔
  unmatchedCueIndexes: number[];               // 附近窗内无任何笔的 cue
  stats: { markCount: number; cueCount: number; matchedMarkCount: number; matchedCueCount: number; windowMs: number; offsetMs: number };
}

// ── SRT 解析 ──
const BOM = /^﻿/;
const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;

function tsToMs(h: string, m: string, s: string, ms: string): number {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms.padEnd(3, '0').slice(0, 3));
}

// 说话人前缀：行首 "X:" / "X：" 且 X 不含换行、长度克制（防误删正文里的冒号）
const SPEAKER = /^\s*([^\n:：]{1,20})\s*[:：]\s*/;

function splitSpeaker(rawText: string): { speaker?: string; text: string } {
  const m = rawText.match(SPEAKER);
  if (!m) return { text: rawText };
  // 多行多说话人（每行不同前缀）时不剥离·保留行内信息，避免误删
  const lines = rawText.split('\n');
  if (lines.length > 1 && lines.some((l, i) => i > 0 && SPEAKER.test(l))) return { text: rawText };
  return { speaker: m[1].trim(), text: rawText.slice(m[0].length) };
}

/** 解析 SRT → cue[]。健壮：BOM/CRLF/逗点或点毫秒/缺序号/SRT setting 行(align:start…)/有无说话人/中英混排。 */
export function parseSrtTranscript(input: string): TranscriptCue[] {
  const s = (input || '').replace(BOM, '').replace(/\r\n?/g, '\n').trim();
  if (!s) return [];
  const blocks = s.split(/\n[ \t]*\n+/); // 容忍多个空行
  const cues: TranscriptCue[] = [];
  let auto = 0;
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let li = 0;
    let index: number;
    if (/^\d+$/.test(lines[0])) { index = Number(lines[0]); li = 1; }
    else index = ++auto;
    // 找含 --> 的时间行
    const timeLineIdx = lines.findIndex((l, i) => i >= li && l.includes('-->'));
    if (timeLineIdx < 0) continue;
    const times = [...lines[timeLineIdx].matchAll(TIME)];
    if (times.length < 2) continue;
    const startMs = tsToMs(times[0][1], times[0][2], times[0][3], times[0][4]);
    const endMs = tsToMs(times[1][1], times[1][2], times[1][3], times[1][4]);
    if (!(endMs > startMs)) continue;
    const rawText = lines.slice(timeLineIdx + 1).join('\n').trim();
    if (!rawText) continue;
    if (index > auto) auto = index; // 显式序号推进 auto，避免后续混乱
    const { speaker, text } = splitSpeaker(rawText);
    cues.push({ index, startMs, endMs, speaker, text: text.trim() || rawText, rawText });
  }
  return cues;
}

// ── 时间窗对照 ──
/** 给定 marks + cues + t0 + offset + window，构建双向"附近"索引（非单句强对应）。 */
export function buildProximityIndex(input: ProximityInput): ProximityIndex {
  const windowMs = input.windowMs ?? 30_000;
  const base = input.t0AbsMs + input.offsetMs;
  const cueAbs = input.cues
    .map((c) => ({ ...c, absStartMs: base + c.startMs, absEndMs: base + c.endMs }))
    .sort((a, b) => a.absStartMs - b.absStartMs);

  const cueToNearbyMarkIds = new Map<number, string[]>();
  const markToNearbyCues = new Map<string, number[]>();
  for (const c of cueAbs) cueToNearbyMarkIds.set(c.index, []);
  const orphanMarkIds: string[] = [];

  for (const mark of input.marks) {
    const t = mark.abs_timestamp;
    // 命中：mark 时刻落在 [cueStart−window, cueEnd+window] 内（窗吸收 t0/落账延迟误差）
    const hits = cueAbs
      .filter((c) => t >= c.absStartMs - windowMs && t <= c.absEndMs + windowMs)
      .map((c) => ({ index: c.index, gap: gapTo(t, c.absStartMs, c.absEndMs) }))
      .sort((a, b) => a.gap - b.gap);
    if (!hits.length) { orphanMarkIds.push(mark.mark_id); markToNearbyCues.set(mark.mark_id, []); continue; }
    markToNearbyCues.set(mark.mark_id, hits.map((h) => h.index));
    for (const h of hits) cueToNearbyMarkIds.get(h.index)!.push(mark.mark_id);
  }

  const unmatchedCueIndexes: number[] = [];
  let matchedCueCount = 0;
  for (const c of cueAbs) {
    if (cueToNearbyMarkIds.get(c.index)!.length) matchedCueCount++;
    else unmatchedCueIndexes.push(c.index);
  }
  const matchedMarkCount = input.marks.length - orphanMarkIds.length;

  return {
    cueAbs,
    cueToNearbyMarkIds,
    markToNearbyCues,
    orphanMarkIds,
    unmatchedCueIndexes,
    stats: { markCount: input.marks.length, cueCount: input.cues.length, matchedMarkCount, matchedCueCount, windowMs, offsetMs: input.offsetMs },
  };
}

function gapTo(t: number, start: number, end: number): number {
  if (t < start) return start - t;
  if (t > end) return t - end;
  return 0;
}

// ── 初始 offset 推断（默认不自动确认·plan 风险2/可行#7）──
export interface OffsetSuggestion { offsetMs: number; confidence: 'high' | 'medium' | 'low'; reason: string; autoConfirm: boolean }

/**
 * 候选打分推断初始 offset，但**默认不自动确认**——录音真 t0 拿不到、误差可能分钟级、稀疏 marks 易乱选。
 * 只有"多笔且跨足够时间跨度 + 某候选覆盖率明显胜出"才建议 autoConfirm=true；否则 low/medium·待人工"对齐这句到这笔"。
 */
export function inferInitialOffset(input: {
  startedAtMs?: number;
  panelStartTimeMs: number;
  marks: AlignMark[];
  cues: TranscriptCue[];
}): OffsetSuggestion {
  const { startedAtMs, panelStartTimeMs, marks, cues } = input;
  if (!cues.length || !marks.length) {
    return { offsetMs: 0, confidence: 'low', reason: 'no_marks_or_cues', autoConfirm: false };
  }
  const sortedMarks = [...marks].sort((a, b) => a.abs_timestamp - b.abs_timestamp);
  const markSpanMs = sortedMarks[sortedMarks.length - 1].abs_timestamp - sortedMarks[0].abs_timestamp;

  const candidates: Array<{ offset: number; reason: string }> = [
    { offset: 0, reason: 'trust_panel_start_time' },
  ];
  if (startedAtMs != null) candidates.push({ offset: startedAtMs - panelStartTimeMs, reason: 'align_inkloop_started_at' });
  const firstCue = [...cues].sort((a, b) => a.startMs - b.startMs)[0];
  candidates.push({ offset: sortedMarks[0].abs_timestamp - panelStartTimeMs - firstCue.startMs, reason: 'align_first_mark_to_first_cue' });

  const score = (offset: number): number => {
    const idx = buildProximityIndex({ marks: sortedMarks, cues, t0AbsMs: panelStartTimeMs, offsetMs: offset, windowMs: 1500 });
    const coverage = idx.stats.matchedMarkCount / Math.max(1, marks.length);
    const penalty = Math.abs(offset) / 600_000; // 10min 量级软惩罚
    return coverage - penalty;
  };
  const ranked = candidates.map((c) => ({ ...c, s: score(c.offset) })).sort((a, b) => b.s - a.s);
  const best = ranked[0];
  const second = ranked[1];

  // 自动确认门槛：≥3 笔、跨度≥2min、最优明显胜出（差≥0.25 覆盖率）。否则不自动确认。
  const margin = best.s - (second?.s ?? -1);
  const enough = marks.length >= 3 && markSpanMs >= 120_000;
  if (enough && margin >= 0.25 && best.s >= 0.5) {
    return { offsetMs: best.offset, confidence: 'high', reason: best.reason, autoConfirm: true };
  }
  // 默认保守：信 panel start_time（offset=0）·待人工校准
  return { offsetMs: 0, confidence: enough ? 'medium' : 'low', reason: 'default_panel_t0_await_manual', autoConfirm: false };
}
