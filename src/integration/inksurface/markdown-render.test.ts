import { describe, expect, it } from 'vitest';
import { enrichExportTags, finalize } from '../../knowledge/builder';
import type { KnowledgeKind, KnowledgeObject } from '../../knowledge/knowledge-object';
import { assembleVaultBundle, type EntityExport } from './vault-export';
import { buildConceptLayer } from './concept-layer';
import { renderVaultMarkdown } from './markdown-render';

const ko = async (documentId: string, title: string, kind: KnowledgeKind, body: string, createdAt: string): Promise<KnowledgeObject> =>
  enrichExportTags(await finalize({ stableKey: `m:${documentId}:${body}`, kind, documentId, documentTitle: title, objectRefs: ['r'], body, provenance: { created_from: 'mark', mark_ids: ['m'] }, status: 'export_ready', createdAt }));

const entity = (mode: EntityExport['mode'], documentId: string, title: string, kos: KnowledgeObject[], blocks: unknown[] = []): EntityExport => ({
  mode, documentId, documentTitle: title, activityDate: kos[0]?.created_at,
  knowledgeExport: { objects: kos } as unknown as EntityExport['knowledgeExport'],
  documentProjections: { document_projections: blocks.length ? [{ blocks }] : [] } as unknown as EntityExport['documentProjections'],
});

async function build() {
  const exports = [
    entity('reading', 'doc_csapp', '深入理解计算机系统', [
      await ko('doc_csapp', '深入理解计算机系统', 'annotation', '缓存一致性 MESI 这段要重读', '2026-06-28T09:00:00Z'),
      await ko('doc_csapp', '深入理解计算机系统', 'ai_note', 'AI：和 DDIA 复制章节同源', '2026-06-29T10:00:00Z'),
    ]),
    entity('meeting', 'mtgdoc_v4', '架构评审 v4', [
      await ko('mtgdoc_v4', '架构评审 v4', 'annotation', '两层真相边界＝命门　（约 0:16 处手写）', '2026-06-29T03:00:00Z'),
      await ko('mtgdoc_v4', '架构评审 v4', 'summary', '会议要点：两层架构', '2026-06-29T03:00:00Z'),
    ], [
      { block_id: 'blk_1', kind: 'heading', text_md: '讨论 v4 架构', region: 'generated', knowledge_object_ids: [] },
      { block_id: 'blk_2', kind: 'paragraph', text_md: '张宇：真相分两层。', region: 'generated', knowledge_object_ids: [] },
      { block_id: 'blk_3', kind: 'paragraph', text_md: '# 决策 参考 [[幽灵节点]] 见下', region: 'generated', knowledge_object_ids: [] },
    ]),
    entity('diary', 'diary_0629', '6.29 日记', [
      await ko('diary_0629', '6.29 日记', 'annotation', '把 B 全量感知做完了', '2026-06-29T22:00:00Z'),
    ]),
  ];
  const bundle = await assembleVaultBundle(exports, { generatedAt: '2026-06-29T00:00:00Z' });
  return renderVaultMarkdown(bundle);
}

const baseOf = (p: string) => p.split('/').pop()!.replace(/\.md$/, '');

