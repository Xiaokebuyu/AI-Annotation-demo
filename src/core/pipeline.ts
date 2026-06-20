import type { AnnotationEvent, EventType, HMP, InferenceRequest, InferenceResult, InferenceView, MarkFeatureType, MarkShape, NormBBox, OCRResult, OutputMode, ScreenOverlay, SurfaceIndex, SurfaceObject } from './contracts';
import { RESULT_TO_OVERLAY, SCHEMA_VERSION } from './contracts';
import { DEVICE_ID, SESSION_ID, shortId, sha256Hex } from './ids';
import { appendAiTurnEntry, setSynthesisWatermark } from '../local/store';
import { bboxOf, classify, markShapeOf, type StrokeFeature } from '../capture/classify';
import { resolveTarget, buildHmp } from '../evidence/target';
import { buildMarkGraph } from '../evidence/mark-graph';
import { projectInferenceView } from '../evidence/inference-view';
import type { Mark, Session } from '../capture/session';
import { mark } from './metrics';
import { trace } from './trace';
import { bus, settings, state, type Stroke } from '../app/state';
import { grabLayers, grabRegion } from '../evidence/ocr';
import { pageText, blocksToText } from '../evidence/focus';
import { extractPageBlocks } from '../surface/renderer';
import { pushInspect } from './inspect';
import { chatTurn } from '../chat/stream-client';
import { openBook, bookMessages } from '../chat/buffer';
import { classifyContext } from '../chat/classify-client';

/** 旁注人格（网页对话式·替代退役 session 的伴读 persona）。buffer 给跨标注连贯，需要时呼应本书前文。 */
const CHAT_SYSTEM =
  '你是 InkLoop —— 嵌在阅读器里的旁注式 AI 同读者。读者在原文上用符号（圈/划/箭头/手写等）连续标注，你只用简短中文旁注回应。' +
  '有时你收到读者这一阵连续标注的整段脉络——综合它给一条贯穿性的旁注，紧扣这些标注、按它们的顺序与关系理解、别逐条复述、别脱开去谈整页大主题。' +
  '有时你收到读者手写的一个问题——直接回答它、扣住所写、不要反问。' +
  '有时随回复附一张截图（你圈/划/写处的图）——给了图就结合图作答。' +
  '不寒暄、不复述原文、不用 markdown 或列表、至多 2–3 句，像页边批注点到为止。' +
  '上文里有读者在这本书前面留下的标注与你的回应——需要时自然呼应，但别强行联系。';
const GVERB: Record<string, string> = {
  circle: '圈选', underline: '划线', highlight: '高亮', arrow: '画箭头标', margin_note: '手写批注', tap_region: '点选', stroke: '标记',
};

