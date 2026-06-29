import { describe, expect, it } from 'vitest';
import { assembleVaultBundle, datesOf, type EntityExport } from './vault-export';
import type { DocumentProjectionExportEnvelope, KnowledgeExportEnvelope } from './contract';

// 最小信封（datesOf/folder 只读 created_at/generated_at·其余字段无关）
const env = (...createdAts: string[]): KnowledgeExportEnvelope =>
  ({ objects: createdAts.map((created_at) => ({ created_at })) } as unknown as KnowledgeExportEnvelope);
const projEnv = (...ps: Array<{ created_at?: string; generated_at?: string }>): DocumentProjectionExportEnvelope =>
  ({ document_projections: ps } as unknown as DocumentProjectionExportEnvelope);

describe('datesOf', () => {
  it('KO 日期去重升序', () => {
    expect(datesOf(env('2026-06-29T10:00:00Z', '2026-06-28T09:00:00Z', '2026-06-29T20:00:00Z'))).toEqual(['2026-06-28', '2026-06-29']);
  });
  it('无 KO 实体走 fallbackDate（saved_at/started_at·真内容日期·不从时间维度消失）', () => {
    expect(datesOf(env(), '2026-06-26T00:00:00Z')).toEqual(['2026-06-26']);
  });
  it('不把 projection/导出时刻误当活动日期：KO 在 6-28 则只 6-28（projection generated_at=导出戳·不进）', () => {
    // fallbackDate 与 KO 日期都给 → 合并；但 projection 的导出时刻不该污染（datesOf 根本不收 projection）
    expect(datesOf(env('2026-06-28T09:00:00Z'), '2026-06-28T00:00:00Z')).toEqual(['2026-06-28']);
  });
  it('非法/空日期被剔', () => {
    expect(datesOf(env('not-a-date', ''))).toEqual([]);
  });
});

describe('assembleVaultBundle 落夹', () => {
  const ex = (mode: EntityExport['mode'], documentId: string, documentTitle: string, koDate: string): EntityExport => ({
    mode, documentId, documentTitle, knowledgeExport: env(koDate), documentProjections: projEnv(),
  });
  it('meeting 落夹带日期（同名分期）、diary 落日期夹、reading 干净标题夹', async () => {
    const bundle = await assembleVaultBundle(
      [
        ex('meeting', 'mtgdoc_x', '周会', '2026-06-29T03:00:00Z'),
        ex('diary', 'diary_x', '6.29 日记', '2026-06-29T22:00:00Z'),
        ex('reading', 'doc_x', '深入理解计算机系统', '2026-06-28T09:00:00Z'),
      ],
      { generatedAt: '2026-06-29T00:00:00Z' },
    );
    const fold = (m: string) => bundle.entities.find((e) => e.mode === m)?.folder.base_dir;
    expect(fold('meeting')).toBe('InkLoop/Meetings/2026-06-29 周会');
    expect(fold('diary')).toBe('InkLoop/Diary/2026-06-29');
    expect(fold('reading')).toBe('InkLoop/Reading/深入理解计算机系统');
    expect(bundle.moc.folder.base_dir).toBe('InkLoop'); // MOC 落顶层
    expect(bundle.moc.documentProjections.document_projections.length).toBeGreaterThan(0);
  });
});
