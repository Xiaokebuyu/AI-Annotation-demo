/**
 * 本地持久化存储（IndexedDB）—— SSoT 账本。
 *   · docs       书目元信息 + 页内容缓存（reflow/图解/阅读位置/水位线），按 document_id；内存 current 去抖落盘。
 *   · pdf_blobs  原始 PDF 字节（重开免重导）。
 *   · marks      页账本：组装手势条目（append-only，擦除=tombstone），index by_doc。
 *   · ai_turns   书日志：AI 回复条目（append-only，改/忽略=supersedes），index by_doc。
 * 全程 try/catch：IDB 不可用（隐私模式等）退化为「仅内存」，不影响主流程。
 */
import type { NormBBox, OverlayState, ScreenOverlay } from '../core/contracts';
import type { ReflowBlock } from '../surface/reflow';
import type { MeetingStatus, PersistedAiTurn, PersistedDoc, PersistedMark, PersistedMeeting, PersistedMeetingMinute, PersistedPage, PersistedPdfBlob, PersistedWorkspace } from '../core/store-format';
import { DB_VERSION, STORE_VERSION } from '../core/store-format';
import { shortId } from '../core/ids';
import { vectorStore } from './vector';
import type { PersistedInkChunk, PersistedInkSegment } from '../core/bedrock';

const DB_NAME = 'inkloop';
const STORE = 'docs';
const PDF_STORE = 'pdf_blobs';   // PDF 原始字节（重开免重导）
const MARKS = 'marks';           // 页账本条目
const TURNS = 'ai_turns';        // 书日志条目
const WORKSPACES = 'workspaces'; // 会议工作区（≈群聊）
const MEETINGS = 'meetings';     // 会议（属某 workspace）
const INK_SEGMENTS = 'ink_segments'; // 基岩：录制段头（profile + 时间锚）
const INK_SAMPLES = 'ink_samples';   // 基岩：采样块（批量 flush）
const MEETING_MINUTES = 'meeting_minutes'; // WS2-C：飞书妙记转写缓存（会后离线复盘）
let dbPromise: Promise<IDBDatabase | null> | null = null;

/** 幂等建 store（连同建表时的初始 index）。已存在则跳过——自愈"版本到位却缺表"。 */
function ensureStore(db: IDBDatabase, name: string, keyPath: string, index?: [string, string]): void {
  if (db.objectStoreNames.contains(name)) return;
  const store = db.createObjectStore(name, { keyPath });
  if (index) store.createIndex(index[0], index[1], { unique: false });
}