/** CHAT_SYSTEM 指纹（ai_turn 存 system_prompt_hash，便于日后 prompt 变更后审计/复现）。模块加载即算。 */
const SYS_HASH_P: Promise<string> = sha256Hex(new TextEncoder().encode(CHAT_SYSTEM).buffer as ArrayBuffer)
  .then((h) => h.slice(0, 8)).catch(() => '');

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
async function enrichHmp(hmp: HMP, evt: AnnotationEvent, targets: SurfaceObject[]): Promise<void> {
  // step⑤：命中图区或无文字的内容对象（如 embedded_image），结构里拿不到字 → 局部 OCR 兜底。
  // （freeform 的"手写 vs 画 + 转写"已在 captureMark 由识别裁判，不在此处理。）
  const needsOcr = hmp.mode !== 'self_content'
    && targets.some((o) => o.type === 'image' || (o.type !== 'blank_region' && !o.text));
  if (!needsOcr || hmp.text_hint) return;
  const crop = grabRegion(evt.geometry.bbox, 0.04);
  if (!crop) return;
  hmp.crop_ref = crop;
  try {
    const r = await fetch('/api/ocr-vlm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: crop, model: settings.inferModel }) });
    if (r.ok) {
      const t = String((await r.json())?.text || '').trim();
      if (t) {
        hmp.text_hint = t; // 识别只补内容，不改 mode/类型
        hmp.confidence = Math.max(hmp.confidence, 0.7);
        trace('HMP:ocrFallback', { hmp_id: hmp.hmp_id, text_hint: t.slice(0, 60) });
        bus.emit('hmp:updated', hmp);
      }
    }
  } catch { /* 兜底失败不连累闭环 */ }
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
    await enrichHmp(hmp, evt, targets); // 图区 OCR 兜底（reader stub 路径；freeform 转写不在此处）
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
  const bookId = state.documentId ?? 'book';
  try {
    // v3 合龙①②：理解走每本书有状态 chat buffer（流式），回应实时落 anchor-layer（页内按 HMP 锚点）。
    // 收尾清掉流式预览，交给持久 overlay（whisper 页 / reader 重排 / insight 卡片 / 记忆）。
    openBook(bookId);
    const marked = (hmp?.text_hint || focusStr || '').trim() || '（未提取到文字）';
    const verb = GVERB[evt.event_type] ?? '标注';
    const ask = finalIntent === 'question' ? '读者像在发问：针对所标处直接作答，不要反问。'
      : finalIntent === 'command' ? '读者写的是一条指令（如总结/翻译/改写）：直接作用在所标处、给结果而非评论。'
      : finalModes.includes('summary') ? '读者在这一处留了多个标注：综合它们给一条整体性的洞察或提示。'
      : '解释所标处是什么、关键在哪，或顺着它点一句——但始终扣住所标这几个字。';
    // 先把"所标处"摆在最前、最重；整页文字仅作消歧上下文放在后面、压短，免得模型跑题到整页主题。
    const ctx = pgText ? `\n\n（仅供消歧的本页上下文，别据此跑题到整页主题）：${pgText.slice(0, 700)}` : '';
    const userContent = `读者在原文上${verb}了这一处：「${marked}」。${ask}${ctx}`;
    const anchorRefs = hmp?.target_object_refs ?? [];
    trace('InferenceRequest(disc)', { mode: 'chat-buffer', page_id: evt.page_id, gesture: evt.event_type, intent: finalIntent, marked: marked.slice(0, 60), buffer_turns: bookMessages(bookId).length } as unknown as Record<string, unknown>);
    const full = await chatTurn(bookId, userContent, {
      system: CHAT_SYSTEM, model: settings.inferModel,
      onDelta: (t) => bus.emit('anchor:place', { id: discId, pageId: evt.page_id, anchorRefs, bbox: evt.geometry.bbox, text: t, kind: 'note' }),
    });
    bus.emit('anchor:clear', discId); // 流式预览结束 → 持久 overlay 接手
    memoryPages = bookMessages(bookId).length;
    result = {
      result_id: shortId('res'), trace_id: evt.trace_id, request_id: 'chat',
      result_type: finalModes[0] as InferenceResult['result_type'],
      content: full || '此刻没能想清楚，稍后再为你低语。',
      source_refs: [{ page_id: evt.page_id, bbox: evt.geometry.bbox, ocr_block_ids: [], event_id: evt.event_id }],
      confidence: 0.8, created_at: new Date().toISOString(), model_name: settings.inferModel, model_version: 'chat-buffer',
    };
    (result as unknown as { _debug?: unknown })._debug = { mode: 'chat-buffer', focus: focusStr, page_text_len: pgText.length, has_image: false, buffer_turns: memoryPages };
    trace('InferenceResult(disc)', result as unknown as Record<string, unknown>);
  } catch (err) {
    bus.emit('anchor:clear', discId);
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
  mark('total', performance.now() - penUpAt);
}

/* ──────────────────────────────────────────────────────────────────────────
 * v3 会话流：mark 落笔即取证(captureMark) → 累积成 session → 长停顿/手写触发
 * 时建标注图 + 蒸馏 inference-view → 主模型回应。语义全交模型（无形状→意图映射）。
 * ────────────────────────────────────────────────────────────────────────── */

/** dev-only：把上下文分类器的 respond/fold 决策镜像到调试通道（kind='classify'）。 */
function mirrorClassify(o: { respond: boolean; reason: string; question: string; discId: string }): void {
  if (!(import.meta as { env?: { DEV?: boolean } }).env?.DEV) return;
  void fetch('/api/__debug/event', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'classify', ts: new Date().toISOString(), ...o }),
  }).catch(() => { /* dev sink 不在/出错都无所谓 */ });
}

