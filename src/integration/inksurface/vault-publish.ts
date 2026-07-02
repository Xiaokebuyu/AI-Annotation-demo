/**
 * Vault release 发布 client（交付路线 Y · 设备→panel · browser）。
 * 走同源 `/api/panel-vault/*` → vite dev proxy（注入 x-inkloop-secret·secret 不进前端）→ panel `/api/inkloop/vault/*`。
 * 经 core/api 的 postJson/getJson（dev 同源 + 生产 VITE_API_BASE_URL 都覆盖）·不裸 fetch。
 *
 * per-user：userId=InkLoop 账号稳定 ID（MVP 单用户先用固定值）；deviceId 仅来源元数据。
 */
import { getJson, postJson } from '../../core/api';
import type { VaultRelease } from './vault-release';

const BASE = '/api/panel-vault';
const u = (s: string) => encodeURIComponent(s);

export interface PublishResult {
  ok?: boolean;
  release_id?: string;
  file_count?: number;
  total_bytes?: number;
  deduped?: boolean; // 同 release_hash 重发 → 内容未变·panel 只把 latest 指过去
  error?: string;
}

/** 上传整包 release（设备→panel 存）。内容未变（同 release_hash）panel 幂等返回 deduped。 */
export async function publishVaultRelease(release: VaultRelease, opts: { userId: string; deviceId?: string; signal?: AbortSignal }): Promise<PublishResult> {
  return postJson<PublishResult>(
    `${BASE}/users/${u(opts.userId)}/releases`,
    { manifest: release.manifest, files: release.files, device_id: opts.deviceId },
    { signal: opts.signal },
  );
}

export interface LatestReleaseAsset {
  path: string;
  content_hash: string;
  bytes: number;
  download: string; // /api/inkloop/vault/users/:u/blobs/sha256/<hex>（下载器据此拉 blob）
}
export interface LatestRelease {
  release: { id: string; release_hash: string; generated_at: string; uploaded_at: string };
  manifest: VaultRelease['manifest'];
  assets: LatestReleaseAsset[];
}

/** 拉某 user 最新 release manifest + 资产下载地址（下载器/调试用）。 */
export async function fetchLatestRelease(userId: string, opts?: { signal?: AbortSignal }): Promise<LatestRelease> {
  return getJson<LatestRelease>(`${BASE}/users/${u(userId)}/releases/latest`, opts);
}
