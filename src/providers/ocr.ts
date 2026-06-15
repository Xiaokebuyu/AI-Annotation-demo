import type { AnnotationEvent, NormBBox, OCRResult } from '../core/contracts';
import { shortId } from '../core/ids';
import { settings, state } from '../app/state';

export type OcrProvider = (evt: AnnotationEvent) => Promise<OCRResult>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const intersects = (r: NormBBox, b: NormBBox): boolean =>
  b[0] < r[0] + r[2] && b[0] + b[2] > r[0] && b[1] < r[1] + r[3] && b[1] + b[3] > r[1];

/** 真实数据路径：标注 bbox 与 PDF.js text layer 几何相交（数字版 PDF 免 OCR） */
const textlayer: OcrProvider = async (evt) => {
  const t0 = performance.now();
  const [x, y, w, h] = evt.geometry.bbox;
  const pad = 0.012;
  const core: NormBBox = [x - pad, y - pad, w + 2 * pad, h + 2 * pad];
  const near: NormBBox = [x - 0.06, y - 0.04, w + 0.12, h + 0.08];
  const coreBlocks = state.textBlocks.filter((tb) => intersects(core, tb.bbox));
  const nearbyText = state.textBlocks.filter((tb) => intersects(near, tb.bbox)).map((tb) => tb.text).join(' ');
  const base = {
    ocr_result_id: shortId('ocr'),
    trace_id: evt.trace_id,
    event_id: evt.event_id,
    page_id: evt.page_id,
    scope: 'region' as const,
    nearby_text: nearbyText || null,
    model_name: 'pdfjs-textlayer',
    model_version: '4.x',
    runtime: 'pdf_text_layer' as const,
    latency_ms: Math.round(performance.now() - t0),
  };
  if (!coreBlocks.length) {
    return { ...base, text_blocks: [], note: 'text layer 无命中（扫描版或空白区域），需真实 OCR' };
  }
  return {
    ...base,
    text_blocks: coreBlocks.map((tb) => ({ ...tb, confidence: 1.0, language: 'auto' })),
  };
};

const mock: OcrProvider = async (evt) => {
  await sleep(120);
  const [x, y, w, h] = evt.geometry.bbox;
  const pad = 0.04;
  return {
    ocr_result_id: shortId('ocr'),
    trace_id: evt.trace_id,
    event_id: evt.event_id,
    page_id: evt.page_id,
    scope: 'region',
    text_blocks: [{
      id: 'ocrb_1',
      text: `（mock）第 ${state.pageIndex + 1} 页标注区域的文本内容`,
      bbox: [Math.max(0, x - pad), Math.max(0, y - pad), w + 2 * pad, h + 2 * pad],
      confidence: 0.91,
      language: 'zh',
    }],
    nearby_text: null,
    model_name: 'deterministic-mock',
    model_version: '0',
    runtime: 'mock',
    latency_ms: 120,
  };
};

/**
 * 把标注 bbox（归一化 [0,1]）那一块从 #page-layer canvas 裁出来 → PNG dataURL。
 * 裁剪框用标注几何 + pad（粗但诚实，见 vlm 的 runtime='cloud_fallback'）。
 * 缩到长边 ≤max 控 token。失败（canvas 不可用/跨域污染）返回 undefined。
 */
