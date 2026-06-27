// 移动版（电纸屏）入口：把引擎接到「新日记」空白可写页 + 日记持久化/列表/重开 + 多页翻页。
// 复用同名 DOM id（page-layer/ink-layer/stage/stage-wrap/whisper-layer），与桌面共用 app/annotation-loop 的编排（不分叉）。
// 注意：不 import 桌面 styles.css —— 移动版有自己的样式（mobile.html 内联）。
import './core/polyfills'; // 必须最先：设备 WebView 109 补 Promise.withResolvers（pdf.js 用到）
import { initRenderer, renderBlankSurface, renderBlankPage, loadFile, reopenBook, gotoPage, renderPage } from './surface/renderer';
import type { SurfaceContext } from './app/surface-context';
import { initWhisper } from './surface/whisper';
import { initInsightPanel } from './surface/insight-panel';
import { initReader } from './surface/reader';
import { wireAnnotationLoop, flushRegion } from './app/annotation-loop';
import { setTool, getActiveContext, state, settings, saveSettings, bus, type Tool } from './app/state';
import { shortId } from './core/ids';
import { createDiaryDoc, listDiaries, listBooks, setActiveDoc, setLastReadPage, setDiaryPageCount, renameDiary, deleteDiary } from './local/store';
import { confirmSheet } from './mobile/sheet';
import { redrawInk } from './capture/ink';
import { restoreLedgerState } from './controllers/ledger-restore';
import { initEinkMirror } from './surface/eink';
import { features } from './config/features';
import { initMobileMeeting } from './mobile/meeting';
import { initMobileDev } from './mobile/dev';
import type { PersistedDoc } from './core/store-format';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const RULED = { ruledLines: false } as const; // 移动版线格走 CSS 叠层（#diary-lines），故引擎页画布不画线

initRenderer({
  pageLayer: el<HTMLCanvasElement>('page-layer'),
  inkLayer: el<HTMLCanvasElement>('ink-layer'),
  stage: el('stage'),
  stageWrap: el('stage-wrap'),
});
wireAnnotationLoop(el<HTMLCanvasElement>('ink-layer'));
initWhisper(el('whisper-layer'));
initReader(el('reader'), { notePlacement: 'inline' }); // 重排阅读视图（书籍态·AI 注内联段落下方·复用桌面 reader.ts 行为层）
initInsightPanel({ cards: el('m-cards'), foot: el('m-panel-foot'), count: el('m-insight-count') }); // 本页洞察历史（复用桌面同款）
if (features.einkBridge) initEinkMirror(); // 电纸屏镜像：套壳内容变化 → 推 IT8951（web/dev 无桥则 no-op）

// AI 洞察抽屉开关（rail 💡）
el('rl-ai').addEventListener('click', () => document.body.classList.toggle('insight-open'));
el('insight-x').addEventListener('click', () => document.body.classList.remove('insight-open'));
el('scrim-insight').addEventListener('click', () => document.body.classList.remove('insight-open'));

// reload/重开后从账本恢复该日记的笔迹（renderBlankSurface 末尾会 emit document:loaded）。
bus.on('document:loaded', () => {
  // 稿纸线叠层（#diary-lines）跟 surfaceType 走：白板=显、PDF(article)=隐。
  // 否则会中把资料 PDF 载进同一画布时，日记格线叠层会透在 PDF 上（#stage-wrap 搬进会中宿主、叠层随行）。
  document.body.dataset.surface = state.surfaceType;
  const id = state.documentId;
  if (id) void restoreLedgerState(id).then(() => redrawInk());
});

// 切回 reader 实例后重渲其 surface（mobile 原本不听 context:switched·桌面 main.ts 有）：
// 否则会中开过资料 PDF 再退会议时，画布残留上一会的资料帧、而活跃 context 已是 reader——
// 用户看着会议资料、落笔却进 reader 文档（归错档）。reader 有 PDF(书)→renderPage 重渲该书首/当前页（state 字段委托 activeCtx，自动指向 reader 的 pdf/页/doc）+ redrawInk 画回其墨迹；
// 空 reader / 日记列表态画布本就隐藏，不重渲（renderBlankSurface 会另起新文档，反而破坏）。
bus.on('context:switched', (ctx) => {
  const c = ctx as SurfaceContext;
  if (c.pdf && c.surfaceType === 'article') {
    void renderPage().then(() => { if (getActiveContext() === c) redrawInk(); });
  }
});

