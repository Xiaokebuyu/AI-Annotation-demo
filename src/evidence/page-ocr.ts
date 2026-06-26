import { state, settings, bus } from '../app/state';
import type { NormBBox, OcrTextBlock } from '../core/contracts';
import { grabRegion } from './ocr';
import { postJson } from '../core/api';
import { ondeviceOcrRegion } from './ondevice';
import { wrapSurfaceIndex } from './target';
import { devEmit } from '../core/dev-telemetry';

/**
 * 图片版/扫描版 PDF 的 OCR 文本层。扫描页没有 PDF.js 文字层 → AI 在这种页"看不见字"。用 OCR 补。两层：
 *
 *  · Phase 2（位置文本层·主路）：`/api/ocr-layout`（dev=mac_runner RapidOCR / 板上=PpOcrBridge 透 box）
 *    拿每行 box+text → 造带 bbox 的 OcrTextBlock[] → 灌进 `state.textBlocks` → `wrapSurfaceIndex` 重建 SurfaceIndex。
 *    扫描页从此和数字版 PDF 一样有"带位置的字"，标注锚定/召回/重排/pageText 全自动可用。
 *
 *  · Phase 1（纯文本·兜底）：Phase 2 不可用/失败（如生产无 ocr-layout 端点）时，整页纯文本当 page_context
 *    （端侧桥优先，否则 `/api/ocr-vlm`），缓存供 `getPageOcrText`（pipeline 的 pageTextFromReflow 在文字层空时退它）。
 *
 * 触发点：renderer.ts 渲染完成后 `void ensureScannedPageLayer(state.pageId)`（#page-layer 画的是本页，grabRegion 才取对图）。
 */

const layerCache = new Map<string, OcrTextBlock[]>(); // pageId → OCR 出的行（带 bbox，Phase 2）
const flatCache = new Map<string, string>();          // pageId → 整页 OCR 纯文本（Phase 1 兜底）
const inflight = new Set<string>();

/** 扫描页判定：本页有图像区、却没有任何文字层 run（= 图片版/扫描版）。 */
export function isScannedPage(): boolean {
  return state.textBlocks.length === 0 && state.imageRegions.length > 0;
}

/** Phase 1 兜底：取本页整页 OCR 纯文本（已缓存才有；未 OCR/失败返回空串）。 */
export function getPageOcrText(pageId: string | null): string {
  return pageId ? (flatCache.get(pageId) ?? '') : '';
}

type LayoutResp = { blocks?: Array<{ text?: string; box?: number[][]; score?: number }>; width?: number; height?: number } | null;

/** 把 /api/ocr-layout 的像素 box 转成归一化 OcrTextBlock[]（每行一块，4 点取轴对齐 bbox）。 */
function toOcrTextBlocks(j: LayoutResp, pageIndex: number): OcrTextBlock[] {
  const W = j?.width || 0, H = j?.height || 0;
  if (!W || !H || !Array.isArray(j?.blocks)) return [];
  const out: OcrTextBlock[] = [];
  j.blocks.forEach((b, i) => {
    const text = String(b?.text || '').trim();
    const box = b?.box;
    if (!text || !Array.isArray(box) || box.length < 3) return;
    const xs = box.map((p) => p[0]), ys = box.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    out.push({
      id: `ocr_${pageIndex}_${i}`,
      text,
      bbox: [minX / W, minY / H, (maxX - minX) / W, (maxY - minY) / H] as NormBBox,
      confidence: Number(b?.score) || 0,
      language: /[一-鿿]/.test(text) ? 'zh' : 'en',
    });
  });
  return out;
}

/** 缓存里有本页位置文本层 → 灌进 textBlocks + 重建 SurfaceIndex。返回是否套用了。 */
function applyLayerIfReady(pageId: string): boolean {
  const blocks = layerCache.get(pageId);
  if (!blocks?.length) return false;
  state.textBlocks = blocks;
  state.surfaceIndex = wrapSurfaceIndex(pageId, state.pageIndex, blocks, state.imageRegions);
  bus.emit('surface:indexed', state.surfaceIndex);
  return true;
}

/**
 * 扫描页 → 建位置文本层（Phase 2）。已缓存即直接套用；否则后台 OCR，回来若仍在本页则套用并缓存。
 * 失败/无结果 → 退 Phase 1 纯文本兜底。每次渲染都调（renderer 每渲染会把 textBlocks 重置空，需重套缓存）。
 */
export async function ensureScannedPageLayer(pageId: string | null): Promise<void> {
  if (!pageId || !isScannedPage()) return;
  if (applyLayerIfReady(pageId)) { // 命中缓存 → 直接套（含重渲后重套）
    const n = layerCache.get(pageId)?.length ?? 0;
    devEmit('pageocr', () => ({ pageId, page_index: state.pageIndex, phase: 'layer', source: 'cache', blocks: n }));
    return;
  }
  if (inflight.has(pageId)) return;
  const img = grabRegion([0, 0, 1, 1], 0, 1600); // 整页位图（长边 ≤1600）
  if (!img) return;
  const pageIndex = state.pageIndex;
  inflight.add(pageId);
  const t0 = performance.now();
  try {
    const j = await postJson<LayoutResp>('/api/ocr-layout', { image: img });
    const blocks = toOcrTextBlocks(j, pageIndex);
    if (blocks.length) {
      layerCache.set(pageId, blocks);
      if (state.pageId === pageId) applyLayerIfReady(pageId); // 仍在本页 → 立即套用
      const ms = Math.round(performance.now() - t0);
      devEmit('pageocr', () => ({
        pageId, page_index: pageIndex, phase: 'layer', source: 'ocr-layout',
        blocks: blocks.length, chars: blocks.reduce((s, b) => s + b.text.length, 0),
        latency_ms: ms, sample: blocks.slice(0, 3).map((b) => b.text.slice(0, 24)),
      }));
    } else {
      await flatFallback(pageId, img); // 没出框 → 退 Phase 1
    }
  } catch {
    await flatFallback(pageId, img);    // ocr-layout 不可用（生产无此端点）→ 退 Phase 1
  } finally {
    inflight.delete(pageId);
  }
}

/** Phase 1 兜底：整页纯文本（端侧桥优先，否则 /api/ocr-vlm），缓存供 getPageOcrText。 */
async function flatFallback(pageId: string, img: string): Promise<void> {
  if (flatCache.has(pageId)) return;
  const t0 = performance.now();
  let source = 'ocr-vlm';
  try {
    let text = '';
    const local = await ondeviceOcrRegion(img);
    if (local) { text = String(local.text || '').trim(); source = 'ondevice'; }
    else {
      const r = await postJson<{ text?: string }>('/api/ocr-vlm', { image: img, model: settings.inferModel, scope: 'page' });
      text = String(r?.text || '').trim();
    }
    if (text) flatCache.set(pageId, text);
    const ms = Math.round(performance.now() - t0);
    devEmit('pageocr', () => ({ pageId, page_index: state.pageIndex, phase: text ? 'flat' : 'none', source, chars: text.length, latency_ms: ms, sample: text.slice(0, 60) }));
  } catch { /* 静默：下次渲染再试 */ }
}
