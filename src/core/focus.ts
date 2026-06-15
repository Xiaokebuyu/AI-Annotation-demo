/**
 * 焦点与整页上下文（P1：bbox 只定位，语义交 LLM）。
 *   pageText()    —— 整页文字按阅读序聚行，作为"恒定上下文"喂模型（不再只给被圈那几个字）。
 *   enclosedText() —— 用真实笔迹闭合曲线做"点在多边形内"，算出圈住了哪些 textBlock（借鉴 xournalpp
 *                     套索"中心在内"，根治 bbox 矩形相交把整页都捞进来的问题）。
 *   focusHint()   —— 0 token 的"焦点提示"：圈中文字优先；圈不到（划线/箭头/手写）退回最近一行。
 * 焦点只是给 LLM 的提示，真正"标注了什么"由 LLM 看合成图判定。
 */
import type { AnnotationEvent, StrokePoint } from './contracts';
import { state } from '../app/state';

/** 射线投射 even-odd：点是否在闭合笔迹多边形内（归一化坐标；内/外是拓扑判定，与轴尺度无关）。 */
function pointInPolygon(px: number, py: number, poly: StrokePoint[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** 圈住了哪些 textBlock（块中心落在闭合笔迹内）→ 阅读序。开口曲线（划线/箭头）几乎圈不到，返回空。 */
export function enclosedBlocks(points: StrokePoint[]): typeof state.textBlocks {
  if (points.length < 3 || !state.textBlocks.length) return [];
  const hits = state.textBlocks.filter((tb) => {
    if (!tb.text.trim()) return false;
    const cx = tb.bbox[0] + tb.bbox[2] / 2, cy = tb.bbox[1] + tb.bbox[3] / 2;
    return pointInPolygon(cx, cy, points);
  });
  return hits.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}

/** 整页文字（按 y 聚行、阅读序）。截断防超长——一页通常远小于上限。 */
export function pageText(maxChars = 3000): string {
  const runs = state.textBlocks
    .filter((tb) => tb.text.trim())
    .map((tb) => ({ y: tb.bbox[1] + tb.bbox[3] / 2, h: tb.bbox[3], x: tb.bbox[0], text: tb.text }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Array<{ y: number; runs: typeof runs }> = [];
  for (const r of runs) {
    const cur = lines[lines.length - 1];
    if (cur && Math.abs(r.y - cur.y) < r.h * 0.6) cur.runs.push(r);
    else lines.push({ y: r.y, runs: [r] });
  }
  const text = lines.map((ln) => { ln.runs.sort((a, b) => a.x - b.x); return ln.runs.map((r) => r.text).join(' '); }).join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

/** 焦点提示（纯几何）：任一笔画圈住了东西就用圈中文字；都圈不到则退回 union 中心最近一行。 */
export function focusHint(events: AnnotationEvent[]): string {
  for (const e of events) {
    const enc = enclosedBlocks(e.stroke_points);
    if (enc.length) return enc.map((t) => t.text).join(' ');
  }
  let y0 = 1, y1 = 0;
  for (const e of events) { const [, y, , h] = e.geometry.bbox; y0 = Math.min(y0, y); y1 = Math.max(y1, y + h); }
  const yc = (y0 + y1) / 2;
  const blocks = state.textBlocks.filter((tb) => tb.text.trim());
  if (!blocks.length) return '';
  let best = blocks[0], bd = Infinity;
  for (const tb of blocks) { const d = Math.abs(tb.bbox[1] + tb.bbox[3] / 2 - yc); if (d < bd) { bd = d; best = tb; } }
  return best.text;
}
