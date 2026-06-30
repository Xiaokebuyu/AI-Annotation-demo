/**
 * 会议 → InkSurface L1 导出（C「打通链路」）。
 *
 * 关键洞察：**会议不需要对方的「会议槽位」**——把会议套进现有「文档 + 标注」契约即可：
 *   · 转写  → document_projection.v1 的块（段摘要＝heading 块、每句转写＝paragraph 块；复用 segment.ts 的分段）。
 *   · 手写  → annotation KnowledgeObject，锚到它落在的那一段（heading 块）。
 *   · 会议总结 → summary KnowledgeObject。
 * 这样 Obsidian 直接渲染成「一篇会议纪要文档 + 旁注手写」，并进思维图（每条手写/总结 [[链接]]→会议文档枢纽）。
 *
 * ⚠️「近似对照」：手写落点是估算的（见 segment.ts / align.ts）；导出里手写锚到「段」而非「某句」，不假精确。
 * 纯派生·只读 store·不改任何真相。KO 复用 builder.finalize → 确定性 ko_id/content_hash，过对方 fixture validator。
 */
import { getMeeting, getCachedMinute, getFoldedMarksByContext } from '../../local/store';
import { parseSrtTranscript } from '../panel-feishu/align';
import { buildSegments, buildSegmentMarks, digestCacheKey, type RecapSegment } from '../panel-feishu/segment';
import { finalize, clampNormBBox, enrichExportTags, INK_PLACEHOLDER_DRAWING, INK_PLACEHOLDER_HANDWRITING } from '../../knowledge/builder';
import { pageIdFor } from '../../core/ids';
import type { PersistedMeeting } from '../../core/store-format';
import type { KnowledgeObject, NormBBox } from '../../knowledge/knowledge-object';
import {
  buildInkloopDocUri,
  computeDocumentProjectionBodyHash,
  computeDocumentProjectionHash,
  DOCUMENT_PROJECTION_EXPORT_SCHEMA_VERSION,
  type DocumentProjection,
  type DocumentProjectionBlock as ProjectionBlock,
  type DocumentProjectionExportEnvelope,
  isExportableKnowledgeObject as isExportableKo,
  type KnowledgeObjectExportEnvelope as KnowledgeExportEnvelope,
} from 'ink-surface-sdk/knowledge-schema';
import { stampExportId, stableToken } from './export-ids';

const DOC_PROJECTION_SCHEMA_VERSION = 'inkloop.document_projection.v1' as const;
const KO_EXPORT_SCHEMA_VERSION = 'inkloop.knowledge_export.v1' as const;

const MEETING_DOC_PREFIX = 'mtgdoc_';
/** 会议导出用的合成文档 id（与会议白板 mtgboard_<id> 区分：那是空白手记画布，这是「转写文档」）。 */
export const meetingDocId = (meetingId: string): string => MEETING_DOC_PREFIX + meetingId;

export interface MeetingExportOpts { appVersion?: string; generatedAt?: string }

export interface MeetingL1Export {
  meetingId: string;
  documentId: string;
  documentTitle: string;
  generatedAt: string;
  knowledgeExport: KnowledgeExportEnvelope;
  documentProjections: DocumentProjectionExportEnvelope;
  warnings: string[];
  diagnostics: {
    cueCount: number; markCount: number; segmentCount: number;
    summaryIncluded: boolean; annotationKoCount: number; skippedKoCount: number;
    transcriptMissing: boolean;
  };
}

const finiteMs = (...xs: Array<number | null | undefined>): number => { for (const x of xs) if (typeof x === 'number' && Number.isFinite(x)) return x; return 0; };
const clk = (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const rng = (a: number, b: number): string => `${clk(a)}–${clk(b)}`;
const inkBody = (text: string, feat: string): string => text.trim() || (feat === 'drawing' ? INK_PLACEHOLDER_DRAWING : INK_PLACEHOLDER_HANDWRITING);

/** 把一场会议折成 L1 导出（KO 包 + 文档投影），可过对方 validator + 走 obsidian-fs CLI。 */
/** store wrapper：从 IndexedDB 取数（会议 + 缓存转写 + 时间脊手写）→ 调纯核心。浏览器/设备用。 */
export async function buildMeetingL1Export(meetingId: string, opts: MeetingExportOpts = {}): Promise<MeetingL1Export> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  let cues = [] as ReturnType<typeof parseSrtTranscript>;
  if (meeting.feishu_minute_token) {
    const cached = await getCachedMinute(meeting.feishu_minute_token);
    if (cached?.srt) cues = parseSrtTranscript(cached.srt);
  }
  const marksRaw = (await getFoldedMarksByContext(`mtg_${meetingId}`)).filter((mk) => !mk.is_tombstone).sort((a, b) => a.abs_timestamp - b.abs_timestamp);
  const marks = marksRaw.map((mk) => ({ mark_id: mk.mark_id, abs_timestamp: mk.abs_timestamp, feature_type: mk.feature_type, marked_text: mk.marked_text, page_index: mk.page_index }));
  return assembleMeetingL1Export({ meeting, cues, marks }, opts);
}

