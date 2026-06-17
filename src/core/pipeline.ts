import type { AnnotationEvent, EventType, HMP, InferenceRequest, InferenceResult, NormBBox, OCRResult, OutputMode, ScreenOverlay, SurfaceIndex, SurfaceObject } from './contracts';
import { RESULT_TO_OVERLAY, SCHEMA_VERSION } from './contracts';
import { DEVICE_ID, SESSION_ID, shortId } from './ids';
import { bboxOf, classify, markShapeOf } from './classify';
import { resolveTarget, buildHmp } from './target';
import { mark } from './metrics';
import { trace } from './trace';
import { bus, settings, state, type Stroke } from '../app/state';
import { grabLayers, grabRegion } from '../providers/ocr';
import { pageText } from './focus';
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

/**
 * HMP 异步增益（徐智强 step⑤/⑥）：几何 HMP 产出后，按需补取证线索，回来 mutate 同一条 HMP 并 re-emit。
 *  · step⑤ 局部 OCR 兜底：命中图区 / 无文字对象 → 裁 crop → /api/ocr-vlm（Kimi 视觉，云端替本地 OCR）。
 *  · step⑥ self_content：空白手写 → 白底笔迹图 → /api/interpret（Kimi 读手写）。
 * 失败一律静默，不连累主推理闭环。
 */
