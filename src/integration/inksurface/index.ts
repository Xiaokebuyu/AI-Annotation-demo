/**
 * InkSurface SDK 对接（L1 Tier2）总入口。
 * `buildL1Export(documentId)` 把一本书的 Tier2 真相（marks + ai_turns 折出的 KO + 重排块）一次性产成
 * 协作方四份 artifacts：KO 信封 / 文档投影信封 / runtime 表面块 / 渲染用 visual model。
 * 纯派生·只读账本与 docs 缓存·不改任何真相、不碰 index.html/main.ts。
 */
import { getDoc } from '../../local/store';
import { buildKnowledgeExport, type ExportOpts } from './knowledge-export';
import { buildDocumentProjectionExport } from './document-projection';
import { buildRuntimeAndVisual } from './runtime-surface';
import type { EntityMembershipFact } from '../../knowledge/builder';
import type { DocumentProjectionExportEnvelope, KnowledgeObjectExportEnvelope as KnowledgeExportEnvelope } from 'ink-surface-sdk/knowledge-schema';
import type { RuntimeSurfaceBlock } from 'ink-surface-sdk/runtime-schema';
import type { InkLoopVisualModel } from 'ink-surface-sdk/surface-model';

/** 导出"漏了什么"的结构化诊断——让调用方/UI 能展示哪些 KO/页/笔没进导出，杜绝"成功"假象。 */
export interface L1Diagnostics {
  skippedKos: { ko_id: string; kind: string; reason: string }[]; // 被隐私/状态/空正文闸挡掉的 KO
  skippedPages: number[];      // 未重排·不进文档投影的页（0-based）
  orphanInk: number;           // 无可导出 KO·按 visual-only 导出的笔数
  unplacedInk: number;         // 未落到任何文档块·彻底没进导出的笔数（真·丢失）
  exportableKoCount: number;
}

export interface L1Export {
  documentId: string;
  generatedAt: string;
  knowledgeExport: KnowledgeExportEnvelope;
  documentProjections: DocumentProjectionExportEnvelope;
  runtimeSurfaceBlocks: { container: 'inkloop_internal.surface_blocks'; document_id: string; generated_at: string; blocks: RuntimeSurfaceBlock[] }; // 外层只是我们的打包容器（非对方契约）；每块自带 inkloop.surface_object.v1
  visualModel: InkLoopVisualModel;
  warnings: string[];
  diagnostics: L1Diagnostics;
  entityFacts: EntityMembershipFact[]; // 存储原生拓扑：本书可导出 KO 的实体关联事实（vault-collect 跨实体聚合用）
}

export async function buildL1Export(documentId: string, opts: ExportOpts = {}): Promise<L1Export> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const o: ExportOpts = { ...opts, generatedAt };

  const doc = await getDoc(documentId);
  const documentTitle = doc?.filename || '(未命名)';

  const { envelope: knowledgeExport, exportable, skipped: skippedKos, entityFacts } = await buildKnowledgeExport(documentId, o);
  const { envelope: documentProjections, warnings: projWarn, skippedPages } = await buildDocumentProjectionExport(documentId, exportable, o);
  const blocks = documentProjections.document_projections[0]?.blocks ?? [];
  const { surfaceBlocks, visualModel, warnings: rtWarn, orphanInk, unplacedInk } = await buildRuntimeAndVisual(documentId, documentTitle, blocks, exportable);

  const warnings = [...projWarn, ...rtWarn];
  if (!exportable.length) warnings.push('没有可导出的 KnowledgeObject（这本书还没有可导出状态的标注/AI 笔记）');
  if (skippedKos.length) warnings.push(`${skippedKos.length} 个 KnowledgeObject 被导出闸挡掉（隐私/状态/空正文·见 diagnostics.skippedKos）`);

  return {
    documentId,
    generatedAt,
    knowledgeExport,
    documentProjections,
    runtimeSurfaceBlocks: { container: 'inkloop_internal.surface_blocks', document_id: documentId, generated_at: generatedAt, blocks: surfaceBlocks },
    visualModel,
    warnings,
    diagnostics: { skippedKos, skippedPages, orphanInk, unplacedInk, exportableKoCount: exportable.length },
    entityFacts,
  };
}

export type { DocumentProjectionExportEnvelope, KnowledgeObjectExportEnvelope as KnowledgeExportEnvelope } from 'ink-surface-sdk/knowledge-schema';
export type { InkLoopVisualModel } from 'ink-surface-sdk/surface-model';
