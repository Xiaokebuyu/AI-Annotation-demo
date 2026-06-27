import type { AnnotationEvent, EventType, NormBBox, ScreenOverlay, StrokePoint } from '../core/contracts';
import { SCHEMA_VERSION } from '../core/contracts';
import type { ReflowBlock } from './reflow';
import { bus, settings, state, strokeMarkIds, type Stroke, type Tool } from '../app/state';
import { recordInkSample } from '../local/bedrock-recorder';
import { styleFor } from '../capture/stroke-style';
import { reflowProviders, reflowAiStream } from './reflow-provider';
import { reflowLocal } from './reflow';
import { extractPageBlocks } from './renderer';
import { grabRegion } from '../evidence/ocr';
import { postJson } from '../core/api';
import { getFoldedMarks, getImageExplain, getReflow, putImageExplain, putReflow } from '../local/store';
import { bboxOf, classifyScored } from '../capture/classify';
import { DEVICE_ID, SESSION_ID, shortId } from '../core/ids';
import { pageCss } from '../core/transform';

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

// 字符对象 id → 所属重排块 id（跨视图锚：标注锚在字符对象上 → 解析到当前重排布局的块）。renderFinal 时重建。
let charToBlock = new Map<string, string>();
function buildIndex(blocks: ReflowBlock[]): void {
  charToBlock = new Map();
  const runToBlock = new Map<string, string>();        // run id → block id
  for (const b of blocks) for (const runId of b.sourceRunIds ?? []) runToBlock.set(runId, b.id);
  for (const o of state.surfaceIndex?.objects ?? []) { // 对象 id = `${runId}_${charIdx}` → 取末 _ 前为 runId
    const bid = runToBlock.get(o.id.slice(0, o.id.lastIndexOf('_')));
    if (bid) charToBlock.set(o.id, bid);
  }
}
/** 字符对象 id → 重排块 id（B 阶段按 ref 在重排视图定位 marks/旁注用）。 */
export function getCharToBlock(): Map<string, string> { return charToBlock; }

/** 一组对象 ref → 它们所在的重排块（取第一个命中的块）。 */
function resolveBlockForRefs(refs: string[]): BlockRef | null {
  for (const r of refs) {
    const bid = charToBlock.get(r);
    if (bid) { const ref = blockRefs.find((b) => b.id === bid); if (ref) return ref; }
  }
  return null;
}
/** 几何就近兜底：ref 空/未命中（如空白手写、旧缓存、VLM）时，取 source bbox y 中心最近的块。 */
function nearestBlockByBbox(bb: NormBBox): BlockRef | null {
  const aMid = bb[1] + bb[3] / 2;
  let best: BlockRef | null = null, bestD = Infinity;
  for (const ref of blockRefs) {
    const d = Math.abs((ref.source[1] + ref.source[3] / 2) - aMid);
    if (d < bestD) { bestD = d; best = ref; }
  }
  return best;
}

/** 重排面一笔：内容坐标 px + 每点真实压感/时间（喂 styleFor 压感线宽、喂 Tier2 运笔方式），tool 随笔走（钢笔/荧光笔）。 */
interface RPoint { x: number; y: number; pressure: number; t: number }
/** committed = onPenUp 发往 reader:gesture 的那条页坐标笔（strokeMarkIds 的 key）；橡皮据此回查整 mark。 */
interface ReaderStroke { tool: Tool; points: RPoint[]; committed?: Stroke }
const inkStrokes: ReaderStroke[] = []; // 已落的笔迹（内容坐标）
let live: { tool: Tool; t0: number; points: RPoint[] } | null = null;
const READER_DEADZONE_PX = 1.3; // 死区(内容 px)：丢相邻 < 此值的抖动点；对齐原版页 ink.ts，避免合并采点产生大量重复点
const MAX_CANVAS_PX = 16000;    // 画布高度封顶（防撞浏览器 canvas 维度上限~16384px，超则整画布失效）；极长重排页超出部分墨不渲染
let lastCanvasW = 0, lastCanvasH = 0, lastDpr = 0; // 上次画布尺寸+DPR：只在真变了才重建位图（避免流式逐块重建大缓冲=卡顿源；纳入 DPR 防换屏/缩放后比例错）

