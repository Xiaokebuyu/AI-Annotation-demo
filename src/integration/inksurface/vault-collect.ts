/**
 * Vault 导出收集器（浏览器侧·读 IndexedDB）—— 枚举三类实体 → 各建 L1 导出 → assembleVaultBundle。
 *
 * 分工：InkLoop 跑在浏览器（IndexedDB·无 fs），这里产出 bundle JSON；Node 侧 scripts/export-vault.ts 落 vault。
 * dev-only（__inkloop.exportVaultBundle）。空实体（无可导出 KO 且无 projection 块）跳过——不写空壳。
 */

import { listAllMeetings, listBooks, listDiaries } from '../../local/store';
import { buildConceptLayer, type ConceptKnowledgeObjectFactory, entityModeOf } from 'ink-surface-sdk/export-core';
import { makeConceptExtractor } from './concept-extract';
import { buildL1Export } from './index';
import { buildMeetingL1Export } from './meeting-export';
import { assembleVaultBundle, type EntityExport, type VaultExportBundle } from './vault-export';
import { finalize, isInkPlaceholderBody } from '../../knowledge/builder';

/** 概念 KO 工厂：SDK 装配出的概念 draft → finalize 的 Draft（确定性 ko_id + content_hash·与其他 KO 同口径过 validator）。
 *  SDK 只调本工厂、不自己建 KO（也不碰 LLM·抽取走 makeConceptExtractor）。 */
const createConceptKo: ConceptKnowledgeObjectFactory = (draft) =>
  finalize({
    stableKey: draft.stableKey,
    kind: 'concept',
    documentId: draft.documentId,
    documentTitle: draft.documentTitle,
    titleOverride: draft.displayName,
    objectRefs: [...draft.memberKoIds],
    body: draft.bodyMarkdown,
    provenance: { created_from: 'session' },
    status: 'export_ready',
    createdAt: draft.createdAt,
  });

function nonEmpty(ex: { knowledgeExport: { objects: unknown[] }; documentProjections: { document_projections: unknown[] } }): boolean {
  return ex.knowledgeExport.objects.length > 0 || ex.documentProjections.document_projections.length > 0;
}

/**
 * ⚠️过渡过滤（笔迹重现 SVG 上线即移除）：丢掉内容为空的笔迹占位 KO（纯涂鸦圈画 / 未识别手写·body_md 恰为占位串）。
 * 否则空白页涂鸦在 Obsidian 刷屏（实测一篇日记 100+ 个占位淹没真内容）。笔迹仍在账本·不丢·将来渲成墨迹再恢复。
 * 在 nonEmpty 判定**之前**过滤 → 纯涂鸦实体（过滤后无 KO 且无 projection）自然跳过、不留空壳。
 * 会议侧 body=占位+「（约 X 处手写）」带时间上下文·不恰等占位·不命中·不误伤。详见记忆 inkloop-obsidian-clean-vault。
 */
function dropInkPlaceholders<T extends { knowledgeExport: { objects: { body_md: string }[] } }>(ex: T): T {
  ex.knowledgeExport.objects = ex.knowledgeExport.objects.filter((ko) => !isInkPlaceholderBody(ko.body_md));
  return ex;
}

export async function collectVaultBundle(
  opts: { generatedAt?: string; appVersion?: string; concepts?: boolean; conceptModel?: string } = {},
): Promise<VaultExportBundle> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const o = { generatedAt, appVersion: opts.appVersion };
  const exports: EntityExport[] = [];

  for (const b of await listBooks()) {
    // listBooks 含会议资料 PDF（mtgdoc_<会议>_<msg> 也有 blob）——它们由会议导出覆盖（marks 在 mtg_ 上下文）；
    // 这里只收真书（entityModeOf==='reading'），否则会落错夹（Reading vs meeting 标签）+ 双重导出。
    if (entityModeOf(b.document_id) !== 'reading') continue;
    const ex = dropInkPlaceholders(await buildL1Export(b.document_id, o));
    if (nonEmpty(ex)) {
      exports.push({ mode: 'reading', documentId: b.document_id, documentTitle: b.filename || b.document_id, knowledgeExport: ex.knowledgeExport, documentProjections: ex.documentProjections, activityDate: b.saved_at, warnings: ex.warnings });
    }
  }
  for (const d of await listDiaries()) {
    const ex = dropInkPlaceholders(await buildL1Export(d.document_id, o));
    if (nonEmpty(ex)) {
      exports.push({ mode: 'diary', documentId: d.document_id, documentTitle: d.filename || d.document_id, knowledgeExport: ex.knowledgeExport, documentProjections: ex.documentProjections, activityDate: d.saved_at, warnings: ex.warnings });
    }
  }
  for (const m of await listAllMeetings()) {
    const ex = dropInkPlaceholders(await buildMeetingL1Export(m.meeting_id, o));
    if (nonEmpty(ex)) {
      exports.push({ mode: 'meeting', documentId: ex.documentId, documentTitle: ex.documentTitle, knowledgeExport: ex.knowledgeExport, documentProjections: ex.documentProjections, activityDate: m.started_at ?? m.scheduled_at ?? m.created_at, warnings: ex.warnings });
    }
  }

  // 概念层（语义跨链）：收齐全部实体的 KO 后跑一遍 LLM 抽概念 → 跨文档桥成概念枢纽。
  // 失败/空不影响其余导出（buildConceptLayer 内部对每条容错·extractFn 失败返 []）。
  const allKos = exports.flatMap((e) => e.knowledgeExport.objects);
  const conceptLayer = opts.concepts === false
    ? undefined
    : await buildConceptLayer(allKos, makeConceptExtractor({ model: opts.conceptModel }), createConceptKo);

  return assembleVaultBundle(exports, { generatedAt, appVersion: opts.appVersion, conceptLayer });
}
