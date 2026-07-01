// 标注会话编排（与具体 DOM id 无关，桌面与移动版共用）：
// 进笔 → 区域组装（空间+时间连续）→ 收口成 mark → 落账本 → 长停顿/手写综合 → AI 旁注。
// 从 main.ts 抽出，wireAnnotationLoop(inkLayer) 挂上 initInk + 相关 bus 监听；各前端各传自己的 #ink 画布。
import { recordEvent, captureMark, commitSessionDiscussion, recognizeInk } from '../core/pipeline';
import { pointInPolygon } from '../evidence/focus';
import { grabLayers } from '../evidence/ocr';
import { classifyScored, classifyStrokeFeature, bboxOf, CLS_BASIS } from '../capture/classify';
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
import { appendMarkEntry, updateOverlayState, getFoldedMarks } from '../local/store';
import type { ScreenOverlay, AnnotationEvent, NormBBox } from '../core/contracts';
import { initInk, redrawInk } from '../capture/ink';
import { rasterizeStrokes } from '../capture/rasterize';
import { normToPx, pageCss } from '../core/transform';
import { signalInkArea } from '../surface/eink';
import { bedrockMarkBoundary } from '../local/bedrock-recorder';
import type { RawRef } from '../core/bedrock';
import type { PersistedStroke } from '../core/store-format';

// 区域组装（空间+时间连续）：同一小块区域里继续写的笔画并进一个 mark；附近无动作满 REGION_QUIET 才提交；
// 笔落到远处=离开该区域 → 上一区域立刻收口。无书写时长上限——慢写整段保持静默、聚成一整团再识别（读得准、只回一条）。
// 附近无动作多久 → 收口提交：走 settings.regionQuietMs（默认 1s·dev 页可调）。调短=识别反馈快；
// 句中思考停顿会拆碎成多个 mark，但 session 图会串回一段叙事，语义不丢。
const REGION_NEAR = 0.06;         // "附近"：笔中心在区域 bbox 外扩此值内算同区（归一化·基础半径）
const REGION_READER_QUICK_MS = 2500; // reader 面"连续快写"时间窗：≤此间隔的下一笔才用 near_pad 放宽半径；慢停后仍按 REGION_NEAR 分区

let sessionTrace: string | null = null;
let idleTimer: number | undefined;     // 长停顿(~1–2min) → 对整段 session 综合回复
const lastSig = new Map<string, string>(); // 防重复提交（按 book）

// 当前挂起的"区域"（单活跃区：写在一处会聚起来；落到远处则旧区先收口、此处另起）。
let regEvents: AnnotationEvent[] = [];
let regStrokes: Stroke[] = []; // 与 regEvents 对齐：组装时给每构成笔建 笔→mark 映射（擦/撤定位整 mark）
let regBbox: NormBBox | null = null;       // 几何 bbox（重排=按块映射的 PDF 归一化）：最终 mark bbox + unionBb 累积。
let regNearBbox: NormBBox | null = null;   // 近邻判定专用 bbox：原版页=同 geometry；重排=屏幕空间（evt.near_bbox）——
                                           // 解决"重排把源 PDF 散落的行重排紧密→跨块连续笔在 PDF 归一化空间被判 far→组装碎成单笔 mark"。
let regNearPad = REGION_NEAR;              // 当前区域的近邻外扩半径（取区内各笔 near_pad 的 max·reader 按行高放宽）。
let regFirstAt = 0;
let regLastAt = 0;                         // 上一笔 ingest 时刻（performance.now）→ 算笔间隔 gapMs，判是否"连续快写"放宽半径。
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
/** 近邻判定用的 bbox：重排带屏幕空间 near_bbox（跨块视觉相邻才算近）；原版页无 → 用几何 bbox（=屏幕）。 */
function nearBoxOf(evt: AnnotationEvent): NormBBox { return evt.near_bbox ?? evt.geometry.bbox; }
/** 该笔的近邻外扩半径（reader 按行高带 near_pad·原版页缺=基础 REGION_NEAR）。 */
function nearPadOf(evt: AnnotationEvent): number { return Math.max(REGION_NEAR, evt.near_pad ?? REGION_NEAR); }
/** 当前区内各笔 near_pad 的 max（撤笔后重算用）。 */
function regionNearPad(): number { return regEvents.reduce((m, e) => Math.max(m, nearPadOf(e)), REGION_NEAR); }
function bboxOfSurface(points: Array<{ x: number; y: number }>): NormBBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return Number.isFinite(x0) ? [x0, y0, x1 - x0, y1 - y0] : [0, 0, 0, 0];
}
function persistedStrokeOf(evt: AnnotationEvent, stroke: Stroke): PersistedStroke {
  const ps: PersistedStroke = {
    tool: stroke.tool,
    points: stroke.points,
    coord_space: evt.coord_space ?? 'page_norm',
    capture_surface: evt.capture_surface ?? (evt.pointer_type === 'reader' ? 'reader' : 'page'),
    ...(evt.reader_layout_id ? { reader_layout_id: evt.reader_layout_id } : {}),
    ...(evt.anchor_runs?.length ? { anchor_runs: evt.anchor_runs } : {}),
    ...(evt.coord_px_per_norm ? { coord_px_per_norm: evt.coord_px_per_norm } : {}), // 块本地投影标记：重投影据此选逆运算
  };
  if (evt.reflow_ink_points?.length) {
    ps.surface_points = evt.reflow_ink_points;
    ps.surface_coord_space = 'reader_px';
    ps.surface_bbox = bboxOfSurface(evt.reflow_ink_points);
  }
  return ps;
}
/** 笔中心是否落在当前区域（bbox 外扩 REGION_NEAR）内。比的是 regNearBbox（与 nearBoxOf 同空间）。 */
function nearRegion(bb: NormBBox, pad = REGION_NEAR): boolean {
  if (!regNearBbox) return false;
  const cx = bb[0] + bb[2] / 2, cy = bb[1] + bb[3] / 2;
  return cx >= regNearBbox[0] - pad && cx <= regNearBbox[0] + regNearBbox[2] + pad
    && cy >= regNearBbox[1] - pad && cy <= regNearBbox[1] + regNearBbox[3] + pad;
}
/**
 * 诊断：远笔触发收口时，记下新笔中心相对"区域外扩框"的越界量（>0=越界多少，<0=其实还在框内）。
 * overX/overY 哪个为正就是被哪个轴甩出去的；越界量很小（如 0.01–0.03）= 阈值偏紧把连续书写切碎。
 */
