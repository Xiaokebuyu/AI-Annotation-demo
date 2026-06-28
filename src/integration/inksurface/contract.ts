/**
 * InkSurface SDK 对接契约（L1 Tier2）—— **协作方 ink-surface-sdk-main 契约的本地镜像**。
 *
 * 这是 InkLoop ↔ 协作方 InkSurface SDK 的边界类型 + 纯哈希/URI 助手。形状照搬对方
 * `ink-surface-sdk-main/packages/{ko-schema fixtures, runtime-schema}` 和 demo
 * `examples/ai-annotation-demo/src/knowledge/{knowledge-object,document-projection,hash,canonical-json,uri}.ts`。
 * ⚠️对方更契约时这里要同步（保持镜像）。content_hash/body_hash 的 canonicalize 复用 builder 的
 * `canonicalJson`（已与对方 canonicalize 对齐：排序键 + 剔 undefined），杜绝两份 canonicalize 漂移。
 *
 * L1 只覆盖 Tier2 语义导出（KO 包 + 文档投影 + runtime 表面块/标注/visual_strokes + 渲染用 visual model）。
 * 基岩 Tier1 / 会议维度 / 妙记对轴 不在 L1（见各 builder 的「扩展点」注释）。
 */
import { canonicalJson, sha256HexStr } from '../../knowledge/builder';
import type { KnowledgeObject, KnowledgeStatus, NormBBox, Sha256 } from '../../knowledge/knowledge-object';

export type { KnowledgeObject, NormBBox, Sha256 };

// ── 哈希（与对方 hash.ts 同：sha256Tagged(canonicalize(x))）──
export async function sha256Tagged(input: string): Promise<Sha256> {
  return `sha256:${await sha256HexStr(input)}` as Sha256;
}
export async function hashCanonical(value: unknown): Promise<Sha256> {
  return sha256Tagged(canonicalJson(value));
}

// ── URI（镜像对方 uri.ts）──
export const docUri = (documentId: string): string => `inkloop://doc/${encodeURIComponent(documentId)}`;

// ════ ① KnowledgeObject 导出信封（inkloop.knowledge_export.v1）════
export const KO_EXPORT_SCHEMA_VERSION = 'inkloop.knowledge_export.v1';
export interface KnowledgeExportEnvelope {
  schema_version: typeof KO_EXPORT_SCHEMA_VERSION;
  export_id: string;
  generated_at: string;
  source: { app: 'inkloop'; app_version?: string; document_id?: string };
  objects: KnowledgeObject[];
}
/** 对方导出闸（isExportableKnowledgeObject）：privacy=export_allowed + 状态可导出 + 正文非空。 */
const EXPORTABLE_STATUS: KnowledgeStatus[] = ['export_ready', 'accepted', 'edited'];
export function isExportableKo(ko: KnowledgeObject): boolean {
  return ko.privacy === 'export_allowed' && EXPORTABLE_STATUS.includes(ko.status) && ko.body_md.trim().length > 0;
}

