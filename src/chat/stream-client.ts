import { appendMsg, bookMessages } from './buffer';
import { postNdjson } from '../core/api';

/** 一轮聊天的产物：回复正文 text + 思考过程 thinking（仅 Claude 返回，其余为空）。 */
export interface ChatTurnResult { text: string; thinking: string; }

/**
 * 一轮网页对话式聊天（流式）：把新 user 消息入每本书 buffer，整串 messages POST /api/chat，
 * 读 NDJSON 帧（{k:'t'|'r',d}）分流——t=回复正文(onDelta)、r=思考过程(onThinking)，收尾把 assistant 正文回写 buffer。
 * **思考过程不进 buffer**（不作后续上下文、避免重发/滚雪球），只随本轮产物返回、由账本/调试页消费。
 * 服务端无状态——连贯全靠这串 messages（替代退役的 Agent SDK 会话）。
 */
export async function chatTurn(
  bookId: string,
  userContent: string,
  opts: { role: string; model: string; maxTokens?: number; onDelta?: (full: string) => void; onThinking?: (full: string) => void; signal?: AbortSignal; images?: Array<{ data: string }> },
): Promise<ChatTurnResult> {
  appendMsg(bookId, { role: 'user', content: userContent }); // 历史只存文字：图不进 buffer（避免每轮重发/滚雪球）
  const messages: Array<{ role: string; content: unknown }> = bookMessages(bookId).map((m) => ({ role: m.role, content: m.content as unknown }));
  // 仅本轮：若带图（被判需图片识别的内容），把最后一条 user 消息换成 [图块…, 文字]
  if (opts.images?.length) {
    const blocks = opts.images.map((im) => {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(im.data);
      return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : null;
    }).filter(Boolean);
    if (blocks.length) messages[messages.length - 1] = { role: 'user', content: [...blocks, { type: 'text', text: userContent }] };
  }
  let text = '', thinking = '';
  // NDJSON 帧 {k:'t'|'r',d} 分流——t=正文(onDelta)、r=思考(onThinking)。分帧/容错/收尾在 postNdjson 内。
  await postNdjson<{ k?: string; d?: string }>(
    '/api/chat',
    { messages, role: opts.role, model: opts.model, maxTokens: opts.maxTokens ?? 500 },
    (ev) => {
      if (ev.k === 'r') { thinking += ev.d ?? ''; opts.onThinking?.(thinking); }
      else { text += ev.d ?? ''; opts.onDelta?.(text); }
    },
    { signal: opts.signal },
  );
  text = text.trim(); thinking = thinking.trim();
  appendMsg(bookId, { role: 'assistant', content: text });
  return { text, thinking };
}
