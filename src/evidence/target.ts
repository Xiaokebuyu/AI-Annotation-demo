/**
 * 徐智强「序列语义方案」step④ —— 空间索引找 target → 产出 HMP 取证记录。
 *
 *   wrapSurfaceIndex —— step①：把已有结构（PDF 文本层/重排块/图像区）包成带 type 的 SurfaceIndex。
 *   resolveTarget    —— step④：用笔迹几何命中 SurfaceObject（包围优先，退而求相交）。
 *   buildHmp         —— 把命中结果组装成 HMP（同步，纯几何）；text_hint/crop_ref/vector_ref 由
 *                       调用方在 step⑤OCR / step⑥手写识别异步回来后补填。
 *
 * 命中逻辑复用 focus.ts 的射线法（pointInPolygon），不重造已验证的"圈住了什么"。
 */
import type {
  AnnotationEvent, HMP, HmpMode, HmpObjectHint, MarkShape, NormBBox,
  OcrTextBlock, SurfaceIndex, SurfaceObject, SurfaceObjectType,
} from '../core/contracts';
import { HMP_SCHEMA_VERSION } from '../core/contracts';
import { pointInPolygon } from './focus';
import { shortId } from '../core/ids';

const byReadingOrder = (a: SurfaceObject, b: SurfaceObject): number =>
  (a.bbox[1] - b.bbox[1]) || (a.bbox[0] - b.bbox[0]);

/** mark bbox 与对象 bbox 的重叠面积 ÷ 对象面积（对象常比 mark 大，用对象面积当分母更稳）。 */
function overlapRatio(mark: NormBBox, obj: NormBBox): number {
  const ix = Math.max(0, Math.min(mark[0] + mark[2], obj[0] + obj[2]) - Math.max(mark[0], obj[0]));
  const iy = Math.max(0, Math.min(mark[1] + mark[3], obj[1] + obj[3]) - Math.max(mark[1], obj[1]));
  return (ix * iy) / Math.max(obj[2] * obj[3], 1e-9);
}

const median = (xs: number[]): number => xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : 0;

/**
 * 局部正文字高（归一化）——笔迹特征分类器的"免费标尺"。
 * 取页内文字对象 bbox 高度的中位数；无文字对象返回 0（分类器据此退化、降置信）。
 */
export function localCharHeight(index: SurfaceIndex | null): number {
  if (!index) return 0;
  const hs = index.objects.filter((o) => o.type === 'title' || o.type === 'text_block').map((o) => o.bbox[3]);
  return median(hs);
}

/**
 * step①（PDF 路径）：用文本层 + 图像区构建**字母级** typed SurfaceIndex。
 * 把每个文本 run 按字符均分宽度拆成逐字对象——对象比任何标记都小，圈/划就能精确命中具体字（粒度=单字）。
 *  · 中日韩等宽字体：均分极准；西文比例字体：近似（够用，focus 仍能拼回 run）。
 *  · 字号大于中位数 1.4× 的 run → 其字标 title，余者 text_block；纯空白字符跳过（命中无意义）。
 *  · imageRegions → image（无字，逼 step⑤ OCR）。
 */
export function wrapSurfaceIndex(
  pageId: string,
  pageIndex: number,
  textBlocks: OcrTextBlock[],
  imageRegions: NormBBox[],
): SurfaceIndex {
  const objects: SurfaceObject[] = [];
  const runs = textBlocks.filter((tb) => tb.text && tb.text.trim());
  const medH = median(runs.map((r) => r.bbox[3])) || 0.012;

  for (const run of runs) {
    const chars = [...run.text]; // 按码点拆，兼容代理对
    const n = chars.length;
    if (!n) continue;
    const charW = run.bbox[2] / n;
    const type: SurfaceObjectType = run.bbox[3] > medH * 1.4 ? 'title' : 'text_block';
    chars.forEach((ch, i) => {
      if (!ch.trim()) return; // 跳过纯空白字符
      objects.push({
        id: `${run.id}_${i}`,
        type,
        bbox: [run.bbox[0] + i * charW, run.bbox[1], charW, run.bbox[3]],
        text: ch,
        source: 'structure',
      });
    });
  }

  imageRegions.forEach((bbox, i) => {
    objects.push({ id: `img_${pageIndex}_${i}`, type: 'image', bbox, role: 'embedded_image', source: 'structure' });
  });

  return { surface_id: pageId, surface_type: 'article', page_index: pageIndex, objects };
}