// ── 渲染 ──
/** 把一个重排文本块建成 DOM 节点（标题/段落/列表）。流式追加与整页渲染共用，保证两条路样式一致。 */
function makeBlockNode(b: ReflowBlock): HTMLElement {
  if (b.type === 'list') {
    const listEl = document.createElement(b.ordered ? 'ol' : 'ul');
    listEl.className = 'reader-list';
    listEl.dataset.bbox = b.source.map((n) => n.toFixed(4)).join(',');
    listEl.dataset.block = b.id;
    for (const item of b.items ?? []) {
      const li = document.createElement('li');
      li.textContent = item;
      listEl.appendChild(li);
    }
    return listEl;
  }
  const node = document.createElement(b.type === 'heading' ? 'h2' : 'p');
  node.className = b.type === 'heading' ? 'reader-h' : 'reader-p';
  if (b.type === 'heading') node.dataset.level = String(b.level);
  node.dataset.bbox = b.source.map((n) => n.toFixed(4)).join(',');
  node.dataset.block = b.id;
  node.textContent = b.text;
  return node;
}

function render(items: RenderItem[], warn: string = ''): void {
  el.querySelectorAll('.reader-page, .reader-empty, .reader-warn').forEach((n) => n.remove());
  pageWrap = null;
  inkStrokes.length = 0;
  if (warn) {
    const w = document.createElement('p');
    w.className = 'reader-warn';
    w.textContent = warn;
    el.insertBefore(w, inkCv);
  }
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
    const node = makeBlockNode(b);
    col.appendChild(node);
    blockRefs.push({ id: b.id, el: node, source: b.source });
  }
  wrap.appendChild(col);
  el.insertBefore(wrap, inkCv);
  pageWrap = wrap;
  // 旁注重贴移到 renderFinal（须在 buildIndex 之后，renderNote 才解析得出块）
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
  const prevSummary = ''; // 跨页记忆撤除（押后）：图解不再带前页摘要
  try {
    const data = await postJson<{ text?: string }>('/api/explain-image', { image, nearby, prevSummary, model: settings.inferModel });
    if (data?.text) { cap.textContent = `图：${String(data.text)}`; putImageExplain(state.pageIndex, source, String(data.text)); }
    else cap.textContent = '（这张图暂时没读出含义）';
  } catch {
    cap.textContent = '（解读失败）';
  }

  delete cap.dataset.pending;
}

let reflowKey = '';   // 上次重排的输入键（页 + 引擎 + 模型）——只在它变了才重排
let reflowSeq = 0;    // 防并发：快速翻页/切引擎时只让最新一次结果落地
let reflowAbort: AbortController | null = null; // 取消上一次未完的流式请求（快速翻页）
let reflowSettling = false; // 重排进行中（占位/流式/算块）→ 内容与画布尺寸不稳，期间不接落笔（避免画的墨随终渲被清空/错位）

/** 缓存/重排身份键：ai 引擎把模型并入（换重排模型 → 独立缓存、可 A/B），其余引擎用引擎名。 */
export function engineKey(provider: string): string {
  return provider === 'ai' ? `ai@${settings.reflowModel}` : provider;
}

/** 图片型 / 字号统一 PDF 的诚实提示（占位渲染时不显示，免占位也报"不可靠"）。 */
function unreliableWarn(): string {
  const sizes = state.textBlocks.map((b) => b.bbox[3]);
  const sizeSpread = sizes.length ? Math.max(...sizes) / Math.min(...sizes) - 1 : 0;
  if (state.textBlocks.length > 0 && state.textBlocks.length < 5)
    return '本页可识别文本极少（可能是图片型 PDF），重排不可靠 — 建议看「原版」。';
  if (sizeSpread < 0.06 && state.textBlocks.length > 20 && state.imageRegions.length === 0)
    return '本页字号统一、缺标题层级线索（常见于网页截图生成的 PDF），重排可能仅是按段堆叠。';
  return '';
}

