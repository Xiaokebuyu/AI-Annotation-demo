/**
 * Vault 导出收集器（浏览器侧·读 IndexedDB）—— 枚举三类实体 → 各建 L1 导出 → assembleVaultBundle。
 *
 * 分工：InkLoop 跑在浏览器（IndexedDB·无 fs），这里产出 bundle JSON；Node 侧 scripts/export-vault.ts 落 vault。
 * dev-only（__inkloop.exportVaultBundle）。空实体（无可导出 KO 且无 projection 块）跳过——不写空壳。
 */

import { getDoc, getMeeting, listAllMeetings, listBooks, listCanonicalEntities, listDiaries } from '../../local/store';
import {
  buildConceptLayer,
  buildConceptLayerFromStoredMemberships,
  type ConceptKnowledgeObjectFactory,
  type ConceptLayer,
  entityModeOf,
} from 'ink-surface-sdk/export-core';
import { makeConceptExtractor } from './concept-extract';
import { buildL1Export } from './index';
import { buildMeetingL1Export } from './meeting-export';
import { assembleVaultBundle, type EntityExport, type VaultExportBundle } from './vault-export';
import { finalize, isInkPlaceholderBody, projectEntities, type EntityMembershipFact } from '../../knowledge/builder';
import type { KoRelationGroup } from 'ink-surface-sdk/knowledge-schema';
import type { InkLoopVisualModel } from 'ink-surface-sdk/surface-model';

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

function strokeKoIds(model: InkLoopVisualModel | undefined): Set<string> {
  return new Set(
    (model?.blocks ?? []).flatMap((block) =>
      (block.annotations ?? [])
        .filter((a) => (a.surface_strokes ?? []).some((s) => s.points.length > 0) || (a.visual_strokes ?? []).some((s) => s.points.length > 0))
        .map((a) => a.ko_id),
    ),
  );
}

/**
 * 丢掉内容为空的笔迹占位 KO（纯涂鸦圈画 / 未识别手写·body_md 恰为占位串）。否则空白页涂鸦在 Obsidian 刷屏
 * （实测一篇日记 100+ 个占位淹没真内容）。笔迹仍在账本·不丢。
 * 在 nonEmpty 判定**之前**过滤 → 纯涂鸦实体（过滤后无 KO 且无 projection）自然跳过、不留空壳。
 * 会议侧 body=占位+「（约 X 处手写）」带时间上下文·不恰等占位·不命中·不误伤。详见记忆 inkloop-obsidian-clean-vault。
 * ⚠️两个例外（占位 KO 命中任一都不过滤）：
 *   · entity_refs/topic_refs（用户明确"归类"过这条笔迹）——那是用户显式声明的关系，过滤掉=无声丢失。
 *   · visualModel 里挂了真笔迹（surface_strokes/visual_strokes 非空）——SVG 内嵌导出已上线，即使 marked_text
 *     为空，Obsidian 里也能直接看到真实笔迹图，不该被当无内容占位吞掉。
 */
export function dropInkPlaceholders<T extends {
  knowledgeExport: { objects: { ko_id: string; body_md: string }[] };
  entityFacts?: EntityMembershipFact[];
  koRelationFacts?: KoRelationGroup[];
  visualModel?: InkLoopVisualModel;
}>(ex: T): T {
  const refKoIds = new Set((ex.entityFacts ?? []).map((f) => f.ko_id));
  const inkKoIds = strokeKoIds(ex.visualModel);
  const kept = new Set<string>();
  ex.knowledgeExport.objects = ex.knowledgeExport.objects.filter((ko) => {
    const keep = !isInkPlaceholderBody(ko.body_md) || refKoIds.has(ko.ko_id) || inkKoIds.has(ko.ko_id);
    if (keep) kept.add(ko.ko_id);
    return keep;
  });
  if (ex.entityFacts) ex.entityFacts = ex.entityFacts.filter((f) => kept.has(f.ko_id));
  if (ex.koRelationFacts) {
    ex.koRelationFacts = ex.koRelationFacts
      .map((g) => ({ ...g, ko_ids: g.ko_ids.filter((id) => kept.has(id)) }))
      .filter((g) => g.ko_ids.length >= 2);
  }
  if (ex.visualModel) {
    ex.visualModel = { ...ex.visualModel, blocks: ex.visualModel.blocks.map((b) => ({ ...b, annotations: b.annotations.filter((a) => kept.has(a.ko_id)) })) };
  }
  return ex;
}

