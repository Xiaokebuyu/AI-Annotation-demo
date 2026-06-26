/**
 * 应用 manifest（D1·种子）—— feature flags + dev 设置子集的「可下发配置」结构。
 * 现只有随包默认（断网即用）；远程拉取 + schema 校验 + last-good 缓存 = 深水后置（D2/之后）。
 * dev 设置覆盖复用 C4 的 applyKnownSettings + DEV_FIELDS：remote 只动 dev 子集，不踩用户偏好。
 */
import { applyKnownSettings, DEV_FIELDS } from '../app/state';
import { features, type Features } from './features';

export interface AppManifest {
  manifestVersion: 1;
  minAppVersion?: string;                 // 低于此版本的 app 忽略本 manifest（深水后置时校验）
  features?: Partial<Features>;
  devSettings?: Record<string, unknown>;  // 对应 C4 DEV_FIELDS（模型/AB 旋钮）
}

/** 随包默认 manifest（断网启动用此）。 */
export const defaultManifest: AppManifest = {
  manifestVersion: 1,
  features: { ...features },
};

/** 应用一份 manifest（本地默认 / 将来 remote 拉到并校验后）：覆盖 flags + dev 设置子集。 */
export function applyManifest(m: AppManifest): void {
  if (m.features) Object.assign(features, m.features);
  if (m.devSettings) applyKnownSettings(m.devSettings, DEV_FIELDS); // 复用 C4 类型守卫，只动 dev 子集
}