function nearDiag(bb: NormBBox, pad = REGION_NEAR, gapMs = 0): Record<string, number> {
  if (!regNearBbox) return {};
  const cx = bb[0] + bb[2] / 2, cy = bb[1] + bb[3] / 2;
  const overR = cx - (regNearBbox[0] + regNearBbox[2] + pad), overL = (regNearBbox[0] - pad) - cx;
  const overB = cy - (regNearBbox[1] + regNearBbox[3] + pad), overT = (regNearBbox[1] - pad) - cy;
  return { cx: +cx.toFixed(4), cy: +cy.toFixed(4), near: +pad.toFixed(4), ...(gapMs ? { gapMs } : {}), overX: +Math.max(overL, overR).toFixed(4), overY: +Math.max(overT, overB).toFixed(4) };
}

/**
 * 笔触划分（Phase P 的门）：这一笔是否进 AI 管线。
 *  · settings.aiTrigger==='auto'（自动判意·实验）→ 每笔都进（旧行为：手写定向 + 长停顿综合）。
 *  · 'pen'（AI 笔触·默认）→ 只有「AI 笔」(tool==='aipen') 进；普通笔/荧光 = 纯内容。
 */
function strokeEntersAI(stroke: Stroke): boolean {
  if (settings.aiTrigger === 'auto') return true;
  return stroke.tool === 'aipen';
}

// 内容笔写库串行化 + 水位：①AI 笔"刚写完普通墨就圈"时，getFoldedMarks 要先读到这些刚写的笔（否则圈不到·P2 race）；
// ②写完发 `mark:resolved`（feature:'drawing'）驱动【日记新页物化/标题候选(mobile-main) · 会议笔数+时间脊(meeting) · reader 旧笔重画】——
// 普通笔绕过 resolveRegion 后这些本会静默不动（intent review 头号回归）。会议时间脊那侧自己去抖、防逐笔过刷。
let contentMarkWrites: Promise<void> = Promise.resolve();
function enqueueContentMark(entry: Parameters<typeof appendMarkEntry>[0]): void {
  contentMarkWrites = contentMarkWrites.catch(() => undefined).then(async () => {
    await appendMarkEntry(entry);
    bus.emit('mark:resolved', { feature: 'drawing', text: '' });
  });
}
async function waitContentMarks(): Promise<void> {
  try { await contentMarkWrites; } catch { /* appendMarkEntry best-effort */ }
}

/**
 * 普通笔（纯内容）落库：**不进**区域组装/captureMark/识别/AI/叠层，只把这一笔作为内容 mark 落账本
 * （reload 可还原 + 可擦）。与 resolveRegion 的 AI mark 唯一差别：跳过 captureMark（不调 /api/interpret）、
 * 不进 session、不综合；标 ai_eligible:false（getPendingMarks 据此排除，reload 不会把它塞回 AI）。
 * 立即落库（无 6s pending 窗）→ 擦它直接走 mark:erase 落 tombstone。
 */
function persistContentStroke(evt: AnnotationEvent, stroke: Stroke): void {
  const bookId = state.documentId ?? 'book';
  const markId = evt.event_id;
  strokeMarkIds.set(stroke, markId); // 擦/撤定位整 mark（单笔内容 mark）
  const isHi = stroke.tool === 'highlighter';
  enqueueContentMark({
    document_id: bookId, page_id: evt.page_id, page_index: pageIdxOf(evt.page_id), mark_id: markId,
    strokes: [persistedStrokeOf(evt, stroke)],
    bbox: evt.geometry.bbox, tool: isHi ? 'highlighter' : 'pen',
    coord_space: evt.coord_space ?? 'page_norm',
    capture_surface: evt.capture_surface ?? (evt.pointer_type === 'reader' ? 'reader' : 'page'),
    ...(evt.reflow_ink_points?.length ? { surface_bbox: bboxOfSurface(evt.reflow_ink_points), surface_coord_space: 'reader_px' as const } : {}),
    ...(evt.reader_layout_id ? { reader_layout_id: evt.reader_layout_id } : {}),
    color: isHi ? 'rgba(212,207,202,0.85)' : '#1A1A1A',
    pointer_type: evt.pointer_type, device_id: evt.device_id, abs_timestamp: Date.now(),
    context_id: getActiveContext().id,
    feature_type: 'drawing', feature_confidence: 0, // 内容笔不识别：中性 drawing 占位（消费方靠 ai_eligible:false 区分）
    scored_type: 'stroke', scored_score: 0,
    hmp: null, marked_text: '', is_tombstone: false,
    ai_eligible: false, origin: isHi ? 'highlighter' : 'pen',
    raw_ref: settings.bedrock ? bedrockMarkBoundary(bookId) : undefined,
    ...(evt.anchor_runs?.length ? { reflow_anchor_runs: evt.anchor_runs } : {}),
  });
}

