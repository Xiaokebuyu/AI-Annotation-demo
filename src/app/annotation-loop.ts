// 标注会话编排（与具体 DOM id 无关，桌面与移动版共用）：
// 进笔 → 区域组装（空间+时间连续）→ 收口成 mark → 落账本 → 长停顿/手写综合 → AI 旁注。
// 从 main.ts 抽出，wireAnnotationLoop(inkLayer) 挂上 initInk + 相关 bus 监听；各前端各传自己的 #ink 画布。
import { recordEvent, captureMark, commitSessionDiscussion } from '../core/pipeline';
import { classifyScored, classifyStrokeFeature, bboxOf } from '../capture/classify';
import {
  addMark, peekSession, clearSession, makeMark, removeMark,
  IDLE_COMMIT_MS, type Mark,
} from '../capture/session';
import { localCharHeight } from '../evidence/target';
import { computeManner } from '../evidence/dynamics';
import { trace } from '../core/trace';
import { devEmit } from '../core/dev-telemetry';
import { shortId, DEVICE_ID } from '../core/ids';
import { bus, state, settings, strokeMarkIds, getActiveContext, type Stroke } from './state';
import { appendMarkEntry, updateOverlayState } from '../local/store';
import type { ScreenOverlay, AnnotationEvent, NormBBox } from '../core/contracts';
import { initInk, redrawInk } from '../capture/ink';
import { signalInkArea } from '../surface/eink';
import { bedrockMarkBoundary } from '../local/bedrock-recorder';
import type { RawRef } from '../core/bedrock';

// 区域组装（空间+时间连续）：同一小块区域里继续写的笔画并进一个 mark；附近无动作满 REGION_QUIET 才提交；
// 笔落到远处=离开该区域 → 上一区域立刻收口。无书写时长上限——慢写整段保持静默、聚成一整团再识别（读得准、只回一条）。
const REGION_QUIET_MS = 6000;     // 附近无动作多久 → 收口提交（dev 可调，按真实手速）
const REGION_NEAR = 0.06;         // "附近"：笔中心在区域 bbox 外扩此值内算同区（归一化）

let sessionTrace: string | null = null;
let idleTimer: number | undefined;     // 长停顿(~1–2min) → 对整段 session 综合回复
const lastSig = new Map<string, string>(); // 防重复提交（按 book）

// 当前挂起的"区域"（单活跃区：写在一处会聚起来；落到远处则旧区先收口、此处另起）。
let regEvents: AnnotationEvent[] = [];
let regStrokes: Stroke[] = []; // 与 regEvents 对齐：组装时给每构成笔建 笔→mark 映射（擦/撤定位整 mark）
let regBbox: NormBBox | null = null;
let regFirstAt = 0;
let regTimer: number | undefined;
// 与 regStrokes **逐位对齐**（含占位 undefined·bedrock 关时）：每笔在 ingestStroke 时同步取的基岩 seq 区间；
// 收口时合并成 mark.raw_ref。同步按笔取才精确——异步 resolveRegion 末尾再读全局水位会被 far-stroke 的下一笔/await 期间新笔污染。
let regRawRefs: (RawRef | undefined)[] = [];

function unionBb(a: NormBBox, b: NormBBox): NormBBox {
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0] + a[2], b[0] + b[2]), y1 = Math.max(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, x1 - x0, y1 - y0];
}

/** 合并一个区域内各笔的基岩 seq 区间 → 一条 raw_ref。区内各笔采样连续、同段 → 取首段 + [首.from, 末.to]。 */
function mergeRawRefs(refs: (RawRef | undefined)[]): RawRef | undefined {
  const d = refs.filter((r): r is RawRef => !!r);
  if (!d.length) return undefined;
  return { segment_id: d[0].segment_id, seq_from: d[0].seq_from, seq_to: d[d.length - 1].seq_to };
}
/** 笔中心是否落在当前区域（bbox 外扩 REGION_NEAR）内。 */
function nearRegion(bb: NormBBox): boolean {
  if (!regBbox) return false;
  const cx = bb[0] + bb[2] / 2, cy = bb[1] + bb[3] / 2;
  return cx >= regBbox[0] - REGION_NEAR && cx <= regBbox[0] + regBbox[2] + REGION_NEAR
    && cy >= regBbox[1] - REGION_NEAR && cy <= regBbox[1] + regBbox[3] + REGION_NEAR;
}
/**
 * 诊断：远笔触发收口时，记下新笔中心相对"区域外扩框"的越界量（>0=越界多少，<0=其实还在框内）。
 * overX/overY 哪个为正就是被哪个轴甩出去的；越界量很小（如 0.01–0.03）= 阈值偏紧把连续书写切碎。
 */
