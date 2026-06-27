/**
 * 移动版（电纸屏）dev 三页 controller —— 复用 web 同一批 store/state 真数据，换 mobile.html 黑白 markup。
 * 不 import 桌面 dev/console.ts（绑 #app-pages 导航壳）。三页：AI 会话 / 采集取证 / 设置。
 *   · AI 会话：getBookAiTurns + getFoldedMarks，按页分组渲 turn。
 *   · 采集取证：getFoldedMarks(hmp 过滤) + state.surfaceIndex → HMP 卡 / 对象表。
 *   · 设置：每控件真绑 settings.*（change→settings:changed/saveSettings）；恢复默认=resetSettings()+reload。
 */
import { state, settings, bus, saveSettings, resetSettings } from '../app/state';
import { listBooks, getBookAiTurns, getFoldedMarks } from '../local/store';
import { esc } from '../core/escape';
import { selfTest } from '../core/transform';
import { traceCount, downloadTrace } from '../core/trace';
import type { PersistedAiTurn, PersistedMark } from '../core/store-format';
import type { SurfaceObject } from '../core/contracts';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let devBook: string | null = null;
let captureSeg: 'hmp' | 'obj' = 'hmp';

const TRIGGER_CN: Record<string, string> = { idle: '长停顿综合', handwriting: '手写定向', discussion: '段落讨论' };
const HMP_MODE: Record<string, [string, boolean]> = { anchored: ['锚定原文', true], self_content: ['自身内容', false], mixed: ['混合', false], unknown: ['未命中', false] };
const HMP_ACTION: Record<string, string> = { enclosure: '圈', underline: '划线', cross: '叉', arrow: '箭头', handwriting: '手写', sketch: '草图', highlight: '高亮', unknown: '未知' };
const fmtTime = (iso: string): string => { try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return ''; } };

/** 书目选择器（chat / capture 共用）。 */
function bookSel(id: string, books: Array<{ document_id: string; filename: string }>): string {
  if (!books.length) return `<select class="sctl" id="${id}" style="max-width:160px" disabled><option>（无书）</option></select>`;
  const opts = books.map((b) => `<option value="${esc(b.document_id)}"${b.document_id === devBook ? ' selected' : ''}>${esc(b.filename || '(未命名)')}</option>`).join('');
  return `<select class="sctl" id="${id}" style="max-width:160px">${opts}</select>`;
}
function bindBookSel(id: string, rerender: () => void): void {
  el<HTMLSelectElement>(id)?.addEventListener('change', (e) => { devBook = (e.target as HTMLSelectElement).value; rerender(); });
}

