/**
 * 笔画样式表（坐标无关）—— 原版页(capture/ink) 与 重排面(surface/reader) 共用，
 * 保证两面"画成什么样"单一来源、不再各写一份漂移。只决定颜色/线宽/笔帽/合成，
 * 不碰坐标：各面用各自坐标系（原版页 normToPx、重排面内容 px）自行画线段。
 */
import type { Tool } from '../app/state';

export interface SegStyle {
  stroke: string;
  width: number;
  cap: CanvasLineCap;
  composite: GlobalCompositeOperation;
}

export function styleFor(tool: Tool, pressure: number): SegStyle {
  if (tool === 'highlighter') {
    // 规范色 #D4CFCA（E-ink 友好浅灰高亮），multiply 让文字透出
    return { stroke: 'rgba(212,207,202,0.85)', width: 16, cap: 'butt', composite: 'multiply' };
  }
  return { stroke: '#1A1A1A', width: 1.2 + 2.2 * (pressure || 0.45), cap: 'round', composite: 'source-over' };
}
