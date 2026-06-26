/**
 * 流水线纯逻辑（F2·从 core/pipeline.ts 抽出）。
 * 这些函数只吃入参 + 契约常量，不读全局 state / 不碰 DOM / 不发网络——可独立单测。
 * pipeline.ts 仍 import 回去用；副作用编排（captureMark/commitSessionDiscussion）留在 pipeline。
 */
import type { AnnotationEvent, EventType, HMP, InferenceResult, InferenceView, MarkFeatureType, MarkShape, NormBBox, ScreenOverlay, SurfaceIndex } from '../core/contracts';
import { RESULT_TO_OVERLAY, SCHEMA_VERSION } from '../core/contracts';
import { shortId } from '../core/ids';
import { markShapeOf } from '../capture/classify';

/** 一笔在流水线里的短标签（手写「…」/ 画「…」/ 标记「…」），逐 mark 阶段挂它。 */
export function markTraceLabel(feature: MarkFeatureType, markedText: string): string {
  const t = (markedText || '').replace(/\s+/g, ' ').slice(0, 16);
  if (feature === 'handwriting') return `手写「${t || '…'}」`;
  if (feature === 'drawing') return `画${t ? `「${t}」` : '（无字）'}`;
  return `标记「${t || '—'}」`;
}

export function unionBBox(events: AnnotationEvent[]): NormBBox {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const e of events) {
    const [x, y, w, h] = e.geometry.bbox;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

export function errorResult(evt: AnnotationEvent, _err: unknown): InferenceResult {
  return {
    result_id: shortId('res'),
    trace_id: evt.trace_id,
    request_id: 'n/a',
    result_type: 'error',
    content: '此刻没能想清楚，稍后再为你低语。',
    source_refs: [{ page_id: evt.page_id, bbox: evt.geometry.bbox, ocr_block_ids: [], event_id: evt.event_id }],
    confidence: 0,
    created_at: new Date().toISOString(),
    model_name: 'n/a',
    model_version: SCHEMA_VERSION,
  };
}

export function buildOverlay(result: InferenceResult, evt: AnnotationEvent): ScreenOverlay {
  return {
    overlay_id: shortId('ovl'),
    trace_id: evt.trace_id,
    page_id: evt.page_id,
    result_id: result.result_id,
    overlay_type: RESULT_TO_OVERLAY[result.result_type],
    geometry: { anchor_bbox: result.source_refs[0]?.bbox || evt.geometry.bbox },
    display_text: result.content,
    dismissible: true,
    created_at: new Date().toISOString(),
    state: 'shown',
    result_type: result.result_type,
  };
}

export function markActionOf(feature: MarkFeatureType, eventType: EventType, score: number): MarkShape {
  if (feature === 'handwriting') return 'handwriting';
  if (feature === 'drawing') return 'sketch';
  return markShapeOf(eventType, score);
}

/** 从 HMP + 当前页 index 解析"所标内容"（结构原文 + 转写）的原始文字。 */
export function resolveMarkedText(hmp: HMP, index: SurfaceIndex): string {
  const refs = new Set(hmp.target_object_refs);
  const objs = index.objects.filter((o) => refs.has(o.id));
  const targetText = objs.map((o) => o.text).filter(Boolean).join('').trim();
  const hint = (hmp.text_hint || '').trim();
  if (hmp.mode === 'self_content') return hint;
  if (targetText && hint && hint !== targetText) return `${targetText}（读出「${hint}」）`;
  return targetText || hint;
}

export function intentToRespond(intent: string): boolean {
  // self_note / reject → 写给自己(fold)；question / todo / attention / relation → 要回答(respond)。
  return !(intent === 'self_note' || intent === 'reject');
}

export function renderPageBackground(items?: Array<{ marked: string; reply: string }>): string {
  if (!items?.length) return '';
  const lines = items.map((it) => `· 读者标注「${it.marked || '（无字）'}」→ 你曾回应「${it.reply || '（无）'}」`).join('\n');
  return `【本页已有批注】（背景，帮你理解整页脉络；别逐条复述，回应只针对下面"当前聚焦"处）：\n${lines}\n\n`;
}

/**
 * 把 inference-view 渲染成喂模型的 user turn：idle=整段综合 / handwriting=定向答问。
 * v3：前置「本页已有批注」动态背景段，用「当前聚焦」与之区隔。
 */
export function renderUserTurn(view: InferenceView): string {
  const bg = renderPageBackground(view.page_annotations);
  const ctx = view.page_context ? `\n\n（本页上下文，仅供消歧）：${view.page_context}` : '';
  const themes = view.thematic?.length ? `\n\n【全书别处你也提过】：${view.thematic.map((t) => `「${t.text}」`).join('、')}` : '';
  if (view.trigger === 'handwriting') {
    const ref = view.referent_lines ? `读者在这句旁边写道：「${view.referent_lines}」。` : '';
    return `${bg}【当前聚焦】读者刚在本页这一处写下问题——手写问：「${view.question || view.marked}」。${ref}相关标注脉络：${view.narrative}。${themes}${ctx}`;
  }
  return `${bg}【当前聚焦】读者刚在本页这一处连续标注——脉络：${view.narrative}。所标内容：「${view.marked || '（未提取到文字）'}」。${themes}${ctx}`;
}
