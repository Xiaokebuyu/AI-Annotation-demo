/**
 * 移动版（电纸屏）dev 三页 controller —— 复用 web 同一批 store/state 真数据，换 mobile.html 黑白 markup。
 * 不 import 桌面 dev/console.ts（绑 #app-pages 导航壳）。三页：AI 会话 / 采集取证 / 设置。
 *   · AI 会话：getBookAiTurns + getFoldedMarks，按页分组渲 turn。
 *   · 采集取证：getFoldedMarks(hmp 过滤) + state.surfaceIndex → HMP 卡 / 对象表。
 *   · 设置：每控件真绑 settings.*（change→settings:changed/saveSettings）；恢复默认=resetSettings()+reload。
 */
import { state, settings, bus, saveSettings, resetSettings } from '../app/state';
import { listInspectableDocs, type InspectableDoc, getBookAiTurns, getFoldedMarks, listAllMeetings, updateMeeting } from '../local/store';
import { esc } from '../core/escape';
import { setApiRoute, apiRouteChoice } from '../core/api';
import { selfTest } from '../core/transform';
import { traceCount, downloadTrace } from '../core/trace';
import { snapshot } from '../core/metrics';
import { pipelineSection, legacySection } from '../dev/pipeline-view'; // dev 流水线/旧轮渲染（与桌面 console.ts 共用·不引 console.css）
import type { PersistedAiTurn, PersistedMark } from '../core/store-format';
import type { HMP, SurfaceObject } from '../core/contracts';
import { createPager, mountPagerBar, type Pager, type PagerBar } from '../surface/virtual-pager';
import { pickOneSheet, infoSheet } from './sheet';
import { publishVaultFromDevice, type VaultPublishResult } from '../integration/inksurface/vault-publish-device';
import { readPanelSyncStatus } from './meeting-sync-status';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let devBook: string | null = null;
let captureSeg: 'hmp' | 'obj' = 'hmp';
let preprocessText = '未运行';
let openChat: string | null = null; // 抽屉式单开：当前展开的 turn entry_id（e-ink 零滑动·只渲展开项）
let openHmp: string | null = null;  // 同上·当前展开的 HMP 卡 key
let chatRenderSeq = 0;    // 代际守卫：异步 re-fetch 期间快速点表头/切书/bus 刷新交错 → 旧 render 晚返回会覆盖新 DOM（电纸屏延迟更高更易触发）
let captureRenderSeq = 0;

const TRIGGER_CN: Record<string, string> = { idle: '长停顿综合', handwriting: '手写定向', discussion: '段落讨论' };
const HMP_MODE: Record<string, [string, boolean]> = { anchored: ['锚定原文', true], self_content: ['自身内容', false], mixed: ['混合', false], unknown: ['未命中', false] };
const HMP_ACTION: Record<string, string> = { enclosure: '圈', underline: '划线', cross: '叉', arrow: '箭头', handwriting: '手写', sketch: '草图', highlight: '高亮', unknown: '未知' };
const HMP_FEAT: Record<string, string> = { markup: '标记', handwriting: '手写', drawing: '画' };

/** 取证行：持久 mark 的取证骨架 + 本会话 state.lastHmps 的 live crop/vector（落库已剥 crop_ref/vector_ref，唯 live 有图）。 */
interface HmpRow { key: string; hmp: HMP; marked: string; feature: string; page_index: number; page_id: string; seq: number; created_at: string; live: boolean; unsaved: boolean }
let pendingFlash: { seg: 'hmp' | 'obj'; selector: string } | null = null; // HMP↔对象互跳：切段后高亮目标

function featureFromAction(action: string): string {
  if (action === 'handwriting') return 'handwriting';
  if (action === 'sketch') return 'drawing';
  return 'markup';
}
function markChipLabel(feature: string, marked: string): string {
  const t = (marked || '').replace(/\s+/g, ' ').slice(0, 10);
  return `${HMP_FEAT[feature] ?? feature}${t ? `「${t}」` : ''}`;
}
/** page_id 形如 pg_{hash8}_{idx} → 取末段页号（与 annotation-loop.pageIdxOf 同约定）。 */
const pageIdxOfSurface = (surfaceId: string): number => { const m = surfaceId.match(/_(\d+)$/); return m ? Number(m[1]) : state.pageIndex; };
async function buildHmpRows(book: string): Promise<HmpRow[]> {
  const persisted = (await getFoldedMarks(book)).filter((m) => m.hmp);
  const liveHmps = book === state.documentId ? state.lastHmps : []; // live crop/vector 只属当前打开的书 → 看别本时不混入（避免 hmp_id 偶撞带错图/错页）
  const liveById = new Map(liveHmps.map((h) => [h.hmp_id, h]));
  const seen = new Set<string>();
  const rows: HmpRow[] = persisted.map((m) => {
    const live = liveById.get(m.hmp!.hmp_id);
    seen.add(m.hmp!.hmp_id);
    const hmp = live && (live.crop_ref || live.vector_ref) ? { ...m.hmp!, crop_ref: live.crop_ref, vector_ref: live.vector_ref } : m.hmp!; // 持久剥了图 → 本会话 live 补回
    return { key: m.mark_id, hmp, marked: m.marked_text, feature: m.feature_type, page_index: m.page_index, page_id: m.page_id, seq: m.seq, created_at: m.created_at, live: !!live, unsaved: false };
  });
  for (const h of liveHmps) { // 本会话还没落库的 HMP（取证图最全）
    if (seen.has(h.hmp_id)) continue;
    rows.push({ key: h.hmp_id, hmp: h, marked: h.text_hint || '', feature: featureFromAction(h.action), page_index: pageIdxOfSurface(h.surface_id), page_id: h.surface_id, seq: Number.MAX_SAFE_INTEGER, created_at: '', live: true, unsaved: true }); // 页号取自 surface_id·非当前 state.pageIndex（翻页后旧 live HMP 不再错挂当前页）
  }
  return rows.sort((a, b) => b.seq - a.seq);
}
const fmtTime = (iso: string): string => { try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return ''; } };
const compactText = (s?: string | null): string => (s ?? '').replace(/\s+/g, ' ').trim();
const clipText = (s?: string | null, max = 20): string => { const t = compactText(s); return t ? (t.length > max ? t.slice(0, max) : t) : '—'; };
/** 抽屉表头一行摘要：手写问 / 所标内容 / 首个 mark 文本，截断。 */
function turnSummary(t: PersistedAiTurn, markMap: Map<string, PersistedMark>): string {
  const firstMark = (t.anchor?.mark_ids ?? []).map((id) => compactText(markMap.get(id)?.marked_text)).find((x) => !!x);
  return clipText(compactText(t.inference_view?.question) || compactText(t.inference_view?.marked) || firstMark, 20);
}
function hmpSummary(row: HmpRow): string {
  return clipText(compactText(row.marked) || compactText(row.hmp.text_hint) || compactText(row.hmp.object_hint), 36);
}

