/**
 * Haoqing M103 设备身份判定——所有 M103 专用组件共用这一个判定，避免各自重复实现。
 *
 * 原生壳只在真机确认为 M103 时才注入 `window.__inkloopDeviceProfile`
 * (见 android MainActivity.kt `injectDeviceProfile`)，其它设备/桌面 web 恒返回 false。
 */
export function isM103Device(): boolean {
  const w = window as unknown as { __inkloopDeviceProfile?: string };
  return w.__inkloopDeviceProfile === 'm103-haoqing';
}
