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
}

export const RESULT_TO_OVERLAY: Record<ResultType, OverlayType> = {
  question: 'question',
  inspiration: 'note',
  connection: 'link',
  summary: 'note',
  action: 'suggestion_card',
  error: 'suggestion_card',
};
