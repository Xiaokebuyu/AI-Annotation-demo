import type { AnnotationEvent, EventType, HMP, InferenceResult, InferenceView, MarkFeatureType, MarkShape, NormBBox, PipelineStage, ScreenOverlay, SurfaceIndex, SurfaceObject } from './contracts';
import { RESULT_TO_OVERLAY, SCHEMA_VERSION } from './contracts';
import { DEVICE_ID, SESSION_ID, shortId } from './ids';
import { appendAiTurnEntry, getReflow, setSynthesisWatermark } from '../local/store';
import { bboxOf, classify, markShapeOf, type StrokeFeature } from '../capture/classify';
import { resolveTarget, buildHmp } from '../evidence/target';
import { buildMarkGraph } from '../evidence/mark-graph';
import { findSpatialRecall } from '../evidence/recall';
import { projectInferenceView } from '../evidence/inference-view';
import type { Mark, Session } from '../capture/session';
import { mark } from './metrics';
import { trace } from './trace';
import { bus, settings, state, type Stroke } from '../app/state';
import { grabLayers, grabRegion } from '../evidence/ocr';
import { pageText, blocksToText, linesInBand } from '../evidence/focus';
import { extractPageBlocks } from '../surface/renderer';
import { pushInspect } from './inspect';
import { chatTurn } from '../chat/stream-client';
import { openBook, bookMessages } from '../chat/buffer';
import { classifyContext } from '../chat/classify-client';
import { postJson } from './api';

/** 伴读 persona 已搬到服务端 server/prompts.ts（按 role 索引、与模型解耦）；/api/chat 收 role='annotator'。
 *  下面这个标签随账本存 system_prompt_hash，标识本轮提示词版本（与 server PROMPT_VERSION 对齐，改 system 文案时同步）。 */
const PROMPT_TAG = 'annotator@v2';

/* ── 处理流水线（调试）：逐组件「收到什么 → 产出什么」，含缩略图，串成一轮链路 ─────────
 * 仅 DEV 落库（gate 同 mirror*）；图压成 ~220px 缩略图控 IndexedDB 体积。供 AI 会话调试页复盘。 */
const DEV = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;

/** 缩略图：把 dataURL 压到长边 ≤max → JPEG（控存储体积）。失败/无图返回空串。 */
function thumb(dataUrl: string | undefined | null, max = 220): Promise<string> {
  if (!dataUrl) return Promise.resolve('');
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          cv.getContext('2d')!.drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', 0.6));
        } catch { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = dataUrl;
    } catch { resolve(''); }
  });
}

