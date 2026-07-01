/**
 * 存储原生拓扑端到端验证：证明整条链路的核心承诺——
 * 「本地路（concepts:false + storedEntities:true）也能产出完整跨文档 [[]] 链接图，全程零 LLM」。
 *
 * 纯函数链（不碰 IndexedDB/不 mock store）：
 *   两本"书"各一条 mark（都声明关联同一 canonical entity）
 *     → assembleKnowledgeProjection（builder：账本 → KO + entityFacts，零 LLM）
 *     → projectEntities（builder：facts + registry → KnowledgeEntity[] + EntityMembership[]，零 LLM）
 *     → buildConceptLayerFromStoredMemberships（SDK export-core：零 LLM，无 extractor 参数可传）
 *     → renderVaultMarkdown（SDK adapter-obsidian：确定性渲染）
 * 断言：两本书里对应的笔记互相 [[wikilink]]，且没有一次 LLM/网络调用发生过（这条链路里根本不存在调用点）。
 */
import { describe, expect, it } from 'vitest';
import type { PersistedAiTurn, PersistedEntity, PersistedMark, PersistedMeeting } from '../../core/store-format';
import { assembleKnowledgeProjection, type BuilderInput, projectEntities } from '../../knowledge/builder';
import { buildConceptLayerFromStoredMemberships } from 'ink-surface-sdk/export-core';
import { renderVaultMarkdown, type ObsidianVaultEntityInput } from 'ink-surface-sdk/adapters/obsidian';
import type { DocumentProjectionExportEnvelope, KnowledgeObjectExportEnvelope as KnowledgeExportEnvelope } from 'ink-surface-sdk/knowledge-schema';
import { assembleVaultBundle, type EntityExport } from './vault-export';
import { toObsidianVaultRenderInput } from './vault-render-input';
import { assembleMeetingL1Export, type MeetingExportInput } from './meeting-export';

function mark(over: Partial<PersistedMark>): PersistedMark {
  return {
    entry_id: `ent_${over.mark_id}`, document_id: 'd', page_id: 'p0', page_index: 0, seq: 1,
    created_at: '2026-06-30T00:00:00.000Z', mark_id: 'm', strokes: [], bbox: [0, 0, 0.1, 0.1],
    tool: 'pen', color: '#000', pointer_type: 'pen', device_id: 'dev', abs_timestamp: 0,
    feature_type: 'markup', feature_confidence: 0.9, scored_type: 'underline', scored_score: 0.9,
    hmp: null, marked_text: '', is_tombstone: false,
    ...over,
  };
}
const noAiTurns: PersistedAiTurn[] = [];

