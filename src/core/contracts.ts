/**
 * P0 数据契约 v0 —— 与周计划文档逐字段对齐。
 * 改动必须递增 version 并通知两组（决策 D4）。
 * 全部 geometry 使用相对页面的归一化坐标 [0,1]（决策 D1）。
 */

export const SCHEMA_VERSION = '0';

export type EventType =
  | 'stroke' | 'highlight' | 'circle' | 'underline' | 'arrow'
  | 'margin_note' | 'tap_region' | 'eraser' | 'unknown';

/** [x, y, w, h]，页面归一化坐标 */
export type NormBBox = [number, number, number, number];

export interface StrokePoint {
  x: number;
  y: number;
  t: number;        // ms，相对落笔时刻
  pressure: number; // 0–1，无损保留（决策 D3）
}

export interface PDFDocumentRecord {
  document_id: string;
  file_hash: string;
  filename: string;
  page_count: number;
  uploaded_at: string;
  source_type: 'upload' | 'device_export' | 'sample';
  local_original_path: string;
  cloud_object_key?: string;
  version: string;
}

export interface PDFPageRecord {
  page_id: string;
  document_id: string;
  page_index: number;
  width: number;   // PDF 单位，归一化坐标的换算基准
  height: number;
  unit: 'pt';
  rotation: number;
  render_dpi: number;
  version: string;
}

export interface AnnotationEvent {
  event_id: string;
  trace_id: string;
  document_id: string;
  page_id: string;
  event_type: EventType;
  geometry: { bbox: NormBBox };
  stroke_points: StrokePoint[];
  text_note: string | null;
  created_at: string;
  device_id: string;
  session_id: string;
  pointer_type: string;
  version: string;
}

export interface OcrTextBlock {
  id: string;
  text: string;
  bbox: NormBBox;
  confidence: number;
  language: string;
}

export type OcrScope = 'full_page' | 'region' | 'stroke_neighborhood';

export interface OCRResult {
  ocr_result_id: string;
  trace_id: string;
  event_id: string;
  page_id: string;
  scope: OcrScope;
  text_blocks: OcrTextBlock[];
  nearby_text: string | null;
  note?: string;
  model_name: string;
  model_version: string;
  runtime: 'mock' | 'pdf_text_layer' | 'cloud_fallback' | 'local_mac' | 'local_board';
  latency_ms: number;
}

export type OutputMode = 'inspiration' | 'question' | 'connection' | 'summary' | 'action';

export interface InferenceRequest {
  request_id: string;
  trace_id: string;
  event_id: string;
  document_context: { document_id: string };
  page_context: { page_id: string; page_index: number };
  annotation_event: { event_type: EventType; page_id: string; geometry: { bbox: NormBBox } };
  ocr_blocks: OcrTextBlock[];
  nearby_text: string | null;
  user_profile_stub: null; // 第一周只能为空（画像后置红线）
  output_modes: OutputMode[];
  version: string;
}

export interface SourceRef {
  page_id: string;
  bbox: NormBBox;
  ocr_block_ids: string[];
  event_id: string;
}

export type ResultType = OutputMode | 'error';

export interface InferenceResult {
  result_id: string;
  trace_id: string;
  request_id: string;
  result_type: ResultType;
  content: string;
  source_refs: SourceRef[];
  confidence: number;
  created_at: string;
  model_name: string;
  model_version: string;
}

export type OverlayType = 'note' | 'highlight' | 'link' | 'question' | 'suggestion_card';
export type OverlayState = 'shown' | 'accepted' | 'edited' | 'dismissed';

export interface ScreenOverlay {
  overlay_id: string;
  trace_id: string;
  page_id: string;
  result_id: string;
  overlay_type: OverlayType;
  geometry: { anchor_bbox: NormBBox };
  display_text: string;
  dismissible: boolean;
  created_at: string;
  state: OverlayState;
  result_type: ResultType;
  object_refs?: string[];  // 锚的字符对象 id（= HMP target_object_refs / view.anchor_refs）；跨视图按 ref 定位
}

export const RESULT_TO_OVERLAY: Record<ResultType, OverlayType> = {
  question: 'question',
  inspiration: 'note',
  connection: 'link',
  summary: 'note',
  action: 'suggestion_card',
  error: 'suggestion_card',
};

/* ──────────────────────────────────────────────────────────────────────────
 * 徐智强「序列语义方案」契约 v1（端侧取证协议：App结构 > 几何命中 > 局部OCR > crop > 后置AI）
 * 这些是**新增**契约，不修改上面冻结的 v0 typed 契约（SCHEMA_VERSION 仍 '0'，不动）。
 * 等徐智强真机契约落地时再对齐字段并一起 bump。
 * ────────────────────────────────────────────────────────────────────────── */

export const HMP_SCHEMA_VERSION = '2';

/** SurfaceObject 类型（徐智强 step①：App 渲染时提交的轻量对象表的成员）。 */
export type SurfaceObjectType =
  | 'title'          // reflowLocal 的 heading
  | 'text_block'     // reflowLocal 的 para/list，或裸 text run
  | 'image'          // 图像区域（embedded_image / 图表）
  | 'chat_message'   // 聊天气泡
  | 'blank_region';  // 空白背景（self_content 锚点）

/** 对象来源（provenance）：标清是谁产出的，防云端视觉同时顶替结构层和 OCR 层导致混淆。 */
export type SurfaceObjectSource = 'structure' | 'reflow' | 'ocr' | 'vlm';

/** 页面/界面类型，决定 target 查找策略。 */
export type SurfaceType = 'article' | 'chat' | 'whiteboard';