/** 终渲：原页图像按 y 插回阅读流 + 警示，整页落地（建 blockRefs、重贴 AI 注）。 */
function renderFinal(blocks: ReflowBlock[], provisional = false): void {
  const figures: FigureItem[] = state.imageRegions.map((bb, i) => ({ kind: 'figure', id: `fig_${state.pageIndex}_${i}`, source: bb }));
  const items: RenderItem[] = [...blocks, ...figures].sort((a, b) => a.source[1] - b.source[1]);
  // VLM 看图重写：bbox 系模型估算、无源 run（anchorUnsafe）→ 跨视图标注只能按就近兜底（不精确），显式告知
  const warn = provisional ? ''
    : (blocks.length && blocks.every((b) => b.anchorUnsafe) ? 'VLM 看图重写：bbox 为估算，标注跨视图映射按就近兜底（不精确），需精确请用「AI 结构重建」。' : unreliableWarn());
  render(items, warn);
  buildIndex(blocks); // 重建 字符对象→块 映射（跨视图锚）
  void highlightMarks(); // 高亮被标注过的块
  state.overlays.filter((o) => o.page_id === state.pageId).forEach(renderNote); // 本页所有旁注按 ref 贴回（在 buildIndex 之后）
}

/** 在重排视图里高亮"被标注过"的块（mark 锚的对象 → 块；ref 空走几何就近）。 */
async function highlightMarks(): Promise<void> {
  const docId = state.documentId;
  if (!docId) return;
  const marks = await getFoldedMarks(docId);
  for (const m of marks) {
    if (m.page_id !== state.pageId) continue;
    const ref = resolveBlockForRefs(m.hmp?.target_object_refs ?? []) ?? nearestBlockByBbox(m.bbox);
    if (ref) ref.el.classList.add('reader-mark-highlight');
  }
}

// 流式渲染：首块到达时清占位、起空列；逐段 append（不插图，收尾 renderFinal 再按 y 插图 + 建 refs）。
let streamCol: HTMLElement | null = null;
function streamStart(): void {
  el.querySelectorAll('.reader-page, .reader-empty, .reader-warn').forEach((n) => n.remove());
  pageWrap = null; inkStrokes.length = 0; blockRefs = [];
  const wrap = document.createElement('div'); wrap.className = 'reader-page';
  const col = document.createElement('article'); col.className = 'reader-col';
  wrap.appendChild(col);
  el.insertBefore(wrap, inkCv);
  pageWrap = wrap; streamCol = col;
  resizeInk();
}
function streamAppend(b: ReflowBlock): void {
  if (!streamCol) return;
  const node = makeBlockNode(b);
  streamCol.appendChild(node);
  blockRefs.push({ id: b.id, el: node, source: b.source });
  // 流式期间不 resizeInk（用户不在画、墨画布无需逐块长高）——renderFinal 末尾统一重排一次，去掉逐块大位图重建。
}