function nearDiag(bb: NormBBox): Record<string, number> {
  if (!regBbox) return {};
  const cx = bb[0] + bb[2] / 2, cy = bb[1] + bb[3] / 2;
  const overR = cx - (regBbox[0] + regBbox[2] + REGION_NEAR), overL = (regBbox[0] - REGION_NEAR) - cx;
  const overB = cy - (regBbox[1] + regBbox[3] + REGION_NEAR), overT = (regBbox[1] - REGION_NEAR) - cy;
  return { cx: +cx.toFixed(4), cy: +cy.toFixed(4), overX: +Math.max(overL, overR).toFixed(4), overY: +Math.max(overT, overB).toFixed(4) };
}

/** 区域收口的原因（进 dev 通道，定位"连续书写被切到新区"）。 */
type FlushReason = 'far-stroke' | 'quiet-6s' | 'manual' | 'view-switch';

/** 收口当前区域 → 解析成一个 mark（异步识别在 resolveRegion 内）。reason/diag 镜像到遥测。 */
export function flushRegion(reason: FlushReason = 'manual', diag: Record<string, number> | null = null): void {
  window.clearTimeout(regTimer);
  const events = regEvents, strokes = regStrokes, rawRefs = regRawRefs;
  const heldMs = regFirstAt ? Math.round(performance.now() - regFirstAt) : 0;
  const regAt = regBbox ? regBbox.map((n) => +n.toFixed(4)) : null;
  regEvents = []; regStrokes = []; regRawRefs = []; regBbox = null; regFirstAt = 0; sessionTrace = null;
  bus.emit('region:clear'); // dev 可视：区域收口 → 清叠层
  if (events.length) void resolveRegion(events, strokes, { reason, heldMs, regBbox: regAt, ...(diag ?? {}) }, rawRefs);
}

/**
 * 进笔前段（**原版页与重排面共用**）：把一笔并进当前组装区域（空间连贯：挨着就并、走远先收口另起），
 * 重置 quiet-6s 收口定时器与 idle 综合定时器。两条进笔路径（initInk 回调 / reader:gesture）都走这里，
 * 重排面据此获得与原版页一致的「区域组装 + far-stroke + quiet-6s + idle」全套（此前重排面逐笔直冲后端、全跳过）。
 * 传入的 evt.geometry.bbox 须为该笔的紧 bbox（归一化）——nearRegion/unionBb 按笔粒度判近邻。
 */
function ingestStroke(evt: AnnotationEvent, stroke: Stroke): void {
  // 空间连贯：挨着当前区域就并进去（重置冷却）；落到远处 → 旧区先收口、此处另起一个区域。
  if (regBbox && !nearRegion(evt.geometry.bbox)) flushRegion('far-stroke', nearDiag(evt.geometry.bbox));
  regEvents.push(evt);
  regStrokes.push(stroke); // 与 regEvents 对齐（落账本时取构成笔）
  // 基岩回链：**此刻同步**取这一笔的 seq 区间（笔抬起样本已录全、尚无下一笔）→ 逐位对齐 regStrokes（关时占位 undefined）。
  // 不留到异步 resolveRegion 末尾读全局水位——那会被 far-stroke 的下一笔/captureMark await 期间的新笔污染。
  regRawRefs.push(settings.bedrock ? bedrockMarkBoundary(state.documentId ?? 'book') : undefined);
  regBbox = regBbox ? unionBb(regBbox, evt.geometry.bbox) : evt.geometry.bbox;
  if (!regFirstAt) regFirstAt = performance.now();
  window.clearTimeout(regTimer);
  // 收口只靠两个真实信号：走到别处(far-stroke) 或 停笔满 REGION_QUIET。不设书写时长上限——慢写整段保持静默。
  regTimer = window.setTimeout(() => flushRegion('quiet-6s'), REGION_QUIET_MS);
  bus.emit('region:update', { bbox: regBbox, near: REGION_NEAR }); // dev 可视：实时画当前组装区域

  // 长停顿(~1–2min)无新笔 → 对整段 session 综合回复（连续标注期间界面静默）
  if (settings.gesture.enabled) {
    const bookId = state.documentId ?? 'book';
    const idleMs = (settings.gesture.idleSeconds ?? IDLE_COMMIT_MS / 1000) * 1000;
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => { void commitSession(bookId, 'idle'); }, idleMs);
  }
}

