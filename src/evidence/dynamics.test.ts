import { describe, expect, it } from 'vitest';
import { computeManner } from './dynamics';
import type { StrokePoint } from '../core/contracts';

const P = (x: number, y: number, t: number): StrokePoint => ({ x, y, t, pressure: 0 });
const stroke = (pts: StrokePoint[]) => [{ points: pts }];

describe('computeManner', () => {
  it('落笔长停顿 → hesitant', () => {
    // 落笔后在原地停 ~300ms 才起步
    const m = computeManner(stroke([P(0, 0, 0), P(0, 0, 100), P(0, 0, 200), P(0, 0, 300), P(0.5, 0, 320), P(1, 0, 340)]), 'handwriting');
    expect(m.adverb).toBe('hesitant');
    expect(m.hesitationMs).toBeGreaterThan(280);
  });

  it('快而无迟疑 → decisive', () => {
    const m = computeManner(stroke([P(0, 0, 0), P(0.5, 0, 8), P(1, 0, 16)]), 'markup');
    expect(m.adverb).toBe('decisive');
    expect(m.retraced).toBeUndefined();
  });

  it('慢 → careful（密集渐进点：持续慢移、非停顿）', () => {
    // 11 点匀速铺满 2s（每 ~200ms 走 0.1），起步即动、不迟疑，但整体慢
    const pts = Array.from({ length: 11 }, (_, i) => P(i / 10, 0, i * 200));
    const m = computeManner(stroke(pts), 'handwriting');
    expect(m.adverb).toBe('careful');
    expect(m.hesitationMs).toBeLessThan(280);
  });

  it('markup 在同一处来回叠 → retraced（且抑制 decisive）', () => {
    const m = computeManner(stroke([P(0, 0, 0), P(0.1, 0, 15), P(0, 0, 30), P(0.1, 0, 45), P(0, 0, 60), P(0.1, 0, 75)]), 'markup');
    expect(m.retraced).toBe(true);
    expect(m.adverb).toBeUndefined(); // retraced 不应被判成 decisive
  });

  it('drawing 不判 retraced（来回是常态，非重描）', () => {
    const m = computeManner(stroke([P(0, 0, 0), P(0.1, 0, 15), P(0, 0, 30), P(0.1, 0, 45), P(0, 0, 60), P(0.1, 0, 75)]), 'drawing');
    expect(m.retraced).toBeUndefined();
  });

  it('无时间戳的笔（t 全 0）→ 仅几何，不臆测速度/迟疑', () => {
    const m = computeManner(stroke([P(0, 0, 0), P(0.1, 0, 0), P(0, 0, 0), P(0.1, 0, 0), P(0, 0, 0), P(0.1, 0, 0)]), 'markup');
    expect(m.retraced).toBe(true);     // 几何信号仍在
    expect(m.adverb).toBeUndefined();  // 不臆测
    expect(m.speed).toBeUndefined();
  });

  it('过短的笔 → 空 manner', () => {
    expect(computeManner(stroke([P(0, 0, 0), P(0.01, 0, 5)]), 'handwriting')).toEqual({});
  });
});
