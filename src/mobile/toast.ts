/**
 * 全局非阻断提醒（跨屏幕：阅读页/dev页/会中都能看到）—— 区别于 sheet.ts 的阻断式弹窗。
 * 挂到 mobile.html 预置的固定容器 `#m-toast-root`（运行时只切 hidden / 改 innerHTML，
 * 不 append 到 body），避免触发 eink.ts 的整屏 GC16 刷新，只走小区域 A2/局部刷新。
 */
import { esc } from '../core/escape';
import { signalElementArea } from '../surface/eink';

export interface MobileToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface MobileToastOptions {
  id?: string;                          // 去重/主动 dismiss 用，如 `meeting-live:${meetingId}`
  title: string;
  message?: string;
  action?: MobileToastAction;
  durationMs?: number | 'sticky';        // 默认 8000ms；'sticky' = 不自动消失，等用户操作/主动 dismiss
  level?: 'info' | 'urgent';
}

interface LiveToast extends MobileToastOptions { id: string; timer?: number; }

const live = new Map<string, LiveToast>();
let seq = 0;

function root(): HTMLElement | null { return document.getElementById('m-toast-root'); }

function render(): void {
  const r = root();
  if (!r) return;
  const items = [...live.values()];
  r.hidden = items.length === 0;
  r.innerHTML = items.map((t) => (
    `<div class="m-toast" data-toast-id="${esc(t.id)}">`
    + `<div class="m-toast-body">`
    + `<div class="m-toast-title">${esc(t.title)}</div>`
    + (t.message ? `<div class="m-toast-msg">${esc(t.message)}</div>` : '')
    + `</div>`
    + `<div class="m-toast-ft">`
    + (t.action ? `<button class="hbtn pri" data-toast-action type="button">${esc(t.action.label)}</button>` : '')
    + `<button class="hbtn" data-toast-close type="button">知道了</button>`
    + `</div></div>`
  )).join('');
  for (const t of items) {
    const el = r.querySelector<HTMLElement>(`[data-toast-id="${CSS.escape(t.id)}"]`);
    if (!el) continue;
    el.querySelector('[data-toast-action]')?.addEventListener('click', () => { void t.action?.run(); dismissMobileToast(t.id); });
    el.querySelector('[data-toast-close]')?.addEventListener('click', () => dismissMobileToast(t.id));
  }
  signalElementArea(r);
}

/** 显示一条全局提示。同 id 已存在时替换内容+重置计时器（不叠加）。 */
export function showMobileToast(opts: MobileToastOptions): void {
  const id = opts.id ?? `toast-${++seq}`;
  const prev = live.get(id);
  if (prev?.timer) window.clearTimeout(prev.timer);
  const t: LiveToast = { ...opts, id };
  const duration = opts.durationMs ?? 8000;
  if (duration !== 'sticky') t.timer = window.setTimeout(() => dismissMobileToast(id), duration);
  live.set(id, t);
  render();
}

/** 关掉一条提示；不传 id 则清空全部（如切出登录态等场景）。 */
export function dismissMobileToast(id?: string): void {
  if (id === undefined) {
    for (const t of live.values()) if (t.timer) window.clearTimeout(t.timer);
    live.clear();
  } else {
    const t = live.get(id);
    if (!t) return;
    if (t.timer) window.clearTimeout(t.timer);
    live.delete(id);
  }
  render();
}
