/**
 * 上下文分类器客户端（v3）：手写触发时判 respond / fold。
 * 带与主模型同源的上下文（inference-view 的 narrative + marked + 对话历史）。
 * 这是与主推理独立的第二次模型调用；网络/解析出错一律默认 respond（漏答真问题更贵）。
 */
import type { InferenceView } from '../core/contracts';
import type { ChatMsg } from './buffer';
import { settings } from '../app/state';
import { postJson } from '../core/api';

/** 上下文分类器选「端侧规则」的哨兵值（dev）：respond/fold 由 intent-rules.ts 驱动、不调云。 */
export const LOCAL_RULES = '__local_rules__';

export async function classifyContext(
  view: InferenceView,
  conversation: ChatMsg[],
): Promise<{ respond: boolean; reason: string }> {
  try {
    const j = await postJson<{ respond?: boolean; reason?: string }>('/api/classify-context', {
      question: view.question || view.marked,
      view_narrative: view.narrative,
      marked: view.marked,
      conversation: conversation.map((m) => ({ role: m.role, content: m.content })),
      model: (settings.classifyModel && settings.classifyModel !== LOCAL_RULES) ? settings.classifyModel : settings.inferModel,
    });
    return { respond: j?.respond !== false, reason: String(j?.reason || '') };
  } catch {
    return { respond: true, reason: 'classifier unreachable' };
  }
}
