import type { AnnotationEvent, EventType, InferenceRequest, InferenceResult, NormBBox, OCRResult, OutputMode, ScreenOverlay } from './contracts';
import { RESULT_TO_OVERLAY, SCHEMA_VERSION } from './contracts';
import { DEVICE_ID, SESSION_ID, shortId } from './ids';
import { bboxOf, classify } from './classify';
import { INTENT_MODES } from './gesture';
import { mark } from './metrics';
import { trace } from './trace';
import { bus, settings, state, type Stroke } from '../app/state';
import { grabPage, grabRegion, runOcr } from '../providers/ocr';
import { inferProviders } from '../providers/inference';
import { getMemory, memorySnapshot, pageMarks, recordMark, setSummary } from './memory';
import { putMemory } from '../app/store';
import { pushInspect } from './inspect';

/** 单笔封装为契约 shape。会话内多笔共享一个 trace_id（决策：停笔会话）。 */
export function makeEvent(stroke: Stroke, traceId: string): AnnotationEvent | null {
  if (!state.documentId || !state.pageId) return null;
  const bb = bboxOf(stroke.points);
  return {
    event_id: shortId('evt'),
    trace_id: traceId,
    document_id: state.documentId,
    page_id: state.pageId,
    event_type: stroke.tool === 'highlighter' ? 'highlight' : classify(stroke.points, bb),
    geometry: { bbox: bb },
    stroke_points: stroke.points, // 无损（决策 D3）
    text_note: null,
    created_at: new Date().toISOString(),
    device_id: DEVICE_ID,
    session_id: SESSION_ID,
    pointer_type: 'unknown',
    version: SCHEMA_VERSION,
  };
}

/** 抬笔即记录：每笔独立 event 进 trace（B 组原料不丢），并打 pen-up→event 延迟。 */
export function recordEvent(stroke: Stroke, traceId: string, pointerType: string, penUpAt: number): AnnotationEvent | null {
  const evt = makeEvent(stroke, traceId);
  if (!evt) return null;
  evt.pointer_type = pointerType;
  trace('AnnotationEvent', evt as unknown as Record<string, unknown>);
  mark('pen_event', performance.now() - penUpAt);
  return evt;
}