/** 纯核心输入：已取好的会议数据（store wrapper 填·或测试合成）。 */
export interface MeetingExportInput {
  meeting: PersistedMeeting;
  cues: ReturnType<typeof parseSrtTranscript>;
  marks: { mark_id: string; abs_timestamp: number; feature_type?: string; marked_text?: string; page_index?: number }[];
}

/** 纯核心：会议数据 → L1 导出（**无 store**·crypto.subtle 在 Node 可用 → 可 vitest + 过对方 validator）。 */
export async function assembleMeetingL1Export(input: MeetingExportInput, opts: MeetingExportOpts = {}): Promise<MeetingL1Export> {
  const generated_at = opts.generatedAt ?? new Date().toISOString();
  const appVersion = opts.appVersion ?? '0.1.0';
  const warnings: string[] = [];
  const m = input.meeting;
  const meetingId = m.meeting_id;
  const documentId = meetingDocId(meetingId);
  const documentTitle = m.title || '会议';
  const createdAt = m.started_at || m.scheduled_at || generated_at;

  // ① 转写（缓存来·已解析成 cue）
  const cues = input.cues;
  const transcriptMissing = !cues.length;
  if (transcriptMissing) warnings.push('转写为空/未缓存——导出只含手写档案（+总结），无会议正文');

  // ② 手写（会议时间脊·跨手记白板 + 资料）→ 相对时刻（t0/offset 防 NaN·与 recap 同口径）
  const t0 = finiteMs(m.feishu_recording_t0, m.panel_meeting_start, m.started_at ? Date.parse(m.started_at) : NaN);
  const segMarks = buildSegmentMarks(input.marks, t0, finiteMs(m.align_offset_ms));
  const segments = buildSegments({ cues, marks: segMarks });
  if (!segments.length) warnings.push('本场既无转写也无手写——仅可能含总结');

  // ③ 文档投影块：段 → heading + 各 cue para。同步收集「段 idx → heading 块 id」。
  const pageId = pageIdFor(documentId, 0);
  const rawBlocks: { block: BlockShell; segIndex: number; isHeading: boolean }[] = [];
  const digestOf = (s: RecapSegment): string => (m.segment_digests?.[digestCacheKey(s)] || s.heuristicSummary || '（这段）').trim();

  for (let si = 0; si < segments.length; si++) {
    const s = segments[si];
    const headTxt = `${digestOf(s)}　〔${rng(s.startMs, s.endMs)}〕`;
    rawBlocks.push({ segIndex: si, isHeading: true, block: blockShell('heading', headTxt, pageId, 2) });
    for (const c of s.cues) {
      const txt = `${c.speaker ? c.speaker + '：' : ''}${c.text}`;
      rawBlocks.push({ segIndex: si, isHeading: false, block: blockShell('paragraph', txt, pageId, undefined) });
    }
  }

  // 合成稳定 block_id + 堆叠 bbox（无真实几何·按文档顺序竖排）+ source_range 偏移。
  const N = Math.max(1, rawBlocks.length);
  const segHeadingId: string[] = [];
  let offset = 0;
  const blocks: ProjectionBlock[] = [];
  for (let i = 0; i < rawBlocks.length; i++) {
    const { block, segIndex, isHeading } = rawBlocks[i];
    const bbox = bandBBox(i, N);
    const block_id = `blk_${String(i + 1).padStart(3, '0')}_${await stableToken(`${documentId}|${i}|${block.text_md}`)}`;
    const text_md = block.text_md;
    const full: ProjectionBlock = {
      ...block,
      block_id,
      source: { page_id: pageId, page_index: 0, object_refs: [], source_range: { start: offset, end: offset + text_md.length }, anchor_bbox: bbox },
      knowledge_object_ids: [],
    };
    blocks.push(full);
    if (isHeading) segHeadingId[segIndex] = block_id;
    offset += text_md.length + 1;
  }

  // ④ KO：会议总结（summary）+ 每笔手写（annotation·锚到所在段 heading 块）。
  const kos: KnowledgeObject[] = [];
  const summaryIncluded = !!m.summary?.trim();
  if (summaryIncluded) {
    kos.push(await finalize({
      stableKey: `mtg|${meetingId}|summary`,
      kind: 'summary',
      documentId, documentTitle,
      pageId, pageIndex: 0,
      objectRefs: [],
      bbox: [0.04, 0, 0.92, 0.06],
      body: m.summary!.trim(),
      provenance: { created_from: 'session' },
      status: 'export_ready',
      createdAt,
    }));
  }

  // 段 idx by mark：buildSegments 把每笔放进某 active 段；反查段 idx。
  const segOfMark = new Map<string, number>();
  segments.forEach((s, si) => { for (const mk of s.marks) segOfMark.set(mk.mark_id, si); });

  let annotationKoCount = 0;
  const blockById = new Map(blocks.map((b) => [b.block_id, b] as const));
  for (const mk of segMarks) {
    const si = segOfMark.get(mk.mark_id);
    const headId = si != null ? segHeadingId[si] : undefined;
    const anchorBlock = headId ? blockById.get(headId) : undefined;
    const ko = await finalize({
      stableKey: `mtg|${meetingId}|mark|${mk.mark_id}`,
      kind: 'annotation',
      documentId, documentTitle,
      pageId, pageIndex: 0,
      objectRefs: [mk.mark_id],
      bbox: anchorBlock?.source?.anchor_bbox ?? [0.04, 0, 0.92, 0.04],
      body: `${inkBody(mk.marked_text, mk.feature_type)}　（约 ${clk(mk.relMs)} 处手写）`,
      provenance: { created_from: 'mark', mark_ids: [mk.mark_id] },
      status: 'export_ready',
      createdAt,
    });
    kos.push(ko);
    annotationKoCount++;
    if (anchorBlock) anchorBlock.knowledge_object_ids = [...new Set([...anchorBlock.knowledge_object_ids, ko.ko_id])].sort();
  }

  // ⑤ 过导出闸 + taxonomy 标签富化（待办1·mode=meeting/会议 slug/会议日期 都从 KO 自身派生·createdAt 已是会议日期）+ 信封。
  const exportable = await Promise.all(kos.filter(isExportableKo).map((ko) => enrichExportTags(ko)));
  const skippedKoCount = kos.length - exportable.length;
  if (skippedKoCount) warnings.push(`${skippedKoCount} 个 KO 被导出闸挡掉（隐私/状态/空正文）`);

  const knowledgeExport: KnowledgeExportEnvelope = {
    schema_version: KO_EXPORT_SCHEMA_VERSION,
    export_id: stampExportId('export', documentId, generated_at),
    generated_at,
    source: { app: 'inkloop', app_version: appVersion, document_id: documentId },
    objects: exportable,
  };

  const documentProjections = await buildProjectionEnvelope(documentId, documentTitle, blocks, generated_at, appVersion, transcriptMissing, warnings);

  return {
    meetingId, documentId, documentTitle, generatedAt: generated_at,
    knowledgeExport, documentProjections, warnings,
    diagnostics: { cueCount: cues.length, markCount: segMarks.length, segmentCount: segments.length, summaryIncluded, annotationKoCount, skippedKoCount, transcriptMissing },
  };
}

