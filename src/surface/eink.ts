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
  const vp = pageBoxToViewport(bbox[0], bbox[1], bbox[2], bbox[3]);
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

// ── 通用 UI 变化刷新（电纸屏设备形态：点按钮/切工具/开菜单也要看到反馈）──
// 语义事件只覆盖重内容（翻页/视图/文档/旁注）；工具高亮、菜单展开、按钮态这类轻量 UI 变化
// 不发任何 bus 事件 → 电纸屏不刷 = 手指点了看不到反馈。用 MutationObserver 兜底：任何 DOM 变动
// 触发一次带上限的去抖整屏刷。带 maxwait 防连续动画把纯尾去抖饿死/导致狂闪。
const UI_DEBOUNCE = 200;   // 变动静默 200ms 后刷
const UI_MAXWAIT = 1000;   // 但连续变动最多每 1s 刷一帧（防动画狂闪/饿死）
let uiTimer = 0;
let uiFirstAt = 0;
function signalUiChanged(): void {
  if (!enabled || !channel()) return;
  const now = Date.now();
  if (!uiFirstAt) uiFirstAt = now;
  if (uiTimer) clearTimeout(uiTimer);
  const delay = Math.min(UI_DEBOUNCE, Math.max(0, UI_MAXWAIT - (now - uiFirstAt)));
  uiTimer = window.setTimeout(() => { uiTimer = 0; uiFirstAt = 0; signalPageReady(); }, delay);
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
  bus.on('overlay:add', () => signalPageReady());      // AI 旁注出现
  bus.on('overlay:remove', () => signalPageReady());   // AI 旁注移除
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
        signalUiChanged();
        return;
      }
    });
    mo.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-pressed', 'aria-expanded', 'aria-selected', 'data-active', 'open', 'value'],
    });
  } catch { /* 老 WebView 无 MutationObserver 时静默 */ }
  // 首帧：首屏渲染稳定后镜像一次当前 UI（含导航壳空态）
  setTimeout(() => signalPageReady(), 600);
}
