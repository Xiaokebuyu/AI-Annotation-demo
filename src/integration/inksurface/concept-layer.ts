/**
 * 概念层（全量感知的语义跃迁）—— 把 AI 读出的「概念」物化成 concept KO + 笔记↔概念边，让想法跨书/会/日记连成网。
 *
 * 设计约束（已与用户对齐）：
 *  · **概念中介**：笔记都连到共享概念枢纽（`[[缓存一致性]]` 底下挂成员），不让笔记两两连（防 N² 毛球）。
 *  · **确定性身份**：concept stableKey=`concept:<规范名>` → ko_id 确定性（跨重导出稳定·跨文档天然合并）。
 *  · **克制**：只留「≥minMembers 个成员、且跨 ≥minDocs 个不同文档」的概念——确保它是**跨文档的桥**、不是噪声。
 *  · 智能在我方管线（LLM 抽概念走 /api/chat·缓存按 content_hash）；Obsidian 只渲染算好的 `[[链接]]`/`#topic`。
 *
 * 纯核心：`buildConceptLayer` 注入 `extractFn`（真实现=LLM+缓存）→ 可单测（假 extractFn）。输出 JSON 可序列化（进 vault bundle）。
 */

import { type Draft, finalize } from '../../knowledge/builder';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';

/** 概念空间的合成文档 id（concept KO 不属于任何真实文档）。 */
export const CONCEPT_DOC_ID = 'inkloop_concepts';

/** 抽取器：读一条 KO → 返回它触及的规范概念词（真实现负责 LLM 调用 + 按 content_hash 缓存）。 */
export type ConceptExtractFn = (ko: KnowledgeObject) => Promise<string[]>;

export interface ConceptLayer {
  concepts: KnowledgeObject[]; // kind='concept' 的枢纽 KO（title=概念名）
  assignmentsByKo: Record<string, string[]>; // koId → 命中的概念显示名[]（渲染器给叶子加 相关概念：[[X]]）
  membersByConcept: Record<string, string[]>; // 概念显示名 → 成员 koId[]（概念枢纽列成员）
}

export interface ConceptOpts {
  topK?: number; // 每笔最多连几个概念（默认 3）
  minMembers?: number; // 概念最小成员数（默认 2）
  minDocs?: number; // 且跨最少几个不同 document（默认 2·确保是跨文档桥）
}

/** 占位/无价值正文——不参与概念抽取（否则产垃圾概念）。 */
const PLACEHOLDER = new Set(['（图形标注 / 圈画）', '（未识别手写）', '（无文字转写）', '（无转写）', '（这段）']);

/** 剥掉会议手写体尾巴「（约 m:ss 处手写）」再判占位——否则纯图形手写 `（图形标注 / 圈画）　（约 0:16 处手写）`
 *  逃过 exact-match，被当真笔送 LLM、可能抽出假概念「图形标注」并满足跨文档门槛（见 meeting-export.ts:168）。 */
function conceptBody(body: string): string {
  return body.trim().replace(/[\s　]*[（(]约[^)）]*处手写[)）]\s*$/u, '').trim();
}

/** 概念身份规范化：NFKC + 压空白 + 折大小写。仅用于**归并/去重键**，显示名保留首见原样。 */
export function normConcept(s: string): string {
  return s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

interface Reg {
  display: string;
  koIds: string[];
  docs: Set<string>;
  earliest: string;
}

/**
 * KO[] + 抽取器 → 概念层。纯·确定性（给定 extractFn）。
 * 不变量：① 概念身份按规范名归并（同概念跨文档合一）；② 只留跨文档桥（≥minMembers 且 ≥minDocs）；
 *        ③ concept ko_id 确定性（stableKey=concept:<规范名>·重导出不漂移）。
 */
export async function buildConceptLayer(kos: KnowledgeObject[], extract: ConceptExtractFn, opts: ConceptOpts = {}): Promise<ConceptLayer> {
  const topK = opts.topK ?? 3;
  const minMembers = opts.minMembers ?? 2;
  const minDocs = opts.minDocs ?? 2;

  // ① 逐 KO 抽概念（跳占位）。reg: 规范名 → {显示名, 成员, 文档集, 最早日期}；rawByKo: koId → 命中规范名[]。
  // **稳定排序**：显示名取「首见」，而首见依赖输入顺序（collectVaultBundle 按 saved_at 倒序·重开书会变序）→
  // 同概念抽到 `Cache Coherence`/`cache coherence` 时 ko_id 不漂、但 title/hash/文件名会漂。按 (created_at, ko_id) 定序即确定性。
  const ordered = [...kos].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.ko_id.localeCompare(b.ko_id));
  const reg = new Map<string, Reg>();
  const rawByKo = new Map<string, string[]>();
  for (const ko of ordered) {
    if (PLACEHOLDER.has(conceptBody(ko.body_md))) continue;
    const names = (await extract(ko)).map((n) => n.trim()).filter(Boolean).slice(0, topK);
    const koNorms: string[] = [];
    for (const name of names) {
      const key = normConcept(name);
      if (!key) continue;
      if (!koNorms.includes(key)) koNorms.push(key);
      const e = reg.get(key) ?? { display: name, koIds: [], docs: new Set<string>(), earliest: ko.created_at };
      if (!e.koIds.includes(ko.ko_id)) e.koIds.push(ko.ko_id);
      e.docs.add(ko.source.document_id);
      if (ko.created_at < e.earliest) e.earliest = ko.created_at;
      reg.set(key, e);
    }
    if (koNorms.length) rawByKo.set(ko.ko_id, koNorms);
  }

  // ② 选择性：只留跨文档桥（≥minMembers 成员且跨 ≥minDocs 文档）。
  const kept = [...reg.entries()].filter(([, e]) => e.koIds.length >= minMembers && e.docs.size >= minDocs);
  const keptKeys = new Set(kept.map(([k]) => k));

  // ③ 物化 concept KO（确定性 stableKey + createdAt=最早成员日期·hash 稳定）。
  // membersByConcept/assignmentsByKo 的 key 来自 LLM 概念名——用 null 原型对象，防真概念名命中 `__proto__`/`constructor` 触发原型 setter 致成员边丢失。
  const concepts: KnowledgeObject[] = [];
  const membersByConcept: Record<string, string[]> = Object.create(null);
  for (const [key, e] of kept) {
    concepts.push(
      await finalize({
        stableKey: `concept:${key}`,
        kind: 'concept',
        documentId: CONCEPT_DOC_ID,
        documentTitle: e.display,
        titleOverride: e.display,
        objectRefs: [],
        body: e.display, // 简述占位·成员列表由渲染器据 membersByConcept 生成
        provenance: { created_from: 'session' },
        status: 'export_ready',
        createdAt: e.earliest,
      } satisfies Draft),
    );
    membersByConcept[e.display] = e.koIds;
  }

  // ④ assignments：koId → 命中的（被保留的）概念显示名。
  const assignmentsByKo: Record<string, string[]> = Object.create(null);
  for (const [koId, norms] of rawByKo) {
    const names = norms.filter((n) => keptKeys.has(n)).map((n) => reg.get(n)?.display).filter((d): d is string => !!d);
    if (names.length) assignmentsByKo[koId] = names;
  }

  return { concepts, assignmentsByKo, membersByConcept };
}
