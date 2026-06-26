/**
 * 全局导航壳（常驻左侧栏）——整个应用的导航中枢，不是一个"控制台页"。
 *
 * 形态参照桌面端：侧栏常驻在最左、正文整体右移给它让位（body padding-left，非浮层覆盖）。
 * 侧栏列出**所有可用页面**，「阅读」是第一个、默认目的地，其余是平级目的地：
 *   · 阅读：主业务页（PDF 阅读 + 标注），其实是 body 原有的 topbar/main，侧栏只把它右移。
 *   · AI 会话：ChatGPT 式对话流 + 每轮「处理流水线」逐组件时间线（收到→产出+图）+ 思考过程。【已实现】
 *     —— 它已**取代**旧「上下文监控」面板（那面板的"喂了什么/回了什么/看到的图"被流水线全覆盖且更细、可持久，
 *        故不再单列入口；旧 inspect 面板仍留在 #dev 供直达，离线 dev-telemetry 镜像也照旧）。
 *   · 采集取证（感知层）：一页两段、深度联动——「HMP 取证（全书逐笔）」+「SurfaceIndex 对象（本页对象表）」；
 *     二者是同一批对象 id 的消费者/生产者（HMP.target_object_refs 指进对象表），命中 ref ↔ 对象行互跳。
 *     看"感知对不对"，是 AI 会话的姊妹镜。【已实现】
 *   · 设置：迁出旧 dev 抽屉的全部设置控件 + 「诊断」段（坐标自测/延迟指标/预处理进度/trace 导出）；
 *     按代码审计**诚实标注每项可用性**（生效/调试叠层/弱效/失效）。【已实现】
 *
 * 旧 `#dev` 抽屉已整体退役（dev-drawer.ts 删除、index.html 标记移除）；dev-overlay（画布叠层）独立保留，
 * 由设置页的 devOverlay/showRegion/showRelations 控。
 *
 * 非「阅读」的页面渲染进 #app-pages（覆盖正文区、不挡侧栏）。侧栏可折叠（键 m / 折叠钮），折叠时正文占满。
 */
import { bus, state, settings, saveSettings, resetSettings, type Placement } from '../app/state';
import { resetBook } from '../chat/buffer';
import { listBooks, getBookAiTurns, getFoldedMarks } from '../local/store';
import { icon } from '../surface/icons';
import { renderMeeting, rerenderMeeting, syncMtgChrome, initMeeting } from '../features/meeting/meeting';
import { esc } from '../core/escape';
import './console.css'; // 导航壳 + dev 页样式（会议样式已随 features/meeting/meeting.css 迁出）
import type { PersistedAiTurn, PersistedMark } from '../core/store-format';
import type { HMP, PipelineStage, PipelineStageIO, SurfaceObject } from '../core/contracts';
import { downloadTrace, traceCount } from '../core/trace';
import { snapshot } from '../core/metrics';
import { selfTest } from '../core/transform';

type PageId = 'reader' | 'meeting' | 'chat' | 'hmp' | 'settings';
const PAGES: Array<{ id: PageId; icon: string; label: string; ready: boolean }> = [
  { id: 'reader', icon: '📖', label: '阅读', ready: true },
  { id: 'meeting', icon: '🗓', label: '会议', ready: true }, // 群聊工作区 → 会议日程 + 资料书架（阶段一脚手架）
  { id: 'chat', icon: '💬', label: 'AI 会话', ready: true }, // 含逐组件处理流水线，已取代旧「上下文监控」
  { id: 'hmp', icon: '🔬', label: '采集取证', ready: true }, // 合并 HMP 取证 + SurfaceIndex 对象，深度联动
  { id: 'settings', icon: '⚙', label: '设置', ready: true }, // 全部设置 + 逐项可用性标注
];
// 导航布局：顶层目的地（阅读 / 会议）+ 折叠的 dev 抽屉（AI会话 / 采集取证 / 设置 收进去）
const TOP_NAV: PageId[] = ['reader', 'meeting'];
const DEV_NAV: PageId[] = ['chat', 'hmp', 'settings'];
const pageDef = (id: PageId): { id: PageId; icon: string; label: string; ready: boolean } => PAGES.find((p) => p.id === id)!;

const NAV_ICON: Record<PageId, string> = { reader: 'book', meeting: 'calendar', chat: 'message', hmp: 'scan', settings: 'settings' };

let activePage: PageId = 'reader';
let selectedBook: string | null = null;

const fmtTime = (iso: string): string => {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return iso; }
};
const TRIGGER_CN: Record<string, { t: string; c: string }> = {
  idle: { t: '长停顿综合', c: '#3b82f6' },
  handwriting: { t: '手写定向', c: '#22c55e' },
  discussion: { t: '段落讨论', c: '#8a877f' },
};


function buildShell(): void {
  if (document.getElementById('app-rail')) return;

  const railItem = (id: PageId, sub = false): string =>
    `<button class="rail-item${sub ? ' rail-sub-item' : ''}" data-page="${id}"><span class="rail-ico">${icon(NAV_ICON[id])}</span><span>${esc(pageDef(id).label)}</span></button>`;
  const rail = document.createElement('nav');
  rail.id = 'app-rail';
  rail.innerHTML =
    `<div class="rail-head"><span class="rail-brand">◐ InkLoop</span><button class="rail-iconbtn" id="rail-collapse" title="收起侧栏（m）">«</button></div>`
    + TOP_NAV.map((id) => railItem(id)).join('')
    + `<button class="rail-item rail-group" id="rail-dev-toggle" title="开发 / 调试页"><span class="rail-ico">${icon('sliders')}</span><span>dev</span><span class="rail-caret">${icon('chevron')}</span></button>`
    + `<div class="rail-sub" id="rail-dev-sub">` + DEV_NAV.map((id) => railItem(id, true)).join('') + `</div>`
    + `<div class="rail-spacer"></div>`;
  document.body.appendChild(rail);

  const reopen = document.createElement('button');
  reopen.id = 'rail-reopen';
  reopen.title = '展开侧栏（m）';
  reopen.textContent = '☰';
  document.body.appendChild(reopen);

  const pages = document.createElement('div');
  pages.id = 'app-pages';
  pages.innerHTML = `<div id="app-page-content"></div>`;
  document.body.appendChild(pages);

  // 图片放大层（流水线里的缩略图点开看大图）
  const lb = document.createElement('div');
  lb.id = 'cns-lightbox';
  lb.className = 'cns-lb';
  lb.innerHTML = '<img alt="">';
  lb.addEventListener('click', () => lb.classList.remove('show'));
  document.body.appendChild(lb);

  rail.querySelectorAll<HTMLButtonElement>('.rail-item[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => go(btn.dataset.page as PageId));
  });
  rail.querySelector('#rail-dev-toggle')!.addEventListener('click', () => setDevExpanded(!railDevOpen()));
  rail.querySelector('#rail-collapse')!.addEventListener('click', () => setCollapsed(true));
  reopen.addEventListener('click', () => setCollapsed(false));
}

function setCollapsed(c: boolean): void {
  document.body.classList.toggle('rail-collapsed', c);
  try { localStorage.setItem('inkloop.rail.collapsed', c ? '1' : '0'); } catch { /* ignore */ }
}

