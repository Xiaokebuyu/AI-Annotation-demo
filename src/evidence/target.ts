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
import { makeSurfaceIndex } from '../core/surface-index';
import type {
  AnnotationEvent, CaptureSurface, HMP, HmpMode, HmpObjectHint, MarkShape, NormBBox, StrokeCoordSpace,
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

  return makeSurfaceIndex(pageId, 'article', objects, pageIndex);
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_EXPAND_MAX = 4; // CJK 命中扩展上限——连续正文没有天然词边界，防止无限扩到整段

/** wrapSurfaceIndex 产出的字母级对象 id 形如 `${run.id}_${charIdx}`；解不出的返回 null。 */
function charRef(id: string): { run: string; idx: number } | null {
  const p = id.lastIndexOf('_');
  if (p <= 0) return null;
  const idx = Number(id.slice(p + 1));
  return Number.isFinite(idx) ? { run: id.slice(0, p), idx } : null;
}

/**
 * 字符级命中 → 词/短语扩展：以命中字符所在 run 为单位，向两侧按"是否文字字符"扩展到词边界
 * （圈住"钻石扣针"的"针"字，应该扩成整个词，而不是只留一个字）。
 * CJK 命中限制最多扩 4 字；非 CJK（拉丁文等有天然空白分词）跟到标点/空白为止，不设上限。
 * 只对字母级对象生效，其余命中（图片/整块文字等无 charRef 的）原样放行。
 */
function expandTextTargets(hits: SurfaceObject[], index: SurfaceIndex): SurfaceObject[] {
  const textHits = hits.filter((o) => o.text && charRef(o.id));
  if (!textHits.length) return hits;

  const selected = new Map(hits.map((o) => [o.id, o] as const));
  const byRun = new Map<string, Array<{ obj: SurfaceObject; idx: number }>>();
  for (const o of index.objects) {
    if (!o.text) continue;
    const r = charRef(o.id);
    if (!r) continue;
    const arr = byRun.get(r.run) ?? [];
    arr.push({ obj: o, idx: r.idx });
    byRun.set(r.run, arr);
  }
  for (const arr of byRun.values()) arr.sort((a, b) => a.idx - b.idx);

  const runs = new Set(textHits.map((o) => charRef(o.id)!.run));
  for (const run of runs) {
    const chars = byRun.get(run);
    if (!chars?.length) continue;
    const hitIds = new Set(textHits.filter((o) => charRef(o.id)!.run === run).map((o) => o.id));
    const pos = chars.map((c, i) => (hitIds.has(c.obj.id) ? i : -1)).filter((i) => i >= 0);
    if (!pos.length) continue;
    let lo = Math.min(...pos), hi = Math.max(...pos);
    const hasCjk = chars.slice(lo, hi + 1).some((c) => CJK_RE.test(c.obj.text || ''));
    const maxLen = hasCjk ? CJK_EXPAND_MAX : Number.POSITIVE_INFINITY;
    while (lo > 0 && WORD_CHAR_RE.test(chars[lo - 1].obj.text || '') && hi - lo + 1 < maxLen) lo--;
    while (hi + 1 < chars.length && WORD_CHAR_RE.test(chars[hi + 1].obj.text || '') && hi - lo + 1 < maxLen) hi++;
    for (let i = lo; i <= hi; i++) selected.set(chars[i].obj.id, chars[i].obj);
  }
  return [...selected.values()].sort(byReadingOrder);
}

/**
 * step④：找 target。优先级——①包围（对象中心落在任一笔迹闭合多边形内，最强信号，复用射线法，
 * **仅对真正闭合的圈生效**——箭头/下划线是开放曲线，笔迹路径末端的收笔勾偶尔会意外围出小闭环，
 * 若对所有形状一视同仁做包围判定，会被这类意外闭环命中 1-2 个字符就直接短路返回，
 * 走不到下面更合理的 bbox 相交判定）→ ②相交（mark bbox 扩 pad 后与对象 bbox 重叠面积占比过阈值，
 * 命中字符对象后扩展到词/短语边界）。都不中返回空（→ HMP mode=unknown，交给 step⑤ OCR 兜底）。
 * 命中结果按阅读序排列。
 */
export function resolveTarget(
  events: AnnotationEvent[],
  markBbox: NormBBox,
  index: SurfaceIndex,
  pad = 0.02,
  overlapThreshold = 0.25,
  action?: MarkShape,
): SurfaceObject[] {
  // ① 包围（仅 enclosure）
  if (action === 'enclosure') {
    const enclosed = index.objects.filter((o) => {
      const cx = o.bbox[0] + o.bbox[2] / 2, cy = o.bbox[1] + o.bbox[3] / 2;
      return events.some((e) => pointInPolygon(cx, cy, e.stroke_points));
    });
    if (enclosed.length) return enclosed.sort(byReadingOrder);
  }

  // ② 相交 + 词/短语扩展
  const [mx, my, mw, mh] = markBbox;
  const expanded: NormBBox = [mx - pad, my - pad, mw + 2 * pad, mh + 2 * pad];
  const hits = index.objects.filter((o) => overlapRatio(expanded, o.bbox) > overlapThreshold).sort(byReadingOrder);
  return expandTextTargets(hits, index);
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
  captureSurface?: CaptureSurface;
  coordSpace?: StrokeCoordSpace;
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

  // 真锚定到内容（anchored）时不需要图像兜底；其余情况（self_content/mixed/unknown，即没能锚到
  // 明确内容）保留调用方传入的墨迹图，供下游 crop 组装兜底当证据送模型（原逻辑按 markup/非 markup
  // 二元判断，漏了"markup 但只圈住空白"这类实际是 self_content 的场景，改按算出的 mode 判断）。
  const vector_ref = mode === 'anchored' ? undefined : opts.vectorRef;

  return {
    hmp_id: shortId('hmp'),
    surface_id: opts.surfaceId,
    capture_surface: opts.captureSurface,
    coord_space: opts.coordSpace,
    mode,
    action,
    target_region: opts.targetBbox,
    target_object_refs: objs.map((o) => o.id),
    object_hint,
    text_hint: opts.textHint,
    crop_ref: opts.cropRef,
    vector_ref,
    confidence,
    version: HMP_SCHEMA_VERSION,
  };
}
