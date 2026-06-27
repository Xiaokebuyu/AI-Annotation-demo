import type { AnnotationEvent, EventType, NormBBox, OverlayState, ScreenOverlay, StrokePoint, SurfaceObject } from '../core/contracts';
import { SCHEMA_VERSION } from '../core/contracts';
import type { PersistedAiTurn, PersistedMark, PersistedStroke } from '../core/store-format';
import type { ReflowBlock } from './reflow';
import { bus, settings, state, strokeMarkIds, type Stroke, type Tool } from '../app/state';
import { recordInkSample } from '../local/bedrock-recorder';
import { styleFor } from '../capture/stroke-style';
import { reflowProviders, reflowAiStream } from './reflow-provider';
import { reflowLocal } from './reflow';
import { extractPageBlocks } from './renderer';
import { grabRegion } from '../evidence/ocr';
import { postJson } from '../core/api';
import { getBookAiTurns, getFoldedMarks, getImageExplain, getReflow, putImageExplain, putReflow } from '../local/store';
import { bboxOf, classifyScored } from '../capture/classify';
import { DEVICE_ID, SESSION_ID, shortId } from '../core/ids';
import { pageCss } from '../core/transform';
import { devEmit } from '../core/dev-telemetry';

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
// AI 旁注摆放：'margin'=桌面右栏绝对定位；'inline'=移动版段落下方内联低语（贴电纸屏 AI 语言）。
let notePlacement: 'margin' | 'inline' = 'margin';

interface BlockRef { id: string; el: HTMLElement; source: NormBBox; runIds: string[]; }
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
/** 一组 source run id → 含其一的当前重排块（refs=0 自由笔落笔时存的"位置真相锚"·= reflow_anchor_runs）：
 *  认存下的段、不靠（可能溢出的）坐标猜 → 同布局恒等、重开跟段走。重排重分组时取第一个仍含该 run 的块。 */
function resolveBlockByRuns(runs: string[]): BlockRef | null {
  for (const r of runs) { const ref = blockRefs.find((b) => b.runIds.includes(r)); if (ref) return ref; }
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
// 旧 mark 真笔触重画通道（仅 restoreStrokes 开=移动版重排）：把持久 mark 的页归一化 strokes 反投影回所属块、
// 独立于 live inkStrokes（免被橡皮/收口/在途笔误伤），每次 layout 变（重排 rebuild / 内联旁注插入致块位移）重算。
let restoreStrokes = false;
const restoredStrokes: Array<ReaderStroke & { markId: string }> = [];
const restoredMarkIds = new Set<string>(); // 已被 restored 重画的 mark_id → resizeInk 跳过同 mark 的 live inkStroke，免双画
// 分页（电纸屏·虚拟页）：把一个 PDF 页的重排流按屏高切成多张「虚拟页」翻阅——固定屏高翻页（电纸屏更自然），
// 内容仍是一条流、只是禁自由滚 + 按「块对齐」断页步进 scrollTop。虚拟页是 reader 派生态：不进 store、多虚拟页共享同一 PDF page_id/HMP。
let paginate = false;
let vIndex = 0;             // 当前 PDF 页内的虚拟页号
let landAtEnd = false;      // 翻回上一 PDF 页时落在其最后一张虚拟页（衔接连续阅读）
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
  restoredStrokes.length = 0; restoredMarkIds.clear(); // 旧页 restored 先清，免 syncRestoredMarks 异步重填前闪上一页笔触
  if (replyMode) { el.querySelectorAll('.reader-reply-mark').forEach((n) => n.remove()); closePopover(); } // 旧页 AI 回复标记/浮层
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
      img.addEventListener('load', () => { if (img.isConnected) repaginate(); }); // 图解码完高度才定 → 重排页 + 重投影（否则分页按 0 高算、图/后文可能横跨屏边界）
      if (crop) img.src = crop;
      const cap = document.createElement('figcaption');
      cap.className = 'reader-figcap';
      cap.dataset.pending = '1';
      cap.textContent = '正在解读这张图…';
      if (replyMode) cap.style.display = 'none'; // 折叠：生成中也不内联（explainFigure 仍写 cap·finish 读 textContent 存进 fig.dataset.explain·CSS 隐）
      fig.appendChild(img);
      fig.appendChild(cap);
      if (replyMode) fig.addEventListener('pointerdown', (e) => { const t = fig.dataset.explain; if (t) { e.stopPropagation(); e.preventDefault(); openFigurePopover(fig, t); } }); // 图解折叠：点图弹浮层
      col.appendChild(fig);
      void explainFigure(cap, it.source, crop);
      continue;
    }
    const b = it;
    const node = makeBlockNode(b);
    col.appendChild(node);
    blockRefs.push({ id: b.id, el: node, source: b.source, runIds: b.sourceRunIds ?? [] });
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
  const finish = (): void => {
    delete cap.dataset.pending;
    if (replyMode) { const fig = cap.closest('.reader-fig') as HTMLElement | null; if (fig) { fig.dataset.explain = cap.textContent ?? ''; fig.classList.add('has-reply'); } } // 图解收进点触浮层（caption 由 CSS 隐藏·点图弹）
    if (cap.isConnected) repaginate();
  };
  if (!image) { cap.textContent = '（无法截取此图）'; finish(); return; }
  const cached = getImageExplain(state.pageIndex, source); // 已解读过 → 直接用，不再调模型
  if (cached) { cap.textContent = `图：${cached}`; finish(); return; }
  const nearby = nearbyText(source);
  const prevSummary = ''; // 跨页记忆撤除（押后）：图解不再带前页摘要
  try {
    const data = await postJson<{ text?: string }>('/api/explain-image', { image, nearby, prevSummary, model: settings.inferModel });
    if (data?.text) { cap.textContent = `图：${String(data.text)}`; putImageExplain(state.pageIndex, source, String(data.text)); }
    else cap.textContent = '（这张图暂时没读出含义）';
  } catch {
    cap.textContent = '（解读失败）';
  }
  finish(); // 删 pending + replyMode 存图解到 fig + 图解文字到达改了高度→重排页
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
  if (!replyMode) state.overlays.filter((o) => o.page_id === state.pageId).forEach(renderNote); // 桌面/原版：内联/右栏旁注。移动版重排走点触浮层标记（syncRestoredMarks 末尾·不进文档流、不扰分页）
  settleV(provisional ? 'relayout' : 'render'); // 先真分页排版（插 spacer 推块到屏顶·块位变）；占位渲染只保位、终渲才落目标虚拟页
  void syncRestoredMarks(); // 再按分页后的最终块位重画旧 mark 真笔触 + 高亮被标注块（+replyMode 末尾画 AI 回复标记）
}

