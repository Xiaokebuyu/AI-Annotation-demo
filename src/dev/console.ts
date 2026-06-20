/**
 * 控制台菜单页（新调试中枢 · hash 路由 #menu）。
 *
 * 形态参照桌面端侧栏：左侧导航 + 主内容区。第一个入口「AI 会话」完整实现——
 *   · 实时 buffer：bookMessages() 这本书模型当下记得的对话（滑动窗 ≤24），即"它的存在"。
 *   · 账本时间线：getBookAiTurns() append-only 全字段取证（触发/prompt/inference-view/回复/锚点/模型/状态/supersedes）。
 * 其余入口（上下文监控 / HMP / 对象 / 设置）先占位标"迁移中"，逐步把旧 dev 页(#dev)的能力搬过来后退役它。
 *
 * 自包含：DOM 与样式都由本模块生成、append 到 body，不依赖 index.html；隐藏=移除 .console-open。
 */
import { bus, state } from '../app/state';
import { bookMessages, resetBook, type ChatMsg } from '../chat/buffer';
import { listBooks, getBookAiTurns } from '../local/store';
import type { PersistedAiTurn } from '../core/store-format';

const esc = (s: string): string => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));

type View = 'chat' | 'inspect' | 'hmp' | 'objects' | 'settings';
const VIEWS: Array<{ id: View; icon: string; label: string; ready: boolean }> = [
  { id: 'chat', icon: '💬', label: 'AI 会话', ready: true },
  { id: 'inspect', icon: '📡', label: '上下文监控', ready: false },
  { id: 'hmp', icon: '🔖', label: '标注取证 HMP', ready: false },
  { id: 'objects', icon: '▦', label: 'SurfaceIndex 对象', ready: false },
  { id: 'settings', icon: '⚙', label: '设置', ready: false },
];

let page: HTMLDivElement | null = null;
let currentView: View = 'chat';
let selectedBook: string | null = null;

const fmtTime = (iso: string): string => {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return iso; }
};
const TRIGGER_CN: Record<string, { t: string; c: string }> = {
  idle: { t: '长停顿综合', c: '#3b82f6' },
  handwriting: { t: '手写定向', c: '#22c55e' },
  discussion: { t: '段落讨论', c: '#8a877f' },
};

