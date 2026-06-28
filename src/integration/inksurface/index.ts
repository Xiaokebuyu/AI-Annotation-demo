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
import type { KnowledgeExportEnvelope, DocumentProjectionExportEnvelope, RuntimeSurfaceBlock, InkLoopVisualModel } from './contract';

export interface L1Export {
  documentId: string;
  generatedAt: string;
  knowledgeExport: KnowledgeExportEnvelope;
  documentProjections: DocumentProjectionExportEnvelope;
  runtimeSurfaceBlocks: { container: 'inkloop_internal.surface_blocks'; document_id: string; generated_at: string; blocks: RuntimeSurfaceBlock[] }; // 外层只是我们的打包容器（非对方契约）；每块自带 inkloop.surface_object.v1
  visualModel: InkLoopVisualModel;
  warnings: string[];
}

export async function buildL1Export(documentId: string, opts: ExportOpts = {}): Promise<L1Export> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const o: ExportOpts = { ...opts, generatedAt };

  const doc = await getDoc(documentId);
  const documentTitle = doc?.filename || '(未命名)';

  const { envelope: knowledgeExport, exportable } = await buildKnowledgeExport(documentId, o);
  const { envelope: documentProjections, warnings: projWarn } = await buildDocumentProjectionExport(documentId, exportable, o);
  const blocks = documentProjections.document_projections[0]?.blocks ?? [];
  const { surfaceBlocks, visualModel, warnings: rtWarn } = await buildRuntimeAndVisual(documentId, documentTitle, blocks, exportable);

  const warnings = [...projWarn, ...rtWarn];
  if (!exportable.length) warnings.push('没有可导出的 KnowledgeObject（这本书还没有可导出状态的标注/AI 笔记）');

  return {
    documentId,
    generatedAt,
    knowledgeExport,
    documentProjections,
    runtimeSurfaceBlocks: { container: 'inkloop_internal.surface_blocks', document_id: documentId, generated_at: generatedAt, blocks: surfaceBlocks },
    visualModel,
    warnings,
  };
}

export type { KnowledgeExportEnvelope, DocumentProjectionExportEnvelope, InkLoopVisualModel } from './contract';