/** 翻页/缩放重渲：丢在途的笔（属旧页），但保留 session/idle（会话跨页、翻页不是边界事件）。 */
function resetAssembly(): void {
  window.clearTimeout(regTimer);
  regEvents = []; regStrokes = []; regRawRefs = []; regBbox = null; regFirstAt = 0; sessionTrace = null;
  bus.emit('region:clear');
}

/** 设置变更/换书：清计时 + 丢当前书 session（硬复位）。 */
function cancelTimers(): void {
  window.clearTimeout(regTimer);
  window.clearTimeout(idleTimer);
  regEvents = []; regStrokes = []; regRawRefs = []; regBbox = null; regFirstAt = 0; sessionTrace = null;
  bus.emit('region:clear');
  if (state.documentId) clearSession(state.documentId);
}

/** 手势决策 = trace + 镜像到 dev 通道（让"圈了几次/每笔判成什么/有没有被并/被丢"在通道里可见）。 */
function gtrace(o: Record<string, unknown>): void {
  trace('GestureSession', o);
  devEmit('gesture', () => ({ strokeCount: Array.isArray(o.strokes) ? (o.strokes as unknown[]).length : undefined, ...o }));
}

const diagOf = (scored: ReturnType<typeof classifyScored>[]) => scored.map((s) => ({ type: s.type, score: Number(s.score.toFixed(2)) }));

/**
 * 收口一个区域：把这团笔合成一个 mark → 落笔当时取证(captureMark) → 累积进 session。
 * 关键：**每笔单独几何分类**后再判特征（不在合并乱线上重判——圈+划合并会毁掉干净的单笔模板信号）。
 * 连续标注期间界面静默；语义全交模型；手写区域收口即走唯一早提交边界（区域冷却本身已是落定）。
 */