// 左缘工具格子（data-tool）→ 引擎 setTool：笔/荧光/擦/手（resolveIntent：非 hand 即落笔，手指默认能写）。
const TOOL: Record<string, Tool> = { pen: 'pen', hi: 'highlighter', er: 'eraser', hand: 'hand' };
for (const b of document.querySelectorAll<HTMLElement>('[data-tool]')) {
  b.addEventListener('click', () => { const t = TOOL[b.dataset.tool ?? '']; if (t) setTool(t); });
}

// ════ 日记：先有文件再写内容 ════
const titleEl = el('diary-title');
const wrap = el('stage-wrap');
const pgInd = el('pg-ind');
const dim = (W = 0, H = 0) => ({ width: W || wrap.clientWidth, height: H || wrap.clientHeight });

// 日记可无限向前翻（空白新页不落盘），故"总页数"取已落盘页数与当前页的较大值——
// 翻到空白新页时显 N/N（不显 N>M），真写了才把 page_count 抬上去、退回去也不缩。书籍 pageIndex 不越界、行为不变。
function updatePageInd(): void {
  const total = Math.max(state.pageCount, state.pageIndex + 1);
  pgInd.textContent = `${state.pageIndex + 1}/${total}`;
}

/** 切到写区视图（日记=new / 书籍=book，都复用同一张画布），并同步左缘高亮 + 标记可写态。 */
function showWritable(read: 'new' | 'book' = 'new'): void {
  document.body.dataset.read = read;
  const hl = read === 'book' ? 'books' : 'new'; // 书籍读书面高亮「书籍」，日记高亮「新日记」
  for (const b of document.querySelectorAll<HTMLElement>('#read-sub [data-read]')) {
    const on = b.dataset.read === hl;
    b.classList.toggle('on', on); b.classList.toggle('dim', !on);
    b.closest('.rl-item')?.classList.toggle('cur', on);
  }
  document.body.classList.add('writable'); // 模块切视图时自己点亮工具格子（不依赖 inline updateWritable）
}

/** 点「新日记」=先建并落库一份新日记文件，再渲染空白可写页。 */
async function newDiary(): Promise<void> {
  const d = new Date();
  const title = `${d.getMonth() + 1}.${d.getDate()} 日记`;
  const id = shortId('diary');
  const doc = await createDiaryDoc(id, title, 1); // 先有文件（立即落库）
  showWritable('new');
  titleEl.contentEditable = 'true';
  titleEl.textContent = title;
  titleEl.dataset.auto = '1'; // 自动占位（待手写命名）——将来第一段手写覆盖
  renderBlankSurface(id, title, { ...RULED, ...dim() }); // 满铺写区
  getActiveContext().storeDoc = doc; setActiveDoc(doc); // R6：store.current = 这本日记
  updatePageInd();
  applyViewMode(); // 新日记=白板，复位成原版视图
}

/** 重开一篇已存日记（从日记列表点开）。 */
function openDiary(doc: PersistedDoc): void {
  const title = doc.filename || '未命名';
  showWritable('new'); // 必须先让写区可见——隐藏时 stage-wrap.clientWidth=0，纸会被算成 0 宽
  titleEl.contentEditable = 'true';
  titleEl.textContent = title;
  titleEl.dataset.auto = '0'; // 已有标题
  renderBlankSurface(doc.document_id, title, { ...RULED, ...dim() }); // emit document:loaded → 账本恢复笔迹
  state.pageCount = doc.page_count || 1; // renderBlankSurface 写死 1，复原真页数
  getActiveContext().storeDoc = doc; setActiveDoc(doc);
  updatePageInd();
  applyViewMode(); // 日记=白板，复位成原版视图（从重排态的书切来时要把 #reader 收掉、露回画布）
}

// ════ 书籍：PDF 导入/重开（复用同一张画布，surfaceType=article） ════
const fileIn = el<HTMLInputElement>('m-file-in');

/** 重开一本已存的书（书架点开）：复用读书面，reopenBook → loadIntoState 渲首页 + emit document:loaded。 */
async function openBook(doc: PersistedDoc): Promise<void> {
  showWritable('book'); // 先让写区可见（reopenBook 内 renderPage 读 stage-wrap.clientWidth）
  titleEl.contentEditable = 'false'; // 书名只读
  titleEl.dataset.auto = '0';
  titleEl.textContent = doc.filename || '未命名';
  const ok = await reopenBook(doc.document_id, doc.filename || '未命名');
  if (!ok) { titleEl.textContent = (doc.filename || '未命名') + '（无文件字节）'; return; }
  updatePageInd();
  applyViewMode(); // 书籍态尊重持久 viewMode（原版/重排粘性）
  if (settings.viewMode === 'reader') bus.emit('view:changed'); // 重排态：PDF 渲完后触发当前页 reflow
}

