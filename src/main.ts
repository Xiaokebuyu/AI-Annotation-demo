import './styles.css';
import { recordEvent, captureMark, commitSessionDiscussion } from './core/pipeline';
import { classifyScored, classifyStrokeFeature, bboxOf, type ScoredGesture, type StrokeFeature } from './capture/classify';
import {
  addMark, peekSession, clearSession, makeMark, removeMark,
  IDLE_COMMIT_MS, type Mark,
} from './capture/session';
import { localCharHeight } from './evidence/target';
import { trace } from './core/trace';
import { devEmit } from './core/dev-telemetry';
import { shortId, DEVICE_ID } from './core/ids';
import { bus, state, settings, strokeMarkIds, type Stroke, type Tool } from './app/state';
import type { ReaderContext } from './app/reader-context';
import { appendMarkEntry, getBookAiTurns, getFoldedMarks, getPendingMarks, listBooks, setLastReadPage, updateOverlayState } from './local/store';
import type { PersistedMark } from './core/store-format';
import type { ScreenOverlay } from './core/contracts';
import type { AnnotationEvent, EventType, NormBBox } from './core/contracts';
import { SCHEMA_VERSION } from './core/contracts';
import { initRenderer, loadFile, reopenBook, renderPage, gotoPage, setZoom, hasDocument } from './surface/renderer';
import { renderChatSurface } from './surface/chat-surface';
import { initInk, redrawInk } from './capture/ink';
import { initWhisper } from './surface/whisper';
import { initReader } from './surface/reader';
import { initAnchorLayer } from './surface/anchor-layer';
import { openBook, appendMsg } from './chat/buffer';
import { initInsightPanel } from './surface/insight-panel';
import { initToolbar } from './surface/toolbar';
import { initDevOverlay } from './dev/dev-overlay';
import { initNavShell } from './dev/console';
import { initEinkMirror, signalInkArea } from './surface/eink';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

initRenderer({
  pageLayer: $<HTMLCanvasElement>('page-layer'),
  inkLayer: $<HTMLCanvasElement>('ink-layer'),
  stage: $('stage'),
  stageWrap: $('stage-wrap'),
});

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

function unionBb(a: NormBBox, b: NormBBox): NormBBox {
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0] + a[2], b[0] + b[2]), y1 = Math.max(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, x1 - x0, y1 - y0];
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
function flushRegion(reason: FlushReason = 'manual', diag: Record<string, number> | null = null): void {
  window.clearTimeout(regTimer);
  const events = regEvents, strokes = regStrokes;
  const heldMs = regFirstAt ? Math.round(performance.now() - regFirstAt) : 0;
  const regAt = regBbox ? regBbox.map((n) => +n.toFixed(4)) : null;
  regEvents = []; regStrokes = []; regBbox = null; regFirstAt = 0; sessionTrace = null;
  bus.emit('region:clear'); // dev 可视：区域收口 → 清叠层
  if (events.length) void resolveRegion(events, strokes, { reason, heldMs, regBbox: regAt, ...(diag ?? {}) });
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
  regEvents = []; regStrokes = []; regBbox = null; regFirstAt = 0; sessionTrace = null;
  bus.emit('region:clear');
}

