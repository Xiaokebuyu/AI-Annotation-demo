/**
 * Haoqing M103 设备专用：接厂商硬件笔点流。
 *
 * 2026-07-01：笔尖已通过 OSD 顺滑落墨，但我们抬笔补画进 canvas 用的是 WebView PointerEvent 的点，
 * 和 OSD 硬件墨迹的点不同源，交接(清OSD+显canvas)时对不齐→用户看到"写完又重刷一遍"的微重影。
 * 原生无缝的秘诀是 canvas/bitmap 和 OSD 用**同一份硬件 socket 点流**建模。这个模块就是接收那份点流：
 * `HqHwBridge.kt` 订阅 `/tmp/hqunifiedsocket`(drawserver→app 广播的 native 笔点)，按 action 缓冲一整笔，
 * 抬笔(action=UP)时把整笔的点(已在 native 侧反变换成 WebView CSS 视口坐标)一次性 `evaluateJavascript`
 * 推到 `window.__inkLoopOnHqSocketStroke`。前端 finish() 抬笔时 `takeHqSocketStroke()` 领这一笔、用它
 * 的点画 canvas + 喂 model，几何和 OSD 完全同源→交接无感。
 *
 * 只在这台设备上生效——非 M103 不装接收器、`takeHqSocketStroke()` 直接超时返回 null，调用方 fallback
 * 到 WebView 点，行为跟没这套机制一致。
 */
import { isM103Device } from './m103-device';

/** 一个 socket 笔点，坐标已是 WebView CSS 视口坐标(等价 clientX/clientY)。 */
export interface HqSocketPoint { x: number; y: number; pressure: number; t: number; strokeWidth?: number; flag: number; }
interface HqSocketStroke { seq: number; source: 'hqunifiedsocket'; points: HqSocketPoint[]; arrivedAt: number; used?: boolean; }

const socketStrokes: HqSocketStroke[] = [];
const waiters: Array<{ since: number; resolve: (s: HqSocketStroke | null) => void; timer: number }> = [];

let installed = false;
/** 安装硬件笔点接收器。非 M103 no-op。mobile-main 启动时调一次。 */
export function initM103HqHwSocket(): void {
  if (installed || !isM103Device()) return;
  installed = true;
  const w = window as unknown as { __inkLoopOnHqSocketStroke?: (raw: Omit<HqSocketStroke, 'arrivedAt'>) => void };
  w.__inkLoopOnHqSocketStroke = (raw) => {
    const st: HqSocketStroke = { ...raw, arrivedAt: performance.now() };
    socketStrokes.push(st);
    while (socketStrokes.length > 8) socketStrokes.shift(); // 环形保留最近 8 笔，够抬笔时领
    // 有 finish() 在等这一笔就直接兑现（socket UP 晚于 WebView pointerdown，since-120 的松弛容异步抖动）
    const i = waiters.findIndex((wt) => st.arrivedAt >= wt.since - 120);
    if (i >= 0) { const wt = waiters.splice(i, 1)[0]; clearTimeout(wt.timer); st.used = true; wt.resolve(st); }
  };
}

/**
 * 抬笔时领这一笔的硬件点。`since`=落笔时刻(performance.now)，用来匹配"这次抬笔对应的那批 socket 点"。
 * socket 整笔是在 UP 后才交付的，所以 finish() 里 await 它：已到就立即领，没到等 `timeoutMs`，超时返回
 * null 让调用方 fallback 到 WebView 点(socket 缺包/重连/4020 失败时)。非 M103 也走超时→null。
 */
export function takeHqSocketStroke(since: number, timeoutMs = 160): Promise<HqSocketStroke | null> {
  const ready = socketStrokes.find((s) => !s.used && s.arrivedAt >= since - 120);
  if (ready) { ready.used = true; return Promise.resolve(ready); }
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      const i = waiters.findIndex((wt) => wt.resolve === resolve);
      if (i >= 0) waiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    waiters.push({ since, resolve, timer });
  });
}