/** 区域收口的原因（进 dev 通道，定位"连续书写被切到新区"）。 */
type FlushReason = 'far-stroke' | `quiet-${number}ms` | 'manual' | 'view-switch';

/** 收口当前区域 → 解析成一个 mark（异步识别在 resolveRegion 内）。reason/diag 镜像到遥测。 */
export function flushRegion(reason: FlushReason = 'manual', diag: Record<string, number> | null = null): void {
  window.clearTimeout(regTimer);
  const events = regEvents, strokes = regStrokes, rawRefs = regRawRefs;
  const heldMs = regFirstAt ? Math.round(performance.now() - regFirstAt) : 0;
  const regAt = regBbox ? regBbox.map((n) => +n.toFixed(4)) : null;
  regEvents = []; regStrokes = []; regRawRefs = []; regBbox = null; regNearBbox = null; regNearPad = REGION_NEAR; regFirstAt = 0; regLastAt = 0; sessionTrace = null;
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
  // 近邻判定用 nearBoxOf（重排=屏幕空间·跨块视觉相邻才算近），不用按块映射的 geometry.bbox（否则重排跨行连笔被判 far 而碎）。
  const nb = nearBoxOf(evt);
  // 是否放宽近邻半径：仅 reader 笔（带 near_bbox）且与上一笔间隔 ≤ REGION_READER_QUICK_MS（连续快写）→ 用按行高的 near_pad；
  // 否则（原版页 / 慢停后 / 远处另起）回到基础 REGION_NEAR——避免把真·独立标注粘成一团。
  const now = performance.now();
  const gapMs = regLastAt ? now - regLastAt : 0;
  const evtPad = nearPadOf(evt);
  const joinPad = evt.near_bbox && (!regLastAt || gapMs <= REGION_READER_QUICK_MS)
    ? Math.max(regNearPad, evtPad)
    : REGION_NEAR;
  if (regNearBbox && !nearRegion(nb, joinPad)) flushRegion('far-stroke', nearDiag(nb, joinPad, Math.round(gapMs)));
  regEvents.push(evt);
  regStrokes.push(stroke); // 与 regEvents 对齐（落账本时取构成笔）
  // 基岩回链：**此刻同步**取这一笔的 seq 区间（笔抬起样本已录全、尚无下一笔）→ 逐位对齐 regStrokes（关时占位 undefined）。
  // 不留到异步 resolveRegion 末尾读全局水位——那会被 far-stroke 的下一笔/captureMark await 期间的新笔污染。
  regRawRefs.push(settings.bedrock ? bedrockMarkBoundary(state.documentId ?? 'book') : undefined);
  regBbox = regBbox ? unionBb(regBbox, evt.geometry.bbox) : evt.geometry.bbox;
  regNearBbox = regNearBbox ? unionBb(regNearBbox, nb) : nb;
  regNearPad = Math.max(regNearPad, evtPad);
  if (!regFirstAt) regFirstAt = now;
  regLastAt = now;
  window.clearTimeout(regTimer);
  // 收口只靠两个真实信号：走到别处(far-stroke) 或 停笔满 REGION_QUIET。不设书写时长上限——慢写整段保持静默。
  const quietMs = settings.regionQuietMs || 1000;
  regTimer = window.setTimeout(() => flushRegion(`quiet-${quietMs}ms`), quietMs);
  bus.emit('region:update', { bbox: regBbox, near: regNearPad }); // dev 可视：实时画当前组装区域

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
  regEvents = []; regStrokes = []; regRawRefs = []; regBbox = null; regNearBbox = null; regNearPad = REGION_NEAR; regFirstAt = 0; regLastAt = 0; sessionTrace = null;
  bus.emit('region:clear');
}

/** 设置变更/换书：清计时 + 丢当前书 session（硬复位）。 */
function cancelTimers(): void {
  window.clearTimeout(regTimer);
  window.clearTimeout(idleTimer);
  regEvents = []; regStrokes = []; regRawRefs = []; regBbox = null; regNearBbox = null; regNearPad = REGION_NEAR; regFirstAt = 0; regLastAt = 0; sessionTrace = null;
  bus.emit('region:clear');
  if (state.documentId) clearSession(state.documentId);
}

/** 手势决策 = trace + 镜像到 dev 通道（让"圈了几次/每笔判成什么/有没有被并/被丢"在通道里可见）。 */
function gtrace(o: Record<string, unknown>): void {
  trace('GestureSession', o);
  devEmit('gesture', () => ({ strokeCount: Array.isArray(o.strokes) ? (o.strokes as unknown[]).length : undefined, ...o }));
}

const diagOf = (scored: ReturnType<typeof classifyScored>[]) => scored.map((s) => ({ type: s.type, score: Number(s.score.toFixed(2)) }));

type Pt = { x: number; y: number };
type EnclosedInk = { text: string; bbox: NormBBox; ink: string; points: AnnotationEvent['stroke_points']; count: number };
const EPS = 1e-6;

