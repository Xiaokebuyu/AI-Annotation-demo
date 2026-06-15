/**
 * v1 手势集 —— 给「低成本语义序列」的几何 token 赋含义（符号 = 意图）。
 *
 * 纯几何、0 OCR：手势的「种类」只看笔迹轨迹（classify），不看像素。
 * 「圈住了什么字」由文本层给（数字版 PDF 免 OCR）；只有「读手写内容」才要 OCR（B 组）。
 *
 * 一次停笔会话 → 一个手势意图。canonical eventType 写进 representative event，
 * 服务端据此框定回应语气（output_modes 约束 result_type）。
 */
import type { AnnotationEvent, EventType, OutputMode } from './contracts';
import { classifyScored, detectQueryIntent } from './classify';

/** 形状门槛：低于此分的单笔自由涂抹不算手势（不触发 AI），笔迹仍无损留着。 */
export const GESTURE_MIN_SCORE = 0.3;

/**
 * 这次停笔到底算不算"刻意的手势"——决定生成与否（"不抢笔"原则：宁漏不滥）。
 * 刻意 = 有一笔画得够像范例（圈/划/箭头分数 ≥ 门槛）。
 *
 * tap_region 不算手势 —— v1 词表里没有"点选触发"；它是 contract 里的合法 event，
 * 但只进 trace、不进推理路径（未来若做"轻触卡片/段落"再走单独通道）。
 * 单笔/多笔潦草 stroke 也不算 —— 改由 VLM 视觉路径（settings.gesture.routing='vlm'）兜底，
 * 不再用"≥2 笔自由"这种粗暴规则把任何涂鸦都当批注。
 */
export function isDeliberate(events: AnnotationEvent[]): boolean {
  if (!events.length) return false;
  return events.some((e) => {
    if (e.event_type === 'tap_region') return false; // tap 永远不算手势
    return classifyScored(e.stroke_points, e.geometry.bbox).score >= GESTURE_MIN_SCORE;
  });
}

export type GestureKind = 'explain' | 'emphasize' | 'ask' | 'note' | 'relate';

/** 用户意图（「为什么写」）—— 决定下游推理怎么响应。 */
export type Intent = 'what_is_this' | 'key_point' | 'question' | 'relation' | 'free_note' | 'command';

export interface Gesture {
  kind: GestureKind;
  label: string;          // 调试/trace 用
  eventType: EventType;   // 写进 representative event；服务端按它框定语气
  intent: Intent;         // 用户意图（为什么写）
  output_modes: OutputMode[];
}

export const GESTURES: Record<GestureKind, Gesture> = {
  explain:   { kind: 'explain',   label: '圈·解释',      eventType: 'circle',      intent: 'what_is_this', output_modes: ['inspiration'] },
  emphasize: { kind: 'emphasize', label: '划线·重点',    eventType: 'underline',   intent: 'key_point',    output_modes: ['inspiration'] },
  ask:       { kind: 'ask',       label: '圈+问号·提问', eventType: 'circle',      intent: 'question',     output_modes: ['question'] },
  relate:    { kind: 'relate',    label: '箭头·关联',    eventType: 'arrow',       intent: 'relation',     output_modes: ['connection'] },
  note:      { kind: 'note',      label: '写字·批注',    eventType: 'margin_note', intent: 'free_note',    output_modes: ['inspiration'] },
};

/** intent → output_modes（VLM 解读手写意图后用它改写推理语气）。 */
export const INTENT_MODES: Record<Intent, OutputMode[]> = {
  what_is_this: ['inspiration'],
  key_point: ['inspiration'],
  question: ['question'],
  relation: ['connection'],
  free_note: ['inspiration'],
  command: ['action'],
};

/** 把一次停笔会话解析成手势意图（纯几何）。tap_region 已被 isDeliberate 过滤，不会到这。 */
export function resolveGesture(events: AnnotationEvent[]): Gesture {
  const types = events.map((e) => e.event_type);
  // 圈 + 额外记号（停笔会话内多了一笔小记号，像问号）→ 提问
  if (detectQueryIntent(types)) return GESTURES.ask;
  if (types.includes('arrow')) return GESTURES.relate; // 箭头 → 关联
  if (types.includes('underline')) return GESTURES.emphasize;
  if (types.includes('circle')) return GESTURES.explain;
  // 全是 stroke（潦草笔但有一笔过门槛）：由 VLM 视觉路径承担"是写字还是抽象符号"的判定；
  // 几何路径下，保守地当批注。如果想要更精准识别，切 routing='vlm'。
  return GESTURES.note;
}