describe('renderVaultMarkdown', () => {
  it('零 sidecar：无 docs/indexes/_assets/.inkloop/manifest/state', async () => {
    const files = await build();
    for (const f of files) {
      expect(f.path).not.toMatch(/\/(docs|indexes|_assets)\//);
      expect(f.path).not.toContain('.inkloop');
      expect(f.path.endsWith('.md')).toBe(true);
    }
  });

  it('文件名干净：无 ko_id 尾巴、无 "p1" 噪声', async () => {
    const files = await build();
    for (const f of files) {
      expect(f.path).not.toMatch(/ko_[0-9A-HJKMNP-TV-Z]{6}/);
      expect(baseOf(f.path)).not.toMatch(/ - [0-9A-Z]{6}$/);
    }
  });

  it('所有 [[wikilink]] 都解析到真实文件（零 dangling·图谱连通）', async () => {
    const files = await build();
    const bases = new Set(files.map((f) => baseOf(f.path)));
    const links = files.flatMap((f) => [...f.markdown.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]));
    const dangling = [...new Set(links)].filter((l) => !bases.has(l));
    expect(links.length).toBeGreaterThan(0);
    expect(dangling).toEqual([]);
  });

  it('叶子带 callout + 来源回链 + 标签；枢纽出链到叶子（双向连通）', async () => {
    const files = await build();
    const leaf = files.find((f) => f.path.includes('缓存一致性'));
    expect(leaf).toBeTruthy();
    expect(leaf!.markdown).toContain('> [!note] InkLoop');
    expect(leaf!.markdown).toContain('**来源**：[[深入理解计算机系统]]');
    expect(leaf!.markdown).toMatch(/inkloop\/book\//);
    const hub = files.find((f) => f.path.endsWith('Reading/深入理解计算机系统/深入理解计算机系统.md'));
    expect(hub!.markdown).toContain('## 笔记');
    expect(hub!.markdown).toContain('[[缓存一致性 MESI 这段要重读]]');
  });

  it('会议枢纽渲染转写；每日 MOC 带日记句（跨模式）', async () => {
    const files = await build();
    const mtg = files.find((f) => f.path.includes('Meetings/') && f.path.endsWith('架构评审 v4.md'));
    expect(mtg!.markdown).toContain('## 讨论 v4 架构'); // 段摘要=转写小节标题（无空 ## 转写 wrapper）
    expect(mtg!.markdown).toContain('张宇：真相分两层。');
    // 转写注入防护：cue 里的 [[幽灵节点]] 被转义、不生成真链接；行首 # 不变标题
    expect(mtg!.markdown).toContain('\\[\\[幽灵节点\\]\\]');
    expect(mtg!.markdown).not.toContain('[[幽灵节点]]');
    expect(mtg!.markdown).toContain('\\# 决策');
    const daily = files.find((f) => baseOf(f.path) === '2026-06-29');
    expect(daily!.markdown).toContain('inkloop/date/2026-06-29'); // frontmatter 标签
    expect(daily!.markdown).toMatch(/2026-06-29 .*开了 .*，写了 .*。/);
    // 节点名剥掉「（约 m:ss 处手写）」时间尾巴（正文仍保留）
    expect(files.some((f) => baseOf(f.path) === '两层真相边界=命门')).toBe(true);
    expect(files.every((f) => !baseOf(f.path).includes('处手写'))).toBe(true);
    const ann = files.find((f) => baseOf(f.path) === '两层真相边界=命门');
    expect(ann!.markdown).toContain('处手写'); // 正文保留时间信息
  });

  it('确定性：同输入 → 同文件集', async () => {
    const a = await build();
    const b = await build();
    expect(a.map((f) => f.path).sort()).toEqual(b.map((f) => f.path).sort());
  });
});

describe('renderVaultMarkdown + 概念层', () => {
  it('概念枢纽落 Concepts/·叶子加相关概念链接+topic 标签·零 dangling', async () => {
    const exports = [
      entity('reading', 'doc_csapp', '深入理解计算机系统', [await ko('doc_csapp', '缓存一致性 MESI', 'annotation', '缓存一致性 MESI 这段要重读', '2026-06-28T09:00:00Z')]),
      entity('diary', 'diary_0629', '6.29 日记', [await ko('diary_0629', '一致性收口', 'annotation', '把一致性问题收口了', '2026-06-29T22:00:00Z')]),
    ];
    const kos = exports.flatMap((e) => e.knowledgeExport.objects);
    // 假抽取器让两条不同文档的笔记共享「一致性」→ 成跨文档桥概念
    const cl = await buildConceptLayer(kos, async (k) => (k.body_md.includes('一致性') ? ['一致性'] : []));
    const bundle = await assembleVaultBundle(exports, { generatedAt: '2026-06-29T00:00:00Z', conceptLayer: cl });
    const files = renderVaultMarkdown(bundle);

    const concept = files.find((f) => f.path === 'InkLoop/Concepts/一致性.md');
    expect(concept).toBeTruthy();
    expect(concept!.markdown).toContain('inkloop/concept');
    expect(concept!.markdown).toContain('## 相关笔记');
    expect(concept!.markdown).toContain('[[缓存一致性 MESI 这段要重读]]'); // 成员叶子链接（叶子名=正文摘录）

    const leaf = files.find((f) => baseOf(f.path) === '缓存一致性 MESI 这段要重读');
    expect(leaf!.markdown).toContain('**相关概念**：[[一致性]]');
    expect(leaf!.markdown).toContain('inkloop/topic/一致性');

    // 零 dangling（含概念边）
    const bases = new Set(files.map((f) => baseOf(f.path)));
    const links = files.flatMap((f) => [...f.markdown.matchAll(/(?<!\\)\[\[([^\]]+)\]\]/g)].map((m) => m[1]));
    expect([...new Set(links)].filter((l) => !bases.has(l))).toEqual([]);
  });
});
