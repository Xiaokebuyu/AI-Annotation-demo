/**
 * 推理网关代理（Node 侧，仅 dev server 内运行）。
 *
 * 复用 Nodesign 的 NoDesk AI Gateway：
 *   POST {LLM_GATEWAY_URL}  (= …/default/passthrough)
 *   Authorization: Bearer {LLM_GATEWAY_KEY}     ← 网关只认 Bearer，不认 x-api-key
 *   body: 标准 Anthropic /v1/messages + 顶层注入 channel / channel_url
 *
 * channel 按 model 前缀自动路由（跟他们网关一致）：kimi-* → moonshot；其余 → DMXAPI。
 * 真实回答由此处的 model 产出；source_refs 由服务端从请求装配，**不让模型编造**（PRD 红线）。
 *
 * 这是 inference 的 provider 接缝实现之一；annotation 语义/文档解析最终归 B 组，
 * 这里先用现成网关把链路跑通。
 */

// 惰性读取：env 由 vite 插件在 configureServer 里注入 process.env，
// 晚于本模块 import 求值，所以不能在模块顶层捕获。
function cfg() {
  return {
    url: process.env.LLM_GATEWAY_URL || 'https://llm-gateway-api.nodesk.tech/default/passthrough',
    key: process.env.LLM_GATEWAY_KEY || '',
    model: process.env.LLM_MODEL || 'kimi-k2.6',
  };
}

function route(model: string): { channel: string; channel_url: string } {
  if (model.startsWith('kimi')) {
    return { channel: 'kimi', channel_url: 'https://api.moonshot.cn/anthropic/v1/messages' };
  }
  return { channel: 'DMX', channel_url: 'https://www.dmxapi.cn/v1/messages' };
}

/** 低层网关调用：传完整 messages（可带 tools），返回完整响应 data。 */
async function callGateway(opts: { system: string; messages: any[]; maxTokens: number; tools?: any[] }): Promise<any> {
  const { url, key, model } = cfg();
  if (!key) throw new Error('LLM_GATEWAY_KEY 未配置（在 annotation-loop-demo/.env 填网关 Key）');
  const { channel, channel_url } = route(model);
  const body: any = { model, max_tokens: opts.maxTokens, system: opts.system, messages: opts.messages, channel, channel_url };
  if (opts.tools) body.tools = opts.tools;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `网关返回 ${resp.status}`);
  return data;
}

const textOf = (data: any): string =>
  (data?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('').trim();

async function gateway(system: string, user: string, maxTokens: number, imageB64?: string): Promise<string> {
  const content = imageB64
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } }, { type: 'text', text: user }]
    : user;
  return textOf(await callGateway({ system, messages: [{ role: 'user', content }], maxTokens }));
}

type MemSnap = Array<{ index: number; summary: string | null; marks: Array<{ text: string; note: string }> }>;

/**
 * Tier2 按需 recall：给模型 recall_page 工具 + 前页索引，让它自己决定回看哪页综合作答。
 * 返回 { text, recalled }（recalled 供开发面板监控"AI 回看了哪些页"）。
 */
async function agentLoop(system: string, task: string, jsonRule: string, memory: MemSnap, imageB64?: string): Promise<{ text: string; recalled: number[] }> {
  const tools = [{
    name: 'recall_page',
    description: '回看某一页的标注与摘要，用于跨页综合',
    input_schema: { type: 'object', properties: { page: { type: 'integer', description: '页码，从 1 起' } }, required: ['page'] },
  }];
  const idx = memory.map((m) => `第${m.index + 1}页${m.summary ? '：' + m.summary : `（${m.marks.length}处标注）`}`).join('；');
  const firstText = `${task}\n\n可回看的前页：${idx}。若与当前内容相关，用 recall_page(页码) 取该页详情来综合；不需要就直接给最终答案。\n\n${jsonRule}`;
  const messages: any[] = [{
    role: 'user',
    content: imageB64
      ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } }, { type: 'text', text: firstText }]
      : firstText,
  }];
  const recalled: number[] = [];
  for (let turn = 0; turn < 3; turn++) {
    const data = await callGateway({ system, messages, maxTokens: 1024, tools });
    const blocks = data.content || [];
    const toolUses = blocks.filter((b: any) => b.type === 'tool_use');
    if (!toolUses.length) return { text: textOf(data), recalled };
    messages.push({ role: 'assistant', content: blocks });
    messages.push({
      role: 'user',
      content: toolUses.map((tu: any) => {
        const page = Number(tu.input?.page);
        recalled.push(page);
        const m = memory.find((x) => x.index === page - 1);
        const body = m
          ? `第${page}页：${m.summary || '(无摘要)'}\n${(m.marks || []).map((k) => `- "${k.text}" → ${k.note}`).join('\n')}`
          : `第${page}页没有标注记录。`;
        return { type: 'tool_result', tool_use_id: tu.id, content: body };
      }),
    });
  }
  const data = await callGateway({ system, messages: [...messages, { role: 'user', content: `直接给最终 JSON，不要再调用工具。${jsonRule}` }], maxTokens: 600 });
  return { text: textOf(data), recalled };
}