/** 一笔在流水线里的短标签（手写「…」/ 画「…」/ 标记「…」），逐 mark 阶段挂它。 */
function markTraceLabel(feature: MarkFeatureType, markedText: string): string {
  const t = (markedText || '').replace(/\s+/g, ' ').slice(0, 16);
  if (feature === 'handwriting') return `手写「${t || '…'}」`;
  if (feature === 'drawing') return `画${t ? `「${t}」` : '（无字）'}`;
  return `标记「${t || '—'}」`;
}


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
async function enrichHmp(hmp: HMP, evt: AnnotationEvent, targets: SurfaceObject[], pl?: PipelineStage[]): Promise<void> {
  // step⑤：命中图区或无文字的内容对象（如 embedded_image），结构里拿不到字 → 局部 OCR 兜底。
  // （freeform 的"手写 vs 画 + 转写"已在 captureMark 由识别裁判，不在此处理。）
  const needsOcr = hmp.mode !== 'self_content'
    && targets.some((o) => o.type === 'image' || (o.type !== 'blank_region' && !o.text));
  if (!needsOcr || hmp.text_hint) return;
  const crop = grabRegion(evt.geometry.bbox, 0.04);
  if (!crop) return;
  hmp.crop_ref = crop;
  try {
    let readOut = '';
    try {
      const j = await postJson<{ text?: string }>('/api/ocr-vlm', { image: crop, model: settings.inferModel });
      readOut = String(j?.text || '').trim();
    } catch { /* http/网络错 → readOut 留空，下方仍记 DEV 阶段 */ }
    if (readOut) {
      hmp.text_hint = readOut; // 识别只补内容，不改 mode/类型
      hmp.confidence = Math.max(hmp.confidence, 0.7);
      trace('HMP:ocrFallback', { hmp_id: hmp.hmp_id, text_hint: readOut.slice(0, 60) });
      bus.emit('hmp:updated', hmp);
    }
    if (pl && DEV) pl.push({
      stage: 'ocr_fallback', label: '图区 OCR 兜底 · /api/ocr-vlm', status: 'ran',
      note: '命中图区/无文字对象，结构层拿不到字 → 裁 crop 交云端视觉转写',
      input: [{ k: '模型', v: settings.inferModel }, { k: '输入', v: '标注区 crop 图' }],
      output: [{ k: '读出文字', v: readOut || '（未读出）' }],
      images: [{ role: 'crop（OCR 输入）', thumb: await thumb(crop) }].filter((x) => x.thumb),
    });
  } catch { /* 兜底失败不连累闭环 */ }
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

/** 云端识别当类型分类器（context-free）：读这团墨是不是文字 → kind + 转写 + 画的粗描述。失败默认 none。 */
async function recognizeInk(inkData: string): Promise<{ kind: string; reading: string; description: string }> {
  try {
    const j = await postJson<{ kind?: string; reading?: string; description?: string }>('/api/interpret', { image: inkData, model: settings.inferModel });
    return { kind: String(j.kind || 'none'), reading: String(j.reading || '').trim(), description: String(j.description || '').trim() };
  } catch { return { kind: 'none', reading: '', description: '' }; }
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
): Promise<{ hmp: HMP | null; markedText: string; feature: StrokeFeature; trace?: PipelineStage[] }> {
  const index = state.surfaceIndex;
  if (!index || event.page_id !== index.surface_id) return { hmp: null, markedText: '', feature };
  const targets = resolveTarget([event], event.geometry.bbox, index);
  const layers = grabLayers(event.geometry.bbox, 0.04);
  const pl: PipelineStage[] = []; // 这笔经手的组件阶段（识别/OCR兜底/取证），提交时拼进整轮流水线

  // freeform 且几何门判 ocrWorthy（非散笔/线条）→ 识别定型（handwriting/drawing）+ 读出文字。
  // 不值得（单笔近直线/太小）→ 跳过识别、留 drawing，省调用、也避免把线条误转写成字。
  let resolved = feature;
  let textHint: string | undefined;
  if (feature.type !== 'markup') {
    if (feature.raw.ocrWorthy && layers.ink) {
      const r = await recognizeInk(layers.ink);
      const isText = r.kind === 'handwriting' || r.kind === 'mixed';
      resolved = { ...feature, type: isText ? 'handwriting' : 'drawing', confidence: r.kind === 'none' ? 0.3 : 0.85 };
      // 文字→转写；画→粗描述（让画也带"内容"进 markedText/叙事/召回；意图仍交推理模型）。
      textHint = (isText ? r.reading : r.description) || undefined;
      if (DEV) pl.push({
        stage: 'recognize', label: '识别分类器 · /api/interpret', status: 'ran',
        note: '自由笔且过几何门(ocrWorthy)：判「手写 vs 画」、转写文字、给画一句粗描述（context-free，不看上下文、不揣测意图）',
        input: [{ k: '模型', v: settings.inferModel }, { k: '输入', v: '白底笔迹图 ink' }],
        output: [
          { k: '判定 kind', v: r.kind },
          { k: '转写 reading', v: r.reading || '（无）' },
          { k: '画的描述 description', v: r.description || '（非画/无）' },
          { k: '定型', v: `${resolved.type} · conf ${resolved.confidence}` },
        ],
        images: [{ role: 'ink（识别输入）', thumb: await thumb(layers.ink) }].filter((x) => x.thumb),
      });
    } else if (DEV) {
      pl.push({
        stage: 'recognize', label: '识别分类器 · /api/interpret', status: 'skipped',
        note: layers.ink ? '几何门判不值得识别（单笔近直线/太小）→ 跳过、留 drawing' : '无白底笔迹图可识别',
        output: [{ k: '定型', v: `${feature.type}（未经识别）` }],
      });
    }
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
  await enrichHmp(hmp, event, targets, pl); // 仅图区 OCR 兜底（freeform 转写已在上面完成）
  mirrorHmp(hmp);
  const markedText = resolveMarkedText(hmp, index);
  if (DEV) pl.push({
    stage: 'hmp', label: 'HMP 取证（落笔当时）', status: 'ran',
    note: `mode=${hmp.mode} · action=${hmp.action} · 命中类型=${hmp.object_hint}`,
    input: [
      { k: '标注框 bbox', v: event.geometry.bbox.map((n) => +n.toFixed(3)).join(', ') },
      { k: '命中对象', v: targets.map((o) => `${o.type}「${(o.text || '').slice(0, 12)}」`).join(' / ') || '（无）' },
    ],
    output: [
      { k: '所标内容 markedText', v: markedText || '（未提取到文字）' },
      { k: '归类', v: hmp.mode === 'self_content' ? '自身内容（手写/画）' : `锚定原文（${hmp.target_object_refs.length} 对象）` },
    ],
    images: [{ role: 'composite（笔迹叠原文）', thumb: await thumb(layers.composite) }].filter((x) => x.thumb),
  });
  return { hmp, markedText, feature: resolved, trace: DEV ? pl : undefined };
}

/**
 * 把 inference-view 渲染成喂模型的 user turn：idle=整段综合 / handwriting=定向答问。
 * v2 去重：只带本轮动态数据 + 一句标明类别；"怎么回应"的规则单点存 server/prompts.ts 的 annotator system。
 */
function renderUserTurn(view: ReturnType<typeof projectInferenceView>): string {
  const ctx = view.page_context ? `\n\n（本页上下文，仅供消歧）：${view.page_context}` : '';
  if (view.trigger === 'handwriting') {
    const ref = view.referent_lines ? `读者在这句旁边写道：「${view.referent_lines}」。` : ''; // ②指代：问的就是这行
    return `读者手写问：「${view.question || view.marked}」。${ref}相关标注脉络：${view.narrative}。${ctx}`;
  }
  return `读者这一阵连续标注的脉络：${view.narrative}。所标内容：「${view.marked || '（未提取到文字）'}」。${ctx}`;
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
/** 本页上下文文本：重排已缓存 → 用真实阅读序(多栏更准)；否则退回 PDF 文本层顺序。纯机会式、不触发任何重排计算。 */
function pageTextFromReflow(maxChars: number): string {
  const ekey = settings.reflowProvider === 'ai' ? `ai@${settings.reflowModel}` : settings.reflowProvider;
  const blocks = getReflow(state.pageIndex, ekey);
  if (!blocks?.length) return pageText(maxChars);
  return blocks.map((b) => (b.type === 'list' ? (b.items ?? []).join('\n') : b.text)).join('\n').slice(0, maxChars);
}

async function slidingContext(maxChars = 3000): Promise<string> {
  const cur = pageTextFromReflow(maxChars); // 当前页：重排已缓存用阅读序，否则 PDF 文本层序
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
  // 原图送达：上面没选出图、但本段里有"画"（self_content 带笔迹图）→ 选最近一张画的原图送进推理模型。
  // 让"画不是最后一笔"（如画完又写了句问题）时，画的原图仍到模型手里，由模型在上下文里解读其含义。
  if (!crop) {
    const draw = [...marks].reverse().find((m) => m.feature.type === 'drawing' && m.hmp?.mode === 'self_content' && !!m.hmp?.vector_ref);
    if (draw?.hmp?.vector_ref) crop = { role: 'ink', data: draw.hmp.vector_ref };
  }

  // 空间召回（治本·根因 A）与滑窗上下文并发取，省 commit 路径串行延迟
  const [priorNeighbors, pageCtx] = await Promise.all([
    findSpatialRecall(session.bookId, marks), // 账本捞回同页邻近旧标注（不进 graph.nodes）
    slidingContext(3000),                     // 以当前页为中心、前后共 ~3000 字滑动窗
  ]);
  // ②：手写问题（孤立边注本身不带指代）取它纵向压着的印刷正文行作显式指代。
  // 仅当锚点 mark 就在当前页（刚写下的手写恒成立）才有现成 textBlocks；否则跳过、退回页面上下文。
  const rowText = (reason === 'handwriting' && anchorMark.event.page_id === state.pageId)
    ? linesInBand(state.textBlocks, anchorMark.event.geometry.bbox)
    : undefined;
  const view = projectInferenceView(graph, {
    trigger: reason,
    pageText: pageCtx,
    question: reason === 'handwriting' ? (triggerMark?.markedText || '') : undefined,
    crop,
    anchorMarkId: anchorMark.id,
    priorNeighbors,
    rowText,
  });
  mirrorView(view, reason, discId); // dev 通道：喂模型前的精简载荷可离线核对

  const bookId = session.bookId;
  // handwriting 路：上下文分类器判 respond/fold（带同源 inference-view + 对话历史）。
  // fold = 写给自己的笔记 → 静默、不落 overlay、mark 留 session（计入下次综合）。
  let classifyDiag: { respond: boolean; reason: string } | null = null; // 存进账本 diag，供会话页"分类展示"
  let classifyConvoLen = 0; // 分类器看到的对话历史条数（流水线展示用）
  let classifyMs = 0;
  if (reason === 'handwriting') {
    classifyConvoLen = bookMessages(bookId).length;
    const tCls0 = performance.now();
    const decision = await classifyContext(view, bookMessages(bookId));
    classifyMs = Math.round(performance.now() - tCls0);
    classifyDiag = { respond: decision.respond, reason: decision.reason };
    trace('ClassifyContext', { respond: decision.respond, reason: decision.reason, question: view.question ?? '' });
    mirrorClassify({ respond: decision.respond, reason: decision.reason, question: view.question ?? '', discId });
    if (!decision.respond) return false;
  }
  openBook(bookId);
  const userContent = renderUserTurn(view);
  const pageId = view.page_id || anchorMark.event.page_id;
  const anchorRefs = view.anchor_refs;

  let result: InferenceResult;
  let thinking = '';
  let modelMs = 0;
  const bufBefore = bookMessages(bookId).length; // 主模型这轮看到的滑窗上下文条数（发送前）
  const tModel0 = performance.now();
  try {
    const { text: full, thinking: tk } = await chatTurn(bookId, userContent, {
      role: 'annotator', model: settings.inferModel,
      maxTokens: reason === 'idle' ? 600 : 400,
      images: view.crop ? [{ data: view.crop.data }] : [], // 被判需图片识别的内容：把合成图/笔迹图送进主推理
      onDelta: (t) => bus.emit('anchor:place', { id: discId, pageId, anchorRefs, bbox: view.anchor_bbox, text: t, kind: 'note' }),
    });
    modelMs = Math.round(performance.now() - tModel0); // 主模型流式往返耗时（取代 上下文监控 的 ms）
    thinking = tk; // 思考过程不进 buffer，只随账本存、供调试页展示
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
  overlay.object_refs = view.anchor_refs; // 跨视图锚
  state.overlays.push(overlay);
  bus.emit('overlay:add', overlay);

  // 处理流水线（DEV）：把这一轮经手的每个组件「收到什么 → 产出什么」按执行顺序串起来，供会话页逐步复盘。
  let pipeline: PipelineStage[] | undefined;
  if (DEV) {
    const pl: PipelineStage[] = [];
    // ① 逐 mark 的落笔取证阶段（识别 / OCR 兜底 / HMP）——落笔当时已记，这里拼起并标注是第几笔
    marks.forEach((m, i) => {
      const lbl = markTraceLabel(m.feature.type, m.markedText);
      (m.trace ?? []).forEach((st) => pl.push({ ...st, mark_ord: i + 1, mark_label: lbl }));
    });
    // ② mark-graph 关联（时空四象限）
    const edgeKinds: Record<string, number> = {};
    for (const e of graph.edges) edgeKinds[e.kind] = (edgeKinds[e.kind] ?? 0) + 1;
    const quads = graph.edges.filter((e) => e.kind === 'temporal' && e.quadrant).map((e) => e.quadrant);
    pl.push({
      stage: 'graph', label: 'mark-graph 关联（时空四象限）', status: 'ran',
      note: '把这段 mark 连成图：相邻时间边落四象限、空间近邻连边（纯确定性）',
      input: [{ k: '输入 mark', v: `${marks.length} 笔` }],
      output: [
        { k: '节点', v: `${graph.nodes.length}` },
        { k: '边', v: Object.entries(edgeKinds).map(([k, n]) => `${k}:${n}`).join(' / ') || '无' },
        ...(quads.length ? [{ k: '时间四象限', v: quads.join(' · ') }] : []),
      ],
    });
    // ②.5 空间召回（治本·根因 A）：建图视野只到"上次回复以来"，这步从持久账本按 bbox 邻近
    // 捞回墙上画着、但已被清出 session 的同页旧标注，作回访上下文（不进 graph.nodes）
    const recallPages = [...new Set(marks.map((m) => m.event.page_id))].length;
    pl.push({
      stage: 'recall', label: '空间召回（账本·同页 bbox 邻近）', status: priorNeighbors.length ? 'ran' : 'skipped',
      note: '建图只看本段 session；这步把"空间临近但已被上一次回复清出 session"的旧标注从账本捞回',
      input: [{ k: '范围', v: `本书同页已落库标注（涉及 ${recallPages} 页）` }],
      output: [{
        k: '召回',
        v: priorNeighbors.length
          ? priorNeighbors.map((r) => `${r.rel === 'containment' ? '圈住' : r.rel === 'same_row' ? '同行' : '邻近'}「${r.text}」`).join(' / ')
          : '无（附近无已落库旧标注）',
      }],
    });
    // ③ inference-view 蒸馏（确定性·无模型）
    const cropThumb = view.crop ? await thumb(view.crop.data) : '';
    pl.push({
      stage: 'inferview', label: 'inference-view 蒸馏（确定性·无模型）', status: 'ran',
      note: '丢坐标/分数/置信，产「关系叙事 + 所标内容 + 滑窗上下文」——主模型与分类器都只吃它',
      input: [
        { k: '触发', v: reason === 'idle' ? '长停顿综合' : '手写定向' },
        { k: '图', v: `${graph.nodes.length} 节点 / ${graph.edges.length} 边` },
        { k: '召回', v: `${priorNeighbors.length} 条邻近旧标注` },
      ],
      output: [
        { k: '关系叙事 narrative', v: view.narrative || '—' },
        { k: '所标内容 marked', v: view.marked || '（未提取到文字）' },
        ...(view.question ? [{ k: '手写问 question', v: view.question }] : []),
        ...(view.referent_lines ? [{ k: '指代行原文（②）', v: view.referent_lines }] : []),
        { k: '滑窗上下文', v: `${view.page_context?.length ?? 0} 字` },
        { k: '回访 recall', v: view.recall?.length ? view.recall.map((r) => `「${r.text}」`).join('、') : '无' },
        { k: '锚点', v: `${view.anchor_refs.length} 对象` },
        { k: '随图 crop', v: view.crop ? `有（${view.crop.role}）` : '无' },
      ],
      images: cropThumb ? [{ role: `${view.crop!.role}（蒸馏挑出的图）`, thumb: cropThumb }] : [],
    });
    // ④ 上下文分类器（仅手写轮；fold 会提前 return、走不到这里）
    if (reason === 'handwriting' && classifyDiag) pl.push({
      stage: 'classify', label: '上下文分类器 · /api/classify-context', status: 'ran',
      note: '判这条手写是「问我」还是「写给自己」(respond/fold)；与主模型独立的第二次调用',
      input: [
        { k: '问题', v: (view.question || view.marked) || '—' },
        { k: 'view_narrative', v: view.narrative || '—' },
        { k: 'marked', v: view.marked || '—' },
        { k: '对话历史', v: `${classifyConvoLen} 条` },
        { k: '模型', v: settings.inferModel },
      ],
      output: [
        { k: '判定', v: classifyDiag.respond ? '回应 respond ✓' : '折叠 fold ✗' },
        { k: '理由', v: classifyDiag.reason || '—' },
        { k: '延迟', v: `${classifyMs} ms` },
      ],
    });
    // ⑤ 主模型（流式）——产出即下方那条回复气泡 + 思考过程
    pl.push({
      stage: 'model', label: '主模型 · /api/chat（流式）', status: result.model_version === 'chat-session' ? 'ran' : 'error',
      note: `系统人格 ${PROMPT_TAG} · 滑窗 buffer ${bufBefore} 轮（发送前）`,
      input: [
        { k: '模型', v: settings.inferModel },
        { k: 'maxTokens', v: String(reason === 'idle' ? 600 : 400) },
        { k: '随发图', v: view.crop ? `有（${view.crop.role}）` : '无' },
        { k: '完整 prompt', v: userContent },
      ],
      output: [
        { k: '回复', v: result.content },
        { k: '思考过程', v: thinking ? `${thinking.length} 字（见下方气泡）` : '（当前模型未回传）' },
        { k: '延迟', v: `${modelMs} ms` },
      ],
      images: cropThumb ? [{ role: `${view.crop!.role}（送入主模型）`, thumb: cropThumb }] : [],
    });
    pipeline = pl;
  }

  // 落账本：ai_turn 进书日志（显示快照 + 锚点 + view 快照[crop 剥] + provenance）；并推综合水位线
  await appendAiTurnEntry({
    document_id: bookId, page_id: pageId, page_index: state.pageIndex,
    overlay_id: discId, overlay, overlay_state: 'shown', user_edited_text: null,
    ai_reply: result.content,
    anchor: { surface_id: view.page_id, mark_ids: marks.map((m) => m.id), object_refs: view.anchor_refs },
    inference_view: { ...view, crop: undefined }, // 存料不存图：crop 落库前剥掉
    prompt_snapshot: userContent,
    system_prompt_hash: PROMPT_TAG,
    settings_snapshot: { inferModel: settings.inferModel, reflowProvider: settings.reflowProvider },
    trigger: reason, model: result.model_name, supersedes: null, thinking,
    diag: { classify: classifyDiag, sent_image: !!view.crop },
    pipeline,
  });
  setSynthesisWatermark(); // 此前所有 mark 记为已综合；之后的新 mark = pending
  bus.emit('aiturn:appended', bookId); // 账本已落 → 通知会话页刷新（overlay:add 早于本 await，单靠它读账本会漏最新一轮）
  return true;
}
