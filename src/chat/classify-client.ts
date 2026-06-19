/**
 * 上下文分类器客户端（v3）：手写触发时判 respond / fold。
 * 带与主模型同源的上下文（inference-view 的 narrative + marked + 对话历史）。
 * 这是与主推理独立的第二次模型调用；网络/解析出错一律默认 respond（漏答真问题更贵）。
 */
import type { InferenceView } from '../core/contracts';
import type { ChatMsg } from './buffer';
import { settings } from '../app/state';

export async function classifyContext(
  view: InferenceView,
  conversation: ChatMsg[],
): Promise<{ respond: boolean; reason: string }> {
  try {
    const r = await fetch('/api/classify-context', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: view.question || view.marked,
        view_narrative: view.narrative,
        marked: view.marked,
        conversation: conversation.map((m) => ({ role: m.role, content: m.content })),
        model: settings.inferModel,
      }),
    });
    if (!r.ok) return { respond: true, reason: 'classifier http error' };
    const j = await r.json() as { respond?: boolean; reason?: string };
    return { respond: j?.respond !== false, reason: String(j?.reason || '') };
  } catch {
    return { respond: true, reason: 'classifier unreachable' };
  }
}
