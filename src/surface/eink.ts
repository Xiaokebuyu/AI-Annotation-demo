/**
 * 电纸屏推帧接缝（前端侧）。
 *
 * 安卓壳通过 androidx.webkit addWebMessageListener 注入全局通道 window.InkLoopEink。
 * 本模块在 InkLoop 内容变化时发 `pageReady` 信号；原生 EinkBridge 收到后用 PixelCopy 抓 WebView 帧
 * → 等比缩进电纸屏 → 8bpp 灰度 → 经 abstract socket 交 eink-helper(root) 推到 IT8951 电纸屏(GC16 整屏)。
 *
 * web/dev 环境无该注入对象 → einkAvailable()=false → 所有调用静默 no-op，对现有行为零影响。
 * 电纸屏是 USB 推位图副屏（非系统显示器），故"何时刷"由前端语义事件驱动，而非系统合成。
 *
 * Phase 2 将加：笔迹抬笔时导出脏区灰度帧走二进制 WebMessagePort → A2 局部快刷（低延迟手写）。
 */
import { bus } from '../app/state';

interface EinkChannel { postMessage(data: string): void; }

const MODE_GC16 = 2;
const MODE_A2 = 4;   // 写字快刷波形（2 级、低延迟）；残影由 helper 周期 GC16 兜底清
let enabled = true;

function channel(): EinkChannel | null {
  const w = window as unknown as { InkLoopEink?: EinkChannel };
  return w.InkLoopEink ?? null;
}

/** 原生桥是否在场且启用（web/dev 恒为 false）。 */
export function einkAvailable(): boolean { return enabled && !!channel(); }
/** 运行期总开关（dev 面板可控）。关时不再推屏。 */
export function setEinkEnabled(v: boolean): void { enabled = v; }

let pendingTimer = 0;
/** 通知原生：整屏内容已就绪，抓帧推电纸屏（GC16）。轻量去抖合并连续触发（翻页/重渲/旁注）。 */
export function signalPageReady(mode: number = MODE_GC16): void {
  if (!enabled || !channel()) return;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(() => {
    pendingTimer = 0;
    const ch = channel();
    try { ch?.postMessage(JSON.stringify({ method: 'pageReady', mode })); } catch { /* no-op */ }
  }, 120);
}

// ── Phase 2：笔迹局部 A2 快刷 ──
// 抬笔 → 把该笔 bbox(页归一化) 换算成视口归一化矩形 → 通知原生只 PixelCopy 该子区、A2 局部快刷(~120ms)，
// 不再整屏 GC16 闪一下。连写多笔在短窗内并集成一个矩形，少推几帧。

/** 页归一化 bbox[x,y,w,h] → 视口归一化矩形。经 #ink-layer 实际显示框(getBoundingClientRect)，
 *  自动含布局偏移/滚动；与 evtNorm 同一基准(canvas 显示尺寸=pageCss)，故 left+bx*width 即落笔的屏上位置。
 *  重排面 #ink-layer display:none → rect 全 0 → 返 null(该模式 A2 留待后续)。 */
function pageBoxToViewport(bx: number, by: number, bw: number, bh: number):
  { x: number; y: number; w: number; h: number } | null {
  const cv = document.getElementById('ink-layer');
  if (!cv) return null;
  const r = cv.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  if (r.width <= 0 || r.height <= 0 || !vw || !vh) return null;
  return {
    x: (r.left + bx * r.width) / vw,
    y: (r.top + by * r.height) / vh,
    w: (bw * r.width) / vw,
    h: (bh * r.height) / vh,
  };
}

