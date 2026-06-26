import * as pdfjsLib from 'pdfjs-dist';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { NormBBox, OcrTextBlock } from '../core/contracts';
import { SCHEMA_VERSION } from '../core/contracts';
import { sha256Hex } from '../core/ids';
import { setPageSize, GUTTER_W } from '../core/transform';
import { blankSurfaceIndex } from '../core/surface-index';
import { trace } from '../core/trace';
import { reflowLocal } from './reflow';
import { reflowProviders } from './reflow-provider';
import { wrapSurfaceIndex } from '../evidence/target';
import { ensureScannedPageLayer } from '../evidence/page-ocr';
import { bus, getActiveContext, settings, state } from '../app/state';
import { getReflow, openDoc, putReflow, storePdfBlob, loadPdfBlob, lastReadPage, activeDoc, setActiveDoc } from '../local/store';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// public/ 资产的运行期 URL：基于 Vite BASE_URL 相对解析。
// dev（页面在根）→ /cmaps/；安卓 WebView（页面在 /assets/index.html）→ /assets/cmaps/。绝对 '/cmaps/' 在后者会错。
const publicAssetUrl = (path: string): string =>
  new URL(`${import.meta.env.BASE_URL || './'}${path}`, window.location.href).toString();

// pdf（当前 PDFDocumentProxy）已迁入 SurfaceContext（方案 B Stage 1）：读写走 getActiveContext().pdf，
// 切回主阅读/已开会议资料免重新 fetch/decode。renderTask 是单 DOM 渲染锁，留模块级（单激活不双渲）。
let renderTask: { cancel(): void; promise: Promise<void> } | null = null;

let pageCv: HTMLCanvasElement;
let inkCv: HTMLCanvasElement;
let stage: HTMLElement;
let stageWrap: HTMLElement;

export function initRenderer(els: {
  pageLayer: HTMLCanvasElement; inkLayer: HTMLCanvasElement; stage: HTMLElement; stageWrap: HTMLElement;
}): void {
  pageCv = els.pageLayer;
  inkCv = els.inkLayer;
  stage = els.stage;
  stageWrap = els.stageWrap;
}

export function hasDocument(): boolean {
  return getActiveContext().pdf !== null;
}

// ── 原页图像区域抽取（扫 PDF 操作流找 paintImage* 算子，用累计变换矩阵求图在页面的 bbox）──
type Mat = [number, number, number, number, number, number];
const matMul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const matApply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function overlapFrac(a: NormBBox, b: NormBBox): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return (ix * iy) / (Math.min(a[2] * a[3], b[2] * b[3]) || 1);
}

async function extractImageRegions(page: PDFPageProxy, vp: PageViewport): Promise<NormBBox[]> {
  try {
    const ops = await page.getOperatorList();
    const O = pdfjsLib.OPS;
    const IMG = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject].filter((v) => v !== undefined));
    let ctm: Mat = [1, 0, 0, 1, 0, 0];
    const stack: Mat[] = [];
    const out: NormBBox[] = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === O.save) stack.push(ctm);
      else if (fn === O.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === O.transform) ctm = matMul(ctm, ops.argsArray[i] as Mat);
      else if (IMG.has(fn)) {
        const corners = ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map(([x, y]) => {
          const [ux, uy] = matApply(ctm, x, y);
          return vp.convertToViewportPoint(ux, uy) as [number, number];
        });
        const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
        const x0 = Math.min(...xs) / vp.width, x1 = Math.max(...xs) / vp.width;
        const y0 = Math.min(...ys) / vp.height, y1 = Math.max(...ys) / vp.height;
        const bb: NormBBox = [x0, y0, x1 - x0, y1 - y0];
        if (bb[2] > 0.06 && bb[3] > 0.04 && bb[2] * bb[3] > 0.012) out.push(bb); // 滤掉图标/分隔线/底纹点
      }
    }
    const kept: NormBBox[] = []; // 去重：高度重叠当作同一张图（mask + 本体常各出现一次）
    for (const b of out) if (!kept.some((k) => overlapFrac(k, b) > 0.6)) kept.push(b);
    return kept;
  } catch {
    return [];
  }
}