async function resolveRegion(batch: AnnotationEvent[], strokes: Stroke[], flushInfo: Record<string, unknown> = {}, rawRefs: (RawRef | undefined)[] = []): Promise<void> {
  const pid = batch[0].page_id;
  const bookId = state.documentId ?? 'book';

  // 每笔单独分类。点按滤除要克制：**多笔且含实笔的区域里，短笔是真笔画的一部分**（汉字的点/小撇/钩、
  // 标点，行程常 <13px 或 ≤3 点 → 被 classifyScored 判 tap_region）——一律滤掉就是"手写丢笔画"的病根
  // （那些笔留在屏上、却不进 mark、不落账本，reload 后凭空消失，也不进识别图）。故只在「孤立单笔点按」
  // 或「整团都是点按」时才丢（真·误触/掌触）；其余全保留，绝不丢用户落下的笔。
  const scoredAll = batch.map((e) => classifyScored(e.stroke_points, e.geometry.bbox));
  const cand = batch.map((e, i) => ({ e, s: scoredAll[i], st: strokes[i] }));
  const realCount = scoredAll.filter((s) => s.type !== 'tap_region').length;
  const keepShortStrokes = batch.length >= 2 && realCount >= 1; // 多笔实质区域 → 短笔也留
  const keep = keepShortStrokes ? cand : cand.filter((x) => x.s.type !== 'tap_region');
  if (!keep.length) {
    gtrace({ page_id: pid, strokes: diagOf(scoredAll), resolved: '— 点按/误触，不计入', flush: flushInfo });
    return;
  }
  const droppedTaps = batch.length - keep.length; // 被滤掉的点按数（>0 即有笔未进 mark，补观测缺口）
  const realEvents = keep.map((x) => x.e);
  const realScored = keep.map((x) => x.s);
  const realStrokes = keep.map((x) => x.st);
  const strokeBboxes = realEvents.map((e) => e.geometry.bbox);
  const points = realEvents.flatMap((e) => e.stroke_points);
  const bbox = bboxOf(points);
  // 几何：判 markup（模板笔够大、跨内容），或给 freeform 标 ocrWorthy；handwriting/drawing 由 captureMark 识别定型。
  const geom = classifyStrokeFeature(realScored, strokeBboxes, points, bbox, localCharHeight(state.surfaceIndex));
  // 代表 event 的形状：markup 取最强模板笔（圈/划/箭头，带箭头方向）；否则按合并笔（自由笔=stroke）
  const domScored = geom.type === 'markup' ? realScored.find((s) => s.type === geom.raw.templateType) : undefined;
  const markScored = domScored ?? classifyScored(points, bbox);
  const repr: AnnotationEvent = { ...realEvents[realEvents.length - 1], geometry: { bbox }, stroke_points: points, event_type: markScored.type };
  const cap = await captureMark(repr, geom, markScored.score); // 识别定型 → cap.feature 是最终类型
  const feature = cap.feature;
  const mark = makeMark(repr, feature, markScored, cap.hmp, cap.markedText);
  mark.trace = cap.trace; // 落笔当时这笔经手的组件阶段（识别/OCR兜底/取证）→ 提交时拼进整轮流水线
  mark.manner = computeManner(realStrokes, feature.type); // 运笔方式（Slice A）：随 mark 进叙事
  addMark(bookId, mark);
  // 落账本（页账本 mark 条目）+ 建 笔→mark 映射（擦/撤时给整 mark 落 tombstone）
  for (const s of realStrokes) strokeMarkIds.set(s, mark.id);
  const tool: 'pen' | 'highlighter' = realStrokes.some((s) => s.tool === 'highlighter') ? 'highlighter' : 'pen';
  const raw_ref = mergeRawRefs(rawRefs); // 基岩回链：合并本区各笔在 ingestStroke 同步取的 seq 区间（精确·不受 far-stroke/await 污染）
  void appendMarkEntry({
    document_id: bookId, page_id: pid, page_index: pageIdxOf(pid), mark_id: mark.id,
    strokes: realStrokes.map((s) => ({ tool: s.tool, points: s.points })),
    bbox, tool, color: tool === 'highlighter' ? 'rgba(212,207,202,0.85)' : '#1A1A1A',
    pointer_type: repr.pointer_type, device_id: repr.device_id, abs_timestamp: Date.now(),
    context_id: getActiveContext().id,
    feature_type: feature.type, feature_confidence: feature.confidence,
    kind: cap.kind, kind_source: cap.kindSource,
    scored_type: markScored.type, scored_score: markScored.score,
    hmp: cap.hmp ? { ...cap.hmp, crop_ref: undefined, vector_ref: undefined } : null,
    marked_text: cap.markedText, raw_ref, is_tombstone: false,
  });
  gtrace({ page_id: pid, strokes: diagOf(realScored), ...(droppedTaps ? { droppedTaps } : {}), feature: feature.type, conf: Number(feature.confidence.toFixed(2)), shape: markScored.type, marked: cap.markedText.slice(0, 40), ...(raw_ref ? { raw_ref } : {}), resolved: `mark·${feature.type}（累积静默）`, flush: flushInfo });

  // 通知前端：一笔已收口定型（日记「第一段手写→标题」据此取 markedText；其它前端可忽略）。
  bus.emit('mark:resolved', { feature: feature.type, text: cap.markedText });

  // 手写 = 唯一早提交边界事件（区域冷却已落定 + 识别已可靠定型，无需再额外等）
  if (feature.type === 'handwriting') void commitSession(bookId, 'handwriting', mark);
}

