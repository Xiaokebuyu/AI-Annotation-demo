/**
 * 边界运行时校验（C5）—— 跨信任边界进来的数据用 zod 校验，不再裸 `as`。
 * 这里放「原生桥（InkLoopOcr）」契约：桥是另一侧（Kotlin）序列化过来的 JSON，
 * 校验可挡住 Kotlin 端契约漂移污染下游（畸形即丢弃 → 调用方降级云端）。
 * （AI 返回的校验在 server/infer.ts；账本 reload 校验留作后续。）
 */
import { z } from 'zod';

/** 原生桥 RPC 应答信封：{id, ok, result?, error?}。畸形即丢弃。 */
export const bridgeRpcRes = z.object({
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type BridgeRpcRes = z.infer<typeof bridgeRpcRes>;

/** 端侧各 method 的 result 形状（不符约定 → null → 调用方自动降级云端）。 */
export const ondeviceResult = {
  recognizeInk: z.object({ kind: z.string(), reading: z.string(), description: z.string() }),
  ocrRegion: z.object({ text: z.string() }),
  capabilities: z.object({ gms: z.boolean().optional() }),
};
