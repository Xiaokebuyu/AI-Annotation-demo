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

  it('规范化归并：大小写/空白不同的同概念合一（显示名取首见）', async () => {
    const a = await mkKo('doc_1', 'x');
    const b = await mkKo('doc_2', 'y');
    const layer = await buildConceptLayer([a, b], lookupExtract({ x: ['Cache Coherence'], y: ['cache  coherence'] }));
    expect(layer.concepts).toHaveLength(1);
    expect(layer.concepts[0].title).toBe('Cache Coherence'); // 首见原样
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
});
