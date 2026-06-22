import type { EventType, MarkShape, NormBBox, StrokePoint } from '../core/contracts';
import { pageCss } from '../core/transform';

export function bboxOf(points: StrokePoint[]): NormBBox {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** CSS px ≈ 1/96 inch → 每物理毫米的 CSS px。用屏幕物理尺度判"点按 vs 刻意手势"，缩放无关
 *  （借鉴 xournalpp：tap 用 mm 而非页面比例；len/diagPx 已是 CSS px，故可直接换算）。 */
const PX_PER_MM = 96 / 25.4; // ≈ 3.78

export interface ScoredGesture {
  type: EventType;
  score: number; // 0–1：这笔画得有多像该模板（用于"画得像范例才算数"的门槛）
  /** 各模板的原始分数（用于诊断"为啥没识别成圈"）。 */
  raw?: { circle: number; underline: number; arrow: number };
  /** 箭头方向：急转(箭头钩)在弧长 atFrac 处 → tip=该端；用于 mark-graph 的 A→B 语义边。 */
  arrow?: { atFrac: number; tip: 'start' | 'end' };
}

/**
 * 几何启发式分类 + 置信度。score 表示笔迹与模板的接近度：
 * 干净的圈/直线/点 → 高分；随手涂、半截笔画 → 低分（自由笔 stroke 基本判不出模板）。
 * dimW/dimH = 归一化坐标的换算基准（默认页面 pageCss；重排面传 reader 画布尺寸）。
 */
export function classifyScored(
  points: StrokePoint[],
  bb: NormBBox,
  dimW: number = pageCss.w,
  dimH: number = pageCss.h,
): ScoredGesture {
  const wPx = bb[2] * dimW;
  const hPx = bb[3] * dimH;
  const diagPx = Math.hypot(wPx, hPx);

  // 总行程（笔走过的总路程）+ 时长 —— 判"点按/误触 vs 刻意手势"的主信号。
  const first = points[0];
  const last = points[points.length - 1];
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot((points[i].x - points[i - 1].x) * dimW, (points[i].y - points[i - 1].y) * dimH);
  }
  const closure = first && last ? Math.hypot((last.x - first.x) * dimW, (last.y - first.y) * dimH) : 0;
  const dur = last ? last.t : 0;

  // 落点/误触判定（物理屏幕尺度，缩放无关）。手抖会把 bbox 撑过几像素，但走过的总路程骗不了人——
  // 刻意手势在屏幕上至少走 ~3.5mm；点按/抖动远小于。又短(<140ms)又走不远的轻触一并归为 tap。
  // tap_region 会被 isDeliberate 滤掉，不进推理路径（v1 词表无"点选触发"）。
  const travelFloor = 3.5 * PX_PER_MM; // ≈ 13 CSS px
  if (points.length <= 3 || len < travelFloor || (dur < 140 && len < 6 * PX_PER_MM)) {
    return { type: 'tap_region', score: 0.7 };
  }
  // 圈：起止接近（闭合）+ 路径绕得够长
  const circleScore = clamp01((0.5 - closure / diagPx) / 0.5) * clamp01((len / diagPx - 1.0) / 1.3);
  // 直划线：扁 + 直（路径≈宽度）—— 阈值放宽，宽松接受"差不多线"
  const aspect = wPx / Math.max(hPx, 1);
  const straight = wPx / Math.max(len, 1);
  const underlineScore = clamp01((aspect - 2.2) / 4) * clamp01((straight - 0.55) / 0.35);

  // 箭头：开口（非闭合）+ 主干够直 + 末端有个 >~100° 急转（箭头钩）。
  let arrowScore = 0;
  let arrowAtFrac = 0; // 急转(箭头钩)所在弧长比例 → 推 tip 端（A→B 方向）
  if (closure > 0.5 * diagPx && points.length >= 6) {
    let sharpest = 0, atFrac = 0, acc = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const v1x = points[i].x - points[i - 1].x, v1y = points[i].y - points[i - 1].y;
      const v2x = points[i + 1].x - points[i].x, v2y = points[i + 1].y - points[i].y;
      let dA = Math.abs(Math.atan2(v2y, v2x) - Math.atan2(v1y, v1x));
      if (dA > Math.PI) dA = 2 * Math.PI - dA;                         // 0..PI
      acc += Math.hypot((points[i].x - points[i - 1].x) * dimW, (points[i].y - points[i - 1].y) * dimH);
      if (dA > sharpest) { sharpest = dA; atFrac = acc / len; }
    }
    const sharp = clamp01((sharpest - 1.75) / (Math.PI - 1.75)); // 转角 >~100°
    const nearEnd = atFrac > 0.68 || atFrac < 0.32 ? 1 : 0;      // 急转靠近某一端
    const shaft = clamp01((closure / len - 0.45) / 0.4);         // 主干直度
    arrowScore = sharp * nearEnd * shaft;
    arrowAtFrac = atFrac;
  }

  // 最小尺寸闸：屏幕上小于 ~3mm 的"圈/划"框不住任何词，多半是原地小抖 → 降为自由笔（低分）。
  const tooSmall = diagPx < 3 * PX_PER_MM;
  const raw = { circle: circleScore, underline: underlineScore, arrow: arrowScore };
  if (!tooSmall && circleScore >= Math.max(underlineScore, arrowScore) && circleScore > 0.22) return { type: 'circle', score: circleScore, raw };
  if (!tooSmall && arrowScore > 0.45 && arrowScore >= underlineScore) return { type: 'arrow', score: arrowScore, raw, arrow: { atFrac: arrowAtFrac, tip: arrowAtFrac > 0.5 ? 'end' : 'start' } };
  if (!tooSmall && underlineScore > 0.22) return { type: 'underline', score: underlineScore, raw };
  return { type: 'stroke', score: 0.15 + Math.max(circleScore, underlineScore, arrowScore) * 0.3, raw }; // 自由笔：低分
}

