/**
 * dev 可视化叠层（精度/粒度诊断用）。settings.devOverlay 开关，默认关。
 *
 *  · 在页面上画出 SurfaceIndex 每个对象的 bbox（淡框，按 type 着色）。
 *  · 命中的 target 对象高亮成绿色实框——"我圈了几个字却点亮了整段"这类精度问题一眼可见。
 *  · 标记 region（HMP.target_region）用红虚线框。
 *  · 右上角浮窗实时显示最新 HMP 的全字段。
 *
 * 叠层 pointer-events:none，不挡笔；坐标用 pageCss（与 ink/whisper 同一套），翻页/缩放随 page:rendered 重绘。
 */
import { bus, state, settings } from '../app/state';
import { pageCss } from '../core/transform';
import type { HMP, MarkGraph } from '../core/contracts';

let layer: HTMLDivElement | null = null;
let regionLayer: HTMLDivElement | null = null;
let relLayer: HTMLDivElement | null = null;
let float: HTMLDivElement | null = null;
let lastHmp: HMP | null = null;
let lastRegion: { bbox: number[]; near: number } | null = null;
let lastGraph: MarkGraph | null = null;

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
const MODE_COLOR: Record<string, string> = { anchored: '#22c55e', self_content: '#f59e0b', mixed: '#3b82f6', unknown: '#ef4444' };

function ensureEls(): void {
  const stage = document.getElementById('stage');
  if (!layer && stage) { layer = document.createElement('div'); layer.id = 'bbox-overlay'; stage.appendChild(layer); }
  if (!regionLayer && stage) {
    regionLayer = document.createElement('div');
    regionLayer.id = 'region-overlay';
    regionLayer.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:6';
    stage.appendChild(regionLayer);
  }
  if (!relLayer && stage) {
    relLayer = document.createElement('div');
    relLayer.id = 'relation-overlay';
    relLayer.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:5';
    stage.appendChild(relLayer);
  }
  if (!float) { float = document.createElement('div'); float.id = 'hmp-float'; document.body.appendChild(float); }
}

/**
 * 提交后画"内容关联"：标注图里**非时间边（空间/语义，含 about）**所连的标注——
 * 每条关联标注一个小紫框 + 关联对之间一条紫虚线。近/远都清楚（远的不会糊成一整页大框）。
 */
/** dev 诊断：把"为什么没画关联框"的判定每次发到 telemetry（仅 graph:built 那次记一条，避免刷屏）。 */
let logNextRel = false;
function mirrorRelViz(d: Record<string, unknown>): void {
  if (!logNextRel) return;
  logNextRel = false;
  void fetch('/api/__debug/event', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'relviz', ts: new Date().toISOString(), ...d }),
  }).catch(() => { /* 诊断失败不连累 */ });
}

function drawRelations(): void {
  if (!relLayer) return;
  const W = pageCss.w, H = pageCss.h;
  relLayer.style.width = W + 'px';
  relLayer.style.height = H + 'px';
  if (!settings.showRelations || !lastGraph) {
    mirrorRelViz({ bail: !settings.showRelations ? 'showRelations=off' : 'no-graph', showRelations: settings.showRelations });
    relLayer.innerHTML = ''; return;
  }
  // 当前页节点的中心/框（px）
  const pos = new Map<string, { cx: number; cy: number; x: number; y: number; w: number; h: number }>();
  for (const n of lastGraph.nodes) {
    if (n.page_id !== state.pageId) continue;
    const b = n.bbox;
    pos.set(n.mark_id, { cx: (b[0] + b[2] / 2) * W, cy: (b[1] + b[3] / 2) * H, x: b[0] * W, y: b[1] * H, w: b[2] * W, h: b[3] * H });
  }
  // 关联 = 非 separate：空间/语义边恒算 + 时间边除"远时远空(separate)"外都算（一口气/扫读/回访）。
  const edges = lastGraph.edges.filter((e) => (e.kind !== 'temporal' || e.quadrant !== 'separate') && pos.has(e.from) && pos.has(e.to));
  mirrorRelViz({
    statePageId: state.pageId, pageCss: { w: Math.round(W), h: Math.round(H) },
    nodes: lastGraph.nodes.length, nodesOnPage: pos.size,
    nodePages: [...new Set(lastGraph.nodes.map((n) => n.page_id))],
    allEdges: lastGraph.edges.map((e) => `${e.kind}/${e.quadrant ?? e.rel}`),
    keptEdges: edges.length,
    bail: !edges.length ? (pos.size < 2 ? 'no-nodes-on-page' : 'all-edges-separate-or-offpage') : 'drew',
  });
  if (!edges.length) { relLayer.innerHTML = ''; return; }
  const involved = new Set<string>();
  let lines = '';
  for (const e of edges) {
    const a = pos.get(e.from)!, b = pos.get(e.to)!;
    involved.add(e.from); involved.add(e.to);
    lines += `<line x1="${a.cx}" y1="${a.cy}" x2="${b.cx}" y2="${b.cy}" stroke="#7c5cff" stroke-width="1.5" stroke-dasharray="5 4" />`;
  }
  let rects = '';
  for (const id of involved) {
    const p = pos.get(id)!;
    rects += `<rect x="${p.x - 4}" y="${p.y - 4}" width="${p.w + 8}" height="${p.h + 8}" rx="6" fill="rgba(124,92,255,0.10)" stroke="#7c5cff" stroke-width="2" />`;
  }
  relLayer.innerHTML = `<svg width="${W}" height="${H}" style="position:absolute;left:0;top:0;overflow:visible">${lines}${rects}</svg>`;
}

