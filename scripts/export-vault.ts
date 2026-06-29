/**
 * Vault 写驱动（Node·dev/验证用）—— 读 __inkloop.exportVaultBundle() 产的 bundle JSON，逐实体按 folder 写进真 Obsidian vault。
 *
 * 浏览器（IndexedDB）产 bundle、Node（fs）写 vault 的分工。直接 import 协作方 SDK 的 obsidian-fs adapter
 * （同 cli.ts 的 resolveTarget + exportDocuments + exportObjects），但**逐实体换 base_dir/documents_dir**
 * → 各落自己的可见目录（待办2 folder 整理）；MOC 落 vault 根（待办1 全量感知）。
 *
 * 用法：npx tsx scripts/export-vault.ts --bundle <bundle.json> --vault <vault-path>
 *
 * ⚠️ binding 黏性：已导出内容改 base_dir 可能仍写旧 remote_path（adapter.ts:285）→ 折叠迁移另算·本驱动针对**全新 vault**。
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { obsidianFsAdapter } from '../ink-surface-sdk-main/examples/ai-annotation-demo/src/adapters/obsidian-fs/adapter';
import { obsidianFsDocumentAdapter } from '../ink-surface-sdk-main/examples/ai-annotation-demo/src/adapters/obsidian-fs/document-adapter';
import { JsonAdapterStorage } from '../ink-surface-sdk-main/examples/ai-annotation-demo/src/adapters/obsidian-fs/json-storage';
import { parseDocumentProjection } from '../ink-surface-sdk-main/examples/ai-annotation-demo/src/knowledge/document-projection';
import { parseKnowledgeObject } from '../ink-surface-sdk-main/examples/ai-annotation-demo/src/knowledge/knowledge-object';

interface Folder {
  base_dir: string;
  documents_dir: string;
}
interface BundleEntity {
  mode: string;
  documentId: string;
  documentTitle: string;
  folder: Folder;
  knowledgeExport: { objects: unknown[] };
  documentProjections: { document_projections: unknown[] };
  warnings?: string[];
}
interface Bundle {
  generatedAt?: string;
  entities: BundleEntity[];
  moc: { folder: Folder; documentProjections: { document_projections: unknown[] } };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function writeUnit(vaultRoot: string, folder: Folder, objectsRaw: unknown[], projectionsRaw: unknown[], label: string): Promise<void> {
  const objects = objectsRaw.map(parseKnowledgeObject);
  const projections = projectionsRaw.map(parseDocumentProjection);
  // create_source_notes：即便某实体的 projection 被 include_full_text=false 拦下，也确保源笔记枢纽存在 → MOC `[[基名]]` 不 dangling。
  const config = { vault_root: vaultRoot, base_dir: folder.base_dir, documents_dir: folder.documents_dir, create_source_notes: true };
  const validation = await obsidianFsAdapter.validateConfig(config);
  if (!validation.ok) throw new Error(`[${label}] invalid config: ${JSON.stringify(validation)}`);
  const target = await obsidianFsAdapter.resolveTarget(config);
  const storage = JsonAdapterStorage.forVault(target.vault_root, target.base_dir);
  // projection 先（建源文档/枢纽），KO 后（叶子回链枢纽）——同 cli.ts 顺序。
  if (projections.length) await obsidianFsDocumentAdapter.exportDocuments({ projections, target, storage, knowledgeObjects: objects });
  if (objects.length) await obsidianFsAdapter.exportObjects({ objects, target, storage, documentProjections: projections });
  console.log(`  ✓ ${label.padEnd(28)} ${folder.documents_dir.padEnd(40)} proj=${projections.length} ko=${objects.length}`);
}

/** 把各实体的导出诊断（被闸挡/未落块等）落成一篇可见报告——「全量感知」诚实面：没进 vault 的东西留痕、不静默。 */
async function writeReport(vaultRoot: string, bundle: Bundle): Promise<void> {
  const rows = bundle.entities.filter((e) => e.warnings?.length);
  if (!rows.length) return;
  const lines = ['---', 'tags: [inkloop, inkloop/report]', '---', '', '# InkLoop 导出报告', '', `生成于 ${bundle.generatedAt ?? ''}`, '', '以下内容**未完整进入 vault**（隐私本地化 / 空正文 / 未重排落块等）——在此留痕，不静默丢失：', ''];
  for (const e of rows) for (const w of e.warnings ?? []) lines.push(`- **${e.mode}｜${e.documentTitle}**：${w}`);
  const dir = join(resolve(process.cwd(), vaultRoot), 'InkLoop');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'InkLoop 导出报告.md'), `${lines.join('\n')}\n`, 'utf8');
  console.log(`  ✓ 导出报告：${rows.length} 个实体有诊断`);
}

async function main(): Promise<void> {
  const bundlePath = arg('--bundle');
  const vaultRoot = arg('--vault');
  if (!bundlePath || !vaultRoot) {
    console.error('Usage: npx tsx scripts/export-vault.ts --bundle <bundle.json> --vault <vault-path> [--allow-existing]');
    process.exit(1);
  }
  const vaultAbs = resolve(process.cwd(), vaultRoot);
  // binding 黏性（adapter.ts:285）：改 folder 规则重跑旧 vault 会留陈旧/重复文件、MOC 只指新的一套 → 默认拒绝。
  if (!process.argv.includes('--allow-existing') && (await exists(join(vaultAbs, 'InkLoop')))) {
    console.error('拒绝写入已存在 InkLoop 树（binding 黏性会致重复/陈旧）。处理迁移后用 --allow-existing。');
    process.exit(2);
  }
  const bundle = JSON.parse(await readFile(resolve(process.cwd(), bundlePath), 'utf8')) as Bundle;

  console.log(`Vault: ${vaultAbs}`);
  console.log(`Entities: ${bundle.entities.length} + MOC`);
  for (const e of bundle.entities) {
    await writeUnit(vaultRoot, e.folder, e.knowledgeExport.objects, e.documentProjections.document_projections, `${e.mode}:${e.documentTitle}`);
  }
  await writeUnit(vaultRoot, bundle.moc.folder, [], bundle.moc.documentProjections.document_projections, 'MOC (枢纽)');
  await writeReport(vaultRoot, bundle);
  console.log('Done.');
}

void main();