export interface SurfaceObject {
  id: string;
  type: SurfaceObjectType;
  bbox: NormBBox;               // 归一化 [x,y,w,h]，与 OcrTextBlock.bbox 同制（D1）
  text?: string;               // image / blank_region 可空
  role?: 'user' | 'agent' | 'embedded_image' | 'diagram' | 'decorative';
  source: SurfaceObjectSource;
}

/** SurfaceIndex：一页/一屏的轻量对象表（徐智强 step① 产物）。 */
export interface SurfaceIndex {
  surface_id: string;          // = state.pageId
  surface_type: SurfaceType;
  page_index: number;
  objects: SurfaceObject[];
}

/** 几何分类后的标注动作（徐智强词汇）。由 markShapeOf() 从 EventType 映射；cross/sketch 当前分类器未产出，留位。 */
export type MarkShape =
  | 'enclosure' | 'underline' | 'cross' | 'arrow' | 'handwriting' | 'sketch' | 'highlight' | 'unknown';

/** 标注语境（徐智强 step④/⑥）。 */
export type HmpMode = 'anchored' | 'self_content' | 'mixed' | 'unknown';

/** 命中对象的类型提示（面向理解层语义，从 SurfaceObject.type 派生）。 */
export type HmpObjectHint = 'text' | 'image_region' | 'ui_region' | 'blank' | 'diagram' | 'unknown';

/**
 * HMP（Hand-Mark Protocol）—— 一次笔迹手势的取证记录（徐智强序列语义方案 step④ 产物）。
 * 只放"在哪、对什么、做了什么手势 + 取证线索"，不放 AI 推断结果（那是 InferenceResult 的职责）。
 * 由 src/core/target.ts:buildHmp 同步产出；step⑤OCR / step⑥手写识别异步补填 text_hint/crop_ref/vector_ref。
 */
export interface HMP {
  hmp_id: string;
  surface_id: string;
  mode: HmpMode;
  action: MarkShape;
  target_region: NormBBox;       // 多笔 union bbox
  target_object_refs: string[];  // 命中的 SurfaceObject.id（空 = 未命中）
  object_hint: HmpObjectHint;
  text_hint?: string;            // step⑤局部OCR / step⑥手写识别读出的文字
  crop_ref?: string;             // demo：区域/合成 crop 的 dataURL（将来换不透明 store key）
  vector_ref?: string;           // demo：白底纯笔迹图 dataURL（徐智强 evidence=vector_ref）
  confidence: number;
  version: string;
}

/* ──────────────────────────────────────────────────────────────────────────
 * 标注图（mark graph）+ inference-view 契约
 *   —— 把"一段 session 的多个 mark"建成带三类边（空间恒存/时间/语义）的图，
 *   再蒸馏成只喂模型的精简 inference-view（丢坐标/stroke/分数）。
 *   新增、不动冻结的 SCHEMA_VERSION='0'；HMP_SCHEMA_VERSION 已 bump 到 '2'。
 * ────────────────────────────────────────────────────────────────────────── */

export const INFERVIEW_SCHEMA_VERSION = '1';

/** 笔迹特征型（正交于 EventType/MarkShape）：标记手势 / 手写文字 / 抽象画。由 stroke 特征判。 */
export type MarkFeatureType = 'markup' | 'handwriting' | 'drawing';

/** 标注图边的种类。 */
export type MarkEdgeKind = 'spatial' | 'temporal' | 'semantic';

/** 时间×空间四象限：近/近=一口气、近时远空=扫读、远时近空=回访、远/远=另起。 */
export type QuadrantLabel = 'one_action' | 'sweep' | 'revisit' | 'separate';

/** 标注图节点 = 一个 mark（1.2s 组装出的一次手势）的取证摘要。 */
export interface MarkNode {
  mark_id: string;
  page_id: string;
  shape: MarkShape;                 // 中性几何事实
  feature_type: MarkFeatureType;
  feature_confidence: number;
  bbox: NormBBox;
  t: number;                        // 组装时刻（performance.now ms）
  mode: HmpMode;
  object_hint: HmpObjectHint;
  target_object_refs: string[];
  text_hint?: string;
  text?: string;                    // 落笔当时解析好的"所标内容"（结构原文+转写）；跨页 session 提交时不再依赖 live index
}

/** 标注图的边：两 mark 之间的关联（语义边可带方向）。 */
export interface MarkEdge {
  from: string;                     // mark_id
  to: string;                       // mark_id
  kind: MarkEdgeKind;
  rel: string;                      // spatial:'proximity'|'containment'|'same_target'；temporal:'before'；semantic:'arrow'|'points_at'
  weight: number;                   // 0–1
  quadrant?: QuadrantLabel;         // 时间边携带的时空象限
  direction?: 'a_to_b';             // 箭头方向
}

/** 标注图 = 一段 session 的 mark 节点 + 三类边（可跨页）。 */
export interface MarkGraph {
  surface_ids: string[];
  nodes: MarkNode[];
  edges: MarkEdge[];
  version: string;
}

/** inference-view：标注图蒸馏成的精简推理载荷（确定性产出，丢坐标/stroke/分数）。 */
export interface InferenceView {
  view_id: string;
  trigger: 'idle' | 'handwriting';
  narrative: string;                // 有序关系叙事
  marked: string;                   // 所标内容（结构原文 + 转写）
  page_context?: string;            // 压短的整页上下文（仅消歧）
  question?: string;                // handwriting 触发时用户写的那句
  crop?: { role: 'ink' | 'composite'; data: string };  // 仅文字表达不了时
  anchor_refs: string[];            // 回屏锚点对象（不给模型坐标）
  anchor_bbox: NormBBox;            // 锚到哪（最近一笔）
  page_id: string;
  version: string;
}