async function enrichHmp(hmp: HMP, evt: AnnotationEvent, targets: SurfaceObject[], inkData?: string): Promise<void> {
  // step⑤：命中图区或无文字的内容对象（如 embedded_image），结构里拿不到字 → 局部 OCR
  const needsOcr = hmp.mode !== 'self_content'
    && targets.some((o) => o.type === 'image' || (o.type !== 'blank_region' && !o.text));
  if (needsOcr && !hmp.text_hint) {
    const crop = grabRegion(evt.geometry.bbox, 0.04);
    if (crop) {
      hmp.crop_ref = crop;
      try {
        const r = await fetch('/api/ocr-vlm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: crop, model: settings.inferModel }) });
        if (r.ok) {
          const t = String((await r.json())?.text || '').trim();
          if (t) {
            hmp.text_hint = t;
            if (hmp.mode === 'unknown') hmp.mode = 'anchored';
            hmp.confidence = Math.max(hmp.confidence, 0.7);
            trace('HMP:ocrFallback', { hmp_id: hmp.hmp_id, text_hint: t.slice(0, 60) });
            bus.emit('hmp:updated', hmp);
          }
        }
      } catch { /* 兜底失败不连累闭环 */ }
    }
  }

  // step⑥：空白里自己写画 → 笔迹本身是内容，读手写
  if (hmp.mode === 'self_content' && inkData) {
    hmp.vector_ref = inkData; // 矢量证据先留（preReading 已填 text_hint 时也保留）
    if (!hmp.text_hint) {
      try {
        const r = await fetch('/api/interpret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: inkData, model: settings.inferModel }) });
        if (r.ok) {
          const reading = String((await r.json())?.reading || '').trim();
          if (reading) {
            hmp.text_hint = reading;
            trace('HMP:selfContent', { hmp_id: hmp.hmp_id, reading: reading.slice(0, 60) });
            bus.emit('hmp:updated', hmp);
          }
        }
      } catch { /* 失败静默 */ }
    }
  }
}

/**
 * 从 HMP 取证记录装配"标注命中了什么"——替掉旧的 focusHint 几何拼装，让"标注→理解"真正由 HMP 驱动。
 *  anchored/mixed：命中对象的原文 +（图区 OCR 读出的字）；self_content：手写读出的内容。
 *  圈在对象内部的精确落点由合成图(crop_ref)承载，这里只交"文字事实"。
 */
function hmpFocus(hmp: HMP, index: SurfaceIndex | null, preReading?: string): string {
  const refs = new Set(hmp.target_object_refs);
  // 命中对象按 target_object_refs 顺序（resolveTarget 已按阅读序排好）取文字，字母级直接拼回原文（无空格）。
  const objs = (index?.objects ?? []).filter((o) => refs.has(o.id));
  const targetText = objs.map((o) => o.text).filter(Boolean).join('').trim();
  const hint = (hmp.text_hint || preReading || '').trim();
  if (hmp.mode === 'self_content') return hint ? `手写「${hint}」` : '';
  if (targetText && hint && hint !== targetText) return `${targetText} · 读出「${hint}」`;
  return targetText || (hint ? `读出「${hint}」` : '');
}

/**
 * dev-only：把完整 HMP 取证记录镜像到服务端调试通道（/api/__debug/event, kind='hmp'）。
 * 去掉 crop/vector 的 base64（只留是否存在），并把 target_object_refs 解析成原文——
 * 让"开发者侧的 Claude"不进浏览器也能逐字段核对采集的完整性/准确性。
 */
function mirrorHmp(hmp: HMP): void {
  if (!(import.meta as { env?: { DEV?: boolean } }).env?.DEV) return;
  try {
    const objs = state.surfaceIndex?.objects ?? [];
    const targets = hmp.target_object_refs.map((id) => {
      const o = objs.find((x) => x.id === id);
      return o ? { id: o.id, type: o.type, role: o.role ?? null, text: o.text ?? null } : { id, missing: true };
    });
    const slim = {
      kind: 'hmp',
      ts: new Date().toISOString(),
      hmp_id: hmp.hmp_id,
      surface_id: hmp.surface_id,
      surface_type: state.surfaceIndex?.surface_type ?? null,
      mode: hmp.mode,
      action: hmp.action,
      object_hint: hmp.object_hint,
      target_region: hmp.target_region.map((n) => +n.toFixed(4)),
      target_object_refs: hmp.target_object_refs,
      targets, // 解析出原文，便于核对准确性
      text_hint: hmp.text_hint ?? null,
      has_crop: !!hmp.crop_ref,
      has_vector: !!hmp.vector_ref,
      confidence: hmp.confidence,
      version: hmp.version,
    };
    void fetch('/api/__debug/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(slim) }).catch(() => { /* dev sink 不在/出错都无所谓 */ });
  } catch { /* 取值出错不连累 UI */ }
}

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
  /** VLM 路径已读到的手写文字（margin_note 时优先用它，跳过 /api/interpret 二次调用）。 */
  preReading?: string,
): Promise<void> {
  if (!events.length) return;
  const evt = representative(events);
  evt.trace_id = shortId('disc');
  if (eventType) evt.event_type = eventType; // 单手势时写 canonical 类型，服务端据此框定语气

  // 徐智强取证线驱动「标注 → 理解」：先产 HMP，await 取证增益(step⑤OCR/step⑥手写)把 text_hint 等齐，
  // 再从 HMP 装配理解输入（命中原文 + 读出的字）。整页文字 pgText 仍作恒定上下文，合成图承载"圈在哪"的精度。
  const layers = grabLayers(evt.geometry.bbox, 0.04);
  const composite = layers.composite; // 监控缩略图 / 兼容字段仍用合成图
  const pgText = pageText();
  const finalModes = modes;
  const finalIntent = intent ?? '';

  let hmp: HMP | null = null;
  if (state.surfaceIndex) {
    const action = markShapeOf(evt.event_type);
    const targets = resolveTarget(events, evt.geometry.bbox, state.surfaceIndex);
    hmp = buildHmp({
      surfaceId: state.surfaceIndex.surface_id,
      action,
      targetBbox: evt.geometry.bbox,
      targetObjects: targets,
      cropRef: layers.composite,
      vectorRef: evt.event_type === 'margin_note' ? layers.ink : undefined,
    });
    // VLM 路径已读到的手写(preReading) 直接作 text_hint，enrichHmp 据此跳过重复的 /api/interpret
    if (preReading && hmp.mode === 'self_content' && !hmp.text_hint) hmp.text_hint = preReading;
    state.lastHmps.unshift(hmp);
    if (state.lastHmps.length > 10) state.lastHmps.length = 10;
    trace('HMP', hmp as unknown as Record<string, unknown>);
    bus.emit('hmp:updated', hmp);
    await enrichHmp(hmp, evt, targets, layers.ink); // 喂理解前把 OCR/手写的 text_hint 等齐
    mirrorHmp(hmp); // 取证完成 → 镜像到 dev 通道，供开发者侧逐字段核对
  }

  // 标注内容来源 = HMP 取证记录（替掉旧的 focusHint 几何拼装）
  const focusStr = hmp ? hmpFocus(hmp, state.surfaceIndex, preReading) : '';

  // 合成图改成**仅兜底才发**（徐方案里它就是"拿不到文字时的视觉证据"）：有文字事实(focusStr 非空)就纯吃事实、不发图。
  // focusStr 为空时，只在"有东西可看"——命中图区但 OCR 没读出(object_hint=image_region) 或 空白手写(self_content)——才发图；
  // 纯空白没命中(unknown/refs空)不发图，让模型走"没对到内容"的诚实兜底，别拿白图瞎编。dev 可强制 sendMarkImage。
  const sendImg = settings.sendMarkImage
    || (!focusStr && hmp != null && (hmp.object_hint === 'image_region' || hmp.mode === 'self_content'));
  const wantInk = hmp?.mode === 'self_content' || evt.event_type === 'margin_note';
  const images: Array<{ role: 'ink' | 'composite'; data: string }> = [];
  if (sendImg) {
    if (wantInk && layers.ink) images.push({ role: 'ink', data: layers.ink });
    if (layers.composite) images.push({ role: 'composite', data: layers.composite });
  }

  let result: InferenceResult;
  let memoryPages = 0;
  let hasImage = false;
  try {
    if (settings.inferEngine === 'session' && state.documentId) {
      // P3 会话引擎:一本书一个长驻 Agent SDK 会话,记得本书前文(替代 memorySnapshot)。
      // 合成图放在 user message(可缓存、不进 tool_result,避开 SDK lift 缓存陷阱)。
      hasImage = images.length > 0;
      trace('InferenceRequest(disc)', { engine: 'session', page_id: evt.page_id, gesture: evt.event_type, focus: focusStr, page_text_len: pgText.length, image_count: images.length } as unknown as Record<string, unknown>);
      const r = await fetch('/api/agent/turn', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bookId: state.documentId, pageIndex: state.pageIndex, gestureType: evt.event_type, intent: finalIntent, pageText: pgText, focus: focusStr, image: sendImg ? composite : undefined, images, modes: finalModes, model: settings.inferModel, thinking: settings.thinking }),
      }).then((x) => x.json());
      if (r?.error) throw new Error(String(r.error));
      result = {
        result_id: shortId('res'), trace_id: evt.trace_id, request_id: 'agent',
        result_type: (finalModes.includes(r.result_type) ? r.result_type : finalModes[0]) as InferenceResult['result_type'],
        content: String(r.content || '此刻没能想清楚，稍后再为你低语。').trim(),
        source_refs: [{ page_id: evt.page_id, bbox: evt.geometry.bbox, ocr_block_ids: [], event_id: evt.event_id }],
        confidence: typeof r.confidence === 'number' ? r.confidence : 0.8,
        created_at: new Date().toISOString(), model_name: (r?._meta?.model as string) || settings.inferModel, model_version: 'agent-session',
      };
      (result as unknown as { _debug?: unknown })._debug = { mode: 'agent-session', focus: focusStr, page_text_len: pgText.length, has_image: hasImage, ms: r?._meta?.ms, cost: r?._meta?.cost };
      trace('InferenceResult(disc)', result as unknown as Record<string, unknown>);
    } else {
      // P1 无状态:每标注一次 /api/infer。page_text/focus/image 为 proxy 级 wire 附加(不动冻结契约 D4)
      const req = buildRequest(evt, { text_blocks: [], nearby_text: focusStr || null }, finalModes) as InferenceRequest & { memory?: unknown; image?: string; images?: Array<{ role: string; data: string }>; page_text?: string; focus?: string; model?: string; intent?: string };
      req.page_text = pgText;
      req.focus = focusStr;
      req.intent = finalIntent;
      req.model = settings.inferModel;
      req.memory = memorySnapshot(evt.page_id);
      memoryPages = Array.isArray(req.memory) ? req.memory.length : 0;
      trace('InferenceRequest(disc)', req as unknown as Record<string, unknown>); // 此时尚未挂 image，trace 不被 base64 撑大
      if (images.length) { req.images = images; req.image = composite; hasImage = true; }
      result = await inferProviders[state.inferProvider](req);
      trace('InferenceResult(disc)', result as unknown as Record<string, unknown>);
    }
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
    nearby: focusStr,
    ocrTexts: [],
    memoryPages,
    hasImage,
    composite: sendImg ? composite : undefined, // 没送图就不在监控里冒充"模型看到的图"
    images,
    bbox: evt.geometry.bbox,
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
    text: focusStr,
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
