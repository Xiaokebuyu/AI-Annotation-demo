import { describe, expect, it } from 'vitest';
import { buildSegments, buildSegmentMarks, type SegmentMark } from './segment';
import type { TranscriptCue } from './align';

// 造 cue：start/end 秒 + 文本（index 自增）。
const cue = (i: number, startS: number, endS: number, text: string): TranscriptCue =>
  ({ index: i, startMs: startS * 1000, endMs: endS * 1000, text, rawText: text });
const mark = (id: string, relS: number, text = '笔', feat = 'handwriting'): SegmentMark =>
  ({ mark_id: id, relMs: relS * 1000, feature_type: feat, marked_text: text, page_index: 0 });

// 全部段的 cue 并集（验零丢失）
const allCueIdx = (segs: ReturnType<typeof buildSegments>) => segs.flatMap((s) => s.cues.map((c) => c.index)).sort((a, b) => a - b);

describe('buildSegments（分段对轴）', () => {
  // 14 句、5 笔，仿真实会议
  const cues: TranscriptCue[] = [
    cue(1, 3, 11, 'aaa'), cue(2, 12, 21, 'bbbb'), cue(3, 22, 33, 'cccccc'),
    cue(4, 34, 45, 'dd'), cue(5, 46, 58, 'eeeee'), cue(6, 60, 70, 'ff'),
    cue(7, 71, 82, 'gggggggg'), cue(8, 84, 95, 'hh'), cue(9, 97, 108, 'iii'),
    cue(10, 110, 122, 'jjjj'), cue(11, 124, 135, 'kk'), cue(12, 137, 148, 'lll'),
    cue(13, 150, 160, 'mm'), cue(14, 161, 170, 'nn'),
  ];
  const marks = [mark('a', 15), mark('b', 50), mark('c', 72), mark('d', 130, '', 'drawing'), mark('e', 152)];

  it('交替产出 active / quiet 段·都非空', () => {
    const segs = buildSegments({ cues, marks });
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.some((s) => s.kind === 'active')).toBe(true);
    expect(segs.some((s) => s.kind === 'quiet')).toBe(true);
    // active 段必有手写·quiet 段必无
    for (const s of segs) {
      if (s.kind === 'active') expect(s.marks.length).toBeGreaterThan(0);
      else expect(s.marks.length).toBe(0);
    }
  });

  it('不变量①段按 startMs 升序·互不重叠', () => {
    const segs = buildSegments({ cues, marks });
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].startMs).toBeGreaterThanOrEqual(segs[i - 1].startMs);
      expect(segs[i].startMs).toBeGreaterThanOrEqual(segs[i - 1].endMs - 1); // 允许贴边
    }
  });

  it('不变量②每个 cue 恰好落进一个段·零丢失', () => {
    const segs = buildSegments({ cues, marks });
    expect(allCueIdx(segs)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    // 无重复归属
    const flat = segs.flatMap((s) => s.cues.map((c) => c.index));
    expect(flat.length).toBe(14);
  });

  it('不变量③每个 mark 恰好落进一个 active 段', () => {
    const segs = buildSegments({ cues, marks });
    const ids = segs.flatMap((s) => s.marks.map((m) => m.mark_id)).sort();
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('相近手写聚成同一 active 段（cluster）', () => {
    // 三笔都在 10/12/14s（间隔 2s ≤ 30s 簇）→ 应归一个 active 段
    const ms = [mark('x', 10), mark('y', 12), mark('z', 14)];
    const segs = buildSegments({ cues, marks: ms });
    const active = segs.filter((s) => s.kind === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].marks).toHaveLength(3);
  });

  it('全程无手写 → 整场一段 quiet·含全部 cue', () => {
    const segs = buildSegments({ cues, marks: [] });
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('quiet');
    expect(allCueIdx(segs)).toHaveLength(14);
  });

  it('手写越界（落在所有转写之后）→ active 段保留·可无 cue', () => {
    const segs = buildSegments({ cues, marks: [mark('late', 999)] });
    const active = segs.filter((s) => s.kind === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].marks[0].mark_id).toBe('late');
    // 全部 cue 仍不丢
    expect(allCueIdx(segs)).toHaveLength(14);
  });

  it('启发式摘要取段内最长 cue 截断', () => {
    const segs = buildSegments({ cues: [cue(1, 0, 5, '短'), cue(2, 6, 10, '这是一段更长的讨论内容主体')], marks: [mark('m', 3)] });
    expect(segs[0].heuristicSummary).toContain('更长的讨论');
  });

  it('cueHash 同内容稳定·内容变即变', () => {
    const a = buildSegments({ cues, marks });
    const b = buildSegments({ cues, marks });
    expect(a.map((s) => s.cueHash)).toEqual(b.map((s) => s.cueHash));
    const changed = buildSegments({ cues: [...cues.slice(0, 13), cue(14, 161, 170, '改了')], marks });
    // 至少含末句的那段 hash 变了
    expect(changed.map((s) => s.cueHash)).not.toEqual(a.map((s) => s.cueHash));
  });
});

describe('buildSegmentMarks（relMs 换算）', () => {
  const t0 = 1_000_000_000_000;
  it('relMs = abs − t0 − offset·按 relMs 升序', () => {
    const out = buildSegmentMarks(
      [{ mark_id: 'b', abs_timestamp: t0 + 50_000 }, { mark_id: 'a', abs_timestamp: t0 + 10_000 }],
      t0, 0,
    );
    expect(out.map((m) => m.mark_id)).toEqual(['a', 'b']);
    expect(out[0].relMs).toBe(10_000);
  });

  it('负相对时间（笔早于 t0）clamp 到 0', () => {
    const out = buildSegmentMarks([{ mark_id: 'x', abs_timestamp: t0 - 5_000 }], t0, 0);
    expect(out[0].relMs).toBe(0);
  });

  it('offset 平移', () => {
    const out = buildSegmentMarks([{ mark_id: 'x', abs_timestamp: t0 + 30_000 }], t0, 10_000);
    expect(out[0].relMs).toBe(20_000);
  });
});
