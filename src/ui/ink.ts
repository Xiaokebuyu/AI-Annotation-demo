import type { StrokePoint } from '../core/contracts';
import { normToPx, pxToNorm, pageCss } from '../core/transform';
import { trace } from '../core/trace';
import { bus, currentStrokes, state, type Stroke, type Tool } from '../app/state';
import { putStrokes } from '../app/store';

/** 把当前页笔迹落盘（每次抬笔/擦除/撤销都调一次，去抖在 store 内部）。 */
export function persistInk(): void {
  putStrokes(state.pageIndex, currentStrokes().map((s) => ({ tool: s.tool, points: s.points })));
}

let cv: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let live: { tool: Tool; points: StrokePoint[]; t0: number; pointerType: string } | null = null;
let nav: { x0: number; y0: number } | null = null;
let onStrokeComplete: ((stroke: Stroke, pointerType: string, penUpAt: number) => void) | null = null;

const SWIPE_MIN_PX = 60; // 横滑超过此距离且以横向为主 → 翻页

/**
 * 输入意图分流 —— 笔 / 手指的「硬件接口」，policy 只在这一处：
 *  - pointerType 'pen'   → 标注（触控笔 / iPad Apple Pencil）
 *  - pointerType 'touch' → 翻页·导航（手指 / 触屏）
 * 真机 / iPad 直接命中上面两支（搬过去零改）；桌面鼠标无 pen/touch，落到 hand 工具兜底。
 */
function resolveIntent(pointerType: string): 'annotate' | 'navigate' {
  if (pointerType === 'pen') return 'annotate';
  if (pointerType === 'touch') return 'navigate';
  return state.tool === 'hand' ? 'navigate' : 'annotate';
}

interface SegStyle {
  stroke: string;
  width: number;
  cap: CanvasLineCap;
  composite: GlobalCompositeOperation;
}

function styleFor(tool: Tool, pressure: number): SegStyle {
  if (tool === 'highlighter') {
    // 规范色 #D4CFCA（E-ink 友好浅灰高亮），multiply 让文字透出
    return { stroke: 'rgba(212,207,202,0.85)', width: 16, cap: 'butt', composite: 'multiply' };
  }
  return { stroke: '#1A1A1A', width: 1.2 + 2.2 * (pressure || 0.45), cap: 'round', composite: 'source-over' };
}

function drawSeg(a: StrokePoint, b: StrokePoint, tool: Tool): void {
  const dpr = window.devicePixelRatio || 1;
  const s = styleFor(tool, b.pressure);
  const p1 = normToPx(a.x, a.y);
  const p2 = normToPx(b.x, b.y);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = s.composite;
  ctx.strokeStyle = s.stroke;
  ctx.lineCap = s.cap;
  ctx.lineWidth = s.width;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}

export function redrawInk(): void {
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, pageCss.w, pageCss.h);
  for (const s of currentStrokes()) {
    for (let i = 1; i < s.points.length; i++) drawSeg(s.points[i - 1], s.points[i], s.tool);
  }
}

function evtNorm(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const r = cv.getBoundingClientRect();
  return pxToNorm(e.clientX - r.left, e.clientY - r.top);
}

function eraseAt(e: PointerEvent): void {
  const p = evtNorm(e);
  const strokes = currentStrokes();
  const hitRadius = 10 / Math.max(pageCss.w, 1); // ~10px
  for (let i = strokes.length - 1; i >= 0; i--) {
    const hit = strokes[i].points.some((pt) => Math.hypot(pt.x - p.x, (pt.y - p.y) * (pageCss.h / pageCss.w)) < hitRadius);
    if (hit) {
      const [removed] = strokes.splice(i, 1);
      trace('StrokeErased', { page_id: state.pageId ?? '', points: removed.points.length });
      persistInk();
      redrawInk();
      return;
    }
  }
}

export function undoStroke(): void {
  const strokes = currentStrokes();
  if (!strokes.length) return;
  strokes.pop();
  trace('StrokeUndone', { page_id: state.pageId ?? '' });
  persistInk();
  redrawInk();
}

export function initInk(
  canvas: HTMLCanvasElement,
  complete: (stroke: Stroke, pointerType: string, penUpAt: number) => void,
): void {
  cv = canvas;
  ctx = canvas.getContext('2d')!;
  onStrokeComplete = complete;

  cv.addEventListener('pointerdown', (e) => {
    if (!state.documentId) return;
    // 手指/手型 → 导航：记起点，抬笔时判横滑翻页（不进笔迹采集）
    if (resolveIntent(e.pointerType) === 'navigate') {
      e.preventDefault();
      nav = { x0: e.clientX, y0: e.clientY };
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      return;
    }
    e.preventDefault();
    if (state.tool === 'eraser') { eraseAt(e); return; }
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const p = evtNorm(e);
    live = {
      tool: state.tool,
      t0: performance.now(),
      pointerType: e.pointerType,
      points: [{ x: p.x, y: p.y, t: 0, pressure: e.pressure || 0 }],
    };
  });

  cv.addEventListener('pointermove', (e) => {
    if (state.tool === 'eraser' && e.buttons) { eraseAt(e); return; }
    if (!live) return;
    e.preventDefault();
    // 无损：优先取全部合并点；合成事件/旧内核返回空数组时回退到事件本身
    let raw: PointerEvent[] = e.getCoalescedEvents ? (e.getCoalescedEvents() as PointerEvent[]) : [];
    if (!raw.length) raw = [e];
    for (const ce of raw) {
      const p = evtNorm(ce);
      const pt: StrokePoint = {
        x: p.x, y: p.y,
        t: Math.round(performance.now() - live.t0),
        pressure: ce.pressure || 0,
      };
      drawSeg(live.points[live.points.length - 1], pt, live.tool);
      live.points.push(pt);
    }
  });

  const finish = () => {
    if (!live) return;
    const penUpAt = performance.now();
    const stroke: Stroke = { tool: live.tool, points: live.points };
    const pointerType = live.pointerType;
    live = null;
    currentStrokes().push(stroke);
    onStrokeComplete?.(stroke, pointerType, penUpAt);
  };

  // 导航抬笔：横滑距离够且以横向为主 → 翻页（左滑下一页、右滑上一页）。main.ts 接 nav:flip。
  const finishNav = (e: PointerEvent) => {
    if (!nav) return;
    const dx = e.clientX - nav.x0, dy = e.clientY - nav.y0;
    nav = null;
    if (Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy)) bus.emit('nav:flip', dx < 0 ? 1 : -1);
  };

  cv.addEventListener('pointerup', (e) => { if (nav) finishNav(e); else finish(); });
  cv.addEventListener('pointercancel', () => { live = null; nav = null; });

  bus.on('page:rendered', () => redrawInk());
  bus.on('tool', () => {
    cv.style.cursor = state.tool === 'eraser' ? 'cell' : state.tool === 'hand' ? 'grab' : 'crosshair';
  });
}