describe('存储原生拓扑端到端：两本书共享一个实体 → 零 LLM 渲出互链的 vault', () => {
  it('本地路（无 extractor）产出跨文档 [[]] 链接图，且笔记确实互相可达', async () => {
    // 书 A：一条笔记标了「注意力机制」
    const bookA = mark({ mark_id: 'ma1', document_id: 'doc_a', marked_text: 'Transformer 里的自注意力', entity_refs: [{ entity_id: 'attention', display: '注意力机制', source: 'declared' }] });
    // 书 B（不同文档）：另一条笔记也标了同一个「注意力机制」——这是共指边真正要证明的东西：跨文档、不同 mark、同一实体。
    const bookB = mark({ mark_id: 'mb1', document_id: 'doc_b', marked_text: '论文里 attention 的定义', entity_refs: [{ entity_id: 'attention', display: '注意力机制', source: 'declared' }] });

    const inputA: BuilderInput = { document_id: 'doc_a', document_title: '深度学习教材', marks: [bookA], aiTurns: noAiTurns };
    const inputB: BuilderInput = { document_id: 'doc_b', document_title: 'Attention Is All You Need', marks: [bookB], aiTurns: noAiTurns };

    // 1) builder：账本 → KO + facts（零 LLM，纯确定性）
    const projA = await assembleKnowledgeProjection(inputA);
    const projB = await assembleKnowledgeProjection(inputB);
    const allKos = [...projA.objects, ...projB.objects];
    const allFacts = [...projA.entityFacts, ...projB.entityFacts];
    expect(allFacts).toHaveLength(2); // 两本书各一条 fact，指向同一 entity_id

    // 2) builder：facts + registry → 确定性实体图（registry 甚至可以是空的——fallback 用 fact 里的 display）
    const registry: PersistedEntity[] = [];
    const { entities, memberships } = projectEntities(allFacts, registry);
    expect(entities.map((e) => e.entity_id)).toEqual(['attention']);
    expect(memberships).toHaveLength(2); // 两个 KO 都挂在同一个 entity 上

    // 3) SDK export-core：纯函数产 ConceptLayer（**不传 extractor**——这条路径根本不存在 LLM 调用点）
    const conceptLayer = buildConceptLayerFromStoredMemberships(allKos, entities, memberships);
    expect(conceptLayer.hubs).toEqual([{ entity_id: 'attention', title: '注意力机制' }]);

    // 4) SDK adapter-obsidian：确定性渲染成 markdown vault
    const entitiesInput: ObsidianVaultEntityInput[] = [
      { documentId: 'doc_a', documentTitle: '深度学习教材', mode: 'reading', dates: ['2026-06-30'], knowledgeObjects: projA.objects, documentProjections: [] },
      { documentId: 'doc_b', documentTitle: 'Attention Is All You Need', mode: 'reading', dates: ['2026-06-30'], knowledgeObjects: projB.objects, documentProjections: [] },
    ];
    const files = renderVaultMarkdown({ entities: entitiesInput, conceptLayer });

    // 概念枢纽存在，且两本书的笔记都反链进去
    const hub = files.find((f) => f.path === 'InkLoop/Concepts/注意力机制.md');
    expect(hub).toBeTruthy();
    expect(hub!.markdown).toContain('## 相关笔记');

    // 核心断言：书 A 的笔记页里能看到指向书 B 笔记的「同实体笔记」链接（跨文档共指边，零 LLM 产出）。
    // 用 callout 标记（`> [!`）精确定位叶子笔记本身——枢纽页也会包含笔记标题的 wikilink，光靠标题匹配会误中枢纽。
    const noteA = files.find((f) => f.markdown.includes('> [!') && f.markdown.includes('自注意力'));
    const noteB = files.find((f) => f.markdown.includes('> [!') && f.markdown.includes('attention 的定义'));
    expect(noteA).toBeTruthy();
    expect(noteB).toBeTruthy();
    expect(noteA!.markdown).toContain('**同实体笔记**');
    expect(noteB!.markdown).toContain('**同实体笔记**');

    // 零 dangling：每个 [[link]] 都真实解析到某个文件（图谱连通，没有断链）
    const bases = new Set(files.map((f) => f.path.split('/').pop()!.replace(/\.md$/, '')));
    const links = files.flatMap((f) => [...f.markdown.matchAll(/(?<!\\)\[\[([^\]]+)\]\]/g)].map((m) => m[1]));
    const dangling = [...new Set(links)].filter((l) => !bases.has(l));
    expect(dangling).toEqual([]);
  });

  it('一本书没有任何 entity_refs 时：不产实体拓扑，KO 导出照常（存储原生拓扑是纯新增，不是硬依赖）', async () => {
    const plain = mark({ mark_id: 'm1', document_id: 'doc_c', marked_text: '普通笔记，没归类' });
    const proj = await assembleKnowledgeProjection({ document_id: 'doc_c', document_title: 'C', marks: [plain], aiTurns: noAiTurns });
    expect(proj.objects).toHaveLength(1);
    expect(proj.entityFacts).toEqual([]);
    const { entities, memberships } = projectEntities(proj.entityFacts, []);
    expect(entities).toEqual([]);
    expect(memberships).toEqual([]);
  });
});

const emptyProjections: DocumentProjectionExportEnvelope = { document_projections: [] } as unknown as DocumentProjectionExportEnvelope;

