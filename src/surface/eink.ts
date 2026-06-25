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
/** 抬笔即调：合并该笔的视口矩形，短窗(150ms)后推一帧 A2 局部快刷。bbox=页归一化[x,y,w,h]。 */
export function signalInkArea(bbox: [number, number, number, number]): void {
  if (!enabled || !channel()) return;
  const vp = pageBoxToViewport(bbox[0], bbox[1], bbox[2], bbox[3]);
  if (!vp) return;
  const x0 = vp.x, y0 = vp.y, x1 = vp.x + vp.w, y1 = vp.y + vp.h;
  inkPending = inkPending
    ? { x0: Math.min(inkPending.x0, x0), y0: Math.min(inkPending.y0, y0), x1: Math.max(inkPending.x1, x1), y1: Math.max(inkPending.y1, y1) }
    : { x0, y0, x1, y1 };
  if (inkTimer) return;   // 窗口内已排程 → 并集等它一起发（不重置计时，落笔延迟有上界）
  inkTimer = window.setTimeout(() => {
    inkTimer = 0;
    const p = inkPending; inkPending = null;
    const ch = channel();
    if (!p || !ch) return;
    try { ch.postMessage(JSON.stringify({ method: 'inkArea', x: p.x0, y: p.y0, w: p.x1 - p.x0, h: p.y1 - p.y0, mode: MODE_A2 })); }
    catch { /* no-op */ }
  }, 150);
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
  // 首帧：首屏渲染稳定后镜像一次当前 UI（含导航壳空态）
  setTimeout(() => signalPageReady(), 600);
}
