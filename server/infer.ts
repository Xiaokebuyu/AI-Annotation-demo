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
async function callGateway(opts: { system: string; messages: any[]; maxTokens: number; tools?: any[]; model?: string }): Promise<any> {
  const { url, key } = cfg();
  const model = opts.model || cfg().model; // 模型可由调用方覆盖(dev 面板选的)，route() 按前缀分渠道
  if (!key) throw new Error('LLM_GATEWAY_KEY 未配置（在 annotation-loop-demo/.env 填网关 Key）');
  const { channel, channel_url } = route(model);
  // gemini 适配：Gemini 2.5/3 flash 默认开思考、思考 token 计入 max_tokens，低预算→空响应。给足余量。
  const max_tokens = model.startsWith('gemini') ? Math.max(opts.maxTokens, 2048) : opts.maxTokens;
  const body: any = { model, max_tokens, system: opts.system, messages: opts.messages, channel, channel_url };
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

/**
 * 流式网关调用：以 SSE(stream:true) 拉取，逐段 yield 文字增量(text_delta)。
 * 网关若不支持流式(返回 application/json) → 退化为一次性读出全文再 yield 一次，
 * 调用方逻辑不变(只是不再是增量)。供 reflowAiStream 做"按段流式重排"。
 */
async function* gatewayTextStream(opts: { system: string; messages: any[]; maxTokens: number; model?: string }): AsyncGenerator<string> {
  const { url, key } = cfg();
  const model = opts.model || cfg().model;
  if (!key) throw new Error('LLM_GATEWAY_KEY 未配置（在 annotation-loop-demo/.env 填网关 Key）');
  const { channel, channel_url } = route(model);
  const max_tokens = model.startsWith('gemini') ? Math.max(opts.maxTokens, 2048) : opts.maxTokens;
  const body: any = { model, max_tokens, system: opts.system, messages: opts.messages, channel, channel_url, stream: true };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  const ct = resp.headers.get('content-type') || '';
  if (!resp.ok || !resp.body || !ct.includes('event-stream')) {
    // 网关没给 SSE（不支持流式/报错）→ 一次性读出，yield 一次（仍正确，只是不增量）
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data?.error?.message || `网关返回 ${resp.status}`);
    yield textOf(data);
    return;
  }
  const reader = (resp.body as any).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const ev = JSON.parse(payload);
        const t = ev?.delta?.text ?? (ev?.delta?.type === 'text_delta' ? ev.delta.text : undefined);
        if (typeof t === 'string' && t) yield t;
      } catch { /* 非 JSON 的 SSE 行（注释/心跳）跳过 */ }
    }
  }
}

const textOf = (data: any): string =>
  (data?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('').trim();

type ImgIn = { role?: string; data: string };

// 多图角色标签：每张图前插一段文字说明它是什么，按名（笔迹图/合成图）引用，不依赖张数/编号。
const ROLE_LABEL: Record<string, string> = {
  ink: '【笔迹图·用户手写已从原文单独抽出、铺白底，识别手写就看这张】',
  composite: '【合成图·墨迹叠在原文上，判断画在哪、圈/划住了什么就看这张】',
  // page(原文层)已弃用——原文以整页文字 page_text 为准，不再单独发图
};

/** 把图列表（带可选角色）转成 content 块：每张前插一段角色标签文字，再插图。 */
function imageBlocks(images: ImgIn[]): any[] {
  const out: any[] = [];
  for (const im of images) {
    const raw = String(im?.data || '');
    const data = raw.replace(/^data:image\/[a-z]+;base64,/, '');
    if (!data) continue;
    const mt = /^data:(image\/[a-z]+);base64,/.exec(raw);
    const media_type = mt ? mt[1] : 'image/png'; // 透传 jpeg/png（grabLayers 原文/合成发 jpeg 省体积）
    const label = im.role ? ROLE_LABEL[im.role] : '';
    if (label) out.push({ type: 'text', text: label });
    out.push({ type: 'image', source: { type: 'base64', media_type, data } });
  }
  return out;
}

/** 单发：images 可为多图(带角色)数组，或单张已 strip 的 b64 字符串(旧调用方)。图在前、文字在后。 */
async function gateway(system: string, user: string, maxTokens: number, image?: string | ImgIn[], model?: string): Promise<string> {
  const blocks = Array.isArray(image)
    ? imageBlocks(image)
    : (image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }] : []);
  const content = blocks.length ? [...blocks, { type: 'text', text: user }] : user;
  return textOf(await callGateway({ system, messages: [{ role: 'user', content }], maxTokens, model }));
}

