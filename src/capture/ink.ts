import type { StrokePoint } from '../core/contracts';
import { normToPx, pxToNorm, pageCss } from '../core/transform';
import { trace } from '../core/trace';
import { bus, currentStrokes, settings, state, strokeMarkIds, type Stroke, type Tool } from '../app/state';
import { recordInkSample } from '../local/bedrock-recorder';
import { styleFor } from './stroke-style';
import { signalInkArea } from '../surface/eink';

let cv: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let live: { tool: Tool; points: StrokePoint[]; t0: number; pointerType: string } | null = null;
let nav: { x0: number; y0: number } | null = null;
/** 死区半径（CSS px）：逐 pointermove 丢掉与上一采样点相距 < 此值的 sub-px 抖动。
 *  借鉴 xournalpp Deadzone(1.3px)——在抖动发生时即抑制，让点按/手抖稳定落到 tap_region，
 *  而非事后靠总行程补救。真实笔画相邻点远大于此值，不受影响。 */
const DEADZONE_PX = 1.3;
let onStrokeComplete: ((stroke: Stroke, pointerType: string, penUpAt: number) => void) | null = null;

const SWIPE_MIN_PX = 60; // 横滑超过此距离且以横向为主 → 翻页

/**
 * 输入意图分流 —— 笔 / 手指的「硬件接口」，policy 只在这一处：
 *  - pointerType 'pen'          → 标注（触控笔 / iPad Apple Pencil）
 *  - pointerType 'touch' / 鼠标 → 跟随当前工具：hand 工具翻页，其它(笔/荧光/擦)落笔
 * 电纸屏电容触摸(WingCool HID)枚举为 'touch'，故手指默认能写、切 hand 工具才翻页。
 */
function resolveIntent(pointerType: string): 'annotate' | 'navigate' {
  if (pointerType === 'pen') return 'annotate';
  return state.tool === 'hand' ? 'navigate' : 'annotate';
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

/** 基岩录制 tap（Tier 1·影子·死区前）。features.bedrock 关时立即返回、零开销。 */
function bedrockTap(e: PointerEvent, p: { x: number; y: number }, phase: 'down' | 'move' | 'up'): void {
  if (!settings.bedrock || !state.documentId) return;
  recordInkSample({
    documentId: state.documentId, pageId: state.pageId ?? undefined,
    x: p.x, y: p.y, phase, contactId: e.pointerId,
    pressure: e.pressure, dims: { w: pageCss.w, h: pageCss.h },
    penSource: e.pointerType === 'pen', surface: 'article',
  });
}

function eraseAt(e: PointerEvent): void {
  const p = evtNorm(e);
  const strokes = currentStrokes();
  const hitRadius = 10 / Math.max(pageCss.w, 1); // ~10px
  for (let i = strokes.length - 1; i >= 0; i--) {
    const hit = strokes[i].points.some((pt) => Math.hypot(pt.x - p.x, (pt.y - p.y) * (pageCss.h / pageCss.w)) < hitRadius);
    if (hit) { eraseStroke(strokes[i], 'erase'); return; }
  }
}

/**
 * 擦/撤一笔：若该笔已属于某 mark（组装过、已落账本）→ 擦掉整 mark（移除其全部笔 + 发 mark:erase
 * 让 main 落 tombstone）；否则（尚未组装的在途笔）只移这一笔，无需 tombstone（它还没持久化）。
 */
function eraseStroke(stroke: Stroke, reason: 'erase' | 'undo'): void {
  const strokes = currentStrokes();
  const mid = strokeMarkIds.get(stroke);
  // 被擦笔集合（命中 mark→整组·否则单笔）：留它们的点算脏区，擦完发 A2 局部刷——
  // 否则电纸屏上画布重画了但不更新（橡皮"擦了没反应"·用户实测漏的就是这个）。
  const erased = mid ? strokes.filter((s) => strokeMarkIds.get(s) === mid) : [stroke];
  if (mid) {
    for (let k = strokes.length - 1; k >= 0; k--) if (strokeMarkIds.get(strokes[k]) === mid) strokes.splice(k, 1);
    bus.emit('mark:erase', mid); // → main: 落 mark tombstone + 从 session 移除
  } else {
    const k = strokes.indexOf(stroke);
    if (k >= 0) strokes.splice(k, 1);
    bus.emit('stroke:cancel', stroke); // 撤 pending 组装：否则 6s 内擦的在途笔仍 assemble 成 mark、reload 复活（两面共有的老洞）
  }
  trace(reason === 'undo' ? 'StrokeUndone' : 'StrokeErased', { page_id: state.pageId ?? '', mark_id: mid ?? '' });
  redrawInk();
  const pts = erased.flatMap((s) => s.points);
  if (pts.length) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    signalInkArea([x0, y0, x1 - x0, y1 - y0]); // 页归一化 bbox → #ink-layer 映射 → A2 局部刷（原版画布）
  }
}

export function undoStroke(): void {
  const strokes = currentStrokes();
  if (!strokes.length) return;
  eraseStroke(strokes[strokes.length - 1], 'undo');
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
    bedrockTap(e, p, 'down');
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
      bedrockTap(ce, p, 'move'); // 死区前：连手抖也录下来
      const last = live.points[live.points.length - 1];
      // 死区：与上一点相距 < DEADZONE_PX(CSS px) 的 sub-px 抖动直接丢，稳 tap 判定（页面未渲染时 pageCss=0，跳过死区）
      if (pageCss.w && pageCss.h && Math.hypot((p.x - last.x) * pageCss.w, (p.y - last.y) * pageCss.h) < DEADZONE_PX) continue;
      const pt: StrokePoint = {
        x: p.x, y: p.y,
        t: Math.round(performance.now() - live.t0),
        pressure: ce.pressure || 0,
      };
      drawSeg(last, pt, live.tool);
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

  cv.addEventListener('pointerup', (e) => { if (nav) finishNav(e); else { bedrockTap(e, evtNorm(e), 'up'); finish(); } });
  cv.addEventListener('pointercancel', () => { live = null; nav = null; });

  bus.on('page:rendered', () => redrawInk());
  bus.on('tool', () => {
    cv.style.cursor = state.tool === 'eraser' ? 'cell' : state.tool === 'hand' ? 'grab' : 'crosshair';
  });
}
