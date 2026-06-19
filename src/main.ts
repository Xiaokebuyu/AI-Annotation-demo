import './styles.css';
import { recordEvent, captureMark, commitSessionDiscussion } from './core/pipeline';
import { classifyScored, classifyStrokeFeature, bboxOf } from './capture/classify';
import {
  addMark, peekSession, clearSession, makeMark,
  IDLE_COMMIT_MS, type Mark,
} from './capture/session';
import { localCharHeight } from './evidence/target';
import { trace } from './core/trace';
import { shortId } from './core/ids';
import { bus, state, settings } from './app/state';
import { getOverlays, getStrokes, removeOverlay, storedDoc, upsertOverlay } from './local/store';
import type { ScreenOverlay } from './core/contracts';
import type { AnnotationEvent, NormBBox } from './core/contracts';
import { initRenderer, loadFile, gotoPage, setZoom, hasDocument } from './surface/renderer';
import { renderChatSurface } from './surface/chat-surface';
import { initInk, persistInk } from './capture/ink';
import { initWhisper } from './surface/whisper';
import { initReader } from './surface/reader';
import { initAnchorLayer } from './surface/anchor-layer';
import { openBook } from './chat/buffer';
import { initInsightPanel } from './surface/insight-panel';
import { initToolbar } from './surface/toolbar';
import { initDevDrawer, toggleDrawer } from './dev/dev-drawer';
import { initDevOverlay } from './dev/dev-overlay';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

initRenderer({
  pageLayer: $<HTMLCanvasElement>('page-layer'),
  inkLayer: $<HTMLCanvasElement>('ink-layer'),
  stage: $('stage'),
  stageWrap: $('stage-wrap'),
});

// 区域组装（空间+时间连续）：同一小块区域里继续写的笔画并进一个 mark；附近无动作满 REGION_QUIET 才提交，
// 最长挂 REGION_MAX_HOLD；笔落到远处=离开该区域 → 上一区域立刻收口。慢写汉字聚成一整团再识别（读得准、只回一条）。
const REGION_QUIET_MS = 6000;     // 附近无动作多久 → 收口提交（dev 可调，按真实手速）
const REGION_MAX_HOLD_MS = 15000; // 一个区域最长挂多久（连续涂写的安全上限）
const REGION_NEAR = 0.06;         // "附近"：笔中心在区域 bbox 外扩此值内算同区（归一化）

let sessionTrace: string | null = null;
let idleTimer: number | undefined;     // 长停顿(~1–2min) → 对整段 session 综合回复
const lastSig = new Map<string, string>(); // 防重复提交（按 book）

// 当前挂起的"区域"（单活跃区：写在一处会聚起来；落到远处则旧区先收口、此处另起）。
let regEvents: AnnotationEvent[] = [];
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
/** 收口当前区域 → 解析成一个 mark（异步识别在 resolveRegion 内）。 */
function flushRegion(): void {
  window.clearTimeout(regTimer);
  const events = regEvents;
  regEvents = []; regBbox = null; regFirstAt = 0; sessionTrace = null;
  bus.emit('region:clear'); // dev 可视：区域收口 → 清叠层
  if (events.length) void resolveRegion(events);
}

/** 翻页/缩放重渲：丢在途的笔（属旧页），但保留 session/idle（会话跨页、翻页不是边界事件）。 */
function resetAssembly(): void {
  window.clearTimeout(regTimer);
  regEvents = []; regBbox = null; regFirstAt = 0; sessionTrace = null;
  bus.emit('region:clear');
}

/** 设置变更/换书：清计时 + 丢当前书 session（硬复位）。 */
function cancelTimers(): void {
  window.clearTimeout(regTimer);
  window.clearTimeout(idleTimer);
  regEvents = []; regBbox = null; regFirstAt = 0; sessionTrace = null;
  bus.emit('region:clear');
  if (state.documentId) clearSession(state.documentId);
}

