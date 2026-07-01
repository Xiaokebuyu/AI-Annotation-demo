import { describe, expect, it } from 'vitest';
import type { HMP, InferenceView, ScreenOverlay } from '../core/contracts';
import type { LedgerEntityRef, PersistedAiTurn, PersistedEntity, PersistedMark } from '../core/store-format';
import {
  assembleKnowledgeObjects,
  assembleKnowledgeProjection,
  type BuilderInput,
  enrichExportTags,
  finalize,
  INK_PLACEHOLDER_DRAWING,
  INK_PLACEHOLDER_HANDWRITING,
  isInkPlaceholderBody,
  normalizeEntityId,
  projectEntities,
} from './builder';
import { KO_SCHEMA_VERSION, type KnowledgeObject } from './knowledge-object';

/* ── 合成账本工厂（只填 builder 真读的字段，重型嵌套类型给最小占位）──────── */

function hmp(over: Partial<HMP> = {}): HMP {
  return {
    hmp_id: 'h0',
    surface_id: 's',
    mode: 'anchored',
    action: 'underline',
    target_region: [0, 0, 0, 0],
    target_object_refs: [],
    object_hint: 'text',
    confidence: 0.9,
    version: '2',
    ...over,
  };
}

function mark(over: Partial<PersistedMark> = {}): PersistedMark {
  return {
    entry_id: `ent_${over.mark_id ?? 'm0'}`,
    document_id: 'doc_test',
    page_id: 'pg_abcd1234_13',
    page_index: 13,
    seq: 1,
    created_at: '2026-06-26T06:35:10.000Z',
    mark_id: 'm0',
    strokes: [],
    bbox: [0.18, 0.52, 0.46, 0.03],
    tool: 'pen',
    color: '#1A1A1A',
    pointer_type: 'pen',
    device_id: 'dev_x',
    abs_timestamp: 0,
    feature_type: 'markup',
    feature_confidence: 0.9,
    scored_type: 'underline',
    scored_score: 0.8,
    hmp: null,
    marked_text: '',
    is_tombstone: false,
    ...over,
  };
}

function aiTurn(over: Partial<PersistedAiTurn> = {}): PersistedAiTurn {
  const overlay: ScreenOverlay = {
    overlay_id: over.overlay_id ?? 'ov0',
    trace_id: 't',
    page_id: 'pg_abcd1234_13',
    result_id: 'r',
    overlay_type: 'note',
    geometry: { anchor_bbox: [0.31, 0.31, 0.12, 0.02] },
    display_text: 'reply',
    dismissible: true,
    created_at: '2026-06-26T06:32:07.829Z',
    state: 'shown',
    result_type: 'inspiration',
  };
  return {
    entry_id: 'ent_a0',
    document_id: 'doc_test',
    page_id: 'pg_abcd1234_13',
    page_index: 13,
    seq: 100,
    created_at: '2026-06-26T06:32:07.829Z',
    overlay_id: 'ov0',
    overlay,
    overlay_state: 'shown',
    user_edited_text: null,
    ai_reply: 'AI says hi',
    anchor: { surface_id: 's', mark_ids: [], object_refs: [] },
    inference_view: {} as unknown as InferenceView,
    prompt_snapshot: '',
    system_prompt_hash: 'annotator@v1',
    settings_snapshot: { inferModel: 'kimi', reflowProvider: 'x' },
    trigger: 'idle',
    model: 'kimi',
    supersedes: null,
    ...over,
  };
}

function input(marks: PersistedMark[], aiTurns: PersistedAiTurn[]): BuilderInput {
  return { document_id: 'doc_test', document_title: '测试书', marks, aiTurns };
}

