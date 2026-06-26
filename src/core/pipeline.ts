import type { AnnotationEvent, HMP, InferenceResult, InferenceView, NormBBox, PipelineStage, ScreenOverlay, SurfaceIndex, SurfaceObject } from './contracts';
import { SCHEMA_VERSION } from './contracts';
import { DEVICE_ID, SESSION_ID, shortId } from './ids';
import { appendAiTurnEntry, getReflow, setSynthesisWatermark, getBookAiTurns } from '../local/store';
import { devEmit } from './dev-telemetry';
import { bboxOf, classify, type StrokeFeature } from '../capture/classify';
import { resolveTarget, buildHmp } from '../evidence/target';
import { buildMarkGraph } from '../evidence/mark-graph';
import { findSpatialRecall, type RecallCandDiag } from '../evidence/recall';
import { findThematicRecall } from '../evidence/thematic';
import { vectorStore } from '../local/vector';
import { makeThumbnail as thumb } from '../platform/web/thumbnail';
import { markTraceLabel, errorResult, buildOverlay, markActionOf, resolveMarkedText, intentToRespond, renderUserTurn } from '../domain/pipeline-pure';
import { projectInferenceView } from '../evidence/inference-view';
import type { Mark, Session } from '../capture/session';
import { mark } from './metrics';
import { trace } from './trace';
import { bus, settings, state, getActiveContext, type Stroke } from '../app/state';
import { grabLayers, grabRegion } from '../evidence/ocr';
import { ondeviceRecognizeInk, ondeviceOcrRegion } from '../evidence/ondevice';
import { classifyIntentLocal, classifyIntentExplained } from '../evidence/intent-rules';
import { pageText, blocksToText, linesInBand, pointInPolygon } from '../evidence/focus';
import { extractPageBlocks } from '../surface/renderer';
import { pushInspect } from './inspect';
import { chatTurn } from '../chat/stream-client';
import { openBook, bookMessages } from '../chat/buffer';
import { classifyContext, LOCAL_RULES } from '../chat/classify-client';
import { getPageOcrText } from '../evidence/page-ocr';
import { postJson, postBeacon } from './api';
import { promptVersion } from './prompt-versions';

/** 伴读 persona 已搬到服务端 server/prompts.ts（按 role 索引、与模型解耦）；/api/chat 收 role='annotator'。
 *  下面这个标签随账本存 system_prompt_hash，标识本轮提示词版本。版本号取自前后端单源 prompt-versions，
 *  bump 服务端某 role 版本即自动同步、不再手工对齐漂移（R8）。 */
const PROMPT_TAG = `annotator@${promptVersion('annotator')}`;

/* ── 处理流水线（调试）：逐组件「收到什么 → 产出什么」，含缩略图，串成一轮链路 ─────────
 * 仅 DEV 落库（gate 同 mirror*）；图压成 ~220px 缩略图控 IndexedDB 体积。供 AI 会话调试页复盘。 */
const DEV = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;

// thumb() 已抽到 platform/web/thumbnail.ts（F2：core 不再直接碰 Image/canvas）。



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
      // 端侧优先：原生桥可用 → 本地区域 OCR；不可用/失败 → 云端 /api/ocr-vlm（Kimi 视觉）。
      const local = await ondeviceOcrRegion(crop);
      if (local) readOut = String(local.text || '').trim();
      else {
        const j = await postJson<{ text?: string }>('/api/ocr-vlm', { image: crop, model: settings.inferModel });
        readOut = String(j?.text || '').trim();
      }
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
 * dev-only：完整 HMP 取证 → kind='hmp'。去 crop/vector base64（只留是否存在），
 * 把 target_object_refs 解析成原文——开发者侧不进浏览器也能逐字段核对采集准确性。
 * 传输/容错/DEV 闸统一在 devEmit；payload 在 thunk 内塑形（生产零开销）。
 */