// ════ AI 会话 ════
export async function renderChat(): Promise<void> {
  const books = await listBooks();
  if (!devBook) devBook = state.documentId || books[0]?.document_id || null; // 默认当前书 / 第一本
  let body: string;
  if (!devBook) body = `<p class="dnote">选一本书（或先在「阅读」里打开一本）查看它的 AI 会话记录。</p>`;
  else {
    const [turns, marks] = await Promise.all([getBookAiTurns(devBook), getFoldedMarks(devBook)]);
    const markMap = new Map(marks.map((m) => [m.mark_id, m]));
    const live = turns.filter((t) => t.overlay_state !== 'dismissed');
    if (!live.length) body = `<p class="dnote">这本书还没有 AI 会话。圈划 + 手写问题，长停顿/手写定向会触发回复。</p>`;
    else {
      const byPage = new Map<number, PersistedAiTurn[]>();
      for (const t of live) { const p = t.page_index ?? 0; if (!byPage.has(p)) byPage.set(p, []); byPage.get(p)!.push(t); }
      const pages = [...byPage.entries()].sort((a, b) => Math.max(...b[1].map((t) => t.seq)) - Math.max(...a[1].map((t) => t.seq)));
      body = pages.map(([pi, ts], gi) => {
        const rows = ts.slice().sort((a, b) => b.seq - a.seq).map((t) => turnBlock(t, markMap)).join('');
        return `<details class="grp"${gi === 0 ? ' open' : ''}><summary><span class="gc">第 ${pi + 1} 页</span><span class="gm">${ts.length} 轮 · ${fmtTime(ts[ts.length - 1].created_at)}</span></summary><div class="gbody">${rows}</div></details>`;
      }).join('');
    }
  }
  el('dv-chat').innerHTML =
    `<div class="dhead"><h1>AI 会话</h1><span class="sp"></span>${bookSel('dv-bk-chat', books)}</div><div class="dbody">${body}</div>`;
  bindBookSel('dv-bk-chat', () => void renderChat());
}
function turnBlock(t: PersistedAiTurn, markMap: Map<string, PersistedMark>): string {
  const trg = TRIGGER_CN[t.trigger] || t.trigger;
  const trgCls = t.trigger === 'handwriting' ? 'trg hw' : 'trg';
  const userText = t.inference_view?.question || t.inference_view?.marked
    || t.anchor?.mark_ids.map((id) => markMap.get(id)?.marked_text).filter(Boolean).join(' ') || '（标注）';
  const folded = !t.ai_reply && t.diag?.classify && t.diag.classify.respond === false;
  const result = folded
    ? `<div class="turn folded">🚫 折叠为「写给自己的笔记」——这处手写没有指向性、不触发回复，留作下次综合。</div>`
    : `<div class="abub">${esc(t.ai_reply || '（无回复）')}`
      + (t.thinking ? `<details class="think"><summary>思考过程</summary><div>${esc(t.thinking)}</div></details>` : '')
      + `<div class="ameta">${esc(t.model || '')}${t.supersedes ? ' · 改写' : ''}</div></div>`;
  return `<div class="turn"><div class="tlab">发送给 AI 的内容 · 第 ${t.page_index + 1} 页 <span class="${trgCls}">${trg}</span><span class="tt">${fmtTime(t.created_at)}</span></div>`
    + (folded ? '' : `<div class="ucard">${esc(userText)}</div>`) + result + (folded ? result : '') + `</div>`;
}