async function rebuild(): Promise<void> {
  if (settings.viewMode !== 'reader') return;
  // 重排输入只由「当前页 + 引擎 + 重排模型」决定。缩放、无关设置变化、布局抖动触发的 page:rendered
  // 都不该重排——这是"重复触发"的根。
  const provider = settings.reflowProvider;
  const ekey = engineKey(provider);
  const key = `${state.pageId ?? ''}|${ekey}`;
  if (key === reflowKey) return;
  reflowKey = key;
  const seq = ++reflowSeq;
  reflowAbort?.abort(); reflowAbort = null;       // 翻得快 → 砍掉上一次未完的流
  const stale = () => seq !== reflowSeq || settings.viewMode !== 'reader';
  reflowSettling = true; // 重排开始：期间挡落笔（内容/画布尺寸不稳，避免画的墨随终渲被清/错位）
  try {
    // 1) 命中持久化缓存（翻回 / 已预热）→ 直接终渲，零请求
    const cached = getReflow(state.pageIndex, ekey);
    if (cached) { renderFinal(cached); void prewarmNext(provider); return; }

    // 2) ai 引擎：即时 local 占位（翻页不空白）→ 按段流式增强 → 终渲 + 落缓存
    if (provider === 'ai') {
      renderFinal(reflowLocal(state.textBlocks), true); // 占位：翻页瞬间就有可读内容
      let started = false;
      const onBlock = (b: ReflowBlock): void => {
        if (stale()) return;
        if (!started) { started = true; streamStart(); } // 首块到达才清占位，避免空屏闪
        streamAppend(b);
      };
      reflowAbort = new AbortController();
      let blocks: ReflowBlock[];
      try {
        blocks = await reflowAiStream(state.textBlocks, onBlock, reflowAbort.signal);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError' || stale()) return;
        blocks = await reflowProviders.ai(state.textBlocks);  // 流式失败 → 非流式兜底
      }
      if (stale()) return;
      streamCol = null;
      putReflow(state.pageIndex, ekey, blocks);
      renderFinal(blocks);                 // 终渲：图按 y 插回 + 建 blockRefs + 重贴 AI 注
      void prewarmNext(provider);
      return;
    }

    // 3) 非 ai 引擎（local/hybrid/vision/rewrite）：整块算完再渲（老路径）
    const blocks = await reflowProviders[provider](state.textBlocks);
    if (stale()) return;
    putReflow(state.pageIndex, ekey, blocks);
    renderFinal(blocks);
    void prewarmNext(provider);
  } catch (e) {
    reflowKey = '';                       // 失败可重试（同输入下次触发再来一遍）
    streamCol = null;
    if (seq !== reflowSeq) return;
    el.querySelectorAll('.reader-page, .reader-col, .reader-empty').forEach((n) => n.remove());
    const err = document.createElement('p');
    err.className = 'reader-empty';
    err.textContent = `重排失败：${(e as Error).message}`;
    el.insertBefore(err, inkCv);
  } finally {
    if (seq === reflowSeq) reflowSettling = false; // 本次重排结束（未被更新一次取代）→ 恢复落笔
  }
}

/** 预热下一页：后台抽下一页文本 + 非流式 ai 重排写入缓存，翻过去即缓存命中。只热 ai 主线。 */
async function prewarmNext(provider: string): Promise<void> {
  if (provider !== 'ai') return;
  const next = state.pageIndex + 1;
  if (next >= state.pageCount) return;
  const ekey = engineKey(provider);
  if (getReflow(next, ekey)) return;                       // 已缓存
  try {
    const blocks = await extractPageBlocks(next);
    if (!blocks.length || getReflow(next, ekey)) return;   // 双检（期间可能被填）
    const reflowed = await reflowProviders.ai(blocks);
    if (reflowed.length && !getReflow(next, ekey)) putReflow(next, ekey, reflowed);
  } catch { /* 预热失败不影响主流程 */ }
}

// ── 行内 AI 注 ──
/** 任意 overlay（不限来源）→ 按对象 ref 定位到所属重排块、贴行内注；ref 空/未命中走几何就近兜底。 */
function renderNote(o: ScreenOverlay): void {
  el.querySelector(`.reader-note[data-for="${o.overlay_id}"]`)?.remove();
  if (o.state === 'dismissed') { layoutNotes(); return; }
  const ref = resolveBlockForRefs(o.object_refs ?? []) ?? nearestBlockByBbox(o.geometry.anchor_bbox);
  if (!ref) { layoutNotes(); return; }
  const note = document.createElement('div');
  note.className = 'reader-note';
  note.dataset.for = o.overlay_id;
  note.dataset.block = ref.id;
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
  const h = Math.min(Math.max(el.scrollHeight, el.clientHeight), MAX_CANVAS_PX);
  // 只在尺寸真变了才重建位图（赋 canvas.width 总会重分配+清空大缓冲）——流式逐块 append 时尺寸基本不变即跳过，去掉重建风暴。
  if (w !== lastCanvasW || h !== lastCanvasH || dpr !== lastDpr) {
    inkCv.width = w * dpr; inkCv.height = h * dpr;
    inkCv.style.width = w + 'px'; inkCv.style.height = h + 'px';
    lastCanvasW = w; lastCanvasH = h; lastDpr = dpr;
  }
  inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  inkCtx.clearRect(0, 0, w, h);
  for (const s of inkStrokes) drawStroke(s);
  if (live) drawStroke(live);
}

