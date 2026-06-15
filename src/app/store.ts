/**
 * 本地持久化存储（IndexedDB）—— 把每个文档的语义蒸馏存下来，重开即恢复。
 * 一个文档一条记录（PersistedDoc，含各页蒸馏），按 document_id 主键。
 * 内存里持有当前文档 `current`（同步读写），改动去抖后异步落 IndexedDB。
 * 全程 try/catch：IDB 不可用（隐私模式等）则退化为「仅内存」，不影响主流程。
 */
import type { NormBBox } from '../core/contracts';
import type { ReflowBlock } from '../core/reflow';
import type { PersistedDoc, PersistedMemory, PersistedPage } from '../core/store-format';
import { STORE_VERSION } from '../core/store-format';

const DB_NAME = 'inkloop';
const STORE = 'docs';
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'document_id' });
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
  if (saved && saved.version === STORE_VERSION) { current = saved; return true; }
  current = { ...meta, saved_at: new Date().toISOString(), version: STORE_VERSION, pages: {} };
  return false;
}

function page(i: number): PersistedPage | null {
  if (!current) return null;
  if (!current.pages[i]) {
    current.pages[i] = {
      page_index: i, reflow: null, reflow_engine: null, images: [],
      memory: { content: null, activity: null, marks: [] }, annotations: [], status: 'pending',
    };
  }
  return current.pages[i];
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

// ── 两段记忆 ──
export function putMemory(i: number, mem: PersistedMemory): void {
  const p = page(i);
  if (!p) return;
  p.memory = { content: mem.content, activity: mem.activity, marks: mem.marks.slice() };
  scheduleSave();
}
/** 记忆A：内容解读（预处理写入）。 */
export function putContent(i: number, content: string): void {
  const p = page(i);
  if (!p) return;
  p.memory.content = content;
  if (p.status !== 'done') p.status = 'done';
  scheduleSave();
}
export function getContent(i: number): string | null {
  return current?.pages[i]?.memory.content ?? null;
}
