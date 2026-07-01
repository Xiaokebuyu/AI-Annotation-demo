/**
 * VaultExportBundle → SDK adapter-obsidian 的 ObsidianVaultRenderInput。
 * SDK 渲染器只吃 canonical artifacts（KO/投影）+ 可选概念层·自己算 folder/MOC；
 * 这里把我方 bundle 的 envelope 摊成 objects/document_projections 数组。
 */
import type { ObsidianVaultRenderInput } from 'ink-surface-sdk/adapters/obsidian';
import { isInkPlaceholderBody } from '../../knowledge/builder';
import type { VaultExportBundle } from './vault-export';

type RenderEntity = VaultExportBundle['entities'][number];
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const strokeHasPoints = (stroke: { points?: readonly { x: number; y: number }[] }): boolean =>
  (stroke.points ?? []).some((p) => finite(p.x) && finite(p.y));

/** 该实体是否有可整页复现的笔迹（非 block_norm、有点）——与 SDK 的整页 SVG 判据同口径。 */
function hasPageSurfaceInk(entity: RenderEntity): boolean {
  for (const block of entity.visualModel?.blocks ?? []) {
    for (const annotation of block.annotations ?? []) {
      for (const stroke of [...(annotation.surface_strokes ?? []), ...(annotation.visual_strokes ?? [])]) {
        if (!strokeHasPoints(stroke)) continue;
        const coord = stroke.coord_space ?? annotation.surface_coord_space ?? 'page_norm';
        if (coord !== 'block_norm') return true;
      }
    }
  }
  return false;
}

/** 有整页复现时，把纯图形/未识别手写的占位 KO 从 knowledgeObjects 移除——它们的笔迹已在整页 SVG/sidecar 里
 *  （runtime-surface 对无 KO 的可见笔会合成 visual-only 标注，笔迹不丢），callout 里再列一堆「（图形标注/圈画）」
 *  空卡片纯属噪声。有正文的 KO（AI 笔记/识别文字/摘录）保留。会议、无整页复现时不动（避免占位无声消失）。 */
function renderKnowledgeObjects(entity: RenderEntity): RenderEntity['knowledgeExport']['objects'] {
  if (entity.mode === 'meeting' || !hasPageSurfaceInk(entity)) return entity.knowledgeExport.objects;
  return entity.knowledgeExport.objects.filter((ko) => !isInkPlaceholderBody(ko.body_md));
}

export function toObsidianVaultRenderInput(bundle: VaultExportBundle): ObsidianVaultRenderInput {
  return {
    entities: bundle.entities.map((entity) => ({
      documentId: entity.documentId,
      documentTitle: entity.documentTitle,
      mode: entity.mode,
      dates: entity.dates,
      knowledgeObjects: renderKnowledgeObjects(entity),
      documentProjections: entity.documentProjections.document_projections,
      ...(entity.materialDocIds?.length ? { materialDocumentIds: entity.materialDocIds } : {}),
      ...(entity.visualModel ? { visualModel: entity.visualModel } : {}),
    })),
    ...(bundle.conceptLayer ? { conceptLayer: bundle.conceptLayer } : {}),
  };
}
