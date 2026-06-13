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

const vlm: OcrProvider = async () => {
  // TODO：裁剪 bbox 区域截图 → 多模态模型 → 组装同 shape 的 OCRResult。
  // bbox 用标注几何派生的裁剪框（粗但诚实），runtime 必须如实写 'cloud_fallback'。
  throw new Error('VLM provider 未接入：周一提案通过后由 API client（Dev A 车道）承载');
};

const local: OcrProvider = async () => {
  throw new Error('本地 OCR 由 B 组接入（B3）');
};

export const ocrProviders: Record<string, OcrProvider> = { textlayer, mock, vlm, local };

export const OCR_PROVIDER_LABELS: Record<string, string> = {
  textlayer: 'PDF text layer（真实文本）',
  mock: 'deterministic mock',
  vlm: 'VLM cloud_fallback（stub）',
  local: '本地 OCR（B组接入）',
};