type MemSnap = Array<{ index: number; content?: string | null; summary: string | null; marks: Array<{ text: string; note: string }> }>;

/**
 * Tier2 按需 recall：给模型 recall_page 工具 + 前页索引，让它自己决定回看哪页综合作答。
 * 返回 { text, recalled }（recalled 供开发面板监控"AI 回看了哪些页"）。
 */
async function agentLoop(system: string, task: string, jsonRule: string, memory: MemSnap, images?: ImgIn[], model?: string): Promise<{ text: string; recalled: number[] }> {
  const tools = [{
    name: 'recall_page',
    description: '回看某一页的标注与摘要，用于跨页综合',
    input_schema: { type: 'object', properties: { page: { type: 'integer', description: '页码，从 1 起' } }, required: ['page'] },
  }];
  // 优先用内容解读（记忆A，预处理产出），其次行为摘要（记忆B）
  const idx = memory.map((m) => `第${m.index + 1}页${m.content ? '：' + m.content : m.summary ? '：' + m.summary : `（${m.marks.length}处标注）`}`).join('；');
  const firstText = `${task}\n\n可回看的前页：${idx}。若与当前内容相关，用 recall_page(页码) 取该页详情来综合；不需要就直接给最终答案。\n\n${jsonRule}`;
  const firstBlocks = images && images.length ? imageBlocks(images) : [];
  const messages: any[] = [{
    role: 'user',
    content: firstBlocks.length ? [...firstBlocks, { type: 'text', text: firstText }] : firstText,
  }];
  const recalled: number[] = [];
  for (let turn = 0; turn < 3; turn++) {
    const data = await callGateway({ system, messages, maxTokens: 1024, tools, model });
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
          ? `第${page}页：${m.content || m.summary || '(无摘要)'}\n${(m.marks || []).map((k) => `- "${k.text}" → ${k.note}`).join('\n')}`
          : `第${page}页没有标注记录。`;
        return { type: 'tool_result', tool_use_id: tu.id, content: body };
      }),
    });
  }
  const data = await callGateway({ system, messages: [...messages, { role: 'user', content: `直接给最终 JSON，不要再调用工具。${jsonRule}` }], maxTokens: 600, model });
  return { text: textOf(data), recalled };
}

const SYM: Record<string, string> = {
  circle: '圈选', underline: '划线', highlight: '高亮', arrow: '箭头',
  margin_note: '批注', tap_region: '点选', stroke: '标记', eraser: '擦除', unknown: '标记',
};

// 回应语气：由「为什么画」(intent) 主导，几何形状(event_type)兜底——提问/指令/综合不被当普通解释。
const TONE_BY_TYPE: Record<string, string> = {
  circle: '这是圈选：解释被圈的是什么、关键在哪。',
  underline: '这是划线/重点：提炼要点、点出它为何重要。',
  highlight: '这是高亮/重点：提炼这处的要点、点出它为何重要。',
  arrow: '这是箭头/关联：点出它指向什么、和什么相关。',
  margin_note: '这是手写批注：先读出 ta 写了什么，再就 ta 写的内容与所标段落给呼应。',
};
function toneFor(eventType: string, intent: string, modes: string[]): string {
  if (intent === 'question') return '用户像在发问：针对所标处直接作答，不要反问。';
  if (intent === 'command') return '用户写的是一条指令（如总结/翻译/改写）：直接执行 ta 的要求、作用在所标段落上，给结果而非评论。';
  if (intent === 'summary' || (Array.isArray(modes) && modes.includes('summary'))) return '用户在这一处留了多个标注：综合它们给一条整体性的洞察或提示，帮 ta 想深一层。';
  return TONE_BY_TYPE[eventType] || '就用户标注处给一条旁注。';
}