function reflowInkRefOf(events: AnnotationEvent[], strokes: Stroke[]): string | undefined {
  const rs = events
    .map((evt, i) => evt.reflow_ink_points?.length ? { tool: strokes[i].tool, points: evt.reflow_ink_points } : null)
    .filter((x): x is { tool: Stroke['tool']; points: AnnotationEvent['stroke_points'] } => !!x);
  if (rs.length) return rasterizeStrokes(rs);
  return events.length === 1 ? events[0].reflow_ink_ref : undefined;
}

// M103 日记白板零画布：#ink-layer 不再逐笔画，AI 识别不能抓可见画布(得白图=大忌·点串云端不消费)。改从账本
// page_norm 点串离屏栅格化白底笔迹图当 layers.ink——真相在点串、与画布解耦。只对白板 self_content 生效(见 resolveRegion 门控)。
function pageInkRefOf(strokes: Stroke[]): string | undefined {
  if (!pageCss.w || !pageCss.h) return undefined; // 页未渲染(dims 0)→无从换算·退回(captureMark 会 fallback grabLayers)
  const rs = strokes
    .filter((s) => s.points.length)
    .map((s) => ({ tool: s.tool, points: s.points.map((p) => ({ ...normToPx(p.x, p.y), t: p.t, pressure: p.pressure })) }));
  return rs.length ? rasterizeStrokes(rs) : undefined;
}

const isStrongMarkup = (s: ReturnType<typeof classifyScored>): boolean =>
  (s.type === 'circle' || s.type === 'underline' || s.type === 'arrow') && s.score >= 0.55;

/** 单笔分类：块本地投影的 reader 事件喂原生 reflow px（基准配平）——分类阈值是像素语义，
 *  不该随 canonical 除数变化；其余（原版页/白板/老事件）照旧走 canonical + pageCss。 */
function scoredOfEvent(e: AnnotationEvent): ReturnType<typeof classifyScored> {
  const rp = e.reflow_ink_points;
  if (e.coord_px_per_norm && rp?.length) {
    const pts = rp.map((p) => ({ x: p.x / CLS_BASIS, y: p.y / CLS_BASIS, t: p.t, pressure: p.pressure }));
    return classifyScored(pts, bboxOf(pts), CLS_BASIS, CLS_BASIS);
  }
  return classifyScored(e.stroke_points, e.geometry.bbox);
}
/** reader 块本地批次的分类 dims：canonical norm × 该值 = 真实 reader px（各笔取中位·跨面混批不启用）。 */
function readerClsDim(events: AnnotationEvent[]): number | undefined {
  if (!events.length || !events.every((e) => e.coord_px_per_norm)) return undefined;
  const xs = events.map((e) => e.coord_px_per_norm!).sort((a, b) => a - b);
  return xs[xs.length >> 1];
}

function boxCenter(b: NormBBox): Pt { return { x: b[0] + b[2] / 2, y: b[1] + b[3] / 2 }; }
function pointInInflatedBox(p: Pt, b: NormBBox, pad: number): boolean {
  return p.x >= b[0] - pad && p.x <= b[0] + b[2] + pad && p.y >= b[1] - pad && p.y <= b[1] + b[3] + pad;
}

/**
 * 一口气「先圈正文，再在旁边写问题」会被空间组装并成同一 mark。
 * 若第一笔是明确 markup，后续多笔明显落在它旁边，就拆成：圈选 mark + 手写 mark。
 */
function shouldSplitLeadingMarkup(batch: AnnotationEvent[], scored: ReturnType<typeof classifyScored>[]): boolean {
  if (batch.length < 3 || !isStrongMarkup(scored[0])) return false;
  const tail = scored.slice(1);
  if (tail.length < 2) return false;
  const tailReal = tail.filter((s) => s.type !== 'tap_region').length;
  if (tailReal < 1) return false;
  const firstBox = nearBoxOf(batch[0]);
  const tailBoxes = batch.slice(1).map(nearBoxOf);
  const tailBox = tailBoxes.reduce(unionBb);
  // leading underline 多是中文字的首横/长横被单笔模板误判 → 用 reader 行高尺度的 guard（紧凑手写不拆）；其余 markup 仍用 0.025。
  const guardPad = scored[0].type === 'underline' ? Math.max(0.025, Math.min(0.08, nearPadOf(batch[0]))) : 0.025;
  if (pointInInflatedBox(boxCenter(tailBox), firstBox, guardPad)) return false; // 多笔重描同一个圈/紧凑手写首横，不拆
  const tailTemplateDominant = tail.filter(isStrongMarkup).length >= Math.ceil(tail.length * 0.75);
  return !tailTemplateDominant;
}

/**
 * 「先写内容 → 再圈起来（→ 接着写问题）」：圈在批次**中段**时 shouldSplitLeadingMarkup 管不到，
 * 整团会被并成一个 mark、freeform 识别只捞出图里最清楚的一句，真实内容在识别那步丢掉。
 * 判据：中段某笔是强圈选、且圈住了**它之前** ≥2 笔的中心 → 返回该笔下标，调用方在此处拆分。
 * 汉字包围结构（口/回/国…）天然不满足——外框先画、圈不住"之前"的笔；只有圈自己刚写的内容才命中。
 * 只认 circle：underline/arrow 出现在书写中段十有八九是长横/连笔误判，不拆。
 */