// ════ 采集取证 ════
export async function renderCapture(): Promise<void> {
  const books = await listBooks();
  if (!devBook) devBook = state.documentId || books[0]?.document_id || null; // 默认当前书 / 第一本
  const seg = `<div class="seg"><button class="${captureSeg === 'hmp' ? 'on' : ''}" data-seg="hmp">HMP 取证</button><button class="${captureSeg === 'obj' ? 'on' : ''}" data-seg="obj">对象</button></div>`;
  let inner: string;
  if (!devBook) inner = `<p class="dnote">选一本书查看它的逐笔 HMP 取证 + SurfaceIndex 对象表。</p>`;
  else if (captureSeg === 'hmp') {
    const marks = (await getFoldedMarks(devBook)).filter((m) => m.hmp).sort((a, b) => b.seq - a.seq);
    inner = `<p class="dnote">逐笔 HMP 取证 —— 最新在上。共 ${marks.length} 笔。</p>` + (marks.map(hmpCard).join('') || `<p class="dnote">这本书还没有带取证的标注。</p>`);
  } else {
    inner = objTable();
  }
  el('dv-hmp').innerHTML =
    `<div class="dhead"><h1>采集取证</h1>${seg}<span class="sp"></span>${bookSel('dv-bk-hmp', books)}</div><div class="dbody">${inner}</div>`;
  el('dv-hmp').querySelectorAll<HTMLElement>('.seg [data-seg]').forEach((b) => b.addEventListener('click', () => { captureSeg = b.dataset.seg as 'hmp' | 'obj'; void renderCapture(); }));
  bindBookSel('dv-bk-hmp', () => void renderCapture());
}
function hmpCard(m: PersistedMark): string {
  const h = m.hmp!;
  const [modeLabel, anchor] = HMP_MODE[h.mode] || ['未知', false];
  const region = `[${h.target_region.map((n) => n.toFixed(2)).join(', ')}]`;
  const refs = h.target_object_refs.length ? h.target_object_refs.join(', ') : (h.mode === 'self_content' ? '空（自身内容）' : '空');
  return `<div class="hcard"><div class="hch"><span class="mode${anchor ? ' anchor' : ''}">${esc(modeLabel)}</span>`
    + `<span class="act">${esc(HMP_ACTION[h.action] || h.action)}</span><span class="feat">${esc(m.feature_type)}</span>`
    + `<span class="hm">${esc(h.object_hint)} · ${h.confidence.toFixed(2)} · ${esc(h.version)} · 第${m.page_index + 1}页</span></div>`
    + `<div class="hcb"><div class="himg">合成图</div><div class="hf">`
    + `<div><b>所标内容</b>${esc(m.marked_text || '—')}</div>`
    + `<div><b>命中对象</b>${esc(refs)}</div>`
    + `<div><b>读出</b>${esc(h.text_hint || '—')}</div>`
    + `<div><b>区域</b>${esc(region)}</div></div></div></div>`;
}
function objTable(): string {
  const si = state.surfaceIndex;
  if (!si || !si.objects.length) return `<p class="dnote">当前没有 SurfaceIndex（打开一本书 / 一页后这里列出本页对象）。</p>`;
  const hitSet = new Set<string>();
  for (const m of state.lastHmps) for (const r of m.target_object_refs) hitSet.add(r);
  const types = new Map<string, number>();
  for (const o of si.objects) types.set(o.type, (types.get(o.type) ?? 0) + 1);
  const dist = [...types.entries()].map(([t, n]) => `${t} ${n}`).join(' · ');
  const rows = si.objects.slice(0, 150).map((o: SurfaceObject) =>
    `<tr><td>${esc(o.id)}</td><td>${esc(o.type)}</td><td>${o.bbox[0].toFixed(2)},${o.bbox[1].toFixed(2)}</td><td>${esc((o.text || '—').slice(0, 24))}</td><td>${hitSet.has(o.id) ? '<span class="mc">命中</span>' : ''}</td></tr>`
  ).join('');
  return `<p class="dnote">本页 SurfaceIndex · surface=${esc(si.surface_type)} · 共 ${si.objects.length} 个 · ${esc(dist)}</p>`
    + `<table class="otbl"><thead><tr><th>id</th><th>type</th><th>bbox</th><th>text</th><th>命中</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ════ 设置（每控件真绑 settings.*）════
type SBadge = 'eff' | 'dev' | 'weak';
interface SCtl {
  label: string; desc?: string; badge: SBadge; effect: 'changed' | 'save';
  type: 'select' | 'check' | 'number';
  opts?: Array<[string, string]>; min?: number; max?: number;
  get: () => string | number | boolean;
  set: (raw: string, checked: boolean) => void;
}
const MODELS_INFER: Array<[string, string]> = [['kimi-k2.6', 'kimi-k2.6'], ['claude-opus-4-8', 'claude-opus-4-8'], ['claude-sonnet-4-6', 'claude-sonnet-4-6'], ['gemini-3.5-flash', 'gemini-3.5-flash'], ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite']];
const MODELS_INHERIT = (extra: Array<[string, string]>): Array<[string, string]> => [['', '继承推理模型'], ...extra, ...MODELS_INFER];

const CORE: SCtl[] = [
  { label: '推理模型', desc: '答问 · 分类器默认', badge: 'eff', effect: 'changed', type: 'select', opts: MODELS_INFER, get: () => settings.inferModel, set: (v) => { settings.inferModel = v; } },
  { label: '识别分类器模型', desc: '/api/interpret', badge: 'eff', effect: 'changed', type: 'select', opts: MODELS_INHERIT([['__local_hwr__', '端侧手写 HWR']]), get: () => settings.interpretModel, set: (v) => { settings.interpretModel = v; } },
  { label: '上下文分类器模型', desc: '/api/classify-context', badge: 'eff', effect: 'changed', type: 'select', opts: MODELS_INHERIT([['__local_rules__', '端侧规则·徐']]), get: () => settings.classifyModel, set: (v) => { settings.classifyModel = v; } },
  { label: '送合成图给模型', badge: 'eff', effect: 'changed', type: 'check', get: () => settings.sendMarkImage, set: (_v, c) => { settings.sendMarkImage = c; } },
  { label: '输出落点', badge: 'eff', effect: 'changed', type: 'select', opts: [['margin', '右侧留白'], ['inline', '贴正文浮动']], get: () => settings.placement, set: (v) => { settings.placement = v as typeof settings.placement; } },
  { label: '手势响应（总开关）', badge: 'eff', effect: 'changed', type: 'check', get: () => settings.gesture.enabled, set: (_v, c) => { settings.gesture.enabled = c; } },
  { label: '长停顿综合阈值', desc: '10–600 秒', badge: 'eff', effect: 'changed', type: 'number', min: 10, max: 600, get: () => settings.gesture.idleSeconds ?? 90, set: (v) => { settings.gesture.idleSeconds = Math.min(600, Math.max(10, parseInt(v, 10) || 90)); } },
  { label: '重排引擎', badge: 'eff', effect: 'changed', type: 'select', opts: [['ai', 'AI 结构重建'], ['hybrid', '启发式+模型精修'], ['local', '仅启发式'], ['vision', '启发式+视觉重排'], ['rewrite', 'VLM 看图重写']], get: () => settings.reflowProvider, set: (v) => { settings.reflowProvider = v; } },
  { label: '重排模型', badge: 'eff', effect: 'changed', type: 'select', opts: [['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite'], ['gemini-3.5-flash', 'gemini-3.5-flash'], ['kimi-k2.6', 'kimi-k2.6'], ['claude-sonnet-4-6', 'claude-sonnet-4-6']], get: () => settings.reflowModel, set: (v) => { settings.reflowModel = v; } },
  { label: '重排前置（渲染即急算）', badge: 'eff', effect: 'save', type: 'check', get: () => settings.reflowEager, set: (_v, c) => { settings.reflowEager = c; } },
  { label: '基岩录制（原始笔迹流·影子）', badge: 'eff', effect: 'save', type: 'check', get: () => settings.bedrock, set: (_v, c) => { settings.bedrock = c; } },
];
const DEBUG: SCtl[] = [
  { label: '显示 bbox 叠层', desc: '对象框 + 命中高亮 + HMP 浮窗', badge: 'dev', effect: 'changed', type: 'check', get: () => settings.devOverlay, set: (_v, c) => { settings.devOverlay = c; } },
  { label: '显示组装区域', desc: '手写实时框', badge: 'dev', effect: 'changed', type: 'check', get: () => settings.showRegion, set: (_v, c) => { settings.showRegion = c; } },
  { label: '显示关联框', desc: '综合后虚框', badge: 'dev', effect: 'changed', type: 'check', get: () => settings.showRelations, set: (_v, c) => { settings.showRelations = c; } },
];
const WEAK: SCtl[] = [
  { label: '预排版前 N 页', desc: '仅下次导入生效', badge: 'weak', effect: 'save', type: 'check', get: () => settings.preprocess.reflowEnabled, set: (_v, c) => { settings.preprocess.reflowEnabled = c; } },
  { label: '预排版页数', badge: 'weak', effect: 'save', type: 'number', min: 0, max: 100, get: () => settings.preprocess.reflowPages, set: (v) => { settings.preprocess.reflowPages = Math.min(100, Math.max(0, parseInt(v, 10) || 0)); } },
];

const LINES_KEY = 'inkloop.mobile.lines';
let ctlReg: SCtl[] = []; // 当前渲染的控件（按 data-si 索引绑定）

function ctlHtml(c: SCtl, i: number): string {
  const badge = c.badge === 'eff' ? '<span class="sbadge eff">生效</span>' : c.badge === 'dev' ? '<span class="sbadge">调试</span>' : '<span class="sbadge weak">弱效</span>';
  const head = `<div class="sl"><div class="sn">${esc(c.label)} ${badge}</div>${c.desc ? `<div class="sd">${esc(c.desc)}</div>` : ''}</div>`;
  let ctl = '';
  if (c.type === 'select') ctl = `<select class="sctl" data-si="${i}">${c.opts!.map(([v, l]) => `<option value="${esc(v)}"${String(c.get()) === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  else if (c.type === 'check') ctl = `<input type="checkbox" class="sck" data-si="${i}"${c.get() ? ' checked' : ''}>`;
  else ctl = `<input type="number" class="sctl" data-si="${i}" value="${c.get()}" min="${c.min}" max="${c.max}">`;
  return `<div class="srow">${head}${ctl}</div>`;
}
export function renderSettings(): void {
  ctlReg = [...CORE, ...DEBUG, ...WEAK];
  const off0 = 0, off1 = CORE.length, off2 = CORE.length + DEBUG.length;
  const linesOn = localStorage.getItem(LINES_KEY) !== 'off';
  const body =
    `<div class="sgrp-h">界面</div>`
    + `<div class="srow"><div class="sl"><div class="sn">日记稿纸线 <span class="sbadge eff">生效</span></div><div class="sd">空白页横线</div></div><input type="checkbox" class="sck" id="set-lines"${linesOn ? ' checked' : ''}></div>`
    + `<div class="sgrp-h">核心 · 影响真实行为</div>` + CORE.map((c, i) => ctlHtml(c, off0 + i)).join('')
    + `<div class="sgrp-h">调试叠层</div>` + DEBUG.map((c, i) => ctlHtml(c, off1 + i)).join('')
    + `<details class="sfold"><summary>历史 / 弱效</summary>` + WEAK.map((c, i) => ctlHtml(c, off2 + i)).join('') + `</details>`
    + `<details class="sfold"><summary>诊断</summary><div class="diag">`
    + diagHtml() + `</div></details>`;
  el('dv-set').innerHTML = `<div class="dhead"><h1>设置</h1><span class="sp"></span><button class="hbtn" id="reset-btn">恢复默认设置</button></div><div class="dbody">${body}</div>`;
  // 绑控件
  el('dv-set').querySelectorAll<HTMLElement>('[data-si]').forEach((node) => {
    const c = ctlReg[parseInt(node.dataset.si!, 10)];
    node.addEventListener('change', () => {
      const inp = node as HTMLInputElement | HTMLSelectElement;
      c.set(inp.value, (inp as HTMLInputElement).checked);
      if (c.effect === 'changed') bus.emit('settings:changed');
      saveSettings();
    });
  });
  // 界面·线格（mobile localStorage + body.lines-off）
  el<HTMLInputElement>('set-lines')?.addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    document.body.classList.toggle('lines-off', !on);
    localStorage.setItem(LINES_KEY, on ? 'on' : 'off');
  });
  // 恢复默认：二次确认 → resetSettings + reload
  const r = el<HTMLButtonElement>('reset-btn'); let armed = false;
  r.addEventListener('click', () => {
    if (!armed) { armed = true; r.textContent = '再点一次确认（清存档·重载）'; r.style.borderColor = '#111'; return; }
    resetSettings(); localStorage.removeItem(LINES_KEY); location.reload();
  });
}
function diagHtml(): string {
  const st = selfTest();
  const coord = st.samples ? `${st.ok ? '✓' : '✗'} ${st.samples} 点 · maxErr ${st.maxErr.toFixed(2)}` : '— 未打开页面';
  return `<div class="dl"><b>坐标自测</b><span>${coord} · zoom ${Math.round(state.zoom * 100)}%</span></div>`
    + `<div class="dl"><b>Trace</b><span>本会话 ${traceCount()} 条 · <a id="dv-trace-dl">下载 JSONL</a></span></div>`;
}

/** 入口：mobile-main boot 调一次。绑 dev 子导航 → 渲染对应页；监听账本/索引 bus 刷新当前页。 */
export function initMobileDev(): void {
  const active = (): string => document.body.dataset.dev || 'chat';
  const renderActive = (): void => {
    if (active() === 'chat') void renderChat();
    else if (active() === 'hmp') void renderCapture();
    else renderSettings();
  };
  document.querySelectorAll<HTMLElement>('#dev-sub [data-dev]').forEach((b) => b.addEventListener('click', () => {
    const d = b.dataset.dev;
    if (d === 'chat') void renderChat();
    else if (d === 'hmp') void renderCapture();
    else if (d === 'set') renderSettings();
  }));
  // 进 dev 面（rail）→ 渲染当前子页
  document.querySelector('.nav [data-mode="dev"]')?.addEventListener('click', () => renderActive());
  // Trace 下载（事件委托：设置页诊断里的链接）
  document.getElementById('surf-dev')?.addEventListener('click', (e) => { if ((e.target as HTMLElement).id === 'dv-trace-dl') downloadTrace(); });
  // 账本/索引变化 → 刷新当前 dev 页（仅 dev 面激活时）
  const live = (): void => { if (document.body.dataset.mode === 'dev') renderActive(); };
  bus.on('aiturn:appended', live);
  bus.on('hmp:updated', live);
  bus.on('surface:indexed', live);
}