function extractJson(text: string): any {
  if (!text) return {};
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { content: text };
  try { return JSON.parse(m[0]); } catch { /* 内部半角引号破坏 JSON（Claude 常见）→ 正则抽字段兜底 */ }
  const b = m[0];
  const rt = b.match(/"result_type"\s*:\s*"([^"]*)"/);
  const cf = b.match(/"confidence"\s*:\s*([0-9.]+)/);
  const cm = b.match(/"content"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"confidence"|\}\s*$)/);
  if (!cm && !rt) return { content: text };
  return { result_type: rt ? rt[1] : undefined, content: cm ? cm[1] : text, confidence: cf ? Number(cf[1]) : undefined };
}

const rand = () => Math.random().toString(36).slice(2, 10);

/** 把一个 InferenceRequest 跑成 InferenceResult（contract 不变）。 */
export async function runInference(req: any): Promise<any> {
  const modes: string[] = req.output_modes || ['inspiration', 'question', 'connection'];
  const evt = req.annotation_event || {};
  const enclosed = (req.ocr_blocks || []).map((b: any) => b.text).join('') || '';
  const nearby = req.nearby_text || '';
  const et: string = evt.event_type;
  const intent = String(req.intent || ''); // 「为什么画」——主导回应语气（提问/指令/综合/解释）
  const isDigest = modes.includes('summary');
  const isAsk = modes.length === 1 && modes[0] === 'question';

  const system =
    '你是 InkLoop —— 嵌在 PDF 阅读器里的旁注式 AI 同读者。用户在原文上用符号（圈/划线/批注/点选）标注，' +
    '你依据符号含义与它圈住的上下文，轻声给一条简短中文旁注。不寒暄、不复述原文、不用 markdown 或列表、不超过 2 句，像页边批注点到为止。';

  // 推理底图：多图(笔迹/原文/合成，同取景)优先；兼容旧的单图 req.image。让模型看着现场作答。
  const imagesIn: ImgIn[] = Array.isArray(req.images)
    ? req.images.filter((i: any) => i && i.data)
    : (req.image ? [{ role: 'composite', data: String(req.image) }] : []);
  const hasImg = imagesIn.length > 0;
  const model = req.model || cfg().model; // dev 面板选的模型(kimi/claude/gemini)，route() 按前缀分渠道
  const pageTextIn = String(req.page_text || '').slice(0, 4000); // P1：整页文字作恒定上下文
  const focus = String(req.focus || nearby || '').trim();        // P1：几何焦点提示

  let task: string;
  if (hasImg && pageTextIn) {
    // P1 统一视觉路径：整页文字作上下文 + 合成图(墨迹叠原文) + 焦点提示，一次看图判完。
    // 形状 / 圈中什么 / 手写读出 / 意图 全交模型，不再靠前端 bbox-文本匹配（治"答非所问"）。
    const tone = toneFor(et, intent, modes);
    const hasInk = imagesIn.some((i) => i.role === 'ink');
    // 话术随实际附图自适应：手写发笔迹图+合成图，非手写只发合成图（省 vision token / 延迟）。
    const imgDesc = hasInk
      ? `上面附了笔迹图（用户手写已从原文抽出、铺白底）与合成图（墨迹叠在原文上）。原文以上面整页文字为准。`
      : `上面附了一张合成图（墨迹叠在原文上，看画在哪、圈住了什么）。原文以上面整页文字为准。`;
    const step1 = hasInk
      ? `请：① 先看笔迹图把手写文字逐字读出来；再看合成图确认标注形状、以及圈/划/指向落在全文哪一处（对照上面整页文字）；`
      : `请：① 看合成图确认标注形状、以及圈/划/指向落在全文哪一处（对照上面整页文字）；`;
    task =
      `这一页的全文（供你理解语境）：\n${pageTextIn}\n\n` +
      `${imgDesc}` +
      `几何粗判焦点约在：「${focus || '（未定位）'}」（仅供参考，以图为准）。\n` +
      `${step1}` +
      `② ${tone} 一句中文旁注，点到为止。`;
  } else if (isDigest) {
    task = `用户停笔了。下面是 ta 在这一页留下的所有标注（每条含符号类型与圈住的文字）：\n${nearby || '（无可提取文字）'}\n请综合这些标注给一条整体性的洞察或提示——帮 ta 想深一层、点出背后的关键、或建议下一步。`;
  } else if (isAsk) {
    // 圈+问号 = 提问
    task = `用户圈了一处并加了记号，像在发问。圈住/附近的内容："${enclosed || nearby || '（未提取到文字）'}"。请针对它直接作答，不要反问。`;
  } else if (et === 'underline') {
    // 划线 = 重点
    task = `用户用划线标了重点："${enclosed || nearby || '（未提取到文字）'}"。请提炼这处的要点、点出它为什么重要——一句话。`;
  } else if (et === 'arrow') {
    // 箭头 = 关联/导向
    task = `用户画了个箭头，像在标"导向/因果/关联"。箭头附近或指向的内容："${enclosed || nearby || '（未提取到文字）'}"。请点出它和什么相关、指向什么结论或下一步——一句话。`;
  } else if (et === 'margin_note') {
    // 写字 = 批注（手写内容暂不可读，先用附近正文）
    task = `用户在页边写了一条批注（手写内容暂不可读）。批注落在这段正文附近："${nearby || enclosed || '（未提取到文字）'}"。请就这段正文给一条呼应 ta 思路的旁注。`;
  } else {
    // 圈 = 解释
    task = `用户圈出了一处："${enclosed || nearby || '（未提取到文字）'}"。请解释它是什么、关键在哪——像同读者在页边轻声点一句。`;
  }
  const jsonRule = `最终只输出一个 JSON 对象：{"result_type":"…","content":"…","confidence":0.x}。result_type 从这些里选最贴切的一个：${modes.join(' / ')}；content 是要显示的旁注文字（内部若引用原文用「」括，勿用半角双引号，否则破坏 JSON）；confidence 是 0–1 把握度。除该 JSON 外不要输出任何文字。`;

  // Tier2：附带前页记忆快照时，走 recall 工具循环；否则单发
  const memory: MemSnap = Array.isArray(req.memory) ? req.memory : [];
  let raw: string;
  let recalled: number[] = [];
  if (memory.length) {
    const r = await agentLoop(system, task, jsonRule, memory, imagesIn, model);
    raw = r.text;
    recalled = r.recalled;
  } else {
    raw = await gateway(system, `${task}\n\n${jsonRule}`, isDigest ? 600 : 400, imagesIn, model);
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
    model_name: model,
    model_version: 'nodesk-gateway',
    recalled, // 服务端额外字段：本次回看了哪些页（开发面板监控用）
    // 上下文监控（proxy 级附加，不动冻结契约）：暴露模型真正看到的 system + 任务 + 上下文
    _debug: {
      model,
      system,
      task,
      enclosed,
      nearby,
      focus,
      page_text_len: pageTextIn.length,
      ocr_block_count: (req.ocr_blocks || []).length,
      has_image: hasImg,
      image_roles: imagesIn.map((i) => i.role || 'image'),
      mode: (hasImg && pageTextIn) ? 'p1-vision' : 'legacy',
      tier: memory.length ? 'tier2-recall' : 'single',
      memory_pages: memory.map((m) => ({ index: m.index, content: m.content ?? null, summary: m.summary, marks: m.marks.length })),
    },
  };
}