/** 画一段线段（内容 px）：样式走共享 styleFor（压感线宽 + 荧光笔 multiply），与原版页同一画法。 */
function drawSegR(a: RPoint, b: RPoint, tool: Tool): void {
  if (!inkCtx) return;
  const s = styleFor(tool, b.pressure);
  inkCtx.globalCompositeOperation = s.composite;
  inkCtx.strokeStyle = s.stroke;
  inkCtx.lineCap = s.cap;
  inkCtx.lineWidth = s.width;
  inkCtx.beginPath();
  inkCtx.moveTo(a.x, a.y);
  inkCtx.lineTo(b.x, b.y);
  inkCtx.stroke();
  inkCtx.globalCompositeOperation = 'source-over';
}

function drawStroke(st: ReaderStroke): void {
  for (let i = 1; i < st.points.length; i++) drawSegR(st.points[i - 1], st.points[i], st.tool);
}

function contentPoint(e: PointerEvent): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top + el.scrollTop };
}

/** 命中哪一段：手势内容-y 中心落在哪个块的纵向范围内。
 *  返回块在**#reader 内容坐标**里的 left/top（与 contentPoint 同系），onPenUp 拿来当映射原点——
 *  绝不可改用 ref.el.offsetTop/offsetLeft：offsetParent 是 .reader-page、与内容坐标差一个页边距。 */
function hitBlock(pts: { x: number; y: number }[]): { ref: BlockRef; left: number; top: number } | null {
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const er = el.getBoundingClientRect();
  for (const ref of blockRefs) {
    const r = ref.el.getBoundingClientRect();
    const a = r.top - er.top + el.scrollTop;
    if (cy >= a - 6 && cy <= a + r.height + 6) return { ref, left: r.left - er.left, top: a };
  }
  return null;
}

// geometry.bbox 用该笔的**紧 bbox**（PDF 归一化），与原版页一致——main.ingestStroke 的 nearRegion/unionBb 要按
// 笔粒度判近邻才能正确组装（旧版传整块 bbox 会让组装退化到整块粒度）。pts 已由 onPenUp 映进命中块的 PDF 坐标。
function makeEvent(kind: EventType, pts: StrokePoint[]): AnnotationEvent {
  return {
    event_id: shortId('evt'), trace_id: shortId('trc'),
    document_id: state.documentId ?? '', page_id: state.pageId ?? '',
    event_type: kind, geometry: { bbox: bboxOf(pts) }, stroke_points: pts,
    text_note: null, created_at: new Date().toISOString(),
    device_id: DEVICE_ID, session_id: SESSION_ID, pointer_type: 'reader', version: SCHEMA_VERSION,
  };
}

function onPenUp(st: ReaderStroke): void {
  // 保留单点笔（中文的点/顿快写只落一个点）：孤立点按仍由下游 tap 过滤滤掉，多笔手写里的点靠 keepShortStrokes 存活。
  const raw = st.points;
  if (!raw.length) return;
  const hit = hitBlock(raw);
  if (!hit) return; // 没画在任何段上 → 不入
  if (!settings.gesture.enabled) return;
  const { ref, left, top } = hit;
  // 解耦（仅重排面）：笔的**形状/尺度**按页面尺度(pageCss)映成 PDF-norm，命中块只提供**锚点原点**(source 左上角)。
  // 旧法把笔挤进块的 source bbox（×source[2]/source[3]）——块过窄或退化(source≈0)时笔塌成点 → 判 tap 丢，
  // 取证连手写都收不到。改用 pageCss 这个稳定页尺度作除数（与 normToPx/redrawInk/grabLayers 同口径）：
  //   · 永不塌缩（与块宽窄/退化无关）；· 不夹值，落块上/下/旁都按真实相对位移映射；
  //   · #ink-layer 据此画出真实尺寸笔迹 → grabLayers 裁出的识别图即真实形状（识别图自动修好，无需改取图链路）。
  const w = pageCss.w || 1, h = pageCss.h || 1;
  const pts: StrokePoint[] = raw.map((p) => ({
    x: ref.source[0] + (p.x - left) / w,
    y: ref.source[1] + (p.y - top) / h,
    t: p.t, pressure: p.pressure,   // 真实时间/压感（喂 Tier2 运笔方式 / 未来压感），不再合成 t:i / 0.5
  }));
  const scored = classifyScored(pts, bboxOf(pts));
  const stroke: Stroke = { tool: st.tool, points: pts };
  st.committed = stroke; // 橡皮用：命中此重排笔 → strokeMarkIds.get(committed) 拿整 mark
  // 当正常 page-ledger mark：发 bus 给 main 走 ingestStroke（组装 + 跨视图 + 持久 + 同享 session/idle）
  bus.emit('reader:gesture', { event: makeEvent(scored.type, pts), stroke });
}

