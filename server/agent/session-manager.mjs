/**
 * per-book 会话管理器:一本书 = 一个长驻 query({prompt: AsyncQueue}) 会话。
 * 每个标注 = 一轮 turn(push 合成图+焦点文字),模型记得本书之前的标注 → 跨标注连贯。
 * 挂在现有 vite 中间件里即可(SDK 自己 spawn 子进程,会话 Map 放模块级)。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getOrStartProxy } from './gateway-proxy.mjs';
import { AsyncQueue, userTurn } from './async-queue.mjs';

const PERSONA =
  '你是 InkLoop —— 嵌在 PDF 阅读器里的旁注式 AI 同读者。读者在原文上用圈/划/箭头/手写做标注，' +
  '你看标注的合成截图(墨迹叠在原文上)、结合整页文字与你记得的本书前文，轻声给一条简短中文旁注。' +
  '严格依据本页文字与所给图作答——**不要臆造未在原文出现的具体事实**(年份、地名、人名、数字等);拿不准就说不确定，宁可点到为止也不编。' +
  '不寒暄、不复述原文、不用 markdown 或列表、不超过 2 句，像页边批注点到为止。' +
  '每条标注只输出一个 JSON 对象:{"result_type":"...","content":"旁注","confidence":0.x}，此外不要任何文字。';

const TONE = {
  underline: '这是划线/重点:提炼要点、点出它为何重要。',
  arrow: '这是箭头/关联:点出它指向什么、和什么相关。',
  margin_note: '这是手写批注:先读出 ta 写了什么，再就内容与所标段落给呼应。',
  circle: '这是圈选:解释被圈的是什么、关键在哪。',
};

const sessions = new Map(); // bookId → session

function extractJson(text) {
  if (!text) return {};
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { content: text };
  try { return JSON.parse(m[0]); } catch { return { content: text }; }
}

async function ensureSession(bookId, cfg) {
  const existing = sessions.get(bookId);
  if (existing && !existing.closed) return existing;

  // 一本书一个会话:单用户单文档,开新会话前关掉其它(避免旧子进程/会话长期堆积)
  for (const [id, other] of sessions) {
    if (id !== bookId && !other.closed) { try { other.inputQueue.close(); } catch { /* */ } sessions.delete(id); }
  }

  const proxy = await getOrStartProxy({ gatewayUrl: cfg.gatewayUrl, realModel: cfg.realModel });
  const sessionId = `inkloop-${bookId}`;
  const baseUrlForBinary = `${proxy.baseUrl}/__nd/${encodeURIComponent(sessionId)}`;
  const inputQueue = new AsyncQueue();
  const s = { inputQueue, pending: [], curText: '', closed: false, bookId };
  s.ready = new Promise((resolve) => { s._resolveReady = resolve; }); // SDK 'init' 到达(子进程就绪)即 resolve
  sessions.set(bookId, s);

  const stream = query({
    prompt: inputQueue,
    options: {
      model: 'claude-opus-4-7[1m]',
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      settingSources: [],
      systemPrompt: PERSONA,
      env: { ...process.env, ANTHROPIC_BASE_URL: baseUrlForBinary, ANTHROPIC_API_KEY: cfg.key },
    },
  });

  // 消费循环:每个 result 结束一轮 → FIFO 解析对应 pending(SDK 串行处理 turn,顺序对齐)
  s.consumer = (async () => {
    try {
      for await (const msg of stream) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          s._resolveReady?.(); // 子进程就绪 → 预热完成
        } else if (msg.type === 'assistant') {
          const t = (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          if (t) s.curText += t;
        } else if (msg.type === 'result') {
          const p = s.pending.shift();
          if (p) p.resolve({ text: s.curText.trim(), subtype: msg.subtype, cost: msg.total_cost_usd, ms: Date.now() - p.t0 });
          s.curText = '';
        }
      }
    } catch (e) {
      s.pending.splice(0).forEach((p) => p.reject(e));
    } finally {
      s.closed = true;
      s._resolveReady?.(); // 别让 open 的等待挂死
      s.pending.splice(0).forEach((p) => p.reject(new Error('session closed')));
    }
  })();

  return s;
}

