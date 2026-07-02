/**
 * 干净 vault 渲染写盘（Node·dev/验证用）—— 读 bundle JSON → renderVaultMarkdown → 直接写 .md（纯 fs·零 SDK 适配器·零 sidecar）。
 * 用法：npx tsx scripts/render-vault.ts --bundle <bundle.json> --vault <vault-path> [--clean]
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { renderVaultMarkdown } from 'ink-surface-sdk/adapters/obsidian';
import type { VaultExportBundle } from '../src/integration/inksurface/vault-export';
import { toObsidianVaultRenderInput } from '../src/integration/inksurface/vault-render-input';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** 只允许写 vault 的 InkLoop/ 子树——防坏/恶意 bundle 的 `../X` 路径逃出 vault。 */
function targetInVault(vaultAbs: string, relPath: string): string {
  const target = resolve(vaultAbs, relPath);
  const rel = relative(vaultAbs, target);
  if (isAbsolute(rel) || rel.split(/[\\/]/)[0] !== 'InkLoop') throw new Error(`拒绝写到 InkLoop/ 之外：${relPath}`);
  return target;
}

async function main(): Promise<void> {
  const bundlePath = arg('--bundle');
  const vaultRoot = arg('--vault');
  if (!bundlePath || !vaultRoot) {
    console.error('Usage: npx tsx scripts/render-vault.ts --bundle <bundle.json> --vault <vault-path> [--clean]');
    process.exit(1);
  }
  const vaultAbs = resolve(process.cwd(), vaultRoot);

  // 先 parse + render + 路径校验**全部成功**，再 clean/写盘——否则坏 bundle 会先删旧 vault 又写不出新文件。
  let bundle: VaultExportBundle;
  try {
    bundle = JSON.parse(await readFile(resolve(process.cwd(), bundlePath), 'utf8')) as VaultExportBundle;
  } catch (err) {
    throw new Error(`Invalid bundle JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const targets = renderVaultMarkdown(toObsidianVaultRenderInput(bundle)).map((f) => ({ markdown: f.markdown, target: targetInVault(vaultAbs, f.path) }));

  if (process.argv.includes('--clean')) await rm(join(vaultAbs, 'InkLoop'), { recursive: true, force: true });
  for (const t of targets) {
    await mkdir(dirname(t.target), { recursive: true });
    await writeFile(t.target, t.markdown, 'utf8');
  }
  console.log(`Vault: ${vaultAbs}`);
  console.log(`Wrote ${targets.length} markdown files (zero sidecar).`);
}

void main();
