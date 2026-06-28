/**
 * ① KnowledgeObject 导出信封（inkloop.knowledge_export.v1）。
 * 取我们已产的 KnowledgeObject[]（builder·ko_id 已是 Crockford-26、content_hash 已与对方 canonicalize 对齐），
 * 过对方导出闸（isExportableKo），套信封。privacy gate：只导出 export_allowed + 可导出状态 + 正文非空的 KO。
 */
import { buildKnowledgeObjects } from '../../knowledge/builder';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import { type KnowledgeExportEnvelope, KO_EXPORT_SCHEMA_VERSION, isExportableKo, stampExportId } from './contract';

export interface ExportOpts { appVersion?: string; generatedAt?: string }

/** 从一本书的账本折出 KO[] → 过闸 → 信封。同一份 KO 也单独返回（projection / runtime 复用，避免重复折叠）。 */
export async function buildKnowledgeExport(
  documentId: string,
  opts: ExportOpts = {},
): Promise<{ envelope: KnowledgeExportEnvelope; exportable: KnowledgeObject[] }> {
  const generated_at = opts.generatedAt ?? new Date().toISOString();
  const all = await buildKnowledgeObjects(documentId);
  const exportable = all.filter(isExportableKo); // local_only / 非可导出状态 / 空正文 都挡在外
  const envelope: KnowledgeExportEnvelope = {
    schema_version: KO_EXPORT_SCHEMA_VERSION,
    export_id: stampExportId('export', documentId, generated_at),
    generated_at,
    source: { app: 'inkloop', app_version: opts.appVersion ?? '0.1.0', document_id: documentId },
    objects: exportable,
  };
  return { envelope, exportable };
}
