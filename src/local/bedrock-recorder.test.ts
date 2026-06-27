import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedInkChunk, PersistedInkSegment } from '../core/bedrock';

// 测试环境无 IndexedDB（见 store.test.ts 注释）。打桩 store 的两个写入口，捕获录像机塑出的记录，
// 验证它真正的活：把采样塑成正确的段头(profile/锚) + 攒批采样块、换书起新段。IDB 落库走 appendEntry，
// 与已在生产验证的 marks 账本同一条路径，此处不重复测。
const { segments, chunks } = vi.hoisted(() => ({ segments: [] as PersistedInkSegment[], chunks: [] as PersistedInkChunk[] }));
vi.mock('./store', () => ({
  appendInkSegment: (s: PersistedInkSegment) => { segments.push(s); return Promise.resolve(); },
  appendInkChunk: (c: PersistedInkChunk) => { chunks.push(c); return Promise.resolve(); },
  pruneBedrock: () => Promise.resolve({ removed: 0 }),
}));

import { bedrockMarkBoundary, flushBedrock, recordInkSample } from './bedrock-recorder';

describe('bedrock-recorder（录像机）', () => {
  beforeEach(() => { segments.length = 0; chunks.length = 0; });

  it('录 down→move→up → 段头(profile+墙钟锚) + 攒批采样块', async () => {
    const doc = 'doc_t1';
    const dims = { w: 800, h: 1000 };
    recordInkSample({ documentId: doc, pageId: 'pg_t_0', x: 0.1, y: 0.2, phase: 'down', contactId: 7, dims, penSource: true, pressure: 0.5 });
    recordInkSample({ documentId: doc, x: 0.15, y: 0.22, phase: 'move', contactId: 7, dims });
    recordInkSample({ documentId: doc, x: 0.2, y: 0.25, phase: 'up', contactId: 7, dims });
    await flushBedrock();

    expect(segments.length).toBe(1);
    expect(segments[0].profile.source).toBe('pointerevent');
    expect(segments[0].profile.native_x_max).toBe(800);
    expect(segments[0].profile.has_pressure).toBe(true);     // penSource=true
    expect(segments[0].anchor.wall_clock_iso).toBeTruthy();
    expect(typeof segments[0].anchor.mono_ms_origin).toBe('number');

    const samples = chunks.flatMap((c) => c.samples);
    expect(samples.length).toBe(3);
    expect(samples.map((s) => s.phase)).toEqual(['down', 'move', 'up']);
    expect(samples.map((s) => s.seq)).toEqual([0, 1, 2]);     // 段内单调
    expect(samples[0].contact_id).toBe(7);
    expect(samples[0].x).toBeCloseTo(0.1);
    expect(samples[0].dynamics?.pressure).toBe(0.5);          // 有压感源 + pressure>0 → 进 dynamics
    expect(samples[1].dynamics).toBeUndefined();              // 无 pressure → 整体省略
  });

  it('换书自动起新段，两书的段不串', async () => {
    const dims = { w: 100, h: 100 };
    recordInkSample({ documentId: 'docA', x: 0.1, y: 0.1, phase: 'down', contactId: 1, dims });
    await flushBedrock();
    recordInkSample({ documentId: 'docB', x: 0.2, y: 0.2, phase: 'down', contactId: 1, dims }); // 换书
    await flushBedrock();

    expect(segments.length).toBe(2);
    expect(segments[0].document_id).toBe('docA');
    expect(segments[1].document_id).toBe('docB');
    expect(segments[0].segment_id).not.toBe(segments[1].segment_id);
    // docB 的块不挂到 docA 的段
    expect(chunks.filter((c) => c.document_id === 'docB').every((c) => c.segment_id === segments[1].segment_id)).toBe(true);
  });

  it('bedrockMarkBoundary 返回"上次收口以来"的精确 seq 区间，跨笔连续不重叠', () => {
    const dims = { w: 100, h: 100 };
    const doc = 'doc_rawref';
    // 第一笔：3 帧 → seq 0,1,2
    recordInkSample({ documentId: doc, x: 0.1, y: 0.1, phase: 'down', contactId: 1, dims });
    recordInkSample({ documentId: doc, x: 0.2, y: 0.2, phase: 'move', contactId: 1, dims });
    recordInkSample({ documentId: doc, x: 0.3, y: 0.3, phase: 'up', contactId: 1, dims });
    const r1 = bedrockMarkBoundary(doc);
    expect(r1).toMatchObject({ seq_from: 0, seq_to: 2 });
    expect(r1?.segment_id).toBeTruthy();
    // 第二笔：2 帧 → seq 3,4，紧接上一个、不重叠、同段
    recordInkSample({ documentId: doc, x: 0.4, y: 0.4, phase: 'down', contactId: 2, dims });
    recordInkSample({ documentId: doc, x: 0.5, y: 0.5, phase: 'up', contactId: 2, dims });
    const r2 = bedrockMarkBoundary(doc);
    expect(r2).toMatchObject({ seq_from: 3, seq_to: 4 });
    expect(r2?.segment_id).toBe(r1?.segment_id);
    // 没有新采样再调 → undefined；别的书 → undefined
    expect(bedrockMarkBoundary(doc)).toBeUndefined();
    expect(bedrockMarkBoundary('other')).toBeUndefined();
    flushBedrock(); // 清掉挂起的 flush 定时器
  });
});