function injectStyle(): void {
  if (document.getElementById('cns-style')) return;
  const s = document.createElement('style');
  s.id = 'cns-style';
  s.textContent = `
  #console-page { display: none; position: fixed; inset: 0; z-index: 60; background: var(--paper); color: var(--ink); font-family: var(--sans); }
  #console-page.console-open { display: flex; }
  .cns-nav { width: 248px; flex: 0 0 248px; border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 14px 10px; gap: 4px; background: var(--page); }
  .cns-brand { font-weight: 600; font-size: 15px; padding: 6px 10px 12px; display: flex; align-items: center; gap: 8px; }
  .cns-menu { display: flex; flex-direction: column; gap: 2px; }
  .cns-item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 9px 10px; border: 0; border-radius: 9px; background: transparent; color: var(--ink); font-size: 13.5px; cursor: pointer; font-family: var(--sans); }
  .cns-item:hover { background: var(--hl); }
  .cns-item.active { background: var(--ink); color: var(--page); }
  .cns-item .cns-soon { margin-left: auto; font-size: 10px; color: var(--hint); }
  .cns-item.active .cns-soon { color: var(--hl); }
  .cns-sec-label { font-size: 11px; color: var(--hint); padding: 14px 10px 4px; letter-spacing: .04em; }
  .cns-books { flex: 1; overflow-y: auto; min-height: 0; }
  .cns-book { padding: 7px 10px; border-radius: 8px; font-size: 12.5px; color: var(--mut); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cns-book:hover { background: var(--hl); }
  .cns-book.active { background: var(--hl); color: var(--ink); font-weight: 600; }
  .cns-foot { border-top: 1px solid var(--line); padding-top: 8px; }
  .cns-main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
  .cns-head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 14px 20px; border-bottom: 1px solid var(--line); }
  .cns-head h2 { margin: 0; font-size: 16px; font-weight: 600; white-space: nowrap; }
  .cns-head-ctl { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cns-head-ctl select, .cns-btn { font-family: var(--sans); font-size: 12.5px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--page); color: var(--ink); cursor: pointer; max-width: 240px; white-space: nowrap; flex-shrink: 0; }
  .cns-btn:hover { background: var(--hl); }
  .cns-content { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
  .cns-chat-grid { flex: 1; display: grid; grid-template-columns: 1fr 1.3fr; min-height: 0; }
  .cns-pane { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); }
  .cns-pane:last-child { border-right: 0; }
  .cns-pane-head { padding: 10px 18px; font-size: 12.5px; font-weight: 600; color: var(--mut); border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 8px; }
  .cns-badge { font-weight: 400; font-size: 11px; color: var(--hint); background: var(--hl); padding: 2px 7px; border-radius: 20px; }
  .cns-scroll { flex: 1; overflow-y: auto; padding: 14px 18px; min-height: 0; }
  .cns-empty { color: var(--hint); font-size: 13px; text-align: center; padding: 40px 16px; }
  .cns-bubble { margin-bottom: 12px; }
  .cns-role { font-size: 11px; color: var(--hint); margin-bottom: 3px; display: block; }
  .cns-msg { font-size: 13px; line-height: 1.6; padding: 9px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
  .cns-u .cns-msg { background: var(--hl); color: var(--ink); }
  .cns-a .cns-msg { background: var(--ai-bg); color: var(--ink); border: 1px solid var(--ai-line); }
  .cns-card { border: 1px solid var(--line); border-radius: 11px; margin-bottom: 12px; overflow: hidden; background: var(--page); }
  .cns-card-head { display: flex; align-items: center; gap: 8px; padding: 9px 13px; cursor: pointer; }
  .cns-card-head:hover { background: var(--hl); }
  .cns-trig { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 20px; color: #fff; }
  .cns-seq { font-size: 11px; color: var(--hint); }
  .cns-card-reply { flex: 1; font-size: 12.5px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cns-card-meta { font-size: 11px; color: var(--hint); white-space: nowrap; }
  .cns-card-body { padding: 4px 13px 13px; display: grid; grid-template-columns: 76px 1fr; gap: 7px 12px; font-size: 12px; border-top: 1px dashed var(--line); }
  .cns-k { color: var(--hint); }
  .cns-v { color: var(--ink); white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
  .cns-v.reply { background: var(--ai-bg); border-radius: 7px; padding: 6px 9px; }
  .cns-state { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 5px; background: var(--hl); color: var(--mut); }
  .cns-placeholder { margin: auto; text-align: center; color: var(--hint); }
  .cns-placeholder .cns-btn { margin-top: 14px; }
  `;
  document.head.appendChild(s);
}

function buildPage(): void {
  if (page) return;
  injectStyle();
  page = document.createElement('div');
  page.id = 'console-page';
  page.innerHTML =
    `<aside class="cns-nav">`
    + `<div class="cns-brand">◐ InkLoop 控制台</div>`
    + `<nav class="cns-menu">`
    + VIEWS.map((v) => `<button class="cns-item" data-view="${v.id}">${v.icon}<span>${esc(v.label)}</span>${v.ready ? '' : '<span class="cns-soon">迁移中</span>'}</button>`).join('')
    + `</nav>`
    + `<div class="cns-sec-label">书架</div>`
    + `<div class="cns-books" id="cns-book-list"></div>`
    + `<div class="cns-foot"><button class="cns-item" id="cns-exit">←<span>返回阅读</span></button></div>`
    + `</aside>`
    + `<main class="cns-main"><div class="cns-content" id="cns-content"></div></main>`;
  document.body.appendChild(page);

  page.querySelectorAll<HTMLButtonElement>('.cns-menu .cns-item').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view as View));
  });
  page.querySelector('#cns-exit')!.addEventListener('click', () => openConsole(false));
}