const SYM: Record<string, string> = {
  circle: '圈选', underline: '划线', highlight: '高亮', arrow: '箭头',
  margin_note: '批注', tap_region: '点选', stroke: '标记', eraser: '擦除', unknown: '标记',
};

function extractJson(text: string): any {
  if (!text) return {};
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { content: text };
  try { return JSON.parse(m[0]); } catch { return { content: text }; }
}

const rand = () => Math.random().toString(36).slice(2, 10);

/** 把一个 InferenceRequest 跑成 InferenceResult（contract 不变）。 */
export async function runInference(req: any): Promise<any> {
  const modes: string[] = req.output_modes || ['inspiration', 'question', 'connection'];
  const evt = req.annotation_event || {};
  const enclosed = (req.ocr_blocks || []).map((b: any) => b.text).join('') || '';
  const nearby = req.nearby_text || '';
  const et: string = evt.event_type;
  const isDigest = modes.includes('summary');
  const isAsk = modes.length === 1 && modes[0] === 'question';

  const system =
    '你是 InkLoop —— 嵌在 PDF 阅读器里的旁注式 AI 同读者。用户在原文上用符号（圈/划线/批注/点选）标注，' +
    '你依据符号含义与它圈住的上下文，轻声给一条简短中文旁注。不寒暄、不复述原文、不用 markdown 或列表、不超过 2 句，像页边批注点到为止。';

  let task: string;
  if (isDigest) {
    task = `用户停笔了。下面是 ta 在这一页留下的所有标注（每条含符号类型与圈住的文字）：\n${nearby || '（无可提取文字）'}\n请综合这些标注给一条整体性的洞察或提示——帮 ta 想深一层、点出背后的关键、或建议下一步。`;
  } else if (isAsk) {
    // 圈+问号 = 提问
    task = `用户圈了一处并加了记号，像在发问。圈住/附近的内容："${enclosed || nearby || '（未提取到文字）'}"。请针对它直接作答，不要反问。`;
  } else if (et === 'underline') {
    // 划线 = 重点
    task = `用户用划线标了重点："${enclosed || nearby || '（未提取到文字）'}"。请提炼这处的要点、点出它为什么重要——一句话。`;
  } else if (et === 'margin_note') {
    // 写字 = 批注（手写内容暂不可读，先用附近正文）
    task = `用户在页边写了一条批注（手写内容暂不可读）。批注落在这段正文附近："${nearby || enclosed || '（未提取到文字）'}"。请就这段正文给一条呼应 ta 思路的旁注。`;
  } else {
    // 圈 = 解释
    task = `用户圈出了一处："${enclosed || nearby || '（未提取到文字）'}"。请解释它是什么、关键在哪——像同读者在页边轻声点一句。`;
  }
  const jsonRule = `最终只输出一个 JSON 对象：{"result_type":"…","content":"…","confidence":0.x}。result_type 从这些里选最贴切的一个：${modes.join(' / ')}；content 是要显示的旁注文字；confidence 是 0–1 把握度。除该 JSON 外不要输出任何文字。`;

  // 局部截图（vlm/full 模式）随请求带来时，作为底图让模型看着原文现场作答（转写+图）
  const img = req.image ? String(req.image).replace(/^data:image\/[a-z]+;base64,/, '') : undefined;

  // Tier2：附带前页记忆快照时，走 recall 工具循环；否则单发
  const memory: MemSnap = Array.isArray(req.memory) ? req.memory : [];
  let raw: string;
  let recalled: number[] = [];
  if (memory.length) {
    const r = await agentLoop(system, task, jsonRule, memory, img);
    raw = r.text;
    recalled = r.recalled;
  } else {
    raw = await gateway(system, `${task}\n\n${jsonRule}`, isDigest ? 600 : 400, img);
  }
  const parsed = extractJson(raw);
  const result_type = modes.includes(parsed.result_type) ? parsed.result_type : modes[0];
  const content = String(parsed.content || raw || '此刻没能想清楚，稍后再为你低语。').trim();
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.8;

  const bbox = req.ocr_blocks?.[0]?.bbox || evt.geometry?.bbox || [0, 0, 0, 0];
  return {
    result_id: 'res_' + rand(),
    trace_id: req.trace_id,
    request_id: req.request_id,
    result_type,
    content,
    source_refs: [{
      page_id: evt.page_id,
      bbox,
      ocr_block_ids: (req.ocr_blocks || []).map((b: any) => b.id),
      event_id: req.event_id,
    }],
    confidence,
    created_at: new Date().toISOString(),
    model_name: cfg().model,
    model_version: 'nodesk-gateway',
    recalled, // 服务端额外字段：本次回看了哪些页（开发面板监控用）
  };
}