/**
 * step④：找 target。优先级——①包围（对象中心落在任一笔迹闭合多边形内，最强信号，复用射线法）
 * → ②相交（mark bbox 扩 pad 后与对象 bbox 重叠面积占比过阈值）。都不中返回空（→ HMP mode=unknown，
 * 交给 step⑤ OCR 兜底）。命中结果按阅读序排列。
 */
export function resolveTarget(
  events: AnnotationEvent[],
  markBbox: NormBBox,
  index: SurfaceIndex,
  pad = 0.02,
  overlapThreshold = 0.25,
): SurfaceObject[] {
  // ① 包围
  const enclosed = index.objects.filter((o) => {
    const cx = o.bbox[0] + o.bbox[2] / 2, cy = o.bbox[1] + o.bbox[3] / 2;
    return events.some((e) => pointInPolygon(cx, cy, e.stroke_points));
  });
  if (enclosed.length) return enclosed.sort(byReadingOrder);

  // ② 相交
  const [mx, my, mw, mh] = markBbox;
  const expanded: NormBBox = [mx - pad, my - pad, mw + 2 * pad, mh + 2 * pad];
  return index.objects.filter((o) => overlapRatio(expanded, o.bbox) > overlapThreshold).sort(byReadingOrder);
}

function objectHintOf(objs: SurfaceObject[]): HmpObjectHint {
  if (!objs.length) return 'unknown';
  // 命中里有内容对象就以内容为准（mixed 时不被 blank 盖过）
  const top = objs.find((o) => o.type !== 'blank_region') ?? objs[0];
  switch (top.type) {
    case 'title':
    case 'text_block': return 'text';
    case 'image': return top.role === 'diagram' ? 'diagram' : 'image_region';
    case 'chat_message': return 'ui_region';
    case 'blank_region': return 'blank';
    default: return 'unknown';
  }
}

/**
 * step④ 末：组装 HMP。同步、纯几何。mode 判定（忠实徐智强）：
 *   命中非空白对象 → anchored；只命中 blank_region → self_content；混合 → mixed；
 *   无命中 → 手写/草图是"在空白里自己写画"(step⑥) 记 self_content，其余记 unknown（待 OCR 兜底）。
 */
export function buildHmp(opts: {
  surfaceId: string;
  action: MarkShape;
  targetBbox: NormBBox;
  targetObjects: SurfaceObject[];
  textHint?: string;
  cropRef?: string;
  vectorRef?: string;
  confidence?: number;
}): HMP {
  const { targetObjects: objs, action } = opts;
  const hasBlank = objs.some((o) => o.type === 'blank_region');
  const hasContent = objs.some((o) => o.type !== 'blank_region');

  let mode: HmpMode;
  if (objs.length === 0) mode = (action === 'handwriting' || action === 'sketch') ? 'self_content' : 'unknown';
  else if (hasBlank && !hasContent) mode = 'self_content';
  else if (hasBlank && hasContent) mode = 'mixed';
  else mode = 'anchored';

  const object_hint: HmpObjectHint = objs.length
    ? objectHintOf(objs)
    : (mode === 'self_content' ? 'blank' : 'unknown');

  const topSource = objs[0]?.source;
  const confidence = opts.confidence ?? (
    mode === 'anchored' ? (topSource === 'structure' || topSource === 'reflow' ? 0.9 : 0.7)
      : mode === 'mixed' ? 0.7
        : mode === 'self_content' ? 0.6
          : 0.3
  );

  return {
    hmp_id: shortId('hmp'),
    surface_id: opts.surfaceId,
    mode,
    action,
    target_region: opts.targetBbox,
    target_object_refs: objs.map((o) => o.id),
    object_hint,
    text_hint: opts.textHint,
    crop_ref: opts.cropRef,
    vector_ref: opts.vectorRef,
    confidence,
    version: HMP_SCHEMA_VERSION,
  };
}