/** 落笔意图（仅重排面）：tool 决定——hand=滚动浏览、pen/highlighter=落笔(笔与手指都画)。
 *  eraser 在 pointerdown 单独处理（擦不画也不滚）。与原版页 resolveIntent 同精神，区别：重排面"导航"=原生滚动、非翻页。 */
function readerIntent(): 'annotate' | 'navigate' {
  return state.tool === 'hand' ? 'navigate' : 'annotate';
}

/** 橡皮命中：内容 px 半径内命中哪一条重排笔 → 擦它（连带整 mark）。点按命中最上面一条即返回。 */
function eraseAt(e: PointerEvent): void {
  const p = contentPoint(e);
  const R = 12; // 命中半径（内容 px）
  for (let i = inkStrokes.length - 1; i >= 0; i--) {
    if (inkStrokes[i].points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < R)) { eraseReaderStroke(inkStrokes[i]); return; }
  }
}

/** 擦一笔重排墨：已成 mark（committed 有 markId）→ 擦掉该 mark 的全部重排笔 + 页坐标副本 + 发 mark:erase 落 tombstone；
 *  尚未组装（无 markId·罕见的 6s 内擦）→ 只移这条视觉笔。 */
function eraseReaderStroke(st: ReaderStroke): void {
  const mid = st.committed ? strokeMarkIds.get(st.committed) : undefined;
  if (mid) {
    const pageArr = state.pageId ? state.strokesByPage.get(state.pageId) : undefined;
    for (let k = inkStrokes.length - 1; k >= 0; k--) {
      const c = inkStrokes[k].committed;
      if (c && strokeMarkIds.get(c) === mid) {
        if (pageArr) { const j = pageArr.indexOf(c); if (j >= 0) pageArr.splice(j, 1); } // 同步移页坐标副本→切回原版页不残留
        inkStrokes.splice(k, 1);
      }
    }
    bus.emit('mark:erase', mid); // → annotation-loop：落 tombstone + 从 session 移除
  } else {
    // 尚未组装（无 markId·6s 内擦/识别异步期）：撤在途笔——通知 annotation-loop 从 pending 组装队列 + strokesByPage + #ink-layer 移除
    // （否则 6s 后仍 assemble 成 mark 落账本、切原版页/reload 复活），再移本面视觉笔。
    if (st.committed) bus.emit('stroke:cancel', st.committed);
    const k = inkStrokes.indexOf(st);
    if (k >= 0) inkStrokes.splice(k, 1);
  }
  resizeInk(); // 重画重排画布
}

/** 基岩录制 tap（Tier 1·影子·死区前·surface=reader）。坐标按重排内容画布尺寸归一化、记真实运动；关时零开销。 */
function bedrockTapR(e: PointerEvent, phase: 'down' | 'move' | 'up'): void {
  if (!settings.bedrock || !state.documentId) return;
  const w = el.clientWidth || 1, h = Math.max(el.scrollHeight, el.clientHeight) || 1;
  const p = contentPoint(e);
  recordInkSample({
    documentId: state.documentId, pageId: state.pageId ?? undefined,
    x: p.x / w, y: p.y / h, phase, contactId: e.pointerId,
    pressure: e.pressure, dims: { w, h },
    penSource: e.pointerType === 'pen', surface: 'reader',
  });
}

