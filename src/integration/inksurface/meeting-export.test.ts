import { describe, expect, it } from 'vitest';
import { assembleMeetingL1Export, meetingDocId, type MeetingExportInput } from './meeting-export';
import { parseSrtTranscript } from '../panel-feishu/align';
import type { PersistedMeeting } from '../../core/store-format';

const KO_ID = /^ko_[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA = /^sha256:[a-f0-9]{64}$/;
const T0 = 1_700_000_000_000;

const SRT = `1
00:00:03,000 --> 00:00:11,000
张宇：今天过一遍 v4 数据架构，分两层。

2
00:00:12,000 --> 00:00:21,000
徐智强：端侧采样率会不会有压力？

3
00:00:46,000 --> 00:00:58,000
张宇：L1 对接已过 validator。

4
00:01:00,000 --> 00:01:10,000
徐智强：采样率下限写进契约。
`;

function meeting(overrides: Partial<PersistedMeeting> = {}): PersistedMeeting {
  return {
    meeting_id: 'mtg_demo1', workspace_id: 'ws_1', title: '架构评审 v4',
    scheduled_at: new Date(T0).toISOString(), status: 'ended',
    started_at: new Date(T0).toISOString(), ended_at: new Date(T0 + 175000).toISOString(),
    material_doc_ids: [],
    feishu_minute_token: 'tok_demo', panel_meeting_start: T0, feishu_recording_t0: T0, align_offset_ms: 0, align_state: 'approx',
    summary: '会议要点：确认两层架构、采样率下限入契约。',
    created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString(),
    ...overrides,
  };
}

const mk = (id: string, relS: number, text = '笔', feat = 'handwriting') =>
  ({ mark_id: id, abs_timestamp: T0 + relS * 1000, feature_type: feat, marked_text: text, page_index: 0 });

const input = (overrides: Partial<MeetingExportInput> = {}): MeetingExportInput => ({
  meeting: meeting(),
  cues: parseSrtTranscript(SRT),
  marks: [mk('a', 15, '两层真相边界'), mk('b', 50, '采样率≥60Hz'), mk('c', 130, '', 'drawing')],
  ...overrides,
});

const OPTS = { generatedAt: '2026-06-29T00:00:00.000Z' };

describe('assembleMeetingL1Export（会议→L1）', () => {
  it('手写零丢失：每笔 → 一条 annotation KO', async () => {
    const out = await assembleMeetingL1Export(input(), OPTS);
    const anns = out.knowledgeExport.objects.filter((k) => k.kind === 'annotation');
    expect(anns).toHaveLength(3); // a/b/c
    expect(out.diagnostics.annotationKoCount).toBe(3);
    expect(out.diagnostics.markCount).toBe(3);
  });

  it('会议总结 → 一条 summary KO', async () => {
    const out = await assembleMeetingL1Export(input(), OPTS);
    const sum = out.knowledgeExport.objects.filter((k) => k.kind === 'summary');
    expect(sum).toHaveLength(1);
    expect(sum[0].body_md).toContain('两层架构');
  });

  it('无总结时不产 summary KO', async () => {
    const out = await assembleMeetingL1Export(input({ meeting: meeting({ summary: undefined }) }), OPTS);
    expect(out.knowledgeExport.objects.some((k) => k.kind === 'summary')).toBe(false);
  });

  it('每句转写 → para 块·每段 → heading 块·零丢句', async () => {
    const out = await assembleMeetingL1Export(input(), OPTS);
    const blocks = out.documentProjections.document_projections[0].blocks;
    const paras = blocks.filter((b) => b.kind === 'paragraph');
    const heads = blocks.filter((b) => b.kind === 'heading');
    expect(paras).toHaveLength(4);            // 4 cue → 4 para
    expect(heads.length).toBeGreaterThanOrEqual(1); // ≥1 段
    expect(out.diagnostics.cueCount).toBe(4);
  });

  it('手写 KO 锚到所在段的 heading 块（knowledge_object_ids 连上）', async () => {
    const out = await assembleMeetingL1Export(input(), OPTS);
    const anns = out.knowledgeExport.objects.filter((k) => k.kind === 'annotation');
    const allAnchored = new Set(out.documentProjections.document_projections[0].blocks.flatMap((b) => b.knowledge_object_ids));
    for (const a of anns) expect(allAnchored.has(a.ko_id)).toBe(true);
  });

  it('ko_id Crockford-26 + content_hash sha256 合规（过对方正则）', async () => {
    const out = await assembleMeetingL1Export(input(), OPTS);
    for (const ko of out.knowledgeExport.objects) {
      expect(ko.ko_id).toMatch(KO_ID);
      expect(ko.content_hash).toMatch(SHA);
      expect(ko.privacy).toBe('export_allowed');
      expect(ko.source.document_id).toBe(meetingDocId('mtg_demo1'));
    }
    const proj = out.documentProjections.document_projections[0];
    expect(proj.body_hash).toMatch(SHA);
    expect(proj.content_hash).toMatch(SHA);
    for (const b of proj.blocks) {
      const bb = b.source?.anchor_bbox;
      expect(bb).toBeTruthy();
      if (bb) { const [x, y, w, h] = bb; expect(x + w).toBeLessThanOrEqual(1.000001); expect(y + h).toBeLessThanOrEqual(1.000001); }
    }
  });

  it('taxonomy 标签富化：每个会议 KO 带 mode/会议/日期维度（待办1 全量感知）', async () => {
    const out = await assembleMeetingL1Export(input(), OPTS);
    const koDate = new Date(T0).toISOString().slice(0, 10); // 会议日期=started_at（KO createdAt 同源）
    expect(out.knowledgeExport.objects.length).toBeGreaterThan(0);
    for (const ko of out.knowledgeExport.objects) {
      expect(ko.tags).toContain('inkloop'); // 既有基线不丢
      expect(ko.tags).toContain('inkloop/meeting'); // mode
      expect(ko.tags).toContain('inkloop/meeting/架构评审-v4'); // 实体 slug·空格→连字符
      expect(ko.tags).toContain(`inkloop/date/${koDate}`); // 跨模式时间连接
    }
  });

  it('确定性：同输入 + 同 generatedAt → 同 ko_id/hash', async () => {
    const a = await assembleMeetingL1Export(input(), OPTS);
    const b = await assembleMeetingL1Export(input(), OPTS);
    expect(a.knowledgeExport.objects.map((k) => k.ko_id)).toEqual(b.knowledgeExport.objects.map((k) => k.ko_id));
    expect(a.knowledgeExport.objects.map((k) => k.content_hash)).toEqual(b.knowledgeExport.objects.map((k) => k.content_hash));
    expect(a.documentProjections.document_projections[0].content_hash).toBe(b.documentProjections.document_projections[0].content_hash);
  });

  it('转写缺失但有手写：仍产手写 KO + 标 transcriptMissing（不静默丢手写）', async () => {
    const out = await assembleMeetingL1Export(input({ cues: [] }), OPTS);
    expect(out.diagnostics.transcriptMissing).toBe(true);
    expect(out.knowledgeExport.objects.filter((k) => k.kind === 'annotation')).toHaveLength(3);
  });
});

describe('assembleMeetingL1Export（存储原生拓扑：KO-KO 关系层 same_context，零 LLM）', () => {
  it('本场会议 ≥2 条手写 KO → 一条 same_context 关系组，串起全部手写 KO', async () => {
    const out = await assembleMeetingL1Export(input(), OPTS);
    const annIds = out.knowledgeExport.objects.filter((k) => k.kind === 'annotation').map((k) => k.ko_id);
    expect(out.koRelationFacts).toHaveLength(1);
    const group = out.koRelationFacts[0];
    // meeting_id 本身已带 'mtg_' 前缀（shortId('mtg')·同 getFoldedMarksByContext 既有的 `mtg_${meetingId}` 双前缀约定一致）。
    expect(group).toMatchObject({ kind: 'same_context', source: 'meeting_context', confidence: 'experimental', relation_id: 'rel:same_context:mtg_mtg_demo1' });
    expect(new Set(group.ko_ids)).toEqual(new Set(annIds));
    expect(group.evidence).toEqual({ context_id: 'mtg_mtg_demo1' });
  });

  it('只有 1 条手写 KO 时不产关系组', async () => {
    const out = await assembleMeetingL1Export(input({ marks: [mk('a', 15, '唯一一笔')] }), OPTS);
    expect(out.koRelationFacts).toEqual([]);
  });

  it('没有手写（只有转写）时不产关系组', async () => {
    const out = await assembleMeetingL1Export(input({ marks: [] }), OPTS);
    expect(out.koRelationFacts).toEqual([]);
  });

  it('确定性：ko_ids 不随 marks 输入顺序漂移', async () => {
    const a = await assembleMeetingL1Export(input(), OPTS);
    const b = await assembleMeetingL1Export(input({ marks: [mk('c', 130, '', 'drawing'), mk('a', 15, '两层真相边界'), mk('b', 50, '采样率≥60Hz')] }), OPTS);
    expect(a.koRelationFacts[0].ko_ids.slice().sort()).toEqual(b.koRelationFacts[0].ko_ids.slice().sort());
  });
});
