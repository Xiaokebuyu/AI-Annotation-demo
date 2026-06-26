import { describe, it, expect } from 'vitest';
import { setPageSize, normToPx, pxToNorm, selfTest, GUTTER_W } from './transform';

describe('transform 坐标栈', () => {
  it('normToPx/pxToNorm 在设定页尺寸后互逆', () => {
    setPageSize(800, 1132);
    const p = normToPx(0.25, 0.5);
    expect(p).toEqual({ x: 200, y: 566 });
    const back = pxToNorm(p.x, p.y);
    expect(back.x).toBeCloseTo(0.25, 12);
    expect(back.y).toBeCloseTo(0.5, 12);
  });

  it('selfTest 在有效页尺寸下往返误差 < 1e-9', () => {
    setPageSize(1024, 768);
    const r = selfTest(500);
    expect(r.ok).toBe(true);
    expect(r.samples).toBe(500);
  });

  it('selfTest 在零尺寸下报 not-ok（pageCss 未初始化）', () => {
    setPageSize(0, 0);
    expect(selfTest().ok).toBe(false);
  });

  it('GUTTER_W 是固定留白常量', () => {
    expect(GUTTER_W).toBe(300);
  });
});