type BlockShell = Omit<ProjectionBlock, 'block_id' | 'source' | 'knowledge_object_ids'>;
function blockShell(kind: ProjectionBlock['kind'], text_md: string, _pageId: string, headingLevel?: number): BlockShell {
  return { kind, ...(kind === 'heading' ? { heading_level: Math.min(6, Math.max(1, headingLevel || 2)) } : {}), text_md, region: 'generated' };
}

/** 第 i / N 块的竖排归一化条带 bbox（无真实几何·稳定可复算·满足 NormBBox refine）。 */
function bandBBox(i: number, n: number): NormBBox {
  const h = Math.min(0.08, 1 / n);
  const y = Math.min(1 - h, (i / n) * (1 - h));
  return clampNormBBox([0.04, y, 0.92, h]);
}

async function buildProjectionEnvelope(
  documentId: string, documentTitle: string, blocks: ProjectionBlock[],
  generated_at: string, appVersion: string, transcriptMissing: boolean, warnings: string[],
): Promise<DocumentProjectionExportEnvelope> {
  const baseEnvelope = (projections: DocumentProjection[]): DocumentProjectionExportEnvelope => ({
    schema_version: DOCUMENT_PROJECTION_EXPORT_SCHEMA_VERSION,
    export_id: stampExportId('projection', documentId, generated_at),
    generated_at,
    source: { app: 'inkloop', app_version: appVersion, document_id: documentId },
    document_projections: projections,
    external_edits: [],
  });
  if (!blocks.length) { warnings.push('无文档投影块（对方 schema 要求 blocks≥1）'); return baseEnvelope([]); }

  const body_hash = await computeDocumentProjectionBodyHash(blocks);
  const base: Omit<DocumentProjection, 'content_hash'> = {
    schema_version: DOC_PROJECTION_SCHEMA_VERSION,
    projection_id: `dp_${documentId}`,
    document_id: documentId,
    document_title: documentTitle,
    document_uri: buildInkloopDocUri(documentId),
    revision_id: `rev_${body_hash.replace('sha256:', '').slice(0, 16)}`,
    generated_at,
    source: { app: 'inkloop', app_version: appVersion },
    privacy: 'export_allowed',
    export_policy: { include_full_text: !transcriptMissing, include_pdf_asset: false, include_raw_strokes: false, include_debug_evidence: false },
    blocks,
    body_hash,
    created_at: generated_at,
    updated_at: generated_at,
  };
  return baseEnvelope([{ ...base, content_hash: await computeDocumentProjectionHash(base) }]);
}