/** 提交一段 session：建图 + 蒸馏 + 回应。committed 才清空 session（fold 不清、留作下次综合）。 */
async function commitSession(bookId: string, reason: 'idle' | 'handwriting', triggerMark?: Mark): Promise<void> {
  const session = peekSession(bookId);
  if (!session) return;
  // idle 综合要有实质：至少一笔手写、锚到真实正文的标记、或被识别成某物的画（带描述）。
  // 纯散笔/乱涂（none、无描述）不触发，避免无关回复——但识别出的草图（笑脸/箭头…）= 用户有意为之，停笔后交模型解读。
  if (reason === 'idle') {
    const substantial = session.marks.some((m) =>
      m.feature.type === 'handwriting'
      || ((m.hmp?.mode === 'anchored' || m.hmp?.mode === 'mixed') && !!m.markedText.trim())
      || (m.feature.type === 'drawing' && !!m.hmp?.text_hint?.trim()));
    if (!substantial) { clearSession(bookId); lastSig.delete('sess_' + bookId); return; }
  }
  const sig = session.marks.map((m) => m.id).join(',') + ':' + reason + ':' + (triggerMark?.id ?? '');
  if (lastSig.get('sess_' + bookId) === sig) return;
  lastSig.set('sess_' + bookId, sig);
  const committedIds = session.marks.map((m) => m.id); // 本批要综合的笔（综合期间新写的不在内、不被连带清掉）
  const discId = 'disc_' + (triggerMark?.id ?? committedIds[committedIds.length - 1]);
  const outcome = await commitSessionDiscussion(session, reason, triggerMark, discId);
  if (outcome === 'committed') {
    for (const id of committedIds) removeMark(bookId, id); // 只摘走已综合这批；综合期间新写的笔留作下一段（B1）
    lastSig.delete('sess_' + bookId);
  } else if (outcome === 'failed') {
    lastSig.delete('sess_' + bookId); // AI 失败：marks 保留（没摘），清 sig 让下次 idle 能就同一批重试（B2）
  }
  // folded：marks 保留 + sig 保留（不重复触发；新笔改变 sig 时再连带综合）
}

// page_id 形如 pg_{hash8}_{idx} → 取末段为页号
function pageIdxOf(pageId: string): number {
  const m = pageId.match(/_(\d+)$/);
  return m ? Number(m[1]) : state.pageIndex;
}

/**
 * 把标注会话编排挂到一块 #ink 画布上：进笔采集 + 区域组装 + 收口 + 综合 + 旁注状态/擦撤账本。
 * 桌面 main.ts 与移动版各自调用一次、传各自的 ink 画布；编排逻辑单一来源、不分叉。
 */