describe('KnowledgeBuilder', () => {
  it('ai_turn anchored to a markup mark → single ai_note (mark folded in, not double-emitted)', async () => {
    const m = mark({
      mark_id: 'm1',
      feature_type: 'markup',
      marked_text: '量子纠缠',
      hmp: hmp({ target_object_refs: ['run3_3', 'run3_4'] }),
    });
    const t = aiTurn({
      overlay_id: 'ov1',
      ai_reply: '已被实验反复验证。',
      anchor: { surface_id: 's', mark_ids: ['m1'], object_refs: ['run3_3', 'run3_4'] },
    });
    const kos = await assembleKnowledgeObjects(input([m], [t]));
    expect(kos).toHaveLength(1); // mark 被 ai_turn 消费 → 不再单独出 excerpt
    const ko = kos[0];
    expect(ko.schema_version).toBe(KO_SCHEMA_VERSION);
    expect(ko.kind).toBe('ai_note');
    expect(ko.title).toBe('测试书 · p14');
    expect(ko.body_md).toBe('已被实验反复验证。');
    expect(ko.source.quote).toBe('量子纠缠');
    expect(ko.source.object_refs).toEqual(['run3_3', 'run3_4']);
    expect(ko.source.page_id).toBe('pg_abcd1234_13');
    expect(ko.source.page_index).toBe(13);
    expect(ko.source.inkloop_uri).toBe('inkloop://doc/doc_test/page/13?anchor=run3_3');
    expect(ko.provenance).toEqual({ created_from: 'ai_turn', mark_ids: ['m1'], ai_turn_ids: ['ent_a0'] });
    expect(ko.tags).toEqual(['inkloop', 'inkloop/ai-note']);
    expect(ko.status).toBe('export_ready');
    expect(ko.privacy).toBe('export_allowed');
    expect(ko.render_hints?.markdown_callout).toBe('note');
    expect(ko.ko_id).toMatch(/^ko_[0-9A-HJKMNP-TV-Z]{26}$/); // 确定性 Crockford-Base32-26（满足协作方 InkSurface 契约）
    expect(ko.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ko.created_at).toBe(ko.updated_at); // 投影取源时刻，hash 稳定
  });

  it('standalone markup mark → excerpt', async () => {
    const m = mark({
      mark_id: 'm2',
      feature_type: 'markup',
      marked_text: '不确定性原理给出测量精度下限。',
      hmp: hmp({ target_object_refs: ['run5_0'] }),
    });
    const kos = await assembleKnowledgeObjects(input([m], []));
    expect(kos).toHaveLength(1);
    const ko = kos[0];
    expect(ko.kind).toBe('excerpt');
    expect(ko.body_md).toBe('不确定性原理给出测量精度下限。');
    expect(ko.source.quote).toBe('不确定性原理给出测量精度下限。');
    expect(ko.tags).toEqual(['inkloop', 'inkloop/excerpt']);
    expect(ko.render_hints?.markdown_callout).toBe('quote');
    expect(ko.provenance).toEqual({ created_from: 'mark', mark_ids: ['m2'] });
    expect(ko.status).toBe('export_ready');
  });

  it('standalone handwriting mark → annotation, body from text_hint', async () => {
    const m = mark({
      mark_id: 'm3',
      feature_type: 'handwriting',
      marked_text: '',
      hmp: hmp({ action: 'handwriting', text_hint: '记得复习这一段' }),
    });
    const kos = await assembleKnowledgeObjects(input([m], []));
    expect(kos).toHaveLength(1);
    const ko = kos[0];
    expect(ko.kind).toBe('annotation');
    expect(ko.body_md).toBe('记得复习这一段');
    expect(ko.source.quote).toBeUndefined(); // 飘写无所标原文
    expect(ko.tags).toEqual(['inkloop', 'inkloop/annotation']);
  });

  it('folded ai_turn excluded, but its handwriting mark still exports as annotation', async () => {
    const m = mark({ mark_id: 'm4', feature_type: 'handwriting', hmp: hmp({ text_hint: '写给自己的话' }) });
    const t = aiTurn({
      overlay_id: 'ov4',
      overlay_state: 'folded',
      anchor: { surface_id: 's', mark_ids: ['m4'], object_refs: [] },
    });
    const kos = await assembleKnowledgeObjects(input([m], [t]));
    expect(kos.map((k) => k.kind)).toEqual(['annotation']);
    expect(kos[0].body_md).toBe('写给自己的话');
  });

  it('dismissed ai_turn → emitted with status dismissed', async () => {
    const m = mark({ mark_id: 'm5', marked_text: 'x', hmp: hmp({ target_object_refs: ['r'] }) });
    const t = aiTurn({
      overlay_id: 'ov5',
      overlay_state: 'dismissed',
      ai_reply: 'reply',
      anchor: { surface_id: 's', mark_ids: ['m5'], object_refs: ['r'] },
    });
    const kos = await assembleKnowledgeObjects(input([m], [t]));
    expect(kos).toHaveLength(1);
    expect(kos[0].kind).toBe('ai_note');
    expect(kos[0].status).toBe('dismissed');
  });

  it('edited ai_turn → body from user_edited_text, status edited', async () => {
    const t = aiTurn({
      overlay_id: 'ov6',
      overlay_state: 'edited',
      ai_reply: 'original reply',
      user_edited_text: '我改写后的内容',
      anchor: { surface_id: 's', mark_ids: [], object_refs: ['r'] },
    });
    const kos = await assembleKnowledgeObjects(input([], [t]));
    expect(kos[0].body_md).toBe('我改写后的内容');
    expect(kos[0].status).toBe('edited');
  });

  it('trigger=discussion → qa kind with question callout', async () => {
    const t = aiTurn({
      overlay_id: 'ov8',
      trigger: 'discussion',
      ai_reply: 'answer',
      anchor: { surface_id: 's', mark_ids: [], object_refs: ['r'] },
    });
    const kos = await assembleKnowledgeObjects(input([], [t]));
    expect(kos[0].kind).toBe('qa');
    expect(kos[0].tags).toEqual(['inkloop', 'inkloop/qa']);
    expect(kos[0].render_hints?.markdown_callout).toBe('question');
  });

  it('empty-content markup(excerpt) produces no KO', async () => {
    const m = mark({ mark_id: 'm9', feature_type: 'markup', marked_text: '', hmp: null });
    const kos = await assembleKnowledgeObjects(input([m], []));
    expect(kos).toHaveLength(0);
  });

  it('纯图形/未识别手写仍产 annotation KO（占位正文·不丢手写·导出全量感知）', async () => {
    const draw = mark({ mark_id: 'md', feature_type: 'drawing', marked_text: '', hmp: null });
    const blank = mark({ mark_id: 'mh', feature_type: 'handwriting', marked_text: '', hmp: null });
    const kos = await assembleKnowledgeObjects(input([draw, blank], []));
    expect(kos).toHaveLength(2);
    expect(kos.every((k) => k.kind === 'annotation')).toBe(true);
    expect(kos.find((k) => k.provenance.mark_ids?.includes('md'))?.body_md).toBe('（图形标注 / 圈画）');
    expect(kos.find((k) => k.provenance.mark_ids?.includes('mh'))?.body_md).toBe('（未识别手写）');
  });

  it('ko_id stable across rebuilds; content_hash flips when body changes', async () => {
    const mk = (text: string) =>
      mark({ mark_id: 'm7', feature_type: 'markup', marked_text: text, hmp: hmp({ target_object_refs: ['r'] }) });
    const [a] = await assembleKnowledgeObjects(input([mk('stable')], []));
    const [b] = await assembleKnowledgeObjects(input([mk('stable')], []));
    expect(a.ko_id).toBe(b.ko_id);
    expect(a.content_hash).toBe(b.content_hash);
    const [c] = await assembleKnowledgeObjects(input([mk('changed')], []));
    expect(c.ko_id).toBe(a.ko_id); // 同源 mark → 同 ko_id
    expect(c.content_hash).not.toBe(a.content_hash); // 内容变 → content_hash 变
  });

  // ── 审查修复回归测（codex panel）──

  it('empty ai_reply turn does NOT consume its mark — mark still exports (no data loss)', async () => {
    const m = mark({
      mark_id: 'm10',
      feature_type: 'markup',
      marked_text: '重要原文',
      hmp: hmp({ target_object_refs: ['r10'] }),
    });
    const t = aiTurn({ overlay_id: 'ov10', ai_reply: '', anchor: { surface_id: 's', mark_ids: ['m10'], object_refs: ['r10'] } });
    const kos = await assembleKnowledgeObjects(input([m], [t]));
    expect(kos).toHaveLength(1); // 空 AI 轮不产 ai_note，但 mark 未被消费
    expect(kos[0].kind).toBe('excerpt'); // → 仍作 excerpt 导出，数据不丢
    expect(kos[0].body_md).toBe('重要原文');
  });

  it('ai_note source uses ai_turn own anchor (page/refs/bbox); quote from mark', async () => {
    const m = mark({
      mark_id: 'm11',
      page_id: 'pg_other_5',
      page_index: 5,
      marked_text: '被引原文',
      bbox: [0.1, 0.1, 0.1, 0.1],
      hmp: hmp({ target_object_refs: ['rMark'] }),
    });
    const t = aiTurn({
      overlay_id: 'ov11',
      page_id: 'pg_turn_2',
      page_index: 2,
      ai_reply: 'AI 洞见',
      anchor: { surface_id: 's', mark_ids: ['m11'], object_refs: ['rTurn'] },
    });
    t.overlay = { ...t.overlay, geometry: { anchor_bbox: [0.5, 0.5, 0.2, 0.2] } };
    const [ko] = await assembleKnowledgeObjects(input([m], [t]));
    expect(ko.kind).toBe('ai_note');
    expect(ko.source.page_index).toBe(2); // ai_turn 自己的页，不是 mark 的 5
    expect(ko.source.page_id).toBe('pg_turn_2');
    expect(ko.source.object_refs).toEqual(['rTurn']); // ai_turn 锚点，不是 mark 的 rMark
    expect(ko.source.anchor_bbox).toEqual([0.5, 0.5, 0.2, 0.2]); // overlay 锚框
    expect(ko.source.quote).toBe('被引原文'); // quote 仍取 mark 的所标原文
    expect(ko.title).toBe('测试书 · p3');
    expect(ko.source.inkloop_uri).toBe('inkloop://doc/doc_test/page/2?anchor=rTurn');
  });

  it('edited with empty user_edited_text → no KO (not reverted to ai_reply)', async () => {
    const t = aiTurn({
      overlay_id: 'ov12',
      overlay_state: 'edited',
      ai_reply: 'original',
      user_edited_text: '',
      anchor: { surface_id: 's', mark_ids: [], object_refs: ['r'] },
    });
    const kos = await assembleKnowledgeObjects(input([], [t]));
    expect(kos).toHaveLength(0);
  });

  it('ko_id namespaced by document_id — same mark_id across docs → different ko_id', async () => {
    const mk = mark({ mark_id: 'same', feature_type: 'markup', marked_text: 'x', hmp: hmp({ target_object_refs: ['r'] }) });
    const [a] = await assembleKnowledgeObjects({ document_id: 'docA', document_title: 'A', marks: [mk], aiTurns: [] });
    const [b] = await assembleKnowledgeObjects({ document_id: 'docB', document_title: 'B', marks: [mk], aiTurns: [] });
    expect(a.ko_id).not.toBe(b.ko_id);
  });
});

