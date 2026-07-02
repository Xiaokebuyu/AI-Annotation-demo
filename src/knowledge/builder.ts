/**
 * KnowledgeBuilder —— Tier 2 语义账本（marks + ai_turns）→ KnowledgeObject 的**适配器/投影**。
 *
 * 数据架构总纲：同一真相 → 适配器 → 各消费方。这是"知识笔记"投影：把账本折叠成对外 KO，
 * 交给协作方的 Obsidian/Notion 适配器。**不改任何真相 schema、不碰基岩**——纯派生、每次现算、不落库。
 *
 * 分两层，便于无 IndexedDB 的 node 单测：
 *   · assembleKnowledgeObjects(input) —— **纯转换核心**，吃已加载的 doc/marks/aiTurns（可单测）。
 *   · buildKnowledgeObjects(documentId) / exportKnowledgeObjects —— store 取数后调核心（运行态/导出）。
 *
 * ko_id / content_hash 用**确定性**派生（非随机 ULID）：KO 不落库、每次重建，随机 id 会让身份漂移、
 * 毁掉 content_hash 去重；确定性派生（hash 自稳定源 id）才真满足契约要的"跨端稳定身份"。
 */
import type { LedgerEntityRef, PersistedAiTurn, PersistedEntity, PersistedMark } from '../core/store-format';
import { getBookAiTurns, getDoc, getFoldedMarks, listBooks } from '../local/store';
import { type EntityMode, taxonomyTags } from 'ink-surface-sdk/export-core';
import type { EntityMembership, KnowledgeEntity, KoRelationGroup } from 'ink-surface-sdk/knowledge-schema';
import {
  KO_SCHEMA_VERSION,
  type KnowledgeKind,
  type KnowledgeObject,
  type KnowledgeStatus,
  type MarkdownCallout,
  type NormBBox,
  type Sha256,
} from './knowledge-object';

/** 纯核心的输入：已从账本取好的一本书的真相切片。 */
export interface BuilderInput {
  document_id: string;
  document_title: string;
  marks: PersistedMark[]; // getFoldedMarks：活 mark（已折 tombstone）
  aiTurns: PersistedAiTurn[]; // getBookAiTurns：每 overlay_id 最新一条（含 dismissed/folded）
}

/* ── 默认/映射表（契约 §3）──────────────────────────────────────────────── */

const CALLOUT: Partial<Record<KnowledgeKind, MarkdownCallout>> = {
  ai_note: 'note',
  qa: 'question',
  excerpt: 'quote',
  annotation: 'note',
  summary: 'summary',
  task: 'todo',
  concept: 'tip',
};

/** overlay_state → KnowledgeStatus。folded 在调用前已剔除（写给自己·不导出）。 */
function statusFromOverlay(s: PersistedAiTurn['overlay_state']): KnowledgeStatus {
  switch (s) {
    case 'accepted':
      return 'accepted';
    case 'edited':
      return 'edited';
    case 'dismissed':
      return 'dismissed';
    default:
      return 'export_ready'; // shown
  }
}

function kindTag(k: KnowledgeKind): string {
  return k.replace(/_/g, '-'); // ai_note → ai-note
}

function inkloopUri(docId: string, pageIndex: number | undefined, anchor: string | undefined): string {
  const d = encodeURIComponent(docId); // 对齐协作方 uri.ts：docId/anchor 都 encode
  if (pageIndex == null) return `inkloop://doc/${d}`;
  const base = `inkloop://doc/${d}/page/${pageIndex}`;
  return anchor ? `${base}?anchor=${encodeURIComponent(anchor)}` : base;
}

/* ── 哈希（确定性 ko_id + content_hash）──────────────────────────────────── */

