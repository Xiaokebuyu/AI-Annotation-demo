import { describe, expect, it } from 'vitest';
import { finalize } from '../../knowledge/builder';
import type { KnowledgeKind, KnowledgeObject } from '../../knowledge/knowledge-object';
import { assembleVaultBundle, type EntityExport } from './vault-export';
import { buildVaultRelease, VAULT_RELEASE_SCHEMA_VERSION } from './vault-release';

const ko = (documentId: string, title: string, kind: KnowledgeKind, body: string, createdAt: string): Promise<KnowledgeObject> =>
  finalize({ stableKey: `m:${documentId}:${body}`, kind, documentId, documentTitle: title, objectRefs: ['r'], body, provenance: { created_from: 'mark', mark_ids: ['m'] }, status: 'export_ready', createdAt });

const entity = (mode: EntityExport['mode'], documentId: string, title: string, kos: KnowledgeObject[]): EntityExport => ({
  mode, documentId, documentTitle: title, activityDate: kos[0]?.created_at,
  knowledgeExport: { objects: kos } as unknown as EntityExport['knowledgeExport'],
  documentProjections: { document_projections: [] } as unknown as EntityExport['documentProjections'],
});

async function bundle(gen = '2026-06-29T00:00:00Z') {
  const exports = [
    entity('reading', 'doc_csapp', '深入理解计算机系统', [await ko('doc_csapp', '深入理解计算机系统', 'annotation', '缓存一致性 MESI', '2026-06-28T09:00:00Z')]),
    entity('diary', 'diary_0629', '6.29 日记', [await ko('diary_0629', '6.29 日记', 'annotation', '把 B 全量感知做完了', '2026-06-29T22:00:00Z')]),
  ];
  return assembleVaultBundle(exports, { generatedAt: gen });
}

describe('buildVaultRelease', () => {
  it('manifest 形状：schema_version + 每文件 sha256/bytes + 文件按 path 升序', async () => {
    const r = await buildVaultRelease(await bundle());
    expect(r.manifest.schema_version).toBe(VAULT_RELEASE_SCHEMA_VERSION);
    expect(r.manifest.files.length).toBe(r.files.length);
    for (const f of r.manifest.files) {
      expect(f.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(f.bytes).toBeGreaterThan(0);
    }
    const paths = r.manifest.files.map((f) => f.path);
    expect([...paths].sort()).toEqual(paths); // 升序
    expect(r.files.map((f) => f.path)).toEqual(paths); // files 与 manifest 同序
  });

  it('content_hash 真是该文件正文的 sha256（下载器据此校验）', async () => {
    const r = await buildVaultRelease(await bundle());
    const f = r.files[0];
    const m = r.manifest.files.find((x) => x.path === f.path)!;
    const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.markdown)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(m.content_hash).toBe(`sha256:${hex}`);
  });

  it('release_hash 只依赖内容：generated_at 不同但内容相同→同 release_hash（幂等·无变更不重传）', async () => {
    const a = await buildVaultRelease(await bundle('2026-06-29T00:00:00Z'));
    const b = await buildVaultRelease(await bundle('2030-01-01T00:00:00Z'));
    expect(a.manifest.generated_at).not.toBe(b.manifest.generated_at);
    expect(a.manifest.release_hash).toBe(b.manifest.release_hash); // 内容指纹稳定
  });

  it('内容变→release_hash 变', async () => {
    const a = await buildVaultRelease(await bundle());
    const exports = [entity('diary', 'diary_x', '别的日记', [await ko('diary_x', '别的日记', 'annotation', '另一条', '2026-06-29T22:00:00Z')])];
    const b = await buildVaultRelease(await assembleVaultBundle(exports, { generatedAt: '2026-06-29T00:00:00Z' }));
    expect(a.manifest.release_hash).not.toBe(b.manifest.release_hash);
  });
});
