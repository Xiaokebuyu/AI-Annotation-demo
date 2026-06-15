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

export function initWhisper(whisperLayer: HTMLElement): void {
  layer = whisperLayer;
  bus.on('overlay:add', (o) => add(o as ScreenOverlay));
  bus.on('overlay:remove', (id) => remove(id as string));
  bus.on('overlay:state', (o) => {
    const ov = o as ScreenOverlay;
    const el = els.get(ov.overlay_id);
    if (el) el.dataset.state = ov.state;
    relayout();
  });
  bus.on('page:rendered', () => {
    // 持久化恢复的 overlays 在 state 里但还没 DOM → 当前页的补上
    for (const o of state.overlays) if (o.page_id === state.pageId && !els.has(o.overlay_id)) add(o);
    relayout();
  });
  bus.on('settings:changed', relayout);
  bus.on('whisper:reveal', (overlayId) => {
    const el = els.get(overlayId as string);
    if (!el || el.style.display === 'none') return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('reveal');
    setTimeout(() => el.classList.remove('reveal'), 1000);
  });
}
