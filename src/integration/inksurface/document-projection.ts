/**
 * ② DocumentProjection 导出（inkloop.document_projection(.export).v1）。
 * 从 `PersistedDoc.pages[].reflow`（我们唯一落库的全书结构）折出文档块，让对方 Obsidian 渲染文档本体并锚 KO。
 * ⚠️只覆盖**重排过的页**（reflow!=null）；没重排的页没有块结构 → 跳过并记 warning。
 * body_hash / content_hash 按对方规则算（见 contract.ts），过对方 fixture validator 的重算校验。
 *
 * 扩展点（不在 L1）：export_policy.include_pdf_asset/include_raw_strokes 当前恒 false；将来基岩 Tier1 从这里挂。
 */
import { getDoc } from '../../local/store';
import { clampNormBBox } from '../../knowledge/builder';
import { pageIdFor } from '../../core/ids';
import type { NormBBox } from '../../knowledge/knowledge-object';
import type { ReflowBlock } from '../../surface/reflow';
import {
  buildInkloopDocUri,
  computeDocumentProjectionBodyHash,
  computeDocumentProjectionHash,
  DOCUMENT_PROJECTION_EXPORT_SCHEMA_VERSION,
  type DocumentProjection,
  type DocumentProjectionBlock as ProjectionBlock,
  type DocumentProjectionExportEnvelope,
} from 'ink-surface-sdk/knowledge-schema';
import { stampExportId, stableToken } from './export-ids';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';

type ProjectionBlockKind = ProjectionBlock['kind'];
const DOC_PROJECTION_SCHEMA_VERSION = 'inkloop.document_projection.v1' as const;

const KIND: Record<ReflowBlock['type'], ProjectionBlockKind> = { heading: 'heading', para: 'paragraph', list: 'list' };

const blockTextMd = (b: ReflowBlock): string =>
  b.type === 'list' && b.items?.length
    ? b.items.map((x, i) => (b.ordered ? `${i + 1}. ${x}` : `- ${x}`)).join('\n')
    : b.text;

/** run 引用归一：KO 的 object_refs 可能是字符级 `tl_3_12`，块的 sourceRunIds 是 run 级 `tl_3` → 取到倒数第二段前缀比对。 */
const runIdOf = (ref: string): string => ref.replace(/_\d+$/, '');

/** 两 bbox 交集占较小框的比例（粗判 KO 是否落在块里·兜底关联）。 */
function overlapRatio(a?: NormBBox, b?: NormBBox): number {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const minArea = Math.max(1e-9, Math.min(a[2] * a[3], b[2] * b[3]));
  return inter / minArea;
}

function koIdsForBlock(kos: KnowledgeObject[], pageIndex: number, block: ReflowBlock): string[] {
  const runIds = new Set(block.sourceRunIds ?? []);
  const ids = kos
    .filter((ko) => ko.source.page_index === pageIndex)
    .filter((ko) =>
      (ko.source.object_refs ?? []).some((ref) => runIds.has(ref) || runIds.has(runIdOf(ref)))
      || overlapRatio(ko.source.anchor_bbox, block.source) > 0.15)
    .map((ko) => ko.ko_id);
  return [...new Set(ids)].sort();
}

export interface ProjectionResult { envelope: DocumentProjectionExportEnvelope; warnings: string[]; skippedPages: number[] }

/** bbox 是否会被 clampNormBBox 实质改动（页边距外/越界）。 */
function bboxOutOfBounds(b?: NormBBox): boolean {
  if (!b) return false;
  return b[0] < 0 || b[1] < 0 || b[0] + b[2] > 1 + 1e-6 || b[1] + b[3] > 1 + 1e-6;
}

