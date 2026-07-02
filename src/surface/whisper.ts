import type { ScreenOverlay } from '../core/contracts';
import { normToPx, pageCss, GUTTER_PAD } from '../core/transform';
import { bus, state, settings } from '../app/state';

/**
 * AI 输出的屏上呈现。两种落点（settings.placement，可随时切换）：
 *  - margin：右侧留白。按标注 y 对齐，多条自动下推防重叠（综述/对话的默认落点）。
 *  - inline：贴正文浮动（原旁注低语行为）。贴标注旁，放不下则翻面/落下。
 * 停笔后整段交付、逐句淡入（电子纸不逐字流式）；hover 才显操作（接受/编辑/暂不）。
 */

const GUTTER_GAP_Y = 16; // 留白内卡片纵向间距
let layer: HTMLElement;
const els = new Map<string, HTMLElement>();

// 折叠模式（Phase F·电纸屏日记/白板）：AI 旁注不再常显成卡片，而是在锚点放一个点触标记，
// 点开才弹浮层（文本 + 收下/改写/散去）——和 reader 重排面的 replyMode 体验一致。
// 桌面/原版页 folded=false，保持原 margin/inline 卡片行为（零回归）。
let folded = false;
let popEl: HTMLElement | null = null;
let backdropEl: HTMLElement | null = null;
function closePop(): void { popEl?.remove(); popEl = null; backdropEl?.remove(); backdropEl = null; }

function dropEl(id: string): void {
  const el = els.get(id);
  if (el) { el.remove(); els.delete(id); }
}
/** 清掉已脱离 state.overlays 的孤儿 DOM——换页/换日记时 renderer 会把 state.overlays 换掉但不发 overlay:remove，
 *  旧页的旁注/星标 DOM 会漏在 layer 上残留（尤其电纸屏日记折叠星标·用户实测"星星持久钉死"）。 */
function pruneOrphanEls(): void {
  const liveIds = new Set(state.overlays.map((o) => o.overlay_id));
  for (const id of [...els.keys()]) if (!liveIds.has(id)) dropEl(id);
}

/** 状态机（收下/改写/散去）单一来源：改 state[+改写文本] → emit overlay:state（annotation-loop 落账本）。 */
function setOverlayState(o: ScreenOverlay, el: HTMLElement | undefined, next: ScreenOverlay['state'], newText?: string): void {
  if (o.state !== 'shown' && !(o.state === 'accepted' && next === 'edited')) return;
  if (newText != null) o.display_text = newText;
  o.state = next;
  if (el) el.dataset.state = next;
  bus.emit('overlay:state', o);
}

/** 点折叠标记 → 弹浮层（☆回复 + 收下/改写/散去）·定位标记下方、夹进画布。 */
function openPop(o: ScreenOverlay): void {
  closePop();
  // 背板：浮层开着时铺一层（pointer-events:auto·#whisper-layer 本身 none），点空白处收起浮层（layer none 时收不到 tap）。
  const bd = document.createElement('div');
  bd.className = 'whisper-pop-backdrop';
  bd.addEventListener('pointerdown', () => closePop());
  layer.appendChild(bd);
  backdropEl = bd;
  const mark = els.get(o.overlay_id);
  const pop = document.createElement('div');
  pop.className = 'whisper-pop';
  const body = document.createElement('div'); body.className = 'whisper-pop-text'; body.textContent = o.display_text;
  pop.appendChild(body);
  const acts = document.createElement('div'); acts.className = 'whisper-pop-acts';
  const mk = (label: string, fn: () => void): void => {
    const b = document.createElement('button'); b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    acts.appendChild(b);
  };
  mk('收下', () => { setOverlayState(o, mark, 'accepted'); closePop(); });
  mk('改写', () => {
    if (body.isContentEditable) { body.contentEditable = 'false'; setOverlayState(o, mark, 'edited', body.textContent ?? ''); closePop(); }
    else { body.contentEditable = 'true'; body.focus(); }
  });
  mk('散去', () => { setOverlayState(o, mark, 'dismissed'); closePop(); });
  pop.appendChild(acts);
  pop.addEventListener('pointerdown', (e) => e.stopPropagation()); // 浮层内点按不冒泡触发外层关闭
  layer.appendChild(pop);
  popEl = pop;
  const [x, y, w, h] = o.geometry.anchor_bbox;
  const p = normToPx(x, y + h);
  pop.style.left = `${Math.max(6, Math.min(p.x, pageCss.w - 244))}px`;
  pop.style.top = `${p.y + 8}px`;
}

