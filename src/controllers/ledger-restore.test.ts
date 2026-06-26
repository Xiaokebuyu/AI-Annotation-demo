import { describe, it, expect, vi } from 'vitest';

// 受控 promise：让 getFoldedMarks 的返回时机可手动控制，精确复现「await 期间被抢占」的竞态。
const h = vi.hoisted(() => ({ resolveFolded: null as null | ((v: unknown[]) => void) }));

vi.mock('../local/store', () => ({
  getFoldedMarks: () => new Promise((r) => { h.resolveFolded = r as (v: unknown[]) => void; }),
  getBookAiTurns: () => Promise.resolve([]),
  getPendingMarks: () => Promise.resolve([]),
  setActiveDoc: () => {},
  activeDoc: () => null,
}));
vi.mock('../chat/buffer', () => ({ openBook: () => {}, appendMsg: () => {} }));
vi.mock('../capture/session', () => ({ addMark: () => {} }));

import { restoreLedgerState } from './ledger-restore';
import { getActiveContext } from '../app/state';

describe('restoreLedgerState 竞态守卫（P0-5）', () => {
  it('恢复中途被同实例的新恢复抢占：迟到的账本读不再写回原实例', async () => {
    const ctxA = getActiveContext();
    ctxA.strokesByPage.set('existing-page', []); // 预置：若旧恢复误执行会被 clear 掉

    const p = restoreLedgerState('A'); // 同步执行到 getFoldedMarks 的 await（已捕获 ctxA + gen）
    ctxA.restoreGeneration++;          // 模拟同实例新一轮恢复开始 → 旧的过期

    h.resolveFolded?.([{ mark_id: 'm1', page_id: 'pg1', strokes: [{ tool: 'pen', points: [] }] }]);
    await p;

    // 旧恢复 alive() 失败 → 提前 return：既不 clear 既有内容、也不写入新页
    expect(ctxA.strokesByPage.has('existing-page')).toBe(true);
    expect(ctxA.strokesByPage.has('pg1')).toBe(false);
  });
});
