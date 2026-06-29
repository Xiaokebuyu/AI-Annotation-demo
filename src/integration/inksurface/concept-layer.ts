/**
 * 概念层（全量感知的语义跃迁）—— 把 AI 读出的「概念」物化成 concept KO + 笔记↔概念边，让想法跨书/会/日记连成网。
 *
 * 设计约束（已与用户对齐）：
 *  · **概念中介**：笔记都连到共享概念枢纽（`[[缓存一致性]]` 底下挂成员），不让笔记两两连（防 N² 毛球）。
 *  · **确定性身份**：concept stableKey=`concept:<规范名>` → ko_id 确定性（跨重导出稳定·跨文档天然合并）。
 *  · **两级门槛**（真 LLM 探针后定）：
 *      - **primary**（≥minMembers 成员 且 跨 ≥minDocs 文档）= 跨文档桥 → 物化成全局概念枢纽 hub 文件，进概念星系。
 *      - **local**（单文档内 ≥minLocalMembers 成员复现）= 本地概念 → 只给叶子打 `#topic` 标签、**不建 hub 文件**（不污染全局星系，
 *        但用户写过的真概念不从图里凭空消失）。**晋升免状态**：本管线无状态重算，本地概念哪天跨到第二个文档，自动变 primary。
 *      - 单笔（成员=1）= 连不上任何东西 → 丢（不出标签/不出 hub）。
 *  · 智能在我方管线（LLM 抽概念走 /api/chat·证据接地+置信度闸在 concept-extract）；Obsidian 只渲染算好的 `[[链接]]`/`#topic`。
 *
 * 纯核心：`buildConceptLayer` 注入 `extractFn`（真实现=LLM+缓存）→ 可单测（假 extractFn）。输出 JSON 可序列化（进 vault bundle）。
 */

import { type Draft, finalize } from '../../knowledge/builder';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';

/** 概念空间的合成文档 id（concept KO 不属于任何真实文档）。 */
export const CONCEPT_DOC_ID = 'inkloop_concepts';

/** 抽取器：读一条 KO → 返回它触及的规范概念词（真实现负责 LLM 调用 + 按 content_hash 缓存）。 */
export type ConceptExtractFn = (ko: KnowledgeObject) => Promise<string[]>;

/** 概念登记项（规范名 → 显示名/成员/文档集/最早日期）。也是 merge seam 的输入元素。 */
export interface ConceptReg {
  display: string;
  koIds: string[];
  docs: Set<string>;
  earliest: string;
}

export interface ConceptLayer {
  concepts: KnowledgeObject[]; // kind='concept' 的 primary 枢纽 KO（title=概念名·建 hub 文件）
  assignmentsByKo: Record<string, string[]>; // koId → 命中的 primary 概念显示名[]（叶子加 相关概念：[[X]] + #topic）
  membersByConcept: Record<string, string[]>; // primary 概念显示名 → 成员 koId[]（hub 列成员）
  localByKo: Record<string, string[]>; // koId → 本地（单文档）概念显示名[]（叶子只加 #topic 标签·无 hub 文件）
}