/** 书目选择器（chat / capture 共用）。 */
const DOC_KIND_CN: Record<InspectableDoc['kind'], string> = { book: '书', diary: '日记', meeting: '会议', other: '其它' };
// 文档选择器：原生 <select> 在电纸屏上下拉弹层看不见/挡点击 → 换 in-app pickOneSheet 黑白浮层（同设置控件）。
// 列表 = listInspectableDocs()（书 + 日记 + 会议白板），打通日记/会议的 dev 下钻（原只列 listBooks）。
function docSelBtn(id: string, docs: InspectableDoc[]): string {
  const cur = docs.find((d) => d.document_id === devBook);
  const text = cur ? `${DOC_KIND_CN[cur.kind]}·${cur.filename}` : (docs.length ? '选择文档' : '（无文档）');
  return `<button type="button" class="sctl sselect" id="${id}"${docs.length ? '' : ' disabled'} data-value="${esc(devBook || '')}" aria-haspopup="dialog" style="max-width:180px">`
    + `<span class="sctl-v">${esc(text)}</span><span class="sctl-caret" aria-hidden="true">▾</span></button>`;
}
function bindDocSel(id: string, docs: InspectableDoc[], rerender: () => void): void {
  el(id)?.addEventListener('click', () => { void (async () => {
    if (!docs.length) return;
    const curIdx = Math.max(0, docs.findIndex((d) => d.document_id === devBook));
    const picked = await pickOneSheet({
      title: '选择文档',
      items: docs.map((d) => ({ id: d.document_id, label: d.filename, sub: DOC_KIND_CN[d.kind] })),
      defaultId: docs[curIdx]?.document_id, confirm: '查看', empty: '还没有文档。',
    });
    if (picked == null || picked === devBook) return;
    devBook = picked; rerender();
  })(); });
}

// ════ AI 会话 ════
// dev 三页（dv-chat/dv-hmp/dv-set）每次 render 重建 innerHTML（含 .dbody）→ 每次渲染末尾给新 .dbody 建一个新 pager。
const devPagers = new Map<string, Pager>();
function pageDbody(viewEl: HTMLElement, key: string, land: 'first' | 'keep' = 'keep'): void {
  devPagers.get(key)?.destroy();
  const sc = viewEl.querySelector<HTMLElement>('.dbody');
  if (!sc) { devPagers.delete(key); return; }
  let bar: PagerBar | undefined;
  const pager = createPager(sc, { onChange: (i) => bar?.update(i) });
  bar = mountPagerBar(pager, viewEl);
  pager.relayout(land);
  devPagers.set(key, pager);
}

