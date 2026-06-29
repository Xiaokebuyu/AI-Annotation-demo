/**
 * Vault 导出收集器（浏览器侧·读 IndexedDB）—— 枚举三类实体 → 各建 L1 导出 → assembleVaultBundle。
 *
 * 分工：InkLoop 跑在浏览器（IndexedDB·无 fs），这里产出 bundle JSON；Node 侧 scripts/export-vault.ts 落 vault。
 * dev-only（__inkloop.exportVaultBundle）。空实体（无可导出 KO 且无 projection 块）跳过——不写空壳。
 */

import { listAllMeetings, listBooks, listDiaries } from '../../local/store';
import { buildL1Export } from './index';
import { buildMeetingL1Export } from './meeting-export';
import { assembleVaultBundle, type EntityExport, type VaultExportBundle } from './vault-export';
import { entityModeOf } from './vault-layout';

function nonEmpty(ex: { knowledgeExport: { objects: unknown[] }; documentProjections: { document_projections: unknown[] } }): boolean {
  return ex.knowledgeExport.objects.length > 0 || ex.documentProjections.document_projections.length > 0;
}

export async function collectVaultBundle(opts: { generatedAt?: string; appVersion?: string } = {}): Promise<VaultExportBundle> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const o = { generatedAt, appVersion: opts.appVersion };
  const exports: EntityExport[] = [];

  for (const b of await listBooks()) {
    // listBooks 含会议资料 PDF（mtgdoc_<会议>_<msg> 也有 blob）——它们由会议导出覆盖（marks 在 mtg_ 上下文）；
    // 这里只收真书（entityModeOf==='reading'），否则会落错夹（Reading vs meeting 标签）+ 双重导出。
    if (entityModeOf(b.document_id) !== 'reading') continue;
    const ex = await buildL1Export(b.document_id, o);
    if (nonEmpty(ex)) {
      exports.push({ mode: 'reading', documentId: b.document_id, documentTitle: b.filename || b.document_id, knowledgeExport: ex.knowledgeExport, documentProjections: ex.documentProjections, activityDate: b.saved_at, warnings: ex.warnings });
    }
  }
  for (const d of await listDiaries()) {
    const ex = await buildL1Export(d.document_id, o);
    if (nonEmpty(ex)) {
      exports.push({ mode: 'diary', documentId: d.document_id, documentTitle: d.filename || d.document_id, knowledgeExport: ex.knowledgeExport, documentProjections: ex.documentProjections, activityDate: d.saved_at, warnings: ex.warnings });
    }
  }
  for (const m of await listAllMeetings()) {
    const ex = await buildMeetingL1Export(m.meeting_id, o);
    if (nonEmpty(ex)) {
      exports.push({ mode: 'meeting', documentId: ex.documentId, documentTitle: ex.documentTitle, knowledgeExport: ex.knowledgeExport, documentProjections: ex.documentProjections, activityDate: m.started_at ?? m.scheduled_at ?? m.created_at, warnings: ex.warnings });
    }
  }

  return assembleVaultBundle(exports, { generatedAt, appVersion: opts.appVersion });
}