/**
 * 把一段 PDF 字节装进阅读态（导入与重开共用）。
 *  · persist 非空 → 导入路径：把 PDF 字节落库（重开免重导）。reopen 路径传 null（库里已有）。
 *  · 阅读位置：openDoc 后从 last_read_page 恢复（新书=0）。
 * 注意 getDocument({data}) 可能 detach buf，故 Blob 拷贝在调用前由 loadFile 先建好。
 */
async function loadIntoState(buf: ArrayBuffer, filename: string, persist: Blob | null, docId?: string): Promise<void> {
  state.fileHash = await sha256Hex(buf);
  state.documentId = docId ?? ('doc_' + state.fileHash.slice(0, 12)); // 默认 hash 派生；docId 显式覆盖（会议资料按稳定 id 归档，转换非确定性也不漂）
  state.fileName = filename;
  state.surfaceType = 'article';
  // cMapUrl/standardFontDataUrl：救老中文 PDF —— 非嵌入 CID 字体 + 预定义 CJK CMap（如 GBK-EUC-H）
  // 需要 CMap 表才能把字符码映射成字形，否则中文画布渲染与 getTextContent 都出空白/乱码。
  // 资产在 public/（cp 自 pdfjs-dist），dev 与 build 均自动服务于根路径。
  const pdf = await pdfjsLib.getDocument({
    data: buf,
    cMapUrl: publicAssetUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: publicAssetUrl('standard_fonts/'),
  }).promise;
  getActiveContext().pdf = pdf; // 迁入激活实例（切回免重新 fetch/decode）
  state.pageCount = pdf.numPages;
  state.strokesByPage.clear();
  // 文档级元信息：Info 字典(Title/Author/Producer/CreationDate…) + 大纲目录。真书常有，喂重排/AI 排版。
  try { const m = await pdf.getMetadata(); state.docMeta = (m && m.info) ? m.info as Record<string, unknown> : null; } catch { state.docMeta = null; }
  try { state.outline = await pdf.getOutline(); } catch { state.outline = null; }
  // 载入本地已存的语义蒸馏（重排/记忆/图解缓存）；没有则新建。重开同一文档即恢复。
  await openDoc({ document_id: state.documentId, file_hash: state.fileHash, filename, page_count: state.pageCount });
  getActiveContext().storeDoc = activeDoc(); // 把载入的文档挂到激活实例，供切回时 store.current 重指向（P0-4）
  state.pageIndex = Math.min(Math.max(lastReadPage(), 0), Math.max(0, state.pageCount - 1)); // 重开跳回阅读位置
  if (persist) await storePdfBlob(state.documentId, persist); // 导入：PDF 字节落库（重开免重导）
  trace('PDFDocument', {
    document_id: state.documentId,
    file_hash: state.fileHash,
    filename,
    page_count: state.pageCount,
    uploaded_at: new Date().toISOString(),
    source_type: persist ? 'upload' : 'reopen',
    local_original_path: '(browser memory ref)',
    version: SCHEMA_VERSION,
  });
  bus.emit('document:loaded');
  await renderPage();
  // 后台预处理（默认关，dev 面板开关）：预排版 + 内容解读，不阻塞首屏
  const pp = settings.preprocess;
  const reflowCap = pp.reflowEnabled ? pp.reflowPages : 0;
  if (reflowCap > 0) void preprocess(reflowCap);
}

/** 导入新 PDF（文件选择/拖拽）。 */
export async function loadFile(file: File): Promise<void> {
  const buf = await file.arrayBuffer();
  const blob = new Blob([buf], { type: 'application/pdf' }); // 先拷贝：getDocument 可能 detach buf
  await loadIntoState(buf, file.name, blob);
}

/** 从持久库重开一本已存的书（免重新选文件）。无字节返回 false。 */
export async function reopenBook(documentId: string, filename: string): Promise<boolean> {
  const blob = await loadPdfBlob(documentId);
  if (!blob) return false;
  const buf = await blob.arrayBuffer();
  await loadIntoState(buf, filename, null, documentId); // 按存档 id 重开（不靠 hash 复算，转换文档也稳）
  return true;
}

/**
 * 打开一个「PDF 字节 URL」进阅读器（会议资料经 convert-service 转成的 PDF 走这条）。
 * documentId 显式稳定（按资料派生）→ 这份 PDF 落库 + 标注归它、重开免重转。已存库则直接重开。
 */
