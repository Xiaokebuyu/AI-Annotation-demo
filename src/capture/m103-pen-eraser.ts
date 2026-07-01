/**
 * Haoqing M103 设备专用：触控笔"橡皮头"识别。
 *
 * 只在这台设备上生效——`isM103Device()` 见 `./m103-device`，其它设备/桌面 web 恒返回 false，本文件
 * 的硬件专属细节(huion 笔倒过来用橡皮头点按时，Chromium 把 PointerEvent.buttons 置为 32，
 * 该 bit 位是 W3C Pointer Events 规范里笔类指针的 eraser 按钮位) 不会泄漏进其它设备的行为。
 *
 * 2026-07-01 真机实测确认（CDP 抓 InkLoop WebView 里的真实 pointerdown 事件）：
 *   正常笔尖 → buttons=1，pressure/tiltX/tiltY 为真实传感器值
 *   橡皮头   → buttons=32，pressure 恒为 1、tiltX/tiltY 恒为 0（这支笔的橡皮头只有二元触发，无压感/倾角）
 *
 * ⚠️ 这个 buttons 位判断只在 `HqHwBridge` 没武装厂商快速手写模式时可靠——武装后 `pointerType`/
 * `buttons` 会被弄脏（见 `./m103-input-source` 文件头注释），此时优先信原生 `nativePointerKind()`
 * 的判断，那边没有覆盖信息时才退回这里的 buttons 位判断。
 */
import { isM103Device } from './m103-device';
import { nativePointerKind } from './m103-input-source';

const ERASER_BUTTON_BIT = 32;

export { isM103Device };

/** 笔的物理橡皮头是否正接触屏幕（跟当前选的工具无关，就跟真实铅笔一样，翻过来就能擦）。 */
export function isHardwareEraserTip(e: PointerEvent): boolean {
  const native = nativePointerKind();
  if (native != null) return native === 'eraser';
  return isM103Device() && e.pointerType === 'pen' && (e.buttons & ERASER_BUTTON_BIT) !== 0;
}