export function findMidMarkupIndex(batch: AnnotationEvent[], scored: ReturnType<typeof classifyScored>[]): number {
  if (batch.length < 3) return -1;
  for (let i = 1; i < batch.length; i++) {
    const s = scored[i];
    if (s.type !== 'circle' || s.score < 0.55) continue;
    const poly = batch[i].stroke_points;
    if (poly.length < 8) continue; // 点数太少不构成可信闭环
    const enclosedPrior = batch.slice(0, i).filter((e) => {
      const c = boxCenter(e.geometry.bbox);
      return pointInPolygon(c.x, c.y, poly);
    }).length;
    if (enclosedPrior >= 2) return i;
  }
  return -1;
}

/**
 * 「AI 笔圈普通内容」＝选择手势（笔触划分设计：普通笔=纯内容不进 AI·AI 笔=唯一进 AI，圈普通墨迹即把它选给 AI 读）：
 * 批内 circle-ish 笔圈住了本页**已落库普通内容墨迹**（ai_eligible:false mark 的中心）→ 在该笔处拆分，
 * 拆出的圈 mark 收口时由 recognizeEnclosedInk 识别被圈内容（marked_text+证据图），narrative 变成
 * 「圈『被圈内容』，随即写下『问题』」——AI 拿到真实内容而不是把圈+问题混成一团乱码识别。
 * 阈值放宽到 0.45（与 classifyStrokeFeature 的 markup 门同格）：手绘椭圆常在 0.5 上下，
 * isStrongMarkup 的 0.55 够不着（真机 evt_6e4bb782=0.52 未拆的直接病根）；语义前提（圈住已有内容）
 * 天然防误拆——写字不会圈住自己已落库的旧墨迹。日记/会议手记同一条白板路径，会议场景直接复用。
 */
export async function findContentEnclosureIndex(
  batch: AnnotationEvent[],
  scored: ReturnType<typeof classifyScored>[],
  pid: string,
  bookId: string,
): Promise<number> {
  if (batch.length < 2) return -1; // 单笔批次没得拆（也防拆出的圈段递归再匹配死循环）
  const cand = batch
    .map((e, i) => ({ e, s: scored[i], i }))
    .filter(({ e, s }) => s.type === 'circle' && s.score >= 0.45 && e.stroke_points.length >= 8);
  if (!cand.length) return -1;
  await waitContentMarks(); // 「写完就圈」内容笔可能还没落库
  let marks;
  try { marks = await getFoldedMarks(bookId); } catch { return -1; }
  const content = marks.filter((m) => m.page_id === pid && m.ai_eligible === false && m.bbox[2] > 0 && m.bbox[3] > 0);
  if (!content.length) return -1;
  for (const { e, i } of cand) {
    if (content.some((m) => pointInPolygon(m.bbox[0] + m.bbox[2] / 2, m.bbox[1] + m.bbox[3] / 2, e.stroke_points))) return i;
  }
  return -1;
}

function bboxCorners(b: NormBBox): Pt[] {
  const [x, y, w, h] = b;
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}
function pointInBBox(p: Pt, b: NormBBox): boolean {
  return p.x >= b[0] - EPS && p.x <= b[0] + b[2] + EPS && p.y >= b[1] - EPS && p.y <= b[1] + b[3] + EPS;
}
function orient(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function onSeg(a: Pt, b: Pt, p: Pt): boolean {
  return Math.abs(orient(a, b, p)) <= EPS && p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS
    && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;
}
function segIntersects(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if ((o1 > EPS && o2 < -EPS || o1 < -EPS && o2 > EPS) && (o3 > EPS && o4 < -EPS || o3 < -EPS && o4 > EPS)) return true;
  return onSeg(a, b, c) || onSeg(a, b, d) || onSeg(c, d, a) || onSeg(c, d, b);
}
function bboxIntersectsPolygon(b: NormBBox, poly: AnnotationEvent['stroke_points']): boolean {
  if (poly.length < 3) return false;
  const corners = bboxCorners(b);
  if (pointInPolygon(b[0] + b[2] / 2, b[1] + b[3] / 2, poly)) return true;
  if (corners.some((p) => pointInPolygon(p.x, p.y, poly))) return true;
  if (poly.some((p) => pointInBBox(p, b))) return true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], c = poly[(i + 1) % poly.length];
    for (let j = 0; j < corners.length; j++) {
      if (segIntersects(a, c, corners[j], corners[(j + 1) % corners.length])) return true;
    }
  }
  return false;
}

/**
 * P2「AI 笔圈普通墨」：AI 笔画了个圈 → 找本页被它圈住的普通墨标记（ai_eligible:false），并集截图识别成文字当所标内容。
 * 命中不再只看 bbox 中心：中心/角点/圈线相交/圈在 bbox 内都算，避免用户圈到普通墨边缘却漏掉。
 * 识别空也保留被圈墨迹图，提交阶段会把图交给主模型兜底理解。
 */
