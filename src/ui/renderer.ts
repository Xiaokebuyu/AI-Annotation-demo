import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { SCHEMA_VERSION } from '../core/contracts';
import { sha256Hex } from '../core/ids';
import { setPageSize } from '../core/transform';
import { trace } from '../core/trace';
import { bus, state } from '../app/state';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

let pdf: PDFDocumentProxy | null = null;
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
  return pdf !== null;
}

export async function loadFile(file: File): Promise<void> {
  const buf = await file.arrayBuffer();
  state.fileHash = await sha256Hex(buf);
  state.documentId = 'doc_' + state.fileHash.slice(0, 12); // hash 派生，重复导入 id 稳定
  state.fileName = file.name;
  pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  state.pageCount = pdf.numPages;
  state.pageIndex = 0;
  state.strokesByPage.clear();
  trace('PDFDocument', {
    document_id: state.documentId,
    file_hash: state.fileHash,
    filename: file.name,
    page_count: state.pageCount,
    uploaded_at: new Date().toISOString(),
    source_type: 'upload',
    local_original_path: '(browser memory ref)',
    version: SCHEMA_VERSION,
  });
  bus.emit('document:loaded');
  await renderPage();
}

export async function renderPage(): Promise<void> {
  if (!pdf || !state.documentId) return;
  const page = await pdf.getPage(state.pageIndex + 1);
  const dpr = window.devicePixelRatio || 1;
  const vp1 = page.getViewport({ scale: 1 });
  const fitWidth = Math.min(860, Math.max(480, stageWrap.clientWidth - 56));
  const baseScale = fitWidth / vp1.width;
  const vp = page.getViewport({ scale: baseScale * state.zoom });
  setPageSize(vp.width, vp.height);

  for (const cv of [pageCv, inkCv]) {
    cv.width = vp.width * dpr;
    cv.height = vp.height * dpr;
    cv.style.width = vp.width + 'px';
    cv.style.height = vp.height + 'px';
  }
  stage.style.width = vp.width + 'px';
  stage.style.height = vp.height + 'px';

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

  // text layer：数字版 PDF 的真实文本 + 精确位置（归一化，zoom/rotation 无关）
  try {
    const tc = await page.getTextContent();
    state.textBlocks = tc.items
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
        return { id: 'tl_' + i, text: it.str, bbox: [x0, y0, x1 - x0, y1 - y0] as [number, number, number, number], confidence: 1, language: 'auto' };
      });
  } catch {
    state.textBlocks = [];
  }

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
  bus.emit('page:rendered');
}

export function gotoPage(delta: number): void {
  if (!pdf) return;
  const next = state.pageIndex + delta;
  if (next < 0 || next >= state.pageCount) return;
  state.pageIndex = next;
  void renderPage();
}

export function setZoom(z: number): void {
  state.zoom = Math.min(3, Math.max(0.5, z));
  if (pdf) void renderPage();
}