export interface ConceptOpts {
  topK?: number; // 每笔最多连几个概念（默认 3）
  minMembers?: number; // primary 最小成员数（默认 2）
  minDocs?: number; // 且跨最少几个不同 document（默认 2·确保是跨文档桥）
  minLocalMembers?: number; // local 最小成员数（默认 2·单文档内复现才算·避免单笔噪声）
  /** 语义合并 seam（注入式·v2 接 embedding/LLM）：给定规范名登记表 → 返回 aliasKey→canonicalKey 映射（扁平·非链式）。
   *  默认不传=不合并（当前靠 prompt「别造近义词」把关；真·近义合并如「语义层≈抽象层级」需语义判断，留 v2-embedding）。 */
  merge?: (reg: ReadonlyMap<string, ConceptReg>) => Map<string, string>;
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

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 解析别名链到终点 canonical（处理 a→b→c）；遇环或终点不在 reg 则返回 undefined（忽略该合并）。 */
function resolveMergeTarget(key: string, aliasMap: ReadonlyMap<string, string>, reg: ReadonlyMap<string, ConceptReg>): string | undefined {
  let cur = key;
  const seen = new Set<string>();
  for (;;) {
    const next = aliasMap.get(cur);
    if (!next || next === cur) return reg.has(cur) ? cur : undefined;
    if (seen.has(cur) || seen.has(next)) return undefined; // 环：忽略
    seen.add(cur);
    cur = next;
  }
}

/** 应用 merge seam：把 aliasKey 的成员/文档/最早日期并进**终点** canonicalKey，删 alias，并把 rawByKo 扁平重映射（去重）。 */
function applyMerge(reg: Map<string, ConceptReg>, rawByKo: Map<string, string[]>, aliasMap: Map<string, string>): void {
  // 先把每个 alias 解析到终点（链式 a→b→c 一跳到位·别名处理序排序保确定性）。
  const redirects = new Map<string, string>();
  for (const alias of [...aliasMap.keys()].sort(cmp)) {
    const canon = resolveMergeTarget(alias, aliasMap, reg);
    if (!canon || alias === canon || !reg.has(alias)) continue;
    redirects.set(alias, canon);
  }
  for (const [alias, canon] of redirects) {
    const a = reg.get(alias);
    const c = reg.get(canon);
    if (!a || !c) continue;
    for (const id of a.koIds) if (!c.koIds.includes(id)) c.koIds.push(id);
    for (const d of a.docs) c.docs.add(d);
    if (a.earliest < c.earliest) c.earliest = a.earliest;
    reg.delete(alias);
  }
  for (const [koId, norms] of rawByKo) {
    const mapped: string[] = [];
    for (const n of norms) {
      const m = redirects.get(n) ?? n;
      if (!mapped.includes(m)) mapped.push(m);
    }
    rawByKo.set(koId, mapped);
  }
}

/**
 * KO[] + 抽取器 → 概念层。纯·确定性（给定 extractFn）。
 * 不变量：① 概念身份按规范名归并（同概念跨文档合一）；② 两级门槛（primary=跨文档桥建 hub / local=单文档复现只打标签 / 单笔丢）；
 *        ③ concept ko_id 确定性（stableKey=concept:<规范名>·重导出不漂移）。
 */
export async function buildConceptLayer(kos: KnowledgeObject[], extract: ConceptExtractFn, opts: ConceptOpts = {}): Promise<ConceptLayer> {
  const topK = opts.topK ?? 3;
  const minMembers = Math.max(2, opts.minMembers ?? 2); // 夹 ≥2：单笔永远不成桥/不进 local（防退化配置）
  const minDocs = Math.max(2, opts.minDocs ?? 2);
  const minLocalMembers = Math.max(2, opts.minLocalMembers ?? 2);

  // ① 逐 KO 抽概念（跳占位）。reg: 规范名 → {显示名, 成员, 文档集, 最早日期}；rawByKo: koId → 命中规范名[]。
  // **稳定排序**：显示名取「首见」，而首见依赖输入顺序（collectVaultBundle 按 saved_at 倒序·重开书会变序）→
  // 同概念抽到 `Cache Coherence`/`cache coherence` 时 ko_id 不漂、但 title/hash/文件名会漂。按 (created_at, ko_id) 定序即确定性。
  const ordered = [...kos].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.ko_id.localeCompare(b.ko_id));
  const koOrder = new Map(ordered.map((ko, i) => [ko.ko_id, i] as const)); // 稳定成员序基准（merge 后重排用）
  const reg = new Map<string, ConceptReg>();
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

  // ①.5 语义合并（注入式 seam·默认无）：抽完、过门槛前做一次近义归并（v2 接 embedding/LLM）。
  if (opts.merge) applyMerge(reg, rawByKo, opts.merge(reg));
  // merge 会按 aliasMap 序追加成员→成员序漂；统一按 KO 稳定序重排（无 merge 时已是该序·幂等）。
  for (const e of reg.values()) e.koIds.sort((a, b) => (koOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (koOrder.get(b) ?? Number.MAX_SAFE_INTEGER) || cmp(a, b));

  // ② 两级分层：primary=跨文档桥（≥minMembers 且 ≥minDocs）；local=**单文档**复现（docs==1 且 ≥minLocalMembers）；单笔/其余丢。
  const primaryKeys = new Set<string>();
  const localKeys = new Set<string>();
  for (const [k, e] of reg) {
    if (e.koIds.length >= minMembers && e.docs.size >= minDocs) primaryKeys.add(k);
    else if (e.docs.size === 1 && e.koIds.length >= minLocalMembers) localKeys.add(k);
  }

  // ③ 物化 primary concept KO（确定性 stableKey + createdAt=最早成员日期·hash 稳定）。
  // membersByConcept/assignmentsByKo/localByKo 的 key 来自 LLM 概念名——用 null 原型对象，防真概念名命中 `__proto__`/`constructor` 触发原型 setter 致成员边丢失。
  const concepts: KnowledgeObject[] = [];
  const membersByConcept: Record<string, string[]> = Object.create(null);
  // 显式定序物化（earliest→display→key）：concept[] 顺序确定 → 渲染器 namer 撞名消歧不随 reg 插入序漂。
  const orderedPrimaryKeys = [...primaryKeys].sort((a, b) => {
    const ea = reg.get(a);
    const eb = reg.get(b);
    return cmp(ea?.earliest ?? '', eb?.earliest ?? '') || cmp(ea?.display ?? '', eb?.display ?? '') || cmp(a, b);
  });
  for (const k of orderedPrimaryKeys) {
    const e = reg.get(k);
    if (!e) continue;
    concepts.push(
      await finalize({
        stableKey: `concept:${k}`,
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

  // ④ assignments（primary·叶子→hub）+ localByKo（local·叶子→只打标签）：koId → 命中的概念显示名。
  const assignmentsByKo: Record<string, string[]> = Object.create(null);
  const localByKo: Record<string, string[]> = Object.create(null);
  const displayOf = (norms: string[], keys: Set<string>): string[] =>
    norms.filter((n) => keys.has(n)).map((n) => reg.get(n)?.display).filter((d): d is string => !!d);
  for (const [koId, norms] of rawByKo) {
    const primary = displayOf(norms, primaryKeys);
    const local = displayOf(norms, localKeys);
    if (primary.length) assignmentsByKo[koId] = primary;
    if (local.length) localByKo[koId] = local;
  }

  return { concepts, assignmentsByKo, membersByConcept, localByKo };
}
