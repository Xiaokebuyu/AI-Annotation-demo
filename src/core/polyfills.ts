/**
 * 老 WebView 兼容垫片。入口最先 import（在 pdf.js 等之前）。现代浏览器上全是 no-op。
 *
 * 设备电纸屏 WebView=Chromium 109，而 pdf.js（vite6 期跟随升级）用到 `Promise.withResolvers`（Chrome 119+）→
 * 不补则导入/渲染任何 PDF 抛 "Promise.withResolvers is not a function"。语法层 vite 不转运行期 API，故手动补。
 */
interface PromiseWithResolvers<T> { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void }

if (typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== 'function') {
  (Promise as unknown as { withResolvers: <T>() => PromiseWithResolvers<T> }).withResolvers = function <T>(): PromiseWithResolvers<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}
