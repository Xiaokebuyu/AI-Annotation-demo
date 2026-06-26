import { describe, it, expect } from 'vitest';
import { pageIdFor } from './ids';

describe('pageIdFor 页 ID 唯一性（B5：消会议资料截断碰撞）', () => {
  it('同一会议、不同资料、相同页号 → 不碰撞（旧 slice(4,12) 会撞）', () => {
    // 旧实现 documentId.slice(4,12) 对这两个都取到 "oc_mtg_a" → 同 pageId；新哈希全 id 后必不同。
    const a = pageIdFor('mtgdoc_mtg_abc123_msg1', 0);
    const b = pageIdFor('mtgdoc_mtg_abc123_msg2', 0);
    expect(a).not.toBe(b);
  });

  it('确定性：同 documentId + 同页号永远同一 ID（跨 reload 稳定，账本可对上）', () => {
    expect(pageIdFor('doc_deadbeef0011', 3)).toBe(pageIdFor('doc_deadbeef0011', 3));
  });

  it('同文档不同页号 → 不同 ID；格式 pg_<8hex>_<页号>', () => {
    const p0 = pageIdFor('doc_deadbeef0011', 0);
    const p1 = pageIdFor('doc_deadbeef0011', 1);
    expect(p0).not.toBe(p1);
    expect(p0).toMatch(/^pg_[0-9a-f]{8}_0$/);
    expect(p1).toMatch(/^pg_[0-9a-f]{8}_1$/);
  });

  it('一批不同会议/资料的页号无碰撞（抽样）', () => {
    const ids: string[] = [];
    for (const mtg of ['mtg_a', 'mtg_bb', 'mtg_ccc']) {
      for (const msg of ['m1', 'm2', 'm3']) {
        for (let pg = 0; pg < 4; pg++) ids.push(pageIdFor(`mtgdoc_${mtg}_${msg}`, pg));
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
