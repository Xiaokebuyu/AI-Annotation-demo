// 共享虚拟翻页引擎（电纸屏：禁自由滚 + 「块对齐」断页步进 scrollTop）。
// 算法源自 reader.ts 的成熟实现（虚拟页 / spacer 推块 / min-height 末页补齐·无尾 spacer overshoot）。
// 用于会议·dev·列表·抽屉·sheet 等所有「定高视口翻页」面；reader 仍用自带副本（严格零回归·后续可并轨）。
//
// 用法：
//   const pager = createPager(scrollEl, { onChange: (i) => bar?.update(i), onGrow: 'last' });
//   pager.content.innerHTML = renderItems();   // 渲染进引擎托管的 .vpager-content 包裹层
//   pager.relayout('first');                    // 重排 + 落首页（也可 'last'/'keep'）
//   const bar = mountPagerBar(pager, footEl);   // ‹ n/m › 控件
// 翻页：bar 的 ‹ › 调 pager.flip(±1)；越界返回 'boundary'（caller 可据此切上层 PDF/段落页）。

const VPAGE_EPS = 1; // 亚像素容差：仅挡舍入/0 高 spacer，真切口（≥2px）一律消除

export interface PageInfo { index: number; count: number; }
export interface PagerOpts {
  /** 内容包裹层（其底边=内容真高）。不传则引擎在 container 内自建/复用 .vpager-content，并把现有子节点搬进去。 */
  content?: HTMLElement;
  /** 不可跨页切的原子块；默认=content 的元素子节点（排除 spacer）。长内容请预切成多块，引擎不横切单块。 */
  blocks?: () => HTMLElement[];
  /** 翻页/重排后回调（页码指示用）。 */
  onChange?: (info: PageInfo) => void;
  /** 内容增长后落位：keep=守当前页；last=跳末页（feed/洞察等尾部增长面）。默认 keep。 */
  onGrow?: 'keep' | 'last';
  /** 自动观察 content 子树变动 + container resize → 重排。默认 true。 */
  observe?: boolean;
  /** spacer/wrapper 类名前缀（多面共存时一般无需改）。 */
  spacerClass?: string;
}
export interface Pager {
  /** 引擎托管的内容包裹层——控制器把 HTML 渲染进这里（别再写 container.innerHTML）。 */
  readonly content: HTMLElement;
  /** 重排版（测块→插 spacer→末页补齐）+ 落位。land: first=首页 / last=末页 / keep=守当前页（默认）。 */
  relayout(land?: 'keep' | 'first' | 'last'): void;
  goto(i: number): void;
  /** 翻一张虚拟页；成功 'moved'，已在边界 'boundary'。 */
  flip(dir: number): 'moved' | 'boundary';
  info(): PageInfo;
  vh(): number;
  /** node 落在第几虚拟页（替代 scrollIntoView 的「跳到目标」）。 */
  pageOf(node: HTMLElement): number;
  destroy(): void;
}