/** 设置变更/换书：清计时 + 丢当前书 session（硬复位）。 */
function cancelTimers(): void {
  window.clearTimeout(regTimer);
  window.clearTimeout(idleTimer);
  regEvents = []; regStrokes = []; regBbox = null; regFirstAt = 0; sessionTrace = null;
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
async function resolveRegion(batch: AnnotationEvent[], strokes: Stroke[], flushInfo: Record<string, unknown> = {}): Promise<void> {
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
  addMark(bookId, mark);
  // 落账本（页账本 mark 条目）+ 建 笔→mark 映射（擦/撤时给整 mark 落 tombstone）
  for (const s of realStrokes) strokeMarkIds.set(s, mark.id);
  const tool: 'pen' | 'highlighter' = realStrokes.some((s) => s.tool === 'highlighter') ? 'highlighter' : 'pen';
  void appendMarkEntry({
    document_id: bookId, page_id: pid, page_index: pageIdxOf(pid), mark_id: mark.id,
    strokes: realStrokes.map((s) => ({ tool: s.tool, points: s.points })),
    bbox, tool, color: tool === 'highlighter' ? 'rgba(212,207,202,0.85)' : '#1A1A1A',
    pointer_type: repr.pointer_type, device_id: repr.device_id, abs_timestamp: Date.now(),
    feature_type: feature.type, feature_confidence: feature.confidence,
    kind: cap.kind, kind_source: cap.kindSource,
    scored_type: markScored.type, scored_score: markScored.score,
    hmp: cap.hmp ? { ...cap.hmp, crop_ref: undefined, vector_ref: undefined } : null,
    marked_text: cap.markedText, is_tombstone: false,
  });
  gtrace({ page_id: pid, strokes: diagOf(realScored), ...(droppedTaps ? { droppedTaps } : {}), feature: feature.type, conf: Number(feature.confidence.toFixed(2)), shape: markScored.type, marked: cap.markedText.slice(0, 40), resolved: `mark·${feature.type}（累积静默）`, flush: flushInfo });

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
  const discId = 'disc_' + (triggerMark?.id ?? session.marks[session.marks.length - 1].id);
  const committed = await commitSessionDiscussion(session, reason, triggerMark, discId);
  if (committed) { clearSession(bookId); lastSig.delete('sess_' + bookId); }
}

initInk($<HTMLCanvasElement>('ink-layer'), (stroke, pointerType, penUpAt) => {
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

// page_id 形如 pg_{hash8}_{idx} → 取末段为页号
function pageIdxOf(pageId: string): number {
  const m = pageId.match(/_(\d+)$/);
  return m ? Number(m[1]) : state.pageIndex;
}
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
    feature_type: 'drawing', feature_confidence: 0, scored_type: 'stroke', scored_score: 0,
    hmp: null, marked_text: '', is_tombstone: true,
  });
});

initWhisper($('whisper-layer'));
initAnchorLayer($('stage'));
initReader($('reader'));
initToolbar($('toolbar'));
initInsightPanel({
  cards: $('cards'),
  foot: $('panel-foot'),
  count: $('insight-count'),
});
initDevOverlay(); // 画布叠层（独立于旧 dev 抽屉，由设置页 devOverlay/showRegion/showRelations 控）
initNavShell();   // 全局导航壳：阅读 / AI 会话 / 采集取证 / 设置（旧 #dev 抽屉已退役）
// 窄屏(电纸屏竖向 / 手机)：导航栏默认收起为抽屉，避免在 ~405px 宽挤占正文（点 ☰ 以浮层拉出）
if (window.matchMedia('(max-width: 640px)').matches) document.body.classList.add('rail-collapsed');
initEinkMirror(); // 电纸屏镜像：套壳内容变化(page:rendered/view/overlay) → 推 IT8951（web/dev 无桥则 no-op）

const fileIn = $<HTMLInputElement>('file-in');
fileIn.addEventListener('change', () => {
  const file = fileIn.files?.[0];
  if (file) void loadFile(file);
});

// ── 书架：列出已持久存储的书，点击免重导打开（阶段一）──
const recentBooks = $('recent-books');
const recentPanel = $('recent-panel');
const recentToggle = $<HTMLButtonElement>('recent-toggle');

function fmtWhen(iso: string): string {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  const p = (n: number) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function renderRecent(container: HTMLElement, opts?: { withCap?: boolean; emptyHint?: boolean }): Promise<void> {
  const books = await listBooks();
  container.innerHTML = '';
  if (!books.length) {
    if (opts?.emptyHint) {
      const e = document.createElement('div');
      e.className = 'recent-empty';
      e.textContent = '还没有已保存的书';
      container.appendChild(e);
    }
    return;
  }
  if (opts?.withCap) {
    const cap = document.createElement('p');
    cap.className = 'recent-cap';
    cap.textContent = '最近打开（已保存，免重导）';
    container.appendChild(cap);
  }
  for (const b of books) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.title = `${b.filename}（${b.page_count} 页）`;
    const name = document.createElement('span');
    name.className = 'ri-name';
    name.textContent = b.filename || '(未命名)';
    const meta = document.createElement('span');
    meta.className = 'ri-meta';
    meta.textContent = `${b.page_count}页 · ${fmtWhen(b.saved_at)}`;
    item.append(name, meta);
    item.addEventListener('click', () => { recentPanel.hidden = true; void reopenBook(b.document_id, b.filename); });
    container.appendChild(item);
  }
}

void renderRecent(recentBooks, { withCap: true }); // 启动即在空状态屏列出

recentToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  if (recentPanel.hidden) { void renderRecent(recentPanel, { emptyHint: true }); recentPanel.hidden = false; }
  else recentPanel.hidden = true;
});
document.addEventListener('click', (e) => {
  if (!recentPanel.hidden && !recentPanel.contains(e.target as Node) && e.target !== recentToggle) recentPanel.hidden = true;
});

