/**
 * WS2-C V2 分段对轴引擎（纯数据·无 DOM/store·vitest 可测）。
 *
 * 把一场会议沿时间轴切成有序、非重叠、不漏 cue 的段：
 *  - active 段＝你写了东西的时段（含 ≥1 手写）；按时间把相近手写聚成一段，并裹一段上下文转写。
 *  - quiet  段＝你没写的时段（只有转写、无手写）；用一条简介带过。
 * 「你的手写就是会议的目录」——概览按段呈现、无聊段塌缩，精确逐句只在下钻详情时出现。
 *
 * ⚠️同 align.ts：这是「近似对照」非「精确对齐」。relMs = abs_timestamp − t0 − offset 偏后且 t0 近似，
 * 故段边界、手写落点都是「附近/同时段」语义，UI 不得呈现成「这笔＝这句」。
 */

import type { TranscriptCue } from './align';

/** 段内手写（UI 右轴 + 详情用）。relMs＝相对会议时刻；可为负＝会前落笔（M6：不再 clamp ≥0）。 */
export interface SegmentMark {
  mark_id: string;
  relMs: number;
  feature_type: string;   // handwriting / drawing / markup
  marked_text: string;    // 识别文字（可能空）
  page_index: number;
}

/** 一段（active 或 quiet）。cues 按 startMs 升序；active 段 marks 非空。 */
export interface RecapSegment {
  kind: 'active' | 'quiet';
  startMs: number;        // 段起（相对会议 t=0）
  endMs: number;          // 段止
  cues: TranscriptCue[];  // 落在本段的转写句（按 startMs）——并集覆盖全部 cue·零丢失
  marks: SegmentMark[];   // 本段手写（quiet 恒空）
  heuristicSummary: string; // 一句话（转写原文摘句）：active 段主展示文案、quiet 段当简介
}

export interface SegmentInput {
  cues: TranscriptCue[];
  marks: SegmentMark[];   // 调用方已折叠去墓碑、算好 relMs（见 buildSegmentMarks）
  // 调参（默认值即下方常量）
  clusterGapMs?: number;  // 相邻手写 ≤ 此间隔 → 归同一 active 段
  contextPreMs?: number;  // active 段在首笔前裹的上下文
  contextPostMs?: number; // active 段在末笔后裹的上下文
  mergeGapMs?: number;    // 两 active 跨度 ≤ 此间隔 → 合并
}

// 聚类/裹窗调参（按「每个写作爆发＝一段」整定）：相近手写(≤CLUSTER_GAP)归一段、各裹少量上下文转写，
// 仅近乎相接(≤MERGE_GAP)的两段才合并——避免把相隔一两分钟的不同关注点糊成一大段。
const CLUSTER_GAP = 30_000;  // 30s 内的连续手写＝同一爆发
const CONTEXT_PRE = 12_000;  // 段在首笔前裹 12s 上下文
const CONTEXT_POST = 8_000;  // 段在末笔后裹 8s
const MERGE_GAP = 5_000;     // 仅间隔 ≤5s 的两 active 才合并
const SUMMARY_MAX = 28;

/** 由 PersistedMark 列表算 SegmentMark：relMs = abs_timestamp − t0 − offset，按 relMs 升序。
 *  负值＝落笔早于会议 t0（会前记录·M6 不再 clamp ≥0，UI 呈现在时间轴左侧）。
 *  调用方传已折叠、已去墓碑的 marks。t0AbsMs = 录音 t0 近似（panel start）；offsetMs = 人工/启发式微调。 */
export function buildSegmentMarks(
  marks: Array<{ mark_id: string; abs_timestamp: number; feature_type?: string; marked_text?: string; page_index?: number }>,
  t0AbsMs: number,
  offsetMs: number,
): SegmentMark[] {
  const base = t0AbsMs + offsetMs;
  return marks
    .map((m) => ({
      mark_id: m.mark_id,
      relMs: m.abs_timestamp - base,
      feature_type: m.feature_type || 'handwriting',
      marked_text: (m.marked_text || '').trim(),
      page_index: m.page_index ?? 0,
    }))
    .sort((a, b) => a.relMs - b.relMs);
}



