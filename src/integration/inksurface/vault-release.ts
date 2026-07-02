/**
 * Vault 发布包（交付路线 Y：只借传输·整包发布）——把 renderVaultMarkdown 的干净 .md 整包打成一个 **release**：
 * manifest（schema_version + 每文件 sha256 + 字节数 + 整包指纹）+ files。
 *
 * 链路：设备 collectVaultBundle → renderVaultMarkdown → buildVaultRelease →（上传 panel 存）→ Obsidian 下载器拉最新 release 写盘。
 *
 * 为什么不走 SDK 的 runtime sync（事件同步）见 [[inkloop-obsidian-clean-vault]] 交付链节：
 *  · SDK 的 sync-api 只是**契约非服务**（apps/sync-api/README「contract fixture, not a deployed service」），无 server。
 *  · 事件 schema 只有增量编辑（block.update/annotation.* ）——**装不下整 vault 快照·冷启动无解**。
 *  · 我们渲染器是**整包**模型（全局命名/MOC/概念跨链需看全部实体）→ 整包发布天然契合、最少碰 SDK。
 * 「SDK 能用就用」：复用其 **schema_version 命名（inkloop.X.vN）+ sha256 内容寻址（Sha256 'sha256:<hex>'）**约定；
 *  release 端点形状对齐 SDK assets 合同（content_hash + download）以便将来真上 sync-api 时平滑。
 */
import { sha256HexStr } from '../../knowledge/builder';
import type { Sha256 } from '../../knowledge/knowledge-object';
import { type RenderedFile, renderVaultMarkdown } from 'ink-surface-sdk/adapters/obsidian';
import type { VaultExportBundle } from './vault-export';
import { toObsidianVaultRenderInput } from './vault-render-input';

export const VAULT_RELEASE_SCHEMA_VERSION = 'inkloop.vault_release.v1';

/** manifest 里一条文件记录（下载器据 content_hash 判变更/校验·按 path 升序）。 */
export interface VaultReleaseFileEntry {
  path: string; // vault 相对路径（InkLoop/...）
  content_hash: Sha256; // 'sha256:<hex>'·内容寻址
  bytes: number; // utf8 字节数
}

export interface VaultReleaseManifest {
  schema_version: typeof VAULT_RELEASE_SCHEMA_VERSION;
  generated_at: string;
  app_version: string;
  /** 整包指纹=按 path 排序的 (path+content_hash) 串的 sha256·**只依赖内容**（不含 generated_at）→ 内容不变则同 hash（幂等/无变更不重传）。 */
  release_hash: Sha256;
  files: VaultReleaseFileEntry[]; // 按 path 升序
}

export interface VaultRelease {
  manifest: VaultReleaseManifest;
  files: RenderedFile[]; // {path, markdown}·与 manifest.files 同序一一对应
}

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;
const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** 整包打 release（纯·确定性：给定 bundle → 同一 release_hash + 同序 files）。 */
export async function buildVaultRelease(bundle: VaultExportBundle, opts: { generatedAt?: string; appVersion?: string } = {}): Promise<VaultRelease> {
  const rendered = renderVaultMarkdown(toObsidianVaultRenderInput(bundle)).slice().sort(byPath);
  const files: VaultReleaseFileEntry[] = [];
  for (const f of rendered) {
    files.push({ path: f.path, content_hash: `sha256:${await sha256HexStr(f.markdown)}`, bytes: utf8Bytes(f.markdown) });
  }
  const releaseManifestLines = files.map((f) => `${f.path} ${f.content_hash}`).join('\n'); // 分隔用空格·须与 panel computeReleaseHash 同口径
  const releaseHash = await sha256HexStr(releaseManifestLines);
  return {
    manifest: {
      schema_version: VAULT_RELEASE_SCHEMA_VERSION,
      generated_at: opts.generatedAt ?? bundle.generatedAt,
      app_version: opts.appVersion ?? '0.1.0',
      release_hash: `sha256:${releaseHash}`,
      files,
    },
    files: rendered,
  };
}
