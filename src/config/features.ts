/**
 * 静态 feature flags（D1·种子）。默认随包、断网即可启动；将来 remote manifest（深水后置）可覆盖。
 * 这是「是否启用某模式/能力」的单一真相源——各消费方读 features.X，不再各处散判 import.meta.env.DEV。
 */
export interface Features {
  meeting: boolean;     // 会议模式：**active**（2026-06-25 用户决定保留，不冻结）；F4 迁进 features/meeting/ 后仍读此 flag 决定 nav
  devConsole: boolean;  // dev 三页（采集取证 / AI 会话 / 设置）
  einkBridge: boolean;  // 电纸屏推帧镜像（无桥自动 no-op）
  mobileShell: boolean; // 移动版 shell（reMarkable 式，开发中）
  localOcr: boolean;    // 端侧印刷 OCR（无桥降级云）
}

/** 运行期 flags（live 单例）。初值=随包默认；config/manifest.ts 的 applyManifest 可整体覆盖。 */
export const features: Features = {
  meeting: true,
  devConsole: import.meta.env.DEV,
  einkBridge: true,
  mobileShell: false,
  localOcr: true,
};
