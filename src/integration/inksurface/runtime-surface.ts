/**
 * ③ Runtime 表面块 + 标注 + visual_strokes，以及对方 renderer 直接吃的 ④ InkLoopVisualModel。
 *
 * 渲染模型（codex review 后定）：
 *  · 墨迹 = 逐笔按**它自己的 anchor_runs** 落到对应块的 `stroke_only` 标注（多笔跨段不塌缩·恒等），坐标转块内局部。
 *  · AI 笔记/手写注 = 每个 KO 一条 `margin_note` 标注（带 KO 正文·只出一次·excerpt 高亮除外），落在 KO 锚块上。
 *  标注的 kind/title/status 一律取**所属 KO**（不是 mark 的 feature_type）——annotation 忠实代表它 ko_id 指向的 KO。
 *  块解析全程**按 mark/KO 所在页过滤**（run id 跨页会重名·必须先收窄到同页）。
 *
 * 扩展点（不在 L1）：会议 context_id / 妙记相对时刻将来挂在 annotation 上；基岩 raw_ref 走另谈的 raw-ink 契约。
 */
import { getFoldedMarks } from '../../local/store';
import { koId } from '../../knowledge/builder';
import type { PersistedMark, PersistedStroke } from '../../core/store-format';
import type { KnowledgeObject, NormBBox } from '../../knowledge/knowledge-object';
import type { DocumentProjectionBlock as ProjectionBlock } from 'ink-surface-sdk/knowledge-schema';
import {
  RUNTIME_SURFACE_OBJECT_SCHEMA_VERSION,
  type RuntimeAnnotation,
  type RuntimeSurfaceBlock,
  type RuntimeSurfaceStroke,
  type RuntimeVisualStroke,
} from 'ink-surface-sdk/runtime-schema';
import type {
  InkLoopAnnotation as VisualModelAnnotation,
  InkLoopVisualBlock as VisualModelBlock,
  InkLoopVisualModel,
} from 'ink-surface-sdk/surface-model';
import { pageBBoxToBlock, pagePointToBlock } from './coordinates';

const pageIdxOf = (pageId: string): number => { const m = pageId.match(/_(\d+)$/); return m ? Number(m[1]) : -1; };
const runIdOf = (ref: string): string => ref.replace(/_\d+$/, '');

function overlapRatio(a?: readonly number[], b?: readonly number[]): number {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const minArea = Math.max(1e-9, Math.min(a[2] * a[3], b[2] * b[3]));
  return (ix * iy) / minArea;
}

/** 在**同页**候选块里按 run ids 命中（run 级或字符级归一后）。 */
function blockByRuns(runs: string[] | undefined, samePage: ProjectionBlock[]): ProjectionBlock | null {
  if (!runs?.length) return null;
  const set = new Set(runs);
  const norm = new Set(runs.map(runIdOf));
  return samePage.find((b) => (b.source?.object_refs ?? []).some((r) => set.has(r) || norm.has(r) || norm.has(runIdOf(r)))) ?? null;
}
/** mark 级块解析（同页）：reflow_anchor_runs + 各笔 anchor_runs → hmp.target_object_refs → bbox 重叠最大。 */
function resolveMarkBlock(mark: PersistedMark, samePage: ProjectionBlock[]): ProjectionBlock | null {
  const runs = [...(mark.reflow_anchor_runs ?? []), ...mark.strokes.flatMap((s) => s.anchor_runs ?? [])];
  const byRun = blockByRuns(runs, samePage) ?? blockByRuns(mark.hmp?.target_object_refs, samePage);
  if (byRun) return byRun;
  let best: ProjectionBlock | null = null;
  let bestOv = 0.02;
  for (const b of samePage) {
    const ov = overlapRatio(mark.bbox, b.source?.anchor_bbox);
    if (ov > bestOv) { bestOv = ov; best = b; }
  }
  return best;
}
/** KO 锚块（同页）：object_refs → anchor_bbox 重叠 → 该页首块兜底。 */
function resolveKoBlock(ko: KnowledgeObject, samePage: ProjectionBlock[]): ProjectionBlock | null {
  if (!samePage.length) return null;
  const byRun = blockByRuns(ko.source.object_refs, samePage);
  if (byRun) return byRun;
  let best: ProjectionBlock | null = null;
  let bestOv = 0.02;
  for (const b of samePage) {
    const ov = overlapRatio(ko.source.anchor_bbox, b.source?.anchor_bbox);
    if (ov > bestOv) { bestOv = ov; best = b; }
  }
  return best ?? samePage[0];
}