export async function openPdfFromUrl(documentId: string, filename: string, pdfUrl: string): Promise<void> {
  if (await reopenBook(documentId, filename)) return; // 之前转过 → 库里有，直接重开（免重转）
  const r = await fetch(pdfUrl);
  if (!r.ok) throw new Error('open pdf ' + r.status);
  const buf = await r.arrayBuffer();
  const blob = new Blob([buf.slice(0)], { type: 'application/pdf' }); // 拷贝：getDocument 可能 detach
  await loadIntoState(buf, filename, blob, documentId);
}

/**
 * 空白手写 surface —— 会议「进入会议」的那张白纸。
 * 同 chat-surface 思路：app 直接渲染表面 + 原生 emit 一份 SurfaceIndex，墨迹/标注/账本/重绘整条链路全复用 PDF 路径那套。
 * 表面是一整张空白（一个覆盖全页的 blank_region，在哪写都命中 self_content）。documentId 稳定 →
 * marks 账本归它、document:loaded 触发 restoreFromLedger 自动重绘已存的笔，重开免重导、跨 reload 不丢。
 *
 * ⚠️架构决议(2026-06-24)：会议的阅读应是「单独阅读实例」。当前阅读器是深度单例（全局 state + 绑死
 * #stage/#ink DOM + 单例 ink），故现采用 **方案 A**：仍用这一套单引擎，由调用方在进/出会议时存档·恢复
 * context（主阅读的书/态）来达到「独立实例」的体验。**方案 B**=把阅读器重构成可实例化的「可标注 surface
 * 组件」（底座层，阅读+每会议各持独立实例）记为后面做，别在阅读上板前动引擎结构。
 */
export function renderBlankSurface(documentId: string, title = '空白页'): void {
  getActiveContext().pdf = null; // 脱离上一份 PDF（防 zoom/翻页误渲旧页）
  getActiveContext().storeDoc = null; setActiveDoc(null); // 白板无持久化文档：store.current 置空，页缓存/阅读位置写操作变 no-op（P0-4）
  state.fileHash = documentId;
  state.documentId = documentId;
  state.fileName = title;
  state.surfaceType = 'whiteboard';
  state.pageCount = 1;
  state.pageIndex = 0;
  state.strokesByPage.clear();
  state.docMeta = null;
  state.outline = null;

  const dpr = window.devicePixelRatio || 1;
  const { fit: W, gutter: gut } = pageMetrics();
  const H = Math.round(W * 1.32); // 一张竖向「纸」
  for (const cv of [pageCv, inkCv]) {
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
  }
  stage.style.width = (W + gut) + 'px';
  stage.style.height = H + 'px';
  stage.style.setProperty('--page-w', W + 'px');
  setPageSize(W, H);

  const ctx = pageCv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(0,0,0,0.05)'; ctx.lineWidth = 1; // 极淡稿纸线（纯装饰，不进 SurfaceIndex）
  for (let y = 36; y < H; y += 30) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }

  const pageId = `${documentId}_0`;
  state.pageId = pageId;
  state.pageRecord = { page_id: pageId, document_id: documentId, page_index: 0, width: W, height: H, unit: 'pt', rotation: 0, render_dpi: 96, version: SCHEMA_VERSION };
  state.overlays = [];
  state.textBlocks = [];
  state.imageRegions = [];
  state.surfaceIndex = blankSurfaceIndex(pageId);

  bus.emit('document:loaded'); // → restoreFromLedger() 自动重绘本白板已存的笔
  bus.emit('page:rendered');
  bus.emit('surface:indexed', state.surfaceIndex);
}

/** 抽取一页的文本块（归一化 bbox，zoom/rotation 无关）。渲染与预处理共用。 */
async function extractTextBlocks(page: PDFPageProxy, vp: PageViewport): Promise<OcrTextBlock[]> {
  try {
    const tc = await page.getTextContent();
    return tc.items
      .filter((it): it is TextItem => 'str' in it && typeof it.str === 'string' && it.str.trim().length > 0)
      .map((it, i) => {
        const [, b, , d, e, f] = it.transform;
        const fontH = Math.hypot(b, d) || Math.abs(d) || 10;
        const [vx1, vy1] = vp.convertToViewportPoint(e, f) as [number, number];
        const [vx2, vy2] = vp.convertToViewportPoint(e + it.width, f + fontH) as [number, number];
        const x0 = Math.min(vx1, vx2) / vp.width;
        const x1 = Math.max(vx1, vx2) / vp.width;
        const y0 = Math.min(vy1, vy2) / vp.height;
        const y1 = Math.max(vy1, vy2) / vp.height;
        return { id: 'tl_' + i, text: it.str, bbox: [x0, y0, x1 - x0, y1 - y0] as NormBBox, confidence: 1, language: 'auto' };
      });
  } catch {
    return [];
  }
}

