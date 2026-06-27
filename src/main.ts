import './core/polyfills'; // 必须最先：老 WebView 补 Promise.withResolvers（pdf.js 用到）
import './styles.css';
import { bus, state, settings, getActiveContext } from './app/state';
import type { SurfaceContext } from './app/surface-context';
import { listBooks, setLastReadPage } from './local/store';
import { initRenderer, loadFile, reopenBook, renderPage, gotoPage, setZoom, hasDocument } from './surface/renderer';
import { renderChatSurface } from './surface/chat-surface';
import { initWhisper } from './surface/whisper';
import { initReader } from './surface/reader';
import { initAnchorLayer } from './surface/anchor-layer';
import { initInsightPanel } from './surface/insight-panel';
import { initToolbar } from './surface/toolbar';
import { initDevOverlay } from './dev/dev-overlay';
import { initNavShell } from './dev/console';
import { initEinkMirror } from './surface/eink';
import { features } from './config/features';
import { restoreLedgerState } from './controllers/ledger-restore';
import { wireAnnotationLoop, flushRegion } from './app/annotation-loop';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

initRenderer({
  pageLayer: $<HTMLCanvasElement>('page-layer'),
  inkLayer: $<HTMLCanvasElement>('ink-layer'),
  stage: $('stage'),
  stageWrap: $('stage-wrap'),
});

// 标注会话编排（区域组装→收口→综合→旁注）抽到 app/annotation-loop，桌面与移动版共用同一份、传各自的 #ink 画布。
wireAnnotationLoop($<HTMLCanvasElement>('ink-layer'));

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
if (features.einkBridge) initEinkMirror(); // 电纸屏镜像：套壳内容变化 → 推 IT8951（web/dev 无桥则 no-op；D1 flag 可关）

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
  const c = ctx as SurfaceContext;
  if (c.pdf && c.surfaceType === 'article') {
    void renderPage().then(() => { if (getActiveContext() === c) void restoreFromLedger(); }); // 渲染期间又切走则不再恢复（P0-5）
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
  await restoreLedgerState(docId); // 账本→state 重建（笔迹/旁注/buffer/pending），见 controllers/ledger-restore
}

let lastPageId: string | null = null;
bus.on('page:rendered', () => {
  $('page-ind').textContent = `第 ${state.pageIndex + 1} / ${state.pageCount} 页`;
  $('zoom-ind').textContent = `${Math.round(state.zoom * 100)}%`;
  // 翻页（非缩放重渲）：记阅读位置。在途笔的复位由 annotation-loop 的 page:rendered 监听负责。
  if (state.pageId !== lastPageId) {
    lastPageId = state.pageId;
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
  interface Window { __inkloop?: { state: typeof state; settings: typeof settings; bus: typeof bus; features: typeof features } }
}
window.__inkloop = { state, settings, bus, features };
