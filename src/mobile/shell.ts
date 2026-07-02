// 移动版（电纸屏）外壳交互：导航脊顶层 mode 切换、阅读/dev 子导航、工具收纳、rail 折叠、文件浮层关闭。
// 原为 mobile.html 末尾的内联 <script>，抽出成模块（正规化）。行为与原内联脚本逐条等价，仅加空值守卫。
// 真数据/钻取（会议进入、dev 段切换、settings 绑定）仍由 mobile/meeting.ts、mobile/dev.ts controller 接管。
const B = document.body;

const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(sel));
const byId = (v: string): HTMLElement | null => document.getElementById(v);

/** 设/清一个导航按钮的 on/dim 态 + 其所属 .rl-item 的 cur 态（与原内联脚本同义）。 */
function setBtn(b: HTMLElement, on: boolean): void {
  b.classList.toggle('on', on);
  b.classList.toggle('dim', !on);
  b.closest('.rl-item')?.classList.toggle('cur', on);
}

/** mode/read/mtg 组合决定当前面是否可书写（空白可写页 / 会中白板）。 */
function updateWritable(): void {
  const { mode, read, mtg } = B.dataset;
  const w =
    (mode === 'read' && (read === 'new' || read === 'book')) ||
    (mode === 'meet' && mtg === 'live');
  B.classList.toggle('writable', w);
}

/** 切阅读子态：diary/new/book/open；open 时让 diary 按钮也高亮（同原脚本）。 */
function setRead(v: string): void {
  B.dataset.read = v;
  for (const b of $$('#read-sub [data-read]')) {
    setBtn(b, b.dataset.read === v || (v === 'open' && b.dataset.read === 'diary'));
  }
  updateWritable();
}

let initialized = false;
export function initMobileShell(): void {
  if (initialized) return;
  initialized = true;

  // 顶层 mode（阅读/会议/dev）
  for (const b of $$('.nav [data-mode]')) {
    b.addEventListener('click', () => {
      for (const x of $$('.nav [data-mode]')) setBtn(x, false);
      setBtn(b, true);
      if (b.dataset.mode) B.dataset.mode = b.dataset.mode;
      updateWritable(); // 会议进入 + 钻取/返回由 mobile/meeting.ts 接管（真数据）
    });
  }

  // 阅读子导航
  for (const b of $$('#read-sub [data-read]')) {
    b.addEventListener('click', () => { if (b.dataset.read) setRead(b.dataset.read); });
  }

  // dev 子导航
  for (const b of $$('#dev-sub [data-dev]')) {
    b.addEventListener('click', () => {
      for (const x of $$('#dev-sub [data-dev]')) setBtn(x, false);
      setBtn(b, true);
      if (b.dataset.dev) B.dataset.dev = b.dataset.dev;
    });
  }

  // 打开旧日记 / 返回日记列表
  for (const row of $$('[data-open]')) row.addEventListener('click', () => setRead('open'));
  byId('open-back')?.addEventListener('click', () => setRead('diary'));

  // 工具收纳：收起按钮切显隐 + 选工具回填图标
  const tt = byId('tools-toggle');
  tt?.addEventListener('click', () => B.classList.toggle('tools-open'));
  for (const b of $$('[data-tool]')) {
    b.addEventListener('click', () => {
      for (const x of $$('[data-tool]')) x.classList.remove('on');
      b.classList.add('on');
      const icon = b.querySelector('svg')?.cloneNode(true);
      const current = tt?.querySelector('.ti');
      if (icon instanceof Element && current) {
        icon.classList.add('ti');
        current.replaceWith(icon);
      }
    });
  }

  // rail 折叠 / 唤出
  byId('rl-collapse')?.addEventListener('click', () => B.classList.add('rail-off'));
  byId('m-tab')?.addEventListener('click', () => B.classList.remove('rail-off'));

  // 文件浮层关闭（书架/导入卡由 mobile-main 动态渲染并绑定）
  byId('files-x')?.addEventListener('click', () => B.classList.remove('files-open'));
  byId('scrim-files')?.addEventListener('click', () => B.classList.remove('files-open'));

  updateWritable();
}