// ════ ② DocumentProjection（inkloop.document_projection(.export).v1）════
export const DOC_PROJECTION_SCHEMA_VERSION = 'inkloop.document_projection.v1';
export const DOC_PROJECTION_EXPORT_SCHEMA_VERSION = 'inkloop.document_projection_export.v1';
export type ProjectionBlockKind = 'heading' | 'paragraph' | 'quote' | 'list' | 'table' | 'image' | 'page_break' | 'unknown';
export type ProjectionRegion = 'generated' | 'editable' | 'external';
export interface ProjectionBlock {
  block_id: string; // ^blk_[A-Za-z0-9_-]+$
  kind: ProjectionBlockKind;
  heading_level?: number; // 1..6（kind=heading 时）
  text_md: string;
  region: ProjectionRegion;
  source?: {
    page_id?: string;
    page_index?: number;
    object_refs: string[];
    source_range?: { start: number; end: number };
    anchor_bbox?: NormBBox;
  };
  knowledge_object_ids: string[];
}
export interface DocumentProjection {
  schema_version: typeof DOC_PROJECTION_SCHEMA_VERSION;
  projection_id: string; // ^dp_[A-Za-z0-9_-]+$
  document_id: string;
  document_title: string;
  document_uri: string; // inkloop://
  revision_id: string;
  generated_at: string;
  source: { app: 'inkloop'; app_version?: string };
  privacy: 'export_allowed' | 'local_only';
  export_policy: { include_full_text: boolean; include_pdf_asset: boolean; include_raw_strokes: boolean; include_debug_evidence: boolean };
  blocks: ProjectionBlock[]; // min 1
  body_hash: Sha256;
  content_hash: Sha256;
  created_at: string;
  updated_at: string;
}
export interface DocumentProjectionExportEnvelope {
  schema_version: typeof DOC_PROJECTION_EXPORT_SCHEMA_VERSION;
  export_id: string;
  generated_at: string;
  source: { app: 'inkloop'; app_version?: string; document_id?: string };
  document_projections: DocumentProjection[];
  external_edits: unknown[];
}
/** body_hash = canonicalize(blocks.map → {block_id,kind,text_md})；与对方 computeDocumentProjectionBodyHash 同。 */
export async function projectionBodyHash(blocks: readonly ProjectionBlock[]): Promise<Sha256> {
  return hashCanonical(blocks.map((b) => ({ block_id: b.block_id, kind: b.kind, text_md: b.text_md })));
}
/** content_hash = canonicalize(projection 去掉 generated_at/created_at/updated_at/content_hash)；与对方同（时间字段不进 hash → 跨次导出稳定）。 */
export async function projectionContentHash(p: Omit<DocumentProjection, 'content_hash'>): Promise<Sha256> {
  const { generated_at: _g, created_at: _c, updated_at: _u, ...stable } = p;
  void _g; void _c; void _u;
  return hashCanonical(stable);
}

// ════ ③ Runtime surface（inkloop.surface_object.v1·渲染/同步用·L1 不计算 hash）════
export const SURFACE_OBJECT_SCHEMA_VERSION = 'inkloop.surface_object.v1';
export interface RuntimeStrokePoint { x: number; y: number; t?: number; pressure?: number }
export interface RuntimeVisualStroke { tool?: 'pen' | 'highlighter'; color?: string; opacity?: number; points: RuntimeStrokePoint[] }
export interface RuntimeAnnotation {
  ko_id: string;
  kind?: string;
  title?: string;
  body_md?: string;
  status?: string;
  render_mode?: 'stroke_only' | 'margin_note' | string;
  visual_bbox?: NormBBox;
  visual_strokes?: RuntimeVisualStroke[];
  created_at?: string;
  updated_at?: string;
}
export interface RuntimeSurfaceBlock {
  schema_version: typeof SURFACE_OBJECT_SCHEMA_VERSION; // 对方 runtime fixture 每块都带（per-object 版本）
  object_id: string;
  doc_id?: string;
  text?: string;
  source_anchor?: { quote?: string; object_refs?: string[] };
  projection?: { block_id?: string; kind?: string; region?: string; page_index?: number; page_id?: string; knowledge_object_ids?: string[] };
  annotations?: RuntimeAnnotation[];
}

// ════ ④ 渲染用 InkLoopVisualModel（surface-model·对方 renderInkLoopVisualModel 直接吃）════
export interface VisualModelAnnotation {
  ko_id: string;
  kind: string;
  title: string;
  body_md?: string;
  status?: string;
  render_mode?: 'stroke_only' | 'margin_note';
  anchor_bbox?: NormBBox;
  page_index?: number;
  visual_bbox?: NormBBox;
  visual_strokes?: RuntimeVisualStroke[];
}
export interface VisualModelBlock {
  id: string;
  kind: string;
  region: string;
  page?: string;
  content: string;
  annotations: VisualModelAnnotation[];
}
export interface InkLoopVisualModel {
  documentTitle: string;
  blocks: VisualModelBlock[];
}

// ── 共用：export_id / 稳定 token（block_id 去随机·保确定性）──
export const stampExportId = (prefix: string, documentId: string, generatedAt: string): string =>
  `${prefix}_${documentId}_${generatedAt.replace(/[-:.TZ]/g, '')}`;
export async function stableToken(seed: string, len = 10): Promise<string> {
  return (await sha256HexStr(seed)).slice(0, len);
}