// 载入合成聊天 surface（徐智强 step① App-agnostic 验证：原生吐 SurfaceIndex）
$('load-chat').addEventListener('click', () => renderChatSurface());

// 拖拽上传：拖到整个阅读区任意位置即可
const reading = $('reading');
const pickPdf = (list: FileList | undefined): File | undefined =>
  list ? [...list].find((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) : undefined;

let dragDepth = 0;
const setDragging = (on: boolean) => reading.classList.toggle('dragover', on);

reading.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) setDragging(true);
});
reading.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
reading.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; setDragging(false); }
});
reading.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  const file = pickPdf(e.dataTransfer?.files);
  if (file) void loadFile(file);
});

bus.on('document:loaded', () => { void restoreFromLedger(); });

// 方案 B Stage 1：切换激活实例（进/退会议）后的重绘。
// 切回已加载的 PDF 实例（如退会议回主阅读）→ 重渲当前页 + 复原 chrome/墨迹/旁注，全程不重新 fetch/decode。
// 白板/聊天 surface 由调用方（enterMeeting）显式 renderBlankSurface 处理；空实例（无书）→ 回空屏。
bus.on('context:switched', (ctx) => {
  const c = ctx as ReaderContext;
  if (c.pdf && c.surfaceType === 'article') {
    void renderPage().then(() => restoreFromLedger());
  } else if (!c.documentId) {
    document.body.classList.remove('doc-loaded');
    $('empty-state').style.display = '';
  }
});

/** reload/重开后从账本重建：笔迹(folded marks) + AI 旁注/对话 buffer(book log) + pending session(水位线后)。 */
async function restoreFromLedger(): Promise<void> {
  document.body.classList.add('doc-loaded');
  $('empty-state').style.display = 'none';
  $('doc-name').textContent = state.fileName;
  void renderRecent(recentBooks, { withCap: true }); // 刷新书架（新导入的书下次回到空屏即可见）
  const docId = state.documentId;
  if (!docId) return;
  openBook(docId); // 非阻塞预热每本书对话 buffer

  // 1) 笔迹：折叠后的 mark → strokesByPage（按 page_id）+ 回填 strokeMarkIds（擦/撤仍能定位整 mark）
  const marks = await getFoldedMarks(docId);
  state.strokesByPage.clear();
  for (const m of marks) {
    const arr = state.strokesByPage.get(m.page_id) ?? [];
    for (const ps of m.strokes) {
      const st: Stroke = { tool: ps.tool as Tool, points: ps.points };
      strokeMarkIds.set(st, m.mark_id);
      arr.push(st);
    }
    state.strokesByPage.set(m.page_id, arr);
  }

  // 2) AI 旁注 + 对话 buffer：书日志折叠（每 overlay_id 取最新；dismissed/folded 不显示）
  //    overlay 恢复 = 非 dismissed 且非 folded（folded=自我笔记，静默：无 reader 旁注、不进 buffer）；
  //    buffer 只回放最近 3 轮（延续性主要靠空间召回，不靠长 transcript）。
  const turns = await getBookAiTurns(docId);
  state.overlays = [];
  const shown = turns.filter((t) => t.overlay_state !== 'dismissed' && t.overlay_state !== 'folded');
  for (const t of shown) {
    t.overlay.object_refs = t.anchor.object_refs; // 跨视图锚（兼容早于 object_refs 的旧快照）
    state.overlays.push(t.overlay);
  }
  for (const t of shown.slice(-3)) { // 仅最近 3 轮进 buffer（与 buffer.ts MAX_TURNS=6 一致）
    appendMsg(docId, { role: 'user', content: t.prompt_snapshot });
    appendMsg(docId, { role: 'assistant', content: t.ai_reply });
  }

  // 3) pending session：水位线之后未综合的 mark 重建进内存 session（下次 idle 仍能综合）
  const pending = await getPendingMarks(docId);
  if (pending.length) {
    const baseT = performance.now(), wall = Date.now();
    for (const pm of pending) addMark(docId, persistedToMark(pm, baseT, wall));
  }

  bus.emit('page:rendered'); // 补一次重绘：renderPage 早于本异步恢复完成，此处让 redrawInk/whisper 拿到恢复后的数据
}