describe('enrichExportTags（导出边界·taxonomy 富化）', () => {
  const koOf = (documentId: string, documentTitle: string, createdAt: string): Promise<KnowledgeObject> =>
    finalize({
      stableKey: `mark:${documentId}:m1`, kind: 'annotation', documentId, documentTitle,
      objectRefs: ['r'], body: '一条手写', provenance: { created_from: 'mark', mark_ids: ['m1'] },
      status: 'export_ready', createdAt,
    });

  it('reading：book/<标题slug> + date·既有标签不丢·ko_id 不变', async () => {
    const ko = await koOf('doc_abc', '深入理解 计算机', '2026-06-29T10:00:00Z');
    const e = await enrichExportTags(ko);
    expect(e.ko_id).toBe(ko.ko_id); // ko_id 与 tags 无关·projection 链接仍有效
    expect(e.tags).toEqual(['inkloop', 'inkloop/annotation', 'inkloop/reading', 'inkloop/book/深入理解-计算机', 'inkloop/date/2026-06-29']);
  });

  it('diary：实体 slug 用日期', async () => {
    const e = await enrichExportTags(await koOf('diary_x', '6.29 日记', '2026-06-29T22:00:00Z'));
    expect(e.tags).toContain('inkloop/diary');
    expect(e.tags).toContain('inkloop/diary/2026-06-29');
  });

  it('content_hash 随富化重算·且自洽（去 hash 重算应一致·过对方 validator 同口径）', async () => {
    const ko = await koOf('doc_abc', '书', '2026-06-29T10:00:00Z');
    const e = await enrichExportTags(ko);
    expect(e.content_hash).not.toBe(ko.content_hash); // tags 变 → hash 变
    const e2 = await enrichExportTags(ko); // 幂等·确定性
    expect(e2.content_hash).toBe(e.content_hash);
  });

  it('幂等 overrides：会议可显式覆盖 date（started_at 而非落笔时刻）', async () => {
    const e = await enrichExportTags(await koOf('mtgdoc_m1', '周会', '2026-06-29T01:00:00Z'), { date: '2026-06-28' });
    expect(e.tags).toContain('inkloop/meeting');
    expect(e.tags).toContain('inkloop/date/2026-06-28');
    expect(e.tags).not.toContain('inkloop/date/2026-06-29');
  });
});

