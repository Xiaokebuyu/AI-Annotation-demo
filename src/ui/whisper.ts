import type { ScreenOverlay } from '../core/contracts';
import { normToPx, pageCss } from '../core/transform';
import { bus, state } from '../app/state';

/**
 * 旁注低语 —— 贴在标注旁、低打扰的文字注释（非卡片）。
 * 停笔后整段交付，逐句淡入（电子纸不逐字流式）。
 * 单击展开操作（接受/编辑/暂不），不点则只是静静陪着。
 */

const WHISPER_W = 230; // 估算宽度，用于左右翻转判定
let layer: HTMLElement;
const els = new Map<string, HTMLElement>();

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?…])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function place(o: ScreenOverlay, el: HTMLElement): void {
  if (o.page_id !== state.pageId || o.state === 'dismissed') {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const [x, y, w, h] = o.geometry.anchor_bbox;
  const topLeft = normToPx(x, y);
  const right = normToPx(x + w, y);
  const bottom = normToPx(x, y + h);

  // 默认贴右侧；右侧放不下则翻到左侧；再放不下落到下方
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
  place(o, el);
}

export function initWhisper(whisperLayer: HTMLElement): void {
  layer = whisperLayer;
  bus.on('overlay:add', (o) => add(o as ScreenOverlay));
  bus.on('overlay:state', (o) => {
    const ov = o as ScreenOverlay;
    const el = els.get(ov.overlay_id);
    if (el) { el.dataset.state = ov.state; place(ov, el); }
  });
  bus.on('page:rendered', () => state.overlays.forEach((o) => {
    const el = els.get(o.overlay_id);
    if (el) place(o, el);
  }));
  bus.on('whisper:reveal', (overlayId) => {
    const el = els.get(overlayId as string);
    if (!el || el.style.display === 'none') return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('reveal');
    setTimeout(() => el.classList.remove('reveal'), 1000);
  });
}