/** 幂等给已存在 store 加 index（onupgradeneeded 内、versionchange 事务）。 */
function ensureIndex(tx: IDBTransaction, storeName: string, indexName: string, keyPath: string): void {
  const store = tx.objectStore(storeName);
  if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath, { unique: false });
}

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction!;   // versionchange 事务：给已存在 store 加 index 用
        const oldV = event.oldVersion; // 0 = 全新库

        // ① 幂等结构基线：确保六个核心 store 存在（连建表时的初始 index）。不依赖 oldVersion，
        //    自愈历史 HMR 坏库（"版本到位却缺表"）。
        ensureStore(db, STORE, 'document_id');
        ensureStore(db, PDF_STORE, 'document_id');
        ensureStore(db, MARKS, 'entry_id', ['by_doc', 'document_id']);
        ensureStore(db, TURNS, 'entry_id', ['by_doc', 'document_id']);
        ensureStore(db, WORKSPACES, 'workspace_id');
        ensureStore(db, MEETINGS, 'meeting_id', ['by_ws', 'workspace_id']);
        ensureStore(db, INK_SEGMENTS, 'segment_id', ['by_doc', 'document_id']); // 基岩段头
        ensureStore(db, INK_SAMPLES, 'chunk_id', ['by_doc', 'document_id']);     // 基岩采样块
        ensureStore(db, MEETING_MINUTES, 'minute_token');                        // WS2-C 妙记转写缓存

        // ② 阶梯迁移：每次 DB_VERSION 升级追加一块 if (oldV < N) {...}——给已存在 store 加 index /
        //    字段级 backfill（须恰好跑一次的数据迁移放这）。
        if (oldV < 6) ensureIndex(tx, MARKS, 'by_context', 'context_id'); // v6 时间脊（C2）
        // v7：基岩 ink_segments/ink_samples 由上方 ① 基线幂等建，无需额外迁移步。
        // v8：meeting_minutes 由上方 ① 基线幂等建，无需额外迁移步。
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => console.warn('[store] IndexedDB 升级被阻塞——请关掉其它 InkLoop 标签页后重载');
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function idbGet(id: string): Promise<PersistedDoc | null> {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      r.onsuccess = () => resolve((r.result as PersistedDoc) ?? null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function idbPut(doc: PersistedDoc): Promise<void> {
  const db = await openDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(doc);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

let current: PersistedDoc | null = null;
let saveTimer: number | undefined;

/** 每书单调递增 seq（Date.now() 起跳，跨 reload 仍增），驱动折叠顺序 + 综合水位线。 */
let seqCounter = 0;
function nextSeq(): number { seqCounter = Math.max(seqCounter + 1, Date.now()); return seqCounter; }

/** 打开文档：从 IndexedDB 载入已存的语义蒸馏（没有则新建）。返回 true=命中缓存。 */
export async function openDoc(meta: { document_id: string; file_hash: string; filename: string; page_count: number }): Promise<boolean> {
  flushSave(); // 切档前先落盘上一份在途改动（防去抖丢写）
  const saved = await idbGet(meta.document_id);
  const hit = !!(saved && saved.version === STORE_VERSION);
  if (hit) {
    current = saved!;
    current.page_count = meta.page_count; // 元信息以本次打开为准
  } else {
    current = { ...meta, saved_at: new Date().toISOString(), version: STORE_VERSION, pages: {} };
  }
  // seq 不回退：新 seq 必超过本书历史（含 reload 前），避免与旧条目冲突
  seqCounter = Math.max(seqCounter, Date.now(), current.synthesis_watermark_seq ?? 0);
  scheduleSave(); // 即便不标注也落库（导入后直接刷新也能在书架列出）
  return hit;
}

/**
 * 把"当前文档"重指向给定 doc——切 SurfaceContext 时调，使 store.current 始终 = 活跃实例的文档。
 * 根除"模块级 current 与 SurfaceContext.documentId 双真相"导致的跨文档串写（P0-4）：
 * 退会议切回阅读 A 时，current 跟着回到 A，翻页/水位线/页缓存不再误写进会议材料 B。
 */
export function setActiveDoc(doc: PersistedDoc | null): void {
  if (doc === current) return;
  flushSave();    // 落盘上一份在途改动，再切
  current = doc;
}
/** 当前活跃文档引用（renderer 载入文档后挂到 SurfaceContext.storeDoc，供切回时重指向）。 */
export function activeDoc(): PersistedDoc | null { return current; }

// ── 书籍持久化：PDF 原始字节 + 书目列表 + 阅读位置 ──

/** 存 PDF 原始字节（重开免重导）。幂等 put，导入路径调用一次。 */
export async function storePdfBlob(documentId: string, blob: Blob): Promise<void> {
  const db = await openDB();
  if (!db) return;
  const rec: PersistedPdfBlob = { document_id: documentId, blob, stored_at: new Date().toISOString(), size_bytes: blob.size };
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(PDF_STORE, 'readwrite');
      tx.objectStore(PDF_STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

/** 取 PDF 字节（无则 null）。 */
export async function loadPdfBlob(documentId: string): Promise<Blob | null> {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const r = db.transaction(PDF_STORE, 'readonly').objectStore(PDF_STORE).get(documentId);
      r.onsuccess = () => resolve((r.result as PersistedPdfBlob | undefined)?.blob ?? null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

/** 列出已存的书（按最近保存倒序）。仅返回有 PDF 字节、能重开的书。 */
export async function listBooks(): Promise<PersistedDoc[]> {
  const db = await openDB();
  if (!db) return [];
  const [docs, blobIds] = await Promise.all([
    new Promise<PersistedDoc[]>((resolve) => {
      try {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        r.onsuccess = () => resolve((r.result as PersistedDoc[]) ?? []);
        r.onerror = () => resolve([]);
      } catch { resolve([]); }
    }),
    new Promise<Set<string>>((resolve) => {
      try {
        const r = db.transaction(PDF_STORE, 'readonly').objectStore(PDF_STORE).getAllKeys();
        r.onsuccess = () => resolve(new Set((r.result as string[]) ?? []));
        r.onerror = () => resolve(new Set());
      } catch { resolve(new Set()); }
    }),
  ]);
  return docs
    .filter((d) => blobIds.has(d.document_id))
    .sort((a, b) => (b.saved_at || '').localeCompare(a.saved_at || ''));
}

/**
 * 建/取一份「日记」文档（无 PDF 字节·空白可写）并立即落库——点新日记=先有文件、再写内容。
 * 幂等：已存在（重开日记）则取回。不碰 current；调用方渲染后 setActiveDoc(doc) 挂为当前（R6 双真相）。
 */
export async function createDiaryDoc(documentId: string, title: string, pageCount = 1): Promise<PersistedDoc> {
  const existing = await idbGet(documentId);
  if (existing) return existing;
  const doc: PersistedDoc = {
    document_id: documentId, file_hash: documentId, filename: title,
    page_count: pageCount, saved_at: new Date().toISOString(),
    version: STORE_VERSION, pages: {},
  };
  await idbPut(doc); // 立即落库：文件先存在
  return doc;
}

/** 改日记标题并落库（手写变标题/手动改标题都走它）。同步更新内存 current（若正是当前文档）。 */
export async function renameDiary(documentId: string, title: string): Promise<void> {
  const doc = await idbGet(documentId);
  if (!doc) return;
  doc.filename = title;
  await idbPut(doc);
  if (current?.document_id === documentId) current.filename = title;
}

/** 列出已存的日记（无 PDF 字节 + id 以 diary 打头，避开会议白板 mtgboard_），按最近倒序。 */
export async function listDiaries(): Promise<PersistedDoc[]> {
  const db = await openDB();
  if (!db) return [];
  const [docs, blobIds] = await Promise.all([
    new Promise<PersistedDoc[]>((resolve) => {
      try {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        r.onsuccess = () => resolve((r.result as PersistedDoc[]) ?? []);
        r.onerror = () => resolve([]);
      } catch { resolve([]); }
    }),
    new Promise<Set<string>>((resolve) => {
      try {
        const r = db.transaction(PDF_STORE, 'readonly').objectStore(PDF_STORE).getAllKeys();
        r.onsuccess = () => resolve(new Set((r.result as string[]) ?? []));
        r.onerror = () => resolve(new Set());
      } catch { resolve(new Set()); }
    }),
  ]);
  return docs
    .filter((d) => !blobIds.has(d.document_id) && d.document_id.startsWith('diary'))
    .sort((a, b) => (b.saved_at || '').localeCompare(a.saved_at || ''));
}

/** dev 页可下钻的全部文档（书/日记/会议白板/其它）——按 kind 标注、最近倒序。
 *  dev 通道原只列 listBooks()，日记/会议（无 PDF 字节）选不到；本函数让三类都进选择器。 */
export type InspectableKind = 'book' | 'diary' | 'meeting' | 'other';
export interface InspectableDoc { document_id: string; filename: string; kind: InspectableKind; saved_at: string }
export async function listInspectableDocs(): Promise<InspectableDoc[]> {
  const db = await openDB();
  if (!db) return [];
  const [docs, blobIds] = await Promise.all([
    new Promise<PersistedDoc[]>((resolve) => {
      try {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        r.onsuccess = () => resolve((r.result as PersistedDoc[]) ?? []);
        r.onerror = () => resolve([]);
      } catch { resolve([]); }
    }),
    new Promise<Set<string>>((resolve) => {
      try {
        const r = db.transaction(PDF_STORE, 'readonly').objectStore(PDF_STORE).getAllKeys();
        r.onsuccess = () => resolve(new Set((r.result as string[]) ?? []));
        r.onerror = () => resolve(new Set());
      } catch { resolve(new Set()); }
    }),
  ]);
  const kindOf = (d: PersistedDoc): InspectableKind =>
    blobIds.has(d.document_id) ? 'book'
      : d.document_id.startsWith('diary') ? 'diary'
        : d.document_id.startsWith('mtgboard_') ? 'meeting' : 'other';
  return docs
    .map((d) => ({ document_id: d.document_id, filename: d.filename || '(未命名)', kind: kindOf(d), saved_at: d.saved_at || '' }))
    .sort((a, b) => b.saved_at.localeCompare(a.saved_at));
}

/** 删除一篇日记：移除 doc 记录 + 它在各账本（marks/ai_turns/基岩段+块）的所有条目。
 *  删的是当前活跃文档则连 saveTimer 一起清，防去抖回写把已删文档复活。 */
export async function deleteDiary(documentId: string): Promise<void> {
  const db = await openDB();
  if (!db) return;
  if (current?.document_id === documentId) {
    window.clearTimeout(saveTimer); saveTimer = undefined; // 取消去抖回写
    current = null;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction([STORE, MARKS, TURNS, INK_SEGMENTS, INK_SAMPLES], 'readwrite');
      tx.objectStore(STORE).delete(documentId);
      for (const name of [MARKS, TURNS, INK_SEGMENTS, INK_SAMPLES]) {
        const req = tx.objectStore(name).index('by_doc').getAllKeys(IDBKeyRange.only(documentId));
        req.onsuccess = () => { for (const k of (req.result as IDBValidKey[]) ?? []) tx.objectStore(name).delete(k); };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

/** 记阅读位置（去抖落盘）。 */
export function setLastReadPage(page: number): void {
  if (!current || current.last_read_page === page) return;
  current.last_read_page = page;
  scheduleSave();
}

/** 日记 materialize：写到新页时把当前日记的 page_count 抬到 count 并落盘（只增不减·空白翻页页不落）。 */
export function setDiaryPageCount(count: number): void {
  if (!current || count <= current.page_count) return;
  current.page_count = count;
  scheduleSave();
}

/** 当前文档已存的阅读位置（无则 0）。 */
export function lastReadPage(): number {
  return current?.last_read_page ?? 0;
}

// ── 账本：marks / ai_turns（append-only，每条独立记录）──

function appendEntry(storeName: string, rec: object): Promise<void> {
  return openDB().then((db) => {
    if (!db) return;
    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).add(rec); // add：新记录（entry_id 唯一），不就地改
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch { resolve(); }
    });
  });
}

function entriesByDoc<T extends { seq: number }>(storeName: string, documentId: string): Promise<T[]> {
  return openDB().then((db) => {
    if (!db) return [] as T[];
    return new Promise<T[]>((resolve) => {
      try {
        const r = db.transaction(storeName, 'readonly').objectStore(storeName).index('by_doc').getAll(IDBKeyRange.only(documentId));
        r.onsuccess = () => resolve(((r.result as T[]) ?? []).sort((a, b) => a.seq - b.seq));
        r.onerror = () => resolve([] as T[]);
      } catch { resolve([] as T[]); }
    });
  });
}

/** 同 entriesByDoc，但走 by_context 索引（C2 时间脊：按落笔时活跃 surface 实例聚合，跨 document）。 */
function entriesByContext<T extends { seq: number }>(storeName: string, contextId: string): Promise<T[]> {
  return openDB().then((db) => {
    if (!db) return [] as T[];
    return new Promise<T[]>((resolve) => {
      try {
        const r = db.transaction(storeName, 'readonly').objectStore(storeName).index('by_context').getAll(IDBKeyRange.only(contextId));
        r.onsuccess = () => resolve(((r.result as T[]) ?? []).sort((a, b) => a.seq - b.seq));
        r.onerror = () => resolve([] as T[]);
      } catch { resolve([] as T[]); }
    });
  });
}

/** 追加一条 mark 条目（含 tombstone）。store 填 entry_id/seq/created_at。 */
export function appendMarkEntry(m: Omit<PersistedMark, 'entry_id' | 'seq' | 'created_at'>): Promise<void> {
  const rec: PersistedMark = { ...m, entry_id: shortId('ent'), seq: nextSeq(), created_at: new Date().toISOString() };
  // C6：标注落账本同时排入向量库 seam（今 no-op）——真向量库接上时历史数据已在库，免冷启动 backfill。
  if (!rec.is_tombstone && rec.marked_text) {
    void vectorStore.upsert({ id: rec.entry_id, bookId: rec.document_id, pageIndex: rec.page_index, text: rec.marked_text, anchorRefs: rec.hmp?.target_object_refs });
  }
  return appendEntry(MARKS, rec);
}

/** 基岩：写一段录制头（每段一次）。 */
export function appendInkSegment(seg: PersistedInkSegment): Promise<void> {
  return appendEntry(INK_SEGMENTS, seg);
}

/** 基岩：写一块采样（批量 flush）。 */
export function appendInkChunk(chunk: PersistedInkChunk): Promise<void> {
  return appendEntry(INK_SAMPLES, chunk);
}

/** 基岩：按书读段头 / 采样块（块按 seq 升序）——供回放、调试、测试。 */
function allByDoc<T>(storeName: string, documentId: string): Promise<T[]> {
  return openDB().then((db) => {
    if (!db) return [] as T[];
    return new Promise<T[]>((resolve) => {
      try {
        const r = db.transaction(storeName, 'readonly').objectStore(storeName).index('by_doc').getAll(IDBKeyRange.only(documentId));
        r.onsuccess = () => resolve((r.result as T[]) ?? []);
        r.onerror = () => resolve([] as T[]);
      } catch { resolve([] as T[]); }
    });
  });
}
export function getInkSegments(documentId: string): Promise<PersistedInkSegment[]> {
  return allByDoc<PersistedInkSegment>(INK_SEGMENTS, documentId);
}
export function getInkChunks(documentId: string): Promise<PersistedInkChunk[]> {
  return allByDoc<PersistedInkChunk>(INK_SAMPLES, documentId).then((cs) => cs.sort((a, b) => a.seq_from - b.seq_from));
}

/** 基岩保留：删掉 created_at 早于 maxAgeMs 的段+块（默认 14 天）。基岩是档案、可裁——
 *  不像 marks/ai_turns 是不可删的真相账本。录像机起新段时顺手跑一次（每 app 会话一次）。 */
export async function pruneBedrock(maxAgeMs = 14 * 24 * 3600_000): Promise<{ removed: number }> {
  const db = await openDB();
  if (!db) return { removed: 0 };
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  let removed = 0;
  for (const storeName of [INK_SEGMENTS, INK_SAMPLES]) {
    const key = storeName === INK_SEGMENTS ? 'segment_id' : 'chunk_id';
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const os = tx.objectStore(storeName);
        const r = os.getAll();
        r.onsuccess = () => {
          for (const rec of (r.result ?? []) as Array<Record<string, string>>) {
            if (rec.created_at && rec.created_at < cutoff) { os.delete(rec[key]); removed++; }
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch { resolve(); }
    });
  }
  return { removed };
}

/** 追加一条 ai_turn 条目。 */
export function appendAiTurnEntry(t: Omit<PersistedAiTurn, 'entry_id' | 'seq' | 'created_at'>): Promise<void> {
  const rec: PersistedAiTurn = { ...t, entry_id: shortId('ent'), seq: nextSeq(), created_at: new Date().toISOString() };
  return appendEntry(TURNS, rec);
}

/** 折叠 mark：去掉被 tombstone 的 mark_id，每 mark_id 取最新非墓碑条目。 */
function foldMarks(all: PersistedMark[]): PersistedMark[] {
  const dead = new Set<string>();
  for (const e of all) if (e.is_tombstone) dead.add(e.mark_id);
  const live = new Map<string, PersistedMark>();
  for (const e of all) if (!e.is_tombstone && !dead.has(e.mark_id)) live.set(e.mark_id, e);
  return [...live.values()].sort((a, b) => a.seq - b.seq);
}

/** 折叠 mark（按 document）：单个 surface 的标注。 */
export async function getFoldedMarks(documentId: string): Promise<PersistedMark[]> {
  return foldMarks(await entriesByDoc<PersistedMark>(MARKS, documentId));
}

/** 折叠 mark（按 context_id，走 by_context 索引）：会议时间脊用——把一场会议里跨 surface（白板 + 各资料）
 *  的所有标注按「落笔时活跃实例」聚合。会中保持 meetingCtx 活跃 → 白板与资料上的笔都带 context_id='mtg_<id>'。 */
export async function getFoldedMarksByContext(contextId: string): Promise<PersistedMark[]> {
  return foldMarks(await entriesByContext<PersistedMark>(MARKS, contextId));
}

/** 未综合的 mark（seq > 当前书水位线）：reload 重建 pending session。
 *  排除 ai_eligible===false 的内容笔（Phase P 普通笔=纯内容）——否则 reload 后普通墨被塞回 pending、
 *  下次 idle 误当 AI 笔综合。老条目无此字段(undefined)按旧行为保留。 */
export async function getPendingMarks(documentId: string): Promise<PersistedMark[]> {
  const wm = current?.synthesis_watermark_seq ?? -1;
  return (await getFoldedMarks(documentId)).filter((m) => m.seq > wm && m.ai_eligible !== false);
}

/** 按 id 取一本书的记录（只读，不挂 current）。KnowledgeBuilder 等派生投影按 documentId 取书目元（如 filename 当标题）。 */
export function getDoc(documentId: string): Promise<PersistedDoc | null> {
  return getOneFrom<PersistedDoc>(STORE, documentId);
}

/** 折叠 ai_turn：每 overlay_id 取最新（最高 seq）条目（含 dismissed，由调用方决定显示）。 */
export async function getBookAiTurns(documentId: string): Promise<PersistedAiTurn[]> {
  const all = await entriesByDoc<PersistedAiTurn>(TURNS, documentId);
  const latest = new Map<string, PersistedAiTurn>();
  for (const e of all) latest.set(e.overlay_id, e); // 已按 seq 升序 → 末者最新
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/** overlay 状态变化（接受/编辑/忽略）：追加一条 supersedes 上一轮的 ai_turn，记新状态/改写文本。 */
export async function updateOverlayState(documentId: string, overlay: ScreenOverlay): Promise<void> {
  const turns = await entriesByDoc<PersistedAiTurn>(TURNS, documentId);
  const prior = turns.filter((t) => t.overlay_id === overlay.overlay_id).pop();
  if (!prior) return; // 无原始轮（理论不该发生）
  const st: OverlayState = overlay.state;
  await appendAiTurnEntry({
    ...prior,
    overlay,
    overlay_state: st,
    user_edited_text: st === 'edited' ? overlay.display_text : prior.user_edited_text,
    supersedes: prior.entry_id,
  });
}

/** 综合提交成功后：把指定书的水位线推到当前最大 seq（此前所有 mark 记为已综合）。
 *  默认当前活跃文档；AI 会话提交显式传归属文档——回答期间已切走时仍写对正确的书（B1）。 */
export function setSynthesisWatermark(doc: PersistedDoc | null = current): void {
  if (!doc) return;
  doc.synthesis_watermark_seq = seqCounter;
  if (doc === current) scheduleSave();
  else void idbPut(doc); // 非活跃文档：直接落盘该书水位线，不动当前去抖
}

// ── docs 内部：页缓存（reflow/图解）──

function page(i: number): PersistedPage | null {
  if (!current) return null;
  if (!current.pages[i]) {
    current.pages[i] = { page_index: i, reflow: null, reflow_engine: null, images: [], status: 'pending' };
  }
  const p = current.pages[i];
  if (!p.images) p.images = []; // 老格式兼容
  return p;
}

function scheduleSave(): void {
  const doc = current; // 绑定到这个 doc：current 之后被重指向/切档，定时器仍落到正确的书，不串档
  if (!doc) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { doc.saved_at = new Date().toISOString(); void idbPut(doc); }, 600);
}

/** 立即落盘当前 doc 的在途改动并清掉去抖定时器（切档前调，防丢写）。 */
function flushSave(): void {
  if (saveTimer === undefined) return;
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  if (current) { current.saved_at = new Date().toISOString(); void idbPut(current); }
}

function overlap(a: NormBBox, b: NormBBox): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return (ix * iy) / (Math.min(a[2] * a[3], b[2] * b[3]) || 1);
}

// ── 重排缓存（切引擎需重排，故带 engine 校验）──
export function getReflow(i: number, engine: string): ReflowBlock[] | null {
  const p = current?.pages[i];
  return p && p.reflow && p.reflow_engine === engine ? p.reflow : null;
}
export function putReflow(i: number, engine: string, blocks: ReflowBlock[]): void {
  const p = page(i);
  if (!p) return;
  p.reflow = blocks; p.reflow_engine = engine;
  if (p.status === 'pending') p.status = 'reflowed';
  scheduleSave();
}

// ── 图像解读缓存（按 bbox 高度重叠匹配）──
export function getImageExplain(i: number, bbox: NormBBox): string | null {
  const p = current?.pages[i];
  const hit = p?.images.find((im) => overlap(im.bbox, bbox) > 0.8);
  return hit ? hit.explanation : null;
}
export function putImageExplain(i: number, bbox: NormBBox, explanation: string): void {
  const p = page(i);
  if (!p) return;
  const ex = p.images.find((im) => overlap(im.bbox, bbox) > 0.8);
  if (ex) ex.explanation = explanation; else p.images.push({ bbox, explanation });
  scheduleSave();
}

// ── 会议工作区（v4）：workspaces + meetings（CRUD，非 append-only，就地 put）──────

// 写失败要让上层知道（L1 事件消费靠它决定「写确认成功才推 cursor」·防静默丢同步）。
// 但 db 不可用（隐私模式/不支持 IndexedDB）仍降级纯内存——与全局降级一致·不抛。
function putInto(storeName: string, rec: object): Promise<void> {
  return openDB().then((db) => {
    if (!db) return;
    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(rec);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error(`IndexedDB put failed: ${storeName}`));
        tx.onabort = () => reject(tx.error ?? new Error(`IndexedDB put aborted: ${storeName}`));
      } catch (e) { reject(e); }
    });
  });
}
function getAllFrom<T>(storeName: string): Promise<T[]> {
  return openDB().then((db) => {
    if (!db) return [] as T[];
    return new Promise<T[]>((resolve) => {
      try {
        const r = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        r.onsuccess = () => resolve((r.result as T[]) ?? []);
        r.onerror = () => resolve([] as T[]);
      } catch { resolve([] as T[]); }
    });
  });
}
function getOneFrom<T>(storeName: string, key: string): Promise<T | null> {
  return openDB().then((db) => {
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      try {
        const r = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        r.onsuccess = () => resolve((r.result as T) ?? null);
        r.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  });
}
function byIndexFrom<T>(storeName: string, index: string, key: string): Promise<T[]> {
  return openDB().then((db) => {
    if (!db) return [] as T[];
    return new Promise<T[]>((resolve) => {
      try {
        const r = db.transaction(storeName, 'readonly').objectStore(storeName).index(index).getAll(IDBKeyRange.only(key));
        r.onsuccess = () => resolve((r.result as T[]) ?? []);
        r.onerror = () => resolve([] as T[]);
      } catch { resolve([] as T[]); }
    });
  });
}

/** 新建工作区（群聊）。 */
export async function createWorkspace(name: string): Promise<PersistedWorkspace> {
  const now = new Date().toISOString();
  const ws: PersistedWorkspace = { workspace_id: shortId('ws'), name: name.trim() || '未命名群聊', source: 'manual', created_at: now, updated_at: now };
  await putInto(WORKSPACES, ws);
  return ws;
}
/** 列出工作区（最近更新在前）。 */
export function listWorkspaces(): Promise<PersistedWorkspace[]> {
  return getAllFrom<PersistedWorkspace>(WORKSPACES).then((a) => a.sort((x, y) => (y.updated_at || '').localeCompare(x.updated_at || '')));
}
export function getWorkspace(id: string): Promise<PersistedWorkspace | null> {
  return getOneFrom<PersistedWorkspace>(WORKSPACES, id);
}
/** 幂等 upsert 一个飞书来源工作区（id 由 chat_id 派生·稳定）。名字没变就不动 updated_at，避免列表抖动。 */
export async function upsertFeishuWorkspace(chatId: string, name: string): Promise<PersistedWorkspace> {
  const id = `ws_fs_${chatId}`;
  const cur = await getOneFrom<PersistedWorkspace>(WORKSPACES, id);
  if (cur && cur.name === name && cur.source === 'feishu') return cur;
  const now = new Date().toISOString();
  const ws: PersistedWorkspace = { workspace_id: id, name: name.trim() || '未命名群聊', source: 'feishu', feishu_chat_id: chatId, created_at: cur?.created_at ?? now, updated_at: now };
  await putInto(WORKSPACES, ws);
  return ws;
}

/** 无群飞书会议的兜底工作区（manual·不带 feishu_chat_id → renderWs 不会去拉群 members/messages 而失败）。 */
export async function upsertPanelWorkspace(name = '飞书会议'): Promise<PersistedWorkspace> {
  const id = 'ws_panel_meetings';
  const cur = await getOneFrom<PersistedWorkspace>(WORKSPACES, id);
  if (cur && cur.source === 'manual') return cur;
  const now = new Date().toISOString();
  const ws: PersistedWorkspace = { workspace_id: id, name: name.trim() || '飞书会议', source: 'manual', created_at: cur?.created_at ?? now, updated_at: now };
  await putInto(WORKSPACES, ws);
  return ws;
}

/** 新建会议（属某工作区）。status 据计划时间派生：过去=已结束，否则=待开始。 */
export async function createMeeting(workspaceId: string, input: { title: string; scheduled_at: string }): Promise<PersistedMeeting> {
  const now = new Date().toISOString();
  const t = new Date(input.scheduled_at).getTime();
  const status: MeetingStatus = Number.isFinite(t) && t < Date.now() ? 'ended' : 'upcoming';
  const mtg: PersistedMeeting = {
    meeting_id: shortId('mtg'), workspace_id: workspaceId, title: input.title.trim() || '未命名会议',
    scheduled_at: input.scheduled_at, status, material_doc_ids: [], created_at: now, updated_at: now,
  };
  await putInto(MEETINGS, mtg);
  return mtg;
}
/** 某工作区的会议（计划时间倒序）。 */
export function listMeetings(workspaceId: string): Promise<PersistedMeeting[]> {
  return byIndexFrom<PersistedMeeting>(MEETINGS, 'by_ws', workspaceId).then((a) => a.sort((x, y) => (y.scheduled_at || '').localeCompare(x.scheduled_at || '')));
}
/** 所有会议（日程聚合用）。 */
export function listAllMeetings(): Promise<PersistedMeeting[]> {
  return getAllFrom<PersistedMeeting>(MEETINGS);
}
export function getMeeting(id: string): Promise<PersistedMeeting | null> {
  return getOneFrom<PersistedMeeting>(MEETINGS, id);
}
/** 局部更新一场会议（合并 patch + 刷新 updated_at）。 */
export async function updateMeeting(id: string, patch: Partial<PersistedMeeting>): Promise<PersistedMeeting | null> {
  const cur = await getOneFrom<PersistedMeeting>(MEETINGS, id);
  if (!cur) return null;
  const next: PersistedMeeting = { ...cur, ...patch, updated_at: new Date().toISOString() };
  await putInto(MEETINGS, next);
  return next;
}

// ── WS2-C：妙记转写缓存（会后离线复盘不丢转写）──
export function getCachedMinute(minuteToken: string): Promise<PersistedMeetingMinute | null> {
  return getOneFrom<PersistedMeetingMinute>(MEETING_MINUTES, minuteToken);
}
export async function putCachedMinute(rec: PersistedMeetingMinute): Promise<void> {
  await putInto(MEETING_MINUTES, rec);
}

/**
 * 模拟会议（开发/演示用，非真实飞书 live 会议）：在一个**飞书来源**工作区下开一场 status=live 的会议，
 * 好让会中工作台能从那个真实群里拉资料、把"除真正加入会议外的所有流程"都走真的。
 * 已存在就复用（确保 live + 有 started_at）；没有飞书工作区返回 null。
 */
export async function startSimMeeting(): Promise<PersistedMeeting | null> {
  const wss = await listWorkspaces();
  const ws = wss.find((w) => w.source === 'feishu' && w.feishu_chat_id);
  if (!ws) return null;
  const existing = (await listMeetings(ws.workspace_id)).find((m) => m.title.startsWith('模拟会议'));
  const now = new Date().toISOString();
  if (existing) {
    return existing.status === 'live' && existing.started_at
      ? existing
      : ((await updateMeeting(existing.meeting_id, { status: 'live', started_at: existing.started_at ?? now })) ?? existing);
  }
  const m = await createMeeting(ws.workspace_id, { title: `模拟会议 · ${ws.name}`, scheduled_at: now });
  return (await updateMeeting(m.meeting_id, { status: 'live', started_at: now })) ?? m;
}