/** #reader 内容坐标系里某块的左上角（与 contentPoint/hitBlock 同系：减容器 rect、加 scrollTop）。 */
function blockContentOrigin(ref: BlockRef): { left: number; top: number } {
  const er = el.getBoundingClientRect();
  const rr = ref.el.getBoundingClientRect();
  return { left: rr.left - er.left, top: rr.top - er.top + el.scrollTop };
}

/** 把一条持久笔（页归一化点串）反投影回所属重排块的当前屏幕位置——onPenUp 映射的逆。
 *  等比：用 pageCss 这个稳定页尺度做除数（**不**按块宽高分别拉伸）→ 圈仍是圈、不畸变；
 *  位置锚到块左上、随文本换行近似（不保证精准套原字，但保形）。 */
function projectPersistedStroke(ps: PersistedStroke, ref: BlockRef): ReaderStroke {
  const o = blockContentOrigin(ref);
  const w = pageCss.w || 1, h = pageCss.h || 1;
  return {
    tool: ps.tool === 'highlighter' ? 'highlighter' : 'pen',
    points: ps.points.map((p) => ({ x: o.left + (p.x - ref.source[0]) * w, y: o.top + (p.y - ref.source[1]) * h, pressure: p.pressure, t: p.t })),
  };
}

// ── 标注锚到文本对象（重排锚定重做）：标注跟着它所标的「字」走，而非按原页坐标硬摆进块 ──
// 字符对象（SurfaceObject.id=`${runId}_${charIdx}`）在重排 DOM 里的真实位置由 Range 定位；按标注类型投影（下划线/高亮切段跟随换行·圈/符号整笔平移）。
type CRect = { left: number; top: number; width: number; height: number };
type Col = { b: NormBBox; r: CRect };
let objectById = new Map<string, SurfaceObject>();
let anchorObjs: SurfaceObject[] = [];                                                      // 有文字的对象（就近锚扫描用·每 sync 建一次）
const blockOffsetCache = new Map<string, Map<string, { start: number; len: number }>>(); // blockId → (objId → DOM UTF-16 [start,len])
const objRectCache = new Map<string, CRect[]>();                                          // objId → content 矩形（一次 sync 内复用）
function anchorCachesReset(): void {
  objectById = new Map((state.surfaceIndex?.objects ?? []).map((o) => [o.id, o]));
  anchorObjs = [...objectById.values()].filter((o) => !!o.text && !!o.text.trim());
  blockOffsetCache.clear(); objRectCache.clear();
}
const runIdOf = (id: string): string => id.slice(0, id.lastIndexOf('_'));
const charIdxOf = (id: string): number => Number(id.slice(id.lastIndexOf('_') + 1));
const W = (): number => pageCss.w || 1, Hn = (): number => pageCss.h || 1;

/** 本块「字符对象 id → DOM 文本节点 UTF-16 [start,len]」：源字符（按 run 序+charIdx=阅读序）逐个对齐 DOM 文本的
 *  非空白码点（两边都跳空白·1:1，故不必精确复刻 joinRuns 的插空格/trim）。仅单文本节点块（.reader-p/.reader-h）；
 *  列表/多节点返回空 → 退块级。 */
function blockCharOffsets(ref: BlockRef): Map<string, { start: number; len: number }> {
  const hit = blockOffsetCache.get(ref.id); if (hit) return hit;
  const map = new Map<string, { start: number; len: number }>();
  const tn = ref.el.firstChild;
  if (ref.el.childNodes.length === 1 && tn && tn.nodeType === 3) {
    const runOrder = new Map(ref.runIds.map((id, i) => [id, i] as const));
    const chars = [...objectById.values()]
      .filter((o) => runOrder.has(runIdOf(o.id)) && !!o.text && !!o.text.trim())
      .sort((a, b) => ((runOrder.get(runIdOf(a.id)) ?? 0) - (runOrder.get(runIdOf(b.id)) ?? 0)) || (charIdxOf(a.id) - charIdxOf(b.id)));
    const text = tn.textContent ?? '';
    const dom: Array<{ off: number; len: number; cp: string }> = [];
    let off = 0;
    for (const cp of text) { if (cp.trim()) dom.push({ off, len: cp.length, cp }); off += cp.length; }
    // 一致性校验：源非空白字符串 === DOM 非空白字符串 才做字符级锚定。否则（AI/hybrid/rewrite 改写文字·列表剥符号致字符数/内容不符）
    // 按序号硬对齐会整体贴错字 → 留空 map、退块级兜底（宁可粗、不贴错）。
    if (chars.map((c) => c.text).join('') === dom.map((d) => d.cp).join('')) {
      for (let i = 0; i < chars.length; i++) map.set(chars[i].id, { start: dom[i].off, len: dom[i].len });
    }
  }
  blockOffsetCache.set(ref.id, map);
  return map;
}
/** 字符对象 → 它在重排 DOM 里的真实矩形（content 坐标·跨行返回多段）；定位不到 []。 */
function rectsForObject(objId: string): CRect[] {
  const hit = objRectCache.get(objId); if (hit) return hit;
  let out: CRect[] = [];
  const bid = charToBlock.get(objId);
  const ref = bid ? blockRefs.find((b) => b.id === bid) : undefined;
  const tn = ref?.el.firstChild;
  const e = ref ? blockCharOffsets(ref).get(objId) : undefined;
  if (ref && tn && e) {
    try {
      const range = document.createRange();
      range.setStart(tn, e.start); range.setEnd(tn, e.start + e.len);
      const er = el.getBoundingClientRect();
      out = [...range.getClientRects()].map((r) => ({ left: r.left - er.left, top: r.top - er.top + el.scrollTop, width: r.width, height: r.height }));
    } catch { out = []; }
  }
  objRectCache.set(objId, out);
  return out;
}
/** 整笔平移：保形保真迹（pageCss 等比）·把源锚点(页归一)摆到目标 content 矩形左上。符号/箭头/手写/圈用。 */
function translateWhole(strokes: PersistedStroke[], srcX: number, srcY: number, dst: CRect): ReaderStroke[] {
  return strokes.map((ps) => ({ tool: (ps.tool === 'highlighter' ? 'highlighter' : 'pen') as Tool,
    points: ps.points.map((p) => ({ x: dst.left + (p.x - srcX) * W(), y: dst.top + (p.y - srcY) * Hn(), pressure: p.pressure, t: p.t })) }));
}
/** 最近文本对象 + 其重排矩形（refs 空的手写符号 why/? 靠这条就近锚·= 用户说的"空间线"）。取最近 8 个里第一个能定位的。 */
function nearestObjectRect(bb: NormBBox): { obj: SurfaceObject; rect: CRect } | null {
  const cx = bb[0] + bb[2] / 2, cy = bb[1] + bb[3] / 2;
  const top: Array<{ o: SurfaceObject; d: number }> = []; // 单遍维护最近 6（避免每条 mark 全量 sort）
  for (const o of anchorObjs) {
    const d = Math.hypot(o.bbox[0] + o.bbox[2] / 2 - cx, o.bbox[1] + o.bbox[3] / 2 - cy);
    if (top.length < 6) { top.push({ o, d }); top.sort((a, b) => a.d - b.d); }
    else if (d < top[5].d) { top[5] = { o, d }; top.sort((a, b) => a.d - b.d); }
  }
  for (const { o } of top) { const r = rectsForObject(o.id); if (r.length) return { obj: o, rect: r[0] }; } // 最近的若在不可定位块(列表/改写)→试次近·都不行返回 null→退块级
  return null;
}
/** 跨度类（下划线/高亮）按字符切段：每命中字符一段·x 拉伸到重排字宽(无缝)·y 锚字底(下划线)/字框(高亮)+保原偏移。
 *  字一换行各字矩形自然分到多行 → 段也跟着分行（**既保原笔 y 起伏，又跟随换行**）。 */
