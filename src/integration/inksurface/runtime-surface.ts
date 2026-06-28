/**
 * ③ Runtime 表面块 + 标注 + visual_strokes，以及对方 renderer 直接吃的 ④ InkLoopVisualModel。
 * 把 PersistedMark 的笔迹挂到它所属的文档块上（块由 anchor_runs → hmp.target_object_refs → bbox 兜底解析），
 * 笔点经坐标变换转成块内局部归一化。annotation.ko_id 连到该 mark 所属的可导出 KO（provenance.mark_ids 反查）。
 *
 * 扩展点（不在 L1）：会议 context_id / 妙记相对时刻 将来挂在 annotation 上；基岩 raw_ref 走另谈的 raw-ink 契约。
 */
import { getFoldedMarks } from '../../local/store';
import type { PersistedMark } from '../../core/store-format';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import {
  type ProjectionBlock, type RuntimeSurfaceBlock, type RuntimeAnnotation, type RuntimeVisualStroke,
  type InkLoopVisualModel, type VisualModelBlock, type VisualModelAnnotation,
} from './contract';
import { pageBBoxToBlock, pagePointToBlock } from './coordinates';

const pageIdxOf = (pageId: string): number => { const m = pageId.match(/_(\d+)$/); return m ? Number(m[1]) : -1; };
const runIdOf = (ref: string): string => ref.replace(/_\d+$/, '');

function overlapRatio(a: readonly number[], b: readonly number[]): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const minArea = Math.max(1e-9, Math.min(a[2] * a[3], b[2] * b[3]));
  return (ix * iy) / minArea;
}

/** 块选择优先级：①笔/mark 的 anchor_runs 命中块 run ②hmp.target_object_refs（归一 run）③同页 bbox 重叠最大。 */
function resolveBlock(mark: PersistedMark, blocks: ProjectionBlock[]): ProjectionBlock | null {
  const runs = new Set([...(mark.reflow_anchor_runs ?? []), ...mark.strokes.flatMap((s) => s.anchor_runs ?? [])]);
  if (runs.size) {
    const hit = blocks.find((b) => (b.source?.object_refs ?? []).some((r) => runs.has(r)));
    if (hit) return hit;
  }
  const hmpRuns = (mark.hmp?.target_object_refs ?? []).map(runIdOf);
  if (hmpRuns.length) {
    const hit = blocks.find((b) => (b.source?.object_refs ?? []).some((r) => hmpRuns.includes(r)));
    if (hit) return hit;
  }
  const pi = pageIdxOf(mark.page_id);
  let best: ProjectionBlock | null = null;
  let bestOv = 0.02;
  for (const b of blocks) {
    if (b.source?.page_index !== pi || !b.source.anchor_bbox) continue;
    const ov = overlapRatio(mark.bbox, b.source.anchor_bbox);
    if (ov > bestOv) { bestOv = ov; best = b; }
  }
  return best;
}

function visualStrokesOf(mark: PersistedMark, blockBBox: readonly number[]): RuntimeVisualStroke[] {
  const bb = blockBBox as [number, number, number, number];
  return mark.strokes
    .filter((s) => s.tool === 'pen' || s.tool === 'highlighter') // 排除 eraser/hand（非可视笔）
    .map((s) => ({ tool: s.tool as 'pen' | 'highlighter', color: mark.color, points: s.points.map((p) => pagePointToBlock(p, bb)) }))
    .filter((s) => s.points.length > 0);
}

