import { describe, expect, it } from 'vitest';
// ⚠️交叉核对：直接用协作方 SDK 的 projection 校验函数（validate-fixtures.ts 的同款检查）验我方 MOC 过校验。
import {
  computeDocumentProjectionBodyHash,
  parseDocumentProjection,
  recomputeDocumentProjectionHash,
} from '../../../ink-surface-sdk-main/examples/ai-annotation-demo/src/knowledge/document-projection';
import { buildMocProjections, type MocEntity } from './moc';
import type { DocumentProjection } from './contract';
import { sourceNoteBaseName } from './vault-layout';

const OPTS = { generatedAt: '2026-06-29T00:00:00.000Z' };

const ENTITIES: MocEntity[] = [
  { documentId: 'doc_b1', documentTitle: '深入理解计算机系统', mode: 'reading', dates: ['2026-06-28', '2026-06-29'] },
  { documentId: 'mtgdoc_m1', documentTitle: '架构评审 v4', mode: 'meeting', dates: ['2026-06-29'] },
  { documentId: 'diary_d1', documentTitle: '6.29 日记', mode: 'diary', dates: ['2026-06-29'] },
];

const textOf = (p: DocumentProjection): string => p.blocks.map((b) => b.text_md).join('\n');
const byId = (ps: DocumentProjection[], id: string): DocumentProjection => {
  const p = ps.find((x) => x.document_id === id);
  if (!p) throw new Error(`MOC not found: ${id}`);
  return p;
};

describe('buildMocProjections', () => {
  it('产出 每日 + 每模式 + 根（数量精确）', async () => {
    const ps = await buildMocProjections(ENTITIES, OPTS);
    // 2 每日（6-28 只有书 / 6-29 三个）+ 3 模式 + 1 根 = 6
    expect(ps.map((p) => p.document_id).sort()).toEqual(
      ['moc_date_2026-06-28', 'moc_date_2026-06-29', 'moc_mode_diary', 'moc_mode_meeting', 'moc_mode_reading', 'moc_root'].sort(),
    );
  });

  it('每篇 MOC 过协作方 SDK projection 校验（parse + body_hash + content_hash 重算一致）', async () => {
    const ps = await buildMocProjections(ENTITIES, OPTS);
    for (const p of ps) {
      const parsed = parseDocumentProjection(p); // zod 解析（不抛=结构合规）
      expect(p.body_hash).toBe(await computeDocumentProjectionBodyHash(parsed.blocks));
      expect(p.content_hash).toBe(await recomputeDocumentProjectionHash(parsed));
    }
  });

  it('每日 MOC：当天所有实体 hub 链接 + 内联日期标签（链接目标=真实枢纽基名）', async () => {
    const ps = await buildMocProjections(ENTITIES, OPTS);
    const d29 = byId(ps, 'moc_date_2026-06-29');
    const t = textOf(d29);
    expect(t).toContain('#inkloop/date/2026-06-29');
    for (const e of ENTITIES) {
      expect(t).toContain(`[[${sourceNoteBaseName(e.documentTitle, e.documentId)}|`); // 链接目标=枢纽基名
    }
    // 「日记式」一句话：6-29 当天三模式都活动 → 读了…开了…写了…
    expect(t).toMatch(/2026-06-29 读了 .*，开了 .*，写了 .*。/);
    // 6-28 只含书（会议/日记那天没活动）
    const d28 = textOf(byId(ps, 'moc_date_2026-06-28'));
    expect(d28).toContain(sourceNoteBaseName('深入理解计算机系统', 'doc_b1'));
    expect(d28).not.toContain('mtgdoc_m1');
    expect(d28).not.toContain('diary_d1');
  });

  it('零丢失：每个实体都进了对应每日 MOC 与其模式 MOC', async () => {
    const ps = await buildMocProjections(ENTITIES, OPTS);
    for (const e of ENTITIES) {
      const base = sourceNoteBaseName(e.documentTitle, e.documentId);
      const inDaily = e.dates.some((d) => textOf(byId(ps, `moc_date_${d}`)).includes(base));
      const inMode = textOf(byId(ps, `moc_mode_${e.mode}`)).includes(base);
      expect(inDaily, `${e.documentId} 应在某每日 MOC`).toBe(true);
      expect(inMode, `${e.documentId} 应在 ${e.mode} 模式 MOC`).toBe(true);
    }
  });

  it('根 MOC：链三个模式 MOC + 最近每日 MOC', async () => {
    const ps = await buildMocProjections(ENTITIES, OPTS);
    const root = textOf(byId(ps, 'moc_root'));
    expect(root).toContain('#inkloop/moc');
    for (const m of ['reading', 'meeting', 'diary'] as const) {
      expect(root).toContain(sourceNoteBaseName({ reading: '阅读', meeting: '会议', diary: '日记' }[m], `moc_mode_${m}`));
    }
    expect(root).toContain(sourceNoteBaseName('2026-06-29', 'moc_date_2026-06-29'));
  });

  it('空实体 → 空数组', async () => {
    expect(await buildMocProjections([], OPTS)).toEqual([]);
  });

  it('确定性：同输入 → 同 content_hash', async () => {
    const a = await buildMocProjections(ENTITIES, OPTS);
    const b = await buildMocProjections(ENTITIES, OPTS);
    expect(a.map((p) => p.content_hash)).toEqual(b.map((p) => p.content_hash));
  });
});