/** 取任意页的文本块（只读文本层、不渲染画布）——供重排预热下一页用，墨水屏友好。 */
export async function extractPageBlocks(pageIndex: number): Promise<OcrTextBlock[]> {
  const pdf = getActiveContext().pdf;
  if (!pdf || pageIndex < 0 || pageIndex >= pdf.numPages) return [];
  try {
    const page = await pdf.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 1 });
    return await extractTextBlocks(page, vp);
  } catch {
    return [];
  }
}

let preprocessing = false;
/**
 * 预处理流水线（后台、顺序、可中断）：导入后封顶若干页——
 *  - 前 reflowCap 页：预排版（local 引擎）写入缓存 → 进重排面即时。
 * 只取文本层、不渲染画布，省性能（墨水屏友好）；已缓存的页跳过。
 */
export async function preprocess(reflowCap: number): Promise<void> {
  const pdf = getActiveContext().pdf;
  if (!pdf || !state.documentId || preprocessing) return;
  preprocessing = true;
  const docId = state.documentId;
  const cap = Math.min(pdf.numPages, reflowCap);
  try {
    for (let i = 0; i < cap; i++) {
      if (state.documentId !== docId) break; // 文档/实例换了 → 停（pdf 快照非空，原 !pdf 检查由 docId 守卫覆盖）
      try {
        const page = await pdf.getPage(i + 1);
        const vp = page.getViewport({ scale: 1 });
        const blocks = await extractTextBlocks(page, vp);
        if (blocks.length) {
          if (i < reflowCap && !getReflow(i, 'local')) {
            const rb = reflowLocal(blocks);
            if (rb.length) putReflow(i, 'local', rb);
          }
        }
      } catch { /* 跳过该页 */ }
      bus.emit('preprocess:progress', i + 1, cap);
    }
  } finally {
    preprocessing = false;
    bus.emit('preprocess:done');
  }
}

/**
 * 页面渲染预算。横屏=页宽 + 右侧 AI 留白(gutter=300)；窄屏(电纸屏竖向 / 手机，≤640px)=
 * 铺满可用宽、无 gutter、下限降到 300，让正文页填满竖向面板（消除 480 桌面下限造成的横向溢出）。
 */
function pageMetrics(): { fit: number; gutter: number } {
  const narrow = window.matchMedia('(max-width: 640px)').matches;
  if (narrow) {
    const avail = stageWrap.clientWidth - 24;            // 竖屏 stage-wrap padding 较小
    return { fit: Math.min(900, Math.max(300, avail)), gutter: 0 };
  }
  const avail = stageWrap.clientWidth - 56 - GUTTER_W;
  return { fit: Math.min(860, Math.max(480, avail)), gutter: GUTTER_W };
}