export async function renderChat(): Promise<void> {
  const seq = ++chatRenderSeq;
  const docs = await listInspectableDocs();
  if (seq !== chatRenderSeq) return; // 期间又触发了一次 render → 本次作废，别拿旧数据覆盖新 DOM
  if (!devBook || !docs.some((d) => d.document_id === devBook)) devBook = state.documentId || docs[0]?.document_id || null; // 默认当前文档 / 最近一份
  let body: string;
  if (!devBook) body = `<p class="dnote">选一份文档（书 / 日记 / 会议），或先在对应面里打开一份，查看它的 AI 会话记录。</p>`;
  else {
    const [turns, marks] = await Promise.all([getBookAiTurns(devBook), getFoldedMarks(devBook)]);
    if (seq !== chatRenderSeq) return;
    const markMap = new Map(marks.map((m) => [m.mark_id, m]));
    const live = turns.filter((t) => t.overlay_state !== 'dismissed');
    if (openChat && !live.some((t) => t.entry_id === openChat)) openChat = null; // 展开项已不在 → 复位
    if (!live.length) body = `<p class="dnote">这份文档还没有 AI 会话。圈划 + 手写问题，长停顿/手写定向会触发回复。</p>`;
    else {
      const byPage = new Map<number, PersistedAiTurn[]>();
      for (const t of live) { const p = t.page_index ?? 0; if (!byPage.has(p)) byPage.set(p, []); byPage.get(p)!.push(t); }
      const pages = [...byPage.entries()].sort((a, b) => Math.max(...b[1].map((t) => t.seq)) - Math.max(...a[1].map((t) => t.seq)));
      body = pages.map(([pi, ts], gi) => {
        const sorted = ts.slice().sort((a, b) => b.seq - a.seq);
        const rows = sorted.map((t) => turnBlock(t, markMap)).join('');
        const hasOpen = sorted.some((t) => t.entry_id === openChat); // 展开项所在页默认展开
        return `<details class="grp"${gi === 0 || hasOpen ? ' open' : ''}><summary><span class="gc">第 ${pi + 1} 页</span><span class="gm">${ts.length} 轮 · ${fmtTime(sorted[0].created_at)}</span></summary><div class="gbody">${rows}</div></details>`;
      }).join('');
    }
  }
  el('dv-chat').innerHTML =
    `<div class="dhead"><h1>AI 会话</h1><span class="sp"></span>${docSelBtn('dv-bk-chat', docs)}</div><div class="dbody">${body}</div>`;
  bindDocSel('dv-bk-chat', docs, () => { openChat = null; void renderChat(); });
  pageDbody(el('dv-chat'), 'chat');
}
function turnBlock(t: PersistedAiTurn, markMap: Map<string, PersistedMark>): string {
  const open = openChat === t.entry_id; // 抽屉单开：只渲展开项的 body
  const trg = TRIGGER_CN[t.trigger] || t.trigger;
  const trgCls = t.trigger === 'handwriting' ? 'trg hw' : 'trg';
  const head = `<button type="button" class="drawer-head turn-head" data-chat="${esc(t.entry_id)}" aria-expanded="${open ? 'true' : 'false'}">`
    + `<span class="di">${open ? '▾' : '▸'}</span><span class="tpage">第 ${t.page_index + 1} 页</span><span class="sep">·</span>`
    + `<span class="${trgCls}">${esc(trg)}</span><span class="sep">·</span><span class="tt">${fmtTime(t.created_at)}</span><span class="sep">·</span>`
    + `<span class="turn-sum">${esc(turnSummary(t, markMap))}</span></button>`;
  if (!open) return `<div class="turn drawer-turn" data-chat="${esc(t.entry_id)}">${head}</div>`;
  const userInner = (t.pipeline && t.pipeline.length) ? pipelineSection(t.pipeline, true) : legacySection(t, markMap); // 有 pipeline 快照→逐组件复盘（电纸屏 collapsed=全收起·点触逐展）；否则旧轮兜底
  const folded = !t.ai_reply && t.diag?.classify && t.diag.classify.respond === false;
  const reason = t.diag?.classify?.reason;
  const result = folded
    ? `<div class="turn folded">🚫 折叠为「写给自己的笔记」——这处手写没有指向性、不触发回复，留作下次综合。`
      + (reason ? `<div class="ameta">分类器：${esc(reason)}</div>` : '') + `</div>`
    : `<div class="abub">${esc(t.ai_reply || '（无回复）')}`
      + (t.thinking ? `<details class="think"><summary>思考过程</summary><div>${esc(t.thinking)}</div></details>` : '')
      + `<div class="ameta">${esc(t.model || '')}${t.supersedes ? ' · 改写' : ''}</div></div>`;
  return `<div class="turn drawer-turn open" data-chat="${esc(t.entry_id)}">${head}<div class="drawer-body turn-body">`
    + `<div class="ucard">${userInner}</div>` + result + `</div></div>`; // 用户卡=pipeline 复盘/旧轮兜底（HTML·不 esc）
}

