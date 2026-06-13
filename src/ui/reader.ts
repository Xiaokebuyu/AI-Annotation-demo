import type { AnnotationEvent, EventType, NormBBox, OutputMode, ScreenOverlay, StrokePoint } from '../core/contracts';
import { SCHEMA_VERSION } from '../core/contracts';
import type { ReflowBlock } from '../core/reflow';
import { bus, settings, state } from '../app/state';
import { reflowProviders } from '../providers/reflow';
import { bboxOf, classifyScored } from '../core/classify';
import { resolveGesture } from '../core/gesture';
import { commitDiscussion } from '../core/pipeline';
import { DEVICE_ID, SESSION_ID, shortId } from '../core/ids';

/**
 * 重排阅读面（settings.viewMode === 'reader'）。
 * 不只渲染：也能在重排文本上**圈画**——手势命中哪一段，就用那段的原页 bbox 入管线，
 * AI 回应**行内贴在该段正下方**（不挤右侧留白，顺带解决空间占用）。
 */

let el: HTMLElement;             // #reader 滚动容器
let inkCv: HTMLCanvasElement;    // 行内圈画画布（内容坐标，随内容滚动）
let inkCtx: CanvasRenderingContext2D | null = null;

interface BlockRef { id: string; el: HTMLElement; source: NormBBox; }
let blockRefs: BlockRef[] = [];

interface RecStroke { event: AnnotationEvent; kind: EventType; score: number; }
const pendingByBlock = new Map<string, RecStroke[]>();
const lastSig = new Map<string, string>();
let pauseTimer: number | undefined;

const inkStrokes: { x: number; y: number }[][] = []; // 已落的笔迹（内容坐标）
let live: { x: number; y: number }[] | null = null;
const DISC = 'disc_r_';

// ── 渲染 ──
function render(blocks: ReflowBlock[]): void {
  el.querySelectorAll('.reader-col, .reader-empty').forEach((n) => n.remove());
  inkStrokes.length = 0;
  if (!blocks.length) {
    const empty = document.createElement('p');
    empty.className = 'reader-empty';
    empty.textContent = '这一页没有可重排的文本层（扫描版或空白页）。';
    el.insertBefore(empty, inkCv);
    resizeInk();
    return;
  }
  const col = document.createElement('article');
  col.className = 'reader-col';
  blockRefs = [];
  for (const b of blocks) {
    const node = document.createElement(b.type === 'heading' ? 'h2' : 'p');
    node.className = b.type === 'heading' ? 'reader-h' : 'reader-p';
    if (b.type === 'heading') node.dataset.level = String(b.level);
    node.dataset.bbox = b.source.map((n) => n.toFixed(4)).join(',');
    node.dataset.block = b.id;
    node.textContent = b.text;
    col.appendChild(node);
    blockRefs.push({ id: b.id, el: node, source: b.source });
  }
  el.insertBefore(col, inkCv);
  // 把已有的本页讨论注重新贴回（切引擎/重渲后不丢）
  state.overlays.filter((o) => o.overlay_id.startsWith(DISC) && o.page_id === state.pageId).forEach(renderNote);
  resizeInk();
}

async function rebuild(): Promise<void> {
  if (settings.viewMode !== 'reader') return;
  try {
    const blocks = await reflowProviders[settings.reflowProvider](state.textBlocks);
    if (settings.viewMode === 'reader') render(blocks);
  } catch (e) {
    el.querySelectorAll('.reader-col, .reader-empty').forEach((n) => n.remove());
    const err = document.createElement('p');
    err.className = 'reader-empty';
    err.textContent = `重排失败：${(e as Error).message}`;
    el.insertBefore(err, inkCv);
  }
}

// ── 行内 AI 注 ──
function renderNote(o: ScreenOverlay): void {
  const blockId = o.overlay_id.slice(DISC.length);
  const ref = blockRefs.find((b) => b.id === blockId);
  if (!ref) return;
  el.querySelector(`.reader-note[data-for="${o.overlay_id}"]`)?.remove();
  if (o.state === 'dismissed') return;
  const note = document.createElement('div');
  note.className = 'reader-note';
  note.dataset.for = o.overlay_id;
  note.textContent = o.display_text;
  ref.el.insertAdjacentElement('afterend', note);
  resizeInk();
}

// ── 圈画采集 ──
function resizeInk(): void {
  if (!inkCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = el.clientWidth;
  const h = Math.max(el.scrollHeight, el.clientHeight);
  inkCv.width = w * dpr; inkCv.height = h * dpr;
  inkCv.style.width = w + 'px'; inkCv.style.height = h + 'px';
  inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  inkCtx.clearRect(0, 0, w, h);
  inkCtx.strokeStyle = '#1A1A1A';
  inkCtx.lineWidth = 1.6;
  inkCtx.lineCap = 'round';
  for (const s of inkStrokes) drawStroke(s);
  if (live) drawStroke(live);
}

function drawStroke(pts: { x: number; y: number }[]): void {
  if (!inkCtx || pts.length < 2) return;
  inkCtx.beginPath();
  inkCtx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) inkCtx.lineTo(pts[i].x, pts[i].y);
  inkCtx.stroke();
}