/**
 * 视觉手势判定（VLM 路径）：替代几何阈值，让模型看用户笔迹截图一气判定
 *   kind:   circle / underline / arrow / handwriting / abstract / nothing
 *   intent: what_is_this / key_point / question / relation / free_note / command
 *   reading: 若是写字，转写出来
 * 用于 settings.gesture.routing='vlm' 时——给"任意符号语言"和"抽象绘画"以可识别性。
 */
export async function runInterpretGesture(payload: any): Promise<{ kind: string; intent: string; reading: string; confidence: number }> {
  const image = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : '';
  if (!image) return { kind: 'nothing', intent: 'free_note', reading: '', confidence: 0 };
  const system =
    '这是用户在 PDF 页面上的笔迹截图（黑色墨水线条）。一次性判定三件事：' +
    '①kind（笔迹形状）：circle（圈选）/ underline（划线/高亮）/ arrow（箭头·关联指向）/ handwriting（手写文字）/ abstract（其它符号，如星号、波浪线、问号、感叹号、自定义符号）/ nothing（潦草无意图、单点）。' +
    '②intent（为什么画）：what_is_this（圈一处问含义）/ key_point（标重点）/ question（在提问）/ relation（指出关联）/ free_note（自由批注）/ command（在下指令，如"总结"/"翻译"）。' +
    '③reading：若 kind=handwriting，原样转写其中文字；否则空字符串。' +
    '只输出一个 JSON：{"kind":"...","intent":"...","reading":"...","confidence":0.x}。除该 JSON 外不要任何文字。' +
    '如果看不出明确意图（很可能只是用户走神涂了一笔），kind="nothing"，让系统不打扰用户。';
  const raw = await gateway(system, '判定这笔笔迹：', 400, image, payload?.model); // 手写视觉随 inferModel 走（kimi/gemini A/B）
  const j = extractJson(raw);
  const KINDS = ['circle', 'underline', 'arrow', 'handwriting', 'abstract', 'nothing'];
  const INTENTS = ['what_is_this', 'key_point', 'question', 'relation', 'free_note', 'command'];
  return {
    kind: KINDS.includes(j.kind) ? j.kind : 'nothing',
    intent: INTENTS.includes(j.intent) ? j.intent : 'free_note',
    reading: String(j.reading || '').trim(),
    confidence: typeof j.confidence === 'number' ? j.confidence : 0.6,
  };
}