// ════ 采集取证 ════
export async function renderCapture(): Promise<void> {
  const seq = ++captureRenderSeq;
  const docs = await listInspectableDocs();
  if (seq !== captureRenderSeq) return; // 期间又触发了一次 render → 本次作废
  if (!devBook || !docs.some((d) => d.document_id === devBook)) devBook = state.documentId || docs[0]?.document_id || null; // 默认当前文档 / 最近一份
  const seg = `<div class="seg"><button class="${captureSeg === 'hmp' ? 'on' : ''}" data-seg="hmp">HMP 取证</button><button class="${captureSeg === 'obj' ? 'on' : ''}" data-seg="obj">对象</button></div>`;
  let inner: string;
  if (!devBook) inner = `<p class="dnote">选一份文档（书 / 日记 / 会议）查看它的逐笔 HMP 取证 + SurfaceIndex 对象表。</p>`;
  else {
    const rows = await buildHmpRows(devBook);
    if (seq !== captureRenderSeq) return;
    if (captureSeg === 'hmp') {
      if (openHmp && !rows.some((r) => r.key === openHmp)) openHmp = null; // 展开项已不在 → 复位
      const si = state.surfaceIndex;
      const objMap = si ? new Map(si.objects.map((o) => [o.id, o])) : null;
      inner = `<p class="dnote">逐笔 HMP 取证 —— 最新在上。共 ${rows.length} 笔。历史标注落库剥了 crop/vector，唯本会话 state.lastHmps 还有取证图。</p>`
        + (rows.map((r) => hmpCard(r, objMap && si && r.page_id === si.surface_id ? objMap : null)).join('') || `<p class="dnote">这本书还没有带取证的标注。</p>`);
    } else inner = objTable(rows);
  }
  el('dv-hmp').innerHTML =
    `<div class="dhead"><h1>采集取证</h1>${seg}<span class="sp"></span>${docSelBtn('dv-bk-hmp', docs)}</div><div class="dbody">${inner}</div>`;
  el('dv-hmp').querySelectorAll<HTMLElement>('.seg [data-seg]').forEach((b) => b.addEventListener('click', () => { captureSeg = b.dataset.seg as 'hmp' | 'obj'; void renderCapture(); }));
  bindDocSel('dv-bk-hmp', docs, () => { openHmp = null; void renderCapture(); });
  pageDbody(el('dv-hmp'), 'hmp');
  applyPendingFlash();
}
/** 取证图：本会话 live 的 crop/vector dataURL（持久落库已剥·历史无图如实标注）。 */
function hmpShots(row: HmpRow): string {
  const imgs = [
    row.hmp.crop_ref ? ['合成', row.hmp.crop_ref] : null,
    row.hmp.vector_ref ? ['笔迹', row.hmp.vector_ref] : null,
  ].filter((x): x is [string, string] => !!x && /^data:image\//.test(x[1]));
  if (!imgs.length) return `<div class="himg hnone">${row.live ? '本会话无图' : '历史标注<br>无图'}</div>`;
  return `<div class="himg hshots">${imgs.map(([cap, src]) => `<span><img src="${esc(src)}" alt=""><em>${esc(cap)}</em></span>`).join('')}</div>`;
}
/** 命中对象：可点 → 切对象表 + 高亮该行（互跳）。本页才解析得到对象文字。 */
function hmpTargetRow(row: HmpRow, objMap: Map<string, SurfaceObject> | null): string {
  const refs = row.hmp.target_object_refs;
  if (!refs.length) return row.hmp.mode === 'self_content' ? '空（自身内容）' : '空';
  if (!objMap) return `${refs.length} 个（第 ${row.page_index + 1} 页；切到该页可解析/互跳）`;
  return refs.map((id) => {
    const o = objMap.get(id);
    return o ? `<span class="cap-link" data-ref="${esc(id)}">${esc(id)}「${esc((o.text || '·' + o.type).slice(0, 18))}」</span>` : `${esc(id)}(缺)`;
  }).join('　');
}
function hmpCard(row: HmpRow, objMap: Map<string, SurfaceObject> | null): string {
  const h = row.hmp;
  const open = openHmp === row.key; // 抽屉单开
  const [modeLabel, anchor] = HMP_MODE[h.mode] || ['未知', false];
  const region = `[${h.target_region.map((n) => n.toFixed(2)).join(', ')}]`;
  const head = `<button type="button" class="drawer-head hmp-head" data-hmp="${esc(row.key)}" aria-expanded="${open ? 'true' : 'false'}">`
    + `<span class="di">${open ? '▾' : '▸'}</span><span class="mode${anchor ? ' anchor' : ''}">${esc(modeLabel)}</span><span class="sep">·</span>`
    + `<span class="act">${esc(HMP_ACTION[h.action] || h.action)}</span><span class="sep">·</span><span class="hmp-text">${esc(hmpSummary(row))}</span></button>`;
  if (!open) return `<div class="hcard" data-mark="${esc(row.key)}">${head}</div>`;
  return `<div class="hcard open" data-mark="${esc(row.key)}">${head}`
    + `<div class="drawer-body hcb">${hmpShots(row)}<div class="hf">`
    + `<div><b>取证</b>${esc(h.object_hint || '—')} · ${h.confidence.toFixed(2)} · ${esc(h.version)} · 第${row.page_index + 1}页${row.unsaved ? ' · 未落库' : row.live ? ' · 本会话' : ''}</div>`
    + `<div><b>类型</b>${esc(HMP_FEAT[row.feature] || row.feature)}</div>`
    + `<div><b>所标内容</b>${esc(row.marked || '—')}</div>`
    + `<div><b>命中对象</b>${hmpTargetRow(row, objMap)}</div>`
    + `<div><b>读出</b>${esc(h.text_hint || '—')}</div>`
    + `<div><b>区域</b>${esc(region)}</div></div></div></div>`;
}
function objTable(rows: HmpRow[] = []): string {
  const si = state.surfaceIndex;
  if (!si || !si.objects.length) return `<p class="dnote">当前没有 SurfaceIndex（打开一本书 / 一页后这里列出本页对象）。</p>`;
  const objMarks = new Map<string, Array<{ id: string; label: string }>>();
  for (const r of rows) {
    if (r.page_id !== si.surface_id) continue;
    for (const ref of r.hmp.target_object_refs) {
      const arr = objMarks.get(ref) ?? [];
      arr.push({ id: r.key, label: markChipLabel(r.feature, r.marked) });
      objMarks.set(ref, arr);
    }
  }
  const types = new Map<string, number>();
  for (const o of si.objects) types.set(o.type, (types.get(o.type) ?? 0) + 1);
  const dist = [...types.entries()].map(([t, n]) => `${t} ${n}`).join(' · ');
  const rowsHtml = si.objects.slice(0, 150).map((o: SurfaceObject) => {
    const hits = objMarks.get(o.id) ?? [];
    const chips = hits.length ? hits.map((h) => `<span class="cap-markchip" data-mark="${esc(h.id)}">${esc(h.label)}</span>`).join('') : '';
    return `<tr data-objid="${esc(o.id)}"><td>${esc(o.id)}</td><td>${esc(o.type)}</td><td>${o.bbox[0].toFixed(2)},${o.bbox[1].toFixed(2)}</td><td>${esc((o.text || '—').slice(0, 24))}</td><td>${chips}</td></tr>`;
  }).join('');
  return `<p class="dnote">本页 SurfaceIndex · surface=${esc(si.surface_type)} · 共 ${si.objects.length} 个 · ${esc(dist)}。命中 chip 可点回 HMP 卡。</p>`
    + `<table class="otbl"><thead><tr><th>id</th><th>type</th><th>bbox</th><th>text</th><th>被命中</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
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
  { label: 'AI 触发模式', desc: 'AI笔触=只选中 AI 笔写的进 AI·走意图识别(默认) · 自动判意=每笔都判(实验)', badge: 'eff', effect: 'changed', type: 'select', opts: [['pen', 'AI 笔触（选中才进 AI·默认）'], ['auto', '自动判意（每笔都判·实验）']], get: () => settings.aiTrigger, set: (v) => { settings.aiTrigger = v as typeof settings.aiTrigger; } },
  { label: '推理模型', desc: '答问 · 分类器默认', badge: 'eff', effect: 'changed', type: 'select', opts: MODELS_INFER, get: () => settings.inferModel, set: (v) => { settings.inferModel = v; } },
  { label: '识别分类器模型', desc: '/api/interpret', badge: 'eff', effect: 'changed', type: 'select', opts: MODELS_INHERIT([['__local_hwr__', '端侧手写 HWR']]), get: () => settings.interpretModel, set: (v) => { settings.interpretModel = v; } },
  { label: '上下文分类器模型', desc: '/api/classify-context', badge: 'eff', effect: 'changed', type: 'select', opts: MODELS_INHERIT([['__local_rules__', '端侧规则·徐']]), get: () => settings.classifyModel, set: (v) => { settings.classifyModel = v; } },
  { label: '送合成图给模型', badge: 'eff', effect: 'changed', type: 'check', get: () => settings.sendMarkImage, set: (_v, c) => { settings.sendMarkImage = c; } },
  { label: '输出落点', badge: 'eff', effect: 'changed', type: 'select', opts: [['margin', '右侧留白'], ['inline', '贴正文浮动']], get: () => settings.placement, set: (v) => { settings.placement = v as typeof settings.placement; } },
  { label: '手势响应（总开关）', badge: 'eff', effect: 'changed', type: 'check', get: () => settings.gesture.enabled, set: (_v, c) => { settings.gesture.enabled = c; } },
  { label: '长停顿综合阈值', desc: '10–600 秒', badge: 'eff', effect: 'changed', type: 'number', min: 10, max: 600, get: () => settings.gesture.idleSeconds ?? 90, set: (v) => { settings.gesture.idleSeconds = Math.min(600, Math.max(10, parseInt(v, 10) || 90)); } },
  { label: '手写收口等待', desc: '停笔多久送识别/AI（1–10 秒·默认 1）。调短=反馈快；写长句常被句中停顿拆碎就调回 2–3', badge: 'eff', effect: 'changed', type: 'number', min: 1, max: 10, get: () => Math.round((settings.regionQuietMs || 1000) / 1000), set: (v) => { settings.regionQuietMs = Math.min(10, Math.max(1, parseInt(v, 10) || 1)) * 1000; } },
  { label: '重排引擎', badge: 'eff', effect: 'changed', type: 'select', opts: [['ai', 'AI 结构重建'], ['hybrid', '启发式+模型精修'], ['local', '仅启发式'], ['vision', '启发式+视觉重排'], ['rewrite', 'VLM 看图重写']], get: () => settings.reflowProvider, set: (v) => { settings.reflowProvider = v; } },
  { label: '重排模型', badge: 'eff', effect: 'changed', type: 'select', opts: [['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite'], ['gemini-3.5-flash', 'gemini-3.5-flash'], ['kimi-k2.6', 'kimi-k2.6'], ['claude-sonnet-4-6', 'claude-sonnet-4-6']], get: () => settings.reflowModel, set: (v) => { settings.reflowModel = v; } },
  { label: '重排前置（渲染即急算）', badge: 'eff', effect: 'save', type: 'check', get: () => settings.reflowEager, set: (_v, c) => { settings.reflowEager = c; } },
  { label: '基岩录制（原始笔迹流·影子）', badge: 'eff', effect: 'save', type: 'check', get: () => settings.bedrock, set: (_v, c) => { settings.bedrock = c; bus.emit('bedrock:user-set', c); } }, // 通知会议 lease：用户手动设过 → 会议退出别误关
];
const DEBUG: SCtl[] = [
  { label: '网络线路（所有云服务共用出口）', desc: '换地方免重打包一键切·对后续请求即时生效。默认=构建烧录值 · 公网=cloudflared(内外网通用·https) · 内网=10.4.36.30直连(少一跳·http明文仅debug构建放行)。AI/Obsidian上传/飞书妙记全走这一个出口。', badge: 'dev', effect: 'changed', type: 'select', opts: [['', '默认（构建烧录值）'], ['cloud', '公网 cloudflared'], ['intranet', '内网直连']], get: () => apiRouteChoice(), set: (v) => setApiRoute(v) },
  { label: 'AI 笔原功能（圈选识别+总是回应）', desc: '默认停用·AI 笔走意图识别即可。开=圈→答被圈内容+跳分类器必回应（重排圈选漂移待重做）', badge: 'dev', effect: 'changed', type: 'check', get: () => settings.aiPenExplicit, set: (_v, c) => { settings.aiPenExplicit = c; } },
  { label: '设备遥测（给开发者）', desc: '开后事实流推 window.__devtel + console（让 Claude 经 CDP 直读板上 gesture/识别/分类/推理/重排）', badge: 'dev', effect: 'changed', type: 'check', get: () => settings.devtel, set: (_v, c) => { settings.devtel = c; } },
  { label: '记录 AI pipeline 快照', desc: '本机也记整轮逐组件复盘（板上默认空·开后每轮多存缩略图）', badge: 'dev', effect: 'changed', type: 'check', get: () => settings.recordPipeline, set: (_v, c) => { settings.recordPipeline = c; } },
  { label: '「思考中…」占位锚', desc: '默认关·抬笔后在锚点显示占位等回答。关=fold 笔记不闪、电纸屏不多刷；开=抬笔即反馈（真答案流式不受影响）', badge: 'dev', effect: 'changed', type: 'check', get: () => settings.thinkingTag, set: (_v, c) => { settings.thinkingTag = c; } },
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
// 知识库上传 UI 态（提到模块态·从态重渲）：上传中若 renderSettings 重渲（surface:indexed 等 bus 事件触发），
// 捕获的 DOM 会 detach、异步结果写不回 → 改为状态驱动，每次重渲都还原。
let vaultPublishBusy = false;
let vaultPublishConcepts = false;
let vaultPublishStatus = '尚未上传。';
/** 上传结果 → 电纸屏可读状态：区分「上传了新内容」vs「内容没变·已是最新」(deduped)，并列出前几条跳过提示（不只数量）。 */
function vaultPublishStatusText(r: VaultPublishResult): string {
  if (!r.ok) return `✗ ${r.error || '上传失败'}（阶段 ${r.stage}）`;
  const base = r.deduped
    ? `✓ 内容没变·远端已是最新 · ${r.entity_count ?? 0} 项 · ${r.file_count ?? 0} 文件`
    : `✓ 已上传新内容 · ${r.entity_count ?? 0} 项 · ${r.file_count ?? 0} 文件`;
  const w = r.warnings ?? [];
  if (!w.length) return base;
  return `${base}\n提示 ${w.length} 条：${w.slice(0, 3).join('；')}${w.length > 3 ? `；另 ${w.length - 3} 条` : ''}`;
}

/** 选择器当前值 → 显示文案（找不到映射就用原始值/未设置）。 */
function selectCtlLabel(c: SCtl, raw = String(c.get())): string {
  return c.opts?.find(([v]) => v === raw)?.[1] ?? (raw || '未设置');
}
/** 点选择器 → 黑白 in-app 选择浮层（替原生 <select> 下拉·电纸屏上原生下拉会挡点击）。 */
async function openSelectCtl(node: HTMLButtonElement, c: SCtl): Promise<void> {
  const opts = c.opts ?? [];
  const cur = String(c.get());
  const currentIdx = Math.max(0, opts.findIndex(([v]) => v === cur));
  const picked = await pickOneSheet({
    title: c.label,
    items: opts.map(([v, label], i) => ({ id: String(i), label, sub: v && v !== label ? v : undefined })),
    defaultId: String(currentIdx), confirm: '确定', empty: '没有可选项。',
  });
  if (picked == null) return;
  const next = opts[Number(picked)]?.[0];
  if (next == null || next === cur) return;
  node.value = next; node.dataset.value = next;
  node.dispatchEvent(new Event('change', { bubbles: true })); // 复用 change 绑定 → applyCtl
}
/** 控件 change 落地：写 settings.* + 回填显示 + 通知/保存（select 走 button.dataset.value，其余走 value/checked）。 */
function applyCtl(node: HTMLElement, c: SCtl): void {
  const raw = c.type === 'select'
    ? ((node as HTMLButtonElement).dataset.value ?? (node as HTMLButtonElement).value)
    : (node as HTMLInputElement | HTMLSelectElement).value;
  c.set(raw, (node as HTMLInputElement).checked);
  if (c.type === 'select') {
    const btn = node as HTMLButtonElement;
    const next = String(c.get());
    btn.value = next; btn.dataset.value = next;
    const label = btn.querySelector<HTMLElement>('.sctl-v');
    if (label) label.textContent = selectCtlLabel(c, next);
  }
  if (c.effect === 'changed') bus.emit('settings:changed');
  saveSettings();
}

function ctlHtml(c: SCtl, i: number): string {
  const badge = c.badge === 'eff' ? '<span class="sbadge eff">生效</span>' : c.badge === 'dev' ? '<span class="sbadge">调试</span>' : '<span class="sbadge weak">弱效</span>';
  const head = `<div class="sl"><div class="sn">${esc(c.label)} ${badge}</div>${c.desc ? `<div class="sd">${esc(c.desc)}</div>` : ''}</div>`;
  let ctl = '';
  if (c.type === 'select') {
    const raw = String(c.get());
    ctl = `<button type="button" class="sctl sselect" data-si="${i}" value="${esc(raw)}" data-value="${esc(raw)}" aria-haspopup="dialog" aria-label="${esc(c.label)}"><span class="sctl-v">${esc(selectCtlLabel(c, raw))}</span><span class="sctl-caret" aria-hidden="true">▾</span></button>`;
  }
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
    + `<div class="sgrp-h">知识库 · Obsidian</div>`
    + `<div class="srow"><div class="sl"><div class="sn">上传到 Obsidian <span class="sbadge eff">生效</span></div><div class="sd">把本机阅读 / 日记 / 会议打包发到 panel（Obsidian 端「同步知识库」拉取）</div></div><button type="button" class="hbtn" id="dv-vault-pub"${vaultPublishBusy ? ' disabled' : ''}>${vaultPublishBusy ? '上传中…' : '上传'}</button></div>`
    + `<div class="srow"><div class="sl"><div class="sn">含概念层</div><div class="sd">跨文档概念枢纽 · 走 LLM · 较慢（默认关）</div></div><input type="checkbox" class="sck" id="dv-vault-concepts"${vaultPublishConcepts ? ' checked' : ''}${vaultPublishBusy ? ' disabled' : ''}></div>`
    + `<div class="srow"><div class="sl"><div class="sd" id="dv-vault-status">${esc(vaultPublishStatus)}</div></div></div>`
    + `<div class="sgrp-h">调试 · 会议</div>`
    + `<div class="srow"><div class="sl"><div class="sn">最近 panel 同步</div><div class="sd">${panelSyncStatusHtml()}</div></div></div>`
    + `<div class="srow"><div class="sl"><div class="sn">手动结束会议</div><div class="sd">仅测试用——正常流程结束只应由云端事件驱动，别拿这个替代真实结束</div></div><button type="button" class="hbtn" id="dv-force-end">选会议</button></div>`
    + `<div class="sgrp-h">核心 · 影响真实行为</div>` + CORE.map((c, i) => ctlHtml(c, off0 + i)).join('')
    + `<div class="sgrp-h">调试叠层</div>` + DEBUG.map((c, i) => ctlHtml(c, off1 + i)).join('')
    + `<details class="sfold"><summary>历史 / 弱效</summary>` + WEAK.map((c, i) => ctlHtml(c, off2 + i)).join('') + `</details>`
    + `<details class="sfold"><summary>诊断</summary><div class="diag">`
    + diagHtml() + `</div></details>`;
  el('dv-set').innerHTML = `<div class="dhead"><h1>设置</h1><span class="sp"></span><button class="hbtn" id="reset-btn">恢复默认设置</button></div><div class="dbody">${body}</div>`;
  // 绑控件
  el('dv-set').querySelectorAll<HTMLElement>('[data-si]').forEach((node) => {
    const c = ctlReg[parseInt(node.dataset.si!, 10)];
    if (c.type === 'select') node.addEventListener('click', () => void openSelectCtl(node as HTMLButtonElement, c)); // 点开黑白选择浮层
    node.addEventListener('change', () => applyCtl(node, c)); // select 由 openSelectCtl 派发 change；check/number 原生 change
  });
  // 调试·手动结束会议（C11：普通用户界面撤掉了这个入口，只留在这里给测试用；真实结束只该由云端/panel 事件驱动）。
  el<HTMLButtonElement>('dv-force-end')?.addEventListener('click', async () => {
    const meetings = (await listAllMeetings()).filter((m) => m.status !== 'ended');
    if (!meetings.length) { await infoSheet({ title: '手动结束会议', message: '没有进行中/待开始的会议。' }); return; }
    const items = meetings.map((m) => ({ id: m.meeting_id, label: m.title || '(未命名会议)', sub: m.status === 'live' ? '进行中' : '待开始' }));
    const picked = await pickOneSheet({ title: '手动结束哪场会议？', items, confirm: '结束' });
    if (!picked) return;
    await updateMeeting(picked, { status: 'ended', ended_at: new Date().toISOString() });
    await infoSheet({ title: '已结束', message: '这场会议已本地标记为已结束（仅测试·不会通知 panel）。' });
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
  // 知识库上传：collect→build→publish 一个动作·结果电纸屏可见（不只 console）。状态走模块态→renderSettings 重渲，
  // 防上传中其它 bus 事件触发 renderSettings 把捕获的 status DOM 变 detach（并发防重入另有 publishVaultFromDevice 内 controller）。
  el<HTMLButtonElement>('dv-vault-pub')?.addEventListener('click', async () => {
    if (vaultPublishBusy) return;
    vaultPublishConcepts = el<HTMLInputElement>('dv-vault-concepts')?.checked ?? false;
    vaultPublishBusy = true;
    vaultPublishStatus = vaultPublishConcepts ? '上传中（含概念层 · 走 LLM · 较慢）…' : '上传中…';
    renderSettings();
    try {
      vaultPublishStatus = vaultPublishStatusText(await publishVaultFromDevice({ concepts: vaultPublishConcepts }));
    } catch (e) { vaultPublishStatus = `✗ ${String((e as Error)?.message || e)}`; }
    finally { vaultPublishBusy = false; renderSettings(); }
  });
  pageDbody(el('dv-set'), 'set');
}
/** A2/C10 诊断：panel 同步是「真没跑」还是「跑了但提醒 UI 太弱」，靠这行状态区分——别等用户事后猜。 */
function panelSyncStatusHtml(): string {
  const s = readPanelSyncStatus();
  if (s.lastErr && (!s.lastOkAt || s.lastErr.at > s.lastOkAt)) {
    return `失败 ${new Date(s.lastErr.at).toLocaleTimeString()} · ${esc(s.lastErr.message)}`;
  }
  if (s.lastOkAt) return `成功 ${new Date(s.lastOkAt).toLocaleTimeString()}`;
  return '尚未同步过';
}

function diagHtml(): string {
  const st = selfTest();
  const coord = st.samples ? `${st.ok ? '✓' : '✗'} ${st.samples} 点 · maxErr ${st.maxErr.toFixed(2)}` : '— 未打开页面';
  const metrics = snapshot().map((r) => `<tr><td>${esc(r.label)}</td><td>${r.last == null ? '—' : r.last + 'ms'}</td><td>${r.p50 == null ? '—' : r.p50 + 'ms'}</td></tr>`).join('')
    || '<tr><td colspan="3">暂无计时</td></tr>';
  return `<div class="dl"><b>坐标自测</b><span>${coord} · zoom ${Math.round(state.zoom * 100)}%</span></div>`
    + `<div class="dl"><b>预处理进度</b><span>${esc(preprocessText)}</span></div>`
    + `<div class="dl stack"><b>Metrics</b><table class="mtbl"><thead><tr><th>阶段</th><th>last</th><th>P50</th></tr></thead><tbody>${metrics}</tbody></table></div>`
    + `<div class="dl"><b>Trace</b><span>本会话 ${traceCount()} 条 · <a id="dv-trace-dl">下载 JSONL</a></span></div>`;
}
/** 设置页诊断块原地刷新（metrics/预处理是 live 流，不整页重渲）。 */
function fillDiag(): void {
  const box = document.querySelector<HTMLElement>('#dv-set .diag');
  if (box) box.innerHTML = diagHtml();
}

// ── 取证页 HMP↔对象互跳：切段后定位到目标 + 闪一下（e-ink 瞬时·不平滑滚） ──
const attrSel = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
function flashTarget(selector: string): void {
  const n = el('dv-hmp').querySelector<HTMLElement>(selector);
  if (!n) return;
  const pager = devPagers.get('hmp');
  if (pager) pager.goto(pager.pageOf(n)); // 跳到目标所在虚拟页（替代 scrollIntoView·电纸屏不滚）
  n.classList.remove('cap-flash'); void n.offsetWidth; n.classList.add('cap-flash');
  window.setTimeout(() => n.classList.remove('cap-flash'), 1400);
}
function applyPendingFlash(): void {
  if (!pendingFlash || captureSeg !== pendingFlash.seg) return;
  const sel = pendingFlash.selector;
  pendingFlash = null;
  requestAnimationFrame(() => flashTarget(sel));
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
  // 事件委托：Trace 下载 + 取证页 HMP↔对象互跳（cap-link 点对象 / cap-markchip 点回 HMP 卡）
  document.getElementById('surf-dev')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.id === 'dv-trace-dl') { downloadTrace(); return; }
    const chatHead = target.closest('.turn-head') as HTMLElement | null; // 抽屉表头：单开切换
    if (chatHead?.dataset.chat) { openChat = openChat === chatHead.dataset.chat ? null : chatHead.dataset.chat; void renderChat(); return; }
    const hmpHead = target.closest('.hmp-head') as HTMLElement | null;
    if (hmpHead?.dataset.hmp) { openHmp = openHmp === hmpHead.dataset.hmp ? null : hmpHead.dataset.hmp; void renderCapture(); return; }
    const ref = target.closest('.cap-link') as HTMLElement | null;
    if (ref?.dataset.ref) { captureSeg = 'obj'; pendingFlash = { seg: 'obj', selector: `tr[data-objid="${attrSel(ref.dataset.ref)}"]` }; void renderCapture(); return; }
    const mark = target.closest('.cap-markchip') as HTMLElement | null;
    if (mark?.dataset.mark) { captureSeg = 'hmp'; openHmp = mark.dataset.mark; pendingFlash = { seg: 'hmp', selector: `.hcard[data-mark="${attrSel(mark.dataset.mark)}"]` }; void renderCapture(); } // 互跳同时展开该卡
  });
  // 账本/索引变化 → 刷新当前 dev 页（仅 dev 面激活时）
  const live = (): void => { if (document.body.dataset.mode === 'dev') renderActive(); };
  bus.on('aiturn:appended', live);
  bus.on('hmp:updated', live);
  bus.on('surface:indexed', live);
  // 设置页诊断 live 流（metrics/预处理·只刷诊断块、不整页重渲）
  const liveDiag = (): void => { if (document.body.dataset.mode === 'dev' && active() === 'set') fillDiag(); };
  bus.on('metrics', liveDiag);
  bus.on('page:rendered', liveDiag);
  bus.on('preprocess:progress', (i, n) => { preprocessText = `预处理中 ${Number(i)}/${Number(n)} 页…`; liveDiag(); });
  bus.on('preprocess:done', () => { preprocessText = '预处理完成'; liveDiag(); });
}
