import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MARK_ENTRY_SCHEMA_VERSION, type PersistedDoc, type PersistedMark } from '../../core/store-format';
import { KO_SCHEMA_VERSION, type KnowledgeObject } from '../../knowledge/knowledge-object';

const store = vi.hoisted(() => ({
  getDoc: vi.fn(),
  getFoldedMarks: vi.fn(),
}));

vi.mock('../../local/store', () => ({
  getDoc: store.getDoc,
  getFoldedMarks: store.getFoldedMarks,
}));

import { buildDocumentProjectionExport } from './document-projection';

function diaryDoc(pageCount: number): PersistedDoc {
  return {
    document_id: 'diary_test',
    file_hash: 'na',
    filename: '7.1 日记',
    page_count: pageCount,
    saved_at: '2026-07-01T00:00:00.000Z',
    version: '1',
    pages: {}, // 日记天生没有印刷文字·从不产生 page.reflow
  };
}

function drawingMark(pageIndex: number, id: string): PersistedMark {
  return {
    schema_version: MARK_ENTRY_SCHEMA_VERSION,
    entry_id: `ent_${id}`,
    document_id: 'diary_test',
    page_id: `pg_diary_${pageIndex}`,
    page_index: pageIndex,
    seq: 1,
    created_at: '2026-07-01T00:00:00.000Z',
    mark_id: id,
    strokes: [{ tool: 'pen', points: [{ x: 0.2, y: 0.3, t: 0, pressure: 0.5 }], coord_space: 'page_norm', capture_surface: 'page' }],
    bbox: [0.2, 0.3, 0.01, 0.01],
    tool: 'pen',
    color: '#1A1A1A',
    pointer_type: 'pen',
    device_id: 'dev',
    abs_timestamp: 1,
    feature_type: 'drawing',
    feature_confidence: 0,
    scored_type: 'stroke',
    scored_score: 0,
    hmp: null,
    marked_text: '',
    ai_eligible: false,
    origin: 'pen',
    is_tombstone: false,
  };
}

function placeholderKo(pageIndex: number, markId: string): KnowledgeObject {
  return {
    schema_version: KO_SCHEMA_VERSION,
    ko_id: `ko_${markId}`,
    kind: 'annotation',
    title: '7.1 日记 · p1',
    body_md: '（图形标注 / 圈画）',
    source: {
      document_id: 'diary_test',
      document_title: '7.1 日记',
      page_id: `pg_diary_${pageIndex}`,
      page_index: pageIndex,
      object_refs: [],
      anchor_bbox: [0.2, 0.3, 0.01, 0.01],
      inkloop_uri: `inkloop://doc/diary_test/page/${pageIndex}`,
    },
    provenance: { created_from: 'mark', mark_ids: [markId] },
    tags: ['inkloop'],
    status: 'export_ready',
    privacy: 'export_allowed',
    content_hash: 'sha256:test',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

describe('buildDocumentProjectionExport 合成占位块（无重排块但有真内容的页）', () => {
  beforeEach(() => {
    store.getDoc.mockReset();
    store.getFoldedMarks.mockReset();
  });

  it('日记页没有 page.reflow 但有真笔迹+KO 时，生成合成占位块而不是整页跳过', async () => {
    store.getDoc.mockResolvedValue(diaryDoc(1));
    store.getFoldedMarks.mockResolvedValue([drawingMark(0, 'evt_1')]);
    const kos = [placeholderKo(0, 'evt_1')];

    const result = await buildDocumentProjectionExport('diary_test', kos);

    expect(result.skippedPages).toEqual([]);
    expect(result.syntheticPages).toEqual([0]);
    const blocks = result.envelope.document_projections[0].blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].region).toBe('generated');
    expect(blocks[0].knowledge_object_ids).toEqual(['ko_evt_1']);
    expect(blocks[0].text_md).toContain('第 1 页手写内容');
    // 合成块不是真印刷正文·include_full_text 必须诚实为 false
    expect(result.envelope.document_projections[0].export_policy.include_full_text).toBe(false);
    expect(result.warnings.some((w) => w.includes('合成占位块'))).toBe(true);
  });

  it('日记页确实什么都没写（无笔迹、无KO）时，仍然跳过，不生成空壳合成块', async () => {
    store.getDoc.mockResolvedValue(diaryDoc(1));
    store.getFoldedMarks.mockResolvedValue([]);

    const result = await buildDocumentProjectionExport('diary_test', []);

    expect(result.syntheticPages).toEqual([]);
    expect(result.skippedPages).toEqual([0]);
    expect(result.envelope.document_projections).toEqual([]);
  });

  it('橡皮擦/tombstone 笔迹不算真内容，仍然跳过', async () => {
    store.getDoc.mockResolvedValue(diaryDoc(1));
    const erased = { ...drawingMark(0, 'evt_2'), is_tombstone: true };
    const eraserStroke = { ...drawingMark(0, 'evt_3'), strokes: [{ ...drawingMark(0, 'evt_3').strokes[0], tool: 'eraser' as const }] };
    store.getFoldedMarks.mockResolvedValue([erased, eraserStroke]);

    const result = await buildDocumentProjectionExport('diary_test', []);

    expect(result.syntheticPages).toEqual([]);
    expect(result.skippedPages).toEqual([0]);
  });

  it('已重排的页仍走原有真实印刷正文块逻辑，不受合成块路径影响', async () => {
    const doc = diaryDoc(1);
    doc.pages[0] = {
      page_index: 0,
      reflow: [{ id: 'b1', type: 'para', text: '这是真实印刷正文', source: [0.1, 0.1, 0.5, 0.05] } as never],
      reflow_engine: 'local',
    } as never;
    store.getDoc.mockResolvedValue(doc);
    store.getFoldedMarks.mockResolvedValue([]);

    const result = await buildDocumentProjectionExport('diary_test', []);

    expect(result.syntheticPages).toEqual([]);
    expect(result.skippedPages).toEqual([]);
    expect(result.envelope.document_projections[0].blocks[0].region).toBe('editable');
    expect(result.envelope.document_projections[0].export_policy.include_full_text).toBe(true);
  });
});