/**
 * 意图理解：读用户在页边的手写批注截图 —— ①转写手写文字 ②判断「为什么写」。
 * 几何手势（圈/划/箭头）的意图已知；手写靠这条 VLM 解读补上（Phase C）。
 */
export async function runInterpret(payload: any): Promise<{ reading: string; intent: string }> {
  const image = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : '';
  if (!image) return { reading: '', intent: 'free_note' };
  const system =
    '这是用户在文档页边手写的批注截图。做两件事：' +
    '①原样转写其中的手写文字；②判断用户意图，从这四个里选最贴切的一个：' +
    'question（在提问）、command（在下指令，如"总结这段"/"翻译"）、relation（在指出关联）、free_note（只是记想法）。' +
    '只输出一个 JSON：{"reading":"转写的文字","intent":"question|command|relation|free_note"}。除该 JSON 外不要任何文字。';
  const raw = await gateway(system, '转写这段手写并判断意图：', 300, image, payload?.model); // 手写转写随 inferModel 走（kimi/gemini A/B）
  const j = extractJson(raw);
  const intent = ['question', 'command', 'relation', 'free_note'].includes(j.intent) ? j.intent : 'free_note';
  return { reading: String(j.reading || '').trim(), intent };
}

/** 内容解读（记忆A）：把一页文字压成一两句「这页在讲什么」，预处理流水线调用。 */
export async function runDigest(payload: any): Promise<{ digest: string }> {
  const text = String(payload?.text || '').slice(0, 4000);
  if (!text) return { digest: '' };
  const system = '你在为一页文档做「内容解读」：用一两句中文概括这页在讲什么、核心论点或关键信息。不寒暄、不复述原文、不用 markdown、不超过 2 句。';
  const user = `这一页的文字：\n${text}\n\n给出这页的内容解读：`;
  const out = await gateway(system, user, 200);
  return { digest: out.trim() };
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

/** 默认重排模型：结构分类任务、对延迟敏感、质量要求低 → 用快模型。dev 面板/payload 可覆盖。 */
const REFLOW_MODEL = 'gemini-3.1-flash-lite';

/**
 * 重排提示词（流式/非流式共用）。输出改为 **NDJSON**——一行一个语义块对象，
 * 便于服务端边收边解析、客户端按段流式渲染（治"等整页排完才显示"的延迟）。
 */
function buildReflowAiPrompt(lines: any[]): { system: string; user: string } {
  const list = lines.map((l) => `${l.id}\t[${l.sizeRatio ?? 1}x] ${String(l.text || '').slice(0, 200)}`).join('\n');
  const system = '你在重建一页 PDF 的文档结构。下面是按阅读顺序的"行"，每行有 id、相对字号(1=正文)、文字。把这些行分组成干净的语义块：heading(标题,带 level)、para(正文段落)、list(列表)。靠内容与字号判断——标题通常字号偏大且独立成行；连续正文要按语义切成多个 para，**绝不能因为行距均匀就把多段并成一段**；项目符号/编号行归 list。';
  const rules =
    `逐行输出 NDJSON——**一行一个独立 JSON 对象**，每行就是一个语义块，按阅读顺序排：\n` +
    `{"type":"heading"|"para"|"list","level":1到3(仅heading需要),"lineIds":["ln_x",...]}\n` +
    `- 每个行 id 必须恰好出现一次，不丢、不重、不新增；\n` +
    `- 不要改写、翻译或新增任何文字——你只做分组与分类；\n` +
    `- 一行一个 JSON 对象，**不要包成数组、不要加 \`\`\` 代码块、不要任何额外解释或编号**。`;
  return { system, user: `${list}\n\n${rules}` };
}

/** 把模型吐的一行解析成合法分组（校验 lineIds 都在本页行内）；非分组行返回 null。 */
function parseGroupLine(line: string, valid: Set<unknown>): { type: string; level: number; lineIds: string[] } | null {
  if (!line || line[0] !== '{') return null; // 代码块/数组/空行/解释文字一律跳过
  let g: any;
  try { g = JSON.parse(line); } catch { return null; }
  if (!g || !Array.isArray(g.lineIds)) return null;
  const lineIds = g.lineIds.filter((id: unknown) => valid.has(id));
  if (!lineIds.length) return null;
  return { type: g.type === 'heading' ? 'heading' : g.type === 'list' ? 'list' : 'para', level: typeof g.level === 'number' ? g.level : 1, lineIds };
}

/**
 * AI 结构重建（非流式）：给"行"（id+相对字号+文字）让模型分组成 标题/段落/列表。
 * 模型只输出分组 lineIds、不改写文字——前端按 lineIds 把文字与原页 bbox 拼回（重排块可追溯）。
 * 关键治"多段并一块"：标题靠字号+独立成行，连续正文按语义切多段，绝不因行距均匀而合并。
 * 用于预热下一页 + 流式失败兜底；实时主路径走 reflowAiStream（SSE 按段流式）。
 */
export async function runReflowAi(payload: any): Promise<any[]> {
  const lines: any[] = payload?.lines || [];
  if (lines.length < 2) return [];
  const { system, user } = buildReflowAiPrompt(lines);
  const model = payload?.model || REFLOW_MODEL;
  const raw = await gateway(system, user, model.startsWith('gemini') ? 4096 : 3500, undefined, model);
  const valid = new Set(lines.map((l) => l.id));
  // 优先按 NDJSON 逐行解析
  const groups = raw.split('\n').map((ln) => parseGroupLine(ln.trim(), valid)).filter(Boolean) as any[];
  if (groups.length) return groups;
  // 兜底：模型仍输出了 JSON 数组（旧习惯）
  return extractJsonArray(raw)
    .filter((g) => g && Array.isArray(g.lineIds))
    .map((g) => ({ type: g.type === 'heading' ? 'heading' : g.type === 'list' ? 'list' : 'para', level: typeof g.level === 'number' ? g.level : 1, lineIds: g.lineIds.filter((id: unknown) => valid.has(id)) }))
    .filter((g) => g.lineIds.length);
}

/**
 * AI 结构重建（流式）：边收模型 NDJSON 边 yield 分组。供 /api/reflow-ai-stream
 * 一段段写回浏览器，让重排"按段冒出来"而非整页排完才显示。网关不支持流式时
 * gatewayTextStream 会退化为一次性返回——本生成器照常逐组 yield（只是不增量）。
 */
export async function* reflowAiStream(payload: any): AsyncGenerator<{ type: string; level: number; lineIds: string[] }> {
  const lines: any[] = payload?.lines || [];
  if (lines.length < 2) return;
  const { system, user } = buildReflowAiPrompt(lines);
  const model = payload?.model || REFLOW_MODEL;
  const valid = new Set(lines.map((l) => l.id));
  let buf = '';
  let full = '';
  let yielded = 0;
  for await (const delta of gatewayTextStream({ system, messages: [{ role: 'user', content: user }], maxTokens: model.startsWith('gemini') ? 4096 : 3500, model })) {
    buf += delta; full += delta;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const g = parseGroupLine(buf.slice(0, nl).trim(), valid);
      buf = buf.slice(nl + 1);
      if (g) { yielded++; yield g; }
    }
  }
  const tail = parseGroupLine(buf.trim(), valid); // 最后一行可能无换行
  if (tail) { yielded++; yield tail; }
  if (yielded === 0) {
    // 模型没按 NDJSON（输出了数组/代码块）→ 整体兜底解析，逐组补出
    for (const g of extractJsonArray(full)) {
      if (g && Array.isArray(g.lineIds)) {
        const lineIds = g.lineIds.filter((id: unknown) => valid.has(id));
        if (lineIds.length) yield { type: g.type === 'heading' ? 'heading' : g.type === 'list' ? 'list' : 'para', level: typeof g.level === 'number' ? g.level : 1, lineIds };
      }
    }
  }
}

