/**
 * 运笔方式（manner）—— Slice A：从一个 mark 的构成笔确定性地提取"怎么画的"，喂进 inference-view 叙事，
 * 让模型读到果断/迟疑/重描，而非只读"做了什么"。纯几何、无模型、scale-free（归一化坐标 + 相对 ms），
 * 原版页与重排面通用。只在信号明显时给 adverb，避免每笔贴标签变噪声；阈值 DEV 可调。
 * 无时间戳的笔（如重排面历史笔）→ 退化为仅几何 retraced，不臆测速度/迟疑。
 */
import type { MarkFeatureType, MarkManner, StrokePoint } from '../core/contracts';

const HESITATE_MS = 280;    // 落笔迟疑：起步前静止超此值
const SETTLE_FRAC = 0.08;   // 起步判定：位移超首笔 bbox 对角线此比例 = 已起步
const FAST = 4.0;           // 果断：归一化速度（对角线/秒）> 此值
const SLOW = 1.3;           // 仔细/缓慢：< 此值
const RETRACE_RATIO = 4.5;  // 重描（仅 markup）：总路程 / bbox 对角线 > 此值

type Pt = { x: number; y: number; t: number };
const d = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

function diagOf(pts: Pt[]): number {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return Math.hypot(x1 - x0, y1 - y0) || 1e-6;
}

/** 首笔落笔迟疑：从 t=0 到位移超过 SETTLE_FRAC·对角线 的那一刻的 t（ms）。 */
function landingHesitation(first: Pt[]): number {
  if (first.length < 2) return 0;
  const diag = diagOf(first), p0 = first[0];
  for (const p of first) if (d(p0, p) > SETTLE_FRAC * diag) return p.t || 0;
  return first[first.length - 1].t || 0;
}

/** 从构成笔提取运笔方式。featureType=已识别定型的最终类型（retraced 仅对 markup 有意义）。 */
export function computeManner(strokes: { points: StrokePoint[] }[], featureType: MarkFeatureType): MarkManner {
  const all = strokes.flatMap((s) => s.points);
  if (all.length < 3) return {};
  const diag = diagOf(all);
  let travel = 0, activeMs = 0;
  for (const s of strokes) {
    const p = s.points;
    for (let i = 1; i < p.length; i++) travel += d(p[i - 1], p[i]);
    if (p.length) activeMs += p[p.length - 1].t || 0; // 每笔 t 相对自身起点
  }
  const retraced = featureType === 'markup' && travel / diag > RETRACE_RATIO;

  const m: MarkManner = {};
  if (retraced) m.retraced = true;

  // 速度/迟疑只在有真实时间戳时算（无 t 的笔不臆测）
  if (activeMs > 0) {
    const speed = (travel / diag) / (activeMs / 1000); // 对角线/秒
    const hesitationMs = landingHesitation(strokes[0]?.points ?? []);
    m.speed = +speed.toFixed(2);
    m.hesitationMs = Math.round(hesitationMs);
    if (hesitationMs > HESITATE_MS) m.adverb = 'hesitant';
    else if (featureType !== 'drawing' && speed >= FAST && !retraced) m.adverb = 'decisive';
    else if (featureType !== 'drawing' && speed <= SLOW) m.adverb = 'careful';
  }
  return m;
}