function setView(v: View): void {
  currentView = v;
  page?.querySelectorAll<HTMLButtonElement>('.cns-menu .cns-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  renderContent();
}

function renderContent(): void {
  const c = page?.querySelector<HTMLDivElement>('#cns-content');
  if (!c) return;
  if (currentView === 'chat') { renderChat(c); return; }
  const label = VIEWS.find((v) => v.id === currentView)?.label ?? '';
  c.innerHTML = `<div class="cns-placeholder"><div style="font-size:15px">「${esc(label)}」迁移中</div>`
    + `<div style="font-size:12.5px;margin-top:6px">这块能力暂时还在旧 dev 页，稍后搬进控制台。</div>`
    + `<button class="cns-btn" id="cns-open-dev">打开旧 dev 页（d）</button></div>`;
  c.querySelector('#cns-open-dev')?.addEventListener('click', () => { location.hash = 'dev'; });
}

/* ── AI 会话视图 ─────────────────────────────────────────────────────────── */

function renderChat(c: HTMLDivElement): void {
  if (!selectedBook) selectedBook = state.documentId ?? null;
  c.innerHTML =
    `<div class="cns-head"><h2>💬 AI 会话</h2><div class="cns-head-ctl">`
    + `<select id="cns-book-sel"></select>`
    + `<button class="cns-btn" id="cns-refresh">⟳ 刷新</button>`
    + `<button class="cns-btn" id="cns-clear">🗑 清空 buffer</button>`
    + `</div></div>`
    + `<div class="cns-chat-grid">`
    + `<section class="cns-pane"><div class="cns-pane-head">实时 buffer <span class="cns-badge" id="cns-buf-badge">—</span></div><div class="cns-scroll" id="cns-buffer"></div></section>`
    + `<section class="cns-pane"><div class="cns-pane-head">账本时间线 <span class="cns-badge" id="cns-led-badge">—</span></div><div class="cns-scroll" id="cns-ledger"></div></section>`
    + `</div>`;

  void fillBookSelect();
  const sel = c.querySelector<HTMLSelectElement>('#cns-book-sel');
  sel?.addEventListener('change', () => { selectedBook = sel.value; renderBuffer(); void renderLedger(); });
  c.querySelector('#cns-refresh')?.addEventListener('click', () => { renderBuffer(); void renderLedger(); void renderBookList(); });
  c.querySelector('#cns-clear')?.addEventListener('click', () => {
    if (selectedBook) { resetBook(selectedBook); renderBuffer(); }
  });

  renderBuffer();
  void renderLedger();
  void renderBookList();
}

async function fillBookSelect(): Promise<void> {
  const sel = page?.querySelector<HTMLSelectElement>('#cns-book-sel');
  if (!sel) return;
  const books = (await listBooks()).map((b) => ({ id: b.document_id, name: b.filename }));
  const opts = books.length ? books : (selectedBook ? [{ id: selectedBook, name: '(当前书)' }] : []);
  sel.innerHTML = opts.map((b) => `<option value="${esc(b.id)}"${b.id === selectedBook ? ' selected' : ''}>${esc(b.name || b.id)}</option>`).join('')
    || '<option value="">（暂无书籍）</option>';
  if (!selectedBook && opts[0]) selectedBook = opts[0].id;
}

function renderBuffer(): void {
  const box = page?.querySelector<HTMLDivElement>('#cns-buffer');
  const badge = page?.querySelector<HTMLSpanElement>('#cns-buf-badge');
  if (!box) return;
  const msgs: ChatMsg[] = selectedBook ? bookMessages(selectedBook) : [];
  if (badge) badge.textContent = `${msgs.length} 轮 · 滑动窗 ≤24`;
  if (!msgs.length) { box.innerHTML = `<p class="cns-empty">这本书还没有对话。圈/划/写一处、停笔，对话会在这里出现。</p>`; return; }
  box.innerHTML = msgs.map((m) =>
    `<div class="cns-bubble ${m.role === 'user' ? 'cns-u' : 'cns-a'}"><span class="cns-role">${m.role === 'user' ? '读者（喂模型的轮）' : 'AI'}</span><div class="cns-msg">${esc(m.content)}</div></div>`
  ).join('');
  box.scrollTop = box.scrollHeight;
}

async function renderLedger(): Promise<void> {
  const box = page?.querySelector<HTMLDivElement>('#cns-ledger');
  const badge = page?.querySelector<HTMLSpanElement>('#cns-led-badge');
  if (!box) return;
  const turns: PersistedAiTurn[] = selectedBook ? await getBookAiTurns(selectedBook) : [];
  if (badge) badge.textContent = `${turns.length} 轮 · append-only`;
  if (!turns.length) { box.innerHTML = `<p class="cns-empty">账本里还没有 AI 轮次。</p>`; return; }
  const CAP = 60;
  const shown = turns.slice(-CAP).reverse(); // 新→旧
  box.innerHTML = shown.map((t, i) => ledgerCard(t, turns.length - i)).join('')
    + (turns.length > CAP ? `<p class="cns-empty">…共 ${turns.length} 轮，仅显示最近 ${CAP}</p>` : '');
  box.querySelectorAll<HTMLDivElement>('.cns-card-head').forEach((h) => {
    h.addEventListener('click', () => { const b = h.nextElementSibling as HTMLElement | null; if (b) b.hidden = !b.hidden; });
  });
}

function ledgerCard(t: PersistedAiTurn, idx: number): string {
  const trig = TRIGGER_CN[t.trigger] ?? { t: t.trigger, c: '#8a877f' };
  const v = t.inference_view;
  const anchor = t.anchor;
  const ctxLen = v?.page_context ? v.page_context.length : 0;
  const state_ = t.overlay_state;
  return `<div class="cns-card">`
    + `<div class="cns-card-head">`
    + `<span class="cns-trig" style="background:${trig.c}">${esc(trig.t)}</span>`
    + `<span class="cns-seq">#${idx} · 第${(t.page_index ?? 0) + 1}页 · ${fmtTime(t.created_at)}</span>`
    + `<span class="cns-card-reply">${esc(t.ai_reply || '（空）')}</span>`
    + `<span class="cns-card-meta">${esc(t.model || '')}${t.supersedes ? ' · 改写' : ''}</span>`
    + `</div>`
    + `<div class="cns-card-body">`
    + row('prompt', t.prompt_snapshot)
    + row('narrative', v?.narrative)
    + row('所标 marked', v?.marked)
    + (v?.question ? row('手写问', v.question) : '')
    + row('上下文', `滑动窗 ${ctxLen} 字${v?.crop ? ' · 含图' : ''}`)
    + `<div class="cns-k">回复</div><div class="cns-v reply">${esc(t.ai_reply || '—')}</div>`
    + row('锚点', `${esc(anchor?.surface_id || '—')} · ${anchor?.mark_ids?.length ?? 0} 笔 · ${anchor?.object_refs?.length ?? 0} 对象`)
    + row('状态', `<span class="cns-state">${esc(state_)}</span>${t.user_edited_text ? ' 改：' + esc(t.user_edited_text) : ''}`)
    + row('元信息', `model=${esc(t.model)} · sys#${esc(t.system_prompt_hash || '—')} · ${esc(t.settings_snapshot?.inferModel || '')}`)
    + `</div></div>`;
}
function row(k: string, val?: string | null): string {
  return `<div class="cns-k">${esc(k)}</div><div class="cns-v">${esc(val || '—')}</div>`;
}

async function renderBookList(): Promise<void> {
  const box = page?.querySelector<HTMLDivElement>('#cns-book-list');
  if (!box) return;
  const books = await listBooks();
  if (!books.length) { box.innerHTML = `<p class="cns-empty" style="padding:14px 10px;text-align:left">书架空</p>`; return; }
  box.innerHTML = books.map((b) =>
    `<div class="cns-book${b.document_id === selectedBook ? ' active' : ''}" data-book="${esc(b.document_id)}" title="${esc(b.filename)}">${esc(b.filename || b.document_id)}</div>`
  ).join('');
  box.querySelectorAll<HTMLDivElement>('.cns-book').forEach((el) => el.addEventListener('click', () => {
    selectedBook = el.dataset.book ?? null;
    void fillBookSelect();
    renderBuffer(); void renderLedger(); void renderBookList();
  }));
}

/* ── 路由 / 入口 ─────────────────────────────────────────────────────────── */

export function openConsole(on?: boolean): void {
  const wantOn = on === undefined ? location.hash !== '#menu' : on;
  if (wantOn && location.hash !== '#menu') location.hash = 'menu';
  else if (!wantOn && location.hash === '#menu') history.replaceState(null, '', location.pathname + location.search);
  syncRoute();
}

function syncRoute(): void {
  if (!page) return;
  const on = location.hash === '#menu';
  page.classList.toggle('console-open', on);
  if (on) { if (!currentView) currentView = 'chat'; setView(currentView); }
}

export function initConsole(): void {
  buildPage();

  // 顶栏入口按钮（注入到现有控件区，紧邻 dev 按钮）
  const ctl = document.querySelector('.top-ctl');
  if (ctl && !document.getElementById('console-toggle')) {
    const btn = document.createElement('button');
    btn.id = 'console-toggle';
    btn.className = 'ghost';
    btn.title = '控制台（m）';
    btn.textContent = '控制台';
    ctl.insertBefore(btn, document.getElementById('dev-toggle'));
    btn.addEventListener('click', () => openConsole(true));
  }

  // 快捷键 m（输入框内不触发）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'm' && !(e.target as HTMLElement)?.isContentEditable
      && !['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName ?? '')) {
      openConsole();
    }
  });

  // 新一轮回复 / 新推理 → 若控制台开着且在 AI 会话视图，实时刷新
  const live = () => { if (page?.classList.contains('console-open') && currentView === 'chat') { renderBuffer(); void renderLedger(); } };
  bus.on('overlay:add', live);
  bus.on('inspect', live);

  window.addEventListener('hashchange', syncRoute);
  syncRoute();
}
