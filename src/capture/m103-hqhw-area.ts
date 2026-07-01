/**
 * Haoqing M103 设备专用：把当前生效的墨迹画布矩形上报给原生 `HqHwBridge`(收窄 OSD 画区到画布本身)，
 * 并在「可见内容真变了」时清掉旧 OSD 硬件墨迹。
 *
 * 2026-07-01：第一版直接拿整个 WebView 当画区，武装后厂商 OSD 会在整屏响应笔迹、擦掉 UI；原生看不到
 * WebView 内 DOM、不知道画布在哪，故改成前端上报可见画布(`#ink-layer` 原版页 / `.reader-ink` 重排书籍页)。
 *
 * OSD 是**物理屏坐标的硬件叠加层，和 WebView 的滚动/切换内容完全解耦**——内容一变(导航/翻页/重排虚拟页/
 * 原版⇄重排/滚动/遮挡层)，旧墨迹就残留在原物理位置盖到新内容上。收口方案(codex 彻查后)=**权威内容签名门**：
 * 所有业务事件只触发重算，只有签名(可见画布身份+物理位置+滚动+doc/page/view/zoom+导航+遮挡)变了才清 OSD；
 * 写字只改 canvas 像素/mark 数据、不改签名，所以不会每笔清=不闪。没有可写画布或被浮层遮挡→报 null→原生 disarm。
 *
 * 只在这台设备上生效——其它设备没有 `window.InkLoopHqHwArea` 通道，postMessage 直接 no-op。
 */
import { bus, getActiveContext, settings, state } from '../app/state';
import { isM103Device } from './m103-device';
import { clearOsdInkAfterCommit, isPenDown } from './m103-input-source';

interface HqHwAreaChannel { postMessage(data: string): void; }

function channel(): HqHwAreaChannel | null {
  if (!isM103Device()) return null;
  const w = window as unknown as { InkLoopHqHwArea?: HqHwAreaChannel };
  return w.InkLoopHqHwArea ?? null;
}

const CANDIDATE_SELECTORS = '#ink-layer, .reader-ink';
interface HqHwRect { x: number; y: number; w: number; h: number; dpr: number }
interface VisibleCanvas { selector: string; el: HTMLElement; rect: HqHwRect }

// 会遮挡/顶掉可写画布的浮层：打开时整个解除武装(报 null)，别让 OSD 在浮层底下响应笔迹。
const BLOCKING_CHROME = ['files-open', 'insight-open', 'side-open'];
function canvasBlocked(): boolean {
  const b = document.body;
  if (BLOCKING_CHROME.some((c) => b.classList.contains(c))) return true;
  if (document.querySelector('.msheet-scrim')) return true; // 动态 sheet 遮罩
  const spine = document.getElementById('mtg-spine');
  return !!spine && !spine.hidden; // 会议时间脊展开遮挡画布
}

function visibleCanvas(): VisibleCanvas | null {
  if (canvasBlocked()) return null;
  // getBoundingClientRect 返回 CSS px；原生侧(getLocationOnScreen+dm.widthPixels)按物理 px 工作，差一个
  // devicePixelRatio(M103=1.5)——不乘会让画区缩到左上角、笔被 drawserver 判区外不刷(2026-07-01 DPR 根因)。
  // 这里换算成物理屏 px 再上报，让原生坐标和 drawserver 的 native 坐标同一把尺。
  const dpr = window.devicePixelRatio || 1;
  const nodes = document.querySelectorAll<HTMLElement>(CANDIDATE_SELECTORS);
  for (const el of nodes) {
    if (el.offsetParent === null) continue; // display:none / 祖先隐藏
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const selector = el.matches('#ink-layer') ? '#ink-layer' : '.reader-ink';
      return { selector, el, rect: { x: r.left * dpr, y: r.top * dpr, w: r.width * dpr, h: r.height * dpr, dpr } };
    }
  }
  return null;
}

function visibleCanvasRect(): HqHwRect | null {
  return visibleCanvas()?.rect ?? null;
}

let reportTimer = 0;
function reportNow(): void {
  reportTimer = 0;
  const ch = channel();
  if (!ch) return;
  const rect = visibleCanvasRect();
  try { ch.postMessage(JSON.stringify(rect)); } catch { /* no-op */ }
}

function scheduleReport(): void {
  if (!channel()) return;
  if (reportTimer) clearTimeout(reportTimer);
  reportTimer = window.setTimeout(reportNow, 150);
}

// ── OSD 换页清理：权威内容签名门 ──
// 只有签名(可见画布身份+物理位置+滚动+doc/page/view/zoom+导航+遮挡)变了才清 OSD；写字后的 canvas 补画/mark
// 落库/reader 重投影不改签名→跳过(治"每笔清=闪"·真机实测 4 笔曾触发 5 次误清)。签名分量务必覆盖所有"内容
// 变脏"路径(codex 列全)：漏一个=该清没清留残留；多算不该算的(如日记 onGrow 长高)=误清闪。
let lastClearSig = '';
let evalRaf = 0;

function rectSig(r: HqHwRect): string {
  // ⚠️只取位置 x/y(不含 w/h)：日记白板写字会 onGrow 自动长高(h 变、位置不变)，含 h 会变成每笔清=闪；
  //   size 变化(zoom)另有 zoom 签名分量兜。位置变(滚动/rail 折叠/画布移位)才是真该清 OSD 的。
  return `${Math.round(r.x)},${Math.round(r.y)}@${r.dpr.toFixed(2)}`;
}

function scrollNodeKey(el: HTMLElement): string {
  return el.id ? `#${el.id}` : el.className ? `.${String(el.className).trim().split(/\s+/).slice(0, 2).join('.')}` : el.tagName.toLowerCase();
}