describe('内容拓扑①端到端：会议 material_doc_ids → 渲出 hub-to-hub 引用资料链', () => {
  it('会议引用一本已导出的书 → meeting hub 出「## 引用资料」直连书 hub，零 dangling', async () => {
    const noted = mark({ mark_id: 'ma1', document_id: 'doc_a', marked_text: '关键定义在这' });
    const projA = await assembleKnowledgeProjection({ document_id: 'doc_a', document_title: '参考资料 A', marks: [noted], aiTurns: noAiTurns });

    const bookExport: EntityExport = {
      mode: 'reading',
      documentId: 'doc_a',
      documentTitle: '参考资料 A',
      knowledgeExport: { objects: projA.objects } as unknown as KnowledgeExportEnvelope,
      documentProjections: emptyProjections,
    };
    const meetingExport: EntityExport = {
      mode: 'meeting',
      documentId: 'mtgdoc_x',
      documentTitle: '周会',
      knowledgeExport: { objects: [] } as unknown as KnowledgeExportEnvelope,
      documentProjections: emptyProjections,
      activityDate: '2026-06-30T03:00:00Z',
      materialDocIds: ['doc_a'],
    };

    const bundle = await assembleVaultBundle([bookExport, meetingExport], { generatedAt: '2026-06-30T00:00:00Z' });
    const renderInput = toObsidianVaultRenderInput(bundle);
    const files = renderVaultMarkdown(renderInput);

    const meetingHub = files.find((f) => f.path === 'InkLoop/Meetings/2026-06-30 周会/周会.md');
    expect(meetingHub).toBeTruthy();
    expect(meetingHub!.markdown).toContain('## 引用资料');
    expect(meetingHub!.markdown).toContain('[[参考资料 A]]');

    const bases = new Set(files.map((f) => f.path.split('/').pop()!.replace(/\.md$/, '')));
    const links = files.flatMap((f) => [...f.markdown.matchAll(/(?<!\\)\[\[([^\]]+)\]\]/g)].map((m) => m[1]));
    expect([...new Set(links)].filter((l) => !bases.has(l))).toEqual([]);
  });

  it('引用的资料文档没入 bundle（未导出/已删）→ 不产悬空链接，其余渲染照常', async () => {
    const meetingExport: EntityExport = {
      mode: 'meeting',
      documentId: 'mtgdoc_y',
      documentTitle: '周会 2',
      knowledgeExport: { objects: [] } as unknown as KnowledgeExportEnvelope,
      documentProjections: emptyProjections,
      activityDate: '2026-06-30T03:00:00Z',
      materialDocIds: ['doc_missing'],
    };

    const bundle = await assembleVaultBundle([meetingExport], { generatedAt: '2026-06-30T00:00:00Z' });
    const files = renderVaultMarkdown(toObsidianVaultRenderInput(bundle));

    const meetingHub = files.find((f) => f.path === 'InkLoop/Meetings/2026-06-30 周会 2/周会 2.md');
    expect(meetingHub).toBeTruthy();
    expect(meetingHub!.markdown).not.toContain('## 引用资料');
  });
});