const visualToolOf = (tool: PersistedStroke['tool']): 'pen' | 'highlighter' =>
  tool === 'highlighter' ? 'highlighter' : 'pen';

function strokesToVisual(strokes: PersistedStroke[], color: string, blockBBox: NormBBox): RuntimeVisualStroke[] {
  return strokes
    .filter((s) => s.tool === 'pen' || s.tool === 'aipen' || s.tool === 'highlighter') // eraser/hand 非可视笔
    .map((s) => ({
      tool: visualToolOf(s.tool),
      color,
      coord_space: 'block_norm' as const,
      capture_surface: s.capture_surface ?? 'page',
      points: s.points.map((p) => pagePointToBlock(p, blockBBox)),
    }))
    .filter((s) => s.points.length > 0);
}

function strokesToSurface(strokes: PersistedStroke[], color: string): RuntimeSurfaceStroke[] {
  return strokes
    .filter((s) => (s.tool === 'pen' || s.tool === 'aipen' || s.tool === 'highlighter') && s.surface_points?.length)
    .map((s) => ({
      tool: visualToolOf(s.tool),
      color,
      capture_surface: s.capture_surface ?? 'page',
      coord_space: s.surface_coord_space ?? s.coord_space ?? 'page_norm',
      bbox: s.surface_bbox,
      points: (s.surface_points ?? []).map((p) => ({ x: p.x, y: p.y, t: p.t, pressure: p.pressure })),
    }));
}

export interface RuntimeResult { surfaceBlocks: RuntimeSurfaceBlock[]; visualModel: InkLoopVisualModel; warnings: string[]; orphanInk: number; unplacedInk: number }