async function recognizeEnclosedInk(polygon: AnnotationEvent['stroke_points'], pid: string, bookId: string): Promise<EnclosedInk | null> {
  await waitContentMarks(); // 等刚写的普通墨真落库（否则"写完就圈"读到旧账本·圈不到）
  let marks;
  try { marks = await getFoldedMarks(bookId); } catch { return null; }
  const enc = marks.filter((m) => m.page_id === pid && m.ai_eligible === false && m.bbox[2] > 0 && m.bbox[3] > 0
    && bboxIntersectsPolygon(m.bbox, polygon))
    .sort((a, b) => (a.abs_timestamp - b.abs_timestamp) || (a.seq - b.seq));
  if (!enc.length) return null;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0; // 被圈墨迹并集 bbox
  for (const m of enc) { x0 = Math.min(x0, m.bbox[0]); y0 = Math.min(y0, m.bbox[1]); x1 = Math.max(x1, m.bbox[0] + m.bbox[2]); y1 = Math.max(y1, m.bbox[1] + m.bbox[3]); }
  if (state.pageId !== pid) return null; // await 期间翻页/切面 → 当前 canvas 已非目标页，别裁错
  // 优先从被圈标注自己的持久化点串离屏栅格化（和 pageInkRefOf 同款模式）：白板/日记页 #ink-layer 平时是空的，
  // grabLayers 画布截屏在这种"零画布"场景截出来是空白图；点串栅格化真相不依赖画布当时是否画着。
  // 原版页面（#ink-layer 平时有内容）栅格化拿不到时才退回 grabLayers 兜底。
  const ink = rasterizeStrokes(enc.flatMap((m) => m.strokes.map((s) => ({
    tool: s.tool as Stroke['tool'],
    points: s.points.map((p) => ({ ...normToPx(p.x, p.y), t: p.t, pressure: p.pressure })),
  })))) ?? grabLayers([x0, y0, x1 - x0, y1 - y0], 0.02).ink;
  if (!ink) return null;
  const points = enc.flatMap((m) => m.strokes.flatMap((s) => s.points)); // 端侧 HWR 要点序
  try {
    const r = await recognizeInk(ink, points);
    return { text: (r.reading || r.description || '').trim(), bbox: [x0, y0, x1 - x0, y1 - y0], ink, points, count: enc.length };
  } catch {
    return { text: '', bbox: [x0, y0, x1 - x0, y1 - y0], ink, points, count: enc.length };
  }
}

/**
 * 收口一个区域：把这团笔合成一个 mark → 落笔当时取证(captureMark) → 累积进 session。
 * 关键：**每笔单独几何分类**后再判特征（不在合并乱线上重判——圈+划合并会毁掉干净的单笔模板信号）。
 * 连续标注期间界面静默；语义全交模型；手写区域收口即走唯一早提交边界（区域冷却本身已是落定）。
 */