export function grabRegion(bbox: NormBBox, pad = 0.02, max = 768): string | undefined {
  const cv = document.getElementById('page-layer') as HTMLCanvasElement | null;
  if (!cv || !cv.width || !cv.height) return undefined;
  const [bx, by, bw, bh] = bbox;
  const x0 = Math.max(0, bx - pad), y0 = Math.max(0, by - pad);
  const x1 = Math.min(1, bx + bw + pad), y1 = Math.min(1, by + bh + pad);
  const sx = x0 * cv.width, sy = y0 * cv.height;
  const sw = Math.max(1, (x1 - x0) * cv.width), sh = Math.max(1, (y1 - y0) * cv.height);
  try {
    const scale = Math.min(1, max / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d')!.drawImage(cv, sx, sy, sw, sh, 0, 0, w, h);
    return tmp.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

/** 把整页 #page-layer canvas 缩到长边 ≤max 转 PNG（整页图 OCR / 推理底图用）。失败返回 undefined。 */
export function grabPage(max = 1280): string | undefined {
  const cv = document.getElementById('page-layer') as HTMLCanvasElement | null;
  if (!cv || !cv.width || !cv.height) return undefined;
  try {
    const scale = Math.min(1, max / Math.max(cv.width, cv.height));
    const w = Math.max(1, Math.round(cv.width * scale)), h = Math.max(1, Math.round(cv.height * scale));
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d')!.drawImage(cv, 0, 0, w, h);
    return tmp.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

/** 把一张截图交 /api/ocr-vlm 让 Kimi 视觉转写成文字。scope=page 时带 bbox 告诉模型框在页面哪。 */
async function transcribe(image: string, scope: 'region' | 'page', bbox?: NormBBox): Promise<string> {
  try {
    const resp = await fetch('/api/ocr-vlm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scope === 'page' ? { image, scope, bbox } : { image }),
    });
    if (resp.ok) return String((await resp.json())?.text || '').trim();
  } catch { /* 失败降级为空，不连累闭环 */ }
  return '';
}

/** 组装 VLM OCR 的 OCRResult（runtime 如实写 cloud_fallback；scope 区分 region / full_page）。 */
function vlmResult(evt: AnnotationEvent, text: string, scope: 'region' | 'page', latency_ms: number, hadImage: boolean): OCRResult {
  const base = {
    ocr_result_id: shortId('ocr'),
    trace_id: evt.trace_id,
    event_id: evt.event_id,
    page_id: evt.page_id,
    scope: (scope === 'page' ? 'full_page' : 'region') as OCRResult['scope'],
    nearby_text: null,
    model_name: 'kimi-vision',
    model_version: 'nodesk-gateway',
    runtime: 'cloud_fallback' as const,
    latency_ms,
  };
  if (!hadImage) return { ...base, text_blocks: [], note: '无法截图（canvas 不可用）' };
  if (!text) return { ...base, text_blocks: [], note: 'VLM 未读出文字' };
  return { ...base, text_blocks: [{ id: shortId('ocrb'), text, bbox: evt.geometry.bbox, confidence: 0.6, language: 'auto' }] };
}

/** 局部图：裁标注那一小块 → Kimi 视觉转写。便宜、聚焦。 */
const vlmRegion: OcrProvider = async (evt) => {
  const t0 = performance.now();
  const image = grabRegion(evt.geometry.bbox);
  const text = image ? await transcribe(image, 'region') : '';
  return vlmResult(evt, text, 'region', Math.round(performance.now() - t0), !!image);
};

/** 整页图：把整页给 Kimi，并告诉它标注框在页面哪 → 带版面上下文地读那块。 */
const vlmPage: OcrProvider = async (evt) => {
  const t0 = performance.now();
  const image = grabPage();
  const text = image ? await transcribe(image, 'page', evt.geometry.bbox) : '';
  return vlmResult(evt, text, 'page', Math.round(performance.now() - t0), !!image);
};

/** OCR 全关时的占位（textlayer 与图像 OCR 都关）。 */
function emptyOcr(evt: AnnotationEvent): OCRResult {
  return {
    ocr_result_id: shortId('ocr'), trace_id: evt.trace_id, event_id: evt.event_id, page_id: evt.page_id,
    scope: 'region', text_blocks: [], nearby_text: null, note: 'OCR 已关闭',
    model_name: 'none', model_version: '0', runtime: 'mock', latency_ms: 0,
  };
}

/**
 * 由设置驱动的 OCR 入口：textlayer（数字版文本层，独立开关）优先取真字；
 * 命不中（扫描/手写/图）再看「图像 OCR」设置走局部图 / 整页图 VLM；都关则空。
 * mock / 本地 OCR(B组) 仍保留为接缝（providers 上方定义），当前 UI 不走。
 */
export async function runOcr(evt: AnnotationEvent): Promise<OCRResult> {
  const { textlayer: useTextlayer, image } = settings.ocr;
  if (useTextlayer) {
    const t = await textlayer(evt);
    if (t.text_blocks.length) return t;   // 数字版命中 → 真字（0 成本）
    if (image === 'off') return t;        // 没开图像 OCR → 返回 textlayer 的空命中（带诚实 note）
  }
  if (image === 'region') return vlmRegion(evt);
  if (image === 'page') return vlmPage(evt);
  return emptyOcr(evt);
}
