import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PersistedDoc } from '../core/store-format';
import { STORE_VERSION } from '../core/store-format';

// node 环境：window 用空壳（store 的去抖只调 set/clearTimeout，不真等定时器）；
// indexedDB 缺失 → store 内 try/catch 自动退化为「仅内存」，正好测同步的活跃文档重指向逻辑。
function mkDoc(id: string): PersistedDoc {
  return { document_id: id, file_hash: id, filename: id, page_count: 10, saved_at: '', version: STORE_VERSION, pages: {} };
}

describe('store 活跃文档重指向（R6：根除模块级 current 双真相 P0-4）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
  });

  it('切档后写操作只落当前活跃文档，切回不被污染', async () => {
    const store = await import('./store');
    const A = mkDoc('A');
    const B = mkDoc('B');

    store.setActiveDoc(A);
    store.setLastReadPage(3);
    expect(store.lastReadPage()).toBe(3);
    expect(A.last_read_page).toBe(3);

    store.setActiveDoc(B); // 进会议、打开材料 B
    expect(store.lastReadPage()).toBe(0); // B 没读过
    store.setLastReadPage(7);
    expect(B.last_read_page).toBe(7);
    expect(A.last_read_page).toBe(3); // ← 核心：A 不被 B 期的翻页污染

    store.setActiveDoc(A); // 退会议切回阅读 A
    expect(store.lastReadPage()).toBe(3); // A 的阅读位置完好
    expect(B.last_read_page).toBe(7);
  });

  it('综合水位线也只写当前文档，不串档', async () => {
    const store = await import('./store');
    const A = mkDoc('A');
    const B = mkDoc('B');

    store.setActiveDoc(A);
    store.setSynthesisWatermark();
    const wmA = A.synthesis_watermark_seq;
    expect(typeof wmA).toBe('number');

    store.setActiveDoc(B);
    store.setSynthesisWatermark();
    expect(B.synthesis_watermark_seq).toBeGreaterThanOrEqual(wmA as number);
    expect(A.synthesis_watermark_seq).toBe(wmA); // A 的水位线不被 B 覆盖
  });

  it('setActiveDoc(null)（白板）后写操作 no-op，不污染上一个文档', async () => {
    const store = await import('./store');
    const A = mkDoc('A');

    store.setActiveDoc(A);
    store.setLastReadPage(5);
    expect(A.last_read_page).toBe(5);

    store.setActiveDoc(null); // 白板：无持久化文档
    store.setLastReadPage(9); // 应 no-op
    expect(store.lastReadPage()).toBe(0);
    expect(A.last_read_page).toBe(5); // 上一个文档完好
  });
});