function segmentByChars(strokes: PersistedStroke[], located: Array<{ obj: SurfaceObject; rects: CRect[] }>, action: string): ReaderStroke[] {
  const cols: Col[] = located.map((l) => ({ b: l.obj.bbox, r: l.rects[0] })).sort((a, b) => (a.b[1] - b.b[1]) || (a.b[0] - b.b[0]));
  if (!cols.length) return [];
  const pick = (x: number, y: number): Col => { let best = cols[0], bd = Infinity; for (const c of cols) { const d = Math.hypot((c.b[0] + c.b[2] / 2) - x, (c.b[1] + c.b[3] / 2) - y); if (d < bd) { bd = d; best = c; } } return best; }; // 2D 最近（原标注跨多原文行也分对行）
  const out: ReaderStroke[] = [];
  for (const ps of strokes) {
    const tool: Tool = ps.tool === 'highlighter' ? 'highlighter' : 'pen';
    // 按「重排行」分组（非按单字）：同一重排行的连续点是一段（连得上·避免单点段画不出）；换到另一行才断 → 自然跟随换行拆段。
    let cur: { lineTop: number; pts: RPoint[] } | null = null;
    const flush = (): void => { if (cur && cur.pts.length >= 2) out.push({ tool, points: cur.pts }); cur = null; }; // <2 点 drawStroke 画不出 → 丢
    for (const p of ps.points) {
      const c = pick(p.x, p.y);
      const [bx, by, bw, bh] = c.b; const r = c.r;
      const mapped: RPoint = {
        x: r.left + (bw ? (p.x - bx) / bw : 0) * r.width,                // x 拉伸到重排字宽（相邻字段无缝）
        y: action === 'highlight'
          ? r.top + (bh ? (p.y - by) / bh : 0) * r.height               // 高亮：y 拉到字框
          : (r.top + r.height) + (p.y - (by + bh)) * Hn(),              // 下划线：y 锚字底 + 保原 px 偏移（与重排字号无关）
        pressure: p.pressure, t: p.t,
      };
      if (cur && Math.abs(r.top - cur.lineTop) > 8) flush();            // 换到重排另一行 → 断段
      if (!cur) cur = { lineTop: r.top, pts: [] };
      cur.pts.push(mapped);
    }
    flush();
  }
  return out;
}
/** 圈/箭头/有 refs 的手写：整笔平移到 refs **首行**并集（跨行落首行·保形不切散弧）。src 锚点也取首行 refs（否则跨行第二行更靠左时水平偏）。 */
function projectSpan(strokes: PersistedStroke[], located: Array<{ obj: SurfaceObject; rects: CRect[] }>): ReaderStroke[] {
  const items = located.map((l) => ({ b: l.obj.bbox, r: l.rects[0] }));
  const minTop = Math.min(...items.map((i) => i.r.top));
  const line = items.filter((i) => i.r.top < minTop + 6); // 首行（重排）
  const dst: CRect = { left: Math.min(...line.map((i) => i.r.left)), top: minTop,
    width: Math.max(...line.map((i) => i.r.left + i.r.width)) - Math.min(...line.map((i) => i.r.left)),
    height: Math.max(...line.map((i) => i.r.top + i.r.height)) - minTop };
  return translateWhole(strokes, Math.min(...line.map((i) => i.b[0])), Math.min(...line.map((i) => i.b[1])), dst); // src 也取首行 refs
}
/** 一条 mark → restored 笔触：按 action/refs 分流。下划线·高亮=切段跟随换行；圈=整笔首行；refs=0 自由笔/兜底=块级（恒等·跟段落）。 */
function projectPersistedMark(m: PersistedMark, fallback: BlockRef | null): ReaderStroke[] {
  const action = m.hmp?.action ?? '';
  const strokes = m.strokes ?? [];
  const refs = m.hmp?.target_object_refs ?? [];
  const located = refs.map((id) => ({ obj: objectById.get(id), rects: rectsForObject(id) }))
    .filter((x): x is { obj: SurfaceObject; rects: CRect[] } => !!x.obj && x.rects.length > 0);
  if (located.length) { // refs 命中 → 锚到那几个字
    if (action === 'underline' || action === 'highlight') return segmentByChars(strokes, located, action);
    return projectSpan(strokes, located); // 圈/箭头/有 refs 的手写：整笔锚首行并集（不误入切段·也不丢 refs 改用 nearest）
  }
  // 块级反投影（projectPersistedStroke）——refs=0 自由笔（手写/画/边注·无字可锚·self_content）走这条：
  //  · **逐笔认各自落笔的块**（stroke.anchor_runs）：多笔手写常跨段落交界、各笔命中不同块；onPenUp 把每笔的坐标存成
  //    **它自己那个块**的相对坐标，故重投影也必须**逐笔回各自的块**才恒等——若整 mark 统一锚一个块，别块的笔会被按
  //    「原版页块间距≠重排块间距」拉拢/塌缩（实测：3 笔 mark live y122–169、统一锚后 restored 塌成 y122–133）。
  //  · 缺自己 anchor（老 mark/原版落笔）→ 退 mark 级 fallback 块（nearestBlockByBbox 几何就近·近似）。
  //  · ⚠️别再改回 nearestObjectRect 字符锚——非恒等、当场漂移（M10 回归，已撤）。
  return strokes
    .map((ps) => {
      const blk = (ps.anchor_runs?.length ? resolveBlockByRuns(ps.anchor_runs) : null) ?? fallback;
      return blk ? projectPersistedStroke(ps, blk) : null;
    })
    .filter((s): s is ReaderStroke => !!s);
}

