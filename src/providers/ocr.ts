import type { AnnotationEvent, NormBBox, OCRResult } from '../core/contracts';
import { shortId } from '../core/ids';
import { state } from '../app/state';

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

/** 局部截图 OCR：裁标注区域 → /api/ocr-vlm（Kimi 视觉转写）→ 同 shape 的 OCRResult。
 *  扫描版 / 手写批注 / 图表公式走这条（textlayer 抓瞎时）。runtime 如实写 cloud_fallback。 */
const vlm: OcrProvider = async (evt) => {
  const t0 = performance.now();
  const image = grabRegion(evt.geometry.bbox);
  const base = {
    ocr_result_id: shortId('ocr'),
    trace_id: evt.trace_id,
    event_id: evt.event_id,
    page_id: evt.page_id,
    scope: 'region' as const,
    nearby_text: null,
    model_name: 'kimi-vision',
    model_version: 'nodesk-gateway',
    runtime: 'cloud_fallback' as const,
    latency_ms: 0,
  };
  if (!image) {
    return { ...base, text_blocks: [], note: '无法截取标注区域（canvas 不可用）', latency_ms: Math.round(performance.now() - t0) };
  }
  let text = '';
  try {
    const resp = await fetch('/api/ocr-vlm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image }),
    });
    if (resp.ok) text = String((await resp.json())?.text || '').trim();
  } catch { /* 失败降级为空，不连累闭环 */ }
  const latency_ms = Math.round(performance.now() - t0);
  if (!text) return { ...base, text_blocks: [], note: 'VLM 未读出文字', latency_ms };
  return {
    ...base,
    text_blocks: [{ id: shortId('ocrb'), text, bbox: evt.geometry.bbox, confidence: 0.6, language: 'auto' }],
    latency_ms,
  };
};

/** 完整 OCR：textlayer 优先（数字版精确、0 成本），命不中再用 VLM 局部截图兜底。 */
const full: OcrProvider = async (evt) => {
  const t = await textlayer(evt);
  if (t.text_blocks.length) return t;
  return vlm(evt);
};

const local: OcrProvider = async () => {
  throw new Error('本地 OCR 由 B 组接入（B3）');
};

export const ocrProviders: Record<string, OcrProvider> = { textlayer, full, vlm, mock, local };

export const OCR_PROVIDER_LABELS: Record<string, string> = {
  textlayer: 'PDF text layer（真实文本·数字版）',
  full: 'textlayer + VLM 兜底（full）',
  vlm: 'VLM 局部截图（only vlm·cloud_fallback）',
  mock: 'deterministic mock',
  local: '本地 OCR（B组接入）',
};