const railDevOpen = (): boolean => !!document.getElementById('rail-dev-sub')?.classList.contains('open');
/** 展开/收起 dev 抽屉（AI会话 / 采集取证 / 设置）。 */
function setDevExpanded(open: boolean): void {
  document.getElementById('rail-dev-sub')?.classList.toggle('open', open);
  document.getElementById('rail-dev-toggle')?.classList.toggle('open', open);
  try { localStorage.setItem('inkloop.rail.dev', open ? '1' : '0'); } catch { /* ignore */ }
}

function highlight(): void {
  document.querySelectorAll<HTMLButtonElement>('#app-rail .rail-item[data-page]')
    .forEach((b) => b.classList.toggle('active', b.dataset.page === activePage));
}

/** 导航到某页（reader 收起页面层；其余渲染进 #app-pages）。所有页均已实现，无"迁移中"跳转。 */
function go(id: PageId): void {
  if (id === 'reader') {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    showPage('reader');
  } else {
    if (location.hash !== '#' + id) location.hash = id; else showPage(id);
  }
}

function showPage(id: PageId): void {
  activePage = id;
  highlight();
  syncMtgChrome(); // 会中浮层（资料栏/退出钮）只在阅读页+会中模式显示
  if (DEV_NAV.includes(id)) setDevExpanded(true); // 进 dev 子页时保持抽屉展开，露出高亮项
  const pages = document.getElementById('app-pages');
  if (!pages) return;
  if (id === 'reader') { pages.classList.remove('show'); return; }
  pages.classList.add('show');
  const content = document.getElementById('app-page-content') as HTMLDivElement | null;
  if (content) renderPage(id, content);
}

function renderPage(id: PageId, content: HTMLDivElement): void {
  if (id === 'meeting') { renderMeeting(content); return; }
  if (id === 'chat') { renderChat(content); return; }
  if (id === 'hmp') { renderCapture(content); return; }
  if (id === 'settings') { renderSettings(content); return; }
}

/* ── AI 会话页（ChatGPT 式对话流）─────────────────────────────────────────── */

function renderChat(c: HTMLDivElement): void {
  if (!selectedBook) selectedBook = state.documentId ?? null;
  c.innerHTML =
    `<div class="cns-head"><h2>${icon('message')} AI 会话</h2><div class="cns-head-ctl">`
    + `<select id="cns-book-sel"></select>`
    + `<button class="cns-btn" id="cns-refresh">⟳ 刷新</button>`
    + `<button class="cns-btn" id="cns-clear" title="清空这本书模型当下记得的对话上下文（≤3 轮滑动窗），不影响账本">🗑 清空上下文</button>`
    + `</div></div>`
    + `<div class="cns-thread" id="cns-thread"><div class="cns-thread-inner" id="cns-thread-inner"></div></div>`;

  const sel = c.querySelector<HTMLSelectElement>('#cns-book-sel');
  sel?.addEventListener('change', () => { selectedBook = sel.value; void renderConversation(); });
  c.querySelector('#cns-refresh')?.addEventListener('click', () => { void fillBookSelect().then(() => renderConversation()); });
  c.querySelector('#cns-clear')?.addEventListener('click', () => { if (selectedBook) { resetBook(selectedBook); } });

  // 先填书目（异步、可能自动选第一本书设 selectedBook）→ 再渲染对话，避免在 selectedBook 落定前渲染出空。
  void fillBookSelect().then(() => renderConversation());
}

async function fillBookSelect(selId = 'cns-book-sel'): Promise<void> {
  const sel = document.getElementById(selId) as HTMLSelectElement | null;
  if (!sel) return;
  const books = (await listBooks()).map((b) => ({ id: b.document_id, name: b.filename }));
  const opts = books.length ? books : (selectedBook ? [{ id: selectedBook, name: '(当前书)' }] : []);
  sel.innerHTML = opts.map((b) => `<option value="${esc(b.id)}"${b.id === selectedBook ? ' selected' : ''}>${esc(b.name || b.id)}</option>`).join('')
    || '<option value="">（暂无书籍）</option>';
  if (!selectedBook && opts[0]) selectedBook = opts[0].id;
}

/* ── 按页分组折叠：把无限增长的列表（会话/取证）归到页里，最新页默认展开、旧页收一行摘要 ──
 * body 懒渲染：只有最新组立即填，其余点开才插 DOM（避免几百条 + 取证图一次性压垮渲染）。 */
interface PageGroup { page_index: number; latestSeq: number; time: string; preview: string; count: number; bodyHtml: string }

function groupSummary(g: PageGroup, unit: string): string {
  return `<details class="grp" data-page="${g.page_index}">`
    + `<summary class="grp-sum"><span class="grp-pg">第 ${g.page_index + 1} 页</span><span class="grp-count">${g.count} ${unit}</span><span class="grp-time">${esc(g.time)}</span><span class="grp-prev">${esc(g.preview || '—')}</span></summary>`
    + `<div class="grp-body"></div></details>`;
}
/** 渲染分组列表：最新组立即填 body，其余懒填。返回 page→bodyHtml 供程序化展开（互跳用）。 */
function renderGroupList(container: HTMLElement, groups: PageGroup[], unit: string): Map<number, string> {
  const bodies = new Map<number, string>(groups.map((g) => [g.page_index, g.bodyHtml]));
  container.innerHTML = groups.map((g) => groupSummary(g, unit)).join('');
  groups.forEach((g, gi) => {
    const det = container.querySelector(`details.grp[data-page="${g.page_index}"]`) as HTMLDetailsElement | null;
    const body = det?.querySelector('.grp-body') as HTMLElement | null;
    if (!det || !body) return;
    if (gi === 0) { body.innerHTML = g.bodyHtml; body.dataset.filled = '1'; det.open = true; }
    else det.addEventListener('toggle', () => { if (det.open && body.dataset.filled !== '1') { body.innerHTML = bodies.get(g.page_index) ?? ''; body.dataset.filled = '1'; } });
  });
  return bodies;
}
/** 程序化展开某页组并补填 body（对象表→HMP 卡互跳时，目标卡可能在收起的旧页组里）。 */
function openHmpGroup(pg: number): void {
  const det = document.querySelector(`#hmp-grp details.grp[data-page="${pg}"]`) as HTMLDetailsElement | null;
  if (!det) return;
  const body = det.querySelector('.grp-body') as HTMLElement | null;
  if (body && body.dataset.filled !== '1') { body.innerHTML = hmpBodyByPage.get(pg) ?? ''; body.dataset.filled = '1'; }
  det.open = true;
}
let hmpPageOfMark = new Map<string, number>(); // mark_id → page_index（互跳定位用）
let hmpBodyByPage = new Map<number, string>(); // page_index → 该页 HMP 卡 html（懒填/互跳用）

