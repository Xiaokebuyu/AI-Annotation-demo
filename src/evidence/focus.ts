/**
 * 整页上下文 + 几何工具（取证线用）。
 *   pageText()       —— 整页文字按阅读序聚行，作为"恒定上下文"喂理解模型。
 *   pointInPolygon() —— 射线法"点在多边形内"；target.ts 的"圈住了什么"复用它。
 * 注：旧的 focusHint/enclosedBlocks（几何猜"圈住了什么"）已被 HMP 取证线取代、移除。
 */
import type { NormBBox, OcrTextBlock, StrokePoint } from '../core/contracts';
import { state } from '../app/state';

/** 射线投射 even-odd：点是否在闭合笔迹多边形内（归一化坐标；内/外是拓扑判定，与轴尺度无关）。 */
export function pointInPolygon(px: number, py: number, poly: StrokePoint[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** 一组文本块 → 按 y 聚行、阅读序拼出文字。任意页复用（当前页 / 前后页滑动窗）。 */
export function blocksToText(blocks: OcrTextBlock[], maxChars = 3000): string {
  const runs = blocks
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

/** 整页文字（当前页 state.textBlocks，按阅读序）。 */
export function pageText(maxChars = 3000): string {
  return blocksToText(state.textBlocks, maxChars);
}

/**
 * 与 bbox 同一纵向带（y 区间重叠，或行中心距 < 该块行高）的印刷正文行，按阅读序拼出。
 * 给"孤立手写问题→它纵向压着的那行原文"作显式指代（②）：边注本身不带指代，靠它指出"问的是这行"。
 */
export function linesInBand(blocks: OcrTextBlock[], bbox: NormBBox, maxChars = 400): string {
  const y0 = bbox[1], y1 = bbox[1] + bbox[3], bc = bbox[1] + bbox[3] / 2;
  const band = blocks.filter((tb) => {
    if (!tb.text.trim()) return false;
    const ty0 = tb.bbox[1], ty1 = tb.bbox[1] + tb.bbox[3];
    const overlap = Math.min(y1, ty1) - Math.max(y0, ty0) > 0;       // y 区间重叠
    const near = Math.abs((ty0 + tb.bbox[3] / 2) - bc) < tb.bbox[3]; // 中心距 < 该块行高
    return overlap || near;
  });
  return blocksToText(band, maxChars);
}
