/**
 * 本地 fixup 代理:让 Claude Agent SDK 以为自己在打 Anthropic /v1/messages,
 * 实际在出口把请求改写后转发到 NoDesk 网关跑 Kimi。
 * 改编自 Nodesign server/lib/binary-fixup-proxy.js —— 去掉 sharp 下采样、多渠道分流,
 * 收窄到我们的单一 kimi 场景:
 *   · SDK 以 spoof model(claude-opus-4-7[1m],让其内部 context 窗按 1M 算)发出 → 出口强制改成真 kimi 模型
 *   · thinking: 'adaptive'(SDK 对非白名单模型强转) → 'enabled'(Kimi 需要)
 *   · 把 tool_result 里的 image 提到 user message 顶层(Kimi vision 兼容;我们图本就在 user msg,留作保险)
 *   · 注入 NoDesk passthrough 所需 channel + channel_url
 *   · x-api-key → Authorization Bearer(NoDesk 只认 Bearer)
 *   · /v1/messages/count_tokens 本地估算(SDK 靠它维护上下文窗口计数)
 * SDK 把 ANTHROPIC_BASE_URL 设成 http://127.0.0.1:PORT/__nd/<sessionId>,本代理剥前缀后转发。
 */
import http from 'node:http';
import https from 'node:https';

let _instance = null;
const PREFIX_RE = /^\/__nd\/([^/]+)(\/.*)$/;

/**
 * 启动代理(幂等)。
 * @param {{gatewayUrl:string, realModel:string, channel?:string, channelUrlBase?:string}} opts
 *   gatewayUrl 已含 /default/passthrough(我们的 LLM_GATEWAY_URL 即是)。
 */
export async function getOrStartProxy(opts) {
  if (_instance) return _instance;
  const { gatewayUrl, realModel, channel = 'kimi', channelUrlBase = 'https://api.moonshot.cn/anthropic' } = opts || {};
  if (!gatewayUrl) throw new Error('gateway-proxy: gatewayUrl required');
  const target = new URL(gatewayUrl);
  const useHttps = target.protocol === 'https:';
  const targetPort = target.port || (useHttps ? 443 : 80);
  const reqLib = useHttps ? https : http;
  const base = channelUrlBase.replace(/\/$/, '');

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        let body = Buffer.concat(chunks);
        let origPath = req.url;
        const m = PREFIX_RE.exec(req.url);
        if (m) origPath = m[2]; // 剥 /__nd/<tag>

        if (!(req.method === 'POST' && /^\/v1\/messages\b/.test(origPath))) {
          res.writeHead(502); res.end(`unsupported ${req.method} ${origPath}`); return;
        }
        if (/^\/v1\/messages\/count_tokens\b/.test(origPath)) {
          const rb = JSON.stringify({ input_tokens: estimateTokens(body) });
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(rb) });
          res.end(rb); return;
        }

        body = fixupBody(body, { realModel, channel, channelUrl: base + origPath });

        const headers = { ...req.headers, host: target.hostname };
        const key = headers['x-api-key'] || headers['X-Api-Key'];
        if (key && !headers['authorization']) headers['authorization'] = `Bearer ${key}`;
        delete headers['x-api-key']; delete headers['X-Api-Key'];
        headers['content-length'] = String(body.length);

        const preq = reqLib.request(
          { hostname: target.hostname, port: targetPort, path: target.pathname, method: 'POST', headers },
          (pres) => {
            if (pres.statusCode >= 400) {
              const rc = []; pres.on('data', (c) => rc.push(c));
              pres.on('end', () => console.warn(`[gateway-proxy] upstream ${pres.statusCode}: ${Buffer.concat(rc).slice(0, 300).toString('utf8').replace(/\s+/g, ' ')}`));
            }
            res.writeHead(pres.statusCode, pres.headers);
            pres.pipe(res);
          },
        );
        preq.on('error', (e) => { console.error(`[gateway-proxy] forward error: ${e.message}`); try { res.writeHead(502); res.end(e.message); } catch { /* */ } });
        preq.write(body); preq.end();
      } catch (e) {
        console.error(`[gateway-proxy] handler error: ${e?.stack || e}`);
        try { res.writeHead(502); res.end(String(e?.message || e)); } catch { /* */ }
      }
    });
    req.on('error', () => { try { res.writeHead(400); res.end(); } catch { /* */ } });
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`[gateway-proxy] ${baseUrl} → ${gatewayUrl} (channel=${channel}, model→${realModel})`);
  _instance = { baseUrl, close: () => new Promise((r) => server.close(() => r())), server };
  return _instance;
}

