import { describe, it, expect } from 'vitest';
import { unionBBox, intentToRespond, markActionOf, markTraceLabel } from './pipeline-pure';
import type { AnnotationEvent } from '../core/contracts';

const ev = (bbox: [number, number, number, number]): AnnotationEvent =>
  ({ geometry: { bbox } } as unknown as AnnotationEvent);

describe('pipeline-pure', () => {
  it('unionBBox 合并多个事件 bbox', () => {
    const u = unionBBox([ev([0.2, 0.3, 0.1, 0.1]), ev([0.5, 0.1, 0.2, 0.2])]);
    expect(u[0]).toBeCloseTo(0.2, 6); // min x
    expect(u[1]).toBeCloseTo(0.1, 6); // min y
    expect(u[2]).toBeCloseTo(0.5, 6); // x1-x0 = 0.7 - 0.2
    expect(u[3]).toBeCloseTo(0.3, 6); // y1-y0 = (0.3+0.1) - 0.1
  });

  it('intentToRespond：self_note/reject 折叠，其余回应', () => {
    expect(intentToRespond('self_note')).toBe(false);
    expect(intentToRespond('reject')).toBe(false);
    expect(intentToRespond('question')).toBe(true);
    expect(intentToRespond('todo')).toBe(true);
  });

  it('markActionOf：手写→handwriting，画→sketch', () => {
    expect(markActionOf('handwriting', 'underline', 1)).toBe('handwriting');
    expect(markActionOf('drawing', 'underline', 1)).toBe('sketch');
  });

  it('markTraceLabel：按 feature 出标签 + 截断', () => {
    expect(markTraceLabel('handwriting', 'hello world foobar baz')).toContain('手写');
    expect(markTraceLabel('drawing', '')).toContain('画');
  });
});