/** 重排里同步旧标注：高亮被标注块；restoreStrokes 开时再把该 mark 的真笔触反投影进 restoredStrokes 重画。
 *  async（getFoldedMarks）→ 捕获 page/seq 守卫，await 后页/重排/视图已变则整次作废（防跨页串画）。 */
async function syncRestoredMarks(): Promise<void> {
  const docId = state.documentId;
  const pageId = state.pageId;
  const seq = reflowSeq;
  if (!docId) return;
  const marks = await getFoldedMarks(docId);
  if (state.documentId !== docId || state.pageId !== pageId || seq !== reflowSeq || settings.viewMode !== 'reader') return; // 守卫：期间翻页/重排/切视图 → 作废
  restoredStrokes.length = 0;
  restoredMarkIds.clear();
  el.querySelectorAll('.reader-mark-highlight').forEach((n) => n.classList.remove('reader-mark-highlight')); // 先清旧高亮：本函数会被 overlay/视图切换重复调（非只 render 后 DOM 已新建）→ 高亮始终反映当前活 mark
  if (restoreStrokes) anchorCachesReset(); // 本次 sync 重建对象表 + 每块字符偏移 + 对象矩形缓存（一次 sync 内复用）
  for (const m of marks) {
    if (m.page_id !== pageId) continue;
    // 块锚优先级：①存下的位置真相锚（reflow_anchor_runs·恒等定段）②markup 的字符 refs 所在块 ③几何就近（老 mark/原版落笔的兜底·近似）
    const block = (m.reflow_anchor_runs?.length ? resolveBlockByRuns(m.reflow_anchor_runs) : null)
      ?? resolveBlockForRefs(m.hmp?.target_object_refs ?? []) ?? nearestBlockByBbox(m.bbox);
    if (block) block.el.classList.add('reader-mark-highlight'); // 被标注块高亮（桌面 styles.css 用·移动版 CSS 已去竖线不绘）
    if (!restoreStrokes) continue;
    const segs = projectPersistedMark(m, block); // 标注锚到文本对象（按类型投影），非纯块级
    // 遥测·重排锚定：live 落点（用户实际画处）vs 重投影落点 + 认到的块 → live==restored 即恒等不漂；不等=漂/塌缩、看漂去哪。
    {
      const bb = (pts: { x: number; y: number }[]): number[] | null => pts.length ? [Math.round(Math.min(...pts.map((p) => p.x))), Math.round(Math.min(...pts.map((p) => p.y))), Math.round(Math.max(...pts.map((p) => p.x))), Math.round(Math.max(...pts.map((p) => p.y)))] : null;
      const livePts = inkStrokes.filter((s) => s.committed && strokeMarkIds.get(s.committed) === m.mark_id).flatMap((s) => s.points);
      const restPts = segs.flatMap((s) => s.points);
      const refs0 = !(m.hmp?.target_object_refs?.length);
      if (refs0) devEmit('reflow', () => ({ at: 'reproj', mark: m.mark_id, ft: m.feature_type, ns: m.strokes.length,
        anchor: (m.reflow_anchor_runs ?? []).slice(0, 5), block: block?.id ?? null, blockRuns: (block?.runIds ?? []).slice(0, 5),
        liveBbox: bb(livePts), restoredBbox: bb(restPts) }));
    }
    for (const rs of segs) if (rs.points.length) restoredStrokes.push({ ...rs, markId: m.mark_id });
    if (segs.some((s) => s.points.length >= 2)) restoredMarkIds.add(m.mark_id); // 只有真画出可绘 restored 才标记（否则去重会误跳该 mark 的 live inkStroke）
  }
  if (restoreStrokes) resizeInk(); // 重画（restored 笔此刻才就位）；桌面 restoreStrokes=false 不多画一次
  if (replyMode && state.documentId === docId && state.pageId === pageId && seq === reflowSeq) { // AI 回复点触标记（用上面已加载的 marks + 现取 ai_turns join 判类型；restored 已就位故 box 取得到手写包围盒）
    const turns = await getBookAiTurns(docId);
    if (state.documentId === docId && state.pageId === pageId && seq === reflowSeq && settings.viewMode === 'reader') { // 第二 await 后补 documentId 守卫·两表都在守卫内赋值（免 stale 覆盖）
      markByIdR = new Map(marks.map((m) => [m.mark_id, m]));
      turnByOverlay = new Map(turns.map((t) => [t.overlay_id, t]));
      renderReplyMarkers();
    }
  }
}

let syncScheduled = false;
/** 内联旁注插入/移除致块位移后，rAF 合批重算 restored（让已成 mark 的圈画跟着新布局走）。桌面 no-op。 */
function scheduleSyncRestoredMarks(): void {
  if (!restoreStrokes || settings.viewMode !== 'reader') return;
  if (syncScheduled) return;
  syncScheduled = true;
  requestAnimationFrame(() => { syncScheduled = false; settleV('relayout'); void syncRestoredMarks(); }); // 插旁注致内容移位 → 重算断点（保持当前虚拟页）+ restored 重投影
}

// 流式渲染：首块到达时清占位、起空列；逐段 append（不插图，收尾 renderFinal 再按 y 插图 + 建 refs）。
let streamCol: HTMLElement | null = null;
function streamStart(): void {
  el.querySelectorAll('.reader-page, .reader-empty, .reader-warn').forEach((n) => n.remove());
  pageWrap = null; inkStrokes.length = 0; blockRefs = [];
  restoredStrokes.length = 0; restoredMarkIds.clear(); // 同 render：流式重渲先清旧页 restored
  if (replyMode) { el.querySelectorAll('.reader-reply-mark').forEach((n) => n.remove()); closePopover(); } // 旧页 AI 回复标记/浮层（否则浮在空列/半成品流上）
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
  blockRefs.push({ id: b.id, el: node, source: b.source, runIds: b.sourceRunIds ?? [] });
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
  if (notePlacement === 'inline') ref.el.insertAdjacentElement('afterend', note); // 移动版：插到所属段落之后，进文档流、贴行下方
  else (pageWrap ?? el).appendChild(note); // 桌面：绝对定位进右侧留白，不进文档流 → 不扰乱正文排版
  layoutNotes();
}

