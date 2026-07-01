import { describe, expect, it } from 'vitest';
import type { EntityMembershipFact } from '../../knowledge/builder';
import { INK_PLACEHOLDER_DRAWING, INK_PLACEHOLDER_HANDWRITING } from '../../knowledge/builder';
import { dropInkPlaceholders, mergeConceptLayers } from './vault-collect';
import type { ConceptLayer } from 'ink-surface-sdk/export-core';

const ko = (ko_id: string, body_md: string) => ({ ko_id, body_md });
const wrap = (objects: ReturnType<typeof ko>[], entityFacts?: EntityMembershipFact[]) => ({
  knowledgeExport: { objects },
  entityFacts,
});
const factOf = (ko_id: string): EntityMembershipFact => ({
  entity_id: 'e1', ko_id, source_document_id: 'd', source_entry_id: 'ent', source: 'declared', created_at: '2026-06-30T00:00:00.000Z',
});

describe('dropInkPlaceholders（存储原生拓扑：占位 KO 带 entity_refs 不能被无声吞掉）', () => {
  it('无 entityFacts：占位 KO 照旧过滤，真内容不受影响', () => {
    const ex = wrap([ko('k1', INK_PLACEHOLDER_DRAWING), ko('k2', '真内容'), ko('k3', INK_PLACEHOLDER_HANDWRITING)]);
    const out = dropInkPlaceholders(ex);
    expect(out.knowledgeExport.objects.map((o) => o.ko_id)).toEqual(['k2']);
  });

  it('占位 KO 带 entity_refs（用户显式归类过）→ 保留，不被过滤（核心：这是本次要修的无声丢失）', () => {
    const ex = wrap([ko('k1', INK_PLACEHOLDER_DRAWING), ko('k2', '真内容')], [factOf('k1')]);
    const out = dropInkPlaceholders(ex);
    expect(out.knowledgeExport.objects.map((o) => o.ko_id).sort()).toEqual(['k1', 'k2']);
  });

  it('被过滤掉的 ko_id 对应的 entityFacts 也一并清掉（不留悬挂 fact）', () => {
    const ex = wrap([ko('k1', INK_PLACEHOLDER_DRAWING), ko('k2', '真内容')], [factOf('k2')]); // k1 无 fact 覆盖 → 该被过滤
    const out = dropInkPlaceholders(ex);
    expect(out.knowledgeExport.objects.map((o) => o.ko_id)).toEqual(['k2']);
    expect(out.entityFacts).toEqual([factOf('k2')]);
  });
});

const layer = (over: Partial<ConceptLayer> = {}): ConceptLayer => ({
  concepts: [], assignmentsByKo: {}, membersByConcept: {}, localByKo: {}, ...over,
});

describe('mergeConceptLayers（存储原生拓扑层 + legacy LLM 概念层 → 渲染器吃的单一 ConceptLayer）', () => {
  it('两者都缺 → undefined；只有一边 → 原样透传', () => {
    expect(mergeConceptLayers(undefined, undefined)).toBeUndefined();
    const stored = layer({ hubs: [{ entity_id: 'e1', title: '实体1' }] });
    expect(mergeConceptLayers(stored, undefined)).toBe(stored);
    const llm = layer({ concepts: [{ title: '概念1' } as never] });
    expect(mergeConceptLayers(undefined, llm)).toBe(llm);
  });

  it('两者都在：hubs 并集，llm 缺 hubs 时从 concepts 派生（否则 llm 的枢纽在渲染器里静默消失）', () => {
    const stored = layer({ hubs: [{ entity_id: 'e1', title: '存储实体' }], membersByConcept: { 存储实体: ['ko1'] } });
    const llm = layer({ concepts: [{ title: '概念A' } as never], membersByConcept: { 概念A: ['ko2'] } }); // 无 hubs
    const merged = mergeConceptLayers(stored, llm)!;
    expect(merged.hubs?.map((h) => h.title).sort()).toEqual(['存储实体', '概念A']);
    expect(merged.membersByConcept).toEqual({ 存储实体: ['ko1'], 概念A: ['ko2'] });
  });

  it('同 key 的成员数组去重合并（同一概念既有存储声明又有 LLM 建议）', () => {
    const stored = layer({ assignmentsByKo: { ko1: ['一致性'] } });
    const llm = layer({ assignmentsByKo: { ko1: ['一致性', '缓存'] } });
    const merged = mergeConceptLayers(stored, llm)!;
    expect(merged.assignmentsByKo.ko1).toEqual(['一致性', '缓存']); // 去重，不重复
  });
});