function contentPoint(e: PointerEvent): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top + el.scrollTop };
}

/** 命中哪一段：手势内容-y 中心落在哪个块的纵向范围内。 */
function hitBlock(pts: { x: number; y: number }[]): BlockRef | null {
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const top = el.getBoundingClientRect().top;
  for (const ref of blockRefs) {
    const r = ref.el.getBoundingClientRect();
    const a = r.top - top + el.scrollTop;
    if (cy >= a - 6 && cy <= a + r.height + 6) return ref;
  }
  return null;
}

function makeEvent(source: NormBBox, kind: EventType, pts: StrokePoint[]): AnnotationEvent {
  return {
    event_id: shortId('evt'), trace_id: shortId('trc'),
    document_id: state.documentId ?? '', page_id: state.pageId ?? '',
    event_type: kind, geometry: { bbox: source }, stroke_points: pts,
    text_note: null, created_at: new Date().toISOString(),
    device_id: DEVICE_ID, session_id: SESSION_ID, pointer_type: 'reader', version: SCHEMA_VERSION,
  };
}

function onPenUp(raw: { x: number; y: number }[]): void {
  if (raw.length < 2) return;
  const w = el.clientWidth || 1;
  const h = el.clientHeight || 1;
  const norm: StrokePoint[] = raw.map((p, i) => ({ x: p.x / w, y: p.y / h, t: i, pressure: 0.5 }));
  const scored = classifyScored(norm, bboxOf(norm), w, h); // 用 reader 画布尺寸判形状
  const ref = hitBlock(raw);
  if (!ref) return; // 没画在任何段上 → 不入讨论
  const list = pendingByBlock.get(ref.id) ?? [];
  list.push({ event: makeEvent(ref.source, scored.type, norm), kind: scored.type, score: scored.score });
  pendingByBlock.set(ref.id, list);
  if (!settings.gesture.enabled) return;
  window.clearTimeout(pauseTimer);
  pauseTimer = window.setTimeout(runReaderDiscussions, settings.gesture.pauseSeconds * 1000);
}

function deliberate(recs: RecStroke[]): boolean {
  if (recs.some((r) => r.score >= 0.4)) return true;            // 有一笔像模板
  return recs.filter((r) => r.kind === 'stroke').length >= 2;    // 或成段手写
}

function runReaderDiscussions(): void {
  for (const [blockId, recs] of pendingByBlock) {
    if (!deliberate(recs)) continue;
    const sig = recs.map((r) => r.event.event_id).join(',');
    const discId = DISC + blockId;
    if (lastSig.get(discId) === sig) continue;
    lastSig.set(discId, sig);
    const events = recs.map((r) => r.event);
    let modes: OutputMode[] = ['summary'];
    let eventType: EventType | undefined;
    if (events.length === 1) { const g = resolveGesture(events); modes = g.output_modes; eventType = g.eventType; }
    void commitDiscussion(events, performance.now(), discId, modes, eventType);
  }
}

export function initReader(readerEl: HTMLElement): void {
  el = readerEl;
  inkCv = document.createElement('canvas');
  inkCv.className = 'reader-ink';
  el.appendChild(inkCv);
  inkCtx = inkCv.getContext('2d');

  el.addEventListener('pointerdown', (e) => {
    if (settings.viewMode !== 'reader' || !state.pageId) return;
    if (state.tool === 'eraser') return;
    live = [contentPoint(e)];
  });
  el.addEventListener('pointermove', (e) => {
    if (!live) return;
    live.push(contentPoint(e));
    drawStroke(live.slice(-2));
  });
  const finish = (e: PointerEvent) => {
    if (!live) return;
    const pts = live; live = null;
    inkStrokes.push(pts);
    onPenUp(pts);
    void e;
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', () => { live = null; });

  bus.on('view:changed', rebuild);
  bus.on('page:rendered', rebuild);
  bus.on('settings:changed', rebuild);
  bus.on('overlay:add', (o) => { const ov = o as ScreenOverlay; if (ov.overlay_id.startsWith(DISC)) renderNote(ov); });
  bus.on('overlay:remove', (id) => el.querySelector(`.reader-note[data-for="${id as string}"]`)?.remove());
  bus.on('overlay:state', (o) => { const ov = o as ScreenOverlay; if (ov.overlay_id.startsWith(DISC)) renderNote(ov); });
  window.addEventListener('resize', () => { if (settings.viewMode === 'reader') resizeInk(); });
}