function annotationOf(mark: PersistedMark, koId: string, block: ProjectionBlock): { runtime: RuntimeAnnotation; visual: VisualModelAnnotation } {
  const bb = (block.source?.anchor_bbox ?? [0, 0, 1, 1]) as [number, number, number, number];
  const body = (mark.hmp?.text_hint?.trim() || mark.marked_text || '').trim();
  const kind = mark.feature_type === 'markup' ? 'excerpt' : 'annotation';
  const visual_strokes = visualStrokesOf(mark, bb);
  const visual_bbox = pageBBoxToBlock(mark.bbox, bb);
  const render_mode: 'margin_note' | 'stroke_only' = body ? 'margin_note' : 'stroke_only';
  const title = (mark.marked_text || body || 'Ink mark').slice(0, 200);
  const runtime: RuntimeAnnotation = {
    ko_id: koId, kind, title, body_md: body || undefined, status: 'export_ready', render_mode,
    visual_bbox, visual_strokes: visual_strokes.length ? visual_strokes : undefined,
    created_at: mark.created_at, updated_at: mark.created_at,
  };
  const visual: VisualModelAnnotation = {
    ko_id: koId, kind, title, body_md: body || undefined, status: 'export_ready', render_mode,
    anchor_bbox: visual_bbox, page_index: block.source?.page_index, visual_bbox,
    visual_strokes: visual_strokes.length ? visual_strokes : undefined,
  };
  return { runtime, visual };
}

export interface RuntimeResult { surfaceBlocks: RuntimeSurfaceBlock[]; visualModel: InkLoopVisualModel; warnings: string[] }

export async function buildRuntimeAndVisual(
  documentId: string,
  documentTitle: string,
  blocks: ProjectionBlock[],
  exportableKos: KnowledgeObject[],
): Promise<RuntimeResult> {
  const warnings: string[] = [];
  // markId → 它所属的可导出 KO id（KO 自己的 mark / 被折进 ai_note 的 mark 都算）
  const markToKo = new Map<string, string>();
  for (const ko of exportableKos) for (const mid of ko.provenance.mark_ids ?? []) if (!markToKo.has(mid)) markToKo.set(mid, ko.ko_id);

  const marks = (await getFoldedMarks(documentId)).filter((m) => !m.is_tombstone);
  const runtimeByBlock = new Map<string, RuntimeAnnotation[]>();
  const visualByBlock = new Map<string, VisualModelAnnotation[]>();
  let unlinked = 0;
  let unplaced = 0;
  for (const mark of marks) {
    const koId = markToKo.get(mark.mark_id);
    if (!koId) { unlinked++; continue; } // 不属任何可导出 KO（如已 dismissed）→ 不渲染
    const block = resolveBlock(mark, blocks);
    if (!block) { unplaced++; continue; } // 没落到任何块（页未重排/无重叠）→ 跳过
    const { runtime, visual } = annotationOf(mark, koId, block);
    (runtimeByBlock.get(block.block_id) ?? runtimeByBlock.set(block.block_id, []).get(block.block_id)!).push(runtime);
    (visualByBlock.get(block.block_id) ?? visualByBlock.set(block.block_id, []).get(block.block_id)!).push(visual);
  }
  if (unlinked) warnings.push(`${unlinked} 笔未连到可导出 KO（跳过）`);
  if (unplaced) warnings.push(`${unplaced} 笔未落到任何文档块（页未重排/无重叠·跳过）`);

  const surfaceBlocks: RuntimeSurfaceBlock[] = blocks.map((b) => ({
    object_id: b.block_id,
    doc_id: documentId,
    text: b.text_md,
    source_anchor: { object_refs: b.source?.object_refs ?? [] },
    projection: { block_id: b.block_id, kind: b.kind, region: b.region, page_index: b.source?.page_index, page_id: b.source?.page_id, knowledge_object_ids: b.knowledge_object_ids },
    annotations: runtimeByBlock.get(b.block_id) ?? [],
  }));

  const visualBlocks: VisualModelBlock[] = blocks.map((b) => ({
    id: b.block_id,
    kind: b.kind,
    region: b.region,
    page: b.source?.page_index != null ? String(b.source.page_index) : undefined, // 对方 renderer 把 page 当页号（Number(page)）；给页索引字符串，别给 page_id（否则 Page NaN）
    content: b.text_md,
    annotations: visualByBlock.get(b.block_id) ?? [],
  }));

  return { surfaceBlocks, visualModel: { documentTitle, blocks: visualBlocks }, warnings };
}