export async function stopProxy() { if (_instance) { await _instance.close(); _instance = null; } }

/** 出口改写:强制真模型(单一 kimi 网关)、thinking 修复、lift 图、注 channel。 */
function fixupBody(body, { realModel, channel, channelUrl }) {
  let p;
  try { p = JSON.parse(body.toString('utf8')); } catch { return body; }
  if (!p || typeof p !== 'object') return body;
  if (realModel) p.model = realModel; // 我们只有 kimi 网关,任何模型(spoof alias / SDK 内部 helper)一律改成真模型
  // SDK 对非白名单模型强转 thinking 'adaptive'(Kimi 不支持→0 思考块);改回 enabled。
  // 但旁注是"一两句"的轻任务,8192 预算会让 Kimi 过度推理→编造事实(如凭空"八五年")+慢。
  // 降到低预算:够产出思考块(SDK 需要),又不过度发散。env 可调。
  if (p.thinking && p.thinking.type === 'adaptive') {
    p.thinking = { type: 'enabled', budget_tokens: Number(process.env.AGENT_THINK_BUDGET) || 1024 };
  }
  if (Array.isArray(p.messages)) liftImagesFromToolResult(p.messages);
  p.channel = channel;
  p.channel_url = channelUrl;
  return Buffer.from(JSON.stringify(p), 'utf8');
}

/** 把 tool_result 内的 image 提到 user message 顶层(Kimi vision 兼容)。 */
function liftImagesFromToolResult(messages) {
  for (const msg of messages) {
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue;
    const lifted = [];
    for (const block of msg.content) {
      if (block?.type !== 'tool_result' || !Array.isArray(block.content)) continue;
      block.content = block.content.map((inner) => {
        if (inner?.type === 'image' && inner.source?.data) {
          lifted.push({ ...inner });
          return { type: 'text', text: '[image lifted to user message top-level for Kimi vision compat]' };
        }
        return inner;
      });
    }
    if (lifted.length) msg.content.push(...lifted);
  }
}

const CJK_REGEX = /[぀-ヿ一-鿿가-힯]/g;
function estimateTokens(body) {
  try {
    const p = JSON.parse(body.toString('utf8'));
    let total = 0;
    const addText = (s) => { if (typeof s === 'string') { const cjk = (s.match(CJK_REGEX) || []).length; total += cjk * 1.3 + (s.length - cjk) / 4; } };
    const addBlock = (b) => {
      if (!b) return;
      if (b.type === 'text') addText(b.text);
      else if (b.type === 'image' && b.source?.data) total += b.source.data.length / 4;
      else if (b.type === 'tool_use') { addText(b.name); addText(JSON.stringify(b.input || {})); }
      else if (b.type === 'tool_result') { if (typeof b.content === 'string') addText(b.content); else if (Array.isArray(b.content)) b.content.forEach(addBlock); }
      else if (b.type === 'thinking') addText(b.thinking);
    };
    for (const msg of (p.messages || [])) { if (typeof msg.content === 'string') addText(msg.content); else if (Array.isArray(msg.content)) msg.content.forEach(addBlock); }
    if (typeof p.system === 'string') addText(p.system); else if (Array.isArray(p.system)) p.system.forEach(addBlock);
    for (const t of (p.tools || [])) { addText(t.name); addText(t.description); addText(JSON.stringify(t.input_schema || {})); }
    return Math.max(1, Math.round(total));
  } catch { return 50000; }
}