async function resolveRegion(batch: AnnotationEvent[], strokes: Stroke[], flushInfo: Record<string, unknown> = {}, rawRefs: (RawRef | undefined)[] = []): Promise<void> {
  const pid = batch[0].page_id;
  const bookId = state.documentId ?? 'book';
  const scoredAll = batch.map(scoredOfEvent);
  if (shouldSplitLeadingMarkup(batch, scoredAll)) {
    gtrace({ page_id: pid, split: 'leading-markup', first: diagOf([scoredAll[0]])[0], tail: diagOf(scoredAll.slice(1)), flush: flushInfo });
    await resolveRegion(batch.slice(0, 1), strokes.slice(0, 1), { ...flushInfo, split: 'leading-markup:first' }, rawRefs.slice(0, 1));
    await resolveRegion(batch.slice(1), strokes.slice(1), { ...flushInfo, split: 'leading-markup:tail' }, rawRefs.slice(1));
    return;
  }
  // 圈在中段（写内容→圈→接着问）：在圈处拆成 内容 / 圈选 /（如有）后续 三段，各自独立收口。
  // 尾段递归——用户连圈两轮时后半段自己再拆；头段是被圈住的书写，天然不再命中。
  const mid = findMidMarkupIndex(batch, scoredAll);
  if (mid > 0) {
    gtrace({ page_id: pid, split: 'mid-markup', at: mid, markup: diagOf([scoredAll[mid]])[0], head: diagOf(scoredAll.slice(0, mid)), tail: diagOf(scoredAll.slice(mid + 1)), flush: flushInfo });
    await resolveRegion(batch.slice(0, mid), strokes.slice(0, mid), { ...flushInfo, split: 'mid-markup:content' }, rawRefs.slice(0, mid));
    await resolveRegion(batch.slice(mid, mid + 1), strokes.slice(mid, mid + 1), { ...flushInfo, split: 'mid-markup:markup' }, rawRefs.slice(mid, mid + 1));
    if (batch.length > mid + 1) await resolveRegion(batch.slice(mid + 1), strokes.slice(mid + 1), { ...flushInfo, split: 'mid-markup:tail' }, rawRefs.slice(mid + 1));
    return;
  }
  // 圈住已落库普通内容（AI 笔圈自己普通笔写的东西+旁边写问题）：在圈处拆，被圈内容的读取交给圈 mark 的 recognizeEnclosedInk。
  const encAt = await findContentEnclosureIndex(batch, scoredAll, pid, bookId);
  if (encAt >= 0) {
    gtrace({ page_id: pid, split: 'content-enclosure', at: encAt, markup: diagOf([scoredAll[encAt]])[0], flush: flushInfo });
    if (encAt > 0) await resolveRegion(batch.slice(0, encAt), strokes.slice(0, encAt), { ...flushInfo, split: 'content-enclosure:head' }, rawRefs.slice(0, encAt));
    await resolveRegion(batch.slice(encAt, encAt + 1), strokes.slice(encAt, encAt + 1), { ...flushInfo, split: 'content-enclosure:markup' }, rawRefs.slice(encAt, encAt + 1));
    if (batch.length > encAt + 1) await resolveRegion(batch.slice(encAt + 1), strokes.slice(encAt + 1), { ...flushInfo, split: 'content-enclosure:tail' }, rawRefs.slice(encAt + 1));
    return;
  }

  // 每笔单独分类。点按滤除要克制：**多笔且含实笔的区域里，短笔是真笔画的一部分**（汉字的点/小撇/钩、
  // 标点，行程常 <13px 或 ≤3 点 → 被 classifyScored 判 tap_region）——一律滤掉就是"手写丢笔画"的病根
  // （那些笔留在屏上、却不进 mark、不落账本，reload 后凭空消失，也不进识别图）。故只在「孤立单笔点按」
  // 或「整团都是点按」时才丢（真·误触/掌触）；其余全保留，绝不丢用户落下的笔。
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
  // reader 块本地批次：dims 传 coord_px_per_norm 中位 → 特征层的像素阈值（ocr 门/复杂度）恢复出真实 reader px。
  const clsDim = readerClsDim(realEvents);
  // 字高标尺必须与 bbox 同空间：reader 批次用命中块视觉行高（换算进 canonical 单位·墨迹高÷行高=真实视觉扁度）。
  // 旧口径拿源 PDF 页字高比 canonical 墨迹高（跨系）→ reader 下划线扁度恒 ≥0.6 被判"太高"降级 drawing、永远不进命中。
  const lineHs = realEvents.map((e) => e.reader_line_h).filter((h): h is number => !!h).sort((a, b) => a - b);
  const charH = clsDim && lineHs.length ? lineHs[lineHs.length >> 1] / clsDim : localCharHeight(state.surfaceIndex);
  const geom = classifyStrokeFeature(realScored, strokeBboxes, points, bbox, charH, clsDim, clsDim);
  // 代表 event 的形状：markup 取最强模板笔（圈/划/箭头，带箭头方向）；否则按合并笔（自由笔=stroke）
  const domScored = geom.type === 'markup' ? realScored.find((s) => s.type === geom.raw.templateType) : undefined;
  const markScored = domScored ?? classifyScored(points, bbox, clsDim, clsDim);
  const repr: AnnotationEvent = {
    ...realEvents[realEvents.length - 1],
    geometry: { bbox }, stroke_points: points, event_type: markScored.type,
    // 白板(日记)零画布→从账本 page_norm 点串离屏栅格化 ink 图给 AI(#ink-layer 空·抓它得白图)。仅白板设，书籍原版/PDF 不设→captureMark 照常 grabLayers(零回归)。
    ...(state.surfaceType === 'whiteboard' ? { ink_ref: pageInkRefOf(realStrokes) } : {}),
    reflow_ink_ref: reflowInkRefOf(realEvents, realStrokes),
    reflow_ink_points: realEvents.flatMap((e) => e.reflow_ink_points ?? []),
  };
  const cap = await captureMark(repr, geom, markScored.score); // 识别定型 → cap.feature 是最终类型
  const feature = cap.feature;
  const mark = makeMark(repr, feature, markScored, cap.hmp, cap.markedText);
  mark.trace = cap.trace; // 落笔当时这笔经手的组件阶段（识别/OCR兜底/取证）→ 提交时拼进整轮流水线
  mark.manner = computeManner(realStrokes, feature.type); // 运笔方式（Slice A）：随 mark 进叙事
  const isAiPen = realStrokes.some((s) => s.tool === 'aipen');
  // P2「圈普通墨」：任何圈、且几何上没圈到文字对象（含白板/日记页只有 blank 占位对象的情况）→ 默认尝试识别
  // 被圈普通墨当所标内容，识别失败也保留圈内墨迹图当证据（见 recognizeEnclosedInk）。不再要求特意切到 AI
  // 笔工具（isAiPen）或开 dev 开关（aiPenExplicit）——是否真的触发 AI 回应仍由下面独立的 fold/respond
  // 分类器把关，这里只是让"圈了内容"这件事不再零证据，不会导致乱回应。
  // AI 笔"必回应、跳过分类器"（下面 462 行附近）是另一个功能点，仍按原样保持默认关闭，不受这处影响。
  if (markScored.type === 'circle' && !mark.markedText.trim()) {
    const enc = await recognizeEnclosedInk(repr.stroke_points, pid, bookId);
    if (enc) {
      if (enc.text) mark.markedText = enc.text;
      if (mark.hmp) {
        mark.hmp.vector_ref = enc.ink;
        mark.hmp.text_hint = enc.text || mark.hmp.text_hint;
        mark.hmp.confidence = Math.max(mark.hmp.confidence, enc.text ? 0.75 : 0.5);
      }
      gtrace({ page_id: pid, aiPenEnclosedInk: { marks: enc.count, text: enc.text.slice(0, 40), bbox: enc.bbox.map((n) => +n.toFixed(4)) } });
    }
  }
  addMark(bookId, mark);
  // 落账本（页账本 mark 条目）+ 建 笔→mark 映射（擦/撤时给整 mark 落 tombstone）
  for (const s of realStrokes) strokeMarkIds.set(s, mark.id);
  const tool: 'pen' | 'highlighter' = realStrokes.some((s) => s.tool === 'highlighter') ? 'highlighter' : 'pen';
  const raw_ref = mergeRawRefs(rawRefs); // 基岩回链：合并本区各笔在 ingestStroke 同步取的 seq 区间（精确·不受 far-stroke/await 污染）
  // mark 级位置真相锚 = 所有保留笔命中块的 source runs **并集**（不再只取 repr=最后一笔·多笔跨块 mark 不丢前面各笔的块）。
  // 逐笔投影仍各认各笔的 stroke.anchor_runs（projectPersistedMark 的 refs=0 分支）；本字段供块高亮 / 缺锚 fallback / 导出。
  const reflowAnchorRuns = [...new Set(realEvents.flatMap((e) => e.anchor_runs ?? []))];
  const readerLayoutIds = [...new Set(realEvents.map((e) => e.reader_layout_id).filter((id): id is string => !!id))];
  void appendMarkEntry({
    document_id: bookId, page_id: pid, page_index: pageIdxOf(pid), mark_id: mark.id,
    strokes: keep.map((x) => persistedStrokeOf(x.e, x.st)), // 逐笔带各自的块锚 + surface-local 点（位置真相与取证真相分开）

    bbox, tool, color: tool === 'highlighter' ? 'rgba(212,207,202,0.85)' : '#1A1A1A',
    coord_space: repr.coord_space ?? 'page_norm',
    capture_surface: repr.capture_surface ?? (repr.pointer_type === 'reader' ? 'reader' : 'page'),
    ...(repr.reflow_ink_points?.length ? { surface_bbox: bboxOfSurface(repr.reflow_ink_points), surface_coord_space: 'reader_px' as const } : {}),
    ...(readerLayoutIds.length === 1 ? { reader_layout_id: readerLayoutIds[0] } : repr.reader_layout_id ? { reader_layout_id: repr.reader_layout_id } : {}),
    pointer_type: repr.pointer_type, device_id: repr.device_id, abs_timestamp: Date.now(),
    context_id: getActiveContext().id,
    feature_type: feature.type, feature_confidence: feature.confidence,
    kind: cap.kind, kind_source: cap.kindSource,
    scored_type: markScored.type, scored_score: markScored.score,
    hmp: mark.hmp ? { ...mark.hmp, crop_ref: undefined, vector_ref: undefined } : null,
    marked_text: mark.markedText, raw_ref, is_tombstone: false, // mark.markedText：P2 圈普通墨时已被识别内容覆盖（否则=cap.markedText）
    ai_eligible: true, origin: realStrokes.some((s) => s.tool === 'aipen') ? 'ai_pen' : 'auto', // 进了 AI 管线（AI 笔触 / 自动判意模式）
    ...(reflowAnchorRuns.length ? { reflow_anchor_runs: reflowAnchorRuns } : {}), // 重排落笔的位置真相锚=各笔块并集（原版落笔无此字段·退近似）
  });
  gtrace({ page_id: pid, strokes: diagOf(realScored), ...(droppedTaps ? { droppedTaps } : {}), feature: feature.type, conf: Number(feature.confidence.toFixed(2)), shape: markScored.type, marked: mark.markedText.slice(0, 40), ...(raw_ref ? { raw_ref } : {}), resolved: `mark·${feature.type}（累积静默）`, flush: flushInfo });

  // 通知前端：一笔已收口定型（日记「第一段手写→标题」据此取 markedText；其它前端可忽略）。
  bus.emit('mark:resolved', { feature: feature.type, text: mark.markedText });

  // 触发回应：默认 AI 笔=激活意图识别的开关 → 它写的手写过 fold/respond 分类器判要不要回应（走下面 else-if 同普通手写）。
  //   AI 笔"原功能"（必回应·圈→答被圈内容·跳分类器）已停用·仅 dev settings.aiPenExplicit 开时恢复（待重排圈选锚定重做）。
  if (isAiPen && settings.aiPenExplicit) void commitSession(bookId, 'handwriting', mark, true);
  else if (feature.type === 'handwriting') void commitSession(bookId, 'handwriting', mark);
}

