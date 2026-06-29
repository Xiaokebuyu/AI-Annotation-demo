/**
 * Vault 导出装配（待办1+2 汇总·纯函数·无 DOM/store·浏览器 hook 与 Node 写驱动共用）。
 *
 * 输入＝各实体已建好的 L1 导出（KO 信封 + projection 信封·已带 taxonomy 标签）；
 * 输出＝一个 bundle：每实体配好**可见落夹** `{base_dir, documents_dir}`（vault-layout）+ 一组 MOC 枢纽笔记（moc.ts）。
 * 写入端（scripts/export-vault.ts）逐实体按 folder 调 SDK adapter → 分目录 + 全量成图。
 */

import {
  DOC_PROJECTION_EXPORT_SCHEMA_VERSION,
  type DocumentProjectionExportEnvelope,
  type KnowledgeExportEnvelope,
  stampExportId,
} from './contract';
import { buildMocProjections, type MocEntity } from './moc';
import { type EntityMode, vaultFolderForEntity, vaultRootFolder } from './vault-layout';

/** 一个实体的 L1 导出切片（buildL1Export / buildMeetingL1Export 产出的子集）。 */
export interface EntityExport {
  mode: EntityMode;
  documentId: string;
  documentTitle: string;
  knowledgeExport: KnowledgeExportEnvelope;
  documentProjections: DocumentProjectionExportEnvelope;
  activityDate?: string; // 实体来源日期（书/日记 saved_at·会议 started_at）——无 KO 实体也能落对日期/进每日 MOC
  warnings?: string[];   // 导出诊断（被闸挡/未落块等）→ 写进 Export Report·不静默
}

export interface VaultBundleEntity extends EntityExport {
  folder: { base_dir: string; documents_dir: string };
  dates: string[];
}

export interface VaultExportBundle {
  schema: 'inkloop.vault_export_bundle.v1';
  generatedAt: string;
  entities: VaultBundleEntity[];
  moc: { folder: { base_dir: string; documents_dir: string }; documentProjections: DocumentProjectionExportEnvelope };
}

export interface VaultExportOpts {
  generatedAt: string;
  appVersion?: string;
  recentDailyLimit?: number;
}

/** YYYY-MM-DD 截取（仅当像 ISO 日期）。⚠️按 UTC 切日——近本地午夜写的内容可能归到 UTC 日；
 *  按设备本地时区分日是已知后续（要把 timeZone 串遍 ExportOpts→enrich→datesOf→folder，blast radius 大，暂缓）。 */
const day = (s?: string): string | undefined => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined);

/** 某实体有活动的日期（去重·升序·YYYY-MM-DD）：取 KO created_at + projection 日期 + 来源 fallbackDate。
 *  含 projection/fallback → projection-only / 无 KO 实体也能进每日 MOC、落对日期（不从时间维度消失）。 */
export function datesOf(env: KnowledgeExportEnvelope, projections?: DocumentProjectionExportEnvelope, fallbackDate?: string): string[] {
  return [
    ...new Set(
      [
        ...env.objects.map((o) => day(o.created_at)),
        ...(projections?.document_projections.map((p) => day(p.created_at) ?? day(p.generated_at)) ?? []),
        day(fallbackDate),
      ].filter((d): d is string => !!d),
    ),
  ].sort();
}

/** 实体导出 → vault bundle（配落夹 + 合成 MOC）。纯·确定性。 */
export async function assembleVaultBundle(exports: EntityExport[], opts: VaultExportOpts): Promise<VaultExportBundle> {
  const appVersion = opts.appVersion ?? '0.1.0';
  const entities: VaultBundleEntity[] = exports.map((ex) => {
    const dates = datesOf(ex.knowledgeExport, ex.documentProjections, ex.activityDate);
    const folder = vaultFolderForEntity({
      documentId: ex.documentId,
      documentTitle: ex.documentTitle,
      mode: ex.mode,
      date: dates[0], // diary 按（最早）活动日落夹；meeting 用 `<日期> <标题>`；reading 用标题
    });
    return { ...ex, folder, dates };
  });

  const mocEntities: MocEntity[] = entities.map((e) => ({ documentId: e.documentId, documentTitle: e.documentTitle, mode: e.mode, dates: e.dates }));
  const mocProjections = await buildMocProjections(mocEntities, { generatedAt: opts.generatedAt, appVersion, recentDailyLimit: opts.recentDailyLimit });

  const mocEnvelope: DocumentProjectionExportEnvelope = {
    schema_version: DOC_PROJECTION_EXPORT_SCHEMA_VERSION,
    export_id: stampExportId('projection', 'moc_root', opts.generatedAt),
    generated_at: opts.generatedAt,
    source: { app: 'inkloop', app_version: appVersion, document_id: 'moc_root' },
    document_projections: mocProjections,
    external_edits: [],
  };

  return {
    schema: 'inkloop.vault_export_bundle.v1',
    generatedAt: opts.generatedAt,
    entities,
    moc: { folder: vaultRootFolder(), documentProjections: mocEnvelope },
  };
}