/** 几何启发式分类：tap_region / circle / underline / stroke */
export function classify(points: StrokePoint[], bb: NormBBox): EventType {
  return classifyScored(points, bb).type;
}

/**
 * EventType → 徐智强 MarkShape 词汇映射（step③→step④ 桥接）。
 * 不改冻结的 EventType 词表（trace/持久化都记了它）；只在产出 HMP 时翻译成徐智强的动作词汇。
 * cross/sketch 当前分类器未产出，留位待真机手势补全。
 */
export function markShapeOf(type: EventType, score = 1): MarkShape {
  switch (type) {
    case 'circle': return 'enclosure';
    case 'underline': return 'underline';
    case 'arrow': return 'arrow';
    case 'highlight': return 'highlight';
    case 'margin_note': return 'handwriting';
    case 'stroke': return score >= 0.3 ? 'handwriting' : 'unknown';
    default: return 'unknown'; // tap_region / eraser / unknown
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 笔迹特征型分类器（level-1，确定性、便宜、端侧友好）—— 两段成本阶梯：
 *   ① markup（圈/划/箭头）有干净几何模板 → 纯几何判定，准、零识别调用。
 *   ② freeform（非模板）：几何**只做 OCR 门**——筛掉明显不是字的（单笔/近直线/太小=破折号/勾/点）
 *      记 drawing 直接放过；其余（多笔 或 单笔够复杂）标 ocrWorthy，交 captureMark 调云端识别**定型**
 *      （"手写 vs 画"无干净几何模板，最终由识别裁判 —— 故门要保守、偏向送 OCR，别漏真手写）。
 *   level-2 端侧小分类器最终替掉②的云端识别；本函数是它的接缝。
 * ────────────────────────────────────────────────────────────────────────── */

export type MarkFeatureType = 'markup' | 'handwriting' | 'drawing';

export interface StrokeFeature {
  type: MarkFeatureType;
  confidence: number;
  scaleRatio: number;     // mark 高 ÷ 局部正文字高（无标尺时 NaN）
  raw: { strokeCount: number; templateScore: number; templateType: EventType; scaleRatio: number; complexity: number; ocrWorthy: boolean; tplSpan: number };
}

/** 路径复杂度 = 笔走过的总路程 ÷ bbox 对角线。近直线≈1；折返多的字/涂≈>1.6。 */
function pathComplexity(points: StrokePoint[], bbox: NormBBox, dimW: number, dimH: number): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot((points[i].x - points[i - 1].x) * dimW, (points[i].y - points[i - 1].y) * dimH);
  }
  const diag = Math.hypot(bbox[2] * dimW, bbox[3] * dimH);
  return diag > 1 ? len / diag : 0;
}

export function classifyStrokeFeature(
  perStroke: ScoredGesture[],
  strokeBboxes: NormBBox[],
  points: StrokePoint[],
  bbox: NormBBox,
  localCharH: number,
  dimW: number = pageCss.w,
  dimH: number = pageCss.h,
): StrokeFeature {
  const strokeCount = perStroke.length;
  // 取每笔里最强的模板笔（圈/划/箭头）+ 记下是哪一笔（要看它的尺寸）；tap/stroke 不算模板。
  let tplType: EventType = 'stroke';
  let tplScore = 0;
  let tplIdx = -1;
  for (let i = 0; i < perStroke.length; i++) {
    const s = perStroke[i];
    if ((s.type === 'circle' || s.type === 'underline' || s.type === 'arrow') && s.score > tplScore) {
      tplScore = s.score; tplType = s.type; tplIdx = i;
    }
  }
  const scaleRatio = localCharH > 0 ? bbox[3] / localCharH : NaN;
  const complexity = pathComplexity(points, bbox, dimW, dimH);
  // **自相对**尺寸闸：模板笔的长边占整个 mark 长边的比例。
  //  真圈/划本身就是整个 mark（占比≈1）；手写里的一个"横/口"只占整团字的一小块（占比小）。
  //  自相对 → 不依赖字号，页边大字手写也不会被误判成 markup。
  const tplBb = tplIdx >= 0 ? strokeBboxes[tplIdx] : null;
  const tplSpan = tplBb ? Math.max(tplBb[2], tplBb[3]) : 0;
  const markLong = Math.max(bbox[2], bbox[3]) || 1e-6;
  const spanRatio = tplSpan / markLong;
  const raw = { strokeCount, templateScore: tplScore, templateType: tplType, scaleRatio, complexity, ocrWorthy: false, tplSpan };

  // ① 圈/划/箭头模板 **且这笔占满了整个 mark（它就是那个手势）** → markup（纯几何）。
  //    自相对闸是关键：否则中文字里的"横"(=underline 1.0)/"口"(=circle) 会把整段手写误判成 markup。
  if (tplScore >= 0.45 && spanRatio >= 0.6) {
    return { type: 'markup', confidence: tplScore, scaleRatio, raw };
  }
  // ② freeform：保守 OCR 门——非太小 且 (多笔 或 单笔够复杂) → 值得送识别定型；否则散笔/线条，记 drawing。
  const diagPx = Math.hypot(bbox[2] * dimW, bbox[3] * dimH);
  const tooTiny = diagPx < 3 * PX_PER_MM; // ~11px：点/勾
  raw.ocrWorthy = !tooTiny && (strokeCount >= 2 || complexity > 1.6);
  return { type: 'drawing', confidence: 0, scaleRatio, raw };
}