export async function renderPage(): Promise<void> {
  const sctx = getActiveContext();
  const pdf = sctx.pdf;
  if (!pdf || !state.documentId) return;
  const gen = ++sctx.renderGeneration; // 本次渲染代号（P0-5 竞态守卫）
  // await 后校验：未被同实例的新渲染抢占、且仍是激活实例——否则丢弃迟到结果不写 state
  const alive = () => sctx.renderGeneration === gen && getActiveContext() === sctx;
  const page = await pdf.getPage(state.pageIndex + 1);
  if (!alive()) return;
  const dpr = window.devicePixelRatio || 1;
  const vp1 = page.getViewport({ scale: 1 });
  // 预算里扣掉右侧留白，保证「页面 + 留白」不溢出阅读区（窄屏=铺满、无 gutter）
  const { fit: fitWidth, gutter: gut } = pageMetrics();
  const baseScale = fitWidth / vp1.width;
  const vp = page.getViewport({ scale: baseScale * state.zoom });
  setPageSize(vp.width, vp.height);

  for (const cv of [pageCv, inkCv]) {
    cv.width = vp.width * dpr;
    cv.height = vp.height * dpr;
    cv.style.width = vp.width + 'px';
    cv.style.height = vp.height + 'px';
  }
  // stage 容纳「页面 + 右侧留白」；页面靠左，留白供 AI 输出（窄屏 gut=0 即铺满）
  stage.style.width = vp.width + gut + 'px';
  stage.style.height = vp.height + 'px';
  stage.style.setProperty('--page-w', vp.width + 'px');

  // 同一 canvas 不允许并发 render（快速连点缩放/翻页）：先取消未完成任务
  if (renderTask) { try { renderTask.cancel(); } catch { /* noop */ } }
  const ctx = pageCv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // intent:'print' 走 setTimeout 而非 requestAnimationFrame —— 页面处于后台
  // （沙箱预览/设备 WebView 退后台）时 rAF 被冻结会导致渲染 promise 永不结算
  renderTask = page.render({ canvasContext: ctx, viewport: vp, intent: 'print' });
  try {
    await renderTask.promise;
  } catch (e) {
    if ((e as { name?: string })?.name === 'RenderingCancelledException') return; // 被更新的渲染取代
    throw e;
  } finally {
    renderTask = null;
  }
  if (!alive()) return; // 画布渲染期间切走/被抢占：不再写 state（防把本页数据写进切换后的实例）

  // text layer：数字版 PDF 的真实文本 + 精确位置（归一化，zoom/rotation 无关）
  const textBlocks = await extractTextBlocks(page, vp);
  if (!alive()) return;
  state.textBlocks = textBlocks;

  // 原页图像区域（重排时保留，不丢图）
  const imageRegions = await extractImageRegions(page, vp);
  if (!alive()) return;
  state.imageRegions = imageRegions;

  state.pageId = `pg_${state.documentId.slice(4, 12)}_${state.pageIndex}`;
  state.pageRecord = {
    page_id: state.pageId,
    document_id: state.documentId,
    page_index: state.pageIndex,
    width: vp1.width,
    height: vp1.height,
    unit: 'pt',
    rotation: page.rotate,
    render_dpi: Math.round(96 * baseScale * state.zoom),
    version: SCHEMA_VERSION,
  };
  trace('PDFPage', state.pageRecord as unknown as Record<string, unknown>);

  // 徐智强 step①：把本页结构（文本层 + 图像区）包成显式 SurfaceIndex（复用 reflowLocal 分 title/text_block）。
  state.surfaceIndex = wrapSurfaceIndex(state.pageId!, state.pageIndex, state.textBlocks, state.imageRegions);
  bus.emit('surface:indexed', state.surfaceIndex);

  // 图片版/扫描页（无文字层、只有图）→ 后台建 OCR 文本层：Phase 2 位置文本层（带 bbox·主路），
  // 失败退 Phase 1 纯文本上下文。让 AI 在图片版 PDF 上不再"看不见字"。
  void ensureScannedPageLayer(state.pageId);

  // 急算开关（默认关·留给端侧）：渲染即后台跑当前引擎重排并缓存，让 AI 上下文用真实阅读序（"重排前置"）。
  if (settings.reflowEager) {
    const ekey = settings.reflowProvider === 'ai' ? `ai@${settings.reflowModel}` : settings.reflowProvider;
    const prov = reflowProviders[settings.reflowProvider];
    if (prov && state.textBlocks.length > 1 && !getReflow(state.pageIndex, ekey)) {
      const pi = state.pageIndex, blocks = state.textBlocks;
      void prov(blocks).then((r) => { if (r.length && !getReflow(pi, ekey)) putReflow(pi, ekey, r); }).catch(() => { /* 急算失败不影响阅读 */ });
    }
  }

  bus.emit('page:rendered');
}

export function gotoPage(delta: number): void {
  if (!getActiveContext().pdf) return;
  const next = state.pageIndex + delta;
  if (next < 0 || next >= state.pageCount) return;
  state.pageIndex = next;
  void renderPage();
}

export function setZoom(z: number): void {
  state.zoom = Math.min(3, Math.max(0.5, z));
  if (getActiveContext().pdf) void renderPage();
}