/** 把右侧 AI 注按所属段的纵向位置摆好，重叠则下推。绝对定位，不影响正文。 */
function layoutNotes(): void {
  if (notePlacement === 'inline') return; // 内联：旁注在文档流里、随段落自然排，无需绝对定位
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

// ── AI 回复折叠成点触浮层（仅移动版重排面 replyMode；桌面/原版仍走 renderNote/whisper-layer）──
// 被回复内容上留特殊标记（圈/划/高亮=点状下划线·手写/画=虚线框·图=虚线框·idle综合=边缘☆），点标记弹浮层显回复+动作，点别处消失。
let replyMode = false;
let popoverEl: HTMLElement | null = null;
let turnByOverlay = new Map<string, PersistedAiTurn>();   // overlay_id → ai_turn（判类型用·join 而来）
let markByIdR = new Map<string, PersistedMark>();          // mark_id → mark
/** 加载 ai_turns + marks 建 join 表（判"被回复内容类型"用·和 M10 同款异步）。 */
async function refreshReplyMeta(): Promise<boolean> {
  const docId = state.documentId, pageId = state.pageId, seq = reflowSeq;
  if (!docId) { turnByOverlay = new Map(); markByIdR = new Map(); return false; }
  const [turns, marks] = await Promise.all([getBookAiTurns(docId), getFoldedMarks(docId)]);
  if (state.documentId !== docId || state.pageId !== pageId || seq !== reflowSeq) return false; // await 期间翻页/切书/重排 → 别用 stale 表覆盖当前页
  turnByOverlay = new Map(turns.map((t) => [t.overlay_id, t]));
  markByIdR = new Map(marks.map((m) => [m.mark_id, m]));
  return true;
}
type ReplyMeta = { kind: 'text'; refs: string[] } | { kind: 'box'; markId?: string } | { kind: 'idle' };
/** overlay → 被回复内容类型（join ai_turn→触发 mark 的 action/feature；join 不到则按 object_refs 粗分兜底）。 */
function classifyOverlay(o: ScreenOverlay): ReplyMeta {
  const turn = turnByOverlay.get(o.overlay_id);
  const ab = turn?.inference_view?.anchor_bbox ?? o.geometry.anchor_bbox; // 触发/锚 mark：本页 mark_ids 里 bbox 最贴 anchor_bbox 的（无显式 anchor_mark_id）
  let mark: PersistedMark | undefined;
  if (turn) { let bd = Infinity;
    for (const mid of turn.anchor?.mark_ids ?? []) { const m = markByIdR.get(mid); if (!m || m.page_id !== state.pageId) continue;
      const d = Math.hypot((m.bbox[0] + m.bbox[2] / 2) - (ab[0] + ab[2] / 2), (m.bbox[1] + m.bbox[3] / 2) - (ab[1] + ab[3] / 2));
      if (d < bd) { bd = d; mark = m; } } }
  const act = mark?.hmp?.action;
  if (mark) { // 按内容定：标记反映被标注的内容（不管是不是 idle 触发·用户定）
    if (mark.feature_type === 'markup' && (act === 'enclosure' || act === 'underline' || act === 'highlight')) return { kind: 'text', refs: mark.hmp?.target_object_refs ?? o.object_refs ?? [] };
    if (mark.feature_type === 'handwriting' || mark.feature_type === 'drawing' || mark.hmp?.mode === 'self_content' || act === 'sketch' || act === 'handwriting') return { kind: 'box', markId: mark.mark_id };
  }
  if ((o.object_refs?.length ?? 0) > 0) return { kind: 'text', refs: o.object_refs ?? [] }; // 无可定位锚 mark·但有文字 refs（页面级综合也常锚文字）
  if (turn?.trigger === 'idle') return { kind: 'idle' }; // 真·无单一内容锚的纯页面级综合 → 边缘 ☆
  return { kind: 'box', markId: mark?.mark_id };
}
/** 字符对象群 → 多行 union 矩形（点状下划线按行画·跨行多段）。 */
function lineRectsForRefs(refs: string[]): CRect[] {
  const rects = refs.flatMap((id) => rectsForObject(id)).sort((a, b) => a.top - b.top);
  const lines: CRect[] = [];
  for (const r of rects) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(r.top - last.top) < 8) { const right = Math.max(last.left + last.width, r.left + r.width); last.left = Math.min(last.left, r.left); last.width = right - last.left; last.top = Math.min(last.top, r.top); last.height = Math.max(last.height, r.height); }
    else lines.push({ ...r });
  }
  return lines;
}
/** 手写/画 mark 在重排里的包围盒（取它已重画的 restoredStrokes·= 真实位置）；无则就近文本对象。 */
function markBox(markId: string | undefined, anchorBbox: NormBBox): CRect | null {
  const pts = markId ? restoredStrokes.filter((s) => s.markId === markId).flatMap((s) => s.points) : [];
  if (pts.length) { const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y); return { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }; }
  return nearestObjectRect(anchorBbox)?.rect ?? null;
}
const padBox = (b: CRect): CRect => ({ left: b.left - 4, top: b.top - 3, width: b.width + 8, height: b.height + 6 });
function addReplyMark(cls: string, box: CRect, o: ScreenOverlay): void {
  const m = document.createElement('div');
  m.className = `reader-reply-mark ${cls} st-${o.state}`; // st-accepted/edited 给视觉状态（已处理 vs 未处理）
  m.dataset.for = o.overlay_id;
  m.style.cssText = `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;`;
  m.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); openPopover(m, o); }); // 阻断 reader 落笔
  el.appendChild(m); // 直接挂 #reader（滚动容器·随内容滚·像 ink 画布）
}
/** 重排里画出所有 AI 回复的标记（替代常驻内联低语）。 */
function renderReplyMarkers(): void {
  if (!replyMode) return;
  el.querySelectorAll('.reader-reply-mark').forEach((n) => n.remove()); closePopover();
  for (const o of state.overlays) {
    if (o.page_id !== state.pageId || o.state === 'dismissed') continue;
    const meta = classifyOverlay(o);
    let drawn = false;
    if (meta.kind === 'text') {
      for (const r of lineRectsForRefs(meta.refs)) { addReplyMark('dot-underline', { left: r.left, top: r.top + r.height + 1, width: r.width, height: 3 }, o); drawn = true; }
    }
    if (!drawn && meta.kind !== 'idle') {
      const b = markBox(meta.kind === 'box' ? meta.markId : undefined, o.geometry.anchor_bbox);
      if (b) { addReplyMark('dash-box', padBox(b), o); drawn = true; }
    }
    if (!drawn) { // idle·或 text/box 定位全失败 → 边缘☆兜底：**回复永不无声消失**（定位不到也给个可点入口·移动重排已撤内联 note/whisper、没这条就彻底看不见）
      const r = nearestObjectRect(o.geometry.anchor_bbox)?.rect;
      addReplyMark('edge-star', { left: 1, top: (r?.top ?? el.scrollTop) + 1, width: 16, height: 16 }, o);
    }
  }
}
function closePopover(): void { popoverEl?.remove(); popoverEl = null; }
/** 点标记 → 弹浮层（☆回复 + 收下/改写/散去）·定位标记下方夹进视口。 */
function openPopover(trigger: HTMLElement, o: ScreenOverlay): void {
  closePopover();
  const pop = document.createElement('div'); pop.className = 'reader-reply-pop';
  pop.addEventListener('pointerdown', (e) => e.stopPropagation()); // 拦冒泡到 #reader（否则点浮层正文会在笔/橡皮模式下落笔/擦）·**不** preventDefault（保 contentEditable 光标/选区）
  pop.style.maxHeight = `${Math.max(80, el.clientHeight - 24)}px`; pop.style.overflowY = 'auto'; // 长回复在分页 hidden overflow 下可滚到动作按钮
  const body = document.createElement('div'); body.className = 'reader-reply-text'; body.textContent = o.display_text;
  pop.appendChild(body); pop.appendChild(replyActions(o, body));
  el.appendChild(pop); popoverEl = pop;
  const er = el.getBoundingClientRect(), tr = trigger.getBoundingClientRect();
  let left = tr.left - er.left + el.scrollLeft, top = tr.bottom - er.top + el.scrollTop + 6;
  requestAnimationFrame(() => {
    if (popoverEl !== pop) return;
    left = Math.max(el.scrollLeft + 8, Math.min(left, el.scrollLeft + el.clientWidth - pop.offsetWidth - 8));
    if (top + pop.offsetHeight > el.scrollTop + el.clientHeight - 8) top = (tr.top - er.top + el.scrollTop) - pop.offsetHeight - 6;
    pop.style.left = `${left}px`; pop.style.top = `${Math.max(el.scrollTop + 8, top)}px`;
  });
}
/** 收下/改写/散去（复用 whisper 同款小状态机：改 state[+改写改 display_text] → emit overlay:state → annotation-loop 落账）。 */
function replyActions(o: ScreenOverlay, body: HTMLElement): HTMLElement {
  const acts = document.createElement('div'); acts.className = 'reader-reply-acts';
  const setState = (next: OverlayState): void => { if (o.state !== 'shown' && !(o.state === 'accepted' && next === 'edited')) return; o.state = next; bus.emit('overlay:state', o); closePopover(); renderReplyMarkers(); };
  const mk = (label: string, fn: () => void): void => { const b = document.createElement('button'); b.textContent = label; b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); fn(); }); acts.appendChild(b); };
  mk('收下', () => setState('accepted'));
  mk('改写', () => { if (body.isContentEditable) { body.contentEditable = 'false'; o.display_text = body.textContent ?? ''; setState('edited'); } else { body.contentEditable = 'true'; body.focus(); } });
  mk('散去', () => setState('dismissed'));
  return acts;
}
/** 图解浮层（只看·无动作·图不是 overlay）。 */
function openFigurePopover(trigger: HTMLElement, text: string): void {
  closePopover();
  const pop = document.createElement('div'); pop.className = 'reader-reply-pop';
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  pop.style.maxHeight = `${Math.max(80, el.clientHeight - 24)}px`; pop.style.overflowY = 'auto';
  const body = document.createElement('div'); body.className = 'reader-reply-text'; body.textContent = text;
  pop.appendChild(body); el.appendChild(pop); popoverEl = pop;
  const er = el.getBoundingClientRect(), tr = trigger.getBoundingClientRect();
  let left = tr.left - er.left + el.scrollLeft, top = tr.bottom - er.top + el.scrollTop + 6;
  requestAnimationFrame(() => {
    if (popoverEl !== pop) return;
    left = Math.max(el.scrollLeft + 8, Math.min(left, el.scrollLeft + el.clientWidth - pop.offsetWidth - 8));
    if (top + pop.offsetHeight > el.scrollTop + el.clientHeight - 8) top = (tr.top - er.top + el.scrollTop) - pop.offsetHeight - 6;
    pop.style.left = `${left}px`; pop.style.top = `${Math.max(el.scrollTop + 8, top)}px`;
  });
}

