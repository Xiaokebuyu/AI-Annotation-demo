import { describe, expect, it } from 'vitest';
import { parseSrtTranscript, buildProximityIndex, inferInitialOffset, type AlignMark } from './align';

const SRT = `1
00:00:08,070 --> 00:00:08,710
说话人 1: Hello, hello.

2
00:00:17,380 --> 00:00:23,940
说话人 1: 这又是一次测试，我相信

3
00:01:05,000 --> 00:01:09,500
Speaker 2: ok let's move on
`;

describe('parseSrtTranscript', () => {
  it('解析基本 SRT + 说话人前缀 + 中英混排', () => {
    const cues = parseSrtTranscript(SRT);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toMatchObject({ index: 1, startMs: 8070, endMs: 8710, speaker: '说话人 1', text: 'Hello, hello.' });
    expect(cues[1].text).toBe('这又是一次测试，我相信');
    expect(cues[2]).toMatchObject({ index: 3, startMs: 65000, speaker: 'Speaker 2', text: "ok let's move on" });
  });

  it('容忍 BOM / CRLF / 多空行 / 缺序号 / 点毫秒 / SRT setting 行', () => {
    const messy = '﻿00:00:01.500 --> 00:00:02.000 align:start position:0%\r\n无序号无说话人\r\n\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n甲：你好\r\n';
    const cues = parseSrtTranscript(messy);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ index: 1, startMs: 1500, endMs: 2000, speaker: undefined, text: '无序号无说话人' });
    expect(cues[1]).toMatchObject({ startMs: 3000, speaker: '甲', text: '你好' });
  });

  it('空/无效输入返回空数组·end<=start 的 cue 丢弃', () => {
    expect(parseSrtTranscript('')).toEqual([]);
    expect(parseSrtTranscript('1\n00:00:05,000 --> 00:00:05,000\nx')).toEqual([]); // 零时长
    expect(parseSrtTranscript('garbage no time')).toEqual([]);
  });

  it('多说话人同 cue（每行不同前缀）不剥离·保留行内信息', () => {
    const cues = parseSrtTranscript('1\n00:00:01,000 --> 00:00:02,000\n甲：你好\n乙：再见');
    expect(cues[0].speaker).toBeUndefined();
    expect(cues[0].text).toContain('甲：你好');
    expect(cues[0].text).toContain('乙：再见');
  });

  it('解码 HTML 实体·不进 UI/summary', () => {
    const cues = parseSrtTranscript('1\n00:00:01,000 --> 00:00:02,000\nA &amp; B &lt;tag&gt; &#48;');
    expect(cues[0].text).toBe('A & B <tag> 0');
  });

  it('数字起头正文不误判说话人（"10:30 开始"）·链接不误剥', () => {
    const c1 = parseSrtTranscript('1\n00:00:01,000 --> 00:00:02,000\n10:30 开始评审');
    expect(c1[0].speaker).toBeUndefined();
    expect(c1[0].text).toBe('10:30 开始评审');
    const c2 = parseSrtTranscript('1\n00:00:01,000 --> 00:00:02,000\nhttps://x.com 见这里');
    expect(c2[0].speaker).toBeUndefined();
  });

  it('正文里含时间不被当 cue 边界（整行 --> 才算时间行）', () => {
    const cues = parseSrtTranscript('1\n00:00:01,000 --> 00:00:09,000\n会议 08:00:00 到 09:00:00 之间');
    expect(cues).toHaveLength(1);
    expect(cues[0].endMs).toBe(9000);
    expect(cues[0].text).toContain('08:00:00');
  });
});

describe('buildProximityIndex（时间窗模型）', () => {
  const cues = parseSrtTranscript(SRT);
  const t0 = 1_000_000_000_000;
  const mk = (id: string, relMs: number): AlignMark => ({ mark_id: id, abs_timestamp: t0 + relMs });

  it('笔落在 cue 窗内 → 双向命中', () => {
    const marks = [mk('m1', 8500), mk('m2', 20000)]; // m1 在 cue1·m2 在 cue2
    const idx = buildProximityIndex({ marks, cues, t0AbsMs: t0, offsetMs: 0, windowMs: 1000 });
    expect(idx.markToNearbyCues.get('m1')).toContain(1);
    expect(idx.markToNearbyCues.get('m2')).toContain(2);
    expect(idx.cueToNearbyMarkIds.get(1)).toContain('m1');
    expect(idx.stats.matchedMarkCount).toBe(2);
  });

  it('窗吸收偏移：30s 窗下落账偏后的笔仍能附近命中', () => {
    const marks = [mk('late', 8070 + 25000)]; // 比 cue1 晚 25s（落账延迟）
    const idx = buildProximityIndex({ marks, cues, t0AbsMs: t0, offsetMs: 0, windowMs: 30000 });
    expect(idx.markToNearbyCues.get('late')!.length).toBeGreaterThan(0);
    expect(idx.orphanMarkIds).not.toContain('late');
  });

  it('远离所有 cue 的笔 → orphan；无笔的 cue → unmatched', () => {
    const marks = [mk('far', 999_999)]; // 远在所有 cue 之后
    const idx = buildProximityIndex({ marks, cues, t0AbsMs: t0, offsetMs: 0, windowMs: 1000 });
    expect(idx.orphanMarkIds).toContain('far');
    expect(idx.unmatchedCueIndexes.length).toBe(3);
    expect(idx.stats.matchedMarkCount).toBe(0);
  });

  it('offset 把转写整体平移·改变归属', () => {
    const marks = [mk('m', 8500)];
    const noShift = buildProximityIndex({ marks, cues, t0AbsMs: t0, offsetMs: 0, windowMs: 1000 });
    const shifted = buildProximityIndex({ marks, cues, t0AbsMs: t0, offsetMs: 60000, windowMs: 1000 }); // 转写晚 60s → m 不再附近
    expect(noShift.markToNearbyCues.get('m')!.length).toBeGreaterThan(0);
    expect(shifted.orphanMarkIds).toContain('m');
  });
});

describe('inferInitialOffset（默认不自动确认）', () => {
  const cues = parseSrtTranscript(SRT);
  const t0 = 1_000_000_000_000;

  it('marks 少/集中 → 不自动确认·保守 offset=0', () => {
    const marks: AlignMark[] = [{ mark_id: 'a', abs_timestamp: t0 + 8000 }]; // 1 笔
    const s = inferInitialOffset({ panelStartTimeMs: t0, marks, cues });
    expect(s.autoConfirm).toBe(false);
    expect(s.offsetMs).toBe(0);
  });

  it('无 marks/cues → low·不自动确认', () => {
    expect(inferInitialOffset({ panelStartTimeMs: t0, marks: [], cues }).autoConfirm).toBe(false);
    expect(inferInitialOffset({ panelStartTimeMs: t0, marks: [{ mark_id: 'a', abs_timestamp: t0 }], cues: [] }).confidence).toBe('low');
  });
});