// 读当前可见画布所有可滚动祖先的 scrollTop/Left 现值(而非累计 tick)：翻虚拟页/日记分页/自由滚动都改这些，
// 直接读现值最可靠——不依赖 scroll 事件时序/冷却窗口(免漏尾)。
function scrollSigFor(el: HTMLElement): string {
  const parts: string[] = [];
  for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
    if (n.scrollTop || n.scrollLeft || n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1) {
      parts.push(`${scrollNodeKey(n)}:${Math.round(n.scrollLeft)},${Math.round(n.scrollTop)}`);
    }
  }
  parts.push(`win:${Math.round(window.scrollX)},${Math.round(window.scrollY)}`);
  const vv = window.visualViewport;
  if (vv) parts.push(`vv:${Math.round(vv.offsetLeft)},${Math.round(vv.offsetTop)},${vv.scale.toFixed(2)}`);
  return parts.join(';');
}

function chromeSig(): string {
  const b = document.body.classList;
  const flags = ['rail-off', 'files-open', 'insight-open', 'side-open', 'mtg-note-open'].filter((c) => b.contains(c));
  if (document.querySelector('.msheet-scrim')) flags.push('sheet');
  const spine = document.getElementById('mtg-spine');
  if (spine && !spine.hidden) flags.push('spine');
  return flags.join(',');
}

function contentSig(): string {
  const b = document.body.dataset;
  const canvas = visibleCanvas();
  return [
    `nav=${b.mode ?? ''}/${b.read ?? ''}/${b.mtg ?? ''}/${b.dev ?? ''}/${b.surface ?? ''}`,
    `ctx=${getActiveContext().id}`,
    `doc=${state.documentId ?? ''}`,
    `page=${state.pageId ?? ''}`,
    `pi=${state.pageIndex}`,
    `surface=${state.surfaceType}`,
    `view=${settings.viewMode}`,          // 原版⇄重排：applyViewMode 只切 display、pageId 不变→靠这个分量抓
    `reflow=${settings.reflowProvider}@${settings.reflowModel}`,
    `zoom=${state.zoom}`,
    `area=${canvas ? `${canvas.selector}:${rectSig(canvas.rect)}` : 'none'}`, // 画布身份+物理位置(rail折叠/移位)
    `scroll=${canvas ? scrollSigFor(canvas.el) : ''}`,                        // 重排虚拟页/日记分页/自由滚动
    `chrome=${chromeSig()}`,                                                   // 遮挡层开合
  ].join('|');
}

function maybeClearOsd(): void {
  if (isPenDown()) return;                // 笔正落纸(写字/擦)：彻底不清 OSD/不 resizeInk——写字引发的程序滚动不触发画布触碰
  scheduleReport();                       // 画区跟随内容——无条件重报(便宜、幂等)
  const sig = contentSig();
  if (sig === lastClearSig) return;       // 内容身份/位置/遮挡都没变(如写字后 mark 重绘)→别清，避免每笔清=闪
  lastClearSig = sig;
  clearOsdInkAfterCommit();               // 双 rAF 屏障：等新内容(redrawInk)画完再清 OSD
}

// DOM 突变(导航改 body dataset·浮层改 class·reader 重排增删节点·画布 style 移位)→ rAF 去抖后重算签名。
function scheduleEvaluate(): void {
  if (evalRaf) return;
  evalRaf = requestAnimationFrame(() => { evalRaf = 0; maybeClearOsd(); });
}

// 滚动兜底：事件只触发检查，签名读当前 scrollTop/rect(不靠 tick·免漏尾)。前沿冷却 200ms 避免自由滚动逐像素
// 清、冷却期内仍重报画区跟随。写字时页面 touch-action=none 不滚(真机实测 scrollCount=0)，故不误清正在写的页。
let scrollCooldown = 0;
function onScroll(): void {
  if (!scrollCooldown) {
    maybeClearOsd();
    scrollCooldown = window.setTimeout(() => { scrollCooldown = 0; }, 200);
  } else {
    scheduleReport();
  }
}

let installed = false;
/** 安装画区上报 + OSD 换页清理(权威内容签名门)。非 M103 直接跳过。 */
export function initM103HqHwArea(): void {
  if (installed || !channel()) return;
  installed = true;
  // 业务事件只负责触发重算(经签名门·写字后 mark 重绘也发这些但签名不变→跳过)
  bus.on('page:rendered', maybeClearOsd);
  bus.on('view:changed', maybeClearOsd);
  bus.on('document:loaded', maybeClearOsd);
  bus.on('context:switched', maybeClearOsd);
  bus.on('settings:changed', maybeClearOsd);
  bus.on('reader:vpage', maybeClearOsd); // 重排虚拟页翻动（reader.ts applyV 发）
  window.addEventListener('resize', maybeClearOsd);
  window.visualViewport?.addEventListener('resize', maybeClearOsd);
  window.visualViewport?.addEventListener('scroll', maybeClearOsd);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true }); // 兜住所有滚动/翻页
  // 导航/遮挡/画布移位靠 DOM 变化捕获(顶层/子导航改 body dataset·浮层改 class·reader 重排增删节点·画布 style
  // 移位)：广观察(childList/subtree/attributes) + rAF 去抖 + 签名门——比逐个 click/事件补更全、防新增路径漏掉。
  const domObserver = new MutationObserver(scheduleEvaluate);
  domObserver.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'data-mode', 'data-read', 'data-mtg', 'data-dev', 'data-surface'],
  });
  setTimeout(reportNow, 600); // 首帧稳定后报一次，跟 eink.ts initEinkMirror 的首帧镜像同节奏
}
