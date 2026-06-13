import type { EventType, NormBBox, StrokePoint } from './contracts';
import { pageCss } from './transform';

export function bboxOf(points: StrokePoint[]): NormBBox {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** 几何启发式分类：tap_region / circle / underline / stroke */
export function classify(points: StrokePoint[], bb: NormBBox): EventType {
  const wPx = bb[2] * pageCss.w;
  const hPx = bb[3] * pageCss.h;
  const diagPx = Math.hypot(wPx, hPx);
  if (points.length <= 3 || diagPx < 8) return 'tap_region';

  const first = points[0];
  const last = points[points.length - 1];
  const closure = Math.hypot((last.x - first.x) * pageCss.w, (last.y - first.y) * pageCss.h);
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(
      (points[i].x - points[i - 1].x) * pageCss.w,
      (points[i].y - points[i - 1].y) * pageCss.h,
    );
  }
  if (closure < 0.25 * diagPx && len > 1.5 * diagPx) return 'circle';
  if (hPx < 14 && wPx > 4 * hPx) return 'underline';
  return 'stroke';
}