/** dev-only：把蒸馏出的 inference-view（喂模型的精简载荷）镜像到调试通道（kind='inferview'）。 */
function mirrorView(view: InferenceView, reason: string, discId: string): void {
  if (!(import.meta as { env?: { DEV?: boolean } }).env?.DEV) return;
  void fetch('/api/__debug/event', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'inferview', ts: new Date().toISOString(), discId, trigger: reason,
      narrative: view.narrative, marked: view.marked, question: view.question ?? null,
      anchor_refs: view.anchor_refs, has_crop: !!view.crop, page_ctx_len: view.page_context?.length ?? 0,
    }),
  }).catch(() => { /* dev sink 不在/出错都无所谓 */ });
}

/** 形状/特征 → MarkShape：手写/画由特征定，其余按几何 EventType。 */
function markActionOf(feature: MarkFeatureType, eventType: EventType, score: number): MarkShape {
  if (feature === 'handwriting') return 'handwriting';
  if (feature === 'drawing') return 'sketch';
  return markShapeOf(eventType, score);
}

/** 从 HMP + 当前页 index 解析"所标内容"（结构原文 + 转写）的原始文字。 */
function resolveMarkedText(hmp: HMP, index: SurfaceIndex): string {
  const refs = new Set(hmp.target_object_refs);
  const objs = index.objects.filter((o) => refs.has(o.id));
  const targetText = objs.map((o) => o.text).filter(Boolean).join('').trim();
  const hint = (hmp.text_hint || '').trim();
  if (hmp.mode === 'self_content') return hint;
  if (targetText && hint && hint !== targetText) return `${targetText}（读出「${hint}」）`;
  return targetText || hint;
}