/** 折叠标记：只给「当前页未处理(shown)回复」放点触星标——它是"这页有条待处理 AI 回复"的入口，不是历史钉。
 *  收下/改写/散去后 state 变→layoutMarkers 会清掉它；恢复已处理的 overlay 也不再钉星（账本/洞察历史仍在）。 */
function addMarker(o: ScreenOverlay): void {
  if (o.page_id !== state.pageId || o.state !== 'shown') return;
  const el = document.createElement('div');
  el.className = 'whisper-mark' + (o.result_type === 'error' ? ' error' : '');
  el.dataset.overlay = o.overlay_id;
  el.dataset.state = o.state;
  el.addEventListener('click', (e) => { e.stopPropagation(); openPop(o); });
  layer.appendChild(el);
  els.set(o.overlay_id, el);
  relayout();
}

/** 折叠模式排版：遍历现有星标 DOM，只保留「当前页未处理(shown)」的贴锚点；已收下/改写/散去、非当前页、
 *  已脱离 state 的一律**清掉 DOM**（旧版只 display:none·处理后仍钉在页上→用户实测"星星持久留下"的根因）。 */
function layoutMarkers(): void {
  const byId = new Map(state.overlays.map((o) => [o.overlay_id, o] as const));
  for (const id of [...els.keys()]) {
    const o = byId.get(id);
    if (!o || o.page_id !== state.pageId || o.state !== 'shown') { dropEl(id); continue; }
    const el = els.get(id)!;
    el.style.display = '';
    const [x, y] = o.geometry.anchor_bbox;
    const p = normToPx(x, y);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
  }
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?…])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** inline：贴标注旁。默认右侧；右放不下翻左；再放不下落到下方。 */
function placeInline(o: ScreenOverlay, el: HTMLElement): void {
  el.classList.remove('gutter');
  const [x, y, w, h] = o.geometry.anchor_bbox;
  const topLeft = normToPx(x, y);
  const right = normToPx(x + w, y);
  const bottom = normToPx(x, y + h);
  const WHISPER_W = 230;
  if (right.x + 12 + WHISPER_W <= pageCss.w) {
    el.classList.remove('left');
    el.style.left = `${right.x + 12}px`;
    el.style.top = `${topLeft.y}px`;
    el.style.removeProperty('right');
  } else if (topLeft.x - 12 - WHISPER_W >= 0) {
    el.classList.add('left');
    el.style.left = `${topLeft.x - 12 - WHISPER_W}px`;
    el.style.top = `${topLeft.y}px`;
  } else {
    el.classList.remove('left');
    el.style.left = `${topLeft.x}px`;
    el.style.top = `${bottom.y + 8}px`;
  }
}

/** margin：留白内，按 anchor y 排序后自上而下堆叠，遇重叠则下推。 */
function layoutGutter(items: ScreenOverlay[]): void {
  const x = pageCss.w + GUTTER_PAD;
  let cursor = 8;
  for (const o of items) {
    const el = els.get(o.overlay_id)!;
    el.classList.add('gutter');
    el.classList.remove('left');
    el.style.removeProperty('right');
    el.style.left = `${x}px`;
    const anchorY = normToPx(0, o.geometry.anchor_bbox[1]).y;
    const top = Math.max(anchorY, cursor);
    el.style.top = `${top}px`;
    cursor = top + el.offsetHeight + GUTTER_GAP_Y;
  }
}

