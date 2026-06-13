import type { ScreenOverlay } from '../core/contracts';
import { bus, state } from '../app/state';

/**
 * 侧栏 = 本页洞察历史（只读）。默认隐藏，按钮拉出。
 * 操作权（收下/改写/散去）归旁注低语；这里仅反映状态、提供回看与定位。
 */

const TYPE_LABEL: Record<string, string> = {
  question: '问', note: '思', link: '联', suggestion_card: '提', highlight: '注',
};

let cardsEl: HTMLElement;
let footEl: HTMLElement;
let countEl: HTMLElement;
const cardEls = new Map<string, HTMLElement>();

function refreshFoot(): void {
  const total = state.overlays.length;
  const kept = state.overlays.filter((o) => o.state === 'accepted' || o.state === 'edited').length;
  const dismissed = state.overlays.filter((o) => o.state === 'dismissed').length;
  countEl.textContent = total ? String(total) : '';
  footEl.textContent = total
    ? `收下 ${kept} · 散去 ${dismissed} · 共 ${total}（沉淀率 ${Math.round((kept / total) * 100)}%）`
    : '';
}

function add(o: ScreenOverlay): void {
  const item = document.createElement('article');
  item.className = 'hist' + (o.result_type === 'error' ? ' error' : '');
  item.dataset.state = o.state;
  item.innerHTML =
    `<span class="hist-tag">${TYPE_LABEL[o.overlay_type] ?? '思'}</span>` +
    `<div class="hist-body">${o.display_text}</div>` +
    `<div class="hist-page">第 ${state.pageIndex + 1} 页 · ${o.result_id}</div>`;
  item.addEventListener('mouseenter', () => bus.emit('whisper:reveal', o.overlay_id));
  cardEls.set(o.overlay_id, item);

  const empty = cardsEl.querySelector('.empty-hint');
  if (empty) empty.remove();
  cardsEl.prepend(item);
  refreshFoot();
}

export function initInsightPanel(els: { cards: HTMLElement; foot: HTMLElement; count: HTMLElement }): void {
  cardsEl = els.cards;
  footEl = els.foot;
  countEl = els.count;
  bus.on('overlay:add', (o) => add(o as ScreenOverlay));
  bus.on('overlay:state', (o) => {
    const ov = o as ScreenOverlay;
    const item = cardEls.get(ov.overlay_id);
    if (item) item.dataset.state = ov.state;
    refreshFoot();
  });
}