function mirrorHmp(hmp: HMP): void {
  devEmit('hmp', () => {
    const objs = state.surfaceIndex?.objects ?? [];
    const targets = hmp.target_object_refs.map((id) => {
      const o = objs.find((x) => x.id === id);
      return o ? { id: o.id, type: o.type, role: o.role ?? null, text: o.text ?? null } : { id, missing: true };
    });
    return {
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
  });
}

/**
 * dev-only：识别裁判 → kind='recognize'。哭脸式漏判的关键观测点——
 * 一笔 freeform 是否送 /api/interpret、为何跳过（markup 由几何判 / 几何门不值得 / 无墨图）、
 * 判定 kind+转写+描述，以及几何初判 feature_in 与最终 feature_out。每笔 captureMark 都发一条。
 */
function mirrorRecognize(o: {
  event_id: string; page_id: string; region: NormBBox;
  feature_in: string; feature_out: string; ocrWorthy: boolean; hasInk: boolean;
  interpretCalled: boolean; gate: string;
  feat?: StrokeFeature;
  kind?: string; reading?: string; description?: string; source?: string;
}): void {
  devEmit('recognize', () => {
    // 几何判别 raw（"先量再改"：定 markup/underline 闸阈值用）——markup 把英文长横判 underline 吃掉的根因，
    // 靠 scale_ratio(mark 高÷本行字高) 与真下划线区分：真划线很扁(scale_ratio 小)、英文手写有一行字那么高。
    const r = o.feat?.raw;
    const markLong = Math.max(o.region[2], o.region[3]) || 1e-6;
    return {
      event_id: o.event_id, page_id: o.page_id, region: o.region.map((n) => +n.toFixed(4)),
      feature_in: o.feature_in, feature_out: o.feature_out, ocrWorthy: o.ocrWorthy, hasInk: o.hasInk,
      interpretCalled: o.interpretCalled, gate: o.gate,
      ...(r ? { feat: {
        tpl_type: r.templateType, tpl_score: +r.templateScore.toFixed(3),
        tpl_span: +r.tplSpan.toFixed(4), span_ratio: +(r.tplSpan / markLong).toFixed(3),
        scale_ratio: Number.isFinite(r.scaleRatio) ? +r.scaleRatio.toFixed(3) : null,
        mark_w: +o.region[2].toFixed(4), mark_h: +o.region[3].toFixed(4),
        stroke_count: r.strokeCount, complexity: +r.complexity.toFixed(2),
      } } : {}),
      // VLM 判定值字段名用 interp_kind，**不要叫 kind**——会和 envelope 的事件 kind 撞名。
      ...(o.interpretCalled ? { interp_kind: o.kind ?? '', reading: o.reading ?? '', description: o.description ?? '', source: o.source ?? '' } : {}),
    };
  });
}


/* ──────────────────────────────────────────────────────────────────────────
 * v3 会话流：mark 落笔即取证(captureMark) → 累积成 session → 长停顿/手写触发
 * 时建标注图 + 蒸馏 inference-view → 主模型回应。语义全交模型（无形状→意图映射）。
 * ────────────────────────────────────────────────────────────────────────── */

/** dev-only：上下文分类器 respond/fold 判定 → kind='classify'。 */
function mirrorClassify(o: { respond: boolean; reason: string; question: string; discId: string }): void {
  devEmit('classify', () => ({ ...o }));
}

/**
 * dev-only：空间召回逐候选判定 → kind='recall'。召回为空时直接看每条候选的 euclid/dy/dx/sameRow/verdict，
 * 无需进浏览器展开折叠。target=当前锚点笔(手写)的 bbox/文字，candidates=evals。
 * 注：thresholds 与 mark-graph.ts SPATIAL_NEAR / recall.ts ROW_BAND·ROW_REACH 对齐（仅作展示）。
 */
function mirrorRecall(o: { discId: string; target: { text: string; bbox: NormBBox } | null; evals: RecallCandDiag[]; recalled: number }): void {
  devEmit('recall', () => ({
    discId: o.discId,
    target: o.target ? { text: o.target.text, bbox: o.target.bbox.map((n) => +n.toFixed(4)), ycenter: +(o.target.bbox[1] + o.target.bbox[3] / 2).toFixed(4) } : null,
    thresholds: { SPATIAL_NEAR: 0.12, ROW_BAND: 0.03, ROW_REACH: 0.5 },
    recalled: o.recalled, candidates: o.evals,
  }));
}

/** dev-only：蒸馏出的 inference-view（喂模型的精简载荷）→ kind='inferview'。 */
function mirrorView(view: InferenceView, reason: string, discId: string): void {
  devEmit('inferview', () => ({
    discId, trigger: reason,
    narrative: view.narrative, marked: view.marked, question: view.question ?? null,
    referent_lines: view.referent_lines ?? null, recall_n: view.recall?.length ?? 0, thematic_n: view.thematic?.length ?? 0, vector_available: vectorStore.available,
    page_annot_n: view.page_annotations?.length ?? 0,
    anchor_refs: view.anchor_refs, has_crop: !!view.crop, page_ctx_len: view.page_context?.length ?? 0,
  }));
}

/** 形状/特征 → MarkShape：手写/画由特征定，其余按几何 EventType。 */

/** 识别分类器选「端侧手写模型」的哨兵值（dev）：手写转写走本地 OpenVINO 英文手写端点 /api/interpret-hwr，不调云。 */
export const LOCAL_HWR = '__local_hwr__';

/**
 * 识别当类型分类器（context-free）：读这团墨是不是文字 → kind + 转写 + 画的粗描述。
 * 端侧优先：原生桥可用且板上有可用手写引擎 → 本地识别，source=local_board。
 * 次选：识别分类器选「端侧手写模型」(LOCAL_HWR) → 走本地 OpenVINO 英文手写端点 /api/interpret-hwr
 *       （dev=mac OpenVINO 跑徐方案模型；图像式行识别，只出 reading、kind 当 handwriting）。
 * 否则降级云端 /api/interpret（source=cloud）；判 kind / 画描述本就留云 VLM。两路均失败默认 none。
 */
async function recognizeInk(
  inkData: string, strokes?: unknown,
): Promise<{ kind: string; reading: string; description: string; source: 'local_board' | 'cloud' }> {
  const local = await ondeviceRecognizeInk(inkData, strokes);
  if (local) return {
    kind: String(local.kind || 'none'), reading: String(local.reading || '').trim(),
    description: String(local.description || '').trim(), source: 'local_board',
  };
  // dev：选了「端侧手写模型」→ 本地英文手写端点。统一契约：端点**自己**判"是否可信手写"，可信才回 reading、否则回空。
  //   "怎么判"与具体模型强耦合（OpenVINO 英文 GNHK 的置信度+长度双门），封装在 server/hwr-dev.mjs 适配层，**不漏进这里**。
  //   故此处与对待任何端侧识别一致：有 reading 就用、空就往下落云 /api/interpret（VLM 判 kind+转写+画描述）。换引擎时只改适配层。
  if (settings.interpretModel === LOCAL_HWR) {
    try {
      const j = await postJson<{ reading?: string }>('/api/interpret-hwr', { image: inkData });
      const reading = String(j?.reading || '').trim();
      if (reading) return { kind: 'handwriting', reading, description: '', source: 'local_board' };
    } catch { /* 端点不在/失败 → 落云端 */ }
  }
  try {
    const model = (settings.interpretModel && settings.interpretModel !== LOCAL_HWR) ? settings.interpretModel : settings.inferModel;
    const j = await postJson<{ kind?: string; reading?: string; description?: string }>('/api/interpret', { image: inkData, model });
    return { kind: String(j.kind || 'none'), reading: String(j.reading || '').trim(), description: String(j.description || '').trim(), source: 'cloud' };
  } catch { return { kind: 'none', reading: '', description: '', source: 'cloud' }; }
}

/**
 * intent A/B 影子对照（Seam C，**不替换**上下文分类器）。
 * 用 IntentClassifier 的 TS 移植（intent-rules.ts）算 6 标签 → respond/fold 预测，与云端决定一起落账算一致率。
 * 规则纯本地、web/dev/套壳都跑（不依赖原生桥/AAR/板子）；云端仍权威驱动行为，端侧仅影子。
 * 收集：postBeacon → 代理 /api/ab/intent（.ab-intent.jsonl，板上生产也发）；并 devEmit 供 dev 面板可视。
 */
function emitIntentAb(text: string, cloud: { respond: boolean; reason: string }, discId: string): void {
  const intent = classifyIntentLocal('handwriting', text);
  const respondPred = intentToRespond(intent);
  const rec = {
    disc_id: discId,
    text: text.slice(0, 120),
    cloud: { respond: cloud.respond, reason: cloud.reason },
    local: { intent, respond_pred: respondPred },
    agree: respondPred === cloud.respond,
  };
  postBeacon('/api/ab/intent', rec); // 生产持久化收集（板上也发）
  devEmit('intent_ab', () => rec);    // dev 面板可视
}

/**
 * "跳出来"语义复判：几何把一笔判成了 markup（圈/划/箭头），但它可能其实是画在空白处的涂鸦/表情。
 * 判据（语义，非几何形状）：圈注的天职是圈住内容；一个**没真圈住任何内容、内部却含其他笔画**的圈，
 * 更像"脸轮廓 + 五官"。命中则推翻几何 markup、转 freeform 送 interpret 让 VLM 定夺（脸 vs 圈）。
 *
 * 真·圈内判定用 pointInPolygon（对象中心是否落在笔迹内），**排除 bbox 边角假命中**——
 * 这正是哭脸误判的根：它 bbox 蹭到正文"，制"、却没真圈住它。
 *
 * ⚠️ 当前仅处理 circle（表情/涂鸦轮廓几乎都是圈），strokeCount≥2（孤零圈意图不明、不强判）。
 * TODO（通用化·用户留的心眼）：未来若别的模板/场景也撞上"几何形状 ≠ 语义意图"，
 *   把"没命中内容 + 伴随笔画"这套语义信号抽成按 templateType 配置的通用复判，替掉这个 circle 特例。
 */
function markupLooksLikeDrawing(feature: StrokeFeature, event: AnnotationEvent, index: SurfaceIndex): boolean {
  if (feature.raw.templateType !== 'circle') return false; // 仅圈（特例，待通用化）
  if (feature.raw.strokeCount < 2) return false;           // 孤零零一个圈 → 不强判
  // 圈住任何非空白内容对象（含图片）→ 是正经圈注；都没圈住、却含多笔 → 疑涂鸦/表情。
  const enclosesContent = index.objects.some((o) =>
    o.type !== 'blank_region' &&
    pointInPolygon(o.bbox[0] + o.bbox[2] / 2, o.bbox[1] + o.bbox[3] / 2, event.stroke_points),
  );
  return !enclosesContent;
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
): Promise<{ hmp: HMP | null; markedText: string; feature: StrokeFeature; kind?: string; kindSource?: string; trace?: PipelineStage[] }> {
  const index = state.surfaceIndex;
  if (!index || event.page_id !== index.surface_id) return { hmp: null, markedText: '', feature };
  const targets = resolveTarget([event], event.geometry.bbox, index);
  const layers = grabLayers(event.geometry.bbox, 0.04);
  const pl: PipelineStage[] = []; // 这笔经手的组件阶段（识别/OCR兜底/取证），提交时拼进整轮流水线

  // 识别定型：freeform 过几何门(ocrWorthy) → 送识别判 handwriting/drawing；markup 默认几何定型不送识别。
  // 但"跳出来"复判会推翻明显是涂鸦的圈（没真圈住内容+含多笔 → 疑表情）→ 也走识别（见 markupLooksLikeDrawing）。
  const freeformOverride = feature.type === 'markup' && markupLooksLikeDrawing(feature, event, index);
  let resolved = feature;
  let textHint: string | undefined;
  let recog: { kind: string; reading: string; description: string; source: 'local_board' | 'cloud' } | null = null; // 识别结果（仅调用时）
  let recogGate: string; // 为何送/跳过识别（dev 遥测核对哭脸式漏判）
  if (feature.type === 'markup' && !freeformOverride) {
    recogGate = 'markup（几何已定型）·不送识别';
  } else if (layers.ink && (feature.raw.ocrWorthy || freeformOverride)) {
    recog = await recognizeInk(layers.ink, event.stroke_points);
    const isText = recog.kind === 'handwriting' || recog.kind === 'mixed';
    const hasDrawing = recog.kind === 'sketch' || recog.kind === 'mixed'; // 含可视化的画（mixed=图+字，仍含画）
    resolved = { ...feature, type: isText ? 'handwriting' : 'drawing', confidence: recog.kind === 'none' ? 0.3 : 0.85, hasDrawing };
    // 文字→转写；画→粗描述。**mixed（图+字）两者都留**：描述进 markedText/叙事/召回，原图另送推理（见下方"原图送达"按 hasDrawing 放宽）。
    textHint = recog.kind === 'mixed'
      ? [recog.reading, recog.description && `（画：${recog.description}）`].filter(Boolean).join(' ') || undefined
      : (isText ? recog.reading : recog.description) || undefined;
    recogGate = freeformOverride ? 'circle 未圈住内容+含多笔(疑涂鸦/表情)·推翻 markup 送识别' : 'freeform 过几何门(ocrWorthy)·送识别';
    if (DEV) pl.push({
      stage: 'recognize', label: '识别分类器 · ' + (recog.source === 'local_board' ? '端侧 OCR (local_board)' : '/api/interpret'), status: 'ran',
      note: (freeformOverride ? '⤷ markup 圈复判：没圈住内容+含多笔→疑涂鸦/表情，推翻几何 markup。' : '自由笔且过几何门(ocrWorthy)。') + '判「手写 vs 画」、转写文字、给画一句粗描述（context-free，不揣测意图）',
      input: [{ k: '识别源', v: recog.source }, { k: '模型', v: recog.source === 'cloud' ? (settings.interpretModel || settings.inferModel) : '端侧模型' }, { k: '输入', v: '白底笔迹图 ink' + (recog.source === 'local_board' ? ' + 笔迹点序' : '') }],
      output: [
        { k: '判定 kind', v: recog.kind },
        { k: '转写 reading', v: recog.reading || '（无）' },
        { k: '画的描述 description', v: recog.description || '（非画/无）' },
        { k: '定型', v: `${resolved.type} · conf ${resolved.confidence}` },
      ],
      images: [{ role: 'ink（识别输入）', thumb: await thumb(layers.ink) }].filter((x) => x.thumb),
    });
  } else {
    recogGate = layers.ink ? '几何门判不值得识别（单笔近直线/太小）·跳过' : '无白底笔迹图·跳过';
    if (DEV) pl.push({
      stage: 'recognize', label: '识别分类器 · /api/interpret', status: 'skipped',
      note: recogGate + '→ 留 drawing',
      output: [{ k: '定型', v: `${feature.type}（未经识别）` }],
    });
  }
  // dev：每笔都发识别裁判（含 markup 跳过的、含被复判推翻的——哭脸式漏判靠这条一眼看穿）
  mirrorRecognize({
    event_id: event.event_id, page_id: event.page_id, region: event.geometry.bbox,
    feature_in: feature.type, feature_out: resolved.type, ocrWorthy: !!feature.raw.ocrWorthy, hasInk: !!layers.ink,
    interpretCalled: !!recog, gate: recogGate, feat: feature, kind: recog?.kind, reading: recog?.reading, description: recog?.description, source: recog?.source,
  });
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
  return { hmp, markedText, feature: resolved, kind: recog?.kind, kindSource: recog?.source, trace: DEV ? pl : undefined };
}

/** 「本页已有批注」动态背景段：本页其他批注+你的旧回应，帮模型理解整页脉络（背景、非焦点）；空则空串。 */

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
  if (!blocks?.length) return pageText(maxChars) || getPageOcrText(state.pageId).slice(0, maxChars); // 扫描页退整页 OCR 文本
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

export type CommitOutcome = 'committed' | 'folded' | 'failed';
export async function commitSessionDiscussion(
  session: Session, reason: 'idle' | 'handwriting', triggerMark: Mark | undefined, discId: string,
): Promise<CommitOutcome> {
  // B1 守卫：回答/旁注/水位线都只写「发起本次综合的归属实例」，回答期间切走也不灌进切换后的文档。
  const ownerCtx = getActiveContext();
  const ownerDoc = ownerCtx.storeDoc;
  const ownerPageIndex = state.pageIndex;
  const aiGen = ++ownerCtx.aiGeneration;
  const alive = () => ownerCtx.aiGeneration === aiGen && getActiveContext() === ownerCtx; // 仍在归属实例、未被新一轮抢占
  const marks = session.marks.slice(); // 快照：综合期间新写的笔不混入本批（也不被本批连带清掉）
  if (!marks.length) return 'folded';
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
    // 含画的笔（drawing 纯画，或 mixed=图+字虽定型 handwriting 仍含画）→ 把它的白底原图送进推理，让模型直接看那张画。
    const draw = [...marks].reverse().find((m) => (m.feature.type === 'drawing' || m.feature.hasDrawing) && m.hmp?.mode === 'self_content');
    if (draw?.hmp?.vector_ref) crop = { role: 'ink', data: draw.hmp.vector_ref };             // 本 session 刚画的，图还在内存
    else if (draw && draw.event.page_id === state.pageId) {
      // 召回/重载的画：vector_ref 落库时被剥（"存料不存图"），但笔迹点序无损存着、redrawInk 已把它画回当前墨水层 →
      // 从墨水层按 bbox 重抓一张白底栅格喂模型，补"日后会话拿不到那张画"的缺口（仅当画仍在当前页）。
      const ink = grabLayers(draw.event.geometry.bbox).ink;
      if (ink) crop = { role: 'ink', data: ink };
    }
  }

  // 空间召回（治本·根因 A）+ 滑窗上下文 + 全书主题召回（向量·现 no-op）+ 账本（回查旧回复）并发取，省串行延迟
  const recallQuery = marks.map((m) => m.markedText).filter(Boolean).join(' ').slice(0, 300);
  const recallDiag: RecallCandDiag[] | undefined = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ? [] : undefined;
  const [priorNeighbors, pageCtx, thematic, bookTurns] = await Promise.all([
    findSpatialRecall(session.bookId, marks, recallDiag), // 账本捞回同页邻近旧标注（不进 graph.nodes）；diag 收逐候选判定
    slidingContext(3000),                      // 以当前页为中心、前后共 ~3000 字滑动窗
    findThematicRecall(session.bookId, recallQuery), // 全书主题联想（向量 stub，现恒返 []）
    getBookAiTurns(session.bookId),            // 回查召回旧标注当时的 AI 回复（替代长 buffer 延续性）
  ]);
  // 召回带回旧回复：按 mark_id 在账本里找它当时所属那轮，取其 ai_reply（截断）。本轮尚未入账，不会自引。
  for (const n of priorNeighbors) {
    if (!n.mark_id) continue;
    const t = bookTurns.find((tt) => tt.anchor.mark_ids.includes(n.mark_id!));
    if (t?.ai_reply) n.reply = t.ai_reply.slice(0, 80);
  }
  // dev：把逐候选判定（含被拒的，带 euclid/dy/dx/verdict）镜像到 telemetry，便于离线核对"召回为空"根因。
  if (recallDiag) mirrorRecall({ discId, target: { text: anchorMark.markedText || `「${reason}」`, bbox: anchorMark.event.geometry.bbox }, evals: recallDiag, recalled: priorNeighbors.length });
  // ②：手写问题（孤立边注本身不带指代）取它纵向压着的印刷正文行作显式指代。
  // 仅当锚点 mark 就在当前页（刚写下的手写恒成立）才有现成 textBlocks；否则跳过、退回页面上下文。
  const rowText = (reason === 'handwriting' && anchorMark.event.page_id === state.pageId)
    ? linesInBand(state.textBlocks, anchorMark.event.geometry.bbox)
    : undefined;
  // 动态背景：本页其他批注 + 你当时的回应（给模型整页脉络）。去重已被焦点召回的那些（priorNeighbors），
  // 免得和召回子句重复；上限最近 6 条防膨胀。本轮尚未入账，天然不在内。
  const focusMarkIds = new Set(priorNeighbors.map((n) => n.mark_id).filter(Boolean) as string[]);
  const pageAnnotations = bookTurns
    .filter((t) => t.page_index === state.pageIndex && t.overlay_state !== 'dismissed' && t.overlay_state !== 'folded')
    .filter((t) => !t.anchor.mark_ids.some((id) => focusMarkIds.has(id)))
    .map((t) => ({ marked: String(t.inference_view?.marked || '').slice(0, 50), reply: String(t.ai_reply || '').slice(0, 80) }))
    .filter((x) => x.marked || x.reply)
    .slice(-6);
  const view = projectInferenceView(graph, {
    trigger: reason,
    pageText: pageCtx,
    question: reason === 'handwriting' ? (triggerMark?.markedText || '') : undefined,
    crop,
    anchorMarkId: anchorMark.id,
    priorNeighbors,
    rowText,
    pageAnnotations,
    thematic,
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
    // dev：上下文分类器选「端侧规则」时，respond/fold 直接由徐 IntentClassifier 的 TS 移植驱动（不调云）。
    const useLocalRules = settings.classifyModel === LOCAL_RULES;
    let decision: { respond: boolean; reason: string };
    if (useLocalRules) {
      const { intent, hit } = classifyIntentExplained('handwriting', view.question || view.marked || '');
      decision = { respond: intentToRespond(intent), reason: `端侧规则 · ${intent}（${hit}）` };
    } else {
      decision = await classifyContext(view, bookMessages(bookId));
    }
    classifyMs = Math.round(performance.now() - tCls0);
    classifyDiag = { respond: decision.respond, reason: decision.reason };
    trace('ClassifyContext', { respond: decision.respond, reason: decision.reason, question: view.question ?? '' });
    mirrorClassify({ respond: decision.respond, reason: decision.reason, question: view.question ?? '', discId });
    if (!useLocalRules) void emitIntentAb(view.question || view.marked || '', decision, discId); // 云端驱动时才做影子对照
    if (!decision.respond) {
      // fold = 写给自己的笔记 → 静默、不落 reader overlay、marks 留 session（计入下次综合）。
      // 仍把这一轮作为「折叠」条目落账本——否则 AI 会话 dev 页（只读 ai_turns）完全看不到判否的流程。
      // overlay_state='folded'：restore 不恢复其 overlay、不回放进 buffer（见 main.restoreFromLedger）；
      // 不调 setSynthesisWatermark（提前 return，marks 自然留 pending）。
      const foldPageId = view.page_id || anchorMark.event.page_id;
      const foldOverlay: ScreenOverlay = {
        overlay_id: discId, trace_id: anchorMark.event.trace_id, page_id: foldPageId,
        result_id: shortId('res'), overlay_type: 'note', geometry: { anchor_bbox: view.anchor_bbox },
        display_text: '', dismissible: true, created_at: new Date().toISOString(),
        state: 'folded', result_type: 'inspiration', object_refs: view.anchor_refs,
      };
      await appendAiTurnEntry({
        document_id: bookId, page_id: foldPageId, page_index: ownerPageIndex,
        overlay_id: discId, overlay: foldOverlay, overlay_state: 'folded', user_edited_text: null,
        ai_reply: '',
        anchor: { surface_id: view.page_id, mark_ids: marks.map((m) => m.id), object_refs: view.anchor_refs },
        inference_view: { ...view, crop: undefined }, // 存料不存图
        prompt_snapshot: renderUserTurn(view),        // 当时本会回应的话会发的内容（折叠没真送）
        system_prompt_hash: PROMPT_TAG,
        settings_snapshot: { inferModel: settings.inferModel, reflowProvider: settings.reflowProvider },
        trigger: 'handwriting', model: settings.inferModel, supersedes: null,
        diag: { classify: classifyDiag, sent_image: false },
      });
      bus.emit('aiturn:appended', bookId); // 会话页开着 → 刷新即见这条折叠轮
      return 'folded';
    }
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
      onDelta: (t) => { if (alive()) bus.emit('anchor:place', { id: discId, pageId, anchorRefs, bbox: view.anchor_bbox, text: t, kind: 'note' }); }, // 切走后不再往当前 surface 喷流式锚（B1）
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
    (result as unknown as { _debug?: unknown })._debug = { mode: 'chat-session', trigger: reason, narrative: view.narrative, marked: view.marked, buffer_turns: bookMessages(bookId).length, referent_lines: view.referent_lines, recall: view.recall, thematic_n: view.thematic?.length ?? 0 };
    trace('InferenceResult(session)', result as unknown as Record<string, unknown>);
  } catch (err) {
    if (alive()) bus.emit('anchor:clear', discId);
    // B2：AI 失败不当成功——不入账本、不推水位线、保留 pending marks（下次 idle 可重试），只在归属实例显示一条瞬时错误旁注。
    const errOverlay = buildOverlay(errorResult(anchorMark.event, err), anchorMark.event);
    errOverlay.overlay_id = discId;
    errOverlay.geometry = { anchor_bbox: view.anchor_bbox };
    errOverlay.object_refs = view.anchor_refs;
    const prevErr = ownerCtx.overlays.find((o) => o.overlay_id === discId);
    if (prevErr) ownerCtx.overlays = ownerCtx.overlays.filter((o) => o !== prevErr);
    ownerCtx.overlays.push(errOverlay);
    if (alive()) { if (prevErr) bus.emit('overlay:remove', discId); bus.emit('overlay:add', errOverlay); }
    return 'failed';
  }

  pushInspect({
    ts: new Date().toISOString(), pageIndex: state.pageIndex,
    gesture: anchorMark.event.event_type, intent: reason, modes: [],
    nearby: view.marked, ocrTexts: [], memoryPages: bookMessages(bookId).length,
    hasImage: !!view.crop, composite: view.crop?.data, images: view.crop ? [view.crop] : [],
    bbox: view.anchor_bbox, debug: (result as unknown as { _debug?: Record<string, unknown> })._debug ?? null,
    resultType: result.result_type, content: result.content, confidence: result.confidence, recalled: [], model: result.model_name,
  });

  // upsert overlay by discId（写归属实例 ownerCtx；切走则只入实例、不发 UI 事件，切回时由账本恢复重建——B1）
  const prev = ownerCtx.overlays.find((o) => o.overlay_id === discId);
  if (prev) { ownerCtx.overlays = ownerCtx.overlays.filter((o) => o !== prev); if (alive()) bus.emit('overlay:remove', discId); }
  const overlay = buildOverlay(result, anchorMark.event);
  overlay.overlay_id = discId;
  overlay.geometry = { anchor_bbox: view.anchor_bbox };
  overlay.object_refs = view.anchor_refs; // 跨视图锚
  ownerCtx.overlays.push(overlay);
  if (alive()) bus.emit('overlay:add', overlay);

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
        ...(view.page_annotations?.length ? [{ k: '本页已有批注（背景）', v: view.page_annotations.map((a) => `「${a.marked}」`).join('、') }] : []),
        { k: '滑窗上下文', v: `${view.page_context?.length ?? 0} 字` },
        { k: '回访 recall', v: view.recall?.length ? view.recall.map((r) => r.reply ? `「${r.text}」(当时:${r.reply.slice(0, 20)}…)` : `「${r.text}」`).join('、') : '无' },
        { k: '主题召回（向量）', v: view.thematic?.length ? view.thematic.map((t) => `「${t.text}」`).join('、') : '无（向量未接入）' },
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
        { k: '判定来源', v: settings.classifyModel === LOCAL_RULES ? '端侧规则 intent-rules（纯规则·无模型）' : `云端 ${settings.classifyModel || settings.inferModel}` },
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
    document_id: bookId, page_id: pageId, page_index: ownerPageIndex,
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
  setSynthesisWatermark(ownerDoc); // 推归属书的综合水位线（回答期间已切走也写对书）；此前 mark 记为已综合
  bus.emit('aiturn:appended', bookId); // 账本已落 → 通知会话页刷新（overlay:add 早于本 await，单靠它读账本会漏最新一轮）
  return 'committed';
}
