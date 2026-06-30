/**
 * 导出用确定性 ID/Token —— SDK 未提供这两个（stampExportId 是我方导出信封惯例·stableToken 是 MOC/投影 block_id 用）。
 * 复用 SDK 的 sha256Hex 保持哈希口径一致。
 */
import { sha256Hex } from 'ink-surface-sdk/knowledge-schema';

/** export_id：前缀 + documentId + 紧凑时间戳（去随机·同输入同 id）。 */
export const stampExportId = (prefix: string, documentId: string, generatedAt: string): string =>
  `${prefix}_${documentId}_${generatedAt.replace(/[-:.TZ]/g, '')}`;

/** 稳定 token（block_id 去随机·保确定性）= sha256(seed) 前 len 位。 */
export async function stableToken(seed: string, len = 10): Promise<string> {
  return (await sha256Hex(seed)).slice(0, len);
}