/** 统一重排：先定可见性，再按落点排版。任何位置/状态/页面/设置变化都走这里。 */
function relayout(): void {
  pruneOrphanEls(); // 先清换页/换日记后脱离 state 的孤儿 DOM（两种落点共用）
  if (folded) { layoutMarkers(); return; } // 折叠模式：标记贴锚点
  const live: ScreenOverlay[] = [];
  for (const o of state.overlays) {
    const el = els.get(o.overlay_id);
    if (!el) continue;
    if (o.page_id !== state.pageId || o.state === 'dismissed') {
      el.style.display = 'none';
    } else {
      el.style.display = '';
      live.push(o);
    }
  }
  if (settings.placement === 'margin') {
    live.sort((a, b) => a.geometry.anchor_bbox[1] - b.geometry.anchor_bbox[1]);
    layoutGutter(live);
  } else {
    for (const o of live) placeInline(o, els.get(o.overlay_id)!);
  }
}

function add(o: ScreenOverlay): void {
  if (folded) { addMarker(o); return; } // 电纸屏日记：折叠成点触标记
  const el = document.createElement('div');
  el.className = 'whisper' + (o.result_type === 'error' ? ' error' : '');
  el.dataset.overlay = o.overlay_id;

  const body = document.createElement('div');
  body.className = 'whisper-text';
  el.appendChild(body);

  // 逐句淡入
  const sentences = splitSentences(o.display_text);
  sentences.forEach((s, i) => {
    const span = document.createElement('span');
    span.className = 'w-sentence';
    span.textContent = s;
    body.appendChild(span);
    setTimeout(() => span.classList.add('show'), 80 + i * 480);
  });

  // 操作条，hover/点击才显形（默认隐身，不打扰）
  const acts = document.createElement('div');
  acts.className = 'whisper-acts';
  const mkBtn = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  };
  const setState = (next: ScreenOverlay['state']) => {
    if (o.state !== 'shown' && !(o.state === 'accepted' && next === 'edited')) return;
    o.state = next;
    el.dataset.state = next;
    bus.emit('overlay:state', o);
  };
  acts.append(
    mkBtn('收下', () => setState('accepted')),
    mkBtn('改写', () => {
      if (body.isContentEditable) {
        body.contentEditable = 'false';
        o.display_text = body.textContent ?? '';
        setState('edited');
      } else {
        body.contentEditable = 'true';
        body.focus();
      }
    }),
    mkBtn('散去', () => setState('dismissed')),
  );
  el.appendChild(acts);

  el.addEventListener('mouseenter', () => bus.emit('whisper:focus', o.overlay_id));
  layer.appendChild(el);
  els.set(o.overlay_id, el);
  relayout();
}

function remove(overlayId: string): void {
  const el = els.get(overlayId);
  if (el) { el.remove(); els.delete(overlayId); }
  relayout();
}

export function initWhisper(whisperLayer: HTMLElement, opts: { fold?: boolean } = {}): void {
  layer = whisperLayer;
  folded = !!opts.fold; // 移动版电纸屏传 true：AI 旁注折叠成点触标记
  bus.on('overlay:add', (o) => add(o as ScreenOverlay));
  bus.on('overlay:remove', (id) => { if (folded) closePop(); remove(id as string); });
  bus.on('overlay:state', (o) => {
    const ov = o as ScreenOverlay;
    if (folded && ov.state !== 'shown') closePop(); // 折叠面：处理后关掉浮层（relayout 会连星标一起清）
    const el = els.get(ov.overlay_id);
    if (el) el.dataset.state = ov.state;
    relayout();
  });
  bus.on('page:rendered', () => {
    if (folded) closePop(); // 翻页/重渲：关掉残留浮层（锚已变）
    // 持久化恢复的 overlays 在 state 里但还没 DOM → 当前页的补上
    for (const o of state.overlays) if (o.page_id === state.pageId && !els.has(o.overlay_id)) add(o);
    relayout();
  });
  bus.on('settings:changed', relayout);
  bus.on('whisper:reveal', (overlayId) => {
    const el = els.get(overlayId as string);
    if (!el || el.style.display === 'none') return;
    el.scrollIntoView({ block: 'center', behavior: document.body.classList.contains('eink-shell') ? 'auto' : 'smooth' }); // 电纸屏壳禁平滑滚动（残影）·CSS scroll-behavior 管不到 scrollIntoView 的 behavior 选项故在此判；桌面无 eink-shell 行为不变
    el.classList.add('reveal');
    setTimeout(() => el.classList.remove('reveal'), 1000);
  });
}