export function createPager(container: HTMLElement, opts: PagerOpts = {}): Pager {
  const spacerClass = opts.spacerClass ?? 'vpager-spacer';
  const onGrow = opts.onGrow ?? 'keep';

  // 内容包裹层：传了用传的；否则在 container 内自建 .vpager-content（把现有子节点搬进去）。
  const content: HTMLElement = (() => {
    if (opts.content) return opts.content;
    const existing = container.querySelector<HTMLElement>(':scope > .vpager-content');
    if (existing) return existing;
    const c = document.createElement('div');
    c.className = 'vpager-content';
    while (container.firstChild) c.appendChild(container.firstChild);
    container.appendChild(c);
    return c;
  })();

  const blocksOf = (): HTMLElement[] =>
    opts.blocks
      ? opts.blocks()
      : Array.from(content.children).filter(
          (c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains(spacerClass),
        );

  let vIndex = 0;
  container.style.overflowY = 'hidden'; // 禁自由滚（programmatic scrollTop 仍可步进）
  container.style.touchAction = 'none';

  const vh = (): number => container.clientHeight || 1;
  const contentH = (): number => {
    const er = container.getBoundingClientRect();
    return Math.max(1, content.getBoundingClientRect().bottom - er.top + container.scrollTop);
  };
  const vCount = (): number => Math.max(1, Math.ceil(contentH() / vh()));

  function paginateLayout(): void {
    content.querySelectorAll('.' + spacerClass).forEach((s) => s.remove());
    content.style.minHeight = '';
    container.scrollTop = 0; // 测量基准：内容坐标=视口坐标
    const H = vh();
    const er = container.getBoundingClientRect();
    let pageBottom = H;
    for (const node of blocksOf()) {
      const r = node.getBoundingClientRect();
      const top = r.top - er.top;
      const h = r.height;
      while (top >= pageBottom) pageBottom += H; // 前面 spacer 已把它推过若干屏 → 边界追上
      if (h <= H && top + VPAGE_EPS < pageBottom && top + h > pageBottom + VPAGE_EPS) {
        const spacer = document.createElement('div');
        spacer.className = spacerClass;
        spacer.style.cssText = `height:${pageBottom - top}px;pointer-events:none;`;
        node.before(spacer);
        pageBottom += H;
      }
    }
    // 末页补齐到整屏倍数：用 min-height（不用尾 spacer——会和末块 trailing margin 叠加 overshoot 多算一页）。
    const wrapTop = content.getBoundingClientRect().top - er.top;
    const natural = content.getBoundingClientRect().bottom - er.top;
    const pages = Math.max(1, Math.ceil(natural / H));
    content.style.minHeight = `${pages * H - wrapTop}px`;
  }

  function applyV(): void {
    vIndex = Math.min(Math.max(0, vIndex), vCount() - 1);
    container.scrollTop = vIndex * vh();
    opts.onChange?.({ index: vIndex, count: vCount() });
  }

  function relayout(land: 'keep' | 'first' | 'last' = 'keep'): void {
    paginateLayout();
    if (land === 'first') vIndex = 0;
    else if (land === 'last') vIndex = vCount() - 1;
    else vIndex = Math.min(vIndex, vCount() - 1);
    applyV();
  }

  // ── 自动重排：内容增长/重渲 → 重排（落位按 onGrow）；container resize → 守页重排 ──
  let ro: ResizeObserver | null = null;
  let mo: MutationObserver | null = null;
  let onLoad: ((e: Event) => void) | null = null;
  let raf = 0;
  let pendingGrow = false;
  const schedule = (grow: boolean): void => {
    pendingGrow = pendingGrow || grow;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      relayout(pendingGrow ? onGrow : 'keep');
      pendingGrow = false;
    });
  };
  if (opts.observe !== false) {
    try {
      ro = new ResizeObserver(() => schedule(false));
      ro.observe(container);
      onLoad = () => schedule(false); // 图片/iframe 解码完高度变 → 守页重排（RO 抓不到 content 内子元素尺寸变）
      content.addEventListener('load', onLoad, true);
      mo = new MutationObserver((recs) => {
        for (const r of recs) {
          if (r.type === 'childList') {
            const nodes = [...r.addedNodes, ...r.removedNodes];
            // 只增删 spacer 的变动是引擎自身排版产生 → 忽略（否则死循环）
            const onlySpacers = nodes.length > 0 && nodes.every(
              (n) => n instanceof HTMLElement && n.classList.contains(spacerClass),
            );
            if (onlySpacers) continue;
            schedule(true); // 真内容增删 → 按 onGrow 落位
            return;
          }
          // characterData / attributes('open'=<details> 折叠) → 高度变·守当前页重排
          schedule(false);
          return;
        }
      });
      // attributes:['open'] 抓 <details> 折叠（dev 流水线/设置大量用·展开后高度变·否则页数/spacer 旧）。
      // 不观察 class/style：避按钮态/minHeight 自身变动狂刷（minHeight 是 style·本就不在过滤里）。
      mo.observe(content, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open'] });
    } catch { /* 老 WebView 无 RO/MO：调用方手动 relayout */ }
  }

  return {
    content,
    relayout,
    goto(i) { vIndex = i; applyV(); },
    flip(dir) {
      const next = vIndex + (dir >= 0 ? 1 : -1);
      if (next < 0 || next >= vCount()) return 'boundary';
      vIndex = next; applyV(); return 'moved';
    },
    info() { return { index: vIndex, count: vCount() }; },
    vh,
    pageOf(node) {
      // 页边界以 container（scroll 容器）顶为基准（paginateLayout 同基准）——不能用 content 顶，
      // 否则漏掉容器 padding，被 spacer 推到下屏顶的块会算成上一页。
      const er = container.getBoundingClientRect();
      const nr = node.getBoundingClientRect();
      const y = nr.top - er.top + container.scrollTop;
      return Math.max(0, Math.min(vCount() - 1, Math.floor(y / vh())));
    },
    destroy() {
      ro?.disconnect();
      mo?.disconnect();
      if (onLoad) content.removeEventListener('load', onLoad, true);
      if (raf) cancelAnimationFrame(raf);
      content.querySelectorAll('.' + spacerClass).forEach((s) => s.remove());
      content.style.minHeight = '';
    },
  };
}

export interface PagerBar { el: HTMLElement; update(info: PageInfo): void; }
/** 挂一条 ‹ n/m › 翻页控件到 host，绑定到 pager.flip；单页时自动隐藏。 */
export function mountPagerBar(pager: Pager, host: HTMLElement): PagerBar {
  const bar = document.createElement('div');
  bar.className = 'vpager-bar';
  bar.innerHTML =
    '<button class="vpager-prev" type="button" aria-label="上一页">‹</button>' +
    '<span class="vpager-pn"></span>' +
    '<button class="vpager-next" type="button" aria-label="下一页">›</button>';
  const pn = bar.querySelector('.vpager-pn') as HTMLElement;
  const prev = bar.querySelector('.vpager-prev') as HTMLButtonElement;
  const next = bar.querySelector('.vpager-next') as HTMLButtonElement;
  prev.addEventListener('click', () => pager.flip(-1));
  next.addEventListener('click', () => pager.flip(1));
  const update = (info: PageInfo): void => {
    pn.textContent = `${info.index + 1} / ${info.count}`;
    prev.disabled = info.index <= 0;
    next.disabled = info.index >= info.count - 1;
    bar.style.display = info.count <= 1 ? 'none' : '';
    host.classList.toggle('has-vpages', info.count > 1); // 单页时容器不留 46px（CSS 用 .has-vpages 才让底）
  };
  host.appendChild(bar);
  update(pager.info());
  return { el: bar, update };
}
