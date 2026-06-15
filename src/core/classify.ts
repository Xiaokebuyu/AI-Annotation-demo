import type { EventType, NormBBox, StrokePoint } from './contracts';
import { pageCss } from './transform';

export function bboxOf(points: StrokePoint[]): NormBBox {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export interface ScoredGesture {
  type: EventType;
  score: number; // 0–1：这笔画得有多像该模板（用于"画得像范例才算数"的门槛）
  /** 各模板的原始分数（用于诊断"为啥没识别成圈"）。 */
  raw?: { circle: number; underline: number; arrow: number };
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
  if (points.length <= 3 || diagPx < 8) return { type: 'tap_region', score: diagPx < 8 ? 0.7 : 0.5 };

  const first = points[0];
  const last = points[points.length - 1];
  const closure = Math.hypot((last.x - first.x) * dimW, (last.y - first.y) * dimH);
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot((points[i].x - points[i - 1].x) * dimW, (points[i].y - points[i - 1].y) * dimH);
  }
  // 圈：起止接近（闭合）+ 路径绕得够长
  const circleScore = clamp01((0.5 - closure / diagPx) / 0.5) * clamp01((len / diagPx - 1.0) / 1.3);
  // 直划线：扁 + 直（路径≈宽度）—— 阈值放宽，宽松接受"差不多线"
  const aspect = wPx / Math.max(hPx, 1);
  const straight = wPx / Math.max(len, 1);
  const underlineScore = clamp01((aspect - 2.2) / 4) * clamp01((straight - 0.55) / 0.35);

  // 箭头：开口（非闭合）+ 主干够直 + 末端有个 >~100° 急转（箭头钩）。
  let arrowScore = 0;
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
  }

  const raw = { circle: circleScore, underline: underlineScore, arrow: arrowScore };
  if (circleScore >= Math.max(underlineScore, arrowScore) && circleScore > 0.22) return { type: 'circle', score: circleScore, raw };
  if (arrowScore > 0.45 && arrowScore >= underlineScore) return { type: 'arrow', score: arrowScore, raw };
  if (underlineScore > 0.22) return { type: 'underline', score: underlineScore, raw };
  return { type: 'stroke', score: 0.15 + Math.max(circleScore, underlineScore, arrowScore) * 0.3, raw }; // 自由笔：低分
}

/** 几何启发式分类：tap_region / circle / underline / stroke */
export function classify(points: StrokePoint[], bb: NormBBox): EventType {
  return classifyScored(points, bb).type;
}

/**
 * 符号对话的「求解意图」启发式占位 —— 一次停笔会话里若有一个圈/点选 + 至少一个附加记号
 * （形如「圈住某处再写个问号」），就当作用户在发问。
 *
 * ⚠️ 这是占位级近似。真正「这个符号在问什么、圈住的到底是什么」属于语义识别，
 * 是本项目要突破的差异化，最终由 LLM 承载（providers/inference.ts 的 cloud 接缝）。
 * 前端只负责把候选意图标出来，不替 LLM 下结论。
 */
export function detectQueryIntent(types: EventType[]): boolean {
  if (types.length < 2) return false;
  const hasCircle = types.includes('circle');                  // 必须真的圈了东西
  const hasMark = types.some((t) => t === 'stroke');           // 旁边再加个潦草记号（问号/感叹号）
  return hasCircle && hasMark;                                 // tap 不再当问号—— tap 不进手势路径
}