/**
 * 局部截图 OCR：读一张从 PDF 裁出的标注区域图，原样转写其中文字（含手写）。
 * 只转写、不解释、不翻译——转写文字回前端填 OCRResult.text_blocks，喂推理 + 装 source_refs。
 */
export async function runOcrVlm(payload: any): Promise<{ text: string }> {
  const image = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : '';
  if (!image) return { text: '' };
  const isPage = payload?.scope === 'page';
  const bbox = Array.isArray(payload?.bbox) ? payload.bbox.map((n: any) => Number(n)) : null;
  const system =
    '你是一个 OCR 转写器。' +
    (isPage
      ? '输入是一整页 PDF 截图，以及用户标注框在页面上的大致位置。只转写标注框那块区域内的文字。'
      : '输入是一张从 PDF 页面裁出的局部截图。转写图中的文字。') +
    '可能是印刷体或手写，按自然阅读顺序输出纯文本，多行用换行分隔。' +
    '不要解释、不要翻译、不要加任何说明或标点修饰。若没有可辨认的文字，输出空字符串。';
  let user = '转写这张截图里的文字：';
  if (isPage && bbox) {
    const [x, y, w, h] = bbox;
    const pct = (v: number) => Math.round(v * 100);
    user = `用户标注框大约在页面横向 ${pct(x)}%–${pct(x + w)}%、纵向 ${pct(y)}%–${pct(y + h)}%（左上角为原点）。转写该区域内的文字：`;
  }
  const text = await gateway(system, user, isPage ? 700 : 500, image, payload?.model); // 局部 OCR 随 inferModel 走（kimi/gemini A/B）
  return { text: text.trim() };
}