/** 手势决策 = trace + 镜像到 dev 通道（让"圈了几次/每笔判成什么/有没有被并/被丢"在通道里可见）。 */
function gtrace(o: Record<string, unknown>): void {
  trace('GestureSession', o);
  void fetch('/api/__debug/event', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'gesture', ts: new Date().toISOString(), strokeCount: Array.isArray(o.strokes) ? (o.strokes as unknown[]).length : undefined, ...o }),
  }).catch(() => { /* 镜像失败不连累主链路 */ });
}

const diagOf = (scored: ReturnType<typeof classifyScored>[]) => scored.map((s) => ({ type: s.type, score: Number(s.score.toFixed(2)) }));

/**
 * 收口一个区域：把这团笔合成一个 mark → 落笔当时取证(captureMark) → 累积进 session。
 * 关键：**每笔单独几何分类**后再判特征（不在合并乱线上重判——圈+划合并会毁掉干净的单笔模板信号）。
 * 连续标注期间界面静默；语义全交模型；手写区域收口即走唯一早提交边界（区域冷却本身已是落定）。
 */
async function resolveRegion(batch: AnnotationEvent[]): Promise<void> {
  const pid = batch[0].page_id;
  const bookId = state.documentId ?? 'book';

  // 每笔单独分类 + 滤点按（per-stroke）
  const scoredAll = batch.map((e) => classifyScored(e.stroke_points, e.geometry.bbox));
  const keep = batch.map((e, i) => ({ e, s: scoredAll[i] })).filter((x) => x.s.type !== 'tap_region');
  if (!keep.length) {
    gtrace({ page_id: pid, strokes: diagOf(scoredAll), resolved: '— 点按/误触，不计入' });
    return;
  }
  const realEvents = keep.map((x) => x.e);
  const realScored = keep.map((x) => x.s);
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
  addMark(bookId, mark);
  gtrace({ page_id: pid, strokes: diagOf(realScored), feature: feature.type, conf: Number(feature.confidence.toFixed(2)), shape: markScored.type, marked: cap.markedText.slice(0, 40), resolved: `mark·${feature.type}（累积静默）` });

  // 手写 = 唯一早提交边界事件（区域冷却已落定 + 识别已可靠定型，无需再额外等）
  if (feature.type === 'handwriting') void commitSession(bookId, 'handwriting', mark);
}

/** 提交一段 session：建图 + 蒸馏 + 回应。committed 才清空 session（fold 不清、留作下次综合）。 */
async function commitSession(bookId: string, reason: 'idle' | 'handwriting', triggerMark?: Mark): Promise<void> {
  const session = peekSession(bookId);
  if (!session) return;
  // idle 综合要有实质：至少一笔手写、或锚到真实正文的标记。纯散笔/涂画（无锚内容）不触发，避免无关回复。
  if (reason === 'idle') {
    const substantial = session.marks.some((m) =>
      m.feature.type === 'handwriting' || ((m.hmp?.mode === 'anchored' || m.hmp?.mode === 'mixed') && !!m.markedText.trim()));
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
  if (!sessionTrace) sessionTrace = shortId('trc');
  const evt = recordEvent(stroke, sessionTrace, pointerType, penUpAt);
  if (!evt) return;
  persistInk(); // 每笔落盘（去抖在 store 内部）

  // 空间连贯：挨着当前区域就并进去（重置冷却）；落到远处 → 旧区先收口、此处另起一个区域。
  if (regBbox && !nearRegion(evt.geometry.bbox)) flushRegion();
  regEvents.push(evt);
  regBbox = regBbox ? unionBb(regBbox, evt.geometry.bbox) : evt.geometry.bbox;
  if (!regFirstAt) regFirstAt = performance.now();
  window.clearTimeout(regTimer);
  // 附近无动作满 REGION_QUIET 才收口；连续涂写到 REGION_MAX_HOLD 强制收口。
  if (performance.now() - regFirstAt >= REGION_MAX_HOLD_MS) flushRegion();
  else {
    regTimer = window.setTimeout(flushRegion, REGION_QUIET_MS);
    bus.emit('region:update', { bbox: regBbox, near: REGION_NEAR }); // dev 可视：实时画当前组装区域
  }

  // 长停顿(~1–2min)无新笔 → 对整段 session 综合回复（连续标注期间界面静默）
  if (settings.gesture.enabled) {
    const bookId = state.documentId ?? 'book';
    const idleMs = (settings.gesture.idleSeconds ?? IDLE_COMMIT_MS / 1000) * 1000;
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => { void commitSession(bookId, 'idle'); }, idleMs);
  }
});