describe('isInkPlaceholderBody（笔迹占位判定·vault 过渡过滤用）', () => {
  it('恰为占位串 → true', () => {
    expect(isInkPlaceholderBody(INK_PLACEHOLDER_DRAWING)).toBe(true);
    expect(isInkPlaceholderBody(INK_PLACEHOLDER_HANDWRITING)).toBe(true);
  });
  it('真内容 → false', () => {
    expect(isInkPlaceholderBody('梅雨是什么时候')).toBe(false);
    expect(isInkPlaceholderBody('')).toBe(false);
  });
  it('会议占位带时间后缀 → false（不误伤会议手记）', () => {
    expect(isInkPlaceholderBody(`${INK_PLACEHOLDER_DRAWING}　（约 3:21 处手写）`)).toBe(false);
  });
  it('builder 给纯图形 mark 产的占位 KO 能被判定命中（防字段名漂移：body_md）', async () => {
    const m: PersistedMark = {
      mark_id: 'm-draw', document_id: 'd', page_id: 'p0', page_index: 0,
      feature_type: 'drawing', marked_text: '', created_at: '2026-06-29T00:00:00Z',
    } as unknown as PersistedMark;
    const kos = await assembleKnowledgeObjects({ document_id: 'd', document_title: 'D', marks: [m], aiTurns: [] } as BuilderInput);
    const placeholder = kos.find((k) => k.kind === 'annotation');
    expect(placeholder?.body_md).toBe(INK_PLACEHOLDER_DRAWING);
    expect(isInkPlaceholderBody(placeholder!.body_md)).toBe(true);
  });
});

