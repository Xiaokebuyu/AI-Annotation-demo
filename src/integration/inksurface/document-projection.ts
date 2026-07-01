/**
 * ② DocumentProjection 导出（inkloop.document_projection(.export).v1）。
 * 从 `PersistedDoc.pages[].reflow`（我们唯一落库的全书结构）折出文档块，让对方 Obsidian 渲染文档本体并锚 KO。
 * ⚠️重排过的页给真实印刷正文块；没重排的页（日记天生没有印刷文字可重排·阅读原版未重排页同理）如果有真实笔迹/KO，
 *   给一个"合成占位块"（region:'generated'，text_md 只是页码+计数说明，不冒充印刷正文，export_policy.include_full_text
 *   随之诚实置 false）当锚点，不再让内容在导出时静默清零；真的什么都没有的页仍跳过并记 warning。
 * body_hash / content_hash 按对方规则算（见 contract.ts），过对方 fixture validator 的重算校验。
 *
 * 扩展点（不在 L1）：export_policy.include_pdf_asset/include_raw_strokes 当前恒 false；将来基岩 Tier1 从这里挂。
 */
import { getDoc, getFoldedMarks } from '../../local/store';
import { clampNormBBox } from '../../knowledge/builder';
import { pageIdFor } from '../../core/ids';
import type { NormBBox } from '../../knowledge/knowledge-object';
import type { PersistedMark, PersistedStroke } from '../../core/store-format';
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

export interface ProjectionResult { envelope: DocumentProjectionExportEnvelope; warnings: string[]; skippedPages: number[]; syntheticPages: number[] }

/** bbox 是否会被 clampNormBBox 实质改动（页边距外/越界）。 */
function bboxOutOfBounds(b?: NormBBox): boolean {
  if (!b) return false;
  return b[0] < 0 || b[1] < 0 || b[0] + b[2] > 1 + 1e-6 || b[1] + b[3] > 1 + 1e-6;
}

// 无重排块的页（日记/原版未重排 PDF 页）用来判断"这页是否有真内容值得给一个锚点"：橡皮/隐藏工具不算。
const visibleTool = (s: PersistedStroke): boolean => s.tool === 'pen' || s.tool === 'aipen' || s.tool === 'highlighter';
const hasVisibleInk = (m: PersistedMark): boolean =>
  !m.is_tombstone && (m.strokes ?? []).some((s) => visibleTool(s) && ((s.points?.length ?? 0) > 0 || (s.surface_points?.length ?? 0) > 0));

/** 无重排块的页的合成占位块文案：标注页序号+笔数+KO数，供人在 Obsidian 里认得这是哪页，而非真实印刷正文。 */
function syntheticPageText(pageIndex: number, markCount: number, koCount: number): string {
  const parts = [`第 ${pageIndex + 1} 页手写内容`];
  if (markCount) parts.push(`${markCount} 笔`);
  if (koCount) parts.push(`${koCount} 条笔记`);
  return parts.join(' · ');
}

export async function buildDocumentProjectionExport(
  documentId: string,
  exportableKos: KnowledgeObject[],
  opts: { appVersion?: string; generatedAt?: string } = {},
): Promise<ProjectionResult> {
  const generated_at = opts.generatedAt ?? new Date().toISOString();
  const warnings: string[] = [];
  const doc = await getDoc(documentId);
  if (!doc) return { envelope: emptyEnvelope(documentId, generated_at, opts.appVersion), warnings: [`doc ${documentId} 不存在`], skippedPages: [], syntheticPages: [] };

  // 没重排块的页（日记天生没有印刷文字可重排·阅读原版未重排页同理）不该让真笔迹静默判死——按页聚合折叠后的
  // 笔迹，稍后给这类页生成一个"合成占位块"当锚点（region:'generated'，不冒充真印刷正文）。
  const marksByPage = new Map<number, PersistedMark[]>();
  for (const m of (await getFoldedMarks(documentId)).filter(hasVisibleInk)) {
    const bucket = marksByPage.get(m.page_index);
    if (bucket) bucket.push(m);
    else marksByPage.set(m.page_index, [m]);
  }

  const blocks: ProjectionBlock[] = [];
  let offset = 0;
  let clampedCount = 0;
  // 遍历全书每一页（按 page_count，越界到有笔迹/KO 的页也算），非重排页记 skippedPages 或补合成块。
  const pageCount = Math.max(
    doc.page_count ?? Object.keys(doc.pages).length,
    1 + Math.max(-1, ...exportableKos.map((ko) => ko.source.page_index ?? -1), ...marksByPage.keys()),
  );
  const skippedPages: number[] = [];
  const syntheticPages: number[] = [];
  for (let pi = 0; pi < pageCount; pi++) {
    const page = doc.pages[pi];
    if (!page?.reflow?.length) {
      const pageKos = exportableKos.filter((ko) => ko.source.page_index === pi).map((ko) => ko.ko_id).sort();
      const pageMarks = marksByPage.get(pi) ?? [];
      if (!pageKos.length && !pageMarks.length) { skippedPages.push(pi); continue; }
      const pageId = pageIdFor(documentId, pi);
      const text_md = syntheticPageText(pi, pageMarks.length, pageKos.length);
      blocks.push({
        block_id: `blk_p${String(pi + 1).padStart(3, '0')}_${await stableToken(`${documentId}|${pi}|synthetic_page`)}`,
        kind: 'paragraph',
        text_md,
        region: 'generated',
        source: {
          page_id: pageId,
          page_index: pi,
          object_refs: [],
          source_range: { start: offset, end: offset + text_md.length },
          anchor_bbox: [0, 0, 1, 1],
        },
        knowledge_object_ids: pageKos,
      });
      offset += text_md.length + 1;
      syntheticPages.push(pi);
      continue;
    }
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
  if (skippedPages.length) warnings.push(`${skippedPages.length} 页无重排块且无可导出内容·跳过：第 ${skippedPages.map((p) => p + 1).join('/')} 页`);
  if (syntheticPages.length) warnings.push(`${syntheticPages.length} 页无重排块但有笔迹/笔记·用合成占位块承载（非真实印刷正文）：第 ${syntheticPages.map((p) => p + 1).join('/')} 页`);
  if (clampedCount) warnings.push(`${clampedCount} 个块锚点在页边距外被夹回页内（anchor_bbox_clamped·导出位置非真实落笔）`);

  if (!blocks.length) {
    warnings.push('全书没有重排过的页、也没有可导出的笔迹/笔记 → 无文档投影（对方 schema 要求 blocks≥1）');
    return { envelope: emptyEnvelope(documentId, generated_at, opts.appVersion), warnings, skippedPages, syntheticPages };
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
    // include_full_text 诚实：有页没进投影、或有页是合成占位块（非真实印刷正文）时都为 false，别让协作方误以为是完整文档
    export_policy: { include_full_text: skippedPages.length === 0 && syntheticPages.length === 0, include_pdf_asset: false, include_raw_strokes: false, include_debug_evidence: false },
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
    syntheticPages,
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
