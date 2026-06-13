import './styles.css';
import { recordEvent, commitSession } from './core/pipeline';
import { shortId } from './core/ids';
import { bus, state } from './app/state';
import type { AnnotationEvent } from './core/contracts';
import { initRenderer, loadFile, gotoPage, setZoom, hasDocument } from './ui/renderer';
import { initInk } from './ui/ink';
import { initWhisper } from './ui/whisper';
import { initInsightPanel } from './ui/insight-panel';
import { initToolbar } from './ui/toolbar';
import { initDevDrawer, toggleDrawer } from './ui/dev-drawer';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const STOP_WINDOW = 1200; // 抬笔后静默窗口：期间无新笔画才算停笔，合并为一次低语

initRenderer({
  pageLayer: $<HTMLCanvasElement>('page-layer'),
  inkLayer: $<HTMLCanvasElement>('ink-layer'),
  stage: $('stage'),
  stageWrap: $('stage-wrap'),
});

let sessionTrace: string | null = null;
let pending: AnnotationEvent[] = [];
let stopTimer: number | undefined;

initInk($<HTMLCanvasElement>('ink-layer'), (stroke, pointerType, penUpAt) => {
  if (!sessionTrace) sessionTrace = shortId('trc');
  const evt = recordEvent(stroke, sessionTrace, pointerType, penUpAt);
  if (!evt) return;
  pending.push(evt);
  window.clearTimeout(stopTimer);
  stopTimer = window.setTimeout(() => {
    const batch = pending;
    pending = [];
    sessionTrace = null;
    void commitSession(batch, performance.now());
  }, STOP_WINDOW);
});

initWhisper($('whisper-layer'));
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
  $('empty-state').style.display = 'none';
  $('doc-name').textContent = state.fileName;
});

bus.on('page:rendered', () => {
  $('page-ind').textContent = `第 ${state.pageIndex + 1} / ${state.pageCount} 页`;
  $('zoom-ind').textContent = `${Math.round(state.zoom * 100)}%`;
});

$('prev').addEventListener('click', () => gotoPage(-1));
$('next').addEventListener('click', () => gotoPage(1));
$('zoom-in').addEventListener('click', () => setZoom(state.zoom + 0.25));
$('zoom-out').addEventListener('click', () => setZoom(state.zoom - 0.25));
$('dev-toggle').addEventListener('click', () => toggleDrawer());

const insight = $('insight');
$('insight-toggle').addEventListener('click', () => insight.classList.toggle('open'));

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.isContentEditable) return;
  if (e.key === 'ArrowLeft') gotoPage(-1);
  if (e.key === 'ArrowRight') gotoPage(1);
});

window.addEventListener('resize', () => {
  if (hasDocument()) setZoom(state.zoom); // 触发自适应重渲
});

declare global {
  interface Window { __inkloop?: { state: typeof state } }
}
window.__inkloop = { state };