describe('normalizeEntityId', () => {
  it('NFKC + 折大小写 + 转 slug', () => {
    expect(normalizeEntityId('Cache Coherence')).toBe('cache-coherence');
    expect(normalizeEntityId('  缓存 一致性  ')).toBe('缓存-一致性');
    expect(normalizeEntityId('Ｃache　Coherence')).toBe('cache-coherence'); // 全角折半角同键
  });
  it('全非法字符兜底 untitled，不产空串', () => {
    expect(normalizeEntityId('   ')).toBe('untitled');
    expect(normalizeEntityId('***')).toBe('untitled');
  });
});

const ref = (entity_id: string, over: Partial<LedgerEntityRef> = {}): LedgerEntityRef => ({ entity_id, source: 'declared', ...over });

describe('assembleKnowledgeProjection（存储原生拓扑：账本 entity_refs → 确定性 facts，零 LLM）', () => {
  it('独立 mark 带 entity_refs → 产对应 fact；assembleKnowledgeObjects 薄壳与新核心 KO 输出一致', async () => {
    const m = mark({ mark_id: 'm1', feature_type: 'markup', marked_text: '缓存一致性', entity_refs: [ref('cache-coherence', { display: '缓存一致性' })] });
    const proj = await assembleKnowledgeProjection(input([m], []));
    const plain = await assembleKnowledgeObjects(input([m], []));

    expect(proj.objects.map((k) => k.ko_id)).toEqual(plain.map((k) => k.ko_id)); // 薄壳行为不变
    expect(proj.entityFacts).toHaveLength(1);
    expect(proj.entityFacts[0]).toMatchObject({ entity_id: 'cache-coherence', display: '缓存一致性', ko_id: proj.objects[0].ko_id, source_document_id: 'doc_test', source: 'declared' });
  });

  it('ai_turn 产出的 KO 同时继承 ai_turn 自身 + 被消费锚 mark 的 refs（手写或 AI 回复任一处归类都算数）', async () => {
    const m = mark({ mark_id: 'm1', feature_type: 'markup', marked_text: '量子纠缠', entity_refs: [ref('physics')] });
    const t = aiTurn({ overlay_id: 'ov1', ai_reply: '已被实验验证。', anchor: { surface_id: 's', mark_ids: ['m1'], object_refs: [] }, topic_refs: [ref('experiment-evidence')] });
    const proj = await assembleKnowledgeProjection(input([m], [t]));

    expect(proj.objects).toHaveLength(1); // mark 仍被消费，不重复出
    const koId = proj.objects[0].ko_id;
    expect(proj.entityFacts.map((f) => f.entity_id).sort()).toEqual(['experiment-evidence', 'physics']);
    expect(proj.entityFacts.every((f) => f.ko_id === koId)).toBe(true);
  });

  it('topic_refs 与 entity_refs 都产 fact（同口径，无差别对待）', async () => {
    const m = mark({ mark_id: 'm1', feature_type: 'markup', marked_text: 'x', entity_refs: [ref('a')], topic_refs: [ref('b')] });
    const proj = await assembleKnowledgeProjection(input([m], []));
    expect(proj.entityFacts.map((f) => f.entity_id).sort()).toEqual(['a', 'b']);
  });

  it('无 refs → entityFacts 为空数组（不是 undefined，调用方不用判空）', async () => {
    const m = mark({ mark_id: 'm1', feature_type: 'markup', marked_text: 'x' });
    const proj = await assembleKnowledgeProjection(input([m], []));
    expect(proj.entityFacts).toEqual([]);
  });

  it('source_created_at 存在时用它做 fact 的 created_at（回填场景防 KO.created_at 漂移的配套：fact 时间线也不该被回填时刻污染）', async () => {
    const m = mark({ mark_id: 'm1', feature_type: 'markup', marked_text: 'x', created_at: '2026-06-30T00:00:00.000Z', source_created_at: '2026-06-01T00:00:00.000Z', entity_refs: [ref('a')] });
    const proj = await assembleKnowledgeProjection(input([m], []));
    expect(proj.entityFacts[0].created_at).toBe('2026-06-01T00:00:00.000Z');
  });
});

