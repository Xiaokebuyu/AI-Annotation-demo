/**
 * ① KnowledgeObject 导出信封（inkloop.knowledge_export.v1）。
 * 取我们已产的 KnowledgeObject[]（builder·ko_id 已是 Crockford-26、content_hash 已与对方 canonicalize 对齐），
 * 过对方导出闸（isExportableKo），套信封。privacy gate：只导出 export_allowed + 可导出状态 + 正文非空的 KO。
 */
import { buildKnowledgeObjects, enrichExportTags } from '../../knowledge/builder';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import { type KnowledgeExportEnvelope, KO_EXPORT_SCHEMA_VERSION, isExportableKo, stampExportId } from './contract';

export interface ExportOpts { appVersion?: string; generatedAt?: string }

/** 被导出闸挡掉的 KO + 原因（让"哪些笔记没进导出"不再静默）。 */
export interface SkippedKo { ko_id: string; kind: string; reason: string }
function skipReason(ko: KnowledgeObject): string {
  if (ko.privacy !== 'export_allowed') return `privacy=${ko.privacy}（仅本地）`;
  if (!['export_ready', 'accepted', 'edited'].includes(ko.status)) return `status=${ko.status}（未到可导出态）`;
  if (!ko.body_md.trim()) return '正文为空';
  return '未知';
}

/** 从一本书的账本折出 KO[] → 过闸 → 信封。同一份 KO 也单独返回（projection / runtime 复用，避免重复折叠）。
 *  被挡掉的 KO 进 `skipped`（带原因），由上层 diagnostics 暴露，杜绝"成功导出"假象。 */
export async function buildKnowledgeExport(
  documentId: string,
  opts: ExportOpts = {},
): Promise<{ envelope: KnowledgeExportEnvelope; exportable: KnowledgeObject[]; skipped: SkippedKo[] }> {
  const generated_at = opts.generatedAt ?? new Date().toISOString();
  const all = await buildKnowledgeObjects(documentId);
  // 富化 taxonomy 标签（mode/实体/日期·待办1 全量感知）：从 KO 自身 document_id/title/created_at 派生。
  // 在过闸后富化（被挡掉的不必富化）；enriched 也传给 projection/runtime——ko_id 不变·链接仍有效。
  const exportable = await Promise.all(all.filter(isExportableKo).map((ko) => enrichExportTags(ko))); // local_only / 非可导出状态 / 空正文 都挡在外
  const skipped: SkippedKo[] = all.filter((ko) => !isExportableKo(ko)).map((ko) => ({ ko_id: ko.ko_id, kind: ko.kind, reason: skipReason(ko) }));
  const envelope: KnowledgeExportEnvelope = {
    schema_version: KO_EXPORT_SCHEMA_VERSION,
    export_id: stampExportId('export', documentId, generated_at),
    generated_at,
    source: { app: 'inkloop', app_version: opts.appVersion ?? '0.1.0', document_id: documentId },
    objects: exportable,
  };
  return { envelope, exportable, skipped };
}
