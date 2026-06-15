import type { AnnotationEvent, EventType, NormBBox, OutputMode, ScreenOverlay, StrokePoint } from '../core/contracts';
import { SCHEMA_VERSION } from '../core/contracts';
import type { ReflowBlock } from '../core/reflow';
import { bus, settings, state } from '../app/state';
import { reflowProviders } from '../providers/reflow';
import { grabRegion } from '../providers/ocr';
import { getImageExplain, getReflow, putImageExplain, putReflow } from '../app/store';
import { bboxOf, classifyScored } from '../core/classify';
import { resolveGesture } from '../core/gesture';
import { commitDiscussion } from '../core/pipeline';
import { memorySnapshot } from '../core/memory';
import { DEVICE_ID, SESSION_ID, shortId } from '../core/ids';

/** 重排阅读流里的一项：重排出的文本块，或保留的原页图像（带 AI 解读）。 */
interface FigureItem { kind: 'figure'; id: string; source: NormBBox; }
type RenderItem = ReflowBlock | FigureItem;

/**
 * 重排阅读面（settings.viewMode === 'reader'）。
 * 不只渲染：也能在重排文本上**圈画**——手势命中哪一段，就用那段的原页 bbox 入管线，
 * AI 回应**行内贴在该段正下方**（不挤右侧留白，顺带解决空间占用）。
 */

let el: HTMLElement;             // #reader 滚动容器
let pageWrap: HTMLElement | null = null; // 居中的阅读块（正文列 + AI 注栏）
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
function render(items: RenderItem[]): void {
  el.querySelectorAll('.reader-page, .reader-empty').forEach((n) => n.remove());
  pageWrap = null;
  inkStrokes.length = 0;
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'reader-empty';
    empty.textContent = '这一页没有可重排的文本层（扫描版或空白页）。';
    el.insertBefore(empty, inkCv);
    resizeInk();
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'reader-page';
  const col = document.createElement('article');
  col.className = 'reader-col';
  blockRefs = [];
  for (const it of items) {
    if ('kind' in it) {
      // 原页图像：保留图本身 + AI 解读注（不丢图，旁附一句它在讲什么）
      const crop = grabRegion(it.source, 0, 1024);
      const fig = document.createElement('figure');
      fig.className = 'reader-fig';
      fig.dataset.block = it.id;
      const img = document.createElement('img');
      img.alt = '原文图像';
      if (crop) img.src = crop;
      const cap = document.createElement('figcaption');
      cap.className = 'reader-figcap';
      cap.dataset.pending = '1';
      cap.textContent = '正在解读这张图…';
      fig.appendChild(img);
      fig.appendChild(cap);
      col.appendChild(fig);
      void explainFigure(cap, it.source, crop);
      continue;
    }
    const b = it;
    if (b.type === 'list') {
      // 列表：保留语义结构（项目符号/编号），不压成一坨段落
      const listEl = document.createElement(b.ordered ? 'ol' : 'ul');
      listEl.className = 'reader-list';
      listEl.dataset.bbox = b.source.map((n) => n.toFixed(4)).join(',');
      listEl.dataset.block = b.id;
      for (const item of b.items ?? []) {
        const li = document.createElement('li');
        li.textContent = item;
        listEl.appendChild(li);
      }
      col.appendChild(listEl);
      blockRefs.push({ id: b.id, el: listEl, source: b.source });
      continue;
    }
    const node = document.createElement(b.type === 'heading' ? 'h2' : 'p');
    node.className = b.type === 'heading' ? 'reader-h' : 'reader-p';
    if (b.type === 'heading') node.dataset.level = String(b.level);
    node.dataset.bbox = b.source.map((n) => n.toFixed(4)).join(',');
    node.dataset.block = b.id;
    node.textContent = b.text;
    col.appendChild(node);
    blockRefs.push({ id: b.id, el: node, source: b.source });
  }
  wrap.appendChild(col);
  el.insertBefore(wrap, inkCv);
  pageWrap = wrap;
  // 把已有的本页讨论注重新贴回（切引擎/重渲后不丢）
  state.overlays.filter((o) => o.overlay_id.startsWith(DISC) && o.page_id === state.pageId).forEach(renderNote);
  resizeInk();
}

/** 图附近的正文（喂给图像解读做上下文）。 */
function nearbyText(bb: NormBBox): string {
  const [x, y, w, h] = bb;
  const pad = 0.06;
  const near: NormBBox = [x - pad, y - pad, w + 2 * pad, h + 2 * pad];
  const hit = (r: NormBBox, b: NormBBox) =>
    b[0] < r[0] + r[2] && b[0] + b[2] > r[0] && b[1] < r[1] + r[3] && b[1] + b[3] > r[1];
  return state.textBlocks.filter((t) => hit(near, t.bbox)).map((t) => t.text).join(' ').slice(0, 800);
}

