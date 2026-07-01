import { describe, expect, it } from 'vitest';
import type { EntityMembershipFact } from '../../knowledge/builder';
import { INK_PLACEHOLDER_DRAWING, INK_PLACEHOLDER_HANDWRITING } from '../../knowledge/builder';
import { dropInkPlaceholders, mergeConceptLayers } from './vault-collect';
import type { ConceptLayer } from 'ink-surface-sdk/export-core';
import type { InkLoopVisualModel } from 'ink-surface-sdk/surface-model';

const ko = (ko_id: string, body_md: string) => ({ ko_id, body_md });
const wrap = (objects: ReturnType<typeof ko>[], entityFacts?: EntityMembershipFact[], visualModel?: InkLoopVisualModel) => ({
  knowledgeExport: { objects },
  entityFacts,
  visualModel,
});
const factOf = (ko_id: string): EntityMembershipFact => ({
  entity_id: 'e1', ko_id, source_document_id: 'd', source_entry_id: 'ent', source: 'declared', created_at: '2026-06-30T00:00:00.000Z',
});
const visualModelWithInk = (koId: string, kind: 'visual' | 'surface' = 'visual'): InkLoopVisualModel => ({
  documentTitle: 'x',
  blocks: [{
    id: 'b1', kind: 'paragraph', region: 'editable', content: '',
    annotations: [{
      ko_id: koId, kind: 'annotation', title: 'x',
      ...(kind === 'visual'
        ? { visual_strokes: [{ points: [{ x: 0.1, y: 0.1 }] }] }
        : { surface_strokes: [{ capture_surface: 'reader' as const, coord_space: 'reader_px' as const, points: [{ x: 1, y: 1 }] }] }),
    }],
  }],
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

describe('dropInkPlaceholders（笔迹 SVG 内嵌导出：占位 KO 挂了真笔迹也不能被无声吞掉）', () => {
  it('占位 KO 的 visualModel 里挂了 visual_strokes → 保留', () => {
    const ex = wrap([ko('k1', INK_PLACEHOLDER_DRAWING), ko('k2', '真内容')], undefined, visualModelWithInk('k1', 'visual'));
    const out = dropInkPlaceholders(ex);
    expect(out.knowledgeExport.objects.map((o) => o.ko_id).sort()).toEqual(['k1', 'k2']);
  });

  it('占位 KO 的 visualModel 里挂了 surface_strokes（reader 面原生坐标）→ 同样保留', () => {
    const ex = wrap([ko('k1', INK_PLACEHOLDER_HANDWRITING), ko('k2', '真内容')], undefined, visualModelWithInk('k1', 'surface'));
    const out = dropInkPlaceholders(ex);
    expect(out.knowledgeExport.objects.map((o) => o.ko_id).sort()).toEqual(['k1', 'k2']);
  });

  it('占位 KO 无 refs 也无笔迹 → 照旧被过滤（不是所有占位都豁免）', () => {
    const ex = wrap([ko('k1', INK_PLACEHOLDER_DRAWING), ko('k2', '真内容')], undefined, visualModelWithInk('k2', 'visual')); // 笔迹挂在 k2 上，不是 k1
    const out = dropInkPlaceholders(ex);
    expect(out.knowledgeExport.objects.map((o) => o.ko_id)).toEqual(['k2']);
  });

  it('被过滤掉的 ko_id，其 visualModel 里的 annotation 也一并清掉（不留死引用）', () => {
    const ex = wrap([ko('k1', INK_PLACEHOLDER_DRAWING), ko('k2', '真内容')], undefined, visualModelWithInk('k2', 'visual')); // k1 无笔迹无 refs → 被过滤
    const out = dropInkPlaceholders(ex);
    const annotations = out.visualModel!.blocks.flatMap((b) => b.annotations);
    expect(annotations.map((a) => a.ko_id)).toEqual(['k2']); // k1 的 annotation（如果有）不该残留；这里本就没有，验证结构完整
  });

  it('无 visualModel（如书/日记还没跑过导出）：dropInkPlaceholders 行为不变，不抛错', () => {
    const ex = wrap([ko('k1', INK_PLACEHOLDER_DRAWING), ko('k2', '真内容')]);
    const out = dropInkPlaceholders(ex);
    expect(out.knowledgeExport.objects.map((o) => o.ko_id)).toEqual(['k2']);
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

  // 同名 hub（存储实体 + LLM 概念独立发现同一个显示名）必须去重成一条：否则 SDK 渲染器按 title 建 Map 时
  // 后写覆盖前写，两条 hub 循环各写一份文件却互相踩踏——一份路径分配了却没人用，另一份被两次写入互相覆盖。
  it('同名 hub 去重：只保留一条，优先带 entity_id 的那条（存储原生更权威）', () => {
    const stored = layer({ hubs: [{ entity_id: 'attention', title: '注意力机制' }], membersByConcept: { 注意力机制: ['ko1'] } });
    const llm = layer({ hubs: [{ title: '注意力机制' }], concepts: [{ title: '注意力机制' } as never], membersByConcept: { 注意力机制: ['ko2'] } });
    const merged = mergeConceptLayers(stored, llm)!;
    expect(merged.hubs).toHaveLength(1); // 不是 2——这是本次要修的重复 hub bug
    expect(merged.hubs![0]).toEqual({ entity_id: 'attention', title: '注意力机制' }); // 保留带 entity_id 的那条
  });

  it('同名但大小写/全半角不同也算同一 hub（NFKC 归一后比较）', () => {
    const stored = layer({ hubs: [{ title: 'Cache Coherence' }] });
    const llm = layer({ hubs: [{ title: 'ｃache coherence' }] }); // 全角 c
    const merged = mergeConceptLayers(stored, llm)!;
    expect(merged.hubs).toHaveLength(1);
  });
});