/** 合并「存储原生拓扑层」与「legacy LLM 概念层」成渲染器吃的单一 ConceptLayer。两者字段形状一致（P1），
 *  逐字段并集去重；任一缺失直接透传另一个。concepts/hubs 都并（渲染器 hub 来源=hubs??concepts 映射，
 *  只并 hubs 会让 llm 的 concepts 在没有 hubs 时静默消失，所以两边都显式转成 hub 再并）。
 *  ⚠️hubs 必须按 title 去重（同名归一后取一条）：SDK 渲染器用 `Map(hubs.map(h=>[h.title,namer(h.title)]))` 建
 *  文件名——重复 title 会被 namer 分配成两个不同文件名，但 Map 只留最后一次的映射，导致两条 hub 循环各写一份
 *  文件却都解析到同一个（后写的）路径：一份文件名被分配了却没人真正用、另一份被两次写入互相覆盖。 */
export function mergeConceptLayers(stored: ConceptLayer | undefined, llm: ConceptLayer | undefined): ConceptLayer | undefined {
  if (!stored && !llm) return undefined;
  if (!stored) return llm;
  if (!llm) return stored;

  const mergeRecord = (a: Record<string, string[]> | undefined, b: Record<string, string[]> | undefined): Record<string, string[]> => {
    const out: Record<string, string[]> = { ...(a ?? {}) };
    for (const [k, v] of Object.entries(b ?? {})) out[k] = [...new Set([...(out[k] ?? []), ...v])];
    return out;
  };

  const titleKey = (title: string): string => title.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const dedupeHubs = (hubs: NonNullable<ConceptLayer['hubs']>): NonNullable<ConceptLayer['hubs']> => {
    const byKey = new Map<string, NonNullable<ConceptLayer['hubs']>[number]>();
    for (const hub of hubs) {
      const key = titleKey(hub.title);
      const cur = byKey.get(key);
      if (!cur || (!cur.entity_id && hub.entity_id)) byKey.set(key, hub); // 优先保留带 entity_id 的（存储原生更权威）
    }
    return [...byKey.values()];
  };

  return {
    concepts: [...stored.concepts, ...llm.concepts],
    hubs: dedupeHubs([...(stored.hubs ?? []), ...(llm.hubs ?? llm.concepts.map((ko) => ({ title: ko.title })))]),
    assignmentsByKo: mergeRecord(stored.assignmentsByKo, llm.assignmentsByKo),
    membersByConcept: mergeRecord(stored.membersByConcept, llm.membersByConcept),
    localByKo: mergeRecord(stored.localByKo, llm.localByKo),
    entityIdsByKo: mergeRecord(stored.entityIdsByKo, llm.entityIdsByKo),
    membersByEntity: mergeRecord(stored.membersByEntity, llm.membersByEntity),
  };
}

export async function collectVaultBundle(
  opts: { generatedAt?: string; appVersion?: string; concepts?: boolean; conceptModel?: string; storedEntities?: boolean } = {},
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
      exports.push({ mode: 'reading', documentId: b.document_id, documentTitle: b.filename || b.document_id, knowledgeExport: ex.knowledgeExport, documentProjections: ex.documentProjections, activityDate: b.saved_at, warnings: ex.warnings, entityFacts: ex.entityFacts, koRelationFacts: ex.koRelationFacts, visualModel: ex.visualModel });
    }
  }
  for (const d of await listDiaries()) {
    const ex = dropInkPlaceholders(await buildL1Export(d.document_id, o));
    if (nonEmpty(ex)) {
      exports.push({ mode: 'diary', documentId: d.document_id, documentTitle: d.filename || d.document_id, knowledgeExport: ex.knowledgeExport, documentProjections: ex.documentProjections, activityDate: d.saved_at, warnings: ex.warnings, entityFacts: ex.entityFacts, koRelationFacts: ex.koRelationFacts, visualModel: ex.visualModel });
    }
  }
  for (const m of await listAllMeetings()) {
    const ex = dropInkPlaceholders(await buildMeetingL1Export(m.meeting_id, o));
    if (nonEmpty(ex)) {
      exports.push({ mode: 'meeting', documentId: ex.documentId, documentTitle: ex.documentTitle, knowledgeExport: ex.knowledgeExport, documentProjections: ex.documentProjections, activityDate: m.started_at ?? m.scheduled_at ?? m.created_at, warnings: ex.warnings, entityFacts: ex.entityFacts, materialDocIds: [...new Set(m.material_doc_ids ?? [])].sort(), koRelationFacts: ex.koRelationFacts, visualModel: ex.visualModel });
    }
  }

  const allKos = exports.flatMap((e) => e.knowledgeExport.objects);

  // 存储原生拓扑层（零 LLM）：账本 entity_refs/topic_refs 的确定性投影。默认开——账本没有 refs 时这层
  // 自然是空的（无害），但一旦有 refs（P4 采集声明/P5 后台建议写回）就该在**任何**导出路径生效，不该要
  // 每个调用方都记得显式传 true；concepts:false 的零 LLM 发布路径尤其依赖这条默认值才算兑现"零 LLM 也能
  // 产出拓扑"的承诺。显式传 storedEntities:false 才关。
  let storedLayer: ConceptLayer | undefined;
  if (opts.storedEntities !== false) {
    const allEntityFacts = exports.flatMap((e) => e.entityFacts ?? []);
    const allKoRelationFacts = exports.flatMap((e) => e.koRelationFacts ?? []);
    const registry = await listCanonicalEntities();
    const { entities, memberships } = projectEntities(allEntityFacts, registry);
    storedLayer = buildConceptLayerFromStoredMemberships(allKos, entities, memberships, allKoRelationFacts);
  }

  // 概念层（语义跨链·可选）：收齐全部实体的 KO 后跑一遍 LLM 抽概念 → 跨文档桥成概念枢纽。
  // 失败/空不影响其余导出（buildConceptLayer 内部对每条容错·extractFn 失败返 []）。
  const llmLayer = opts.concepts === false
    ? undefined
    : await buildConceptLayer(allKos, makeConceptExtractor({ model: opts.conceptModel }), createConceptKo);

  const conceptLayer = mergeConceptLayers(storedLayer, llmLayer);

  return assembleVaultBundle(exports, { generatedAt, appVersion: opts.appVersion, conceptLayer });
}

