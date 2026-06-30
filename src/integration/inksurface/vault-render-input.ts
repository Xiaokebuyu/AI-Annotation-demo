/**
 * VaultExportBundle → SDK adapter-obsidian 的 ObsidianVaultRenderInput。
 * SDK 渲染器只吃 canonical artifacts（KO/投影）+ 可选概念层·自己算 folder/MOC；
 * 这里把我方 bundle 的 envelope 摊成 objects/document_projections 数组。
 */
import type { ObsidianVaultRenderInput } from 'ink-surface-sdk/adapters/obsidian';
import type { VaultExportBundle } from './vault-export';

export function toObsidianVaultRenderInput(bundle: VaultExportBundle): ObsidianVaultRenderInput {
  return {
    entities: bundle.entities.map((entity) => ({
      documentId: entity.documentId,
      documentTitle: entity.documentTitle,
      mode: entity.mode,
      dates: entity.dates,
      knowledgeObjects: entity.knowledgeExport.objects,
      documentProjections: entity.documentProjections.document_projections,
    })),
    ...(bundle.conceptLayer ? { conceptLayer: bundle.conceptLayer } : {}),
  };
}