/** 云端识别当类型分类器（context-free）：读这团墨是不是文字 → kind + 转写。失败默认 none。 */
async function recognizeInk(inkData: string): Promise<{ kind: string; reading: string }> {
  try {
    const r = await fetch('/api/interpret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: inkData, model: settings.inferModel }) });
    if (!r.ok) return { kind: 'none', reading: '' };
    const j = await r.json() as { kind?: string; reading?: string };
    return { kind: String(j.kind || 'none'), reading: String(j.reading || '').trim() };
  } catch { return { kind: 'none', reading: '' }; }
}

/**
 * 落笔当时（该页仍是当前页）就建好这个 mark 的 HMP + 定型 + 解析所标文字。
 * 跨页 session 提交时画布已是别页、无法重取，故必须在此刻捕获并随 mark 存下。
 *   · markup（圈/划/箭头）：几何已定型，所标内容取自结构层（命中字）。
 *   · freeform：云端识别裁判 handwriting/drawing（"手写 vs 画"无几何模板），结果写进 HMP + 返回最终 feature。
 * 返回 resolved feature（freeform 经识别定型后的真实类型）。
 */
export async function captureMark(
  event: AnnotationEvent, feature: StrokeFeature, score: number,
): Promise<{ hmp: HMP | null; markedText: string; feature: StrokeFeature }> {
  const index = state.surfaceIndex;
  if (!index || event.page_id !== index.surface_id) return { hmp: null, markedText: '', feature };
  const targets = resolveTarget([event], event.geometry.bbox, index);
  const layers = grabLayers(event.geometry.bbox, 0.04);

  // freeform 且几何门判 ocrWorthy（非散笔/线条）→ 识别定型（handwriting/drawing）+ 读出文字。
  // 不值得（单笔近直线/太小）→ 跳过识别、留 drawing，省调用、也避免把线条误转写成字。
  let resolved = feature;
  let textHint: string | undefined;
  if (feature.type !== 'markup' && feature.raw.ocrWorthy && layers.ink) {
    const r = await recognizeInk(layers.ink);
    const isText = r.kind === 'handwriting' || r.kind === 'mixed';
    resolved = { ...feature, type: isText ? 'handwriting' : 'drawing', confidence: r.kind === 'none' ? 0.3 : 0.85 };
    textHint = r.reading || undefined;
  }
  const action = markActionOf(resolved.type, event.event_type, score);
  // markup 锚它所标的内容；freeform（手写/画）属 self_content——它本身就是内容，不锚到 bbox 碰巧蹭到的正文
  // （手写跟正文的位置关系靠叙事里同时出现的圈/划来带，避免"误锚正文→模型幻觉"）。
  const hmpTargets = resolved.type === 'markup' ? targets : [];
  const hmp = buildHmp({
    surfaceId: index.surface_id, action, targetBbox: event.geometry.bbox,
    targetObjects: hmpTargets, cropRef: layers.composite,
    vectorRef: resolved.type !== 'markup' ? layers.ink : undefined,
    textHint,
  });
  state.lastHmps.unshift(hmp);
  if (state.lastHmps.length > 10) state.lastHmps.length = 10;
  trace('HMP', hmp as unknown as Record<string, unknown>);
  bus.emit('hmp:updated', hmp);
  await enrichHmp(hmp, event, targets); // 仅图区 OCR 兜底（freeform 转写已在上面完成）
  mirrorHmp(hmp);
  return { hmp, markedText: resolveMarkedText(hmp, index), feature: resolved };
}

/** 把 inference-view 渲染成喂模型的 user turn：idle=整段综合 / handwriting=定向答问。 */
function renderUserTurn(view: ReturnType<typeof projectInferenceView>): string {
  const ctx = view.page_context ? `\n\n（仅供消歧的本页上下文，别据此跑题到整页主题）：${view.page_context}` : '';
  if (view.trigger === 'handwriting') {
    return `读者手写问：「${view.question || view.marked}」。相关标注脉络：${view.narrative}。直接作答、扣住所写，不要反问。${ctx}`;
  }
  return `读者这一阵连续标注的脉络：${view.narrative}。所标内容：「${view.marked || '（未提取到文字）'}」。综合整段脉络给一条贯穿性的旁注，按标注的顺序与关系理解，别逐条复述。${ctx}`;
}

/**
 * 会话提交：建标注图 → 蒸馏 inference-view → 主模型流式回应 → 落 anchor + overlay。
 * 返回是否真的回应了（idle 恒 true；handwriting 经分类器，fold 返回 false——分类器在 Phase D 接）。
 */
// 任意页文字（按 docId+页号缓存；页内容不变，无需失效）。
const pageTextCache = new Map<string, string>();
async function pageTextAt(i: number): Promise<string> {
  if (i < 0 || i >= state.pageCount) return '';
  const key = `${state.documentId}_${i}`;
  const hit = pageTextCache.get(key);
  if (hit !== undefined) return hit;
  try { const t = blocksToText(await extractPageBlocks(i)); pageTextCache.set(key, t); return t; }
  catch { return ''; }
}
/** 以当前页为中心、向前向后凑总长 ~maxChars 的滑动内容窗口（喂模型作上下文）。 */
async function slidingContext(maxChars = 3000): Promise<string> {
  const cur = pageText(maxChars); // 当前页全文（已渲染的 state.textBlocks）
  if (cur.length >= maxChars) return cur;
  const budget = maxChars - cur.length;
  const i = state.pageIndex;
  const prev = await pageTextAt(i - 1);
  const next = await pageTextAt(i + 1);
  const half = Math.floor(budget / 2);
  const prevTail = prev.slice(Math.max(0, prev.length - half));
  const nextHead = next.slice(0, budget - prevTail.length);
  return [prevTail, cur, nextHead].filter(Boolean).join('\n');
}

export async function commitSessionDiscussion(
  session: Session, reason: 'idle' | 'handwriting', triggerMark: Mark | undefined, discId: string,
): Promise<boolean> {
  const marks = session.marks;
  if (!marks.length) return false;
  const graph = buildMarkGraph(marks, marks.map((m) => m.hmp));
  bus.emit('graph:built', graph); // dev：关联框可视（按非时间边连通分量框住成组标注）
  const anchorMark = (reason === 'handwriting' && triggerMark) ? triggerMark : marks[marks.length - 1];

  // crop 仅兜底：锚点 mark 没解析出文字、但有图可看（图区 OCR 没读出 / 空白手写）才带图（dev 显示用）
  let crop: { role: 'ink' | 'composite'; data: string } | undefined;
  const ah = anchorMark.hmp;
  if (settings.sendMarkImage || (!anchorMark.markedText.trim() && ah && (ah.object_hint === 'image_region' || ah.mode === 'self_content'))) {
    if (ah?.mode === 'self_content' && ah.vector_ref) crop = { role: 'ink', data: ah.vector_ref };
    else if (ah?.crop_ref) crop = { role: 'composite', data: ah.crop_ref };
  }

  const view = projectInferenceView(graph, {
    trigger: reason,
    pageText: await slidingContext(3000), // 以当前页为中心、前后共 ~3000 字滑动窗
    question: reason === 'handwriting' ? (triggerMark?.markedText || '') : undefined,
    crop,
    anchorMarkId: anchorMark.id,
  });
  mirrorView(view, reason, discId); // dev 通道：喂模型前的精简载荷可离线核对

  const bookId = session.bookId;
  // handwriting 路：上下文分类器判 respond/fold（带同源 inference-view + 对话历史）。
  // fold = 写给自己的笔记 → 静默、不落 overlay、mark 留 session（计入下次综合）。
  if (reason === 'handwriting') {
    const decision = await classifyContext(view, bookMessages(bookId));
    trace('ClassifyContext', { respond: decision.respond, reason: decision.reason, question: view.question ?? '' });
    mirrorClassify({ respond: decision.respond, reason: decision.reason, question: view.question ?? '', discId });
    if (!decision.respond) return false;
  }
  openBook(bookId);
  const userContent = renderUserTurn(view);
  const pageId = view.page_id || anchorMark.event.page_id;
  const anchorRefs = view.anchor_refs;

  let result: InferenceResult;
  try {
    const full = await chatTurn(bookId, userContent, {
      system: CHAT_SYSTEM, model: settings.inferModel,
      maxTokens: reason === 'idle' ? 600 : 400,
      images: view.crop ? [{ data: view.crop.data }] : [], // 被判需图片识别的内容：把合成图/笔迹图送进主推理
      onDelta: (t) => bus.emit('anchor:place', { id: discId, pageId, anchorRefs, bbox: view.anchor_bbox, text: t, kind: 'note' }),
    });
    bus.emit('anchor:clear', discId);
    result = {
      result_id: shortId('res'), trace_id: shortId('disc'), request_id: 'chat',
      result_type: 'inspiration',
      content: full || '此刻没能想清楚，稍后再为你低语。',
      source_refs: [{ page_id: pageId, bbox: view.anchor_bbox, ocr_block_ids: [], event_id: anchorMark.id }],
      confidence: 0.8, created_at: new Date().toISOString(), model_name: settings.inferModel, model_version: 'chat-session',
    };
    (result as unknown as { _debug?: unknown })._debug = { mode: 'chat-session', trigger: reason, narrative: view.narrative, marked: view.marked, buffer_turns: bookMessages(bookId).length };
    trace('InferenceResult(session)', result as unknown as Record<string, unknown>);
  } catch (err) {
    bus.emit('anchor:clear', discId);
    result = errorResult(anchorMark.event, err);
  }

  pushInspect({
    ts: new Date().toISOString(), pageIndex: state.pageIndex,
    gesture: anchorMark.event.event_type, intent: reason, modes: [],
    nearby: view.marked, ocrTexts: [], memoryPages: bookMessages(bookId).length,
    hasImage: !!view.crop, composite: view.crop?.data, images: view.crop ? [view.crop] : [],
    bbox: view.anchor_bbox, debug: (result as unknown as { _debug?: Record<string, unknown> })._debug ?? null,
    resultType: result.result_type, content: result.content, confidence: result.confidence, recalled: [], model: result.model_name,
  });

  // upsert overlay by discId
  const prev = state.overlays.find((o) => o.overlay_id === discId);
  if (prev) { state.overlays = state.overlays.filter((o) => o !== prev); bus.emit('overlay:remove', discId); }
  const overlay = buildOverlay(result, anchorMark.event);
  overlay.overlay_id = discId;
  overlay.geometry = { anchor_bbox: view.anchor_bbox };
  state.overlays.push(overlay);
  bus.emit('overlay:add', overlay);

  // 落账本：ai_turn 进书日志（显示快照 + 锚点 + view 快照[crop 剥] + provenance）；并推综合水位线
  await appendAiTurnEntry({
    document_id: bookId, page_id: pageId, page_index: state.pageIndex,
    overlay_id: discId, overlay, overlay_state: 'shown', user_edited_text: null,
    ai_reply: result.content,
    anchor: { surface_id: view.page_id, mark_ids: marks.map((m) => m.id), object_refs: view.anchor_refs },
    inference_view: { ...view, crop: undefined }, // 存料不存图：crop 落库前剥掉
    prompt_snapshot: userContent,
    system_prompt_hash: await SYS_HASH_P,
    settings_snapshot: { inferModel: settings.inferModel, reflowProvider: settings.reflowProvider },
    trigger: reason, model: result.model_name, supersedes: null,
  });
  setSynthesisWatermark(); // 此前所有 mark 记为已综合；之后的新 mark = pending
  return true;
}
