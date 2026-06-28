/**
 * 移动版（电纸屏）底部浮层 sheet —— 替代 window.prompt/alert/confirm 的原生弹窗。
 * reMarkable 黑白语言：白底卡片从底部滑入、上方 .scrim 半透明遮罩，点遮罩 / 取消 / Esc = 关闭。
 * 全部返回 Promise，调用处 await 即可（替原来同步 prompt 的写法）。
 *
 * 四个 API：infoSheet（替 alert）/ promptSheet（单输入）/ formSheet（多字段）/ pickSheet（多选列表）。
 */
import { esc } from '../core/escape';

interface SheetHandle {
  scrim: HTMLDivElement;
  body: HTMLDivElement;
  footOk: HTMLButtonElement;
  close: () => void;
}

/** 挂载一个 sheet 骨架，返回容器引用 + 关闭函数（带退场动画后移除 DOM）。 */
function mountSheet(titleHtml: string, bodyHtml: string, okText: string | null): SheetHandle {
  const scrim = document.createElement('div');
  scrim.className = 'msheet-scrim';
  scrim.innerHTML =
    `<div class="msheet" role="dialog" aria-modal="true">`
    + `<div class="msheet-grip"></div>`
    + (titleHtml ? `<div class="msheet-h">${titleHtml}</div>` : '')
    + `<div class="msheet-bd"></div>`
    + `<div class="msheet-ft">`
    + (okText === null ? '' : `<button class="hbtn" data-cancel type="button">取消</button>`)
    + `<button class="hbtn pri" data-ok type="button">${esc(okText ?? '知道了')}</button>`
    + `</div></div>`;
  const body = scrim.querySelector('.msheet-bd') as HTMLDivElement;
  body.innerHTML = bodyHtml;
  document.body.appendChild(scrim);
  // 下一帧加 open 触发滑入动画
  requestAnimationFrame(() => scrim.classList.add('open'));

  const close = (): void => {
    scrim.classList.remove('open');
    window.setTimeout(() => scrim.remove(), 160);
    document.removeEventListener('keydown', onKey);
  };
  // Esc=触发「取消/知道了」按钮同一条已绑路径（那条才 resolve Promise）。
  // 直接 close 会关 DOM 但让调用方的 await 永挂——务必走按钮 click 复用其 resolve。
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    const dismiss = scrim.querySelector<HTMLButtonElement>('[data-cancel]') ?? scrim.querySelector<HTMLButtonElement>('[data-ok]');
    dismiss?.click();
  };
  document.addEventListener('keydown', onKey);

  return { scrim, body, footOk: scrim.querySelector('[data-ok]') as HTMLButtonElement, close };
}

/** 通用：绑定 取消/确定/点遮罩=取消。onOk 返回 false 可阻止关闭（校验失败时）。 */
function wire(h: SheetHandle, onCancel: () => void, onOk: () => boolean | void): void {
  h.scrim.querySelector('[data-cancel]')?.addEventListener('click', () => { h.close(); onCancel(); });
  h.scrim.addEventListener('mousedown', (e) => { if (e.target === h.scrim) { h.close(); onCancel(); } });
  h.footOk.addEventListener('click', () => { if (onOk() !== false) h.close(); });
}

/** 信息提示（替 window.alert）。单按钮（okText=null→不渲染取消钮、确定钮默认「知道了」），点遮罩/确定/Esc 都关。 */
export function infoSheet(opts: { title?: string; message: string }): Promise<void> {
  return new Promise((resolve) => {
    const h = mountSheet(opts.title ? esc(opts.title) : '', `<p class="msheet-msg">${esc(opts.message)}</p>`, null);
    const done = (): void => resolve();
    h.scrim.querySelector('[data-ok]')?.addEventListener('click', () => { h.close(); done(); });
    h.scrim.addEventListener('mousedown', (e) => { if (e.target === h.scrim) { h.close(); done(); } });
  });
}

/** 确认对话（取消/确定）。返回 true=确认、false=取消/遮罩/Esc。用于删除等不可逆操作二次确认。 */
export function confirmSheet(opts: { title?: string; message: string; confirm?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const h = mountSheet(opts.title ? esc(opts.title) : '', `<p class="msheet-msg">${esc(opts.message)}</p>`, opts.confirm ?? '确定');
    wire(h, () => resolve(false), () => { resolve(true); });
  });
}

