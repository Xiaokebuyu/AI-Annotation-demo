/**
 * Vault 上传触发链（交付路线 Y·设备→panel）：collect → build → publish 串成一个动作。
 * mobile-main 的 __inkloop hook 与 设置页「上传到 Obsidian」按钮共用同一份逻辑（不靠 window 全局·有类型）。
 *
 * 传输：dev/同源经 Vite panelVaultProxy 注 x-inkloop-secret；生产（安卓）经 VITE_API_BASE_URL → standalone.ts 的
 *       /api/panel-vault 代理注密钥。secret 永不进前端/APK。
 * 单用户 MVP：userId 固定（与 Obsidian 下载器插件 + standalone INKLOOP_USER_ID 一致）。真设备多用户需 per-user
 *       可吊销 token（见记忆 inkloop-obsidian-clean-vault·暂缓）——本件是单用户传输层。
 */
import type { VaultExportBundle } from './vault-export';
import type { VaultEntityRef } from './vault-collect';

export const VAULT_PUBLISH_USER_ID = 'edy'; // 须三处一致：此处 / Obsidian 插件 userId / standalone INKLOOP_USER_ID（否则发上去 Obsidian 同步不到）
export const VAULT_PUBLISH_DEVICE_ID = 'mobile'; // 仅来源元数据

export type VaultPublishStage = 'busy' | 'collect' | 'build' | 'publish' | 'done' | 'aborted';
export interface VaultPublishOpts {
  userId?: string;
  deviceId?: string;
  generatedAt?: string;
  appVersion?: string;
  concepts?: boolean; // 默认关：上传链不挂 LLM（概念抽取慢 + 未端到端验真 LLM）。传 true 才跑概念层 → 出 Concepts/ 枢纽
  conceptModel?: string;
  allowEmpty?: boolean; // 默认禁止全空 release 上传（防把 Obsidian 端冲成空 vault）
  signal?: AbortSignal;
}
export interface VaultPublishResult {
  ok: boolean;
  stage: VaultPublishStage;
  userId: string;
  deviceId: string;
  entity_count?: number;
  file_count?: number;
  total_bytes?: number;
  release_hash?: string;
  release_id?: string;
  deduped?: boolean; // 同 release_hash 重发·内容未变·panel 只把 latest 指过去
  warnings?: string[];
  error?: string;
}

let controller: AbortController | null = null;
/** 取消进行中的上传（无则返回 false）。 */
export function abortVaultPublish(): boolean {
  if (!controller) return false;
  controller.abort();
  return true;
}
function warningsOf(bundle: VaultExportBundle): string[] {
  return bundle.entities.flatMap((e) => (e.warnings ?? []).map((w) => `${e.documentTitle}: ${w}`));
}