// 设置变化时取消在途计时（避免旧设置下的延迟触发）
bus.on('settings:changed', cancelTimers);

// AI 卡片持久化：page_id 形如 pg_{hash8}_{idx} → 取末段为页号
function pageIdxOf(pageId: string): number {
  const m = pageId.match(/_(\d+)$/);
  return m ? Number(m[1]) : state.pageIndex;
}
bus.on('overlay:add', (o) => { const ov = o as ScreenOverlay; upsertOverlay(pageIdxOf(ov.page_id), ov); });
bus.on('overlay:state', (o) => { const ov = o as ScreenOverlay; upsertOverlay(pageIdxOf(ov.page_id), ov); });
bus.on('overlay:remove', (id) => {
  const ov = state.overlays.find((x) => x.overlay_id === (id as string));
  if (ov) removeOverlay(pageIdxOf(ov.page_id), ov.overlay_id);
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
initDevDrawer({
  drawer: $('dev-drawer'),
  inferSelect: $<HTMLSelectElement>('infer-provider'),
  metricsBody: $('metrics-body'),
  traceLog: $('trace-log'),
  selftest: $('selftest'),
  downloadBtn: $('dl-trace'),
  closeBtn: $('drawer-close'),
});
initDevOverlay();

const fileIn = $<HTMLInputElement>('file-in');
fileIn.addEventListener('change', () => {
  const file = fileIn.files?.[0];
  if (file) void loadFile(file);
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

bus.on('document:loaded', () => {
  document.body.classList.add('doc-loaded');
  $('empty-state').style.display = 'none';
  $('doc-name').textContent = state.fileName;
  if (state.documentId) openBook(state.documentId); // 开书非阻塞预热每本书对话 buffer（≈0ms，纯建数组）
  // 从持久化恢复：两段记忆、原始笔迹、AI 卡片（重排/图解缓存由 reader 按需读 store）
  const doc = storedDoc();
  if (!doc || !state.documentId) return;
  state.overlays = [];
  for (const p of Object.values(doc.pages)) {
    const pid = `pg_${state.documentId.slice(4, 12)}_${p.page_index}`;
    // 逐页记忆撤除（押后）：只恢复笔迹 + AI 卡片，不再 restorePage
    // 笔迹：填回 strokesByPage（按 page_id 索引）
    if (p.strokes?.length) state.strokesByPage.set(pid, p.strokes.map((s) => ({ tool: s.tool, points: s.points })));
    // 卡片：合到全局 overlays（whisper/reader 按当前 page_id 过滤显示）
    if (p.overlays?.length) state.overlays.push(...p.overlays);
  }
});

let lastPageId: string | null = null;
bus.on('page:rendered', () => {
  $('page-ind').textContent = `第 ${state.pageIndex + 1} / ${state.pageCount} 页`;
  $('zoom-ind').textContent = `${Math.round(state.zoom * 100)}%`;
  // 翻页（非缩放重渲）：丢在途的笔，但 session/idle 跨页保留（翻页不是边界事件）
  if (state.pageId !== lastPageId) {
    lastPageId = state.pageId;
    resetAssembly();
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
$('dev-toggle').addEventListener('click', () => toggleDrawer());

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
