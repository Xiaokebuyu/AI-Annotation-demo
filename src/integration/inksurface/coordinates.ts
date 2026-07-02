/**
 * ④ 坐标变换：canonical 笔点是**页归一化** [0,1]（PDF 页；reader 落笔另有 surface_points），
 * 对方 visual_strokes 要**块内局部归一化**（点相对所属块 bbox·renderer 乘 100 放进块 SVG）。
 * 变换 = (p − blockOrigin) / blockSize。**不夹到 [0,1]**：对方文档明确允许溢出（旁注/圈到段外/跨段手写需要）。
 */
import type { NormBBox } from '../../knowledge/knowledge-object';
import type { StrokePoint } from '../../core/contracts';
import type { RuntimeStrokePoint } from 'ink-surface-sdk/runtime-schema';

const safe = (v: number): number => (Math.abs(v) <= 1e-6 ? 1e-6 : v);

export function pagePointToBlock(p: StrokePoint, block: NormBBox): RuntimeStrokePoint {
  const [bx, by, bw, bh] = block;
  return { x: (p.x - bx) / safe(bw), y: (p.y - by) / safe(bh), t: p.t, pressure: p.pressure };
}

export function pageBBoxToBlock(bb: NormBBox, block: NormBBox): NormBBox {
  const [x, y, w, h] = bb;
  const [bx, by, bw, bh] = block;
  return [(x - bx) / safe(bw), (y - by) / safe(bh), w / safe(bw), h / safe(bh)];
}
