/**
 * ① KnowledgeObject 导出信封（inkloop.knowledge_export.v1）。
 * 取我们已产的 KnowledgeObject[]（builder·ko_id 已是 Crockford-26、content_hash 已与对方 canonicalize 对齐），
 * 过对方导出闸（isExportableKo），套信封。privacy gate：只导出 export_allowed + 可导出状态 + 正文非空的 KO。
 */
import { buildKnowledgeProjection, enrichExportTags, type EntityMembershipFact } from '../../knowledge/builder';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import {
  isExportableKnowledgeObject as isExportableKo,
  type KnowledgeObjectExportEnvelope as KnowledgeExportEnvelope,
  type KoRelationGroup,
} from 'ink-surface-sdk/knowledge-schema';
import { stampExportId } from './export-ids';

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
): Promise<{ envelope: KnowledgeExportEnvelope; exportable: KnowledgeObject[]; skipped: SkippedKo[]; entityFacts: EntityMembershipFact[]; koRelationFacts: KoRelationGroup[] }> {
  const generated_at = opts.generatedAt ?? new Date().toISOString();
  const { objects: all, entityFacts: rawFacts, koRelationFacts: rawRelationFacts } = await buildKnowledgeProjection(documentId);
  // 富化 taxonomy 标签（mode/实体/日期·待办1 全量感知）：从 KO 自身 document_id/title/created_at 派生。
  // 在过闸后富化（被挡掉的不必富化）；enriched 也传给 projection/runtime——ko_id 不变·链接仍有效。
  const exportable = await Promise.all(all.filter(isExportableKo).map((ko) => enrichExportTags(ko))); // local_only / 非可导出状态 / 空正文 都挡在外
  const skipped: SkippedKo[] = all.filter((ko) => !isExportableKo(ko)).map((ko) => ({ ko_id: ko.ko_id, kind: ko.kind, reason: skipReason(ko) }));
  const exportableIds = new Set(exportable.map((ko) => ko.ko_id));
  const entityFacts = rawFacts.filter((f) => exportableIds.has(f.ko_id)); // 被导出闸挡掉的 KO，其实体关联也不该出现在导出图里
  const koRelationFacts = rawRelationFacts
    .map((g) => ({ ...g, ko_ids: g.ko_ids.filter((id) => exportableIds.has(id)) }))
    .filter((g) => g.ko_ids.length >= 2); // 被导出闸挡掉的成员剔除后，若关系组只剩 <2 个 KO 就整组丢弃（关系至少要两端都在场）
  const envelope: KnowledgeExportEnvelope = {
    schema_version: 'inkloop.knowledge_export.v1',
    export_id: stampExportId('export', documentId, generated_at),
    generated_at,
    source: { app: 'inkloop', app_version: opts.appVersion ?? '0.1.0', document_id: documentId },
    objects: exportable,
  };
  return { envelope, exportable, skipped, entityFacts, koRelationFacts };
}
