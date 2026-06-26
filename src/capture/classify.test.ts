import { describe, it, expect } from 'vitest';
import { bboxOf } from './classify';
import type { StrokePoint } from '../core/contracts';

const pt = (x: number, y: number): StrokePoint => ({ x, y, t: 0, pressure: 1 });

describe('classify.bboxOf', () => {
  it('从 stroke 点算出归一化包围盒 [x,y,w,h]', () => {
    const bb = bboxOf([pt(0.2, 0.3), pt(0.5, 0.1), pt(0.4, 0.6)]);
    expect(bb[0]).toBeCloseTo(0.2, 6); // x = min x
    expect(bb[1]).toBeCloseTo(0.1, 6); // y = min y
    expect(bb[2]).toBeCloseTo(0.3, 6); // w = maxx - minx
    expect(bb[3]).toBeCloseTo(0.5, 6); // h = maxy - miny
  });

  it('单点退化成零宽高包围盒', () => {
    const bb = bboxOf([pt(0.4, 0.7)]);
    expect(bb).toEqual([0.4, 0.7, 0, 0]);
  });
});
