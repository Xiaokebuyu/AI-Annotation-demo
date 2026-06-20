/**
 * 本地持久化存储（IndexedDB）—— 把每个文档的语义蒸馏存下来，重开即恢复。
 * 一个文档一条记录（PersistedDoc，含各页蒸馏），按 document_id 主键。
 * 内存里持有当前文档 `current`（同步读写），改动去抖后异步落 IndexedDB。
 * 全程 try/catch：IDB 不可用（隐私模式等）则退化为「仅内存」，不影响主流程。
 */
import type { NormBBox, ScreenOverlay } from '../core/contracts';
import type { ReflowBlock } from '../surface/reflow';
import type { PersistedDoc, PersistedPage, PersistedPdfBlob, PersistedStroke } from '../core/store-format';
import { STORE_VERSION } from '../core/store-format';

const DB_NAME = 'inkloop';
const STORE = 'docs';
const PDF_STORE = 'pdf_blobs'; // 阶段一：原始 PDF 字节（重开免重导），键 document_id
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 2); // v1→v2：新增 pdf_blobs（保留 docs 不动）
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'document_id' });
        if (!db.objectStoreNames.contains(PDF_STORE)) db.createObjectStore(PDF_STORE, { keyPath: 'document_id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
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
    } catch {
      resolve(null);
    }
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
    } catch {
      resolve();
    }
  });
}

let current: PersistedDoc | null = null;
let saveTimer: number | undefined;

export function storedDoc(): PersistedDoc | null {
  return current;
}

/** 打开文档：从 IndexedDB 载入已存的语义蒸馏（没有则新建）。返回 true=命中缓存。 */
export async function openDoc(meta: { document_id: string; file_hash: string; filename: string; page_count: number }): Promise<boolean> {
  const saved = await idbGet(meta.document_id);
  if (saved && saved.version === STORE_VERSION) {
    current = saved;
    current.page_count = meta.page_count; // 元信息以本次打开为准
    scheduleSave();
    return true;
  }
  current = { ...meta, saved_at: new Date().toISOString(), version: STORE_VERSION, pages: {} };
  scheduleSave(); // 即便不标注也落库（否则导入后直接刷新会丢书目、重开列不出）
  return false;
}

// ── 书籍持久化（阶段一）：PDF 原始字节 + 书目列表 + 阅读位置 ──

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

/** 列出已存的书（按最近保存倒序），供书架/最近列表。仅返回有 PDF 字节、能重开的书。 */
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
    .filter((d) => blobIds.has(d.document_id)) // 无字节的旧书重开不了，不列
    .sort((a, b) => (b.saved_at || '').localeCompare(a.saved_at || ''));
}

/** 记阅读位置（去抖落盘）。 */
export function setLastReadPage(page: number): void {
  if (!current || current.last_read_page === page) return;
  current.last_read_page = page;
  scheduleSave();
}

/** 当前文档已存的阅读位置（无则 0）。 */
export function lastReadPage(): number {
  return current?.last_read_page ?? 0;
}

function page(i: number): PersistedPage | null {
  if (!current) return null;
  if (!current.pages[i]) {
    current.pages[i] = {
      page_index: i, reflow: null, reflow_engine: null, images: [],
      strokes: [], overlays: [], status: 'pending',
    };
  }
  // 老格式兼容：恢复旧文档时补字段
  const p = current.pages[i];
  if (!p.strokes) p.strokes = [];
  if (!p.overlays) p.overlays = [];
  return p;
}

function scheduleSave(): void {
  if (!current) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (current) { current.saved_at = new Date().toISOString(); void idbPut(current); }
  }, 600);
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

// ── 笔迹（每页全量存）──
export function putStrokes(i: number, strokes: PersistedStroke[]): void {
  const p = page(i);
  if (!p) return;
  p.strokes = strokes.slice();
  scheduleSave();
}
export function getStrokes(i: number): PersistedStroke[] {
  return current?.pages[i]?.strokes ?? [];
}

// ── AI 卡片（按 overlay_id upsert）──
export function upsertOverlay(i: number, o: ScreenOverlay): void {
  const p = page(i);
  if (!p) return;
  const idx = p.overlays.findIndex((x) => x.overlay_id === o.overlay_id);
  if (idx >= 0) p.overlays[idx] = o; else p.overlays.push(o);
  scheduleSave();
}
export function removeOverlay(i: number, id: string): void {
  const p = page(i);
  if (!p) return;
  p.overlays = p.overlays.filter((x) => x.overlay_id !== id);
  scheduleSave();
}
export function getOverlays(i: number): ScreenOverlay[] {
  return current?.pages[i]?.overlays ?? [];
}