// ── 圈画采集 ──
function resizeInk(): void {
  if (!inkCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = el.clientWidth;
  const h = Math.min(Math.max(pageContentH(), el.clientHeight), MAX_CANVAS_PX); // 用内容真高(pageWrap 底)而非 el.scrollHeight：画布 absolute 会把自己灌进 scrollHeight → 否则高度只增不减（棘轮）
  // 只在尺寸真变了才重建位图（赋 canvas.width 总会重分配+清空大缓冲）——流式逐块 append 时尺寸基本不变即跳过，去掉重建风暴。
  if (w !== lastCanvasW || h !== lastCanvasH || dpr !== lastDpr) {
    inkCv.width = w * dpr; inkCv.height = h * dpr;
    inkCv.style.width = w + 'px'; inkCv.style.height = h + 'px';
    lastCanvasW = w; lastCanvasH = h; lastDpr = dpr;
  }
  inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  inkCtx.clearRect(0, 0, w, h);
  for (const s of restoredStrokes) drawStroke(s);            // 旧 mark 真笔触（锚到当前块位）先画
  for (const s of inkStrokes) {                              // 本会话在途/未锚的笔；已成 restored 的 mark 跳过免双画
    const mid = s.committed ? strokeMarkIds.get(s.committed) : undefined;
    if (mid && restoredMarkIds.has(mid)) continue;
    drawStroke(s);
  }
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
function makeEvent(kind: EventType, pts: StrokePoint[], anchorRuns: string[]): AnnotationEvent {
  return {
    event_id: shortId('evt'), trace_id: shortId('trc'),
    document_id: state.documentId ?? '', page_id: state.pageId ?? '',
    event_type: kind, geometry: { bbox: bboxOf(pts) }, stroke_points: pts,
    text_note: null, created_at: new Date().toISOString(),
    device_id: DEVICE_ID, session_id: SESSION_ID, pointer_type: 'reader', version: SCHEMA_VERSION,
    anchor_runs: anchorRuns,         // 命中块的 source run ids → 随 mark 落库当位置锚（repr 经手保留）
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
  // 遥测·重排锚定：每笔命中哪个块 + 屏幕中心（看一个 mark 的多笔是否命中**不同**块 → 逐笔块锚的依据）。
  devEmit('reflow', () => ({ at: 'draw', block: ref.id, runs: ref.runIds.slice(0, 5), nr: ref.runIds.length,
    scYc: Math.round(raw.reduce((s, p) => s + p.y, 0) / raw.length), scXc: Math.round(raw.reduce((s, p) => s + p.x, 0) / raw.length),
    blkTop: Math.round(top), styp: scored.type }));
  // 当正常 page-ledger mark：发 bus 给 main 走 ingestStroke（组装 + 跨视图 + 持久 + 同享 session/idle）
  // ref.runIds = 命中块的 source run ids → 随事件落库当**位置真相锚**（重投影认它定段、不靠坐标猜，治"刚画完就乱飘"）
  bus.emit('reader:gesture', { event: makeEvent(scored.type, pts, ref.runIds), stroke });
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
  // restored（旧 mark 重画的真笔触·不在 inkStrokes 里）：命中 → 按 markId 擦整 mark（之前漏了这条，旧圈在重排里擦不掉）
  for (let i = restoredStrokes.length - 1; i >= 0; i--) {
    if (restoredStrokes[i].points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < R)) { eraseRestoredMark(restoredStrokes[i].markId); return; }
  }
}

/** 擦一条 restored 旧 mark（重排里命中其重画笔触）：移 restored 副本 + 页坐标副本（切回原版页不残留）+ 落 tombstone + 重画。 */
function eraseRestoredMark(mid: string): void {
  for (let k = restoredStrokes.length - 1; k >= 0; k--) if (restoredStrokes[k].markId === mid) restoredStrokes.splice(k, 1);
  restoredMarkIds.delete(mid);
  const pageArr = state.pageId ? state.strokesByPage.get(state.pageId) : undefined;
  if (pageArr) for (let k = pageArr.length - 1; k >= 0; k--) { if (strokeMarkIds.get(pageArr[k]) === mid) pageArr.splice(k, 1); }
  bus.emit('mark:erase', mid); // → annotation-loop：落 tombstone + 从 session 移除
  resizeInk();
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
    for (let k = restoredStrokes.length - 1; k >= 0; k--) if (restoredStrokes[k].markId === mid) restoredStrokes.splice(k, 1); // 同步移 restored 副本→擦完即消失
    restoredMarkIds.delete(mid);
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
  // 分页态：禁自由纵向滚（电纸屏靠 ‹ › 翻虚拟页）；annotate 仍 none 让笔落墨。非分页态保留原 pan-y/none。
  if (paginate) { el.style.touchAction = 'none'; return; }
  el.style.touchAction = settings.viewMode === 'reader' && readerIntent() === 'annotate' ? 'none' : 'pan-y';
}

// ── 虚拟页分页（仅 paginate=移动版）──
const VPAGE_EPS = 1; // 亚像素容差：仅挡舍入误判 / 0 高 spacer，真切口（哪怕 2px）一律消除
function vh(): number { return el.clientHeight || 1; }
/** 内容真高 = 阅读块（pageWrap）底边（内容坐标）。**不含** #reader 底 padding（96px·否则末尾留白被算成虚拟页），
 *  也**不含** absolute ink 画布（其高=内容高·会灌进 el.scrollHeight 形成"只增不减"棘轮·翻短内容时虚拟页数虚高）。空页回退 clientHeight。 */
function pageContentH(): number {
  if (!pageWrap) return el.clientHeight;
  const er = el.getBoundingClientRect();
  return Math.max(1, pageWrap.getBoundingClientRect().bottom - er.top + el.scrollTop);
}
function vCount(): number { return Math.max(1, Math.ceil(pageContentH() / vh())); }
/** 真分页排版：把会横跨屏高边界的整块，前面插一段白 spacer 推到下一屏顶——每屏只含完整的块，
 *  不横切文字、不丢字（被推的块下一屏从头完整显示）。仅 paginate；重排落地/插旁注/resize 后调（先清旧 spacer 再算）。
 *  超过一屏高的单块（极罕见）不强推、留在原处（只它自己底部会被屏边裁，无解但极少）。 */
function paginateLayout(): void {
  if (!paginate || !pageWrap) return;
  pageWrap.querySelectorAll('.reader-spacer').forEach((s) => s.remove());
  pageWrap.style.minHeight = ''; // 先清上次的补齐，免累积/污染本次测量
  el.scrollTop = 0; // 测量基准：内容坐标 = 视口坐标（免叠 scrollTop）
  const H = vh();
  const er = el.getBoundingClientRect();
  let pageBottom = H; // 当前屏底边界（内容坐标）
  for (const node of pageWrap.querySelectorAll<HTMLElement>('.reader-h,.reader-p,.reader-list,.reader-fig,.reader-note')) {
    const r = node.getBoundingClientRect(); // 每块都读新 rect（已含前面插入的 spacer 位移）
    const top = r.top - er.top, h = r.height;
    while (top >= pageBottom) pageBottom += H; // 前面 spacer 已把它推过若干屏 → 边界追上
    if (h <= H && top + VPAGE_EPS < pageBottom && top + h > pageBottom + VPAGE_EPS) { // 起点在边界前且会越界 → 垫白整块推到下一屏顶（连 2px 切口也消除）
      const spacer = document.createElement('div');
      spacer.className = 'reader-spacer';
      spacer.style.cssText = `height:${pageBottom - top}px;pointer-events:none;`;
      node.before(spacer);
      pageBottom += H;
    }
  }
  // 末页补齐到整屏倍数：用 pageWrap.min-height（**不用尾 spacer**——尾 spacer 会和末块 trailing margin 叠加、overshoot 多算一页）。
  // 否则末屏 scrollTop=vIndex*H 够不到、被浏览器 clamp 到 scrollHeight-H、起点落非边界处 → 末屏顶重现半截块；"翻回末屏"也落 clamp 后位置。
  const wrapTop = pageWrap.getBoundingClientRect().top - er.top;
  const natural = pageWrap.getBoundingClientRect().bottom - er.top; // 含末块 trailing margin
  const pages = Math.max(1, Math.ceil(natural / H));
  pageWrap.style.minHeight = `${pages * H - wrapTop}px`; // pageWrap 底 = wrapTop + minHeight = pages*H
}
/** 把 scrollTop 钉到当前虚拟页（= vIndex 屏，分页排版后块已对齐屏高边界 → 每屏整块、无切口）。 */
function applyV(): void {
  vIndex = Math.min(Math.max(0, vIndex), vCount() - 1);
  el.scrollTop = vIndex * vh();
  bus.emit('reader:vpage'); // → 页码指示刷新
}
/** 真分页排版 + 落到目标虚拟页。
 *  mode='render'（新 PDF 页/重排落地）：前进→首屏、翻回→末屏（landAtEnd）。
 *  mode='relayout'（同页再布局：插旁注/resize/切回视图）：保持当前虚拟页，不跳。 */
function settleV(mode: 'render' | 'relayout'): void {
  if (!paginate) return;
  paginateLayout();
  if (mode === 'render') { vIndex = landAtEnd ? vCount() - 1 : 0; landAtEnd = false; }
  else vIndex = Math.min(vIndex, vCount() - 1);
  applyV();
}
/** 异步内容（图片解码完 / 图解文字到达）改了高度后：重排页 + 重投影。仅 paginate·重排态。 */
function repaginate(): void {
  if (!paginate || settings.viewMode !== 'reader') return;
  settleV('relayout');
  scheduleSyncRestoredMarks();
}

/** 当前虚拟页信息（页码指示用）。非分页/单屏 → count=1。 */
export function readerVInfo(): { index: number; count: number } { return { index: vIndex, count: vCount() }; }
/** 翻一张虚拟页：成功移动返回 'moved'；已在 PDF 页边界返回 'boundary'（caller 据此翻 PDF 页）。 */
export function readerFlip(dir: number): 'moved' | 'boundary' {
  if (!paginate || settings.viewMode !== 'reader') return 'boundary';
  const next = vIndex + (dir >= 0 ? 1 : -1);
  if (next < 0 || next >= vCount()) return 'boundary';
  landAtEnd = false; // 用户手动翻 → 撤销任何待落"末屏"（防占位/流式期间被 landAtEnd 抢位）
  vIndex = next; applyV(); return 'moved';
}
/** 翻回上一 PDF 页前置：下次重排落地后停在其最后一张虚拟页。 */
export function readerArmBackward(): void { landAtEnd = true; }

export function initReader(readerEl: HTMLElement, opts?: { notePlacement?: 'margin' | 'inline'; restoreStrokes?: boolean; paginate?: boolean }): void {
  el = readerEl;
  notePlacement = opts?.notePlacement ?? 'margin';
  restoreStrokes = opts?.restoreStrokes ?? false;
  paginate = opts?.paginate ?? false;
  replyMode = restoreStrokes; // 移动版重排面：AI 回复折叠成点触浮层（桌面/原版仍走 renderNote/whisper-layer）
  if (paginate) el.style.overflowY = 'hidden'; // 分页：禁自由滚（电纸屏靠 ‹ › 翻虚拟页；programmatic scrollTop 仍可步进）
  if (replyMode) document.addEventListener('pointerdown', (e) => { const t = e.target; if (popoverEl && !(t instanceof Element && t.closest('.reader-reply-pop,.reader-reply-mark,.reader-fig'))) closePopover(); }, true); // 点别处（非浮层/标记/图）关浮层
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
  // 切到重排（含开书直接进重排态）：#reader 此刻才从 hidden 露出 → 重置 ink 画布尺寸（隐藏时 clientWidth=0 被缓存成 0×0）
  // + 重算 restored（隐藏时 getBoundingClientRect 全 0、那次投影是垃圾坐标）。rebuild 可能因 reflowKey 命中早返不重画，故独立兜一道。
  bus.on('view:changed', () => { if (settings.viewMode === 'reader' && (restoreStrokes || paginate)) { resizeInk(); settleV('relayout'); scheduleSyncRestoredMarks(); } }); // gate 在移动版：桌面靠 rebuild 自带 resizeInk·此处不渗透（严格零回归）
  bus.on('view:changed', setReaderTouchAction); // 进/出重排 → touch-action 跟随
  bus.on('tool', setReaderTouchAction);          // 切工具 → 重排面滚动/落笔切换
  bus.on('page:rendered', rebuild);
  bus.on('settings:changed', rebuild);
  setReaderTouchAction();                          // 初始就位
  // AI 回复变动：移动版重排=只刷新点触标记（marker 是绝对定位·不改文档流→**不再** scheduleSyncRestoredMarks/重分页·这就是去掉的"内联 note 推内容"那套）；桌面/原版仍走 renderNote。
  const refreshReplyMarkers = (): void => { if (replyMode && settings.viewMode === 'reader') void refreshReplyMeta().then((ok) => { if (ok) renderReplyMarkers(); }); };
  bus.on('overlay:add', (o) => { const ov = o as ScreenOverlay; if (settings.viewMode !== 'reader' || ov.page_id !== state.pageId) return; if (replyMode) refreshReplyMarkers(); else { renderNote(ov); scheduleSyncRestoredMarks(); } });
  bus.on('overlay:remove', (id) => { if (replyMode) { if (settings.viewMode === 'reader') renderReplyMarkers(); } else { el.querySelector(`.reader-note[data-for="${id as string}"]`)?.remove(); scheduleSyncRestoredMarks(); } });
  bus.on('overlay:state', (o) => { const ov = o as ScreenOverlay; if (settings.viewMode !== 'reader' || ov.page_id !== state.pageId) return; if (replyMode) refreshReplyMarkers(); else { renderNote(ov); scheduleSyncRestoredMarks(); } });
  bus.on('aiturn:appended', () => refreshReplyMarkers()); // 回复落账(overlay:add 早于它)→重 join 刷新·修首帧粗分错标记一直留着

  // 重排里落的笔收口成 mark 后 → 重投影（把那条仍是内容px的 live inkStroke 升级成锚到块的 restored·不然旁注插入致内容移位它不跟随）。scheduleSyncRestoredMarks 内部已 gate 移动版+重排态。
  bus.on('mark:resolved', () => scheduleSyncRestoredMarks());
  window.addEventListener('resize', () => { if (settings.viewMode === 'reader') { resizeInk(); layoutNotes(); settleV('relayout'); scheduleSyncRestoredMarks(); } }); // 补 resync：resize 改了块位、restored 需按新位重投影（否则与正文错位）
}
