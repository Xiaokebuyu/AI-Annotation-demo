import { describe, expect, it } from 'vitest';
import { finalize } from '../../knowledge/builder';
import type { KnowledgeKind, KnowledgeObject } from '../../knowledge/knowledge-object';
import { buildConceptLayer, CONCEPT_DOC_ID, normConcept, type ConceptExtractFn } from './concept-layer';

const mkKo = (documentId: string, body: string, createdAt = '2026-06-29T10:00:00Z', kind: KnowledgeKind = 'annotation'): Promise<KnowledgeObject> =>
  finalize({ stableKey: `m:${documentId}:${body}`, kind, documentId, documentTitle: 'doc', objectRefs: ['r'], body, provenance: { created_from: 'mark', mark_ids: ['m'] }, status: 'export_ready', createdAt });

// 假抽取器：按 KO 正文查表（真实现=LLM）。
const lookupExtract = (table: Record<string, string[]>): ConceptExtractFn => async (ko) => table[ko.body_md] ?? [];

describe('buildConceptLayer', () => {
  it('跨文档桥成概念枢纽；同文档/单成员概念被丢（防毛球）', async () => {
    const a = await mkKo('doc_csapp', 'MESI 缓存一致性'); // 缓存一致性, MESI
    const b = await mkKo('doc_ddia', '复制一致性'); // 缓存一致性, 复制
    const c = await mkKo('doc_csapp', '局部性原理'); // 局部性（单文档单成员）
    const layer = await buildConceptLayer([a, b, c], lookupExtract({
      'MESI 缓存一致性': ['缓存一致性', 'MESI'],
      '复制一致性': ['缓存一致性', '复制'],
      '局部性原理': ['局部性'],
    }));
    // 只有「缓存一致性」跨了 doc_csapp + doc_ddia 两文档、2 成员 → 留；MESI/复制/局部性都单成员或单文档 → 丢
    expect(layer.concepts.map((k) => k.title)).toEqual(['缓存一致性']);
    const concept = layer.concepts[0];
    expect(concept.kind).toBe('concept');
    expect(concept.source.document_id).toBe(CONCEPT_DOC_ID);
    expect(layer.membersByConcept['缓存一致性'].sort()).toEqual([a.ko_id, b.ko_id].sort());
    expect(layer.assignmentsByKo[a.ko_id]).toEqual(['缓存一致性']);
    expect(layer.assignmentsByKo[b.ko_id]).toEqual(['缓存一致性']);
    expect(layer.assignmentsByKo[c.ko_id]).toBeUndefined(); // 局部性被丢→c 无概念
  });

  it('规范化归并：大小写/空白不同的同概念合一（显示名取确定性首位：早 created_at）', async () => {
    const a = await mkKo('doc_1', 'x', '2026-06-29T10:00:00Z'); // 更早 → 稳定排序后首位
    const b = await mkKo('doc_2', 'y', '2026-06-29T11:00:00Z');
    const layer = await buildConceptLayer([b, a], lookupExtract({ x: ['Cache Coherence'], y: ['cache  coherence'] })); // 故意倒序传入
    expect(layer.concepts).toHaveLength(1);
    expect(layer.concepts[0].title).toBe('Cache Coherence'); // 不随输入序漂移：取 created_at 早的 a 的原样
    expect(layer.membersByConcept['Cache Coherence']).toHaveLength(2);
  });

  it('占位正文（图形/未识别手写）不抽概念', async () => {
    const a = await mkKo('doc_1', '（图形标注 / 圈画）');
    const b = await mkKo('doc_2', '（未识别手写）');
    let called = 0;
    const layer = await buildConceptLayer([a, b], async () => { called++; return ['噪声']; });
    expect(called).toBe(0);
    expect(layer.concepts).toEqual([]);
  });

  it('会议手写占位带时间尾巴「（约 m:ss 处手写）」也跳过（不抽假概念）', async () => {
    const a = await mkKo('mtgdoc_1', '（图形标注 / 圈画）　（约 0:16 处手写）');
    const b = await mkKo('mtgdoc_2', '（图形标注 / 圈画）　（约 1:20 处手写）');
    let called = 0;
    const layer = await buildConceptLayer([a, b], async () => { called++; return ['图形标注']; });
    expect(called).toBe(0); // 剥尾巴后命中 PLACEHOLDER → 根本不调 LLM
    expect(layer.concepts).toEqual([]);
  });

  it('concept ko_id 确定性（重建不漂移·stableKey=concept:规范名）', async () => {
    const ks = [await mkKo('d1', 'p'), await mkKo('d2', 'q')];
    const tbl = lookupExtract({ p: ['一致性'], q: ['一致性'] });
    const a = await buildConceptLayer(ks, tbl);
    const b = await buildConceptLayer(ks, tbl);
    expect(a.concepts[0].ko_id).toBe(b.concepts[0].ko_id);
  });

  it('topK 限制每笔概念数', async () => {
    const a = await mkKo('d1', 'm');
    const b = await mkKo('d2', 'm2');
    // a 抽 4 个，但 topK=2 只取前 2；与 b 共享前 2 才可能成桥
    const layer = await buildConceptLayer([a, b], lookupExtract({ m: ['A', 'B', 'C', 'D'], m2: ['A', 'B'] }), { topK: 2 });
    expect((layer.assignmentsByKo[a.ko_id] ?? []).length).toBeLessThanOrEqual(2);
    expect(layer.concepts.map((k) => k.title).sort()).toEqual(['A', 'B']);
  });

  it('normConcept：NFKC+压空白+折大小写', () => {
    expect(normConcept('  Cache   Coherence ')).toBe('cache coherence');
    expect(normConcept('缓存一致性')).toBe('缓存一致性');
  });

  it('两级：单文档复现→local（只标签·不建 hub）·单笔→丢', async () => {
    const a = await mkKo('doc_x', 'p1');
    const b = await mkKo('doc_x', 'p2');
    const c = await mkKo('doc_x', 'p3');
    const layer = await buildConceptLayer([a, b, c], lookupExtract({ p1: ['局部性'], p2: ['局部性'], p3: ['虚拟内存'] }));
    expect(layer.concepts).toEqual([]); // 没跨文档 → 无 primary hub
    expect(layer.localByKo[a.ko_id]).toEqual(['局部性']); // 2 成员 1 文档 → local
    expect(layer.localByKo[b.ko_id]).toEqual(['局部性']);
    expect(layer.localByKo[c.ko_id]).toBeUndefined(); // 虚拟内存 单笔 → 丢（不出标签）
    expect(layer.assignmentsByKo[a.ko_id]).toBeUndefined(); // local 不进 assignments（不出 wikilink）
  });

  it('晋升免状态：本地概念跨到第二文档→重算自动变 primary', async () => {
    const a = await mkKo('doc_x', 'p1');
    const b = await mkKo('doc_x', 'p2');
    const before = await buildConceptLayer([a, b], lookupExtract({ p1: ['局部性'], p2: ['局部性'] }));
    expect(before.concepts).toEqual([]); // 同文档 → local
    const c = await mkKo('doc_y', 'p3'); // 第二文档也谈
    const after = await buildConceptLayer([a, b, c], lookupExtract({ p1: ['局部性'], p2: ['局部性'], p3: ['局部性'] }));
    expect(after.concepts.map((x) => x.title)).toEqual(['局部性']); // 自动晋升 primary
    expect(after.localByKo[a.ko_id]).toBeUndefined();
  });

  it('merge seam：近义 key 并进 canonical（成员/边重映射）', async () => {
    const a = await mkKo('doc_1', 'm1');
    const b = await mkKo('doc_2', 'm2');
    const tbl = lookupExtract({ m1: ['语义层', '抽象层级'], m2: ['语义层', '抽象层级'] });
    const noMerge = await buildConceptLayer([a, b], tbl);
    expect(noMerge.concepts.map((c) => c.title).sort()).toEqual(['抽象层级', '语义层']); // 不合并=两个冗余 hub
    const merged = await buildConceptLayer([a, b], tbl, { merge: () => new Map([['抽象层级', '语义层']]) });
    expect(merged.concepts.map((c) => c.title)).toEqual(['语义层']); // 合并成一个
    expect(merged.membersByConcept['语义层'].sort()).toEqual([a.ko_id, b.ko_id].sort());
    expect(merged.assignmentsByKo[a.ko_id]).toEqual(['语义层']); // 抽象层级 被重映射掉
  });
});