export function wireAnnotationLoop(inkLayer: HTMLCanvasElement): void {
  initInk(inkLayer, (stroke, pointerType, penUpAt) => {
    signalInkArea(bboxOf(stroke.points)); // 电纸屏：该笔局部 A2 快刷（先于事件判定即刷；web/dev 无桥 no-op）
    if (!sessionTrace) sessionTrace = shortId('trc'); // 一段区域的笔共享 trace（recordEvent 要打点/计延迟，原版页专属）
    const evt = recordEvent(stroke, sessionTrace, pointerType, penUpAt);
    if (!evt) return;
    ingestStroke(evt, stroke); // 进共用组装前段：far-stroke / quiet-6s / idle
  });

  // 设置变化时取消在途计时（避免旧设置下的延迟触发）
  bus.on('settings:changed', cancelTimers);

  // 重排面手势 = 正常 page-ledger mark：reader 把命中块的 PDF-norm 事件发来，走与原版页**同一条进笔前段**
  // （ingestStroke：区域组装 + far-stroke + quiet-6s + idle 综合），不再逐笔直冲后端 resolveRegion。
  // 坐标已在 reader 侧映回原页归一化空间；evt.geometry.bbox 为该笔紧 bbox（reader.makeEvent 已改）。
  bus.on('reader:gesture', (p) => {
    const { event, stroke } = p as { event: AnnotationEvent; stroke: Stroke };
    // 笔迹即时进 PDF 页 strokesByPage（原版页 redraw 用它）→ 切回原版立刻可见；reload 由 mark 账本重建。
    const arr = state.strokesByPage.get(event.page_id) ?? [];
    arr.push(stroke);
    state.strokesByPage.set(event.page_id, arr);
    // 关键：把笔同步重绘到 #ink-layer。识别图(grabLayers)是从 #ink-layer 裁的，而重排面的笔只画在自己的
    // #reader-ink 画布上 → 不重绘 #ink-layer 就会裁到**空白**、识别恒返 none、手写永远采集不到。
    // #ink-layer 在重排模式下 display:none 但 canvas 位图照常可画（已验证）。redrawInk 读 strokesByPage[当前页]。
    redrawInk();
    // 注：reader 的 trace_id 是逐笔的（reader.makeEvent 自带），不共享 sessionTrace——mark 身份是 repr.event_id，无下游影响。
    ingestStroke(event, stroke); // 与原版页同一前段 → 多笔组装、quiet-6s 收口、idle 综合全接通
  });

  // AI 旁注持久化在书日志：新轮由 pipeline 提交时 append ai_turn；替换由同 overlay_id 的新条目折叠覆盖。
  // 这里只处理用户对卡片的状态变化（接受/编辑/忽略）→ 追加 supersedes 的新 ai_turn 记新状态/改写文本。
  bus.on('overlay:state', (o) => {
    const ov = o as ScreenOverlay;
    if (state.documentId) void updateOverlayState(state.documentId, ov);
  });

  // 擦/撤一笔 → 给整 mark 落 tombstone（append-only）+ 从 pending session 移除（别再进下次综合）
  bus.on('mark:erase', (mid) => {
    const markId = mid as string;
    const bookId = state.documentId ?? 'book';
    removeMark(bookId, markId);
    void appendMarkEntry({
      document_id: bookId, page_id: state.pageId ?? '', page_index: state.pageIndex, mark_id: markId,
      strokes: [], bbox: [0, 0, 0, 0], tool: 'pen', color: '',
      pointer_type: 'unknown', device_id: DEVICE_ID, abs_timestamp: Date.now(),
      context_id: getActiveContext().id,
      feature_type: 'drawing', feature_confidence: 0, scored_type: 'stroke', scored_score: 0,
      hmp: null, marked_text: '', is_tombstone: true,
    });
  });

  // 撤一条**尚未组装成 mark** 的在途笔（两面 6s 内擦/识别异步期）：从 pending 组装队列 + strokesByPage 移除、重画 #ink-layer。
  // 不发 tombstone（它还没持久化成 mark）；与 mark:erase（已成 mark→落 tombstone）互补。彻底堵"擦了却 6s 后仍 assemble 成 mark/复活"。
  bus.on('stroke:cancel', (s) => {
    const stroke = s as Stroke;
    const i = regStrokes.indexOf(stroke);
    if (i >= 0) {
      regStrokes.splice(i, 1); regEvents.splice(i, 1); regRawRefs.splice(i, 1); // 三者逐位对齐
      regBbox = regEvents.length ? regEvents.map((e) => e.geometry.bbox).reduce(unionBb) : null;
      if (!regEvents.length) { window.clearTimeout(regTimer); regFirstAt = 0; }
      if (regBbox) bus.emit('region:update', { bbox: regBbox, near: REGION_NEAR }); else bus.emit('region:clear');
    }
    for (const arr of state.strokesByPage.values()) { const j = arr.indexOf(stroke); if (j >= 0) { arr.splice(j, 1); break; } } // 移页坐标副本
    redrawInk(); // 重画 #ink-layer（识别图/原版页据它）
  });

  // 翻页（非缩放重渲）：丢在途的笔，但 session/idle 跨页保留（翻页不是边界事件）。
  // 仅在 page_id 真变时复位（缩放重渲不复位）；阅读位置记录留在各前端 chrome 里。
  let lastPageId: string | null = null;
  bus.on('page:rendered', () => {
    if (state.pageId !== lastPageId) { lastPageId = state.pageId; resetAssembly(); }
  });
}