async function renderConversation(): Promise<void> {
  const inner = document.getElementById('cns-thread-inner');
  const thread = document.getElementById('cns-thread');
  if (!inner) return;
  const turns: PersistedAiTurn[] = selectedBook ? await getBookAiTurns(selectedBook) : [];
  const shown = turns.filter((t) => t.overlay_state !== 'dismissed'); // 时间序（旧→新）
  if (!shown.length) {
    inner.innerHTML = `<p class="cns-empty">这本书还没有 AI 对话。<br>圈/划/写一处、停笔，每一轮「发送给 AI 的内容 + 回复 + 思考」会在这里成串出现。</p>`;
    return;
  }
  const marks = selectedBook ? await getFoldedMarks(selectedBook) : [];
  const markMap = new Map(marks.map((m) => [m.mark_id, m]));
  const idxMap = new Map(shown.map((t, i) => [t.entry_id, i + 1])); // 全局 1-based 轮号（按时间序）
  const byPage = new Map<number, PersistedAiTurn[]>();
  for (const t of shown) { const p = t.page_index ?? 0; const a = byPage.get(p); if (a) a.push(t); else byPage.set(p, [t]); }
  const groups: PageGroup[] = [...byPage.entries()].map(([page_index, ts]) => {
    const sorted = ts.slice().sort((a, b) => b.seq - a.seq); // 组内新→旧
    const latest = sorted[0];
    const prev = (latest.inference_view?.question || latest.inference_view?.marked || latest.ai_reply || '').replace(/\s+/g, ' ').slice(0, 34);
    return { page_index, latestSeq: latest.seq, time: fmtTime(latest.created_at), preview: prev, count: sorted.length, bodyHtml: sorted.map((t) => turnBlock(t, idxMap.get(t.entry_id) ?? 0, markMap)).join('') };
  }).sort((a, b) => b.latestSeq - a.latestSeq); // 最近活动的页在最上
  renderGroupList(inner, groups, '轮');
  if (thread) thread.scrollTop = 0; // 最新页在最上、默认展开 → 滚顶即见最新
}

const SHAPE_CN: Record<string, string> = { circle: '圈', underline: '划线', highlight: '高亮', arrow: '箭头', margin_note: '手写', stroke: '标记', tap_region: '点选' };
/** 一个 mark 的"识别结果"标签：手写/画/markup + 识别出的文字（识别分类器的产物）。 */
function featureLabel(m: PersistedMark): string {
  const txt = (m.marked_text || '').replace(/\s+/g, ' ').slice(0, 18);
  if (m.feature_type === 'handwriting') return `手写「${txt || '…'}」`;
  if (m.feature_type === 'drawing') return `画${txt ? `「${txt}」` : '（无字）'}`;
  return `${SHAPE_CN[m.scored_type] || '标记'}「${txt || '—'}」`;
}

/* ── 处理流水线渲染（逐组件「收到什么 → 产出什么」时间线）─────────────────────── */

function ioRows(rows?: PipelineStageIO[]): string {
  if (!rows?.length) return '';
  return rows.map((r) => {
    const val = r.v || '';
    const long = val.length > 64 || val.includes('\n');
    return `<div class="cns-pl-kv"><span class="k">${esc(r.k)}：</span><span class="v${long ? ' long' : ''}">${esc(val || '—')}</span></div>`;
  }).join('');
}
function imgRow(imgs?: Array<{ role: string; thumb: string }>): string {
  if (!imgs?.length) return '';
  return `<div class="cns-pl-imgs">`
    + imgs.map((im) => {
      const safeThumb = /^data:image\//.test(im.thumb) ? esc(im.thumb) : ''; // 只放行本地截图 data:image/ URL + esc，杜绝 src 属性逃逸
      return `<div class="cns-pl-img"><img class="cns-zoom" src="${safeThumb}" alt=""><span>${esc(im.role)}</span></div>`;
    }).join('')
    + `</div>`;
}
/** 一个组件阶段卡：summary（mark 标 + 名 + 状态 + note）+ body（收到 → 图 → 产出）。 */
function stageCard(st: PipelineStage): string {
  const open = (st.stage === 'model' || st.stage === 'inferview') ? ' open' : ''; // 末两步默认展开
  const tag = st.status === 'skipped' ? '<span class="cns-pl-tag skipped">跳过</span>'
    : st.status === 'error' ? '<span class="cns-pl-tag error">出错</span>' : '';
  const markChip = st.mark_ord ? `<span class="cns-pl-mark">mark ${st.mark_ord}·${esc(st.mark_label || '')}</span>` : '';
  return `<details class="cns-pl-stage ${st.status ?? ''}"${open}>`
    + `<summary class="cns-pl-sum">${markChip}<span class="cns-pl-name">${esc(st.label)}</span>${tag}<span class="cns-pl-note">${esc(st.note || '')}</span></summary>`
    + `<div class="cns-pl-body">`
    + (st.input?.length ? `<div class="cns-pl-io"><div class="cns-pl-io-h">↓ 收到（输入）</div>${ioRows(st.input)}</div>` : '')
    + imgRow(st.images)
    + (st.output?.length ? `<div class="cns-pl-io"><div class="cns-pl-io-h out">↑ 产出（输出）</div>${ioRows(st.output)}</div>` : '')
    + `</div></details>`;
}
function pipelineSection(stages: PipelineStage[]): string {
  return `<div class="cns-sec">处理流水线（逐组件：收到什么 → 产出什么 · ${stages.length} 步）</div>`
    + `<div class="cns-pl">` + stages.map(stageCard).join('') + `</div>`;
}

/** 旧轮（无 pipeline 快照）的兜底展示：保留分类器判定 + 蒸馏字段 + 正文/prompt 折叠块。 */
function legacySection(t: PersistedAiTurn, markMap: Map<string, PersistedMark>): string {
  const v = t.inference_view;
  const diag = t.diag ?? {};
  const classify = diag.classify
    ? `<div class="cns-kv"><span class="k">上下文分类器：</span>${diag.classify.respond ? '<span class="cns-yes">回应 ✓</span>' : '<span class="cns-no">折叠 ✗</span>'} — ${esc(diag.classify.reason || '')}</div>`
    : `<div class="cns-kv"><span class="k">上下文分类器：</span>未触发（长停顿综合走 idle，无需判定）</div>`;
  const chips = (t.anchor?.mark_ids ?? []).map((id) => markMap.get(id)).filter((m): m is PersistedMark => !!m)
    .map((m) => `<span class="cns-chip">${esc(featureLabel(m))}</span>`).join('');
  const markRow = `<div class="cns-kv"><span class="k">识别（逐 mark）：</span>${chips || '<span class="cns-chip" style="color:var(--hint)">（无 mark 记录）</span>'}</div>`;
  const q = v?.question ? `<div class="cns-kv"><span class="k">手写问：</span>${esc(v.question)}</div>` : '';
  const sentImg = diag.sent_image ? '<span class="cns-yes">有</span>' : '无';
  const ctx = v?.page_context || '';
  const ctxBlock = ctx
    ? `<details class="cns-ctx"><summary><span class="cns-ctx-h">📄 正文块（滑动窗 ${ctx.length} 字）</span><span class="cns-ctx-prev">${esc(ctx.slice(0, 150))}…</span></summary><div class="cns-ctx-body">${esc(ctx)}</div></details>`
    : `<div class="cns-kv"><span class="k">正文块：</span>（无）</div>`;
  const prompt = t.prompt_snapshot || '';
  const promptBlock = `<details class="cns-ctx"><summary><span class="cns-ctx-h">🧾 完整 prompt（${prompt.length} 字）</span><span class="cns-ctx-prev">${esc(prompt.slice(0, 130))}…</span></summary><div class="cns-ctx-body">${esc(prompt || '—')}</div></details>`;
  return `<div class="cns-sec">分类器判定</div>` + classify + markRow
    + `<div class="cns-sec">蒸馏后喂入（inference-view）</div>`
    + `<div class="cns-kv"><span class="k">关系叙事：</span>${esc(v?.narrative || '—')}</div>`
    + `<div class="cns-kv"><span class="k">所标内容：</span>${esc(v?.marked || '—')}</div>`
    + q
    + `<div class="cns-kv"><span class="k">锚点：</span>${t.anchor?.object_refs?.length ?? 0} 对象 / ${t.anchor?.mark_ids?.length ?? 0} 笔 · 随发图：${sentImg}</div>`
    + ctxBlock + promptBlock;
}