/** 单行文本输入（替 window.prompt）。返回值字符串；取消返回 null。 */
export function promptSheet(opts: { title: string; placeholder?: string; value?: string; confirm?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const h = mountSheet(esc(opts.title),
      `<input class="msheet-in" type="text" value="${esc(opts.value ?? '')}" placeholder="${esc(opts.placeholder ?? '')}" />`,
      opts.confirm ?? '确定');
    const input = h.body.querySelector('.msheet-in') as HTMLInputElement;
    const submit = (): void => { h.close(); resolve(input.value.trim()); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    wire(h, () => resolve(null), () => { submit(); return false; }); // submit 自己 close，return false 防重复
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}

/** 多字段表单（如 会议标题 + 计划时间）。返回 key→值；取消返回 null。 */
export function formSheet(opts: {
  title: string;
  fields: Array<{ key: string; label: string; placeholder?: string; value?: string }>;
  confirm?: string;
}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const rows = opts.fields.map((f) =>
      `<label class="msheet-field"><span class="msheet-lab">${esc(f.label)}</span>`
      + `<input class="msheet-in" data-key="${esc(f.key)}" type="text" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" /></label>`
    ).join('');
    const h = mountSheet(esc(opts.title), rows, opts.confirm ?? '确定');
    const inputs = [...h.body.querySelectorAll<HTMLInputElement>('.msheet-in')];
    const collect = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const i of inputs) out[i.dataset.key || ''] = i.value.trim();
      return out;
    };
    wire(h, () => resolve(null), () => { resolve(collect()); });
    inputs.forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && i === inputs[inputs.length - 1]) { resolve(collect()); h.close(); } }));
    requestAnimationFrame(() => { inputs[0]?.focus(); inputs[0]?.select(); });
  });
}

/** 多选列表（如 添加资料）。返回选中的 id[]；取消返回 null。空列表时只显提示。 */
export function pickSheet(opts: {
  title: string;
  items: Array<{ id: string; label: string; sub?: string }>;
  confirm?: string;
  empty?: string;
}): Promise<string[] | null> {
  return new Promise((resolve) => {
    if (!opts.items.length) {
      const h = mountSheet(esc(opts.title), `<p class="msheet-msg">${esc(opts.empty ?? '没有可选项。')}</p>`, null);
      h.scrim.querySelector('[data-ok]')?.addEventListener('click', () => { h.close(); resolve(null); });
      h.scrim.addEventListener('mousedown', (e) => { if (e.target === h.scrim) { h.close(); resolve(null); } });
      return;
    }
    const rows = opts.items.map((it) =>
      `<div class="msheet-pick" data-id="${esc(it.id)}"><span class="msheet-box"></span>`
      + `<span class="msheet-pl"><span class="msheet-pt">${esc(it.label)}</span>${it.sub ? `<span class="msheet-ps">${esc(it.sub)}</span>` : ''}</span></div>`
    ).join('');
    const h = mountSheet(esc(opts.title), `<div class="msheet-picks">${rows}</div>`, opts.confirm ?? '添加');
    const picked = new Set<string>();
    const syncOk = (): void => { h.footOk.textContent = picked.size ? `${opts.confirm ?? '添加'} (${picked.size})` : (opts.confirm ?? '添加'); };
    h.body.querySelectorAll<HTMLElement>('.msheet-pick').forEach((row) => row.addEventListener('click', () => {
      const id = row.dataset.id || '';
      if (picked.has(id)) { picked.delete(id); row.classList.remove('on'); } else { picked.add(id); row.classList.add('on'); }
      syncOk();
    }));
    wire(h, () => resolve(null), () => { resolve([...picked]); });
  });
}

/** 单选列表（radio 语义·替 pickSheet 多选）。默认选中 defaultId（如"推荐"项）。确认返回选中 id，取消/空返回 null。 */
export function pickOneSheet(opts: {
  title: string;
  items: Array<{ id: string; label: string; sub?: string }>;
  defaultId?: string;
  confirm?: string;
  empty?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    if (!opts.items.length) {
      const h = mountSheet(esc(opts.title), `<p class="msheet-msg">${esc(opts.empty ?? '没有可选项。')}</p>`, null);
      h.scrim.querySelector('[data-ok]')?.addEventListener('click', () => { h.close(); resolve(null); });
      h.scrim.addEventListener('mousedown', (e) => { if (e.target === h.scrim) { h.close(); resolve(null); } });
      return;
    }
    const rows = opts.items.map((it) =>
      `<div class="msheet-pick" data-id="${esc(it.id)}"><span class="msheet-box"></span>`
      + `<span class="msheet-pl"><span class="msheet-pt">${esc(it.label)}</span>${it.sub ? `<span class="msheet-ps">${esc(it.sub)}</span>` : ''}</span></div>`
    ).join('');
    const h = mountSheet(esc(opts.title), `<div class="msheet-picks">${rows}</div>`, opts.confirm ?? '确认');
    let sel = opts.defaultId && opts.items.some((i) => i.id === opts.defaultId) ? opts.defaultId : opts.items[0].id;
    const paint = (): void => h.body.querySelectorAll<HTMLElement>('.msheet-pick').forEach((row) => row.classList.toggle('on', row.dataset.id === sel));
    h.body.querySelectorAll<HTMLElement>('.msheet-pick').forEach((row) => row.addEventListener('click', () => { sel = row.dataset.id || sel; paint(); }));
    paint();
    wire(h, () => resolve(null), () => { resolve(sel); });
  });
}