/** 提交一段 session：建图 + 蒸馏 + 回应。committed 才清空 session（fold 不清、留作下次综合）。 */
async function commitSession(bookId: string, reason: 'idle' | 'handwriting', triggerMark?: Mark, alwaysRespond = false): Promise<void> {
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
  const outcome = await commitSessionDiscussion(session, reason, triggerMark, discId, alwaysRespond);
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
    // 笔触划分（Phase P）：普通笔=纯内容 → 单独落库、不进 AI；AI 笔/自动判意 → 进区域组装。
    if (!strokeEntersAI(stroke)) {
      const evt = recordEvent(stroke, shortId('trc'), pointerType, penUpAt);
      if (evt) persistContentStroke(evt, stroke);
      return;
    }
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
    // 笔触划分（Phase P）：重排面同样门控——普通笔=纯内容落库；AI 笔/自动判意 → 进区域组装。
    if (strokeEntersAI(stroke)) ingestStroke(event, stroke); // 与原版页同一前段 → 多笔组装、quiet-6s 收口、idle 综合全接通
    else persistContentStroke(event, stroke);
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
      regNearBbox = regEvents.length ? regEvents.map((e) => nearBoxOf(e)).reduce(unionBb) : null;
      regNearPad = regEvents.length ? regionNearPad() : REGION_NEAR;
      if (!regEvents.length) { window.clearTimeout(regTimer); regFirstAt = 0; regLastAt = 0; }
      if (regBbox) bus.emit('region:update', { bbox: regBbox, near: regNearPad }); else bus.emit('region:clear');
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