/** 导入一份新 PDF（file input / 文件桥读出的 File）。 */
async function importPdfFile(f: File): Promise<void> {
  showWritable('book');
  titleEl.contentEditable = 'false';
  titleEl.dataset.auto = '0';
  titleEl.textContent = f.name;
  await loadFile(f); // 落库 + 渲首页 + emit document:loaded
  updatePageInd();
  void renderBookShelf(); // 新书进书架
}
fileIn.addEventListener('change', () => {
  const f = fileIn.files?.[0]; fileIn.value = '';
  if (f) void importPdfFile(f);
});

/** 导入入口：有原生文件桥（电纸屏·系统选择器看不见）走 WebView 内浏览器；否则用系统文件选择器。 */
function importBook(): void {
  const bridge = (window as unknown as { InkLoopFiles?: { list?: unknown } }).InkLoopFiles;
  if (bridge && typeof bridge.list === 'function') void openFileBrowser(); // 原生桥（设备）
  else fileIn.click(); // dev/preview：系统选择器
}

// ── 书架（真数据 listBooks）──
async function renderBookShelf(): Promise<void> {
  const grid = el('rv-books').querySelector('.grid');
  const cnt = el('rv-books').querySelector('.cnt');
  if (!grid) return;
  const books = await listBooks();
  if (cnt) cnt.textContent = `${books.length} 本`;
  grid.textContent = '';
  for (const b of books) {
    const pos = !b.last_read_page ? '未开始'
      : (b.last_read_page >= (b.page_count - 1) ? '读完' : `读到 ${b.last_read_page + 1} 页`);
    const card = document.createElement('div');
    card.className = 'bcard';
    card.innerHTML = '<span class="spine"></span><div class="bt"></div><div class="bm"></div>';
    (card.querySelector('.bt') as HTMLElement).textContent = b.filename || '(未命名)'; // textContent 防 XSS
    (card.querySelector('.bm') as HTMLElement).innerHTML = `PDF · ${b.page_count} 页<br>${pos}`;
    card.addEventListener('click', () => void openBook(b));
    grid.appendChild(card);
  }
  // 导入卡（与书卡同尺寸）
  const imp = document.createElement('div');
  imp.className = 'bcard imp';
  imp.innerHTML = '<div class="pl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg></div><div class="il">导入文件</div><div class="is">PDF · HTML · 图片</div>';
  imp.addEventListener('click', importBook);
  grid.appendChild(imp);
}
el('read-sub').querySelector<HTMLElement>('[data-read="books"]')?.addEventListener('click', () => void renderBookShelf());

// ── WebView 内文件浏览器（电纸屏：系统选择器看不见，需安卓壳 InkLoopFiles 桥枚举 /sdcard）──
// 桥契约：window.InkLoopFiles = { list(path):Promise<{name,path,dir,size?}[]>, readBase64(path):Promise<string> }
// 无桥（web/dev）→ importBook 不会走到这；走到了也安全降级到系统文件选择器。
interface FileEntry { name: string; path: string; dir: boolean; size?: number }
// 原生桥（InkLoopFilesBridge·addJavascriptInterface）：方法同步返回字符串（list=JSON / readBase64=base64）。
interface FilesBridge { list(p: string): string; readBase64(p: string): string }
const FILE_ROOT = '/sdcard/Download';
async function openFileBrowser(path: string = FILE_ROOT): Promise<void> {
  const bridge = (window as unknown as { InkLoopFiles?: FilesBridge }).InkLoopFiles;
  if (!bridge?.list) { fileIn.click(); return; }
  document.body.classList.add('files-open');
  const crumb = el('files').querySelector('.crumb') as HTMLElement;
  const fls = el('files').querySelector('.fls') as HTMLElement;
  crumb.textContent = path;
  fls.textContent = '加载中…';
  let entries: FileEntry[];
  try { const raw = await bridge.list(path); entries = JSON.parse(typeof raw === 'string' ? raw : '[]'); } // 桥同步返 JSON 串
  catch { document.body.classList.remove('files-open'); fileIn.click(); return; }
  fls.textContent = '';
  if (!entries.length) { fls.innerHTML = '<p class="empty" style="padding:20px 12px">这个目录是空的，或缺「所有文件访问」权限（设置里授予后重开）。</p>'; }
  const addRow = (label: string, meta: string, dir: boolean, onClick: () => void): void => {
    const r = document.createElement('div');
    r.className = dir ? 'frow dir' : 'frow';
    const ic = dir
      ? '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
      : '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>';
    r.innerHTML = `<span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ic}</svg></span><div><div class="nm"></div><div class="mt"></div></div>${dir ? '<span class="go"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>' : ''}`;
    (r.querySelector('.nm') as HTMLElement).textContent = label;
    (r.querySelector('.mt') as HTMLElement).textContent = meta;
    r.addEventListener('click', onClick);
    fls.appendChild(r);
  };
  if (path !== FILE_ROOT) addRow('返回上级', '', true, () => void openFileBrowser(path.replace(/\/[^/]+\/?$/, '') || FILE_ROOT));
  for (const e of entries) {
    if (e.dir) addRow(e.name, '文件夹', true, () => void openFileBrowser(e.path));
    else if (/\.pdf$/i.test(e.name)) addRow(e.name, e.size ? `${(e.size / 1048576).toFixed(1)} MB` : 'PDF', false, () => void importFromBridge(bridge, e));
    // 其它（HTML/图片）暂不导入——HTML→PDF / 图片转 PDF 走 convert-service，后续
  }
}
async function importFromBridge(bridge: FilesBridge, e: FileEntry): Promise<void> {
  try {
    const b64 = await bridge.readBase64(e.path);
    if (!b64) return; // 读失败（无权限/越权）：留在浏览器
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const f = new File([bytes], e.name, { type: 'application/pdf' });
    document.body.classList.remove('files-open');
    await importPdfFile(f);
  } catch { /* 读失败：留在浏览器 */ }
}