/** 按当前工具切 #reader 的 touch-action：pen/highlighter/eraser 禁原生滚动→手指落笔即画/擦；仅 hand 放行纵向滚动。 */
function setReaderTouchAction(): void {
  if (!el) return;
  el.style.touchAction = settings.viewMode === 'reader' && readerIntent() === 'annotate' ? 'none' : 'pan-y';
}

export function initReader(readerEl: HTMLElement): void {
  el = readerEl;
  inkCv = document.createElement('canvas');
  inkCv.className = 'reader-ink';
  el.appendChild(inkCv);
  inkCtx = inkCv.getContext('2d');

  el.addEventListener('pointerdown', (e) => {
    if (settings.viewMode !== 'reader' || !state.pageId) return;
    if (state.tool === 'hand') return;                    // 让出给 #reader 原生滚动
    if (reflowSettling) return;                           // 重排未稳：让出原生滚动、不落笔/不擦（内容与画布尺寸不稳）
    e.preventDefault();
    if (state.tool === 'eraser') { eraseAt(e); return; }  // 橡皮：擦命中的笔/整 mark，不落 live、不滚
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    live = { tool: state.tool, t0: performance.now(), points: [{ ...contentPoint(e), pressure: e.pressure || 0, t: 0 }] };
    bedrockTapR(e, 'down');
  });
  el.addEventListener('pointermove', (e) => {
    if (state.tool === 'eraser' && e.buttons) { eraseAt(e); return; } // 按住拖动连擦（对齐原版页）
    if (!live) return;
    e.preventDefault();
    // 无损采点：优先取合并事件（快写时一次 move 携多个采样点）——对齐原版页 ink.ts，治中文快写笔点稀疏/毛糙。
    const coalesced = e.getCoalescedEvents ? (e.getCoalescedEvents() as PointerEvent[]) : [];
    const list = coalesced.length ? coalesced : [e];
    for (const ce of list) {
      const p = contentPoint(ce);
      bedrockTapR(ce, 'move'); // 死区前：连手抖也录进基岩
      const last = live.points[live.points.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < READER_DEADZONE_PX) continue; // 死区：丢 sub-px 抖动
      const pt: RPoint = { x: p.x, y: p.y, pressure: ce.pressure || 0, t: Math.round(performance.now() - live.t0) };
      drawSegR(last, pt, live.tool); // 增量画新线段（压感线宽，无须全量重画）
      live.points.push(pt);
    }
  });
  const finish = (e: PointerEvent) => {
    if (!live) return;
    bedrockTapR(e, 'up');
    const st = live; live = null;
    inkStrokes.push(st);
    onPenUp(st);
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', () => { live = null; resizeInk(); }); // 清掉已增量画上的 live 线段，否则留视觉幽灵墨

  bus.on('view:changed', rebuild);
  bus.on('view:changed', setReaderTouchAction); // 进/出重排 → touch-action 跟随
  bus.on('tool', setReaderTouchAction);          // 切工具 → 重排面滚动/落笔切换
  bus.on('page:rendered', rebuild);
  bus.on('settings:changed', rebuild);
  setReaderTouchAction();                          // 初始就位
  bus.on('overlay:add', (o) => { const ov = o as ScreenOverlay; if (settings.viewMode === 'reader' && ov.page_id === state.pageId) renderNote(ov); });
  bus.on('overlay:remove', (id) => el.querySelector(`.reader-note[data-for="${id as string}"]`)?.remove());
  bus.on('overlay:state', (o) => { const ov = o as ScreenOverlay; if (settings.viewMode === 'reader' && ov.page_id === state.pageId) renderNote(ov); });
  window.addEventListener('resize', () => { if (settings.viewMode === 'reader') { resizeInk(); layoutNotes(); } });
}
