import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MARK_ENTRY_SCHEMA_VERSION, type PersistedMark } from '../../core/store-format';
import { KO_SCHEMA_VERSION, type KnowledgeObject } from '../../knowledge/knowledge-object';
import type { DocumentProjectionBlock as ProjectionBlock } from 'ink-surface-sdk/knowledge-schema';

const store = vi.hoisted(() => ({
  getFoldedMarks: vi.fn(),
}));

vi.mock('../../local/store', () => ({
  getFoldedMarks: store.getFoldedMarks,
}));

import { buildRuntimeAndVisual } from './runtime-surface';

describe('buildRuntimeAndVisual surface strokes', () => {
  beforeEach(() => {
    store.getFoldedMarks.mockReset();
  });

  it('keeps reader-local stroke points while preserving legacy block_norm visual projection', async () => {
    const mark: PersistedMark = {
      schema_version: MARK_ENTRY_SCHEMA_VERSION,
      entry_id: 'ent_reader',
      document_id: 'doc_reader',
      page_id: 'pg_0e8fdedf_3',
      page_index: 3,
      seq: 1,
      created_at: '2026-06-30T08:00:00.000Z',
      mark_id: 'm_reader',
      strokes: [{
        tool: 'aipen',
        points: [
          { x: 0.15, y: 0.23, t: 0, pressure: 0.5 },
          { x: 0.19, y: 0.25, t: 20, pressure: 0.6 },
        ],
        coord_space: 'page_norm',
        capture_surface: 'reader',
        surface_points: [
          { x: 120, y: 480, t: 0, pressure: 0.5 },
          { x: 200, y: 520, t: 20, pressure: 0.6 },
        ],
        surface_coord_space: 'reader_px',
        surface_bbox: [120, 480, 80, 40],
        anchor_runs: ['run_child_1'],
      }],
      bbox: [0.15, 0.23, 0.04, 0.02],
      coord_space: 'page_norm',
      capture_surface: 'reader',
      surface_bbox: [120, 480, 80, 40],
      surface_coord_space: 'reader_px',
      tool: 'pen',
      color: '#1A1A1A',
      pointer_type: 'reader',
      device_id: 'dev',
      abs_timestamp: 1,
      feature_type: 'markup',
      feature_confidence: 0.9,
      scored_type: 'circle',
      scored_score: 0.9,
      hmp: null,
      marked_text: '两个孩子听得入神',
      ai_eligible: true,
      origin: 'ai_pen',
      is_tombstone: false,
    };
    store.getFoldedMarks.mockResolvedValue([mark]);

    const block: ProjectionBlock = {
      block_id: 'blk_reader',
      kind: 'paragraph',
      text_md: '两个孩子听得入神。',
      region: 'generated',
      source: {
        page_id: 'pg_0e8fdedf_3',
        page_index: 3,
        object_refs: ['run_child_1'],
        anchor_bbox: [0.1, 0.2, 0.4, 0.1],
      },
      knowledge_object_ids: ['ko_reader'],
    };
    const ko: KnowledgeObject = {
      schema_version: KO_SCHEMA_VERSION,
      ko_id: 'ko_reader',
      kind: 'annotation',
      title: 'reader mark',
      body_md: '',
      source: {
        document_id: 'doc_reader',
        document_title: 'reader doc',
        page_id: 'pg_0e8fdedf_3',
        page_index: 3,
        object_refs: ['run_child_1'],
        inkloop_uri: 'inkloop://doc/doc_reader/page/3',
      },
      provenance: { created_from: 'mark', mark_ids: ['m_reader'] },
      tags: ['inkloop'],
      status: 'export_ready',
      privacy: 'export_allowed',
      content_hash: 'sha256:test',
      created_at: '2026-06-30T08:00:00.000Z',
      updated_at: '2026-06-30T08:00:00.000Z',
    };

    const result = await buildRuntimeAndVisual('doc_reader', 'reader doc', [block], [ko]);

    const rt = result.surfaceBlocks[0].annotations?.[0];
    expect(rt?.capture_surface).toBe('reader');
    expect(rt?.surface_coord_space).toBe('reader_px');
    expect(rt?.surface_bbox).toEqual([120, 480, 80, 40]);
    expect(rt?.surface_strokes).toEqual([{
      tool: 'pen',
      color: '#1A1A1A',
      capture_surface: 'reader',
      coord_space: 'reader_px',
      bbox: [120, 480, 80, 40],
      points: [
        { x: 120, y: 480, t: 0, pressure: 0.5 },
        { x: 200, y: 520, t: 20, pressure: 0.6 },
      ],
    }]);
    expect(rt?.visual_strokes?.[0].coord_space).toBe('block_norm');
    expect(rt?.visual_strokes?.[0].capture_surface).toBe('reader');
    expect(rt?.visual_strokes?.[0].tool).toBe('pen');
    expect(rt?.visual_strokes?.[0].points[0].x).toBeCloseTo(0.125);
    expect(rt?.visual_strokes?.[0].points[0].y).toBeCloseTo(0.3);
    expect(rt?.visual_strokes?.[0].points[0].t).toBe(0);
    expect(rt?.visual_strokes?.[0].points[0].pressure).toBe(0.5);
    expect(result.visualModel.blocks[0].annotations[0].surface_strokes?.[0].coord_space).toBe('reader_px');
    expect(result.warnings.some((w) => w.includes('非原版 surface'))).toBe(true);
  });
});
