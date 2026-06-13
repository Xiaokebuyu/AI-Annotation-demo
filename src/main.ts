import './styles.css';
import { recordEvent, commitDiscussion, summarizePage } from './core/pipeline';
import { resolveGesture, isDeliberate, type Gesture } from './core/gesture';
import { shortId } from './core/ids';
import { bus, state, settings } from './app/state';
import type { AnnotationEvent, EventType, NormBBox, OutputMode } from './core/contracts';
import { initRenderer, loadFile, gotoPage, setZoom, hasDocument } from './ui/renderer';
import { initInk } from './ui/ink';
import { initWhisper } from './ui/whisper';
import { initReader } from './ui/reader';
import { initInsightPanel } from './ui/insight-panel';
import { initToolbar } from './ui/toolbar';
import { initDevDrawer, toggleDrawer } from './ui/dev-drawer';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const SESSION_WINDOW = 1200; // 手势组装窗：抬笔静默此窗即算一次手势完成（多笔合一）

initRenderer({
  pageLayer: $<HTMLCanvasElement>('page-layer'),
  inkLayer: $<HTMLCanvasElement>('ink-layer'),
  stage: $('stage'),
  stageWrap: $('stage-wrap'),
});

let sessionTrace: string | null = null;
let pending: AnnotationEvent[] = [];
let sessionTimer: number | undefined; // 组装一次手势（多笔合一）
let pauseTimer: number | undefined;   // 停顿到点 → 聚类已识别手势、每簇一条讨论

// 本页"已识别手势会话"（过了形状门槛才进来）
interface RecGesture { events: AnnotationEvent[]; gesture: Gesture; bbox: NormBBox; }
const recByPage = new Map<string, RecGesture[]>();
const recBucket = (pid: string): RecGesture[] => {
  if (!recByPage.has(pid)) recByPage.set(pid, []);
  return recByPage.get(pid)!;
};
const lastSig = new Map<string, string>(); // discId → 上轮成员签名，避免重复生成

function unionBBox(events: AnnotationEvent[]): NormBBox {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const e of events) {
    const [x, y, w, h] = e.geometry.bbox;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

function cancelTimers(): void {
  window.clearTimeout(sessionTimer);
  window.clearTimeout(pauseTimer);
  pending = [];
  sessionTrace = null;
}

/** 按纵向邻近把已识别手势聚成"段落讨论"簇。 */
function clusterByProximity(recs: RecGesture[]): RecGesture[][] {
  const sorted = [...recs].sort((a, b) => a.bbox[1] - b.bbox[1]);
  const clusters: RecGesture[][] = [];
  const GAP = 0.06; // 纵向间隙阈值（页面归一化）
  for (const r of sorted) {
    const cur = clusters[clusters.length - 1];
    const curBottom = cur ? Math.max(...cur.map((c) => c.bbox[1] + c.bbox[3])) : -1;
    if (cur && r.bbox[1] - curBottom < GAP) cur.push(r);
    else clusters.push([r]);
  }
  return clusters;
}

/** 一簇手势 → 生成参数：单手势按其意图，多手势走综合，含提问则作答。 */
function clusterIntent(cluster: RecGesture[]): { modes: OutputMode[]; eventType?: EventType } {
  if (cluster.some((c) => c.gesture.kind === 'ask')) return { modes: ['question'], eventType: 'circle' };
  if (cluster.length === 1) return { modes: cluster[0].gesture.output_modes, eventType: cluster[0].gesture.eventType };
  return { modes: ['summary'] };
}

/** 停顿到点：聚类本页已识别手势，每簇一条讨论；成员没变则跳过（不重复生成）。 */
function runDiscussions(pid: string): void {
  const recs = recBucket(pid);
  if (!recs.length) return;
  for (const cluster of clusterByProximity(recs)) {
    const events = cluster.flatMap((c) => c.events);
    const ids = events.map((e) => e.event_id).sort();
    const discId = 'disc_' + ids[0];
    const sig = ids.join(',');
    if (lastSig.get(discId) === sig) continue;
    lastSig.set(discId, sig);
    const { modes, eventType } = clusterIntent(cluster);
    void commitDiscussion(events, performance.now(), discId, modes, eventType);
  }
}

initInk($<HTMLCanvasElement>('ink-layer'), (stroke, pointerType, penUpAt) => {
  if (!sessionTrace) sessionTrace = shortId('trc');
  const evt = recordEvent(stroke, sessionTrace, pointerType, penUpAt);
  if (!evt) return;
  pending.push(evt);

  // 1.2s：一次手势组装完 → 过形状门槛(画得像范例)才记为"已识别手势"，随手涂忽略
  window.clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(() => {
    const batch = pending;
    pending = [];
    sessionTrace = null;
    if (batch.length && isDeliberate(batch)) {
      recBucket(batch[0].page_id).push({ events: batch, gesture: resolveGesture(batch), bbox: unionBBox(batch) });
    }
  }, SESSION_WINDOW);

  // 停顿窗：每次落笔重置；停笔 pauseSeconds 后才生成（避免打扰）
  if (settings.gesture.enabled) {
    const pid = evt.page_id;
    window.clearTimeout(pauseTimer);
    pauseTimer = window.setTimeout(() => runDiscussions(pid), settings.gesture.pauseSeconds * 1000);
  }
});

// 设置变化时取消在途计时（避免旧设置下的延迟触发）
bus.on('settings:changed', cancelTimers);

initWhisper($('whisper-layer'));
initReader($('reader'));
initToolbar($('toolbar'));
initInsightPanel({
  cards: $('cards'),
  foot: $('panel-foot'),
  count: $('insight-count'),
});
initDevDrawer({
  drawer: $('dev-drawer'),
  ocrSelect: $<HTMLSelectElement>('ocr-provider'),
  inferSelect: $<HTMLSelectElement>('infer-provider'),
  metricsBody: $('metrics-body'),
  traceLog: $('trace-log'),
  selftest: $('selftest'),
  downloadBtn: $('dl-trace'),
  closeBtn: $('drawer-close'),
});

const fileIn = $<HTMLInputElement>('file-in');
fileIn.addEventListener('change', () => {
  const file = fileIn.files?.[0];
  if (file) void loadFile(file);
});

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
});

let lastPageId: string | null = null;
bus.on('page:rendered', () => {
  $('page-ind').textContent = `第 ${state.pageIndex + 1} / ${state.pageCount} 页`;
  $('zoom-ind').textContent = `${Math.round(state.zoom * 100)}%`;
  // 翻页（非缩放重渲）：取消在途计时 + 总结上一页（喂跨页综合）
  if (state.pageId !== lastPageId) {
    const prev = lastPageId;
    lastPageId = state.pageId;
    cancelTimers();
    if (prev) void summarizePage(prev);
  }
});

$('prev').addEventListener('click', () => gotoPage(-1));
$('next').addEventListener('click', () => gotoPage(1));
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