/** 启发式一句话：取段内最长 cue 文本截断（最能代表讨论密点）；空段给占位。
 *  概览/详情/导出统一直接用这句（不再另起 LLM 摘要一遍——转写本身就是妙记给的可信原文，没必要二次复述）。 */
function heuristicOf(cues: TranscriptCue[], marks: SegmentMark[]): string {
  if (cues.length) {
    let best = cues[0];
    for (const c of cues) if (c.text.length > best.text.length) best = c;
    const chars = [...best.text.trim()];
    const body = chars.length > SUMMARY_MAX ? chars.slice(0, SUMMARY_MAX).join('') + '…' : chars.join('');
    return body || '（无文字转写）';
  }
  // active 段无附近转写（手写落在转写覆盖之外）
  return marks.length ? '（这段附近没有转写）' : '（无转写）';
}

/** 把相邻手写按 clusterGap 聚成簇（每簇 → 一个 active 段的锚）。marks 须已按 relMs 升序。 */
function clusterMarks(marks: SegmentMark[], gap: number): SegmentMark[][] {
  const groups: SegmentMark[][] = [];
  for (const mk of marks) {
    const g = groups[groups.length - 1];
    if (g && mk.relMs - g[g.length - 1].relMs <= gap) g.push(mk);
    else groups.push([mk]);
  }
  return groups;
}

/**
 * 主分段：cues + marks → 有序非重叠段（active/quiet 交替）。
 * 不变量：① 段按 startMs 升序、互不重叠；② 每个 cue 恰好落进一个段（并集＝全部 cue·零丢失）；
 *        ③ 每个 mark 恰好落进一个 active 段。
 */
