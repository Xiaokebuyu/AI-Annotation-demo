import { appendMsg, bookMessages } from './buffer';

/**
 * 一轮网页对话式聊天（流式）：把新 user 消息入每本书 buffer，整串 messages POST /api/chat，
 * 逐段读 text/plain 增量、回调 onDelta(累计全文)，收尾把 assistant 全文回写 buffer。
 * 服务端无状态——连贯全靠这串 messages（替代退役的 Agent SDK 会话 + memorySnapshot）。
 */
export async function chatTurn(
  bookId: string,
  userContent: string,
  opts: { system: string; model: string; maxTokens?: number; onDelta?: (full: string) => void; signal?: AbortSignal; images?: Array<{ data: string }> },
): Promise<string> {
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
  const resp = await fetch('/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: opts.signal,
    body: JSON.stringify({ messages, system: opts.system, model: opts.model, maxTokens: opts.maxTokens ?? 500 }),
  });
  if (!resp.ok || !resp.body) throw new Error(`/api/chat ${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    full += dec.decode(value, { stream: true });
    opts.onDelta?.(full);
  }
  full = full.trim();
  appendMsg(bookId, { role: 'assistant', content: full });
  return full;
}