/**
 * 一轮 = 用户内容块 + AI 回复气泡（含思考过程）。
 *   用户块：有处理流水线快照(pipeline)→渲染逐组件「收到→产出」时间线（含图）；
 *   旧轮无快照→兜底走 legacySection（分类器判定 + 蒸馏字段 + 正文/prompt 折叠）。
 */
function turnBlock(t: PersistedAiTurn, idx: number, markMap: Map<string, PersistedMark>): string {
  const trig = TRIGGER_CN[t.trigger] ?? { t: t.trigger, c: '#8a877f' };
  const folded = t.overlay_state === 'folded'; // 手写被判「写给自己」→ 静默未回应，仍入账供此处复盘
  const reply = t.ai_reply || '（空回复）';
  const think = (t.thinking || '').trim();
  const userInner = (t.pipeline && t.pipeline.length) ? pipelineSection(t.pipeline) : legacySection(t, markMap);

  const thinkBlock = think
    ? `<details class="cns-think"><summary>💭 思考过程（${think.length} 字）</summary><div class="cns-think-body">${esc(think)}</div></details>`
    : `<div class="cns-nothink">无思考过程返回（当前模型不回传；切到 claude-sonnet-4-6 可见）</div>`;

  // 折叠轮：不渲 AI 气泡，改给一条"未回应"说明（判否理由已在上方 legacySection 的「分类器判定」里）。
  const resultSection = folded
    ? `<div class="cns-label" style="margin-top:14px">结果</div>`
      + `<div class="cns-row ai"><div class="cns-col"><div class="cns-bub" style="background:#f3efe7;border:1px dashed #d8cdbb;color:#6d655c">`
      + `🚫 折叠为「写给自己的笔记」——上下文分类器判无需回应，未触发主模型。这条手写仍留在 session，计入下次长停顿综合。`
      + `</div><div class="cns-meta">#${idx} · 未回应（fold）</div></div></div>`
    : `<div class="cns-label" style="margin-top:14px">AI 回复</div>`
      + `<div class="cns-row ai"><div class="cns-col"><div class="cns-bub ai">${esc(reply)}</div>`
      + thinkBlock
      + `<div class="cns-meta">#${idx} · ${esc(t.model || '')}${t.supersedes ? ' · 改写' : ''}</div></div></div>`;

  return `<div class="cns-turn">`
    + `<div class="cns-label">发送给 AI 的内容 · 第 ${(t.page_index ?? 0) + 1} 页 · <span class="cns-trig" style="background:${trig.c}">${esc(trig.t)}</span>${folded ? ' · <span class="cns-trig" style="background:#a99">折叠</span>' : ''} · ${fmtTime(t.created_at)}</div>`
    + `<div class="cns-userwrap"><div class="cns-usercard">` + userInner + `</div></div>`
    + resultSection
    + `</div>`;
}

/* ── 采集取证 / 感知层页（合并 HMP 取证 + SurfaceIndex 对象，深度联动）────────────────
 * 一页两段：① HMP 取证（全书逐笔，新→旧）② SurfaceIndex 对象（本页对象表，refs 的字典）。
 * 二者是同一批对象 id 的消费者/生产者——HMP.target_object_refs 指进对象表。互跳：点 HMP 命中
 * 对象 ref → 跳对象段高亮那行；对象行「被命中」chip → 跳 HMP 段高亮那张卡。
 * 对象 id 是页内的，故互跳/原文解析天然只对当前页成立（state.surfaceIndex 只有当前页）。
 * HMP 段骨架=每本书折叠 mark 账本（getFoldedMarks，持久·全量·跨 reload），叠本会话 state.lastHmps
 * 的取证图（落库剥 crop/ink，仅本会话标注带图）+ 未落库最新一笔即时占位。 */

let captureSeg: 'hmp' | 'objects' = 'hmp';

const HMP_MODE: Record<string, { t: string; c: string }> = {
  anchored: { t: '锚定原文', c: '#22c55e' }, self_content: { t: '自身内容', c: '#f59e0b' },
  mixed: { t: '混合', c: '#3b82f6' }, unknown: { t: '未命中', c: '#ef4444' },
};
const HMP_ACTION: Record<string, string> = { enclosure: '圈', underline: '划线', cross: '叉', arrow: '箭头', handwriting: '手写', sketch: '草图', highlight: '高亮', unknown: '未知' };
const HMP_HINT: Record<string, string> = { text: '文字', image_region: '图区', ui_region: 'UI', blank: '空白', diagram: '图表', unknown: '未知' };
const HMP_FEAT: Record<string, string> = { markup: '标记', handwriting: '手写', drawing: '画' };

/** 一行取证记录：账本 mark 为骨架，可叠本会话取证图。 */
interface HmpRow {
  key: string; hmp: HMP; marked: string; feature: string;
  page_index: number; page_id: string; seq: number; created_at: string; live: boolean; unsaved: boolean;
}

function featureFromAction(action: string): string {
  if (action === 'handwriting') return 'handwriting';
  if (action === 'sketch') return 'drawing';
  return 'markup';
}

async function buildHmpRows(book: string): Promise<HmpRow[]> {
  const persisted = (await getFoldedMarks(book)).filter((m) => m.hmp);
  const liveById = new Map(state.lastHmps.map((h) => [h.hmp_id, h]));
  const seen = new Set<string>();
  const rows: HmpRow[] = persisted.map((m) => {
    const id = m.hmp!.hmp_id; seen.add(id);
    const live = liveById.get(id);
    // 账本剥了图：若本会话还留着同一条 HMP，把 crop/ink 借回来显示
    const hmp = live && (live.crop_ref || live.vector_ref) ? { ...m.hmp!, crop_ref: live.crop_ref, vector_ref: live.vector_ref } : m.hmp!;
    return { key: m.mark_id, hmp, marked: m.marked_text, feature: m.feature_type, page_index: m.page_index, page_id: m.page_id, seq: m.seq, created_at: m.created_at, live: !!live, unsaved: false };
  });
  // 未落库的最新一笔（hmp:updated 早于 appendMarkEntry 一个 tick）：即时占位。lastHmps 是全局的，
  // 只在"选中书=当前打开的书"时才并入，避免把别的书的未落库笔串进来。
  if (selectedBook === state.documentId) {
    for (const h of state.lastHmps) {
      if (seen.has(h.hmp_id)) continue;
      rows.push({ key: h.hmp_id, hmp: h, marked: h.text_hint || '', feature: featureFromAction(h.action), page_index: state.pageIndex, page_id: h.surface_id, seq: Number.MAX_SAFE_INTEGER, created_at: '', live: true, unsaved: true });
    }
  }
  return rows.sort((a, b) => b.seq - a.seq); // 新→旧：未落库的最新在最上
}