/**
 * 图像解读：看一张从原页裁出的图，结合「图附近正文 + 前页总结」说清它在讲什么。
 * 重排时图不丢，旁附这一句 AI 注解。（未来上下文可扩到相邻页。）
 */
export async function runExplainImage(payload: any): Promise<{ text: string }> {
  const image = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : '';
  if (!image) return { text: '' };
  const nearby = String(payload?.nearby || '').slice(0, 800);
  const prev = String(payload?.prevSummary || '').slice(0, 200);
  const system =
    '你在帮读者理解一篇文档里的一张图（照片 / 图表 / 示意图 / 公式截图）。' +
    '结合给到的上下文，用一两句中文说清这张图在讲什么、为什么放在这里、它支撑了什么观点。' +
    '不要逐像素描述外观，不要寒暄，不要 markdown，最多 2 句。读不出就说「这张图的含义不明确」。';
  const ctx = [prev ? `前页梗概：${prev}` : '', nearby ? `图附近的正文：${nearby}` : ''].filter(Boolean).join('\n');
  const user = `${ctx ? ctx + '\n\n' : ''}看这张图，给读者一句解读：`;
  const text = await gateway(system, user, 300, image);
  return { text: text.trim() };
}

/**
 * VLM 重写重排：让模型看一张整页 PDF 截图，按真实阅读顺序产出语义块（标题/段/列表）。
 * 治网页截图、扭曲页、字号统一的 OCR 嵌字 PDF —— 这些把纯几何 reflowLocal 打爆的情况。
 * 严格转写、不改写原文（PRD 红线）；返回数组里每块带模型估计的归一化 bbox（便于反查）。
 */
