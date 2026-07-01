import type { NormBBox } from '../core/contracts';
import { normToPx, pageCss, GUTTER_PAD } from '../core/transform';
import { bus, state } from '../app/state';

/**
 * 锚点落位层（v3 优先①）—— 把 AI 输出按 **HMP 锚点** 精准画回原页。
 *
 * 设计取向（关键）：模型只 **引用** 已存在的对象（SurfaceIndex object id / HMP target_object_refs），
 * 绝不让它吐坐标（吐坐标必幻觉）。本层负责 ref → 本页归一化 bbox → 屏幕像素 的解析与渲染，
 * 并保留"点回原页"的溯源（点注 → 闪烁锚点区域）。chat/ 面板（P4）产出 {anchor_refs, text, kind} 经
 * bus('anchor:place') 驱动本层；本层对生产者无依赖。
 */

export type AnchorKind = 'note' | 'margin' | 'highlight' | 'link';
export interface AnchorTarget { pageId: string; anchorRefs?: string[]; bbox?: NormBBox; }
export interface AnchorContent extends AnchorTarget { id: string; text: string; kind?: AnchorKind; }

/** 锚点（对象引用 / 直给 bbox）→ 本页归一化 bbox。引用走 SurfaceIndex 取命中对象的并集。 */
export function resolveAnchorBBox(t: AnchorTarget): NormBBox | null {
  const refs = t.anchorRefs ?? [];
  const objs = state.surfaceIndex?.objects ?? [];
  if (refs.length && objs.length) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0, hit = 0;
    for (const id of refs) {
      const o = objs.find((x) => x.id === id);
      if (!o) continue;
      hit++;
      const [x, y, w, h] = o.bbox;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
    }
    if (hit) return [x0, y0, x1 - x0, y1 - y0];
  }
  return t.bbox ?? null;
}

let layer: HTMLElement | null = null;
interface Item { el: HTMLElement; pageId: string; bbox: NormBBox; kind: AnchorKind; }
const items = new Map<string, Item>();
const NOTE_W = 230;

/** inline / link：贴锚点右侧，放不下翻左，再放不下落到下方。margin：右侧留白按 y 对齐。 */
function position(el: HTMLElement, bbox: NormBBox, kind: AnchorKind): void {
  const [x, y, w, h] = bbox;
  if (kind === 'margin') {
    el.style.left = `${pageCss.w + GUTTER_PAD}px`;
    el.style.top = `${normToPx(0, y).y}px`;
    el.style.removeProperty('right');
    return;
  }
  const tl = normToPx(x, y);
  const right = normToPx(x + w, y);
  const bottom = normToPx(x, y + h);
  if (right.x + 12 + NOTE_W <= pageCss.w) { el.style.left = `${right.x + 12}px`; el.style.top = `${tl.y}px`; }
  else if (tl.x - 12 - NOTE_W >= 0) { el.style.left = `${tl.x - 12 - NOTE_W}px`; el.style.top = `${tl.y}px`; }
  else { el.style.left = `${tl.x}px`; el.style.top = `${bottom.y + 8}px`; }
}

/** 溯源：点注 → 在锚点区域闪一道高亮（"这句对应原文这里"）。 */
function flashAnchor(bbox: NormBBox): void {
  if (!layer) return;
  const [x, y, w, h] = bbox;
  const p = normToPx(x, y);
  const flash = document.createElement('div');
  flash.className = 'anchor-flash';
  flash.style.cssText = `position:absolute;left:${p.x}px;top:${p.y}px;width:${w * pageCss.w}px;height:${h * pageCss.h}px;`
    + 'background:rgba(47,107,115,.22);outline:1.5px solid rgba(47,107,115,.7);border-radius:3px;pointer-events:none;transition:opacity .6s;';
  layer.appendChild(flash);
  requestAnimationFrame(() => { flash.style.opacity = '0'; });
  setTimeout(() => flash.remove(), 700);
}

/** 落一条锚定内容。不在当前页则只记录、不画（翻回该页 page:rendered 时补画）。 */
export function placeAnchor(c: AnchorContent): void {
  if (!layer) return;
  const bbox = resolveAnchorBBox(c);
  if (!bbox) return;
  const kind = c.kind ?? 'note';
  let it = items.get(c.id);
  if (!it) {
    const el = document.createElement('div');
    el.className = 'anchor-note';
    el.style.position = 'absolute';
    el.style.pointerEvents = 'auto';
    el.style.maxWidth = `${NOTE_W}px`;
    layer.appendChild(el);
    it = { el, pageId: c.pageId, bbox, kind };
    items.set(c.id, it);
  }
  it.pageId = c.pageId; it.bbox = bbox; it.kind = kind;
  it.el.dataset.kind = kind;
  it.el.dataset.pending = /思考中|处理中|生成中/.test(c.text) ? '1' : '0';
  it.el.textContent = c.text;
  it.el.title = '点击：定位回原文';
  it.el.onclick = () => flashAnchor(bbox);
  relayout();
}

export function clearAnchor(id?: string): void {
  if (id) { items.get(id)?.el.remove(); items.delete(id); return; }
  for (const it of items.values()) it.el.remove();
  items.clear();
}

/** 翻页/缩放后重定位：仅显示当前页的锚注，按像素重算坐标。 */
function relayout(): void {
  for (const it of items.values()) {
    if (it.pageId !== state.pageId) { it.el.style.display = 'none'; continue; }
    it.el.style.display = '';
    position(it.el, it.bbox, it.kind);
  }
}

export function initAnchorLayer(host: HTMLElement): void {
  layer = document.createElement('div');
  layer.id = 'anchor-layer';
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;';
  host.appendChild(layer);
  bus.on('anchor:place', (c) => placeAnchor(c as AnchorContent));
  bus.on('anchor:clear', (id) => clearAnchor(id as string | undefined));
  bus.on('page:rendered', relayout);
}
