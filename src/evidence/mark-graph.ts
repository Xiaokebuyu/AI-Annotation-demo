/**
 * 标注图（mark graph）—— 把一段 session 的 mark 建成带三类边的图。
 *
 *   空间边（"空间近一定有关联"，恒算）：邻近 / 包含 / 同目标对象。
 *   时间边：相邻 mark 的先后 + 间隔，并携带时间×空间四象限标签。
 *   语义边：箭头 A→B 方向、手写指向。语义可盖过几何（权重更高，留给 inference-view 解读）。
 *
 * 纯几何、确定性、无模型。命中复用 focus.pointInPolygon；逐 mark 的取证(HMP)由调用方先建好传入。
 */
import type {
  HMP, MarkEdge, MarkGraph, MarkNode, NormBBox, QuadrantLabel, StrokePoint,
} from '../core/contracts';
import { INFERVIEW_SCHEMA_VERSION } from '../core/contracts';
import type { Mark } from '../capture/session';
import { BURST_GAP_MS } from '../capture/session';
import { markShapeOf } from '../capture/classify';
import { pointInPolygon } from './focus';

/** 两 mark 中心被视为"空间近"的归一化距离阈值。 */
const SPATIAL_NEAR = 0.12;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const centerOf = (b: NormBBox): [number, number] => [b[0] + b[2] / 2, b[1] + b[3] / 2];
const centerDist = (a: NormBBox, b: NormBBox): number => {
  const [ax, ay] = centerOf(a), [bx, by] = centerOf(b);
  return Math.hypot(ax - bx, ay - by);
};

/** 时间"近"阈值（关系判定用，比 burst 组装窗宽，配合手写慢节奏）：≤此值视为同一阅读流。dev 可调。 */
const NEAR_TIME_MS = 30_000;

/** 时间×空间四象限。关系 = 非 separate（时间近 或 空间近 即关联；唯独时间远 AND 空间远才算无关）。 */
function quadrantOf(gapMs: number, dist: number): QuadrantLabel {
  const nearTime = gapMs < NEAR_TIME_MS;
  const nearSpace = dist < SPATIAL_NEAR;
  if (nearTime && nearSpace) return 'one_action';
  if (nearTime && !nearSpace) return 'sweep';
  if (!nearTime && nearSpace) return 'revisit';
  return 'separate';
}

/** 一个 mark 的笔迹是否包住另一个 mark 的中心（射线法）。 */
function encloses(host: Mark, ptBbox: NormBBox): boolean {
  const [cx, cy] = centerOf(ptBbox);
  return pointInPolygon(cx, cy, host.event.stroke_points);
}

function nodeOf(mark: Mark, hmp: HMP | null): MarkNode {
  return {
    mark_id: mark.id,
    page_id: mark.event.page_id,
    shape: hmp?.action ?? markShapeOf(mark.event.event_type, mark.scored.score),
    feature_type: mark.feature.type,
    feature_confidence: mark.feature.confidence,
    bbox: mark.event.geometry.bbox,
    t: mark.t,
    mode: hmp?.mode ?? 'unknown',
    object_hint: hmp?.object_hint ?? 'unknown',
    target_object_refs: hmp?.target_object_refs ?? [],
    text_hint: hmp?.text_hint,
    text: mark.markedText, // 落笔当时解析好（跨页提交不再依赖 live index）
  };
}

/** 箭头 mark 的 tip 端坐标（A→B 的 B 端）。 */
function arrowTip(mark: Mark): StrokePoint | null {
  const a = mark.scored.arrow;
  const pts = mark.event.stroke_points;
  if (!a || pts.length < 2) return null;
  return a.tip === 'end' ? pts[pts.length - 1] : pts[0];
}
function arrowTail(mark: Mark): StrokePoint | null {
  const a = mark.scored.arrow;
  const pts = mark.event.stroke_points;
  if (!a || pts.length < 2) return null;
  return a.tip === 'end' ? pts[0] : pts[pts.length - 1];
}

/**
 * 建标注图。marks 与 hmps 下标对齐（hmps[i] 可为 null=无 SurfaceIndex）。
 * marks 已按时间序（addMark 追加序）。所标文字在落笔当时已解析进 mark.markedText，本函数不碰 live index。
 */
export function buildMarkGraph(marks: Mark[], hmps: (HMP | null)[]): MarkGraph {
  const nodes = marks.map((m, i) => nodeOf(m, hmps[i] ?? null));
  const edges: MarkEdge[] = [];
  const surfaceIds = [...new Set(marks.map((m) => m.event.page_id))];

  // 时间边（相邻）+ 四象限
  for (let i = 1; i < marks.length; i++) {
    const prev = marks[i - 1], cur = marks[i];
    const gap = cur.t - prev.t;
    const dist = centerDist(prev.event.geometry.bbox, cur.event.geometry.bbox);
    edges.push({
      from: prev.id, to: cur.id, kind: 'temporal', rel: 'before',
      weight: clamp01(1 - gap / BURST_GAP_MS), quadrant: quadrantOf(gap, dist),
    });
  }

  // 空间边（所有对，恒算）：包含 > 邻近；同目标另记
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const a = marks[i], b = marks[j];
      const dist = centerDist(a.event.geometry.bbox, b.event.geometry.bbox);
      if (encloses(a, b.event.geometry.bbox) || encloses(b, a.event.geometry.bbox)) {
        edges.push({ from: a.id, to: b.id, kind: 'spatial', rel: 'containment', weight: 1 });
      } else if (dist < SPATIAL_NEAR) {
        edges.push({ from: a.id, to: b.id, kind: 'spatial', rel: 'proximity', weight: clamp01(1 - dist / SPATIAL_NEAR) });
      }
      const refsA = new Set(nodes[i].target_object_refs);
      if (nodes[j].target_object_refs.some((r) => refsA.has(r))) {
        edges.push({ from: a.id, to: b.id, kind: 'spatial', rel: 'same_target', weight: 0.8 });
      }
    }
  }

  // 语义边：箭头 A→B（连 tail/tip 最近的另一 mark）
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (m.event.event_type !== 'arrow' || !m.scored.arrow) continue;
    const tail = arrowTail(m), tip = arrowTip(m);
    if (!tail || !tip) continue;
    const tailBb: NormBBox = [tail.x, tail.y, 0, 0];
    const tipBb: NormBBox = [tip.x, tip.y, 0, 0];
    let from = -1, to = -1, dFrom = Infinity, dTo = Infinity;
    for (let k = 0; k < marks.length; k++) {
      if (k === i) continue;
      const df = centerDist(tailBb, marks[k].event.geometry.bbox);
      const dt = centerDist(tipBb, marks[k].event.geometry.bbox);
      if (df < dFrom) { dFrom = df; from = k; }
      if (dt < dTo) { dTo = dt; to = k; }
    }
    if (from >= 0 && to >= 0 && from !== to) {
      edges.push({ from: marks[from].id, to: marks[to].id, kind: 'semantic', rel: 'arrow', weight: 1, direction: 'a_to_b' });
    }
  }

  return { surface_ids: surfaceIds, nodes, edges, version: INFERVIEW_SCHEMA_VERSION };
}