/** 把一条标注拼成一轮 turn 的 content(合成图 + 焦点文字 + 整页语境)。 */
function buildTurnContent({ pageText, focus, gestureType, image }) {
  const tone = TONE[gestureType] || '就用户标注处给一条旁注。';
  const text =
    `这一页全文（语境）：\n${(pageText || '').slice(0, 2500)}\n\n` +
    `附图是我刚在原文上画的标注（墨迹叠在字上）。几何粗判焦点约在：「${focus || '未定位'}」（以图为准）。\n` +
    `① 看图确认我标注的形状、以及圈/划/指向/写了哪些字（手写就读出来）；② ${tone} 一句中文旁注。`;
  const content = [];
  if (image) {
    const b64 = String(image).replace(/^data:image\/[a-z]+;base64,/, '');
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } });
  }
  content.push({ type: 'text', text });
  return content;
}

/** 跑一轮标注 → 返回 InkLoop 形态的结果。bookId 内的会话长驻、记得前文。 */
export async function runAgentTurn(bookId, ann, cfg) {
  const s = await ensureSession(bookId, cfg);
  const content = buildTurnContent(ann);
  const res = await new Promise((resolve, reject) => {
    s.pending.push({ resolve, reject, t0: Date.now() });
    s.inputQueue.push(userTurn(content));
  });
  const parsed = extractJson(res.text);
  const modes = Array.isArray(ann.modes) ? ann.modes : [];
  return {
    result_type: modes.includes(parsed.result_type) ? parsed.result_type : (modes[0] || 'inspiration'),
    content: String(parsed.content || res.text || '此刻没能想清楚，稍后再为你低语。').trim(),
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
    _meta: { ms: res.ms, cost: res.cost, subtype: res.subtype },
  };
}

/** 纯文本跟进轮(测试连贯 / 未来"追问"用):不带图,直接 push 一句到会话。 */
export async function runRawTurn(bookId, text, cfg) {
  const s = await ensureSession(bookId, cfg);
  const res = await new Promise((resolve, reject) => {
    s.pending.push({ resolve, reject, t0: Date.now() });
    s.inputQueue.push(userTurn(text));
  });
  return { content: res.text, _meta: { ms: res.ms, cost: res.cost } };
}

export function closeAgentSession(bookId) {
  const s = sessions.get(bookId);
  if (s) { try { s.inputQueue.close(); } catch { /* */ } sessions.delete(bookId); }
}

export function agentSessionStats() {
  return [...sessions.entries()].map(([id, s]) => ({ bookId: id, closed: s.closed, pending: s.pending.length }));
}

// ── HTTP 端点封装(vite 中间件挂载用;cfg 从 env 取,key 不出服务端) ──
function cfgFromEnv() {
  return { gatewayUrl: process.env.LLM_GATEWAY_URL, key: process.env.LLM_GATEWAY_KEY, realModel: process.env.LLM_MODEL || 'kimi-k2.6' };
}

/** POST /api/agent/turn —— 跑一轮标注。 */
export async function agentTurnEndpoint(body) {
  const { bookId, gestureType, pageText, focus, image, modes } = body || {};
  if (!bookId) throw new Error('bookId required');
  return runAgentTurn(bookId, { gestureType, pageText, focus, image, modes }, cfgFromEnv());
}

/** POST /api/agent/open —— 开书预热:起会话 + spawn 子进程,消掉首笔 ~14s 冷启。 */
export async function agentOpenEndpoint(body) {
  if (!body?.bookId) throw new Error('bookId required');
  const s = await ensureSession(body.bookId, cfgFromEnv());
  // 等子进程 'init' 就绪(spawn 完),让开书后的首笔标注变成热轮;超时兜底不挂死
  await Promise.race([s.ready, new Promise((r) => setTimeout(r, 20000))]);
  return { ok: true, warmed: body.bookId };
}

/** POST /api/agent/close —— 关书结束会话。 */
export function agentCloseEndpoint(body) {
  closeAgentSession(body?.bookId);
  return { ok: true };
}
