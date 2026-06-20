/**
 * 标注会话累积器（v3 三速一脊·采集侧）。
 *
 * 单位重定义：stroke → 1.2s 组装成一个 mark；mark 按**本书**累积成一段 session（可跨页）。
 *   连续标注期间界面静默；离开静默只有两个口子（main.ts 接线）：
 *     · 长停顿 idle(~1–2min) → 对整段 session 综合回复
 *     · 手写 mark 即时进上下文分类器 → 判 respond 才定向回答（唯一边界事件）
 * 翻页不提交、不清空（"翻页不是边界事件"）；换书 / 改设置才丢 session。
 *
 * 本模块只管数据与累积；计时/触发在 main.ts，建图在 evidence/mark-graph.ts。
 */
import type { AnnotationEvent, HMP } from '../core/contracts';
import type { ScoredGesture, StrokeFeature } from './classify';

/** 1.2s 笔迹组装窗（沿用旧 SESSION_WINDOW，产一个 mark）。 */
export const ASSEMBLY_WINDOW = 1200;
/** burst 间隔：相邻 mark 间隔 < 此值算同一段连续动作（~8–15s，dev 可调）。 */
export const BURST_GAP_MS = 12_000;
/** 长停顿提交阈值：~1–2min 无新 mark → 综合回复（dev 可调）。 */
export const IDLE_COMMIT_MS = 90_000;

/** 一个 mark = 1.2s 组装出的一次手势（多笔合并的代表 event + 特征 + 几何分 + 落笔当时的取证）。 */
export interface Mark {
  id: string;            // = 代表 event 的 event_id
  event: AnnotationEvent; // 代表 event（union bbox + 合并笔点）
  feature: StrokeFeature; // markup / handwriting / drawing
  scored: ScoredGesture;  // 中性几何形状（+ 箭头方向）
  t: number;             // 组装时刻 performance.now() ms
  hmp: HMP | null;        // 落笔当时建好+取证（含 crop/转写）；跨页 session 不能在提交时重取
  markedText: string;     // 落笔当时解析好的"所标内容"（结构原文+转写）
}

/** 一段会话 = 本书自上次回复以来累积的 mark（可跨页）。 */
export interface Session {
  bookId: string;
  marks: Mark[];
  startedAt: number;
  lastMarkAt: number;
}

const sessions = new Map<string, Session>();

/** 取（或新建）本书的当前 session。 */
export function getSession(bookId: string): Session {
  let s = sessions.get(bookId);
  if (!s) {
    s = { bookId, marks: [], startedAt: performance.now(), lastMarkAt: 0 };
    sessions.set(bookId, s);
  }
  return s;
}

/** 只读窥视（不新建）：无累积返回 null。 */
export function peekSession(bookId: string): Session | null {
  const s = sessions.get(bookId);
  return s && s.marks.length ? s : null;
}

/** 把一个 mark 追加进本书 session，返回更新后的 session。 */
export function addMark(bookId: string, mark: Mark): Session {
  const s = getSession(bookId);
  s.marks.push(mark);
  s.lastMarkAt = mark.t;
  return s;
}

/** 提交后清空本书 session（下一批 mark 起一段新 session）。 */
export function clearSession(bookId: string): void {
  sessions.delete(bookId);
}

/** 从 session 移除一个 mark（擦除/撤销一笔时，别让它再进下次综合）。 */
export function removeMark(bookId: string, markId: string): void {
  const s = sessions.get(bookId);
  if (!s) return;
  s.marks = s.marks.filter((m) => m.id !== markId);
}

/** 打包一个 mark（纯组装；代表 event 与 HMP/markedText 由调用方先算好）。 */
export function makeMark(
  event: AnnotationEvent,
  feature: StrokeFeature,
  scored: ScoredGesture,
  hmp: HMP | null,
  markedText: string,
): Mark {
  return { id: event.event_id, event, feature, scored, t: performance.now(), hmp, markedText };
}

/** 按时间间隔把 session 的 mark 切成多段 burst（间隔 > BURST_GAP_MS 断开）。 */
export function sessionBursts(session: Session, gapMs = BURST_GAP_MS): Mark[][] {
  const bursts: Mark[][] = [];
  let cur: Mark[] = [];
  for (const m of session.marks) {
    if (cur.length && m.t - cur[cur.length - 1].t > gapMs) { bursts.push(cur); cur = []; }
    cur.push(m);
  }
  if (cur.length) bursts.push(cur);
  return bursts;
}