async function sha256Bytes(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
export async function sha256HexStr(s: string): Promise<string> {
  return [...await sha256Bytes(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32（无 I/L/O/U）；协作方 ko_id zod 正则即此字符集

/** 稳定键 → 'ko_'+确定性 Crockford-Base32-26。同一源每次重建得同一 id（跨端稳定、可去重）。
 *  Crockford 大写 26 位满足协作方 InkSurface 契约 `^ko_[0-9A-HJKMNP-TV-Z]{26}$`——是**确定性派生**(非随机 ULID)，故保留跨端稳定身份。 */
export async function koId(stableKey: string): Promise<string> {
  const d = await sha256Bytes(`${KO_SCHEMA_VERSION}|${stableKey}`);
  let out = '';
  for (let i = 0; i < 26; i++) out += CROCKFORD[d[i] % 32];
  return `ko_${out}`;
}

/** 夹到合法归一化框：x,y,w,h≥0 且 x+w≤1、y+h≤1（满足协作方 NormBBoxSchema refine）。
 *  我们的页坐标允许越界到页边距（x 可 >1），导出当锚点 hint 时夹回页内。 */
export function clampNormBBox(b: NormBBox): NormBBox {
  const x = Math.min(1, Math.max(0, b[0]));
  const y = Math.min(1, Math.max(0, b[1]));
  return [x, y, Math.min(1 - x, Math.max(0, b[2])), Math.min(1 - y, Math.max(0, b[3]))];
}

/** 确定性 JSON：键名递归排序、数组保序、**剔除 undefined 键**（与协作方 canonicalize 一致 → content_hash 跨端可重算校验）。 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

async function contentHash(ko: KnowledgeObject): Promise<Sha256> {
  const { content_hash: _omit, ...rest } = ko;
  void _omit;
  return `sha256:${await sha256HexStr(canonicalJson(rest))}`;
}

/* ── 组装单条 KO ──────────────────────────────────────────────────────────── */

export interface Draft {
  stableKey: string;
  kind: KnowledgeKind;
  documentId: string;
  documentTitle: string;
  titleOverride?: string; // 概念 KO 等：标题=概念名，而非默认的「文档名·pN」
  pageId?: string;
  pageIndex?: number;
  objectRefs: string[];
  bbox?: NormBBox;
  quote?: string;
  body: string;
  provenance: KnowledgeObject['provenance'];
  status: KnowledgeStatus;
  createdAt: string;
}

/** 从 Draft 组装一条合规 KO（确定性 ko_id + content_hash）。会议导出等"非账本派生"的 KO 复用此函数·哈希一致过 validator。 */
export async function finalize(d: Draft): Promise<KnowledgeObject> {
  const title = d.titleOverride ?? (d.pageIndex != null ? `${d.documentTitle} · p${d.pageIndex + 1}` : d.documentTitle);
  const callout = CALLOUT[d.kind];
  const ko: KnowledgeObject = {
    schema_version: KO_SCHEMA_VERSION,
    ko_id: await koId(d.stableKey),
    kind: d.kind,
    title,
    body_md: d.body,
    source: {
      document_id: d.documentId,
      document_title: d.documentTitle,
      ...(d.pageId ? { page_id: d.pageId } : {}),
      ...(d.pageIndex != null ? { page_index: d.pageIndex } : {}),
      object_refs: d.objectRefs,
      ...(d.bbox ? { anchor_bbox: clampNormBBox(d.bbox) } : {}),
      ...(d.quote ? { quote: d.quote } : {}),
      inkloop_uri: inkloopUri(d.documentId, d.pageIndex, d.objectRefs[0]),
    },
    provenance: d.provenance,
    tags: ['inkloop', `inkloop/${kindTag(d.kind)}`],
    status: d.status,
    privacy: 'export_allowed', // v1 默认
    ...(callout ? { render_hints: { markdown_callout: callout } } : {}),
    content_hash: 'sha256:pending', // 占位，下面据全对象算
    created_at: d.createdAt,
    updated_at: d.createdAt, // 投影取源条目时刻，保 content_hash 跨重建稳定（非取构建时 now）
  };
  ko.content_hash = await contentHash(ko);
  return ko;
}

/** 导出边界·后置标签富化（待办1·全量感知）：给 KO 叠加 taxonomy 标签（mode/实体/日期）→ 重算 content_hash。
 *  **只在导出路径调用**（运行态 KO 不富化·标签对画布无意义）。ko_id 不变（派生自 stableKey·与 tags 无关）
 *  → document_projection 的 block→ko 链接仍有效。默认从 KO 自身派生；overrides 可显式指定
 *  （会议传 started_at 日期、自定 entity slug）。tags 去重保序（既有在前）。 */
export async function enrichExportTags(
  ko: KnowledgeObject,
  overrides: { mode?: EntityMode; entitySlug?: string; date?: string } = {},
): Promise<KnowledgeObject> {
  const extra = taxonomyTags({
    documentId: ko.source.document_id,
    documentTitle: ko.source.document_title,
    isoDate: ko.created_at,
    ...overrides,
  });
  const next: KnowledgeObject = { ...ko, tags: [...new Set([...ko.tags, ...extra])] };
  next.content_hash = await contentHash(next);
  return next;
}

/** 纯图形/未识别手写的占位正文（无文字可 OCR、无所标内容）——单一真相源（builder + meeting-export 共用）。 */
export const INK_PLACEHOLDER_DRAWING = '（图形标注 / 圈画）';
export const INK_PLACEHOLDER_HANDWRITING = '（未识别手写）';
/** 该正文是否只是内容为空的笔迹占位（body 恰等于占位串）。
 *  vault 导出在「笔迹重现(SVG)」上线前据此过滤掉这类占位（否则空白页涂鸦在 Obsidian 刷屏·见记忆 inkloop-obsidian-clean-vault）。
 *  ⚠️只判恰等——会议侧 body=占位+「（约 X 处手写）」带时间上下文·不命中·不过滤。笔迹仍在账本·不丢·将来渲成墨迹。 */
export const isInkPlaceholderBody = (body: string): boolean => body === INK_PLACEHOLDER_DRAWING || body === INK_PLACEHOLDER_HANDWRITING;

/* ── 普通笔簇合并：抬笔即落库(persistContentStroke)天生一笔一条 mark，不像 AI 笔走区域组装——
 *   连续书写/画画在导出时会碎成一堆几乎相同的单笔占位 KO（Obsidian 刷屏）。这里在建 KO 前，把同页、
 *   短间隔、空间相邻的未识别内容笔事后聚成一组，折成一条 KO（provenance.mark_ids 本就是数组，天然支持）。
 *   不碰实时落笔热路径（那条路径当前有 M103 硬件适配并发改动，风险更高）；纯函数、可回滚。 ── */
const CONTENT_CLUSTER_MAX_GAP_MS = 2500; // 产品阈值：抬笔间隔多久内算"连续书写"，2-3s 之间，需真机数据调
const CONTENT_CLUSTER_NEAR = 0.06; // 对齐 capture 侧 REGION_NEAR 的页归一化邻近半径（annotation-loop.ts）

function unionBBox(a: NormBBox, b: NormBBox): NormBBox {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.max(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, x1 - x0, y1 - y0];
}

const sourceCreatedAtOf = (m: PersistedMark): string => m.source_created_at ?? m.created_at;
const markTimeMs = (m: PersistedMark): number =>
  Number.isFinite(m.abs_timestamp) && m.abs_timestamp > 0 ? m.abs_timestamp : Date.parse(sourceCreatedAtOf(m));

/** 该 mark 是否有真实可见笔迹（橡皮擦/空笔画不算·笔迹仍要在，否则合并了个空壳）。 */
const hasVisibleInk = (m: PersistedMark): boolean =>
  m.strokes.some((s) => (s.tool === 'pen' || s.tool === 'aipen') && s.points.length > 0);

/** 是否可参与聚簇：只并"未识别的纯内容笔"——已识别出文字/已被用户显式声明实体关系的 mark 本身已经
 *  是有意义的独立单元，不该被临近笔迹粘在一起（会稀释语义、或把用户的显式声明连带并进邻居）。
 *  高亮(markup/excerpt)不并：高亮通常标记一段特定原文，多段高亮粘一起会混淆"标了哪一段"。 */
function clusterableContentMark(m: PersistedMark): boolean {
  const hasText = !!m.marked_text.trim() || !!m.hmp?.text_hint?.trim();
  const hasRefs = (m.entity_refs?.length ?? 0) > 0 || (m.topic_refs?.length ?? 0) > 0;
  return m.ai_eligible === false && m.tool === 'pen' && !hasText && !hasRefs
    && (m.feature_type === 'drawing' || m.feature_type === 'handwriting') && hasVisibleInk(m);
}

/** 新 mark 的中心点是否落在当前簇 union bbox 的邻近范围内（对齐 capture 侧"挨着就并"的判定）。 */
function nearCluster(group: readonly PersistedMark[], m: PersistedMark): boolean {
  const box = group.map((x) => x.bbox).reduce(unionBBox);
  const cx = m.bbox[0] + m.bbox[2] / 2;
  const cy = m.bbox[1] + m.bbox[3] / 2;
  return cx >= box[0] - CONTENT_CLUSTER_NEAR && cx <= box[0] + box[2] + CONTENT_CLUSTER_NEAR
    && cy >= box[1] - CONTENT_CLUSTER_NEAR && cy <= box[1] + box[3] + CONTENT_CLUSTER_NEAR;
}

/** marks（按 seq 序）→ 分组：可聚簇的连续内容笔（同页+同 context+短间隔+空间邻近）合成一组；
 *  其余（已识别/已消费/有 refs/高亮等）各自单独成组，保持原有"一 mark 一 KO"语义不变。 */
function standaloneMarkGroups(marks: readonly PersistedMark[], consumed: ReadonlySet<string>): PersistedMark[][] {
  const groups: PersistedMark[][] = [];
  let cur: PersistedMark[] = [];
  const flush = (): void => { if (cur.length) groups.push(cur); cur = []; };
  for (const m of [...marks].sort((a, b) => a.seq - b.seq)) {
    if (consumed.has(m.mark_id)) { flush(); continue; }
    if (!clusterableContentMark(m)) { flush(); groups.push([m]); continue; }
    const last = cur[cur.length - 1];
    const sameContext = !last || !last.context_id || !m.context_id || last.context_id === m.context_id;
    if (last && last.page_id === m.page_id && sameContext
      && markTimeMs(m) - markTimeMs(last) <= CONTENT_CLUSTER_MAX_GAP_MS && nearCluster(cur, m)) {
      cur.push(m);
    } else {
      flush();
      cur = [m];
    }
  }
  flush();
  return groups;
}

/* ── 存储原生拓扑：账本 entity_refs → 确定性成员关系（零 LLM）───────────────── */

/** 归一化实体 id（NFKC + 折大小写 + 转 slug）。写 entity_refs 的一方（采集声明/后台 suggester）用它算 canonical entity_id；
 *  这里也用它兜底——facts 里若混进未归一的裸 display（不该发生，但账本数据不受 TS 类型约束，防御一下）。 */
export function normalizeEntityId(input: string): string {
  return input.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

/** 一条"某 KO 关联到某实体"的确定性事实（side-channel，不进任何 KO 字段·不碰 content_hash）。
 *  由账本条目的 entity_refs/topic_refs 直接映射而来——真相已经在账本里，这里只是投影，不计算/不猜测。 */
export interface EntityMembershipFact {
  entity_id: string;
  display?: string;
  ko_id: string;
  source_document_id: string;
  source_entry_id: string;
  source: LedgerEntityRef['source'];
  created_at: string; // 决定 entity 首次出现时间的排序键；取 ref 所在条目的 source_created_at ?? created_at
}

/** refs（mark/ai_turn 的 entity_refs 或 topic_refs）→ 事实数组。builder 内外都用它映射，别重复实现同一逻辑（如 meeting-export）。
 *  · review_state='rejected' 的 ref 不产事实——用户明确拒绝过的建议不能变成"确定性拓扑"里的真相。
 *  · entity_id 兜底走 normalizeEntityId：契约上写 refs 的一方该已归一化，这里防御一手（防未来生产者疏漏，
 *    让同一实体的不同大小写/裸 display 拆成多个 hub）。 */
export function entityFactsFrom(refs: LedgerEntityRef[] | undefined, koId: string, documentId: string, sourceEntryId: string, createdAt: string): EntityMembershipFact[] {
  return (refs ?? [])
    .filter((ref) => ref.review_state !== 'rejected')
    .flatMap((ref) => {
      const rawId = (ref.entity_id || ref.display || '').trim();
      if (!rawId) return [];
      return [{ entity_id: normalizeEntityId(rawId), display: ref.display, ko_id: koId, source_document_id: documentId, source_entry_id: sourceEntryId, source: ref.source, created_at: createdAt }];
    });
}

/* ── 纯转换核心 ──────────────────────────────────────────────────────────── */

/** mark 的源 run 恒等锚并集：reflow_anchor_runs（重排落笔的位置真相）∪ 各笔 anchor_runs ∪ HMP 命中 refs。
 *  KO/投影定位段落以此恒等匹配为先——reader 笔的 canonical bbox 是近似投影（可越界），不配当定位真相。 */
export function markSourceObjectRefs(m: PersistedMark): string[] {
  return [...new Set([
    ...(m.reflow_anchor_runs ?? []),
    ...(m.strokes ?? []).flatMap((s) => s.anchor_runs ?? []),
    ...(m.hmp?.target_object_refs ?? []),
  ])];
}

export interface KnowledgeProjection {
  objects: KnowledgeObject[];
  entityFacts: EntityMembershipFact[];
  koRelationFacts: KoRelationGroup[]; // 存储原生拓扑（KO-KO 关系层）：同一 AI 回复锚定的兄弟 mark 产的 KO 分组
}

/**
 * 折叠 marks + ai_turns → KnowledgeObject[] + 存储原生实体成员事实。纯函数（除 crypto.subtle）：
 *   1) 每条非 folded 的 ai_turn → ai_note（trigger=discussion 时 qa），source 取 ai_turn 自身锚点、quote 取锚 mark；
 *      成功产出才把锚到的活 mark 记"已消费"（空内容轮不消费，其 mark 仍单独导出）。产出的 KO 关联到
 *      ai_turn 自身 + 全部被消费锚 mark 的 entity_refs/topic_refs（用户在手写或 AI 回复任一处"归类"都算数）。
 *   2) 未被任何 ai_turn 消费的活 mark → excerpt（markup）/ annotation（手写/画）；空内容笔不产 KO。
 */
export async function assembleKnowledgeProjection(input: BuilderInput): Promise<KnowledgeProjection> {
  const { document_id, document_title, marks, aiTurns } = input;
  const markById = new Map(marks.map((m) => [m.mark_id, m]));
  const consumed = new Set<string>();
  const out: KnowledgeObject[] = [];
  const entityFacts: EntityMembershipFact[] = [];
  // 存储原生拓扑（KO-KO 关系层）：记录每个 mark_id 最终折成了哪些 ko_id（ai_turn 消费的 anchor mark → ai KO；
  // 未消费的独立 mark → 自己的 excerpt/annotation KO），用于下面把「同一 ai_turn 锚定的多个 mark」串成 same_ai_turn 关系组。
  const koIdsByMarkId = new Map<string, string[]>();
  const addMarkKo = (markId: string, id: string): void => {
    const ids = koIdsByMarkId.get(markId) ?? [];
    if (!ids.includes(id)) ids.push(id);
    koIdsByMarkId.set(markId, ids);
  };

  // 1) ai_turns → ai_note / qa（成功产出才把锚 mark 记为"已消费"，并进本条不再单独导出）
  for (const t of aiTurns) {
    if (t.overlay_state === 'folded') continue; // 写给自己·静默没回应·不导出（底下手写仍走 mark 循环导出）
    // edited 严格取用户改写文本（改成空亦视作空 body·不产）；否则取 AI 回复
    const body = t.overlay_state === 'edited' && t.user_edited_text != null ? t.user_edited_text : t.ai_reply;
    if (!body) continue; // 空内容轮不产 KO，且**不消费**锚 mark → 该 mark 仍由下方循环单独导出（不丢）
    const anchorIds = t.anchor?.mark_ids ?? [];
    const anchorMarks = anchorIds.map((id) => markById.get(id)).filter((m): m is PersistedMark => !!m);
    // dismissed 的 KO 不可导出（见 knowledge-export.ts isExportableKo）——若锚 mark 自己声明过 entity_refs/topic_refs，
    // 别把它一起消费掉：那样 mark 的内容+它自己的拓扑声明会随 dismissed 的 AI KO 一起从导出里无声消失。
    // 用户拒绝的是 AI 的回复，不是自己写的那笔、更不是自己标的关系。可导出（shown/accepted/edited）时消费如常。
    const turnWillExport = t.overlay_state !== 'dismissed';
    for (const m of anchorMarks) {
      const markHasOwnRefs = (m.entity_refs?.length ?? 0) > 0 || (m.topic_refs?.length ?? 0) > 0;
      if (turnWillExport || !markHasOwnRefs) consumed.add(m.mark_id);
    }
    const anchorMark = anchorMarks[0];
    // 定位 refs 恒等优先：turn 自身 anchor.object_refs 常年为空（触发笔=手写 self_content），
    // 而锚 mark 的 reflow_anchor_runs/HMP refs 才是真相——没有它们导出只能退几何兜底（reader 笔的 bbox 是烂近似）。
    const anchorObjectRefs = [...new Set(anchorMarks.flatMap(markSourceObjectRefs))];
    const turnCreatedAt = t.source_created_at ?? t.created_at;
    const ko = await finalize({
      stableKey: `ai_turn:${document_id}:${t.overlay_id}`, // 含 doc 命名空间·防全库聚合短 id 跨书碰撞
      kind: t.trigger === 'discussion' ? 'qa' : 'ai_note',
      documentId: document_id,
      documentTitle: document_title,
      // source 统一取 ai_turn 自身锚点（page/refs/bbox 同源·session 级聚合），quote 取锚 mark 所标原文
      pageId: t.page_id,
      pageIndex: t.page_index,
      objectRefs: anchorObjectRefs.length ? anchorObjectRefs : (t.anchor?.object_refs ?? []),
      bbox: t.overlay?.geometry?.anchor_bbox,
      quote: anchorMark?.marked_text || undefined,
      body,
      provenance: {
        created_from: 'ai_turn',
        mark_ids: anchorIds.filter((id) => markById.has(id)),
        ai_turn_ids: [t.entry_id],
      },
      status: statusFromOverlay(t.overlay_state),
      createdAt: turnCreatedAt, // source_created_at 兜底：补写 refs 的 revision 不该让既有 KO 的 created_at（进 content_hash）漂移
    });
    out.push(ko);
    entityFacts.push(...entityFactsFrom(t.entity_refs, ko.ko_id, document_id, t.entry_id, turnCreatedAt));
    entityFacts.push(...entityFactsFrom(t.topic_refs, ko.ko_id, document_id, t.entry_id, turnCreatedAt));
    for (const m of anchorMarks) {
      const markCreatedAt = m.source_created_at ?? m.created_at;
      entityFacts.push(...entityFactsFrom(m.entity_refs, ko.ko_id, document_id, m.entry_id, markCreatedAt));
      entityFacts.push(...entityFactsFrom(m.topic_refs, ko.ko_id, document_id, m.entry_id, markCreatedAt));
    }
    for (const markId of anchorIds) if (markById.has(markId)) addMarkKo(markId, ko.ko_id);
  }

  // 2) 独立 mark → excerpt / annotation（未识别的连续内容笔先事后聚簇·减少导出碎片，见 standaloneMarkGroups）
  for (const group of standaloneMarkGroups(marks, consumed)) {
    const m = group[0];
    const kind: KnowledgeKind = m.feature_type === 'markup' ? 'excerpt' : 'annotation';
    const transcript = group.map((x) => x.hmp?.text_hint?.trim()).find((t) => !!t);
    const markedText = group.map((x) => x.marked_text.trim()).find((t) => !!t) ?? '';
    // excerpt 正文=所标原文（空则无价值·跳）；annotation（手写/画）正文=识别文字，退回所标内容，
    // **再退回占位**——纯图形/未识别手写也要产 KO，否则用户真画过的圈画在导出里无声消失（与会议侧 inkBody 同口径）。
    const inkBody = (m.feature_type === 'drawing' ? INK_PLACEHOLDER_DRAWING : INK_PLACEHOLDER_HANDWRITING);
    const body = kind === 'excerpt' ? m.marked_text || '' : transcript || markedText || inkBody;
    if (!body) continue; // 仅 excerpt 无所标原文时为空→跳；annotation 永有占位正文（不丢手写）
    const markIds = group.map((x) => x.mark_id);
    const bbox = group.map((x) => x.bbox).reduce(unionBBox);
    const objectRefs = [...new Set(group.flatMap(markSourceObjectRefs))];
    const ko = await finalize({
      stableKey: `mark:${document_id}:${m.mark_id}`, // 簇沿用首笔身份，减少导出/wikilink 迁移 churn
      kind,
      documentId: document_id,
      documentTitle: document_title,
      pageId: m.page_id,
      pageIndex: m.page_index,
      objectRefs,
      bbox,
      quote: markedText || undefined,
      body,
      provenance: { created_from: 'mark', mark_ids: markIds },
      status: 'export_ready',
      createdAt: sourceCreatedAtOf(m), // source_created_at 兜底：补写 refs 的 revision 不该让既有 KO 的 created_at（进 content_hash）漂移
    });
    out.push(ko);
    for (const src of group) {
      const t = sourceCreatedAtOf(src);
      entityFacts.push(...entityFactsFrom(src.entity_refs, ko.ko_id, document_id, src.entry_id, t));
      entityFacts.push(...entityFactsFrom(src.topic_refs, ko.ko_id, document_id, src.entry_id, t));
      addMarkKo(src.mark_id, ko.ko_id);
    }
  }

  const objects = out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.ko_id.localeCompare(b.ko_id));
  const koOrder = new Map(objects.map((ko, index) => [ko.ko_id, index] as const));
  const byKoOrder = (a: string, b: string): number => (koOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (koOrder.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b);

  // same_ai_turn 关系组：同一 ai_turn 锚定 ≥2 个 mark 时，把这些 mark 折成的 KO 串成一组「同源笔记」。
  // 注：大多数场景一次 AI 回复只产 1 条 KO（consumed anchor marks 被折进同一条 ai_note/qa），这条关系
  // 组常年只有 0-1 个成员、不会渲出可见互链——只有 dismissed 等边缘情况才会出现 ≥2 个独立 KO（已知降级，
  // 用户已确认接受·不为此改「一次问答只产一条笔记」的消费逻辑）。
  const koRelationFacts: KoRelationGroup[] = [];
  for (const t of aiTurns) {
    if (t.overlay_state === 'folded') continue;
    const mark_ids = [...new Set(t.anchor?.mark_ids ?? [])].filter((id) => markById.has(id)).sort();
    if (mark_ids.length < 2) continue;
    const ko_ids = [...new Set(mark_ids.flatMap((id) => koIdsByMarkId.get(id) ?? []))].sort(byKoOrder);
    if (ko_ids.length < 2) continue;
    koRelationFacts.push({
      schema_version: 'inkloop.ko_relation_group.v1',
      relation_id: `rel:same_ai_turn:${document_id}:${t.overlay_id}`,
      kind: 'same_ai_turn',
      source: 'ai_turn_anchor',
      confidence: 'deterministic',
      ko_ids,
      evidence: { document_id, source_entry_id: t.entry_id, overlay_id: t.overlay_id, mark_ids },
      created_at: t.source_created_at ?? t.created_at,
    });
  }

  return {
    objects,
    entityFacts: entityFacts.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.entity_id.localeCompare(b.entity_id) || a.ko_id.localeCompare(b.ko_id)),
    koRelationFacts,
  };
}

/** 折叠 marks + ai_turns → KnowledgeObject[]（不含实体拓扑；纯 KO 消费者用这个，与既有调用点行为完全一致）。 */
export async function assembleKnowledgeObjects(input: BuilderInput): Promise<KnowledgeObject[]> {
  return (await assembleKnowledgeProjection(input)).objects;
}

/** 沿 status='merged'+merged_into 链走到底，解析出当前活着的 canonical entity_id。
 *  环守卫：正常数据不会有环（合并该是无环的），但若脏数据出现环，收敛到环内字典序最小的 id——
 *  不管从环上哪个成员开始解析，结果都一样，不会把同一个环撕成两个不同的"活"实体。 */
function resolveEntityRef(entityId: string, registryById: Map<string, PersistedEntity>): string {
  let current = entityId;
  const path: string[] = [];
  for (;;) {
    if (path.includes(current)) return [...path].sort()[0]; // 环：确定性收敛，不死循环
    path.push(current);
    const rec = registryById.get(current);
    if (!rec || rec.status !== 'merged' || !rec.merged_into) return current;
    current = rec.merged_into;
  }
}

export interface EntityProjection {
  entities: KnowledgeEntity[];
  memberships: EntityMembership[];
}

/**
 * facts + canonical_entities 注册表快照 → 确定性 KnowledgeEntity[] + EntityMembership[]。纯函数、零 LLM：
 *   · 按 registry 的 status='merged' 链把每条 fact 的 entity_id 重映射到活的实体（合并不改历史 refs）。
 *   · 成员边按 (resolved entity_id, ko_id) 去重；entity 优先取 registry 记录（display/kind/aliases/时间），
 *     registry 缺记录时用 fact 里最早出现的 display 兜底——refs 是唯一真相源，registry 暂缺不该让关系消失。
 *   · 只有至少一条活 fact 指向的实体才出现在结果里（合并掉的旧实体天然不再是 hub，无需特判排除）。
 */
export function projectEntities(facts: readonly EntityMembershipFact[], registry: readonly PersistedEntity[]): EntityProjection {
  const registryById = new Map(registry.map((e) => [e.entity_id, e] as const));
  const resolved = facts.map((f) => ({ ...f, entity_id: resolveEntityRef(f.entity_id, registryById) }));

  const membershipByKey = new Map<string, EntityMembership>();
  const earliestByEntity = new Map<string, { display: string; createdAt: string }>();

  for (const f of resolved) {
    const key = `${f.entity_id} ${f.ko_id}`;
    if (!membershipByKey.has(key)) {
      membershipByKey.set(key, { schema_version: 'inkloop.entity_membership.v1', entity_id: f.entity_id, ko_id: f.ko_id, source: f.source });
    }
    const cur = earliestByEntity.get(f.entity_id);
    const display = f.display ?? registryById.get(f.entity_id)?.display ?? f.entity_id;
    if (!cur || f.created_at < cur.createdAt) earliestByEntity.set(f.entity_id, { display, createdAt: f.created_at });
  }

  const createdFromOf = (reg: PersistedEntity | undefined): KnowledgeEntity['provenance']['created_from'] => {
    const first = reg?.provenance.entries[0]?.source;
    return first === 'llm_suggestion' || first === 'import' || first === 'merge' ? first : 'manual';
  };

  const entities: KnowledgeEntity[] = [...earliestByEntity.keys()].sort().map((entityId) => {
    const reg = registryById.get(entityId);
    const fallback = earliestByEntity.get(entityId)!;
    return {
      schema_version: 'inkloop.knowledge_entity.v1',
      entity_id: entityId,
      kind: reg?.kind ?? 'entity',
      display: reg?.display ?? fallback.display,
      ...(reg?.aliases ? { aliases: reg.aliases } : {}),
      provenance: { created_from: createdFromOf(reg) },
      ...(reg?.status ? { status: reg.status } : {}),
      ...(reg?.merged_into ? { merged_into: reg.merged_into } : {}),
      created_at: reg?.created_at ?? fallback.createdAt,
      updated_at: reg?.updated_at ?? fallback.createdAt,
    };
  });

  const memberships = [...membershipByKey.values()].sort((a, b) => a.entity_id.localeCompare(b.entity_id) || a.ko_id.localeCompare(b.ko_id));
  return { entities, memberships };
}

/* ── store 取数包装（运行态 / 导出）──────────────────────────────────────── */

/** 取一本书的真相切片、折叠成 KO[] + 实体成员事实。 */
export async function buildKnowledgeProjection(documentId: string): Promise<KnowledgeProjection> {
  const [doc, marks, aiTurns] = await Promise.all([
    getDoc(documentId),
    getFoldedMarks(documentId),
    getBookAiTurns(documentId),
  ]);
  return assembleKnowledgeProjection({
    document_id: documentId,
    document_title: doc?.filename ?? documentId,
    marks,
    aiTurns,
  });
}

/** 取一本书的真相切片、折叠成 KO[]（不含实体拓扑；与既有调用点行为完全一致）。 */
export async function buildKnowledgeObjects(documentId: string): Promise<KnowledgeObject[]> {
  return (await buildKnowledgeProjection(documentId)).objects;
}

/** 导出一本书的 KO 列表为 JSON 文本（契约 §8 v1：导出 JSON 给 FS 适配器扫）。 */
export async function exportKnowledgeObjects(documentId: string): Promise<string> {
  return JSON.stringify(await buildKnowledgeObjects(documentId), null, 2);
}

/** 导出全部书的 KO 列表为 JSON 文本。 */
export async function exportAllKnowledgeObjects(): Promise<string> {
  const books = await listBooks();
  const all: KnowledgeObject[] = [];
  for (const b of books) all.push(...(await buildKnowledgeObjects(b.document_id)));
  return JSON.stringify(all, null, 2);
}