function extractJsonArray(text: string): any[] {
  if (!text) return [];
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a : []; } catch { return []; }
}

/**
 * 逐块精修（中间路线）：几何切好的块交模型清断词/纠类型/修阅读顺序，
 * **同一批 id 各用一次、不许合并拆分** —— 这样每块仍认得原页 bbox（前端按 id 贴回）。
 */
export async function runReflow(payload: any): Promise<any[]> {
  const blocks: any[] = payload?.blocks || [];
  if (!blocks.length) return [];
  const img = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : undefined;
  const list = blocks.map((b, i) => `${i + 1}. [${b.type}] (${b.id}) ${b.text}`).join('\n');
  const system = '你在精修一页 PDF 的文本块：纠正每块是标题还是正文、按正确阅读顺序排列、修断词与多余空格。只精修，不改写原意。';
  const rules =
    `输出一个 JSON 数组，每个元素 {"id":"…","type":"heading"|"para","level":1到3,"text":"…"}：\n` +
    `- 必须把每个 id 各用一次，不许合并、拆分、新增或丢弃；\n` +
    `- 按真实阅读顺序排列（多栏要对）；type/level 重新判定（para 的 level 给 0）；text 清掉断词与多余空格。\n` +
    `只输出该 JSON 数组，别的都不要。`;
  const user = img
    ? `这是该页的图，以及按几何切好的文本块（序号、粗类型、id、文字）：\n${list}\n\n看着图判断真实版面，${rules}`
    : `下面是按几何切好的文本块（序号、粗类型、id、文字）：\n${list}\n\n${rules}`;
  const raw = await gateway(system, user, 2500, img);
  const refined = extractJsonArray(raw);
  // 校验：只保留出现过的 id；模型漏掉的块前端会按原样补回
  const ids = new Set(blocks.map((b) => b.id));
  return refined.filter((r) => r && ids.has(r.id)).map((r) => ({
    id: r.id,
    type: r.type === 'heading' ? 'heading' : 'para',
    level: typeof r.level === 'number' ? r.level : 0,
    text: String(r.text || '').trim(),
  }));
}

/**
 * 局部截图 OCR：读一张从 PDF 裁出的标注区域图，原样转写其中文字（含手写）。
 * 只转写、不解释、不翻译——转写文字回前端填 OCRResult.text_blocks，喂推理 + 装 source_refs。
 */
export async function runOcrVlm(payload: any): Promise<{ text: string }> {
  const image = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : '';
  if (!image) return { text: '' };
  const system =
    '你是一个 OCR 转写器。输入是一张从 PDF 页面裁出的局部截图。' +
    '原样转写图中的文字（可能是印刷体或手写），按自然阅读顺序输出纯文本，多行用换行分隔。' +
    '不要解释、不要翻译、不要加任何说明或标点修饰。若图中没有可辨认的文字，输出空字符串。';
  const user = '转写这张截图里的文字：';
  const text = await gateway(system, user, 500, image);
  return { text: text.trim() };
}

/** 翻页总结：把一页的标注 + AI 回应压成一句备忘，供跨页综合。 */
export async function runSummarize(payload: any): Promise<{ summary: string }> {
  const marks: any[] = payload?.marks || [];
  if (!marks.length) return { summary: '' };
  const list = marks.map((m, i) => `${i + 1}. "${String(m.text || '').slice(0, 50)}"${m.note ? ` → ${m.note}` : ''}`).join('\n');
  const system = '你在为一页阅读做一句话备忘：读者在这页关注/追问了什么、形成了什么想法。';
  const user = `这页的标注与 AI 回应：\n${list}\n\n用一句中文概括读者在这页的关注线索（≤40 字），只输出这句话，别的不要。`;
  const raw = await gateway(system, user, 120);
  return { summary: raw.trim() };
}