function hmpShots(hmp: HMP): string {
  const shot = (data: string | undefined, cap: string): string => data
    ? `<div class="hmp-shot"><img class="cns-zoom" src="${data}" alt="${esc(cap)}"><span>${esc(cap)}</span></div>` : '';
  const crop = shot(hmp.crop_ref, 'composite 叠原文');
  const ink = shot(hmp.vector_ref, '笔迹 ink');
  return (crop || ink)
    ? `<div class="hmp-shots">${crop}${ink}</div>`
    : `<div class="hmp-noshot">无取证图<br>（历史标注落库已剥图）</div>`;
}

/** 一笔的短 chip 标签（对象段「被命中」用）。 */
function markChipLabel(feature: string, marked: string): string {
  const t = (marked || '').replace(/\s+/g, ' ').slice(0, 10);
  return `${HMP_FEAT[feature] ?? feature}${t ? `「${t}」` : ''}`;
}

/** 命中对象行：当前页→每 ref 渲成可跳 cap-link（解析回原文，dangling 标红）；非当前页只显条数（不误报"缺"）。 */
function hmpTargetRow(row: HmpRow, objMap: Map<string, SurfaceObject> | null): string {
  const refs = row.hmp.target_object_refs;
  if (!refs.length) return `<div class="cns-kv"><span class="k">命中对象：</span><span class="hmp-xpage">空（未命中 / 自身内容）</span></div>`;
  if (objMap) {
    const parts = refs.map((id) => {
      const o = objMap.get(id);
      return o
        ? `<span class="cap-link" data-ref="${esc(id)}" title="跳到对象表这一行">${esc(id)}「${esc((o.text || '·' + o.type).slice(0, 24))}」</span>`
        : `${esc(id)}<span class="hmp-miss">(缺)</span>`;
    });
    return `<div class="cns-kv"><span class="k">命中对象（${refs.length}）：</span>${parts.join('　')}</div>`;
  }
  return `<div class="cns-kv"><span class="k">命中对象：</span><span class="hmp-xpage">${refs.length} 个（在第 ${row.page_index + 1} 页，切到该页可解析回原文 + 互跳）</span></div>`;
}

function hmpCard(row: HmpRow, objMap: Map<string, SurfaceObject> | null): string {
  const h = row.hmp;
  const mode = HMP_MODE[h.mode] ?? { t: h.mode, c: '#8a877f' };
  const region = `[${h.target_region.map((n) => n.toFixed(3)).join(', ')}]`;
  return `<div class="hmp-card" data-mark="${esc(row.key)}">`
    + `<div class="hmp-chead">`
    + `<span class="hmp-mode" style="background:${mode.c}">${esc(mode.t)}</span>`
    + `<span class="hmp-act">${esc(HMP_ACTION[h.action] ?? h.action)}</span>`
    + `<span class="hmp-feat">${esc(HMP_FEAT[row.feature] ?? row.feature)}</span>`
    + (row.unsaved ? `<span class="hmp-live">本次会话·未落库</span>` : row.live ? `<span class="hmp-live">本次会话</span>` : '')
    + `<span class="hmp-cmeta">${esc(HMP_HINT[h.object_hint] ?? h.object_hint)} · 信心 ${h.confidence.toFixed(2)} · v${esc(h.version)} · 第 ${row.page_index + 1} 页</span>`
    + `</div>`
    + `<div class="hmp-body">${hmpShots(h)}<div class="hmp-fields">`
    + `<div class="cns-kv"><span class="k">所标内容：</span>${esc(row.marked || '（未提取到文字）')}</div>`
    + hmpTargetRow(row, objMap)
    + `<div class="cns-kv"><span class="k">读出 text_hint：</span>${esc(h.text_hint || '—')}</div>`
    + `<div class="cns-kv"><span class="k">区域 region：</span>${region}</div>`
    + `</div></div></div>`;
}