export async function buildDocumentProjectionExport(
  documentId: string,
  exportableKos: KnowledgeObject[],
  opts: { appVersion?: string; generatedAt?: string } = {},
): Promise<ProjectionResult> {
  const generated_at = opts.generatedAt ?? new Date().toISOString();
  const warnings: string[] = [];
  const doc = await getDoc(documentId);
  if (!doc) return { envelope: emptyEnvelope(documentId, generated_at, opts.appVersion), warnings: [`doc ${documentId} 不存在`], skippedPages: [] };

  const blocks: ProjectionBlock[] = [];
  let offset = 0;
  let clampedCount = 0;
  // 遍历全书每一页（按 page_count），非重排页记 skippedPages——不再只看已缓存的页、不再静默跳过。
  const pageCount = doc.page_count ?? Object.keys(doc.pages).length;
  const skippedPages: number[] = [];
  for (let pi = 0; pi < pageCount; pi++) {
    const page = doc.pages[pi];
    if (!page?.reflow?.length) { skippedPages.push(pi); continue; }
    const pageId = pageIdFor(documentId, pi);
    for (const b of page.reflow) {
      const text_md = blockTextMd(b);
      if (bboxOutOfBounds(b.source)) clampedCount++;
      const block: ProjectionBlock = {
        block_id: `blk_p${String(pi + 1).padStart(3, '0')}_${await stableToken(`${documentId}|${pi}|${b.id}`)}`,
        kind: KIND[b.type],
        ...(b.type === 'heading' ? { heading_level: Math.min(6, Math.max(1, b.level || 1)) } : {}),
        text_md,
        region: b.anchorUnsafe ? 'generated' : 'editable', // VLM 估算块=generated；文本层重排=editable
        source: {
          page_id: pageId,
          page_index: pi,
          object_refs: b.sourceRunIds ?? [],
          source_range: { start: offset, end: offset + text_md.length },
          anchor_bbox: clampNormBBox(b.source), // 越界夹回页内（renderer 需要落点）；夹动了的计入 clampedCount 警告，不静默
        },
        knowledge_object_ids: koIdsForBlock(exportableKos, pi, b),
      };
      blocks.push(block);
      offset += text_md.length + 1;
    }
  }
  if (skippedPages.length) warnings.push(`${skippedPages.length} 页未重排（无块结构·该页正文/标注/笔迹不进文档投影）：第 ${skippedPages.map((p) => p + 1).join('/')} 页`);
  if (clampedCount) warnings.push(`${clampedCount} 个块锚点在页边距外被夹回页内（anchor_bbox_clamped·导出位置非真实落笔）`);

  if (!blocks.length) {
    warnings.push('全书没有重排过的页 → 无文档投影（对方 schema 要求 blocks≥1）');
    return { envelope: emptyEnvelope(documentId, generated_at, opts.appVersion), warnings, skippedPages };
  }

  const body_hash = await computeDocumentProjectionBodyHash(blocks);
  const base: Omit<DocumentProjection, 'content_hash'> = {
    schema_version: DOC_PROJECTION_SCHEMA_VERSION,
    projection_id: `dp_${documentId}`,
    document_id: documentId,
    document_title: doc.filename || '(未命名)',
    document_uri: buildInkloopDocUri(documentId),
    revision_id: `rev_${body_hash.replace('sha256:', '').slice(0, 16)}`, // 跟内容走·内容不变则同 revision
    generated_at,
    source: { app: 'inkloop', app_version: opts.appVersion ?? '0.1.0' },
    privacy: 'export_allowed',
    // include_full_text 诚实：有页没进投影时为 false，别让协作方误以为是完整文档
    export_policy: { include_full_text: skippedPages.length === 0, include_pdf_asset: false, include_raw_strokes: false, include_debug_evidence: false },
    blocks,
    body_hash,
    created_at: generated_at,
    updated_at: generated_at,
  };
  const projection: DocumentProjection = { ...base, content_hash: await computeDocumentProjectionHash(base) };

  return {
    envelope: {
      schema_version: DOCUMENT_PROJECTION_EXPORT_SCHEMA_VERSION,
      export_id: stampExportId('projection', documentId, generated_at),
      generated_at,
      source: { app: 'inkloop', app_version: opts.appVersion ?? '0.1.0', document_id: documentId },
      document_projections: [projection],
      external_edits: [],
    },
    warnings,
    skippedPages,
  };
}

function emptyEnvelope(documentId: string, generated_at: string, appVersion?: string): DocumentProjectionExportEnvelope {
  return {
    schema_version: DOCUMENT_PROJECTION_EXPORT_SCHEMA_VERSION,
    export_id: stampExportId('projection', documentId, generated_at),
    generated_at,
    source: { app: 'inkloop', app_version: appVersion ?? '0.1.0', document_id: documentId },
    document_projections: [],
    external_edits: [],
  };
}