/** 手写时实时画当前组装区域：聚拢块(实框) + "附近"判定边界(虚框)。 */
function drawRegion(): void {
  if (!regionLayer) return;
  regionLayer.style.width = pageCss.w + 'px';
  regionLayer.style.height = pageCss.h + 'px';
  if (!settings.showRegion || !lastRegion) { regionLayer.innerHTML = ''; return; }
  const { bbox, near } = lastRegion;
  const r = toPx(bbox);
  const nl = (bbox[0] - near) * pageCss.w, nt = (bbox[1] - near) * pageCss.h;
  const nw = (bbox[2] + 2 * near) * pageCss.w, nh = (bbox[3] + 2 * near) * pageCss.h;
  regionLayer.innerHTML =
    `<div style="position:absolute;left:${nl}px;top:${nt}px;width:${nw}px;height:${nh}px;border:1.5px dashed #f59e0b;border-radius:6px;background:rgba(245,158,11,0.05)"></div>`
    + `<div style="position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid #f59e0b;border-radius:4px;background:rgba(245,158,11,0.14)"></div>`;
}

const on = (): boolean => !!settings.devOverlay;
const toPx = (b: number[]) => ({ left: b[0] * pageCss.w, top: b[1] * pageCss.h, width: b[2] * pageCss.w, height: b[3] * pageCss.h });

function drawObjects(): void {
  if (!layer) return;
  layer.style.width = pageCss.w + 'px';
  layer.style.height = pageCss.h + 'px';
  const si = state.surfaceIndex;
  if (!on() || !si) { layer.innerHTML = ''; return; }
  const refs = new Set(lastHmp?.target_object_refs ?? []);
  let html = si.objects.map((o) => {
    const p = toPx(o.bbox);
    const hit = refs.has(o.id) ? ' hit' : '';
    return `<div class="bbox-rect t-${esc(o.type)}${hit}" style="left:${p.left}px;top:${p.top}px;width:${p.width}px;height:${p.height}px" title="${esc(o.id)} · ${esc(o.type)}"><span class="bbox-tag">${esc(o.id)}</span></div>`;
  }).join('');
  if (lastHmp) {
    const m = toPx(lastHmp.target_region);
    html += `<div class="bbox-mark" style="left:${m.left}px;top:${m.top}px;width:${m.width}px;height:${m.height}px"></div>`;
  }
  layer.innerHTML = html;
}

function drawFloat(): void {
  if (!float) return;
  if (!on()) { float.style.display = 'none'; return; }
  float.style.display = 'block';
  const h = lastHmp;
  if (!h) { float.innerHTML = '<div class="hf-head">HMP 浮窗</div><div class="hf-empty">圈/划/写一处…</div>'; return; }
  const objs = state.surfaceIndex?.objects ?? [];
  const targets = h.target_object_refs.map((id) => {
    const o = objs.find((x) => x.id === id);
    return o ? `${esc(o.id)}「${esc((o.text || '·' + o.type).slice(0, 18))}」` : `${esc(id)}(缺)`;
  });
  const color = MODE_COLOR[h.mode] ?? '#888';
  float.innerHTML = `<div class="hf-head" style="border-color:${color}">HMP · <b style="color:${color}">${esc(h.mode)}</b> / ${esc(h.action)}</div>`
    + `<div class="hf-row"><span>target</span><b>${targets.length ? targets.join('　') : '<i style="color:#ef4444">空（未命中）</i>'}</b></div>`
    + `<div class="hf-row"><span>object_hint</span><b>${esc(h.object_hint)}</b></div>`
    + `<div class="hf-row"><span>text_hint</span><b>${esc(h.text_hint || '—')}</b></div>`
    + `<div class="hf-row"><span>region</span><b>[${h.target_region.map((n) => n.toFixed(3)).join(', ')}]</b></div>`
    + `<div class="hf-row"><span>confidence</span><b>${h.confidence.toFixed(2)}</b> · v${esc(h.version)}</div>`
    + `<div class="hf-row"><span>refs/证据</span><b>${h.target_object_refs.length}</b> · crop ${h.crop_ref ? '✓' : '✗'} · vec ${h.vector_ref ? '✓' : '✗'}</div>`;
}

function refresh(): void { ensureEls(); drawObjects(); drawFloat(); drawRegion(); drawRelations(); }

export function initDevOverlay(): void {
  ensureEls();
  bus.on('surface:indexed', () => { lastHmp = null; lastGraph = null; refresh(); });
  bus.on('hmp:updated', (h) => { lastHmp = h as HMP; refresh(); });
  bus.on('page:rendered', refresh);
  bus.on('settings:changed', refresh);
  bus.on('region:update', (c) => { lastRegion = c as { bbox: number[]; near: number }; drawRegion(); });
  bus.on('region:clear', () => { lastRegion = null; drawRegion(); });
  bus.on('graph:built', (g) => { lastGraph = g as MarkGraph; logNextRel = true; drawRelations(); });
  refresh();
}