function entity(id: string, over: Partial<PersistedEntity> = {}): PersistedEntity {
  return { entity_id: id, normalized_key: id, display: id, kind: 'entity', provenance: { document_ids: [], entries: [] }, created_at: '2026-06-01T00:00:00.000Z', updated_at: '2026-06-01T00:00:00.000Z', ...over };
}
function fact(entity_id: string, ko_id: string, over: { created_at?: string; display?: string; source?: LedgerEntityRef['source'] } = {}) {
  return { entity_id, ko_id, source_document_id: 'doc_test', source_entry_id: 'ent_x', source: over.source ?? ('declared' as const), created_at: over.created_at ?? '2026-06-01T00:00:00.000Z', display: over.display };
}

describe('projectEntities（facts + registry → 确定性 KnowledgeEntity[]/EntityMembership[]，零 LLM）', () => {
  it('registry 有记录时用 registry 的 display/kind；无记录时用 fact 里最早出现的 display 兜底（refs 是真相源，registry 缺不该丢关系）', () => {
    const facts = [fact('known', 'ko1'), fact('ghost', 'ko2', { display: '幽灵实体' })];
    const { entities } = projectEntities(facts, [entity('known', { display: '已注册', kind: 'topic' })]);
    const known = entities.find((e) => e.entity_id === 'known');
    const ghost = entities.find((e) => e.entity_id === 'ghost');
    expect(known).toMatchObject({ display: '已注册', kind: 'topic' });
    expect(ghost).toMatchObject({ display: '幽灵实体', kind: 'entity' }); // registry 缺记录 → fallback 兜底，不丢
  });

  it('同 (entity_id, ko_id) 去重成员边；不同 ko_id 各成一条', () => {
    const facts = [fact('a', 'ko1'), fact('a', 'ko1'), fact('a', 'ko2')];
    const { memberships } = projectEntities(facts, []);
    expect(memberships).toHaveLength(2);
  });

  it('合并链：status=merged+merged_into 把旧 entity 的 fact 重映射到活实体；旧实体不再出现在结果里', () => {
    const facts = [fact('old-name', 'ko1', { display: '旧名' })];
    const registry = [entity('old-name', { status: 'merged', merged_into: 'new-name' }), entity('new-name', { display: '新名' })];
    const { entities, memberships } = projectEntities(facts, registry);
    expect(entities.map((e) => e.entity_id)).toEqual(['new-name']); // old-name 不再是活 hub
    expect(memberships).toEqual([{ schema_version: 'inkloop.entity_membership.v1', entity_id: 'new-name', ko_id: 'ko1', source: 'declared' }]);
  });

  it('合并链多级：a→b→c 一路解析到底', () => {
    const facts = [fact('a', 'ko1')];
    const registry = [entity('a', { status: 'merged', merged_into: 'b' }), entity('b', { status: 'merged', merged_into: 'c' }), entity('c', { display: '终点' })];
    const { entities } = projectEntities(facts, registry);
    expect(entities.map((e) => e.entity_id)).toEqual(['c']);
  });

  it('合并链成环：不死循环，就地停在当前 id（防御性——正常数据不会出现环）', () => {
    const facts = [fact('a', 'ko1')];
    const registry = [entity('a', { status: 'merged', merged_into: 'b' }), entity('b', { status: 'merged', merged_into: 'a' })];
    const { entities } = projectEntities(facts, registry); // 不超时/不抛错即通过
    expect(entities).toHaveLength(1);
  });

  it('确定性：facts 输入顺序打乱，输出 entities/memberships 顺序不变', () => {
    const facts1 = [fact('b', 'ko2'), fact('a', 'ko1')];
    const facts2 = [fact('a', 'ko1'), fact('b', 'ko2')];
    const registry = [entity('a'), entity('b')];
    expect(projectEntities(facts1, registry)).toEqual(projectEntities(facts2, registry));
  });
});