// 标题手动改 → 脱离自动态、持久化；回车收尾（单行）。
titleEl.addEventListener('input', () => { titleEl.dataset.auto = '0'; });
titleEl.addEventListener('blur', () => {
  const id = state.documentId;
  if (id && state.surfaceType === 'whiteboard') void renameDiary(id, (titleEl.textContent || '未命名').trim());
});
titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } });

// 第一段手写 → 自动成为标题（仅 data-auto=1 占位态时覆盖；识别出的 markedText 来自后端）。
bus.on('mark:resolved', (p) => {
  const { feature, text } = p as { feature: string; text: string };
  if (state.surfaceType !== 'whiteboard') return;
  // 日记 materialize：在某页写了内容→该页落成真页（page_count 抬到含当前页·只增）。
  // storeDoc 存在=有持久文档(日记)；会议白板 storeDoc=null→跳过。空白翻页过去没写的页不会到这(无 mark)。
  if (getActiveContext().storeDoc) {
    const need = state.pageIndex + 1;
    if (need > state.pageCount) { state.pageCount = need; updatePageInd(); }
    setDiaryPageCount(need); // 落盘 doc.page_count（need<=已存则 no-op）
  }
  if (feature !== 'handwriting' || titleEl.dataset.auto !== '1') return;
  const t = (text || '').trim().split('\n')[0].slice(0, 40);
  if (!t) return;
  titleEl.textContent = t;
  titleEl.dataset.auto = '0';
  const id = state.documentId;
  if (id) void renameDiary(id, t);
});

// 点「新日记」即新建（即便已在新日记页也另起一份）。
el('read-sub').querySelector<HTMLElement>('[data-read="new"]')?.addEventListener('click', () => void newDiary());
if (document.body.dataset.read === 'new') void newDiary();

// ════ 翻页（多页日记） ════
// 日记无限向前翻：只挡住小于 0，不挡上界——翻过最后一页就是一张空白新页（未写=不落盘，写了才在 mark:resolved 里 materialize）。
function gotoDiaryPage(idx: number): void {
  if (state.surfaceType !== 'whiteboard') return;
  if (idx < 0) return;
  renderBlankPage(idx, RULED);
  redrawInk();            // 画回该页已有笔迹（strokesByPage 已含全部页；空白新页无笔=空画）
  setLastReadPage(idx);   // 记阅读位置（空白新页也记，当书签）
  updatePageInd();
}
/** 翻页：书籍（article）走 renderer.gotoPage；日记（whiteboard）走 gotoDiaryPage。 */
function pageNav(delta: number): void {
  if (state.surfaceType === 'article') gotoPage(delta);
  else gotoDiaryPage(state.pageIndex + delta);
}
el('pg-prev').addEventListener('click', () => pageNav(-1));
el('pg-next').addEventListener('click', () => pageNav(1)); // 日记：下一页可无限向前（空白新页·写了才落盘），取代原手动加页