let inkPending: { x0: number; y0: number; x1: number; y1: number } | null = null;
let inkTimer = 0;
/** 通用 A2 脏区核心：并集视口归一化矩形[0,1]，短窗(150ms)后推一帧 A2 局部快刷。夹值 + 丢空矩形。 */
function pushDirty(x0: number, y0: number, x1: number, y1: number): void {
  if (!enabled || !channel()) return;
  x0 = Math.max(0, Math.min(1, x0)); y0 = Math.max(0, Math.min(1, y0));
  x1 = Math.max(0, Math.min(1, x1)); y1 = Math.max(0, Math.min(1, y1));
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return;
  inkPending = inkPending
    ? { x0: Math.min(inkPending.x0, x0), y0: Math.min(inkPending.y0, y0), x1: Math.max(inkPending.x1, x1), y1: Math.max(inkPending.y1, y1) }
    : { x0, y0, x1, y1 };
  if (inkTimer) return;   // 窗口内已排程 → 并集等它一起发（不重置计时，延迟有上界）
  inkTimer = window.setTimeout(() => {
    inkTimer = 0;
    const p = inkPending; inkPending = null;
    const ch = channel();
    if (!p || !ch) return;
    try { ch.postMessage(JSON.stringify({ method: 'inkArea', x: p.x0, y: p.y0, w: p.x1 - p.x0, h: p.y1 - p.y0, mode: MODE_A2 })); }
    catch { /* no-op */ }
  }, 150);
}
/** 抬笔即调：页归一化 bbox → 视口矩形 → A2 局部快刷（原版画布·经 #ink-layer）。 */
export function signalInkArea(bbox: [number, number, number, number]): void {
  const min = 8 / Math.max(window.innerWidth || 1, window.innerHeight || 1);
  const bw = bbox[2] || min, bh = bbox[3] || min;
  const vp = pageBoxToViewport(bbox[0] - (bw - bbox[2]) / 2, bbox[1] - (bh - bbox[3]) / 2, bw, bh);
  if (vp) pushDirty(vp.x, vp.y, vp.x + vp.w, vp.y + vp.h);
}
/** 通用 A2 脏区：直接给视口归一化矩形[0,1]（不经 #ink-layer）。重排面手写/橡皮/AI 标记/小反馈用。 */
export function signalViewportArea(rect: { x: number; y: number; w: number; h: number }): void {
  pushDirty(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
}
/** 通用 A2 脏区：给一个元素，按其当前视口位置刷 A2（抽屉/sheet/旁注块/小反馈用）。 */
export function signalElementArea(node: Element): void {
  const r = node.getBoundingClientRect();
  const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
  pushDirty(r.left / vw, r.top / vh, (r.left + r.width) / vw, (r.top + r.height) / vh);
}

// ── 通用 UI 变化刷新（电纸屏：点按钮/切工具/开菜单/AI 标记/时钟也要看到反馈）──
// 语义事件(翻页/视图/文档)走整屏 GC16；其余 DOM 变动由 MutationObserver 兜底，按【变更区域大小】决定：
// 小改 → A2 局部快刷（工具高亮/AI 标记/时钟/列表小改）；大改(>60% 视口) / body 级(视图切换 data-* / 模态 append) → 整屏 GC16。
// 这把原来「任何 UI 变动都整屏 GC16」换成「按区域局部刷」，工具/抽屉/时钟/AI 标记不再整屏闪。
let uiDirty: { l: number; t: number; r: number; b: number } | null = null;
let uiPageLevel = false;
let uiTimer = 0;
function flushUi(): void {
  uiTimer = 0;
  const d = uiDirty, pl = uiPageLevel;
  uiDirty = null; uiPageLevel = false;
  if (pl) { signalPageReady(); return; }
  if (!d) return;
  const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
  const w = d.r - d.l, h = d.b - d.t;
  if (w <= 0 || h <= 0) return;
  if ((w * h) / (vw * vh) > 0.6) signalPageReady();                            // 大改 → 整屏 GC16（清残影）
  else signalViewportArea({ x: d.l / vw, y: d.t / vh, w: w / vw, h: h / vh });  // 小改 → A2 局部
}
function noteUiChange(target: Node): void {
  if (!enabled || !channel()) return;
  if (target === document.body) { uiPageLevel = true; }   // body 级（视图切换 data-* / 模态 append）→ 整屏
  else {
    const el = target instanceof Element ? target : target.parentElement;
    const b = el?.getBoundingClientRect();
    if (b && b.width > 0 && b.height > 0) {
      uiDirty = uiDirty
        ? { l: Math.min(uiDirty.l, b.left), t: Math.min(uiDirty.t, b.top), r: Math.max(uiDirty.r, b.right), b: Math.max(uiDirty.b, b.bottom) }
        : { l: b.left, t: b.top, r: b.right, b: b.bottom };
    }
  }
  if (!uiTimer) uiTimer = window.setTimeout(flushUi, 120); // 合并 120ms 内多批变动，统一决策
}

let installed = false;
/** 安装电纸屏镜像钩子：画板内容变化时推整屏。main.ts 启动时调一次（无桥环境直接跳过）。 */
export function initEinkMirror(): void {
  if (installed || !channel()) return;   // 非套壳环境直接跳过
  installed = true;
  // 内容变更的语义事件 → 整屏 GC16 重刷（去抖合并）
  bus.on('page:rendered', () => signalPageReady());   // PDF 页/白板渲染完成
  bus.on('view:changed', () => signalPageReady());     // 原版 ⇄ 重排切换
  bus.on('document:loaded', () => signalPageReady());  // 文档载入
  // AI 旁注/标记 出现/消失 不再整屏 GC16——它们是局部 DOM 变动，由下面 MutationObserver 兜底按区域 A2 局部刷。
  // 通用兜底：任何 UI DOM 变动（工具高亮/菜单/按钮态…）→ 去抖整屏刷，保证触摸反馈可见。
  // 排除「不该牵动整屏」的子树：笔迹画布(走 A2 局部)、重排笔迹画布、dev 调试叠层(region/bbox/relation/hmp·
  // 开着会在手写时画框→被这里抓成整屏 GC16·已默认关·这里再兜一层)、虚拟翻页引擎自插的垫白 spacer。
  const EINK_IGNORE = '#ink-layer,.reader-ink,#region-overlay,#bbox-overlay,#relation-overlay,#hmp-float,.vpager-spacer,[data-eink-ignore]';
  const einkIgnored = (node: Node | null): boolean => {
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    return !!el?.closest(EINK_IGNORE);
  };
  try {
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (einkIgnored(r.target)) continue;
        noteUiChange(r.target);   // 不 early-return：遍历全批取并集区域，flushUi 统一决策 A2/GC16
      }
    });
    mo.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-pressed', 'aria-expanded', 'aria-selected', 'data-active', 'data-state', 'data-mode', 'data-read', 'data-mtg', 'data-dev', 'data-surface', 'open', 'value'],
    });
  } catch { /* 老 WebView 无 MutationObserver 时静默 */ }
  // 原生表单控件（select/checkbox/radio/number）改值是改 property、**不产生 DOM 变动** → MutationObserver 抓不到 →
  // 电纸屏不刷（"改了看不见"）。补一条：change 冒泡到 document 时按目标元素局部 A2 刷一发。
  // 用 change（离散提交）不用 input（文本逐字太频）；range 拖动结束才 change，够用。
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t instanceof Element && !einkIgnored(t)) signalElementArea(t);
  }, true);
  // 仅 range/number 补 input（实时可见）；不给文本框补 input——逐字会过刷。
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && (t.type === 'range' || t.type === 'number') && !einkIgnored(t)) signalElementArea(t);
  }, true);
  // 首帧：首屏渲染稳定后镜像一次当前 UI（含导航壳空态）
  setTimeout(() => signalPageReady(), 600);
}