export async function runReflowVlm(payload: any): Promise<any[]> {
  const image = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : '';
  if (!image) return [];
  const system =
    '你在重排一张 PDF 页面截图。按真实阅读顺序输出一个 JSON 数组，每个元素是一个语义块：' +
    '{"type":"heading"|"para"|"list","level":1到3(heading时；其他=0),' +
    '"text":"原样转写的文字（para/heading用；list省略）",' +
    '"items":["项1","项2"](list用；其他省略),"ordered":true|false(list用),' +
    '"bbox":[x,y,w,h] 归一化0–1，估计该块在页面上的位置}。' +
    '严格按图中文字转写，不要改写、翻译、添加或省略文字；多栏按真实阅读顺序排（先左栏后右栏）；' +
    '标题/正文/列表分类清楚。只输出 JSON 数组，别的都不要。';
  const raw = await gateway(system, '看这张页面图，按上面格式重排：', 3000, image);
  const arr = extractJsonArray(raw);
  return arr.filter((b) => b && (b.type === 'heading' || b.type === 'para' || b.type === 'list')).map((b) => ({
    type: b.type,
    level: typeof b.level === 'number' ? b.level : 0,
    text: typeof b.text === 'string' ? b.text.trim() : '',
    items: Array.isArray(b.items) ? b.items.map((x: unknown) => String(x).trim()).filter(Boolean) : undefined,
    ordered: typeof b.ordered === 'boolean' ? b.ordered : undefined,
    bbox: Array.isArray(b.bbox) && b.bbox.length === 4 ? b.bbox.map((n: any) => Number(n) || 0) : [0, 0, 1, 0.05],
  }));
}

/**
 * 网页对话式聊天（流式·P2 替代退役的 Agent SDK 会话）。
 * 无状态端点：会话状态（每本书 buffer）由客户端持有、整串 messages 传入——正是 ChatGPT/Claude 网页对话的形态。
 * 逐段 yield 文字增量；客户端 append + 可解析锚点结构化输出（锚点落位 P3/P4 接）。
 */
export async function* chatStream(payload: any): AsyncGenerator<string> {
  const messages: any[] = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!messages.length) return;
  const system = String(payload?.system || '');
  const model = payload?.model || cfg().model;
  const maxTokens = typeof payload?.maxTokens === 'number' ? payload.maxTokens : 800;
  for await (const delta of gatewayTextStream({ system, messages, maxTokens, model })) yield delta;
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