/** SurfaceIndex 对象段：本页对象表（step① 源头）+ 每行「被命中」的笔 chip（可跳 HMP 卡）。 */
function renderObjTable(objMarks: Map<string, Array<{ id: string; label: string }>>): string {
  const si = state.surfaceIndex;
  if (!si || !si.objects.length) return `<p class="cns-empty">本页无 SurfaceIndex 对象。<br>打开一本 PDF、翻到某页——这里显示该页被解析出的对象表（HMP 的 refs 就指向它们）。</p>`;
  const CAP = 150;
  const shown = si.objects.slice(0, CAP);
  const dist: Record<string, number> = {};
  for (const o of si.objects) dist[o.type] = (dist[o.type] ?? 0) + 1;
  const distStr = Object.entries(dist).map(([k, n]) => `${k} ${n}`).join(' · ');
  const body = shown.map((o) => {
    const hits = objMarks.get(o.id) ?? [];
    const chips = hits.length
      ? hits.map((h) => `<span class="cap-markchip" data-mark="${esc(h.id)}" title="跳到 HMP 这张卡">${esc(h.label)}</span>`).join('')
      : '<span class="cap-dim">—</span>';
    return `<tr data-objid="${esc(o.id)}"><td class="cap-mono">${esc(o.id)}</td><td>${esc(o.type)}</td><td>${esc(o.role || '—')}</td><td class="cap-mono">${o.bbox.map((n) => n.toFixed(3)).join(',')}</td><td>${esc((o.text || '').slice(0, 40) || '—')}</td><td>${esc(o.source)}</td><td>${chips}</td></tr>`;
  }).join('');
  return `<p class="hmp-note">本页 SurfaceIndex 对象表（step①：页被解析成什么）——HMP 的 target_object_refs 指向这些 id。surface=${esc(si.surface_type)} · 共 ${si.objects.length} 个 · ${esc(distStr)}${si.objects.length > CAP ? ` · 仅显前 ${CAP}` : ''}。「被命中」可点回 HMP 卡。</p>`
    + `<table class="cap-tbl"><thead><tr><th>id</th><th>type</th><th>role</th><th>bbox</th><th>text</th><th>src</th><th>被命中</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** 渲染两段内容（HMP 取证 + 对象表），并备好 ref↔对象 互跳所需的映射。 */
async function renderCaptureContent(): Promise<void> {
  const hmpInner = document.getElementById('hmp-inner');
  const objInner = document.getElementById('obj-inner');
  if (!hmpInner || !objInner) return;
  if (!selectedBook) {
    hmpInner.innerHTML = `<p class="cns-empty">还没有书籍。导入一本 PDF、圈/划/写一处，取证记录会出现在这里。</p>`;
    objInner.innerHTML = renderObjTable(new Map());
    return;
  }
  const rows = await buildHmpRows(selectedBook);
  const si = state.surfaceIndex; // 仅当前页对象表 → 只有当前页的 mark 能解析回原文/互跳
  const objMap = si ? new Map(si.objects.map((o) => [o.id, o])) : null;
  // 对象→命中它的笔（仅当前页：对象 id 是页内的）。从已合并的 rows 派生，含未落库的本会话笔。
  const objMarks = new Map<string, Array<{ id: string; label: string }>>();
  if (si) for (const r of rows) {
    if (r.page_id !== si.surface_id) continue;
    for (const ref of r.hmp.target_object_refs) {
      const arr = objMarks.get(ref) ?? [];
      arr.push({ id: r.key, label: markChipLabel(r.feature, r.marked) });
      objMarks.set(ref, arr);
    }
  }
  if (!rows.length) {
    hmpInner.innerHTML = `<p class="cns-empty">这本书还没有标注取证记录。<br>圈/划/写一处、停笔，每一笔的 HMP（命中了什么 / 读出什么 / 取证图）会在这里出现。</p>`;
    hmpPageOfMark = new Map(); hmpBodyByPage = new Map();
  } else {
    // 按页分组（rows 已新→旧，per-page 数组保序）
    const byPage = new Map<number, HmpRow[]>();
    for (const r of rows) { const a = byPage.get(r.page_index); if (a) a.push(r); else byPage.set(r.page_index, [r]); }
    hmpPageOfMark = new Map(rows.map((r) => [r.key, r.page_index]));
    const groups: PageGroup[] = [...byPage.entries()].map(([page_index, rs]) => {
      const latest = rs[0];
      return { page_index, latestSeq: latest.seq, time: latest.created_at ? fmtTime(latest.created_at) : '本会话', preview: markChipLabel(latest.feature, latest.marked), count: rs.length,
        bodyHtml: rs.map((r) => hmpCard(r, (objMap && si && r.page_id === si.surface_id) ? objMap : null)).join('') };
    }).sort((a, b) => b.latestSeq - a.latestSeq);
    hmpInner.innerHTML = `<p class="hmp-note">逐笔 HMP 取证——按页分组，最新页默认展开、旧页收起。点蓝色「命中对象」可跳对象表对照。共 ${rows.length} 笔。</p><div id="hmp-grp"></div>`;
    const grp = document.getElementById('hmp-grp');
    hmpBodyByPage = grp ? renderGroupList(grp, groups, '笔') : new Map();
  }
  objInner.innerHTML = renderObjTable(objMarks);
}

/** 切段（HMP 取证 ↔ SurfaceIndex 对象）。 */
function setSeg(seg: 'hmp' | 'objects'): void {
  captureSeg = seg;
  document.getElementById('cap-wrap')?.setAttribute('data-seg', seg);
  document.querySelectorAll<HTMLButtonElement>('#cap-seg .cap-segbtn').forEach((b) => b.classList.toggle('active', b.dataset.seg === seg));
}

/** 滚到目标元素并闪一下高亮（互跳定位）。 */
function flashTarget(sel: string): void {
  const el = document.querySelector(sel) as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('cap-flash'); void el.offsetWidth; el.classList.add('cap-flash');
  window.setTimeout(() => el.classList.remove('cap-flash'), 1500);
}

function renderCapture(c: HTMLDivElement): void {
  if (!selectedBook) selectedBook = state.documentId ?? null;
  c.innerHTML =
    `<div class="cns-head"><h2>${icon('scan')} 采集取证</h2>`
    + `<div id="cap-seg"><button class="cap-segbtn" data-seg="hmp">HMP 取证</button><button class="cap-segbtn" data-seg="objects">SurfaceIndex 对象</button></div>`
    + `<div class="cns-head-ctl"><select id="cap-book-sel"></select><button class="cns-btn" id="cap-refresh">⟳ 刷新</button></div></div>`
    + `<div class="cns-thread"><div id="cap-wrap" data-seg="${captureSeg}">`
    + `<div class="cap-pane cap-hmp"><div class="hmp-inner" id="hmp-inner"></div></div>`
    + `<div class="cap-pane cap-obj"><div class="obj-inner" id="obj-inner"></div></div>`
    + `</div></div>`;
  const sel = c.querySelector<HTMLSelectElement>('#cap-book-sel');
  sel?.addEventListener('change', () => { selectedBook = sel.value; void renderCaptureContent(); });
  c.querySelector('#cap-refresh')?.addEventListener('click', () => { void fillBookSelect('cap-book-sel').then(() => renderCaptureContent()); });
  c.querySelectorAll<HTMLButtonElement>('#cap-seg .cap-segbtn').forEach((b) => b.addEventListener('click', () => setSeg(b.dataset.seg as 'hmp' | 'objects')));
  setSeg(captureSeg);
  void fillBookSelect('cap-book-sel').then(() => renderCaptureContent());
}

/* ── 设置页（迁出旧 #dev 抽屉；按代码审计诚实标注每项是否真生效）─────────────────────
 * settings 落 localStorage（inkloop.prefs.v1 产品键 / inkloop.devflags.v1 dev 键）；多数项改完 effect='changed'（emit settings:changed
 * → main 取消在途计时 + 清当前 session），少数仅 saveSettings()。可用性徽标来自本会话审计：
 * 生效=v3 主路真读；调试叠层=只影响可视化；弱效=仅下次导入文档时生效（预排版预热）。 */

type SetBadge = { t: string; c: 'live' | 'dev' | 'weak' | 'dead' };
const B_LIVE: SetBadge = { t: '生效', c: 'live' };
const B_DEV: SetBadge = { t: '调试叠层', c: 'dev' };
const B_WEAK: SetBadge = { t: '弱效', c: 'weak' };

type SetRow =
  | { kind: 'check'; label: string; badge: SetBadge; hint?: string; get: () => boolean; set: (v: boolean) => void; effect: 'changed' | 'save' }
  | { kind: 'select'; label: string; badge: SetBadge; hint?: string; opts: Array<[string, string]>; get: () => string; set: (v: string) => void; effect: 'changed' | 'save' }
  | { kind: 'number'; label: string; badge: SetBadge; hint?: string; min: number; max: number; unit: string; get: () => number; set: (v: number) => void; effect: 'changed' | 'save' };
interface SetSection { title: string; note?: string; fold?: boolean; rows: SetRow[] }

function setSections(): SetSection[] {
  const g = settings.gesture, p = settings.preprocess;
  return [
    { title: '核心 · 影响真实行为', rows: [
      { kind: 'select', label: '推理模型（答问 · 分类器默认）', badge: B_LIVE, opts: [['kimi-k2.6', 'kimi-k2.6（中文笔迹稳）'], ['claude-opus-4-8', 'claude-opus-4-8（最新·慢）'], ['claude-opus-4-7', 'claude-opus-4-7（质量·慢）'], ['claude-sonnet-4-6', 'claude-sonnet-4-6（快·能回思考）'], ['gemini-3.5-flash', 'gemini-3.5-flash'], ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite（快）']], get: () => settings.inferModel, set: (v) => { settings.inferModel = v; }, effect: 'changed' },
      { kind: 'select', label: '识别分类器模型 · /api/interpret（空=继承推理模型）', badge: B_LIVE, opts: [['', '继承推理模型'], ['__local_hwr__', '端侧手写·OpenVINO 英文(徐方案·走本地端点)'], ['kimi-k2.6', 'kimi-k2.6'], ['claude-opus-4-8', 'claude-opus-4-8'], ['claude-sonnet-4-6', 'claude-sonnet-4-6'], ['gemini-3.5-flash', 'gemini-3.5-flash'], ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite']], get: () => settings.interpretModel, set: (v) => { settings.interpretModel = v; }, effect: 'changed' },
      { kind: 'select', label: '上下文分类器模型 · /api/classify-context（空=继承推理模型）', badge: B_LIVE, opts: [['', '继承推理模型'], ['__local_rules__', '端侧规则·徐 IntentClassifier（驱动 respond/fold·不调云）'], ['kimi-k2.6', 'kimi-k2.6'], ['claude-opus-4-8', 'claude-opus-4-8'], ['claude-sonnet-4-6', 'claude-sonnet-4-6'], ['gemini-3.5-flash', 'gemini-3.5-flash'], ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite']], get: () => settings.classifyModel, set: (v) => { settings.classifyModel = v; }, effect: 'changed' },
      { kind: 'check', label: '送合成图给模型', hint: '强制把合成图/笔迹图也送进主模型；默认关＝纯文字取证路线（徐方案）', badge: B_LIVE, get: () => settings.sendMarkImage, set: (v) => { settings.sendMarkImage = v; }, effect: 'changed' },
      { kind: 'select', label: '输出落点', badge: B_LIVE, opts: [['margin', '右侧留白'], ['inline', '贴正文浮动']], get: () => settings.placement, set: (v) => { settings.placement = v as Placement; }, effect: 'changed' },
      { kind: 'check', label: '手势响应（总开关）', hint: '关掉后停笔不再生成 HMP+旁注、不触发综合', badge: B_LIVE, get: () => g.enabled, set: (v) => { g.enabled = v; }, effect: 'changed' },
      { kind: 'number', label: '长停顿综合阈值', unit: '秒', min: 10, max: 600, hint: '停笔多少秒触发整段 session 综合（v3 主线，默认 90）；调小可冒烟测', badge: B_LIVE, get: () => g.idleSeconds ?? 90, set: (v) => { g.idleSeconds = v; }, effect: 'changed' },
      { kind: 'select', label: '重排引擎', badge: B_LIVE, opts: [['ai', 'AI 结构重建（主线·保 bbox）'], ['local', '仅启发式'], ['hybrid', '启发式+模型精修'], ['vision', '启发式+视觉重排'], ['rewrite', 'VLM 看图重写']], get: () => settings.reflowProvider, set: (v) => { settings.reflowProvider = v; }, effect: 'changed' },
      { kind: 'select', label: '重排模型', badge: B_LIVE, opts: [['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite（默认·快）'], ['gemini-3.5-flash', 'gemini-3.5-flash'], ['kimi-k2.6', 'kimi-k2.6（慢·对照）'], ['claude-sonnet-4-6', 'claude-sonnet-4-6（准·对照）']], get: () => settings.reflowModel, set: (v) => { settings.reflowModel = v; }, effect: 'changed' },
      { kind: 'check', label: '重排前置（渲染即后台急算）', hint: '每次翻页后台预排当前页·烧 token；默认关', badge: B_LIVE, get: () => settings.reflowEager, set: (v) => { settings.reflowEager = v; }, effect: 'save' },
    ] },
    { title: '调试叠层 · 只影响可视化、不碰推理', rows: [
      { kind: 'check', label: '显示 bbox 叠层（对象框+命中高亮+HMP 浮窗）', badge: B_DEV, get: () => settings.devOverlay, set: (v) => { settings.devOverlay = v; }, effect: 'changed' },
      { kind: 'check', label: '显示组装区域（手写实时框）', badge: B_DEV, get: () => settings.showRegion, set: (v) => { settings.showRegion = v; }, effect: 'changed' },
      { kind: 'check', label: '显示关联框（综合后紫色虚框）', badge: B_DEV, get: () => settings.showRelations, set: (v) => { settings.showRelations = v; }, effect: 'changed' },
    ] },
    { title: '历史 / 弱效 · 仅特定时机生效（按代码审计标注）', note: '保留可调，但仅下次导入文档时生效。', fold: true, rows: [
      { kind: 'check', label: '预排版前 N 页', hint: '仅下次导入文档时生效', badge: B_WEAK, get: () => p.reflowEnabled, set: (v) => { p.reflowEnabled = v; }, effect: 'save' },
      { kind: 'number', label: '预排版页数', unit: '页', min: 0, max: 100, badge: B_WEAK, get: () => p.reflowPages, set: (v) => { p.reflowPages = v; }, effect: 'save' },
    ] },
  ];
}

function setRowHtml(r: SetRow, id: string): string {
  const badge = `<span class="set-badge ${r.badge.c}">${esc(r.badge.t)}</span>`;
  const hint = r.hint ? `<div class="cset-hint">${esc(r.hint)}</div>` : '';
  let ctl: string;
  if (r.kind === 'check') ctl = `<input type="checkbox" id="${id}"${r.get() ? ' checked' : ''}>`;
  else if (r.kind === 'select') ctl = `<select id="${id}">${r.opts.map(([v, t]) => `<option value="${esc(v)}"${v === r.get() ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  else ctl = `<input type="number" id="${id}" min="${r.min}" max="${r.max}" step="1" value="${r.get()}"><span class="cset-unit">${esc(r.unit)}</span>`;
  return `<div class="cset-row"><div class="cset-text"><div class="cset-l"><span class="cset-label">${esc(r.label)}</span>${badge}</div>${hint}</div><div class="cset-control">${ctl}</div></div>`;
}

function applySetEffect(effect: 'changed' | 'save'): void {
  if (effect === 'changed') bus.emit('settings:changed'); // → main cancelTimers + clearSession
  saveSettings();
}

/* 诊断（迁自旧 #dev 抽屉的几个孤儿读数：坐标自测 / 延迟指标 / 预处理进度 / trace 导出）。 */
function diagHtml(): string {
  return `<details class="cset-fold cset-sec" id="cset-diag"><summary>诊断 · 迁自旧 dev 面板</summary>`
    + `<div class="cset-sec-note">坐标变换自测、各阶段延迟、预处理进度、trace 导出——旧 #dev 退役后搬到这里。</div>`
    + `<div class="cset-row"><div class="cset-text"><div class="cset-l"><span class="cset-label">坐标自测</span></div><div class="cset-hint" id="cset-selftest">…</div></div></div>`
    + `<div class="cset-row"><div class="cset-text"><div class="cset-l"><span class="cset-label">预处理进度</span></div><div class="cset-hint" id="cset-pp">未运行</div></div></div>`
    + `<div class="cset-row"><div class="cset-text" style="width:100%"><div class="cset-l"><span class="cset-label">延迟指标（last / P50）</span></div><table class="cap-tbl" id="cset-metrics" style="margin-top:7px"><tbody></tbody></table></div></div>`
    + `<div class="cset-row"><div class="cset-text"><div class="cset-l"><span class="cset-label">Trace 事件日志</span></div><div class="cset-hint" id="cset-tracecount">导出本会话所有 trace（NDJSON），离线核对采集/推理细节</div></div><div class="cset-control"><button class="cns-btn" id="cset-dl-trace">下载 JSONL</button></div></div>`
    + `</details>`;
}
function fillDiag(): void {
  const st = document.getElementById('cset-selftest');
  if (st) { const r = selfTest(); st.textContent = r.samples ? `${r.ok ? '✓' : '✗'} ${r.samples} 点 · maxErr ${r.maxErr.toExponential(1)} · zoom ${Math.round(state.zoom * 100)}%` : '等待页面渲染'; }
  const mb = document.getElementById('cset-metrics')?.querySelector('tbody');
  if (mb) mb.innerHTML = snapshot().map((r) => `<tr><td>${esc(r.label)}</td><td class="cap-mono">${r.last == null ? '–' : r.last + 'ms'}</td><td class="cap-mono">${r.p50 == null ? '–' : r.p50 + 'ms'}</td></tr>`).join('') || '<tr><td class="cap-dim" colspan="3">暂无计时</td></tr>';
  const tc = document.getElementById('cset-tracecount');
  if (tc) tc.textContent = `本会话 ${traceCount()} 条 trace；导出 NDJSON 离线核对采集/推理细节`;
}

let resetArmed = false;
function renderSettings(c: HTMLDivElement): void {
  let n = 0;
  const flat: Array<{ id: string; row: SetRow }> = [];
  const secHtml = setSections().map((s) => {
    const rowsHtml = s.rows.map((row) => { const id = `cset-${n++}`; flat.push({ id, row }); return setRowHtml(row, id); }).join('');
    const note = s.note ? `<div class="cset-sec-note">${esc(s.note)}</div>` : '';
    return s.fold
      ? `<details class="cset-fold cset-sec"><summary>${esc(s.title)}</summary>${note}${rowsHtml}</details>`
      : `<div class="cset-sec"><div class="cset-sec-h">${esc(s.title)}</div>${note}${rowsHtml}</div>`;
  }).join('');
  c.innerHTML =
    `<div class="cns-head"><h2>${icon('settings')} 设置</h2><div class="cns-head-ctl">`
    + `<button class="cns-btn" id="cset-reset" title="清掉 localStorage 里存的设置、重载回代码默认">恢复默认设置</button>`
    + `</div></div>`
    + `<div class="cns-thread"><div class="cset-wrap">${secHtml}${diagHtml()}`
    + `<div class="cset-actions"><span class="cset-hint">设置存于浏览器 localStorage（inkloop.prefs.v1 / inkloop.devflags.v1），即时生效；个别项需翻页/重导/清上下文才显现，已在各项标注。徽标含义：生效=v3 主路真读 · 调试叠层=只影响可视化 · 弱效=读它的路径当前主路不走或仅导入时生效 · 失效=当前无人按它分流。</span></div>`
    + `</div></div>`;
  document.getElementById('cset-dl-trace')?.addEventListener('click', () => downloadTrace());
  fillDiag();
  for (const { id, row } of flat) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) continue;
    el.addEventListener('change', () => {
      if (row.kind === 'check') row.set((el as HTMLInputElement).checked);
      else if (row.kind === 'select') row.set(el.value);
      else { const v = Math.min(row.max, Math.max(row.min, Math.round(+el.value || 0))); row.set(v); (el as HTMLInputElement).value = String(v); }
      applySetEffect(row.effect);
    });
  }
  resetArmed = false;
  const resetBtn = c.querySelector<HTMLButtonElement>('#cset-reset');
  resetBtn?.addEventListener('click', () => {
    if (!resetArmed) { resetArmed = true; resetBtn.textContent = '再点一次确认（清存档·重载）'; resetBtn.classList.add('cset-danger'); return; }
    resetSettings(); // 删产品键 + dev 键 + 旧扁平键（state 层收口，不再硬编码单键）
    location.reload();
  });
}

