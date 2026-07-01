/**
 * Vault 导出装配（纯函数·无 DOM/store）。
 *
 * 输入＝各实体已建好的 L1 导出（KO 信封 + projection 信封·已带 taxonomy 标签）；
 * 输出＝一个 bundle：每实体配好**可见落夹** `{base_dir, documents_dir}`（SDK adapter-obsidian 的 vaultFolderForEntity）+ 概念层。
 * 渲染端（SDK adapter-obsidian renderVaultMarkdown）吃 bundle（经 vault-render-input 转）→ 干净 .md（含内联 MOC）。
 * MOC 不再在此预生成 DocumentProjection——已由 SDK adapter 内联渲染。
 */

import type { ConceptLayer, EntityMode } from 'ink-surface-sdk/export-core';
import { type VaultFolder, vaultFolderForEntity } from 'ink-surface-sdk/adapters/obsidian';
import type {
  DocumentProjectionExportEnvelope,
  KnowledgeObjectExportEnvelope as KnowledgeExportEnvelope,
  KoRelationGroup,
} from 'ink-surface-sdk/knowledge-schema';
import type { InkLoopVisualModel } from 'ink-surface-sdk/surface-model';
import type { EntityMembershipFact } from '../../knowledge/builder';

/** 一个实体的 L1 导出切片（buildL1Export / buildMeetingL1Export 产出的子集）。 */
export interface EntityExport {
  mode: EntityMode;
  documentId: string;
  documentTitle: string;
  knowledgeExport: KnowledgeExportEnvelope;
  documentProjections: DocumentProjectionExportEnvelope;
  activityDate?: string; // 实体来源日期（书/日记 saved_at·会议 started_at）——无 KO 实体也能落对日期/进每日 MOC
  warnings?: string[];   // 导出诊断（被闸挡/未落块等）→ 写进 Export Report·不静默
  entityFacts?: EntityMembershipFact[]; // 存储原生拓扑：本实体可导出 KO 的实体关联事实（vault-collect 跨实体聚合用；assembleVaultBundle 透传进 bundle JSON，但渲染器只读 conceptLayer，不读这个字段）
  materialDocIds?: string[]; // 仅 meeting 有意义：本场会议引用过的资料文档 id（来自 PersistedMeeting.material_doc_ids）
  koRelationFacts?: KoRelationGroup[]; // 存储原生拓扑：本实体可导出 KO 的 KO-KO 关系事实（vault-collect 跨实体聚合用；同 entityFacts，渲染器只读 conceptLayer）
  visualModel?: InkLoopVisualModel; // 逐笔原始墨迹（按 ko_id 挂在 annotation 上），渲染器据此在叶子内嵌 SVG 复现笔迹
}

export interface VaultBundleEntity extends EntityExport {
  folder: VaultFolder;
  dates: string[];
}

export interface VaultExportBundle {
  schema: 'inkloop.vault_export_bundle.v1';
  generatedAt: string;
  entities: VaultBundleEntity[];
  conceptLayer?: ConceptLayer; // 概念层（语义跨链）·渲染器据此出 Concepts/ 枢纽 + 叶子相关概念链接
}

export interface VaultExportOpts {
  generatedAt: string;
  appVersion?: string;
  conceptLayer?: ConceptLayer; // 由 vault-collect 跑 buildConceptLayer（LLM）后传入·纯装配不调 LLM
}

/** YYYY-MM-DD 截取（仅当像 ISO 日期）。⚠️按 UTC 切日——近本地午夜写的内容可能归到 UTC 日。 */
const day = (s?: string): string | undefined => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined);

/** 某实体有活动的日期（去重·升序·YYYY-MM-DD）：KO created_at（真内容时刻）+ 来源 fallbackDate（saved_at/started_at）。 */
export function datesOf(env: KnowledgeExportEnvelope, fallbackDate?: string): string[] {
  return [...new Set([...env.objects.map((o) => day(o.created_at)), day(fallbackDate)].filter((d): d is string => !!d))].sort();
}

/** 实体导出 → vault bundle（配落夹 + 概念层）。纯·确定性。 */
export async function assembleVaultBundle(exports: EntityExport[], opts: VaultExportOpts): Promise<VaultExportBundle> {
  const entities: VaultBundleEntity[] = exports.map((ex) => {
    const dates = datesOf(ex.knowledgeExport, ex.activityDate);
    const folder = vaultFolderForEntity({
      documentId: ex.documentId,
      documentTitle: ex.documentTitle,
      mode: ex.mode,
      date: dates[0], // diary 按（最早）活动日落夹；meeting 用 `<日期> <标题>`；reading 用标题
    });
    return { ...ex, folder, dates };
  });

  return {
    schema: 'inkloop.vault_export_bundle.v1',
    generatedAt: opts.generatedAt,
    entities,
    ...(opts.conceptLayer ? { conceptLayer: opts.conceptLayer } : {}),
  };
}