export function buildSegments(input: SegmentInput): RecapSegment[] {
  const clusterGap = input.clusterGapMs ?? CLUSTER_GAP;
  const pre = input.contextPreMs ?? CONTEXT_PRE;
  const post = input.contextPostMs ?? CONTEXT_POST;
  const mergeGap = input.mergeGapMs ?? MERGE_GAP;

  const cues = [...input.cues].sort((a, b) => a.startMs - b.startMs);
  const marks = [...input.marks].sort((a, b) => a.relMs - b.relMs);
  if (!cues.length && !marks.length) return [];
  // cue 起止极值：cue.endMs 未必随 startMs 单调 → 取真 min/max（codex A#2·防段止 < 段内某 cue 止）。
  const cueStartMin = cues.length ? cues.reduce((v, c) => Math.min(v, c.startMs), Infinity) : Infinity;
  const cueEndMax = cues.length ? cues.reduce((v, c) => Math.max(v, c.endMs), -Infinity) : -Infinity;

  // 全程无手写 → 整场一段 quiet（仍可下钻读全文）。
  if (!marks.length) {
    return [finishSeg('quiet', cueStartMin, cueEndMax, cues, [])];
  }

  // ① 手写聚簇 → 每簇一个 active 时间窗 [簇首−pre, 簇末+post]。
  //    簇首在会中(≥0)：裹上下文但不越过 t0（clamp ≥0）；簇首在会前(<0)：本就是会前记录，窗口起点＝簇首本身
  //    （不再倒贴 pre——那只是徒增一段无意义的「更早会前」空白，M6）。
  const groups = clusterMarks(marks, clusterGap);
  let spans = groups.map((g) => ({
    start: g[0].relMs >= 0 ? Math.max(0, g[0].relMs - pre) : g[0].relMs,
    end: g[g.length - 1].relMs + post,
    marks: g,
  }));

  // ② 合并跨度过近的 active 窗（避免碎成一堆小段）。
  const merged: typeof spans = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp.start - last.end <= mergeGap) {
      last.end = Math.max(last.end, sp.end);
      last.marks = last.marks.concat(sp.marks);
    } else merged.push({ ...sp });
  }
  spans = merged;

  // ③ 时间轴下界/上界（含越界手写：手写可能落在转写之外）。
  const tMin = Math.min(cueStartMin, spans[0].start);
  const tMax = Math.max(cueEndMax, spans[spans.length - 1].end);

  // ④ 沿轴行走：active 窗外、含 cue 的空隙 → quiet 段；active 窗 → active 段。
  //    cue 归属按 startMs 落在哪个段的 [start,end]。先给每段框定时间界，再灌 cue。
  const frames: Array<{ kind: 'active' | 'quiet'; start: number; end: number; marks: SegmentMark[] }> = [];
  let cursor = tMin;
  for (const sp of spans) {
    if (sp.start > cursor) frames.push({ kind: 'quiet', start: cursor, end: sp.start, marks: [] });
    frames.push({ kind: 'active', start: sp.start, end: sp.end, marks: sp.marks });
    cursor = sp.end;
  }
  if (cursor < tMax) frames.push({ kind: 'quiet', start: cursor, end: tMax, marks: [] });

  // ⑤ 灌 cue：每 cue 按 startMs 落进覆盖它的 frame；落在边界外的（理论不该有）兜进最近 frame，保证零丢失。
  const bucket: TranscriptCue[][] = frames.map(() => []);
  for (const c of cues) {
    let fi = frames.findIndex((f) => c.startMs >= f.start && c.startMs < f.end);
    if (fi < 0) fi = frames.findIndex((f) => c.startMs >= f.start && c.startMs <= f.end); // 含右端点
    if (fi < 0) fi = nearestFrame(frames, c.startMs); // 兜底：贴最近段
    bucket[fi].push(c);
  }

  // ⑥ 收口：丢掉「无 cue 的 quiet 段」（纯空隙不展示）；active 段恒保留（含手写）。
  //    段时间界＝frame 边界（frames 由游标行走铺成·连续且不重叠）→ 直接用，保证段间不重叠（别再 min/max 撑出界）。
  //    ⚠️quiet 段单独 clamp startMs≥0（codex 抓：会前 active 段后紧跟的 quiet 段会继承负 cursor，quiet 段本无手写、
  //    只用来兜 cue——而 cue.startMs 恒≥0，"会前 quiet" 没有对应语义，UI 会显示成误导的负时间范围）。
  //    clamp 只发生在这里（灌 cue 时用的还是真实 frame 边界），不影响 cue 归属；active 段的负 startMs 不变（M6 本意）。
  const out: RecapSegment[] = [];
  frames.forEach((f, i) => {
    const segCues = bucket[i];
    if (f.kind === 'quiet' && !segCues.length) return;
    if (f.kind === 'quiet') {
      const start = Math.max(0, f.start);
      out.push(finishSeg('quiet', start, Math.max(start, f.end), segCues, []));
      return;
    }
    out.push(finishSeg('active', f.start, f.end, segCues, f.marks));
  });
  return out;
}

function finishSeg(kind: 'active' | 'quiet', startMs: number, endMs: number, cues: TranscriptCue[], marks: SegmentMark[]): RecapSegment {
  // 不再 clamp ≥0：会前 active 段的负 startMs 要保留（M6·UI 靠它渲成时间轴左侧「会前」段）。
  return { kind, startMs, endMs, cues, marks, heuristicSummary: heuristicOf(cues, marks) };
}

function nearestFrame(frames: Array<{ start: number; end: number }>, t: number): number {
  let bi = 0, bd = Infinity;
  frames.forEach((f, i) => { const d = t < f.start ? f.start - t : t > f.end ? t - f.end : 0; if (d < bd) { bd = d; bi = i; } });
  return bi;
}