describe('内容拓扑②端到端：KO-KO 关系层 → leaf 互链「同源笔记」/「同场采集笔记」，零 Concepts/ hub 污染', () => {
  it('same_ai_turn：dismissed ai_turn + 两个带 refs 的锚 mark → 3 个 KO 互标「同源笔记」', async () => {
    const m1 = mark({ mark_id: 'm1', document_id: 'doc_b', marked_text: '缓存一致性', entity_refs: [{ entity_id: 'x', source: 'declared' }] });
    const m2 = mark({ mark_id: 'm2', document_id: 'doc_b', marked_text: 'MESI 协议', entity_refs: [{ entity_id: 'y', source: 'declared' }] });
    const t: PersistedAiTurn = {
      entry_id: 'ent_t1', document_id: 'doc_b', page_id: 'p0', page_index: 0, seq: 2,
      created_at: '2026-06-30T00:00:00.000Z', overlay_id: 'ov1',
      overlay: { overlay_id: 'ov1', trace_id: 't', page_id: 'p0', result_id: 'r', overlay_type: 'note', geometry: { anchor_bbox: [0.1, 0.1, 0.2, 0.02] }, display_text: 'reply', dismissible: true, created_at: '2026-06-30T00:00:00.000Z', state: 'shown', result_type: 'inspiration' },
      overlay_state: 'dismissed', user_edited_text: null, ai_reply: '回复',
      anchor: { surface_id: 's', mark_ids: ['m1', 'm2'], object_refs: [] },
      inference_view: {} as unknown as PersistedAiTurn['inference_view'],
      prompt_snapshot: '', system_prompt_hash: 'annotator@v1', settings_snapshot: { inferModel: 'kimi', reflowProvider: 'x' },
      trigger: 'idle', model: 'kimi', supersedes: null,
    };

    const proj = await assembleKnowledgeProjection({ document_id: 'doc_b', document_title: '书 B', marks: [m1, m2], aiTurns: [t] });
    const conceptLayer = buildConceptLayerFromStoredMemberships(proj.objects, [], [], proj.koRelationFacts);

    const entities: ObsidianVaultEntityInput[] = [
      { documentId: 'doc_b', documentTitle: '书 B', mode: 'reading', dates: ['2026-06-30'], knowledgeObjects: proj.objects, documentProjections: [] },
    ];
    const files = renderVaultMarkdown({ entities, conceptLayer });

    const excerpt1 = files.find((f) => f.markdown.includes('> [!') && f.markdown.includes('缓存一致性'));
    const excerpt2 = files.find((f) => f.markdown.includes('> [!') && f.markdown.includes('MESI 协议'));
    expect(excerpt1).toBeTruthy();
    expect(excerpt2).toBeTruthy();
    expect(excerpt1!.markdown).toContain('**同源笔记**');
    expect(excerpt2!.markdown).toContain('**同源笔记**');
    expect(files.some((f) => f.path.startsWith('InkLoop/Concepts/'))).toBe(false); // 关系层不产 hub

    const bases = new Set(files.map((f) => f.path.split('/').pop()!.replace(/\.md$/, '')));
    const links = files.flatMap((f) => [...f.markdown.matchAll(/(?<!\\)\[\[([^\]]+)\]\]/g)].map((m) => m[1]));
    expect([...new Set(links)].filter((l) => !bases.has(l))).toEqual([]);
  });

  it('same_context：一场会议的多条手写 KO 端到端渲出「同场采集笔记」互链', async () => {
    const meeting: PersistedMeeting = {
      meeting_id: 'mtg_e2e1', workspace_id: 'ws_1', title: '端到端会议',
      scheduled_at: '2026-06-30T03:00:00.000Z', status: 'ended',
      started_at: '2026-06-30T03:00:00.000Z', ended_at: '2026-06-30T03:30:00.000Z',
      material_doc_ids: [], align_state: 'approx',
      created_at: '2026-06-30T03:00:00.000Z', updated_at: '2026-06-30T03:00:00.000Z',
    };
    const meetingInput: MeetingExportInput = {
      meeting,
      cues: [],
      marks: [
        { mark_id: 'a', abs_timestamp: 0, feature_type: 'handwriting', marked_text: '甲笔记', page_index: 0 },
        { mark_id: 'b', abs_timestamp: 1000, feature_type: 'handwriting', marked_text: '乙笔记', page_index: 0 },
      ],
    };
    const meetingOut = await assembleMeetingL1Export(meetingInput, { generatedAt: '2026-06-30T00:00:00.000Z' });

    const meetingExport: EntityExport = {
      mode: 'meeting',
      documentId: meetingOut.documentId,
      documentTitle: meetingOut.documentTitle,
      knowledgeExport: meetingOut.knowledgeExport,
      documentProjections: meetingOut.documentProjections,
      activityDate: meeting.started_at,
      koRelationFacts: meetingOut.koRelationFacts,
    };

    const conceptLayer = buildConceptLayerFromStoredMemberships(meetingOut.knowledgeExport.objects, [], [], meetingExport.koRelationFacts);
    const bundle = await assembleVaultBundle([meetingExport], { generatedAt: '2026-06-30T00:00:00Z', conceptLayer });
    const files = renderVaultMarkdown(toObsidianVaultRenderInput(bundle));

    const leaf1 = files.find((f) => f.markdown.includes('> [!') && f.markdown.includes('甲笔记'));
    const leaf2 = files.find((f) => f.markdown.includes('> [!') && f.markdown.includes('乙笔记'));
    expect(leaf1).toBeTruthy();
    expect(leaf2).toBeTruthy();
    expect(leaf1!.markdown).toContain('**同场采集笔记**');
    expect(leaf2!.markdown).toContain('**同场采集笔记**');
    expect(files.some((f) => f.path.startsWith('InkLoop/Concepts/'))).toBe(false);

    const bases = new Set(files.map((f) => f.path.split('/').pop()!.replace(/\.md$/, '')));
    const links = files.flatMap((f) => [...f.markdown.matchAll(/(?<!\\)\[\[([^\]]+)\]\]/g)].map((m) => m[1]));
    expect([...new Set(links)].filter((l) => !bases.has(l))).toEqual([]);
  });
});