/* ── 路由 / 初始化 ───────────────────────────────────────────────────────── */

function syncFromHash(): void {
  const id = location.hash.replace(/^#/, '') as PageId;
  const def = PAGES.find((p) => p.id === id);
  if (def && def.ready && id !== 'reader') showPage(id); // #chat / #hmp / #settings 已实现页
  else showPage('reader'); // 其余（含历史 #dev 链接）一律回到阅读底
}

export function initNavShell(): void {
  // 注入会议 ↔ 导航壳桥：go=切页、activePage=读当前页；initMeeting 内部捕获 boot 主阅读实例。
  initMeeting({ go, activePage: () => activePage });
  buildShell();

  try { if (localStorage.getItem('inkloop.rail.collapsed') === '1') document.body.classList.add('rail-collapsed'); } catch { /* ignore */ }
  try { if (localStorage.getItem('inkloop.rail.dev') === '1') setDevExpanded(true); } catch { /* ignore */ }

  // 流水线/取证缩略图 → 点开放大（事件委托，重渲后仍生效）
  document.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement;
    if (!tgt?.classList?.contains('cns-zoom')) return;
    const lb = document.getElementById('cns-lightbox');
    const img = lb?.querySelector('img');
    if (lb && img) { img.setAttribute('src', (tgt as HTMLImageElement).src); lb.classList.add('show'); }
  });

  // 采集取证页互跳：HMP 命中对象 ref ↔ 对象表行（对象 id 页内唯一，互跳只对当前页成立）
  document.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement;
    const refEl = tgt?.closest?.('.cap-link') as HTMLElement | null;
    if (refEl?.dataset.ref) { setSeg('objects'); flashTarget(`#obj-inner tr[data-objid="${CSS.escape(refEl.dataset.ref)}"]`); return; }
    const markEl = tgt?.closest?.('.cap-markchip') as HTMLElement | null;
    if (markEl?.dataset.mark) {
      setSeg('hmp');
      const pg = hmpPageOfMark.get(markEl.dataset.mark); // 目标卡可能在收起的旧页组里 → 先展开补填
      if (pg != null) openHmpGroup(pg);
      flashTarget(`#hmp-inner .hmp-card[data-mark="${CSS.escape(markEl.dataset.mark)}"]`);
    }
  });

  // 键 m：折叠/展开侧栏（输入框内不触发）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'm' && !(e.target as HTMLElement)?.isContentEditable
      && !['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName ?? '')) {
      setCollapsed(!document.body.classList.contains('rail-collapsed'));
    }
  });

  // 账本新落一轮（aiturn:appended 在 appendAiTurnEntry 之后发，保证读到最新）/ 新推理 → 会话页开着就刷新
  const live = () => { if (activePage === 'chat') void renderConversation(); };
  bus.on('aiturn:appended', live);
  bus.on('inspect', live);
  // 新 HMP 取证 / 翻页换页对象表 → 采集取证页开着就刷新两段（surface:indexed 让命中解析/互跳在切到该页后补上）
  const liveHmp = () => { if (activePage === 'hmp') void renderCaptureContent(); };
  bus.on('hmp:updated', liveHmp);
  bus.on('surface:indexed', liveHmp);
  // 设置页「诊断」读数实时刷新（迁自旧 #dev：延迟指标 / 坐标自测 / 预处理进度）
  const liveDiag = () => { if (activePage === 'settings') fillDiag(); };
  bus.on('metrics', liveDiag);
  bus.on('page:rendered', liveDiag);
  bus.on('preprocess:progress', (i, n) => { const el = document.getElementById('cset-pp'); if (el) el.textContent = `预处理中 ${i as number}/${n as number} 页…`; });
  bus.on('preprocess:done', () => { const el = document.getElementById('cset-pp'); if (el) el.textContent = '预处理完成'; });
  // 切书后默认跟随当前书
  bus.on('document:loaded', () => {
    selectedBook = state.documentId ?? selectedBook;
    if (activePage === 'chat') { void fillBookSelect(); void renderConversation(); }
    if (activePage === 'hmp') { void fillBookSelect('cap-book-sel').then(() => renderCaptureContent()); }
    if (activePage === 'meeting') rerenderMeeting();
  });

  window.addEventListener('hashchange', syncFromHash);
  syncFromHash();
}
