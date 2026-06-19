import { selfTest } from '../core/transform';
import { snapshot } from '../core/metrics';
import { downloadTrace } from '../core/trace';
import { bus, state, settings, saveSettings, type Placement, type OcrImageMode } from '../app/state';
import { INFER_PROVIDER_LABELS } from '../local/model-client';
import { inspectLog } from '../core/inspect';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
const SYM: Record<string, string> = {
  circle: '圈选', underline: '划线', highlight: '高亮', arrow: '箭头',
  margin_note: '批注', tap_region: '点选', stroke: '标记', eraser: '擦除', unknown: '标记',
};

/**
 * 开发抽屉 —— 规范要求：Debug 信息只在开发/研究模式出现，普通用户不被打扰。
 * 唤出方式：URL ?dev=1 自动展开；快捷键 d；顶栏 ⋯ 按钮。
 */

let drawer: HTMLElement;
let traceLog: HTMLElement;
let metricsBody: HTMLElement;
let selftestEl: HTMLElement;

function fillSelect(sel: HTMLSelectElement, labels: Record<string, string>, current: string): void {
  sel.innerHTML = '';
  for (const [value, label] of Object.entries(labels)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

/** 上下文监控：渲染最近若干次推理「喂了什么 + 回了什么」。 */
function renderInspect(): void {
  const box = document.getElementById('inspect-log');
  if (!box) return;
  const items = inspectLog();
  if (!items.length) { box.innerHTML = '<p class="ins-empty">还没有推理。圈/划一处、停笔，结果会出现在这里。</p>'; return; }
  box.innerHTML = items.map((r) => {
    const d = (r.debug ?? {}) as Record<string, unknown>;
    const mem = (d.memory_pages as Array<{ index: number; content: string | null; summary: string | null }> | undefined) ?? [];
    const memLine = mem.length ? mem.map((m) => `第${m.index + 1}页：${m.content || m.summary || '—'}`).join('；') : '无';
    const tag = `${SYM[r.gesture] ?? r.gesture}${r.intent ? '·' + r.intent : ''} → ${r.resultType}`;
    const ms = typeof d.ms === 'number' ? `${Math.round(d.ms as number)}ms · ` : '';
    const mode = d.mode ? `${esc(String(d.mode))} · ` : '';
    const flags = [r.recalled.length ? `回看[${r.recalled.join(',')}]` : '', String(d.tier ?? '')].filter(Boolean).join(' · ');
    const bb = r.bbox ? r.bbox.map((n) => n.toFixed(2)).join(',') : '';
    // 模型实际看到的图直接显示在卡片里——核对"是模型问题还是没截到/没识别"。
    // 多图(笔迹/原文/合成)逐张并排显示并标注角色；兼容旧的单张合成图。
    const ROLE_CN: Record<string, string> = { ink: '笔迹', page: '原文', composite: '合成' };
    const imgs = (r.images && r.images.length) ? r.images : (r.composite ? [{ role: 'composite', data: r.composite }] : []);
    const shot = imgs.length
      ? `<div class="ins-shots">${imgs.map((im) => `<a class="ins-shotwrap" href="${im.data}" target="_blank" title="模型看到的「${ROLE_CN[im.role] ?? im.role}」· bbox[${bb}] · 点击放大"><img class="ins-shot" src="${im.data}" alt="${esc(im.role)}" /><span class="ins-shotcap">${ROLE_CN[im.role] ?? esc(im.role)}</span></a>`).join('')}</div>`
      : `<div class="ins-noshot">无图</div>`;
    return `<div class="ins-card">`
      + `<div class="ins-head"><span class="ins-tag">${esc(tag)}</span><span class="ins-meta">第${r.pageIndex + 1}页 · ${mode}${ms}${esc(r.model)}${flags ? ' · ' + esc(flags) : ''}</span></div>`
      + `<div class="ins-main">${shot}<div class="ins-cols">`
      + `<div class="ins-line"><span class="ins-k">焦点</span><span class="ins-v">${esc(r.nearby || '—')}</span></div>`
      + `<div class="ins-line"><span class="ins-k">回复</span><span class="ins-v ins-reply">${esc(r.content)} <em class="ins-conf">信心 ${r.confidence}</em></span></div>`
      + `</div></div>`
      + `<details class="ins-more"><summary>系统 / 任务 / OCR / 记忆</summary><div class="ins-body">`
      + `<div class="ins-k">系统提示</div><div class="ins-v">${esc(String(d.system ?? '—'))}</div>`
      + `<div class="ins-k">任务</div><div class="ins-v">${esc(String(d.task ?? '—'))}</div>`
      + `<div class="ins-k">OCR 块（${r.ocrTexts.length}）</div><div class="ins-v">${esc(r.ocrTexts.join(' / ') || '—')}</div>`
      + `<div class="ins-k">前页记忆（${r.memoryPages}）</div><div class="ins-v">${esc(memLine)}</div>`
      + `</div></details></div>`;
  }).join('');
}

const MODE_COLOR: Record<string, string> = {
  anchored: '#22c55e', self_content: '#f59e0b', mixed: '#3b82f6', unknown: '#ef4444',
};
const ACTION_CN: Record<string, string> = {
  enclosure: '圈', underline: '划线', cross: '叉', arrow: '箭头',
  handwriting: '手写', sketch: '草图', highlight: '高亮', unknown: '未知',
};
const OBJHINT_CN: Record<string, string> = {
  text: '文字', image_region: '图区', ui_region: 'UI', blank: '空白', diagram: '图表', unknown: '未知',
};

/** HMP 取证面板：最近若干条 HMP 的**全字段**，肉眼核对采集完整性/准确性（命中→原文、region bbox、text_hint、provenance、version）。 */
function renderHmpLog(): void {
  const box = document.getElementById('hmp-log');
  if (!box) return;
  const hmps = state.lastHmps;
  if (!hmps.length) { box.innerHTML = '<p class="ins-empty">还没有标注。圈/划/写一处、停笔，HMP 会出现在这里。</p>'; return; }
  const objs = state.surfaceIndex?.objects ?? [];
  box.innerHTML = hmps.map((h) => {
    const color = MODE_COLOR[h.mode] ?? '#888';
    const targets = h.target_object_refs.map((id) => {
      const o = objs.find((x) => x.id === id);
      return o ? `${esc(o.id)}「${esc((o.text || '·' + o.type).slice(0, 24))}」` : `${esc(id)}<span style="color:#ef4444">(缺)</span>`;
    });
    const refs = targets.length ? targets.join('　') : '<span style="color:#ef4444">空（未命中）</span>';
    const ocr = h.text_hint ? esc(h.text_hint) : '—';
    const reg = h.target_region.map((n) => n.toFixed(3)).join(', ');
    const crop = h.crop_ref ? `<a class="ins-shotwrap" href="${h.crop_ref}" target="_blank" title="局部 crop"><img class="ins-shot" src="${h.crop_ref}" alt="crop" /><span class="ins-shotcap">crop</span></a>` : '';
    const ink = h.vector_ref ? `<a class="ins-shotwrap" href="${h.vector_ref}" target="_blank" title="笔迹白底"><img class="ins-shot" src="${h.vector_ref}" alt="ink" /><span class="ins-shotcap">笔迹</span></a>` : '';
    const shots = (crop || ink) ? `<div class="ins-shots">${crop}${ink}</div>` : '<div class="ins-noshot">无图</div>';
    return `<div class="ins-card">`
      + `<div class="ins-head"><span class="ins-tag" style="color:${color}">[${esc(h.mode)}] ${ACTION_CN[h.action] ?? esc(h.action)}</span>`
      + `<span class="ins-meta">${OBJHINT_CN[h.object_hint] ?? esc(h.object_hint)} · 命中${h.target_object_refs.length} · 信心${h.confidence.toFixed(2)} · v${esc(h.version)}</span></div>`
      + `<div class="ins-main">${shots}<div class="ins-cols">`
      + `<div class="ins-line"><span class="ins-k">target</span><span class="ins-v">${refs}</span></div>`
      + `<div class="ins-line"><span class="ins-k">text_hint</span><span class="ins-v">${ocr}</span></div>`
      + `<div class="ins-line"><span class="ins-k">region</span><span class="ins-v">[${reg}]</span></div>`
      + `</div></div></div>`;
  }).join('');
}

/** SurfaceIndex 对象表（step① 源头）：逐对象 id/type/role/bbox/text/source，核对采集源本身对不对。 */
function renderSurfaceObjects(): void {
  const box = document.getElementById('surface-objects');
  if (!box) return;
  const si = state.surfaceIndex;
  if (!si || !si.objects.length) { box.innerHTML = '<p class="ins-empty">无对象。</p>'; return; }
  const CAP = 80; // 字母级下对象可达数百，截断防表格爆炸
  const shown = si.objects.slice(0, CAP);
  box.innerHTML = '<table class="so-tbl"><thead><tr><th>id</th><th>type</th><th>role</th><th>bbox</th><th>text</th><th>src</th></tr></thead><tbody>'
    + shown.map((o) => `<tr><td>${esc(o.id)}</td><td>${esc(o.type)}</td><td>${esc(o.role || '—')}</td><td>${o.bbox.map((n) => n.toFixed(3)).join(',')}</td><td>${esc((o.text || '').slice(0, 40) || '—')}</td><td>${esc(o.source)}</td></tr>`).join('')
    + '</tbody></table>'
    + (si.objects.length > CAP ? `<p class="ins-empty">…共 ${si.objects.length} 个对象，仅显示前 ${CAP}</p>` : '');
}

/** SurfaceIndex 概览：surface 类型 + 对象数 + type 分布（核对 step① 原生吐的对象表）。 */
function renderSurfaceSummary(): void {
  const el = document.getElementById('surface-summary');
  if (!el) return;
  const si = state.surfaceIndex;
  if (!si) { el.textContent = 'surface：未初始化'; return; }
  const dist = si.objects.reduce((acc, o) => { acc[o.type] = (acc[o.type] || 0) + 1; return acc; }, {} as Record<string, number>);
  const distStr = Object.entries(dist).map(([t, n]) => `${t}×${n}`).join(' · ') || '空';
  el.textContent = `surface：${si.surface_type} · ${si.objects.length} 个对象 · ${distStr}`;
}

function renderMetrics(): void {
  metricsBody.innerHTML = snapshot()
    .map((r) => `<tr><td>${r.label}</td><td>${r.last == null ? '–' : r.last + 'ms'}</td><td>${r.p50 == null ? '–' : r.p50 + 'ms'}</td></tr>`)
    .join('');
}

function runSelfTest(): void {
  const r = selfTest();
  if (!r.samples) {
    selftestEl.textContent = '坐标自测：等待页面渲染';
    selftestEl.dataset.ok = '';
    return;
  }
  selftestEl.textContent = `坐标自测：${r.ok ? '✓' : '✗'} ${r.samples}pts maxErr=${r.maxErr.toExponential(1)} @zoom ${Math.round(state.zoom * 100)}%`;
  selftestEl.dataset.ok = String(r.ok);
}

/**
 * 开发面板：从右侧抽屉改造为独立全屏页（hash 路由 #dev）。
 *  toggleDrawer 改写 location.hash 而非直接 hide/show —— 走浏览器路由，前进/后退也能切。
 *  hashchange 监听里再统一更新 drawer.hidden 和 body.dev-on。
 */
export function toggleDrawer(force?: boolean): void {
  const wantOn = force === undefined ? location.hash !== '#dev' : force;
  if (wantOn && location.hash !== '#dev') location.hash = 'dev';
  else if (!wantOn && location.hash === '#dev') history.replaceState(null, '', location.pathname + location.search);
  syncDevRoute();
}

function syncDevRoute(): void {
  if (!drawer) return;
  const on = location.hash === '#dev';
  drawer.hidden = !on;
  document.body.classList.toggle('dev-on', on);
}

/** AI 行为设置：各项独立绑定，改动即写回 settings 并广播 settings:changed。 */
function initSettings(): void {
  const $id = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const placement = $id<HTMLSelectElement>('set-placement');
  const reflow = $id<HTMLSelectElement>('set-reflow');
  const textlayer = $id<HTMLInputElement>('set-textlayer');
  const ocrImage = $id<HTMLSelectElement>('set-ocr-image');
  const ppReflowOn = $id<HTMLInputElement>('set-pp-reflow-on');
  const ppReflow = $id<HTMLInputElement>('set-pp-reflow');
  const ppDigestOn = $id<HTMLInputElement>('set-pp-digest-on');
  const ppDigest = $id<HTMLInputElement>('set-pp-digest');
  const gesture = $id<HTMLInputElement>('set-gesture');
  const gestureRouting = $id<HTMLSelectElement>('set-gesture-routing');
  const ctxLines = $id<HTMLInputElement>('set-ctx-lines');
  const pauseSec = $id<HTMLInputElement>('set-pause-sec');
  const inferModel = $id<HTMLSelectElement>('set-infer-model');
  const reflowModel = $id<HTMLSelectElement>('set-reflow-model');
  const sendImage = $id<HTMLInputElement>('set-send-image');
  const devOverlay = $id<HTMLInputElement>('set-dev-overlay');
  const showRegion = $id<HTMLInputElement>('set-show-region');
  const showRelations = $id<HTMLInputElement>('set-show-relations');

  // 从 settings 初始化控件
  placement.value = settings.placement;
  reflow.value = settings.reflowProvider;
  textlayer.checked = settings.ocr.textlayer;
  ocrImage.value = settings.ocr.image;
  ppReflowOn.checked = settings.preprocess.reflowEnabled;
  ppReflow.value = String(settings.preprocess.reflowPages);
  ppDigestOn.checked = settings.preprocess.digestEnabled;
  ppDigest.value = String(settings.preprocess.digestPages);
  gesture.checked = settings.gesture.enabled;
  gestureRouting.value = settings.gesture.routing;
  ctxLines.value = String(settings.gesture.contextLines);
  pauseSec.value = String(settings.gesture.pauseSeconds);
  inferModel.value = settings.inferModel;
  reflowModel.value = settings.reflowModel;
  sendImage.checked = settings.sendMarkImage;
  devOverlay.checked = settings.devOverlay;
  showRegion.checked = settings.showRegion;
  showRelations.checked = settings.showRelations;

  const changed = () => { bus.emit('settings:changed'); saveSettings(); };
  const clampPp = (el: HTMLInputElement, cur: number) => Math.min(100, Math.max(0, Number(el.value) || cur));
  placement.addEventListener('change', () => { settings.placement = placement.value as Placement; changed(); });
  reflow.addEventListener('change', () => { settings.reflowProvider = reflow.value; changed(); });
  reflowModel.addEventListener('change', () => { settings.reflowModel = reflowModel.value; changed(); }); // 换重排模型 → engineKey 变 → 当前页重排刷新（可 A/B）
  textlayer.addEventListener('change', () => { settings.ocr.textlayer = textlayer.checked; changed(); });
  ocrImage.addEventListener('change', () => { settings.ocr.image = ocrImage.value as OcrImageMode; changed(); });
  sendImage.addEventListener('change', () => { settings.sendMarkImage = sendImage.checked; changed(); });
  devOverlay.addEventListener('change', () => { settings.devOverlay = devOverlay.checked; changed(); });
  showRegion.addEventListener('change', () => { settings.showRegion = showRegion.checked; changed(); });
  showRelations.addEventListener('change', () => { settings.showRelations = showRelations.checked; changed(); });
  ppReflowOn.addEventListener('change', () => { settings.preprocess.reflowEnabled = ppReflowOn.checked; saveSettings(); });
  ppDigestOn.addEventListener('change', () => { settings.preprocess.digestEnabled = ppDigestOn.checked; saveSettings(); });
  ppReflow.addEventListener('change', () => { settings.preprocess.reflowPages = clampPp(ppReflow, settings.preprocess.reflowPages); ppReflow.value = String(settings.preprocess.reflowPages); saveSettings(); });
  ppDigest.addEventListener('change', () => { settings.preprocess.digestPages = clampPp(ppDigest, settings.preprocess.digestPages); ppDigest.value = String(settings.preprocess.digestPages); saveSettings(); });
  gesture.addEventListener('change', () => { settings.gesture.enabled = gesture.checked; changed(); });
  gestureRouting.addEventListener('change', () => { settings.gesture.routing = gestureRouting.value as 'auto' | 'geometric' | 'vlm'; changed(); });
  inferModel.addEventListener('change', () => { settings.inferModel = inferModel.value; changed(); });
  ctxLines.addEventListener('change', () => {
    const n = Math.min(10, Math.max(0, Number(ctxLines.value) || settings.gesture.contextLines));
    settings.gesture.contextLines = n;
    ctxLines.value = String(n);
    changed();
  });
  pauseSec.addEventListener('change', () => {
    const n = Math.min(30, Math.max(1, Number(pauseSec.value) || settings.gesture.pauseSeconds));
    settings.gesture.pauseSeconds = n;
    pauseSec.value = String(n);
    changed();
  });
}

export function initDevDrawer(els: {
  drawer: HTMLElement;
  inferSelect: HTMLSelectElement;
  metricsBody: HTMLElement;
  traceLog: HTMLElement;
  selftest: HTMLElement;
  downloadBtn: HTMLElement;
  closeBtn: HTMLElement;
}): void {
  drawer = els.drawer;
  traceLog = els.traceLog;
  metricsBody = els.metricsBody;
  selftestEl = els.selftest;

  initSettings();
  fillSelect(els.inferSelect, INFER_PROVIDER_LABELS, state.inferProvider);
  els.inferSelect.addEventListener('change', () => { state.inferProvider = els.inferSelect.value; });
  els.downloadBtn.addEventListener('click', () => downloadTrace());
  els.closeBtn.addEventListener('click', () => toggleDrawer(false));

  bus.on('metrics', renderMetrics);
  bus.on('inspect', renderInspect);
  bus.on('hmp:updated', renderHmpLog);
  bus.on('surface:indexed', () => { renderSurfaceSummary(); renderSurfaceObjects(); });
  bus.on('preprocess:progress', (i, n) => { const el = document.getElementById('pp-progress'); if (el) el.textContent = `预处理中 ${i as number}/${n as number} 页…`; });
  bus.on('preprocess:done', () => { const el = document.getElementById('pp-progress'); if (el) el.textContent = '预处理完成'; });
  bus.on('page:rendered', runSelfTest);
  bus.on('trace', (kind, obj) => {
    const o = obj as {
      trace_id?: string; event_id?: string; nearby_text?: string | null; content?: string;
      result_type?: string; source_refs?: Array<{ page_id?: string; ocr_block_ids?: string[] }>; recalled?: number[];
      strokes?: Array<{ type: string; score: number; raw?: { circle: number; underline: number; arrow: number } }>;
      threshold?: number; deliberate?: boolean; resolved?: string; route?: string; features?: string;
    };
    let txt = `${String(kind).padEnd(22)}${o.trace_id ?? o.event_id ?? ''}`;
    // 手势诊断：每会话原始分类 + 是否过门槛 + 解析出的手势
    if (kind === 'GestureSession' && o.strokes) {
      const lines = o.strokes.map((s, i) => {
        const r = s.raw;
        const detail = r ? ` (circle=${r.circle.toFixed(2)} underline=${r.underline.toFixed(2)} arrow=${r.arrow.toFixed(2)})` : '';
        return `   笔${i + 1}: ${s.type} · 分${s.score}${detail}`;
      }).join('\n');
      const tail = o.route
        ? `档=${o.route}${o.features ? ' · ' + o.features : ''}`
        : (o.threshold !== undefined ? `门槛=${o.threshold} · 过=${o.deliberate ? '是' : '否'}` : '');
      txt += `\n${lines}\n   ${tail}${tail ? ' → ' : ''}${o.resolved ?? ''}`;
    }
    // 请求：AI 看到/引用了哪些内容（圈住的原文）
    if (o.nearby_text) txt += `\n   ⟵引用上下文: ${String(o.nearby_text).replace(/\n/g, ' ').slice(0, 90)}`;
    // 结果：AI 回复 + 指回的来源（页 · 命中块数）+ 跨页回看了哪些页
    if (o.content && o.source_refs) {
      const refs = o.source_refs.map((r) => `${r.page_id ?? '?'}${r.ocr_block_ids?.length ? `·${r.ocr_block_ids.length}块` : ''}`).join(' ');
      const rc = o.recalled?.length ? `  ·回看[${o.recalled.join(',')}页]` : '';
      txt += `\n   ↳[${o.result_type ?? ''}] "${String(o.content).slice(0, 36)}" ⟵ ${refs}${rc}`;
    }
    const line = document.createElement('div');
    line.textContent = txt;
    traceLog.appendChild(line);
    traceLog.scrollTop = traceLog.scrollHeight;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'd' && !(e.target as HTMLElement)?.isContentEditable
      && !['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName ?? '')) {
      toggleDrawer();
    }
  });

  // 路由：?dev=1 兼容（导到 #dev）；hashchange 同步显示
  if (new URLSearchParams(location.search).get('dev') === '1' && location.hash !== '#dev') {
    history.replaceState(null, '', location.pathname + '#dev');
  }
  window.addEventListener('hashchange', syncDevRoute);
  syncDevRoute();
  renderMetrics();
  renderInspect();
  renderHmpLog();
  renderSurfaceSummary();
  renderSurfaceObjects();
  runSelfTest();
}