/** 持久 mark → 内存 Mark（仅 pending session 重建用）。t 由 abs_timestamp 折回 performance.now 时间线（保关系 gap）。 */
function persistedToMark(pm: PersistedMark, baseT: number, wall: number): Mark {
  const points = pm.strokes.flatMap((s) => s.points);
  const event: AnnotationEvent = {
    event_id: pm.mark_id, trace_id: '', document_id: pm.document_id, page_id: pm.page_id,
    event_type: pm.scored_type as EventType, geometry: { bbox: pm.bbox }, stroke_points: points,
    text_note: null, created_at: pm.created_at, device_id: pm.device_id, session_id: '',
    pointer_type: pm.pointer_type, version: SCHEMA_VERSION,
  };
  const feature: StrokeFeature = {
    type: pm.feature_type, confidence: pm.feature_confidence, scaleRatio: NaN,
    raw: { strokeCount: pm.strokes.length, templateScore: 0, templateType: pm.scored_type as EventType, scaleRatio: NaN, complexity: 0, ocrWorthy: false, tplSpan: 0 },
  };
  const scored: ScoredGesture = { type: pm.scored_type as EventType, score: pm.scored_score };
  return { id: pm.mark_id, event, feature, scored, t: baseT - (wall - pm.abs_timestamp), hmp: pm.hmp, markedText: pm.marked_text };
}

let lastPageId: string | null = null;
bus.on('page:rendered', () => {
  $('page-ind').textContent = `第 ${state.pageIndex + 1} / ${state.pageCount} 页`;
  $('zoom-ind').textContent = `${Math.round(state.zoom * 100)}%`;
  // 翻页（非缩放重渲）：丢在途的笔，但 session/idle 跨页保留（翻页不是边界事件）
  if (state.pageId !== lastPageId) {
    lastPageId = state.pageId;
    resetAssembly();
    setLastReadPage(state.pageIndex); // 记阅读位置（去抖落盘），重开跳回
  }
});

$('prev').addEventListener('click', () => gotoPage(-1));
$('next').addEventListener('click', () => gotoPage(1));

// 翻页手势：笔/手指分流后，手指横滑（或 hand 工具拖动）→ ink.ts 发 nav:flip
bus.on('nav:flip', (dir) => gotoPage(Number(dir) || 0));

// 触控板两指横滑 → 翻页（最贴近真机手指翻页）。横向为主才拦，竖向滚动放行；一次滑一翻、加锁防连翻。
let wheelAccum = 0;
let wheelLock = false;
$('stage-wrap').addEventListener('wheel', (e) => {
  if (settings.viewMode !== 'page' || !hasDocument()) return;
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // 竖向滚动不翻页
  e.preventDefault();                                    // 拦 Safari/浏览器的前进后退手势
  if (wheelLock) return;
  wheelAccum += e.deltaX;
  if (Math.abs(wheelAccum) > 80) {
    gotoPage(wheelAccum > 0 ? 1 : -1);
    wheelAccum = 0;
    wheelLock = true;
    window.setTimeout(() => { wheelLock = false; }, 450);
  }
}, { passive: false });
$('zoom-in').addEventListener('click', () => setZoom(state.zoom + 0.25));
$('zoom-out').addEventListener('click', () => setZoom(state.zoom - 0.25));

const insight = $('insight');
$('insight-toggle').addEventListener('click', () => insight.classList.toggle('open'));

// 原版 PDF ⇄ 重排阅读
function applyViewMode(): void {
  const isReader = settings.viewMode === 'reader';
  $('reading').classList.toggle('reader', isReader);
  ($('reader') as HTMLElement).hidden = !isReader;
  ($('stage-wrap') as HTMLElement).style.display = isReader ? 'none' : '';
  const btn = $('view-toggle');
  btn.textContent = isReader ? '原版' : '重排';
  btn.classList.toggle('active', isReader);
}
$('view-toggle').addEventListener('click', () => {
  // 切面前先收口在途区域：此刻 pageId/surfaceIndex 仍是当前面，能正确落成 mark；否则 regBbox 跨面存活，
  // 切过去第一笔会与旧面在途区域误并（跨面污染）。空区域时 flushRegion 有 events.length 守卫、是 no-op。
  flushRegion('view-switch');
  settings.viewMode = settings.viewMode === 'reader' ? 'page' : 'reader';
  applyViewMode();
  bus.emit('view:changed');
});
applyViewMode(); // 初始即同步 DOM 到持久化的 viewMode（否则刷新后 reader 持久值不反映、停在 page）

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.isContentEditable) return;
  if (e.key === 'ArrowLeft') gotoPage(-1);
  if (e.key === 'ArrowRight') gotoPage(1);
});

window.addEventListener('resize', () => {
  if (hasDocument()) setZoom(state.zoom); // 触发自适应重渲
});

declare global {
  interface Window { __inkloop?: { state: typeof state; settings: typeof settings; bus: typeof bus } }
}
window.__inkloop = { state, settings, bus };