/** 单实体引用（会议用 meetingId 找·书/日记用 documentId 找——两者查找键不同，故分支而非共用 id 字段）。 */
export type VaultEntityRef = { mode: 'meeting'; meetingId: string } | { mode: 'reading' | 'diary'; documentId: string };

/**
 * 单实体收集（阶段⑤·按需导出预检用）：只建这一个实体的 L1 导出切片，不装配整包 bundle（MOC/概念层是跨实体的，
 * 单实体天然没有）。用于「导出到 Obsidian」按钮判断这场会议/这本书有没有可导出内容 + 拿标题。
 * ⚠️真正发布仍要走 collectVaultBundle 整包通道（见其头注）——panel `latest release` 是全量快照语义，
 * 单独发一个实体的 release 会把其它实体从 Obsidian 端删掉。单实体最小化发布待 panel 加实体端点后才能做。
 */
export async function collectVaultEntity(ref: VaultEntityRef, opts: { generatedAt?: string; appVersion?: string } = {}): Promise<EntityExport | null> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const o = { generatedAt, appVersion: opts.appVersion };
  // ⚠️「实体不存在」和「实体存在但没内容」是两回事——前者是错误(调用方传了脏/已删的 id)，
  // 后者是合法态(该会议/文档确实还没手写)。混成同一个 null 会让 publishEntityToVault 把
  // "会议已被删除"误判成 entityEmpty 轻提示静默放过（codex 抓）。not-found 改抛错。
  if (ref.mode === 'meeting') {
    const m = await getMeeting(ref.meetingId);
    if (!m) throw new Error(`会议不存在或已被删除：${ref.meetingId}`);
    const ex = dropInkPlaceholders(await buildMeetingL1Export(ref.meetingId, o));
    if (!nonEmpty(ex)) return null;
    return { mode: 'meeting', documentId: ex.documentId, documentTitle: ex.documentTitle, knowledgeExport: ex.knowledgeExport, documentProjections: ex.documentProjections, activityDate: m.started_at ?? m.scheduled_at ?? m.created_at, warnings: ex.warnings, entityFacts: ex.entityFacts, materialDocIds: [...new Set(m.material_doc_ids ?? [])].sort(), koRelationFacts: ex.koRelationFacts, visualModel: ex.visualModel };
  }
  const doc = await getDoc(ref.documentId);
  if (!doc) throw new Error(`文档不存在或已被删除：${ref.documentId}`);
  const ex = dropInkPlaceholders(await buildL1Export(ref.documentId, o));
  if (!nonEmpty(ex)) return null;
  return { mode: ref.mode, documentId: ref.documentId, documentTitle: doc.filename || ref.documentId, knowledgeExport: ex.knowledgeExport, documentProjections: ex.documentProjections, activityDate: doc.saved_at, warnings: ex.warnings, entityFacts: ex.entityFacts, koRelationFacts: ex.koRelationFacts, visualModel: ex.visualModel };
}