/** 一个动作把真 IndexedDB 数据推上 panel。并发防重入 + 空 release 守卫 + 分阶段错误 + warnings 透出。 */
export async function publishVaultFromDevice(opts: VaultPublishOpts = {}): Promise<VaultPublishResult> {
  const userId = opts.userId ?? VAULT_PUBLISH_USER_ID;
  const deviceId = opts.deviceId ?? VAULT_PUBLISH_DEVICE_ID;
  if (controller) return { ok: false, stage: 'busy', userId, deviceId, error: '已有 vault 上传在进行中' };

  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) ctrl.abort();
  controller = ctrl;
  const throwIfAborted = (): void => { if (ctrl.signal.aborted) throw new DOMException('Vault publish aborted', 'AbortError'); };

  let stage: VaultPublishStage = 'collect';
  try {
    const [{ collectVaultBundle }, { buildVaultRelease }, { publishVaultRelease }] = await Promise.all([
      import('./vault-collect'),
      import('./vault-release'),
      import('./vault-publish'),
    ]);
    throwIfAborted();

    const bundle = await collectVaultBundle({ generatedAt: opts.generatedAt, appVersion: opts.appVersion, concepts: opts.concepts ?? false, conceptModel: opts.conceptModel });
    throwIfAborted();
    const warnings = warningsOf(bundle);
    if (!bundle.entities.length && !opts.allowEmpty) {
      const r: VaultPublishResult = { ok: false, stage: 'collect', userId, deviceId, entity_count: 0, file_count: 0, warnings, error: '没有可发布实体·空 release 未上传' };
      console.warn('[vault] publish skipped', r);
      return r;
    }

    stage = 'build';
    const release = await buildVaultRelease(bundle, { generatedAt: opts.generatedAt, appVersion: opts.appVersion });
    const totalBytes = release.manifest.files.reduce((n, f) => n + f.bytes, 0);
    throwIfAborted();

    stage = 'publish';
    const published = await publishVaultRelease(release, { userId, deviceId, signal: ctrl.signal });
    // 完整性闸：postJson 非 2xx 已抛错落 catch；这里再挡「2xx 但 ok:false / 文件数不符」的弱失败，别静默报成功。
    const expectedFileCount = release.files.length;
    const rejected = published.ok === false;
    const fileCountMismatch = published.deduped !== true && published.file_count != null && published.file_count !== expectedFileCount;
    const publishError = published.error
      ?? (rejected ? 'panel 拒绝发布' : undefined)
      ?? (fileCountMismatch ? `panel 只确认 ${published.file_count ?? 0}/${expectedFileCount} 个文件·未按成功处理` : undefined);
    const ok = publishError == null;
    const result: VaultPublishResult = {
      ok,
      stage: ok ? 'done' : 'publish',
      userId, deviceId,
      entity_count: bundle.entities.length,
      file_count: published.file_count ?? expectedFileCount,
      total_bytes: published.total_bytes ?? totalBytes,
      release_hash: release.manifest.release_hash,
      release_id: published.release_id,
      deduped: published.deduped === true,
      warnings: warnings.length ? warnings : undefined,
      error: publishError,
    };
    if (ok) console.info('[vault] release published', result);
    else console.error('[vault] publish rejected', result);
    return result;
  } catch (e) {
    const err = e as Error;
    const aborted = ctrl.signal.aborted || err?.name === 'AbortError';
    const r: VaultPublishResult = { ok: false, stage: aborted ? 'aborted' : stage, userId, deviceId, error: aborted ? '已取消' : String(err?.message || e) };
    if (aborted) console.info('[vault] publish aborted', r);
    else console.error('[vault] publish failed', r, e);
    return r;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    if (controller === ctrl) controller = null;
  }
}

export interface EntityPublishResult extends VaultPublishResult {
  entityEmpty?: boolean; // true=预检发现这个实体没有可导出内容（无手写/无资料）——未发起网络请求
}

/**
 * 阶段⑤·按需导出入口：单会议/单书「导出到 Obsidian」按钮调这个。
 * 先用 collectVaultEntity 轻量预检这个实体是否有内容（没有就直接告知，不发请求）；
 * 有内容才走 publishVaultFromDevice 的整包安全通道发布（原因见 vault-collect.ts collectVaultEntity 头注：
 * panel latest release 是全量快照语义，真正「只传这一个实体」要等 panel 实体端点部署后才能做）。
 * 发布成功且是会议 → 落 exported_at（recap 显示「上次导出」）。
 */
export async function publishEntityToVault(ref: VaultEntityRef, opts: VaultPublishOpts = {}): Promise<EntityPublishResult> {
  const userId = opts.userId ?? VAULT_PUBLISH_USER_ID;
  const deviceId = opts.deviceId ?? VAULT_PUBLISH_DEVICE_ID;
  const { collectVaultEntity } = await import('./vault-collect');
  let entity: Awaited<ReturnType<typeof collectVaultEntity>>;
  try {
    entity = await collectVaultEntity(ref, { generatedAt: opts.generatedAt, appVersion: opts.appVersion });
  } catch (e) {
    // 实体不存在/已被删（collectVaultEntity 现在对这种情况抛错·非"没内容"）——按钮层要弹失败提示,不能当 entityEmpty 轻提示放过（codex 抓）。
    return { ok: false, stage: 'collect', userId, deviceId, error: String((e as Error)?.message || e) };
  }
  if (!entity) {
    return {
      ok: false, stage: 'collect', userId, deviceId, entityEmpty: true,
      error: ref.mode === 'meeting' ? '这场会议还没有可导出内容（没有手写、也没有转写）' : '这份文档还没有可导出内容',
    };
  }
  const result = await publishVaultFromDevice(opts);
  if (result.ok && ref.mode === 'meeting') {
    const { updateMeeting } = await import('../../local/store');
    await updateMeeting(ref.meetingId, { exported_at: new Date().toISOString() }).catch(() => {});
  }
  return result;
}