function unionBBox(events: AnnotationEvent[]): NormBBox {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const e of events) {
    const [x, y, w, h] = e.geometry.bbox;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** 会话内多笔合并成一个代表 event 用于推理（trace 里每笔仍独立留存）。 */
function representative(events: AnnotationEvent[]): AnnotationEvent {
  const bbox = unionBBox(events);
  const points = events.flatMap((e) => e.stroke_points);
  const last = events[events.length - 1];
  return { ...last, geometry: { bbox }, stroke_points: points, event_type: classify(points, bbox) };
}

function buildRequest(
  evt: AnnotationEvent,
  ocr: Pick<OCRResult, 'text_blocks' | 'nearby_text'>,
  output_modes: OutputMode[] = ['inspiration', 'question', 'connection'],
): InferenceRequest {
  return {
    request_id: shortId('req'),
    trace_id: evt.trace_id,
    event_id: evt.event_id,
    document_context: { document_id: evt.document_id },
    page_context: { page_id: evt.page_id, page_index: state.pageIndex },
    annotation_event: { event_type: evt.event_type, page_id: evt.page_id, geometry: evt.geometry },
    ocr_blocks: ocr.text_blocks,
    nearby_text: ocr.nearby_text,
    user_profile_stub: null,
    output_modes,
    version: SCHEMA_VERSION,
  };
}

function errorResult(evt: AnnotationEvent, err: unknown): InferenceResult {
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

function buildOverlay(result: InferenceResult, evt: AnnotationEvent): ScreenOverlay {
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

/** 符号类型 → 中文标签（喂给推理的结构化上下文，也方便人读 trace）。 */
const SYM_LABEL: Record<EventType, string> = {
  circle: '圈选', underline: '划线', highlight: '高亮', arrow: '箭头',
  margin_note: '批注', tap_region: '点选', stroke: '标记', eraser: '擦除', unknown: '标记',
};

/**
 * 段落讨论提交：把同一段上的一簇手势（1 个或多个）合成一条回应，落在该段旁的留白。
 * 每个标注各取「符号类型 + 圈住的上下文」结构化进 nearby_text（守 D4：不改契约形状，
 * 只用既有 nearby_text / output_modes）。**按 discId upsert** —— 讨论继续就原地刷新
 * 同一条，不每段各占空间。云端失败降级不崩（A11）。
 */
export async function commitDiscussion(
  events: AnnotationEvent[],
  penUpAt: number,
  discId: string,
  modes: OutputMode[],
  eventType?: EventType,
  intent?: string,
): Promise<void> {
  if (!events.length) return;
  const evt = representative(events);
  evt.trace_id = shortId('disc');
  if (eventType) evt.event_type = eventType; // 单手势时写 canonical 类型，服务端据此框定语气

  // 逐标注取圈住的上下文（单条 OCR 失败跳过，不连累整体）。runOcr 由设置决定 textlayer / 图像 OCR
  const ocrs = await Promise.all(events.map((e) => runOcr(e).catch(() => null)));
  const parts = events.map((e, i) => {
    const blocks = ocrs[i]?.text_blocks ?? [];
    return { type: e.event_type, text: (blocks.map((b) => b.text).join('') || ocrs[i]?.nearby_text || '').trim() };
  });
  let structured = parts.map((p) => `〔${SYM_LABEL[p.type]}〕"${(p.text || '此处').slice(0, 40)}"`).join('  ');
  const allBlocks = ocrs.flatMap((o) => o?.text_blocks ?? []);

  // Phase C 意图理解：手写批注 → VLM 读手写 + 判「为什么写」（疑问/命令/关联/记想法），据此路由推理
  let finalModes = modes;
  let finalIntent = intent ?? '';
  if (evt.event_type === 'margin_note') {
    const crop = grabRegion(evt.geometry.bbox, 0.02);
    if (crop) {
      try {
        const resp = await fetch('/api/interpret', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: crop }),
        });
        if (resp.ok) {
          const r = await resp.json();
          if (r?.reading) structured = `〔批注〕"${String(r.reading).slice(0, 80)}"${structured ? '  ' + structured : ''}`;
          const im = (INTENT_MODES as Record<string, OutputMode[]>)[r?.intent];
          if (im) { finalModes = im; finalIntent = String(r.intent); }
        }
      } catch { /* 解读失败 → 退回几何意图 */ }
    }
  }

  let result: InferenceResult;
  let memoryPages = 0;
  let hasImage = false;
  try {
    // Tier2：附带前页记忆快照，让模型按需 recall（见 server/infer agentLoop）；契约不变，memory 是 proxy 级附加
    const req = buildRequest(evt, { text_blocks: allBlocks, nearby_text: structured || null }, finalModes) as InferenceRequest & { memory?: unknown; image?: string };
    req.memory = memorySnapshot(evt.page_id);
    memoryPages = Array.isArray(req.memory) ? req.memory.length : 0;
    trace('InferenceRequest(disc)', req as unknown as Record<string, unknown>); // 此时尚未挂 image，trace 不被 base64 撑大
    // 转写+图：当这簇手势的 OCR 实际走了 VLM（runtime=cloud_fallback）才把截图带给推理做底图——
    // 图像模式是整页图就给整页、局部图就给那一块；数字版命中 textlayer 则不带图，省 token。
    if (ocrs.some((o) => o?.runtime === 'cloud_fallback')) {
      const img = settings.ocr.image === 'page' ? grabPage() : grabRegion(evt.geometry.bbox, 0.03);
      if (img) { req.image = img; hasImage = true; }
    }
    result = await inferProviders[state.inferProvider](req);
    trace('InferenceResult(disc)', result as unknown as Record<string, unknown>);
  } catch (err) {
    result = errorResult(evt, err);
    trace('InferenceResult(error)', result as unknown as Record<string, unknown>);
  }

  // 上下文监控：记一条「这次喂了什么、模型回了什么」
  const dbg = result as unknown as { _debug?: Record<string, unknown>; recalled?: number[] };
  pushInspect({
    ts: new Date().toISOString(),
    pageIndex: state.pageIndex,
    gesture: evt.event_type,
    intent: finalIntent,
    modes: finalModes,
    nearby: structured,
    ocrTexts: allBlocks.map((b) => b.text),
    memoryPages,
    hasImage,
    debug: dbg._debug ?? null,
    resultType: result.result_type,
    content: result.content,
    confidence: result.confidence,
    recalled: dbg.recalled ?? [],
    model: result.model_name,
  });

  // upsert by discId：移除同一讨论的上一条，原地换最新一条
  const prev = state.overlays.find((o) => o.overlay_id === discId);
  if (prev) {
    state.overlays = state.overlays.filter((o) => o !== prev);
    bus.emit('overlay:remove', discId);
  }
  const overlay = buildOverlay(result, evt);
  overlay.overlay_id = discId;
  overlay.geometry = { anchor_bbox: evt.geometry.bbox }; // 锚到这簇手势，留白里按其 y 对齐
  trace('ScreenOverlay(disc)', overlay as unknown as Record<string, unknown>);
  state.overlays.push(overlay);
  bus.emit('overlay:add', overlay);
  // 记入逐页记忆（按 discId upsert），供翻页总结与跨页综合
  recordMark(evt.page_id, state.pageIndex, {
    discId,
    gesture: evt.event_type,
    text: parts.map((p) => p.text).filter(Boolean).join(' '),
    note: result.content,
  });
  const pm = getMemory(evt.page_id); // 写穿持久化（记忆B 更新即落盘）
  if (pm) putMemory(pm.index, { content: pm.content, activity: pm.summary, marks: pm.marks });
  mark('total', performance.now() - penUpAt);
}

/** 翻页时把上一页的标注记忆压成一句摘要，存进记忆供后续跨页综合。 */
export async function summarizePage(pageId: string): Promise<void> {
  const marks = pageMarks(pageId);
  if (!marks.length) return;
  try {
    const resp = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marks }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data?.summary) {
      setSummary(pageId, String(data.summary).trim());
      const pm = getMemory(pageId); // 写穿持久化（记忆B 摘要）
      if (pm) putMemory(pm.index, { content: pm.content, activity: pm.summary, marks: pm.marks });
    }
  } catch { /* 总结失败不影响主流程 */ }
}
