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
import type { PersistedAiTurn, PersistedMark } from '../core/store-format';
import { getBookAiTurns, getDoc, getFoldedMarks, listBooks } from '../local/store';
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

interface Draft {
  stableKey: string;
  kind: KnowledgeKind;
  documentId: string;
  documentTitle: string;
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

async function finalize(d: Draft): Promise<KnowledgeObject> {
  const title = d.pageIndex != null ? `${d.documentTitle} · p${d.pageIndex + 1}` : d.documentTitle;
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

/* ── 纯转换核心 ──────────────────────────────────────────────────────────── */

/**
 * 折叠 marks + ai_turns → KnowledgeObject[]。纯函数（除 crypto.subtle）：
 *   1) 每条非 folded 的 ai_turn → ai_note（trigger=discussion 时 qa），source 取 ai_turn 自身锚点、quote 取锚 mark；
 *      成功产出才把锚到的活 mark 记"已消费"（空内容轮不消费，其 mark 仍单独导出）。
 *   2) 未被任何 ai_turn 消费的活 mark → excerpt（markup）/ annotation（手写/画）；空内容笔不产 KO。
 */
export async function assembleKnowledgeObjects(input: BuilderInput): Promise<KnowledgeObject[]> {
  const { document_id, document_title, marks, aiTurns } = input;
  const markById = new Map(marks.map((m) => [m.mark_id, m]));
  const consumed = new Set<string>();
  const out: KnowledgeObject[] = [];

  // 1) ai_turns → ai_note / qa（成功产出才把锚 mark 记为"已消费"，并进本条不再单独导出）
  for (const t of aiTurns) {
    if (t.overlay_state === 'folded') continue; // 写给自己·静默没回应·不导出（底下手写仍走 mark 循环导出）
    // edited 严格取用户改写文本（改成空亦视作空 body·不产）；否则取 AI 回复
    const body = t.overlay_state === 'edited' && t.user_edited_text != null ? t.user_edited_text : t.ai_reply;
    if (!body) continue; // 空内容轮不产 KO，且**不消费**锚 mark → 该 mark 仍由下方循环单独导出（不丢）
    const anchorIds = t.anchor?.mark_ids ?? [];
    for (const id of anchorIds) if (markById.has(id)) consumed.add(id); // 确认会产出后再消费
    const anchorMark = anchorIds.map((id) => markById.get(id)).find((m): m is PersistedMark => !!m);
    out.push(
      await finalize({
        stableKey: `ai_turn:${document_id}:${t.overlay_id}`, // 含 doc 命名空间·防全库聚合短 id 跨书碰撞
        kind: t.trigger === 'discussion' ? 'qa' : 'ai_note',
        documentId: document_id,
        documentTitle: document_title,
        // source 统一取 ai_turn 自身锚点（page/refs/bbox 同源·session 级聚合），quote 取锚 mark 所标原文
        pageId: t.page_id,
        pageIndex: t.page_index,
        objectRefs: t.anchor?.object_refs ?? [],
        bbox: t.overlay?.geometry?.anchor_bbox,
        quote: anchorMark?.marked_text || undefined,
        body,
        provenance: {
          created_from: 'ai_turn',
          mark_ids: anchorIds.filter((id) => markById.has(id)),
          ai_turn_ids: [t.entry_id],
        },
        status: statusFromOverlay(t.overlay_state),
        createdAt: t.created_at,
      }),
    );
  }

  // 2) 独立 mark → excerpt / annotation
  for (const m of marks) {
    if (consumed.has(m.mark_id)) continue;
    const kind: KnowledgeKind = m.feature_type === 'markup' ? 'excerpt' : 'annotation';
    const transcript = m.hmp?.text_hint?.trim();
    // excerpt 正文=所标原文；annotation（手写/画）正文=识别出的手写转写，退回所标内容
    const body = kind === 'excerpt' ? m.marked_text || '' : transcript || m.marked_text || '';
    if (!body) continue; // 无正文无 quote = 无价值，不产 KO
    out.push(
      await finalize({
        stableKey: `mark:${document_id}:${m.mark_id}`,
        kind,
        documentId: document_id,
        documentTitle: document_title,
        pageId: m.page_id,
        pageIndex: m.page_index,
        objectRefs: m.hmp?.target_object_refs ?? [],
        bbox: m.bbox,
        quote: m.marked_text || undefined,
        body,
        provenance: { created_from: 'mark', mark_ids: [m.mark_id] },
        status: 'export_ready',
        createdAt: m.created_at,
      }),
    );
  }

  return out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.ko_id.localeCompare(b.ko_id));
}

/* ── store 取数包装（运行态 / 导出）──────────────────────────────────────── */

/** 取一本书的真相切片、折叠成 KO[]。 */
export async function buildKnowledgeObjects(documentId: string): Promise<KnowledgeObject[]> {
  const [doc, marks, aiTurns] = await Promise.all([
    getDoc(documentId),
    getFoldedMarks(documentId),
    getBookAiTurns(documentId),
  ]);
  return assembleKnowledgeObjects({
    document_id: documentId,
    document_title: doc?.filename ?? documentId,
    marks,
    aiTurns,
  });
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
