import type { OcrTextBlock, PDFPageRecord, ScreenOverlay, StrokePoint } from '../core/contracts';

type Handler = (...args: unknown[]) => void;

class Bus {
  private handlers = new Map<string, Set<Handler>>();
  on(event: string, fn: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
  }
  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.forEach((fn) => fn(...args));
  }
}

/**
 * 事件总线。约定的事件：
 *  'document:loaded'      文档导入完成
 *  'page:rendered'        页面渲染完成（含缩放重渲）
 *  'overlay:add' (o)      新 overlay 产生
 *  'overlay:state' (o)    overlay 状态变化（接受/编辑/忽略）
 *  'anchor:focus' (id)    请求高亮某个锚点
 *  'card:focus' (id)      请求滚动到某张卡片
 *  'trace' (kind, obj)    新 trace 记录
 *  'metrics'              延迟/计数更新
 *  'tool' (tool)          工具切换
 */
export const bus = new Bus();

export type Tool = 'pen' | 'highlighter' | 'eraser';

export interface Stroke {
  tool: Tool;
  points: StrokePoint[];
}

export const state = {
  tool: 'pen' as Tool,
  zoom: 1,
  fileName: '',
  fileHash: null as string | null,
  documentId: null as string | null,
  pageCount: 0,
  pageIndex: 0,
  pageId: null as string | null,
  pageRecord: null as PDFPageRecord | null,
  textBlocks: [] as OcrTextBlock[],
  strokesByPage: new Map<string, Stroke[]>(),
  overlays: [] as ScreenOverlay[],
  ocrProvider: 'textlayer',
  inferProvider: 'mock',
};

export function currentStrokes(): Stroke[] {
  if (!state.pageId) return [];
  if (!state.strokesByPage.has(state.pageId)) state.strokesByPage.set(state.pageId, []);
  return state.strokesByPage.get(state.pageId)!;
}

export function setTool(tool: Tool): void {
  state.tool = tool;
  bus.emit('tool', tool);
}