export async function buildRuntimeAndVisual(
  documentId: string,
  documentTitle: string,
  blocks: ProjectionBlock[],
  exportableKos: KnowledgeObject[],
): Promise<RuntimeResult> {
  const warnings: string[] = [];
  const blockById = new Map(blocks.map((b) => [b.block_id, b]));
  const byPage = new Map<number, ProjectionBlock[]>();
  for (const b of blocks) { const pi = b.source?.page_index ?? -1; (byPage.get(pi) ?? byPage.set(pi, []).get(pi)!).push(b); }

  const markToKo = new Map<string, KnowledgeObject>();
  for (const ko of exportableKos) for (const mid of ko.provenance.mark_ids ?? []) if (!markToKo.has(mid)) markToKo.set(mid, ko);

  const runtimeByBlock = new Map<string, RuntimeAnnotation[]>();
  const visualByBlock = new Map<string, VisualModelAnnotation[]>();
  const push = (blockId: string, rt: RuntimeAnnotation, vz: VisualModelAnnotation): void => {
    (runtimeByBlock.get(blockId) ?? runtimeByBlock.set(blockId, []).get(blockId)!).push(rt);
    (visualByBlock.get(blockId) ?? visualByBlock.set(blockId, []).get(blockId)!).push(vz);
  };

  // ── 墨迹：逐笔按各自块落 stroke_only 标注 ──
  // KO-backed 笔取所属 KO 的 kind/title/status；无 KO 的可见笔（纯图形/识别失败手写/被 dismiss 的笔）
  // 也产 stroke_only（合成确定性 ko_id·visual-only），不再静默丢——否则 InkLoop 里看得到、导出后消失。
  const marks = (await getFoldedMarks(documentId)).filter((m) => !m.is_tombstone);
  let orphanInk = 0;
  let unplaced = 0;
  let surfaceOnlyInk = 0;
  for (const mark of marks) {
    const ko = markToKo.get(mark.mark_id);
    const samePage = byPage.get(pageIdxOf(mark.page_id)) ?? [];
    if (!samePage.length) { unplaced++; continue; }
    // 标注元信息：有 KO 用 KO 的；无 KO 合成 visual-only
    let meta: { ko_id: string; kind: string; title: string; status: string };
    if (ko) {
      meta = { ko_id: ko.ko_id, kind: ko.kind, title: ko.title, status: ko.status };
    } else {
      orphanInk++;
      meta = {
        ko_id: await koId(`visual-only|${mark.mark_id}`),
        kind: mark.feature_type || 'stroke',
        title: (mark.marked_text || '').trim().slice(0, 40) || '（手写/图形）',
        status: 'export_ready',
      };
    }
    const fallback = resolveMarkBlock(mark, samePage);
    const groups = new Map<string, PersistedStroke[]>();
    for (const s of mark.strokes) {
      if (s.tool !== 'pen' && s.tool !== 'aipen' && s.tool !== 'highlighter') continue;
      const blk = (s.anchor_runs?.length ? blockByRuns(s.anchor_runs, samePage) : null) ?? fallback;
      if (!blk) continue;
      (groups.get(blk.block_id) ?? groups.set(blk.block_id, []).get(blk.block_id)!).push(s);
    }
    if (!groups.size) { unplaced++; continue; }
    for (const [blockId, strokes] of groups) {
      const blk = blockById.get(blockId)!;
      const bb = (blk.source?.anchor_bbox ?? [0, 0, 1, 1]) as NormBBox;
      const vs = strokesToVisual(strokes, mark.color, bb);
      const surfaceStrokes = strokesToSurface(strokes, mark.color);
      if (!vs.length) continue;
      const visual_bbox = pageBBoxToBlock(mark.bbox, bb);
      const captureSurface = mark.capture_surface ?? vs.find((s) => s.capture_surface)?.capture_surface ?? 'page';
      if (captureSurface !== 'page' && surfaceStrokes.length) surfaceOnlyInk++;
      const rt: RuntimeAnnotation = {
        ...meta,
        render_mode: 'stroke_only',
        visual_bbox,
        visual_strokes: vs,
        capture_surface: captureSurface,
        surface_coord_space: mark.surface_coord_space ?? surfaceStrokes[0]?.coord_space,
        surface_bbox: mark.surface_bbox,
        ...(surfaceStrokes.length ? { surface_strokes: surfaceStrokes } : {}),
        created_at: mark.created_at,
        updated_at: mark.created_at,
      };
      const vz: VisualModelAnnotation = {
        ...meta,
        render_mode: 'stroke_only',
        anchor_bbox: visual_bbox,
        page_index: blk.source?.page_index,
        visual_bbox,
        visual_strokes: vs,
        capture_surface: captureSurface,
        surface_coord_space: mark.surface_coord_space ?? surfaceStrokes[0]?.coord_space,
        surface_bbox: mark.surface_bbox,
        ...(surfaceStrokes.length ? { surface_strokes: surfaceStrokes } : {}),
      };
      push(blockId, rt, vz);
    }
  }
  if (orphanInk) warnings.push(`${orphanInk} 笔无可导出 KO·按 visual-only 笔迹导出（合成 ko_id）`);
  if (unplaced) warnings.push(`${unplaced} 笔未落到任何文档块（页未重排/无重叠·跳过）`);
  if (surfaceOnlyInk) warnings.push(`${surfaceOnlyInk} 组非原版 surface 笔迹带 surface_strokes 导出；legacy visual_strokes 仍为 canonical page 近似投影`);

  // ── AI 笔记/手写注：每个 KO 一条 margin_note（带正文·只一次）；excerpt(高亮)只靠墨迹不另出旁注 ──
  let koNoteOrphan = 0;
  for (const ko of exportableKos) {
    if (ko.kind === 'excerpt' || ko.kind === 'source_document') continue;
    const body = ko.body_md.trim();
    if (!body) continue;
    const pi = ko.source.page_index;
    if (pi == null) { koNoteOrphan++; continue; }
    const blk = resolveKoBlock(ko, byPage.get(pi) ?? []);
    if (!blk) { koNoteOrphan++; continue; }
    const bb = (blk.source?.anchor_bbox ?? [0, 0, 1, 1]) as NormBBox;
    const anchor = ko.source.anchor_bbox ? pageBBoxToBlock(ko.source.anchor_bbox, bb) : undefined;
    const rt: RuntimeAnnotation = { ko_id: ko.ko_id, kind: ko.kind, title: ko.title, body_md: body, status: ko.status, render_mode: 'margin_note', visual_bbox: anchor, created_at: ko.created_at, updated_at: ko.updated_at };
    const vz: VisualModelAnnotation = { ko_id: ko.ko_id, kind: ko.kind, title: ko.title, body_md: body, status: ko.status, render_mode: 'margin_note', anchor_bbox: anchor, page_index: blk.source?.page_index, visual_bbox: anchor };
    push(blk.block_id, rt, vz);
  }
  if (koNoteOrphan) warnings.push(`${koNoteOrphan} 条 KO 笔记无锚块（页未重排·旁注略）`);

  const surfaceBlocks: RuntimeSurfaceBlock[] = blocks.map((b) => ({
    schema_version: RUNTIME_SURFACE_OBJECT_SCHEMA_VERSION,
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

  return { surfaceBlocks, visualModel: { documentTitle, blocks: visualBlocks }, warnings, orphanInk, unplacedInk: unplaced };
}