// ── 原版 PDF ⇄ 重排阅读（仅书籍态）。重排=隐藏 #stage-wrap 露 #reader（复用 reader.ts·AI 注内联）──
function applyViewMode(): void {
  const isReader = document.body.dataset.read === 'book' && settings.viewMode === 'reader';
  el('stage-wrap').style.display = isReader ? 'none' : '';
  el('whisper-layer').style.display = isReader ? 'none' : '';
  (el('reader') as HTMLElement).hidden = !isReader;
  el('view-toggle').textContent = isReader ? '原版' : '重排';
  el('view-toggle').classList.toggle('on', isReader);
}
el('view-toggle').addEventListener('click', () => {
  if (document.body.dataset.read !== 'book') return; // 重排只对书籍（日记是白板·无文本层）
  flushRegion('view-switch'); // 切面前收口在途区域：此刻 pageId/surfaceIndex 仍是当前面，否则跨面误并
  settings.viewMode = settings.viewMode === 'reader' ? 'page' : 'reader';
  saveSettings();
  applyViewMode();
  bus.emit('view:changed'); // → reader.rebuild 重排当前页
});
// 手型工具横滑 → 翻页（ink.ts 发 nav:flip）。
bus.on('nav:flip', (dir) => pageNav(Number(dir) || 0));
// 书籍 gotoPage 渲染后更新页码（日记 gotoDiaryPage 自带；重复调用幂等）。
bus.on('page:rendered', updatePageInd);

// ════ 日记列表（真数据） ════
const WK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
async function renderDiaryList(): Promise<void> {
  const body = el('rv-diary').querySelector('.vbody');
  const cnt = el('rv-diary').querySelector('.cnt');
  if (!body) return;
  const diaries = await listDiaries();
  if (cnt) cnt.textContent = `${diaries.length} 篇`;
  body.textContent = '';
  if (!diaries.length) {
    const e = document.createElement('div');
    e.className = 'recent-empty';
    e.style.cssText = 'padding:24px 8px;color:var(--mut2);font-size:13px;';
    e.textContent = '还没有日记。点左侧「新日记」开一篇。';
    body.appendChild(e);
    return;
  }
  for (const doc of diaries) {
    const d = doc.saved_at ? new Date(doc.saved_at) : null;
    const dateStr = d ? `${d.getMonth() + 1}.${d.getDate()}` : '';
    const wk = d ? WK[d.getDay()] : '';
    const row = document.createElement('div');
    row.className = 'drow';
    row.innerHTML = `<div class="dd">${dateStr}<span class="wk">${wk}</span></div>`
      + `<div class="dc"><div class="dt"></div><div class="dm">${doc.page_count || 1} 页</div></div>`
      + `<button class="drow-del" aria-label="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg></button>`;
    (row.querySelector('.dt') as HTMLElement).textContent = doc.filename || '未命名';
    row.addEventListener('click', () => openDiary(doc));
    row.querySelector('.drow-del')?.addEventListener('click', async (e) => {
      e.stopPropagation(); // 别触发 openDiary
      const ok = await confirmSheet({ title: '删除日记', message: `「${doc.filename || '未命名'}」及其全部手写会删掉，不可恢复。`, confirm: '删除' });
      if (ok) { await deleteDiary(doc.document_id); void renderDiaryList(); }
    });
    body.appendChild(row);
  }
}
// 切到「日记」时刷新列表。
el('read-sub').querySelector<HTMLElement>('[data-read="diary"]')?.addEventListener('click', () => void renderDiaryList());

// dev 调试钩子（同桌面 __inkloop）：preview/控制台里读状态、发 bus 事件、测书籍导入。
(window as unknown as { __inkloop?: unknown }).__inkloop = { state, bus, getActiveContext, listBooks, loadFile, reopenBook, openBook };

// ════ 线格开关 boot 态：复选框绑定移到 mobile/dev.ts（设置页重渲会重建该控件）════
document.body.classList.toggle('lines-off', localStorage.getItem('inkloop.mobile.lines') === 'off');

// ════ 会议 controller（真数据·会中白板）════
// 会议资料一律开在会议工作台内（enterMeeting→openMaterialInMeeting·载进 meetingCtx）、不再跳全局阅读面，故无需 goReadSurface。
initMobileMeeting({ readerCtx: getActiveContext() }); // readerCtx = boot 主阅读实例（'__reader__'）
initMobileDev(); // dev 三页（AI 会话 / 采集取证 / 设置）接真数据

// ════ 启动：渲染默认视图（日记列表）+ 预备书架（真数据）════
void renderDiaryList();
void renderBookShelf();