/** 让 Kimi 看图，结合「图附近正文 + 前页总结」给一句解读，填进 figcaption。 */
async function explainFigure(cap: HTMLElement, source: NormBBox, image?: string): Promise<void> {
  if (!image) { cap.textContent = '（无法截取此图）'; delete cap.dataset.pending; return; }
  const cached = getImageExplain(state.pageIndex, source); // 已解读过 → 直接用，不再调模型
  if (cached) { cap.textContent = `图：${cached}`; delete cap.dataset.pending; return; }
  const nearby = nearbyText(source);
  const prevSummary = memorySnapshot(state.pageId ?? '').find((m) => m.index === state.pageIndex - 1)?.summary ?? '';
  try {
    const resp = await fetch('/api/explain-image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image, nearby, prevSummary }),
    });
    const data = resp.ok ? await resp.json() : null;
    if (data?.text) { cap.textContent = `图：${String(data.text)}`; putImageExplain(state.pageIndex, source, String(data.text)); }
    else cap.textContent = '（这张图暂时没读出含义）';
  } catch {
    cap.textContent = '（解读失败）';
  }
  delete cap.dataset.pending;
}

let reflowKey = '';   // 上次重排的输入键（页 + 引擎）——只在它变了才重排
let reflowSeq = 0;    // 防并发：快速翻页/切引擎时只让最新一次结果落地

async function rebuild(): Promise<void> {
  if (settings.viewMode !== 'reader') return;
  // 重排输入只由「当前页 + 重排引擎」决定。缩放、无关设置变化、布局抖动触发的 page:rendered
  // 都不该重排——这是"重复触发"的根（hybrid/vision 还会重复打网关）。
  const key = `${state.pageId ?? ''}|${settings.reflowProvider}`;
  if (key === reflowKey) return;
  reflowKey = key;
  const seq = ++reflowSeq;
  try {
    // 先读持久化的预排版缓存（重开/翻回即时，不再实时重排）；没有才算，算完写回
    let blocks = getReflow(state.pageIndex, settings.reflowProvider);
    if (!blocks) {
      blocks = await reflowProviders[settings.reflowProvider](state.textBlocks);
      if (seq !== reflowSeq || settings.viewMode !== 'reader') return; // 被更新的一次取代
      putReflow(state.pageIndex, settings.reflowProvider, blocks);
    }
    // 把原页图像按 y 顺序插回阅读流（图不丢；reflow 纯函数不动）
    const figures: FigureItem[] = state.imageRegions.map((bb, i) => ({ kind: 'figure', id: `fig_${state.pageIndex}_${i}`, source: bb }));
    const items: RenderItem[] = [...blocks, ...figures].sort((a, b) => a.source[1] - b.source[1]);
    render(items);
  } catch (e) {
    reflowKey = '';                       // 失败可重试（同输入下次触发再来一遍）
    if (seq !== reflowSeq) return;
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
  el.querySelector(`.reader-note[data-for="${o.overlay_id}"]`)?.remove();
  const ref = blockRefs.find((b) => b.id === blockId);
  if (!ref || o.state === 'dismissed') { layoutNotes(); return; }
  const note = document.createElement('div');
  note.className = 'reader-note';
  note.dataset.for = o.overlay_id;
  note.dataset.block = blockId;
  note.textContent = o.display_text;
  (pageWrap ?? el).appendChild(note); // 绝对定位进右侧留白，不进文档流 → 不扰乱正文排版
  layoutNotes();
}

/** 把右侧 AI 注按所属段的纵向位置摆好，重叠则下推。绝对定位，不影响正文。 */
function layoutNotes(): void {
  const items = ([...el.querySelectorAll('.reader-note')] as HTMLElement[])
    .map((n) => ({ n, top: blockRefs.find((b) => b.id === n.dataset.block)?.el.offsetTop ?? 0 }))
    .sort((a, b) => a.top - b.top);
  let cursor = 0;
  for (const { n, top } of items) {
    const y = Math.max(top, cursor);
    n.style.top = `${y}px`;
    cursor = y + n.offsetHeight + 12;
  }
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
    if (state.tool === 'eraser' || state.tool === 'hand') return; // hand 工具/手指不在重排面画
    if (e.pointerType === 'touch') return;                        // 触屏手指留给滚动导航
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
  window.addEventListener('resize', () => { if (settings.viewMode === 'reader') { resizeInk(); layoutNotes(); } });
}
